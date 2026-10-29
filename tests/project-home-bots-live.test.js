/**
 * The project home's Bots section in a real browser (R1.2 §14): at a 390x844
 * phone and a 1280x800 desktop the rows and the add/move controls fit with no
 * sideways scroll and 44 px targets, and the move round trip works: pick,
 * confirm, the bot shows up in the list. Waits for document.fonts.ready and two
 * frames before measuring. Skips without a browser unless CROW_REQUIRE_TEST_CHROME=1.
 * CROW_TEST_SHOT_DIR=<dir> saves a PNG per case.
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
actAsServe();

const dir = mkdtempSync(join(tmpdir(), "project-home-bots-live-"));
process.env.CROW_DATA_DIR = dir;
const HOME = join(dir, "home");
process.env.CROW_HOME = HOME;
mkdirSync(HOME, { recursive: true });
delete process.env.CROW_DB_PATH;
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
const DB_FILE = join(dir, "crow.db");
writeFileSync(join(dir, "instance-id"), "instance-project-home-bots-live");
process.env.PIBOT_PI_CLI = "/nonexistent/pi-never-spawned-by-this-file.js";
const REPO = new URL("..", import.meta.url).pathname;
const SHOT_DIR = process.env.CROW_TEST_SHOT_DIR || "";
const perch = JSON.stringify({ models: { default: "p/m" }, gateways: [{ type: "perch" }], system_prompt: "Be brief." });

let server, base, chrome;

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env }, stdio: "pipe", cwd: REPO });
  const { hashToken } = await import("../servers/gateway/dashboard/auth.js");
  const c = new Database(DB_FILE);
  const proj = c.prepare("INSERT INTO project_spaces (slug, name, type, status, workspace_dir) VALUES (?,?,'general','active',?)");
  const mem = c.prepare("INSERT INTO project_members (project_id, contact_id, role) VALUES (?, NULL, 'owner')");
  const garden = Number(proj.run("garden", "A community garden with a fairly long name", join(dir, "projects", "garden")).lastInsertRowid);
  const kitchen = Number(proj.run("kitchen", "Kitchen", join(dir, "projects", "kitchen")).lastInsertRowid);
  mem.run(garden); mem.run(kitchen);
  c.prepare("INSERT INTO oauth_tokens (token, token_type, client_id, expires_at, created_at) VALUES (?, 'access', 'dashboard', datetime('now','+1 day'), ?)")
    .run(hashToken("new-sess"), "2026-06-01 00:00:00");
  const bot = c.prepare("INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES (?,?,?,1,?)");
  bot.run("hank", "Hank the very thorough gardener", perch, garden);
  bot.run("ivy", "Ivy", perch, garden);
  bot.run("cook", "Cook, who has a long name to wrap around", perch, kitchen);
  bot.run("sage", "Sage", perch, kitchen);
  c.close();
  const { createDbClient } = await import("../servers/db.js");
  const db = createDbClient();
  await (await import("../servers/gateway/dashboard/settings/registry.js")).writeSetting(db, "shell_since", "2026-01-01 00:00:00");
  db.close();
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

const NO_H_SCROLL = "(function(){ var b=document.querySelector('.content-body'); return { doc: Math.max(0, document.scrollingElement.scrollWidth - window.innerWidth), body: b.scrollWidth - b.clientWidth }; })()";
/** {count, bad}: the visible targets under `sel` and those under 44 px either way. */
const small = (sel) => `(function(){ var bad=[], count=0;
  document.querySelectorAll(${JSON.stringify(sel)}).forEach(function(el){
    var cs=getComputedStyle(el); if(cs.display==='none'||cs.visibility==='hidden') return;
    var r=el.getBoundingClientRect(); if(!r.width&&!r.height) return;
    count++;
    if(r.width<44||r.height<44) bad.push((el.className||el.tagName)+':'+(el.textContent||'').trim().slice(0,24)+':'+Math.round(r.width)+'x'+Math.round(r.height));
  }); return { count: count, bad: bad }; })()`;
const TARGETS = ".ph-bots a, .ph-bots button, .ph-bots select, .ph-bots summary";


for (const [width, height] of [[390, 844], [1280, 800]]) {
  test(`${width}x${height}: rows and controls fit, 44 px targets, no sideways overflow; the move round trip works`, async (ctx) => {
    if (!chrome) return ctx.skip("no headless Chrome");
    const p = await open("/dashboard/project/garden", { width, height });
    try {
      assert.deepEqual(await p.ev(NO_H_SCROLL), { doc: 0, body: 0 }, "no sideways scroll");
      const closed = await p.ev(small(TARGETS));
      // Two Edit links, the Add a bot summary, the move select and its Continue.
      assert.ok(closed.count >= 5, "targets: " + closed.count);
      assert.deepEqual(closed.bad, [], "every target >= 44 px");
      // Rows are full width.
      const widths = await p.ev("(function(){ var l=document.querySelector('.ph-bot-list').getBoundingClientRect(); return Array.from(document.querySelectorAll('.ph-bot')).map(function(r){ return Math.round(r.getBoundingClientRect().width - l.width); }); })()");
      assert.ok(widths.length >= 2 && widths.every((w) => w === 0), 'rows fill the list: ' + widths);
      // At phone width the select and its button stack.
      if (width < 600) {
        const stacked = await p.ev("(function(){ var s=document.querySelector('[data-ph-move-select]').getBoundingClientRect(), b=document.querySelector('[data-ph-move-go]').getBoundingClientRect(); return b.top >= s.bottom - 1; })()");
        assert.equal(stacked, true, "select above the button");
      }
      await p.ev("document.querySelector('.ph-add summary').click(), 1");
      await p.until("document.querySelector('.ph-add').open", "the add details");
      assert.deepEqual((await p.ev(small(TARGETS))).bad, []);
      assert.deepEqual(await p.ev(NO_H_SCROLL), { doc: 0, body: 0 });
      await p.ev("document.querySelector('.ph-add summary').click(), 1");

      // Pick, then the confirm.
      await p.ev("document.querySelector('[data-ph-move-go]').click(), 1");
      await p.until("!!document.querySelector('[data-ph-confirm]')", "the confirm");
      await sleep(600); // the page cross-fades on a Turbo visit; measure the settled page
      await p.ev("document.fonts ? document.fonts.ready.then(function(){return 1;}) : 1");
      await p.ev(TWO_FRAMES);
      const heading = await p.ev("document.querySelector('.ph-confirm-h').textContent");
      const [, moving] = heading.match(/^Move (.+) from Kitchen to A community garden with a fairly long name\?$/) || [];
      assert.ok(moving, "the confirm names the bot, where it is and the project: " + heading);
      const before = await p.ev("document.querySelectorAll('.ph-bot').length");
      const confirm = await p.ev(small(TARGETS));
      assert.deepEqual(confirm.bad, [], "confirm targets >= 44 px");
      assert.deepEqual(await p.ev(NO_H_SCROLL), { doc: 0, body: 0 });
      await p.shot(`ph-bots-${width}`);
      // Confirm: the bot appears in the list.
      await p.ev("document.querySelector('[data-ph-confirm] button[type=submit]').click(), 1");
      await p.until("!!document.querySelector('[data-ph-moved]') && document.querySelectorAll('.ph-bot').length === " + (before + 1), "the moved bot in the list");
      assert.equal(await p.ev("document.querySelector('[data-ph-moved]').textContent"), moving + " is now in this project.");
      assert.deepEqual(await p.ev(NO_H_SCROLL), { doc: 0, body: 0 });
    } finally { await p.close(); }
  });
}
