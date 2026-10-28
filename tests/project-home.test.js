/**
 * R1.2 PR 1, Task 3: the project home, /dashboard/project/<slug>.
 *
 * The REAL dashboard router (dashboardAuth, csrfMiddleware, the panel
 * dispatch) is mounted over a scratch CROW_DATA_DIR and a scratch tasks.db
 * brought through migrations 0001–0004, so every page test goes through the
 * same route, scope rule and layout production uses. The data rules (lead,
 * sessions' filing, relative day) are also checked on data.js directly.
 * Requests carry Serve's headers so isAllowedNetwork admits them.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { actAsServe, serveHeaders } from "./fixtures/serve-peer.mjs";
actAsServe(); // this process's HTTP client stands in for tailscaled (the Serve socket owner)

const dir = mkdtempSync(join(tmpdir(), "project-home-"));
process.env.CROW_DATA_DIR = dir;
const HOME = join(dir, "home");
process.env.CROW_HOME = HOME;
mkdirSync(HOME, { recursive: true });
delete process.env.CROW_DB_PATH;
const TASKS = join(dir, "tasks.db");
process.env.CROW_TASKS_DB_PATH = TASKS;
const DB_FILE = join(dir, "crow.db");
writeFileSync(join(dir, "instance-id"), "instance-project-home");
process.env.PIBOT_PI_CLI = "/nonexistent/pi-never-spawned-by-this-file.js";
const REPO = new URL("..", import.meta.url).pathname;

const MODEL_KEY = "crow-chat/example-model-7b";
const P = {};
let server, base, MODE, SCOPE, data, i18n;

const perch = (models) => JSON.stringify({ gateways: [{ type: "perch" }], models: { default: models } });

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env }, stdio: "pipe", cwd: REPO });
  const { hashToken } = await import("../servers/gateway/dashboard/auth.js");
  const c = new Database(DB_FILE);
  const proj = c.prepare("INSERT INTO project_spaces (slug, name, type, status, archived_at, tasks_db_uri) VALUES (?,?,?,?,?,?)");
  P.garden = Number(proj.run("garden", "Garden", "general", "active", null, null).lastInsertRowid);
  P.kitchen = Number(proj.run("kitchen", "Kitchen", "general", "active", null, "file:" + join(dir, "other.db")).lastInsertRowid);
  P.attic = Number(proj.run("attic", "Attic", "general", "archived", "2026-01-01 00:00:00", null).lastInsertRowid);
  P.solo = Number(proj.run("solo", "Solo", "general", "active", null, null).lastInsertRowid);
  P.named = Number(proj.run("named", "Named", "general", "active", null, null).lastInsertRowid);
  P.empty = Number(proj.run("empty", "Empty", "general", "active", null, null).lastInsertRowid);
  c.prepare("INSERT INTO oauth_tokens (token, token_type, client_id, expires_at, created_at) VALUES (?, 'access', 'dashboard', datetime('now','+1 day'), ?)")
    .run(hashToken("new-sess"), "2026-06-01 00:00:00");

  // Bots. Garden: two attachable (Ivy is the coordinator), plus one without a
  // perch gateway and the voice bot, neither of which Perch can attach.
  const bot = c.prepare("INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES (?,?,?,1,?)");
  bot.run("hank", "Hank", perch(MODEL_KEY), P.garden);
  bot.run("ivy", "Ivy", perch("role:coordinator"), P.garden);
  bot.run("quiet", "Aaron", JSON.stringify({ gateways: [], models: { default: MODEL_KEY } }), P.garden);
  bot.run("crow.voice", "Crow", perch(MODEL_KEY), P.garden);
  bot.run("sol", "Sol", perch(MODEL_KEY), P.solo);
  bot.run("zed", "Zed", perch(MODEL_KEY), P.named);
  bot.run("amy", "Amy", perch(MODEL_KEY), P.named);

  // Perch sessions. The filing (shell_items) decides the project, never the
  // bot's home project or bot_sessions.project_id.
  const sess = c.prepare("INSERT INTO bot_sessions (bot_id, kind, status, gateway_thread_id, label, archived_at, project_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)");
  const file = c.prepare("INSERT INTO shell_items (item_kind, item_ref, project_id, set_by) VALUES ('perch_thread', ?, ?, 'origin')");
  sess.run("ivy", "perch-live", "active", "perchlive-aaaaaaaa", "Seed order", null, P.garden, "2026-10-01 09:00:00", "2026-10-02 09:00:00");
  sess.run("hank", "perch-live", "stopped", "perchlive-bbbbbbbb", null, null, P.garden, "2026-10-01 08:00:00", "2026-10-01 08:00:00");
  sess.run("hank", "perch-live", "active", "perchlive-cccccccc", "Archived one", "2026-10-03 00:00:00", P.garden, "2026-10-03 00:00:00", "2026-10-03 00:00:00");
  sess.run("ivy", "perch-live", "active", "perchlive-dddddddd", "Filed elsewhere", null, P.garden, "2026-10-04 00:00:00", "2026-10-04 00:00:00");
  sess.run("ivy", "perch-live", "active", "perchlive-eeeeeeee", "Never filed", null, P.garden, "2026-10-05 00:00:00", "2026-10-05 00:00:00");
  sess.run("ivy", "chat", "active", "perchlive-ffffffff", "A chat row", null, P.garden, "2026-10-06 00:00:00", "2026-10-06 00:00:00");
  file.run("perchlive-aaaaaaaa", P.garden);
  file.run("perchlive-bbbbbbbb", P.garden);
  file.run("perchlive-cccccccc", P.garden);
  file.run("perchlive-dddddddd", P.kitchen);
  file.run("perchlive-ffffffff", P.garden);
  c.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, sha TEXT)");
  for (const id of ["0001-board-stages", "0002-board-defs", "0003-tracker-convergence"]) {
    c.prepare("INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, datetime('now'))").run(id);
  }
  c.close();

  const tk = new Database(TASKS);
  tk.exec(`CREATE TABLE IF NOT EXISTS tasks_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL, description TEXT,
    status TEXT NOT NULL DEFAULT 'pending', priority INTEGER DEFAULT 3,
    due_date TEXT, phase TEXT, owner TEXT, tags TEXT,
    parent_id INTEGER, project_id INTEGER,
    assigned_bot TEXT, board_id INTEGER, bot_id TEXT,
    action_needed TEXT, next_followup_date TEXT,
    processing_lease TEXT, processing_lease_status TEXT,
    autonomy TEXT NOT NULL DEFAULT 'gated', archived_at TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT, data_json TEXT NOT NULL DEFAULT '{}'
  );
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

  // Garden's cards: four need you (a decision, a review, two questions), one is up next.
  const tw = new Database(TASKS);
  const add = tw.prepare("INSERT INTO tasks_items (title, project_id, status, priority, action_needed, data_json) VALUES (?,?,?,?,?,?)");
  add.run("Pick the seed mix", P.garden, "pending", 1, null, JSON.stringify({ decision: { question: "Which mix?", options: ["a", "b"] } }));
  const review = Number(add.run("Soil test results", P.garden, "pending", 2, null, "{}").lastInsertRowid);
  add.run("Where does the hose go?", P.garden, "pending", 3, "Front or back?", "{}");
  add.run("Order more mulch?", P.garden, "pending", 4, "How many bags?", "{}");
  add.run("Rake the leaves", P.garden, "pending", 5, null, "{}");
  tw.prepare("INSERT INTO board_results (item_id, actor_kind, outcome, status) VALUES (?, 'bot', 'success', 'recorded')").run(review);
  tw.close();

  const { createDbClient } = await import("../servers/db.js");
  const { writeSetting } = await import("../servers/gateway/dashboard/settings/registry.js");
  const db = createDbClient();
  await writeSetting(db, "shell_since", "2026-01-01 00:00:00");
  db.close();

  const mode = await import("../servers/gateway/dashboard/shell/mode.js");
  MODE = mode.cookieName(mode.MODE_COOKIE);
  SCOPE = mode.cookieName(mode.SCOPE_COOKIE);
  data = await import("../servers/gateway/dashboard/panels/project-home/data.js");
  i18n = await import("../servers/gateway/dashboard/shared/i18n.js");

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
  server?.closeAllConnections?.();
  server?.close();
  rmSync(dir, { recursive: true, force: true });
});

const NET = serveHeaders("operator@example.com");
const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ");
async function get(path, jar) {
  const r = await fetch(base + path, { redirect: "manual", headers: { ...NET, cookie: cookieHeader(jar) } });
  return { status: r.status, location: r.headers.get("location"), cookies: r.headers.getSetCookie(), body: await r.text() };
}
const jarNew = (extra = {}) => ({ crow_session: "new-sess", crow_csrf: "tok", [MODE]: "new", ...extra });
const scopeCookies = (cookies) => cookies.filter((c) => c.startsWith(SCOPE + "=") || /^crow_scope/.test(c));
/** The page's visible text: tags and their attributes removed. */
const textOf = (html) => html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]*>/g, " ");
const section = (html, cls) => (html.match(new RegExp(`<section class="ph-section ${cls}">([\\s\\S]*?)</section>`)) || [])[1] || "";

test("the home renders start, needs-you and earlier sessions for the slug", async () => {
  const r = await get("/dashboard/project/garden", jarNew());
  assert.equal(r.status, 200);
  assert.match(r.body, /<body class="shell/);
  assert.equal((r.body.match(/class="shell-scope-name">([^<]*)</) || [])[1], "Garden", "the chip names the project");

  const start = section(r.body, "ph-start");
  assert.match(start, /data-ph-start data-bot="ivy">Start a session</, "Start a session, with the coordinator as lead");
  assert.match(start, /with <strong data-ph-lead-name>Ivy<\/strong>/);
  assert.match(start, /data-ph-change[^>]*>change</);
  const options = [...start.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(options, ["hank", "ivy"], "the project's attachable bots only, by name (no voice bot, no bot without Perch)");

  const needs = section(r.body, "ph-needs");
  const rows = [...needs.matchAll(/<span class="ph-kind ph-kind--(\w+)">([^<]+)<\/span><span class="ph-row-title">([^<]+)</g)].map((m) => [m[1], m[2], m[3]]);
  assert.deepEqual(rows, [
    ["decision", "Decision", "Pick the seed mix"],
    ["review", "Review", "Soil test results"],
    ["question", "Question", "Where does the hose go?"],
  ], "three rows, in the Board's order, each with its kind");
  assert.match(needs, /4 need you/);
  // Each row opens its card's drawer by the one card-link rule (the project's card-board bot).
  const { drawerHrefs } = await import("../servers/gateway/board/card-link.js");
  const { createDbClient } = await import("../servers/db.js");
  const db = createDbClient();
  try {
    const hrefs = await drawerHrefs(db, [1, 2, 3]);
    for (const id of [1, 2, 3]) assert.ok(needs.includes(`href="${hrefs.get(id)}"`), `card ${id} links to ${hrefs.get(id)}`);
  } finally { db.close(); }
  assert.match(needs, /href="\/dashboard\/board\?project=garden">All on Board</);

  const earlier = section(r.body, "ph-earlier");
  const sessions = [...earlier.matchAll(/href="\/dashboard\/perch#([^"]+)"><span class="ph-row-title">([^<]+)<\/span><span class="ph-meta">([^<]+)</g)].map((m) => [m[1], m[2], m[3].split(" · ")[0]]);
  assert.deepEqual(sessions, [
    ["perchlive-aaaaaaaa", "Seed order", "Ivy"],
    ["perchlive-bbbbbbbb", "Untitled session", "Hank"],
  ], "newest first; a stopped session is listed; an unlabelled one is Untitled");

  // The drawer marks this project's link as the current page; the tabs follow the project.
  assert.match(r.body, /<a href="\/dashboard\/project\/garden" class="shell-project is-current" aria-current="page">/);
  assert.match(r.body, /<a href="\/dashboard\/project\/garden" class="shell-tab" aria-current="page">/, "Chat's tab is this home, and current");
  assert.match(r.body, /<a href="\/dashboard\/board\?project=garden" class="shell-tab">[\s\S]*?<span>Board · 4<\/span>/, "Board · N from the count");
});

test("a project whose cards live elsewhere shows it can't count them; a project with none says so", async () => {
  const k = await get("/dashboard/project/kitchen", jarNew());
  assert.equal(k.status, 200);
  assert.match(section(k.body, "ph-needs"), /Can&#39;t count this project&#39;s cards here|Can't count this project's cards here/);
  const e = await get("/dashboard/project/empty", jarNew());
  assert.match(section(e.body, "ph-needs"), /Nothing needs you/);
  assert.match(section(e.body, "ph-start"), /This project has no bots yet/);
  assert.match(section(e.body, "ph-start"), /href="\/dashboard\/bot-builder"/);
  assert.match(section(e.body, "ph-earlier"), /No sessions yet/);
});

test("the lead rule: one bot; coordinator; by name; none", async () => {
  const { createDbClient } = await import("../servers/db.js");
  const db = createDbClient();
  try {
    const lead = async (id) => { const l = data.leadOf(await data.projectBots(db, id)); return l && l.id; };
    assert.equal(await lead(P.solo), "sol", "the only bot");
    assert.equal(await lead(P.garden), "ivy", "the coordinator, though Hank comes first by name");
    assert.equal(await lead(P.named), "amy", "else the first by display name");
    assert.equal(await lead(P.empty), null, "none");
    const solo = await get("/dashboard/project/solo", jarNew());
    assert.doesNotMatch(section(solo.body, "ph-start"), /data-ph-change|<select/, "one bot: nothing to change");
  } finally { db.close(); }
});

test("earlier sessions follow the shell_items filing", async () => {
  const { createDbClient } = await import("../servers/db.js");
  const db = createDbClient();
  try {
    const ids = (await data.earlierSessions(db, P.garden)).map((s) => s.threadId);
    // dddd is the garden bot's but filed under Kitchen; eeee is filed nowhere;
    // cccc is archived; ffff is not a perch-live session.
    assert.deepEqual(ids, ["perchlive-aaaaaaaa", "perchlive-bbbbbbbb"]);
    assert.deepEqual((await data.earlierSessions(db, P.kitchen)).map((s) => s.threadId), ["perchlive-dddddddd"]);
  } finally { db.close(); }
});

test("unknown slug 404s without a cookie", async () => {
  for (const slug of ["nope", "attic", "unassigned", "all", String(P.garden)]) {
    const r = await get("/dashboard/project/" + slug, jarNew());
    assert.equal(r.status, 404, slug);
    assert.match(r.body, /This project isn(&#39;|')t here/, slug);
    assert.match(r.body, /<button type="button" class="ph-start-btn" data-shell-open="shell-drawer"[^>]*>Back to projects</, slug);
    assert.deepEqual(scopeCookies(r.cookies), [], `no scope cookie for ${slug}`);
  }
  // /dashboard/project-home (the panel id, no slug) is no page either.
  assert.equal((await get("/dashboard/project-home", jarNew())).status, 404);
});

test("home GET is read-only", async () => {
  const counts = () => {
    const c = new Database(DB_FILE, { readonly: true });
    try {
      return Object.fromEntries(["shell_items", "dashboard_settings", "memories"].map((tb) => [tb, c.prepare(`SELECT COUNT(*) AS n FROM ${tb}`).get().n]));
    } finally { c.close(); }
  };
  const before = counts();
  // The path slug wins over the cookie, and ?project= neither moves nor rewrites it.
  const r = await get("/dashboard/project/garden?project=kitchen", jarNew({ [SCOPE]: "kitchen" }));
  assert.equal(r.status, 200);
  assert.equal((r.body.match(/class="shell-scope-name">([^<]*)</) || [])[1], "Garden");
  assert.deepEqual(scopeCookies(r.cookies), []);
  assert.deepEqual(r.cookies, [], "no cookie at all");
  await get("/dashboard/project/kitchen", jarNew());
  await get("/dashboard/project/nope", jarNew());
  assert.deepEqual(counts(), before);
});

test("classic mode redirects to /dashboard/projects", async () => {
  const r = await get("/dashboard/project/garden", jarNew({ [MODE]: "classic" }));
  assert.equal(r.status, 302);
  assert.equal(r.location, "/dashboard/projects");
});

test("no ids or model names in the page", async () => {
  const r = await get("/dashboard/project/garden", jarNew());
  const text = textOf(r.body);
  assert.doesNotMatch(text, /perchlive-[0-9a-f]{8}/, "no session id is shown");
  assert.doesNotMatch(r.body, new RegExp(MODEL_KEY.replace(/[/.]/g, "\\$&")), "the bot's model key is nowhere in the page");
  assert.doesNotMatch(r.body, /role:coordinator/);
  assert.doesNotMatch(text, /\b(stopped|active|hibernating)\b/i, "no session state");
});

test("the drawer marks the scoped project as current, but not as the page", async () => {
  const r = await get("/dashboard/memory", jarNew({ [SCOPE]: "garden" }));
  assert.equal(r.status, 200);
  assert.match(r.body, /<a href="\/dashboard\/project\/garden" class="shell-project is-current" aria-current="true">/);
  assert.doesNotMatch(r.body, /aria-current="page"><span class="shell-project-dot"/);
});

test("relative day: today, yesterday, a weekday, a date", () => {
  const now = new Date(2026, 9, 28, 15, 0, 0); // local time
  const at = (d) => d.toISOString();
  assert.deepEqual(data.relativeDay(at(new Date(2026, 9, 28, 1, 0)), { now }), { key: "shell.today" });
  assert.deepEqual(data.relativeDay(at(new Date(2026, 9, 27, 23, 0)), { now }), { key: "shell.yesterday" });
  assert.equal(data.relativeDay(at(new Date(2026, 9, 24, 12, 0)), { now }).text, "Saturday");
  assert.equal(data.relativeDay(at(new Date(2026, 9, 24, 12, 0)), { now, lang: "es" }).text, "sábado");
  assert.equal(data.relativeDay(at(new Date(2026, 9, 1, 12, 0)), { now }).text, "Oct 1");
  assert.equal(data.relativeDay(at(new Date(2025, 9, 1, 12, 0)), { now }).text, "Oct 1, 2025");
  assert.equal(data.relativeDay(null, { now }), null);
});

test("en and es strings exist for every new key", () => {
  const keys = ["startSession", "with", "changeLead", "leadPick", "noProjectBots", "makeBot", "allOnBoard", "nothingNeedsYou",
    "countUnknown", "kindDecision", "kindReview", "kindQuestion", "earlierSessions", "untitledSession", "noSessions",
    "today", "yesterday", "projectMissing", "backToProjects"].map((k) => "shell." + k);
  for (const k of keys) {
    const e = i18n.translations[k];
    assert.ok(e && e.en && e.es, k);
    assert.notEqual(e.en, e.es, `${k} is translated`);
  }
});
