/**
 * The browser's noVNC WebSocket token (`webUI.wsHostTokenEnv`), added by the
 * gateway's extension proxy server-side.
 *
 * websockify (--host-token) connects a WebSocket to RFB only when the
 * upgrade's Host header is the per-instance token from the bundle's own .env.
 * The gateway sets it on the upstream upgrade, after the origin and session
 * checks; no page, script, URL or listing carries it.
 *
 * extension-proxy.js resolves CROW_HOME at module load, so it is pointed at a
 * scratch dir BEFORE the import (extension-proxy-auth-token.test.js idiom).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProxyMiddleware } from "http-proxy-middleware";

const CROW_HOME = mkdtempSync(join(tmpdir(), "crow-proxy-wstoken-"));
process.env.CROW_HOME = CROW_HOME;
after(() => { try { rmSync(CROW_HOME, { recursive: true, force: true }); } catch {} });

const { default: extensionProxyFactory, readWsHostToken, upgradeFromOwnOrigin } =
  await import("../servers/gateway/routes/extension-proxy.js");

const TOKEN = "a".repeat(8) + "0123456789abcdef".repeat(3) + "b".repeat(8);   // 64 chars, test value
const REPO_MANIFEST = JSON.parse(readFileSync(new URL("../bundles/browser/manifest.json", import.meta.url), "utf8"));

function installBrowser(port, envText) {
  const dir = join(CROW_HOME, "bundles", "browser");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...REPO_MANIFEST, webUI: { ...REPO_MANIFEST.webUI, port } }));
  if (envText === null) rmSync(join(dir, ".env"), { force: true });
  else writeFileSync(join(dir, ".env"), envText, { mode: 0o600 });
  writeFileSync(join(CROW_HOME, "installed.json"), JSON.stringify([{ id: "browser", type: "bundle" }]));
}

test("readWsHostToken: the bundle's own .env key, only a plain token, read fresh each time", () => {
  installBrowser(1, `CROW_BROWSER_VNC_TOKEN=${TOKEN}\n`);
  assert.equal(readWsHostToken("browser", "CROW_BROWSER_VNC_TOKEN", CROW_HOME), TOKEN);
  installBrowser(1, "CROW_BROWSER_VNC_TOKEN=short\n");
  assert.equal(readWsHostToken("browser", "CROW_BROWSER_VNC_TOKEN", CROW_HOME), null, "too short: never sent");
  installBrowser(1, `CROW_BROWSER_VNC_TOKEN=${TOKEN}\\r\\nX: y\n`);
  assert.equal(readWsHostToken("browser", "CROW_BROWSER_VNC_TOKEN", CROW_HOME), null, "header-breaking characters: never sent");
  installBrowser(1, null);
  assert.equal(readWsHostToken("browser", "CROW_BROWSER_VNC_TOKEN", CROW_HOME), null, "no .env: no token");
  installBrowser(1, `CROW_BROWSER_VNC_TOKEN=${TOKEN}\n`);
  assert.equal(readWsHostToken("browser", "../x", CROW_HOME), null, "a bad key name");
  assert.equal(readWsHostToken("browser", null, CROW_HOME), null);
});

test("the real proxy sets the token as the upstream Host on the WebSocket upgrade, and nowhere else", async () => {
  // Upstream: records the Host of every plain request and every upgrade.
  const seen = { http: [], ws: [] };
  const up = http.createServer((req, res) => { seen.http.push(req.headers.host); res.end("ok"); });
  up.on("upgrade", (req, socket) => {
    seen.ws.push(req.headers.host);
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    setTimeout(() => socket.end(), 50);
  });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  installBrowser(up.address().port, "CROW_BROWSER_CDP_PORT=1\n");   // the token is not there yet

  // The real http-proxy-middleware, captured through the factory's seam; the
  // upgrade is driven directly (setupWebSocket's own checks are tested below).
  const mws = [];
  const { router } = extensionProxyFactory((req, res, next) => next(), {
    createProxy: (opts) => { const mw = createProxyMiddleware(opts); mws.push(mw); return mw; },
  });
  const app = express(); app.use(router);
  const gw = http.createServer(app);
  gw.on("upgrade", (req, socket, head) => mws[0].upgrade(req, socket, head));
  await new Promise((r) => gw.listen(0, "127.0.0.1", r));
  const upgrade = () => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: gw.address().port, path: "/proxy/browser/websockify",
      headers: { Connection: "Upgrade", Upgrade: "websocket", Host: "dash.example.test", Origin: "https://dash.example.test" } });
    req.on("upgrade", (res, socket) => { socket.destroy(); resolve(res.statusCode); });
    req.on("response", (res) => resolve(res.statusCode));
    req.on("error", reject);
    req.end();
  });
  try {
    assert.equal(await upgrade(), 101);
    assert.notEqual(seen.ws[0], TOKEN, "no token in the .env yet: none sent (websockify then refuses)");

    writeFileSync(join(CROW_HOME, "bundles", "browser", ".env"), `CROW_BROWSER_CDP_PORT=1\nCROW_BROWSER_VNC_TOKEN=${TOKEN}\n`, { mode: 0o600 });
    assert.equal(await upgrade(), 101);
    assert.equal(seen.ws[1], TOKEN, "added later, read per upgrade, sent as the upstream Host");

    const page = await new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port: gw.address().port, path: "/proxy/browser/vnc.html" }, (res) => {
        let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve(b));
      }).on("error", reject);
    });
    assert.equal(page, "ok");
    assert.ok(!seen.http.includes(TOKEN), "plain page requests never carry it");

    const listing = await new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port: gw.address().port, path: "/proxy" }, (res) => {
        let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve(b));
      }).on("error", reject);
    });
    assert.ok(listing.includes('"browser"') && !listing.includes(TOKEN), "the /proxy listing never carries it");
  } finally {
    gw.close(); up.close();
  }
});

test("upgradeFromOwnOrigin: the Origin must name the host the request was sent to (Host or Serve's X-Forwarded-Host)", () => {
  const r = (headers) => ({ headers });
  assert.equal(upgradeFromOwnOrigin(r({ host: "crow.example.ts.net:8444", origin: "https://crow.example.ts.net:8444" })), true);
  assert.equal(upgradeFromOwnOrigin(r({ host: "127.0.0.1:3001", "x-forwarded-host": "crow.example.ts.net:8444", origin: "https://crow.example.ts.net:8444" })), true, "behind Serve");
  assert.equal(upgradeFromOwnOrigin(r({ host: "crow.example.ts.net:8444" })), false, "no Origin");
  assert.equal(upgradeFromOwnOrigin(r({ host: "crow.example.ts.net:8444", origin: "https://evil.example" })), false, "a foreign page");
  assert.equal(upgradeFromOwnOrigin(r({ host: "crow.example.ts.net:8444", origin: "https://crow.example.ts.net:8445" })), false, "another port is another origin");
  assert.equal(upgradeFromOwnOrigin(r({ host: "crow.example.ts.net:8444", origin: "null" })), false, "an opaque origin");
  assert.equal(upgradeFromOwnOrigin(r({ host: "crow.example.ts.net:8444", origin: "file://crow.example.ts.net:8444" })), false);
});

test("setupWebSocket refuses a token-carrying upgrade from a foreign or missing Origin before anything else, and one with no session", async () => {
  installBrowser(4999, `CROW_BROWSER_VNC_TOKEN=${TOKEN}\n`);
  let upgraded = 0;
  const { setupWebSocket } = extensionProxyFactory((req, res, next) => next(), {
    createProxy: () => { const mw = (req, res, next) => next(); mw.upgrade = () => { upgraded++; }; return mw; },
  });
  const server = new EventEmitter();
  setupWebSocket(server);
  const fire = (headers, remoteAddress = "10.0.0.5") => new Promise((resolve) => {
    const written = [];
    const socket = { remoteAddress, write: (s) => written.push(s), destroy: () => resolve(written.join("")) };
    server.emit("upgrade", { url: "/proxy/browser/websockify", headers, socket, connection: socket }, socket, Buffer.alloc(0));
  });
  const w = console.warn; console.warn = () => {};
  try {
    assert.match(await fire({ host: "dash.example.test", origin: "https://evil.example", cookie: "crow_session=x" }), /^HTTP\/1\.1 403/);
    assert.match(await fire({ host: "dash.example.test", cookie: "crow_session=x" }), /^HTTP\/1\.1 403/, "no Origin");
    assert.match(await fire({ host: "dash.example.test", origin: "https://dash.example.test" }), /^HTTP\/1\.1 401/, "own origin, no session");
    assert.equal(upgraded, 0, "nothing reached the backend");
  } finally { console.warn = w; }
});

test("no client code, page or panel HTML carries the token or names its key", async () => {
  const { perchHubJs } = await import("../servers/gateway/dashboard/perch-hub/client.js");
  for (const lang of ["en", "es"]) assert.doesNotMatch(perchHubJs(lang), /VNC_TOKEN|[?&]token=/, lang);
  for (const f of ["servers/gateway/dashboard/perch-hub/take-over.js", "servers/gateway/dashboard/perch-hub/browser-tile.js",
    "servers/gateway/apps/catalog.js", "servers/gateway/apps/app-tile.js", "bundles/browser/panel/browser.js", "bundles/browser/panel/routes.js",
    "bundles/browser/server/server.js"]) {
    assert.doesNotMatch(readFileSync(new URL("../" + f, import.meta.url), "utf8"), /VNC_TOKEN|[?&]token=/, f);
  }
});
