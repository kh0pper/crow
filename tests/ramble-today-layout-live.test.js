/**
 * Moves design P10 Task 10.5 — the Ramble panel's live layout, at 360x640 (a
 * phone, mobile emulation) and 800x480 (a small landscape screen).
 *
 * The REAL panel HTML (panel/ramble.js laid out in a bare document), served by
 * a local http server together with the bundle's own static files and three
 * JSON answers: the approved copy table, the day's cards and the prefs. The
 * page's other clients (the map, the egg, the flock) ask for routes this
 * server does not have and 404, exactly as an install without the bundle's
 * server modules would: those errors are expected and never asserted on.
 *
 * What is measured, per size:
 *   - the five-tab bar is one row, every tab one tap tall and inside the
 *     screen, no label spilling out of its own button;
 *   - the Today view never pans sideways;
 *   - the day's three cards are drawn, the Now card is open, no card reaches
 *     past the screen and every card header is one tap tall;
 *   - the first-run sheet fits on both axes with its Skip and Next reachable;
 *   - opening Customize leaves its cards-a-day block inside the screen.
 * Plus a control that proves the overflow check reaches the mechanism.
 *
 * A private headless Chrome (tests/fixtures/headless-chrome.mjs), never a live
 * browser. Skips without one unless CROW_REQUIRE_TEST_CHROME=1.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { startHeadlessChrome } from "./fixtures/headless-chrome.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATIC_DIR = resolve(join(ROOT, "bundles/ramble/panel/static"));
const COPY = JSON.parse(readFileSync(join(ROOT, "bundles/ramble/server/moves/player-copy.en.json"), "utf8"));

const { default: panel } = await import("../bundles/ramble/panel/ramble.js");

/* ---------------------------------------------------------------- fixtures */

const LONG_TITLE = "A ten minute walk at a pace you can talk at, out in the park";

const slot = (name, entry, extra) => Object.assign({
  slot: name, entry, area: null, plannedArea: null, reasons: [], why: "",
  swap: 0, done: false, standIn: false, empty: false,
}, extra || {});

const WALK = { id: "walk-10", kind: "walk", title: "A ten minute walk", minutes: 10 };
const LONG = { id: "long-entry", kind: "exercise", title: LONG_TITLE, minutes: 10 };
const BEND = { id: "side-bend", kind: "pose", title: "Side bend", minutes: 10 };

const DAY = {
  day: "2026-10-30",
  need: 3,
  nowSlot: "midday",
  off: false,
  complete: false,
  outdoor: null,
  steps: { day: "2026-10-30", goal: 6000, steps: 4200, goal_met: false, walked: false },
  streak: { days: 12, doneToday: 1, need: 3 },
  setup: { needed: false },
  slots: [slot("morning", LONG), slot("midday", WALK), slot("evening", BEND)],
};

/* The same day for a player who has not answered the first-run questions yet,
 * with an empty slot so that card's own words are drawn too. */
const FIRST_RUN_DAY = Object.assign(JSON.parse(JSON.stringify(DAY)), {
  setup: { needed: true },
  slots: [
    slot("morning", LONG),
    slot("midday", WALK),
    slot("evening", null, { empty: true, reasons: ["no_match"] }),
  ],
});

const PREFS = {
  prefs: { on: true, kinds: [], equipment: ["none", "wall"], limits: [], level: 2, weather: true, cards: 3, windows: [] },
};

const PAGES = {
  "/": DAY,
  "/first-run": FIRST_RUN_DAY,
};

const CARDS_READY = "document.querySelectorAll('#rb-today-view .rb-slot-card').length === 3";

/* ----------------------------------------------------------------- server */

const TYPES = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

let chrome = null, server = null, port = 0, html = "";
let currentPage = "/";

function sendJson(res, body, status) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/** One allow-listed file from panel/static, resolved-prefix checked. */
function sendStatic(rel, res) {
  let target = "";
  try { target = resolve(join(STATIC_DIR, decodeURIComponent(rel))); } catch { target = ""; }
  if (!target || (target !== STATIC_DIR && !target.startsWith(STATIC_DIR + sep))) {
    res.writeHead(400, { "content-type": "text/plain" });
    res.end("Bad path");
    return;
  }
  const ext = target.slice(target.lastIndexOf("."));
  const type = TYPES[ext];
  if (!type || !existsSync(target) || !statSync(target).isFile()) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
    return;
  }
  res.writeHead(200, { "content-type": type });
  res.end(readFileSync(target));
}

async function renderPanel() {
  let sent = null;
  const res = { send: (body) => { sent = body; } };
  await panel.handler({ query: {} }, res, {
    db: null,
    layout: ({ content }) => "<!doctype html><html><head><meta charset=utf-8>" +
      "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
      "</head><body>" + content + "</body></html>",
    lang: "en",
  });
  assert.ok(sent, "the panel sent nothing");
  return sent;
}

before(async () => {
  chrome = await startHeadlessChrome();
  if (!chrome) return;
  html = await renderPanel();
  server = http.createServer((req, res) => {
    let pathname = "/";
    try { pathname = new URL(req.url || "/", "http://localhost").pathname; } catch { pathname = "/"; }

    if (Object.prototype.hasOwnProperty.call(PAGES, pathname)) {
      currentPage = pathname;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    if (pathname.startsWith("/ramble/static/")) {
      sendStatic(pathname.slice("/ramble/static/".length), res);
      return;
    }
    if (pathname === "/api/ramble/moves/copy") { sendJson(res, { copy: COPY }, 200); return; }
    if (pathname === "/api/ramble/moves/day") { sendJson(res, PAGES[currentPage] || DAY, 200); return; }
    if (pathname === "/api/ramble/moves/prefs") { sendJson(res, PREFS, 200); return; }
    // Every other route the rest of the Ramble client asks for, and every
    // other path: nothing here answers it.
    sendJson(res, {}, 404);
  });
  await new Promise((r) => server.listen(0, chrome.bindHost, r));
  port = server.address().port;
});

after(async () => {
  if (server) server.close();
  if (chrome) await chrome.close();
});

/* ------------------------------------------------------------ the browser */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MEASURE = `(function(){
  var iw = window.innerWidth, ih = window.innerHeight;
  function box(el){
    if (!el) return null;
    var r = el.getBoundingClientRect();
    return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height };
  }
  function shown(el){
    if (!el) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  var root = document.getElementById("ramble");
  var tabs = Array.prototype.slice.call(document.querySelectorAll("#rb-tabs .rb-tab")).map(function(tab){
    var r = tab.getBoundingClientRect();
    return { top: r.top, left: r.left, right: r.right, height: r.height,
      sw: tab.scrollWidth, cw: tab.clientWidth, text: tab.textContent };
  });
  var cards = Array.prototype.slice.call(document.querySelectorAll("#rb-today-view .rb-slot-card")).map(function(card){
    var r = card.getBoundingClientRect();
    return { slot: card.getAttribute("data-slot"), left: r.left, right: r.right,
      bodyShown: shown(card.querySelector(".rb-slot-body")) };
  });
  var heads = Array.prototype.slice.call(document.querySelectorAll("#rb-today-view .rb-slot-head")).map(box);
  var firstRun = document.getElementById("rb-first-run");
  var panelEl = firstRun ? firstRun.querySelector(".rb-sheet-panel") : null;
  var buttons = Array.prototype.slice.call(document.querySelectorAll("#rb-first-run-body .rb-first-run-btns .rb-btn"));
  var prefSlots = document.getElementById("rb-pref-slots");
  var nowBadge = document.querySelector("#rb-today-view .rb-slot-now");
  var nowCard = nowBadge ? nowBadge.closest(".rb-slot-card") : null;
  return JSON.stringify({
    iw: iw,
    ih: ih,
    docScrollWidth: document.documentElement.scrollWidth,
    view: root ? root.getAttribute("data-view") : null,
    tabCount: tabs.length,
    tabs: tabs,
    cards: cards,
    heads: heads,
    nowBodyShown: nowCard ? shown(nowCard.querySelector(".rb-slot-body")) : null,
    firstRun: {
      shown: shown(firstRun),
      panel: box(panelEl),
      buttons: buttons.map(function(b){ var o = box(b); o.text = b.textContent; return o; })
    },
    prefSlots: box(prefSlots),
    prefSlotsFilled: prefSlots ? prefSlots.children.length > 0 : false
  });
})()`;

async function measure(opts) {
  const { page = "/", w = 360, h = 640, waitFor = "", openCustomize = false, injectWide = 0 } = opts || {};
  const tab = await (await fetch(chrome.cdp + "/json/new?about:blank", { method: "PUT" })).json();
  const { default: WebSocket } = await import("ws");
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
  let id = 0;
  const send = (method, params = {}) => new Promise((resolve, reject) => {
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
    const o = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (o.exceptionDetails) throw new Error(JSON.stringify(o.exceptionDetails));
    return o.result.value;
  };
  const until = async (expression, tries) => {
    let ok = false;
    for (let i = 0; i < tries && !ok; i += 1) {
      try { ok = await evalIn(expression); } catch { ok = false; }
      if (!ok) await sleep(150);
    }
    return ok;
  };
  try {
    await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: w < 700 });
    await send("Page.navigate", { url: `http://${chrome.pageHost}:${port}${page}` });
    assert.ok(await until("document.readyState === 'complete' && !!document.getElementById('rb-tabs')", 120),
      "the panel page never loaded: " + page);
    if (waitFor) assert.ok(await until(waitFor, 120), "the page never got to: " + waitFor);
    if (openCustomize) {
      await evalIn("(function(){var b=document.getElementById('rb-customize');if(!b)return 0;b.click();return 1;})()");
      assert.ok(await until("!!document.querySelector('#rb-pref-slots .rb-pref-slots-block')", 120),
        "the customize sheet never filled its cards-a-day block");
    }
    if (injectWide > 0) {
      await evalIn(`(function(){var d=document.createElement('div');d.style.width=${injectWide}+'px';` +
        "d.style.height='10px';document.body.appendChild(d);return 1;})()");
    }
    // A sheet slides up as it opens (.22s). Measure where it comes to rest, not
    // where the animation had got to.
    await evalIn("(function(){" +
      "var running=(document.getAnimations ? document.getAnimations() : []).filter(function(a){" +
        "return a.playState === 'running' && a.effect && a.effect.target && a.effect.target.classList &&" +
          "a.effect.target.classList.contains('rb-sheet-panel');});" +
      "return Promise.all(running.map(function(a){ return a.finished.catch(function(){}); })).then(function(){ return 1; });" +
    "})()");
    await evalIn("new Promise(function(r){requestAnimationFrame(function(){requestAnimationFrame(function(){r(1);});});})");
    return JSON.parse(await evalIn(MEASURE));
  } finally {
    ws.close();
    await fetch(chrome.cdp + "/json/close/" + tab.id).catch(() => {});
  }
}

/* ------------------------------------------------------------- the checks */

const TOL = 1;

for (const [w, h] of [[360, 640], [800, 480]]) {
  test(`live @${w}x${h}: the five tabs are one row, one tap tall, inside the screen`, async (t) => {
    if (!chrome) return t.skip("no headless Chrome");
    const m = await measure({ page: "/", w, h, waitFor: CARDS_READY });
    assert.equal(m.tabCount, 5, "five tabs: " + JSON.stringify(m.tabs));
    const tops = m.tabs.map((tab) => tab.top);
    assert.ok(Math.max(...tops) - Math.min(...tops) <= 2, "all five on one row: " + JSON.stringify(m.tabs));
    for (const tab of m.tabs) {
      assert.ok(tab.height >= 44, "one tap tall (" + tab.text + "): " + JSON.stringify(tab));
      assert.ok(tab.left >= -TOL && tab.right <= m.iw + TOL,
        "inside the screen (" + tab.text + "): " + JSON.stringify(tab) + " at " + m.iw);
      assert.ok(tab.sw <= tab.cw + 1,
        "its label does not spill out of the button (" + tab.text + "): " + JSON.stringify(tab));
    }
  });

  test(`live @${w}x${h}: the Today view never pans sideways`, async (t) => {
    if (!chrome) return t.skip("no headless Chrome");
    const m = await measure({ page: "/", w, h, waitFor: CARDS_READY });
    assert.equal(m.view, "today", "the Today view is the one showing: " + JSON.stringify(m.view));
    assert.ok(m.docScrollWidth <= m.iw,
      "the page is no wider than the screen: " + m.docScrollWidth + " at " + m.iw);
  });

  test(`live @${w}x${h}: the day's three cards load, the Now card open, none past the screen`, async (t) => {
    if (!chrome) return t.skip("no headless Chrome");
    const m = await measure({ page: "/", w, h, waitFor: CARDS_READY });
    assert.equal(m.cards.length, 3, "a card per slot: " + JSON.stringify(m.cards));
    assert.equal(m.nowBodyShown, true, "the Now card's body is on show: " + JSON.stringify(m.cards));
    for (const card of m.cards) {
      assert.ok(card.left >= -TOL && card.right <= m.iw + TOL,
        "the " + card.slot + " card is inside the screen: " + JSON.stringify(card) + " at " + m.iw);
    }
    assert.equal(m.heads.length, 3, "each card has its header button");
    for (const head of m.heads) {
      assert.ok(head.h >= 44, "the card header is one tap tall: " + JSON.stringify(head));
    }
  });

  test(`live @${w}x${h}: the first-run sheet fits, with Skip and Next reachable`, async (t) => {
    if (!chrome) return t.skip("no headless Chrome");
    const m = await measure({
      page: "/first-run", w, h,
      waitFor: "!!document.querySelector('#rb-first-run-body .rb-first-run-btns .rb-btn')",
    });
    assert.equal(m.firstRun.shown, true, "the first-run sheet is on screen");
    const fit = m.firstRun.panel;
    assert.ok(fit, "the sheet has its panel");
    assert.ok(fit.l >= -TOL && fit.r <= m.iw + TOL, "inside the screen across: " + JSON.stringify(fit) + " at " + m.iw);
    assert.ok(fit.t >= -TOL && fit.b <= m.ih + TOL, "inside the screen down: " + JSON.stringify(fit) + " at " + m.ih);

    const labels = m.firstRun.buttons.map((b) => b.text);
    assert.deepEqual(labels, [COPY["firstRun.skip"], COPY["firstRun.next"]],
      "the first screen offers Skip and Next: " + JSON.stringify(labels));
    for (const b of m.firstRun.buttons) {
      assert.ok(b.l >= -TOL && b.r <= m.iw + TOL && b.t >= -TOL && b.b <= m.ih + TOL,
        "reachable (" + b.text + "): " + JSON.stringify(b));
    }
    assert.ok(m.docScrollWidth <= m.iw,
      "the page is no wider than the screen: " + m.docScrollWidth + " at " + m.iw);
  });

  test(`live @${w}x${h}: the customize sheet's cards-a-day block stays inside the screen`, async (t) => {
    if (!chrome) return t.skip("no headless Chrome");
    const m = await measure({ page: "/", w, h, waitFor: CARDS_READY, openCustomize: true });
    assert.equal(m.prefSlotsFilled, true, "the block was drawn into the sheet");
    assert.ok(m.prefSlots, "the block has a box");
    assert.ok(m.prefSlots.l >= -TOL && m.prefSlots.r <= m.iw + TOL,
      "inside the screen across: " + JSON.stringify(m.prefSlots) + " at " + m.iw);
    assert.ok(m.docScrollWidth <= m.iw,
      "the page is no wider than the screen: " + m.docScrollWidth + " at " + m.iw);
  });
}

test("live @360x640: the overflow check reaches the mechanism — a 2000px element pans the page", async (t) => {
  if (!chrome) return t.skip("no headless Chrome");
  const m = await measure({ page: "/", w: 360, h: 640, waitFor: CARDS_READY, injectWide: 2000 });
  assert.ok(m.docScrollWidth > m.iw,
    "a 2000px element must read as a sideways pan, or the check above proves nothing: " +
    m.docScrollWidth + " at " + m.iw);
});
