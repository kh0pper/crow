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
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProxyMiddleware } from "http-proxy-middleware";
import { createDbClient } from "../servers/db.js";
import { markFromLaptop } from "./helpers/off-box.js";

const CROW_HOME = mkdtempSync(join(tmpdir(), "crow-proxy-wstoken-"));
process.env.CROW_HOME = CROW_HOME;
// The token-carrying viewer's page is the owner's own sign-in only now, so this
// file needs real oauth_tokens rows; the owner gate reads crow.db through this.
const DB_PATH = join(CROW_HOME, "crow.db");
process.env.CROW_DB_PATH = DB_PATH;
after(() => {
  try { db.close(); } catch { /* never opened */ }
  try { rmSync(CROW_HOME, { recursive: true, force: true }); } catch {}
});

const { default: extensionProxyFactory, readWsHostToken, upgradeFromOwnOrigin } =
  await import("../servers/gateway/routes/extension-proxy.js");

const TOKEN = "a".repeat(8) + "0123456789abcdef".repeat(3) + "b".repeat(8);   // 64 chars, test value
const REPO_MANIFEST = JSON.parse(readFileSync(new URL("../bundles/browser/manifest.json", import.meta.url), "utf8"));

/** The owner's own sign-in: a plain 'dashboard' session (all that one is used
 * for here — see tests/extension-proxy-owner-only.test.js for the session tags). */
const OWNER_SESSION = "test-owner-session";
const db = createDbClient(DB_PATH);
await db.execute({
  sql: "CREATE TABLE IF NOT EXISTS oauth_tokens (token TEXT PRIMARY KEY, token_type TEXT, client_id TEXT, scopes TEXT, expires_at TEXT)",
  args: [],
});
await db.execute({
  sql: "INSERT OR REPLACE INTO oauth_tokens (token, token_type, client_id, scopes, expires_at) VALUES (?, 'access', 'dashboard', 'dashboard', ?)",
  args: [createHash("sha256").update(OWNER_SESSION).digest("hex"), new Date(Date.now() + 3_600_000).toISOString()],
});

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
  // dashboardAuth is stood in for (it refuses a bare-loopback peer outright): the
  // stub sets req.dashboardSession as the real one does, and marks the request as
  // the owner's laptop — a test's own call is from this machine, never the owner.
  const mws = [];
  const auth = (req, _res, next) => {
    const m = /(?:^|;\s*)crow_session=([^;]+)/.exec(req.headers.cookie || "");
    req.dashboardSession = m ? m[1] : undefined;
    markFromLaptop(req);
    next();
  };
  const { router } = extensionProxyFactory(auth, {
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
      http.get({ host: "127.0.0.1", port: gw.address().port, path: "/proxy/browser/vnc.html", headers: { cookie: `crow_session=${OWNER_SESSION}` } }, (res) => {
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

test("one proxyReqWs per bundle: the bearer for bundles that ask, the Host token only for the browser, nothing else", () => {
  writeFileSync(join(CROW_HOME, "hub-token"), "hub-bearer");
  const dirs = [
    ["perch-hub", { port: 4210, authTokenFile: "hub-token" }, null],
    ["browser", { ...REPO_MANIFEST.webUI, port: 4211 }, `CROW_BROWSER_VNC_TOKEN=${TOKEN}\n`],
    ["frigate", { port: 4212, path: "/" }, null],
  ];
  for (const [id, webUI, env] of dirs) {
    const d = join(CROW_HOME, "bundles", id); mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "manifest.json"), JSON.stringify({ id, name: id, webUI }));
    if (env) writeFileSync(join(d, ".env"), env); else rmSync(join(d, ".env"), { force: true });
  }
  writeFileSync(join(CROW_HOME, "installed.json"), JSON.stringify(dirs.map(([id]) => ({ id, type: "bundle" }))));
  const opts = [];
  extensionProxyFactory((q, s, n) => n(), { createProxy: (o) => { opts.push(o); const mw = (q, s, n) => n(); mw.upgrade = () => {}; return mw; } });
  const by = Object.fromEntries(opts.map((o) => [o.target, o]));
  const call = (hook) => { const h = {}; hook({ setHeader: (k, v) => { h[k] = v; }, getHeader: () => undefined }, { headers: {}, body: undefined, readableLength: 0 }); return h; };
  assert.deepEqual(call(by["http://127.0.0.1:4210"].on.proxyReqWs), { Authorization: "Bearer hub-bearer" });
  assert.deepEqual(call(by["http://127.0.0.1:4211"].on.proxyReqWs), { Host: TOKEN });
  assert.deepEqual(call(by["http://127.0.0.1:4212"].on.proxyReqWs), {});
  assert.equal(call(by["http://127.0.0.1:4211"].on.proxyReq).Host, undefined, "plain HTTP never carries it");
});

test("upgrade routing has a path boundary: /proxy/browser-x/… goes to browser-x, never to the browser", async () => {
  const d = (id, webUI, env) => {
    const p = join(CROW_HOME, "bundles", id); mkdirSync(p, { recursive: true });
    writeFileSync(join(p, "manifest.json"), JSON.stringify({ id, name: id, webUI }));
    if (env) writeFileSync(join(p, ".env"), env);
  };
  d("browser", { ...REPO_MANIFEST.webUI, port: 4311 }, `CROW_BROWSER_VNC_TOKEN=${TOKEN}\n`);
  d("browser-x", { port: 4312 });
  writeFileSync(join(CROW_HOME, "installed.json"), JSON.stringify([{ id: "browser", type: "bundle" }, { id: "browser-x", type: "bundle" }]));
  const hits = [];
  const { setupWebSocket } = extensionProxyFactory((q, s, n) => n(), {
    createProxy: (o) => { const mw = (q, s, n) => n(); mw.upgrade = () => hits.push(o.target); return mw; },
  });
  const server = new EventEmitter(); setupWebSocket(server);
  const fire = (url, headers) => new Promise((resolve) => {
    const written = [];
    const socket = { remoteAddress: "10.0.0.5", write: (x) => written.push(x), destroy: () => resolve(written.join("")) };
    server.emit("upgrade", { url, headers, socket, connection: socket }, socket, Buffer.alloc(0));
  });
  const w = console.warn; console.warn = () => {};
  try {
    // A foreign origin: the browser's origin check must NOT be the one answering browser-x.
    const r = await fire("/proxy/browser-x/ws", { host: "h", origin: "https://evil.example" });
    assert.match(r, /^HTTP\/1\.1 401/, "browser-x's own path: session check (no browser origin check) — " + r);
    assert.match(await fire("/proxy/browser/websockify", { host: "h", origin: "https://evil.example" }), /^HTTP\/1\.1 403/);
    assert.match(await fire("/proxy/browser?x=1", { host: "h", origin: "https://evil.example" }), /^HTTP\/1\.1 403/);
    assert.deepEqual(hits, []);
  } finally { console.warn = w; }
});
