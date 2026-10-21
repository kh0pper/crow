/**
 * Per-instance bot-cron ticker lease. Keeps a second ticker idle on the same
 * instance; it is NOT the correctness guarantee (the atomic claim in
 * bot_scheduler.mjs is). The lease is a small JSON file in the instance data
 * dir, read-modified-written inside an OS-released SQLite lock, never throwing.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { withSqliteLock } from "../../servers/shared/sqlite-lock.js";

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
      renameSync(tmp, leasePath(dir));
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
