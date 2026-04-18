#!/usr/bin/env node
/**
 * Phase 1 smoke test: provider registry parses correctly and all providers
 * have the fields the orchestrator expects (baseUrl, models[].id).
 *
 * Usage: node scripts/smoke/providers-resolve.js
 * Exits 0 on pass, non-zero on fail.
 */

import { loadProviders } from "../../servers/orchestrator/providers.js";

const EXPECTED_PROVIDERS = [
  "crow-dispatch",
  "crow-chat",
  "crow-swap-coder",
  "crow-swap-deep",
  "grackle-embed",
  "grackle-rerank",
  "grackle-vision",
];

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

const cfg = loadProviders();
if (!cfg._source) fail("no models.json found in any search path");
console.log(`source: ${cfg._source}`);

if (!cfg.providers || typeof cfg.providers !== "object") {
  fail("providers map missing or not an object");
}

const providers = cfg.providers;
const names = Object.keys(providers);

for (const expected of EXPECTED_PROVIDERS) {
  if (!providers[expected]) fail(`missing expected provider: ${expected}`);
  const p = providers[expected];
  if (!p.baseUrl) fail(`${expected}: baseUrl missing`);
  if (!p.host) fail(`${expected}: host missing`);
  if (!Array.isArray(p.models) || p.models.length === 0) {
    fail(`${expected}: models[] missing or empty`);
  }
  for (const m of p.models) {
    if (!m.id) fail(`${expected}: model missing id`);
  }
}

// Verify mutex groups / conflicts are consistent. mutexGroup is declared at
// provider level (crow-strix-vram for all five Strix Halo-local bundles);
// the port-level :8003 subset collapsed into the broader VRAM-level mutex
// when crow-chat moved off vLLM's :8002 and onto the :8003 llama.cpp bundle.
const swapCoder = providers["crow-swap-coder"];
const swapDeep = providers["crow-swap-deep"];
if (swapCoder.mutexGroup !== swapDeep.mutexGroup) {
  fail("crow-swap-coder and crow-swap-deep must share a mutexGroup");
}
const swapDeepFirst = swapDeep.models[0];
if (!Array.isArray(swapDeepFirst.conflictsWith) || !swapDeepFirst.conflictsWith.includes("crow-chat")) {
  fail("crow-swap-deep must declare conflictsWith: [crow-chat] (mutex redundancy for GLM)");
}

// Verify Maker Lab priority pin
if (providers["crow-dispatch"].models[0].priority !== "maker_lab") {
  fail("crow-dispatch must have priority: maker_lab");
}

console.log(`PASS: ${names.length} providers loaded, all schema checks passed`);
process.exit(0);
