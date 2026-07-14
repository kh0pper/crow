/**
 * Item 5 PR1 (spec §D1): guided-creation wizard state machine + honesty +
 * no-clobber create. Steps derive from WIZARD_STEP_KEYS (a step insertion
 * must not re-break positional assumptions); every step form must opt out
 * of Turbo Drive (data-turbo="false" — render-on-POST is incompatible with
 * Turbo's must-redirect rule, spec round-2 CRITICAL-A) and carry CSRF.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "btb-wizard-"));
process.env.CROW_DATA_DIR = dir;

let db = null;
let renderWizard, handleWizardCreate, WIZARD_STEP_KEYS, uniqueBotId, slugifyBotId;
let translations = null;

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir },
    stdio: "pipe",
    cwd: new URL("..", import.meta.url).pathname,
  });
  const { createDbClient } = await import("../servers/db.js");
  db = createDbClient();
  ({ renderWizard, handleWizardCreate, WIZARD_STEP_KEYS, uniqueBotId, slugifyBotId } =
    await import("../servers/gateway/dashboard/panels/bot-builder/wizard.js"));
  ({ translations } = await import("../servers/gateway/dashboard/shared/i18n.js"));
});

after(async () => {
  try { db && db.close && db.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

function mkRes() {
  const res = { redirected: null, html: null };
  res.redirectAfterPost = (url) => { res.redirected = url; };
  res.send = (html) => { res.html = html; return res; };
  return res;
}

const ctx = () => ({ db, layout: ({ content }) => content, lang: "en", PAGE_CSS: "", notice: "" });

async function renderGet(query = { new: "1" }) {
  const res = mkRes();
  await renderWizard({ method: "GET", query, headers: {} }, res, ctx());
  return res.html;
}

async function renderPost(body) {
  const res = mkRes();
  await renderWizard({ method: "POST", body, query: {}, headers: {} }, res, ctx());
  return res.html;
}

async function addProvider(id, models) {
  await db.execute({
    sql: "INSERT INTO providers (id, base_url, models, disabled) VALUES (?,?,?,0)",
    args: [id, "http://127.0.0.1:9999/v1", JSON.stringify(models)],
  });
}
const clearProviders = () => db.execute({ sql: "DELETE FROM providers", args: [] });
const botRow = async (id) =>
  (await db.execute({ sql: "SELECT bot_id, display_name, definition FROM pi_bot_defs WHERE bot_id=?", args: [id] })).rows[0] || null;

const stepIdx = (k) => WIZARD_STEP_KEYS.indexOf(k);

// ---- shape ----

test("WIZARD_STEP_KEYS is the five-step spec order", () => {
  assert.deepEqual(WIZARD_STEP_KEYS, ["template", "basics", "model", "channel", "review"]);
});

test("slugifyBotId + uniqueBotId collision suffix", async () => {
  assert.equal(slugifyBotId("  My Research Scout! "), "my-research-scout");
  assert.equal(slugifyBotId("---"), "");
  await db.execute({
    sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES ('taken','x','{}',1)",
    args: [],
  });
  assert.equal(await uniqueBotId(db, "Taken"), "taken-2");
  assert.equal(await uniqueBotId(db, "Free Name"), "free-name");
});

// ---- step 0 (template) ----

test("GET ?new=1 renders step 0: turbo opt-out, csrf, five template cards, no bare keys", async () => {
  const html = await renderGet();
  assert.match(html, /<form method="POST"[^>]*data-turbo="false"/, "step form must opt out of Turbo Drive");
  assert.match(html, /name="_csrf"/, "step form must carry CSRF");
  assert.match(html, /name="action" value="wizard_step"/);
  assert.match(html, /name="step" value="0"/);
  const radios = html.match(/name="tpl"/g) || [];
  assert.equal(radios.length, 5, "five template radio cards");
  assert.ok(!/botbuilder\.[a-zA-Z_]/.test(html), "no bare i18n keys");
});

test("GET with a step param still renders step 0 (no GET deep-links)", async () => {
  const html = await renderGet({ new: "1", step: "3" });
  assert.match(html, /name="step" value="0"/);
});

// ---- navigation + carry ----

test("next from template carries tpl into basics; back returns with state intact", async () => {
  const s1 = await renderPost({ action: "wizard_step", step: String(stepIdx("template")), nav: "next", tpl: "discord-qa" });
  assert.match(s1, /name="step" value="1"/);
  assert.match(s1, /name="display_name"/, "basics renders the name input");
  assert.match(s1, /<input type="hidden" name="tpl" value="discord-qa">/, "tpl carried");
  // back from basics re-renders template with the selection preserved
  const s0 = await renderPost({ action: "wizard_step", step: "1", nav: "back", tpl: "discord-qa", display_name: "My Bot" });
  assert.match(s0, /name="step" value="0"/);
  assert.match(s0, /value="discord-qa" checked/, "returning Back preserves the selected card");
  assert.match(s0, /<input type="hidden" name="display_name" value="My Bot">/, "entered name survives Back");
});

test("basics requires a name (re-render with error, no advance)", async () => {
  const html = await renderPost({ action: "wizard_step", step: "1", nav: "next", tpl: "blank", display_name: "  " });
  assert.match(html, /name="step" value="1"/, "stays on basics");
  assert.match(html, /callout-error/, "renders the error callout");
});

test("basics → model computes a collision-suffixed bot_id into the carry", async () => {
  await addProvider("prov", [{ id: "m1" }]);
  await db.execute({
    sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES ('taken-2','x','{}',1)",
    args: [],
  });
  const html = await renderPost({ action: "wizard_step", step: "1", nav: "next", tpl: "blank", display_name: "Taken" });
  assert.match(html, /name="step" value="2"/);
  assert.match(html, /<input type="hidden" name="bot_id" value="taken-3">/, "collision suffix continues past existing ids");
  await clearProviders();
});

// ---- model honesty (Item 4 contract carried into the wizard) ----

test("model step with zero providers: warn + providers link + disabled Next, no select", async () => {
  await clearProviders();
  const html = await renderPost({ action: "wizard_step", step: "1", nav: "next", tpl: "blank", display_name: "Zero Prov" });
  assert.match(html, /btb-warn/, "warn shown");
  assert.ok(html.includes("/dashboard/settings?section=llm&amp;tab=providers"), "providers deep link");
  assert.ok(!html.includes('name="model"'), "no submittable empty model select");
  assert.match(html, /name="nav" value="next"[^>]*disabled|disabled[^>]*name="nav" value="next"/, "Next disabled");
});

test("model step invalid selection re-renders with error", async () => {
  await addProvider("prov", [{ id: "m1" }]);
  const html = await renderPost({
    action: "wizard_step", step: "2", nav: "next",
    tpl: "blank", display_name: "X", bot_id: "x", model: "prov/other",
  });
  assert.match(html, /name="step" value="2"/, "stays on model step");
  assert.match(html, /callout-error/);
  await clearProviders();
});

// ---- channel step + multi-line carry ----

test("channel step renders shared gateway fields; review re-emits newlines as entities", async () => {
  await addProvider("prov", [{ id: "m1" }]);
  const ch = await renderPost({
    action: "wizard_step", step: "2", nav: "next",
    tpl: "email-responder", display_name: "Mail Bot", bot_id: "mail-bot", model: "prov/m1",
  });
  assert.match(ch, /name="step" value="3"/);
  assert.ok(ch.includes('name="gw_address"'), "gmail fields via shared renderer (template preselects gmail)");
  // → review with a multi-line allowlist: carry must preserve the newline
  const rv = await renderPost({
    action: "wizard_step", step: "3", nav: "next",
    tpl: "email-responder", display_name: "Mail Bot", bot_id: "mail-bot", model: "prov/m1",
    gw_type: "gmail", gw_address: "me+bot@x.com", gw_allowlist: "a@x.com\nb@y.com",
  });
  assert.match(rv, /name="step" value="4"/);
  assert.match(rv, /name="action" value="wizard_create"/, "review form posts wizard_create");
  assert.ok(rv.includes("a@x.com&#10;b@y.com"), "newline carried as &#10; entity");
  assert.match(rv, /name="nav" value="back"/, "review has Back");
  assert.match(rv, /name="nav" value="create"/, "review has Create");
  assert.match(rv, /data-turbo="false"/);
  await clearProviders();
});

test("channel reload (update-fields button) re-renders the same step with the new type's fields", async () => {
  const html = await renderPost({
    action: "wizard_step", step: "3", nav: "reload",
    tpl: "blank", display_name: "X", bot_id: "x", model: "prov/m1", gw_type: "slack",
  });
  assert.match(html, /name="step" value="3"/, "reload stays on channel");
  assert.ok(html.includes('name="gw_bot_token"'), "slack fields rendered after type change");
});

// ---- final create ----

test("wizard_create (blank/none): inserts row, safe defaults, PRG to review with created notice", async () => {
  await addProvider("prov", [{ id: "m1" }]);
  const res = mkRes();
  await handleWizardCreate({ body: {
    action: "wizard_create", nav: "create",
    tpl: "blank", display_name: "Fresh Bot", bot_id: "fresh-bot", model: "prov/m1", gw_type: "none",
  } }, res, { db, lang: "en" });
  assert.match(res.redirected, /bot=fresh-bot&tab=review&created=fresh-bot/);
  const row = await botRow("fresh-bot");
  assert.ok(row, "row inserted");
  const def = JSON.parse(row.definition);
  assert.equal(def.models.default, "prov/m1");
  assert.deepEqual(def.gateways, []);
  assert.equal(def.permission_policy.bash, "deny");
  assert.equal(def.permission_policy.external_send, "draft_only");
  await clearProviders();
});

test("wizard_create (gmail): channel record parity via the shared normalizer", async () => {
  await addProvider("prov", [{ id: "m1" }]);
  const res = mkRes();
  await handleWizardCreate({ body: {
    action: "wizard_create", nav: "create",
    tpl: "email-responder", display_name: "Mail Bot", bot_id: "mail-bot", model: "prov/m1",
    gw_type: "gmail", gw_address: "me+bot@x.com", gw_allowlist: "a@x.com\nb@y.com",
  } }, res, { db, lang: "en" });
  const def = JSON.parse((await botRow("mail-bot")).definition);
  assert.deepEqual(def.gateways, [{ type: "gmail", address: "me+bot@x.com", allowlist: ["a@x.com", "b@y.com"] }]);
  assert.ok(def.system_prompt.toLowerCase().includes("email"), "template prompt applied");
  await clearProviders();
});

test("wizard_create conflict: duplicate submit redirects to the existing bot, never clobbers", async () => {
  await addProvider("prov", [{ id: "m1" }]);
  const res = mkRes();
  await handleWizardCreate({ body: {
    action: "wizard_create", nav: "create",
    tpl: "blank", display_name: "CLOBBERED?", bot_id: "fresh-bot", model: "prov/m1", gw_type: "none",
  } }, res, { db, lang: "en" });
  assert.match(res.redirected, /bot=fresh-bot&tab=review&created=fresh-bot/, "neutral created redirect");
  assert.ok(!/error=/.test(res.redirected), "no error banner on duplicate submit");
  const row = await botRow("fresh-bot");
  assert.equal(row.display_name, "Fresh Bot", "existing bot untouched (no clobber)");
  await clearProviders();
});

test("wizard_create invalid model: PRG back to wizard with error, no row", async () => {
  await clearProviders();
  const res = mkRes();
  await handleWizardCreate({ body: {
    action: "wizard_create", nav: "create",
    tpl: "blank", display_name: "Nope", bot_id: "nope-bot", model: "ghost/model", gw_type: "none",
  } }, res, { db, lang: "en" });
  assert.match(res.redirected, /new=1&error=/);
  assert.equal(await botRow("nope-bot"), null);
});

test("wizard_create with nav=back sends nothing (falls through to the step render)", async () => {
  const res = mkRes();
  await handleWizardCreate({ body: { action: "wizard_create", nav: "back", tpl: "blank" } }, res, { db, lang: "en" });
  assert.equal(res.redirected, null);
  assert.equal(res.html, null);
});

test("wizard_create (voice type): persists a type-only draft record", async () => {
  await addProvider("prov", [{ id: "m1" }]);
  const res = mkRes();
  await handleWizardCreate({ body: {
    action: "wizard_create", nav: "create",
    tpl: "blank", display_name: "Kiosk Bot", bot_id: "kiosk-bot", model: "prov/m1", gw_type: "companion",
  } }, res, { db, lang: "en" });
  const def = JSON.parse((await botRow("kiosk-bot")).definition);
  assert.deepEqual(def.gateways, [{ type: "companion" }], "device-less draft, W1-4 semantics");
  await clearProviders();
});

// ---- i18n parity for the new keys (full-panel parity test lands in PR3) ----

test("every new wizard key ships en+es and es differs from en (except proper nouns)", () => {
  const sameOk = new Set([
    "botbuilder.wizGw_gmail", "botbuilder.wizGw_discord", "botbuilder.wizGw_telegram",
    "botbuilder.wizGw_slack", "botbuilder.wizGw_glasses",
  ]);
  const wizKeys = Object.keys(translations).filter((k) =>
    k.startsWith("botbuilder.wiz") || k.startsWith("botbuilder.tpl_") ||
    ["botbuilder.createExists", "botbuilder.quickCreateSummary",
      "botbuilder.emptyListWizard", "botbuilder.emptyListWizardLink"].includes(k));
  assert.ok(wizKeys.length >= 45, "expected the full wizard key set, got " + wizKeys.length);
  for (const k of wizKeys) {
    const e = translations[k];
    assert.ok(e.en && e.es, `${k} must have en+es`);
    if (!sameOk.has(k)) assert.notEqual(e.en, e.es, `${k} es must differ from en (t() silently falls back)`);
  }
});
