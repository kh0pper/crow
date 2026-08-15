// tests/board-card-api.test.js
// Harness: scratch tasks.db + crow.db via env, ephemeral express server,
// plain fetch. dashboardAuth stub = pass-through (auth is not under test).
//
// Track 1 Task 4: the router now calls into the Task 2/3 services for the
// plan drawer, so a hand-built fixture 500s the moment any route touches
// board_plans/board_mutations/autonomy/archived_at. The fixture is
// migration-built instead — mark 0001-0003 done in bookkeeping, hand-seed a
// post-0003 shape, run the registry so 0004 executes for real (same pattern
// as tests/board-card-service.test.js's Task 2 fixture).
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
import { runMigrations } from "../scripts/migrations/runner.mjs";

const dir = mkdtempSync(join(tmpdir(), "board-api-"));
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
process.env.CROW_DB_PATH = join(dir, "crow.db");

const MIGRATIONS_DIR = join(import.meta.dirname, "..", "scripts", "migrations");

function markPriorDone(c) {
  c.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, sha TEXT)");
  for (const id of ["0001-board-stages", "0002-board-defs", "0003-tracker-convergence"]) {
    c.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, datetime('now'))").run(id);
  }
}

let trackerItemId; // an id-space guard fixture (board_id NOT NULL): a "wrong kind" id

// Seed BEFORE importing the router (module reads env at import time), then
// run the REAL 0004 migration so board_plans/board_mutations/autonomy/
// archived_at exist wherever the services expect them.
{
  const t = new Database(process.env.CROW_TASKS_DB_PATH);
  // The post-0003 shape (plan_ref present — 0004 drops it for real below).
  t.exec(`CREATE TABLE tasks_items (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
    description TEXT, status TEXT NOT NULL DEFAULT 'pending', priority INTEGER DEFAULT 3,
    due_date TEXT, phase TEXT, owner TEXT, tags TEXT, parent_id INTEGER, project_id INTEGER,
    assigned_bot TEXT, plan_ref TEXT, board_id INTEGER, bot_id TEXT, action_needed TEXT,
    next_followup_date TEXT, processing_lease TEXT, processing_lease_status TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT, data_json TEXT NOT NULL DEFAULT '{}')`);
  t.exec(`CREATE TABLE board_defs (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE,
    project_id INTEGER UNIQUE, display_name TEXT NOT NULL, status_values TEXT NOT NULL,
    terminal_values TEXT NOT NULL, fields_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  t.prepare("INSERT INTO tasks_items (title, project_id) VALUES ('card one', 1)").run(); // id=1
  t.prepare("INSERT INTO board_defs (project_id, display_name, status_values, terminal_values, fields_json) VALUES (7, 'Custom', ?, ?, ?)")
    .run('["todo","doing","shipped"]', '["shipped"]', '[{"key":"phase","label":"Phase","storage":"column"}]');
  t.prepare("INSERT INTO tasks_items (title, project_id, status) VALUES ('custom two', 7, 'todo')").run(); // id=2
  t.prepare("INSERT INTO tasks_items (title, project_id, status) VALUES ('custom three', 7, 'todo')").run(); // id=3
  // A tracker ITEM (board_id NOT NULL) — the "wrong kind" id for the
  // merged-id-space guard tests (D-T1.8).
  t.prepare("INSERT INTO board_defs (slug, display_name, status_values, terminal_values, fields_json) VALUES ('pir','PIR',?,?,?)")
    .run('["open","done"]', '["done"]', '[]');
  const pirBoardId = t.prepare("SELECT id FROM board_defs WHERE slug='pir'").get().id;
  const itemR = t.prepare("INSERT INTO tasks_items (board_id, title, status) VALUES (?, 'tracker item', 'open')").run(pirBoardId); // id=4
  trackerItemId = Number(itemR.lastInsertRowid);
  t.close();

  const c = new Database(process.env.CROW_DB_PATH);
  markPriorDone(c);
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

  await runMigrations({
    migrationsDir: MIGRATIONS_DIR, dbPath: process.env.CROW_DB_PATH,
    tasksDbPath: process.env.CROW_TASKS_DB_PATH, sha: "test", log: () => {},
  });
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

test("GET card returns the resolved board def; no stage, no effectiveStage, no plan_ref", async () => {
  const r = await (await fetch(base + "/card/2")).json();
  assert.ok(!Object.hasOwn(r, "effectiveStage"), "effectiveStage retired");
  assert.ok(!Object.hasOwn(r.card, "stage"), "stage retired from the response");
  assert.ok(Object.hasOwn(r.card, "assigned_bot"), "assigned_bot still served");
  assert.ok(!Object.hasOwn(r.card, "plan_ref"), "plan_ref retired from the response (D-T1.7)");
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

// ---- Track 1 Task 4: the plan drawer re-points to plan RECORDS (D-T1.4) ----

test("GET /card/:id/plan starts empty; POST appends draft v1; GET reflects it", async () => {
  const empty = await (await fetch(base + "/card/1/plan")).json();
  assert.deepEqual(empty, { versions: [], current: null });

  const save1 = await (await fetch(base + "/card/1/plan", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ body_md: "# v1 plan\n" }) })).json();
  assert.deepEqual(save1, { ok: true, version: 1 });

  const g1 = await (await fetch(base + "/card/1/plan")).json();
  assert.equal(g1.versions.length, 1);
  assert.equal(g1.versions[0].version, 1);
  assert.equal(g1.versions[0].status, "draft");
  assert.ok(g1.versions[0].created_at);
  assert.deepEqual(g1.current, { version: 1, body_md: "# v1 plan\n", status: "draft" });
});

test("plan approve marks the version approved; a newer draft does not displace it as current until IT is approved", async () => {
  const approve1 = await (await fetch(base + "/card/1/plan/approve", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ version: 1 }) })).json();
  assert.deepEqual(approve1, { ok: true });

  const afterApprove = await (await fetch(base + "/card/1/plan")).json();
  assert.equal(afterApprove.current.status, "approved");
  assert.equal(afterApprove.current.version, 1);

  const save2 = await (await fetch(base + "/card/1/plan", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ body_md: "# v2 plan\n" }) })).json();
  assert.deepEqual(save2, { ok: true, version: 2 });

  const stillV1 = await (await fetch(base + "/card/1/plan")).json();
  assert.equal(stillV1.current.version, 1, "an approved plan stays current until the newer draft is itself approved (D-T1.4)");
  assert.equal(stillV1.versions.length, 2);

  const approve2 = await fetch(base + "/card/1/plan/approve", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ version: 2 }) });
  assert.equal(approve2.status, 200);

  const nowV2 = await (await fetch(base + "/card/1/plan")).json();
  assert.equal(nowV2.current.version, 2);
  assert.equal(nowV2.current.status, "approved");
  const supersededV1 = nowV2.versions.find((v) => v.version === 1);
  assert.equal(supersededV1.status, "superseded");

  // Approving an already-superseded version is refused, not silently re-approved.
  const reapprove = await fetch(base + "/card/1/plan/approve", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ version: 1 }) });
  assert.equal(reapprove.status, 400);
});

test("plan approve: 400 on a missing/non-integer version, 404 on a version that does not exist", async () => {
  const badBody = await fetch(base + "/card/1/plan/approve", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
  assert.equal(badBody.status, 400);
  const notFound = await fetch(base + "/card/1/plan/approve", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ version: 999 }) });
  assert.equal(notFound.status, 404);
});

test("plan-dispatch route is retired (Track 1 / D-T1.7): 404", async () => {
  const r = await fetch(base + "/card/1/plan-dispatch", { method: "POST" });
  assert.equal(r.status, 404);
});

// ---- Track 1 Task 4: merged-id-space guards (D-T1.8) ----

test("id-space guards: a tracker-item id refuses /project, /execute, /force-unlock, /plan (GET+POST+approve)", async () => {
  const before = (() => {
    const d = new Database(process.env.CROW_TASKS_DB_PATH);
    const r = d.prepare("SELECT * FROM tasks_items WHERE id=?").get(trackerItemId);
    d.close();
    return r;
  })();

  // Each of these is a "card not found" refusal in THIS implementation
  // (board_id IS NULL guard, D-T1.8) — asserted precisely as 404 rather than
  // "400 or 404" so a dropped guard can't hide behind a coincidental 400
  // from some other validation (e.g. execute's "no assigned_bot" check).
  const proj = await fetch(base + "/card/" + trackerItemId + "/project", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ project_id: 1 }) });
  assert.equal(proj.status, 404, "project: " + proj.status);

  const exec = await fetch(base + "/card/" + trackerItemId + "/execute", { method: "POST" });
  assert.equal(exec.status, 404, "execute: " + exec.status);

  const unlock = await fetch(base + "/card/" + trackerItemId + "/force-unlock", { method: "POST" });
  assert.equal(unlock.status, 404, "force-unlock: " + unlock.status);

  const planGet = await fetch(base + "/card/" + trackerItemId + "/plan");
  assert.equal(planGet.status, 404, "plan GET: " + planGet.status);

  const planPost = await fetch(base + "/card/" + trackerItemId + "/plan", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ body_md: "hijack" }) });
  assert.equal(planPost.status, 404, "plan POST: " + planPost.status);

  const planApprove = await fetch(base + "/card/" + trackerItemId + "/plan/approve", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ version: 1 }) });
  assert.equal(planApprove.status, 404, "plan approve: " + planApprove.status);

  const after = (() => {
    const d = new Database(process.env.CROW_TASKS_DB_PATH);
    const r = d.prepare("SELECT * FROM tasks_items WHERE id=?").get(trackerItemId);
    d.close();
    return r;
  })();
  assert.deepEqual(after, before, "the tracker item must be byte-unchanged by every refused card-shaped call");
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
