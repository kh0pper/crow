/**
 * Perch Hub P2, Task C-13 — the interactive session engine.
 *
 * Harness shape (deliberate, read before editing):
 *
 *   • A REAL init-db'd scratch crow.db (CROW_DATA_DIR + CROW_HOME under a
 *     mkdtemp), because the engine's session-row writes are real SQL through
 *     the gateway's own createDbClient — the row contract (kind='perch-live',
 *     pi_session_dir, model, status) is half the behavior and a mocked DB
 *     would prove nothing about it.
 *   • An INJECTED bridge seam: a fake PiRpc class that records its constructor
 *     opts, hands the test a controllable promptTurn promise, and lets the test
 *     drive the child's event stream through the engine's own `onEvent`. No pi
 *     is ever spawned, no model is ever warmed.
 *   • INJECTED timers + clock (`setTimer`/`clearTimer`/`now`), so idle
 *     hibernation, the stall watchdog, the abort grace and the 60 s lease
 *     refresh are all driven deterministically instead of slept through.
 *
 * The one place the real modules ARE exercised is the precondition test (r1
 * S10) plus the two CARRIED-FINDINGS legs (escalate + project-native world),
 * which run the genuine bot-world.mjs against the scratch DB — they resolve
 * paths and export names, which no amount of seam injection can prove.
 *
 * run-suite.mjs forces CROW_DISABLE_PERCH=1 suite-wide; every engine here is
 * constructed with its own `env` object (the P1 idiom), so the suite-wide kill
 * switch neither disables these tests nor is bypassed for the real gateway.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const dir = mkdtempSync(join(tmpdir(), "perch-interactive-"));
process.env.CROW_DATA_DIR = dir;
process.env.CROW_HOME = join(dir, "home");
delete process.env.CROW_DB_PATH;
process.env.PI_MODELS_JSON = join(dir, "models.json");

const CROW_HOME = process.env.CROW_HOME;
const DB_FILE = join(dir, "crow.db");
const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const LEASE_PATH = join(CROW_HOME, "perch-interactive-leases.json");

let createInteractiveEngine, getInteractiveEngine, _resetInteractiveEngineForTest;

function raw() {
  return new Database(DB_FILE);
}

function rowFor(threadId) {
  const c = raw();
  const r = c.prepare("SELECT * FROM bot_sessions WHERE gateway_thread_id=? ORDER BY id DESC LIMIT 1").get(threadId);
  c.close();
  return r || null;
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
    clearTimer(id) {
      timers.delete(id);
    },
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
    pending: () => timers.size,
  };
}

/** Let queued microtasks + the engine's own async continuations settle. */
const tick = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

// ---------------------------------------------------------------------------
// fake bridge seam
// ---------------------------------------------------------------------------

let pidSeq = 900000;

function makeBridge(opts = {}) {
  const state = {
    worlds: [],            // every buildBotWorld({...}) argument
    preps: [],             // every prepareSpawn(world, opts) call
    warm: [],
    meter: [],
    audit: [],
    instances: [],         // every FakePi constructed
    narrowedTools: opts.narrowedTools == null ? null : opts.narrowedTools,
    piSessionIdInRow: opts.piSessionIdInRow == null ? null : opts.piSessionIdInRow,
    livePi: opts.livePi == null ? 0 : opts.livePi,
    maxPi: opts.maxPi == null ? 4 : opts.maxPi,
    projectId: opts.projectId === undefined ? 7 : opts.projectId,
    worldGate: null,       // set to a promise to hold buildBotWorld mid-flight
    prepGate: null,
    meterGate: null,       // set to a promise to hold meterTurn mid-flight (M-4)
    piScript: null,        // (pi, index) => {} — per-instance scripting (I-3)
    modelKey: opts.modelKey || "crow-local/qwen3.6-35b-a3b",
  };

  class FakePi {
    constructor(o) {
      this.opts = o;
      this.onEvent = o.onEvent;
      this.sent = [];
      this.closed = 0;
      this.trimmed = 0;
      this.aborts = 0;
      this.turns = [];
      this._exitCode = null;
      this.proc = { pid: ++pidSeq };
      this.piSessionId = "pisess-" + this.proc.pid;
      this.statsSeq = 0;
      this.closeGate = null;
      let done;
      this.exited = new Promise((r) => { done = r; });
      this._done = done;
      state.instances.push(this);
      if (state.piScript) state.piScript(this, state.instances.length - 1);
    }
    async getState() {
      return { data: { sessionId: this.piSessionId } };
    }
    async getSessionStats() {
      this.statsSeq += 1;
      return { data: { tokens: { input: 10 * this.statsSeq, output: 5 * this.statsSeq, cacheRead: 0 } } };
    }
    promptTurn(message, ms, images) {
      const rec = { message, ms, images };
      rec.promise = new Promise((resolve, reject) => { rec.resolve = resolve; rec.reject = reject; });
      this.turns.push(rec);
      return rec.promise;
    }
    trimLog() { this.trimmed += 1; }
    async abortSince() { this.aborts += 1; return null; }
    send(o) {
      if (this._exitCode != null) throw new Error("pi exited");
      this.sent.push(o);
    }
    async close() {
      this.closed += 1;
      if (this.closeGate) await this.closeGate;
      this.exit(0);
    }
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

  const seam = {
    _state: state,
    PiRpc: FakePi,
    LIFECYCLE_DEFAULTS: { get maxPi() { return state.maxPi; } },
    countLivePi: () => state.livePi,
    async buildBotWorld(args) {
      state.worlds.push(args);
      if (state.worldGate) await state.worldGate;
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
        narrowedTools: state.narrowedTools,
        gatewayType: args.gatewayType,
      };
    },
    async prepareSpawn(world, o) {
      state.preps.push({ world, opts: o });
      if (state.prepGate) await state.prepGate;
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
    async warmModel(provider) { state.warm.push(provider); },
    async meterTurn(args) {
      state.meter.push(args);
      if (state.meterGate) await state.meterGate;
      return { recorded: true };
    },
    appendAudit(projectId, o) { state.audit.push({ projectId, ...o }); },
  };
  return seam;
}

function makeEngine(o = {}) {
  const clock = makeClock();
  const bridge = o.bridge || makeBridge(o.bridgeOpts);
  // The env object is MUTABLE and read at call time (#217 class): a test can
  // retune a knob mid-session exactly as a systemd drop-in + restart would.
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

/** Collect every event the engine emits for a session. Async since fix round 1
 * (I-2): subscribe adopts unknown rows, so it awaits. */
async function collect(engine, sessionId) {
  const events = [];
  const off = await engine.subscribe(sessionId, (e) => events.push(e));
  return { events, off, ofType: (t) => events.filter((e) => e.type === t) };
}

/** spawn + let the post-spawn get_state continuation settle. */
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
  getInteractiveEngine = mod.getInteractiveEngine;
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
// 1. spawn
// ---------------------------------------------------------------------------

test("spawn: kill switch refuses with perch_disabled and spawns nothing", async () => {
  const { engine, state } = makeEngine({ env: { CROW_DISABLE_PERCH: "1" } });
  // Minor 5 (d): the old third assertion here was vacuous (list() derives every
  // non-stopped row as hibernating, so "no awake session" could never fail).
  // Assert something real instead: the refused spawn left NO session row.
  const countRows = () => {
    const c = raw();
    const n = c.prepare("SELECT COUNT(*) AS n FROM bot_sessions WHERE kind='perch-live'").get().n;
    c.close();
    return n;
  };
  const rowsBefore = countRows();
  await assert.rejects(() => engine.spawn({ botId: "botty" }), (e) => e.code === "perch_disabled");
  assert.equal(state.instances.length, 0);
  assert.equal(state.worlds.length, 0, "the gate fires before any world build");
  assert.equal(countRows(), rowsBefore, "a refused spawn writes no session row");
});

test("spawn: builds the world, warms, constructs PiRpc with the FULL piRpcOpts + PI_BOT_INTERACTIVE, and writes the perch-live row", async () => {
  const { engine, state } = makeEngine({ bridgeOpts: { narrowedTools: '["bash"]' } });
  const r = await spawned(engine, "botty");

  assert.equal(r.state, "awake");
  assert.match(r.threadId, /^perchlive-[0-9a-f]{8}$/);
  assert.equal(r.sessionId, r.threadId);

  // world → prepareSpawn → warm → PiRpc, in that order
  assert.equal(state.worlds.length, 1);
  assert.equal(state.worlds[0].botId, "botty");
  assert.equal(state.worlds[0].threadId, r.threadId);
  assert.equal(state.worlds[0].gatewayType, "perch");
  assert.equal(state.warm.length, 1);
  assert.equal(state.warm[0], "crow-local");

  assert.equal(state.instances.length, 1);
  const opts = state.instances[0].opts;
  // The full spawn-readiness bag, not a hand-rolled subset: the permission
  // policy the child gets is derived from def + selfAuthoringDir inside PiRpc,
  // so dropping any of these weakens the child's confinement.
  assert.equal(opts.sessionDir, join(dir, "bots", "botty"));
  assert.equal(opts.appendSystemPromptFile, join(dir, "sys.md"));
  assert.equal(opts.narrowedTools, '["bash"]');
  assert.equal(opts.remoteEnabled, false);
  assert.ok(opts.resolved && opts.resolved.key === "crow-local/qwen3.6-35b-a3b");
  assert.ok(opts.def);
  assert.equal(opts.piSessionId, null, "a fresh spawn resumes nothing");
  assert.deepEqual(opts.extraEnv, { PI_BOT_INTERACTIVE: "1" });
  assert.equal(typeof opts.onEvent, "function");

  const row = rowFor(r.threadId);
  assert.ok(row, "a bot_sessions row exists");
  assert.equal(row.kind, "perch-live");
  assert.equal(row.gateway_type, "perch");
  assert.equal(row.status, "active");
  assert.equal(row.bot_id, "botty");
  // r1 C6: without pi_session_dir the P1 transcript endpoint 404s forever.
  assert.equal(row.pi_session_dir, join(dir, "bots", "botty") + "/sessions");
  assert.equal(row.model, "crow-local/qwen3.6-35b-a3b");
  // get_state → pi_session_id persisted
  assert.equal(row.pi_session_id, state.instances[0].piSessionId);
});

test("spawn: interactive_capacity at PERCH_INTERACTIVE_MAX_AWAKE, no eligible victim — no second child", async () => {
  const { engine, state } = makeEngine({ env: { PERCH_INTERACTIVE_MAX_AWAKE: "1" } });
  const r = await spawned(engine, "botty");
  // Track 3 Task 7: an idle occupant at cap is now a safe-victim eviction
  // candidate (see the "safe-victim eviction" tests below) — put botty
  // mid-turn so it is INELIGIBLE, proving this is a genuine capacity refusal
  // and not just a race lost against eviction.
  await engine.message(r.sessionId, "stay busy");
  await assert.rejects(() => engine.spawn({ botId: "other" }), (e) => e.code === "interactive_capacity");
  assert.equal(state.instances.length, 1);
});

test("spawn: pi_capacity when countLivePi is at LIFECYCLE_DEFAULTS.maxPi — no child", async () => {
  const { engine, state } = makeEngine({ bridgeOpts: { livePi: 2, maxPi: 2 } });
  await assert.rejects(() => engine.spawn({ botId: "botty" }), (e) => e.code === "pi_capacity");
  assert.equal(state.instances.length, 0);
  assert.equal(state.worlds.length, 0, "the gate is BEFORE the world build");
});

test("CR3: two concurrent spawns at MAX_AWAKE=1 produce exactly one child and one 409", async () => {
  const { engine, state } = makeEngine({ env: { PERCH_INTERACTIVE_MAX_AWAKE: "1" } });
  // Hold both requests inside the world build so they are genuinely mid-flight
  // together: only a reservation taken synchronously with the capacity CHECK
  // can decide between them.
  let release;
  state.worldGate = new Promise((r) => { release = r; });
  const p1 = engine.spawn({ botId: "a" });
  const p2 = engine.spawn({ botId: "b" });
  // Attach the settle handlers in the SAME synchronous run the promises were
  // created in: the loser rejects before the first `await` below, and an
  // unobserved rejection is a node test failure of its own.
  const settled = Promise.allSettled([p1, p2]);
  await tick();
  release();
  const results = await settled;
  const ok = results.filter((r) => r.status === "fulfilled");
  const bad = results.filter((r) => r.status === "rejected");
  assert.equal(ok.length, 1, "exactly one spawn wins");
  assert.equal(bad.length, 1);
  assert.equal(bad[0].reason.code, "interactive_capacity");
  assert.equal(state.instances.length, 1, "exactly one child was constructed");
});

test("I-1: a child that dies during SPAWN's own trailing awaits never reports 'awake' — session ends hibernating with lastError, and the freed slot lets the next spawn succeed", async () => {
  const { engine, state } = makeEngine({ env: { PERCH_INTERACTIVE_MAX_AWAKE: "1" } });
  // The child dies WHILE startChild's own trailing `pi.getState()` call is in
  // flight — the D1 idiom (line ~432 above), mirrored for the SPAWN path
  // instead of a re-wake. D1 proves message()'s post-wake `refuseIfPiGone`
  // guard catches this for a re-wake because it keys off `s.pi`, not
  // `s.state`; spawn() has no equivalent guard and used to trust startChild's
  // tail directly. Because getState() resolves (rather than rejects),
  // startChild ran to completion and reached its own unconditional tail —
  // `s.state = "awake"; s.lastError = null;` — clobbering attachExit's
  // already-correct hibernating park into a lie: spawn() returned
  // {state:"awake"} for a session whose child was already dead, and the
  // permanently-"awake"-counted slot 409'd every later spawn with
  // interactive_capacity forever (reserveSlot() counts state==="awake").
  state.piScript = (pi, idx) => {
    if (idx !== 0) return;
    const realGetState = pi.getState.bind(pi);
    pi.getState = async () => {
      pi.exit(-1);
      return realGetState();
    };
  };
  const r = await spawned(engine, "wedgy");
  state.piScript = null;

  assert.equal(r.state, "hibernating", "spawn must never report awake for a session whose child already died");
  const snap = await engine.get(r.sessionId);
  assert.equal(snap.state, "hibernating");
  assert.ok(snap.lastError, "attachExit's honest error must survive, not be erased by startChild's tail");

  // The slot really is free: a second spawn succeeds immediately at
  // MAX_AWAKE=1, proving the dead session was never left permanently counted
  // as awake.
  const other = await spawned(engine, "other");
  assert.equal((await engine.get(other.sessionId)).state, "awake");
});

// ---------------------------------------------------------------------------
// 2. message / turn model
// ---------------------------------------------------------------------------

test("message: sends the RAW text through promptTurn with ms=0 and returns a turnId", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  const { turnId } = await engine.message(s.sessionId, "hello there");
  assert.ok(turnId);
  const pi = state.instances[0];
  assert.equal(pi.turns.length, 1);
  assert.equal(pi.turns[0].message, "hello there", "no channel template is wrapped around it");
  assert.equal(pi.turns[0].ms, 0, "no bridge turn budget — the engine's stall watchdog owns it");
});

test("message: a second message while a turn is in flight is refused with turn_in_progress", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  await engine.message(s.sessionId, "one");
  await assert.rejects(() => engine.message(s.sessionId, "two"), (e) => e.code === "turn_in_progress");
  assert.equal(state.instances[0].turns.length, 1);
});

test("D1: a child that dies during the WAKE's own trailing awaits is caught before promptTurn — and never wedges the session at 'awake' with no child (the worse D1 variant)", async () => {
  const { engine, clock, state } = makeEngine({ env: { PERCH_INTERACTIVE_MAX_AWAKE: "1" } });
  const s = await spawned(engine, "wedgy");
  clock.advance(600_001);
  await tick();
  assert.equal((await engine.get(s.sessionId)).state, "hibernating");

  const sink = await collect(engine, s.sessionId);
  state.piScript = (pi, idx) => {
    if (idx !== 1) return;
    // The child dies WHILE startChild's own trailing `pi.getState()` call is
    // in flight (I-3's technique, but exiting instead of throwing). Because
    // that call resolves (rather than rejects), startChild runs to
    // completion and reaches its OWN unconditional tail — `s.state =
    // "awake"; writeLeases();` — which clobbers attachExit's already-correct
    // "hibernating" back to "awake" with s.pi left null. This is the
    // acceptance report's "worse variant", observed once and not reduced to
    // a deterministic repro there; here it is deterministic. message()'s own
    // post-wake guard is the thing that must catch it: it keys off `s.pi`
    // liveness, not `s.state`, so it corrects the clobbered state instead of
    // trusting it.
    const realGetState = pi.getState.bind(pi);
    pi.getState = async () => {
      pi.exit(-1);
      return realGetState();
    };
  };
  await assert.rejects(
    () => engine.message(s.sessionId, "wake me"),
    (e) => e.code === "pi_gone",
    "a typed refusal, never the raw TypeError the null-deref used to leak"
  );
  state.piScript = null;

  assert.equal((await engine.get(s.sessionId)).state, "hibernating",
    "never wedged 'awake' with no child, even though startChild's tail unconditionally sets state=awake");
  assert.ok(sink.ofType("error").length >= 1, "an honest error event reaches the lens");

  // The awake slot really is free: a brand-new spawn works immediately,
  // proving PERCH_INTERACTIVE_MAX_AWAKE was never permanently pinned.
  const other = await spawned(engine, "other");
  assert.equal((await engine.get(other.sessionId)).state, "awake");
});

test("D1: a child that dies WHILE the pre-turn stats call is in flight is caught by the second guard, not promptTurn's null-deref", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  const pi = state.instances[0];
  const realGetSessionStats = pi.getSessionStats.bind(pi);
  // The kill lands mid-round-trip: by the time this call's promise settles,
  // attachExit has already nulled s.pi — exercising the SECOND guard site
  // (after getSessionStats, before promptTurn), not the first.
  pi.getSessionStats = async () => {
    pi.exit(-1);
    return realGetSessionStats();
  };
  await assert.rejects(
    () => engine.message(s.sessionId, "dies mid-stats"),
    (e) => e.code === "pi_gone"
  );
  assert.equal(pi.turns.length, 0, "promptTurn is never called on the now-dead child");
  assert.equal((await engine.get(s.sessionId)).state, "hibernating");
});

test("clean completion: meters + audits, emits reply, trims the log, and parks the row", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  const sink = await collect(engine, s.sessionId);
  await engine.message(s.sessionId, "do it");
  const pi = state.instances[0];
  pi.emit({ type: "tool_execution_start", toolName: "bash", toolCallId: "t1" });
  pi.emit({ type: "tool_execution_end", toolName: "bash", toolCallId: "t1", isError: false });
  pi.lastTurn().resolve({
    type: "agent_end",
    messages: [{ role: "assistant", content: [{ type: "text", text: "all done" }] }],
  });
  await tick();

  const replies = sink.ofType("reply");
  assert.equal(replies.length, 1);
  assert.equal(replies[0].text, "all done");
  assert.equal(pi.trimmed, 1, "the accumulating event log is trimmed after each turn");

  assert.equal(state.meter.length, 1, "CR6: every other bot turn meters; so does this one");
  assert.ok(state.meter[0].statsBefore, "before/after snapshots are id-correlated");
  assert.ok(state.meter[0].statsAfter);
  assert.equal(state.meter[0].resolved.key, "crow-local/qwen3.6-35b-a3b");
  assert.equal(state.audit.length, 1);
  assert.equal(state.audit[0].action, "bot.invoke");
  assert.equal(state.audit[0].actor_id, "botty");
  assert.deepEqual(state.audit[0].payload.tool_names, ["bash"]);
  assert.equal(state.audit[0].payload.model, "crow-local/qwen3.6-35b-a3b");
  // Minor 5 (b): the audit row points at the REAL bot_sessions row.
  assert.equal(state.audit[0].payload.session_id, rowFor(s.threadId).id);

  const row = rowFor(s.threadId);
  assert.equal(row.status, "waiting-user");
  assert.equal(row.model, "crow-local/qwen3.6-35b-a3b");
  assert.equal((await engine.get(s.sessionId)).state, "awake");
});

test("CR2: an aborted turn's late agent_end produces NO reply and is neither metered nor audited", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  const sink = await collect(engine, s.sessionId);
  await engine.message(s.sessionId, "long one");
  const pi = state.instances[0];

  await engine.abort(s.sessionId);
  assert.equal(pi.aborts, 1, "the RPC abort is sent");

  // Aborting a RUNNING turn is exactly what produces agent_end (agent-loop.js).
  pi.lastTurn().resolve({
    type: "agent_end",
    stopReason: "aborted",
    messages: [{ role: "assistant", content: [{ type: "text", text: "partial work" }] }],
  });
  await tick();

  assert.equal(sink.ofType("reply").length, 0, "no reply event may follow an abort on the same turn");
  assert.equal(state.meter.length, 0);
  assert.equal(state.audit.length, 0);
  assert.ok(sink.ofType("state").length >= 1);
  assert.equal((await engine.get(s.sessionId)).state, "awake", "the session stays awake after an abort");
});

test("CR1: a refused ack surfaces an SSE error, clears the in-flight turn, arms idle, and does NOT wedge or kill the session", async () => {
  const { engine, clock, state } = makeEngine();
  const s = await spawned(engine);
  const sink = await collect(engine, s.sessionId);
  await engine.message(s.sessionId, "bad model");
  const pi = state.instances[0];
  // M-3: the refusal is TYPED at bridge.mjs's throw site — the engine keys on
  // err.code, so the fake must carry it (the string alone no longer matches).
  const refusal = new Error("prompt refused: no such provider");
  refusal.code = "prompt_refused";
  pi.lastTurn().reject(refusal);
  await tick();

  const errs = sink.ofType("error");
  assert.equal(errs.length, 1);
  assert.match(errs[0].text, /prompt refused/);
  assert.equal(pi.closed, 0, "a preflight refusal leaves the child healthy — no agent loop ever started");
  assert.equal((await engine.get(s.sessionId)).state, "awake");
  // Minor 5 (a): an errored turn is neither metered nor audited.
  assert.equal(state.meter.length, 0, "a refused turn is not metered");
  assert.equal(state.audit.length, 0, "a refused turn is not audited");

  // Not wedged: a second message runs normally.
  const again = await engine.message(s.sessionId, "try again");
  assert.ok(again.turnId);
  assert.equal(pi.turns.length, 2);

  // And the idle timer really was armed by the failed turn (proven by
  // completing this turn and watching hibernation arrive on schedule).
  pi.lastTurn().resolve({ type: "agent_end", messages: [] });
  await tick();
  clock.advance(600_001);
  await tick();
  assert.equal((await engine.get(s.sessionId)).state, "hibernating");
});

test("CARRIED 3: an abandoned turn CLOSES the child — a late agent_end can never satisfy the next turn's wait", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  const sink = await collect(engine, s.sessionId);
  await engine.message(s.sessionId, "hi");
  const pi = state.instances[0];
  // An ack timeout: the prompt may well have been received and the agent loop
  // may still be live. pi's agent_end carries no id, so reusing this child
  // would let its late agent_end end the NEXT turn.
  pi.lastTurn().reject(new Error("timeout:prompt-ack (stderr )"));
  await tick();

  assert.equal(pi.closed, 1, "the child is closed, never reused");
  assert.equal((await engine.get(s.sessionId)).state, "hibernating");
  assert.ok(sink.ofType("error").length >= 1);
  // Minor 5 (a): an errored turn is neither metered nor audited.
  assert.equal(state.meter.length, 0, "an abandoned turn is not metered");
  assert.equal(state.audit.length, 0, "an abandoned turn is not audited");
});

test("CARRIED 3: an abort that never lands abandons the child after the grace window", async () => {
  const { engine, clock, state } = makeEngine();
  const s = await spawned(engine);
  await engine.message(s.sessionId, "hi");
  const pi = state.instances[0];
  await engine.abort(s.sessionId);
  assert.equal(pi.closed, 0, "still hoping for the agent_end an abort of a running turn produces");
  clock.advance(30_001);
  await tick();
  assert.equal(pi.closed, 1, "abort with no active run emits nothing — the child must not be reused");
  assert.equal((await engine.get(s.sessionId)).state, "hibernating");
});

// ---------------------------------------------------------------------------
// 3. onEvent forwarding (the curation contract)
// ---------------------------------------------------------------------------

test("onEvent forwarding: tools, assistant text, notify, and the ignored ui methods", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  const sink = await collect(engine, s.sessionId);
  await engine.message(s.sessionId, "go");
  const pi = state.instances[0];

  pi.emit({ type: "tool_execution_start", toolName: "read", toolCallId: "c1", args: {} });
  pi.emit({ type: "tool_execution_end", toolName: "read", toolCallId: "c1", isError: true, result: "boom" });
  pi.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "thinking out loud" }] } });
  pi.emit({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "not mine" }] } });
  pi.emit({ type: "extension_ui_request", id: "n1", method: "notify", message: "heads up" });
  pi.emit({ type: "extension_ui_request", id: "x1", method: "setStatus", statusKey: "k", statusText: "v" });
  pi.emit({ type: "extension_ui_request", id: "x2", method: "setWidget", widgetKey: "k", widgetLines: [] });
  pi.emit({ type: "extension_ui_request", id: "x3", method: "setTitle", title: "t" });
  pi.emit({ type: "extension_ui_request", id: "x4", method: "set_editor_text", text: "t" });

  const tools = sink.ofType("tool");
  assert.deepEqual(tools.map((e) => [e.name, e.phase, e.isError]), [["read", "start", false], ["read", "end", true]]);
  const texts = sink.ofType("text");
  assert.deepEqual(texts.map((e) => e.text), ["thinking out loud"]);
  const logs = sink.ofType("log");
  assert.deepEqual(logs.map((e) => e.text), ["heads up"]);
  assert.equal(sink.ofType("ask_user").length, 0, "setStatus/setWidget/setTitle/set_editor_text are ignored");
});

test("onEvent forwarding: every ask_user method carries its OWN fields (r1 S5)", async () => {
  const cases = [
    [{ type: "extension_ui_request", id: "a", method: "select", title: "Pick", options: ["[ ] one", "Other…"] },
      { requestId: "a", method: "select", title: "Pick", options: ["[ ] one", "Other…"] }],
    [{ type: "extension_ui_request", id: "b", method: "input", title: "Name?", placeholder: "type here" },
      { requestId: "b", method: "input", title: "Name?", placeholder: "type here" }],
    [{ type: "extension_ui_request", id: "c", method: "confirm", title: "Sure?", message: "This deletes prod." },
      { requestId: "c", method: "confirm", title: "Sure?", message: "This deletes prod." }],
    [{ type: "extension_ui_request", id: "d", method: "editor", title: "Edit", prefill: "draft text" },
      { requestId: "d", method: "editor", title: "Edit", prefill: "draft text" }],
  ];
  for (const [msg, expected] of cases) {
    const { engine, state } = makeEngine();
    const s = await spawned(engine);
    const sink = await collect(engine, s.sessionId);
    await engine.message(s.sessionId, "go");
    state.instances[0].emit(msg);
    const card = sink.ofType("ask_user")[0];
    assert.ok(card, msg.method + " produced a card");
    for (const [k, v] of Object.entries(expected)) assert.deepEqual(card[k], v, msg.method + "." + k);
    assert.deepEqual((await engine.get(s.sessionId)).pendingUi, { ...expected });
  }
});

// ---------------------------------------------------------------------------
// 4. answer
// ---------------------------------------------------------------------------

test("answer: value / confirmed / cancelled shapes, and pendingUi clears", async () => {
  const shapes = [
    ["select", { value: "one" }, { type: "extension_ui_response", id: "q", value: "one" }],
    ["input", { value: "typed" }, { type: "extension_ui_response", id: "q", value: "typed" }],
    ["confirm", { confirmed: true }, { type: "extension_ui_response", id: "q", confirmed: true }],
    ["confirm", { confirmed: false }, { type: "extension_ui_response", id: "q", confirmed: false }],
    ["select", { cancelled: true }, { type: "extension_ui_response", id: "q", cancelled: true }],
  ];
  for (const [method, answer, expected] of shapes) {
    const { engine, state } = makeEngine();
    const s = await spawned(engine);
    await engine.message(s.sessionId, "go");
    const pi = state.instances[0];
    pi.emit({ type: "extension_ui_request", id: "q", method, title: "T", options: ["one"], message: "m" });
    await engine.answer(s.sessionId, "q", answer);
    assert.deepEqual(pi.sent[pi.sent.length - 1], expected, method + " " + JSON.stringify(answer));
    assert.equal((await engine.get(s.sessionId)).pendingUi, null);
  }
});

test("answer: a stale/unknown requestId is refused with no_such_request", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  await engine.message(s.sessionId, "go");
  const pi = state.instances[0];
  pi.emit({ type: "extension_ui_request", id: "q", method: "input", title: "T" });
  await assert.rejects(() => engine.answer(s.sessionId, "not-q", { value: "x" }), (e) => e.code === "no_such_request");
  assert.equal(pi.sent.length, 0, "nothing is sent to the child on a mismatched id");
  // the real card still stands
  assert.equal((await engine.get(s.sessionId)).pendingUi.requestId, "q");
});

test("answer after the child EXITED is a no_such_request refusal, never a raw throw (r1 S4)", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  await engine.message(s.sessionId, "go");
  const pi = state.instances[0];
  pi.emit({ type: "extension_ui_request", id: "q", method: "input", title: "T" });
  pi.exit(1);
  await tick();
  await assert.rejects(() => engine.answer(s.sessionId, "q", { value: "x" }), (e) => e.code === "no_such_request");
});

// ---------------------------------------------------------------------------
// 5. hibernate
// ---------------------------------------------------------------------------

test("hibernate: the idle timer closes the child, parks the row, and flips the state", async () => {
  const { engine, clock, state } = makeEngine();
  const s = await spawned(engine);
  const sink = await collect(engine, s.sessionId);
  clock.advance(600_001);
  await tick();
  assert.equal(state.instances[0].closed, 1);
  assert.equal((await engine.get(s.sessionId)).state, "hibernating");
  assert.equal(rowFor(s.threadId).status, "waiting-user");
  assert.ok(sink.ofType("state").some((e) => e.state === "hibernating"));
});

test("hibernate: an UNANSWERED ask_user card blocks hibernation (mutation (a))", async () => {
  const { engine, clock, state } = makeEngine();
  const s = await spawned(engine);
  const pi = state.instances[0];
  // A card can arrive outside a turn (pi's extension host emits whenever it
  // likes); whatever the turn bookkeeping says, hibernating on an unanswered
  // question destroys both the question and the child waiting on it.
  pi.emit({ type: "extension_ui_request", id: "q", method: "confirm", title: "Sure?", message: "yes?" });
  clock.advance(600_001);
  await tick();
  assert.equal(pi.closed, 0, "an unanswered card must survive the idle window");
  assert.equal((await engine.get(s.sessionId)).state, "awake");

  // Answering releases it: the idle countdown resumes from the answer.
  await engine.answer(s.sessionId, "q", { confirmed: true });
  clock.advance(600_001);
  await tick();
  assert.equal(pi.closed, 1);
});

test("hibernate: an in-flight turn is not hibernated out from under itself", async () => {
  const { engine, clock, state } = makeEngine({ env: { PERCH_TURN_STALL_MS: "9000000" } });
  const s = await spawned(engine);
  await engine.message(s.sessionId, "long job");
  clock.advance(600_001);
  await tick();
  assert.equal(state.instances[0].closed, 0);
  assert.equal((await engine.get(s.sessionId)).state, "awake");
});

// ---------------------------------------------------------------------------
// 6. wake
// ---------------------------------------------------------------------------

test("wake: a message to a hibernating session rebuilds the world FRESH and resumes the pi session", async () => {
  const { engine, clock, state } = makeEngine();
  const s = await spawned(engine);
  const firstPi = state.instances[0];
  clock.advance(600_001);
  await tick();
  assert.equal((await engine.get(s.sessionId)).state, "hibernating");

  // The operator narrowed the session (or edited the envelope) while it slept.
  state.narrowedTools = '["bash","write"]';
  state.piSessionIdInRow = firstPi.piSessionId;

  await engine.message(s.sessionId, "back again");
  await tick();
  assert.equal(state.worlds.length, 2, "the world is rebuilt, not cached");
  assert.equal(state.instances.length, 2);
  const wakeOpts = state.instances[1].opts;
  assert.equal(wakeOpts.narrowedTools, '["bash","write"]', "the FRESH narrowing lands in the wake spawn");
  assert.equal(wakeOpts.piSessionId, firstPi.piSessionId, "the pi session is resumed, not restarted");
  assert.deepEqual(wakeOpts.extraEnv, { PI_BOT_INTERACTIVE: "1" });
  assert.equal((await engine.get(s.sessionId)).state, "awake");
  assert.equal(rowFor(s.threadId).status, "active");
  assert.equal(state.instances[1].turns[0].message, "back again");
});

test("C8: a wake past the interactive cap with no eligible victim is refused with the exact code and spawns no child", async () => {
  const { engine, clock, state } = makeEngine({ env: { PERCH_INTERACTIVE_MAX_AWAKE: "1" } });
  const a = await spawned(engine, "a");
  clock.advance(600_001);
  await tick();                                       // a hibernates
  const b = await spawned(engine, "b");               // b now owns the one slot
  assert.equal(state.instances.length, 2);
  // Track 3 Task 7: an idle b would now be an eviction candidate — keep it
  // mid-turn so this proves a genuine refusal, not a race lost to eviction.
  await engine.message(b.sessionId, "stay busy");
  await assert.rejects(() => engine.message(a.sessionId, "wake me"), (e) => e.code === "interactive_capacity");
  assert.equal(state.instances.length, 2, "no third child");
  assert.equal((await engine.get(a.sessionId)).state, "hibernating", "the failed reservation is released");
  assert.equal((await engine.get(b.sessionId)).state, "awake");
});

test("C8: a wake past the pi cap is refused with pi_capacity and spawns no child", async () => {
  const { engine, clock, state } = makeEngine();
  const s = await spawned(engine);
  clock.advance(600_001);
  await tick();
  state.livePi = 4;                                   // maxPi default in the fake seam is 4
  await assert.rejects(() => engine.message(s.sessionId, "wake me"), (e) => e.code === "pi_capacity");
  assert.equal(state.instances.length, 1);
  assert.equal((await engine.get(s.sessionId)).state, "hibernating");
});

test("CR3: two concurrent WAKES at MAX_AWAKE=1 produce exactly one child and one 409", async () => {
  const { engine, clock, env, state } = makeEngine({ env: { PERCH_INTERACTIVE_MAX_AWAKE: "2" } });
  const a = await spawned(engine, "a");
  const b = await spawned(engine, "b");
  clock.advance(600_001);
  await tick();                                       // both hibernate
  assert.equal((await engine.get(a.sessionId)).state, "hibernating");
  assert.equal((await engine.get(b.sessionId)).state, "hibernating");

  env.PERCH_INTERACTIVE_MAX_AWAKE = "1";              // read at call time
  let release;
  state.worldGate = new Promise((r) => { release = r; });
  const before = state.instances.length;
  const p1 = engine.message(a.sessionId, "one");
  const p2 = engine.message(b.sessionId, "two");
  const settled = Promise.allSettled([p1, p2]);     // observe both before any await
  await tick();
  release();
  const results = await settled;
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const bad = results.find((r) => r.status === "rejected");
  assert.equal(bad.reason.code, "interactive_capacity");
  assert.equal(state.instances.length, before + 1, "exactly one child woke");
});

// ---------------------------------------------------------------------------
// 7. stall watchdog
// ---------------------------------------------------------------------------

test("C3 watchdog: fires on silence — aborts the turn and reports it", async () => {
  const { engine, clock, state } = makeEngine({ env: { PERCH_TURN_STALL_MS: "60000" } });
  const s = await spawned(engine);
  const sink = await collect(engine, s.sessionId);
  await engine.message(s.sessionId, "silent job");
  const pi = state.instances[0];
  clock.advance(60_001);
  await tick();
  assert.equal(pi.aborts, 1);
  assert.ok(sink.ofType("error").some((e) => /stall/i.test(e.text)));
  // and the abort flag holds: the agent_end the abort produces is silent
  pi.lastTurn().resolve({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "half" }] }] });
  await tick();
  assert.equal(sink.ofType("reply").length, 0);
});

test("C3 watchdog: resets on every child event", async () => {
  const { engine, clock, state } = makeEngine({ env: { PERCH_TURN_STALL_MS: "60000" } });
  const s = await spawned(engine);
  await engine.message(s.sessionId, "chatty job");
  const pi = state.instances[0];
  for (let i = 0; i < 5; i++) {
    clock.advance(50_000);
    pi.emit({ type: "tool_execution_start", toolName: "bash", toolCallId: "c" + i });
    await tick();
  }
  assert.equal(pi.aborts, 0, "250 s of steady tool traffic is not a stall");
  clock.advance(60_001);
  await tick();
  assert.equal(pi.aborts, 1, "…but silence after the last event is");
});

test("C3 watchdog: PAUSED across a long pendingUi wait (mutation (e))", async () => {
  const { engine, clock, state } = makeEngine({ env: { PERCH_TURN_STALL_MS: "60000" } });
  const s = await spawned(engine);
  await engine.message(s.sessionId, "asky job");
  const pi = state.instances[0];
  pi.emit({ type: "extension_ui_request", id: "q", method: "select", title: "Which?", options: ["a", "b"] });
  clock.advance(600_000);                             // ten stall windows of human thinking time
  await tick();
  assert.equal(pi.aborts, 0, "a session waiting on a human is not stalled");
  await engine.answer(s.sessionId, "q", { value: "a" });
  clock.advance(60_001);
  await tick();
  assert.equal(pi.aborts, 1, "…and the watchdog resumes once the answer is in");
});

// ---------------------------------------------------------------------------
// 8. stop / stopAll
// ---------------------------------------------------------------------------

test("stop: closes the child, marks the row stopped, clears the card, and is not wakeable", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  const pi = state.instances[0];
  await engine.message(s.sessionId, "go");
  pi.emit({ type: "extension_ui_request", id: "q", method: "input", title: "T" });
  await engine.stop(s.sessionId);
  assert.equal(pi.closed, 1);
  assert.equal((await engine.get(s.sessionId)).state, "stopped");
  assert.equal((await engine.get(s.sessionId)).pendingUi, null);
  assert.equal(rowFor(s.threadId).status, "stopped");
  await assert.rejects(() => engine.message(s.sessionId, "hi again"), (e) => e.code === "session_stopped");
});

test("stopAll: bounded — a child that will not close cannot hold shutdown open", async () => {
  const { engine, state } = makeEngine({ env: { PERCH_INTERACTIVE_MAX_AWAKE: "2" } });
  const a = await spawned(engine, "a");
  const b = await spawned(engine, "b");
  state.instances[0].closeGate = new Promise(() => {});   // never resolves
  const t0 = Date.now();
  const r = await engine.stopAll({ timeoutMs: 60 });
  assert.ok(Date.now() - t0 < 5000, "stopAll returned inside its budget");
  assert.equal(r.stopped, 2, "both children were asked to die");
  assert.equal(state.instances[1].closed, 1);
  // Rows persist AND are parked (I-1) — hibernation semantics, not deletion,
  // and never a fresh 'active' claim that would 409 the next boot's wake.
  // The HUNG child's row is parked too: the write lands before the close.
  assert.equal(rowFor(a.threadId).status, "waiting-user");
  assert.equal(rowFor(b.threadId).status, "waiting-user");
});

// ---------------------------------------------------------------------------
// 9. lease file
// ---------------------------------------------------------------------------

test("lease file: written on spawn, refreshed every 60 s, emptied on the last close", async () => {
  const { engine, clock, state } = makeEngine();
  const s = await spawned(engine);
  const pi = state.instances[0];

  const first = JSON.parse(readFileSync(LEASE_PATH, "utf8"));
  assert.equal(first.version, 1);
  const key = String(pi.proc.pid);
  assert.ok(first.leases[key], "the awake child's pid holds a lease");
  assert.equal(first.leases[key].sessionId, s.sessionId);
  assert.equal(first.leases[key].expiresAt, clock.now() + 180_000);

  const t0 = clock.now();
  clock.advance(60_000);
  await tick();
  const refreshed = JSON.parse(readFileSync(LEASE_PATH, "utf8"));
  assert.equal(refreshed.leases[key].expiresAt, t0 + 60_000 + 180_000, "the lease is refreshed, not left to expire");

  await engine.stop(s.sessionId);
  const empty = JSON.parse(readFileSync(LEASE_PATH, "utf8"));
  assert.deepEqual(empty.leases, {}, "the last close leaves an EMPTY lease set, not a stale pid");
});

// ---------------------------------------------------------------------------
// 10. child crash
// ---------------------------------------------------------------------------

test("crash: an unexpected child exit hibernates the session with lastError, clears the card, and re-wakes on the next message", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  const sink = await collect(engine, s.sessionId);
  const pi = state.instances[0];
  pi.emit({ type: "extension_ui_request", id: "q", method: "input", title: "T" });
  pi.exit(3);
  await tick();

  const snap = (await engine.get(s.sessionId));
  assert.equal(snap.state, "hibernating");
  assert.match(String(snap.lastError), /exited/);
  assert.equal(snap.pendingUi, null);
  assert.ok(sink.ofType("error").length >= 1);
  assert.ok(sink.ofType("state").some((e) => e.state === "hibernating"));

  await engine.message(s.sessionId, "you back?");
  await tick();
  assert.equal(state.instances.length, 2, "a next message attempts a normal wake");
  assert.equal((await engine.get(s.sessionId)).state, "awake");
});

// ---------------------------------------------------------------------------
// 11. subscribe / get / list
// ---------------------------------------------------------------------------

test("subscribe: a late subscriber is replayed the state AND the pending card; unsubscribe stops delivery", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  await engine.message(s.sessionId, "go");
  state.instances[0].emit({ type: "extension_ui_request", id: "q", method: "select", title: "Which?", options: ["a"] });

  const late = [];
  const off = await engine.subscribe(s.sessionId, (e) => late.push(e));
  assert.equal(late[0].type, "state");
  assert.equal(late[0].state, "awake");
  assert.equal(late[1].type, "ask_user");
  assert.equal(late[1].requestId, "q");

  off();
  state.instances[0].emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "later" }] } });
  assert.equal(late.filter((e) => e.type === "text").length, 0, "unsubscribe really detaches");
});

test("subscribe: after an abort the replay carries NO card, and after hibernation neither card nor child", async () => {
  const { engine, clock, state } = makeEngine();
  const s = await spawned(engine);
  await engine.message(s.sessionId, "go");
  state.instances[0].emit({ type: "extension_ui_request", id: "q", method: "input", title: "T" });
  await engine.abort(s.sessionId);
  const afterAbort = [];
  (await engine.subscribe(s.sessionId, (e) => afterAbort.push(e)))();
  assert.deepEqual(afterAbort.map((e) => e.type), ["state"]);

  state.instances[0].turns[0].resolve({ type: "agent_end", messages: [] });
  await tick();
  clock.advance(600_001);
  await tick();
  const afterHib = [];
  (await engine.subscribe(s.sessionId, (e) => afterHib.push(e)))();
  assert.deepEqual(afterHib.map((e) => e.type), ["state"]);
  assert.equal(afterHib[0].state, "hibernating");
});

test("list: live sessions this process holds, plus hibernating perch-live rows it does not", async () => {
  const { engine } = makeEngine();
  const s = await spawned(engine, "listy");
  // A row left behind by a previous gateway process.
  const c = raw();
  c.prepare(
    "INSERT INTO bot_sessions (bot_id,gateway_type,gateway_thread_id,kind,status,control) VALUES (?,?,?,?,?,?)"
  ).run("ghosty", "perch", "perchlive-deadbeef", "perch-live", "waiting-user", "run");
  c.close();

  const all = await engine.list();
  const mine = all.find((x) => x.sessionId === s.sessionId);
  const ghost = all.find((x) => x.sessionId === "perchlive-deadbeef");
  assert.ok(mine && mine.state === "awake");
  assert.ok(ghost && ghost.state === "hibernating", "a row from a previous process is derivable as hibernating");
  assert.equal(ghost.botId, "ghosty");
});

test("get: unknown session is null, not a throw", async () => {
  const { engine } = makeEngine();
  assert.equal((await engine.get("nope")), null);
  await assert.rejects(() => engine.message("nope", "hi"), (e) => e.code === "no_such_session");
});

// ---------------------------------------------------------------------------
// 12. singleton + default-seam precondition
// ---------------------------------------------------------------------------

test("getInteractiveEngine is the ONE process singleton; createIfMissing:false never mints one", async () => {
  _resetInteractiveEngineForTest();
  assert.equal(getInteractiveEngine({ createIfMissing: false }), null);
  const a = getInteractiveEngine();
  const b = getInteractiveEngine();
  assert.equal(a, b);
  assert.equal(getInteractiveEngine({ createIfMissing: false }), a);
  _resetInteractiveEngineForTest();
  assert.equal(getInteractiveEngine({ createIfMissing: false }), null);
});

test("precondition (r1 S10): with DEFAULT seams every lazily-resolved bridge function actually resolves", async () => {
  const engine = createInteractiveEngine({ env: { CROW_HOME } , crowHome: CROW_HOME });
  const seams = await engine._loadSeams();
  for (const name of ["buildBotWorld", "prepareSpawn", "PiRpc", "warmModel", "countLivePi", "meterTurn", "appendAudit"]) {
    assert.equal(typeof seams[name], "function", name + " resolved from the real modules");
  }
  assert.equal(typeof seams.LIFECYCLE_DEFAULTS.maxPi, "number");

  // The export names this engine (and C-11) depend on, asserted at the source.
  const B = await import("../scripts/pi-bots/bridge.mjs");
  for (const name of ["PiRpc", "getSession", "upsertSession", "appendAuditBridge", "db", "toolAllowlist"]) {
    assert.equal(typeof B[name], "function", "bridge.mjs exports " + name);
  }
  assert.equal(typeof B.CROW_DB, "string");
});

// ---------------------------------------------------------------------------
// 13. CARRIED FINDINGS 1 + 2 — the real bot-world legs
// ---------------------------------------------------------------------------

test("CARRIED 1: prepareSpawn(world, {escalate:true}) resolves the bot's ESCALATION model", async () => {
  const { buildBotWorld, prepareSpawn } = await import("../scripts/pi-bots/bot-world.mjs");
  const botId = "escalator";
  const c = raw();
  c.prepare("INSERT OR REPLACE INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES (?,?,?,?)")
    .run(botId, "Escalator", JSON.stringify({
      session_dir: join(dir, "bots", botId),
      system_prompt: "You are a test bot.",
      models: { default: "crow-local/qwen3.6-35b-a3b", escalation: "crow-chat/big-model" },
      tools: { pi_builtin: ["read"] },
    }), 1);
  c.close();

  const world = await buildBotWorld({ botId, threadId: "perchlive-esc", gatewayType: "perch" });
  const plain = await prepareSpawn(world, { escalate: false });
  assert.equal(plain.resolved.key, "crow-local/qwen3.6-35b-a3b");
  assert.equal(plain.resolved.escalated, false);

  const hot = await prepareSpawn(world, { escalate: true });
  assert.equal(hot.resolved.key, "crow-chat/big-model", "the escalate plumb reaches resolveModel");
  assert.equal(hot.resolved.escalated, true);
  assert.equal(hot.resolved.source, "escalation");
  assert.equal(hot.piRpcOpts.resolved.key, "crow-chat/big-model", "…and lands in the spawn bag");
});

test("CARRIED 2: a project-native bot's world roots the session dir in the project workspace", async () => {
  const { buildBotWorld } = await import("../scripts/pi-bots/bot-world.mjs");
  const botId = "projecty";
  const workspace = join(dir, "spaces", "alpha");
  const c = raw();
  const info = c.prepare(
    "INSERT INTO project_spaces (slug, name, workspace_dir, storage_prefix) VALUES (?,?,?,?)"
  ).run("alpha", "Alpha", workspace, "alpha/");
  c.prepare("INSERT OR REPLACE INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES (?,?,?,?,?)")
    .run(botId, "Projecty", JSON.stringify({
      session_dir: join(dir, "bots", botId),        // the LEGACY path, deliberately different
      system_prompt: "You are a project bot.",
      models: { default: "crow-local/qwen3.6-35b-a3b" },
      tools: { pi_builtin: ["read"] },
    }), 1, Number(info.lastInsertRowid));
  c.close();

  const world = await buildBotWorld({ botId, threadId: "perchlive-proj", gatewayType: "perch" });
  assert.equal(world.sessionDir, workspace + "/bots/" + botId, "project workspace wins over def.session_dir");
  assert.ok(existsSync(world.sessionDir + "/sessions"), "the sessions dir is created where pi will actually run");
  assert.equal(world.projectId, Number(info.lastInsertRowid));
});

// ---------------------------------------------------------------------------
// 14. fix round 1 — restart survivability, slot-leak, turn-window
//     (review findings I-1 / I-2 / I-3 / M-4)
// ---------------------------------------------------------------------------

test("I-1 restart: stopAll parks every row so a NEW process on the same DB can wake the session", async () => {
  const A = makeEngine();
  const s = await spawned(A.engine, "restarty");
  assert.equal(rowFor(s.threadId).status, "active", "precondition: the row is claimed while awake");

  const r = await A.engine.stopAll({ timeoutMs: 500 });
  assert.equal(r.stopped, 1);
  assert.equal(rowFor(s.threadId).status, "waiting-user",
    "stopAll PARKS the row — a fresh 'active' would read as a live claim and 409 the next boot for a full turn budget");

  // The restart: a fresh engine (fresh bridge seam, empty sessions map), same DB.
  const B = makeEngine();
  const wake = await B.engine.message(s.sessionId, "hello again");
  assert.ok(wake.turnId, "the wake succeeds instead of throwing turn_in_progress");
  await tick();
  assert.equal(B.state.instances.length, 1);
  assert.equal(B.state.instances[0].opts.piSessionId, A.state.instances[0].piSessionId,
    "the adopted row's pi session is resumed, not restarted");
  assert.equal((await B.engine.get(s.sessionId)).state, "awake");
});

test("I-2 restart: get / subscribe / stop adopt a row this process never held", async () => {
  const A = makeEngine();
  const s = await spawned(A.engine, "adopty");
  await A.engine.stopAll({ timeoutMs: 500 });

  const B = makeEngine();
  const snap = await B.engine.get(s.sessionId);
  assert.ok(snap, "get() adopts instead of returning null");
  assert.equal(snap.state, "hibernating");
  assert.equal(snap.botId, "adopty");

  const C = makeEngine();
  const events = [];
  const off = await C.engine.subscribe(s.sessionId, (e) => events.push(e));
  assert.equal(events[0].type, "state");
  assert.equal(events[0].state, "hibernating", "the replayed state is derived from the adopted row");
  off();

  const D = makeEngine();
  await D.engine.stop(s.sessionId);
  assert.equal(rowFor(s.threadId).status, "stopped", "a ghost session CAN be stopped after a restart");
  assert.equal((await D.engine.get(s.sessionId)).state, "stopped");
});

test("I-2 restart: abort/answer on an un-adopted hibernating session return their honest no-op errors", async () => {
  const A = makeEngine();
  const s = await spawned(A.engine, "honesty");
  await A.engine.stopAll({ timeoutMs: 500 });

  const B = makeEngine();
  await assert.rejects(() => B.engine.abort(s.sessionId), (e) => e.code === "no_turn",
    "no pending turn — the honest refusal, never no_such_session");
  const C = makeEngine();
  await assert.rejects(() => C.engine.answer(s.sessionId, "q1", { value: "x" }), (e) => e.code === "no_such_request",
    "no pending request — the honest refusal, never no_such_session");
  // A session that exists NOWHERE (no memory, no row) is still no_such_session.
  await assert.rejects(() => B.engine.stop("perchlive-nowhere"), (e) => e.code === "no_such_session");
  await assert.rejects(() => B.engine.subscribe("perchlive-nowhere", () => {}), (e) => e.code === "no_such_session");
});

test("I-3: a wake failure after the child was constructed releases the slot even when its close HANGS", async () => {
  const { engine, clock, state } = makeEngine({ env: { PERCH_INTERACTIVE_MAX_AWAKE: "1" } });
  const s = await spawned(engine, "leaky");
  clock.advance(600_001);
  await tick();
  assert.equal((await engine.get(s.sessionId)).state, "hibernating");

  let releaseClose;
  state.piScript = (pi, idx) => {
    if (idx === 1) {
      // Fail AFTER `s.pi` was set: a synchronous getState throw dodges the
      // engine's `.catch(() => null)` (which never gets attached), exactly the
      // "wake failure after the child exists" class. The close hangs until the
      // test releases it.
      pi.getState = () => { throw new Error("get_state boom"); };
      pi.closeGate = new Promise((r) => { releaseClose = r; });
    }
  };
  // Hang-proof by construction: under the pre-fix code this await NEVER
  // settles (the catch awaited the hanging close), so race a real timer and
  // fail loudly instead of wedging the file.
  const outcome = await Promise.race([
    engine.message(s.sessionId, "wake").then(() => "resolved", (e) => e),
    new Promise((r) => setTimeout(() => r("hung"), 2000)),
  ]);
  assert.ok(outcome instanceof Error, "the wake failure must reject promptly (got: " + String(outcome) + ")");
  assert.match(outcome.message, /get_state boom/);
  state.piScript = null;

  assert.equal((await engine.get(s.sessionId)).state, "hibernating",
    "the reservation is released unconditionally — never counted-awake while closing");
  await tick();
  assert.equal(rowFor(s.threadId).status, "waiting-user", "our own dead 'active' claim is parked");

  // The slot is free RIGHT NOW — the hung close must not hold it.
  const other = await spawned(engine, "other");
  assert.equal((await engine.get(other.sessionId)).state, "awake",
    "the next spawn succeeds — no permanent interactive_capacity leak");

  // When the hung close finally lands, the teardown is SILENT: the child was
  // detached before closing, so attachExit treats the exit as expected.
  const sink = await collect(engine, s.sessionId);
  releaseClose();
  await tick();
  assert.equal(sink.events.filter((e) => e.type === "error" && /exited/.test(String(e.text))).length, 0,
    "no spurious 'pi exited unexpectedly' on an expected teardown");
});

test("M-4: the turn stays claimed until reply + trimLog — a fast second message cannot interleave with turn 1's tail", async () => {
  const { engine, state } = makeEngine();
  let release;
  state.meterGate = new Promise((r) => { release = r; });
  const s = await spawned(engine);
  const sink = await collect(engine, s.sessionId);
  await engine.message(s.sessionId, "one");
  const pi = state.instances[0];
  pi.lastTurn().resolve({
    type: "agent_end",
    messages: [{ role: "assistant", content: [{ type: "text", text: "first done" }] }],
  });
  await tick();                                       // completion is now parked inside meterTurn
  assert.equal(state.meter.length, 1, "precondition: the completion path reached metering");
  assert.equal(pi.trimmed, 0, "trimLog has not run — the turn is still finishing");

  // THE window M-4 is about: a second message lands while turn 1's completion
  // is mid-await. It must be refused, never interleaved (turn 1's reply would
  // otherwise land after turn 2 started, and trimLog would run mid-turn).
  await assert.rejects(() => engine.message(s.sessionId, "two"), (e) => e.code === "turn_in_progress");
  assert.equal(sink.ofType("reply").length, 0, "turn 1's reply has not been emitted yet");

  release();
  await tick();
  assert.equal(sink.ofType("reply").length, 1);
  assert.equal(sink.ofType("reply")[0].text, "first done");
  assert.equal(pi.trimmed, 1, "trimLog ran with NO other turn in flight (the C-12 caller guarantee)");

  const r2 = await engine.message(s.sessionId, "two");
  assert.ok(r2.turnId, "…and the second message succeeds once turn 1 is fully done");
  assert.equal(pi.turns.length, 2);
});

// ---------------------------------------------------------------------------
// 12. fix round 2 — adoption is single-flight (concurrent first-touch)
// ---------------------------------------------------------------------------

test("R2: two concurrent message() at one not-yet-resident row share ONE adoption — one child, one turn_in_progress", async () => {
  const A = makeEngine();
  const s = await spawned(A.engine, "racey");
  await A.engine.stopAll({ timeoutMs: 500 });

  // The restart: fresh engine, empty sessions map, same DB. BOTH messages land
  // before either adoption completes — round 1's adopt() did an async row read
  // then an unconditional sessions.set, so each call built its own session
  // object and BOTH spawned children (the one-in-flight guard never saw the
  // other's turn).
  const B = makeEngine();
  const results = await Promise.allSettled([
    B.engine.message(s.sessionId, "one"),
    B.engine.message(s.sessionId, "two"),
  ]);
  await tick();

  assert.equal(B.state.instances.length, 1,
    "exactly ONE child — concurrent first-touches must resolve the SAME session object");
  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  assert.equal(fulfilled.length, 1, "one caller wins the turn");
  assert.ok(fulfilled[0].value.turnId);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, "turn_in_progress",
    "the loser is refused by the one-in-flight guard, not given a second child");
  assert.equal(B.state.worlds.length, 1, "one adoption, one wake, one world build");
});

test("R2: two concurrent subscribe() at one not-yet-resident row attach to the SAME session — neither is orphaned", async () => {
  const A = makeEngine();
  const s = await spawned(A.engine, "subracey");
  await A.engine.stopAll({ timeoutMs: 500 });

  const B = makeEngine();
  const eventsA = [];
  const eventsB = [];
  await Promise.all([
    B.engine.subscribe(s.sessionId, (e) => eventsA.push(e)),
    B.engine.subscribe(s.sessionId, (e) => eventsB.push(e)),
  ]);
  assert.equal(eventsA[0].state, "hibernating");
  assert.equal(eventsB[0].state, "hibernating");

  // A subsequent state change must reach BOTH. Under round 1's racy adopt the
  // second sessions.set orphaned the first subscriber's session object: it got
  // its attach replay and then silence, forever.
  await B.engine.stop(s.sessionId);
  await tick();
  assert.ok(eventsA.some((e) => e.type === "state" && e.state === "stopped"),
    "subscriber A observes the stop");
  assert.ok(eventsB.some((e) => e.type === "state" && e.state === "stopped"),
    "subscriber B observes the stop — no split-brain session objects");
});

test("R2 rode-along: a spawn failure AFTER the row was stamped parks it; a failure BEFORE writes nothing", async () => {
  const { engine, state } = makeEngine();
  // Fail after startChild's writeRow(active): a synchronous getState throw
  // dodges the `.catch(() => null)` (never attached), same class as I-3.
  state.piScript = (pi) => { pi.getState = () => { throw new Error("get_state boom"); }; };
  await assert.rejects(() => engine.spawn({ botId: "ghosty" }), /get_state boom/);
  state.piScript = null;
  await tick();
  const c = raw();
  const row = c.prepare("SELECT status FROM bot_sessions WHERE bot_id='ghosty' ORDER BY id DESC LIMIT 1").get();
  const ghost2 = c.prepare("SELECT COUNT(*) AS n FROM bot_sessions WHERE bot_id='ghosty2'").get();
  c.close();
  assert.ok(row, "precondition: startChild stamped the row before the failure");
  assert.equal(row.status, "waiting-user",
    "the catch parks the stamped row — an orphaned 'active' would read as hibernating forever in list() and 409 wakes");

  // Fail BEFORE the row stamp: the park must not MINT a row (writeRow's insert
  // branch would) — gated on s.rowId, which only the stamp sets.
  const boom = Promise.reject(new Error("world boom"));
  boom.catch(() => { /* pre-handled; buildBotWorld's await still throws */ });
  state.worldGate = boom;
  await assert.rejects(() => engine.spawn({ botId: "ghosty2" }), /world boom/);
  state.worldGate = null;
  await tick();
  assert.equal(ghost2.n, 0, "sanity of the probe itself");
  const c2 = raw();
  const n = c2.prepare("SELECT COUNT(*) AS n FROM bot_sessions WHERE bot_id='ghosty2'").get().n;
  c2.close();
  assert.equal(n, 0, "a pre-stamp failure writes NO row — no minted ghost");
});
