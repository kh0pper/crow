/**
 * Perch Hub P2, Track 3 Task 4 — engine model tracking, control(), options(),
 * warm-on-switch, engine-owned permission mode.
 *
 * A SEPARATE harness from tests/perch-interactive.test.js (per the task
 * brief: extend the pattern here rather than bloating the existing file).
 * Same shape as that file's harness — real scratch-DB'd crow.db, an injected
 * fake PiRpc/bridge seam, injected clock/timers — with ONE addition: the fake
 * PiRpc here implements `commandSince` (Track 3 Task 3's correlated
 * slash-command RPC), recording every call and answering with protocol-shaped
 * responses (`set_model`/`set_thinking_level`/`get_available_models`/
 * `get_available_thinking_levels`), scriptable per test.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const dir = mkdtempSync(join(tmpdir(), "perch-interactive-controls-"));
process.env.CROW_DATA_DIR = dir;
process.env.CROW_HOME = join(dir, "home");
delete process.env.CROW_DB_PATH;
process.env.PI_MODELS_JSON = join(dir, "models.json");

const CROW_HOME = process.env.CROW_HOME;
const DB_FILE = join(dir, "crow.db");
const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const LEASE_PATH = join(CROW_HOME, "perch-interactive-leases.json");

let createInteractiveEngine, _resetInteractiveEngineForTest;

function raw() {
  return new Database(DB_FILE);
}

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
// fake bridge seam, with commandSince
// ---------------------------------------------------------------------------

let pidSeq = 800000;

function makeBridge(opts = {}) {
  const state = {
    worlds: [],
    warm: [],           // every warmModel(provider) call, in call order
    meter: [],
    audit: [],
    instances: [],
    callOrder: [],       // e.g. "warm:crow-local", "command:set_model" — shared cross-instance order
    modelKey: opts.modelKey || "crow-local/qwen3.6-35b-a3b",
    piSessionIdInRow: opts.piSessionIdInRow == null ? null : opts.piSessionIdInRow,
    livePi: 0,
    maxPi: 4,
    projectId: 7,
    commandScript: null,  // (pi, payload) => response|undefined — per-call override
    availableModels: [{ provider: "crow-local", id: "qwen3.6-35b-a3b" }, { provider: "crow-chat", id: "big-model" }],
    availableThinkingLevels: ["off", "low", "high"],
  };

  class FakePi {
    constructor(o) {
      this.opts = o;
      this.onEvent = o.onEvent;
      this.sent = [];
      this.closed = 0;
      this.trimmed = 0;
      this.turns = [];
      this.commands = [];
      this._exitCode = null;
      this.proc = { pid: ++pidSeq };
      this.piSessionId = "pisess-" + this.proc.pid;
      this.statsSeq = 0;
      let done;
      this.exited = new Promise((r) => { done = r; });
      this._done = done;
      state.instances.push(this);
    }
    async getState() {
      return { data: { sessionId: this.piSessionId } };
    }
    async getSessionStats() {
      this.statsSeq += 1;
      return { data: { tokens: { input: 10 * this.statsSeq, output: 5 * this.statsSeq, cacheRead: 0 } } };
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
    /** Test driver: mirrors PiRpc.commandSince's real contract (Track 3 Task
     * 3) — id-correlated request, success:true|false response, fail-closed
     * (success !== true) => err.code = "command_failed". */
    async commandSince(payload) {
      state.callOrder.push("command:" + payload.type);
      this.commands.push(payload);
      let res = state.commandScript ? await state.commandScript(this, payload) : null;
      if (!res) {
        switch (payload.type) {
          case "set_model":
            res = { type: "response", command: "set_model", success: true,
              data: { provider: payload.provider, id: payload.modelId } };
            break;
          case "set_thinking_level":
            res = { type: "response", command: "set_thinking_level", success: true };
            break;
          case "get_available_models":
            res = { type: "response", command: "get_available_models", success: true,
              data: { models: state.availableModels } };
            break;
          case "get_available_thinking_levels":
            res = { type: "response", command: "get_available_thinking_levels", success: true,
              data: { levels: state.availableThinkingLevels } };
            break;
          default:
            res = { type: "response", command: payload.type, success: true };
        }
      }
      if (res.success !== true) {
        const err = new Error(payload.type + " failed: " + (res.error || "unknown"));
        err.code = "command_failed";
        throw err;
      }
      return res;
    }
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
        session: state.piSessionIdInRow ? { id: 1, pi_session_id: state.piSessionIdInRow } : null,
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
      state.callOrder.push("warm:" + provider);
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
    providers: {
      "crow-local": { models: [{ id: "qwen3.6-35b-a3b" }] },
      "crow-chat": { models: [{ id: "big-model" }] },
    },
  }));
  const mod = await import("../servers/gateway/perch-interactive.js");
  createInteractiveEngine = mod.createInteractiveEngine;
  _resetInteractiveEngineForTest = mod._resetInteractiveEngineForTest;
});

beforeEach(() => {
  if (_resetInteractiveEngineForTest) _resetInteractiveEngineForTest();
  try { rmSync(LEASE_PATH, { force: true }); } catch { /* not there */ }
});

after(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});

// ---------------------------------------------------------------------------
// 0. steer: an empty message is a client bug, refused loudly (acceptance F3)
// ---------------------------------------------------------------------------

test("steer: empty / whitespace message is refused with empty_message and nothing is sent to pi", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  await engine.message(s.sessionId, "go"); // turn in flight (promptTurn pending)
  const pi = state.instances[0];
  const before = pi.sent.length;
  await assert.rejects(() => engine.steer(s.sessionId, "   "), (e) => e.code === "empty_message");
  await assert.rejects(() => engine.steer(s.sessionId, ""), (e) => e.code === "empty_message");
  await assert.rejects(() => engine.steer(s.sessionId, null), (e) => e.code === "empty_message");
  assert.equal(pi.sent.length, before, "no steer frame reached pi");
  const r = await engine.steer(s.sessionId, "  go left ");
  assert.deepEqual(r, { ok: true });
  assert.equal(pi.sent.length, before + 1, "a real steer still goes through unchanged");
  pi.lastTurn().resolve({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }] });
  await tick();
});

test("steer: empty message is reported as empty_message even when no turn is running (client bug beats no_turn)", async () => {
  const { engine } = makeEngine();
  const s = await spawned(engine);
  await assert.rejects(() => engine.steer(s.sessionId, " "), (e) => e.code === "empty_message");
  await assert.rejects(() => engine.steer(s.sessionId, "x"), (e) => e.code === "no_turn");
});

// ---------------------------------------------------------------------------
// 0b. cycle/wake progress is visible in the drawer (acceptance F4)
// ---------------------------------------------------------------------------

test("cycle emits progress log lines: cycling, world rebuilt, model warm, context re-read warning", async () => {
  const { engine } = makeEngine();
  const s = await spawned(engine);
  // The fake world writes no .mcp.json; seed one where the real writeBotMcp
  // would put it so the "world rebuilt" line can report the ACTIVE count
  // (disabled entries are canonical leftovers, not minted servers).
  writeFileSync(join(dir, "bots", "botty", ".mcp.json"), JSON.stringify({
    mcpServers: { tasks: { command: "node" }, board: { url: "http://127.0.0.1:1/board/mcp" }, other: { disabled: true } },
  }));
  const logs = [];
  const unsub = await engine.subscribe(s.sessionId, (ev) => { if (ev.type === "log") logs.push(ev.text); });
  await engine.cycle(s.sessionId);
  unsub();
  assert.ok(logs.some((t) => /^cycling: stopping the child/.test(t)), logs.join("|"));
  assert.ok(logs.some((t) => t === "world rebuilt: 2 MCP server(s) minted"), logs.join("|"));
  assert.ok(logs.some((t) => /^model warm: crow-local\/qwen3\.6-35b-a3b/.test(t)), logs.join("|"));
  assert.ok(logs.some((t) => /re-reads its full transcript/.test(t)), logs.join("|"));
  // Order matters to an operator watching the drawer: the warning that the
  // first turn will be slow is the LAST line, after the child is up.
  const idx = (re) => logs.findIndex((t) => re.test(t));
  assert.ok(idx(/^cycling:/) < idx(/^world rebuilt/), "cycling precedes world rebuilt");
  assert.ok(idx(/^world rebuilt/) < idx(/^model warm:/), "world rebuilt precedes model warm");
  assert.ok(idx(/^model warm:/) < idx(/re-reads its full transcript/), "model warm precedes the ready line");
});

test("wake (hibernate -> message) emits the world rebuilt + model warm lines too", async () => {
  const { engine, clock, state } = makeEngine();
  const s = await spawned(engine);
  clock.advance(600_001); // idle timer -> hibernate
  await tick();
  assert.equal((await engine.get(s.sessionId)).state, "hibernating");
  const logs = [];
  const unsub = await engine.subscribe(s.sessionId, (ev) => { if (ev.type === "log") logs.push(ev.text); });
  await engine.message(s.sessionId, "wake up");
  unsub();
  assert.ok(logs.some((t) => /^world rebuilt/.test(t)), logs.join("|"));
  assert.ok(logs.some((t) => /^model warm:/.test(t)), logs.join("|"));
  const pi = state.instances[state.instances.length - 1];
  pi.lastTurn().resolve({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }] });
  await tick();
});

// ---------------------------------------------------------------------------
// 1. model_select event tracking
// ---------------------------------------------------------------------------

test("model_select event: updates snapshot().model and the NEXT turn's meterTurn resolved.key", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  const pi = state.instances[0];
  assert.equal((await engine.get(s.sessionId)).model, "crow-local/qwen3.6-35b-a3b", "starts on the spawn-resolved model");

  // pi picked a different model on its own (its own /model, or an
  // auto-fallback) — real event shape verified: {model:{provider, id}}.
  pi.emit({ type: "model_select", model: { provider: "crow-chat", id: "big-model" }, previousModel: null, source: "user" });

  assert.equal((await engine.get(s.sessionId)).model, "crow-chat/big-model", "snapshot reports the tracked model immediately");

  await engine.message(s.sessionId, "go");
  pi.lastTurn().resolve({
    type: "agent_end",
    messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }],
  });
  await tick();

  assert.equal(state.meter.length, 1);
  assert.equal(state.meter[0].resolved.key, "crow-chat/big-model", "the NEXT turn's meterTurn prices the serving model, not the spawn model");
});

test("model_select event: emits a state event and a 'now on <key>' log note", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  const pi = state.instances[0];
  const sink = await collect(engine, s.sessionId);

  pi.emit({ type: "model_select", model: { provider: "crow-chat", id: "big-model" }, previousModel: null, source: "user" });

  const logs = sink.ofType("log");
  assert.ok(logs.some((e) => e.text === "now on crow-chat/big-model"));
  const states = sink.ofType("state");
  assert.ok(states.some((e) => e.model === "crow-chat/big-model"));
});

test("model_select event: dedupes on an unchanged value — no duplicate log/state when the value already matches", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  const pi = state.instances[0];
  const sink = await collect(engine, s.sessionId);

  pi.emit({ type: "model_select", model: { provider: "crow-chat", id: "big-model" }, previousModel: null, source: "user" });
  const afterFirst = sink.events.length;
  pi.emit({ type: "model_select", model: { provider: "crow-chat", id: "big-model" }, previousModel: null, source: "user" });
  assert.equal(sink.events.length, afterFirst, "a repeat model_select carrying the SAME value produces no new events");
});

test("model_select event: malformed model payload (missing id) is silently ignored — no crash, no state change", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  const pi = state.instances[0];
  const before = (await engine.get(s.sessionId)).model;
  pi.emit({ type: "model_select", model: { provider: "crow-chat" } });
  assert.equal((await engine.get(s.sessionId)).model, before);
});

// ---------------------------------------------------------------------------
// 2. control() — model switch while awake
// ---------------------------------------------------------------------------

test("control() model switch (awake): warmModel is called BEFORE commandSince (assert call order)", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  state.callOrder.length = 0;   // clear the spawn's own warm call

  const r = await engine.control(s.sessionId, { model: { provider: "crow-chat", modelId: "big-model" } });

  assert.deepEqual(state.callOrder, ["warm:crow-chat", "command:set_model"],
    "warmModel(provider) must complete before the set_model commandSince — pi-lab's local-models starter self-disables in bots");
  assert.equal(r.applied.model, "crow-chat/big-model");
  assert.deepEqual(r.bindsAtWake, {}, "an awake switch applies live — nothing pending for the next wake");
});

test("control() model switch (awake): updates currentModel/resolved so snapshot() and the audit both report the new model", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  await engine.control(s.sessionId, { model: { provider: "crow-chat", modelId: "big-model" } });
  assert.equal((await engine.get(s.sessionId)).model, "crow-chat/big-model");

  await engine.message(s.sessionId, "go");
  const pi = state.instances[0];
  pi.lastTurn().resolve({
    type: "agent_end",
    messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }],
  });
  await tick();
  assert.equal(state.audit[0].payload.model, "crow-chat/big-model");
});

test("control() model switch while hibernating: nothing live to command — tracked for the next wake under bindsAtWake", async () => {
  const { engine, clock, state } = makeEngine();
  const s = await spawned(engine);
  clock.advance(600_001);
  await tick();
  assert.equal((await engine.get(s.sessionId)).state, "hibernating");

  const r = await engine.control(s.sessionId, { model: { provider: "crow-chat", modelId: "big-model" } });
  assert.deepEqual(r.applied, {}, "no live child — nothing applied");
  assert.equal(r.bindsAtWake.model, "crow-chat/big-model");
  assert.equal(state.instances[0].commands.length, 0, "no commandSince on a dead child");
});

// ---------------------------------------------------------------------------
// 3. hibernate → wake fidelity (spec §8 / review finding 8)
// ---------------------------------------------------------------------------

test("hibernate -> message (wake): the fresh PiRpc gets the TRACKED model, the wake's warmModel gets the TRACKED provider, and the post-wake turn's meterTurn prices the TRACKED model", async () => {
  const { engine, clock, state } = makeEngine();
  const s = await spawned(engine);
  const firstPi = state.instances[0];

  // Track a switch away from the spawn-resolved model, via a live child event
  // (equally reachable via control() — this exercises the OTHER of the two
  // producers behavior 1 names).
  firstPi.emit({ type: "model_select", model: { provider: "crow-chat", id: "big-model" }, previousModel: null, source: "user" });
  assert.equal((await engine.get(s.sessionId)).model, "crow-chat/big-model");

  clock.advance(600_001);
  await tick();
  assert.equal((await engine.get(s.sessionId)).state, "hibernating");

  state.warm.length = 0;
  await engine.message(s.sessionId, "back again");
  await tick();

  assert.equal(state.instances.length, 2, "a fresh child was constructed for the wake");
  const wakePi = state.instances[1];
  assert.equal(wakePi.opts.resolved.key, "crow-chat/big-model", "the wake's PiRpc constructor receives the TRACKED model, not the spawn-resolved one");
  assert.deepEqual(state.warm, ["crow-chat"], "the wake's warmModel call warms the TRACKED provider");

  wakePi.lastTurn().resolve({
    type: "agent_end",
    messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }],
  });
  await tick();
  assert.equal(state.meter.length, 1);
  assert.equal(state.meter[0].resolved.key, "crow-chat/big-model", "the post-wake turn's metering prices the TRACKED model from turn 1");
});

test("hibernate -> message (wake): a model tracked via control() while hibernating also lands on the fresh PiRpc", async () => {
  const { engine, clock, state } = makeEngine();
  const s = await spawned(engine);
  clock.advance(600_001);
  await tick();

  await engine.control(s.sessionId, { model: { provider: "crow-chat", modelId: "big-model" } });
  await engine.message(s.sessionId, "wake");
  await tick();

  const wakePi = state.instances[1];
  assert.equal(wakePi.opts.resolved.key, "crow-chat/big-model");
});

// ---------------------------------------------------------------------------
// 4. permissionMode — binds at wake, never live
// ---------------------------------------------------------------------------

test("control({permissionMode:'bypass'}) while awake: returned under bindsAtWake (never applied), and the next wake's PiRpc opts carry it", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  const sink = await collect(engine, s.sessionId);

  const r = await engine.control(s.sessionId, { permissionMode: "bypass" });
  assert.deepEqual(r.applied, {}, "permission mode NEVER applies live — pi's policy is fixed via env at spawn time");
  assert.equal(r.bindsAtWake.permissionMode, "bypass");
  assert.equal((await engine.get(s.sessionId)).permissionMode, "bypass", "the session record reflects it immediately");
  assert.ok(sink.ofType("log").some((e) => e.text === "permission mode → bypass"), "spec §4.1.4 visible system note");

  // Force a wake (hibernate the awake session, then message it) and assert
  // the fresh PiRpc's opts carry the stored mode.
  await engine.stop(s.sessionId).catch(() => {});
});

test("permissionMode binds at the NEXT wake's PiRpc opts (not applied to the currently-awake child)", async () => {
  const { engine, clock, state } = makeEngine();
  const s = await spawned(engine);
  await engine.control(s.sessionId, { permissionMode: "bypass" });

  clock.advance(600_001);
  await tick();
  assert.equal((await engine.get(s.sessionId)).state, "hibernating");

  await engine.message(s.sessionId, "wake");
  await tick();
  const wakePi = state.instances[1];
  assert.equal(wakePi.opts.permissionMode, "bypass", "the wake's PiRpc opts carry the stored permission mode");
});

test("adopt (fresh engine over the same row): snapshot reports permissionMode 'guarded' — reset on restart (spec §5.3)", async () => {
  const { engine: engineA, state } = makeEngine();
  const s = await spawned(engineA);
  await engineA.control(s.sessionId, { permissionMode: "bypass" });
  assert.equal((await engineA.get(s.sessionId)).permissionMode, "bypass");
  await engineA.stopAll();

  // A brand-new engine over the SAME scratch DB, as a restarted gateway
  // process would be. It has never held this session — get() adopts the row.
  const { engine: engineB } = makeEngine();
  const snap = await engineB.get(s.sessionId);
  assert.ok(snap, "the row is adopted");
  assert.equal(snap.permissionMode, "guarded", "a restart must never silently resurrect 'bypass'");
});

// ---------------------------------------------------------------------------
// 5. control() refusals
// ---------------------------------------------------------------------------

test("control(): model/thinking switches are refused with turn_in_progress while a turn is in flight", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  await engine.message(s.sessionId, "long one");

  await assert.rejects(
    () => engine.control(s.sessionId, { model: { provider: "crow-chat", modelId: "big-model" } }),
    (e) => e.code === "turn_in_progress"
  );
  await assert.rejects(
    () => engine.control(s.sessionId, { thinking: "high" }),
    (e) => e.code === "turn_in_progress"
  );
  assert.equal(state.instances[0].commands.length, 0, "neither switch reached the child mid-turn");
});

test("control(): permissionMode is NOT refused mid-turn (it never touches the live child)", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  await engine.message(s.sessionId, "long one");
  const r = await engine.control(s.sessionId, { permissionMode: "ask" });
  assert.equal(r.bindsAtWake.permissionMode, "ask");
});

test("control(): unknown permissionMode value is refused with bad_request", async () => {
  const { engine } = makeEngine();
  const s = await spawned(engine);
  await assert.rejects(
    () => engine.control(s.sessionId, { permissionMode: "yolo" }),
    (e) => e.code === "bad_request"
  );
});

test("control(): unknown thinking level and a model missing modelId are both refused with bad_request", async () => {
  const { engine } = makeEngine();
  const s = await spawned(engine);
  await assert.rejects(
    () => engine.control(s.sessionId, { thinking: "ultra-mega" }),
    (e) => e.code === "bad_request"
  );
  await assert.rejects(
    () => engine.control(s.sessionId, { model: { provider: "crow-chat" } }),
    (e) => e.code === "bad_request"
  );
});

test("control(): no_such_session and session_stopped refusals", async () => {
  const { engine } = makeEngine();
  await assert.rejects(
    () => engine.control("perchlive-nope", { permissionMode: "ask" }),
    (e) => e.code === "no_such_session"
  );
  const s = await spawned(engine);
  await engine.stop(s.sessionId);
  await assert.rejects(
    () => engine.control(s.sessionId, { permissionMode: "ask" }),
    (e) => e.code === "session_stopped"
  );
});

// ---------------------------------------------------------------------------
// 6. thinking level — live passthrough, no persistence
// ---------------------------------------------------------------------------

test("control({thinking}) while awake: sent live via commandSince set_thinking_level, applied reported", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  const r = await engine.control(s.sessionId, { thinking: "high" });
  assert.equal(r.applied.thinking, "high");
  const pi = state.instances[0];
  assert.deepEqual(pi.commands[0], { type: "set_thinking_level", level: "high" });
});

test("control({thinking}) while hibernating: a no-op — no persistence field exists to bind at wake (pi's own session file remembers it across --session resume; verified by rpc-types.d.ts: no CLI flag overrides a resumed session's thinking level)", async () => {
  const { engine, clock } = makeEngine();
  const s = await spawned(engine);
  clock.advance(600_001);
  await new Promise((r) => setImmediate(r));
  const r = await engine.control(s.sessionId, { thinking: "high" });
  assert.deepEqual(r.applied, {});
  assert.deepEqual(r.bindsAtWake, {}, "thinking level is never persisted by this engine");
});

// ---------------------------------------------------------------------------
// 7. options()
// ---------------------------------------------------------------------------

test("options(): awake session returns the live models + thinking levels from the child", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  const r = await engine.options(s.sessionId);
  assert.deepEqual(r.models, [{ provider: "crow-local", id: "qwen3.6-35b-a3b" }, { provider: "crow-chat", id: "big-model" }]);
  assert.deepEqual(r.thinkingLevels, ["off", "low", "high"]);
});

test("options(): hibernating session returns {models: null, thinkingLevels: null} — never wakes a child just to list", async () => {
  const { engine, clock, state } = makeEngine();
  const s = await spawned(engine);
  clock.advance(600_001);
  await tick();
  assert.equal((await engine.get(s.sessionId)).state, "hibernating");
  const r = await engine.options(s.sessionId);
  assert.deepEqual(r, { models: null, thinkingLevels: null });
  assert.equal(state.instances.length, 1, "no second child was spawned");
});

test("options(): unknown session is refused with no_such_session", async () => {
  const { engine } = makeEngine();
  await assert.rejects(() => engine.options("perchlive-nope"), (e) => e.code === "no_such_session");
});
