// scripts/migrations/0034-reports-send.mjs
//
// Crow Recurring Reports' send half: report_recipients (one row per report and address, lower-cased,
// with the owner's approval nonce and seal and the four state words) and report_sends (the send log:
// one row per run, recipient and attempt, carrying the claim token, the Crow-made Message-ID, the
// provider's id and a short reason). Epoch-ms times. States are validated in the stores
// (servers/gateway/reports/approvals.js and the mail module's reports send door), never by a CHECK. No
// foreign keys: the reports store removes one report's rows itself. LOCAL ONLY: both names are in
// instance-sync's LOCAL_ONLY_TABLES, because a recipient is a person the owner writes to and a send
// names them, and a report never leaves the instance holding it.
//
// ADDITIVE, no SCHEMA_GENERATION bump: init-db.js carries the same DDL as REPORTS_SEND_DDL
// (servers/shared/reports-schema.js) on its own rail, so a co-hosted instance converging on its own
// restart gets it too. DDL only: there is nothing to backfill, and no schema object or row is removed.
// The earlier reports constants (0031's REPORTS_DDL, 0032's REPORTS_RUNS_DDL, 0033's
// REPORTS_VERSIONS_DDL) are untouched, because those migrations execute them and their approved shapes
// stay as they are.
import Database from "better-sqlite3";
import { REPORTS_SEND_DDL, REPORTS_SEND_TABLES } from "../../servers/shared/reports-schema.js";

export const id = "0034-reports-send";

// rollbackSafe: two new local-only tables and three indexes only; older code never reads them.
export const rollbackSafe = true;

export function run({ dbPath, log = () => {} }) {
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 10000");
  try {
    db.exec(REPORTS_SEND_DDL);
    // CREATE TABLE/INDEX IF NOT EXISTS, so a re-run after a partial apply finds whatever is already
    // there and says the same thing.
    for (const table of REPORTS_SEND_TABLES) log(`  ${table}: ensured`);
    return { applied: true, results: REPORTS_SEND_TABLES.map((t) => `${t}: ensured`) };
  } finally {
    db.close();
  }
}