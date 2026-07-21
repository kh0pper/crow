// C4 Task 6 — servers/gateway/bot-runtime.js: the gateway-supervised bot
// runtime (bridge-tick interval + Discord child), both gated by the SAME
// bot_runtime feature flag every standalone pi-bots runner respects
// (runtime-gate.mjs). All seams (db conn, runBridgeTick, superviseProcess,
// bus, timers, pollMs) are injected so nothing here spawns a real process,
// touches the real event bus, or waits on a real clock longer than a few ms.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import Database from "better-sqlite3";

import {
  initBotRuntime,
  botRuntimeStatus,
  _resetBotRuntimeForTest,
} from "../servers/gateway/bot-runtime.js";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function makeConn() {
  const d = new Database(":memory:");
  d.exec(`
    CREATE TABLE dashboard_settings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE dashboard_settings_overrides (
      key TEXT, instance_id TEXT, value TEXT,
      updated_at TEXT DEFAULT (datetime('now')), lamport_ts INTEGER DEFAULT 0,
      PRIMARY KEY(key, instance_id)
    );
    CREATE TABLE pi_bot_defs (
      bot_id TEXT PRIMARY KEY, display_name TEXT, definition TEXT,
      project_id INTEGER, enabled INTEGER DEFAULT 1,
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
  return d;
}

function setFlag(conn, enabled) {
  conn.prepare(
    "INSERT INTO dashboard_settings (key, value) VALUES ('feature_flags', ?) " +
    "ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).run(JSON.stringify({ bot_runtime: enabled }));
}

function upsertBot(conn, botId, gateways, enabled = 1) {
  conn.prepare(
    "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES (?,?,?,?) " +
    "ON CONFLICT(bot_id) DO UPDATE SET definition=excluded.definition, enabled=excluded.enabled"
  ).run(botId, botId, JSON.stringify({ gateways }), enabled);
}

function removeBot(conn, botId) {
  conn.prepare("DELETE FROM pi_bot_defs WHERE bot_id=?").run(botId);
}

function discordGw(token, extra = {}) {
  return [{ type: "discord", token, guild_id: "g1", channel_ids: ["c1"], allowlist: ["u1"], ...extra }];
}

/** Fake setInterval/clearInterval/setTimeout/clearTimeout: records + lets the
 * test invoke scheduled callbacks manually — no real waiting for anything
 * bot-runtime schedules itself (bridge interval, reconcile debounce). */
function fakeTimers() {
  let nextId = 1;
  const intervals = new Map();
  const timeouts = new Map();
  return {
    setIntervalFn: (fn, ms) => { const id = nextId++; intervals.set(id, { fn, ms }); return id; },
    clearIntervalFn: (id) => intervals.delete(id),
    setTimeoutFn: (fn, ms) => { const id = nextId++; timeouts.set(id, { fn, ms }); return id; },
    clearTimeoutFn: (id) => timeouts.delete(id),
    intervals,
    timeouts,
    lastInterval: () => [...intervals.values()].at(-1),
    lastTimeout: () => [...timeouts.values()].at(-1),
  };
}

function fakeSuperviseProcess() {
  const calls = [];
  const handles = [];
  const fn = (opts) => {
    calls.push(opts);
    const handle = {
      key: opts.key,
      live: true,
      state: "running",
      restartCount: 0,
      lastError: null,
      stopCalls: 0,
      stop: async function stop() {
        this.stopCalls++;
        this.live = false;
        this.state = "stopped";
        return Promise.resolve();
      },
    };
    handles.push(handle);
    return handle;
  };
  return { fn, calls, handles };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let conns = [];
function trackConn(c) { conns.push(c); return c; }

beforeEach(() => {
  _resetBotRuntimeForTest();
  conns = [];
});
afterEach(() => {
  _resetBotRuntimeForTest();
  for (const c of conns) { try { c.close(); } catch {} }
});

// ---------------------------------------------------------------------------
// mode resolution
// ---------------------------------------------------------------------------

test("disabled mode: CROW_DISABLE_BOT_RUNTIME=1 no-ops, status reports disabled/unarmed", async () => {
  const r = await initBotRuntime({ env: { CROW_DISABLE_BOT_RUNTIME: "1" } });
  assert.equal(r.mode, "disabled");
  const status = botRuntimeStatus();
  assert.equal(status.mode, "disabled");
  assert.equal(status.bridge.armed, false);
  assert.equal(status.discord.running, false);
});

test("external mode: PIBOT_SUPERVISOR=external no-ops (host systemd manages it)", async () => {
  const r = await initBotRuntime({ env: { PIBOT_SUPERVISOR: "external" } });
  assert.equal(r.mode, "external");
  const status = botRuntimeStatus();
  assert.equal(status.mode, "external");
  assert.equal(status.bridge.armed, false);
  assert.equal(status.discord.running, false);
});

test("env is read from the injected object, never process.env — a clean env with the real process.env carrying CROW_DISABLE_BOT_RUNTIME still runs gateway mode", async () => {
  const prev = process.env.CROW_DISABLE_BOT_RUNTIME;
  process.env.CROW_DISABLE_BOT_RUNTIME = "1"; // simulates running under run-suite.mjs
  try {
    const conn = trackConn(makeConn());
    setFlag(conn, false);
    const timers = fakeTimers();
    const r = await initBotRuntime({
      env: {}, // clean injected env — no CROW_DISABLE_BOT_RUNTIME here
      _conn: conn,
      _superviseProcess: fakeSuperviseProcess().fn,
      _setIntervalFn: timers.setIntervalFn,
      _clearIntervalFn: timers.clearIntervalFn,
      _setTimeoutFn: timers.setTimeoutFn,
      _clearTimeoutFn: timers.clearTimeoutFn,
      _bus: new EventEmitter(),
      _pollMs: 10,
    });
    assert.equal(r.mode, "gateway");
  } finally {
    if (prev === undefined) delete process.env.CROW_DISABLE_BOT_RUNTIME;
    else process.env.CROW_DISABLE_BOT_RUNTIME = prev;
  }
});

// ---------------------------------------------------------------------------
// gateway mode: bridge interval arms + ticks call the lib
// ---------------------------------------------------------------------------

test("gateway mode: flag on arms the bridge interval and each fire calls runBridgeTick", async () => {
  const conn = trackConn(makeConn());
  setFlag(conn, true);
  const timers = fakeTimers();
  let tickCalls = 0;
  const runBridgeTick = async () => { tickCalls++; return { ok: true, bots: 0, handled: 0, errors: [] }; };

  await initBotRuntime({
    env: {},
    _conn: conn,
    _runBridgeTick: runBridgeTick,
    _superviseProcess: fakeSuperviseProcess().fn,
    _setIntervalFn: timers.setIntervalFn,
    _clearIntervalFn: timers.clearIntervalFn,
    _setTimeoutFn: timers.setTimeoutFn,
    _clearTimeoutFn: timers.clearTimeoutFn,
    _bus: new EventEmitter(),
    _pollMs: 10,
  });
  await wait(20); // let runtimeGate's boot tick call start()

  assert.equal(botRuntimeStatus().bridge.armed, true);
  const interval = timers.lastInterval();
  assert.ok(interval, "an interval was scheduled");
  assert.equal(interval.ms, 60000, "default PIBOT_BRIDGE_TICK_MS");

  await interval.fn();
  assert.equal(tickCalls, 1);
  await interval.fn();
  assert.equal(tickCalls, 2);
  assert.equal(botRuntimeStatus().bridge.lastResult.ok, true);
});

test("gateway mode: PIBOT_BRIDGE_TICK_MS overrides the default interval period", async () => {
  const conn = trackConn(makeConn());
  setFlag(conn, true);
  const timers = fakeTimers();
  await initBotRuntime({
    env: { PIBOT_BRIDGE_TICK_MS: "5000" },
    _conn: conn,
    _runBridgeTick: async () => ({ ok: true, bots: 0, handled: 0, errors: [] }),
    _superviseProcess: fakeSuperviseProcess().fn,
    _setIntervalFn: timers.setIntervalFn,
    _clearIntervalFn: timers.clearIntervalFn,
    _setTimeoutFn: timers.setTimeoutFn,
    _clearTimeoutFn: timers.clearTimeoutFn,
    _bus: new EventEmitter(),
    _pollMs: 10,
  });
  await wait(20);
  assert.equal(timers.lastInterval().ms, 5000);
});

test("busy guard: an overlapping fire while a tick is in flight is a no-op", async () => {
  const conn = trackConn(makeConn());
  setFlag(conn, true);
  const timers = fakeTimers();
  let tickCalls = 0;
  let resolveFirst;
  const runBridgeTick = async () => {
    tickCalls++;
    if (tickCalls === 1) return new Promise((res) => { resolveFirst = res; });
    return { ok: true, bots: 0, handled: 0, errors: [] };
  };

  await initBotRuntime({
    env: {},
    _conn: conn,
    _runBridgeTick: runBridgeTick,
    _superviseProcess: fakeSuperviseProcess().fn,
    _setIntervalFn: timers.setIntervalFn,
    _clearIntervalFn: timers.clearIntervalFn,
    _setTimeoutFn: timers.setTimeoutFn,
    _clearTimeoutFn: timers.clearTimeoutFn,
    _bus: new EventEmitter(),
    _pollMs: 10,
  });
  await wait(20);
  const interval = timers.lastInterval();

  const p1 = interval.fn(); // in flight, unresolved
  await wait(5);
  const p2 = interval.fn(); // overlapping fire — must be a no-op
  await p2;
  assert.equal(tickCalls, 1, "the overlapping fire never called runBridgeTick a second time");

  resolveFirst({ ok: true, bots: 0, handled: 0, errors: [] });
  await p1;

  await interval.fn(); // now safe to run again
  assert.equal(tickCalls, 2);
});

// ---------------------------------------------------------------------------
// breaker
// ---------------------------------------------------------------------------

test("breaker: opens after PIBOT_BREAKER_THRESHOLD consecutive failing ticks, then skips while cooling down", async () => {
  const conn = trackConn(makeConn());
  setFlag(conn, true);
  const timers = fakeTimers();
  let tickCalls = 0;
  const runBridgeTick = async () => {
    tickCalls++;
    return { ok: true, bots: 1, handled: 0, errors: ["boom " + tickCalls] };
  };

  await initBotRuntime({
    env: { PIBOT_BREAKER_THRESHOLD: "2", PIBOT_BREAKER_COOLDOWN_MS: "50000" },
    _conn: conn,
    _runBridgeTick: runBridgeTick,
    _superviseProcess: fakeSuperviseProcess().fn,
    _setIntervalFn: timers.setIntervalFn,
    _clearIntervalFn: timers.clearIntervalFn,
    _setTimeoutFn: timers.setTimeoutFn,
    _clearTimeoutFn: timers.clearTimeoutFn,
    _bus: new EventEmitter(),
    _pollMs: 10,
  });
  await wait(20);
  const interval = timers.lastInterval();

  await interval.fn(); // failure 1
  assert.equal(botRuntimeStatus().bridge.breaker.open, false);
  await interval.fn(); // failure 2 -> threshold reached
  const afterOpen = botRuntimeStatus().bridge.breaker;
  assert.equal(afterOpen.open, true);
  assert.match(afterOpen.lastError, /boom 2/);
  assert.ok(afterOpen.retryAt);

  await interval.fn(); // still cooling down (50s cooldown) — must skip, not call the lib
  assert.equal(tickCalls, 2, "ticks are skipped while the breaker is open and not past retryAt");
});

test("breaker: a thrown tick counts as a failure too", async () => {
  const conn = trackConn(makeConn());
  setFlag(conn, true);
  const timers = fakeTimers();
  const runBridgeTick = async () => { throw new Error("injected throw"); };

  await initBotRuntime({
    env: { PIBOT_BREAKER_THRESHOLD: "1", PIBOT_BREAKER_COOLDOWN_MS: "50000" },
    _conn: conn,
    _runBridgeTick: runBridgeTick,
    _superviseProcess: fakeSuperviseProcess().fn,
    _setIntervalFn: timers.setIntervalFn,
    _clearIntervalFn: timers.clearIntervalFn,
    _setTimeoutFn: timers.setTimeoutFn,
    _clearTimeoutFn: timers.clearTimeoutFn,
    _bus: new EventEmitter(),
    _pollMs: 10,
  });
  await wait(20);
  await timers.lastInterval().fn();
  const breaker = botRuntimeStatus().bridge.breaker;
  assert.equal(breaker.open, true);
  assert.match(breaker.lastError, /injected throw/);
});

test("breaker: half-open retry after cooldown — success closes it, failure keeps it open", async () => {
  const conn = trackConn(makeConn());
  setFlag(conn, true);
  const timers = fakeTimers();
  let shouldFail = true;
  let calls = 0;
  const runBridgeTick = async () => {
    calls++;
    if (shouldFail) return { ok: true, bots: 1, handled: 0, errors: ["still broken " + calls] };
    return { ok: true, bots: 1, handled: 1, errors: [] };
  };

  await initBotRuntime({
    env: { PIBOT_BREAKER_THRESHOLD: "1", PIBOT_BREAKER_COOLDOWN_MS: "20" },
    _conn: conn,
    _runBridgeTick: runBridgeTick,
    _superviseProcess: fakeSuperviseProcess().fn,
    _setIntervalFn: timers.setIntervalFn,
    _clearIntervalFn: timers.clearIntervalFn,
    _setTimeoutFn: timers.setTimeoutFn,
    _clearTimeoutFn: timers.clearTimeoutFn,
    _bus: new EventEmitter(),
    _pollMs: 10,
  });
  await wait(20);
  const interval = timers.lastInterval();

  await interval.fn(); // failure -> opens (threshold 1)
  assert.equal(botRuntimeStatus().bridge.breaker.open, true);
  assert.equal(calls, 1);

  await interval.fn(); // still within the 20ms cooldown -> skipped
  assert.equal(calls, 1);

  await wait(25); // cooldown elapses
  await interval.fn(); // half-open trial — still failing -> reopens with a fresh retryAt
  assert.equal(calls, 2);
  assert.equal(botRuntimeStatus().bridge.breaker.open, true);

  await wait(25);
  shouldFail = false;
  await interval.fn(); // half-open trial — now succeeds -> closes
  assert.equal(calls, 3);
  const closed = botRuntimeStatus().bridge.breaker;
  assert.equal(closed.open, false);
  assert.equal(closed.failures, 0);
  assert.equal(closed.lastError, null);
});

test("breaker: flag-off stop() resets it — stale failure state does not survive an off/on cycle", async () => {
  const conn = trackConn(makeConn());
  setFlag(conn, true);
  const timers = fakeTimers();
  const runBridgeTick = async () => ({ ok: true, bots: 1, handled: 0, errors: ["boom"] });

  await initBotRuntime({
    env: { PIBOT_BREAKER_THRESHOLD: "1", PIBOT_BREAKER_COOLDOWN_MS: "50000" },
    _conn: conn,
    _runBridgeTick: runBridgeTick,
    _superviseProcess: fakeSuperviseProcess().fn,
    _setIntervalFn: timers.setIntervalFn,
    _clearIntervalFn: timers.clearIntervalFn,
    _setTimeoutFn: timers.setTimeoutFn,
    _clearTimeoutFn: timers.clearTimeoutFn,
    _bus: new EventEmitter(),
    _pollMs: 10,
  });
  await wait(20);
  await timers.lastInterval().fn();
  assert.equal(botRuntimeStatus().bridge.breaker.open, true);

  setFlag(conn, false);
  await wait(30); // next poll observes inactive -> stop()

  const status = botRuntimeStatus();
  assert.equal(status.bridge.armed, false);
  assert.equal(status.bridge.breaker.open, false, "stop() resets the breaker");
  assert.equal(status.bridge.breaker.failures, 0);
});

// ---------------------------------------------------------------------------
// discord supervision
// ---------------------------------------------------------------------------

test("discord: the child is started only when an enabled bot has a discord gateway with a token", async () => {
  const conn = trackConn(makeConn());
  setFlag(conn, true);
  const timers = fakeTimers();
  const sp = fakeSuperviseProcess();

  await initBotRuntime({
    env: {},
    _conn: conn,
    _runBridgeTick: async () => ({ ok: true, bots: 0, handled: 0, errors: [] }),
    _superviseProcess: sp.fn,
    _setIntervalFn: timers.setIntervalFn,
    _clearIntervalFn: timers.clearIntervalFn,
    _setTimeoutFn: timers.setTimeoutFn,
    _clearTimeoutFn: timers.clearTimeoutFn,
    _bus: new EventEmitter(),
    _pollMs: 10,
  });
  await wait(20);
  assert.equal(sp.calls.length, 0, "no discord bots yet — child never started");
  assert.equal(botRuntimeStatus().discord.running, false);
});

test("discord: a discord-gateway bot at boot starts the child with the expected supervise args", async () => {
  const conn = trackConn(makeConn());
  setFlag(conn, true);
  upsertBot(conn, "botA", discordGw("tok-1"));
  const timers = fakeTimers();
  const sp = fakeSuperviseProcess();

  await initBotRuntime({
    env: {},
    _conn: conn,
    _runBridgeTick: async () => ({ ok: true, bots: 0, handled: 0, errors: [] }),
    _superviseProcess: sp.fn,
    _setIntervalFn: timers.setIntervalFn,
    _clearIntervalFn: timers.clearIntervalFn,
    _setTimeoutFn: timers.setTimeoutFn,
    _clearTimeoutFn: timers.clearTimeoutFn,
    _bus: new EventEmitter(),
    _pollMs: 10,
  });
  await wait(20);

  assert.equal(sp.calls.length, 1);
  const call = sp.calls[0];
  assert.equal(call.key, "pibot-discord");
  assert.equal(call.command, process.execPath);
  assert.equal(call.args.length, 1);
  assert.match(call.args[0], /discord_gateway\.mjs$/);
  assert.equal(call.maxRestarts, 10);
  assert.equal(call.idleMinutes, 0);
  assert.ok(call.registry instanceof Map);
  assert.equal(botRuntimeStatus().discord.running, true);
});

test("discord: stopped when runtimeGate stops the runtime on flag-off", async () => {
  const conn = trackConn(makeConn());
  setFlag(conn, true);
  upsertBot(conn, "botA", discordGw("tok-1"));
  const timers = fakeTimers();
  const sp = fakeSuperviseProcess();

  await initBotRuntime({
    env: {},
    _conn: conn,
    _runBridgeTick: async () => ({ ok: true, bots: 0, handled: 0, errors: [] }),
    _superviseProcess: sp.fn,
    _setIntervalFn: timers.setIntervalFn,
    _clearIntervalFn: timers.clearIntervalFn,
    _setTimeoutFn: timers.setTimeoutFn,
    _clearTimeoutFn: timers.clearTimeoutFn,
    _bus: new EventEmitter(),
    _pollMs: 10,
  });
  await wait(20);
  assert.equal(botRuntimeStatus().discord.running, true);

  setFlag(conn, false);
  await wait(30);

  assert.equal(sp.handles[0].stopCalls, 1);
  assert.equal(botRuntimeStatus().discord.running, false);
});

// ---------------------------------------------------------------------------
// defs-changed reconcile (debounced)
// ---------------------------------------------------------------------------

test("defs-changed reconcile: appear -> start, config change -> restart, disappear -> stop", async () => {
  const conn = trackConn(makeConn());
  setFlag(conn, true);
  const timers = fakeTimers();
  const sp = fakeSuperviseProcess();
  const testBus = new EventEmitter();

  await initBotRuntime({
    env: {},
    _conn: conn,
    _runBridgeTick: async () => ({ ok: true, bots: 0, handled: 0, errors: [] }),
    _superviseProcess: sp.fn,
    _setIntervalFn: timers.setIntervalFn,
    _clearIntervalFn: timers.clearIntervalFn,
    _setTimeoutFn: timers.setTimeoutFn,
    _clearTimeoutFn: timers.clearTimeoutFn,
    _bus: testBus,
    _pollMs: 10,
  });
  await wait(20);
  assert.equal(botRuntimeStatus().discord.running, false, "no discord bots at boot");

  // appear -> start
  upsertBot(conn, "botA", discordGw("tok-1"));
  testBus.emit("pibots:defs-changed", { bot_id: "botA" });
  const debounced1 = timers.lastTimeout();
  assert.equal(debounced1.ms, 2000, "reconcile is debounced 2s");
  debounced1.fn(); // fire-and-forget, like the real setTimeout callback
  await wait(10);
  assert.equal(sp.calls.length, 1);
  assert.equal(botRuntimeStatus().discord.running, true);

  // config change (token rotated) -> restart (stop old, start new)
  upsertBot(conn, "botA", discordGw("tok-2"));
  testBus.emit("pibots:defs-changed", { bot_id: "botA" });
  timers.lastTimeout().fn();
  await wait(10);
  assert.equal(sp.handles[0].stopCalls, 1, "the OLD handle was stopped");
  assert.equal(sp.calls.length, 2, "a NEW handle was started");
  assert.equal(botRuntimeStatus().discord.running, true);

  // disappear -> stop
  removeBot(conn, "botA");
  testBus.emit("pibots:defs-changed", { bot_id: "botA" });
  timers.lastTimeout().fn();
  await wait(10);
  assert.equal(sp.handles[1].stopCalls, 1, "the current handle was stopped");
  assert.equal(botRuntimeStatus().discord.running, false);
});

test("defs-changed reconcile: a burst of events within the debounce window collapses to one reconcile", async () => {
  const conn = trackConn(makeConn());
  setFlag(conn, true);
  const timers = fakeTimers();
  const sp = fakeSuperviseProcess();
  const testBus = new EventEmitter();

  await initBotRuntime({
    env: {},
    _conn: conn,
    _runBridgeTick: async () => ({ ok: true, bots: 0, handled: 0, errors: [] }),
    _superviseProcess: sp.fn,
    _setIntervalFn: timers.setIntervalFn,
    _clearIntervalFn: timers.clearIntervalFn,
    _setTimeoutFn: timers.setTimeoutFn,
    _clearTimeoutFn: timers.clearTimeoutFn,
    _bus: testBus,
    _pollMs: 10,
  });
  await wait(20);

  upsertBot(conn, "botA", discordGw("tok-1"));
  testBus.emit("pibots:defs-changed", { bot_id: "botA" });
  testBus.emit("pibots:defs-changed", { bot_id: "botA" });
  testBus.emit("pibots:defs-changed", { bot_id: "botA" });
  assert.equal(timers.timeouts.size, 1, "later emits reschedule the same debounce, not stack new ones");

  timers.lastTimeout().fn();
  await wait(10);
  assert.equal(sp.calls.length, 1, "one reconcile ran, one discord child started");
});

// ---------------------------------------------------------------------------
// flag-missing default: isMpaHost fallback (the prod double-poll hazard)
// ---------------------------------------------------------------------------

test("flag-missing default: OFF on a plain (non-MPA-shaped) data dir", async () => {
  const prevHome = process.env.CROW_HOME;
  const prevData = process.env.CROW_DATA_DIR;
  process.env.CROW_HOME = "/tmp/crow-plain-home";
  process.env.CROW_DATA_DIR = "/tmp/crow-plain-data";
  try {
    const conn = trackConn(makeConn()); // no feature_flags row at all
    const timers = fakeTimers();
    await initBotRuntime({
      env: {},
      _conn: conn,
      _runBridgeTick: async () => ({ ok: true, bots: 0, handled: 0, errors: [] }),
      _superviseProcess: fakeSuperviseProcess().fn,
      _setIntervalFn: timers.setIntervalFn,
      _clearIntervalFn: timers.clearIntervalFn,
      _setTimeoutFn: timers.setTimeoutFn,
      _clearTimeoutFn: timers.clearTimeoutFn,
      _bus: new EventEmitter(),
      _pollMs: 10,
    });
    await wait(20);
    assert.equal(botRuntimeStatus().bridge.armed, false, "plain data dir -> flag-missing resolves OFF");
  } finally {
    if (prevHome === undefined) delete process.env.CROW_HOME; else process.env.CROW_HOME = prevHome;
    if (prevData === undefined) delete process.env.CROW_DATA_DIR; else process.env.CROW_DATA_DIR = prevData;
  }
});

test("flag-missing default: ON on a ~/.crow-mpa-shaped data dir (isMpaHost fallback)", async () => {
  const prevHome = process.env.CROW_HOME;
  const prevData = process.env.CROW_DATA_DIR;
  process.env.CROW_HOME = "/home/kh0pp/.crow-mpa";
  process.env.CROW_DATA_DIR = "/home/kh0pp/.crow-mpa/data";
  try {
    const conn = trackConn(makeConn()); // no feature_flags row at all
    const timers = fakeTimers();
    await initBotRuntime({
      env: {},
      _conn: conn,
      _runBridgeTick: async () => ({ ok: true, bots: 0, handled: 0, errors: [] }),
      _superviseProcess: fakeSuperviseProcess().fn,
      _setIntervalFn: timers.setIntervalFn,
      _clearIntervalFn: timers.clearIntervalFn,
      _setTimeoutFn: timers.setTimeoutFn,
      _clearTimeoutFn: timers.clearTimeoutFn,
      _bus: new EventEmitter(),
      _pollMs: 10,
    });
    await wait(20);
    assert.equal(botRuntimeStatus().bridge.armed, true, "~/.crow-mpa-shaped dir -> flag-missing resolves ON");
  } finally {
    if (prevHome === undefined) delete process.env.CROW_HOME; else process.env.CROW_HOME = prevHome;
    if (prevData === undefined) delete process.env.CROW_DATA_DIR; else process.env.CROW_DATA_DIR = prevData;
  }
});
