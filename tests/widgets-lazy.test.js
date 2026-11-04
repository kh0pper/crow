/**
 * Widgets phase 4: a widget that is NOT on a page's default layout is not loaded with that page.
 *
 * Both widget pages used to run every offered widget's loader on every page view, including the
 * cells drawn `hidden` because they are on neither default layout (the weather, the in-Crow
 * launchers, every add-on). Now:
 *   - `splitForPage` (widgets/grid-html.js) is the one place the offer is cut: the page's default
 *     layout is loaded with the page, everything else is a lazy cell;
 *   - a lazy cell is drawn hidden like before, plus `data-wg-lazy="1"`, and its body is one
 *     `widgets.grid.loading` line; the picker still lists it;
 *   - the device fetches that body from GET /dashboard/widgets-api/cell the moment it shows the
 *     cell (widgets/grid-client.js), which is owner-only, offers only what `widgetsForPage` offers
 *     for that page, and renders with the same `cellBodyHtml` the page draws a cell with.
 *
 * The probe add-on installed below is a real installed bundle: its loader counts its own calls in
 * `globalThis`, so "the page never loaded it" is asserted against a loader that would have recorded
 * it. Nothing here reaches the network.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import Database from "better-sqlite3";
import { parseHTML } from "linkedom";
import { startHeadlessChrome } from "./fixtures/headless-chrome.mjs";
import { actAsServe, serveHeaders } from "./fixtures/serve-peer.mjs";
import { widgetOf, widgetsForPage, loadWidgets } from "../servers/gateway/widgets/registry.js";
import { splitForPage, gridHtml, gridCellHtml, defaultOnFor } from "../servers/gateway/widgets/grid-html.js";
import { gridClientJs } from "../servers/gateway/widgets/grid-client.js";
import { forYouPageHtml } from "../servers/gateway/dashboard/panels/for-you/html.js";
import { t } from "../servers/gateway/dashboard/shared/i18n.js";
actAsServe(); // this process's HTTP client stands in for tailscaled (the Serve socket owner)

const dir = mkdtempSync(join(tmpdir(), "widgets-lazy-"));
process.env.CROW_DATA_DIR = dir;
const HOME = join(dir, "home");
process.env.CROW_HOME = HOME;
mkdirSync(HOME, { recursive: true });
delete process.env.CROW_DB_PATH;
delete process.env.CROW_FOR_YOU;
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db"); // absent: an empty "What needs me"
process.env.PIBOT_PI_CLI = "/nonexistent/pi-never-spawned-by-this-file.js";
const DB_FILE = join(dir, "crow.db");
writeFileSync(join(dir, "instance-id"), "instance-widgets-lazy");
const REPO = new URL("..", import.meta.url).pathname;

// ─── the probe add-on ────────────────────────────────────────────────────────
// One installed bundle, two widgets: one that says how often it was loaded, one that throws. Its
// widgets are on neither page's default layout, so both are lazy cells on both pages.
const PROBE = "probe";
const PROBE_GOOD = `addon-${PROBE}-spin`;
const PROBE_BOOM = `addon-${PROBE}-boom`;
const PROBE_TITLE = "Probe";

function installProbe() {
  const bdir = join(HOME, "bundles", PROBE);
  mkdirSync(join(bdir, "widgets"), { recursive: true });
  writeFileSync(join(bdir, "manifest.json"), JSON.stringify({
    id: PROBE, name: "Probe", description: "d", type: "bundle", category: "misc", version: "1.0.0",
    widgets: [
      { id: "spin", title: PROBE_TITLE, sizes: [[2, 1], [4, 1]] },
      { id: "boom", title: "Boom", sizes: [[2, 1]] },
    ],
  }));
  writeFileSync(join(bdir, "widgets", "spin.js"), [
    "export async function load() {",
    "  globalThis.__probeWidgetLoads = (globalThis.__probeWidgetLoads || 0) + 1;",
    '  return { state: "ok", headline: "Probe body", items: [], more_href: null };',
    "}",
    "",
  ].join("\n"));
  writeFileSync(join(bdir, "widgets", "boom.js"),
    'export async function load() { throw new Error("the probe is unhappy"); }\n');
  writeFileSync(join(HOME, "installed.json"), JSON.stringify([PROBE]));
}
installProbe();

const probeLoads = () => Number(globalThis.__probeWidgetLoads || 0);

// ─── the split ───────────────────────────────────────────────────────────────

test("splitForPage: the page's own default layout loads with it, every other offer is lazy", () => {
  const halves = (page) => {
    const { eager, lazy } = splitForPage(widgetsForPage(page, { crowHome: HOME }), page);
    return { eager: eager.map((w) => w.id), lazy: lazy.map((w) => w.id) };
  };
  assert.deepEqual(halves("widgets"), {
    eager: ["needs-me", "today"],
    lazy: ["morning", "moves", "listen", "news", "weather", "messages", "apps", "projects", "bots", `addon-${PROBE}-spin`, `addon-${PROBE}-boom`],
  }, "the generic page's default is What needs me and Today + Ramble; everything else waits");
  assert.deepEqual(halves("for-you"), {
    eager: ["needs-me", "morning", "moves", "listen", "news"],
    lazy: ["today", "weather", "messages", "apps", "projects", "bots", `addon-${PROBE}-spin`, `addon-${PROBE}-boom`],
  }, "For You's default is its five cards, in order");

  // The two halves are the offer, whole and in its order: nothing added, nothing lost.
  for (const page of ["widgets", "for-you"]) {
    const offered = widgetsForPage(page, { crowHome: HOME });
    const { eager, lazy } = splitForPage(offered, page);
    assert.equal(eager.length + lazy.length, offered.length, page);
    assert.deepEqual([...eager, ...lazy].sort((a, b) => a.id.localeCompare(b.id)), offered.slice().sort((a, b) => a.id.localeCompare(b.id)), page);
    for (const widget of eager) assert.equal(defaultOnFor(widget, page), true, `${widget.id} is on ${page}'s default`);
    for (const widget of lazy) assert.equal(defaultOnFor(widget, page), false, `${widget.id} is not on ${page}'s default`);
  }

  assert.deepEqual(splitForPage([]), { eager: [], lazy: [] }, "no offer, no split");
  assert.deepEqual(splitForPage(null, "widgets"), { eager: [], lazy: [] });
});

// ─── the markup ──────────────────────────────────────────────────────────────

/** A stand-in widget: its loader and renderer say whether they were reached. */
function standIn(id, { defaultOn = true, reached }) {
  return {
    id,
    titleKey: "forYou.morning",
    sizes: [[2, 1], [4, 1]],
    defaultSize: [2, 1],
    pages: ["widgets"],
    defaultOn,
    load: async () => { reached.push("load:" + id); return {}; },
    render: () => { reached.push("render:" + id); return `<p id="body-${id}">${id}</p>`; },
  };
}

test("a lazy cell is drawn hidden with one loading line, and its loader and renderer never run", async () => {
  const reached = [];
  const eager = standIn("eager", { reached });
  const lazyOne = standIn("lazy-one", { defaultOn: false, reached });
  const offered = [eager, lazyOne];
  const { eager: loadThese, lazy } = splitForPage(offered, "widgets");
  assert.deepEqual(loadThese.map((w) => w.id), ["eager"], "only the default-layout widget is in the page's loads");
  assert.deepEqual(lazy.map((w) => w.id), ["lazy-one"]);

  const loaded = await loadWidgets(loadThese, {});
  const html = gridHtml("widgets", [...loaded, { widget: lazyOne, lazy: true }], "en");
  assert.deepEqual(reached, ["load:eager", "render:eager"], "the lazy widget was never loaded or rendered");

  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  const cell = document.querySelector('[data-widget="lazy-one"]');
  assert.ok(cell, "the cell is drawn");
  assert.equal(cell.hasAttribute("hidden"), true, "like every offered cell that is not on the default layout");
  assert.equal(cell.getAttribute("data-wg-lazy"), "1", "and marked lazy");
  assert.equal(cell.querySelectorAll(".wg-cell-body > *").length, 1, "the body holds exactly one line");
  assert.equal(cell.querySelector(".wg-cell-body > .fy-note").textContent, t("widgets.grid.loading", "en"));
  assert.deepEqual([cell.getAttribute("data-w"), cell.getAttribute("data-h")], ["2", "1"], "the widget's own size");
  assert.equal(cell.querySelector("[data-wg-remove]").getAttribute("aria-label"), "Remove Your morning", "the handles are there as on any cell");
  assert.equal(cell.querySelector("[data-wg-size]").getAttribute("aria-label"), "Change the size of Your morning");

  // The default-layout cell is exactly what it was: loaded, rendered, marked lazy by nothing.
  const live = document.querySelector('[data-widget="eager"]');
  assert.equal(live.hasAttribute("data-wg-lazy"), false);
  assert.match(live.querySelector(".wg-cell-body").innerHTML, /id="body-eager"/);

  // The picker still lists the lazy widget, by its title.
  const picker = document.querySelector("[data-wg-picker-tpl]").innerHTML;
  assert.match(picker, /data-wg-add="lazy-one"/);
  assert.match(picker, /Your morning/);

  // The two lines the client may need are carried on the grid, in the page's language.
  const grid = document.querySelector(".wg-grid");
  assert.equal(grid.getAttribute("data-wg-nothing"), t("widgets.grid.nothing", "en"));
  assert.equal(grid.getAttribute("data-wg-error"), t("widgets.grid.error", "en"));
  assert.equal(grid.getAttribute("data-wg-page"), "widgets");
});

test("Spanish: the same loading, nothing and error lines, from the page's own language", () => {
  const weather = widgetOf("weather");
  const html = gridHtml("for-you", [{ widget: weather, lazy: true }], "es");
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  assert.equal(document.querySelector(".wg-cell-body").textContent, t("widgets.grid.loading", "es"));
  const grid = document.querySelector(".wg-grid");
  assert.equal(grid.getAttribute("data-wg-nothing"), t("widgets.grid.nothing", "es"));
  assert.equal(grid.getAttribute("data-wg-error"), t("widgets.grid.error", "es"));
  // A page that draws its own cells (forYouCells, widgets phase 2's other caller) is untouched: no
  // cell it draws is a lazy placeholder.
  const pageHtml = forYouPageHtml({
    settings: { sections: { morning: true, moves: true, listen: true, news: true, weather: true }, city: "", place: null },
    dateText: "viernes, 30 de octubre",
    needsMe: { id: "needs-me", title: "What needs me", state: "empty", headline: "All clear", items: [], doing: [], more_href: "/dashboard/bot-board", lock: { count: 0, label: "0 waiting" } },
    morning: { needs: { total: 0, items: [] }, due: { total: 0, items: [] }, finished: { total: 0, items: [] }, leftOff: null },
    moves: { ramble: "ok", moves: { challenge: { day: "2026-10-30", title: "Estirar", minutes: 10, why: "", done: false }, off: false, health: { energy: 18, max: 30 }, steps: { today: 3200, goal: 6000 }, streak: { days: 4 } } },
    listen: { media: "missing", music: false },
    news: { state: "missing", stories: [], hidden: [] },
  }, "es", Date.parse("2026-10-30T12:00:00Z"));
  assert.doesNotMatch(pageHtml, /data-wg-lazy/, "a page-drawn cell is loaded, never lazy");
  assert.match(pageHtml, /data-widget="morning"/);
});

test("a lazy cell for a widget with nothing to show: the server says so on the grid, not in a cell", async () => {
  // The month-old contract holds: an eager widget that renders "" draws no cell at all.
  const empty = { id: "nothing", titleKey: "forYou.morning", sizes: [[2, 1]], defaultSize: [2, 1], load: async () => ({}), render: () => "" };
  const html = gridHtml("widgets", await loadWidgets([empty], {}), "en");
  assert.equal(html.includes('data-widget="nothing"'), false);
  // A LAZY one is drawn anyway: the page cannot know in advance, so the device is told the nothing
  // line instead (the route answers html: "" and the client draws it).
  const lazyHtml = gridHtml("widgets", [{ widget: empty, lazy: true }], "en");
  assert.ok(lazyHtml.includes('data-widget="nothing"'));
  assert.match(lazyHtml, /data-wg-nothing="Nothing to show here right now\."/);
});

test("gridCellHtml: an entry is lazy only when it says so", () => {
  const widget = standIn("plain", { reached: [] });
  const live = gridCellHtml({ widget, data: {} }, "en", undefined, "widgets");
  assert.doesNotMatch(live, /data-wg-lazy/);
  const lazy = gridCellHtml({ widget, lazy: true }, "en", undefined, "widgets");
  assert.match(lazy, /data-wg-lazy="1"/);
});

// ─── the real pages and the cell route ───────────────────────────────────────

let server, base, MODE, panelMod, settingsMod;

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env }, stdio: "pipe", cwd: REPO });
  const { hashToken } = await import("../servers/gateway/dashboard/auth.js");
  const c = new Database(DB_FILE);
  c.prepare("INSERT INTO project_spaces (slug, name, type, status) VALUES ('garden','Garden','general','active')").run();
  const tok = c.prepare("INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at, created_at) VALUES (?, 'access', 'dashboard', ?, datetime('now','+1 day'), '2026-06-01 00:00:00')");
  tok.run(hashToken("owner-sess"), "dashboard");
  tok.run(hashToken("plain-sess"), "");
  tok.run(hashToken("sso-sess"), "dashboard sso src:instance-peer");
  c.close();

  const { createDbClient } = await import("../servers/db.js");
  const { writeSetting } = await import("../servers/gateway/dashboard/settings/registry.js");
  const db = createDbClient();
  try { await writeSetting(db, "shell_since", "2026-01-01 00:00:00"); } finally { db.close(); }

  panelMod = await import("../servers/gateway/dashboard/panels/for-you.js");
  settingsMod = await import("../servers/gateway/for-you/settings.js");
  const mode = await import("../servers/gateway/dashboard/shell/mode.js");
  MODE = mode.cookieName(mode.MODE_COOKIE);
  const { default: dashboardRouter } = await import("../servers/gateway/dashboard/index.js");
  const { default: express } = await import("express");
  const app = express();
  app.use((req, res, next) => { res.redirectAfterPost = (url) => res.redirect(303, url); next(); });
  app.use(express.json({ limit: "1mb" }));
  app.use(dashboardRouter((req, res, next) => next()));
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = "http://127.0.0.1:" + server.address().port;
});

after(() => {
  delete process.env.CROW_FOR_YOU;
  server?.closeAllConnections?.();
  server?.close();
  rmSync(dir, { recursive: true, force: true });
});

const CALENDAR = { summary: "Dentist", start: "2026-11-03T18:30:00Z", all_day: false };
const RAMBLE = { mood: "tired", energy: 24, max: 60, steps: { today: 3200, goal: 6000 } };

beforeEach(async () => {
  globalThis.__probeWidgetLoads = 0;
  const { _setTodaySeamsForTest } = await import("../servers/gateway/for-you/today.js");
  _setTodaySeamsForTest({ calendar: async () => CALENDAR, ramble: async () => RAMBLE });
  // No weather service is ever reached (no city, so no reading and no network).
  panelMod._setForYouSeamsForTest({ weather: async () => null });
  // The For You switches back on, and no weather place.
  const { createDbClient } = await import("../servers/db.js");
  const db = createDbClient();
  try { await settingsMod.writeForYouSettings(db, settingsMod.normalizeSettings({})); } finally { db.close(); }
});

const NET = serveHeaders("operator@example.com");
const jar = (sess) => `crow_session=${sess}; crow_csrf=tok; ${MODE}=new`;
async function get(path, sess = "owner-sess") {
  const r = await fetch(base + path, { redirect: "manual", headers: { ...NET, cookie: jar(sess) } });
  return { status: r.status, cache: r.headers.get("cache-control"), body: await r.text() };
}
async function cell(page, id, sess = "owner-sess") {
  const r = await fetch(`${base}/dashboard/widgets-api/cell?page=${encodeURIComponent(page)}&id=${encodeURIComponent(id)}`, {
    redirect: "manual", headers: { ...NET, cookie: jar(sess), accept: "application/json" },
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, cache: r.headers.get("cache-control"), type: r.headers.get("content-type"), text, json };
}
async function withFlag(fn) {
  process.env.CROW_FOR_YOU = "1";
  try { return await fn(); } finally { delete process.env.CROW_FOR_YOU; }
}

/** A cell's body as the page drew it: exactly what the route has to answer for that widget. */
function drawnBody(html, id) {
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  const body = document.querySelector(`[data-widget="${id}"] .wg-cell-body`);
  return body ? body.innerHTML : null;
}

/** Markup through the same parser, so the comparison is about the markup and not the serializer. */
function reparsed(html) {
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  return document.body.innerHTML;
}

test("the widgets page loads only its default layout: the lazy cells are drawn, never loaded", async () => {
  await withFlag(async () => {
    const r = await get("/dashboard/widgets");
    assert.equal(r.status, 200);
    assert.equal(probeLoads(), 0, "the add-on widget's loader was never called for the page");

    const { document } = parseHTML(`<!doctype html><html><body>${r.body}</body></html>`);
    const grid = document.querySelector('.wg-grid[data-wg-page="widgets"]');
    const cells = [...grid.querySelectorAll("[data-widget]")];
    const lazyIds = cells.filter((el) => el.getAttribute("data-wg-lazy") === "1").map((el) => el.getAttribute("data-widget"));
    assert.ok(lazyIds.includes(PROBE_GOOD), "the add-on widget is a lazy cell");
    for (const id of ["morning", "moves", "listen", "news", "weather", "messages", "apps", "projects", "bots", PROBE_GOOD, PROBE_BOOM]) {
      assert.ok(lazyIds.includes(id), `${id} is lazy on the widgets page`);
    }
    const lazy = grid.querySelector(`[data-widget="${PROBE_GOOD}"]`);
    assert.equal(lazy.hasAttribute("hidden"), true, "hidden until this device adds it");
    assert.equal(lazy.querySelector(".wg-cell-body").textContent, t("widgets.grid.loading", "en"), "one loading line");
    assert.match(grid.querySelector("[data-wg-picker-tpl]").innerHTML, new RegExp(`data-wg-add="${PROBE_GOOD}">${PROBE_TITLE}<`), "the picker lists it by title");

    // The default layout is loaded and drawn as it always was.
    for (const id of ["needs-me", "today"]) {
      const cellEl = grid.querySelector(`[data-widget="${id}"]`);
      assert.equal(cellEl.hasAttribute("data-wg-lazy"), false, `${id} is loaded with the page`);
      assert.equal(cellEl.hasAttribute("hidden"), false);
      assert.ok(cellEl.querySelector(".wg-cell-body").children.length > 0, `${id} has its body`);
    }
  });
});

test("For You loads only its own five; Today + Ramble and the rest wait for this device", async () => {
  await withFlag(async () => {
    const r = await get("/dashboard/for-you");
    assert.equal(r.status, 200);
    assert.equal(probeLoads(), 0, "no lazy widget was loaded");
    const { document } = parseHTML(`<!doctype html><html><body>${r.body}</body></html>`);
    const grid = document.querySelector('.wg-grid[data-wg-page="for-you"]');
    const eager = [...grid.querySelectorAll("[data-widget]")].filter((el) => el.getAttribute("data-wg-lazy") !== "1");
    assert.deepEqual(eager.map((el) => el.getAttribute("data-widget")), ["needs-me", "morning", "listen", "news"], "the four cards that drew a body (Move draws none without Ramble installed)");
    const today = grid.querySelector('[data-widget="today"]');
    assert.equal(today.getAttribute("data-wg-lazy"), "1", "Today + Ramble is lazy here");
    assert.equal(today.querySelector(".wg-cell-body").textContent, t("widgets.grid.loading", "en"));
    assert.deepEqual([today.getAttribute("data-w"), today.getAttribute("data-h")], ["2", "2"], "at its own default size");
    // The header's weather chip is not a widget cell and still reads once with the page.
    assert.match(r.body, /class="fy-head"/);
  });
});

// ─── the route ───────────────────────────────────────────────────────────────

test("cell route: the owner's own session only — every other session is 404 and loads nothing", async () => {
  await withFlag(async () => {
    for (const sess of ["plain-sess", "sso-sess"]) {
      const r = await cell("widgets", PROBE_GOOD, sess);
      assert.equal(r.status, 404, sess);
      assert.equal(r.json?.html, undefined, `${sess} gets no html`);
    }
    assert.equal(probeLoads(), 0, "the widget's loader was never called for a refused request");
    // And the owner's own request does load it, exactly once.
    const own = await cell("widgets", PROBE_GOOD);
    assert.equal(own.status, 200);
    assert.equal(probeLoads(), 1);
  });
});

test("cell route: an unknown page, a page whose flag is off, and an id the page does not offer are 404", async () => {
  await withFlag(async () => {
    for (const page of ["", "nope", "FOR-YOU", "for_you"]) {
      const r = await cell(page, "today");
      assert.equal(r.status, 404, JSON.stringify(page));
      assert.equal(r.json?.code, undefined, "a page that is not one of the two says nothing else");
    }
    // A widget whose For You switch is off is not offered, so it has no cell to fill.
    const { createDbClient } = await import("../servers/db.js");
    const db = createDbClient();
    try {
      await settingsMod.writeForYouSettings(db, settingsMod.normalizeSettings({ sections: { morning: false } }));
    } finally { db.close(); }
    const off = await cell("for-you", "morning");
    assert.equal(off.status, 404);
    assert.equal(off.json?.code, "no_widget");
    assert.equal(probeLoads(), 0, "nothing was loaded to answer a 404");
    // An id no page offers at all is the same answer, never a lookup by any other route.
    for (const id of ["", "nope", "../today", "addon-nobody-nothing"]) {
      const r = await cell("widgets", id);
      assert.equal(r.status, 404, JSON.stringify(id));
      assert.equal(r.json?.code, "no_widget", JSON.stringify(id));
    }
  });
  // The page's own gate applies to the route too: no flag, no cell.
  const off = await cell("widgets", "today");
  assert.equal(process.env.CROW_FOR_YOU, undefined);
  assert.equal(off.status, 404);
  assert.equal(off.json?.html, undefined);
});

test("cell route: it answers exactly the body the page draws, uncached, for either page", async () => {
  await withFlag(async () => {
    // Today + Ramble is loaded with the widgets page, so the page's own drawing is the answer.
    const page = await get("/dashboard/widgets");
    const expected = drawnBody(page.body, "today");
    assert.ok(expected && expected.length > 0, "the page drew Today + Ramble");
    const asked = await cell("widgets", "today");
    assert.equal(asked.status, 200);
    assert.equal(asked.cache, "no-store");
    assert.match(String(asked.type), /application\/json/);
    assert.deepEqual(Object.keys(asked.json).sort(), ["html", "id"], "one id and one body");
    assert.equal(asked.json.id, "today");
    assert.equal(reparsed(asked.json.html), expected, "the same markup the page would have drawn");

    // A lazy widget asked for by the page that does not draw it: the answer is the same body the
    // OTHER page draws eagerly.
    const forYou = await get("/dashboard/for-you");
    const morning = drawnBody(forYou.body, "morning");
    assert.ok(morning && morning.length > 0, "For You drew Your morning");
    const lazyAsk = await cell("widgets", "morning");
    assert.equal(lazyAsk.status, 200);
    assert.equal(reparsed(lazyAsk.json.html), morning, "Your morning, from the widgets page's own offer");

    // An add-on widget: the same discovery the page uses, and the loader's own answer.
    const addon = await cell("widgets", PROBE_GOOD);
    assert.equal(addon.status, 200);
    assert.equal(addon.json.html, expectedAddonHtml());
    assert.match(addon.json.html, /Probe body/);
  });
});

/** The probe add-on's cell body, as its renderer draws it from its own loader's answer. */
function expectedAddonHtml() {
  const widget = widgetsForPage("widgets", { crowHome: HOME }).find((w) => w.id === PROBE_GOOD);
  return widget.render({ state: "ok", headline: "Probe body", items: [], more_href: null }, "en");
}

test("cell route: a loader that throws is the widget's own error line, not a 500", async () => {
  await withFlag(async () => {
    const r = await cell("widgets", PROBE_BOOM);
    assert.equal(r.status, 200, "the cell still answers");
    assert.equal(r.json.id, PROBE_BOOM);
    assert.equal(r.json.html, `<p class="fy-note">${t("widgets.grid.error", "en")}</p>`);
    assert.doesNotMatch(r.text, /the probe is unhappy/, "the add-on's own words never reach the device");

    // A widget with its own error card keeps it (What needs me's title and its way into the list).
    panelMod._setForYouSeamsForTest({ needsMe: async () => { throw new Error("aggregator down"); } });
    const needs = await cell("widgets", "needs-me");
    assert.equal(needs.status, 200);
    assert.match(needs.json.html, /<section class="fy-card fy-needs"/);
    assert.match(needs.json.html, new RegExp(t("widgets.needsMe.error", "en")));
    assert.doesNotMatch(needs.text, /aggregator down/);
  });
});

test("cell route: a widget with nothing to show answers html \"\" (the client draws the nothing line)", async () => {
  await withFlag(async () => {
    // The weather is offered, but with no city there is no reading: the render is "".
    const r = await cell("widgets", "weather");
    assert.equal(r.status, 200);
    assert.equal(r.json.id, "weather");
    assert.equal(r.json.html, "");
    // Even a weather read that throws is no reading (For You's context degrades it), so the answer is
    // still the empty one rather than a 500.
    panelMod._setForYouSeamsForTest({ weather: async () => { throw new Error("no service"); } });
    const broken = await cell("widgets", "weather");
    assert.equal(broken.status, 200);
    assert.equal(broken.json.html, "");
  });
});

test("cell route: a title from a row is escaped in the fetched body, never markup", async () => {
  await withFlag(async () => {
    const evil = {
      id: "needs-me", title: '<script>alert("title")</script>', state: "empty", headline: "Clear",
      items: [], doing: [], more_href: "/dashboard/bot-board", lock: { count: 0, label: "0 waiting" },
    };
    panelMod._setForYouSeamsForTest({ needsMe: async () => evil });
    const r = await cell("widgets", "needs-me");
    assert.equal(r.status, 200);
    assert.ok(!r.json.html.includes("<script>"), "no script tag survives the fetch");
    assert.match(r.json.html, /&lt;script&gt;alert\(&quot;title&quot;\)&lt;\/script&gt;/);
  });
});

test("cell route: the language is the request's own cookie, as every other route picks it", async () => {
  await withFlag(async () => {
    const r = await fetch(`${base}/dashboard/widgets-api/cell?page=widgets&id=${PROBE_BOOM}`, {
      headers: { ...NET, cookie: `crow_session=owner-sess; crow_csrf=tok; crow_lang=es; ${MODE}=new` },
    });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).html, `<p class="fy-note">${t("widgets.grid.error", "es")}</p>`);
  });
});

// ─── the client, in a vm ────────────────────────────────────────────────────

const CLIENT = (() => {
  const js = gridClientJs();
  assert.ok(!js.includes("`"), "grid-client may carry no backtick: it is emitted inside a template literal");
  assert.ok(!js.includes("${"), "and no ${ either");
  return js.replace(/^<script>\s*/, "").replace(/<\/script>\s*$/, "");
})();

const KEY = "crow.widgets.layout.for-you";

/**
 * For You's grid, the client run over it in a vm, and a stubbed `window.fetch` that answers like
 * the cell route. `layout` is what this device has saved (undefined: none at all).
 */
function rig({ layout, respond }) {
  const live = { id: "live", titleKey: "forYou.morning", sizes: [[2, 1]], defaultSize: [2, 1], pages: ["for-you"], defaultOn: true, render: () => `<p id="h-live">Live</p>` };
  const lazyWidget = { id: "lazy", titleKey: "forYou.news", sizes: [[2, 1]], defaultSize: [2, 1], pages: ["for-you"], defaultOn: false, render: () => `<p id="h-lazy">Fetched</p>` };
  const cells = [{ widget: live, data: {} }, { widget: lazyWidget, lazy: true }];
  const { document, window } = parseHTML(`<!doctype html><html><body>${gridHtml("for-you", cells, "en")}</body></html>`);
  const store = new Map();
  if (layout !== undefined) store.set(KEY, JSON.stringify(layout));
  const calls = [];
  window.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
  window.fetch = (url, opts) => {
    calls.push({ url, opts });
    return Promise.resolve(respond(url, opts));
  };
  const ctx = vm.createContext({ window, document, JSON, Number, Object, Array, String, isFinite, setTimeout, clearTimeout, encodeURIComponent });
  vm.runInContext(CLIENT, ctx);
  const grid = document.querySelector("[data-wg-page]");
  const cellOf = (id) => document.querySelector(`[data-widget="${id}"]`);
  return { document, window, grid, cellOf, calls, shown: () => [...grid.querySelectorAll("[data-widget]")].filter((el) => !el.hasAttribute("hidden")).map((el) => el.getAttribute("data-widget")) };
}

/** Let the client's fetch chain (and the DOM work after it) run. */
const settle = () => new Promise((r) => setTimeout(r, 20));

const shownLazy = { v: 1, cells: [{ id: "live", w: 2, h: 1 }, { id: "lazy", w: 2, h: 1 }] };

test("the client fills a lazy cell this device shows, and stops being lazy", async () => {
  const r = rig({ layout: shownLazy, respond: () => ({ ok: true, json: async () => ({ id: "lazy", html: '<p id="h-lazy">Fetched</p>' }) }) });
  await settle();
  assert.equal(r.calls.length, 1, "one fetch for the one shown lazy cell");
  assert.equal(r.calls[0].url, "/dashboard/widgets-api/cell?page=for-you&id=lazy");
  assert.equal(r.calls[0].opts.credentials, "same-origin");
  assert.equal(r.calls[0].opts.headers.Accept, "application/json");
  const cell = r.cellOf("lazy");
  assert.equal(cell.hasAttribute("data-wg-lazy"), false, "no longer lazy: it has its body");
  assert.match(cell.querySelector(".wg-cell-body").innerHTML, /id="h-lazy"/);
  assert.equal(r.cellOf("live").hasAttribute("data-wg-lazy"), false);
  assert.equal(r.calls.filter((c) => c.url.includes("id=live")).length, 0, "an eager cell is never fetched");
});

test("the client never fetches a lazy cell this device does not show", async () => {
  const r = rig({ respond: () => ({ ok: true, json: async () => ({ html: "<p>x</p>" }) }) });
  await settle();
  assert.deepEqual(r.shown(), ["live"], "the lazy cell stays hidden on the server's default");
  assert.equal(r.calls.length, 0, "nothing to pay for");
  assert.equal(r.cellOf("lazy").getAttribute("data-wg-lazy"), "1", "still lazy");
});

test("the client draws the grid's nothing line for an empty answer, as text", async () => {
  const r = rig({ layout: shownLazy, respond: () => ({ ok: true, json: async () => ({ id: "lazy", html: "" }) }) });
  await settle();
  const body = r.cellOf("lazy").querySelector(".wg-cell-body");
  assert.equal(body.children.length, 1, "one line");
  assert.equal(body.firstElementChild.className, "fy-note");
  assert.equal(body.textContent, t("widgets.grid.nothing", "en"));
  assert.equal(r.cellOf("lazy").hasAttribute("data-wg-lazy"), false);
});

test("the client shows the grid's error line when the fetch fails, and stays lazy for a later try", async () => {
  for (const respond of [
    () => ({ ok: false, json: async () => ({ error: "Not found" }) }),
    () => ({ ok: true, json: async () => { throw new Error("not json"); } }),
    () => { throw new Error("offline"); },
  ]) {
    const r = rig({ layout: shownLazy, respond });
    await settle();
    const cell = r.cellOf("lazy");
    assert.equal(cell.querySelector(".wg-cell-body").textContent, t("widgets.grid.error", "en"));
    assert.equal(cell.getAttribute("data-wg-lazy"), "1", "marked lazy again, so a later show tries once more");
    assert.equal(r.calls.length, 1, "one attempt per show, never a loop");
  }
});

test("the client does not start a second fetch for a cell already being fetched", async () => {
  // Boot fetches the shown lazy cell once; a second show (the picker's add) must not ask again while
  // that request is in flight — the cell is marked 'loading', not '1', until it settles.
  let release;
  const gate = new Promise((r) => { release = r; });
  const r = rig({
    layout: shownLazy,
    respond: () => gate.then(() => ({ ok: true, json: async () => ({ html: "<p>late</p>" }) })),
  });
  assert.equal(r.calls.length, 1, "one fetch at boot");
  assert.equal(r.cellOf("lazy").getAttribute("data-wg-lazy"), "loading", "mid-fetch");
  // Open the picker and add the same cell again: the client shows it and asks to fill it.
  r.document.querySelector("[data-wg-edit]").dispatchEvent(new r.window.Event("click", { bubbles: true }));
  r.document.querySelector("[data-wg-add]").dispatchEvent(new r.window.Event("click", { bubbles: true }));
  const again = r.document.querySelector(`[data-wg-picker] [data-wg-add="lazy"]`);
  assert.ok(again, "the picker knows the cell");
  again.dispatchEvent(new r.window.Event("click", { bubbles: true }));
  await settle();
  assert.equal(r.calls.length, 1, "still one fetch for the one cell");
  release();
  await settle();
  assert.equal(r.cellOf("lazy").hasAttribute("data-wg-lazy"), false);
});

// ─── the page, in a real browser ────────────────────────────────────────────

let chrome;

test("live: a saved layout with a lazy widget loads it on show, and '+ Add widget' fills one too", async (ctx) => {
  await withFlag(async () => {
    chrome = await startHeadlessChrome();
    if (!chrome) return ctx.skip("no headless Chrome (CROW_REQUIRE_TEST_CHROME=1 makes this a failure)");
    const tab = await (await fetch(chrome.cdp + "/json/new?about:blank", { method: "PUT" })).json();
    const { default: WebSocket } = await import("ws");
    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
    let id = 0;
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const mine = ++id;
      const on = (raw) => {
        const m = JSON.parse(raw);
        if (m.id !== mine) return;
        ws.off("message", on);
        m.error ? reject(new Error(method + ": " + JSON.stringify(m.error))) : resolve(m.result || {});
      };
      ws.on("message", on);
      ws.send(JSON.stringify({ id: mine, method, params }));
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
    });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (expression, what, ms = 15000) => {
      const end = Date.now() + ms;
      for (;;) {
        let v = null;
        try { v = await ev(expression); } catch { /* mid-navigation */ }
        if (v) return v;
        if (Date.now() > end) throw new Error("timed out waiting for " + what + (errors.length ? "; page errors: " + errors.slice(-5).join(" | ") : ""));
        await sleep(60);
      }
    };
    const READY = "!!document.querySelector('[data-wg-page=\"widgets\"][data-wg-ready=\"1\"]')";
    const TWO_FRAMES = "new Promise(function(r){requestAnimationFrame(function(){requestAnimationFrame(function(){r(1);});});})";
    const LAYOUT_KEY = "crow.widgets.layout.widgets";
    try {
      await send("Page.enable");
      await send("Runtime.enable");
      await send("Network.enable");
      await send("Network.clearBrowserCookies");
      await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
      for (const ck of [{ name: "crow_session", value: "owner-sess" }, { name: "crow_csrf", value: "tok" }, { name: MODE, value: "new" }]) {
        await send("Network.setCookie", { ...ck, url: base, path: "/" });
      }
      process.env.CROW_FOR_YOU = "1";
      await send("Network.setExtraHTTPHeaders", { headers: NET });
      // Record what a lazy cell looked like at the moment its body was asked for. The wrapper is
      // installed for every document from here on, so the reload below is covered too.
      await send("Page.addScriptToEvaluateOnNewDocument", {
        source: "(function(){ var real = window.fetch; window.__lazySeen = [];"
          + " window.fetch = function(url, opts) {"
          + "  var u = String(url); var m = /[?&]id=([^&]*)/.exec(u);"
          + "  if (u.indexOf('/dashboard/widgets-api/cell') >= 0 && m) {"
          + "   var c = document.querySelector('[data-widget=\"' + decodeURIComponent(m[1]) + '\"]');"
          + "   window.__lazySeen.push({ id: decodeURIComponent(m[1]), lazy: c ? c.getAttribute('data-wg-lazy') : null,"
          + "    body: c && c.querySelector('.wg-cell-body') ? (c.querySelector('.wg-cell-body').textContent || '').trim() : null });"
          + "  }"
          + "  return real.apply(window, arguments); }; })();",
      });

      // 1. A device that has this widget on its own layout: it shows, so it loads.
      await send("Page.navigate", { url: base + "/dashboard/widgets" });
      await until(READY, "the widget grid");
      await ev(`(function(){ try { localStorage.setItem(${JSON.stringify(LAYOUT_KEY)}, ${JSON.stringify(JSON.stringify({ v: 1, cells: [
        { id: "needs-me", w: 2, h: 2 }, { id: "today", w: 2, h: 2 }, { id: PROBE_GOOD, w: 2, h: 1 },
      ] }))}); } catch (e) {} return 1; })()`);
      await send("Page.reload");
      await until(READY, "the grid with the device's layout");
      await until(`document.querySelector('[data-widget="${PROBE_GOOD}"]').getAttribute('data-wg-lazy') === null`, "the fetched cell");
      assert.match(await ev(`document.querySelector('[data-widget="${PROBE_GOOD}"] .wg-cell-body').textContent`), /Probe body/);
      const seen = await ev("window.__lazySeen || []");
      assert.deepEqual(seen.map((s) => s.id), [PROBE_GOOD], "exactly the shown lazy cell was fetched, once");
      assert.equal(seen[0].lazy, "loading", "it was marked mid-fetch, never fetched twice");
      assert.equal(seen[0].body, t("widgets.grid.loading", "en"), "and it showed the loading line until the body came");
      assert.deepEqual(errors, [], "no page errors");

      // 2. A device with no layout of its own: "+ Add widget" puts the same lazy cell up.
      await ev(`(function(){ try { localStorage.removeItem(${JSON.stringify(LAYOUT_KEY)}); } catch (e) {} return 1; })()`);
      await send("Page.reload");
      await until(READY, "the grid without a layout");
      await ev(TWO_FRAMES);
      assert.equal(await ev(`document.querySelector('[data-widget="${PROBE_GOOD}"]').hasAttribute('hidden')`), true, "offered, not shown");
      await ev("document.querySelector('[data-wg-edit]').click()");
      await until("!document.querySelector('[data-wg-add]').hasAttribute('hidden')", "the Add widget button");
      await ev("document.querySelector('[data-wg-add]').click()");
      await until("!!document.querySelector('[data-wg-picker][open]')", "the picker");
      assert.equal(await ev(`document.querySelector('[data-wg-picker] [data-wg-add="${PROBE_GOOD}"]').hasAttribute('hidden')`), false, "the lazy widget is offered");
      await ev(`document.querySelector('[data-wg-picker] [data-wg-add="${PROBE_GOOD}"]').click()`);
      await until(`document.querySelector('[data-widget="${PROBE_GOOD}"]').getAttribute('data-wg-lazy') === null`, "the added cell's body");
      assert.equal(await ev(`document.querySelector('[data-widget="${PROBE_GOOD}"]').hasAttribute('hidden')`), false, "shown on the page");
      assert.match(await ev(`document.querySelector('[data-widget="${PROBE_GOOD}"] .wg-cell-body').textContent`), /Probe body/);
      const scroll = await ev("(function(){ var g=document.querySelector('[data-wg-page]'); return { sw: document.scrollingElement.scrollWidth, vw: window.innerWidth, gridSw: g.scrollWidth, gridCw: g.clientWidth }; })()");
      assert.ok(scroll.sw <= scroll.vw, `no page scroll sideways (${scroll.sw} ≤ ${scroll.vw})`);
      assert.ok(scroll.gridSw <= scroll.gridCw, `the grid does not scroll sideways (${scroll.gridSw} ≤ ${scroll.gridCw})`);
      assert.deepEqual(errors, [], "no page errors");
    } finally {
      delete process.env.CROW_FOR_YOU;
      ws.close();
      await fetch(chrome.cdp + "/json/close/" + tab.id).catch(() => {});
      await chrome.close();
      chrome = null;
    }
  });
});