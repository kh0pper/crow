/**
 * Widgets phase 2, Task 3: the generic widget page (/dashboard/widgets) and its "Today + Ramble"
 * card (for-you/today.js, panels/for-you/html.js todayHtml), driven through the REAL dashboard
 * router over a scratch CROW_DATA_DIR and CROW_HOME:
 *   - CROW_FOR_YOU off: /dashboard/widgets is a 404 for the owner too; on: the owner's own local
 *     password session gets it, a plain-scope or SSO session gets 404, and the page has no POST;
 *   - its default screenful is What needs me and Today + Ramble, at 2×2, with every other widget
 *     offered by "+ Add widget": those are drawn as hidden LAZY cells (one loading line each) and
 *     are not loaded with the page — the device fetches a cell from /dashboard/widgets-api/cell when
 *     it shows it (widgets/grid-client.js);
 *   - the layout key is the grid client's own (crow.widgets.layout.widgets) and the page carries
 *     the grid client, untouched from PR 1;
 *   - Today + Ramble's lines are each optional: no Workspace (or a CalDAV that throws) leaves the
 *     calendar line out; no Ramble leaves the steps and mood lines out; with none of them there is
 *     no card at all. Every value — an event's summary — is escaped;
 *   - one live-Chrome check at 390×844: two grid columns and no sideways scroll.
 *
 * Nothing here reaches the network: the calendar and the Ramble state are test seams
 * (for-you/today.js _setTodaySeamsForTest), exactly as For You's moves and weather are.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { parseHTML } from "linkedom";
import { startHeadlessChrome } from "./fixtures/headless-chrome.mjs";
import { actAsServe, serveHeaders } from "./fixtures/serve-peer.mjs";
import { loadToday, _setTodaySeamsForTest, CALENDAR_TIMEOUT_MS } from "../servers/gateway/for-you/today.js";
import { todayHtml } from "../servers/gateway/dashboard/panels/for-you/html.js";
import { gridClientJs } from "../servers/gateway/widgets/grid-client.js";
import { forYouClientJs } from "../servers/gateway/dashboard/panels/for-you/client.js";
actAsServe(); // this process's HTTP client stands in for tailscaled (the Serve socket owner)

const dir = mkdtempSync(join(tmpdir(), "widgets-page-"));
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
writeFileSync(join(dir, "instance-id"), "instance-widgets-page");
writeFileSync(join(HOME, "installed.json"), "[]"); // neither Ramble nor Workspace is installed
const REPO = new URL("..", import.meta.url).pathname;
const NOW = Date.parse("2026-11-03T15:00:00Z");

let server, base, MODE, panelMod;

const CALENDAR = { summary: "Dentist", start: "2026-11-03T18:30:00Z", all_day: false };
const RAMBLE = { mood: "tired", energy: 24, max: 60, steps: { today: 3200, goal: 6000 } };

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
  _setTodaySeamsForTest({});
  panelMod?._setForYouSeamsForTest({});
  server?.closeAllConnections?.();
  server?.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  // The calendar and the bird's state, without Workspace or Ramble installed.
  _setTodaySeamsForTest({ calendar: async () => CALENDAR, ramble: async () => RAMBLE });
  // No weather service is reached: no city, so no weather widget.
  panelMod._setForYouSeamsForTest({ weather: async () => null });
});

const NET = serveHeaders("operator@example.com");
const jar = (sess) => `crow_session=${sess}; crow_csrf=tok; ${MODE}=new`;
async function get(path, sess = "owner-sess") {
  const r = await fetch(base + path, { redirect: "manual", headers: { ...NET, cookie: jar(sess) } });
  return { status: r.status, location: r.headers.get("location"), body: await r.text() };
}
async function post(path, sess = "owner-sess") {
  const r = await fetch(base + path, {
    method: "POST", redirect: "manual",
    headers: { ...NET, cookie: jar(sess), "content-type": "application/x-www-form-urlencoded" }, body: "_csrf=tok",
  });
  return { status: r.status, body: await r.text() };
}
async function withFlag(fn) {
  process.env.CROW_FOR_YOU = "1";
  try { return await fn(); } finally { delete process.env.CROW_FOR_YOU; }
}

/** The grid's cells, in the order the server drew them, with the size, visibility and body it gave each. */
function cells(body) {
  const { document } = parseHTML(`<!doctype html><html><body>${body}</body></html>`);
  return [...document.querySelectorAll('.wg-grid[data-wg-page="widgets"] [data-widget]')].map((el) => ({
    id: el.getAttribute("data-widget"),
    hidden: el.hasAttribute("hidden"),
    lazy: el.getAttribute("data-wg-lazy"),
    w: Number(el.getAttribute("data-w")),
    h: Number(el.getAttribute("data-h")),
    sizes: JSON.parse(el.getAttribute("data-sizes") || "[]"),
    text: String(el.textContent || "").replace(/\s+/g, " ").trim(),
    body: String((el.querySelector(".wg-cell-body") || {}).textContent || "").replace(/\s+/g, " ").trim(),
  }));
}

// ─── the gates ───────────────────────────────────────────────────────────────

test("flag off: /dashboard/widgets is a 404 for the owner too, and draws no grid", async () => {
  assert.equal(process.env.CROW_FOR_YOU, undefined);
  const r = await get("/dashboard/widgets");
  assert.equal(r.status, 404);
  assert.doesNotMatch(r.body, /wg-grid|data-widget=/);
});

test("flag on: the owner's own local password session gets it; a plain or an SSO session gets 404; there is no POST", async () => {
  await withFlag(async () => {
    const own = await get("/dashboard/widgets");
    assert.equal(own.status, 200);
    assert.match(own.body, /<body class="shell/);
    assert.match(own.body, /<h1 class="fy-title">Widgets<\/h1>/);
    assert.match(own.body, /<div class="wg-grid" data-wg-page="widgets"/);
    for (const sess of ["plain-sess", "sso-sess"]) {
      const r = await get("/dashboard/widgets", sess);
      assert.equal(r.status, 404, sess);
      assert.doesNotMatch(r.body, /wg-grid/, sess);
    }
    // The page has no form: any state-changing method is a 404, never a silent no-op.
    assert.equal((await post("/dashboard/widgets")).status, 404);
  });
});

test("its default screenful is What needs me and Today + Ramble at 2×2; the rest are lazy cells", async () => {
  await withFlag(async () => {
    const r = await get("/dashboard/widgets");
    assert.equal(r.status, 200);
    const drawn = cells(r.body);
    assert.deepEqual(drawn.filter((c) => !c.hidden).map((c) => c.id), ["needs-me", "today"], "the page's default layout");
    const today = drawn.find((c) => c.id === "today");
    assert.deepEqual([today.w, today.h], [2, 2], "Today + Ramble's default size");
    assert.deepEqual(today.sizes, [[2, 1], [2, 2], [4, 1]], "and the only sizes it may step through");
    const needs = drawn.find((c) => c.id === "needs-me");
    assert.deepEqual([needs.w, needs.h], [2, 2]);
    assert.equal(needs.lazy, null, "a default-layout widget is loaded with the page");
    assert.equal(today.lazy, null);
    assert.equal(needs.text.includes("What needs me"), true);
    // Every registered widget is offered on the page, in registry order. The ones the default layout
    // does not hold are drawn hidden as LAZY cells: one loading line each, never loaded with the page,
    // and listed by the picker so "+ Add widget" can put them up (widgets/grid-client.js fills it).
    assert.deepEqual(drawn.map((c) => c.id), [
      "needs-me", "morning", "moves", "listen", "news", "today", "weather",
      "messages", "apps", "projects", "bots",
    ], "the cells the page draws");
    for (const id of ["morning", "moves", "listen", "news", "weather", "messages", "apps", "projects", "bots"]) {
      const lazy = drawn.find((c) => c.id === id);
      assert.equal(lazy.hidden, true, `${id} is offered, not part of the default`);
      assert.equal(lazy.lazy, "1", `${id} is a lazy cell`);
      assert.equal(lazy.body, "Loading…", `${id} draws the loading line, and nothing else`);
      assert.match(r.body, new RegExp(`data-wg-add="${id}"`), `${id} is offered by the picker`);
    }
  });
});

test("the page runs the grid client PR 1 built, with the widgets page's own layout key", async () => {
  await withFlag(async () => {
    const r = await get("/dashboard/widgets");
    assert.equal(r.body.split('class="wg-grid"').length - 1, 1, "one grid");
    assert.equal(r.body.split('<template data-wg-picker-tpl>').length - 1, 1, "one picker template");
    assert.ok(r.body.includes("crow.widgets.layout."), "the client names the layout key");
    assert.ok(r.body.includes(gridClientJs().trim().slice(0, 40)), "and it is the grid client, unchanged");
    assert.ok(r.body.includes(forYouClientJs().trim().slice(0, 40)), "the widgets' own client ships too (a sheet, a Done, an answer)");
    // The grid's own markup renders every value (the layout around it carries "undefined" in its CSS
    // comments, so only the grid is checked).
    const { document } = parseHTML(`<!doctype html><html><body>${r.body}</body></html>`);
    const grid = document.querySelector('.wg-grid[data-wg-page="widgets"]');
    assert.ok(grid, "the grid is in the page");
    assert.doesNotMatch(grid.outerHTML, /undefined|NaN|\[object Object\]/, "no value failed to render");
  });
});

// ─── Today + Ramble ─────────────────────────────────────────────────────────

test("Today + Ramble draws the calendar, the bird's steps and its mood, and opens Ramble", async () => {
  await withFlag(async () => {
    const today = cells((await get("/dashboard/widgets")).body).find((c) => c.id === "today");
    assert.ok(today, "the card is on the page");
    assert.match(today.text, /Today \+ Ramble/);
    assert.match(today.text, /Next up/);
    assert.match(today.text, /Dentist/);
    assert.match(today.text, /Steps today/);
    assert.match(today.text, /3200 of 6000 steps/);
    assert.match(today.text, /Mood/);
    assert.match(today.text, /Tired/);
    assert.match(today.text, /Open Ramble/);
    const { document } = parseHTML(`<!doctype html><html><body>${(await get("/dashboard/widgets")).body}</body></html>`);
    const card = document.querySelector('[data-widget="today"] [data-fy-today-card]');
    assert.equal(card.getAttribute("href"), "/dashboard/ramble", "a tap opens Ramble");
  });
});

test("the calendar line is left out when Workspace is not installed, and when its CalDAV throws", async () => {
  await withFlag(async () => {
    // No Workspace on this instance: no calendar seam at all, the bird's state still there.
    _setTodaySeamsForTest({ ramble: async () => RAMBLE });
    const noWorkspace = cells((await get("/dashboard/widgets")).body).find((c) => c.id === "today");
    assert.ok(noWorkspace, "the card still draws");
    assert.doesNotMatch(noWorkspace.text, /Next up/, "no calendar line");
    assert.doesNotMatch(noWorkspace.text, /Dentist/);
    assert.match(noWorkspace.text, /3200 of 6000 steps/, "the Ramble lines are untouched");

    // Workspace installed but the read throws: the line is omitted, never an error on the page.
    _setTodaySeamsForTest({ calendar: async () => { throw new Error("dav is down"); }, ramble: async () => RAMBLE });
    const r = await get("/dashboard/widgets");
    assert.equal(r.status, 200);
    const thrown = cells(r.body).find((c) => c.id === "today");
    assert.doesNotMatch(thrown.text, /Next up/);
    assert.doesNotMatch(r.body, /dav is down/, "the failure is not printed onto the page");
  });
});

test("without Ramble the steps and mood lines are omitted, and the card still draws the calendar", async () => {
  await withFlag(async () => {
    // No Ramble installed and no seam: only the calendar is left.
    _setTodaySeamsForTest({ calendar: async () => CALENDAR });
    const today = cells((await get("/dashboard/widgets")).body).find((c) => c.id === "today");
    assert.ok(today, "the card draws on the calendar line alone");
    assert.match(today.text, /Dentist/);
    assert.doesNotMatch(today.text, /Steps today/);
    assert.doesNotMatch(today.text, /Mood/);
  });
});

test("with no line at all there is no card: the cell is not drawn, and the page is untouched", async () => {
  await withFlag(async () => {
    _setTodaySeamsForTest({});
    const r = await get("/dashboard/widgets");
    assert.equal(r.status, 200);
    const drawn = cells(r.body);
    assert.ok(!drawn.some((c) => c.id === "today"), "no Today + Ramble cell");
    assert.deepEqual(drawn.filter((c) => !c.hidden).map((c) => c.id), ["needs-me"], "What needs me is still the default");
  });
});

test("loadToday: each line is its own read, a throw costs only that line, and the seams are the bundle reads", async () => {
  const ctx = { crowHome: HOME, now: NOW, tz: "UTC", lang: "en" };
  // No seams at all, nothing installed: an empty card (never a broken one).
  _setTodaySeamsForTest({});
  assert.deepEqual(await loadToday(null, ctx), { calendar: null, move: null, ramble: null });

  // The calendar alone, its "when" formatted in the instance's zone.
  _setTodaySeamsForTest({ calendar: async () => CALENDAR });
  assert.deepEqual(await loadToday(null, ctx), { calendar: { summary: "Dentist", when: "6:30 PM" }, move: null, ramble: null });

  // A calendar that throws is no calendar; the Ramble seam still answers.
  _setTodaySeamsForTest({ calendar: async () => { throw new Error("nope"); }, ramble: async () => RAMBLE });
  assert.deepEqual(await loadToday(null, ctx), { calendar: null, move: null, ramble: RAMBLE });

  // A hanging Workspace read is cut off, and the line is left out.
  _setTodaySeamsForTest({ calendar: () => new Promise(() => {}), ramble: async () => RAMBLE });
  const started = Date.now();
  const out = await loadToday(null, ctx);
  assert.equal(out.calendar, null, "a hanging calendar is left out");
  assert.deepEqual(out.ramble, RAMBLE);
  assert.ok(Date.now() - started >= CALENDAR_TIMEOUT_MS - 50, "it really waited for the budget, not a fixed delay");
  assert.ok(Date.now() - started < CALENDAR_TIMEOUT_MS * 4, "and no longer");
  _setTodaySeamsForTest({});
});

test("an event's summary from someone's calendar is escaped, never markup", async () => {
  const html = todayHtml({
    calendar: { summary: 'Dentist <b>"real"</b>', when: "6:30 PM" },
    ramble: { mood: "happy", steps: { today: 1, goal: 2 } },
  }, "es", NOW);
  assert.match(html, /Dentist &lt;b&gt;&quot;real&quot;&lt;\/b&gt;/);
  assert.ok(!html.includes("<b>"));
  // Spanish, from the same keys the page uses.
  assert.match(html, /Lo próximo/);
  assert.match(html, /Pasos de hoy/);
  assert.match(html, /1 de 2 pasos/);
  assert.match(html, /Contento/);
  assert.match(html, /Abrir Ramble/);
  assert.equal(todayHtml(null, "en", NOW), "");
  assert.equal(todayHtml({}, "en", NOW), "", "nothing to show: no card");
});

test("eventWhen: today's clock time, another day's weekday, an all-day event, and a start it cannot read", async () => {
  const { eventWhen } = await import("../servers/gateway/for-you/today.js");
  const now = Date.parse("2026-11-03T15:00:00Z");
  assert.equal(eventWhen({ start: "2026-11-03T18:30:00Z" }, "en", "UTC", now), "6:30 PM");
  assert.equal(eventWhen({ start: "2026-11-06T18:30:00Z" }, "en", "UTC", now), "Friday 6:30 PM");
  assert.equal(eventWhen({ start: "2026-11-06", all_day: true }, "en", "UTC", now), "All day");
  assert.match(eventWhen({ start: "2026-11-03T18:30:00Z" }, "es", "UTC", now), /^18:30$/, "Spanish uses the 24-hour clock");
  assert.equal(eventWhen({ start: "not a date" }, "en", "UTC", now), "");
});

// ─── the page, in a real browser ────────────────────────────────────────────

let chrome;

test("390×844: the widgets page is two columns wide and does not scroll sideways", async (ctx) => {
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
    try {
      await send("Page.enable");
      await send("Runtime.enable");
      await send("Network.enable");
      await send("Network.clearBrowserCookies");
      await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
      for (const ck of [{ name: "crow_session", value: "owner-sess" }, { name: "crow_csrf", value: "tok" }, { name: MODE, value: "new" }]) {
        await send("Network.setCookie", { ...ck, url: base, path: "/" });
      }
      // The page exists only with For You on (cleared in `after`), and a browser carries no Serve
      // headers of its own: the browser's requests get them as the fetch helpers' do.
      process.env.CROW_FOR_YOU = "1";
      await send("Network.setExtraHTTPHeaders", { headers: NET });
      await send("Page.navigate", { url: base + "/dashboard/widgets" });
      await until("!!document.querySelector('[data-wg-page=\"widgets\"][data-wg-ready=\"1\"]')", "the widget grid");
      await ev("new Promise(function(r){requestAnimationFrame(function(){requestAnimationFrame(function(){r(1);});});})");
      assert.equal(await ev("document.querySelector('h1.fy-title').textContent"), "Widgets");
      assert.equal(await ev("getComputedStyle(document.querySelector('[data-wg-page=\"widgets\"]')).gridTemplateColumns.split(' ').length"), 2, "two columns on the phone");
      const scroll = await ev("(function(){ var g=document.querySelector('[data-wg-page=\"widgets\"]'); return { sw: document.scrollingElement.scrollWidth, vw: window.innerWidth, gridSw: g.scrollWidth, gridCw: g.clientWidth }; })()");
      assert.ok(scroll.sw <= scroll.vw, `no page scroll sideways (${scroll.sw} ≤ ${scroll.vw})`);
      assert.ok(scroll.gridSw <= scroll.gridCw, `the grid does not scroll sideways (${scroll.gridSw} ≤ ${scroll.gridCw})`);
      const shown = await ev("Array.prototype.map.call(document.querySelectorAll('[data-wg-page=\"widgets\"] [data-widget]'), function(el){ return el.hasAttribute('hidden') ? null : el.getAttribute('data-widget'); }).filter(Boolean)");
      assert.deepEqual(shown, ["needs-me", "today"], "the default screenful, as drawn");
      assert.deepEqual(errors, [], "no page errors");
    } finally {
      ws.close();
      await fetch(chrome.cdp + "/json/close/" + tab.id).catch(() => {});
      await chrome.close();
      chrome = null;
    }
  });
});
test("the Today card starts the move when it carries one, and plainly opens Ramble when it does not", () => {
  const withMove = todayHtml({ move: { title: "A ten minute walk", minutes: 10 } }, "en", NOW);
  assert.match(withMove, /href="\/dashboard\/ramble\?moves=start"/, "Ramble reads moves=start, so a tap lands on the move");
  const without = todayHtml({ calendar: { summary: "Dentist" } }, "en", NOW);
  assert.match(without, /href="\/dashboard\/ramble"/);
  assert.doesNotMatch(without, /moves=/);
});
