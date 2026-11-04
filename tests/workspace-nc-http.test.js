// ncFetch and pooled keep-alive sockets the server already closed. Seen as the T10-I3 calendar flake: a long repeat
// expansion kept the event loop busy past the server's 5 s keep-alive timeout, so the next request went out on a
// socket the server had already closed and failed with ECONNRESET ("workspace_unreachable").
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { ncFetch } from "../bundles/workspace/server/nc/http.js";
import { queryEvents } from "../bundles/workspace/server/pim/caldav.js";

const cfg = { user: "crow-bot", appPassword: "pw" };
// fetch hands a socket back to its pool a few loop turns after the body is read; give it that time (in the real
// failure the socket had sat idle for seconds)
const idle = async (res) => { await res.text(); await new Promise((r) => setTimeout(r, 50)); };
/** A fresh origin per case (so the client pool starts empty) whose second request on a kept-alive socket is reset:
 *  the server already dropped that socket and the client did not notice in time. */
async function staleSocketServer(fn) {
  const seen = []; const perSocket = new WeakMap();
  const server = http.createServer((req, res) => {
    const n = (perSocket.get(req.socket) || 0) + 1; perSocket.set(req.socket, n);
    seen.push(`${req.method} #${n}`);
    if (n > 1) { req.socket.resetAndDestroy(); return; }
    req.resume(); req.on("end", () => res.end("ok"));
  });
  server.keepAliveTimeout = 60000;
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try { await fn(`http://127.0.0.1:${server.address().port}/`, seen); }
  finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
}

for (const method of ["PROPFIND", "REPORT", "GET", "PUT", "DELETE"]) {
  test(`${method} that lands on a socket the server already closed is resent once, on a fresh connection`, () => staleSocketServer(async (base, seen) => {
    await idle(await ncFetch(cfg, "GET", base)); // leaves an idle kept-alive socket in the pool
    const r = await ncFetch(cfg, method, base, { body: method === "PUT" ? "x" : undefined });
    assert.equal(r.status, 200);
    assert.deepEqual(seen, ["GET #1", `${method} #2`, `${method} #1`]);
  }));
}

for (const method of ["POST", "MOVE"]) {
  test(`${method} is never resent: a reset is workspace_unreachable and the request went out once`, () => staleSocketServer(async (base, seen) => {
    await idle(await ncFetch(cfg, "GET", base));
    await assert.rejects(ncFetch(cfg, method, base, { body: method === "POST" ? "x" : undefined }), { code: "workspace_unreachable" });
    assert.deepEqual(seen, ["GET #1", `${method} #2`]);
  }));
}

test("a server that is down stays workspace_unreachable (refused connections are not retried)", async () => {
  const dead = http.createServer(); await new Promise((r) => dead.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${dead.address().port}/`; await new Promise((r) => dead.close(r));
  await assert.rejects(ncFetch(cfg, "GET", url), { code: "workspace_unreachable" });
});

// ---- the caller's own cancel (the Today card giving up on its calendar budget) ----
// A stub fetch that never answers on its own: it rejects only when its signal is aborted.
const stallingFetch = (seen) => (url, opts) => new Promise((_, reject) => {
  seen.signals.push(opts.signal);
  opts.signal.addEventListener("abort", () => reject(opts.signal.reason ?? Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
});
const withFetch = async (stub, fn) => {
  const real = globalThis.fetch; globalThis.fetch = stub;
  try { return await fn(); } finally { globalThis.fetch = real; }
};
const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));

test("a caller signal aborted mid-request aborts the request and reports it as cancelled", async () => {
  const seen = { signals: [] };
  await withFetch(stallingFetch(seen), async () => {
    const ac = new AbortController();
    const p = ncFetch(cfg, "GET", "http://127.0.0.1:1/", { signal: ac.signal });
    await tick();
    assert.equal(seen.signals.length, 1);
    assert.equal(seen.signals[0].aborted, false);
    ac.abort();
    await assert.rejects(p, (e) => e.code === "workspace_unreachable" && /cancelled/.test(e.message));
    assert.equal(seen.signals[0].aborted, true, "the request's own signal is aborted, not just the caller's");
  });
});

test("a signal already aborted sends nothing at all", async () => {
  const seen = { signals: [] };
  await withFetch(stallingFetch(seen), async () => {
    const ac = new AbortController(); ac.abort();
    await assert.rejects(ncFetch(cfg, "GET", "http://127.0.0.1:1/", { signal: ac.signal }),
      (e) => e.code === "workspace_unreachable" && /cancelled/.test(e.message));
    assert.equal(seen.signals.length, 0);
  });
});

test("without a caller signal the request still carries a timeout of its own", async () => {
  const seen = { signals: [] };
  await withFetch(stallingFetch(seen), async () => {
    await assert.rejects(ncFetch(cfg, "GET", "http://127.0.0.1:1/", { timeoutMs: 30 }),
      (e) => e.code === "workspace_unreachable" && /timed out/.test(e.message));
    assert.equal(seen.signals.length, 1);
    assert.ok(seen.signals[0] instanceof AbortSignal);
    assert.equal(seen.signals[0].aborted, true);
  });
});

test("a caller's abort is never resent, even for a method that may be sent twice", async () => {
  let calls = 0;
  await withFetch((url, opts) => new Promise((_, reject) => {
    calls++;
    // the reset a torn-down request can surface as: still not a reason to send it again
    opts.signal.addEventListener("abort", () => reject(Object.assign(new Error("reset"), { cause: { code: "ECONNRESET" } })), { once: true });
  }), async () => {
    const ac = new AbortController();
    const p = ncFetch(cfg, "PROPFIND", "http://127.0.0.1:1/", { signal: ac.signal });
    await tick();
    ac.abort();
    await assert.rejects(p, (e) => e.code === "workspace_unreachable" && /cancelled/.test(e.message));
    assert.equal(calls, 1);
  });
});

// ---- caldav hands the caller's signal down ----
test("queryEvents gives ncFetch the caller's signal", async () => {
  const seen = { signals: [] };
  const emptyMultistatus = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"></d:multistatus>`;
  await withFetch(async (url, opts) => {
    seen.signals.push(opts.signal);
    return new Response(emptyMultistatus, { status: 207, headers: { "Content-Type": "application/xml; charset=utf-8" } });
  }, async () => {
    const nc = { user: "crow-bot", appPassword: "pw", ncUrl: "http://127.0.0.1:1" };
    const cal = { kind: "cal", id: "personal", href: "/remote.php/dav/calendars/crow-bot/personal/" };
    const ac = new AbortController();
    const out = await queryEvents(nc, cal, new Date(0), new Date(86400000), { signal: ac.signal });
    assert.deepEqual(out, []);
    assert.equal(seen.signals.length, 1);
    assert.ok(seen.signals[0] instanceof AbortSignal);
    assert.equal(seen.signals[0].aborted, false);
    // and it is the caller's abort that travels: aborting the caller aborts the request's signal too
    ac.abort();
    assert.equal(seen.signals[0].aborted, true);
  });
});
