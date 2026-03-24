/**
 * Crow Database Client Factory (Bundle Edition)
 *
 * Creates a @libsql/client instance for local SQLite files.
 *
 * Subset of servers/db.js — excludes verifyDb, auditLog, isSqliteVecAvailable.
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
  // Bundle fallback: try repo root's data/ dir (3 levels up from bundles/media/server/)
  const repoData = resolve(__dirname, "../../../data");
  if (existsSync(repoData)) return repoData;
  return resolve(home || ".", "data");
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
  const filePath = dbPath || process.env.CROW_DB_PATH || resolve(resolveDataDir(), "crow.db");
  const client = createClient({ url: `file:${filePath}` });
  client.execute("PRAGMA busy_timeout = 5000").catch(err =>
    console.warn("[db] Failed to set busy_timeout:", err.message)
  );
  return client;
}
