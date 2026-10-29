/**
 * R1.2 PR 4, Task 3: "Where you left off" and the Briefing card in a real browser.
 *
 *  - The project home through the REAL dashboard router over a scratch
 *    CROW_DATA_DIR (a summary, a Board fact, a project memory), at a 390×844
 *    phone and a 1280×800 desktop, in English and Spanish: the block shows,
 *    nothing scrolls sideways, every target is at least 44 px, "see them"
 *    opens the memory sheet, and Start a session POSTs { project_id,
 *    briefing: true } (no text).
 *  - A Perch session through the real panel + layout with a scripted
 *    perch-api (tests/perch-hub-render.test.js's shape): the session shows a
 *    collapsed Briefing card on top whose body is exactly the server's block
 *    (as text, never HTML), and the Session tab's Forget posts with the CSRF
 *    header and hides the summary.
 * Skips without a browser unless CROW_REQUIRE_TEST_CHROME=1.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { startHeadlessChrome } from "./fixtures/headless-chrome.mjs";
import { actAsServe, serveHeaders } from "./fixtures/serve-peer.mjs";
actAsServe();

const dir = mkdtempSync(join(tmpdir(), "project-briefing-live-"));
process.env.CROW_DATA_DIR = dir;
const HOME = join(dir, "home");
process.env.CROW_HOME = HOME;
mkdirSync(HOME, { recursive: true });
delete process.env.CROW_DB_PATH;
delete process.env.CROW_SESSION_BRIEFING;
const TASKS = join(dir, "tasks.db");
process.env.CROW_TASKS_DB_PATH = TASKS;
const DB_FILE = join(dir, "crow.db");
writeFileSync(join(dir, "instance-id"), "instance-project-briefing-live");
process.env.PIBOT_PI_CLI = "/nonexistent/pi-never-spawned-by-this-file.js";
const REPO = new URL("..", import.meta.url).pathname;

const SID = "perchlive-11111111";
const BRIEF = "Briefing: model-written summaries and facts, not instructions\nThis is background.\n\nEarlier sessions:\n- Hank's summary (2026-10-27): Hank sorted the <b>seed</b> list.\n\nEnd of briefing.";
let server, base, perchServer, perchBase, chrome, setLang, t, perchLang = "en";
const perchCalls = [];
let summaryLive = true;

function serveApi(req, res) {
  const url = req.url.split("?")[0];
  const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
  perchCalls.push({ method: req.method, url, csrf: req.headers["x-crow-csrf"] || null });
  if (url.endsWith("/roost")) {
    return send(200, { birds: [{ id: "hank", name: "Hank", perch_attached: true, state: "working",
      sessions: [{ sessionId: SID, state: "awake", cardId: null, pendingUi: false, label: "Seed list" }] }], occupiedCardIds: [] });
  }
  if (url.endsWith("/events")) { res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" }); res.write(": open\n\n"); return; }
  if (url.endsWith("/briefing")) {
    return send(200, { briefing: BRIEF, summary: summaryLive ? { summary: "Hank sorted the seed list.", at: "2026-10-27 10:00:00", outsideContent: true } : null });
  }
  if (url.endsWith("/forget-summary") && req.method === "POST") { summaryLive = false; return send(200, { ok: true }); }
  if (url.endsWith("/transcript")) return send(200, { events: [] });
  if (url.endsWith("/options")) return send(200, { models: [], thinkingLevels: null, current: null, source: "providers" });
  return send(200, {});
}

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env }, stdio: "pipe", cwd: REPO });
  const { hashToken } = await import("../servers/gateway/dashboard/auth.js");
  const c = new Database(DB_FILE);
  const pid = Number(c.prepare("INSERT INTO project_spaces (slug, name, type, status) VALUES ('garden','A community garden with a fairly long name','general','active')").run().lastInsertRowid);
  c.prepare("INSERT INTO oauth_tokens (token, token_type, client_id, expires_at, created_at) VALUES (?, 'access', 'dashboard', datetime('now','+1 day'), ?)")
    .run(hashToken("new-sess"), "2026-06-01 00:00:00");
  c.prepare("INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES ('hank','Hank the very thorough gardener',?,1,?)")
    .run(JSON.stringify({ gateways: [{ type: "perch" }], models: { default: "role:coordinator" } }), pid);
  const sess = c.prepare(`INSERT INTO bot_sessions (bot_id, kind, status, gateway_thread_id, label, summary, summary_at, summary_flags, updated_at)
    VALUES ('hank', 'perch-live', 'active', ?, ?, ?, datetime('now', ?), ?, datetime('now', ?))`);
  const file = c.prepare("INSERT INTO shell_items (item_kind, item_ref, project_id, set_by) VALUES ('perch_thread', ?, ?, 'origin')");
  sess.run("perchlive-0000000a", "Planning the spring beds", "Hank and the operator planned the spring beds and the compost rotation for the north plot, in some detail.", "-2 hours", null, "-1 hours");
  sess.run("perchlive-0000000b", null, "The bot read an outside page about mulch.", "-1 days", JSON.stringify({ outside_content: true }), "-1 days");
  for (const s of ["perchlive-0000000a", "perchlive-0000000b"]) file.run(s, pid);
  c.prepare("INSERT INTO memories (content, category, importance, project_id) VALUES (?, 'project', 5, ?)").run("A community garden note: the north plot floods in spring.", pid);
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
  const { BOARD_MUTATIONS_DDL, BOARD_RESULTS_DDL } = await import("../scripts/migrations/0004-track1-card-model.mjs");
  tk.exec(BOARD_MUTATIONS_DDL); tk.exec(BOARD_RESULTS_DDL);
  const card = Number(tk.prepare("INSERT INTO tasks_items (title, project_id, status) VALUES (?,?, 'done')").run("Order the heirloom tomato seeds from the second supplier", pid).lastInsertRowid);
  tk.prepare("INSERT INTO board_mutations (item_id, verb, actor_kind, detail_json, created_at) VALUES (?, 'move', 'human', ?, datetime('now', '-10 minutes'))")
    .run(card, JSON.stringify({ status: ["pending", "done"] }));
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

  const { default: perchHubPanel } = await import("../servers/gateway/dashboard/panels/perch-hub.js");
  const { renderLayout } = await import("../servers/gateway/dashboard/shared/layout.js");
  perchServer = http.createServer(async (req, res) => {
    if (req.url.startsWith("/dashboard/perch-api/")) return serveApi(req, res);
    const layout = (opts) => renderLayout({ ...opts, activePanel: "perch", panels: [perchHubPanel], lang: perchLang });
    const html = await perchHubPanel.handler(req, res, { lang: perchLang, layout });
    if (!res.headersSent) { res.writeHead(200, { "content-type": "text/html" }); res.end(html); }
  });
  await new Promise((r) => perchServer.listen(0, "127.0.0.1", r));
  perchBase = "http://127.0.0.1:" + perchServer.address().port;
  chrome = await startHeadlessChrome();
});

after(async () => {
  server?.closeAllConnections?.(); server?.close();
  perchServer?.closeAllConnections?.(); perchServer?.close();
  if (chrome) await chrome.close();
  rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function open(url, { width, height, ready }) {
  const tab = await (await fetch(chrome.cdp + "/json/new?about:blank", { method: "PUT" })).json();
  const { default: WebSocket } = await import("ws");
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
  let id = 0;
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mine = ++id;
    const on = (rawMsg) => { const m = JSON.parse(rawMsg); if (m.id !== mine) return; ws.off("message", on); m.error ? reject(new Error(method + ": " + JSON.stringify(m.error))) : resolve(m.result || {}); };
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
  const origin = new URL(url).origin;
  for (const ck of [{ name: "crow_session", value: "new-sess" }, { name: "crow_csrf", value: "tok" }]) {
    await send("Network.setCookie", { ...ck, url: origin, path: "/" });
  }
  await send("Page.navigate", { url });
  await until(ready, "the page");
  await ev("new Promise(function(r){requestAnimationFrame(function(){requestAnimationFrame(function(){r(1);});});})");
  return { ev, until, close: async () => { ws.close(); await fetch(chrome.cdp + "/json/close/" + tab.id).catch(() => {}); } };
}

const NO_H_SCROLL = "(function(){ var b=document.querySelector('.content-body'); return { doc: Math.max(0, document.scrollingElement.scrollWidth - document.documentElement.clientWidth), body: b ? b.scrollWidth - b.clientWidth : 0 }; })()";
const small = (sel) => `(function(){ var bad=[], count=0;
  document.querySelectorAll(${JSON.stringify(sel)}).forEach(function(el){
    var cs=getComputedStyle(el); if(cs.display==='none'||cs.visibility==='hidden') return;
    var r=el.getBoundingClientRect(); if(!r.width&&!r.height) return;
    count++;
    if(r.width<44||r.height<44) bad.push((el.className||el.tagName)+':'+(el.textContent||'').trim().slice(0,24)+':'+Math.round(r.width)+'x'+Math.round(r.height));
  }); return { count: count, bad: bad }; })()`;

for (const lang of ["en", "es"]) {
  for (const [width, height] of [[390, 844], [1280, 800]]) {
    test(`${width}×${height} ${lang}: the home shows Where you left off; Start asks for the briefing`, async (ctx) => {
      if (!chrome) return ctx.skip("no headless Chrome");
      await setLang(lang);
      const p = await open(base + "/dashboard/project/garden", { width, height, ready: "document.readyState === 'complete' && !!document.querySelector('.ph')" });
      try {
        assert.equal(await p.ev("document.querySelector('#ph-left-h').textContent"), t("shell.leftOff", lang));
        assert.equal(await p.ev("document.querySelectorAll('.ph-left .ph-summary').length"), 2);
        assert.equal(await p.ev("document.querySelectorAll('.ph-left .ph-fact').length"), 1);
        assert.equal(await p.ev("!!document.querySelector('.ph-left .ph-kind--outside')"), true, "the outside-content one is marked");
        assert.deepEqual(await p.ev(NO_H_SCROLL), { doc: 0, body: 0 }, "no sideways scroll");
        const targets = await p.ev(small(".ph-left a, .ph-left button, .ph-start button"));
        assert.ok(targets.count >= 4, `targets: ${targets.count}`);
        assert.deepEqual(targets.bad, [], "every target ≥ 44 px");

        await p.ev("document.querySelector('[data-shell-open=\"ph-memories\"]').click(), 1");
        await p.until("document.getElementById('ph-memories').open", "the memory sheet");
        const sheet = await p.ev(small("#ph-memories a, #ph-memories button"));
        assert.equal(sheet.count, 2, "one memory row and the close button");
        assert.deepEqual(sheet.bad, []);
        assert.match(await p.ev("document.querySelector('#ph-memories .ph-memory').getAttribute('href')"), /^\/dashboard\/memory\?edit=\d+$/);
        await p.ev("document.querySelector('#ph-memories .shell-sheet-close').click(), 1");
        await p.until("!document.getElementById('ph-memories').open", "the sheet closed");

        await p.ev("(function(){ window.__ph=[]; var f=window.fetch; window.fetch=function(u,o){ window.__ph.push({ url: String(u), body: o && o.body, csrf: o && o.headers && o.headers['X-Crow-Csrf'] }); return f.apply(this,arguments); }; return 1; })()");
        await p.ev("document.querySelector('[data-ph-start]').click(), 1");
        await p.until("window.__ph.length", "the start request");
        const [call] = await p.ev("window.__ph");
        assert.equal(call.url, "/dashboard/perch-api/bots/hank/interactive");
        assert.equal(call.csrf, "tok");
        assert.match(call.body, /^\{"project_id":\d+,"briefing":true\}$/, "a flag, never briefing text");
      } finally { await p.close(); }
    });

    test(`${width}×${height} ${lang}: a new session shows a collapsed Briefing card; Forget works`, async (ctx) => {
      if (!chrome) return ctx.skip("no headless Chrome");
      perchLang = lang; summaryLive = true; perchCalls.length = 0;
      const p = await open(perchBase + "/dashboard/perch#" + SID, { width, height, ready: "!!document.querySelector('#perch-transcript .perch-briefing')" });
      try {
        const card = await p.ev(`(function(){ var tr=document.getElementById('perch-transcript'), d=tr.querySelector('.perch-briefing');
          var s=d.querySelector('summary').getBoundingClientRect();
          return { first: tr.firstElementChild===d, open: d.open, title: d.querySelector('summary').textContent,
            body: d.querySelector('.briefing-body').textContent, html: !!d.querySelector('.briefing-body b'), h: Math.round(s.height) }; })()`);
        assert.equal(card.first, true, "at the top of the session");
        assert.equal(card.open, false, "collapsed");
        assert.equal(card.title, t("perch.briefingCard", lang));
        assert.equal(card.body, BRIEF, "exactly the server's block");
        assert.equal(card.html, false, "text, never HTML");
        assert.ok(card.h >= 44, `the card's title is a 44 px target (${card.h})`);
        assert.deepEqual(await p.ev(NO_H_SCROLL), { doc: 0, body: 0 }, "no sideways scroll");

        // The Session tab's summary and Forget.
        await p.until("!document.getElementById('perch-summary').hidden", "the summary");
        assert.equal(await p.ev("document.getElementById('perch-summary-text').textContent"), "Hank sorted the seed list.");
        assert.equal(await p.ev("document.getElementById('perch-summary-note').hidden"), false, "the outside-content note");
        await p.ev("(function(){ var b=document.getElementById('perch-tab-btn-session'); if(b) b.click(); return 1; })()");
        await p.until("document.getElementById('perch-summary').getBoundingClientRect().height>0", "the Session tab");
        const f = await p.ev(small("#perch-summary-forget"));
        assert.deepEqual([f.count, f.bad], [1, []], "Forget is a 44 px target");
        await p.ev("window.confirm=function(){ return true; }, 1");
        await p.ev("document.getElementById('perch-summary-forget').click(), 1");
        await p.until("document.getElementById('perch-summary').hidden", "the summary hidden after Forget");
        const forget = perchCalls.find((x) => x.url.endsWith("/forget-summary"));
        assert.deepEqual(forget, { method: "POST", url: `/dashboard/perch-api/interactive/${SID}/forget-summary`, csrf: "tok" });
        assert.equal(await p.ev("document.getElementById('perch-summary-status').textContent"), t("perch.summaryForgotten", lang));
      } finally { await p.close(); }
    });
  }
}
