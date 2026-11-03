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
      setTimeout(() => { res.write("data: 2\n\n"); res.end(); }, 400);
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
  assert.ok(second.at - first.at >= 200, "each event arrives on its own, not as one buffered body: " + (second.at - first.at) + "ms");
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

// ---- containment PR 6 review fixes ---------------------------------------

/** An upstream that answers after `ms`, recording how many requests it holds at once. */
async function slowUpstream(ms) {
  const st = { concurrent: 0, peak: 0, paths: [] };
  const srv = createHttpServer((req, res) => {
    st.concurrent++;
    st.peak = Math.max(st.peak, st.concurrent);
    st.paths.push(req.url);
    setTimeout(() => {
      st.concurrent--;
      const body = JSON.stringify({ path: req.url });
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      res.end(body);
    }, ms);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  st.port = srv.address().port;
  st.close = () => new Promise((r) => srv.close(() => r()));
  return st;
}

test("pipelined requests on one connection are served one at a time", async () => {
  const up2 = await slowUpstream(15);
  try {
    const { r } = await relay({ gatewayPort: up2.port });
    const c = doorClient(r.socketPath, up2.port);
    await c.ready;
    // 50 requests through ONE connection, sent in batches of four: every batch
    // is pipelined (written without waiting for any response) while the relay's
    // per-connection queue cap (8) is never exceeded.
    const paths = Array.from({ length: 50 }, (_, i) => "/llm/v1/models?n=" + i);
    const got = [];
    for (let i = 0; i < paths.length; i += 4) {
      const batch = paths.slice(i, i + 4);
      for (const p of batch) c.write(GET(p));
      for (let k = 0; k < batch.length; k++) got.push(await c.next(5000));
    }
    assert.deepEqual(got.map((g) => g.status), Array(50).fill(200), "every pipelined request is answered");
    assert.deepEqual(got.map((g) => JSON.parse(g.body).path), paths, "in order");
    assert.equal(up2.peak, 1, "one upstream request open at a time (was: one per pipelined request)");
    c.close();
  } finally { await up2.close(); }
});

test("a flood past the per-connection queue is refused with 503 and closes", async () => {
  const up2 = await slowUpstream(60);
  try {
    const { r } = await relay({ gatewayPort: up2.port });
    const c = doorClient(r.socketPath, up2.port);
    await c.ready;
    // 20 requests in ONE write: 1 in flight, 8 queued, the rest refused.
    for (let i = 0; i < 20; i++) c.write(GET("/llm/v1/models?n=" + i));
    const got = [];
    for (let i = 0; i < 10; i++) got.push(await c.next(5000));
    assert.deepEqual(got.slice(0, 9).map((g) => g.status), Array(9).fill(200), "one in flight + eight queued");
    assert.equal(got[9].status, 503, "the ninth queued request is beyond the cap");
    assert.match(got[9].head, /connection: close/i);
    c.close();
  } finally { await up2.close(); }
});

test("the relay-wide upstream cap answers 503", async () => {
  const up2 = await slowUpstream(600);
  try {
    const { r, logs } = await relay({ gatewayPort: up2.port, maxUpstream: 2 });
    const a = doorClient(r.socketPath, up2.port), b = doorClient(r.socketPath, up2.port);
    await a.ready; await b.ready;
    a.write(GET("/llm/v1/a"));
    b.write(GET("/llm/v1/b"));
    await until(() => up2.concurrent === 2);
    const c = doorClient(r.socketPath, up2.port);
    await c.ready;
    c.write(GET("/llm/v1/c"));
    assert.equal((await c.next()).status, 503, "the third connection's request is over the relay cap");
    assert.equal((await a.next()).status, 200, "the two in flight still answer");
    assert.equal((await b.next()).status, 200);
    assert.ok(logs.some((l) => /relay upstream cap 2/.test(l)), logs.join("\n"));
    a.close(); b.close(); c.close();
  } finally { await up2.close(); }
});

// ---- a body on a bodiless method would be forwarded unframed ----------------

test("a GET with a chunked body is refused, nothing upstream", async () => {
  seen = [];
  const { r, logs } = await relay();
  const c = doorClient(r.socketPath, upPort);
  await c.ready;
  c.write("GET /llm/v1/models HTTP/1.1\r\nHost: 127.0.0.1\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n");
  const res = await c.next();
  assert.equal(res.status, 400, "the relay refuses it itself");
  assert.match(res.head, /connection: close/i);
  assert.deepEqual(JSON.parse(res.body), { error: "bad request" });
  assert.equal(seen.length, 0, "nothing was opened upstream");
  assert.ok(logs.some((l) => /deny GET \/llm\/v1\/models \(body on a bodiless method\)/.test(l)), logs.join("\n"));
  c.close();
});

test("a GET with Content-Length > 0 is refused", async () => {
  seen = [];
  const { r } = await relay();
  const c = doorClient(r.socketPath, upPort);
  await c.ready;
  c.write("GET /llm/v1/models HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 5\r\n\r\nhello");
  const res = await c.next();
  assert.equal(res.status, 400);
  assert.match(res.head, /connection: close/i);
  assert.equal(seen.length, 0, "the five bytes never reached the gateway as a second request");
  c.close();
});

test("a chunked POST is forwarded framed", async () => {
  const bodies = [];
  const parsed = createHttpServer((req, res) => {
    let b = "";
    req.setEncoding("utf8");
    req.on("data", (d) => { b += d; });
    req.on("end", () => { bodies.push(b); res.writeHead(200, { "content-length": 2 }); res.end("ok"); });
  });
  await new Promise((r) => parsed.listen(0, "127.0.0.1", r));
  // A raw TCP upstream: the head the relay wrote, byte for byte.
  let head = "";
  let answered = false;
  const raw = createNetServer((sock) => {
    sock.on("error", () => {});
    sock.on("data", (d) => {
      head += d.toString("latin1");
      const end = head.indexOf("\r\n\r\n");
      if (answered || end < 0) return;
      if (head.slice(end + 4).includes("0\r\n\r\n")) {
        answered = true;
        sock.end("HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok");
      }
    });
  });
  await new Promise((r) => raw.listen(0, "127.0.0.1", r));
  const rawPort = raw.address().port;
  try {
    // 1. through a real HTTP parser upstream: the body arrives intact.
    const one = await relay({ gatewayPort: parsed.address().port });
    const c1 = doorClient(one.r.socketPath, parsed.address().port);
    await c1.ready;
    c1.write("POST /llm/v1/models HTTP/1.1\r\nHost: 127.0.0.1\r\nTransfer-Encoding: chunked\r\n\r\n7\r\n{\"a\":1}\r\n0\r\n\r\n");
    assert.equal((await c1.next()).status, 200);
    assert.deepEqual(bodies, ["{\"a\":1}"], "the gateway's parser reassembled the chunked body");
    c1.close();
    // 2. a raw TCP upstream sees the framing header on the relay's own hop.
    const two = await relay({ gatewayPort: rawPort });
    const c2 = doorClient(two.r.socketPath, rawPort);
    await c2.ready;
    c2.write("POST /llm/v1/models HTTP/1.1\r\nHost: 127.0.0.1\r\nTransfer-Encoding: chunked\r\n\r\n7\r\n{\"a\":1}\r\n0\r\n\r\n");
    assert.equal((await c2.next()).status, 200);
    const headText = head.slice(0, head.indexOf("\r\n\r\n"));
    assert.match(headText, /\r\ntransfer-encoding: chunked\r\n/i, headText);
    assert.equal(/content-length:/i.test(headText), false, "one framing per hop, never both");
    assert.match(head.slice(head.indexOf("\r\n\r\n")), /7\r\n\{"a":1\}\r\n0\r\n\r\n/, "the body is chunk-framed, not raw");
    c2.close();
  } finally {
    await new Promise((r) => parsed.close(() => r()));
    await new Promise((r) => raw.close(() => r()));
  }
});

// ---- an upstream that dies mid-body -----------------------------------------

test("an upstream that dies mid-body closes the bot's connection", async () => {
  const dying = createNetServer((sock) => {
    sock.on("error", () => {});
    sock.once("data", () => {
      sock.write("HTTP/1.1 200 OK\r\ncontent-length: 1000\r\n\r\n1234567");
      setTimeout(() => { try { sock.destroy(); } catch {} }, 20);
    });
  });
  await new Promise((r) => dying.listen(0, "127.0.0.1", r));
  const dyingPort = dying.address().port;
  try {
    const { r } = await relay({ gatewayPort: dyingPort });
    const c = connect(r.socketPath);
    c.on("error", () => {});
    const closed = new Promise((resolve) => c.on("close", () => resolve(Date.now())));
    const t0 = Date.now();
    c.on("connect", () => c.write(`PORT ${dyingPort}\nGET /llm/v1/models HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`));
    c.on("data", () => {});
    const at = await Promise.race([closed, sleep(2000).then(() => null)]);
    assert.ok(at !== null, "a truncated upstream body must not leave the bot's connection half-answered");
    assert.ok(at - t0 < 2000);
  } finally { await new Promise((r) => dying.close(() => r())); }
});

// ---- the doors server's own timeout (it never listens) ----------------------

test("a PORT line followed by a partial head is closed after headTimeoutMs", async () => {
  const { r } = await relay({ headTimeoutMs: 300 });
  const c = connect(r.socketPath);
  c.on("error", () => {});
  const closed = new Promise((resolve) => c.on("close", () => resolve(Date.now())));
  const t0 = Date.now();
  c.on("connect", () => c.write(`PORT ${upPort}\nGET /llm/v1/models HTTP/1.1\r\nHost: 127.0.0.1\r\n`));
  c.on("data", () => {});
  const at = await Promise.race([closed, sleep(2000).then(() => null)]);
  assert.ok(at !== null, "the socket is closed after headTimeoutMs, not left hanging");
  assert.ok(at - t0 < 2000, "closed within 2 s (was: never, the server never listens)");
  c.destroy();
});