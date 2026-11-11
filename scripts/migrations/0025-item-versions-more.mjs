// scripts/migrations/0025-item-versions-more.mjs
//
// The REST OF THE COVERED CONTENT (version history Task 7): research notes, KB
// articles, bot definitions — and board cards, which live in a SEPARATE
// database.
//
// TWO STORES, TWO SETS OF TRIGGERS. SQLite triggers cannot write across
// databases, so a card change can never produce a row of crow.db's
// item_versions. tasks.db therefore gets its OWN item_versions table (plus the
// same append-only guards and the same erase-control row) via `tasksDbPath`, and
// the card capture triggers live THERE. The DDL is not copied: it is 0024's
// exported ITEM_VERSIONS_DDL, so the two stores can never drift into shapes the
// one History API cannot read. Everything else in this file reuses 0024's
// exported helpers (baselineSql, triggerSql, tableColumns, snapshotExpr,
// projectRefExpr) for the same reason.
//
// LOCAL ONLY. Nothing this migration creates is added to any sync table list:
// each store's item_versions is local to this instance, and `item_versions` is
// never in instance-sync's SYNCED_TABLES (nor the card triggers' new rows
// anywhere near an outbound transform). See the note above ITEM_TYPES.
//
// PER TYPE, TOLERANT OF ABSENT TABLES, WITH THE ONE DELIBERATE EXCEPTION:
//   - kb_articles is BUNDLE-OWNED (bundles/knowledge-base). It is normally
//     absent when this runs, so this migration SKIPS that type with a reason and
//     still applies the rest; the bundle's own init-tables.js installs
//     triggerSql("kb_article") right after it creates the table (a table it just
//     created has no rows, so it needs no baseline).
//   - research_notes and pi_bot_defs are init-db's, so their absence is a
//     half-built store: this run still installs whatever IS there (idempotent),
//     and returns a deferral so the registry retries.
//   - tasks_items is created by 0000-tasks-base, which sorts FIRST, so a real
//     instance always has it by now. If it is somehow absent — or
//     `tasksDbPath` never arrived — this returns a deferral too, rather than
//     recording "applied" and leaving the card triggers uninstalled forever.
//
// ATOMIC PER TYPE, exactly as 0024: for each table the triggers and the baseline
// are ONE BEGIN IMMEDIATE transaction (db.transaction(...).immediate()), so no
// other connection can observe (or write through) the half-installed state, and
// the baseline is guarded PER ITEM (`v.item_id = CAST(t.<id> AS TEXT)`), which
// makes a second run write nothing at all.
//
// Credentials never enter history: pi_bot_defs carries none in a COLUMN — they
// live inside the `definition` JSON — so that column is snapshotted through the
// allow-listed projection in covered.js (BOT_DEFINITION_KEYS), compared by the
// same projection, and restored by a merge that leaves the live credential keys
// untouched (api.js). No credential-named column is tracked or snapshotted here,
// and the import rules in covered.js refuse one at load time.
//
// Additive only, no SCHEMA_GENERATION bump: the registry is the rail for schema
// a running instance can pick up on boot (see scripts/migrations/runner.mjs).
import Database from "better-sqlite3";
import { performance } from "node:perf_hooks";
import {
  COVERED,
  SECRET_COLUMN,
  STORE_TASKS,
  tableColumns,
  triggerSql,
  typesForMigration,
} from "../../servers/shared/history/covered.js";
import { ITEM_VERSIONS_DDL, baselineSql } from "./0024-item-versions.mjs";

export const id = "0025-item-versions-more";

// rollbackSafe: new tables (tasks.db's item_versions and its guards) plus three
// triggers per covered table; older code neither reads nor writes any of them.
export const rollbackSafe = true;

/**
 * The item types THIS migration owns: every COVERED entry whose `migration` names
 * it. Adding a covered type therefore means naming its owner in covered.js — a
 * type cannot be added and silently left uncaptured (a test asserts every COVERED
 * type is claimed by exactly one migration).
 */
export const ITEM_TYPES = Object.freeze(typesForMigration(id));

/** The types this migration installs in tasks.db (the card store). */
export const TASK_ITEM_TYPES = Object.freeze(ITEM_TYPES.filter((t) => COVERED[t].store === STORE_TASKS));

const tableExists = (db, table) =>
  Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));

const columnsOf = (db, table) =>
  new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));

function open(path) {
  const db = new Database(path);
  db.pragma("busy_timeout = 10000");
  return db;
}

/**
 * Install one type's triggers and baseline, in ONE immediate transaction.
 *
 * The checks are the caller's (the table has to exist with every column a
 * trigger names); this is only the write. Returns the baseline row count and how
 * long it took, for the log.
 */
function installOne(db, itemType) {
  const spec = COVERED[itemType];
  const install = db.transaction(() => {
    for (const sql of triggerSql(itemType)) db.exec(sql);
    const startedAt = performance.now();
    const { changes } = db.prepare(baselineSql(itemType, spec)).run();
    return { added: Number(changes), ms: performance.now() - startedAt };
  });
  return install.immediate();
}

/** A covered table is ready when it exists and has every column a trigger names. */
function readiness(db, spec) {
  if (!tableExists(db, spec.table)) return { ready: false, reason: `${spec.table} absent` };
  const columns = columnsOf(db, spec.table);
  const missing = tableColumns(spec).filter((c) => !columns.has(c));
  if (missing.length) return { ready: false, reason: `${spec.table} missing ${missing.join(", ")}` };
  const secretColumns = [...spec.tracked, ...spec.snapshot].filter((c) => SECRET_COLUMN.test(c));
  if (secretColumns.length) {
    throw new Error(`history: ${spec.table} would version a credential column (${secretColumns.join(", ")})`);
  }
  return { ready: true };
}

export function run({ dbPath, tasksDbPath, log = () => {} }) {
  const skipped = [];
  const unready = [];

  // ---- crow.db: the notes, the KB (when the bundle is installed) and the bots.
  const cdb = open(dbPath);
  try {
    // The history table itself, in case 0024 deferred on this store (it only
    // waits for ITS three tables) or this store is older than the erase switch.
    // Every statement is IF NOT EXISTS; a healthy store does nothing here.
    cdb.exec(ITEM_VERSIONS_DDL);
    log("  item_versions: ensured (table, indexes, append-only guards, erase control)");

    for (const itemType of ITEM_TYPES) {
      const spec = COVERED[itemType];
      if (spec.store === STORE_TASKS) continue;
      const state = readiness(cdb, spec);
      if (!state.ready) {
        if (spec.bundleOwned) {
          // The bundle creates it later and installs its own triggers (see
          // bundles/knowledge-base/server/init-tables.js). Not a deferral: this
          // migration has nothing to wait for.
          skipped.push({ itemType, reason: `${state.reason} (bundle-owned; its init installs the triggers)` });
          log(`  ${spec.table}: ${state.reason} — bundle-owned, its init installs the ${itemType} triggers`);
        } else {
          unready.push({ itemType, reason: state.reason });
          log(`  ${spec.table}: ${state.reason} — ${itemType} triggers skipped, will retry`);
        }
        continue;
      }
      const { added, ms } = installOne(cdb, itemType);
      log(`  ${spec.table}: triggers ensured, ${added} baseline version(s) in ${ms.toFixed(1)} ms`);
    }
  } finally {
    cdb.close();
  }

  // ---- tasks.db: board cards, in the database the cards actually live in.
  if (!tasksDbPath) {
    log("  tasks.db: no tasksDbPath — card triggers skipped, will retry");
    return {
      deferred: true,
      reason: `tasks.db path not available${unready.length ? `; also not ready: ${unready.map((u) => u.reason).join(", ")}` : ""}`,
      skipped,
    };
  }
  const tdb = open(tasksDbPath);
  try {
    for (const itemType of TASK_ITEM_TYPES) {
      const spec = COVERED[itemType];
      const state = readiness(tdb, spec);
      if (!state.ready) {
        unready.push({ itemType, reason: state.reason });
        log(`  ${spec.table}: ${state.reason} — ${itemType} triggers skipped, will retry`);
        continue;
      }
      // tasks.db gets its OWN item_versions (and its own append-only guards and
      // erase control): a trigger cannot write into crow.db's. LOCAL ONLY: this
      // table is never named in a sync table list — versions stay on the instance
      // that recorded them, exactly as crow.db's do.
      tdb.exec(ITEM_VERSIONS_DDL);
      log(`  ${spec.table}: item_versions ensured in tasks.db (local only, never synced)`);
      const { added, ms } = installOne(tdb, itemType);
      log(`  ${spec.table}: triggers ensured, ${added} baseline version(s) in ${ms.toFixed(1)} ms`);
    }
  } finally {
    tdb.close();
  }

  if (unready.length) {
    return {
      deferred: true,
      reason: `covered tables not ready: ${unready.map((u) => u.reason).sort().join(", ")}`,
      skipped,
    };
  }
  return { applied: true, skipped };
}