/**
 * Item 4 PR1 (§2.1 items 3-6): create-form / create-action honesty.
 *
 * The Bot Builder used to bake Kevin's personal defaults into every new bot:
 * a hardcoded crow-local/qwen3.6-35b-a3b model pin (form + silent create
 * fallback + defaultDefinition fallback) and a kevin.hopper@maestro.press
 * Gmail gateway. A fresh install must never inherit those:
 *   - defaultDefinition REQUIRES a validated model key (throws on empty —
 *     tripwire; the create guard upstream is the real gate), ships
 *     gateways: [], and no PI_PROVIDER in spawn_env.
 *   - the create action rejects an empty/unknown model (no row inserted).
 *   - the create form disables submit + links to provider settings when no
 *     models exist, and never pins a specific model when they do.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "btb-create-honesty-"));
process.env.CROW_DATA_DIR = dir;

let db = null;
let handleBotBuilderPost = null;
let defaultDefinition = null;
let renderBotList = null;
let translations = null;

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir },
    stdio: "pipe",
    cwd: new URL("..", import.meta.url).pathname,
  });
  const { createDbClient } = await import("../servers/db.js");
  db = createDbClient();
  ({ handleBotBuilderPost } = await import("../servers/gateway/dashboard/panels/bot-builder/api-handlers.js"));
  ({ defaultDefinition } = await import("../servers/gateway/dashboard/panels/bot-builder/data-queries.js"));
  ({ renderBotList } = await import("../servers/gateway/dashboard/panels/bot-builder/html.js"));
  ({ translations } = await import("../servers/gateway/dashboard/shared/i18n.js"));
});

after(async () => {
  try { db && db.close && db.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

function mkRes() {
  const res = { redirected: null, html: null };
  res.redirectAfterPost = (url) => { res.redirected = url; };
  res.send = (html) => { res.html = html; };
  return res;
}

async function clearProviders() {
  await db.execute({ sql: "DELETE FROM providers", args: [] });
}

async function addProvider(id, models) {
  await db.execute({
    sql: "INSERT INTO providers (id, base_url, models, disabled) VALUES (?,?,?,0)",
    args: [id, "http://127.0.0.1:9999/v1", JSON.stringify(models)],
  });
}

async function botRow(botId) {
  const { rows } = await db.execute({ sql: "SELECT bot_id, definition FROM pi_bot_defs WHERE bot_id=?", args: [botId] });
  return rows[0] || null;
}

const renderCtx = (overrides = {}) => ({
  db,
  layout: ({ content }) => content,
  notice: "",
  PAGE_CSS: "",
  req: { headers: {} },
  ...overrides,
});

// ---- Task C: defaultDefinition de-personalization ----

test("defaultDefinition throws on empty model (tripwire — create guard is upstream)", () => {
  assert.throws(() => defaultDefinition("t-bot", 1, ""), /model/i);
  assert.throws(() => defaultDefinition("t-bot", 1, undefined), /model/i);
});

test("defaultDefinition returns gateways: [] (no personal Gmail gateway)", () => {
  const def = defaultDefinition("t-bot", 1, "prov/m1");
  assert.deepEqual(def.gateways, []);
});

test("defaultDefinition spawn_env has no PI_PROVIDER (bridge sets it per turn) but keeps CROW_JOURNAL_MODE", () => {
  const def = defaultDefinition("t-bot", 1, "prov/m1");
  assert.ok(!("PI_PROVIDER" in def.spawn_env), "PI_PROVIDER must not be baked into spawn_env");
  assert.equal(def.spawn_env.CROW_JOURNAL_MODE, "DELETE");
});

test("defaultDefinition JSON contains no personal substrings (kevin / maestro.press)", () => {
  const json = JSON.stringify(defaultDefinition("t-bot", 42, "prov/m1")).toLowerCase();
  assert.ok(!json.includes("kevin"), "definition must not contain 'kevin'");
  assert.ok(!json.includes("maestro.press"), "definition must not contain 'maestro.press'");
  assert.ok(!json.includes("crow-local/qwen3.6-35b-a3b"), "definition must not contain the old model pin");
});

test("defaultDefinition uses the passed model as models.default", () => {
  const def = defaultDefinition("t-bot", 1, "prov/m1");
  assert.equal(def.models.default, "prov/m1");
});

// ---- Task B: create-action guard ----

test("create with a model not in the provider registry inserts NO row and surfaces an error", async () => {
  await clearProviders();
  await addProvider("prov", ["m1", "m2"]);
  const res = mkRes();
  await handleBotBuilderPost(
    { body: { action: "create", bot_id: "bad-model-bot", display_name: "Bad", model: "prov/nope" }, headers: {} },
    res, { db }
  );
  assert.equal(await botRow("bad-model-bot"), null, "no pi_bot_defs row on invalid model");
  assert.match(res.redirected, /error=/, "error banner must be surfaced: " + res.redirected);
});

test("create with an EMPTY model inserts NO row (old silent crow-local fallback is gone)", async () => {
  await clearProviders();
  await addProvider("prov", ["m1"]);
  const res = mkRes();
  await handleBotBuilderPost(
    { body: { action: "create", bot_id: "empty-model-bot", display_name: "Empty" }, headers: {} },
    res, { db }
  );
  assert.equal(await botRow("empty-model-bot"), null, "no pi_bot_defs row on empty model");
  assert.match(res.redirected, /error=/);
});

test("create with a valid model inserts the row with that model", async () => {
  await clearProviders();
  await addProvider("prov", ["m1", "m2"]);
  const res = mkRes();
  await handleBotBuilderPost(
    { body: { action: "create", bot_id: "good-bot", display_name: "Good", model: "prov/m2" }, headers: {} },
    res, { db }
  );
  const row = await botRow("good-bot");
  assert.ok(row, "row inserted for valid model: " + res.redirected);
  const def = JSON.parse(row.definition);
  assert.equal(def.models.default, "prov/m2");
  // Item 5 PR2 (spec §D4): create lands on the readiness checklist.
  assert.match(res.redirected, /tab=review&created=good-bot/);
});

test("create error message is i18n-keyed (botbuilder.createModelInvalid, EN+ES)", async () => {
  const entry = translations["botbuilder.createModelInvalid"];
  assert.ok(entry && entry.en && entry.es, "botbuilder.createModelInvalid must exist with en+es");
  await clearProviders();
  await addProvider("prov", ["m1"]);
  const res = mkRes();
  await handleBotBuilderPost(
    { body: { action: "create", bot_id: "i18n-bot", display_name: "I18n", model: "prov/nope" }, headers: {} },
    res, { db }
  );
  assert.ok(
    res.redirected.includes(encodeURIComponent(entry.en)),
    "redirect must carry the i18n'd message: " + res.redirected
  );
});

// ---- Task A: create-form honesty ----

test("render with ZERO providers: submit disabled + providers settings link", async () => {
  await clearProviders();
  const res = mkRes();
  await renderBotList(res, renderCtx());
  assert.ok(res.html, "renderBotList must send html");
  assert.match(
    res.html,
    /<button type="submit" class="btb-btn" disabled>/,
    "create submit must carry the disabled attribute when no models exist"
  );
  assert.ok(
    res.html.includes("/dashboard/settings?section=llm&amp;tab=providers") ||
    res.html.includes("/dashboard/settings?section=llm&tab=providers"),
    "warning must link to the providers settings tab"
  );
});

test("render WITH providers: first option is the natural default, no crow-local pin, submit enabled", async () => {
  await clearProviders();
  // Deliberately include the previously-pinned model so the old hardcoded
  // `selected` attribute would trigger if it ever came back.
  await addProvider("aprov", ["alpha", "beta"]);
  await addProvider("crow-local", ["qwen3.6-35b-a3b"]);
  const res = mkRes();
  await renderBotList(res, renderCtx());
  const html = res.html;
  // Model select present with the first provider model as the FIRST option.
  const sel = html.match(/<select name="model"[^>]*>([\s\S]*?)<\/select>/);
  assert.ok(sel, "model select must render");
  const firstOpt = sel[1].match(/<option value="([^"]+)"/);
  assert.equal(firstOpt && firstOpt[1], "aprov/alpha", "first option must be the first provider model");
  // No hardcoded selected pin anywhere in the model select — the browser's
  // natural first-option default is the honest behavior.
  assert.ok(!sel[1].includes(" selected"), "no option may carry a hardcoded selected attribute");
  // Submit enabled again.
  assert.match(html, /<button type="submit" class="btb-btn">/);
  assert.ok(!/<button type="submit" class="btb-btn" disabled>/.test(html));
});

// ---- Task D + E: honest warn text / generic gwHintGmail ----

test("editor warn text no longer claims a crow-local fail-closed fallback", () => {
  const src = readFileSync(new URL("../servers/gateway/dashboard/panels/bot-builder/api-handlers.js", import.meta.url), "utf8");
  assert.ok(!src.includes("fails closed to crow-local"), "lying warn text must be gone");
  assert.ok(
    src.includes("saved anyway; runs will fail until this model is available on this instance."),
    "honest warn text must be present"
  );
});

test("gwHintGmail is generic (no maestro.press alias example) in EN and ES", () => {
  const entry = translations["botbuilder.gwHintGmail"];
  assert.ok(entry && entry.en && entry.es);
  assert.ok(!entry.en.includes("maestro.press"), "EN hint must not reference maestro.press");
  assert.ok(!entry.es.includes("maestro.press"), "ES hint must not reference maestro.press");
  assert.match(entry.en, /bridge_tick\.mjs/, "EN hint still explains the polling mechanism");
  assert.match(entry.es, /bridge_tick\.mjs/, "ES hint still explains the polling mechanism");
});

test("providers-link text is i18n-keyed (botbuilder.createProvidersLink, EN+ES)", () => {
  const entry = translations["botbuilder.createProvidersLink"];
  assert.ok(entry && entry.en && entry.es, "botbuilder.createProvidersLink must exist with en+es");
});
