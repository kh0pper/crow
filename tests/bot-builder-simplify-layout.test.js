/**
 * Bot Builder simplification — phone width (the PR #452 rules): every view
 * of the editor fits a 390 px / 412 px phone without the panel panning
 * sideways, at the default and the dashboard's xlarge text size.
 *
 * Live: a private headless Chrome (tests/fixtures/headless-chrome.mjs) loads
 * the real rendered editor inside the real dashboard layout. Skips without a
 * browser unless CROW_REQUIRE_TEST_CHROME=1 (CI).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHeadlessChrome } from "./fixtures/headless-chrome.mjs";

const dir = mkdtempSync(join(tmpdir(), "btb-simplify-layout-"));
process.env.CROW_DATA_DIR = dir;

const LONG_TOOL = "crow_browser_capture_har_image_with_a_very_long_name_that_has_no_spaces";
const SOURCES = {
  error: null,
  sources: [
    { server: "crow-memory", name: "Crow memory", account: "", ok: true, catalog: [
      { name: "crow_store_memory", access: "write" }, { name: "crow_search_memories", access: "read" } ] },
    { server: "google-workspace-a-very-long-account-name-for-testing-wrap", name: "Google Workspace",
      account: "a-very-long-account-name-for-testing-wrap@example.com", ok: true, catalog: [
        { name: "gmail_search_threads", access: "read" }, { name: "gmail_create_draft", access: "write" },
        { name: LONG_TOOL, access: "write" } ] },
  ],
};
const DEF = {
  models: { default: "test-prov/model-a" },
  tools: { pi_builtin: ["read"], crow_mcp: ["google-workspace-a-very-long-account-name-for-testing-wrap/gmail_search_threads", "google-workspace-a-very-long-account-name-for-testing-wrap/" + LONG_TOOL] },
  gateways: [{ type: "gmail", address: "a-rather-long-bot-address+alias@example.com", allowlist: ["alex@example.com"] }],
  permission_policy: { bash: "allowlist", bash_allow: ["git status"], write_paths: ["/srv/bots/a/really/deep/workspace/folder/that/is/long"], external_send: "draft_only", confirm: [] },
  system_prompt: "You are a helpful bot.",
};
const VIEWS = ["basics", "abilities", "safety", "activity", "advanced"];

let chrome = null, server = null, port = 0, db = null;
const pages = {};

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: new URL("..", import.meta.url).pathname,
  });
  const { createDbClient } = await import("../servers/db.js");
  db = createDbClient();
  await db.execute({ sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES (?,?,?,1)",
    args: ["phone-bot", "A bot with a fairly long display name for phones", JSON.stringify(DEF)] });
  const { _setSourcesForTest } = await import("../servers/gateway/dashboard/panels/bot-builder/sources.js");
  _setSourcesForTest(SOURCES);
  const { _setEngineStatusForTest } = await import("../servers/gateway/dashboard/panels/bot-builder/api-handlers.js");
  _setEngineStatusForTest({ state: "ready", source: "test" });
  const { renderBotEditor } = await import("../servers/gateway/dashboard/panels/bot-builder/editor.js");
  const { botBuilderStyles } = await import("../servers/gateway/dashboard/panels/bot-builder/css.js");
  const { renderLayout } = await import("../servers/gateway/dashboard/shared/layout.js");
  for (const v of VIEWS) {
    const res = { send(s) { this.html = s; } };
    const q = { bot: "phone-bot", tab: v };
    await renderBotEditor({ method: "GET", query: q, body: {}, cookies: {}, headers: {} }, res,
      { db, layout: ({ title, content }) => renderLayout({ title, content, activePanel: "bot-builder", panels: [], lang: "en" }),
        lang: "en", PAGE_CSS: botBuilderStyles(), botId: "phone-bot", notice: "", q });
    pages[v] = res.html;
  }
  chrome = await startHeadlessChrome();
  if (!chrome) return;
  server = http.createServer((req, res) => {
    const v = (req.url || "/").slice(1) || "basics";
    res.writeHead(200, { "content-type": "text/html" });
    res.end(pages[v] || "");
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

async function measure(view, w, h, { textSize = null, css = "" } = {}) {
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
    await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 2, mobile: true });
    if (textSize) {
      await send("Page.enable");
      await send("Page.addScriptToEvaluateOnNewDocument", { source: `try{localStorage.setItem("crow-text-size",${JSON.stringify(textSize)})}catch(e){}` });
    }
    await send("Page.navigate", { url: `http://${chrome.pageHost}:${port}/${view}` });
    let ok = false;
    for (let i = 0; i < 75 && !ok; i++) { await new Promise((r) => setTimeout(r, 200)); try { ok = await evalIn("!!document.querySelector('.btb-tabs')"); } catch {} }
    assert.ok(ok, "the editor never loaded: " + view);
    // open every disclosure so their contents are measured too
    await evalIn("(function(){document.querySelectorAll('details').forEach(function(d){d.open=true;});return 1;})()");
    if (css) await evalIn(`(function(){var s=document.createElement('style');s.textContent=${JSON.stringify(css)};document.head.appendChild(s);return 1;})()`);
    await evalIn("new Promise(function(r){requestAnimationFrame(function(){requestAnimationFrame(function(){r(1);});});})");
    return JSON.parse(await evalIn(`(function(){var cb=document.querySelector('.content-body');
      var worst=null,lim=cb.getBoundingClientRect().left+cb.clientWidth+1;
      document.querySelectorAll('.content-body *').forEach(function(e){var r=e.getBoundingClientRect();
        if(r.width&&r.right>lim){ var sc=e.closest('.table-scroll,.btb-tool-list,pre'); if(!sc && (!worst||r.right>worst.r)) worst={r:Math.round(r.right),tag:e.tagName,cls:String(e.className).slice(0,40)}; }});
      return JSON.stringify({body:cb.scrollWidth-cb.clientWidth, doc:document.documentElement.scrollWidth-innerWidth, worst:worst});})()`));
  } finally { ws.close(); await fetch(chrome.cdp + "/json/close/" + tab.id).catch(() => {}); }
}

for (const [w, h] of [[390, 844], [412, 730]]) {
  for (const textSize of [null, "xlarge"]) {
    test(`live @${w}x${h}${textSize ? " xlarge text" : ""}: no editor view pans sideways`, async (t) => {
      if (!chrome) return t.skip("no headless Chrome");
      for (const v of VIEWS) {
        const m = await measure(v, w, h, { textSize });
        assert.equal(m.body, 0, `${v}: the panel pans inside .content-body ${JSON.stringify(m)}`);
        assert.equal(m.doc, 0, `${v}: the page is wider than the screen ${JSON.stringify(m)}`);
      }
    });
  }
}

test("live @390x844: the check reaches the mechanism — a tab row that may not wrap pans the panel", async (t) => {
  if (!chrome) return t.skip("no headless Chrome");
  const m = await measure("abilities", 390, 844, { textSize: "xlarge", css: ".btb-tabs,.btb-seg{flex-wrap:nowrap!important}.btb-tab,.btb-seg-opt{white-space:nowrap}" });
  assert.ok(m.body > 0 || m.doc > 0, "knocking out the wrap must overflow, or this file proves nothing: " + JSON.stringify(m));
});
