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
  const def = (name, exportName) => `export const ${exportName} = [{ name: "${name}", run: async (args, ctx) => { const s = globalThis.__mkStub; s.calls.push({ name: "${name}", args, ctx }); s.next += 1; return { created: true, file_id: s.next }; } }];`;
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

const page = (model, project = { id: "unassigned", name: "Unassigned" }) => renderMakePage({ model: { items: [], ...model }, filter: "all", lang: "en", project });

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

function bootClient(model, bots = [{ id: "b1", name: "Bee", perch_attached: true }, { id: "b2", name: "Off", perch_attached: false }]) {
  const html = page(model, { id: P1, name: "Garden" });
  const { window, document } = parseHTML(`<html><body>${html}</body></html>`);
  const calls = [];
  Object.defineProperty(document, "cookie", { configurable: true, get: () => "crow_session=s; crow_csrf=tok123" });
  const loc = { href: "/dashboard/make", hash: "" };
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
      else if (c.url.endsWith("/make-api/blank")) data = { ok: true, fileId: 5, webUrl: "https://ws.example.test/f/5" };
      return { ok: true, status: 200, json: async () => data };
    },
  });
  const m = makeClientJs("en").match(/<script>([\s\S]*)<\/script>/);
  vm.runInContext(m[1], ctx);
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
  const click = (el) => el.dispatchEvent(new window.Event("click", { bubbles: true }));
  return { window, document, calls, loc, opened: () => opened, settle, click, $: (s) => document.querySelector(s) };
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
