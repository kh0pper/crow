// tests/gpu-orchestrator-stderr-cause.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { acquireProvider, _setOwnInstanceIdForTest, _setReservationReaderForTest } from "../servers/gateway/gpu-orchestrator.js";

_setOwnInstanceIdForTest("me");
_setReservationReaderForTest(() => null);

const catalog = { models: [{ id: "m-dead", task: "chat", context_len: 8192, serving: { class: "resident" } }] };
const state = { registry: { "m-dead@Q": { catalogId: "m-dead", quant: "Q", file: "m.gguf", path: "/w/m.gguf", sizeMb: 1 } }, reservations: {}, conversions: {}, runtimeOverrides: {} };
const cfg = { providers: { "m-dead": { baseUrl: "http://127.0.0.1:18177/v1", doorUrl: "http://d/llm/p/m-dead/v1", models: [{ id: "m-dead" }],
  gpuPolicy: { runtime: "native", owner: "me", catalogId: "m-dead", quant: "Q", port: 18177 } } } };

test("a native start that never becomes ready throws with the child's stderr tail, after stopping it", async () => {
  let stopped = false;
  const opts = {
    cfg, resolveDataDirFn: () => "/fake", loadStateFn: () => state, loadCatalogFn: () => catalog,
    getCachedProbeFn: () => ({ accel: "cpu" }), reprobeFn: async () => ({ accel: "cpu" }), existsSyncFn: () => true,
    ensureRuntimeFn: async () => "/opt/llama/llama-server", getRuntimeOverrideFn: () => null, getModelRuntimeOverrideFn: () => null,
    identityProbeFn: async () => "down", acquireHostLockFn: () => () => {},
    startModelFn: () => ({ live: true, argv: [], touch() {}, status: () => ({ stderrTail: ["llama_model_load: error loading model", "out of memory"] }), stop: async () => { stopped = true; } }),
    readinessTimeoutMs: 20, readinessPollMs: 1, readinessInitialDelayMs: 0,
  };
  await assert.rejects(acquireProvider("m-dead", opts), (e) => Array.isArray(e.stderrTail) && e.stderrTail.includes("out of memory"));
  assert.equal(stopped, true);
});
