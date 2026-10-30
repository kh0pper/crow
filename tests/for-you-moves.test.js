/**
 * For You v1 — the Move card (Ramble's today's challenge, Done/Swap, the bird's Health, steps and
 * streak).
 *
 * What is pinned here:
 *   - the gateway loader (for-you/moves.js): Ramble missing is "missing", an old copy "update", a
 *     throwing copy "error" (each hides only this section), and the page's weather reaches the
 *     bundle as { rain, temp, code } and nothing else;
 *   - Ramble's own module (bundles/ramble/server/for-you.js) over a scratch ramble db: the
 *     challenge shape, Done filed under the challenge's day, the streak, and challenges off;
 *   - the card's markup: an escaped title, Start/Done/Swap/something-else, the health bar, steps,
 *     the streak, and the quiet line when challenges are off;
 *   - the page: the Move card sits after Your morning and before Listen, its Customize switch
 *     hides it, and with Ramble absent (or failing) the page renders without it and without an
 *     error — and the owner gate still answers 404 for anyone else;
 *   - the client JS: no backtick (it is emitted inside a template literal), Done posts the
 *     challenge's own day, and the card is repainted from the returned JSON with textContent only.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createClient } from "@libsql/client";
import vm from "node:vm";
import { parseHTML } from "linkedom";
import { actAsServe, serveHeaders } from "./fixtures/serve-peer.mjs";
actAsServe();

const dir = mkdtempSync(join(tmpdir(), "for-you-moves-"));
process.env.CROW_DATA_DIR = dir;
const HOME = join(dir, "home");
process.env.CROW_HOME = HOME;
mkdirSync(HOME, { recursive: true });
delete process.env.CROW_DB_PATH;
process.env.CROW_FOR_YOU = "1";
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
process.env.PIBOT_PI_CLI = "/nonexistent/pi-never-spawned-by-this-file.js";
const DB_FILE = join(dir, "crow.db");
writeFileSync(join(dir, "instance-id"), "instance-for-you-moves");
writeFileSync(join(HOME, "installed.json"), "[]");
const REPO = new URL("..", import.meta.url).pathname;

const DAY = "2026-10-30";
/** Ramble's forYouMoves shape (what the bundle module returns and the card renders). */
function snapshot(over = {}) {
  return {
    challenge: {
      day: DAY, title: "Morning stretch", minutes: 10, why: "A good way to start the morning.",
      done: false, entryId: "ex-1", ...(over.challenge || {}),
    },
    health: { energy: 18, max: 30, ...(over.health || {}) },
    steps: { today: 3200, goal: 6000, ...(over.steps || {}) },
    streak: { days: 4, ...(over.streak || {}) },
  };
}

/** The routes' own snapshot shape (the JSON a Done or a Swap returns): the entry is nested. */
function routeSnapshot(over = {}) {
  return {
    challenge: {
      day: DAY, entry: { id: "ex-1", title: "Morning stretch", minutes: 10 },
      reasons: ["slot:day"], why: "A good way to start the morning.", done: false, off: false, swap: 0,
      ...(over.challenge || {}),
    },
    health: { energy: 18, max: 30, ...(over.health || {}) },
    steps: { day: DAY, steps: 3200, goal: 6000, ...(over.steps || {}) },
    streak: { days: 4, ...(over.streak || {}) },
  };
}

// ---- the gateway loader ------------------------------------------------------

let M, B, H;
before(async () => {
  M = await import("../servers/gateway/for-you/moves.js");
  B = await import("../bundles/ramble/server/for-you.js");
  H = await import("../servers/gateway/dashboard/panels/for-you/html.js");
});

test("loader: Ramble absent is 'missing'; an old copy 'update'; a copy that throws is 'error', never the page's", async () => {
  writeFileSync(join(HOME, "installed.json"), "[]");
  M._setMovesModuleForTest(null);
  const db = createClient({ url: "file::memory:" });
  try {
    assert.deepEqual(await M.loadMoves(db, { crowHome: HOME }), { ramble: "missing" });
    M._setMovesModuleForTest({});
    assert.deepEqual(await M.loadMoves(db, { crowHome: HOME }), { ramble: "update" });
    M._setMovesModuleForTest({ forYouMoves: async () => { throw new Error("no such column: moves"); } });
    assert.deepEqual(await M.loadMoves(db, { crowHome: HOME }), { ramble: "error" });
  } finally { M._setMovesModuleForTest(null); db.close(); }
});

test("loader: the page's weather reaches Ramble as { rain, temp, code }, and nothing else does", async () => {
  const seen = [];
  M._setMovesModuleForTest({ forYouMoves: async (db, opts) => { seen.push(opts); return snapshot(); } });
  const db = createClient({ url: "file::memory:" });
  try {
    const ok = await M.loadMoves(db, {
      crowHome: HOME, now: 1_000,
      weather: { temp: 21, code: 0, high: 25, low: 12, rain: 30, unit: "celsius" },
    });
    assert.equal(ok.ramble, "ok");
    assert.equal(ok.moves.challenge.title, "Morning stretch");
    assert.deepEqual(seen[0].weather, { rain: 30, temp: 21, code: 0 });
    assert.equal(seen[0].now, 1_000);
    assert.equal(seen[0].lang, "en", "the page's language defaults to English");
    await M.loadMoves(db, { crowHome: HOME, now: 2_000, weather: null });
    assert.equal(seen[1].weather, null);
    await M.loadMoves(db, { crowHome: HOME, now: 3_000, weather: null, lang: "es" });
    assert.equal(seen[2].lang, "es", "the page's language reaches the bundle, so the why line is Spanish");
    assert.deepEqual(M.moveWeather({ temp: 21 }), { temp: 21 });
    for (const junk of [{}, { temp: "warm" }, null, "hot", 4]) assert.equal(M.moveWeather(junk), null, String(junk));
  } finally { M._setMovesModuleForTest(null); db.close(); }
});

// ---- Ramble's module ---------------------------------------------------------

/** A picker- and ledger-shaped entry. */
function entry(over = {}) {
  return {
    id: "ex-1",
    kind: "exercise",
    title: "A short bodyweight flow",
    minutes: 10,
    level: 2,
    indoor: true,
    activity: "bodyweight",
    equipment: ["none"],
    tags: [],
    steps: ["do the thing"],
    works: [],
    stretches: [],
    mistakes: [],
    skipIf: [],
    easier: null,
    harder: null,
    sources: [],
    reviewed: true,
    pose: {},
    ...over,
  };
}

async function rambleDb() {
  const { initRambleTables } = await import("../bundles/ramble/server/init-tables.js");
  const db = createClient({ url: "file::memory:" });
  await initRambleTables(db);
  return db;
}

test("Ramble's module: today's challenge, the bird's Health, today's steps and the streak; Done files under the card's day", async () => {
  const db = await rambleDb();
  try {
    const now = new Date(2026, 9, 30, 12, 0, 0).getTime(); // local noon: the picker's "day" slot
    const lib = [entry()];
    const first = await B.forYouMoves(db, { now, weather: null, library: lib });
    assert.equal(first.off, false);
    assert.deepEqual(Object.keys(first.challenge).sort(), ["day", "done", "entryId", "minutes", "title", "why"]);
    assert.equal(first.challenge.day, DAY);
    assert.equal(first.challenge.title, "A short bodyweight flow");
    assert.equal(first.challenge.minutes, 10);
    assert.equal(first.challenge.entryId, "ex-1");
    assert.equal(first.challenge.done, false);
    assert.equal(first.challenge.why, "A good way to break up the day.");
    assert.equal(first.health.max >= first.health.energy, true);
    assert.deepEqual(first.steps, { today: 0, goal: 6000 });
    assert.equal(first.streak.days, 0);

    // The why line follows the page's language, from the same stored reason codes.
    const es = await B.forYouMoves(db, { now, weather: null, library: lib, lang: "es" });
    assert.equal(es.challenge.why, "Una buena forma de cortar el día.");

    const { recordChallengeDone } = await import("../bundles/ramble/server/moves/ledger.js");
    await recordChallengeDone(db, { day: first.challenge.day, entry: entry(), now });
    const after = await B.forYouMoves(db, { now, weather: null, library: lib });
    assert.equal(after.challenge.done, true, "Done is per day: the card stays, marked done");
    assert.equal(after.challenge.day, DAY);
    assert.ok(after.health.energy >= first.health.energy, "the move pays Health");
    assert.equal(after.streak.days, 1, "a Done day is a streak day");

    // Nothing free-text can ride out: the challenge is these six fields, health/steps/streak these.
    assert.deepEqual(Object.keys(after).sort(), ["challenge", "health", "off", "steps", "streak"]);
    assert.deepEqual(Object.keys(after.health).sort(), ["energy", "max"]);
    assert.deepEqual(Object.keys(after.steps).sort(), ["goal", "today"]);
    assert.deepEqual(Object.keys(after.streak), ["days"]);
  } finally { db.close(); }
});

test("Ramble's module: no entry the picker can serve is a null challenge; challenges off is the quiet flag, not an error", async () => {
  const db = await rambleDb();
  try {
    const now = new Date(2026, 9, 30, 12, 0, 0).getTime();
    const none = await B.forYouMoves(db, { now, library: [] });
    assert.equal(none.challenge, null);
    assert.equal(none.off, false);
    assert.equal(none.streak.days, 0);

    const { writePrefs } = await import("../bundles/ramble/server/moves/today.js");
    await writePrefs(db, { on: false });
    const off = await B.forYouMoves(db, { now, library: [entry()] });
    assert.equal(off.off, true);
    assert.equal(off.challenge, null);
    assert.deepEqual(Object.keys(off.health).sort(), ["energy", "max"], "Health still shows");
  } finally { db.close(); }
});

// ---- the card's markup -------------------------------------------------------

const movesOk = () => ({
  ramble: "ok",
  moves: {
    challenge: { day: DAY, title: "Morning stretch", minutes: 10, why: "A good way to start the morning.", done: false, entryId: "ex-1" },
    off: false,
    health: { energy: 18, max: 30 },
    steps: { today: 3200, goal: 6000 },
    streak: { days: 4 },
  },
});

test("the card: the title and the why line are escaped, and Start, Done, Swap and something else are there", () => {
  const out = H.movesHtml({ ramble: "ok", moves: { ...movesOk().moves, challenge: {
    day: DAY, title: 'He said "<b>hi</b>" & left', minutes: 10, why: "A & B <script>", done: false, entryId: "ex-1",
  } } }, "en");
  assert.match(out, /He said &quot;&lt;b&gt;hi&lt;\/b&gt;&quot; &amp; left/);
  assert.doesNotMatch(out, /<b>hi<\/b>|<script>/);
  assert.match(out, /A &amp; B &lt;script&gt;/);

  const page = H.movesHtml(movesOk(), "en");
  assert.match(page, /<h2 class="fy-kicker" id="fy-moves-h">Move<\/h2>/);
  assert.match(page, /<a class="fy-btn fy-btn--primary" href="\/dashboard\/ramble\?moves=start">Start<\/a>/);
  assert.match(page, /<button type="button" class="fy-btn" data-fy-move="done" data-day="2026-10-30">Done<\/button>/);
  assert.match(page, /<button type="button" class="fy-btn" data-fy-move="swap">Swap<\/button>/);
  assert.match(page, /<a class="fy-more-link" href="\/dashboard\/ramble\?moves=log">I did something else<\/a>/);
  assert.match(page, /10 min/);
  assert.match(page, /A good way to start the morning\./);
  assert.match(page, /18 of 30 health/);
  assert.match(page, /width:60%/);
  assert.match(page, /3200 of 6000 steps/);
  assert.match(page, /4-day streak/);
  assert.match(page, /aria-label="18 of 30 health"/);
});

test("the card: a done challenge shows the done state; challenges off is one quiet line with the way back on", () => {
  const done = H.movesHtml({ ramble: "ok", moves: { ...movesOk().moves, challenge: { ...movesOk().moves.challenge, done: true } } }, "en");
  assert.match(done, /<button type="button" class="fy-btn" data-fy-move="done" data-day="2026-10-30" disabled>Done today<\/button>/);

  const off = H.movesHtml({ ramble: "ok", moves: { ...movesOk().moves, off: true, challenge: null } }, "en");
  assert.match(off, /Daily challenges are off\./);
  assert.match(off, /href="\/dashboard\/ramble\?moves=prefs">Turn them on<\/a>/);
  assert.doesNotMatch(off, /data-fy-move="/, "nothing to press while they are off");

  const none = H.movesHtml({ ramble: "ok", moves: { ...movesOk().moves, challenge: null } }, "en");
  assert.match(none, /No challenge today\./);
  assert.match(none, /href="\/dashboard\/ramble\?moves=start">Open Ramble</);
});

test("the card: missing, outdated or failing Ramble hides the whole section; es has its own words", () => {
  for (const state of [{ ramble: "missing" }, { ramble: "update" }, { ramble: "error" }, { ramble: "ok", moves: null }, null]) {
    assert.equal(H.movesHtml(state, "en"), "", JSON.stringify(state));
  }
  const es = H.movesHtml(movesOk(), "es");
  assert.match(es, /id="fy-moves-h">Movimiento</);
  assert.match(es, />Empezar</);
  assert.match(es, />Hecho</);
  assert.match(es, />Cambiar</);
  assert.match(es, />Hice otra cosa</);
  assert.match(es, /18 de 30 de salud/);
  assert.match(es, /3200 de 6000 pasos/);
  assert.match(es, /4 días seguidos/);
  // A single day reads in the singular.
  assert.match(H.movesHtml({ ramble: "ok", moves: { ...movesOk().moves, streak: { days: 1 } } }, "es"), /1 día seguido/);
});

test("the page puts Move after Your morning and before Listen; every section off says so", () => {
  const settings = { sections: { morning: true, moves: true, listen: true, news: false, weather: false }, city: "", place: null };
  const morning = { needs: { total: 0, items: [] }, due: { total: 0, items: [] }, finished: { total: 0, items: [] }, leftOff: null };
  const page = H.forYouPageHtml({
    settings, dateText: "Friday, October 30", morning, moves: movesOk(), listen: { media: "missing", music: false }, news: null, weather: null,
  }, "en");
  const at = (re) => page.search(re);
  assert.ok(at(/id="fy-moves-h">Move</) > at(/id="fy-morning-h"/), "after Your morning");
  assert.ok(at(/id="fy-moves-h">Move</) < at(/id="fy-listen-h">Listen</), "before Listen");
  assert.match(page, /data-fy-move="done" data-day="2026-10-30"/);

  const offPage = H.forYouPageHtml({
    settings: { ...settings, sections: { morning: true, moves: false, listen: true, news: false, weather: false } },
    dateText: "Friday, October 30", morning, moves: movesOk(), listen: { media: "missing", music: false }, news: null, weather: null,
  }, "en");
  assert.doesNotMatch(offPage, /fy-moves-h/, "the switch hides the card");
  assert.match(offPage, /fy-listen-h/, "and only that card");
});

// ---- the client JS -----------------------------------------------------------

test("the client JS has no backtick (it is emitted inside a template literal)", async () => {
  const { forYouClientJs } = await import("../servers/gateway/dashboard/panels/for-you/client.js");
  assert.ok(!forYouClientJs().includes("`"));
});

function movesRig() {
  return import("../servers/gateway/dashboard/panels/for-you/client.js").then(({ forYouClientJs }) => {
    const card = H.movesHtml(movesOk(), "en");
    const { document, window } = parseHTML(`<!doctype html><html><body><main data-fy data-fy-failed="That didn't save">${card}</main></body></html>`);
    Object.defineProperty(document, "cookie", { value: "crow_csrf=t", configurable: true });
    const posts = [];
    let reply = routeSnapshot({ challenge: { entry: { id: "ex-1", title: "New <img src=x onerror=alert(1)>", minutes: 10 }, done: true, why: "" } });
    let fail = false;
    const fetchStub = (url, opts) => {
      posts.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
      if (fail) return Promise.resolve({ ok: false, status: 500 });
      return Promise.resolve({ ok: true, status: 200, json: async () => reply });
    };
    const ctx = vm.createContext({ window, document, fetch: fetchStub, JSON, String, Number, Math, encodeURIComponent, decodeURIComponent, Promise });
    vm.runInContext(forYouClientJs().replace(/^<script>|<\/script>\s*$/g, ""), ctx);
    const click = (verb) => document.querySelector('[data-fy-move="' + verb + '"]').dispatchEvent(new window.Event("click", { bubbles: true }));
    return {
      document, posts, click,
      reply(next) { reply = next; },
      failOn() { fail = true; },
      async settle() { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); },
    };
  });
}

test("the client: Done posts the challenge's own day, and the card is repainted from the JSON with textContent only", async () => {
  const r = await movesRig();
  r.click("done");
  await r.settle();
  assert.deepEqual(r.posts, [{ url: "/api/ramble/moves/done", body: { day: DAY } }]);
  const title = r.document.querySelector("[data-fy-move-title]");
  assert.equal(title.textContent, "New <img src=x onerror=alert(1)>");
  assert.equal(r.document.querySelectorAll("img").length, 0, "never parsed as HTML");
  const done = r.document.querySelector('[data-fy-move="done"]');
  assert.equal(done.textContent, "Done today");
  assert.equal(done.disabled, true);
  assert.equal(r.document.querySelector("[data-fy-move-why]").hasAttribute("hidden"), true, "an empty why line is hidden");
  assert.equal(r.document.querySelector("[data-fy-move-energy]").textContent, "18 of 30 health");
});

test("the client: the streak line is singular at one day", async () => {
  const r = await movesRig();
  r.reply(routeSnapshot({ streak: { days: 1 } }));
  r.click("done");
  await r.settle();
  assert.equal(r.document.querySelector("[data-fy-move-streak]").textContent, "1-day streak");

  const plural = await movesRig();
  plural.click("done");
  await plural.settle();
  assert.equal(plural.document.querySelector("[data-fy-move-streak]").textContent, "4-day streak");
});

test("the client: a repaint that throws never leaves the Done/Swap buttons stuck", async () => {
  const r = await movesRig();
  r.reply({ challenge: { day: DAY, done: false, get entry() { throw new Error("paint failed"); } } });
  r.click("done");
  await r.settle();
  assert.equal(r.document.querySelector("[data-fy-move-status]").textContent, "That didn't save");
  for (const verb of ["done", "swap"]) {
    assert.equal(r.document.querySelector('[data-fy-move="' + verb + '"]').disabled, false, verb);
  }
});

test("the client: Swap posts to Ramble's swap route; a refusal is said in the card, a failure leaves it usable", async () => {
  const r = await movesRig();
  r.reply({ ...routeSnapshot({ challenge: { entry: { id: "ex-2", title: "Another one", minutes: 5 } } }), refused: true });
  r.click("swap");
  await r.settle();
  assert.deepEqual(r.posts, [{ url: "/api/ramble/moves/swap", body: {} }]);
  assert.equal(r.document.querySelector("[data-fy-move-title]").textContent, "Another one");
  assert.equal(r.document.querySelector("[data-fy-move-minutes]").textContent, "5 min");
  assert.equal(r.document.querySelector("[data-fy-move-status]").textContent, "That's all the swaps for today.");
  assert.equal(r.document.querySelector('[data-fy-move="swap"]').disabled, false, "the buttons come back");

  r.failOn();
  r.click("swap");
  await r.settle();
  assert.equal(r.document.querySelector("[data-fy-move-status]").textContent, "That didn't save");
  assert.equal(r.document.querySelector('[data-fy-move="swap"]').disabled, false);
});

// ---- the page (the real dashboard router) ------------------------------------

let server, base, MODE;
before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env }, stdio: "pipe", cwd: REPO });
  const { hashToken } = await import("../servers/gateway/dashboard/auth.js");
  const c = new Database(DB_FILE);
  const tok = c.prepare("INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at, created_at) VALUES (?, 'access', 'dashboard', ?, datetime('now','+1 day'), '2026-06-01 00:00:00')");
  tok.run(hashToken("moves-owner"), "dashboard");
  tok.run(hashToken("moves-plain"), "");
  c.close();

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
  M?._setMovesModuleForTest(null);
  delete process.env.CROW_FOR_YOU;
  server?.closeAllConnections?.();
  server?.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  M?._setMovesModuleForTest(null);
  writeFileSync(join(HOME, "installed.json"), "[]");
  const c = new Database(DB_FILE);
  try { c.prepare("DELETE FROM dashboard_settings_overrides WHERE key = 'for_you_settings'").run(); } finally { c.close(); }
});

const NET = serveHeaders("operator@example.com");
const jar = (sess) => `crow_session=${sess}; crow_csrf=tok; ${MODE}=new`;
async function get(path, sess = "moves-owner") {
  const r = await fetch(base + path, { redirect: "manual", headers: { ...NET, cookie: jar(sess) } });
  return { status: r.status, body: await r.text() };
}
async function save(fields) {
  const body = new URLSearchParams({ _csrf: "tok", ...fields });
  const r = await fetch(base + "/dashboard/for-you", {
    method: "POST", redirect: "manual",
    headers: { ...NET, cookie: jar("moves-owner"), "content-type": "application/x-www-form-urlencoded" }, body,
  });
  return { status: r.status, location: r.headers.get("location") };
}

test("page: Ramble absent is no card and no error; installed, the card is there between Your morning and Listen", async () => {
  const absent = await get("/dashboard/for-you");
  assert.equal(absent.status, 200);
  assert.match(absent.body, /Your morning/);
  assert.doesNotMatch(absent.body, /fy-moves/, "no card at all");

  M._setMovesModuleForTest({ forYouMoves: async () => snapshot() });
  const page = (await get("/dashboard/for-you")).body;
  assert.match(page, /id="fy-moves-h">Move</);
  assert.match(page, /data-fy-move="done" data-day="2026-10-30"/);
  const at = (re) => page.search(re);
  assert.ok(at(/id="fy-moves-h"/) > at(/id="fy-morning-h"/), "after Your morning");
  assert.ok(at(/id="fy-moves-h"/) < at(/id="fy-listen-h"/), "before Listen");
});

test("page: a failing Ramble hides only its own card, and the rest of the page renders", async () => {
  M._setMovesModuleForTest({ forYouMoves: async () => { throw new Error("no such column: moves"); } });
  const r = await get("/dashboard/for-you");
  assert.equal(r.status, 200);
  assert.doesNotMatch(r.body, /fy-moves/);
  assert.match(r.body, /Your morning/);
  assert.match(r.body, /Install Media Hub/, "Listen still renders");
});

test("page: the Move switch turns the card off and on again, like every other section", async () => {
  M._setMovesModuleForTest({ forYouMoves: async () => snapshot() });
  assert.equal((await save({ city: "", section_morning: "1" })).status, 303);
  const off = await get("/dashboard/for-you");
  assert.doesNotMatch(off.body, /fy-moves/);
  assert.match(off.body, /Your morning/);

  const cz = await get("/dashboard/for-you?view=customize");
  assert.match(cz.body, /<span>Move<\/span><input type="checkbox" name="section_moves" value="1">/);

  await save({ city: "", section_moves: "1" });
  assert.match((await get("/dashboard/for-you")).body, /id="fy-moves-h">Move</);
  assert.match((await get("/dashboard/for-you?view=customize")).body, /<input type="checkbox" name="section_moves" value="1" checked>/);
});

test("page: a non-owner session still gets 404 for the page (and never the card)", async () => {
  M._setMovesModuleForTest({ forYouMoves: async () => snapshot() });
  for (const sess of ["moves-plain"]) {
    const r = await get("/dashboard/for-you", sess);
    assert.equal(r.status, 404, sess);
    assert.doesNotMatch(r.body, /fy-moves|data-fy-move/, sess);
    assert.equal((await get("/dashboard/for-you?view=customize", sess)).status, 404, sess);
  }
});