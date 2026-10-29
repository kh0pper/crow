import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { actAsServe, serveHeaders } from "./fixtures/serve-peer.mjs";

actAsServe();
const dir = mkdtempSync(join(tmpdir(), "make-scope-"));
process.env.CROW_DATA_DIR = dir;
process.env.CROW_DB_PATH = join(dir, "crow.db");
process.env.CROW_HOME = join(dir, "home");
mkdirSync(process.env.CROW_HOME, { recursive: true });
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
writeFileSync(join(dir, "instance-id"), "instance-make-scope");
const REPO = new URL("..", import.meta.url).pathname;

let server, base, make, seen = [];
const NEW = { crow_session: "new-sess", crow_csrf: "tok" };
const NET = serveHeaders("operator@example.com");
const OK = { artifacts: "installed", workspace: "installed" };
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
  await db.execute("INSERT INTO artifacts (id,title,type,current_version,origin_card) VALUES ('art_card001','Card doc','page',1,7)");
  await db.execute("INSERT INTO artifacts (id,title,type,current_version) VALUES ('art_other01','Other','page',1)");
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
  return { status: r.status, setCookie: r.headers.get("set-cookie"), body: await r.text() };
}

test("parseMakeScope: card, all, project default, invalid card id", () => {
  const proj = { projectId: 2, slug: "p2" };
  assert.deepEqual(make.parseMakeScope({ scope: "card:12" }, proj), { kind: "card", cardId: "12" });
  assert.deepEqual(make.parseMakeScope({ scope: "all" }, proj), { kind: "all" });
  assert.deepEqual(make.parseMakeScope({}, proj), { kind: "project", scope: proj });
  assert.deepEqual(make.parseMakeScope({}, { all: true }), { kind: "all" });
  assert.equal(make.parseMakeScope({ scope: "card:0" }, proj).kind, "project");
  assert.equal(make.parseMakeScope({ scope: "card:abc" }, { all: true }).kind, "all");
  assert.equal(make.parseMakeScope({ scope: ["card:1"] }, { all: true }).kind, "all");
});

test("card scope lists only the card's documents and ignores the project scope", async () => {
  const { listMakeItems } = await import("../servers/gateway/make/sources.js");
  const { createDbClient } = await import("../servers/db.js");
  const db = createDbClient();
  const home = join(dir, "h");
  mkdirSync(join(home, "bundles", "artifacts"), { recursive: true });
  writeFileSync(join(home, "bundles", "artifacts", "manifest.json"), "{}");
  writeFileSync(join(home, "installed.json"), JSON.stringify([{ id: "artifacts" }]));
  const m = await listMakeItems(db, { projectId: 999 }, { crowHome: home, cardRefs: new Set(["artifact:art_card001"]) });
  assert.deepEqual(m.items.map((i) => i.ref), ["art_card001"]);
  const none = await listMakeItems(db, { all: true }, { crowHome: home, cardRefs: new Set() });
  assert.equal(none.items.length, 0);
  db.close();
});

test("scope and filter combine; the active chip has aria-current; chips are links", async () => {
  seam({ items: [item()], ...OK });
  const r = await get("/dashboard/make?scope=all&filter=documents");
  assert.equal(r.status, 200);
  assert.match(r.body, /<nav class="mk-scope-chips" role="group" aria-label="Show">/);
  assert.match(r.body, /href="\/dashboard\/make\?scope=all&amp;filter=documents" aria-current="page"/);
  assert.doesNotMatch(r.body, /This card/);
  assert.match(r.body, /href="\/dashboard\/make\?scope=all&amp;filter=pages"/);
});

test("card scope passes cardRefs, shows the header, and writes no cookie", async () => {
  seen = [];
  seam({ items: [item({ ref: "art_card001" })], ...OK });
  const r = await get("/dashboard/make?scope=card:7");
  assert.equal(r.status, 200);
  assert.ok(seen.at(-1).opts.cardRefs.has("artifact:art_card001"));
  assert.ok(!seen.at(-1).opts.cardRefs.has("artifact:art_other01"));
  assert.match(r.body, /Documents for #7/);
  assert.match(r.body, /This card/);
  assert.match(r.body, /href="\/dashboard\/make\?scope=card%3A7" aria-current="page"/);
  assert.ok(!r.setCookie || !/crow_project|scope/i.test(r.setCookie), "no project cookie");
});

test("?card= alone shows the This card chip but stays on the default scope", async () => {
  const r = await get("/dashboard/make?card=7");
  assert.match(r.body, /scope=card%3A7/);
  assert.doesNotMatch(r.body, /Documents for #7/);
});

test("unknown card shows the empty line", async () => {
  seam({ items: [], ...OK });
  const r = await get("/dashboard/make?scope=card:99999");
  assert.match(r.body, /This card has no documents yet/);
});

test("en and es strings", async () => {
  const { t } = await import("../servers/gateway/dashboard/shared/i18n.js");
  for (const k of ["shell.makeScopeLabel", "shell.makeScopeCard", "shell.makeScopeAll", "shell.makeCardHeader", "shell.makeCardEmpty"]) {
    assert.ok(t(k, "en") && t(k, "en") !== k, k);
    assert.ok(t(k, "es") && t(k, "es") !== t(k, "en"), `${k} es`);
  }
});
