/**
 * Crow Tax — Database Client
 *
 * Reuses the standard Crow DB pattern.
 */

import { createClient } from "@libsql/client";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function resolveDataDir() {
  if (process.env.CROW_DATA_DIR) {
    return resolve(process.env.CROW_DATA_DIR);
  }
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const crowHome = resolve(home, ".crow", "data");
  if (home && existsSync(crowHome)) {
    return crowHome;
  }
  const repoData = resolve(__dirname, "../../../data");
  if (existsSync(repoData)) return repoData;
  return resolve(home || ".", "data");
}

export function createDbClient(dbPath) {
  const filePath = dbPath || process.env.CROW_TAX_DB_PATH || process.env.CROW_DB_PATH || resolve(resolveDataDir(), "crow.db");
  const client = createClient({ url: `file:${filePath}` });
  client.execute("PRAGMA busy_timeout = 5000").catch(err =>
    console.warn("[db] Failed to set busy_timeout:", err.message)
  );
  return client;
}
