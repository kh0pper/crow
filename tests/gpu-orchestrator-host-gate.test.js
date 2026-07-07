import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getOwnAddresses, isLocallyOrchestratable,
  alwaysResidentProviders, resolveWarmableProviderName,
  retryDeferredResidents, _setDeferredResidentsForTest,
} from "../servers/gateway/gpu-orchestrator.js";

// Real fleet shapes (models.json fallback on a fresh install):
const CFG = { providers: {
  "crow-voice":    { baseUrl: "http://100.118.41.122:8011/v1", host: "local", bundleId: "vllm-rocm-qwen35-4b", gpuPolicy: { alwaysResident: true } },
  "grackle-embed": { baseUrl: "http://100.121.254.89:9100/v1", host: "grackle-5fc01ac74463b6f4", bundleId: "vllm-cuda-embed", gpuPolicy: { alwaysResident: true } },
  "crow-llm":      { baseUrl: "http://localhost:3001/llm/v1", host: "local", bundleId: null },
  "cloud-alias":   { baseUrl: "https://api.together.xyz/v1", host: "cloud" },
  "loop-bundle":   { baseUrl: "http://127.0.0.1:8004/v1", bundleId: "llamacpp-cpu-qwen3-embed", gpuPolicy: { alwaysResident: true } },
} };
const CROW = new Set(["localhost", "127.0.0.1", "::1", "100.118.41.122"]);
const GRACKLE = new Set(["localhost", "127.0.0.1", "::1", "100.121.254.89"]);
const FRESH = new Set(["localhost", "127.0.0.1", "::1", "10.0.0.5"]);

test("isLocallyOrchestratable is physical: own-IP or loopback, never the host string", () => {
  assert.equal(isLocallyOrchestratable(CFG.providers["crow-voice"], CROW), true);
  assert.equal(isLocallyOrchestratable(CFG.providers["crow-voice"], GRACKLE), false);   // host:"local" LIES on grackle
  assert.equal(isLocallyOrchestratable(CFG.providers["grackle-embed"], GRACKLE), true); // host:"grackle-…" LIES on grackle (C1)
  assert.equal(isLocallyOrchestratable(CFG.providers["grackle-embed"], CROW), false);
  assert.equal(isLocallyOrchestratable(CFG.providers["loop-bundle"], FRESH), true);     // loopback is local everywhere
  assert.equal(isLocallyOrchestratable(CFG.providers["cloud-alias"], FRESH), false);
  assert.equal(isLocallyOrchestratable({ baseUrl: "not a url" }, FRESH), false);
  assert.equal(isLocallyOrchestratable({}, FRESH), false);
});

test("F-10 headline: a FRESH install ensures NO alwaysResident bundles from the shipped models.json", () => {
  // loop-bundle is synthetic; the real shipped set (crow-voice, grackle-embed) must be empty on fresh
  const shipped = { providers: { "crow-voice": CFG.providers["crow-voice"], "grackle-embed": CFG.providers["grackle-embed"] } };
  assert.deepEqual(alwaysResidentProviders(shipped, FRESH), []);
});

test("C1 closed: grackle keeps its own embed resident; crow keeps its own voice; neither ensures the other's", () => {
  // NOTE (deviation from brief, see report): loop-bundle's baseUrl is loopback
  // (127.0.0.1), which the brief's own physical-gate design treats as
  // "local everywhere" (see the isLocallyOrchestratable test above) — GRACKLE's
  // ownAddrs also always contains 127.0.0.1, so it necessarily matches there
  // too. The literal brief expected only ["grackle-embed"] here, which
  // contradicts the loopback-is-universal invariant it asserts elsewhere;
  // this expectation includes loop-bundle to stay consistent with that
  // invariant rather than silently special-casing loopback out of this one
  // assertion.
  assert.deepEqual(alwaysResidentProviders(CFG, GRACKLE).sort(), ["grackle-embed", "loop-bundle"]);
  const crowNames = alwaysResidentProviders(CFG, CROW).sort();
  assert.deepEqual(crowNames, ["crow-voice", "loop-bundle"]);
});

test("resolveWarmableProviderName refuses foreign bundles even though they HAVE a bundleId", () => {
  assert.equal(resolveWarmableProviderName(CFG, "grackle-embed", CROW), null);
  assert.equal(resolveWarmableProviderName(CFG, "crow-voice", CROW), "crow-voice");
  // bundle-less alias resolves only to a PHYSICALLY-local sibling
  assert.equal(resolveWarmableProviderName(CFG, "cloud-alias", CROW), null);
});

test("getOwnAddresses always contains loopback names", () => {
  const own = getOwnAddresses();
  assert.ok(own.has("localhost") && own.has("127.0.0.1"));
});

test("R2-C1 self-heal: a resident deferred at boot is ensured once its IP appears, exactly once", async () => {
  _setDeferredResidentsForTest(["crow-voice"]);
  const calls = [];
  const ensure = async (name) => { calls.push(name); return false; };
  // interface still down → stays parked, no ensure
  assert.deepEqual(await retryDeferredResidents({ cfg: CFG, ownAddrs: FRESH, ensure }), []);
  assert.deepEqual(calls, []);
  // tailscale0 up → ensured exactly once, then drained
  assert.deepEqual(await retryDeferredResidents({ cfg: CFG, ownAddrs: CROW, ensure }), ["crow-voice"]);
  assert.deepEqual(calls, ["crow-voice"]);
  assert.deepEqual(await retryDeferredResidents({ cfg: CFG, ownAddrs: CROW, ensure }), []);
  assert.deepEqual(calls, ["crow-voice"]);
});

test("R2-C1: a peer's resident parks forever without ensure calls or errors", async () => {
  _setDeferredResidentsForTest(["grackle-embed"]);
  const calls = [];
  const ensure = async (name) => { calls.push(name); return false; };
  assert.deepEqual(await retryDeferredResidents({ cfg: CFG, ownAddrs: CROW, ensure }), []);
  assert.deepEqual(calls, []);
  _setDeferredResidentsForTest([]); // isolation for later tests
});
