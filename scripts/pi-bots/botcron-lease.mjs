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

/** Try to take or renew the lease. Resolves true if this holder owns it. */
export async function holdBotcronLease({ dir, holder, ttlMs = 180000, now = Date.now(), lockTimeoutMs = 2000 }) {
  try {
    mkdirSync(dir, { recursive: true });
    return await withSqliteLock(lockPath(dir), async () => {
      const cur = readLease(dir);
      if (cur && cur.holder !== holder && cur.expires_at > now) return false;
      const tmp = `${leasePath(dir)}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ holder, pid: process.pid, expires_at: now + ttlMs }));
      try { renameSync(tmp, leasePath(dir)); } catch (e) { try { unlinkSync(tmp); } catch {} throw e; }
      return true;
    }, { timeoutMs: lockTimeoutMs });
  } catch { return false; }
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
 * it gains the lease and one when it loses it, never per tick. stop() waits
 * for an in-flight sweep, then frees the lease; a stopped ticker never ticks
 * again (make a new one to re-arm). sweep() never rejects.
 * @returns {{ sweep(): Promise<{fired:number, held:boolean, skipped?:boolean}>, stop(): Promise<void>, readonly held: boolean }}
 */
export function createBotcronTicker({
  dir,
  holder = BOTCRON_HOLDER,
  ttlMs = 180000,
  log = () => {},
  _hold = holdBotcronLease,
  _release = releaseBotcronLease,
  _tick = null,
}) {
  let held = false;
  let stopped = false;
  let inflight = null;

  async function run() {
    const ok = await _hold({ dir, holder, ttlMs });
    if (stopped) { // disarmed while we waited on the lock: hand the lease straight back
      if (ok) await _release({ dir, holder });
      held = false;
      return { fired: 0, held: false };
    }
    if (ok !== held) {
      held = ok;
      log(ok ? "lease acquired, this process ticks bot-cron schedules"
             : "lease lost, another ticker on this instance owns bot-cron schedules");
    }
    if (!ok) return { fired: 0, held: false };
    const tick = _tick || (await import("./bot_scheduler.mjs")).tickBotSchedules;
    const r = tick({ log });
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
