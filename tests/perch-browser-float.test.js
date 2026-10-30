// The floating browser preview (brief 2026-10-29): the live tile's
// YouTube-style mini player once it scrolls away.
//
// The tile snippet (browser-tile.js) and the float snippet (browser-float.js)
// run together in a vm sandbox with the hub's shared-scope helpers, as in
// perch-browser-tile.test.js: a fake IntersectionObserver says what is on
// screen, fetch and setTimeout are recorded and driven by hand.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { perchHubJs } from "../servers/gateway/dashboard/perch-hub/client.js";
import { perchBrowserTileJs } from "../servers/gateway/dashboard/perch-hub/browser-tile.js";
import { perchBrowserFloatJs } from "../servers/gateway/dashboard/perch-hub/browser-float.js";
import { translations } from "../servers/gateway/dashboard/shared/i18n.js";

const SID = "perchlive-aaaaaaaa";
const API = "/dashboard/perch-api";
const B64 = "/9j/4AAQSkZJRg==";

// ---------------------------------------------------------------------------
// a small DOM
// ---------------------------------------------------------------------------
function makeEl(tag, doc) {
  const attrs = {};
  const node = {
    tagName: String(tag || "div").toUpperCase(), children: [], parentNode: null,
    className: "", textContent: "", hidden: false, disabled: false, type: "", onclick: null, id: "",
    style: {}, scrollTop: 0, scrollHeight: 0, alt: "", offsetWidth: 156, offsetHeight: 140,
    appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); this.children.push(c); c.parentNode = this; return c; },
    insertBefore(c, ref) {
      if (c.parentNode) c.parentNode.removeChild(c);
      const i = ref ? this.children.indexOf(ref) : -1;
      if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
      c.parentNode = this; return c;
    },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; },
    contains(x) { for (let n = x; n; n = n.parentNode) if (n === this) return true; return false; },
    focus() { doc.activeElement = node; },
    setAttribute(k, v) { attrs[k] = String(v); if (k === "src") node._src = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null; },
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(attrs, k); },
    removeAttribute(k) { delete attrs[k]; if (k === "src") node._src = ""; },
  };
  Object.defineProperty(node, "src", { get() { return node._src || ""; }, set(v) { node._src = String(v); }, enumerable: true });
  Object.defineProperty(node, "innerHTML", { set() { throw new Error("innerHTML sink reached"); }, get() { return ""; } });
  return node;
}
function walk(n, fn) { fn(n); for (const c of n.children) walk(c, fn); }
function byClass(n, cls) { const o = []; walk(n, (x) => { if (String(x.className || "").split(/\s+/).includes(cls)) o.push(x); }); return o; }
const one = (n, cls) => byClass(n, cls)[0];
const tick = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

function mount({ innerWidth = 390, innerHeight = 800, stored, storageThrows = false, composerRect, tabsRect, shellTabsRect } = {}) {
  const ios = [];
  class FakeIO {
    constructor(cb) { this.cb = cb; this.nodes = new Set(); ios.push(this); }
    observe(n) { this.nodes.add(n); }
    unobserve(n) { this.nodes.delete(n); }
    disconnect() { this.nodes.clear(); }
  }
  const calls = [];
  const fetchFn = (url, opts) => {
    let resolve, reject;
    const p = new Promise((res, rej) => { resolve = res; reject = rej; });
    const c = { url: String(url), opts: opts || {}, resolve, reject, settled: false };
    if (opts && opts.signal) opts.signal.addEventListener("abort", () => { if (!c.settled) { c.settled = true; c.aborted = true; reject(new Error("AbortError")); } });
    calls.push(c);
    return p;
  };
  const timers = new Map(); let tseq = 1;
  const events = [];
  const handlers = {};
  const docT = new EventTarget();
  const doc = { visibilityState: "visible", cookie: "crow_csrf=tok-123", activeElement: null };
  doc.createElement = (t) => makeEl(t, doc);
  doc.addEventListener = (...a) => docT.addEventListener(...a);
  doc.dispatchEvent = (ev) => { events.push(ev); return docT.dispatchEvent(ev); };
  const root = makeEl("div", doc);
  const transcript = makeEl("div", doc);
  const input = makeEl("textarea", doc);
  const composer = makeEl("div", doc);
  composer.getBoundingClientRect = () => composerRect || { top: 700, left: 0, width: innerWidth, height: 100 };
  const tabs = makeEl("nav", doc);
  tabs.getBoundingClientRect = () => tabsRect || { top: 0, left: 0, width: 0, height: 0 };
  const shellTabs = makeEl("nav", doc);
  shellTabs.getBoundingClientRect = () => shellTabsRect || { top: 0, left: 0, width: 0, height: 0 };
  doc.querySelector = (sel) => (sel === ".shell-tabs" ? shellTabs : null);
  root.appendChild(transcript); root.appendChild(composer); composer.appendChild(input);
  doc.body = root;
  const store = new Map();
  if (stored !== undefined) store.set("crow-perch-bfloat-pos", stored);
  const localStorage = storageThrows
    ? { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } }
    : { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); } };
  const HUB = { streams: {} };
  const ids = { "perch-transcript": transcript, "perch-hub-root": root, "perch-composer": composer, "perch-input": input, "perch-tabs": tabs };
  const sandbox = {
    console, document: doc, window: { innerWidth, innerHeight, localStorage }, API, HUB,
    current: { sid: SID },
    el: (id) => ids[id] || (id === "perch-bfloat" ? byClass(root, "ph-bfloat")[0] || null : null),
    live: () => !sandbox.__retired,
    bindOnce: (target, type, key, fn) => { handlers[key] = fn; },
    csrf: () => "tok-123",
    perchApi: () => Promise.resolve({ ok: true, j: {} }),
    line: (cls, text) => { const d = makeEl("div", doc); if (cls) d.className = cls; d.textContent = text == null ? "" : String(text); return d; },
    fetch: fetchFn,
    setTimeout: (fn, ms) => { const id = tseq++; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    IntersectionObserver: FakeIO,
    AbortController, CustomEvent, Event, Date, Math, JSON, encodeURIComponent, Number, String,
    __export(api) { sandbox.api = api; },
  };
  vm.createContext(sandbox);
  vm.runInContext(`(function(){\n${perchBrowserTileJs("en")}\n${perchBrowserFloatJs("en")}\n;__export({ browserFrame: browserFrame, resetBrowserTiles: resetBrowserTiles, retireBrowserTiles: retireBrowserTiles, bfClamp: bfClamp, bfResize: bfResize, bf: bf });\n})();`, sandbox);
  const frames = () => calls.filter((c) => c.url.includes("/browser/frame"));
  const pending = () => frames().filter((c) => !c.settled);
  const respond = async (c, status, body) => {
    c.settled = true;
    c.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });
    await tick();
  };
  const show = async (node, on = true) => { ios[ios.length - 1].cb([{ target: node, isIntersecting: on }]); await tick(); };
  const float = () => byClass(root, "ph-bfloat")[0] || null;
  const floating = () => { const f = float(); return !!f && !f.hidden && f.getAttribute("data-leaving") !== "1"; };
  const runTimers = (ms) => { for (const [id, x] of [...timers.entries()]) if (x.ms === ms) { timers.delete(id); x.fn(); } };
  const setVisible = async (v) => { doc.visibilityState = v ? "visible" : "hidden"; handlers.btVisibility(); await tick(); };
  return { sandbox, api: sandbox.api, doc, root, transcript, input, calls, frames, pending, respond, show, float, floating, timers, runTimers, events, handlers, HUB, store, setVisible };
}

async function liveTile(h, anchor = "call_1", domain = "example.com") {
  h.api.browserFrame({ type: "browser", phase: "live", anchor, domain, gen: 3 });
  await tick();
  return byClass(h.transcript, "ph-btile").find((x) => x.getAttribute("data-anchor") === (anchor || ""));
}
function done(h, anchor) {
  h.api.browserFrame({ type: "browser", phase: "done", anchor, domain: "example.com", shot: null, note: null });
}

// ---------------------------------------------------------------------------
// static shape
// ---------------------------------------------------------------------------
test("the float snippet: no backtick or stray ${, no HTML sink, spliced between the tile and the Take over sheet", () => {
  for (const lang of ["en", "es"]) {
    const js = perchBrowserFloatJs(lang);
    assert.equal(js.includes("`"), false);
    assert.equal(js.includes("${"), false);
    assert.ok(!/\.innerHTML\s*\+?=|\.outerHTML\s*\+?=|insertAdjacentHTML\s*\(|document\.write\s*\(/.test(js), "no HTML sink");
    const hub = perchHubJs(lang);
    const at = hub.indexOf(js);
    assert.ok(at > 0, "spliced verbatim");
    assert.ok(hub.indexOf(perchBrowserTileJs(lang)) < at, "after the tile (it uses the tile's scope)");
    assert.doesNotThrow(() => new Function(hub), lang + " hub parses");
  }
  const src = readFileSync(new URL("../servers/gateway/dashboard/perch-hub/browser-float.js", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("return `") + 8, src.lastIndexOf("`;"));
  assert.equal(/`/.test(body), false);
  assert.equal((body.match(/\$\{/g) || []).length, (body.match(/\$\{tJs\("/g) || []).length, "the only ${ are tJs interpolations");
  for (const k of new Set([...src.matchAll(/tJs\("([^"]+)"/g)].map((m) => m[1]))) assert.ok(translations[k]?.en && translations[k]?.es, k);
  const want = {
    "perch.browserFloatLabel": ["Browser preview", "Vista previa del navegador"],
    "perch.browserFloatExpand": ["Full screen", "Pantalla completa"],
    "perch.browserFloatClose": ["Close preview", "Cerrar vista previa"],
    "perch.browserFloatExit": ["Exit full screen", "Salir de pantalla completa"],
  };
  for (const [k, [en, es]] of Object.entries(want)) { assert.equal(translations[k].en, en); assert.equal(translations[k].es, es); }
  assert.ok(perchBrowserFloatJs("es").includes("Salir de pantalla completa"));
});

test("the hub's one resize listener clamps the float", () => {
  const hub = perchHubJs("en");
  assert.match(hub, /bindOnce\(window,'resize','narrowResize',function\(\)\{[^\n]*bfResize\(\);/);
});

test("the CSS: tokens only, 44 px targets, hidden wins, a reduced-motion version, under the Take over sheet", async () => {
  const { perchHubCss } = await import("../servers/gateway/dashboard/perch-hub/css.js");
  const css = perchHubCss();
  const block = css.slice(css.indexOf("#perch-hub-root .ph-bfloat{"), css.lastIndexOf(".ph-bfloat") + 200);
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(block), "no literal colours");
  assert.match(block, /\.bf-grow,#perch-hub-root \.ph-bfloat \.bf-close\{[^}]*width:44px;height:44px/);
  assert.match(block, /\.bf-bar button\{min-height:44px;min-width:44px/);
  assert.match(block, /\.ph-bfloat\[hidden\],#perch-hub-root \.ph-bfloat \[hidden\]\{display:none\}/);
  assert.match(block, /prefers-reduced-motion:reduce\)\{#perch-hub-root \.ph-bfloat\{transition:none;animation:none\}/);
  assert.match(block, /\.ph-bfloat\{position:fixed;[^}]*z-index:1100/);
  assert.match(block, /\[data-expanded="1"\]\{[^}]*z-index:1250/, "full screen under the Take over sheet (1300)");
  assert.match(block, /width:min\(40vw,320px\)/);
});

// ---------------------------------------------------------------------------
// the state machine
// ---------------------------------------------------------------------------
test("live + off screen floats; back on screen goes home; done fades back; never before the observer reports", async () => {
  const h = mount();
  const t = await liveTile(h, "call_1", "<b>shop</b>.example");
  assert.equal(h.floating(), false, "the observer has not reported yet: no flash on creation");
  await h.show(t, true);
  assert.equal(h.floating(), false, "on screen: inline only");
  await h.show(t, false);
  assert.equal(h.floating(), true, "scrolled away while live: the mini player");
  const f = h.float();
  assert.equal(f.parentNode, h.root, "in #perch-hub-root");
  assert.equal(one(f, "bf-host").textContent, "<b>shop</b>.example", "textContent");
  assert.equal(f.getAttribute("aria-label"), "Browser preview · <b>shop</b>.example");
  assert.ok(one(f, "bf-dot"));
  assert.equal(f.style.left, (390 - 156 - 12) + "px", "bottom right");
  assert.equal(f.style.top, (700 - 140 - 12) + "px", "above the composer");
  for (const cls of ["bf-frame", "bf-grow", "bf-close", "bf-take", "bf-exit"]) {
    const b = one(f, cls);
    assert.equal(b.tagName, "BUTTON", cls); assert.equal(b.type, "button", cls);
  }
  assert.equal(one(f, "bf-grow").getAttribute("aria-label"), "Full screen");
  assert.equal(one(f, "bf-close").getAttribute("aria-label"), "Close preview");
  // back into view: home (a fade, then hidden)
  await h.show(t, true);
  assert.equal(h.floating(), false);
  assert.equal(f.getAttribute("data-leaving"), "1", "fading");
  h.runTimers(200);
  assert.equal(f.hidden, true);
  // away again, then the turn ends: no floating done tile
  await h.show(t, false);
  assert.equal(h.floating(), true);
  assert.equal(f.getAttribute("data-leaving"), null, "a re-show cancels the fade");
  done(h, "call_1"); await tick();
  assert.equal(h.floating(), false, "done: back into the transcript");
  await h.show(t, false);
  assert.equal(h.floating(), false, "a done tile never floats");
});

test("× closes it for this turn only", async () => {
  const h = mount();
  const t = await liveTile(h, "call_1");
  await h.show(t, false);
  assert.equal(h.floating(), true);
  one(h.float(), "bf-close").focus();
  one(h.float(), "bf-close").onclick();
  assert.equal(h.floating(), false);
  assert.equal(h.doc.activeElement, h.input, "focus that was inside goes to the composer");
  assert.ok(byClass(h.transcript, "ph-btile").includes(t), "the tile stays inline");
  await h.show(t, true); await h.show(t, false);
  assert.equal(h.floating(), false, "no pop-out again this turn");
  h.api.browserFrame({ type: "browser", phase: "live", anchor: "call_1", domain: "b.example", gen: 4 });
  await tick();
  assert.equal(h.floating(), false, "a later frame of the same turn neither");
  // the next turn floats again
  done(h, "call_1");
  const t2 = await liveTile(h, "call_2");
  await h.show(t2, false);
  assert.equal(h.floating(), true);
});

test("one mini player per session: the newest live tile", async () => {
  const h = mount();
  const t1 = await liveTile(h, "call_1", "one.example");
  await h.show(t1, false);
  assert.equal(one(h.float(), "bf-host").textContent, "one.example");
  const t2 = await liveTile(h, "call_2", "two.example");
  assert.equal(h.floating(), false, "the older turn's float went home; the new tile is not reported yet");
  await h.show(t2, false);
  await h.show(t1, false);
  assert.equal(byClass(h.root, "ph-bfloat").length, 1, "one node");
  assert.equal(one(h.float(), "bf-host").textContent, "two.example", "the newest");
  // a new transcript: gone
  h.api.resetBrowserTiles(); await tick();
  assert.equal(h.floating(), false);
});

test("the picture mirrors the tile's frames and dims with it", async () => {
  const h = mount();
  const t = await liveTile(h, "call_1");
  await h.show(t, false);
  const img = one(h.float(), "bf-img");
  assert.equal(img.hidden, true, "no frame yet");
  await h.respond(h.pending()[0], 200, { seq: 1, jpeg: B64, w: 640, h: 400 });
  assert.equal(img.src, "data:image/jpeg;base64," + B64);
  assert.equal(img.hidden, false);
  assert.equal(img.alt, "example.com");
  await h.respond(h.pending()[0], 409, null);
  assert.equal(h.float().getAttribute("data-dim"), "1", "not holder: dimmed like the tile");
});

// ---------------------------------------------------------------------------
// polling
// ---------------------------------------------------------------------------
test("polling: a floating tile counts as on screen; × and a hidden page stop it; one request in flight", async () => {
  const realNow = Date.now;
  Date.now = () => 1_000_000;
  try {
    const h = mount();
    const t = await liveTile(h, "call_1");
    await h.show(t, true);
    assert.equal(h.pending().length, 1);
    await h.show(t, false);
    assert.equal(h.floating(), true);
    assert.equal(h.pending().length, 1, "floating: the poll keeps going");
    assert.equal(h.frames().length, 1, "the same request, not a second one");
    await h.respond(h.pending()[0], 200, { seq: 2, jpeg: B64, w: 1, h: 1 });
    assert.equal(h.pending().length, 1, "the next poll");
    assert.match(h.pending()[0].url, /after=2/);
    // the page hides: stop; visible again: the float resumes it
    await h.setVisible(false);
    assert.equal(h.pending().length, 0);
    await h.setVisible(true);
    assert.equal(h.pending().length, 1);
    // ×: off screen and not floating, so the poll stops
    one(h.float(), "bf-close").onclick(); await tick();
    assert.equal(h.pending().length, 0);
    assert.ok(h.frames().at(-1).aborted);
    assert.equal(Object.keys(h.HUB.streams).length, 0);
    // a floating tile from the start (it scrolled away before its first frame) polls too
    const h2 = mount();
    const u = await liveTile(h2, "call_7");
    await h2.show(u, false);
    assert.equal(h2.floating(), true);
    assert.equal(h2.pending().length, 1);
  } finally { Date.now = realNow; }
});

// ---------------------------------------------------------------------------
// full screen
// ---------------------------------------------------------------------------
test("tap expands to full screen; Escape and Exit return focus to the mini player; Take over hands off", async () => {
  const h = mount();
  const t = await liveTile(h, "call_1");
  await h.show(t, false);
  const f = h.float();
  const frame = one(f, "bf-frame");
  frame.onclick();
  assert.equal(f.getAttribute("data-expanded"), "1");
  assert.equal(f.getAttribute("role"), "dialog");
  assert.equal(f.getAttribute("aria-modal"), "true");
  assert.equal(h.doc.activeElement, one(f, "bf-exit"), "focus on the close control");
  assert.equal(one(f, "bf-take").hidden, false);
  assert.equal(one(f, "bf-exit").hidden, false);
  assert.equal(one(f, "bf-close").hidden, true);
  // the tile scrolling into view behind it does not yank full screen away
  await h.show(t, true);
  assert.equal(f.getAttribute("data-expanded"), "1");
  await h.show(t, false);
  h.handlers.bfKey({ key: "Escape", preventDefault() {} });
  assert.equal(f.getAttribute("data-expanded"), null);
  assert.equal(f.getAttribute("role"), "group");
  assert.equal(h.doc.activeElement, frame, "focus back on the mini player");
  assert.equal(h.floating(), true);
  // the grow button, then Exit
  one(f, "bf-grow").onclick();
  assert.equal(f.getAttribute("data-expanded"), "1");
  one(f, "bf-exit").onclick();
  assert.equal(f.getAttribute("data-expanded"), null);
  // Take over from full screen: back to the mini player, the tile's event goes out
  frame.onclick();
  one(f, "bf-take").onclick();
  assert.equal(f.getAttribute("data-expanded"), null);
  const ev = h.events.find((e) => e.type === "perch:browser-takeover");
  assert.deepEqual({ ...ev.detail }, { sid: SID, anchor: "call_1" });
  // done while full screen: gone, focus to the composer
  frame.onclick();
  done(h, "call_1"); await tick();
  assert.equal(h.floating(), false);
  assert.equal(f.getAttribute("data-expanded"), null);
  assert.equal(h.doc.activeElement, h.input);
});

test("B1: a rotation while full screen: Exit puts the mini player back inside the new viewport", async () => {
  const h = mount({ innerWidth: 390, innerHeight: 800 });
  const t = await liveTile(h, "call_1");
  await h.show(t, false);
  const f = h.float();
  assert.equal(f.style.top, (700 - 140 - 12) + "px", "portrait: low on the screen");
  one(f, "bf-frame").onclick();
  h.sandbox.window.innerWidth = 800; h.sandbox.window.innerHeight = 390;
  h.api.bfResize();
  one(f, "bf-exit").onclick();
  const x = parseInt(f.style.left, 10), y = parseInt(f.style.top, 10);
  assert.ok(x >= 8 && x <= 800 - 156 - 8, "left inside: " + x);
  assert.ok(y >= 8 && y <= 390 - 140 - 8, "top inside: " + y);
  // Escape too, with a dragged (stored) spot
  f.onpointerdown({ pointerId: 1, button: 0, clientX: 0, clientY: 0, target: one(f, "bf-frame") });
  f.onpointermove({ pointerId: 1, clientX: 0, clientY: 100, preventDefault() {} });
  f.onpointerup({ pointerId: 1 });
  h.runTimers(0);
  one(f, "bf-frame").onclick();
  h.sandbox.window.innerWidth = 390; h.sandbox.window.innerHeight = 300;
  h.handlers.bfKey({ key: "Escape", preventDefault() {} });
  assert.ok(parseInt(f.style.top, 10) <= 300 - 140 - 8);
  assert.ok(parseInt(f.style.left, 10) <= 390 - 156 - 8);
});

// ---------------------------------------------------------------------------
// drag and position
// ---------------------------------------------------------------------------
test("F1: with the composer hidden (another tab), the default spot sits above the visible bottom bar", async () => {
  const hidden = { top: 0, left: 0, width: 0, height: 0 };
  // Perch's tab strip at the bottom
  const h = mount({ composerRect: hidden, tabsRect: { top: 740, left: 0, width: 390, height: 60 } });
  await h.show(await liveTile(h, "call_1"), false);
  assert.equal(h.float().style.top, (740 - 140 - 12) + "px");
  // the shell's bottom tabs (new mode)
  const h2 = mount({ composerRect: hidden, shellTabsRect: { top: 730, left: 0, width: 390, height: 70 } });
  await h2.show(await liveTile(h2, "call_1"), false);
  assert.equal(h2.float().style.top, (730 - 140 - 12) + "px");
  // composer on screen above the tabs: the composer wins (the higher one)
  const h3 = mount({ tabsRect: { top: 740, left: 0, width: 390, height: 60 } });
  await h3.show(await liveTile(h3, "call_1"), false);
  assert.equal(h3.float().style.top, (700 - 140 - 12) + "px");
  // nothing visible: the window bottom
  const h4 = mount({ composerRect: hidden });
  await h4.show(await liveTile(h4, "call_1"), false);
  assert.equal(h4.float().style.top, (800 - 140 - 12) + "px");
  // switchTab re-places it, so the default follows the tab change
  assert.match(perchHubJs("en"), /function switchTab\(name\)\{[\s\S]*?bfResize\(\);[^\n]*\n  \}/);
});

test("F2: an on-screen keyboard (visual viewport only) lifts it; applyVV re-places it", async () => {
  const h = mount();
  await h.show(await liveTile(h, "call_1"), false);
  const f = h.float();
  assert.equal(f.style.top, (700 - 140 - 12) + "px");
  // the keyboard: 800 → 450 visible, no window resize
  h.sandbox.window.visualViewport = { height: 450, offsetTop: 0, scale: 1 };
  h.api.bfResize();
  assert.ok(parseInt(f.style.top, 10) <= 450 - 140 - 8, "above the keyboard: " + f.style.top);
  // pinch-zoom is not a keyboard: the layout viewport stays the bound
  h.sandbox.window.visualViewport = { height: 300, offsetTop: 200, scale: 2 };
  h.api.bfResize();
  assert.equal(f.style.top, (700 - 140 - 12) + "px");
  assert.match(perchHubJs("en"), /var applyVV=function\(\)\{[\s\S]*?bfResize\(\);[^\n]*\n    \};/, "applyVV calls it");
});

test("bfClamp keeps the box inside the viewport", () => {
  const h = mount();
  const c = h.api.bfClamp;
  assert.deepEqual({ ...c({ x: 100, y: 200 }, 150, 120, 390, 800) }, { x: 100, y: 200 });
  assert.deepEqual({ ...c({ x: -50, y: -9 }, 150, 120, 390, 800) }, { x: 8, y: 8 });
  assert.deepEqual({ ...c({ x: 999, y: 9999 }, 150, 120, 390, 800) }, { x: 390 - 150 - 8, y: 800 - 120 - 8 });
  assert.deepEqual({ ...c({ x: "nope", y: null }, 150, 120, 390, 800) }, { x: 8, y: 8 });
  assert.deepEqual({ ...c({ x: 50, y: 50 }, 500, 900, 390, 800) }, { x: 8, y: 8 }, "a box bigger than the viewport pins to the margin");
});

test("drag moves it, a drag is not a tap, the spot is remembered and clamped on resize", async () => {
  const h = mount();
  const t = await liveTile(h, "call_1");
  await h.show(t, false);
  const f = h.float();
  const frame = one(f, "bf-frame");
  const x0 = parseInt(f.style.left, 10), y0 = parseInt(f.style.top, 10);
  const captured = [];
  f.setPointerCapture = (id) => captured.push(id);
  f.onpointerdown({ pointerId: 1, button: 0, clientX: 300, clientY: 600, target: frame });
  f.onpointermove({ pointerId: 1, clientX: 302, clientY: 601, preventDefault() {} });
  assert.equal(parseInt(f.style.left, 10), x0, "under 6 px: still a tap");
  assert.deepEqual(captured, [], "no capture for a tap (it would retarget the click)");
  f.onpointermove({ pointerId: 1, clientX: 100, clientY: 200, preventDefault() {} });
  assert.deepEqual(captured, [1], "captured once it is a drag");
  assert.equal(parseInt(f.style.left, 10), x0 - 200);
  assert.equal(parseInt(f.style.top, 10), y0 - 400);
  f.onpointerup({ pointerId: 1 });
  frame.onclick();
  assert.equal(f.getAttribute("data-expanded"), null, "the click that ends a drag does not expand");
  assert.deepEqual(JSON.parse(h.store.get("crow-perch-bfloat-pos")), { x: x0 - 200, y: y0 - 400 });
  // off the edge: clamped
  f.onpointerdown({ pointerId: 2, button: 0, clientX: 100, clientY: 100, target: frame });
  f.onpointermove({ pointerId: 2, clientX: -900, clientY: 100, preventDefault() {} });
  f.onpointerup({ pointerId: 2 });
  assert.equal(f.style.left, "8px");
  // the buttons never start a drag
  f.onpointerdown({ pointerId: 3, button: 0, clientX: 10, clientY: 10, target: one(f, "bf-close") });
  assert.equal(h.api.bf.drag, null);
  // a rotation: back inside the narrower viewport
  f.onpointerdown({ pointerId: 4, button: 0, clientX: 0, clientY: 0, target: frame });
  f.onpointermove({ pointerId: 4, clientX: 500, clientY: 0, preventDefault() {} });
  f.onpointerup({ pointerId: 4 });
  assert.equal(f.style.left, (390 - 156 - 8) + "px");
  h.sandbox.window.innerWidth = 300; h.sandbox.window.innerHeight = 400;
  h.api.bfResize();
  assert.equal(f.style.left, (300 - 156 - 8) + "px");
  assert.ok(parseInt(f.style.top, 10) <= 400 - 140 - 8);
});

test("a stored spot is used on this device; bad or blocked storage falls back to the default", async () => {
  const h = mount({ stored: JSON.stringify({ x: 20, y: 30 }) });
  const t = await liveTile(h, "call_1");
  await h.show(t, false);
  assert.equal(h.float().style.left, "20px");
  assert.equal(h.float().style.top, "30px");
  for (const opts of [{ stored: "{not json" }, { stored: JSON.stringify({ x: "1", y: 2 }) }, { storageThrows: true }]) {
    const h2 = mount(opts);
    const u = await liveTile(h2, "call_1");
    await h2.show(u, false);
    assert.equal(h2.float().style.left, (390 - 156 - 12) + "px", JSON.stringify(opts));
    const f = h2.float(), frame = one(f, "bf-frame");
    f.onpointerdown({ pointerId: 1, button: 0, clientX: 0, clientY: 0, target: frame });
    f.onpointermove({ pointerId: 1, clientX: -40, clientY: 0, preventDefault() {} });
    assert.doesNotThrow(() => f.onpointerup({ pointerId: 1 }), "a refused write is not an error");
  }
});

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------
test("a retire or a Turbo snapshot removes the node; a new instance clears one left behind", async () => {
  const h = mount();
  const t = await liveTile(h, "call_1");
  await h.show(t, false);
  assert.ok(h.float());
  h.handlers.bfCache();
  assert.equal(h.float(), null, "not in the cached snapshot");
  await h.show(t, true); await h.show(t, false);
  assert.ok(h.float(), "back after the snapshot");
  h.sandbox.__retired = true;
  h.api.retireBrowserTiles();
  assert.equal(h.float(), null, "retired: gone at once");
  // a stale node in the page (a restored snapshot) is replaced, never doubled
  const h2 = mount();
  const stale = makeEl("div", h2.doc); stale.className = "ph-bfloat"; h2.root.appendChild(stale);
  const u = await liveTile(h2, "call_1");
  await h2.show(u, false);
  assert.equal(byClass(h2.root, "ph-bfloat").length, 1);
  assert.notEqual(h2.float(), stale);
});
