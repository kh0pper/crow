// scripts/migrations/0015-research-note-withdrawal.mjs
//
// Withdraw a bad quote note: research_notes gains who wrote it (created_by: "owner" or
// "bot:<id>", recorded at add time) and whether it was withdrawn here (withdrawn_at,
// withdrawn_by, withdrawn_reason). A withdrawn note stays in the table (the record of what was
// claimed) but no longer counts as a live quote.
//
// ADDITIVE, no SCHEMA_GENERATION bump: init-db.js applies the same NOTE_WITHDRAWAL_COLUMNS right
// after its provenance block (one shape, two rails). ADD COLUMN only, never drops or deletes, no
// back-fill, no index. Defers exactly when 0013 does (researchTablesDeferral): the research tables
// are absent, or still on the old research_projects FK shape that init-db's rebuild must fix first.
import Database from "better-sqlite3";
import { addColumnIfMissing } from "./0005-bot-sessions-label-cwd.mjs";
import { researchTablesDeferral } from "./0013-research-provenance.mjs";
import { NOTE_WITHDRAWAL_COLUMNS } from "../../servers/research/provenance-schema.js";

export const id = "0015-research-note-withdrawal";

export function run({ dbPath, log = () => {} }) {
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 10000");
  try {
    const deferral = researchTablesDeferral(db);
    if (deferral) {
      log(`  ${deferral}`);
      return { deferred: true };
    }

    const results = [];
    for (const spec of NOTE_WITHDRAWAL_COLUMNS) {
      const r = db.transaction(() => addColumnIfMissing(db, spec.table, spec.column, spec.ddl)).immediate();
      log(`  ${spec.table}.${spec.column}: ${r}`);
      results.push(`${spec.table}.${spec.column}: ${r}`);
    }
    return { applied: true, results };
  } finally {
    db.close();
  }
}
