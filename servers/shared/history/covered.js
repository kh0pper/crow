/**
 * covered.js — what version history records, and the trigger SQL that records it.
 *
 * One map, `COVERED`, from `item_type` to the table behind it and the columns a
 * version snapshots. Everything else is derived from it: the migration that
 * installs the triggers (scripts/migrations/0024-item-versions.mjs), the
 * History API's field list, and the tests. Adding a covered table in a later
 * task means adding one entry here plus its migration.
 *
 * Two rules the lists obey, both asserted by tests/history-capture.test.js:
 *   - every content column is tracked;
 *   - no column whose name matches /api_key|token|secret|password/i is ever
 *     tracked (secrets are never versioned — the version table must not become
 *     a second copy of a key), and no counter, timestamp, sync clock or derived
 *     id is tracked either.
 *
 * The triggers are ordinary SQLite triggers, so a write is recorded however it
 * arrives — including a bot's direct SQL over its own connection, which is the
 * case this feature exists for. They sit BESIDE init-db's FTS triggers and
 * never modify them.
 */

/**
 * The item types under capture.
 *
 * `idColumn` is the table's primary key; the version row stores it as TEXT so
 * one table can key several shapes.
 *
 * `tracked` is the snapshot's field list, in display order. Choices worth
 * knowing:
 *   - memories: the six content columns. NOT project_id / project_uuid /
 *     instance_id (placement pointers the write path and the sync layer stamp)
 *     and NOT access_count / accessed_at — a memory that is only *recalled* is
 *     not a change (review focus 1).
 *   - blog_posts: every content column (the plan's six plus the byline, the
 *     visibility and the cover image). NOT nostr_event_id (an id derived from
 *     publishing elsewhere), NOT published_at/created_at/updated_at.
 *   - crow_context: the section's key, title, body, its enabled toggle and its
 *     scope keys — a section's identity IS its scope, so device_id and
 *     project_id are tracked. NOT sort_order (an ordering counter),
 *     NOT updated_at, NOT lamport_ts.
 */
export const COVERED = Object.freeze({
  memory: Object.freeze({
    table: "memories",
    idColumn: "id",
    tracked: Object.freeze(["content", "context", "tags", "source", "category", "importance"]),
  }),
  blog_post: Object.freeze({
    table: "blog_posts",
    idColumn: "id",
    tracked: Object.freeze([
      "title",
      "slug",
      "content",
      "excerpt",
      "author",
      "status",
      "visibility",
      "cover_image_key",
      "tags",
    ]),
  }),
  context_section: Object.freeze({
    table: "crow_context",
    idColumn: "id",
    tracked: Object.freeze([
      "section_key",
      "section_title",
      "content",
      "enabled",
      "device_id",
      "project_id",
    ]),
  }),
});

/** A credential-shaped column name. Never tracked. */
export const SECRET_COLUMN = /api_key|token|secret|password/i;

// Fail at import rather than at the first bot write: a tracked credential
// column would put a key into the version table.
for (const [itemType, spec] of Object.entries(COVERED)) {
  for (const column of spec.tracked) {
    if (SECRET_COLUMN.test(column)) {
      throw new Error(`history: ${itemType}.${column} looks like a credential column and must never be versioned`);
    }
  }
}

/** Trigger names for one covered table: hist_<table>{_ai,_au,_ad}. */
export function triggerNames(spec) {
  return ["ai", "au", "ad"].map((suffix) => `hist_${spec.table}_${suffix}`);
}

// SQL string literal, single quotes doubled.
const str = (s) => `'${String(s).replace(/'/g, "''")}'`;

// A json_object(...) snapshot of the tracked columns of one row (NEW or OLD).
const snapshotOf = (spec, row) =>
  `json_object(${spec.tracked.map((c) => `${str(c)}, ${row}."${c}"`).join(", ")})`;

/**
 * The three CREATE TRIGGER statements for one covered item type:
 *
 *   hist_<table>_ai  AFTER INSERT  → op 'insert', snapshot of NEW
 *   hist_<table>_au  AFTER UPDATE  → op 'update' of NEW, but ONLY when a tracked
 *                                     column actually changed (each compared with
 *                                     IS NOT, so a NULL↔value move counts and a
 *                                     recalled memory does not)
 *   hist_<table>_ad  AFTER DELETE  → op 'delete', snapshot of OLD (a delete
 *                                     keeps what it removed)
 *
 * `IF NOT EXISTS` makes the migration re-runnable.
 *
 * TODO(history-redaction, Task 4): redaction is deliberately NOT done here. The
 * public-hygiene secret rules are JavaScript regexes; SQLite has no `regexp`
 * unless a connection registers one, and the connections that matter most here
 * are raw ones (a bot's own sqlite3 client). A trigger that called a missing
 * function would fail that write outright, and one that silently fell back to
 * LIKE would store the secret anyway. Task 4's sweep scans versions with
 * redacted = 0, replaces matches with "[redacted]" and sets redacted = 1; until
 * it ships, a secret written into a covered column is copied verbatim into
 * item_versions.
 */
export function triggerSql(itemType) {
  const spec = COVERED[itemType];
  if (!spec) throw new Error(`history: unknown item_type ${str(itemType)}`);

  const [ai, au, ad] = triggerNames(spec);
  const idOf = (row) => `CAST(${row}."${spec.idColumn}" AS TEXT)`;
  const insert = (row, op) =>
    `INSERT INTO item_versions (item_type, item_id, op, snapshot_json)\n` +
    `    VALUES (${str(itemType)}, ${idOf(row)}, ${str(op)}, ${snapshotOf(spec, row)});`;
  const changed = spec.tracked.map((c) => `NEW."${c}" IS NOT OLD."${c}"`).join(" OR ");

  return [
    `CREATE TRIGGER IF NOT EXISTS ${ai} AFTER INSERT ON ${spec.table} BEGIN\n  ${insert("NEW", "insert")}\nEND`,
    `CREATE TRIGGER IF NOT EXISTS ${au} AFTER UPDATE ON ${spec.table}\n` +
      `WHEN ${changed}\nBEGIN\n  ${insert("NEW", "update")}\nEND`,
    `CREATE TRIGGER IF NOT EXISTS ${ad} AFTER DELETE ON ${spec.table} BEGIN\n  ${insert("OLD", "delete")}\nEND`,
  ];
}