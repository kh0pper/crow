// scripts/migrations/0021-satellites.mjs
//
// Satellite tables (satellites, satellite_revocations, satellite_tool_pins, satellite_bot_optins).
// LOCAL ONLY (instance-sync LOCAL_ONLY_TABLES). ADDITIVE and idempotent, no SCHEMA_GENERATION bump:
// scripts/init-db.js builds from the same constant (servers/shared/satellite-schema.js), one shape,
// two rails. DDL only: it never drops or deletes.
import Database from "better-sqlite3";
import { SATELLITE_DDL } from "../../servers/shared/satellite-schema.js";

export const id = "0021-satellites";

export function run({ dbPath, log = () => {} }) {
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 10000");
  try {
    db.transaction(() => {
      db.exec(SATELLITE_DDL);
      log("  satellite tables: ensured");
    }).immediate();
  } finally {
    db.close();
  }
  return { applied: true };
}
