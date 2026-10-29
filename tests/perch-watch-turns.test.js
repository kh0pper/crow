/**
 * Voice hand-off (PR 3): the Perch engine's turn-end hook.
 *
 * `watchTurns(sessionId, fn, { first })` hears a session's turn outcomes
 * without counting as a subscriber, `turnEnded` is the one place every end
 * path reports through (once per turn), `s.firstTurn` is replayed to a
 * watcher that registers after turn 1 already ended, and
 * `suppressTurnEndPush(cardId)` drops the running turn's own away push.
 *
 * Harness shape mirrors tests/perch-interactive.test.js: a real init-db'd
 * scratch crow.db, an injected bridge seam with a controllable fake pi, an
 * injected clock, plus an injected notifications seam so every away push is
 * counted here instead of read back through the notification gate.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const dir = mkdtempSync(join(tmpdir(), "perch-watch-turns-"));
process.env.CROW_DATA_DIR = dir;
process.env.CROW_HOME = join(dir, "home");
delete process.env.CROW_DB_PATH;
process.env.PI_MODELS_JSON = join(dir, "models.json");

const CROW_HOME = process.env.CROW_HOME;
const DB_FILE = join(dir, "crow.db");
const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

let createInteractiveEngine, _resetInteractiveEngineForTest;

function raw() {
  return new Database(DB_FILE);
}

// ---------------------------------------------------------------------------
// fake clock + timers
// ---------------------------------------------------------------------------

function makeClock() {
  let t = 1_700_000_000_000;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimer(fn, ms) {
      const id = ++seq;
      timers.set(id, { fn, at: t + Number(ms) });
      return id;
    },
    clearTimer(id) { timers.delete(id); },
    /** Fire every timer due within `ms`, in due order, advancing `now` as we go. */
    advance(ms) {
      const target = t + ms;
      for (;;) {
        let pick = null;
        for (const [id, e] of timers) {
          if (e.at <= target && (pick === null || e.at < pick.entry.at)) pick = { id, entry: e };
        }
        if (!pick) break;
        timers.delete(pick.id);
        t = pick.entry.at;
        pick.entry.fn();
      }
      t = target;
    },
  };
}

/** Let queued microtasks + the engine's own async continuations settle. */
const tick = async (n = 8) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

// ---------------------------------------------------------------------------
// fake bridge seam
// ---------------------------------------------------------------------------

let pidSeq = 700000;

function makeBridge() {
  const state = { instances: [], piScript: null };

  class FakePi {
    constructor(o) {
      this.opts = o;
      this.onEvent = o.onEvent;
      this.turns = [];
      this._exitCode = null;
      this.proc = { pid: ++pidSeq };
      this.piSessionId = "pisess-" + this.proc.pid;
      let done;
      this.exited = new Promise((r) => { done = r; });
      this._done = done;
      state.instances.push(this);
      if (state.piScript) state.piScript(this, state.instances.length - 1);
    }
    async getState() { return { data: { sessionId: this.piSessionId } }; }
    async getSessionStats() { return { data: { tokens: { input: 10, output: 5, cacheRead: 0 } } }; }
    promptTurn(message, ms, images) {
      const rec = { message, ms, images };
      rec.promise = new Promise((resolve, reject) => { rec.resolve = resolve; rec.reject = reject; });
      this.turns.push(rec);
      return rec.promise;
    }
    trimLog() {}
    async abortSince() { return null; }
    send(o) { if (this._exitCode != null) throw new Error("pi exited"); void o; }
    async close() { this.exit(0); }
    exit(code = 0) {
      if (this._exitCode != null) return;
      this._exitCode = code;
      this._done(code);
    }
    _exitError() { return new Error("pi exited (code " + this._exitCode + ") before responding"); }
    /** Test driver: push one parsed stdout message into the engine. */
    emit(m) { this.onEvent(m); }
    lastTurn() { return this.turns[this.turns.length - 1]; }
  }

  return {
    _state: state,
    PiRpc: FakePi,
    LIFECYCLE_DEFAULTS: { maxPi: 4 },
    countLivePi: () => 0,
    async buildBotWorld(args) {
      return {
        def: { session_dir: join(dir, "bots", args.botId), permission_policy: { bash: "deny", write_paths: [] } },
        bot: { bot_id: args.botId },
        crowHome: CROW_HOME,
        projectId: 7,
        projectSpace: null,
        projectMembers: [],
        sessionDir: join(dir, "bots", args.botId),
        tasksDbPath: join(dir, "tasks.db"),
        remoteEnabled: false,
        peerGatewayUrls: {},
        session: null,
        narrowedTools: null,
        gatewayType: args.gatewayType,
      };
    },
    async prepareSpawn(world) {
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
          remoteEnabled: world.remoteEnabled, narrowedTools: world.narrowedTools,
          appendSystemPromptFile: join(dir, "sys.md"),
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
  const pushes = [];
  const logs = [];
  const env = Object.assign({ CROW_HOME, PERCH_NOTIFY_MIN_RUN_S: "30", PERCH_TURN_STALL_MS: "60000" }, o.env);
  const engine = createInteractiveEngine({
    crowHome: CROW_HOME,
    env,
    bridge,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    log: (m) => logs.push(String(m)),
    notifications: {
      async createNotification(db, opts) { pushes.push(opts); return { id: pushes.length }; },
    },
  });
  return { engine, clock, bridge, env, state: bridge._state, pushes, logs };
}

/** spawn + let the post-spawn get_state continuation settle. */
async function spawned(engine, botId = "botty") {
  const r = await engine.spawn({ botId });
  await tick();
  return r;
}

/** A watcher that records every call. */
function watcher() {
  const calls = [];
  const fn = (ctx) => calls.push(ctx);
  return { fn, calls, get once() { assert.equal(calls.length, 1, "fired exactly once: " + JSON.stringify(calls.map((c) => c.outcome))); return calls[0]; } };
}

const ok = (text = "done") => ({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text }] }] });
const errMsg = (errorMessage) => ({ role: "assistant", content: [], stopReason: "error", errorMessage });
const failedEnd = (errorMessage = "400 bad request") => ({ type: "agent_end", messages: [errMsg(errorMessage)] });
const OVERFLOW = "the request exceeds the available context size, try increasing it";
const RECOVERY_FAILED = "Context overflow recovery failed after one compact-and-retry attempt.";

/** Turn 1 overflowed and pi is compacting: the turn is deferred, `s.turn` is free. */
async function deferredOverflow(engine, s, pi) {
  await engine.message(s.sessionId, "huge");
  pi.emit({ type: "message_end", message: errMsg(OVERFLOW) });
  pi.emit({ type: "compaction_start", reason: "overflow" });
  pi.lastTurn().resolve({ type: "agent_end", messages: [errMsg(OVERFLOW)], willRetry: false });
  await tick();
}

/** Park the awake session through the idle timer, so the next message() wakes. */
async function hibernated(engine, clock, s) {
  clock.advance(600_001);
  await tick();
  assert.equal((await engine.get(s.sessionId)).state, "hibernating");
}

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir },
    stdio: "pipe",
    cwd: REPO,
  });
  mkdirSync(CROW_HOME, { recursive: true });
  writeFileSync(process.env.PI_MODELS_JSON, JSON.stringify({
    providers: { "crow-local": { models: [{ id: "qwen3.6-35b-a3b" }] } },
  }));
  const mod = await import("../servers/gateway/perch-interactive.js");
  createInteractiveEngine = mod.createInteractiveEngine;
  _resetInteractiveEngineForTest = mod._resetInteractiveEngineForTest;
});

beforeEach(() => {
  if (_resetInteractiveEngineForTest) _resetInteractiveEngineForTest();
});

after(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});

// ---------------------------------------------------------------------------
// 1. registration
// ---------------------------------------------------------------------------

test("watchTurns on an unknown session throws no_such_session synchronously", async () => {
  const { engine } = makeEngine();
  assert.throws(() => engine.watchTurns("nope", () => {}), (e) => e.code === "no_such_session");
  assert.throws(() => engine.watchTurns("nope", () => {}, { first: true }), (e) => e.code === "no_such_session");
});

test("a watcher does not count as a subscriber: the away 'replied' push still fires", async () => {
  const { engine, clock, state, pushes } = makeEngine();
  const s = await spawned(engine);
  const w = watcher();
  engine.watchTurns(s.sessionId, w.fn, { first: true });
  await engine.message(s.sessionId, "go");
  clock.advance(35_000);
  state.instances[0].lastTurn().resolve(ok("all done"));
  await tick();
  assert.equal(w.once.outcome, "ok");
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].title, "botty replied");
});

test("a watcher that throws is caught and logged; the turn still completes", async () => {
  const { engine, state, logs } = makeEngine();
  const s = await spawned(engine);
  engine.watchTurns(s.sessionId, () => { throw new Error("watcher broke"); }, { first: true });
  await engine.message(s.sessionId, "go");
  state.instances[0].lastTurn().resolve(ok());
  await tick();
  assert.equal((await engine.get(s.sessionId)).state, "awake");
  assert.ok(logs.some((l) => /watcher broke/.test(l)));
});

// ---------------------------------------------------------------------------
// 2. every end path fires exactly once
// ---------------------------------------------------------------------------

test("fires once: a clean completion is ok", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  const w = watcher();
  engine.watchTurns(s.sessionId, w.fn, { first: true });
  await engine.message(s.sessionId, "go");
  state.instances[0].lastTurn().resolve(ok());
  await tick();
  const c = w.once;
  assert.equal(c.outcome, "ok");
  assert.equal(c.replay, false);
  assert.equal(c.alreadyPushed, false);
  assert.equal(c.errorText, null);
  assert.equal(typeof c.suppressPush, "function");
});

test("fires once: a turn ending in a model error is failed, with the redacted error", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  const w = watcher();
  engine.watchTurns(s.sessionId, w.fn, { first: true });
  await engine.message(s.sessionId, "go");
  state.instances[0].lastTurn().resolve(failedEnd("401 Bearer abc.def-ghi invalid_tools"));
  await tick();
  const c = w.once;
  assert.equal(c.outcome, "failed");
  assert.match(c.errorText, /invalid_tools/);
  assert.doesNotMatch(c.errorText, /abc\.def-ghi/);
});

test("fires once: a rejected prompt (onTurnError) is failed", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  const w = watcher();
  engine.watchTurns(s.sessionId, w.fn, { first: true });
  await engine.message(s.sessionId, "go");
  const refusal = new Error("prompt refused: no such provider");
  refusal.code = "prompt_refused";
  state.instances[0].lastTurn().reject(refusal);
  await tick();
  assert.equal(w.once.outcome, "failed");
  assert.match(w.calls[0].errorText, /prompt refused/);
});

test("fires once: a stall is stalled, and the aborted agent_end that follows fires nothing more", async () => {
  const { engine, clock, state } = makeEngine();
  const s = await spawned(engine);
  const w = watcher();
  engine.watchTurns(s.sessionId, w.fn, { first: true });
  await engine.message(s.sessionId, "silent job");
  clock.advance(60_001);
  await tick();
  assert.equal(w.once.outcome, "stalled");
  state.instances[0].lastTurn().resolve(ok("half"));
  await tick();
  assert.equal(w.calls.length, 1);
});

test("fires once: a stall followed by the prompt's rejection on the same turn is one end", async () => {
  const { engine, clock, state } = makeEngine();
  const s = await spawned(engine);
  const plain = watcher();
  engine.watchTurns(s.sessionId, plain.fn);
  await engine.message(s.sessionId, "silent");
  const pi = state.instances[0];
  pi.abortSince = () => new Promise(() => {});          // hold the abort: the turn stays current
  clock.advance(60_001);
  await tick();
  pi.lastTurn().reject(new Error("timeout:prompt-ack"));
  await tick();
  assert.equal(plain.once.outcome, "stalled");
});

test("fires once: the child dying mid-turn is exited", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  const w = watcher();
  engine.watchTurns(s.sessionId, w.fn, { first: true });
  await engine.message(s.sessionId, "go");
  state.instances[0].exit(3);
  await tick();
  assert.equal(w.once.outcome, "exited");
  assert.match(w.calls[0].errorText, /exited/);
  // the rejected promptTurn that follows reaches onTurnError on a cleared turn: nothing more
  state.instances[0].lastTurn().reject(new Error("pi exited"));
  await tick();
  assert.equal(w.calls.length, 1);
});

test("fires once: the child dying with a deferred overflow turn pending ends that turn as exited", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  const w = watcher();
  engine.watchTurns(s.sessionId, w.fn, { first: true });
  const pi = state.instances[0];
  await deferredOverflow(engine, s, pi);
  assert.equal(w.calls.length, 0, "deferred: not an outcome yet");
  pi.exit(1);
  await tick();
  assert.equal(w.once.outcome, "exited");
});

test("fires once: a child gone before the turn starts (pi_gone) is one end — the exit lands first, the refusal is deduped", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  const w = watcher();
  engine.watchTurns(s.sessionId, w.fn, { first: true });
  const pi = state.instances[0];
  const realStats = pi.getSessionStats.bind(pi);
  pi.getSessionStats = async () => { pi.exit(-1); return realStats(); };
  await assert.rejects(() => engine.message(s.sessionId, "dies mid-stats"), (e) => e.code === "pi_gone");
  await tick();
  // attachExit reacts to `pi.exited` before message() resumes (the engine's
  // own D1 note: it "USUALLY lands first"), so the turn is "exited"; the
  // refuseIfPiGone belt behind it reports "refused" into `turn.watched`.
  assert.equal(w.once.outcome, "exited");
  assert.match(w.calls[0].errorText, /exited/);
});

test("fires once: a tool-budget refusal is refused, before its push, and the record says it pushed", async () => {
  const { engine, bridge, state, pushes } = makeEngine();
  bridge.capFor = () => 1;
  const s = await spawned(engine);
  state.instances[0].toolsCsv = "read,bash";
  const w = watcher();
  engine.watchTurns(s.sessionId, w.fn, { first: true });
  await assert.rejects(() => engine.message(s.sessionId, "work the card"), (e) => e.code === "tool_budget");
  await tick();
  const c = w.once;
  assert.equal(c.outcome, "refused");
  assert.match(c.errorText, /at most 1 tools/);
  assert.equal(c.alreadyPushed, false, "the watcher runs BEFORE the push decision");
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].title, "botty can't run its turn");
  assert.equal(engine._sessionRecordForTest(s.sessionId).firstTurn.pushed, true);
});

test("fires once: a wake that fails on turn 1 is refused with the error's code", async () => {
  const { engine, clock, bridge } = makeEngine();
  const s = await spawned(engine);
  await hibernated(engine, clock, s);
  const w = watcher();
  engine.watchTurns(s.sessionId, w.fn, { first: true });
  bridge.buildBotWorld = async () => { const e = new Error("world broke"); e.code = "world_failed"; throw e; };
  await assert.rejects(() => engine.message(s.sessionId, "wake"), (e) => e.code === "world_failed");
  await tick();
  assert.equal(w.once.outcome, "refused");
  assert.equal(w.calls[0].errorText, "world_failed");
  assert.equal((await engine.get(s.sessionId)).state, "hibernating");
});

test("fires once: a row write that throws on a non-wake turn is refused", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  const w = watcher();
  engine.watchTurns(s.sessionId, w.fn, { first: true });
  const c = raw();
  c.exec("CREATE TRIGGER refuse_row_write BEFORE UPDATE ON bot_sessions BEGIN SELECT RAISE(ABORT, 'row write refused'); END");
  try {
    await assert.rejects(() => engine.message(s.sessionId, "go"), /row write refused/);
  } finally {
    c.exec("DROP TRIGGER refuse_row_write");
    c.close();
  }
  await tick();
  assert.equal(w.once.outcome, "refused");
  assert.match(w.calls[0].errorText, /SQLITE_CONSTRAINT|row write refused/, "the error's code (its message when it has none)");
  assert.equal(state.instances[0].turns.length, 0, "promptTurn never ran");
});

test("fires nothing: a wake refused by a cross-process turn_in_progress belongs to the other process", async () => {
  const { engine, clock, state } = makeEngine();
  const s = await spawned(engine);
  await hibernated(engine, clock, s);
  const w = watcher();
  engine.watchTurns(s.sessionId, w.fn, { first: true });
  const c = raw();
  c.prepare("UPDATE bot_sessions SET status='active', updated_at=datetime('now') WHERE gateway_thread_id=?").run(s.threadId);
  c.close();
  await assert.rejects(() => engine.message(s.sessionId, "wake"), (e) => e.code === "turn_in_progress");
  await tick();
  assert.equal(w.calls.length, 0);
  assert.equal(engine._sessionRecordForTest(s.sessionId).firstTurn, null);
  // the other process's claim ages out: this session's real turn 1 is still reported
  const c2 = raw();
  c2.prepare("UPDATE bot_sessions SET status='waiting-user' WHERE gateway_thread_id=?").run(s.threadId);
  c2.close();
  await engine.message(s.sessionId, "wake");
  state.instances[1].lastTurn().resolve(ok());
  await tick();
  assert.equal(w.once.outcome, "ok");
});

// ---- overflow -------------------------------------------------------------

test("fires once: a deferred overflow whose recovery fails without a retry is failed", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  const w = watcher();
  engine.watchTurns(s.sessionId, w.fn, { first: true });
  const pi = state.instances[0];
  await deferredOverflow(engine, s, pi);
  pi.emit({ type: "compaction_end", reason: "overflow", aborted: false, willRetry: false, errorMessage: "summarization failed" });
  await tick();
  assert.equal(w.once.outcome, "failed");
  assert.match(w.calls[0].errorText, /summarization failed/);
});

test("fires once: a recovered retry (willRetry, then a clean agent_end) is ok", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  const w = watcher();
  engine.watchTurns(s.sessionId, w.fn, { first: true });
  const pi = state.instances[0];
  await deferredOverflow(engine, s, pi);
  pi.emit({ type: "compaction_end", reason: "overflow", aborted: false, willRetry: true, result: { summary: "s" } });
  await tick();
  assert.equal(w.calls.length, 0, "compacted and retrying: still not an outcome");
  pi.emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "fine now" }], stopReason: "stop" }], willRetry: false });
  await tick();
  assert.equal(w.once.outcome, "ok");
  const rec = engine._sessionRecordForTest(s.sessionId);
  assert.equal(rec.overflowTurn, null, "the overflow state is cleared with the recovery");
  assert.equal(rec.overflowCompacting, false);
});

test("fires once: a double overflow (willRetry, then recovery failed) is failed", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  const w = watcher();
  engine.watchTurns(s.sessionId, w.fn, { first: true });
  const pi = state.instances[0];
  await deferredOverflow(engine, s, pi);
  pi.emit({ type: "compaction_end", reason: "overflow", aborted: false, willRetry: true, result: { summary: "s" } });
  await tick();
  pi.emit({ type: "compaction_end", reason: "overflow", aborted: false, willRetry: false, errorMessage: RECOVERY_FAILED });
  await tick();
  assert.equal(w.once.outcome, "failed");
  assert.match(w.calls[0].errorText, /recovery failed/);
});

test("fires once: a retry agent_end carrying an error, then the second compaction_end, is failed; the error row is still drawn", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  const w = watcher();
  engine.watchTurns(s.sessionId, w.fn, { first: true });
  const frames = [];
  await engine.subscribe(s.sessionId, (e) => frames.push(e));
  const pi = state.instances[0];
  await deferredOverflow(engine, s, pi);
  pi.emit({ type: "compaction_end", reason: "overflow", aborted: false, willRetry: true, result: { summary: "s" } });
  pi.emit({ type: "agent_end", messages: [errMsg(OVERFLOW)], willRetry: false });
  await tick();
  assert.equal(w.once.outcome, "failed");
  assert.match(w.calls[0].errorText, /context size/);
  pi.emit({ type: "compaction_end", reason: "overflow", aborted: false, willRetry: false, errorMessage: RECOVERY_FAILED });
  await tick();
  assert.equal(w.calls.length, 1);
  const errs = frames.filter((e) => e.type === "error");
  assert.equal(errs.length, 1, "pi's own 'recovery failed' row is drawn exactly as before");
  assert.match(errs[0].text, /recovery failed/);
});

test("fires once: a willRetry agent_end during the retry is pi's auto-retry, not an end", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  const w = watcher();
  engine.watchTurns(s.sessionId, w.fn, { first: true });
  const pi = state.instances[0];
  await deferredOverflow(engine, s, pi);
  pi.emit({ type: "compaction_end", reason: "overflow", aborted: false, willRetry: true, result: { summary: "s" } });
  pi.emit({ type: "agent_end", messages: [errMsg("503 overloaded")], willRetry: true });
  await tick();
  assert.equal(w.calls.length, 0);
  pi.emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "fine" }], stopReason: "stop" }], willRetry: false });
  await tick();
  assert.equal(w.once.outcome, "ok");
});

test("fires once: the message() backstop ends a retrying turn as ok", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  const w = watcher();
  engine.watchTurns(s.sessionId, w.fn, { first: true });
  const pi = state.instances[0];
  await deferredOverflow(engine, s, pi);
  pi.emit({ type: "compaction_end", reason: "overflow", aborted: false, willRetry: true, result: { summary: "s" } });
  await tick();
  assert.equal(w.calls.length, 0);
  await engine.message(s.sessionId, "again");            // the retry ended unseen; the operator sends again
  assert.equal(w.once.outcome, "ok");
  assert.equal(engine._sessionRecordForTest(s.sessionId).overflowTurn, null);
  pi.lastTurn().resolve(ok());
  await tick();
  assert.equal(w.calls.length, 1, "turn 2's end is not turn 1's");
});

test("a compaction still running when the operator sends again keeps the deferred turn, and its failure still reaches it", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  const w = watcher();
  engine.watchTurns(s.sessionId, w.fn, { first: true });
  const pi = state.instances[0];
  await deferredOverflow(engine, s, pi);
  await engine.message(s.sessionId, "hello?");           // the composer was free again
  assert.equal(w.calls.length, 0, "no backstop while compaction runs");
  pi.emit({ type: "compaction_end", reason: "overflow", aborted: false, willRetry: false, errorMessage: "summarization failed" });
  await tick();
  assert.equal(w.once.outcome, "failed");
});

// ---------------------------------------------------------------------------
// 3. what does not count, and the first-turn record
// ---------------------------------------------------------------------------

test("an aborted turn is not an outcome: the next completed turn is first", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  const w = watcher();
  engine.watchTurns(s.sessionId, w.fn, { first: true });
  await engine.message(s.sessionId, "go");
  await engine.abort(s.sessionId);
  state.instances[0].lastTurn().resolve(ok("half"));
  await tick();
  assert.equal(w.calls.length, 0);
  await engine.message(s.sessionId, "again");
  state.instances[0].lastTurn().resolve(ok());
  await tick();
  assert.equal(w.once.outcome, "ok");
});

test("a parked turn 1 is not the first turn: the watcher fires on turn 2's outcome", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  const w = watcher();
  engine.watchTurns(s.sessionId, w.fn, { first: true });
  await engine.message(s.sessionId, "go");
  const pi = state.instances[0];
  pi.emit({ type: "extension_ui_request", id: "q1", method: "input", title: "Which file?" });
  pi.emit({ type: "extension_ui_request", id: "n1", method: "notify", message: "crow-state:" + JSON.stringify({ kind: "ask-parked", reason: "timeout" }) });
  await tick();
  pi.lastTurn().resolve({ type: "agent_end", messages: [] });
  await tick();
  assert.equal(w.calls.length, 0, "a parked turn is not an outcome");
  assert.equal(engine._sessionRecordForTest(s.sessionId).firstTurn, null);
  await engine.message(s.sessionId, "the second one");
  pi.lastTurn().resolve(failedEnd("500 boom"));
  await tick();
  assert.equal(w.once.outcome, "failed");
  assert.equal(w.calls[0].replay, false);
});

test("turn 1 ending before watchTurns registers is replayed, with alreadyPushed from the record", async () => {
  // under 30 s: nothing was pushed
  const a = makeEngine();
  const sa = await spawned(a.engine, "quick");
  await a.engine.message(sa.sessionId, "go");
  a.state.instances[0].lastTurn().resolve(failedEnd("500 boom"));
  await tick();
  const wa = watcher();
  a.engine.watchTurns(sa.sessionId, wa.fn, { first: true });
  assert.equal(wa.once.outcome, "failed");
  assert.equal(wa.calls[0].replay, true);
  assert.equal(wa.calls[0].alreadyPushed, false);
  assert.match(wa.calls[0].errorText, /boom/);
  assert.equal(a.pushes.length, 0);

  // 30 s or more: Perch's own "turn failed" push already went out
  const b = makeEngine();
  const sb = await spawned(b.engine, "slow");
  await b.engine.message(sb.sessionId, "go");
  b.clock.advance(35_000);
  b.state.instances[0].lastTurn().resolve(failedEnd("500 boom"));
  await tick();
  assert.equal(b.pushes.length, 1);
  assert.equal(b.pushes[0].title, "slow's turn failed");
  const wb = watcher();
  b.engine.watchTurns(sb.sessionId, wb.fn, { first: true });
  assert.equal(wb.once.outcome, "failed");
  assert.equal(wb.calls[0].replay, true);
  assert.equal(wb.calls[0].alreadyPushed, true);

  // a replayed watcher is not kept: turn 2 is not reported to it
  await b.engine.message(sb.sessionId, "again");
  b.state.instances[0].lastTurn().resolve(ok());
  await tick();
  assert.equal(wb.calls.length, 1);
  assert.equal(engine_turnWatchers(b.engine, sb.sessionId), 0);
});

function engine_turnWatchers(engine, sessionId) {
  return engine._sessionRecordForTest(sessionId).turnWatchers.size;
}

test("a message() refused before any turn exists is replayed as firstTurn (refused, with the code)", async () => {
  const { engine, clock, env } = makeEngine();
  const s = await spawned(engine);
  await hibernated(engine, clock, s);
  env.CROW_DISABLE_PERCH = "1";                         // reserveWithEviction throws synchronously
  await assert.rejects(() => engine.message(s.sessionId, "wake"), (e) => e.code === "perch_disabled");
  const w = watcher();
  engine.watchTurns(s.sessionId, w.fn, { first: true });
  const c = w.once;
  assert.equal(c.outcome, "refused");
  assert.equal(c.errorText, "perch_disabled");
  assert.equal(c.replay, true);
  assert.equal(c.alreadyPushed, false);
});

test("a message() refused before any turn exists fires an already-registered first watcher at once", async () => {
  const { engine, clock, env } = makeEngine();
  const s = await spawned(engine);
  await hibernated(engine, clock, s);
  const w = watcher();
  engine.watchTurns(s.sessionId, w.fn, { first: true });
  env.CROW_DISABLE_PERCH = "1";
  await assert.rejects(() => engine.message(s.sessionId, "wake"), (e) => e.code === "perch_disabled");
  assert.equal(w.once.outcome, "refused");
  assert.equal(w.calls[0].replay, false);
});

test("turn_in_progress is not recorded: the running turn reports for itself", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  const w = watcher();
  engine.watchTurns(s.sessionId, w.fn, { first: true });
  await engine.message(s.sessionId, "go");
  await assert.rejects(() => engine.message(s.sessionId, "and this"), (e) => e.code === "turn_in_progress");
  assert.equal(w.calls.length, 0);
  assert.equal(engine._sessionRecordForTest(s.sessionId).firstTurn, null);
  state.instances[0].lastTurn().resolve(ok());
  await tick();
  assert.equal(w.once.outcome, "ok");
});

test("a second turn ending while turn 1 is still compacting does not become firstTurn", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  const w = watcher();
  engine.watchTurns(s.sessionId, w.fn, { first: true });
  const pi = state.instances[0];
  await deferredOverflow(engine, s, pi);
  await engine.message(s.sessionId, "meanwhile");       // compaction still running: turn 1 is kept
  pi.lastTurn().resolve(ok("turn 2 done"));
  await tick();
  assert.equal(w.calls.length, 0, "turn 2 is not turn 1");
  assert.equal(engine._sessionRecordForTest(s.sessionId).firstTurn, null);
  pi.emit({ type: "compaction_end", reason: "overflow", aborted: false, willRetry: false, errorMessage: "summarization failed" });
  await tick();
  assert.equal(w.once.outcome, "failed");
  assert.equal(engine._sessionRecordForTest(s.sessionId).firstTurn.outcome, "failed");
});

test("a plain watcher hears every turn; unwatch stops it", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  const w = watcher();
  const off = engine.watchTurns(s.sessionId, w.fn);
  const pi = state.instances[0];
  await engine.message(s.sessionId, "one");
  pi.lastTurn().resolve(ok());
  await tick();
  await engine.message(s.sessionId, "two");
  pi.lastTurn().resolve(failedEnd());
  await tick();
  assert.deepEqual(w.calls.map((c) => c.outcome), ["ok", "failed"]);
  off();
  await engine.message(s.sessionId, "three");
  pi.lastTurn().resolve(ok());
  await tick();
  assert.equal(w.calls.length, 2);
});

test("firstTurn.pushed: true after a 30 s 'turn failed' push, false under 30 s and false with a live subscriber", async () => {
  const slow = makeEngine();
  const s1 = await spawned(slow.engine, "slow");
  await slow.engine.message(s1.sessionId, "go");
  slow.clock.advance(35_000);
  slow.state.instances[0].lastTurn().resolve(failedEnd());
  await tick();
  assert.equal(slow.pushes.length, 1);
  assert.equal(slow.engine._sessionRecordForTest(s1.sessionId).firstTurn.pushed, true);

  const quick = makeEngine();
  const s2 = await spawned(quick.engine, "quick");
  await quick.engine.message(s2.sessionId, "go");
  quick.state.instances[0].lastTurn().resolve(failedEnd());
  await tick();
  assert.equal(quick.pushes.length, 0);
  assert.equal(quick.engine._sessionRecordForTest(s2.sessionId).firstTurn.pushed, false);

  const watched = makeEngine();
  const s3 = await spawned(watched.engine, "watched");
  await watched.engine.subscribe(s3.sessionId, () => {});
  await watched.engine.message(s3.sessionId, "go");
  watched.clock.advance(35_000);
  watched.state.instances[0].lastTurn().resolve(ok());
  await tick();
  assert.equal(watched.pushes.length, 0);
  assert.deepEqual(watched.engine._sessionRecordForTest(s3.sessionId).firstTurn, { outcome: "ok", errorText: null, pushed: false });
});

// ---------------------------------------------------------------------------
// 4. stop, and push suppression
// ---------------------------------------------------------------------------

test("stop clears the watchers", async () => {
  const { engine } = makeEngine();
  const s = await spawned(engine);
  const w = watcher();
  engine.watchTurns(s.sessionId, w.fn, { first: true });
  engine.watchTurns(s.sessionId, () => {});
  assert.equal(engine_turnWatchers(engine, s.sessionId), 2);
  await engine.stop(s.sessionId);
  assert.equal(engine_turnWatchers(engine, s.sessionId), 0);
  await assert.rejects(() => engine.message(s.sessionId, "more"), (e) => e.code === "session_stopped");
  assert.equal(w.calls.length, 0, "a stop is not an outcome, and the refusal after it reaches no watcher");
});

test("a watcher's suppressPush() drops this turn's own away push (and the record says nothing pushed)", async () => {
  const { engine, clock, state, pushes } = makeEngine();
  const s = await spawned(engine);
  engine.watchTurns(s.sessionId, (ctx) => { if (ctx.outcome !== "ok") ctx.suppressPush(); }, { first: true });
  await engine.message(s.sessionId, "go");
  clock.advance(35_000);
  state.instances[0].lastTurn().resolve(failedEnd());
  await tick();
  assert.equal(pushes.length, 0);
  assert.equal(engine._sessionRecordForTest(s.sessionId).firstTurn.pushed, false);
  // only that turn: the next slow turn pushes as usual
  await engine.message(s.sessionId, "again");
  clock.advance(35_000);
  state.instances[0].lastTurn().resolve(ok());
  await tick();
  assert.equal(pushes.length, 1);
});

test("noPush gates the tool-budget push", async () => {
  const { engine, bridge, state, pushes } = makeEngine();
  bridge.capFor = () => 1;
  const s = await spawned(engine);
  state.instances[0].toolsCsv = "read,bash";
  engine.watchTurns(s.sessionId, (ctx) => ctx.suppressPush(), { first: true });
  await assert.rejects(() => engine.message(s.sessionId, "work the card"), (e) => e.code === "tool_budget");
  await tick();
  assert.equal(pushes.length, 0);
  assert.equal(engine._sessionRecordForTest(s.sessionId).firstTurn.pushed, false);
});

test("suppressTurnEndPush marks the running turn of the session holding the card; nothing else", async () => {
  const { engine, clock, state, pushes } = makeEngine();
  const s = await spawned(engine);
  await engine.attachCard(s.sessionId, 41);
  assert.equal(engine.suppressTurnEndPush(41), false, "no running turn: nothing to suppress");
  assert.equal(engine.suppressTurnEndPush(99), false, "no holder");
  await engine.message(s.sessionId, "work it");
  assert.equal(engine.suppressTurnEndPush("41"), true);
  clock.advance(35_000);
  state.instances[0].lastTurn().resolve(ok("reported already"));
  await tick();
  assert.equal(pushes.length, 0, "the report's own notice reached the operator; no second 'replied'");
  // turn-scoped: the next slow turn pushes
  await engine.message(s.sessionId, "more");
  clock.advance(35_000);
  state.instances[0].lastTurn().resolve(ok());
  await tick();
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].title, "botty replied");
});

// ---------------------------------------------------------------------------
// 5. push behaviour pins: no watcher, no noPush
// ---------------------------------------------------------------------------

test("pin: a turn of 30 s or more pushes 'replied'", async () => {
  const { engine, clock, state, pushes } = makeEngine();
  const s = await spawned(engine, "long");
  await engine.message(s.sessionId, "go");
  clock.advance(30_000);
  state.instances[0].lastTurn().resolve(ok("all done, boss"));
  await tick();
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].title, "long replied");
  assert.equal(pushes[0].body, "all done, boss");
  assert.equal(pushes[0].action_url, "/dashboard/bot-board#bird=" + s.sessionId);
});

test("pin: a failed turn of 30 s or more pushes 'turn failed'", async () => {
  const { engine, clock, state, pushes } = makeEngine();
  const s = await spawned(engine, "broke");
  await engine.message(s.sessionId, "go");
  clock.advance(35_000);
  state.instances[0].lastTurn().resolve(failedEnd("400 invalid_tools"));
  await tick();
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].title, "broke's turn failed");
  assert.match(pushes[0].body, /invalid_tools/);
});

test("pin: a turn under 30 s pushes nothing", async () => {
  const { engine, clock, state, pushes } = makeEngine();
  const s = await spawned(engine, "quick");
  await engine.message(s.sessionId, "go");
  clock.advance(29_999);
  state.instances[0].lastTurn().resolve(ok());
  await tick();
  assert.equal(pushes.length, 0);
});

test("pin: a live subscriber means no push", async () => {
  const { engine, clock, state, pushes } = makeEngine();
  const s = await spawned(engine, "watched");
  const off = await engine.subscribe(s.sessionId, () => {});
  await engine.message(s.sessionId, "go");
  clock.advance(60_000);
  state.instances[0].lastTurn().resolve(ok());
  await tick();
  off();
  assert.equal(pushes.length, 0);
});
