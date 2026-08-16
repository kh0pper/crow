/**
 * Perch Hub P1, Task C-5 — servers/gateway/routes/perch.js.
 *
 * Track 3 Task 16 retired the per-turn channel this file used to exercise
 * (POST /bots/:id/turn, GET /turns/:turnId/events); the ~17 tests for it, and
 * the handleInbound-injection seam they relied on, were removed with it.
 * perch-live (perch-interactive.js / perch-interactive-api.js, covered by
 * tests/perch-interactive-routes.test.js) is now the only interactive rail.
 *
 * Harness: a real init-db'd scratch crow.db (CROW_DATA_DIR, so nothing can
 * touch the operator's ~/.crow) and an ephemeral express server. Engine state
 * is pinned through engine-gate's _setEngineStatusForTest because CI runners
 * have no pi installed at all.
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

let server, base, _setEngineStatusForTest;

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
  const { default: perchApiRouter } = await import("../servers/gateway/routes/perch.js");
  const { default: express } = await import("express");

  const app = express();
  app.use(express.json()); // the gateway installs this globally (index.js:386)
  app.use(perchApiRouter((req, res, next) => next()));
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
// turns (RETIRED — Track 3 Task 16: POST /bots/:id/turn and
// GET /turns/:turnId/events, and the ~17 tests that exercised them, were
// removed. perch-live (perch-interactive.js / perch-interactive-api.js) is
// now the only interactive rail.)
// ---------------------------------------------------------------------------

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

test("two consecutive narrows on one thread leave exactly ONE row, updated in place", async () => {
  await postJson("/bots/chatty/sessions/narrow-c/narrow", { disabled_tools: ["bash"] });
  await postJson("/bots/chatty/sessions/narrow-c/narrow", { disabled_tools: ["read", "bash"] });
  const c = raw();
  const rows = c.prepare("SELECT id, narrowed_tools FROM bot_sessions WHERE bot_id='chatty' AND gateway_thread_id='narrow-c'").all();
  c.close();
  assert.equal(rows.length, 1, "ON CONFLICT is unusable here — the index is not unique; the upsert must be a transaction");
  assert.equal(rows[0].narrowed_tools, '["read","bash"]');
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

    // Same for a mutating route: a session-less caller cannot narrow a bot's
    // tools.
    const narrow = await fetch(b + "/bots/chatty/sessions/unauth-thread/narrow", {
      method: "POST",
      headers: { "content-type": "application/json", "tailscale-user-login": "someone@example.com" },
      body: JSON.stringify({ disabled_tools: ["bash"] }),
      redirect: "manual",
    });
    assert.equal(narrow.status, 303);
    const c = raw();
    const rows = c.prepare("SELECT id FROM bot_sessions WHERE gateway_thread_id='unauth-thread'").all();
    c.close();
    assert.equal(rows.length, 0, "a refused, session-less narrow must never write a row");
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
