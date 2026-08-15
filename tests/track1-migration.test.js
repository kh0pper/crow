// tests/track1-migration.test.js
//
// Migration 0004-track1-card-model: board_plans/board_results/board_mutations
// (instance-global tasks.db only), tasks_briefings (instance-global,
// probe-guarded), tasks_items.autonomy/archived_at (everywhere), and the
// DROP COLUMN plan_ref retirement (probe-guarded — the bundle's own CREATE
// never had the column, so an unconditional DROP throws on those stores).
//
// Per-project stores (project_spaces.tasks_db_uri) get ONLY the column
// ALTERs + the guarded DROP, each with its own sidecar backup — the three
// new tables and tasks_briefings are instance-global-only (D-T1.4).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "../scripts/migrations/runner.mjs";

const DIR = join(import.meta.dirname, "..", "scripts", "migrations");

// Every fixture pre-records 0001-0003 in schema_migrations — otherwise the
// whole-directory run re-executes them against already-converged data and
// crashes (0002's duplicate-column-add, 0003's tracker-table DROP on tables
// that no longer exist). Real instances are protected by their bookkeeping
// rows; fixtures must be too. See tests/tracker-convergence-migration.test.js
// markPhaseADone for the same pattern — extended here to also mark 0003.
function markPriorDone(c) {
  c.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, sha TEXT)");
  for (const id of ["0001-board-stages", "0002-board-defs", "0003-tracker-convergence"]) {
    c.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, datetime('now'))").run(id);
  }
}

function colNames(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}
function hasTable(db, name) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
}
function rowCount(db, table) {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
}
function readTitle(db, id) {
  return db.prepare("SELECT title FROM tasks_items WHERE id=?").get(id)?.title;
}

// A post-0003 instance-global tasks.db: tasks_items carries plan_ref (0001's
// column, never dropped pre-Track-1), board_id/lease columns (0003), no
// autonomy/archived_at yet, no board_plans/results/mutations/briefings.
function seedPost0003TasksDb(t) {
  t.exec(`CREATE TABLE tasks_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT,
    status TEXT NOT NULL DEFAULT 'pending', priority INTEGER DEFAULT 3,
    due_date TEXT, phase TEXT, owner TEXT, tags TEXT, parent_id INTEGER,
    project_id INTEGER, assigned_bot TEXT, plan_ref TEXT, stage TEXT,
    board_id INTEGER, bot_id TEXT, action_needed TEXT, next_followup_date TEXT,
    processing_lease TEXT, processing_lease_status TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT, data_json TEXT NOT NULL DEFAULT '{}');
  CREATE TABLE board_defs (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE,
    project_id INTEGER UNIQUE, display_name TEXT NOT NULL, status_values TEXT NOT NULL,
    terminal_values TEXT NOT NULL, fields_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "t1card-"));
  const dbPath = join(root, "crow.db");
  const tasksDbPath = join(root, "tasks.db");
  const c = new Database(dbPath);
  markPriorDone(c);
  c.exec(`CREATE TABLE project_spaces (id INTEGER PRIMARY KEY, name TEXT, tasks_db_uri TEXT);
    CREATE TABLE bot_sessions (id INTEGER PRIMARY KEY);`);
  c.close();
  const t = new Database(tasksDbPath);
  seedPost0003TasksDb(t);
  t.prepare("INSERT INTO tasks_items (id, title, status, project_id) VALUES (1,'seeded card one','pending',1)").run();
  t.prepare("INSERT INTO tasks_items (id, title, status, project_id, board_id) VALUES (2,'seeded tracker item','pending',1,9)").run();
  t.close();
  return { root, dbPath, tasksDbPath };
}

test("0004 adds tables+columns and drops plan_ref on a post-0003 store", async () => {
  const f = fixture();
  try {
    const r = await runMigrations({ migrationsDir: DIR, dbPath: f.dbPath, tasksDbPath: f.tasksDbPath, sha: "test", log: () => {} });
    assert.ok(r.applied.includes("0004-track1-card-model"));

    const tasksDb = new Database(f.tasksDbPath);
    const cols = colNames(tasksDb, "tasks_items");
    assert.ok(cols.includes("autonomy") && cols.includes("archived_at"));
    assert.ok(!cols.includes("plan_ref"), "plan_ref must be dropped");
    for (const tbl of ["board_plans", "board_results", "board_mutations", "tasks_briefings"]) {
      assert.ok(hasTable(tasksDb, tbl), `${tbl} must exist`);
    }
    // data survives bit-for-bit
    assert.equal(rowCount(tasksDb, "tasks_items"), 2);
    assert.equal(readTitle(tasksDb, 1), "seeded card one");
    assert.equal(readTitle(tasksDb, 2), "seeded tracker item");
    // autonomy default is 'gated'
    const row = tasksDb.prepare("SELECT autonomy, archived_at FROM tasks_items WHERE id=1").get();
    assert.equal(row.autonomy, "gated");
    assert.equal(row.archived_at, null);
    tasksDb.close();
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("0004 re-run converges (idempotent)", async () => {
  const f = fixture();
  try {
    const a = await runMigrations({ migrationsDir: DIR, dbPath: f.dbPath, tasksDbPath: f.tasksDbPath, log: () => {} });
    assert.ok(a.applied.includes("0004-track1-card-model"));
    const b = await runMigrations({ migrationsDir: DIR, dbPath: f.dbPath, tasksDbPath: f.tasksDbPath, log: () => {} });
    assert.ok(b.skipped.includes("0004-track1-card-model"), "recorded — second call skips via bookkeeping");

    // Shape-level idempotence too: call the migration body directly a second
    // time, bypassing the record, the way 0002/0003's own tests do.
    const mod = await import(join(DIR, "0004-track1-card-model.mjs"));
    await mod.run({ dbPath: f.dbPath, tasksDbPath: f.tasksDbPath, log: () => {} });

    const tasksDb = new Database(f.tasksDbPath);
    const cols = colNames(tasksDb, "tasks_items");
    assert.ok(cols.includes("autonomy") && cols.includes("archived_at"));
    assert.ok(!cols.includes("plan_ref"));
    assert.equal(rowCount(tasksDb, "tasks_items"), 2, "no duplication on re-run");
    tasksDb.close();
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("0004 defers when tasks_items absent", async () => {
  const root = mkdtempSync(join(tmpdir(), "t1card-defer-"));
  try {
    const dbPath = join(root, "crow.db");
    const tasksDbPath = join(root, "tasks.db");
    const c = new Database(dbPath);
    markPriorDone(c);
    c.exec(`CREATE TABLE project_spaces (id INTEGER PRIMARY KEY, name TEXT, tasks_db_uri TEXT);
      CREATE TABLE bot_sessions (id INTEGER PRIMARY KEY);`);
    c.close();
    new Database(tasksDbPath).close(); // empty file — tasks_items absent

    const r = await runMigrations({ migrationsDir: DIR, dbPath, tasksDbPath, log: () => {} });
    assert.ok(r.deferred.includes("0004-track1-card-model"));
    assert.ok(!r.applied.includes("0004-track1-card-model"));

    const book = new Database(dbPath);
    const rows = book.prepare("SELECT id FROM schema_migrations WHERE id='0004-track1-card-model'").all();
    book.close();
    assert.deepEqual(rows, [], "a deferral must leave no bookkeeping row behind");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("0004 tolerates a store that never had plan_ref", async () => {
  const root = mkdtempSync(join(tmpdir(), "t1card-noplanref-"));
  try {
    const dbPath = join(root, "crow.db");
    const tasksDbPath = join(root, "tasks.db");
    const c = new Database(dbPath);
    markPriorDone(c);
    c.exec(`CREATE TABLE project_spaces (id INTEGER PRIMARY KEY, name TEXT, tasks_db_uri TEXT);
      CREATE TABLE bot_sessions (id INTEGER PRIMARY KEY);`);
    c.close();
    // bundle-shaped store: no plan_ref column at all.
    const t = new Database(tasksDbPath);
    t.exec(`CREATE TABLE tasks_items (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', project_id INTEGER, data_json TEXT NOT NULL DEFAULT '{}');
      CREATE TABLE board_defs (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE,
        project_id INTEGER UNIQUE, display_name TEXT NOT NULL, status_values TEXT NOT NULL,
        terminal_values TEXT NOT NULL, fields_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    t.prepare("INSERT INTO tasks_items (title, status) VALUES ('bundle card','pending')").run();
    t.close();

    const r = await runMigrations({ migrationsDir: DIR, dbPath, tasksDbPath, log: () => {} });
    assert.ok(r.applied.includes("0004-track1-card-model"), "must not throw absent plan_ref");

    const tasksDb = new Database(tasksDbPath);
    const cols = colNames(tasksDb, "tasks_items");
    assert.ok(cols.includes("autonomy") && cols.includes("archived_at"));
    assert.ok(!cols.includes("plan_ref"));
    tasksDb.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("0004 per-project store gets columns + guarded drop + backup, NOT the three tables", async () => {
  const f = fixture();
  const projRoot = mkdtempSync(join(tmpdir(), "t1card-proj-"));
  try {
    const projTasksDbPath = join(projRoot, "tasks.db");
    const pt = new Database(projTasksDbPath);
    pt.exec(`CREATE TABLE tasks_items (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', project_id INTEGER, plan_ref TEXT,
      data_json TEXT NOT NULL DEFAULT '{}')`);
    pt.prepare("INSERT INTO tasks_items (id, title, status, project_id, plan_ref) VALUES (1,'project card',?,?,NULL)")
      .run("pending", 2);
    pt.close();

    const c = new Database(f.dbPath);
    c.prepare("INSERT INTO project_spaces (id, name, tasks_db_uri) VALUES (2, 'Proj Two', ?)").run(projTasksDbPath);
    c.close();

    const r = await runMigrations({ migrationsDir: DIR, dbPath: f.dbPath, tasksDbPath: f.tasksDbPath, log: () => {} });
    assert.ok(r.applied.includes("0004-track1-card-model"));

    const pdb = new Database(projTasksDbPath);
    const cols = colNames(pdb, "tasks_items");
    assert.ok(cols.includes("autonomy") && cols.includes("archived_at"));
    assert.ok(!cols.includes("plan_ref"), "per-project store also drops plan_ref");
    for (const tbl of ["board_plans", "board_results", "board_mutations", "tasks_briefings"]) {
      assert.ok(!hasTable(pdb, tbl), `${tbl} must NOT exist in a per-project store`);
    }
    assert.equal(rowCount(pdb, "tasks_items"), 1, "row survives");
    pdb.close();

    const files = readdirSync(projRoot);
    assert.ok(files.some((n) => n.startsWith("tasks.db.bak-0004-")), "per-project store gets its own sidecar backup");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(projRoot, { recursive: true, force: true });
  }
});

test("0004 logs non-NULL plan_ref before dropping (per-project)", async () => {
  const f = fixture();
  const projRoot = mkdtempSync(join(tmpdir(), "t1card-projlog-"));
  try {
    const projTasksDbPath = join(projRoot, "tasks.db");
    const pt = new Database(projTasksDbPath);
    pt.exec(`CREATE TABLE tasks_items (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', project_id INTEGER, plan_ref TEXT,
      data_json TEXT NOT NULL DEFAULT '{}')`);
    pt.prepare("INSERT INTO tasks_items (id, title, status, project_id, plan_ref) VALUES (1,'workspace card','pending',3,?)")
      .run(JSON.stringify({ kind: "workspace" }));
    pt.close();

    const c = new Database(f.dbPath);
    c.prepare("INSERT INTO project_spaces (id, name, tasks_db_uri) VALUES (3, 'Proj Three', ?)").run(projTasksDbPath);
    c.close();

    const lines = [];
    const r = await runMigrations({
      migrationsDir: DIR, dbPath: f.dbPath, tasksDbPath: f.tasksDbPath,
      log: (msg) => lines.push(msg),
    });
    assert.ok(r.applied.includes("0004-track1-card-model"));

    const hit = lines.find((l) => l.includes("plan_ref") && l.includes("workspace"));
    assert.ok(hit, `expected a loud log line naming the non-NULL plan_ref value before dropping; got:\n${lines.join("\n")}`);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(projRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Task 8 (D-T1.6): Monday sync archiving invariants — integration case.
// A row that was archived+synced BEFORE the migration converges its schema,
// then survives a Monday twoway pull round-trip without duplicating (no
// extra tasks_items row / pm_sync_state row) or resurrecting (archived_at
// stays set; nothing gets recreated remotely).
// ---------------------------------------------------------------------------
function stubFetchThrows() {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("fetch must not be called in this test"); };
  return () => { globalThis.fetch = original; };
}

test("0004 + Monday twoway pull: an archived+synced kanban row survives migration and a pull round-trip neither duplicates nor resurrects it", async () => {
  const f = fixture();
  const restoreFetch = stubFetchThrows();
  const ARCHIVE_PROJECT_ID = 99; // isolated from fixture()'s own seeded rows (project_id 1)
  try {
    // Pre-migration: a plain kanban card, no archived_at column yet.
    const t0 = new Database(f.tasksDbPath);
    const rowId = Number(
      t0.prepare("INSERT INTO tasks_items (title, status, project_id) VALUES (?,?,?)")
        .run("Migrated Archived Card", "in_progress", ARCHIVE_PROJECT_ID).lastInsertRowid
    );
    t0.close();

    const r = await runMigrations({ migrationsDir: DIR, dbPath: f.dbPath, tasksDbPath: f.tasksDbPath, log: () => {} });
    assert.ok(r.applied.includes("0004-track1-card-model"));

    // Post-migration: archive the card, then wire up sync bookkeeping
    // (pm_sync_state/pm_sync_log are bundle-owned — not created by init-db.js
    // or the migration; same hand-rolled pattern as tests/pm-monday-mirror
    // .test.js and tests/pm-monday-archive.test.js).
    const ARCHIVED_AT = "2026-08-10T00:00:00Z";
    const t1 = new Database(f.tasksDbPath);
    t1.prepare("UPDATE tasks_items SET archived_at = ? WHERE id = ?").run(ARCHIVED_AT, rowId);
    t1.close();

    const { createDbClient } = await import("../servers/db.js");
    const { syncTwowayBoard, contentHash } = await import("../bundles/pm-workspace/server/sync/monday.js");

    const BOARD_ID = "777";
    const localHash = contentHash({ title: "Migrated Archived Card", status: "in_progress" });
    const c = new Database(f.dbPath);
    c.exec(`
      CREATE TABLE pm_sync_state (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT, board_id TEXT, item_id TEXT, local_kind TEXT, local_id INTEGER,
        content_hash TEXT, monday_updated_at TEXT, last_synced_at TEXT,
        UNIQUE(board_id, item_id)
      );
      CREATE TABLE pm_sync_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_at TEXT DEFAULT (datetime('now')),
        direction TEXT, board_id TEXT, action TEXT, item_ref TEXT, detail TEXT, ok INTEGER
      );
    `);
    c.prepare(
      "INSERT INTO pm_sync_state (source, board_id, item_id, local_kind, local_id, content_hash, monday_updated_at) VALUES ('monday',?,?,?,?,?,?)"
    ).run(BOARD_ID, "monday-archived-1", "kanban", rowId, localHash, "2026-01-01T00:00:00Z");
    c.close();

    const cdb = createDbClient(f.dbPath);
    const tdb = createDbClient(f.tasksDbPath);
    const board = {
      board_id: BOARD_ID, mode: "twoway",
      target: { kind: "kanban", project_id: ARCHIVE_PROJECT_ID },
      column_map: {}, status_map: { "Working on it": "in_progress" }, status_column_id: "status_col",
    };
    const item = {
      id: "monday-archived-1", name: "Updated From Monday", updated_at: "2026-08-15T00:00:00Z",
      group: { id: "g1" }, column_values: [{ id: "status_col", text: "Working on it", value: null }],
    };

    const countRows = async () => Number((await tdb.execute({ sql: "SELECT COUNT(*) AS n FROM tasks_items", args: [] })).rows[0].n);
    const baseline = await countRows();

    const totals1 = { created: 0, updated: 0, pushed: 0, conflicts: 0, flagged: 0, errors: 0 };
    await syncTwowayBoard(cdb, tdb, board, [item], "test-token", totals1);
    assert.equal(totals1.updated, 1, "the pull updates the archived row in place");
    assert.equal(totals1.created, 0, "no resurrection: nothing new created locally or remotely");
    assert.equal(totals1.errors, 0);
    assert.equal(await countRows(), baseline, "no duplicate row from the pull");

    const card = (await tdb.execute({ sql: "SELECT title, archived_at FROM tasks_items WHERE id=?", args: [rowId] })).rows[0];
    assert.equal(card.title, "Updated From Monday", "updated in place");
    assert.equal(card.archived_at, ARCHIVED_AT, "stays archived through the pull");

    const logRows = (await cdb.execute({ sql: "SELECT action FROM pm_sync_log WHERE item_ref=?", args: ["Updated From Monday"] })).rows;
    assert.ok(logRows.some((row) => row.action === "pull_archived_update"), `expected pull_archived_update; got: ${JSON.stringify(logRows)}`);

    // Second identical pull: still no duplication, still no resurrection.
    const totals2 = { created: 0, updated: 0, pushed: 0, conflicts: 0, flagged: 0, errors: 0 };
    await syncTwowayBoard(cdb, tdb, board, [item], "test-token", totals2);
    assert.equal(totals2.created, 0);
    assert.equal(await countRows(), baseline, "still exactly one row for this card after a second pull");

    const stateCount = (await cdb.execute({ sql: "SELECT COUNT(*) AS n FROM pm_sync_state WHERE board_id=? AND item_id=?", args: [BOARD_ID, "monday-archived-1"] })).rows[0].n;
    assert.equal(Number(stateCount), 1, "still exactly one mapping row");

    await cdb.close();
    await tdb.close();
  } finally {
    restoreFetch();
    rmSync(f.root, { recursive: true, force: true });
  }
});
