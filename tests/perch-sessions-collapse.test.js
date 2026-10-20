// Perch: the Sessions column collapses on desktop (2026-10-20).
//
// At and above the split breakpoint the session list sits in a 320px column
// beside the open chat. The operator can hide it (#perch-list-collapse, in the
// Sessions heading row) and bring it back (#perch-list-reveal, first in the
// chat head) — the same pair the shell's own sidebar uses. The choice persists
// per device in localStorage. Below the breakpoint nothing changes: the phone
// already shows one view at a time.
//
// Static + unit checks here run without a browser; the live layout checks
// further down drive the real page in a private headless Chrome
// (tests/fixtures/headless-chrome.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";

const PERCH = "../servers/gateway/dashboard/perch-hub/";

// ─── static: markup ─────────────────────────────────────────────────────────

/** The opening tag of the element with this id, or null. */
function tagFor(html, id) {
  const m = html.match(new RegExp('<[a-z]+[^>]*\\bid="' + id + '"[^>]*>'));
  return m ? m[0] : null;
}

for (const [lang, hide, show, heading] of [
  ["en", "Hide sessions", "Show sessions", "Sessions"],
  ["es", "Ocultar sesiones", "Mostrar sesiones", "Sesiones"],
]) {
  test(`markup (${lang}): a collapse button and a reveal button, both real controls of #perch-list`, async () => {
    const { perchHubContent } = await import(PERCH + "html.js");
    const html = perchHubContent(lang);
    const collapse = tagFor(html, "perch-list-collapse");
    const reveal = tagFor(html, "perch-list-reveal");
    assert.ok(collapse, "#perch-list-collapse must exist");
    assert.ok(reveal, "#perch-list-reveal must exist");
    for (const tag of [collapse, reveal]) {
      assert.match(tag, /^<button\b/, "a real <button>: Enter and Space come for free");
      assert.match(tag, /\btype="button"/);
      assert.match(tag, /\baria-controls="perch-list"/);
      // "true" on purpose: without JS the list is on screen, so "true" is the
      // honest server value; the client corrects it from localStorage.
      assert.match(tag, /\baria-expanded="true"/);
    }
    assert.match(collapse, new RegExp('aria-label="' + hide + '"'));
    assert.match(reveal, new RegExp('aria-label="' + show + '"'));
    // The reveal button's visible text is the heading word, so a sighted
    // operator reads "Sessions" and a screen reader hears "Show sessions"
    // (label-in-name holds: the visible word is inside the accessible name).
    const revealBody = html.slice(html.indexOf(reveal) + reveal.length, html.indexOf("</button>", html.indexOf(reveal)));
    assert.equal(revealBody.replace(/<svg[\s\S]*?<\/svg>/g, "").trim(), heading);
  });
}

test("markup: the collapse button sits BESIDE the Sessions heading, not inside the <h2>", async () => {
  const { perchHubContent } = await import(PERCH + "html.js");
  const html = perchHubContent("en");
  const list = html.indexOf('id="perch-list"');
  const h2 = html.indexOf("<h2", list);
  const h2End = html.indexOf("</h2>", h2);
  const btn = html.indexOf('id="perch-list-collapse"');
  assert.ok(h2 > list && btn > list, "both inside #perch-list");
  assert.ok(btn > h2End, "a button inside a heading would make the heading's name include it");
  assert.ok(btn < html.indexOf('id="perch-launch"'), "and in the heading row, above the launcher");
  // The row that wraps them.
  const row = html.lastIndexOf('class="perch-list-head"', h2);
  assert.ok(row > list && row < h2, "h2 + collapse button share one .perch-list-head row");
});

test("markup: the reveal button leads the chat head, before ← Sessions", async () => {
  const { perchHubContent } = await import(PERCH + "html.js");
  const html = perchHubContent("en");
  const head = html.indexOf('class="perch-head"');
  const reveal = html.indexOf('id="perch-list-reveal"');
  const back = html.indexOf('id="perch-back"');
  assert.ok(head > -1 && reveal > head && reveal < back);
});

// ─── static: CSS ────────────────────────────────────────────────────────────

/** The body of the first `@media (min-width:900px){...}` block, brace-matched. */
function mediaBlock(css, query) {
  const at = css.indexOf("@media " + query);
  if (at < 0) return null;
  let depth = 0;
  for (let i = css.indexOf("{", at); i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") { depth--; if (!depth) return { start: at, end: i, body: css.slice(css.indexOf("{", at) + 1, i) }; }
  }
  return null;
}

test("CSS: the collapse rules live in their own module, scoped to wide + chat-open", async () => {
  const { perchSessionsCollapseCss } = await import(PERCH + "sessions-collapse-css.js");
  const { PERCH_SPLIT_MIN_WIDTH } = await import(PERCH + "css.js");
  const css = perchSessionsCollapseCss();
  const m = mediaBlock(css, "(min-width:" + PERCH_SPLIT_MIN_WIDTH + "px)");
  assert.ok(m, "a min-width:" + PERCH_SPLIT_MIN_WIDTH + "px block, from the shared constant");
  // Every rule that reads the collapsed class is inside that block, AND keyed
  // on an open chat: with no session open the chat pane is display:none even
  // on desktop, so hiding the list there would leave an empty page.
  const outside = css.slice(0, m.start) + css.slice(m.end + 1);
  assert.ok(!/sessions-collapsed/.test(outside), "no collapse rule may apply below the breakpoint");
  const rules = m.body.split("}").filter((r) => /sessions-collapsed/.test(r));
  assert.ok(rules.length >= 3, "list hidden, grid single-column, reveal shown");
  for (const r of rules) assert.match(r, /body\[data-view="chat"\]/, "keyed on an open chat: " + r.trim());
  // The grid must collapse to ONE track: with #perch-list display:none the
  // chat would otherwise land in the 320px column.
  assert.match(m.body, /sessions-collapsed[^{]*\.hub-split\{[^}]*grid-template-columns:minmax\(0,1fr\)/);
  assert.match(m.body, /sessions-collapsed[^{]*#perch-list\{[^}]*display:none/);
});

test("CSS: both buttons are hidden by default, i.e. on the phone and with no chat open", async () => {
  const { perchSessionsCollapseCss } = await import(PERCH + "sessions-collapse-css.js");
  const css = perchSessionsCollapseCss();
  const m = mediaBlock(css, "(min-width:900px)");
  const outside = css.slice(0, m.start) + css.slice(m.end + 1);
  for (const id of ["perch-list-collapse", "perch-list-reveal"]) {
    assert.match(outside, new RegExp("#" + id + "[^{]*\\{[^}]*display:none"), "#" + id + " hidden at base");
  }
});

test("CSS: no unscoped selectors leak onto the shell", async () => {
  const { perchSessionsCollapseCss } = await import(PERCH + "sessions-collapse-css.js");
  const css = perchSessionsCollapseCss().replace(/\/\*[\s\S]*?\*\//g, "");
  for (const rule of css.split("}")) {
    const body = rule.replace(/@media[^{]*\{/, "");
    const sel = body.slice(0, body.indexOf("{")).trim();
    if (!sel) continue;
    for (const part of sel.split(",")) {
      assert.match(part.trim(), /#perch-(hub-root|list|chat)/, "unscoped selector: " + part.trim());
    }
  }
});

test("html.js appends the collapse CSS after the main sheet (so it wins at equal specificity)", async () => {
  const { perchHubContent } = await import(PERCH + "html.js");
  const { perchHubCss } = await import(PERCH + "css.js");
  const { perchSessionsCollapseCss } = await import(PERCH + "sessions-collapse-css.js");
  const html = perchHubContent("en");
  const main = html.indexOf(perchHubCss());
  const extra = html.indexOf(perchSessionsCollapseCss());
  assert.ok(main > -1 && extra > main, "the module's CSS follows perchHubCss() in the page");
  assert.ok(extra < html.indexOf("</style>"), "inside the same <style>");
});

// ─── i18n ───────────────────────────────────────────────────────────────────

test("i18n: the hide/show labels exist in English and Spanish", async () => {
  const { t } = await import("../servers/gateway/dashboard/shared/i18n.js");
  assert.equal(t("perch.hideSessions", "en"), "Hide sessions");
  assert.equal(t("perch.hideSessions", "es"), "Ocultar sesiones");
  assert.equal(t("perch.showSessions", "en"), "Show sessions");
  assert.equal(t("perch.showSessions", "es"), "Mostrar sesiones");
});

// ─── unit: client.js ────────────────────────────────────────────────────────

function maskComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));
}
/** Pull one named function out of the emitted script (the
 *  perch-hub-client.test.js pattern). `extra` declares its free variables. */
async function extract(name, extra = "") {
  const { perchHubJs } = await import(PERCH + "client.js");
  const src = perchHubJs("en");
  const start = src.indexOf("function " + name + "(");
  assert.ok(start > -1, name + " is not in the emitted script");
  const masked = maskComments(src);
  let depth = 0, end = -1;
  for (let i = masked.indexOf("{", start); i < masked.length; i++) {
    if (masked[i] === "{") depth++;
    else if (masked[i] === "}") { depth--; if (!depth) { end = i; break; } }
  }
  return new Function(extra + src.slice(start, end + 1) + "; return " + name + ";")();
}

/** A localStorage stand-in. `throws` makes every access throw, the way a
 *  private window or blocked site data does. */
function fakeStorage({ throws = false, initial = {} } = {}) {
  const map = { ...initial };
  return {
    map,
    getItem(k) { if (throws) throw new Error("SecurityError"); return Object.hasOwn(map, k) ? map[k] : null; },
    setItem(k, v) { if (throws) throw new Error("QuotaExceededError"); map[k] = String(v); },
  };
}

test("readCollapsed: false when storage is empty or throws, true only on '1'", async () => {
  const KEY = "crow-perch-sessions-collapsed";
  const run = async (storage) => {
    globalThis.__ls = storage;
    const f = await extract("readCollapsed", "var window={get localStorage(){ return globalThis.__ls; }};");
    return f();
  };
  assert.equal(await run(fakeStorage()), false);
  assert.equal(await run(fakeStorage({ throws: true })), false);
  assert.equal(await run(fakeStorage({ initial: { [KEY]: "0" } })), false);
  assert.equal(await run(fakeStorage({ initial: { [KEY]: "1" } })), true);
  // A getter that itself throws (some browsers throw on the property access).
  globalThis.__ls = undefined;
  const f = await extract("readCollapsed",
    "var window={get localStorage(){ throw new Error('SecurityError'); }};");
  assert.equal(f(), false);
  delete globalThis.__ls;
});

/** A minimal DOM for setSessionsCollapsed / toggleSessions. */
function fakeDom() {
  const node = (id) => ({ id, className: "", attrs: {}, focused: false,
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return Object.hasOwn(this.attrs, k) ? this.attrs[k] : null; },
    focus() { dom.focusLog.push({ id, rootClass: dom.nodes["perch-hub-root"].className }); } });
  const dom = { focusLog: [], polls: 0, nodes: {} };
  for (const id of ["perch-hub-root", "perch-list-collapse", "perch-list-reveal"]) dom.nodes[id] = node(id);
  dom.nodes["perch-hub-root"].className = "perch-narrow";
  return dom;
}
async function collapseApi(storage) {
  const dom = fakeDom();
  globalThis.__t = { dom, storage };
  const extra = (await extract("setToken")).toString() + ";" +
    (await extract("applySessionsCollapsed")).toString() + ";" +
    "var T=globalThis.__t; var window={localStorage:T.storage};" +
    "function el(id){ return T.dom.nodes[id]||null; }" +
    "function syncListPolling(){ T.dom.polls++; }" +
    "var sessionsCollapsed=false;";
  const setSessionsCollapsed = await extract("setSessionsCollapsed", extra);
  const toggleSessions = await extract("toggleSessions",
    extra + (await extract("setSessionsCollapsed", extra)).toString() + ";");
  return { dom, setSessionsCollapsed, toggleSessions };
}

test("setSessionsCollapsed: stores '1'/'0', toggles the root class, flips aria-expanded on BOTH buttons", async () => {
  const storage = fakeStorage();
  const { dom, setSessionsCollapsed } = await collapseApi(storage);
  setSessionsCollapsed(true);
  assert.equal(storage.map["crow-perch-sessions-collapsed"], "1");
  assert.deepEqual(dom.nodes["perch-hub-root"].className.split(" ").sort(), ["perch-narrow", "sessions-collapsed"],
    "the class is added without clobbering the root's other classes");
  assert.equal(dom.nodes["perch-list-collapse"].attrs["aria-expanded"], "false");
  assert.equal(dom.nodes["perch-list-reveal"].attrs["aria-expanded"], "false");
  assert.equal(dom.polls, 1, "a toggle re-decides polling: a hidden list must stop polling");
  assert.deepEqual(dom.focusLog, [], "focus-neutral: only a user gesture moves focus");

  setSessionsCollapsed(false);
  assert.equal(storage.map["crow-perch-sessions-collapsed"], "0");
  assert.equal(dom.nodes["perch-hub-root"].className, "perch-narrow");
  assert.equal(dom.nodes["perch-list-collapse"].attrs["aria-expanded"], "true");
  assert.equal(dom.nodes["perch-list-reveal"].attrs["aria-expanded"], "true");
  assert.equal(dom.polls, 2);
  delete globalThis.__t;
});

test("setSessionsCollapsed survives a throwing setItem (private window) and still applies", async () => {
  const { dom, setSessionsCollapsed } = await collapseApi(fakeStorage({ throws: true }));
  assert.doesNotThrow(() => setSessionsCollapsed(true));
  assert.match(dom.nodes["perch-hub-root"].className, /\bsessions-collapsed\b/);
  assert.equal(dom.nodes["perch-list-reveal"].attrs["aria-expanded"], "false");
  delete globalThis.__t;
});

test("toggleSessions hands focus to the control that is live after the change, class first", async () => {
  const { dom, toggleSessions } = await collapseApi(fakeStorage());
  toggleSessions();
  assert.equal(dom.focusLog.length, 1);
  assert.equal(dom.focusLog[0].id, "perch-list-reveal", "collapse -> focus the reveal button");
  assert.match(dom.focusLog[0].rootClass, /sessions-collapsed/,
    "the class (which displays the reveal button) is set BEFORE focus, or focus() on a display:none button is a no-op");
  toggleSessions();
  assert.equal(dom.focusLog[1].id, "perch-list-collapse", "reveal -> focus the collapse button");
  delete globalThis.__t;
});

test("listOnScreen: a collapsed list on desktop is NOT on screen; the list view always is", async () => {
  const mk = async (view, wide, collapsed) => {
    const f = await extract("listOnScreen",
      "var body={getAttribute:function(){ return " + JSON.stringify(view) + "; }};" +
      "var SPLIT={matches:" + wide + "}; var sessionsCollapsed=" + collapsed + ";");
    return f();
  };
  assert.equal(await mk("chat", true, true), false, "wide + chat + collapsed: hidden, stop polling");
  assert.equal(await mk("chat", true, false), true, "wide + chat + expanded: the split shows it");
  assert.equal(await mk("list", true, false), true, "wide + list view");
  // I4: the stored preference is '1' but no chat is open — the collapse rules
  // are keyed on data-view="chat", so the list IS on screen and must poll.
  assert.equal(await mk("list", true, true), true, "wide + list view + stored collapsed: still polls");
  assert.equal(await mk("chat", false, false), false, "phone + chat: hidden, as today");
  assert.equal(await mk("list", false, true), true, "phone + list view");
});

test("the stored state is applied at the TOP of the script, before the bootstrap opens anything", async () => {
  const { perchHubJs } = await import(PERCH + "client.js");
  const src = perchHubJs("en");
  const init = src.indexOf("var sessionsCollapsed=readCollapsed()");
  assert.ok(init > -1, "the state is read once into sessionsCollapsed");
  const apply = src.indexOf("applySessionsCollapsed();", init);
  assert.ok(apply > -1, "and applied to the DOM straight away");
  // I1: before ANY call that can reach listOnScreen()/syncListPolling() —
  // otherwise a direct #sid load polls a list it is about to hide.
  for (const marker of ["function openSession(", "if(parseHash(location.hash)) applyHash();", "applyNarrow();"]) {
    const at = src.indexOf(marker);
    assert.ok(at > -1, marker);
    assert.ok(apply < at, "applied before " + marker);
  }
  assert.ok(!/addEventListener\('keydown'/.test(src.slice(init, apply + 200)), "no keyboard shortcut in v1");
});
