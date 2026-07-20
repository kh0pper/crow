// tests/onboarding-steps.test.js
//
// Item 4 PR2 — wizard grows from 5 to 7 steps: "ai" (provider orientation,
// F-ONBOARD-2) and "starter" (starter collections, sub-scope 4d).
// STEP_KEYS is exported so tests derive positions instead of re-pinning indices.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as i18n from "../servers/gateway/dashboard/shared/i18n.js";
import onboardingPanel, { STEP_KEYS } from "../servers/gateway/dashboard/panels/onboarding.js";
import { loadCollections } from "../servers/gateway/dashboard/panels/extensions/collections.js";

// Same seam as tests/onboarding.test.js: drive the panel handler with a stub layout.
async function render(query = {}, { db } = {}) {
  let captured = "";
  const layout = ({ content }) => content;
  const res = { send(h) { captured = h; }, setHeader() {} };
  const req = { method: "GET", query, headers: {} };
  const out = await onboardingPanel.handler(req, res, { layout, lang: "en", db });
  return typeof out === "string" ? out : captured;
}

const stepOf = (stem) => String(STEP_KEYS.indexOf(stem));

// Minimal db stub: answers the providers COUNT query with `n`, everything else empty.
function providersDb(n) {
  return {
    async execute(q) {
      const sql = typeof q === "string" ? q : q.sql;
      if (/COUNT\(\*\)/i.test(sql) && /providers/i.test(sql)) {
        return { rows: [{ n }] };
      }
      return { rows: [] };
    },
  };
}

// ── STEP_KEYS shape ──────────────────────────────────────────────────────────

test("STEP_KEYS is exactly welcome,ai,integrations,bot,starter,connect,meet,done in order", () => {
  assert.deepEqual(STEP_KEYS, ["welcome", "ai", "integrations", "bot", "starter", "connect", "meet", "done"]);
});

// ── ai step ──────────────────────────────────────────────────────────────────

test("ai step renders the providers deep link (new tab, noopener)", async () => {
  const html = await render({ step: stepOf("ai") }, { db: providersDb(0) });
  assert.ok(html.includes("/dashboard/settings?section=llm&amp;tab=providers")
    || html.includes("/dashboard/settings?section=llm&tab=providers"),
  "ai step links to the providers tab");
  assert.ok(html.includes('target="_blank"'), "ai deep link opens a new tab");
  assert.ok(html.includes('rel="noopener"'), "ai deep link sets rel=noopener");
  assert.ok(html.includes(i18n.t("onboarding.ai.body", "en")), "ai step renders its body copy");
});

test("ai step with ZERO providers shows the honest empty-state note", async () => {
  const html = await render({ step: stepOf("ai") }, { db: providersDb(0) });
  assert.ok(html.includes(i18n.t("onboarding.aiEmptyNote", "en")), "empty-state note present");
  assert.ok(!html.includes(i18n.t("onboarding.aiConfiguredNote", "en").replace("{n}", "0")),
    "configured note absent when nothing is configured");
});

test("ai step with providers shows the configured note with the count", async () => {
  const html = await render({ step: stepOf("ai") }, { db: providersDb(3) });
  const expected = i18n.t("onboarding.aiConfiguredNote", "en").replace("{n}", "3");
  assert.ok(html.includes(expected), `configured note with count present: ${expected}`);
  assert.ok(!html.includes(i18n.t("onboarding.aiEmptyNote", "en")), "empty-state note absent");
});

test("ai step survives a db error: no 500, no count callout, deep link intact", async () => {
  const db = { async execute() { throw new Error("db is on fire"); } };
  const html = await render({ step: stepOf("ai") }, { db });
  assert.ok(html.includes("stepper"), "page still renders");
  assert.ok(html.includes("/dashboard/settings?section=llm&tab=providers")
    || html.includes("/dashboard/settings?section=llm&amp;tab=providers"), "deep link intact");
  assert.ok(!html.includes(i18n.t("onboarding.aiEmptyNote", "en")), "no empty claim on error");
  const configuredStem = i18n.t("onboarding.aiConfiguredNote", "en").split("{n}")[0].trim();
  assert.ok(!configuredStem || !html.includes(configuredStem), "no configured claim on error");
});

test("ai step without a db omits the count callout but still renders", async () => {
  const html = await render({ step: stepOf("ai") });
  assert.ok(html.includes("stepper"), "page renders without a db");
  assert.ok(!html.includes(i18n.t("onboarding.aiEmptyNote", "en")), "no empty claim without a db");
});

// ── starter step ─────────────────────────────────────────────────────────────

test("starter step renders one card per collection plus the collections deep link", async () => {
  const collections = loadCollections();
  assert.ok(collections.length > 0, "repo ships at least one starter collection");
  const html = await render({ step: stepOf("starter") });
  const cardCount = (html.match(/onboarding-action-card"/g) || []).length;
  assert.equal(cardCount, collections.length, "one card per collection");
  for (const c of collections) {
    assert.ok(html.includes(c.name), `card for ${c.id} shows its name`);
    assert.ok(html.includes(String(c.members.length)), `card for ${c.id} shows its member count`);
  }
  assert.ok(html.includes("/dashboard/extensions#collections"), "deep link to the collections section");
  assert.ok(html.includes(i18n.t("onboarding.openCollections", "en")), "deep link uses its i18n label");
  assert.ok(html.includes('target="_blank"'), "starter deep link opens a new tab");
});

test("starter step deep link appears exactly once (cards are not install buttons)", async () => {
  const html = await render({ step: stepOf("starter") });
  const anchors = (html.match(/<a\b[^>]*href="\/dashboard\/extensions#collections"[^>]*>/g) || []);
  assert.equal(anchors.length, 1, "exactly one anchor to extensions#collections");
});

// ── new i18n keys ────────────────────────────────────────────────────────────

test("new ai/starter onboarding keys resolve in en AND es", () => {
  const KEYS = [
    "onboarding.ai.title", "onboarding.ai.body",
    "onboarding.aiEmptyNote", "onboarding.aiConfiguredNote", "onboarding.openProviders",
    "onboarding.starter.title", "onboarding.starter.body",
    "onboarding.starterMemberCount", "onboarding.openCollections",
  ];
  for (const k of KEYS) {
    const entry = i18n.translations[k];
    assert.ok(entry, `missing translations entry for ${k}`);
    assert.ok(entry.en && entry.en.trim(), `missing/empty en value for ${k}`);
    assert.ok(entry.es && entry.es.trim(), `missing/empty es value for ${k}`);
  }
});

// Task 7: the AI step's three-choice rework — every new key it references.
test("new ai-step three-choice onboarding.ai.* keys resolve in en AND es", () => {
  const KEYS = [
    "onboarding.ai.optionLocalTitle", "onboarding.ai.optionLocalDesc",
    "onboarding.ai.optionCloudTitle", "onboarding.ai.optionCloudDesc",
    "onboarding.ai.optionSkipTitle", "onboarding.ai.optionSkipDesc",
    "onboarding.ai.localFits", "onboarding.ai.localUnknown", "onboarding.ai.localWontFit",
    "onboarding.ai.localAlreadyInstalled",
    "onboarding.ai.downloadStart", "onboarding.ai.downloadRetry", "onboarding.ai.downloadDone",
    "onboarding.ai.downloadEta", "onboarding.ai.upsell",
    "onboarding.ai.cloudProviderLabel", "onboarding.ai.cloudKeyLabel", "onboarding.ai.cloudModelLabel",
    "onboarding.ai.cloudSubmit", "onboarding.ai.cloudAdded", "onboarding.ai.cloudFreeTiersBlurb",
    "onboarding.ai.cloudDocsLinkLabel", "onboarding.ai.cloudBadPreset", "onboarding.ai.cloudKeyRequired",
    "onboarding.ai.cloudSaveFailed", "onboarding.ai.sizeGb",
  ];
  for (const k of KEYS) {
    const entry = i18n.translations[k];
    assert.ok(entry, `missing translations entry for ${k}`);
    assert.ok(entry.en && entry.en.trim(), `missing/empty en value for ${k}`);
    assert.ok(entry.es && entry.es.trim(), `missing/empty es value for ${k}`);
  }
});
