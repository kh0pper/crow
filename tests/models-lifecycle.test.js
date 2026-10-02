// tests/models-lifecycle.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createJobStore, buildModelsListing, JOB_STATES } from "../servers/gateway/models/lifecycle.js";

test("job store: create, update, activeFor, eviction of old finished jobs", () => {
  let t = 1000, n = 0;
  const s = createJobStore({ now: () => t, maxJobs: 2, idFn: () => `j${++n}` });
  const a = s.create("crow-chat");
  assert.equal(a.state, "queued");
  assert.equal(s.activeFor("crow-chat").id, "j1");
  t = 2000;
  s.update("j1", { state: "resident" });
  assert.equal(s.get("j1").updatedAt, 2000);
  assert.equal(s.activeFor("crow-chat"), null, "a resident job is finished");
  s.create("a"); s.create("b");
  assert.equal(s.get("j1"), null, "oldest finished job evicted past maxJobs");
  assert.throws(() => s.update("j2", { state: "nope" }), /unknown job state/);
  assert.deepEqual(JOB_STATES, ["queued", "evicting", "starting", "resident", "failed", "blocked_by_reservation"]);
});

const providers = {
  "crow-chat": { models: [{ id: "qwen3.6-35b-a3b" }], doorUrl: "http://d/llm/v1", baseUrl: "http://127.0.0.1:18102/v1", gpuPolicy: { runtime: "native", owner: "me", catalogId: "qwen3.6-35b-a3b", quant: "UD-Q5_K_XL", mutexGroup: "crow-strix-vram", port: 18102 } },
  "crow-local-27b-512k": { models: [{ id: "qwen3.8-27b-512k" }], doorUrl: "http://d/llm/v1", baseUrl: "http://127.0.0.1:18104/v1", gpuPolicy: { runtime: "native", owner: "me", catalogId: "qwen3.8-27b", quant: "UD-Q6_K_XL", mutexGroup: "crow-strix-vram", port: 18104 } },
  "crow-local-27b": { models: [{ id: "qwen3.8-27b" }], baseUrl: "http://100.64.9.1:8006/v1", gpuPolicy: { engine: { managed: "external", host: "crow", label: "gufo" } } },
  "r4-gemma": { models: [{ id: "gemma-4-e2b-it" }], baseUrl: "http://100.64.9.1:3008/llm/v1", gpuPolicy: { runtime: "native", owner: "r4", port: 18120 } },
  "qwen-cloud": { models: [{ id: "x" }], baseUrl: "https://example.com/v1" },
};

test("listing: resident/stopped/blocked, wouldEvict lists resident siblings, external and foreign rows, cloud omitted", () => {
  const rows = buildModelsListing({
    providers,
    ownInstanceId: "me",
    snapshotOf: (name) => (name === "crow-chat" ? { live: true, argv: ["--model", "/m.gguf"] } : null),
    jobs: { activeFor: () => null },
    reservation: { owner: "win", expires_at: "2026-10-05T12:00:00Z", allow: ["crow-chat"] },
    externalHealth: { "crow-local-27b": { ready: true } },
    siblingsOf: (name) => (name === "crow-local-27b-512k" ? ["crow-chat"] : name === "crow-chat" ? ["crow-local-27b-512k"] : []),
  });
  const by = Object.fromEntries(rows.map((r) => [r.provider, r]));
  assert.equal(by["crow-chat"].status, "resident");
  assert.deepEqual(by["crow-chat"].argv, ["--model", "/m.gguf"]);
  assert.equal(by["crow-local-27b-512k"].status, "blocked_by_reservation", "not on the allow list while reserved");
  assert.deepEqual(by["crow-local-27b-512k"].wouldEvict, ["crow-chat"], "only RESIDENT siblings");
  assert.equal(by["crow-local-27b"].status, "external_up");
  assert.equal(by["crow-local-27b"].managed, "external");
  assert.equal(by["r4-gemma"].status, "foreign");
  assert.equal(by["r4-gemma"].owner, "r4");
  assert.equal(by["qwen-cloud"], undefined);
});

test("listing: an active job reports loading", () => {
  const rows = buildModelsListing({
    providers: { "crow-chat": providers["crow-chat"] }, ownInstanceId: "me", snapshotOf: () => null,
    jobs: { activeFor: () => ({ id: "j1", state: "starting" }) }, reservation: null, externalHealth: {}, siblingsOf: () => [],
  });
  assert.equal(rows[0].status, "loading");
});
