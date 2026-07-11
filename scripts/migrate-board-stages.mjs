// scripts/migrate-board-stages.mjs
// Board–plan unification Plan 1 Task 1: guarded ALTERs (init-pi-bots.mjs
// pattern — PRAGMA presence check, additive, idempotent, absent-table
// tolerant). Run on deploy, both instances. SQLite ADD COLUMN never rebuilds
// the table, so existing CHECK constraints are unaffected.
import Database from "better-sqlite3";
import { tasksDbPath, botsDbPath } from "./pi-bots/instance-paths.mjs";

function addColumnIfMissing(db, table, column, ddl) {
  const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
  if (!t) return "skip (" + table + " absent)";
  const have = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (have.includes(column)) return "no-op";
  db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`).run();
  return "added";
}

function open(p) { const d = new Database(p); d.pragma("busy_timeout = 10000"); return d; }

const out = [];
{
  const tdb = open(tasksDbPath());
  out.push(["tasks_items.stage", addColumnIfMissing(tdb, "tasks_items", "stage", "TEXT")]);
  out.push(["tasks_items.assigned_bot", addColumnIfMissing(tdb, "tasks_items", "assigned_bot", "TEXT")]);
  out.push(["tasks_items.plan_ref", addColumnIfMissing(tdb, "tasks_items", "plan_ref", "TEXT")]);
  tdb.close();
}
{
  const cdb = open(botsDbPath());
  out.push(["project_spaces.repo_path", addColumnIfMissing(cdb, "project_spaces", "repo_path", "TEXT")]);
  out.push(["bot_sessions.kind", addColumnIfMissing(cdb, "bot_sessions", "kind", "TEXT NOT NULL DEFAULT 'chat'")]);
  cdb.close();
}
for (const [what, r] of out) console.log("  " + what + ": " + r);
