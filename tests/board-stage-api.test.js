// tests/board-stage-api.test.js
// Harness: scratch tasks.db + crow.db via env, ephemeral express server,
// plain fetch. dashboardAuth stub = pass-through (auth is not under test).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

const dir = mkdtempSync(join(tmpdir(), "board-api-"));
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
process.env.CROW_DB_PATH = join(dir, "crow.db");

// Seed BEFORE importing the router (module reads env at import time).
{
  const t = new Database(process.env.CROW_TASKS_DB_PATH);
  t.exec(`CREATE TABLE tasks_items (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
    description TEXT, status TEXT NOT NULL DEFAULT 'pending', priority INTEGER DEFAULT 3,
    due_date TEXT, owner TEXT, tags TEXT, parent_id INTEGER, project_id INTEGER,
    stage TEXT, assigned_bot TEXT, plan_ref TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')), completed_at TEXT)`);
  t.prepare("INSERT INTO tasks_items (title, project_id) VALUES ('card one', 1)").run();
  t.close();
  const c = new Database(process.env.CROW_DB_PATH);
  c.exec(`CREATE TABLE project_spaces (id INTEGER PRIMARY KEY, name TEXT, slug TEXT,
      workspace_dir TEXT, tasks_db_uri TEXT, archived_at TEXT, repo_path TEXT);
    CREATE TABLE pi_bot_defs (bot_id TEXT PRIMARY KEY, display_name TEXT NOT NULL,
      definition TEXT, enabled INTEGER NOT NULL DEFAULT 1, project_id INTEGER);
    CREATE TABLE bot_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT NOT NULL,
      card_id INTEGER, status TEXT NOT NULL DEFAULT 'active', control TEXT NOT NULL DEFAULT 'run',
      pi_session_dir TEXT, kind TEXT NOT NULL DEFAULT 'chat', updated_at TEXT DEFAULT (datetime('now')))`);
  c.prepare("INSERT INTO project_spaces (id, name, slug, repo_path) VALUES (1, 'proj', 'proj', NULL)").run();
  c.prepare("INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES ('scout', 'Scout', '{}', 1, 1)").run();
  c.close();
}

let server, base;
before(async () => {
  const { default: express } = await import("express");
  const { default: botBoardApiRouter } = await import("../servers/gateway/routes/bot-board-api.js");
  const app = express();
  app.use(express.json());
  app.use(botBoardApiRouter((req, res, next) => next())); // auth stub
  await new Promise((r) => { server = app.listen(0, r); });
  base = "http://127.0.0.1:" + server.address().port + "/dashboard/bot-board-api";
});
after(() => server && server.close());

test("GET card returns stage columns + effectiveStage (legacy null stage, no plan → backlog)", async () => {
  const r = await (await fetch(base + "/card/1")).json();
  assert.equal(r.card.stage, null);
  assert.equal(r.effectiveStage, "backlog");
  assert.ok(Object.hasOwn(r.card, "assigned_bot") && Object.hasOwn(r.card, "plan_ref"));
  assert.ok(Object.hasOwn(r.projects[0], "repo_path"));
});

test("move by stage writes stage AND projected status atomically", async () => {
  const r = await fetch(base + "/card/1/move", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ stage: "executing" }) });
  assert.equal(r.status, 200);
  const t = new Database(process.env.CROW_TASKS_DB_PATH);
  const row = t.prepare("SELECT stage, status, completed_at FROM tasks_items WHERE id=1").get();
  t.close();
  assert.equal(row.stage, "executing");
  assert.equal(row.status, "in_progress");
  assert.equal(row.completed_at, null);
});

test("move to done sets completed_at; back out clears it; bad stage 400s", async () => {
  await fetch(base + "/card/1/move", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ stage: "done" }) });
  const t = new Database(process.env.CROW_TASKS_DB_PATH);
  assert.ok(t.prepare("SELECT completed_at FROM tasks_items WHERE id=1").get().completed_at);
  t.close();
  await fetch(base + "/card/1/move", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ stage: "ready" }) });
  const t2 = new Database(process.env.CROW_TASKS_DB_PATH);
  const row = t2.prepare("SELECT stage, status, completed_at FROM tasks_items WHERE id=1").get();
  t2.close();
  assert.deepEqual([row.stage, row.status, row.completed_at], ["ready", "pending", null]);
  const bad = await fetch(base + "/card/1/move", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ stage: "bogus" }) });
  assert.equal(bad.status, 400);
});

test("legacy move by status still works unchanged", async () => {
  const r = await fetch(base + "/card/1/move", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "in_progress" }) });
  assert.equal(r.status, 200);
});

test("assigned_bot: set to known bot OK, unknown 400, clear OK", async () => {
  const ok = await fetch(base + "/card/1", { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "card one", assigned_bot: "scout" }) });
  assert.equal(ok.status, 200);
  const bad = await fetch(base + "/card/1", { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "card one", assigned_bot: "nope" }) });
  assert.equal(bad.status, 400);
  const clear = await fetch(base + "/card/1", { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "card one", assigned_bot: "" }) });
  assert.equal(clear.status, 200);
});

test("plan GET/POST honors a repo plan_ref, contained under repo_path", async () => {
  const { mkdtempSync: mkd, mkdirSync: mkdir, writeFileSync: wf } = await import("node:fs");
  const repo = mkd(join(tmpdir(), "board-repo-"));
  mkdir(join(repo, ".pi", "plans"), { recursive: true });
  wf(join(repo, ".pi", "plans", "card-1.md"), "# the plan\n");
  const c = new Database(process.env.CROW_DB_PATH);
  c.prepare("UPDATE project_spaces SET repo_path=? WHERE id=1").run(repo);
  c.close();
  const t = new Database(process.env.CROW_TASKS_DB_PATH);
  t.prepare("UPDATE tasks_items SET plan_ref=? WHERE id=1")
    .run(JSON.stringify({ kind: "repo", path: ".pi/plans/card-1.md" }));
  t.close();
  const g = await (await fetch(base + "/card/1/plan")).json();
  assert.equal(g.exists, true);
  assert.equal(g.kind, "repo");
  assert.equal(g.markdown, "# the plan\n");
  const p = await fetch(base + "/card/1/plan", { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ markdown: "# edited\n", mtime: g.mtime }) });
  assert.equal(p.status, 200);
});

test("repo plan_ref with no repo_path on the project → 400, never a fallback", async () => {
  const c = new Database(process.env.CROW_DB_PATH);
  c.prepare("UPDATE project_spaces SET repo_path=NULL WHERE id=1").run();
  c.close();
  const g = await fetch(base + "/card/1/plan");
  assert.equal(g.status, 400);
  const t = new Database(process.env.CROW_TASKS_DB_PATH); // restore for later tests
  t.prepare("UPDATE tasks_items SET plan_ref=NULL WHERE id=1").run();
  t.close();
});

test("first plan save into a repo with NO .pi/plans tree creates it (contained)", async () => {
  const { mkdtempSync: mkd } = await import("node:fs");
  const repo = mkd(join(tmpdir(), "board-repo-bare-"));
  const c = new Database(process.env.CROW_DB_PATH);
  c.prepare("UPDATE project_spaces SET repo_path=? WHERE id=1").run(repo);
  c.close();
  const t = new Database(process.env.CROW_TASKS_DB_PATH);
  t.prepare("UPDATE tasks_items SET plan_ref=? WHERE id=1")
    .run(JSON.stringify({ kind: "repo", path: ".pi/plans/first.md" }));
  t.close();
  const p = await fetch(base + "/card/1/plan", { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ markdown: "# first plan\n" }) });
  assert.equal(p.status, 200);
  const g = await (await fetch(base + "/card/1/plan")).json();
  assert.equal(g.markdown, "# first plan\n");
  const t2 = new Database(process.env.CROW_TASKS_DB_PATH); // restore for any later tests
  t2.prepare("UPDATE tasks_items SET plan_ref=NULL WHERE id=1").run();
  t2.close();
});

test("execute: refuses without assigned_bot, refuses when not Ready, dispatches when Ready", async () => {
  const t = new Database(process.env.CROW_TASKS_DB_PATH);
  t.prepare("UPDATE tasks_items SET stage='ready', status='pending', assigned_bot=NULL WHERE id=1").run();
  t.close();
  const noBot = await fetch(base + "/card/1/execute", { method: "POST" });
  assert.equal(noBot.status, 400);

  const t2 = new Database(process.env.CROW_TASKS_DB_PATH);
  t2.prepare("UPDATE tasks_items SET assigned_bot='scout', stage='backlog', status='pending' WHERE id=1").run();
  t2.close();
  const notReady = await fetch(base + "/card/1/execute", { method: "POST" });
  assert.equal(notReady.status, 409);

  const t3 = new Database(process.env.CROW_TASKS_DB_PATH);
  t3.prepare("UPDATE tasks_items SET stage='ready' WHERE id=1").run();
  t3.close();
  process.env.CROW_BOARD_DISPATCH_DRYRUN = "1"; // test seam: skip the real spawn
  const ok = await (await fetch(base + "/card/1/execute", { method: "POST" })).json();
  delete process.env.CROW_BOARD_DISPATCH_DRYRUN;
  assert.equal(ok.ok, true);
  assert.equal(ok.dispatched, "scout");
  const t4 = new Database(process.env.CROW_TASKS_DB_PATH);
  const row = t4.prepare("SELECT stage, status FROM tasks_items WHERE id=1").get();
  t4.close();
  assert.deepEqual([row.stage, row.status], ["executing", "in_progress"]);
});
