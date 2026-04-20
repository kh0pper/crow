import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Point peer-credentials at an empty file — the default fetch impl isn't
// exercised in these tests (we swap it), but the module pulls in peer-creds
// at import time and complains if the path doesn't exist.
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const tmp = mkdtempSync(join(tmpdir(), "crow-overview-cache-test-"));
writeFileSync(join(tmp, "peer-tokens.json"), "{}", { mode: 0o600 });
process.env.CROW_PEER_TOKENS_PATH = join(tmp, "peer-tokens.json");

const mod = await import("../servers/gateway/dashboard/overview-cache.js");
const { getPeerOverview, invalidatePeerCache, prefetchPeerOverviews, _resetCache, _setFetchImpl, _inspectCache } = mod;

const fakeDb = { execute: async () => ({ rows: [] }), close: () => {} };

function okEnvelope(overrides = {}) {
  return {
    ok: true,
    status: 200,
    body: {
      instance: { id: "aaa111", name: "crow", hostname: "crow.ts.net", is_home: false },
      tiles: [
        { id: "memory", name: "Memory", icon: "memory", pathname: "/dashboard/memory", port: null, category: "local-panel" },
        { id: "navidrome", name: "Navidrome", icon: "music", pathname: "/proxy/navidrome/", port: null, category: "bundle" },
      ],
      health: { status: "ok", checkedAt: "2026-04-20T00:00:00Z" },
    },
    raw: "stub",
    ...overrides,
  };
}

beforeEach(() => {
  _resetCache();
  _setFetchImpl(null);
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test("overview-cache: unknown icon → silently mapped to 'default'", async () => {
  _setFetchImpl(async () => okEnvelope());
  const r = await getPeerOverview(fakeDb, "peer-aaa111");
  assert.equal(r.status, "ok");
  const navidrome = r.tiles.find(t => t.id === "navidrome");
  assert.equal(navidrome.icon, "default", "unknown icon 'music' should downgrade to 'default'");
  const memory = r.tiles.find(t => t.id === "memory");
  assert.equal(memory.icon, "memory", "known icon preserved");
});

test("overview-cache: pathname with '..' segment → tile dropped", async () => {
  _setFetchImpl(async () => okEnvelope({
    body: {
      instance: { id: "aaa111", name: "crow", hostname: "crow.ts.net", is_home: false },
      tiles: [
        { id: "traversal", name: "Bad", icon: "default", pathname: "/dashboard/../etc", port: null, category: "local-panel" },
        { id: "memory", name: "Memory", icon: "memory", pathname: "/dashboard/memory", port: null, category: "local-panel" },
      ],
      health: { status: "ok", checkedAt: "now" },
    },
  }));
  const r = await getPeerOverview(fakeDb, "peer-aaa111");
  assert.equal(r.status, "ok");
  assert.equal(r.tiles.length, 1);
  assert.equal(r.tiles[0].id, "memory");
});

test("overview-cache: javascript: pathname → tile dropped (regex rejects)", async () => {
  _setFetchImpl(async () => okEnvelope({
    body: {
      instance: { id: "aaa111", name: "crow", hostname: "crow.ts.net", is_home: false },
      tiles: [
        { id: "xss", name: "Bad", icon: "default", pathname: "javascript:alert(1)", port: null, category: "local-panel" },
      ],
      health: { status: "ok", checkedAt: "now" },
    },
  }));
  const r = await getPeerOverview(fakeDb, "peer-aaa111");
  assert.equal(r.tiles.length, 0, "javascript: URI must be rejected");
});

test("overview-cache: unknown category → tile dropped", async () => {
  _setFetchImpl(async () => okEnvelope({
    body: {
      instance: { id: "aaa111", name: "crow", hostname: "crow.ts.net", is_home: false },
      tiles: [
        { id: "weird", name: "Weird", icon: "default", pathname: "/dashboard/x", port: null, category: "invented-category" },
      ],
      health: { status: "ok", checkedAt: "now" },
    },
  }));
  const r = await getPeerOverview(fakeDb, "peer-aaa111");
  assert.equal(r.tiles.length, 0);
});

test("overview-cache: missing tiles array → whole envelope rejected as schema_violation", async () => {
  _setFetchImpl(async () => ({ ok: true, status: 200, body: { instance: { id: "aaa111" }, health: {} }, raw: "{}" }));
  const r = await getPeerOverview(fakeDb, "peer-aaa111");
  assert.equal(r.status, "unavailable");
  assert.equal(r.reason, "schema_violation");
});

test("overview-cache: invalid port (0 / negative / non-int) → tile dropped", async () => {
  _setFetchImpl(async () => okEnvelope({
    body: {
      instance: { id: "aaa111", name: "crow", hostname: "crow.ts.net", is_home: false },
      tiles: [
        { id: "bad1", name: "Zero", icon: "default", pathname: "/x", port: 0, category: "bundle" },
        { id: "bad2", name: "Neg", icon: "default", pathname: "/x", port: -5, category: "bundle" },
        { id: "bad3", name: "Huge", icon: "default", pathname: "/x", port: 99999, category: "bundle" },
        { id: "good", name: "OK", icon: "default", pathname: "/x", port: 9000, category: "bundle" },
      ],
      health: { status: "ok", checkedAt: "now" },
    },
  }));
  const r = await getPeerOverview(fakeDb, "peer-aaa111");
  assert.equal(r.tiles.length, 1);
  assert.equal(r.tiles[0].id, "good");
});

// ---------------------------------------------------------------------------
// Caching behavior
// ---------------------------------------------------------------------------

test("overview-cache: successive gets within TTL share cached result (one fetch)", async () => {
  let calls = 0;
  _setFetchImpl(async () => { calls++; return okEnvelope(); });
  await getPeerOverview(fakeDb, "peer-aaa111");
  await getPeerOverview(fakeDb, "peer-aaa111");
  await getPeerOverview(fakeDb, "peer-aaa111");
  assert.equal(calls, 1);
});

test("overview-cache: concurrent misses share in-flight promise (no duplicate fetch)", async () => {
  let calls = 0;
  let release;
  const gate = new Promise(r => { release = r; });
  _setFetchImpl(async () => {
    calls++;
    await gate;
    return okEnvelope();
  });
  const p1 = getPeerOverview(fakeDb, "peer-bbb222");
  const p2 = getPeerOverview(fakeDb, "peer-bbb222");
  const p3 = getPeerOverview(fakeDb, "peer-bbb222");
  release();
  const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
  assert.equal(calls, 1, "stampede should collapse to one fetch");
  assert.equal(r1.status, "ok");
  assert.equal(r1, r2);
  assert.equal(r2, r3);
});

test("overview-cache: invalidatePeerCache forces next fetch", async () => {
  let calls = 0;
  _setFetchImpl(async () => { calls++; return okEnvelope(); });
  await getPeerOverview(fakeDb, "peer-ccc333");
  assert.equal(calls, 1);
  invalidatePeerCache("peer-ccc333");
  await getPeerOverview(fakeDb, "peer-ccc333");
  assert.equal(calls, 2);
});

test("overview-cache: fetch error → unavailable sentinel is cached", async () => {
  let calls = 0;
  _setFetchImpl(async () => {
    calls++;
    return { ok: false, status: 0, error: "timeout" };
  });
  const r1 = await getPeerOverview(fakeDb, "peer-ddd444");
  assert.equal(r1.status, "unavailable");
  assert.equal(r1.reason, "timeout");
  const r2 = await getPeerOverview(fakeDb, "peer-ddd444");
  assert.equal(r2.status, "unavailable");
  assert.equal(calls, 1, "sentinel should be cached");
});

test("overview-cache: response_too_large body → unavailable sentinel", async () => {
  // forwardSignedRequest would already have rejected at fetch time, but the
  // cache layer double-checks for defense-in-depth. Simulate by passing a
  // raw string larger than MAX_RESPONSE_BYTES (64 KB).
  const bigRaw = "x".repeat(64 * 1024 + 1);
  _setFetchImpl(async () => ({ ok: true, status: 200, body: null, raw: bigRaw }));
  const r = await getPeerOverview(fakeDb, "peer-eee555");
  assert.equal(r.status, "unavailable");
  assert.equal(r.reason, "response_too_large");
});

test("overview-cache: prefetchPeerOverviews fetches in parallel", async () => {
  let calls = 0;
  _setFetchImpl(async () => { calls++; return okEnvelope(); });
  const results = await prefetchPeerOverviews(fakeDb, ["peer-1", "peer-2", "peer-3"]);
  assert.equal(results.length, 3);
  assert.equal(calls, 3);
  for (const r of results) assert.equal(r.status, "ok");
});
