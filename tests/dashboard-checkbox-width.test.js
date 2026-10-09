/**
 * Checkboxes and radios keep their natural size (2026-10).
 *
 * The shared form reset in layout.js gives input, textarea and select
 * width:100%. A checkbox in a flex row with that width takes the whole row:
 * the Bot Builder's tool chooser (a checkbox, the tool name and a tag) showed
 * each tool name one character per line on a phone. The reset now leaves
 * checkboxes and radios at their natural width.
 *
 * Source half: the rule is present. Live half (private headless Chrome; skips
 * without one, fails in CI where CROW_REQUIRE_TEST_CHROME=1): the real
 * renderLayout() page plus the Bot Builder styles, measured at phone widths.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import { startHeadlessChrome } from "./fixtures/headless-chrome.mjs";

const ROOT = new URL("..", import.meta.url).pathname;

test("the shared form reset leaves checkboxes and radios at their natural width", () => {
  const src = readFileSync(ROOT + "servers/gateway/dashboard/shared/layout.js", "utf8");
  assert.match(src, /input\[type="checkbox"\],\s*input\[type="radio"\]\s*\{\s*width:\s*auto;/);
});

// The Bot Builder's tool row exactly as tab-abilities.js renders it.
const ROW = (name) => `<label class="btb-tool" data-access="read"><input type="checkbox" checked>` +
  `<span class="btb-tool-name">${name}</span><span class="btb-tag btb-tag-read">reads</span></label>`;
const FIXTURE = `<div class="btb-tool-list" id="list">${ROW("Status")}${ROW("List libraries")}</div>
  <label id="radio-row" style="display:flex;gap:.5rem;align-items:center"><input type="radio" name="r"><span>Pick this one</span></label>`;

let chrome = null, server = null, port = 0;
before(async () => {
  chrome = await startHeadlessChrome();
  if (!chrome) return;
  const { renderLayout } = await import("../servers/gateway/dashboard/shared/layout.js");
  const { botBuilderStyles } = await import("../servers/gateway/dashboard/panels/bot-builder/css.js");
  const html = renderLayout({ title: "Boxes", content: botBuilderStyles() + FIXTURE, activePanel: "x", panels: [], lang: "en" });
  server = http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(html); });
  await new Promise((r) => server.listen(0, chrome.bindHost, r));
  port = server.address().port;
});
after(async () => { if (server) server.close(); if (chrome) await chrome.close(); });

async function measure(w, h, css = "") {
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
    await send("Page.navigate", { url: `http://${chrome.pageHost}:${port}/` });
    let ok = false;
    for (let i = 0; i < 75 && !ok; i++) { await new Promise((r) => setTimeout(r, 200)); try { ok = await evalIn("!!document.getElementById('radio-row')"); } catch {} }
    assert.ok(ok, "the fixture page never loaded");
    if (css) await evalIn(`(function(){var s=document.createElement('style');s.textContent=${JSON.stringify(css)};document.head.appendChild(s);return 1;})()`);
    await evalIn("new Promise(function(r){requestAnimationFrame(function(){requestAnimationFrame(function(){r(1);});});})");
    return JSON.parse(await evalIn(`(function(){
      var box=document.querySelector('#list input').getBoundingClientRect();
      var name=document.querySelectorAll('#list .btb-tool-name')[1];
      var lh=parseFloat(getComputedStyle(name).lineHeight)||16;
      var radio=document.querySelector('#radio-row input').getBoundingClientRect();
      return JSON.stringify({ box: Math.round(box.width), nameLines: Math.round(name.getBoundingClientRect().height/lh), radio: Math.round(radio.width) });
    })()`));
  } finally { ws.close(); await fetch(chrome.cdp + "/json/close/" + tab.id).catch(() => {}); }
}

for (const [w, h] of [[390, 844], [412, 730]]) {
  test(`live @${w}x${h}: a tool row keeps a small checkbox and the tool name on one line`, async (t) => {
    if (!chrome) return t.skip("no headless Chrome");
    const m = await measure(w, h);
    assert.ok(m.box <= 32, "the checkbox stays checkbox-sized: " + JSON.stringify(m));
    assert.equal(m.nameLines, 1, "\"List libraries\" fits on one line: " + JSON.stringify(m));
    assert.ok(m.radio <= 32, "a radio stays radio-sized: " + JSON.stringify(m));
  });
}

test("live @390x844: the test reaches the mechanism — with the old full-width reset the name is crushed again", async (t) => {
  if (!chrome) return t.skip("no headless Chrome");
  const m = await measure(390, 844, 'input[type="checkbox"],input[type="radio"]{width:100% !important}');
  assert.ok(m.box > 100 && m.nameLines > 1, "a full-width checkbox must crush the name: " + JSON.stringify(m));
});
