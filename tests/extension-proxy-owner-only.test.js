/**
 * The browser viewer (the token-carrying noVNC) is the OWNER's own sign-in only.
 *
 * The gateway adds the per-instance WebSocket token to the upstream upgrade
 * (extension-proxy.js `proxyReqWs`), so what was left in front of the operator's
 * logged-in Chromium was the network rule plus verifySession — and verifySession
 * accepts ANY live dashboard session: one a paired peer's single sign-on minted
 * ('dashboard sso src:<peer>'), one from a login made on this machine
 * ('dashboard onhost'), and a request from this machine itself. Any of those
 * handed a non-owner full control of the browser. Both entry points — the HTTP
 * viewer page and the WebSocket upgrade — now also require
 * isLocalPasswordSession (servers/gateway/dashboard/local-session.js), the same
 * gate keychain saves, Media Hub and Services use. An extension WITHOUT
 * `webUI.wsHostTokenEnv` keeps exactly its old behaviour.
 *
 * Real sessions are seeded in oauth_tokens and the requests are made to look
 * like they come from the owner's laptop (tests/helpers/off-box.js): a test's own
 * loopback call is "this machine", and this machine is never the owner's turn.
 *
 * extension-proxy.js resolves CROW_HOME at module load, so it is pointed at a
 * scratch dir BEFORE the import (extension-proxy-ws-token.test.js idiom); the
 * owner gate reads crow.db through CROW_DB_PATH, set here for the same reason.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const CROW_HOME = mkdtempSync(join(tmpdir(), "crow-proxy-owner-"));
const DB_PATH = join(CROW_HOME, "crow.db");
process.env.CROW_HOME = CROW_HOME;
process.env.CROW_DB_PATH = DB_PATH;

const { default: extensionProxyFactory } = await import("../servers/gateway/routes/extension-proxy.js");
const { createDbClient } = await import("../servers/db.js");
const { setInterfaceTableForTests } = await import("../servers/shared/ip-classify.js");
const { markFromLaptop } = await import("./helpers/off-box.js");

/** This box is 10.0.0.5 on the LAN and 100.64.20.1 on the tailnet; the owner's
 * laptop is 10.0.0.42. An injected interface table keeps "not this machine"
 * deterministic (tests/self-origin.test.js idiom), and a 10.x address is
 * private, so isAllowedNetwork's direct-peer rule allows the upgrade as it does
 * in the field. */
const OWNER_LAPTOP = "10.0.0.42";
const TABLE = {
  lo: [
    { address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", cidr: "127.0.0.1/8" },
    { address: "::1", netmask: "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", family: "IPv6", cidr: "::1/128" },
  ],
  eno1: [{ address: "10.0.0.5", netmask: "255.255.255.0", family: "IPv4", cidr: "10.0.0.5/24" }],
  tailscale0: [
    { address: "100.64.20.1", netmask: "255.255.255.255", family: "IPv4", cidr: "100.64.20.1/32" },
    { address: "fd7a:115c:a1e0::1", netmask: "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", family: "IPv6", cidr: "fd7a:115c:a1e0::1/128" },
  ],
};
setInterfaceTableForTests(() => TABLE);

// ---------------------------------------------------------------------------
// real dashboard sessions
// ---------------------------------------------------------------------------

const db = createDbClient(DB_PATH);
await db.execute({
  sql: "CREATE TABLE IF NOT EXISTS oauth_tokens (token TEXT PRIMARY KEY, token_type TEXT, client_id TEXT, scopes TEXT, expires_at TEXT)",
  args: [],
});

const SESSION = { owner: "s-owner", onhost: "s-onhost", sso: "s-sso" };
const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
for (const [tok, scopes] of [
  [SESSION.owner, "dashboard"],
  [SESSION.onhost, "dashboard onhost"],
  [SESSION.sso, "dashboard sso src:peer1"],
]) {
  await db.execute({
    sql: "INSERT OR REPLACE INTO oauth_tokens (token, token_type, client_id, scopes, expires_at) VALUES (?, 'access', 'dashboard', ?, ?)",
    args: [createHash("sha256").update(tok).digest("hex"), scopes, expiresAt],
  });
}

after(() => {
  try { setInterfaceTableForTests(null); } catch {}
  try { db.close(); } catch {}
  try { rmSync(CROW_HOME, { recursive: true, force: true }); } catch {}
});

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const TOKEN = "b".repeat(8) + "0123456789abcdef".repeat(3) + "c".repeat(8);   // 64 chars, test value
const REPO_MANIFEST = JSON.parse(readFileSync(new URL("../bundles/browser/manifest.json", import.meta.url), "utf8"));

/** installed.json + one bundle (manifest, and a .env when `envText` is given) —
 * getProxiedExtensions() reads both when the factory is constructed. */
function installBundle(id, webUI, envText = null) {
  const dir = join(CROW_HOME, "bundles", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ id, name: id, type: "bundle", webUI }));
  if (envText !== null) writeFileSync(join(dir, ".env"), envText, { mode: 0o600 });
  writeFileSync(join(CROW_HOME, "installed.json"), JSON.stringify([{ id, type: "bundle" }]));
}

/** The browser bundle as installed on this box: the token-carrying viewer. */
const installBrowser = (port) =>
  installBundle("browser", { ...REPO_MANIFEST.webUI, port }, `CROW_BROWSER_VNC_TOKEN=${TOKEN}\n`);

/** An ordinary proxied web UI: no `wsHostTokenEnv`, so nothing changes for it. */
const installPlainUi = (port) => installBundle("plainui", { port, path: "/" });

/** Upstream that records the Host of every plain request and every upgrade. */
async function startUpstream() {
  const seen = { http: [], ws: [] };
  const server = http.createServer((req, res) => {
    seen.http.push(req.headers.host);
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("upstream ok");
  });
  server.on("upgrade", (req, socket) => {
    seen.ws.push(req.headers.host);
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    setTimeout(() => socket.end(), 50);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, seen, port: server.address().port };
}

/**
 * A stand-in for dashboardAuth: it sets req.dashboardSession from the cookie
 * (as the real one does) and marks the request as coming from the owner's
 * laptop. The real dashboardAuth refuses a bare-loopback peer outright, so a
 * test can never drive it from loopback — same seam tests/self-origin.test.js
 * uses for the keychain routes.
 */
function laptopAuth(req, _res, next) {
  const m = /(?:^|;\s*)crow_session=([^;]+)/.exec(req.headers.cookie || "");
  req.dashboardSession = m ? m[1] : undefined;
  markFromLaptop(req, OWNER_LAPTOP);
  next();
}

async function startGateway({ auth = laptopAuth, websocket = false } = {}) {
  const { router, setupWebSocket } = extensionProxyFactory(auth);
  const app = express();
  app.use(router);
  const server = http.createServer(app);
  // Registered BEFORE setupWebSocket, so its handler runs first: the connection
  // is loopback, but the gateway must see the owner's laptop.
  server.on("upgrade", (req) => markFromLaptop(req, OWNER_LAPTOP));
  if (websocket) setupWebSocket(server);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: server.address().port };
}

function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path, headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error("timeout")); });
  });
}

/** A browser-shaped upgrade: the Origin names the Host it is sent to. Resolves
 * with the status code (101 for a backend that accepted), or null when the
 * gateway wrote a bare status line and dropped the connection. */
function upgrade(port, path, session) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const req = http.request({
      host: "127.0.0.1",
      port,
      path,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        Host: "dash.example.test",
        Origin: "https://dash.example.test",
        ...(session ? { cookie: `crow_session=${session}` } : {}),
      },
    });
    req.on("upgrade", (res, socket) => { socket.destroy(); finish(res.statusCode); });
    req.on("response", (res) => { res.resume(); finish(res.statusCode); });
    req.on("error", () => finish(null));
    req.setTimeout(5000, () => { req.destroy(); finish(null); });
    req.end();
  });
}

/** Drive setupWebSocket's own handler with a fake upgrade socket, so the exact
 * status line it writes is observable. */
function fakeUpgrade(server, headers) {
  return new Promise((resolve) => {
    const written = [];
    const socket = { remoteAddress: OWNER_LAPTOP, write: (s) => written.push(s), destroy: () => resolve(written.join("")) };
    server.emit("upgrade", { url: "/proxy/browser/websockify", headers, socket, connection: socket }, socket, Buffer.alloc(0));
  });
}

/** A factory whose proxy is a stub: it records "the backend was reached". */
function stubGateway() {
  const reached = [];
  const { setupWebSocket } = extensionProxyFactory((req, res, next) => next(), {
    createProxy: (opts) => {
      const mw = (req, res, next) => next();
      mw.upgrade = (req, socket) => { reached.push(opts.target); try { socket.destroy?.(); } catch { /* fake socket */ } };
      return mw;
    },
  });
  const server = new EventEmitter();
  setupWebSocket(server);
  return { reached, server };
}

const browserUpgradeHeaders = (session) => ({
  host: "dash.example.test",
  origin: "https://dash.example.test",
  ...(session ? { cookie: `crow_session=${session}` } : {}),
});

// ---------------------------------------------------------------------------
// the WebSocket upgrade
// ---------------------------------------------------------------------------

test("the upgrade: a peer's SSO session and an on-host login are refused, the owner's own sign-in reaches the backend", async () => {
  installBrowser(4999);
  const { reached, server } = stubGateway();

  assert.match(await fakeUpgrade(server, browserUpgradeHeaders(SESSION.sso)), /^HTTP\/1\.1 403/,
    "a session a paired peer's single sign-on minted is a live session but not the owner's");
  assert.match(await fakeUpgrade(server, browserUpgradeHeaders(SESSION.onhost)), /^HTTP\/1\.1 403/,
    "a session minted by a login from this machine is not the owner's either");
  assert.deepEqual(reached, [], "the backend never saw an upgrade");

  assert.doesNotMatch(await fakeUpgrade(server, browserUpgradeHeaders(SESSION.owner)), /^HTTP\/1\.1 403/,
    "the owner's own local password session is let through");
  assert.equal(reached.length, 1);
});

test("the owner's real upgrade reaches the backend with the token as its Host header", async () => {
  const up = await startUpstream();
  installBrowser(up.port);
  const gw = await startGateway({ websocket: true });
  try {
    assert.equal(await upgrade(gw.port, "/proxy/browser/websockify", SESSION.owner), 101);
    assert.deepEqual(up.seen.ws, [TOKEN], "the token is the upstream Host on the owner's upgrade");
  } finally {
    gw.server.close(); up.server.close();
  }
});

test("an SSO session's real upgrade to the token-carrying viewer never reaches the backend", async () => {
  const up = await startUpstream();
  installBrowser(up.port);
  const gw = await startGateway({ websocket: true });
  try {
    const status = await upgrade(gw.port, "/proxy/browser/websockify", SESSION.sso);
    assert.notEqual(status, 101, `refused, not upgraded (got ${status})`);
    // null: the gateway wrote a bare "HTTP/1.1 403 Forbidden" line and dropped the
    // socket, which the client may report as a connection error instead of a status.
    assert.ok(status === 403 || status === null, `403 from the gateway (got ${status})`);
    assert.deepEqual(up.seen.ws, [], "the backend never saw an upgrade");
  } finally {
    gw.server.close(); up.server.close();
  }
});

test("an extension WITHOUT a websocket token is unchanged: an SSO session's upgrade still goes through", async () => {
  const up = await startUpstream();
  installPlainUi(up.port);
  const gw = await startGateway({ websocket: true });
  try {
    assert.equal(await upgrade(gw.port, "/proxy/plainui/socket", SESSION.sso), 101);
    assert.equal(up.seen.ws.length, 1);
  } finally {
    gw.server.close(); up.server.close();
  }
});

// ---------------------------------------------------------------------------
// the HTTP viewer page
// ---------------------------------------------------------------------------

test("the viewer page: an SSO session gets a 403 plain-text refusal and its backend is never asked", async () => {
  const up = await startUpstream();
  installBrowser(up.port);
  const gw = await startGateway();
  try {
    const refused = await get(gw.port, "/proxy/browser/vnc.html", { cookie: `crow_session=${SESSION.sso}` });
    assert.equal(refused.status, 403);
    assert.match(String(refused.headers["content-type"]), /^text\/plain/);
    assert.ok(refused.body.trim().length > 0 && refused.body.length < 200, "a short plain-text body, never the viewer page");
    assert.equal(up.seen.http.length, 0, "the viewer page's backend was never asked");
  } finally {
    gw.server.close(); up.server.close();
  }
});

test("the viewer page: the owner's own sign-in is proxied to the backend", async () => {
  const up = await startUpstream();
  installBrowser(up.port);
  const gw = await startGateway();
  try {
    const page = await get(gw.port, "/proxy/browser/vnc.html", { cookie: `crow_session=${SESSION.owner}` });
    assert.equal(page.status, 200);
    assert.equal(page.body, "upstream ok");
    assert.equal(up.seen.http.length, 1);
  } finally {
    gw.server.close(); up.server.close();
  }
});

test("the viewer page: an on-host login is refused too", async () => {
  const up = await startUpstream();
  installBrowser(up.port);
  const gw = await startGateway();
  try {
    const refused = await get(gw.port, "/proxy/browser/vnc.html", { cookie: `crow_session=${SESSION.onhost}` });
    assert.equal(refused.status, 403);
    assert.equal(up.seen.http.length, 0);
  } finally {
    gw.server.close(); up.server.close();
  }
});

test("a page for an extension WITHOUT a websocket token is unchanged: an SSO session is proxied", async () => {
  const up = await startUpstream();
  installPlainUi(up.port);
  const gw = await startGateway();
  try {
    const page = await get(gw.port, "/proxy/plainui/index.html", { cookie: `crow_session=${SESSION.sso}` });
    assert.equal(page.status, 200);
    assert.equal(page.body, "upstream ok");
    assert.equal(up.seen.http.length, 1);
  } finally {
    gw.server.close(); up.server.close();
  }
});
test("B2: after the owner has loaded the viewer page, an SSO upgrade and a cookieless one still never reach the backend", async () => {
  const up = await startUpstream();
  installBrowser(up.port);
  const gw = await startGateway({ websocket: true });
  try {
    const before = gw.server.listenerCount("upgrade");
    const page = await get(gw.port, "/proxy/browser/vnc.html", { cookie: `crow_session=${SESSION.owner}` });
    assert.equal(page.status, 200, "the owner's page load is proxied");
    assert.equal(gw.server.listenerCount("upgrade"), before, "the page load added no upgrade listener of its own");
    for (const session of [SESSION.sso, null]) {
      const status = await upgrade(gw.port, "/proxy/browser/websockify", session);
      assert.notEqual(status, 101, `refused (${session ? "sso" : "no cookie"}, got ${status})`);
    }
    assert.notEqual(await upgrade(gw.port, "/websockify", null), 101, "an upgrade on another path is not proxied either");
    assert.deepEqual(up.seen.ws, [], "the backend never saw an upgrade, so never the token");
  } finally {
    gw.server.closeAllConnections?.(); gw.server.close(); up.server.close();
  }
});
