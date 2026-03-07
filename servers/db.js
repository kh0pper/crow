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
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createDbClient(dbPath) {
  const tursoUrl = process.env.TURSO_DATABASE_URL;
  const tursoToken = process.env.TURSO_AUTH_TOKEN;

  if (tursoUrl) {
    return createClient({ url: tursoUrl, authToken: tursoToken });
  }

  // Local file-based SQLite
  const filePath = dbPath || process.env.CROW_DB_PATH || resolve(__dirname, "../data/crow.db");
  return createClient({ url: `file:${filePath}` });
}
