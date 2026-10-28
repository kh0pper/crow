// Research fetch-before-cite, PR 2, Task 14: a repo skill's exact
// `server/tool` frontmatter entries reach the bot that selects it (at spawn,
// for background jobs and at a Bot Builder save), within the model's tool cap,
// and the owner's unticks (def.tools.skill_tools_declined) are respected.
// Fixture skills live in a scratch repo-skills dir passed as `repoSkillsDir`;
// the real skills/ is never written.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

for (const k of Object.keys(process.env)) if (/^(PI_|PIBOT_)/.test(k)) delete process.env[k];
const dir = mkdtempSync(join(tmpdir(), "skill-tools-"));
const crowHome = join(dir, "home");
const repoSkillsDir = join(dir, "repo-skills");
process.env.CROW_DATA_DIR = dir;
process.env.CROW_HOME = crowHome;
delete process.env.CROW_DB_PATH;
process.env.PIBOT_MAX_PI = "99";
process.env.PIBOT_WARM_GATEWAY_URL = "http://127.0.0.1:1";
process.env.PIBOT_WARM_TIMEOUT_MS = "1500";
process.env.PIBOT_MCP_CONFIG_DELIVERY = "fd";
process.env.CROW_PI_SANDBOX = "off";
process.env.PI_MODELS_JSON = join(dir, "models.json");
writeFileSync(process.env.PI_MODELS_JSON, JSON.stringify({ providers: { stub: { models: [{ id: "m1" }] }, capped: { models: [{ id: "m1" }] } } }));
process.env.HOME = join(dir, "fakehome");
mkdirSync(join(process.env.HOME, ".pi", "agent"), { recursive: true });
const srv = (n) => ({ command: "node", args: [join(dir, n + ".js")] });
writeFileSync(join(process.env.HOME, ".pi", "agent", "mcp.json"), JSON.stringify({
  mcpServers: { "crow-projects": srv("projects"), "crow-memory": srv("memory") },
}));
mkdirSync(join(crowHome, "skills"), { recursive: true });
mkdirSync(repoSkillsDir, { recursive: true });

const FX = [
  "---", "name: fx", "description: Fixture skill", "tools:",
  "  - crow-projects/crow_add_source", "  - crow-projects/crow_get_source", "  - crow-memory", "  - crow_identity_list",
  "---", "", "# Fixture", "", "Open pages before citing them.", "",
].join("\n");
writeFileSync(join(repoSkillsDir, "fx.md"), FX);
writeFileSync(join(repoSkillsDir, "shadowed.md"), FX.replace("name: fx", "name: shadowed"));
writeFileSync(join(crowHome, "skills", "shadowed.md"), FX.replace("name: fx", "name: shadowed"));
writeFileSync(join(repoSkillsDir, "offfx.md"), FX.replace("name: fx", "name: offfx"));
writeFileSync(join(crowHome, "skills", "mine.md"), FX.replace("name: fx", "name: mine"));
// fxr: a write tool, a read tool, and a server outside GRANTABLE_SERVERS
writeFileSync(join(repoSkillsDir, "fxr.md"), ["---", "name: fxr", "tools:",
  "  - crow-sharing/crow_send_message", "  - crow-projects/crow_add_source", "  - crow-projects/crow_search_notes",
  "---", "", "# Fixture R", ""].join("\n"));

const DB_FILE = join(dir, "crow.db");
const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

const ST = await import("../scripts/pi-bots/skill-tools.mjs");
const { setSkillOff } = await import("../servers/shared/skill-state.js");
const { buildBotWorld } = await import("../scripts/pi-bots/bot-world.mjs");
const { runJob } = await import("../scripts/pi-bots/job_runner.mjs");
const { buildToolsCsv } = await import("../scripts/pi-bots/bridge.mjs");
const { saveAbilities } = await import("../servers/gateway/dashboard/panels/bot-builder/save-handlers.js");
const { renderAbilities, renderSkillsCard } = await import("../servers/gateway/dashboard/panels/bot-builder/tab-abilities.js");
const { _setSourcesForTest } = await import("../servers/gateway/dashboard/panels/bot-builder/sources.js");
const { t } = await import("../servers/gateway/dashboard/shared/i18n.js");

const ADD = "crow-projects/crow_add_source", GET = "crow-projects/crow_get_source";
const LIST = "crow-projects/crow_list_projects", CREATE = "crow-projects/crow_create_project";
const SEARCH = "crow-projects/crow_search_notes";
const opts = { crowHome, repoSkillsDir };
const noCap = async () => ({ cap: null, countFor: () => 0 });
const capOf = (cap) => async () => ({ cap, countFor: (d) => d.tools.crow_mcp.length });

const SOURCES = { error: null, sources: [
  { server: "crow-projects", name: "Crow projects", account: "", ok: true, catalog: [
    { name: "crow_list_projects", access: "read" }, { name: "crow_get_source", access: "read" },
    { name: "crow_add_source", access: "write" }, { name: "crow_create_project", access: "write" },
    { name: "crow_search_notes", access: "read" } ] },
] };
const CATALOG = JSON.stringify({ "crow-projects": SOURCES.sources[0].catalog.map((x) => [x.name, x.access]) });

// hank: already selected fx, crow-projects in custom mode (a write tool picked)
const HANK = () => ({ system_prompt: "You are Hank.", models: { default: "stub/m1" }, skills: ["fx"],
  tools: { pi_builtin: ["read"], crow_mcp: [LIST, CREATE] } });
// read-mode hank: crow-projects selected Read-only
const READ_HANK = () => ({ system_prompt: "You are Hank.", models: { default: "stub/m1" }, skills: ["fxr"],
  tools: { pi_builtin: ["read"], crow_mcp: [LIST, GET] } });

function putBot(botId, def) {
  const c = new Database(DB_FILE);
  c.prepare("INSERT OR REPLACE INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES (?,?,?,1)").run(botId, "Bot " + botId, JSON.stringify(def));
  c.close();
}
function storedDef(botId) {
  const c = new Database(DB_FILE);
  try { return c.prepare("SELECT definition FROM pi_bot_defs WHERE bot_id=?").get(botId).definition; } finally { c.close(); }
}

before(() => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: REPO });
  const c = new Database(DB_FILE);
  c.prepare("INSERT OR REPLACE INTO providers (id, base_url, models) VALUES (?,?,?)").run("capped", "http://127.0.0.1:1/v1", JSON.stringify([{ id: "m1", maxTools: 1 }]));
  c.close();
  _setSourcesForTest(SOURCES);
});
after(() => { _setSourcesForTest(null); rmSync(dir, { recursive: true, force: true }); });

test("a repo skill's server/tool entries are returned; bare names are not", () => {
  assert.deepEqual(ST.skillRequiredTools("fx", opts), [ADD, GET]);
  assert.deepEqual(ST.skillRequiredTools("nope", opts), []);
  // the real repo dir by default: shipped skills list bare servers only, so nothing new is granted
  assert.deepEqual(ST.skillRequiredTools("blog", { crowHome }), []);
});

test("a crowHome copy of the same name grants nothing", () => {
  assert.deepEqual(ST.skillRequiredTools("shadowed", opts), []);
  assert.deepEqual(ST.skillRequiredTools("mine", opts), []);
});

test("a switched-off skill grants nothing", () => {
  setSkillOff(crowHome, "offfx", true);
  try { assert.deepEqual(ST.skillRequiredTools("offfx", opts), []); }
  finally { setSkillOff(crowHome, "offfx", false); }
  assert.deepEqual(ST.skillRequiredTools("offfx", opts), [ADD, GET]);
});

test("the union skips what the def already grants", () => {
  assert.deepEqual(ST.withSkillRequiredTools(["crow-projects__crow_add_source", GET], ["fx"], opts).added, []);
  assert.deepEqual(ST.withSkillRequiredTools(["crow-projects"], ["fx"], opts).added, []);
  assert.deepEqual(ST.withSkillRequiredTools([GET], ["fx"], { ...opts, declined: [ADD] }).added, []);
  const r = ST.withSkillRequiredTools([CREATE], ["fx", "fx"], opts);
  assert.deepEqual(r.added, [ADD, GET]);
  assert.deepEqual(r.list, [CREATE, ADD, GET]);
});

test("addSkillToolsGuarded never mutates its input and leaves voice bots alone", async () => {
  const def = HANK();
  const before = JSON.stringify(def);
  const r = await ST.addSkillToolsGuarded(def, { ...opts, budget: await noCap() });
  assert.equal(JSON.stringify(def), before);
  assert.deepEqual(r.added, [ADD, GET]);
  assert.deepEqual(r.def.tools.crow_mcp, [LIST, CREATE, ADD, GET]);
  const voice = { kind: "voice", skills: ["fx"], tools: { crow_mcp: [] } };
  assert.equal((await ST.addSkillToolsGuarded(voice, { ...opts, budget: await noCap() })).def, voice);
  const capped = await ST.addSkillToolsGuarded(def, { ...opts, budget: await capOf(2)() });
  assert.equal(capped.refused, true);
  assert.equal(capped.def, def);
  assert.deepEqual(capped.wanted, [ADD, GET]);
});

test("spawn: hank-shaped def gets the tools in world.def only, never in the stored def", async () => {
  putBot("hank", { ...HANK(), tools: { pi_builtin: ["read"], crow_mcp: [CREATE] } });
  const stored = storedDef("hank");
  const logs = [];
  const world = await buildBotWorld({ botId: "hank", threadId: "t1", gatewayType: "perch", log: (m) => logs.push(m), repoSkillsDir });
  assert.ok(world.def.tools.crow_mcp.includes(ADD), JSON.stringify(world.def.tools));
  assert.ok(world.def.tools.crow_mcp.includes(GET));
  assert.equal(storedDef("hank"), stored, "the stored definition is byte-identical");
  assert.ok(logs.some((l) => l.startsWith("skill tools added: ") && l.includes(ADD)), logs.join("\n"));
  assert.ok(world.mcpConfig && world.mcpConfig.mcpServers && world.mcpConfig.mcpServers["crow-projects"], JSON.stringify(world.mcpConfig));
  const csv = buildToolsCsv(world.def, { resolved: { provider: "stub", model: "m1" } }).csv;
  assert.match(csv, /mcp__crow-projects__crow_add_source/);
});

test("spawn: over the tool cap the union is skipped and logged; the turn proceeds", async () => {
  putBot("capbot", { ...HANK(), models: { default: "capped/m1" } });
  const logs = [];
  const world = await buildBotWorld({ botId: "capbot", threadId: "t1", gatewayType: "perch", log: (m) => logs.push(m), repoSkillsDir });
  assert.deepEqual(world.def.tools.crow_mcp, [LIST, CREATE]);
  assert.ok(logs.some((l) => l.startsWith("skill tools not added (tool limit): ") && l.includes(ADD)), logs.join("\n"));
  assert.ok(world.sessionDir, "the world is still built");
});

const always = Object.assign(() => true, { hasSnapshot: false, anyStartingWith: () => true });

/** A posted Abilities form: skills + the crow-projects services row. */
function form({ skills, mode, was, tools }) {
  const b = { skills_rendered: "1", skills, src_catalog: CATALOG };
  if (mode) { b["src__crow-projects"] = mode; b["src__crow-projects__was"] = was; b["tool__crow-projects"] = tools; }
  return b;
}

test("save: newly selecting the skill writes its tools into the def", async () => {
  const def = { ...HANK(), skills: [], tools: { pi_builtin: ["read"], crow_mcp: [CREATE] } };
  const out = await saveAbilities(def, form({ skills: ["fx"] }), { lang: "en", changed: always, ...opts, companionBudget: noCap });
  assert.deepEqual(def.skills, ["fx"]);
  assert.deepEqual(def.tools.crow_mcp, [CREATE, ADD, GET]);
  assert.equal(def.tools.skill_tools_declined, undefined, "a new skill records no declines");
  assert.ok(!out.warn);

  const def2 = { ...HANK(), skills: [], tools: { pi_builtin: ["read"], crow_mcp: [CREATE] } };
  const out2 = await saveAbilities(def2, form({ skills: ["fx"] }), { lang: "en", changed: always, ...opts, companionBudget: capOf(2) });
  assert.deepEqual(def2.tools.crow_mcp, [CREATE]);
  assert.ok((out2.warn || []).includes(t("botbuilder.abSkillToolsCapped", "en")), JSON.stringify(out2));
});

async function renderHank(def, { budget = noCap } = {}) {
  return renderAbilities({ def, lang: "en", hidden: () => "", db: null, req: null, bot: { display_name: "Hank" }, botId: "hank", ...opts, companionBudget: budget });
}
const ticked = (html, v) => new RegExp(`value="${v.replace("/", "\\/")}" checked`).test(html);
const shownMode = (html) => (html.match(/name="src__crow-projects__was" value="([a-z]+)"/) || [])[1];

test("the Abilities tab shows the effective tools for an already-selected skill", async () => {
  const html = await renderHank(HANK());
  assert.equal(ticked(html, ADD), true, "the union's tool is ticked");
  assert.equal(ticked(html, GET), true);
  assert.equal(ticked(html, CREATE), true);
  assert.equal(ticked(html, SEARCH), false);
  assert.equal(shownMode(html), "custom");
  // declined: not ticked
  const d = HANK(); d.tools.skill_tools_declined = [ADD];
  const html2 = await renderHank(d);
  assert.equal(ticked(html2, ADD), false);
  assert.equal(ticked(html2, GET), true);
  // read mode: the union adds the read tool only, and the source stays Read-only
  const html4 = await renderHank(READ_HANK());
  assert.equal(ticked(html4, SEARCH), true);
  assert.equal(ticked(html4, ADD), false);
  assert.equal(shownMode(html4), "read");
  // over the cap: the tab shows what the bot gets, and says why
  const html3 = await renderHank(HANK(), { budget: capOf(2) });
  assert.equal(ticked(html3, ADD), false);
  assert.ok(html3.includes(t("botbuilder.abSkillToolsCapped", "en")));
  assert.ok(!html.includes(t("botbuilder.abSkillToolsCapped", "en")));
});

test("saving with an already-selected skill records unticked required tools as declined", async () => {
  // untouched save: the effective form round-trips byte-identically
  const def0 = HANK(); const raw0 = JSON.stringify(def0);
  await saveAbilities(def0, form({ skills: ["fx"], mode: "custom", was: "custom", tools: [LIST, CREATE, ADD, GET] }), { lang: "en", changed: always, ...opts, companionBudget: noCap });
  assert.equal(JSON.stringify(def0), raw0, "an untouched save leaves the def as it was");

  const def = HANK();
  await saveAbilities(def, form({ skills: ["fx"], mode: "custom", was: "custom", tools: [LIST, CREATE, GET] }), { lang: "en", changed: always, ...opts, companionBudget: noCap });
  assert.deepEqual(def.tools.skill_tools_declined, [ADD]);
  assert.deepEqual(def.tools.crow_mcp, [LIST, CREATE], "GET came from the union and stays out of the stored list");
  assert.ok(!ST.effectiveCrowMcp(def, opts).includes(ADD));
  putBot("hank2", def);
  const world = await buildBotWorld({ botId: "hank2", threadId: "t1", gatewayType: "perch", repoSkillsDir });
  assert.ok(!world.def.tools.crow_mcp.includes(ADD));
  assert.ok(world.def.tools.crow_mcp.includes(GET), "the other fx tools stay granted");

  // the owner picks Read-only for the source: the mode is respected (no write tool
  // comes back through the union, and leaving it unticked is not a decline)
  const def2 = HANK();
  await saveAbilities(def2, form({ skills: ["fx"], mode: "read", was: "custom" }), { lang: "en", changed: always, ...opts, companionBudget: noCap });
  assert.equal(def2.tools.skill_tools_declined, undefined);
  assert.ok(!def2.tools.crow_mcp.includes(CREATE));
  const eff2 = ST.effectiveCrowMcp(def2, opts);
  assert.ok(!eff2.includes(ADD) && eff2.includes(GET) && eff2.includes(LIST), JSON.stringify(eff2));

  // the services card was not posted: declines are left as they are
  const def3 = HANK(); def3.tools.skill_tools_declined = [ADD];
  await saveAbilities(def3, { skills_rendered: "1", skills: ["fx"] }, { lang: "en", changed: always, ...opts, companionBudget: noCap });
  assert.deepEqual(def3.tools.skill_tools_declined, [ADD]);
});

test("an unticked skill tool is recorded as declined and stays off at spawn", async () => {
  // save 1: newly select fx
  const def = { ...HANK(), skills: [], tools: { pi_builtin: ["read"], crow_mcp: [CREATE] } };
  await saveAbilities(def, form({ skills: ["fx"] }), { lang: "en", changed: always, ...opts, companionBudget: noCap });
  assert.deepEqual(def.tools.crow_mcp, [CREATE, ADD, GET]);
  // save 2: untick add_source with fx still selected
  await saveAbilities(def, form({ skills: ["fx"], mode: "custom", was: "custom", tools: [CREATE, GET] }), { lang: "en", changed: always, ...opts, companionBudget: noCap });
  assert.deepEqual(def.tools.skill_tools_declined, [ADD]);
  assert.ok(!def.tools.crow_mcp.includes(ADD));
  putBot("decl", def);
  const w = await buildBotWorld({ botId: "decl", threadId: "t1", gatewayType: "perch", repoSkillsDir });
  assert.ok(!w.def.tools.crow_mcp.includes(ADD));
  assert.ok(w.def.tools.crow_mcp.includes(GET));
  // save 3: re-tick it
  await saveAbilities(def, form({ skills: ["fx"], mode: "custom", was: "custom", tools: [CREATE, GET, ADD] }), { lang: "en", changed: always, ...opts, companionBudget: noCap });
  assert.equal(def.tools.skill_tools_declined, undefined, "removed from the declines");
  assert.ok(ST.effectiveCrowMcp(def, opts).includes(ADD));
  // dropping fx clears its declines
  def.tools.skill_tools_declined = [ADD];
  await saveAbilities(def, form({ skills: [] }), { lang: "en", changed: always, ...opts, companionBudget: noCap });
  assert.deepEqual(def.skills, []);
  assert.equal(def.tools.skill_tools_declined, undefined);
});

test("background jobs get the union too", async () => {
  const def = { ...HANK(), tools: { pi_builtin: ["read"], crow_mcp: [CREATE] } };
  const raw = JSON.stringify(def);
  const seen = {};
  class PiRpc {
    constructor(o) { seen.def = o.def; seen.mcpConfig = o.mcpConfig; }
    async getState() { return { data: { sessionId: "s1" } }; }
    async getSessionStats() { return null; }
    async prompt() {}
    assistantText() { return "done"; }
    toolCalls() { return []; }
    async close() {}
  }
  const bridge = { loadBot: () => ({ bot_id: "jobbot", display_name: "Job", def, project_id: null }), PiRpc };
  const r = await runJob({ job_id: "j1", bot_id: "jobbot", goal: "work", escalate: 0 }, { bridge, repoSkillsDir });
  assert.equal(r.result, "done");
  assert.ok(seen.def.tools.crow_mcp.includes(ADD), JSON.stringify(seen.def.tools));
  assert.ok(seen.mcpConfig && seen.mcpConfig.mcpServers["crow-projects"]);
  assert.match(buildToolsCsv(seen.def, { resolved: { provider: "stub", model: "m1" } }).csv, /mcp__crow-projects__crow_add_source/);
  assert.equal(JSON.stringify(def), raw, "the loaded def is not mutated");
});

test("Bot Builder shows a needs-tools hint for a non-repo skill", async () => {
  const html = renderSkillsCard({ def: { skills: ["mine"], tools: { crow_mcp: [] } }, lang: "en", ...opts });
  assert.ok(html.includes("Needs tools:"), html);
  assert.match(html, /<span class="btb-muted">Needs tools: crow-projects<\/span>/);
  assert.deepEqual(ST.skillToolHints({ skills: ["mine", "fx"], tools: { crow_mcp: [] } }, opts), [{ skill: "mine", servers: ["crow-projects"] }]);
  assert.deepEqual(ST.skillToolHints({ skills: ["mine"], tools: { crow_mcp: [ADD, GET] } }, opts), []);
  const es = renderSkillsCard({ def: { skills: ["mine"], tools: { crow_mcp: [] } }, lang: "es", ...opts });
  assert.ok(es.includes("Necesita herramientas:"));
});

test("skills stay prompt text: approving a proposal never adds tools", async () => {
  putBot("author", { skills: [], tools: { crow_mcp: [] } });
  const { promoteSkill } = await import("../scripts/pi-bots/skill_promote.mjs");
  // named like a repo skill (the fixture repo has "fx"): it lands in <crowHome>/skills and shadows it
  const r = promoteSkill({ bot_id: "author", name: "fx", text: FX, mode: "operator", crowHome });
  try {
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(existsSync(join(crowHome, "skills", "fx.md")));
    assert.deepEqual(ST.skillRequiredTools("fx", opts), []);
    assert.deepEqual(JSON.parse(storedDef("author")).tools, { crow_mcp: [] });
  } finally { rmSync(join(crowHome, "skills", "fx.md"), { force: true }); }
});

test("only GRANTABLE_SERVERS are granted: crow-sharing/crow_send_message stays informational", () => {
  assert.deepEqual(ST.GRANTABLE_SERVERS, ["crow-projects"]);
  assert.deepEqual(ST.skillRequiredTools("fxr", opts), [ADD, SEARCH]);
  const r = ST.withSkillRequiredTools([], ["fxr"], opts);
  assert.ok(!r.list.some((e) => e.startsWith("crow-sharing")), JSON.stringify(r));
});

test("read mode: a read-mode hank gets no write tools from the union, at spawn or on save", async () => {
  assert.equal(ST.serverInReadMode([LIST, GET], "crow-projects"), true);
  assert.equal(ST.serverInReadMode([LIST, CREATE], "crow-projects"), false);
  assert.equal(ST.serverInReadMode(["crow-projects"], "crow-projects"), false);
  assert.equal(ST.serverInReadMode([], "crow-projects"), false);
  assert.deepEqual(ST.withSkillRequiredTools([LIST, GET], ["fxr"], opts).added, [SEARCH]);
  assert.deepEqual(ST.withSkillRequiredTools([LIST, CREATE], ["fxr"], opts).added, [ADD, SEARCH]);
  putBot("readhank", READ_HANK());
  const w = await buildBotWorld({ botId: "readhank", threadId: "t1", gatewayType: "perch", repoSkillsDir });
  assert.deepEqual(w.def.tools.crow_mcp, [LIST, GET, SEARCH]);
  // an untouched save of the read-mode page: byte-identical, no declines
  const d = READ_HANK(); const raw = JSON.stringify(d);
  await saveAbilities(d, form({ skills: ["fxr"], mode: "read", was: "read" }), { lang: "en", changed: always, ...opts, companionBudget: noCap });
  assert.equal(JSON.stringify(d), raw);
  // newly selecting fxr on a read-mode def writes only the read tool
  const n = { ...READ_HANK(), skills: [] };
  await saveAbilities(n, form({ skills: ["fxr"] }), { lang: "en", changed: always, ...opts, companionBudget: noCap });
  assert.deepEqual(n.tools.crow_mcp, [LIST, GET, SEARCH]);
});

test("a hand tick survives a save when the page was rendered over the cap", async () => {
  // capOf(2): HANK's union (4 tools) is refused, so the page showed the stored list
  const def = HANK();
  await saveAbilities(def, form({ skills: ["fx"], mode: "custom", was: "custom", tools: [LIST, CREATE, ADD] }), { lang: "en", changed: always, ...opts, companionBudget: capOf(2) });
  assert.ok(def.tools.crow_mcp.includes(ADD), JSON.stringify(def.tools));
  assert.equal(def.tools.skill_tools_declined, undefined, "no declines from an over-cap page");
});

test("an Abilities save never fails on a skill-tools error", async () => {
  const def = HANK(); def.models = { default: "stub/m1" };
  const boom = async () => { throw new Error("no model"); };
  const out = await saveAbilities(def, form({ skills: ["fx"], mode: "custom", was: "custom", tools: [LIST, CREATE] }), { lang: "en", changed: always, ...opts, companionBudget: boom });
  assert.ok(!out.error);
  assert.deepEqual(def.tools.crow_mcp, [LIST, CREATE]);
});

test("a regenerated MCP config carries the union, like a spawn", async () => {
  putBot("regen", { ...HANK(), tools: { pi_builtin: ["read"], crow_mcp: ["crow-memory/crow_store_memory"] } });
  const raw = storedDef("regen");
  const { createDbClient } = await import("../servers/db.js");
  const { regenerateBotMcp } = await import("../servers/gateway/dashboard/panels/bot-mcp-regen.js");
  const db = createDbClient();
  try {
    const r = await regenerateBotMcp(db, "regen", { repoSkillsDir });
    assert.ok(r.servers.includes("crow-projects"), JSON.stringify(r.servers));
  } finally { try { db.close(); } catch {} }
  assert.equal(storedDef("regen"), raw);
});
