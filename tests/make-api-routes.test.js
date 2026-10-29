/**
 * Task 4.3: "Start something". POST /dashboard/make-api/blank files a blank Workspace document in the
 * current project; the Start sheet offers install instead of actions for a missing bundle; the
 * composer pre-fills the type's starter text. The Workspace bundle is a stub dir under CROW_HOME
 * (the same dynamic-import path the real code uses), recording what the create tools were given.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { parseHTML } from "linkedom";

const dir = mkdtempSync(join(tmpdir(), "make-api-routes-"));
process.env.CROW_DATA_DIR = dir;
const HOME = join(dir, "home");
process.env.CROW_HOME = HOME;
mkdirSync(HOME, { recursive: true });
delete process.env.CROW_DB_PATH;
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
const REPO = new URL("..", import.meta.url).pathname;

let server, base, db, getItem, P1;
const WS = join(HOME, "bundles", "workspace");
const rec = () => globalThis.__mkStub;

function installWorkspace(on) {
  writeFileSync(join(HOME, "installed.json"), JSON.stringify(on ? [{ id: "workspace" }] : []));
}
function stubBundle() {
  mkdirSync(join(WS, "server", "tools"), { recursive: true });
  mkdirSync(join(WS, "server", "nc"), { recursive: true });
  writeFileSync(join(WS, "manifest.json"), "{}");
  const w = (f, s) => writeFileSync(join(WS, "server", f), s);
  w("config.js", `export function getConfig() { const s = globalThis.__mkStub; if (s.notReady) { const e = new Error("not ready"); e.code = "not_ready"; throw e; } return { webBase: "https://ws.example.test" }; }`);
  w("server.js", `export const realClock = { now: () => 0 };`);
  w("tools/common.js", `export function toPublic(e, cfg) { return { file_id: e.fileId, web_url: cfg.webBase + "/f/" + e.fileId }; }`);
  w("nc/dav.js", `export async function mkcol(cfg, segs) { globalThis.__mkStub.mkcols.push(segs); return true; }`);
  const def = (name, exportName) => `export const ${exportName} = [{ name: "${name}", run: async (args, ctx) => { const s = globalThis.__mkStub; if (s.badPath) { const e = new Error("bad"); e.code = "bad_path"; throw e; } s.calls.push({ name: "${name}", args, ctx }); s.next += 1; return { created: true, file_id: s.next }; } }];`;
  w("tools/docs.js", def("ws_docs_create", "docsWriteDefs"));
  w("tools/sheets.js", def("ws_sheets_create", "sheetsDefs"));
  w("tools/slides.js", def("ws_slides_create", "slidesDefs"));
}

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: REPO });
  const c = new Database(join(dir, "crow.db"));
  P1 = Number(c.prepare("INSERT INTO project_spaces (slug, name) VALUES ('garden','Garden')").run().lastInsertRowid);
  c.close();
  stubBundle();
  ({ getItem } = await import("../servers/shared/shell-items.js"));
  const { createDbClient } = await import("../servers/db.js");
  db = createDbClient();
  const { makeApiRouter } = await import("../servers/gateway/routes/make-api.js");
  const { csrfMiddleware } = await import("../servers/gateway/dashboard/shared/csrf.js");
  const { parseCookies } = await import("../servers/gateway/dashboard/auth.js");
  const { default: express } = await import("express");
  const auth = (req, res, next) => (parseCookies(req).crow_session === "good" ? next() : res.redirect("/dashboard/login"));
  const app = express();
  app.use("/dashboard", csrfMiddleware);
  app.use(makeApiRouter(auth));
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = "http://127.0.0.1:" + server.address().port + "/dashboard/make-api";
});
after(() => { if (server) server.close(); try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => { globalThis.__mkStub = { calls: [], mkcols: [], next: 40, notReady: false }; installWorkspace(true); });

const AUTHED = { cookie: "crow_session=good; crow_csrf=tok", "x-crow-csrf": "tok" };
async function post(path, body, headers = AUTHED) {
  const r = await fetch(base + path, { method: "POST", redirect: "manual", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}

test("a blank document is filed in the project", async () => {
  const r = await post("/blank", { kind: "docx", title: "Plan", project_id: P1 });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.fileId, 41);
  assert.equal(r.body.filed, true);
  assert.equal(r.body.webUrl, "https://ws.example.test/f/41");
  assert.equal((await getItem(db, "workspace_file", "41")).projectId, P1);
  const call = rec().calls[0];
  assert.equal(call.name, "ws_docs_create");
  assert.deepEqual(call.args, { folder: "Crow/garden", title: "Plan", content: "", find_existing: false });
  assert.equal(typeof call.ctx.getConfig, "function");
  assert.deepEqual(rec().mkcols, [["Crow"], ["Crow", "garden"]]);
});

test("sheets and decks spell out every argument; no project means Unassigned", async () => {
  let r = await post("/blank", { kind: "xlsx", title: "Budget" });
  assert.equal(r.status, 200);
  assert.deepEqual(rec().calls[0].args, { folder: "Crow/Unassigned", title: "Budget", find_existing: false });
  assert.equal((await getItem(db, "workspace_file", String(r.body.fileId))).projectId, null);
  r = await post("/blank", { kind: "pptx", title: "Pitch", project_id: "unassigned" });
  assert.equal(r.status, 200);
  assert.deepEqual(rec().calls[1].args, { title: "Pitch", folder: "Crow/Unassigned" });
});

test("a filing failure after a successful create reports filed:false", async () => {
  // A project archived between the check and the filing can't be simulated cheaply; drop the table instead.
  const c = new Database(join(dir, "crow.db"));
  c.exec("ALTER TABLE shell_items RENAME TO shell_items_off");
  try {
    const r = await post("/blank", { kind: "docx", title: "Orphan", project_id: P1 });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.filed, false);
  } finally { c.exec("ALTER TABLE shell_items_off RENAME TO shell_items"); c.close(); }
});

// ── This card: card_id on Blank ──
async function cardStore() {
  const t = new Database(process.env.CROW_TASKS_DB_PATH);
  t.exec("CREATE TABLE IF NOT EXISTS tasks_items (id INTEGER PRIMARY KEY, title TEXT, status TEXT, project_id INTEGER, action_needed TEXT, data_json TEXT, board_id INTEGER, archived_at TEXT)");
  const c = new Database(join(dir, "crow.db"));
  const old = c.prepare("SELECT id FROM project_spaces WHERE slug='shed'").get()
    || { id: Number(c.prepare("INSERT INTO project_spaces (slug, name, status) VALUES ('shed','Shed','archived')").run().lastInsertRowid) };
  c.close();
  const put = t.prepare("INSERT OR REPLACE INTO tasks_items (id, title, status, project_id, board_id, archived_at) VALUES (?, ?, 'open', ?, NULL, ?)");
  put.run(21, "Live card", P1, null);
  put.run(22, "Archived card", P1, "2026-10-01 00:00:00");
  put.run(23, "Card in an archived project", old.id, null);
  put.run(24, "Card whose link fails", null, null);
  t.close();
}

test("card_id: a bad, archived or missing card is 400 bad_card and creates nothing", async () => {
  await cardStore();
  for (const card_id of ["21", 0, -3, 1.5, 99999, 22]) {
    const r = await post("/blank", { kind: "docx", title: "Nope", project_id: P1, card_id });
    assert.equal(r.status, 400, `card_id ${JSON.stringify(card_id)}`);
    assert.equal(r.body.error, "bad_card", `card_id ${JSON.stringify(card_id)}`);
  }
  assert.equal(rec().calls.length, 0, "nothing was created");
  assert.deepEqual(rec().mkcols, []);
});

test("card_id: the card's project overrides a posted project_id, and the file is linked to the card", async () => {
  await cardStore();
  const r = await post("/blank", { kind: "docx", title: "On the card", project_id: "unassigned", card_id: 21 });
  assert.equal(r.status, 200);
  assert.equal(r.body.filed, true);
  assert.deepEqual(rec().calls[0].args.folder, "Crow/garden");
  const it = await getItem(db, "workspace_file", String(r.body.fileId));
  assert.equal(it.projectId, P1);
  assert.equal(it.cardId, 21);
});

test("card_id: a card whose project is not live files Unassigned, still on the card", async () => {
  await cardStore();
  const r = await post("/blank", { kind: "docx", title: "Shed list", project_id: P1, card_id: 23 });
  assert.equal(r.status, 200);
  assert.equal(rec().calls[0].args.folder, "Crow/Unassigned");
  const it = await getItem(db, "workspace_file", String(r.body.fileId));
  assert.equal(it.projectId, null);
  assert.equal(it.cardId, 23);
});

test("card_id: a link failure after the create reports filed:false", async () => {
  await cardStore();
  const c = new Database(join(dir, "crow.db"));
  rec().next = 900; // a file id no earlier test used
  c.exec("CREATE TRIGGER mk_link_fail BEFORE UPDATE OF card_id ON shell_items WHEN NEW.card_id = 24 BEGIN SELECT RAISE(ABORT, 'link refused'); END;");
  try {
    const r = await post("/blank", { kind: "docx", title: "Unlinked", card_id: 24 });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.filed, false);
    assert.equal(rec().calls.length, 1, "the file was created");
    assert.equal((await getItem(db, "workspace_file", String(r.body.fileId))).cardId, null);
  } finally { c.exec("DROP TRIGGER mk_link_fail"); c.close(); }
});

test("Blank never re-files an existing document", async () => {
  const a = await post("/blank", { kind: "docx", title: "Same" });
  const b = await post("/blank", { kind: "docx", title: "Same" });
  assert.notEqual(a.body.fileId, b.body.fileId);
  assert.ok(rec().calls.every((c) => c.args.find_existing === false));
});

test("Workspace missing is 409 and names it; not ready is its own 409", async () => {
  installWorkspace(false);
  let r = await post("/blank", { kind: "docx", title: "X" });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "workspace_missing");
  assert.equal(rec().calls.length, 0);
  installWorkspace(true);
  rec().notReady = true;
  r = await post("/blank", { kind: "docx", title: "X" });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "workspace_not_ready");
});

test("a bad kind, an empty or long title, or a bad project is 400", async () => {
  for (const body of [
    { kind: "pdf", title: "X" }, { title: "X" }, { kind: "docx", title: "   " }, { kind: "docx" },
    { kind: "docx", title: "x".repeat(201) }, { kind: "docx", title: 5 }, { kind: "docx", title: "X", project_id: 99999 }, { kind: "docx", title: "X", project_id: "abc" },
  ]) {
    const r = await post("/blank", body);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 60));
  }
  assert.equal(rec().calls.length, 0);
  assert.equal((await post("/blank", { kind: "docx", title: "x".repeat(200) })).status, 200);
});

test("a title with a slash or backslash is 400 bad_title, and a tool bad_path maps to 400", async () => {
  for (const title of ["a/b", "a\\b", "../x"]) {
    const r = await post("/blank", { kind: "docx", title });
    assert.equal(r.status, 400, title);
    assert.equal(r.body.error, "bad_title");
  }
  assert.equal(rec().calls.length, 0);
  rec().badPath = true;
  const r = await post("/blank", { kind: "docx", title: "Fine" });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "bad_title");
});

test("CSRF is required, and so is a session", async () => {
  const noCsrf = await post("/blank", { kind: "docx", title: "X" }, { cookie: "crow_session=good; crow_csrf=tok" });
  assert.equal(noCsrf.status, 403);
  const noSession = await post("/blank", { kind: "docx", title: "X" }, { cookie: "crow_csrf=tok", "x-crow-csrf": "tok" });
  assert.notEqual(noSession.status, 200);
  assert.equal(rec().calls.length, 0);
});

// ── the Start sheet and composer ──
const { renderMakePage } = await import("../servers/gateway/dashboard/panels/make/html.js");
const { makeClientJs } = await import("../servers/gateway/dashboard/panels/make/client.js");
const { tJs } = await import("../servers/gateway/dashboard/shared/i18n.js");
const { MAKE_CSS: MAKE_CSS_FOR_TEST } = await import("../servers/gateway/dashboard/panels/make/css.js");

const page = (model, project = { id: "unassigned", name: "Unassigned" }) => renderMakePage({ model: { items: [], ...model }, filter: "all", lang: "en", project, projects: [] });

test("the sheet offers install instead of actions for a missing bundle", () => {
  const html = page({ artifacts: "installed", workspace: "missing" });
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  const row = document.querySelector('[data-mk-row="document"]');
  assert.ok(row);
  const link = row.querySelector("a[href]");
  assert.equal(link.getAttribute("href"), "/dashboard/extensions?q=workspace");
  assert.equal(row.querySelector("[data-mk-blank]"), null);
  assert.equal(row.querySelector("[data-mk-type]"), null);
  const pageRow = document.querySelector('[data-mk-row="page"]');
  assert.ok(pageRow.querySelector('[data-mk-type="page"]'));
  assert.equal(pageRow.querySelector("[data-mk-blank]"), null, "pages have no Blank");
  const docs = parseHTML(`<html><body>${page({ artifacts: "installed", workspace: "installed" })}</body></html>`).document;
  assert.equal(docs.querySelectorAll("[data-mk-blank]").length, 3);
  const nr = parseHTML(`<html><body>${page({ artifacts: "installed", workspace: "not_ready" })}</body></html>`).document;
  assert.equal(nr.querySelector('[data-mk-row="deck"] a[href]').getAttribute("href"), "/dashboard/workspace");
});

function bootClient(model, bots = [{ id: "b1", name: "Bee", perch_attached: true }, { id: "b2", name: "Off", perch_attached: false }], opts = {}) {
  const html = renderMakePage({ model: { items: [], ...model }, filter: "all", lang: "en", project: { id: P1, name: "Garden" }, projects: [{ id: 2, slug: "g", name: "Garden" }, { id: 3, slug: "o", name: "Orchard" }], startCard: opts.card ?? null });
  const { window, document } = parseHTML(`<html><body>${html}</body></html>`);
  const calls = [];
  Object.defineProperty(document, "cookie", { configurable: true, get: () => "crow_session=s; crow_csrf=tok123" });
  const loc = { href: "/dashboard/make", hash: "", reload() {} };
  let opened = 0;
  window.open = () => { opened += 1; };
  const ctx = vm.createContext({
    window, document, console, location: loc, open: () => { opened += 1; }, setTimeout, clearTimeout,
    fetch: async (url, init) => {
      const c = { url: String(url), method: (init && init.method) || "GET", headers: (init && init.headers) || {}, body: init && init.body ? JSON.parse(init.body) : null };
      calls.push(c);
      let data = {};
      if (c.url.endsWith("/perch-api/bots")) data = { bots };
      else if (c.url.endsWith("/interactive")) data = { threadId: "perchlive-t9", sessionId: "perchlive-t9" };
      else if (c.url.endsWith("/message")) data = { turnId: "t1" };
      else if (c.url.startsWith("/api/artifacts/")) data = { artifact: { id: "art_abc123", current_version: (opts.versions || [1])[0] }, versions: (opts.versions || [1]).map((n) => ({ n })) };
      else if (c.url.includes("/shell-api/items/")) data = { ok: true };
      else if (c.url.endsWith("/make-api/blank")) data = opts.blank || { ok: true, fileId: 5, webUrl: "https://ws.example.test/f/5" };
      return { ok: true, status: 200, json: async () => data };
    },
  });
  const m = makeClientJs("en").match(/<script>([\s\S]*)<\/script>/);
  delete window.__mkBound; // linkedom windows share props; a real page load starts clean
  vm.runInContext(m[1], ctx);
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
  const click = (el) => el.dispatchEvent(new window.Event("click", { bubbles: true }));
  return { ctx, rerun: () => vm.runInContext(m[1], ctx), window, document, calls, loc, opened: () => opened, settle, click, $: (s) => document.querySelector(s) };
}

test("makeClientJs has no backticks (it is a template literal)", () => {
  const s = makeClientJs("en");
  assert.equal(s.includes("`"), false);
});

test("the composer starts from the type's text", async () => {
  const c = bootClient({ artifacts: "installed", workspace: "installed" });
  c.click(c.$('[data-mk-type="page"]'));
  await c.settle();
  assert.equal(c.$("[data-mk-field]").value, tJs("shell.startPage"));
  assert.equal(c.$("[data-mk-field]").value, "Make a page to ");
  assert.match(c.$("[data-mk-chip]").textContent, /Garden/);
  c.click(c.$('[data-mk-pill="diagram"]'));
  assert.equal(c.$("[data-mk-field]").value, "Draw a diagram of ");
  // only Perch-attached bots are offered
  const opts = [...c.document.querySelectorAll("[data-mk-bot] option")].map((o) => o.value);
  assert.deepEqual(opts, ["b1"]);
});

test("submitting starts a chat in the project, sends the text, then goes to the thread", async () => {
  const c = bootClient({ artifacts: "installed", workspace: "installed" });
  c.click(c.$('[data-mk-type="document"]'));
  await c.settle();
  c.$("[data-mk-field]").value = "Write a document about bees";
  c.click(c.$("[data-mk-submit]"));
  await c.settle();
  const posts = c.calls.filter((x) => x.method === "POST");
  assert.equal(posts[0].url, "/dashboard/perch-api/bots/b1/interactive");
  assert.deepEqual(posts[0].body, { project_id: P1 });
  assert.equal(posts[0].headers["X-Crow-Csrf"], "tok123");
  assert.equal(posts[1].url, "/dashboard/perch-api/interactive/perchlive-t9/message");
  assert.deepEqual(posts[1].body, { message: "Write a document about bees" });
  assert.equal(c.loc.href, "/dashboard/perch#perchlive-t9");
});

test("Blank posts the title and project to make-api", async () => {
  const c = bootClient({ artifacts: "installed", workspace: "installed" });
  c.click(c.$('[data-mk-blank="docx"]'));
  await c.settle();
  c.$("[data-mk-title]").value = "Notes";
  c.click(c.$("[data-mk-submit]"));
  await c.settle();
  const p = c.calls.find((x) => x.url === "/dashboard/make-api/blank");
  assert.deepEqual(p.body, { kind: "docx", title: "Notes", project_id: P1 });
  assert.equal(p.headers["X-Crow-Csrf"], "tok123");
  assert.equal(c.loc.href, "https://ws.example.test/f/5", "same tab goes to the file");
  assert.equal(c.opened(), 0, "no popup");
});

test("on This card, Blank posts the card too; a chat started there carries only the card's project", async () => {
  const c = bootClient({ artifacts: "installed", workspace: "installed" }, undefined, { card: "8" });
  c.click(c.$('[data-mk-blank="docx"]'));
  await c.settle();
  c.$("[data-mk-title]").value = "Notes";
  c.click(c.$("[data-mk-submit]"));
  await c.settle();
  assert.deepEqual(c.calls.find((x) => x.url === "/dashboard/make-api/blank").body, { kind: "docx", title: "Notes", project_id: P1, card_id: 8 });
  const chat = bootClient({ artifacts: "installed", workspace: "installed" }, undefined, { card: "8" });
  chat.click(chat.$('[data-mk-type="document"]'));
  await chat.settle();
  chat.$("[data-mk-field]").value = "Write it";
  chat.click(chat.$("[data-mk-submit]"));
  await chat.settle();
  assert.deepEqual(chat.calls.find((x) => x.url.endsWith("/interactive")).body, { project_id: P1 }, "the interactive API takes no card");
});

test("on This card, filed:false says the file is not on the card before opening it (en and es)", async () => {
  const { makeClientJs: js } = await import("../servers/gateway/dashboard/panels/make/client.js");
  assert.ok(js("es").includes(tJs("shell.makeNotOnCard", "es")));
  assert.notEqual(tJs("shell.makeNotOnCard", "es"), tJs("shell.makeNotOnCard", "en"));
  const c = bootClient({ artifacts: "installed", workspace: "installed" }, undefined, { card: "8", blank: { ok: true, fileId: 5, webUrl: "https://ws.example.test/f/5", filed: false } });
  c.click(c.$('[data-mk-blank="docx"]'));
  await c.settle();
  c.$("[data-mk-title]").value = "Notes";
  c.click(c.$("[data-mk-submit]"));
  await c.settle();
  assert.equal(c.$("[data-mk-status]").textContent, "Created, but not added to the card. Open the card to add it.");
  assert.equal(c.loc.href, "/dashboard/make", "it waits so the notice can be read");
  await new Promise((r) => setTimeout(r, 3200));
  assert.equal(c.loc.href, "https://ws.example.test/f/5", "then opens the file");
  // filed:true on a card goes straight to the file.
  const ok = bootClient({ artifacts: "installed", workspace: "installed" }, undefined, { card: "8", blank: { ok: true, fileId: 6, webUrl: "https://ws.example.test/f/6", filed: true } });
  ok.click(ok.$('[data-mk-blank="docx"]'));
  await ok.settle();
  ok.$("[data-mk-title]").value = "Fine";
  ok.click(ok.$("[data-mk-submit]"));
  await ok.settle();
  assert.equal(ok.loc.href, "https://ws.example.test/f/6");
});

// ── Task 4.4: versions stay visible ──
const ART = { kind: "artifact", ref: "art_abc123", type: "page", title: "Garden plan", updatedAt: "2026-10-26T12:00:00Z", version: 3 };
const WSF = { kind: "workspace_file", ref: "77", type: "document", title: "Notes", updatedAt: "2026-10-26T12:00:00Z" };

test("every tile has a focusable, labelled more button and all targets are 44px", () => {
  const { document } = parseHTML(`<html><body>${page({ artifacts: "installed", workspace: "installed", items: [ART] })}</body></html>`);
  const b = document.querySelector("[data-mk-more]");
  assert.ok(b);
  assert.equal(b.tagName, "BUTTON");
  assert.match(b.getAttribute("aria-label"), /Garden plan/);
  assert.equal(document.querySelector("[data-mk-more]").closest("a"), null, "the button is not nested in the link");
  assert.match(MAKE_CSS_FOR_TEST, /\.mk-more\s*\{[^}]*min-height: 44px/);
});

test("the version line links to earlier versions when there are some", async () => {
  const c = bootClient({ artifacts: "installed", workspace: "installed", items: [ART] }, undefined, { versions: [3, 2, 1] });
  c.click(c.$("[data-mk-more]"));
  await c.settle();
  assert.ok(c.calls.some((x) => x.url === "/api/artifacts/art_abc123"));
  assert.match(c.$("[data-mk-vline]").textContent, /v3 \u00b7 earlier versions/);
  const links = [...c.document.querySelectorAll("[data-mk-vlink]")];
  assert.equal(links.length, 3);
  assert.equal(links[0].getAttribute("href"), "/dashboard/artifacts/view/art_abc123?v=3");
  assert.equal(links[2].getAttribute("href"), "/dashboard/artifacts/view/art_abc123?v=1");
});

test("a single version has no link", async () => {
  const c = bootClient({ artifacts: "installed", workspace: "installed", items: [ART] }, undefined, { versions: [1] });
  c.click(c.$("[data-mk-more]"));
  await c.settle();
  assert.equal(c.$("[data-mk-vline]").textContent.trim(), "v1");
  assert.equal(c.document.querySelectorAll("[data-mk-vlink]").length, 0);
  assert.equal(c.$("[data-mk-versions]").hasAttribute("hidden"), true);
});

test("a workspace tile shows Open and Move only, with no version fetch", async () => {
  const c = bootClient({ artifacts: "installed", workspace: "installed", items: [WSF] });
  c.click(c.$("[data-mk-more]"));
  await c.settle();
  assert.equal(c.calls.filter((x) => x.url.startsWith("/api/artifacts/")).length, 0);
  assert.equal(c.$("[data-mk-vline]").hasAttribute("hidden"), true);
  assert.equal(c.$("[data-mk-pv-open]").getAttribute("href"), "/dashboard/make/open/workspace_file/77");
});

test("Move to project posts the chosen project", async () => {
  const c = bootClient({ artifacts: "installed", workspace: "installed", items: [ART] });
  c.click(c.$("[data-mk-more]"));
  await c.settle();
  const sel = c.$("[data-mk-pv-project]");
  [...sel.options].find((o) => o.value === "2").setAttribute("selected", "");
  sel.selectedIndex = [...sel.options].findIndex((o) => o.value === "2");
  c.click(c.$("[data-mk-pv-move]"));
  await c.settle();
  const p = c.calls.find((x) => x.url === "/dashboard/shell-api/items/artifact/art_abc123/project");
  assert.deepEqual(p.body, { project_id: 2 });
  assert.equal(p.headers["X-Crow-Csrf"], "tok123");
});

test("a long press opens the sheet, but a scroll cancels it", async () => {
  const mk = () => bootClient({ artifacts: "installed", workspace: "installed", items: [ART] }, undefined, { versions: [2, 1] });
  const ev = (c, type, x, y) => c.$(".mk-tile").dispatchEvent(Object.assign(new c.window.Event(type, { bubbles: true }), { clientX: x, clientY: y }));
  let c = mk();
  ev(c, "pointerdown", 10, 10);
  await new Promise((r) => setTimeout(r, 650));
  await c.settle();
  assert.ok(c.calls.some((x) => x.url.startsWith("/api/artifacts/")), "long press opened the sheet");
  c = mk();
  ev(c, "pointerdown", 10, 10);
  ev(c, "pointermove", 10, 40);
  await new Promise((r) => setTimeout(r, 650));
  assert.equal(c.calls.length, 0, "movement cancelled it");
});

test("document listeners are bound once however many Turbo visits re-run the script", async () => {
  const c = bootClient({ artifacts: "installed", workspace: "installed", items: [ART] }, undefined, { versions: [2, 1] });
  c.rerun(); c.rerun();
  c.click(c.$("[data-mk-more]"));
  await c.settle();
  assert.equal(c.calls.filter((x) => x.url.startsWith("/api/artifacts/")).length, 1, "one click, one handler run");
});

test("Move starts on the item's current project, disabled until the choice differs", async () => {
  const c = bootClient({ artifacts: "installed", workspace: "installed", items: [{ ...ART, projectId: 3 }] });
  c.click(c.$("[data-mk-more]"));
  await c.settle();
  const sel = c.$("[data-mk-pv-project]");
  assert.equal(sel.options[sel.selectedIndex].value, "3");
  assert.equal(c.$("[data-mk-pv-move]").hasAttribute("disabled"), true);
  c.click(c.$("[data-mk-pv-move]"));
  await c.settle();
  assert.equal(c.calls.filter((x) => x.url.includes("/shell-api/")).length, 0, "no post for an unchanged choice");
  sel.selectedIndex = [...sel.options].findIndex((o) => o.value === "2");
  sel.dispatchEvent(new c.window.Event("change", { bubbles: true }));
  assert.equal(c.$("[data-mk-pv-move]").hasAttribute("disabled"), false);
  const u = bootClient({ artifacts: "installed", workspace: "installed", items: [ART] });
  u.click(u.$("[data-mk-more]"));
  await u.settle();
  const us = u.$("[data-mk-pv-project]");
  assert.equal(us.options[us.selectedIndex].value, "unassigned");
});

test("after a successful move the gallery refreshes in place", async () => {
  const c = bootClient({ artifacts: "installed", workspace: "installed", items: [ART] });
  const visits = [];
  c.window.Turbo = { visit: (u, o) => visits.push([u, o]) };
  c.click(c.$("[data-mk-more]"));
  await c.settle();
  const sel = c.$("[data-mk-pv-project]");
  sel.selectedIndex = [...sel.options].findIndex((o) => o.value === "2");
  c.click(c.$("[data-mk-pv-move]"));
  await c.settle();
  assert.match(c.$("[data-mk-pv-status]").textContent, /Moved/);
  await new Promise((r) => setTimeout(r, 750));
  assert.equal(JSON.stringify(visits), JSON.stringify([["/dashboard/make", { action: "replace" }]]));
});
