// scripts/migrations/0033-reports-versions.mjs
//
// Crow Recurring Reports' run-to-version map: report_versions (one row per artifact version a run wrote,
// keyed on the version's own (artifact_id, n), with the run, the report, the trigger and the run's
// allowed http(s) links). The row is written inside the artifacts store's own version batch, so it
// exists exactly when the version does. Times are epoch ms. trigger carries no CHECK:
// servers/gateway/reports/run.js validates the three trigger words in JS. No foreign keys: the reports
// store removes one report's rows itself. LOCAL ONLY: the name is in instance-sync's LOCAL_ONLY_TABLES,
// because a row names a report and a report never leaves the instance holding it.
//
// ADDITIVE, no SCHEMA_GENERATION bump: init-db.js carries the same DDL as REPORTS_VERSIONS_DDL
// (servers/shared/reports-schema.js) on its own rail, so a co-hosted instance converging on its own
// restart gets it too. DDL only: there is nothing to backfill, and no schema object or row is removed.
// 0031's REPORTS_DDL and 0032's REPORTS_RUNS_DDL are untouched, because those migrations execute them
// and their approved shapes stay as they are.
import Database from "better-sqlite3";
import { REPORTS_VERSIONS_DDL, REPORTS_VERSIONS_TABLES } from "../../servers/shared/reports-schema.js";

export const id = "0033-reports-versions";

// rollbackSafe: one new local-only table and one index only; older code never reads them.
export const rollbackSafe = true;

export function run({ dbPath, log = () => {} }) {
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 10000");
  try {
    db.exec(REPORTS_VERSIONS_DDL);
    // CREATE TABLE/INDEX IF NOT EXISTS, so a re-run after a partial apply finds whatever is already
    // there and says the same thing.
    for (const table of REPORTS_VERSIONS_TABLES) log(`  ${table}: ensured`);
    return { applied: true, results: REPORTS_VERSIONS_TABLES.map((t) => `${t}: ensured`) };
  } finally {
    db.close();
  }
}