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
 */
import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { resolveDbPath } from "../../db.js";
import {
  COVERED,
  ITEM_VERSIONS_ERASE_DDL,
  guardTriggerDefs,
  tableColumns,
  triggerDefs,
} from "./covered.js";

const tableExists = (db, table) =>
  Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));

const columnsOf = (db, table) =>
  new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));

const triggerNamesIn = (db) =>
  new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all().map((r) => r.name));

/** The migration that owns capture triggers and baselines. */
export const BASELINE_MIGRATION_ID = "0024-item-versions";

/** Has the migration registry recorded 0024? (No registry table = no.) */
const migrationRecorded = (db) => {
  try {
    return Boolean(
      db.prepare("SELECT 1 FROM schema_migrations WHERE id = ?").get(BASELINE_MIGRATION_ID),
    );
  } catch {
    return false;
  }
};

/**
 * Does this item type have a baseline yet? Either the migration that writes the
 * baselines is recorded as applied, or a 'system' version (the baseline's author)
 * of that item type is present — which covers a store restored from a backup that
 * lost its schema_migrations row.
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
 * @param {import("better-sqlite3").Database} db
 * @returns {{restored: string[], skipped: string[], awaitingBaseline: string[],
 *   disarmed: number}} `restored` is the trigger names this call created (empty on
 *   a healthy store); `skipped` is the covered tables left alone because they are
 *   absent or still missing a column a trigger names (the migration will install
 *   theirs once the table is whole); `awaitingBaseline` is the ready tables whose
 *   capture is left to the migration because no baseline exists yet; `disarmed` is
 *   the number of erase-switch rows reset to 0.
 */
export function ensureHistoryTriggers(db) {
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

  // A switch still armed at boot belongs to an erase transaction that never
  // committed; leaving it on would let anything rewrite history without the
  // audited door. Reset it before anything can write.
  const disarmed = db.prepare("UPDATE item_versions_erase SET armed = 0 WHERE armed <> 0").run().changes;

  const recorded = migrationRecorded(db);
  const wanted = [...guardTriggerDefs()];
  for (const [itemType, spec] of Object.entries(COVERED)) {
    if (!tableExists(db, spec.table)) {
      skipped.push(spec.table);
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
    if (!hasBaseline(db, itemType, recorded)) {
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

  return { restored: missingDefs.map((d) => d.name), skipped, awaitingBaseline, disarmed: Number(disarmed) };
}

/**
 * Boot entry point: ensure against THIS instance's crow.db (CROW_DB_PATH →
 * <resolveDataDir()>/crow.db, exactly as the migration registry resolves it).
 * Called from servers/gateway/index.js immediately after the registry runs, so
 * a rebuilt table is covered by the same boot that rebuilt it.
 *
 * Never creates the database file: if crow.db is absent the schema guard and the
 * registry have already failed loudly, and an empty file here would only confuse
 * the next boot.
 *
 * Non-fatal by contract (the gateway wraps it): a failure to re-ensure capture is
 * reported to the log, and the gateway also drops an alert-spool entry so "history
 * capture is off" shows up in the bell.
 *
 * @param {{log?: (message: string) => void, dbPath?: string}} [opts]
 */
export function ensureHistoryTriggersAtBoot({ log = console.log, dbPath } = {}) {
  const path = dbPath || resolveDbPath();
  if (!existsSync(path)) return { restored: [], skipped: ["crow.db absent"], awaitingBaseline: [], disarmed: 0 };

  const db = new Database(path, { fileMustExist: true });
  db.pragma("busy_timeout = 10000");
  try {
    const result = ensureHistoryTriggers(db);
    if (result.restored.length) {
      log(`[history] re-created ${result.restored.length} trigger(s): ${result.restored.join(", ")}`);
    }
    if (result.disarmed) {
      log(
        `[history] disarmed the erase switch left armed by an erase that never committed (${result.disarmed} row(s) reset) — history is append-only again`,
      );
    }
    // "item_versions absent" just means migration 0024 has not applied yet (it
    // defers until the covered tables exist) — the registry already reports that
    // once per boot, so repeating it here would only add noise.
    const notable = result.skipped.filter((s) => s !== "item_versions absent");
    if (notable.length) log(`[history] capture not ensured for: ${notable.join(", ")}`);
    // No baseline yet: the migration installs the capture triggers together with
    // the baselines, so this is "wait for 0024", not "capture is broken" — but it
    // is worth one line, because until it applies those writes are unrecorded.
    if (result.awaitingBaseline.length) {
      log(`[history] capture not armed yet (no baseline; waiting for ${BASELINE_MIGRATION_ID}): ${result.awaitingBaseline.join(", ")}`);
    }
    return result;
  } finally {
    db.close();
  }
}