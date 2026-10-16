/**
 * "Give to…" (queue item 20, PR 2; T6) — the two routes that put a card on a
 * bot's board, and optionally start it:
 *
 *   POST /dashboard/perch-api/cards/:id/give  {bot_id, start?, note?}
 *   POST /dashboard/perch-api/bots/:id/tasks  {title, start?, note?}
 *
 * Both live on routes/perch-interactive-api.js, which dashboard/index.js
 * mounts AFTER csrfMiddleware — so this harness mounts the router behind the
 * REAL csrfMiddleware (as index.js does) and a session-checking auth stub.
 * A fake interactive engine stands in for pi: no child is ever spawned.
 *
 * "Start right away" defaults OFF (Kevin, 2026-10-16): a give without
 * start:true assigns and never calls spawn. With start:true the SAME dispatch
 * core as POST /bots/:id/dispatch runs; a start that fails leaves the card
 * given and says why (started:false + code). One board_mutations row and one
 * card_given audit row per give.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const dir = mkdtempSync(join(tmpdir(), "perch-give-card-"));
process.env.CROW_DATA_DIR = dir;
process.env.CROW_HOME = join(dir, "home");
delete process.env.CROW_DB_PATH;
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
const DB_FILE = join(dir, "crow.db");
const TASKS = process.env.CROW_TASKS_DB_PATH;
const REPO = new URL("..", import.meta.url).pathname;

let server, base, _setEngineStatusForTest, engineImpl, calls, engineCalls = 0;
let PID, PID2, PID_ARCH;

const raw = () => new Database(DB_FILE);
const rawTasks = () => new Database(TASKS);

function seedBot(id, def, { enabled = 1, project = null } = {}) {
  const c = raw();
  c.prepare("INSERT OR REPLACE INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES (?,?,?,?,?)")
    .run(id, id[0].toUpperCase() + id.slice(1), JSON.stringify(def), enabled, project);
  c.close();
}

function seedCard({ title = "card", boardId = null, archivedAt = null, projectId = null, parentId = null, status = "pending" } = {}) {
  const t = rawTasks();
  const r = t.prepare("INSERT INTO tasks_items (title, board_id, archived_at, project_id, parent_id, status) VALUES (?,?,?,?,?,?)")
    .run(title, boardId, archivedAt, projectId, parentId, status);
  t.close();
  return Number(r.lastInsertRowid);
}
const card = (id) => { const t = rawTasks(); const r = t.prepare("SELECT * FROM tasks_items WHERE id=?").get(id); t.close(); return r; };
const mutations = (id) => { const t = rawTasks(); const r = t.prepare("SELECT * FROM board_mutations WHERE item_id=? ORDER BY id").all(id); t.close(); return r; };
const audits = (target) => { const c = raw(); const r = c.prepare("SELECT * FROM project_audit_log WHERE action='card_given' AND target=?").all(target); c.close(); return r; };

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: REPO });
  const c = raw();
  const mk = (slug, archived) => Number(c.prepare(
    "INSERT INTO project_spaces (slug, name, archived_at) VALUES (?,?,?)").run(slug, slug, archived).lastInsertRowid);
  PID = mk("helper-board", null);
  PID2 = mk("glassy-board", null);
  PID_ARCH = mk("old-board", "2026-01-01 00:00:00");
  c.close();

  const PERCH = { type: "perch" };
  seedBot("helper", { gateways: [PERCH], tracker_config: { type: "kanban" } }, { project: PID });
  seedBot("glassy", { gateways: [{ type: "glasses" }] }, { project: PID2 });
  seedBot("nob", { gateways: [PERCH], tracker_config: { type: "none" } });
  seedBot("noproj", { gateways: [PERCH] });
  seedBot("sleeper", { gateways: [PERCH] }, { enabled: 0, project: PID });
  seedBot("oldie", { gateways: [PERCH] }, { project: PID_ARCH });
  seedBot("tinker", { gateways: [PERCH], tracker_config: { type: "custom", tracker_slug: "t" } }, { project: PID });

  const t = rawTasks();
  t.exec(`CREATE TABLE tasks_items (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
    description TEXT, status TEXT NOT NULL DEFAULT 'pending', priority INTEGER DEFAULT 3,
    due_date TEXT, phase TEXT, owner TEXT, tags TEXT, parent_id INTEGER, project_id INTEGER,
    assigned_bot TEXT, board_id INTEGER, bot_id TEXT, action_needed TEXT, next_followup_date TEXT,
    processing_lease TEXT, processing_lease_status TEXT,
    autonomy TEXT NOT NULL DEFAULT 'gated', archived_at TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT, data_json TEXT NOT NULL DEFAULT '{}')`);
  t.exec(`CREATE TABLE board_mutations (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL,
    verb TEXT NOT NULL, actor_kind TEXT NOT NULL, actor_id TEXT, job_id TEXT,
    detail_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  // glassy's board (PID2) has its own vocabulary: "shipped" is terminal there.
  t.exec(`CREATE TABLE board_defs (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT, project_id INTEGER,
    display_name TEXT, status_values TEXT NOT NULL, terminal_values TEXT NOT NULL, fields_json TEXT NOT NULL DEFAULT '[]')`);
  t.prepare("INSERT INTO board_defs (project_id, display_name, status_values, terminal_values) VALUES (?,?,?,?)")
    .run(PID2, "Glassy", JSON.stringify(["pending", "doing", "shipped"]), JSON.stringify(["shipped"]));
  t.close();

  ({ _setEngineStatusForTest } = await import("../servers/gateway/dashboard/panels/bot-builder/engine-gate.js"));
  const { default: perchInteractiveApiRouter } = await import("../servers/gateway/routes/perch-interactive-api.js");
  const { csrfMiddleware } = await import("../servers/gateway/dashboard/shared/csrf.js");
  const { parseCookies } = await import("../servers/gateway/dashboard/auth.js");
  const { default: express } = await import("express");

  // Session gate stand-in: the real dashboardAuth also checks the network,
  // which a loopback test can never pass. Only a "good" session gets through.
  const auth = (req, res, next) => (parseCookies(req).crow_session === "good" ? next() : res.status(401).json({ error: "unauthorized" }));
  const app = express();
  app.use(express.json());
  const router = express.Router();
  router.use("/dashboard", csrfMiddleware);          // index.js order: CSRF first,
  router.use(perchInteractiveApiRouter(auth, {        // then the perch-api router
    engine: () => { engineCalls++; return engineImpl; },
    annotate: async (m) => m, providerModels: () => [], piProviders: () => null,
  }));
  app.use(router);
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = "http://127.0.0.1:" + server.address().port + "/dashboard/perch-api";
});

after(() => { _setEngineStatusForTest(null); if (server) server.close(); rmSync(dir, { recursive: true, force: true }); });

beforeEach(() => {
  engineCalls = 0;
  _setEngineStatusForTest({ state: "ready", source: "test", cliPath: "/nonexistent/pi" });
  calls = { spawn: [], message: [], checkCardFree: [] };
  engineImpl = {
    async checkCardFree(cardId) { calls.checkCardFree.push(cardId); },
    async spawn({ botId, cardId }) { calls.spawn.push({ botId, cardId }); return { sessionId: "perchlive-give", threadId: "perchlive-give", state: "awake" }; },
    async message(sid, text) { calls.message.push({ sid, text }); return { turnId: "t1" }; },
  };
});

const AUTHED = { cookie: "crow_session=good; crow_csrf=tok", "x-crow-csrf": "tok" };
async function post(path, body, headers = AUTHED) {
  const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}

// ---- the rails ----

test("no session: refused by the auth gate", async () => {
  const id = seedCard();
  const r = await post(`/cards/${id}/give`, { bot_id: "helper" }, {});
  assert.equal(r.status, 401);
  assert.equal(card(id).project_id, null);
});

test("a session without the CSRF echo: 403 from the real csrfMiddleware, nothing written", async () => {
  const id = seedCard();
  const r = await post(`/cards/${id}/give`, { bot_id: "helper" }, { cookie: "crow_session=good; crow_csrf=tok" });
  assert.equal(r.status, 403);
  assert.equal(card(id).project_id, null);
  const r2 = await post(`/bots/helper/tasks`, { title: "x" }, { cookie: "crow_session=good; crow_csrf=tok", "x-crow-csrf": "nope" });
  assert.equal(r2.status, 403);
});

test("an x-crow-signature header skips CSRF but authenticates nothing: still refused without a session", async () => {
  const id = seedCard();
  const r = await post(`/cards/${id}/give`, { bot_id: "helper" }, { "x-crow-signature": "deadbeef" });
  assert.equal(r.status, 401);
  assert.equal(card(id).project_id, null);
});

// ---- card + bot validation ----

test("unknown card 404, tracker item 400, archived 409", async () => {
  assert.equal((await post(`/cards/999999/give`, { bot_id: "helper" })).status, 404);
  const item = seedCard({ boardId: 3 });
  const r1 = await post(`/cards/${item}/give`, { bot_id: "helper" });
  assert.equal(r1.status, 400);
  const arch = seedCard({ archivedAt: "2026-01-01 00:00:00" });
  const r2 = await post(`/cards/${arch}/give`, { bot_id: "helper" });
  assert.equal(r2.status, 409);
  assert.equal(r2.body.error, "archived");
});

test("a card id that is not an integer, or no bot_id: 400 bad_request", async () => {
  assert.equal((await post(`/cards/abc/give`, { bot_id: "helper" })).status, 400);
  const id = seedCard();
  const r = await post(`/cards/${id}/give`, {});
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "bad_request");
});

test("a locked card (an active bridge session holds it — the board lock rail): 409 locked, unchanged", async () => {
  const id = seedCard();
  const c = raw();
  c.prepare("INSERT INTO bot_sessions (bot_id,gateway_type,gateway_thread_id,status,control,card_id) VALUES (?,?,?,?,?,?)")
    .run("helper", "gmail", "seed-lock-" + id, "active", "run", id);
  c.close();
  const r = await post(`/cards/${id}/give`, { bot_id: "helper" });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "locked");
  assert.equal(r.body.rail, "session");
  assert.equal(card(id).project_id, null);
});

test("a disabled or unknown bot: 400 bot_unavailable", async () => {
  const id = seedCard();
  for (const bot of ["sleeper", "ghost"]) {
    const r = await post(`/cards/${id}/give`, { bot_id: bot });
    assert.equal(r.status, 400, bot);
    assert.equal(r.body.error, "bot_unavailable");
  }
});

test("a bot with no board (none, no project, custom tracker, archived project): 409 no_board", async () => {
  const id = seedCard();
  for (const bot of ["nob", "noproj", "tinker", "oldie"]) {
    const r = await post(`/cards/${id}/give`, { bot_id: bot });
    assert.equal(r.status, 409, bot);
    assert.equal(r.body.error, "no_board", bot);
  }
  assert.equal(card(id).project_id, null);
  assert.equal(mutations(id).length, 0);
});

// ---- the give itself ----

test("give without start: on the bot's board, assigned, gated, ONE mutation, ONE audit row, no spawn", async () => {
  const id = seedCard({ title: "water the plants" });
  const r = await post(`/cards/${id}/give`, { bot_id: "helper" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, assigned: true, started: false, cardId: id });
  const row = card(id);
  assert.equal(row.project_id, PID);
  assert.equal(row.assigned_bot, "helper");
  assert.equal(row.autonomy, "gated");
  const m = mutations(id);
  assert.equal(m.length, 1);
  assert.equal(m[0].verb, "update");
  assert.deepEqual(JSON.parse(m[0].detail_json), { project_id: [null, PID], assigned_bot: [null, "helper"] });
  const a = audits(`card:${id}`);
  assert.equal(a.length, 1);
  assert.equal(a[0].project_id, PID);
  assert.deepEqual(JSON.parse(a[0].payload), { bot_id: "helper", start: false });
  assert.equal(calls.spawn.length, 0);
  assert.equal(calls.message.length, 0);
});

test("start:\"true\" (a string) is not start — only boolean true starts", async () => {
  const id = seedCard();
  const r = await post(`/cards/${id}/give`, { bot_id: "helper", start: "true" });
  assert.equal(r.body.started, false);
  assert.equal(calls.spawn.length, 0);
});

test("give with start, perch bot: the dispatch core spawns bound to the card and fires turn 1; still ONE mutation", async () => {
  const id = seedCard();
  const r = await post(`/cards/${id}/give`, { bot_id: "helper", start: true, note: "today please" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, assigned: true, started: true, cardId: id, sessionId: "perchlive-give" });
  assert.deepEqual(calls.checkCardFree, [id]);
  assert.deepEqual(calls.spawn, [{ botId: "helper", cardId: id }]);
  assert.deepEqual(calls.message, [{ sid: "perchlive-give", text: "today please" }]);
  assert.equal(mutations(id).length, 1, "the dispatch core's assigned_bot write is skipped — give already wrote it");
});

test("give with start, a bot with no Perch channel: given, not started, says why", async () => {
  const id = seedCard();
  const r = await post(`/cards/${id}/give`, { bot_id: "glassy", start: true });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, assigned: true, started: false, cardId: id, code: "perch_not_attached" });
  assert.equal(card(id).project_id, PID2);
  assert.equal(calls.spawn.length, 0);
});

test("give with start while the engine is not ready: given, started:false code engine_required", async () => {
  _setEngineStatusForTest({ state: "missing", source: "test" });
  const id = seedCard();
  const r = await post(`/cards/${id}/give`, { bot_id: "helper", start: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.started, false);
  assert.equal(r.body.code, "engine_required");
  assert.equal(card(id).assigned_bot, "helper");
});

test("give with start when spawn throws: given, started:false with the engine's code", async () => {
  engineImpl.spawn = async () => { throw Object.assign(new Error("full"), { code: "interactive_capacity" }); };
  const id = seedCard();
  const r = await post(`/cards/${id}/give`, { bot_id: "helper", start: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.started, false);
  assert.equal(r.body.code, "interactive_capacity");
  assert.equal(card(id).project_id, PID);
});

test("re-giving a card to another bot moves it to that bot's board", async () => {
  const id = seedCard({ projectId: PID });
  const r = await post(`/cards/${id}/give`, { bot_id: "glassy" });
  assert.equal(r.status, 200);
  assert.equal(card(id).project_id, PID2);
  assert.equal(card(id).assigned_bot, "glassy");
});

// ---- a new task straight onto a bot's board ----

test("POST /bots/:id/tasks creates the card on the bot's board, assigned, gated: ONE create mutation, ONE audit row", async () => {
  const r = await post(`/bots/helper/tasks`, { title: "  Book the vet  " });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.assigned, true);
  assert.equal(r.body.started, false);
  const id = r.body.cardId;
  const row = card(id);
  assert.equal(row.title, "Book the vet");
  assert.equal(row.project_id, PID);
  assert.equal(row.assigned_bot, "helper");
  assert.equal(row.autonomy, "gated");
  assert.equal(row.board_id, null);
  const m = mutations(id);
  assert.equal(m.length, 1);
  assert.equal(m[0].verb, "create");
  assert.equal(audits(`card:${id}`).length, 1);
  assert.equal(calls.spawn.length, 0);
});

test("POST /bots/:id/tasks with start:true starts it through the same core", async () => {
  const r = await post(`/bots/helper/tasks`, { title: "Plan the week", start: true });
  assert.equal(r.body.started, true);
  assert.deepEqual(calls.spawn, [{ botId: "helper", cardId: r.body.cardId }]);
  assert.deepEqual(calls.message, [{ sid: "perchlive-give", text: "" }], "no note: turn 1 carries the card brief alone");
  assert.equal(mutations(r.body.cardId).length, 1);
});

test("POST /bots/:id/tasks refuses a blank title (400) and a board-off bot (409 no_board), writing nothing", async () => {
  const before = rawTasks().prepare("SELECT COUNT(*) AS n FROM tasks_items").get().n;
  const r1 = await post(`/bots/helper/tasks`, { title: "   " });
  assert.equal(r1.status, 400);
  assert.equal(r1.body.error, "bad_request");
  const r2 = await post(`/bots/nob/tasks`, { title: "x" });
  assert.equal(r2.status, 409);
  assert.equal(r2.body.error, "no_board");
  const r3 = await post(`/bots/sleeper/tasks`, { title: "x" });
  assert.equal(r3.status, 400);
  assert.equal(r3.body.error, "bot_unavailable");
  assert.equal(rawTasks().prepare("SELECT COUNT(*) AS n FROM tasks_items").get().n, before);
});

// ---- subtasks and parents: a child always lives in its parent's project ----

test("a subtask cannot be given on its own: 400 bad_request, unchanged", async () => {
  const parent = seedCard({ title: "parent" });
  const child = seedCard({ title: "child", parentId: parent });
  const r = await post(`/cards/${child}/give`, { bot_id: "helper" });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "bad_request");
  assert.equal(card(child).project_id, null);
  assert.equal(mutations(child).length, 0);
  assert.equal(audits(`card:${child}`).length, 0);
});

test("giving a parent moves its live children (and theirs) to the same board; archived ones stay; ONE audit row with the count", async () => {
  const parent = seedCard({ title: "parent" });
  const kid1 = seedCard({ title: "kid1", parentId: parent });
  const kid2 = seedCard({ title: "kid2", parentId: parent, projectId: PID2 });
  const grandkid = seedCard({ title: "grandkid", parentId: kid1 });
  const gone = seedCard({ title: "gone", parentId: parent, archivedAt: "2026-01-01 00:00:00" });
  const r = await post(`/cards/${parent}/give`, { bot_id: "helper" });
  assert.equal(r.status, 200);
  assert.equal(card(parent).project_id, PID);
  for (const k of [kid1, kid2, grandkid]) {
    assert.equal(card(k).project_id, PID, "child " + k);
    const m = mutations(k);
    assert.equal(m.length, 1, "one update per child");
    assert.deepEqual(Object.keys(JSON.parse(m[0].detail_json)), ["project_id"], "only the project moves; a child is not assigned");
  }
  assert.equal(card(gone).project_id, null, "an archived child is left alone");
  assert.equal(mutations(gone).length, 0);
  const a = audits(`card:${parent}`);
  assert.equal(a.length, 1);
  assert.deepEqual(JSON.parse(a[0].payload), { bot_id: "helper", start: false, children: 3 });
  for (const k of [kid1, kid2, grandkid]) assert.equal(audits(`card:${k}`).length, 0, "audited once, for the parent");
});

// ---- a finished card is not given ----

test("a card in a terminal status (the default board's done/cancelled) is refused 409 finished, unchanged", async () => {
  for (const status of ["done", "cancelled"]) {
    const id = seedCard({ status });
    const r = await post(`/cards/${id}/give`, { bot_id: "helper" });
    assert.equal(r.status, 409, status);
    assert.equal(r.body.error, "finished", status);
    assert.equal(card(id).project_id, null);
    assert.equal(mutations(id).length, 0);
  }
});

test("terminal per the TARGET board's definition: 'shipped' on glassy's board is finished there", async () => {
  const id = seedCard({ status: "shipped" });
  const r = await post(`/cards/${id}/give`, { bot_id: "glassy" });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "finished");
  assert.equal(card(id).project_id, null);
  const ok = await post(`/cards/${seedCard({ status: "doing" })}/give`, { bot_id: "glassy" });
  assert.equal(ok.status, 200, "a non-terminal status on that board gives fine");
});

test("terminal on the card's CURRENT board counts too: a 'shipped' card on glassy's board is not re-given to helper", async () => {
  const id = seedCard({ status: "shipped", projectId: PID2 });
  const r = await post(`/cards/${id}/give`, { bot_id: "helper" });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "finished");
  assert.equal(card(id).project_id, PID2);
});

// ---- the engine singleton is resolved only once a start can actually run ----

test("give without start never resolves the engine, ready or not", async () => {
  await post(`/cards/${seedCard()}/give`, { bot_id: "helper" });
  _setEngineStatusForTest({ state: "missing", source: "test" });
  await post(`/cards/${seedCard()}/give`, { bot_id: "helper" });
  assert.equal(engineCalls, 0);
});

test("a start refused before spawn (engine not ready, no Perch channel) never resolves the engine", async () => {
  await post(`/cards/${seedCard()}/give`, { bot_id: "glassy", start: true });
  _setEngineStatusForTest({ state: "missing", source: "test" });
  await post(`/cards/${seedCard()}/give`, { bot_id: "helper", start: true });
  await post(`/bots/helper/tasks`, { title: "x", start: true });
  assert.equal(engineCalls, 0);
});

test("a refused dispatch (engine not ready / no Perch channel) never resolves the engine", async () => {
  const id = seedCard();
  const r1 = await post(`/bots/glassy/dispatch`, { card_id: id });
  assert.equal(r1.status, 403);
  _setEngineStatusForTest({ state: "missing", source: "test" });
  const r2 = await post(`/bots/helper/dispatch`, { card_id: id });
  assert.equal(r2.status, 409);
  assert.equal(engineCalls, 0);
  _setEngineStatusForTest({ state: "ready", source: "test", cliPath: "/nonexistent/pi" });
  const r3 = await post(`/bots/helper/dispatch`, { card_id: id });
  assert.equal(r3.status, 201);
  assert.equal(engineCalls, 1, "resolved once a dispatch can run");
});
