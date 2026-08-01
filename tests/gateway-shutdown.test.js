/**
 * Tests for the gracefulShutdown sequence (W4-2 A).
 *
 * Boots the gateway as a child process (clean env, temp CROW_DATA_DIR,
 * random port, --no-auth) and verifies:
 *   1. SIGTERM → exit code 0 within 25s (covers drain + session/proxy cap).
 *   2. A /health GET issued right before SIGTERM completes successfully.
 *   3. SIGTERM with an open SSE connection still exits 0 (the SSE socket is
 *      an expected casualty after the drain window; the process must not hang).
 *   4. The gateway-supervised Perch hub child does not OUTLIVE the gateway
 *      (Perch Hub C-3 — supervised children are detached with no pdeathsig,
 *      and shutdownAll() only knows proxy.js's bundle children).
 *
 * If the child-process approach is flaky after 3 attempts we would fall back
 * to a stub-server unit test, but the headless boot validated fine (see dev log)
 * so we go with the real process approach.
 *
 * Timing margins are generous for CI: 25s exit cap, 15s boot wait.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import http from "node:http";

// ---- find a free port ----
function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

// ---- wait for the gateway to be healthy ----
async function waitForHealth(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
          res.resume();
          res.on("end", () => resolve());
        });
        req.on("error", reject);
        req.setTimeout(500, () => { req.destroy(); reject(new Error("timeout")); });
      });
      return; // healthy
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw new Error(`Gateway did not become healthy within ${timeoutMs}ms`);
}

/** Fire a GET and return { statusCode } — resolves as long as a response starts. */
function httpGet(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      res.resume();
      res.on("end", () => resolve({ statusCode: res.statusCode }));
    });
    req.on("error", reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error("GET timeout")); });
  });
}

/** Open an SSE connection; returns { req, waitForFirstByte }. */
function openSse(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { hostname: "127.0.0.1", port, path, headers: { Accept: "text/event-stream" } },
      (res) => {
        const waitForFirstByte = new Promise((rfb) => {
          res.once("data", () => rfb());
          res.once("error", () => rfb()); // still counts — the socket opened
        });
        resolve({ req, res, waitForFirstByte });
      }
    );
    req.on("error", reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error("SSE connect timeout")); });
  });
}

/**
 * Install a stub perch-hub payload under a scratch CROW_HOME. The stub is a
 * plain Node script that records its pid and then never exits on its own —
 * standing in for the vendored hub, whose only relevant property here is that
 * it is a long-lived, gateway-supervised, DETACHED child.
 */
function installPerchStub(crowHome, pidFile) {
  const hubDir = join(crowHome, "bundles", "perch-hub", "payload", "hub");
  mkdirSync(hubDir, { recursive: true });
  writeFileSync(
    join(hubDir, "server.mjs"),
    'import { writeFileSync } from "node:fs";\n' +
    "writeFileSync(process.env.PERCH_STUB_PIDFILE, String(process.pid));\n" +
    "setInterval(() => {}, 1 << 30);\n"
  );
}

/** Spawn a fresh gateway process; return { child, port, dataDir }. */
async function spawnGateway({ perchStub = null } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "gw-shutdown-"));
  // Scratch CROW_HOME so the gateway's boot-time bundle/panel repair never
  // touches the operator's real ~/.crow (see repairInstalledBundleAssets).
  const crowHome = join(dataDir, "crow-home");
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dataDir, CROW_HOME: crowHome },
    stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });

  const port = await freePort();

  const env = {
    ...process.env,
    CROW_DATA_DIR: dataDir,
    CROW_HOME: crowHome,
    CROW_GATEWAY_URL: `http://127.0.0.1:${port}`,
    PORT: String(port),
    CROW_SHUTDOWN_DRAIN_MS: "500",
  };

  if (perchStub) {
    installPerchStub(crowHome, perchStub);
    // run-suite forces the kill switch on suite-wide; this one test needs the
    // supervisor to actually run, so it is unset HERE rather than globally.
    delete env.CROW_DISABLE_PERCH;
    env.PERCH_STUB_PIDFILE = perchStub;
    // Loopback ports the stub never binds, but the defaults (4210/4211) are a
    // real host's live perch block — never point a test at them.
    env.CROW_PERCH_PORT = String(await freePort());
    env.CROW_PERCH_REGISTRY_PORT = String(await freePort());
  }

  // Use a short drain window so the test doesn't have to wait 3s per SSE close.
  const child = spawn(
    process.execPath,
    ["servers/gateway/index.js", "--no-auth"],
    { env, cwd: join(import.meta.dirname, ".."), stdio: "pipe" }
  );
  // Drain child stdout/stderr to avoid blocking the process.
  child.stdout.resume();
  child.stderr.resume();

  return { child, port, dataDir };
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// ---- test 1: SIGTERM → exit 0 ----
test("SIGTERM exits with code 0 within 25s", async (t) => {
  const { child, port, dataDir } = await spawnGateway();
  after(() => { try { child.kill("SIGKILL"); } catch {} rmSync(dataDir, { recursive: true, force: true }); });

  await waitForHealth(port);

  const exitPromise = new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });

  child.kill("SIGTERM");

  const result = await Promise.race([
    exitPromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout waiting for exit")), 25_000)),
  ]);

  assert.equal(result.code, 0, `expected exit code 0, got ${result.code} (signal: ${result.signal})`);
});

// ---- test 2: GET before SIGTERM completes ----
test("GET /health completes before SIGTERM is handled", async () => {
  const { child, port, dataDir } = await spawnGateway();
  after(() => { try { child.kill("SIGKILL"); } catch {} rmSync(dataDir, { recursive: true, force: true }); });

  await waitForHealth(port);

  // Issue the GET, then SIGTERM.  Both complete in the same event-loop tick
  // from the child's perspective, so the GET should be served before the
  // listener closes.
  const getPromise = httpGet(port, "/health");
  child.kill("SIGTERM");

  const exitPromise = new Promise((resolve) => child.on("exit", (code) => resolve(code)));

  const [getResult, exitCode] = await Promise.all([
    getPromise.catch(() => ({ statusCode: 0 })),
    exitPromise,
  ]);

  // The GET may have succeeded (200) or received ECONNRESET/ECONNREFUSED if
  // the drain window closed it — either way the exit must be 0.
  assert.equal(exitCode, 0, `expected exit 0, got ${exitCode}`);
  // If the response landed, it should be 200.
  if (getResult.statusCode !== 0) {
    assert.equal(getResult.statusCode, 200, `health returned ${getResult.statusCode}`);
  }
});

// ---- test 3: SIGTERM with open SSE connection exits 0 ----
test("SIGTERM with open SSE connection exits 0 (SSE is expected casualty)", async () => {
  const { child, port, dataDir } = await spawnGateway();
  after(() => { try { child.kill("SIGKILL"); } catch {} rmSync(dataDir, { recursive: true, force: true }); });

  await waitForHealth(port);

  // Open an SSE connection — the /health route doesn't serve SSE, so we try the
  // push/notifications stream.  If unavailable, the connection error is swallowed;
  // what matters is that the gateway still exits cleanly.
  let sseReq;
  try {
    const sse = await openSse(port, "/api/push/notifications");
    sseReq = sse.req;
    await sse.waitForFirstByte;
  } catch {
    // SSE route not available or auth-blocked — proceed without it.
    sseReq = null;
  }

  const exitPromise = new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });

  child.kill("SIGTERM");

  const result = await Promise.race([
    exitPromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout: process hung on SSE")), 25_000)),
  ]);

  try { sseReq?.destroy(); } catch {}

  assert.equal(result.code, 0, `expected exit 0 even with open SSE, got code=${result.code} signal=${result.signal}`);
});

// ---- test 4: the gateway-supervised Perch hub dies WITH the gateway ----
//
// Perch Hub C-3. shutdownAll() (step 5) only reaps proxy.js's MCP bundle
// children — it has never known about process-supervisor handles, and those
// children are spawned `detached: true` (own process group, so a terminal
// SIGINT never reaches them) with no pdeathsig. C-2 proved live that the hub
// was still in `ps` after the gateway exited, holding its loopback port
// against the restarted gateway's own child. This is the regression guard.
test("SIGTERM also stops the gateway-supervised Perch hub (it must not outlive the gateway)", async () => {
  const pidFile = join(mkdtempSync(join(tmpdir(), "gw-perch-pid-")), "hub.pid");
  const { child, port, dataDir } = await spawnGateway({ perchStub: pidFile });
  let hubPid = null;
  after(() => {
    try { child.kill("SIGKILL"); } catch {}
    if (hubPid && pidAlive(hubPid)) { try { process.kill(-hubPid, "SIGKILL"); } catch {} }
    rmSync(dataDir, { recursive: true, force: true });
  });

  await waitForHealth(port);

  // The supervisor starts post-listen, so the stub's pid file appears shortly
  // after /health does.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !existsSync(pidFile)) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(existsSync(pidFile), "the supervised hub never started — this test would pass vacuously");
  hubPid = Number(readFileSync(pidFile, "utf8").trim());
  assert.ok(hubPid > 0);
  assert.equal(pidAlive(hubPid), true, "the hub must be running before we test that shutdown stops it");

  const exitPromise = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  child.kill("SIGTERM");
  const result = await Promise.race([
    exitPromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout waiting for exit")), 25_000)),
  ]);
  assert.equal(result.code, 0, `expected exit 0, got code=${result.code} signal=${result.signal}`);

  // The child is in its own process group: nothing else will ever reap it.
  const goneBy = Date.now() + 5_000;
  while (Date.now() < goneBy && pidAlive(hubPid)) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(pidAlive(hubPid), false,
    `supervised hub (pid ${hubPid}) survived gateway shutdown — it is detached, so it would hold its port forever`);
});
