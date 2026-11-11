// scripts/migrations/0026-item-versions-sources.mjs
//
// RESEARCH SOURCES KEEP THEIR HISTORY (the version history follow-up to Task 7):
// the `research_source` item type's capture triggers and its baseline, for the
// `research_sources` table scripts/init-db.js creates.
//
// WHY A SEPARATE MIGRATION rather than an addition to 0025: a migration is only
// ever run once per store, and 0025 has already been recorded as applied on every
// instance that has booted since Task 7 shipped. Adding a type to its list would
// install nothing there — the registry would skip it forever, and the sources
// would stay uncaptured while the covered list says otherwise. The registry is
// ordered by file name, so this runs after 0025 on a fresh install and on the
// next boot of an upgraded one.
//
// NOTHING IS COPIED FROM 0024/0025. The table DDL, the append-only guards and the
// per-item baseline statement are 0024's exported ITEM_VERSIONS_DDL and
// baselineSql; the readiness checks and the trigger SQL are covered.js's
// tableColumns / triggerSql / SECRET_COLUMN. The type's own spec (`tracked`,
// `snapshot`, `omitted`, `projectRef`) lives in covered.js, where adding a
// covered table is one entry plus "which migration owns it".
//
// ONE STORE, ONE KIND OF TYPE. `research_sources` is init-db's, in crow.db, so
// this migration only ever looks at crow.db — it needs no tasksDbPath, and a
// type owned by this migration that lived in the other store would be an error at
// load time rather than a silent no-op (see the check below).
//
// WHAT IS DELIBERATELY OUT OF HISTORY (the controller's ruling under the version
// history design — large re-fetchable fields stay out; recorded in covered.js): the
// fetch columns — fetched_text and the bookkeeping beside it — are a re-fetchable
// cache, so they are in neither `tracked` nor `snapshot`, and full_text
// (person-supplied, nothing can regenerate it) is in both, uncapped.
//
// ATOMIC PER TABLE, exactly as 0024/0025: for each table the triggers and the
// baseline are ONE BEGIN IMMEDIATE transaction (db.transaction(...).immediate()),
// so no other connection can observe (or write through) the half-installed state.
// The baseline is guarded PER ITEM (`v.item_id = CAST(t.<id> AS TEXT)`), so a
// second run writes nothing at all, and a row already captured by a live trigger
// keeps its real versions instead of gaining a second 'insert'.
//
// TOLERANT OF AN ABSENT TABLE, like 0025: research_sources is normally there (a
// fresh install creates it and 0013/init-db add the provenance columns), but a
// half-built store — a partial restore, a bare DB a co-hosted instance has not run
// init-db against — is skipped with a logged reason and the run DEFERS, so a later
// boot retries and installs the triggers then. Credentials never enter history:
// no column of this table is credential-named (checked at load by covered.js's
// import rules and again by the readiness check), and text that merely LOOKS like
// a key is redacted by the existing redaction sweep (sweep.js), the same pass the
// other types get.
//
// LOCAL ONLY: nothing here is added to any sync table list. research_sources is
// not in instance-sync's SYNCED_TABLES at all (the rows are not synced, only the
// notes that reference them are), so a source's versions — and a source's restore
// — stay on the instance that recorded them.
//
// Additive only, no SCHEMA_GENERATION bump: the registry is the rail for schema a
// running instance can pick up on boot (see scripts/migrations/runner.mjs).
import Database from "better-sqlite3";
import { performance } from "node:perf_hooks";
import {
  COVERED,
  SECRET_COLUMN,
  STORE_CROW,
  tableColumns,
  triggerSql,
  typesForMigration,
} from "../../servers/shared/history/covered.js";
import { ITEM_VERSIONS_DDL, baselineSql } from "./0024-item-versions.mjs";

export const id = "0026-item-versions-sources";

// rollbackSafe: three triggers per covered table; older code neither reads nor
// writes them, and the versions they write are rows of a table it already knows.
export const rollbackSafe = true;

/**
 * The item types THIS migration owns: every COVERED entry whose `migration` names
 * it. A type cannot be added and silently left uncaptured (a test asserts every
 * COVERED type is claimed by exactly one migration).
 */
export const ITEM_TYPES = Object.freeze(typesForMigration(id));

// This migration opens crow.db only, so a type it owned in ANY other store could
// never be installed here. Failing at load is the honest direction: a migration
// that quietly skipped it would leave that table uncaptured forever while the
// registry reported it applied.
for (const itemType of ITEM_TYPES) {
  if (COVERED[itemType].store !== STORE_CROW) {
    throw new Error(`history: ${itemType} lives in another store; ${id} installs crow.db types only`);
  }
}

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
 * The checks are the caller's (the table has to exist with every column a trigger
 * names); this is only the write. Returns the baseline row count and how long it
 * took, for the log.
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
  // A derived field reading another table (a section's project_uuid from
  // project_spaces) cannot be captured while that table is absent: the trigger —
  // and the baseline — would fail on every covered row. research_source has no
  // derived field today; the check is here so a later one cannot break the boot.
  if (Object.keys(spec.derived || {}).length && !tableExists(db, "project_spaces")) {
    return { ready: false, reason: `project_spaces absent (${spec.table} needs it)` };
  }
  const secretColumns = [...spec.tracked, ...spec.snapshot].filter((c) => SECRET_COLUMN.test(c));
  if (secretColumns.length) {
    throw new Error(`history: ${spec.table} would version a credential column (${secretColumns.join(", ")})`);
  }
  return { ready: true };
}

export function run({ dbPath, log = () => {} }) {
  const unready = [];
  const db = open(dbPath);
  try {
    // The history table itself, in case this store is older than the erase switch
    // (or 0024 deferred on it). Every statement is IF NOT EXISTS; a store that
    // already ran 0024/0025 does nothing here.
    db.exec(ITEM_VERSIONS_DDL);
    log("  item_versions: ensured (table, indexes, append-only guards, erase control)");

    for (const itemType of ITEM_TYPES) {
      const spec = COVERED[itemType];
      const state = readiness(db, spec);
      if (!state.ready) {
        unready.push({ itemType, reason: state.reason });
        log(`  ${spec.table}: ${state.reason} — ${itemType} triggers skipped, will retry`);
        continue;
      }
      const { added, ms } = installOne(db, itemType);
      log(`  ${spec.table}: triggers ensured, ${added} baseline version(s) in ${ms.toFixed(1)} ms`);
    }
  } finally {
    db.close();
  }

  if (unready.length) {
    return {
      deferred: true,
      reason: `covered tables not ready: ${unready.map((u) => u.reason).sort().join(", ")}`,
    };
  }
  return { applied: true };
}