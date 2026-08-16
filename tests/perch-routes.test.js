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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from "node:fs";
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
  // C-6 made `kind` real on bridge-created rows too, so the payload carries it
  // as a first-class field (before C-6 the lens had to key badges off
  // gateway_type alone).
  assert.equal(byThread["thread-gmail"].kind, "chat");
  assert.equal(byThread["thread-perch"].kind, "perch");
});

test("GET /bots/:id/sessions surfaces the control column — Track 3 Task 9, Task 13's interrupted-note UI reads it", async () => {
  const c = raw();
  c.prepare(
    "INSERT INTO bot_sessions (bot_id,gateway_type,gateway_thread_id,kind,status,control) " +
    "VALUES ('chatty','perch','thread-run','perch-live','waiting-user','run')"
  ).run();
  c.prepare(
    "INSERT INTO bot_sessions (bot_id,gateway_type,gateway_thread_id,kind,status,control) " +
    "VALUES ('chatty','perch','thread-interrupted','perch-live','waiting-user','interrupted')"
  ).run();
  c.close();

  const { body } = await getJson("/bots/chatty/sessions");
  const byThread = Object.fromEntries(body.sessions.map((s) => [s.gateway_thread_id, s]));
  assert.equal(byThread["thread-run"].control, "run");
  assert.equal(byThread["thread-interrupted"].control, "interrupted");
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

test("GET /bots/:id/sessions is capped, and says so rather than dumping every row", async () => {
  // A long-lived gmail bot gets one row per THREAD, and duplicate rows per
  // (bot, thread) are tolerated by design (getSession takes the newest), so
  // this table only ever grows. An uncapped ORDER BY id DESC hands the lens
  // the entire history in one JSON body.
  const c = raw();
  const ins = c.prepare(
    "INSERT INTO bot_sessions (bot_id,gateway_type,gateway_thread_id,status) VALUES ('crowded','gmail',?,'waiting-user')"
  );
  for (let i = 0; i < 60; i++) ins.run("t" + String(i).padStart(3, "0"));
  c.close();

  const { body } = await getJson("/bots/crowded/sessions");
  assert.equal(body.sessions.length, 50);
  assert.equal(body.limit, 50);
  assert.equal(body.truncated, true, "the lens cannot be honest about a cap it is not told about");
  // Newest first — a cap that kept the OLDEST rows would hide today's work.
  assert.equal(body.sessions[0].gateway_thread_id, "t059");
  assert.equal(body.sessions[49].gateway_thread_id, "t010");
});

test("a bot under the cap is not reported as truncated", async () => {
  const c = raw();
  const ins = c.prepare(
    "INSERT INTO bot_sessions (bot_id,gateway_type,gateway_thread_id,status) VALUES ('sparse','perch',?,'waiting-user')"
  );
  for (let i = 0; i < 3; i++) ins.run("s" + i);
  c.close();
  const { body } = await getJson("/bots/sparse/sessions");
  assert.equal(body.sessions.length, 3);
  assert.equal(body.truncated, false);
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
    await opts.log("thinking\nhard");
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
  assert.equal(inboundCalls[0].kind, "perch"); // C-6 plumbs this through to the row

  const { text } = await readSse("/turns/" + body.turnId + "/events");
  assert.deepEqual(sseEvents(text), ["log", "reply"]);
  assert.equal(sseData(text, "reply").text, "hello from the bot");
  // The lens writes `log` straight into the pending line as raw e.data (it
  // JSON-parses only the terminal events), and a raw newline would split the
  // SSE frame — so a log arrives as one plain, single-line string.
  assert.match(text, /^data: thinking hard$/m);

  // The session row the turn claimed is a real perch row.
  const c = raw();
  const row = c.prepare("SELECT gateway_type, kind, status FROM bot_sessions WHERE bot_id='chatty' AND gateway_thread_id=?").get(body.sessionId);
  c.close();
  assert.equal(row.gateway_type, "perch");
  // `kind` comes from claimTurn's INSERT here (handleInbound is injected in this
  // file, so the bridge's own upsert never runs). The C-6 plumb that makes the
  // BRIDGE-created INSERT carry it is proven end-to-end in perch-narrowing.test.js.
  assert.equal(row.kind, "perch");
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

test("the in-flight guard is taken BEFORE the first await, so two concurrent turns cannot both start", async () => {
  // The guard is only meaningful if nothing can yield between the check and
  // the claim. The one real yield on that path is the lazy bridge import on a
  // gateway's first turn — a genuine module load, not a microtask — so this
  // drives a router through `loadBridgeImpl` to reproduce exactly that window.
  // Injecting `handleInboundImpl` instead would short-circuit before the
  // import and prove nothing: microtask-only awaits can never interleave with
  // another request, which is why the defect is invisible to the other tests.
  const { default: perchApiRouter } = await import("../servers/gateway/routes/perch.js");
  const { default: express } = await import("express");

  const started = [];
  const app = express();
  app.use(express.json());
  app.use(perchApiRouter((req, res, next) => next(), {
    loadBridgeImpl: async () => {
      await new Promise((r) => setTimeout(r, 40)); // the real import's cost
      return {
        handleInbound: (opts) => {
          started.push(opts);
          return new Promise(() => {}); // a turn that is still running
        },
      };
    },
  }));
  const srv = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const b = "http://127.0.0.1:" + srv.address().port + "/dashboard/perch-api";
  const post = () => fetch(b + "/bots/chatty/turn", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "race", sessionId: "toctou-thread" }),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

  try {
    const [one, two] = await Promise.all([post(), post()]);
    assert.deepEqual([one.status, two.status].sort(), [202, 409],
      "exactly one of two simultaneous turns may be admitted");
    assert.equal((one.status === 409 ? one : two).body.error, "turn_in_progress");
    assert.equal(started.length, 1,
      "two pi processes resuming ONE session file corrupts the transcript — that is what the guard is for");
  } finally {
    srv.close();
    _resetPerchTurnsForTest(); // the admitted turn never resolves
  }
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

// --- F1: sessionId is caller-supplied, so it can name ANOTHER channel's thread -
//
// Traced failure this pins shut: pass a live gmail thread id and claimTurn()
// flips that row to active → the bridge's getSession() RESUMES it → the perch
// message lands in the gmail conversation's pi session file → upsertSession()
// relabels the row `perch` permanently, and the lens badges off gateway_type so
// nothing ever shows it happened.

test("POST /turn refuses to hijack a gmail thread, and leaves its row untouched", async () => {
  const c = raw();
  c.prepare(
    "INSERT INTO bot_sessions (bot_id,gateway_type,gateway_thread_id,kind,status,pi_session_id,pi_session_dir,updated_at) " +
    "VALUES ('chatty','gmail','198f0c2a11bd7e4c','chat','waiting-user','gmail-uuid','/tmp/gmail-sessions',datetime('now','-2 days'))"
  ).run();
  c.close();

  const r = await postJson("/bots/chatty/turn", { message: "hijack", sessionId: "198f0c2a11bd7e4c" });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "not_a_perch_session");
  assert.equal(r.body.gateway_type, "gmail", "the refusal names the channel that actually owns the thread");
  assert.equal(inboundCalls.length, 0, "the bridge must never be handed a turn aimed at another channel");

  const after = raw();
  const row = after.prepare(
    "SELECT gateway_type, kind, status, pi_session_id FROM bot_sessions WHERE bot_id='chatty' AND gateway_thread_id='198f0c2a11bd7e4c'"
  ).get();
  after.close();
  assert.equal(row.gateway_type, "gmail", "the row must not be relabelled");
  assert.equal(row.kind, "chat");
  assert.equal(row.pi_session_id, "gmail-uuid", "…and its pi session must stay attached to gmail");
  assert.equal(row.status, "waiting-user", "…and it must not be left claimed 'active'");
});

test("a refused hijack does not leave the thread wedged or reported live", async () => {
  // The in-flight guard is taken before the channel check (it has to be — see
  // the TOCTOU test), so every refusal AFTER it must hand the guard back.
  // A leak here would be silent and permanent: the thread would answer 409
  // turn_in_progress forever, and GET /sessions would badge it `live`.
  const c = raw();
  c.prepare(
    "INSERT INTO bot_sessions (bot_id,gateway_type,gateway_thread_id,kind,status,updated_at) " +
    "VALUES ('chatty','discord','wedge-check','chat','waiting-user',datetime('now','-1 day'))"
  ).run();
  c.close();

  const first = await postJson("/bots/chatty/turn", { message: "one", sessionId: "wedge-check" });
  assert.equal(first.status, 400);
  const second = await postJson("/bots/chatty/turn", { message: "two", sessionId: "wedge-check" });
  assert.equal(second.status, 400, "a second attempt must still get the HONEST refusal, not 409");
  assert.equal(second.body.error, "not_a_perch_session");

  const { body } = await getJson("/bots/chatty/sessions");
  const row = body.sessions.find((s) => s.gateway_thread_id === "wedge-check");
  assert.equal(row.live, false, "a refused turn must never leave a thread badged live");
});

test("a thread refused for a fresh DB claim becomes usable again once the claim ages out", async () => {
  const c = raw();
  c.prepare(
    "INSERT INTO bot_sessions (bot_id,gateway_type,gateway_thread_id,status,updated_at) " +
    "VALUES ('chatty','perch','ages-out','active',datetime('now'))"
  ).run();
  c.close();
  assert.equal((await postJson("/bots/chatty/turn", { message: "hi", sessionId: "ages-out" })).status, 409);

  // The gateway that owned that claim is gone; the row ages past one turn
  // budget. Nothing in THIS process may still be holding the thread.
  const c2 = raw();
  c2.prepare("UPDATE bot_sessions SET updated_at=datetime('now','-3 hours') WHERE gateway_thread_id='ages-out'").run();
  c2.close();
  inboundHook = async (opts) => { await opts.sendReply("back"); return { action: "asked" }; };
  assert.equal((await postJson("/bots/chatty/turn", { message: "hi again", sessionId: "ages-out" })).status, 202);
  await new Promise((r) => setTimeout(r, 50));
});

test("POST /turn still resumes a perch thread, and still opens a brand-new one", async () => {
  // The guard is a channel check, not a blanket ban on `sessionId`: the two
  // legitimate cases must keep working or the chat card can never hold a
  // conversation. (Without this pair the F1 fix could be a wholesale refusal.)
  const c = raw();
  c.prepare(
    "INSERT INTO bot_sessions (bot_id,gateway_type,gateway_thread_id,kind,status,updated_at) " +
    "VALUES ('chatty','perch','mine-to-resume','perch','waiting-user',datetime('now','-1 hour'))"
  ).run();
  // A pre-channel legacy row (gateway_type NULL) is not evidence of another
  // channel, so it stays usable rather than becoming permanently unreachable.
  c.prepare(
    "INSERT INTO bot_sessions (bot_id,gateway_thread_id,status,updated_at) " +
    "VALUES ('chatty','legacy-null-channel','waiting-user',datetime('now','-1 hour'))"
  ).run();
  c.close();

  inboundHook = async (opts) => { await opts.sendReply("resumed"); return { action: "asked" }; };
  assert.equal((await postJson("/bots/chatty/turn", { message: "again", sessionId: "mine-to-resume" })).status, 202);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await postJson("/bots/chatty/turn", { message: "again", sessionId: "legacy-null-channel" })).status, 202);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await postJson("/bots/chatty/turn", { message: "fresh" })).status, 202);
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

// --- F2: narrowing is a PERCH-session concept in P1 --------------------------
//
// The narrow route is keyed by gateway_thread_id, which the caller supplies, so
// without a channel check an operator could permanently strip `bash` from a
// production gmail thread from inside Perch — and Bot Builder, the declared
// single writer of the envelope, would show nothing. Cross-channel narrowing is
// a Phase-2 question; it needs Bot Builder visibility first.

test("POST /narrow refuses a gmail session row and leaves its capabilities alone", async () => {
  const c = raw();
  c.prepare(
    "INSERT INTO bot_sessions (bot_id,gateway_type,gateway_thread_id,kind,status,narrowed_tools) " +
    "VALUES ('chatty','gmail','narrow-gmail','chat','waiting-user',NULL)"
  ).run();
  c.close();

  const r = await postJson("/bots/chatty/sessions/narrow-gmail/narrow", { disabled_tools: ["bash"] });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "not_a_perch_session");
  assert.equal(r.body.gateway_type, "gmail");

  const after = raw();
  const row = after.prepare(
    "SELECT narrowed_tools, gateway_type FROM bot_sessions WHERE bot_id='chatty' AND gateway_thread_id='narrow-gmail'"
  ).get();
  after.close();
  assert.equal(row.narrowed_tools, null, "a gmail thread's envelope is Bot Builder's alone");
  assert.equal(row.gateway_type, "gmail");
});

test("POST /narrow still accepts a perch row and a thread that does not exist yet", async () => {
  // The refusal must be a channel check, not a ban on narrowing: the two
  // legitimate cases are the whole feature.
  const c = raw();
  c.prepare(
    "INSERT INTO bot_sessions (bot_id,gateway_type,gateway_thread_id,kind,status) " +
    "VALUES ('chatty','perch','narrow-existing-perch','perch','waiting-user')"
  ).run();
  c.close();
  assert.equal((await postJson("/bots/chatty/sessions/narrow-existing-perch/narrow", { disabled_tools: ["bash"] })).status, 200);
  assert.equal((await postJson("/bots/chatty/sessions/narrow-brand-new/narrow", { disabled_tools: ["bash"] })).status, 200);
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
  // narrowed_tools itself landed at generation 8 without needing its OWN
  // bump (an addColumnIfMissing addition, no CHECK/rebuild). A literal `= 8`
  // here would go stale on every LATER, unrelated bump (e.g. Track 3 Task 7's
  // 8->9 for the bot_sessions.control CHECK widen) — assert the invariant
  // this test actually cares about (>= the generation narrowed_tools shipped
  // at), not a frozen snapshot of an ever-advancing counter.
  const genSrc = readFileSync(join(REPO, "servers/shared/schema-version.js"), "utf8");
  const genMatch = genSrc.match(/SCHEMA_GENERATION = (\d+)/);
  assert.ok(genMatch && Number(genMatch[1]) >= 8,
    "narrowed_tools's own addition must not have required a schema generation bump");
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

test("GET transcript reads only the tail BYTES — a fat file is never slurped whole", async () => {
  // The line cap alone does not bound memory: 100 lines of 50 KB is a 5 MB
  // file that passes `all.length > 2000` untouched, and readFileSync + split
  // holds it twice. Real pi session files are large (one on this box already
  // exceeds 2 MB) and a single line can be enormous.
  const sessions = join(dir, "sessions-fat");
  mkdirSync(sessions, { recursive: true });
  const uuid = "019eeb17-0000-7000-8000-dddddddddddd";
  const lines = [];
  for (let i = 0; i < 100; i++) {
    lines.push(JSON.stringify({
      type: "message", id: "m" + i,
      message: { role: "user", content: "x".repeat(50 * 1024) },
    }));
  }
  const file = join(sessions, "2026-06-21T16-50-50-013Z_" + uuid + ".jsonl");
  writeFileSync(file, lines.join("\n") + "\n");
  // Comfortably past the 2 MB byte cap, while staying well under the 2000-line
  // cap (100 lines) — so only the BYTE bound can be what truncates this.
  const fixtureSize = statSync(file).size;
  assert.ok(fixtureSize > 4 * 1024 * 1024, "precondition: fixture must dwarf the byte cap, got " + fixtureSize);

  const c = raw();
  c.prepare(
    "INSERT INTO bot_sessions (bot_id,gateway_type,gateway_thread_id,pi_session_dir,pi_session_id,status) " +
    "VALUES ('chatty','perch','t-fat',?,?,'waiting-user')"
  ).run(sessions, uuid);
  c.close();

  const { status, body } = await getJson("/bots/chatty/sessions/t-fat/transcript");
  assert.equal(status, 200);
  assert.ok(body.events.length > 0, "the newest turns must still render");
  assert.ok(body.events.length < 100, "the whole file must not come back: got " + body.events.length + " of 100");
  assert.equal(body.events[body.events.length - 1].id, "m99", "the tail is what survives");
  assert.equal(body.events.some((e) => e.id === "m0"), false, "the head must have been left on disk");
  assert.equal(body.truncated, true);
  // The exact count of dropped entries is unknowable once the head is never
  // read — saying 0 would be a lie, so the field is null and the lens words it
  // without a number.
  assert.equal(body.omitted, null);
  // Every event that DID come back is a complete, parsed object: the partial
  // first line at the byte boundary is dropped, not half-parsed.
  assert.ok(body.events.every((e) => e && e.type === "message" && e.message && e.message.role === "user"));
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

test("nothing claims perch owns the first in-process handleInbound — the gmail tick got there first", () => {
  // Three places asserted perch was the FIRST in-process handleInbound in the
  // gateway. It is not: the gmail tick has run one in-process since C4, and a
  // reader who believes the claim will draw the wrong conclusion about which
  // process budgets and which timeouts a perch turn is subject to.
  const tickLib = readFileSync(join(REPO, "scripts/pi-bots/bridge_tick_lib.mjs"), "utf8");
  assert.match(tickLib, /import \{ handleInbound \} from "\.\/bridge\.mjs"/,
    "the gmail tick imports the bridge directly…");
  const runtime = readFileSync(join(REPO, "servers/gateway/bot-runtime.js"), "utf8");
  assert.match(runtime, /import \{ runBridgeTick as defaultRunBridgeTick \} from "\.\.\/\.\.\/scripts\/pi-bots\/bridge_tick_lib\.mjs"/,
    "…and the gateway runs that tick in-process, which is what makes the 'first' claim false");

  // Matches the ASSERTION ("this is the FIRST in-process…", "it is the
  // **first in-process** one") and not its denial ("is NOT the … first
  // in-process one"), which both files now carry deliberately.
  const CLAIMS_FIRST = /\bis the (\*\*)?first in-process\b/i;
  for (const rel of ["servers/gateway/routes/perch.js", "docs/developers/perch-hub.md"]) {
    const src = readFileSync(join(REPO, rel), "utf8");
    assert.equal(CLAIMS_FIRST.test(src), false, rel + " still repeats the false 'first in-process' claim");
    // The fact worth stating instead: they share a process, and therefore the
    // host-wide pi budget and the PIBOT_* tuning.
    assert.match(src, /countLivePi/, rel + " should say what sharing a process actually costs");
    assert.match(src, /PIBOT_/, rel + " should say that perch inherits gmail's PIBOT_* tuning");
  }
});

test("the proxy's bearer injection depends on SameSite=Lax, and says so where it injects", async () => {
  // POST /api/hub/spawn on the vendored hub is arbitrary code execution (the
  // hub's own header says so), and extension-proxy.js injects the hub's bearer
  // on EVERY proxied request — so the backend's own auth is satisfied for
  // anyone who reaches the proxy. The proxy router is mounted at APP ROOT
  // (boot/late-mounts.js `app.use(router)`), i.e. outside the /dashboard CSRF
  // rail. What stops a cross-site POST from riding an operator's logged-in
  // session into that endpoint is one thing only: SameSite=Lax on crow_session.
  const { setSessionCookie } = await import("../servers/gateway/dashboard/auth.js");
  const headers = {};
  setSessionCookie({ setHeader: (k, v) => { headers[k] = v; } }, "tok");
  const session = headers["Set-Cookie"].find((c) => c.startsWith("crow_session="));
  assert.match(session, /SameSite=Lax/,
    "SameSite=None here would make /proxy/perch-hub/api/hub/spawn cross-site reachable — that is RCE, not a cookie tweak");
  assert.match(session, /HttpOnly/);

  // Pinning the cookie is not enough: the dependency has to be legible at the
  // injection site, or a future "relax the cookie so the dashboard can be
  // embedded" change has nothing to warn it.
  const proxy = readFileSync(join(REPO, "servers/gateway/routes/extension-proxy.js"), "utf8");
  assert.match(proxy, /SameSite=Lax/, "the injection hook must name the cookie property it leans on");
  assert.match(proxy, /spawn/, "…and what is on the other side of it");
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

test("perchAttached is imported from the shared module, not redefined locally (Track 2 §5.1)", () => {
  const src = readFileSync(join(REPO, "servers/gateway/routes/perch.js"), "utf8");
  assert.match(src, /import\s*\{[^}]*perchAttached[^}]*\}\s*from\s*"\.\.\/shared\/perch-attached\.js"/,
    "perch.js must import perchAttached from the shared module");
  assert.doesNotMatch(src, /function perchAttached\(/,
    "perch.js must not define its own local perchAttached — that is the duplication this task removes");
});
