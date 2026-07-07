/**
 * resolveWarmableProviderName — Plan B Part 1 model-warming (gpu-orchestrator).
 *
 * pi-bots resolves a bot's model to a bundle-LESS raw-endpoint alias (e.g.
 * "crow-local" :8003, bundleId null), but the warmable bundle is a sibling
 * provider sharing that baseUrl ("crow-chat"). This pure mapper picks the right
 * provider to warm so a background job doesn't hit a cold :8003 → "(no reply)".
 */
import { test } from "node:test";
import assert from "node:assert";
import { resolveWarmableProviderName } from "../servers/gateway/gpu-orchestrator.js";

const cfg = {
  providers: {
    "crow-local": { baseUrl: "http://x:8003/v1", host: "local", bundleId: null },
    "crow-chat": { baseUrl: "http://x:8003/v1", host: "local", bundleId: "llamacpp-qwen36-35b" },
    "crow-voice": { baseUrl: "http://x:8011/v1", host: "local", bundleId: "vllm-qwen35-4b" },
    "alibaba": { baseUrl: "https://cloud/v1", host: "cloud", bundleId: null },
  },
};

// F-INSTALL-10: resolveWarmableProviderName now takes this machine's own
// addresses (physical locality gate) as a third param. Declare the fixture's
// synthetic host "x" as one of our own addresses so the original
// alias→sibling / cloud-skip semantics stay under test unchanged.
const OWN = new Set(["localhost", "127.0.0.1", "::1", "x"]);

test("bundle-less local alias resolves to its bundled same-baseUrl sibling", () => {
  assert.strictEqual(resolveWarmableProviderName(cfg, "crow-local", OWN), "crow-chat");
});

test("a provider that already has a bundle resolves to itself", () => {
  assert.strictEqual(resolveWarmableProviderName(cfg, "crow-voice", OWN), "crow-voice");
  assert.strictEqual(resolveWarmableProviderName(cfg, "crow-chat", OWN), "crow-chat");
});

test("cloud alias / unknown / no-sibling resolve to null (no warm)", () => {
  assert.strictEqual(resolveWarmableProviderName(cfg, "alibaba", OWN), null);
  assert.strictEqual(resolveWarmableProviderName(cfg, "ghost", OWN), null);
  assert.strictEqual(resolveWarmableProviderName({ providers: {} }, "crow-local", OWN), null);
  // bundle-less local alias with no bundled sibling on its baseUrl → null
  const lonely = { providers: { x: { baseUrl: "http://y:9/v1", host: "local", bundleId: null } } };
  assert.strictEqual(resolveWarmableProviderName(lonely, "x", OWN), null);
});
