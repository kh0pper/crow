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
 *   - the drawer and the mascot sheet carry the For You link only while the flag is on;
 *   - Listen is on by default, sits between Your morning and Your news, and has its own switch.
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
import { parseHTML, DOMParser } from "linkedom";
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
      sections: { morning: true, listen: false, news: false, weather: true }, city: "Exampleton",
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
    assert.deepEqual(JSON.parse(stored().local), { sections: { morning: false, listen: false, news: false, weather: true }, city: "", place: null });
  });
});

test("Listen: on by default, between Your morning and Your news; its Customize switch turns it off and on", async () => {
  await withFlag(async () => {
    const c = new Database(DB_FILE);
    try { c.prepare("DELETE FROM dashboard_settings_overrides WHERE key = 'for_you_settings'").run(); } finally { c.close(); }
    const page = (await get("/dashboard/for-you")).body;
    const at = (re) => page.search(re);
    assert.ok(at(/id="fy-listen-h">Listen</) > at(/id="fy-morning-h"/), "after Your morning");
    assert.ok(at(/id="fy-listen-h">Listen</) < at(/id="fy-news-h"/), "before Your news");
    assert.match(page, /Media Hub reads you a short news briefing each morning/, "no Media Hub: the offer, in its own tile");
    assert.match(page, /data-fy-play-label="Play" data-fy-pause-label="Pause"/);
    const cz = await get("/dashboard/for-you?view=customize");
    assert.match(cz.body, /<span>Listen<\/span><input type="checkbox" name="section_listen" value="1" checked>/);

    await save({ city: "", section_morning: "1", section_news: "1" });
    assert.equal(JSON.parse(stored().local).sections.listen, false);
    assert.doesNotMatch((await get("/dashboard/for-you")).body, /id="fy-listen-h"/);
    await save({ city: "", section_listen: "1" });
    assert.match((await get("/dashboard/for-you")).body, /id="fy-listen-h">Listen</);
    // The owner gate covers it like the rest: anyone else gets 404, no Listen.
    for (const sess of ["plain-sess", "sso-sess"]) {
      const r = await get("/dashboard/for-you", sess);
      assert.equal(r.status, 404, sess);
      assert.doesNotMatch(r.body, /fy-listen|fy-audio/, sess);
    }
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
  assert.ok(js.includes("__crowForYouReveal"), "the drag reveal ships with the shell");
  assert.match(js, /a\[data-for-you-entry\]/, "and targets the flag-gated link only");
});

/**
 * The drag reveal block alone, run in a vm over a linkedom page: a phone-width shell page with its
 * .main-content, tab bar and (flag on) the drawer's For You link. Time, animation frames and timers
 * are driven by hand, so a test says exactly how fast the finger moved. Assertions never compare a
 * linkedom node itself (assert.ok(!node), not equal(node, null)): a failure would inspect the whole
 * document graph and hang the run instead of failing it.
 */
const ORIGIN = "https://crow.example.ts.net";
async function revealRig({
  path = "/dashboard/perch", hash = "", search = "", view = "list", selection = "", kiosk = false, overlay = false,
  draft = "", width = 390, link = true, reduce = false, fetchHtml = null, fetchOk = true, styles = null, prevPath = null,
  href = "/dashboard/for-you", referrer = "",
} = {}) {
  const { shellClientJs } = await import("../servers/gateway/dashboard/shell/client.js");
  const js = shellClientJs();
  const a = js.indexOf("// ─── For You: the drag reveal");
  assert.ok(a >= 0, "the block is there");
  const block = js.slice(a, js.indexOf("// ─── The apps launcher", a));
  const { document } = parseHTML(`<!doctype html><html><body class="shell" data-view="${view}">
    <div class="dashboard">
      <main class="main-content">
        <header class="content-header shell-header--tab"><h2>Chat</h2><a class="shell-scope" id="scope" href="/dashboard/perch">All</a></header>
        <div class="content-body">
          <div class="row"><span class="cell">A chat</span></div>
          <div class="strip"><span class="chip">x</span></div>
          <textarea class="draft"></textarea>
          <input class="field" type="text">
          <canvas class="cv"></canvas><video class="vid"></video><div class="ns" data-no-swipe><span class="in">x</span></div>
        </div>
      </main>
      <nav class="shell-tabs"><a href="/dashboard/perch" aria-current="page">Chat</a></nav>
    </div>
    <dialog id="shell-drawer">${link ? '<a href="' + href + '" class="shell-more-item" data-for-you-entry>For You</a>' : ""}</dialog>
    ${overlay ? "<dialog open></dialog>" : ""}
  </body></html>`);
  if (draft) document.querySelector(".draft").value = draft;
  Object.defineProperty(document, "referrer", { value: referrer });
  const main = document.querySelector(".main-content");
  const tabs = document.querySelector(".shell-tabs");
  const listeners = {};
  let moveOpts = null;
  document.addEventListener = (type, fn) => { listeners[type] = fn; };
  main.addEventListener = (type, fn, opts) => { listeners["main:" + type] = fn; moveOpts = opts; };

  const clock = { t: 1000 };
  let frames = [], rafCalls = 0, timers = [];
  const visits = [], backs = [], fetched = [];
  const store = new Map();
  const location = { origin: ORIGIN, pathname: path, hash, search };
  const window = {
    innerWidth: width,
    localStorage: { getItem: (k) => (kiosk && k === "crow.kiosk.token" ? "tok" : null) },
    matchMedia: (q) => ({ matches: (/max-width: 1023px/.test(q) && width <= 1023) || (/prefers-reduced-motion/.test(q) && reduce) }),
    getSelection: () => ({ isCollapsed: !selection, toString: () => selection }),
    Turbo: { visit: (href) => visits.push(href) },
    history: { length: 3, back: () => backs.push(location.pathname) },
    sessionStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    addEventListener: (type, fn) => { listeners["window:" + type] = fn; },
  };
  const fetchStub = fetchHtml == null ? undefined : (url, opts) => {
    fetched.push({ url, opts });
    return Promise.resolve({ ok: fetchOk, status: fetchOk ? 200 : 500, text: () => Promise.resolve(fetchHtml) });
  };
  const ctx = vm.createContext({
    window, document, location, Date: { now: () => clock.t }, String, Math, Array, Promise, DOMParser, URL, AbortController, fetch: fetchStub,
    getComputedStyle: styles || (() => ({ overflowX: "visible" })),
    requestAnimationFrame: (fn) => { rafCalls++; frames.push(fn); return frames.length; },
    cancelAnimationFrame: () => { frames = []; },
    setTimeout: (fn, ms) => { const h = { fn, at: clock.t + ms }; timers.push(h); return h; },
    clearTimeout: (h) => { timers = timers.filter((x) => x !== h); },
  });
  // A Crow page before this one: run the block there first, then "visit" this one.
  if (prevPath) {
    const real = { ...location };
    Object.assign(location, { pathname: prevPath, hash: "", search: "" });
    vm.runInContext(block, ctx);
    Object.assign(location, real);
  }
  vm.runInContext(block, ctx);

  const at = (sel) => document.querySelector(sel);
  const r = {
    document, main, tabs, visits, backs, fetched, listeners, clock, store,
    // A Turbo render of another page: the block runs again (its visit()).
    visitTo(pathname, search = "") {
      Object.assign(location, { pathname, search, hash: "" });
      vm.runInContext(block, ctx);
    },
    get moveOpts() { return moveOpts; },
    get rafCalls() { return rafCalls; },
    panel: () => document.querySelector("[data-fy-reveal]"),
    frame() { const f = frames; frames = []; f.forEach((fn) => fn()); },
    // Runs the timers due within ms, in order (a timer may add another).
    wait(ms) {
      const until = clock.t + ms;
      for (;;) {
        const due = timers.filter((h) => h.at <= until).sort((x, y) => x.at - y.at)[0];
        if (!due) break;
        timers = timers.filter((h) => h !== due);
        clock.t = Math.max(clock.t, due.at);
        due.fn();
      }
      clock.t = until;
    },
    down(x, y = 300, target = at(".cell")) { listeners.touchstart({ touches: [{ clientX: x, clientY: y }], target }); },
    move(x, y = 300, dt = 16) {
      clock.t += dt;
      const ev = { touches: [{ clientX: x, clientY: y }], cancelable: true, prevented: false, preventDefault() { this.prevented = true; } };
      listeners["main:touchmove"]?.(ev);
      return ev.prevented;
    },
    up(x, y = 300, dt = 0) { clock.t += dt; listeners.touchend({ changedTouches: [{ clientX: x, clientY: y }] }); },
    // A whole drag: down at x0, steps moves to x1 (dt ms apart), an optional pause, up; then
    // the animation and its timers run out. Returns the Turbo visits so far.
    drag(x0, x1, { dy = 0, steps = 8, dt = 40, pause = 0, target } = {}) {
      r.down(x0, 300, target);
      for (let i = 1; i <= steps; i++) {
        r.move(Math.round(x0 + ((x1 - x0) * i) / steps), Math.round(300 + (dy * i) / steps), dt);
        r.frame();
      }
      r.up(x1, 300 + dy, pause);
      r.wait(1000);
      return visits.length;
    },
  };
  return r;
}

test("the drag reveal: the page and the For You panel follow the finger 1:1 once the axis lock decides", async () => {
  const r = await revealRig();
  r.down(100);
  assert.equal(r.move(106), false, "inside the slop: nothing yet, and nothing cancelled");
  assert.ok(!r.panel());
  assert.equal(r.move(120), true, "past the slop and mostly sideways: the drag takes over");
  assert.ok(r.panel(), "the panel is in");
  assert.equal(r.move(170), true);
  assert.equal(r.move(180), true);
  assert.equal(r.rafCalls, 1, "one frame per paint, however many moves");
  r.frame();
  assert.equal(r.main.style.transform, "translate3d(60px,0,0)", "1:1 from where the lock took over");
  assert.equal(r.tabs.style.transform, "translate3d(60px,0,0)", "the tab bar moves with the page");
  assert.equal(r.panel().style.transform, "translate3d(-330px,0,0)", "the panel sits just left of the page");
  assert.equal(r.main.style.willChange, "transform");
  assert.equal(r.panel().getAttribute("aria-hidden"), "true");
  assert.ok(r.panel().hasAttribute("inert"));
  assert.equal(r.document.documentElement.style.overflowX, "clip");
  assert.equal(r.move(50), true);
  r.frame();
  assert.equal(r.main.style.transform, "translate3d(0px,0,0)", "never past where it started");
  assert.equal(r.moveOpts?.passive, false, "the touchmove listener can cancel (it sits on .main-content only)");
  assert.equal(r.document.querySelector(".content-body").style.touchAction, "pan-y pinch-zoom");
});

test("the drag reveal: past 35% it lands on For You, and the page stays put until For You renders", async () => {
  const r = await revealRig();
  r.drag(60, 260, { pause: 200 }); // 200 px - the 12+ px slop, then a stop: no flick
  assert.deepEqual(r.visits, ["/dashboard/for-you"]);
  assert.deepEqual(r.backs, [], "the forward drag never calls history.back()");
  assert.equal(r.main.style.transform, "translate3d(390px,0,0)", "the page finished leaving");
  assert.match(r.main.style.transition, /^transform \d+ms cubic-bezier/);
  assert.equal(r.panel().style.transform, "translate3d(0px,0,0)", "For You fills the screen");
  // Turbo renders For You: the new body is tidied, nothing of the reveal comes along.
  const newBody = r.document.body.cloneNode(true);
  r.listeners["turbo:before-render"]({ detail: { newBody } });
  assert.ok(!newBody.querySelector("[data-fy-reveal]"));
  assert.equal(newBody.querySelector(".main-content").style.transform, "");
  assert.ok(!newBody.querySelector("[data-fy-moved]"));
  assert.equal(r.document.documentElement.style.overflowX, "");
});

test("the drag reveal: a flick lands on For You even short of 35%; a slow short drag springs back", async () => {
  const flick = await revealRig();
  assert.equal(flick.drag(60, 160, { steps: 5, dt: 10 }), 1, "100 px in 50 ms");
  const slow = await revealRig();
  assert.equal(slow.drag(60, 170, { pause: 200 }), 0, "about 95 px of 390, then a stop");
  assert.ok(!slow.panel(), "the panel is gone");
  assert.equal(slow.main.style.transform, "", "the page is back, unstyled");
  assert.equal(slow.main.style.willChange, "");
  assert.equal(slow.main.hasAttribute("data-fy-moved"), false);
  assert.equal(slow.document.documentElement.style.overflowX, "");
  // Past 35% but flung back the other way: back too.
  const back = await revealRig();
  back.down(60);
  for (const x of [80, 140, 200, 260, 300]) { back.move(x, 300, 40); back.frame(); }
  for (const x of [280, 240, 200]) { back.move(x, 300, 10); back.frame(); }
  back.up(200);
  back.wait(1000);
  assert.equal(back.visits.length, 0, "flung back: it stays");
  // Quick to 100 px, then a stop before letting go: the old speed doesn't count.
  const stopped = await revealRig();
  assert.equal(stopped.drag(60, 180, { steps: 4, dt: 10, pause: 300 }), 0, "a fast start, a stop, a short drag: back");
});

test("the drag reveal: the wrong way never takes over, and a second finger springs it back", async () => {
  const r = await revealRig();
  r.down(300);
  assert.equal(r.move(280), false, "right to left on the Chat list: not cancelled");
  assert.equal(r.move(200), false);
  assert.ok(!r.panel(), "and no panel");
  const two = await revealRig();
  two.down(60);
  two.move(90); two.move(250); two.frame();
  assert.ok(two.panel());
  two.listeners["main:touchmove"]({ touches: [{ clientX: 250, clientY: 300 }, { clientX: 100, clientY: 400 }], cancelable: true, preventDefault() {} });
  two.wait(1000);
  assert.ok(!two.panel(), "pinch: the drag lets go");
  assert.deepEqual(two.visits, []);
  assert.equal(two.main.style.transform, "");
  // The second finger's own touchstart arrives first: it springs back too, even past 35%.
  const tap = await revealRig();
  tap.down(60);
  tap.move(90); tap.move(300); tap.frame();
  tap.listeners.touchstart({ touches: [{ clientX: 300, clientY: 300 }, { clientX: 100, clientY: 400 }], target: tap.main });
  assert.equal(tap.move(310), false, "the drag no longer follows");
  tap.up(310);
  tap.wait(1000);
  assert.ok(!tap.panel());
  assert.deepEqual(tap.visits, [], "no landing");
  assert.equal(tap.main.style.transform, "");
});

test("the drag reveal: a vertical scroll is untouched, and a later sideways move does not take it over", async () => {
  const r = await revealRig();
  r.down(100);
  assert.equal(r.move(104, 320), false);
  assert.equal(r.move(230, 330), false, "the scroll decided first");
  r.up(230, 330);
  r.wait(1000);
  assert.ok(!r.panel());
  assert.equal(r.visits.length, 0);
  assert.equal(r.main.style.transform || "", "");
  assert.equal((await revealRig()).drag(60, 220, { dy: 150 }), 0, "a diagonal, mostly vertical: a scroll");
});

test("the drag reveal keeps every guard: only the Chat list or a project home, phone width, the flag's link, and none of the blockers", async () => {
  assert.equal((await revealRig()).drag(60, 300), 1, "the Chat list");
  assert.equal((await revealRig({ path: "/dashboard/project/garden" })).drag(60, 300), 1, "a project home");
  const tooNear = await revealRig();
  assert.equal(tooNear.drag(40, 300), 0, "inside 48 px of the left edge: the system Back gesture's");
  assert.ok(!tooNear.panel());
  assert.equal((await revealRig()).drag(48, 300), 1, "48 px in is far enough");
  assert.equal((await revealRig()).drag(300, 60), 0, "right to left on the Chat list");
  assert.equal((await revealRig({ hash: "#perchlive-0000000a" })).drag(60, 300), 0, "an open chat");
  assert.equal((await revealRig({ view: "chat" })).drag(60, 300), 0, "the chat view");
  assert.equal((await revealRig({ path: "/dashboard/board" })).drag(60, 300), 0, "any other page");
  assert.equal((await revealRig({ selection: "some text" })).drag(60, 300), 0, "text is selected");
  assert.equal((await revealRig({ overlay: true })).drag(60, 300), 0, "a drawer, sheet or dialog is open");
  assert.equal((await revealRig({ draft: "half a thought" })).drag(60, 300), 0, "a draft would be lost");
  assert.equal((await revealRig({ kiosk: true })).drag(60, 300), 0, "a paired kiosk display");
  assert.equal((await revealRig({ width: 1280 })).drag(60, 300), 0, "desktop");
  const off = await revealRig({ link: false });
  assert.equal(off.drag(60, 300), 0, "flag off: no link, no target");
  assert.ok(!off.panel());
  assert.equal(off.listeners["main:touchmove"], undefined, "flag off: no touchmove listener at all");
  assert.equal(off.document.querySelector(".content-body").style.touchAction || "", "", "flag off: touch-action untouched");
  for (const sel of [".draft", ".field", ".cv", ".vid", ".in"]) {
    const r = await revealRig();
    assert.equal(r.drag(60, 300, { target: r.document.querySelector(sel) }), 0, `starting on ${sel}`);
  }
  const tabs = await revealRig();
  assert.equal(tabs.drag(60, 300, { target: tabs.tabs }), 0, "outside the page's .main-content (the tab bar)");
  const sel = await revealRig({ selection: "" });
  sel.down(60);
  assert.equal(sel.move(90), true);
  sel.up(90); sel.wait(1000);
  assert.ok(!sel.panel(), "a drag released at once springs back and tidies up");
});

test("the drag reveal works over the page's own scroller, and a real sideways scroller still keeps its swipe", async () => {
  // .content-body scrolls vertically; overflow-y:auto makes its computed overflow-x "auto" too.
  const styles = () => ({ overflowX: "auto" });
  const widen = (el, sw, cw) => { Object.defineProperty(el, "scrollWidth", { value: sw }); Object.defineProperty(el, "clientWidth", { value: cw }); };
  const page = await revealRig({ path: "/dashboard/project/garden", styles });
  widen(page.document.querySelector(".content-body"), 400, 390);
  assert.equal(page.drag(60, 300), 1, "over the page's own scroller");
  const strip = await revealRig({ path: "/dashboard/project/garden", styles });
  widen(strip.document.querySelector(".strip"), 900, 390);
  assert.equal(strip.drag(60, 300, { target: strip.document.querySelector(".chip") }), 0, "inside a real sideways scroller");
  const tiny = await revealRig({ path: "/dashboard/project/garden", styles });
  widen(tiny.document.querySelector(".row"), 395, 390);
  assert.equal(tiny.drag(60, 300), 1, "a few pixels of overflow is not a scroller");
});

test("the reverse drag on For You: right to left pushes it out to the page you came from", async () => {
  const fromChat = await revealRig({ path: "/dashboard/for-you", prevPath: "/dashboard/perch", referrer: ORIGIN + "/dashboard/perch" });
  fromChat.drag(330, 100, { pause: 200 });
  assert.deepEqual(fromChat.backs, ["/dashboard/for-you"], "history.back() to the Crow page before");
  assert.deepEqual(fromChat.visits, []);
  assert.equal(fromChat.main.style.transform, "translate3d(-390px,0,0)");
  assert.equal(fromChat.panel().style.transform, "translate3d(0px,0,0)", "a plain panel from the right");
  assert.equal(fromChat.panel().children.length, 0);

  const direct = await revealRig({ path: "/dashboard/for-you", referrer: ORIGIN + "/dashboard/perch" });
  direct.drag(330, 100, { pause: 200 });
  assert.deepEqual(direct.backs, [], "no Crow page before it: never Back out of Crow");
  assert.deepEqual(direct.visits, ["/dashboard/perch"], "the Chat list instead");
  for (const referrer of ["", "https://elsewhere.example/page", "not a url"]) {
    const r = await revealRig({ path: "/dashboard/for-you", prevPath: "/dashboard/perch", referrer });
    r.drag(330, 100, { pause: 200 });
    assert.deepEqual([r.backs, r.visits], [[], ["/dashboard/perch"]], `referrer ${JSON.stringify(referrer)}: the Chat list, never Back`);
  }

  const short = await revealRig({ path: "/dashboard/for-you", prevPath: "/dashboard/perch" });
  short.drag(330, 250, { pause: 200 });
  assert.deepEqual([short.backs, short.visits], [[], []], "short of 35%: springs back");
  assert.equal(short.main.style.transform, "");

  const edge = await revealRig({ path: "/dashboard/for-you", prevPath: "/dashboard/perch" });
  edge.drag(360, 60, { pause: 200 });
  assert.deepEqual([edge.backs, edge.visits], [[], []], "inside 48 px of the right edge: the system Back gesture's");
  const wrongWay = await revealRig({ path: "/dashboard/for-you", prevPath: "/dashboard/perch" });
  assert.equal(wrongWay.drag(60, 300, { pause: 200 }), 0, "left to right on For You: nothing");
  assert.deepEqual(wrongWay.backs, []);
  const custom = await revealRig({ path: "/dashboard/for-you", search: "?view=customize", prevPath: "/dashboard/perch" });
  custom.drag(330, 100, { pause: 200 });
  assert.deepEqual([custom.backs, custom.visits], [[], []], "not on Customize (it has its own back button)");
});

test("the drag reveal with reduced motion: nothing slides, the panel cross-fades in", async () => {
  const r = await revealRig({ reduce: true });
  r.down(60);
  r.move(80); r.move(80 + 195); r.frame();
  assert.equal(r.main.style.transform || "", "", "the page does not move");
  assert.equal(r.panel().style.transform || "", "");
  assert.equal(r.panel().style.opacity, "0.5", "the panel fades in with the finger");
  r.up(275, 300, 200);
  assert.match(r.panel().style.transition, /^opacity 150ms/);
  assert.equal(r.panel().style.opacity, "1");
  r.wait(1000);
  assert.deepEqual(r.visits, ["/dashboard/for-you"]);
  const back = await revealRig({ reduce: true });
  assert.equal(back.drag(60, 150, { pause: 200 }), 0);
  assert.ok(!back.panel());
});

test("the drag reveal's panel: a For You copy with nothing that runs, or a skeleton until it arrives", async () => {
  const fetchHtml = `<!doctype html><html><head><script>window.pwned = 1</script></head><body class="shell">
    <div class="dashboard"><main class="main-content" id="m" onclick="pwned()">
      <header class="content-header"><h2>For You</h2></header>
      <div class="content-body"><style>.fy { gap: 16px; }</style>
        <div class="fy" data-fy><h1 class="fy-title" id="t">For You</h1>
          <script>window.pwned = 2</script><iframe src="/x"></iframe><object data="/y"></object>
          <a class="ok" href="/dashboard/board" onmouseover="pwned()">Board</a>
          <a class="js" href="javascript:pwned()">x</a><a class="far" href="//evil.example/">x</a><a class="bs" href="/\\evil.example/">x</a>
          <img class="far" src="https://evil.example/p.png" srcset="https://evil.example/2x.png 2x"><img class="near" src="/img/a.png">
          <svg><script>pwned()</script><use href="javascript:pwned()"></use></svg>
          <dialog open id="fy-sheet-1"><button autofocus formaction="/z">x</button></dialog>
          <form action="https://evil.example/"><input name="q"></form>
        </div>
      </div></main>
      <nav class="shell-tabs" data-turbo-permanent id="tabs"><a href="/dashboard/perch">Chat</a></nav></div>
    <script>window.pwned = 3</script></body></html>`;
  const r = await revealRig({ fetchHtml });
  r.down(60);
  assert.equal(r.fetched.length, 1, "fetched on the first eligible touch");
  assert.equal(r.fetched[0].url, "/dashboard/for-you");
  assert.equal(r.fetched[0].opts.credentials, "same-origin");
  await new Promise((res) => setImmediate(res));
  r.up(60);
  r.down(60);
  assert.equal(r.fetched.length, 1, "once per page view");
  r.move(80); r.move(150); r.frame();
  const p = r.panel();
  assert.ok(p.classList.contains("dashboard"), "laid out like the page");
  assert.ok(p.querySelector(".main-content .fy-title"), "the copy is For You's");
  assert.ok(p.querySelector(".shell-tabs"), "with its tab bar");
  assert.ok(p.querySelector("style"), "For You's own (scoped) styles come along");
  const html = p.outerHTML;
  for (const bad of ["<script", "<iframe", "<object", "<dialog", "onclick", "onmouseover", "javascript:", "evil.example", "srcset", " id=", "autofocus", "formaction", "data-turbo-permanent", "action="]) {
    assert.ok(!html.includes(bad), `nothing like ${bad} in the panel`);
  }
  assert.equal(p.querySelector("a.ok").getAttribute("href"), "/dashboard/board", "a same-site path stays");
  assert.equal(p.querySelector("img.near").getAttribute("src"), "/img/a.png");
  assert.equal(p.querySelector("a.bs").hasAttribute("href"), false, "a backslash path (protocol-relative to a browser) goes");

  // A response that is not For You (a sign-in page, an error): the skeleton.
  const login = await revealRig({ fetchHtml: '<html><body><main class="main-content"><form><input name="password"></form></main></body></html>' });
  login.down(60);
  await new Promise((res) => setImmediate(res));
  login.move(80); login.move(150); login.frame();
  const sk = login.panel();
  assert.equal(sk.querySelectorAll(".fy-reveal-card").length, 3, "three grey cards");
  assert.equal(sk.querySelector(".fy-reveal-title").textContent, "For You", "the link's own (translated) name");
  assert.equal(sk.querySelector(".content-header h2").textContent, "For You");
  assert.equal(sk.querySelector(".content-header").classList.contains("shell-header--tab"), false);
  assert.ok(!sk.querySelector("[aria-current]"), "no tab lit");
  assert.ok(!sk.querySelector("[id]"), "no duplicate ids from the live header");
  assert.ok(!sk.querySelector("input"));
  // No fetch at all (or not back yet): the skeleton too.
  const none = await revealRig();
  none.down(60); none.move(80); none.move(150); none.frame();
  assert.equal(none.panel().querySelectorAll(".fy-reveal-card").length, 3);
});

test("the drag reveal's source never writes fetched text as HTML", async () => {
  const { shellClientJs } = await import("../servers/gateway/dashboard/shell/client.js");
  const js = shellClientJs();
  const block = js.slice(js.indexOf("// ─── For You: the drag reveal"), js.indexOf("// ─── The apps launcher"));
  for (const sink of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "createContextualFragment", "eval(", "new Function"]) {
    assert.ok(!block.includes(sink), `no ${sink}`);
  }
  assert.match(block, /new DOMParser\(\)\.parseFromString\(html, 'text\/html'\)/, "fetched text only ever goes through DOMParser");
});

test("a cached snapshot taken mid-reveal is tidied before it shows, and a new page view starts clean", async () => {
  const r = await revealRig({ path: "/dashboard/for-you", prevPath: "/dashboard/perch", referrer: ORIGIN + "/" });
  r.drag(330, 100, { pause: 200 });
  assert.deepEqual(r.backs, ["/dashboard/for-you"]);
  // Turbo restores the Chat list from a snapshot that carried a mid-drag page and panel.
  const snap = r.document.body.cloneNode(true);
  snap.querySelector(".main-content").setAttribute("style", "transform:translate3d(120px,0,0);will-change:transform");
  snap.querySelector(".main-content").setAttribute("data-fy-moved", "");
  r.listeners["turbo:before-render"]({ detail: { newBody: snap } });
  assert.ok(!snap.querySelector("[data-fy-reveal]"));
  assert.equal(snap.querySelector(".main-content").style.transform, "");
  assert.equal(snap.querySelector(".main-content").style.willChange, "");
  // The give-up timer from the landing does nothing once the page has moved on.
  r.wait(20000);
});

test("the drag reveal's sanitizer: no name, background or SVG animation, and no CSS that could load anything", async () => {
  const fetchHtml = `<html><body class="shell"><div class="dashboard"><main class="main-content">
    <div class="content-body">
      <style class="plain">.fy { gap: 16px; }</style>
      <style class="beacon">.fy { background: url(https://evil.example/b.png); }</style>
      <style class="imp">@import "https://evil.example/x.css";</style>
      <style class="esc">.fy { background: \\75 rl(https://evil.example/c.png); }</style>
      <div class="fy" data-fy>
        <h1 class="fy-title" style="color: red">For You</h1>
        <p class="bg" style="background-image: url('https://evil.example/d.png')" background="https://evil.example/e.png">x</p>
        <img class="named" name="Turbo" src="/img/a.png"><form class="f" name="Turbo"></form>
        <svg><a href="/x"><animate attributeName="href" to="javascript:pwned()"/><set attributeName="href" to="javascript:pwned()"/>x</a></svg>
      </div>
    </div></main></div></body></html>`;
  const r = await revealRig({ fetchHtml });
  r.down(60);
  await new Promise((res) => setImmediate(res));
  r.move(80); r.move(150); r.frame();
  const p = r.panel();
  assert.ok(p.querySelector("style.plain"), "plain For You CSS stays");
  for (const cls of ["beacon", "imp", "esc"]) assert.ok(!p.querySelector("style." + cls), `style.${cls} is dropped`);
  assert.equal(p.querySelector(".fy-title").getAttribute("style"), "color: red", "a plain style attribute stays");
  assert.equal(p.querySelector(".bg").hasAttribute("style"), false, "a style attribute with url( goes");
  assert.equal(p.querySelector(".bg").hasAttribute("background"), false);
  assert.equal(p.querySelector(".named").hasAttribute("name"), false, "no named globals");
  assert.equal(p.querySelector(".f").hasAttribute("name"), false);
  const html = p.outerHTML;
  for (const bad of ["evil.example", "<animate", "<set", "javascript:", "@import", "url("]) assert.ok(!html.includes(bad), `nothing like ${bad}`);
});

test("the drag reveal fetches at most once per page view, even on failure; a new render aborts it; only a /dashboard/ link is used", async () => {
  const failed = await revealRig({ fetchHtml: "oops", fetchOk: false });
  failed.down(60);
  await new Promise((res) => setImmediate(res));
  failed.up(60);
  failed.down(70);
  failed.up(70);
  assert.equal(failed.fetched.length, 1, "a failure is not retried on every touch");
  failed.down(60); failed.move(80); failed.move(150); failed.frame(); // the skeleton still shows
  assert.equal(failed.panel().querySelectorAll(".fy-reveal-card").length, 3);

  const slow = await revealRig({ fetchHtml: "<html></html>" });
  slow.down(60);
  const signal = slow.fetched[0].opts.signal;
  assert.ok(signal && !signal.aborted);
  slow.listeners["turbo:before-render"]({ detail: { newBody: slow.document.body.cloneNode(true) } });
  assert.equal(signal.aborted, true, "Turbo rendering another page aborts it");

  for (const href of ["https://evil.example/dashboard/for-you", "//evil.example/dashboard/for-you", "/elsewhere", "/dashboard\\..\\x", "javascript:alert(1)"]) {
    const r = await revealRig({ href, fetchHtml: "<html></html>" });
    assert.equal(r.drag(60, 300, { pause: 200 }), 0, `no landing on ${href}`);
    assert.equal(r.fetched.length, 0, `no fetch of ${href}`);
    assert.ok(!r.panel());
  }
});

test("the way back after a forward drag: a one-time marker, then the referrer rule, then the Chat list", async () => {
  const MARK = "crow.forYou.dragFrom";
  // 1. The app opens Crow fresh (no referrer): forward drag, land, reverse drag -> Back, marker consumed.
  const r = await revealRig({ path: "/dashboard/project/garden" });
  r.drag(60, 300, { pause: 200 });
  assert.deepEqual(r.visits, ["/dashboard/for-you"]);
  assert.equal(JSON.parse(r.store.get(MARK)).landed, false, "set on landing, not yet rendered");
  assert.equal(JSON.parse(r.store.get(MARK)).from, "/dashboard/project/garden");
  r.listeners["turbo:before-render"]({ detail: { newBody: r.document.body.cloneNode(true) } });
  r.visitTo("/dashboard/for-you");
  assert.equal(JSON.parse(r.store.get(MARK)).landed, true, "For You's render marks it landed");
  r.drag(330, 100, { pause: 200 });
  assert.deepEqual(r.backs, ["/dashboard/for-you"], "Back, with no referrer at all");
  assert.equal(r.visits.length, 1, "no Chat list visit");
  assert.equal(r.store.has(MARK), false, "consumed");

  // 2. No marker, a same-origin referrer and a Crow page before: Back.
  const ref = await revealRig({ path: "/dashboard/for-you", prevPath: "/dashboard/perch", referrer: ORIGIN + "/dashboard/perch" });
  ref.drag(330, 100, { pause: 200 });
  assert.deepEqual([ref.backs, ref.visits], [["/dashboard/for-you"], []]);

  // 3. Neither: the Chat list.
  const none = await revealRig({ path: "/dashboard/for-you", prevPath: "/dashboard/perch" });
  none.drag(330, 100, { pause: 200 });
  assert.deepEqual([none.backs, none.visits], [[], ["/dashboard/perch"]]);
});

test("the landing marker is cleared by any other navigation, and a late landing does not count", async () => {
  const MARK = "crow.forYou.dragFrom";
  const away = await revealRig();
  away.drag(60, 300, { pause: 200 });
  away.listeners["turbo:before-render"]({ detail: { newBody: away.document.body.cloneNode(true) } });
  away.visitTo("/dashboard/for-you");
  away.visitTo("/dashboard/for-you", "?view=customize");
  assert.equal(away.store.has(MARK), false, "Customize is away from For You: cleared");
  away.visitTo("/dashboard/for-you");
  away.drag(330, 100, { pause: 200 });
  assert.deepEqual([away.backs, away.visits.slice(1)], [[], ["/dashboard/perch"]], "came in another way: the Chat list");

  const late = await revealRig();
  late.drag(60, 300, { pause: 200 });
  late.listeners["turbo:before-render"]({ detail: { newBody: late.document.body.cloneNode(true) } });
  late.clock.t += 60000;
  late.visitTo("/dashboard/for-you");
  assert.equal(late.store.has(MARK), false, "a landing long after the drag is not this drag's");

  // A forged or foreign marker is never followed.
  const forged = await revealRig({ path: "/dashboard/for-you" });
  forged.store.set(MARK, JSON.stringify({ from: "https://elsewhere.example/", to: "/dashboard/for-you", at: forged.clock.t, landed: true }));
  forged.drag(330, 100, { pause: 200 });
  assert.deepEqual([forged.backs, forged.visits], [[], ["/dashboard/perch"]]);
});
