/**
 * Per-instance bot-cron ticker lease. Keeps a second ticker idle on the same
 * instance; it is NOT the correctness guarantee (the atomic claim in
 * bot_scheduler.mjs is). The lease is a small JSON file in the instance data
 * dir, read-modified-written inside an OS-released SQLite lock, never throwing.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { withSqliteLock } from "../../servers/shared/sqlite-lock.js";

/** This process's lease holder id, fixed for its life. */
export const BOTCRON_HOLDER = `${process.pid}:${randomUUID()}`;

const leasePath = (dir) => join(dir, "botcron-ticker.lease.json");
const lockPath = (dir) => join(dir, "botcron-ticker.lock");

function readLease(dir) {
  try {
    const l = JSON.parse(readFileSync(leasePath(dir), "utf8"));
    if (l && typeof l.holder === "string" && Number.isFinite(l.expires_at)) return l;
  } catch {}
  return null; // missing or corrupt == expired
}

/** True when no process with this pid exists (ESRCH). EPERM means it is alive. */
function pidIsDead(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return false; }
  catch (e) { return !!(e && e.code === "ESRCH"); }
}

/**
 * Try to take or renew the lease, telling "someone else holds it" apart from
 * "the lease cannot be taken at all". Resolves:
 *   { held: true }                    this holder owns it now
 *   { held: false }                   another live holder owns it, or the lock was busy
 *   { held: false, error: "<msg>" }   any other failure (a lock file that is not a
 *                                     database, a WAL lock file, EACCES, EROFS, ENOSPC …)
 * A live lease whose recorded pid no longer exists is taken over at once, so a
 * restarted ticker does not wait out the TTL. Never throws.
 */
export async function tryBotcronLease({ dir, holder, ttlMs = 180000, now = Date.now(), lockTimeoutMs = 2000 }) {
  try {
    mkdirSync(dir, { recursive: true });
    const held = await withSqliteLock(lockPath(dir), async () => {
      const cur = readLease(dir);
      if (cur && cur.holder !== holder && cur.expires_at > now && !pidIsDead(cur.pid)) return false;
      const tmp = `${leasePath(dir)}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ holder, pid: process.pid, expires_at: now + ttlMs }));
      try { renameSync(tmp, leasePath(dir)); } catch (e) { try { unlinkSync(tmp); } catch {} throw e; }
      return true;
    }, { timeoutMs: lockTimeoutMs });
    return { held };
  } catch (e) {
    if (e && e.code === "busy") return { held: false };
    return { held: false, error: String((e && e.message) || e) };
  }
}

/** Try to take or renew the lease. Resolves true if this holder owns it; never throws. */
export async function holdBotcronLease(opts) {
  return (await tryBotcronLease(opts)).held;
}

/** Free the lease if this holder owns it; otherwise a no-op. Never throws. */
export async function releaseBotcronLease({ dir, holder, lockTimeoutMs = 2000 }) {
  try {
    await withSqliteLock(lockPath(dir), async () => {
      const cur = readLease(dir);
      if (cur && cur.holder === holder) unlinkSync(leasePath(dir));
    }, { timeoutMs: lockTimeoutMs });
  } catch {}
}

/** Lease TTL for a poll cadence: at least 3 polls, never under the 180 s default. */
export function botcronLeaseTtl(pollMs) {
  const p = Number(pollMs) || 60000;
  return Math.max(180000, 3 * p);
}

/**
 * One bot-cron ticker for this process: each sweep() takes or renews the
 * lease and, only while it holds it, runs one tickBotSchedules() pass.
 * Overlapping sweeps are dropped (one in flight at a time). Logs one line when
 * it gains the lease and one when it loses it, never per tick. A lease that
 * cannot be taken at all (not "another ticker holds it") is logged once per
 * distinct error, and once again on recovery; no ticker runs meanwhile. stop() waits
 * for an in-flight sweep, then frees the lease; a stopped ticker never ticks
 * again (make a new one to re-arm). sweep() never rejects.
 * @returns {{ sweep(): Promise<{fired:number, held:boolean, skipped?:boolean}>, stop(): Promise<void>, readonly held: boolean }}
 */
export function createBotcronTicker({
  dir,
  holder = BOTCRON_HOLDER,
  ttlMs = 180000,
  pollMs = 60000,
  log = () => {},
  _hold = tryBotcronLease,
  _release = releaseBotcronLease,
  _tick = null,
}) {
  let held = false;
  let stopped = false;
  let inflight = null;
  let lastError = null; // the lease error currently being reported, if any
  let aliveAt = null;   // start time of this ticker's last successful tick (the missed-run heartbeat)

  async function run() {
    const res = await _hold({ dir, holder, ttlMs });
    // _hold may resolve a plain boolean (holdBotcronLease shape) or { held, error }.
    const ok = typeof res === "boolean" ? res : !!(res && res.held);
    const error = (res && typeof res === "object" && res.error) || null;
    if (stopped) { // disarmed while we waited on the lock: hand the lease straight back
      if (ok) await _release({ dir, holder });
      held = false;
      return { fired: 0, held: false };
    }
    if (error) {
      if (error !== lastError) {
        lastError = error;
        log(`cannot take the bot-cron lease: ${error}; scheduled bot runs are paused on this instance`);
      }
      held = false;
      return { fired: 0, held: false, error };
    }
    if (lastError) {
      lastError = null;
      log("the bot-cron lease can be taken again; scheduled bot runs resume");
    }
    if (ok !== held) {
      held = ok;
      log(ok ? "lease acquired, this process ticks bot-cron schedules"
             : "lease lost, another ticker on this instance owns bot-cron schedules");
    }
    if (!ok) return { fired: 0, held: false };
    const tick = _tick || (await import("./bot_scheduler.mjs")).tickBotSchedules;
    const startedAt = Date.now();
    // Heartbeat slack: a sweep up to one poll interval before `due` still means
    // "alive around due", so a long poll never reports a false miss.
    const r = tick({ log, aliveAt, aliveSlackMs: Math.max(120000, Number(pollMs) || 60000) });
    aliveAt = startedAt; // only after the tick returned: a failed sweep never moves the heartbeat
    return { fired: (r && r.fired) || 0, held: true };
  }

  function sweep() {
    if (stopped || inflight) return Promise.resolve({ fired: 0, held, skipped: true });
    inflight = run()
      .catch((e) => { log("error (non-fatal): " + ((e && e.message) || e)); return { fired: 0, held }; })
      .finally(() => { inflight = null; });
    return inflight;
  }

  async function stop() {
    stopped = true;
    if (inflight) { try { await inflight; } catch {} }
    await _release({ dir, holder });
    held = false;
  }

  return { sweep, stop, get held() { return held; } };
}
