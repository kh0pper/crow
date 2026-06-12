/**
 * Crow Database Client Factory
 *
 * Opens a SQLite file via better-sqlite3 and exposes a libsql-shaped
 * async API so existing callers keep working unchanged. Results carry
 * the {rows, columns, rowsAffected, lastInsertRowid} shape libsql
 * returned.
 *
 * Previously backed by @libsql/client, which had two bugs that made it
 * unsuitable for our workload:
 *   - Silent cross-process stale reads: a client never observed writes
 *     made by a separate process (sqlite3 CLI, other gateway instance)
 *     to the same file. No error thrown, just stale snapshot forever.
 *   - Chronic SQLITE_IOERR on healthy files: reads would begin failing
 *     with "disk I/O error" even when PRAGMA integrity_check = ok.
 *     Closing and reopening the client did not recover.
 *
 * See 2026-04-22 MPA pipeline-runner investigation.
 *
 * Shared by memory server, research server, gateway auth, sharing,
 * orchestrator, scheduler, and init-db. Used by all three gateway
 * instances (primary, MPA, finance) running off this tree.
 */

import Database from "better-sqlite3";
import { existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Sanitize user input for use in SQLite FTS5 MATCH queries.
 * Strips FTS5 operators and wraps individual terms in double quotes
 * for safe literal matching. Returns null if no valid terms remain.
 */
export function sanitizeFtsQuery(input) {
  if (!input || typeof input !== "string") return null;
  // Remove FTS5 operators and special syntax
  const cleaned = input
    .replace(/\b(AND|OR|NOT|NEAR)\b/gi, "")
    .replace(/[*"(){}[\]^~:]/g, "")
    .trim();
  if (!cleaned) return null;
  // Split into words, quote each for literal matching
  const terms = cleaned
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((w) => `"${w}"`)
    .join(" ");
  return terms || null;
}

/**
 * Escape SQL LIKE wildcard characters in user input.
 * Use with `LIKE ? ESCAPE '\'` in queries.
 */
export function escapeLikePattern(input) {
  if (!input || typeof input !== "string") return input;
  return input
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");
}

/**
 * Resolve the Crow data directory path.
 * Priority: CROW_DATA_DIR env → ~/.crow/data/ → ./data/ (fallback)
 */
export function resolveDataDir() {
  if (process.env.CROW_DATA_DIR) {
    return resolve(process.env.CROW_DATA_DIR);
  }
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const crowHome = resolve(home, ".crow", "data");
  // Use ~/.crow/data/ if it exists, otherwise fall back to repo-local ./data/
  if (home && existsSync(crowHome)) {
    return crowHome;
  }
  return resolve(__dirname, "../data");
}

/**
 * Verify database is accessible and schema is initialized.
 * Throws descriptive errors on failure.
 */
export async function verifyDb(db) {
  try {
    await db.execute("SELECT 1 FROM memories LIMIT 0");
  } catch (err) {
    if (/SQLITE_CANTOPEN|unable to open database/i.test(err.message)) {
      throw new Error("Database not found. Run 'npm run setup' in the crow directory first.");
    } else if (/no such table/i.test(err.message)) {
      throw new Error("Database not initialized. Run 'npm run init-db' first.");
    }
    throw err;
  }
}

/**
 * Log an audit event to the audit_log table.
 * Errors are logged to stderr rather than thrown.
 */
export async function auditLog(db, eventType, { actor, ip, details } = {}) {
  try {
    await db.execute({
      sql: "INSERT INTO audit_log (event_type, actor, ip_address, details) VALUES (?, ?, ?, ?)",
      args: [eventType, actor || null, ip || null, details ? JSON.stringify(details) : null],
    });
  } catch (e) {
    console.error('audit log failed:', e.message);
  }
}

/**
 * Check if sqlite-vec extension is available and loaded.
 * Returns true if vec0 virtual tables can be created.
 */
export async function isSqliteVecAvailable(db) {
  try {
    await db.execute("SELECT vec_version()");
    return true;
  } catch {
    return false;
  }
}

/**
 * Safely add a column to an existing table if it doesn't exist.
 * SQLite doesn't support IF NOT EXISTS for ALTER TABLE ADD COLUMN,
 * so we catch the "duplicate column" error.
 */
const SQL_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SQL_COLTYPE_RE = /^[A-Za-z0-9_() '"-]+$/;

export async function ensureColumn(db, table, column, type) {
  if (!SQL_IDENT_RE.test(table) || !SQL_IDENT_RE.test(column) || !SQL_COLTYPE_RE.test(type)) {
    throw new Error(`ensureColumn: invalid identifier or type (${table}.${column} ${type})`);
  }
  try {
    await db.execute({ sql: `ALTER TABLE ${table} ADD COLUMN ${column} ${type}`, args: [] });
  } catch (err) {
    // Column already exists — safe to ignore
    if (!err.message?.includes("duplicate column")) throw err;
  }
}

/**
 * Normalize the args payload callers pass through libsql-shape APIs.
 * libsql accepts arrays (positional) and objects (named via :foo/@foo/$foo);
 * better-sqlite3 accepts the same via stmt.run(...args) for positional
 * and stmt.run(namedObject) for named.
 */
function spreadArgs(args) {
  if (args == null) return [];
  return Array.isArray(args) ? args : [args];
}

/**
 * Execute a single statement on a better-sqlite3 handle and return a
 * libsql-shaped ResultSet. Reader statements (SELECT, PRAGMA that
 * returns rows, WITH, etc.) go through .all(); others through .run()
 * so we collect changes / lastInsertRowid.
 */
function executeOne(db, sql, rawArgs) {
  const stmt = db.prepare(sql);
  const args = spreadArgs(rawArgs);
  if (stmt.reader) {
    const rows = stmt.all(...args);
    return {
      rows,
      columns: rows.length > 0 ? Object.keys(rows[0]) : [],
      rowsAffected: 0,
      lastInsertRowid: 0,
    };
  }
  const info = stmt.run(...args);
  return {
    rows: [],
    columns: [],
    rowsAffected: info.changes,
    lastInsertRowid: info.lastInsertRowid,
  };
}

/**
 * Per-path keeper handles. SQLite in WAL mode unlinks the -wal/-shm files
 * when the last active connection to a file closes. The gateway has many
 * transient createDbClient() open/close cycles (startup migrations, the
 * per-minute loadRemoteInstances probe, etc.) and if any of them happens
 * to be the last active connection at close time, the unlink orphans the
 * FDs held by peer modules, which then fail reads with
 * "disk I/O error" (SQLite surfacing EBADF on the unlinked inode).
 *
 * Holding one never-closed keeper per DB path guarantees there's always
 * another reader registered in the WAL index, so close() on transient
 * clients can't drop the count to zero.
 *
 * Keeper registration is result-read-based: ensureKeeper registers ONLY when
 * the post-attempt mode read shows 'wal'. Non-WAL DBs don't get a keeper (no
 * fd waste; removes the deleted-wal-fd hazard for DELETE-mode hosts).
 */

import os from "node:os";

const VALID_JOURNAL_MODES = new Set(["WAL", "DELETE", "TRUNCATE", "PERSIST", "MEMORY", "OFF"]);

/**
 * Module-level totalmem probe. Injectable for tests:
 *   set CROW_TEST_TOTALMEM=<bytes> env before importing, OR
 *   assign db._setTotalmemFn(fn) in tests (see export below).
 */
let _totalmemFn = os.totalmem;
export function _setTotalmemFn(fn) { _totalmemFn = fn; }

// Dedup-log sets: one warn per (filePath, requestedMode) per process.
const _modeWarnedPaths = new Set(); // "path::mode"
const _failedFlipPaths = new Set(); // "path::mode" — skip flip on repeat attempts

// Dedup-log set for auto-SELECT decision (logged once per process).
let _autoSelectLogged = false;

/**
 * Resolve the journal mode to request.
 *
 * Priority:
 *   1. CROW_JOURNAL_MODE env (explicit override — always wins).
 *   2. Low-RAM auto-select: totalmem ≤ CROW_WAL_MIN_RAM_GB → "DELETE".
 *   3. Default: "WAL".
 *
 * CROW_TEST_TOTALMEM env overrides totalmem() for test isolation (set before
 * import, or use _setTotalmemFn() for in-process injection).
 */
export function resolveJournalMode() {
  if (process.env.CROW_JOURNAL_MODE) {
    const raw = process.env.CROW_JOURNAL_MODE.toUpperCase();
    return VALID_JOURNAL_MODES.has(raw) ? raw : "WAL";
  }

  // Low-RAM auto-select: ≤ CROW_WAL_MIN_RAM_GB GiB → DELETE.
  // A nominal-2GB host reports slightly under 2 GiB; <= catches it.
  const minRamGb = parseFloat(process.env.CROW_WAL_MIN_RAM_GB || "2");
  const totalMem = process.env.CROW_TEST_TOTALMEM
    ? parseInt(process.env.CROW_TEST_TOTALMEM, 10)
    : _totalmemFn();
  const totalGb = totalMem / (1024 ** 3);

  if (totalGb <= minRamGb) {
    if (!_autoSelectLogged) {
      _autoSelectLogged = true;
      console.warn(
        `[db] Low-RAM host (${totalGb.toFixed(2)} GiB ≤ ${minRamGb} GiB threshold) — ` +
        `auto-selecting journal_mode=DELETE. Set CROW_JOURNAL_MODE=WAL to override.`
      );
    }
    return "DELETE";
  }

  return "WAL";
}

export const _dbKeepers = new Map();

/**
 * Ensure a WAL-mode keeper handle exists for filePath.
 *
 * Registration is RESULT-READ-BASED: we register the keeper only when the
 * DB is actually in WAL mode. On non-WAL DBs: close and don't register
 * (saves the fd; removes the deleted-wal-fd hazard on DELETE-mode hosts).
 *
 * Must be called AFTER the client's own pragma resolution in createDbClient
 * so the read reflects the mode the client actually ended up in.
 *
 * @param {string} filePath - Absolute path to the SQLite file.
 * @param {string} requestedMode - The mode that was requested (for context).
 */
function ensureKeeper(filePath, requestedMode) {
  if (_dbKeepers.has(filePath)) return;
  const keeper = new Database(filePath);
  const actualMode = (() => {
    try { return keeper.pragma("journal_mode", { simple: true }); } catch { return null; }
  })();
  if (typeof actualMode === "string" && actualMode.toLowerCase() === "wal") {
    try { keeper.pragma("busy_timeout = 30000"); } catch {}
    _dbKeepers.set(filePath, keeper);
  } else {
    // Non-WAL or unreadable — close without registering.
    try { keeper.close(); } catch {}
    const warnKey = `${filePath}::keeper-skip`;
    if (!_modeWarnedPaths.has(warnKey)) {
      _modeWarnedPaths.add(warnKey);
      console.warn(
        `[db] keeper-skip for ${filePath}: mode is '${actualMode}' (requested '${requestedMode}') — no WAL keeper registered`
      );
    }
  }
}

/**
 * Create a database client for the given (or inferred) SQLite file.
 * The returned object mirrors @libsql/client's surface (async .execute,
 * .batch, .executeMultiple, .close) so existing call sites don't have
 * to change.
 *
 * The async signatures are retained; the underlying work is synchronous
 * because better-sqlite3 is synchronous, but promise-returning keeps
 * callers that use await correct.
 *
 * Journal mode handling (read-first, deduped, non-fatal):
 *   1. READ the current mode (lock-free, no SQLITE_BUSY risk).
 *   2. Skip the flip if already at the requested mode.
 *   3. Attempt the flip only when modes differ AND no prior failed attempt
 *      for this (path, mode) pair in this process (failed-attempt memo prevents
 *      repeat 5s event-loop stalls on a locked DB during a boot storm).
 *   4. On throw OR post-flip mismatch: dedup-log once per (path, requestedMode)
 *      and continue — accept the current mode rather than crashing.
 *   5. busy_timeout 30000 explicit set stays (unchanged from prior behavior).
 */
export function createDbClient(dbPath) {
  const filePath = dbPath || process.env.CROW_DB_PATH || resolve(resolveDataDir(), "crow.db");

  const db = new Database(filePath);
  const requestedMode = resolveJournalMode();

  // Read-first: lock-free, no SQLITE_BUSY risk.
  let currentMode = null;
  try {
    currentMode = db.pragma("journal_mode", { simple: true });
  } catch {
    // Unreadable — proceed to attempt flip anyway.
  }

  const modeKey = `${filePath}::${requestedMode}`;
  const needsFlip = typeof currentMode === "string"
    ? currentMode.toLowerCase() !== requestedMode.toLowerCase()
    : true; // unreadable current mode → attempt flip

  if (needsFlip && !_failedFlipPaths.has(modeKey)) {
    try {
      db.pragma(`journal_mode = ${requestedMode}`);
      // Re-read to confirm.
      const resultMode = db.pragma("journal_mode", { simple: true });
      if (typeof resultMode === "string" && resultMode.toLowerCase() !== requestedMode.toLowerCase()) {
        // Mode mismatch after flip (DB declined — common when another writer holds it).
        if (!_modeWarnedPaths.has(modeKey)) {
          _modeWarnedPaths.add(modeKey);
          console.warn(
            `[db] journal_mode flip to '${requestedMode}' declined for ${filePath} — ` +
            `DB is in '${resultMode}' mode. Continuing with current mode.`
          );
        }
        _failedFlipPaths.add(modeKey);
      }
    } catch (err) {
      // SQLITE_BUSY or other error — re-read actual mode and dedup-log.
      let actualMode = null;
      try { actualMode = db.pragma("journal_mode", { simple: true }); } catch {}
      if (!_modeWarnedPaths.has(modeKey)) {
        _modeWarnedPaths.add(modeKey);
        console.warn(
          `[db] journal_mode flip to '${requestedMode}' failed for ${filePath} ` +
          `(${err.message}) — DB is in '${actualMode}' mode. Continuing with current mode.`
        );
      }
      _failedFlipPaths.add(modeKey); // don't retry; prevents repeat 5s event-loop stalls
    }
  }

  try {
    db.pragma("busy_timeout = 30000");
  } catch (err) {
    console.warn("[db] Failed to set busy_timeout:", err.message);
  }

  // ensureKeeper AFTER pragma resolution (spec requirement: C4/keeper hygiene).
  // Registers keeper only when the DB is actually in WAL mode.
  ensureKeeper(filePath, requestedMode);

  return {
    async execute(arg) {
      if (typeof arg === "string") return executeOne(db, arg, []);
      return executeOne(db, arg.sql, arg.args);
    },
    async batch(statements) {
      // Wrap in a single transaction so all statements commit atomically,
      // matching libsql's batch() semantics.
      const txn = db.transaction((stmts) => stmts.map((s) => {
        if (typeof s === "string") return executeOne(db, s, []);
        return executeOne(db, s.sql, s.args);
      }));
      return txn(statements);
    },
    async executeMultiple(sql) {
      db.exec(sql);
      return [];
    },
    close() {
      try { db.close(); } catch {}
    },
  };
}

/**
 * Perform an online backup of a crow.db file to destPath using the keeper
 * handle's better-sqlite3 `.backup()`. Runs the SQLite online backup API
 * from inside the gateway process so no external process ever opens the
 * DB file directly — which would, under WAL mode, orphan the gateway's
 * -wal/-shm FDs on close.
 *
 * Returns { totalPages, remainingPages } from better-sqlite3, so callers
 * can confirm completion.
 *
 * C5 fallback: if no keeper is registered (e.g. DELETE-mode host where
 * ensureKeeper skipped registration), open a transient handle, run the
 * backup, then close it. This is safe on DELETE-mode DBs (the never-open-
 * externally hazard in WAL mode doesn't apply to DELETE/TRUNCATE/PERSIST).
 */
export async function performBackup(dbPath, destPath) {
  const filePath = dbPath || process.env.CROW_DB_PATH || resolve(resolveDataDir(), "crow.db");
  const keeper = _dbKeepers.get(filePath);
  if (keeper) {
    return keeper.backup(destPath);
  }
  // C5: transient-handle fallback for non-WAL hosts.
  const transient = new Database(filePath);
  try {
    return await transient.backup(destPath);
  } finally {
    try { transient.close(); } catch {}
  }
}
