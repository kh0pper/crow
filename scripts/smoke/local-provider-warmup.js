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

// All five crow-* providers share the Strix Halo unified 124 GB VRAM pool
// and collide under load (a 32B weight + KV cache leaves no room for another
// weight). One provider-level group ties them all together so acquiring any
// one evicts the others via bundleStop.
const agentic = getProvider("crow-swap-agentic");
expect("crow-swap-agentic has provider-level mutexGroup=crow-strix-vram",
  mutexGroupOf(agentic), "crow-strix-vram");

const agenticSiblings = getMutexSiblings("crow-swap-agentic").sort();
expect("crow-swap-agentic sees all 4 other crow-* providers as siblings",
  agenticSiblings,
  ["crow-chat", "crow-dispatch", "crow-swap-coder", "crow-swap-deep"]);

// grackle-rerank's mutexGroup is at provider-level; make sure the fallback
// didn't regress the original case.
const rerankSiblings = getMutexSiblings("grackle-rerank");
expect("grackle-rerank sees grackle-vision as sibling",
  rerankSiblings, ["grackle-vision"]);

// All 5 crow-* members show up in the group, with crow-chat as default
// (idle auto-revert restores it when a specialist times out).
const groups = getMutexGroups();
const vram = groups.get("crow-strix-vram");
expect("crow-strix-vram group has 5 members",
  vram?.members?.map((m) => m.name).sort(),
  ["crow-chat", "crow-dispatch", "crow-swap-agentic", "crow-swap-coder", "crow-swap-deep"]);
expect("crow-strix-vram group defaultMember=crow-chat",
  vram?.default, "crow-chat");

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
