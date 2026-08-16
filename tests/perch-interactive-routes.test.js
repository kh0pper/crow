/**
 * Perch Hub P2, Task C-15 — servers/gateway/routes/perch-interactive-api.js,
 * plus the perch.js modifications it required (kind='perch-live' refusal on
 * the P1 turn route, `state` on the sessions list).
 *
 * Harness: a real init-db'd scratch crow.db (CROW_DATA_DIR, so nothing can
 * touch the operator's ~/.crow), an ephemeral express server, and an INJECTED
 * fake interactive engine (`engineImpl`, reconfigured per test) — no pi is
 * ever spawned, no bridge module is ever loaded except in the one dedicated
 * precondition test.
 *
 * `engineImpl` is mutable module state (mirrors perch-routes.test.js's own
 * `inboundHook` idiom): tests overwrite individual methods, `beforeEach`
 * restores sane defaults. The router is handed `{ engine: () => engineImpl }`
 * — an ACCESSOR, so the swap takes effect on the next request without
 * rebuilding the app.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import Database from "better-sqlite3";

const dir = mkdtempSync(join(tmpdir(), "perch-interactive-routes-"));
process.env.CROW_DATA_DIR = dir;
process.env.CROW_HOME = join(dir, "home");
delete process.env.CROW_DB_PATH;
// Track 3 Task 9: dispatch/attach-card read+write the INSTANCE-GLOBAL tasks
// store (tasksDbPath() from scripts/pi-bots/instance-paths.mjs) — set
// explicitly rather than relying on the CROW_DATA_DIR-derived default, same
// as board-card-api.test.js's own idiom.
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");

const DB_FILE = join(dir, "crow.db");
const TASKS_DB_FILE = process.env.CROW_TASKS_DB_PATH;
const REPO = new URL("..", import.meta.url).pathname;

let server, base, _setEngineStatusForTest;
/** Every opts object handleInboundImpl was called with (P1 turn-route regression). */
let inboundCalls = [];
let inboundHook = null;

// Track 3 Task 9 fixture ids (assigned in before()): a live card, an
// archived one, and a custom-board tracker ITEM (board_id NOT NULL) — the
// "wrong kind" id dispatch/attach-card must 400 on.
let liveCardId, archivedCardId, itemId;

/** Mutable fake interactive engine. Reset to these defaults in beforeEach;
 * individual tests overwrite whichever methods they need to observe or fail. */
let engineImpl;
let engineCalls;

function raw() {
  return new Database(DB_FILE);
}

function seedBot(botId, def, { name = botId, enabled = 1 } = {}) {
  const c = raw();
  c.prepare("INSERT OR REPLACE INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES (?,?,?,?)")
    .run(botId, name, JSON.stringify(def), enabled);
  c.close();
}

// ---------------------------------------------------------------------------
// Track 3 Task 9: the instance-global tasks store (dispatch/attach-card read
// + write it directly). A minimal hand-rolled schema — just the columns
// card-service.js's getCard/updateCard/recordMutation touch, same idiom as
// tests/board-card-api.test.js's own fixture, without the board_defs/status
// machinery those routes never exercise (dispatch/attach-card never validate
// status).
// ---------------------------------------------------------------------------

function rawTasks() {
  return new Database(TASKS_DB_FILE);
}

function initTasksDb() {
  const t = rawTasks();
  t.exec(`CREATE TABLE IF NOT EXISTS tasks_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    priority INTEGER DEFAULT 3,
    due_date TEXT, phase TEXT, owner TEXT, tags TEXT,
    parent_id INTEGER, project_id INTEGER,
    assigned_bot TEXT, board_id INTEGER, bot_id TEXT,
    action_needed TEXT, next_followup_date TEXT,
    processing_lease TEXT, processing_lease_status TEXT,
    autonomy TEXT NOT NULL DEFAULT 'gated',
    archived_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT,
    data_json TEXT NOT NULL DEFAULT '{}'
  )`);
  t.exec(`CREATE TABLE IF NOT EXISTS board_mutations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL,
    verb TEXT NOT NULL,
    actor_kind TEXT NOT NULL CHECK(actor_kind IN ('human','session','bot')),
    actor_id TEXT,
    job_id TEXT,
    detail_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  t.close();
}

function seedCard({ title = "card", boardId = null, archivedAt = null, assignedBot = null } = {}) {
  const t = rawTasks();
  const r = t.prepare(
    "INSERT INTO tasks_items (title, board_id, archived_at, assigned_bot) VALUES (?,?,?,?)"
  ).run(title, boardId, archivedAt, assignedBot);
  t.close();
  return Number(r.lastInsertRowid);
}

function taskRow(id) {
  const t = rawTasks();
  const row = t.prepare("SELECT * FROM tasks_items WHERE id=?").get(id);
  t.close();
  return row || null;
}

const PERCH_BOT = {
  gateways: [{ type: "perch" }],
  tools: { pi_builtin: ["read", "bash"] },
  models: { default: "local/qwen" },
};

/** Build an engine-thrown error the way perch-interactive.js's engineError()
 * does: an Error whose .code is what ERROR_MAP switches on. */
function engineErr(code) {
  const e = new Error(code);
  e.code = code;
  return e;
}

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir },
    stdio: "pipe",
    cwd: REPO,
  });

  seedBot("chatty", PERCH_BOT, { name: "Chatty" });
  seedBot("quiet", {
    gateways: [{ type: "gmail", address: "q@example.com", allowlist: ["a@example.com"] }],
    models: { default: "local/qwen" },
  }, { name: "Quiet" });

  initTasksDb();
  liveCardId = seedCard({ title: "live card" });
  archivedCardId = seedCard({ title: "archived card", archivedAt: "2026-01-01T00:00:00.000Z" });
  itemId = seedCard({ title: "tracker item", boardId: 1 });

  ({ _setEngineStatusForTest } = await import("../servers/gateway/dashboard/panels/bot-builder/engine-gate.js"));
  const { default: perchApiRouter } = await import("../servers/gateway/routes/perch.js");
  const { default: perchInteractiveApiRouter } = await import("../servers/gateway/routes/perch-interactive-api.js");
  const { default: express } = await import("express");

  const fakeAuth = (req, res, next) => { req.dashboardSession = "test-token"; next(); };

  const app = express();
  // Mirrors index.js's own global-parser/route-scoped-parser split (its
  // `_hasOwnParser`): the files-upload and message (images) routes need a
  // bigger-than-default limit and install their OWN express.json() inside
  // perch-interactive-api.js — the global parser here must skip both exact
  // paths or it would consume (and, at default limits, reject) the body
  // before the route-scoped parser ever sees it.
  const defaultJsonParser = express.json();
  app.use((req, res, next) => (
    /^\/dashboard\/perch-api\/interactive\/[^/]+\/(files|message)$/.test(req.path) ? next() : defaultJsonParser(req, res, next)
  ));
  // Both routers mount at the same /dashboard/perch-api prefix, exactly as
  // dashboard/index.js does — their path sets don't collide.
  app.use(perchApiRouter(fakeAuth, {
    handleInboundImpl: (opts) => { inboundCalls.push(opts); return inboundHook(opts); },
    interactiveEngine: () => engineImpl,
  }));
  app.use(perchInteractiveApiRouter(fakeAuth, { engine: () => engineImpl }));

  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = "http://127.0.0.1:" + server.address().port + "/dashboard/perch-api";
});

after(() => {
  _setEngineStatusForTest(null);
  if (server) server.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  _setEngineStatusForTest({ state: "ready", source: "test", cliPath: "/nonexistent/pi" });
  inboundCalls = [];
  inboundHook = async () => ({ action: "asked" });
  engineCalls = {
    spawn: [], message: [], answer: [], abort: [], stop: [], get: [], subscribe: [],
    checkCardFree: [], attachCard: [], control: [], cycle: [], options: [],
  };
  engineImpl = {
    async spawn({ botId, cardId }) {
      engineCalls.spawn.push({ botId, cardId });
      return { sessionId: "perchlive-abc", threadId: "perchlive-abc", state: "awake" };
    },
    async message(sid, text, images) {
      engineCalls.message.push({ sid, text, images });
      return { turnId: "turn-1" };
    },
    async checkCardFree(cardId, opts) {
      engineCalls.checkCardFree.push({ cardId, opts });
    },
    async attachCard(sid, cardId) {
      engineCalls.attachCard.push({ sid, cardId });
      return { ok: true, cardId, botId: "chatty" };
    },
    async control(sid, opts) {
      engineCalls.control.push({ sid, opts });
      return { applied: {}, bindsAtWake: {} };
    },
    async cycle(sid) {
      engineCalls.cycle.push({ sid });
      return { state: "waking" };
    },
    async options(sid) {
      engineCalls.options.push({ sid });
      return { models: [], thinkingLevels: [] };
    },
    async answer(sid, requestId, value) {
      engineCalls.answer.push({ sid, requestId, value });
      return { ok: true };
    },
    async abort(sid) {
      engineCalls.abort.push({ sid });
      return { ok: true };
    },
    async stop(sid) {
      engineCalls.stop.push({ sid });
      return { ok: true };
    },
    async get(sid) {
      engineCalls.get.push({ sid });
      return { sessionId: sid, botId: "chatty", threadId: sid, rowId: 1, state: "awake", pendingUi: null, lastError: null, model: "local/qwen" };
    },
    async subscribe(sid, fn) {
      engineCalls.subscribe.push({ sid, fn });
      fn({ type: "state", sessionId: sid, botId: "chatty", threadId: sid, state: "awake", lastError: null, pendingUi: null });
      return () => {};
    },
  };
});

const getJson = async (path) => {
  const r = await fetch(base + path);
  return { status: r.status, body: await r.json().catch(() => null) };
};

const postJson = async (path, body) => {
  const r = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

/** Read an SSE response until `until(buffer)` is true (or the server closes).
 * Returns the reader too, so leak tests can cancel() and then poll. */
async function readSse(path, until = () => false) {
  const res = await fetch(base + path);
  if (res.status !== 200) return { status: res.status, text: await res.text(), reader: null };
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    if (until(buf)) break;
  }
  return { status: res.status, text: buf, reader };
}

/** Every `event: <name>` in an SSE payload, in order. */
const sseEvents = (text) => [...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
/** The data payload of the Nth `event: <name>` block. */
function sseDataAt(text, name, n = 0) {
  const re = new RegExp("^event: " + name + "\\ndata: (.*)$", "gm");
  let m, i = 0;
  while ((m = re.exec(text))) { if (i++ === n) return JSON.parse(m[1]); }
  return null;
}

/** Poll a synchronous predicate until it's true or the budget runs out —
 * res.on("close") fires asynchronously after reader.cancel(), so the leak
 * test cannot assert immediately. */
async function waitUntil(predicate, { attempts = 50, everyMs = 10 } = {}) {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return predicate();
}

// ---------------------------------------------------------------------------
// POST /bots/:id/interactive — spawn
// ---------------------------------------------------------------------------

test("POST /bots/:id/interactive 201s and passes botId through to the engine", async () => {
  const { status, body } = await postJson("/bots/chatty/interactive", {});
  assert.equal(status, 201);
  assert.deepEqual(body, { sessionId: "perchlive-abc", threadId: "perchlive-abc", state: "awake" });
  assert.deepEqual(engineCalls.spawn, [{ botId: "chatty", cardId: undefined }]);
});

test("POST /bots/:id/interactive 409s engine_required before ever touching the engine", async () => {
  _setEngineStatusForTest({ state: "absent" });
  const { status, body } = await postJson("/bots/chatty/interactive", {});
  assert.equal(status, 409);
  assert.equal(body.error, "engine_required");
  assert.equal(engineCalls.spawn.length, 0, "the engine gate is checked BEFORE the engine is ever called");
});

test("POST /bots/:id/interactive 403s perch_not_attached for a gmail-only bot", async () => {
  const { status, body } = await postJson("/bots/quiet/interactive", {});
  assert.equal(status, 403);
  assert.equal(body.error, "perch_not_attached");
  assert.equal(engineCalls.spawn.length, 0);
});

test("POST /bots/:id/interactive on an unknown bot resolves to perch_not_attached — no distinct unknown_bot shape", async () => {
  // The documented external interface enumerates engine_required /
  // perch_not_attached / interactive_capacity / pi_capacity / perch_disabled
  // only. An unknown bot's def parses to {}, which perchAttached() refuses
  // exactly like a real gmail-only bot — no separate 404 branch to keep in
  // sync with the documented shape.
  const { status, body } = await postJson("/bots/does-not-exist/interactive", {});
  assert.equal(status, 403);
  assert.equal(body.error, "perch_not_attached");
});

test("POST /bots/:id/interactive maps interactive_capacity, pi_capacity, and perch_disabled", async () => {
  engineImpl.spawn = async () => { throw engineErr("interactive_capacity"); };
  let r = await postJson("/bots/chatty/interactive", {});
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "interactive_capacity");

  engineImpl.spawn = async () => { throw engineErr("pi_capacity"); };
  r = await postJson("/bots/chatty/interactive", {});
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "pi_capacity");

  engineImpl.spawn = async () => { throw engineErr("perch_disabled"); };
  r = await postJson("/bots/chatty/interactive", {});
  assert.equal(r.status, 503);
  assert.equal(r.body.error, "perch_disabled");
});

test("POST /bots/:id/interactive maps an unrecognized engine throw to a plain 500", async () => {
  engineImpl.spawn = async () => { throw new Error("disk full"); };
  const { status, body } = await postJson("/bots/chatty/interactive", {});
  assert.equal(status, 500);
  assert.equal(body.error, "disk full");
});

test("an err.code that collides with Object.prototype ('constructor') still maps to a clean 500 (fix-round F2)", async () => {
  // Pre-fix, `ERROR_MAP[err.code]` walked the prototype chain: code
  // "constructor" yielded Object's constructor function (truthy, not an
  // array), so mapped[0] was undefined and res.status(undefined) threw inside
  // an async catch — an unhandled rejection instead of a response.
  engineImpl.spawn = async () => { throw engineErr("constructor"); };
  const { status, body } = await postJson("/bots/chatty/interactive", {});
  assert.equal(status, 500);
  assert.equal(body.error, "constructor");
});

// ---------------------------------------------------------------------------
// POST /interactive/:sid/message
// ---------------------------------------------------------------------------

test("POST /interactive/:sid/message 202s with the turnId the engine returns", async () => {
  const { status, body } = await postJson("/interactive/sess-1/message", { message: "hello" });
  assert.equal(status, 202);
  assert.deepEqual(body, { turnId: "turn-1" });
  assert.deepEqual(engineCalls.message, [{ sid: "sess-1", text: "hello", images: undefined }]);
});

test("the interactive message is capped at 32k before it reaches the engine", async () => {
  const big = "x".repeat(40_000);
  const { status } = await postJson("/interactive/sess-1/message", { message: big });
  assert.equal(status, 202);
  assert.equal(engineCalls.message[0].text.length, 32_000);
});

test("POST /interactive/:sid/message maps turn_in_progress, no_such_session (404), and session_stopped→410 stopped", async () => {
  engineImpl.message = async () => { throw engineErr("turn_in_progress"); };
  let r = await postJson("/interactive/sess-1/message", { message: "hi" });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "turn_in_progress");

  engineImpl.message = async () => { throw engineErr("no_such_session"); };
  r = await postJson("/interactive/unknown/message", { message: "hi" });
  assert.equal(r.status, 404);
  assert.equal(r.body.error, "no_such_session");

  // session_stopped is the engine's OWN internal code; the external body
  // must read "stopped" — the documented contract, not the engine's vocabulary.
  engineImpl.message = async () => { throw engineErr("session_stopped"); };
  r = await postJson("/interactive/sess-1/message", { message: "hi" });
  assert.equal(r.status, 410);
  assert.equal(r.body.error, "stopped");
});

// ---------------------------------------------------------------------------
// POST /interactive/:sid/answer
// ---------------------------------------------------------------------------

test("POST /interactive/:sid/answer forwards requestId + the full body as the value, and returns {ok:true}", async () => {
  const { status, body } = await postJson("/interactive/sess-1/answer", { requestId: "r1", value: "yes" });
  assert.equal(status, 200);
  assert.deepEqual(body, { ok: true });
  assert.deepEqual(engineCalls.answer, [{ sid: "sess-1", requestId: "r1", value: { requestId: "r1", value: "yes" } }]);
});

test("POST /interactive/:sid/answer 409s no_such_request — including the dead-child case (S4: never a 500)", async () => {
  engineImpl.answer = async () => { throw engineErr("no_such_request"); };
  const { status, body } = await postJson("/interactive/sess-1/answer", { requestId: "stale" });
  assert.equal(status, 409);
  assert.equal(body.error, "no_such_request");
});

// ---------------------------------------------------------------------------
// POST /interactive/:sid/abort
// ---------------------------------------------------------------------------

test("POST /interactive/:sid/abort returns {ok:true} on a real in-flight turn", async () => {
  const { status, body } = await postJson("/interactive/sess-1/abort", {});
  assert.equal(status, 200);
  assert.deepEqual(body, { ok: true });
  assert.deepEqual(engineCalls.abort, [{ sid: "sess-1" }]);
});

test("POST /interactive/:sid/abort 409s no_turn — an honest refusal, never a silent ok (carried delta)", async () => {
  engineImpl.abort = async () => { throw engineErr("no_turn"); };
  const { status, body } = await postJson("/interactive/sess-1/abort", {});
  assert.equal(status, 409);
  assert.equal(body.error, "no_turn");
});

// ---------------------------------------------------------------------------
// POST /interactive/:sid/stop
// ---------------------------------------------------------------------------

test("POST /interactive/:sid/stop returns {ok:true}", async () => {
  const { status, body } = await postJson("/interactive/sess-1/stop", {});
  assert.equal(status, 200);
  assert.deepEqual(body, { ok: true });
  assert.deepEqual(engineCalls.stop, [{ sid: "sess-1" }]);
});

// ---------------------------------------------------------------------------
// POST /bots/:id/dispatch — Track 3 Task 9
// ---------------------------------------------------------------------------

test("POST /bots/:id/dispatch 201s, spawns with cardId, writes assigned_bot, and fires turn 1 fire-and-forget", async () => {
  const { status, body } = await postJson("/bots/chatty/dispatch", { card_id: liveCardId, note: "please work this" });
  assert.equal(status, 201);
  assert.deepEqual(body, { sessionId: "perchlive-abc", threadId: "perchlive-abc", state: "awake" });
  assert.deepEqual(engineCalls.spawn, [{ botId: "chatty", cardId: liveCardId }]);
  // Fix round 1: dispatch keeps calling checkCardFree WITHOUT an exclusion —
  // a fresh spawn always mints a brand-new sessionId, so it can never
  // collide with its own not-yet-existent row.
  assert.deepEqual(engineCalls.checkCardFree, [{ cardId: liveCardId, opts: undefined }]);
  // Fire-and-forget: the route never awaits eng.message(), but the fake's
  // synchronous prefix (before its first await) has already run by the time
  // the response is sent — no polling needed.
  assert.deepEqual(engineCalls.message, [{ sid: "perchlive-abc", text: "please work this", images: undefined }]);
  assert.equal(taskRow(liveCardId).assigned_bot, "chatty");
});

test("POST /bots/:id/dispatch defaults note to \"\" when omitted", async () => {
  await postJson("/bots/chatty/dispatch", { card_id: liveCardId });
  assert.equal(engineCalls.message.at(-1).text, "");
});

test("POST /bots/:id/dispatch 400s bad_request for a missing or non-integer card_id, before ever touching the tasks store", async () => {
  for (const body of [{}, { card_id: "abc" }, { card_id: null }]) {
    const r = await postJson("/bots/chatty/dispatch", body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.error, "bad_request", JSON.stringify(body));
  }
  assert.equal(engineCalls.spawn.length, 0);
});

test("POST /bots/:id/dispatch 409s engine_required before ever touching the tasks store", async () => {
  _setEngineStatusForTest({ state: "absent" });
  const { status, body } = await postJson("/bots/chatty/dispatch", { card_id: liveCardId });
  assert.equal(status, 409);
  assert.equal(body.error, "engine_required");
  assert.equal(engineCalls.spawn.length, 0);
});

test("POST /bots/:id/dispatch 403s perch_not_attached for a gmail-only bot", async () => {
  const { status, body } = await postJson("/bots/quiet/dispatch", { card_id: liveCardId });
  assert.equal(status, 403);
  assert.equal(body.error, "perch_not_attached");
  assert.equal(engineCalls.spawn.length, 0);
});

test("POST /bots/:id/dispatch 404s an unknown card id", async () => {
  const { status, body } = await postJson("/bots/chatty/dispatch", { card_id: 999999 });
  assert.equal(status, 404);
  assert.equal(body.error, "not_found");
  assert.equal(engineCalls.spawn.length, 0);
});

test("POST /bots/:id/dispatch 400s bad_request for a custom-board tracker ITEM id (board_id NOT NULL) — dispatch is cards-only", async () => {
  const { status, body } = await postJson("/bots/chatty/dispatch", { card_id: itemId });
  assert.equal(status, 400);
  assert.equal(body.error, "bad_request");
  assert.equal(engineCalls.spawn.length, 0);
});

test("POST /bots/:id/dispatch 409s archived for an archived card", async () => {
  const { status, body } = await postJson("/bots/chatty/dispatch", { card_id: archivedCardId });
  assert.equal(status, 409);
  assert.equal(body.error, "archived");
  assert.equal(engineCalls.spawn.length, 0);
});

test("POST /bots/:id/dispatch 409s card_occupied from checkCardFree, before spawn is ever called", async () => {
  engineImpl.checkCardFree = async () => { throw engineErr("card_occupied"); };
  const { status, body } = await postJson("/bots/chatty/dispatch", { card_id: liveCardId });
  assert.equal(status, 409);
  assert.equal(body.error, "card_occupied");
  assert.equal(engineCalls.spawn.length, 0);
});

test("POST /bots/:id/dispatch maps a spawn() throw and never writes assigned_bot or fires turn 1", async () => {
  const freshCardId = seedCard({ title: "spawn-throw fixture" }); // untouched by any earlier test
  engineImpl.spawn = async () => { throw engineErr("interactive_capacity"); };
  const { status, body } = await postJson("/bots/chatty/dispatch", { card_id: freshCardId });
  assert.equal(status, 409);
  assert.equal(body.error, "interactive_capacity");
  assert.equal(taskRow(freshCardId).assigned_bot, null);
  assert.equal(engineCalls.message.length, 0);
});

// ---------------------------------------------------------------------------
// POST /interactive/:sid/attach-card — Track 3 Task 9
// ---------------------------------------------------------------------------

test("POST /interactive/:sid/attach-card 200s, checks occupancy, calls attachCard, and writes assigned_bot from the returned botId", async () => {
  const { status, body } = await postJson("/interactive/sess-1/attach-card", { card_id: liveCardId });
  assert.equal(status, 200);
  assert.deepEqual(body, { ok: true, cardId: liveCardId });
  // Fix round 1: attach-card DOES pass an exclusion — the target session's
  // own sid, so a re-assert of a card it already holds can reach
  // attachCard()'s idempotent no-op path instead of 409ing against itself.
  assert.deepEqual(engineCalls.checkCardFree, [{ cardId: liveCardId, opts: { excludeSessionId: "sess-1" } }]);
  assert.deepEqual(engineCalls.attachCard, [{ sid: "sess-1", cardId: liveCardId }]);
  assert.equal(taskRow(liveCardId).assigned_bot, "chatty");
});

test("POST /interactive/:sid/attach-card 400s bad_request for a missing or non-integer card_id", async () => {
  const { status, body } = await postJson("/interactive/sess-1/attach-card", {});
  assert.equal(status, 400);
  assert.equal(body.error, "bad_request");
  assert.equal(engineCalls.attachCard.length, 0);
});

test("POST /interactive/:sid/attach-card 404s an unknown card id", async () => {
  const { status, body } = await postJson("/interactive/sess-1/attach-card", { card_id: 999998 });
  assert.equal(status, 404);
  assert.equal(body.error, "not_found");
  assert.equal(engineCalls.attachCard.length, 0);
});

test("POST /interactive/:sid/attach-card 400s bad_request for a custom-board tracker ITEM id", async () => {
  const { status, body } = await postJson("/interactive/sess-1/attach-card", { card_id: itemId });
  assert.equal(status, 400);
  assert.equal(body.error, "bad_request");
  assert.equal(engineCalls.attachCard.length, 0);
});

test("POST /interactive/:sid/attach-card 409s archived for an archived card", async () => {
  const { status, body } = await postJson("/interactive/sess-1/attach-card", { card_id: archivedCardId });
  assert.equal(status, 409);
  assert.equal(body.error, "archived");
  assert.equal(engineCalls.attachCard.length, 0);
});

test("POST /interactive/:sid/attach-card 409s card_occupied from checkCardFree, before attachCard is ever called", async () => {
  engineImpl.checkCardFree = async () => { throw engineErr("card_occupied"); };
  const { status, body } = await postJson("/interactive/sess-1/attach-card", { card_id: liveCardId });
  assert.equal(status, 409);
  assert.equal(body.error, "card_occupied");
  assert.equal(engineCalls.attachCard.length, 0);
});

// Fix round 1 (coordinator-reported Important): checkCardFree's perch-live
// rail used to match the CALLING session's own already-attached row, so the
// route's checkCardFree-then-attachCard sequence 409'd a session
// re-asserting the card it already holds — attachCard()'s documented
// idempotent no-op path was unreachable over HTTP. The fake below stands in
// for the real engine's exclusion semantics: "occupied by sess-1 itself,
// clears ONLY when excluded by that exact sessionId" — proving the ROUTE
// actually plumbs `{excludeSessionId: sid}` through, not merely that it
// calls checkCardFree at all.
test("POST /interactive/:sid/attach-card to the card THIS session already holds 200s/no-ops — the idempotent path is reachable (fix round 1)", async () => {
  engineImpl.checkCardFree = async (cardId, opts) => {
    engineCalls.checkCardFree.push({ cardId, opts });
    if (!opts || opts.excludeSessionId !== "sess-1") throw engineErr("card_occupied");
    // else: excluded — the session's own row no longer occupies the card.
  };
  const { status, body } = await postJson("/interactive/sess-1/attach-card", { card_id: liveCardId });
  assert.equal(status, 200);
  assert.deepEqual(body, { ok: true, cardId: liveCardId });
  assert.deepEqual(engineCalls.checkCardFree, [{ cardId: liveCardId, opts: { excludeSessionId: "sess-1" } }]);
  assert.deepEqual(engineCalls.attachCard, [{ sid: "sess-1", cardId: liveCardId }]);
});

test("POST /interactive/:sid/attach-card to a card held by a DIFFERENT session still 409s — exclusion is narrowly scoped, never a blanket bypass (fix round 1)", async () => {
  engineImpl.checkCardFree = async (cardId, opts) => {
    engineCalls.checkCardFree.push({ cardId, opts });
    // Occupied by SOME OTHER session — excluding "sess-1" (the caller) can
    // never clear a claim that belongs to someone else.
    throw engineErr("card_occupied");
  };
  const { status, body } = await postJson("/interactive/sess-1/attach-card", { card_id: liveCardId });
  assert.equal(status, 409);
  assert.equal(body.error, "card_occupied");
  assert.deepEqual(engineCalls.checkCardFree, [{ cardId: liveCardId, opts: { excludeSessionId: "sess-1" } }]);
  assert.equal(engineCalls.attachCard.length, 0);
});

test("POST /interactive/:sid/attach-card maps session_stopped -> 410 stopped, and never writes assigned_bot", async () => {
  const freshCardId = seedCard({ title: "attach-stopped fixture" }); // untouched by any earlier test
  engineImpl.attachCard = async () => { throw engineErr("session_stopped"); };
  const { status, body } = await postJson("/interactive/sess-1/attach-card", { card_id: freshCardId });
  assert.equal(status, 410);
  assert.equal(body.error, "stopped");
  assert.equal(taskRow(freshCardId).assigned_bot, null);
});

// ---------------------------------------------------------------------------
// POST /interactive/:sid/control — snake_case body -> camelCase engine opts
// ---------------------------------------------------------------------------

test("POST /interactive/:sid/control maps model {provider,id}->modelId, thinking, permission_mode->permissionMode, plan_mode->planMode", async () => {
  const { status, body } = await postJson("/interactive/sess-1/control", {
    model: { provider: "crow-local", id: "qwen3.6-35b-a3b" },
    thinking: "high",
    permission_mode: "guarded",
    plan_mode: true,
  });
  assert.equal(status, 200);
  assert.deepEqual(body, { applied: {}, bindsAtWake: {} });
  assert.deepEqual(engineCalls.control, [{
    sid: "sess-1",
    opts: {
      model: { provider: "crow-local", modelId: "qwen3.6-35b-a3b" },
      thinking: "high",
      permissionMode: "guarded",
      planMode: true,
    },
  }]);
});

test("POST /interactive/:sid/control forwards plan_mode:false — a present falsy value, not an omitted field", async () => {
  await postJson("/interactive/sess-1/control", { plan_mode: false });
  assert.deepEqual(engineCalls.control[0].opts, { planMode: false });
});

test("POST /interactive/:sid/control sends an empty opts object when the body carries no recognized fields", async () => {
  await postJson("/interactive/sess-1/control", {});
  assert.deepEqual(engineCalls.control[0].opts, {});
});

test("POST /interactive/:sid/control maps bad_request, turn_in_progress, session_stopped, no_such_session, and not_awake", async () => {
  for (const [code, wantStatus, wantError] of [
    ["bad_request", 400, "bad_request"],
    ["turn_in_progress", 409, "turn_in_progress"],
    ["session_stopped", 410, "stopped"],
    ["no_such_session", 404, "no_such_session"],
    ["not_awake", 409, "not_awake"],
  ]) {
    engineImpl.control = async () => { throw engineErr(code); };
    const { status, body } = await postJson("/interactive/sess-1/control", { thinking: "low" });
    assert.equal(status, wantStatus, code);
    assert.equal(body.error, wantError, code);
  }
});

// ---------------------------------------------------------------------------
// POST /interactive/:sid/cycle
// ---------------------------------------------------------------------------

test("POST /interactive/:sid/cycle 200s with the engine's own {state}", async () => {
  const { status, body } = await postJson("/interactive/sess-1/cycle", {});
  assert.equal(status, 200);
  assert.deepEqual(body, { state: "waking" });
  assert.deepEqual(engineCalls.cycle, [{ sid: "sess-1" }]);
});

test("POST /interactive/:sid/cycle maps cycle_busy and session_stopped", async () => {
  engineImpl.cycle = async () => { throw engineErr("cycle_busy"); };
  let r = await postJson("/interactive/sess-1/cycle", {});
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "cycle_busy");

  engineImpl.cycle = async () => { throw engineErr("session_stopped"); };
  r = await postJson("/interactive/sess-1/cycle", {});
  assert.equal(r.status, 410);
  assert.equal(r.body.error, "stopped");
});

// ---------------------------------------------------------------------------
// GET /interactive/:sid/options
// ---------------------------------------------------------------------------

test("GET /interactive/:sid/options 200s with the engine's models/thinkingLevels", async () => {
  engineImpl.options = async (sid) => {
    engineCalls.options.push({ sid });
    return { models: [{ provider: "crow-local", id: "qwen3.6-35b-a3b" }], thinkingLevels: ["low", "high"] };
  };
  const { status, body } = await getJson("/interactive/sess-1/options");
  assert.equal(status, 200);
  assert.deepEqual(body, { models: [{ provider: "crow-local", id: "qwen3.6-35b-a3b" }], thinkingLevels: ["low", "high"] });
  assert.deepEqual(engineCalls.options, [{ sid: "sess-1" }]);
});

test("GET /interactive/:sid/options 404s no_such_session", async () => {
  engineImpl.options = async () => { throw engineErr("no_such_session"); };
  const { status, body } = await getJson("/interactive/sess-1/options");
  assert.equal(status, 404);
  assert.equal(body.error, "no_such_session");
});

// ---------------------------------------------------------------------------
// POST /interactive/:sid/message — images passthrough (Track 3 Task 9)
// ---------------------------------------------------------------------------

test("POST /interactive/:sid/message normalizes {mime,data_b64} images into pi's ImageContent shape and forwards them to eng.message", async () => {
  const b64 = Buffer.from("fake-png-bytes").toString("base64");
  const { status } = await postJson("/interactive/sess-1/message", {
    message: "look at this",
    images: [{ mime: "image/png", data_b64: b64 }],
  });
  assert.equal(status, 202);
  assert.deepEqual(engineCalls.message[0].images, [{ type: "image", data: b64, mimeType: "image/png" }]);
});

test("POST /interactive/:sid/message caps images at 3 — a 4th valid image beyond the cap never reaches the engine", async () => {
  const ok = Buffer.from("ok").toString("base64");
  const { status } = await postJson("/interactive/sess-1/message", {
    message: "hi",
    images: [
      { mime: "image/png", data_b64: ok },
      { mime: "image/gif", data_b64: ok },
      { mime: "image/webp", data_b64: ok },
      { mime: "image/jpeg", data_b64: ok }, // 4th — beyond the cap, dropped
    ],
  });
  assert.equal(status, 202);
  assert.equal(engineCalls.message[0].images.length, 3);
  assert.deepEqual(engineCalls.message[0].images.map((i) => i.mimeType), ["image/png", "image/gif", "image/webp"]);
});

test("POST /interactive/:sid/message drops an oversize (post-decode) image and a missing-mime entry, best-effort — same downloadImages() discipline, never throws", async () => {
  const ok = Buffer.from("ok").toString("base64");
  const big = Buffer.alloc(2 * 1024 * 1024 + 1, 1).toString("base64");
  const { status } = await postJson("/interactive/sess-1/message", {
    message: "hi",
    images: [
      { mime: "image/jpeg", data_b64: big }, // oversize post-decode — dropped
      { mime: "", data_b64: ok },            // missing mime — dropped
      { mime: "image/png", data_b64: ok },   // the one survivor
    ],
  });
  assert.equal(status, 202);
  assert.deepEqual(engineCalls.message[0].images, [{ type: "image", data: ok, mimeType: "image/png" }]);
});

test("POST /interactive/:sid/message omits images entirely (undefined, not []) when none are sent", async () => {
  await postJson("/interactive/sess-1/message", { message: "hi" });
  assert.equal(engineCalls.message[0].images, undefined);
});

// ---------------------------------------------------------------------------
// POST /interactive/:sid/files — base64 JSON upload into the session's uploadsDir
// ---------------------------------------------------------------------------

test("POST /interactive/:sid/files writes a sanitized-name file into the session's REAL uploadsDir", async () => {
  const uploadsDir = mkdtempSync(join(tmpdir(), "perch-uploads-"));
  engineImpl.get = async (sid) => ({ sessionId: sid, uploadsDir, outputsDir: null });
  const data = Buffer.from("hello upload");
  const { status, body } = await postJson("/interactive/sess-1/files", {
    name: "notes.txt", data_b64: data.toString("base64"),
  });
  assert.equal(status, 200);
  assert.deepEqual(body, { path: "notes.txt" });
  assert.deepEqual(readFileSync(join(uploadsDir, "notes.txt")), data);
});

test("POST /interactive/:sid/files strips directory components from name (basename) — a traversal attempt lands as a flat file, never escapes", async () => {
  const uploadsDir = mkdtempSync(join(tmpdir(), "perch-uploads-"));
  engineImpl.get = async (sid) => ({ sessionId: sid, uploadsDir, outputsDir: null });
  const { status, body } = await postJson("/interactive/sess-1/files", {
    name: "../../etc/evil.txt", data_b64: Buffer.from("x").toString("base64"),
  });
  assert.equal(status, 200);
  assert.equal(body.path, "evil.txt");
  assert.ok(readFileSync(join(uploadsDir, "evil.txt"), "utf8"));
});

test("POST /interactive/:sid/files 400s an empty name, a bare dotfile name, and a missing/empty data_b64", async () => {
  const uploadsDir = mkdtempSync(join(tmpdir(), "perch-uploads-"));
  engineImpl.get = async (sid) => ({ sessionId: sid, uploadsDir, outputsDir: null });
  const goodData = Buffer.from("x").toString("base64");
  for (const body of [
    { name: "", data_b64: goodData },
    { name: ".hidden", data_b64: goodData },
    { name: "..", data_b64: goodData },
    { name: "ok.txt", data_b64: "" },
    { name: "ok.txt" },
  ]) {
    const r = await postJson("/interactive/sess-1/files", body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.error, "bad_request", JSON.stringify(body));
  }
});

test("POST /interactive/:sid/files 400s a payload over the 5 MB post-decode cap", async () => {
  const uploadsDir = mkdtempSync(join(tmpdir(), "perch-uploads-"));
  engineImpl.get = async (sid) => ({ sessionId: sid, uploadsDir, outputsDir: null });
  const big = Buffer.alloc(5 * 1024 * 1024 + 1, 7).toString("base64");
  const { status, body } = await postJson("/interactive/sess-1/files", { name: "big.bin", data_b64: big });
  assert.equal(status, 400);
  assert.equal(body.error, "bad_request");
});

test("POST /interactive/:sid/files 409s no_session_dir when the session has never been through startChild in this process", async () => {
  engineImpl.get = async (sid) => ({ sessionId: sid, uploadsDir: null, outputsDir: null });
  const { status, body } = await postJson("/interactive/sess-1/files", { name: "ok.txt", data_b64: Buffer.from("x").toString("base64") });
  assert.equal(status, 409);
  assert.equal(body.error, "no_session_dir");
});

test("POST /interactive/:sid/files 404s no_such_session for an unknown session", async () => {
  engineImpl.get = async () => null;
  const { status, body } = await postJson("/interactive/sess-1/files", { name: "ok.txt", data_b64: Buffer.from("x").toString("base64") });
  assert.equal(status, 404);
  assert.equal(body.error, "no_such_session");
});

// ---------------------------------------------------------------------------
// no_such_session, uniformly, across the mutating routes that resolve a session
// ---------------------------------------------------------------------------

test("answer/abort/stop all 404 no_such_session for an unknown sid, through the same ERROR_MAP", async () => {
  engineImpl.answer = async () => { throw engineErr("no_such_session"); };
  engineImpl.abort = async () => { throw engineErr("no_such_session"); };
  engineImpl.stop = async () => { throw engineErr("no_such_session"); };
  for (const [path, body] of [
    ["/interactive/ghost/answer", { requestId: "r1" }],
    ["/interactive/ghost/abort", {}],
    ["/interactive/ghost/stop", {}],
  ]) {
    const r = await postJson(path, body);
    assert.equal(r.status, 404, path);
    assert.equal(r.body.error, "no_such_session", path);
  }
});

// ---------------------------------------------------------------------------
// GET /interactive/:sid/events — SSE
// ---------------------------------------------------------------------------

test("GET /interactive/:sid/events 404s an unknown session before ever opening the stream", async () => {
  engineImpl.get = async () => null;
  const { status, text } = await readSse("/interactive/ghost/events");
  assert.equal(status, 404);
  assert.equal(JSON.parse(text).error, "no_such_session");
});

test("GET /interactive/:sid/events replays state + a pending ask_user on connect, then a pushed ask_user, as single-line JSON frames", async () => {
  const pendingCard = { requestId: "r1", method: "confirm", title: "proceed?" };
  engineImpl.get = async (sid) => ({ sessionId: sid, botId: "chatty", threadId: sid, rowId: 1, state: "awake", pendingUi: pendingCard, lastError: null, model: "local/qwen" });
  engineImpl.subscribe = async (sid, fn) => {
    engineCalls.subscribe.push({ sid, fn });
    // Mirrors the real engine.subscribe(): replay state, then the pending card.
    fn({ type: "state", sessionId: sid, botId: "chatty", threadId: sid, state: "awake", lastError: null, pendingUi: pendingCard });
    fn({ type: "ask_user", ...pendingCard });
    return () => {};
  };

  const { status, text, reader } = await readSse("/interactive/sess-1/events", (buf) => sseEvents(buf).length >= 2);
  try {
    assert.equal(status, 200);
    assert.deepEqual(sseEvents(text), ["state", "ask_user"]);

    const stateEvt = sseDataAt(text, "state", 0);
    assert.equal(stateEvt.state, "awake");
    const askEvt = sseDataAt(text, "ask_user", 0);
    assert.equal(askEvt.requestId, "r1");
    assert.equal(askEvt.title, "proceed?");

    // Single-line JSON data frames: every "data: " line's payload occupies
    // EXACTLY one line — the frame separator is the blank line after it, never
    // a raw newline inside the JSON itself.
    const dataLines = text.split("\n").filter((l) => l.startsWith("data: "));
    assert.equal(dataLines.length, 2);
    for (const line of dataLines) assert.doesNotThrow(() => JSON.parse(line.slice("data: ".length)));
  } finally {
    // Every test that opens a real SSE connection must close it: an
    // uncancelled reader leaves a keep-alive socket open, which blocks
    // after()'s server.close() and hangs the whole file.
    if (reader) try { await reader.cancel(); } catch { /* already closed */ }
  }
});

test("GET /interactive/:sid/events streams text | tool | log | reply | error events verbatim", async () => {
  let push;
  engineImpl.subscribe = async (sid, fn) => {
    fn({ type: "state", sessionId: sid, state: "awake", lastError: null, pendingUi: null });
    push = fn;
    return () => {};
  };
  const res = await fetch(base + "/interactive/sess-1/events");
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const readUntil = async (n) => {
    while (sseEvents(buf).length < n) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
    }
  };
  await readUntil(1); // the initial state replay
  push({ type: "text", text: "partial reply" });
  push({ type: "tool", name: "bash", phase: "start", isError: false });
  push({ type: "log", text: "notice" });
  push({ type: "reply", text: "done" });
  await readUntil(5);
  assert.deepEqual(sseEvents(buf), ["state", "text", "tool", "log", "reply"]);
  assert.equal(sseDataAt(buf, "text", 0).text, "partial reply");
  assert.equal(sseDataAt(buf, "tool", 0).name, "bash");
  assert.equal(sseDataAt(buf, "reply", 0).text, "done");
  try { await reader.cancel(); } catch { /* already closed */ }
});

test("GET /interactive/:sid/events unsubscribes when the client disconnects — no leaked subscriber", async () => {
  const subscribers = new Set();
  engineImpl.subscribe = async (sid, fn) => {
    subscribers.add(fn);
    fn({ type: "state", sessionId: sid, state: "awake", lastError: null, pendingUi: null });
    return () => subscribers.delete(fn);
  };
  const { reader } = await readSse("/interactive/sess-1/events", (buf) => sseEvents(buf).length >= 1);
  assert.equal(subscribers.size, 1, "the stream must have subscribed exactly once");
  try { await reader.cancel(); } catch { /* already closing */ }
  const drained = await waitUntil(() => subscribers.size === 0);
  assert.ok(drained, "unsubscribe must run once res 'close' fires — a lingering subscriber is a leaked callback per connection");
});

test("a client abort DURING the subscribe await still unsubscribes — close is bound BEFORE subscribe (fix-round F1)", async () => {
  // The real engine.subscribe() can await a DB read (resolveSession→adoptRow)
  // before it registers the subscriber. A client that aborts inside that
  // window fires res 'close' while the route is still awaiting — if the close
  // handler were registered after the await (the pre-fix ordering), it would
  // never be added and the subscriber would leak for the process lifetime.
  // The fake below awaits a REAL timer: a microtask-resolving fake resolves
  // before the abort can land and can never hit the window.
  //
  // Leak detection is CUMULATIVE (added/removed counters), never a snapshot of
  // a Set's size: the subscriber is only added when the 80ms timer fires, so a
  // size===0 poll started at abort time reads true vacuously before the leak
  // even materializes (exactly how this test's first draft passed against the
  // subscribe-then-bind mutant).
  let added = 0;
  let removed = 0;
  let inWindow;
  const windowOpen = new Promise((r) => { inWindow = r; });
  engineImpl.subscribe = async (sid, fn) => {
    inWindow(); // the route is now awaiting us — the abort window is open
    await new Promise((r) => setTimeout(r, 80)); // REAL timer, not a microtask
    added++;
    fn({ type: "state", sessionId: sid, state: "awake", lastError: null, pendingUi: null });
    return () => { removed++; };
  };

  const ac = new AbortController();
  const fetched = fetch(base + "/interactive/sess-1/events", { signal: ac.signal })
    .catch(() => { /* aborted — expected */ });
  await windowOpen;
  ac.abort(); // client gone while subscribe is still in flight
  await fetched;

  const landed = await waitUntil(() => added === 1, { attempts: 60, everyMs: 10 });
  assert.ok(landed, "harness: the fake subscribe must eventually resolve and register its subscriber");
  const drained = await waitUntil(() => removed === 1, { attempts: 60, everyMs: 10 });
  assert.ok(drained, "an abort mid-subscribe must still unsubscribe — a subscriber that outlives its connection is a per-abort leak");
});

test("SSE cap reached → 503 with Retry-After, and the engine is never subscribed (fix-round F4)", async () => {
  const { openStream, _resetStreamCount, _getStreamCount } =
    await import("../servers/gateway/streams/sse.js");
  // Earlier SSE tests cancel their readers asynchronously — wait for every
  // straggler close to drain the counter, or the fill below could land one
  // short of the cap and flake.
  await waitUntil(() => _getStreamCount() === 0);
  _resetStreamCount();

  // sse-cap.test.js idiom: CROW_SSE_MAX is read at module load, so fill the
  // shared counter to the cap with stub streams rather than re-tuning the env.
  const stubRes = () => ({
    writableEnded: false, headersSent: false,
    writeHead() {}, flushHeaders() {}, write() {}, end() {}, on() {},
  });
  const MAX = parseInt(process.env.CROW_SSE_MAX || "200", 10);
  const filled = [];
  try {
    for (let i = 0; i < MAX; i++) {
      const s = openStream(stubRes(), { heartbeatMs: 1e9 });
      assert.ok(s, `filler stream ${i + 1} must open under cap`);
      filled.push(s);
    }

    const res = await fetch(base + "/interactive/sess-1/events");
    assert.equal(res.status, 503, "over-cap SSE connect must 503");
    assert.equal(res.headers.get("retry-after"), "5");
    await res.text(); // drain
    assert.equal(engineCalls.subscribe.length, 0,
      "openAuthedStream returned null — the route must bail before ever subscribing to the engine");
  } finally {
    for (const s of filled) s.close();
    _resetStreamCount();
  }
});

// ---------------------------------------------------------------------------
// unauthenticated / source-order (C-3 discipline, proven on THIS router)
// ---------------------------------------------------------------------------

test("an unauthenticated request to a REAL perch-interactive route never reaches the handler", async () => {
  const { dashboardAuth } = await import("../servers/gateway/dashboard/auth.js");
  const { default: perchInteractiveApiRouter } = await import("../servers/gateway/routes/perch-interactive-api.js");
  const { default: express } = await import("express");

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { res.redirectAfterPost = (url) => res.redirect(303, url); next(); });
  app.use(perchInteractiveApiRouter(dashboardAuth));
  const srv = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const b = "http://127.0.0.1:" + srv.address().port + "/dashboard/perch-api";
  try {
    // Off-network (bare loopback, no Tailscale headers) → hard refusal.
    const offNet = await fetch(b + "/bots/chatty/interactive", { method: "POST" });
    assert.equal(offNet.status, 403);

    // On-network but session-less → bounced to the login page, never through.
    const noSession = await fetch(b + "/bots/chatty/interactive", {
      method: "POST",
      headers: { "tailscale-user-login": "someone@example.com" },
      redirect: "manual",
    });
    assert.equal(noSession.status, 303);
    assert.equal(noSession.headers.get("location"), "/dashboard/login");

    // Same for the SSE route — a session-less caller must not even reach
    // openAuthedStream, let alone subscribe to a real session.
    const events = await fetch(b + "/interactive/sess-1/events", {
      headers: { "tailscale-user-login": "someone@example.com" },
      redirect: "manual",
    });
    assert.equal(events.status, 303);
  } finally {
    srv.close();
  }
});

test("the perch-interactive API is mounted AFTER the dashboard CSRF rail, not at app root", () => {
  const src = readFileSync(join(REPO, "servers/gateway/dashboard/index.js"), "utf8");
  const csrf = src.indexOf('router.use("/dashboard", csrfMiddleware)');
  const mount = src.indexOf("perchInteractiveApiRouter(dashboardAuth)");
  assert.ok(csrf > 0 && mount > 0, "both the CSRF rail and the perch-interactive mount must live in dashboard/index.js");
  assert.ok(mount > csrf, "the perch-interactive router must be mounted after csrfMiddleware");
  // It must also come after the P1 perch mount (README ordering, not load-bearing
  // by itself, but a regression here means someone reordered the block by hand).
  const p1Mount = src.indexOf("perchApiRouter(dashboardAuth)");
  assert.ok(p1Mount > 0 && mount > p1Mount, "the interactive mount should sit after the P1 perch mount");

  const boot = readFileSync(join(REPO, "servers/gateway/boot/feature-mounts.js"), "utf8");
  assert.equal(boot.includes("perch-interactive-api.js"), false, "an app-root mount would bypass the CSRF rail");
});

test("index.js's global 1mb JSON parser skips the files and message routes — their own route-scoped 10mb parsers must be reachable", () => {
  // Structural check (same idiom as the mount-order test above — plain
  // source inspection, never a dynamically-executed re-derivation of the
  // predicate): index.js's _hasOwnParser regex must name both routes under
  // the perch-interactive prefix, and perch-interactive-api.js must actually
  // install a bigger parser on both — a mismatch on either side would mean
  // one of the two either 413s in prod or silently double-parses.
  const indexSrc = readFileSync(join(REPO, "servers/gateway/index.js"), "utf8");
  assert.match(indexSrc, /dashboard\\\/perch-api\\\/interactive\\\/\[\^\/\]\+\\\/\(files\|message\)/,
    "_hasOwnParser must skip BOTH .../interactive/:sid/files and .../message");

  const routesSrc = readFileSync(join(REPO, "servers/gateway/routes/perch-interactive-api.js"), "utf8");
  assert.match(routesSrc, /router\.use\(P \+ "\/interactive\/:sid\/files", express\.json\(/);
  assert.match(routesSrc, /router\.use\(P \+ "\/interactive\/:sid\/message", express\.json\(/);
});

// ---------------------------------------------------------------------------
// CSRF: POST refused without a matching token, GET/SSE unaffected
// ---------------------------------------------------------------------------

function rawRequest(port, path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

test("CSRF: POST without X-Crow-Csrf is refused by the real csrfMiddleware; GET/SSE pass through unaffected", async () => {
  const { csrfMiddleware } = await import("../servers/gateway/dashboard/shared/csrf.js");
  const { default: perchInteractiveApiRouter } = await import("../servers/gateway/routes/perch-interactive-api.js");
  const { default: express } = await import("express");

  const csrfEngine = {
    async get() { return null; }, // any GET below should reach here and 404, not be CSRF-blocked
  };
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.dashboardSession = "tok"; next(); }); // stands in for dashboardAuth
  app.use(csrfMiddleware); // the REAL middleware — same rail as dashboard/index.js
  app.use(perchInteractiveApiRouter((req, res, next) => next(), { engine: csrfEngine }));
  const srv = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const port = srv.address().port;
  try {
    const cookie = "crow_session=abc; crow_csrf=tok-value";

    // POST with a session cookie present but no X-Crow-Csrf header/body field.
    const post = await rawRequest(port, "/dashboard/perch-api/interactive/sess-1/abort", {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "content-length": "2" },
      body: "{}",
    });
    assert.equal(post.status, 403);
    assert.match(post.body, /CSRF/);

    // A matching X-Crow-Csrf header passes CSRF and reaches the route (engine
    // has no /abort override here, so it 500s past csrf — proving CSRF itself
    // let it through, which is all this half of the test is for).
    const postOk = await rawRequest(port, "/dashboard/perch-api/interactive/sess-1/abort", {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "content-length": "2", "x-crow-csrf": "tok-value" },
      body: "{}",
    });
    assert.notEqual(postOk.status, 403);

    // GET (the SSE route) is a read, exempt from CSRF regardless of token —
    // reaches the handler and gets the ordinary 404 from csrfEngine.get()->null.
    const get = await rawRequest(port, "/dashboard/perch-api/interactive/sess-1/events", { headers: { cookie } });
    assert.equal(get.status, 404);
    assert.equal(JSON.parse(get.body).error, "no_such_session");
  } finally {
    srv.close();
  }
});

// ---------------------------------------------------------------------------
// default-accessor precondition (r1 S10, extended to this router's wiring)
// ---------------------------------------------------------------------------

test("constructing the router with the DEFAULT engine accessor resolves a real, fully-wired interactive engine", async () => {
  const { getInteractiveEngine, _resetInteractiveEngineForTest } = await import("../servers/gateway/perch-interactive.js");
  const { default: perchInteractiveApiRouterReal } = await import("../servers/gateway/routes/perch-interactive-api.js");
  _resetInteractiveEngineForTest();
  try {
    // No {engine} override — the factory's default IS getInteractiveEngine.
    perchInteractiveApiRouterReal((req, res, next) => next());
    const engine = getInteractiveEngine({ createIfMissing: false });
    assert.equal(engine, null, "merely constructing the router must not eagerly mint the singleton — the accessor is called per-request");

    const resolved = getInteractiveEngine();
    for (const method of ["spawn", "message", "answer", "abort", "stop", "subscribe", "get", "list", "stopAll", "_loadSeams"]) {
      assert.equal(typeof resolved[method], "function", "default engine must expose " + method);
    }
    // r1 S10, exercised from this router's own default wiring: every
    // bot-engine module + export name the interactive engine depends on
    // resolves, unspawned.
    await assert.doesNotReject(resolved._loadSeams());
  } finally {
    _resetInteractiveEngineForTest();
  }
});

// ---------------------------------------------------------------------------
// perch.js: P1 turn route refuses kind='perch-live'; sessions list carries state
// ---------------------------------------------------------------------------

test("POST /bots/:id/turn refuses a kind='perch-live' thread — the interactive engine owns it, never a per-turn claim", async () => {
  const c = raw();
  c.prepare(
    "INSERT INTO bot_sessions (bot_id,gateway_type,gateway_thread_id,kind,status) " +
    "VALUES ('chatty','perch','live-thread','perch-live','waiting-user')"
  ).run();
  c.close();
  const { status, body } = await postJson("/bots/chatty/turn", { message: "hi", sessionId: "live-thread" });
  assert.equal(status, 400);
  assert.equal(body.error, "not_a_perch_session");
  assert.equal(body.kind, "perch-live");
  assert.equal(inboundCalls.length, 0, "a per-turn POST must never spawn a second pi against the interactive engine's own session file");

  // Fix-round F5: the refusal must fire BEFORE claimTurn ever touches the row
  // — a claim written and then refused would still yank status='active' out
  // from under the interactive engine. Re-read the row: status untouched, and
  // no second row inserted (claimTurn's INSERT branch never ran either).
  const check = raw();
  const rows = check.prepare(
    "SELECT status FROM bot_sessions WHERE bot_id='chatty' AND gateway_thread_id='live-thread'"
  ).all();
  check.close();
  assert.equal(rows.length, 1, "the refusal must not have inserted a second row for the thread");
  assert.equal(rows[0].status, "waiting-user", "the perch-live row's claim must be untouched — never flipped to 'active' by a refused per-turn POST");
});

test("GET /bots/:id/sessions surfaces engine state for kind='perch-live' rows, and derives a fallback when the engine has no snapshot", async () => {
  const c = raw();
  c.prepare("INSERT INTO bot_sessions (bot_id,gateway_type,gateway_thread_id,kind,status) VALUES ('chatty','perch','live-a','perch-live','active')").run();
  c.prepare("INSERT INTO bot_sessions (bot_id,gateway_type,gateway_thread_id,kind,status) VALUES ('chatty','perch','live-b','perch-live','stopped')").run();
  c.prepare("INSERT INTO bot_sessions (bot_id,gateway_type,gateway_thread_id,kind,status) VALUES ('chatty','perch','live-c','perch-live','waiting-user')").run();
  c.prepare("INSERT INTO bot_sessions (bot_id,gateway_type,gateway_thread_id,kind,status) VALUES ('chatty','perch','plain-perch','perch','waiting-user')").run();
  c.close();

  engineImpl.get = async (sid) => (sid === "live-a" ? { sessionId: sid, state: "awake" } : null);

  const { body } = await getJson("/bots/chatty/sessions");
  const byThread = Object.fromEntries(body.sessions.map((s) => [s.gateway_thread_id, s]));

  assert.equal(byThread["live-a"].state, "awake", "the engine's own snapshot wins when it holds or can adopt the session");
  assert.equal(byThread["live-b"].state, "stopped", "no snapshot: derive from the row — stopped stays stopped");
  assert.equal(byThread["live-c"].state, "hibernating", "no snapshot: any other status derives to hibernating");
  assert.equal("state" in byThread["plain-perch"], false, "a plain kind='perch' row must not carry a state field at all");
  assert.equal(typeof byThread["live-a"].live, "boolean", "the live flag is still emitted (other kinds depend on it) — see the BADGE CONTRACT comment at the emission site");
});

test("GET /bots/:id/sessions falls back to the derived state when the engine throws", async () => {
  const c = raw();
  c.prepare("INSERT INTO bot_sessions (bot_id,gateway_type,gateway_thread_id,kind,status) VALUES ('chatty','perch','live-err','perch-live','active')").run();
  c.close();
  engineImpl.get = async () => { throw new Error("db unavailable"); };
  const { status, body } = await getJson("/bots/chatty/sessions");
  assert.equal(status, 200, "a broken engine lookup must not 500 the whole sessions list");
  const row = body.sessions.find((s) => s.gateway_thread_id === "live-err");
  assert.equal(row.state, "hibernating");
});

test("POST /narrow still accepts a kind='perch-live' row — Step 5 decision: interactive sessions ARE narrowable", async () => {
  const c = raw();
  c.prepare(
    "INSERT INTO bot_sessions (bot_id,gateway_type,gateway_thread_id,kind,status) " +
    "VALUES ('chatty','perch','live-narrow','perch-live','waiting-user')"
  ).run();
  c.close();
  const { status, body } = await postJson("/bots/chatty/sessions/live-narrow/narrow", { disabled_tools: ["bash"] });
  assert.equal(status, 200);
  assert.deepEqual(body, { ok: true });
});

test("perchAttached is imported from the shared module, not redefined locally (Track 2 §5.1)", () => {
  const src = readFileSync(join(REPO, "servers/gateway/routes/perch-interactive-api.js"), "utf8");
  assert.match(src, /import\s*\{[^}]*perchAttached[^}]*\}\s*from\s*"\.\.\/shared\/perch-attached\.js"/,
    "perch-interactive-api.js must import perchAttached from the shared module");
  assert.doesNotMatch(src, /function perchAttached\(/,
    "perch-interactive-api.js must not define its own local perchAttached — that is the duplication this task removes");
});
