/**
 * Bot Builder rows (queue item 20, option A; T3) — the row ⋯ menu's client
 * script: toggles hidden + aria-expanded, Escape closes and hands focus back
 * to the trigger, ArrowDown focuses the first item, an outside click closes
 * it, and opening one menu closes the others (the Perch #477 semantics).
 *
 * The emitted script runs against a minimal DOM stub (document-level
 * delegation, so the stub only needs closest/contains/querySelectorAll).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rowMenuScript } from "../servers/gateway/dashboard/panels/bot-builder/row-menu.js";

function scriptBody() {
  const html = rowMenuScript();
  const m = html.match(/^<script>([\s\S]*)<\/script>$/);
  assert.ok(m, "a single inline <script> element");
  return m[1];
}

test("the emitted script parses and carries no backticks", () => {
  const src = scriptBody();
  assert.ok(!src.includes("`"), "panel client JS is a template literal: no backticks inside");
  assert.doesNotThrow(() => new Function("window", "document", src));
});

// ---- a tiny DOM ----------------------------------------------------------
class El {
  constructor(doc, tag, attrs = {}) {
    this.doc = doc; this.tag = tag; this.attrs = { ...attrs }; this.children = []; this.parent = null; this.hidden = false;
  }
  get id() { return this.attrs.id || ""; }
  get className() { return this.attrs.class || ""; }
  append(...kids) { for (const k of kids) { k.parent = this; this.children.push(k); } return this; }
  getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; }
  setAttribute(n, v) { this.attrs[n] = String(v); }
  matches(sel) {
    if (sel.startsWith(".")) return this.className.split(" ").includes(sel.slice(1));
    const a = sel.match(/^\[([a-z-]+)="([^"]*)"\]$/);
    if (a) return this.getAttribute(a[1]) === a[2];
    return false;
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
}

function makeDom(rowCount = 2) {
  const listeners = {};
  const doc = {
    activeElement: null,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
  };
  const body = new El(doc, "body");
  doc.body = body;
  doc.querySelectorAll = (s) => body.querySelectorAll(s);
  doc.querySelector = (s) => body.querySelector(s);
  doc.getElementById = (id) => body.querySelectorAll(".btb-menu").concat(body.querySelectorAll(".btb-more")).find((e) => e.id === id) || null;
  const rows = [];
  for (let i = 0; i < rowCount; i++) {
    const more = new El(doc, "button", { class: "btb-more", "aria-controls": `btb-menu-${i}`, "aria-expanded": "false" });
    const menu = new El(doc, "div", { class: "btb-menu", id: `btb-menu-${i}`, role: "menu" });
    menu.hidden = true;
    const items = [0, 1, 2].map((k) => new El(doc, "a", { role: "menuitem", "data-k": String(k) }));
    menu.append(...items);
    const row = new El(doc, "div", { class: "btb-row" }).append(new El(doc, "span", { class: "btb-av" }), more, menu);
    body.append(row);
    rows.push({ row, more, menu, items });
  }
  const outside = new El(doc, "p", { class: "elsewhere" });
  body.append(outside);
  const fire = (type, target, extra = {}) => {
    const ev = { type, target, key: extra.key, relatedTarget: extra.relatedTarget || null, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} };
    for (const fn of listeners[type] || []) fn(ev);
    return ev;
  };
  const win = {};
  new Function("window", "document", scriptBody())(win, doc);
  return { doc, rows, outside, fire, listeners, win };
}

test("clicking ⋯ opens its menu, sets aria-expanded and focuses the first item; clicking again closes", () => {
  const { doc, rows, fire } = makeDom();
  const [a] = rows;
  fire("click", a.more);
  assert.equal(a.menu.hidden, false);
  assert.equal(a.more.getAttribute("aria-expanded"), "true");
  assert.equal(doc.activeElement, a.items[0]);
  fire("click", a.more);
  assert.equal(a.menu.hidden, true);
  assert.equal(a.more.getAttribute("aria-expanded"), "false");
});

test("opening one menu closes the other", () => {
  const { rows, fire } = makeDom();
  fire("click", rows[0].more);
  fire("click", rows[1].more);
  assert.equal(rows[0].menu.hidden, true);
  assert.equal(rows[0].more.getAttribute("aria-expanded"), "false");
  assert.equal(rows[1].menu.hidden, false);
});

test("Escape closes the menu and returns focus to the trigger", () => {
  const { doc, rows, fire } = makeDom();
  fire("click", rows[0].more);
  const ev = fire("keydown", rows[0].items[1], { key: "Escape" });
  assert.equal(rows[0].menu.hidden, true);
  assert.equal(doc.activeElement, rows[0].more);
  assert.equal(ev.defaultPrevented, true);
});

test("ArrowDown on the trigger opens the menu on its first item; arrows move inside", () => {
  const { doc, rows, fire } = makeDom();
  fire("keydown", rows[1].more, { key: "ArrowDown" });
  assert.equal(rows[1].menu.hidden, false);
  assert.equal(doc.activeElement, rows[1].items[0]);
  fire("keydown", rows[1].items[0], { key: "ArrowDown" });
  assert.equal(doc.activeElement, rows[1].items[1]);
  fire("keydown", rows[1].items[1], { key: "ArrowUp" });
  assert.equal(doc.activeElement, rows[1].items[0]);
  fire("keydown", rows[1].items[0], { key: "ArrowUp" });
  assert.equal(doc.activeElement, rows[1].items[2], "wraps to the last item");
});

test("an outside click closes the open menu; a click inside it does not", () => {
  const { rows, outside, fire } = makeDom();
  fire("click", rows[0].more);
  fire("click", rows[0].items[2]);
  assert.equal(rows[0].menu.hidden, false, "a click on an item is the item's business");
  fire("click", outside);
  assert.equal(rows[0].menu.hidden, true);
  assert.equal(rows[0].more.getAttribute("aria-expanded"), "false");
});

test("binds once: a second run (a Turbo visit) adds no second set of listeners", () => {
  const { doc, listeners, win } = makeDom();
  const before = (listeners.click || []).length;
  new Function("window", "document", scriptBody())(win, doc);
  assert.equal((listeners.click || []).length, before);
});

test("Tab away from an open menu closes it (focusout to outside); moving focus inside keeps it open", () => {
  const { doc, rows, outside, fire } = makeDom();
  fire("click", rows[0].more);
  fire("focusout", rows[0].items[0], { relatedTarget: rows[0].items[1] });
  assert.equal(rows[0].menu.hidden, false, "focus moving between items keeps the menu open");
  fire("focusout", rows[0].items[1], { relatedTarget: rows[0].more });
  assert.equal(rows[0].menu.hidden, false, "focus going back to its own trigger keeps it open");
  fire("click", rows[0].more); fire("click", rows[0].more);
  fire("focusout", rows[0].items[0], { relatedTarget: outside });
  assert.equal(rows[0].menu.hidden, true, "Tab out of the menu closes it");
  assert.equal(rows[0].more.getAttribute("aria-expanded"), "false");
  assert.notEqual(doc.activeElement, rows[0].more, "focus is not pulled back to the trigger");
});

test("focusout with no destination (window blur) leaves the menu alone", () => {
  const { rows, fire } = makeDom();
  fire("click", rows[1].more);
  fire("focusout", rows[1].items[0], {});
  assert.equal(rows[1].menu.hidden, false);
});
