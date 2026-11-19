/**
 * The primary-gateway lease: only one gateway process on a crow.db runs reports.
 *
 * A `--no-auth` gateway is a loopback companion that shares the same crow.db, and an auto-update
 * restart briefly has two gateway processes on it. The reports scheduler hook therefore writes a small
 * lease row before it does anything (`dashboard_settings`, key `reports.gateway_lease`, a plain text
 * value: `{runId, pid, kernelBootId, at}`), refreshes it on every tick, and lets go of it when it
 * shuts down cleanly.
 *
 * The lease is STALE — free to take — when any of these is true, because any of them means the process
 * that wrote it is not this machine's running gateway any more:
 *
 *   - its `kernelBootId` differs from this machine's (the box was rebooted since);
 *   - its `pid` is not alive (an auto-update restart leaves the old pid gone within seconds);
 *   - its `pid` is THIS process's pid but its `runId` is not (a container restart, or a launcher that
 *     reuses a pid, hands a new gateway process a number a dead one already had);
 *   - its `at` is more than three minutes old (a tick is a minute apart: a live holder refreshes it).
 *
 * A live lease held by another process means another gateway is already running reports on this
 * database: the answer is `{held: false}` and the caller waits for the next tick, which tries again.
 * That is why an auto-update restart never leaves reports switched off: the old holder's pid is gone
 * before the new process's first tick.
 *
 * The write is race-safe. It is ONE statement, and its `ON CONFLICT ... WHERE` guard names the exact
 * value this call read, so two processes racing for an empty or stale lease cannot both win: the
 * loser's statement changes no row (`rowsAffected` 0) and it answers `{held: false}`.
 *
 * A lost write is not always another process. Two passes in ONE process (a scheduler tick and a kick
 * from a run route, say) can read the same `ours` lease and both write, and the second write then
 * changes no row even though the row still names this process. So a lost write re-reads the row: when
 * the `runId` now stored is still this process's, the lease is held (the winner was us).
 *
 * `deps` is the seam (tests inject all of it):
 *   - `now()`: epoch ms, the lease's `at` and the age check.
 *   - `pid`: this process's pid.
 *   - `isPidAlive(pid)`: whether a pid is alive. The default is `process.kill(pid, 0)`, where EPERM
 *     counts as alive (the process exists, it is simply not ours).
 *   - `kernelBootId()`: `/proc/sys/kernel/random/boot_id`, or null when it cannot be read (null
 *     compares equal to null: an unreadable boot id does not by itself make a lease stale).
 *   - `runId`: the id this process mints once (`gatewayRunId()`).
 */
import { readFileSync } from "node:fs";
import { gatewayRunId } from "../run-id.js";

/** The `dashboard_settings` key the lease lives under. Not in the sync allowlist: it never travels. */
export const LEASE_KEY = "reports.gateway_lease";

/** How long a lease nobody refreshed is believed: three ticks. */
export const LEASE_STALE_MS = 3 * 60 * 1000;

/** This machine's kernel boot id, or null. */
function defaultKernelBootId() {
  try {
    const text = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return text || null;
  } catch {
    return null;
  }
}

/** Is that pid a live process? EPERM means "alive, but not ours". */
function defaultIsPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

function resolveDeps(deps) {
  const given = deps == null ? {} : deps;
  const fn = (key, fallback) => (typeof given[key] === "function" ? given[key] : fallback);
  return {
    now: fn("now", Date.now),
    pid: Number.isInteger(given.pid) ? given.pid : process.pid,
    isPidAlive: fn("isPidAlive", defaultIsPidAlive),
    kernelBootId: fn("kernelBootId", defaultKernelBootId),
    runId: typeof given.runId === "string" && given.runId ? given.runId : gatewayRunId(),
  };
}

function clock(deps) {
  const value = Number(deps.now());
  return Number.isFinite(value) ? value : Date.now();
}

/** The stored lease, or null when there is none (or what is stored is not a lease). */
function parseLease(text) {
  if (typeof text !== "string" || !text) return null;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    runId: typeof value.runId === "string" ? value.runId : "",
    pid: Number.isInteger(value.pid) ? value.pid : null,
    kernelBootId: typeof value.kernelBootId === "string" ? value.kernelBootId : null,
    at: Number.isFinite(Number(value.at)) ? Number(value.at) : 0,
  };
}

/** Why a lease may be taken: nobody holds one, we do, or its holder is gone. */
function staleReason(lease, deps, now, bootId) {
  if (!lease) return "none";
  if (lease.runId && lease.runId === deps.runId) return "ours";
  // Our own pid under another run id: the number was reused (a container restart, a supervisor that
  // hands out the same pid again), so the holder that wrote it is not this process. Alive-pid says
  // nothing here, which is exactly why this check comes before it.
  if (lease.pid != null && lease.pid === deps.pid) return "same-pid";
  if (lease.kernelBootId !== bootId) return "other-boot";
  if (lease.pid == null || !deps.isPidAlive(lease.pid)) return "pid-gone";
  if (now - lease.at > LEASE_STALE_MS) return "aged-out";
  return null;
}

/** The stored lease's raw text, or null. A read failure is answered as "no lease" by `takeLease`. */
async function readLeaseText(db) {
  const { rows } = await db.execute({
    sql: "SELECT value FROM dashboard_settings WHERE key = ?",
    args: [LEASE_KEY],
  });
  const value = rows[0]?.value;
  return typeof value === "string" ? value : null;
}

/**
 * Take or refresh the lease.
 *
 * @param {object} db
 * @param {object} [deps] see the header
 * @returns {Promise<{held: boolean, reason: string}>} `held` is whether THIS process may run reports
 *   now; `reason` names why (none, ours, same-pid, other-boot, pid-gone, aged-out, live, raced,
 *   unreadable)
 */
export async function takeLease(db, deps) {
  const d = resolveDeps(deps);
  const now = clock(d);
  const bootId = d.kernelBootId();
  let previous = null;
  try {
    previous = await readLeaseText(db);
  } catch {
    return { held: false, reason: "unreadable" };
  }
  const lease = parseLease(previous);
  const reason = staleReason(lease, d, now, bootId);
  if (reason === null) return { held: false, reason: "live" };

  const value = JSON.stringify({ runId: d.runId, pid: d.pid, kernelBootId: bootId, at: now });
  let result;
  try {
    result = await db.execute({
      sql: `INSERT INTO dashboard_settings (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
             WHERE dashboard_settings.value IS ?`,
      args: [LEASE_KEY, value, previous],
    });
  } catch {
    return { held: false, reason: "unreadable" };
  }
  if (Number(result?.rowsAffected) === 1) return { held: true, reason };
  // Somebody else wrote it between our read and our write. When the value now stored still names this
  // process, the racing writer was one of our own passes (a tick and a kick refreshing the same lease)
  // and the lease is held; only a value that names another process is a lost race.
  let current = null;
  try {
    current = await readLeaseText(db);
  } catch {
    current = null;
  }
  if (parseLease(current)?.runId === d.runId) return { held: true, reason };
  return { held: false, reason: "raced" };
}

/**
 * Let go of the lease, but only when it is ours: a process that never held it must not delete the
 * lease of the gateway that does.
 *
 * @param {object} db
 * @param {object} [deps]
 * @returns {Promise<boolean>} whether a row was removed
 */
export async function releaseLease(db, deps) {
  const d = resolveDeps(deps);
  let previous = null;
  try {
    previous = await readLeaseText(db);
  } catch {
    return false;
  }
  if (parseLease(previous)?.runId !== d.runId) return false;
  try {
    const result = await db.execute({
      sql: "DELETE FROM dashboard_settings WHERE key = ? AND value IS ?",
      args: [LEASE_KEY, previous],
    });
    return Number(result?.rowsAffected) === 1;
  } catch {
    return false;
  }
}