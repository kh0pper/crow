// scripts/migrations/0024-item-versions.mjs
//
// item_versions: the append-only record of every change to covered Crow content
// (the version history design). One row per version, holding the item's FULL
// value after the change, who made it and which job it belonged to. Filled by
// SQLite triggers on each covered table, so a write is recorded however it
// arrives — including a bot's own direct SQL connection, which is the case the
// feature exists for. The field lists, the trigger bodies and the append-only
// guards come from servers/shared/history/covered.js, so the two can never
// drift.
//
// LOCAL ONLY: item_versions is never added to instance-sync's SYNCED_TABLES. Each
// instance records the versions of every change it applies, including ones that
// arrive from a peer, so no new sync surface is created. What DOES cross is the
// fact of an ERASE: `item_erasures` (below) holds one permanent tombstone per
// erased item, and an erase event tells a peer to erase its copy and record the
// same tombstone (servers/shared/history/erase.js ERASURE_SYNC_TABLES). The
// tombstone table itself is not synced either — each instance keeps its own,
// and the event is what makes a pair agree.
//
// TWO MORE TABLES ride in this migration:
//   - `item_erasures` (the tombstones; never purged — forgetting one reopens the
//     door it exists to shut), and
//   - `pending_erasures` (a Maker Lab learner delete's durable "finish this"
//     marker: the cascade and the marker commit together, so a failure in the
//     following history erase leaves a marker a retry — with the profile row
//     already gone — or the 5-minute sweep can complete). The bundle creates the
//     same table itself (`CREATE TABLE IF NOT EXISTS`) so an install older than
//     this migration still works; both shapes are identical on purpose.
//
// Additive only, no SCHEMA_GENERATION bump (init-db.js is untouched): the
// registry is the rail for schema a running instance can pick up on boot.
//
// ATOMIC PER TABLE: for each covered table the triggers and the baseline are one
// BEGIN IMMEDIATE transaction (better-sqlite3 db.transaction(...).immediate()).
// It has to be one transaction because a write landing between "triggers exist"
// and "baseline written" would be captured by the trigger AND count as the
// item's only version, so the baseline guard would then skip it — leaving a row
// whose first real version is a later edit and whose original value is lost.
// One transaction means no other connection sees an intermediate state.
//
// The baseline is guarded PER ITEM, not per item type: a row that already has
// ANY version is left alone (it was captured live), every other row gets one
// 'insert' baseline authored by 'system'. That also makes a partially completed
// earlier run safe to repeat.
//
// Idempotent in its own right, because a database restored from backup can lose
// its schema_migrations row: the table, the indexes, the control table, the two
// tables added beside it (item_erasures, pending_erasures) and the triggers are
// all IF NOT EXISTS, and the baseline is per item, so a second run writes nothing.
//
// Tolerant of absent tables: memories / blog_posts / crow_context are created by
// init-db.js, but a store can be missing one (a partial restore, or a bare DB on
// a co-hosted instance that has not run init-db yet). An absent table — or a
// present one that is still missing a tracked or snapshotted column — is skipped
// with a logged reason, and the run DEFERS, so a later boot retries and picks up
// the triggers then. The table itself is always created: it holds no data of its
// own until a covered table is there to fill it.
//
// The triggers can disappear without this migration's record disappearing (an
// init-db rebuild of a covered table drops them). servers/shared/history/ensure.js
// re-creates them on every boot for exactly that reason; this file is the one
// that also writes baselines, and the boot re-ensure therefore only arms capture
// for a table this migration has already baselined.
//
// TODO(history-redaction, Task 4): text that matches the public-hygiene secret
// patterns is meant to be stored as "[redacted]" with redacted = 1. That cannot
// be done in a trigger (SQLite has no built-in regexp, and a registered SQL
// function would be missing on a raw sqlite3 connection, so the write would
// either fail or store the secret anyway). Task 4's sweep does it in JS over
// versions with redacted = 0; until then a secret written into a covered column
// is copied verbatim into item_versions.
import Database from "better-sqlite3";
import { performance } from "node:perf_hooks";
import {
  COVERED,
  ITEM_VERSIONS_ERASE_DDL,
  SECRET_COLUMN,
  guardTriggerSql,
  projectRefExpr,
  snapshotExpr,
  tableColumns,
  triggerSql,
} from "../../servers/shared/history/covered.js";
import { ITEM_ERASURES_DDL } from "../../servers/shared/history/erase.js";

export const id = "0024-item-versions";

/**
 * The Maker Lab learner-delete marker. A local table (never synced): it names a
 * learner whose cascade has committed but whose history erase has not finished,
 * with the memory ids read just before the cascade so the erase can be re-run
 * after the profile row is gone. Duplicated verbatim in
 * bundles/maker-lab/server/pending-erasures.js — the bundle must still work on an
 * install that has not run this migration.
 */
export const PENDING_ERASURES_DDL = `
  CREATE TABLE IF NOT EXISTS pending_erasures (
    learner_id INTEGER PRIMARY KEY,
    project_uuid TEXT,
    memory_ids_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );`;

// rollbackSafe: a new table, its indexes, guards and triggers on existing
// tables; older code neither reads nor writes any of them.
export const rollbackSafe = true;

// Whole content snapshots (they are small for text rows; diffs are computed at
// display time). `author_kind` is one of owner | bot | peer | system |
// unattributed — a write with no write context is 'unattributed', never 'owner'.
// author_id / job_id / origin_instance are stamped by the gateway after the
// trigger has inserted the row (Task 2), which is why they are nullable and
// `author_kind` defaults rather than being required.
//
// `project_ref` is the erase scope: the item's project at the time of the
// version (memories: project_uuid else project_id; crow_context: the uuid looked
// up from project_spaces else project_id; blog_posts: NULL — a post belongs to
// the instance, not a project). It is a copy, not a join, so a version stays
// findable by project after the project row or the item itself is gone. This is
// Task 4's index.
//
// A snapshot column that the covered table does NOT have is DERIVED: computed
// from the row when the version is written (crow_context.project_uuid, looked up
// from project_spaces). It is stored like any other value and restored by api.js
// as a filing, never written back into the row.
//
// The erase control table and the append-only guards are appended from
// covered.js: the guards must be installed with the table, not later.
export const ITEM_VERSIONS_DDL =
  `
  CREATE TABLE IF NOT EXISTS item_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_type TEXT NOT NULL,
    item_id TEXT NOT NULL,
    op TEXT NOT NULL CHECK(op IN ('insert','update','delete')),
    snapshot_json TEXT NOT NULL,
    project_ref TEXT,
    author_kind TEXT NOT NULL DEFAULT 'unattributed'
      CHECK(author_kind IN ('owner','bot','peer','system','unattributed')),
    author_id TEXT,
    job_id TEXT,
    origin_instance TEXT,
    redacted INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE INDEX IF NOT EXISTS idx_item_versions_item
    ON item_versions(item_type, item_id, id);
  CREATE INDEX IF NOT EXISTS idx_item_versions_job
    ON item_versions(job_id);
  CREATE INDEX IF NOT EXISTS idx_item_versions_project
    ON item_versions(project_ref);
` +
  ITEM_VERSIONS_ERASE_DDL +
  "\n" +
  guardTriggerSql().join(";\n") +
  ";\n";

/**
 * One `insert` baseline version per existing row of a covered table that has no
 * version yet, authored by the migration ('system'), so an upgraded instance has
 * a starting point for content that predates history.
 *
 * Guarded per ITEM (`v.item_id = CAST(t.<id> AS TEXT)`), not per item type: a row
 * already captured by a live trigger keeps its real versions instead of gaining a
 * second 'insert', and a partially completed earlier run fills only the gaps.
 * Every value goes through covered.js's BLOB-safe expression, and `project_ref`
 * is filled the same way the triggers fill it.
 */
export function baselineSql(itemType, spec) {
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

const tableExists = (db, table) =>
  Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));

const columnsOf = (db, table) =>
  new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));

export function run({ dbPath, log = () => {} }) {
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 10000");
  try {
    db.exec(ITEM_VERSIONS_DDL);
    // The tombstones an erase leaves behind (and the learner-delete marker the
    // Maker Lab bundle finishes from). Additive and IF NOT EXISTS, so a store
    // that already ran an earlier build of this migration picks them up here.
    db.exec(ITEM_ERASURES_DDL);
    db.exec(PENDING_ERASURES_DDL);
    log("  item_erasures + pending_erasures: ensured");

    // A dev instance that ran an earlier build of this same (unreleased)
    // migration already has the table without project_ref, and CREATE TABLE IF
    // NOT EXISTS will not add it. Cheap insurance so that never turns into a
    // trigger that cannot compile.
    if (tableExists(db, "item_versions") && !columnsOf(db, "item_versions").has("project_ref")) {
      db.exec("ALTER TABLE item_versions ADD COLUMN project_ref TEXT");
      db.exec("CREATE INDEX IF NOT EXISTS idx_item_versions_project ON item_versions(project_ref)");
      log("  item_versions: added project_ref (an earlier build predated it)");
    }
    log("  item_versions: ensured (table, 3 indexes, append-only guards, erase control)");

    const unready = [];
    for (const [itemType, spec] of Object.entries(COVERED)) {
      if (!tableExists(db, spec.table)) {
        unready.push(spec.table);
        log(`  ${spec.table}: absent — ${itemType} triggers skipped, will retry`);
        continue;
      }
      const columns = columnsOf(db, spec.table);
      // A trigger naming a column the table does not have fails to compile, so a
      // half-built table defers instead of breaking the boot. snapshot is a
      // superset of tracked (covered.js asserts it), so this covers both lists —
      // and a DERIVED snapshot column is computed, never selected, so it is not
      // one of them.
      const missingColumns = tableColumns(spec).filter((c) => !columns.has(c));
      if (missingColumns.length) {
        unready.push(spec.table);
        log(
          `  ${spec.table}: missing ${missingColumns.join(", ")} — ${itemType} triggers skipped, will retry`,
        );
        continue;
      }
      // A derived field reading another table (crow_context.project_uuid from
      // project_spaces) cannot be captured while that table is absent: the
      // trigger — and this baseline — would fail on every covered row.
      if (Object.keys(spec.derived || {}).length && !tableExists(db, "project_spaces")) {
        unready.push(spec.table);
        log(`  ${spec.table}: project_spaces absent — ${itemType} triggers skipped, will retry`);
        continue;
      }
      const secretColumns = [...spec.tracked, ...spec.snapshot].filter((c) => SECRET_COLUMN.test(c));
      if (secretColumns.length) {
        throw new Error(`history: ${spec.table} would version a credential column (${secretColumns.join(", ")})`);
      }

      // Triggers AND baseline in one BEGIN IMMEDIATE transaction: no other
      // connection can observe (or write through) the half-installed state.
      const install = db.transaction(() => {
        for (const sql of triggerSql(itemType)) db.exec(sql);
        const startedAt = performance.now();
        // The INSERT's own change count, not two COUNT(*) scans of a table that
        // grows with every write on the instance.
        const { changes } = db.prepare(baselineSql(itemType, spec)).run();
        return { added: Number(changes), ms: performance.now() - startedAt };
      });
      const { added, ms } = install.immediate();
      log(`  ${spec.table}: triggers ensured, ${added} baseline version(s) in ${ms.toFixed(1)} ms`);
    }

    if (unready.length) {
      return {
        deferred: true,
        reason: `covered tables not ready: ${unready.sort().join(", ")}`,
      };
    }
    return { applied: true };
  } finally {
    db.close();
  }
}