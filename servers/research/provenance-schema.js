// Fetch-before-cite provenance columns: the one shape both rails apply (scripts/init-db.js's
// provenance block and scripts/migrations/0013-research-provenance.mjs). Import-free on purpose:
// the migration, init-db and servers/research/ensure-schema.js all read it without a cycle.
//
// Each column is an ADD COLUMN (SQLite never rebuilds the table for it). `backfill` runs once, in
// the same transaction as the ADD that creates the column, and never again: a row written later
// with the column NULL stays NULL. fetched_text is deliberately NOT in sources_fts.

export const PROVENANCE_COLUMNS = [
  {
    table: "research_sources",
    column: "fetch_status",
    ddl: "TEXT CHECK(fetch_status IN ('fetched','fetched_no_text','failed','not_applicable','legacy'))",
    backfill: "UPDATE research_sources SET fetch_status = 'legacy'",
  },
  { table: "research_sources", column: "fetched_at", ddl: "TEXT", backfill: null },
  { table: "research_sources", column: "final_url", ddl: "TEXT", backfill: null },
  { table: "research_sources", column: "http_status", ddl: "INTEGER", backfill: null },
  { table: "research_sources", column: "content_sha256", ddl: "TEXT", backfill: null },
  { table: "research_sources", column: "fetched_text", ddl: "TEXT", backfill: null },
  { table: "research_sources", column: "fetch_error", ddl: "TEXT", backfill: null },
  {
    table: "research_sources",
    column: "verification_method",
    ddl: "TEXT CHECK(verification_method IN ('quotes_checked','manual_owner','legacy_flag'))",
    backfill: "UPDATE research_sources SET verification_method = 'legacy_flag' WHERE verified = 1",
  },
  { table: "research_sources", column: "verified_by", ddl: "TEXT", backfill: null },
  {
    table: "research_notes",
    column: "provenance",
    ddl: "TEXT CHECK(provenance IN ('fetched','snippet','derived'))",
    backfill: null,
  },
  { table: "research_notes", column: "quote_found", ddl: "INTEGER CHECK(quote_found IN (0,1))", backfill: null },
  { table: "research_notes", column: "locator", ddl: "TEXT", backfill: null },
];

// Note authorship and withdrawal (migration 0015; init-db applies the same specs right after the
// provenance block). Local-only like the provenance columns: created_by names a local actor
// ("owner", "bot:<id>") and a peer's value could name an unrelated local bot; a withdrawal is this
// instance's judgment of its own copy of a note. No back-fill: a note written before 0015 has no
// recorded author, and nothing is withdrawn until someone withdraws it.
export const NOTE_WITHDRAWAL_COLUMNS = [
  { table: "research_notes", column: "created_by", ddl: "TEXT", backfill: null },
  { table: "research_notes", column: "withdrawn_at", ddl: "TEXT", backfill: null },
  { table: "research_notes", column: "withdrawn_by", ddl: "TEXT", backfill: null },
  { table: "research_notes", column: "withdrawn_reason", ddl: "TEXT", backfill: null },
];

// A copy of a research_sources / research_notes row without its 0013 or 0015 columns: fetch facts,
// note provenance, authorship and withdrawal are this instance's own judgment of its copy (and
// fetched_text can be 200k chars), so no share path ever sends them. A no-op for any other table.
export function withoutProvenance(row, table) {
  const copy = { ...row };
  for (const { table: t, column } of [...PROVENANCE_COLUMNS, ...NOTE_WITHDRAWAL_COLUMNS]) {
    if (t === table) delete copy[column];
  }
  return copy;
}

export const PROVENANCE_INDEX_SQL =
  "CREATE INDEX IF NOT EXISTS idx_sources_project_final_url ON research_sources(project_id, final_url)";
