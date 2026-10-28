/**
 * Redesign P5 Task 5.4: review a card from the Perch chat.
 *
 *   GET  /dashboard/perch-api/interactive/:sid/card       {card, result, decisions}
 *   POST /dashboard/perch-api/cards/:id/accept            {result_id, accept_failure?}
 *   POST /dashboard/perch-api/cards/:id/request-change    {result_id, text}
 *   POST /dashboard/bot-board-api/card/:id/decision       #535's answer route (chips post here)
 *   POST /dashboard/bot-board-api/card/:id/result/:rid/decide   optional seen_result_id (R-P5-5)
 *
 * Harness: an init-db'd scratch crow.db and a scratch tasks.db brought through migrations
 * 0001-0004 (shell-board-move-routes' idiom), both routers behind the REAL csrfMiddleware and a
 * session stub. Decisions are asked through board_ask_decision's own handler with signed actor
 * headers (board-offer-mcp's idiom), so the source can only come from actor.thread.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const dir = mkdtempSync(join(tmpdir(), "perch-card-result-"));
process.env.CROW_DATA_DIR = dir;
process.env.CROW_HOME = join(dir, "home");
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
delete process.env.CROW_DB_PATH;
mkdirSync(process.env.CROW_HOME, { recursive: true });

const REPO = new URL("..", import.meta.url).pathname;
const TASKS = process.env.CROW_TASKS_DB_PATH;
const DB_FILE = join(dir, "crow.db");

let server, base, sig, tools, mcpTdb, mcpCdb;

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: REPO });
  const tk = new Database(TASKS);
  tk.exec(`CREATE TABLE IF NOT EXISTS tasks_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT,
    status TEXT NOT NULL DEFAULT 'pending', priority INTEGER DEFAULT 3,
    due_date TEXT, phase TEXT, owner TEXT, tags TEXT, parent_id INTEGER, project_id INTEGER,
    assigned_bot TEXT, board_id INTEGER, bot_id TEXT, action_needed TEXT, next_followup_date TEXT,
    processing_lease TEXT, processing_lease_status TEXT, autonomy TEXT NOT NULL DEFAULT 'gated',
    archived_at TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT, data_json TEXT NOT NULL DEFAULT '{}');
  CREATE TABLE board_defs (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE,
    project_id INTEGER UNIQUE, display_name TEXT NOT NULL, status_values TEXT NOT NULL,
    terminal_values TEXT NOT NULL, fields_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  // Project 7's board ships to "shipped".
  tk.prepare("INSERT INTO board_defs (project_id, display_name, status_values, terminal_values) VALUES (7, 'Ship', ?, ?)")
    .run('["todo","doing","shipped","dropped"]', '["shipped","dropped"]');
  tk.close();
  {
    const c = new Database(DB_FILE);
    c.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, sha TEXT)");
    for (const id of ["0001-board-stages", "0002-board-defs", "0003-tracker-convergence"]) {
      c.prepare("INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, datetime('now'))").run(id);
    }
    c.close();
  }
  const migDir = join(dir, "migrations");
  mkdirSync(migDir);
  for (const f of ["0001-board-stages.mjs", "0002-board-defs.mjs", "0003-tracker-convergence.mjs", "0004-track1-card-model.mjs"]) {
    symlinkSync(join(REPO, "scripts", "migrations", f), join(migDir, f));
  }
  const { runMigrations } = await import("../scripts/migrations/runner.mjs");
  await runMigrations({ migrationsDir: migDir, dbPath: DB_FILE, tasksDbPath: TASKS, sha: "test", log: () => {} });

  sig = await import("../scripts/pi-bots/actor-sig.mjs");
  sig.initGatewayActorKey();
  const { createDbClient } = await import("../servers/db.js");
  const { createBoardMcpServer } = await import("../servers/gateway/board-mcp.js");
  mcpCdb = createDbClient(DB_FILE);
  mcpTdb = createDbClient(TASKS);
  tools = createBoardMcpServer({ cdb: mcpCdb, tdb: mcpTdb, verifyActor: sig.verifyBoardActorSig, verifyThread: sig.verifyBoardThreadActorSig })._registeredTools;

  const perch = await import("../servers/gateway/routes/perch-interactive-api.js");
  const { default: botBoardApiRouter } = await import("../servers/gateway/routes/bot-board-api.js");
  const { csrfMiddleware } = await import("../servers/gateway/dashboard/shared/csrf.js");
  const { parseCookies } = await import("../servers/gateway/dashboard/auth.js");
  const { default: express } = await import("express");
  const auth = (req, res, next) => (parseCookies(req).crow_session === "good" ? next() : res.status(401).json({ error: "unauthorized" }));
  const app = express();
  app.use(express.json());
  const router = express.Router();
  router.use("/dashboard", csrfMiddleware);
  router.use(perch.default(auth, { engine: () => ({}), annotate: async (m) => m, providerModels: () => [], piProviders: () => null }));
  router.use(botBoardApiRouter(auth));
  app.use(router);
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = "http://127.0.0.1:" + server.address().port + "/dashboard";
});

after(() => {
  try { mcpCdb.close(); mcpTdb.close(); } catch {}
  if (server) { server.closeAllConnections(); server.close(); }
  rmSync(dir, { recursive: true, force: true });
});

const AUTHED = { cookie: "crow_session=good; crow_csrf=tok", "x-crow-csrf": "tok" };
async function post(path, body, headers = AUTHED) {
  const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function get(path, headers = AUTHED) {
  const r = await fetch(base + path, { headers });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const chatCard = (sid) => get(`/perch-api/interactive/${sid}/card`);
const accept = (id, body, h) => post(`/perch-api/cards/${id}/accept`, body, h);
const change = (id, body, h) => post(`/perch-api/cards/${id}/request-change`, body, h);

function tq(sql, ...a) { const t = new Database(TASKS); try { return t.prepare(sql).all(...a); } finally { t.close(); } }
function addCard({ status = "todo", project = 7, title = "c" } = {}) {
  const t = new Database(TASKS);
  const id = Number(t.prepare("INSERT INTO tasks_items (title, status, project_id) VALUES (?, ?, ?)").run(title, status, project).lastInsertRowid);
  t.close();
  return id;
}
function addResult(itemId, { status = "recorded", outcome = "success", summary = "Did the thing." } = {}) {
  const t = new Database(TASKS);
  const id = Number(t.prepare("INSERT INTO board_results (item_id, actor_kind, actor_id, outcome, status, summary_md) VALUES (?, 'bot', 'scout', ?, ?, ?)")
    .run(itemId, outcome, status, summary).lastInsertRowid);
  t.close();
  return id;
}
function link(sid, cardId) {
  const c = new Database(DB_FILE);
  c.prepare("INSERT INTO bot_sessions (bot_id, gateway_thread_id, card_id, kind) VALUES ('b1', ?, ?, 'perch-live')").run(sid, cardId);
  c.close();
}
const card = (id) => tq("SELECT * FROM tasks_items WHERE id=?", id)[0];
const result = (id) => tq("SELECT * FROM board_results WHERE id=?", id)[0];
const muts = (id, verb) => tq("SELECT * FROM board_mutations WHERE item_id=? AND verb=?", id, verb);

/** The extra a bot's board call carries: signed bot headers, plus a signed Perch thread when given. */
function extra(botId, threadId) {
  const headers = { "x-crow-actor-kind": "bot", "x-crow-actor-id": botId, "x-crow-actor-sig": sig.signBoardActor({ botId }) };
  if (threadId) {
    headers["x-crow-actor-thread"] = threadId;
    headers["x-crow-actor-gateway"] = "perch";
    headers["x-crow-actor-thread-sig"] = sig.signBoardThreadActor({ botId, threadId, gatewayType: "perch" });
  }
  return { authInfo: { clientId: "local-mcp" }, requestInfo: { headers } };
}
let fp = 0;
async function ask(args, ex) {
  const r = await tools.board_ask_decision.handler(args, ex);
  assert.notEqual(r.isError, true, r.content && r.content[0].text);
  return JSON.parse(r.content[0].text).id;
}
function decisionArgs(question = "Which way?") {
  fp++;
  return {
    decision: {
      question, fingerprint: "fp-" + fp, batch: "b-" + fp,
      options: [
        { label: "Left", consequence: "We go left.", recommended: true },
        { label: "Right", consequence: "We go right." },
      ],
    },
  };
}

// ---- the rails ----

test("the review routes need a session and CSRF", async () => {
  const id = addCard();
  const rid = addResult(id);
  assert.equal((await accept(id, { result_id: rid }, {})).status, 401);
  assert.equal((await accept(id, { result_id: rid }, { cookie: "crow_session=good; crow_csrf=tok" })).status, 403);
  assert.equal((await change(id, { result_id: rid, text: "x" }, { cookie: "crow_session=good; crow_csrf=tok" })).status, 403);
  assert.equal((await get("/perch-api/interactive/perchlive-z/card", {})).status, 401);
  assert.equal(result(rid).status, "recorded");
  assert.equal(card(id).status, "todo");
});

test("bad bodies are 400; an unknown result is 404", async () => {
  const id = addCard();
  const rid = addResult(id);
  assert.equal((await accept(id, {})).status, 400);
  assert.equal((await accept(id, { result_id: "1" })).status, 400);
  assert.equal((await accept("abc", { result_id: rid })).status, 400);
  assert.equal((await accept(id, { result_id: 999999 })).status, 404);
  assert.equal((await change(id, { result_id: rid })).status, 400);
  assert.equal((await change(id, { result_id: rid, text: "   " })).status, 400);
  assert.equal((await change(id, { result_id: rid, text: "x".repeat(4001) })).status, 400);
  assert.equal((await change(id, { result_id: 999999, text: "x" })).status, 404);
  assert.equal(result(rid).status, "recorded");
});

// ---- GET card ----

test("the card route reports the real lane, and only a recorded result", async () => {
  assert.deepEqual((await chatCard("perchlive-none")).body, { card: null, result: null, decisions: [] });
  const id = addCard({ title: "Ship it" });
  link("perchlive-a", id);
  let r = await chatCard("perchlive-a");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.card, { id, title: "Ship it", status: "todo", lane: "up_next", projectId: 7, botId: "b1" });
  assert.equal(r.body.result, null);

  const rid = addResult(id, { outcome: "partial", summary: "Most of it." });
  r = await chatCard("perchlive-a");
  assert.equal(r.body.card.lane, "needs_you");
  assert.deepEqual(r.body.result, { id: rid, outcome: "partial", summaryMd: "Most of it." });

  const t = new Database(TASKS); t.prepare("UPDATE board_results SET status='approved' WHERE id=?").run(rid); t.close();
  r = await chatCard("perchlive-a");
  assert.equal(r.body.result, null, "an already approved result is not offered");
  assert.equal(r.body.card.lane, "up_next");
});

// ---- Accept ----

test("Accept approves and closes in one tap", async () => {
  const id = addCard();
  const rid = addResult(id);
  const r = await accept(id, { result_id: rid });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { ok: true, status: "approved", moved: true });
  assert.equal(card(id).status, "shipped");
  assert.equal(result(rid).status, "approved");
  assert.equal(result(rid).decided_via, "perch");
  assert.equal(muts(id, "result_decide").length, 1);
  assert.equal(muts(id, "move").length, 1);
});

test("two Accept taps at once decide once", async () => {
  const id = addCard();
  const rid = addResult(id);
  const both = await Promise.all([accept(id, { result_id: rid }), accept(id, { result_id: rid })]);
  assert.deepEqual(both.map((x) => x.status).sort(), [200, 409]);
  assert.equal(both.find((x) => x.status === 409).body.error, "already_decided");
  assert.equal(muts(id, "result_decide").length, 1);
  assert.equal(muts(id, "move").length, 1);
  assert.equal(card(id).status, "shipped");
});

test("Accept on a superseded result is 409 stale", async () => {
  const id = addCard();
  const older = addResult(id);
  const newer = addResult(id);
  const r = await accept(id, { result_id: older });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "stale");
  assert.equal(result(older).status, "recorded");
  assert.equal(result(newer).status, "recorded");
  assert.equal(card(id).status, "todo");
  assert.equal(muts(id, "result_decide").length, 0);
});

test("Accept after the classic board decided is 409", async () => {
  const id = addCard();
  const rid = addResult(id);
  const classic = await post(`/bot-board-api/card/${id}/result/${rid}/decide`, { decision: "rejected" });
  assert.equal(classic.status, 200);
  const r = await accept(id, { result_id: rid });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "already_decided");
  assert.equal(result(rid).status, "rejected");
  assert.equal(card(id).status, "todo");
});

test("R-P5-4: a failure or partial result needs accept_failure", async () => {
  for (const outcome of ["failure", "partial"]) {
    const id = addCard();
    const rid = addResult(id, { outcome });
    const r = await accept(id, { result_id: rid });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "confirm_failure");
    assert.equal(result(rid).status, "recorded", "nothing written without the flag");
    assert.equal(card(id).status, "todo");
    assert.equal(muts(id, "result_decide").length, 0);
    const ok = await accept(id, { result_id: rid, accept_failure: true });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(result(rid).status, "approved");
    assert.equal(card(id).status, "shipped");
  }
});

test("R-P5-7: Accept on a card with an open decision is 409 answer_first, nothing written", async () => {
  const id = addCard();
  const t = new Database(TASKS);
  t.prepare("UPDATE tasks_items SET data_json=? WHERE id=?").run(JSON.stringify({ decision: { question: "q?", options: [{ label: "a" }, { label: "b" }] } }), id);
  t.close();
  const rid = addResult(id);
  for (const body of [{ result_id: rid }, { result_id: rid, accept_failure: true }]) {
    const r = await accept(id, body);
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "answer_first");
  }
  assert.equal(result(rid).status, "recorded");
  assert.equal(card(id).status, "todo");
  assert.equal(muts(id, "result_decide").length, 0);
  assert.equal(muts(id, "move").length, 0);
});

// ---- Ask for a change ----

test("Ask for a change rejects and moves nothing", async () => {
  const id = addCard({ status: "doing" });
  const rid = addResult(id);
  const r = await change(id, { result_id: rid, text: "Use the blue one." });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { ok: true });
  assert.equal(result(rid).status, "rejected");
  assert.equal(result(rid).decided_via, "perch");
  assert.equal(card(id).status, "doing");
  assert.equal(muts(id, "move").length, 0);
  assert.equal(muts(id, "result_decide").length, 1);
  const again = await change(id, { result_id: rid, text: "And again." });
  assert.equal(again.status, 409);
  assert.equal(again.body.error, "already_decided");
});

test("Ask for a change on a superseded result is 409 stale", async () => {
  const id = addCard();
  const older = addResult(id);
  addResult(id);
  const r = await change(id, { result_id: older, text: "x" });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "stale");
  assert.equal(result(older).status, "recorded");
});

// ---- R-P5-5: the Board face's Reject sends the result it showed ----

test("the classic decide route refuses a stale seen_result_id; callers without it are unchanged", async () => {
  const id = addCard();
  const older = addResult(id);
  const newer = addResult(id);
  // The face showed `older` as the newest; a newer result landed since.
  let r = await post(`/bot-board-api/card/${id}/result/${older}/decide`, { decision: "rejected", seen_result_id: older });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "stale");
  assert.equal(result(older).status, "recorded");
  // The shown id must be the decided one.
  r = await post(`/bot-board-api/card/${id}/result/${newer}/decide`, { decision: "rejected", seen_result_id: older });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "stale");
  r = await post(`/bot-board-api/card/${id}/result/${newer}/decide`, { decision: "rejected", seen_result_id: null });
  assert.equal(r.status, 409);
  assert.equal((await post(`/bot-board-api/card/${id}/result/${newer}/decide`, { decision: "rejected", seen_result_id: "x" })).status, 400);
  assert.equal(result(newer).status, "recorded");
  r = await post(`/bot-board-api/card/${id}/result/${newer}/decide`, { decision: "rejected", seen_result_id: newer });
  assert.equal(r.status, 200);
  assert.equal(result(newer).status, "rejected");
  // Without seen_result_id (MCP, the classic drawer): an older result is still decidable.
  r = await post(`/bot-board-api/card/${id}/result/${older}/decide`, { decision: "approved" });
  assert.equal(r.status, 200);
  assert.equal(result(older).status, "approved");
});

test("the Board face's Reject posts the shown result id", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../servers/gateway/dashboard/panels/board/client.js", import.meta.url), "utf8");
  assert.match(src, /\/decide',\{decision:'rejected',seen_result_id:seenOf\(li\)\.rid\}\)/);
});

// ---- decisions (R-P5-6) ----

test("decision chips come only from this chat", async () => {
  const id = await ask(decisionArgs("Left or right?"), extra("b1", "perchlive-q"));
  const stored = JSON.parse(card(id).data_json).decision;
  assert.deepEqual(stored.source, { thread_id: "perchlive-q" });
  const q = await chatCard("perchlive-q");
  assert.deepEqual(q.body.decisions, [{
    cardId: id, question: "Left or right?",
    options: [
      { index: 0, label: "Left", consequence: "We go left.", recommended: true },
      { index: 1, label: "Right", consequence: "We go right.", recommended: false },
    ],
  }]);
  assert.deepEqual((await chatCard("perchlive-r")).body.decisions, []);

  // A source in tool arguments is never read: not at the top level, not inside the decision.
  const forged = decisionArgs("Forged?");
  forged.source = { thread_id: "perchlive-r" };
  forged.decision.source = { thread_id: "perchlive-r" };
  const fid = await ask(forged, extra("b1"));
  assert.equal(JSON.parse(card(fid).data_json).decision.source, undefined);
  const fid2 = await ask({ ...decisionArgs("Forged too?"), source: { thread_id: "perchlive-r" } }, extra("b1", "perchlive-s"));
  assert.deepEqual(JSON.parse(card(fid2).data_json).decision.source, { thread_id: "perchlive-s" });
  assert.deepEqual((await chatCard("perchlive-r")).body.decisions, []);
});

test("an unsigned thread header sets no source", async () => {
  const ex = extra("b1");
  ex.requestInfo.headers["x-crow-actor-thread"] = "perchlive-u";
  ex.requestInfo.headers["x-crow-actor-gateway"] = "perch";
  const id = await ask(decisionArgs("Unsigned?"), ex);
  assert.equal(JSON.parse(card(id).data_json).decision.source, undefined);
  assert.deepEqual((await chatCard("perchlive-u")).body.decisions, []);
});

test("a chat shows its newest 3 open decisions", async () => {
  const ids = [];
  for (let i = 0; i < 4; i++) ids.push(await ask(decisionArgs("Q" + i), extra("b1", "perchlive-m")));
  const r = await chatCard("perchlive-m");
  assert.deepEqual(r.body.decisions.map((d) => d.cardId), [ids[3], ids[2], ids[1]]);
});

test("answering a decision in chat leaves Needs you", async () => {
  const id = await ask(decisionArgs("Go?"), extra("b1", "perchlive-d"));
  link("perchlive-d", id);
  let r = await chatCard("perchlive-d");
  assert.equal(r.body.card.lane, "needs_you");
  assert.equal(r.body.decisions.length, 1);
  const a = await post(`/bot-board-api/card/${id}/decision`, { index: 0 });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  r = await chatCard("perchlive-d");
  assert.deepEqual(r.body.decisions, []);
  assert.equal(r.body.card.lane, "done", "the lane now comes from the card's other rules (#535 closes it)");
  assert.equal((await post(`/bot-board-api/card/${id}/decision`, { index: 1 })).status, 409, "one answer per card");
});

test("the card route names the card's own bot when it has one, else the chat's bot", async () => {
  const id = addCard({ title: "Assigned" });
  const t = new Database(TASKS); t.prepare("UPDATE tasks_items SET assigned_bot='other-bot' WHERE id=?").run(id); t.close();
  link("perchlive-ab", id);
  assert.equal((await chatCard("perchlive-ab")).body.card.botId, "other-bot");
});
