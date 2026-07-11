/**
 * /wm mount auth (W5 hardening).
 *
 * The window-manager MCP mount was the gateway's one null-auth mount. It is
 * not view-only (crow_wm can spawn the pet process and send P2P
 * invites/memos/reactions), so it must sit behind the same auth chain as
 * every other MCP mount. This test boots the gateway in AUTH mode (no
 * --no-auth) on an isolated temp data dir and pins:
 *   1. POST /wm/mcp with no credentials → 401 (was 400 pre-fix: the bare MCP
 *      transport answered, proving the mount was reachable unauthenticated).
 *   2. POST /wm/mcp with a valid local MCP token → NOT 401/403 (the MCP
 *      transport answers; local token = full local-operator credential).
 *   3. Same two assertions for /wm/sse (GET).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import http from "node:http";

const repoRoot = join(import.meta.dirname, "..");

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
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw new Error(`Gateway did not become healthy within ${timeoutMs}ms`);
}

/** POST an MCP initialize request; resolve with the status code. */
function postMcp(port, path, headers = {}) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "wm-auth-test", version: "0.0.1" },
    },
  });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "Content-Length": Buffer.byteLength(body),
          ...headers,
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      }
    );
    req.on("error", reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error("POST timeout")); });
    req.end(body);
  });
}

/** GET an SSE path; resolve with the status code as soon as headers arrive. */
function getSse(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { hostname: "127.0.0.1", port, path, headers: { Accept: "text/event-stream", ...headers } },
      (res) => {
        const code = res.statusCode;
        req.destroy(); // don't hold the stream open
        resolve(code);
      }
    );
    req.on("error", reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error("SSE timeout")); });
  });
}

let child = null;
let port = null;
let dataDir = null;
let token = null;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "wm-auth-"));
  const dbPath = join(dataDir, "crow.db");
  // Scratch CROW_HOME so the gateway's boot-time bundle/panel repair never
  // touches the operator's real ~/.crow (see repairInstalledBundleAssets).
  const crowHome = join(dataDir, "crow-home");

  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dataDir, CROW_DB_PATH: dbPath, CROW_HOME: crowHome },
    stdio: "pipe",
    cwd: repoRoot,
  });

  // Mint a local MCP token into the isolated DB before boot. Must run in a
  // child process with the SAME CROW_DATA_DIR/CROW_DB_PATH env as the gateway:
  // local-scoped settings are keyed by the instance id derived from the data
  // dir, so minting from this (live-env) process would store the token under
  // the wrong instance id and the gateway would reject it.
  const mintScript = `
    const { createDbClient } = await import("./servers/db.js");
    const { generateLocalToken } = await import("./servers/gateway/local-token.js");
    const db = createDbClient(process.env.CROW_DB_PATH);
    process.stdout.write(await generateLocalToken(db));
    db.close();
  `;
  token = execFileSync(process.execPath, ["--input-type=module", "-e", mintScript], {
    env: { ...process.env, CROW_DATA_DIR: dataDir, CROW_DB_PATH: dbPath, CROW_HOME: crowHome },
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  assert.match(token, /^[0-9a-f]{64}$/);

  port = await freePort();
  // AUTH MODE: no --no-auth flag.
  child = spawn(process.execPath, ["servers/gateway/index.js"], {
    env: {
      ...process.env,
      CROW_DATA_DIR: dataDir,
      CROW_DB_PATH: dbPath,
      CROW_HOME: crowHome,
      CROW_GATEWAY_URL: `http://127.0.0.1:${port}`,
      PORT: String(port),
    },
    cwd: repoRoot,
    stdio: "pipe",
  });
  child.stdout.resume();
  child.stderr.resume();
  await waitForHealth(port);
}, { timeout: 30000 });

after(() => {
  if (child && !child.killed) child.kill("SIGKILL");
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

test("POST /wm/mcp without credentials is rejected with 401", async () => {
  const code = await postMcp(port, "/wm/mcp");
  assert.equal(code, 401);
});

test("POST /wm/mcp with a valid local MCP token reaches the MCP transport", async () => {
  const code = await postMcp(port, "/wm/mcp", { Authorization: `Bearer ${token}` });
  assert.ok(code !== 401 && code !== 403, `expected auth to pass, got ${code}`);
  assert.equal(code, 200); // initialize on a fresh session succeeds
});

test("GET /wm/sse without credentials is rejected with 401", async () => {
  const code = await getSse(port, "/wm/sse");
  assert.equal(code, 401);
});

test("GET /wm/sse with a valid local MCP token opens the stream", async () => {
  const code = await getSse(port, "/wm/sse", { Authorization: `Bearer ${token}` });
  assert.equal(code, 200);
});

test("dashboard mounted: /dashboard/login is a real route (regression: a broken import inside the dashboard graph once unmounted the whole Nest silently)", async () => {
  const code = await new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/dashboard/login`, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error("timeout")); });
  });
  assert.notEqual(code, 404, "/dashboard/login must exist — 404 means the dashboard router failed to mount");
});

test("control: /router/mcp rejects bare requests identically (parity)", async () => {
  const code = await postMcp(port, "/router/mcp");
  assert.equal(code, 401);
});

test("POST /wm/mcp with a BOGUS bearer is rejected with 401 (not 500)", async () => {
  const code = await postMcp(port, "/wm/mcp", { Authorization: "Bearer not-a-real-token" });
  assert.equal(code, 401);
});
