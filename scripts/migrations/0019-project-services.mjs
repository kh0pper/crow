// scripts/migrations/0019-project-services.mjs
//
// Project services, the schema half:
//   - service_connections: a project's connected accounts (one row per account, per service). LOCAL
//     ONLY: the table is in instance-sync's LOCAL_ONLY_TABLES. Deleting a project cascades its rows away.
//   - crow_keychain.connection_uuid + idx_crow_keychain_service: a kind 'service' secret is linked to
//     its connection by uuid, one secret per (connection, env_key).
//   - chat_conversations.project_id: the project a chat belongs to. No backfill: existing threads
//     stay in "Everything".
//   - bot_jobs.principal: who started a job. Existing rows stay NULL, which fails closed.
//
// ADDITIVE, no SCHEMA_GENERATION bump: scripts/init-db.js builds from the same constants
// (servers/shared/project-services-schema.js; one shape, two rails, the 0005/0010/0018 story), so a
// co-hosted instance converging on its own restart gets it too. DDL only: it never drops or deletes.
//
// Defers while project_spaces is absent (the connections table references it; init-db creates it).
// Each column is added only when its table exists: crow_keychain and bot_jobs are also created
// lazily (ensureKeychainTable, the bot_jobs ensure), and both of those carry the new column in their
// CREATE body and add it to an older table themselves.
import Database from "better-sqlite3";
import {
  SERVICE_CONNECTIONS_DDL,
  CHAT_PROJECT_COLUMN,
  KEYCHAIN_CONNECTION_COLUMN,
  BOT_JOBS_PRINCIPAL_COLUMN,
  KEYCHAIN_SERVICE_INDEX_DDL,
} from "../../servers/shared/project-services-schema.js";

export const id = "0019-project-services";

const hasTable = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

/** "added" | "no-op" | "absent" — runs the constant's own ALTER; never throws on a missing table. */
function addColumn(db, { table, column, ddl }) {
  if (!hasTable(db, table)) return "absent";
  if (db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column)) return "no-op";
  db.exec(ddl);
  return "added";
}

export function run({ dbPath, log = () => {} }) {
  const results = [];
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 10000");
  try {
    if (!hasTable(db, "project_spaces")) {
      log("  project_spaces absent: deferred");
      return { deferred: true };
    }
    const note = (r) => { log(`  ${r}`); results.push(r); };
    db.transaction(() => {
      db.exec(SERVICE_CONNECTIONS_DDL);
      note("service_connections: ensured");
      for (const c of [CHAT_PROJECT_COLUMN, KEYCHAIN_CONNECTION_COLUMN, BOT_JOBS_PRINCIPAL_COLUMN]) {
        note(`${c.table}.${c.column}: ${addColumn(db, c)}`);
      }
      if (hasTable(db, "crow_keychain")) {
        db.exec(KEYCHAIN_SERVICE_INDEX_DDL);
        note("idx_crow_keychain_service: ensured");
      }
    })();
  } finally {
    db.close();
  }
  return { applied: true, results };
}
