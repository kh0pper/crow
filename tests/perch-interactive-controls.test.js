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
      // Wave 2: PiRpc exposes the FINAL --tools csv it pinned; the engine's
      // Session-tab tool count reads it. A fixed, known list so tests can
      // assert the exact number.
      this.toolsCsv = "read,write,ask_user";
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
        // Mirror the real B2 builder: the effective working directory is the
        // operator's choice when one was passed, else the world root. The
        // engine reads world.cwd into s.cwd, so a spawn/control({cwd}) can be
        // observed end-to-end through the fake seam.
        cwd: args.cwd || join(dir, "bots", args.botId),
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
    // The session-free provider catalogue options() falls back to with no live
    // child. Injected so a test never depends on this machine's provider DB or
    // models.json; omitted, the engine lazily imports perch-model-catalog.js.
    providerModels: o.providerModels,
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

// The launcher's path, end to end on the engine side: the operator picks a
// model beside "New session", the client spawns and then control()s it BEFORE
// any message. The point is that turn 1 is served and priced by the picked
// model, not that a later switch corrects it.
test("launch path: a control() between spawn and the first message serves turn 1 on the picked model", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  assert.equal((await engine.get(s.sessionId)).model, "crow-local/qwen3.6-35b-a3b", "the bot's own default, as spawned");
  const spawnWarms = state.warm.length;

  const r = await engine.control(s.sessionId, { model: { provider: "crow-chat", modelId: "big-model" } });
  assert.equal(r.applied.model, "crow-chat/big-model");
  assert.equal(state.warm[spawnWarms], "crow-chat",
    "the picked provider is warmed before the switch, so the first turn does not race a cold endpoint");
  assert.equal((await engine.get(s.sessionId)).model, "crow-chat/big-model");

  await engine.message(s.sessionId, "hello - can you see the board?");
  state.instances[0].lastTurn().resolve({
    type: "agent_end",
    messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }],
  });
  await tick();
  assert.equal(state.meter.length, 1, "exactly one turn ran");
  assert.equal(state.meter[0].resolved.key, "crow-chat/big-model",
    "TURN ONE is priced on the picked model — not the spawn-resolved one with a switch after it");
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

// The defect Kevin hit: he switched a session to another model, a deploy
// restarted the gateway, and the picker "stopped working". The engine
// hibernates idle sessions by design and adoptRow brings a restart-orphaned
// row back hibernating too, so `models: null` was the answer for the
// commonest state of a perfectly healthy session — and an empty dropdown is
// indistinguishable from a broken page.
const CATALOGUE = [
  { provider: "crow-local", id: "qwen3.6-35b-a3b", name: "Qwen", baseUrl: "http://x:8003/v1" },
  { provider: "raven-flash", id: "flash-next", name: "Flash", baseUrl: "http://y:8010/v1" },
  // Round 3 R2a: the switch tests use crow-chat/big-model (it is in the real
  // models.json fixture this mirrors), so the catalogue that GATES control()
  // must carry it — the rejection cases (ghost/nope) stay valid regardless.
  { provider: "crow-chat", id: "big-model", name: "Big", baseUrl: "http://z:8020/v1" },
];

test("options(): a hibernating session lists the provider catalogue, and still never wakes a child", async () => {
  let calls = 0;
  const { engine, clock, state } = makeEngine({ providerModels: () => { calls++; return CATALOGUE; } });
  const s = await spawned(engine);
  clock.advance(600_001);
  await tick();
  assert.equal((await engine.get(s.sessionId)).state, "hibernating");
  const r = await engine.options(s.sessionId);
  assert.deepEqual(r.models, CATALOGUE, "an empty picker on a live session is the bug this ends");
  assert.equal(calls, 1);
  assert.equal(r.source, "providers", "the caller must not have to infer which half answered");
  // Fix round 1 Q1: a list with no "which one is live" is how the picker came
  // to assert whichever model sorted first.
  assert.equal(r.current, "crow-local/qwen3.6-35b-a3b", "the model this session is actually on");
  // Deliberately still null: control()'s thinking branch is a no-op with no
  // child (pi's own session file owns the level across a --session resume),
  // so offering that picker would promise a change that never happens.
  assert.equal(r.thinkingLevels, null);
  assert.equal(state.instances.length, 1, "no second child was spawned");
});

test("options(): a LIVE child stays authoritative — the catalogue is not even consulted", async () => {
  let calls = 0;
  const { engine } = makeEngine({ providerModels: () => { calls++; return CATALOGUE; } });
  const s = await spawned(engine);
  const r = await engine.options(s.sessionId);
  assert.deepEqual(r.models, [{ provider: "crow-local", id: "qwen3.6-35b-a3b" }, { provider: "crow-chat", id: "big-model" }],
    "pi is the process that will route the next turn; its list wins whenever there is one");
  assert.equal(r.source, "child");
  assert.equal(r.current, "crow-local/qwen3.6-35b-a3b");
  assert.equal(calls, 0);
});

test("options(): `current` follows a model switch, in both the live and the hibernating answer", async () => {
  const { engine, clock, state } = makeEngine({ providerModels: () => CATALOGUE });
  const s = await spawned(engine);
  await engine.control(s.sessionId, { model: { provider: "crow-chat", modelId: "big-model" } });
  assert.equal((await engine.options(s.sessionId)).current, "crow-chat/big-model",
    "a live session reports the model control() moved it to, not the spawn-resolved one");

  clock.advance(600_001);
  await tick();
  const asleep = await engine.options(s.sessionId);
  assert.equal(asleep.source, "providers");
  assert.equal(asleep.current, "crow-chat/big-model",
    "and hibernating it still reports it — that switch binds at the next wake and really works");
  assert.equal(state.instances.length, 1, "still no second child");
});

test("options(): `current` reflects a model pi chose ON ITS OWN, read after the RPCs", async () => {
  // An auto-fallback, or the operator's own /model in the TUI: the engine
  // learns it from a model_select frame, and the picker is about to be set
  // from this value.
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  state.instances[0].emit({ type: "model_select", model: { provider: "crow-chat", id: "big-model" },
    previousModel: null, source: "user" });
  assert.equal((await engine.options(s.sessionId)).current, "crow-chat/big-model");
});

test("options(): a catalogue that throws degrades to an empty list, never a failed GET", async () => {
  const { engine, clock } = makeEngine({ providerModels: () => { throw new Error("no provider registry"); } });
  const s = await spawned(engine);
  clock.advance(600_001);
  await tick();
  const r = await engine.options(s.sessionId);
  assert.deepEqual(r.models, [], "the drawer renders a disabled picker on this — an honest answer");
  assert.equal(r.thinkingLevels, null);
});

test("options(): unknown session is refused with no_such_session", async () => {
  const { engine } = makeEngine();
  await assert.rejects(() => engine.options("perchlive-nope"), (e) => e.code === "no_such_session");
});

// ---------------------------------------------------------------------------
// 8. rename() — "it seems like there is not a way to rename the sessions"
// ---------------------------------------------------------------------------

function labelOf(threadId) {
  const c = raw();
  const row = c.prepare("SELECT label FROM bot_sessions WHERE gateway_thread_id=? ORDER BY id DESC LIMIT 1").get(threadId);
  c.close();
  return row ? row.label : undefined;
}

test("rename(): the name lands on the session's OWN row — no second store", async () => {
  const { engine } = makeEngine();
  const s = await spawned(engine);
  const r = await engine.rename(s.sessionId, "Nov package copy pass");
  assert.deepEqual(r, { label: "Nov package copy pass" });
  assert.equal(labelOf(s.sessionId), "Nov package copy pass");
  assert.equal((await engine.get(s.sessionId)).label, "Nov package copy pass");
});

test("rename(): a name survives a gateway restart, because adoptRow restores it", async () => {
  const { engine } = makeEngine();
  const s = await spawned(engine);
  await engine.rename(s.sessionId, "survives a deploy");

  // A FRESH engine on the same DB: exactly what a restart is, and the state in
  // which the operator hit the empty model picker.
  _resetInteractiveEngineForTest();
  const { engine: reborn } = makeEngine();
  const snap = await reborn.get(s.sessionId);
  assert.equal(snap.state, "hibernating", "precondition: adopted, not held");
  assert.equal(snap.label, "survives a deploy", "a name lost on every restart would make renaming pointless");
});

test("rename(): trimmed, whitespace-collapsed and capped — the WRITER guarantees what is stored", async () => {
  const { engine } = makeEngine();
  const s = await spawned(engine);
  assert.deepEqual(await engine.rename(s.sessionId, "   spaced   out   name  "), { label: "spaced out name" });
  const long = "x".repeat(200);
  const capped = await engine.rename(s.sessionId, long);
  assert.equal(capped.label.length, 80, "80 chars: long enough to be useful, short enough for a 320px column");
  assert.equal(labelOf(s.sessionId).length, 80, "and the ROW holds the capped value, not the raw one");
});

test("rename(): empty CLEARS the name — a real action, not a way to go anonymous", async () => {
  const { engine } = makeEngine();
  const s = await spawned(engine);
  await engine.rename(s.sessionId, "temporary");
  assert.deepEqual(await engine.rename(s.sessionId, "   "), { label: null });
  assert.equal(labelOf(s.sessionId), null, "a COALESCE here would make clearing impossible");
  assert.equal((await engine.get(s.sessionId)).label, null);
});

test("rename(): a later lifecycle write does not resurrect a cleared name", async () => {
  // End-state property, mechanism-independent: whatever writeRow does on the
  // next hibernate, a name the operator cleared stays cleared.
  const { engine, clock } = makeEngine();
  const s = await spawned(engine);
  await engine.rename(s.sessionId, "gone in a moment");
  await engine.rename(s.sessionId, "");
  clock.advance(600_001);
  await tick();
  assert.equal((await engine.get(s.sessionId)).state, "hibernating", "the hibernate wrote the row");
  assert.equal(labelOf(s.sessionId), null);
});

test("rename(): pushes a state event, so an open drawer sees a rename made elsewhere", async () => {
  const { engine } = makeEngine();
  const s = await spawned(engine);
  const sub = await collect(engine, s.sessionId);
  await engine.rename(s.sessionId, "watch this");
  const states = sub.ofType("state");
  assert.ok(states.length >= 1);
  assert.equal(states[states.length - 1].label, "watch this");
  sub.off();
});

test("rename(): a STOPPED session can still be named, and an unknown one is refused", async () => {
  const { engine } = makeEngine();
  const s = await spawned(engine);
  await engine.stop(s.sessionId);
  // Naming a finished session while sorting through what happened is exactly
  // when an operator wants to — and it touches no child, so nothing to refuse.
  assert.deepEqual(await engine.rename(s.sessionId, "the one that failed"), { label: "the one that failed" });
  assert.equal(labelOf(s.sessionId), "the one that failed");
  await assert.rejects(() => engine.rename("perchlive-nope", "x"), (e) => e.code === "no_such_session");
});

test("rename(): a mid-turn rename is never refused — it touches no child", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  await engine.message(s.sessionId, "go");                 // turn in flight
  assert.deepEqual(await engine.rename(s.sessionId, "named mid-turn"), { label: "named mid-turn" });
  state.instances[0].lastTurn().resolve({
    type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }],
  });
  await tick();
});

test("rename(): does not clear the 'interrupted' flag a shutdown left on the row", async () => {
  // writeRow() stamps `status` and resets `control` to 'run' on every call, so
  // rename() deliberately uses a targeted UPDATE instead. stopAll() marks a
  // session that was mid-turn when the gateway went down control='interrupted'
  // and the drawer reads that to say "interrupted, not answered" — a rename
  // must not quietly erase it.
  const { engine } = makeEngine();
  const s = await spawned(engine);
  const c = raw();
  c.prepare("UPDATE bot_sessions SET control='interrupted', status='waiting-user' WHERE gateway_thread_id=?")
    .run(s.sessionId);
  c.close();

  await engine.rename(s.sessionId, "named after the crash");

  const after = raw();
  const row = after.prepare("SELECT control, status, label FROM bot_sessions WHERE gateway_thread_id=?")
    .get(s.sessionId);
  after.close();
  assert.equal(row.label, "named after the crash");
  assert.equal(row.control, "interrupted", "a rename must not reset the control flag");
  assert.equal(row.status, "waiting-user", "nor restamp the status");
});

test("rename(): a session with no row is refused, not answered 200 with nothing written", async () => {
  // Fix round 1 Q4. The silent version returned {label}, the route answered
  // 200, and the list and header painted a name that no row carried and that
  // nothing later repaired — writeRow does not touch the column.
  const { engine } = makeEngine();
  const s = await spawned(engine);
  const rec = engine._sessionRecordForTest(s.sessionId);
  rec.rowId = null;                                  // a session that never got a row
  rec.label = "before";
  await assert.rejects(() => engine.rename(s.sessionId, "after"), (e) => e.code === "not_persisted");
  assert.equal(rec.label, "before",
    "and the in-memory label is rolled back — the engine must not report a name the row lacks");
});

// ---------------------------------------------------------------------------
// Fix round 2 N2 — Q1 survived for every session adopted after a restart.
//
// adoptRow SELECTed the row's `model` and threw it away, so servingModel()
// returned null for every adopted session and options() answered
// `current: null`. The drawer then enabled the picker, populated the whole
// catalogue, and selected option 0 — the exact defect Q1 exists for, in the
// one case the !s.pi branch of options() was added to serve.
//
// This is Kevin's sequence: switch the model, the gateway restarts, open the
// session again.
// ---------------------------------------------------------------------------

function rowModelOf(threadId) {
  const c = raw();
  const row = c.prepare("SELECT model FROM bot_sessions WHERE gateway_thread_id=? ORDER BY id DESC LIMIT 1").get(threadId);
  c.close();
  return row ? row.model : undefined;
}

test("N2: a session adopted after a restart reports the model its ROW carries", async () => {
  const { engine, clock } = makeEngine();
  const s = await spawned(engine);
  // Deliberately NOT the spawn model, and deliberately not first in the
  // fixture catalogue — option 0 must not be able to pass by accident.
  await engine.control(s.sessionId, { model: { provider: "crow-chat", modelId: "big-model" } });
  clock.advance(600_001);
  await tick();
  assert.equal(rowModelOf(s.sessionId), "crow-chat/big-model", "precondition: the row carries it");

  // The restart.
  _resetInteractiveEngineForTest();
  const { engine: reborn } = makeEngine({ providerModels: () => CATALOGUE });
  const snap = await reborn.get(s.sessionId);
  assert.equal(snap.state, "hibernating", "precondition: adopted, not held");
  assert.equal(snap.model, "crow-chat/big-model",
    "measured null before the fix, which made the drawer show whichever model sorted first");

  const opts = await reborn.options(s.sessionId);
  assert.equal(opts.source, "providers");
  assert.equal(opts.current, "crow-chat/big-model", "and the picker is told which entry is live");
  assert.notEqual(opts.current, opts.models[0].provider + "/" + opts.models[0].id,
    "fixture check: the live model is not option 0, or this proves nothing");
});

test("N2: the report and the next WAKE agree — turn 1 runs on the adopted model", async () => {
  // Restoring only a reporting field would swap one lie for a subtler one: the
  // picker saying flash-next while the next turn quietly ran on the def's
  // default. startChild reads currentModelParts before warmModel/PiRpc, so the
  // adopted value is what actually serves.
  const { engine, clock } = makeEngine();
  const s = await spawned(engine);
  await engine.control(s.sessionId, { model: { provider: "crow-chat", modelId: "big-model" } });
  clock.advance(600_001);
  await tick();

  _resetInteractiveEngineForTest();
  const { engine: reborn, state } = makeEngine();
  await reborn.message(s.sessionId, "after the restart");
  await tick();
  const pi = state.instances[state.instances.length - 1];
  pi.lastTurn().resolve({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }] });
  await tick();
  assert.equal(state.meter.length, 1);
  assert.equal(state.meter[0].resolved.key, "crow-chat/big-model",
    "the wake serves the model the row recorded, not the def's default");
  assert.ok(state.warm.includes("crow-chat"), "and warms that provider before spawning");
});

test("N2: a row with no usable model key leaves the tracking alone", async () => {
  const { engine, clock } = makeEngine();
  const s = await spawned(engine);
  clock.advance(600_001);
  await tick();
  for (const bad of ["", "no-slash", "/leading", "trailing/"]) {
    const c = raw();
    c.prepare("UPDATE bot_sessions SET model=? WHERE gateway_thread_id=?").run(bad, s.sessionId);
    c.close();
    _resetInteractiveEngineForTest();
    const { engine: reborn } = makeEngine();
    const snap = await reborn.get(s.sessionId);
    assert.equal(snap.model, null, JSON.stringify(bad) + " must not be parsed into a model");
  }
});

test("N2: a switch made while HIBERNATING also survives the restart", async () => {
  // The other half of the operator's sequence: the session was already asleep
  // when the model was changed, so nothing wakes to write a turn row.
  const { engine, clock } = makeEngine();
  const s = await spawned(engine);
  clock.advance(600_001);
  await tick();
  const r = await engine.control(s.sessionId, { model: { provider: "crow-chat", modelId: "big-model" } });
  assert.equal(r.bindsAtWake.model, "crow-chat/big-model", "precondition: the hibernating path, not the live one");
  assert.equal(rowModelOf(s.sessionId), "crow-chat/big-model",
    "and it reaches the row, or a restart before the next turn loses it");

  _resetInteractiveEngineForTest();
  const { engine: reborn } = makeEngine({ providerModels: () => CATALOGUE });
  assert.equal((await reborn.get(s.sessionId)).model, "crow-chat/big-model");
  assert.equal((await reborn.options(s.sessionId)).current, "crow-chat/big-model");
});

// ---------------------------------------------------------------------------
// Fix round 2 N1, engine side — the frames must NAME their turn.
//
// The drawer judges a `reply` against the turn it completes rather than against
// a client-side memory that a reconnect invalidates. That only works if the
// engine stamps the id, and the client tests build their own frames, so
// nothing over there can prove this half.
// ---------------------------------------------------------------------------

test("N1: text and reply frames carry the id of the turn they belong to", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  const sub = await collect(engine, s.sessionId);
  const pi = state.instances[0];

  const t1 = await engine.message(s.sessionId, "one");
  pi.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "streamed" }] } });
  pi.lastTurn().resolve({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "streamed" }] }] });
  await tick();

  const text1 = sub.ofType("text");
  const reply1 = sub.ofType("reply");
  assert.equal(text1.length, 1);
  assert.equal(reply1.length, 1);
  assert.equal(text1[0].turnId, t1.turnId, "the text frame names the turn message() returned");
  assert.equal(reply1[0].turnId, t1.turnId, "and the reply names the SAME turn it completes");

  const t2 = await engine.message(s.sessionId, "two");
  assert.notEqual(t2.turnId, t1.turnId, "fixture check: a second turn is a different turn");
  pi.lastTurn().resolve({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "again" }] }] });
  await tick();
  const reply2 = sub.ofType("reply");
  assert.equal(reply2.length, 2);
  assert.equal(reply2[1].turnId, t2.turnId,
    "turn 2's reply must be distinguishable from turn 1's — that is the whole mechanism");
  sub.off();
});

test("N1: a child speaking OUTSIDE a turn emits a text frame with a null turn id", async () => {
  // The honest answer, and what the client's fallback flag is for.
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  const sub = await collect(engine, s.sessionId);
  state.instances[0].emit({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "unsolicited" }] },
  });
  await tick();
  const texts = sub.ofType("text");
  assert.equal(texts.length, 1);
  assert.equal(texts[0].turnId, null);
  sub.off();
});

// ---------------------------------------------------------------------------
// Fix round 3 R1 — the row's `model` column means "explicit operator choice"
// and nothing else. The spawn/wake/turn-end stamps wrote the RESOLVER's answer
// into it, and adoptRow then treated every such value as an override: after a
// gateway restart, a changed bot-def default was silently ignored by every
// existing session, forever, self-perpetuated by the next wake's re-stamp.
// ---------------------------------------------------------------------------

test("R1: a def-default change reaches a session whose row carries no explicit choice", async () => {
  // The exact pin the review flagged: spawn on default A, hibernate, change
  // the def to B, restart (adopt), send — turn 1 must run on B. Pre-fix this
  // served A: the row held the stamped default and the restore treated it as
  // the operator's override.
  const { engine, bridge, clock } = makeEngine();
  const s = await spawned(engine);
  clock.advance(600_001);
  await tick();
  assert.equal(rowModelOf(s.sessionId), null, "round 3: a plain spawn leaves the row choiceless");

  bridge._state.modelKey = "crow-chat/big-model";           // the def's new default
  _resetInteractiveEngineForTest();
  const { engine: reborn, state } = makeEngine({ bridge });
  await reborn.message(s.sessionId, "after the def change");
  await tick();
  const pi = state.instances[state.instances.length - 1];
  assert.equal(pi.opts.resolved.key, "crow-chat/big-model",
    "wake follows the DEF, not the old stamped value — this is the whole fix");
  pi.lastTurn().resolve({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }] });
  await tick();
  assert.equal(state.meter[state.meter.length - 1].resolved.key, "crow-chat/big-model",
    "and metering prices the new default, not the pinned one");
});

test("R1: control({model:null}) revokes the choice — row NULLed, next wake re-resolves from the def", async () => {
  // Revocation is what makes a legacy auto-stamped row recoverable from the
  // UI (the drawer's "the bot's own model" option POSTs model:null).
  const { engine, clock } = makeEngine();
  const s = await spawned(engine);
  await engine.control(s.sessionId, { model: { provider: "crow-chat", modelId: "big-model" } });
  assert.equal(rowModelOf(s.sessionId), "crow-chat/big-model", "precondition: an explicit choice is stamped");

  const r = await engine.control(s.sessionId, { model: null });
  assert.equal(r.applied.model, null, "the engine speaks the revocation back");
  assert.equal(rowModelOf(s.sessionId), null, "and it reaches the row");

  // Honest reporting: the live child keeps its model until the next wake —
  // snapshot() must not claim null while it is still serving big-model.
  const snap = await engine.get(s.sessionId);
  assert.equal(snap.model, "crow-chat/big-model", "servingModel falls back to s.resolved — truthful for the live child");

  clock.advance(600_001);
  await tick();
  _resetInteractiveEngineForTest();
  const { engine: reborn, state } = makeEngine();
  await reborn.message(s.sessionId, "wake");
  await tick();
  const pi = state.instances[state.instances.length - 1];
  assert.equal(pi.opts.resolved.key, "crow-local/qwen3.6-35b-a3b",
    "the next wake follows the def again — a revoked choice must not resurrect");
});

test("R1 belt: a model_select landing before any rowId is persisted when the row appears", async () => {
  // Staff review C2: on a fresh spawn there is a window between PiRpc
  // construction and writeRow completing where s.rowId is null. A child's
  // FIRST model_select in that window used to be dropped forever — every
  // later writeRow COALESCE-preserves, it does not re-write from tracking.
  // The fake child emits the event synchronously from the constructor, the
  // hardest shape the window can produce.
  const { engine, bridge } = makeEngine();
  const Base = bridge.PiRpc;
  bridge.PiRpc = class ChattyPi extends Base {
    constructor(o) {
      super(o);
      this.emit({ type: "model_select", model: { provider: "crow-chat", id: "big-model" }, source: "test" });
    }
  };
  const s = await spawned(engine);
  assert.equal(rowModelOf(s.sessionId), "crow-chat/big-model",
    "the writeRow-tail belt replayed the choice that arrived with no rowId");
});

// ---------------------------------------------------------------------------
// Fix round 3 R2 — a dead model key must not become a durable poison pill.
//
// model_resolver.mjs is fail-closed (an invalid key resolves to LOCAL_FALLBACK),
// but control()'s switch and the adopt-restore bypass that resolver entirely:
// the pair is written straight to s.currentModelParts and, now, to the row.
// crow-dsv4 was disabled the very day PR #356 merged, so the case is live.
// Two rails: validate at the switch (R2a), fall open with a log at wake (R2b).
// ---------------------------------------------------------------------------

test("R2a: control() refuses a model the catalogue does not carry, and changes nothing", async () => {
  const { engine } = makeEngine({ providerModels: () => CATALOGUE });   // crow-local/qwen, raven-flash/flash-next
  const s = await spawned(engine);
  await assert.rejects(
    engine.control(s.sessionId, { model: { provider: "ghost", modelId: "nope" } }),
    /bad_request/,
    "an arbitrary pair the instance cannot serve is rejected, not persisted",
  );
  assert.equal(rowModelOf(s.sessionId), null, "the rejection leaves the row choiceless — no pill planted");
  const snap = await engine.get(s.sessionId);
  assert.equal(snap.model, "crow-local/qwen3.6-35b-a3b", "and the in-memory tracking still reports the last-good model");
});

test("R2a: control() accepts a catalogue model even under an injected partial list (the switch's real target)", async () => {
  const { engine } = makeEngine({ providerModels: () => CATALOGUE });
  const s = await spawned(engine);
  const r = await engine.control(s.sessionId, { model: { provider: "raven-flash", modelId: "flash-next" } });
  assert.equal(r.applied.model, "raven-flash/flash-next", "a listed pair switches normally");
  assert.equal(rowModelOf(s.sessionId), "raven-flash/flash-next");
});

test("R2a: an EMPTY catalogue fails open — a registry hiccup must not lock out a live session", async () => {
  const { engine, clock } = makeEngine({ providerModels: () => [] });   // cold/unreadable registry
  const s = await spawned(engine);
  clock.advance(600_001);
  await tick();
  const r = await engine.control(s.sessionId, { model: { provider: "crow-chat", modelId: "big-model" } });
  assert.equal(r.bindsAtWake.model, "crow-chat/big-model",
    "with nothing to check against, the operator's choice is honored, not refused");
});

test("R2b: an adopted session whose recorded model died falls open to the def, with a log", async () => {
  // The exact crow-dsv4 shape: the row carries crow-chat/big-model, a provider
  // later disabled. On wake, servingModel is validated against the catalogue;
  // absent => drop the override, serve the def's fresh resolution, and TELL
  // the operator rather than spawning a child on a provider that cannot answer.
  const { engine, clock } = makeEngine();
  const s = await spawned(engine);
  await engine.control(s.sessionId, { model: { provider: "crow-chat", modelId: "big-model" } });
  assert.equal(rowModelOf(s.sessionId), "crow-chat/big-model", "precondition: the durable choice is in the row");
  clock.advance(600_001);
  await tick();

  _resetInteractiveEngineForTest();
  // A fresh engine whose catalogue no longer lists crow-chat/big-model (it was
  // disabled), while the def still resolves to crow-local's default.
  const { engine: reborn, state } = makeEngine({ providerModels: () => [
    { provider: "crow-local", id: "qwen3.6-35b-a3b", name: "Qwen" },
  ] });
  const sub = await collect(reborn, s.sessionId);
  await reborn.message(s.sessionId, "wake after the provider died");
  await tick();
  const pi = state.instances[state.instances.length - 1];
  assert.equal(pi.opts.resolved.key, "crow-local/qwen3.6-35b-a3b",
    "the dead recorded model is NOT forced onto the wake — the def's resolution serves");
  const logs = sub.ofType("log");
  assert.ok(logs.some((l) => /not available/.test(l.text) && /crow-chat\/big-model/.test(l.text)),
    "and the drawer is told why, naming the dead model");
  assert.equal(rowModelOf(s.sessionId), "crow-chat/big-model",
    "the ROW keeps the choice — a temporarily disabled provider must not erase it");
  sub.off();
});

// ---------------------------------------------------------------------------
// 9. Open-anywhere B4 — cwd is a session property: spawn, wake, adopt, control
// ---------------------------------------------------------------------------

/** A real on-disk dir under the scratch root (control() validates with statSync). */
function workDir(name) {
  const d = join(dir, name);
  mkdirSync(d, { recursive: true });
  return d;
}

test("B4: spawn({cwd}) runs pi in the chosen dir, makes it writable, and reports it in the snapshot", async () => {
  const { engine, state } = makeEngine();
  const chosen = workDir("b4-spawn-chosen");
  const r = await engine.spawn({ botId: "botty", cwd: chosen });
  await tick();
  assert.equal(state.worlds[0].cwd, chosen, "the chosen dir reaches buildBotWorld");
  const pi = state.instances[0];
  assert.equal(pi.opts.cwd, chosen, "pi's process cwd is the chosen dir");
  assert.ok(pi.opts.extraWritePaths.includes(chosen), "the chosen dir is added to write_paths (decision 2)");
  assert.ok(pi.opts.extraWritePaths.some((p) => p === join(dir, "bots", "botty", "outputs", r.sessionId)),
    "outputsDir stays writable alongside the chosen dir");
  assert.equal((await engine.get(r.sessionId)).cwd, chosen, "snapshot reports the chosen cwd");
});

test("B4: spawn() without cwd keeps the default world root — no write_paths widening", async () => {
  const { engine, state } = makeEngine();
  const r = await engine.spawn({ botId: "botty" });
  await tick();
  const pi = state.instances[0];
  const worldRoot = join(dir, "bots", "botty");
  assert.equal(pi.opts.cwd, worldRoot, "default cwd is the world root");
  assert.deepEqual(pi.opts.extraWritePaths, [join(worldRoot, "outputs", r.sessionId)],
    "a default session's write_paths is exactly [outputsDir] — byte-identical, no widening");
  assert.equal((await engine.get(r.sessionId)).cwd, worldRoot, "snapshot reports the effective (default) cwd");
});

test("B4: spawn({cwd}) survives a simulated restart — a fresh engine adopts the row and reports the same cwd", async () => {
  const { engine: engineA } = makeEngine();
  const chosen = workDir("b4-restart-chosen");
  const s = await engineA.spawn({ botId: "botty", cwd: chosen });
  await tick();
  await engineA.stopAll();

  const { engine: engineB } = makeEngine();
  const snap = await engineB.get(s.sessionId);
  assert.ok(snap, "the row is adopted");
  assert.equal(snap.cwd, chosen, "the chosen cwd is persisted on the row and restored on adopt");
});

test("B4: control({cwd}) while hibernating binds at the next wake — the fresh PiRpc runs in the new dir", async () => {
  const { engine, clock, state } = makeEngine();
  const s = await spawned(engine);
  clock.advance(600_001);
  await tick();
  assert.equal((await engine.get(s.sessionId)).state, "hibernating");

  const chosen = workDir("b4-control-hib");
  const r = await engine.control(s.sessionId, { cwd: chosen });
  assert.equal(r.bindsAtWake.cwd, chosen, "reported under bindsAtWake like permissionMode");
  assert.equal((await engine.get(s.sessionId)).cwd, chosen, "snapshot reflects the new cwd immediately");

  await engine.message(s.sessionId, "wake in the new dir");
  await tick();
  const wakePi = state.instances[1];
  assert.equal(wakePi.opts.cwd, chosen, "the wake's PiRpc runs in the chosen dir");
  assert.ok(wakePi.opts.extraWritePaths.includes(chosen), "and the chosen dir is writable after the wake");
  wakePi.lastTurn().resolve({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }] });
  await tick();
});

test("B4: control({cwd}) while awake hibernates the live child (no live chdir) and logs the change", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  assert.equal((await engine.get(s.sessionId)).state, "awake", "a healthy spawn is awake");
  const sub = await collect(engine, s.sessionId);
  const chosen = workDir("b4-control-awake");
  await engine.control(s.sessionId, { cwd: chosen });
  assert.equal((await engine.get(s.sessionId)).state, "hibernating", "pi's cwd is fixed at spawn, so the child hibernates");
  assert.equal(state.instances[0].closed, 1, "the live child was closed");
  assert.ok(sub.ofType("log").some((e) => /working directory/.test(e.text || "")),
    "a visible log frame states the directory change");
  sub.off();
});

test("B4: control({cwd}) is refused turn_in_progress while a turn is in flight", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  await engine.message(s.sessionId, "long one");
  const chosen = workDir("b4-midturn");
  await assert.rejects(() => engine.control(s.sessionId, { cwd: chosen }), (e) => e.code === "turn_in_progress");
  state.instances[0].lastTurn().resolve({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }] });
  await tick();
});

test("B4: control({cwd}) refuses a relative path, a nonexistent path, and a file — all bad_request", async () => {
  const { engine } = makeEngine();
  const s = await spawned(engine);
  await assert.rejects(() => engine.control(s.sessionId, { cwd: "relative/path" }), (e) => e.code === "bad_request", "relative refused");
  await assert.rejects(() => engine.control(s.sessionId, { cwd: join(dir, "does-not-exist") }), (e) => e.code === "bad_request", "nonexistent refused");
  const filePath = join(dir, "b4-a-file.txt");
  writeFileSync(filePath, "not a dir");
  await assert.rejects(() => engine.control(s.sessionId, { cwd: filePath }), (e) => e.code === "bad_request", "a file is not a directory");
});

// ---------------------------------------------------------------------------
// Wave 2/3 — the Session tab's facts on the engine's own shapes, the tool
// frame relay's args/result payloads, and the get_commands relay behind the
// composer's slash menu.
// ---------------------------------------------------------------------------

test("Wave 2: snapshot carries the facts; a hibernating child reports honest nulls", async () => {
  const { engine } = makeEngine();
  const s = await spawned(engine);
  const snap = await engine.get(s.sessionId);
  assert.equal(snap.toolCount, 3, "the pinned --tools csv, counted — envelope minus narrowing, as spawned");
  assert.ok(snap.uptimeSeconds >= 0, "awake since just now");
  assert.equal(snap.memoryMB, null,
    "a fake pid has no /proc entry — a fact that cannot be measured is null, never a guess");
  assert.equal(snap.contextUsage, null, "no turn has ended yet, so pi has no context number");

  await engine._hibernateForTest(s.sessionId);
  const after = await engine.get(s.sessionId);
  assert.equal(after.uptimeSeconds, null, "uptime belongs to the CHILD, not the session");
  assert.equal(after.toolCount, 3, "the envelope fact survives a hibernate — it is what the next wake pins");
});

test("Wave 2: contextUsage is captured at turn end from pi's own stats and rides the state frame", async () => {
  const { engine, bridge } = makeEngine();
  const Base = bridge.PiRpc;
  bridge.PiRpc = class StatsPi extends Base {
    async getSessionStats() {
      const r = await super.getSessionStats();
      r.data.contextUsage = { tokens: 110163, contextWindow: 262144, percent: 42 };
      return r;
    }
  };
  const s = await spawned(engine);
  const pi = bridge._state.instances[bridge._state.instances.length - 1];
  await engine.message(s.sessionId, "go");
  pi.lastTurn().resolve({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }] });
  await tick();
  const snap = await engine.get(s.sessionId);
  assert.deepEqual(snap.contextUsage, { tokens: 110163, contextWindow: 262144, percent: 42 },
    "captured at the only moment stats are already being fetched — metering — so the meter costs zero extra RPCs");
  const { events, off, ofType } = await collect(engine, s.sessionId);
  const states = ofType("state");
  assert.ok(states.length, "subscribe replays state");
  assert.deepEqual(states[states.length - 1].contextUsage, snap.contextUsage);
  off();
});

test("Wave 3: tool frames relay args and results, capped at the engine's truncation", async () => {
  const { engine, bridge } = makeEngine();
  const s = await spawned(engine);
  const pi = bridge._state.instances[bridge._state.instances.length - 1];
  const { events, off, ofType } = await collect(engine, s.sessionId);

  pi.emit({ type: "tool_execution_start", toolCallId: "tc-1", toolName: "bash", args: { command: "ls -la" } });
  const start = ofType("tool").filter((e) => e.phase === "start").pop();
  assert.equal(start.toolCallId, "tc-1");
  assert.ok(start.argsText.includes('"command":"ls -la"'), "the chip shows what the call CARRIED");

  const huge = "x".repeat(700);
  pi.emit({ type: "tool_execution_start", toolCallId: "tc-2", toolName: "write", args: huge });
  const start2 = ofType("tool").filter((e) => e.phase === "start").pop();
  assert.equal(start2.argsText.length, 601, "600 chars + the ellipsis — a write payload never balloons a frame");

  pi.emit({ type: "tool_execution_end", toolCallId: "tc-1", toolName: "bash",
    result: { content: [{ type: "text", text: "total 8" }, { type: "text", text: "drwx" }] }, isError: false });
  const end = ofType("tool").filter((e) => e.phase === "end").pop();
  assert.equal(end.resultText, "total 8\ndrwx", "text blocks joined — what an operator wants to read");
  assert.equal(end.isError, false);
  off();
});

test("Wave 3: commands() relays pi's get_commands registry; a hibernating child says so instead of faking empty", async () => {
  const { engine, state } = makeEngine();
  state.commandScript = (pi, payload) =>
    payload.type === "get_commands"
      ? { success: true, data: { commands: [
          { name: "plan", description: "plan mode", source: "extension" },
          { name: "", description: "junk row" },
          null ] } }
      : null;
  const s = await spawned(engine);
  const out = await engine.commands(s.sessionId);
  assert.deepEqual(out.commands, [{ name: "plan", description: "plan mode", source: "extension" }],
    "mapped to name/description/source, junk filtered, never passed through raw");
  assert.equal(out.hibernating, false);

  await engine._hibernateForTest(s.sessionId);
  const asleep = await engine.commands(s.sessionId);
  assert.deepEqual(asleep, { commands: [], hibernating: true },
    "waking a child because the operator typed '/' would be a lie of availability");
  await assert.rejects(() => engine.commands("perchlive-deadbeef"), /no_such_session/);
});
