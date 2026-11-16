// scripts/migrations/0029-mail-account-send-columns.mjs
//
// Crow Mail A3: an account carries the name that goes on From (display_name), its other addresses
// (aliases_json, used by reply-all) and how its Sent copy is kept (sent_copy: 'provider' | 'append').
// ADD COLUMN only, from the same constant scripts/init-db.js loops (MAIL_ACCOUNT_SEND_COLUMNS in
// servers/shared/mail-schema.js) — one shape, two rails. 0027's MAIL_DDL is not touched: the columns
// are added to a table that already exists, and a fresh install gets them from init-db's own ALTERs
// right after it creates the table.
//
// mail_accounts is LOCAL ONLY (instance-sync's LOCAL_ONLY_TABLES), so there is no sync column list to
// change: an account never replicates to a paired instance.
//
// ADDITIVE, no SCHEMA_GENERATION bump: ADD COLUMN only, no back-fill, and it never drops or deletes.
// The column defaults ('[]' and 'provider') are what every existing account row reads afterwards;
// display_name stays NULL until the operator names the account. sent_copy is validated in the account
// store, not by a CHECK.
//
// mail_accounts is core crow.db — init-db creates it on every instance — so an "absent" read here is
// a store from before the mail tables existed. Recording applied is then correct: init-db's own
// addColumnIfMissing calls add the three columns when they create the table, and there is nothing
// left to retry (0005's reasoning).
import Database from "better-sqlite3";
import { addColumnIfMissing } from "./0005-bot-sessions-label-cwd.mjs";
import { MAIL_ACCOUNT_SEND_COLUMNS } from "../../servers/shared/mail-schema.js";

export const id = "0029-mail-account-send-columns";

// rollbackSafe: three additive mail_accounts columns only; older code never selects them.
export const rollbackSafe = true;

export function run({ dbPath, log = () => {} }) {
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 10000");
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mail_accounts'").get()) {
      log("  mail_accounts: absent — nothing to add");
      return { applied: true, results: ["mail_accounts: absent"] };
    }

    const results = [];
    // addColumnIfMissing reports "added" | "no-op" | "absent" and never throws on a missing
    // table, so a re-run after a partial list finds the columns already there and says no-op.
    for (const spec of MAIL_ACCOUNT_SEND_COLUMNS) {
      const r = addColumnIfMissing(db, spec.table, spec.column, spec.definition);
      log(`  ${spec.table}.${spec.column}: ${r}`);
      results.push(`${spec.table}.${spec.column}: ${r}`);
    }
    return { applied: true, results };
  } finally {
    db.close();
  }
}