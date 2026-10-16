/**
 * Unassigned lane + "Give to…" (queue item 20, PR 2) — live layout. The real
 * rendered Bot Board (a board-on bot, a board-off bot) and Bot Builder list
 * inside the real dashboard layout, with cards on no board, at a 390 px
 * phone and a 1280 px wide screen, default and xlarge text:
 *   - the page never scrolls sideways, with the give sheet / dialog open too;
 *   - the Unassigned lane is the first phone tab (opened first) and the
 *     first column on wide;
 *   - the give sheet is a full-width bottom sheet on a phone and a popover
 *     beside the card on wide, inside the screen and on top of everything;
 *   - the Bot Builder "Give <Name> a task" dialog fits and is on top.
 * Plus a control that proves the overflow check reaches the mechanism.
 *
 * A private headless Chrome (tests/fixtures/headless-chrome.mjs), never the
 * live :9223. Skips without a browser unless CROW_REQUIRE_TEST_CHROME=1.
 * CROW_TEST_SHOT_DIR=<dir> saves a PNG per page and size for the PR.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { startHeadlessChrome } from "./fixtures/headless-chrome.mjs";

const dir = mkdtempSync(join(tmpdir(), "bot-give-layout-"));
process.env.CROW_DATA_DIR = dir;
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
delete process.env.CROW_DB_PATH;

const SHOT_DIR = process.env.CROW_TEST_SHOT_DIR || "";
let chrome = null, server = null, port = 0, db = null;
const pages = {};

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: new URL("..", import.meta.url).pathname,
  });
  const { createDbClient } = await import("../servers/db.js");
  db = createDbClient();
  const { createProjectSpace } = await import("../servers/shared/project-spaces.js");
  const pid = (await createProjectSpace(db, { name: "Helper's board" })).id;
  const pid2 = (await createProjectSpace(db, { name: "Glasses board" })).id;
  const add = (id, name, def, p) => db.execute({
    sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id, updated_at) VALUES (?,?,?,1,?,datetime('now','-9 days'))",
    args: [id, name, JSON.stringify(def), p] });
  await add("assistant", "A personal assistant with a long name", { gateways: [{ type: "perch" }], tracker_config: { type: "none" } }, null);
  await add("helper", "Helper", { gateways: [{ type: "perch" }], tracker_config: { type: "kanban" } }, pid);
  await add("glasses-bot", "Glasses helper with a longer name", { gateways: [{ type: "glasses", device_id: "d2" }] }, pid2);
  await add("quiet-bot", "Quiet test bot", { gateways: [] }, null);

  const t = new Database(process.env.CROW_TASKS_DB_PATH);
  t.exec(`CREATE TABLE tasks_items (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
    description TEXT, status TEXT NOT NULL DEFAULT 'pending', priority INTEGER DEFAULT 3,
    due_date TEXT, phase TEXT, owner TEXT, tags TEXT, parent_id INTEGER, project_id INTEGER,
    assigned_bot TEXT, plan_ref TEXT, board_id INTEGER, data_json TEXT NOT NULL DEFAULT '{}',
    archived_at TEXT,
    created_at TEXT DEFAULT (datetime('now','-2 days')), updated_at TEXT DEFAULT (datetime('now')), completed_at TEXT)`);
  const ins = t.prepare("INSERT INTO tasks_items (title, project_id, tags, assigned_bot) VALUES (?,?,?,?)");
  ins.run("Research: a fairly long card title that has to wrap on a phone screen", pid, "research", null);
  ins.run("Find a plumber for the kitchen sink before the weekend, ideally someone local", null, "home,urgent", null);
  ins.run("Water the plants", null, null, "helper");
  t.close();

  const { renderLayout } = await import("../servers/gateway/dashboard/shared/layout.js");
  const { renderBotList } = await import("../servers/gateway/dashboard/panels/bot-builder/html.js");
  const { botBuilderStyles } = await import("../servers/gateway/dashboard/panels/bot-builder/css.js");
  const { default: boardPanel } = await import("../servers/gateway/dashboard/panels/bot-board.js");
  const layoutFor = (active) => ({ title, content }) => renderLayout({ title, content, activePanel: active, panels: [], lang: "en" });

  const res = { send(s) { this.html = s; } };
  await renderBotList(res, { db, layout: layoutFor("bot-builder"), notice: "", PAGE_CSS: botBuilderStyles(), req: { headers: {}, csrfToken: "tok" } });
  pages.list = res.html;
  for (const [key, bot] of [["board-on", "helper"], ["board-off", "assistant"]]) {
    pages[key] = await boardPanel.handler({ method: "GET", query: { bot }, headers: {}, csrfToken: "tok" },
      { redirect() {} }, { db, layout: layoutFor("bot-board"), lang: "en" });
  }

  chrome = await startHeadlessChrome();
  if (!chrome) return;
  server = http.createServer((req, r) => {
    r.writeHead(200, { "content-type": "text/html" });
    r.end(pages[(req.url || "/").slice(1)] || "");
  });
  await new Promise((r) => server.listen(0, chrome.bindHost, r));
  port = server.address().port;
});
after(async () => {
  if (server) server.close();
  if (chrome) await chrome.close();
  try { db && db.close && db.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

// What the measure step can do before reading the page.
const OPEN_GIVE = "(function(){var b=document.querySelector('.bb-give-btn');b.scrollIntoView({block:'center'});b.click();" +
  "var r=document.querySelector('[name=bb-give-bot]');if(r){r.click();}return 1;})()";
const OPEN_TASK = "(function(){var b=document.querySelector('.btb-more[aria-controls]');" +
  "var m=document.getElementById(b.getAttribute('aria-controls'));" +
  "var all=document.querySelectorAll('.btb-give-task');var g=all[0];var more=document.querySelector('[aria-controls=\"'+g.closest('.btb-menu').id+'\"]');" +
  "more.click();g.click();return 1;})()";

async function measure(page, w, h, { textSize = null, css = "", action = "", shot = "" } = {}) {
  const tab = await (await fetch(chrome.cdp + "/json/new?about:blank", { method: "PUT" })).json();
  const { default: WebSocket } = await import("ws");
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
  let id = 0;
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mine = ++id;
    const onMsg = (raw) => { const m = JSON.parse(raw); if (m.id !== mine) return; ws.off("message", onMsg);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result || {}); };
    ws.on("message", onMsg);
    ws.send(JSON.stringify({ id: mine, method, params }));
  });
  const evalIn = async (expr) => { const o = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (o.exceptionDetails) throw new Error(JSON.stringify(o.exceptionDetails)); return o.result.value; };
  try {
    await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: w < 700 });
    if (textSize) {
      await send("Page.enable");
      await send("Page.addScriptToEvaluateOnNewDocument", { source: `try{localStorage.setItem("crow-text-size",${JSON.stringify(textSize)})}catch(e){}` });
    }
    await send("Page.navigate", { url: `http://${chrome.pageHost}:${port}/${page}` });
    let ok = false;
    for (let i = 0; i < 75 && !ok; i++) { await new Promise((r) => setTimeout(r, 200)); try { ok = await evalIn("!!document.querySelector('.content-body') && document.readyState==='complete'"); } catch {} }
    assert.ok(ok, "the page never loaded: " + page);
    if (css) await evalIn(`(function(){var s=document.createElement('style');s.textContent=${JSON.stringify(css)};document.head.appendChild(s);return 1;})()`);
    if (action) await evalIn(action);
    await evalIn("new Promise(function(r){requestAnimationFrame(function(){requestAnimationFrame(function(){r(1);});});})");
    const m = JSON.parse(await evalIn(`(function(){
      var cb=document.querySelector('.content-body');
      var vis=function(e){ if(!e) return null; var r=e.getBoundingClientRect(); return r.width>0&&r.height>0; };
      var box=function(e){ if(!e) return null; var r=e.getBoundingClientRect(); return {l:Math.round(r.left),r:Math.round(r.right),t:Math.round(r.top),b:Math.round(r.bottom)}; };
      var onTop=function(e){ if(!e||!vis(e)) return null; var r=e.getBoundingClientRect();
        var pts=[[r.left+r.width/2, r.top+10],[r.left+r.width/2, r.bottom-10],[r.left+10, r.top+r.height/2],[r.right-10, r.top+r.height/2]];
        return pts.every(function(p){ var x=document.elementFromPoint(Math.max(0,Math.min(p[0],innerWidth-1)), Math.max(0,Math.min(p[1],innerHeight-1))); return !!(x&&e.contains(x)); }); };
      var panel=document.querySelector('#bb-give:not([hidden]) .bb-give-panel') || document.querySelector('#btb-give:not([hidden]) .btb-give-panel');
      var lanes=Array.prototype.slice.call(document.querySelectorAll('#bb-board > div')).filter(vis).map(function(c){return c.getAttribute('data-col');});
      var giveBtn=document.querySelector('.bb-give-btn');
      var go=document.getElementById('bb-give-go')||document.getElementById('btb-give-go');
      return JSON.stringify({
        doc: document.documentElement.scrollWidth-innerWidth,
        body: cb.scrollWidth-cb.clientWidth,
        iw: innerWidth, ih: innerHeight,
        lanes: lanes,
        firstCol: (function(){var f=document.querySelector('#bb-board > div');return f?f.getAttribute('data-col'):null;})(),
        selTab: (function(){var t=document.querySelector('.bb-lane-tabs [aria-selected=true]');return t?t.getAttribute('data-lane'):null;})(),
        unLane: box(document.querySelector('.bb-lane-un')),
        unCardsOnTop: Array.prototype.slice.call(document.querySelectorAll('.bb-un-card')).filter(vis).length,
        panel: box(panel), panelOnTop: onTop(panel),
        panelScroll: panel ? panel.scrollWidth-panel.clientWidth : null,
        goShown: vis(go), goOnTop: onTop(go),
        btn: box(giveBtn)
      });})()`));
    if (shot && SHOT_DIR) {
      const tall = !action;
      if (tall) {
        const full = await evalIn("Math.ceil(document.documentElement.scrollHeight)");
        await send("Emulation.setDeviceMetricsOverride", { width: w, height: Math.max(h, Math.min(full, 3000)), deviceScaleFactor: 1, mobile: w < 700 });
      }
      const png = await send("Page.captureScreenshot", { format: "png" });
      mkdirSync(SHOT_DIR, { recursive: true });
      writeFileSync(join(SHOT_DIR, shot + ".png"), Buffer.from(png.data, "base64"));
    }
    return m;
  } finally { ws.close(); await fetch(chrome.cdp + "/json/close/" + tab.id).catch(() => {}); }
}

for (const [w, h] of [[390, 844], [1280, 800]]) {
  for (const textSize of [null, "xlarge"]) {
    const label = `${w}x${h}${textSize ? " xlarge text" : ""}`;
    const phone = w < 700;
    const xl = textSize ? "-xl" : "";

    test(`live @${label}: the Unassigned lane is ${phone ? "the first tab, opened first" : "the first column"}; no sideways pan`, async (t) => {
      if (!chrome) return t.skip("no headless Chrome");
      const m = await measure("board-on", w, h, { textSize, shot: `board-unassigned-${w}${xl}` });
      assert.ok(m.doc <= 0 && m.body === 0, `no sideways pan ${JSON.stringify(m)}`);
      assert.equal(m.firstCol, "__unassigned", `the lane leads the board ${JSON.stringify(m)}`);
      if (phone) {
        assert.equal(m.selTab, "__unassigned", `opened first ${JSON.stringify(m)}`);
        assert.deepEqual(m.lanes, ["__unassigned"], `alone ${JSON.stringify(m)}`);
      } else {
        assert.ok(m.lanes.length >= 4 && m.lanes[0] === "__unassigned", `side by side ${JSON.stringify(m)}`);
      }
      assert.equal(m.unCardsOnTop, 2);
      assert.ok(m.unLane.l >= 0 && m.unLane.r <= m.iw, JSON.stringify(m));
    });

    test(`live @${label}: the give sheet ${phone ? "docks to the bottom, full width" : "opens beside the card"}, unclipped, no sideways pan`, async (t) => {
      if (!chrome) return t.skip("no headless Chrome");
      const m = await measure("board-on", w, h, { textSize, action: OPEN_GIVE, shot: `give-sheet-${w}${xl}` });
      assert.ok(m.doc <= 0 && m.body === 0, `no sideways pan ${JSON.stringify(m)}`);
      assert.ok(m.panel, `the sheet opens ${JSON.stringify(m)}`);
      assert.equal(m.panelOnTop, true, `nothing covers the sheet ${JSON.stringify(m)}`);
      assert.equal(m.panelScroll, 0, `nothing in the sheet overflows sideways ${JSON.stringify(m)}`);
      assert.ok(m.panel.l >= 0 && m.panel.r <= m.iw && m.panel.t >= 0 && m.panel.b <= m.ih, `inside the screen ${JSON.stringify(m)}`);
      assert.equal(m.goShown, true);
      assert.equal(m.goOnTop, true, `the Give button is reachable ${JSON.stringify(m)}`);
      if (phone) {
        assert.ok(m.panel.l === 0 && m.panel.r === m.iw && Math.abs(m.panel.b - m.ih) <= 1, `a bottom sheet ${JSON.stringify(m)}`);
      } else {
        assert.ok(m.panel.r - m.panel.l < m.iw / 2, `a popover, not a full-width sheet ${JSON.stringify(m)}`);
        const nearBelow = Math.abs(m.panel.t - m.btn.b) <= 12, nearAbove = Math.abs(m.btn.t - m.panel.b) <= 12;
        const beside = (Math.abs(m.panel.l - m.btn.r) <= 12 || Math.abs(m.btn.l - m.panel.r) <= 12) && m.panel.t <= m.btn.t && m.panel.b >= m.btn.b;
        assert.ok(nearBelow || nearAbove || beside, `anchored to the card's button ${JSON.stringify(m)}`);
        assert.ok(m.panel.r <= m.btn.l || m.panel.l >= m.btn.r || m.panel.b <= m.btn.t || m.panel.t >= m.btn.b, `and never on top of it ${JSON.stringify(m)}`);
      }
    });

    test(`live @${label}: the board-off view lists the lane and its sheet fits`, async (t) => {
      if (!chrome) return t.skip("no headless Chrome");
      const m = await measure("board-off", w, h, { textSize, action: OPEN_GIVE, shot: `board-off-give-${w}${xl}` });
      assert.ok(m.doc <= 0 && m.body === 0, JSON.stringify(m));
      assert.equal(m.panelOnTop, true, JSON.stringify(m));
      assert.ok(m.panel.l >= 0 && m.panel.r <= m.iw && m.panel.b <= m.ih, JSON.stringify(m));
    });

    test(`live @${label}: the Bot Builder "Give <Name> a task" dialog fits and is on top`, async (t) => {
      if (!chrome) return t.skip("no headless Chrome");
      const m = await measure("list", w, h, { textSize, action: OPEN_TASK, shot: `give-task-${w}${xl}` });
      assert.ok(m.doc <= 0 && m.body === 0, JSON.stringify(m));
      assert.ok(m.panel, `the dialog opens ${JSON.stringify(m)}`);
      assert.equal(m.panelOnTop, true, `nothing covers it ${JSON.stringify(m)}`);
      assert.equal(m.panelScroll, 0, JSON.stringify(m));
      assert.ok(m.panel.l >= 0 && m.panel.r <= m.iw && m.panel.t >= 0 && m.panel.b <= m.ih, JSON.stringify(m));
      assert.equal(m.goOnTop, true, JSON.stringify(m));
    });
  }
}

test("live @390x844: the check reaches the mechanism — an unassigned card that may not shrink pans the page", async (t) => {
  if (!chrome) return t.skip("no headless Chrome");
  const m = await measure("board-on", 390, 844, { css: ".bb-un-card{white-space:nowrap;width:600px}" });
  assert.ok(m.doc > 0 || m.body > 0, "forcing a 600px card must overflow, or this file proves nothing: " + JSON.stringify(m));
});

test("live @1280x800: the check reaches the mechanism — a sheet under another layer reads as covered", async (t) => {
  if (!chrome) return t.skip("no headless Chrome");
  const m = await measure("board-on", 1280, 800, { action: OPEN_GIVE, css: "body::after{content:'';position:fixed;inset:0;z-index:5000}" });
  assert.equal(m.panelOnTop, false, "a covered sheet must read as covered: " + JSON.stringify(m));
});
