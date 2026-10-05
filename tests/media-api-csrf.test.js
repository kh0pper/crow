/**
 * Media API — every state-changing /api/media/* route carries the gateway's
 * double-submit CSRF check, and every in-dashboard caller of those routes
 * sends the token.
 *
 * Server side: the REAL media router is mounted behind a pass-through auth
 * stub with a session cookie present. Each POST/DELETE/PATCH route must
 * answer 403 (and change nothing) without a matching X-Crow-Csrf header, and
 * reach its handler with one.
 *
 * Client side: the panel's script calls those routes with a bare fetch(); the
 * dashboard layout's fetch wrapper is what attaches the header. The REAL
 * layout scripts and the REAL panel scripts run in one vm context with a
 * crow_csrf cookie, every caller is driven, and each state-changing request
 * that reaches the network stub must carry the token.
 *
 * Env discipline: HOME, CROW_DATA_DIR and CROW_DB_PATH point at a scratch dir
 * BEFORE anything is imported, so nothing resolves to a real install.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import vm from "node:vm";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dir, "..");
const SCRATCH = mkdtempSync(join(tmpdir(), "media-api-csrf-"));

const savedEnv = {
  HOME: process.env.HOME,
  CROW_DATA_DIR: process.env.CROW_DATA_DIR,
  CROW_DB_PATH: process.env.CROW_DB_PATH,
  CROW_CSRF_STRICT: process.env.CROW_CSRF_STRICT,
};
process.env.HOME = SCRATCH;
process.env.CROW_DATA_DIR = SCRATCH;
process.env.CROW_DB_PATH = join(SCRATCH, "crow.db");
delete process.env.CROW_CSRF_STRICT; // strict (the default)

// The real core schema (schedules, settings, overrides): media 1.1.0's briefing routes use it.
const { execFileSync } = await import("node:child_process");
execFileSync(process.execPath, ["scripts/init-db.js"], { cwd: REPO_ROOT, stdio: "pipe", env: { ...process.env, CROW_HOME: SCRATCH, CROW_DATA_DIR: SCRATCH, CROW_DB_PATH: join(SCRATCH, "crow.db") } });

// Dynamic imports: static ones are hoisted above the env writes above.
const { createDbClient } = await import("../servers/db.js");
const { initMediaTables } = await import("../bundles/media/server/init-tables.js");
const { default: mediaRouter } = await import("../bundles/media/panel/routes.js");
const { default: panel } = await import("../bundles/media/panel/media.js");
const { renderLayout } = await import("../servers/gateway/dashboard/shared/layout.js");

const db = createDbClient();
await initMediaTables(db);
await db.execute(`CREATE TABLE IF NOT EXISTS dashboard_settings (key TEXT PRIMARY KEY, value TEXT)`);
await db.execute(`CREATE TABLE IF NOT EXISTS podcast_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, feed_url TEXT NOT NULL UNIQUE,
  title TEXT, description TEXT, image_url TEXT, last_fetched TEXT)`);

async function insert(sql, args = []) {
  return Number((await db.execute({ sql, args })).lastInsertRowid);
}
async function count(table, where = "1=1", args = []) {
  return Number((await db.execute({ sql: `SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, args })).rows[0].n);
}

const sourceId = await insert(
  "INSERT INTO media_sources (source_type, name, url) VALUES ('rss', 'Source', 'https://feeds.example.test/a.xml')");
const articleId = await insert(
  "INSERT INTO media_articles (source_id, guid, title) VALUES (?, 'g1', 'Article')", [sourceId]);

// ---------------------------------------------------------------------------
// Server: the real router, a pass-through auth stub, a session cookie.
// ---------------------------------------------------------------------------
const TOKEN = "csrf-test-token-0123456789abcdef";
const COOKIE = `crow_session=session-test-value; crow_csrf=${TOKEN}`;

const app = express();
app.use(express.json());
app.use(mediaRouter((req, res, next) => next()));
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;

after(() => {
  server.close();
  try { db.close(); } catch {}
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(SCRATCH, { recursive: true, force: true });
});

function call(method, path, body, { token } = {}) {
  const headers = { Cookie: COOKIE, "Content-Type": "application/json" };
  if (token !== undefined) headers["X-Crow-Csrf"] = token;
  return fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function expectRejected(method, path, body) {
  for (const token of [undefined, "wrong-token-0123456789abcdef0123"]) {
    const r = await call(method, path, body, { token });
    assert.equal(r.status, 403, `${method} ${path} with ${token ? "a wrong" : "no"} token must be refused`);
    assert.match(await r.text(), /CSRF token/);
  }
}

test("article action: refused without the token, applied with it", async () => {
  const path = `/api/media/articles/${articleId}/action`;
  await expectRejected("POST", path, { action: "star" });
  assert.equal(await count("media_article_states", "article_id = ? AND is_starred = 1", [articleId]), 0);
  const r = await call("POST", path, { action: "star" }, { token: TOKEN });
  assert.equal(r.status, 200);
  assert.equal(await count("media_article_states", "article_id = ? AND is_starred = 1", [articleId]), 1);
});

test("source add: refused without the token, reaches the handler with it", async () => {
  await expectRejected("POST", "/api/media/sources", { url: "https://feeds.example.test/new.xml" });
  assert.equal(await count("media_sources"), 1);
  // No url: the handler's own validation answers (no network fetch is made).
  const r = await call("POST", "/api/media/sources", {}, { token: TOKEN });
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { error: "URL is required" });
});

test("source refresh: refused without the token, reaches the handler with it", async () => {
  await expectRejected("POST", "/api/media/sources/999999/refresh");
  // Unknown source: the handler's own lookup answers (no network fetch is made).
  const r = await call("POST", "/api/media/sources/999999/refresh", undefined, { token: TOKEN });
  assert.equal(r.status, 404);
  assert.deepEqual(await r.json(), { error: "Not found" });
});

test("article listen: refused without the token, reaches the handler with it", async () => {
  await expectRejected("POST", `/api/media/articles/${articleId}/listen`);
  const r = await call("POST", `/api/media/articles/${articleId}/listen`, undefined, { token: TOKEN });
  // 503 when there is no local voice (CI, and this scratch instance); never the CSRF refusal.
  assert.ok([200, 500, 503].includes(r.status), `unexpected status ${r.status}`);
  const body = await r.json();
  assert.ok(body.audio_url || body.error, "a JSON answer from the handler");
});

test("briefing create: refused without the token, reaches the handler with it", async () => {
  await expectRejected("POST", "/api/media/briefings", { topic: "nomatch-zzz", audio: false });
  assert.equal(await count("media_briefings"), 0, "a refused request makes nothing");
  const r = await call("POST", "/api/media/briefings", { topic: "nomatch-zzz", audio: false }, { token: TOKEN });
  assert.equal(r.status, 202, "made in the background; answers at once");
  const b = await r.json();
  assert.ok(Number(b.id) > 0);
  assert.equal(b.kind, "manual");
  assert.equal(await count("media_briefings"), 1);
});

test("schedule save: refused without the token, reaches the handler with it", async () => {
  await expectRejected("POST", "/api/media/briefings/schedule", { time: "08:00" });
  assert.equal(await count("schedules", "task = 'media:briefing'"), 0);
  const r = await call("POST", "/api/media/briefings/schedule", { time: "08:00", enabled: true }, { token: TOKEN });
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  assert.equal(await count("schedules", "task = 'media:briefing'"), 1);
});

test("playlists: create, add, patch, remove item, delete are refused without the token and work with it", async () => {
  await expectRejected("POST", "/api/media/playlists", { name: "Mix" });
  assert.equal(await count("media_playlists"), 0);
  const created = await call("POST", "/api/media/playlists", { name: "Mix" }, { token: TOKEN });
  assert.equal(created.status, 200);
  const playlistId = Number((await created.json()).id);
  assert.ok(playlistId > 0);

  const itemsPath = `/api/media/playlists/${playlistId}/items`;
  await expectRejected("POST", itemsPath, { item_type: "article", item_id: articleId });
  assert.equal(await count("media_playlist_items"), 0);
  const added = await call("POST", itemsPath, { item_type: "article", item_id: articleId }, { token: TOKEN });
  assert.equal(added.status, 200);
  const itemRowId = Number((await db.execute({
    sql: "SELECT id FROM media_playlist_items WHERE playlist_id = ?", args: [playlistId] })).rows[0].id);

  const plPath = `/api/media/playlists/${playlistId}`;
  await expectRejected("PATCH", plPath, { visibility: "public" });
  assert.equal(await count("media_playlists", "id = ? AND visibility = 'public'", [playlistId]), 0);
  const patched = await call("PATCH", plPath, { visibility: "public" }, { token: TOKEN });
  assert.equal(patched.status, 200);
  assert.equal(await count("media_playlists", "id = ? AND visibility = 'public'", [playlistId]), 1);

  const itemPath = `${itemsPath}/${itemRowId}`;
  await expectRejected("DELETE", itemPath);
  assert.equal(await count("media_playlist_items", "id = ?", [itemRowId]), 1);
  const removed = await call("DELETE", itemPath, undefined, { token: TOKEN });
  assert.equal(removed.status, 200);
  assert.equal(await count("media_playlist_items", "id = ?", [itemRowId]), 0);

  await expectRejected("DELETE", plPath);
  assert.equal(await count("media_playlists", "id = ?", [playlistId]), 1);
  const deleted = await call("DELETE", plPath, undefined, { token: TOKEN });
  assert.equal(deleted.status, 200);
  assert.equal(await count("media_playlists", "id = ?", [playlistId]), 0);
});

test("source delete: refused without the token, applied with it", async () => {
  const doomed = await insert(
    "INSERT INTO media_sources (source_type, name, url) VALUES ('rss', 'Doomed', 'https://feeds.example.test/z.xml')");
  await expectRejected("DELETE", `/api/media/sources/${doomed}`);
  assert.equal(await count("media_sources", "id = ?", [doomed]), 1);
  const r = await call("DELETE", `/api/media/sources/${doomed}`, undefined, { token: TOKEN });
  assert.equal(r.status, 200);
  assert.equal(await count("media_sources", "id = ?", [doomed]), 0);
});

test("every state-changing /api/media route in the router is CSRF-gated", () => {
  const router = mediaRouter((req, res, next) => next());
  const mutating = router.stack
    .filter((l) => l.route && l.route.path.startsWith("/api/media/"))
    .flatMap((l) => Object.keys(l.route.methods).filter((m) => m !== "get" && m !== "head")
      .map((m) => ({ method: m, path: l.route.path, names: l.route.stack.map((s) => s.name) })));
  assert.equal(mutating.length, 12, "the route inventory this test covers");
  for (const r of mutating) {
    assert.ok(r.names.includes("csrfMiddleware"), `${r.method.toUpperCase()} ${r.path} lacks csrfMiddleware`);
  }
});

test("read-only routes still answer without a token", async () => {
  const r = await fetch(base + "/api/media/playlists", { headers: { Cookie: COOKIE } });
  assert.equal(r.status, 200);
});

// ---------------------------------------------------------------------------
// Client: the real layout + panel scripts in one vm context.
// ---------------------------------------------------------------------------
async function panelScripts() {
  let captured = null;
  await panel.handler({ method: "GET", query: { tab: "feed" }, body: {} }, {
    redirectAfterPost() { throw new Error("unexpected redirect on a GET"); },
  }, { db, appRoot: REPO_ROOT, layout: (opts) => { captured = opts; return ""; } });
  assert.ok(captured, "the panel renders through layout(), so the layout's scripts run first");
  return captured.scripts || "";
}

function fakeEl(extra = {}) {
  const el = {
    style: {}, textContent: "", disabled: false, children: [],
    appendChild(c) { el.children.push(c); return c; },
    remove() {}, contains() { return false; },
    closest() { return { remove() {} }; },
    ...extra,
  };
  return el;
}

test("panel callers: every state-changing request carries X-Crow-Csrf from the crow_csrf cookie", async () => {
  const html = renderLayout({ title: "Media", content: "", activePanel: "media", panels: [] });
  const layoutScripts = [...parseHTML(html).document.querySelectorAll("script")]
    .filter((s) => !s.getAttribute("src")).map((s) => s.textContent);

  const sent = [];
  const json = (url) => {
    if (/\/api\/media\/playlists$/.test(url)) return { playlists: [{ id: 7, name: "Mix" }] };
    if (/\/api\/media\/playlists\/\d+$/.test(url)) return { items: [{ item_id: 3, item_title: "A" }, { item_id: 4, item_title: "B" }] };
    if (/\/listen$/.test(url)) return { audio_url: url.replace(/\/listen$/, "/audio") };
    return { ok: true };
  };
  const formEls = {
    "briefing-topic": { value: "tech" },
    "media-sched-time": { value: "08:00" },
    "media-sched-on": { checked: true },
    "media-sched-stories": { value: "8" },
    "media-sched-show": { value: "0" },
    "media-sched-weekdays": { checked: true },
  };
  const sandbox = {
    console, URL, Headers, setTimeout, clearTimeout, Promise,
    setInterval: () => 0, clearInterval() {},
    fetch: (input, init) => {
      sent.push({ url: typeof input === "string" ? input : input.url, init: init || {} });
      return Promise.resolve({ json: async () => json(typeof input === "string" ? input : input.url) });
    },
    document: {
      cookie: `crow_session=s; crow_csrf=${TOKEN}`,
      addEventListener() {}, removeEventListener() {},
      getElementById: (id) => formEls[id] || null,
      querySelector: () => null, querySelectorAll: () => [],
      createElement: () => fakeEl(),
      documentElement: fakeEl({ setAttribute() {}, getAttribute() { return null; }, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, dataset: {} }),
      body: null,
    },
    location: { href: "https://dash.example.test/dashboard/media", origin: "https://dash.example.test", reload() {} },
    localStorage: { getItem() { return null; }, setItem() {} },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    navigator: {},
    addEventListener() {},
    alert() {},
    crowPlayer: { load() {}, queue() {} },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  // Layout scripts touch DOM this stub does not model; the fetch wrapper is
  // what matters and must be installed regardless.
  for (const s of layoutScripts) {
    try { new vm.Script(s).runInContext(sandbox); } catch { /* unrelated DOM wiring */ }
  }
  assert.equal(sandbox.__crowFetchWrapped, true, "the dashboard layout wraps window.fetch");
  new vm.Script(await panelScripts(), { filename: "media-panel-client.js" }).runInContext(sandbox);

  const flush = () => new Promise((r) => setTimeout(r, 10));
  sandbox.crowListenTts(fakeEl(), 3, "A");
  sandbox.crowSetPlaylistVisibility(7, "public");
  sandbox.crowRemovePlaylistItem(7, 11, fakeEl());
  const attrs = (map) => fakeEl({ getAttribute: (k) => map[k] ?? null });
  sandbox.crowMakeBriefing(attrs({ "data-label": "Make", "data-busy": "Making" }));
  sandbox.crowSaveSchedule(fakeEl());
  sandbox.crowPlayAll(7);
  const menuBtn = fakeEl({ parentElement: fakeEl() });
  sandbox.crowShowPlaylistMenu(menuBtn, 3);
  await flush();
  const menu = menuBtn.parentElement.children[0];
  assert.ok(menu && menu.children[0] && menu.children[0].onclick, "the playlist menu lists a playlist");
  menu.children[0].onclick();
  await flush();

  const mutating = sent.filter((r) => (r.init.method || "GET").toUpperCase() !== "GET");
  const seen = new Set(mutating.map((r) => `${r.init.method.toUpperCase()} ${r.url.replace(/\d+/g, ":n")}`));
  assert.deepEqual([...seen].sort(), [
    "DELETE /api/media/playlists/:n/items/:n",
    "PATCH /api/media/playlists/:n",
    "POST /api/media/articles/:n/listen",
    "POST /api/media/briefings",
    "POST /api/media/briefings/schedule",
    "POST /api/media/playlists/:n/items",
  ], "every state-changing caller in the panel script was exercised");
  for (const r of mutating) {
    const headers = new Headers(r.init.headers);
    assert.equal(headers.get("X-Crow-Csrf"), TOKEN, `${r.init.method} ${r.url} must carry the token`);
  }
  // Content-Type set by the caller survives the wrapper.
  const briefing = mutating.find((r) => r.url === "/api/media/briefings");
  assert.equal(new Headers(briefing.init.headers).get("Content-Type"), "application/json");
});
