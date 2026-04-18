#!/usr/bin/env node
/**
 * Smoke: verify gpu-orchestrator wiring for chat-path warmup.
 *
 * Covers the non-docker paths only — does NOT attempt to `docker compose up`
 * any bundle. Validates:
 *   1. mutexGroup lookup reads both provider-level (grackle-*) AND
 *      models[0].mutexGroup (crow-swap-*) declarations.
 *   2. `maybeAcquireLocalProvider` is a safe no-op for cloud providers
 *      (null), unknown IDs (null), and peer-hosted bundles (null).
 *
 * Usage: node scripts/smoke/local-provider-warmup.js
 * Exits 0 on pass, non-zero on fail.
 */

import {
  _internals,
  maybeAcquireLocalProvider,
} from "../../servers/gateway/gpu-orchestrator.js";

const { getMutexSiblings, getMutexGroups, mutexGroupOf, getProvider } = _internals;

let failed = 0;
function expect(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}`);
  if (!ok) {
    console.log(`  expected: ${JSON.stringify(expected)}`);
    console.log(`  actual:   ${JSON.stringify(actual)}`);
    failed++;
  }
}

// -------- 1. mutexGroup lookup --------

// crow-swap-* declare mutexGroup on models[0]; the pre-fix code read it from
// the provider top-level and returned [] siblings, which would have caused a
// :8003 port collision the first time two swap members were acquired.
const agentic = getProvider("crow-swap-agentic");
expect("crow-swap-agentic has models[0].mutexGroup=8003-swap",
  mutexGroupOf(agentic), "8003-swap");

const swapSiblings = getMutexSiblings("crow-swap-agentic").sort();
expect("crow-swap-agentic sees coder+deep as siblings",
  swapSiblings, ["crow-swap-coder", "crow-swap-deep"]);

// grackle-rerank's mutexGroup is at provider-level; make sure the fallback
// didn't regress the original case.
const rerankSiblings = getMutexSiblings("grackle-rerank");
expect("grackle-rerank sees grackle-vision as sibling",
  rerankSiblings, ["grackle-vision"]);

// All three :8003 members show up in the group, with no declared default.
const groups = getMutexGroups();
const swap = groups.get("8003-swap");
expect("8003-swap group has 3 members",
  swap?.members?.map((m) => m.name).sort(),
  ["crow-swap-agentic", "crow-swap-coder", "crow-swap-deep"]);
expect("8003-swap group has no default member",
  swap?.default, null);

// -------- 2. maybeAcquireLocalProvider safety --------

// Cloud providers and unknown IDs must never trigger docker.
expect("maybeAcquireLocalProvider(null) is no-op",
  await maybeAcquireLocalProvider(null), null);
expect("maybeAcquireLocalProvider('does-not-exist') is no-op",
  await maybeAcquireLocalProvider("does-not-exist"), null);
expect("maybeAcquireLocalProvider('grackle-vision') is no-op (peer host)",
  await maybeAcquireLocalProvider("grackle-vision"), null);

if (failed) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nOK — all assertions passed");
