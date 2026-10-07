// Live layout check (a private headless Chrome, tests/fixtures/headless-chrome.mjs):
// a finished timer on the kiosk page, both inside the dashboard's Talk to Crow
// overlay (session mode) and on a paired display.
//
// The bug this guards: the finished timer was a full-screen layer inside the
// frame, so its close button sat in the frame's top-right corner, under the
// overlay's own close button (which always wins: it is drawn above the frame),
// and the layer covered the bird and the talk button. The only reachable
// control closed the whole overlay, and the timer came back on reopen.
//
// What is measured here, with real hit-testing:
//   - the window's close button is horizontally clear of the overlay's close
//     button (so no status-bar inset, which the frame cannot read, can bring
//     them together) and is what a tap at its centre reaches;
//   - the bird and the talk button stay visible and are what a tap reaches;
//   - one real click anywhere on the finished card dismisses it, once.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { startHeadlessChrome } from "./fixtures/headless-chrome.mjs";
import { kioskThemeCss } from "../bundles/kiosk/server/runtime.js";
import { STRINGS } from "../bundles/kiosk/server/strings.js";
import { PERCH_TOKENS } from "../servers/gateway/dashboard/shared/design-tokens.js";
import { crowTalkCss, crowTalkOverlayHtml } from "../servers/gateway/dashboard/shared/crow-talk.js";

const PUB = new URL("../bundles/kiosk/public/", import.meta.url);
let chrome = null, server = null, port = 0, CDP = "(no headless Chrome)", HOST = "127.0.0.1", available = false;

// The page under test, minus its socket: the window view alone, driven by the test.
const HARNESS = `import { createWindowView } from "/display/assets/wm-view.js";
import { STRINGS } from "/display/assets/strings.js";
window.__dismissed = [];
window.__wm = createWindowView(document.getElementById("windows"), { t: (k) => STRINGS.en[k] || k, onDismiss: (id) => window.__dismissed.push(id) });
window.__ready = true;`;

function kioskPage(session) {
  let html = readFileSync(new URL("kiosk.html", PUB), "utf8")
    .replace('<script src="/display/assets/bird-svg.js"></script>', "")
    .replace("/display/assets/kiosk.js", "/display/assets/harness.js");
  if (session) html = html.replace("<html ", '<html data-mode="session" ');
  return html;
}
const PARENT = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<style>body{margin:0}${crowTalkCss}</style></head><body>${crowTalkOverlayHtml("en")}
<script>var o=document.getElementById('crow-talk-overlay');var f=document.createElement('iframe');f.id='crow-talk-frame';f.src='/display/session';o.appendChild(f);o.classList.add('active');</script></body></html>`;

before(async () => {
  chrome = await startHeadlessChrome();
  available = !!chrome;
  if (!available) return;
  CDP = chrome.cdp; HOST = chrome.pageHost;
  server = http.createServer((req, res) => {
    const u = req.url.split("?")[0];
    const send = (type, body) => { res.writeHead(200, { "content-type": type }); res.end(body); };
    if (u === "/parent") return send("text/html", PARENT);
    if (u === "/display/session") return send("text/html", kioskPage(true));
    if (u === "/display") return send("text/html", kioskPage(false));
    if (u === "/display/assets/harness.js") return send("text/javascript", HARNESS);
    if (u === "/display/assets/theme.css") return send("text/css", kioskThemeCss(PERCH_TOKENS));
    if (u === "/display/assets/strings.js") return send("text/javascript", `export const STRINGS = ${JSON.stringify(STRINGS)};\n`);
    const m = u.match(/^\/display\/assets\/([\w.-]+\.(js|css))$/);
    if (m) { try { return send(m[2] === "js" ? "text/javascript" : "text/css", readFileSync(new URL(m[1], PUB), "utf8")); } catch {} }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, chrome.bindHost, r));
  port = server.address().port;
});
after(async () => { if (server) server.close(); if (chrome) await chrome.close(); });

async function withTab(path, { width, height }, fn) {
  const tab = await (await fetch(CDP + "/json/new?about:blank", { method: "PUT" })).json();
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
  const evalIn = async (expr) => {
    const out = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (out.exceptionDetails) throw new Error("page threw: " + JSON.stringify(out.exceptionDetails));
    return out.result.value;
  };
  const click = async (x, y) => {
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
  };
  try {
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 900 });
    await send("Page.enable");
    await send("Page.navigate", { url: `http://${HOST}:${port}${path}` });
    return await fn({ evalIn, click });
  } finally {
    ws.close();
    await fetch(CDP + "/json/close/" + tab.id).catch(() => {});
  }
}

// Runs in the top document. `W` is the kiosk window (the frame's, or the page itself on a paired display).
const MEASURE = (session) => `(async function(){
  var W = ${session ? "document.getElementById('crow-talk-frame') && document.getElementById('crow-talk-frame').contentWindow" : "window"};
  for (var i = 0; i < 100 && !(W && W.__ready && W.document.readyState === 'complete'); i++) {
    await new Promise(function(r){ setTimeout(r, 100); });
    W = ${session ? "document.getElementById('crow-talk-frame') && document.getElementById('crow-talk-frame').contentWindow" : "window"};
  }
  if (!W || !W.__ready) return { error: 'kiosk page never loaded' };
  W.__wm.apply({ action: 'open', window: { id: 'timer-1', kind: 'timer', title: 'Tea', name: 'Tea', ends_at: Date.now() + 60000, done: false } });
  W.__wm.apply({ action: 'timer_done', id: 'timer-1' });
  await new Promise(function(r){ setTimeout(r, 50); });
  var D = W.document;
  var frame = ${session ? "document.getElementById('crow-talk-frame').getBoundingClientRect()" : "{ left: 0, top: 0 }"};
  function box(el) { var r = el.getBoundingClientRect(); return { left: r.left + frame.left, top: r.top + frame.top, right: r.right + frame.left, bottom: r.bottom + frame.top, x: r.left + r.width / 2, y: r.top + r.height / 2 }; }
  function reaches(el) {
    var b = el.getBoundingClientRect(), x = b.left + b.width / 2, y = b.top + b.height / 2;
    var inner = D.elementFromPoint(x, y);
    var outer = ${session ? "document.elementFromPoint(x + frame.left, y + frame.top)" : "inner"};
    return { inner: !!inner && (inner === el || el.contains(inner)), outer: ${session ? "outer && outer.id" : "'(no overlay)'"} };
  }
  var card = D.querySelector('article.is-done'), close = card && card.querySelector('.k-win-close');
  var bird = D.getElementById('bird'), mic = D.getElementById('mic');
  var ov = document.getElementById('crow-talk-close');
  return {
    vw: innerWidth, vh: innerHeight,
    card: card && box(card), close: close && box(close), bird: box(bird), mic: box(mic),
    overlayClose: ov ? box(ov) : null,
    reachClose: close && reaches(close), reachBird: reaches(bird), reachMic: reaches(mic),
    ringing: D.documentElement.classList.contains('k-ringing'),
    hint: card && card.querySelector('.k-tap-dismiss') && card.querySelector('.k-tap-dismiss').textContent,
    cardPosition: card && W.getComputedStyle(card).position
  };
})()`;

const onScreen = (b, m) => b.right > 0 && b.bottom > 0 && b.left < m.vw && b.top < m.vh;

for (const [label, path, size] of [
  ["session overlay, phone portrait 412x915", "/parent", { width: 412, height: 915 }],
  ["session overlay, phone landscape 915x412", "/parent", { width: 915, height: 412 }],
  ["session overlay, desktop 1280x800", "/parent", { width: 1280, height: 800 }],
  ["paired wall display 800x480", "/display", { width: 800, height: 480 }],
  ["paired phone 412x915", "/display", { width: 412, height: 915 }],
]) {
  const session = path === "/parent";
  test(`live: a finished timer (${label}) — its close button is clear of the overlay's, the bird and the talk button stay reachable, one tap on the card dismisses it`, async (t) => {
    if (!available) return t.skip("no headless Chrome: " + CDP);
    await withTab(path, size, async ({ evalIn, click }) => {
      const m = await evalIn(MEASURE(session));
      assert.ok(!m.error, m.error);
      const why = JSON.stringify(m);
      assert.ok(m.card, "the finished card renders: " + why);
      assert.notEqual(m.cardPosition, "fixed", "a finished timer is not a full-screen layer");
      assert.equal(m.ringing, true, "the page tint marks a ringing timer");
      assert.equal(m.hint, STRINGS.en.timer_tap_dismiss);
      assert.ok(onScreen(m.close, m), "the window's close button is on screen: " + why);
      assert.equal(m.reachClose.inner, true, "a tap on the window's close button reaches it: " + why);
      for (const k of ["bird", "mic"]) {
        assert.ok(onScreen(m[k], m), `${k} is on screen: ${why}`);
        assert.equal(m[k === "bird" ? "reachBird" : "reachMic"].inner, true, `a tap on the ${k} reaches it (not the timer card): ${why}`);
      }
      if (session) {
        assert.equal(m.reachClose.outer, "crow-talk-frame", "the overlay's close button is not over the window's: " + why);
        assert.equal(m.reachBird.outer, "crow-talk-frame", "nor over the bird: " + why);
        assert.equal(m.reachMic.outer, "crow-talk-frame", "nor over the talk button: " + why);
        // Horizontal clearance: holds whatever top inset the phone's status bar gives the overlay's button.
        assert.ok(m.close.right < m.overlayClose.left, "the two close buttons share no column: " + why);
      }
      // One real click in the card, away from its close button, dismisses it once.
      const x = (m.card.left + m.card.right) / 2, y = (m.card.top + m.card.bottom) / 2;
      await click(x, y);
      const after = await evalIn(`(function(){var W=${session ? "document.getElementById('crow-talk-frame').contentWindow" : "window"};return { dismissed: W.__dismissed, left: W.document.querySelectorAll('article').length, ringing: W.document.documentElement.classList.contains('k-ringing') };})()`);
      assert.deepEqual(after, { dismissed: ["timer-1"], left: 0, ringing: false });
    });
  });
}
