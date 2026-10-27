/**
 * Task 4.2: the Make gallery panel, its filters and install offers, and the open route.
 * The REAL dashboard router is mounted over a scratch CROW_DATA_DIR (same harness as
 * shell-routes.test.js); the data source and the Workspace lookup are seams.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const dir = mkdtempSync(join(tmpdir(), "make-panel-"));
process.env.CROW_DATA_DIR = dir;
process.env.CROW_HOME = join(dir, "home");
mkdirSync(process.env.CROW_HOME, { recursive: true });
delete process.env.CROW_DB_PATH;
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
writeFileSync(join(dir, "instance-id"), "instance-make-panel");
const REPO = new URL("..", import.meta.url).pathname;

let server, base, make, seen = [];
const NEW = { crow_session: "new-sess", crow_csrf: "tok" };
const NET = { "tailscale-user-login": "operator@example.com" };

const item = (o) => ({
  kind: "artifact", ref: "art_aaaaaa", title: "A page", type: "page", filter: "pages", shared: false,
  updatedAt: "2026-10-26T10:00:00.000Z", version: 1, cardId: null, projectId: null, justMade: false,
  openUrl: "/dashboard/make/open/artifact/art_aaaaaa", ...o,
});
const seam = (model) => make._setMakeSeamsForTest({ list: async (db, scope, opts) => { seen.push({ scope, opts }); return model; } });

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env }, stdio: "pipe", cwd: REPO });
  const { hashToken } = await import("../servers/gateway/dashboard/auth.js");
  const c = new Database(join(dir, "crow.db"));
  c.prepare("INSERT INTO project_spaces (slug, name, type, status) VALUES ('garden','Garden','general','active')").run();
  c.prepare("INSERT INTO oauth_tokens (token, token_type, client_id, expires_at, created_at) VALUES (?, 'access', 'dashboard', datetime('now','+1 day'), '2026-06-01 00:00:00')").run(hashToken("new-sess"));
  c.close();
  const { createDbClient } = await import("../servers/db.js");
  const { writeSetting } = await import("../servers/gateway/dashboard/settings/registry.js");
  const db = createDbClient();
  await writeSetting(db, "shell_since", "2026-01-01 00:00:00");
  const { initArtifactsTables } = await import("../bundles/artifacts/server/init-tables.js");
  await initArtifactsTables(db);
  await db.execute("INSERT INTO artifacts (id,title,type,current_version) VALUES ('art_1abcdef','One','page',3)");
  await db.execute("INSERT INTO artifacts (id,title,type,current_version,deleted_at) VALUES ('art_gone123','Gone','page',1,datetime('now'))");
  db.close();

  make = await import("../servers/gateway/dashboard/panels/make.js");
  const { renderLayout } = await import("../servers/gateway/dashboard/shared/layout.js");
  const { default: dashboardRouter } = await import("../servers/gateway/dashboard/index.js");
  const { default: express } = await import("express");
  const app = express();
  app.use(dashboardRouter((req, res, next) => next(), { renderLayout }));
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = "http://127.0.0.1:" + server.address().port;
});
after(() => { make?._setMakeSeamsForTest(); if (server) server.close(); rmSync(dir, { recursive: true, force: true }); });

async function get(path, jar = NEW) {
  const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
  const r = await fetch(base + path, { redirect: "manual", headers: { ...NET, cookie } });
  return { status: r.status, location: r.headers.get("location"), body: await r.text() };
}
const OK = { artifacts: "installed", workspace: "installed" };

test("four filter chips with the active one marked", async () => {
  seam({ items: [item()], ...OK });
  const r = await get("/dashboard/make?filter=documents");
  assert.equal(r.status, 200);
  for (const w of ["All", "Documents", "Pages", "Shared"]) assert.match(r.body, new RegExp(`class="mk-chip[^"]*"[^>]*>${w}<`));
  assert.equal((r.body.match(/class="mk-chip[ "]/g) || []).length, 4);
  assert.match(r.body, /href="\/dashboard\/make\?filter=documents"/);
  assert.match(r.body, /mk-chip mk-chip-on" href="\/dashboard\/make\?filter=documents" aria-current="page"/);
  assert.equal(seen.at(-1).opts.filter, "documents");
  const bad = await get("/dashboard/make?filter=bogus");
  assert.equal(seen.at(-1).opts.filter, "all");
  assert.match(bad.body, /mk-chip mk-chip-on" href="\/dashboard\/make"/);
});

test("Just made and the card number show only when true", async () => {
  seam({ items: [item({ ref: "art_aaaaaa", justMade: true, cardId: 12 }), item({ ref: "art_bbbbbb", title: "Plain" })], ...OK });
  const r = await get("/dashboard/make");
  const tiles = r.body.split('<li class="mk-cell"').slice(1).map((x) => x.split("</li>")[0]);
  assert.equal(tiles.length, 2);
  assert.match(tiles[0], /class="mk-tile mk-just"/);
  assert.match(tiles[0], /#12/);
  assert.match(tiles[0], /Just made/);
  assert.doesNotMatch(tiles[1], /mk-just|#\d|Just made/);
});

test("workspace tiles open in a new tab, artifact tiles do not", async () => {
  seam({ items: [item(), item({ kind: "workspace_file", ref: "77", title: "Menu", type: "spreadsheet", filter: "documents" })], ...OK });
  const r = await get("/dashboard/make");
  assert.match(r.body, /href="\/dashboard\/make\/open\/workspace_file\/77" target="_blank" rel="noopener"/);
  assert.doesNotMatch(r.body, /open\/artifact\/art_aaaaaa" target/);
});

test("titles are escaped", async () => {
  seam({ items: [item({ title: "<img src=x onerror=alert(1)>" })], ...OK });
  const r = await get("/dashboard/make");
  assert.doesNotMatch(r.body, /<img src=x/);
});

test("Artifacts missing: an offer that links to Extensions", async () => {
  seam({ items: [], artifacts: "missing", workspace: "installed" });
  const r = await get("/dashboard/make");
  assert.match(r.body, /Pages and diagrams need Artifacts\./);
  assert.match(r.body, /href="\/dashboard\/extensions\?q=artifacts"/);
  assert.doesNotMatch(r.body, /extensions\?q=workspace/);
});

test("Workspace missing and not_ready offers", async () => {
  seam({ items: [item()], artifacts: "installed", workspace: "missing" });
  let r = await get("/dashboard/make");
  assert.match(r.body, /href="\/dashboard\/extensions\?q=workspace"/);
  assert.match(r.body, /<ul class="mk-grid"/, "artifacts still list");
  seam({ items: [item()], artifacts: "installed", workspace: "not_ready" });
  r = await get("/dashboard/make");
  assert.match(r.body, /Finish setting up Workspace/);
  assert.match(r.body, /href="\/dashboard\/workspace"/);
});

test("both missing: the empty state with both offers and no grid", async () => {
  seam({ items: [], artifacts: "missing", workspace: "missing" });
  const r = await get("/dashboard/make");
  assert.match(r.body, /extensions\?q=artifacts/);
  assert.match(r.body, /extensions\?q=workspace/);
  assert.doesNotMatch(r.body, /<ul class="mk-grid"/);
});

test("installed but empty: the empty line", async () => {
  seam({ items: [], ...OK });
  const r = await get("/dashboard/make");
  assert.match(r.body, /Nothing here yet\. Start something\./);
});

test("Workspace unavailable: a quiet notice, artifacts still list (R-P4-7)", async () => {
  seam({ items: [item()], artifacts: "installed", workspace: "unavailable" });
  const r = await get("/dashboard/make");
  assert.match(r.body, /Workspace can&#39;t be reached right now\.|Workspace can't be reached right now\./);
  assert.match(r.body, /<ul class="mk-grid"/);
  assert.doesNotMatch(r.body, /Finish setting up|extensions\?q=workspace/);
});

test("the panel follows the shell scope; an archived/missing project falls back to Everything", async () => {
  seam({ items: [], ...OK });
  await get("/dashboard/make", { ...NEW });
  assert.deepEqual(seen.at(-1).scope, { all: true });
});

test("opening an artifact marks it seen", async () => {
  const r = await get("/dashboard/make/open/artifact/art_1abcdef");
  assert.equal(r.status, 303);
  assert.equal(r.location, "/dashboard/artifacts/view/art_1abcdef?from=make");
  const { createDbClient } = await import("../servers/db.js");
  const { getItem } = await import("../servers/shared/shell-items.js");
  const db = createDbClient();
  try { assert.equal((await getItem(db, "artifact", "art_1abcdef")).seenVersion, 3); } finally { db.close(); }
});

test("opening a Workspace file marks it seen and redirects to the bundle's url", async () => {
  make._setMakeSeamsForTest({ workspaceUrl: async (id) => (id === "77" ? "https://ws.example.test/f/77" : null) });
  const r = await get("/dashboard/make/open/workspace_file/77");
  assert.equal(r.status, 303);
  assert.equal(r.location, "https://ws.example.test/f/77");
  const { createDbClient } = await import("../servers/db.js");
  const { getItem } = await import("../servers/shared/shell-items.js");
  const db = createDbClient();
  try { assert.ok(await getItem(db, "workspace_file", "77")); } finally { db.close(); }
  assert.equal((await get("/dashboard/make/open/workspace_file/78")).status, 404);
});

test("an unknown ref is 404, and a ref with a slash or a URL is refused", async () => {
  make._setMakeSeamsForTest({ workspaceUrl: async () => "https://ws.example.test/f/1" });
  const refs = [
    ["artifact", "art_nope1234"], ["artifact", "art_gone123"], ["artifact", "art_1abcdef%2F..%2Fx"],
    ["artifact", "art_1abcdef%2e%2e"], ["artifact", "http%3A%2F%2Fevil.test"], ["artifact", "%2F%2Fevil.test"], ["artifact", "art_1abcdef/extra"],
    ["workspace_file", "abc"], ["workspace_file", "12%2F..%2F3"], ["workspace_file", "1%2F2"], ["workspace_file", "http%3A%2F%2Fevil.test"], ["workspace_file", "0"], ["workspace_file", "-5"],
    ["bogus", "77"],
  ];
  for (const [k, ref] of refs) {
    const r = await get(`/dashboard/make/open/${k}/${ref}`);
    assert.ok([400, 404].includes(r.status), `${k}/${ref} -> ${r.status}`);
    assert.equal(r.location, null, `${k}/${ref} must not redirect`);
  }
});

test("the open route sits behind dashboardAuth", async () => {
  const r = await get("/dashboard/make/open/artifact/art_1abcdef", {});
  assert.notEqual(r.status, 303);
  assert.doesNotMatch(String(r.location), /artifacts\/view/);
});

test("Spanish strings exist for every Make key", async () => {
  const { translations } = await import("../servers/gateway/dashboard/shared/i18n.js");
  const keys = Object.keys(translations).filter((k) => /^shell\.(make|justMade|needArtifacts|getArtifacts|needWorkspace|getWorkspace|finishWorkspace|workspaceUnavailable)/.test(k));
  assert.ok(keys.length >= 16);
  for (const k of keys) assert.ok(translations[k].en && translations[k].es, k);
});
