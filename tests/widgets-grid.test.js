/**
 * Widgets phase 2, PR 1 (spec §7.3): For You is one grid of widgets, and Edit mode.
 *
 * The first half needs no database and no server:
 *   - the registry (widgets/registry.js): unique ids, a default size that is one of the widget's
 *     sizes, a title in both languages, and no widget claiming the generic "widgets" page that
 *     phase 2's Task 3 has not built;
 *   - the page's default order, unbroken: needs-me, morning, moves, listen, news (and the weather,
 *     offered but drawn hidden: the chip stays in For You's header);
 *   - a failed load is that cell's own line — its own card where it has one — and every other cell
 *     still renders; a widget with nothing to show draws no cell at all;
 *   - every id, page name and title in the markup is escaped;
 *   - the client (widgets/grid-client.js), lifted out of the page and run in a vm over linkedom with
 *     its own localStorage: the saved order, size and removals are applied; garbage, a wrong version
 *     or an id no widget carries falls back to the default and never to a blank page; a mouse drag
 *     moves a cell, a touch drag starts only after a long press, the Size button cycles only the
 *     widget's allowed sizes, Remove then "+ Add widget" round-trips, and Done writes the layout.
 *
 * The second half drives the REAL dashboard router in a private headless Chrome (the `open()` of
 * tests/shell-board-live.test.js) at 390×844 and 1280×800: two grid columns on the phone and four
 * when wide, no sideways scroll, Edit mode's targets at least 44 px, a drag that reorders and a
 * reload that keeps the order, a resize, and a Remove / Add round-trip.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import vm from "node:vm";
import { parseHTML } from "linkedom";
import { startHeadlessChrome } from "./fixtures/headless-chrome.mjs";
import { actAsServe, serveHeaders } from "./fixtures/serve-peer.mjs";
import { WIDGETS, widgetOf, widgetsForPage, loadWidgets } from "../servers/gateway/widgets/registry.js";
import { gridHtml, gridCellHtml } from "../servers/gateway/widgets/grid-html.js";
import { gridClientJs } from "../servers/gateway/widgets/grid-client.js";
import { forYouPageHtml } from "../servers/gateway/dashboard/panels/for-you/html.js";
import { t } from "../servers/gateway/dashboard/shared/i18n.js";
actAsServe(); // this process's HTTP client stands in for tailscaled (the Serve socket owner)

const dir = mkdtempSync(join(tmpdir(), "widgets-grid-"));
process.env.CROW_DATA_DIR = dir;
const HOME = join(dir, "home");
process.env.CROW_HOME = HOME;
mkdirSync(HOME, { recursive: true });
delete process.env.CROW_DB_PATH;
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
process.env.CROW_FOR_YOU = "1";
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
process.env.PIBOT_PI_CLI = "/nonexistent/pi-never-spawned-by-this-file.js";
writeFileSync(join(dir, "instance-id"), "instance-widgets-grid");
writeFileSync(join(HOME, "installed.json"), "[]");
const REPO = new URL("..", import.meta.url).pathname;
const NOW = Date.parse("2026-11-03T12:00:00Z");

// ─── the registry ─────────────────────────────────────────────────────────────

test("the registry: unique ids in For You's order, sizes that include the default, and both pages", () => {
  const ids = WIDGETS.map((w) => w.id);
  assert.equal(ids.length, new Set(ids).size, "every id is unique");
  assert.deepEqual(ids, [
    "needs-me", "morning", "moves", "listen", "news", "today", "weather",
    // Widgets phase 3, PR 2: offered on both pages, on neither default layout.
    "messages", "camera", "apps", "projects", "bots",
  ], "For You's default order, then Today + Ramble, then the weather, then the in-Crow widgets");
  for (const w of WIDGETS) {
    assert.ok(Array.isArray(w.sizes) && w.sizes.length > 0, `${w.id} lists its sizes`);
    assert.ok(Array.isArray(w.defaultSize) && w.defaultSize.length === 2, `${w.id} has a default size`);
    assert.ok(
      w.sizes.some((s) => s[0] === w.defaultSize[0] && s[1] === w.defaultSize[1]),
      `${w.id}: its default size ${JSON.stringify(w.defaultSize)} is one of ${JSON.stringify(w.sizes)}`,
    );
    assert.equal(typeof w.load, "function", `${w.id} loads`);
    assert.equal(typeof w.render, "function", `${w.id} renders`);
    for (const lang of ["en", "es"]) {
      assert.notEqual(t(w.titleKey, lang), w.titleKey, `${w.id} has a ${lang} title`);
    }
    // The generic /dashboard/widgets page (widgets phase 2, Task 3) offers every one of them.
    assert.deepEqual(w.pages, ["for-you", "widgets"], `${w.id} is offered on For You and on the widget page`);
  }
  assert.equal(widgetOf("morning").id, "morning");
  assert.equal(widgetOf("nope"), null);
});

test("the offer: a section's customize switch off means not offered, and never changes the server setting", () => {
  const settings = { sections: { morning: true, moves: false, listen: false, news: false, weather: true } };
  // The in-Crow widgets (widgets phase 3, PR 2) carry no switch either, so they are always offered —
  // from "+ Add widget" on either page (they are part of neither page's DEFAULT layout).
  const inCrow = ["messages", "camera", "apps", "projects", "bots"];
  // `today` carries no customize switch, so it is always offered — from "+ Add widget" on either page
  // (it is only part of the generic page's DEFAULT layout; see the widget page's own test).
  assert.deepEqual(widgetsForPage("for-you", { settings }).map((w) => w.id), ["needs-me", "morning", "today", "weather", ...inCrow]);
  // The generic page offers the same widgets (the customize switches are page-blind); `today` has no
  // switch, so it is always offered there.
  assert.deepEqual(widgetsForPage("widgets", { settings }).map((w) => w.id), ["needs-me", "morning", "today", "weather", ...inCrow]);
  assert.deepEqual(widgetsForPage("for-you").map((w) => w.id), WIDGETS.map((w) => w.id), "no settings: everything is offered");
});

// ─── the markup ───────────────────────────────────────────────────────────────

function summary(over = {}) {
  return {
    id: "needs-me", title: "What needs me", state: "empty", headline: "All clear",
    items: [], doing: [], more_href: "/dashboard/bot-board", lock: { count: 0, label: "0 waiting" }, ...over,
  };
}

function pageData(over = {}) {
  return {
    settings: { sections: { morning: true, moves: true, listen: true, news: true, weather: true }, city: "", place: null },
    dateText: "Friday, October 30",
    needsMe: summary(),
    morning: { needs: { total: 0, items: [] }, due: { total: 0, items: [] }, finished: { total: 0, items: [] }, leftOff: null },
    moves: { ramble: "ok", moves: { challenge: { day: "2026-10-30", title: "Morning stretch", minutes: 10, why: "", done: false }, off: false, health: { energy: 18, max: 30 }, steps: { today: 3200, goal: 6000 }, streak: { days: 4 } } },
    listen: { media: "missing", music: false },
    news: { state: "missing", stories: [], hidden: [] },
    weather: { temp: 21, code: 0, high: 25, low: 12, rain: 30, unit: "celsius" },
    ...over,
  };
}

/** The widgets a page drew, in document order, and whether each one is visible. */
function drawnCells(html) {
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  return [...document.querySelectorAll(".wg-grid [data-widget]")].map((el) => ({
    id: el.getAttribute("data-widget"),
    hidden: el.hasAttribute("hidden"),
    w: Number(el.getAttribute("data-w")),
    h: Number(el.getAttribute("data-h")),
    sizes: JSON.parse(el.getAttribute("data-sizes") || "[]"),
  }));
}

test("For You's default order is exactly today's: needs-me, morning, moves, listen, news", () => {
  const cells = drawnCells(forYouPageHtml(pageData(), "en", NOW));
  assert.deepEqual(cells.filter((c) => !c.hidden).map((c) => c.id), ["needs-me", "morning", "moves", "listen", "news"]);
  for (const c of cells) assert.ok(c.sizes.length > 0, `${c.id} carries its allowed sizes`);
  // The weather's chip is still the header's; the weather WIDGET is offered, drawn hidden, so this
  // device may add it without the page's default look changing.
  const weather = cells.find((c) => c.id === "weather");
  assert.ok(weather, "the weather cell is offered");
  assert.equal(weather.hidden, true, "and hidden until this device adds it");
  const html = forYouPageHtml(pageData(), "en", NOW);
  assert.match(html, /<span class="fy-chip">21° · Clear<\/span>/, "the header chip is untouched");
  assert.ok(html.indexOf('data-widget="weather"') > html.indexOf('data-widget="news"'), "the weather is drawn last");
});

test("a section that is off draws no cell at all, and a widget with nothing to show draws none either", () => {
  const off = drawnCells(forYouPageHtml(pageData({
    settings: { sections: { morning: true, moves: false, listen: false, news: false, weather: false }, city: "", place: null },
  }), "en", NOW));
  assert.deepEqual(off.map((c) => c.id), ["needs-me", "morning"], "off means not offered");
  // Ramble missing (the loader's own answer) renders "": no Move cell, and no error line either.
  const noRamble = drawnCells(forYouPageHtml(pageData({ moves: { ramble: "missing" } }), "en", NOW));
  assert.deepEqual(noRamble.filter((c) => !c.hidden).map((c) => c.id), ["needs-me", "morning", "listen", "news"]);
});

test("a loader that throws is its own one-line cell, and every other cell still renders", async () => {
  const widgets = [
    { id: "fine", titleKey: "forYou.morning", sizes: [[2, 1]], defaultSize: [2, 1], load: async () => ({ n: 1 }), render: (d) => `<p id="fine-body">fine ${d.n}</p>` },
    { id: "broken", titleKey: "forYou.news", sizes: [[2, 1]], defaultSize: [2, 1], load: async () => { throw new Error("no such table"); }, render: () => `<p id="never">never drawn</p>` },
    { id: "empty", titleKey: "forYou.listen", sizes: [[2, 1]], defaultSize: [2, 1], load: async () => ({}), render: () => "" },
  ];
  const cells = await loadWidgets(widgets, {}, { log: () => {} });
  assert.deepEqual(cells.map((c) => (c.failed ? "failed" : "ok")), ["ok", "failed", "ok"]);
  const html = gridHtml("test-page", cells, "en");
  assert.match(html, /id="fine-body"/, "the healthy widget renders");
  assert.ok(html.includes('data-widget="broken"'), "the failing widget keeps its cell");
  assert.match(html, /This widget couldn't load just now\./, "with one line saying so");
  assert.doesNotMatch(html, /id="never"/, "its own render never ran");
  assert.doesNotMatch(html, /data-widget="empty"/, "a widget with nothing to show draws no cell");
});

test("a loader that hangs is cut off at the per-widget timeout, and the page is drawn without it", async () => {
  const widgets = [
    { id: "quick", titleKey: "forYou.morning", sizes: [[2, 1]], defaultSize: [2, 1], load: async () => ({ n: 2 }), render: (d) => `<p id="quick-body">quick ${d.n}</p>` },
    { id: "stuck", titleKey: "forYou.news", sizes: [[2, 1]], defaultSize: [2, 1], load: () => new Promise(() => {}), render: () => `<p id="stuck-body">never</p>` },
  ];
  const started = Date.now();
  const cells = await loadWidgets(widgets, {}, { log: () => {}, timeoutMs: 40 });
  assert.ok(Date.now() - started < 2000, "the page did not wait for the hung read");
  assert.deepEqual(cells.map((c) => (c.failed ? "failed" : "ok")), ["ok", "failed"]);
  const html = gridHtml("test-page", cells, "en");
  assert.match(html, /id="quick-body"/);
  assert.match(html, /data-widget="stuck"/);
  assert.match(html, /This widget couldn't load just now\./);
  assert.doesNotMatch(html, /id="stuck-body"/);
});

test("a widget with its own error line keeps its card: What needs me and Your morning still say what failed", async () => {
  const cells = await loadWidgets([widgetOf("needs-me"), widgetOf("morning")], {
    needsMe: async () => { throw new Error("aggregator down"); },
    projects: async () => { throw new Error("database is locked"); },
    now: NOW, lang: "en", tz: "UTC", db: null, crowHome: HOME, settings: { sections: {} },
  }, { log: () => {} });
  const html = gridHtml("for-you", cells, "en");
  assert.match(html, /<section class="fy-card fy-needs"/, "the needs-me card, not a bare line");
  assert.match(html, /What needs me couldn't load just now\./);
  assert.match(html, /Your morning couldn't load just now\./);
  assert.match(html, /data-widget="morning"/);
});

test("every id, page name and title that reaches markup is escaped", () => {
  const evil = {
    id: 'x"><script>alert(1)</script>',
    titleKey: "forYou.morning", sizes: [[2, 1]], defaultSize: [2, 1],
    render: () => "<p>body</p>",
  };
  const html = gridHtml('p"><b>', [{ widget: evil, data: {} }], "es");
  assert.ok(!html.includes('<script>alert(1)'), "a widget id cannot open a script tag");
  assert.ok(html.includes('data-widget="x&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"'), "it is escaped instead");
  assert.match(html, /data-wg-page="p&quot;&gt;&lt;b&gt;"/, "and so is the page name");

  const cell = gridCellHtml({ widget: widgetOf("needs-me"), data: summary({ title: 'Hi "there" <b>you</b>', more_href: "/dashboard/board" }) }, "en");
  assert.match(cell, /Hi &quot;there&quot; &lt;b&gt;you&lt;\/b&gt;/, "a title from a row is escaped inside the cell");
  assert.ok(!cell.includes("<b>you</b>"));
  assert.match(cell, /aria-label="Remove What needs me"/, "the buttons name their widget");
});

test("the page's markup: one grid, one picker template, and nothing unrendered leaks into it", () => {
  const html = forYouPageHtml(pageData(), "en", NOW);
  assert.equal(html.split('class="wg-grid"').length - 1, 1, "one grid");
  assert.equal(html.split("data-wg-picker-tpl").length - 1, 1, "one picker template");
  assert.equal(html.split('class="wg-cell"').length - 1, 6, "a cell for every widget the page offers");
  assert.equal(html.split("data-wg-edit").length - 1, 1, "one Edit button");
  assert.doesNotMatch(html, /undefined|NaN|\[object Object\]/, "no value failed to render");
});

// ─── the client, in a vm ─────────────────────────────────────────────────────

const CLIENT = (() => {
  const js = gridClientJs();
  assert.ok(!js.includes("`"), "grid-client may carry no backtick: it is emitted inside a template literal");
  assert.ok(!js.includes("${"), "and no ${ either");
  return js.replace(/^<script>\s*/, "").replace(/<\/script>\s*$/, "");
})();

test("the grid's client is emitted inside a template literal: no backtick, no ${", () => {
  const js = gridClientJs();
  assert.ok(js.startsWith("<script>"), "emitted as its own script element");
  assert.ok(js.trimEnd().endsWith("</script>"), "and closed");
  assert.equal(js.split("`").length - 1, 0, "no backtick anywhere in the emitted source");
  assert.equal(js.split("${").length - 1, 0, "no ${ anywhere in the emitted source");
  assert.ok(CLIENT.length > 1000, "the client is really there");
});

const RIG_WIDGETS = [
  { id: "a", titleKey: "forYou.morning", sizes: [[4, 2], [2, 2], [4, 1], [2, 1]], defaultSize: [4, 2], render: () => `<section class="fy-card"><h2 id="h-a">A</h2></section>` },
  { id: "b", titleKey: "forYou.listen", sizes: [[4, 2], [2, 2], [4, 1], [2, 1]], defaultSize: [4, 2], render: () => `<section class="fy-card"><h2 id="h-b">B</h2></section>` },
  { id: "c", titleKey: "forYou.news", sizes: [[2, 2], [1, 1]], defaultSize: [2, 2], render: () => `<section class="fy-card"><h2 id="h-c">C</h2></section>` },
];

const KEY = "crow.widgets.layout.for-you";

/**
 * A page with the server's own grid markup, its own localStorage, and the client run over it.
 * `boxes` gives `getBoundingClientRect` to the cells by id ([left, top, width, height]), which is
 * all a drag needs from a browser.
 */
function rig({ layout = undefined, widgets = RIG_WIDGETS, boxes = {} } = {}) {
  const html = gridHtml("for-you", widgets.map((widget) => ({ widget, data: {} })), "en");
  const { document, window } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  const store = new Map();
  if (layout !== undefined) store.set(KEY, typeof layout === "string" ? layout : JSON.stringify(layout));
  const win = {
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); },
    },
  };
  const ctx = vm.createContext({
    window: win, document, JSON, Number, Object, Array, String, isFinite, setTimeout, clearTimeout,
  });
  vm.runInContext(CLIENT, ctx);
  const grid = document.querySelector("[data-wg-page]");
  assert.ok(grid, "the client found the grid");
  const cell = (id) => document.querySelector(`[data-widget="${id}"]`);
  for (const [id, [left, top, width, height]] of Object.entries(boxes)) {
    const el = cell(id);
    assert.ok(el, "no cell " + id);
    Object.defineProperty(el, "getBoundingClientRect", {
      value: () => ({ left, top, width, height, right: left + width, bottom: top + height }),
    });
  }
  const shown = () => [...grid.querySelectorAll("[data-widget]")]
    .filter((el) => !el.hasAttribute("hidden"))
    .map((el) => el.getAttribute("data-widget"));
  const size = (id) => [Number(cell(id).getAttribute("data-w")), Number(cell(id).getAttribute("data-h"))];
  const fire = (type, target, props = {}) => {
    const ev = new window.Event(type, { bubbles: true, cancelable: true });
    Object.assign(ev, props);
    target.dispatchEvent(ev);
    return ev;
  };
  const click = (target) => fire("click", typeof target === "string" ? document.querySelector(target) : target);
  return {
    document, grid, store, cell, shown, size, fire, click,
    clickIn: (id, sel) => click(cell(id).querySelector(sel)),
    saved: () => (store.has(KEY) ? JSON.parse(store.get(KEY)) : null),
    editing: () => grid.hasAttribute("data-editing"),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("the client applies the device's layout: order, size and removals", () => {
  const r = rig({ layout: { v: 1, cells: [{ id: "c", w: 1, h: 1 }, { id: "a", w: 2, h: 2 }] } });
  assert.deepEqual(r.shown(), ["c", "a"], "the saved order");
  assert.deepEqual(r.size("c"), [1, 1], "the saved size");
  assert.deepEqual(r.size("a"), [2, 2]);
  assert.equal(r.cell("b").hasAttribute("hidden"), true, "a widget the layout does not list was removed here");
});

test("no layout is the server's default: every cell, its default size, the weather still hidden", () => {
  const weather = { id: "weather", titleKey: "forYou.weather", sizes: [[1, 1]], defaultSize: [1, 1], defaultOn: false, render: () => "<p>wx</p>" };
  const r = rig({ widgets: [RIG_WIDGETS[0], weather] });
  assert.deepEqual(r.shown(), ["a"], "the default-off cell stays hidden");
  assert.deepEqual(r.size("a"), [4, 2]);
  assert.equal(r.cell("a").getAttribute("data-w"), "4");
});

test("bad, stale or foreign data is the default — never a blank page", () => {
  for (const bad of [
    "{not json at all",
    "null",
    '{"v":2,"cells":[{"id":"c","w":1,"h":1}]}',
    '{"v":1}',
    '{"v":1,"cells":"c"}',
    '{"v":1,"cells":[{"id":"gone","w":1,"h":1}]}',
    '{"v":1,"cells":[{"nope":1}]}',
    "",
  ]) {
    const r = rig({ layout: bad });
    assert.deepEqual(r.shown(), ["a", "b", "c"], JSON.stringify(bad));
    assert.deepEqual(r.size("a"), [4, 2], JSON.stringify(bad));
  }
  // An id no widget carries any more is dropped; the rest of the layout still applies.
  const mixed = rig({ layout: { v: 1, cells: [{ id: "gone", w: 1, h: 1 }, { id: "b", w: 2, h: 1 }] } });
  assert.deepEqual(mixed.shown(), ["b"]);
  assert.deepEqual(mixed.size("b"), [2, 1]);
  // Every widget removed is a real layout, not garbage: it is honoured.
  const none = rig({ layout: { v: 1, cells: [] } });
  assert.deepEqual(none.shown(), []);
});

test("a mouse drag moves a cell where it is dropped", () => {
  const r = rig();
  r.click("[data-wg-edit]");
  assert.equal(r.editing(), true);
  assert.equal(r.document.querySelector("[data-wg-hint]").hasAttribute("hidden"), false, "the hint shows in edit mode");
  assert.equal(r.document.querySelector("[data-wg-add]").hasAttribute("hidden"), false);
  assert.equal(r.document.querySelector("[data-wg-done]").hasAttribute("hidden"), false);
  // A rect per cell: a is on top, then b, then c.
  for (const [id, top] of [["a", 0], ["b", 200], ["c", 400]]) {
    const el = r.cell(id);
    Object.defineProperty(el, "getBoundingClientRect", { value: () => ({ left: 0, top, width: 390, height: 200, right: 390, bottom: top + 200 }) });
  }
  r.fire("pointerdown", r.cell("a").querySelector(".wg-cell-body"), { clientX: 10, clientY: 10, button: 0, pointerType: "mouse", pointerId: 1 });
  r.fire("pointermove", r.grid, { clientX: 10, clientY: 405, button: 0, pointerType: "mouse", pointerId: 1 });
  r.fire("pointerup", r.grid, { clientX: 10, clientY: 405, pointerType: "mouse", pointerId: 1 });
  assert.deepEqual(r.shown(), ["b", "a", "c"], "dropped on c's near half: just before c");
  assert.equal(r.grid.hasAttribute("data-wg-dragging"), false, "the drag state is cleared");
  // Dropped on b's far half: just after b.
  r.fire("pointerdown", r.cell("b").querySelector(".wg-cell-body"), { clientX: 380, clientY: 210, button: 0, pointerType: "mouse", pointerId: 1 });
  r.fire("pointermove", r.grid, { clientX: 380, clientY: 390, button: 0, pointerType: "mouse", pointerId: 1 });
  r.fire("pointerup", r.grid, { clientX: 380, clientY: 390, pointerType: "mouse", pointerId: 1 });
  assert.deepEqual(r.shown(), ["b", "a", "c"], "a drag on b's own far half leaves the order alone");
});

test("a touch drag starts only after a long press; moving first is a scroll, not a drag", async () => {
  const boxes = { a: [0, 0, 390, 200], b: [0, 200, 390, 200], c: [0, 400, 390, 200] };
  const scrolled = rig({ boxes });
  scrolled.click("[data-wg-edit]");
  scrolled.fire("pointerdown", scrolled.cell("a"), { clientX: 10, clientY: 10, pointerType: "touch", pointerId: 2 });
  scrolled.fire("pointermove", scrolled.grid, { clientX: 12, clientY: 60, pointerType: "touch", pointerId: 2 });
  await sleep(500);
  scrolled.fire("pointermove", scrolled.grid, { clientX: 10, clientY: 405, pointerType: "touch", pointerId: 2 });
  scrolled.fire("pointerup", scrolled.grid, { clientX: 10, clientY: 405, pointerType: "touch", pointerId: 2 });
  assert.deepEqual(scrolled.shown(), ["a", "b", "c"], "the finger moved before the press landed: no drag");

  const held = rig({ boxes });
  held.click("[data-wg-edit]");
  held.fire("pointerdown", held.cell("a"), { clientX: 10, clientY: 10, pointerType: "touch", pointerId: 2 });
  await sleep(500);
  held.fire("pointermove", held.grid, { clientX: 10, clientY: 405, pointerType: "touch", pointerId: 2 });
  held.fire("pointerup", held.grid, { clientX: 10, clientY: 405, pointerType: "touch", pointerId: 2 });
  assert.deepEqual(held.shown(), ["b", "a", "c"], "held, then dragged: the cell moved");
});

test("the Size button cycles only the widget's own sizes, and wraps", () => {
  const r = rig();
  r.click("[data-wg-edit]");
  const allowed = JSON.parse(r.cell("a").getAttribute("data-sizes"));
  const seen = [];
  for (let i = 0; i < 5; i++) {
    r.clickIn("a", "[data-wg-size]");
    seen.push(r.size("a"));
  }
  assert.deepEqual(seen, [[2, 2], [4, 1], [2, 1], [4, 2], [2, 2]], "the list, in order, wrapping");
  for (const size of seen) assert.ok(allowed.some((s) => s[0] === size[0] && s[1] === size[1]), JSON.stringify(size));
  // A different widget has a different list, and its own cycle.
  r.clickIn("c", "[data-wg-size]");
  assert.deepEqual(r.size("c"), [1, 1]);
  r.clickIn("c", "[data-wg-size]");
  assert.deepEqual(r.size("c"), [2, 2]);
});

test("Remove then '+ Add widget' round-trips, and Done writes the layout", () => {
  const r = rig();
  r.click("[data-wg-edit]");
  r.clickIn("b", "[data-wg-remove]");
  assert.equal(r.cell("b").hasAttribute("hidden"), true, "removed on this device");
  assert.deepEqual(r.shown(), ["a", "c"]);
  assert.equal(r.saved(), null, "nothing is saved until Done");

  r.click("[data-wg-add]");
  const picker = r.document.querySelector("[data-wg-picker]");
  assert.ok(picker, "the picker was cloned out of the template into the page");
  assert.equal(picker.hasAttribute("open"), true, "and opened");
  assert.equal(picker.querySelector('[data-wg-add="b"]').hasAttribute("hidden"), false, "the removed widget is offered");
  assert.equal(picker.querySelector('[data-wg-add="a"]').hasAttribute("hidden"), true, "a widget already on the page is not");
  assert.equal(picker.querySelector("[data-wg-picker-empty]").hasAttribute("hidden"), true);

  r.click(picker.querySelector('[data-wg-add="b"]'));
  assert.deepEqual(r.shown(), ["a", "c", "b"], "added last");
  assert.deepEqual(r.size("b"), [4, 2], "at its own default size");
  assert.equal(picker.hasAttribute("open"), false, "the picker closed");

  r.click("[data-wg-done]");
  assert.equal(r.editing(), false, "Done leaves edit mode");
  assert.deepEqual(r.saved(), { v: 1, cells: [
    { id: "a", w: 4, h: 2 }, { id: "c", w: 2, h: 2 }, { id: "b", w: 4, h: 2 },
  ] });
  assert.match(r.document.querySelector("[data-wg-status]").textContent, /Layout saved/, "and says so");

  const reloaded = rig({ layout: r.saved() });
  assert.deepEqual(reloaded.shown(), ["a", "c", "b"], "the saved layout is what the next visit draws");
  assert.equal(reloaded.cell("c").getAttribute("data-w"), "2");
});

test("with every widget already on the page, the picker says so", () => {
  const r = rig();
  r.click("[data-wg-edit]");
  r.click("[data-wg-add]");
  const picker = r.document.querySelector("[data-wg-picker]");
  const offered = [...picker.querySelectorAll("[data-wg-add]")].filter((b) => !b.hasAttribute("hidden"));
  assert.deepEqual(offered, [], "nothing to add");
  assert.equal(picker.querySelector("[data-wg-picker-empty]").hasAttribute("hidden"), false);
});

test("the grid's styles: 2 columns on a phone, 4 when wide, nothing under 44 px, editing shows the handles", async () => {
  const { widgetsGridCss } = await import("../servers/gateway/widgets/grid-css.js");
  const css = widgetsGridCss();
  assert.match(css, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/, "two columns first");
  assert.match(css, /@media \(min-width: 720px\) \{ \.wg-grid \{ grid-template-columns: repeat\(4,/, "four when wide");
  assert.match(css, /\.wg-remove, \.wg-size \{[^}]*min-width: 44px; min-height: 44px/, "the handles are 44 px");
  assert.match(css, /\.wg-grid\[data-editing\] \.wg-remove/, "shown in edit mode only");
  assert.match(css, /\.wg-grid\[data-editing\] \.wg-cell-body \{ pointer-events: none; \}/, "a drag can start anywhere on the cell");
  assert.equal(css.split("</style").length - 1, 1, "one closing style tag, at the end");
  assert.ok(!css.slice(0, css.lastIndexOf("</style")).includes("</style"), "no literal closing style tag inside the string");
});

// ─── the page, in a real browser ─────────────────────────────────────────────

let server, base, chrome;

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env }, stdio: "pipe", cwd: REPO });
  const { hashToken } = await import("../servers/gateway/dashboard/auth.js");
  const c = new Database(join(dir, "crow.db"));
  c.prepare("INSERT INTO project_spaces (slug, name, type, status) VALUES ('garden','Garden','general','active')").run();
  const tok = c.prepare("INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at, created_at) VALUES (?, 'access', 'dashboard', ?, datetime('now','+1 day'), '2026-06-01 00:00:00')");
  tok.run(hashToken("grid-sess"), "dashboard");
  c.close();
  const { createDbClient } = await import("../servers/db.js");
  const { writeSetting } = await import("../servers/gateway/dashboard/settings/registry.js");
  const db = createDbClient();
  try { await writeSetting(db, "shell_since", "2026-01-01 00:00:00"); } finally { db.close(); }

  const { default: dashboardRouter } = await import("../servers/gateway/dashboard/index.js");
  const { default: express } = await import("express");
  const app = express();
  // Serve stand-in: the headers Serve really sends, so the owner's session is the owner's turn.
  app.use((req, res, next) => { Object.assign(req.headers, serveHeaders("operator@example.com")); res.redirectAfterPost = (url) => res.redirect(303, url); next(); });
  app.use(express.json({ limit: "1mb" }));
  app.use(express.static(fileURLToPath(new URL("../servers/gateway/public", import.meta.url))));
  app.use(dashboardRouter((req, res, next) => next()));
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = "http://127.0.0.1:" + server.address().port;
  chrome = await startHeadlessChrome();
});

after(async () => {
  delete process.env.CROW_FOR_YOU;
  server?.closeAllConnections?.();
  server?.close();
  if (chrome) await chrome.close();
  rmSync(dir, { recursive: true, force: true });
});

const READY = "!!window.Turbo && document.readyState === 'complete'"
  + " && !!document.querySelector('[data-wg-page][data-wg-ready=\"1\"]')"
  + " && !document.documentElement.hasAttribute('aria-busy')";
const TWO_FRAMES = "new Promise(function(r){requestAnimationFrame(function(){requestAnimationFrame(function(){r(1);});});})";
const NO_H_SCROLL = "(function(){ var g=document.querySelector('[data-wg-page]'); return {"
  + " sw: document.scrollingElement.scrollWidth, vw: window.innerWidth,"
  + " bodySw: document.body.scrollWidth, gridSw: g.scrollWidth, gridCw: g.clientWidth }; })()";
const COLUMNS = "(function(){ return getComputedStyle(document.querySelector('[data-wg-page]')).gridTemplateColumns.split(' ').length; })()";
const ORDER = "Array.prototype.map.call(document.querySelectorAll('[data-wg-page] [data-widget]'),"
  + " function(el){ return el.hasAttribute('hidden') ? null : el.getAttribute('data-widget'); })"
  + ".filter(function(id){ return id; })";
const STORED = "try { JSON.parse(localStorage.getItem('crow.widgets.layout.for-you')) } catch (e) { null }";

/** {count, bad}: the visible elements matching `sel`, and those under 44×44 as "class:text:w×h". */
const small = (sel) => `(function(){ var bad=[], count=0;
  document.querySelectorAll(${JSON.stringify(sel)}).forEach(function(el){
    var cs=getComputedStyle(el); if(cs.display==='none'||cs.visibility==='hidden') return;
    var r=el.getBoundingClientRect(); if(!r.width&&!r.height) return;
    count++;
    if(r.width<44||r.height<44) bad.push((el.className||el.tagName)+':'+(el.textContent||el.getAttribute('aria-label')||'').trim().slice(0,24)+':'+Math.round(r.width)+'x'+Math.round(r.height));
  }); return { count: count, bad: bad }; })()`;

async function assertTargets(p, groups, tag) {
  for (const [sel, min, what] of groups) {
    const r = await p.ev(small(sel));
    assert.ok(r.count >= min, `${what}: found ${r.count} visible, expected at least ${min} (${tag})`);
    assert.deepEqual(r.bad, [], `${what} ≥ 44 px (${tag})`);
  }
}

/** A tab at a viewport, logged in as the owner, its device layout forgotten. */
async function open(path = "/dashboard/for-you", { width = 390, height = 844 } = {}) {
  const tab = await (await fetch(chrome.cdp + "/json/new?about:blank", { method: "PUT" })).json();
  const { default: WebSocket } = await import("ws");
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
  let id = 0;
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mine = ++id;
    const on = (raw) => { const m = JSON.parse(raw); if (m.id !== mine) return; ws.off("message", on); m.error ? reject(new Error(method + ": " + JSON.stringify(m.error))) : resolve(m.result || {}); };
    ws.on("message", on); ws.send(JSON.stringify({ id: mine, method, params }));
  });
  const ev = async (expression) => {
    const o = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (o.exceptionDetails) throw new Error("page threw: " + JSON.stringify(o.exceptionDetails));
    return o.result.value;
  };
  const errors = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    if (m.method === "Runtime.exceptionThrown") errors.push((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text);
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push(m.params.args.map((a) => a.value ?? a.description).join(" "));
  });
  const until = async (expression, what, ms = 10000) => {
    const end = Date.now() + ms;
    for (;;) {
      let v = null;
      try { v = await ev(expression); } catch { /* mid-navigation */ }
      if (v) return v;
      if (Date.now() > end) {
        let where = "";
        try { where = await ev("location.href"); } catch {}
        throw new Error("timed out waiting for " + what + " (" + expression + ") at " + where + (errors.length ? "; page errors: " + errors.slice(-5).join(" | ") : ""));
      }
      await sleep(60);
    }
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");
  await send("Network.clearBrowserCookies");
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 900 });
  const TOUCH = width < 900;
  if (TOUCH) await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  for (const ck of [{ name: "crow_session", value: "grid-sess" }, { name: "crow_csrf", value: "tok" }]) {
    await send("Network.setCookie", { ...ck, url: base, path: "/" });
  }
  // Each tab starts from the default layout: the browser's profile (and so its localStorage) is
  // shared by every tab. Clear the key after the first paint, and reload if there was one.
  await send("Page.navigate", { url: base + path });
  await until(READY, "the widget grid");
  const hadLayout = await ev("(function(){ try { var k='crow.widgets.layout.for-you'; var v=localStorage.getItem(k); localStorage.removeItem(k); return v !== null; } catch (e) { return false; } })()");
  if (hadLayout) {
    await send("Page.reload");
    await until(READY, "the grid with a fresh layout");
  }
  await ev(TWO_FRAMES);
  /** Scroll a cell into view at the top of the page, so a drag's two points are both on screen. */
  const reveal = async (sel) => {
    await ev(`(function(){ var e=document.querySelector(${JSON.stringify(sel)}); if (e && e.scrollIntoView) e.scrollIntoView({block:'start'}); return 1; })()`);
    await ev(TWO_FRAMES);
  };
  /** A point on a cell: its top half ("near") or its bottom half ("far"), measured after `reveal`. */
  const point = async (sel, where) => {
    const p = await ev(`(function(){ var e=document.querySelector(${JSON.stringify(sel)}); if(!e) return null;`
      + ` var r=e.getBoundingClientRect(); var y = ${where === "far" ? "r.bottom - Math.min(12, r.height/4)" : "r.top + Math.min(12, r.height/4)"};`
      + " return { x: r.left + r.width/2, y: y, top: r.top, bottom: r.bottom, vh: window.innerHeight }; })()");
    assert.ok(p, "no element " + sel);
    assert.ok(p.y > 0 && p.y < p.vh, `${sel}'s drag point is on screen (${Math.round(p.y)} of ${p.vh})`);
    return p;
  };
  const click = async (sel) => {
    const p = await ev(`(function(){ var e=document.querySelector(${JSON.stringify(sel)}); if(!e) return null;`
      + " if(e.scrollIntoView) e.scrollIntoView({block:'center'}); var r=e.getBoundingClientRect();"
      + " return { x: r.left + r.width/2, y: r.top + Math.min(r.height/2, 20) }; })()");
    assert.ok(p, "no element " + sel);
    const hit = await ev(`(function(){ var h=document.elementFromPoint(${p.x}, ${p.y}); var e=document.querySelector(${JSON.stringify(sel)}); return !!(h && e && (h===e || e.contains(h))); })()`);
    assert.ok(hit, `${sel} is the element under its own centre (nothing covers it)`);
    if (TOUCH) {
      // A phone tap, as the phone sends it: touch emulation does not turn synthetic mouse presses into clicks.
      const pt = [{ x: p.x, y: p.y, id: 2, radiusX: 1, radiusY: 1, force: 1 }];
      await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pt });
      await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } else {
      for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: p.x, y: p.y, button: "left", clickCount: 1 });
    }
    await ev(TWO_FRAMES);
  };
  // Both drags drop the source on the far (bottom) half of the target: it lands just after it.
  const mouseDrag = async (fromSel, toSel) => {
    await reveal(fromSel);
    const from = await point(fromSel, "near");
    const to = await point(toSel, "far");
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1 });
    for (let i = 1; i <= 6; i++) {
      await send("Input.dispatchMouseEvent", {
        type: "mouseMoved", button: "left", buttons: 1,
        x: from.x + ((to.x - from.x) * i) / 6, y: from.y + ((to.y - from.y) * i) / 6,
      });
    }
    await sleep(80);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1 });
    await ev(TWO_FRAMES);
  };
  const touchDrag = async (fromSel, toSel) => {
    await reveal(fromSel);
    const from = await point(fromSel, "near");
    const to = await point(toSel, "far");
    const touch = (x, y) => [{ x, y, id: 1, radiusX: 1, radiusY: 1, force: 1 }];
    await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: touch(from.x, from.y) });
    await sleep(600); // longer than the client's 400 ms press
    for (let i = 1; i <= 6; i++) {
      await send("Input.dispatchTouchEvent", {
        type: "touchMove", touchPoints: touch(from.x + ((to.x - from.x) * i) / 6, from.y + ((to.y - from.y) * i) / 6),
      });
      await sleep(16);
    }
    await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await ev(TWO_FRAMES);
  };
  const reload = async () => { await send("Page.reload"); await until(READY, "the reloaded grid"); await ev(TWO_FRAMES); };
  return { send, ev, until, click, point, reveal, mouseDrag, touchDrag, reload, errors,
    close: async () => { ws.close(); await fetch(chrome.cdp + "/json/close/" + tab.id).catch(() => {}); } };
}

test("390×844: two columns, no sideways scroll, Edit mode at 44 px, a long-press drag and a reload that keeps it", async (ctx) => {
  if (!chrome) return ctx.skip("no headless Chrome (CROW_REQUIRE_TEST_CHROME=1 makes this a failure)");
  const p = await open();
  try {
    assert.equal(await p.ev("document.body.classList.contains('shell')"), true, "the new shell");
    assert.deepEqual(await p.ev(ORDER), ["needs-me", "morning", "listen", "news"], "For You's default order");
    assert.equal(await p.ev(COLUMNS), 2, "two grid columns on the phone");
    let s = await p.ev(NO_H_SCROLL);
    assert.ok(s.sw <= s.vw, `no page scroll sideways (${s.sw} ≤ ${s.vw})`);
    assert.ok(s.gridSw <= s.gridCw, `the grid does not scroll sideways (${s.gridSw} ≤ ${s.gridCw})`);
    assert.equal(await p.ev(STORED), null, "nothing stored yet: the default is drawn");

    await p.click("[data-wg-edit]");
    assert.equal(await p.ev("document.querySelector('[data-wg-page]').hasAttribute('data-editing')"), true, "edit mode is on");
    await assertTargets(p, [
      ["[data-wg-add]", 1, "Add widget"],
      ["[data-wg-done]", 1, "Done"],
      ["[data-wg-remove]", 4, "Remove buttons"],
      ["[data-wg-size]", 4, "Size buttons"],
    ], "phone, editing");

    await p.touchDrag('[data-widget="needs-me"]', '[data-widget="morning"]');
    assert.deepEqual(await p.ev(ORDER), ["morning", "needs-me", "listen", "news"], "the long press dropped the first cell after Your morning");
    s = await p.ev(NO_H_SCROLL);
    assert.ok(s.sw <= s.vw, "still no sideways scroll mid-edit");

    await p.click("[data-wg-done]");
    assert.equal(await p.ev("document.querySelector('[data-wg-page]').hasAttribute('data-editing')"), false, "Done leaves edit mode");
    const stored = await p.ev(STORED);
    assert.deepEqual(stored.cells.map((c) => c.id), ["morning", "needs-me", "listen", "news"], "the device's layout");
    assert.equal(stored.v, 1);

    await p.reload();
    assert.deepEqual(await p.ev(ORDER), ["morning", "needs-me", "listen", "news"], "the reload keeps the order");
    assert.equal(await p.ev(COLUMNS), 2);
    s = await p.ev(NO_H_SCROLL);
    assert.ok(s.sw <= s.vw);
    await assertTargets(p, [["[data-wg-edit]", 1, "Edit"]], "phone, not editing");
    assert.deepEqual(p.errors, [], "no page errors");
  } finally { await p.close(); }
});

test("1280×800: four columns, a resize, a mouse drag, and a Remove / Add round-trip that survives a reload", async (ctx) => {
  if (!chrome) return ctx.skip("no headless Chrome (CROW_REQUIRE_TEST_CHROME=1 makes this a failure)");
  const p = await open("/dashboard/for-you", { width: 1280, height: 800 });
  try {
    assert.equal(await p.ev(COLUMNS), 4, "four grid columns when wide");
    const s = await p.ev(NO_H_SCROLL);
    assert.ok(s.sw <= s.vw, `no page scroll sideways (${s.sw} ≤ ${s.vw})`);
    assert.deepEqual(await p.ev(ORDER), ["needs-me", "morning", "listen", "news"]);

    await p.click("[data-wg-edit]");
    await assertTargets(p, [["[data-wg-remove]", 4, "Remove buttons"], ["[data-wg-size]", 4, "Size buttons"]], "desktop, editing");

    // The Size button steps through the widget's own list and nothing else.
    const allowed = await p.ev("JSON.parse(document.querySelector('[data-widget=\"morning\"]').getAttribute('data-sizes'))");
    const before = await p.ev("document.querySelector('[data-widget=\"morning\"]').getAttribute('data-w') + ',' + document.querySelector('[data-widget=\"morning\"]').getAttribute('data-h')");
    await p.click('[data-widget="morning"] [data-wg-size]');
    const after = await p.ev("document.querySelector('[data-widget=\"morning\"]').getAttribute('data-w') + ',' + document.querySelector('[data-widget=\"morning\"]').getAttribute('data-h')");
    assert.notEqual(after, before, "the size changed");
    assert.ok(allowed.map((a) => a.join(",")).includes(after), `and it is one of ${JSON.stringify(allowed)}`);

    await p.mouseDrag('[data-widget="needs-me"]', '[data-widget="morning"]');
    assert.deepEqual(await p.ev(ORDER), ["morning", "needs-me", "listen", "news"], "dropped on Your morning's far half: just after it");

    // Remove the last widget here, then add it back from the picker: it goes last.
    await p.click('[data-widget="news"] [data-wg-remove]');
    assert.deepEqual(await p.ev(ORDER), ["morning", "needs-me", "listen"]);
    await p.click("[data-wg-add]");
    await p.until("!!document.querySelector('[data-wg-picker][open]')", "the picker");
    await p.ev(TWO_FRAMES);
    await assertTargets(p, [["[data-wg-picker] [data-wg-add]", 1, "picker buttons"]], "desktop, picker");
    const offered = (await p.ev("[...document.querySelectorAll('[data-wg-picker] [data-wg-add]')].filter(function(b){return !b.hasAttribute('hidden')}).map(function(b){return b.getAttribute('data-wg-add')}).join(',')")).split(",");
    assert.ok(offered.includes("news"), "the removed widget is offered: " + offered.join(","));
    for (const id of ["morning", "needs-me", "listen"]) assert.ok(!offered.includes(id), id + ", still on the page, is not offered");
    await p.click('[data-wg-picker] [data-wg-add="news"]');
    await p.ev(TWO_FRAMES);
    assert.deepEqual(await p.ev(ORDER), ["morning", "needs-me", "listen", "news"], "added back, last");

    await p.click("[data-wg-done]");
    const stored = await p.ev(STORED);
    assert.deepEqual(stored.cells.map((c) => c.id), ["morning", "needs-me", "listen", "news"]);
    await p.reload();
    assert.deepEqual(await p.ev(ORDER), ["morning", "needs-me", "listen", "news"], "the reload keeps order and sizes");
    assert.equal(await p.ev("document.querySelector('[data-widget=\"morning\"]').getAttribute('data-w')"), after.split(",")[0], "and the resized width");
    assert.deepEqual(p.errors, [], "no page errors");
  } finally { await p.close(); }
});