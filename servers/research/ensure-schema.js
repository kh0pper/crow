// ensureProvenanceSchema: bring one crow.db up to the provenance shape at server construction,
// whatever the instance's restart order (0013 may not have run yet on a co-hosted instance).
// Kept out of provenance-schema.js so that file stays import-free and 0013 can import it.
//
// Never throws. `ready` is true only when every PROVENANCE_COLUMNS column exists afterwards;
// "deferred" means 0013 declined (tables absent, or the old research_projects FK shape still
// waiting on init-db's rebuild); "error" is anything else (a busy store, an unreadable file).
import Database from "better-sqlite3";
import { run } from "../../scripts/migrations/0013-research-provenance.mjs";
import { run as run0015 } from "../../scripts/migrations/0015-research-note-withdrawal.mjs";
import { PROVENANCE_COLUMNS, NOTE_WITHDRAWAL_COLUMNS } from "./provenance-schema.js";

function missingColumns(dbPath, specs = PROVENANCE_COLUMNS) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const have = new Map();
    const cols = (t) => {
      if (!have.has(t)) have.set(t, new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name)));
      return have.get(t);
    };
    return specs.filter(({ table, column }) => !cols(table).has(column)).map((c) => `${c.table}.${c.column}`);
  } finally {
    db.close();
  }
}

/** @returns {{ready: boolean, state: "ready"|"deferred"|"error", reason?: string}} */
export function ensureProvenanceSchema(dbPath) {
  try {
    const outcome = run({ dbPath, log: () => {} });
    if (outcome && outcome.deferred) {
      return { ready: false, state: "deferred", reason: "research tables absent or still on the research_projects FK shape" };
    }
    const missing = missingColumns(dbPath);
    if (missing.length) return { ready: false, state: "error", reason: `missing columns: ${missing.join(", ")}` };
    return { ready: true, state: "ready" };
  } catch (err) {
    return { ready: false, state: "error", reason: err && err.message ? err.message : String(err) };
  }
}

/**
 * ensureWithdrawalSchema: the same contract for 0015's note authorship and withdrawal columns,
 * kept separate so a DB where they fail to land leaves provenance readiness (and every
 * fetch-before-cite tool) alone; only note withdrawal degrades.
 *
 * Test-only seam: CROW_TEST_SKIP_WITHDRAWAL_SCHEMA=1 makes it report an error without touching the
 * file, so a test can build a server whose withdrawal columns are missing. Nothing in the product
 * sets it.
 * @returns {{ready: boolean, state: "ready"|"deferred"|"error", reason?: string}}
 */
export function ensureWithdrawalSchema(dbPath) {
  if (process.env.CROW_TEST_SKIP_WITHDRAWAL_SCHEMA === "1") {
    return { ready: false, state: "error", reason: "skipped (CROW_TEST_SKIP_WITHDRAWAL_SCHEMA)" };
  }
  try {
    const outcome = run0015({ dbPath, log: () => {} });
    if (outcome && outcome.deferred) {
      return { ready: false, state: "deferred", reason: "research tables absent or still on the research_projects FK shape" };
    }
    const missing = missingColumns(dbPath, NOTE_WITHDRAWAL_COLUMNS);
    if (missing.length) return { ready: false, state: "error", reason: `missing columns: ${missing.join(", ")}` };
    return { ready: true, state: "ready" };
  } catch (err) {
    return { ready: false, state: "error", reason: err && err.message ? err.message : String(err) };
  }
}
