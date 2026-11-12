// scripts/migrations/0027-mail-store.mjs
//
// The Crow Mail store: mail_accounts, mail_folders, mail_threads, mail_messages, the external-content
// mail_messages_fts index with its three triggers, mail_sync_state and mail_image_allow. The DDL lives
// in servers/shared/mail-schema.js (MAIL_DDL): init-db.js builds the same shape on its own rail, so a
// co-hosted instance converging on its own restart gets these tables too. LOCAL ONLY: every table is
// in instance-sync's LOCAL_ONLY_TABLES — this is the user's mail. Epoch-ms times; statuses and states
// are validated in the store, not by a CHECK. No foreign keys (one account's rows go in one
// transaction).
//
// ADDITIVE, no SCHEMA_GENERATION bump: DDL only, there is nothing to backfill.
import Database from "better-sqlite3";
import { MAIL_DDL } from "../../servers/shared/mail-schema.js";

export const id = "0027-mail-store";

// rollbackSafe: new tables, an index and triggers only; older code never reads them.
export const rollbackSafe = true;

export function run({ dbPath, log = () => {} }) {
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 10000");
  try {
    db.exec(MAIL_DDL);
    log("  mail tables: ensured");
  } finally {
    db.close();
  }
  return { applied: true, results: ["mail tables: ensured"] };
}