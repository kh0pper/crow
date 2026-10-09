/**
 * A cross-process lock the OPERATING SYSTEM releases (Crow Artifacts, plan
 * re-check R2-H2). It replaces a pid lock file whose stale-recovery was
 * check-then-unlink (two waiters could both "recover" and both hold it) and
 * which wedged on a reused pid or an empty file.
 *
 * Mechanism: a small, separate SQLite file (never crow.db, so a 50 MB blob
 * write never holds crow.db's write lock). `BEGIN IMMEDIATE` on a dedicated
 * connection takes SQLite's RESERVED lock (an fcntl lock on the file). The
 * kernel drops it when the process dies, whatever the state of the file, so
 * there is no stale detection, no pid, nothing to wedge.
 *
 * The connection uses busy_timeout 0: a busy lock throws SQLITE_BUSY at once
 * and the wait is an async sleep, so the gateway's event loop never blocks.
 * Rollback journal (not WAL); nothing is ever written, so the file stays an
 * empty database. A corrupt file is NOT deleted (deleting a lock file another
 * process may hold is how exclusion breaks); it fails closed with a named
 * error that the health signal reports.
 *
 * Caller contract: keep the promise returned by fn() reachable. (A test holder
 * that awaited an unreferenced never-settling promise let V8 collect the
 * suspended frame and its connection, which released the lock.)
 */
import Database from "better-sqlite3";

// R3-L5: every connection that holds a lock is pinned here, so it cannot be
// garbage-collected (and its lock dropped) while held, whatever the caller does.
const HELD = new Set();

export async function withSqliteLock(path, fn, { timeoutMs = 30000, pollMs = [15, 40] } = {}) {
  const end = Date.now() + timeoutMs;
  let db;
  for (;;) {
    try {
      db = new Database(path, { timeout: 0 });
      db.pragma("busy_timeout = 0");
      // R3-L4: a WAL-mode lock file can turn contention into hard
      // SQLITE_BUSY_RECOVERY failures; refuse it rather than guess.
      const mode = String(db.pragma("journal_mode", { simple: true }) || "").toLowerCase();
      if (mode === "wal") throw Object.assign(new Error(`write-lock file is in WAL mode: ${path}`), { code: "lock_wal" });
      db.exec("BEGIN IMMEDIATE");
      HELD.add(db);
      break;
    } catch (e) {
      try { db && db.close(); } catch {}
      db = null;
      const code = String((e && e.code) || "");
      if (code === "lock_wal") throw e;
      if (code === "SQLITE_NOTADB" || code.startsWith("SQLITE_CORRUPT")) throw Object.assign(new Error(`write-lock file is not a database: ${path} (remove it while no Crow process is running)`), { code: "lock_corrupt" });
      // R3-L4: extended codes (SQLITE_BUSY_RECOVERY, SQLITE_BUSY_SNAPSHOT,
      // SQLITE_LOCKED_SHAREDCACHE …) are contention too: wait, never fail.
      if (!/^SQLITE_(BUSY|LOCKED)/.test(code)) throw e;
      if (Date.now() > end) throw Object.assign(new Error("artifact store busy"), { code: "busy" });
      await new Promise((r) => setTimeout(r, pollMs[0] + Math.random() * (pollMs[1] - pollMs[0])));
    }
  }
  try { return await fn(); }
  finally {
    try { db.exec("COMMIT"); } catch {}
    HELD.delete(db);
    try { db.close(); } catch {}
  }
}
