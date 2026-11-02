// Live browser tile, Task 7: the Take over sheet in the Perch hub (spec
// 2026-10-27 §4.4, §7 items 7 and 13).
//
// The sheet snippet (perch-hub/take-over.js) runs in a vm sandbox together
// with the tile snippet (browser-tile.js) and the REAL csrf / perchApi lifted
// out of the emitted hub, so the CSRF header and the request shapes are the
// shipped ones. The server is scripted per request; timers are captured and
// fired by hand.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { perchHubJs } from "../servers/gateway/dashboard/perch-hub/client.js";
import { perchBrowserTileJs } from "../servers/gateway/dashboard/perch-hub/browser-tile.js";
import { perchTakeOverJs } from "../servers/gateway/dashboard/perch-hub/take-over.js";
import { translations } from "../servers/gateway/dashboard/shared/i18n.js";

const SID = "perchlive-aaaaaaaa";
const API = "/dashboard/perch-api";
const SECRET = "vnc-Secret-77";
const ENTRY = { id: 41, bundle_id: "browser", env_key: "CROW_BROWSER_VNC_PASSWORD", readable: true, label: "VNC viewer password" };

function makeEl(tag) {
  const attrs = {};
  const node = {
    tagName: String(tag || "div").toUpperCase(), children: [], parentNode: null,
    className: "", textContent: "", hidden: false, disabled: false, type: "", value: "", onclick: null,
    style: {}, scrollTop: 0, scrollHeight: 0, alt: "", focused: 0,
    focus() { node.focused += 1; },
    appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); this.children.push(c); c.parentNode = this; return c; },
    insertBefore(c, ref) {
      if (c.parentNode) c.parentNode.removeChild(c);
      const i = ref ? this.children.indexOf(ref) : -1;
      if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
      c.parentNode = this; return c;
    },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; },
    setAttribute(k, v) { attrs[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null; },
    removeAttribute(k) { delete attrs[k]; },
    get firstChild() { return this.children[0] || null; },
  };
  Object.defineProperty(node, "innerHTML", { set() { throw new Error("innerHTML sink reached"); }, get() { return ""; } });
  return node;
}
function walk(n, fn) { fn(n); for (const c of n.children) walk(c, fn); }
function byClass(n, cls) { const o = []; walk(n, (x) => { if (String(x.className || "").split(/\s+/).includes(cls)) o.push(x); }); return o; }
const one = (n, cls) => byClass(n, cls)[0];
const tick = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

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

/**
 * `server(call)` answers each request: { status, body } (or a Promise of it).
 * Default: take-over/heartbeat held, hand-back idle; the keychain still answers
 * with an old install's VNC entry, which the sheet must never ask for.
 */
function mount({ server, clipboard = "ok", search = "", lang = "en" } = {}) {
  const hub = perchHubJs(lang);
  const root = makeEl("div");
  const transcript = makeEl("div");
  const mine = makeEl("button"); mine.hidden = true; mine.className = "browser-mine";
  const calls = [];
  const logs = [];
  const answer = server || ((c) => {
    if (c.path.endsWith("/browser/take-over")) return { status: 200, body: { state: "held" } };
    if (c.path.endsWith("/browser/heartbeat")) return { status: 200, body: { state: "held" } };
    if (c.path.endsWith("/browser/hand-back")) return { status: 200, body: { state: "idle" } };
    if (c.path.endsWith("/keychain/api/entries")) return { status: 200, body: { entries: [ENTRY], reauth_method: "password" } };
    if (c.path.endsWith("/keychain/api/reveal")) return { status: 200, body: { secret: SECRET } };
    return { status: 404, body: {} };
  });
  const fetchFn = (url, opts = {}) => {
    const c = { url: String(url), path: String(url).split("?")[0], method: opts.method || "GET", headers: opts.headers || {}, body: opts.body ? JSON.parse(opts.body) : undefined };
    calls.push(c);
    return Promise.resolve(answer(c)).then((r) => ({ ok: r.status >= 200 && r.status < 300, status: r.status, json: () => Promise.resolve(r.body) }));
  };
  const timers = new Map(); let tseq = 1;
  const docT = new EventTarget();
  const handlers = {};
  const written = [];
  const nav = {};
  if (clipboard === "ok") nav.clipboard = { writeText: (s) => { written.push(s); return Promise.resolve(); } };
  else if (clipboard === "reject") nav.clipboard = { writeText: (s) => { written.push(s); return Promise.reject(new Error("NotAllowedError")); } };
  const loc = { search, pathname: "/dashboard/perch", hash: "#" + SID };
  const replaced = [];
  const doc = {
    visibilityState: "visible", cookie: "crow_csrf=tok-9", body: makeEl("body"),
    createElement: (t) => makeEl(t),
    addEventListener: (...a) => docT.addEventListener(...a),
    dispatchEvent: (ev) => docT.dispatchEvent(ev),
  };
  const sandbox = {
    console: { log: (...a) => logs.push(a.join(" ")), warn: (...a) => logs.push(a.join(" ")), error: (...a) => logs.push(a.join(" ")) },
    document: doc, window: { innerWidth: 390 }, API, HUB: { streams: {} }, navigator: nav,
    location: loc, history: { state: null, replaceState: (st, t, url) => replaced.push(url) },
    current: { sid: SID },
    el: (id) => (id === "perch-hub-root" ? root : id === "perch-transcript" ? transcript : id === "perch-browser-mine" ? mine : null),
    live: () => !sandbox.__retired,
    bindOnce: (target, type, key, fn) => { handlers[key] = fn; target.addEventListener(type, (ev) => { const h = handlers[key]; if (h) h(ev); }); },
    fetch: fetchFn,
    setTimeout: (fn, ms) => { const id = tseq++; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    AbortController, CustomEvent, Event, Date, Math, JSON, Promise, encodeURIComponent, Number, String, Array,
    __export(api) { sandbox.api = api; },
  };
  sandbox.line = (cls, text) => { const d = makeEl("div"); if (cls) d.className = cls; d.textContent = text == null ? "" : String(text); return d; };
  vm.createContext(sandbox);
  const lifted = ["csrf", "perchApi"].map((n) => lift(hub, n)).join("\n");
  vm.runInContext(`(function(){\n${lifted}\n${perchBrowserTileJs(lang)}\n${perchTakeOverJs(lang)}\n;__export({ closeTakeOver: closeTakeOver, takeOverFromLink: takeOverFromLink, browserFrame: browserFrame, toMineRefresh: toMineRefresh });\n})();`, sandbox);
  const sheet = () => one(root, "ph-tosheet") || null;
  const fire = async (ms) => {
    const due = [...timers.entries()].filter(([, t]) => ms == null || t.ms === ms);
    for (const [id, t] of due) { timers.delete(id); t.fn(); }
    await tick();
  };
  const open = async (detail = { sid: SID, anchor: "call_1" }) => { doc.dispatchEvent(new CustomEvent("perch:browser-takeover", { detail })); await tick(); };
  const posts = (suffix) => calls.filter((c) => c.method === "POST" && c.path.endsWith(suffix));
  const click = async (n) => { n.onclick(); await tick(); };
  return { sandbox, api: sandbox.api, root, transcript, mine, calls, posts, timers, fire, open, sheet, written, logs, replaced, doc, handlers, click };
}

// ---------------------------------------------------------------------------

test("the snippet has no backtick or stray ${, is spliced into the hub, parses, and the hub closes it on retire and opens it from a link", () => {
  for (const lang of ["en", "es"]) {
    const js = perchTakeOverJs(lang);
    assert.equal(js.includes("`"), false);
    assert.equal(js.includes("${"), false);
    assert.ok(!/\.innerHTML\s*\+?=|\.outerHTML\s*\+?=|insertAdjacentHTML\s*\(|document\.write\s*\(/.test(js), "no HTML sink");
    assert.ok(!/console\./.test(js), "nothing is logged");
    const hub = perchHubJs(lang);
    assert.ok(hub.includes(js), "spliced verbatim");
    assert.doesNotThrow(() => new Function(hub), lang + " hub parses");
  }
  const src = readFileSync(new URL("../servers/gateway/dashboard/perch-hub/take-over.js", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("return `") + 8, src.lastIndexOf("`;"));
  assert.equal((body.match(/\$\{/g) || []).length, (body.match(/\$\{tJs\("/g) || []).length, "the only ${ are tJs interpolations");
  const hub = perchHubJs("en");
  assert.match(hub, /HUB\.retire=function\(\)\{[\s\S]*?closeTakeOver\(\);[\s\S]*?\};/, "a Turbo retire closes the sheet");
  assert.match(hub, /else \{ startListPolling\(\); loadList\(\); \}\n\s*takeOverFromLink\(\);\n\s*toMineRefresh\(\);\n\}\)\(\);/, "the bootstrap honours ?take-over=1");
  const retire = lift(hub, "closeTakeOver");
  assert.doesNotMatch(retire, /hand-back/, "closing the UI never hands back");
});

test("the strings are exact (en + es) in the Browser tile block", () => {
  const want = {
    "perch.handBack": ["Hand back", "Devolver"],
    "perch.botFinishing": ["The bot is finishing its step…", "El bot está terminando su paso…"],
    "browser.botUsing": ["A bot is using the browser", "Un bot está usando el navegador"],
  };
  const i18nSrc = readFileSync(new URL("../servers/gateway/dashboard/shared/i18n.js", import.meta.url), "utf8");
  const block = i18nSrc.slice(i18nSrc.indexOf("// ─── Browser tile ───"));
  for (const [k, [en, es]] of Object.entries(want)) {
    assert.equal(translations[k].en, en, k);
    assert.equal(translations[k].es, es, k);
    assert.ok(block.includes('"' + k + '"'), k + " sits in the Browser tile block");
  }
  // The viewer has no password of its own any more (loopback VNC behind sign-in).
  assert.equal(translations["perch.copyPassword"], undefined);
  assert.equal(translations["perch.noPassword"], undefined);
});

test("Take over (the tile's button or a tap on the picture) opens a full-screen sheet with the noVNC viewer, the domain and Hand back; Hand back closes it", async () => {
  const h = mount();
  h.api.browserFrame({ type: "browser", phase: "live", anchor: "call_1", domain: "shop.example.test", gen: 2 });
  await tick();
  const tile = one(h.transcript, "ph-btile");
  assert.ok(tile, "the live tile is drawn");
  await h.click(one(tile, "bt-take"));   // the tile's own Take over button
  const s = h.sheet();
  assert.ok(s, "the sheet is open");
  assert.equal(s.getAttribute("role"), "dialog");
  assert.equal(s.getAttribute("aria-modal"), "true");
  const tk = h.posts("/browser/take-over");
  assert.equal(tk.length, 1);
  assert.equal(tk[0].path, API + "/browser/take-over");
  assert.equal(tk[0].headers["X-Crow-Csrf"], "tok-9", "CSRF header");
  assert.equal(one(s, "to-host").textContent, "shop.example.test");
  const vnc = one(s, "to-vnc");
  assert.ok(vnc, "the viewer loads once held");
  assert.equal(vnc.getAttribute("src"), "/proxy/browser/vnc.html?autoconnect=true&resize=scale&view_only=false");
  const back = one(s, "to-back");
  assert.equal(back.textContent, "Hand back");
  assert.ok(back.focused > 0, "focus lands on Hand back");
  // a second Take over while open: no second sheet, no second request
  await h.open();
  assert.equal(byClass(h.root, "ph-tosheet").length, 1);
  assert.equal(h.posts("/browser/take-over").length, 1);
  await h.click(back);
  assert.equal(h.posts("/browser/hand-back").length, 1);
  assert.equal(h.posts("/browser/hand-back")[0].headers["X-Crow-Csrf"], "tok-9");
  assert.equal(h.sheet(), null, "closed");
  assert.equal([...h.timers.values()].filter((t) => t.ms === 15000).length, 0, "no heartbeat left running");
  // a tap on the live picture opens it too
  await h.click(one(tile, "bt-frame"));
  assert.ok(h.sheet(), "the picture is a Take over control");
  assert.equal(h.posts("/browser/take-over").length, 2);
});

test("pending: \"The bot is finishing its step…\" and no viewer until the switch; then the heartbeat every 15 s", async () => {
  let state = "pending";
  const h = mount({ server: (c) => {
    if (/take-over|heartbeat/.test(c.path)) return { status: 200, body: { state } };
    if (c.path.endsWith("/entries")) return { status: 200, body: { entries: [] } };
    return { status: 200, body: { state: "idle" } };
  } });
  await h.open();
  const s = h.sheet();
  const st = one(s, "to-status");
  assert.equal(st.textContent, "The bot is finishing its step…");
  assert.equal(st.hidden, false);
  assert.equal(st.getAttribute("role"), "status");
  assert.equal(one(s, "to-vnc"), undefined, "no viewer while the bot finishes");
  assert.equal([...h.timers.values()].filter((t) => t.ms === 1000).length, 1, "checks again in 1 s");
  await h.fire(1000);
  assert.equal(h.posts("/browser/heartbeat").length, 1);
  assert.equal(one(s, "to-vnc"), undefined);
  state = "held";
  await h.fire(1000);
  assert.ok(one(s, "to-vnc"), "switched: the viewer loads");
  assert.equal(st.textContent, "Waiting for you", "held: the bot is paused on the operator");
  assert.equal(st.hidden, false);
  assert.equal([...h.timers.values()].filter((t) => t.ms === 15000).length, 1, "heartbeat every 15 s");
  await h.fire(15000);
  assert.equal(h.posts("/browser/heartbeat").length, 3);
  assert.equal([...h.timers.values()].filter((t) => t.ms === 15000).length, 1, "and again");
});

test("a Turbo retire or a hidden tab closes the UI only: no hand back, no timer left; the server's idle (5-minute loss) closes it too", async () => {
  const h = mount();
  await h.open();
  assert.ok(h.sheet());
  h.doc.visibilityState = "hidden";
  h.doc.dispatchEvent(new Event("visibilitychange"));
  await tick();
  assert.ok(h.sheet(), "a hidden tab does not close or hand back");
  h.api.closeTakeOver();   // what HUB.retire runs
  assert.equal(h.sheet(), null);
  assert.equal(h.posts("/browser/hand-back").length, 0, "never hands back");
  assert.equal([...h.timers.values()].filter((t) => t.ms === 15000).length, 0, "the heartbeat timer is gone");
  // reopening re-takes (a renewal on the server) and resumes
  await h.open();
  assert.ok(h.sheet());
  assert.equal(h.posts("/browser/take-over").length, 2);

  let hb = "held";
  const h2 = mount({ server: (c) => (/heartbeat/.test(c.path) ? { status: 200, body: { state: hb } } : c.path.endsWith("/take-over") ? { status: 200, body: { state: "held" } } : { status: 200, body: { entries: [] } }) });
  await h2.open();
  hb = "idle";
  await h2.fire(15000);
  assert.equal(h2.sheet(), null, "the browser went back on the server: the sheet closes");
  assert.equal(h2.posts("/browser/hand-back").length, 0);
});

test("browser busy (503): the sheet says so and stays; Hand back still works", async () => {
  const h = mount({ server: (c) => (c.path.endsWith("/take-over") ? { status: 503, body: { error: "browser_busy" } } : c.path.endsWith("/hand-back") ? { status: 200, body: { state: "idle" } } : { status: 200, body: { entries: [] } }) });
  await h.open();
  const st = one(h.sheet(), "to-status");
  assert.equal(st.textContent, translations["shell.offerFailed"].en);
  assert.equal(one(h.sheet(), "to-vnc"), undefined);
  await h.click(one(h.sheet(), "to-back"));
  assert.equal(h.sheet(), null);
});

test("no VNC password: the sheet has no Copy row or re-auth, never asks the keychain, and its viewer URL carries no password", async () => {
  // The keychain may still hold an entry from an older install: it is never read.
  const h = mount({ clipboard: "reject" });
  await h.open();
  const s = h.sheet();
  assert.ok(one(s, "to-vnc"), "the viewer loads");
  for (const cls of ["to-pw-row", "to-copy", "to-hint", "to-pw", "to-reauth", "to-reauth-input"]) {
    assert.equal(byClass(s, cls).length, 0, "no " + cls);
  }
  assert.equal(h.calls.filter((c) => c.url.includes("/keychain/")).length, 0, "no keychain request");
  const src = one(s, "to-vnc").getAttribute("src");
  assert.equal(src, "/proxy/browser/vnc.html?autoconnect=true&resize=scale&view_only=false", "autoconnects through the proxy");
  assert.doesNotMatch(src, /password/i);
  assert.deepEqual(h.written, [], "nothing goes to the clipboard");
  h.api.closeTakeOver();
  assert.equal(h.sheet(), null);
  for (const lang of ["en", "es"]) {
    const js = perchTakeOverJs(lang);
    assert.doesNotMatch(js, /VNC_PASSWORD|keychain|\/reveal|password=/i, lang + ": no password plumbing left");
  }
});

test("a ?take-over=1 link (the wait_for_user attention item) opens the sheet once and drops the flag", async () => {
  const h = mount({ search: "?take-over=1" });
  h.api.takeOverFromLink();
  await tick();
  assert.ok(h.sheet());
  assert.deepEqual(h.replaced, ["/dashboard/perch#" + SID], "the flag leaves the URL");
  const h2 = mount({ search: "?bot=x&take-over=1" });
  h2.api.takeOverFromLink();
  await tick();
  assert.deepEqual(h2.replaced, ["/dashboard/perch?bot=x#" + SID]);
  const h3 = mount({ search: "?take-over=10" });
  h3.api.takeOverFromLink();
  await tick();
  assert.equal(h3.sheet(), null, "only the exact flag");
  // the link marker rides the request (the server checks that chat's live turn)
  assert.deepEqual(h.posts("/browser/take-over")[0].body, { from: "link", sid: SID });
  // the tile's own button carries no marker
  const h4 = mount();
  await h4.open();
  assert.equal(h4.posts("/browser/take-over")[0].body, undefined);
  // the Browser panel's own take-over (a non-Perch holder): no marker either
  const h5 = mount({ search: "?take-over=panel" });
  h5.api.takeOverFromLink();
  await tick();
  assert.ok(h5.sheet());
  assert.equal(h5.posts("/browser/take-over")[0].body, undefined);
  assert.deepEqual(h5.replaced, ["/dashboard/perch#" + SID]);
});

test("a stale link (409 no_live_turn) never takes the browser: the sheet says the bot is no longer waiting; Hand back closes it", async () => {
  const h = mount({ search: "?take-over=1", server: (c) => (c.path.endsWith("/take-over") ? { status: 409, body: { error: "no_live_turn" } } : c.path.endsWith("/hand-back") ? { status: 200, body: { state: "idle" } } : { status: 200, body: { entries: [] } }) });
  h.api.takeOverFromLink();
  await tick();
  assert.ok(h.sheet(), "not a silent close");
  const st = one(h.sheet(), "to-status");
  assert.equal(st.textContent, "The bot is no longer waiting for you.");
  assert.equal(st.hidden, false);
  assert.equal(one(h.sheet(), "to-vnc"), undefined, "no viewer");
  assert.equal(h.posts("/browser/take-over").length, 1);
  assert.equal([...h.timers.values()].filter((t) => t.ms === 1000 || t.ms === 15000).length, 0, "nothing keeps running");
  await h.click(one(h.sheet(), "to-back"));
  assert.equal(h.sheet(), null);
  assert.equal(translations["perch.browserNotWaiting"].es, "El bot ya no te está esperando.");
});

test("B10: a dead-link sheet's Hand back only closes it: no hand-back request, a live operator holding elsewhere (tab A) is untouched and its control returns", async () => {
  const h = mount({ search: "?take-over=1", server: (c) => (c.path.endsWith("/take-over") ? { status: 409, body: { error: "other_bot" } } : c.path.endsWith("/browser/state") ? { status: 200, body: { state: "held" } } : c.path.endsWith("/hand-back") ? { status: 200, body: { state: "idle" } } : { status: 200, body: { entries: [] } }) });
  h.mine.hidden = false;   // tab A's operator holding: "You have the browser · Hand back"
  h.api.takeOverFromLink();
  await tick();
  assert.equal(one(h.sheet(), "to-status").textContent, "The bot is no longer waiting for you.");
  assert.equal(h.mine.hidden, true, "the open sheet hides the control");
  await h.click(one(h.sheet(), "to-back"));
  assert.equal(h.sheet(), null, "closed");
  assert.equal(h.posts("/browser/hand-back").length, 0, "no hand back sent");
  assert.equal(h.mine.hidden, false, "the holding is intact: its control returns");
  // a live sheet's Hand back still hands back
  const live = mount();
  await live.open();
  await live.click(one(live.sheet(), "to-back"));
  assert.equal(live.posts("/browser/hand-back").length, 1);
});

test("a Done tile whose turn asked for the operator keeps Take over, and its tap asks like a link", async () => {
  const h = mount();
  h.api.browserFrame({ type: "browser", phase: "live", anchor: "call_9", domain: "bank.example.test", gen: 1 });
  h.api.browserFrame({ type: "browser", phase: "done", anchor: "call_9", domain: "bank.example.test", shot: null, note: null, ask: true });
  await tick();
  const tile = one(h.transcript, "ph-btile");
  assert.equal(tile.getAttribute("data-phase"), "done");
  const take = one(tile, "bt-take");
  assert.equal(take.hidden, false, "kept");
  await h.click(take);
  assert.ok(h.sheet());
  assert.deepEqual(h.posts("/browser/take-over")[0].body, { from: "link", sid: SID }, "checked against the ask window");
  // without the ask, a Done tile has no Take over (as before)
  const g = mount();
  g.api.browserFrame({ type: "browser", phase: "live", anchor: "call_8", domain: null, gen: 1 });
  g.api.browserFrame({ type: "browser", phase: "done", anchor: "call_8", domain: null, shot: null, note: null });
  await tick();
  assert.equal(one(one(g.transcript, "ph-btile"), "bt-take").hidden, true);
});

test("\"You have the browser · Hand back\": shown on load while held or pending, a tap hands back and hides it; hidden while the sheet is open", async () => {
  for (const state of ["held", "pending"]) {
    const h = mount({ server: (c) => (c.path.endsWith("/browser/state") ? { status: 200, body: { state } } : c.path.endsWith("/hand-back") ? { status: 200, body: { state: "idle" } } : { status: 200, body: { entries: [] } }) });
    h.api.toMineRefresh();
    await tick();
    assert.equal(h.mine.hidden, false, state + ": shown");
    assert.equal(h.calls.find((c) => c.path.endsWith("/browser/state")).method, "GET");
    h.mine.onclick(); h.mine.onclick();
    await tick();
    assert.equal(h.posts("/browser/hand-back").length, 1, "one hand back");
    assert.equal(h.posts("/browser/hand-back")[0].headers["X-Crow-Csrf"], "tok-9");
    assert.equal(h.mine.hidden, true, "gone after hand back");
  }
  const idle = mount({ server: (c) => (c.path.endsWith("/browser/state") ? { status: 200, body: { state: "idle" } } : { status: 200, body: { entries: [] } }) });
  idle.api.toMineRefresh();
  await tick();
  assert.equal(idle.mine.hidden, true, "idle: hidden");
  const o = mount();
  o.mine.hidden = false;
  await o.open();
  assert.equal(o.mine.hidden, true, "the open sheet has its own Hand back");
  const hubSrc = perchHubJs("en");
  assert.match(hubSrc, /takeOverFromLink\(\);\n\s*toMineRefresh\(\);\n\}\)\(\);/, "refreshed on every hub load");
  const html = readFileSync(new URL("../servers/gateway/dashboard/perch-hub/html.js", import.meta.url), "utf8");
  assert.match(html, /<button type="button" class="browser-mine" id="perch-browser-mine" hidden>\$\{escapeHtml\(t\("perch.youHaveBrowser", lang\)\)\} · \$\{escapeHtml\(t\("perch.handBack", lang\)\)\}<\/button>/);
  assert.equal(translations["perch.youHaveBrowser"].en, "You have the browser");
  assert.equal(translations["perch.youHaveBrowser"].es, "Tienes tú el navegador");
});

test("a failed check while pending keeps checking every 1 s (never stuck); pending that ends idle says it failed and stops", async () => {
  const answers = ["pending", 503, "pending", "held"];
  const h = mount({ server: (c) => {
    if (c.path.endsWith("/entries")) return { status: 200, body: { entries: [] } };
    if (/take-over|heartbeat/.test(c.path)) {
      const a = answers.shift();
      return typeof a === "number" ? { status: a, body: { error: "browser_busy" } } : { status: 200, body: { state: a } };
    }
    return { status: 200, body: { state: "idle" } };
  } });
  await h.open();
  const st = one(h.sheet(), "to-status");
  await h.fire(1000);   // 503
  assert.equal(st.textContent, translations["shell.offerFailed"].en);
  assert.equal([...h.timers.values()].filter((t) => t.ms === 1000).length, 1, "still checking");
  await h.fire(1000);   // pending
  assert.equal(st.textContent, "The bot is finishing its step…");
  await h.fire(1000);   // held
  assert.ok(one(h.sheet(), "to-vnc"));

  const g = mount({ server: (c) => (c.path.endsWith("/take-over") ? { status: 200, body: { state: "pending" } } : c.path.endsWith("/heartbeat") ? { status: 200, body: { state: "idle" } } : { status: 200, body: { entries: [] } }) });
  await g.open();
  await g.fire(1000);
  assert.ok(g.sheet(), "the sheet stays so the operator sees why");
  assert.equal(one(g.sheet(), "to-status").textContent, translations["shell.offerFailed"].en);
  assert.equal(one(g.sheet(), "to-vnc"), undefined);
  assert.equal([...g.timers.values()].filter((t) => t.ms === 1000 || t.ms === 15000).length, 0, "stopped");
});

test("Spanish sheet strings", async () => {
  const h = mount({ lang: "es", server: (c) => (c.path.endsWith("/entries") ? { status: 200, body: { entries: [] } } : { status: 200, body: { state: "pending" } }) });
  await h.open();
  assert.equal(one(h.sheet(), "to-back").textContent, "Devolver");
  assert.equal(one(h.sheet(), "to-status").textContent, "El bot está terminando su paso…");
});

test("the sheet's CSS: full screen, 44 px targets, Perch tokens only", () => {
  const css = readFileSync(new URL("../servers/gateway/dashboard/perch-hub/css.js", import.meta.url), "utf8");
  const block = css.split("\n").filter((l) => l.includes(".ph-tosheet")).join("\n");
  assert.match(block, /\.ph-tosheet\{position:fixed;inset:0/);
  assert.match(block, /\.ph-tosheet button\{min-height:44px;min-width:44px/);
  assert.match(block, /\.ph-tosheet \[hidden\]\{display:none\}/);
  assert.equal(/#[0-9a-f]{3,8}\b|rgb\(/i.test(block), false, "no literal colours");
});
