/**
 * SAT-7 part C: the owner grants a bot a satellite bundle's tools in Bot Builder.
 *
 * Bot Builder lists one extra tool SOURCE per satellite-hosted bundle that has an owner-approved
 * pin (servers/gateway/dashboard/panels/bot-builder/sources.js), keyed by the bundle id — the same
 * key the grants (`<bundle>/<tool>` in def.tools.crow_mcp) and the part B mount
 * (satellites/tools-mount.js authorizeSatelliteCall) use. Every tool of such a source is
 * WRITE unless the owner marked that exact tool read against the pinned list, and nothing is ever
 * auto-granted: no default, no template.
 *
 * A scratch Crow home + init-db database, the in-test paired satellite (tests/helpers/
 * fake-satellite-mgmt.js: real pins, real signatures, no socket), the real source loader, the real
 * Abilities/Safety renders, the real save handlers and the real authorize function.
 */
import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmScratch } from "./helpers/safe-rm.js";

const HOME = mkdtempSync(join(tmpdir(), "crow-satbld-home-"));
const DATA = mkdtempSync(join(tmpdir(), "crow-satbld-data-"));
const DB_PATH = join(DATA, "crow.db");
const saved = { CROW_HOME: process.env.CROW_HOME, HOME: process.env.HOME, CROW_DATA_DIR: process.env.CROW_DATA_DIR, CROW_DB_PATH: process.env.CROW_DB_PATH };
process.env.CROW_HOME = HOME;
// An empty home: readCanonicalMcp finds no ~/.pi/agent/mcp.json, so probeAll spawns nothing and
// Bot Builder's only live source here is the satellite.
process.env.HOME = HOME;
process.env.CROW_DATA_DIR = DATA;
process.env.CROW_DB_PATH = DB_PATH;
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";

const { createDbClient } = await import("../servers/db.js");
const store = await import("../servers/gateway/satellites/store.js");
const { authorizeSatelliteCall } = await import("../servers/gateway/satellites/tools-mount.js");
const { loadSources, selectedWriteTools, satelliteReadMarks, sourceDisplay } = await import(
  "../servers/gateway/dashboard/panels/bot-builder/sources.js"
);
const { renderAbilities } = await import("../servers/gateway/dashboard/panels/bot-builder/tab-abilities.js");
const { renderSafety } = await import("../servers/gateway/dashboard/panels/bot-builder/tab-safety.js");
const { saveAbilities, saveSafety } = await import("../servers/gateway/dashboard/panels/bot-builder/save-handlers.js");
const { changeTracker } = await import("../servers/gateway/dashboard/panels/bot-builder/ui.js");
const { applyTemplate, BOT_TEMPLATES } = await import("../servers/gateway/dashboard/panels/bot-builder/templates.js");
const { defaultDefinition } = await import("../servers/gateway/dashboard/panels/bot-builder/data-queries.js");
const ST = await import("../scripts/pi-bots/skill-tools.mjs");
const { translations, fill } = await import("../servers/gateway/dashboard/shared/i18n.js");
const { createMgmtFake, makeSatelliteRow, toolsHash } = await import("./helpers/fake-satellite-mgmt.js");

const BUNDLE = "gitea";
const SAT_NAME = "vps-1-test";
const BOT = "b1";
// gitea_list_repos reads like a lookup (the name rule alone calls it read); gitea_get_repo does
// too. Only the pin's read marks may say so for a satellite-hosted bundle.
const TOOLS = [
  { name: "gitea_list_repos", description: "List repositories", inputSchema: { type: "object", properties: {} } },
  { name: "gitea_get_repo", description: "Get one repository", inputSchema: { type: "object", properties: {} } },
  { name: "gitea_create_issue", description: "Create an issue", inputSchema: { type: "object", properties: { title: { type: "string" } } } },
];
const MARKS = ["gitea_list_repos"];
const BUNDLE_NAME = JSON.parse(readFileSync(new URL(`../bundles/${BUNDLE}/manifest.json`, import.meta.url), "utf8")).name;
const label = (lang = "en") => fill(translations["botbuilder.srcSatelliteOn"][lang], { name: BUNDLE_NAME, host: SAT_NAME });

let db, fake, satId;

const writeInstalled = (list) => writeFileSync(join(HOME, "installed.json"), JSON.stringify(list, null, 2));
const installGitea = () => writeInstalled([{ id: BUNDLE, mode: "satellite", host: satId, version: "1.0.0" }]);
const statusJson = () => JSON.stringify({ v: 1, status: fake.statusBody(), health: null, error: null, alerts: { psi: false, tools: {} } });
const putPin = (marks = MARKS) => store.putToolPin(db, {
  satellite_id: satId, bundle: BUNDLE, version: "1.0.0", tools_sha256: toolsHash(TOOLS),
  tools_json: JSON.stringify(TOOLS), read_marks_json: JSON.stringify(marks), approved_at: "2026-11-01T00:00:00Z",
});
const sourcesNow = async () => (await loadSources({ db, crowHome: HOME })).sources;
const giteaSource = async () => (await sourcesNow()).find((s) => s.server === BUNDLE);
const setDef = (def) => db.execute({
  sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES (?,?,?,1)",
  args: [BOT, "B1", JSON.stringify(def)],
});
const abilitiesCtx = (def, lang = "en") => ({ db, def, lang, hidden: () => "", bot: { display_name: "B1" }, botId: BOT, crowHome: HOME });
const safetyCtx = (def, lang = "en") => ({ db, def, lang, botId: BOT, hidden: () => "", crowHome: HOME });

before(async () => {
  assert.ok(process.env.CROW_SUITE_SCRATCH, "runs only in the scratch suite env");
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: process.env, stdio: "pipe", cwd: join(import.meta.dirname, "..") });
  db = createDbClient(DB_PATH);
  fake = createMgmtFake();
  satId = fake.satId;
  fake.state.tools = { [BUNDLE]: TOOLS };
  fake.state.toolVersion = { [BUNDLE]: "1.0.0" };
  await makeSatelliteRow(db, fake, { name: SAT_NAME });
});

after(() => {
  try { db?.close(); } catch { /* closed */ }
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const d of [HOME, DATA]) rmScratch(d);
});

beforeEach(async () => {
  installGitea();
  await db.execute({ sql: "DELETE FROM satellite_tool_pins", args: [] });
  await putPin();
  await db.execute({ sql: "UPDATE satellites SET status = 'active', revoked_at = NULL, unreachable_since = NULL, last_status_json = ? WHERE id = ?", args: [statusJson(), satId] });
  await db.execute({ sql: "DELETE FROM pi_bot_defs WHERE bot_id = ?", args: [BOT] });
});

afterEach(async () => {
  await db.execute({ sql: "DELETE FROM satellite_tool_pins", args: [] });
});

// ---- the source row ---------------------------------------------------------------------------

test("a pinned satellite bundle is a source: its tools, all write except the read-marked one", async () => {
  const src = await giteaSource();
  assert.ok(src, "the satellite bundle is listed as a tool source");
  assert.equal(src.server, BUNDLE, "keyed by the bundle id — the grants' own key");
  assert.equal(src.satellite, true);
  assert.equal(src.ok, true);
  assert.equal(src.satelliteName, SAT_NAME);
  assert.equal(sourceDisplay(src, "en").name, label("en"), "the name says where it runs");
  assert.equal(sourceDisplay(src, "es").name, label("es"), "…in the reader's language");
  assert.deepEqual(src.catalog.map((t) => [t.name, t.access]), [
    ["gitea_list_repos", "read"],   // the pin's read mark
    ["gitea_get_repo", "write"],    // the name rule would call it read
    ["gitea_create_issue", "write"],
  ]);
  assert.deepEqual([...(await satelliteReadMarks(db, HOME)).get(BUNDLE)], MARKS);
});

test("the Abilities tab offers one satellite row whose ticks carry the grant key", async () => {
  const def = { tools: { crow_mcp: [`${BUNDLE}/gitea_create_issue`], pi_builtin: [] }, skills: [], permission_policy: { bash: "deny" } };
  const html = await renderAbilities(abilitiesCtx(def));
  const row = (html.split(`data-src="${BUNDLE}"`)[1] || "").split("</section>")[0];
  assert.match(row, new RegExp(`name="src__${BUNDLE}"`), "the usual mode control");
  assert.match(row, /value="gitea\/gitea_create_issue" checked/, "the granted tool is ticked");
  assert.match(row, /value="gitea\/gitea_get_repo"/, "every pinned tool is offered");
  assert.ok(row.includes(label("en")), "the row names the satellite it runs on");
});

test("no pin: no source at all (nothing was ever approved)", async () => {
  await db.execute({ sql: "DELETE FROM satellite_tool_pins", args: [] });
  assert.equal(await giteaSource(), undefined);
});

test("a revoked satellite: no source at all", async () => {
  await store.markRevoked(db, satId, new Date().toISOString());
  assert.equal(await giteaSource(), undefined);
});

test("an unreachable satellite: the row still shows, not ok, with a short reason", async () => {
  await db.execute({
    sql: "UPDATE satellites SET status = 'unreachable', unreachable_since = ? WHERE id = ?",
    args: ["2026-11-02T10:00:00Z", satId],
  });
  const src = await giteaSource();
  assert.ok(src, "the row is still listed");
  assert.equal(src.ok, false);
  assert.match(String(src.error), /unreachable since 10:00 UTC/);
  const html = await renderAbilities(abilitiesCtx({ tools: { crow_mcp: [], pi_builtin: [] }, skills: [], permission_policy: { bash: "deny" } }));
  assert.match(html, new RegExp(`data-src="${BUNDLE}"`), "rendered");
  assert.match(html, /10:00 UTC/, "with the reason");
});

// ---- grants -----------------------------------------------------------------------------------

test("selecting a satellite tool writes <bundle>/<tool>, and the mount then grants that bot", async () => {
  const def = { tools: { crow_mcp: [] }, permission_policy: {} };
  const b = {
    src_catalog: JSON.stringify({ [BUNDLE]: [["gitea_list_repos", "read"], ["gitea_get_repo", "write"], ["gitea_create_issue", "write"]] }),
    [`src__${BUNDLE}`]: "custom",
    [`src__${BUNDLE}__was`]: "off",
    [`tool__${BUNDLE}`]: [`${BUNDLE}/gitea_create_issue`],
  };
  const r = await saveAbilities(def, b, { lang: "en", changed: changeTracker(b), crowHome: HOME });
  assert.equal(r.error, undefined, r.error);
  assert.deepEqual(def.tools.crow_mcp, [`${BUNDLE}/gitea_create_issue`]);

  // The store as the POST handler leaves it, then the part B mount's own check.
  await setDef(def);
  const actor = { botId: BOT, scope: "job", principal: "owner", jobId: "job-1" };
  const ok = await authorizeSatelliteCall(db, actor, { sat: satId, bundle: BUNDLE });
  assert.equal(ok.ok, true, `authorize refused: ${ok.code}`);
  assert.deepEqual(ok.ctx.allowedTools, ["gitea_create_issue"]);
  assert.equal(ok.ctx.botId, BOT);

  // A bundle the bot was not granted at all is still refused.
  const none = await authorizeSatelliteCall(db, actor, { sat: satId, bundle: "elsewhere" });
  assert.equal(none.ok, false);
});

test("a new bot and every template default grant no satellite tool", async () => {
  const fresh = defaultDefinition(BOT, null, "stub/m1");
  assert.ok(!fresh.tools.crow_mcp.some((k) => k.startsWith(`${BUNDLE}/`)), JSON.stringify(fresh.tools.crow_mcp));
  // Even a probe surface that (wrongly) offers the satellite's tools changes nothing.
  const available = new Set([...fresh.tools.crow_mcp, "crow-memory/crow_search_memories", `${BUNDLE}/gitea_create_issue`, `${BUNDLE}/gitea_list_repos`]);
  const ctx = { availableMcp: available, availableSkills: [], satelliteBundles: new Set([BUNDLE]) };
  for (const tpl of BOT_TEMPLATES) {
    const def = applyTemplate(defaultDefinition(BOT, null, "stub/m1"), tpl, ctx);
    assert.ok(!def.tools.crow_mcp.some((k) => k.startsWith(`${BUNDLE}/`)), `template ${tpl.id} granted a satellite tool`);
  }
  // A template that DID name a satellite bundle (and an ordinary server) grants the ordinary one only.
  const hostile = { id: "hostile", tools: { crow_mcp: [`${BUNDLE}/gitea_create_issue`, "crow-memory/crow_search_memories"] }, skills: [] };
  const overlaid = applyTemplate(defaultDefinition(BOT, null, "stub/m1"), hostile, ctx);
  assert.ok(overlaid.tools.crow_mcp.includes("crow-memory/crow_search_memories"));
  assert.ok(!overlaid.tools.crow_mcp.some((k) => k.startsWith(`${BUNDLE}/`)), JSON.stringify(overlaid.tools.crow_mcp));
  // …and the same template without the install records is not filtered (the set is what decides).
  const unfiltered = applyTemplate(defaultDefinition(BOT, null, "stub/m1"), hostile, { ...ctx, satelliteBundles: null });
  assert.ok(unfiltered.tools.crow_mcp.includes(`${BUNDLE}/gitea_create_issue`), "the guard is the installed-bundle set");
});

// ---- classification at the other call sites ----------------------------------------------------

test("skill-tools: a satellite source is write-class, whatever the tool name says", async () => {
  const readLookup = [`${BUNDLE}/gitea_list_repos`, `${BUNDLE}/gitea_get_repo`];
  assert.equal(ST.serverInReadMode(readLookup, BUNDLE, { crowHome: HOME }), false, "never Read-only by name");
  assert.equal(ST.unionMayGrant(readLookup, `${BUNDLE}/gitea_get_repo`, { crowHome: HOME }), false);
  // No pins needed for this part: installed.json placing the bundle on a satellite is enough.
  assert.equal(ST.serverInReadMode(readLookup, BUNDLE), false, "the default (no marks) fails closed too");
  assert.equal(ST.isReadTool("gitea_list_repos"), true, "the bare name rule on its own, as the old code called it");
  const opts = ST.satelliteClassifyOpts(BUNDLE, { crowHome: HOME });
  assert.deepEqual(opts, { isSatellite: true, readMarks: [] }, "no marks here — write");
  assert.equal(ST.isReadTool("gitea_list_repos", opts), false);
  // With the owner's marks the marked tool is read again.
  const marked = ST.satelliteClassifyOpts(BUNDLE, { satelliteMarks: await satelliteReadMarks(db, HOME) });
  assert.equal(ST.isReadTool("gitea_list_repos", marked), true);
  assert.equal(ST.isReadTool("gitea_get_repo", marked), false);
  // An ordinary server is untouched by any of this.
  assert.equal(ST.serverInReadMode(["crow-projects/crow_get_source"], "crow-projects", { crowHome: HOME }), true);
});

test("sources.js: a granted satellite tool is write-class for the Safety tab", async () => {
  const marks = await satelliteReadMarks(db, HOME);
  const def = { tools: { crow_mcp: [`${BUNDLE}/gitea_list_repos`, `${BUNDLE}/gitea_get_repo`] } };
  // Without the satellite marks both lookup-shaped names read as "read" (the pre-SAT-7 answer).
  assert.deepEqual(selectedWriteTools(def), []);
  assert.deepEqual(selectedWriteTools(def, null, marks).map((t) => t.name), ["gitea_get_repo"]);
  // …and the catalog the Abilities tab rendered agrees.
  const src = await giteaSource();
  assert.deepEqual(selectedWriteTools(def, { [BUNDLE]: src.catalog }, marks).map((t) => t.name), ["gitea_get_repo"]);
});

// ---- Safety tab ---------------------------------------------------------------------------------

test("a granted satellite tool is on the Safety tab's ask list", async () => {
  const def = { tools: { crow_mcp: [`${BUNDLE}/gitea_create_issue`] }, permission_policy: {} };
  const html = await renderSafety(safetyCtx(def));
  assert.ok(html.includes(`name="confirm_tool" value="${BUNDLE}/gitea_create_issue"`), html.match(/<div class="btb-check-list">[\s\S]*?<\/div>/)?.[0]);
  assert.ok(html.includes(label("en")), "the row names the satellite source");
  assert.ok(html.includes(JSON.stringify([`${BUNDLE}/gitea_create_issue`]).replace(/"/g, "&quot;")), "offered to the save");
});

test("the Safety save records a satellite tool's ask entry under the bundle id", async () => {
  // The page's own offer (confirm_offered) — the normal path.
  const offered = JSON.stringify([`${BUNDLE}/gitea_get_repo`]);
  const def = { tools: { crow_mcp: [`${BUNDLE}/gitea_get_repo`] }, permission_policy: {} };
  const b = { confirm_rendered: "1", confirm_offered: offered, confirm_tool: [`${BUNDLE}/gitea_get_repo`] };
  await saveSafety(def, b, { lang: "en", changed: changeTracker(b), db, botId: BOT });
  assert.deepEqual(def.permission_policy.confirm, ["mcp__gitea__gitea_get_repo", "gitea_get_repo"]);

  // No offer posted (an older page): the tools come from the def, classified with the satellite
  // marks — the lookup-shaped name still counts as write.
  const fallback = { tools: { crow_mcp: [`${BUNDLE}/gitea_get_repo`] }, permission_policy: {} };
  const b2 = { confirm_rendered: "1", confirm_tool: [`${BUNDLE}/gitea_get_repo`] };
  await saveSafety(fallback, b2, { lang: "en", changed: changeTracker(b2), db, botId: BOT });
  assert.deepEqual(fallback.permission_policy.confirm, ["mcp__gitea__gitea_get_repo", "gitea_get_repo"]);
});

// ---- copy ---------------------------------------------------------------------------------------

test("the source label exists in both languages", () => {
  const e = translations["botbuilder.srcSatelliteOn"];
  assert.equal(typeof e?.en, "string");
  assert.equal(typeof e?.es, "string");
  assert.notEqual(e.en, e.es);
  const ph = (s) => (s.match(/\{[a-z]+\}/g) || []).sort().join(",");
  assert.equal(ph(e.en), ph(e.es));
  assert.equal(ph(e.en), "{host},{name}");
});
// ---- fail closed (review) -----------------------------------------------------------------------

test("marks fail closed: a satellite bundle whose records cannot be read still classifies every tool as write", async () => {
  // A db that throws on every read: no row loads, but installed.json still says the bundle is satellite-hosted.
  const broken = { execute: async () => { throw new Error("db down"); } };
  const marks = await satelliteReadMarks(broken, HOME);
  assert.deepEqual(marks.get(BUNDLE), [], "seeded from installed.json with no read marks");
  const def = { tools: { crow_mcp: [`${BUNDLE}/gitea_list_repos`] } };
  assert.deepEqual(selectedWriteTools(def, null, marks).map((t) => t.name), ["gitea_list_repos"],
    "a lookup-shaped name is still on the ask list, never back to the name rule");
});

test("a satellite that has not reported its tools yet is a not-ok row with no tools", async () => {
  const body = fake.statusBody();
  const noTools = JSON.stringify({ v: 1, status: { ...body, tools: {} }, health: null, error: null, alerts: { psi: false, tools: {} } });
  await db.execute({ sql: "UPDATE satellites SET last_status_json = ? WHERE id = ?", args: [noTools, satId] });
  const src = await giteaSource();
  assert.ok(src, "the row still shows");
  assert.equal(src.ok, false, "not ok, so the owner's existing grants are never rewritten from it");
  assert.deepEqual(src.catalog, []);
  assert.match(String(src.error), /not reported/);
});
