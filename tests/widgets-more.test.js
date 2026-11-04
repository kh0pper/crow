/**
 * Widgets phase 3, PR 2: the in-Crow widgets — Messages and the three launchers (apps, projects,
 * bots).
 *
 * The first half needs no browser:
 *   - the registry: four new ids, offered on both pages but on neither page's DEFAULT layout (the
 *     defaults are asserted against the same list the pages drew before this PR), with the sizes the
 *     plan names and a title in both languages;
 *   - Messages: the five latest conversations from the Messages panel's own reader, each with the
 *     deep link its kind has (?open= a peer, ?openRoom= a room, ?ai= an AI chat), an unread dot and
 *     a relative age; the empty list is "No conversations yet", and a missing database is an ERROR
 *     cell (the registry's), never an empty one;
 *   - the launchers: tile grids of at most twelve, a tile whose href is not same-site is DROPPED,
 *     names are escaped, apps/projects/bots read the real sources (disabled bots left out);
 *   - one live-Chrome check at 390×844: the Apps widget added through "+ Add widget" on
 *     /dashboard/widgets, drawn, with no sideways scroll.
 *
 * The camera widget that shipped beside these is now an ADD-ON widget: the installed Frigate bundle
 * provides it (bundles/frigate/widgets/cameras.js) and tests/widgets-addons.test.js covers it.
 *
 * Nothing here reaches the network: the Messages reader, the launcher, the project list and the bot
 * rows are taken as arguments (widgets/more.js).
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
import { WIDGETS, widgetOf, widgetsForPage, loadWidgets } from "../servers/gateway/widgets/registry.js";
import { gridHtml, defaultOnFor } from "../servers/gateway/widgets/grid-html.js";
import {
  loadMessages, loadApps, loadProjects, loadBots, launcherItems, messagesHref, sameSiteHref,
  MESSAGES_LIMIT, TILES_LIMIT,
} from "../servers/gateway/widgets/more.js";
import { messagesHtml, appsHtml, projectsHtml, botsHtml, widgetsMoreCss } from "../servers/gateway/widgets/more-html.js";
import { t } from "../servers/gateway/dashboard/shared/i18n.js";
import { _setTodaySeamsForTest } from "../servers/gateway/for-you/today.js";
actAsServe(); // this process's HTTP client stands in for tailscaled (the Serve socket owner)

const NEW_IDS = ["messages", "apps", "projects", "bots"];

const dir = mkdtempSync(join(tmpdir(), "widgets-more-"));
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
writeFileSync(join(dir, "instance-id"), "instance-widgets-more");
writeFileSync(join(HOME, "installed.json"), "[]"); // no bundle installed: no camera widget
const REPO = new URL("..", import.meta.url).pathname;
const NOW = Date.parse("2026-11-03T15:00:00Z");

/** A db that answers every query with no rows: the readers run for real over an empty store. */
const emptyDb = { execute: async () => ({ rows: [] }) };

// ─── the registry ────────────────────────────────────────────────────────────

test("the registry: the four in-Crow widgets, offered on both pages, on neither default layout", () => {
  for (const id of NEW_IDS) {
    const w = widgetOf(id);
    assert.ok(w, `${id} is registered`);
    assert.deepEqual(w.pages, ["for-you", "widgets"], `${id} is offered on both pages`);
    assert.equal(w.defaultOn, false, `${id} is not part of any page's default layout`);
    assert.equal(w.section, null, `${id} is always offered (no For You switch)`);
    assert.equal(typeof w.load, "function", `${id} loads`);
    assert.equal(typeof w.render, "function", `${id} renders`);
    assert.ok(Array.isArray(w.sizes) && w.sizes.length > 0, `${id} lists its sizes`);
    assert.ok(w.sizes.some((s) => s[0] === w.defaultSize[0] && s[1] === w.defaultSize[1]),
      `${id}: its default size ${JSON.stringify(w.defaultSize)} is one of ${JSON.stringify(w.sizes)}`);
    assert.match(w.titleKey, /^widgets\.more\./, `${id}'s title lives under widgets.more.*`);
    for (const lang of ["en", "es"]) {
      assert.notEqual(t(w.titleKey, lang), w.titleKey, `${id} has a ${lang} title`);
    }
  }
  assert.deepEqual(widgetOf("messages").sizes.map((s) => s.join("x")), ["2x2", "4x2"]);
  for (const id of ["apps", "projects", "bots"]) {
    assert.deepEqual(widgetOf(id).sizes.map((s) => s.join("x")), ["2x1", "2x2", "4x1", "4x2"], id);
  }
  // Every new widget is drawn hidden by both pages (the "+ Add widget" entry), whatever this host
  // has installed — an add-on's own offer gate is a separate, later filter.
  for (const id of NEW_IDS) {
    for (const page of ["for-you", "widgets"]) {
      assert.equal(defaultOnFor(widgetOf(id), page), false, `${id} is hidden on ${page}`);
    }
  }
});

test("both pages' default layouts are unchanged by this PR", () => {
  // What each page draws VISIBLE, from the registry alone: the same lists the pages drew before.
  const visible = (page) => WIDGETS.filter((w) => w.pages.includes(page) && defaultOnFor(w, page)).map((w) => w.id);
  assert.deepEqual(visible("for-you"), ["needs-me", "morning", "moves", "listen", "news"]);
  assert.deepEqual(visible("widgets"), ["needs-me", "today"]);
  // And the grid's own markup agrees: a new widget's cell carries `hidden`.
  const cells = NEW_IDS.map((id) => ({ widget: widgetOf(id), data: {} }));
  const html = gridHtml("widgets", cells, "en");
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  for (const id of NEW_IDS) {
    const cell = document.querySelector(`[data-widget="${id}"]`);
    assert.ok(cell, `${id} has a cell`);
    assert.equal(cell.hasAttribute("hidden"), true, `${id} is drawn hidden until this device adds it`);
  }
});

// ─── Messages ────────────────────────────────────────────────────────────────

const CONVERSATIONS = [
  { type: "peer", id: "12", displayName: "alex", lastActivity: "2026-11-03T14:40:00Z", unread: 2 },
  { type: "room", id: "room-7", groupId: 7, displayName: "Garden", lastActivity: "2026-11-03T13:00:00Z", unread: 0 },
  { type: "ai", id: "3", displayName: "Plans", lastActivity: "2026-11-03T11:00:00Z", unread: 0 },
  { type: "peer", id: "14", displayName: "second user", lastActivity: "2026-11-02T09:00:00Z", unread: 1 },
  { type: "ai", id: "4", displayName: "Ramble ideas", lastActivity: "2026-11-01T09:00:00Z", unread: 0 },
  { type: "peer", id: "15", displayName: "sixth", lastActivity: "2026-10-30T09:00:00Z", unread: 0 },
];

test("messages: the five latest, each with the deep link its kind has", async () => {
  const data = await loadMessages(emptyDb, { list: async () => ({ items: CONVERSATIONS, totalUnread: 3 }) });
  assert.equal(data.conversations.length, MESSAGES_LIMIT, "five conversations, never six");
  assert.equal(data.totalUnread, 3);
  assert.deepEqual(data.conversations.map((c) => c.href), [
    "/dashboard/messages?open=12",
    "/dashboard/messages?openRoom=7",
    "/dashboard/messages?ai=3",
    "/dashboard/messages?open=14",
    "/dashboard/messages?ai=4",
  ]);
  // The links the messages page really answers (panels/messages/client.js): peer/room/ai.
  assert.equal(messagesHref({ type: "peer", id: "9" }), "/dashboard/messages?open=9");
  assert.equal(messagesHref({ type: "room", id: "room-9", groupId: 9 }), "/dashboard/messages?openRoom=9");
  assert.equal(messagesHref({ type: "room", id: "room-9" }), "/dashboard/messages?openRoom=9", "the group id comes off the room id");
  assert.equal(messagesHref({ type: "ai", id: "9" }), "/dashboard/messages?ai=9");
  assert.equal(messagesHref({ type: "peer", id: "not-a-number" }), "/dashboard/messages", "a non-numeric id opens the list");

  const html = messagesHtml(data, "en", NOW);
  assert.match(html, /href="\/dashboard\/messages\?open=12"/);
  assert.match(html, /href="\/dashboard\/messages\?openRoom=7"/);
  assert.match(html, /href="\/dashboard\/messages\?ai=3"/);
  assert.match(html, /aria-label="2 unread"/, "the unread dot says how many");
  assert.match(html, /wg-conv-age">20m</, "and the row says how long ago it moved");
  assert.match(html, /href="\/dashboard\/messages"/, "the way into the full list");
  assert.match(html, /Messages/, "the title is translated, not a key");
  assert.doesNotMatch(html, /widgets\.more\.messages/, "no raw key reaches the page");
});

test("messages: an empty list says so; a missing database is an error cell, not an empty one", async () => {
  const empty = await loadMessages(emptyDb); // the real reader over a store with no rows
  assert.deepEqual(empty, { conversations: [], totalUnread: 0 });
  assert.match(messagesHtml(empty, "en", NOW), /No conversations yet/);
  assert.match(messagesHtml(empty, "es", NOW), /Aún no hay conversaciones/);

  await assert.rejects(() => loadMessages(null), /no database/, "a widget without its data is a failure");
  const cells = await loadWidgets([widgetOf("messages")], { db: null, lang: "en" }, { log: () => {} });
  assert.equal(cells[0].failed, true);
  const html = gridHtml("widgets", cells, "en");
  assert.match(html, /data-widget="messages"/, "the cell is still there");
  assert.match(html, /This widget couldn't load just now/);
  assert.doesNotMatch(html, /No conversations yet/, "an unreadable store is not an empty one");
});

test("messages: a conversation's name is escaped, never markup", async () => {
  const html = messagesHtml({
    conversations: [{ kind: "peer", id: "1", name: '<script>alert("x")</script>', unread: 1, at: null, href: "/dashboard/messages?open=1" }],
    totalUnread: 1,
  }, "en", NOW);
  assert.ok(!html.includes("<script>"), "a name cannot open a script tag");
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
});

// ─── the launchers ───────────────────────────────────────────────────────────

test("a launcher tile whose href is not same-site is dropped", async () => {
  // The shared rule first: one leading "/", never "//".
  assert.equal(sameSiteHref("/dashboard/media"), "/dashboard/media");
  assert.equal(sameSiteHref("https://example.invalid/x"), null);
  assert.equal(sameSiteHref("//example.invalid/x"), null);
  assert.equal(sameSiteHref("dashboard/media"), null);
  assert.equal(sameSiteHref(null), null);
  assert.deepEqual(launcherItems([
    { id: "a", label: "Off site", href: "https://example.invalid/a" },
    { id: "b", label: "Protocol relative", href: "//example.invalid/b" },
    { id: "c", label: "Relative", href: "dashboard/c" },
    { id: "d", label: "In Crow", href: "/dashboard/media" },
  ], (row) => row.href).map((row) => row.id), ["d"]);

  // The apps loader takes its hrefs from the catalog, so that is where a bad one could come from.
  const apps = await loadApps(emptyDb, {
    launcher: async () => ({
      apps: [
        { id: "evil", label: "Evil", href: "https://example.invalid/app" },
        { id: "media", label: "Media Hub", href: "/dashboard/media" },
      ],
      tiles: [
        { id: "net", label: "Net", href: "//example.invalid/tile" },
        { id: "board", label: "Board", href: "/dashboard/board" },
      ],
    }),
  });
  assert.deepEqual(apps.items.map((i) => i.id), ["media", "board"]);
  const html = appsHtml(apps, "en");
  assert.doesNotMatch(html, /example\.invalid/, "nothing off-site is rendered");
  assert.match(html, /href="\/dashboard\/media"/);
  assert.match(html, /href="\/dashboard\/board"/);

  // The renderer is the last line: a hand-made item with an off-site href is not drawn either.
  const forced = appsHtml({ items: [{ id: "x", label: "Off site", href: "https://example.invalid/x" }] }, "en");
  assert.doesNotMatch(forced, /example\.invalid/);
  assert.match(forced, /No apps yet/, "with nothing safe to draw, the empty line");
});

test("the launchers read the real sources: apps, active projects, enabled bots", async () => {
  const apps = await loadApps(emptyDb, {
    crowHome: HOME,
    launcher: async (db, scope) => {
      assert.deepEqual(scope, { all: true }, "the apps widget shows every app, not a project's");
      return { apps: [{ id: "media", label: "Media Hub", href: "/dashboard/media" }], tiles: [{ id: "board", label: "Board", href: "/dashboard/board" }] };
    },
  });
  assert.deepEqual(apps.items.map((i) => i.label), ["Media Hub", "Board"]);
  assert.match(appsHtml(apps, "en"), /href="\/dashboard\/extensions"/, "\"See all\" is the app catalog");

  const projects = await loadProjects(emptyDb, {
    projects: async () => ([
      { id: 1, slug: "garden", name: "<b>Garden</b>" },
      { id: 2, slug: "a b/c", name: "Second" },
      { id: 3, slug: "", name: "No slug, no home" },
    ]),
  });
  assert.deepEqual(projects.items.map((i) => i.href), ["/dashboard/project/garden", "/dashboard/project/a%20b%2Fc"]);
  const projectsMarkup = projectsHtml(projects, "en");
  assert.match(projectsMarkup, /href="\/dashboard\/project\/garden"/);
  assert.match(projectsMarkup, /&lt;b&gt;Garden&lt;\/b&gt;/, "a project's name is escaped");
  assert.ok(!projectsMarkup.includes("<b>Garden</b>"));
  assert.match(projectsMarkup, /href="\/dashboard\/projects"/, "\"See all\" is the Projects page");

  const bots = await loadBots(emptyDb, {
    rows: async () => ([
      { bot_id: "scout", display_name: "Scout", enabled: 1 },
      { bot_id: "paused one", display_name: "", enabled: 0 },
      { bot_id: "a b", display_name: "Spaced <i>bot</i>", enabled: 1 },
    ]),
  });
  assert.deepEqual(bots.items.map((i) => i.href), ["/dashboard/bot-builder?bot=scout", "/dashboard/bot-builder?bot=a%20b"], "enabled bots only, ids encoded");
  const botsHtmlOut = botsHtml(bots, "en");
  assert.match(botsHtmlOut, /Spaced &lt;i&gt;bot&lt;\/i&gt;/, "a bot's name is escaped");
  assert.match(botsHtmlOut, /href="\/dashboard\/bot-builder"/, "\"See all\" is Bot Builder");

  // Twelve tiles at most, whatever the store holds.
  const many = await loadProjects(emptyDb, {
    projects: async () => Array.from({ length: TILES_LIMIT + 5 }, (_, i) => ({ id: i, slug: "p" + i, name: "P" + i })),
  });
  assert.equal(many.items.length, TILES_LIMIT);
  assert.equal(many.total, TILES_LIMIT + 5);
});

test("the launchers' empty states say so, in both languages", async () => {
  const apps = await loadApps(emptyDb, { launcher: async () => ({ apps: [], tiles: [] }) });
  assert.deepEqual(apps, { items: [], total: 0 });
  assert.match(appsHtml(apps, "en"), /No apps yet/);
  assert.match(appsHtml(apps, "es"), /Aún no hay aplicaciones/);
  assert.match(appsHtml(apps, "es"), /Ver todo/, "\"See all\" is translated");
  assert.match(projectsHtml(await loadProjects(emptyDb, { projects: async () => [] }), "en"), /No projects yet/);
  assert.match(botsHtml(await loadBots(emptyDb, { rows: async () => [] }), "en"), /No bots yet/);
  assert.match(botsHtml({ items: [] }, "es"), /Aún no hay bots/);
});

test("each in-Crow loader's failure is its own cell, and the rest of the grid still draws", async () => {
  const ok = { id: "fine", titleKey: "forYou.morning", sizes: [[2, 1]], defaultSize: [2, 1], load: async () => ({}), render: () => "<p id=\"fine-body\">fine</p>" };
  const cells = await loadWidgets(
    [ok, widgetOf("messages"), widgetOf("apps"), widgetOf("projects"), widgetOf("bots")],
    { db: null, crowHome: HOME, lang: "en" },
    { log: () => {} },
  );
  assert.deepEqual(cells.map((c) => (c.failed ? "failed" : "ok")), ["ok", "failed", "failed", "failed", "failed"]);
  const html = gridHtml("widgets", cells, "en");
  assert.match(html, /id="fine-body"/, "the healthy widget is untouched");
  for (const id of NEW_IDS) {
    assert.match(html, new RegExp(`data-widget="${id}"`), `${id} keeps its cell`);
  }
  assert.equal(html.split("This widget couldn't load just now").length - 1, 4, "one error line per failed cell");
});

// ─── the widgets' styles ────────────────────────────────────────────────────

test("the widgets' styles: 44 px targets, a still that fits its box, one style tag", () => {
  const css = widgetsMoreCss();
  assert.match(css, /\.wg-conv \{[^}]*min-height: 44px/, "a conversation row is a 44 px target");
  assert.match(css, /\.wg-tile \{[^}]*min-height: 44px/, "a launcher tile too");
  assert.match(css, /\.wg-cam-img \{[^}]*width: 100%/, "a still never widens the cell");
  assert.match(css, /\.wg-tile-label \{[^}]*overflow-wrap: anywhere/, "a long name wraps inside its cell");
  assert.equal(css.split("</style").length - 1, 1, "one closing style tag, at the end");
  assert.ok(!css.slice(0, css.lastIndexOf("</style")).includes("</style"), "no literal closing style tag inside the string");
});

// ─── the real pages, through the dashboard router ────────────────────────────

let server, base, MODE;

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env }, stdio: "pipe", cwd: REPO });
  const { hashToken } = await import("../servers/gateway/dashboard/auth.js");
  const c = new Database(DB_FILE);
  c.prepare("INSERT INTO project_spaces (slug, name, type, status) VALUES ('garden','Garden','general','active')").run();
  const tok = c.prepare("INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at, created_at) VALUES (?, 'access', 'dashboard', ?, datetime('now','+1 day'), '2026-06-01 00:00:00')");
  tok.run(hashToken("owner-sess"), "dashboard");
  c.close();

  const { createDbClient } = await import("../servers/db.js");
  const { writeSetting } = await import("../servers/gateway/dashboard/settings/registry.js");
  const db = createDbClient();
  try { await writeSetting(db, "shell_since", "2026-01-01 00:00:00"); } finally { db.close(); }

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
  server?.closeAllConnections?.();
  server?.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  writeFileSync(join(HOME, "installed.json"), "[]");
});

const NET = serveHeaders("operator@example.com");
const jar = () => `crow_session=owner-sess; crow_csrf=tok; ${MODE}=new`;
async function get(path, sess = "owner-sess") {
  const r = await fetch(base + path, { redirect: "manual", headers: { ...NET, cookie: sess === "owner-sess" ? jar() : `crow_session=${sess}; crow_csrf=tok; ${MODE}=new` } });
  return { status: r.status, body: await r.text() };
}
async function withFlag(fn) {
  process.env.CROW_FOR_YOU = "1";
  try { return await fn(); } finally { delete process.env.CROW_FOR_YOU; }
}

// ─── the page, in a real browser ────────────────────────────────────────────

let chrome;

test("390×844: the Apps widget is added through '+ Add widget' and draws, with no sideways scroll", async (ctx) => {
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
    const ORDER = "Array.prototype.map.call(document.querySelectorAll('[data-wg-page] [data-widget]'),"
      + " function(el){ return el.hasAttribute('hidden') ? null : el.getAttribute('data-widget'); })"
      + ".filter(function(id){ return id; })";
    const NO_H_SCROLL = "(function(){ var g=document.querySelector('[data-wg-page]'); return {"
      + " sw: document.scrollingElement.scrollWidth, vw: window.innerWidth,"
      + " gridSw: g.scrollWidth, gridCw: g.clientWidth }; })()";
    try {
      await send("Page.enable");
      await send("Runtime.enable");
      await send("Network.enable");
      await send("Network.clearBrowserCookies");
      await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
      for (const ck of [{ name: "crow_session", value: "owner-sess" }, { name: "crow_csrf", value: "tok" }, { name: MODE, value: "new" }]) {
        await send("Network.setCookie", { ...ck, url: base, path: "/" });
      }
      // A browser carries no Serve headers of its own: its requests get them as the fetch helpers' do.
      await send("Network.setExtraHTTPHeaders", { headers: NET });
      // Today draws only with something to say: a fixture Ramble state stands in for the bundle.
      _setTodaySeamsForTest({ ramble: async () => ({ mood: "tired", energy: 24, max: 60, steps: { today: 3200, goal: 6000 } }) });
      await send("Page.navigate", { url: base + "/dashboard/widgets" });
      await until("!!document.querySelector('[data-wg-page=\"widgets\"][data-wg-ready=\"1\"]')", "the widget grid");
      await ev("new Promise(function(r){requestAnimationFrame(function(){requestAnimationFrame(function(){r(1);});});})");

      assert.deepEqual(await ev(ORDER), ["needs-me", "today"], "the default screenful before the add");
      assert.equal(await ev("document.querySelector('[data-wg-add=\"apps\"]') ? 1 : 0"), 0, "the picker is still a template");
      // Edit → "+ Add widget" → the Apps entry → Done. element.click() is the phone tap the grid hears.
      await ev("document.querySelector('[data-wg-edit]').click()");
      await until("!document.querySelector('[data-wg-add]').hasAttribute('hidden')", "the Add widget button");
      await ev("document.querySelector('[data-wg-add]').click()");
      await until("!!document.querySelector('[data-wg-picker][open]')", "the picker");
      assert.equal(await ev("document.querySelector('[data-wg-picker] [data-wg-add=\"apps\"]').hasAttribute('hidden')"), false, "Apps is offered");
      await ev("document.querySelector('[data-wg-picker] [data-wg-add=\"apps\"]').click()");
      await ev("document.querySelector('[data-wg-done]').click()");
      await ev("new Promise(function(r){requestAnimationFrame(function(){requestAnimationFrame(function(){r(1);});});})");

      assert.deepEqual(await ev(ORDER), ["needs-me", "today", "apps"], "the Apps widget was added, last");
      const cell = await ev("(function(){ var el=document.querySelector('[data-widget=\"apps\"]');"
        + " return { text: (el.textContent||'').replace(/\\s+/g,' ').trim(), tiles: el.querySelectorAll('.wg-tile').length,"
        + " height: el.getBoundingClientRect().height }; })()");
      assert.match(cell.text, /Apps/, "the cell drew its title");
      assert.ok(cell.height > 60, `the cell has a drawn body (${cell.height} px)`);
      const scroll = await ev(NO_H_SCROLL);
      assert.ok(scroll.sw <= scroll.vw, `no page scroll sideways (${scroll.sw} ≤ ${scroll.vw})`);
      assert.ok(scroll.gridSw <= scroll.gridCw, `the grid does not scroll sideways (${scroll.gridSw} ≤ ${scroll.gridCw})`);
      assert.deepEqual(errors, [], "no page errors");
    } finally {
      ws.close();
      await fetch(chrome.cdp + "/json/close/" + tab.id).catch(() => {});
      await chrome.close();
      chrome = null;
    }
  });
});


test("sameSiteHref refuses a second slash or backslash, a scheme, and control characters", () => {
  for (const bad of ["//evil.example/x", "/\\evil.example/x", "/a\\b", "http://evil.example", "/a\u0001b", "", null]) {
    assert.equal(sameSiteHref(bad), null, JSON.stringify(bad));
  }
  for (const good of ["/dashboard/x", "/dashboard/messages?open=3"]) assert.equal(sameSiteHref(good), good);
});
