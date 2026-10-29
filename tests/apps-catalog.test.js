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

const { listApps, appsForBots, grantedServers, appsForProject, _resetCatalogCache, _setClock } =
  await import("../servers/gateway/apps/catalog.js");

const home = join(dir, "bundles-home");
function bundle(id, manifest) {
  mkdirSync(join(home, "bundles", id), { recursive: true });
  writeFileSync(join(home, "bundles", id, "manifest.json"), JSON.stringify({ id, name: id, ...manifest }));
}
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
  install(["browser", "ntfy", "notes", "plain"]);
});
after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  _resetCatalogCache(); _setClock(null);
  sdb = new Database(":memory:");
  sdb.exec(`CREATE TABLE pi_bot_defs (bot_id TEXT PRIMARY KEY, display_name TEXT, definition TEXT, enabled INTEGER DEFAULT 1, project_id INTEGER);
    CREATE TABLE dashboard_settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE dashboard_settings_overrides (key TEXT, instance_id TEXT, value TEXT);`);
});

test("listApps reads webUI, desktop and panel bundles", () => {
  const apps = listApps({ crowHome: home });
  assert.deepEqual(apps.map((a) => a.id).sort(), ["browser", "notes", "ntfy"]);
  const b = apps.find((a) => a.id === "browser");
  assert.equal(b.kind, "desktop");
  assert.equal(b.href, "/proxy/browser/vnc.html");
  assert.equal(b.desktopPath, "vnc.html");
  assert.equal(b.leaseDeclared, true);
  assert.deepEqual(b.mcpServers, ["browser", "crow-browser"]);
  const n = apps.find((a) => a.id === "notes");
  assert.equal(n.kind, "page");
  assert.equal(n.href, "/dashboard/notes");
  assert.equal(n.desktopPath, null);
});

test("direct-mode apps keep their own href", () => {
  const a = listApps({ crowHome: home }).find((x) => x.id === "ntfy");
  assert.equal(a.href, "http://{host}:2586/");
  assert.equal(a.kind, "page");
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

test("crow-core grants no bundle apps", async () => {
  const g = await grantedServers(db, { tools: { crow_mcp: ["crow-core/crow_store_memory"] } });
  assert.deepEqual(appsForBots(listApps({ crowHome: home }), [g]), []);
});

test("remote blocks never count", async () => {
  sdb.prepare("INSERT INTO dashboard_settings VALUES ('feature_flags', ?)").run(JSON.stringify({ remote_invocation: true }));
  const def = { tools: { crow_mcp: [], remote_mcp: ["abcdef1234567890::browser"] } };
  const g = await grantedServers(db, def);
  assert.equal(g.size, 0);
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
    t += 2_000;
    assert.deepEqual(listApps({ crowHome: home }).map((a) => a.id), ["browser"]);
  } finally {
    install(["browser", "ntfy", "notes", "plain"]);
  }
});

test("browser manifest declares mcpServers and desktop", () => {
  const mf = JSON.parse(readFileSync(join(REPO, "bundles/browser/manifest.json"), "utf8"));
  assert.deepEqual(mf.mcpServers, ["browser", "crow-browser"]);
  assert.deepEqual(mf.desktop, { path: "vnc.html", lease: true });
  assert.equal(mf.version, "1.3.11");
  execFileSync(process.execPath, ["scripts/build-registry.mjs", "--check"], { cwd: REPO, stdio: "pipe" });
});
