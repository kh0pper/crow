// scripts/migrations/0013-research-provenance.mjs
//
// Fetch-before-cite: research_sources gains what Crow saw when it opened a page (fetch_status,
// fetched_at, final_url, http_status, content_sha256, fetched_text, fetch_error) and how a source
// came to be marked verified (verification_method, verified_by); research_notes gains per-claim
// provenance (provenance, quote_found, locator). Plus an index on (project_id, final_url) for
// add_source's dedupe.
//
// ADDITIVE, no SCHEMA_GENERATION bump: init-db.js applies the same PROVENANCE_COLUMNS (one shape,
// two rails, the 0005/0010/0011 story). ADD COLUMN only, never drops or deletes. The one-time
// back-fill (legacy rows: fetch_status 'legacy'; verified rows: verification_method 'legacy_flag')
// runs in the same transaction as the ADD that creates its column, so a re-run, or a row written
// after the column exists, is never back-filled.
//
// Deferred while either table still carries its pre-W2-5-B2 FK to research_projects: init-db's
// rebuild of those tables aborts on columns it does not know, so it must run before these land.
// Deferred too when either table is absent (init-db creates both, then applies this shape itself).
import Database from "better-sqlite3";
import { addColumnIfMissing } from "./0005-bot-sessions-label-cwd.mjs";
import { PROVENANCE_COLUMNS, PROVENANCE_INDEX_SQL } from "../../servers/research/provenance-schema.js";

export const id = "0013-research-provenance";

const TABLES = ["research_sources", "research_notes"];

/**
 * Why a research-table migration must wait on this DB, or null when it can run: either table is
 * absent, or still carries its pre-W2-5-B2 FK to research_projects. Shared with 0015.
 */
export function researchTablesDeferral(db) {
  for (const t of TABLES) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t)) {
      return `${t}: absent`;
    }
    if (db.prepare(`PRAGMA foreign_key_list(${t})`).all().some((r) => r.table === "research_projects")) {
      return `${t}: FK still targets research_projects — init-db's rebuild runs first`;
    }
  }
  return null;
}

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
    for (const spec of PROVENANCE_COLUMNS) {
      const r = db.transaction(() => {
        const out = addColumnIfMissing(db, spec.table, spec.column, spec.ddl);
        if (out === "added" && spec.backfill) db.prepare(spec.backfill).run();
        return out;
      }).immediate();
      log(`  ${spec.table}.${spec.column}: ${r}`);
      results.push(`${spec.table}.${spec.column}: ${r}`);
    }
    db.exec(PROVENANCE_INDEX_SQL);
    return { applied: true, results };
  } finally {
    db.close();
  }
}
