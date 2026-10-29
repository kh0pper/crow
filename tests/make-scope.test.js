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
  // Cards live in tasks.db: 7 is open, 10 is archived (and still has a document linked to it).
  const tdb = new Database(process.env.CROW_TASKS_DB_PATH);
  tdb.exec("CREATE TABLE IF NOT EXISTS tasks_items (id INTEGER PRIMARY KEY, title TEXT, status TEXT, project_id INTEGER, action_needed TEXT, data_json TEXT, board_id INTEGER, archived_at TEXT)");
  tdb.prepare("INSERT INTO tasks_items (id, title, status) VALUES (7, 'Seven', 'open')").run();
  tdb.prepare("INSERT INTO tasks_items (id, title, status) VALUES (9, 'Nine', 'open')").run();
  tdb.prepare("INSERT INTO tasks_items (id, title, status, archived_at) VALUES (10, 'Old card', 'done', '2026-10-01 00:00:00')").run();
  tdb.close();
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
  const r = await get("/dashboard/make?project=garden&scope=all&filter=documents");
  assert.equal(r.status, 200);
  assert.match(r.body, /<div class="mk-scope-chips" role="group" aria-label="Show">/);
  assert.doesNotMatch(r.body, /<nav class="mk-scope-chips"/);
  assert.match(r.body, /href="\/dashboard\/make\?scope=all&amp;filter=documents" aria-current="true"/);
  assert.match(r.body, /mk-chip mk-chip-on" href="\/dashboard\/make\?scope=all&amp;filter=documents" aria-current="true"/, "the type row marks its chip the same way");
  assert.doesNotMatch(r.body, /mk-(scope-)?chip[^"]*" href="[^"]*" aria-current="page"/);
  // Spec §5.5: the scope row is the first row, the type filters the second.
  assert.ok(r.body.indexOf('class="mk-scope-chips"') < r.body.indexOf('class="mk-bar"'), "scope row first");
  assert.doesNotMatch(r.body, /class="mk-scope-chip[^"]*"[^>]*>This card</);
  assert.match(r.body, /href="\/dashboard\/make\?scope=all&amp;filter=pages"/);
});

test("card scope passes cardRefs, shows the header, and writes no cookie", async () => {
  seen = [];
  seam({ items: [item({ ref: "art_card001" })], ...OK });
  // The shell sets its mode cookie on a first visit; send it back so only a scope write could show.
  const first = await get("/dashboard/make");
  const mode = /^(crow_mode_[0-9a-f]+)=([^;]*)/.exec(first.setCookie || "");
  const jar = mode ? { ...NEW, [mode[1]]: mode[2] } : NEW;
  const r = await get("/dashboard/make?scope=card:7", jar);
  assert.equal(r.status, 200);
  assert.ok(seen.at(-1).opts.cardRefs.has("artifact:art_card001"));
  assert.ok(!seen.at(-1).opts.cardRefs.has("artifact:art_other01"));
  assert.match(r.body, /Documents for #7/);
  assert.match(r.body, /This card/);
  assert.match(r.body, /href="\/dashboard\/make\?scope=card%3A7" aria-current="true"/);
  assert.equal(r.setCookie, null, "a scope GET sets no cookie at all");
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

test("This project shows when a project chip is set and hides otherwise; the card title is escaped", async () => {
  seam({ items: [item()], ...OK });
  const plain = await get("/dashboard/make");
  assert.doesNotMatch(plain.body, /scope=project/);
  const proj = await get("/dashboard/make?project=garden");
  assert.match(proj.body, /href="\/dashboard\/make\?scope=project" aria-current="true">Garden</);
  const all = await get("/dashboard/make?project=garden&scope=all");
  assert.match(all.body, /scope=all&amp;filter=pages|href="\/dashboard\/make\?scope=all" aria-current="true"/);
  // The card title comes from tasks.db and is bot text: it must be escaped.
  const { createDbClient } = await import("../servers/db.js");
  const t = createDbClient(process.env.CROW_TASKS_DB_PATH);
  await t.execute("CREATE TABLE IF NOT EXISTS tasks_items (id INTEGER PRIMARY KEY, title TEXT, status TEXT, project_id INTEGER, action_needed TEXT, data_json TEXT, board_id INTEGER)");
  await t.execute({ sql: "INSERT OR REPLACE INTO tasks_items (id,title,status) VALUES (7, ?, 'open')", args: ["<b>x</b>&"] });
  t.close();
  const r = await get("/dashboard/make?scope=card:7");
  assert.match(r.body, /Documents for #7 &lt;b&gt;x&lt;\/b&gt;&amp;/);
  assert.doesNotMatch(r.body, /<b>x<\/b>/);
});

test("card mode reaches a document older than any recent-list cap and files only the card's rows", async () => {
  const { listMakeItems } = await import("../servers/gateway/make/sources.js");
  const { createDbClient } = await import("../servers/db.js");
  const db = createDbClient();
  const home = join(dir, "h2");
  for (const b of ["artifacts", "workspace"]) {
    mkdirSync(join(home, "bundles", b, "server", "nc"), { recursive: true });
    writeFileSync(join(home, "bundles", b, "manifest.json"), "{}");
  }
  writeFileSync(join(home, "installed.json"), JSON.stringify([{ id: "artifacts" }, { id: "workspace" }]));
  writeFileSync(join(home, "bundles", "workspace", "server", "config.js"), "export const getConfig = () => ({});");
  writeFileSync(join(home, "bundles", "workspace", "server", "nc", "dav.js"), "export const stat = async () => null; export const listRecent = async () => { throw new Error('listRecent must not be used'); };");
  for (let i = 0; i < 70; i++) {
    await db.execute({ sql: "INSERT INTO artifacts (id,title,type,current_version,updated_at) VALUES (?,?,'page',1,'2026-10-01 00:00:00')", args: [`art_new${String(i).padStart(4, "0")}`, `n${i}`] });
  }
  await db.execute("INSERT INTO artifacts (id,title,type,current_version,updated_at) VALUES ('art_oldest1','Old','page',1,'2020-01-01 00:00:00')");
  const count = async () => Number((await db.execute("SELECT COUNT(*) c FROM shell_items WHERE item_kind='artifact'")).rows[0].c);
  const before = await count();
  const docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const wsStat = async (cfg, { file_id }) => (file_id === 41 ? { fileId: 41, name: "Brief.docx", mime: docx, modified: "2026-10-02T00:00:00.000Z", isFolder: false } : null);
  const m = await listMakeItems(db, { projectId: 999 }, { crowHome: home, wsStat, cardRefs: new Set(["artifact:art_oldest1", "workspace_file:41", "workspace_file:42"]) });
  assert.deepEqual(m.items.map((i) => `${i.kind}:${i.ref}`).sort(), ["artifact:art_oldest1", "workspace_file:41"]);
  assert.equal(m.items.find((i) => i.kind === "workspace_file").title, "Brief.docx");
  assert.equal(await count() - before, 1, "only the card's own artifact got filed");
  db.close();
});

test("en and es strings", async () => {
  const { t } = await import("../servers/gateway/dashboard/shared/i18n.js");
  for (const k of ["shell.makeScopeLabel", "shell.makeScopeCard", "shell.makeScopeAll", "shell.makeCardHeader", "shell.makeCardEmpty"]) {
    assert.ok(t(k, "en") && t(k, "en") !== k, k);
    assert.ok(t(k, "es") && t(k, "es") !== t(k, "en"), `${k} es`);
  }
});

// ── Final review fix wave ──

test("the Unassigned shell scope stays Unassigned: a project-kind scope with its own chip", async () => {
  assert.deepEqual(make.parseMakeScope({}, { unassigned: true }), { kind: "project", scope: { unassigned: true } });
  assert.equal(make.parseMakeScope({ scope: "all" }, { unassigned: true }).kind, "all");
  seen = [];
  seam({ items: [], ...OK });
  const r = await get("/dashboard/make?project=unassigned");
  assert.deepEqual(seen.at(-1).scope, { unassigned: true }, "the lister gets the Unassigned scope, not all");
  assert.match(r.body, /href="\/dashboard\/make\?scope=project" aria-current="true">Unassigned</);
  const { createDbClient } = await import("../servers/db.js");
  const { writeSetting } = await import("../servers/gateway/dashboard/settings/registry.js");
  const sdb = createDbClient();
  await writeSetting(sdb, "language", "es");
  let es;
  try { es = await get("/dashboard/make?project=unassigned"); } finally { await writeSetting(sdb, "language", "en"); sdb.close(); }
  assert.match(es.body, /href="\/dashboard\/make\?scope=project" aria-current="true">Sin asignar</, "es chip label");
});

test("no scope row when All would be its only chip", async () => {
  seam({ items: [item()], ...OK });
  for (const path of ["/dashboard/make", "/dashboard/make?scope=all", "/dashboard/make?project=all"]) {
    const r = await get(path);
    assert.doesNotMatch(r.body, /class="mk-scope-chips"/, path);
    assert.match(r.body, /class="mk-chips"/, `${path}: the type filters still show`);
  }
});

test("the previews back link keeps ?card= like the chips do", async () => {
  seam({ items: [item()], ...OK });
  const r = await get("/dashboard/make?card=7&filter=pages");
  assert.match(r.body, /name="back" value="\/dashboard\/make\?card=7&amp;filter=pages"/);
  const c = await get("/dashboard/make?scope=card:7");
  assert.match(c.body, /name="back" value="\/dashboard\/make\?scope=card%3A7"/);
});

// A Workspace bundle stub under CROW_HOME: create tools, mkcol and stat read globalThis.__scopeWs.
function stubWorkspace(home) {
  const ws = join(home, "bundles", "workspace", "server");
  mkdirSync(join(ws, "tools"), { recursive: true });
  mkdirSync(join(ws, "nc"), { recursive: true });
  writeFileSync(join(home, "bundles", "workspace", "manifest.json"), "{}");
  writeFileSync(join(home, "installed.json"), JSON.stringify([{ id: "workspace" }]));
  const w = (f, s) => writeFileSync(join(ws, f), s);
  w("config.js", "export function getConfig() { return { webBase: 'https://ws.example.test' }; }");
  w("server.js", "export const realClock = { now: () => 0 };");
  w("tools/common.js", "export function toPublic(e, cfg) { return { file_id: e.fileId, web_url: cfg.webBase + '/f/' + e.fileId }; }");
  w("nc/dav.js", `export async function mkcol() { return true; }
export async function listRecent() { return []; }
export async function stat(cfg, { file_id }) {
  const s = globalThis.__scopeWs;
  if (s.fail) { const e = new Error("boom"); e.code = s.fail; throw e; }
  const f = s.files.get(file_id);
  if (!f) { const e = new Error("gone"); e.code = "not_found"; throw e; }
  return f;
}`);
  const def = (name, exportName) => `export const ${exportName} = [{ name: "${name}", run: async (args) => { const s = globalThis.__scopeWs; s.next += 1; s.files.set(s.next, { fileId: s.next, name: args.title + ".docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", modified: "2026-10-28T10:00:00.000Z", isFolder: false }); s.folders.push(args.folder); return { created: true, file_id: s.next }; } }];`;
  w("tools/docs.js", def("ws_docs_create", "docsWriteDefs"));
  w("tools/sheets.js", def("ws_sheets_create", "sheetsDefs"));
  w("tools/slides.js", def("ws_slides_create", "slidesDefs"));
}

test("a blank document started on This card lands on the card, filed under the CARD's project", async () => {
  make._setMakeSeamsForTest();
  globalThis.__scopeWs = { files: new Map(), next: 300, folders: [], fail: null };
  stubWorkspace(process.env.CROW_HOME);
  const { createDbClient } = await import("../servers/db.js");
  const db = createDbClient();
  await db.execute("INSERT INTO project_spaces (slug, name, type, status) VALUES ('kitchen','Kitchen','general','active')");
  const kitchen = Number((await db.execute("SELECT id FROM project_spaces WHERE slug='kitchen'")).rows[0].id);
  const garden = Number((await db.execute("SELECT id FROM project_spaces WHERE slug='garden'")).rows[0].id);
  const tdb = createDbClient(process.env.CROW_TASKS_DB_PATH);
  await tdb.execute("CREATE TABLE IF NOT EXISTS tasks_items (id INTEGER PRIMARY KEY, title TEXT, status TEXT, project_id INTEGER, action_needed TEXT, data_json TEXT, board_id INTEGER)");
  await tdb.execute({ sql: "INSERT OR REPLACE INTO tasks_items (id,title,status,project_id) VALUES (8,'Menu card','open',?)", args: [kitchen] });
  tdb.close();
  try {
    // The shell chip says Garden; the card lives in Kitchen. The sheet starts in the card's project.
    const page = await get("/dashboard/make?project=garden&scope=card:8");
    assert.match(page.body, /Documents for #8 Menu card/);
    assert.match(page.body, new RegExp(`<dialog id="mk-start" class="mk-sheet" data-project="${kitchen}" data-card="8"`));
    assert.match(page.body, /<span class="mk-project-chip" data-mk-chip>Kitchen<\/span>/);
    assert.match(page.body, /This card has no documents yet/);
    // The client posts the card with the blank document; the server validates and links it.
    const post = (body) => fetch(base + "/dashboard/make-api/blank", { method: "POST", headers: { ...NET, "content-type": "application/json", cookie: "crow_session=new-sess; crow_csrf=tok", "x-crow-csrf": "tok" }, body: JSON.stringify(body) });
    const bad = await post({ kind: "docx", title: "Nope", project_id: garden, card_id: 99999 });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error, "bad_card");
    assert.equal(globalThis.__scopeWs.next, 300, "an unknown card creates nothing");
    assert.equal((await post({ kind: "docx", title: "Nope", card_id: "8" })).status, 400, "card_id must be a number");
    const r = await post({ kind: "docx", title: "Shopping list", project_id: kitchen, card_id: 8 });
    assert.equal(r.status, 200);
    const out = await r.json();
    assert.equal(out.ok, true);
    assert.equal(out.filed, true);
    assert.deepEqual(globalThis.__scopeWs.folders, ["Crow/kitchen"]);
    const row = (await db.execute({ sql: "SELECT project_id, card_id FROM shell_items WHERE item_kind='workspace_file' AND item_ref=?", args: [String(out.fileId)] })).rows[0];
    assert.equal(Number(row.project_id), kitchen, "filed under the card's project");
    assert.equal(Number(row.card_id), 8, "linked to the card");
    const after = await get("/dashboard/make?project=garden&scope=card:8");
    assert.match(after.body, /Shopping list\.docx/, "it shows in the card's This card view");
    assert.doesNotMatch(after.body, /This card has no documents yet/);
    // A card id from the client outranks project_id: the card decides the filing.
    const r2 = await post({ kind: "docx", title: "Second", project_id: garden, card_id: 8 });
    const id2 = (await r2.json()).fileId;
    const row2 = (await db.execute({ sql: "SELECT project_id FROM shell_items WHERE item_kind='workspace_file' AND item_ref=?", args: [String(id2)] })).rows[0];
    assert.equal(Number(row2.project_id), kitchen);
    // Outside card mode the sheet carries no card.
    const plain = await get("/dashboard/make?project=garden");
    assert.doesNotMatch(plain.body, /data-card=/);
  } finally {
    db.close();
  }
});

test("card mode: a Workspace error that is not not_found shows Workspace unavailable, not the empty line", async () => {
  make._setMakeSeamsForTest();
  globalThis.__scopeWs = { files: new Map(), next: 400, folders: [], fail: null };
  stubWorkspace(process.env.CROW_HOME);
  const { createDbClient } = await import("../servers/db.js");
  const db = createDbClient();
  const { setItemCard } = await import("../servers/shared/shell-items.js");
  await setItemCard(db, "workspace_file", "777", 9);
  db.close();
  globalThis.__scopeWs.fail = "forbidden";
  const r = await get("/dashboard/make?scope=card:9");
  assert.ok(r.body.includes("Workspace can&#39;t be reached right now.") || r.body.includes("Workspace can't be reached right now."));
  assert.doesNotMatch(r.body, /This card has no documents yet/);
  // A file that is simply gone (not_found) is skipped: the card is empty, and says so.
  globalThis.__scopeWs.fail = null;
  const gone = await get("/dashboard/make?scope=card:9");
  assert.match(gone.body, /This card has no documents yet/);
  assert.doesNotMatch(gone.body, /can(&#39;|')t be reached/);
});

test("card mode Workspace lookups: at most 50 ids, four at a time, one deadline, first hard error stops", async () => {
  const { listMakeItems } = await import("../servers/gateway/make/sources.js");
  const { createDbClient } = await import("../servers/db.js");
  const db = createDbClient();
  const home = process.env.CROW_HOME;
  const refs = new Set(Array.from({ length: 60 }, (_, i) => `workspace_file:${i + 1}`));
  // Bounded: 60 ids give 50 lookups, never more than 4 at once.
  let calls = 0, inFlight = 0, peak = 0;
  const counted = async () => { calls++; inFlight++; peak = Math.max(peak, inFlight); await new Promise((r) => setTimeout(r, 2)); inFlight--; throw Object.assign(new Error("gone"), { code: "not_found" }); };
  const m = await listMakeItems(db, { all: true }, { crowHome: home, cardRefs: refs, wsStat: counted });
  assert.equal(calls, 50);
  assert.ok(peak <= 4 && peak >= 2, `peak ${peak}`);
  assert.equal(m.workspace, "installed");
  // The first error that is not not_found/bad_ref: unavailable, and no more lookups start.
  calls = 0;
  const failing = async () => { calls++; throw Object.assign(new Error("boom"), { code: "forbidden" }); };
  const f = await listMakeItems(db, { all: true }, { crowHome: home, cardRefs: refs, wsStat: failing });
  assert.equal(f.workspace, "unavailable");
  assert.ok(calls <= 4, `stopped after the first failures (${calls})`);
  // A bad_ref is skipped like a missing file.
  const badRef = await listMakeItems(db, { all: true }, { crowHome: home, cardRefs: new Set(["workspace_file:5"]), wsStat: async () => { throw Object.assign(new Error("x"), { code: "bad_ref" }); } });
  assert.equal(badRef.workspace, "installed");
  // A slow Workspace hits the one overall deadline and counts as unavailable.
  const t0 = Date.now();
  const slow = await listMakeItems(db, { all: true }, { crowHome: home, cardRefs: refs, wsStat: () => new Promise(() => {}), wsDeadlineMs: 80 });
  assert.equal(slow.workspace, "unavailable");
  assert.ok(Date.now() - t0 < 2000, "one deadline, not one per lookup");
  db.close();
});

test("an archived card shows the empty This card view with no start sheet", async () => {
  const { createDbClient } = await import("../servers/db.js");
  const { setItemCard } = await import("../servers/shared/shell-items.js");
  const db = createDbClient();
  await setItemCard(db, "artifact", "art_other01", 10);
  db.close();
  seen = [];
  seam({ items: [], ...OK });
  const r = await get("/dashboard/make?scope=card:10");
  assert.equal(r.status, 200);
  assert.equal(seen.at(-1).opts.cardRefs.size, 0, "nothing of an archived card is listed");
  assert.match(r.body, /This card has no documents yet/);
  assert.doesNotMatch(r.body, /id="mk-start"/);
  assert.doesNotMatch(r.body, /class="btn btn-primary mk-start-btn"/);
  const live = await get("/dashboard/make?scope=card:7");
  assert.match(live.body, /<dialog id="mk-start"[^>]* data-card="7"/, "a live card keeps its sheet");
});

test("a card with more than 50 Workspace files says only the first 50 show", async () => {
  const { listMakeItems } = await import("../servers/gateway/make/sources.js");
  const { createDbClient } = await import("../servers/db.js");
  const db = createDbClient();
  const docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const refs = new Set(Array.from({ length: 60 }, (_, i) => `workspace_file:${i + 1}`));
  const wsStat = async (cfg, { file_id }) => ({ fileId: file_id, name: `f${file_id}.docx`, mime: docx, modified: "2026-10-02T00:00:00.000Z", isFolder: false });
  const m = await listMakeItems(db, { all: true }, { crowHome: process.env.CROW_HOME, cardRefs: refs, wsStat });
  assert.equal(m.wsCapped, 50);
  assert.equal(m.items.length, 50);
  const few = await listMakeItems(db, { all: true }, { crowHome: process.env.CROW_HOME, cardRefs: new Set(["workspace_file:1"]), wsStat });
  assert.equal(few.wsCapped, undefined);
  db.close();
  seam({ items: [item()], ...OK, wsCapped: 50 });
  const r = await get("/dashboard/make?scope=card:7");
  assert.match(r.body, /Showing the first 50 of this card(&#39;|')s Workspace files\./);
  const plain = await get("/dashboard/make");
  assert.doesNotMatch(plain.body, /Showing the first 50/);
  const { t } = await import("../servers/gateway/dashboard/shared/i18n.js");
  assert.notEqual(t("shell.makeCardCapped", "es"), t("shell.makeCardCapped", "en"));
});
