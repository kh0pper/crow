// R1.2 PR 5, Task 2: the apps launcher in the drawer, its API, and the
// Add-tile hook. The drawer markup is checked as rendered; the data comes from
// the real catalog (a temp CROW_HOME) over a real init-db'd crow.db; the API is
// mounted behind the real csrfMiddleware and a session-checking auth stub, as
// dashboard/index.js orders it. The live half is tests/apps-launcher-live.test.js.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const dir = mkdtempSync(join(tmpdir(), "shell-apps-launcher-"));
process.env.CROW_DATA_DIR = dir;
const HOME = join(dir, "home");
process.env.CROW_HOME = HOME;
mkdirSync(HOME, { recursive: true });
delete process.env.CROW_DB_PATH;
const DB_FILE = join(dir, "crow.db");
const REPO = new URL("..", import.meta.url).pathname;

function bundle(id, manifest) {
  mkdirSync(join(HOME, "bundles", id), { recursive: true });
  writeFileSync(join(HOME, "bundles", id, "manifest.json"), JSON.stringify({ id, name: id, ...manifest }));
}

let db, server, base, P_OWNED, P_VISITED, P_VIEWER, P_EMPTY;
let shellDrawer, launcherFor, registerLauncherTile, launcherTiles, _resetLauncherTiles, canManageProject, _resetCatalogCache;

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: REPO });
  bundle("browser", { icon: "monitor", webUI: { port: 6080, path: "/vnc.html", label: "Browser" }, desktop: { path: "vnc.html", lease: true }, mcpServers: ["browser"] });
  bundle("ntfy", { webUI: { port: 2586, path: "/", proxyMode: "direct", label: "Ntfy" }, mcpServers: ["ntfy"] });
  bundle("wiki", { icon: "book", webUI: { port: 7002, path: "/", label: "Wiki" }, mcpServers: ["wiki"] });
  writeFileSync(join(HOME, "installed.json"), JSON.stringify([{ id: "browser" }, { id: "ntfy" }, { id: "wiki" }]));

  const c = new Database(DB_FILE);
  const mk = (slug) => Number(c.prepare("INSERT INTO project_spaces (slug, name) VALUES (?,?)").run(slug, slug).lastInsertRowid);
  P_OWNED = mk("owned"); P_VISITED = mk("visited"); P_VIEWER = mk("viewer"); P_EMPTY = mk("empty");
  c.prepare("DELETE FROM project_members").run();
  c.prepare("INSERT INTO project_members (project_id, contact_id, role) VALUES (?, NULL, 'owner')").run(P_OWNED);
  c.prepare("INSERT INTO project_members (project_id, contact_id, role) VALUES (?, NULL, 'owner')").run(P_EMPTY);
  c.prepare("INSERT INTO project_members (project_id, contact_id, role) VALUES (?, NULL, 'viewer')").run(P_VIEWER);
  // The owned project's bot can use the browser; nothing grants the others.
  c.prepare("INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES ('b1','B1',?,1,?)")
    .run(JSON.stringify({ tools: { crow_mcp: ["browser/browser_navigate"] } }), P_OWNED);
  c.close();

  ({ shellDrawer } = await import("../servers/gateway/dashboard/shell/chrome.js"));
  ({ launcherFor } = await import("../servers/gateway/apps/launcher.js"));
  ({ registerLauncherTile, launcherTiles, _resetLauncherTiles, canManageProject } = await import("../servers/gateway/apps/extra-tiles.js"));
  ({ _resetCatalogCache } = await import("../servers/gateway/apps/catalog.js"));
  const { createDbClient } = await import("../servers/db.js");
  db = createDbClient();

  const { appsApiRouter } = await import("../servers/gateway/routes/apps-api.js");
  const { csrfMiddleware } = await import("../servers/gateway/dashboard/shared/csrf.js");
  const { parseCookies } = await import("../servers/gateway/dashboard/auth.js");
  const { default: express } = await import("express");
  const auth = (req, res, next) => (parseCookies(req).crow_session === "good" ? next() : res.redirect("/dashboard/login"));
  const app = express();
  app.use(express.json());
  const router = express.Router();
  router.use(auth);
  router.use(csrfMiddleware);
  router.use(appsApiRouter(auth));
  app.use(router);
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (db) db.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => { _resetLauncherTiles(); _resetCatalogCache(); });

const getPanel = () => null;
const projects = () => [{ id: P_OWNED, slug: "owned", name: "Owned" }, { id: P_EMPTY, slug: "empty", name: "Empty" }];
const scopeOf = (id, slug) => ({ projectId: id, slug });
const section = (html) => (html.match(/<section class="shell-apps".*?<\/section>/s) || [""])[0];

test("drawer lists This project and All apps", async () => {
  const apps = await launcherFor(db, scopeOf(P_OWNED, "owned"));
  const html = section(shellDrawer({ scope: scopeOf(P_OWNED, "owned"), projects: projects(), lang: "en", apps, getPanel }));
  assert.match(html, /<h3 class="shell-heading" id="shell-apps-title">Apps<\/h3>/);
  assert.match(html, /data-apps-view="project" aria-pressed="true">This project</);
  assert.match(html, /data-apps-view="all" aria-pressed="false">All apps</);
  // The project's grid is server-rendered: only the browser (its bot's grant).
  const grid = html.match(/data-apps-grid="project"[^>]*>(.*?)<\/div>/s)[1];
  assert.deepEqual([...grid.matchAll(/data-app-id="([^"]+)"/g)].map((m) => m[1]), ["browser"]);
  assert.match(grid, /href="\/proxy\/browser\/vnc.html" class="shell-app" data-app-id="browser" data-app-kind="desktop" data-turbo="false"/);
  assert.match(grid, /<span class="shell-app-icon" aria-hidden="true"><svg /, "the manifest's icon key, from the app-icons table");
  assert.match(html, /data-apps-grid="all" hidden><\/div>/, "All is fetched on switch, not rendered");

  // Everything: no This project, the All grid is rendered.
  const every = section(shellDrawer({ scope: { all: true }, projects: projects(), lang: "en", apps: await launcherFor(db, { all: true }), getPanel }));
  assert.doesNotMatch(every, /data-apps-view="project"/);
  assert.match(every, /data-apps-view="all" aria-pressed="true">All apps</);
  const es = section(shellDrawer({ scope: scopeOf(P_OWNED, "owned"), projects: projects(), lang: "es", apps, getPanel }));
  assert.match(es, />Este proyecto</);
  assert.match(es, />Todas las apps</);
  // No launcher data handed in (classic, older callers): no section.
  assert.equal(section(shellDrawer({ scope: { all: true }, projects: [], lang: "en", getPanel })), "");
});

test("All apps is the full catalog", async () => {
  const all = await launcherFor(db, { all: true });
  assert.equal(all.scope, "all");
  assert.deepEqual(all.apps.map((a) => a.id).sort(), ["browser", "ntfy", "wiki"]);
  const ntfy = all.apps.find((a) => a.id === "ntfy");
  assert.deepEqual([ntfy.kind, ntfy.href, ntfy.directPort, ntfy.path], ["page", "/dashboard/extensions", 2586, "/"], "a direct app: its fallback href + port and path");
  assert.ok(ntfy.icon.startsWith("<svg"), "no icon key: the generic glyph");
  const html = section(shellDrawer({ scope: { all: true }, projects: [], lang: "en", apps: all, getPanel }));
  assert.match(html, /data-app-id="ntfy" data-app-kind="page" data-direct-port="2586" data-direct-path="\/"/);
  // Unassigned lists everything too, and the API's project=all is the same list.
  assert.deepEqual((await launcherFor(db, { unassigned: true })).apps.map((a) => a.id).sort(), ["browser", "ntfy", "wiki"]);
  const r = await fetch(`${base}/dashboard/shell-api/apps?project=all`, { headers: { cookie: "crow_session=good" } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store");
  const body = await r.json();
  assert.deepEqual(body.apps.map((a) => a.id).sort(), ["browser", "ntfy", "wiki"]);
  for (const a of body.apps) assert.deepEqual(Object.keys(a).slice(0, 4), ["id", "label", "kind", "href"]);
  const proj = await (await fetch(`${base}/dashboard/shell-api/apps?project=owned`, { headers: { cookie: "crow_session=good" } })).json();
  assert.deepEqual(proj.apps.map((a) => a.id), ["browser"]);
  assert.equal(proj.projectSlug, "owned");
  const missing = await fetch(`${base}/dashboard/shell-api/apps?project=nope`, { headers: { cookie: "crow_session=good" } });
  assert.equal(missing.status, 404);
});

test("empty This project offers All apps", async () => {
  const apps = await launcherFor(db, scopeOf(P_EMPTY, "empty"));
  assert.deepEqual(apps.apps, []);
  const html = section(shellDrawer({ scope: scopeOf(P_EMPTY, "empty"), projects: projects(), lang: "en", apps, getPanel }));
  assert.match(html, /<p class="shell-apps-empty">No apps for this project(?:&#39;|')s bots yet · <button type="button" class="shell-apps-goto" data-apps-goto="all">All apps<\/button><\/p>/);
  const es = section(shellDrawer({ scope: scopeOf(P_EMPTY, "empty"), projects: projects(), lang: "es", apps, getPanel }));
  assert.match(es, /Los bots de este proyecto aún no tienen apps · <button[^>]*>Todas las apps</);
});

test("the apps API refuses a request without a session", async () => {
  const r = await fetch(`${base}/dashboard/shell-api/apps?project=all`, { redirect: "manual" });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("location"), "/dashboard/login");
});

test("canManage: true only for a live project the local owner owns", async () => {
  assert.equal(await canManageProject(db, { all: true }), false, "Everything");
  assert.equal(await canManageProject(db, { unassigned: true }), false, "Unassigned");
  assert.equal(await canManageProject(db, null), false, "no scope");
  assert.equal(await canManageProject(db, scopeOf(P_OWNED, "owned")), true, "owned");
  assert.equal(await canManageProject(db, scopeOf(P_VISITED, "visited")), false, "a visited project: no local-owner row");
  assert.equal(await canManageProject(db, scopeOf(P_VIEWER, "viewer")), false, "a local viewer row is not the owner");
});

test("launcher tiles: a stub registration renders after the app tiles, in order, by when(ctx)", async () => {
  const seen = [];
  registerLauncherTile({ id: "stub-a", labelKey: "shell.newProject", icon: "plus",
    when: (c) => { seen.push(c); return !!c.projectSlug && c.canManage; }, href: (c) => "/dashboard/project/" + c.projectSlug + "/a" });
  registerLauncherTile({ id: "stub-b", labelKey: "shell.more", icon: "nope", when: () => true, href: () => "/dashboard/b" });
  registerLauncherTile({ id: "stub-off-site", labelKey: "shell.more", when: () => true, href: () => "https://example.com/" });
  assert.throws(() => registerLauncherTile({ id: "stub-a", labelKey: "x", href: () => "/" }), /already registered/);

  const owned = await launcherFor(db, scopeOf(P_OWNED, "owned"));
  assert.deepEqual(owned.tiles.map((x) => [x.id, x.label, x.href]), [["stub-a", "New project", "/dashboard/project/owned/a"], ["stub-b", "More of Crow", "/dashboard/b"]]);
  assert.deepEqual({ ...seen.at(-1) }, { scope: "project", projectSlug: "owned", lang: "en", canManage: true });
  const visited = await launcherFor(db, scopeOf(P_VISITED, "visited"));
  assert.deepEqual(visited.tiles.map((x) => x.id), ["stub-b"], "canManage false hides stub-a");
  assert.deepEqual({ ...seen.at(-1) }, { scope: "project", projectSlug: "visited", lang: "en", canManage: false });
  await launcherFor(db, { all: true });
  assert.deepEqual({ ...seen.at(-1) }, { scope: "all", projectSlug: null, lang: "en", canManage: false });
  await launcherFor(db, { unassigned: true });
  assert.deepEqual({ ...seen.at(-1) }, { scope: "unassigned", projectSlug: null, lang: "en", canManage: false });

  const html = section(shellDrawer({ scope: scopeOf(P_OWNED, "owned"), projects: projects(), lang: "en", apps: owned, getPanel }));
  const order = [...html.matchAll(/data-(?:app-id|launcher-tile)="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ["browser", "stub-a", "stub-b"]);
  assert.match(html, /href="\/dashboard\/project\/owned\/a" class="shell-app shell-app--extra" data-launcher-tile="stub-a">/);
  // The API carries the same tiles (the session's apps sheet renders them).
  const body = await (await fetch(`${base}/dashboard/shell-api/apps?project=owned`, { headers: { cookie: "crow_session=good" } })).json();
  assert.deepEqual(body.tiles.map((x) => x.id), ["stub-a", "stub-b"]);
  assert.deepEqual(launcherTiles({ scope: "all", projectSlug: null, lang: "es", canManage: false }).map((x) => x.label), ["Más de Crow"]);
});

test("no tile registered: launcherFor never asks for canManage", async () => {
  let calls = 0;
  const spy = { execute: (q) => { if (/project_members/.test(q.sql)) calls++; return db.execute(q); } };
  const out = await launcherFor(spy, scopeOf(P_OWNED, "owned"));
  assert.deepEqual(out.tiles, []);
  assert.equal(calls, 0);
});

test("client code stays template-safe", async () => {
  const { readFileSync } = await import("node:fs");
  const { shellClientJs } = await import("../servers/gateway/dashboard/shell/client.js");
  const js = shellClientJs();
  assert.doesNotMatch(js, /`|\$\{/);
  assert.match(js, /crow:open-app-tile/);
  assert.match(js, /cancelable: true/);
  const src = readFileSync(join(REPO, "servers/gateway/dashboard/perch-hub/client.js"), "utf8");
  const appsPart = src.slice(src.indexOf("R1.2 PR 5: the session's apps sheet"), src.indexOf("Session tab: \"Change directory\""));
  assert.ok(appsPart.length > 100);
  assert.doesNotMatch(appsPart, /`|\$\{|localStorage/);
});
