/**
 * The player bar reserves its space on every dashboard page (2026-10-20), measured in a REAL browser.
 *
 * The report: on a phone, Perch's chat view with a radio playing — the fixed player bar (bottom:0,
 * z-index 1000) sat on the bottom tab row (#perch-tabs), so the tabs were hidden and could not be tapped.
 * The same bar covered the end of every phone page (.content-body could never scroll out from under it)
 * and the last ~bar of every desktop page.
 *
 * The fix is one mechanism: playerBarJs runs the reserve (player.js PLAYER_RESERVE_JS), which keeps
 * --crow-player-h on <html> equal to the bar's height while it shows (else 0px), and the layout reserves
 * through that variable only — the app shells (phone, Perch) end at the bar, a scrolling page pads its
 * .main-content, and bottom-anchored sheets sit on the bar.
 *
 * Here: the real renderLayout + perchHubPanel (the perch-phone-layout harness), with the bar and the player
 * script added exactly the way dashboard/index.js adds them, real Turbo 8.0.5 (the vendored file), real
 * media playback, a private headless Chrome (tests/fixtures/headless-chrome.mjs). Skips with no browser
 * unless CROW_REQUIRE_TEST_CHROME=1. CROW_TEST_SHOT_DIR=<dir> saves PNGs of Perch at 412 px.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startHeadlessChrome } from "./fixtures/headless-chrome.mjs";

// The bot engine is READY in this fixture (see perch-phone-layout.test.js): no "engine not installed" banner.
process.env.PIBOT_PI_CLI = "/nonexistent/pi-never-spawned-by-this-file.js";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const SID = "perchlive-5c1d0a77";
const SHOT_DIR = process.env.CROW_TEST_SHOT_DIR || "";

/** A quiet 8 kHz tone (tests/player-bar-turbo-nav-live.test.js). */
function wav(sec) {
  const n = 8000 * sec, b = Buffer.alloc(44 + n);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n, 4); b.write("WAVE", 8); b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24); b.writeUInt32LE(8000, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write("data", 36); b.writeUInt32LE(n, 40);
  for (let i = 0; i < n; i++) b[44 + i] = 128 + Math.round(10 * Math.sin(i / 5));
  return b;
}
const WAV = wav(60);

let chrome = null, server = null, port = 0, HOST = "127.0.0.1";

function serveApi(req, res) {
  const url = req.url.split("?")[0];
  const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
  if (url.endsWith("/roost")) return send(200, { birds: [{ id: "hank", name: "Hank", perch_attached: true, state: "working",
    sessions: [{ sessionId: SID, state: "awake", cardId: null, pendingUi: false, label: null }] }], occupiedCardIds: [] });
  if (url.endsWith("/events")) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write(": open\n\n");
    return;                                    // stays open, like the real stream
  }
  if (url.endsWith("/transcript")) {
    const events = [];
    for (let i = 0; i < 8; i++) {
      events.push({ type: "message", message: { role: "user", content: "question " + i } });
      events.push({ type: "message", message: { role: "assistant", content: "answer " + i + " — " + "words ".repeat(30) } });
    }
    return send(200, { events });
  }
  return send(200, {});
}

/** A plain layout page: a tall .content-body ending in #last-row, plus the Bot Board's styles so its
 *  phone picker sheet and drawer can be opened on it. */
function plainContent(botBoardCss) {
  const rows = Array.from({ length: 40 }, (_, i) => `<p style="margin:0 0 12px">row ${i}</p>`).join("");
  return `${botBoardCss}${rows}<p id="last-row" style="margin:0;padding:8px;background:#fc0">the last row</p>`;
}

before(async () => {
  // The Crow app's WebView plays without a gesture (setMediaPlaybackRequiresUserGesture(false)).
  chrome = await startHeadlessChrome({ extraArgs: ["--autoplay-policy=no-user-gesture-required"] });
  if (!chrome) return;
  HOST = chrome.pageHost;
  const { default: perchHubPanel } = await import("../servers/gateway/dashboard/panels/perch-hub.js");
  const { renderLayout } = await import("../servers/gateway/dashboard/shared/layout.js");
  const { playerBarHtml, playerBarJs } = await import("../servers/gateway/dashboard/shared/player.js");
  const { botBoardStyles } = await import("../servers/gateway/dashboard/panels/bot-board/css.js");
  const turbo = readFileSync(REPO + "/servers/gateway/public/vendor/turbo-8.0.5.umd.js");
  // dashboard/index.js:884-892 — every panel page gets the bar after the content and the player script.
  const withBar = (opts) => renderLayout({ ...opts, activePanel: "perch", panels: [perchHubPanel], lang: "en",
    afterContent: playerBarHtml("en"), scripts: (opts.scripts || "") + playerBarJs("en") });
  server = http.createServer(async (req, res) => {
    const html = (body) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(body); };
    if (req.url.startsWith("/dashboard/perch-api/")) return serveApi(req, res);
    if (req.url.startsWith("/vendor/turbo")) { res.writeHead(200, { "content-type": "application/javascript" }); return res.end(turbo); }
    if (req.url === "/a.wav") { res.writeHead(200, { "content-type": "audio/wav", "content-length": WAV.length }); return res.end(WAV); }
    if (req.url.startsWith("/dashboard/plain")) return html(withBar({ title: "Plain", content: plainContent(botBoardStyles()) }));
    // A layout page WITHOUT the bar: a Turbo visit through it drops the permanent bar, and the way back
    // brings a NEW bar element (review I2).
    if (req.url.startsWith("/dashboard/nobar")) return html(renderLayout({ title: "No bar", content: "<p id='nobar'>no bar</p>",
      activePanel: "perch", panels: [perchHubPanel], lang: "en" }));
    if (req.url.startsWith("/dashboard/perch")) {
      const out = await perchHubPanel.handler(req, res, { lang: "en", layout: withBar });
      if (!res.headersSent) html(out);
      return;
    }
    res.writeHead(404, { "content-type": "application/json" }); res.end("{}");
  });
  await new Promise((r) => server.listen(0, chrome.bindHost, r));
  port = server.address().port;
});
after(async () => { server?.closeAllConnections?.(); server?.close(); if (chrome) await chrome.close(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TWO_FRAMES = "new Promise(function(r){requestAnimationFrame(function(){requestAnimationFrame(function(){r(1);});});})";

/** A tab at w x h on `path`, held open across evaluations. */
async function open(w, h, path, ready) {
  const t = await (await fetch(chrome.cdp + "/json/new?about:blank", { method: "PUT" })).json();
  const { default: WebSocket } = await import("ws");
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
  let id = 0;
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mine = ++id;
    const on = (raw) => { const m = JSON.parse(raw); if (m.id !== mine) return; ws.off("message", on); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result || {}); };
    ws.on("message", on); ws.send(JSON.stringify({ id: mine, method, params }));
  });
  const evalIn = async (expression) => {
    const o = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (o.exceptionDetails) throw new Error("page threw: " + JSON.stringify(o.exceptionDetails));
    return o.result.value;
  };
  const until = async (expr, ms = 15000) => {
    const end = Date.now() + ms;
    for (;;) { let v; try { v = await evalIn(expr); } catch { v = false; } if (v === true || Date.now() > end) return v; await sleep(100); }
  };
  await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 2, mobile: w < 900 });
  await send("Page.enable");
  await send("Page.navigate", { url: `http://${HOST}:${port}${path}` });
  assert.equal(await until(ready), true, "the page never reached its ready state: " + ready);
  // Hermetic: the player persists its item in this origin's localStorage; start every tab with the bar hidden.
  await evalIn("(function(){ try { localStorage.clear(); } catch (e) {} var b = document.getElementById('crow-player-bar'); if (b && b.style.display !== 'none') window.crowPlayer.close(); return 1; })()");
  await evalIn(TWO_FRAMES);
  return {
    send, evalIn, until,
    json: async (expr) => JSON.parse(await evalIn(expr)),
    css: (text) => evalIn(`(function(){var s=document.createElement('style');s.textContent=${JSON.stringify(text)};document.head.appendChild(s);return 1;})()`),
    showBar: async () => { await evalIn("window.crowPlayer.load('/a.wav', 'Radio KPFT'); 1"); await evalIn(TWO_FRAMES); },
    hideBar: async () => { await evalIn("window.crowPlayer.close(); 1"); await evalIn(TWO_FRAMES); },
    shot: async (name) => {
      if (!SHOT_DIR) return;
      mkdirSync(SHOT_DIR, { recursive: true });
      const png = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(join(SHOT_DIR, name + ".png"), Buffer.from(png.data, "base64"));
    },
    close: async () => { try { await evalIn("try { localStorage.clear(); } catch (e) {} 1"); } catch {} ws.close(); await fetch(chrome.cdp + "/json/close/" + t.id).catch(() => {}); },
  };
}

const PERCH = `/dashboard/perch#${SID}`;
const PERCH_READY = "document.body.getAttribute('data-view') === 'chat' && !!document.querySelector('#perch-transcript .entry.bot') && document.getElementById('perch-send').getBoundingClientRect().height > 0";
const PLAIN_READY = "!!window.crowPlayer && !!document.getElementById('last-row')";

/** Shared: the variable, the bar, and a hit test that names the bar when it is what the finger lands on. */
const COMMON = `
  var bar = document.getElementById('crow-player-bar');
  var shown = !!bar && bar.style.display !== 'none';
  var barTop = shown ? bar.getBoundingClientRect().top : innerHeight;
  var v = getComputedStyle(document.documentElement).getPropertyValue('--crow-player-h').trim();
  function hit(e, name) { var b = e.getBoundingClientRect(); var x = b.left + b.width / 2, y = b.top + b.height / 2;
    var t = document.elementFromPoint(x, y);
    return { name: name, at: t ? (t.id || t.className || t.tagName) : null, ok: !!t && (t === e || e.contains(t)), inBar: !!t && !!t.closest('#crow-player-bar'), top: b.top, bottom: b.bottom, h: b.height }; }
`;
const PERCH_GEO = `(function(){ ${COMMON}
  var items = [].map.call(document.querySelectorAll('#perch-tabs button'), function (b) { return hit(b, 'tab:' + b.getAttribute('data-tab')); })
    .concat([hit(document.getElementById('perch-input'), 'input'), hit(document.getElementById('perch-send'), 'send')]);
  return JSON.stringify({ v: v, barH: shown ? bar.offsetHeight : 0, shown: shown, barTop: barTop, vh: innerHeight, items: items,
    tabsBottom: document.getElementById('perch-tabs').getBoundingClientRect().bottom,
    sendBottom: document.getElementById('perch-send').getBoundingClientRect().bottom,
    scrollX: document.documentElement.scrollWidth - innerWidth, scrollY: document.documentElement.scrollHeight - innerHeight });
})()`;

function assertClear(m, label) {
  for (const it of m.items) {
    assert.equal(it.inBar, false, `${label}: ${it.name} is under the bar: ` + JSON.stringify(m));
    assert.equal(it.ok, true, `${label}: ${it.name} is not what a tap at its centre reaches: ` + JSON.stringify(m));
    assert.ok(it.h > 0 && it.bottom <= m.barTop + 0.5, `${label}: ${it.name} runs below the bar's top: ` + JSON.stringify(m));
  }
}

// ─── Perch: the report ─────────────────────────────────────────────────────

for (const [w, h] of [[412, 915], [1280, 900]]) {
  test(`live @${w}x${h}: Perch's tabs, message box and Send sit above the bar and take the tap; hidden bar → 0px and the old layout`, async (t) => {
    if (!chrome) return t.skip("no headless Chrome");
    const s = await open(w, h, PERCH, PERCH_READY);
    try {
      const m0 = await s.json(PERCH_GEO);
      assert.equal(m0.shown, false);
      assert.equal(m0.v, "0px", "no bar, no reserve");
      assertClear(m0, "hidden");
      if (w === 412) await s.shot("perch-412-bar-hidden");

      await s.showBar();
      const m1 = await s.json(PERCH_GEO);
      assert.equal(m1.shown, true);
      assert.ok(m1.barH > 0, "the bar shows: " + JSON.stringify(m1));
      assert.equal(m1.v, m1.barH + "px", "the variable is the bar's height");
      assertClear(m1, "bar shown");
      assert.ok(m1.scrollX <= 0, "no horizontal page scroll: " + JSON.stringify(m1));
      assert.ok(m1.scrollY <= 0, "the document itself does not scroll: " + JSON.stringify(m1));
      if (w === 412) await s.shot("perch-412-bar-shown");

      await s.hideBar();
      const m2 = await s.json(PERCH_GEO);
      assert.equal(m2.v, "0px", "closed: back to 0px");
      assert.ok(Math.abs(m2.tabsBottom - m0.tabsBottom) <= 0.5 && Math.abs(m2.sendBottom - m0.sendBottom) <= 0.5,
        "closed: the tabs and Send return to where they were: " + JSON.stringify({ m0, m2 }));
    } finally { await s.close(); }
  });
}

test("live @412x915: the test reaches the mechanism — with the shell's height knocked back to 100dvh the tabs are under the bar", async (t) => {
  if (!chrome) return t.skip("no headless Chrome");
  const s = await open(412, 915, PERCH, PERCH_READY);
  try {
    await s.css(".main-content{height:100vh !important;height:100dvh !important;min-height:100vh !important}");
    await s.showBar();
    const m = await s.json(PERCH_GEO);
    assert.ok(m.items.some((it) => it.inBar || !it.ok), "knocked out, the bug must come back: " + JSON.stringify(m));
    await s.shot("perch-412-bar-shown-BEFORE-knockout");
  } finally { await s.close(); }
});

test("live @412x915 (C1): the base min-height:100vh must lose to the shell — re-injected, the tabs are under the bar again", async (t) => {
  if (!chrome) return t.skip("no headless Chrome");
  const s = await open(412, 915, PERCH, PERCH_READY);
  try {
    await s.css("body .main-content{min-height:100vh !important}");
    await s.showBar();
    const m = await s.json(PERCH_GEO);
    assert.ok(m.items.some((it) => it.inBar || !it.ok), "without min-height:0 the shell grows back under the bar: " + JSON.stringify(m));
  } finally { await s.close(); }
});

test("live @412x915: a transcript scrolled to its end stays at its end when the bar appears", async (t) => {
  if (!chrome) return t.skip("no headless Chrome");
  const s = await open(412, 915, PERCH, PERCH_READY);
  try {
    const gap = "(function(){var tr=document.getElementById('perch-transcript');return tr.scrollHeight-tr.scrollTop-tr.clientHeight;})()";
    await s.evalIn("(function(){var tr=document.getElementById('perch-transcript');tr.scrollTop=tr.scrollHeight;return 1;})()");
    await s.evalIn(TWO_FRAMES);
    assert.ok(await s.evalIn(gap) <= 2, "fixture: scrolled to the end");
    await s.showBar();
    await sleep(100);
    assert.ok(await s.evalIn(gap) <= 2, "still at the end after the column shrank: " + await s.evalIn(gap));
  } finally { await s.close(); }
});

test("live @412x915 and @1280x900: Perch's artifact pane (full-screen sheet, docked split) ends at the bar", async (t) => {
  if (!chrome) return t.skip("no headless Chrome");
  for (const [w, h, cls] of [[412, 915, "art-pane-sheet"], [1280, 900, "art-pane-split"]]) {
    const s = await open(w, h, PERCH, PERCH_READY);
    try {
      await s.showBar();
      const m = await s.json(`(function(){ ${COMMON}
        var p = document.createElement('div'); p.className = 'art-pane ${cls}'; p.innerHTML = '<div class="art-pane-bar">x</div><div style="flex:1"></div><div id="pane-foot" style="height:30px">foot</div>';
        document.getElementById('perch-hub-root').appendChild(p);
        var r = p.getBoundingClientRect();
        return JSON.stringify({ v: v, barTop: barTop, paneBottom: r.bottom, foot: hit(document.getElementById('pane-foot'), 'foot') }); })()`);
      assert.notEqual(m.v, "0px");
      assert.ok(m.paneBottom <= m.barTop + 0.5, `${cls}: the pane runs under the bar: ` + JSON.stringify(m));
      assert.equal(m.foot.ok, true, `${cls}: the pane's foot is covered: ` + JSON.stringify(m));
    } finally { await s.close(); }
  }
});

// ─── every other page ─────────────────────────────────────────────────────

const LAST_ROW = `(function(){ ${COMMON}
  var cb = document.querySelector('.content-body');
  cb.scrollTop = cb.scrollHeight; window.scrollTo(0, document.documentElement.scrollHeight);
  var last = document.getElementById('last-row');
  return JSON.stringify({ v: v, shown: shown, barTop: barTop, last: hit(last, 'last-row'),
    scrollX: document.documentElement.scrollWidth - innerWidth }); })()`;

for (const [w, h] of [[412, 915], [1280, 900]]) {
  test(`live @${w}x${h}: a plain page's last row scrolls clear of the bar`, async (t) => {
    if (!chrome) return t.skip("no headless Chrome");
    const s = await open(w, h, "/dashboard/plain", PLAIN_READY);
    try {
      await s.showBar();
      const m = await s.json(LAST_ROW);
      assert.equal(m.shown, true);
      assert.ok(m.last.bottom <= m.barTop + 0.5 && m.last.ok, "the last row stays under the bar: " + JSON.stringify(m));
      assert.ok(m.scrollX <= 0, "no horizontal page scroll: " + JSON.stringify(m));
    } finally { await s.close(); }
  });
}

test("live @1280x900: the test reaches the mechanism — without .main-content's padding the last row stays under the bar", async (t) => {
  if (!chrome) return t.skip("no headless Chrome");
  const s = await open(1280, 900, "/dashboard/plain", PLAIN_READY);
  try {
    await s.css(".main-content{padding-bottom:0 !important}");
    await s.showBar();
    const m = await s.json(LAST_ROW);
    assert.ok(!m.last.ok || m.last.bottom > m.barTop + 0.5, "knocked out, the last row must be covered again: " + JSON.stringify(m));
  } finally { await s.close(); }
});

test("live @412x915: the Bot Board's picker sheet and drawer, the header dropdown and the toasts sit above the bar", async (t) => {
  if (!chrome) return t.skip("no headless Chrome");
  const s = await open(412, 915, "/dashboard/plain", PLAIN_READY);
  try {
    await s.showBar();
    const m = await s.json(`(function(){ ${COMMON}
      function add(html) { var d = document.createElement('div'); d.innerHTML = html; var e = d.firstChild; document.body.appendChild(e); return e; }
      var sheet = add('<div class="bb-sheet"><div style="height:240px">sheet</div><button id="sheet-last">last</button></div>');
      var drawer = add('<div class="bb-drawer bb-open"><div style="height:2000px">drawer</div><button id="drawer-last">last</button></div>');
      drawer.scrollTop = drawer.scrollHeight;
      var dd = add('<div class="header-dropdown" style="display:block"><div style="height:120px">notifications</div></div>');
      var toasts = document.getElementById('crow-toasts');
      return JSON.stringify({ v: v, barTop: barTop,
        sheet: sheet.getBoundingClientRect().bottom, sheetLast: hit(document.getElementById('sheet-last'), 'sheet-last'),
        drawer: drawer.getBoundingClientRect().bottom, drawerLast: hit(document.getElementById('drawer-last'), 'drawer-last'),
        dropdown: dd.getBoundingClientRect().bottom, toasts: toasts.getBoundingClientRect().bottom }); })()`);
    assert.notEqual(m.v, "0px");
    for (const k of ["sheet", "drawer", "dropdown", "toasts"]) assert.ok(m[k] <= m.barTop + 0.5, `${k} runs under the bar: ` + JSON.stringify(m));
    assert.equal(m.sheetLast.ok, true, "the sheet's last control takes the tap: " + JSON.stringify(m));
    assert.equal(m.drawerLast.ok, true, "the drawer's last control takes the tap: " + JSON.stringify(m));
  } finally { await s.close(); }
});

// ─── the reserve itself, live ─────────────────────────────────────────────

test("live (I4): load() → the variable is set synchronously, in the same task, by adjustPosition", async (t) => {
  if (!chrome) return t.skip("no headless Chrome");
  const s = await open(412, 915, "/dashboard/plain", PLAIN_READY);
  try {
    const m = await s.json("(function(){ window.crowPlayer.load('/a.wav', 'Radio'); var bar = document.getElementById('crow-player-bar'); return JSON.stringify({ v: document.documentElement.style.getPropertyValue('--crow-player-h'), h: bar.offsetHeight }); })()");
    assert.ok(m.h > 0);
    assert.equal(m.v, m.h + "px", "no wait for an observer: " + JSON.stringify(m));
  } finally { await s.close(); }
});

test("live (I3): one second of playback writes the variable at most once", async (t) => {
  if (!chrome) return t.skip("no headless Chrome");
  const s = await open(412, 915, "/dashboard/plain", PLAIN_READY);
  try {
    await s.showBar();
    assert.equal(await s.until("window.crowPlayer.isPlaying() && document.getElementById('crow-audio').currentTime > 0.2"), true, "it plays");
    await s.evalIn(`(function(){ var st = document.documentElement.style, orig = st.setProperty; window.__writes = 0;
      st.setProperty = function (k) { if (k === '--crow-player-h') window.__writes++; return orig.apply(this, arguments); };
      window.__t0 = document.getElementById('crow-audio').currentTime; return 1; })()`);
    await sleep(1000);
    const m = await s.json("JSON.stringify({ writes: window.__writes, advanced: document.getElementById('crow-audio').currentTime - window.__t0, time: document.getElementById('crow-player-time').textContent })");
    assert.ok(m.advanced > 0.5, "fixture: playback really ran (progress and time ticking): " + JSON.stringify(m));
    assert.ok(m.writes <= 1, "the reserve rewrote an unchanged value on every tick: " + JSON.stringify(m));
  } finally { await s.close(); }
});

test("live (I2): Turbo visits — the variable survives one with the bar, and follows the NEW bar after a page without one", async (t) => {
  if (!chrome) return t.skip("no headless Chrome");
  const s = await open(412, 915, "/dashboard/plain", PLAIN_READY);
  try {
    assert.equal(await s.evalIn("typeof window.Turbo"), "object", "fixture: Turbo really is loaded");
    await s.showBar();
    const v = "getComputedStyle(document.documentElement).getPropertyValue('--crow-player-h').trim()";
    const barH = "document.getElementById('crow-player-bar').offsetHeight";
    await s.evalIn("window.__bar1 = document.getElementById('crow-player-bar'); Turbo.visit('/dashboard/plain?2', { action: 'replace' }); 1");
    assert.equal(await s.until("location.search === '?2' && !!document.getElementById('last-row') && document.getElementById('crow-player-bar') === window.__bar1 && !document.documentElement.hasAttribute('aria-busy')"), true);
    await sleep(300);
    assert.equal(await s.evalIn(v), (await s.evalIn(barH)) + "px", "a visit with the (permanent) bar keeps the reserve");
    assert.equal(await s.evalIn("document.getElementById('crow-player-bar').getAttribute('data-crow-player-reserve')"), "1");

    await s.evalIn("window.crowPlayer.close(); Turbo.visit('/dashboard/nobar', { action: 'replace' }); 1");
    assert.equal(await s.until("!!document.getElementById('nobar') && !document.documentElement.hasAttribute('aria-busy')"), true);
    await s.evalIn("Turbo.visit('/dashboard/plain?3', { action: 'replace' }); 1");
    assert.equal(await s.until("location.search === '?3' && !!document.getElementById('last-row') && !!document.getElementById('crow-player-bar') && !document.documentElement.hasAttribute('aria-busy')"), true);
    assert.equal(await s.evalIn("document.getElementById('crow-player-bar') !== window.__bar1"), true, "fixture: a new bar element");
    await s.evalIn(TWO_FRAMES);
    assert.equal(await s.evalIn(v), "0px", "the new bar is hidden");
    // Shown without a call into the reserve: only an observer on the NEW bar can see it.
    await s.evalIn("document.getElementById('crow-player-bar').style.display = 'block'; 1");
    await s.evalIn(TWO_FRAMES);
    const h = await s.evalIn(barH);
    assert.ok(h > 0);
    assert.equal(await s.evalIn(v), h + "px", "the reserve follows the new bar");
    const m = await s.json(LAST_ROW);
    assert.ok(m.last.ok && m.last.bottom <= m.barTop + 0.5, "and the page still clears it: " + JSON.stringify(m));
  } finally { await s.close(); }
});
