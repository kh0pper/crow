// scripts/migrations/0004-track1-card-model.mjs
//
// Track 1: the card model gains provenance (board_mutations), plans-as-
// records (board_plans), and terminal-state results (board_results) — all
// instance-global-only (D-T1.4: gateway verbs only ever address
// instance-global cards; creating these per-project would reopen the
// merged-id-space bug). tasks_briefings is created here too (probe-guarded)
// because nothing in the repo creates it today — only the installed bundle
// does — and Task 6's briefing verbs need it on bundle-less instances.
//
// tasks_items gains `autonomy` (service-validated 'gated'|'auto', default
// 'gated' — no CHECK via ALTER) and `archived_at` (NULL = live) EVERYWHERE —
// instance-global AND every per-project store (project_spaces.tasks_db_uri,
// the 0002 enumeration precedent) — because cards live in both places and a
// column-guarded reader elsewhere (D-T1.6) must find the column wherever the
// card is.
//
// `plan_ref` retires (D-T1.7): DROP COLUMN is the last statement, and it is
// PROBE-GUARDED — the bundle's own CREATE TABLE never had the column (only
// pre-Track-1 code that lived through 0001-board-stages did), so an
// unconditional DROP throws on any bundle-created or grackle-empty store.
// Any non-NULL plan_ref value found on a per-project store is logged loudly
// before the drop — recordPlanRef wrote to per-project stores, so "all-NULL"
// is verified only for the instance-global copy (spec D-T1.4 migration
// note 6); the referenced plan FILES stay on disk, the log preserves the
// id → plan_ref mapping for manual recovery if ever needed.
import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { resolveSqlitePath } from "../pi-bots/instance-paths.mjs";

export const id = "0004-track1-card-model";

export const BOARD_PLANS_DDL = `CREATE TABLE IF NOT EXISTS board_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL,
  version INTEGER NOT NULL,
  body_md TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','superseded')),
  created_actor_kind TEXT NOT NULL, created_actor_id TEXT,
  decided_at TEXT, decided_via TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(item_id, version)
)`;

export const BOARD_RESULTS_DDL = `CREATE TABLE IF NOT EXISTS board_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL,
  plan_id INTEGER,
  job_id TEXT,
  actor_kind TEXT NOT NULL, actor_id TEXT,
  outcome TEXT NOT NULL CHECK(outcome IN ('success','failure','partial')),
  summary_md TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'recorded' CHECK(status IN ('recorded','approved','rejected')),
  decided_at TEXT, decided_via TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

export const BOARD_MUTATIONS_DDL = `CREATE TABLE IF NOT EXISTS board_mutations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL,
  verb TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK(actor_kind IN ('human','session','bot')),
  actor_id TEXT,
  job_id TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

export const BOARD_MUTATIONS_INDEX_DDL =
  "CREATE INDEX IF NOT EXISTS idx_board_mutations_item ON board_mutations(item_id, id)";

export const TASKS_BRIEFINGS_DDL = `CREATE TABLE IF NOT EXISTS tasks_briefings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  briefing_date TEXT NOT NULL UNIQUE,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

export const TASKS_BRIEFINGS_INDEX_DDL =
  "CREATE INDEX IF NOT EXISTS idx_tasks_briefings_date ON tasks_briefings(briefing_date DESC)";

function open(p) {
  const d = new Database(p);
  d.pragma("busy_timeout = 10000");
  return d;
}

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

/**
 * Bring ONE store's tasks_items to the Track 1 shape: add autonomy +
 * archived_at (guarded), drop plan_ref (guarded), sidecar backup first if
 * any write is about to happen. Returns "converged" (nothing to do) or
 * "migrated" (at least one write happened).
 */
async function migrateStore(dbh, dbFilePath, log) {
  const needsAutonomy = !hasColumn(dbh, "tasks_items", "autonomy");
  const needsArchivedAt = !hasColumn(dbh, "tasks_items", "archived_at");
  const needsPlanRefDrop = hasColumn(dbh, "tasks_items", "plan_ref");

  if (!needsAutonomy && !needsArchivedAt && !needsPlanRefDrop) return "converged";

  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const bak = `${dbFilePath}.bak-0004-${ts}`;
  await dbh.backup(bak);
  log(`  backup: ${bak}`);

  if (needsAutonomy) {
    dbh.exec("ALTER TABLE tasks_items ADD COLUMN autonomy TEXT NOT NULL DEFAULT 'gated'");
    log("  tasks_items.autonomy: added");
  } else {
    log("  tasks_items.autonomy: no-op");
  }

  if (needsArchivedAt) {
    dbh.exec("ALTER TABLE tasks_items ADD COLUMN archived_at TEXT");
    log("  tasks_items.archived_at: added");
  } else {
    log("  tasks_items.archived_at: no-op");
  }

  if (needsPlanRefDrop) {
    const nonNull = dbh.prepare(
      "SELECT id, plan_ref FROM tasks_items WHERE plan_ref IS NOT NULL"
    ).all();
    for (const r of nonNull) {
      log(`  DROPPING non-NULL plan_ref on card #${r.id}: plan_ref='${r.plan_ref}' — the referenced plan file (if any) stays on disk`);
    }
    dbh.exec("ALTER TABLE tasks_items DROP COLUMN plan_ref");
    log(`  tasks_items.plan_ref: dropped (${nonNull.length} non-NULL value(s) logged above)`);
  } else {
    log("  tasks_items.plan_ref: absent already — no-op");
  }

  return "migrated";
}

export async function run({ dbPath, tasksDbPath, log = () => {} }) {
  // ---- The instance-global store: the three new tables + tasks_briefings +
  // the column ALTERs + the guarded DROP. ----
  const tdb = open(tasksDbPath);
  try {
    const hasTasksItems = tdb.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='tasks_items'"
    ).get();
    if (!hasTasksItems) return { deferred: true };

    tdb.exec(BOARD_PLANS_DDL);
    tdb.exec(BOARD_RESULTS_DDL);
    tdb.exec(BOARD_MUTATIONS_DDL);
    tdb.exec(BOARD_MUTATIONS_INDEX_DDL);
    tdb.exec(TASKS_BRIEFINGS_DDL);
    tdb.exec(TASKS_BRIEFINGS_INDEX_DDL);
    log("  board_plans, board_results, board_mutations, tasks_briefings: created (IF NOT EXISTS)");

    const outcome = await migrateStore(tdb, tasksDbPath, log);
    log(`  instance-global tasks_items: ${outcome}`);

    // 14 kevin-gated tagged cards are noted here — the tag stays as a visual
    // marker, the autonomy column is the machine truth; no data rewrite.
    const cols = tdb.prepare("PRAGMA table_info(tasks_items)").all().map((c) => c.name);
    if (cols.includes("tags")) {
      const gatedTagCount = tdb.prepare(
        "SELECT COUNT(*) AS n FROM tasks_items WHERE tags LIKE '%kevin-gated%'"
      ).get().n;
      log(`  kevin-gated tag count: ${gatedTagCount} (autonomy stays default 'gated' for all — no data rewrite)`);
    }

    // ---- Per-project stores: columns + guarded drop only, own backup,
    // NOT the three tables / tasks_briefings (D-T1.4: instance-global-only).
    const projectDbUris = [];
    try {
      const cdb = open(dbPath);
      try {
        for (const r of cdb.prepare("SELECT tasks_db_uri FROM project_spaces").all()) {
          if (r.tasks_db_uri) projectDbUris.push(String(r.tasks_db_uri));
        }
      } finally { cdb.close(); }
    } catch { /* crow.db lookup is best-effort — fallback: no project stores */ }

    const globalReal = resolveSqlitePath(tasksDbPath);
    const seen = new Set([globalReal]);
    for (const uri of projectDbUris) {
      const real = resolveSqlitePath(uri);
      if (!real || seen.has(real)) continue;
      seen.add(real);
      if (!existsSync(real)) { log(`  project store ${uri}: file absent — skipped`); continue; }
      try {
        const pdb = open(real);
        try {
          const hasItems = pdb.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='tasks_items'"
          ).get();
          if (!hasItems) { log(`  project store ${real}: tasks_items absent — skipped`); continue; }
          const o = await migrateStore(pdb, real, log);
          log(`  project store ${real}: ${o}`);
        } finally { pdb.close(); }
      } catch (e) {
        log(`  project store ${real}: MIGRATION FAILED — autonomy/archived_at unwritable there until fixed: ${(e && e.message) || e}`);
      }
    }
  } finally {
    tdb.close();
  }
}
