// scripts/migrations/0031-reports-core.mjs
//
// Crow Recurring Reports' core tables: reports (one row per report: the head recipe, the delivery and
// comment settings, the go-live seal columns), report_recipe_revisions (every recipe saved, one row
// per revision, written once), report_state (the report's own key/value store), report_usage (a day's
// sends, bot minutes and extra step runs against the caps) and report_approvals_audit (every approval
// decision, refused and revoked ones included). Times are epoch ms. status, author_kind, delivery and
// comment words carry no CHECK: the stores validate them in JS. No foreign keys: the store removes one
// report's rows itself. LOCAL ONLY: every name is in instance-sync's LOCAL_ONLY_TABLES, because a
// report names the owner's sources, recipients and credentials, and never leaves the instance holding
// it.
//
// ADDITIVE, no SCHEMA_GENERATION bump: init-db.js carries the same DDL as REPORTS_DDL
// (servers/shared/reports-schema.js) on its own rail, so a co-hosted instance converging on its own
// restart gets it too. DDL only: there is nothing to backfill, and no schema object or row is removed.
import Database from "better-sqlite3";
import { REPORTS_DDL, REPORTS_TABLES } from "../../servers/shared/reports-schema.js";

export const id = "0031-reports-core";

// rollbackSafe: five new local-only tables and two indexes only; older code never reads them.
export const rollbackSafe = true;

export function run({ dbPath, log = () => {} }) {
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 10000");
  try {
    db.exec(REPORTS_DDL);
    // CREATE TABLE/INDEX IF NOT EXISTS, so a re-run after a partial apply finds whatever is already
    // there and says the same thing.
    for (const table of REPORTS_TABLES) log(`  ${table}: ensured`);
    return { applied: true, results: REPORTS_TABLES.map((t) => `${t}: ensured`) };
  } finally {
    db.close();
  }
}