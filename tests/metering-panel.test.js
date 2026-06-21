import { test } from "node:test";
import assert from "node:assert/strict";

import { renderUsageBody } from "../servers/gateway/dashboard/panels/metering.js";

const summary = {
  totals: { events: 2, inputTokens: 3000, outputTokens: 500, cachedTokens: 0, costUsd: 2 },
  unpricedEvents: 0,
  byProvider: [
    { providerId: "together", providerType: null, modelId: "llama-8b", events: 2, inputTokens: 3000, outputTokens: 500, costUsd: 2 },
  ],
};

test("renderUsageBody shows spend total, event count, and per-provider rows", () => {
  const html = renderUsageBody(summary, [], "", "en");
  assert.match(html, /2\.0000|2\.00/); // total cost
  assert.match(html, /together/);
  assert.match(html, /llama-8b/);
  assert.match(html, /3,000|3000/); // input tokens
});

test("renderUsageBody warns when there are unpriced events (price-book gap)", () => {
  const withGap = { ...summary, unpricedEvents: 5, totals: { ...summary.totals } };
  const html = renderUsageBody(withGap, [], "", "en");
  assert.match(html, /unpriced|price rule|price book/i);
  assert.match(html, /5/);
});

test("renderUsageBody does NOT show the unpriced warning when coverage is complete", () => {
  const html = renderUsageBody(summary, [], "", "en");
  assert.doesNotMatch(html, /events? (have|with) no (matching )?price/i);
});

test("renderUsageBody lists configured price rules", () => {
  const rules = [
    { provider_id: null, provider_type: "together", model_id: "llama-3.1-8b", input_cost_per_1m: 0.18, output_cost_per_1m: 0.18 },
  ];
  const html = renderUsageBody(summary, rules, "", "en");
  assert.match(html, /llama-3\.1-8b/);
  assert.match(html, /0\.18/);
});

test("renderUsageBody renders the price-rule editor (update/delete/add/seed + csrf)", () => {
  const rules = [
    { id: 7, provider_id: "crow-chat", provider_type: null, model_id: "*", input_cost_per_1m: 0, output_cost_per_1m: 0 },
  ];
  const csrf = '<input type="hidden" name="_csrf" value="tok123">';
  const html = renderUsageBody(summary, rules, csrf, "en");
  assert.match(html, /name="action" value="update"/);
  assert.match(html, /name="id" value="7"/);
  assert.match(html, /name="action" value="delete"/);
  assert.match(html, /name="action" value="add"/);
  assert.match(html, /name="action" value="seed"/);
  assert.match(html, /name="_csrf" value="tok123"/);
});

test("renderUsageBody surfaces an error callout when one is passed", () => {
  const html = renderUsageBody(summary, [], "", "en", "Input rate must be a number >= 0.");
  assert.match(html, /Input rate must be a number/);
});
