/**
 * Bot Builder rows + Bot Board picker (queue item 20, option A; T11) — live
 * layout. The real rendered Bot Builder list and Bot Board (a board-on bot
 * and a board-off bot) inside the real dashboard layout, at a 390 px phone
 * and a 1280 px wide screen, default and xlarge text:
 *   - the page never scrolls sideways (the chip strip scrolls inside itself);
 *   - the header title is one line;
 *   - on a phone the five bot rows fit within one 844 px screen (one and a
 *     half at xlarge text);
 *   - on a wide screen the rows sit in two columns;
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

const dir = mkdtempSync(join(tmpdir(), "bot-rows-layout-"));
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

async function measure(page, w, h, { textSize = null, css = "", openMenu = false, shot = "" } = {}) {
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
    if (openMenu) await evalIn("(function(){var b=document.querySelector('.btb-more');if(b)b.click();return 1;})()");
    if (css) await evalIn(`(function(){var s=document.createElement('style');s.textContent=${JSON.stringify(css)};document.head.appendChild(s);return 1;})()`);
    await evalIn("new Promise(function(r){requestAnimationFrame(function(){requestAnimationFrame(function(){r(1);});});})");
    const m = JSON.parse(await evalIn(`(function(){
      var cb=document.querySelector('.content-body');
      var h2=document.querySelector('.content-header h2'); var rg=document.createRange(); rg.selectNodeContents(h2);
      var lines={}; Array.prototype.forEach.call(rg.getClientRects(),function(r){ if(r.width>0) lines[Math.round(r.top)]=1; });
      var rows=Array.prototype.slice.call(document.querySelectorAll('.btb-row'));
      var roost=document.querySelector('.bb-roost');
      var chips=document.querySelector('.bb-chips-bots');
      return JSON.stringify({
        doc: document.documentElement.scrollWidth-innerWidth,
        body: cb.scrollWidth-cb.clientWidth,
        titleLines: Object.keys(lines).length,
        rows: rows.length,
        rowsSpan: rows.length ? Math.round(rows[rows.length-1].getBoundingClientRect().bottom-rows[0].getBoundingClientRect().top) : 0,
        sameTop: rows.length>1 ? rows[0].offsetTop===rows[1].offsetTop : null,
        roostShown: roost ? roost.getBoundingClientRect().height>0 : null,
        chipsFit: chips ? chips.getBoundingClientRect().right<=cb.getBoundingClientRect().right+1 : null
      });})()`));
    if (shot && SHOT_DIR) {
      const full = await evalIn("Math.ceil(document.documentElement.scrollHeight)");
      await send("Emulation.setDeviceMetricsOverride", { width: w, height: Math.max(h, Math.min(full, 3000)), deviceScaleFactor: 1, mobile: w < 700 });
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
    test(`live @${label}: list and board never pan sideways; the title is one line`, async (t) => {
      if (!chrome) return t.skip("no headless Chrome");
      for (const page of ["list", "board-on", "board-off"]) {
        const shot = `${page}-${w}${textSize ? "-xl" : ""}`;
        const m = await measure(page, w, h, { textSize, shot });
        assert.ok(m.doc <= 0, `${page}: the page is wider than the screen ${JSON.stringify(m)}`);
        assert.equal(m.body, 0, `${page}: the panel pans inside .content-body ${JSON.stringify(m)}`);
        assert.equal(m.titleLines, 1, `${page}: the header title wraps ${JSON.stringify(m)}`);
        if (page !== "list") {
          assert.equal(m.chipsFit, true, `${page}: the chip strip stays inside the panel ${JSON.stringify(m)}`);
        }
        if (page === "board-on") {
          assert.equal(m.roostShown, !phone, `${page}: the bot status strip is ${phone ? "hidden on a phone" : "shown on wide"} ${JSON.stringify(m)}`);
        }
      }
      const open = await measure("list", w, h, { textSize, openMenu: true, shot: `list-menu-${w}${textSize ? "-xl" : ""}` });
      assert.ok(open.doc <= 0 && open.body === 0, `an open ⋯ menu does not pan the page ${JSON.stringify(open)}`);
    });

    test(`live @${label}: the rows ${phone ? (textSize ? "fit one and a half phone screens" : "fit one phone screen") : "sit in two columns"}`, async (t) => {
      if (!chrome) return t.skip("no headless Chrome");
      const m = await measure("list", w, h, { textSize });
      assert.equal(m.rows, 5);
      // The one-screen budget is for the default text size. At xlarge every
      // line is ~1.3x taller and a row is four lines plus its buttons, so the
      // budget there is the same five rows within one and a half screens.
      if (phone) {
        const budget = textSize ? Math.round(844 * 1.5) : 844;
        assert.ok(m.rowsSpan <= budget, `five rows take ${m.rowsSpan}px (budget ${budget}) ${JSON.stringify(m)}`);
      }
      else assert.equal(m.sameTop, true, `rows 1 and 2 share a line ${JSON.stringify(m)}`);
    });
  }
}

test("live @390x844: the check reaches the mechanism — a row that may not shrink pans the page", async (t) => {
  if (!chrome) return t.skip("no headless Chrome");
  const m = await measure("list", 390, 844, { css: ".btb-row{white-space:nowrap;width:600px;flex-wrap:nowrap}" });
  assert.ok(m.doc > 0 || m.body > 0, "forcing a 600px row must overflow, or this file proves nothing: " + JSON.stringify(m));
});
