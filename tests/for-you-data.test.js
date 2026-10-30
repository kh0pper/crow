/**
 * For You v1, the data under the page:
 *   - the morning card (for-you/morning.js) from a scratch crow.db (init-db) and a scratch tasks.db
 *     (migrations 0001-0004): the Board's Needs-you lane, cards due by today (not done), results
 *     bots reported in the last day, and "where you left off" from perch/briefing.js;
 *   - the news "why" words (for-you/news.js) for each kind of Media Hub evidence, and the news
 *     states (no Media Hub, an old Media Hub, a working one);
 *   - the weather (for-you/weather.js) over a fake fetch: fixed https hosts only, a timeout,
 *     the cache, and no chip on any failure.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const dir = mkdtempSync(join(tmpdir(), "for-you-data-"));
process.env.CROW_DATA_DIR = dir;
const HOME = join(dir, "home");
process.env.CROW_HOME = HOME;
mkdirSync(HOME, { recursive: true });
delete process.env.CROW_DB_PATH;
delete process.env.CROW_SESSION_BRIEFING;
const TASKS = join(dir, "tasks.db");
process.env.CROW_TASKS_DB_PATH = TASKS;
const DB_FILE = join(dir, "crow.db");
writeFileSync(join(dir, "instance-id"), "instance-for-you-data");
const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

const P = {}, C = {};
let createDbClient, M, N, W, H;

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env }, stdio: "pipe", cwd: REPO });
  const c = new Database(DB_FILE);
  const proj = c.prepare("INSERT INTO project_spaces (slug, name, type, status) VALUES (?,?, 'general', 'active')");
  P.garden = Number(proj.run("garden", "Garden").lastInsertRowid);
  P.other = Number(proj.run("other", "Other").lastInsertRowid);
  const PERCH = JSON.stringify({ gateways: [{ type: "perch" }], models: { default: "crow-chat/example-7b" } });
  c.prepare("INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES (?,?,?,1,?)").run("ivy", "Ivy", PERCH, P.garden);
  c.prepare(`INSERT INTO bot_sessions (bot_id, kind, status, gateway_thread_id, label, summary, summary_at, created_at, updated_at)
    VALUES ('ivy', 'perch-live', 'active', 'perchlive-00000001', 'Seed order', 'A model-written summary that must not show.', datetime('now','-3 hours'), datetime('now','-4 hours'), datetime('now','-3 hours'))`).run();
  c.prepare("INSERT INTO shell_items (item_kind, item_ref, project_id, set_by) VALUES ('perch_thread', 'perchlive-00000001', ?, 'origin')").run(P.garden);
  c.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, sha TEXT)");
  for (const id of ["0001-board-stages", "0002-board-defs", "0003-tracker-convergence"]) {
    c.prepare("INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, datetime('now'))").run(id);
  }
  c.close();

  const tk = new Database(TASKS);
  tk.exec(`CREATE TABLE IF NOT EXISTS tasks_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT,
    status TEXT NOT NULL DEFAULT 'pending', priority INTEGER DEFAULT 3, due_date TEXT, phase TEXT, owner TEXT, tags TEXT,
    parent_id INTEGER, project_id INTEGER, assigned_bot TEXT, board_id INTEGER, bot_id TEXT,
    action_needed TEXT, next_followup_date TEXT, processing_lease TEXT, processing_lease_status TEXT,
    autonomy TEXT NOT NULL DEFAULT 'gated', archived_at TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT, data_json TEXT NOT NULL DEFAULT '{}');
  CREATE TABLE board_defs (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE,
    project_id INTEGER UNIQUE, display_name TEXT NOT NULL, status_values TEXT NOT NULL,
    terminal_values TEXT NOT NULL, fields_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  tk.close();
  const migDir = join(dir, "migrations");
  mkdirSync(migDir);
  for (const f of ["0001-board-stages.mjs", "0002-board-defs.mjs", "0003-tracker-convergence.mjs", "0004-track1-card-model.mjs"]) {
    symlinkSync(join(REPO, "scripts", "migrations", f), join(migDir, f));
  }
  const { runMigrations } = await import("../scripts/migrations/runner.mjs");
  await runMigrations({ migrationsDir: migDir, dbPath: DB_FILE, tasksDbPath: TASKS, sha: "test", log: () => {} });

  ({ createDbClient } = await import("../servers/db.js"));
  M = await import("../servers/gateway/for-you/morning.js");
  N = await import("../servers/gateway/for-you/news.js");
  W = await import("../servers/gateway/for-you/weather.js");
  H = await import("../servers/gateway/dashboard/panels/for-you/html.js");
});

after(() => { rmSync(dir, { recursive: true, force: true }); });

const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
const PROJECTS = () => [{ id: P.garden, slug: "garden", name: "Garden" }, { id: P.other, slug: "other", name: "Other" }];
async function withDb(fn) { const db = createDbClient(); try { return await fn(db); } finally { db.close(); } }

test("morning: needs you, due by today, finished by bots in the last day, and where you left off; every line linked", async () => {
  const now = Date.now();
  const tw = new Database(TASKS);
  const add = tw.prepare("INSERT INTO tasks_items (title, project_id, status, action_needed, due_date) VALUES (?,?,?,?,?)");
  C.ask = Number(add.run("Choose a mulch", P.garden, "pending", "Pick one", null).lastInsertRowid);
  C.today = Number(add.run("Water plan", P.garden, "pending", null, ymd(now)).lastInsertRowid);
  C.late = Number(add.run("Old chore", P.garden, "pending", null, ymd(now - 3 * 86400000)).lastInsertRowid);
  C.doneDue = Number(add.run("Done and due", P.garden, "done", null, ymd(now)).lastInsertRowid);
  C.later = Number(add.run("Next week", P.garden, "pending", null, ymd(now + 7 * 86400000)).lastInsertRowid);
  C.soil = Number(add.run("Soil test", P.other, "pending", null, null).lastInsertRowid);
  C.human = Number(add.run("Hand job", P.other, "pending", null, null).lastInsertRowid);
  C.stale = Number(add.run("Yesterday's news", P.other, "pending", null, null).lastInsertRowid);
  const res = tw.prepare("INSERT INTO board_results (item_id, actor_kind, actor_id, outcome, status, created_at) VALUES (?,?,?,?, 'approved', datetime('now', ?))");
  res.run(C.soil, "bot", "ivy", "success", "-2 hours");
  res.run(C.human, "human", null, "success", "-1 hours");
  res.run(C.stale, "bot", "ivy", "success", "-30 hours");
  tw.close();

  const m = await withDb((db) => M.loadMorning(db, { projects: PROJECTS(), tz: "UTC", now, tasksDbPath: TASKS }));
  // Garden's cards open on its card-board bot's board (Ivy); Other has none, so the plain card view.
  assert.equal(m.needs.total, 1);
  assert.deepEqual(m.needs.items, [{ title: "Choose a mulch", project: "Garden", kind: "question", href: `/dashboard/bot-board?bot=ivy#open=${C.ask}` }]);
  assert.equal(m.due.total, 2, "today and overdue, never a done card or a later one");
  assert.deepEqual(m.due.items.map((d) => [d.title, d.overdue, d.href]), [
    ["Old chore", true, `/dashboard/bot-board?bot=ivy#open=${C.late}`],
    ["Water plan", false, `/dashboard/bot-board?bot=ivy#open=${C.today}`],
  ]);
  assert.equal(m.finished.total, 1, "a bot's result in the last day; never a person's, never an older one");
  assert.deepEqual(m.finished.items, [{ title: "Soil test", project: "Other", outcome: "success", bot: "Ivy", href: `/dashboard/bot-board?card=${C.soil}` }]);
  assert.deepEqual(m.leftOff, { title: "Seed order", project: "Garden", href: "/dashboard/perch?project=garden#perchlive-00000001" });
  assert.ok(!JSON.stringify(m).includes("model-written"), "the session's summary text is never shown");

  assert.equal(H.morningSentence(m, "en"), "1 card needs you, 2 cards are due by today, and your bots finished 1 thing since yesterday.");
  assert.equal(H.morningSentence(m, "es"), "1 tarjeta te necesita, 2 tarjetas vencen hoy o antes y tus bots terminaron 1 cosa desde ayer.");
  const html = H.morningHtml(m, "en");
  for (const href of [`/dashboard/bot-board?bot=ivy#open=${C.ask}`, `/dashboard/bot-board?card=${C.soil}`, "/dashboard/perch?project=garden#perchlive-00000001"]) {
    assert.ok(html.includes(`href="${href}"`), href);
  }
  assert.match(html, /Finished by Ivy/);
  assert.match(html, /Overdue/);

  // The briefing's off switch turns "where you left off" off too.
  process.env.CROW_SESSION_BRIEFING = "0";
  try {
    assert.equal((await withDb((db) => M.loadMorning(db, { projects: PROJECTS(), tz: "UTC", now, tasksDbPath: TASKS }))).leftOff, null);
  } finally { delete process.env.CROW_SESSION_BRIEFING; }
});

test("morning: 250 done past-due cards never crowd out the one that is really overdue", async () => {
  const now = Date.now();
  const path = join(dir, "tasks-mature.db");
  const src = new Database(TASKS);
  src.exec(`VACUUM INTO '${path}'`);
  src.close();
  const tw = new Database(path);
  tw.exec("DELETE FROM tasks_items; DELETE FROM board_results;");
  const add = tw.prepare("INSERT INTO tasks_items (title, project_id, status, due_date) VALUES (?,?,?,?)");
  // Older due dates than the open card's, so a scan ordered by due date meets them first.
  tw.transaction(() => { for (let i = 0; i < 250; i++) add.run(`Done ${i}`, i % 2 ? P.garden : null, "done", ymd(now - (20 + i) * 86400000)); })();
  const open = Number(add.run("Still open", P.other, "pending", ymd(now - 2 * 86400000)).lastInsertRowid);
  tw.close();
  const m = await withDb((db) => M.loadMorning(db, { projects: PROJECTS(), tz: "UTC", now, tasksDbPath: path }));
  assert.equal(m.due.total, 1);
  assert.deepEqual(m.due.items.map((d) => [d.title, d.overdue, d.href]), [["Still open", true, `/dashboard/bot-board?card=${open}`]]);
});

test("morning: no tasks.db is an empty morning, never an error", async () => {
  const m = await withDb((db) => M.loadMorning(db, { projects: PROJECTS(), tz: "UTC", tasksDbPath: join(dir, "absent.db") }));
  assert.deepEqual([m.needs.total, m.due.total, m.finished.total], [0, 0, 0]);
  assert.equal(H.morningSentence({ ...m, leftOff: null }, "en"), "Nothing needs you this morning.");
});

test("news why: each kind of Media Hub evidence has its own words, and nothing else is ever claimed", () => {
  assert.equal(N.whyText({ kind: "topic", label: "local ai", affinity: 0.8 }, "en"), "You like stories about local ai");
  assert.equal(N.whyText({ kind: "source", label: "Example Wire" }, "en"), "You often like stories from Example Wire");
  assert.equal(N.whyText({ kind: "category", label: "science" }, "en"), "You follow science news");
  assert.equal(N.whyText({ kind: "popular" }, "en"), "Popular right now");
  assert.equal(N.whyText({ kind: "new" }, "en"), "New from a source you follow");
  assert.equal(N.whyText({ kind: "topic", label: "  " }, "en"), "New from a source you follow", "a liked kind with no label falls back");
  assert.equal(N.whyText({ kind: "invented", label: "x" }, "en"), "New from a source you follow");
  assert.equal(N.whyText(null, "en"), "New from a source you follow");
  assert.equal(N.whyText({ kind: "topic", label: "ciencia" }, "es"), "Te gustan las noticias sobre ciencia");
  const now = Date.parse("2026-10-29T12:00:00Z");
  assert.equal(N.ageText("2026-10-29T10:00:00Z", "en", now), "2h");
  assert.equal(N.ageText("2026-10-29 11:30:00", "en", now), "30m");
  assert.equal(N.ageText("2026-10-26T12:00:00Z", "en", now), "3d");
  assert.equal(N.ageText("2026-10-30T12:00:00Z", "en", now), "", "a future date has no age");
});

test("news states: no Media Hub offers the install, an old copy asks for an update, a working one lists its picks", async () => {
  writeFileSync(join(HOME, "installed.json"), "[]");
  assert.equal((await withDb((db) => N.loadNews(db, { crowHome: HOME }))).state, "missing");
  const html = H.newsHtml({ state: "missing", stories: [], hidden: [] }, "en");
  assert.match(html, /href="\/dashboard\/extensions\?q=media"[^>]*>Install Media Hub</);
  writeFileSync(join(HOME, "installed.json"), JSON.stringify([{ id: "media" }]));
  assert.equal((await withDb((db) => N.loadNews(db, { crowHome: HOME }))).state, "update", "the installed copy has no server/for-you.js");
  N._setNewsModuleForTest({
    forYouStories: async (db, { limit }) => [{ id: 7, title: "A <b>story</b>", url: "https://news.example.invalid/7", summary: "Short.", sourceId: 3, sourceName: "Example Wire", publishedAt: new Date().toISOString(), why: { kind: "source", label: "Example Wire" }, limit }],
    hiddenSources: async () => [{ id: 4, name: "Loud" }],
  });
  try {
    const news = await withDb((db) => N.loadNews(db, { crowHome: HOME }));
    assert.equal(news.state, "ok");
    assert.equal(news.stories.length, 1);
    assert.equal(news.stories[0].limit, N.NEWS_MAX);
    assert.deepEqual(news.hidden, [{ id: 4, name: "Loud" }]);
    const out = H.newsHtml(news, "en");
    assert.match(out, /A &lt;b&gt;story&lt;\/b&gt;/, "the headline is escaped");
    assert.match(out, /href="https:\/\/news\.example\.invalid\/7" target="_blank" rel="noopener noreferrer"/);
    assert.match(out, /Example Wire · 1m · You often like stories from Example Wire/);
    assert.match(out, /Read at Example Wire/);
    assert.match(out, /data-fy-act="hide" data-article="7" data-source="3"/);
    assert.match(out, /1 story, picked for you/);
    assert.match(H.newsHtml({ state: "ok", stories: [], hidden: [] }, "en"), /Nothing good in your news right now/);
  } finally { N._setNewsModuleForTest(null); }
});

// ---- weather -----------------------------------------------------------------

const GEO_BODY = { results: [{ name: "Exampleton", admin1: "State", country: "United States", country_code: "US", latitude: 39.8, longitude: -89.6 }] };
const FC_BODY = { current: { temperature_2m: 71.6, weather_code: 2 }, daily: { temperature_2m_max: [80.2], temperature_2m_min: [60.6], precipitation_probability_max: [10] } };
function fakeFetch(bodies, calls) {
  return async (url, opts) => {
    calls.push({ url: new URL(url), opts });
    const u = new URL(url);
    const body = u.hostname === W.GEO_HOST ? bodies.geo : bodies.fc;
    if (body instanceof Error) throw body;
    return { ok: true, status: 200, json: async () => body };
  };
}

beforeEach(() => W.clearWeatherCache());

test("weather: the geocoder and the forecast are fetched from the two fixed https hosts only, whatever the city says", async () => {
  const calls = [];
  const f = fakeFetch({ geo: GEO_BODY, fc: FC_BODY }, calls);
  const place = await W.geocodeCity("evil.example.invalid/@x?y#z", { fetchImpl: f });
  assert.deepEqual(place, { name: "Exampleton", admin1: "State", country: "United States", lat: 39.8, lon: -89.6, unit: "fahrenheit" });
  const wx = await W.weatherFor(place, { fetchImpl: f });
  assert.deepEqual(wx, { temp: 72, code: 2, high: 80, low: 61, rain: 10, unit: "fahrenheit" });
  assert.deepEqual(calls.map((c) => c.url.protocol + "//" + c.url.hostname + c.url.pathname),
    [`https://${W.GEO_HOST}/v1/search`, `https://${W.FORECAST_HOST}/v1/forecast`]);
  assert.equal(calls[0].url.searchParams.get("name"), "evil.example.invalid/@x?y#z", "the city is only ever a query value");
  assert.equal(calls[1].url.searchParams.get("temperature_unit"), "fahrenheit");
  for (const c of calls) {
    assert.ok(c.opts.signal instanceof AbortSignal, "every fetch carries a timeout signal");
    assert.equal(c.opts.redirect, "error", "a redirect off the fixed host is refused");
  }
  assert.equal(await W.geocodeCity("   ", { fetchImpl: f }), null);
  assert.equal(await W.geocodeCity("Nowhere", { fetchImpl: fakeFetch({ geo: { results: [] } }, []) }), null);
  const eu = await W.geocodeCity("Exampleville", { fetchImpl: fakeFetch({ geo: { results: [{ name: "Exampleville", country_code: "FR", latitude: 45.7, longitude: 4.8 }] } }, []) });
  assert.equal(eu.unit, "celsius");
});

test("weather: a slow host times out and means no chip; the failure is remembered for a while", async () => {
  let n = 0;
  const hang = (url, { signal }) => { n++; return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))); };
  const place = { lat: 1, lon: 2, unit: "celsius" };
  const t0 = Date.now();
  assert.equal(await W.weatherFor(place, { fetchImpl: hang }), null);
  const took = Date.now() - t0;
  assert.ok(took >= W.FETCH_TIMEOUT_MS - 100 && took < W.FETCH_TIMEOUT_MS + 2000, `timed out after ${took} ms`);
  assert.equal(await W.weatherFor(place, { fetchImpl: hang }), null);
  assert.equal(n, 1, "a recent failure is not retried on every page load");
});

test("weather: cached for half an hour; a stale value is served at once while it refreshes; bad data is no chip", async () => {
  const calls = [];
  let clock = 1_000_000;
  const now = () => clock;
  const place = { lat: 10, lon: 20, unit: "celsius" };
  const f = fakeFetch({ fc: FC_BODY }, calls);
  assert.equal((await W.weatherFor(place, { fetchImpl: f, now })).temp, 72);
  clock += W.CACHE_MS - 1000;
  await W.weatherFor(place, { fetchImpl: f, now });
  assert.equal(calls.length, 1, "within the half hour: no fetch");
  clock += 2000;
  const warm = { ...FC_BODY, current: { temperature_2m: 90, weather_code: 0 } };
  const stale = await W.weatherFor(place, { fetchImpl: fakeFetch({ fc: warm }, calls), now });
  assert.equal(stale.temp, 72, "the stale value, at once");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await W.weatherFor(place, { fetchImpl: f, now })).temp, 90, "then the refreshed one");
  assert.equal(await W.weatherFor({ lat: 5, lon: 5, unit: "celsius" }, { fetchImpl: fakeFetch({ fc: { current: {} } }, []) }), null);
  assert.equal(await W.weatherFor(null), null, "no place: no chip and no fetch");
});

test("weather words and the chip: the WMO code's words, the attribution, and nothing at all without weather", () => {
  assert.deepEqual([0, 2, 3, 45, 53, 63, 81, 73, 95, 7].map(W.weatherKind), ["clear", "partly", "cloudy", "fog", "drizzle", "rain", "rain", "snow", "storm", null]);
  const { chip, detail } = H.weatherHtml({ temp: 72, code: 2, high: 80, low: 61, rain: 10 }, "en");
  assert.match(chip, />72° · Partly cloudy</);
  assert.match(detail, /High 80° · Low 61° · 10% chance of rain/);
  assert.match(detail, /Weather: Open-Meteo/);
  assert.deepEqual(H.weatherHtml(null, "en"), { chip: "", detail: "" });
});
