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
import { PROVIDER_PRESETS } from "../servers/shared/provider-presets.js";
import { candidatePick } from "../servers/shared/provider-recommendations.js";
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
  assert.ok(!html.includes('data-turbo="false"'), "cloud form stays Turbo-enabled (redirects to wizard itself)");
  assert.ok(html.includes('name="_csrf"'), "csrf input present");
  assert.equal(PROVIDER_PRESETS.length, 9, "nine presets");
  for (const preset of PROVIDER_PRESETS) {
    assert.ok(html.includes(`value="${preset.id}"`), `preset option value for ${preset.id} rendered`);
    assert.ok(html.includes(i18n.t(preset.labelKey, "en")), `preset label for ${preset.id} rendered`);
  }
});

test("ai step cloud panel embeds the one Add a provider sheet and an opener", async () => {
  const html = await render({ step: String(AI_IDX) }, { db: providersDb(0) });
  assert.ok(html.includes('id="models-add"'), "the sheet is embedded");
  assert.ok(html.includes("data-models-add"), "an opener button is present");
  assert.ok(html.includes("/api/providers/test"), "the sheet client posts to the provider routes");
  assert.ok(!html.includes("cloud-presets"), "no stale preset module referenced");
});

test("ai step with ?cloud=ok shows the success callout", async () => {
  const html = await render({ step: String(AI_IDX), cloud: "ok" }, { db: providersDb(0) });
  assert.ok(html.includes(i18n.t("onboarding.ai.cloudAdded", "en")), "success callout rendered");
});

test("ai step without ?cloud=ok does not show the success callout", async () => {
  const html = await render({ step: String(AI_IDX) }, { db: providersDb(0) });
  assert.ok(!html.includes(i18n.t("onboarding.ai.cloudAdded", "en")), "no success callout without cloud=ok");
});

// ── option-card radio width (CDP round finding #2) ──────────────────────────
//
// The dashboard's global CSS reset (layout.js:1101, `input, textarea, select
// { width: 100%; ... }`) is unscoped by `type`, so without a scoped override
// the radio inputs in .onb-ai-option inflate to the full row width and crush
// the title+desc column to a ~70-100px sliver (live-measured 1525px on a
// 1920px viewport in the CDP round). Pin the scoped override that fixes it
// without touching the global reset (contained blast radius — see the CSS
// comment in onboarding.js for why the global rule itself is untouched here).
test("ai step's option-card radios carry a scoped width:auto override (CDP round finding #2)", async () => {
  const html = await render({ step: String(AI_IDX) }, { db: providersDb(0) });
  const selectorIdx = html.indexOf('.onb-ai-option input[type="radio"]');
  assert.ok(selectorIdx > -1, "could not locate the .onb-ai-option input[type=radio] selector in the rendered ai step");
  // The declaration block includes a source-comment aside that itself quotes
  // a CSS rule (braces and all), so a naive "up to the first }" match would
  // truncate inside that comment — anchor on the actual closing brace via
  // the always-present flex-shrink declaration that ends the real block.
  const closeIdx = html.indexOf("flex-shrink: 0;", selectorIdx);
  assert.ok(closeIdx > -1, "could not find the end of the radio declaration block");
  const ruleBody = html.slice(selectorIdx, closeIdx);
  assert.match(ruleBody, /width:\s*auto/, "radio width is explicitly reset to auto, overriding the global input{width:100%} reset");
  assert.match(ruleBody, /flex:\s*0 0 auto/, "radio does not stretch to fill the flex row");
});

test("ai step keeps the existing providers-count note + deep link (unchanged behavior)", async () => {
  const html = await render({ step: String(AI_IDX) }, { db: providersDb(2) });
  assert.ok(html.includes(i18n.t("onboarding.aiConfiguredNote", "en").replace("{n}", "2")), "configured note still renders");
  assert.ok(html.includes("/dashboard/settings?section=models\""), "Models page deep link renders");
});

test("Task 7 review fix round 1: new i18n keys resolve in en AND es", () => {
  const KEYS = [
    "onboarding.ai.cloudErrModelRequired",
    "onboarding.ai.cloudThatAddress",
    "onboarding.ai.upsellLink",
    "onboarding.ai.cloudErrBadPreset",
    "onboarding.ai.cloudErrMissingKey",
    "onboarding.ai.cloudErrSaveFailed",
  ];
  for (const k of KEYS) {
    const entry = i18n.translations[k];
    assert.ok(entry, `missing translations entry for ${k}`);
    assert.ok(entry.en && entry.en.trim(), `missing/empty en value for ${k}`);
    assert.ok(entry.es && entry.es.trim(), `missing/empty es value for ${k}`);
  }
});

// ── POST handler (handleCloudProviderPost) ──────────────────────────────────

const okTest = async () => ({ ok: true, code: "ok", models: ["m1"], host: "api.openai.com", baseUrl: "https://api.openai.com/v1" });
const noRows = async () => [];

test("cloud-provider POST: ok test writes one row at the preset's base URL, redirects cloud=ok", async () => {
  const calls = [];
  let invalidated = false;
  const res = makeRes();
  await handleCloudProviderPost(makePostReq({ preset: "openai", apiKey: "fixture-key-123", model: "typed-model" }), res, {
    db: {}, testFn: okTest, listRowsFn: noRows,
    upsertProviderFn: async (db, provider) => { calls.push(provider); return { id: provider.id }; },
    invalidateCacheFn: async () => { invalidated = true; },
  });
  assert.equal(calls.length, 1, "upsertProvider called once");
  assert.equal(calls[0].id, "openai");
  assert.equal(calls[0].baseUrl, "https://api.openai.com/v1");
  assert.equal(calls[0].apiKey, "fixture-key-123");
  assert.equal(calls[0].host, "cloud");
  assert.equal(calls[0].disabled, false);
  assert.equal(calls[0].models[0].id, "typed-model");
  assert.ok(invalidated, "providers cache invalidated");
  assert.ok(res.redirected.includes(`step=${AI_IDX}`) && res.redirected.includes("cloud=ok"));
  assert.ok(!res.redirected.includes("fixture-key-123"), "key never in the redirect");
});

test("cloud-provider POST: an empty model field uses the preset's first verified everyday pick", async () => {
  const pick = candidatePick("openai", "everyday");
  assert.ok(pick, "the fixture preset has a verified everyday pick");
  const calls = [];
  const res = makeRes();
  await handleCloudProviderPost(makePostReq({ preset: "openai", apiKey: "fixture-key-123", model: "" }), res, {
    db: {}, testFn: okTest, listRowsFn: noRows,
    upsertProviderFn: async (db, provider) => { calls.push(provider); },
    invalidateCacheFn: async () => {},
  });
  assert.equal(calls[0].models[0].id, pick.model_id);
});

test("cloud-provider POST: no typed model and no verified pick -> model_required, nothing tested or written", async () => {
  let tested = false, wrote = false;
  const res = makeRes();
  await handleCloudProviderPost(makePostReq({ preset: "other", baseUrl: "https://api.example.com/v1", apiKey: "fixture-key-123", model: "" }), res, {
    db: {}, testFn: async () => { tested = true; return { ok: true, code: "ok" }; }, listRowsFn: noRows,
    upsertProviderFn: async () => { wrote = true; }, invalidateCacheFn: async () => {},
  });
  assert.equal(tested, false);
  assert.equal(wrote, false);
  assert.ok(res.redirected.includes("cloud_error=model_required"));
});

test("cloud-provider POST: a preview-only everyday pick is not used; model_required", async () => {
  let wrote = false;
  const res = makeRes();
  await handleCloudProviderPost(makePostReq({ preset: "openai", apiKey: "fixture-key-123", model: "" }), res, {
    db: {}, testFn: okTest, listRowsFn: noRows,
    pickFn: () => ({ model_id: "preview-model", status: "preview", preview: true }),
    upsertProviderFn: async () => { wrote = true; }, invalidateCacheFn: async () => {},
  });
  assert.equal(wrote, false);
  assert.ok(res.redirected.includes("cloud_error=model_required"));
});

test("cloud-provider POST: Other with an empty key and a typed model writes a keyless row", async () => {
  const calls = [];
  const res = makeRes();
  await handleCloudProviderPost(makePostReq({ preset: "other", baseUrl: "https://api.example.com/v1", apiKey: "", model: "local-model" }), res, {
    db: {}, listRowsFn: noRows,
    testFn: async (args) => ({ ok: true, code: "ok", models: null, host: "api.example.com", baseUrl: args.baseUrl }),
    upsertProviderFn: async (db, provider) => { calls.push(provider); }, invalidateCacheFn: async () => {},
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].baseUrl, "https://api.example.com/v1");
  assert.ok(!calls[0].apiKey, "no key stored");
  assert.equal(calls[0].models[0].id, "local-model");
  assert.ok(res.redirected.includes("cloud=ok"));
});

test("cloud-provider POST: key_rejected redirects cloud_error=key_rejected and never writes", async () => {
  let wrote = false;
  const res = makeRes();
  await handleCloudProviderPost(makePostReq({ preset: "openai", apiKey: "fixture-key-123", model: "m" }), res, {
    db: {}, testFn: async () => ({ ok: false, code: "key_rejected", status: 401, models: null, host: "api.openai.com" }), listRowsFn: noRows,
    upsertProviderFn: async () => { wrote = true; }, invalidateCacheFn: async () => {},
  });
  assert.equal(wrote, false);
  assert.ok(res.redirected.includes("cloud_error=key_rejected"));
  assert.ok(!res.redirected.includes("fixture-key-123"));
});

test("cloud-provider POST: an existing differently-keyed openai row makes the write openai-2", async () => {
  const calls = [];
  const res = makeRes();
  await handleCloudProviderPost(makePostReq({ preset: "openai", apiKey: "fixture-key-123", model: "m" }), res, {
    db: {}, testFn: okTest,
    listRowsFn: async () => [{ id: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "other-key-999", models: [] }],
    upsertProviderFn: async (db, provider) => { calls.push(provider); },
    invalidateCacheFn: async () => {},
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, "openai-2");
  assert.ok(res.redirected.includes("cloud=ok"));
});

test("cloud-provider POST: the Z.AI plan variant picks its base URL", async () => {
  const calls = [];
  const res = makeRes();
  await handleCloudProviderPost(makePostReq({ preset: "zai", variant: "coding", apiKey: "fixture-key-123", model: "m" }), res, {
    db: {}, listRowsFn: noRows,
    testFn: async (args) => ({ ok: true, code: "ok", models: null, host: "api.z.ai", baseUrl: args.variantId === "coding" ? "https://api.z.ai/api/coding/paas/v4" : "wrong" }),
    upsertProviderFn: async (db, provider) => { calls.push(provider); }, invalidateCacheFn: async () => {},
  });
  assert.equal(calls[0].baseUrl, "https://api.z.ai/api/coding/paas/v4");
});

test("cloud-provider POST: a Model Studio region picks its base URL; another preset's variant falls back to the default region", async () => {
  for (const [variant, want] of [["hk", "hk"], ["payg", undefined], ["", undefined]]) {
    const seen = [];
    const res = makeRes();
    await handleCloudProviderPost(makePostReq({ preset: "modelstudio", variant, apiKey: "fixture-key-123", model: "qwen3.8-flash" }), res, {
      db: {}, listRowsFn: noRows,
      testFn: async (args) => { seen.push(args.variantId); return { ok: true, code: "ok", models: null, host: "dashscope-intl.aliyuncs.com", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1" }; },
      upsertProviderFn: async () => {}, invalidateCacheFn: async () => {},
    });
    assert.equal(seen[0], want, JSON.stringify(variant));
    assert.ok(res.redirected.includes("cloud=ok"), variant);
  }
});

test("the no-script form lists each preset's variants under its own name, with the Model Studio regions", async () => {
  const page = await render({ step: String(AI_IDX) }, { db: providersDb(0) });
  const html = page.slice(page.indexOf("<noscript>"), page.indexOf("</noscript>"));
  assert.ok(html.length > 0, "the no-script form");
  assert.ok(html.includes('<optgroup label="Z.AI">'), "Z.AI group");
  assert.ok(html.includes('<optgroup label="Alibaba Model Studio (Qwen)">'), "Model Studio group");
  for (const v of ["payg", "coding", "intl", "us", "cn", "hk"]) assert.ok(html.includes(`<option value="${v}">`), v);
});

test("cloud-provider POST: unknown preset id -> cloud_error=bad_preset, never tests or writes", async () => {
  let called = false;
  const res = makeRes();
  await handleCloudProviderPost(makePostReq({ preset: "not-a-real-preset", apiKey: "fixture-key-123" }), res, {
    db: {}, testFn: async () => { called = true; return { ok: true }; }, listRowsFn: noRows,
    upsertProviderFn: async () => { called = true; }, invalidateCacheFn: async () => {},
  });
  assert.equal(res.status_, null);
  assert.equal(called, false);
  assert.ok(res.redirected.includes(`step=${AI_IDX}`));
  assert.ok(res.redirected.includes("cloud_error=bad_preset"));
});

test("cloud-provider POST: empty API key -> cloud_error=missing_key, never tests or writes", async () => {
  let called = false;
  const res = makeRes();
  await handleCloudProviderPost(makePostReq({ preset: "openai", apiKey: "   ", model: "m" }), res, {
    db: {}, testFn: async () => { called = true; return { ok: true }; }, listRowsFn: noRows,
    upsertProviderFn: async () => { called = true; }, invalidateCacheFn: async () => {},
  });
  assert.equal(called, false);
  assert.ok(res.redirected.includes("cloud_error=missing_key"));
});

test("cloud-provider POST: a write failure -> cloud_error=save_failed, the key is never logged", async () => {
  const res = makeRes();
  const originalError = console.error, originalWarn = console.warn;
  const logged = [];
  console.error = (...args) => logged.push(args.map(String).join(" "));
  console.warn = (...args) => logged.push(args.map(String).join(" "));
  try {
    await handleCloudProviderPost(makePostReq({ preset: "openai", apiKey: "fixture-super-secret", model: "m" }), res, {
      db: {}, testFn: okTest, listRowsFn: noRows,
      upsertProviderFn: async () => { throw new Error("db exploded"); },
      invalidateCacheFn: async () => {},
    });
  } finally {
    console.error = originalError; console.warn = originalWarn;
  }
  assert.ok(res.redirected.includes("cloud_error=save_failed"));
  assert.ok(!res.redirected.includes("fixture-super-secret"));
  assert.ok(!logged.join(" ").includes("fixture-super-secret"), "api key never logged");
});

test("cloud-provider POST: every Task 9 failure code redirects as itself (closed enum), key never echoed", async () => {
  for (const code of ["bad_key", "rate_limited", "unreachable", "not_found", "bad_url", "forbidden_target", "provider_error"]) {
    const res = makeRes();
    await handleCloudProviderPost(makePostReq({ preset: "openai", apiKey: "fixture-key-123", model: "m" }), res, {
      db: {}, testFn: async () => ({ ok: false, code, status: 500, models: null, host: "api.openai.com" }), listRowsFn: noRows,
      upsertProviderFn: async () => { throw new Error("must not write"); }, invalidateCacheFn: async () => {},
    });
    assert.ok(res.redirected.includes(`cloud_error=${code}`), code);
    assert.ok(!res.redirected.includes("fixture-key-123"));
  }
});

test("ai step: each failure code renders its own plain line with no raw placeholders", async () => {
  for (const code of ["key_rejected", "bad_key", "rate_limited", "unreachable", "not_found", "bad_url", "forbidden_target", "provider_error", "model_required"]) {
    const html = await render({ step: String(AI_IDX), cloud_error: code, cloud_preset: "openai", cloud_status: "500" }, { db: providersDb(0) });
    assert.ok(html.includes("callout-error") || html.includes("callout"), code);
    assert.ok(!/\{(provider|host|status)\}/.test(html.slice(html.indexOf('id="onb-ai-panel-cloud"'), html.indexOf('data-models-add'))), `${code}: no raw placeholder`);
  }
});

// ── error-callout rendering (SSR, gated by the closed cloud_error enum) ─────

test("ai step with ?cloud_error=bad_preset shows the bad-preset error callout and reveals the cloud panel", async () => {
  const html = await render({ step: String(AI_IDX), cloud_error: "bad_preset" }, { db: providersDb(0) });
  assert.ok(html.includes(i18n.t("onboarding.ai.cloudErrBadPreset", "en")), "bad-preset error callout rendered");
  assert.ok(!html.includes('id="onb-ai-panel-cloud" class="onb-ai-panel" hidden'), "cloud panel is revealed, not hidden");
});

test("ai step with ?cloud_error=missing_key shows the missing-key error callout", async () => {
  const html = await render({ step: String(AI_IDX), cloud_error: "missing_key" }, { db: providersDb(0) });
  assert.ok(html.includes(i18n.t("onboarding.ai.cloudErrMissingKey", "en")), "missing-key error callout rendered");
});

test("ai step with ?cloud_error=save_failed shows the save-failed error callout", async () => {
  const html = await render({ step: String(AI_IDX), cloud_error: "save_failed" }, { db: providersDb(0) });
  assert.ok(html.includes(i18n.t("onboarding.ai.cloudErrSaveFailed", "en")), "save-failed error callout rendered");
});

test("ai step with an unrecognized ?cloud_error value renders no error callout (closed enum)", async () => {
  const html = await render({ step: String(AI_IDX), cloud_error: "totally-made-up" }, { db: providersDb(0) });
  assert.ok(!html.includes("callout-error"), "no error callout for an unrecognized code");
});

test("ai step cloud form's API key input is required", async () => {
  const html = await render({ step: String(AI_IDX) }, { db: providersDb(0) });
  assert.ok(/id="onb-ai-cloud-key"[^>]*\brequired\b/.test(html), "key input carries the required attribute");
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
  // Call-site match, not a bare substring: "1500" alone would also pass for
  // "15000" (src.includes("1500") is vacuous — src.includes("15000") is also
  // true). Pin the actual setTimeout(..., 1500) argument position instead.
  assert.ok(/setTimeout\(function \(\) \{ pollDownload\(jobId\); \}, 1500\);/.test(src),
    "polls at exactly the 1500ms interval (call-site match)");
  assert.ok(!/,\s*15000\)/.test(src), "no stray 15-second interval snuck in");
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

// ── reattach-on-return: a distinct, deletion-detectable source contract ─────
// (Task 7 review finding 4). Plain string/substring checks on "believeActive"
// or "reattempted" alone would still pass if those identifiers were reused
// for something unrelated, and a check that only sees "/api/models/downloads"
// somewhere in the file can't tell reattach-on-init apart from the ordinary
// downloading/registering poll loop. These assertions were verified against
// a real deletion: temporarily removing the `if (believeActive &&
// !reattempted) { ... }` resume-POST block from ai-step-client.js made this
// test fail (the branchBody match came back without the guard/flip/re-POST
// lines), and restoring the block made it pass again.
test("ai-step-client.js: reattach-on-return is a distinct source contract (init fetch + vanished-job resume guard)", () => {
  const src = readFileSync(join(repoRoot, "servers/gateway/dashboard/panels/onboarding/ai-step-client.js"), "utf8");

  // Module-init Promise.all fetches catalog AND downloads together, feeding
  // both into renderLocalCard before any download starts or any idle
  // "Download and set up" button ever renders — this is what lets a step
  // re-entry pick up an in-flight job instead of restarting it.
  const initBlock = src.match(
    /Promise\.all\(\[\s*fetch\("\/api\/models\/catalog"\)[\s\S]{0,150}fetch\("\/api\/models\/downloads"\)[\s\S]{0,300}renderLocalCard\(results\[0\], results\[1\]\)/
  );
  assert.ok(initBlock, "module-init Promise.all fetches catalog+downloads together and feeds both into renderLocalCard, before any download starts");

  // The vanished-job resume guard, isolated to the "!job" branch specifically
  // (distinct from the ordinary downloading/registering poll loop below it).
  const vanishedJobBranch = src.match(/if \(!job\) \{[\s\S]{0,600}?\n\s*\}\n/);
  assert.ok(vanishedJobBranch, "could not locate the vanished-job (!job) branch");
  const branchBody = vanishedJobBranch[0];
  assert.ok(/believeActive\s*&&\s*!reattempted/.test(branchBody),
    "vanished-job branch gates the resume POST on believeActive && !reattempted together");
  assert.ok(/reattempted\s*=\s*true/.test(branchBody),
    "reattempted flips true before the resume POST fires (never-loop-forever guard)");
  assert.ok(/fetch\("\/api\/models\/download",/.test(branchBody),
    "vanished-job branch re-POSTs to the download endpoint to resume from the on-disk journal");
});

// ── ETA rendering: a minimal deletion-detectable source contract ───────────
// (review addendum). Verified against a real deletion: temporarily changing
// `etaText = fmtEta(...)` to `etaText = '--';` made this test fail, restoring
// it made it pass again.
test("ai-step-client.js: ETA rendering (fmtEta + rolling average) reaches the DOM at its render site", () => {
  const src = readFileSync(join(repoRoot, "servers/gateway/dashboard/panels/onboarding/ai-step-client.js"), "utf8");
  assert.ok(/function fmtEta\(/.test(src), "fmtEta helper defined");
  assert.ok(/etaText\s*=\s*fmtEta\(/.test(src), "renderProgress's rolling-average path calls fmtEta and assigns etaText");
  assert.ok(/etaLabel[\s\S]{0,80}join\(etaText\)/.test(src), "the ETA label is built by interpolating etaText into the downloadEta string");
  assert.ok(/statusEl2\.textContent\s*=[\s\S]{0,200}etaLabel/.test(src), "the render site writes etaLabel into the status text actually shown in the DOM");
});

// ── upsell deep-link (finding 1) ────────────────────────────────────────────
test("ai-step-client.js: the upsell card renders a real anchor to /dashboard/model-catalog, not plain text", () => {
  const src = readFileSync(join(repoRoot, "servers/gateway/dashboard/panels/onboarding/ai-step-client.js"), "utf8");
  const scriptStart = src.indexOf("<script>", src.indexOf("export function aiStepClientJS"));
  const scriptEnd = src.indexOf("</script>", scriptStart);
  const body = src.slice(scriptStart, scriptEnd);
  assert.ok(/createElement\("a"\)/.test(body), "upsell renders via a real <a> element");
  assert.ok(/upsellLink\.href\s*=\s*"\/dashboard\/model-catalog"/.test(body), "upsell link points at the real Model Catalog route");
  assert.ok(!body.includes("innerHTML"), "upsell link is built via DOM methods, never innerHTML (checked inside the served <script> block only)");
});
