// tests/board-card-api.test.js
// Harness: scratch tasks.db + crow.db via env, ephemeral express server,
// plain fetch. dashboardAuth stub = pass-through (auth is not under test).
//
// Track 0 Phase A: status writes validate against the RESOLVED BOARD DEF
// (routes/board-defs.js) — project 7 carries a custom def; project 1 has no
// def row and exercises the builtin fallback (today's four statuses).
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
  // board_id is present (Track 0 Phase B merged the tracker-item id space into
  // this same table — F2's card-side by-id guards add `AND board_id IS NULL`
  // to every card endpoint, which SQLite errors on if the column is absent).
  // Every INSERT below omits it, so cards land NULL — the correct card shape.
  t.exec(`CREATE TABLE tasks_items (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
    description TEXT, status TEXT NOT NULL DEFAULT 'pending', priority INTEGER DEFAULT 3,
    due_date TEXT, owner TEXT, tags TEXT, parent_id INTEGER, project_id INTEGER,
    stage TEXT, assigned_bot TEXT, plan_ref TEXT, board_id INTEGER,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')), completed_at TEXT)`);
  t.prepare("INSERT INTO tasks_items (title, project_id) VALUES ('card one', 1)").run();
  t.exec(`CREATE TABLE board_defs (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE,
    project_id INTEGER UNIQUE, display_name TEXT NOT NULL, status_values TEXT NOT NULL,
    terminal_values TEXT NOT NULL, fields_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  t.prepare("INSERT INTO board_defs (project_id, display_name, status_values, terminal_values, fields_json) VALUES (7, 'Custom', ?, ?, ?)")
    .run('["todo","doing","shipped"]', '["shipped"]', '[{"key":"phase","label":"Phase","storage":"column"}]');
  t.prepare("INSERT INTO tasks_items (title, project_id, status) VALUES ('custom two', 7, 'todo')").run();
  t.prepare("INSERT INTO tasks_items (title, project_id, status) VALUES ('custom three', 7, 'todo')").run();
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

test("GET card returns the resolved board def; no stage, no effectiveStage", async () => {
  const r = await (await fetch(base + "/card/2")).json();
  assert.ok(!Object.hasOwn(r, "effectiveStage"), "effectiveStage retired");
  assert.ok(!Object.hasOwn(r.card, "stage"), "stage retired from the response");
  assert.ok(Object.hasOwn(r.card, "assigned_bot") && Object.hasOwn(r.card, "plan_ref"), "dormant columns still served");
  assert.deepEqual(r.board.status_values, ["todo", "doing", "shipped"]);
  assert.deepEqual(r.board.terminal_values, ["shipped"]);
  assert.equal(r.board.builtin, false);
  assert.equal(r.board.fields[0].key, "phase");
  assert.ok(Object.hasOwn(r.projects[0], "repo_path"));
  const b = await (await fetch(base + "/card/1")).json();
  assert.equal(b.board.builtin, true, "no def row → builtin fallback");
  assert.deepEqual(b.board.status_values, ["pending", "in_progress", "done", "cancelled"]);
});

test("move validates against the card's board def", async () => {
  const ok = await fetch(base + "/card/2/move", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "doing" }) });
  assert.equal(ok.status, 200);
  const bad = await fetch(base + "/card/2/move", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "done" }) });
  assert.equal(bad.status, 400, "a builtin status is off-list on this board");
});

test("terminal stamping follows the def: shipped stamps, back to doing clears", async () => {
  await fetch(base + "/card/2/move", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "shipped" }) });
  const t = new Database(process.env.CROW_TASKS_DB_PATH);
  assert.ok(t.prepare("SELECT completed_at FROM tasks_items WHERE id=2").get().completed_at, "custom terminal stamps completed_at");
  t.close();
  await fetch(base + "/card/2/move", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "doing" }) });
  const t2 = new Database(process.env.CROW_TASKS_DB_PATH);
  const row = t2.prepare("SELECT status, completed_at FROM tasks_items WHERE id=2").get();
  t2.close();
  assert.deepEqual([row.status, row.completed_at], ["doing", null]);
});

test("move by stage is gone: {stage:…} → 400", async () => {
  const r = await fetch(base + "/card/1/move", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ stage: "ready" }) });
  assert.equal(r.status, 400);
});

test("legacy move by status still works on a def-less board", async () => {
  const r = await fetch(base + "/card/1/move", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "in_progress" }) });
  assert.equal(r.status, 200);
  const bad = await fetch(base + "/card/1/move", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "bogus" }) });
  assert.equal(bad.status, 400);
});

test("edit validates status against the def too", async () => {
  const bad = await fetch(base + "/card/2", { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "custom two", status: "pending" }) });
  assert.equal(bad.status, 400, "'pending' is not on the custom board");
  const ok = await fetch(base + "/card/2", { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "custom two", status: "todo" }) });
  assert.equal(ok.status, 200);
});

test("card create lands on the board's first status when 'pending' is off the def", async () => {
  const r = await fetch(base + "/card", { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "new custom card", project_id: 7 }) });
  assert.equal(r.status, 200);
  const { id } = await r.json();
  const t = new Database(process.env.CROW_TASKS_DB_PATH);
  const row = t.prepare("SELECT status FROM tasks_items WHERE id=?").get(id);
  t.prepare("DELETE FROM tasks_items WHERE id=?").run(id);
  t.close();
  assert.equal(row.status, "todo", "the def's first status, not an off-def DEFAULT 'pending'");

  // builtin project keeps today's DEFAULT behavior
  const r2 = await fetch(base + "/card", { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "new legacy card", project_id: 1 }) });
  const { id: id2 } = await r2.json();
  const t2 = new Database(process.env.CROW_TASKS_DB_PATH);
  const row2 = t2.prepare("SELECT status FROM tasks_items WHERE id=?").get(id2);
  t2.prepare("DELETE FROM tasks_items WHERE id=?").run(id2);
  t2.close();
  assert.equal(row2.status, "pending");
});

test("board-def endpoints: GET resolves (builtin + custom), POST upserts through validateDefPayload", async () => {
  // GET custom
  const g = await (await fetch(base + "/board-def?project_id=7")).json();
  assert.equal(g.builtin, false);
  assert.deepEqual(g.status_values, ["todo", "doing", "shipped"]);
  // GET builtin fallback
  const gb = await (await fetch(base + "/board-def?project_id=1")).json();
  assert.equal(gb.builtin, true);

  // POST create for project 1 — the no-orphaning guard checks EXISTING cards,
  // so park card 1 on a status the new list keeps.
  const t0 = new Database(process.env.CROW_TASKS_DB_PATH);
  t0.prepare("UPDATE tasks_items SET status='open' WHERE id=1").run();
  t0.close();
  const create = await fetch(base + "/board-def", { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project_id: 1, display_name: "Proj One",
      status_values: ["open", "closed"], terminal_values: ["closed"], fields: [] }) });
  assert.equal(create.status, 200, JSON.stringify(await create.clone().json().catch(() => ({}))));
  const g2 = await (await fetch(base + "/board-def?project_id=1")).json();
  assert.equal(g2.builtin, false);
  assert.deepEqual(g2.status_values, ["open", "closed"]);

  // POST update (upsert, still one row)
  const update = await fetch(base + "/board-def", { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project_id: 1, display_name: "Proj One",
      status_values: ["open", "review", "closed"], terminal_values: ["closed"], fields: [] }) });
  assert.equal(update.status, 200);
  const t = new Database(process.env.CROW_TASKS_DB_PATH);
  assert.equal(t.prepare("SELECT COUNT(*) n FROM board_defs WHERE project_id=1").get().n, 1, "upsert");
  t.close();

  // Validation is validateDefPayload, not re-implemented: terminal ⊄ statuses → 400
  const bad = await fetch(base + "/board-def", { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project_id: 1, display_name: "X",
      status_values: ["a"], terminal_values: ["zz"], fields: [] }) });
  assert.equal(bad.status, 400);

  // Removing a status that still has cards → 400 with the count; def unchanged.
  // (card 1 currently carries a legacy status — put it on 'open' first.)
  const t2 = new Database(process.env.CROW_TASKS_DB_PATH);
  t2.prepare("UPDATE tasks_items SET status='open' WHERE id=1").run();
  t2.close();
  const strand = await fetch(base + "/board-def", { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project_id: 1, display_name: "Proj One",
      status_values: ["review", "closed"], terminal_values: ["closed"], fields: [] }) });
  assert.equal(strand.status, 400);
  assert.match(String((await strand.json()).error), /open.*1 card|1 card.*open|'open'/i);
  const g3 = await (await fetch(base + "/board-def?project_id=1")).json();
  assert.deepEqual(g3.status_values, ["open", "review", "closed"], "def unchanged after refusal");

  // restore card 1 to a builtin-def-compatible state for later tests
  const t3 = new Database(process.env.CROW_TASKS_DB_PATH);
  t3.prepare("UPDATE tasks_items SET status='pending' WHERE id=1").run();
  t3.prepare("DELETE FROM board_defs WHERE project_id=1").run();
  t3.close();
});

test("cancel on a board where 'cancelled' is NON-terminal does not stamp completed_at", async () => {
  const t = new Database(process.env.CROW_TASKS_DB_PATH);
  t.prepare("INSERT INTO board_defs (project_id, display_name, status_values, terminal_values) VALUES (11,'NT',?,?)")
    .run('["open","cancelled","archived"]', '["archived"]');
  t.prepare("INSERT INTO tasks_items (id, title, project_id, status) VALUES (40,'nt card',11,'open')").run();
  t.close();
  const ok = await fetch(base + "/card/40/cancel", { method: "POST" });
  assert.equal(ok.status, 200);
  const t2 = new Database(process.env.CROW_TASKS_DB_PATH);
  const row = t2.prepare("SELECT status, completed_at FROM tasks_items WHERE id=40").get();
  t2.prepare("DELETE FROM tasks_items WHERE id=40").run();
  t2.prepare("DELETE FROM board_defs WHERE project_id=11").run();
  t2.close();
  assert.equal(row.status, "cancelled");
  assert.equal(row.completed_at, null, "non-terminal cancel must not fabricate a completion timestamp");
});

test("cancel: 400 on a board without 'cancelled', works on the builtin board", async () => {
  const bad = await fetch(base + "/card/3/cancel", { method: "POST" });
  assert.equal(bad.status, 400);
  const ok = await fetch(base + "/card/1/cancel", { method: "POST" });
  assert.equal(ok.status, 200);
  const t = new Database(process.env.CROW_TASKS_DB_PATH);
  const row = t.prepare("SELECT status, completed_at FROM tasks_items WHERE id=1").get();
  t.close();
  assert.equal(row.status, "cancelled");
  assert.ok(row.completed_at);
  // restore card 1 for the plan/execute tests below
  const t2 = new Database(process.env.CROW_TASKS_DB_PATH);
  t2.prepare("UPDATE tasks_items SET status='pending', completed_at=NULL WHERE id=1").run();
  t2.close();
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

test("execute: refuses without assigned_bot, refuses terminal, dispatches and writes nothing", async () => {
  const t = new Database(process.env.CROW_TASKS_DB_PATH);
  t.prepare("UPDATE tasks_items SET status='pending', assigned_bot=NULL WHERE id=1").run();
  t.close();
  const noBot = await fetch(base + "/card/1/execute", { method: "POST" });
  assert.equal(noBot.status, 400);

  const t2 = new Database(process.env.CROW_TASKS_DB_PATH);
  t2.prepare("UPDATE tasks_items SET assigned_bot='scout', status='done' WHERE id=1").run();
  t2.close();
  const terminal = await fetch(base + "/card/1/execute", { method: "POST" });
  assert.equal(terminal.status, 409, "a terminal card is not dispatchable");

  const t3 = new Database(process.env.CROW_TASKS_DB_PATH);
  t3.prepare("UPDATE tasks_items SET status='pending' WHERE id=1").run();
  t3.close();
  const before = (() => {
    const d = new Database(process.env.CROW_TASKS_DB_PATH);
    const r = d.prepare("SELECT * FROM tasks_items WHERE id=1").get();
    d.close(); return r;
  })();
  // Dispatch enqueues a bot_jobs row (the route creates the table on first use
  // — this crow.db is seeded without it). Nothing spawns, so no DRYRUN seam is
  // needed or exists any more.
  const ok = await (await fetch(base + "/card/1/execute", { method: "POST" })).json();
  assert.equal(ok.ok, true);
  assert.equal(ok.dispatched, "scout");
  const c = new Database(process.env.CROW_DB_PATH);
  const job = c.prepare("SELECT bot_id, card_id, card_action, source, status FROM bot_jobs WHERE job_id=?").get(ok.jobId);
  c.close();
  assert.deepEqual(job, { bot_id: "scout", card_id: 1, card_action: "execute", source: "card", status: "queued" },
    "the dispatch's whole effect is this queued row");
  const t4 = new Database(process.env.CROW_TASKS_DB_PATH);
  const row = t4.prepare("SELECT * FROM tasks_items WHERE id=1").get();
  t4.close();
  assert.deepEqual(row, before, "dispatch writes nothing to the card");
});

test("plan-dispatch: gate matches execute; enqueues card_action='plan', card untouched", async () => {
  // Card 1 is the SAME card the execute test just dispatched, and its queued
  // job now locks the card on the job rail. Clear the rail first.
  const c = new Database(process.env.CROW_DB_PATH);
  c.prepare("DELETE FROM bot_jobs").run();
  c.close();
  const before = (() => {
    const d = new Database(process.env.CROW_TASKS_DB_PATH);
    const r = d.prepare("SELECT * FROM tasks_items WHERE id=1").get();
    d.close(); return r;
  })();
  const ok = await (await fetch(base + "/card/1/plan-dispatch", { method: "POST" })).json();
  assert.equal(ok.ok, true);
  const c2 = new Database(process.env.CROW_DB_PATH);
  assert.equal(c2.prepare("SELECT card_action FROM bot_jobs WHERE card_id=1").get().card_action, "plan");
  c2.close();
  const t3 = new Database(process.env.CROW_TASKS_DB_PATH);
  const row = t3.prepare("SELECT * FROM tasks_items WHERE id=1").get();
  t3.close();
  assert.deepEqual(row, before, "plan-dispatch writes nothing to the card");
});
