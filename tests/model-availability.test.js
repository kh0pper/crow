// The bot drawer's model picker used to list every model any provider row
// declared, with no way to tell a model that is serving from one whose endpoint
// nothing is listening on. On the R4 instance that meant `deepseek-v4-flash`
// (127.0.0.1:8020, up only inside a dsv4-window) sat in the dropdown looking
// exactly like a working choice, and picking it failed every turn on connection
// refused.
//
// Three states, because "reachable" alone would be a lie about on-demand
// providers: the gateway really will start those when a turn asks for them.

import { test } from "node:test";
import assert from "node:assert/strict";

import { annotateAvailability } from "../servers/gateway/model-availability.js";

const MODELS = [
  { id: "qwen3.6-35b-a3b", provider: "crow-local", baseUrl: "http://h:8003/v1" },
  { id: "qwen3.5-122b-a10b", provider: "crow-local-122b", baseUrl: "http://h:8004/v1" },
  { id: "deepseek-v4-flash", provider: "crow-dsv4", baseUrl: "http://127.0.0.1:8020/v1" },
  { id: "glm-5.1", provider: "zai-coding", baseUrl: "https://api.z.ai/v4" },
];

/** `answering` lists the baseUrls something is listening on; everything else
 *  refuses the connection. `warmable` maps provider name → warm target. */
function deps({ answering = [], warmable = {} } = {}) {
  const live = new Set(answering);
  return {
    fetchStatus: async (url) => {
      if (!live.has(url)) throw new Error("ECONNREFUSED");
      return 200;
    },
    resolveWarmable: (name) => warmable[name] ?? null,
  };
}

test("a provider answering right now is up", async () => {
  const out = await annotateAvailability(MODELS, deps({ answering: ["http://h:8003/v1"] }));
  assert.equal(out.find((m) => m.provider === "crow-local").availability, "up");
});

test("a silent provider this gateway can start is on_demand, not unavailable", async () => {
  // crow-local-122b has no bundle of its own; the orchestrator resolves it to a
  // sibling that does. Marking it unavailable would talk an operator out of a
  // choice that works.
  const out = await annotateAvailability(
    MODELS,
    deps({ warmable: { "crow-local-122b": "crow-local-122b" } })
  );
  assert.equal(out.find((m) => m.provider === "crow-local-122b").availability, "on_demand");
});

test("a silent provider nothing here can start is unavailable", async () => {
  const out = await annotateAvailability(MODELS, deps({ answering: ["http://h:8003/v1"] }));
  assert.equal(out.find((m) => m.provider === "crow-dsv4").availability, "unavailable");
});

test("up wins over warmable — a running provider is never labelled on_demand", async () => {
  const out = await annotateAvailability(
    MODELS,
    deps({ answering: ["http://h:8003/v1"], warmable: { "crow-local": "crow-chat" } })
  );
  assert.equal(out.find((m) => m.provider === "crow-local").availability, "up");
});

test("one probe however many models share an endpoint", async () => {
  const calls = [];
  const many = [
    { id: "a", provider: "crow-local", baseUrl: "http://h:8003/v1" },
    { id: "b", provider: "crow-local", baseUrl: "http://h:8003/v1" },
    { id: "c", provider: "crow-local", baseUrl: "http://h:8003/v1" },
  ];
  await annotateAvailability(many, {
    fetchStatus: async (url) => { calls.push(url); return 200; },
    resolveWarmable: () => null,
  });
  assert.deepEqual(calls, ["http://h:8003/v1"]);
});

test("a probe that throws leaves the model listed, never the whole call failing", async () => {
  const out = await annotateAvailability(MODELS, {
    fetchStatus: async () => { throw new Error("network gone"); },
    resolveWarmable: () => null,
  });
  assert.equal(out.length, MODELS.length);
  assert.ok(out.every((m) => m.availability === "unavailable"));
});

test("annotation is additive — every original field survives", async () => {
  const out = await annotateAvailability(
    [{ id: "x", provider: "p", name: "X", baseUrl: "http://h/v1", extra: 1 }],
    deps({ answering: ["http://h/v1"] })
  );
  assert.deepEqual(out[0], {
    id: "x", provider: "p", name: "X", baseUrl: "http://h/v1", extra: 1,
    availability: "up",
  });
});

test("an empty or missing model list is not an error", async () => {
  assert.deepEqual(await annotateAvailability([], deps()), []);
  assert.deepEqual(await annotateAvailability(null, deps()), []);
});

// ---------------------------------------------------------------------------
// Probing the endpoint, not the orchestrator's residency view
// ---------------------------------------------------------------------------
//
// The first version delegated to gpu-orchestrator's isProviderReady(). Live on
// the R4 instance that marked 14 of 16 models "not running", including seven
// Z.AI cloud models that work perfectly. Two separate causes:
//
//   1. isProviderReady requires a 2xx. An authenticated cloud API answers 401
//      to an unauthenticated probe — which proves it is UP, not down.
//   2. It resolves the provider through the orchestrator's own provider config.
//      crow-local-122b answers 200 on :8004 and was still reported unavailable,
//      because that lookup did not carry the row.
//
// Both go away by probing the baseUrl pi already puts on every model entry, and
// by asking "did anything answer" rather than "did it answer 2xx". Residency and
// availability are different questions; only the second one is being asked here.

test("an endpoint that answers 401 is up — an authenticated API is not a down one", async () => {
  const out = await annotateAvailability(
    [{ id: "glm-5.1", provider: "zai-coding", baseUrl: "https://api.z.ai/v4" }],
    { fetchStatus: async () => 401, resolveWarmable: () => null }
  );
  assert.equal(out[0].availability, "up");
});

test("any HTTP answer counts as up — 200, 401, 403, 404, 500", async () => {
  for (const status of [200, 401, 403, 404, 500]) {
    const out = await annotateAvailability(
      [{ id: "m", provider: "p", baseUrl: "http://h/v1" }],
      { fetchStatus: async () => status, resolveWarmable: () => null }
    );
    assert.equal(out[0].availability, "up", `status ${status} means something is listening`);
  }
});

test("nothing listening is not up — a refused connection is the real negative", async () => {
  const out = await annotateAvailability(
    [{ id: "deepseek-v4-flash", provider: "crow-dsv4", baseUrl: "http://127.0.0.1:8020/v1" }],
    { fetchStatus: async () => { throw new Error("ECONNREFUSED"); }, resolveWarmable: () => null }
  );
  assert.equal(out[0].availability, "unavailable");
});

test("the probe uses the baseUrl on the model entry, not a provider-config lookup", async () => {
  const seen = [];
  await annotateAvailability(
    [{ id: "a", provider: "crow-local-122b", baseUrl: "http://100.118.41.122:8004/v1" }],
    { fetchStatus: async (url) => { seen.push(url); return 200; }, resolveWarmable: () => null }
  );
  assert.equal(seen.length, 1);
  assert.ok(seen[0].startsWith("http://100.118.41.122:8004/v1"),
    "the entry's own baseUrl, so a row missing from the orchestrator config still probes");
});

test("a model with no baseUrl falls back to warmability rather than claiming up", async () => {
  const out = await annotateAvailability(
    [{ id: "a", provider: "p" }, { id: "b", provider: "q" }],
    { fetchStatus: async () => { throw new Error("should not be called"); },
      resolveWarmable: (n) => (n === "p" ? "p" : null) }
  );
  assert.equal(out[0].availability, "on_demand");
  assert.equal(out[1].availability, "unavailable");
});

test("one probe per distinct baseUrl, not per provider — several rows share :8003", async () => {
  const seen = [];
  await annotateAvailability(
    [
      { id: "a", provider: "crow-local", baseUrl: "http://h:8003/v1" },
      { id: "b", provider: "crow-chat", baseUrl: "http://h:8003/v1" },
      { id: "c", provider: "crow-swap-deep", baseUrl: "http://h:8003/v1" },
      { id: "d", provider: "other", baseUrl: "http://h:8004/v1" },
    ],
    { fetchStatus: async (u) => { seen.push(u); return 200; }, resolveWarmable: () => null }
  );
  assert.equal(seen.length, 2, "two distinct baseUrls, two probes");
});
