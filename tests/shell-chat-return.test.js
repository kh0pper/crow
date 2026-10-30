// The Chat tab returns to the open chat (2026-10-29): Chat -> Board -> Chat
// used to land on the session list. Runs the shell client's block in a vm
// with a fake page.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { shellClientJs } from "../servers/gateway/dashboard/shell/client.js";

function block() {
  const src = shellClientJs();
  const start = src.indexOf("// ─── The Chat tab returns to the open chat");
  const end = src.indexOf("// ─── The apps launcher");
  assert.ok(start > 0 && end > start, "block present");
  return src.slice(start, end);
}

function page(url) {
  const store = new Map();
  const listeners = { click: [], hashchange: [] };
  const visits = [];
  const u = new URL(url);
  const location = { origin: u.origin, pathname: u.pathname, search: u.search, hash: u.hash };
  Object.defineProperty(location, "href", { set(v) { visits.push(v); }, get() { return u.href; } });
  const win = {
    sessionStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    addEventListener: (t, fn) => (listeners[t] || (listeners[t] = [])).push(fn),
    Turbo: { visit: (v) => visits.push(v) },
  };
  const document = { addEventListener: (t, fn) => (listeners[t] || (listeners[t] = [])).push(fn) };
  const ctx = vm.createContext({ window: win, document, location, URL, sessionStorage: win.sessionStorage, console });
  const run = () => vm.runInContext(block(), ctx);
  const go = (next) => { const n = new URL(next); location.pathname = n.pathname; location.search = n.search; location.hash = n.hash; };
  const clickTab = (href, opts = {}) => {
    const a = { getAttribute: (k) => (k === "href" ? href : null) };
    let prevented = false;
    const e = { defaultPrevented: false, button: 0, metaKey: !!opts.meta, ctrlKey: false, shiftKey: false, altKey: false,
      target: { closest: (sel) => (sel.includes('data-shell-tab="chat"') ? a : null) }, preventDefault() { prevented = true; } };
    for (const fn of listeners.click) fn(e);
    return prevented;
  };
  return { run, go, clickTab, visits, store, fireHash: () => listeners.hashchange.forEach((f) => f()), win };
}

const O = "https://crow.example.ts.net:8444";

test("an open chat is remembered, and the Chat tab on the Board reopens it", () => {
  const p = page(`${O}/dashboard/perch?project=travel-21#perchlive-1a2b3c4d`);
  p.run();
  assert.equal(p.store.get("crow.shell.lastChat"), "/dashboard/perch?project=travel-21#perchlive-1a2b3c4d");
  p.go(`${O}/dashboard/board?project=travel-21`);
  p.win.__crowShellChatReturnBound = true; // the second page run keeps the one listener
  p.run();
  assert.equal(p.clickTab("/dashboard/project/travel-21"), true);
  assert.deepEqual(p.visits, ["/dashboard/perch?project=travel-21#perchlive-1a2b3c4d"]);
});

test("going back to the chat list forgets it, so the Chat tab goes to the list", () => {
  const p = page(`${O}/dashboard/perch?project=travel-21#perchlive-1a2b3c4d`);
  p.run();
  p.go(`${O}/dashboard/perch?project=travel-21`);
  p.fireHash();
  assert.equal(p.store.has("crow.shell.lastChat"), false);
  p.go(`${O}/dashboard/board?project=travel-21`);
  assert.equal(p.clickTab("/dashboard/project/travel-21"), false);
  assert.deepEqual(p.visits, []);
});

test("another project's chat is not reopened; Everything reopens any; modified clicks are left alone", () => {
  const p = page(`${O}/dashboard/perch?project=travel-21#perchlive-1a2b3c4d`);
  p.run();
  p.go(`${O}/dashboard/board?project=capstone-7`);
  assert.equal(p.clickTab("/dashboard/project/capstone-7"), false, "different project: normal link");
  assert.equal(p.clickTab("/dashboard/perch", { meta: true }), false, "cmd-click: normal link");
  assert.equal(p.clickTab("/dashboard/perch"), true, "Everything scope reopens it");
});

test("a hash that isn't an engine session id is never stored", () => {
  const p = page(`${O}/dashboard/perch?project=travel-21#javascript:alert(1)`);
  p.run();
  assert.equal(p.store.has("crow.shell.lastChat"), false);
});

test("the shell client still contains no backticks", () => {
  assert.equal(shellClientJs().slice(1, -1).includes("`"), false);
});

// ---- the Board count matches the Board (2026-10-29) ----
import { shellTabsNav } from "../servers/gateway/dashboard/shell/chrome.js";

function tabs(counts) {
  const html = shellTabsNav({ tab: "chat", scope: { projectId: 21 }, projects: [{ id: 21, slug: "travel-21", name: "Travel" }], lang: "en", counts, homeSlug: null, getPanel: () => true });
  const label = (id) => (html.match(new RegExp(`data-shell-tab="${id}"[^>]*>[\\s\\S]*?<span>([^<]*)</span>`)) || [])[1];
  return { chat: label("chat"), board: label("board") };
}

test("Board · N counts cards needing you; a waiting chat counts on Chat, not Board", () => {
  const m = new Map([[21, 1]]);
  m.parts = new Map([[21, { cards: 0, chats: 1 }]]);
  assert.deepEqual(tabs(m), { chat: "Chat · 1", board: "Board" });
  const m2 = new Map([[21, 3]]);
  m2.parts = new Map([[21, { cards: 2, chats: 1 }]]);
  assert.deepEqual(tabs(m2), { chat: "Chat · 1", board: "Board · 2" });
});

test("without the split (an older counts Map) the Board shows the total as before", () => {
  assert.deepEqual(tabs(new Map([[21, 4]])), { chat: "Chat", board: "Board · 4" });
  assert.deepEqual(tabs(new Map([[21, null]])), { chat: "Chat", board: "Board" });
});
