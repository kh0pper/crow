/**
 * Track 3 Task 11 — GET /dashboard/perch-api/roost.
 *
 * Harness mirrors tests/perch-routes.test.js: a real init-db'd scratch crow.db
 * (CROW_DATA_DIR, so nothing can touch the operator's ~/.crow), an ephemeral
 * express server, and a fake `interactiveEngine` seam (perch.js's own
 * accessor-or-object shape) — no pi is ever spawned.
 *
 * Three router instances:
 *   - `base`    — a fake engine with a fixed `.list()` fixture; exercises the
 *                 priority fold, the card_id/control merge (incl. the
 *                 stopped-session fallback-to-engine-value case), and
 *                 occupiedCardIds (session rail + job rail).
 *   - `noEngine` — `interactiveEngine: () => null`; every consumer must fail
 *                 soft to "no live birds", not throw.
 *   - `defaultEngine` — no seam override at all (the real production default,
 *                 `getInteractiveEngine`); proves /roost never conjures a live
 *                 engine into existence just by being polled.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const dir = mkdtempSync(join(tmpdir(), "roost-strip-"));
process.env.CROW_DATA_DIR = dir;
process.env.CROW_HOME = join(dir, "home");
delete process.env.CROW_DB_PATH;

const DB_FILE = join(dir, "crow.db");
const REPO = new URL("..", import.meta.url).pathname;

function raw() {
  return new Database(DB_FILE);
}

function seedBot(botId, def, { name = botId } = {}) {
  const c = raw();
  c.prepare("INSERT OR REPLACE INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES (?,?,?,1)")
    .run(botId, name, JSON.stringify(def));
  c.close();
}

const PERCH_BOT = { gateways: [{ type: "perch" }], models: { default: "local/qwen" } };
const GMAIL_BOT = { gateways: [{ type: "gmail", address: "q@example.com", allowlist: ["a@example.com"] }] };

// Engine fixture: chatty has an awake card-bound session AND a stopped
// card-bound session (whose row is excluded from the DB card_id query below —
// its cardId in the response must fall back to the engine's own value). asker
// has a pending (waiting) card-bound session and a card-less hibernating one —
// the fold must pick 'waiting'. sleepy has one card-less hibernating session.
// empty and quiet have none.
const ENGINE_SESSIONS = [
  { sessionId: "chatty-1", botId: "chatty", state: "awake", pendingUi: null, cardId: 10 },
  { sessionId: "chatty-2", botId: "chatty", state: "stopped", pendingUi: null, cardId: 99 },
  { sessionId: "asker-a", botId: "asker", state: "awake", pendingUi: { kind: "ask" }, cardId: 11 },
  { sessionId: "asker-b", botId: "asker", state: "hibernating", pendingUi: null, cardId: null },
  { sessionId: "sleepy-1", botId: "sleepy", state: "hibernating", pendingUi: null, cardId: null },
];

let server, noEngineServer, defaultServer, base, noEngineBase, defaultBase;

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir },
    stdio: "pipe",
    cwd: REPO,
  });

  seedBot("chatty", PERCH_BOT, { name: "Chatty" });
  seedBot("asker", PERCH_BOT, { name: "Asker" });
  seedBot("sleepy", PERCH_BOT, { name: "Sleepy" });
  seedBot("empty", PERCH_BOT, { name: "Empty" });
  seedBot("quiet", GMAIL_BOT, { name: "Quiet" });

  const c = raw();
  const insSession = c.prepare(
    "INSERT INTO bot_sessions (bot_id,gateway_type,gateway_thread_id,kind,status,card_id,control) VALUES (?,?,?,?,?,?,?)"
  );
  insSession.run("chatty", "perch", "chatty-1", "perch-live", "active", 10, "run");
  // Deliberately status='stopped' — excluded from /roost's own card_id/control
  // query, so its output must fall back to the engine snapshot's own cardId.
  insSession.run("chatty", "perch", "chatty-2", "perch-live", "stopped", 99, "run");
  insSession.run("asker", "perch", "asker-a", "perch-live", "active", 11, "run");
  insSession.run("asker", "perch", "asker-b", "perch-live", "waiting-user", null, "run");
  insSession.run("sleepy", "perch", "sleepy-1", "perch-live", "waiting-user", null, "run");

  const insJob = c.prepare(
    "INSERT INTO bot_jobs (job_id, bot_id, goal, card_id, card_action, status) VALUES (?,?,?,?,?,?)"
  );
  insJob.run("job-queued", "chatty", "do the thing", 20, "execute", "queued");
  insJob.run("job-done", "chatty", "did the thing", 30, "execute", "completed");
  c.close();

  const { default: perchApiRouter } = await import("../servers/gateway/routes/perch.js");
  const { default: express } = await import("express");

  {
    const app = express();
    app.use(perchApiRouter((req, res, next) => next(), {
      interactiveEngine: () => ({ list: async () => ENGINE_SESSIONS }),
    }));
    server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
    base = "http://127.0.0.1:" + server.address().port + "/dashboard/perch-api";
  }
  {
    const app = express();
    app.use(perchApiRouter((req, res, next) => next(), { interactiveEngine: () => null }));
    noEngineServer = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
    noEngineBase = "http://127.0.0.1:" + noEngineServer.address().port + "/dashboard/perch-api";
  }
  {
    const app = express();
    app.use(perchApiRouter((req, res, next) => next())); // no seam override at all — production default
    defaultServer = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
    defaultBase = "http://127.0.0.1:" + defaultServer.address().port + "/dashboard/perch-api";
  }
});

after(() => {
  if (server) server.close();
  if (noEngineServer) noEngineServer.close();
  if (defaultServer) defaultServer.close();
  rmSync(dir, { recursive: true, force: true });
});

const getJson = async (b, path) => {
  const r = await fetch(b + path);
  return { status: r.status, body: await r.json().catch(() => null) };
};

function byId(birds) {
  return Object.fromEntries(birds.map((b) => [b.id, b]));
}

test("GET /roost returns one bird per bot def, with the spec §3.2 priority fold", async () => {
  const { status, body } = await getJson(base, "/roost");
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(byId(body.birds)).sort(), ["asker", "chatty", "empty", "quiet", "sleepy"]);

  const b = byId(body.birds);
  assert.equal(b.chatty.state, "working", "an awake session (ignoring the stopped one) folds to working");
  assert.equal(b.asker.state, "waiting", "waiting beats hibernating across two sessions of one bot");
  assert.equal(b.sleepy.state, "hibernating");
  assert.equal(b.empty.state, "idle", "a perch-attached bot with zero sessions is idle, not observing");
  assert.equal(b.quiet.state, "observing", "no complete perch gateway record — always observing");
  assert.equal(b.quiet.perch_attached, false);
  assert.equal(b.chatty.perch_attached, true);
});

test("GET /roost's session shape merges engine state with bot_sessions card_id/control", async () => {
  const { body } = await getJson(base, "/roost");
  const b = byId(body.birds);

  const chattySessions = Object.fromEntries(b.chatty.sessions.map((s) => [s.sessionId, s]));
  assert.equal(chattySessions["chatty-1"].cardId, 10);
  assert.equal(chattySessions["chatty-1"].control, "run");
  assert.equal(chattySessions["chatty-1"].pendingUi, false);
  // chatty-2's bot_sessions row is status='stopped' and therefore excluded
  // from the card_id/control query — cardId must fall back to the engine
  // snapshot's own value (99), and control (DB-only) must be null.
  assert.equal(chattySessions["chatty-2"].cardId, 99, "stopped-row fallback to the engine's own cardId");
  assert.equal(chattySessions["chatty-2"].control, null);

  const askerSessions = Object.fromEntries(b.asker.sessions.map((s) => [s.sessionId, s]));
  assert.equal(askerSessions["asker-a"].pendingUi, true);
  assert.equal(askerSessions["asker-a"].cardId, 11);
  assert.equal(askerSessions["asker-b"].cardId, null);
});

test("GET /roost's occupiedCardIds is the session rail (non-stopped) union the job rail (queued/running)", async () => {
  const { body } = await getJson(base, "/roost");
  const ids = body.occupiedCardIds.slice().sort((x, y) => x - y);
  assert.deepEqual(ids, [10, 11, 20]);
  assert.ok(!ids.includes(99), "a stopped session's card must not read as occupied");
  assert.ok(!ids.includes(30), "a completed job's card must not read as occupied");
});

test("GET /roost fails soft to no live birds when the engine is null", async () => {
  const { status, body } = await getJson(noEngineBase, "/roost");
  assert.equal(status, 200);
  const b = byId(body.birds);
  assert.equal(b.chatty.state, "idle", "no engine means no live session to report");
  assert.deepEqual(b.chatty.sessions, []);
  assert.equal(b.quiet.state, "observing", "attach state is independent of the engine");
  // occupiedCardIds is DB-derived and unaffected by the engine being absent —
  // same job-rail row seeded above, no perch-live rows in THIS server's reach
  // (same DB, so the session-rail portion is identical too).
  const ids = body.occupiedCardIds.slice().sort((x, y) => x - y);
  assert.deepEqual(ids, [10, 11, 20]);
});

test("GET /roost never conjures a live engine into existence — the production default degrades to null", async () => {
  const { status, body } = await getJson(defaultBase, "/roost");
  assert.equal(status, 200);
  const b = byId(body.birds);
  assert.equal(b.chatty.state, "idle");
  assert.deepEqual(b.chatty.sessions, []);
});
