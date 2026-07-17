/**
 * PM Workspace — database client factory (bundle edition).
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

import { createClient } from "@libsql/client";
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
  // Bundle fallback: repo root's data/ (3 levels up from bundles/pm-workspace/server/)
  const repoData = resolve(__dirname, "../../../data");
  if (existsSync(repoData)) return repoData;
  return crowData;
}

/** Resolve the crow.db path without opening it. */
export function resolveDbPath(dbPath) {
  return dbPath || process.env.CROW_DB_PATH || join(resolveDataDir(), "crow.db");
}

/** Create a libsql client for the main crow DB. */
export function createDbClient(dbPath) {
  const filePath = resolveDbPath(dbPath);
  const client = createClient({ url: `file:${filePath}` });
  client.execute("PRAGMA busy_timeout = 10000").catch((err) =>
    console.warn("[pm-workspace db] Failed to set busy_timeout:", err.message)
  );
  return client;
}

/** Resolve the kanban tasks DB path (tasks bundle). */
export function resolveTasksDbPath(config = {}) {
  return (
    config.CROW_TASKS_DB_PATH ||
    process.env.CROW_TASKS_DB_PATH ||
    join(resolveDataDir(), "tasks.db")
  );
}

/** Create a libsql client for the tasks DB. Returns null if the file is absent. */
export function createTasksDbClient(config = {}) {
  const filePath = resolveTasksDbPath(config);
  if (!existsSync(filePath)) return null;
  const client = createClient({ url: `file:${filePath}` });
  client.execute("PRAGMA busy_timeout = 10000").catch((err) =>
    console.warn("[pm-workspace db] tasks.db busy_timeout:", err.message)
  );
  return client;
}
