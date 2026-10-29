// Live browser tile, Task 6: the tile in the Perch thread (spec 2026-10-27 §1,
// §4.2, §4.3 delivery, §4.5, §4.6, §7 items 4 and 10).
//
// The tile snippet (perch-hub/browser-tile.js) runs in a vm sandbox with the
// hub's shared-scope helpers. The REAL appendToolChip / finishToolChip /
// csrf / perchApi are lifted out of the emitted hub script and spliced in, so
// the anchor chips and the CSRF header are the shipped ones, not stand-ins
// (the perch-card-chip / perch-artifact-card idiom, one step further).
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { perchHubJs } from "../servers/gateway/dashboard/perch-hub/client.js";
import { perchBrowserTileJs } from "../servers/gateway/dashboard/perch-hub/browser-tile.js";
import { translations } from "../servers/gateway/dashboard/shared/i18n.js";

const SID = "perchlive-aaaaaaaa";
const API = "/dashboard/perch-api";
const B64 = "/9j/4AAQSkZJRg==";

// ---------------------------------------------------------------------------
// a small DOM: enough of Element for the snippet and the lifted chip code
// ---------------------------------------------------------------------------
function makeEl(tag) {
  const attrs = {};
  const node = {
    tagName: String(tag || "div").toUpperCase(), children: [], parentNode: null,
    className: "", textContent: "", hidden: false, disabled: false, type: "", onclick: null,
    style: {}, scrollTop: 0, scrollHeight: 0, alt: "",
    appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); this.children.push(c); c.parentNode = this; return c; },
    insertBefore(c, ref) {
      if (c.parentNode) c.parentNode.removeChild(c);
      const i = ref ? this.children.indexOf(ref) : -1;
      if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
      c.parentNode = this; return c;
    },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; },
    setAttribute(k, v) { attrs[k] = String(v); if (k === "src") node._src = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null; },
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(attrs, k); },
    removeAttribute(k) { delete attrs[k]; if (k === "src") node._src = ""; },
    get firstChild() { return this.children[0] || null; },
  };
  Object.defineProperty(node, "src", { get() { return node._src || ""; }, set(v) { node._src = String(v); }, enumerable: true });
  Object.defineProperty(node, "innerHTML", { set() { throw new Error("innerHTML sink reached"); }, get() { return ""; } });
  return node;
}
function walk(n, fn) { fn(n); for (const c of n.children) walk(c, fn); }
function byClass(n, cls) { const o = []; walk(n, (x) => { if (String(x.className || "").split(/\s+/).includes(cls)) o.push(x); }); return o; }
const tiles = (tr) => byClass(tr, "ph-btile");
const one = (n, cls) => byClass(n, cls)[0];
const tick = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

// ---------------------------------------------------------------------------
// the lifted hub functions
// ---------------------------------------------------------------------------
function maskComments(src) { return src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " ")); }
function lift(src, name) {
  const start = src.indexOf("function " + name + "(");
  assert.ok(start > -1, name + " is not in the hub script");
  const masked = maskComments(src);
  let depth = 0;
  for (let i = masked.indexOf("{", start); i < masked.length; i++) {
    if (masked[i] === "{") depth++;
    else if (masked[i] === "}") { depth--; if (!depth) return src.slice(start, i + 1); }
  }
  throw new Error("unbalanced " + name);
}

function mount({ innerWidth = 390, io = true, newMode = false } = {}) {
  const hub = perchHubJs("en");
  const transcript = makeEl("div");
  const status = makeEl("div"); status.hidden = true;
  const ios = [];
  class FakeIO {
    constructor(cb) { this.cb = cb; this.nodes = new Set(); this.disconnected = false; ios.push(this); }
    observe(n) { this.nodes.add(n); }
    unobserve(n) { this.nodes.delete(n); }
    disconnect() { this.nodes.clear(); this.disconnected = true; }
  }
  const calls = [];
  const fetchFn = (url, opts) => {
    let resolve, reject;
    const p = new Promise((res, rej) => { resolve = res; reject = rej; });
    const c = { url: String(url), method: (opts && opts.method) || "GET", opts: opts || {}, resolve, reject, settled: false };
    if (opts && opts.signal) opts.signal.addEventListener("abort", () => { if (!c.settled) { c.settled = true; c.aborted = true; reject(new Error("AbortError")); } });
    calls.push(c);
    return p;
  };
  const timers = new Map(); let tseq = 1;
  const docT = new EventTarget();
  const events = [];
  const handlers = {};
  const doc = {
    visibilityState: "visible",
    cookie: "crow_csrf=tok-123",
    createElement: (t) => makeEl(t),
    addEventListener: (...a) => docT.addEventListener(...a),
    dispatchEvent(ev) { events.push(ev); return docT.dispatchEvent(ev); },
  };
  const HUB = { streams: {} };
  const sandbox = {
    console, document: doc, window: { innerWidth }, API, HUB,
    current: { sid: SID },
    el: (id) => (id === "perch-transcript" ? transcript : id === "perch-browser-status" ? status : null),
    live: () => !sandbox.__retired,
    bindOnce: (target, type, key, fn) => { handlers[key] = fn; },
    fetch: fetchFn,
    setTimeout: (fn, ms) => { const id = tseq++; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    AbortController, CustomEvent, Event, Date, Math, JSON, encodeURIComponent, Number, String,
    TOOL_RUNNING: "running", TOOL_DONE: "done", TOOL_FAILED: "failed",
    __export(api) { sandbox.api = api; },
  };
  if (io) sandbox.IntersectionObserver = FakeIO;
  sandbox.line = (cls, text) => { const d = makeEl("div"); if (cls) d.className = cls; d.textContent = text == null ? "" : String(text); return d; };
  vm.createContext(sandbox);
  // New mode (R1.2 PR 2): the "See what happened" group code rides along,
  // with SHEET truthy, so the chips land in a .tool-group the tile must anchor after.
  const groupFns = ["toolGroupFor", "toolGroupOpen", "toolGroupRefresh", "groupLabel", "chipFailed", "subagentNames", "isSubagentTool"];
  const lifted = ["appendToolChip", "finishToolChip", "csrf", "perchApi"].concat(newMode ? groupFns : []).map((n) => lift(hub, n)).join("\n");
  const groupVars = newMode
    ? "var SHEET={}; var toolGroup=null, toolGroups=[], toolTurn=0, toolGroupSeq=0; " + /var KNOWN_REFUSALS=\[[\s\S]*?\];/.exec(hub)[0] +
      " var TG_S={ see:'See what happened', running:'running', step:'1 step', steps:'{n} steps', failedOne:'1 failed', failed:'{n} failed' };\n"
    : "";
  vm.runInContext(`(function(){\nvar toolChips={};\n${groupVars}${lifted}\n${perchBrowserTileJs("en")}\n;__export({ browserFrame: browserFrame, browserHistory: browserHistory, resetBrowserTiles: resetBrowserTiles, retireBrowserTiles: retireBrowserTiles, appendToolChip: appendToolChip, finishToolChip: finishToolChip });\n})();`, sandbox);
  const frames = () => calls.filter((c) => c.url.includes("/browser/frame"));
  const pending = () => frames().filter((c) => !c.settled);
  const respond = async (c, status, body) => {
    c.settled = true;
    c.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });
    await tick();
  };
  const io0 = () => ios[ios.length - 1];
  const show = async (node, on = true) => { io0().cb([{ target: node, isIntersecting: on }]); await tick(); };
  const setVisible = async (v) => { doc.visibilityState = v ? "visible" : "hidden"; handlers.btVisibility && handlers.btVisibility(); await tick(); };
  return { sandbox, api: sandbox.api, transcript, status, calls, frames, pending, respond, ios, io0, show, setVisible, timers, events, HUB, handlers, doc };
}

function msgRow(h, text, ts) {
  const d = makeEl("div"); d.className = "entry bot"; d.textContent = text;
  if (ts) d.setAttribute("data-ts", String(ts));
  h.transcript.appendChild(d); return d;
}
const chipOf = (h, id) => h.transcript.children.find((c) => c.getAttribute && c.getAttribute("data-call") === id);
const idx = (h, n) => h.transcript.children.indexOf(n);

async function liveTile(h, anchor = "call_1", domain = "example.com") {
  h.api.browserFrame({ type: "browser", phase: "live", anchor, domain, gen: 3 });
  await tick();
  const t = tiles(h.transcript).find((x) => x.getAttribute("data-anchor") === (anchor || ""));
  return t;
}

// ---------------------------------------------------------------------------
// static shape
// ---------------------------------------------------------------------------
test("no client source contains a backtick or ${ inside the template literal; the snippet is spliced and parses", () => {
  for (const lang of ["en", "es"]) {
    const js = perchBrowserTileJs(lang);
    assert.equal(js.includes("`"), false, "no backtick");
    assert.equal(js.includes("${"), false, "no dollar-brace");
    assert.ok(!/\.innerHTML\s*\+?=|\.outerHTML\s*\+?=|insertAdjacentHTML\s*\(|document\.write\s*\(|setSanitizedHtml\(/.test(js), "no HTML sink");
    const hub = perchHubJs(lang);
    assert.ok(hub.includes(js), "spliced verbatim");
    assert.doesNotThrow(() => new Function(hub), lang + " hub parses");
  }
  const src = readFileSync(new URL("../servers/gateway/dashboard/perch-hub/browser-tile.js", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("return `") + 8, src.lastIndexOf("`;"));
  assert.equal(/`/.test(body), false, "no raw backtick inside the emitted literal");
  assert.equal((body.match(/\$\{/g) || []).length, (body.match(/\$\{tJs\("/g) || []).length, "the only ${ are tJs interpolations");
});

test("the hub wires the tile: the browser frame, the history replay, every reset and the retire", () => {
  const js = perchHubJs("en");
  assert.match(js, /on\('browser',function\(d\)\{/);
  assert.match(js, /if\(!histSettled\)\{ histBuf\.push\(\{ browserFrame:true, d:d \}\); return; \}/, "frames wait for the history batch");
  assert.match(js, /browserHistory\(shots\|\|\[\]\)/, "flushHistBuf replays the frozen tiles");
  assert.ok(js.indexOf("browserHistory(shots||[])") < js.indexOf("var buf=histBuf; histBuf=[];"), "frozen tiles land before the buffered live frames replay");
  assert.match(js, /if\(f\.browserFrame\)\{ browserFrame\(f\.d\); return; \}/);
  assert.equal((js.match(/resetBrowserTiles\(\);/g) || []).length, 3, "openSession, resyncHistory and closeSession reset the tiles");
  assert.match(js, /HUB\.retire=function\(\)\{[\s\S]*?retireBrowserTiles\(\);[\s\S]*?\};/, "a Turbo retire stops every poller and the observer");
  assert.match(js, /wrap\.setAttribute\('data-call',/, "chips carry their call id for the anchor");
  assert.match(js, /kind==='browser_shot'/, "a shot never renders as a sent-file card");
});

test("the header has the status line, and every tile string is a translated key (en + es, exact)", async () => {
  const htmlSrc = readFileSync(new URL("../servers/gateway/dashboard/perch-hub/html.js", import.meta.url), "utf8");
  assert.match(htmlSrc, /<div class="browser-status" id="perch-browser-status" role="status" hidden><\/div>/);
  const want = {
    "perch.browserLive": ["Live", "En vivo"],
    "perch.browserDone": ["Done", "Hecho"],
    "perch.browserNeutral": ["Browser", "Navegador"],
    "perch.browserUsing": ["Using the browser · {domain}", "Usando el navegador · {domain}"],
    "perch.browserUsingNoDomain": ["Using the browser", "Usando el navegador"],
    "perch.browserWaiting": ["Waiting for you", "Esperando por ti"],
    "perch.browserYouHadIt": ["You had the browser", "Tenías tú el navegador"],
    "perch.browserDelete": ["Delete screenshot", "Borrar captura"],
    "perch.takeOver": ["Take over", "Tomar el control"],
  };
  for (const [k, [en, es]] of Object.entries(want)) {
    assert.ok(translations[k], k);
    assert.equal(translations[k].en, en, k + " en");
    assert.equal(translations[k].es, es, k + " es");
  }
  const i18nSrc = readFileSync(new URL("../servers/gateway/dashboard/shared/i18n.js", import.meta.url), "utf8");
  const block = i18nSrc.slice(i18nSrc.indexOf("// ─── Browser tile ───"));
  assert.ok(i18nSrc.includes("// ─── Browser tile ───"), "the block header");
  for (const k of Object.keys(want)) assert.ok(block.indexOf('"' + k + '"') > 0 && block.indexOf('"' + k + '"') < 2000, k + " lives in the block");
  const src = readFileSync(new URL("../servers/gateway/dashboard/perch-hub/browser-tile.js", import.meta.url), "utf8");
  for (const k of new Set([...src.matchAll(/tJs\("([^"]+)"/g)].map((m) => m[1]))) assert.ok(translations[k]?.en && translations[k]?.es, k);
  assert.ok(perchBrowserTileJs("es").includes("Tomar el control"));
});

test("the CSS: Perch tokens only, ≥ 44 px targets, the phone column never scrolls sideways", async () => {
  const { perchHubCss } = await import("../servers/gateway/dashboard/perch-hub/css.js");
  const css = perchHubCss();
  const block = css.slice(css.indexOf(".ph-btile"), css.lastIndexOf(".browser-status") + 400);
  assert.ok(block.length > 200, "the tile has its rules");
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(block), "no literal colours: tokens only");
  assert.match(block, /\.ph-btile \.bt-actions button\{[^}]*min-height:44px/);
  assert.match(block, /\.ph-btile \.bt-frame\{[^}]*min-height:44px/);
  assert.match(block, /\.ph-btile\{[^}]*min-width:0/);
  assert.match(block, /\.ph-btile \[hidden\]\{display:none\}/);
});

// ---------------------------------------------------------------------------
// placement
// ---------------------------------------------------------------------------
test("one tile per turn, placed after its anchor chip", async () => {
  const h = mount();
  msgRow(h, "on it");
  h.api.appendToolChip({ name: "mcp__browser__crow_browser_navigate", toolCallId: "call_1", argsText: "{}" });
  h.api.appendToolChip({ name: "mcp__browser__crow_browser_click", toolCallId: "call_2", argsText: "{}" });
  const t = await liveTile(h, "call_1");
  assert.ok(t, "a tile");
  assert.equal(idx(h, t), idx(h, chipOf(h, "call_1")) + 1, "right after the first browser chip");
  assert.equal(t.getAttribute("data-phase"), "live");
  // the same turn's later frames (a new domain, a new gen) update the SAME tile
  h.api.browserFrame({ type: "browser", phase: "live", anchor: "call_1", domain: "shop.example.com", gen: 4 });
  await tick();
  assert.equal(tiles(h.transcript).length, 1, "one tile per turn");
  assert.equal(one(t, "bt-host").textContent, "shop.example.com");
  // done freezes the same tile
  h.api.browserFrame({ type: "browser", phase: "done", anchor: "call_1", domain: "shop.example.com", shot: { id: 7, url: API + "/interactive/" + SID + "/workspace/browser-shop.example.com-20261028-090507.jpg" }, note: null });
  await tick();
  assert.equal(tiles(h.transcript).length, 1);
  assert.equal(t.getAttribute("data-phase"), "done");
  // a new turn: a new tile after ITS chip, the old one stays in its place
  msgRow(h, "next");
  h.api.appendToolChip({ name: "mcp__browser__crow_browser_navigate", toolCallId: "call_9", argsText: "{}" });
  const t2 = await liveTile(h, "call_9", "other.example.org");
  assert.equal(tiles(h.transcript).length, 2);
  assert.equal(idx(h, t2), idx(h, chipOf(h, "call_9")) + 1);
  assert.equal(idx(h, t), idx(h, chipOf(h, "call_1")) + 1, "the first turn's tile did not move");
});

test("router-named and plain chips both anchor it", async () => {
  const h = mount();
  h.api.appendToolChip({ name: "mcp__browser", toolCallId: "call_r", argsText: '{"action":"call","tool":"crow_browser_navigate"}' });
  msgRow(h, "after the router chip");
  const t = await liveTile(h, "call_r");
  assert.equal(idx(h, t), idx(h, chipOf(h, "call_r")) + 1, "router chip anchors");
  // a history chip (toolCallId 'hist:<id>') anchors by its raw id
  const h2 = mount();
  h2.api.appendToolChip({ name: "mcp__browser__crow_browser_snapshot", toolCallId: "hist:call_p" });
  h2.api.finishToolChip({ toolCallId: "hist:call_p", isError: false, resultText: "ok" });
  msgRow(h2, "later");
  const t2 = await liveTile(h2, "call_p");
  assert.equal(idx(h2, t2), idx(h2, chipOf(h2, "call_p")) + 1, "plain (history) chip anchors");
  // no chip on screen for the anchor: the end of the turn's stream
  const h3 = mount();
  msgRow(h3, "a");
  const t3 = await liveTile(h3, "call_missing");
  assert.equal(idx(h3, t3), h3.transcript.children.length - 1);
  // an anchorless frame is one tile too, and a later anchored frame adopts it
  const h4 = mount();
  h4.api.appendToolChip({ name: "mcp__browser__crow_browser_navigate", toolCallId: "call_late" });
  await liveTile(h4, null);
  h4.api.browserFrame({ type: "browser", phase: "live", anchor: null, domain: "a.example", gen: 2 });
  h4.api.browserFrame({ type: "browser", phase: "live", anchor: "call_late", domain: "a.example", gen: 2 });
  await tick();
  assert.equal(tiles(h4.transcript).length, 1, "still one tile for the turn");
  assert.equal(tiles(h4.transcript)[0].getAttribute("data-anchor"), "call_late");
});

test("live: hostname via textContent, neutral Browser when null, Live dot, Take over (≥ 44 px class) dispatches perch:browser-takeover", async () => {
  const h = mount();
  const t = await liveTile(h, "call_1", "<b>evil</b>.example");
  assert.equal(one(t, "bt-host").textContent, "<b>evil</b>.example", "textContent, never markup");
  assert.equal(one(t, "bt-state").textContent, "Live");
  assert.ok(one(t, "bt-dot"));
  const take = one(t, "bt-take");
  assert.equal(take.tagName, "BUTTON"); assert.equal(take.type, "button");
  assert.equal(take.textContent, "Take over"); assert.equal(take.hidden, false);
  assert.equal(one(t, "bt-del").hidden, true, "no Delete while live");
  take.onclick();
  const ev = h.events.find((e) => e.type === "perch:browser-takeover");
  assert.ok(ev, "the Task 7 hook event");
  assert.deepEqual({ ...ev.detail }, { sid: SID, anchor: "call_1" });
  const h2 = mount();
  const n = await liveTile(h2, "call_2", null);
  assert.equal(one(n, "bt-host").textContent, "Browser");
  assert.equal(h2.status.textContent, "Using the browser", "no domain: the plain line");
});

// ---------------------------------------------------------------------------
// polling
// ---------------------------------------------------------------------------
test("polls only while the tile is on screen and the tab visible", async () => {
  const realNow = Date.now;
  Date.now = () => 1_000_000;                 // a frozen clock: every poll gap is exactly 1 s (the sandbox shares Date)
  try { await pollsOnScreen(); } finally { Date.now = realNow; }
});
async function pollsOnScreen() {
  const h = mount({ innerWidth: 390 });
  const t = await liveTile(h, "call_1");
  assert.equal(h.frames().length, 0, "not on screen yet: no poll");
  assert.ok(h.io0().nodes.has(t), "the tile is observed");
  await h.show(t, true);
  assert.equal(h.pending().length, 1, "on screen + visible: one poll");
  const c = h.pending()[0];
  assert.equal(c.url, API + "/interactive/" + SID + "/browser/frame?after=0&vw=390", "vw is the viewport width");
  assert.equal(c.opts.headers["X-Crow-Csrf"], "tok-123");
  assert.ok(c.opts.signal, "aborts through an AbortController");
  assert.equal(Object.values(h.HUB.streams).length, 1, "registered in HUB.streams");
  // a frame: the img shows a data: URL, the next poll asks after its seq
  await h.respond(c, 200, { seq: 5, jpeg: B64, w: 640, h: 400 });
  const img = one(t, "bt-img");
  assert.equal(img.src, "data:image/jpeg;base64," + B64);
  assert.equal(h.pending().length, 1, "never more than one request in flight");
  assert.match(h.pending()[0].url, /after=5&vw=390$/);
  // 204: poll again (an early 204 waits out the 1 s minimum gap first: no busy loop)
  await h.respond(h.pending()[0], 204, null);
  if (!h.pending().length) {
    const gap = [...h.timers.entries()].filter(([, x]) => x.ms > 0 && x.ms <= 1000);
    assert.equal(gap.length, 1, "one gap timer");
    h.timers.delete(gap[0][0]); gap[0][1].fn(); await tick();
  }
  assert.equal(h.pending().length, 1);
  assert.match(h.pending()[0].url, /after=5/);
  // scrolled away: the poll is aborted, nothing new starts
  await h.show(t, false);
  assert.equal(h.pending().length, 0);
  assert.ok(h.frames().at(-1).aborted, "the in-flight poll was aborted");
  assert.equal(Object.values(h.HUB.streams).length, 0, "unregistered");
  const before = h.frames().length;
  await tick();
  assert.equal(h.frames().length, before);
  // back on screen: polling resumes after the last seq
  await h.show(t, true);
  assert.equal(h.pending().length, 1);
  assert.match(h.pending()[0].url, /after=5/);
  // a malformed frame body is never put into the image
  {
    await h.respond(h.pending()[0], 200, { seq: 6, jpeg: "\"><script>", w: 1, h: 1 });
    assert.equal(img.src, "data:image/jpeg;base64," + B64, "kept the last good frame");
    // M1: no tight loop — the next poll waits ≥ 1 s and asks after the refused frame's seq
    assert.equal(h.pending().length, 0, "not re-asked at once");
    const gap = [...h.timers.entries()].filter(([, x]) => x.ms === 1000);
    assert.equal(gap.length, 1, "a 1 s gap timer");
    h.timers.delete(gap[0][0]); gap[0][1].fn(); await tick();
    assert.equal(h.pending().length, 1);
    assert.match(h.pending()[0].url, /after=6&vw=390$/, "seq advanced past the refused frame");
    // a 200 that does not advance seq (same or lower) also waits the gap
    await h.respond(h.pending()[0], 200, { seq: 6, jpeg: B64, w: 1, h: 1 });
    assert.equal(h.pending().length, 0);
    assert.equal([...h.timers.values()].filter((x) => x.ms === 1000).length, 1);
    // a non-integer seq never advances
    for (const [id, x] of [...h.timers.entries()]) { h.timers.delete(id); x.fn(); }
    await tick();
    await h.respond(h.pending()[0], 200, { seq: 7.5, jpeg: B64, w: 1, h: 1 });
    for (const [id, x] of [...h.timers.entries()]) { h.timers.delete(id); x.fn(); }
    await tick();
    assert.match(h.pending()[0].url, /after=6&/);
  }
}

test("M4: a network error while visible retries once after 5 s; an abort never does", async () => {
  const h = mount();
  const t = await liveTile(h, "call_1");
  await h.show(t, true);
  const c = h.pending()[0];
  c.settled = true; c.reject(new TypeError("Failed to fetch")); await tick();
  assert.equal(h.pending().length, 0);
  const r = [...h.timers.entries()].filter(([, x]) => x.ms === 5000);
  assert.equal(r.length, 1, "one 5 s retry");
  h.timers.delete(r[0][0]); r[0][1].fn(); await tick();
  assert.equal(h.pending().length, 1, "retried");
  const c2 = h.pending()[0];
  c2.settled = true; c2.reject(new TypeError("Failed to fetch")); await tick();
  assert.equal([...h.timers.values()].filter((x) => x.ms === 5000).length, 0, "only once");
  // an abort (scrolling away) schedules nothing
  await h.show(t, true);
  assert.equal(h.pending().length, 1);
  await h.show(t, false);
  assert.equal([...h.timers.values()].filter((x) => x.ms === 5000).length, 0);
});

test("M2: the live picture is named Take over · host; a frozen one is not a control", async () => {
  const h = mount();
  const t = await liveTile(h, "call_1", "example.com");
  const frame = one(t, "bt-frame");
  assert.equal(frame.getAttribute("aria-label"), "Take over · example.com");
  frame.onclick();
  assert.equal(h.events.filter((e) => e.type === "perch:browser-takeover").length, 1);
  h.api.browserFrame({ type: "browser", phase: "done", anchor: "call_1", domain: "example.com",
    shot: { id: 3, url: API + "/interactive/" + SID + "/workspace/browser-example.com-20261028-090507.jpg" }, note: null });
  await tick();
  assert.equal(frame.getAttribute("aria-label"), null);
  assert.equal(frame.getAttribute("tabindex"), "-1");
  assert.equal(frame.disabled, true);
  frame.onclick();
  assert.equal(h.events.filter((e) => e.type === "perch:browser-takeover").length, 1, "no take-over from a frozen tile");
});

test("M3: the role=status header is written only when its text changes", async () => {
  const h = mount();
  let writes = 0, val = "";
  Object.defineProperty(h.status, "textContent", { get: () => val, set: (v) => { writes++; val = String(v); }, configurable: true });
  await liveTile(h, "call_1", "example.com");
  assert.equal(val, "Using the browser · example.com");
  const w = writes;
  h.api.browserFrame({ type: "browser", phase: "live", anchor: "call_1", domain: "example.com", gen: 4 });
  h.api.browserFrame({ type: "browser", phase: "live", anchor: "call_1", domain: "example.com", gen: 5 });
  await tick();
  assert.equal(writes, w, "same text, no write");
  h.api.browserFrame({ type: "browser", phase: "live", anchor: "call_1", domain: "b.example", gen: 6 });
  await tick();
  assert.equal(writes, w + 1);
});

test("hidden tab stops polling", async () => {
  const h = mount();
  const t = await liveTile(h, "call_1");
  await h.show(t, true);
  assert.equal(h.pending().length, 1);
  await h.setVisible(false);
  assert.equal(h.pending().length, 0, "the poll is aborted when the tab hides");
  assert.equal(Object.values(h.HUB.streams).length, 0);
  // the tile scrolling around while hidden starts nothing
  await h.show(t, true);
  assert.equal(h.pending().length, 0, "on screen but hidden: still no poll");
  await h.setVisible(true);
  assert.equal(h.pending().length, 1, "visible again: one poll");
  // and a tab hidden while a 204 is in flight does not chain a new poll
  const c = h.pending()[0];
  h.doc.visibilityState = "hidden";
  await h.respond(c, 204, null);
  for (const [id, x] of [...h.timers.entries()]) { h.timers.delete(id); x.fn(); }
  await tick();
  assert.equal(h.pending().length, 0, "a settled poll checks visibility before the next");
  assert.equal(Object.values(h.HUB.streams).length, 0);
});

test("Turbo retire aborts the poller (HUB.retire, AbortController)", async () => {
  const h = mount();
  const t = await liveTile(h, "call_1");
  await h.show(t, true);
  const c = h.pending()[0];
  const streams = Object.values(h.HUB.streams);
  assert.equal(streams.length, 1);
  // HUB.retire closes every registry entry by identity
  for (const k of Object.keys(h.HUB.streams)) { h.HUB.streams[k].close(); delete h.HUB.streams[k]; }
  assert.ok(c.aborted, "close() aborts the fetch");
  h.api.retireBrowserTiles();
  assert.ok(h.io0().disconnected, "the observer is disconnected");
  h.sandbox.__retired = true;
  await h.show(t, true);
  await h.setVisible(true);
  assert.equal(h.pending().length, 0, "a retired instance never polls again");
});

test("409 not_holder dims the last frame", async () => {
  const h = mount();
  const t = await liveTile(h, "call_1");
  await h.show(t, true);
  await h.respond(h.pending()[0], 200, { seq: 1, jpeg: B64, w: 640, h: 400 });
  await h.respond(h.pending()[0], 409, { error: "not_holder" });
  assert.equal(t.getAttribute("data-dim"), "1", "dimmed");
  assert.equal(one(t, "bt-img").src, "data:image/jpeg;base64," + B64, "the last frame stays");
  assert.equal(h.pending().length, 0, "and polling stopped");
  await h.show(t, false); await h.show(t, true); await h.setVisible(true);
  assert.equal(h.pending().length, 0, "it does not restart by itself");
  // the lease coming back (a new live frame) undims and resumes
  h.api.browserFrame({ type: "browser", phase: "live", anchor: "call_1", domain: "example.com", gen: 5 });
  await tick();
  assert.equal(t.getAttribute("data-dim"), null);
  assert.equal(h.pending().length, 1);
});

test("404 stops; 429 backs off 5 s and resumes once", async () => {
  const h = mount();
  const t = await liveTile(h, "call_1");
  await h.show(t, true);
  await h.respond(h.pending()[0], 429, { error: "too_many_polls" });
  assert.equal(h.pending().length, 0);
  const backoff = [...h.timers.values()].filter((x) => x.ms === 5000);
  assert.equal(backoff.length, 1, "one 5 s back-off timer");
  backoff[0].fn(); await tick();
  assert.equal(h.pending().length, 1, "resumed once");
  await h.respond(h.pending()[0], 429, { error: "too_many_polls" });
  assert.equal([...h.timers.values()].filter((x) => x.ms === 5000).length, 1, "no second back-off");
  assert.equal(h.pending().length, 0);
  const h2 = mount();
  const t2 = await liveTile(h2, "call_1");
  await h2.show(t2, true);
  await h2.respond(h2.pending()[0], 404, { error: "no_browser" });
  assert.equal(h2.pending().length, 0);
  await h2.show(t2, false); await h2.show(t2, true);
  assert.equal(h2.pending().length, 0, "404 stays stopped");
});

// ---------------------------------------------------------------------------
// done, history, delete
// ---------------------------------------------------------------------------
test("done freezes to the shot url, with a Done dot and Delete screenshot; polling stops", async () => {
  const h = mount();
  const t = await liveTile(h, "call_1");
  await h.show(t, true);
  const c = h.pending()[0];
  const url = API + "/interactive/" + SID + "/workspace/browser-example.com-20261028-090507.jpg";
  h.api.browserFrame({ type: "browser", phase: "done", anchor: "call_1", domain: "example.com", shot: { id: 12, url }, note: null });
  await tick();
  assert.ok(c.aborted, "the live poll is aborted");
  assert.equal(h.pending().length, 0);
  assert.equal(t.getAttribute("data-phase"), "done");
  assert.equal(one(t, "bt-img").src, url);
  assert.equal(one(t, "bt-state").textContent, "Done");
  assert.equal(one(t, "bt-del").hidden, false);
  assert.equal(one(t, "bt-del").textContent, "Delete screenshot");
  assert.equal(one(t, "bt-take").hidden, true, "no Take over on a frozen tile");
  assert.equal(h.status.hidden, true, "the header line goes away");
  assert.equal(h.io0().nodes.has(t), false, "no longer observed");
  // a shot url from elsewhere is never loaded
  const t2 = await liveTile(h, "call_2");
  h.api.browserFrame({ type: "browser", phase: "done", anchor: "call_2", domain: "x", shot: { id: 13, url: "https://elsewhere.example/x.jpg" }, note: null });
  await tick();
  assert.equal(one(t2, "bt-img").src, "");
  assert.equal(one(t2, "bt-del").hidden, true);
});

test("done with note operator shows \"You had the browser\" and no image", async () => {
  const h = mount();
  const t = await liveTile(h, "call_1");
  await h.show(t, true);
  await h.respond(h.pending()[0], 200, { seq: 1, jpeg: B64, w: 640, h: 400 });
  h.api.browserFrame({ type: "browser", phase: "done", anchor: "call_1", domain: "example.com", shot: null, note: "operator" });
  await tick();
  assert.equal(t.getAttribute("data-phase"), "done");
  assert.equal(one(t, "bt-img").src, "", "no image");
  assert.equal(one(t, "bt-frame").hidden, true);
  const note = one(t, "bt-note");
  assert.equal(note.hidden, false);
  assert.equal(note.textContent, "You had the browser");
  assert.equal(one(t, "bt-del").hidden, true, "nothing to delete");
});

test("the header status line: Using the browser · {domain} while live, Waiting for you while the operator holds it", async () => {
  const h = mount();
  const t = await liveTile(h, "call_1", "example.com");
  assert.equal(h.status.hidden, false);
  assert.equal(h.status.textContent, "Using the browser · example.com");
  await h.show(t, true);
  const c = h.pending()[0];
  h.api.browserFrame({ type: "browser", phase: "operator", anchor: "call_1", held: true });
  await tick();
  assert.equal(h.status.textContent, "Waiting for you");
  assert.equal(t.getAttribute("data-operator"), "1");
  assert.ok(c.aborted, "no frames while the operator drives");
  assert.equal(h.pending().length, 0);
  h.api.browserFrame({ type: "browser", phase: "operator", anchor: "call_1", held: false });
  await tick();
  assert.equal(h.status.textContent, "Using the browser · example.com");
  assert.equal(t.getAttribute("data-operator"), null);
  assert.equal(h.pending().length, 1, "polling resumes after hand back");
  h.api.resetBrowserTiles();
  assert.equal(h.status.hidden, true, "a new transcript has no header line");
  assert.equal(h.pending().length, 0);
});

test("frozen tiles replay in place", async () => {
  const h = mount();
  const T = (s) => Date.parse(s.replace(" ", "T") + "Z");
  const m1 = msgRow(h, "turn one", T("2026-10-28 09:00:00"));
  h.api.appendToolChip({ name: "mcp__browser__crow_browser_navigate", toolCallId: "hist:call_a" });
  h.api.finishToolChip({ toolCallId: "hist:call_a", resultText: "ok" });
  const m2 = msgRow(h, "turn one reply", T("2026-10-28 09:01:00"));
  const m3 = msgRow(h, "turn two", T("2026-10-28 10:00:00"));
  const m4 = msgRow(h, "turn two reply", T("2026-10-28 10:05:00"));
  void m1; void m2;
  const u = (n) => API + "/interactive/" + SID + "/workspace/" + n;
  // newest first, as the route sends them
  h.api.browserHistory([
    { id: 31, name: "browser-page-20261028-100300.jpg", url: u("browser-page-20261028-100300.jpg"), turn_anchor: "call_gone", created_at: "2026-10-28 10:03:00" },
    { id: 30, name: "browser-example.com-20261028-090030.jpg", url: u("browser-example.com-20261028-090030.jpg"), turn_anchor: "call_a", created_at: "2026-10-28 09:00:30" },
  ]);
  await tick();
  const ts = tiles(h.transcript);
  assert.equal(ts.length, 2);
  const a = ts.find((x) => x.getAttribute("data-anchor") === "call_a");
  const g = ts.find((x) => x.getAttribute("data-anchor") === "call_gone");
  assert.equal(idx(h, a), idx(h, chipOf(h, "call_a")) + 1, "anchor present: after the chip");
  assert.equal(idx(h, g), idx(h, m4) - 1, "anchor missing: by created_at, right before the first newer message");
  assert.equal(idx(h, g), idx(h, m3) + 1);
  for (const x of ts) {
    assert.equal(x.getAttribute("data-phase"), "done");
    assert.equal(one(x, "bt-del").hidden, false);
    assert.equal(one(x, "bt-take").hidden, true);
  }
  assert.equal(one(a, "bt-host").textContent, "example.com", "the host comes from the shot's name");
  assert.equal(one(g, "bt-host").textContent, "Browser", "an empty host reads as the neutral label");
  assert.equal(one(a, "bt-img").src, u("browser-example.com-20261028-090030.jpg"));
  assert.equal(byClass(h.transcript, "filecard").length, 0, "never a sent-file card");
  // the same shot arriving as a live done frame (the subscribe seam) is not a second tile
  h.api.browserFrame({ type: "browser", phase: "done", anchor: "call_a", domain: "example.com", shot: { id: 30, url: u("browser-example.com-20261028-090030.jpg") }, note: null });
  await tick();
  assert.equal(tiles(h.transcript).length, 2);
  // newer than every row: the end
  h.api.browserHistory([{ id: 40, name: "browser-z.example-20261028-235900.jpg", url: u("browser-z.example-20261028-235900.jpg"), turn_anchor: null, created_at: "2026-10-28 23:59:00" }]);
  await tick();
  assert.equal(idx(h, tiles(h.transcript).find((x) => one(x, "bt-host").textContent === "z.example")), h.transcript.children.length - 1);
  // malformed rows are skipped
  h.api.browserHistory([{ id: 41, url: "https://elsewhere.example/x.jpg", created_at: "" }, null, { url: u("x.jpg") }]);
  await tick();
  assert.equal(tiles(h.transcript).length, 3);
});

test("Delete screenshot removes the tile after a 200", async () => {
  const h = mount();
  const u = API + "/interactive/" + SID + "/workspace/browser-example.com-20261028-090030.jpg";
  h.api.browserHistory([{ id: 30, name: "browser-example.com-20261028-090030.jpg", url: u, turn_anchor: null, created_at: "2026-10-28 09:00:30" }]);
  await tick();
  const t = tiles(h.transcript)[0];
  const del = one(t, "bt-del");
  del.onclick(); del.onclick();
  const dels = h.calls.filter((c) => c.method === "DELETE");
  assert.equal(dels.length, 1, "one request for a double tap");
  assert.equal(dels[0].url, API + "/interactive/" + SID + "/browser-shots/30");
  assert.equal(dels[0].opts.headers["X-Crow-Csrf"], "tok-123", "the hub's CSRF header");
  assert.equal(del.disabled, true);
  // a failure keeps the tile and re-enables the button
  dels[0].settled = true;
  dels[0].resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: "x" }) });
  await tick();
  assert.equal(tiles(h.transcript).length, 1);
  assert.equal(del.disabled, false);
  del.onclick();
  const d2 = h.calls.filter((c) => c.method === "DELETE")[1];
  d2.settled = true;
  d2.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
  await tick();
  assert.equal(tiles(h.transcript).length, 0, "gone after the 200");
});

test("no IntersectionObserver: the tile counts as on screen", async () => {
  const h = mount({ io: false });
  await liveTile(h, "call_1");
  assert.equal(h.pending().length, 1);
});

// ---------------------------------------------------------------------------
// R1.2 PR 2: in new mode the chip sits inside a "See what happened" group
// ---------------------------------------------------------------------------
test("new mode: the tile anchors after its chip's group, so folding the group never hides it", async () => {
  const h = mount({ newMode: true });
  msgRow(h, "on it");
  h.api.appendToolChip({ name: "mcp__browser__crow_browser_navigate", toolCallId: "call_1", argsText: "{}" });
  const group = h.transcript.children.find((c) => c.className === "tool-group");
  assert.ok(group, "the chip went into a group");
  assert.equal(chipOf(h, "call_1"), undefined, "the chip is not a transcript child any more");
  const t = await liveTile(h, "call_1");
  assert.equal(idx(h, t), idx(h, group) + 1, "right after the group");
  // the same turn's next chip still joins the group (a tile after it does not close it)
  h.api.appendToolChip({ name: "mcp__browser__crow_browser_click", toolCallId: "call_2", argsText: "{}" });
  assert.equal(h.transcript.children.filter((c) => c.className === "tool-group").length, 1);
  assert.equal(group.children[1].children.length, 2);
  assert.equal(idx(h, t), idx(h, group) + 1, "the tile stays after the group");
  // a history chip anchors after its group by its raw id too
  const h2 = mount({ newMode: true });
  h2.api.appendToolChip({ name: "mcp__browser__crow_browser_snapshot", toolCallId: "hist:call_p" });
  h2.api.finishToolChip({ toolCallId: "hist:call_p", isError: false, resultText: "ok" });
  msgRow(h2, "later");
  const t2 = await liveTile(h2, "call_p");
  const g2 = h2.transcript.children.find((c) => c.className === "tool-group");
  assert.equal(g2.children[1].hidden, true, "a finished history group is folded");
  assert.equal(idx(h2, t2), idx(h2, g2) + 1, "and its tile is outside it, visible");
});
