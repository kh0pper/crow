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
 * Resolve the Crow data directory path.
 * Priority: CROW_DATA_DIR env -> ~/.crow/data/ -> ./data/ (fallback)
 */
export function resolveDataDir() {
  if (process.env.CROW_DATA_DIR) {
    return resolve(process.env.CROW_DATA_DIR);
  }
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const crowHome = resolve(home, ".crow", "data");
  if (home && existsSync(crowHome)) {
    return crowHome;
  }
  // Bundle fallback: try repo root's data/ dir (3 levels up from bundles/iptv/server/)
  const repoData = resolve(__dirname, "../../../data");
  if (existsSync(repoData)) return repoData;
  return resolve(home || ".", "data");
}

export function createDbClient(dbPath) {
  const filePath = dbPath || process.env.CROW_DB_PATH || resolve(resolveDataDir(), "crow.db");
  return createClient({ url: `file:${filePath}` });
}
