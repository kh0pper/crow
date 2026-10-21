// Bot-cron ticking from the gateway bot runtime (gateway mode only) and from
// the pibot-gateways runner, both through the per-instance ticker lease, so a
// due schedule enqueues exactly one job per instance. The gateway half runs the
// real initBotRuntime with injected timers; the runner half is simulated with
// the same createBotcronTicker the runner uses, under a different holder id.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import {
  initBotRuntime,
  botRuntimeStatus,
  _resetBotRuntimeForTest,
} from "../servers/gateway/bot-runtime.js";
import {
  BOTCRON_HOLDER,
  createBotcronTicker,
  holdBotcronLease,
} from "../scripts/pi-bots/botcron-lease.mjs";
import { ensureBotJobsSchema } from "../scripts/pi-bots/job_runner.mjs";

const POLL = "7000"; // a distinct period, so the botcron interval is easy to find

let dir, dbPath, prevDbPath, conns;

function makeGateConn(flagOn) {
  const d = new Database(":memory:");
  d.exec(`
    CREATE TABLE dashboard_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT);
    CREATE TABLE dashboard_settings_overrides (key TEXT, instance_id TEXT, value TEXT, updated_at TEXT,
      lamport_ts INTEGER DEFAULT 0, PRIMARY KEY(key, instance_id));
    CREATE TABLE pi_bot_defs (bot_id TEXT PRIMARY KEY, display_name TEXT, definition TEXT,
      project_id INTEGER, enabled INTEGER DEFAULT 1, updated_at TEXT);
  `);
  setFlag(d, flagOn);
  conns.push(d);
  return d;
}

function setFlag(conn, on) {
  conn.prepare(
    "INSERT INTO dashboard_settings (key, value) VALUES ('feature_flags', ?) " +
    "ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).run(JSON.stringify({ bot_runtime: on }));
}

function fakeTimers() {
  let nextId = 1;
  const intervals = new Map();
  return {
    setIntervalFn: (fn, ms) => { const id = nextId++; intervals.set(id, { fn, ms }); return id; },
    clearIntervalFn: (id) => intervals.delete(id),
    setTimeoutFn: () => 0,
    clearTimeoutFn: () => {},
    botcron: () => [...intervals.values()].find((i) => i.ms === Number(POLL)),
  };
}

function seedDue() {
  const d = new Database(dbPath);
  d.prepare("INSERT INTO schedules (task, cron_expression, description, enabled, next_run) VALUES (?,?,?,1,?)")
    .run("pipeline:botcron:bot-1", "*/5 * * * *", JSON.stringify({ goal: "say hi" }), new Date(Date.now() - 60000).toISOString());
  d.close();
}
function makeDueAgain() {
  const d = new Database(dbPath);
  d.prepare("UPDATE schedules SET next_run=?").run(new Date(Date.now() - 60000).toISOString());
  d.close();
}
const jobCount = () => {
  const d = new Database(dbPath);
  try { return d.prepare("SELECT COUNT(*) c FROM bot_jobs").get().c; } finally { d.close(); }
};
const leaseFile = () => join(dir, "botcron-ticker.lease.json");
const leaseHolder = () => (existsSync(leaseFile()) ? JSON.parse(readFileSync(leaseFile(), "utf8")).holder : null);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await wait(5); }
  return fn();
}

async function initGateway(env, conn, timers) {
  return initBotRuntime({
    env,
    _conn: conn,
    _runBridgeTick: async () => ({ ok: true, bots: 0, handled: 0, errors: [] }),
    _superviseProcess: () => ({ live: true, state: "running", restartCount: 0, stop: async () => {} }),
    _setIntervalFn: timers.setIntervalFn,
    _clearIntervalFn: timers.clearIntervalFn,
    _setTimeoutFn: timers.setTimeoutFn,
    _clearTimeoutFn: timers.clearTimeoutFn,
    _bus: new EventEmitter(),
    _pollMs: 10,
  });
}

beforeEach(async () => {
  await _resetBotRuntimeForTest();
  conns = [];
  dir = mkdtempSync(join(tmpdir(), "bot-runtime-botcron-"));
  dbPath = join(dir, "crow.db");
  prevDbPath = process.env.CROW_DB_PATH;
  process.env.CROW_DB_PATH = dbPath; // the gateway's lease dir and the scheduler's DB both resolve here
  const d = new Database(dbPath);
  d.exec(`CREATE TABLE schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT, task TEXT, cron_expression TEXT, description TEXT,
    enabled INTEGER DEFAULT 1, last_run TEXT, next_run TEXT, updated_at TEXT)`);
  ensureBotJobsSchema(d);
  d.close();
});
afterEach(async () => {
  await _resetBotRuntimeForTest();
  for (const c of conns) { try { c.close(); } catch {} }
  if (prevDbPath === undefined) delete process.env.CROW_DB_PATH; else process.env.CROW_DB_PATH = prevDbPath;
  rmSync(dir, { recursive: true, force: true });
});

test("gateway mode: one due schedule gives one job (immediate tick on arming), and the next tick adds none", async () => {
  seedDue();
  const timers = fakeTimers();
  const r = await initGateway({ PIBOT_BOTCRON_POLL_MS: POLL }, makeGateConn(true), timers);
  assert.equal(r.mode, "gateway");
  assert.ok(await until(() => jobCount() === 1), "the immediate tick enqueued the due schedule");
  assert.equal(leaseHolder(), BOTCRON_HOLDER);
  assert.equal(botRuntimeStatus().botcron.armed, true);

  const iv = timers.botcron();
  assert.ok(iv, "a bot-cron interval is armed on PIBOT_BOTCRON_POLL_MS");
  await iv.fn();
  assert.equal(jobCount(), 1, "the schedule was advanced, so a second tick enqueues nothing");
});

test("gateway mode: the bot-cron interval defaults to 60000 ms", async () => {
  const intervals = [];
  const timers = fakeTimers();
  const orig = timers.setIntervalFn;
  timers.setIntervalFn = (fn, ms) => { intervals.push(ms); return orig(fn, ms); };
  await initGateway({}, makeGateConn(true), timers);
  assert.ok(await until(() => botRuntimeStatus().botcron.armed));
  // the bridge tick also defaults to 60000: both intervals are armed on it
  assert.deepEqual(intervals.filter((ms) => ms === 60000).length, 2);
});

test("gateway mode with the flag off never ticks bot cron", async () => {
  seedDue();
  const timers = fakeTimers();
  await initGateway({ PIBOT_BOTCRON_POLL_MS: POLL }, makeGateConn(false), timers);
  await wait(60);
  assert.equal(jobCount(), 0);
  assert.equal(timers.botcron(), undefined);
  assert.equal(botRuntimeStatus().botcron.armed, false);
});

for (const [name, env] of [
  ["external", { PIBOT_SUPERVISOR: "external", PIBOT_BOTCRON_POLL_MS: POLL }],
  ["disabled", { CROW_DISABLE_BOT_RUNTIME: "1", PIBOT_BOTCRON_POLL_MS: POLL }],
]) {
  test(`${name} mode never ticks bot cron from the gateway`, async () => {
    seedDue();
    const timers = fakeTimers();
    const r = await initGateway(env, makeGateConn(true), timers);
    assert.equal(r.mode, name);
    await wait(60);
    assert.equal(jobCount(), 0);
    assert.equal(timers.botcron(), undefined);
    assert.equal(existsSync(leaseFile()), false, "the lease is never taken");
    assert.equal(botRuntimeStatus().botcron.armed, false);
  });
}

test("a gateway ticker and a runner ticker on one instance give one job per due schedule over 3 rounds", async () => {
  seedDue();
  const timers = fakeTimers();
  await initGateway({ PIBOT_BOTCRON_POLL_MS: POLL }, makeGateConn(true), timers);
  assert.ok(await until(() => jobCount() === 1));
  const runner = createBotcronTicker({ dir, holder: "runner-sim" });

  // round 1: the gateway's immediate tick already fired; the runner idles
  assert.deepEqual(await runner.sweep(), { fired: 0, held: false });
  assert.equal(jobCount(), 1);

  // round 2: runner first, then the gateway
  makeDueAgain();
  assert.equal((await runner.sweep()).fired, 0);
  await timers.botcron().fn();
  assert.equal(jobCount(), 2);

  // round 3: the gateway first, then the runner
  makeDueAgain();
  await timers.botcron().fn();
  assert.equal((await runner.sweep()).fired, 0);
  assert.equal(jobCount(), 3);

  assert.equal(runner.held, false);
  assert.equal(leaseHolder(), BOTCRON_HOLDER);
  await runner.stop(); // a non-holder's stop leaves the gateway's lease alone
  assert.equal(leaseHolder(), BOTCRON_HOLDER);
});

test("disarming (flag off) clears the bot-cron interval and releases the lease", async () => {
  const timers = fakeTimers();
  const conn = makeGateConn(true);
  await initGateway({ PIBOT_BOTCRON_POLL_MS: POLL }, conn, timers);
  assert.ok(await until(() => leaseHolder() === BOTCRON_HOLDER), "the gateway took the lease");

  setFlag(conn, false);
  assert.ok(await until(() => !botRuntimeStatus().botcron.armed && !existsSync(leaseFile())), "stop released the lease");
  assert.equal(timers.botcron(), undefined, "the interval was cleared");
  assert.equal(await holdBotcronLease({ dir, holder: "runner-sim" }), true, "another ticker can take it at once");
});

test("the runner ticker logs once on gaining the lease and once on losing it, not per tick", async () => {
  const lines = [];
  let ok = true;
  const t = createBotcronTicker({
    dir, holder: "h", log: (m) => lines.push(m),
    _hold: async () => ok, _release: async () => {}, _tick: () => ({ fired: 0 }),
  });
  await t.sweep(); await t.sweep();
  ok = false; await t.sweep(); await t.sweep();
  ok = true; await t.sweep();
  assert.deepEqual(lines.map((l) => l.split(",")[0]), ["lease acquired", "lease lost", "lease acquired"]);
});

test("the ticker drops an overlapping sweep and never ticks after stop", async () => {
  let ticks = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const t = createBotcronTicker({
    dir, holder: "h",
    _hold: async () => { await gate; return true; }, _release: async () => {}, _tick: () => { ticks++; return { fired: 1 }; },
  });
  const p1 = t.sweep();
  assert.equal((await t.sweep()).skipped, true);
  release();
  assert.equal((await p1).fired, 1);
  await t.stop();
  assert.equal((await t.sweep()).skipped, true);
  assert.equal(ticks, 1);
});
