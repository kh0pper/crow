/**
 * Staged sends, Task 2 — the Perch capture hook (spec §12.1).
 *
 * The engine is driven through a FakePi exactly as tests/perch-interactive.test.js does: a real
 * init-db'd scratch crow.db (the recorder's row writes are real SQL), a fake bridge seam, an
 * injected clock, and the child's events pushed through the engine's own `onEvent`.
 *
 * What is proven here:
 *   • the staged row exists AT THE MOMENT the tool end frame is emitted (the hub refetches the card
 *     on that frame, so a row written after it would draw an empty card);
 *   • `tainted` is "tainted BEFORE this call" — a draft that is the session's first tool does not
 *     count its own taint, an earlier tainting tool does;
 *   • a recorder failure never breaks the turn (one log line, tool name + code, no draft content).
 *
 * The fake world's google-workspace block carries NO token env, so the recorder names no credential
 * and never touches Gmail: `cred_ref` is null ("Open in Gmail to send"). The Gmail read itself is
 * covered in tests/staged-recorder.test.js against tests/fixtures/fake-gmail.mjs.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const dir = mkdtempSync(join(tmpdir(), "staged-capture-perch-"));
process.env.CROW_DATA_DIR = dir;
process.env.CROW_HOME = join(dir, "home");
delete process.env.CROW_DB_PATH;
process.env.PI_MODELS_JSON = join(dir, "models.json");

const CROW_HOME = process.env.CROW_HOME;
const DB_FILE = join(dir, "crow.db");
const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

/** The pi-named tool all three Perch draft forms share a suffix with. */
const DRAFT = "mcp__google-workspace__gmail_create_draft";
const DRAFT_PERSONAL = "mcp__google-workspace__gmail_create_draft_personal";

let createInteractiveEngine, _resetInteractiveEngineForTest;

/* ---------------------------------------------------------------- harness */

function db() {
  return new Database(DB_FILE);
}

function stagedRows(sessionId) {
  const c = db();
  try {
    return c.prepare("SELECT * FROM staged_sends WHERE session_id=? ORDER BY rowid").all(sessionId);
  } finally { c.close(); }
}

function notificationCount() {
  const c = db();
  try { return c.prepare("SELECT COUNT(*) AS n FROM notifications").get().n; } finally { c.close(); }
}

/** Let queued microtasks + the engine's async continuations settle. */
const tick = async (n = 10) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

function makeClock() {
  let t = 1_700_000_000_000;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimer(fn, ms) { const id = ++seq; timers.set(id, { fn, at: t + Number(ms) }); return id; },
    clearTimer(id) { timers.delete(id); },
    advance(ms) {
      const target = t + ms;
      for (;;) {
        let pick = null;
        for (const [id, e] of timers) if (e.at <= target && (pick === null || e.at < pick.entry.at)) pick = { id, entry: e };
        if (!pick) break;
        timers.delete(pick.id);
        t = pick.entry.at;
        pick.entry.fn();
      }
      t = target;
    },
  };
}

let pidSeq = 500000;

function makeBridge() {
  const state = { worlds: [], instances: [], livePi: 0, maxPi: 4 };

  class FakePi {
    constructor(o) {
      this.opts = o;
      this.onEvent = o.onEvent;
      this.sent = [];
      this.closed = 0;
      this.proc = { pid: ++pidSeq };
      this.piSessionId = "pisess-" + this.proc.pid;
      this.toolsCsv = "";
      this.turns = [];
      let done;
      this.exited = new Promise((r) => { done = r; });
      this._done = done;
      this._exitCode = null;
      state.instances.push(this);
    }
    async getState() { return { data: { sessionId: this.piSessionId } }; }
    async getSessionStats() { return { data: { tokens: { input: 1, output: 1, cacheRead: 0 } } }; }
    promptTurn(message, ms, images) {
      const rec = { message, ms, images };
      rec.promise = new Promise((resolve, reject) => { rec.resolve = resolve; rec.reject = reject; });
      this.turns.push(rec);
      return rec.promise;
    }
    trimLog() {}
    async abortSince() { return null; }
    send(o) { this.sent.push(o); }
    async close() { this.closed += 1; this.exit(0); }
    exit(code = 0) { if (this._exitCode != null) return; this._exitCode = code; this._done(code); }
    _exitError() { return new Error("pi exited"); }
    emit(m) { this.onEvent(m); }
    lastTurn() { return this.turns[this.turns.length - 1]; }
  }

  return {
    _state: state,
    PiRpc: FakePi,
    LIFECYCLE_DEFAULTS: { get maxPi() { return state.maxPi; } },
    countLivePi: () => state.livePi,
    async buildBotWorld(args) {
      state.worlds.push(args);
      return {
        def: { session_dir: join(dir, "bots", args.botId), permission_policy: { bash: "deny", write_paths: [] } },
        bot: { bot_id: args.botId },
        crowHome: CROW_HOME,
        projectId: null,
        projectSpace: null,
        projectMembers: [],
        sessionDir: join(dir, "bots", args.botId),
        tasksDbPath: join(dir, "tasks.db"),
        remoteEnabled: false,
        peerGatewayUrls: {},
        session: null,
        narrowedTools: null,
        gatewayType: args.gatewayType,
        // A google-workspace block with NO token env: the recorder names no credential and never
        // calls Gmail. (The primary/personal mapping itself is a recorder test.)
        mcpConfig: { mcpServers: { "google-workspace": { env: {} }, board: { env: {} } } },
      };
    },
    async prepareSpawn(world, o) {
      const resolved = {
        provider: "crow-local", model: "qwen3.6-35b-a3b", key: "crow-local/qwen3.6-35b-a3b",
        escalated: false, source: "default", escalationRequestedButUnavailable: false,
      };
      return {
        sysFile: join(dir, "sys.md"),
        selfAuthoringDir: null,
        resolved,
        piRpcOpts: {
          def: world.def, sessionDir: world.sessionDir, resolved, selfAuthoringDir: null,
          remoteEnabled: false, narrowedTools: null, appendSystemPromptFile: join(dir, "sys.md"),
          mcpConfig: world.mcpConfig,
        },
      };
    },
    async warmModel() {},
    async meterTurn() { return { recorded: true }; },
    appendAudit() {},
  };
}

function makeEngine(o = {}) {
  const clock = makeClock();
  const bridge = makeBridge();
  const env = Object.assign({ CROW_HOME }, o.env);
  const engine = createInteractiveEngine({
    crowHome: CROW_HOME,
    env,
    bridge,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    log: o.log || (() => {}),
    // Only the slow-recording test passes one; `undefined` takes the real recorder.
    recordDraft: o.recordDraft,
  });
  return { engine, clock, state: bridge._state };
}

async function spawned(engine, botId = "botty") {
  const r = await engine.spawn({ botId });
  await tick();
  return r;
}

/** One successful draft call, as pi reports it (start carries args, end carries the result). */
function emitDraft(pi, { toolCallId = "call-1", toolName = DRAFT, args = {}, draftId = "draft-1", threadId = "gt-1", isError = false } = {}) {
  pi.emit({ type: "tool_execution_start", toolName, toolCallId, args });
  pi.emit({
    type: "tool_execution_end", toolName, toolCallId, isError,
    result: { content: [{ type: "text", text: JSON.stringify({ success: true, data: { draft_id: draftId, thread_id: threadId } }) }] },
  });
}

/** An assistant message_end / agent_end message. */
const textMsg = (text) => ({ role: "assistant", content: [{ type: "text", text }] });

/** The chat-relevant frames only, as compact strings (the probe form: "tool:end:<callId>"). */
const seenOf = (frames) => frames
  .filter((e) => e.type === "tool" || e.type === "text" || e.type === "reply")
  .map((e) => (e.type === "tool" ? "tool:" + e.phase + ":" + e.toolCallId : e.type));

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: REPO,
  });
  mkdirSync(CROW_HOME, { recursive: true });
  writeFileSync(process.env.PI_MODELS_JSON, JSON.stringify({
    providers: { "crow-local": { models: [{ id: "qwen3.6-35b-a3b" }] } },
  }));
  const mod = await import("../servers/gateway/perch-interactive.js");
  createInteractiveEngine = mod.createInteractiveEngine;
  _resetInteractiveEngineForTest = mod._resetInteractiveEngineForTest;
});

after(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});

/* ----------------------------------------------------------------- tests */

test("perch draft recorded before end frame", async () => {
  if (_resetInteractiveEngineForTest) _resetInteractiveEngineForTest();
  const { engine, state } = makeEngine();
  const s = await spawned(engine, "botty");

  // The subscriber reads the DB INSIDE the frame: if the recorder ran after the emit, this would
  // be null (the frame is what makes the hub refetch the card).
  let rowAtFrame = "not-seen";
  await engine.subscribe(s.sessionId, (e) => {
    if (e.type !== "tool" || e.phase !== "end") return;
    const c = db();
    try { rowAtFrame = c.prepare("SELECT * FROM staged_sends WHERE session_id=?").get(s.sessionId) || null; } finally { c.close(); }
  });

  emitDraft(state.instances[0], {
    args: { to: "alex@example.com", cc: "", subject: "Hello from Perch", body: "Body text" },
    draftId: "draft-1", threadId: "gt-1",
  });
  await tick(20);

  assert.ok(rowAtFrame && rowAtFrame !== "not-seen", "the staged row exists when the end frame is emitted");
  const row = rowAtFrame;
  assert.equal(row.provider_draft_id, "draft-1");
  assert.equal(row.provider_thread_id, "gt-1");
  assert.equal(row.session_id, s.sessionId);
  assert.equal(row.thread_id, s.threadId);
  assert.equal(row.bot_id, "botty");
  assert.equal(row.channel, "gmail");
  assert.equal(row.state, "staged");
  // No credential this world can name: the card says "Open in Gmail to send".
  assert.equal(row.cred_ref, null);
  // The snapshot comes from the ARGS because the read could not happen at all.
  assert.equal(JSON.parse(row.snapshot).subject, "Hello from Perch");
  assert.deepEqual(JSON.parse(row.snapshot).to, ["alex@example.com"]);
  assert.equal(row.new_recipients, null);
  // A Perch row gets no notification: the chat card is enough.
  assert.equal(notificationCount(), 0);
});

test("taint before vs by the draft", async () => {
  if (_resetInteractiveEngineForTest) _resetInteractiveEngineForTest();

  // A: the draft is the session's FIRST tool. Its own taint (a draft tool is never on the clean
  // list) is written at this call's start and must not count as "tainted before".
  const a = makeEngine();
  const sa = await spawned(a.engine, "botty");
  emitDraft(a.state.instances[0], { toolCallId: "a-1", draftId: "draft-a" });
  await tick(20);
  const [rowA] = stagedRows(sa.sessionId);
  assert.ok(rowA, "the clean-session draft is recorded");
  assert.equal(rowA.tainted, 0, "the draft's own taint is not 'tainted before the draft'");

  // B: an earlier tool tainted this session (read is outside text), so the draft is tainted.
  if (_resetInteractiveEngineForTest) _resetInteractiveEngineForTest();
  const b = makeEngine();
  const sb = await spawned(b.engine, "botty");
  const pi = b.state.instances[0];
  pi.emit({ type: "tool_execution_start", toolName: "read", toolCallId: "b-read", args: { path: "/tmp/x" } });
  pi.emit({ type: "tool_execution_end", toolName: "read", toolCallId: "b-read", isError: false, result: { content: [{ type: "text", text: "outside text" }] } });
  await tick();
  emitDraft(pi, { toolCallId: "b-1", draftId: "draft-b" });
  await tick(20);
  const [rowB] = stagedRows(sb.sessionId);
  assert.ok(rowB, "the tainted-session draft is recorded");
  assert.equal(rowB.tainted, 1, "an earlier tool's taint counts");
});

test("a recorder failure does not break the turn", async () => {
  if (_resetInteractiveEngineForTest) _resetInteractiveEngineForTest();
  const logs = [];
  const { engine, state } = makeEngine({ log: (line) => logs.push(String(line)) });
  const s = await spawned(engine, "botty");
  const frames = [];
  await engine.subscribe(s.sessionId, (e) => frames.push(e));

  // The staged table is the recorder's only dependency. Hiding it makes the write throw; the turn
  // must still end with its tool frame and log exactly one content-free line.
  const c = db();
  c.exec("ALTER TABLE staged_sends RENAME TO staged_sends_hidden");
  c.close();
  try {
    emitDraft(state.instances[0], {
      args: { to: "alex@example.com", subject: "Hello from Perch", body: "Body text" },
      draftId: "draft-1",
    });
    await tick(20);
  } finally {
    const back = db();
    try { back.exec("ALTER TABLE staged_sends_hidden RENAME TO staged_sends"); } finally { back.close(); }
  }

  const end = frames.find((e) => e.type === "tool" && e.phase === "end");
  assert.ok(end, "the end frame is emitted even when the recorder failed");
  assert.equal(end.isError, false, "the tool itself did not fail");
  assert.equal(stagedRows(s.sessionId).length, 0, "no row was written");

  const line = logs.find((l) => l.includes("gmail_create_draft"));
  assert.ok(line, "one log line names the tool");
  assert.match(line, /gmail_create_draft\): \S+$/, "and carries an error code after the tool name");
  assert.equal(logs.filter((l) => l.includes("gmail_create_draft")).length, 1, "exactly one line");
  const all = logs.join("\n");
  for (const token of ["alex@example.com", "Hello from Perch", "Body text"]) {
    assert.ok(!all.includes(token), "no draft content in the logs: " + token);
  }
});

test("a draft tool the session never started is still recorded (resume mid-call), fail-closed tainted", async () => {
  if (_resetInteractiveEngineForTest) _resetInteractiveEngineForTest();
  const { engine, state } = makeEngine();
  const s = await spawned(engine, "botty");
  // Only the END event: a session adopted mid-call. The recorder fails closed on taint.
  state.instances[0].emit({
    type: "tool_execution_end", toolName: DRAFT_PERSONAL, toolCallId: "orphan", isError: false,
    result: { content: [{ type: "text", text: JSON.stringify({ success: true, data: { draft_id: "draft-o" } }) }] },
  });
  await tick(20);
  const [row] = stagedRows(s.sessionId);
  assert.ok(row, "the row is still written");
  assert.equal(row.tainted, 1, "a call whose start we never saw fails closed");
  assert.equal(row.provider_draft_id, "draft-o");
});

/* ------------------------------------------------- frames keep their order (H1) */

test("frames keep their order while a draft is recorded", async () => {
  if (_resetInteractiveEngineForTest) _resetInteractiveEngineForTest();
  const { engine, state } = makeEngine();
  const s = await spawned(engine, "botty");
  const frames = [];
  await engine.subscribe(s.sessionId, (e) => frames.push(e));
  await engine.message(s.sessionId, "please draft it");
  const pi = state.instances[0];

  // One turn's events, with no tick in between: draft end, text, a second tool, text, agent_end.
  emitDraft(pi, { toolCallId: "c1", toolName: DRAFT, draftId: "draft-order-1", args: { subject: "One" } });
  pi.emit({ type: "message_end", message: textMsg("the draft is ready") });
  pi.emit({ type: "tool_execution_start", toolName: "read", toolCallId: "c2", args: { path: "/tmp/x" } });
  pi.emit({ type: "message_end", message: textMsg("and reviewed") });
  pi.lastTurn().resolve({ type: "agent_end", messages: [textMsg("the draft is ready")] });

  // Until the row exists, only the frames BEFORE the draft's end may reach the client: everything
  // after it waits its turn. Without the queue the text, the next tool and the reply overtake it.
  assert.deepEqual(seenOf(frames), ["tool:start:c1"], "nothing overtakes a draft's end frame");

  await tick(20);
  assert.deepEqual(seenOf(frames), [
    "tool:start:c1",
    "tool:end:c1",
    "text",
    "tool:start:c2",
    "text",
    "reply",
  ], "the client sees the original order, with nothing dropped");
  assert.equal(stagedRows(s.sessionId).length, 1, "the wait was for a real row");
  // Nothing was dropped on the way: the turn's state frames came through too.
  assert.ok(frames.some((e) => e.type === "state"), "state frames are queued and released, not dropped");
});

test("two drafts in one turn end in their own order", async () => {
  if (_resetInteractiveEngineForTest) _resetInteractiveEngineForTest();
  const { engine, state } = makeEngine();
  const s = await spawned(engine, "botty");
  const frames = [];
  await engine.subscribe(s.sessionId, (e) => frames.push(e));
  await engine.message(s.sessionId, "draft two replies");
  const pi = state.instances[0];

  emitDraft(pi, { toolCallId: "c1", draftId: "draft-first", args: { subject: "First" } });
  pi.emit({ type: "message_end", message: textMsg("first done") });
  emitDraft(pi, { toolCallId: "c2", draftId: "draft-second", args: { subject: "Second" } });  pi.emit({ type: "message_end", message: textMsg("second done") });
  pi.lastTurn().resolve({ type: "agent_end", messages: [textMsg("two drafts")] });

  assert.deepEqual(seenOf(frames), ["tool:start:c1"]);
  await tick(20);
  // Each draft's own end frame sits where its call did: the second never jumps the first.
  assert.deepEqual(seenOf(frames), [
    "tool:start:c1", "tool:end:c1", "text", "tool:start:c2", "tool:end:c2", "text", "reply",
  ]);
  const rows = stagedRows(s.sessionId);
  assert.deepEqual(rows.map((r) => r.provider_draft_id), ["draft-first", "draft-second"], "two rows, in call order");
});

test("a slow recording does not hold the chat past 5 s", async () => {
  if (_resetInteractiveEngineForTest) _resetInteractiveEngineForTest();
  let release;
  const gate = new Promise((r) => { release = r; });
  const recordCalls = [];
  const { engine, clock, state } = makeEngine({
    recordDraft: async (args) => { recordCalls.push(args); await gate; return { id: "ss-late" }; },
  });
  const s = await spawned(engine, "botty");
  const frames = [];
  await engine.subscribe(s.sessionId, (e) => frames.push(e));
  await engine.message(s.sessionId, "draft it slowly");
  const pi = state.instances[0];

  emitDraft(pi, { toolCallId: "c1", draftId: "draft-slow" });
  pi.emit({ type: "message_end", message: textMsg("waiting on the draft") });
  assert.deepEqual(seenOf(frames), ["tool:start:c1"], "the end frame waits for its row");

  clock.advance(4_999);
  assert.deepEqual(seenOf(frames), ["tool:start:c1"], "still inside the cap");

  clock.advance(2);
  assert.equal(recordCalls.length, 1, "the recorder ran exactly once");
  assert.deepEqual(seenOf(frames), ["tool:start:c1", "tool:end:c1", "text"],
    "at the 5 s cap the end frame goes out anyway (the row lands later and the card refetches)");

  // The row arriving late must not send the frame a second time.
  release();
  await tick(20);
  assert.deepEqual(seenOf(frames), ["tool:start:c1", "tool:end:c1", "text"], "a late row adds no second frame");
});

test("an error result records nothing", async () => {
  if (_resetInteractiveEngineForTest) _resetInteractiveEngineForTest();
  const { engine, state } = makeEngine();
  const s = await spawned(engine, "botty");
  const frames = [];
  await engine.subscribe(s.sessionId, (e) => frames.push(e));
  const pi = state.instances[0];

  // isError with a success-shaped body: a forged draft id must never become a row. The end frame
  // still goes out (the tool DID end), and it does not open a slot: nothing waits for a row.
  pi.emit({ type: "tool_execution_start", toolName: DRAFT, toolCallId: "e1", args: { subject: "Forged" } });
  pi.emit({ type: "tool_execution_end", toolName: DRAFT, toolCallId: "e1", isError: true,
    result: { content: [{ type: "text", text: JSON.stringify({ success: true, data: { draft_id: "forged-1" } }) }] } });
  pi.emit({ type: "message_end", message: textMsg("that failed") });

  assert.deepEqual(seenOf(frames), ["tool:start:e1", "tool:end:e1", "text"], "an errored call never queues frames");
  await tick(20);
  assert.equal(stagedRows(s.sessionId).length, 0, "an errored call made no draft");
  assert.equal(frames.find((e) => e.type === "tool" && e.phase === "end").isError, true);
});