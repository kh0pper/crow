/**
 * Perch Hub P2, Track 3 Task 5 — rpc-state-bridge mirror: engine-side half of
 * the plan-mode drawer. pi-lab's `extensions/rpc-state-bridge.ts` (separate
 * repo, crow-mode branch) forwards the plan-mode bus's `{enabled, executing,
 * todosDone, todosTotal, todos}` state over pi's `extension_ui_request`
 * notify channel as `"crow-state:" + JSON.stringify({kind:"plan-mode", state})`.
 * This file proves the engine's two halves of that contract:
 *   1. `onUiRequest`'s notify branch discriminates the `crow-state:` prefix,
 *      mirrors it into `s.planMode`, and emits `plan_state` (never `log`) —
 *      malformed JSON after the prefix is swallowed, never a throw/log line.
 *   2. `control(sessionId, {planMode})` drives the OTHER direction: it sends
 *      `/plan on` or `/plan off` via `promptAckOnly` (never bare `/plan`,
 *      which toggles) and is refused mid-turn or while hibernating (plan
 *      mode needs a live child).
 *
 * Same harness shape as tests/perch-interactive-controls.test.js (real
 * scratch-DB'd crow.db, injected fake PiRpc/bridge seam, injected
 * clock/timers), with ONE addition: the fake PiRpc implements
 * `promptAckOnly` (Track 3 Task 3's ack-only prompt RPC — never waits for
 * agent_end), recording every call.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "perch-interactive-statebridge-"));
process.env.CROW_DATA_DIR = dir;
process.env.CROW_HOME = join(dir, "home");
delete process.env.CROW_DB_PATH;
process.env.PI_MODELS_JSON = join(dir, "models.json");

const CROW_HOME = process.env.CROW_HOME;
const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

let createInteractiveEngine, _resetInteractiveEngineForTest;

// ---------------------------------------------------------------------------
// fake clock + timers (identical idiom to tests/perch-interactive.test.js)
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
    clearTimer(id) {
      timers.delete(id);
    },
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

const tick = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

// ---------------------------------------------------------------------------
// fake bridge seam, with promptAckOnly
// ---------------------------------------------------------------------------

let pidSeq = 900000;

function makeBridge(opts = {}) {
  const state = {
    worlds: [],
    warm: [],
    meter: [],
    audit: [],
    instances: [],
    modelKey: opts.modelKey || "crow-local/qwen3.6-35b-a3b",
    livePi: 0,
    maxPi: 4,
    projectId: 7,
    promptAckScript: null, // (pi, message) => {success,error}|undefined — per-call override
  };

  class FakePi {
    constructor(o) {
      this.opts = o;
      this.onEvent = o.onEvent;
      this.sent = [];
      this.closed = 0;
      this.trimmed = 0;
      this.turns = [];
      this.ackOnlyCalls = [];
      this._exitCode = null;
      this.proc = { pid: ++pidSeq };
      this.piSessionId = "pisess-" + this.proc.pid;
      let done;
      this.exited = new Promise((r) => { done = r; });
      this._done = done;
      state.instances.push(this);
    }
    async getState() {
      return { data: { sessionId: this.piSessionId } };
    }
    async getSessionStats() {
      return { data: { tokens: { input: 10, output: 5, cacheRead: 0 } } };
    }
    promptTurn(message, ms) {
      const rec = { message, ms };
      rec.promise = new Promise((resolve, reject) => { rec.resolve = resolve; rec.reject = reject; });
      this.turns.push(rec);
      return rec.promise;
    }
    lastTurn() { return this.turns[this.turns.length - 1]; }
    trimLog() { this.trimmed += 1; }
    async abortSince() { return null; }
    send(o) {
      if (this._exitCode != null) throw new Error("pi exited");
      this.sent.push(o);
    }
    /** Mirrors bridge.mjs's PiRpc.promptAckOnly: sends a `prompt` frame and
     * resolves on the ack ONLY — never waits for agent_end. Fail-closed on
     * success !== true. */
    async promptAckOnly(message) {
      if (this._exitCode != null) throw new Error("pi exited");
      const id = "prompt_" + (this._ackSeq = (this._ackSeq || 0) + 1);
      this.send({ type: "prompt", id, message });
      this.ackOnlyCalls.push({ id, message });
      const res = state.promptAckScript ? await state.promptAckScript(this, message) : null;
      const ack = res || { type: "response", command: "prompt", id, success: true };
      if (ack.success !== true) {
        const err = new Error("prompt refused: " + (ack.error || "unknown"));
        err.code = "prompt_refused";
        throw err;
      }
      return ack;
    }
    async close() {
      this.closed += 1;
      this.exit(0);
    }
    exit(code = 0) {
      if (this._exitCode != null) return;
      this._exitCode = code;
      this._done(code);
    }
    _exitError() { return new Error("pi exited (code " + this._exitCode + ") before responding"); }
    emit(m) { this.onEvent(m); }
  }

  const seam = {
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
        projectId: state.projectId,
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
        provider: state.modelKey.split("/")[0],
        model: state.modelKey.split("/").slice(1).join("/"),
        key: state.modelKey,
        escalated: false,
        source: "default",
        escalationRequestedButUnavailable: false,
      };
      return {
        sysFile: join(dir, "sys.md"),
        selfAuthoringDir: null,
        resolved,
        piRpcOpts: {
          def: world.def,
          sessionDir: world.sessionDir,
          resolved,
          selfAuthoringDir: null,
          remoteEnabled: world.remoteEnabled,
          narrowedTools: world.narrowedTools,
          appendSystemPromptFile: join(dir, "sys.md"),
        },
      };
    },
    async warmModel(provider) {
      state.warm.push(provider);
    },
    async meterTurn(args) {
      state.meter.push(args);
      return { recorded: true };
    },
    appendAudit(projectId, o) { state.audit.push({ projectId, ...o }); },
  };
  return seam;
}

function makeEngine(o = {}) {
  const clock = makeClock();
  const bridge = o.bridge || makeBridge(o.bridgeOpts);
  const env = Object.assign({ CROW_HOME }, o.env);
  const engine = createInteractiveEngine({
    crowHome: CROW_HOME,
    env,
    bridge,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    log: () => {},
  });
  return { engine, clock, bridge, env, state: bridge._state };
}

async function collect(engine, sessionId) {
  const events = [];
  const off = await engine.subscribe(sessionId, (e) => events.push(e));
  return { events, off, ofType: (t) => events.filter((e) => e.type === t) };
}

async function spawned(engine, botId = "botty") {
  const r = await engine.spawn({ botId });
  await tick();
  return r;
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

// The REAL bus payload (verified, pi-lab plan-mode/index.ts:300-307):
// {enabled, executing, todosDone, todosTotal, todos}.
const REAL_STATE = { enabled: true, executing: false, todosDone: 0, todosTotal: 0, todos: [] };
function crowStateFrame(state = REAL_STATE) {
  return "crow-state:" + JSON.stringify({ kind: "plan-mode", state });
}

// ---------------------------------------------------------------------------
// 1. onUiRequest: crow-state mirror (incoming, pi-lab -> engine)
// ---------------------------------------------------------------------------

test("extension_ui_request notify carrying a crow-state: plan-mode frame emits plan_state (never log) and updates snapshot/state.planMode", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  const pi = state.instances[0];
  const sink = await collect(engine, s.sessionId);

  pi.emit({ type: "extension_ui_request", method: "notify", message: crowStateFrame() });

  const planStates = sink.ofType("plan_state");
  assert.equal(planStates.length, 1);
  assert.deepEqual(planStates[0].state, REAL_STATE);
  assert.equal(sink.ofType("log").length, 0, "a crow-state: frame must never become a log line");

  const snap = await engine.get(s.sessionId);
  assert.deepEqual(snap.planMode, REAL_STATE);
});

test("ordinary notify (no crow-state: prefix) still becomes a log line (regression)", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  const pi = state.instances[0];
  const sink = await collect(engine, s.sessionId);

  pi.emit({ type: "extension_ui_request", method: "notify", message: "plain operator note" });

  assert.deepEqual(sink.ofType("log").map((e) => e.text), ["plain operator note"]);
  assert.equal(sink.ofType("plan_state").length, 0);
});

test("malformed JSON after the crow-state: prefix is swallowed — no log line, no plan_state, no throw", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  const pi = state.instances[0];
  const sink = await collect(engine, s.sessionId);

  assert.doesNotThrow(() => {
    pi.emit({ type: "extension_ui_request", method: "notify", message: "crow-state:{not valid json" });
  });

  assert.equal(sink.ofType("log").length, 0);
  assert.equal(sink.ofType("plan_state").length, 0);
  const snap = await engine.get(s.sessionId);
  assert.equal(snap.planMode, null, "no state was mirrored from malformed JSON");
});

test("re-subscribe replays plan_state when s.planMode is set", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  const pi = state.instances[0];

  pi.emit({ type: "extension_ui_request", method: "notify", message: crowStateFrame() });

  const sink = await collect(engine, s.sessionId); // fresh subscriber, after the mirror landed
  const planStates = sink.ofType("plan_state");
  assert.equal(planStates.length, 1, "subscribe() replays the last known plan_state to a late subscriber");
  assert.deepEqual(planStates[0].state, REAL_STATE);
});

test("re-subscribe before any plan-mode frame: no plan_state replay (s.planMode is still null)", async () => {
  const { engine } = makeEngine();
  const s = await spawned(engine);
  const sink = await collect(engine, s.sessionId);
  assert.equal(sink.ofType("plan_state").length, 0);
});

// ---------------------------------------------------------------------------
// 2. control({planMode}) — outgoing direction (engine -> pi-lab)
// ---------------------------------------------------------------------------

test("control({planMode:true}) sends /plan on via promptAckOnly (ack-only, no agent_end waiter left)", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  const pi = state.instances[0];

  const r = await engine.control(s.sessionId, { planMode: true });

  assert.deepEqual(pi.ackOnlyCalls.map((c) => c.message), ["/plan on"], "never bare /plan — that toggles");
  assert.equal(pi.turns.length, 0, "promptAckOnly must never leave an agent_end waiter behind");
  assert.equal(r.applied.planMode, true);
});

test("control({planMode:false}) sends /plan off via promptAckOnly", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  const pi = state.instances[0];

  const r = await engine.control(s.sessionId, { planMode: false });

  assert.deepEqual(pi.ackOnlyCalls.map((c) => c.message), ["/plan off"]);
  assert.equal(pi.turns.length, 0);
  assert.equal(r.applied.planMode, false);
});

test("control({planMode}) is refused with turn_in_progress while a turn is in flight", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  await engine.message(s.sessionId, "long one");

  await assert.rejects(
    () => engine.control(s.sessionId, { planMode: true }),
    (e) => e.code === "turn_in_progress"
  );
  assert.equal(state.instances[0].ackOnlyCalls.length, 0, "the switch never reached the child mid-turn");
});

test("control({planMode}) is refused while hibernating — plan mode needs a live child", async () => {
  const { engine, clock, state } = makeEngine();
  const s = await spawned(engine);
  clock.advance(600_001);
  await tick();
  assert.equal((await engine.get(s.sessionId)).state, "hibernating");

  await assert.rejects(() => engine.control(s.sessionId, { planMode: true }));
  assert.equal(state.instances[0].ackOnlyCalls.length, 0);
});

test("control({planMode}) propagates prompt_refused when the child's ack fails (fail-closed)", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  state.promptAckScript = async (_pi, message) => ({ success: false, error: "no plan-mode extension loaded" });

  await assert.rejects(
    () => engine.control(s.sessionId, { planMode: true }),
    (e) => e.code === "prompt_refused"
  );
});

test("control(): non-boolean planMode is refused with bad_request", async () => {
  const { engine } = makeEngine();
  const s = await spawned(engine);
  await assert.rejects(
    () => engine.control(s.sessionId, { planMode: "on" }),
    (e) => e.code === "bad_request"
  );
});
