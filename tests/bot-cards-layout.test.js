/**
 * Bot Builder cards + Bot Board picker (queue item 20, option B; T11) — live
 * layout. The real rendered Bot Builder list and Bot Board (a board-on bot
 * and a board-off bot) inside the real dashboard layout, at a 390 px phone
 * and a 1280 px wide screen, default and xlarge text:
 *   - the page never scrolls sideways, with the ⋯ popover or the picker
 *     sheet open too;
 *   - the header title is one line;
 *   - on a phone the cards are one column and at least two are fully on the
 *     first screen (default text); the ⋯ menu opens inline, unclipped;
 *   - on a wide screen the cards sit in three columns, the third row ending
 *     in the + New bot tile; the ⋯ popover is on top, unclipped;
 *   - the picker sheet docks to the bottom on a phone, drops under the
 *     button on wide;
 *   - the lanes are tabs on a phone (one lane shown; a tab switches it) and
 *     columns on wide;
 *   - the bot status strip is hidden on a phone and shown on a wide screen.
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

const dir = mkdtempSync(join(tmpdir(), "bot-cards-layout-"));
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
  await db.execute({ sql: "DELETE FROM providers", args: [] });
  await db.execute({ sql: "INSERT INTO providers (id, base_url, models, disabled) VALUES (?,?,?,0)",
    args: ["crow-chat", "http://127.0.0.1:9999/v1", JSON.stringify([{ id: "qwen3.6-35b-a3b", name: "Qwen3.6 35B A3B (local, chat)" }])] });
  const { createProjectSpace } = await import("../servers/shared/project-spaces.js");
  const pid = (await createProjectSpace(db, { name: "Helper's board" })).id;
  const add = (id, name, def, p) => db.execute({
    sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id, updated_at) VALUES (?,?,?,1,?,datetime('now','-9 days'))",
    args: [id, name, JSON.stringify({ models: { default: "crow-chat/qwen3.6-35b-a3b" }, ...def }), p] });
  await add("assistant", "A personal assistant with a long name", { gateways: [{ type: "perch" }, { type: "discord", token: "x" }], tracker_config: { type: "none" } }, null);
  await add("helper", "Helper", { gateways: [{ type: "perch" }], tracker_config: { type: "kanban" } }, pid);
  await add("home-kiosk", "Home kiosk companion", { gateways: [{ type: "companion", device_id: "d1" }] }, null);
  await add("glasses-bot", "Glasses", { gateways: [{ type: "glasses", device_id: "d2" }] }, null);
  await add("quiet-bot", "Quiet test bot", { gateways: [] }, null);

  const t = new Database(process.env.CROW_TASKS_DB_PATH);
  t.exec(`CREATE TABLE tasks_items (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
    description TEXT, status TEXT NOT NULL DEFAULT 'pending', priority INTEGER DEFAULT 3,
    due_date TEXT, phase TEXT, owner TEXT, tags TEXT, parent_id INTEGER, project_id INTEGER,
    assigned_bot TEXT, plan_ref TEXT, board_id INTEGER, data_json TEXT NOT NULL DEFAULT '{}',
    archived_at TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')), completed_at TEXT)`);
  t.prepare("INSERT INTO tasks_items (title, project_id, tags) VALUES (?,?,?)").run("Research: a fairly long card title that has to wrap on a phone screen", pid, "research");
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

async function measure(page, w, h, { textSize = null, css = "", openMenu = false, openPicker = false, laneTab = -1, view = "", shot = "" } = {}) {
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
    if (openMenu !== false) await evalIn("(function(){var b=document.querySelectorAll('.btb-more')[" + (openMenu === true ? 0 : openMenu) + "];b.scrollIntoView({block:'center'});b.click();return 1;})()");
    if (openPicker) await evalIn("(function(){document.querySelector('.bb-pick-btn').click();return 1;})()");
    if (laneTab >= 0) await evalIn("(function(){document.querySelectorAll('.bb-lane-tabs [role=tab]')[" + laneTab + "].click();return 1;})()");
    if (view) await evalIn("(function(){document.querySelector('.bb-view-btn[data-view=" + view + "]').click();return 1;})()");
    if (css) await evalIn(`(function(){var s=document.createElement('style');s.textContent=${JSON.stringify(css)};document.head.appendChild(s);return 1;})()`);
    await evalIn("new Promise(function(r){requestAnimationFrame(function(){requestAnimationFrame(function(){r(1);});});})");
    const m = JSON.parse(await evalIn(`(function(){
      var cb=document.querySelector('.content-body');
      var h2=document.querySelector('.content-header h2'); var rg=document.createRange(); rg.selectNodeContents(h2);
      var lines={}; Array.prototype.forEach.call(rg.getClientRects(),function(r){ if(r.width>0) lines[Math.round(r.top)]=1; });
      var vis=function(e){ if(!e) return null; var r=e.getBoundingClientRect(); return r.width>0&&r.height>0; };
      var box=function(e){ if(!e) return null; var r=e.getBoundingClientRect(); return {l:Math.round(r.left),r:Math.round(r.right),t:Math.round(r.top),b:Math.round(r.bottom)}; };
      var cards=Array.prototype.slice.call(document.querySelectorAll('.btb-botcard'));
      var tops=cards.map(function(c){return Math.round(c.getBoundingClientRect().top);});
      var menu=document.querySelector('.btb-menu:not([hidden])');
      var hit=null;
      if(menu){ var mr=menu.getBoundingClientRect(); var el=document.elementFromPoint(mr.left+mr.width/2, Math.min(mr.top+12, innerHeight-2)); hit=!!(el&&menu.contains(el)); }
      var sheet=document.querySelector('details.bb-picker[open] .bb-sheet');
      var sheetHit=null;
      if(sheet){ var sr=sheet.getBoundingClientRect(); var se=document.elementFromPoint(sr.left+sr.width/2, sr.top+sr.height/2); sheetHit=!!(se&&sheet.contains(se)); }
      var roost=document.querySelector('.bb-roost');
      var cols=Array.prototype.slice.call(document.querySelectorAll('#bb-board .bb-col')).filter(vis).map(function(c){return c.getAttribute('data-col');});
      var tabs=document.querySelector('.bb-lane-tabs');
      return JSON.stringify({
        doc: document.documentElement.scrollWidth-innerWidth,
        body: cb.scrollWidth-cb.clientWidth,
        titleLines: Object.keys(lines).length,
        iw: innerWidth, ih: innerHeight,
        cards: cards.length,
        tops: tops,
        onFirstScreen: cards.filter(function(c){var r=c.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;}).length,
        newTile: vis(document.querySelector('.btb-botcard-new')),
        newTileTop: box(document.querySelector('.btb-botcard-new')),
        menu: box(menu), menuOnTop: hit,
        menuStatic: menu ? getComputedStyle(menu).position==='static' : null,
        picker: vis(document.querySelector('.bb-pick-btn')),
        sheet: box(sheet), sheetOnTop: sheetHit,
        roostShown: roost ? roost.getBoundingClientRect().height>0 : null,
        tabsShown: vis(tabs),
        cols: cols,
        selTab: (function(){var t=document.querySelector('.bb-lane-tabs [aria-selected=true]');return t?t.getAttribute('data-lane'):null;})()
      });})()`));
    if (shot && SHOT_DIR) {
      const full = await evalIn("Math.ceil(document.documentElement.scrollHeight)");
      await send("Emulation.setDeviceMetricsOverride", { width: w, height: Math.max(h, Math.min(full, 3000)), deviceScaleFactor: 1, mobile: w < 700 });
      const png = await send("Page.captureScreenshot", { format: "png" });
      mkdirSync(SHOT_DIR, { recursive: true });
      writeFileSync(join(SHOT_DIR, shot + ".png"), Buffer.from(png.data, "base64"));
    }
    // the view toggle is remembered per browser profile; never leak it into the next page
    if (view) await evalIn("(function(){try{Object.keys(localStorage).forEach(function(k){if(k.indexOf('bb-view-')===0)localStorage.removeItem(k);});}catch(e){}return 1;})()");
    return m;
  } finally { ws.close(); await fetch(chrome.cdp + "/json/close/" + tab.id).catch(() => {}); }
}

for (const [w, h] of [[390, 844], [1280, 800]]) {
  for (const textSize of [null, "xlarge"]) {
    const label = `${w}x${h}${textSize ? " xlarge text" : ""}`;
    const phone = w < 700;
    const xl = textSize ? "-xl" : "";
    test(`live @${label}: list and board never pan sideways; the title is one line`, async (t) => {
      if (!chrome) return t.skip("no headless Chrome");
      for (const page of ["list", "board-on", "board-off"]) {
        const m = await measure(page, w, h, { textSize, shot: `${page}-${w}${xl}` });
        assert.ok(m.doc <= 0, `${page}: the page is wider than the screen ${JSON.stringify(m)}`);
        assert.equal(m.body, 0, `${page}: the panel pans inside .content-body ${JSON.stringify(m)}`);
        assert.equal(m.titleLines, 1, `${page}: the header title wraps ${JSON.stringify(m)}`);
        if (page !== "list") assert.equal(m.picker, true, `${page}: the name button shows ${JSON.stringify(m)}`);
        if (page === "board-on") {
          assert.equal(m.roostShown, !phone, `${page}: the bot status strip is ${phone ? "hidden on a phone" : "shown on wide"} ${JSON.stringify(m)}`);
        }
      }
    });

    test(`live @${label}: the cards ${phone ? "are one column, two+ on the first screen" : "sit in three columns, ending in the New bot tile"}`, async (t) => {
      if (!chrome) return t.skip("no headless Chrome");
      const m = await measure("list", w, h, { textSize });
      assert.equal(m.cards, 5);
      const distinctTops = new Set(m.tops).size;
      if (phone) {
        assert.equal(distinctTops, 5, `one card per line ${JSON.stringify(m)}`);
        assert.equal(m.newTile, false, `the tile is wide-only; the toolbar button is the phone's way in ${JSON.stringify(m)}`);
        // the first-screen budget is for the default text size
        if (!textSize) assert.ok(m.onFirstScreen >= 2, `at least two whole cards on the first screen ${JSON.stringify(m)}`);
      } else {
        assert.ok(m.tops[0] === m.tops[1] && m.tops[1] === m.tops[2] && m.tops[3] > m.tops[2], `three per line ${JSON.stringify(m)}`);
        assert.equal(m.newTile, true);
        assert.equal(m.newTileTop.t, m.tops[3], `the tile closes the second line ${JSON.stringify(m)}`);
      }
    });

    test(`live @${label}: the ⋯ menu opens ${phone ? "inline below the footer" : "as a popover on top"}, unclipped, no sideways pan`, async (t) => {
      if (!chrome) return t.skip("no headless Chrome");
      // the first card, and a card in the last column on wide (index 2)
      for (const idx of phone ? [0] : [0, 2]) {
        const m = await measure("list", w, h, { textSize, openMenu: idx, shot: idx ? "" : `list-menu-${w}${xl}` });
        assert.ok(m.doc <= 0 && m.body === 0, `an open ⋯ menu does not pan the page ${JSON.stringify(m)}`);
        assert.ok(m.menu && m.menu.l >= 0 && m.menu.r <= m.iw, `the menu is inside the screen ${JSON.stringify(m)}`);
        assert.equal(m.menuOnTop, true, `nothing covers the menu ${JSON.stringify(m)}`);
        assert.equal(m.menuStatic, phone, `${phone ? "inline" : "a popover"} ${JSON.stringify(m)}`);
      }
    });

    test(`live @${label}: the picker sheet ${phone ? "docks to the bottom" : "drops under the button"}`, async (t) => {
      if (!chrome) return t.skip("no headless Chrome");
      const m = await measure("board-on", w, h, { textSize, openPicker: true, shot: `board-picker-${w}${xl}` });
      assert.ok(m.doc <= 0 && m.body === 0, `the open sheet does not pan the page ${JSON.stringify(m)}`);
      assert.ok(m.sheet, `the sheet opens ${JSON.stringify(m)}`);
      assert.equal(m.sheetOnTop, true, `nothing covers the sheet ${JSON.stringify(m)}`);
      if (phone) {
        assert.ok(m.sheet.l === 0 && m.sheet.r === m.iw && Math.abs(m.sheet.b - m.ih) <= 1, `a full-width bottom sheet ${JSON.stringify(m)}`);
      } else {
        assert.ok(m.sheet.l >= 0 && m.sheet.r <= m.iw && m.sheet.b <= m.ih, `a popover inside the screen ${JSON.stringify(m)}`);
      }
    });

    test(`live @${label}: the lanes are ${phone ? "tabs, one shown at a time" : "columns, no tabs"}`, async (t) => {
      if (!chrome) return t.skip("no headless Chrome");
      const m = await measure("board-on", w, h, { textSize });
      if (phone) {
        assert.equal(m.tabsShown, true, `tabs show ${JSON.stringify(m)}`);
        assert.deepEqual(m.cols, ["pending"], `the lane with cards opens first, alone ${JSON.stringify(m)}`);
        const m2 = await measure("board-on", w, h, { textSize, laneTab: 2, shot: `board-tab-done-${w}${xl}` });
        assert.deepEqual(m2.cols, ["done"], `a tab switches the lane ${JSON.stringify(m2)}`);
        assert.equal(m2.selTab, "done");
        assert.ok(m2.doc <= 0 && m2.body === 0, JSON.stringify(m2));
        const m3 = await measure("board-on", w, h, { textSize, view: "list" });
        assert.equal(m3.tabsShown, false, `the list view hides the lane tabs ${JSON.stringify(m3)}`);
        assert.deepEqual(m3.cols, [], `the list view hides the lanes ${JSON.stringify(m3)}`);
        const m4 = await measure("board-on", w, h, { textSize });
        assert.equal(m4.tabsShown, true, `the next page is back on columns ${JSON.stringify(m4)}`);
      } else {
        assert.equal(m.tabsShown, false, `no tabs on wide ${JSON.stringify(m)}`);
        assert.ok(m.cols.length >= 3, `the columns show side by side ${JSON.stringify(m)}`);
      }
    });
  }
}

test("live @390x844: the check reaches the mechanism — a card that may not shrink pans the page", async (t) => {
  if (!chrome) return t.skip("no headless Chrome");
  const m = await measure("list", 390, 844, { css: ".btb-botcard{white-space:nowrap;width:600px}" });
  assert.ok(m.doc > 0 || m.body > 0, "forcing a 600px card must overflow, or this file proves nothing: " + JSON.stringify(m));
});

test("live @1280x800: the check reaches the mechanism — a clipping card hides its popover", async (t) => {
  if (!chrome) return t.skip("no headless Chrome");
  const m = await measure("list", 1280, 800, { openMenu: true, css: ".btb-botcard{overflow:hidden}" });
  assert.equal(m.menuOnTop, false, "a clipped popover must read as covered, or the unclipped check proves nothing: " + JSON.stringify(m));
});
