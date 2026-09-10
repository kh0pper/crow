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
  { id: "qwen3.6-35b-a3b", provider: "crow-local" },
  { id: "qwen3.5-122b-a10b", provider: "crow-local-122b" },
  { id: "deepseek-v4-flash", provider: "crow-dsv4" },
  { id: "glm-5.1", provider: "zai-coding" },
];

function deps({ ready = [], warmable = {} } = {}) {
  const readySet = new Set(ready);
  return {
    isProviderReady: async (name) => readySet.has(name),
    resolveWarmable: (name) => warmable[name] ?? null,
  };
}

test("a provider answering right now is up", async () => {
  const out = await annotateAvailability(MODELS, deps({ ready: ["crow-local"] }));
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
  const out = await annotateAvailability(MODELS, deps({ ready: ["crow-local"] }));
  assert.equal(out.find((m) => m.provider === "crow-dsv4").availability, "unavailable");
});

test("up wins over warmable — a running provider is never labelled on_demand", async () => {
  const out = await annotateAvailability(
    MODELS,
    deps({ ready: ["crow-local"], warmable: { "crow-local": "crow-chat" } })
  );
  assert.equal(out.find((m) => m.provider === "crow-local").availability, "up");
});

test("each provider is probed once however many models it carries", async () => {
  const calls = [];
  const many = [
    { id: "a", provider: "crow-local" },
    { id: "b", provider: "crow-local" },
    { id: "c", provider: "crow-local" },
  ];
  await annotateAvailability(many, {
    isProviderReady: async (name) => { calls.push(name); return true; },
    resolveWarmable: () => null,
  });
  assert.deepEqual(calls, ["crow-local"]);
});

test("a probe that throws leaves the model listed, never the whole call failing", async () => {
  const out = await annotateAvailability(MODELS, {
    isProviderReady: async () => { throw new Error("network gone"); },
    resolveWarmable: () => null,
  });
  assert.equal(out.length, MODELS.length);
  assert.ok(out.every((m) => m.availability === "unavailable"));
});

test("annotation is additive — every original field survives", async () => {
  const out = await annotateAvailability(
    [{ id: "x", provider: "p", name: "X", baseUrl: "http://h/v1", extra: 1 }],
    deps({ ready: ["p"] })
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
