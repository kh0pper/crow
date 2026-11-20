/**
 * S1a live: the kiosk page's on-screen keyboard, driven in a REAL headless Chrome.
 *
 * The REAL kiosk.js runs in a private browser against a fake WebSocket server that records every frame
 * the page sends and can push frames back at it. The page is loaded at /display/session?osk=1: the
 * explicit override is the way to force the keyboard on, because a session without the parameter gets
 * none — the phone's Talk to Crow overlay brings the phone's own keyboard (case (i)).
 *
 * The http server counts every GET of /display/assets/osk.js and /display/assets/osk.css, which is how
 * the cases pin "nothing before the first focus, then once each".
 *
 * Case (h) is the ?osk=1 force against a real key on a real keyboard; case (l) taps keys with CDP touch events,
 * the path a finger on the panel takes (the field must keep its focus and the keyboard must stay up).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { WebSocketServer } from "ws";
import { startHeadlessChrome } from "./fixtures/headless-chrome.mjs";
import { kioskThemeCss } from "../bundles/kiosk/server/runtime.js";
import { STRINGS } from "../bundles/kiosk/server/strings.js";
import { PERCH_TOKENS } from "../servers/gateway/dashboard/shared/design-tokens.js";

const PUB = new URL("../bundles/kiosk/public/", import.meta.url);
const BIRD_ENGINE = new URL("../bundles/ramble/server/bird-svg.cjs", import.meta.url);
const SESSION_PATH = "/display/session";
const WS_PATH = "/api/kiosk/session/dashboard";
const VIEWPORTS = [["phone overlay 390x800", 390, 800], ["kiosk 1024x600", 1024, 600]];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let chrome = null, server = null, wss = null, port = 0, CDP = "(no headless Chrome)", HOST = "127.0.0.1", available = false;
/** One entry per socket the page opened: the frames it sent, in arrival order. */
const conns = [];
/** GETs of the keyboard's two assets, reset before every navigation. */
const counts = { js: 0, css: 0 };
/** What the next `ready` frame carries as the display's language (case (k) turns it to "es"). */
let readyLang = "en";

const sessionPage = () => readFileSync(new URL("kiosk.html", PUB), "utf8").replace("<html ", '<html data-mode="session" ');

function replyReady(c) {
  for (const m of [
    { type: "ready", server_now: Date.now(), display_config: { name: "T", lang: readyLang, bird: { species: "crow", seed: 0, mood: "happy" } } },
    { type: "wm", action: "snapshot", windows: [] },
    { type: "state", bird: "idle" },
  ]) if (c.ws.readyState === 1) c.ws.send(JSON.stringify(m));
}

before(async () => {
  chrome = await startHeadlessChrome();
  available = !!chrome;
  if (!available) return;
  CDP = chrome.cdp; HOST = chrome.pageHost;
  server = http.createServer((req, res) => {
    const u = (req.url || "").split("?")[0];
    // The keyboard's two files are counted on every GET (a 404 counts too, so a missing asset is never
    // mistaken for "never asked for").
    const send = (type, body) => { res.writeHead(200, { "content-type": type, "cache-control": "no-store" }); res.end(body); };
    if (u === SESSION_PATH) return send("text/html", sessionPage());
    if (u === "/display/assets/theme.css") return send("text/css", kioskThemeCss(PERCH_TOKENS));
    if (u === "/display/assets/strings.js") return send("text/javascript", `export const STRINGS = ${JSON.stringify(STRINGS)};\n`);
    if (u === "/display/assets/bird-svg.js") return send("text/javascript", readFileSync(BIRD_ENGINE, "utf8"));
    const m = u.match(/^\/display\/assets\/([\w.-]+\.(js|css))$/);
    if (m) {
      if (m[1] === "osk.js") counts.js++;
      else if (m[1] === "osk.css") counts.css++;
      try { return send(m[2] === "js" ? "text/javascript" : "text/css", readFileSync(new URL(m[1], PUB), "utf8")); } catch {}
    }
    res.writeHead(404); res.end();
  });
  wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (((req.url || "").split("?")[0]) !== WS_PATH) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const c = { frames: [], ws };
      conns.push(c);
      ws.on("message", (raw, isBinary) => {
        if (isBinary) return;                       // the page's mic frames: not JSON, not recorded
        let m;
        try { m = JSON.parse(String(raw)); } catch { return; }
        c.frames.push(m);
        if (m.type === "hello") replyReady(c);
      });
    });
  });
  await new Promise((r) => server.listen(0, chrome.bindHost, r));
  port = server.address().port;
});
after(async () => { if (wss) wss.close(); if (server) server.close(); if (chrome) await chrome.close(); });

const conn = () => conns.at(-1);
const frames = (type, c = conn()) => (c ? c.frames.filter((f) => f.type === type) : []);
const push = (...ms) => { const c = conn(); for (const m of ms) if (c) c.ws.send(JSON.stringify(m)); };

// In every document, before the page's own scripts: a count of page errors and the measurement helpers
// (__k.box/vis/hit/attr/text as the page's other live tests use them), plus the keyboard's own lookups.
const PAGE_HELPERS = `window.__errs = 0;
addEventListener("error", function () { window.__errs++; });
addEventListener("unhandledrejection", function () { window.__errs++; });
window.__k = {
  vis: function (sel) {
    var el = document.querySelector(sel); if (!el) return false;
    var cs = getComputedStyle(el), r = el.getBoundingClientRect();
    return cs.display !== "none" && cs.visibility !== "hidden" && r.width > 0 && r.height > 0;
  },
  box: function (sel) {
    var el = document.querySelector(sel); if (!el || !__k.vis(sel)) return null;
    var r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height, x: r.left + r.width / 2, y: r.top + r.height / 2 };
  },
  hit: function (sel) {
    var b = __k.box(sel); if (!b) return false;
    var el = document.elementFromPoint(b.x, b.y), target = document.querySelector(sel);
    return !!el && (el === target || target.contains(el));
  },
  attr: function (sel, name) { var el = document.querySelector(sel); return el ? el.getAttribute(name) : null; },
  text: function (sel) { var el = document.querySelector(sel); return el ? el.textContent : null; },
  tag: function (sel) { var el = document.querySelector(sel); return el ? el.tagName : null; },
  osk: function () {
    return { present: !!document.getElementById("osk"), vis: __k.vis("#osk"), open: document.documentElement.classList.contains("k-osk-open") };
  },
  key: function (label) {
    var bs = [].slice.call(document.querySelectorAll("#osk button"));
    var want = String(label);
    var pick = function (fn) { return bs.filter(fn)[0] || null; };
    var hit = pick(function (x) { return (x.textContent || "").trim() === want; })
      || pick(function (x) { return (x.textContent || "").trim().toLowerCase() === want.toLowerCase(); })
      || pick(function (x) { return x.getAttribute("aria-label") === want; })
      || pick(function (x) { return String(x.getAttribute("aria-label") || "").toLowerCase() === want.toLowerCase(); });
    if (!hit) return null;
    var r = hit.getBoundingClientRect();
    return { text: (hit.textContent || "").trim(), aria: hit.getAttribute("aria-label"), left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height, x: r.left + r.width / 2, y: r.top + r.height / 2 };
  },
  keyList: function () {
    return [].slice.call(document.querySelectorAll("#osk button")).map(function (b) {
      var r = b.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
      var el = document.elementFromPoint(x, y);
      return { label: (b.textContent || "").trim() || b.getAttribute("aria-label") || "", left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height, hit: !!el && (el === b || b.contains(el)) };
    });
  }
};`;

/** Everything case (j) measures, in one round trip. */
const OSK_MEASURE = `(function () {
  var out = { vw: innerWidth, vh: innerHeight, scrollW: document.documentElement.scrollWidth, boxes: {}, hits: {}, keys: [], mic: __k.vis("#mic"), tools: [] };
  ["#osk", "#compose-text", "#compose-send", "#cap-bot", "#cap-user", "#np-chip"].forEach(function (sel) {
    var b = __k.box(sel); if (!b) return;
    out.boxes[sel] = b; out.hits[sel] = __k.hit(sel);
  });
  out.keys = __k.keyList();
  out.tools = [].slice.call(document.querySelectorAll(".k-tools button")).map(function (b) { return { id: b.id, vis: __k.vis("#" + b.id) }; });
  return out;
})()`;

async function withTab(width, height, fn, query = "?osk=1") {
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
  const until = async (pred, ms = 6000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { try { if (await pred()) return true; } catch {} await sleep(40); }
    return false;
  };
  /** A real mouse click at a point (a key's centre, a control's centre). */
  const clickAt = async (pt) => {
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: pt.x, y: pt.y, button: "left", clickCount: 1 });
  };
  const click = async (sel) => {
    const b = await evalIn(`__k.box(${JSON.stringify(sel)})`);
    assert.ok(b, `${sel} is on the page and visible`);
    await clickAt(b);
    return b;
  };
  /** One press on a key of #osk, by its label (textContent, or its aria-label for a glyph key), at its centre. */
  const press = async (label) => {
    const b = await evalIn(`__k.key(${JSON.stringify(label)})`);
    assert.ok(b, `#osk has a ${JSON.stringify(label)} key`);
    await clickAt(b);
    return b;
  };
  const typed = async (text) => { await send("Input.insertText", { text }); };
  const value = () => evalIn("document.getElementById('compose-text').value");
  const focusId = () => evalIn("document.activeElement && document.activeElement.id");
  const osk = () => evalIn("__k.osk()");
  const waitOsk = (on = true, ms = 6000) => until(async () => { const s = await evalIn("__k.osk()"); return on ? s.vis && s.open : !s.vis && !s.open; }, ms);
  const base = `http://${HOST}:${port}${SESSION_PATH}`;
  const navRaw = async (q = query) => { await send("Page.navigate", { url: base + q }); };
  /** A socket opened by the document loaded after `from`, and its hello. */
  const waitHello = (from) => until(() => conns.length > from && conns.at(-1).frames.some((f) => f.type === "hello"));
  /** mountUi ran: ready was handled (it is what gives the bird its accessible name). */
  const waitReady = () => until(async () => (await evalIn("!!(document.getElementById('bird') && document.getElementById('bird').getAttribute('aria-label'))")));
  /** Load the page (fresh asset counts) and wait until it is up. */
  const navTo = async (q = query) => {
    counts.js = 0; counts.css = 0;
    const from = conns.length;
    await navRaw(q);
    assert.ok(await waitHello(from), `the page boots and says hello (${q || "no query"})`);
    assert.ok(await waitReady(), "the page handles ready");
    return conns.at(-1);
  };
  const nav = () => navTo(query);
  try {
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 900 });
    await send("Page.enable");
    await send("Page.addScriptToEvaluateOnNewDocument", { source: PAGE_HELPERS });
    // Each case starts from a clean localStorage: one Chrome profile is shared by every tab here.
    await navRaw();
    assert.ok(await until(async () => String(await evalIn("location.href")).startsWith(base)), "the tab is on the test origin");
    await evalIn("localStorage.clear()");
    const first = await nav();
    return await fn({ evalIn, click, clickAt, press, typed, value, focusId, osk, waitOsk, send, until, nav, navTo, navRaw, waitHello, waitReady, first, base });
  } finally {
    ws.close();
    await fetch(CDP + "/json/close/" + tab.id).catch(() => {});
  }
}

/** The keyboard's two assets were fetched exactly once for this page load. */
const assetsOnce = () => {
  assert.equal(counts.js, 1, "osk.js is fetched exactly once");
  assert.equal(counts.css, 1, "osk.css is fetched exactly once");
};

// ---- (a) nothing before the first focus ----

for (const [label, width, height] of VIEWPORTS) {
  test(`live (${label}) (a): with the keyboard forced on, nothing is fetched or drawn before a field takes focus`, async (t) => {
    if (!available) return t.skip("no headless Chrome: " + CDP);
    await withTab(width, height, async ({ evalIn, osk }) => {
      assert.ok(await evalIn("document.readyState") === "complete");
      assert.equal(await evalIn("__k.vis('#type-btn')"), true, "the compose opener is there");
      assert.equal((await osk()).present, false, "no #osk is created at boot");
      assert.equal((await osk()).open, false, "and html carries no k-osk-open");
      assert.deepEqual(counts, { js: 0, css: 0 }, "osk.js and osk.css were never asked for");
      assert.equal(await evalIn("window.__errs"), 0);
    });
  });
}

// ---- (b) the composer opens → the keyboard is fetched once and shows ----

for (const [label, width, height] of VIEWPORTS) {
  test(`live (${label}) (b): opening the composer focuses the field, fetches osk.js + osk.css once each and shows #osk`, async (t) => {
    if (!available) return t.skip("no headless Chrome: " + CDP);
    await withTab(width, height, async ({ evalIn, click, until, focusId, osk, waitOsk }) => {
      await click("#type-btn");
      assert.equal(await evalIn("__k.vis('#compose')"), true, "the composer opens");
      assert.ok(await until(async () => (await focusId()) === "compose-text"), "the field takes focus");
      assert.ok(await waitOsk(true), "the on-screen keyboard comes up");
      assert.equal((await osk()).present, true, "#osk is on the page");
      assert.equal(await evalIn("document.documentElement.classList.contains('k-osk-open')"), true, "html says the keyboard is open");
      assert.equal(await evalIn("__k.attr('#compose-text', 'inputmode')"), "none", "the field asks for no native keyboard to compete with it");
      assetsOnce();
      await sleep(250);
      assetsOnce();
      assert.equal(await evalIn("window.__errs"), 0);
    });
  });
}

// ---- (c) the keys type into the field ----

for (const [label, width, height] of VIEWPORTS) {
  test(`live (${label}) (c): keys type at the caret, shift capitalises once, ?123 switches layers, space and backspace work`, async (t) => {
    if (!available) return t.skip("no headless Chrome: " + CDP);
    await withTab(width, height, async ({ evalIn, click, typed, press, value, waitOsk }) => {
      await click("#type-btn");
      assert.ok(await waitOsk(true), "the keyboard is up");

      // A letter at the caret, in the middle of the text.
      await typed("ac");
      await evalIn("(function () { var i = document.getElementById('compose-text'); i.setSelectionRange(1, 1); return i.selectionStart; })()");
      await press("b");
      assert.equal(await value(), "abc", "the letter goes in at the caret");

      // A letter over a selection.
      await evalIn("(function () { var i = document.getElementById('compose-text'); i.setSelectionRange(1, 3); return i.value; })()");
      await press("z");
      assert.equal(await value(), "az", "\"bc\" is replaced");

      // Shift: one capital, then it turns itself off.
      await press(STRINGS.en.osk_shift);
      await press("d");
      assert.equal(await value(), "azD", "shift + a letter is one capital");
      await press("e");
      assert.equal(await value(), "azDe", "and the next letter is lower case again");

      // The layer key: ?123 → symbols, whose key now reads ABC, and back.
      await press(STRINGS.en.osk_symbols);
      assert.ok(await evalIn(`!!__k.key(${JSON.stringify(STRINGS.en.osk_letters)})`), "the layer key now reads as the letters label");

      // The symbols layer deletes too, without a trip back to ABC.
      assert.ok(await evalIn(`!!__k.key(${JSON.stringify(STRINGS.en.osk_backspace)})`), "the symbols layer has its own Backspace key");
      await press(STRINGS.en.osk_backspace);
      assert.equal(await value(), "azD", "its Backspace removes one character");
      assert.ok(await evalIn(`!!__k.key(${JSON.stringify(STRINGS.en.osk_letters)})`), "and the keyboard stays on the symbols layer");

      await press(STRINGS.en.osk_letters);
      assert.ok(await evalIn(`!!__k.key(${JSON.stringify(STRINGS.en.osk_symbols)})`), "and back as the symbols label");

      // Space, then backspace.
      await press("e");
      await press(STRINGS.en.osk_space);
      assert.equal(await value(), "azDe ", "space adds a space");
      await press(STRINGS.en.osk_backspace);
      assert.equal(await value(), "azDe", "backspace removes one character");
      assert.equal(await evalIn("window.__errs"), 0);
    });
  });
}

// ---- (d) the field keeps the focus while keys are pressed ----

test("live (d): the field keeps the focus through key presses, so the caret is where the user left it", async (t) => {
  if (!available) return t.skip("no headless Chrome: " + CDP);
  await withTab(390, 800, async ({ click, press, focusId, waitOsk, evalIn }) => {
    await click("#type-btn");
    assert.ok(await waitOsk(true), "the keyboard is up");
    for (const key of ["a", STRINGS.en.osk_space, STRINGS.en.osk_backspace, STRINGS.en.osk_shift, "b"]) {
      await press(key);
      assert.equal(await focusId(), "compose-text", `the field still has the focus after "${key}"`);
    }
    assert.equal(await evalIn("window.__errs"), 0);
  });
});

// ---- (e) the keyboard's Send key sends the message and puts the keyboard away ----

for (const [label, width, height] of VIEWPORTS) {
  test(`live (${label}) (e): the Send key sends one text_turn with the typed words, clears the field and closes the keyboard`, async (t) => {
    if (!available) return t.skip("no headless Chrome: " + CDP);
    await withTab(width, height, async ({ click, typed, press, value, waitOsk, until, osk, evalIn }) => {
      await click("#type-btn");
      assert.ok(await waitOsk(true), "the keyboard is up");
      await typed("hello crow");
      await press(STRINGS.en.type_send);
      assert.ok(await until(() => frames("text_turn").length === 1), "one text_turn frame");
      await sleep(200);
      assert.equal(frames("text_turn").length, 1, "exactly one");
      assert.equal(frames("text_turn")[0].text, "hello crow", "carrying the typed words");
      assert.equal(await value(), "", "the field is cleared");
      assert.ok(await waitOsk(false), "the keyboard goes away");
      assert.equal((await osk()).open, false, "and html drops k-osk-open");
      assert.equal(await evalIn("window.__errs"), 0);
    });
  });
}

// ---- (f) the Hide key closes only the keyboard ----

test("live (f): the Hide key closes the keyboard and leaves the composer open; tapping the field brings it back", async (t) => {
  if (!available) return t.skip("no headless Chrome: " + CDP);
  await withTab(390, 800, async ({ click, press, waitOsk, evalIn }) => {
    await click("#type-btn");
    assert.ok(await waitOsk(true), "the keyboard is up");
    const hide = await evalIn(`__k.key(${JSON.stringify(STRINGS.en.type_close)})`);
    assert.ok(hide, "the keyboard has the Hide key (aria-label type_close)");
    assert.equal(hide.aria, STRINGS.en.type_close, "the Hide key is the one labelled type_close");
    await press(STRINGS.en.type_close);
    assert.ok(await waitOsk(false), "the keyboard closes");
    assert.equal(await evalIn("__k.vis('#compose')"), true, "the composer stays open");

    await click("#compose-text");
    assert.ok(await waitOsk(true), "tapping the field again brings the keyboard back");
    assert.equal(await evalIn("window.__errs"), 0);
  });
});

// ---- (g) blur closes it ----

test("live (g): when the field loses the focus the keyboard closes", async (t) => {
  if (!available) return t.skip("no headless Chrome: " + CDP);
  await withTab(390, 800, async ({ click, waitOsk, evalIn }) => {
    await click("#type-btn");
    assert.ok(await waitOsk(true), "the keyboard is up");
    await evalIn("document.getElementById('compose-text').blur()");
    assert.ok(await waitOsk(false), "blur closes the keyboard");
    assert.equal(await evalIn("__k.vis('#compose')"), true, "the composer itself stays open");
    assert.equal(await evalIn("window.__errs"), 0);
  });
});

// ---- (h) ?osk=1 forces the keyboard: a real key on a real keyboard does not take it away ----

test("live (h): with ?osk=1 a trusted keydown does not close or disable the keyboard — the parameter forces it", async (t) => {
  if (!available) return t.skip("no headless Chrome: " + CDP);
  await withTab(390, 800, async ({ click, send, waitOsk, evalIn }) => {
    await click("#type-btn");
    assert.ok(await waitOsk(true), "the keyboard is up");
    // A key that types, then keys that type nothing at all: neither closes it, and none disables it for later.
    for (const [key, code, vk] of [["a", "KeyA", 65], ["Escape", "Escape", 27], ["Shift", "ShiftLeft", 16], ["ArrowLeft", "ArrowLeft", 37]]) {
      const typing = key.length === 1;
      await send("Input.dispatchKeyEvent", { type: "keyDown", text: typing ? key : undefined, unmodifiedText: typing ? key : undefined, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
      assert.equal(await evalIn("__k.osk().open"), true, `the keyboard stays open after a physical ${key}`);
      assert.equal(await evalIn("__k.vis('#osk')"), true, `and #osk is still drawn after a physical ${key}`);
    }
    assert.equal(await evalIn("__k.attr('#compose-text', 'inputmode')"), "none", "the field still asks for no native keyboard");
    // Still wanted on the next focus too (nothing latched the keyboard off).
    await evalIn("document.getElementById('compose-text').blur()");
    await click("#compose-text");
    assert.ok(await waitOsk(true), "tapping the field keeps it up");
    assert.equal(await evalIn("window.__errs"), 0);
  });
});

// ---- (i) without the override a session page leaves the keyboard alone ----

// A session is the phone's overlay: the phone brings its own keyboard, so nothing is drawn or fetched.
test("live (i): on this session page without ?osk=1 — and with ?osk=0 — focusing the field opens nothing and fetches nothing", async (t) => {
  if (!available) return t.skip("no headless Chrome: " + CDP);
  await withTab(390, 800, async ({ click, navTo, until, evalIn, focusId, osk }) => {
    for (const q of ["", "?osk=0"]) {
      await navTo(q);
      await click("#type-btn");
      assert.ok(await until(async () => (await focusId()) === "compose-text"), `the field takes focus (${q || "no query"})`);
      await sleep(600);
      assert.equal((await osk()).present, false, `no #osk is created (${q || "no query"})`);
      assert.equal((await osk()).open, false, `html keeps no k-osk-open (${q || "no query"})`);
      assert.equal(await evalIn("__k.attr('#compose-text', 'inputmode')"), null, `the field is not marked as keyboard-less (${q || "no query"})`);
      assert.deepEqual(counts, { js: 0, css: 0 }, `osk.js and osk.css are never fetched (${q || "no query"})`);
      assert.equal(await evalIn("window.__errs"), 0);
    }
  });
});

// ---- (j) the layout with the keyboard up ----

const LONG_NP = "Morning Mix — a very long now playing title that keeps going and going past one line";

for (const [label, width, height] of VIEWPORTS) {
  test(`live (${label}) (j): with the keyboard up nothing overlaps, everything is on screen and every key is a 44 px target`, async (t) => {
    if (!available) return t.skip("no headless Chrome: " + CDP);
    await withTab(width, height, async ({ click, waitOsk, evalIn, until }) => {
      await click("#type-btn");
      assert.ok(await waitOsk(true), "the keyboard is up");
      // Both captions carry text, and the now-playing chip is forced up: they all share the screen with the keys.
      push({ type: "transcript_final", text: "what is playing" }, { type: "caption_delta", text: "Morning Mix." });
      assert.ok(await until(async () => (await evalIn("__k.text('#cap-user')")) === "what is playing"), "the user caption is up");
      await evalIn(`(function () { var c = document.getElementById('np-chip'); c.hidden = false; c.textContent = ${JSON.stringify(LONG_NP)}; return __k.vis('#np-chip'); })()`);
      await sleep(150);

      const m = await evalIn(OSK_MEASURE);
      assert.ok(m.scrollW <= width, `no horizontal overflow (${m.scrollW} > ${width})`);
      const expected = ["#osk", "#compose-text", "#compose-send", "#cap-bot", "#cap-user", "#np-chip"];
      assert.deepEqual(Object.keys(m.boxes).sort(), [...expected].sort(), "all six boxes are on screen");
      for (const sel of expected) {
        const b = m.boxes[sel];
        assert.ok(b.left >= 0 && b.right <= width, `${sel} is inside the viewport width (${b.left}…${b.right})`);
        assert.ok(b.top >= 0 && b.bottom <= m.vh, `${sel} is fully inside the viewport height (${b.top}…${b.bottom} of ${m.vh})`);
        assert.equal(m.hits[sel], true, `a tap at the centre of ${sel} reaches it`);
      }
      for (let i = 0; i < expected.length; i++) {
        for (let j = i + 1; j < expected.length; j++) {
          const a = m.boxes[expected[i]], b = m.boxes[expected[j]];
          const overlap = a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
          assert.equal(overlap, false, `${expected[i]} and ${expected[j]} do not overlap`);
        }
      }
      assert.equal(m.mic, false, "with the keyboard up the talk pill is out of the way");
      for (const tool of m.tools) assert.equal(tool.vis, false, `with the keyboard up .k-tools #${tool.id} is out of the way`);

      assert.ok(m.keys.length >= 30, `the keyboard draws its keys (${m.keys.length})`);
      // Ten letter keys cannot be 44 px wide at 390: every key is 44 px TALL at both viewports, and 44 px wide
      // at a kiosk's 1024 (32 px is what a 390 px row of ten keys leaves for each).
      const minKeyW = width >= 600 ? 43.5 : 31.5;
      for (const k of m.keys) {
        assert.ok(k.w >= minKeyW && k.h >= 43.5, `the ${JSON.stringify(k.label)} key covers ${width >= 600 ? "44x44" : "32 wide, 44 tall"} (${k.w}x${k.h})`);
        assert.equal(k.hit, true, `a tap at the centre of the ${JSON.stringify(k.label)} key reaches it`);
        assert.ok(k.left >= 0 && k.right <= width, `the ${JSON.stringify(k.label)} key is inside the viewport width (${k.left}…${k.right})`);
        assert.ok(k.top >= 0 && k.bottom <= m.vh, `the ${JSON.stringify(k.label)} key is fully on screen (${k.top}…${k.bottom} of ${m.vh})`);
      }
      assert.equal(await evalIn("window.__errs"), 0);
    });
  });
}

// ---- (k) the Spanish layout ----

test("live (k): a Spanish display gets ñ and its own Space label", async (t) => {
  if (!available) return t.skip("no headless Chrome: " + CDP);
  readyLang = "es";
  try {
    await withTab(390, 800, async ({ click, waitOsk, evalIn }) => {
      await click("#type-btn");
      assert.ok(await waitOsk(true), "the keyboard is up");
      assert.ok(await evalIn(`!!__k.key("ñ")`), "the Spanish keyboard has a ñ key");
      assert.equal(await evalIn(`!!__k.key("n")`), true, "and its plain n");
      const space = await evalIn(`__k.key(${JSON.stringify(STRINGS.es.osk_space)})`);
      assert.ok(space, "the space key is labelled with osk_space (es)");
      const lower = (v) => String(v || "").toLowerCase();
      assert.ok([space.text, space.aria].some((v) => lower(v) === lower(STRINGS.es.osk_space)), `the space key reads ${JSON.stringify(STRINGS.es.osk_space)}`);
      if (STRINGS.en.osk_space !== STRINGS.es.osk_space) {
        assert.ok(![space.text, space.aria].some((v) => lower(v) === lower(STRINGS.en.osk_space)), "and not the English label");
      }
      assert.equal(await evalIn("window.__errs"), 0);
    });
  } finally { readyLang = "en"; }
});

// ---- (l) a finger on a key: the letter lands, the field keeps the focus and the keyboard stays ----

for (const [label, width, height] of VIEWPORTS) {
  test(`live (${label}) (l): a touch tap on a key types, keeps the field focused and keeps the keyboard up`, async (t) => {
    if (!available) return t.skip("no headless Chrome: " + CDP);
    await withTab(width, height, async ({ click, send, until, evalIn, focusId, value, waitOsk }) => {
      await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
      await click("#type-btn");
      assert.ok(await waitOsk(true), "the keyboard is up");
      assert.equal(await focusId(), "compose-text", "the field has the focus");
      /** One finger: down and up on a point, the way a tap on a touchscreen arrives. */
      const tap = async (at) => {
        await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: at.x, y: at.y, id: 1, radiusX: 4, radiusY: 4, force: 1 }] });
        await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      };
      const a = await evalIn(`__k.key("a")`);
      assert.ok(a, "the a key is on the page");
      await tap(a);
      assert.ok(await until(async () => (await value()) === "a"), "the tapped letter lands in the field");
      const space = await evalIn(`__k.key(${JSON.stringify(STRINGS.en.osk_space)})`);
      assert.ok(space, "the space key is on the page");
      await tap(space);
      assert.ok(await until(async () => (await value()) === "a "), "and a second tap types again");
      assert.equal(await evalIn("__k.osk().open"), true, "the keyboard stays open through a touch tap");
      assert.equal(await evalIn("__k.vis('#osk')"), true, "and #osk is still drawn");
      assert.equal(await focusId(), "compose-text", "the field still has the focus: no tap on a key stole it");
      assert.equal(await evalIn("window.__errs"), 0);
    });
  });
}