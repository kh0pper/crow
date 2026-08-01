/**
 * Perch Hub P1, Task C-5 — servers/gateway/routes/perch.js.
 *
 * Harness: a real init-db'd scratch crow.db (CROW_DATA_DIR, so nothing can
 * touch the operator's ~/.crow), an ephemeral express server, and an INJECTED
 * handleInbound — no pi is ever spawned, no bridge turn is ever run. Engine
 * state is pinned through engine-gate's _setEngineStatusForTest because CI
 * runners have no pi installed at all.
 *
 * The one exception to "auth is not under test" is deliberate: C-3's cases
 * prove dashboardAuth refuses in isolation, which would keep passing even if
 * this router forgot to mount it. So the last block drives the REAL middleware
 * against a REAL perch route.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";

const dir = mkdtempSync(join(tmpdir(), "perch-routes-"));
process.env.CROW_DATA_DIR = dir;
process.env.CROW_HOME = join(dir, "home");
delete process.env.CROW_DB_PATH;

const DB_FILE = join(dir, "crow.db");
const REPO = new URL("..", import.meta.url).pathname;

/** Set per test: the fake handleInbound body. */
let inboundHook = null;
/** Every opts object the router handed to handleInbound. */
let inboundCalls = [];

let server, base, _setEngineStatusForTest, _resetPerchTurnsForTest;

function raw() {
  return new Database(DB_FILE);
}

function seedBot(botId, def, { name = botId, enabled = 1 } = {}) {
  const c = raw();
  c.prepare("INSERT OR REPLACE INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES (?,?,?,?)")
    .run(botId, name, JSON.stringify(def), enabled);
  c.close();
}

const PERCH_BOT = {
  gateways: [{ type: "perch" }],
  tools: { pi_builtin: ["read", "bash"], crow_mcp: ["crow-tasks/tasks_list"] },
  skills: ["govqa-portal"],
  models: { default: "local/qwen" },
  permission_policy: { multi_agent: false },
};

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir },
    stdio: "pipe",
    cwd: REPO,
  });

  seedBot("chatty", PERCH_BOT, { name: "Chatty" });
  seedBot("quiet", {
    gateways: [{ type: "gmail", address: "q@example.com", allowlist: ["a@example.com"] }],
    tools: { pi_builtin: ["read"] },
    models: { default: "local/qwen" },
  }, { name: "Quiet" });
  seedBot("multi", {
    ...PERCH_BOT,
    permission_policy: { multi_agent: true },
  }, { name: "Multi" });

  ({ _setEngineStatusForTest } = await import("../servers/gateway/dashboard/panels/bot-builder/engine-gate.js"));
  const perchModule = await import("../servers/gateway/routes/perch.js");
  ({ _resetPerchTurnsForTest } = perchModule);
  const { default: perchApiRouter } = perchModule;
  const { default: express } = await import("express");

  const app = express();
  app.use(express.json()); // the gateway installs this globally (index.js:386)
  app.use(perchApiRouter((req, res, next) => next(), {
    handleInboundImpl: (opts) => {
      inboundCalls.push(opts);
      return inboundHook(opts);
    },
  }));
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
  _resetPerchTurnsForTest();
  inboundCalls = [];
  inboundHook = async () => ({ action: "asked" });
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

/** Read an SSE response until `until(buffer)` is true (or the server closes). */
async function readSse(path, until = () => false) {
  const res = await fetch(base + path);
  if (res.status !== 200) return { status: res.status, text: await res.text() };
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    if (until(buf)) break;
  }
  try { await reader.cancel(); } catch { /* already closed */ }
  return { status: res.status, text: buf };
}

/** Every `event: <name>` in an SSE payload, in order. */
const sseEvents = (text) => [...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
/** The data payload of the first `event: <name>` block. */
function sseData(text, name) {
  const m = new RegExp("^event: " + name + "\\ndata: (.*)$", "m").exec(text);
  return m ? JSON.parse(m[1]) : null;
}

// ---------------------------------------------------------------------------
// bots + sessions
// ---------------------------------------------------------------------------

test("GET /bots reports every bot with its attach state and the engine state", async () => {
  const { status, body } = await getJson("/bots");
  assert.equal(status, 200);
  const byId = Object.fromEntries(body.bots.map((b) => [b.id, b]));
  assert.deepEqual(Object.keys(byId).sort(), ["chatty", "multi", "quiet"]);
  assert.equal(byId.chatty.name, "Chatty");
  assert.equal(byId.chatty.perch_attached, true, "a complete {type:'perch'} record is an attach");
  assert.equal(byId.quiet.perch_attached, false, "a gmail-only bot is observed, not conversable");
  assert.equal(byId.chatty.engine.state, "ready");
  assert.equal(typeof byId.chatty.runtime_on, "boolean");

  _setEngineStatusForTest({ state: "absent" });
  const absent = await getJson("/bots");
  assert.equal(absent.body.bots[0].engine.state, "absent");
});

test("GET /bots/:id/sessions surfaces channel, board and narrowing columns", async () => {
  const c = raw();
  c.prepare(
    "INSERT INTO bot_sessions (bot_id,gateway_type,gateway_thread_id,kind,status,card_id,plan_path,narrowed_tools) " +
    "VALUES ('chatty','gmail','thread-gmail','chat','waiting-user',42,'/plans/42.md',NULL)"
  ).run();
  c.prepare(
    "INSERT INTO bot_sessions (bot_id,gateway_type,gateway_thread_id,kind,status,narrowed_tools) " +
    "VALUES ('chatty','perch','thread-perch','perch','waiting-user','[\"bash\"]')"
  ).run();
  c.close();

  const { status, body } = await getJson("/bots/chatty/sessions");
  assert.equal(status, 200);
  const byThread = Object.fromEntries(body.sessions.map((s) => [s.gateway_thread_id, s]));
  assert.equal(byThread["thread-gmail"].gateway_type, "gmail");
  assert.equal(byThread["thread-gmail"].card_id, 42);
  assert.equal(byThread["thread-gmail"].plan_path, "/plans/42.md");
  assert.equal(byThread["thread-gmail"].live, false);
  assert.ok(byThread["thread-gmail"].updated_at, "the lens renders a timestamp");
  // PL-2 finding #1: the envelope endpoint is per-BOT, so the controls pane
  // can only learn a SESSION's narrowing from this row.
  assert.equal(byThread["thread-perch"].narrowed_tools, '["bash"]');
  assert.equal(byThread["thread-gmail"].narrowed_tools, null);
});

test("GET /bots/:id/sessions marks a fresh active row live, a stale one not", async () => {
  const c = raw();
  c.prepare(
    "INSERT INTO bot_sessions (bot_id,gateway_type,gateway_thread_id,status,updated_at) " +
    "VALUES ('livebot','perch','fresh','active',datetime('now'))"
  ).run();
  c.prepare(
    "INSERT INTO bot_sessions (bot_id,gateway_type,gateway_thread_id,status,updated_at) " +
    "VALUES ('livebot','perch','stale','active',datetime('now','-3 hours'))"
  ).run();
  c.close();
  const { body } = await getJson("/bots/livebot/sessions");
  const byThread = Object.fromEntries(body.sessions.map((s) => [s.gateway_thread_id, s]));
  assert.equal(byThread.fresh.live, true);
  assert.equal(byThread.stale.live, false, "an aged-out claim must be reclaimable, not eternally 'live'");
});

// ---------------------------------------------------------------------------
// envelope
// ---------------------------------------------------------------------------

test("GET /bots/:id/envelope splits the def's grant into allowed and known-denied", async () => {
  const { status, body } = await getJson("/bots/chatty/envelope");
  assert.equal(status, 200);
  assert.deepEqual(body.tools.map((t) => t.id), ["read", "bash", "mcp__crow-tasks__tasks_list"]);
  assert.ok(body.tools.every((t) => t.allowed === true));
  // MCP ids render in Bot Builder's vocabulary, not pi's wire name.
  assert.equal(body.tools[2].label, "crow-tasks/tasks_list");
  assert.deepEqual(body.denied.map((t) => t.id), ["edit", "write", "list", "glob", "grep"]);
  assert.deepEqual(body.skills, ["govqa-portal"]);
  assert.equal(body.model, "local/qwen");
  assert.equal(body.tools.some((t) => t.id === "subagent"), false);
});

test("GET /bots/:id/envelope lists subagent as narrowable only under the multi_agent opt-in", async () => {
  const { body } = await getJson("/bots/multi/envelope");
  assert.equal(body.tools.some((t) => t.id === "subagent"), true);
  assert.equal(body.denied.some((t) => t.id === "subagent"), false);
});

test("GET /bots/:id/envelope 404s an unknown bot", async () => {
  assert.equal((await getJson("/bots/nope/envelope")).status, 404);
});

// ---------------------------------------------------------------------------
// turns
// ---------------------------------------------------------------------------

test("POST /turn 202s, passes the perch channel through, and streams the reply", async () => {
  inboundHook = async (opts) => {
    await opts.log("thinking");
    await opts.sendReply("hello from the bot");
    return { action: "asked" };
  };
  const { status, body } = await postJson("/bots/chatty/turn", { message: "hi" });
  assert.equal(status, 202);
  assert.ok(body.turnId);
  assert.ok(body.sessionId.startsWith("perch-"));

  assert.equal(inboundCalls.length, 1);
  assert.equal(inboundCalls[0].gateway_type, "perch");
  assert.equal(inboundCalls[0].bot_id, "chatty");
  assert.equal(inboundCalls[0].user_message, "hi");
  assert.equal(inboundCalls[0].kind, "perch"); // ignored today; C-6 plumbs it

  const { text } = await readSse("/turns/" + body.turnId + "/events");
  assert.deepEqual(sseEvents(text), ["log", "reply"]);
  assert.equal(sseData(text, "reply").text, "hello from the bot");

  // The session row the turn claimed is a real perch row.
  const c = raw();
  const row = c.prepare("SELECT gateway_type, status FROM bot_sessions WHERE bot_id='chatty' AND gateway_thread_id=?").get(body.sessionId);
  c.close();
  assert.equal(row.gateway_type, "perch");
  assert.equal(row.status, "waiting-user", "a finished turn must not leave a live claim behind");
});

test("SSE fans out to a listener attached while the turn is still running", async () => {
  let release;
  inboundHook = (opts) => new Promise((resolve) => {
    release = async () => { await opts.sendReply("late answer"); resolve({ action: "asked" }); };
  });
  const { body } = await postJson("/bots/chatty/turn", { message: "wait for it" });
  const streamed = readSse("/turns/" + body.turnId + "/events", (buf) => buf.includes("event: reply"));
  await new Promise((r) => setTimeout(r, 50)); // let the stream attach
  await release();
  const { text } = await streamed;
  assert.deepEqual(sseEvents(text), ["reply"]);
  assert.equal(sseData(text, "reply").text, "late answer");
});

test("a deferred turn (pi at capacity) ends with a terminal error — there is no tick to retry it", async () => {
  inboundHook = async () => ({ action: "deferred", reason: "pi-capacity", livePi: 3 });
  const { body } = await postJson("/bots/chatty/turn", { message: "hi" });
  await new Promise((r) => setTimeout(r, 50));
  const { text } = await readSse("/turns/" + body.turnId + "/events");
  assert.deepEqual(sseEvents(text), ["error"]);
  assert.match(sseData(text, "error").text, /busy/);
  // A deferral never wrote a session row, so the claim must be released.
  const c = raw();
  const row = c.prepare("SELECT status FROM bot_sessions WHERE bot_id='chatty' AND gateway_thread_id=?").get(body.sessionId);
  c.close();
  assert.equal(row.status, "waiting-user");
});

test("an {action:'error'} turn reports the bridge's own message once, not twice", async () => {
  inboundHook = async (opts) => {
    await opts.sendReply("(bridge error: pi exited)");
    return { action: "error", error: "pi exited" };
  };
  const { body } = await postJson("/bots/chatty/turn", { message: "hi" });
  await new Promise((r) => setTimeout(r, 50));
  const { text } = await readSse("/turns/" + body.turnId + "/events");
  assert.deepEqual(sseEvents(text), ["reply"], "the failure was already delivered via sendReply");
  assert.match(sseData(text, "reply").text, /bridge error/);
});

test("a turn that replies and THEN blows up stays a single terminal event", async () => {
  // The bridge's failure paths deliver through sendReply and only then return
  // (or throw). A late error must not append a second terminal event: the lens
  // finishes the card on the first one, and a replaying client would otherwise
  // see the turn both answered and failed.
  inboundHook = async (opts) => {
    await opts.sendReply("here is your answer");
    throw new Error("cleanup exploded after the reply");
  };
  const { body } = await postJson("/bots/chatty/turn", { message: "hi" });
  await new Promise((r) => setTimeout(r, 50));
  const { text } = await readSse("/turns/" + body.turnId + "/events");
  assert.deepEqual(sseEvents(text), ["reply"]);
  assert.equal(sseData(text, "reply").text, "here is your answer");
});

test("a log emitted after the turn is terminal is dropped, not replayed", async () => {
  inboundHook = async (opts) => {
    await opts.sendReply("answered");
    opts.log("a straggler line from a dying child");
    return { action: "asked" };
  };
  const { body } = await postJson("/bots/chatty/turn", { message: "hi" });
  await new Promise((r) => setTimeout(r, 50));
  const { text } = await readSse("/turns/" + body.turnId + "/events");
  assert.deepEqual(sseEvents(text), ["reply"]);
});

test("a pre-flight throw becomes a terminal error event", async () => {
  inboundHook = async () => { throw new Error("unknown bot: chatty"); };
  const { body } = await postJson("/bots/chatty/turn", { message: "hi" });
  await new Promise((r) => setTimeout(r, 50));
  const { text } = await readSse("/turns/" + body.turnId + "/events");
  assert.deepEqual(sseEvents(text), ["error"]);
  assert.match(sseData(text, "error").text, /unknown bot/);
});

test("one turn per thread: a second POST is refused while the first is in flight, and allowed after", async () => {
  let release;
  inboundHook = (opts) => new Promise((resolve) => {
    release = async () => { await opts.sendReply("done"); resolve({ action: "asked" }); };
  });
  const first = await postJson("/bots/chatty/turn", { message: "one", sessionId: "serial-thread" });
  assert.equal(first.status, 202);
  const second = await postJson("/bots/chatty/turn", { message: "two", sessionId: "serial-thread" });
  assert.equal(second.status, 409);
  assert.equal(second.body.error, "turn_in_progress");
  assert.equal(inboundCalls.length, 1, "the refused turn must never reach the bridge");

  await release();
  await new Promise((r) => setTimeout(r, 50));
  inboundHook = async (opts) => { await opts.sendReply("second"); return { action: "asked" }; };
  const third = await postJson("/bots/chatty/turn", { message: "three", sessionId: "serial-thread" });
  assert.equal(third.status, 202);
});

test("a stale DB claim from a gateway that died mid-turn does not wedge the thread", async () => {
  const c = raw();
  c.prepare(
    "INSERT INTO bot_sessions (bot_id,gateway_type,gateway_thread_id,status,updated_at) " +
    "VALUES ('chatty','perch','wedged','active',datetime('now','-3 hours'))"
  ).run();
  c.close();
  const r = await postJson("/bots/chatty/turn", { message: "still there?", sessionId: "wedged" });
  assert.equal(r.status, 202);
});

test("a fresh DB claim blocks a turn even with an empty in-memory map (restart mid-turn)", async () => {
  const c = raw();
  c.prepare(
    "INSERT INTO bot_sessions (bot_id,gateway_type,gateway_thread_id,status,updated_at) " +
    "VALUES ('chatty','perch','restarted','active',datetime('now'))"
  ).run();
  c.close();
  _resetPerchTurnsForTest(); // simulate: this process knows nothing of that turn
  const r = await postJson("/bots/chatty/turn", { message: "hello?", sessionId: "restarted" });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "turn_in_progress");
});

test("turn guards: engine absent 409s, an unattached bot 403s, an empty message 400s", async () => {
  _setEngineStatusForTest({ state: "absent" });
  const noEngine = await postJson("/bots/chatty/turn", { message: "hi" });
  assert.equal(noEngine.status, 409);
  assert.equal(noEngine.body.error, "engine_required");

  _setEngineStatusForTest({ state: "ready", source: "test", cliPath: "/nonexistent/pi" });
  const notAttached = await postJson("/bots/quiet/turn", { message: "hi" });
  assert.equal(notAttached.status, 403);
  assert.equal(notAttached.body.error, "perch_not_attached");

  const empty = await postJson("/bots/chatty/turn", { message: "   " });
  assert.equal(empty.status, 400);
  assert.equal((await postJson("/bots/nope/turn", { message: "hi" })).status, 404);
  assert.equal(inboundCalls.length, 0, "no guard may let a turn through to the bridge");
});

test("the turn message is capped at 32k before it reaches the bridge", async () => {
  await postJson("/bots/chatty/turn", { message: "x".repeat(50000) });
  assert.equal(inboundCalls[0].user_message.length, 32000);
});

test("GET /turns/:id/events 404s an unknown turn", async () => {
  const r = await fetch(base + "/turns/does-not-exist/events");
  assert.equal(r.status, 404);
  assert.equal((await r.json()).error, "unknown_turn");
});

// ---------------------------------------------------------------------------
// narrowing
// ---------------------------------------------------------------------------

test("POST /narrow accepts a subset of the envelope and stores it on the session row", async () => {
  const r = await postJson("/bots/chatty/sessions/narrow-a/narrow", { disabled_tools: ["bash"] });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  const c = raw();
  const rows = c.prepare("SELECT * FROM bot_sessions WHERE bot_id='chatty' AND gateway_thread_id='narrow-a'").all();
  c.close();
  assert.equal(rows.length, 1, "narrowing a never-run thread upserts exactly one row");
  assert.equal(rows[0].narrowed_tools, '["bash"]');
  assert.equal(rows[0].gateway_type, "perch");
  assert.equal(rows[0].kind, "perch");
  assert.notEqual(rows[0].status, "active", "an upserted narrowing row must not read as a turn in progress");
});

test("POST /narrow rejects widening — unknown ids and def-denied ids alike", async () => {
  const unknown = await postJson("/bots/chatty/sessions/narrow-b/narrow", { disabled_tools: ["read", "teleport"] });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.error, "widening_rejected");
  assert.deepEqual(unknown.body.offending, ["teleport"]);

  // `edit` is a real pi builtin this def does NOT grant: naming it is an
  // attempt to act on something outside the envelope.
  const denied = await postJson("/bots/chatty/sessions/narrow-b/narrow", { disabled_tools: ["edit"] });
  assert.equal(denied.status, 400);
  assert.deepEqual(denied.body.offending, ["edit"]);

  const bad = await postJson("/bots/chatty/sessions/narrow-b/narrow", { disabled_tools: "bash" });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, "bad_request");

  const c = raw();
  const rows = c.prepare("SELECT id FROM bot_sessions WHERE bot_id='chatty' AND gateway_thread_id='narrow-b'").all();
  c.close();
  assert.equal(rows.length, 0, "a rejected narrowing must not create a row");
});

test("two consecutive narrows on one thread leave exactly ONE row, and the next turn reuses it", async () => {
  await postJson("/bots/chatty/sessions/narrow-c/narrow", { disabled_tools: ["bash"] });
  await postJson("/bots/chatty/sessions/narrow-c/narrow", { disabled_tools: ["read", "bash"] });
  const c = raw();
  const rows = c.prepare("SELECT id, narrowed_tools FROM bot_sessions WHERE bot_id='chatty' AND gateway_thread_id='narrow-c'").all();
  c.close();
  assert.equal(rows.length, 1, "ON CONFLICT is unusable here — the index is not unique; the upsert must be a transaction");
  assert.equal(rows[0].narrowed_tools, '["read","bash"]');

  inboundHook = async (opts) => { await opts.sendReply("ok"); return { action: "asked" }; };
  const turn = await postJson("/bots/chatty/turn", { message: "hi", sessionId: "narrow-c" });
  assert.equal(turn.status, 202);
  await new Promise((r) => setTimeout(r, 50));
  const c2 = raw();
  const after = c2.prepare("SELECT id, narrowed_tools FROM bot_sessions WHERE bot_id='chatty' AND gateway_thread_id='narrow-c'").all();
  c2.close();
  assert.equal(after.length, 1, "the turn must claim the SAME row the narrowing created");
  assert.equal(after[0].id, rows[0].id);
  assert.equal(after[0].narrowed_tools, '["read","bash"]', "claiming a turn must not erase the narrowing");
});

test("narrowed_tools is a real column, declared BOTH ways (the #250 convention)", () => {
  const c = raw();
  const cols = c.prepare("PRAGMA table_info(bot_sessions)").all().map((r) => r.name);
  c.close();
  assert.ok(cols.includes("narrowed_tools"), "a freshly init-db'd database must carry the column");

  // A fresh DB gets it from the CREATE body; an install that already has the
  // table gets it from the guarded ALTER. Only the pair covers both, and a
  // fresh-DB assertion alone cannot tell which one supplied it.
  const src = readFileSync(join(REPO, "scripts/init-db.js"), "utf8");
  assert.match(src, /narrowed_tools\s+TEXT,/, "the CREATE body must declare the column for fresh installs");
  assert.match(src, /addColumnIfMissing\("bot_sessions", "narrowed_tools", "TEXT"\)/,
    "pre-existing installs need the guarded ALTER");
  assert.equal(/SCHEMA_GENERATION = 8/.test(readFileSync(join(REPO, "servers/shared/schema-version.js"), "utf8")), true,
    "an additive column must not bump the schema generation");
});

// ---------------------------------------------------------------------------
// transcripts
// ---------------------------------------------------------------------------

test("GET transcript resolves the session file by GLOB and skips unparseable lines", async () => {
  const sessions = join(dir, "sessions-a");
  mkdirSync(sessions, { recursive: true });
  const uuid = "019eeb17-0000-7000-8000-aaaaaaaaaaaa";
  // Real on-disk shape: <ISO>_<uuid>.jsonl — join(dir, uuid + ".jsonl") 404s.
  writeFileSync(join(sessions, "2026-06-21T16-50-50-013Z_" + uuid + ".jsonl"),
    JSON.stringify({ type: "session", version: 1, id: uuid, cwd: "/tmp" }) + "\n" +
    JSON.stringify({ type: "model_change", model: "local/qwen" }) + "\n" +
    "{ this line is half-written\n" +
    JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: "hello" } }) + "\n");
  const c = raw();
  c.prepare(
    "INSERT INTO bot_sessions (bot_id,gateway_type,gateway_thread_id,pi_session_dir,pi_session_id,status) " +
    "VALUES ('chatty','perch','t-script',?,?,'waiting-user')"
  ).run(sessions, uuid);
  c.close();

  const { status, body } = await getJson("/bots/chatty/sessions/t-script/transcript");
  assert.equal(status, 200);
  assert.deepEqual(body.events.map((e) => e.type), ["session", "model_change", "message"]);
  assert.equal(body.events[2].message.role, "user");
  assert.equal(body.truncated, false);
  assert.equal(body.omitted, 0);
});

test("GET transcript TAIL-truncates: the newest turns survive, the oldest are counted", async () => {
  const sessions = join(dir, "sessions-big");
  mkdirSync(sessions, { recursive: true });
  const uuid = "019eeb17-0000-7000-8000-bbbbbbbbbbbb";
  const lines = [];
  for (let i = 0; i < 2500; i++) {
    lines.push(JSON.stringify({ type: "message", id: "m" + i, message: { role: "user", content: "line " + i } }));
  }
  writeFileSync(join(sessions, "2026-06-21T16-50-50-013Z_" + uuid + ".jsonl"), lines.join("\n") + "\n");
  const c = raw();
  c.prepare(
    "INSERT INTO bot_sessions (bot_id,gateway_type,gateway_thread_id,pi_session_dir,pi_session_id,status) " +
    "VALUES ('chatty','perch','t-big',?,?,'waiting-user')"
  ).run(sessions, uuid);
  c.close();

  const { body } = await getJson("/bots/chatty/sessions/t-big/transcript");
  assert.equal(body.events.length, 2000);
  assert.equal(body.truncated, true);
  assert.equal(body.omitted, 500);
  assert.equal(body.events[0].id, "m500", "head-truncation would hide today's turns");
  assert.equal(body.events[1999].id, "m2499");
});

test("GET transcript 404s when there is no row, no dir, or no matching file", async () => {
  assert.equal((await getJson("/bots/chatty/sessions/never-existed/transcript")).status, 404);

  const c = raw();
  c.prepare(
    "INSERT INTO bot_sessions (bot_id,gateway_type,gateway_thread_id,pi_session_dir,pi_session_id,status) " +
    "VALUES ('chatty','perch','t-nofile',?,'019eeb17-0000-7000-8000-cccccccccccc','waiting-user')"
  ).run(join(dir, "sessions-a"));
  c.close();
  const r = await getJson("/bots/chatty/sessions/t-nofile/transcript");
  assert.equal(r.status, 404);
  assert.equal(r.body.error, "no_transcript");
});

// ---------------------------------------------------------------------------
// the auth gate, on a REAL route
// ---------------------------------------------------------------------------

test("an unauthenticated request to a REAL perch route never reaches the handler", async () => {
  const { dashboardAuth } = await import("../servers/gateway/dashboard/auth.js");
  const { default: perchApiRouter } = await import("../servers/gateway/routes/perch.js");
  const { default: express } = await import("express");

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { res.redirectAfterPost = (url) => res.redirect(303, url); next(); });
  app.use(perchApiRouter(dashboardAuth));
  const srv = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const b = "http://127.0.0.1:" + srv.address().port + "/dashboard/perch-api";
  try {
    // Bare loopback, no Tailscale identity → hard network refusal.
    const offNet = await fetch(b + "/bots");
    assert.equal(offNet.status, 403);
    assert.equal((await offNet.text()).includes("bots"), false, "no bot list may leak past the gate");

    // On-network but session-less → bounced to the login page.
    const noSession = await fetch(b + "/bots", {
      headers: { "tailscale-user-login": "someone@example.com" },
      redirect: "manual",
    });
    assert.equal(noSession.status, 303);
    assert.equal(noSession.headers.get("location"), "/dashboard/login");

    // Same for a mutating route: a session-less caller cannot drive a bot.
    const turn = await fetch(b + "/bots/chatty/turn", {
      method: "POST",
      headers: { "content-type": "application/json", "tailscale-user-login": "someone@example.com" },
      body: JSON.stringify({ message: "hi" }),
      redirect: "manual",
    });
    assert.equal(turn.status, 303);
    assert.equal(inboundCalls.length, 0);
  } finally {
    srv.close();
  }
});

test("the perch API is mounted AFTER the dashboard CSRF rail, not at app root", () => {
  // Mounting it beside bot-board-api in boot/feature-mounts.js would run it
  // BEFORE dashboard/index.js's csrfMiddleware — the router would answer and
  // never call next(), silently dropping CSRF for every mutating perch route.
  const src = readFileSync(join(REPO, "servers/gateway/dashboard/index.js"), "utf8");
  const csrf = src.indexOf('router.use("/dashboard", csrfMiddleware)');
  const mount = src.indexOf("perchApiRouter(dashboardAuth)");
  assert.ok(csrf > 0 && mount > 0, "both the CSRF rail and the perch mount must live in dashboard/index.js");
  assert.ok(mount > csrf, "the perch router must be mounted after csrfMiddleware");

  const boot = readFileSync(join(REPO, "servers/gateway/boot/feature-mounts.js"), "utf8");
  assert.equal(boot.includes("perch.js"), false, "an app-root mount would bypass the CSRF rail");
});
