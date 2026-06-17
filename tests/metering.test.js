import { test } from "node:test";
import assert from "node:assert/strict";

import { computeCost, selectPriceRule } from "../servers/shared/metering.js";

// computeCost keeps full float precision (rounding happens at invoicing), so
// assert money math to sub-cent tolerance rather than exact float equality.
const approx = (actual, expected) =>
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `expected ~${expected}, got ${actual}`,
  );

test("computeCost bills input and output tokens at their per-1M rates", () => {
  const rule = { input_cost_per_1m: 0.18, output_cost_per_1m: 0.18 };
  // 2,000,000 input + 1,000,000 output at $0.18/1M each = 0.36 + 0.18 = 0.54
  const cost = computeCost({ inputTokens: 2_000_000, outputTokens: 1_000_000 }, rule);
  approx(cost, 0.54);
});

test("computeCost bills cached tokens (a subset of input) at the cache-read rate", () => {
  const rule = { input_cost_per_1m: 1.0, output_cost_per_1m: 2.0, cache_read_cost_per_1m: 0.1 };
  // 1,000,000 input of which 400,000 cached: 600k@1.0 + 400k@0.1 = 0.6 + 0.04 = 0.64; +500k out@2.0 = 1.0
  const cost = computeCost(
    { inputTokens: 1_000_000, outputTokens: 500_000, cachedTokens: 400_000 },
    rule,
  );
  approx(cost, 1.64);
});

test("selectPriceRule prefers an exact provider_id + model_id match", () => {
  const rules = [
    { provider_type: "together", model_id: "*", input_cost_per_1m: 9 },
    { provider_id: "cloud-together-main", model_id: "llama-3.1-8b", input_cost_per_1m: 0.18 },
    { provider_type: "together", model_id: "llama-3.1-8b", input_cost_per_1m: 5 },
  ];
  const rule = selectPriceRule(rules, {
    providerId: "cloud-together-main",
    providerType: "together",
    modelId: "llama-3.1-8b",
  });
  assert.equal(rule.input_cost_per_1m, 0.18);
});

test("selectPriceRule falls back to provider_type + model_id, then wildcard", () => {
  const rules = [
    { provider_type: "together", model_id: "*", input_cost_per_1m: 9 },
    { provider_type: "together", model_id: "llama-3.1-8b", input_cost_per_1m: 5 },
  ];
  const byType = selectPriceRule(rules, {
    providerId: "cloud-together-main",
    providerType: "together",
    modelId: "llama-3.1-8b",
  });
  assert.equal(byType.input_cost_per_1m, 5);

  const wildcard = selectPriceRule(rules, {
    providerId: "cloud-together-main",
    providerType: "together",
    modelId: "some-other-model",
  });
  assert.equal(wildcard.input_cost_per_1m, 9);
});

test("selectPriceRule returns null when nothing matches", () => {
  const rules = [{ provider_type: "openai", model_id: "gpt-4o", input_cost_per_1m: 2.5 }];
  const rule = selectPriceRule(rules, {
    providerId: "cloud-together-main",
    providerType: "together",
    modelId: "llama-3.1-8b",
  });
  assert.equal(rule, null);
});
