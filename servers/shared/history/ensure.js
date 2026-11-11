/**
 * ensure.js — put the version-history triggers back if something dropped them.
 *
 * The capture triggers live on tables init-db.js owns, and init-db rebuilds a
 * table by creating `<table>_new`, copying, dropping the original and renaming
 * (`crow_context` is rebuilt that way for its partial unique indexes). A DROP
 * TABLE drops its triggers with it — while migration 0024's row in
 * schema_migrations stays recorded, so the registry never runs it again. The
 * same is true of a table restored from a backup taken before the triggers, and
 * of an operator who edited triggers by hand.
 *
 * So every boot re-ensures them: for each covered table that exists AND still has
 * every column a trigger names, create any missing capture trigger (and, first,
 * the append-only guard triggers and their erase control table). CREATE TRIGGER
 * IF NOT EXISTS makes this a cheap read plus a no-op on a healthy store, and it
 * cannot overwrite a trigger that is already there.
 *
 * CAPTURE WAITS FOR ITS BASELINE. A capture trigger is only installed for a table
 * the migration has already BASELINED — 0024 is recorded as applied in
 * schema_migrations, or at least one 'system' version of that item_type exists.
 * Otherwise a table that appeared (or was rebuilt) between boots would start
 * recording versions of rows whose pre-history was never stored, and the
 * migration's per-item baseline guard would then skip those rows forever: their
 * original value would be lost while the store looks fully captured. Before the
 * baseline, capture is the migration's job (it installs the triggers and writes
 * the baselines in one transaction) — so this function leaves the table alone.
 * The GUARD triggers carry no such dependency (they sit on item_versions itself)
 * and are always ensured.
 *
 * Deliberately NO baselines here: a dropped trigger means writes went
 * unrecorded, and only the migration (which can defer) decides what a baseline
 * is. This function's job is "writes are captured again from now on".
 *
 * Also re-creates the append-only guards, because they sit on item_versions
 * itself, which nothing else rebuilds. And it DISARMS a stuck erase switch: Task
 * 4 arms item_versions_erase inside its erase transaction and disarms it before
 * committing, so a row still armed at boot means that transaction never
 * committed — leaving the switch on would silently permit history rewrites for
 * the life of the process.
 *
 * ONE DATABASE PER CALL. `store` names which database this handle is (default
 * `crow`), and only that store's covered types are looked at: a card's table
 * lives in the instance-global tasks.db, whose own item_versions and triggers are
 * migration 0025's to install (a SQLite trigger cannot write across databases).
 * The BOOT entry point below therefore runs this twice — once against crow.db,
 * once against tasks.db (when that file exists), including the disarm of a stuck
 * item_versions_erase on each — because one call can only see one file. The
 * "has the migration applied" question is answered from crow.db's
 * schema_migrations in both cases: the registry keeps ONE book for the instance.
 */
import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { resolveDbPath } from "../../db.js";
import { tasksDbPath as defaultTasksDbPath } from "../../../scripts/pi-bots/instance-paths.mjs";
import {
  COVERED,
  ITEM_VERSIONS_ERASE_DDL,
  ITEM_VERSIONS_TRASH_INDEX_SQL,
  STORE_CROW,
  STORE_TASKS,
  guardTriggerDefs,
  tableColumns,
  triggerDefs,
} from "./covered.js";
import { ITEM_ERASURES_DDL, PENDING_ERASURES_DDL, PENDING_REMOTE_ERASURES_DDL } from "./erase.js";

const tableExists = (db, table) =>
  Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));

const indexExists = (db, index) =>
  Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(index));

const columnsOf = (db, table) =>
  new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));

const triggerNamesIn = (db) =>
  new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all().map((r) => r.name));

/** The migration that owns capture triggers and baselines for crow.db's first three types. */
export const BASELINE_MIGRATION_ID = "0024-item-versions";

/** Has the migration registry recorded `migrationId` in this store? (No registry table = no.) */
const migrationRecorded = (db, migrationId = BASELINE_MIGRATION_ID) => {
  try {
    return Boolean(
      db.prepare("SELECT 1 FROM schema_migrations WHERE id = ?").get(migrationId),
    );
  } catch {
    return false;
  }
};

/**
 * The migration ids recorded as applied in ONE store's `schema_migrations` (an
 * empty set when the table is absent).
 *
 * The registry keeps its bookkeeping in crow.db even for a migration that writes
 * to tasks.db (scripts/migrations/runner.mjs: one `book` handle, the instance's
 * dbPath), so tasks.db has NO schema_migrations of its own and must be told what
 * has already run — see ensureHistoryTriggers's `baselineRecorded`.
 */
export function recordedMigrations(db) {
  try {
    return new Set(db.prepare("SELECT id FROM schema_migrations").all().map((row) => String(row.id)));
  } catch {
    return new Set();
  }
}

/**
 * Does this item type have a baseline yet? Either the migration that owns the
 * type (spec.migration — 0024 for memories/posts/sections, 0025 for the rest) is
 * recorded as applied, or a 'system' version (the baseline's author) of that item
 * type is present — which covers a store restored from a backup that lost its
 * schema_migrations row.
 *
 * Per TYPE, not per store: a store that has run 0024 but where 0025 deferred has
 * captured memories and no baselined notes, and arming the notes' capture before
 * their baseline is exactly the loss this check exists to prevent.
 */
const hasBaseline = (db, itemType, recorded) =>
  recorded ||
  Boolean(
    db
      .prepare("SELECT 1 FROM item_versions WHERE item_type = ? AND author_kind = 'system' LIMIT 1")
      .get(itemType),
  );

/**
 * Re-create every missing history trigger on one open crow.db.
 *
 * Also ensures the tombstone table (item_erasures), the two local bookkeeping tables
 * beside it, the Trash listing's partial index, and disarms a stuck erase switch;
 * none of those is a trigger, so none appears in `restored`.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{store?: string, baselineRecorded?: (migrationId: string) => boolean}} [opts]
 *   `store` names which store this handle IS (default `crow`): a crow.db handle must
 *   never look for tasks.db's table, and a type whose covered table lives in another
 *   store is left to that store's own ensure (migration 0025 installs the card
 *   triggers in tasks.db). `baselineRecorded` answers "has this migration been
 *   recorded as applied" for the store being ensured; it defaults to THIS handle's
 *   own schema_migrations — which is right for crow.db and wrong for tasks.db, whose
 *   registry rows live in crow.db (so the boot caller passes the crow.db set there).
 * @returns {{restored: string[], skipped: string[], awaitingBaseline: string[],
 *   disarmed: number}} `restored` is the trigger names this call created (empty on
 *   a healthy store); `skipped` is the covered tables left alone because they are
 *   absent or still missing a column a trigger names (the migration will install
 *   theirs once the table is whole); `awaitingBaseline` is the ready tables whose
 *   capture is left to the migration because no baseline exists yet; `disarmed` is
 *   the number of erase-switch rows reset to 0.
 */
export function ensureHistoryTriggers(db, { store = STORE_CROW, baselineRecorded = null } = {}) {
  const skipped = [];
  const awaitingBaseline = [];
  // Nothing to guard or capture yet: migration 0024 owns creation, and a store
  // without item_versions has never run it.
  if (!tableExists(db, "item_versions")) {
    return { restored: [], skipped: ["item_versions absent"], awaitingBaseline, disarmed: 0 };
  }
  if (!columnsOf(db, "item_versions").has("project_ref")) {
    // An item_versions from an earlier build of the migration: its triggers
    // would name a column that is not there. Let 0024 re-run instead.
    return {
      restored: [],
      skipped: ["item_versions.project_ref absent"],
      awaitingBaseline,
      disarmed: 0,
    };
  }

  // The guard triggers read the erase control table, so it must exist whether or
  // not a trigger is missing (it can be lost the same way they can). Idempotent:
  // IF NOT EXISTS plus a seed that writes only when the table is empty.
  const needsControlTable =
    !tableExists(db, "item_versions_erase") ||
    db.prepare("SELECT COUNT(*) AS n FROM item_versions_erase").get().n === 0;
  if (needsControlTable) db.exec(ITEM_VERSIONS_ERASE_DDL);

  // The TOMBSTONES (migration 0024). Also ensured here, for the same reason: a
  // store that already recorded 0024 from an earlier build of this unreleased
  // migration never runs it again, and an erase must be able to write its
  // tombstone — the row that stops a peer re-creating what was erased. Never
  // purged, so there is nothing else to do with it. It is not a trigger, so it
  // does not join `restored`.
  if (!tableExists(db, "item_erasures")) db.exec(ITEM_ERASURES_DDL);
  // `erase_lamport` (the erase event's lamport, i.e. the bound below which a peer's
  // write is the erased item coming back) arrived with a later build of the same
  // unreleased migration: a dev store that already ran 0024 has the table without
  // it, and CREATE TABLE IF NOT EXISTS would never add the column.
  else if (!columnsOf(db, "item_erasures").has("erase_lamport")) {
    db.exec("ALTER TABLE item_erasures ADD COLUMN erase_lamport INTEGER");
  }
  // The Maker Lab learner-delete marker and the "finish this inbound erase" work
  // queue. Both are local bookkeeping tables beside the tombstones, ensured here
  // for the same reason (a store that recorded an earlier build of 0024 never runs
  // it again), and both IF NOT EXISTS.
  if (!tableExists(db, "pending_erasures")) db.exec(PENDING_ERASURES_DDL);
  if (!tableExists(db, "pending_remote_erasures")) db.exec(PENDING_REMOTE_ERASURES_DDL);

  // The Trash listing's partial index (the same unreleased 0024 revision as the two
  // tables above): the listing is planned onto it, so a dev store that recorded an
  // earlier build of the migration must pick it up here rather than keep a
  // full-table plan forever. IF NOT EXISTS, so a healthy store is a no-op.
  if (!indexExists(db, "idx_item_versions_deletes")) db.exec(ITEM_VERSIONS_TRASH_INDEX_SQL);

  // A switch still armed at boot belongs to an erase transaction that never
  // committed; leaving it on would let anything rewrite history without the
  // audited door. Reset it before anything can write.
  const disarmed = db.prepare("UPDATE item_versions_erase SET armed = 0 WHERE armed <> 0").run().changes;

  const wanted = [...guardTriggerDefs()];
  for (const [itemType, spec] of Object.entries(COVERED)) {
    // This handle is ONE database. A type whose table lives in the other store is
    // that store's own ensure's business (0025 installs the card triggers in
    // tasks.db); looking for it here would only report it "absent" forever.
    if ((spec.store || STORE_CROW) !== store) continue;
    if (!tableExists(db, spec.table)) {
      // A bundle-owned table that is not here yet is not a problem to report: its
      // bundle installs its own triggers when it creates it (and this ensure
      // re-creates them for a table that IS here). Anything else really is a table
      // this store is missing.
      if (!spec.bundleOwned) skipped.push(spec.table);
      continue;
    }
    const columns = columnsOf(db, spec.table);
    // snapshot is a superset of tracked (covered.js asserts it), so one check
    // covers both the WHEN list and the stored fields. A DERIVED field is
    // computed, not read, so it is not expected to be a column of the table.
    const missing = tableColumns(spec).filter((c) => !columns.has(c));
    if (missing.length) {
      skipped.push(spec.table);
      continue;
    }
    // A derived field that reads another table (crow_context.project_uuid from
    // project_spaces) cannot be captured while that table is absent: the trigger
    // would fail the covered write itself.
    if (Object.keys(spec.derived || {}).length && !tableExists(db, "project_spaces")) {
      skipped.push(spec.table);
      continue;
    }
    if (!hasBaseline(db, itemType, baselineRecorded ? baselineRecorded(spec.migration) : migrationRecorded(db, spec.migration))) {
      awaitingBaseline.push(spec.table);
      continue;
    }
    wanted.push(...triggerDefs(itemType));
  }

  const existing = triggerNamesIn(db);
  const missingDefs = wanted.filter((d) => !existing.has(d.name));
  if (missingDefs.length) {
    db.transaction(() => {
      for (const def of missingDefs) db.exec(def.sql);
    }).immediate();
  }

  return {
    restored: missingDefs.map((d) => d.name),
    skipped,
    awaitingBaseline,
    disarmed: Number(disarmed),
  };
}

/**
 * Boot entry point: ensure against THIS instance's TWO history stores.
 *
 *   crow.db   CROW_DB_PATH → <resolveDataDir()>/crow.db, exactly as the migration
 *             registry resolves it;
 *   tasks.db  tasksDbPath() (CROW_TASKS_DB_PATH, else <data dir>/tasks.db) — the
 *             instance-global store the board reads. It is a SEPARATE database with
 *             its own item_versions, its own guards and its own erase switch
 *             (migration 0025), and a SQLite trigger cannot write across databases,
 *             so a card's capture can only be re-armed by an ensure run against
 *             THAT file. A rebuilt/lost tasks_items therefore needs this pass as
 *             much as crow.db's tables do.
 *
 * Called from servers/gateway/index.js immediately after the registry runs, so a
 * rebuilt table is covered by the same boot that rebuilt it.
 *
 * Never creates a database file: if crow.db is absent the schema guard and the
 * registry have already failed loudly, and an empty file here would only confuse
 * the next boot. tasks.db is ensured only when it already exists, for the same
 * reason (a tasks.db with no tasks_items is a board that has never run, not a
 * broken store).
 *
 * WHICH MIGRATION COUNTS AS "RECORDED" ON tasks.db: crow.db's schema_migrations.
 * The registry keeps one book for the whole instance, in crow.db, even for the
 * migrations that write to tasks.db (scripts/migrations/runner.mjs), so tasks.db has
 * no schema_migrations of its own — the crow.db set is read ONCE and handed to the
 * tasks pass, which is what tells "0025 has applied, arm the card triggers" apart
 * from "0025 has not, leave it alone".
 *
 * Non-fatal by contract (the gateway wraps it): a failure to re-ensure capture is
 * reported to the log, and the gateway also drops an alert-spool entry so "history
 * capture is off" shows up in the bell.
 *
 * @param {{log?: (message: string) => void, dbPath?: string, tasksDbPath?: string}} [opts]
 */
export function ensureHistoryTriggersAtBoot({ log = console.log, dbPath, tasksDbPath } = {}) {
  const path = dbPath || resolveDbPath();
  if (!existsSync(path)) return { restored: [], skipped: ["crow.db absent"], awaitingBaseline: [], disarmed: 0 };

  const db = new Database(path, { fileMustExist: true });
  db.pragma("busy_timeout = 10000");
  let result;
  let recorded;
  try {
    result = ensureHistoryTriggers(db);
    recorded = recordedMigrations(db);
    report(result, log);
  } finally {
    db.close();
  }

  // tasks.db, the card store: its own item_versions, guards, erase switch and
  // capture triggers, and its own stuck-switch disarm. Skipped when the file is not
  // there yet (a board that has never run) — opening it would CREATE it.
  const tasksPath = tasksDbPath || defaultTasksDbPath();
  if (existsSync(tasksPath)) {
    let tdb;
    try {
      tdb = new Database(tasksPath, { fileMustExist: true });
      tdb.pragma("busy_timeout = 10000");
      const tasksResult = ensureHistoryTriggers(tdb, {
        store: STORE_TASKS,
        baselineRecorded: (migrationId) => recorded.has(String(migrationId)),
      });
      report(tasksResult, log, "tasks.db");
    } catch (err) {
      // A board store that is busy or being migrated (the tasks addon child holds it
      // open) must not fail the boot over a re-ensure the next boot repeats.
      log(`[history] tasks.db capture not ensured this boot: ${err?.message ?? err}`);
    } finally {
      try {
        tdb?.close();
      } catch {
        /* a stuck close must not fail the boot */
      }
    }
  }
  return result;
}

/** The per-store report, in one place so both stores say the same things. */
function report(result, log, storeName = null) {
  const where = storeName ? ` (${storeName})` : "";
  if (result.restored.length) {
    log(`[history] re-created ${result.restored.length} trigger(s)${where}: ${result.restored.join(", ")}`);
  }
  if (result.disarmed) {
    log(
      `[history] disarmed the erase switch left armed by an erase that never committed${where} ` +
        `(${result.disarmed} row(s) reset) — history is append-only again`,
    );
  }
  // "item_versions absent" just means the history migration has not applied yet (it
  // defers until the covered tables exist) — the registry already reports that once
  // per boot, so repeating it here would only add noise.
  const notable = result.skipped.filter((s) => s !== "item_versions absent");
  if (notable.length) log(`[history] capture not ensured${where} for: ${notable.join(", ")}`);
  // No baseline yet: the migration installs the capture triggers together with the
  // baselines, so this is "wait for the migration", not "capture is broken" — but it
  // is worth one line, because until it applies those writes are unrecorded.
  if (result.awaitingBaseline.length) {
    log(
      `[history] capture not armed yet${where} (no baseline; waiting for the history migration): ` +
        result.awaitingBaseline.join(", "),
    );
  }
}