// scripts/migrations/0024-item-versions.mjs
//
// item_versions: the append-only record of every change to covered Crow content
// (the version history design). One row per version, holding the item's FULL
// value after the change, who made it and which job it belonged to. Filled by
// SQLite triggers on each covered table, so a write is recorded however it
// arrives — including a bot's own direct SQL connection, which is the case the
// feature exists for. The field lists and the trigger bodies come from
// servers/shared/history/covered.js, so the two can never drift.
//
// LOCAL ONLY: item_versions is never added to instance-sync's SYNCED_TABLES. Each
// instance records the versions of every change it applies, including ones that
// arrive from a peer, so no new sync surface is created.
//
// Additive only, no SCHEMA_GENERATION bump (init-db.js is untouched): the
// registry is the rail for schema a running instance can pick up on boot.
//
// Idempotent in its own right, because a database restored from backup can lose
// its schema_migrations row: the table, the indexes and the triggers are all
// IF NOT EXISTS, and the baseline is guarded per item type (see baselineSql), so
// a second run writes nothing.
//
// Tolerant of absent tables: memories / blog_posts / crow_context are created by
// init-db.js, but a store can be missing one (a partial restore, or a bare DB on
// a co-hosted instance that has not run init-db yet). An absent table — or a
// present one that is still missing a tracked column — is skipped with a logged
// reason, and the run DEFERS, so a later boot retries and picks up the triggers
// then. The table itself is always created: it holds no data of its own until a
// covered table is there to fill it.
//
// TODO(history-redaction, Task 4): text that matches the public-hygiene secret
// patterns is meant to be stored as "[redacted]" with redacted = 1. That cannot
// be done in a trigger (SQLite has no built-in regexp, and a registered SQL
// function would be missing on a raw sqlite3 connection, so the write would
// either fail or store the secret anyway). Task 4's sweep does it in JS over
// versions with redacted = 0; until then a secret written into a covered column
// is copied verbatim into item_versions.
import Database from "better-sqlite3";
import { COVERED, SECRET_COLUMN, triggerSql } from "../../servers/shared/history/covered.js";

export const id = "0024-item-versions";

// rollbackSafe: a new table, its indexes and triggers on existing tables;
// older code neither reads nor writes any of them.
export const rollbackSafe = true;

// Whole content snapshots (they are small for text rows; diffs are computed at
// display time). `author_kind` is one of owner | bot | peer | system |
// unattributed — a write with no write context is 'unattributed', never 'owner'.
// author_id / job_id / origin_instance are stamped by the gateway after the
// trigger has inserted the row (Task 2), which is why they are nullable and
// `author_kind` defaults rather than being required.
export const ITEM_VERSIONS_DDL = `
  CREATE TABLE IF NOT EXISTS item_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_type TEXT NOT NULL,
    item_id TEXT NOT NULL,
    op TEXT NOT NULL CHECK(op IN ('insert','update','delete')),
    snapshot_json TEXT NOT NULL,
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
`;

/**
 * One `insert` baseline version per existing row of a covered table, authored by
 * the migration ('system'), so an upgraded instance has a starting point for
 * content that predates history.
 *
 * Guarded per item type on purpose: the WHERE NOT EXISTS makes the whole
 * statement a no-op once that item type has ANY version, so re-running (or a
 * partially completed earlier run) never duplicates baselines. It is also why it
 * is one statement rather than a count comparison — SQLite runs it atomically.
 */
export function baselineSql(itemType, spec) {
  const quoted = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const snapshot = `json_object(${spec.tracked.map((c) => `${quoted(c)}, ${c}`).join(", ")})`;
  return `INSERT INTO item_versions (item_type, item_id, op, snapshot_json, author_kind)
    SELECT ${quoted(itemType)}, CAST(${spec.idColumn} AS TEXT), 'insert', ${snapshot}, 'system'
      FROM ${spec.table}
     WHERE NOT EXISTS (SELECT 1 FROM item_versions WHERE item_type = ${quoted(itemType)})
     ORDER BY ${spec.idColumn}`;
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
    log("  item_versions: ensured (table + 2 indexes)");

    const unready = [];
    for (const [itemType, spec] of Object.entries(COVERED)) {
      if (!tableExists(db, spec.table)) {
        unready.push(spec.table);
        log(`  ${spec.table}: absent — ${itemType} triggers skipped, will retry`);
        continue;
      }
      const columns = columnsOf(db, spec.table);
      // A trigger naming a column the table does not have fails to compile, so a
      // half-built table defers instead of breaking the boot.
      const missingColumns = [spec.idColumn, ...spec.tracked].filter((c) => !columns.has(c));
      if (missingColumns.length) {
        unready.push(spec.table);
        log(
          `  ${spec.table}: missing ${missingColumns.join(", ")} — ${itemType} triggers skipped, will retry`,
        );
        continue;
      }
      const secretTracked = spec.tracked.filter((c) => SECRET_COLUMN.test(c));
      if (secretTracked.length) {
        throw new Error(`history: ${spec.table} tracks a credential column (${secretTracked.join(", ")})`);
      }

      for (const sql of triggerSql(itemType)) db.exec(sql);
      const before = db.prepare("SELECT COUNT(*) AS n FROM item_versions").get().n;
      db.exec(baselineSql(itemType, spec));
      const added = db.prepare("SELECT COUNT(*) AS n FROM item_versions").get().n - before;
      log(`  ${spec.table}: triggers ensured${added > 0 ? `, ${added} baseline version(s)` : ""}`);
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