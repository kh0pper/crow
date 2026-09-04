/**
 * Perch Hub P2, Track 3 Task 7 — cycle(), capacity safe-victim eviction, and
 * the stopAll interruption marker.
 *
 * A SEPARATE harness from tests/perch-interactive.test.js (same idiom as the
 * controls/dispatch/statebridge task files: extend the pattern here rather
 * than bloating the existing file). Same shape — real scratch-DB'd crow.db,
 * an injected fake PiRpc/bridge seam, injected clock/timers.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const dir = mkdtempSync(join(tmpdir(), "perch-interactive-capacity-"));
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

function rowFor(threadId) {
  const c = raw();
  const r = c.prepare("SELECT * FROM bot_sessions WHERE gateway_thread_id=? ORDER BY id DESC LIMIT 1").get(threadId);
  c.close();
  return r || null;
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
    pending: () => timers.size,
  };
}

const tick = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

// ---------------------------------------------------------------------------
// fake bridge seam (identical idiom to tests/perch-interactive.test.js, no
// commandSince — this task never exercises control())
// ---------------------------------------------------------------------------

let pidSeq = 800000;

function makeBridge(opts = {}) {
  const state = {
    worlds: [],
    preps: [],
    warm: [],
    meter: [],
    audit: [],
    instances: [],
    narrowedTools: opts.narrowedTools == null ? null : opts.narrowedTools,
    livePi: opts.livePi == null ? 0 : opts.livePi,
    maxPi: opts.maxPi == null ? 8 : opts.maxPi,
    projectId: opts.projectId === undefined ? 7 : opts.projectId,
    worldGate: null,
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
        session: null,
        narrowedTools: state.narrowedTools,
        gatewayType: args.gatewayType,
      };
    },
    async prepareSpawn(world, o) {
      state.preps.push({ world, opts: o });
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
    async meterTurn(args) { state.meter.push(args); return { recorded: true }; },
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
  try { rmSync(LEASE_PATH, { force: true }); } catch { /* not there */ }
});

after(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});

// ---------------------------------------------------------------------------
// 1. cycle()
// ---------------------------------------------------------------------------

test("cycle: closes and respawns the child on an idle awake session — narrowing/mode are re-read", async () => {
  const { engine, state } = makeEngine({ bridgeOpts: { narrowedTools: '["bash"]' } });
  const s = await spawned(engine, "botty");
  const firstPi = state.instances[0];
  assert.equal(state.instances.length, 1);

  const r = await engine.cycle(s.sessionId);

  assert.equal(r.state, "awake");
  assert.equal(firstPi.closed, 1, "the OLD child was closed");
  assert.equal(state.instances.length, 2, "a FRESH child was constructed — two FakePi total");
  assert.equal(state.worlds.length, 2, "the world is rebuilt fresh, not replayed");
  const secondOpts = state.instances[1].opts;
  assert.equal(secondOpts.narrowedTools, '["bash"]', "narrowing is re-read on the cycle spawn");
  assert.notEqual(state.instances[1], firstPi, "the session now holds the NEW child, not the old one");
  assert.equal((await engine.get(s.sessionId)).state, "awake");
});

test("cycle: refused with cycle_busy while a turn is in flight", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  await engine.message(s.sessionId, "go");
  await assert.rejects(() => engine.cycle(s.sessionId), (e) => e.code === "cycle_busy");
  assert.equal(state.instances.length, 1, "no respawn attempted");
  assert.equal(state.instances[0].closed, 0, "the live child was never touched");
});

test("cycle: refused with cycle_busy while a card is pending", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  await engine.message(s.sessionId, "ask");
  const pi = state.instances[0];
  pi.emit({ type: "extension_ui_request", id: "q", method: "input", title: "T" });
  const before = await engine.get(s.sessionId);
  assert.ok(before.pendingUi, "test setup sanity: a card is pending");

  await assert.rejects(() => engine.cycle(s.sessionId), (e) => e.code === "cycle_busy");

  assert.equal(state.instances.length, 1, "no respawn attempted");
  assert.equal(pi.closed, 0, "the child holding the unanswered question was never closed");
  assert.ok((await engine.get(s.sessionId)).pendingUi, "the card survives");
});

test("cycle: no_such_session and session_stopped refusals", async () => {
  const { engine } = makeEngine();
  await assert.rejects(() => engine.cycle("perchlive-ghost"), (e) => e.code === "no_such_session");
  const s = await spawned(engine);
  await engine.stop(s.sessionId);
  await assert.rejects(() => engine.cycle(s.sessionId), (e) => e.code === "session_stopped");
});

// Fix round 1 (coordinator-reported Important finding): two concurrent
// cycle() calls on the SAME session used to race — the second saw `s.pi`
// already null after the first's hibernate() closed it, no-op'd its own
// hibernate(), and spawned a competing child; then the first's suspended
// startChild resumed and spawned a THIRD, clobbering `s.pi` and leaking the
// second's child as an uncounted orphan. `s.cycling` (set synchronously,
// before cycle()'s first await; cleared in a finally) closes this the same
// way `s.turn`'s claim closes message()'s own re-entrancy hole.
test("cycle: re-entrancy guard — two concurrent cycle() on ONE session produce exactly one respawn, the other gets cycle_busy", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine, "botty");
  assert.equal(state.instances.length, 1);

  let outcomeA = null;
  let outcomeB = null;
  const pA = engine.cycle(s.sessionId).then((r) => { outcomeA = { ok: true, r }; }, (e) => { outcomeA = { ok: false, e }; });
  const pB = engine.cycle(s.sessionId).then((r) => { outcomeB = { ok: true, r }; }, (e) => { outcomeB = { ok: false, e }; });
  await Promise.allSettled([pA, pB]);

  const outcomes = [outcomeA, outcomeB];
  const ok = outcomes.filter((o) => o.ok);
  const bad = outcomes.filter((o) => !o.ok);
  assert.equal(ok.length, 1, "exactly one of the two racing cycle() calls succeeds");
  assert.equal(bad.length, 1, "the other is refused, not left to race");
  assert.equal(bad[0].e.code, "cycle_busy");
  assert.equal(state.instances.length, 2, "exactly ONE respawn happened — the original plus ONE fresh child, never two");
  assert.equal(state.instances[0].closed, 1, "the original child was closed exactly once");
  assert.equal((await engine.get(s.sessionId)).state, "awake");
  // The guard clears itself: a THIRD cycle(), after both racers have
  // settled, is not wedged permanently cycle_busy.
  const r3 = await engine.cycle(s.sessionId);
  assert.equal(r3.state, "awake");
  assert.equal(state.instances.length, 3);
});

test("cycle: a message() fired mid-cycle gets a typed refusal — exactly one live child survives", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine, "botty");
  const firstPi = state.instances[0];

  // Hold the respawn inside buildBotWorld so the session is genuinely
  // mid-cycle — the OLD child already closed by hibernate(), the NEW one not
  // yet constructed — when message() fires.
  let release;
  state.worldGate = new Promise((r) => { release = r; });
  const cyclePromise = engine.cycle(s.sessionId);
  await tick();
  assert.equal(firstPi.closed, 1, "test setup sanity: the old child is already closed mid-cycle");
  assert.equal(state.instances.length, 1, "test setup sanity: the new child has not been constructed yet");

  await assert.rejects(() => engine.message(s.sessionId, "hi"), (e) => e.code === "cycle_busy",
    "message() must not try to wake a session cycle() is already respawning");

  release();
  const r = await cyclePromise;
  assert.equal(r.state, "awake");

  assert.equal(state.instances.length, 2, "exactly one respawn — message() never spawned a competing child");
  assert.equal(state.instances[1].closed, 0, "the new child is alive and untouched");
});

// ---------------------------------------------------------------------------
// 2. safe-victim eviction
// ---------------------------------------------------------------------------

test("safe-victim eviction: DEFAULT_MAX_AWAKE is 3 with no env override — a 4th spawn evicts the oldest-idle", async () => {
  const { engine, clock, state } = makeEngine();       // no PERCH_INTERACTIVE_MAX_AWAKE set
  const a = await spawned(engine, "a");
  clock.advance(1000);
  const b = await spawned(engine, "b");
  clock.advance(1000);
  const c = await spawned(engine, "c");
  assert.equal(state.instances.length, 3, "three fakes spawn cleanly at the default cap");

  const d = await spawned(engine, "d");
  assert.equal(d.state, "awake", "the fourth spawn succeeds via eviction, not a refusal");
  assert.equal(state.instances.length, 4);
  assert.equal(state.instances[0].closed, 1, "a (the oldest-idle) was evicted");
  assert.equal((await engine.get(a.sessionId)).state, "hibernating");
  assert.equal((await engine.get(b.sessionId)).state, "awake", "b and c were untouched");
  assert.equal((await engine.get(c.sessionId)).state, "awake");
});

test("safe-victim eviction: MAX_AWAKE=2, two idle awake sessions — a third spawn evicts the oldest-idle and succeeds", async () => {
  const { engine, clock, state } = makeEngine({ env: { PERCH_INTERACTIVE_MAX_AWAKE: "2" } });
  const a = await spawned(engine, "a");
  clock.advance(1000);                                  // a is strictly older-idle than b
  const b = await spawned(engine, "b");
  assert.equal(state.instances.length, 2);

  const c = await spawned(engine, "c");

  assert.equal(c.state, "awake");
  assert.equal(state.instances.length, 3, "a's OLD child closed, c's NEW child opened — three total");
  assert.equal(state.instances[0].closed, 1, "a (oldest-idle) was evicted — its child closed");
  assert.equal((await engine.get(a.sessionId)).state, "hibernating", "a is now hibernating");
  assert.equal((await engine.get(b.sessionId)).state, "awake", "b (newer-idle) was left untouched");
  assert.equal(rowFor(a.threadId).status, "waiting-user", "a's row is parked, not left active");
});

test("safe-victim eviction: no eligible victim (one mid-turn, one pendingUi) — third spawn throws interactive_capacity", async () => {
  const { engine, state } = makeEngine({ env: { PERCH_INTERACTIVE_MAX_AWAKE: "2" } });
  const a = await spawned(engine, "a");
  const b = await spawned(engine, "b");
  await engine.message(a.sessionId, "stay busy");        // a: mid-turn — ineligible
  await engine.message(b.sessionId, "ask");
  state.instances[1].emit({ type: "extension_ui_request", id: "q", method: "input", title: "T" }); // b: pendingUi — ineligible
  assert.equal(state.instances.length, 2);

  await assert.rejects(() => engine.spawn({ botId: "c" }), (e) => e.code === "interactive_capacity");

  assert.equal(state.instances.length, 2, "no third child — no eligible victim to evict");
  assert.equal(state.instances[0].closed, 0);
  assert.equal(state.instances[1].closed, 0);
  assert.equal((await engine.get(a.sessionId)).state, "awake");
  assert.equal((await engine.get(b.sessionId)).state, "awake");
});

test("safe-victim eviction: pi_capacity is never evicted around — a saturated host pi budget refuses outright even with an idle victim available", async () => {
  const { engine, state } = makeEngine({ env: { PERCH_INTERACTIVE_MAX_AWAKE: "2" }, bridgeOpts: { maxPi: 1 } });
  const a = await spawned(engine, "a");                 // idle, otherwise evictable
  assert.equal(state.instances.length, 1);
  state.livePi = 1;                                     // host pi budget now saturated

  await assert.rejects(() => engine.spawn({ botId: "b" }), (e) => e.code === "pi_capacity");

  assert.equal(state.instances.length, 1, "no eviction was attempted for a pi_capacity refusal");
  assert.equal(state.instances[0].closed, 0);
  assert.equal((await engine.get(a.sessionId)).state, "awake");
});

test("safe-victim eviction: the wake path (message()) evicts exactly like spawn()", async () => {
  const { engine, clock, env, state } = makeEngine({ env: { PERCH_INTERACTIVE_MAX_AWAKE: "2" } });
  const a = await spawned(engine, "a");
  const b = await spawned(engine, "b");
  clock.advance(600_001);
  await tick();                                          // both hibernate on idle timeout
  assert.equal((await engine.get(a.sessionId)).state, "hibernating");
  assert.equal((await engine.get(b.sessionId)).state, "hibernating");

  // Retune the cap down to 1 (env is mutable, read at call time — the P1
  // idiom) so waking BOTH forces the second wake to evict the first.
  env.PERCH_INTERACTIVE_MAX_AWAKE = "1";

  await engine.message(a.sessionId, "wake a");
  assert.equal((await engine.get(a.sessionId)).state, "awake");
  assert.equal(state.instances.length, 3, "a woke into a THIRD fake instance");
  // Let a's turn complete so it is idle (turn===null) — an eviction
  // candidate needs no in-flight turn, same as a plain spawned session.
  state.instances[2].lastTurn().resolve({ type: "agent_end", messages: [] });
  await tick();

  // b's wake evicts a (the only idle awake occupant) via the SAME
  // reserveWithEviction path message() now shares with spawn().
  await engine.message(b.sessionId, "wake b");
  assert.equal((await engine.get(b.sessionId)).state, "awake");
  assert.equal((await engine.get(a.sessionId)).state, "hibernating", "a (idle) was evicted to make room for b");
  assert.equal(state.instances.length, 4, "b woke into a FOURTH fake instance");
});

test("safe-victim eviction: concurrency — two concurrent spawns racing ONE eligible victim produce exactly one eviction and one refusal (the sync handover)", async () => {
  const { engine, state } = makeEngine({ env: { PERCH_INTERACTIVE_MAX_AWAKE: "2" } });
  const v1 = await spawned(engine, "v1");                // idle — the only eligible victim
  const v2 = await spawned(engine, "v2");
  await engine.message(v2.sessionId, "stay busy");        // mid-turn — NOT eligible
  assert.equal(state.instances.length, 2);

  let outcomeA = null;
  let outcomeB = null;
  const pA = engine.spawn({ botId: "a" }).then((r) => { outcomeA = { ok: true, r }; }, (e) => { outcomeA = { ok: false, e }; });
  const pB = engine.spawn({ botId: "b" }).then((r) => { outcomeB = { ok: true, r }; }, (e) => { outcomeB = { ok: false, e }; });
  await Promise.allSettled([pA, pB]);

  const outcomes = [outcomeA, outcomeB];
  const ok = outcomes.filter((o) => o.ok);
  const bad = outcomes.filter((o) => !o.ok);
  assert.equal(ok.length, 1, "exactly one of the two racing spawns succeeds");
  assert.equal(bad.length, 1, "exactly one refusal");
  assert.equal(bad[0].e.code, "interactive_capacity");
  assert.equal(state.instances[0].closed, 1, "v1 (the only eligible victim) was evicted exactly once");
  assert.equal((await engine.get(v1.sessionId)).state, "hibernating");
  assert.equal((await engine.get(v2.sessionId)).state, "awake", "v2 (ineligible) was left untouched");
  // v1, v2, and exactly ONE winner's fresh child — never two.
  assert.equal(state.instances.length, 3, "only the winner got a fresh child — no double-eviction, no double-spawn");
});

// ---------------------------------------------------------------------------
// 3. stopAll interruption marker
// ---------------------------------------------------------------------------

test("stopAll: an in-flight turn is parked with control='interrupted'; an idle session is parked with control='run'", async () => {
  const { engine } = makeEngine({ env: { PERCH_INTERACTIVE_MAX_AWAKE: "2" } });
  const busy = await spawned(engine, "busy");
  await engine.message(busy.sessionId, "go");            // mid-turn when stopAll lands
  const idle = await spawned(engine, "idle");            // no turn

  await engine.stopAll();

  assert.equal(rowFor(busy.threadId).control, "interrupted");
  assert.equal(rowFor(idle.threadId).control, "run");
});

test("stopAll: a session's NEXT normal write resets control back to 'run'", async () => {
  const { engine } = makeEngine({ env: { PERCH_INTERACTIVE_MAX_AWAKE: "2" } });
  const busy = await spawned(engine, "busy");
  await engine.message(busy.sessionId, "go");
  await engine.stopAll();
  assert.equal(rowFor(busy.threadId).control, "interrupted");

  // Waking the SAME session (not a fresh spawn, which would mint an
  // unrelated row) writes a normal row (writeRow's default control='run').
  await engine.message(busy.sessionId, "hi again");
  assert.equal(rowFor(busy.threadId).control, "run", "the next normal write clears the marker");
});

// ---------------------------------------------------------------------------
// 4. hibernate()'s pendingUi guard
// ---------------------------------------------------------------------------

test("hibernate(): called directly on a pendingUi session is a no-op — the card and the child survive (spec I5)", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  await engine.message(s.sessionId, "ask");
  const pi = state.instances[0];
  pi.emit({ type: "extension_ui_request", id: "q", method: "input", title: "T" });
  const before = await engine.get(s.sessionId);
  assert.ok(before.pendingUi, "test setup sanity: a card is pending");

  await engine._hibernateForTest(s.sessionId);

  const after = await engine.get(s.sessionId);
  assert.equal(after.state, "awake", "the session was never hibernated");
  assert.ok(after.pendingUi, "the card survives");
  assert.equal(pi.closed, 0, "the child holding the unanswered question was never closed");
});

test("hibernate(): a normal idle session (no pendingUi) DOES hibernate via the same test seam", async () => {
  const { engine, state } = makeEngine();
  const s = await spawned(engine);
  await engine._hibernateForTest(s.sessionId);
  const after = await engine.get(s.sessionId);
  assert.equal(after.state, "hibernating");
  assert.equal(state.instances[0].closed, 1);
});
