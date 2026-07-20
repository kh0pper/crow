// tests/onboarding-ai-step.test.js
//
// C1/C3 Task 7 — the onboarding wizard's AI step rework: three visible
// choices (local-default with in-wizard model download, cloud paste-a-key,
// skip). Covers the SSR three-option layout, the cloud-provider POST
// handler (handleCloudProviderPost), and the served client script's hard
// contract (no literal backtick, drives /api/models/download, polls at
// 1500ms) — mirrors the same source-string pattern
// tests/models-panel-ui.test.js uses for model-catalog.js's client script.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

import onboardingPanel, { STEP_KEYS, handleCloudProviderPost } from "../servers/gateway/dashboard/panels/onboarding.js";
import { CLOUD_PRESETS } from "../servers/gateway/dashboard/panels/onboarding/cloud-presets.js";
import * as i18n from "../servers/gateway/dashboard/shared/i18n.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const AI_IDX = STEP_KEYS.indexOf("ai");

// Same seam as tests/onboarding-steps.test.js: drive the panel handler with a stub layout.
async function render(query = {}, { db } = {}) {
  let captured = "";
  const layout = ({ content }) => content;
  const res = { send(h) { captured = h; }, setHeader() {} };
  const req = { method: "GET", query, headers: {} };
  const out = await onboardingPanel.handler(req, res, { layout, lang: "en", db });
  return typeof out === "string" ? out : captured;
}

// Minimal db stub: answers the providers COUNT query, everything else empty.
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

function makeRes() {
  return {
    headers: {}, redirected: null, body: null, status_: null, contentType: null,
    setHeader(k, v) { this.headers[k] = v; },
    redirectAfterPost(url) { this.redirected = url; },
    status(code) { this.status_ = code; return this; },
    type(t) { this.contentType = t; return this; },
    send(b) { this.body = b; return this; },
  };
}
function makePostReq(body) {
  return { method: "POST", headers: {}, query: {}, body };
}

// ── three-option SSR layout ─────────────────────────────────────────────────

test("ai step renders three option radios (local/cloud/skip)", async () => {
  const html = await render({ step: String(AI_IDX) }, { db: providersDb(0) });
  assert.ok(html.includes('id="onb-ai-radio-local"'), "local radio present");
  assert.ok(html.includes('id="onb-ai-radio-cloud"'), "cloud radio present");
  assert.ok(html.includes('id="onb-ai-radio-skip"'), "skip radio present");
  assert.ok(html.includes(i18n.t("onboarding.ai.optionLocalTitle", "en")), "local option title rendered");
  assert.ok(html.includes(i18n.t("onboarding.ai.optionCloudTitle", "en")), "cloud option title rendered");
  assert.ok(html.includes(i18n.t("onboarding.ai.optionSkipTitle", "en")), "skip option title rendered");
});

test("ai step local option ships a download button (via the client script) + the script include", async () => {
  const html = await render({ step: String(AI_IDX) }, { db: providersDb(0) });
  assert.ok(html.includes("<script>") && html.includes("</script>"), "client script included on the ai step");
  assert.ok(html.includes("onb-ai-download-btn"), "download button id created by the client script");
  assert.ok(html.includes("/api/models/download"), "client script drives the download endpoint");
  assert.ok(html.includes('id="onb-ai-local-action"'), "local card has an action-area mount point for the button");
});

test("ai step cloud form posts to /dashboard/onboarding/cloud-provider with every preset rendered", async () => {
  const html = await render({ step: String(AI_IDX) }, { db: providersDb(0) });
  assert.ok(html.includes('action="/dashboard/onboarding/cloud-provider"'), "form posts to the cloud-provider endpoint");
  assert.ok(html.includes('method="POST"'), "form is a POST");
  assert.ok(html.includes('name="_csrf"'), "csrf input present");
  for (const preset of CLOUD_PRESETS) {
    assert.ok(html.includes(`value="${preset.id}"`), `preset option value for ${preset.id} rendered`);
    assert.ok(html.includes(preset.label), `preset label for ${preset.id} rendered`);
  }
});

test("ai step with ?cloud=ok shows the success callout", async () => {
  const html = await render({ step: String(AI_IDX), cloud: "ok" }, { db: providersDb(0) });
  assert.ok(html.includes(i18n.t("onboarding.ai.cloudAdded", "en")), "success callout rendered");
});

test("ai step without ?cloud=ok does not show the success callout", async () => {
  const html = await render({ step: String(AI_IDX) }, { db: providersDb(0) });
  assert.ok(!html.includes(i18n.t("onboarding.ai.cloudAdded", "en")), "no success callout without cloud=ok");
});

test("ai step keeps the existing providers-count note + deep link (unchanged behavior)", async () => {
  const html = await render({ step: String(AI_IDX) }, { db: providersDb(2) });
  assert.ok(html.includes(i18n.t("onboarding.aiConfiguredNote", "en").replace("{n}", "2")), "configured note still renders");
  assert.ok(html.includes("/dashboard/settings?section=llm&tab=providers")
    || html.includes("/dashboard/settings?section=llm&amp;tab=providers"), "advanced providers deep link still renders");
});

// ── POST handler (handleCloudProviderPost) ──────────────────────────────────

test("cloud-provider POST: valid preset+key calls upsertProvider with the preset's baseUrl, redirects with cloud=ok", async () => {
  const calls = [];
  let invalidated = false;
  const res = makeRes();
  await handleCloudProviderPost(makePostReq({ preset: "openai", apiKey: "sk-test-123", model: "" }), res, {
    db: {},
    upsertProviderFn: async (db, provider) => { calls.push(provider); return { id: provider.id }; },
    invalidateCacheFn: async () => { invalidated = true; },
  });
  assert.equal(calls.length, 1, "upsertProvider called once");
  const openaiPreset = CLOUD_PRESETS.find((p) => p.id === "openai");
  assert.equal(calls[0].id, "openai");
  assert.equal(calls[0].baseUrl, openaiPreset.baseUrl, "baseUrl matches the preset");
  assert.equal(calls[0].apiKey, "sk-test-123", "apiKey passed through");
  assert.equal(calls[0].host, "cloud");
  assert.equal(calls[0].bundleId, null);
  assert.equal(calls[0].disabled, false);
  assert.equal(calls[0].providerType, openaiPreset.providerType);
  assert.equal(calls[0].models[0].id, openaiPreset.defaultModel, "empty model field falls back to the preset default");
  assert.ok(invalidated, "invalidateProvidersCache called");
  assert.ok(res.redirected, "redirects (no raw send)");
  assert.ok(res.redirected.includes(`step=${AI_IDX}`) && res.redirected.includes("cloud=ok"), "redirects back to the ai step with cloud=ok");
});

test("cloud-provider POST: an editable custom model field overrides the preset default", async () => {
  const calls = [];
  const res = makeRes();
  await handleCloudProviderPost(makePostReq({ preset: "openai", apiKey: "sk-test", model: "gpt-4o" }), res, {
    db: {},
    upsertProviderFn: async (db, provider) => { calls.push(provider); },
    invalidateCacheFn: async () => {},
  });
  assert.equal(calls[0].models[0].id, "gpt-4o");
});

test("cloud-provider POST: unknown preset id → 400, never calls upsertProvider", async () => {
  let called = false;
  const res = makeRes();
  await handleCloudProviderPost(makePostReq({ preset: "not-a-real-preset", apiKey: "sk-test" }), res, {
    db: {},
    upsertProviderFn: async () => { called = true; },
    invalidateCacheFn: async () => {},
  });
  assert.equal(res.status_, 400);
  assert.equal(called, false, "upsertProvider never called for a bad preset");
  assert.equal(res.redirected, null);
});

test("cloud-provider POST: empty API key → 400, never calls upsertProvider", async () => {
  let called = false;
  const res = makeRes();
  await handleCloudProviderPost(makePostReq({ preset: "openai", apiKey: "   " }), res, {
    db: {},
    upsertProviderFn: async () => { called = true; },
    invalidateCacheFn: async () => {},
  });
  assert.equal(res.status_, 400);
  assert.equal(called, false, "upsertProvider never called for an empty key");
});

test("cloud-provider POST: never logs the raw api key, even on a failure path", async () => {
  const res = makeRes();
  const originalError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.map(String).join(" "));
  try {
    await handleCloudProviderPost(makePostReq({ preset: "openai", apiKey: "sk-super-secret-key" }), res, {
      db: {},
      upsertProviderFn: async () => { throw new Error("db exploded"); },
      invalidateCacheFn: async () => {},
    });
  } finally {
    console.error = originalError;
  }
  assert.equal(res.status_, 500);
  assert.ok(!logged.join(" ").includes("sk-super-secret-key"), "api key never logged");
});

// ── client-script contract (source-string assertions) ───────────────────────

test("ai-step-client.js: zero literal backtick characters inside the <script> block", () => {
  const src = readFileSync(join(repoRoot, "servers/gateway/dashboard/panels/onboarding/ai-step-client.js"), "utf8");
  // indexOf("<script>", ...) anchored after the exported function (the
  // module doc above it mentions "<script>" as prose, not markup — mirrors
  // tests/models-panel-ui.test.js's anchor past "function modelCatalogClientJS").
  const scriptStart = src.indexOf("<script>", src.indexOf("export function aiStepClientJS"));
  const scriptEnd = src.indexOf("</script>", scriptStart);
  assert.ok(scriptStart > -1 && scriptEnd > scriptStart, "could not locate the client <script> block");
  const body = src.slice(scriptStart + "<script>".length, scriptEnd);
  const backtickCount = (body.match(/`/g) || []).length;
  assert.equal(backtickCount, 0, "a literal backtick inside the client <script> block would break the whole page's template literal");
});

test("ai-step-client.js: drives POST /api/models/download and polls at 1500ms", () => {
  const src = readFileSync(join(repoRoot, "servers/gateway/dashboard/panels/onboarding/ai-step-client.js"), "utf8");
  assert.ok(src.includes("/api/models/download"), "posts to the download endpoint");
  assert.ok(src.includes("1500"), "polls at the 1500ms interval");
  assert.ok(src.includes("/api/models/downloads"), "reattach-on-return checks the downloads list");
  assert.ok(src.includes("/api/models/catalog"), "populates the card from the catalog endpoint");
});

test("ai-step-client.js: never calls POST /api/models/reprobe (catalog self-warms the probe)", () => {
  const src = readFileSync(join(repoRoot, "servers/gateway/dashboard/panels/onboarding/ai-step-client.js"), "utf8");
  const scriptStart = src.indexOf("<script>", src.indexOf("export function aiStepClientJS"));
  const scriptEnd = src.indexOf("</script>", scriptStart);
  const body = src.slice(scriptStart, scriptEnd);
  assert.ok(!body.includes("/reprobe"), "no separate reprobe call — the catalog fetch is the only probe trigger");
});
