// tests/board-stages-migration.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";

const NODE = process.execPath;

function scratchDbs() {
  const dir = mkdtempSync(join(tmpdir(), "board-mig-"));
  const tasksDb = join(dir, "tasks.db");
  const crowDb = join(dir, "crow.db");
  const t = new Database(tasksDb);
  t.exec(`CREATE TABLE tasks_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
    description TEXT, status TEXT NOT NULL DEFAULT 'pending',
    priority INTEGER DEFAULT 3, due_date TEXT, owner TEXT, tags TEXT,
    parent_id INTEGER, project_id INTEGER, phase TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')), completed_at TEXT)`);
  t.close();
  const c = new Database(crowDb);
  c.exec(`CREATE TABLE project_spaces (id INTEGER PRIMARY KEY, name TEXT, slug TEXT,
    workspace_dir TEXT, tasks_db_uri TEXT, archived_at TEXT);
    CREATE TABLE bot_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT NOT NULL,
    card_id INTEGER, status TEXT NOT NULL DEFAULT 'active', control TEXT NOT NULL DEFAULT 'run',
    updated_at TEXT DEFAULT (datetime('now')))`);
  c.close();
  return { tasksDb, crowDb };
}

function cols(dbPath, table) {
  const d = new Database(dbPath);
  const names = d.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  d.close();
  return names;
}

function runMigration(env) {
  execFileSync(NODE, ["scripts/migrate-board-stages.mjs"], {
    env: { ...process.env, ...env }, encoding: "utf8",
  });
}

test("adds stage/assigned_bot/plan_ref + repo_path + kind, idempotently", () => {
  const { tasksDb, crowDb } = scratchDbs();
  const env = { CROW_TASKS_DB_PATH: tasksDb, CROW_DB_PATH: crowDb };
  runMigration(env);
  for (const c of ["stage", "assigned_bot", "plan_ref"]) assert.ok(cols(tasksDb, "tasks_items").includes(c), c);
  assert.ok(cols(crowDb, "project_spaces").includes("repo_path"));
  assert.ok(cols(crowDb, "bot_sessions").includes("kind"));
  runMigration(env); // second run must be a clean no-op
  assert.equal(cols(tasksDb, "tasks_items").filter((c) => c === "stage").length, 1);
});

test("tolerates absent tables (primary gateway)", () => {
  const dir = mkdtempSync(join(tmpdir(), "board-mig-empty-"));
  const tasksDb = join(dir, "tasks.db"); const crowDb = join(dir, "crow.db");
  new Database(tasksDb).close(); new Database(crowDb).close();
  runMigration({ CROW_TASKS_DB_PATH: tasksDb, CROW_DB_PATH: crowDb }); // must not throw
});
