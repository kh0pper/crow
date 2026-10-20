/**
 * Crow's voice (PR 1) — live layout. The real rendered Bot Builder list (Crow's
 * card first, the Kiosk available), the real Crow voice editor, and the real
 * Kiosk panel ("Answers as Crow · Customise in Bot Builder" where the
 * assistant pickers were), inside the real dashboard layout, served next to a
 * canned Kiosk listing, at a 390 px phone and a 1280 px wide screen, default
 * and xlarge text:
 *   - no page ever scrolls sideways;
 *   - Crow's card comes first, and its abilities line wraps inside it; on a
 *     phone at least two whole cards are still on the first screen;
 *   - the editor's preset cards, selects and persona box stay inside the
 *     screen, and Save is reachable;
 *   - each Kiosk "Answers as Crow" line stays inside its box.
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
process.env.CROW_HOME = join(dir, "home");
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
delete process.env.CROW_DB_PATH;

const SHOT_DIR = process.env.CROW_TEST_SHOT_DIR || "";
let chrome = null, server = null, port = 0, db = null;
const pages = {};

const LONG = "A personal assistant with a long name";
const ABIL = { items: [{ id: "calendar", quick: false }, { id: "reminders", quick: false }, { id: "crow_messages", quick: true }, { id: "lists", quick: false }, { id: "projects", quick: true }, { id: "addon:nb", quick: true, label: "A notebook add-on with a long name" }], none: false };
const LISTING = {
  devices: [
    { id: "kiosk-1", name: "Kitchen counter display", bound_bot_id: "assistant", connected: true, latency: {}, kiosk_settings: { memory_integration: false } },
    { id: "kiosk-2", name: "Hallway display by the front door", connected: false, latency: {}, kiosk_settings: { memory_integration: true } },
  ],
  bots: [], pending: [], stt_profiles: [{ id: "stt-a", name: "Whisper" }], tts_profiles: [{ id: "tts-a", name: "Kokoro", provider: "kokoro" }],
  voice: { bot_id: "crow.voice", name: "Crow", fit: "full", fit_memory: "no_skills", abilities: ABIL, abilities_memory: ABIL },
  dashboard_talk: true,
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
  await db.execute({ sql: "INSERT INTO providers (id, base_url, host, models, disabled) VALUES (?,?,?,?,0)",
    args: ["cloud-provider-with-a-long-name", "http://127.0.0.1:9998/v1", "cloud", JSON.stringify([{ id: "a-cloud-model-with-a-very-long-identifier", name: "A cloud model with a very long display name" }])] });
  const add = (id, name, def) => db.execute({
    sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id, updated_at) VALUES (?,?,?,1,NULL,datetime('now','-9 days'))",
    args: [id, name, JSON.stringify(def)] });
  const { voiceBotDefinition } = await import("../servers/shared/voice-bot.js");
  await add("crow.voice", "Crow", voiceBotDefinition({ preset: "cloud", fastKey: "crow-chat/qwen3.6-35b-a3b", cloudKey: "cloud-provider-with-a-long-name/a-cloud-model-with-a-very-long-identifier" }));
  for (const [id, name] of [["assistant", LONG], ["helper", "Helper"], ["quiet-bot", "Quiet test bot"]]) {
    await add(id, name, { models: { default: "crow-chat/qwen3.6-35b-a3b" }, gateways: [{ type: "perch" }] });
  }

  const { renderLayout } = await import("../servers/gateway/dashboard/shared/layout.js");
  const { renderBotList } = await import("../servers/gateway/dashboard/panels/bot-builder/html.js");
  const { renderVoiceBotEditor } = await import("../servers/gateway/dashboard/panels/bot-builder/voice-bot-editor.js");
  const { botBuilderStyles } = await import("../servers/gateway/dashboard/panels/bot-builder/css.js");
  const { default: kioskPanel } = await import("../bundles/kiosk/panel/kiosk.js");
  const layoutFor = (active) => ({ title, content }) => renderLayout({ title, content, activePanel: active, panels: [], lang: "en" });
  const res = { send(s) { this.html = s; } };
  await renderBotList(res, { db, layout: layoutFor("bot-builder"), notice: "", PAGE_CSS: botBuilderStyles(), req: { headers: {}, csrfToken: "tok" }, kioskAvailable: true });
  pages.list = res.html;
  const ed = { send(s) { this.html = s; } };
  await renderVoiceBotEditor({ headers: {}, csrfToken: "tok" }, ed, { db, layout: layoutFor("bot-builder"), lang: "en", PAGE_CSS: botBuilderStyles(), notice: "", kioskAvailable: true });
  pages.editor = ed.html;
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

const WAIT_ABIL = "new Promise(function(r){var n=0;(function w(){var a=document.querySelector('.btb-abil');if((a&&!a.hidden)||n++>60)return r(1);setTimeout(w,50);})();})";
const WAIT_KIOSK = "new Promise(function(r){var n=0;(function w(){if(document.querySelectorAll('.kk-crow').length>=4||n++>60)return r(1);setTimeout(w,50);})();})";

async function measure(page, w, h, { textSize = null, css = "", shot = "" } = {}) {
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
    // Always set the size: tabs share the profile's localStorage, so a previous xlarge run would leak into a "default" one.
    await send("Page.enable");
    await send("Page.addScriptToEvaluateOnNewDocument", { source: `try{localStorage.setItem("crow-text-size",${JSON.stringify(textSize || "default")})}catch(e){}` });
    await send("Page.navigate", { url: `http://${chrome.pageHost}:${port}/${page}` });
    let ok = false;
    for (let i = 0; i < 75 && !ok; i++) { await new Promise((r) => setTimeout(r, 200)); try { ok = await evalIn("!!document.querySelector('.content-body') && document.readyState==='complete'"); } catch {} }
    assert.ok(ok, "the page never loaded: " + page);
    await evalIn(page === "kiosk" ? WAIT_KIOSK : WAIT_ABIL);
    if (css) await evalIn(`(function(){var s=document.createElement('style');s.textContent=${JSON.stringify(css)};document.head.appendChild(s);return 1;})()`);
    await evalIn("new Promise(function(r){requestAnimationFrame(function(){requestAnimationFrame(function(){r(1);});});})");
    const m = JSON.parse(await evalIn(`(function(){
      var cb=document.querySelector('.content-body');
      var box=function(e){ if(!e) return null; var r=e.getBoundingClientRect(); return {l:Math.round(r.left),r:Math.round(r.right),t:Math.round(r.top),b:Math.round(r.bottom),h:Math.round(r.height)}; };
      var inside=function(e, p){ var a=box(e), b=box(p); return !!(a&&b&&a.l>=b.l&&a.r<=b.r); };
      var cards=Array.prototype.slice.call(document.querySelectorAll('.btb-botcard'));
      var abil=document.querySelector('.btb-abil:not([hidden])');
      var save=document.querySelector('button[form="btb-vsave"][type="submit"]');
      return JSON.stringify({
        doc: document.documentElement.scrollWidth-innerWidth,
        body: cb.scrollWidth-cb.clientWidth,
        iw: innerWidth, ih: innerHeight,
        cards: cards.length,
        first: cards.length ? cards[0].getAttribute('data-bot') : null,
        onFirstScreen: cards.filter(function(c){var r=c.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;}).length,
        abil: abil ? { text: abil.textContent, box: box(abil), inCard: abil.closest('.btb-botcard') ? inside(abil, abil.closest('.btb-botcard')) : null, sw: abil.scrollWidth-abil.clientWidth } : null,
        fields: Array.prototype.slice.call(document.querySelectorAll('.btb-vsec select, .btb-vsec textarea, .btb-vsec input[type=text], .btb-vpreset')).map(function(e){var b=box(e);return {r:b.r,l:b.l};}),
        save: box(save),
        crow: Array.prototype.slice.call(document.querySelectorAll('.kk-crow')).map(function(e){return { inBox: inside(e, e.parentElement), sw: e.scrollWidth-e.clientWidth, text: e.textContent };})
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
    const xl = textSize ? "-xl" : "";

    test(`live @${label}: Crow's card comes first and its abilities line wraps inside it; no sideways pan${phone && !textSize ? "; two whole cards on the first screen" : ""}`, async (t) => {
      if (!chrome) return t.skip("no headless Chrome");
      const m = await measure("list", w, h, { textSize, shot: `voice-list-${w}${xl}` });
      assert.ok(m.doc <= 0 && m.body === 0, `no sideways pan ${JSON.stringify(m)}`);
      assert.equal(m.first, "crow.voice", JSON.stringify(m));
      assert.equal(m.cards, 4);
      assert.ok(m.abil && m.abil.text.indexOf("By voice on displays: ") === 0, JSON.stringify(m.abil));
      assert.ok(m.abil.inCard && m.abil.sw <= 0, `inside Crow's card ${JSON.stringify(m.abil)}`);
      if (phone && !textSize) assert.ok(m.onFirstScreen >= 2, `two whole cards on the first screen ${JSON.stringify(m)}`);
    });

    test(`live @${label}: the Crow voice editor never pans; every field and preset card fits the screen; Save is reachable`, async (t) => {
      if (!chrome) return t.skip("no headless Chrome");
      const m = await measure("editor", w, h, { textSize, shot: `voice-editor-${w}${xl}` });
      assert.ok(m.doc <= 0 && m.body === 0, `no sideways pan ${JSON.stringify(m)}`);
      assert.ok(m.fields.length >= 8, JSON.stringify(m.fields));
      for (const f of m.fields) assert.ok(f.l >= 0 && f.r <= m.iw, `inside the screen ${JSON.stringify(f)} of ${m.iw}`);
      assert.ok(m.save && m.save.l >= 0 && m.save.r <= m.iw && m.save.h > 0, `Save is there ${JSON.stringify(m.save)}`);
      assert.ok(m.abil && m.abil.sw <= 0, `the abilities line wraps ${JSON.stringify(m.abil)}`);
    });

    test(`live @${label}: the Kiosk panel's Answers as Crow lines stay inside their boxes`, async (t) => {
      if (!chrome) return t.skip("no headless Chrome");
      const m = await measure("kiosk", w, h, { textSize, shot: `voice-kiosk-${w}${xl}` });
      assert.ok(m.doc <= 0 && m.body === 0, `no sideways pan ${JSON.stringify(m)}`);
      assert.equal(m.crow.length, 4, `the pairing form, Talk to Crow and two displays ${JSON.stringify(m.crow)}`);
      for (const c of m.crow) assert.ok(c.inBox && c.sw <= 0 && c.text.startsWith("Answers as Crow"), JSON.stringify(c));
    });
  }
}

test("live @390x844: the check reaches the mechanism — preset cards that may not shrink pan the editor", async (t) => {
  if (!chrome) return t.skip("no headless Chrome");
  const m = await measure("editor", 390, 844, { css: ".btb-vpresets{grid-template-columns:repeat(2,600px)!important;max-width:none!important}" });
  assert.ok(m.doc > 0 || m.body > 0 || m.fields.some((f) => f.r > m.iw), "600px preset cards must overflow, or this file proves nothing: " + JSON.stringify(m));
});
