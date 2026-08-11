// tests/board-defs-migration.test.js
//
// Migration 0002-board-defs: creates board_defs and rebuilds tasks_items with
// DERIVED DDL — the status CHECK dropped, `stage` dropped, `data_json` added —
// preserving every other column and row byte-identical (the Track 0 data
// guarantee, executable). The fixture is r4-shaped: bundle DDL with the inline
// CHECK, plus the trailing stage/assigned_bot/plan_ref columns 0001 appended.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { run } from "../scripts/migrations/0002-board-defs.mjs";

const dir = mkdtempSync(join(tmpdir(), "board-defs-mig-"));
const TASKS = join(dir, "tasks.db");
const CROW = join(dir, "crow.db");

// The live bundle DDL (verified on r4 2026-08-11) + 0001's appended columns.
const LEGACY_DDL = `CREATE TABLE tasks_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','done','cancelled')),
      priority INTEGER NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
      due_date TEXT,
      phase TEXT,
      owner TEXT,
      tags TEXT,
      project_id INTEGER,
      parent_id INTEGER REFERENCES tasks_items(id) ON DELETE CASCADE,
      recurrence_id INTEGER REFERENCES tasks_recurrence(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    , stage TEXT, assigned_bot TEXT, plan_ref TEXT)`;

const INDEXES = [
  "CREATE INDEX idx_tasks_items_status ON tasks_items(status)",
  "CREATE INDEX idx_tasks_items_due ON tasks_items(due_date)",
  "CREATE INDEX idx_tasks_items_parent ON tasks_items(parent_id)",
  "CREATE INDEX idx_tasks_items_project ON tasks_items(project_id)",
  "CREATE INDEX idx_tasks_items_recurrence ON tasks_items(recurrence_id)",
];

const SURVIVING_COLS = [
  "id", "title", "description", "status", "priority", "due_date", "phase",
  "owner", "tags", "project_id", "parent_id", "recurrence_id",
  "created_at", "updated_at", "completed_at", "assigned_bot", "plan_ref",
];

let beforeRows;

before(() => {
  const t = new Database(TASKS);
  t.exec("CREATE TABLE tasks_recurrence (id INTEGER PRIMARY KEY AUTOINCREMENT, pattern TEXT)");
  t.exec(LEGACY_DDL);
  for (const ix of INDEXES) t.exec(ix);
  const ins = t.prepare(
    "INSERT INTO tasks_items (title, description, status, priority, due_date, phase, owner, tags, project_id, parent_id, stage, assigned_bot, plan_ref, completed_at) " +
    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
  );
  // project 7: phases in play (r4-shaped journal cards)
  ins.run("Parse HB2 file", "Box file id 123, two named traps, standing rule.", "pending", 2, "2026-09-01", "Drafting", "kevin", "kevin-gated", 7, null, null, null, null, null);
  ins.run("Toolkit ES copy", "long body ".repeat(80), "in_progress", 3, null, "Internal review", null, null, 7, null, null, null, null, null);
  ins.run("Ship November toolkit", null, "done", 1, null, "Final", null, null, 7, null, null, null, null, "2026-08-01 10:00:00");
  ins.run("Cancelled acceptance card", "carried the only stage value", "cancelled", 3, null, null, null, null, 7, null, "executing", "r4-assistant", null, "2026-08-07 21:00:00");
  ins.run("Subtask of #1", null, "pending", 3, null, "Drafting", null, null, 7, 1, null, null, null, null);
  // project 9: no phases anywhere
  ins.run("Plain card A", null, "pending", 3, null, null, null, null, 9, null, null, null, null, null);
  ins.run("Plain card B", null, "done", 4, null, null, null, null, 9, null, null, null, null, "2026-07-01 09:00:00");
  // no-project card (NULL project_id — must survive, seeds no def)
  ins.run("Loose note", null, "pending", 3, null, null, null, null, null, null, null, null, null, null);
  beforeRows = t.prepare(`SELECT ${SURVIVING_COLS.join(",")} FROM tasks_items ORDER BY id`).all();
  t.close();

  const c = new Database(CROW);
  c.exec("CREATE TABLE project_spaces (id INTEGER PRIMARY KEY, name TEXT, slug TEXT, archived_at TEXT)");
  c.prepare("INSERT INTO project_spaces (id, name, slug) VALUES (7, 'TEHCY R4', 'tehcy')").run();
  c.close();
});

function bakFiles() {
  return readdirSync(dir).filter((f) => f.startsWith("tasks.db.bak-0002-"));
}

test("run(): rebuild drops CHECK and stage, adds data_json, preserves rows", () => {
  const out = run({ dbPath: CROW, tasksDbPath: TASKS, log: () => {} });
  assert.ok(!out || !out.deferred, "must not defer when tasks_items exists");

  const t = new Database(TASKS);
  try {
    const sql = t.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks_items'").get().sql;
    assert.ok(!/CHECK\s*\(\s*status/i.test(sql), "status CHECK gone");
    assert.ok(/CHECK\s*\(\s*priority/i.test(sql), "priority CHECK kept");
    const cols = t.prepare("PRAGMA table_info(tasks_items)").all().map((c) => c.name);
    assert.ok(!cols.includes("stage"), "stage column gone");
    assert.ok(cols.includes("data_json"), "data_json added");
    assert.ok(cols.includes("assigned_bot") && cols.includes("plan_ref"), "dormant columns kept");

    // Row-for-row, column-for-column equality on every surviving column.
    const after = t.prepare(`SELECT ${SURVIVING_COLS.join(",")} FROM tasks_items ORDER BY id`).all();
    assert.deepEqual(after, beforeRows, "data guarantee");
    const dj = t.prepare("SELECT DISTINCT data_json FROM tasks_items").all();
    assert.deepEqual(dj, [{ data_json: "{}" }], "data_json seeded to {}");

    // A custom status is now insertable (the CHECK is really gone).
    t.prepare("INSERT INTO tasks_items (title, status) VALUES ('custom', 'tea_review')").run();
    t.prepare("DELETE FROM tasks_items WHERE title='custom'").run();

    // All five indexes recreated.
    const ix = t.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='tasks_items' AND sql IS NOT NULL ORDER BY name").all().map((r) => r.name);
    assert.deepEqual(ix, [
      "idx_tasks_items_due", "idx_tasks_items_parent", "idx_tasks_items_project",
      "idx_tasks_items_recurrence", "idx_tasks_items_status",
    ]);
  } finally { t.close(); }
});

test("board_defs seeded per project: four statuses, phase field only where phases exist", () => {
  const t = new Database(TASKS);
  try {
    const defs = t.prepare("SELECT project_id, display_name, status_values, terminal_values, fields_json FROM board_defs ORDER BY project_id").all();
    assert.equal(defs.length, 2, "one def per project with cards; none for NULL project");
    const [p7, p9] = defs;
    assert.equal(p7.project_id, 7);
    assert.equal(p7.display_name, "TEHCY R4", "name from crow.db project_spaces");
    assert.deepEqual(JSON.parse(p7.status_values), ["pending", "in_progress", "done", "cancelled"]);
    assert.deepEqual(JSON.parse(p7.terminal_values), ["done", "cancelled"]);
    const f7 = JSON.parse(p7.fields_json);
    assert.equal(f7.length, 1);
    assert.equal(f7[0].key, "phase");
    assert.equal(f7[0].storage, "column");
    assert.deepEqual(f7[0].options, ["Drafting", "Final", "Internal review"], "distinct phases, sorted");
    assert.equal(p9.project_id, 9);
    assert.equal(p9.display_name, "Project 9", "fallback name when crow.db has no row");
    assert.deepEqual(JSON.parse(p9.fields_json), [], "no phase field without phases");
  } finally { t.close(); }
});

test("sidecar backup exists and holds the OLD shape", () => {
  const baks = bakFiles();
  assert.equal(baks.length, 1);
  const b = new Database(join(dir, baks[0]), { readonly: true });
  try {
    const cols = b.prepare("PRAGMA table_info(tasks_items)").all().map((c) => c.name);
    assert.ok(cols.includes("stage"), "backup still has stage");
    const sql = b.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks_items'").get().sql;
    assert.ok(/CHECK\s*\(\s*status/i.test(sql), "backup still has the CHECK");
    assert.equal(b.prepare("SELECT count(*) n FROM tasks_items").get().n, beforeRows.length);
  } finally { b.close(); }
});

test("re-run: no second rebuild, no second backup, data still equal, defs untouched", () => {
  const t0 = new Database(TASKS);
  t0.prepare("UPDATE board_defs SET display_name='Edited by hand' WHERE project_id=7").run();
  t0.close();

  const out = run({ dbPath: CROW, tasksDbPath: TASKS, log: () => {} });
  assert.ok(!out || !out.deferred);
  assert.equal(bakFiles().length, 1, "idempotent — no second backup/rebuild");

  const t = new Database(TASKS);
  try {
    const after = t.prepare(`SELECT ${SURVIVING_COLS.join(",")} FROM tasks_items ORDER BY id`).all();
    assert.deepEqual(after, beforeRows);
    assert.equal(
      t.prepare("SELECT display_name FROM board_defs WHERE project_id=7").get().display_name,
      "Edited by hand", "INSERT OR IGNORE keeps operator edits"
    );
    assert.equal(t.prepare("SELECT count(*) n FROM board_defs").get().n, 2);
  } finally { t.close(); }
});

test("fresh dir with no tasks_items: {deferred:true}, board_defs still created", () => {
  const d2 = mkdtempSync(join(tmpdir(), "board-defs-mig-fresh-"));
  const t2 = join(d2, "tasks.db");
  const c2 = join(d2, "crow.db");
  new Database(t2).close(); // empty db file, no tables
  new Database(c2).close();
  const out = run({ dbPath: c2, tasksDbPath: t2, log: () => {} });
  assert.equal(out && out.deferred, true);
  const t = new Database(t2);
  try {
    assert.ok(t.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='board_defs'").get());
  } finally { t.close(); }
});
