/**
 * The player bar and the layers around it, in a REAL browser (queue item 21 follow-up, 2026-10-20).
 *
 *  1. Modals cover the bar. The model-catalog, contacts and extensions modals used z-index 1000, the
 *     bar's own; the bar is later in the DOM, so it painted over their backdrops. Every full-screen
 *     layer now sits on player.js Z.modal (tests/dashboard-overlay-z-index.test.js guards the scale);
 *     here each one's REAL rules (read from its source) are put on a page with the bar showing, and a
 *     tap where the bar is lands on the backdrop. Knocked back to 1000, the bar wins again.
 *  2. The keyboard. With the on-screen keyboard open in the Android app the bar sat ~60 px above the
 *     composer. On a touch screen, while a text field has focus AND the viewport has shrunk (the
 *     keyboard), the bar hides and --crow-player-h drops to 0px; it comes back on blur or when the
 *     keyboard closes; the audio never pauses. A desktop (no coarse pointer) never hides it.
 *
 * Harness: tests/player-bar-reserve-live.test.js (the real renderLayout + perchHubPanel, the bar and
 * its script added the way dashboard/index.js adds them, real Turbo, real playback, private headless
 * Chrome). The keyboard is simulated the way the app's WebView meets it: the viewport height shrinks.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startHeadlessChrome } from "./fixtures/headless-chrome.mjs";
import { rulesFor } from "./fixtures/fixed-overlays.mjs";

// The bot engine is READY in this fixture (see perch-phone-layout.test.js): no "engine not installed" banner.
process.env.PIBOT_PI_CLI = "/nonexistent/pi-never-spawned-by-this-file.js";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const SID = "perchlive-7a2e91c4";
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
async function open(w, h, path, ready, init = "") {
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
  // A phone has a touch screen: (pointer: coarse), what the keyboard rule keys on. A desktop tab does not.
  if (w < 900) await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await send("Page.enable");
  if (init) await send("Page.addScriptToEvaluateOnNewDocument", { source: init });
  await send("Page.navigate", { url: `http://${HOST}:${port}${path}` });
  assert.equal(await until(ready), true, "the page never reached its ready state: " + ready);
  // Hermetic: the player persists its item in this origin's localStorage; start every tab with the bar hidden.
  await evalIn("(function(){ try { localStorage.clear(); } catch (e) {} var b = document.getElementById('crow-player-bar'); if (b && b.style.display !== 'none') window.crowPlayer.close(); return 1; })()");
  await evalIn(TWO_FRAMES);
  return {
    send, evalIn, until,
    /** Resize the viewport the way the Android app does when the on-screen keyboard opens (the WebView's
     *  window shrinks: innerHeight and the visual viewport both drop). */
    viewport: async (vw, vh, screen) => { await send("Emulation.setDeviceMetricsOverride", { width: vw, height: vh, deviceScaleFactor: 2, mobile: vw < 900, ...(screen || {}) }); await evalIn(TWO_FRAMES); },
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


// ─── 1. modals cover the bar ───────────────────────────────────────────────

/** Each layer that covers the page: its source file, selector, and how its page shows it. */
const MODALS = [
  ["servers/gateway/dashboard/panels/model-catalog.js", "#mcat-modal-overlay"],
  ["servers/gateway/dashboard/panels/contacts/css.js", ".import-modal-backdrop"],
  ["servers/gateway/dashboard/panels/extensions/css.js", "#modal-overlay"],
  ["servers/gateway/dashboard/panels/bot-builder/css.js", "#engine-gate-modal-overlay"],
  ["servers/gateway/dashboard/panels/messages/css.js", ".bot-dir-modal"],
  ["servers/gateway/dashboard/perch-hub/css.js", "#perch-browse-modal"],
  ["servers/gateway/dashboard/panels/bot-builder/css.js", ".btb-give"],
  ["servers/gateway/dashboard/panels/bot-board/css.js", ".bb-give"],
];

/** Put the layer (its real rules) on the page, shown the way its client shows it (display:flex), inside the
 *  page content where panels render it: earlier in the DOM than the bar, which the layout adds after it. */
function mountModal(file, sel) {
  const css = rulesFor(file, sel);
  assert.ok(css.includes("position"), "fixture: found the rules for " + sel);
  const attr = sel.startsWith("#") ? `el.id=${JSON.stringify(sel.slice(1))};` : `el.className=${JSON.stringify(sel.slice(1))};`;
  return `(function(){var s=document.createElement('style');s.textContent=${JSON.stringify(css)};document.head.appendChild(s);
    var el=document.createElement('div');${attr}el.setAttribute('data-test-modal','1');el.style.display='flex';
    (document.querySelector('.content-body') || document.body).appendChild(el);return 1;})()`;
}
const HIT_BAR = `(function(){ var bar=document.getElementById('crow-player-bar'); var b=bar.getBoundingClientRect();
  var t=document.elementFromPoint(b.left+b.width/2, b.top+b.height/2);
  return JSON.stringify({ shown: bar.style.display!=='none' && b.height>0, inBar: !!t && !!t.closest('#crow-player-bar'),
    onModal: !!t && !!t.closest('[data-test-modal]'), at: t ? (t.id || t.className || t.tagName) : null }); })()`;

for (const [w, h] of [[412, 915], [1280, 900]]) {
  test(`live @${w}x${h}: every modal and sheet backdrop covers the player bar`, async (t) => {
    if (!chrome) return t.skip("no headless Chrome");
    const s = await open(w, h, "/dashboard/plain", PLAIN_READY);
    try {
      await s.showBar();
      for (const [file, sel] of MODALS) {
        await s.evalIn("document.querySelectorAll('[data-test-modal]').forEach(function(e){e.remove();}); 1");
        await s.evalIn(mountModal(file, sel));
        await s.evalIn(TWO_FRAMES);
        const m = await s.json(HIT_BAR);
        assert.equal(m.shown, true, sel + ": fixture, the bar shows");
        assert.equal(m.inBar, false, `${sel} (${file}): the bar paints over the backdrop: ` + JSON.stringify(m));
        assert.equal(m.onModal, true, `${sel}: a tap where the bar is lands on the backdrop: ` + JSON.stringify(m));
      }
    } finally { await s.close(); }
  });
}

test("live @412x915: the test reaches the mechanism — a modal knocked back to the bar's z-index 1000 is painted over", async (t) => {
  if (!chrome) return t.skip("no headless Chrome");
  const s = await open(412, 915, "/dashboard/plain", PLAIN_READY);
  try {
    await s.showBar();
    await s.evalIn(mountModal("servers/gateway/dashboard/panels/extensions/css.js", "#modal-overlay"));
    await s.css("#modal-overlay{z-index:1000 !important}");
    await s.evalIn(TWO_FRAMES);
    const m = await s.json(HIT_BAR);
    assert.equal(m.inBar, true, "at an equal z-index the later bar wins: " + JSON.stringify(m));
  } finally { await s.close(); }
});

// ─── 2. the on-screen keyboard ─────────────────────────────────────────────

const KB = `(function(){ var bar=document.getElementById('crow-player-bar'); var a=document.getElementById('crow-audio');
  var cs=getComputedStyle(bar); var send=document.getElementById('perch-send').getBoundingClientRect();
  return JSON.stringify({ visible: cs.display!=='none' && bar.getBoundingClientRect().height>0, inline: bar.style.display,
    v: getComputedStyle(document.documentElement).getPropertyValue('--crow-player-h').trim(), barH: bar.offsetHeight,
    paused: a.paused, t: a.currentTime, vh: innerHeight, sendBottom: send.bottom,
    focused: document.activeElement && document.activeElement.id, coarse: matchMedia('(pointer: coarse)').matches }); })()`;
const FOCUS = "(function(){ document.getElementById('perch-input').focus(); return document.activeElement.id; })()";
const BLUR = "(function(){ document.activeElement.blur(); return 1; })()";
const KEYBOARD = 300;   // the on-screen keyboard's height, in CSS px

test("live @412x915: a focused composer with the keyboard open hides the bar and frees its space; blur brings it back; the audio plays on", async (t) => {
  if (!chrome) return t.skip("no headless Chrome");
  const s = await open(412, 915, PERCH, PERCH_READY);
  try {
    await s.showBar();
    assert.equal(await s.until("!document.getElementById('crow-audio').paused && document.getElementById('crow-audio').currentTime > 0"), true, "fixture: playing");
    const m0 = await s.json(KB);
    assert.equal(m0.coarse, true, "fixture: a touch screen");
    assert.equal(m0.visible, true);
    assert.equal(m0.v, m0.barH + "px");

    // Focus alone (a hardware keyboard, or the keyboard not up yet): the bar stays.
    assert.equal(await s.evalIn(FOCUS), "perch-input");
    await s.evalIn(TWO_FRAMES);
    const m1 = await s.json(KB);
    assert.equal(m1.visible, true, "focus without a keyboard keeps the bar: " + JSON.stringify(m1));
    assert.equal(m1.v, m1.barH + "px");

    // The keyboard opens: the WebView's viewport shrinks.
    await s.viewport(412, 915 - KEYBOARD);
    const m2 = await s.json(KB);
    assert.equal(m2.focused, "perch-input", "fixture: still typing");
    assert.equal(m2.visible, false, "keyboard open: the bar is hidden: " + JSON.stringify(m2));
    assert.equal(m2.v, "0px", "keyboard open: the reserve is 0px: " + JSON.stringify(m2));
    assert.ok(Math.abs((m2.vh - m2.sendBottom) - (m0.vh - m0.sendBottom - m0.barH)) <= 1,
      "the composer takes the bar's old room (the space under Send shrinks by the bar's height): " + JSON.stringify({ m0, m2 }));
    assert.ok(m2.inline !== "none", "the player's own state is untouched (shown): " + JSON.stringify(m2));
    await sleep(400);
    const m3 = await s.json(KB);
    assert.equal(m3.paused, false, "the audio keeps playing while the bar is hidden");
    assert.ok(m3.t > m2.t, "and keeps advancing: " + JSON.stringify({ m2, m3 }));

    // Blur (Send, a tap outside): the bar comes back at once, the reserve with it.
    await s.evalIn(BLUR);
    await s.evalIn(TWO_FRAMES);
    const m4 = await s.json(KB);
    assert.equal(m4.visible, true, "blurred: the bar is back: " + JSON.stringify(m4));
    assert.equal(m4.v, m4.barH + "px", "blurred: the reserve is back");
    assert.equal(m4.paused, false);

    // The keyboard closes with focus kept (Android's back key): the bar comes back too.
    await s.viewport(412, 915);
    await s.evalIn(FOCUS);
    await s.viewport(412, 915 - KEYBOARD);
    assert.equal((await s.json(KB)).visible, false, "fixture: hidden again");
    await s.viewport(412, 915);
    const m5 = await s.json(KB);
    assert.equal(m5.focused, "perch-input");
    assert.equal(m5.visible, true, "keyboard closed, focus kept: the bar is back: " + JSON.stringify(m5));
    assert.equal(m5.v, m5.barH + "px");
    assert.equal(m5.paused, false);
  } finally { await s.close(); }
});

test("live @412x915: rotating with the keyboard open keeps the bar hidden (the tallest height is kept per width, i.e. per orientation)", async (t) => {
  if (!chrome) return t.skip("no headless Chrome");
  const s = await open(412, 915, PERCH, PERCH_READY);
  const PORTRAIT = { screenWidth: 412, screenHeight: 915, screenOrientation: { type: "portraitPrimary", angle: 0 } };
  const LANDSCAPE = { screenWidth: 915, screenHeight: 412, screenOrientation: { type: "landscapePrimary", angle: 90 } };
  const KB_LAND = 200;  // a landscape keyboard leaves ~210 px of page
  try {
    await s.viewport(412, 915, PORTRAIT);
    await s.showBar();
    await s.evalIn(FOCUS);
    await s.viewport(412, 915 - KEYBOARD, PORTRAIT);
    assert.equal((await s.json(KB)).visible, false, "fixture: portrait, keyboard up, hidden");

    // Rotate with the keyboard still up: landscape was never seen at full height.
    await s.viewport(915, 412 - KB_LAND, LANDSCAPE);
    const m1 = await s.json(KB);
    assert.equal(await s.evalIn("screen.orientation.type"), "landscape-primary", "fixture: the emulated screen rotated");
    assert.equal(m1.focused, "perch-input");
    assert.equal(m1.visible, false, "rotated with the keyboard up: still hidden: " + JSON.stringify(m1));
    assert.equal(m1.v, "0px");

    // The keyboard closes in landscape: back; it opens again: hidden.
    await s.viewport(915, 412, LANDSCAPE);
    assert.equal((await s.json(KB)).visible, true, "landscape, keyboard closed: the bar is back");
    await s.viewport(915, 412 - KB_LAND, LANDSCAPE);
    assert.equal((await s.json(KB)).visible, false, "landscape, keyboard up again: hidden");

    // Rotate back with the keyboard up: portrait's tallest height was kept.
    await s.viewport(412, 915 - KEYBOARD, PORTRAIT);
    const m2 = await s.json(KB);
    assert.equal(m2.visible, false, "back to portrait with the keyboard up: hidden: " + JSON.stringify(m2));
    assert.equal(m2.paused, false, "the audio plays on through it all");

    await s.evalIn(BLUR);
    await s.evalIn(TWO_FRAMES);
    const m3 = await s.json(KB);
    assert.equal(m3.visible, true);
    assert.equal(m3.v, m3.barH + "px");
  } finally { await s.close(); }
});

test("live @412x915: the keyboard alone (nothing focused, e.g. a page that resized) never hides the bar", async (t) => {
  if (!chrome) return t.skip("no headless Chrome");
  const s = await open(412, 915, PERCH, PERCH_READY);
  try {
    await s.showBar();
    await s.viewport(412, 915 - KEYBOARD);
    const m = await s.json(KB);
    assert.equal(m.visible, true, JSON.stringify(m));
    assert.equal(m.v, m.barH + "px");
  } finally { await s.close(); }
});

test("live @1280x900: on a desktop focus and a shorter window change nothing", async (t) => {
  if (!chrome) return t.skip("no headless Chrome");
  const s = await open(1280, 900, PERCH, PERCH_READY);
  try {
    await s.showBar();
    const m0 = await s.json(KB);
    assert.equal(m0.coarse, false, "fixture: a mouse, not a touch screen");
    await s.evalIn(FOCUS);
    await s.viewport(1280, 900 - KEYBOARD);
    const m1 = await s.json(KB);
    assert.equal(m1.focused, "perch-input");
    assert.equal(m1.visible, true, "desktop: the bar stays: " + JSON.stringify(m1));
    assert.equal(m1.v, m1.barH + "px");
  } finally { await s.close(); }
});
