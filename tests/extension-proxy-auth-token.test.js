/**
 * Perch Hub C-3 — `webUI.authTokenFile` bearer injection in the extension
 * proxy (`servers/gateway/routes/extension-proxy.js`).
 *
 * Everything here runs against the REAL proxy router in front of a REAL stub
 * upstream, because the two things worth proving are both invisible to a unit
 * test of the reader:
 *   1. the header actually reaches the backend (http-proxy-middleware is v3 —
 *      the v2 top-level `onProxyReq` option it would be natural to reach for
 *      is silently ignored, so a "correct-looking" hook can inject nothing);
 *   2. the read is LAZY — the token file is minted by perch-runtime AFTER this
 *      factory has been constructed, so a boot-time read gets nothing and
 *      would serve an empty header for the life of the process.
 *
 * extension-proxy.js resolves CROW_HOME at module load, so it is pointed at a
 * scratch dir BEFORE the import (bundles-auth-bypass.test.js idiom).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CROW_HOME = mkdtempSync(join(tmpdir(), "crow-proxy-token-"));
process.env.CROW_HOME = CROW_HOME;

after(() => { try { rmSync(CROW_HOME, { recursive: true, force: true }); } catch {} });

const { default: extensionProxyFactory, readAuthToken } =
  await import("../servers/gateway/routes/extension-proxy.js");

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** Write installed.json + a manifest so getProxiedExtensions() sees the bundle. */
function installWebUiBundle(id, webUI) {
  const dir = join(CROW_HOME, "bundles", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ id, name: id, type: "bundle", webUI }));
  writeFileSync(join(CROW_HOME, "installed.json"), JSON.stringify([{ id, type: "bundle" }]));
}

/** Upstream that records the Authorization header of every request it serves. */
async function startUpstream() {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers["authorization"] ?? null });
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("upstream ok");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, seen, port: server.address().port };
}

/** Mount the real proxy router; `auth` defaults to a pass-through. */
async function startGateway(auth = (req, res, next) => next()) {
  const app = express();
  const { router } = extensionProxyFactory(auth);
  app.use(router);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  return { server, port: server.address().port };
}

function get(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error("timeout")); });
  });
}

// ---------------------------------------------------------------------------
// (a) token present → header injected
// ---------------------------------------------------------------------------

test("a manifest webUI.authTokenFile makes the proxy inject Authorization: Bearer <token>", async () => {
  const up = await startUpstream();
  writeFileSync(join(CROW_HOME, "perch-token"), "tok-abc123\n");
  installWebUiBundle("perch-hub", { port: up.port, authTokenFile: "perch-token" });
  const gw = await startGateway();
  try {
    const res = await get(gw.port, "/proxy/perch-hub/bots");
    assert.equal(res.status, 200);
    assert.equal(up.seen.length, 1);
    assert.equal(up.seen[0].url, "/bots", "the /proxy/<id> prefix is stripped before the hub sees it");
    assert.equal(up.seen[0].auth, "Bearer tok-abc123",
      "the bearer must reach the backend — an v2-style top-level onProxyReq hook is silently ignored by http-proxy-middleware v3");
  } finally {
    gw.server.close(); up.server.close();
  }
});

// ---------------------------------------------------------------------------
// (a) laziness — the file appears AFTER the factory was constructed
// ---------------------------------------------------------------------------

test("a token file created AFTER the proxy factory was built is still picked up", async () => {
  const up = await startUpstream();
  const tokenPath = join(CROW_HOME, "late-token");
  try { rmSync(tokenPath, { force: true }); } catch {}
  installWebUiBundle("perch-hub", { port: up.port, authTokenFile: "late-token" });

  // Factory built with NO token file on disk — exactly the first boot after
  // install, where perch-runtime mints the token from the post-listen step.
  const gw = await startGateway();
  try {
    const before = await get(gw.port, "/proxy/perch-hub/a");
    assert.equal(before.status, 200);
    assert.equal(up.seen[0].auth, null, "no token file yet → no header (the hub 401s, honestly)");

    writeFileSync(tokenPath, "minted-after-boot");

    const afterReq = await get(gw.port, "/proxy/perch-hub/b");
    assert.equal(afterReq.status, 200);
    assert.equal(up.seen[1].auth, "Bearer minted-after-boot",
      "the token must be read per request, not once at factory-construction time");
  } finally {
    gw.server.close(); up.server.close();
  }
});

// ---------------------------------------------------------------------------
// (a) no authTokenFile → nothing injected
// ---------------------------------------------------------------------------

test("a webUI manifest without authTokenFile proxies with no Authorization header", async () => {
  const up = await startUpstream();
  installWebUiBundle("browser", { port: up.port });
  const gw = await startGateway();
  try {
    await get(gw.port, "/proxy/browser/vnc.html");
    assert.equal(up.seen.length, 1);
    assert.equal(up.seen[0].auth, null,
      "bundles that never asked for a bearer must not suddenly receive one");
  } finally {
    gw.server.close(); up.server.close();
  }
});

test("a named-but-missing token file omits the header rather than sending an empty bearer", async () => {
  const up = await startUpstream();
  installWebUiBundle("perch-hub", { port: up.port, authTokenFile: "no-such-token" });
  const gw = await startGateway();
  try {
    await get(gw.port, "/proxy/perch-hub/");
    assert.equal(up.seen[0].auth, null);
  } finally {
    gw.server.close(); up.server.close();
  }
});

// ---------------------------------------------------------------------------
// (a) websocket upgrade path
// ---------------------------------------------------------------------------

test("the websocket upgrade path gets the same bearer, via the v3 `on.proxyReqWs` hook", () => {
  writeFileSync(join(CROW_HOME, "perch-token"), "ws-token-xyz");
  installWebUiBundle("perch-hub", { port: 4210, authTokenFile: "perch-token" });

  const captured = [];
  const createProxy = (options) => {
    captured.push(options);
    const mw = (req, res, next) => next();
    mw.upgrade = () => {};
    return mw;
  };
  extensionProxyFactory((req, res, next) => next(), { createProxy });

  assert.equal(captured.length, 1);
  const options = captured[0];
  assert.equal(options.onProxyReq, undefined,
    "the v2 top-level onProxyReq is silently IGNORED by http-proxy-middleware v3 — hooks must live under `on`");
  assert.equal(typeof options.on.proxyReq, "function");
  assert.equal(typeof options.on.proxyReqWs, "function",
    "server.on('upgrade') never runs the proxyReq hook — without proxyReqWs, websockets reach the hub unauthenticated");

  for (const hook of [options.on.proxyReq, options.on.proxyReqWs]) {
    const headers = {};
    hook({ setHeader: (k, v) => { headers[k] = v; } });
    assert.equal(headers["Authorization"], "Bearer ws-token-xyz");
  }
});

// ---------------------------------------------------------------------------
// reader unit cases — path containment + trimming
// ---------------------------------------------------------------------------

test("readAuthToken: trims, treats empty as absent, and refuses to escape CROW_HOME", () => {
  const home = mkdtempSync(join(tmpdir(), "crow-token-read-"));
  try {
    writeFileSync(join(home, "tok"), "  padded-token \n");
    writeFileSync(join(home, "empty"), "   \n");
    assert.equal(readAuthToken("tok", home), "padded-token");
    assert.equal(readAuthToken("empty", home), null);
    assert.equal(readAuthToken(null, home), null);
    assert.equal(readAuthToken("missing", home), null);
    // A manifest is data on disk; it must not be able to name the operator's key.
    writeFileSync(join(home, "..", "outside-token"), "secret");
    assert.equal(readAuthToken("../outside-token", home), null,
      "authTokenFile must stay inside CROW_HOME");
  } finally {
    try { rmSync(home, { recursive: true, force: true }); } catch {}
    try { rmSync(join(home, "..", "outside-token"), { force: true }); } catch {}
  }
});

// ---------------------------------------------------------------------------
// auth gate — the proxy route is never reachable without the dashboard session
// ---------------------------------------------------------------------------

test("an unauthenticated request to /proxy/perch-hub/ is refused before it reaches the hub", async () => {
  const up = await startUpstream();
  writeFileSync(join(CROW_HOME, "perch-token"), "tok-abc123");
  installWebUiBundle("perch-hub", { port: up.port, authTokenFile: "perch-token" });
  // Stand-in for dashboardAuth: refuses, exactly as it does with no session.
  const gw = await startGateway((req, res) => res.status(401).json({ error: "unauthenticated" }));
  try {
    const res = await get(gw.port, "/proxy/perch-hub/bots");
    assert.equal(res.status, 401);
    assert.equal(up.seen.length, 0,
      "auth must run BEFORE the proxy — otherwise an unauthenticated caller reaches the hub WITH an injected bearer");
  } finally {
    gw.server.close(); up.server.close();
  }
});
