/**
 * Attaching the Perch channel while the perch-hub bundle is NOT installed
 * (Perch Hub Phase 1, acceptance finding D2).
 *
 * The C-10 acceptance round found the honest hole: with perch-hub uninstalled
 * the Bot Builder still offers "Perch (dashboard chat)", the save succeeds
 * silently, `POST /dashboard/perch-api/bots/:id/turn` still 202s and spawns
 * pi — and there is no surface anywhere on which to read the reply, because
 * the lens IS the bundle. A channel you can attach and talk to, with the
 * answer going nowhere visible.
 *
 * The fix is a WARN, not a block — the plan's own words ("gateway attach
 * warns"), and the C4 `warn=bot_runtime_off` banner is the precedent this
 * copies: the save still succeeds, and the page tells the truth with a
 * one-click install beside it.
 *
 * What this file proves:
 *   • the warn is raised on BOTH save surfaces (gateways tab AND wizard
 *     create — the C-4 lesson this arc keeps re-learning is that gating one
 *     surface leaves a hole), and the definition is SAVED either way;
 *   • the signal is `perchInstalled()`'s disk truth at call time, so an
 *     installed-but-not-running Perch (the restart window every webUI bundle
 *     install goes through) does NOT warn;
 *   • non-perch channels never raise it;
 *   • the banner renders friendly copy plus a real install affordance, and
 *     stacks correctly with `warn=bot_runtime_off` (two warns on one save
 *     means express hands the panel an ARRAY);
 *   • the banner's client script actually POSTs the perch-hub install job,
 *     drives the restart a webUI bundle always needs, and comes back to a
 *     URL with the now-false warning stripped;
 *   • EN + ES copy exists for every new string (the global parity gate).
 */
import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHTML } from "linkedom";

// BOTH CROW_DATA_DIR and CROW_HOME are pinned before anything is imported:
// `scripts/init-db.js` without CROW_DATA_DIR writes the LIVE ~/.crow/data
// database, and perchInstalled() without CROW_HOME reads the LIVE ~/.crow
// bundle tree (C-7 finding #1 — this happened once already this arc).
const scratchRoot = mkdtempSync(join(tmpdir(), "perch-attach-warn-"));
const dataDir = join(scratchRoot, "data");
mkdirSync(dataDir, { recursive: true });
process.env.CROW_DATA_DIR = dataDir;
process.env.CROW_HOME = join(scratchRoot, "home-initial");
mkdirSync(process.env.CROW_HOME, { recursive: true });

let db = null;
let handleBotBuilderPost = null;
let _setEngineStatusForTest = null;
let _setBotRuntimeStatusForTest = null;
let handleWizardCreate = null;
let botBuilderPanel = null;
let translations = null;
let writeSetting = null;

const ENGINE_READY = { state: "ready", source: "env", cliPath: "/fake/cli.js" };

/** A CROW_HOME with (or without) the vendored payload entrypoint on disk —
 * the exact file `perchInstalled()` and `initPerchRuntime` both gate on. */
function makeCrowHome({ installed = false } = {}) {
  const home = mkdtempSync(join(scratchRoot, "crowhome-"));
  if (installed) {
    const hubDir = join(home, "bundles", "perch-hub", "payload", "hub");
    mkdirSync(hubDir, { recursive: true });
    writeFileSync(join(hubDir, "server.mjs"), "// vendored hub stub\n");
  }
  return home;
}

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dataDir, CROW_HOME: process.env.CROW_HOME },
    stdio: "pipe",
    cwd: new URL("..", import.meta.url).pathname,
  });
  const { createDbClient } = await import("../servers/db.js");
  db = createDbClient();
  ({ handleBotBuilderPost, _setEngineStatusForTest, _setBotRuntimeStatusForTest } =
    await import("../servers/gateway/dashboard/panels/bot-builder/api-handlers.js"));
  ({ handleWizardCreate } = await import("../servers/gateway/dashboard/panels/bot-builder/wizard.js"));
  ({ default: botBuilderPanel } = await import("../servers/gateway/dashboard/panels/bot-builder.js"));
  ({ translations } = await import("../servers/gateway/dashboard/shared/i18n.js"));
  ({ writeSetting } = await import("../servers/gateway/dashboard/settings/registry.js"));
});

after(async () => {
  try { db && db.close && db.close(); } catch {}
  rmSync(scratchRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  _setEngineStatusForTest(ENGINE_READY);
  // The runtime-disarmed warn is a SEPARATE signal (C4); pin it off so these
  // cases assert on the perch warn alone. One test flips it on deliberately.
  _setBotRuntimeStatusForTest(null);
  await db.execute({
    sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES (?,?,?,1) " +
      "ON CONFLICT(bot_id) DO UPDATE SET definition=excluded.definition",
    args: ["warn-bot", "Warn Bot", JSON.stringify({ gateways: [], tools: {}, models: {} })],
  });
  await writeSetting(db, "feature_flags", JSON.stringify({}), { scope: "local" });
});

afterEach(() => {
  _setEngineStatusForTest(null);
  _setBotRuntimeStatusForTest(null);
});

function mkRes() {
  const res = { redirected: null, html: null };
  res.redirectAfterPost = (url) => { res.redirected = url; };
  res.send = (s) => { res.html = s; return res; };
  return res;
}

const readDef = async (botId = "warn-bot") =>
  JSON.parse((await db.execute({ sql: "SELECT definition FROM pi_bot_defs WHERE bot_id=?", args: [botId] })).rows[0].definition);

// ---------------------------------------------------------------------------
// 1. The gateways-tab save surface
// ---------------------------------------------------------------------------

test("perch attach with the bundle absent → the save SUCCEEDS and carries warn=perch_not_installed", async () => {
  process.env.CROW_HOME = makeCrowHome({ installed: false });
  const res = mkRes();
  await handleBotBuilderPost(
    { body: { action: "save_gateways", bot_id: "warn-bot", gw_type: "perch" } },
    res, { db },
  );
  assert.match(res.redirected, /saved=1/, "the warn must never block the save: " + res.redirected);
  assert.match(res.redirected, /warn=perch_not_installed/, "no warning was raised: " + res.redirected);
  assert.deepEqual((await readDef()).gateways, [{ type: "perch" }],
    "the perch record must persist exactly as it does with the bundle installed");
});

test("perch attach with the bundle INSTALLED but the hub not running → no warn (installed-but-restarting is not a defect)", async () => {
  // A webUI bundle install always ends in a gateway restart (C-3), so
  // "installed, supervisor has never seen it" is a normal window. Keying the
  // warn off the supervisor's running state would nag through every one.
  process.env.CROW_HOME = makeCrowHome({ installed: true });
  const res = mkRes();
  await handleBotBuilderPost(
    { body: { action: "save_gateways", bot_id: "warn-bot", gw_type: "perch" } },
    res, { db },
  );
  assert.match(res.redirected, /saved=1/);
  assert.equal(res.redirected.includes("perch_not_installed"), false,
    "an installed Perch must never be reported as missing: " + res.redirected);
});

test("a non-perch channel never raises the perch warn, bundle present or not", async () => {
  process.env.CROW_HOME = makeCrowHome({ installed: false });
  const res = mkRes();
  await handleBotBuilderPost(
    { body: { action: "save_gateways", bot_id: "warn-bot", gw_type: "gmail", gw_address: "b@x.com", gw_allowlist: "a@b.c" } },
    res, { db },
  );
  assert.match(res.redirected, /saved=1/);
  assert.equal(res.redirected.includes("perch_not_installed"), false, res.redirected);
});

test("clearing the channel back to none drops the warn (it is a property of the SAVED record, not of the host)", async () => {
  process.env.CROW_HOME = makeCrowHome({ installed: false });
  const res = mkRes();
  await handleBotBuilderPost(
    { body: { action: "save_gateways", bot_id: "warn-bot", gw_type: "none" } },
    res, { db },
  );
  assert.match(res.redirected, /saved=1/);
  assert.equal(res.redirected.includes("perch_not_installed"), false, res.redirected);
});

// ---------------------------------------------------------------------------
// 2. The wizard-create save surface (the C-4 "gate BOTH surfaces" lesson)
// ---------------------------------------------------------------------------

test("wizard create with the perch channel and no bundle → bot IS created, redirect carries the warn", async () => {
  process.env.CROW_HOME = makeCrowHome({ installed: false });
  await db.execute({
    sql: "INSERT INTO providers (id, base_url, models, disabled) VALUES (?,?,?,0)",
    args: ["warnprov", "http://127.0.0.1:9999/v1", JSON.stringify([{ id: "m1" }])],
  });
  try {
    const res = mkRes();
    await handleWizardCreate({ body: {
      action: "wizard_create", nav: "create",
      tpl: "discord-qa", display_name: "Wiz Warn Bot", bot_id: "wiz-warn-bot",
      model: "warnprov/m1", gw_type: "perch",
    } }, res, { db, lang: "en" });
    assert.match(res.redirected, /created=wiz-warn-bot/, "the wizard must still create the bot: " + res.redirected);
    assert.match(res.redirected, /warn=perch_not_installed/,
      "the wizard is the OTHER save surface — gating one leaves a hole: " + res.redirected);
    assert.deepEqual((await readDef("wiz-warn-bot")).gateways, [{ type: "perch" }]);
  } finally {
    await db.execute({ sql: "DELETE FROM providers", args: [] });
    await db.execute({ sql: "DELETE FROM pi_bot_defs WHERE bot_id='wiz-warn-bot'", args: [] });
  }
});

test("wizard create with the perch channel and the bundle installed → no warn", async () => {
  process.env.CROW_HOME = makeCrowHome({ installed: true });
  await db.execute({
    sql: "INSERT INTO providers (id, base_url, models, disabled) VALUES (?,?,?,0)",
    args: ["warnprov", "http://127.0.0.1:9999/v1", JSON.stringify([{ id: "m1" }])],
  });
  try {
    const res = mkRes();
    await handleWizardCreate({ body: {
      action: "wizard_create", nav: "create",
      tpl: "discord-qa", display_name: "Wiz OK Bot", bot_id: "wiz-ok-bot",
      model: "warnprov/m1", gw_type: "perch",
    } }, res, { db, lang: "en" });
    assert.match(res.redirected, /created=wiz-ok-bot/);
    assert.equal(res.redirected.includes("perch_not_installed"), false, res.redirected);
  } finally {
    await db.execute({ sql: "DELETE FROM providers", args: [] });
    await db.execute({ sql: "DELETE FROM pi_bot_defs WHERE bot_id='wiz-ok-bot'", args: [] });
  }
});

// ---------------------------------------------------------------------------
// 3. The rendered banner
// ---------------------------------------------------------------------------

function mkGetReq(query) {
  return { method: "GET", query, body: {}, cookies: {}, headers: {} };
}
const layout = ({ content }) => content;

async function renderPanel(query, lang = "en") {
  const res = mkRes();
  await botBuilderPanel.handler(mkGetReq(query), res, { db, layout, lang });
  return res.html;
}

test("warn=perch_not_installed renders friendly copy plus a one-click install button, never the raw query value", async () => {
  process.env.CROW_HOME = makeCrowHome({ installed: false });
  const html = await renderPanel({ bot: "warn-bot", tab: "gateways", saved: "1", warn: "perch_not_installed" });
  assert.ok(!html.includes(">perch_not_installed<"), "must never leak the raw query value as visible text");
  assert.ok(html.includes(translations["botbuilder.perchMissingBody"].en), "the honest explanation is missing");
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  assert.equal(document.querySelectorAll("#perch-install-btn").length, 1,
    "the warning must carry an install affordance — a warning with no fix is just a scold");
  assert.equal(document.querySelectorAll("#perch-install-status").length, 1,
    "the install client needs its status line");
  assert.match(html, /class="btb-notice-warn"/, "renders as a WARNING, not an error (the save succeeded)");
});

test("the banner is not rendered when there is no perch warn", async () => {
  process.env.CROW_HOME = makeCrowHome({ installed: false });
  const html = await renderPanel({ bot: "warn-bot", tab: "gateways", saved: "1" });
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  assert.equal(document.querySelectorAll("#perch-install-btn").length, 0,
    "an ordinary save must not sprout an install button");
  assert.ok(!html.includes(translations["botbuilder.perchMissingBody"].en));
});

test("both warns on one save render BOTH banners (express hands a repeated ?warn= through as an array)", async () => {
  process.env.CROW_HOME = makeCrowHome({ installed: false });
  const html = await renderPanel({
    bot: "warn-bot", tab: "gateways", saved: "1",
    warn: ["bot_runtime_off", "perch_not_installed"],
  });
  assert.ok(html.includes(translations["botbuilder.runtimeOffBannerBody"].en),
    "the runtime-off warning was swallowed by the perch one");
  assert.ok(html.includes(translations["botbuilder.perchMissingBody"].en),
    "the perch warning was swallowed by the runtime-off one");
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  assert.equal(document.querySelectorAll("#bot-runtime-enable-btn").length, 1);
  assert.equal(document.querySelectorAll("#perch-install-btn").length, 1);
});

test("an arbitrary warn string still renders escaped as before (no regression from the array handling)", async () => {
  process.env.CROW_HOME = makeCrowHome({ installed: false });
  const html = await renderPanel({ bot: "warn-bot", tab: "gateways", warn: "device binding incomplete: <boom>" });
  assert.ok(html.includes("device binding incomplete: &lt;boom&gt;"),
    "free-form warn text must still reach the page, escaped");
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  assert.equal(document.querySelectorAll("boom").length, 0);
});

test("Spanish renders Spanish copy for the perch warning", async () => {
  process.env.CROW_HOME = makeCrowHome({ installed: false });
  const html = await renderPanel({ bot: "warn-bot", tab: "gateways", warn: "perch_not_installed" }, "es");
  assert.ok(html.includes(translations["botbuilder.perchMissingBody"].es), "the banner is not translated");
  assert.deepEqual(html.match(/botbuilder\.perchMissing[A-Za-z0-9]*/g) || [], [],
    "a raw i18n key leaked into the page");
});

test("every new botbuilder.perch* key resolves to real en + es copy", () => {
  const keys = Object.keys(translations).filter((k) => /^botbuilder\.perchMissing/.test(k));
  assert.ok(keys.length >= 1, "expected at least one botbuilder.perchMissing* key");
  for (const k of keys) {
    assert.ok(translations[k].en, `${k} has no en copy`);
    assert.ok(translations[k].es, `${k} has no es copy`);
  }
});

// ---------------------------------------------------------------------------
// 4. The banner's install client, executed for real
// ---------------------------------------------------------------------------

/** Mount the REAL rendered banner (markup + its script) in linkedom and run
 * the script — so a banner whose button is wired to nothing goes red here. */
async function bootBannerClient({ href = "https://crow.test/dashboard/bot-builder?bot=warn-bot&tab=gateways&saved=1&warn=perch_not_installed" } = {}) {
  process.env.CROW_HOME = makeCrowHome({ installed: false });
  const pageHtml = await renderPanel({ bot: "warn-bot", tab: "gateways", saved: "1", warn: "perch_not_installed" });
  const { window, document } = parseHTML(`<html><body>${pageHtml}</body></html>`);
  const script = [...document.querySelectorAll("script")]
    .map((s) => s.textContent)
    .find((s) => s.includes("perch-install-btn"));
  assert.ok(script, "the banner shipped no client script — the install button would be inert");

  const calls = [];
  const timers = [];
  const location = { href, reloads: 0, reload() { location.reloads += 1; } };
  let fetchImpl = null;
  const fetchStub = (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), init, body });
    const result = fetchImpl
      ? fetchImpl(String(url), init)
      : { ok: true, status: 200, json: () => Promise.resolve({}) };
    return Promise.resolve(result);
  };
  const ctx = vm.createContext({
    window, document, location, console, URL,
    fetch: fetchStub,
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
    setInterval: () => 0,
  });
  vm.runInContext(script, ctx);

  const btn = document.getElementById("perch-install-btn");
  return {
    document, btn, calls, location,
    click: () => btn.dispatchEvent(new window.Event("click", { bubbles: true })),
    settle: async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); },
    flushTimers: () => { timers.splice(0).forEach((fn) => fn()); },
    setFetchImpl: (fn) => { fetchImpl = fn; },
    statusText: () => document.getElementById("perch-install-status").textContent,
  };
}

test("banner client: clicking install POSTs the perch-hub bundle-install job", async () => {
  const g = await bootBannerClient();
  g.setFetchImpl(() => ({ ok: true, status: 200, json: () => Promise.resolve({ job_id: "job-1" }) }));
  g.click();
  await g.settle();
  const install = g.calls.find((c) => c.url.endsWith("/dashboard/bundles/api/install"));
  assert.ok(install, "no install call was made — the affordance is the whole point of the warning");
  assert.deepEqual(install.body, { bundle_id: "perch-hub", env_vars: {} });
  assert.equal(g.btn.disabled, true, "the button must disarm while the job runs");
});

test("banner client: after the install and the restart, the page comes back WITHOUT the now-false warning", async () => {
  const g = await bootBannerClient();
  g.setFetchImpl((url) => {
    if (url.endsWith("/install")) return { ok: true, status: 200, json: () => Promise.resolve({ job_id: "job-2" }) };
    if (url.includes("/jobs/")) return { ok: true, status: 200, json: () => Promise.resolve({ status: "complete_restart", log: ["installed"] }) };
    return { ok: true, status: 200, json: () => Promise.resolve({}) };
  });
  g.click();
  await g.settle();
  assert.ok(g.calls.find((c) => c.url.endsWith("/dashboard/bundles/api/restart")),
    "a webUI bundle needs a gateway restart (C-3)");
  g.flushTimers();
  await g.settle();
  assert.ok(g.calls.find((c) => c.url === "/health"), "the client must wait for the gateway to come back");
  await g.settle();
  assert.equal(g.location.href.includes("warn=perch_not_installed"), false,
    "reloading straight back onto the stale warning would re-scold about a bundle that is now installed: " + g.location.href);
  assert.match(g.location.href, /bot=warn-bot/, "the operator must land back on the same bot");
});

test("banner client: a failed install re-arms the button and shows why", async () => {
  const g = await bootBannerClient();
  g.setFetchImpl((url) => {
    if (url.endsWith("/install")) return { ok: true, status: 200, json: () => Promise.resolve({ job_id: "job-3" }) };
    return { ok: true, status: 200, json: () => Promise.resolve({ status: "failed", log: ["no disk space"] }) };
  });
  g.click();
  await g.settle();
  assert.equal(g.btn.disabled, false, "a failed install must leave the operator able to retry");
  assert.ok(g.statusText().includes("no disk space"), g.statusText());
});
