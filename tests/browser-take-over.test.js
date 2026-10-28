/**
 * Live browser tile, Task 7: Take over, Hand back and the password copy —
 * the server side (spec 2026-10-27 §4.4, §7 items 7, 13, 14; Rulings B3, B4).
 *
 * Three harnesses:
 *  - the take-over controller (servers/gateway/browser-tile/take-over.js) on
 *    the REAL shared lease module in a scratch dir, with an injected clock and
 *    timers, plus the REAL browser MCP lease guard playing the bot (so "the
 *    bot is told" is the guard's own text, not a stand-in);
 *  - the Perch engine with a fake pi child (the browser-tile-session harness):
 *    the operator frames, the stall pause, the operator note, the forged file,
 *    the wait_for_user attention item;
 *  - the three routes on the real perch-api router behind the REAL
 *    dashboardAuth and csrfMiddleware (Serve headers via actAsServe, a real
 *    session row in a scratch crow.db).
 * Plus the Browser panel's notice, rendered by its real handler.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, openSync, closeSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { actAsServe, serveHeaders } from "./fixtures/serve-peer.mjs";
actAsServe();

for (const k of Object.keys(process.env)) if (/^(PI_|PIBOT_)/.test(k)) delete process.env[k];
process.env.CROW_PI_SANDBOX = "off";

const dir = mkdtempSync(join(tmpdir(), "browser-take-over-"));
process.env.CROW_DATA_DIR = dir;
process.env.CROW_HOME = join(dir, "home");
delete process.env.CROW_DB_PATH;
process.env.PI_MODELS_JSON = join(dir, "models.json");
const CROW_HOME = process.env.CROW_HOME;
const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

let lease, takeOverMod, guardMod, createInteractiveEngine, _resetInteractiveEngineForTest;

const TAKEN = "The operator took the browser during this step; check the page.";
const HANDED_BACK = "The operator handed the browser back; call again.";
const HELD = "The operator has the browser; call again to continue.";

// ---------------------------------------------------------------------------
// shared bits
// ---------------------------------------------------------------------------
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
    set(v) { t = v; },
    pendingNamed: (name) => [...timers.values()].filter((e) => e.fn.name === name).length,
  };
}
const tick = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
/** Advance the fake clock in steps, letting the controller's async work settle between them. */
async function advance(clock, ms, step = 500) {
  for (let done = 0; done < ms; done += step) { clock.advance(Math.min(step, ms - done)); await tick(); }
}
let leaseSeq = 0;
function scratchLeaseDir() {
  const d = join(dir, "lease-" + (++leaseSeq));
  mkdirSync(d, { mode: 0o700 });
  return d;
}

/** The controller on a scratch lease dir; onHeld calls recorded. */
function controller(o = {}) {
  const clock = o.clock || makeClock();
  const d = o.dir || scratchLeaseDir();
  const held = [];
  const ctl = takeOverMod.createTakeOver({
    dir: () => d, onHeld: (h) => held.push(h),
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    isAlive: o.isAlive || null, log: () => {},
  });
  return { ctl, clock, dir: d, held };
}

/** The REAL browser MCP lease guard, as one Perch session's bot, on the same clock and dir. */
function botGuard(clock, d, { sessionId = "perchlive-aaaa0001", botId = "bot-a" } = {}) {
  const server = { handlers: {}, tool(name, ...rest) { this.handlers[name] = rest.at(-1); } };
  guardMod.installLeaseGuard(server, {
    lease, dir: d, env: { PI_BOT_PERCH_SESSION_ID: sessionId, PI_BOT_ID: botId }, pid: process.pid,
    now: clock.now,
    // the guard's 500 ms operator poll: real microtask yields plus the fake clock
    sleep: async (ms) => { clock.advance(ms); await tick(5); },
    getTargetId: async () => "TARGET1", proc: new EventEmitter(), exit: () => {},
  });
  const acted = [];
  let gate = null;
  server.tool("crow_browser_click", "stub", {}, async (args) => {
    acted.push(args);
    if (gate) await gate.promise;
    return { content: [{ type: "text", text: "clicked" }] };
  });
  return {
    acted,
    call: (args = {}) => server.handlers.crow_browser_click(args, {}),
    hold() { let r; gate = { promise: new Promise((x) => { r = x; }) }; gate.release = r; return gate; },
    open() { const g = gate; gate = null; if (g) g.release(); },
  };
}
const text = (r) => r.content.map((c) => c.text || "").join("\n");

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: REPO });
  mkdirSync(CROW_HOME, { recursive: true });
  writeFileSync(process.env.PI_MODELS_JSON, JSON.stringify({ providers: { "crow-local": { models: [{ id: "qwen3.6-35b-a3b" }] } } }));
  lease = await import("../servers/shared/browser-lease.js");
  takeOverMod = await import("../servers/gateway/browser-tile/take-over.js");
  guardMod = await import("../bundles/browser/server/lease-guard.js");
  const mod = await import("../servers/gateway/perch-interactive.js");
  createInteractiveEngine = mod.createInteractiveEngine;
  _resetInteractiveEngineForTest = mod._resetInteractiveEngineForTest;
});
beforeEach(() => { if (_resetInteractiveEngineForTest) _resetInteractiveEngineForTest(); });
after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

// ---------------------------------------------------------------------------
// the controller + the lease + the bot's guard
// ---------------------------------------------------------------------------

test("take-over waits for the in-flight call: pending, then held when the call ends; the bot's step ran once and untouched", async () => {
  const { ctl, clock, dir: d, held } = controller();
  const bot = botGuard(clock, d);
  const gate = bot.hold();
  const running = bot.call({ selector: "#submit" });
  await tick();
  assert.equal(bot.acted.length, 1, "the bot's submit is in flight");
  assert.equal((await lease.readLease(d)).inCall.length, 1);

  assert.deepEqual(await ctl.takeOver(), { state: "pending" });
  assert.deepEqual(held, [], "not switched while the call runs");
  await advance(clock, 5000);
  assert.equal(ctl.state(), "pending");
  assert.equal((await lease.readLease(d)).holder.kind, "bot", "the bot keeps the page until its step ends");
  assert.deepEqual(await ctl.heartbeat(), { state: "pending" });

  bot.open();
  const r = await running;
  assert.equal(text(r), "clicked", "the step finished on its own, with no take-over prefix");
  await advance(clock, 600);
  assert.equal(ctl.state(), "held");
  assert.deepEqual(held, [true]);
  const l = await lease.readLease(d);
  assert.equal(l.holder.kind, "operator");
  assert.deepEqual(l.inCall, []);
  assert.equal(bot.acted.length, 1, "submitted once");
  ctl.close();
});

test("with a pending take-over, a new bot call does not act; the in-flight call finishes; the switch happens when it ends", async () => {
  const { ctl, clock, dir: d, held } = controller();
  const bot = botGuard(clock, d);
  const gate = bot.hold();
  const inFlight = bot.call({ step: "submit" });
  await tick();
  assert.deepEqual(await ctl.takeOver(), { state: "pending" });
  const l = await lease.readLease(d);
  assert.equal(typeof l.pendingOperator, "number", "the lease says the operator asked");
  assert.equal(lease.operatorBlocks(l, clock.now()), true);
  // A NEW call of the same bot: it waits (like an operator holding), never acts.
  bot.open();   // the next call must not block on the gate; the in-flight one still waits on `gate`
  let newer = null;
  const second = bot.call({ step: "next" }).then((r) => { newer = r; });
  await tick();
  assert.equal(newer, null, "the new call waits");
  assert.equal(bot.acted.length, 1, "only the in-flight call ran");
  gate.release();
  const first = await inFlight;
  assert.equal(text(first), "clicked", "the in-flight call finished");
  await second;   // its own 500 ms polls advance the clock: the controller switches meanwhile
  assert.equal(ctl.state(), "held", "switched once the in-flight call ended");
  assert.deepEqual(held, [true]);
  assert.equal(text(newer), HELD, "the new call returned the held text after its 20 s wait");
  assert.equal(bot.acted.length, 1, "the new call never acted");
  const after = await lease.readLease(d);
  assert.equal(after.holder.kind, "operator");
  assert.equal("pendingOperator" in after, false, "the flag ends with the take");
  ctl.close();
});

test("the pending flag: kept across a release (no other bot slips in), refuses a new beginCall, expires after 35 s, survives schema validation", async () => {
  const d = scratchLeaseDir();
  const now = 1_700_000_000_000;
  const a = { kind: "bot", sessionId: "perchlive-aaaa0004", botId: null };
  const b = { kind: "bot", sessionId: "perchlive-bbbb0004", botId: null };
  await lease.acquire(d, a, { now });
  await lease.beginCall(d, a, { callId: "c1", pid: 4242, now });
  const r = await lease.takeOperatorIfIdle(d, { now, isAlive: () => true });
  assert.equal(r.taken, false);
  assert.equal(r.lease.pendingOperator, now);
  await assert.rejects(lease.beginCall(d, a, { callId: "c2", pid: 4242, now }), (e) => e.code === "EPENDINGOPERATOR", "no new call begins");
  await lease.beginCall(d, a, { callId: "c1", pid: 4242, targetId: "T1", now });   // the in-flight call may still record its page
  assert.equal((await lease.acquire(d, a, { now: now + 1 })).reason, "operator", "the holder's own new call waits");
  assert.equal(await lease.release(d, a.sessionId, { now, isAlive: () => false }), "released");
  const freed = await lease.readLease(d);
  assert.equal(freed.holder, null);
  assert.equal(freed.pendingOperator, now, "kept across the release");
  assert.equal((await lease.acquire(d, b, { now: now + 1000 })).reason, "operator", "another bot cannot slip in");
  assert.equal((await lease.acquire(d, b, { now: now + 35_001 })).ok, true, "a forgotten flag expires");
  // validation: a bad flag reads as an invalid (free) lease; a far-future one does not block
  const { writeFileSync: wf } = await import("node:fs");
  const base = { gen: 1, holder: null, inCall: [], releaseOnCallEnd: false, targetId: null, since: 0, renewedAt: 0, ttlMs: 120000, lastHolderKey: null };
  const d2 = scratchLeaseDir();
  wf(join(d2, lease.LEASE_NAME), JSON.stringify({ ...base, pendingOperator: "soon" }));
  assert.equal(await lease.readLease(d2), null);
  wf(join(d2, lease.LEASE_NAME), JSON.stringify({ ...base, pendingOperator: now + 10 * 60_000 }));
  assert.equal(lease.operatorBlocks(await lease.readLease(d2), now), false, "a far-future stamp cannot pin it");
  wf(join(d2, lease.LEASE_NAME), JSON.stringify(base));
  assert.equal("pendingOperator" in (await lease.readLease(d2)), false, "absent stays absent");
  await lease.takeOperatorIfIdle(d, { now: now + 40_000 });
  assert.equal((await lease.clearPendingOperator(d)).holder.kind, "operator");
});

test("past the 30 s cap with the lease still locked, the take-over gives up with the busy answer (not pending until the 5 min loss)", async () => {
  const { ctl, clock, dir: d, held } = controller();
  const bot = botGuard(clock, d);
  bot.hold();
  const running = bot.call({});
  await tick();
  assert.deepEqual(await ctl.takeOver(), { state: "pending" });
  await advance(clock, 29_900);
  assert.equal(ctl.state(), "pending");
  const fd = openSync(join(d, lease.LOCK_NAME), "wx", 0o600); writeSync(fd, process.pid + "\n"); closeSync(fd);
  clock.advance(600);   // the poll at the cap: takeOperator → ELEASELOCKED after the 2 s lock timeout
  for (let i = 0; i < 100 && ctl.state() === "pending"; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(ctl.state(), "idle", "gave up");
  assert.deepEqual(held, []);
  assert.equal(clock.pendingNamed("heartbeatLoss"), 0, "no 5 min wait left");
  assert.equal(clock.pendingNamed("takeOverPoll"), 0);
  await assert.rejects(ctl.heartbeat(), (e) => e.code === "ETAKEOVERBUSY", "the next heartbeat answers busy");
  assert.deepEqual(await ctl.heartbeat(), { state: "idle" }, "once");
  rmSync(join(d, lease.LOCK_NAME));
  bot.open();
  assert.equal(text(await running), "clicked");
  ctl.close();
});

test("take-over waits at most 30 s: then it switches anyway and the still-running call's result says so", async () => {
  const { ctl, clock, dir: d, held } = controller();
  const bot = botGuard(clock, d);
  bot.hold();
  const running = bot.call({ selector: "#pay" });
  await tick();
  assert.deepEqual(await ctl.takeOver(), { state: "pending" });
  await advance(clock, 29_500);
  assert.equal(ctl.state(), "pending", "still waiting before 30 s");
  await advance(clock, 1000);
  assert.equal(ctl.state(), "held", "switched at 30 s");
  assert.deepEqual(held, [true]);
  assert.equal((await lease.readLease(d)).holder.kind, "operator");
  bot.open();
  const r = await running;
  assert.ok(text(r).startsWith(TAKEN), "the bot is told: " + text(r).slice(0, 80));
  assert.equal(bot.acted.length, 1, "the action happened once, never repeated");
  ctl.close();
});

test("take-over with no call in flight switches at once; a second tap renews, never takes twice", async () => {
  const { ctl, clock, dir: d, held } = controller();
  await lease.acquire(d, { kind: "bot", sessionId: "perchlive-aaaa0001", botId: "bot-a" }, { now: clock.now() });
  assert.deepEqual(await ctl.takeOver(), { state: "held" });
  const g = (await lease.readLease(d)).gen;
  clock.advance(1000);
  const [a, b] = await Promise.all([ctl.takeOver(), ctl.takeOver()]);
  assert.deepEqual([a, b], [{ state: "held" }, { state: "held" }]);
  assert.deepEqual(held, [true], "onHeld once");
  assert.equal((await lease.readLease(d)).gen, g, "a renewal, not a new holding");
  ctl.close();
});

test("heartbeat keeps it; 5 minutes without one releases; page hide or navigation does not (nothing but the button or the loss ends it)", async () => {
  const { ctl, clock, dir: d, held } = controller();
  assert.deepEqual(await ctl.takeOver(), { state: "held" });
  for (let i = 0; i < 4; i++) {
    clock.advance(4 * 60_000 + 50_000);   // 4 min 50 s, under the 5 min loss
    await tick();
    assert.equal(ctl.state(), "held", "heartbeat " + i + " came in time");
    assert.deepEqual(await ctl.heartbeat(), { state: "held" });
    const l = await lease.readLease(d);
    assert.equal(l.holder.kind, "operator");
    assert.equal(l.renewedAt, clock.now(), "the heartbeat renews the file too");
  }
  // The tab hides, the phone dozes, the operator navigates: the server is not told and does nothing.
  clock.advance(4 * 60_000 + 59_000);
  await tick();
  assert.equal(ctl.state(), "held");
  assert.equal(clock.pendingNamed("heartbeatLoss"), 1, "exactly one loss timer");
  clock.advance(2000);
  await tick();
  assert.equal(ctl.state(), "idle", "5 minutes without a heartbeat hands it back");
  assert.deepEqual(held, [true, false]);
  assert.equal((await lease.readLease(d)).holder, null, "the lease is free");
  assert.deepEqual(await ctl.heartbeat(), { state: "idle" }, "a late heartbeat learns it went back");
  assert.equal(clock.pendingNamed("heartbeatLoss"), 0);
  ctl.close();
});

test("hand back clears it and a waiting bot's next call acts (the waited call never acts)", async () => {
  const { ctl, clock, dir: d, held } = controller();
  const bot = botGuard(clock, d);
  await ctl.takeOver();
  // Hand back while the bot is waiting on the operator.
  let waited = null;
  const p = bot.call({ selector: "#next" }).then((r) => { waited = r; });
  await tick();
  assert.equal(waited, null, "the bot is waiting");
  assert.deepEqual(await ctl.handBack(), { state: "idle" });
  await p;
  assert.equal(text(waited), HANDED_BACK);
  assert.equal(bot.acted.length, 0, "a call that waited never acts");
  assert.deepEqual(held, [true, false]);
  assert.equal((await lease.readLease(d)).holder, null);
  const next = await bot.call({ selector: "#next" });
  assert.match(text(next), /clicked/, "the next call acts");
  assert.equal(bot.acted.length, 1);
  // a hand back with nothing held answers idle and changes nothing
  assert.deepEqual(await ctl.handBack(), { state: "idle" });
  assert.deepEqual(held, [true, false]);
  ctl.close();
});

test("a pending take-over handed back before it switched never takes the browser", async () => {
  const { ctl, clock, dir: d, held } = controller();
  const bot = botGuard(clock, d);
  bot.hold();
  const running = bot.call({});
  await tick();
  assert.deepEqual(await ctl.takeOver(), { state: "pending" });
  assert.deepEqual(await ctl.handBack(), { state: "idle" });
  assert.equal("pendingOperator" in (await lease.readLease(d)), false, "the request's flag is dropped");
  await advance(clock, 31_000);
  assert.deepEqual(held, [], "never held");
  assert.equal((await lease.readLease(d)).holder.kind, "bot");
  bot.open();
  assert.equal(text(await running), "clicked");
  assert.equal(clock.pendingNamed("takeOverPoll"), 0);
  ctl.close();
});

test("a forged operator lease file never counts as the operator's holding (B4)", async () => {
  const { ctl, clock, dir: d, held } = controller();
  await lease.takeOperator(d, { now: clock.now() });   // a bot wrote the operator into the file
  assert.equal(ctl.state(), "idle");
  assert.deepEqual(await ctl.heartbeat(), { state: "idle" }, "the heartbeat route does not adopt it");
  assert.equal((await lease.readLease(d)).renewedAt, clock.now(), "and does not renew it");
  clock.advance(10_000);
  await ctl.heartbeat();
  assert.notEqual((await lease.readLease(d)).renewedAt, clock.now());
  assert.deepEqual(held, [], "onHeld (the engine's operator state) never fired");
  ctl.close();
});

test("a jammed lease lock is busy, never a hang (B3): take-over throws ELEASELOCKED within the lock timeout", async () => {
  const { ctl, dir: d } = controller();
  const fd = openSync(join(d, lease.LOCK_NAME), "wx", 0o600);
  writeSync(fd, process.pid + "\n");   // a live pid, a fresh mtime: not breakable for 30 s
  closeSync(fd);
  const t0 = Date.now();
  await assert.rejects(ctl.takeOver(), (e) => e.code === "ELEASELOCKED");
  assert.ok(Date.now() - t0 < 5000, "gave up within the lock timeout");
  assert.equal(ctl.state(), "idle");
  rmSync(join(d, lease.LOCK_NAME));
  assert.deepEqual(await ctl.takeOver(), { state: "held" }, "works again once the lock is gone");
  ctl.close();
});

test("takeOperatorIfIdle: dead in-call pids do not block; an operator or expired holding is taken", async () => {
  const d = scratchLeaseDir();
  const now = 1_700_000_000_000;
  const bot = { kind: "bot", sessionId: "perchlive-aaaa0002", botId: null };
  await lease.acquire(d, bot, { now });
  await lease.beginCall(d, bot, { callId: "c1", pid: 4242, now });
  assert.equal((await lease.takeOperatorIfIdle(d, { now, isAlive: () => true })).taken, false);
  const r = await lease.takeOperatorIfIdle(d, { now, isAlive: () => false });
  assert.equal(r.taken, true, "a dead pid is no call in flight");
  assert.equal(r.lease.holder.kind, "operator");
  assert.equal((await lease.takeOperatorIfIdle(d, { now: now + 1, isAlive: () => true })).taken, true, "the operator's own: renewed");
  const d2 = scratchLeaseDir();
  await lease.acquire(d2, bot, { now });
  await lease.beginCall(d2, bot, { callId: "c1", pid: 4242, now });
  assert.equal((await lease.takeOperatorIfIdle(d2, { now: now + 121_000, isAlive: () => true })).taken, true, "expired: free");
});

// ---------------------------------------------------------------------------
// the engine
// ---------------------------------------------------------------------------
let pidSeq = 810000;
function makeBridge() {
  const state = { instances: [] };
  class FakePi {
    constructor(o) {
      this.opts = o; this.onEvent = o.onEvent; this.turns = []; this.closed = 0; this.aborts = 0; this._exitCode = null;
      this.proc = { pid: ++pidSeq }; this.piSessionId = "pisess-" + this.proc.pid;
      let done; this.exited = new Promise((r) => { done = r; }); this._done = done;
      state.instances.push(this);
    }
    async getState() { return { data: { sessionId: this.piSessionId } }; }
    async getSessionStats() { return { data: { tokens: { input: 1, output: 1, cacheRead: 0 } } }; }
    promptTurn(message, ms, images) {
      const rec = { message, ms, images };
      rec.promise = new Promise((resolve, reject) => { rec.resolve = resolve; rec.reject = reject; });
      this.turns.push(rec); return rec.promise;
    }
    trimLog() {}
    async abortSince() { this.aborts += 1; return null; }
    send() {}
    async close() { this.closed += 1; this.exit(0); }
    exit(code = 0) { if (this._exitCode != null) return; this._exitCode = code; this._done(code); }
    _exitError() { return new Error("pi exited (code " + this._exitCode + ")"); }
    emit(m) { this.onEvent(m); }
    lastTurn() { return this.turns[this.turns.length - 1]; }
  }
  const resolved = { provider: "crow-local", model: "qwen3.6-35b-a3b", key: "crow-local/qwen3.6-35b-a3b", escalated: false, source: "default" };
  return {
    _state: state, PiRpc: FakePi, LIFECYCLE_DEFAULTS: { maxPi: 8 }, countLivePi: () => 0,
    async buildBotWorld(args) {
      return {
        def: { session_dir: join(dir, "bots", args.botId), permission_policy: { bash: "deny", write_paths: [] } },
        bot: { bot_id: args.botId }, crowHome: CROW_HOME, projectId: 7, projectSpace: null, projectMembers: [],
        sessionDir: join(dir, "bots", args.botId), tasksDbPath: join(dir, "tasks.db"),
        remoteEnabled: false, peerGatewayUrls: {}, session: null, narrowedTools: null, gatewayType: args.gatewayType,
      };
    },
    async prepareSpawn(world) {
      return { sysFile: join(dir, "sys.md"), selfAuthoringDir: null, resolved,
        piRpcOpts: { def: world.def, sessionDir: world.sessionDir, resolved, selfAuthoringDir: null, remoteEnabled: false, narrowedTools: null } };
    },
    async warmModel() {}, async meterTurn() { return { recorded: true }; }, appendAudit() {},
  };
}
function makeEngine(o = {}) {
  const clock = makeClock();
  const bridge = makeBridge();
  const leaseDir = scratchLeaseDir();
  const notes = [];
  const notifications = {
    async createNotification(_db, opts) { notes.push(opts); return { id: notes.length }; },
    async upsertGroupedNotification() { return { created: true }; },
    async closeNotificationGroup() {},
    async repushNotificationGroup() { return null; },
  };
  const engine = createInteractiveEngine({
    crowHome: CROW_HOME, env: Object.assign({ CROW_HOME }, o.env), bridge,
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    log: () => {}, notifications,
    browserLease: { installed: true, dir: leaseDir, isAlive: () => false },
  });
  return { engine, clock, state: bridge._state, leaseDir, notes };
}
const NAV = "mcp__browser__crow_browser_navigate";
const END = { type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] };

async function liveTurn(h) {
  const s = await h.engine.spawn({ botId: "botty" });
  await tick();
  const events = [];
  await h.engine.subscribe(s.sessionId, (e) => events.push(e));
  await h.engine.message(s.sessionId, "browse");
  const pi = h.state.instances[0];
  pi.emit({ type: "tool_execution_start", toolName: NAV, toolCallId: "c1", args: { url: "https://example.test/" } });
  await lease.acquire(h.leaseDir, { kind: "bot", sessionId: s.sessionId, botId: "botty" }, { now: h.clock.now() });
  pi.emit({ type: "tool_execution_end", toolName: NAV, toolCallId: "c1", isError: false, result: { content: [] } });
  await tick();
  const browser = () => events.filter((e) => e.type === "browser");
  assert.equal(browser().filter((e) => e.phase === "live").length, 1, "the tile went live");
  return { s, pi, events, browser };
}

test("engine: take over emits the operator frame (held) to the live tile, pauses the stall watchdog; hand back emits held:false and re-arms it", async () => {
  const h = makeEngine({ env: { PERCH_TURN_STALL_MS: "1000" } });
  const { s, pi, events, browser } = await liveTurn(h);
  assert.deepEqual(await h.engine.browserTakeOver.takeOver(), { state: "held" });
  await tick();
  assert.deepEqual(browser().filter((e) => e.phase === "operator"), [{ type: "browser", phase: "operator", anchor: "c1", held: true }]);
  // a reconnecting thread sees "Waiting for you" again
  const late = [];
  await h.engine.subscribe(s.sessionId, (e) => late.push(e));
  assert.deepEqual(late.filter((e) => e.type === "browser").map((e) => e.phase + ":" + (e.held ?? "")), ["live:", "operator:true"]);
  h.clock.advance(5000);
  await tick();
  assert.equal(events.filter((e) => e.type === "error").length, 0, "no stall while the operator has it");
  assert.deepEqual(await h.engine.browserTakeOver.handBack(), { state: "idle" });
  await tick();
  assert.deepEqual(browser().filter((e) => e.phase === "operator").map((e) => e.held), [true, false]);
  h.clock.advance(1001);
  await tick();
  assert.ok(events.some((e) => e.type === "error" && /stall/.test(e.text)), "re-armed after hand back");
  assert.equal(pi.aborts >= 0, true);
});

test("engine: a turn that ends while the operator holds it → Done, no shot, the note; hand back starts nothing", async () => {
  const h = makeEngine();
  let shots = 0;
  h.engine.browserHooks.finalShot = async () => { shots += 1; return { id: 1, url: "/x/1" }; };
  const { s, pi, browser } = await liveTurn(h);
  assert.equal(h.engine.browserTurnLive(s.sessionId), true, "a live turn using the browser");
  await h.engine.browserTakeOver.takeOver();
  pi.lastTurn().resolve(END);
  await tick();
  assert.equal(h.engine.browserTurnLive(s.sessionId), false, "the turn ended: a link no longer takes it");
  assert.deepEqual(browser().filter((e) => e.phase === "done"), [{ type: "browser", phase: "done", anchor: "c1", domain: null, shot: null, note: "operator" }]);
  assert.equal(shots, 0);
  assert.equal(h.engine.browserTurnLive("perchlive-nosuch00"), false);
  const before = browser().length;
  await h.engine.browserTakeOver.handBack();
  await tick();
  assert.equal(browser().length, before, "no frame for a finished tile");
  assert.equal(h.state.instances[0].turns.length, 1, "hand back starts no turn");
});

test("engine: a forged operator file during a turn sets no operator state: no frame, no note, the stall still runs", async () => {
  const h = makeEngine({ env: { PERCH_TURN_STALL_MS: "1000" } });
  let shots = 0;
  h.engine.browserHooks.finalShot = async () => { shots += 1; return null; };
  const { pi, events, browser } = await liveTurn(h);
  await lease.takeOperator(h.leaseDir, { now: h.clock.now() });   // the bot forged it
  h.engine.browserLeaseChanged(await lease.readLease(h.leaseDir));
  await tick();
  assert.equal(browser().filter((e) => e.phase === "operator").length, 0);
  assert.deepEqual(await h.engine.browserTakeOver.heartbeat(), { state: "idle" });
  h.clock.advance(1001);
  await tick();
  assert.ok(events.some((e) => e.type === "error" && /stall/.test(e.text)), "the stall watchdog was never paused");
  pi.lastTurn().resolve(END);
  await tick();
  const done = browser().filter((e) => e.phase === "done")[0];
  assert.equal(done.note, null, "the note needs the gateway's own record");
  void shots;   // the stalled turn's own exit path decides the shot; the point is the note
});

const WAIT = "mcp__browser__crow_browser_wait_for_user";
const parked = (message = "x") => ({ content: [{ type: "text", text: JSON.stringify({ status: "waiting_for_user", message, instruction: "tap Take over" }, null, 2) }] });

test("wait_for_user raises the attention item at its END, only when it parked (not on a busy/held refusal, not on resume)", async () => {
  const h = makeEngine();
  const s = await h.engine.spawn({ botId: "botty" });
  await tick();
  await h.engine.message(s.sessionId, "log in");
  const pi = h.state.instances[0];
  // a refusal from the lease guard: no item
  pi.emit({ type: "tool_execution_start", toolName: WAIT, toolCallId: "w0", args: { message: "x" } });
  await tick();
  assert.equal(h.notes.length, 0, "nothing at the start");
  pi.emit({ type: "tool_execution_end", toolName: WAIT, toolCallId: "w0", isError: false, result: { content: [{ type: "text", text: "The operator has the browser; call again to continue." }] } });
  await tick();
  assert.equal(h.notes.length, 0, "a held refusal raises nothing");
  // an error: no item
  pi.emit({ type: "tool_execution_start", toolName: WAIT, toolCallId: "w9", args: {} });
  pi.emit({ type: "tool_execution_end", toolName: WAIT, toolCallId: "w9", isError: true, result: parked() });
  await tick();
  assert.equal(h.notes.length, 0);
  // parked: the item (the end frame carries no args; the start's verdict is remembered)
  pi.emit({ type: "tool_execution_start", toolName: WAIT, toolCallId: "w1", args: { message: "Solve the CAPTCHA on https://bank.example.test/login" } });
  pi.emit({ type: "tool_execution_end", toolName: WAIT, toolCallId: "w1", isError: false, result: parked("Solve the CAPTCHA on https://bank.example.test/login") });
  await tick();
  pi.emit({ type: "tool_execution_start", toolName: "mcp__browser", toolCallId: "w2", args: { action: "call", tool: "crow_browser_wait_for_user", args: { message: "again" } } });
  pi.emit({ type: "tool_execution_end", toolName: "mcp__browser", toolCallId: "w2", isError: false, result: parked() });
  await tick();
  assert.equal(h.notes.length, 1, "one item per turn");
  const n = h.notes[0];
  assert.equal(n.type, "attention");
  assert.equal(n.priority, "high");
  assert.equal(n.action_url, "/dashboard/perch?take-over=1#" + s.sessionId);
  assert.match(n.title, /botty needs you/);
  assert.doesNotMatch(JSON.stringify(n), /bank\.example|https?:/, "no URL or host rides the item");
  pi.lastTurn().resolve(END);
  await tick();
  await h.engine.message(s.sessionId, "go on");
  const pi2 = h.state.instances[0];
  pi2.emit({ type: "tool_execution_start", toolName: WAIT, toolCallId: "w3", args: { message: "x", resume: true } });
  pi2.emit({ type: "tool_execution_end", toolName: WAIT, toolCallId: "w3", isError: false, result: parked() });
  pi2.emit({ type: "tool_execution_start", toolName: "mcp__browser", toolCallId: "w4", args: JSON.stringify({ action: "call", tool: "crow_browser_wait_for_user", args: { resume: true } }) });
  pi2.emit({ type: "tool_execution_end", toolName: "mcp__browser", toolCallId: "w4", isError: false, result: parked() });
  await tick();
  assert.equal(h.notes.length, 1, "resume raises nothing");
  const { isWaitForUser } = await import("../servers/gateway/browser-tile/session-hooks.js");
  assert.equal(isWaitForUser("mcp__other__crow_browser_navigate", {}), false);
  assert.equal(isWaitForUser("mcp__x__wait_for_user", {}), false);
});

/** The real engine behind the real router (auth stubbed: the auth rails are tested below). */
async function engineRoutes(h) {
  const { default: perchInteractiveApiRouter } = await import("../servers/gateway/routes/perch-interactive-api.js");
  const { default: express } = await import("express");
  const app = express();
  app.use(express.json());
  app.use(perchInteractiveApiRouter((req, res, next) => next(), { engine: () => h.engine, annotate: async (m) => m, providerModels: () => [], piProviders: () => null }));
  const srv = await new Promise((r) => { const x = app.listen(0, "127.0.0.1", () => r(x)); });
  const base = "http://127.0.0.1:" + srv.address().port + "/dashboard/perch-api/browser/";
  const post = async (op, body) => {
    const r = await fetch(base + op, { method: "POST", headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const get = async (op) => { const r = await fetch(base + op); return { status: r.status, body: await r.json().catch(() => null) }; };
  return { post, get, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }) };
}

test("the wait_for_user link after the turn ended opens the sheet and takes the browser; the Done tile keeps Take over; another bot holding → 409; after 30 min → 409", async () => {
  const h = makeEngine();
  const { s, pi, browser } = await liveTurn(h);
  pi.emit({ type: "tool_execution_start", toolName: WAIT, toolCallId: "w1", args: { message: "2FA code" } });
  pi.emit({ type: "tool_execution_end", toolName: WAIT, toolCallId: "w1", isError: false, result: parked("2FA code") });
  await tick();
  pi.lastTurn().resolve(END);   // wait_for_user returns at once: the bot ends its turn
  await tick();
  const done = browser().filter((e) => e.phase === "done")[0];
  assert.equal(done.ask, true, "the Done tile keeps its Take over");
  assert.equal(h.engine.browserTurnLive(s.sessionId), false, "no live turn any more");
  const r = await engineRoutes(h);
  try {
    const link = { from: "link", sid: s.sessionId };
    // the lease: free (the turn end released it)
    assert.deepEqual(await r.post("take-over", link), { status: 200, body: { state: "held" } }, "the link takes the browser");
    assert.equal((await lease.readLease(h.leaseDir)).holder.kind, "operator");
    assert.deepEqual(await r.get("state"), { status: 200, body: { state: "held" } });
    assert.deepEqual((await r.post("take-over", link)).body, { state: "held" }, "operator-held: the link still works (a renewal)");
    assert.deepEqual((await r.post("hand-back")).body, { state: "idle" });
    // another bot holds it now: refused, nothing taken
    await lease.acquire(h.leaseDir, { kind: "bot", sessionId: "perchlive-0ther000", botId: "other" }, { now: h.clock.now() });
    assert.deepEqual(await r.post("take-over", link), { status: 409, body: { error: "no_live_turn" } });
    assert.equal((await lease.readLease(h.leaseDir)).holder.sessionId, "perchlive-0ther000");
    assert.deepEqual(await r.get("state"), { status: 200, body: { state: "idle" } });
    await lease.release(h.leaseDir, "perchlive-0ther000", { now: h.clock.now(), isAlive: () => false });
    // this session's own holding counts
    await lease.acquire(h.leaseDir, { kind: "bot", sessionId: s.sessionId, botId: "botty" }, { now: h.clock.now() });
    assert.equal(await h.engine.browserLinkOk(s.sessionId), true);
    await lease.release(h.leaseDir, s.sessionId, { now: h.clock.now(), isAlive: () => false });
    // 30 minutes later: refused
    h.clock.set(h.clock.now() + 30 * 60_000 + 1000);
    assert.deepEqual(await r.post("take-over", link), { status: 409, body: { error: "no_live_turn" } });
    assert.equal(await h.engine.browserLinkOk("perchlive-nosuch00"), false);
  } finally { h.engine.browserTakeOver.close(); await r.close(); }
});

// ---------------------------------------------------------------------------
// the routes: real dashboardAuth + csrfMiddleware
// ---------------------------------------------------------------------------
async function routeHarness() {
  const { hashToken, dashboardAuth } = await import("../servers/gateway/dashboard/auth.js");
  const { default: Database } = await import("better-sqlite3");
  const c = new Database(join(dir, "crow.db"));
  c.prepare("INSERT OR IGNORE INTO oauth_tokens (token, token_type, client_id, expires_at, created_at) VALUES (?, 'access', 'dashboard', datetime('now','+1 day'), '2026-06-01 00:00:00')").run(hashToken("to-sess"));
  c.close();
  const { default: perchInteractiveApiRouter } = await import("../servers/gateway/routes/perch-interactive-api.js");
  const { csrfMiddleware } = await import("../servers/gateway/dashboard/shared/csrf.js");
  const { default: express } = await import("express");
  const h = controller({ isAlive: () => true });
  const engine = { browserTakeOver: h.ctl, browserLinkOk: async (sid) => sid === "perchlive-11111111" };
  const app = express();
  app.use(express.json());
  const router = express.Router();
  router.use("/dashboard", csrfMiddleware);
  router.use(perchInteractiveApiRouter(dashboardAuth, { engine: () => engine, annotate: async (m) => m, providerModels: () => [], piProviders: () => null }));
  app.use(router);
  const srv = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = "http://127.0.0.1:" + srv.address().port + "/dashboard/perch-api/browser/";
  const AUTH = { ...serveHeaders(), cookie: "crow_session=to-sess; crow_csrf=tok", "x-crow-csrf": "tok" };
  const post = async (op, headers = AUTH, body) => {
    const opts = { method: "POST", headers: body ? { ...headers, "content-type": "application/json" } : headers, redirect: "manual" };
    if (body) opts.body = JSON.stringify(body);
    const r = await fetch(base + op, opts);
    let out = null; try { out = await r.json(); } catch { out = null; }
    return { status: r.status, body: out };
  };
  return { ...h, engine, post, AUTH, base, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }) };
}

test("routes need CSRF and dashboard auth; a contact or Funnel request is refused; take over / heartbeat / hand back answer the state", async () => {
  const r = await routeHarness();
  try {
    const noCsrf = await r.post("take-over", { ...serveHeaders(), cookie: "crow_session=to-sess; crow_csrf=tok" });
    assert.equal(noCsrf.status, 403, "CSRF token missing from the header");
    const wrong = await r.post("take-over", { ...r.AUTH, "x-crow-csrf": "nope" });
    assert.equal(wrong.status, 403);
    const noSession = await r.post("take-over", { ...serveHeaders(), cookie: "crow_csrf=tok", "x-crow-csrf": "tok" });
    assert.ok([302, 303, 401, 403].includes(noSession.status), "no session: " + noSession.status);
    const contact = await r.post("take-over", { ...serveHeaders(), "x-crow-signature": "sig", "x-crow-instance": "peer" });
    assert.ok([302, 303, 401, 403].includes(contact.status), "a signed contact request: " + contact.status);
    const funnel = await r.post("take-over", { ...r.AUTH, "tailscale-funnel-request": "?1" });
    assert.equal(funnel.status, 403, "Funnel");
    const offNet = await r.post("take-over", { cookie: r.AUTH.cookie, "x-crow-csrf": "tok" });
    assert.equal(offNet.status, 403, "no Serve headers: off the network");
    assert.equal(r.ctl.state(), "idle", "nothing refused reached the controller");
    assert.deepEqual(r.held, []);

    // a stale link: no live turn using the browser in that chat → 409, nothing taken
    for (const sid of ["perchlive-22222222", "", undefined]) {
      const stale = await r.post("take-over", r.AUTH, { from: "link", sid });
      assert.deepEqual(stale, { status: 409, body: { error: "no_live_turn" } });
    }
    assert.equal(r.ctl.state(), "idle");
    assert.deepEqual(r.held, []);
    assert.deepEqual((await r.post("take-over", r.AUTH, { from: "link", sid: "perchlive-11111111" })).body, { state: "held" }, "a live turn's link takes it");
    assert.deepEqual((await r.post("hand-back")).body, { state: "idle" });
    r.held.length = 0;
    const take = await r.post("take-over");
    assert.equal(take.status, 200);
    const stateOf = async (headers) => { const x = await fetch(r.base + "state", { headers, redirect: "manual" }); return { status: x.status, body: await x.json().catch(() => null) }; };
    assert.deepEqual(await stateOf(r.AUTH), { status: 200, body: { state: "held" } }, "GET state (no CSRF needed for a read)");
    assert.notEqual((await stateOf({ ...serveHeaders(), cookie: "crow_csrf=tok" })).status, 200, "no session: refused");
    assert.equal((await stateOf({ ...r.AUTH, "tailscale-funnel-request": "?1" })).status, 403, "Funnel: refused");
    assert.deepEqual(take.body, { state: "held" });
    assert.deepEqual((await r.post("heartbeat")).body, { state: "held" });
    assert.deepEqual((await r.post("hand-back")).body, { state: "idle" });
    assert.deepEqual((await r.post("heartbeat")).body, { state: "idle" });
    assert.deepEqual(r.held, [true, false]);

    // pending while a bot call is in flight
    const bot = { kind: "bot", sessionId: "perchlive-aaaa0003", botId: null };
    await lease.acquire(r.dir, bot, { now: r.clock.now() });
    await lease.beginCall(r.dir, bot, { callId: "c1", pid: process.pid, now: r.clock.now() });
    assert.deepEqual((await r.post("take-over")).body, { state: "pending" });
    assert.deepEqual((await r.post("hand-back")).body, { state: "idle" });

    // a jammed lock: 503 browser_busy, quickly
    const fd = openSync(join(r.dir, lease.LOCK_NAME), "wx", 0o600); writeSync(fd, process.pid + "\n"); closeSync(fd);
    const t0 = Date.now();
    const warned = [];
    const realWarn = console.warn;
    console.warn = (...a) => warned.push(a.join(" "));
    let busy;
    try { busy = await r.post("take-over"); } finally { console.warn = realWarn; }
    assert.deepEqual(warned, ["[perch-interactive-api] browser takeOver: ELEASELOCKED"], "a code, nothing else");
    assert.equal(busy.status, 503);
    assert.deepEqual(busy.body, { error: "browser_busy" });
    assert.ok(Date.now() - t0 < 5000);
    rmSync(join(r.dir, lease.LOCK_NAME));
    // no browser bundle here: 404
    r.engine.browserTakeOver = null;
    assert.equal((await r.post("take-over")).status, 404);
    r.engine.browserTakeOver = takeOverMod.createTakeOver({ dir: () => null, onHeld: () => {} });
    assert.deepEqual((await r.post("take-over")), { status: 404, body: { error: "no_browser" } });
  } finally { r.ctl.close(); await r.close(); }
});

// ---------------------------------------------------------------------------
// the Browser panel
// ---------------------------------------------------------------------------
test("the Browser panel shows \"A bot is using the browser\" with Take over while a bot holds the lease", async () => {
  const home = join(dir, "panel-home");
  mkdirSync(join(home, "bundles", "browser"), { recursive: true });
  symlinkSync(join(REPO, "bundles", "browser", "server"), join(home, "bundles", "browser", "server"));
  // this instance's browser: a container name that does not exist, a closed port (no real docker or CDP is touched)
  writeFileSync(join(home, "bundles", "browser", ".env"), "CROW_BROWSER_CONTAINER_NAME=crow-take-over-test-none\nCROW_BROWSER_CDP_PORT=1\n");
  const prevHome = process.env.CROW_HOME, prevPath = process.env.PATH;
  process.env.CROW_HOME = home;
  const noTools = join(dir, "no-tools"); mkdirSync(noTools, { recursive: true });
  process.env.PATH = noTools;   // the panel's docker/curl probes find nothing: no real container is asked
  try {
    const { default: panel, botHolding, takeOverHref } = await import("../bundles/browser/panel/browser.js");
    const render = async (lang = "en") => panel.handler({ query: {} }, {}, { db: null, appRoot: REPO, lang, layout: (o) => o.content });
    const leaseDirP = join(home, "browser-lease");
    let html = await render();
    assert.doesNotMatch(html, /browser-bot-using/, "free: no notice");
    const sid = "perchlive-0123abcd";
    await lease.acquire(leaseDirP, { kind: "bot", sessionId: sid, botId: "botty" }, { now: Date.now() });
    html = await render();
    assert.match(html, /class="browser-bot-using"/);
    assert.match(html, /A bot is using the browser/);
    assert.match(html, new RegExp('href="/dashboard/perch\\?take-over=1#' + sid + '">Take over</a>'));
    assert.doesNotMatch(html, /<iframe/, "no viewer behind the bot's back");
    html = await render("es");
    assert.match(html, /Un bot está usando el navegador/);
    assert.match(html, />Tomar el control</);
    // an external holder: the sheet alone
    assert.equal(takeOverHref({ sessionId: "external:123" }), "/dashboard/perch?take-over=panel");
    assert.equal(takeOverHref({ sessionId: "perchlive-0123abcd\"><x" }), "/dashboard/perch?take-over=panel");
    // the operator's own holding, or an expired one: no notice
    await lease.takeOperator(leaseDirP, { now: Date.now() });
    assert.doesNotMatch(await render(), /browser-bot-using/);
    assert.equal(botHolding({ holder: { kind: "bot", sessionId: "s" } }, () => true), null, "a free (expired) lease");
    assert.equal(botHolding(null, lease.isFree), null);
    // the gateway's in-memory state says the operator holds it: "You have the browser" + Hand back
    const pi = await import("../servers/gateway/perch-interactive.js");
    let st = "held";
    pi._setInteractiveEngineForTest({ browserTakeOver: { state: () => st } });
    try {
      html = await render();
      assert.match(html, /class="browser-operator-has"/);
      assert.match(html, /You have the browser/);
      assert.match(html, /<button type="button" id="browser-hand-back"[^>]*>Hand back<\/button>/);
      assert.match(await render("es"), /Tienes tú el navegador[\s\S]*>Devolver</);
      st = "pending";
      assert.match(await render(), /browser-operator-has/);
      st = "idle";
      assert.doesNotMatch(await render(), /browser-operator-has/, "idle: nothing");
      // the file alone (a forged operator holding) never shows it
      pi._setInteractiveEngineForTest(null);
      assert.doesNotMatch(await render(), /browser-operator-has/);
    } finally { pi._setInteractiveEngineForTest(null); }
    // tap → the hand-back route with the CSRF header, then a reload
    const { HAND_BACK_JS } = await import("../bundles/browser/panel/browser.js");
    assert.equal(/`|\$\{/.test(HAND_BACK_JS), false);
    const vm = await import("node:vm");
    const btn = { disabled: false, l: null, addEventListener(t, f) { this.l = f; } };
    const fetched = []; let reloaded = 0;
    const ctx = { document: { getElementById: (id) => (id === "browser-hand-back" ? btn : null), cookie: "a=1; crow_csrf=tk%3D" },
      fetch: (u, o) => { fetched.push({ u, o }); return Promise.resolve({ ok: true }); }, location: { reload: () => { reloaded++; } }, decodeURIComponent };
    vm.runInNewContext(HAND_BACK_JS, ctx);
    btn.l(); btn.l();
    await tick();
    assert.equal(fetched.length, 1, "one request for a double tap");
    assert.equal(fetched[0].u, "/dashboard/perch-api/browser/hand-back");
    assert.equal(fetched[0].o.method, "POST");
    assert.equal(fetched[0].o.headers["X-Crow-Csrf"], "tk=");
    assert.equal(reloaded, 1);
  } finally { process.env.CROW_HOME = prevHome; process.env.PATH = prevPath; }
});

test("the skill points the handoff at Take over in the chat", async () => {
  const { readFileSync } = await import("node:fs");
  const md = readFileSync(join(REPO, "bundles/browser/skills/crow-browser.md"), "utf8");
  const sec = md.slice(md.indexOf("## The human-in-the-loop rule"), md.indexOf("## Stealth"));
  assert.match(sec, /Take over/);
  assert.match(sec, /Hand back/);
  assert.doesNotMatch(sec, /VNC URL\)|localhost:6080/);
  assert.doesNotMatch(md, /VNC human-in-the-loop handoff/);
});
