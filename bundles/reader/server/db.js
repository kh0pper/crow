/**
 * Reader — database client factory (bundle edition).
 *
 * Resolution order for the crow DB path:
 *   1. explicit dbPath argument
 *   2. CROW_DB_PATH env
 *   3. $CROW_DATA_DIR/crow.db
 *   4. $CROW_HOME/data/crow.db (default ~/.crow/data/crow.db)
 *
 * FTS sanitizer copied from the knowledge-base bundle so MATCH queries
 * are always literal-term safe.
 */

import { appImport } from "./app-root.js";
import { existsSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Sanitize user input for use in SQLite FTS5 MATCH queries.
 * Strips FTS5 operators and wraps individual terms in double quotes
 * for safe literal matching. Returns null if no valid terms remain.
 */
export function sanitizeFtsQuery(input) {
  if (!input || typeof input !== "string") return null;
  const cleaned = input
    .replace(/\b(AND|OR|NOT|NEAR)\b/gi, "")
    .replace(/[*"(){}[\]^~:]/g, "")
    .trim();
  if (!cleaned) return null;
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

/** Resolve the Crow data directory. */
export function resolveDataDir() {
  if (process.env.CROW_DATA_DIR) return resolve(process.env.CROW_DATA_DIR);
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  const crowData = join(process.env.CROW_HOME || join(home, ".crow"), "data");
  if (existsSync(crowData)) return crowData;
  // Bundle fallback: repo root's data/ (3 levels up from bundles/reader/server/)
  const repoData = resolve(__dirname, "../../../data");
  if (existsSync(repoData)) return repoData;
  return crowData;
}

/** Resolve the crow.db path without opening it. */
export function resolveDbPath(dbPath) {
  return dbPath || process.env.CROW_DB_PATH || join(resolveDataDir(), "crow.db");
}

/**
 * Shared better-sqlite3 client factory from the core repo (libsql-shaped
 * surface: execute/batch/executeMultiple/close). Loaded once at module init.
 *
 * A single SQLite implementation per process is a CORRECTNESS requirement,
 * not a preference: this module is imported into the gateway process by the
 * panel routes, and a second SQLite build (@libsql) opening crow.db there
 * defeats last-closer detection and unlinks the live WAL (see app-root.js
 * header — 2026-08-04 corruption root cause).
 *
 * Fallback: only when the core client cannot load (standalone install with
 * no repo checkout, or a node whose ABI can't load the repo's
 * better-sqlite3 — e.g. an externally spawned stdio MCP copy on an older
 * node). @libsql is imported LAZILY there so gateway-hosted code never even
 * maps the second SQLite library. Cross-process libsql is lock-safe; only
 * in-process mixing is not, and in-process always resolves the core client.
 */
let _coreCreateDbClient = null;
try {
  ({ createDbClient: _coreCreateDbClient } = await appImport("servers/db.js"));
} catch (err) {
  console.warn(
    `[reader db] core db client unavailable (${err.message}) — ` +
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
    console.warn(`[reader db] core db client failed (${err.message.split("\n")[0]}) -- ` +
      "falling back to @libsql/client (safe cross-process only)");
    return null;
  }
}


async function libsqlClient(filePath, label) {
  const { createClient } = await import("@libsql/client");
  const client = createClient({ url: `file:${filePath}` });
  client.execute("PRAGMA busy_timeout = 10000").catch((err) =>
    console.warn(`[reader db] ${label} busy_timeout:`, err.message)
  );
  return client;
}

/** Create a client for the main crow DB (core better-sqlite3 wrapper). */
export function createDbClient(dbPath) {
  const filePath = resolveDbPath(dbPath);
  return tryCoreClient(filePath) || libsqlProxy(filePath, "crow.db");
}

/**
 * Wrap the async libsql fallback in a lazily-resolving proxy so the factory
 * keeps its synchronous signature. Every method awaits the underlying
 * client's creation first.
 */
function libsqlProxy(filePath, label) {
  const clientPromise = libsqlClient(filePath, label);
  return {
    async execute(arg) { return (await clientPromise).execute(arg); },
    async batch(stmts) { return (await clientPromise).batch(stmts); },
    async executeMultiple(sql) { return (await clientPromise).executeMultiple(sql); },
    close() { clientPromise.then((c) => c.close()).catch(() => {}); },
  };
}
