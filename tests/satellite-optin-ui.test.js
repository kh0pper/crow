/**
 * SAT-7 part B, the Bot Builder half: the per-bot "Also on other people's turns" opt-in
 * (`servers/gateway/dashboard/panels/bot-builder/tab-safety.js` + save-handlers.js saveSafety).
 * It is stored in `satellite_bot_optins` (migration 0021), is shown only when this Crow hosts a
 * satellite bundle, carries the ruling's warning in both languages, and is never a grant.
 *
 * A scratch Crow home + init-db database, the real Safety tab renderer with its tool probe pinned
 * (sources._setSourcesForTest), the real save handler and the real change tracker.
 */
import { test, before, after, beforeEach } from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { rmScratch } from "./helpers/safe-rm.js";

const HOME = mkdtempSync(join(tmpdir(), "crow-satoptin-home-"));
const DATA = mkdtempSync(join(tmpdir(), "crow-satoptin-data-"));
const DB_PATH = join(DATA, "crow.db");
const saved = { CROW_HOME: process.env.CROW_HOME, CROW_DATA_DIR: process.env.CROW_DATA_DIR, CROW_DB_PATH: process.env.CROW_DB_PATH };
process.env.CROW_HOME = HOME;
process.env.CROW_DATA_DIR = DATA;
process.env.CROW_DB_PATH = DB_PATH;

const { createDbClient } = await import("../servers/db.js");
const { renderSafety } = await import("../servers/gateway/dashboard/panels/bot-builder/tab-safety.js");
const { saveSafety, applySatelliteOptin } = await import("../servers/gateway/dashboard/panels/bot-builder/save-handlers.js");
const { handleBotBuilderPost } = await import("../servers/gateway/dashboard/panels/bot-builder/api-handlers.js");
const { changeTracker } = await import("../servers/gateway/dashboard/panels/bot-builder/ui.js");
const { _setSourcesForTest } = await import("../servers/gateway/dashboard/panels/bot-builder/sources.js");
const { getBotOptin } = await import("../servers/gateway/satellites/store.js");
const { translations } = await import("../servers/gateway/dashboard/shared/i18n.js");

const BOT = "b1";
// The ruling's copy with the installed bundles' own display names filled in (F5).
const warnText = (lang, bundles) => translations["botbuilder.sfSatAnyTurnWarn"][lang].split("{bundles}").join(bundles);
const WARNING_EN = warnText("en", "Gitea");
let db;

const ctx = (lang = "en") => ({ db, def: { tools: { crow_mcp: [] }, permission_policy: {} }, botId: BOT, lang, hidden: (tab) => `<input type="hidden" name="tab" value="${tab}">`, crowHome: HOME });
const installSatellite = (list) => writeFileSync(join(HOME, "installed.json"), JSON.stringify(list));
const mkRes = () => {
  const res = { html: null, redirected: null };
  res.send = (s) => { res.html = s; return res; };
  res.redirectAfterPost = (url) => { res.redirected = url; };
  return res;
};
/** The real POST handler, the way the browser drives it. */
// A request from the owner's own local password session (the only one that may change a bot's
// satellite opt-in), or from a peer's SSO sign-in (which may not). A client address that is not
// this machine's, so the self-origin rule does not apply.
const OWNER_SESS = "owner-sess-satoptin", SSO_SESS = "sso-sess-satoptin";
const hashTok = (t) => createHash("sha256").update(t).digest("hex");
const post = async (body, { session = OWNER_SESS } = {}) => {
  const res = mkRes();
  const req = { body: { action: "save_safety", bot_id: BOT, ...body }, headers: {}, cookies: {}, dashboardSession: session, socket: { remoteAddress: "100.64.20.5" }, ip: "100.64.20.5" };
  await handleBotBuilderPost(req, res, { db });
  return res;
};

before(async () => {
  assert.ok(process.env.CROW_SUITE_SCRATCH, "runs only in the scratch suite env");
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: process.env, stdio: "pipe", cwd: join(import.meta.dirname, "..") });
  db = createDbClient(DB_PATH);
  for (const [tok, scopes] of [[OWNER_SESS, "dashboard"], [SSO_SESS, "dashboard sso src:instance-peer"]]) {
    await db.execute({ sql: "INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at, created_at) VALUES (?, 'access', 'dashboard', ?, datetime('now','+1 day'), datetime('now'))", args: [hashTok(tok), scopes] });
  }
  // No MCP probe on a page render: the tool sources are pinned.
  _setSourcesForTest({ error: null, sources: [] });
});

after(() => {
  _setSourcesForTest(null);
  try { db?.close(); } catch { /* closed */ }
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const d of [HOME, DATA]) rmScratch(d);
});

beforeEach(async () => {
  installSatellite([]);
  try { await db.execute({ sql: "DELETE FROM satellite_bot_optins", args: [] }); } catch { /* not migrated */ }
  // The bot row the POST handler saves into (a real def, as Bot Builder created it).
  try { await db.execute({ sql: "DELETE FROM pi_bot_defs WHERE bot_id = ?", args: [BOT] }); } catch { /* not migrated */ }
  await db.execute({
    sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES (?,?,?,1)",
    args: [BOT, "B1", JSON.stringify({ tools: { crow_mcp: [] }, permission_policy: { bash: "deny", write_paths: [] } })],
  });
});

test("no satellite bundle installed: no opt-in control at all (a local-only Crow never sees it)", async () => {
  const html = await renderSafety(ctx());
  assert.ok(!html.includes("sat_any_turn"), html);
  for (const lang of ["en", "es"]) assert.ok(!html.includes(translations["botbuilder.sfSatAnyTurn"][lang]), lang);
});

test("a satellite bundle installed: the toggle and the warning, in the reader's language", async () => {
  installSatellite([{ id: "gitea", mode: "satellite", host: "sat-alpha-0001", version: "1.0.0" }]);
  const en = await renderSafety(ctx("en"));
  assert.ok(en.includes('name="sat_any_turn"'), "the control");
  assert.ok(en.includes("Also on other people&#39;s turns") || en.includes("Also on other people's turns"), "the label");
  assert.ok(en.includes(warnText("en", "Gitea")), "the warning names the installed bundle: " + warnText("en", "Gitea"));
  assert.ok(en.includes('id="sf-sat-warn" hidden'), "hidden while the box is off");
  assert.ok(en.includes('name="sat_any_turn_rendered"'), "the save knows the page had the control");
  assert.ok(en.includes('data-warn="sf-sat-warn"'), "the inline script only un-hides the rendered paragraph");
  const es = await renderSafety(ctx("es"));
  assert.ok(es.includes(warnText("es", "Gitea")), "the Spanish warning");
});

// F5: the warning never says "Gitea" whatever is installed; it names the installed bundles.
test("F5: the warning names the installed satellite bundles, one or several, in both languages", async () => {
  // The rest of the sentence is word for word: only the name is a placeholder.
  assert.equal(translations["botbuilder.sfSatAnyTurnWarn"].en,
    "{bundles} tools will also run on turns started by other people (email, Discord). They can ask this bot to change your repositories.");
  assert.equal(translations["botbuilder.sfSatAnyTurnWarn"].es,
    "Las herramientas de {bundles} también funcionarán en turnos iniciados por otras personas (correo, Discord). Podrán pedir a este bot que cambie tus repositorios.");
  // One bundle that is not Gitea: its own display name (from the bundle's manifest).
  const browserName = JSON.parse(readFileSync(new URL("../bundles/browser/manifest.json", import.meta.url), "utf8")).name;
  installSatellite([{ id: "browser", mode: "satellite", host: "sat-alpha-0001", version: "1.0.0" }]);
  let en = await renderSafety(ctx("en"));
  assert.ok(en.includes(warnText("en", browserName)), "the installed bundle's display name");
  assert.ok(!en.includes(warnText("en", "Gitea")), "never Gitea by default");
  // Two of them: both names, joined as a reader's list.
  installSatellite([
    { id: "gitea", mode: "satellite", host: "sat-alpha-0001", version: "1.0.0" },
    { id: "browser", mode: "satellite", host: "sat-alpha-0001", version: "1.0.0" },
  ]);
  en = await renderSafety(ctx("en"));
  assert.ok(en.includes(warnText("en", "Gitea and " + browserName)), "both names, in order");
  const es = await renderSafety(ctx("es"));
  assert.ok(es.includes(warnText("es", "Gitea y " + browserName)), "both names in Spanish");
});

test("turned on: the warning is rendered visible, and the checkbox is checked", async () => {
  installSatellite([{ id: "gitea", mode: "satellite", host: "sat-alpha-0001", version: "1.0.0" }]);
  await db.execute({ sql: "INSERT INTO satellite_bot_optins (bot_id, any_turn) VALUES (?, 1)", args: [BOT] });
  const html = await renderSafety(ctx());
  assert.ok(html.includes('id="sf-sat-any" data-warn="sf-sat-warn" checked'), "checked");
  assert.ok(html.includes('id="sf-sat-warn">'), "not hidden");
});

test("saveSafety returns the wanted opt-in but writes nothing itself (F3: the POST writes it after the def lands)", async () => {
  const r = await saveSafety({ tools: {}, permission_policy: {} }, { sat_any_turn: "on", sat_any_turn_rendered: "1", tab: "safety" },
    { lang: "en", db, botId: BOT, changed: changeTracker({}) });
  assert.equal(r.satOptin, true, "the wanted value comes back");
  assert.equal(await getBotOptin(db, BOT), false, "nothing is written here");
  // The page had no control: no value to write at all.
  const none = await saveSafety({ tools: {}, permission_policy: {} }, { sat_any_turn: "on", tab: "safety" },
    { lang: "en", db, botId: BOT, changed: changeTracker({}) });
  assert.equal(none.satOptin, undefined);
  // applySatelliteOptin is the writer, on change only.
  assert.deepEqual((await applySatelliteOptin({ db, botId: BOT, want: true, lang: "en" })).warn, []);
  assert.equal(await getBotOptin(db, BOT), true);
  assert.deepEqual((await applySatelliteOptin({ db, botId: BOT, want: true, lang: "en" })).warn, [], "no-op when unchanged");
  assert.equal(await getBotOptin(db, BOT), true);
  await applySatelliteOptin({ db, botId: BOT, want: false, lang: "en" });
  assert.equal(await getBotOptin(db, BOT), false);
});

// F3: the opt-in is never switched on by a save that was refused.
test("F3: a save refused for a bad read path leaves the opt-in off", async () => {
  installSatellite([{ id: "gitea", mode: "satellite", host: "sat-alpha-0001", version: "1.0.0" }]);
  const res = await post({ sat_any_turn: "on", sat_any_turn_rendered: "1", pp_read_paths: "Documents" });
  assert.match(res.redirected, /error=/, res.redirected);
  assert.match(decodeURIComponent(res.redirected), /absolute paths/);
  assert.equal(await getBotOptin(db, BOT), false, "a refused save turns nothing on");
  // The same post with a valid path: saved, and the opt-in follows the saved def.
  const ok = await post({ sat_any_turn: "on", sat_any_turn_rendered: "1", pp_read_paths: "/home/u/notes" });
  assert.match(ok.redirected, /saved=1/, ok.redirected);
  assert.equal(await getBotOptin(db, BOT), true);
});

test("the opt-in is not a grant: saving it never touches the bot's tool list", async () => {
  const def = { tools: { crow_mcp: ["crow-memory/crow_recall"] }, permission_policy: {} };
  const r = await saveSafety(def, { sat_any_turn: "on", sat_any_turn_rendered: "1", tab: "safety" }, { lang: "en", db, botId: BOT, changed: changeTracker({}) });
  await applySatelliteOptin({ db, botId: BOT, want: r.satOptin, lang: "en" });
  assert.deepEqual(def.tools.crow_mcp, ["crow-memory/crow_recall"]);
  assert.equal(await getBotOptin(db, BOT), true);
});

test("spec §8: a peer's SSO sign-in can never switch a bot's satellite opt-in on", async () => {
  installSatellite([{ id: "gitea", mode: "satellite", host: "sat-alpha-0001", version: "1.0.0" }]);
  await applySatelliteOptin({ db, botId: BOT, want: false, lang: "en" });
  const res = await post({ sat_any_turn: "on", sat_any_turn_rendered: "1", pp_read_paths: "/home/u/notes" }, { session: SSO_SESS });
  assert.match(res.redirected, /saved=1/, "the rest of the save still lands");
  assert.match(decodeURIComponent(res.redirected), /only be changed from your own sign-in/);
  assert.equal(await getBotOptin(db, BOT), false, "the opt-in stays off");
});

test("spec §8: a non-owner save leaves the bot's satellite grants exactly as they were", async () => {
  const { keepSatelliteGrants } = await import("../servers/gateway/dashboard/panels/bot-builder/api-handlers.js");
  const bundleIds = new Set(["gitea"]);
  const orig = { tools: { crow_mcp: ["crow-memory/crow_recall", "gitea/gitea_list_repos"] } };
  const added = { tools: { crow_mcp: ["crow-memory/crow_recall", "gitea/gitea_list_repos", "gitea/gitea_create_repo", "crow-tasks/x"] } };
  keepSatelliteGrants(added, orig, { bundleIds });
  assert.deepEqual(added.tools.crow_mcp.sort(), ["crow-memory/crow_recall", "crow-tasks/x", "gitea/gitea_list_repos"].sort(), "a new satellite grant is dropped, other changes kept");
  const removed = { tools: { crow_mcp: ["crow-memory/crow_recall"] } };
  keepSatelliteGrants(removed, orig, { bundleIds });
  assert.ok(removed.tools.crow_mcp.includes("gitea/gitea_list_repos"), "a removed satellite grant is put back");
});
