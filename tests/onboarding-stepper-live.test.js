/**
 * Compact stepper + disabled buttons, measured in a real browser (design
 * study quick win 4).
 *
 * On a phone the onboarding stepper's eight chips wrapped to three or four
 * rows and pushed the Welcome step's content most of a screen down. At the
 * dashboard's phone breakpoint (max-width:768px, inclusive) the stepper now
 * shows one compact line ("Step 1 of 8 · Welcome" + a thin bar) and keeps the
 * full list sr-only (clipped, never display:none, so screen readers keep
 * every step). Disabled .btn buttons render grey, including on hover, where
 * the legacy .btn-primary:hover / .btn-danger:hover rules used to recolour
 * them.
 *
 * Private headless Chrome; skips without one, fails in CI where
 * CROW_REQUIRE_TEST_CHROME=1. Each mechanism check deletes the rule under
 * test from the live stylesheet and asserts the measurement flips.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startHeadlessChrome } from "./fixtures/headless-chrome.mjs";

const BUTTONS = `<div id="btn-fixture" style="display:flex;gap:1rem;padding:1rem">
  <button type="button" class="btn btn-primary btn-md" id="b-primary" disabled>Save</button>
  <button type="button" class="btn btn-danger btn-md" id="b-danger" disabled>Delete</button>
  <button type="button" class="btn btn-primary btn-md" id="b-live">Live</button>
</div>`;

let chrome = null, server = null, port = 0;
before(async () => {
  chrome = await startHeadlessChrome();
  if (!chrome) return;
  const { renderLayout } = await import("../servers/gateway/dashboard/shared/layout.js");
  const { default: onboarding } = await import("../servers/gateway/dashboard/panels/onboarding.js");
  const page = async (lang, extra = "") => {
    let html = "";
    const layout = (o) => renderLayout({ ...o, content: o.content + extra, activePanel: "onboarding", panels: [], lang });
    const res = { send(h) { html = h; }, setHeader() {} };
    const out = await onboarding.handler({ method: "GET", query: { step: "0" }, headers: { cookie: `crow_lang=${lang}` } }, res, { layout, lang });
    return typeof out === "string" ? out : html;
  };
  const pages = { "/en": await page("en"), "/es": await page("es"), "/buttons": await page("en", BUTTONS) };
  server = http.createServer((req, res) => {
    const body = pages[req.url] || "not found";
    res.writeHead(pages[req.url] ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, chrome.bindHost, r));
  port = server.address().port;
});
after(async () => { if (server) server.close(); if (chrome) await chrome.close(); });

// Deletes every top-level rule whose text contains the needle: a whole
// @media block when the needle is inside it, or a plain style rule.
const DELETE_RULES = (needle) => `(function(){var n=0;for(var s of document.styleSheets){var l;try{l=s.cssRules;}catch(e){continue;}` +
  `for(var i=l.length-1;i>=0;i--){if(l[i].cssText.indexOf(${JSON.stringify(needle)})!==-1){s.deleteRule(i);n++;}}}return n;})()`;

async function withTab(w, h, path, fn) {
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
  const settle = () => evalIn("new Promise(function(r){requestAnimationFrame(function(){requestAnimationFrame(function(){r(1);});});})");
  try {
    await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 2, mobile: w <= 768 });
    await send("Page.navigate", { url: `http://${chrome.pageHost}:${port}${path}` });
    let ok = false;
    for (let i = 0; i < 75 && !ok; i++) { await new Promise((r) => setTimeout(r, 200)); try { ok = await evalIn("!!document.querySelector('.stepper-wrap')"); } catch {} }
    assert.ok(ok, "the onboarding page never loaded");
    await settle();
    return await fn({ send, evalIn, settle });
  } finally { ws.close(); await fetch(chrome.cdp + "/json/close/" + tab.id).catch(() => {}); }
}

const MEASURE = `(function(){
  var wrap=document.querySelector('.stepper-wrap'), ol=wrap.querySelector('ol.stepper'), cp=wrap.querySelector('.stepper-compact');
  var text=cp.querySelector('.stepper-compact-text');
  var olR=ol.getBoundingClientRect(), cpR=cp.getBoundingClientRect();
  var lh=parseFloat(getComputedStyle(text).lineHeight)||parseFloat(getComputedStyle(text).fontSize)*1.3;
  var tops={}; ol.querySelectorAll('li').forEach(function(li){tops[Math.round(li.getBoundingClientRect().top)]=1;});
  var mark=document.querySelector('.crow-mark');
  return JSON.stringify({
    olDisplay:getComputedStyle(ol).display, olW:Math.round(olR.width), olH:Math.round(olR.height), olRows:Object.keys(tops).length,
    olSteps:ol.querySelectorAll('li').length, olCurrent:ol.querySelectorAll('[aria-current="step"]').length,
    cpDisplay:getComputedStyle(cp).display, cpH:Math.round(cpR.height), textLines:Math.round(text.getBoundingClientRect().height/lh),
    text:text.textContent, markTop:mark?Math.round(mark.getBoundingClientRect().top+window.scrollY):-1,
    sideways:document.documentElement.scrollWidth>window.innerWidth+1
  });
})()`;

for (const lang of ["en", "es"]) {
  test(`live @412x915 (${lang}): one compact line, the list clipped for screen readers, Welcome content high`, async (t) => {
    if (!chrome) return t.skip("no headless Chrome");
    const m = JSON.parse(await withTab(412, 915, "/" + lang, ({ evalIn }) => evalIn(MEASURE)));
    assert.equal(m.cpDisplay, "block", "compact line shown: " + JSON.stringify(m));
    assert.ok(m.cpH > 0 && m.textLines <= 2, "compact line is at most two lines: " + JSON.stringify(m));
    assert.ok(m.text.startsWith(lang === "en" ? "Step 1 of 8 · " : "Paso 1 de 8 · "), m.text);
    assert.notEqual(m.olDisplay, "none", "the list is sr-only, never display:none");
    assert.ok(m.olW <= 1 && m.olH <= 1, "the list is clipped: " + JSON.stringify(m));
    assert.equal(m.olSteps, 8, "every step stays in the DOM");
    assert.equal(m.olCurrent, 1, "exactly one aria-current step");
    assert.ok(m.markTop >= 0 && m.markTop < 300, "Welcome content starts above 300px: " + JSON.stringify(m));
    assert.equal(m.sideways, false, "no sideways scroll");
  });
}

test("live @768x1024: the breakpoint is inclusive — still compact at exactly 768", async (t) => {
  if (!chrome) return t.skip("no headless Chrome");
  const m = JSON.parse(await withTab(768, 1024, "/en", ({ evalIn }) => evalIn(MEASURE)));
  assert.equal(m.cpDisplay, "block", JSON.stringify(m));
  assert.ok(m.olW <= 1 && m.olH <= 1, JSON.stringify(m));
});

test("live @1280x900: the full list in at most two rows, compact line hidden", async (t) => {
  if (!chrome) return t.skip("no headless Chrome");
  const m = JSON.parse(await withTab(1280, 900, "/en", ({ evalIn }) => evalIn(MEASURE)));
  assert.equal(m.cpDisplay, "none", JSON.stringify(m));
  assert.ok(m.olW > 300 && m.olRows <= 2, "the step list is visible: " + JSON.stringify(m));
  assert.equal(m.sideways, false);
});

test("live @412x915: the test reaches the mechanism — without the phone rule the list is back and the content drops", async (t) => {
  if (!chrome) return t.skip("no headless Chrome");
  const m = JSON.parse(await withTab(412, 915, "/en", async ({ evalIn, settle }) => {
    const n = await evalIn(DELETE_RULES(".stepper-wrap .stepper-compact"));
    assert.ok(n >= 1, "found the phone media rule to delete");
    await settle();
    return evalIn(MEASURE);
  }));
  assert.equal(m.cpDisplay, "none", JSON.stringify(m));
  assert.ok(m.olH > 1 && m.olRows >= 3, "the chip list wraps to three or more rows again: " + JSON.stringify(m));
  assert.ok(m.markTop >= 300, "and the Welcome content drops below 300px: " + JSON.stringify(m));
});

const HOVER = (sel) => `(function(){var r=document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();return JSON.stringify({x:r.left+r.width/2,y:r.top+r.height/2});})()`;
const STYLE = `(function(){var g=function(id){var cs=getComputedStyle(document.getElementById(id));return {bg:cs.backgroundColor,color:cs.color,cursor:cs.cursor,hover:document.getElementById(id).matches(':hover')};};
  var probe=document.createElement('div');probe.style.background='var(--crow-bg-elevated)';document.body.appendChild(probe);var elevated=getComputedStyle(probe).backgroundColor;probe.remove();
  return JSON.stringify({primary:g('b-primary'),danger:g('b-danger'),live:g('b-live'),elevated:elevated});})()`;

async function hoverMeasure(w, h, removeRule) {
  return JSON.parse(await withTab(w, h, "/buttons", async ({ send, evalIn, settle }) => {
    if (removeRule) assert.ok(await evalIn(DELETE_RULES(".btn.btn:disabled")) >= 1, "found the disabled rule to delete");
    const out = {};
    for (const id of ["b-primary", "b-danger"]) {
      const p = JSON.parse(await evalIn(HOVER("#" + id)));
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y });
      await settle();
      out[id] = JSON.parse(await evalIn(STYLE));
    }
    return JSON.stringify(out);
  }));
}

for (const [w, h] of [[412, 915], [1280, 900]]) {
  test(`live @${w}x${h}: disabled primary and danger buttons stay grey on hover`, async (t) => {
    if (!chrome) return t.skip("no headless Chrome");
    const m = await hoverMeasure(w, h, false);
    const p = m["b-primary"], d = m["b-danger"];
    assert.ok(p.primary.hover && d.danger.hover, "the pointer is over each button: " + JSON.stringify(m));
    assert.equal(p.primary.bg, p.elevated, "disabled primary (hovered) uses the elevated grey: " + JSON.stringify(p));
    assert.equal(d.danger.bg, d.elevated, "disabled danger (hovered) uses the elevated grey: " + JSON.stringify(d));
    assert.equal(p.primary.cursor, "not-allowed");
    assert.notEqual(p.live.bg, p.elevated, "an enabled primary keeps its accent");
  });
}

test("live @1280x900: the test reaches the mechanism — without the disabled rule a hovered disabled button is coloured", async (t) => {
  if (!chrome) return t.skip("no headless Chrome");
  const m = await hoverMeasure(1280, 900, true);
  assert.notEqual(m["b-primary"].primary.bg, m["b-primary"].elevated, JSON.stringify(m["b-primary"]));
  assert.notEqual(m["b-danger"].danger.bg, m["b-danger"].elevated, JSON.stringify(m["b-danger"]));
});
