// tests/tracker-convergence-migration.test.js
//
// Phase B: tracker_defs/tracker_items (crow.db) → board_defs/tasks_items
// (tasks.db). The fixture mirrors live r4 at 2026-08-11: 3 defs, 18 items,
// pm_sync_state rows of BOTH kinds — the kanban rows must survive untouched
// (they key on card ids, which is why 0003 may never rebuild tasks_items).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "../scripts/migrations/runner.mjs";

const DIR = join(import.meta.dirname, "..", "scripts", "migrations");

// Every fixture pre-records 0001/0002 in schema_migrations. Without this, the
// whole-directory run re-executes them against the already-converged shape:
// 0001 re-adds `stage`, and 0002's rebuild then appends a DUPLICATE data_json
// column and throws (deriveNewDdl is unconditional, 0002-board-defs.mjs:72).
// Real instances are protected by their bookkeeping rows; fixtures must be too.
// DO NOT "fix" 0002 if you hit this — fix the fixture.
function markPhaseADone(c) {
  c.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, sha TEXT)");
  c.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES ('0001-board-stages', datetime('now'))").run();
  c.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES ('0002-board-defs', datetime('now'))").run();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "trkconv-"));
  const dbPath = join(root, "crow.db");
  const tasksDbPath = join(root, "tasks.db");
  const c = new Database(dbPath);
  markPhaseADone(c);
  c.exec(`CREATE TABLE project_spaces (id INTEGER PRIMARY KEY, name TEXT, tasks_db_uri TEXT);
    CREATE TABLE bot_sessions (id INTEGER PRIMARY KEY);
    CREATE TABLE tracker_defs (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL, columns_json TEXT NOT NULL, status_values TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE tracker_items (id INTEGER PRIMARY KEY AUTOINCREMENT,
      tracker_id INTEGER NOT NULL REFERENCES tracker_defs(id), bot_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending', priority INTEGER DEFAULT 3, label TEXT NOT NULL,
      data_json TEXT NOT NULL DEFAULT '{}', action_needed TEXT, next_followup_date TEXT,
      processing_lease TEXT, processing_lease_status TEXT,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE pm_sync_state (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT, board_id TEXT,
      item_id TEXT, local_kind TEXT, local_id INTEGER, content_hash TEXT,
      monday_updated_at TEXT, last_synced_at TEXT, UNIQUE(board_id, item_id));`);
  c.prepare("INSERT INTO tracker_defs (slug, display_name, columns_json, status_values) VALUES (?,?,?,?)")
    .run("toolkit-assets", "Toolkit Assets",
      JSON.stringify([{ key: "asset_type", label: "Type", type: "text", required: true }]),
      JSON.stringify(["planned", "drafting", "drafted"]));
  c.prepare("INSERT INTO tracker_defs (slug, display_name, columns_json, status_values) VALUES (?,?,?,?)")
    .run("comms-log", "Communications Log",
      JSON.stringify([{ key: "contact", label: "Contact", type: "text" }]),
      JSON.stringify(["open", "waiting", "done"]));
  const insItem = c.prepare(`INSERT INTO tracker_items
    (tracker_id, bot_id, status, priority, label, data_json, action_needed, processing_lease_status)
    VALUES (?,?,?,?,?,?,?,?)`);
  insItem.run(1, null, "drafted", 2, "Poster EN", '{"asset_type":"poster"}', null, null);
  insItem.run(1, "scout", "drafting", 3, "Flyer ES", '{"asset_type":"flyer"}', "needs review", "in-progress");
  // pm_sync_state: one tracker row pointing at item 2, one kanban row that must not move
  c.prepare("INSERT INTO pm_sync_state (source, board_id, item_id, local_kind, local_id) VALUES ('monday','B','I1','tracker',2)").run();
  c.prepare("INSERT INTO pm_sync_state (source, board_id, item_id, local_kind, local_id) VALUES ('monday','B','I2','kanban',7)").run();
  c.close();
  const t = new Database(tasksDbPath);
  // converged Phase A shape (no CHECK, no stage, data_json present) + one real card
  t.exec(`CREATE TABLE tasks_items (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
    description TEXT, status TEXT NOT NULL DEFAULT 'pending', priority INTEGER DEFAULT 3,
    due_date TEXT, phase TEXT, owner TEXT, tags TEXT, parent_id INTEGER, project_id INTEGER,
    assigned_bot TEXT, plan_ref TEXT, created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')), completed_at TEXT, data_json TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE board_defs (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE,
      project_id INTEGER UNIQUE, display_name TEXT NOT NULL, status_values TEXT NOT NULL,
      terminal_values TEXT NOT NULL, fields_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  t.prepare("INSERT INTO tasks_items (id, title, project_id, status) VALUES (7,'existing card',1,'pending')").run();
  t.close();
  return { root, dbPath, tasksDbPath };
}

test("0003 moves defs+items, remaps pm_sync_state, drops crow tables — cards untouched", async () => {
  const f = fixture();
  try {
    const r = await runMigrations({ migrationsDir: DIR, dbPath: f.dbPath, tasksDbPath: f.tasksDbPath });
    assert.ok(r.applied.includes("0003-tracker-convergence"));

    const t = new Database(f.tasksDbPath);
    const cols = t.prepare("PRAGMA table_info(tasks_items)").all().map((x) => x.name);
    for (const col of ["board_id", "bot_id", "action_needed", "next_followup_date", "processing_lease", "processing_lease_status"]) {
      assert.ok(cols.includes(col), `tasks_items.${col} must exist`);
    }
    // card #7 byte-identical (same id, same row — no rebuild happened)
    const card = t.prepare("SELECT id, title, status, board_id FROM tasks_items WHERE id=7").get();
    assert.deepEqual(card, { id: 7, title: "existing card", status: "pending", board_id: null });

    // defs moved with terminal seeding + fields mapping
    const defs = t.prepare("SELECT slug, status_values, terminal_values, fields_json FROM board_defs WHERE slug IS NOT NULL ORDER BY slug").all();
    assert.equal(defs.length, 2);
    const toolkit = defs.find((d) => d.slug === "toolkit-assets");
    assert.equal(toolkit.terminal_values, "[]", "no 'done' in list → empty terminals");
    // spread-preserve: `type` (and any future entry key) MUST survive — the
    // client renders json-typed fields differently and the source is dropped
    assert.deepEqual(JSON.parse(toolkit.fields_json),
      [{ key: "asset_type", label: "Type", type: "text", required: true, storage: "data" }]);
    const comms = defs.find((d) => d.slug === "comms-log");
    assert.equal(comms.terminal_values, '["done"]');

    // items moved: label→title, data/lease verbatim, board_id set, NEW ids (≠7)
    const boardId = t.prepare("SELECT id FROM board_defs WHERE slug='toolkit-assets'").get().id;
    const items = t.prepare("SELECT id, title, status, priority, data_json, action_needed, processing_lease_status, bot_id FROM tasks_items WHERE board_id=? ORDER BY title").all(boardId);
    assert.equal(items.length, 2);
    const flyer = items.find((i) => i.title === "Flyer ES");
    assert.equal(flyer.status, "drafting");
    assert.equal(flyer.data_json, '{"asset_type":"flyer"}');
    assert.equal(flyer.action_needed, "needs review");
    assert.equal(flyer.processing_lease_status, "in-progress");
    assert.equal(flyer.bot_id, "scout");
    assert.notEqual(flyer.id, 7);
    t.close();

    const c = new Database(f.dbPath);
    // crow tables dropped
    assert.equal(c.prepare("SELECT name FROM sqlite_master WHERE name IN ('tracker_defs','tracker_items')").all().length, 0);
    // tracker sync-state row remapped to the flyer's NEW id; kanban row untouched
    assert.equal(c.prepare("SELECT local_id FROM pm_sync_state WHERE local_kind='tracker'").get().local_id, flyer.id);
    assert.equal(c.prepare("SELECT local_id FROM pm_sync_state WHERE local_kind='kanban'").get().local_id, 7);
    c.close();
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("0003 re-run after a partial copy converges without duplicates", async () => {
  const f = fixture();
  try {
    // simulate a crashed first run: def row + ONE of the two items already copied
    const t = new Database(f.tasksDbPath);
    t.exec("ALTER TABLE tasks_items ADD COLUMN board_id INTEGER");
    t.prepare("INSERT INTO board_defs (slug, display_name, status_values, terminal_values, fields_json) VALUES ('toolkit-assets','Toolkit Assets','[\"planned\",\"drafting\",\"drafted\"]','[]','[]')").run();
    const bid = t.prepare("SELECT id FROM board_defs WHERE slug='toolkit-assets'").get().id;
    t.prepare("INSERT INTO tasks_items (title, status, board_id) VALUES ('Poster EN','drafted',?)").run(bid);
    t.close();

    await runMigrations({ migrationsDir: DIR, dbPath: f.dbPath, tasksDbPath: f.tasksDbPath });

    const t2 = new Database(f.tasksDbPath);
    const n = t2.prepare("SELECT COUNT(*) AS n FROM tasks_items WHERE board_id=?").get(bid).n;
    t2.close();
    assert.equal(n, 2, "DELETE+recopy must leave exactly the tracker's items — no dupes, no strays");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("pm_sync_state remap is chain-safe when new ids overlap old ids", async () => {
  // Small stores overlap. Fixture ids: cards up to 7 (AUTOINCREMENT), tracker
  // items with OLD ids 1 (Poster), 2 (Flyer), 8 (high-id) → copy in old-id
  // order lands NEW ids 8, 9, 10, so idMap = {1→8, 2→9, 8→10}. The chain: a
  // sync row at local_id=1 is set to 8 by the (1→8) entry, and a SINGLE-PASS
  // remap then re-matches it with the (8→10) entry and drags it to 10 — where
  // it collides with the row that legitimately belongs there. The two-phase
  // remap (negate, then flip) is what this test proves.
  const f = fixture();
  try {
    const c = new Database(f.dbPath);
    c.prepare("INSERT INTO tracker_items (id, tracker_id, status, priority, label) VALUES (8, 1, 'planned', 3, 'high-id item')").run();
    c.prepare("INSERT INTO pm_sync_state (source, board_id, item_id, local_kind, local_id) VALUES ('monday','B','I0','tracker',1)").run();
    c.prepare("INSERT INTO pm_sync_state (source, board_id, item_id, local_kind, local_id) VALUES ('monday','B','I8','tracker',8)").run();
    c.close();

    await runMigrations({ migrationsDir: DIR, dbPath: f.dbPath, tasksDbPath: f.tasksDbPath });

    const t = new Database(f.tasksDbPath);
    const poster = t.prepare("SELECT id FROM tasks_items WHERE title='Poster EN'").get();
    const highId = t.prepare("SELECT id FROM tasks_items WHERE title='high-id item'").get();
    t.close();
    assert.notEqual(poster.id, highId.id);
    const c2 = new Database(f.dbPath);
    assert.equal(c2.prepare("SELECT local_id FROM pm_sync_state WHERE item_id='I0'").get().local_id, poster.id,
      "the old-id-1 row lands on Poster's new id (8) and must NOT be dragged to 10 by the (8→10) entry");
    assert.equal(c2.prepare("SELECT local_id FROM pm_sync_state WHERE item_id='I8'").get().local_id, highId.id);
    c2.close();
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("0003 with no tracker tables applies as a column-only no-op; absent tasks_items defers", async () => {
  // (a) fresh install: crow.db has no tracker tables → applied, columns exist
  const root = mkdtempSync(join(tmpdir(), "trkconv-fresh-"));
  try {
    const dbPath = join(root, "crow.db"); const tasksDbPath = join(root, "tasks.db");
    const c = new Database(dbPath);
    markPhaseADone(c);
    c.exec("CREATE TABLE project_spaces (id INTEGER PRIMARY KEY); CREATE TABLE bot_sessions (id INTEGER PRIMARY KEY)");
    c.close();
    const t = new Database(tasksDbPath);
    t.exec("CREATE TABLE tasks_items (id INTEGER PRIMARY KEY, title TEXT, status TEXT DEFAULT 'pending', phase TEXT, project_id INTEGER, data_json TEXT NOT NULL DEFAULT '{}')");
    t.close();
    const r = await runMigrations({ migrationsDir: DIR, dbPath, tasksDbPath });
    assert.ok(r.applied.includes("0003-tracker-convergence"), "no tracker tables → recorded, not deferred (they are never created later)");
    const t2 = new Database(tasksDbPath);
    assert.ok(t2.prepare("PRAGMA table_info(tasks_items)").all().map((x) => x.name).includes("board_id"));
    t2.close();
  } finally { rmSync(root, { recursive: true, force: true }); }

  // (b) tasks bundle not started: tasks_items absent → deferred (0002 precedent)
  const root2 = mkdtempSync(join(tmpdir(), "trkconv-defer-"));
  try {
    const dbPath = join(root2, "crow.db"); const tasksDbPath = join(root2, "tasks.db");
    const c = new Database(dbPath);
    markPhaseADone(c);
    c.exec("CREATE TABLE project_spaces (id INTEGER PRIMARY KEY); CREATE TABLE bot_sessions (id INTEGER PRIMARY KEY)");
    c.close();
    new Database(tasksDbPath).close();
    const r = await runMigrations({ migrationsDir: DIR, dbPath, tasksDbPath });
    assert.ok(r.deferred.includes("0003-tracker-convergence"));
    assert.ok(!r.applied.includes("0003-tracker-convergence"));
  } finally { rmSync(root2, { recursive: true, force: true }); }
});
