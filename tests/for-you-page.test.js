/**
 * For You v1, the page and its gates, through the REAL dashboard router (dashboardAuth,
 * csrfMiddleware, the panel dispatch, the shell) over a scratch CROW_DATA_DIR and CROW_HOME:
 *   - CROW_FOR_YOU off: /dashboard/for-you is a 404 for everyone, and no entry point renders;
 *   - on: only the owner's own local password session gets the page; a session without the
 *     password scope or one a paired instance's sign-in minted (SSO) gets 404, GET and POST alike;
 *   - the customize save needs the CSRF token, writes LOCAL scope only (never the synced table),
 *     geocodes a changed city once, and a city it can't find is saved with no place (no chip);
 *   - no city: no weather chip, and the quiet "Add your city" link; with one, the chip and the
 *     Open-Meteo attribution;
 *   - the drawer and the mascot sheet carry the For You link only while the flag is on.
 * The geocoder and the weather fetch are test seams: nothing here reaches the network.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import vm from "node:vm";
import { actAsServe, serveHeaders } from "./fixtures/serve-peer.mjs";
actAsServe();

const dir = mkdtempSync(join(tmpdir(), "for-you-page-"));
process.env.CROW_DATA_DIR = dir;
const HOME = join(dir, "home");
process.env.CROW_HOME = HOME;
mkdirSync(HOME, { recursive: true });
delete process.env.CROW_DB_PATH;
delete process.env.CROW_FOR_YOU;
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db"); // absent: an empty morning
process.env.PIBOT_PI_CLI = "/nonexistent/pi-never-spawned-by-this-file.js";
const DB_FILE = join(dir, "crow.db");
writeFileSync(join(dir, "instance-id"), "instance-for-you-page");
writeFileSync(join(HOME, "installed.json"), "[]");
const REPO = new URL("..", import.meta.url).pathname;

let server, base, MODE, panelMod;
const geocoded = [];

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
  panelMod?._setForYouSeamsForTest({});
  server?.closeAllConnections?.();
  server?.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  geocoded.length = 0;
  panelMod._setForYouSeamsForTest({
    geocode: async (city) => {
      geocoded.push(city);
      if (city === "Atlantis") return null;
      if (city === "Offline") throw new Error("network down");
      return { name: "Exampleton", admin1: "State", country: "Country", lat: 39.8, lon: -89.6, unit: "celsius" };
    },
    weather: async (place) => (place ? { temp: 21, code: 0, high: 25, low: 12, rain: 30, unit: "celsius" } : null),
  });
});

const NET = serveHeaders("operator@example.com");
const jar = (sess) => `crow_session=${sess}; crow_csrf=tok; ${MODE}=new`;
async function get(path, sess = "owner-sess") {
  const r = await fetch(base + path, { redirect: "manual", headers: { ...NET, cookie: jar(sess) } });
  return { status: r.status, location: r.headers.get("location"), body: await r.text() };
}
async function save(fields, { sess = "owner-sess", csrf = "tok" } = {}) {
  const body = new URLSearchParams({ ...(csrf ? { _csrf: csrf } : {}), ...fields });
  const r = await fetch(base + "/dashboard/for-you", {
    method: "POST", redirect: "manual",
    headers: { ...NET, cookie: jar(sess), "content-type": "application/x-www-form-urlencoded" }, body,
  });
  return { status: r.status, location: r.headers.get("location"), body: await r.text() };
}
async function withFlag(fn) {
  process.env.CROW_FOR_YOU = "1";
  try { return await fn(); } finally { delete process.env.CROW_FOR_YOU; }
}
function stored() {
  const c = new Database(DB_FILE, { readonly: true });
  try {
    return {
      local: c.prepare("SELECT value FROM dashboard_settings_overrides WHERE key = 'for_you_settings'").get()?.value ?? null,
      global: c.prepare("SELECT value FROM dashboard_settings WHERE key = 'for_you_settings'").get()?.value ?? null,
    };
  } finally { c.close(); }
}

test("flag off: a 404 for the owner too, GET and POST, and no entry point anywhere", async () => {
  assert.equal(process.env.CROW_FOR_YOU, undefined);
  const r = await get("/dashboard/for-you");
  assert.equal(r.status, 404);
  assert.doesNotMatch(r.body, /data-fy/);
  assert.equal((await save({ city: "Exampleton" })).status, 404);
  assert.equal(stored().local, null, "nothing was written");
  const home = await get("/dashboard/project/garden");
  assert.equal(home.status, 200);
  assert.doesNotMatch(home.body, /<a [^>]*data-for-you-entry/, "no link (the swipe's code names the attribute, but finds nothing)");
  assert.doesNotMatch(home.body, /href="\/dashboard\/for-you"/);
});

test("flag on: the owner's local password session gets the page; a plain or a paired instance's SSO session gets 404", async () => {
  await withFlag(async () => {
    const own = await get("/dashboard/for-you");
    assert.equal(own.status, 200);
    assert.match(own.body, /<body class="shell/);
    assert.match(own.body, /<h1 class="fy-title">For You<\/h1>/);
    assert.match(own.body, /Your morning/);
    assert.match(own.body, /Nothing needs you this morning\./);
    for (const sess of ["plain-sess", "sso-sess"]) {
      const r = await get("/dashboard/for-you", sess);
      assert.equal(r.status, 404, sess);
      assert.doesNotMatch(r.body, /data-fy/, sess);
      assert.equal((await get("/dashboard/for-you?view=customize", sess)).status, 404, sess);
      assert.equal((await save({ city: "Exampleton" }, { sess })).status, 404, `${sess} cannot save`);
    }
    assert.equal(stored().local, null, "no non-owner save landed");
  });
});

test("flag on: the drawer's More of Crow and the mascot sheet link For You", async () => {
  await withFlag(async () => {
    const home = await get("/dashboard/project/garden");
    const links = home.body.match(/<a href="\/dashboard\/for-you"[^>]*data-for-you-entry[^>]*>/g) || [];
    assert.ok(links.length >= 2, `drawer (and rail) plus the mascot sheet: ${links.length}`);
    assert.match(home.body, /class="shell-sheet-link" data-for-you-entry>For You</);
    assert.match(home.body, /class="shell-more-item" data-for-you-entry>For You</);
  });
});

test("no city: no weather chip and a quiet link to add one; Media Hub missing: the install offer", async () => {
  await withFlag(async () => {
    const r = await get("/dashboard/for-you");
    assert.doesNotMatch(r.body, /class="fy-chip"/);
    assert.doesNotMatch(r.body, /Open-Meteo/);
    assert.match(r.body, /<a class="fy-quiet" href="\/dashboard\/for-you\?view=customize#fy-city">Add your city for weather<\/a>/);
    assert.match(r.body, /Install Media Hub/);
  });
});

test("customize save: CSRF required; local scope only; a changed city is geocoded once and the chip appears", async () => {
  await withFlag(async () => {
    assert.equal((await save({ city: "Exampleton", section_morning: "1" }, { csrf: null })).status, 403, "no CSRF token");
    assert.equal((await save({ city: "Exampleton", section_morning: "1" }, { csrf: "wrong" })).status, 403);
    assert.equal(stored().local, null);

    const r = await save({ city: "  Exampleton ", section_morning: "1", section_weather: "1" });
    assert.equal(r.status, 303);
    assert.equal(r.location, "/dashboard/for-you?view=customize&flash=saved");
    assert.deepEqual(geocoded, ["Exampleton"]);
    const s = stored();
    assert.equal(s.global, null, "never the synced table");
    assert.deepEqual(JSON.parse(s.local), {
      sections: { morning: true, news: false, weather: true }, city: "Exampleton",
      place: { name: "Exampleton", admin1: "State", country: "Country", lat: 39.8, lon: -89.6, unit: "celsius" },
    });

    const page = await get("/dashboard/for-you");
    assert.match(page.body, /<span class="fy-chip">21° · Clear<\/span>/);
    assert.match(page.body, /High 25° · Low 12° · 30% chance of rain/);
    assert.match(page.body, /Weather: Open-Meteo/);
    assert.doesNotMatch(page.body, /Add your city/);
    assert.doesNotMatch(page.body, /Your news/, "the news section is off");

    // The same city again: no second lookup.
    await save({ city: "Exampleton", section_weather: "1" });
    assert.deepEqual(geocoded, ["Exampleton"]);
    const cz = await get("/dashboard/for-you?view=customize&flash=saved");
    assert.match(cz.body, /Weather for Exampleton, State, Country/);
    assert.match(cz.body, /<input type="checkbox" name="section_weather" value="1" checked>/);
    assert.match(cz.body, /<input type="checkbox" name="section_news" value="1">/);
    assert.match(cz.body, /role="status">Saved\.</);
  });
});

test("a city the geocoder can't find, or can't reach, is saved with no place: no chip, and the screen says which", async () => {
  await withFlag(async () => {
    const r = await save({ city: "Atlantis", section_weather: "1" });
    assert.equal(r.location, "/dashboard/for-you?view=customize&flash=notfound");
    assert.equal(JSON.parse(stored().local).place, null);
    const cz = await get(r.location);
    assert.match(cz.body, /Saved, but Crow couldn't find &quot;Atlantis&quot;/);
    assert.doesNotMatch((await get("/dashboard/for-you")).body, /class="fy-chip"/);
    const off = await save({ city: "Offline", section_weather: "1" });
    assert.equal(off.location, "/dashboard/for-you?view=customize&flash=failed");
    assert.equal(JSON.parse(stored().local).city, "Offline");
    // Clearing the city clears the place.
    await save({ city: "", section_weather: "1" });
    assert.deepEqual(JSON.parse(stored().local), { sections: { morning: false, news: false, weather: true }, city: "", place: null });
  });
});

test("every section off: one line says where to turn them back on", async () => {
  await withFlag(async () => {
    await save({ city: "" });
    const r = await get("/dashboard/for-you");
    assert.match(r.body, /Every section is off\. Turn one on in Customize\./);
    assert.doesNotMatch(r.body, /Your morning/);
  });
});

test("a failing project lookup costs the morning one line; the rest of the page renders", async () => {
  await withFlag(async () => {
    await save({ city: "Exampleton", section_morning: "1", section_news: "1", section_weather: "1" });
    panelMod._setForYouSeamsForTest({
      geocode: async () => null,
      weather: async () => ({ temp: 21, code: 0, high: 25, low: 12, rain: 30, unit: "celsius" }),
      projects: async () => { throw new Error("database is locked"); },
    });
    const r = await get("/dashboard/for-you");
    assert.equal(r.status, 200);
    assert.match(r.body, /Your morning couldn't load just now\./);
    assert.match(r.body, /<span class="fy-chip">21° · Clear<\/span>/, "weather still renders");
    assert.match(r.body, /Install Media Hub/, "news still renders");
  });
});

test("a signed peer request (crossHostAuth) never reaches the page", async () => {
  await withFlag(async () => {
    const { isLocalPasswordSessionOn } = await import("../servers/gateway/dashboard/local-session.js");
    const { createDbClient } = await import("../servers/db.js");
    const db = createDbClient();
    try {
      assert.equal(await isLocalPasswordSessionOn(db, { dashboardSession: "owner-sess" }), true);
      let status = 0;
      const res = { status(n) { status = n; return this; }, type() { return this; }, send() { return this; } };
      const out = await panelMod.default.handler({ method: "GET", query: {}, dashboardSession: "owner-sess", crossHostAuth: { ok: true } }, res, { db, lang: "en", layout: () => "page" });
      assert.equal(out, null);
      assert.equal(status, 404);
    } finally { db.close(); }
  });
});

test("the page's client JS carries no backtick (it is emitted inside a template literal)", async () => {
  const { forYouClientJs } = await import("../servers/gateway/dashboard/panels/for-you/client.js");
  assert.ok(!forYouClientJs().includes("`"));
  const { shellClientJs } = await import("../servers/gateway/dashboard/shell/client.js");
  const js = shellClientJs();
  assert.ok(js.includes("__crowForYouSwipeBound"), "the swipe ships with the shell");
  assert.match(js, /a\[data-for-you-entry\]/, "and targets the flag-gated link only");
});

/** The swipe block alone, run against a stub page: which gestures navigate and which don't. */
async function swipeRig({ path = "/dashboard/perch", hash = "", view = "list", selection = "", kiosk = false, overlay = false, draft = "", width = 390, link = true } = {}) {
  const { shellClientJs } = await import("../servers/gateway/dashboard/shell/client.js");
  const js = shellClientJs();
  const a = js.indexOf("// ─── For You: the phone swipe");
  const block = js.slice(a, js.indexOf("// ─── The apps launcher", a));
  const listeners = {};
  const visits = [];
  const body = { getAttribute: (k) => (k === "data-view" ? view : null) };
  const field = { value: draft, isContentEditable: false };
  const document = {
    body,
    addEventListener: (type, fn) => { listeners[type] = fn; },
    querySelector: (sel) => {
      if (sel.startsWith("dialog[open]")) return overlay ? {} : null;
      if (sel === "a[data-for-you-entry]") return link ? { getAttribute: () => "/dashboard/for-you" } : null;
      return null;
    },
    querySelectorAll: () => (draft ? [field] : []),
  };
  const window = {
    localStorage: { getItem: (k) => (kiosk && k === "crow.kiosk.token" ? "tok" : null) },
    matchMedia: (q) => ({ matches: /max-width: 1023px/.test(q) && width <= 1023 }),
    getSelection: () => ({ isCollapsed: !selection, toString: () => selection }),
    Turbo: { visit: (href) => visits.push(href) },
  };
  vm.runInNewContext(block, { window, document, location: { pathname: path, hash }, getComputedStyle: () => ({ overflowX: "visible" }), Date, String });
  const target = { parentElement: null, matches: () => false, scrollWidth: 0, clientWidth: 0 };
  return (x0, x1, dy = 0) => {
    listeners.touchstart({ touches: [{ clientX: x0, clientY: 300 }], target });
    listeners.touchend({ changedTouches: [{ clientX: x1, clientY: 300 + dy }] });
    return visits.length;
  };
}

test("the phone swipe: a clear left-to-right swipe on the Chat list or a project home opens For You, and nothing else does", async () => {
  assert.equal((await swipeRig())(60, 220), 1, "the Chat list");
  assert.equal((await swipeRig({ path: "/dashboard/project/garden" }))(60, 220), 1, "a project home");
  assert.equal((await swipeRig())(10, 220), 0, "from the edge: Android's back gesture owns it");
  assert.equal((await swipeRig())(60, 120), 0, "too short");
  assert.equal((await swipeRig())(60, 220, 150), 0, "mostly vertical: a scroll");
  assert.equal((await swipeRig())(220, 60), 0, "right to left");
  assert.equal((await swipeRig({ hash: "#perchlive-0000000a" }))(60, 220), 0, "an open chat");
  assert.equal((await swipeRig({ view: "chat" }))(60, 220), 0, "the chat view");
  assert.equal((await swipeRig({ path: "/dashboard/board" }))(60, 220), 0, "any other page");
  assert.equal((await swipeRig({ selection: "some text" }))(60, 220), 0, "text is selected");
  assert.equal((await swipeRig({ overlay: true }))(60, 220), 0, "a drawer, sheet or dialog is open");
  assert.equal((await swipeRig({ draft: "half a thought" }))(60, 220), 0, "a draft would be lost");
  assert.equal((await swipeRig({ kiosk: true }))(60, 220), 0, "a paired kiosk display");
  assert.equal((await swipeRig({ width: 1280 }))(60, 220), 0, "desktop");
  assert.equal((await swipeRig({ link: false }))(60, 220), 0, "flag off: no link, no target");
});
