/**
 * C4 Task 7 — server-side engine-attach gate + runtime-disarmed warning on
 * the Bot Builder gateways-tab save path.
 *
 * The gate fires ONLY on a functional attach: the saved gateway record has
 * `type ∈ ENGINE_CHANNELS` (gmail/discord/telegram/slack) AND
 * `missingGatewayFields(gw).length === 0` (a complete record). An
 * incomplete draft (the type-only record the dropdown's
 * onchange="this.form.requestSubmit()" auto-submit produces before the
 * operator has typed anything — W1-4 snap-back doctrine) must keep saving
 * exactly as before the gate existed; no consumer acts on an incomplete
 * record anyway.
 *
 * engineStatus()'s real resolution ladder (pi_resolver.mjs) has a "global"
 * rung keyed off process.execPath that resolves to a REAL install on this
 * dev box (crow itself hosts a real bot-engine) — so "CROW_HOME empty +
 * clear PIBOT_PI_CLI" does NOT reliably produce engineStatus().state ===
 * "absent" here the way it would on a clean CI runner. The absent/ready/
 * installing/unhealthy scenarios below pin the result via
 * _setEngineStatusForTest instead, so they're deterministic regardless of
 * what's installed on the host running the suite. One test (PIBOT_PI_CLI
 * pointed at a real tmp file) exercises the REAL engineStatus() to prove
 * the production wiring — rung 1 (env override) always wins verbatim
 * regardless of host state, so it's safe to rely on directly.
 *
 * The runtime-disarmed warning (&warn=bot_runtime_off) reads
 * botRuntimeStatus().mode, which is a module singleton only populated by a
 * real initBotRuntime() call (timers, a sync sqlite handle, the event bus)
 * — too heavy for a route test, so it's pinned the same way via
 * _setBotRuntimeStatusForTest.
 */
import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "btb-engine-gate-"));
process.env.CROW_DATA_DIR = dir;

let db = null;
let handleBotBuilderPost = null;
let _setEngineStatusForTest = null;
let _setBotRuntimeStatusForTest = null;
let writeSetting = null;
let handleWizardCreate = null;
let renderWizard = null;
let WIZARD_STEP_KEYS = null;
let renderBotEditor = null;
let botBuilderPanel = null;

const origPibotPiCli = process.env.PIBOT_PI_CLI;
const origCrowHome = process.env.CROW_HOME;

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir },
    stdio: "pipe",
    cwd: new URL("..", import.meta.url).pathname,
  });
  const { createDbClient } = await import("../servers/db.js");
  db = createDbClient();
  ({
    handleBotBuilderPost,
    _setEngineStatusForTest,
    _setBotRuntimeStatusForTest,
  } = await import("../servers/gateway/dashboard/panels/bot-builder/api-handlers.js"));
  ({ writeSetting } = await import("../servers/gateway/dashboard/settings/registry.js"));
  ({ handleWizardCreate, renderWizard, WIZARD_STEP_KEYS } =
    await import("../servers/gateway/dashboard/panels/bot-builder/wizard.js"));
  ({ renderBotEditor } = await import("../servers/gateway/dashboard/panels/bot-builder/editor.js"));
  ({ default: botBuilderPanel } = await import("../servers/gateway/dashboard/panels/bot-builder.js"));
});

after(async () => {
  try { db && db.close && db.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  _setEngineStatusForTest(null);
  _setBotRuntimeStatusForTest(null);
  if (origPibotPiCli === undefined) delete process.env.PIBOT_PI_CLI;
  else process.env.PIBOT_PI_CLI = origPibotPiCli;
  if (origCrowHome === undefined) delete process.env.CROW_HOME;
  else process.env.CROW_HOME = origCrowHome;
  // Reset each bot to a plain gmail gateway before every test so a prior
  // test's saved (or rejected) state can't leak into the next.
  await db.execute({
    sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES (?,?,?,1) " +
      "ON CONFLICT(bot_id) DO UPDATE SET definition=excluded.definition",
    args: ["gate-bot", "Gate Bot", JSON.stringify({ gateways: [{ type: "gmail", address: "x@y.z", allowlist: ["x@y.z"] }], tools: {}, models: {} })],
  });
  await writeSetting(db, "feature_flags", JSON.stringify({}), { scope: "local" });
});

afterEach(() => {
  _setEngineStatusForTest(null);
  _setBotRuntimeStatusForTest(null);
  if (origCrowHome === undefined) delete process.env.CROW_HOME;
  else process.env.CROW_HOME = origCrowHome;
});

function mkRes() {
  const res = { redirected: null };
  res.redirectAfterPost = (url) => { res.redirected = url; };
  return res;
}

async function readDef() {
  const { rows } = await db.execute({ sql: "SELECT definition FROM pi_bot_defs WHERE bot_id='gate-bot'", args: [] });
  return JSON.parse(rows[0].definition);
}

// ---------------------------------------------------------------------------
// complete engine-channel records, engine absent → rejected
// ---------------------------------------------------------------------------

test("complete discord record + engine absent → error=engine_required, def unchanged", async () => {
  _setEngineStatusForTest({ state: "absent" });
  const before = await readDef();
  const res = mkRes();
  await handleBotBuilderPost(
    { body: { action: "save_gateways", bot_id: "gate-bot", gw_type: "discord", gw_token: "tok123" } },
    res, { db }
  );
  assert.match(res.redirected, /error=engine_required/, "must redirect with error=engine_required: " + res.redirected);
  assert.equal(res.redirected.includes("saved=1"), false);
  const after = await readDef();
  assert.deepEqual(after, before, "definition must be unchanged when the gate rejects the save");
});

test("complete gmail record + engine absent → error=engine_required, def unchanged", async () => {
  _setEngineStatusForTest({ state: "absent" });
  const before = await readDef();
  const res = mkRes();
  await handleBotBuilderPost(
    { body: { action: "save_gateways", bot_id: "gate-bot", gw_type: "gmail", gw_address: "bot@x.com", gw_allowlist: "a@b.c" } },
    res, { db }
  );
  assert.match(res.redirected, /error=engine_required/, "must redirect with error=engine_required: " + res.redirected);
  const after = await readDef();
  assert.deepEqual(after, before, "definition must be unchanged when the gate rejects the save");
});

// ---------------------------------------------------------------------------
// incomplete draft, engine absent → saves exactly as today (draft doctrine)
// ---------------------------------------------------------------------------

test("incomplete (type-only) discord draft + engine absent → saved as today, not gated", async () => {
  _setEngineStatusForTest({ state: "absent" });
  const res = mkRes();
  await handleBotBuilderPost(
    { body: { action: "save_gateways", bot_id: "gate-bot", gw_type: "discord" } }, // no gw_token
    res, { db }
  );
  assert.match(res.redirected, /saved=1/, "type-only draft must save even with the engine absent: " + res.redirected);
  const def = await readDef();
  assert.equal(def.gateways[0]?.type, "discord");
  assert.equal(def.gateways[0]?.token, "", "no token on the draft");
});

// ---------------------------------------------------------------------------
// non-gated types
// ---------------------------------------------------------------------------

test("complete crow-messages gateway + engine absent → saved (crow-messages never gated)", async () => {
  _setEngineStatusForTest({ state: "absent" });
  const res = mkRes();
  await handleBotBuilderPost(
    { body: { action: "save_gateways", bot_id: "gate-bot", gw_type: "crow-messages", gw_allow_paired_instances: "on" } },
    res, { db }
  );
  assert.match(res.redirected, /saved=1/, "crow-messages must never be gated: " + res.redirected);
  const def = await readDef();
  assert.equal(def.gateways[0]?.type, "crow-messages");
});

test("none type + engine absent → saved", async () => {
  _setEngineStatusForTest({ state: "absent" });
  const res = mkRes();
  await handleBotBuilderPost(
    { body: { action: "save_gateways", bot_id: "gate-bot", gw_type: "none" } },
    res, { db }
  );
  assert.match(res.redirected, /saved=1/, "none type must never be gated: " + res.redirected);
  const def = await readDef();
  assert.deepEqual(def.gateways, []);
});

// ---------------------------------------------------------------------------
// engine states that must NOT block (engine exists — only "absent" blocks)
// ---------------------------------------------------------------------------

test("complete discord record + engine installing → saved (installing does not block)", async () => {
  _setEngineStatusForTest({ state: "installing" });
  const res = mkRes();
  await handleBotBuilderPost(
    { body: { action: "save_gateways", bot_id: "gate-bot", gw_type: "discord", gw_token: "tok123" } },
    res, { db }
  );
  assert.match(res.redirected, /saved=1/, "installing must not block attach: " + res.redirected);
});

test("complete discord record + engine unhealthy → saved (unhealthy does not block)", async () => {
  _setEngineStatusForTest({ state: "unhealthy", error: "boom", retryAt: null });
  const res = mkRes();
  await handleBotBuilderPost(
    { body: { action: "save_gateways", bot_id: "gate-bot", gw_type: "discord", gw_token: "tok123" } },
    res, { db }
  );
  assert.match(res.redirected, /saved=1/, "unhealthy must not block attach: " + res.redirected);
});

// ---------------------------------------------------------------------------
// real engineStatus() integration — PIBOT_PI_CLI rung always wins verbatim
// ---------------------------------------------------------------------------

test("complete record with PIBOT_PI_CLI pointing at a real tmp stub file (ready) → saved", async () => {
  const stub = join(dir, "pi-cli-stub.js");
  writeFileSync(stub, "// stub\n");
  process.env.PIBOT_PI_CLI = stub;
  const res = mkRes();
  await handleBotBuilderPost(
    { body: { action: "save_gateways", bot_id: "gate-bot", gw_type: "discord", gw_token: "tok123" } },
    res, { db }
  );
  assert.match(res.redirected, /saved=1/, "real engineStatus() ready must save: " + res.redirected);
  assert.equal(res.redirected.includes("warn=bot_runtime_off"), false, "botRuntimeStatus() defaults to mode!=='gateway' with no real init");
});

// ---------------------------------------------------------------------------
// runtime-disarmed warning
// ---------------------------------------------------------------------------

test("engine ready + bot_runtime flag off → saved with warn=bot_runtime_off", async () => {
  _setEngineStatusForTest({ state: "ready", source: "env", cliPath: "/fake/cli.js" });
  _setBotRuntimeStatusForTest({ mode: "gateway" });
  await writeSetting(db, "feature_flags", JSON.stringify({ bot_runtime: false }), { scope: "local" });
  const res = mkRes();
  await handleBotBuilderPost(
    { body: { action: "save_gateways", bot_id: "gate-bot", gw_type: "discord", gw_token: "tok123" } },
    res, { db }
  );
  assert.match(res.redirected, /saved=1/, "save must still succeed: " + res.redirected);
  assert.match(res.redirected, /warn=bot_runtime_off/, "must warn the runtime is disarmed: " + res.redirected);
});

test("engine ready + bot_runtime flag on → saved, no warn", async () => {
  _setEngineStatusForTest({ state: "ready", source: "env", cliPath: "/fake/cli.js" });
  _setBotRuntimeStatusForTest({ mode: "gateway" });
  await writeSetting(db, "feature_flags", JSON.stringify({ bot_runtime: true }), { scope: "local" });
  const res = mkRes();
  await handleBotBuilderPost(
    { body: { action: "save_gateways", bot_id: "gate-bot", gw_type: "discord", gw_token: "tok123" } },
    res, { db }
  );
  assert.match(res.redirected, /saved=1/, "save must succeed: " + res.redirected);
  assert.equal(res.redirected.includes("warn=bot_runtime_off"), false, "flag on must not warn: " + res.redirected);
});

test("engine ready + runtime mode 'disabled' (suite kill switch) → saved, no warn", async () => {
  _setEngineStatusForTest({ state: "ready", source: "env", cliPath: "/fake/cli.js" });
  _setBotRuntimeStatusForTest({ mode: "disabled" });
  await writeSetting(db, "feature_flags", JSON.stringify({ bot_runtime: false }), { scope: "local" });
  const res = mkRes();
  await handleBotBuilderPost(
    { body: { action: "save_gateways", bot_id: "gate-bot", gw_type: "discord", gw_token: "tok123" } },
    res, { db }
  );
  assert.match(res.redirected, /saved=1/);
  assert.equal(res.redirected.includes("warn=bot_runtime_off"), false, "mode!=='gateway' must never warn");
});

// ---------------------------------------------------------------------------
// Review finding 1: the runtime-disarmed warning must read botRuntimeActive(db)
// (which falls back to isMpaHost() when the flag is unset), NOT hand-roll
// "unset === off". On an MPA host with an unset flag, the runtime is armed
// by default — warning anyway would be a false positive.
// ---------------------------------------------------------------------------

test("MPA-shaped host + UNSET bot_runtime flag + engine ready → saved, NO warn (isMpaHost fallback arms the runtime)", async () => {
  _setEngineStatusForTest({ state: "ready", source: "env", cliPath: "/fake/cli.js" });
  _setBotRuntimeStatusForTest({ mode: "gateway" });
  await writeSetting(db, "feature_flags", JSON.stringify({}), { scope: "local" }); // bot_runtime key absent entirely
  process.env.CROW_HOME = "/home/x/.crow-mpa"; // isMpaHost() keys off CROW_HOME|CROW_DATA_DIR containing ".crow-mpa"
  const res = mkRes();
  await handleBotBuilderPost(
    { body: { action: "save_gateways", bot_id: "gate-bot", gw_type: "discord", gw_token: "tok123" } },
    res, { db }
  );
  assert.match(res.redirected, /saved=1/, "save must succeed: " + res.redirected);
  assert.equal(res.redirected.includes("warn=bot_runtime_off"), false,
    "MPA host + unset flag must resolve bot_runtime=true via botRuntimeActive's isMpaHost() fallback: " + res.redirected);
});

test("plain (non-MPA) host + UNSET bot_runtime flag + engine ready → saved WITH warn", async () => {
  _setEngineStatusForTest({ state: "ready", source: "env", cliPath: "/fake/cli.js" });
  _setBotRuntimeStatusForTest({ mode: "gateway" });
  await writeSetting(db, "feature_flags", JSON.stringify({}), { scope: "local" }); // bot_runtime key absent entirely
  delete process.env.CROW_HOME; // CROW_DATA_DIR is already a plain tmp dir (no ".crow-mpa")
  const res = mkRes();
  await handleBotBuilderPost(
    { body: { action: "save_gateways", bot_id: "gate-bot", gw_type: "discord", gw_token: "tok123" } },
    res, { db }
  );
  assert.match(res.redirected, /saved=1/, "save must succeed: " + res.redirected);
  assert.match(res.redirected, /warn=bot_runtime_off/,
    "plain host + unset flag must default off (isMpaHost() false) and warn: " + res.redirected);
});

// ---------------------------------------------------------------------------
// Review finding 2: the wizard's final create must be gated the same way the
// Gateways-tab save is — a complete engine-channel record built via the same
// normalizeGatewayFields machinery must not be INSERTed while the engine is
// absent (nothing would ever poll it, and the operator never sees a warning
// because the row would look fully onboarded).
// ---------------------------------------------------------------------------

async function addWizProvider(id, models) {
  await db.execute({
    sql: "INSERT INTO providers (id, base_url, models, disabled) VALUES (?,?,?,0)",
    args: [id, "http://127.0.0.1:9999/v1", JSON.stringify(models)],
  });
}
const clearWizProviders = () => db.execute({ sql: "DELETE FROM providers", args: [] });
const wizBotRow = async (id) =>
  (await db.execute({ sql: "SELECT bot_id, display_name, definition FROM pi_bot_defs WHERE bot_id=?", args: [id] })).rows[0] || null;
const wizStepIdx = (k) => WIZARD_STEP_KEYS.indexOf(k);

function mkWizRes() {
  const res = { redirected: null, html: null };
  res.redirectAfterPost = (url) => { res.redirected = url; };
  res.send = (html) => { res.html = html; return res; };
  return res;
}

test("wizard create: complete discord record + engine absent → NOT inserted, bounces back to the channel step with the carry intact", async () => {
  await addWizProvider("wizprov", [{ id: "m1" }]);
  _setEngineStatusForTest({ state: "absent" });
  const body = {
    action: "wizard_create", nav: "create",
    tpl: "discord-qa", display_name: "Wiz Discord Bot", bot_id: "wiz-discord-bot",
    model: "wizprov/m1", gw_type: "discord", gw_token: "tok123",
  };
  const res = mkWizRes();
  await handleWizardCreate({ body }, res, { db, lang: "en" });
  assert.equal(res.redirected, null, "engine-required gate must send nothing (same convention as name/model validation failures)");
  assert.equal(res.html, null);
  assert.equal(await wizBotRow("wiz-discord-bot"), null, "no pi_bot_defs row inserted while the engine is absent");

  // panel-handler fall-through: handleWizardCreate sent nothing, so the
  // caller falls through to renderWizard, which re-derives the failure and
  // re-renders the CHANNEL step (not review) with the carry intact — the
  // same PRG-avoidance convention as the existing name/model gate failures.
  const renderRes = mkWizRes();
  await renderWizard(
    { method: "POST", body, query: {}, headers: {} },
    renderRes,
    { db, layout: ({ content }) => content, lang: "en", PAGE_CSS: "", notice: "" }
  );
  const html = renderRes.html;
  assert.match(html, new RegExp(`name="step" value="${wizStepIdx("channel")}"`), "re-renders the channel step, not review");
  assert.match(html, /callout-error/, "shows an error callout");
  assert.match(html, /<input type="hidden" name="display_name" value="Wiz Discord Bot">/, "entered state preserved");
  await clearWizProviders();
  _setEngineStatusForTest(null);
});

test("wizard create: complete discord record + engine ready → inserted as before", async () => {
  await addWizProvider("wizprov", [{ id: "m1" }]);
  _setEngineStatusForTest({ state: "ready", source: "env", cliPath: "/fake/cli.js" });
  const res = mkWizRes();
  await handleWizardCreate({ body: {
    action: "wizard_create", nav: "create",
    tpl: "discord-qa", display_name: "Wiz Discord Bot 2", bot_id: "wiz-discord-bot-2",
    model: "wizprov/m1", gw_type: "discord", gw_token: "tok123",
  } }, res, { db, lang: "en" });
  assert.match(res.redirected, /bot=wiz-discord-bot-2&tab=review&created=wiz-discord-bot-2/, "must PRG on success: " + res.redirected);
  const row = await wizBotRow("wiz-discord-bot-2");
  assert.ok(row, "row must be inserted when the engine is ready");
  const def = JSON.parse(row.definition);
  assert.deepEqual(def.gateways, [{ type: "discord", token: "tok123", allowlist: [], channel_ids: [] }]);
  await clearWizProviders();
  _setEngineStatusForTest(null);
});

// ---------------------------------------------------------------------------
// C4 Task 8 — client-side gate modal + one-click install, runtime-enable
// warn banner (server-rendered contract: data attributes for the client
// mirror, friendly banners instead of raw error/warn values, the zero-
// backtick client script invariant).
// ---------------------------------------------------------------------------

const layout = ({ content }) => content;

function mkGetReq(query) {
  return { method: "GET", query, body: {}, cookies: {}, headers: {} };
}
function mkSendRes() {
  const res = { html: null, redirected: null };
  res.send = (s) => { res.html = s; return res; };
  res.redirectAfterPost = (url) => { res.redirected = url; };
  return res;
}

test("gateways tab render: complete gmail record + engine absent → form armed with channels + required-fields data attributes", async () => {
  _setEngineStatusForTest({ state: "absent" });
  const res = mkSendRes();
  const req = mkGetReq({ bot: "gate-bot", tab: "gateways" });
  await renderBotEditor(req, res, { db, layout, lang: "en", PAGE_CSS: "", botId: "gate-bot", notice: "", q: req.query });
  assert.match(res.html, /id="btb-gateways-form"[^>]*data-engine-gate="1"/, "form must carry the gate attribute");
  assert.match(res.html, /data-engine-channels="gmail,discord,telegram,slack"/, "channels list must mirror ENGINE_CHANNELS");
  assert.match(res.html, /data-engine-required-fields="gw_address,gw_allowlist"/, "required DOM field names for gmail");
  assert.match(res.html, /window\.__crowEngineGateOpen/, "stable hook for the Task 9 readiness row must be present");
  assert.match(res.html, /id="engine-gate-modal-overlay"/, "modal overlay markup must ship on the page");
});

test("gateways tab render: engine ready → NOT armed (no data-engine-gate attribute anywhere)", async () => {
  _setEngineStatusForTest({ state: "ready", source: "env", cliPath: "/fake/cli.js" });
  const res = mkSendRes();
  const req = mkGetReq({ bot: "gate-bot", tab: "gateways" });
  await renderBotEditor(req, res, { db, layout, lang: "en", PAGE_CSS: "", botId: "gate-bot", notice: "", q: req.query });
  assert.ok(!/data-engine-gate="1"/.test(res.html), "must not arm the client gate while the engine is ready");
  // The overlay/hook still ship (Task 9's readiness row may still want the
  // hook even when this particular tab isn't gated) but the script itself
  // is unconditional — only the FORM's data attribute is state-dependent.
  assert.match(res.html, /window\.__crowEngineGateOpen/);
});

test("gateways tab render: engine absent but gwType is crow-messages (not an ENGINE_CHANNELS type) → NOT armed", async () => {
  await db.execute({
    sql: "UPDATE pi_bot_defs SET definition=? WHERE bot_id='gate-bot'",
    args: [JSON.stringify({ gateways: [{ type: "crow-messages", allow_paired_instances: true }], tools: {}, models: {} })],
  });
  _setEngineStatusForTest({ state: "absent" });
  const res = mkSendRes();
  const req = mkGetReq({ bot: "gate-bot", tab: "gateways" });
  await renderBotEditor(req, res, { db, layout, lang: "en", PAGE_CSS: "", botId: "gate-bot", notice: "", q: req.query });
  assert.ok(!/data-engine-gate="1"/.test(res.html), "crow-messages is never a gated channel type");
});

test("bot-builder panel: error=engine_required renders a friendly banner + Install button, never the raw query value", async () => {
  _setEngineStatusForTest({ state: "absent" });
  const res = mkSendRes();
  const req = mkGetReq({ bot: "gate-bot", tab: "gateways", error: "engine_required" });
  await botBuilderPanel.handler(req, res, { db, layout, lang: "en" });
  assert.ok(!res.html.includes(">engine_required<"), "must never leak the raw query value as visible text");
  assert.match(res.html, /class="btb-notice-err"/, "renders as an error notice");
  assert.match(res.html, /id="engine-gate-open-btn"/, "renders the Install bot engine button");
  assert.doesNotMatch(res.html, /needs the bot engine.*undefined/i);
});

test("bot-builder panel: warn=bot_runtime_off renders a friendly banner + one-click enable button, never the raw query value", async () => {
  _setEngineStatusForTest({ state: "ready", source: "env", cliPath: "/fake/cli.js" });
  const res = mkSendRes();
  const req = mkGetReq({ bot: "gate-bot", tab: "gateways", warn: "bot_runtime_off" });
  await botBuilderPanel.handler(req, res, { db, layout, lang: "en" });
  assert.ok(!res.html.includes(">bot_runtime_off<"), "must never leak the raw query value as visible text");
  assert.match(res.html, /class="btb-notice-warn"/, "renders as a warn notice");
  assert.match(res.html, /id="bot-runtime-enable-btn"/, "renders the one-click enable button");
  assert.match(res.html, /id="bot-runtime-enable-status"/, "renders a status span for the async enable result");
});

test("bot-builder panel: an unrelated error value still renders raw (no regression to the generic fallback)", async () => {
  _setEngineStatusForTest({ state: "ready", source: "env", cliPath: "/fake/cli.js" });
  const res = mkSendRes();
  const req = mkGetReq({ bot: "gate-bot", tab: "gateways", error: "unknown_bot" });
  await botBuilderPanel.handler(req, res, { db, layout, lang: "en" });
  assert.match(res.html, />unknown_bot</, "generic fallback still renders the raw value verbatim");
  assert.ok(!/id="engine-gate-open-btn"/.test(res.html), "the engine-gate banner (with its button) must not render for an unrelated error");
});

test("engine-gate-client.js: zero literal backtick characters inside the emitted <script> block", () => {
  const src = readFileSync(join(new URL("..", import.meta.url).pathname, "servers/gateway/dashboard/panels/bot-builder/engine-gate-client.js"), "utf8");
  const scriptStart = src.indexOf("<script>", src.indexOf("function engineGateClientJS"));
  const scriptEnd = src.indexOf("</script>", scriptStart);
  assert.ok(scriptStart > -1 && scriptEnd > scriptStart, "could not locate the client <script> block");
  const body = src.slice(scriptStart + "<script>".length, scriptEnd);
  const backtickCount = (body.match(/`/g) || []).length;
  assert.equal(backtickCount, 0, "a literal backtick inside the client <script> block would break the whole dashboard");
});

test("engine-gate-client.js: emitted script is syntactically valid JS and exposes the stable hook", async () => {
  const { engineGateClientJS } = await import("../servers/gateway/dashboard/panels/bot-builder/engine-gate-client.js");
  const out = engineGateClientJS("en");
  const s = out.indexOf("<script>") + "<script>".length;
  const e = out.indexOf("</script>");
  const js = out.slice(s, e);
  assert.doesNotThrow(() => new Function(js), "emitted client JS must parse without a SyntaxError");
  assert.match(js, /window\.__crowEngineGateOpen\s*=\s*function/, "must define the stable hook Task 9 will call");
  assert.match(js, /bundle_id:\s*BUNDLE_ID/, "install POST must target bot-engine");
  assert.match(js, /already_installing/, "must handle the 409 already_installing adopt-job-id path");
});
