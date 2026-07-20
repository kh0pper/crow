// C4 Task 5 — bridge_tick as a library. bridge_tick.mjs used to be a
// process.exit(0)-only CLI script; the gateway now needs to drive the exact
// same tick in-process (Task 6, ~60s interval) without spawning a child
// process or killing itself on the first skip. This exercises the extracted
// runBridgeTick({ log, _dbFactory, _resolvePiCli }) from bridge_tick_lib.mjs
// and the three mandatory behavior deltas called out in the C4 build brief:
//   1. returns a result object instead of process.exit
//   2. the main better-sqlite3 handle closes in try/finally on EVERY path
//      (previously only reachable via process.exit, which skipped the close)
//   3. the lock file is instance-scoped (hash of the resolved crow.db path)
//      and unlinks in `finally` on ALL paths, including the pi_bot_defs
//      missing catch (which previously exited WITHOUT unlinking).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, closeSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { runBridgeTick, lockPathFor } from "../scripts/pi-bots/bridge_tick_lib.mjs";

const FAKE_PI = { cliPath: "/fake/pi/dist/cli.js", source: "env" };
const engineOk = () => FAKE_PI;
const engineMissing = () => null;

/** A fresh scratch data dir with the FULL schema (init-db.js), CROW_DATA_DIR
 *  pointed at it for the duration of the test, restored afterward. */
function scratchDataDir(label) {
  const dir = mkdtempSync(join(tmpdir(), `crow-bridge-tick-${label}-`));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir },
    stdio: "pipe",
  });
  after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function setBotRuntime(dbPath, enabled) {
  const d = new Database(dbPath);
  try {
    d.prepare(
      "INSERT INTO dashboard_settings (key, value) VALUES ('feature_flags', ?) " +
      "ON CONFLICT(key) DO UPDATE SET value=excluded.value"
    ).run(JSON.stringify({ bot_runtime: enabled }));
  } finally {
    d.close();
  }
}

/** Run a callback with CROW_DATA_DIR (and no CROW_DB_PATH) set, restoring both after. */
async function withDataDir(dir, fn) {
  const prevDir = process.env.CROW_DATA_DIR;
  const prevDbPath = process.env.CROW_DB_PATH;
  delete process.env.CROW_DB_PATH;
  process.env.CROW_DATA_DIR = dir;
  try {
    return await fn();
  } finally {
    if (prevDir === undefined) delete process.env.CROW_DATA_DIR; else process.env.CROW_DATA_DIR = prevDir;
    if (prevDbPath === undefined) delete process.env.CROW_DB_PATH; else process.env.CROW_DB_PATH = prevDbPath;
  }
}

function trackingFactory(defaultFactory) {
  let opens = 0, closes = 0;
  const factory = (path) => {
    opens++;
    const d = defaultFactory(path);
    const origClose = d.close.bind(d);
    d.close = () => { closes++; return origClose(); };
    return d;
  };
  return { factory, counts: () => ({ opens, closes }) };
}

function realFactory(path) {
  const d = new Database(path);
  d.pragma("busy_timeout = 10000");
  return d;
}

test("runBridgeTick returns a result object (never exits the process)", async () => {
  const dir = scratchDataDir("returns");
  await withDataDir(dir, async () => {
    const r = await runBridgeTick({ _resolvePiCli: engineMissing, log: () => {} });
    assert.equal(typeof r, "object");
    assert.equal(r.ok, true);
    assert.equal(r.skipped, "engine_missing");
  });
});

test("runBridgeTick: engine_missing skip is DB-free and happens before any gmail I/O", async () => {
  // Deliberately CROW_DATA_DIR pointing at a dir with NO crow.db at all —
  // if the engine check needed the db first this would throw ENOENT.
  const dir = mkdtempSync(join(tmpdir(), "crow-bridge-tick-noengine-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  await withDataDir(dir, async () => {
    const r = await runBridgeTick({ _resolvePiCli: engineMissing, log: () => {} });
    assert.deepEqual(r, { ok: true, skipped: "engine_missing" });
  });
});

test("runBridgeTick: skipped 'runtime_disabled' when bot_runtime flag is off", async () => {
  const dir = scratchDataDir("runtime-off");
  setBotRuntime(join(dir, "crow.db"), false);
  await withDataDir(dir, async () => {
    const r = await runBridgeTick({ _resolvePiCli: engineOk, log: () => {} });
    assert.equal(r.ok, true);
    assert.equal(r.skipped, "runtime_disabled");
  });
});

test("runBridgeTick: skipped 'locked' when a fresh lock file already exists (instance-scoped path)", async () => {
  const dir = scratchDataDir("locked");
  const dbPath = join(dir, "crow.db");
  const lock = lockPathFor(dbPath);
  closeSync(openSync(lock, "w"));
  after(() => { try { rmSync(lock); } catch {} });
  await withDataDir(dir, async () => {
    const r = await runBridgeTick({ _resolvePiCli: engineOk, log: () => {} });
    assert.equal(r.ok, true);
    assert.equal(r.skipped, "locked");
    // We never owned the lock — it must still be there afterward.
    assert.ok(existsSync(lock));
  });
});

test("runBridgeTick: lock released after a normal completed run (0 enabled bots)", async () => {
  const dir = scratchDataDir("normal-run");
  const dbPath = join(dir, "crow.db");
  setBotRuntime(dbPath, true);
  const lock = lockPathFor(dbPath);
  await withDataDir(dir, async () => {
    const r = await runBridgeTick({ _resolvePiCli: engineOk, log: () => {} });
    assert.equal(r.ok, true);
    assert.equal(r.skipped, undefined);
    assert.equal(r.bots, 0);
    assert.equal(r.handled, 0);
    assert.ok(!existsSync(lock), "lock must be gone after a normal completed run");
  });
});

test("runBridgeTick: lock released even when pi_bot_defs table is missing (fresh/partial DB)", async () => {
  // A hand-built minimal DB: dashboard_settings + dashboard_settings_overrides
  // exist (so botRuntimeEnabledSync can resolve true) but pi_bot_defs does
  // NOT — the fresh-DB race the brief calls out (gateway ticks before
  // init-db has run, or a partial/corrupt DB).
  const dir = mkdtempSync(join(tmpdir(), "crow-bridge-tick-nodefs-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "crow.db");
  const d = new Database(dbPath);
  d.exec(`
    CREATE TABLE dashboard_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE dashboard_settings_overrides (key TEXT, instance_id TEXT, value TEXT, updated_at TEXT DEFAULT (datetime('now')), lamport_ts INTEGER DEFAULT 0, PRIMARY KEY(key, instance_id));
  `);
  d.prepare("INSERT INTO dashboard_settings (key, value) VALUES ('feature_flags', ?)").run(JSON.stringify({ bot_runtime: true }));
  d.close();

  const lock = lockPathFor(dbPath);
  await withDataDir(dir, async () => {
    const r = await runBridgeTick({ _resolvePiCli: engineOk, log: () => {} });
    assert.equal(r.ok, true);
    assert.equal(r.bots, 0);
    assert.equal(r.handled, 0);
    assert.ok(!existsSync(lock), "lock must be gone even on the pi_bot_defs-missing early return (old bug: exited without unlinking)");
  });
});

test("runBridgeTick: lock released AND db handle closed when the tick body throws unexpectedly", async () => {
  const dir = scratchDataDir("throws");
  const dbPath = join(dir, "crow.db");
  setBotRuntime(dbPath, true);
  const lock = lockPathFor(dbPath);

  let calls = 0;
  const throwingFactory = (path) => {
    calls++;
    if (calls === 1) throw new Error("injected-boom");
    return realFactory(path);
  };

  await withDataDir(dir, async () => {
    await assert.rejects(
      () => runBridgeTick({ _resolvePiCli: engineOk, _dbFactory: throwingFactory, log: () => {} }),
      /injected-boom/
    );
    assert.ok(!existsSync(lock), "lock must be released even though the tick body threw");
  });
});

test("runBridgeTick: db handle opened via _dbFactory is closed on every path (open/close balance)", async () => {
  const dir = scratchDataDir("db-balance");
  const dbPath = join(dir, "crow.db");
  setBotRuntime(dbPath, true);
  const { factory, counts } = trackingFactory(realFactory);

  await withDataDir(dir, async () => {
    const r = await runBridgeTick({ _resolvePiCli: engineOk, _dbFactory: factory, log: () => {} });
    assert.equal(r.ok, true);
    const { opens, closes } = counts();
    assert.ok(opens >= 1, "at least one db handle was opened");
    assert.equal(opens, closes, `every opened handle must be closed (opens=${opens} closes=${closes})`);
  });
});
