// The login and password-reset pages are network-gated — and so are the 2FA
// steps that finish a login (POST /dashboard/login/2fa and the recovery routes)
// and the 2FA setup steps (GET/POST /dashboard/login/2fa/setup).
//
// dashboardAuth (servers/gateway/dashboard/auth.js) already refuses a source that
// isAllowedNetwork() rejects, but the PUBLIC routes — GET/POST /dashboard/login,
// GET/POST /dashboard/reset, POST /dashboard/reset/complete, the 2FA login steps
// and the 2FA setup steps — are mounted before it, so without their own gate a
// source the rest of
// the dashboard refuses still got a password form to guess into (and, on a fresh
// install, a setup page), or a TOTP code to guess into.
//
// The gate is isAllowedNetwork() plus ONE exemption: a request straight off this
// machine's loopback socket (loginNetworkAllowed), because that is the first-run
// setup path and the owner at the console. Everything else — a public address, a
// Funnel request, a loopback socket carrying forwarding/tailscale headers — is
// refused with the same 403 page dashboardAuth sends.
//
// The refused cases go through the REAL dashboard router: the peer address is
// overridden on the socket (an x-test-peer header read by a test-only shim), which
// is the only way to make an in-process HTTP client look like a public peer
// without planting the peer-class memo (a memo would leave isDirectLoopback's own
// loopback test reading 127.0.0.1). "Never touched" is proven against a real
// database: the password check and the lockout counter both write rows, so a
// refused request must leave dashboard_settings and audit_log byte-for-byte alone.

import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scryptSync, randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import {
  dashboardAuth,
  isAllowedNetwork,
  loginNetworkAllowed,
  sendNetworkRefusal,
  attemptLogin,
  sessionAuth,
} from "../servers/gateway/dashboard/auth.js";
import { listenProxySocketForTests, closeProxySocket } from "../servers/gateway/proxy-socket.js";

// --- request / env helpers --------------------------------------------------

// The decision is made on the TCP peer (req.socket), never req.ip: `ip` here is
// the socket address, and `req.ip` is deliberately something else.
function mkReq({ ip = "127.0.0.1", headers = {}, socket = {} } = {}) {
  const sock = { remoteAddress: ip, ...socket };
  return { ip: "203.0.113.250", headers, socket: sock, connection: sock };
}

function withEnv(vars, fn) {
  const prev = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const done = () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  let out;
  try {
    out = fn();
  } catch (e) {
    done();
    throw e;
  }
  if (out && typeof out.then === "function") return out.finally(done);
  done();
  return out;
}

/** The env a refusal case must not inherit from the host shell. */
const GATE_OFF = {
  CROW_DASHBOARD_PUBLIC: undefined,
  CROW_ALLOWED_IPS: undefined,
  CROW_TRUSTED_PROXIES: undefined,
  CROW_SETUP_TOKEN: undefined,
};

// --- minimal database -------------------------------------------------------

const DDL = `
  CREATE TABLE dashboard_settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT
  );
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT,
    actor TEXT,
    ip_address TEXT,
    details TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE oauth_tokens (
    token TEXT PRIMARY KEY,
    token_type TEXT NOT NULL CHECK(token_type IN ('access', 'refresh')),
    client_id TEXT NOT NULL,
    scopes TEXT DEFAULT '',
    resource TEXT,
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
`;

/** A DB with a real (verifiable) password and an empty audit log. */
function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "crow-login-gate-"));
  const path = join(dir, "crow.db");
  const d = new Database(path);
  d.exec(DDL);
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync("correct horse battery staple", salt, 64).toString("hex");
  d.prepare("INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('password_hash', ?, datetime('now'))")
    .run(`${salt}:${hash}`);
  d.close();
  return { dir, path };
}

function dbRows(path, sql, args = []) {
  const d = new Database(path, { readonly: true });
  try { return d.prepare(sql).all(...args); } finally { d.close(); }
}

const lockoutRows = (path) =>
  dbRows(path, "SELECT key, value FROM dashboard_settings WHERE key LIKE 'lockout:%'");
const auditRows = (path) => dbRows(path, "SELECT event_type, ip_address FROM audit_log");

/** Every write a login/reset handler would make to the auth state. */
function authState(path) {
  return {
    settings: dbRows(path, "SELECT key, value FROM dashboard_settings ORDER BY key"),
    audit: auditRows(path),
  };
}

// --- the real dashboard router ---------------------------------------------

/** A test-only shim: make the request look like it came from another machine. An
 * unknown header changes nothing else in classifyPeer/isAllowedNetwork. */
const PEER_HEADER = "x-test-peer";
function peerShim(req, res, next) {
  const addr = req.headers[PEER_HEADER];
  if (addr) {
    Object.defineProperty(req.socket, "remoteAddress", { value: addr, configurable: true, writable: true });
  }
  next();
}

async function startDashboard({ socketPath } = {}) {
  const { default: dashboardRouter } = await import("../servers/gateway/dashboard/index.js");
  const app = express();
  app.use(peerShim);
  app.use((req, res, next) => { res.redirectAfterPost = (url) => res.redirect(303, url); next(); });
  // A stub for the panels' mcp auth: these tests never reach a panel.
  app.use(dashboardRouter((req, res, next) => res.status(401).end()));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  if (socketPath) {
    // The dedicated proxy socket Caddy dials (proxy-socket.js marks every
    // connection accepted there), which is how a Caddy peer is modelled: a
    // unix socket has no peer address, so only the marker can vouch for it.
    const proxy = listenProxySocketForTests(app, server, socketPath, { log: () => {} });
    assert.ok(proxy, "the test-only proxy listener starts");
    await once(proxy, "listening");
    server.proxySocket = proxy;
  }
  return server;
}

function request(port, path, { method = "GET", headers = {}, body = null, peer = null } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null
      : typeof body === "string" ? body : new URLSearchParams(body).toString();
    const req = http.request({
      host: "127.0.0.1",
      port,
      path,
      method,
      headers: {
        ...(payload ? { "content-type": "application/x-www-form-urlencoded", "content-length": Buffer.byteLength(payload) } : {}),
        ...(peer ? { [PEER_HEADER]: peer } : {}),
        ...headers,
      },
    }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** The public auth routes, in the shape a password (or code) guesser would use. */
const PUBLIC_AUTH_ROUTES = [
  { path: "/dashboard/login" },
  { path: "/dashboard/login", method: "POST", body: { password: "guess-guess-guess" } },
  { path: "/dashboard/reset" },
  { path: "/dashboard/reset", method: "POST", body: {} },
  { path: "/dashboard/reset/complete", method: "POST", body: { token: "tok", password: "guess-guess-guess", confirm: "guess-guess-guess" } },
  // The 2FA steps that finish a login carry their own gate.
  { path: "/dashboard/login/2fa", method: "POST", body: { totp_code: "000000" } },
  { path: "/dashboard/login/2fa/recovery" },
  { path: "/dashboard/login/2fa/recovery", method: "POST", body: { recovery_code: "aaaa-bbbb" } },
  // So do the 2FA setup steps: a refused source must not be handed a fresh
  // secret (which would replace the live one) nor get to verify a code.
  { path: "/dashboard/login/2fa/setup" },
  { path: "/dashboard/login/2fa/setup", method: "POST", body: { totp_code: "000000", secret: "JBSWY3DPEHPK3PXP" } },
];

function label(route) {
  return `${route.method || "GET"} ${route.path}`;
}

// --- the gate itself --------------------------------------------------------

test("loginNetworkAllowed: a public, non-loopback source is refused", () => {
  const refused = mkReq({ ip: "203.0.113.7" });
  assert.equal(isAllowedNetwork(refused), false);
  assert.equal(loginNetworkAllowed(refused), false);
});

test("loginNetworkAllowed: LAN and tailnet sources stay allowed", () => {
  for (const ip of ["192.168.1.20", "10.0.0.5", "172.16.0.1", "100.64.20.5", "100.96.0.7", "fd7a:115c:a1e0::1234"]) {
    const req = mkReq({ ip });
    assert.equal(isAllowedNetwork(req), true, ip);
    assert.equal(loginNetworkAllowed(req), true, ip);
  }
});

test("loginNetworkAllowed: direct loopback stays allowed (first-run setup, owner at the console)", () => {
  // Bare loopback is NOT an allowed network — isAllowedNetwork refuses it — so
  // these pass only because of the loopback exemption.
  for (const ip of ["127.0.0.1", "::1"]) {
    const req = mkReq({ ip });
    assert.equal(isAllowedNetwork(req), false, ip);
    assert.equal(loginNetworkAllowed(req), true, ip);
  }
});

test("loginNetworkAllowed: a Funnel request is refused even from a tailnet address", () => {
  const req = mkReq({ ip: "100.64.20.5", headers: { "tailscale-funnel-request": "?1" } });
  assert.equal(isAllowedNetwork(req), false);
  assert.equal(loginNetworkAllowed(req), false);
});

test("loginNetworkAllowed: loopback carrying forwarding or tailscale headers is not 'direct loopback'", () => {
  for (const headers of [
    { "x-forwarded-for": "203.0.113.7" },
    { "x-real-ip": "203.0.113.7" },
    { forwarded: "for=203.0.113.7" },
    { "tailscale-user-login": "alice@example.com" }, // a Serve-shaped socket no test process can vouch for
    { "tailscale-funnel-request": "?1" },
  ]) {
    const req = mkReq({ ip: "127.0.0.1", headers });
    assert.equal(isAllowedNetwork(req), false, JSON.stringify(headers));
    assert.equal(loginNetworkAllowed(req), false, JSON.stringify(headers));
  }
});

test("loginNetworkAllowed: CROW_DASHBOARD_PUBLIC=true opens a public source", () => {
  withEnv({ CROW_DASHBOARD_PUBLIC: "true" }, () => {
    const req = mkReq({ ip: "203.0.113.7" });
    assert.equal(isAllowedNetwork(req), true);
    assert.equal(loginNetworkAllowed(req), true);
  });
});

test("loginNetworkAllowed is never more permissive than isAllowedNetwork for a non-loopback source", () => {
  for (const ip of ["203.0.113.7", "8.8.8.8", "1.2.3.4", "fd7a:115c:a1e1::1"]) {
    const req = mkReq({ ip });
    assert.equal(isAllowedNetwork(req), false, ip);
    assert.equal(loginNetworkAllowed(req), false, ip);
  }
});

// --- the refusal page -------------------------------------------------------

function captureRes() {
  const out = { status: null, type: null, body: null };
  const res = {
    status(c) { out.status = c; return this; },
    type(t) { out.type = t; return this; },
    send(b) { out.body = b; return this; },
  };
  return { res, out };
}

test("sendNetworkRefusal: exactly the page dashboardAuth sends, same 403, same i18n keys", () => {
  for (const cookie of ["crow_lang=en", "crow_lang=es"]) {
    const req = mkReq({ ip: "203.0.113.7", headers: { cookie } });
    const direct = captureRes();
    sendNetworkRefusal(req, direct.res);
    const viaAuth = captureRes();
    let nexted = false;
    dashboardAuth(req, viaAuth.res, () => { nexted = true; });
    assert.equal(nexted, false, "dashboardAuth must refuse, not pass");
    assert.equal(direct.out.status, 403);
    assert.equal(direct.out.type, "html");
    assert.deepEqual(direct.out, viaAuth.out, `identical output (${cookie})`);
    assert.match(direct.out.body, cookie.endsWith("es") ? /Acceso denegado/ : /Access Denied/);
    assert.doesNotMatch(direct.out.body, /name="password"/, "no password form is ever served on the refusal page");
  }
});

// --- the real router: refused sources --------------------------------------

test("a refused source gets 403 on every login/reset route and never reaches the password check or the lockout counter", async () => {
  const { dir, path } = freshDb();
  const before = authState(path);
  const server = await startDashboard();
  try {
    const port = server.address().port;
    for (const route of PUBLIC_AUTH_ROUTES) {
      const r = await withEnv({ ...GATE_OFF, CROW_DB_PATH: path }, () =>
        request(port, route.path, { method: route.method, body: route.body, peer: "203.0.113.7" }));
      assert.equal(r.status, 403, `${label(route)} must be refused, got ${r.status}`);
      assert.match(r.body, /Access Denied/, label(route));
      assert.doesNotMatch(r.body, /name="password"/, `${label(route)} must not serve a password form`);
      assert.equal(r.headers["set-cookie"], undefined, `${label(route)} must not mint a cookie`);
    }
    // The password check, the lockout counter and the audit trail are all writes:
    // a request that never ran one leaves the database exactly as it was.
    assert.deepEqual(authState(path), before, "no auth state was touched");
    assert.deepEqual(lockoutRows(path), [], "the lockout counter was never bumped");
    assert.deepEqual(auditRows(path), [], "no login attempt was recorded");
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a refused source never reaches the 2FA setup gate: no setup page, no secret saved, no code verified", async () => {
  // The gate under test is the network one. Both loops below send the same two
  // requests — once with no cookie, once carrying a REAL session — from the
  // refused peer. The session is minted by the gateway's own login path
  // (attemptLogin against a real password hash) and 2FA is NOT enabled on this
  // DB, so nothing but its source stops a signed-in caller here: twoFactorSetupGate
  // passes a live session through, and the GET then writes the TOTP secret
  // (the positive control below does exactly that on an allowed peer). Without
  // this route's gate the refused request would fall through to that same
  // session check, which shares the network rule and answers 302 — hence the
  // status and `location` assertions below, plus the row check.
  const { dir, path } = freshDb();
  const server = await startDashboard();
  try {
    const port = server.address().port;
    const { token, error } = await withEnv({ ...GATE_OFF, CROW_DB_PATH: path }, () =>
      attemptLogin("correct horse battery staple", "10.0.0.5", null, null, { onHost: false }));
    assert.equal(error, undefined, `the real login minted a session (${error})`);
    assert.ok(token, "a real dashboard session was minted");
    const session = await withEnv({ ...GATE_OFF, CROW_DB_PATH: path }, () => sessionAuth(token));
    assert.equal(session.valid, true, "the session is live in the session store");
    assert.deepEqual(
      dbRows(path, "SELECT key FROM dashboard_settings WHERE key = 'totp_enabled'"),
      [],
      "2FA starts off, so the gate would hand a signed-in caller the setup page",
    );
    // Snapshot AFTER the mint: the login itself writes audit rows and the session
    // row, and neither may move from here on.
    const before = authState(path);
    const routes = [
      { path: "/dashboard/login/2fa/setup" },
      { path: "/dashboard/login/2fa/setup", method: "POST", body: { totp_code: "000000", secret: "JBSWY3DPEHPK3PXP" } },
    ];
    for (const route of routes) {
      // No cookie: nothing to reach the gate with, exactly as before.
      const anon = await withEnv({ ...GATE_OFF, CROW_DB_PATH: path }, () =>
        request(port, route.path, { method: route.method, body: route.body, peer: "203.0.113.7" }));
      assert.equal(anon.status, 403, `${label(route)} must be refused, got ${anon.status}`);
      assert.match(anon.body, /Access Denied/, label(route));
      assert.equal(anon.headers.location, undefined, `${label(route)} never reached twoFactorSetupGate's redirect`);
      assert.equal(anon.headers["set-cookie"], undefined, `${label(route)} must not mint a cookie`);
      assert.doesNotMatch(anon.body, /name="totp_code"/, `${label(route)} must not serve the setup form`);
      assert.doesNotMatch(anon.body, /data:image/, `${label(route)} must not serve a QR code`);

      // With the live session: the network gate is the ONLY thing refusing this.
      // Had it passed, the GET would have written totp_secret + totp_recovery_codes
      // and the POST would have verified the code against it.
      const signed = await withEnv({ ...GATE_OFF, CROW_DB_PATH: path }, () =>
        request(port, route.path, {
          method: route.method,
          body: route.body,
          peer: "203.0.113.7",
          headers: { cookie: `crow_session=${token}` },
        }));
      assert.equal(signed.status, 403, `${label(route)} with a live session must still be refused, got ${signed.status}`);
      assert.match(signed.body, /Access Denied/, label(route));
      assert.equal(signed.headers.location, undefined, `${label(route)} never reached twoFactorSetupGate's redirect`);
      assert.equal(signed.headers["set-cookie"], undefined, `${label(route)} must not mint a cookie`);
      assert.doesNotMatch(signed.body, /name="totp_code"/, `${label(route)} must not serve the setup form`);
      assert.doesNotMatch(signed.body, /data:image/, `${label(route)} must not serve a QR code`);
    }
    assert.deepEqual(authState(path), before, "no auth state was touched");
    assert.deepEqual(
      dbRows(path, "SELECT key FROM dashboard_settings WHERE key LIKE 'totp%'"),
      [],
      "no TOTP secret or recovery codes were saved",
    );
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("positive control: the same session on an allowed source does reach saveTotpSetup and writes the TOTP secret", async () => {
  // This is what the refused case above must NOT do, and it is what makes its
  // "no totp row" assertion falsifiable: same DB, same session cookie, same
  // request — only the peer address is one the gate allows. If the network gate
  // on /dashboard/login/2fa/setup were dropped, the refused GET would land here
  // and leave totp_secret + totp_recovery_codes behind.
  const { dir, path } = freshDb();
  const server = await startDashboard();
  try {
    const port = server.address().port;
    const { token } = await withEnv({ ...GATE_OFF, CROW_DB_PATH: path }, () =>
      attemptLogin("correct horse battery staple", "10.0.0.5", null, null, { onHost: false }));
    assert.ok(token, "a real dashboard session was minted");
    assert.deepEqual(
      dbRows(path, "SELECT key FROM dashboard_settings WHERE key LIKE 'totp%'"),
      [],
      "2FA starts off",
    );
    const r = await withEnv({ ...GATE_OFF, CROW_DB_PATH: path }, () =>
      request(port, "/dashboard/login/2fa/setup", { peer: "10.0.0.5", headers: { cookie: `crow_session=${token}` } }));
    assert.equal(r.status, 200, `an allowed source with a live session gets the setup page (got ${r.status})`);
    assert.match(r.body, /name="totp_code"/, "the setup form is served");
    const written = dbRows(path, "SELECT key FROM dashboard_settings WHERE key LIKE 'totp%' ORDER BY key");
    assert.deepEqual(
      written.map((row) => row.key),
      ["totp_recovery_codes", "totp_secret"],
      "saveTotpSetup wrote the secret and the recovery codes",
    );
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a Funnel request is refused on the login page even from a tailnet socket", async () => {
  const { dir, path } = freshDb();
  const server = await startDashboard();
  try {
    const port = server.address().port;
    for (const route of [PUBLIC_AUTH_ROUTES[0], PUBLIC_AUTH_ROUTES[1]]) {
      const r = await withEnv({ ...GATE_OFF, CROW_DB_PATH: path }, () =>
        request(port, route.path, {
          method: route.method,
          body: route.body,
          peer: "100.64.20.5",
          headers: { "tailscale-funnel-request": "?1" },
        }));
      assert.equal(r.status, 403, `${label(route)} over the Funnel must be refused`);
      assert.match(r.body, /Access Denied/);
    }
    assert.deepEqual(lockoutRows(path), []);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a bare loopback socket carrying a forwarding header is refused, not read as the owner's machine", async () => {
  const { dir, path } = freshDb();
  const server = await startDashboard();
  try {
    const port = server.address().port;
    // No peer override: the socket really is 127.0.0.1. The header is what takes
    // the loopback exemption away.
    const r = await withEnv({ ...GATE_OFF, CROW_DB_PATH: path }, () =>
      request(port, "/dashboard/login", { headers: { "x-forwarded-for": "203.0.113.7" } }));
    assert.equal(r.status, 403);
    assert.deepEqual(lockoutRows(path), []);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the real router: allowed sources are unchanged -------------------------

test("allowed sources still get the login page: LAN, tailnet, direct loopback, and CROW_DASHBOARD_PUBLIC=true", async () => {
  const { dir, path } = freshDb();
  const server = await startDashboard();
  try {
    const port = server.address().port;
    for (const ip of ["192.168.1.20", "10.0.0.5", "100.64.20.5"]) {
      const r = await withEnv({ ...GATE_OFF, CROW_DB_PATH: path }, () =>
        request(port, "/dashboard/login", { peer: ip }));
      assert.equal(r.status, 200, `${ip} is an allowed source`);
      assert.match(r.body, /name="password"/, `${ip} gets the password form`);
      assert.doesNotMatch(r.body, /Access Denied/, ip);
    }
    // Direct loopback: refused by isAllowedNetwork, allowed by the exemption.
    const loop = await withEnv({ ...GATE_OFF, CROW_DB_PATH: path }, () =>
      request(port, "/dashboard/login"));
    assert.equal(loop.status, 200, "the owner on the machine keeps the login/setup page");
    assert.match(loop.body, /name="password"/);

    // The reset page is served on the same terms.
    const reset = await withEnv({ ...GATE_OFF, CROW_DB_PATH: path }, () =>
      request(port, "/dashboard/reset", { peer: "10.0.0.5" }));
    assert.equal(reset.status, 200);
    assert.doesNotMatch(reset.body, /Access Denied/);

    // CROW_DASHBOARD_PUBLIC=true is the documented way to open a public source.
    const open = await withEnv({ ...GATE_OFF, CROW_DASHBOARD_PUBLIC: "true", CROW_DB_PATH: path }, () =>
      request(port, "/dashboard/login", { peer: "203.0.113.7" }));
    assert.equal(open.status, 200);
    assert.match(open.body, /name="password"/);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("positive control: an allowed source's POST does reach the password check and bumps the lockout counter", async () => {
  // This is what the refused case above must NOT do — it proves the 403s there
  // come from the gate and not from a handler that is broken for everyone.
  const { dir, path } = freshDb();
  const server = await startDashboard();
  try {
    const port = server.address().port;
    const r = await withEnv({ ...GATE_OFF, CROW_DB_PATH: path }, () =>
      request(port, "/dashboard/login", { method: "POST", peer: "10.0.0.5", body: { password: "not-the-password" } }));
    assert.equal(r.status, 200, "the login page comes back with an error");
    assert.match(r.body, /name="password"/);
    assert.equal(r.headers["set-cookie"], undefined, "a failed login mints no session");

    const counters = lockoutRows(path);
    assert.equal(counters.length, 1, "the password check ran and bumped the counter");
    assert.equal(counters[0].key, "lockout:10.0.0.5");
    assert.ok(JSON.parse(counters[0].value).count >= 1);
    assert.ok(auditRows(path).some((row) => row.event_type === "auth_login_failure"));
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the real router: a Caddy proxy peer ------------------------------------
//
// The installer's Caddy dials the gateway's dedicated unix socket
// (proxy-socket.js), so its visitors arrive with no peer address at all and a
// PROXY_SOCKET mark on the connection. The harness can model that peer exactly:
// listenProxySocketForTests serves the same app on a unix socket and marks every
// accepted connection the way production does, so nothing is planted on a
// request.

/** One request over the proxy unix socket, as Caddy's dial makes it. */
function proxyRequest(socketPath, path, { headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path, method: "GET", headers }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("a Caddy proxy peer gets the login page for a private client, and is refused for a public one", async () => {
  const { dir, path } = freshDb();
  const socketPath = join(dir, "gateway.sock");
  const server = await startDashboard({ socketPath });
  try {
    const r = await withEnv({ ...GATE_OFF, CROW_DB_PATH: path }, () =>
      proxyRequest(socketPath, "/dashboard/login", { headers: { "x-forwarded-for": "10.0.0.5" } }));
    assert.equal(r.status, 200, `the LAN visitor Caddy named is an allowed source (got ${r.status})`);
    assert.match(r.body, /name="password"/, "the login page is served");
    assert.doesNotMatch(r.body, /Access Denied/);

    // The header can only take trust away: the hop Caddy names is what decides.
    const pub = await withEnv({ ...GATE_OFF, CROW_DB_PATH: path }, () =>
      proxyRequest(socketPath, "/dashboard/login", { headers: { "x-forwarded-for": "203.0.113.7" } }));
    assert.equal(pub.status, 403, "a public client through the same proxy is refused");
    assert.match(pub.body, /Access Denied/);
  } finally {
    await closeProxySocket(server.proxySocket);
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});