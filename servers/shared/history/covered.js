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
 * They differ on purpose. Some pointers (memories.instance_id, blog_posts.
 * published_at / nostr_event_id) are not changes worth a version on their own
 * but must be IN the snapshot so a redaction/erase knows what it is erasing and
 * a reader sees the row as it was. A memory's FILING is different: project_id /
 * project_uuid ARE tracked (a memory that moves between projects, or is unfiled
 * by a project delete, must show up in that project's history) — with one
 * exception, the sync layer's uuid stamp, see STAMP_ONLY_TRANSITIONS below.
 *
 * `projectRef` is the ordering used to fill item_versions.project_ref: the first
 * non-empty project column in the list, cast to TEXT. That column is the erase
 * scope — Task 4 finds an item's versions by project/learner without joining a
 * table that may have deleted the row.
 *
 * `derived` is for a snapshot field the covered TABLE DOES NOT HAVE, computed
 * from the row instead of read from it (crow_context's project_uuid — see the
 * entry below). A derived column is a snapshot field and a legal project_ref,
 * but never a tracked one, never a column a trigger or the WHOLE-row check
 * expects to exist in the table, and never something a restore writes back into
 * the row.
 *
 * `projected` is for a column that EXISTS but must never be stored verbatim: the
 * version keeps a PROJECTION of it (a bot definition's non-secret keys — see
 * bot_def below), and the update trigger compares the projection, so a change
 * only a credential can see writes no version. A projected column is always a
 * real column, is snapshotted, may be tracked, and is restored by a MERGE into
 * the live value (api.js RESTORE_PROJECTIONS), never by writing the projection
 * over it — that would blank the keys the snapshot deliberately omits.
 *
 * `store` says WHICH DATABASE the covered table lives in: `crow` (this
 * instance's crow.db) or `tasks` (the instance-global tasks.db — board cards).
 * SQLite triggers cannot write across databases, so tasks.db gets its OWN
 * item_versions (migration 0025) and every consumer asks `typesForStore` which
 * database a type's triggers belong to.
 *
 * `migration` names the one migration that installs a type's triggers and its
 * baseline. It is explicit rather than inferred so a new covered type cannot be
 * added without deciding which migration owns it; a test asserts every COVERED
 * type is claimed by exactly one migration (0024's own list never grows).
 *
 * Nothing else is special. Two rules the lists obey, both asserted at import
 * below and by tests/history-capture.test.js:
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
 *   - memories: the six content columns plus project_id / project_uuid. A filing
 *     change IS a change: a memory moved to another project (or unfiled when its
 *     project is deleted — servers/shared/project-lifecycle.js) writes an update
 *     version under the new project_ref, otherwise the old project's history
 *     would keep claiming it. The one exception is the sync layer stamping a
 *     portable uuid onto an already-filed row (STAMP_ONLY_TRANSITIONS). NOT
 *     instance_id (a placement pointer), and NOT access_count / accessed_at — a
 *     memory that is only *recalled* is not a change (review focus 1).
 *   - blog_posts: every content column (the plan's six plus the byline, the
 *     visibility and the cover image). NOT nostr_event_id (an id derived from
 *     publishing elsewhere), NOT published_at/created_at/updated_at.
 *   - crow_context: the section's key, title, body, its enabled toggle and its
 *     scope keys — a section's identity IS its scope, so device_id and
 *     project_id are tracked. NOT sort_order (an ordering counter),
 *     NOT updated_at, NOT lamport_ts, and NOT the derived project_uuid (it is a
 *     function of project_id, which is tracked).
 *
 * `snapshot` is the full row minus counters/derived/secret-named columns, so
 * memories carries its filing (project_id, project_uuid), blog_posts carries
 * published_at and nostr_event_id, and crow_context keeps its list.
 */

/** The instance's own database (init-db.js builds it; migrations 0024/0025 add history to it). */
export const STORE_CROW = "crow";

/** The instance-global tasks.db (board cards; migration 0025 adds history to it). */
export const STORE_TASKS = "tasks";

export const COVERED = Object.freeze({
  memory: Object.freeze({
    store: STORE_CROW,
    migration: "0024-item-versions",
    table: "memories",
    idColumn: "id",
    tracked: Object.freeze([
      "content",
      "context",
      "tags",
      "source",
      "category",
      "importance",
      "project_id",
      "project_uuid",
    ]),
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
    store: STORE_CROW,
    migration: "0024-item-versions",
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
    store: STORE_CROW,
    migration: "0024-item-versions",
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
      "project_uuid",
    ]),
    // crow_context has NO portable project id of its own: project_id is a
    // per-instance integer that project_spaces REUSES, so a snapshot carrying
    // only that id can be restored into a stranger's project that took the id
    // over — and instance-sync would then spread the mistake. The uuid is looked
    // up from project_spaces when the version is written (NULL when the section
    // is unfiled, or when its project row is already gone), so a version records
    // the project it really belonged to. api.js files a restored section by it.
    derived: Object.freeze({
      project_uuid: (row) => `(SELECT uuid FROM project_spaces WHERE id = ${colRef("project_id", row)})`,
    }),
    // Portable uuid first, local id second — the same ordering memories uses, and
    // the same reason (a version that outlives the project row must key on the
    // portable id).
    projectRef: Object.freeze(["project_uuid", "project_id"]),
    // This snapshot cannot be filed by a local project id at all. crow_context
    // gained project_uuid (a derived field) WITH the triggers and the baseline
    // that write it, so a section version without one predates them — and its
    // bare project_id names whatever project held that id THEN. ids are reused,
    // so trusting it could file a restored section into a stranger's project (the
    // exact failure the filing machinery exists to prevent), and sync would
    // spread it. Such a section is restored UNFILED and the caller is told
    // (`unfiled: true`), which is honest and recoverable.
    //
    // memories do NOT set this: project_id-only versions are a normal pre-uuid
    // shape there, and the live row's own project_uuid is a second opinion.
    filingRequiresUuid: true,
  }),
  research_note: Object.freeze({
    store: STORE_CROW,
    migration: "0025-item-versions-more",
    table: "research_notes",
    idColumn: "id",
    // The note's own content, its provenance (what a quote note claims and where
    // it was found) and its FILING: a note moved between projects, re-pointed at
    // another source, or withdrawn is a change worth a version. NOT uuid /
    // origin_instance_id / created_by (identity, origin and authorship pointers)
    // and NOT created_at / updated_at / withdrawn_at / lamport_ts (timestamps).
    tracked: Object.freeze([
      "title",
      "content",
      "note_type",
      "tags",
      "project_id",
      "source_id",
      "provenance",
      "quote_found",
      "locator",
      "withdrawn_by",
      "withdrawn_reason",
    ]),
    // The whole row minus the key and the clocks/pointers: uuid and
    // origin_instance_id ride along so a version says which note it was and where
    // it came from, exactly as a memory's filing does, and withdrawn_at is kept so
    // restoring a withdrawn note comes back as a live one.
    snapshot: Object.freeze([
      "project_id",
      "source_id",
      "title",
      "content",
      "note_type",
      "tags",
      "uuid",
      "origin_instance_id",
      "created_by",
      "provenance",
      "quote_found",
      "locator",
      "withdrawn_at",
      "withdrawn_by",
      "withdrawn_reason",
    ]),
    // research_notes.uuid is the NOTE's own identity (addUuidColumn), never the
    // project's, so the project ref is the local project id alone. A restored note
    // is therefore filed by resolveFiling's "keep the id only while that project
    // still exists" rule — the same one memories use when they carry no uuid.
    projectRef: Object.freeze(["project_id"]),
  }),
  kb_article: Object.freeze({
    store: STORE_CROW,
    migration: "0025-item-versions-more",
    table: "kb_articles",
    idColumn: "id",
    // The BUNDLE owns this table: it does not exist until the knowledge-base bundle
    // runs, so migration 0025 skips it with a reason and the bundle's own init
    // installs `triggerSql("kb_article")` right after creating it. An absent
    // kb_articles is therefore NORMAL (every instance without the bundle), not a
    // half-built store to retry or a line to log on every boot.
    bundleOwned: true,
    // The bundle owns this table, so 0025 skips it with a reason when it is
    // absent and bundles/knowledge-base/server/init-tables.js installs the
    // triggers itself once it has created them (see that file). Everything a
    // person writes is tracked: the pair/collection placement, the copy and the
    // publishing state. NOT created_at / updated_at, and NOT published_at /
    // last_verified_at (timestamps — snapshotted, never a change on their own).
    tracked: Object.freeze([
      "collection_id",
      "category_id",
      "pair_id",
      "language",
      "slug",
      "title",
      "content",
      "excerpt",
      "author",
      "status",
      "tags",
      "verified_by",
    ]),
    // The whole row minus id/created_at/updated_at. published_at and
    // last_verified_at stay IN the snapshot (a version must keep the publishing
    // facts, the way blog_posts does) without being changes of their own.
    snapshot: Object.freeze([
      "collection_id",
      "category_id",
      "pair_id",
      "language",
      "slug",
      "title",
      "content",
      "excerpt",
      "author",
      "status",
      "tags",
      "last_verified_at",
      "verified_by",
      "published_at",
    ]),
    // A KB article belongs to the instance (its collection), not to a project.
    projectRef: Object.freeze([]),
  }),
  bot_def: Object.freeze({
    store: STORE_CROW,
    migration: "0025-item-versions-more",
    table: "pi_bot_defs",
    idColumn: "bot_id",
    // Who the bot is, whether it is on, which project it works in, and its
    // DEFINITION (compared by projection — see `projected`).
    tracked: Object.freeze(["display_name", "definition", "enabled", "project_id"]),
    // pi_bot_defs carries no credential-named COLUMN at all: the credentials live
    // inside the `definition` JSON. So the row's other columns are snapshotted
    // whole, and `definition` is snapshotted as an allow-listed projection that
    // cannot carry one (BOT_DEFINITION_KEYS).
    snapshot: Object.freeze(["display_name", "definition", "enabled", "project_id"]),
    // The definition is stored as its non-secret projection, and COMPARED the
    // same way: a change only a token can see (an operator rotating a Discord
    // token) must not write a version, and a version must never hold the token.
    projected: Object.freeze({
      definition: definitionProjection,
    }),
    projectRef: Object.freeze(["project_id"]),
  }),
  card: Object.freeze({
    // Board cards live in the instance-global tasks.db, a SEPARATE database: its
    // triggers live there (migration 0025) and its versions are rows of
    // tasks.db's own item_versions. A caller holding crow.db's client must never
    // read or restore them.
    store: STORE_TASKS,
    migration: "0025-item-versions-more",
    table: "tasks_items",
    idColumn: "id",
    // The plan's "title, body and the plan fields" (the card model of migrations
    // 0000/0001/0003/0004): the text, where the card sits, who it is for and when
    // it is due, and the machine fields that decide what happens to it. NOT
    // updated_at / completed_at / created_at, NOT the scheduler's bookkeeping
    // (action_needed, next_followup_date, processing_lease*), and NOT
    // archived_at — an archived card STAYS archived, so a restore must not be
    // able to unarchive one (it is in neither list, so no restore names it).
    // `stage` is absent because the migrated shape does not have it: 0001 added it
    // and 0002's rebuild dropped it again.
    tracked: Object.freeze([
      "title",
      "description",
      "status",
      "priority",
      "due_date",
      "phase",
      "owner",
      "tags",
      "project_id",
      "parent_id",
      "board_id",
      "bot_id",
      "assigned_bot",
      "autonomy",
    ]),
    // data_json (a board's custom-field blob, whose shape each board defines) is
    // left OUT for the same fail-safe reason gateways and spawn_env are left out
    // of a bot definition: it is the one column that can hold whatever a board's
    // fields were defined to hold. The scheduler's bookkeeping, the terminal
    // timestamp, the recurrence pointer and archived_at are out for the reasons in
    // `tracked` above; `omitted` states that for the whole-row check in
    // tests/history-capture.test.js, so a NEW column cannot be left out by
    // accident.
    omitted: Object.freeze([
      "data_json",
      "completed_at",
      "archived_at",
      "recurrence_id",
      "action_needed",
      "next_followup_date",
      "processing_lease",
      "processing_lease_status",
    ]),
    snapshot: Object.freeze([
      "title",
      "description",
      "status",
      "priority",
      "due_date",
      "phase",
      "owner",
      "tags",
      "project_id",
      "parent_id",
      "board_id",
      "bot_id",
      "assigned_bot",
      "autonomy",
    ]),
    // A card has no portable project key, and tasks.db has no project_spaces
    // table to resolve one against, so it declares no project scope. Restoring a
    // card keeps the project it is in NOW (api.js KEEP_CURRENT): moving a card
    // between projects is a change worth a version, but not something a restore
    // replays.
    projectRef: Object.freeze([]),
  }),
});

/* ------------------------------------------- erase by project (Task 4) */

/**
 * TODO(history-erase, Task 4): erase-by-project is a CLOSURE over the item, not a
 * row delete. Two consequences, both load-bearing:
 *
 *   1. Take every version of every item_id that has ANY version with that
 *      project_ref — not just the versions whose own project_ref matches. A
 *      memory that moved from project A to project B has versions under both,
 *      and erasing A must not leave half of that item's history behind (nor may
 *      A's erase reach into B's live memory: the closure is over VERSIONS, and
 *      the versions it takes go with the project).
 *   2. Match BOTH keys. project_ref holds the portable uuid when the row had one
 *      and the local project id (cast to TEXT) otherwise, because pre-project_uuid
 *      rows and project_id-only writes carry no uuid. (A context section's uuid is
 *      looked up from project_spaces at capture time, so it is held the same way.)
 *      So the predicate is
 *      `project_ref IN (<project uuid>, CAST(<local project id> AS TEXT))`, and
 *      both values must be bound as TEXT (a bare integer never equals the
 *      stored text).
 *
 * Both are queries against idx_item_versions_project: the closure is one lookup
 * for the item_id set plus one indexed pass over (item_type, item_id).
 */

/* ------------------------------------------------- the sync layer's stamp */

/**
 * A tracked column can move without the content changing: the sync layer STAMPS a
 * portable pointer onto a row that is already filed. memories.project_uuid is the
 * one case (mapInboundMemoryProject / a summary memory whose uuid arrives later):
 * project_uuid goes NULL → uuid while project_id stays exactly what it was.
 *
 * Checked against instance-sync: a regular memory never carries project_uuid on
 * the wire (OUTBOUND_TRANSFORMS drops a null one and only a summary memory has a
 * uuid), so this does NOT fire for every memory on sync. It does fire for that
 * summary-memory case, and a version there would say "this memory moved" when
 * nothing moved — the filing is the same project, only its portable id is now
 * known. So the transition is excluded from the WHEN clause on its own: it counts
 * only while project_id is unchanged.
 *
 * Anything else still counts. A content edit in the same statement as the stamp
 * writes a version (the other terms of the WHEN are unaffected), a real filing
 * change moves project_id and so is recorded, and unfiling (uuid → NULL, from a
 * project delete) is a change, not a stamp.
 *
 * `column` is the tracked column being stamped; `unchanged` are the tracked
 * columns that must compare equal (NULL-safe IS) for it to count as a stamp.
 */
export const STAMP_ONLY_TRANSITIONS = Object.freeze({
  memory: Object.freeze({
    column: "project_uuid",
    unchanged: Object.freeze(["project_id"]),
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
  // A derived field is computed for every version, so it must be in the
  // snapshot; and it is not a real column, so it cannot be tracked (there is no
  // OLD/NEW value to compare).
  for (const column of Object.keys(spec.derived || {})) {
    if (!spec.snapshot.includes(column)) {
      throw new Error(`history: ${itemType}.${column} is derived but not snapshotted`);
    }
    if (spec.tracked.includes(column)) {
      throw new Error(`history: ${itemType}.${column} is derived, so it cannot be tracked`);
    }
  }
  // A stamp exclusion names columns the WHEN clause already compares; if either
  // list changed underneath it, the exclusion would silently stop matching.
  const stamp = STAMP_ONLY_TRANSITIONS[itemType];
  if (stamp) {
    if (!spec.tracked.includes(stamp.column)) {
      throw new Error(`history: ${itemType}.${stamp.column} is a stamp-only column but is not tracked`);
    }
    for (const column of stamp.unchanged) {
      if (!spec.tracked.includes(column)) {
        throw new Error(`history: ${itemType}.${column} guards a stamp but is not tracked`);
      }
    }
  }
  // A PROJECTED column is a real column stored through a projection, so it must
  // be in the snapshot (that projection IS what a version keeps) and it may be
  // tracked (the trigger compares two projections). It cannot also be derived:
  // a derived field is not a column at all.
  for (const column of Object.keys(spec.projected || {})) {
    if (!spec.snapshot.includes(column)) {
      throw new Error(`history: ${itemType}.${column} is projected but not snapshotted`);
    }
    if (spec.derived && spec.derived[column]) {
      throw new Error(`history: ${itemType}.${column} is both projected and derived`);
    }
  }
  // The whole point of a projection list is that a credential key cannot reach
  // the version table: every projected KEY is checked against SECRET_COLUMN in
  // the projection's own definition below (BOT_DEFINITION_KEYS).
  if (spec.snapshot.includes(spec.idColumn)) {
    throw new Error(`history: ${itemType}.${spec.idColumn} is the item key, never a snapshot field`);
  }
  if (!Object.values([STORE_CROW, STORE_TASKS]).includes(spec.store)) {
    throw new Error(`history: ${itemType}.store must be ${STORE_CROW} or ${STORE_TASKS}`);
  }
  if (typeof spec.migration !== "string" || spec.migration === "") {
    throw new Error(`history: ${itemType} must name the migration that installs its triggers`);
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

/* ------------------------------------ the bot definition's safe projection */

/**
 * The pi_bot_defs.definition keys a version MAY keep.
 *
 * An ALLOW-list, deliberately: the definition is one JSON blob and a new
 * credential-bearing key can appear in it without any change here (a new gateway
 * type, an operator pasting a key into an advanced field). An allow-list fails
 * SAFE when that happens — the new key is simply not versioned — where a
 * deny-list (json_remove of the keys we know today) would start copying the new
 * secret into item_versions the day it appears. Every key below is content the
 * Bot Builder edits; nothing below can authenticate anything.
 *
 * What is NOT here, and why (each one read from the code that writes it):
 *   gateways            scripts/pi-bots/gateways/index.mjs:87 (discord `token`),
 *                       gateways/telegram.mjs:38 (`token`),
 *                       gateways/slack.mjs:37-38 (`bot_token`, `app_token`) — and
 *                       the editor's own secret set in
 *                       servers/gateway/bot-federation.js:19 adds `password` and
 *                       `secret`, so the whole subtree is out.
 *   spawn_env           an env blob: servers/gateway/dashboard/panels/bot-builder/
 *                       data-queries.js:374 writes it, and
 *                       servers/gateway/bot-federation.js:23 redacts any key
 *                       matching /(TOKEN|KEY|SECRET|PASSWORD|CRED)/i because such
 *                       keys DO occur there. A blob with arbitrary keys cannot be
 *                       allow-listed per key, so it is out.
 *   session_dir         a placement pointer (where the bot works), not content.
 *
 * The projection is also what the update trigger COMPARES, so rotating a token
 * (or setting an env key) writes no version at all: the definition a version
 * describes did not change.
 */
export const BOT_DEFINITION_KEYS = Object.freeze([
  "engine",
  "models",
  "fast_voice_model",
  "tools",
  "skills",
  "permission_policy",
  "triggers",
  "tracker_config",
  "system_prompt",
  "description",
  "persona",
  "companion_features",
]);

for (const key of BOT_DEFINITION_KEYS) {
  if (SECRET_COLUMN.test(key)) {
    throw new Error(`history: bot_def.definition key ${key} looks like a credential and must never be versioned`);
  }
}

/**
 * The allow-listed projection of one pi_bot_defs row's `definition`, as a SQL
 * expression: a json_object of exactly BOT_DEFINITION_KEYS, or NULL when the
 * column does not hold a JSON document.
 *
 * The json_valid/typeof guard is load-bearing: json_extract raises "malformed
 * JSON" on a broken document, and a trigger that raised would fail the bot's own
 * write (the capture trigger runs INSIDE it). A corrupt definition is therefore
 * versioned as NULL — visible as "the definition changed" with nothing to show,
 * which is the honest reading — instead of breaking the write.
 */
function definitionProjection(row) {
  const ref = colRef("definition", row);
  const pairs = BOT_DEFINITION_KEYS.map((key) => `${str(key)}, json_extract(${ref}, '$.${key}')`).join(", ");
  return `(CASE WHEN typeof(${ref}) = 'text' AND json_valid(${ref}) THEN json_object(${pairs}) ELSE NULL END)`;
}

/** SQL expression for one column's value: its projection, its derived lookup, or itself. */
function columnSource(spec, column, row = null) {
  const projected = spec.projected && spec.projected[column];
  if (projected) return projected(row);
  const derived = spec.derived && spec.derived[column];
  if (derived) return derived(row);
  return colRef(column, row);
}

/** True when a snapshot column is computed (projected or derived), never read raw. */
export function isComputed(spec, column) {
  return Boolean((spec.projected && spec.projected[column]) || (spec.derived && spec.derived[column]));
}

/**
 * The columns of `spec` a covered TABLE must actually have: its key plus every
 * snapshotted column that is not derived (a derived one is computed, never
 * selected). Used by the migration and the boot re-ensure to decide whether a
 * table is ready for its triggers, and by the History API to decide what to
 * read and what to write.
 *
 * A PROJECTED column is a real column of the table, so it stays in this list: the
 * trigger reads it (through the projection), and a restore writes the merged
 * value back into it.
 */
export function tableColumns(spec) {
  return [spec.idColumn, ...spec.snapshot].filter((column) => !(spec.derived && spec.derived[column]));
}

/**
 * One stored value, BLOB-safe and TEXT-safe, from any SQL expression.
 *
 * json_object() raises "JSON cannot hold BLOB values" for a blob, and SQLite
 * does not enforce declared column types — a `content` column can hold one. A
 * raw bot write carrying a blob must not fail its own INSERT (the trigger runs
 * inside the write) and must not fail the migration's baseline, so a blob is
 * stored as the reversible string 'hex:<SQLite hex(), which is UPPERCASE>'.
 *
 * TEXT needs the matching escape, and it must be SYMMETRIC with the reader. A
 * text value may legitimately START with "hex:" (a memory whose content is
 * "hex:DEADBEEF", a hash written into a section) and read back that is
 * indistinguishable from a stored blob; it may equally start with "txt:" (the
 * escape itself, or a piece of text that simply says so) and read back the
 * reader would strip a prefix that was never added. So a text value starting
 * with EITHER marker is stored as 'txt:<the value>', and api.js's decodeValue
 * strips exactly one 'txt:' prefix again. Every other text value is stored
 * verbatim, so the transpose is exact: after one 'txt:' strip, 'hex:' means
 * bytes, 'txt:' means text, anything else is itself.
 *
 * Rows written BEFORE this escape existed carry no marker, so a text value that
 * looked exactly like a blob in one of them is still read back as bytes. That
 * ambiguity cannot be resolved after the fact and is accepted; it affects only
 * snapshots taken before the escape (and the triggers of an already-migrated
 * store keep their old body until they are re-created, which is the same set of
 * rows).
 */
function storeValue(expr) {
  return (
    `CASE typeof(${expr}) ` +
    `WHEN 'blob' THEN 'hex:' || hex(${expr}) ` +
    `WHEN 'text' THEN (CASE WHEN substr(${expr}, 1, 4) IN ('hex:', 'txt:') ` +
    `THEN 'txt:' || ${expr} ELSE ${expr} END) ` +
    `ELSE ${expr} END`
  );
}

/** One column's stored value (see storeValue). */
export function valueExpr(column, row = null) {
  return storeValue(colRef(column, row));
}

/**
 * One snapshot column's stored value: a real column read from the row, a
 * PROJECTED column's projection of it (bot_def.definition — never the raw JSON),
 * or a derived field computed from it (crow_context.project_uuid).
 */
export function columnValueExpr(spec, column, row = null) {
  return storeValue(columnSource(spec, column, row));
}

/**
 * The update trigger's comparison for one tracked column: the plain column for an
 * ordinary one, or the PROJECTION on both sides for a projected one (so a token
 * rotation, which the projection cannot see, is not a version).
 */
export function compareExpr(spec, column) {
  if (!(spec.projected && spec.projected[column])) return `NEW."${column}" IS NOT OLD."${column}"`;
  return `(${columnValueExpr(spec, column, "NEW")}) IS NOT (${columnValueExpr(spec, column, "OLD")})`;
}

/** A json_object(...) snapshot of the snapshotted columns of one row (NEW/OLD or bare). */
export function snapshotExpr(spec, row = null) {
  return `json_object(${spec.snapshot
    .map((c) => `${str(c)}, ${columnValueExpr(spec, c, row)}`)
    .join(", ")})`;
}

/**
 * The item_versions.project_ref expression for one row: the first non-empty
 * project key (a real column, or a derived lookup such as crow_context's uuid),
 * cast to TEXT, or NULL when the type has no project filing.
 */
export function projectRefExpr(spec, row = null) {
  const columns = spec.projectRef || [];
  if (!columns.length) return "NULL";
  const parts = columns.map((c) => {
    return `NULLIF(CAST(${columnSource(spec, c, row)} AS TEXT), '')`;
  });
  return parts.length === 1 ? parts[0] : `COALESCE(${parts.join(", ")})`;
}

/* ------------------------------------------ which migration, which database */

/** The item types one migration installs triggers and baselines for, in COVERED order. */
export function typesForMigration(migrationId) {
  return Object.entries(COVERED)
    .filter(([, spec]) => spec.migration === migrationId)
    .map(([itemType]) => itemType);
}

/** The item types whose covered table lives in one store (`crow` or `tasks`). */
export function typesForStore(store) {
  return Object.entries(COVERED)
    .filter(([, spec]) => spec.store === store)
    .map(([itemType]) => itemType);
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

/**
 * The Trash listing's index: a delete IS the Trash entry (trash.js), so the listing
 * is "every delete, per item, that has no newer version" — exactly the rows a
 * partial index on (item_type, item_id, id) WHERE op = 'delete' holds. Defined here,
 * beside the table's other DDL, so migration 0024 and the boot ensure share one
 * definition: a store that already recorded an earlier build of 0024 never runs it
 * again and would otherwise keep the full-table plan.
 */
export const ITEM_VERSIONS_TRASH_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_item_versions_deletes
    ON item_versions(item_type, item_id, id) WHERE op = 'delete';`;

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
 * The three guard triggers that make item_versions append-only:
 *
 *   hist_item_versions_guard_bi  BEFORE INSERT — aborts an insert that names an
 *                                id which already exists, unless armed. NEW.id
 *                                is NULL for the capture triggers and for the
 *                                baseline (AUTOINCREMENT assigns it), so this
 *                                only ever stops an explicit
 *                                `INSERT OR REPLACE INTO item_versions (id, …)`
 *                                — SQLite's REPLACE deletes the conflicting row
 *                                and inserts a new one, which would otherwise
 *                                rewrite history without the UPDATE guard ever
 *                                seeing it.
 *   hist_item_versions_guard_au  BEFORE UPDATE — aborts unless (a) an armed
 *                                erase is in progress, or (b) this is a single
 *                                attribution stamp on a row that is still
 *                                'unattributed' and carries no attribution yet:
 *                                NEW.author_kind must name a REAL author (not
 *                                'unattributed' again) and OLD.author_id /
 *                                OLD.job_id / OLD.origin_instance must all be
 *                                NULL, so attribution happens exactly once and
 *                                cannot be "re-stamped" into a different (or no)
 *                                author.
 *   hist_item_versions_guard_ad  BEFORE DELETE — aborts unless armed.
 *
 * Name attribution here, not in the caller, so a Task 2 stamp and the guard can
 * never drift apart. `IF NOT EXISTS` makes these re-runnable.
 */
export function guardTriggerDefs() {
  return [
    {
      name: "hist_item_versions_guard_bi",
      sql: `CREATE TRIGGER IF NOT EXISTS hist_item_versions_guard_bi
BEFORE INSERT ON item_versions
WHEN NEW."id" IS NOT NULL
 AND ${ARMED} = 0
 AND EXISTS (SELECT 1 FROM item_versions WHERE "id" = NEW."id")
BEGIN
  SELECT RAISE(ABORT, 'version history is append-only (an existing version cannot be replaced)');
END`,
    },
    {
      name: "hist_item_versions_guard_au",
      sql: `CREATE TRIGGER IF NOT EXISTS hist_item_versions_guard_au
BEFORE UPDATE ON item_versions
WHEN ${ARMED} = 0
 AND NOT (OLD.author_kind = 'unattributed'
      AND NEW.author_kind <> 'unattributed'
      AND OLD.author_id IS NULL
      AND OLD.job_id IS NULL
      AND OLD.origin_instance IS NULL
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
 *                                     IS NOT, so a NULL→value move counts and a
 *                                     recalled memory does not — except a
 *                                     stamp-only transition, see
 *                                     STAMP_ONLY_TRANSITIONS)
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
  // A stamp-only transition is excluded TERM BY TERM, not from the whole WHEN:
  // a statement that both stamps the pointer and edits the content must still
  // write a version (for the edit), and only the stamp's own term goes quiet.
  const stamp = STAMP_ONLY_TRANSITIONS[itemType];
  const changeExpr = spec.tracked
    .map((c) => {
      const cmp = compareExpr(spec, c);
      if (!stamp || stamp.column !== c) return cmp;
      const unchanged = stamp.unchanged.map((u) => `NEW."${u}" IS OLD."${u}"`).join(" AND ");
      return `(${cmp}\n        AND NOT (OLD."${c}" IS NULL AND NEW."${c}" IS NOT NULL AND ${unchanged}))`;
    })
    .join(" OR ");

  return [
    {
      name: ai,
      sql: `CREATE TRIGGER IF NOT EXISTS ${ai} AFTER INSERT ON ${spec.table} BEGIN\n  ${insert("NEW", "insert")}\nEND`,
    },
    {
      name: au,
      sql:
        `CREATE TRIGGER IF NOT EXISTS ${au} AFTER UPDATE ON ${spec.table}\n` +
        `WHEN ${changeExpr}\nBEGIN\n  ${insert("NEW", "update")}\nEND`,
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

/* ------------------------------------------------------------- the baseline */

/**
 * One `insert` baseline version per existing row of a covered table that has no
 * version yet, authored by whoever installs the triggers ('system'), so an
 * instance that gains history has a starting point for content that predates it.
 *
 * Guarded per ITEM (`v.item_id = CAST(t.<id> AS TEXT)`), not per item type: a row
 * already captured by a live trigger keeps its real versions instead of gaining a
 * second 'insert', and a partially completed earlier run fills only the gaps.
 * Every value goes through valueExpr's BLOB-safe expression, and `project_ref` is
 * filled the same way the triggers fill it.
 *
 * IT LIVES HERE, BESIDE THE TRIGGER SQL, because a second installer needs it too:
 * kb_articles is a BUNDLE-owned table, so migration 0025 skips it and
 * bundles/knowledge-base/server/init-tables.js installs its triggers — and it must
 * baseline whatever rows that table already holds BEFORE those triggers exist, or
 * their pre-history is lost for good (the per-item guard would then skip them
 * forever). 0024 re-exports this function, so the migration and the bundle cannot
 * drift into two baseline shapes.
 *
 * @param {string} itemType a COVERED item type
 * @param {object} [spec] its COVERED spec (defaults to COVERED[itemType])
 * @returns {string} the INSERT statement, runnable inside the installer's transaction
 */
export function baselineSql(itemType, spec = COVERED[itemType]) {
  if (!spec) throw new Error(`history: unknown item_type ${str(itemType)}`);
  const quoted = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const idOf = `CAST(t."${spec.idColumn}" AS TEXT)`;
  return `INSERT INTO item_versions (item_type, item_id, op, snapshot_json, project_ref, author_kind)
    SELECT ${quoted(itemType)}, ${idOf}, 'insert', ${snapshotExpr(spec, "t")},
           ${projectRefExpr(spec, "t")}, 'system'
      FROM ${spec.table} t
     WHERE NOT EXISTS (
       SELECT 1 FROM item_versions v
        WHERE v.item_type = ${quoted(itemType)}
          AND v.item_id = ${idOf})
     ORDER BY t."${spec.idColumn}"`;
}