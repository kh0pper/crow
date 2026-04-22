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
export async function ensureColumn(db, table, column, type) {
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
 */
const VALID_JOURNAL_MODES = new Set(["WAL", "DELETE", "TRUNCATE", "PERSIST", "MEMORY", "OFF"]);
function resolveJournalMode() {
  const raw = (process.env.CROW_JOURNAL_MODE || "WAL").toUpperCase();
  return VALID_JOURNAL_MODES.has(raw) ? raw : "WAL";
}

const _dbKeepers = new Map();
function ensureKeeper(filePath) {
  if (_dbKeepers.has(filePath)) return;
  const keeper = new Database(filePath);
  try { keeper.pragma(`journal_mode = ${resolveJournalMode()}`); } catch {}
  try { keeper.pragma("busy_timeout = 30000"); } catch {}
  _dbKeepers.set(filePath, keeper);
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
 */
export function createDbClient(dbPath) {
  const filePath = dbPath || process.env.CROW_DB_PATH || resolve(resolveDataDir(), "crow.db");

  ensureKeeper(filePath);

  const db = new Database(filePath);
  try {
    const mode = resolveJournalMode();
    db.pragma(`journal_mode = ${mode}`);
  } catch (err) {
    console.warn("[db] Failed to set journal_mode:", err.message);
  }
  try {
    db.pragma("busy_timeout = 30000");
  } catch (err) {
    console.warn("[db] Failed to set busy_timeout:", err.message);
  }

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
 */
export async function performBackup(dbPath, destPath) {
  const filePath = dbPath || process.env.CROW_DB_PATH || resolve(resolveDataDir(), "crow.db");
  ensureKeeper(filePath);
  const keeper = _dbKeepers.get(filePath);
  return keeper.backup(destPath);
}
