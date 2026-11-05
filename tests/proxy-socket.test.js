/**
 * The dedicated proxy socket (the security audit's finding N1a-3/N1a-4).
 *
 * The installer's Caddy used to dial the gateway over loopback, so every
 * visitor was a loopback socket carrying X-Forwarded-For: unverifiable (any
 * local process writes the same header), refused by isAllowedNetwork, and the
 * owner was locked out of their own instance right after first-run setup.
 *
 * CROW_TRUSTED_PROXIES=loopback is not the fix (see loopbackProxyWarning).
 * Instead SYSTEMD owns a unix socket (crow-gateway-proxy.socket: root:caddy
 * 0660) and the gateway listens on the fd it inherits (LISTEN_FDS). Only the
 * local Caddy can open it, so a process running as the gateway's own user
 * cannot dial it with a forged header; every connection accepted there is
 * marked (PROXY_SOCKET) so classifyPeer can name the client Caddy named — the
 * rightmost X-Forwarded-For hop, and only that hop.
 *
 * These tests pin:
 *   - a marked socket is `proxy` with the rightmost X-Forwarded-For hop, and
 *     isAllowedNetwork validates it exactly like any declared proxy;
 *   - the rightmost hop wins even when it is itself in CROW_TRUSTED_PROXIES;
 *   - a marked socket with a public hop, a chain containing one, or no header
 *     at all is refused (fail closed);
 *   - an UNMARKED loopback socket with the same header is still unverified and
 *     refused, so forgery stays impossible;
 *   - a real HTTP round trip over a unix socket sees the same classification;
 *   - the fd-selection rule (LISTEN_PID/LISTEN_FDS/LISTEN_FDNAMES) and the fact
 *     that no listener exists without it, or under --no-auth;
 *   - a child process handed the listening fd as fd 3 (exactly what socket
 *     activation does) serves requests over it, marked;
 *   - the Access Denied page no longer advises CROW_DASHBOARD_PUBLIC;
 *   - the fix-it detector fires on a loopback Caddyfile with no socket unit,
 *     and resolves its card once the Caddyfile no longer dials loopback.
 *
 * Placeholder addresses only: the LAN client is 192.168.1.20, the public one
 * 8.8.8.8.
 */
import { test, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import express from "express";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { classifyPeer, resolveClientMiddleware, PROXY_SOCKET } from "../servers/shared/peer-class.js";
import { resetPeerWarningsForTests } from "../servers/shared/peer-uid.js";
import { isAllowedNetwork, dashboardAuth } from "../servers/gateway/dashboard/auth.js";
import { isSelfOrigin, effectiveClient } from "../servers/shared/self-origin.js";
import { setInterfaceTableForTests } from "../servers/shared/ip-classify.js";
import { translations, SUPPORTED_LANGS, t } from "../servers/gateway/dashboard/shared/i18n.js";
import {
  startActivatedProxySocket, listenProxySocketForTests, closeProxySocket, pickProxyFd,
  PROXY_SOCKET_UNIT,
} from "../servers/gateway/proxy-socket.js";
import detector, { caddyProxySocketProblem, DEDUP_KEY } from "../servers/gateway/fix-it/detectors/caddy-proxy-socket.js";

const ENV_KEYS = ["CROW_DASHBOARD_PUBLIC", "CROW_TRUSTED_PROXIES", "CROW_ALLOWED_IPS"];
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

test("on the proxy socket the client is the RIGHTMOST hop only — never one further left", () => {
  // 10.0.0.9 is a proxy this box also lists, but Caddy is the one that spoke to
  // the socket: the visitor it saw is the client, and reading the earlier hop
  // would let the header move the client one proxy deeper.
  process.env.CROW_TRUSTED_PROXIES = "10.0.0.0/8";
  try {
    const req = marked({ "x-forwarded-for": "192.168.1.5, 10.0.0.9" });
    const p = classifyPeer(req);
    assert.equal(p.via, "proxy");
    assert.equal(p.client, "10.0.0.9");
    assert.equal(isAllowedNetwork(req), true, "both hops are private, so the request passes");
  } finally {
    delete process.env.CROW_TRUSTED_PROXIES;
  }
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

// ─── a real HTTP round trip over the socket (TEST-ONLY path listener) ───

const tmpDir = mkdtempSync(join(tmpdir(), "crow-proxy-socket-"));
after(() => rmSync(tmpDir, { recursive: true, force: true }));

/** Resolve once `text` appears in the stream's output. */
function waitForText(stream, text, stderr = () => "") {
  return new Promise((resolve, reject) => {
    let buf = "";
    stream.on("data", (c) => {
      buf += c;
      if (buf.includes(text)) resolve();
    });
    stream.on("end", () => reject(new Error(`stream ended before "${text}"; stderr:\n${stderr()}`)));
    stream.on("error", reject);
  });
}

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

/** The app shape every round-trip test serves: the classifier's verdict. */
function whoApp() {
  const app = express();
  app.use(resolveClientMiddleware());
  app.get("/who", (req, res) => res.json({
    via: req.crowPeer.via,
    client: req.crowPeer.client,
    proxySocket: req.crowPeer.proxySocket,
    ip: req.ip,
    allowed: isAllowedNetwork(req),
    selfOrigin: isSelfOrigin(req),
  }));
  return app;
}

test("real HTTP round trip on a marked unix socket: LAN allowed, public denied, no header denied", async () => {
  const socketPath = join(tmpDir, "gateway.sock");
  const server = listenProxySocketForTests(whoApp(), http.createServer(), socketPath, { log: () => {} });
  assert.ok(server, "the test-only path listener starts");
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

    // The box's own loopback address through Caddy is still "this machine".
    const selfReq = JSON.parse((await requestUnix(socketPath, { "x-forwarded-for": "127.0.0.1" })).body);
    assert.equal(selfReq.client, "127.0.0.1");
    assert.equal(selfReq.selfOrigin, true);
  } finally {
    await closeProxySocket(server);
  }
});

test("real TCP loopback with a forged X-Forwarded-For stays unverified — no marker, no trust", async () => {
  const server = http.createServer(whoApp());
  server.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const { port } = server.address();
    const body = await new Promise((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, path: "/who", headers: { "x-forwarded-for": "192.168.1.20" } },
        (res) => {
          let raw = "";
          res.on("data", (c) => { raw += c; });
          res.on("end", () => resolve(JSON.parse(raw)));
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(body.via, "unverified", "any same-box program can write that header");
    assert.equal(body.proxySocket, false);
    assert.equal(body.allowed, false);
    // And it reads as this machine, which is why the gate refuses it: the only
    // way to look like a distinct client Caddy vouched for is the marker, and
    // the marker can only be set by a connection systemd's socket accepted.
    assert.equal(body.selfOrigin, true);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("the test-only listener is a no-op without a target, and closeProxySocket never throws twice", async () => {
  assert.equal(listenProxySocketForTests(express(), http.createServer(), null), null);
  assert.equal(listenProxySocketForTests(express(), http.createServer(), ""), null);
  const closed = await closeProxySocket(null);
  assert.equal(closed, undefined);
  const none = await closeProxySocket(null, { force: true });
  assert.equal(none, undefined);
});

// ─── the production path: an fd from systemd (socket activation) ───

test("pickProxyFd: only a matching LISTEN_PID with fds yields an fd, named for our unit", () => {
  const pid = 4242;
  assert.equal(pickProxyFd({}, pid), null, "no activation at all");
  assert.equal(pickProxyFd({ LISTEN_PID: String(pid) }, pid), null, "LISTEN_FDS missing");
  assert.equal(pickProxyFd({ LISTEN_PID: String(pid), LISTEN_FDS: "0" }, pid), null, "no fds passed");
  assert.equal(
    pickProxyFd({ LISTEN_PID: String(pid + 1), LISTEN_FDS: "1" }, pid), null,
    "a foreign LISTEN_PID (an inherited environment) is ignored",
  );
  assert.equal(pickProxyFd({ LISTEN_PID: String(pid), LISTEN_FDS: "1" }, pid), null, "no names: refused (exact match only)");
  assert.equal(pickProxyFd({ LISTEN_PID: String(pid), LISTEN_FDS: "1", LISTEN_FDNAMES: "crow-gateway.socket" }, pid), null,
    "a sole fd from another socket unit is never taken for the proxy socket");
  assert.equal(
    pickProxyFd({ LISTEN_PID: String(pid), LISTEN_FDS: "1", LISTEN_FDNAMES: PROXY_SOCKET_UNIT }, pid), 3,
  );
  assert.equal(
    pickProxyFd({ LISTEN_PID: String(pid), LISTEN_FDS: "2", LISTEN_FDNAMES: `other.socket:${PROXY_SOCKET_UNIT}` }, pid), 4,
    "the fd is picked by NAME, not by position",
  );
  assert.equal(
    pickProxyFd({ LISTEN_PID: String(pid), LISTEN_FDS: "2", LISTEN_FDNAMES: "a.socket:b.socket" }, pid), null,
    "several fds and none of them ours is ambiguous — refuse",
  );
});

test("no activation fd means no proxy listener at all", () => {
  const mk = () => http.createServer();
  assert.equal(startActivatedProxySocket(express(), mk(), { env: {}, pid: process.pid, log: () => {} }), null);
  assert.equal(
    startActivatedProxySocket(express(), mk(), { env: { LISTEN_PID: "1", LISTEN_FDS: "1" }, pid: process.pid, log: () => {} }),
    null,
    "a stray LISTEN_PID from another process must not make this one listen",
  );
});

test("the gateway skips the proxy socket under --no-auth and reads no path from the environment", () => {
  const root = resolve(import.meta.dirname, "..");
  const index = readFileSync(join(root, "servers", "gateway", "index.js"), "utf8");
  const mod = readFileSync(join(root, "servers", "gateway", "proxy-socket.js"), "utf8");
  assert.match(index, /if \(!noAuth\) proxyServer = startActivatedProxySocket\(app, server\)/);
  for (const src of [index, mod]) {
    assert.doesNotMatch(src, /CROW_PROXY_SOCKET/, "the path-based socket mode is gone");
    assert.doesNotMatch(src, /listenProxySocket\(/, "nothing but the test helper listens on a path");
    assert.doesNotMatch(src, /chmodSync|rmSync\(socketPath/, "the gateway never chmods or unlinks a socket");
  }
  // Step 3 of the drain waits for BOTH listeners.
  assert.match(index, /Promise\.all\(\[tcpClosed, proxyClosed\]\)/);
});

test("LISTEN_FDS: a child handed the listening fd as fd 3 serves marked requests over it", async (t) => {
  // An abstract socket (Linux namespace, leading NUL) has no file to unlink, so
  // closing this process's own listener cannot remove the path the child is
  // still serving on.
  const socketPath = `\0crow-proxy-activate-${process.pid}-${Date.now()}`;

  // This test is "systemd": it creates the listening socket, then hands the fd
  // to the child as fd 3 (the first activation fd), exactly as the socket unit
  // does. The child sets LISTEN_PID to its OWN pid, which systemd also does.
  const handed = net.createServer();
  await new Promise((r) => handed.listen(socketPath, r));
  const fd = handed._handle?.fd;
  if (!Number.isInteger(fd)) { handed.close(); return t.skip("this node exposes no listening fd"); }

  const root = resolve(import.meta.dirname, "..");
  const url = (p) => pathToFileURL(join(root, p)).href;
  const script = `
    process.env.LISTEN_PID = String(process.pid);
    process.env.LISTEN_FDS = "1";
    process.env.LISTEN_FDNAMES = ${JSON.stringify(PROXY_SOCKET_UNIT)};
    const http = (await import("node:http")).default;
    const express = (await import("express")).default;
    const { resolveClientMiddleware } = await import(${JSON.stringify(url("servers/shared/peer-class.js"))});
    const { isAllowedNetwork } = await import(${JSON.stringify(url("servers/gateway/dashboard/auth.js"))});
    const { startActivatedProxySocket } = await import(${JSON.stringify(url("servers/gateway/proxy-socket.js"))});
    const app = express();
    app.use(resolveClientMiddleware());
    app.get("/who", (req, res) => res.json({
      via: req.crowPeer.via,
      client: req.crowPeer.client,
      proxySocket: req.crowPeer.proxySocket,
      allowed: isAllowedNetwork(req),
    }));
    const proxy = startActivatedProxySocket(app, http.createServer(), { log: () => {} });
    if (!proxy) { console.error("NO_LISTENER"); process.exit(3); }
    proxy.once("listening", () => console.log("READY"));
  `;
  const env = { ...process.env };
  delete env.LISTEN_PID; delete env.LISTEN_FDS; delete env.LISTEN_FDNAMES;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root, stdio: ["ignore", "pipe", "pipe", fd], env,
  });

  let stderr = "";
  child.stderr.on("data", (c) => { stderr += c; });
  // The child holds its own descriptor; closing ours must leave the socket open.
  handed.close();
  try {
    await Promise.race([
      waitForText(child.stdout, "READY", () => stderr),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`child never listened; stderr:\n${stderr}`)), 20_000)),
    ]);
    const body = JSON.parse((await requestUnix(socketPath, { "x-forwarded-for": "192.168.1.20" })).body);
    assert.equal(body.via, "proxy", "a connection accepted on the activated fd is marked");
    assert.equal(body.client, "192.168.1.20");
    assert.equal(body.proxySocket, true);
    assert.equal(body.allowed, true);

    const pub = JSON.parse((await requestUnix(socketPath, { "x-forwarded-for": "8.8.8.8" })).body);
    assert.equal(pub.allowed, false, "and it fails closed for a public client");
  } finally {
    child.kill("SIGKILL");
    try { await once(child, "exit"); } catch {}
  }
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
const SOCKET_CADDYFILE = "<host>.local {\n    tls internal\n    reverse_proxy unix//run/crow-proxy/gateway.sock\n}\n";
const NO_SOCKET_UNIT = join(FIXTURE_DIR, "no-such.socket");
const SOCKET_UNIT_FIXTURE = fixture(
  "crow-gateway-proxy.socket",
  "[Socket]\nListenStream=/run/crow-proxy/gateway.sock\nSocketUser=root\nSocketGroup=caddy\nSocketMode=0660\n",
);

test("detector fires on a loopback Caddyfile with no socket unit, and carries the exact command", () => {
  const problem = caddyProxySocketProblem({ caddyfile: fixture("loopback", LOOPBACK_CADDYFILE), socketUnit: NO_SOCKET_UNIT });
  assert.ok(problem, "must fire on `reverse_proxy localhost:3001` + a missing unit");
  assert.match(problem.title, /turned away/);
  assert.match(problem.why, /Crow does not run as root/);
  assert.match(problem.fixCommand, /^sudo bash .*scripts\/fix-caddy-proxy-socket\.sh$/);
  assert.ok(problem.why.includes(problem.fixCommand), "the card text carries the command");
  assert.doesNotMatch(problem.why, /CROW_DASHBOARD_PUBLIC/);

  const dotted = caddyProxySocketProblem({ caddyfile: fixture("dotted", "x {\n\treverse_proxy 127.0.0.1:3001\n}\n"), socketUnit: NO_SOCKET_UNIT });
  assert.ok(dotted, "127.0.0.1:3001 fires too");
});

test("detector matches the same line shapes the fix script rewrites (a ` {`, a trailing comment)", () => {
  for (const line of [
    "    reverse_proxy localhost:3001 {",
    "    reverse_proxy localhost:3001   # old loopback dial",
    "    reverse_proxy 127.0.0.1:3001\t{",
  ]) {
    const caddyfile = fixture(`shape-${Math.random().toString(36).slice(2)}`, `x {\n${line}\n}\n`);
    assert.ok(caddyProxySocketProblem({ caddyfile, socketUnit: NO_SOCKET_UNIT }), `must fire on: ${line}`);
  }
  // ...and stays quiet on ports/lines it must not touch.
  for (const line of ["    reverse_proxy localhost:30010", "    reverse_proxy localhost:3002", "#    reverse_proxy localhost:3001"]) {
    const caddyfile = fixture(`notshape-${Math.random().toString(36).slice(2)}`, `x {\n${line}\n}\n`);
    assert.equal(caddyProxySocketProblem({ caddyfile, socketUnit: NO_SOCKET_UNIT }), null, `must not fire on: ${line}`);
  }
});

test("detector stays quiet on a fixed Caddyfile, a missing file, another port, and an installed socket unit", () => {
  const loopbackFile = fixture("loopback2", LOOPBACK_CADDYFILE);
  assert.equal(caddyProxySocketProblem({ caddyfile: fixture("socket", SOCKET_CADDYFILE), socketUnit: NO_SOCKET_UNIT }), null);
  assert.equal(caddyProxySocketProblem({ caddyfile: join(FIXTURE_DIR, "nope"), socketUnit: NO_SOCKET_UNIT }), null);
  assert.equal(caddyProxySocketProblem({ caddyfile: fixture("other-port", "x {\n\treverse_proxy localhost:3002\n}\n"), socketUnit: NO_SOCKET_UNIT }), null);
  // Decided on the Caddyfile alone (review): a socket unit next to a Caddyfile
  // that still dials loopback is still a locked-out owner.
  assert.ok(caddyProxySocketProblem({ caddyfile: loopbackFile, socketUnit: SOCKET_UNIT_FIXTURE }));
});

test("detector.check upserts one boot card (no one-click remedy: the gateway is not root)", async () => {
  const items = [];
  const store = { upsertItem: async (i) => { items.push(i); return { id: 1, notify: true }; }, resolveByKey: async () => {} };
  await detector.check(store, { caddyfile: fixture("loopback3", LOOPBACK_CADDYFILE), socketUnit: NO_SOCKET_UNIT });
  assert.equal(items.length, 1);
  assert.equal(items[0].source, "caddy-proxy-socket");
  assert.equal(items[0].severity, "warn");
  assert.deepEqual(items[0].remedies, []);
  assert.match(items[0].why, /fix-caddy-proxy-socket\.sh/);

  items.length = 0;
  await detector.check(store, { caddyfile: fixture("socket2", SOCKET_CADDYFILE), socketUnit: NO_SOCKET_UNIT });
  assert.equal(items.length, 0, "nothing is written when the Caddyfile is fine");
});

test("detector.check RESOLVES its card once the problem is gone (Caddy dials the socket)", async () => {
  const items = [];
  const resolved = [];
  const store = {
    upsertItem: async (i) => { items.push(i); return { id: 1, notify: true }; },
    resolveByKey: async (source, key) => { resolved.push([source, key]); },
  };
  const caddyfile = fixture("loopback4", LOOPBACK_CADDYFILE);
  await detector.check(store, { caddyfile, socketUnit: NO_SOCKET_UNIT });
  assert.equal(items.length, 1);
  assert.deepEqual(resolved, [], "nothing to resolve while the problem is there");

  const fixed = fixture("socket4", SOCKET_CADDYFILE);
  await detector.check(store, { caddyfile: fixed, socketUnit: NO_SOCKET_UNIT });
  assert.equal(items.length, 1, "no card is written once Caddy dials the socket");
  assert.deepEqual(resolved, [["caddy-proxy-socket", DEDUP_KEY]], "the stale card is resolved");

  // A store without resolveByKey (or one that throws) must not break boot.
  await detector.check({ upsertItem: async () => ({ id: 1, notify: false }) }, { caddyfile: fixed, socketUnit: NO_SOCKET_UNIT });
});