/**
 * Crow Database Client Factory
 *
 * Creates a @libsql/client instance configured for either:
 * - Turso (remote): when TURSO_DATABASE_URL is set
 * - Local SQLite file: fallback using file: URL
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

export function createDbClient(dbPath) {
  const tursoUrl = process.env.TURSO_DATABASE_URL;
  const tursoToken = process.env.TURSO_AUTH_TOKEN;

  if (tursoUrl) {
    return createClient({ url: tursoUrl, authToken: tursoToken });
  }

  // Local file-based SQLite
  const filePath = dbPath || process.env.CROW_DB_PATH || resolve(resolveDataDir(), "crow.db");
  return createClient({ url: `file:${filePath}` });
}
