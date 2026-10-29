import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";

const dir = mkdtempSync(join(tmpdir(), "apps-catalog-"));
process.env.CROW_HOME = join(dir, "home");
process.env.CROW_DATA_DIR = dir;
mkdirSync(process.env.CROW_HOME, { recursive: true });
const REPO = new URL("..", import.meta.url).pathname;

const { listApps, appsForBots, grantedServers, appsForProject, invalidateAppCatalog, invalidateProjectApps, cleanPath, NOVNC_PAGE_QUERY, _resetCatalogCache, _setClock } =
  await import("../servers/gateway/apps/catalog.js");
const { registerPanel } = await import("../servers/gateway/dashboard/panel-registry.js");

const home = join(dir, "bundles-home");
function bundle(id, manifest) {
  mkdirSync(join(home, "bundles", id), { recursive: true });
  writeFileSync(join(home, "bundles", id, "manifest.json"), JSON.stringify({ id, name: id, ...manifest }));
}
const ALL = ["browser", "ntfy", "notes", "plain", "hidden", "dunder", "pager", "climber", "nested"];
function install(ids) {
  writeFileSync(join(home, "installed.json"), JSON.stringify(ids.map((id) => ({ id }))));
}

// A minimal async db over better-sqlite3 (execute({sql,args}) -> {rows}).
let sdb;
const db = { execute: async ({ sql, args = [] }) => ({ rows: sdb.prepare(sql).all(...args) }) };
function seedBot(botId, def, projectId = 1) {
  sdb.prepare("INSERT INTO pi_bot_defs (bot_id, display_name, definition, project_id) VALUES (?,?,?,?)")
    .run(botId, botId, JSON.stringify(def), projectId);
}

before(() => {
  bundle("browser", { webUI: { port: 6080, path: "/vnc.html", label: "VNC Viewer" }, desktop: { path: "vnc.html", lease: true }, mcpServers: ["browser", "crow-browser"] });
  bundle("ntfy", { webUI: { port: 2586, path: "/", proxyMode: "direct" }, mcpServers: ["ntfy"] });
  bundle("notes", { panel: "panel/notes.js", mcpServers: ["notes-srv"] });
  bundle("plain", { description: "no ui" });
  bundle("hidden", { panel: "panel/hidden.js", mcpServers: ["hidden-srv"] });
  bundle("dunder", { webUI: { port: 7001, path: "/" }, mcpServers: ["weird__srv"] });
  // I3: a desktop.path that is not a clean noVNC page makes a page app, never a desktop one.
  bundle("pager", { webUI: { port: 7002, path: "/" }, desktop: { path: "index.html", lease: true } });
  bundle("climber", { webUI: { port: 7003, path: "/" }, desktop: { path: "../vnc.html", lease: true } });
  bundle("nested", { webUI: { port: 7004, path: "/" }, desktop: { path: "/app/novnc/vnc_lite.html" } });
  install(ALL);
  // The live registry knows notes' panel (route differs from its id); "hidden" is not enabled.
  registerPanel({ id: "notes-panel", bundleId: "notes", route: "/dashboard/notes-panel", handler() {} });
});
after(() => { _setClock(null); _resetCatalogCache(); rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => {
  _resetCatalogCache(); _setClock(null);
  sdb = new Database(":memory:");
  sdb.exec(`CREATE TABLE pi_bot_defs (bot_id TEXT PRIMARY KEY, display_name TEXT, definition TEXT, enabled INTEGER DEFAULT 1, project_id INTEGER);
    CREATE TABLE dashboard_settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE dashboard_settings_overrides (key TEXT, instance_id TEXT, value TEXT);`);
});

test("listApps reads webUI, desktop and panel bundles", () => {
  const apps = listApps({ crowHome: home });
  assert.deepEqual(apps.map((a) => a.id).sort(), ["browser", "climber", "dunder", "nested", "notes", "ntfy", "pager"]); // "hidden" has no registered panel
  const b = apps.find((a) => a.id === "browser");
  assert.equal(b.kind, "desktop");
  assert.equal(b.href, "/proxy/browser/vnc.html?autoconnect=true&resize=scale&view_only=false");
  assert.equal(b.label, "browser", "the manifest's name, not webUI.label (\"VNC Viewer\")");
  assert.equal(b.desktopPath, "vnc.html");
  assert.equal(b.leaseDeclared, true);
  assert.deepEqual(b.mcpServers, ["browser", "crow-browser"]);
  const n = apps.find((a) => a.id === "notes");
  assert.equal(n.kind, "page");
  assert.equal(n.href, "/dashboard/notes-panel"); // the registered panel's real route
  assert.equal(n.desktopPath, null);
});

// I3: one noVNC-path rule, at the catalog.
test("the catalog marks an app desktop only when its desktop.path is a clean noVNC page", () => {
  const by = Object.fromEntries(listApps({ crowHome: home }).map((a) => [a.id, a]));
  assert.equal(by.pager.kind, "page", "index.html is not a noVNC page");
  assert.equal(by.pager.desktopPath, null);
  assert.equal(by.pager.leaseDeclared, false);
  assert.equal(by.pager.href, "/proxy/pager/");
  assert.equal(by.climber.kind, "page", "a path that climbs out");
  assert.equal(by.climber.desktopPath, null);
  assert.equal(by.nested.kind, "desktop");
  assert.equal(by.nested.desktopPath, "app/novnc/vnc_lite.html", "the cleaned path");
  for (const [p, want] of [["vnc.html", "vnc.html"], ["/vnc.html", "vnc.html"], ["a/b/vnc_lite.html", "a/b/vnc_lite.html"], ["index.html", null],
    ["../vnc.html", null], ["a/../vnc.html", null], ["./vnc.html", null], ["vnc.html?x=1", null], ["vnc.html.evil", null], ["x/vnc.htm", null], ["", null], [null, null]]) {
    assert.equal(cleanPath(p), want, String(p));
  }
});

// I2: noVNC saves view_only per origin, so every launcher link to a noVNC page pins it off.
test("every launcher link to a desktop app's noVNC page pins autoconnect, scale and view_only=false", () => {
  assert.equal(NOVNC_PAGE_QUERY, "?autoconnect=true&resize=scale&view_only=false");
  for (const a of listApps({ crowHome: home }).filter((x) => x.kind === "desktop")) {
    assert.equal(a.href, "/proxy/" + a.id + "/" + a.desktopPath + NOVNC_PAGE_QUERY, a.id);
    assert.equal(new URL(a.href, "https://x.example").searchParams.get("view_only"), "false");
  }
  // A page app whose web UI is not a noVNC page keeps its href as it was.
  assert.equal(listApps({ crowHome: home }).find((a) => a.id === "dunder").href, "/proxy/dunder/");
});

test("appsForProject is cached per project for 30 s and cleared by a bot-def save", async () => {
  const { emitBotDefsChanged } = await import("../servers/gateway/dashboard/panels/bot-builder/defs-changed.js");
  let t = 1000;
  _setClock(() => t);
  let queries = 0;
  const counting = { execute: (q) => { if (/pi_bot_defs/.test(q.sql)) queries++; return db.execute(q); } };
  seedBot("a", { tools: { crow_mcp: ["browser/browser_navigate"] } });
  assert.deepEqual((await appsForProject(counting, 1, { crowHome: home })).map((x) => x.id), ["browser"]);
  seedBot("b", { tools: { crow_mcp: ["notes-srv/x"] } });
  t += 29_000;
  assert.deepEqual((await appsForProject(counting, 1, { crowHome: home })).map((x) => x.id), ["browser"], "cached");
  assert.equal(queries, 1);
  assert.deepEqual((await appsForProject(counting, 2, { crowHome: home })), [], "per project");
  assert.equal(queries, 2);
  t += 2_000;
  assert.deepEqual((await appsForProject(counting, 1, { crowHome: home })).map((x) => x.id).sort(), ["browser", "notes"], "expired");
  assert.equal(queries, 3);

  seedBot("c", { tools: { crow_mcp: ["weird__srv/x"] } });   // grants dunder, but nothing cached changes until a save
  sdb.prepare("UPDATE pi_bot_defs SET enabled = 0 WHERE bot_id = 'a'").run();
  assert.deepEqual((await appsForProject(counting, 1, { crowHome: home })).map((x) => x.id).sort(), ["browser", "notes"], "still cached");
  emitBotDefsChanged("a");   // what every Bot Builder save emits
  assert.deepEqual((await appsForProject(counting, 1, { crowHome: home })).map((x) => x.id).sort(), ["dunder", "notes"], "a save clears it");
  assert.equal(queries, 4);
  invalidateProjectApps();
  await appsForProject(counting, 1, { crowHome: home });
  assert.equal(queries, 5, "invalidateProjectApps clears it too");
  invalidateAppCatalog();
  await appsForProject(counting, 1, { crowHome: home });
  assert.equal(queries, 6, "an install clears it too");
  // Another db never shares an answer.
  const other = { execute: async () => ({ rows: [] }) };
  assert.deepEqual(await appsForProject(other, 1, { crowHome: home }), []);
});

test("direct-mode apps keep their own href", () => {
  const a = listApps({ crowHome: home }).find((x) => x.id === "ntfy");
  assert.equal(a.href, null);
  assert.equal(a.directPort, 2586);
  assert.equal(a.path, "/");
  assert.equal(a.fallbackHref, "/dashboard/extensions");
  assert.equal(a.kind, "page");
  assert.ok(!JSON.stringify(listApps({ crowHome: home })).includes("{host}"));
});

test("skill-granted server counts", async () => {
  const def = { tools: { crow_mcp: ["browser/browser_navigate"] } };
  const g = await grantedServers(db, def);
  assert.deepEqual([...g], ["browser"]);
  const apps = appsForBots(listApps({ crowHome: home }), [g]);
  assert.deepEqual(apps.map((a) => a.id), ["browser"]);
  const whole = await grantedServers(db, { tools: { crow_mcp: ["crow-browser"] } });
  assert.deepEqual([...whole], ["crow-browser"]);
});

test("a repo skill's granted tools count", async () => {
  const skills = join(dir, "skills");
  mkdirSync(skills, { recursive: true });
  writeFileSync(join(skills, "sk-test.md"), "---\nname: sk-test\ndescription: x\ntools:\n  - crow-projects/crow_add_source\n---\nbody\n");
  const g = await grantedServers(db, { skills: ["sk-test"], tools: { crow_mcp: [] } }, { repoSkillsDir: skills, crowHome: home, remoteEnabled: false });
  assert.deepEqual([...g], ["crow-projects"]);
});

test("a server name containing __ resolves against the known names", async () => {
  const def = { tools: { crow_mcp: ["weird__srv/some_tool"] } };
  const g = await grantedServers(db, def, { knownServers: ["weird__srv"], remoteEnabled: false });
  assert.deepEqual([...g], ["weird__srv"]);
  assert.deepEqual(appsForBots(listApps({ crowHome: home }), [g]).map((a) => a.id), ["dunder"]);
});

test("disabled bots are skipped", async () => {
  seedBot("off", { tools: { crow_mcp: ["browser/browser_navigate"] } });
  sdb.prepare("UPDATE pi_bot_defs SET enabled = 0").run();
  assert.deepEqual(await appsForProject(db, 1, { crowHome: home }), []);
});

test("crow-core grants no bundle apps", async () => {
  const g = await grantedServers(db, { tools: { crow_mcp: ["crow-core/crow_store_memory"] } });
  assert.deepEqual(appsForBots(listApps({ crowHome: home }), [g]), []);
});

test("remote blocks never count", async () => {
  sdb.prepare("INSERT INTO dashboard_settings VALUES ('feature_flags', ?)").run(JSON.stringify({ remote_invocation: true }));
  const def = { tools: { crow_mcp: [], remote_mcp: ["abcdef1234567890::browser"] } };
  const g = await grantedServers(db, def, { knownServers: ["browser"] });
  assert.equal(g.size, 0);
  // the exact remote name is what is excluded, not a "crow-remote-" prefix
  const real = await grantedServers(db, { tools: { crow_mcp: ["crow-remote-notmine/x"] } });
  assert.deepEqual([...real], ["crow-remote-notmine"]);
  assert.deepEqual(appsForBots(listApps({ crowHome: home }), [g]), []);
});

test("a bot with no crow_mcp gets no apps", async () => {
  seedBot("bare", { tools: { pi_builtin: ["read", "bash"] } });
  assert.deepEqual(await appsForProject(db, 1, { crowHome: home }), []);
});

test("appsForProject unions the project's bots", async () => {
  seedBot("a", { tools: { crow_mcp: ["browser/browser_navigate"] } });
  seedBot("b", { tools: { crow_mcp: ["notes-srv/x"] } });
  seedBot("c", { tools: { crow_mcp: ["ntfy/x"] } }, 2);
  const apps = await appsForProject(db, 1, { crowHome: home });
  assert.deepEqual(apps.map((x) => x.id).sort(), ["browser", "notes"]);
});

test("the catalog is cached for 30 s", () => {
  let t = 1000;
  _setClock(() => t);
  const first = listApps({ crowHome: home });
  install(["browser"]);
  try {
    t += 29_000;
    assert.equal(listApps({ crowHome: home }), first);
    assert.ok(Object.isFrozen(first));
    t += 2_000;
    assert.deepEqual(listApps({ crowHome: home }).map((a) => a.id), ["browser"]);
  } finally {
    install(ALL);
  }
});

test("invalidateAppCatalog drops the cache", () => {
  const first = listApps({ crowHome: home });
  install(["browser"]);
  try {
    assert.equal(listApps({ crowHome: home }), first);
    invalidateAppCatalog();
    assert.deepEqual(listApps({ crowHome: home }).map((a) => a.id), ["browser"]);
  } finally {
    install(ALL);
  }
});

test("browser manifest declares mcpServers and desktop", () => {
  const mf = JSON.parse(readFileSync(join(REPO, "bundles/browser/manifest.json"), "utf8"));
  assert.deepEqual(mf.mcpServers, ["browser", "crow-browser"]);
  assert.deepEqual(mf.desktop, { path: "vnc.html", lease: true });
  execFileSync(process.execPath, ["scripts/build-registry.mjs", "--check"], { cwd: REPO, stdio: "pipe" });
});
