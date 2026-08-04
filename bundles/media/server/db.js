/**
 * Crow Database Client Factory (Bundle Edition)
 *
 * Creates a @libsql/client instance for local SQLite files.
 *
 * Subset of servers/db.js — excludes verifyDb, auditLog, isSqliteVecAvailable.
 */

import { appImport } from "./app-root.js";
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

let _coreCreateDbClient = null;
try {
  ({ createDbClient: _coreCreateDbClient } = await appImport("servers/db.js"));
} catch (err) {
  console.warn(
    `[media db] core db client unavailable (${err.message}) — ` +
    "will fall back to @libsql/client (safe cross-process only)"
  );
}

let _coreBroken = false;
/** Core factory with call-time fallback: better-sqlite3 binds its native
 *  module lazily at construction, so an ABI mismatch (e.g. a node 20
 *  process importing a node 22 build) throws HERE, not at import. */
function tryCoreClient(filePath) {
  if (_coreBroken || !_coreCreateDbClient) return null;
  try { return _coreCreateDbClient(filePath); }
  catch (err) {
    _coreBroken = true;
    console.warn(`[media db] core db client failed (${err.message.split("\n")[0]}) -- ` +
      "falling back to @libsql/client (safe cross-process only)");
    return null;
  }
}


// Lazy @libsql fallback: never statically load a second SQLite build into a
// process that may already hold better-sqlite3 connections (see app-root.js
// header — 2026-08-04 corruption root cause).
function libsqlProxy(filePath, extraPragmas = []) {
  const clientPromise = import("@libsql/client").then(({ createClient }) => {
    const client = createClient({ url: `file:${filePath}` });
    for (const p of ["PRAGMA busy_timeout = 5000", ...extraPragmas]) {
      client.execute(p).catch(err => console.warn("[media db]", p, "failed:", err.message));
    }
    return client;
  });
  return {
    async execute(arg) { return (await clientPromise).execute(arg); },
    async batch(stmts) { return (await clientPromise).batch(stmts); },
    async executeMultiple(sql) { return (await clientPromise).executeMultiple(sql); },
    close() { clientPromise.then((c) => c.close()).catch(() => {}); },
  };
}

export function createDbClient(dbPath) {
  const filePath = dbPath || process.env.CROW_DB_PATH || resolve(resolveDataDir(), "crow.db");
  const core = tryCoreClient(filePath);
  if (core) return core;
  return libsqlProxy(filePath);
}
