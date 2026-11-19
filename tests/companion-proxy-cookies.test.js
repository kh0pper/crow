/**
 * The companion proxy (`/companion/*`) is the SECOND place Crow serves a
 * third-party app on the dashboard's own origin — Open-LLM-VTuber receives the
 * browser's whole `Cookie` header, and its `Set-Cookie` lands back on the
 * dashboard origin. It had neither half of the queue-item-#51 rule that
 * `/proxy/<id>/` got (routes/extension-proxy.js): the request handed
 * `crow_session` to the companion app and every `Set-Cookie` came straight
 * through, unfiltered and unscoped.
 *
 * Both halves are now the SAME shared helper (servers/gateway/proxy-cookie-filter.js),
 * checked here against the REAL proxy in front of a REAL stub upstream — an
 * options-level assertion would not prove what actually leaves the gateway.
 *
 * companion-proxy.js reads COMPANION_PORT at module load, so the stub upstream
 * is bound and the env pointed at it BEFORE the import (the
 * extension-proxy-cookies.test.js idiom) and the proxy is built ONCE, as the
 * gateway builds it once.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CROW_HOME = mkdtempSync(join(tmpdir(), "crow-companion-proxy-cookies-"));
process.env.CROW_HOME = CROW_HOME;
process.env.CROW_DATA_DIR = CROW_HOME; // no real instance id / no real crow.db
process.env.CROW_DB_PATH = join(CROW_HOME, "crow.db");

// ---------------------------------------------------------------------------
// fixtures — one stub companion, one real proxy, one gateway socket
// ---------------------------------------------------------------------------

/** Every socket a server accepts, so teardown can end upgraded ones too. */
function track(server) {
  const set = new Set();
  server.on("connection", (s) => { set.add(s); s.on("close", () => set.delete(s)); });
  return () => { for (const s of set) s.destroy(); };
}

const httpSeen = [];
const wsSeen = [];
/** The `Set-Cookie`s the stub companion answers with, per test. */
let stubSetCookies = null;
/**
 * What the stub answers a WebSocket UPGRADE with, per test:
 *   null                                   → a plain 101, closed after 20 ms
 *   { headers: [...], echo: true }         → a 101 with those raw header lines, echoing data
 *   { status, reason, headers, body }      → a NON-101 response (a refused upgrade)
 */
let stubWs = null;
let upstream = null;
let gateway = null;
let killUpstream = null;
let killGateway = null;

function reset({ setCookies = null, ws = null } = {}) {
  stubSetCookies = setCookies;
  stubWs = ws;
  httpSeen.length = 0;
  wsSeen.length = 0;
}

/** The stub's answer to one upgrade, per `stubWs` (see above). */
function answerUpgrade(socket) {
  if (stubWs?.status && stubWs.status !== 101) {
    const body = stubWs.body || "";
    const lines = [
      `HTTP/1.1 ${stubWs.status} ${stubWs.reason || "Error"}`,
      "Content-Type: text/plain",
      `Content-Length: ${Buffer.byteLength(body)}`,
      ...(stubWs.headers || []),
    ];
    socket.write(lines.join("\r\n") + "\r\n\r\n" + body);
    setTimeout(() => socket.end(), 20);
    return;
  }
  const extra = (stubWs?.headers || []).join("\r\n");
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
    (extra ? extra + "\r\n" : "") + "\r\n");
  if (stubWs?.echo) {
    socket.on("data", (d) => socket.write(Buffer.concat([Buffer.from("echo:"), d])));
    return; // stays open: the test drives both directions
  }
  setTimeout(() => socket.end(), 20);
}

before(async () => {
  upstream = http.createServer((req, res) => {
    httpSeen.push({ url: req.url, cookie: req.headers.cookie });
    const headers = { "content-type": "text/plain" };
    if (stubSetCookies) headers["set-cookie"] = stubSetCookies;
    res.writeHead(200, headers);
    res.end("upstream ok");
  });
  upstream.on("upgrade", (req, socket) => {
    wsSeen.push({ url: req.url, cookie: req.headers.cookie });
    answerUpgrade(socket);
  });
  killUpstream = track(upstream);
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));

  // companion-proxy.js reads COMPANION_PORT at load — point it at the stub first.
  process.env.COMPANION_PORT = String(upstream.address().port);
  const { default: setupCompanionProxy } = await import("../servers/gateway/routes/companion-proxy.js");
  const app = express();
  const server = http.createServer(app);
  setupCompanionProxy(app, server);
  killGateway = track(server);
  gateway = server;
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
});

after(() => {
  try { killGateway?.(); gateway?.close(); } catch {}
  try { killUpstream?.(); upstream?.close(); } catch {}
  try { rmSync(CROW_HOME, { recursive: true, force: true }); } catch {}
});

function get(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port: gateway.address().port, path, headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error("timeout")); });
  });
}

/** A raw upgrade request; resolves with the first response line. */
function rawUpgrade(path, headers = {}) {
  const port = gateway.address().port;
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1", () => {
      const extra = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join("");
      s.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n${extra}\r\n`);
    });
    let buf = "";
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(buf.split("\r\n")[0] || ""); } };
    s.on("data", (c) => { buf += c; if (buf.includes("\r\n")) { s.destroy(); finish(); } });
    s.on("close", finish);
    s.on("error", finish);
    s.setTimeout(3000, () => { s.destroy(); finish(); });
  });
}

function setCookieValues(headers) {
  const v = headers["set-cookie"];
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

/**
 * An upgrade whose raw bytes stay readable: `waitFor(text)` resolves once that
 * text has arrived (or the socket closed, which also resolves), `text()` is
 * everything received so far. Used to read the handshake — both the header
 * block and whatever follows it — and to drive frames on the live socket.
 */
function wsConnect(path, headers = {}) {
  const port = gateway.address().port;
  const socket = net.connect(port, "127.0.0.1", () => {
    const extra = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join("");
    socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n${extra}\r\n`);
  });
  let buf = "";
  let closed = false;
  const waiters = [];
  const settle = () => {
    for (const w of [...waiters]) {
      if (!buf.includes(w.needle)) continue;
      waiters.splice(waiters.indexOf(w), 1);
      clearTimeout(w.timer);
      w.resolve();
    }
  };
  socket.on("data", (c) => { buf += c.toString("latin1"); settle(); });
  socket.on("close", () => { closed = true; for (const w of waiters.splice(0)) { clearTimeout(w.timer); w.resolve(); } });
  return {
    socket,
    text: () => buf,
    /** Resolve once `needle` has arrived (or the socket closed). */
    waitFor: (needle, ms = 3000) => new Promise((resolve, reject) => {
      if (buf.includes(needle) || closed) return resolve();
      const w = { needle, resolve };
      w.timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(w), 1);
        reject(new Error(`timed out waiting for ${JSON.stringify(needle)}; got ${JSON.stringify(buf)}`));
      }, ms);
      waiters.push(w);
    }),
    close: () => socket.destroy(),
  };
}

// ---------------------------------------------------------------------------
// the request path — the companion app never sees Crow's cookies
// ---------------------------------------------------------------------------

test("HTTP: the companion backend receives the app's cookies and none of Crow's", async () => {
  reset();
  const res = await get("/companion/x", {
    cookie: "app_sid=abc123; crow_session=live-dashboard-session; crow_csrf=csrf-value; crow_mode_local=classic; theme=dark",
  });
  assert.equal(res.status, 200);
  assert.equal(httpSeen.length, 1);
  assert.equal(httpSeen[0].cookie, "app_sid=abc123; theme=dark",
    "the companion app is third-party code on the dashboard's origin: Crow's session must not be forwarded to it");
});

test("HTTP: a request carrying only Crow's cookies arrives with no Cookie header at all", async () => {
  reset();
  await get("/companion/x", { cookie: "crow_session=only; crow_csrf=only" });
  assert.equal(httpSeen.length, 1);
  assert.equal(httpSeen[0].cookie, undefined, "nothing left → the header is dropped, not sent empty");
});

test("WebSocket upgrade: the companion backend receives the app's cookies and none of Crow's", async () => {
  reset();
  const line = await rawUpgrade("/companion/client-ws", {
    cookie: "app_sid=abc123; crow_session=live-dashboard-session; crow_csrf=csrf-value; theme=dark",
  });
  assert.match(line, /101/);
  assert.equal(wsSeen.length, 1);
  assert.equal(wsSeen[0].cookie, "app_sid=abc123; theme=dark",
    "the upgrade never runs the `proxyReq` hook — proxyReqWs must strip there too");
});

// ---------------------------------------------------------------------------
// the response path — the companion app cannot set Crow's cookies, and its own
// are scoped under /companion/
// ---------------------------------------------------------------------------

test("a companion Set-Cookie for a Crow name is dropped; the app's own cookie is kept and scoped", async () => {
  reset({
    setCookies: [
      "crow_session=forged; Path=/",
      "=crow_session=forged-too",
      "crow_csrf=forged; Path=/",
      "app_sid=abc; Path=/",
    ],
  });
  const cookies = setCookieValues((await get("/companion/")).headers);
  assert.deepEqual(cookies, ["app_sid=abc; Path=/companion/"],
    "a companion cannot mint or overwrite the dashboard cookies, and its own is scoped to /companion/");
});

test("the shared parser applies here too: `Path =/`, a last origin-wide Path, and Domain never survive", async () => {
  reset({
    setCookies: [
      "spaced=1; Path =/",
      "last=1; Path=/x; Path =/",
      "sub=1; Path=/api",
      "climb=1; Path=/../..",
      "dom=1; Domain =ex.com; Path=/",
      "nopath=1; HttpOnly",
    ],
  });
  assert.deepEqual(setCookieValues((await get("/companion/")).headers), [
    "spaced=1; Path=/companion/",
    "last=1; Path=/companion/",
    "sub=1; Path=/companion/api",
    "climb=1; Path=/companion/",
    "dom=1; Path=/companion/",
    "nopath=1; HttpOnly; Path=/companion/",
  ]);
});

test("a companion response with no Set-Cookie is left alone", async () => {
  reset();
  assert.deepEqual(setCookieValues((await get("/companion/")).headers), []);
});

// ---------------------------------------------------------------------------
// the WebSocket handshake — http-proxy writes the upstream's header block
// straight to the client socket, so `proxyRes` never sees it
// ---------------------------------------------------------------------------

test("a 101 carries no Set-Cookie at all (Crow's or the app's), and frames still flow both ways", async () => {
  reset({
    ws: {
      echo: true,
      headers: [
        "Set-Cookie: crow_session=forged; Path=/",
        "Set-Cookie: app_sid=abc; Path=/",
        "X-Kept: yes",
      ],
    },
  });
  const ws = wsConnect("/companion/client-ws");
  try {
    await ws.waitFor("\r\n\r\n");
    const head = ws.text().slice(0, ws.text().indexOf("\r\n\r\n"));
    assert.match(head, /^HTTP\/1\.1 101/, "the upgrade still succeeds");
    assert.doesNotMatch(head, /set-cookie/i,
      "a 101 is a handshake, not a document response: the app may set no cookie there — least of all crow_session");
    assert.match(head, /x-kept: yes/i, "every other handshake header is forwarded untouched");
    assert.equal(wsSeen.length, 1, "the upgrade reached the companion");

    ws.socket.write("ping");
    await ws.waitFor("echo:ping");
    assert.match(ws.text(), /echo:ping/, "the socket still carries data in both directions after the header block");
  } finally {
    ws.close();
  }
});

test("a non-101 refusal from the companion reaches the browser without its Set-Cookie", async () => {
  reset({
    ws: {
      status: 403,
      reason: "Forbidden",
      headers: ["Set-Cookie: crow_session=forged; Path=/", "Set-Cookie: app_sid=abc; Path=/"],
      body: "no upgrade for you",
    },
  });
  const ws = wsConnect("/companion/client-ws");
  try {
    await ws.waitFor("no upgrade for you");
    const text = ws.text();
    const head = text.slice(0, text.indexOf("\r\n\r\n"));
    assert.match(head, /^HTTP\/1\.1 403/, "the refusal is forwarded as it is");
    assert.doesNotMatch(head, /set-cookie/i, "an error response to an upgrade sets no cookies on our origin either");
    assert.match(text, /no upgrade for you/, "the response body is untouched");
  } finally {
    ws.close();
  }
});