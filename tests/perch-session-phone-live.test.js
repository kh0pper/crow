// A Perch session on a phone in the new shell, LIVE (phone review 2026-10-29):
// the real Perch page in the real new shell, in a private headless Chrome,
// against a scripted perch-api with a session filed to a project. At
// 390x844, en and es, dark and light:
//   - the shell's Chat · Board · Make bar stays on screen, and the composer
//     sits above it (never under it);
//   - the composer is ONE row ("+", a one-line field, Send share a top) at
//     the default "Message" placeholder;
//   - the head's bot name and project line are not clipped, the line is the
//     project name, and every head and composer target is at least 44 px
//     with at least 8 px between the head's three targets;
//   - the transcript is the only scroller and nothing scrolls sideways;
//   - the header chip names the session's project.
// Plus: a simulated on-screen keyboard (a stand-in visualViewport) hides the
// bar while it is open, and the bar comes back when it closes.
// Set SESSION_PHONE_SHOTS_DIR (+ SESSION_PHONE_SHOTS_TAG) to save screenshots.
// Skips cleanly without Chrome.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startHeadlessChrome } from "./fixtures/headless-chrome.mjs";

process.env.PIBOT_PI_CLI = "/nonexistent/pi-never-spawned-by-this-file.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const SID = "perchlive-22222222";
const PROJECT = { id: 1, slug: "backyard-garden", name: "Backyard garden plan board" };
const BOT = "Garden assistant";
const SHOTS = process.env.SESSION_PHONE_SHOTS_DIR || "";
const SHOT_TAG = process.env.SESSION_PHONE_SHOTS_TAG || "after";

let CDP = "(no headless Chrome)", BIND_HOST = "127.0.0.1", HOST = "127.0.0.1";
let chrome = null, available = false, server = null, port = 0;
const streams = new Set();
function send(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}
function serveApi(req, res) {
  const url = req.url.split("?")[0];
  if (url.endsWith("/roost")) {
    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    return send(res, 200, {
      birds: [{ id: "garden-assistant", name: BOT, perch_attached: true, state: "working",
        sessions: [{ sessionId: SID, state: "awake", cardId: null, pendingUi: false, control: "run",
          projectId: PROJECT.id, lastActivityAt: now }] }],
      occupiedCardIds: [],
    });
  }
  if (url.endsWith("/events")) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write(": open\n\n");
    streams.add(res);
    req.on("close", () => streams.delete(res));
    return;
  }
  if (url.endsWith("/transcript")) {
    return send(res, 200, { events: Array.from({ length: 30 }, (_, i) => ({
      type: "message", message: { role: i % 2 ? "assistant" : "user",
        content: [{ type: "text", text: i % 2 ? "Here is a reply long enough to wrap over a couple of lines on a phone, number " + i : "Question " + i }] } })) });
  }
  if (url.endsWith("/options")) return send(res, 200, { models: [], thinkingLevels: [] });
  if (url.endsWith("/commands")) return send(res, 200, { commands: [] });
  if (url.endsWith("/models")) return send(res, 200, { models: [], default: null });
  return send(res, 200, {});
}

before(async () => {
  chrome = await startHeadlessChrome();
  available = !!chrome;
  if (!available) return;
  CDP = chrome.cdp; HOST = chrome.pageHost; BIND_HOST = chrome.bindHost;
  const { default: perchHubPanel } = await import("../servers/gateway/dashboard/panels/perch-hub.js");
  const { renderLayout } = await import("../servers/gateway/dashboard/shared/layout.js");
  const { tamagotchiHtml, tamagotchiTrayHtml } = await import("../servers/gateway/dashboard/shared/notifications.js");
  const turbo = readFileSync(join(REPO, "servers/gateway/public/vendor/turbo-8.0.5.umd.js"));
  server = http.createServer(async (req, res) => {
    if (req.url.startsWith("/dashboard/perch-api/")) return serveApi(req, res);
    if (req.url.startsWith("/api/")) return send(res, 200, { items: [] });
    if (req.url.startsWith("/vendor/turbo")) {
      res.writeHead(200, { "content-type": "application/javascript" });
      return res.end(turbo);
    }
    if (!req.url.startsWith("/dashboard/perch")) {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end("<!doctype html><title>blank</title><p>blank</p>");
    }
    const lang = /[?&]lang=es\b/.test(req.url) ? "es" : "en";
    req.crowMode = { mode: "new" };
    // A link into a filed session carries ?project=<slug>, and the server
    // renders that project's scope (shell/request.js resolveScope).
    const scope = new RegExp("[?&]project=" + PROJECT.slug + "\\b").test(req.url) ? { projectId: PROJECT.id, slug: PROJECT.slug } : { all: true };
    req.crowScope = scope;
    // The real header: the mascot, with its tray in the one sheet (no avatar).
    const layout = (opts) => renderLayout({ ...opts, activePanel: "perch", panels: [perchHubPanel], lang,
      headerIcons: tamagotchiHtml(lang, { sheet: true }),
      variant: "shell", shell: { scope, projects: [PROJECT], tab: "chat", getPanel: () => null, tray: tamagotchiTrayHtml(lang) } });
    const db = { execute: async () => ({ rows: [PROJECT] }) };
    const html = await perchHubPanel.handler(req, res, { lang, layout, db });
    if (!res.headersSent) { res.writeHead(200, { "content-type": "text/html" }); res.end(html); }
  });
  await new Promise((r) => server.listen(0, BIND_HOST, r));
  port = server.address().port;
});

after(async () => {
  for (const res of streams) res.end();
  if (server) server.close();
  if (chrome) await chrome.close();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A stand-in visualViewport (window.visualViewport is [Replaceable]): the
 *  test moves its height to open and close a "keyboard". */
const FAKE_VV = `(function(){
  var vv=new EventTarget(); vv.height=window.innerHeight; vv.width=window.innerWidth; vv.offsetTop=0; vv.offsetLeft=0; vv.scale=1;
  window.__fakeVV=vv; window.visualViewport=vv;
})();`;

async function tab({ lang = "en", dark = false, fakeVV = false } = {}) {
  const t = await (await fetch(CDP + "/json/new?about:blank", { method: "PUT" })).json();
  const { default: WebSocket } = await import("ws");
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
  let id = 0;
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const mine = ++id;
    const onMsg = (raw) => {
      const m = JSON.parse(raw);
      if (m.id !== mine) return;
      ws.off("message", onMsg);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result || {});
    };
    ws.on("message", onMsg);
    ws.send(JSON.stringify({ id: mine, method, params }));
  });
  const evalIn = async (expression) => {
    const out = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (out.exceptionDetails) throw new Error("page threw: " + JSON.stringify(out.exceptionDetails));
    return out.result.value;
  };
  const waitFor = async (expression, what, ms = 8000) => {
    const end = Date.now() + ms;
    for (;;) {
      let v = null;
      try { v = await evalIn(expression); } catch { /* mid-navigation */ }
      if (v) return v;
      if (Date.now() > end) throw new Error("timed out waiting for " + what);
      await sleep(100);
    }
  };
  await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
  await cdp("Page.enable");
  if (fakeVV) await cdp("Page.addScriptToEvaluateOnNewDocument", { source: FAKE_VV });
  const q = [lang === "es" ? "lang=es" : "", "project=" + PROJECT.slug].filter(Boolean).join("&");
  await cdp("Page.navigate", { url: `http://${HOST}:${port}/dashboard/perch?${q}#${SID}` });
  await waitFor("document.body.getAttribute('data-view')==='chat'&&!!document.getElementById('perch-bot-name').textContent" +
    "&&!!document.getElementById('perch-ident-sub').textContent&&document.querySelectorAll('#perch-transcript .msg, #perch-transcript > *').length>4",
  "the chat, its head and its transcript");
  await evalIn("new Promise(function(r){ requestAnimationFrame(function(){ requestAnimationFrame(r); }); })");
  return {
    evalIn, waitFor,
    json: async (expression) => JSON.parse(await evalIn(expression)),
    shot: async (file) => {
      const { data } = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      writeFileSync(file, Buffer.from(data, "base64"));
    },
    close: async () => { ws.close(); await fetch(CDP + "/json/close/" + t.id).catch(() => {}); },
  };
}

const GEOMETRY = `(function(){
  function box(e){ if(!e) return null; var b=e.getBoundingClientRect(); return {l:b.left,r:b.right,t:b.top,b:b.bottom,w:b.width,h:b.height}; }
  function shown(e){ return !!e&&getComputedStyle(e).display!=='none'&&e.getClientRects().length>0; }
  var bar=document.querySelector('.shell-tabs'), name=document.getElementById('perch-bot-name'),
      sub=document.getElementById('perch-ident-sub'), input=document.getElementById('perch-input'),
      chip=document.querySelector('.shell-scope-name'), tr=document.getElementById('perch-transcript');
  var scrollers=[].slice.call(document.querySelectorAll('body *')).filter(function(e){
    var cs=getComputedStyle(e); return /(auto|scroll)/.test(cs.overflowY)&&e.scrollHeight>e.clientHeight+1&&e.clientHeight>0; })
    .map(function(e){ return e.id||e.className||e.tagName; });
  return JSON.stringify({ vw:innerWidth, vh:innerHeight, sw:document.documentElement.scrollWidth,
    docScrolls:document.scrollingElement.scrollHeight>innerHeight+1,
    barShown:shown(bar), bar:box(bar),
    composer:box(document.getElementById('perch-composer')),
    plus:box(document.getElementById('perch-plus')), plusShown:shown(document.getElementById('perch-plus')),
    input:box(input), send:box(document.getElementById('perch-send')),
    placeholder:input.getAttribute('placeholder'),
    back:box(document.getElementById('perch-back')), ident:box(document.getElementById('perch-ident-btn')),
    apps:box(document.getElementById('perch-apps-btn')), appsShown:shown(document.getElementById('perch-apps-btn')),
    name:name.textContent, nameClipped:name.scrollWidth>name.clientWidth,
    sub:sub.textContent, subClipped:sub.scrollWidth>sub.clientWidth,
    chip:chip?chip.textContent:null, chipClipped:chip?chip.scrollWidth>chip.clientWidth+0.5:null,
    chipEllipsis:chip?getComputedStyle(chip).textOverflow==='ellipsis':null,
    chevronInside:(function(){ var b=document.querySelector('.shell-scope'); var v=b&&b.querySelector('svg'); if(!b||!v) return null;
      var bb=b.getBoundingClientRect(), vb=v.getBoundingClientRect();
      return vb.width>0 && vb.left>=bb.left-0.5 && vb.right<=bb.right+0.5 && bb.left>=0 && bb.right<=innerWidth+0.5; })(),
    avatars:document.querySelectorAll('.shell-avatar').length, bird:box(document.getElementById('crow-bird-btn')),
    fieldFont:parseFloat(getComputedStyle(input).fontSize), kb:document.body.hasAttribute('data-perch-kb'), scrollers:scrollers, transcriptScrolls:tr.scrollHeight>tr.clientHeight });
})()`;

function assertLayout(m, lang, label) {
  const at = (s) => `${s} (${label}) ${JSON.stringify(m)}`;
  // The shell's bar is on screen, and the composer ends above it.
  assert.equal(m.barShown, true, at("the Chat · Board · Make bar is visible"));
  assert.ok(m.bar.b <= m.vh + 0.5 && m.bar.t < m.vh, at("the bar is inside the viewport"));
  assert.ok(m.composer.b <= m.bar.t + 0.5, at("the composer ends above the bar"));
  assert.ok(m.send.b <= m.bar.t + 0.5, at("Send is not under the bar"));
  // One row: the three controls share a top, the field is one line tall.
  assert.equal(m.placeholder, lang === "es" ? "Mensaje" : "Message");
  assert.equal(m.plusShown, true, at("+ is shown"));
  assert.ok(Math.abs(m.plus.t - m.send.t) <= 2 && Math.abs(m.plus.t - m.input.t) <= 2, at("+, the field and Send share one row"));
  assert.ok(m.input.h <= 50, at("the field is one line tall"));
  for (const k of ["plus", "send"]) assert.ok(m[k].w >= 44 && m[k].h >= 44, at(k + " is a 44 px target"));
  assert.ok(m.send.w <= 96, at("Send is compact"));
  // The head: the bot name, then the project name, neither clipped.
  assert.equal(m.name, BOT);
  assert.equal(m.nameClipped, false, at("the bot name is not clipped"));
  assert.ok(m.sub === PROJECT.name || m.sub.indexOf(PROJECT.name + " · ") === 0, at("the context line is the project name"));
  assert.equal(m.subClipped, false, at("the project line is not clipped"));
  assert.equal(m.appsShown, true);
  for (const k of ["back", "ident", "apps"]) assert.ok(m[k].w >= 44 && m[k].h >= 44, at(k + " is a 44 px target"));
  assert.ok(m.ident.l - m.back.r >= 8, at("8 px between Back and the name"));
  assert.ok(m.apps.l - m.ident.r >= 8, at("8 px between the name and the apps button"));
  // The real header: the server-rendered chip names the session's project
  // (the link carried ?project=), unclipped; the mascot is the only button.
  assert.equal(m.chip, PROJECT.name, at("the header chip names the session's project"));
  // The chip itself and its chevron are never cut off. A long project name
  // may shorten with an ellipsis (fonts differ by machine: CI's fallback
  // font is wider), never by being cropped mid-letter.
  assert.equal(m.chevronInside, true, at("the chip and its chevron are fully on screen"));
  if (m.chipClipped) assert.equal(m.chipEllipsis, true, at("a long chip name shortens with an ellipsis"));
  assert.equal(m.avatars, 0, at("no separate avatar button"));
  assert.ok(m.bird && m.bird.w >= 44 && m.bird.h >= 44, at("the mascot is a 44 px target"));
  assert.ok(m.fieldFont >= 16, at("the field's text is at least 16px (no iOS focus zoom)"));
  // Nothing pans: no sideways scroll, the document does not scroll, the
  // transcript is the only scroller.
  assert.ok(m.sw <= m.vw, at("no horizontal scroll"));
  assert.equal(m.docScrolls, false, at("the page itself does not scroll"));
  assert.deepEqual(m.scrollers, ["perch-transcript"], at("the transcript is the only scroller"));
}

for (const lang of ["en", "es"]) {
  for (const dark of [true, false]) {
    test(`390x844 ${lang} ${dark ? "dark" : "light"}: the bar stays, the composer is one row above it, the head fits`, async (t) => {
      if (!available) return t.skip("no headless Chrome");
      const s = await tab({ lang, dark });
      try {
        if (SHOTS && dark) {
          mkdirSync(SHOTS, { recursive: true });
          await s.shot(join(SHOTS, `session-phone-${SHOT_TAG}-${lang}.png`));
        }
        // Measure after web fonts and two frames, as settings-llm-phone-layout does.
        await s.evalIn("document.fonts.ready.then(function(){ return new Promise(function(r){ requestAnimationFrame(function(){ requestAnimationFrame(function(){ r(1); }); }); }); })");
        assertLayout(await s.json(GEOMETRY), lang, `${lang} ${dark ? "dark" : "light"}`);
      } finally { await s.close(); }
    });
  }
}

test("390x844: typing grows the field, and Send and + stay on the row's bottom edge", async (t) => {
  if (!available) return t.skip("no headless Chrome");
  const s = await tab();
  try {
    await s.evalIn("(function(){ var i=document.getElementById('perch-input'); i.focus(); i.value='one\\ntwo\\nthree'; i.dispatchEvent(new Event('input',{bubbles:true})); return 1; })()");
    await s.evalIn("new Promise(function(r){ requestAnimationFrame(function(){ requestAnimationFrame(r); }); })");
    const m = await s.json(GEOMETRY);
    assert.ok(m.input.h > 60, `the field grew (${m.input.h})`);
    assert.ok(Math.abs(m.plus.b - m.send.b) <= 2, "+ and Send share the bottom edge: " + JSON.stringify(m));
    assert.ok(m.plus.t > m.input.t + 10, "+ stays on the bottom line, not pushed to its own row");
    assert.ok(m.composer.b <= m.bar.t + 0.5, "still above the bar");
  } finally { await s.close(); }
});

test("390x844: an open on-screen keyboard hides the bar and lifts the composer; closing it brings the bar back", async (t) => {
  if (!available) return t.skip("no headless Chrome");
  const s = await tab({ fakeVV: true });
  try {
    assert.equal(await s.evalIn("window.visualViewport===window.__fakeVV"), true, "the stand-in viewport is in place");
    const KB = 300;
    // Covered but no text field focused (say, a pinch-zoom report): the bar stays.
    await s.evalIn(`(function(){ var v=window.__fakeVV; v.height=innerHeight-${KB}; v.dispatchEvent(new Event('resize')); return 1; })()`);
    await s.evalIn("new Promise(function(r){ setTimeout(r,50); })");
    assert.equal(await s.evalIn("document.body.hasAttribute('data-perch-kb')"), false, "no keyboard without a focused text field");
    // A pinch zoom (height shrinks by the scale) is not a keyboard either.
    await s.evalIn(`(function(){ var v=window.__fakeVV; document.getElementById('perch-input').focus(); v.scale=2; v.height=innerHeight/2; v.dispatchEvent(new Event('resize')); return 1; })()`);
    await s.evalIn("new Promise(function(r){ setTimeout(r,50); })");
    assert.equal(await s.evalIn("document.body.hasAttribute('data-perch-kb')"), false, "a zoom is not a keyboard");
    await s.evalIn(`(function(){ var v=window.__fakeVV; v.scale=1; v.height=innerHeight-${KB}; v.dispatchEvent(new Event('resize')); return 1; })()`);
    await s.waitFor("getComputedStyle(document.querySelector('.shell-tabs')).display==='none'", "the bar to hide for the keyboard");
    await s.evalIn("new Promise(function(r){ requestAnimationFrame(function(){ requestAnimationFrame(r); }); })");
    const open = await s.json(GEOMETRY);
    assert.ok(open.send.b <= open.vh - KB + 0.5, `Send sits above the keyboard (${open.send.b} ≤ ${open.vh - KB})`);
    await s.evalIn("(function(){ var v=window.__fakeVV; v.height=innerHeight; v.dispatchEvent(new Event('resize')); return 1; })()");
    await s.waitFor("getComputedStyle(document.querySelector('.shell-tabs')).display!=='none'", "the bar to come back");
    await s.evalIn("new Promise(function(r){ requestAnimationFrame(function(){ requestAnimationFrame(r); }); })");
    assertLayout(await s.json(GEOMETRY), "en", "after the keyboard closed");
  } finally { await s.close(); }
});

test("390x844: a blur brings the bar back even while the viewport still reports the keyboard", async (t) => {
  if (!available) return t.skip("no headless Chrome");
  const s = await tab({ fakeVV: true });
  try {
    await s.evalIn("(function(){ document.getElementById('perch-input').focus(); var v=window.__fakeVV; v.height=innerHeight-300; v.dispatchEvent(new Event('resize')); return 1; })()");
    await s.waitFor("document.body.hasAttribute('data-perch-kb')", "the keyboard flag");
    await s.evalIn("document.getElementById('perch-input').blur(); 1");
    await s.waitFor("!document.body.hasAttribute('data-perch-kb')&&getComputedStyle(document.querySelector('.shell-tabs')).display!=='none'", "the bar back after the blur");
  } finally { await s.close(); }
});
