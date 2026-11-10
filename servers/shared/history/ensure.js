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
 * Deliberately NO baselines here: a dropped trigger means writes went
 * unrecorded, and only the migration (which can defer) decides what a baseline
 * is. This function's job is "writes are captured again from now on".
 *
 * Also re-creates the append-only guards, because they sit on item_versions
 * itself, which nothing else rebuilds.
 */
import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { resolveDbPath } from "../../db.js";
import {
  COVERED,
  ITEM_VERSIONS_ERASE_DDL,
  guardTriggerDefs,
  triggerDefs,
} from "./covered.js";

const tableExists = (db, table) =>
  Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));

const columnsOf = (db, table) =>
  new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));

const triggerNamesIn = (db) =>
  new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all().map((r) => r.name));

/**
 * Re-create every missing history trigger on one open crow.db.
 *
 * @param {import("better-sqlite3").Database} db
 * @returns {{restored: string[], skipped: string[]}} `restored` is the trigger
 *   names this call created (empty on a healthy store); `skipped` is the
 *   covered tables left alone because they are absent or still missing a column
 *   a trigger names (the migration will install theirs once the table is whole).
 */
export function ensureHistoryTriggers(db) {
  const skipped = [];
  // Nothing to guard or capture yet: migration 0024 owns creation, and a store
  // without item_versions has never run it.
  if (!tableExists(db, "item_versions")) {
    return { restored: [], skipped: ["item_versions absent"] };
  }
  if (!columnsOf(db, "item_versions").has("project_ref")) {
    // An item_versions from an earlier build of the migration: its triggers
    // would name a column that is not there. Let 0024 re-run instead.
    return { restored: [], skipped: ["item_versions.project_ref absent"] };
  }

  const wanted = [...guardTriggerDefs()];
  for (const [itemType, spec] of Object.entries(COVERED)) {
    if (!tableExists(db, spec.table)) {
      skipped.push(spec.table);
      continue;
    }
    const columns = columnsOf(db, spec.table);
    // snapshot is a superset of tracked (covered.js asserts it), so one check
    // covers both the WHEN list and the stored fields.
    const missing = [spec.idColumn, ...spec.snapshot].filter((c) => !columns.has(c));
    if (missing.length) {
      skipped.push(spec.table);
      continue;
    }
    wanted.push(...triggerDefs(itemType));
  }

  const existing = triggerNamesIn(db);
  const missingDefs = wanted.filter((d) => !existing.has(d.name));
  // The guard triggers read the erase control table, so it must exist whether or
  // not a trigger is missing (it can be lost the same way they can). Idempotent:
  // IF NOT EXISTS plus a seed that writes only when the table is empty.
  const needsControlTable =
    !tableExists(db, "item_versions_erase") ||
    db.prepare("SELECT COUNT(*) AS n FROM item_versions_erase").get().n === 0;
  if (missingDefs.length || needsControlTable) {
    db.exec(ITEM_VERSIONS_ERASE_DDL);
  }
  if (missingDefs.length) {
    db.transaction(() => {
      for (const def of missingDefs) db.exec(def.sql);
    }).immediate();
  }

  return { restored: missingDefs.map((d) => d.name), skipped };
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
 * @param {{log?: (message: string) => void, dbPath?: string}} [opts]
 */
export function ensureHistoryTriggersAtBoot({ log = console.log, dbPath } = {}) {
  const path = dbPath || resolveDbPath();
  if (!existsSync(path)) return { restored: [], skipped: ["crow.db absent"] };

  const db = new Database(path, { fileMustExist: true });
  db.pragma("busy_timeout = 10000");
  try {
    const result = ensureHistoryTriggers(db);
    if (result.restored.length) {
      log(`[history] re-created ${result.restored.length} trigger(s): ${result.restored.join(", ")}`);
    }
    // "item_versions absent" just means migration 0024 has not applied yet (it
    // defers until the covered tables exist) — the registry already reports that
    // once per boot, so repeating it here would only add noise.
    const notable = result.skipped.filter((s) => s !== "item_versions absent");
    if (notable.length) log(`[history] capture not ensured for: ${notable.join(", ")}`);
    return result;
  } finally {
    db.close();
  }
}