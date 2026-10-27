/**
 * The preview renderer's bounded loopback fetch (R4-C2): GET only, no browser header,
 * no redirect followed, 8 MB per response, 32 MB and 100 requests per render, 4 in
 * flight, 5 s per request, and the render's end aborts what is in flight. Every case
 * runs against a local http stub on 127.0.0.1.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createOriginFetcher, PREVIEW_LIMITS } from "../servers/gateway/preview/origin-fetch.js";

const MiB = 1024 * 1024;
const servers = [];
after(() => { for (const s of servers) { s.closeAllConnections?.(); s.close(); } });

/** A stub origin; `handle(req, res, stub)` answers; hits and sockets are counted. */
async function stub(handle) {
  const st = { hits: [], sockets: 0, closed: 0, active: 0, peak: 0, bodyBytes: 0 };
  const s = http.createServer(async (req, res) => {
    st.hits.push({ method: req.method, url: req.url, headers: { ...req.headers } });
    st.active++; st.peak = Math.max(st.peak, st.active);
    res.on("close", () => { st.active--; });
    try { await handle(req, res, st); } catch { try { res.destroy(); } catch {} }
  });
  s.on("connection", (sock) => { st.sockets++; sock.on("close", () => { st.closed++; }); });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  servers.push(s);
  st.port = s.address().port;
  return st;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fetcherFor = (st, limits) => createOriginFetcher({ host: "127.0.0.1", port: st.port, ...(limits ? { limits: { ...PREVIEW_LIMITS, ...limits } } : {}) });

/** Writes `total` bytes in 64 KiB chunks, honouring backpressure; counts what left. */
async function stream(res, total, st) {
  const chunk = Buffer.alloc(64 * 1024, 0x61);
  let sent = 0;
  while (sent < total && !res.destroyed) {
    const n = Math.min(chunk.length, total - sent);
    const okw = res.write(n === chunk.length ? chunk : chunk.subarray(0, n));
    sent += n;
    st.bodyBytes = sent;
    if (!okw) await new Promise((r) => { res.once("drain", r); res.once("close", r); });
  }
  if (!res.destroyed) res.end();
}

test("PREVIEW_LIMITS are the reviewed values", () => {
  assert.deepEqual({ ...PREVIEW_LIMITS }, { requestMs: 5000, renderMs: 15000, responseBytes: 8388608, renderBytes: 33554432, requests: 100, inFlight: 4 });
  assert.ok(Object.isFrozen(PREVIEW_LIMITS));
});

test("GET only, and no browser header is forwarded", async () => {
  const st = await stub((req, res) => { res.writeHead(200, { "content-type": "text/css", "x-a": "1" }); res.end("body{}"); });
  const s = fetcherFor(st).session({ signal: new AbortController().signal });
  const r = await s.get("/v/T/a.css?x=1");
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.equal(r.body.toString(), "body{}");
  assert.deepEqual(r.headers.find(([k]) => k === "x-a"), ["x-a", "1"]);
  assert.equal(st.hits.length, 1);
  assert.equal(st.hits[0].method, "GET");
  assert.equal(st.hits[0].url, "/v/T/a.css?x=1");
  for (const h of ["cookie", "referer", "authorization", "origin", "user-agent"]) assert.equal(st.hits[0].headers[h], undefined, h);
});

test("a 302 is redirect, never followed", async () => {
  const st = await stub((req, res) => {
    if (req.url === "/target") { res.writeHead(200); return res.end("followed"); }
    res.writeHead(302, { location: `http://127.0.0.1:${st.port}/target` }); res.end();
  });
  const r = await fetcherFor(st).session().get("/v/T/");
  assert.deepEqual(r, { ok: false, reason: "redirect" });
  await sleep(100);
  assert.equal(st.hits.filter((h) => h.url === "/target").length, 0);
});

test("a declared size over 8 MB is refused before the body", async () => {
  const st = await stub(async (req, res) => {
    res.writeHead(200, { "content-length": String(9437184) });
    await stream(res, 9437184, st);
  });
  const s = fetcherFor(st).session();
  const r = await s.get("/big");
  assert.deepEqual(r, { ok: false, reason: "cap_response" });
  assert.ok(s.stats().bytes <= 64 * 1024, `read ${s.stats().bytes} bytes`);
});

test("a streamed 20 MB body is cut at 8 MB", async () => {
  const st = await stub(async (req, res) => { res.writeHead(200); await stream(res, 20 * MiB, st); });
  const s = fetcherFor(st).session();
  const r = await s.get("/big");
  assert.deepEqual(r, { ok: false, reason: "cap_response" });
  assert.ok(s.stats().bytes <= 8 * MiB + 64 * 1024, `read ${s.stats().bytes} bytes`);
  await sleep(200);
  assert.ok(st.bodyBytes < 20 * MiB, `the stub stopped early (${st.bodyBytes})`);
});

test("the render total caps at 32 MB", async () => {
  const st = await stub(async (req, res) => { res.writeHead(200); await stream(res, 7 * MiB, st); });
  const s = fetcherFor(st).session();
  for (let i = 0; i < 4; i++) {
    const r = await s.get(`/r${i}`);
    assert.equal(r.ok, true, `response ${i + 1}: ${r.reason}`);
    assert.equal(r.body.length, 7 * MiB);
  }
  assert.deepEqual(await s.get("/r4"), { ok: false, reason: "cap_render" });
  assert.ok(s.stats().bytes <= 32 * MiB + 64 * 1024);
});

test("the 101st request is refused", async () => {
  const st = await stub((req, res) => { res.writeHead(200); res.end("x"); });
  const s = fetcherFor(st).session();
  for (let i = 0; i < 100; i++) assert.equal((await s.get(`/r${i}`)).ok, true);
  assert.deepEqual(await s.get("/r100"), { ok: false, reason: "cap_requests" });
  assert.equal(st.hits.length, 100);
  assert.equal(s.stats().requests, 100);
});

test("never more than 4 in flight", async () => {
  const st = await stub(async (req, res) => { await sleep(100); res.writeHead(200); res.end("x"); });
  const s = fetcherFor(st).session();
  const all = await Promise.all(Array.from({ length: 10 }, (_, i) => s.get(`/r${i}`)));
  assert.ok(all.every((r) => r.ok));
  assert.equal(st.peak, 4);
  assert.equal(s.stats().maxInFlight, 4);
});

test("a queued request's clock starts when it is sent", async () => {
  // 150 ms each, 300 ms per request: the fifth waits ~150 ms for a slot and still fits.
  const st = await stub(async (req, res) => { await sleep(150); res.writeHead(200); res.end("x"); });
  const s = fetcherFor(st, { requestMs: 300 }).session();
  const all = await Promise.all(Array.from({ length: 8 }, (_, i) => s.get(`/r${i}`)));
  assert.deepEqual(all.map((r) => r.ok), Array(8).fill(true));
});

test("a slow origin hits the per-request timeout", async () => {
  const st = await stub(async (req, res) => { await sleep(2000); if (!res.destroyed) { res.writeHead(200); res.end("late"); } });
  const s = fetcherFor(st, { requestMs: 200 }).session();
  const t0 = Date.now();
  const r = await s.get("/slow");
  const ms = Date.now() - t0;
  assert.deepEqual(r, { ok: false, reason: "timeout" });
  assert.ok(ms >= 200 && ms <= 700, `timed out after ${ms} ms`);
});

test("the render's end aborts what's in flight", async () => {
  const st = await stub(async (req, res) => { res.writeHead(200); res.write("x"); await sleep(5000); });
  const ac = new AbortController();
  const s = fetcherFor(st).session({ signal: ac.signal });
  const p = s.get("/hold");
  await sleep(150);
  assert.equal(st.closed, 0);
  ac.abort();
  assert.deepEqual(await p, { ok: false, reason: "aborted" });
  const t0 = Date.now();
  while (st.closed < 1 && Date.now() - t0 < 2000) await sleep(20);
  assert.equal(st.closed, 1, "the stub saw the socket close");
  assert.deepEqual(await s.get("/after"), { ok: false, reason: "aborted" });
});

test("artifactOriginInfo exposes bindHost", async () => {
  const rt = await import("../servers/gateway/artifact-origin/runtime.js");
  const freePort = async () => {
    const s = http.createServer();
    await new Promise((r) => s.listen(0, "127.0.0.1", r));
    const p = s.address().port;
    await new Promise((r) => s.close(r));
    return p;
  };
  for (const [bind, want] of [["0.0.0.0", "127.0.0.1"], ["127.0.0.1", "127.0.0.1"], ["::", "::1"]]) {
    rt._resetForTest();
    const p = await freePort();
    try {
      await rt.startArtifactOriginFromEnv({ CROW_ARTIFACT_ORIGIN_PORT: String(p), CROW_ARTIFACT_ORIGIN_BIND: bind });
      assert.equal(rt.artifactOriginInfo().bindHost, want, `bind ${bind}`);
      // And the fetcher reaches the listener there (a token-less path is a sandboxed 404).
      const r = await createOriginFetcher({ host: want, port: p }).session().get("/v/x/");
      assert.equal(r.ok, true);
      assert.equal(r.status, 404);
    } finally { rt._resetForTest(); }
  }
});
