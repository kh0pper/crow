/**
 * Queue item 17 (page half), live: typing to Crow and the one-tap voice toggle on the kiosk page —
 * the same page the dashboard's phone overlay loads in session mode.
 *
 * The REAL kiosk.js runs in a private headless Chrome against a fake WebSocket server that records
 * every frame the page sends and can push frames back at it. A private browser, so the layout cases
 * are the page's own and never another tab's; every case first clears localStorage on the test origin,
 * because those tabs do share one Chrome profile and the voice-off flag is kept per device there.
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
const WS_PATH = "/api/kiosk/session/dashboard";
const VIEWPORTS = [["phone overlay 390x800", 390, 800], ["kiosk 1024x600", 1024, 600]];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let chrome = null, server = null, wss = null, port = 0, CDP = "(no headless Chrome)", HOST = "127.0.0.1", available = false;
/** One entry per socket the page opened: the frames it sent, in arrival order. */
const conns = [];
let holdReady = false;

const sessionPage = () => readFileSync(new URL("kiosk.html", PUB), "utf8").replace("<html ", '<html data-mode="session" ');

function replyReady(c) {
  for (const m of [
    { type: "ready", server_now: Date.now(), display_config: { name: "T", lang: "en", bird: { species: "crow", seed: 0, mood: "happy" } } },
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
    const send = (type, body) => { res.writeHead(200, { "content-type": type }); res.end(body); };
    if (u === "/display/session") return send("text/html", sessionPage());
    if (u === "/display/assets/theme.css") return send("text/css", kioskThemeCss(PERCH_TOKENS));
    if (u === "/display/assets/strings.js") return send("text/javascript", `export const STRINGS = ${JSON.stringify(STRINGS)};\n`);
    if (u === "/display/assets/bird-svg.js") return send("text/javascript", readFileSync(BIRD_ENGINE, "utf8"));
    const m = u.match(/^\/display\/assets\/([\w.-]+\.(js|css))$/);
    if (m) { try { return send(m[2] === "js" ? "text/javascript" : "text/css", readFileSync(new URL(m[1], PUB), "utf8")); } catch {} }
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
        if (m.type === "hello" && !holdReady) replyReady(c);
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
const pushBinary = (bytes = 4) => conn()?.ws.send(Buffer.alloc(bytes));

// In every document, before the page's own scripts: a count of page errors, a count of AudioContexts the page
// builds (B4: a typed message must set the output up itself), and the measurement helpers.
const PAGE_HELPERS = `window.__errs = 0;
addEventListener("error", function () { window.__errs++; });
addEventListener("unhandledrejection", function () { window.__errs++; });
window.__ac = 0;
(function () {
  var AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  var Wrapped = function (opts) { window.__ac++; return new AC(opts); };
  Wrapped.prototype = AC.prototype;
  window.AudioContext = Wrapped;
})();
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
  scroll: function (sel) { var el = document.querySelector(sel); if (!el) return null; return { top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight }; }
};`;

const MEASURE = `(function () {
  var out = { vw: innerWidth, vh: innerHeight, scrollW: document.documentElement.scrollWidth, boxes: {}, hits: {}, tags: {} };
  ["#voice-btn", "#type-btn", "#mic", "#compose-text", "#compose-send", "#np-chip"].forEach(function (sel) {
    var b = __k.box(sel); if (!b) return;
    out.boxes[sel] = b; out.hits[sel] = __k.hit(sel); out.tags[sel] = __k.tag(sel);
  });
  return out;
})()`;

const BUTTONS = new Set(["#voice-btn", "#type-btn", "#mic", "#compose-send", "#np-chip"]);
const TAGS = { "#voice-btn": "BUTTON", "#type-btn": "BUTTON", "#mic": "BUTTON", "#compose-text": "INPUT", "#compose-send": "BUTTON", "#np-chip": "BUTTON" };

/** No horizontal overflow, every control clear of the others, fully on screen, big enough, and what a tap reaches. */
function layoutOk(m, width, expected, why) {
  assert.ok(m.scrollW <= width, `${why}: no horizontal overflow (${m.scrollW} > ${width})`);
  assert.deepEqual(Object.keys(m.boxes).sort(), [...expected].sort(), `${why}: the controls on screen`);
  for (const sel of expected) {
    const b = m.boxes[sel];
    assert.equal(m.tags[sel], TAGS[sel], `${why}: ${sel} is a ${TAGS[sel]}`);
    assert.ok(b.left >= 0 && b.right <= width, `${why}: ${sel} is inside the viewport width (${b.left}…${b.right})`);
    assert.ok(b.top >= 0 && b.bottom <= m.vh, `${why}: ${sel} is fully inside the viewport height (${b.top}…${b.bottom} of ${m.vh})`);
    assert.equal(m.hits[sel], true, `${why}: a tap at the centre of ${sel} reaches it`);
    if (BUTTONS.has(sel)) assert.ok(b.w >= 43.5 && b.h >= 43.5, `${why}: ${sel} covers at least 44x44 (${b.w}x${b.h})`);
  }
  const sels = Object.keys(m.boxes);
  for (let i = 0; i < sels.length; i++) {
    for (let j = i + 1; j < sels.length; j++) {
      const a = m.boxes[sels[i]], b = m.boxes[sels[j]];
      const overlap = a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      assert.equal(overlap, false, `${why}: ${sels[i]} and ${sels[j]} do not overlap`);
    }
  }
}

async function withTab(width, height, fn) {
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
  const click = async (sel) => {
    const b = await evalIn(`__k.box(${JSON.stringify(sel)})`);
    assert.ok(b, `${sel} is on the page and visible`);
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: b.x, y: b.y, button: "left", clickCount: 1 });
    return b;
  };
  const typed = async (text) => { await send("Input.insertText", { text }); };
  const url = `http://${HOST}:${port}/display/session`;
  const navRaw = async () => { await send("Page.navigate", { url }); };
  /** A socket opened by the document loaded after `from`, and its hello. */
  const waitHello = (from) => until(() => conns.length > from && conns.at(-1).frames.some((f) => f.type === "hello"));
  /** mountUi ran: ready was handled (it is what gives the bird its accessible name). */
  const waitReady = () => until(async () => (await evalIn("!!(document.getElementById('bird') && document.getElementById('bird').getAttribute('aria-label'))")));
  const nav = async () => { const from = conns.length; await navRaw(); assert.ok(await waitHello(from), "the page boots and says hello"); assert.ok(await waitReady(), "the page handles ready"); return conns.at(-1); };
  /** The common first move: one tap on #voice-btn, and the state it must show. */
  const voiceOff = async () => {
    await click("#voice-btn");
    assert.ok(await until(() => frames("voice_mode").some((f) => f.on === false)), "the page sends voice_mode off");
    assert.ok(await until(async () => (await evalIn("localStorage.getItem('crow.kiosk.voice_off')")) === "1"), "the flag is stored");
    assert.ok(await until(async () => (await evalIn("__k.vis('#compose')")) === true), "the composer opens in its place");
  };
  try {
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 900 });
    await send("Page.enable");
    await send("Page.addScriptToEvaluateOnNewDocument", { source: PAGE_HELPERS });
    // Each case starts from a clean localStorage: one Chrome profile is shared by every tab here, so a flag
    // stored by an earlier case would otherwise decide this one's boot state. Clear it on the test origin, then load.
    await navRaw();
    assert.ok(await until(async () => String(await evalIn("location.href")).startsWith(url)), "the tab is on the test origin");
    await evalIn("localStorage.clear()");
    const first = await nav();
    return await fn({ evalIn, click, typed, send, until, nav, navRaw, waitHello, waitReady, voiceOff, first });
  } finally {
    ws.close();
    await fetch(CDP + "/json/close/" + tab.id).catch(() => {});
  }
}

// ---- Plumbing (holds for the page as it is today): the real page, the fake server, a clean console ----

test("live plumbing: the real page boots in session mode — hello, ready handled, talk pill and bird up, no page error", async (t) => {
  if (!available) return t.skip("no headless Chrome: " + CDP);
  await withTab(390, 800, async ({ evalIn, first }) => {
    assert.ok(first.frames.some((f) => f.type === "hello"), "the page says hello (session mode)");
    assert.equal(first.frames.find((f) => f.type === "hello").voice_off, undefined, "voice on: the hello says nothing about voice");
    assert.equal(await evalIn("document.readyState"), "complete");
    assert.equal(await evalIn("__k.vis('#mic')"), true, "the talk pill is up");
    assert.equal(await evalIn("__k.vis('#bird')"), true);
    assert.equal(await evalIn("__k.tag('#bird')"), "BUTTON");
    assert.equal(await evalIn("document.getElementById('cap-bot').textContent"), STRINGS.en.tap_hint);
    assert.equal(await evalIn("window.__errs"), 0);
  });
});

// ---- (a) the boot state, on the phone overlay and on the kiosk ----

for (const [label, width, height] of VIEWPORTS) {
  test(`live (${label}): voice on at boot — talk pill up, composer closed, the two icon buttons in reach`, async (t) => {
    if (!available) return t.skip("no headless Chrome: " + CDP);
    await withTab(width, height, async ({ evalIn }) => {
      assert.equal(await evalIn("__k.vis('#mic')"), true);
      assert.equal(await evalIn("__k.vis('#compose')"), false, "the composer starts closed");
      assert.equal(await evalIn("__k.vis('#type-btn')"), true, "the compose opener is there");
      assert.equal(await evalIn("__k.attr('#voice-btn','data-voice')"), "on");
      assert.equal(await evalIn("__k.attr('#voice-btn','aria-label')"), STRINGS.en.voice_turn_off);
      assert.equal(await evalIn("__k.attr('#voice-btn','title')"), STRINGS.en.voice_turn_off);
      assert.equal(await evalIn("__k.attr('#type-btn','aria-label')"), STRINGS.en.type_open);
      assert.equal(await evalIn("__k.attr('#compose-text','placeholder')"), STRINGS.en.type_placeholder);
      assert.equal(await evalIn("__k.attr('#compose-text','aria-label')"), STRINGS.en.type_placeholder, "B11: the box is labelled with its placeholder");
      assert.equal((await evalIn("__k.text('#compose-send')") || "").trim(), STRINGS.en.type_send);
      await sleep(200);
      assert.deepEqual(frames("voice_mode"), [], "voice on sends no voice_mode frame");
      assert.equal(await evalIn("window.__errs"), 0);
    });
  });
}

// ---- (b) one typed message: one frame, the field cleared, the answer in the captions ----

for (const [label, width, height] of VIEWPORTS) {
  test(`live (${label}): the composer sends one text_turn, clears the field, and a blank one sends nothing`, async (t) => {
    if (!available) return t.skip("no headless Chrome: " + CDP);
    await withTab(width, height, async ({ evalIn, click, typed, until }) => {
      await click("#type-btn");
      assert.equal(await evalIn("__k.vis('#compose')"), true);
      assert.ok(await until(async () => (await evalIn("document.activeElement && document.activeElement.id")) === "compose-text"), "the field takes focus");
      assert.equal(await evalIn("__k.attr('#type-btn','aria-label')"), STRINGS.en.type_close, "the opener offers to close");

      await typed("hello crow");
      assert.equal(await evalIn("document.getElementById('compose-text').value"), "hello crow");
      await click("#compose-send");
      assert.ok(await until(() => frames("text_turn").length === 1), "one text_turn frame");
      await sleep(200);
      assert.equal(frames("text_turn").length, 1, "exactly one");
      const turn = frames("text_turn")[0];
      assert.equal(turn.text, "hello crow");
      assert.equal(typeof turn.turn_id, "string");
      assert.ok(turn.turn_id.length > 0, "with a turn id");
      assert.equal(await evalIn("document.getElementById('compose-text').value"), "", "the field is cleared");

      await click("#compose-text");
      await typed("   ");
      await click("#compose-send");
      await sleep(300);
      assert.equal(frames("text_turn").length, 1, "blank text sends nothing");

      push({ type: "transcript_final", text: "hello crow" }, { type: "caption_delta", text: "It is noon." });
      assert.ok(await until(async () => (await evalIn("__k.text('#cap-bot')")) === "It is noon."), "the answer is captioned");
      assert.equal(await evalIn("__k.text('#cap-user')"), "hello crow");
      assert.equal(await evalIn("window.__errs"), 0);
    });
  });
}

// ---- (c) the server's turn_over: the sent words come back so they can be sent again ----

test("live: turn_over busy puts the words back in the field and says it is still answering; empty puts them back too", async (t) => {
  if (!available) return t.skip("no headless Chrome: " + CDP);
  await withTab(390, 800, async ({ evalIn, click, typed, until }) => {
    await click("#type-btn");
    await typed("hello crow");
    await click("#compose-send");
    assert.ok(await until(() => frames("text_turn").length === 1));
    const busyId = frames("text_turn")[0].turn_id;
    assert.equal(await evalIn("document.getElementById('compose-text').value"), "");

    push({ type: "turn_over", turn_id: busyId, reason: "busy" });
    assert.ok(await until(async () => (await evalIn("document.getElementById('compose-text').value")) === "hello crow"), "busy: the text is back");
    assert.equal(await evalIn("__k.text('#cap-bot')"), STRINGS.en.err_turn_busy);

    await click("#compose-send");
    assert.ok(await until(() => frames("text_turn").length === 2), "the restored words can be sent again");
    const emptyId = frames("text_turn")[1].turn_id;
    assert.notEqual(emptyId, busyId, "each send gets its own turn id");
    push({ type: "turn_over", turn_id: emptyId, reason: "empty" });
    assert.ok(await until(async () => (await evalIn("document.getElementById('compose-text').value")) === "hello crow"), "empty: the text is back");
    assert.equal(await evalIn("window.__errs"), 0);
  });
});

// ---- (d) one tap turns voice off: the frame, the stored flag, the pill gone, the bird inert ----

for (const [label, width, height] of VIEWPORTS) {
  test(`live (${label}): one tap turns voice off — voice_mode, the stored flag, no talk pill, an inert bird, no audio`, async (t) => {
    if (!available) return t.skip("no headless Chrome: " + CDP);
    await withTab(width, height, async ({ evalIn, click, voiceOff, until }) => {
      await voiceOff();
      assert.equal(await evalIn("__k.vis('#mic')"), false, "the big talk pill is gone");
      assert.equal(await evalIn("__k.vis('#compose')"), true, "the composer is open");
      assert.equal(await evalIn("__k.vis('#type-btn')"), false, "the opener is not needed while the composer stays open");
      assert.equal(await evalIn("__k.attr('#voice-btn','data-voice')"), "off");
      assert.equal(await evalIn("__k.attr('#voice-btn','aria-label')"), STRINGS.en.voice_turn_on);
      assert.equal(await evalIn("__k.attr('#voice-btn','title')"), STRINGS.en.voice_turn_on);
      assert.equal(await evalIn("__k.text('#cap-bot')"), STRINGS.en.voice_off_hint);

      const starts = frames("turn_start").length;
      assert.equal(await evalIn("__k.hit('#bird')"), true, "the bird is still what a tap reaches");
      await click("#bird");
      await sleep(400);
      assert.equal(frames("turn_start").length, starts, "a tap on the bird opens no mic");
      assert.equal(frames("text_turn").length, 0, "and sends nothing typed");

      push({ type: "tts_start", codec: "pcm", sample_rate: 24000, turn_id: "t0" });
      pushBinary();
      await sleep(400);
      assert.equal(await evalIn("window.__errs"), 0, "a tts_start and audio while off throw nothing");
      assert.equal(await evalIn("__k.attr('#voice-btn','data-voice')"), "off");
      assert.equal(await evalIn("__k.text('#cap-bot')"), STRINGS.en.voice_off_hint, "and the page is still where it was");
      assert.ok(await until(async () => (await evalIn("document.readyState")) === "complete"), "the page still answers");
    });
  });
}

// ---- (e) the stored state survives a reload, and voice_mode off goes right after ready ----

test("live: a reload starts with voice off and re-sends voice_mode off right after the next ready", async (t) => {
  if (!available) return t.skip("no headless Chrome: " + CDP);
  await withTab(390, 800, async ({ evalIn, navRaw, waitHello, waitReady, until, voiceOff }) => {
    await voiceOff();
    holdReady = true;                               // the new page shows its own state before the server speaks
    const from = conns.length;
    let fresh;
    try {
      await navRaw();
      assert.ok(await waitHello(from), "the reloaded page says hello");
      fresh = conns.at(-1);
      assert.equal(fresh.frames[0].voice_off, true, "B9: the stored choice rides the hello, before the server's first line");
      assert.equal(await evalIn("localStorage.getItem('crow.kiosk.voice_off')"), "1", "the stored flag survived");
      assert.equal(await evalIn("__k.attr('#voice-btn','data-voice')"), "off", "the page starts with voice off");
      assert.equal(await evalIn("__k.vis('#mic')"), false, "and the talk pill does not come up");
      await sleep(300);
      assert.deepEqual(frames("voice_mode", fresh), [], "nothing goes before ready");
      holdReady = false;
      replyReady(fresh);
      assert.ok(await until(() => frames("voice_mode", fresh).some((f) => f.on === false)), "voice_mode off follows ready");
      const order = fresh.frames.map((f) => f.type);
      assert.equal(order[0], "hello", "hello first: " + JSON.stringify(order));
      assert.ok(order.indexOf("hello") < order.indexOf("voice_mode"), "hello then voice_mode: " + JSON.stringify(order));
      assert.equal(order.filter((x) => x === "voice_mode").length, 1, "once per ready");
    } finally { holdReady = false; }
    assert.ok(await waitReady(), "the reloaded page handles ready");
    assert.equal(await evalIn("__k.attr('#voice-btn','data-voice')"), "off");
    assert.equal(await evalIn("window.__errs"), 0);
  });
});

// ---- (e') the flag is a per-device setting: a restarted browser comes back with voice off, from localStorage alone ----

test("live: voice off survives a reload with localStorage only — the restart of a kiosk browser keeps it off", async (t) => {
  if (!available) return t.skip("no headless Chrome: " + CDP);
  await withTab(390, 800, async ({ evalIn, navRaw, waitHello, waitReady, voiceOff }) => {
    await voiceOff();
    const from = conns.length;
    await navRaw();                                 // a fresh document: nothing of the old page's memory is left
    assert.ok(await waitHello(from), "the reloaded page says hello");
    assert.ok(await waitReady(), "the reloaded page handles ready");
    assert.equal(await evalIn("localStorage.getItem('crow.kiosk.voice_off')"), "1", "the flag is in localStorage");
    assert.equal(await evalIn("sessionStorage.getItem('crow.kiosk.voice_off')"), null, "and in no per-tab place");
    assert.equal(await evalIn("__k.attr('#voice-btn','data-voice')"), "off", "the reloaded page starts with voice off");
    assert.equal(await evalIn("__k.vis('#mic')"), false, "the talk pill stays away");
    assert.equal(await evalIn("__k.vis('#compose')"), true, "the composer is open in its place");
    assert.equal(await evalIn("window.__errs"), 0);
  });
});

// ---- (f) the second tap brings voice back ----
test("live: a second tap on #voice-btn sends voice_mode on, drops the stored flag, and brings the pill back", async (t) => {
  if (!available) return t.skip("no headless Chrome: " + CDP);
  await withTab(390, 800, async ({ evalIn, click, voiceOff, until }) => {
    await voiceOff();
    await click("#voice-btn");
    assert.ok(await until(() => frames("voice_mode").some((f) => f.on === true)), "the page sends voice_mode on");
    assert.ok(await until(async () => (await evalIn("localStorage.getItem('crow.kiosk.voice_off')")) === null), "the stored flag is gone");
    assert.equal(await evalIn("__k.vis('#mic')"), true);
    assert.equal(await evalIn("__k.vis('#compose')"), false, "the composer closes again");
    assert.equal(await evalIn("__k.attr('#voice-btn','data-voice')"), "on");
    assert.equal(await evalIn("__k.text('#cap-bot')"), STRINGS.en.tap_hint, "the caption is the tap hint again");
    assert.equal(await evalIn("window.__errs"), 0);
  });
});

// ---- (g)+(h) layout and hit-testing, with the composer open and voice off, then voice on ----

for (const [label, width, height] of VIEWPORTS) {
  test(`live (${label}): composer and buttons fit without overlap and are what a tap reaches`, async (t) => {
    if (!available) return t.skip("no headless Chrome: " + CDP);
    await withTab(width, height, async ({ evalIn, click, voiceOff, until }) => {
      await voiceOff();
      layoutOk(await evalIn(MEASURE), width, ["#voice-btn", "#compose-text", "#compose-send"], `${label}, voice off with the composer open`);

      await click("#voice-btn");
      assert.ok(await until(async () => (await evalIn("__k.vis('#mic')")) === true), "the talk pill is back");
      assert.equal(await evalIn("__k.vis('#compose')"), false);
      layoutOk(await evalIn(MEASURE), width, ["#voice-btn", "#type-btn", "#mic"], `${label}, voice on`);
    });
  });
}

// ---- (i) B4: a typed message with voice on sets the reply's audio output up itself ----

test("live (B4): a typed message with voice on creates the page's AudioContext in the gesture, with no microphone", async (t) => {
  if (!available) return t.skip("no headless Chrome: " + CDP);
  await withTab(390, 800, async ({ evalIn, click, typed, until }) => {
    assert.equal(await evalIn("window.__ac"), 0, "nothing has set the output up yet");
    await click("#type-btn");
    await typed("hello crow");
    await click("#compose-send");
    assert.ok(await until(() => frames("text_turn").length === 1), "the words go");
    assert.ok(await until(async () => (await evalIn("window.__ac")) >= 1), "the reply's output exists before any tap on the bird");
    assert.equal(await evalIn("window.__errs"), 0);
  });
});

// ---- (j) B5: voice off is quiet, not stuck — a tap still cancels a slow reply ----

test("live (B5): with voice off a tap on the bird cancels a slow reply; an idle bird offers nothing to cancel", async (t) => {
  if (!available) return t.skip("no headless Chrome: " + CDP);
  await withTab(390, 800, async ({ evalIn, click, voiceOff, until }) => {
    await voiceOff();
    await click("#bird");
    await sleep(300);
    assert.deepEqual(frames("barge_in"), [], "idle and voice off: nothing to cancel");
    push({ type: "state", bird: "thinking" });
    assert.ok(await until(async () => (await evalIn("document.getElementById('bird').classList.contains('is-thinking')"))), "the server says it is thinking");
    await click("#bird");
    assert.ok(await until(() => frames("barge_in").length === 1), "the tap sends barge_in");
    assert.equal(await evalIn("__k.vis('#compose')"), true, "the composer stays up");
    assert.equal(await evalIn("window.__errs"), 0);
  });
});

// ---- (k) B1: the now-playing chip clears an open composer ----

for (const [label, width, height] of VIEWPORTS) {
  test(`live (${label}) B1: with the chip up and the composer open, the two never overlap and both are tap-reachable`, async (t) => {
    if (!available) return t.skip("no headless Chrome: " + CDP);
    await withTab(width, height, async ({ evalIn, voiceOff, until }) => {
      await voiceOff();
      // The frame the server sends for a playing item (media-view.js "load"): it makes the chip show.
      push({ type: "media", action: "load", id: "m1", url: "/display/assets/nope.mp3", title: "Morning Mix", subtitle: "Radio", source: "radio", volume: 40, muted: false, paused: false });
      assert.ok(await until(async () => (await evalIn("__k.vis('#np-chip')")) === true), "the chip is up");
      assert.match(await evalIn("__k.text('#np-chip')"), /Morning Mix/, "and it names the item");
      layoutOk(await evalIn(MEASURE), width, ["#voice-btn", "#compose-text", "#compose-send", "#np-chip"], `${label}, voice off, composer open, chip up`);
      assert.equal(await evalIn("window.__errs"), 0);
    });
  });
}

// ---- (l) B3: a very long reply caption cannot push the composer or the tools off the screen ----

const LONG_CAPTION = Array.from({ length: 18 }, (_, i) => `Sentence ${i + 1} keeps going for a while, well past what fits in the caption box at once.`).join(" ");

for (const [label, width, height] of VIEWPORTS) {
  test(`live (${label}) B3: a very long reply caption leaves the composer and the tools on screen and reachable`, async (t) => {
    if (!available) return t.skip("no headless Chrome: " + CDP);
    await withTab(width, height, async ({ evalIn, click, voiceOff, until }) => {
      assert.ok(LONG_CAPTION.length > 1400, "the caption is about 1500 characters");
      await voiceOff();
      push({ type: "transcript_final", text: "what is the plan" }, { type: "caption_delta", text: LONG_CAPTION });
      assert.ok(await until(async () => ((await evalIn("__k.text('#cap-bot')")) || "").length >= LONG_CAPTION.length), "the whole caption is on the page");
      await sleep(150);
      const cap = await evalIn("__k.scroll('#captions')");
      assert.ok(cap.height > cap.client, `the caption box scrolls instead of growing (${JSON.stringify(cap)})`);
      assert.ok(cap.top + cap.client >= cap.height - 2, `the newest text is in view (${JSON.stringify(cap)})`);
      layoutOk(await evalIn(MEASURE), width, ["#voice-btn", "#compose-text", "#compose-send"], `${label}, a very long caption, voice off with the composer open`);

      await click("#voice-btn");
      assert.ok(await until(async () => (await evalIn("__k.vis('#type-btn')")) === true), "both tool buttons are back");
      layoutOk(await evalIn(MEASURE), width, ["#voice-btn", "#type-btn", "#mic"], `${label}, a very long caption, voice on`);
      assert.equal(await evalIn("window.__errs"), 0);
    });
  });
}