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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
