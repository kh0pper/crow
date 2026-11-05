/**
 * The dedicated proxy socket (the security audit's finding N1a-3/N1a-4).
 *
 * The installer's Caddy used to dial the gateway over loopback, so every
 * visitor was a loopback socket carrying X-Forwarded-For: unverifiable (any
 * local process writes the same header), refused by isAllowedNetwork, and the
 * owner was locked out of their own instance right after first-run setup.
 *
 * CROW_TRUSTED_PROXIES=loopback is not the fix (see loopbackProxyWarning).
 * Instead the gateway also listens on a unix socket whose filesystem mode
 * decides who may connect; Caddy dials it, and every connection accepted there
 * is marked (PROXY_SOCKET) so classifyPeer can name the client Caddy named.
 *
 * These tests pin:
 *   - a marked socket is `proxy` with the rightmost X-Forwarded-For hop, and
 *     isAllowedNetwork validates it exactly like any declared proxy;
 *   - a marked socket with a public hop, a chain containing one, or no header
 *     at all is refused (fail closed);
 *   - an UNMARKED loopback socket with the same header is still unverified and
 *     refused, so forgery stays impossible;
 *   - a real HTTP round trip over a unix socket sees the same classification;
 *   - isSelfOrigin follows the effective client through the proxy socket;
 *   - the Access Denied page no longer advises CROW_DASHBOARD_PUBLIC=true;
 *   - the fix-it detector fires on a loopback Caddyfile and stays quiet
 *     otherwise.
 *
 * Placeholder addresses only: the LAN client is 192.168.1.20, the public one
 * 8.8.8.8.
 */
import { test, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import express from "express";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyPeer, resolveClientMiddleware, PROXY_SOCKET } from "../servers/shared/peer-class.js";
import { resetPeerWarningsForTests } from "../servers/shared/peer-uid.js";
import { isAllowedNetwork, dashboardAuth } from "../servers/gateway/dashboard/auth.js";
import { isSelfOrigin, effectiveClient } from "../servers/shared/self-origin.js";
import { setInterfaceTableForTests } from "../servers/shared/ip-classify.js";
import { translations, SUPPORTED_LANGS, t } from "../servers/gateway/dashboard/shared/i18n.js";
import {
  listenProxySocket, closeProxySocket, proxySocketPath,
} from "../servers/gateway/proxy-socket.js";
import detector, { caddyProxySocketProblem } from "../servers/gateway/fix-it/detectors/caddy-proxy-socket.js";

const ENV_KEYS = ["CROW_DASHBOARD_PUBLIC", "CROW_TRUSTED_PROXIES", "CROW_ALLOWED_IPS", "CROW_PROXY_SOCKET"];
let saved;
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  resetPeerWarningsForTests();
  setInterfaceTableForTests(() => ({}));
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  setInterfaceTableForTests(null);
});

/** A request on the dedicated proxy socket: a unix socket has no peer address. */
const marked = (headers = {}) => ({ headers, socket: { [PROXY_SOCKET]: true } });
/** An ordinary same-box TCP connection (the shape the old Caddyfile produced). */
const loopback = (headers = {}, addr = "127.0.0.1") => ({ headers, socket: { remoteAddress: addr } });

// ─── the classifier ───

test("a marked socket with a LAN X-Forwarded-For is `proxy`, and the LAN client is allowed", () => {
  const req = marked({ "x-forwarded-for": "192.168.1.20" });
  const p = classifyPeer(req);
  assert.equal(p.via, "proxy");
  assert.equal(p.client, "192.168.1.20");
  assert.equal(p.proxySocket, true);
  assert.equal(p.socket, "", "a unix socket has no peer address");
  assert.equal(isAllowedNetwork(req), true);
});

test("a marked socket naming a public client is refused", () => {
  const req = marked({ "x-forwarded-for": "8.8.8.8" });
  assert.equal(classifyPeer(req).via, "proxy");
  assert.equal(classifyPeer(req).client, "8.8.8.8");
  assert.equal(isAllowedNetwork(req), false);
});

test("a marked socket whose chain names a public hop anywhere is refused (a header can only take trust away)", () => {
  const req = marked({ "x-forwarded-for": "8.8.8.8, 192.168.1.20" });
  assert.equal(classifyPeer(req).client, "192.168.1.20");
  assert.equal(isAllowedNetwork(req), false);
});

test("a marked socket with no forwarding header names nobody and is refused (fail closed)", () => {
  const req = marked();
  const p = classifyPeer(req);
  assert.equal(p.via, "proxy");
  assert.equal(p.client, null);
  assert.equal(isAllowedNetwork(req), false);
});

test("a marked socket with only X-Real-IP still names no X-Forwarded-For client and is refused", () => {
  const req = marked({ "x-real-ip": "192.168.1.20" });
  assert.equal(classifyPeer(req).client, null);
  assert.equal(isAllowedNetwork(req), false);
});

test("UNMARKED loopback with the same header stays unverified and refused — forgery is still impossible", () => {
  const req = loopback({ "x-forwarded-for": "192.168.1.20" });
  const p = classifyPeer(req);
  assert.equal(p.via, "unverified");
  assert.equal(p.client, "127.0.0.1");
  assert.equal(p.proxySocket, false);
  assert.equal(isAllowedNetwork(req), false);
});

test("declared proxies keep their behaviour (no regression from the fail-closed client check)", () => {
  process.env.CROW_TRUSTED_PROXIES = "10.0.0.9";
  try {
    assert.equal(isAllowedNetwork(loopback({ "x-forwarded-for": "192.168.1.20" }, "10.0.0.9")), true);
    assert.equal(isAllowedNetwork(loopback({ "x-forwarded-for": "8.8.8.8" }, "10.0.0.9")), false);
    // No header: the declared proxy itself is the client, as before.
    assert.equal(isAllowedNetwork(loopback({}, "10.0.0.9")), true);
  } finally {
    delete process.env.CROW_TRUSTED_PROXIES;
  }
});

test("isSelfOrigin follows the effective client through the proxy socket", () => {
  // The box's own loopback address through Caddy: still "this machine".
  assert.equal(effectiveClient(marked({ "x-forwarded-for": "127.0.0.1" })), "127.0.0.1");
  assert.equal(isSelfOrigin(marked({ "x-forwarded-for": "127.0.0.1" })), true);
  // The box's own LAN address (the injected table is empty, so every address
  // reads as "this machine") — the point is that the client, not the (empty)
  // socket, is what gets looked at.
  assert.equal(effectiveClient(marked({ "x-forwarded-for": "10.0.0.42" })), "10.0.0.42");
  // A LAN neighbour is not this machine once the table knows the box's own addresses.
  setInterfaceTableForTests(() => ({ eno1: [{ address: "10.0.0.5", netmask: "255.255.255.0", family: "IPv4", cidr: "10.0.0.5/24" }] }));
  assert.equal(isSelfOrigin(marked({ "x-forwarded-for": "192.168.1.20" })), false);
  assert.equal(isSelfOrigin(marked({ "x-forwarded-for": "10.0.0.5" })), true, "the box's own LAN address");
});

// ─── a real HTTP round trip over the socket ───

const tmpDir = mkdtempSync(join(tmpdir(), "crow-proxy-socket-"));
after(() => rmSync(tmpDir, { recursive: true, force: true }));

function requestUnix(socketPath, headers = {}, path = "/who") {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path, method: "GET", headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("real HTTP round trip: the unix socket marks the connection and the client is classified", async () => {
  const app = express();
  app.use(resolveClientMiddleware());
  app.get("/who", (req, res) => res.json({
    via: req.crowPeer.via,
    client: req.crowPeer.client,
    proxySocket: req.crowPeer.proxySocket,
    ip: req.ip,
    allowed: isAllowedNetwork(req),
  }));

  const socketPath = join(tmpDir, "gateway.sock");
  assert.equal(proxySocketPath({ CROW_PROXY_SOCKET: socketPath }), socketPath);
  assert.equal(proxySocketPath({}), null);

  const server = listenProxySocket(app, http.createServer(), socketPath, { log: () => {} });
  assert.ok(server, "a configured path starts a listener");
  try {
    await once(server, "listening");
    const ok = await requestUnix(socketPath, { "x-forwarded-for": "192.168.1.20" });
    assert.equal(ok.status, 200);
    const body = JSON.parse(ok.body);
    assert.equal(body.via, "proxy");
    assert.equal(body.client, "192.168.1.20");
    assert.equal(body.proxySocket, true);
    assert.equal(body.ip, "192.168.1.20", "req.ip is the client Caddy named, not undefined");
    assert.equal(body.allowed, true);

    const pub = JSON.parse((await requestUnix(socketPath, { "x-forwarded-for": "8.8.8.8" })).body);
    assert.equal(pub.via, "proxy");
    assert.equal(pub.allowed, false);

    const bare = JSON.parse((await requestUnix(socketPath, {})).body);
    assert.equal(bare.client, null);
    assert.equal(bare.allowed, false);
  } finally {
    closeProxySocket(server, socketPath);
  }
});

test("no CROW_PROXY_SOCKET means no second listener", () => {
  assert.equal(listenProxySocket(express(), http.createServer(), null), null);
});

// ─── the Access Denied page ───

function deniedPage(req) {
  let out = null;
  const res = {
    status(code) { this.code = code; return this; },
    type() { return this; },
    send(html) { out = { code: this.code, html }; },
  };
  dashboardAuth(req, res, () => { throw new Error("a denied request must never reach next()"); });
  return out;
}

test("the Access Denied page keeps 403 and no longer advises CROW_DASHBOARD_PUBLIC", () => {
  const page = deniedPage(loopback({}, "8.8.8.8"));
  assert.equal(page.code, 403);
  assert.doesNotMatch(page.html, /CROW_DASHBOARD_PUBLIC/);
  assert.match(page.html, /Access Denied/);
  assert.match(page.html, /home network or your Tailscale network/);
  assert.match(page.html, /localhost/);
  assert.match(page.html, /off on purpose/);
});

test("the Access Denied page is translated (es) and both languages say the same thing", () => {
  const es = deniedPage(loopback({ cookie: "crow_lang=es" }, "8.8.8.8"));
  assert.equal(es.code, 403);
  assert.match(es.html, /Acceso denegado/);
  assert.match(es.html, /Tailscale/);
  assert.doesNotMatch(es.html, /CROW_DASHBOARD_PUBLIC/);

  for (const key of ["login.accessDeniedTitle", "login.accessDeniedBody"]) {
    for (const lang of SUPPORTED_LANGS) {
      assert.equal(typeof translations[key][lang], "string", `${key} missing ${lang}`);
      assert.ok(translations[key][lang].length > 0, `${key} has empty ${lang}`);
    }
    assert.notEqual(translations[key].es, translations[key].en, `${key} es must be translated`);
    assert.equal(t(key, "es"), translations[key].es);
  }
});

// ─── the fix-it detector ───

const FIXTURE_DIR = mkdtempSync(join(tmpdir(), "crow-caddyfile-"));
after(() => rmSync(FIXTURE_DIR, { recursive: true, force: true }));

function fixture(name, text) {
  const p = join(FIXTURE_DIR, name);
  writeFileSync(p, text);
  return p;
}

const LOOPBACK_CADDYFILE = "<host>.local {\n    tls internal\n    reverse_proxy localhost:3001\n}\n";
const SOCKET_CADDYFILE = "<host>.local {\n    tls internal\n    reverse_proxy unix//run/crow/gateway.sock\n}\n";

test("detector fires on a loopback Caddyfile and carries the exact command to run", () => {
  const problem = caddyProxySocketProblem({ caddyfile: fixture("loopback", LOOPBACK_CADDYFILE), env: {} });
  assert.ok(problem, "must fire on `reverse_proxy localhost:3001`");
  assert.match(problem.title, /turned away/);
  assert.match(problem.why, /Crow does not run as root/);
  assert.match(problem.fixCommand, /^sudo bash .*scripts\/fix-caddy-proxy-socket\.sh$/);
  assert.ok(problem.why.includes(problem.fixCommand), "the card text carries the command");
  assert.doesNotMatch(problem.why, /CROW_DASHBOARD_PUBLIC/);

  const dotted = caddyProxySocketProblem({ caddyfile: fixture("dotted", "x {\n\treverse_proxy 127.0.0.1:3001\n}\n"), env: {} });
  assert.ok(dotted, "127.0.0.1:3001 fires too");
});

test("detector stays quiet on a fixed Caddyfile, a missing file, another port, and a set CROW_PROXY_SOCKET", () => {
  assert.equal(caddyProxySocketProblem({ caddyfile: fixture("socket", SOCKET_CADDYFILE), env: {} }), null);
  assert.equal(caddyProxySocketProblem({ caddyfile: join(FIXTURE_DIR, "nope"), env: {} }), null);
  assert.equal(caddyProxySocketProblem({ caddyfile: fixture("other-port", "x {\n\treverse_proxy localhost:3002\n}\n"), env: {} }), null);
  // A gateway already listening on the socket is not the problem (upgrade in progress).
  assert.equal(caddyProxySocketProblem({ caddyfile: fixture("loopback2", LOOPBACK_CADDYFILE), env: { CROW_PROXY_SOCKET: "/run/crow/gateway.sock" } }), null);
});

test("detector.check upserts one boot card (no one-click remedy: the gateway is not root)", async () => {
  const items = [];
  const store = { upsertItem: async (i) => { items.push(i); return { id: 1, notify: true }; }, resolveByKey: async () => {} };
  await detector.check(store, { caddyfile: fixture("loopback3", LOOPBACK_CADDYFILE), env: {} });
  assert.equal(items.length, 1);
  assert.equal(items[0].source, "caddy-proxy-socket");
  assert.equal(items[0].severity, "warn");
  assert.deepEqual(items[0].remedies, []);
  assert.match(items[0].why, /fix-caddy-proxy-socket\.sh/);

  items.length = 0;
  await detector.check(store, { caddyfile: fixture("socket2", SOCKET_CADDYFILE), env: {} });
  assert.equal(items.length, 0, "nothing is written when the Caddyfile is fine");
});