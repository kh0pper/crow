import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getPeerCapabilities, _setFetchImpl, _resetCache, validateCapabilitiesEnvelope } from "../servers/gateway/dashboard/capabilities-cache.js";

beforeEach(() => _resetCache());
afterEach(() => _setFetchImpl(null)); // restore the real defaultFetchImpl between tests

test("validateCapabilitiesEnvelope accepts a well-formed payload", () => {
  const ok = validateCapabilitiesEnvelope({
    instance: { id: "abc", name: "Crow" },
    capabilities: {
      tools: [{ canonicalId: "crow-memory", category: "memory", name: "Memory", bundleId: null, toolCount: 5 }],
      skills: [{ name: "research" }],
      bots: [{ bot_id: "x", display_name: "X", enabled: true, project_id: null, tracker_type: "none", model: "m", tool_count: 0 }],
    },
    generatedAt: "2026-06-08T00:00:00Z",
  });
  assert.ok(ok);
  assert.equal(ok.capabilities.tools.length, 1);
});

test("validateCapabilitiesEnvelope rejects junk / missing capabilities", () => {
  assert.equal(validateCapabilitiesEnvelope(null), null);
  assert.equal(validateCapabilitiesEnvelope({ instance: { id: "x" } }), null);
  assert.equal(validateCapabilitiesEnvelope({ capabilities: "nope" }), null);
});

test("validateCapabilitiesEnvelope strips unexpected fields from items", () => {
  const ok = validateCapabilitiesEnvelope({
    instance: { id: "abc", name: null },
    capabilities: { tools: [{ canonicalId: "c", category: "x", name: "n", bundleId: null, toolCount: 1, evil: "DROP" }], skills: [], bots: [] },
    generatedAt: "t",
  });
  assert.ok(!JSON.stringify(ok).includes("DROP"));
});

test("getPeerCapabilities caches a successful fetch", async () => {
  let calls = 0;
  _setFetchImpl(async () => { calls++; return { data: { instance: { id: "p" }, capabilities: { tools: [], skills: [], bots: [] }, generatedAt: "t" }, ttlMs: 60_000 }; });
  const a = await getPeerCapabilities({}, "p", { source: "test" });
  const b = await getPeerCapabilities({}, "p", { source: "test" });
  assert.equal(calls, 1, "second call served from cache");
  assert.equal(a.status, "ok");
  assert.equal(b.status, "ok");
});

test("validateCapabilitiesEnvelope preserves the exposed boolean (producer↔validator parity)", () => {
  const ok = validateCapabilitiesEnvelope({
    instance: { id: "abc", name: "Crow" },
    capabilities: {
      tools: [
        { canonicalId: "crow-memory", category: "memory", name: "Memory", bundleId: null, toolCount: 5, exposed: true },
        { canonicalId: "crow-blog", category: "blog", name: "Blog", bundleId: null, toolCount: 3 }, // missing → false
      ],
      skills: [], bots: [],
    },
    generatedAt: "t",
  });
  assert.equal(ok.capabilities.tools[0].exposed, true);
  assert.equal(ok.capabilities.tools[1].exposed, false);
});
