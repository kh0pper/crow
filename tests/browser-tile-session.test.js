/**
 * Live browser tile, Task 3: Perch sessions own their browser lease and
 * announce the tile.
 *
 * The engine runs with a fake pi child (the perch-interactive.test.js idiom:
 * an injected bridge seam, injected clock + timers, a real init-db'd scratch
 * crow.db) and the REAL shared lease module on a scratch lease dir. The test
 * plays the browser MCP server's part by writing the lease the way it does
 * (acquire / beginCall with the session's own identity).
 *
 * One leg spawns a real PiRpc against a stub child (the bot-bash-auto-spawn
 * idiom, sandbox off) to prove the identity env survives the bridge's own
 * env assembly, not just the engine's extraEnv.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const k of Object.keys(process.env)) if (/^(PI_|PIBOT_)/.test(k)) delete process.env[k];
process.env.CROW_PI_SANDBOX = "off";

const dir = mkdtempSync(join(tmpdir(), "browser-tile-session-"));
process.env.CROW_DATA_DIR = dir;
process.env.CROW_HOME = join(dir, "home");
delete process.env.CROW_DB_PATH;
process.env.PI_MODELS_JSON = join(dir, "models.json");
const CROW_HOME = process.env.CROW_HOME;
const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

let createInteractiveEngine, _resetInteractiveEngineForTest;
let lease;   // servers/shared/browser-lease.js
let hooks;   // servers/gateway/browser-tile/session-hooks.js

// ---------------------------------------------------------------------------
// harness (trimmed from perch-interactive.test.js)
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
  };
}

const tick = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

let pidSeq = 800000;
function makeBridge() {
  const state = { instances: [] };
  class FakePi {
    constructor(o) {
      this.opts = o;
      this.onEvent = o.onEvent;
      this.turns = [];
      this.closed = 0;
      this.aborts = 0;
      this._exitCode = null;
      this.proc = { pid: ++pidSeq };
      this.piSessionId = "pisess-" + this.proc.pid;
      let done;
      this.exited = new Promise((r) => { done = r; });
      this._done = done;
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
    _state: state,
    PiRpc: FakePi,
    LIFECYCLE_DEFAULTS: { maxPi: 8 },
    countLivePi: () => 0,
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
    async warmModel() {},
    async meterTurn() { return { recorded: true }; },
    appendAudit() {},
  };
}

let leaseSeq = 0;
function makeEngine(o = {}) {
  const clock = makeClock();
  const bridge = makeBridge();
  const leaseDir = join(dir, "lease-" + (++leaseSeq));
  const env = Object.assign({ CROW_HOME }, o.env);
  const lines = [];
  const engine = createInteractiveEngine({
    crowHome: CROW_HOME, env, bridge,
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    log: (m) => lines.push(m),
    browserLease: o.browserLease === undefined ? { installed: true, dir: leaseDir, ...(o.isAlive ? { isAlive: o.isAlive } : {}) } : o.browserLease,
  });
  return { engine, clock, state: bridge._state, leaseDir, lines };
}

async function collect(engine, sessionId) {
  const events = [];
  await engine.subscribe(sessionId, (e) => events.push(e));
  return { events, browser: () => events.filter((e) => e.type === "browser") };
}

async function spawned(engine, botId = "botty") {
  const r = await engine.spawn({ botId });
  await tick();
  return r;
}

const holderOf = (sid, botId = "botty") => ({ kind: "bot", sessionId: sid, botId });
const NAV = "mcp__browser__crow_browser_navigate";

/** The MCP server's part: take the lease for the session at the engine clock. */
async function mcpAcquire(h, sid, botId) {
  const r = await lease.acquire(h.leaseDir, holderOf(sid, botId), { now: h.clock.now() });
  assert.equal(r.ok, true, "the fake MCP server got the lease");
  return r.lease;
}

/** A turn that made one browser call (c1) and holds the lease: live emitted. */
async function liveTurn(h, opts = {}) {
  const s = await spawned(h.engine);
  const sink = await collect(h.engine, s.sessionId);
  await h.engine.message(s.sessionId, "browse");
  const pi = h.state.instances[0];
  pi.emit({ type: "tool_execution_start", toolName: NAV, toolCallId: "c1", args: { url: "https://example.test/" } });
  await mcpAcquire(h, s.sessionId);
  if (opts.inCallPid) await lease.beginCall(h.leaseDir, holderOf(s.sessionId), { callId: "c1", pid: opts.inCallPid, now: h.clock.now() });
  else pi.emit({ type: "tool_execution_end", toolName: NAV, toolCallId: "c1", isError: false, result: { content: [] } });
  await tick();
  if (opts.inCallPid) {
    // The call is still running: the gateway learns of the holding from its watcher hook.
    h.engine.browserLeaseChanged(await lease.readLease(h.leaseDir));
    await tick();
  }
  assert.equal(sink.browser().filter((e) => e.phase === "live").length, 1, "the tile went live");
  return { s, sink, pi };
}

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: REPO });
  mkdirSync(CROW_HOME, { recursive: true });
  writeFileSync(process.env.PI_MODELS_JSON, JSON.stringify({ providers: { "crow-local": { models: [{ id: "qwen3.6-35b-a3b" }] } } }));
  const mod = await import("../servers/gateway/perch-interactive.js");
  createInteractiveEngine = mod.createInteractiveEngine;
  _resetInteractiveEngineForTest = mod._resetInteractiveEngineForTest;
  lease = await import("../servers/shared/browser-lease.js");
  hooks = await import("../servers/gateway/browser-tile/session-hooks.js");
});

beforeEach(() => { if (_resetInteractiveEngineForTest) _resetInteractiveEngineForTest(); });
after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

const END = { type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] };

// ---------------------------------------------------------------------------

test("the child gets PI_BOT_PERCH_SESSION_ID and PI_BOT_ID", async () => {
  const h = makeEngine();
  const s = await spawned(h.engine, "botty");
  const env = h.state.instances[0].opts.extraEnv;
  assert.equal(env.PI_BOT_PERCH_SESSION_ID, s.sessionId);
  assert.equal(env.PI_BOT_ID, "botty");
  assert.equal(env.PI_BOT_INTERACTIVE, "1", "the existing unlock is kept");
});

test("the identity env survives the bridge's env assembly; a bot def cannot set it", async () => {
  const { PiRpc } = await import("../scripts/pi-bots/bridge.mjs");
  const d = mkdtempSync(join(tmpdir(), "browser-tile-spawn-"));
  mkdirSync(join(d, "sessions"), { recursive: true });
  const out = join(d, "env.json");
  const stub = join(d, "stub-pi.mjs");
  writeFileSync(stub, [
    'import { writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(out)}, JSON.stringify({ sid: process.env.PI_BOT_PERCH_SESSION_ID ?? null, bot: process.env.PI_BOT_ID ?? null }));`,
    "setTimeout(() => process.exit(0), 50);",
  ].join("\n"));
  const run = async (def, extraEnv) => {
    rmSync(out, { force: true });
    const pi = new PiRpc({ def, sessionDir: d, resolved: { provider: "p", model: "m", key: "p/m" }, nodeBin: process.execPath, cliPath: stub, extraEnv, diagLog: () => {} });
    await new Promise((r) => pi.proc.on("exit", r));
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(existsSync(out), "stub ran");
    return JSON.parse(readFileSync(out, "utf8"));
  };
  const perch = await run({ permission_policy: { bash: "deny", write_paths: [] } },
    { PI_BOT_INTERACTIVE: "1", PI_BOT_PERCH_SESSION_ID: "perchlive-abcd1234", PI_BOT_ID: "botty" });
  assert.deepEqual(perch, { sid: "perchlive-abcd1234", bot: "botty" });
  const said = [];
  const realError = console.error;
  console.error = (...a) => said.push(a.join(" "));
  let forged;
  try {
    forged = await run({ permission_policy: { bash: "deny", write_paths: [] }, spawn_env: { PI_BOT_PERCH_SESSION_ID: "perchlive-stolen00", PI_BOT_ID: "other" } }, {});
  } finally { console.error = realError; }
  assert.deepEqual(forged, { sid: null, bot: null }, "a channel bot's spawn_env cannot claim a Perch session");
  assert.ok(said.some((l) => /stripped engine-reserved spawn_env keys.*PI_BOT_PERCH_SESSION_ID, PI_BOT_ID/.test(l)));
  rmSync(d, { recursive: true, force: true });
});

test("isBrowserTool matches mcp__browser__crow_browser_navigate and router mcp__browser with args.tool crow_browser_click; not crow_browser-like names on another server", () => {
  const { isBrowserTool } = hooks;
  assert.equal(isBrowserTool("mcp__browser__crow_browser_navigate", null), true);
  assert.equal(isBrowserTool("mcp__crow-browser__crow_browser_screenshot", undefined), true);
  assert.equal(isBrowserTool("mcp__browser", { action: "call", tool: "crow_browser_click", args: {} }), true);
  assert.equal(isBrowserTool("mcp__browser", JSON.stringify({ action: "call", tool: "crow_browser_click" })), true, "argsText form");
  // not browser calls
  assert.equal(isBrowserTool("mcp__other__crow_browserish", null), false);
  assert.equal(isBrowserTool("mcp__other__my_crow_browser_navigate", null), false);
  assert.equal(isBrowserTool("crow_browser_navigate", null), false, "no mcp prefix");
  assert.equal(isBrowserTool("mcp__other", { tool: "crow_browserx" }), false);
  assert.equal(isBrowserTool("mcp__other", { tool: "not_crow_browser_click" }), false);
  assert.equal(isBrowserTool("mcp__browser", { action: "list" }), false, "a router list call is not a browser action");
  assert.equal(isBrowserTool("mcp__browser", "{not json"), false, "malformed args are not a browser call");
  assert.equal(isBrowserTool("mcp__browser", "[1,2]"), false);
  assert.equal(isBrowserTool("bash", { tool: "crow_browser_click" }), false);
  assert.equal(isBrowserTool(null, null), false);
});

test("live is emitted only when this live session with s.turn holds the lease", async () => {
  const h = makeEngine();
  const s = await spawned(h.engine);
  const sink = await collect(h.engine, s.sessionId);
  await h.engine.message(s.sessionId, "browse");
  const pi = h.state.instances[0];
  // a non-browser tool first: it is never the anchor
  pi.emit({ type: "tool_execution_start", toolName: "bash", toolCallId: "b0", args: { command: "ls" } });
  pi.emit({ type: "tool_execution_end", toolName: "bash", toolCallId: "b0", isError: false });
  pi.emit({ type: "tool_execution_start", toolName: NAV, toolCallId: "c1", args: {} });
  // another bot holds the lease: this session's call was refused "busy"
  await lease.acquire(h.leaseDir, holderOf("perchlive-other000", "other"), { now: h.clock.now() });
  pi.emit({ type: "tool_execution_end", toolName: NAV, toolCallId: "c1", isError: false });
  await tick();
  assert.equal(sink.browser().length, 0, "a bot that got busy never lights a tile");
  await lease.release(h.leaseDir, "perchlive-other000", { now: h.clock.now() });

  // the session's second browser call gets the lease
  pi.emit({ type: "tool_execution_start", toolName: "mcp__browser", toolCallId: "c2", args: { action: "call", tool: "crow_browser_click", args: {} } });
  const l = await mcpAcquire(h, s.sessionId);
  pi.emit({ type: "tool_execution_end", toolName: "mcp__browser", toolCallId: "c2", isError: false });
  await tick();
  const live = sink.browser();
  assert.equal(live.length, 1);
  assert.deepEqual(live[0], { type: "browser", phase: "live", anchor: "c1", domain: null, gen: l.gen },
    "the anchor is the turn's FIRST browser toolCallId");
  const rec = h.engine._sessionRecordForTest(s.sessionId).browser;
  assert.equal(rec.anchor, "c1");
  assert.equal(rec.gen, l.gen);
  assert.equal(rec.domain, null);

  // a further browser call on the same holding re-emits nothing
  pi.emit({ type: "tool_execution_start", toolName: NAV, toolCallId: "c3", args: {} });
  pi.emit({ type: "tool_execution_end", toolName: NAV, toolCallId: "c3", isError: false });
  await tick();
  assert.equal(sink.browser().length, 1);

  // the watcher hook (Task 5) brings the domain: one more live frame
  h.engine.browserLeaseChanged(await lease.readLease(h.leaseDir), { domain: "example.test" });
  await tick();
  assert.equal(sink.browser().length, 2);
  assert.equal(sink.browser()[1].domain, "example.test");

  // a late subscriber sees the live tile replayed
  const late = await collect(h.engine, s.sessionId);
  assert.equal(late.browser().length, 1);
  assert.equal(late.browser()[0].phase, "live");
});

test("renewal at most once per 10 s during a streaming turn", async () => {
  const h = makeEngine();
  const { pi } = await liveTurn(h);
  const t0 = (await lease.readLease(h.leaseDir)).renewedAt;
  const msg = () => pi.emit({ type: "message_update", message: { role: "assistant", content: [] } });
  for (let i = 0; i < 9; i++) { h.clock.advance(1000); msg(); await tick(); }
  assert.equal((await lease.readLease(h.leaseDir)).renewedAt, t0, "no renewal inside 10 s");
  h.clock.advance(1000); msg(); await tick();
  const t1 = (await lease.readLease(h.leaseDir)).renewedAt;
  assert.equal(t1, t0 + 10_000, "renewed at 10 s");
  h.clock.advance(4000); msg(); msg(); msg(); await tick();
  assert.equal((await lease.readLease(h.leaseDir)).renewedAt, t1);

  // the gateway never TAKES a free lease: it only renews its own
  await lease.release(h.leaseDir, (await lease.readLease(h.leaseDir)).holder.sessionId, { now: h.clock.now() });
  h.clock.advance(20_000); msg(); await tick();
  const after = await lease.readLease(h.leaseDir);
  assert.equal(after.holder, null, "a released lease stays free");
});

test("turn end releases; a live in-call pid defers (releaseOnCallEnd)", async () => {
  {
    const h = makeEngine();
    const { s, sink, pi } = await liveTurn(h);
    pi.lastTurn().resolve(END);
    await tick();
    const l = await lease.readLease(h.leaseDir);
    assert.equal(l.holder, null, "released at turn end");
    const done = sink.browser().filter((e) => e.phase === "done");
    assert.equal(done.length, 1);
    assert.deepEqual(done[0], { type: "browser", phase: "done", anchor: "c1", domain: null, shot: null, note: null });
    const order = sink.events.map((e) => e.type === "browser" ? "browser:" + e.phase : e.type).filter((t) => t === "reply" || t === "browser:done");
    assert.deepEqual(order, ["reply", "browser:done"], "done follows the reply");
    assert.equal(h.engine._sessionRecordForTest(s.sessionId).browser, null);
  }
  {
    const h = makeEngine({ isAlive: (pid) => pid === 4242 });
    const { pi } = await liveTurn(h, { inCallPid: 4242 });
    pi.lastTurn().resolve(END);
    await tick();
    const l = await lease.readLease(h.leaseDir);
    assert.equal(l.holder.sessionId.startsWith("perchlive-"), true, "still held while the call runs");
    assert.equal(l.releaseOnCallEnd, true, "the release is deferred to the call's end");
  }
});

test("the aborted early return releases (and defers for a live in-call pid)", async () => {
  {
    const h = makeEngine();
    const { s, sink, pi } = await liveTurn(h);
    await h.engine.abort(s.sessionId);
    pi.lastTurn().resolve({ type: "agent_end", stopReason: "aborted", messages: [] });
    await tick();
    assert.equal((await lease.readLease(h.leaseDir)).holder, null);
    assert.equal(sink.browser().filter((e) => e.phase === "done").length, 1);
  }
  {
    const h = makeEngine({ isAlive: (pid) => pid === 4243 });
    const { s, pi } = await liveTurn(h, { inCallPid: 4243 });
    await h.engine.abort(s.sessionId);
    pi.lastTurn().resolve({ type: "agent_end", stopReason: "aborted", messages: [] });
    await tick();
    assert.equal((await lease.readLease(h.leaseDir)).releaseOnCallEnd, true);
  }
});

test("onTurnError releases, both the refused-prompt and the abandoned-child branches", async () => {
  for (const code of ["prompt_refused", null]) {
    const h = makeEngine();
    const { sink, pi } = await liveTurn(h);
    const err = new Error(code ? "prompt refused" : "timeout:prompt-ack");
    if (code) err.code = code;
    pi.lastTurn().reject(err);
    await tick();
    assert.equal((await lease.readLease(h.leaseDir)).holder, null, "released (" + (code || "abandon") + ")");
    assert.equal(sink.browser().filter((e) => e.phase === "done").length, 1, "exactly one done (" + (code || "abandon") + ")");
  }
  const h = makeEngine({ isAlive: (pid) => pid === 4244 });
  const { pi } = await liveTurn(h, { inCallPid: 4244 });
  pi.lastTurn().reject(new Error("timeout:prompt-ack"));
  await tick();
  assert.equal((await lease.readLease(h.leaseDir)).releaseOnCallEnd, true, "deferred while the pid lives");
});

test("abandonChild (abort grace) and close (stop, hibernate, child exit, stopAll) release", async () => {
  {
    const h = makeEngine();
    const { s, sink } = await liveTurn(h);
    await h.engine.abort(s.sessionId);
    h.clock.advance(30_001);                       // no agent_end: the child is abandoned
    await tick();
    assert.equal(h.state.instances[0].closed, 1);
    assert.equal((await lease.readLease(h.leaseDir)).holder, null, "abandonChild");
    assert.equal(sink.browser().filter((e) => e.phase === "done").length, 1);
  }
  {
    const h = makeEngine();
    const { s, sink } = await liveTurn(h);
    await h.engine.stop(s.sessionId);
    await tick();
    assert.equal((await lease.readLease(h.leaseDir)).holder, null, "stop");
    assert.equal(sink.browser().filter((e) => e.phase === "done").length, 1);
  }
  {
    const h = makeEngine({ isAlive: (pid) => pid === 4245 });
    const { s } = await liveTurn(h, { inCallPid: 4245 });
    await h.engine.stop(s.sessionId);
    await tick();
    assert.equal((await lease.readLease(h.leaseDir)).releaseOnCallEnd, true, "stop defers for a live in-call pid");
  }
  {
    const h = makeEngine();
    const { sink, pi } = await liveTurn(h);
    pi.exit(1);                                    // the child dies mid-turn
    await tick();
    assert.equal((await lease.readLease(h.leaseDir)).holder, null, "child exit");
    assert.equal(sink.browser().filter((e) => e.phase === "done").length, 1);
  }
  {
    const h = makeEngine();
    await liveTurn(h);
    await h.engine.stopAll({ timeoutMs: 2000 });
    await tick();
    assert.equal((await lease.readLease(h.leaseDir)).holder, null, "stopAll");
  }
  {
    // hibernate (idle close) after a turn whose lease was left held (a call the
    // gateway did not recognise): released on close too.
    const h = makeEngine();
    const s = await spawned(h.engine);
    await mcpAcquire(h, s.sessionId);
    await h.engine._hibernateForTest(s.sessionId);
    await tick();
    assert.equal((await lease.readLease(h.leaseDir)).holder, null, "hibernate");
  }
});

test("the stall watchdog is suspended while the operator holds the lease", async () => {
  const h = makeEngine({ env: { PERCH_TURN_STALL_MS: "1000" } });
  const s = await spawned(h.engine);
  const sink = await collect(h.engine, s.sessionId);
  await h.engine.message(s.sessionId, "browse");
  const pi = h.state.instances[0];
  await lease.takeOperator(h.leaseDir, { now: h.clock.now() });
  h.engine.browserOperator(true);
  h.clock.advance(5000);
  pi.emit({ type: "message_update", message: { role: "assistant", content: [] } });   // touchStall must not re-arm it
  h.clock.advance(5000);
  await tick();
  assert.equal(sink.events.filter((e) => e.type === "error").length, 0, "no stall while the operator has the browser");
  assert.equal(pi.aborts, 0);
  await lease.handBack(h.leaseDir);
  h.engine.browserOperator(false);
  h.clock.advance(1001);
  await tick();
  assert.ok(sink.events.some((e) => e.type === "error" && /stall/.test(e.text)), "re-armed once the operator lease ends");
});

test("restart: no live tile without a live turn", async () => {
  const h = makeEngine();
  const s = await spawned(h.engine);
  const sink = await collect(h.engine, s.sessionId);
  // a lease left by a previous gateway naming a session that does not exist
  await lease.acquire(h.leaseDir, holderOf("perchlive-dead0000"), { now: h.clock.now() });
  h.engine.browserLeaseChanged(await lease.readLease(h.leaseDir), { domain: "example.test" });
  await tick();
  // a lease naming this session, which has no turn
  await lease.release(h.leaseDir, "perchlive-dead0000", { now: h.clock.now() });
  await mcpAcquire(h, s.sessionId);
  h.engine.browserLeaseChanged(await lease.readLease(h.leaseDir));
  await tick();
  assert.equal(sink.browser().length, 0);
  const late = await collect(h.engine, s.sessionId);
  assert.equal(late.browser().length, 0, "a reload shows no live tile");
  // the next turn's end frees what the old one left behind
  await h.engine.message(s.sessionId, "hi");
  h.state.instances[0].lastTurn().resolve(END);
  await tick();
  assert.equal((await lease.readLease(h.leaseDir)).holder, null);
  assert.equal(sink.browser().length, 0, "no tile ever lit, so no done either");
});

test("done carries note \"operator\" and no shot when the operator held it at turn end", async () => {
  const h = makeEngine();
  let shots = 0;
  h.engine.browserHooks.finalShot = async () => { shots += 1; return { id: 7, url: "/x/7" }; };
  const { sink, pi } = await liveTurn(h);
  await lease.takeOperator(h.leaseDir, { now: h.clock.now() });
  h.engine.browserOperator(true);
  pi.lastTurn().resolve(END);
  await tick();
  const done = sink.browser().filter((e) => e.phase === "done");
  assert.deepEqual(done, [{ type: "browser", phase: "done", anchor: "c1", domain: null, shot: null, note: "operator" }]);
  assert.equal(shots, 0, "no shot is taken while the operator has the browser");
  const l = await lease.readLease(h.leaseDir);
  assert.equal(l.holder.kind, "operator", "turn end never frees the operator's holding");

  // without the operator, the hook's shot rides the done frame, and it ran
  // before the lease was released (the bot still held the page)
  const h2 = makeEngine();
  let heldDuringShot = null;
  h2.engine.browserHooks.finalShot = async (ctx) => {
    heldDuringShot = hooks.heldBySession(await lease.readLease(h2.leaseDir), ctx.sessionId, h2.clock.now());
    assert.equal(ctx.operatorTook, false);
    assert.equal(typeof ctx.genAtEnd, "number");
    return { id: 9, url: "/files/9" };
  };
  const r2 = await liveTurn(h2);
  r2.pi.lastTurn().resolve(END);
  await tick();
  assert.equal(heldDuringShot, true);
  assert.deepEqual(r2.sink.browser().filter((e) => e.phase === "done")[0].shot, { id: 9, url: "/files/9" });
});

test("no browser bundle on this instance: no lease I/O and no tile", async () => {
  const h = makeEngine({ browserLease: { installed: false, dir: join(dir, "never") } });
  const s = await spawned(h.engine);
  const sink = await collect(h.engine, s.sessionId);
  await h.engine.message(s.sessionId, "browse");
  const pi = h.state.instances[0];
  pi.emit({ type: "tool_execution_start", toolName: NAV, toolCallId: "c1", args: {} });
  pi.emit({ type: "tool_execution_end", toolName: NAV, toolCallId: "c1", isError: false });
  pi.lastTurn().resolve(END);
  await tick();
  assert.equal(existsSync(join(dir, "never")), false);
  assert.equal(sink.browser().length, 0);
  // and the default resolution reads this instance's installed.json
  assert.equal(hooks.browserInstalled(CROW_HOME), false);
  writeFileSync(join(CROW_HOME, "installed.json"), JSON.stringify([{ id: "browser", type: "bundle" }]));
  assert.equal(hooks.browserInstalled(CROW_HOME), true);
  rmSync(join(CROW_HOME, "installed.json"));
});

test("a locked lease never breaks a turn, and nothing logged names a URL", async () => {
  const h = makeEngine();
  const { pi, sink } = await liveTurn(h);
  // a bot plants a lock naming a live pid: gateway writes give up (ELEASELOCKED)
  writeFileSync(join(h.leaseDir, "lease.lock"), "1\n");
  h.clock.advance(10_000);
  pi.emit({ type: "message_update", message: { role: "assistant", content: [] } });
  await new Promise((r) => setTimeout(r, 2300));   // the 2 s lock wait (real clock)
  pi.lastTurn().resolve(END);
  await new Promise((r) => setTimeout(r, 2300));
  await tick();
  assert.equal(sink.events.filter((e) => e.type === "reply").length, 1, "the turn still ended");
  assert.equal(sink.browser().filter((e) => e.phase === "done").length, 1, "done still emitted");
  assert.ok(h.lines.some((l) => /ELEASELOCKED/.test(l)), "logged as a code");
  assert.ok(!h.lines.some((l) => /example\.test|https?:/.test(l)), "no URL or host in the log");
});
