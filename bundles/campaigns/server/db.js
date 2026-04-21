/**
 * Crow Campaigns — Database Client Factory
 *
 * Creates a @libsql/client instance pointing at Crow's shared crow.db.
 * Enables foreign keys for cascading deletes.
 */

import { createClient } from "@libsql/client";
import { existsSync } from "fs";
import { resolve } from "path";

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
  return resolve(home || ".", "data");
}

export function createDbClient(dbPath) {
  const filePath = dbPath || process.env.CROW_DB_PATH || resolve(resolveDataDir(), "crow.db");
  const client = createClient({ url: `file:${filePath}` });
  client.execute("PRAGMA busy_timeout = 5000").catch(err =>
    console.warn("[campaigns-db] Failed to set busy_timeout:", err.message)
  );
  client.execute("PRAGMA foreign_keys = ON").catch(err =>
    console.warn("[campaigns-db] Failed to enable foreign_keys:", err.message)
  );
  return client;
}
