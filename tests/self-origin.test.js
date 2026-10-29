/**
 * A request from this machine itself is never the owner's turn (project services Task 16b).
 *
 * The shared browser container runs on host networking and can set any header, cookie or
 * user agent; through Tailscale Serve it even carries the owner's tailnet login. Only the
 * client address tells it apart, so servers/shared/self-origin.js decides on that, inside
 * isLocalPasswordSessionOn (every owner check inherits it), and a login made from this
 * machine is stored as scopes 'dashboard onhost' (never owner, wherever it is replayed).
 *
 * Placeholder addresses only: this box is 10.0.0.5 on the LAN, 100.64.20.1 on the tailnet,
 * 172.17.0.1 on docker0 and 172.18.0.1 on a compose bridge (an injected interface table);
 * the owner's laptop is 100.64.20.9 on the tailnet, 10.0.0.42 on the LAN, or 203.0.113.7.
 */
import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { actAsServe, serveHeaders } from "./fixtures/serve-peer.mjs";

const tmpDir = mkdtempSync(join(tmpdir(), "crow-self-origin-"));
execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: tmpDir }, stdio: "pipe" });
process.env.CROW_DATA_DIR = tmpDir;
actAsServe();

const { setInterfaceTableForTests } = await import("../servers/shared/ip-classify.js");
const { isSelfOrigin, isSelfAddress, effectiveClient } = await import("../servers/shared/self-origin.js");
const { isLocalPasswordSessionOn, isLocalPasswordSession } = await import("../servers/gateway/dashboard/local-session.js");
const { passwordSessionScopes, attemptLogin, complete2faLogin } = await import("../servers/gateway/dashboard/auth.js");
const { isLocalDashboardSession } = await import("../bundles/phone/server/authority.js");
const { createDbClient } = await import("../servers/db.js");
const db = createDbClient(join(tmpDir, "crow.db"));

const TABLE = {
  lo: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", cidr: "127.0.0.1/8" }, { address: "::1", netmask: "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", family: "IPv6", cidr: "::1/128" }],
  eno1: [{ address: "10.0.0.5", netmask: "255.255.255.0", family: "IPv4", cidr: "10.0.0.5/24" }],
  tailscale0: [{ address: "100.64.20.1", netmask: "255.255.255.255", family: "IPv4", cidr: "100.64.20.1/32" }, { address: "fd7a:115c:a1e0::1", netmask: "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", family: "IPv6", cidr: "fd7a:115c:a1e0::1/128" }],
  docker0: [{ address: "172.17.0.1", netmask: "255.255.0.0", family: "IPv4", cidr: "172.17.0.1/16" }],
  "br-0a1b2c3d": [{ address: "172.18.0.1", netmask: "255.255.0.0", family: "IPv4" }],
};
const useTable = (t = TABLE) => setInterfaceTableForTests(() => t);
useTable();
afterEach(() => useTable());
after(() => { setInterfaceTableForTests(null); try { db.close(); } catch {} rmSync(tmpDir, { recursive: true, force: true }); });

const hash = (t) => createHash("sha256").update(t).digest("hex");
const until = new Date(Date.now() + 3_600_000).toISOString();
for (const [tok, scopes] of [["s-owner", "dashboard"], ["s-onhost", "dashboard onhost"], ["s-sso", "dashboard sso"]]) {
  await db.execute({ sql: "INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at) VALUES (?, 'access', 'dashboard', ?, ?)", args: [hash(tok), scopes, until] });
}

/** A plain request from a direct TCP peer. */
const direct = (addr, extra = {}) => ({ socket: { remoteAddress: addr }, headers: {}, ...extra });

test("the client: a direct peer is its socket; loopback with no Serve client, or no socket, is nobody", () => {
  assert.equal(effectiveClient(direct("10.0.0.42")), "10.0.0.42");
  assert.equal(effectiveClient(direct("127.0.0.1")), null);
  assert.equal(effectiveClient({ headers: {} }), null);
  // A direct peer's own X-Forwarded-For is never believed (no trusted proxy is declared).
  assert.equal(effectiveClient(direct("10.0.0.5", { headers: { "x-forwarded-for": "10.0.0.42" } })), "10.0.0.5");
});

test("on the box: loopback, every interface address (tailnet and docker too), any bridge subnet, v4-mapped spellings", () => {
  for (const a of ["127.0.0.1", "127.8.9.1", "::1", "::ffff:127.0.0.1", "10.0.0.5", "::ffff:10.0.0.5", "100.64.20.1", "fd7a:115c:a1e0::1", "172.17.0.1", "172.17.0.9", "172.17.250.3", "172.18.3.4", "0.0.0.0", "::"]) {
    assert.equal(isSelfAddress(a), true, a);
  }
});

test("off the box: another LAN host, another tailnet node, a public address", () => {
  for (const a of ["10.0.0.42", "100.64.20.9", "fd7a:115c:a1e0::9", "203.0.113.7", "172.19.0.2"]) {
    assert.equal(isSelfAddress(a), false, a);
  }
});

test("undeterminable is on the box: no address, garbage, an unreadable or empty interface table", () => {
  for (const a of [null, undefined, "", "not-an-ip", "999.1.1.1"]) assert.equal(isSelfAddress(a), true, String(a));
  setInterfaceTableForTests(() => { throw new Error("EPERM"); });
  assert.equal(isSelfAddress("10.0.0.42"), true, "a throwing interface read");
  assert.equal(isSelfOrigin(direct("10.0.0.42")), true);
  setInterfaceTableForTests(() => ({}));
  assert.equal(isSelfAddress("10.0.0.42"), true, "an empty table");
  setInterfaceTableForTests(() => ({ eth0: [{ address: "nonsense" }] }));
  assert.equal(isSelfAddress("10.0.0.42"), true, "a table with no usable address");
  setInterfaceTableForTests(() => ({ ...TABLE, docker0: [{ address: "172.17.0.1" }] }));
  assert.equal(isSelfAddress("10.0.0.42"), true, "a bridge with no prefix could cover anything");
});

test("a declared reverse proxy: its forwarded client decides (on the box, or not)", () => {
  const prev = process.env.CROW_TRUSTED_PROXIES;
  process.env.CROW_TRUSTED_PROXIES = "10.0.0.9";
  try {
    assert.equal(isSelfOrigin(direct("10.0.0.9", { headers: { "x-forwarded-for": "10.0.0.5" } })), true, "the proxy relays this box");
    assert.equal(isSelfOrigin(direct("10.0.0.9", { headers: { "x-forwarded-for": "172.17.0.4" } })), true, "a container");
    assert.equal(isSelfOrigin(direct("10.0.0.9", { headers: { "x-forwarded-for": "10.0.0.42" } })), false, "the laptop");
  } finally {
    if (prev === undefined) delete process.env.CROW_TRUSTED_PROXIES; else process.env.CROW_TRUSTED_PROXIES = prev;
  }
});

test("isLocalPasswordSessionOn: never the owner from the box; the owner's session from a LAN host is", async () => {
  const on = (addr, session = "s-owner", extra = {}) => isLocalPasswordSessionOn(db, direct(addr, { dashboardSession: session, ...extra }));
  assert.equal(await on("127.0.0.1"), false, "loopback with no Serve client");
  assert.equal(await on("10.0.0.5"), false, "the box's own LAN address");
  assert.equal(await on("100.64.20.1"), false, "the box's own tailnet address, direct");
  assert.equal(await on("172.17.0.1"), false, "docker0's address");
  assert.equal(await on("172.17.0.23"), false, "a bridged container");
  assert.equal(await on("10.0.0.42"), true, "a LAN address that is not the box");
  assert.equal(await on("203.0.113.7"), true);
  assert.equal(await isLocalPasswordSessionOn(db, { dashboardSession: "s-owner", headers: {} }), false, "no socket: undeterminable");
  // The session tags still decide off the box.
  assert.equal(await on("10.0.0.42", "s-onhost"), false, "a session minted by a login from the box");
  assert.equal(await on("10.0.0.42", "s-sso"), false);
  assert.equal(await on("10.0.0.42", "s-owner", { crossHostAuth: { ok: true } }), false);
  // The one-client form too.
  assert.equal(await isLocalPasswordSession(direct("10.0.0.5", { dashboardSession: "s-owner" })), false);
  assert.equal(await isLocalPasswordSession(direct("10.0.0.42", { dashboardSession: "s-owner" })), true);
  // An unreadable interface table: no owner anywhere.
  setInterfaceTableForTests(() => { throw new Error("EPERM"); });
  assert.equal(await on("10.0.0.42"), false);
});

// ---- through Tailscale Serve (a real loopback socket, Serve's headers) -------------------------
async function withServer(app, fn) {
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  try { return await fn(server.address().port); } finally { server.close(); }
}
function request(port, { method = "GET", path = "/", headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("through Serve: the box's own tailnet IP (with the owner's login) is not the owner; another tailnet node is", async () => {
  const app = express();
  app.get("/who", async (req, res) => {
    req.dashboardSession = "s-owner";
    res.json({ self: isSelfOrigin(req), owner: await isLocalPasswordSessionOn(db, req) });
  });
  await withServer(app, async (port) => {
    const ask = async (headers) => JSON.parse((await request(port, { path: "/who", headers })).text);
    assert.deepEqual(await ask(serveHeaders("owner@example.invalid", "100.64.20.1")), { self: true, owner: false }, "the box, via Serve, as the owner's login");
    assert.deepEqual(await ask(serveHeaders("owner@example.invalid", "fd7a:115c:a1e0::1")), { self: true, owner: false }, "the box's tailnet IPv6");
    assert.deepEqual(await ask(serveHeaders("owner@example.invalid", "100.64.20.9")), { self: false, owner: true }, "the owner's laptop");
    assert.deepEqual(await ask({}), { self: true, owner: false }, "bare loopback");
    assert.deepEqual(await ask({ "x-forwarded-for": "100.64.20.9" }), { self: true, owner: false }, "loopback naming a client without Serve's shape");
  });
});

// ---- the login flag -----------------------------------------------------------------------------
test("passwordSessionScopes fails closed: only an explicit off-box login is a plain 'dashboard' session", () => {
  assert.equal(passwordSessionScopes(false), "dashboard");
  for (const v of [true, undefined, null, 0, "false"]) assert.equal(passwordSessionScopes(v), "dashboard onhost", String(v));
});

test("attemptLogin / complete2faLogin store 'dashboard onhost' unless told the login was off the box", async () => {
  const { setPassword } = await import("../servers/gateway/dashboard/auth.js");
  await setPassword("correct horse battery staple");
  const scopesOf = async (tok) => (await db.execute({ sql: "SELECT scopes FROM oauth_tokens WHERE token = ?", args: [hash(tok)] })).rows[0]?.scopes;
  const a = await attemptLogin("correct horse battery staple", "10.0.0.5", null, null, { onHost: true });
  assert.equal(await scopesOf(a.token), "dashboard onhost");
  const b = await attemptLogin("correct horse battery staple", "10.0.0.5");
  assert.equal(await scopesOf(b.token), "dashboard onhost", "no flag: fails closed");
  const c = await attemptLogin("correct horse battery staple", "10.0.0.42", null, null, { onHost: false });
  assert.equal(await scopesOf(c.token), "dashboard");
  assert.equal(await scopesOf((await complete2faLogin("10.0.0.5", { onHost: true })).token), "dashboard onhost");
  assert.equal(await scopesOf((await complete2faLogin("10.0.0.5")).token), "dashboard onhost");
  assert.equal(await scopesOf((await complete2faLogin("10.0.0.42", { onHost: false })).token), "dashboard");
  await db.execute("DELETE FROM dashboard_settings WHERE key = 'password_hash'");
});

test("the real login route: a login from the box is 'dashboard onhost', still signed in from a laptop, never the owner; the laptop's own login is", async () => {
  const { default: dashboardRouter } = await import("../servers/gateway/dashboard/index.js");
  const app = express();
  app.use((req, res, next) => { res.redirectAfterPost = (url) => res.redirect(303, url); next(); });
  app.use(dashboardRouter((req, res, next) => next()));
  app.get("/owner-probe", async (req, res) => {
    const m = /(?:^|;\s*)crow_session=([^;]+)/.exec(req.headers.cookie || "");
    req.dashboardSession = m ? m[1] : undefined;
    res.json({ owner: await isLocalPasswordSessionOn(db, req) });
  });
  const PW = "correct horse battery staple";
  const form = (o) => new URLSearchParams(o).toString();
  const sessionOf = (r) => {
    const set = [].concat(r.headers["set-cookie"] || []);
    const m = set.map((c) => /^crow_session=([^;]+)/.exec(c)).find(Boolean);
    return m ? m[1] : null;
  };
  const scopesOf = async (tok) => (await db.execute({ sql: "SELECT scopes FROM oauth_tokens WHERE token = ?", args: [hash(tok)] })).rows[0]?.scopes;
  await withServer(app, async (port) => {
    const login = (headers, body) => request(port, { method: "POST", path: "/dashboard/login", headers: { ...headers, "content-type": "application/x-www-form-urlencoded" }, body: form(body) });
    // First-time setup, from the box through Serve (the shared browser carries the owner's login).
    const fromBox = serveHeaders("owner@example.invalid", "100.64.20.1");
    const r1 = await login(fromBox, { password: PW, confirm: PW });
    assert.equal(r1.status, 303, r1.text.slice(0, 200));
    const boxTok = sessionOf(r1);
    assert.ok(boxTok, "a session cookie");
    assert.equal(await scopesOf(boxTok), "dashboard onhost");

    const fromLaptop = serveHeaders("owner@example.invalid", "100.64.20.9");
    const probe = async (tok, headers) => JSON.parse((await request(port, { path: "/owner-probe", headers: { ...headers, cookie: `crow_session=${tok}` } })).text).owner;
    assert.equal(await probe(boxTok, fromLaptop), false, "the box's session replayed from the laptop is still not the owner");
    assert.equal(await probe(boxTok, fromBox), false);

    // ...but it is a working dashboard session (Kevin's ruling 2: it may sign in, never as the owner).
    const page = await request(port, { path: "/dashboard/schedule", headers: { ...fromLaptop, cookie: `crow_session=${boxTok}` } });
    assert.equal(page.status, 200, `an onhost session loads a dashboard page (got ${page.status} ${page.headers.location || ""})`);
    const pageFromBox = await request(port, { path: "/dashboard/schedule", headers: { ...fromBox, cookie: `crow_session=${boxTok}` } });
    assert.equal(pageFromBox.status, 200, "and from the box itself");

    // The laptop's own login is a plain session: the owner from the laptop, never from the box.
    const r2 = await login(fromLaptop, { password: PW });
    assert.equal(r2.status, 303);
    const lapTok = sessionOf(r2);
    assert.equal(await scopesOf(lapTok), "dashboard");
    assert.equal(await probe(lapTok, fromLaptop), true, "the owner's turn from the laptop");
    assert.equal(await probe(lapTok, fromBox), false, "the laptop's cookie used from the box");

    // A login straight to loopback (no Serve client) is on the box too.
    const r3 = await login({}, { password: PW });
    const loopTok = sessionOf(r3);
    if (loopTok) assert.equal(await scopesOf(loopTok), "dashboard onhost");
  });
  await db.execute("DELETE FROM dashboard_settings WHERE key = 'password_hash'");
});

// ---- the phone bundle's call approvals use the same check ----------------------------------
test("phone call approvals: an onhost session is refused, the owner's session from another machine is accepted, the box is refused", async () => {
  assert.equal(await isLocalDashboardSession(db, direct("203.0.113.7", { dashboardSession: "s-onhost" })), false, "scopes 'dashboard onhost'");
  assert.equal(await isLocalDashboardSession(db, direct("203.0.113.7", { dashboardSession: "s-owner" })), true, "a normal session from a non-box address");
  assert.equal(await isLocalDashboardSession(db, direct("10.0.0.42", { dashboardSession: "s-owner" })), true);
  assert.equal(await isLocalDashboardSession(db, direct("10.0.0.5", { dashboardSession: "s-owner" })), false, "the box itself");
  assert.equal(await isLocalDashboardSession(db, direct("172.17.0.3", { dashboardSession: "s-owner" })), false, "a container");
  assert.equal(await isLocalDashboardSession(db, direct("203.0.113.7", { dashboardSession: "s-sso" })), false);
  assert.equal(await isLocalDashboardSession(db, "s-owner"), false, "a bare session string (no request) is refused");
});
