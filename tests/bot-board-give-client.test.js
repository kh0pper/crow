/**
 * The give sheet's client script (queue item 20, PR 2; T9). Emitted by
 * bot-board/give-client.js as a template literal, so: it must parse, carry
 * no backticks, and every user-facing string must reach the browser through
 * tJs (the en/es emission diff of tests/board-i18n-literals.test.js).
 *
 * Then the script is RUN against a small DOM stub and driven: a Give to…
 * button opens the dialog with the card's title; picking a bot with no
 * Perch channel disables "Start now" and shows why; Give POSTs
 * {bot_id, start} to /dashboard/perch-api/cards/<id>/give; the toast says
 * what happened (including "Given to X. Couldn't start: <code>"); Escape
 * closes and hands focus back to the button.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { giveScript } from "../servers/gateway/dashboard/panels/bot-board/give-client.js";
import { translations } from "../servers/gateway/dashboard/shared/i18n.js";

function body(lang = "en") {
  const m = giveScript(lang).match(/^<script>([\s\S]*)<\/script>$/);
  assert.ok(m, "one inline <script>");
  return m[1];
}

test("the emitted script parses and carries no backticks", () => {
  for (const lang of ["en", "es"]) {
    const src = body(lang);
    assert.ok(!src.includes("`"));
    assert.doesNotThrow(() => new Function(src));
  }
});

test("every client string reaches the browser through tJs (en in en, es in es, no English in es)", () => {
  const en = body("en"), es = body("es");
  for (const k of ["botboard.giveTo", "botboard.giveBtn", "botboard.giveDone", "botboard.giveStarted", "botboard.giveStartFailed", "botboard.giveFailed"]) {
    const v = translations[k];
    assert.ok(en.includes("'" + v.en.replace(/'/g, "\\'") + "'"), k + " en");
    assert.ok(es.includes("'" + v.es.replace(/'/g, "\\'") + "'"), k + " es");
    assert.ok(!es.includes("'" + v.en.replace(/'/g, "\\'") + "'"), k + " leaks English into es");
  }
});

test("it posts to the CSRF-railed perch-api give route", () => {
  assert.ok(body().includes("'/dashboard/perch-api/cards/'"));
  assert.ok(!body().includes("/dashboard/bot-board/api"), "never the root-mounted, CSRF-less bot-board API");
});

// ---- a tiny DOM -----------------------------------------------------------
class El {
  constructor(doc, tag, attrs = {}) {
    this.doc = doc; this.tag = tag; this.attrs = { ...attrs }; this.children = []; this.parent = null;
    this.hidden = "hidden" in attrs; this.disabled = "disabled" in attrs; this.checked = "checked" in attrs;
    this.textContent = ""; this.style = {}; this.offsetWidth = 300; this.offsetHeight = 260;
    const cls = new Set(String(attrs.class || "").split(" ").filter(Boolean));
    this.classList = { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c) };
    this._cls = cls;
  }
  get id() { return this.attrs.id || ""; }
  get value() { return this.attrs.value || ""; }
  append(...kids) { for (const k of kids) { k.parent = this; this.children.push(k); } return this; }
  getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; }
  hasAttribute(n) { return n in this.attrs; }
  setAttribute(n, v) { this.attrs[n] = String(v); }
  matches(sel) {
    return sel.split(",").some((one) => {
      const s = one.trim();
      if (s.startsWith(".")) return this._cls.has(s.slice(1));
      const a = s.match(/^\[([a-z-]+)(?:="([^"]*)")?\]$/);
      if (a) return a[2] === undefined ? this.hasAttribute(a[1]) : this.getAttribute(a[1]) === a[2];
      return s === this.tag;
    });
  }
  closest(sel) { for (let n = this; n; n = n.parent) if (n.matches && n.matches(sel)) return n; return null; }
  contains(o) { for (let n = o; n; n = n.parent) if (n === this) return true; return false; }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => { for (const c of n.children) { if (c.matches(sel)) out.push(c); walk(c); } };
    walk(this); return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  focus() { this.doc.activeElement = this; }
  getBoundingClientRect() { return { left: 500, top: 300, bottom: 340, right: 600, width: 100, height: 40 }; }
}

function mount({ wide = false, lang = "en", noOnBots = false } = {}) {
  const listeners = {};
  const doc = { activeElement: null, addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); } };
  const E = (tag, attrs) => new El(doc, tag, attrs);
  const root = E("body");
  const giveBtn = E("button", { class: "btn bb-give-btn", "data-card-id": "7", "data-card-title": "Water the plants", hidden: "" });
  const dialog = E("div", { class: "bb-give", id: "bb-give", role: "dialog", hidden: "" });
  const panel = E("div", { class: "bb-give-panel" });
  const cardLine = E("p", { id: "bb-give-card" });
  const hank = E("input", { type: "radio", name: "bb-give-bot", value: "hank", "data-perch": "1", "data-name": "Hank" });
  const glassy = E("input", { type: "radio", name: "bb-give-bot", value: "glassy", "data-perch": "0", "data-name": "Glassy" });
  const later = E("input", { type: "radio", name: "bb-give-when", value: "later", checked: "" });
  const now = E("input", { type: "radio", name: "bb-give-when", value: "now" });
  const hint = E("p", { id: "bb-give-hint", hidden: "" });
  const cancel = E("button", { "data-give-close": "" });
  const go = E("button", { id: "bb-give-go", disabled: "" });
  // noOnBots: no board-on bot, only a board-off bot's Turn on form (hidden
  // inputs + its submit button), as giveSheetHtml renders it.
  const offForm = E("form", { method: "POST" });
  const offHidden = [E("input", { type: "hidden", name: "action", value: "board_on" }), E("input", { type: "hidden", name: "bot_id", value: "assistant" })];
  const turnOn = E("button", { type: "submit" });
  offForm.append(...offHidden, turnOn);
  if (noOnBots) panel.append(cardLine, offForm, later, now, hint, cancel, go);
  else panel.append(cardLine, hank, glassy, later, now, hint, cancel, go);
  dialog.append(panel);
  root.append(giveBtn, dialog);
  const all = () => [root, ...root.querySelectorAll("*,[id],[name],[class]")];
  doc.getElementById = (id) => root.querySelectorAll(`[id="${id}"]`)[0] || null;
  doc.querySelector = (s) => root.querySelector(s);
  doc.querySelectorAll = (s) => root.querySelectorAll(s);
  void all;

  const fetches = [], toasts = [], reloads = [];
  let respond = () => ({ ok: true, status: 200, body: { ok: true, assigned: true, started: false, cardId: 7 } });
  const win = {
    innerWidth: wide ? 1280 : 390, innerHeight: wide ? 800 : 844,
    matchMedia: (q) => ({ matches: wide && /min-width/.test(q) }),
    crowToast: (msg, opts) => toasts.push({ msg, type: opts && opts.type }),
  };
  const fetch = (url, opts) => {
    fetches.push({ url, opts, body: JSON.parse(opts.body) });
    const r = respond();
    return Promise.resolve({ ok: r.ok, status: r.status, json: () => Promise.resolve(r.body) });
  };
  const fn = new Function("window", "document", "fetch", "setTimeout", "location", body(lang));
  const loc = { href: "/dashboard/bot-board?bot=hank", reload() {} };
  fn(win, doc, fetch, (f) => reloads.push(f), loc);
  // A Turbo visit renders a fresh body and re-runs the inline script against
  // the SAME window (already bound): only the reveal must run again.
  const rerun = () => fn(win, doc, fetch, (f) => reloads.push(f), loc);
  const fire = (type, target, extra = {}) => {
    const ev = { type, target, key: extra.key, shiftKey: !!extra.shiftKey, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    for (const f of listeners[type] || []) f(ev);
    return ev;
  };
  const pick = (radio) => { for (const r of [hank, glassy]) r.checked = r === radio; fire("change", radio); };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { E, root, rerun, offHidden, turnOn, doc, dialog, panel, cardLine, hank, glassy, later, now, hint, cancel, go, giveBtn, fire, pick, flush, fetches, toasts, reloads, setRespond: (f) => { respond = f; } };
}

test("Give to… opens the dialog with the card's title; nothing picked yet, so Give is disabled", () => {
  const d = mount();
  d.fire("click", d.giveBtn);
  assert.equal(d.dialog.hidden, false);
  assert.equal(d.cardLine.textContent, "Water the plants");
  assert.equal(d.go.disabled, true);
  assert.equal(d.later.checked, true, "Add to board for later is the default");
  assert.equal(d.now.checked, false);
});

test("picking a bot names it on the button; a bot with no Perch channel cannot Start now, and the hint says why", () => {
  const d = mount();
  d.fire("click", d.giveBtn);
  d.pick(d.hank);
  assert.equal(d.go.disabled, false);
  assert.equal(d.go.textContent, "Give to Hank");
  assert.equal(d.now.disabled, false);
  assert.equal(d.hint.hidden, true);
  d.now.checked = true; d.later.checked = false;
  d.pick(d.glassy);
  assert.equal(d.now.disabled, true);
  assert.equal(d.now.checked, false, "a Start now pick falls back to later");
  assert.equal(d.later.checked, true);
  assert.equal(d.hint.hidden, false);
  assert.equal(d.go.textContent, "Give to Glassy");
});

test("Give posts {bot_id, start:false} by default, toasts 'Given to X.', closes, and reloads", async () => {
  const d = mount();
  d.fire("click", d.giveBtn);
  d.pick(d.glassy);
  d.fire("click", d.go);
  await d.flush();
  assert.equal(d.fetches.length, 1);
  assert.equal(d.fetches[0].url, "/dashboard/perch-api/cards/7/give");
  assert.equal(d.fetches[0].opts.method, "POST");
  assert.deepEqual(d.fetches[0].body, { bot_id: "glassy", start: false });
  assert.deepEqual(d.toasts.at(-1), { msg: "Given to Glassy.", type: "success" });
  assert.equal(d.dialog.hidden, true);
  assert.equal(d.reloads.length, 1, "a reload is scheduled so the card shows on its new board");
});

test("Start now that fails says so: 'Given to Hank. Couldn't start: <code>'", async () => {
  const d = mount();
  d.setRespond(() => ({ ok: true, status: 200, body: { ok: true, assigned: true, started: false, cardId: 7, code: "interactive_capacity" } }));
  d.fire("click", d.giveBtn);
  d.pick(d.hank);
  d.later.checked = false; d.now.checked = true; d.fire("change", d.now);
  d.fire("click", d.go);
  await d.flush();
  assert.deepEqual(d.fetches[0].body, { bot_id: "hank", start: true });
  assert.equal(d.toasts.at(-1).msg, "Given to Hank. Couldn't start: interactive_capacity");
  assert.equal(d.toasts.at(-1).type, "warning");
});

test("Start now that works: 'Given to Hank, and started.'", async () => {
  const d = mount();
  d.setRespond(() => ({ ok: true, status: 200, body: { ok: true, assigned: true, started: true, cardId: 7, sessionId: "s" } }));
  d.fire("click", d.giveBtn);
  d.pick(d.hank);
  d.later.checked = false; d.now.checked = true;
  d.fire("click", d.go);
  await d.flush();
  assert.equal(d.toasts.at(-1).msg, "Given to Hank, and started.");
});

test("a refusal keeps the dialog open and says why", async () => {
  const d = mount();
  d.setRespond(() => ({ ok: false, status: 409, body: { error: "no_board" } }));
  d.fire("click", d.giveBtn);
  d.pick(d.hank);
  d.fire("click", d.go);
  await d.flush();
  assert.deepEqual(d.toasts.at(-1), { msg: "Couldn't give it: no_board", type: "error" });
  assert.equal(d.dialog.hidden, false);
  assert.equal(d.reloads.length, 0);
  assert.equal(d.go.disabled, false, "and can be retried");
});

test("Escape and Cancel close the dialog and hand focus back to the Give to… button", () => {
  const d = mount();
  d.fire("click", d.giveBtn);
  const ev = d.fire("keydown", d.hank, { key: "Escape" });
  assert.equal(ev.defaultPrevented, true);
  assert.equal(d.dialog.hidden, true);
  assert.equal(d.doc.activeElement, d.giveBtn);
  d.fire("click", d.giveBtn);
  d.fire("click", d.cancel);
  assert.equal(d.dialog.hidden, true);
  assert.equal(d.doc.activeElement, d.giveBtn);
});

test("a tap on the backdrop (the dialog layer itself) closes it", () => {
  const d = mount();
  d.fire("click", d.giveBtn);
  d.fire("click", d.dialog);
  assert.equal(d.dialog.hidden, true);
});

test("Tab is trapped inside the dialog", () => {
  const d = mount();
  d.fire("click", d.giveBtn);
  d.pick(d.hank);
  d.go.focus();
  const ev = d.fire("keydown", d.go, { key: "Tab" });
  assert.equal(ev.defaultPrevented, true, "Tab on the last control wraps");
  assert.notEqual(d.doc.activeElement, d.go);
  assert.ok(d.panel.contains(d.doc.activeElement));
});

test("on wide the panel is placed as a popover beside the card; on a phone it stays a bottom sheet", () => {
  const w = mount({ wide: true });
  w.fire("click", w.giveBtn);
  assert.ok(w.panel.classList.contains("bb-placed"));
  assert.equal(w.panel.style.top, "346px");
  assert.equal(w.panel.style.left, "500px");
  const p = mount();
  p.fire("click", p.giveBtn);
  assert.ok(!p.panel.classList.contains("bb-placed"));
  assert.equal(p.panel.style.top || "", "");
});

test("the focus trap skips hidden inputs (a board-off bot's Turn on form) — with no board-on bots too", () => {
  const d = mount({ noOnBots: true });
  d.fire("click", d.giveBtn);
  assert.equal(d.doc.activeElement, d.turnOn, "opening focuses the first real control, not a type=hidden input");
  d.cancel.focus();
  d.fire("keydown", d.cancel, { key: "Tab" });
  assert.ok(!d.offHidden.includes(d.doc.activeElement), "Tab never lands on a hidden input");
  assert.equal(d.doc.activeElement, d.turnOn);
  d.turnOn.focus();
  d.fire("keydown", d.turnOn, { key: "Tab", shiftKey: true });
  assert.equal(d.doc.activeElement, d.cancel, "Shift+Tab on the first real control wraps to the last enabled one (Give stays disabled: no bot to pick)");
});

test("the script reveals the server-hidden Give to… buttons, again on a Turbo re-render, binding once", () => {
  const d = mount();
  assert.equal(d.giveBtn.hidden, false, "revealed on first run");
  const fresh = d.E("button", { class: "btn bb-give-btn", "data-card-id": "8", "data-card-title": "Feed the cat", hidden: "" });
  d.root.append(fresh);
  d.rerun();
  assert.equal(fresh.hidden, false, "a re-rendered button is revealed too");
  d.fire("click", fresh);
  assert.equal(d.cardLine.textContent, "Feed the cat");
  d.fire("keydown", d.go, { key: "Escape" });
  d.fire("click", d.giveBtn);
  assert.equal(d.cardLine.textContent, "Water the plants", "listeners bound once: one open per click");
});
