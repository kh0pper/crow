#!/usr/bin/env node
/**
 * Smoke: verify gpu-orchestrator wiring for chat-path warmup.
 *
 * Covers the non-docker paths only — does NOT attempt to `docker compose up`
 * any bundle. Validates:
 *   1. mutexGroup lookup reads both provider-level (host-level provider ids)
 *      AND models[0].mutexGroup (crow-swap-*) declarations.
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
const chat = getProvider("crow-chat");
expect("crow-chat has provider-level mutexGroup=crow-strix-vram",
  mutexGroupOf(chat), "crow-strix-vram");

const chatSiblings = getMutexSiblings("crow-chat").sort();
expect("crow-chat sees all 3 other crow-* providers as siblings",
  chatSiblings,
  ["crow-dispatch", "crow-swap-coder", "crow-swap-deep"]);

// The rerank/vision pair's mutexGroup is at provider-level; make sure the
// fallback didn't regress the original case. Only run when both smoke
// provider ids are configured (no shipped provider row declares this pair
// by default — see the vision capability pick in smart-router.js).
if (process.env.SMOKE_RERANK_PROVIDER && process.env.SMOKE_VISION_PROVIDER) {
  const rerankSiblings = getMutexSiblings(process.env.SMOKE_RERANK_PROVIDER);
  expect(`${process.env.SMOKE_RERANK_PROVIDER} sees ${process.env.SMOKE_VISION_PROVIDER} as sibling`,
    rerankSiblings, [process.env.SMOKE_VISION_PROVIDER]);
}

// All 4 crow-* members show up in the group, with crow-chat as default
// (idle auto-revert restores it when a specialist times out).
// crow-swap-agentic was retired Apr 2026 when crow-chat adopted the
// Qwen3.6-35B-A3B MoE bundle — the two would have been duplicate aliases.
const groups = getMutexGroups();
const vram = groups.get("crow-strix-vram");
expect("crow-strix-vram group has 4 members",
  vram?.members?.map((m) => m.name).sort(),
  ["crow-chat", "crow-dispatch", "crow-swap-coder", "crow-swap-deep"]);
expect("crow-strix-vram group defaultMember=crow-chat",
  vram?.default, "crow-chat");

// -------- 2. maybeAcquireLocalProvider safety --------

// Cloud providers and unknown IDs must never trigger docker.
expect("maybeAcquireLocalProvider(null) is no-op",
  await maybeAcquireLocalProvider(null), null);
expect("maybeAcquireLocalProvider('does-not-exist') is no-op",
  await maybeAcquireLocalProvider("does-not-exist"), null);
if (process.env.SMOKE_RERANK_PROVIDER && process.env.SMOKE_VISION_PROVIDER) {
  expect(`maybeAcquireLocalProvider('${process.env.SMOKE_VISION_PROVIDER}') is no-op (peer host)`,
    await maybeAcquireLocalProvider(process.env.SMOKE_VISION_PROVIDER), null);
}

if (failed) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nOK — all assertions passed");
