/**
 * Containment PR 6, layer 1 at the relay: on the gateway port the relay no
 * longer splices bytes. It terminates HTTP, judges EVERY request on the
 * connection (keep-alive and pipelining included) against the bot doors, and
 * forwards allowed requests with http.request — from the relay mark.
 *
 * The upstream here is a real loopback HTTP server, so the tests see exactly
 * what the gateway would: the paths that arrived, and the source address each
 * one came from. A spliced relay would pass every one of these requests (and
 * every one of these holes) straight through.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer, connect } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startEgressRelay } from "../scripts/pi-bots/pi_egress.mjs";
import { RELAY_SOURCE_V4 } from "../servers/shared/bot-doors.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) {
  const t = Date.now();
  while (!fn()) { if (Date.now() - t > ms) throw new Error("timed out waiting"); await sleep(10); }
}

const scratch = mkdtempSync(join(tmpdir(), "crow-door-filter-"));
const relays = [];
let up, upPort, seen = [];

before(async () => {
  up = createHttpServer((req, res) => {
    seen.push({ method: req.method, path: req.url, mark: req.socket.remoteAddress, headers: req.headers });
    if (req.url === "/llm/v1/sse") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.flushHeaders();
      res.write("data: 1\n\n");
      setTimeout(() => { res.write("data: 2\n\n"); res.end(); }, 150);
      return;
    }
    const body = JSON.stringify({ ok: true, path: req.url });
    res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
    res.end(body);
  });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  upPort = up.address().port;
});
after(async () => {
  for (const r of relays) { try { await r.close(); } catch {} }
  await new Promise((r) => up.close(() => r()));
  rmSync(scratch, { recursive: true, force: true });
});

let n = 0;
async function relay(opts = {}) {
  const logs = [];
  const r = await startEgressRelay({
    dir: join(scratch, "r" + (++n)), botId: "bot-x", gatewayPort: upPort,
    log: (l) => logs.push(l), ...opts,
  });
  relays.push(r);
  return { r, logs };
}

/** A bot's side: the PORT line, then raw HTTP. Responses are read in order. */
function doorClient(sockPath, port) {
  const sock = connect(sockPath);
  const st = { buf: Buffer.alloc(0), waiters: [], events: [] };
  const pump = () => {
    while (st.waiters.length) {
      const end = st.buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      const head = st.buf.subarray(0, end).toString("latin1");
      const m = /^HTTP\/1\.[01] (\d{3})/.exec(head);
      if (!m) return;
      const cl = Number((/\r\ncontent-length:\s*(\d+)/i.exec(head) || [])[1] || 0);
      if (st.buf.length < end + 4 + cl) return;
      const body = st.buf.subarray(end + 4, end + 4 + cl).toString();
      st.buf = st.buf.subarray(end + 4 + cl);
      st.waiters.shift()({ status: Number(m[1]), head, body });
    }
  };
  sock.on("data", (d) => { st.events.push({ at: Date.now(), text: d.toString("latin1") }); st.buf = Buffer.concat([st.buf, d]); pump(); });
  sock.on("error", () => {});
  const ready = new Promise((resolve, reject) => {
    sock.on("connect", () => { sock.write(`PORT ${port}\n`); resolve(); });
    sock.on("error", reject);
  });
  return {
    sock, ready, events: st.events,
    raw: () => st.buf.toString("latin1"),
    write: (s) => sock.write(s),
    next: (ms = 3000) => new Promise((resolve, reject) => {
      st.waiters.push(resolve);
      pump();
      setTimeout(() => reject(new Error("no response within " + ms)), ms).unref?.();
    }),
    close: () => { try { sock.destroy(); } catch {} },
  };
}

const GET = (path, extra = "") => `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\n${extra}\r\n`;

test("refuses /internal/actor-sign", async () => {
  seen = [];
  const { r, logs } = await relay();
  const c = doorClient(r.socketPath, upPort);
  await c.ready;
  c.write(`POST /internal/actor-sign HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}`);
  const res = await c.next();
  assert.equal(res.status, 403, "the relay refuses it: nothing is opened upstream");
  assert.match(res.head, /connection: close/i);
  assert.equal(seen.length, 0, "the gateway never saw the request");
  assert.ok(logs.some((l) => /bot=bot-x deny POST \/internal\/actor-sign \(not a door\)$/.test(l)), logs.join("\n"));
  for (const line of logs) assert.ok(!line.includes("{}"), "the request body is never logged");
  c.close();
});

test("pipelined request after a door request is refused", async () => {
  seen = [];
  const { r, logs } = await relay();
  const c = doorClient(r.socketPath, upPort);
  await c.ready;
  // Both requests in ONE write: the old splice passed the second through with
  // the first, one connection being the whole trick.
  c.write(GET("/llm/v1/models")
    + "POST /internal/actor-sign HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 2\r\n\r\n{}");
  const first = await c.next();
  assert.equal(first.status, 200, "the door request still works");
  const second = await c.next();
  assert.equal(second.status, 403, "the smuggled request on the same connection is refused");
  assert.deepEqual(seen.map((x) => x.path), ["/llm/v1/models"]);
  assert.ok(logs.some((l) => /deny POST \/internal\/actor-sign \(not a door\)/.test(l)), logs.join("\n"));
  c.close();
});

test("upgrade refused", async () => {
  seen = [];
  const { r } = await relay();
  const ws = doorClient(r.socketPath, upPort);
  await ws.ready;
  ws.write(`GET /llm/v1/models HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n`
    + `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  assert.equal((await ws.next()).status, 403);
  ws.close();
  // A Connection: upgrade with no Upgrade value is the same refusal.
  const hdr = doorClient(r.socketPath, upPort);
  await hdr.ready;
  hdr.write(GET("/llm/v1/models", "Connection: upgrade\r\n"));
  assert.equal((await hdr.next()).status, 403);
  hdr.close();
  assert.equal(seen.length, 0, "an upgrade never reaches the gateway");
});

test("door request carries the mark", async () => {
  seen = [];
  const { r } = await relay();
  const c = doorClient(r.socketPath, upPort);
  await c.ready;
  c.write(GET("/board/mcp"));
  const res = await c.next();
  assert.equal(res.status, 200);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].mark, RELAY_SOURCE_V4, "the upstream socket is bound to the relay mark");
  assert.equal(seen[0].path, "/board/mcp");
  c.close();
});

test("a bot cannot speak for a proxy hop or a Tailscale login", async () => {
  seen = [];
  const { r } = await relay();
  const c = doorClient(r.socketPath, upPort);
  await c.ready;
  c.write(GET("/board/mcp", "X-Forwarded-For: 100.64.20.5\r\nX-Forwarded-Host: gw.example.ts.net\r\nX-Forwarded-Proto: https\r\n"
    + "Forwarded: for=100.64.20.5\r\nX-Real-IP: 100.64.20.5\r\nTailscale-User-Login: owner@example.com\r\nTailscale-Funnel-Request: ?1\r\n"
    + "X-Crow-Actor-Kind: bot\r\n"));
  const res = await c.next();
  assert.equal(res.status, 200);
  const h = seen[0].headers;
  for (const k of ["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "forwarded", "x-real-ip", "tailscale-user-login", "tailscale-funnel-request"]) {
    assert.equal(h[k], undefined, k + " must not reach the gateway");
  }
  assert.equal(h["x-crow-actor-kind"], "bot", "the bot's own (signed) actor headers still pass");
  c.close();
});

test("sse streams through", async () => {
  seen = [];
  const { r } = await relay();
  const c = doorClient(r.socketPath, upPort);
  await c.ready;
  c.write(GET("/llm/v1/sse"));
  await until(() => c.events.some((e) => e.text.includes("data: 2")));
  const first = c.events.find((e) => e.text.includes("data: 1"));
  const second = c.events.find((e) => e.text.includes("data: 2"));
  assert.ok(first && second, JSON.stringify(c.events));
  assert.ok(second.at - first.at >= 100, "each event arrives on its own, not as one buffered body: " + (second.at - first.at) + "ms");
  c.close();
});

test("no other loopback port", async () => {
  const otherSeen = [];
  const other = createNetServer((s) => { otherSeen.push("connected"); s.end("X"); });
  await new Promise((r) => other.listen(0, "127.0.0.1", r));
  const otherPort = other.address().port;
  try {
    const { r, logs } = await relay();
    const c = doorClient(r.socketPath, otherPort);
    await c.ready;
    c.write(GET("/llm/v1/models"));
    await sleep(200);
    assert.equal(c.raw(), "", "the connection is destroyed: no splice, no HTTP");
    assert.equal(otherSeen.length, 0, "the other loopback port is never opened");
    assert.ok(logs.some((l) => /deny 127\.0\.0\.1:\d+ \(not the bot's gateway port\)/.test(l)), logs.join("\n"));
    c.close();
  } finally { await new Promise((r) => other.close(() => r())); }
});

test("an upstream that cannot be reached gives 502 (fail closed)", async () => {
  // A port nothing listens on: the relay's own upstream connect fails.
  const probe = createNetServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const closedPort = probe.address().port;
  await new Promise((r) => probe.close(() => r()));
  const { r, logs } = await relay({ gatewayPort: closedPort });
  const c = doorClient(r.socketPath, closedPort);
  await c.ready;
  c.write(GET("/llm/v1/models"));
  const res = await c.next();
  assert.equal(res.status, 502, "an upstream failure is never a pass-through");
  assert.ok(logs.some((l) => /upstream (ECONNREFUSED|error)/.test(l)), logs.join("\n"));
  c.close();
});

test("doorFilter: false still forwards through node:http, from the mark (the seam the gateway guard is proven with)", async () => {
  seen = [];
  const { r } = await relay({ doorFilter: false });
  const c = doorClient(r.socketPath, upPort);
  await c.ready;
  c.write(`POST /internal/actor-sign HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 2\r\n\r\n{}`);
  const res = await c.next();
  assert.equal(res.status, 200, "the relay does not judge the path here");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].mark, RELAY_SOURCE_V4, "the mark is still set: the gateway layer has something to refuse");
  assert.equal(seen[0].path, "/internal/actor-sign");
  c.close();
});