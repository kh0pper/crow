/**
 * Crow Database Client Factory
 *
 * Creates a @libsql/client instance for local SQLite files.
 *
 * Shared by memory server, research server, gateway auth, and init-db.
 */

import { createClient } from "@libsql/client";
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
 * Eagerly probes the DB (libsql connections are lazy).
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
 * Classify an error as a libsql-client wedge (file is healthy but the
 * long-lived in-process client has poisoned its page cache). Recognises
 * both the SQLITE_CORRUPT "disk image is malformed" variant and the
 * SQLITE_IOERR "disk I/O error" variant that have been observed on MPA.
 *
 * See the MPA wedge investigation 2026-04-21 — sqlite3 CLI reads the
 * same file cleanly while the long-lived gateway client returns these
 * errors. Recreating the client clears the poisoned state.
 */
function isWedgeError(err) {
  const blob = String(err?.message || err) + " " + String(err?.code || "");
  return /SQLITE_CORRUPT|SQLITE_IOERR|disk image is malformed|disk I\/O error/i.test(blob);
}

function openUnwrappedClient(filePath) {
  const c = createClient({ url: `file:${filePath}` });
  c.execute("PRAGMA journal_mode = WAL").catch(err =>
    console.warn("[db] Failed to set WAL mode:", err.message)
  );
  c.execute("PRAGMA busy_timeout = 30000").catch(err =>
    console.warn("[db] Failed to set busy_timeout:", err.message)
  );
  return c;
}

/**
 * Create a libsql client wrapped with self-healing retry for the MPA
 * wedge class of errors. On SQLITE_CORRUPT / SQLITE_IOERR from execute()
 * or batch(), the wrapper closes the poisoned underlying client, opens
 * a fresh one against the same file, and retries the operation once.
 *
 * Transactions are NOT auto-retried — mid-transaction state can't be
 * safely replayed. Callers that need transaction-level resilience must
 * restart the transaction themselves.
 *
 * Recoveries are logged with an incrementing count so operators can
 * gauge wedge frequency without trawling logs for error text.
 */
export function createDbClient(dbPath) {
  const filePath = dbPath || process.env.CROW_DB_PATH || resolve(resolveDataDir(), "crow.db");

  let client = openUnwrappedClient(filePath);
  let closed = false;
  let recoveryCount = 0;
  let lastRecoveryAt = 0;

  async function tryRecover() {
    if (closed) return false;
    const now = Date.now();
    // Throttle: at most one recovery per 500ms per wrapper. Parallel
    // operations that all see the wedge converge on this throttle so we
    // don't thrash close/open cycles.
    if (now - lastRecoveryAt < 500) return false;
    lastRecoveryAt = now;
    recoveryCount++;
    console.warn(`[db] libsql wedge on ${filePath} — recreating client (recovery #${recoveryCount})`);
    try { client.close(); } catch {}
    client = openUnwrappedClient(filePath);
    return true;
  }

  async function withRetry(method, args) {
    try {
      return await client[method](...args);
    } catch (err) {
      if (!isWedgeError(err)) throw err;
      const recovered = await tryRecover();
      if (!recovered) throw err;
      // Single retry on the fresh client. If this also wedges, propagate.
      return await client[method](...args);
    }
  }

  // Explicit wrappers for the retryable methods. Other libsql client
  // methods fall through to the current underlying client via the Proxy
  // below — future API additions won't silently break callers, at the
  // cost of not getting auto-retry (transactions intentionally fall
  // through since mid-transaction state can't be safely replayed).
  const wrapped = {
    execute: (...args) => withRetry("execute", args),
    batch: (...args) => withRetry("batch", args),
    executeMultiple: (...args) => withRetry("executeMultiple", args),
    transaction: (...args) => client.transaction(...args),
    close: () => {
      closed = true;
      try { client.close(); } catch {}
    },
    get _recoveryCount() { return recoveryCount; },
  };

  return new Proxy(wrapped, {
    get(target, prop) {
      if (prop in target) return target[prop];
      // Fall through to the live underlying client for any unwrapped
      // method (migrate, sync, etc.). `client` is captured by closure
      // and updated on recovery, so even a fallthrough call sees the
      // freshest client.
      const v = client[prop];
      return typeof v === "function" ? v.bind(client) : v;
    },
  });
}
