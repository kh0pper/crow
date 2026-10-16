/**
 * "Which bot answers voice" (queue item 20, PR 3, task 10) — live layout.
 * The real rendered Bot Builder list (kiosk available, devices bound) and the
 * real Kiosk panel, inside the real dashboard layout, served next to a canned
 * Kiosk listing, at a 390 px phone and a 1280 px wide screen, default and
 * xlarge text:
 *   - the page never scrolls sideways, with the "Use for voice…" dialog open too;
 *   - a card's voice line with several places wraps inside the card, and on a
 *     phone at least two whole cards are still on the first screen;
 *   - the dialog is unclipped, on top, nothing in it overflows sideways, and
 *     Save is reachable;
 *   - the Kiosk panel's "Automatic — now {name}" select fits the screen.
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
import { startHeadlessChrome } from "./fixtures/headless-chrome.mjs";

const dir = mkdtempSync(join(tmpdir(), "voice-bot-layout-"));
process.env.CROW_DATA_DIR = dir;
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
delete process.env.CROW_DB_PATH;

const SHOT_DIR = process.env.CROW_TEST_SHOT_DIR || "";
let chrome = null, server = null, port = 0, db = null;
const pages = {};

const LONG = "A personal assistant with a long name";
const LISTING = {
  devices: [
    { id: "kiosk-1", name: "Kitchen counter display", bound_bot_id: "assistant", connected: true, latency: {}, kiosk_settings: { memory_integration: false } },
    { id: "kiosk-2", name: "Hallway display by the front door", bound_bot_id: "assistant", connected: false, latency: {}, kiosk_settings: { memory_integration: true } },
  ],
  bots: [
    { bot_id: "assistant", display_name: LONG, fit: "full", fit_memory: "no_skills" },
    { bot_id: "glasses-bot", display_name: "Glasses", fit: "no_skills", fit_memory: "too_large" },
    { bot_id: "helper", display_name: "Helper", fit: "full", fit_memory: "full" },
    { bot_id: "home-kiosk", display_name: "Home kiosk companion", fit: "too_large", fit_memory: "too_large" },
    { bot_id: "quiet-bot", display_name: "Quiet test bot", fit: null, fit_memory: null },
  ],
  pending: [], stt_profiles: [{ id: "stt-a", name: "Whisper" }], tts_profiles: [{ id: "tts-a", name: "Kokoro", provider: "kokoro" }],
  dashboard_voice: { available: true, bot_id: null, effective_bot_id: "assistant", auto_bot_id: "assistant" },
};

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: new URL("..", import.meta.url).pathname,
  });
  const { createDbClient } = await import("../servers/db.js");
  db = createDbClient();
  await db.execute({ sql: "DELETE FROM providers", args: [] });
  await db.execute({ sql: "INSERT INTO providers (id, base_url, models, disabled) VALUES (?,?,?,0)",
    args: ["crow-chat", "http://127.0.0.1:9999/v1", JSON.stringify([{ id: "qwen3.6-35b-a3b", name: "Qwen3.6 35B A3B (local, chat)" }])] });
  const add = (id, name, def) => db.execute({
    sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id, updated_at) VALUES (?,?,?,1,NULL,datetime('now','-9 days'))",
    args: [id, name, JSON.stringify({ models: { default: "crow-chat/qwen3.6-35b-a3b" }, ...def })] });
  await add("assistant", LONG, { gateways: [{ type: "perch" }], tracker_config: { type: "none" } });
  await add("glasses-bot", "Glasses", { gateways: [{ type: "glasses", device_id: "d2" }] });
  await add("helper", "Helper", { gateways: [{ type: "perch" }] });
  await add("home-kiosk", "Home kiosk companion", { gateways: [{ type: "companion", device_id: "d1" }] });
  await add("quiet-bot", "Quiet test bot", { gateways: [] });
  // The assistant also answers on a pair of glasses: its line carries glasses + phone & dashboard + two displays.
  await db.execute({ sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('meta_glasses_devices', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    args: [JSON.stringify([
      { id: "d1", name: "Living room companion", device_kind: "companion", bound_bot_id: "home-kiosk" },
      { id: "d2", name: "Walking glasses", device_kind: "glasses", bound_bot_id: "glasses-bot" },
      { id: "d5", name: "Reading glasses with a long name", device_kind: "glasses", bound_bot_id: "assistant" },
    ])] });

  const { renderLayout } = await import("../servers/gateway/dashboard/shared/layout.js");
  const { renderBotList } = await import("../servers/gateway/dashboard/panels/bot-builder/html.js");
  const { botBuilderStyles } = await import("../servers/gateway/dashboard/panels/bot-builder/css.js");
  const { default: kioskPanel } = await import("../bundles/kiosk/panel/kiosk.js");
  const layoutFor = (active) => ({ title, content }) => renderLayout({ title, content, activePanel: active, panels: [], lang: "en" });
  const res = { send(s) { this.html = s; } };
  await renderBotList(res, { db, layout: layoutFor("bot-builder"), notice: "", PAGE_CSS: botBuilderStyles(), req: { headers: {}, csrfToken: "tok" }, kioskAvailable: true });
  pages.list = res.html;
  await kioskPanel.handler({ query: {} }, { send(s) { pages.kiosk = s; } }, { db, lang: "en", layout: layoutFor("kiosk") });

  chrome = await startHeadlessChrome();
  if (!chrome) return;
  server = http.createServer((req, r) => {
    const url = (req.url || "/").split("?")[0];
    if (url === "/api/kiosk/admin/displays") { r.writeHead(200, { "content-type": "application/json" }); return r.end(JSON.stringify(LISTING)); }
    if (url.startsWith("/api/")) { r.writeHead(200, { "content-type": "application/json" }); return r.end(url.endsWith("/stations") ? '{"stations":[]}' : '{"installed":false}'); }
    r.writeHead(200, { "content-type": "text/html" });
    r.end(pages[url.slice(1)] || "");
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

const WAIT_LINES = "new Promise(function(r){var n=0;(function w(){var it=document.querySelector('.btb-voice-use');if((it&&!it.hidden)||n++>50)return r(1);setTimeout(w,50);})();})";
const OPEN_VOICE = "new Promise(function(r){var it=document.querySelector('.btb-voice-use[data-bot-id=\"assistant\"]');" +
  "var more=document.querySelector('[aria-controls=\"'+it.closest('.btb-menu').id+'\"]');more.scrollIntoView({block:'center'});more.click();it.click();" +
  "var n=0;(function w(){if(document.querySelector('[data-vu-row=\"dev:kiosk-2\"]')||n++>50)return r(1);setTimeout(w,50);})();})";
const WAIT_KIOSK = "new Promise(function(r){var n=0;(function w(){if(document.querySelector('#kk-dash select')||n++>60)return r(1);setTimeout(w,50);})();})";

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
    await evalIn(page === "kiosk" ? WAIT_KIOSK : WAIT_LINES);
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
      var cards=Array.prototype.slice.call(document.querySelectorAll('.btb-botcard'));
      var line=document.querySelector('.btb-voice[data-voice-bot="assistant"]');
      var card=line?line.closest('.btb-botcard'):null;
      var lineRects=line?Array.prototype.slice.call(line.getClientRects()):[];
      var panel=document.querySelector('#btb-vu:not([hidden]) .btb-give-panel');
      var save=document.getElementById('btb-vu-save');
      var sel=document.querySelector('#kk-dash select');
      return JSON.stringify({
        doc: document.documentElement.scrollWidth-innerWidth,
        body: cb.scrollWidth-cb.clientWidth,
        iw: innerWidth, ih: innerHeight,
        cards: cards.length,
        onFirstScreen: cards.filter(function(c){var r=c.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;}).length,
        line: line ? { shown: vis(line), text: line.textContent, box: box(line), card: box(card), lines: Math.round(line.getBoundingClientRect().height / parseFloat(getComputedStyle(line).lineHeight || 16)) } : null,
        hiddenItems: Array.prototype.slice.call(document.querySelectorAll('.btb-voice-use')).filter(function(e){return e.hidden;}).length,
        panel: box(panel), panelOnTop: onTop(panel), panelScroll: panel ? panel.scrollWidth-panel.clientWidth : null,
        saveOnTop: onTop(save),
        rows: document.querySelectorAll('#btb-vu [data-vu-row]').length,
        sel: sel ? { box: box(sel), auto: sel.options[0].textContent, scroll: sel.closest('.kk-card').scrollWidth - sel.closest('.kk-card').clientWidth } : null
      });})()`));
    if (shot && SHOT_DIR) {
      if (!action) {
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

    test(`live @${label}: the voice line wraps inside its card; no sideways pan${phone && !textSize ? "; two whole cards on the first screen" : ""}`, async (t) => {
      if (!chrome) return t.skip("no headless Chrome");
      const m = await measure("list", w, h, { textSize, shot: `voice-list-${w}${xl}` });
      assert.ok(m.doc <= 0 && m.body === 0, `no sideways pan ${JSON.stringify(m)}`);
      assert.equal(m.hiddenItems, 0, `the listing loaded: every Use for voice… shows ${JSON.stringify(m)}`);
      assert.equal(m.line.shown, true, JSON.stringify(m));
      for (const bit of ["Reading glasses with a long name", "Phone & dashboard (automatic)", "Kitchen counter display", "Hallway display by the front door"]) {
        assert.ok(m.line.text.includes(bit), `${bit} ${JSON.stringify(m.line)}`);
      }
      assert.ok(m.line.box.l >= m.line.card.l && m.line.box.r <= m.line.card.r, `inside its card ${JSON.stringify(m.line)}`);
      if (phone && !textSize) assert.ok(m.onFirstScreen >= 2, `two whole cards on the first screen ${JSON.stringify(m)}`);
    });

    test(`live @${label}: the "Use for voice…" dialog ${phone ? "is a bottom sheet" : "is a centred modal"}, unclipped, on top, Save reachable`, async (t) => {
      if (!chrome) return t.skip("no headless Chrome");
      const m = await measure("list", w, h, { textSize, action: OPEN_VOICE, shot: `voice-dialog-${w}${xl}` });
      assert.ok(m.doc <= 0 && m.body === 0, JSON.stringify(m));
      assert.ok(m.panel, `the dialog opens ${JSON.stringify(m)}`);
      assert.equal(m.rows, 3, `Phone & dashboard + two displays ${JSON.stringify(m)}`);
      assert.equal(m.panelOnTop, true, `nothing covers it ${JSON.stringify(m)}`);
      assert.equal(m.panelScroll, 0, `nothing in it overflows sideways ${JSON.stringify(m)}`);
      assert.ok(m.panel.l >= 0 && m.panel.r <= m.iw && m.panel.t >= 0 && m.panel.b <= m.ih, `inside the screen ${JSON.stringify(m)}`);
      assert.equal(m.saveOnTop, true, `Save is reachable ${JSON.stringify(m)}`);
      if (phone) assert.ok(m.panel.l === 0 && m.panel.r === m.iw, `full width on a phone ${JSON.stringify(m)}`);
    });

    test(`live @${label}: the Kiosk panel's "Automatic — now {name}" select fits the screen`, async (t) => {
      if (!chrome) return t.skip("no headless Chrome");
      const m = await measure("kiosk", w, h, { textSize, action: "(function(){document.getElementById('kk-dash').scrollIntoView({block:'start'});return 1;})()", shot: `voice-kiosk-${w}${xl}` });
      assert.ok(m.sel, `the picker renders ${JSON.stringify(m)}`);
      assert.equal(m.sel.auto, `Automatic — now ${LONG}`);
      assert.ok(m.doc <= 0 && m.body === 0, `no sideways pan ${JSON.stringify(m)}`);
      assert.ok(m.sel.box.l >= 0 && m.sel.box.r <= m.iw, `the select is inside the screen ${JSON.stringify(m)}`);
      assert.ok(m.sel.scroll <= 0, `nothing in its card overflows ${JSON.stringify(m)}`);
    });
  }
}

test("live @390x844: the check reaches the mechanism — a voice line that may not wrap pans the page", async (t) => {
  if (!chrome) return t.skip("no headless Chrome");
  const m = await measure("list", 390, 844, { css: ".btb-voice{white-space:nowrap;overflow-wrap:normal}.btb-botcard{min-width:max-content}" });
  assert.ok(m.doc > 0 || m.body > 0, "a nowrap voice line must overflow, or this file proves nothing: " + JSON.stringify(m));
});

test("live @390x844: the check reaches the mechanism — a select that may not shrink pans the Kiosk panel", async (t) => {
  if (!chrome) return t.skip("no headless Chrome");
  const m = await measure("kiosk", 390, 844, { css: "#kk-dash select{min-width:700px !important;max-width:none !important}" });
  assert.ok(m.doc > 0 || m.body > 0 || m.sel.scroll > 0 || m.sel.box.r > m.iw, "a 700px select must overflow, or this file proves nothing: " + JSON.stringify(m));
});
