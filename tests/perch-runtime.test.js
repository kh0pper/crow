// Task C-2 — servers/gateway/perch-runtime.js: gateway supervision of the
// vendored Perch hub payload. Every seam (crowHome, env, superviseProcess,
// randomBytes, the raw spawn under the log-drain wrapper, the logger) is
// injected, so nothing here spawns a real process, mints a token into the
// real ~/.crow, or writes to the real gateway log.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  initPerchRuntime,
  perchRuntimeStatus,
  stopPerchRuntime,
  stopPerchRuntimeBounded,
  PERCH_STOP_TIMEOUT_MS,
  _resetPerchRuntimeForTest,
} from "../servers/gateway/perch-runtime.js";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

let scratch;

function makeCrowHome({ installed = true } = {}) {
  const home = mkdtempSync(join(scratch, "crowhome-"));
  if (installed) {
    const hubDir = join(home, "bundles", "perch-hub", "payload", "hub");
    mkdirSync(hubDir, { recursive: true });
    writeFileSync(join(hubDir, "server.mjs"), "// vendored hub stub\n");
  } else {
    mkdirSync(home, { recursive: true });
  }
  return home;
}

/** Records every superviseProcess call and hands back a controllable handle. */
function fakeSupervisor() {
  const calls = [];
  const handles = [];
  const fn = (opts) => {
    calls.push(opts);
    const h = {
      key: opts.key,
      live: true,
      state: "running",
      restartCount: 0,
      lastError: null,
      stopCount: 0,
      stop: async () => {
        h.stopCount += 1;
        h.live = false;
        h.state = "stopped";
      },
      // let a test drive the terminal hook the runtime registered
      fireTerminal: (reason) => opts.onTerminal(reason),
    };
    handles.push(h);
    return h;
  };
  fn.calls = calls;
  fn.handles = handles;
  return fn;
}

/** A child-process double with the two piped streams superviseProcess asks for. */
function fakeChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "perch-runtime-test-"));
});

afterEach(() => {
  _resetPerchRuntimeForTest();
  try { rmSync(scratch, { recursive: true, force: true }); } catch {}
});

// ---------------------------------------------------------------------------
// (a) not installed
// ---------------------------------------------------------------------------

test("no payload under CROW_HOME → not_installed, nothing spawned, no token minted", async () => {
  const home = makeCrowHome({ installed: false });
  const supervise = fakeSupervisor();

  const res = await initPerchRuntime({ crowHome: home, env: {}, superviseProcess: supervise });

  assert.deepEqual(res, { started: false, reason: "not_installed" });
  assert.equal(supervise.calls.length, 0);
  assert.equal(existsSync(join(home, "perch-token")), false,
    "an uninstalled host must not accumulate a stray token file");
  assert.equal(perchRuntimeStatus().installed, false);
  assert.equal(perchRuntimeStatus().running, false);
});

// ---------------------------------------------------------------------------
// (b) kill switch
// ---------------------------------------------------------------------------

test("CROW_DISABLE_PERCH=1 wins even when the payload IS installed", async () => {
  const home = makeCrowHome();
  const supervise = fakeSupervisor();

  const res = await initPerchRuntime({
    crowHome: home,
    env: { CROW_DISABLE_PERCH: "1" },
    superviseProcess: supervise,
  });

  assert.deepEqual(res, { started: false, reason: "disabled" });
  assert.equal(supervise.calls.length, 0);
  assert.equal(existsSync(join(home, "perch-token")), false);
  // status stays honest about what is on disk
  assert.equal(perchRuntimeStatus().installed, true);
  assert.equal(perchRuntimeStatus().running, false);
});

// ---------------------------------------------------------------------------
// (c) spawn shape + env block
// ---------------------------------------------------------------------------

test("installed → supervises the payload once with the crow-mode env block", async () => {
  const home = makeCrowHome();
  const supervise = fakeSupervisor();

  const res = await initPerchRuntime({
    crowHome: home,
    env: { PATH: "/usr/bin" },
    superviseProcess: supervise,
  });

  assert.equal(res.started, true);
  assert.ok(res.handle);
  assert.equal(supervise.calls.length, 1);

  const payloadDir = join(home, "bundles", "perch-hub", "payload");
  const opts = supervise.calls[0];
  assert.equal(opts.key, "perch-hub");
  assert.equal(opts.command, process.execPath);
  assert.deepEqual(opts.args, [join(payloadDir, "hub", "server.mjs")]);
  assert.equal(opts.cwd, payloadDir);
  assert.equal(opts.alwaysResident, true);
  assert.equal(opts.maxRestarts, 3);
  assert.equal(typeof opts.spawn, "function", "stdio-drain wrapper must be wired in");
  assert.equal(typeof opts.onTerminal, "function");

  const token = readFileSync(join(home, "perch-token"), "utf8").trim();
  assert.deepEqual(opts.env, {
    PATH: "/usr/bin",
    PERCH_CROW_MODE: "1",
    PERCH_BASE_PATH: "/proxy/perch-hub",
    PERCH_API_TOKEN: token,
    PI_HUB_PORT: "4210",
    PI_HUB_REGISTRY_PORT: "4211",
    PI_HUB_POOL_START: "4141",
    PI_HUB_POOL_END: "4179",
  });
});

test("CROW_PERCH_PORT / CROW_PERCH_REGISTRY_PORT override the defaults", async () => {
  const home = makeCrowHome();
  const supervise = fakeSupervisor();

  await initPerchRuntime({
    crowHome: home,
    env: { CROW_PERCH_PORT: "4310", CROW_PERCH_REGISTRY_PORT: "4311" },
    superviseProcess: supervise,
  });

  const env = supervise.calls[0].env;
  assert.equal(env.PI_HUB_PORT, "4310");
  assert.equal(env.PI_HUB_REGISTRY_PORT, "4311");
  assert.equal(perchRuntimeStatus().port, 4310);
});

// ---------------------------------------------------------------------------
// (c cont.) token minting + reuse
// ---------------------------------------------------------------------------

test("token is 32-byte hex, mode 0600, and REUSED on a second init", async () => {
  const home = makeCrowHome();
  const tokenPath = join(home, "perch-token");
  let mintCount = 0;
  const randomBytes = (n) => {
    mintCount += 1;
    assert.equal(n, 32, "spec pins a 32-byte token");
    return Buffer.alloc(n, 0xab);
  };

  const supervise1 = fakeSupervisor();
  await initPerchRuntime({ crowHome: home, env: {}, superviseProcess: supervise1, randomBytes });

  const first = readFileSync(tokenPath, "utf8").trim();
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(mintCount, 1);
  assert.equal(statSync(tokenPath).mode & 0o777, 0o600, "token file must not be world/group readable");

  _resetPerchRuntimeForTest();
  const supervise2 = fakeSupervisor();
  await initPerchRuntime({ crowHome: home, env: {}, superviseProcess: supervise2, randomBytes });

  const second = readFileSync(tokenPath, "utf8").trim();
  assert.equal(second, first, "an existing token must never be regenerated");
  assert.equal(mintCount, 1, "randomBytes must not be called when a token already exists");
  assert.equal(supervise2.calls[0].env.PERCH_API_TOKEN, first);
});

// ---------------------------------------------------------------------------
// (d) status
// ---------------------------------------------------------------------------

test("perchRuntimeStatus reflects handle state and lastError after onTerminal", async () => {
  const home = makeCrowHome();
  const supervise = fakeSupervisor();

  const before = perchRuntimeStatus();
  assert.deepEqual(
    { installed: before.installed, running: before.running, state: before.state, lastError: before.lastError, port: before.port },
    { installed: false, running: false, state: "stopped", lastError: null, port: null }
  );

  await initPerchRuntime({ crowHome: home, env: {}, superviseProcess: supervise });

  let st = perchRuntimeStatus();
  assert.equal(st.installed, true);
  assert.equal(st.running, true);
  assert.equal(st.state, "running");
  assert.equal(st.lastError, null);
  assert.equal(st.port, 4210);

  supervise.handles[0].fireTerminal("unhealthy");
  st = perchRuntimeStatus();
  assert.match(st.lastError, /unhealthy/);

  supervise.handles[0].live = false;
  supervise.handles[0].state = "unhealthy";
  st = perchRuntimeStatus();
  assert.equal(st.running, false);
  assert.equal(st.state, "unhealthy");
});

// ---------------------------------------------------------------------------
// stdio drain wrapper
// ---------------------------------------------------------------------------

test("the spawn wrapper drains child stdout/stderr into the gateway log", async () => {
  const home = makeCrowHome();
  const supervise = fakeSupervisor();
  const lines = [];
  const child = fakeChild();
  const spawnCalls = [];
  const fakeSpawn = (cmd, args, opts) => { spawnCalls.push({ cmd, args, opts }); return child; };

  await initPerchRuntime({
    crowHome: home,
    env: {},
    superviseProcess: supervise,
    _spawn: fakeSpawn,
    _log: (line) => lines.push(line),
  });

  const wrapper = supervise.calls[0].spawn;
  const returned = wrapper("node", ["hub/server.mjs"], { cwd: "/tmp" });

  assert.equal(spawnCalls.length, 1, "wrapper must delegate to the real spawn");
  assert.equal(returned, child, "wrapper must return the child superviseProcess supervises");
  assert.ok(child.stdout.listenerCount("data") > 0, "stdout must be drained (64KB pipe would otherwise stall the child)");
  assert.ok(child.stderr.listenerCount("data") > 0, "stderr must be drained");

  child.stdout.emit("data", Buffer.from("hub listening on 4210\n"));
  child.stderr.emit("data", Buffer.from("boom\n"));

  assert.deepEqual(lines, ["[perch-hub] hub listening on 4210", "[perch-hub] boom"]);
});

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

test("stopPerchRuntime is awaitable, stops the handle, and is idempotent", async () => {
  const home = makeCrowHome();
  const supervise = fakeSupervisor();
  await initPerchRuntime({ crowHome: home, env: {}, superviseProcess: supervise });

  const stopped = await stopPerchRuntime();
  assert.equal(stopped, true);
  assert.equal(supervise.handles[0].stopCount, 1);
  assert.equal(perchRuntimeStatus().running, false);
  assert.equal(perchRuntimeStatus().state, "stopped");

  // C-3 awaits this before deleting the payload dir — a second call must
  // resolve rather than throw or re-kill.
  assert.equal(await stopPerchRuntime(), false);
  assert.equal(supervise.handles[0].stopCount, 1);
});

// ---------------------------------------------------------------------------
// bounded stop (C-3) — shared by the uninstall path and gateway shutdown
// ---------------------------------------------------------------------------

test("stopPerchRuntimeBounded stops a live handle and reports stopped:true", async () => {
  const home = makeCrowHome();
  const supervise = fakeSupervisor();
  await initPerchRuntime({ crowHome: home, env: {}, superviseProcess: supervise });

  assert.deepEqual(await stopPerchRuntimeBounded(), { stopped: true, timedOut: false });
  assert.equal(supervise.handles[0].stopCount, 1);
  assert.equal(perchRuntimeStatus().running, false);

  // Nothing left to stop — still resolves, never throws (shutdown runs it
  // unconditionally, including on hosts that never installed perch-hub).
  assert.deepEqual(await stopPerchRuntimeBounded(), { stopped: false, timedOut: false });
});

test("stopPerchRuntimeBounded gives up at the bound when the child never exits", async () => {
  // handle.stop() resolves on the child's "exit" event, so a process that
  // ignores SIGTERM leaves it pending forever. Neither an uninstall job nor
  // gateway shutdown may wait on that.
  const started = Date.now();
  const res = await stopPerchRuntimeBounded({
    timeoutMs: 100,
    stopImpl: () => new Promise(() => {}),
  });
  const elapsed = Date.now() - started;
  assert.deepEqual(res, { stopped: false, timedOut: true });
  assert.ok(elapsed < 2000, `bounded stop took ${elapsed}ms — it is not actually bounded`);
});

test("stopPerchRuntimeBounded swallows a throwing stop rather than failing its caller", async () => {
  const res = await stopPerchRuntimeBounded({
    timeoutMs: 100,
    stopImpl: () => { throw new Error("kill failed: EPERM"); },
  });
  assert.deepEqual(res, { stopped: false, timedOut: false });
});

test("the default bound is 5s and is exported so both callers share one number", () => {
  assert.equal(PERCH_STOP_TIMEOUT_MS, 5000);
});
