/**
 * Bot Builder lists a project's connected services (project services Task 19). A scratch Crow
 * home (no ~/.pi/agent/mcp.json, so nothing canonical is probed) and data dir (init-db), real
 * connections bound by the owner's connect path, and the echo fixture as the installed add-on.
 * Child starts are stubbed everywhere except the cache-only paths, so no service is run.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rmScratch } from "./helpers/safe-rm.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(REPO, "tests", "fixtures", "echo-mcp-server.mjs");
const SCRATCH = mkdtempSync(join(tmpdir(), "crow-btb-services-"));
const HOME = join(SCRATCH, "home");
const DATA = join(SCRATCH, "data");
mkdirSync(join(HOME, "secrets"), { recursive: true });
mkdirSync(DATA, { recursive: true });
process.env.CROW_HOME = HOME;
// An empty home: readCanonicalMcp finds no ~/.pi/agent/mcp.json, so probeAll spawns nothing.
process.env.HOME = HOME;
process.env.CROW_DATA_DIR = DATA;
process.env.CROW_AUTO_UPDATE = "0";
process.env.CROW_DISABLE_HEALTH_MONITOR = "1";
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
process.env.CROW_DISABLE_NOSTR = "1";
execFileSync(process.execPath, ["scripts/init-db.js"], { env: process.env, stdio: "pipe", cwd: REPO });

const { createDbClient } = await import("../servers/db.js");
const { ensureWriteKey } = await import("../servers/gateway/keychain/store.js");
const SC = await import("../servers/shared/service-connections.js");
const SENS = await import("../servers/shared/service-sensitivity.js");
const TC = await import("../servers/gateway/services/tool-cache.js");
const { serviceById } = await import("../servers/shared/service-catalog.js");
const { serviceToolsForBuilder, probeExtensions } = await import("../servers/gateway/dashboard/panels/bot-builder/data-queries.js");
const { loadSources } = await import("../servers/gateway/dashboard/panels/bot-builder/sources.js");
const { renderAbilities } = await import("../servers/gateway/dashboard/panels/bot-builder/tab-abilities.js");
const { extensionTools } = await import("../scripts/pi-bots/ext_registry.mjs");
const { t, translations } = await import("../servers/gateway/dashboard/shared/i18n.js");

const GH = "GITHUB_PERSONAL_ACCESS_TOKEN";
const SPAWNS = join(HOME, "spawns.log");
const PLAIN = "plain-addon";

after(() => rmScratch(SCRATCH));

// ---- scratch install -------------------------------------------------------------------------

function writeInstall() {
  for (const id of ["github", "notion", PLAIN]) mkdirSync(join(HOME, "bundles", id), { recursive: true });
  for (const id of ["github", "notion"]) {
    writeFileSync(join(HOME, "bundles", id, "echo-control.json"), JSON.stringify({ spawnLog: SPAWNS }));
  }
  writeFileSync(join(HOME, "installed.json"), JSON.stringify(
    ["github", "notion", PLAIN].map((id) => ({ id, type: "mcp-server", version: "1.0.0" })),
  ));
  writeFileSync(join(HOME, "mcp-addons.json"), JSON.stringify({
    github: { command: "node", args: [FIXTURE], env: {} },
    notion: { command: "node", args: [FIXTURE], env: {} },
    [PLAIN]: { command: "node", args: [FIXTURE], env: {} },
  }), { mode: 0o600 });
}
writeInstall();

const spawnCount = () => (existsSync(SPAWNS) ? readFileSync(SPAWNS, "utf8").split("\n").filter(Boolean).length : 0);
/** An empty cache entry reads as a miss (tools.length === 0). */
const clearCache = (serviceId) => TC.writeToolCache(HOME, serviceId, "1.0.0", []);

function withDb(fn) {
  const d = createDbClient();
  return Promise.resolve()
    .then(() => fn(d))
    .finally(() => d.close());
}

let slugN = 0;
async function project() {
  return withDb(async (d) => {
    const slug = `p${++slugN}`;
    const r = await d.execute({ sql: "INSERT INTO project_spaces (slug, name) VALUES (?, ?) RETURNING id", args: [slug, slug] });
    return Number(r.rows[0].id);
  });
}

/** As the owner's connect route does: the row, then its binding and fingerprints. */
async function connect(serviceId, { projectId, label = "work", secrets = {} } = {}) {
  return withDb(async (d) => {
    const key = await ensureWriteKey(d, { crowHome: HOME });
    const c = await SC.createConnection(d, { projectId, serviceId, accountLabel: label, secrets, config: {}, testedAt: new Date() }, { key });
    SENS.recordConnectionBinding(c, { crowHome: HOME, service: serviceById(serviceId), values: { config: c.config, secrets } });
    return c;
  });
}

const countingEnsure = (counter, toolsFor = () => []) => async () => {
  counter.calls++;
  return { tools: toolsFor() };
};

const namesOf = (tools) => tools.map((x) => x.name);

// ---- the plan's cases -------------------------------------------------------------------------

test("a tool cache answers the builder with no process start", async () => {
  TC.writeToolCache(HOME, "github", "1.0.0", [{ name: "whoami", description: "who" }, { name: "envhash", description: "hash" }]);
  const pid = await project();
  await connect("github", { projectId: pid, secrets: { [GH]: "test-token-1" } });
  const counter = { calls: 0 };
  const r = await withDb((d) => serviceToolsForBuilder(d, { serviceId: "github", projectId: pid, crowHome: HOME, ensure: countingEnsure(counter) }));
  assert.equal(r.source, "cache");
  assert.deepEqual(namesOf(r.tools), ["whoami", "envhash"]);
  assert.deepEqual(Object.keys(r.tools[0]).sort(), ["description", "name"]);
  assert.equal(counter.calls, 0);
});

test("no cache: one start fills the tools; a second call under the same budget starts nothing", async () => {
  clearCache("github");
  const pid = await project();
  await connect("github", { projectId: pid, secrets: { [GH]: "test-token-2" } });
  const counter = { calls: 0 };
  const ensure = countingEnsure(counter, () => {
    TC.writeToolCache(HOME, "github", "1.0.0", [{ name: "whoami", description: "" }, { name: "sleep", description: "" }]);
    return [{ name: "whoami" }];
  });
  const started = new Set();
  const first = await withDb((d) => serviceToolsForBuilder(d, { serviceId: "github", projectId: pid, crowHome: HOME, ensure, started }));
  assert.equal(first.source, "connection");
  assert.equal(counter.calls, 1);
  assert.deepEqual(namesOf(first.tools), ["whoami", "sleep"]);
  const second = await withDb((d) => serviceToolsForBuilder(d, { serviceId: "github", projectId: pid, crowHome: HOME, ensure, started }));
  assert.equal(counter.calls, 1, "the page's start budget is spent");
  assert.deepEqual(namesOf(second.tools), ["whoami", "sleep"]);
});

test("no cache and no active connection: nothing starts and there are no tools", async () => {
  clearCache("github");
  const pid = await project();
  const conn = await connect("github", { projectId: pid, secrets: { [GH]: "test-token-3" } });
  await withDb((d) => d.execute({
    sql: "UPDATE service_connections SET status = 'error', last_error = 'auth_failed' WHERE uuid = ?",
    args: [conn.uuid],
  }));
  const counter = { calls: 0 };
  const r = await withDb((d) => serviceToolsForBuilder(d, { serviceId: "github", projectId: pid, crowHome: HOME, ensure: countingEnsure(counter) }));
  assert.equal(r.source, "none");
  assert.deepEqual(r.tools, []);
  assert.equal(counter.calls, 0);
});

test("a sensitive connection is private: no tools, no start, and nothing offered", async () => {
  clearCache("notion");
  const pid = await project();
  await connect("notion", { projectId: pid, secrets: { NOTION_TOKEN: "test-token-4" } });
  const counter = { calls: 0 };
  const r = await withDb((d) => serviceToolsForBuilder(d, { serviceId: "notion", projectId: pid, crowHome: HOME, ensure: countingEnsure(counter) }));
  assert.deepEqual(r, { tools: [], source: "none", privateOnly: true });
  assert.equal(counter.calls, 0);
});

test("a connection in another project does not list the service here", async () => {
  clearCache("github");
  const other = await project();
  const here = await project();
  await connect("github", { projectId: other, secrets: { [GH]: "test-token-5" } });
  const out = await withDb((d) => loadSources({ db: d, projectId: here, crowHome: HOME }));
  assert.equal(out.sources.filter((s) => s.connected === true).length, 0);
  assert.ok(!out.sources.some((s) => s.server === "github"), "the other project's github is not listed");
});

test("extensionTools refuses a service bundle before any probe", async () => {
  const before = spawnCount();
  const r = await extensionTools({
    id: "github", group: "GitHub", block: { command: "node", args: [FIXTURE], cwd: join(HOME, "bundles", "github") },
  }, { crowHome: HOME });
  assert.equal(r.ok, false);
  assert.equal(r.serverId, "github");
  assert.equal(r.error, "service bundle: tools come from its connections");
  assert.equal(spawnCount(), before, "the fixture would have logged a spawn");

  const plain = await extensionTools({
    id: PLAIN, block: { command: "node", args: [FIXTURE], cwd: join(HOME, "bundles", PLAIN) },
  }, { crowHome: HOME });
  assert.notEqual(plain.error, "service bundle: tools come from its connections");
  assert.equal(plain.ok, true);
  assert.ok(namesOf(plain.tools || []).includes("whoami"));
});

test("probeExtensions lists no service bundle", async () => {
  const exts = await probeExtensions(HOME);
  assert.ok(!exts.some(({ ext }) => ext.id === "github"));
  assert.ok(!exts.some(({ ext }) => ext.id === "notion"));
  assert.ok(exts.some(({ ext }) => ext.id === PLAIN), "an ordinary add-on still probes");
});

// ---- render ----------------------------------------------------------------------------------

const abilitiesCtx = (db, def) => ({
  db, def, lang: "en", hidden: () => "", bot: { display_name: "B" }, botId: "b1", crowHome: HOME,
});

test("the Abilities tab shows a connected service in its own card, selectable as today", async () => {
  TC.writeToolCache(HOME, "github", "1.0.0", [{ name: "whoami", description: "who" }, { name: "sleep", description: "" }]);
  const pid = await project();
  await connect("github", { projectId: pid, secrets: { [GH]: "test-token-6" } });
  const def = { project_id: pid, skills: [], tools: { crow_mcp: ["github/whoami"], pi_builtin: ["read"] }, permission_policy: { bash: "deny" } };
  const html = await withDb((d) => renderAbilities(abilitiesCtx(d, def)));
  assert.match(html, /Connected services \(this project\)/);
  const row = (html.split('data-src="github"')[1] || "").split("</section>")[0];
  assert.match(row, /name="src__github"/, "the row carries the usual mode control");
  assert.match(row, /value="github\/whoami"/, "the selection key stays service/tool");
  assert.match(html, /name="src_catalog"/);
  assert.match(html, /github\\?&quot;:\[\[/, "the connected source is in the hidden catalog");
});

test("a private connection renders its copy and no input at all", async () => {
  clearCache("notion");
  const pid = await project();
  await connect("notion", { projectId: pid, secrets: { NOTION_TOKEN: "test-token-7" } });
  const def = { project_id: pid, skills: [], tools: { crow_mcp: [], pi_builtin: [] }, permission_policy: { bash: "deny" } };
  const html = await withDb((d) => renderAbilities(abilitiesCtx(d, def)));
  const row = (html.match(/<div class="btb-src btb-src-private" data-src="notion">[\s\S]*?<\/p><\/div>/) || [""])[0];
  assert.match(row, /Private: bots can't use this connection\./);
  assert.doesNotMatch(row, /<input/, "never offered");
});

test("a bot without a project gets no connected-services card", async () => {
  const def = { project_id: null, skills: [], tools: { crow_mcp: [], pi_builtin: [] }, permission_policy: { bash: "deny" } };
  const html = await withDb((d) => renderAbilities(abilitiesCtx(d, def)));
  assert.doesNotMatch(html, /Connected services \(this project\)/);
});

test("the three connected-services keys exist in English and Spanish", () => {
  for (const key of ["botbuilder.abConnectedTitle", "botbuilder.abConnectedNoTools", "botbuilder.abConnectedPrivate"]) {
    assert.equal(typeof translations[key]?.en, "string", key);
    assert.equal(typeof translations[key]?.es, "string", key);
    assert.doesNotMatch(translations[key].en, /\u2014/);
    assert.doesNotMatch(translations[key].es, /\u2014/);
  }
  assert.match(t("botbuilder.abConnectedTitle", "es"), /Servicios conectados/);
  assert.match(t("botbuilder.abConnectedNoTools", "es"), /Probar de nuevo/);
  assert.match(t("botbuilder.abConnectedPrivate", "es"), /Privada/);
});