// Perch Sessions collapse, LIVE: the real page through the real dashboard
// shell, in a private headless Chrome (tests/fixtures/headless-chrome.mjs),
// against a scripted perch-api. The static and unit halves are in
// tests/perch-sessions-collapse.test.js; only this file proves the column
// really leaves the screen, the chat really takes the width, focus really
// lands on the live control, and the phone really is unchanged.
//
// Every wait is a poll on a page condition, never a fixed sleep before an
// assertion. Set PERCH_COLLAPSE_SHOTS=<dir> to also save screenshots.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startHeadlessChrome } from "./fixtures/headless-chrome.mjs";

// The engine is "ready" (no banner), as in perch-hub-render.test.js: the
// resolver's env rung, so nothing depends on whether pi is installed here.
process.env.PIBOT_PI_CLI = "/nonexistent/pi-never-spawned-by-this-file.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const SID = "perchlive-11111111";
const SIDS = [SID, "perchlive-22222222"];
const KEY = "crow-perch-sessions-collapsed";
const SHOTS = process.env.PERCH_COLLAPSE_SHOTS || "";

let CDP = "(no headless Chrome)", BIND_HOST = "127.0.0.1", HOST = "127.0.0.1";
let chrome = null, available = false, server = null, port = 0;

/** How many times the page asked for /roost: the list poll's request. */
let roostHits = 0;

function send(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

function serveApi(req, res) {
  const url = req.url.split("?")[0];
  if (url.endsWith("/roost")) {
    roostHits++;
    return send(res, 200, {
      birds: [{ id: "r4-assistant", name: "R4 Assistant", perch_attached: true, state: "working",
        sessions: SIDS.map((sid) => ({ sessionId: sid, state: "awake", cardId: null, pendingUi: false, control: "run" })) }],
      occupiedCardIds: [],
    });
  }
  if (url.endsWith("/events")) {
    // Held open and silent: an erroring EventSource would bounce the page
    // back to the list on its own.
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write(": open\n\n");
    return;
  }
  if (url.endsWith("/transcript")) {
    return send(res, 200, { events: Array.from({ length: 40 }, (_, i) => ({
      type: "message", message: { role: i % 2 ? "assistant" : "user",
        content: [{ text: "a transcript line long enough to wrap at desktop width, number " + i }] } })) });
  }
  if (url.endsWith("/options")) return send(res, 200, { models: [], thinkingLevels: [] });
  if (url.endsWith("/models")) return send(res, 200, { models: [], default: null });
  return send(res, 200, {});
}

/** The artifacts bundle, just enough for one card whose "Open beside" opens
 *  the real split pane (artifact-card.js). */
function serveArtifacts(req, res) {
  const url = req.url.split("?")[0];
  if (url.startsWith("/api/artifacts/by-thread/")) return send(res, 200, { items: [{ artifactId: "art-1" }] });
  if (url === "/api/artifacts/art-1") {
    return send(res, 200, { artifact: { id: "art-1", title: "Launch plan", type: "html", current_version: 1 },
      versions: [{ n: 1, state: "live" }], threads: [] });
  }
  return send(res, 200, { items: [] });
}

before(async () => {
  chrome = await startHeadlessChrome();
  available = !!chrome;
  if (!available) return;
  CDP = chrome.cdp; HOST = chrome.pageHost; BIND_HOST = chrome.bindHost;
  const { default: perchHubPanel } = await import("../servers/gateway/dashboard/panels/perch-hub.js");
  const { renderLayout } = await import("../servers/gateway/dashboard/shared/layout.js");
  const turbo = readFileSync(join(REPO, "servers/gateway/public/vendor/turbo-8.0.5.umd.js"));
  server = http.createServer(async (req, res) => {
    if (req.url.startsWith("/dashboard/perch-api/")) return serveApi(req, res);
    if (req.url.startsWith("/api/artifacts/")) return serveArtifacts(req, res);
    if (req.url.startsWith("/vendor/turbo")) {
      res.writeHead(200, { "content-type": "application/javascript" });
      return res.end(turbo);
    }
    // The pane's iframe and the storage-priming page: a plain document.
    if (!req.url.startsWith("/dashboard/perch")) {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end("<!doctype html><title>blank</title><p>blank</p>");
    }
    const layout = (opts) => renderLayout({ ...opts, activePanel: "perch", panels: [perchHubPanel], lang: "en" });
    const html = await perchHubPanel.handler(req, res, { lang: "en", layout });
    if (!res.headersSent) { res.writeHead(200, { "content-type": "text/html" }); res.end(html); }
  });
  await new Promise((r) => server.listen(0, BIND_HOST, r));
  port = server.address().port;
});

after(async () => { if (server) server.close(); if (chrome) await chrome.close(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A tab held across steps. `stored` primes localStorage[KEY] on this origin
 *  BEFORE the Perch page loads (null clears it), so the very first paint is
 *  the one under test. */
async function tab(width, height, { stored = null, hash = "" } = {}) {
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
  const base = `http://${HOST}:${port}`;
  await cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 900 });
  await cdp("Page.enable");
  await cdp("DOM.enable");
  await cdp("Page.navigate", { url: base + "/prime" });
  await waitFor("document.readyState==='complete'", "the priming page");
  await evalIn(stored == null
    ? `localStorage.removeItem(${JSON.stringify(KEY)}); 'ok'`
    : `localStorage.setItem(${JSON.stringify(KEY)},${JSON.stringify(stored)}); 'ok'`);
  const ready = hash
    ? "document.body.getAttribute('data-view')==='chat'&&!!document.getElementById('perch-bot-name').textContent"
    : "document.querySelectorAll('#perch-list-body .roost-row').length>0";
  await cdp("Page.navigate", { url: base + "/dashboard/perch" + (hash ? "#" + hash : "") });
  await waitFor(ready, "the Perch page to settle");
  return {
    cdp, evalIn, waitFor, ready,
    json: async (expression) => JSON.parse(await evalIn(expression)),
    /** A real mouse click at the element's centre, dispatched by the browser. */
    click: async (elId) => {
      const r = await evalIn(`(function(){ var b=document.getElementById(${JSON.stringify(elId)}).getBoundingClientRect();
        return JSON.stringify({x:b.left+b.width/2,y:b.top+b.height/2}); })()`);
      const { x, y } = JSON.parse(r);
      for (const type of ["mousePressed", "mouseReleased"]) {
        await cdp("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
      }
    },
    key: async (name) => {
      const k = name === "Enter"
        ? { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" }
        : { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " };
      await cdp("Input.dispatchKeyEvent", { type: "keyDown", ...k });
      await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: k.key, code: k.code, windowsVirtualKeyCode: k.windowsVirtualKeyCode });
    },
    reload: async () => { await cdp("Page.reload", {}); await sleep(200); await waitFor(ready, "the reload to settle"); },
    shot: async (name) => {
      if (!SHOTS) return;
      mkdirSync(SHOTS, { recursive: true });
      const { data } = await cdp("Page.captureScreenshot", { format: "png" });
      writeFileSync(join(SHOTS, name + ".png"), Buffer.from(data, "base64"));
    },
    close: async () => { ws.close(); await fetch(CDP + "/json/close/" + t.id).catch(() => {}); },
  };
}

/** Everything the layout assertions read, in one round trip. */
const STATE = `(function(){
  function shown(id){ var e=document.getElementById(id); return !!e&&getComputedStyle(e).display!=='none'; }
  function rect(id){ var b=document.getElementById(id).getBoundingClientRect();
    return {left:Math.round(b.left),right:Math.round(b.right),top:Math.round(b.top),bottom:Math.round(b.bottom),width:Math.round(b.width)}; }
  var send=document.getElementById('perch-send').getBoundingClientRect();
  var ls=null; try{ ls=localStorage.getItem('${KEY}'); }catch(e){}
  return JSON.stringify({
    view: document.body.getAttribute('data-view'),
    list: shown('perch-list'), chat: shown('perch-chat'),
    collapseBtn: shown('perch-list-collapse'), revealBtn: shown('perch-list-reveal'), back: shown('perch-back'),
    chatRect: rect('perch-chat'),
    collapsedClass: document.getElementById('perch-hub-root').classList.contains('sessions-collapsed'),
    ariaCollapse: document.getElementById('perch-list-collapse').getAttribute('aria-expanded'),
    ariaReveal: document.getElementById('perch-list-reveal').getAttribute('aria-expanded'),
    active: document.activeElement&&document.activeElement.id,
    sendReachable: send.bottom<=innerHeight&&send.top>=0&&send.right<=innerWidth&&send.left>=0,
    stored: ls,
    identGap: Math.round(document.querySelector('#perch-chat .perch-ident').getBoundingClientRect().left
      - document.getElementById('perch-list-reveal').getBoundingClientRect().right),
    hScroll: document.documentElement.scrollWidth>document.documentElement.clientWidth
  });
})()`;

const LIST_HIDDEN = "getComputedStyle(document.getElementById('perch-list')).display==='none'";
const LIST_SHOWN = "getComputedStyle(document.getElementById('perch-list')).display!=='none'";

test("live @1280x900: collapse, persist across a reload, reveal with Enter, collapse with Space", async (t) => {
  if (!available) return t.skip("no headless Chrome");
  const s = await tab(1280, 900, { stored: null, hash: SID });
  try {
    const open = await s.json(STATE);
    assert.equal(open.view, "chat", "precondition: a session is open");
    assert.equal(open.list, true, "precondition: the split shows the list beside the chat");
    assert.equal(open.collapseBtn, true, "the collapse control is on screen while a chat is open");
    assert.equal(open.revealBtn, false, "nothing to reveal yet");
    assert.equal(open.ariaCollapse, "true");
    await s.shot("1280-expanded");

    // (a) a real click
    await s.click("perch-list-collapse");
    await s.waitFor(LIST_HIDDEN, "the list to leave the screen");
    const shut = await s.json(STATE);
    assert.equal(shut.list, false);
    assert.ok(shut.chatRect.width >= open.chatRect.width + 300,
      `the chat must take the column's width: ${open.chatRect.width} -> ${shut.chatRect.width}`);
    assert.equal(shut.ariaCollapse, "false");
    assert.equal(shut.ariaReveal, "false");
    assert.equal(shut.revealBtn, true);
    assert.equal(shut.active, "perch-list-reveal", "focus moves to the control that is still on screen");
    // The head reads "> Sessions  R4 Assistant", not the button at one edge
    // and the bot name stranded at the other (.perch-head is space-between).
    assert.ok(shut.identGap >= 0 && shut.identGap <= 24, "the bot name sits beside the reveal button, gap " + shut.identGap + "px");
    assert.equal(shut.stored, "1");
    // (d) Send stays reachable
    assert.equal(shut.sendReachable, true, "Send must stay on screen with the list collapsed");
    assert.equal(shut.hScroll, false);
    await s.shot("1280-collapsed");

    // (b) reload: still collapsed, and the hidden list is NOT polled. A cold
    // #sid load asks /roost exactly once (openSession has no row cached); a
    // second hit means the bootstrap polled a list it then hid (review I1).
    roostHits = 0;
    await s.reload();
    await sleep(600);                     // let any stray list load land before counting
    const again = await s.json(STATE);
    assert.equal(again.collapsedClass, true, "persisted");
    assert.equal(again.list, false);
    assert.equal(again.chatRect.width, shut.chatRect.width, "the chat is wide straight away");
    assert.equal(again.ariaReveal, "false");
    assert.equal(roostHits, 1, `a collapsed list must not be loaded or polled; /roost was hit ${roostHits}x`);

    // (c) keyboard: Enter on the reveal button
    await s.evalIn("document.getElementById('perch-list-reveal').focus(); 'ok'");
    roostHits = 0;
    await s.key("Enter");
    await s.waitFor(LIST_SHOWN, "the list to come back");
    const back = await s.json(STATE);
    assert.equal(back.active, "perch-list-collapse", "focus hands back to the collapse control");
    assert.equal(back.ariaCollapse, "true");
    assert.equal(back.chatRect.width, open.chatRect.width);
    assert.equal(back.stored, "0");
    for (const end = Date.now() + 3000; roostHits < 1 && Date.now() < end;) await sleep(100);
    assert.ok(roostHits >= 1, "revealing loads the list at once, not at the next 10s tick");

    // Space on the collapse button
    await s.key("Space");
    await s.waitFor(LIST_HIDDEN, "Space to collapse it again");
    const spaced = await s.json(STATE);
    assert.equal(spaced.active, "perch-list-reveal");
    assert.equal(spaced.stored, "1");
  } finally { await s.close(); }
});

test("live @1280x900: with the artifact split pane open and the list collapsed, the chat and both controls stay usable", async (t) => {
  if (!available) return t.skip("no headless Chrome");
  const s = await tab(1280, 900, { stored: "1", hash: SID });
  try {
    await s.waitFor("!!document.querySelector('#perch-transcript .art-open')", "the artifact card");
    await s.evalIn("document.querySelector('#perch-transcript .art-open').click(); 'ok'");
    await s.waitFor("document.body.classList.contains('perch-art-split')", "the split pane");
    const m = await s.json(`(function(){
      var o=JSON.parse(${STATE});
      var pane=document.getElementById('perch-art-pane').getBoundingClientRect();
      var r=document.getElementById('perch-list-reveal').getBoundingClientRect();
      var hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
      o.paneLeft=Math.round(pane.left);
      o.revealHit=!!hit&&(hit.id==='perch-list-reveal'||document.getElementById('perch-list-reveal').contains(hit));
      return JSON.stringify(o);
    })()`);
    assert.equal(m.list, false, "precondition: collapsed");
    assert.equal(m.chat, true);
    assert.ok(m.chatRect.right <= m.paneLeft, `the chat (right ${m.chatRect.right}) must not run under the pane (left ${m.paneLeft})`);
    assert.equal(m.sendReachable, true);
    assert.ok(m.chatRect.width >= 300, "the chat keeps a usable width: " + m.chatRect.width);
    assert.equal(m.revealHit, true, "the reveal control is hit-testable, not under the pane");
    await s.shot("1280-collapsed-artifact-pane");
    await s.click("perch-list-reveal");
    await s.waitFor(LIST_SHOWN, "the list to come back beside the pane");
  } finally { await s.close(); }
});

test("live @1280x900: with no session open the stored choice does not hide the list (and it keeps polling)", async (t) => {
  if (!available) return t.skip("no headless Chrome");
  const s = await tab(1280, 900, { stored: "1" });
  try {
    const m = await s.json(STATE);
    assert.equal(m.view === "chat", false);
    assert.equal(m.list, true, "the collapse rules are keyed on an open chat");
    assert.equal(m.collapseBtn, false, "no collapse control without a chat to widen");
    assert.equal(m.revealBtn, false);
  } finally { await s.close(); }
});

test("live @412x730: the phone is unchanged, whatever is stored", async (t) => {
  if (!available) return t.skip("no headless Chrome");
  const chatWith = async (stored) => {
    const s = await tab(412, 730, { stored });
    try {
      const list = await s.json(STATE);
      assert.equal(list.list, true, `stored=${stored}: the list view shows the list`);
      assert.equal(list.collapseBtn, false);
      assert.equal(list.revealBtn, false);
      await s.evalIn(`location.hash='${SID}'; 'ok'`);
      await s.waitFor("document.body.getAttribute('data-view')==='chat'&&!!document.getElementById('perch-bot-name').textContent", "the chat");
      const chat = await s.json(STATE);
      await s.shot(stored === "1" ? "412-chat-stored-collapsed" : "412-chat-today");
      assert.equal(chat.list, false, "one view at a time");
      assert.equal(chat.collapseBtn, false, "both new controls stay off the phone");
      assert.equal(chat.revealBtn, false);
      assert.equal(chat.back, true, "← Sessions is still the way back");
      assert.equal(chat.sendReachable, true);
      await s.click("perch-back");
      await s.waitFor("document.body.getAttribute('data-view')!=='chat'", "← Sessions to return to the list");
      assert.equal((await s.json(STATE)).list, true);
      return chat.chatRect;
    } finally { await s.close(); }
  };
  const today = await chatWith(null);
  const stored = await chatWith("1");
  assert.deepEqual(stored, today, "the chat view is pixel-for-pixel where it is today");
});

test("live: toggling across five Turbo visits adds no window or document listeners", async (t) => {
  if (!available) return t.skip("no headless Chrome");
  const s = await tab(1280, 900, { stored: null, hash: SID });
  try {
    assert.equal(await s.evalIn("typeof window.Turbo"), "object", "fixture check: Turbo must be on the page");
    const counts = async () => {
      const out = {};
      for (const expr of ["window", "document"]) {
        const h = await s.cdp("Runtime.evaluate", { expression: expr, returnByValue: false });
        const { listeners } = await s.cdp("DOMDebugger.getEventListeners", { objectId: h.result.objectId, depth: 0 });
        for (const l of listeners) { const k = expr + "." + l.type; out[k] = (out[k] || 0) + 1; }
      }
      return out;
    };
    const toggleTwice = "(function(){ document.getElementById('perch-list-collapse').click();" +
      " document.getElementById('perch-list-reveal').click(); return 'ok'; })()";
    await s.evalIn(toggleTwice);
    const before = await counts();
    for (let i = 0; i < 4; i++) {
      await s.evalIn(`Turbo.visit('/dashboard/perch#${SID}',{action:'replace'}); 'go'`);
      await s.waitFor(`window.__crowPerchHub.gen===${i + 2}`, "visit " + (i + 2));
      await s.waitFor("!!document.getElementById('perch-list-collapse')", "the new body");
      await s.evalIn(toggleTwice);
    }
    assert.equal(await s.evalIn("window.__crowPerchHub.gen"), 5, "five script instances really ran");
    assert.deepEqual(await counts(), before, "listener counts must be flat across instances");
  } finally { await s.close(); }
});
