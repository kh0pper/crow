// Task C-2 — servers/gateway/perch-runtime.js: gateway supervision of the
// vendored Perch hub payload. Every seam (crowHome, env, superviseProcess,
// randomBytes, the raw spawn under the log-drain wrapper, the logger) is
// injected, so nothing here spawns a real process, mints a token into the
// real ~/.crow, or writes to the real gateway log.
//
// The LAST test in this file is deliberately different — Task C-8's end-to-end
// install: the REAL vendored payload, the REAL superviseProcess, a real hub
// process answering a real HTTP request. See its header block.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, statSync, readFileSync, cpSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  initPerchRuntime,
  perchRuntimeStatus,
  stopPerchRuntime,
  stopPerchRuntimeBounded,
  PERCH_STOP_TIMEOUT_MS,
  PERCH_BUNDLE_ID,
  _resetPerchRuntimeForTest,
} from "../servers/gateway/perch-runtime.js";
import { computePayloadDigest } from "../scripts/check-vendored-payloads.mjs";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

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

// ---------------------------------------------------------------------------
// C-8 — END TO END: real vendored payload, real supervisor, real HTTP
// ---------------------------------------------------------------------------
//
// Everything above this line runs against fakes. This one does not: it copies
// `bundles/perch-hub/payload/` — the actual bytes `scripts/vendor-perch.mjs`
// pulled out of pi-lab at the commit recorded in payload/UPSTREAM — into a
// scratch CROW_HOME laid out the way a real install lays it out, then boots it
// through the REAL `superviseProcess` and proves the hub answers
// `GET /bots` with the bearer the runtime minted.
//
// Why the fixture writes BOTH the payload tree AND `installed.json`:
// "installed" has two different readers in this product and they read two
// different things. `perch-runtime.js` and the Perch panel key off the payload
// directory on disk; the extension PROXY's route table
// (`extension-proxy.js` getProxiedExtensions) is built from
// `CROW_HOME/installed.json` joined against `CROW_HOME/bundles/<id>/manifest.json`.
// A fixture with only the payload boots a healthy hub behind a proxy route that
// 404s — everything looks fine and nothing works. Real install writes all
// three (payload, manifest copy, installed.json entry), so this does too.
//
// Ports are allocated from the ephemeral range at run time, never the 4210/4211
// defaults and never the lab's live pi-hub on 4200/4201.

/** Bind :0 on loopback, note the port the kernel handed out, release it. */
function freeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Lay out a scratch CROW_HOME exactly as a real bundle install would. */
function installRealPayload(home) {
  const srcBundle = join(REPO_ROOT, "bundles", PERCH_BUNDLE_ID);
  assert.ok(
    existsSync(join(srcBundle, "payload", "hub", "server.mjs")),
    "bundles/perch-hub/payload is missing — run `node scripts/vendor-perch.mjs --ref crow-mode`",
  );
  const destBundle = join(home, "bundles", PERCH_BUNDLE_ID);
  mkdirSync(destBundle, { recursive: true });
  cpSync(join(srcBundle, "payload"), join(destBundle, "payload"), { recursive: true });
  cpSync(join(srcBundle, "manifest.json"), join(destBundle, "manifest.json"));

  const manifest = JSON.parse(readFileSync(join(destBundle, "manifest.json"), "utf8"));
  writeFileSync(
    join(home, "installed.json"),
    JSON.stringify(
      [{ id: PERCH_BUNDLE_ID, type: "bundle", version: manifest.version, installedAt: new Date().toISOString() }],
      null,
      2,
    ),
  );
  return { destBundle, manifest };
}

/** Poll until the hub answers, or give up with the child's own log lines. */
async function fetchWhenUp(url, init, { timeoutMs = 20000, logs = [] } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      return await fetch(url, init);
    } catch (err) {
      lastErr = err;
      await sleep(150);
    }
  }
  throw new Error(
    `hub never answered ${url} within ${timeoutMs}ms (last: ${lastErr && lastErr.message})\n` +
      `child output:\n${logs.join("\n") || "  (none)"}`,
  );
}

/** Any live process whose argv mentions this scratch payload dir. */
function processesUnder(payloadDir) {
  const ps = execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" });
  return ps.split("\n").filter((line) => line.includes(payloadDir));
}

test("E2E: the vendored payload installs, boots under the real supervisor, and serves /bots", async () => {
  const home = mkdtempSync(join(scratch, "crowhome-e2e-"));
  const { destBundle, manifest } = installRealPayload(home);
  const payloadDir = join(destBundle, "payload");

  // The fixture must be the REAL vendored bytes, not a stub like the fakes
  // above use — otherwise a green run below would prove nothing about what
  // ships. This is the same digest CI recomputes.
  assert.equal(
    computePayloadDigest(payloadDir),
    manifest.payload_sha256,
    "scratch payload does not match the manifest's stamped digest",
  );
  assert.equal(manifest.draft, false, "the bundle must be published for anyone to install it");

  const port = await freeLoopbackPort();
  const registryPort = await freeLoopbackPort();
  for (const p of [port, registryPort]) {
    assert.ok(p > 10000, `refusing to bind low port ${p}`);
    assert.ok(![4200, 4201, 4210, 4211].includes(p), `port ${p} is reserved`);
  }
  assert.notEqual(port, registryPort);

  const logs = [];
  let started = null;
  try {
    // No `superviseProcess` seam and no `_spawn` seam: this is the real
    // supervisor spawning a real node process. Only the logger is captured.
    started = await initPerchRuntime({
      crowHome: home,
      env: {
        PATH: process.env.PATH,
        // Scratch HOME so the hub's settings.json / session lookups can never
        // reach the operator's real ~/.pi.
        HOME: home,
        CROW_PERCH_PORT: String(port),
        CROW_PERCH_REGISTRY_PORT: String(registryPort),
      },
      _log: (line) => logs.push(line),
    });
    assert.equal(started.started, true);
    assert.ok(started.handle, "real superviseProcess must hand back a handle");

    const token = readFileSync(join(home, "perch-token"), "utf8").trim();
    assert.match(token, /^[0-9a-f]{64}$/);

    const res = await fetchWhenUp(
      `http://127.0.0.1:${port}/bots`,
      { headers: { Authorization: `Bearer ${token}` } },
      { logs },
    );
    assert.equal(res.status, 200, `GET /bots with the minted bearer must be 200\nchild output:\n${logs.join("\n")}`);
    const body = await res.text();
    // The bots lens exists only under PERCH_CROW_MODE=1 — the runtime's env
    // block is what turns it on, so this marker proves the crow-mode wiring
    // end to end, not just "some server answered".
    assert.ok(body.includes('id="perch-bots-root"'), "response is not the crow-mode bots lens");

    // The bearer is load-bearing, not decorative.
    const unauth = await fetch(`http://127.0.0.1:${port}/bots`, { redirect: "manual" });
    assert.notEqual(unauth.status, 200, "the hub must not serve /bots without the bearer");

    assert.equal(perchRuntimeStatus().running, true);
    assert.equal(perchRuntimeStatus().port, port);
  } finally {
    // Real teardown path — the same one gateway shutdown and uninstall use.
    const stopped = await stopPerchRuntime();
    if (started && started.started) assert.equal(stopped, true);
  }

  // The supervisor kills the whole process GROUP; if that ever regresses the
  // hub outlives the gateway and keeps the port. `handle.stop()` resolves on
  // the child's exit event, so by here it is already gone.
  assert.deepEqual(processesUnder(payloadDir), [], "a hub process survived the stop path");
  await assert.rejects(
    fetch(`http://127.0.0.1:${port}/bots`),
    "the hub port must be closed after teardown",
  );
});
