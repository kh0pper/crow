/**
 * covered.js — what version history records, and the trigger SQL that records it.
 *
 * One map, `COVERED`, from `item_type` to the table behind it and the columns a
 * version snapshots. Everything else is derived from it: the migration that
 * installs the triggers (scripts/migrations/0024-item-versions.mjs), the boot
 * re-ensure (servers/shared/history/ensure.js), the History API's field list and
 * the tests. Adding a covered table in a later task means adding one entry here
 * plus its migration.
 *
 * TWO LISTS, deliberately separate:
 *
 *   `tracked`  — what TRIGGERS a version. The update trigger's WHEN clause is
 *               this list, so a column here decides "is this a change?".
 *   `snapshot` — what the version STORES: the whole row minus counters, derived
 *               ids/orderings, timestamps, sync clocks and anything
 *               credential-shaped. It is the item as it was, because Task 4's
 *               erase and the reader both need the row, not just the edit.
 *
 * They differ on purpose. Placement/ownership pointers (memories.project_id /
 * project_uuid / instance_id, blog_posts.published_at / nostr_event_id) are not
 * changes worth a version on their own, but they must be IN the snapshot so a
 * version keeps its filing (a deleted memory's versions stay findable by
 * project) and so a redaction/erase knows what it is erasing.
 *
 * `projectRef` is the ordering used to fill item_versions.project_ref: the first
 * non-empty column in the list, cast to TEXT. That column is the erase scope —
 * Task 4 finds an item's versions by project/learner without joining a table
 * that may have deleted the row.
 *
 * Two rules the lists obey, both asserted at import below and by
 * tests/history-capture.test.js:
 *   - every column the WHEN clause names is also snapshotted (a change that is
 *     detected must be recorded);
 *   - no column whose name matches /api_key|token|secret|password/i is ever
 *     tracked OR snapshotted (secrets are never versioned — the version table
 *     must not become a second copy of a key).
 *
 * The triggers are ordinary SQLite triggers, so a write is recorded however it
 * arrives — including a bot's direct SQL over its own connection, which is the
 * case this feature exists for. They sit BESIDE init-db's FTS triggers and never
 * modify them.
 *
 * INSERT OR REPLACE is recorded as insert → insert, not insert → update:
 * SQLite's REPLACE deletes the conflicting row and inserts a new one, and with
 * `recursive_triggers` off (Crow's connections never turn it on) the delete
 * trigger does not fire for the replaced row. Task 3's history reader tolerates
 * that pair; it must not assume an update row exists.
 */

/**
 * The item types under capture.
 *
 * `idColumn` is the table's primary key; the version row stores it as TEXT so
 * one table can key several shapes.
 *
 * `tracked` is the update trigger's WHEN list, in display order. Choices worth
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
 *
 * `snapshot` is the full row minus counters/derived/secret-named columns, so
 * memories carries its filing (project_id, project_uuid), blog_posts carries
 * published_at and nostr_event_id, and crow_context keeps its list.
 */
export const COVERED = Object.freeze({
  memory: Object.freeze({
    table: "memories",
    idColumn: "id",
    tracked: Object.freeze(["content", "context", "tags", "source", "category", "importance"]),
    snapshot: Object.freeze([
      "content",
      "context",
      "tags",
      "source",
      "category",
      "importance",
      "instance_id",
      "project_id",
      "project_uuid",
    ]),
    // Portable project id first: project_id is a per-instance FK, so a version
    // that outlives the project row must key on the uuid when it has one.
    projectRef: Object.freeze(["project_uuid", "project_id"]),
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
    snapshot: Object.freeze([
      "title",
      "slug",
      "content",
      "excerpt",
      "author",
      "status",
      "visibility",
      "cover_image_key",
      "tags",
      "nostr_event_id",
      "published_at",
    ]),
    // A blog post belongs to the instance, not to a project.
    projectRef: Object.freeze([]),
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
    snapshot: Object.freeze([
      "section_key",
      "section_title",
      "content",
      "enabled",
      "device_id",
      "project_id",
    ]),
    projectRef: Object.freeze(["project_id"]),
  }),
});

/** A credential-shaped column name. Never tracked, never snapshotted. */
export const SECRET_COLUMN = /api_key|token|secret|password/i;

// Fail at import rather than at the first bot write: a tracked credential
// column would put a key into the version table, and a tracked column that the
// snapshot omits would record "something changed" with nothing to show.
for (const [itemType, spec] of Object.entries(COVERED)) {
  for (const column of [...spec.tracked, ...spec.snapshot]) {
    if (SECRET_COLUMN.test(column)) {
      throw new Error(`history: ${itemType}.${column} looks like a credential column and must never be versioned`);
    }
  }
  for (const column of [...spec.tracked, ...spec.projectRef]) {
    if (!spec.snapshot.includes(column)) {
      throw new Error(`history: ${itemType}.${column} is tracked or a project ref but is not snapshotted`);
    }
  }
  if (spec.snapshot.includes(spec.idColumn)) {
    throw new Error(`history: ${itemType}.${spec.idColumn} is the item key, never a snapshot field`);
  }
}

/** Trigger names for one covered table: hist_<table>{_ai,_au,_ad}. */
export function triggerNames(spec) {
  return ["ai", "au", "ad"].map((suffix) => `hist_${spec.table}_${suffix}`);
}

// SQL string literal, single quotes doubled.
const str = (s) => `'${String(s).replace(/'/g, "''")}'`;

// A column reference: `NEW."content"`, or `"content"` for a bare SELECT.
const colRef = (column, row) => (row ? `${row}."${column}"` : `"${column}"`);

/**
 * One stored value, BLOB-safe.
 *
 * json_object() raises "JSON cannot hold BLOB values" for a blob, and SQLite
 * does not enforce declared column types — a `content` column can hold one. A
 * raw bot write carrying a blob must not fail its own INSERT (the trigger runs
 * inside the write) and must not fail the migration's baseline, so a blob is
 * stored as the reversible string 'hex:<SQLite hex(), which is UPPERCASE>'.
 */
export function valueExpr(column, row = null) {
  const ref = colRef(column, row);
  return `CASE typeof(${ref}) WHEN 'blob' THEN 'hex:' || hex(${ref}) ELSE ${ref} END`;
}

/** A json_object(...) snapshot of the snapshotted columns of one row (NEW/OLD or bare). */
export function snapshotExpr(spec, row = null) {
  return `json_object(${spec.snapshot
    .map((c) => `${str(c)}, ${valueExpr(c, row)}`)
    .join(", ")})`;
}

/**
 * The item_versions.project_ref expression for one row: the first non-empty
 * project column, cast to TEXT, or NULL when the type has no project filing.
 */
export function projectRefExpr(spec, row = null) {
  const columns = spec.projectRef || [];
  if (!columns.length) return "NULL";
  const parts = columns.map((c) => `NULLIF(CAST(${colRef(c, row)} AS TEXT), '')`);
  return parts.length === 1 ? parts[0] : `COALESCE(${parts.join(", ")})`;
}

/* ------------------------------------------------------- append-only guards */

/**
 * The one-row arm switch for Task 4's erase. Deletes and non-attribution
 * updates of item_versions are refused unless a row with armed = 1 exists here;
 * Task 4 arms it INSIDE its own erase transaction and disarms it after.
 *
 * Task 4's redaction sweep arms the SAME switch: redaction rewrites
 * snapshot_json and sets redacted = 1, which is a history rewrite and must go
 * through the same audited door rather than look like an accident.
 *
 * PLAINLY: this is defence in depth against ACCIDENTS, not a security boundary.
 * Any process with a write handle on crow.db — the gateway's own user, a bot's
 * sqlite3 client, the operator — can arm this table, drop the triggers below, or
 * turn the guard off with a pragma. It stops a stray `DELETE FROM
 * item_versions`, a bot "cleaning up", and an UPDATE that rewrites history by
 * hand; it does not stop a determined local attacker. The real protections are
 * Task 4's erase API (audited, project-scoped) and file permissions on crow.db.
 */
export const ITEM_VERSIONS_ERASE_TABLE = "item_versions_erase";

export const ITEM_VERSIONS_ERASE_DDL = `
  CREATE TABLE IF NOT EXISTS ${ITEM_VERSIONS_ERASE_TABLE} (armed INTEGER);

  INSERT INTO ${ITEM_VERSIONS_ERASE_TABLE} (armed)
    SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM ${ITEM_VERSIONS_ERASE_TABLE});
`;

// True while Task 4's erase has the history table open for mutation.
const ARMED = `EXISTS (SELECT 1 FROM ${ITEM_VERSIONS_ERASE_TABLE} WHERE armed = 1)`;

// Everything an attribution stamp (Task 2) is NOT allowed to touch. `IS` is
// NULL-safe, so a NULL→NULL move is still "unchanged".
const ATTRIBUTION_COLUMNS = ["author_kind", "author_id", "job_id", "origin_instance"];

const IMMUTABLE_COMPARISONS = [
  "id",
  "item_type",
  "item_id",
  "op",
  "snapshot_json",
  "project_ref",
  "redacted",
  "created_at",
]
  .map((c) => `NEW."${c}" IS OLD."${c}"`)
  .join("\n      AND ");

/**
 * The two guard triggers that make item_versions append-only:
 *
 *   hist_item_versions_guard_au  BEFORE UPDATE — aborts unless (a) an armed
 *                                erase is in progress, or (b) this is a single
 *                                attribution stamp on a row that is still
 *                                'unattributed' (Task 2 sets author_kind/
 *                                author_id/job_id/origin_instance and nothing
 *                                else). Because (b) requires OLD.author_kind =
 *                                'unattributed', attribution can be stamped
 *                                exactly once per row.
 *   hist_item_versions_guard_ad  BEFORE DELETE — aborts unless armed.
 *
 * Name attribution here, not in the caller, so a Task 2 stamp and the guard can
 * never drift apart. `IF NOT EXISTS` makes these re-runnable.
 */
export function guardTriggerDefs() {
  return [
    {
      name: "hist_item_versions_guard_au",
      sql: `CREATE TRIGGER IF NOT EXISTS hist_item_versions_guard_au
BEFORE UPDATE ON item_versions
WHEN ${ARMED} = 0
 AND NOT (OLD.author_kind = 'unattributed'
      AND NEW.author_kind IN ('owner','bot','peer','system','unattributed')
      AND ${IMMUTABLE_COMPARISONS})
BEGIN
  SELECT RAISE(ABORT, 'version history is append-only');
END`,
    },
    {
      name: "hist_item_versions_guard_ad",
      sql: `CREATE TRIGGER IF NOT EXISTS hist_item_versions_guard_ad
BEFORE DELETE ON item_versions
WHEN ${ARMED} = 0
BEGIN
  SELECT RAISE(ABORT, 'version history is append-only');
END`,
    },
  ];
}

/** Just the guard trigger SQL, in creation order. */
export function guardTriggerSql() {
  return guardTriggerDefs().map((d) => d.sql);
}

/** The columns an attribution stamp may set (exported for Task 2 and the tests). */
export const ATTRIBUTION_FIELDS = Object.freeze([...ATTRIBUTION_COLUMNS]);

/**
 * The three capture triggers for one covered item type:
 *
 *   hist_<table>_ai  AFTER INSERT  → op 'insert', snapshot of NEW
 *   hist_<table>_au  AFTER UPDATE  → op 'update' of NEW, but ONLY when a tracked
 *                                     column actually changed (each compared with
 *                                     IS NOT, so a NULL↔value move counts and a
 *                                     recalled memory does not)
 *   hist_<table>_ad  AFTER DELETE  → op 'delete', snapshot of OLD (a delete
 *                                     keeps what it removed)
 *
 * Each statement is `IF NOT EXISTS`, so the migration and the boot re-ensure are
 * both re-runnable.
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
export function triggerDefs(itemType) {
  const spec = COVERED[itemType];
  if (!spec) throw new Error(`history: unknown item_type ${str(itemType)}`);

  const [ai, au, ad] = triggerNames(spec);
  const idOf = (row) => `CAST(${row}."${spec.idColumn}" AS TEXT)`;
  const insert = (row, op) =>
    `INSERT INTO item_versions (item_type, item_id, op, snapshot_json, project_ref)\n` +
    `    VALUES (${str(itemType)}, ${idOf(row)}, ${str(op)}, ${snapshotExpr(spec, row)}, ` +
    `${projectRefExpr(spec, row)});`;
  const changed = spec.tracked.map((c) => `NEW."${c}" IS NOT OLD."${c}"`).join(" OR ");

  return [
    {
      name: ai,
      sql: `CREATE TRIGGER IF NOT EXISTS ${ai} AFTER INSERT ON ${spec.table} BEGIN\n  ${insert("NEW", "insert")}\nEND`,
    },
    {
      name: au,
      sql:
        `CREATE TRIGGER IF NOT EXISTS ${au} AFTER UPDATE ON ${spec.table}\n` +
        `WHEN ${changed}\nBEGIN\n  ${insert("NEW", "update")}\nEND`,
    },
    {
      name: ad,
      sql: `CREATE TRIGGER IF NOT EXISTS ${ad} AFTER DELETE ON ${spec.table} BEGIN\n  ${insert("OLD", "delete")}\nEND`,
    },
  ];
}

/** The three capture trigger statements for one item type, in creation order. */
export function triggerSql(itemType) {
  return triggerDefs(itemType).map((d) => d.sql);
}