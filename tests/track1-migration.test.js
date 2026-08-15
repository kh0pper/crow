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
