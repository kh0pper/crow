/**
 * R1.2 PR 1, Task 3: the project home in a real browser.
 *
 * The REAL dashboard router over a scratch CROW_DATA_DIR (and the vendored
 * Turbo from public/), driven by a private headless Chrome
 * (tests/fixtures/headless-chrome.mjs) at a 390×844 phone and a 1280×800
 * desktop, in English and Spanish:
 *   - neither the page nor .content-body scrolls sideways;
 *   - every target on the home (Start, change, the bot pick, each row, the
 *     links) is at least 44 px, and the 404's Back to projects too;
 *   - "change" shows the pick, and picking a bot renames the lead;
 *   - Start a session POSTs the picked bot with { project_id } and the CSRF
 *     header, and reaches the spawn route (which refuses here: the scratch
 *     gateway's engine is off), and the page says it didn't start.
 * Skips without a browser unless CROW_REQUIRE_TEST_CHROME=1.
 * CROW_TEST_SHOT_DIR=<dir> saves a PNG per size and language.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { startHeadlessChrome } from "./fixtures/headless-chrome.mjs";
import { actAsServe, serveHeaders } from "./fixtures/serve-peer.mjs";
actAsServe(); // this process's HTTP client stands in for tailscaled (the Serve socket owner)

const dir = mkdtempSync(join(tmpdir(), "project-home-live-"));
process.env.CROW_DATA_DIR = dir;
const HOME = join(dir, "home");
process.env.CROW_HOME = HOME;
mkdirSync(HOME, { recursive: true });
delete process.env.CROW_DB_PATH;
const TASKS = join(dir, "tasks.db");
process.env.CROW_TASKS_DB_PATH = TASKS;
const DB_FILE = join(dir, "crow.db");
writeFileSync(join(dir, "instance-id"), "instance-project-home-live");
process.env.PIBOT_PI_CLI = "/nonexistent/pi-never-spawned-by-this-file.js";
const REPO = new URL("..", import.meta.url).pathname;
const SHOT_DIR = process.env.CROW_TEST_SHOT_DIR || "";

let server, base, chrome, setLang, t;

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env }, stdio: "pipe", cwd: REPO });
  const { hashToken } = await import("../servers/gateway/dashboard/auth.js");
  const c = new Database(DB_FILE);
  const pid = Number(c.prepare("INSERT INTO project_spaces (slug, name, type, status) VALUES ('garden','A community garden with a fairly long name','general','active')").run().lastInsertRowid);
  c.prepare("INSERT INTO oauth_tokens (token, token_type, client_id, expires_at, created_at) VALUES (?, 'access', 'dashboard', datetime('now','+1 day'), ?)")
    .run(hashToken("new-sess"), "2026-06-01 00:00:00");
  const bot = c.prepare("INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES (?,?,?,1,?)");
  bot.run("hank", "Hank the very thorough gardener", JSON.stringify({ gateways: [{ type: "perch" }], models: { default: "role:coordinator" } }), pid);
  bot.run("ivy", "Ivy", JSON.stringify({ gateways: [{ type: "perch" }], models: { default: "role:everyday" } }), pid);
  const sess = c.prepare("INSERT INTO bot_sessions (bot_id, kind, status, gateway_thread_id, label, updated_at) VALUES (?, 'perch-live', 'stopped', ?, ?, datetime('now', ?))");
  const file = c.prepare("INSERT INTO shell_items (item_kind, item_ref, project_id, set_by) VALUES ('perch_thread', ?, ?, 'origin')");
  [["perchlive-0000000a", "Planning the spring beds and the compost rotation for the north plot", "-1 hours"],
   ["perchlive-0000000b", null, "-1 days"], ["perchlive-0000000c", "Tools", "-3 days"], ["perchlive-0000000d", "Budget", "-40 days"]]
    .forEach(([id, label, ago]) => { sess.run("hank", id, label, ago); file.run(id, pid); });
  c.close();

  const tk = new Database(TASKS);
  tk.exec(`CREATE TABLE tasks_items (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT,
    status TEXT NOT NULL DEFAULT 'pending', priority INTEGER DEFAULT 3, parent_id INTEGER, project_id INTEGER,
    assigned_bot TEXT, board_id INTEGER, action_needed TEXT, archived_at TEXT, data_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE board_defs (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE,
    project_id INTEGER UNIQUE, display_name TEXT NOT NULL, status_values TEXT NOT NULL,
    terminal_values TEXT NOT NULL, fields_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  const add = tk.prepare("INSERT INTO tasks_items (title, project_id, action_needed, data_json) VALUES (?,?,?,?)");
  add.run("Which of the three seed suppliers should we order the heirloom tomatoes from this year?", pid, "Pick one", "{}");
  add.run("Pick a mulch", pid, null, JSON.stringify({ decision: { question: "Which?" } }));
  tk.close();

  const { createDbClient } = await import("../servers/db.js");
  const { writeSetting } = await import("../servers/gateway/dashboard/settings/registry.js");
  const db = createDbClient();
  await writeSetting(db, "shell_since", "2026-01-01 00:00:00");
  db.close();
  setLang = async (lang) => { const d = createDbClient(); try { await writeSetting(d, "language", lang); } finally { d.close(); } };
  ({ t } = await import("../servers/gateway/dashboard/shared/i18n.js"));

  const { default: dashboardRouter } = await import("../servers/gateway/dashboard/index.js");
  const { default: express } = await import("express");
  const app = express();
  app.use((req, res, next) => { res.redirectAfterPost = (url) => res.redirect(303, url); next(); });
  app.use(express.json({ limit: "1mb" }));
  app.use(express.static(fileURLToPath(new URL("../servers/gateway/public", import.meta.url))));
  app.use(dashboardRouter((req, res, next) => next()));
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = "http://127.0.0.1:" + server.address().port;
  chrome = await startHeadlessChrome();
});

after(async () => {
  server?.closeAllConnections?.();
  server?.close();
  if (chrome) await chrome.close();
  rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TWO_FRAMES = "new Promise(function(r){requestAnimationFrame(function(){requestAnimationFrame(function(){r(1);});});})";

async function open(path, { width, height }) {
  const tab = await (await fetch(chrome.cdp + "/json/new?about:blank", { method: "PUT" })).json();
  const { default: WebSocket } = await import("ws");
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
  let id = 0;
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mine = ++id;
    const on = (raw) => { const m = JSON.parse(raw); if (m.id !== mine) return; ws.off("message", on); m.error ? reject(new Error(method + ": " + JSON.stringify(m.error))) : resolve(m.result || {}); };
    ws.on("message", on); ws.send(JSON.stringify({ id: mine, method, params }));
  });
  const ev = async (expression) => {
    const o = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (o.exceptionDetails) throw new Error("page threw: " + JSON.stringify(o.exceptionDetails));
    return o.result.value;
  };
  const until = async (expression, what, ms = 10000) => {
    const end = Date.now() + ms;
    for (;;) {
      let v = null;
      try { v = await ev(expression); } catch { /* mid-navigation */ }
      if (v) return v;
      if (Date.now() > end) throw new Error("timed out waiting for " + what);
      await sleep(60);
    }
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");
  await send("Network.clearBrowserCookies");
  await send("Network.setExtraHTTPHeaders", { headers: serveHeaders("operator@example.com") });
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 900 });
  if (width < 900) await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  for (const ck of [{ name: "crow_session", value: "new-sess" }, { name: "crow_csrf", value: "tok" }]) {
    await send("Network.setCookie", { ...ck, url: base, path: "/" });
  }
  await send("Page.navigate", { url: base + path });
  await until("document.readyState === 'complete' && !!document.querySelector('.ph')", "the project home");
  await ev("document.fonts ? document.fonts.ready.then(function(){return 1;}) : 1");
  await ev(TWO_FRAMES);
  const shot = async (name) => {
    if (!SHOT_DIR) return;
    mkdirSync(SHOT_DIR, { recursive: true });
    const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
    writeFileSync(join(SHOT_DIR, name + ".png"), Buffer.from(data, "base64"));
  };
  return { ev, until, shot, close: async () => { ws.close(); await fetch(chrome.cdp + "/json/close/" + tab.id).catch(() => {}); } };
}

const NO_H_SCROLL = "(function(){ var b=document.querySelector('.content-body'); return { doc: Math.max(0, document.scrollingElement.scrollWidth - document.documentElement.clientWidth), body: b.scrollWidth - b.clientWidth }; })()";
/** {count, bad}: the visible targets under `sel` and those under 44 px either way. */
const small = (sel) => `(function(){ var bad=[], count=0;
  document.querySelectorAll(${JSON.stringify(sel)}).forEach(function(el){
    var cs=getComputedStyle(el); if(cs.display==='none'||cs.visibility==='hidden') return;
    var r=el.getBoundingClientRect(); if(!r.width&&!r.height) return;
    count++;
    if(r.width<44||r.height<44) bad.push((el.className||el.tagName)+':'+(el.textContent||'').trim().slice(0,24)+':'+Math.round(r.width)+'x'+Math.round(r.height));
  }); return { count: count, bad: bad }; })()`;
const TARGETS = ".ph a, .ph button, .ph select";

for (const lang of ["en", "es"]) {
  for (const [width, height] of [[390, 844], [1280, 800]]) {
    test(`${width}×${height} ${lang}: the home has no sideways scroll and 44 px targets; change and Start work`, async (ctx) => {
      if (!chrome) return ctx.skip("no headless Chrome");
      await setLang(lang);
      const p = await open("/dashboard/project/garden", { width, height });
      try {
        assert.equal(await p.ev("document.body.classList.contains('shell')"), true, "the new shell");
        assert.equal(await p.ev("document.querySelector('[data-ph-start]').textContent"), t("shell.startSession", lang));
        assert.deepEqual(await p.ev(NO_H_SCROLL), { doc: 0, body: 0 }, "no sideways scroll");
        // Before "change": Start, change, two Needs-you rows, All on Board, four sessions.
        const closed = await p.ev(small(TARGETS));
        assert.ok(closed.count >= 9, `targets on the page: ${closed.count}`);
        assert.deepEqual(closed.bad, [], "every target ≥ 44 px");
        await p.shot(`project-home-${width}-${lang}`);

        await p.ev("document.querySelector('[data-ph-change]').click(), 1");
        await p.until("!document.querySelector('.ph-pick').hidden", "the bot pick");
        assert.equal(await p.ev("document.querySelector('[data-ph-change]').getAttribute('aria-expanded')"), "true");
        const opened = await p.ev(small(".ph-pick select"));
        assert.equal(opened.count, 1);
        assert.deepEqual(opened.bad, []);
        assert.deepEqual(await p.ev(NO_H_SCROLL), { doc: 0, body: 0 }, "no sideways scroll with the pick open");
        await p.ev("(function(){ var s=document.querySelector('[data-ph-bot]'); s.value='ivy'; s.dispatchEvent(new Event('change')); return 1; })()");
        assert.equal(await p.ev("document.querySelector('[data-ph-lead-name]').textContent"), "Ivy");
        assert.equal(await p.ev("document.querySelector('[data-ph-start]').getAttribute('data-bot')"), "ivy");

        // Record what the page sends and what comes back.
        await p.ev("(function(){ window.__ph=[]; var f=window.fetch; window.fetch=function(u,o){ return f.apply(this,arguments).then(function(r){ r.clone().text().then(function(x){ window.__ph.push({ url: String(u), body: o && o.body, csrf: o && o.headers && o.headers['X-Crow-Csrf'], status: r.status, text: x }); }); return r; }); }; return 1; })()");
        await p.ev("document.querySelector('[data-ph-start]').click(), 1");
        await p.until("document.querySelector('[data-ph-status]').textContent !== '' && window.__ph.length", "the start result");
        const [call] = await p.ev("window.__ph");
        assert.equal(call.url, "/dashboard/perch-api/bots/ivy/interactive", "the picked bot, for this session");
        assert.equal(call.csrf, "tok", "the dashboard CSRF token rides the header");
        assert.match(call.body, /^\{"project_id":\d+\}$/);
        // Past CSRF and auth, the spawn route ran: this scratch gateway's engine refuses with perch_disabled.
        assert.deepEqual([call.status, JSON.parse(call.text).error], [503, "perch_disabled"]);
        assert.equal(await p.ev("document.querySelector('[data-ph-status]').textContent"), t("perch.startFailed", lang));
        assert.equal(await p.ev("document.querySelector('[data-ph-start]').disabled"), false, "Start is usable again");
      } finally { await p.close(); }
    });
  }

  test(`390×844 ${lang}: the 404 has no sideways scroll, and Back to projects opens the drawer`, async (ctx) => {
    if (!chrome) return ctx.skip("no headless Chrome");
    await setLang(lang);
    const p = await open("/dashboard/project/nope", { width: 390, height: 844 });
    try {
      assert.deepEqual(await p.ev(NO_H_SCROLL), { doc: 0, body: 0 });
      const r = await p.ev(small(TARGETS));
      assert.equal(r.count, 1);
      assert.deepEqual(r.bad, []);
      await p.ev("document.querySelector('.ph-missing [data-shell-open]').click(), 1");
      await p.until("document.getElementById('shell-drawer').open", "the drawer");
    } finally { await p.close(); }
  });
}
