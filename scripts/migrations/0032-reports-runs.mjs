// scripts/migrations/0032-reports-runs.mjs
//
// Crow Recurring Reports' runs: report_runs (one row per attempt at running a report: who asked, the
// scheduled window, the run engine's status, the small block log and the redacted error text) and
// report_run_requests (the queue a bot tool inserts a preview or a run now into; the runner claims it,
// the tool never starts a run itself). Times are epoch ms. trigger, status and kind carry no CHECK:
// servers/gateway/reports/run.js validates them in JS. No foreign keys: the store removes one report's
// rows itself. LOCAL ONLY: both names are in instance-sync's LOCAL_ONLY_TABLES, because a run names the
// owner's sources and a report never leaves the instance holding it.
//
// ADDITIVE, no SCHEMA_GENERATION bump: init-db.js carries the same DDL as REPORTS_RUNS_DDL
// (servers/shared/reports-schema.js) on its own rail, so a co-hosted instance converging on its own
// restart gets it too. DDL only: there is nothing to backfill, and no schema object or row is removed.
// 0031's REPORTS_DDL is untouched, because 0031 executes it and its approved shape stays as it is.
import Database from "better-sqlite3";
import { REPORTS_RUNS_DDL, REPORTS_RUNS_TABLES } from "../../servers/shared/reports-schema.js";

export const id = "0032-reports-runs";

// rollbackSafe: two new local-only tables and three indexes only; older code never reads them.
export const rollbackSafe = true;

export function run({ dbPath, log = () => {} }) {
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 10000");
  try {
    db.exec(REPORTS_RUNS_DDL);
    // CREATE TABLE/INDEX IF NOT EXISTS, so a re-run after a partial apply finds whatever is already
    // there and says the same thing.
    for (const table of REPORTS_RUNS_TABLES) log(`  ${table}: ensured`);
    return { applied: true, results: REPORTS_RUNS_TABLES.map((t) => `${t}: ensured`) };
  } finally {
    db.close();
  }
}