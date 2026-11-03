/**
 * The "What needs me" widget API (widgets phase 1, Task 2): the summary and the one act endpoint,
 * through the REAL csrfMiddleware plus the router's own owner check, over a scratch crow.db
 * (init-db) and a scratch tasks.db (migrations 0001-0004), the way tests/widgets-needs-me.test.js
 * builds them. The hand-off core is a fake: the summary's hand-off source is its own store, and a
 * confirm is recorded instead of starting a bot.
 *
 *   - the summary is JSON for the owner's own local password session alone; an SSO session, one minted
 *     by a login from this machine itself, or a plain-scope session is 404 — and so is the act, with
 *     nothing decided;
 *   - an act answers a decision option (exactly once), accepts a result through decideResult, and
 *     confirms a hand-off through the core with "yes" on the phone;
 *   - a plan key is refused (no inline plan approval), an unknown action is refused too;
 *   - a nonce drawn before the item changed is 409 stale, and a decision answered on another device is
 *     never answered twice;
 *   - not_now hides the item for four hours in the LOCAL-scope setting and never touches the card;
 *   - an act without the CSRF token is 403 before anything is read.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { markFromLaptop } from "./helpers/off-box.js";

const dir = mkdtempSync(join(tmpdir(), "widgets-routes-"));
process.env.CROW_DATA_DIR = dir;
const HOME = join(dir, "home");
process.env.CROW_HOME = HOME;
mkdirSync(HOME, { recursive: true });
delete process.env.CROW_DB_PATH;
const TASKS = join(dir, "tasks.db");
process.env.CROW_TASKS_DB_PATH = TASKS;
const DB_FILE = join(dir, "crow.db");
writeFileSync(join(dir, "instance-id"), "instance-widgets-routes");
writeFileSync(join(HOME, "installed.json"), "[]");
const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

const NOW = Date.parse("2026-11-03T12:00:00Z");
const CLOCK = { t: NOW };

const OWN = "owner-sess";
const CSRF = "csrf-token-1";

const P = {};
let server, base, M, express;

// The fake hand-off core: rows the summary lists, and the confirms the act records.
const HANDOFFS = [];
const CONFIRMS = [];

const fakeCore = {
  async confirm(db, id, decision, via) {
    CONFIRMS.push({ id, decision, via });
    const at = HANDOFFS.findIndex((r) => r.id === id);
    if (at < 0) return { status: "none" };
    HANDOFFS.splice(at, 1);
    return { status: decision === "yes" ? "started" : "declined" };
  },
  store: {
    async openRows(db, { statuses } = {}) {
      return HANDOFFS.filter((r) => !statuses || statuses.includes(r.status)).map((r) => ({ ...r }));
    },
    async get(db, id) {
      const row = HANDOFFS.find((r) => r.id === id);
      return row ? { ...row } : null;
    },
  },
};

/** The session stub: the cookie names the session, and the peer-class memo makes it the laptop's. */
function stubAuth(req, res, next) {
  const m = /(?:^|;\s*)crow_session=([^;]+)/.exec(req.headers.cookie || "");
  if (m) { req.dashboardSession = m[1]; if (!req.headers["x-test-on-box"]) markFromLaptop(req); }
  if (req.headers["x-test-crosshost"]) req.crossHostAuth = true;
  return next();
}

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env }, stdio: "pipe", cwd: REPO });
  const c = new Database(DB_FILE);
  const proj = c.prepare("INSERT INTO project_spaces (slug, name, type, status) VALUES (?,?, 'general', 'active')");
  P.garden = Number(proj.run("garden", "Garden").lastInsertRowid);
  P.other = Number(proj.run("other", "Other").lastInsertRowid);
  c.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, sha TEXT)");
  for (const id of ["0001-board-stages", "0002-board-defs", "0003-tracker-convergence"]) {
    c.prepare("INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, datetime('now'))").run(id);
  }
  c.close();

  // The tasks store: the post-0003 shape, then the real migrations 0001-0004.
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

  // Sessions: the owner's own password login, plus the three that are never the owner's.
  const { hashToken } = await import("../servers/gateway/dashboard/auth.js");
  const s = new Database(DB_FILE);
  try {
    const tok = s.prepare("INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at, created_at) VALUES (?, 'access', 'dashboard', ?, datetime('now','+1 day'), '2026-06-01 00:00:00')");
    tok.run(hashToken(OWN), "dashboard");
    tok.run(hashToken("plain-sess"), "");
    tok.run(hashToken("sso-sess"), "dashboard sso src:instance-peer");
    tok.run(hashToken("onhost-sess"), "dashboard onhost");
  } finally { s.close(); }

  express = (await import("express")).default;
  M = await import("../servers/gateway/for-you/morning.js");
  const { widgetsRouter } = await import("../servers/gateway/routes/widgets.js");
  const { csrfMiddleware } = await import("../servers/gateway/dashboard/shared/csrf.js");

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false }));
  // The dashboard's own order: auth, then the CSRF double-submit check, then the widget router.
  app.use("/dashboard", stubAuth);
  app.use("/dashboard", csrfMiddleware);
  app.use(widgetsRouter(stubAuth, { core: fakeCore, now: () => CLOCK.t }));
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = "http://127.0.0.1:" + server.address().port;
});

after(() => {
  server?.closeAllConnections?.();
  server?.close();
  rmSync(dir, { recursive: true, force: true });
});

// ---- scratch-store helpers ---------------------------------------------------

function resetStores() {
  CLOCK.t = NOW;
  HANDOFFS.length = 0;
  CONFIRMS.length = 0;
  const tk = new Database(TASKS);
  try {
    tk.exec("DELETE FROM tasks_items; DELETE FROM board_results; DELETE FROM board_plans; DELETE FROM board_mutations;");
  } finally { tk.close(); }
  const c = new Database(DB_FILE);
  try {
    c.exec("DELETE FROM voice_handoffs; DELETE FROM messages; DELETE FROM contacts; DELETE FROM bot_jobs; DELETE FROM bot_sessions;");
    c.prepare("DELETE FROM dashboard_settings_overrides WHERE key = 'widgets_snoozed'").run();
    c.prepare("DELETE FROM dashboard_settings WHERE key = 'widgets_snoozed'").run();
  } finally { c.close(); }
  M._resetNeedsCacheForTest();
}

let cardClock = 1;
function addCard({ title, projectId = P.garden, status = "pending", priority = 3, actionNeeded = null, decision = null }) {
  const tk = new Database(TASKS);
  try {
    const data = decision ? JSON.stringify({ decision }) : "{}";
    const stamp = `2026-11-03 10:${String(cardClock++ % 60).padStart(2, "0")}:00`;
    return Number(tk.prepare(`INSERT INTO tasks_items (title, project_id, status, priority, action_needed, data_json, updated_at)
      VALUES (?,?,?,?,?,?,?)`).run(title, projectId, status, priority, actionNeeded, data, stamp).lastInsertRowid);
  } finally { tk.close(); }
}

function addResult(cardId, { status = "recorded", outcome = "success", actorKind = "bot" } = {}) {
  const tk = new Database(TASKS);
  try {
    return Number(tk.prepare("INSERT INTO board_results (item_id, actor_kind, actor_id, outcome, status) VALUES (?,?,?,?,?)")
      .run(cardId, actorKind, actorKind === "bot" ? "ivy" : null, outcome, status).lastInsertRowid);
  } finally { tk.close(); }
}

function addPlan(cardId, { version = 1, status = "draft", body = "1. do the thing" } = {}) {
  const tk = new Database(TASKS);
  try {
    tk.prepare("INSERT INTO board_plans (item_id, version, body_md, status, created_actor_kind) VALUES (?,?,?,?, 'bot')")
      .run(cardId, version, body, status);
  } finally { tk.close(); }
}

function addHandoff({ id, task, status = "awaiting_phone", expiresAt = NOW + 600000 }) {
  const row = {
    id, kind: "handoff", surface: "kiosk", device_id: "kiosk-1", bot_id: "ivy", task, status,
    created_at: NOW - 1000, expires_at: expiresAt, updated_at: NOW - 1000, lang: "en",
  };
  HANDOFFS.push(row);
  return row;
}

/** A decision payload the Board itself would accept (options, exactly one recommended, first). */
function decision(labels, { recommended = 0 } = {}) {
  return {
    question: "Which one?",
    context_md: "",
    fingerprint: "fp-1",
    batch: "batch-1",
    expires: "2999-01-01",
    options: labels.map((label, i) => ({ label, consequence: "a consequence", recommended: i === recommended })),
  };
}

function read(fn) {
  const tk = new Database(TASKS);
  try { return fn(tk); } finally { tk.close(); }
}

const taskRow = (id) => read((tk) => tk.prepare("SELECT * FROM tasks_items WHERE id=?").get(id));
const resultRow = (id) => read((tk) => tk.prepare("SELECT * FROM board_results WHERE id=?").get(id));
const planRow = (id) => read((tk) => tk.prepare("SELECT * FROM board_plans WHERE item_id=? ORDER BY id DESC").get(id));
const chosenOf = (id) => { try { return JSON.parse(taskRow(id).data_json).decision?.chosen ?? null; } catch { return null; } };
const mutationCount = (verb) => read((tk) => Number(tk.prepare("SELECT COUNT(*) AS n FROM board_mutations WHERE verb=?").get(verb)?.n || 0));

function setting(table, key) {
  const c = new Database(DB_FILE);
  try {
    const row = table === "local"
      ? c.prepare("SELECT value FROM dashboard_settings_overrides WHERE key=?").get(key)
      : c.prepare("SELECT value FROM dashboard_settings WHERE key=?").get(key);
    return row ? row.value : null;
  } finally { c.close(); }
}

// ---- the API -----------------------------------------------------------------

const jar = (session) => `crow_session=${session}; crow_csrf=${CSRF}`;

async function get(path, { session = OWN } = {}) {
  const r = await fetch(base + path, { headers: { cookie: jar(session) } });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, type: r.headers.get("content-type"), cache: r.headers.get("cache-control"), text, json };
}

const summary = (opts) => get("/dashboard/widgets-api/needs-me", opts);

async function act(body, { session = OWN, csrf = CSRF, extra = {} } = {}) {
  const r = await fetch(base + "/dashboard/widgets-api/needs-me/act", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: jar(session),
      ...(csrf ? { "x-crow-csrf": csrf } : {}),
      ...extra,
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, text, json };
}

beforeEach(() => resetStores());

// ---- the summary -------------------------------------------------------------

test("summary: JSON for the owner's own session; sso, onhost and plain-scope sessions get 404", async () => {
  addCard({ title: "Choose a mulch", decision: decision(["Mulch", "Compost"]) });

  const own = await summary();
  assert.equal(own.status, 200);
  assert.match(String(own.type), /application\/json/);
  assert.equal(own.cache, "no-store");
  assert.equal(own.json.id, "needs-me");
  assert.equal(own.json.title, "What needs me");
  assert.deepEqual(own.json.items.map((i) => i.kind), ["decision"]);
  assert.equal(own.json.items[0].project, "Garden");
  assert.deepEqual(own.json.lock, { count: 1, label: "1 waiting" });

  for (const session of ["sso-sess", "onhost-sess", "plain-sess"]) {
    const r = await summary({ session });
    assert.equal(r.status, 404, session);
    assert.equal(r.json?.items, undefined, `${session} is shown no items`);
  }
});

// ---- the act -----------------------------------------------------------------

test("act: the owner answers a decision option, and the card is decided exactly once", async () => {
  const card = addCard({ title: "Choose a mulch", decision: decision(["Mulch", "Compost"]) });
  const drawn = (await summary()).json.items[0];
  assert.deepEqual(drawn.actions.map((a) => a.id), ["option:0", "option:1"]);

  const r = await act({ key: drawn.key, action: "option:1", nonce: drawn.nonce });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.summary.items, [], "an answered card leaves the summary");

  assert.equal(chosenOf(card).index, 1);
  assert.equal(taskRow(card).status, "done", "answering closes the card");
  assert.equal(mutationCount("decision"), 1);

  // The same tap again, from a widget drawn before the answer: refused, and nothing decided twice.
  const again = await act({ key: drawn.key, action: "option:1", nonce: drawn.nonce });
  assert.equal(again.status, 409);
  assert.equal(again.json.code, "stale");
  assert.equal(chosenOf(card).index, 1, "the one answer stands");
  assert.equal(mutationCount("decision"), 1);
});

test("act: accept approves the result through decideResult and never moves the card", async () => {
  const card = addCard({ title: "Soil test" });
  const result = addResult(card);
  const drawn = (await summary()).json.items[0];
  assert.equal(drawn.kind, "result");
  assert.deepEqual(drawn.actions.map((a) => a.id), ["accept", "not_now"]);

  const r = await act({ key: drawn.key, action: "accept", nonce: drawn.nonce });
  assert.equal(r.status, 200);
  const decided = resultRow(result);
  assert.equal(decided.status, "approved");
  assert.equal(decided.decided_via, "widget");
  assert.equal(taskRow(card).status, "pending", "decideResult never moves the card");
  assert.equal(mutationCount("result_decide"), 1);
  assert.deepEqual(r.json.summary.items, [], "the approved result is no longer waiting");
});

test('act: hand-off yes confirms through the core with "yes" on the phone, and no declines', async () => {
  const yes = addHandoff({ id: "vh-0123456789abcdef", task: "Water the beds" });
  const no = addHandoff({ id: "vh-fedcba9876543210", task: "Book the van" });
  const items = (await summary()).json.items;
  const itemYes = items.find((i) => i.key === `handoff:${yes.id}`);
  const itemNo = items.find((i) => i.key === `handoff:${no.id}`);
  assert.deepEqual(itemYes.actions.map((a) => a.id), ["yes", "no"]);

  const r = await act({ key: itemYes.key, action: "yes", nonce: itemYes.nonce });
  assert.equal(r.status, 200);
  assert.deepEqual(CONFIRMS, [{ id: yes.id, decision: "yes", via: "phone" }]);
  assert.equal(r.json.summary.items.some((i) => i.key === itemYes.key), false, "no longer waiting on the phone");

  const declined = await act({ key: itemNo.key, action: "no", nonce: itemNo.nonce });
  assert.equal(declined.status, 200);
  assert.deepEqual(CONFIRMS.at(-1), { id: no.id, decision: "no", via: "phone" });
});

test("act: a plan key never approves inline — 400 bad_action, and the plan is untouched", async () => {
  const card = addCard({ title: "Approve the rebuild plan", actionNeeded: "Approve the plan" });
  addPlan(card, { version: 2, status: "draft" });
  const drawn = (await summary()).json.items[0];
  assert.equal(drawn.kind, "plan");
  assert.equal(drawn.key, `card:${card}:plan:2`);
  assert.deepEqual(drawn.actions, [], "plans never carry actions");

  const r = await act({ key: drawn.key, action: "approve", nonce: drawn.nonce });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, "bad_action");
  assert.equal(planRow(card).status, "draft", "nothing was approved");
});

test("act: an unknown key is 404 and an action the item does not offer is 400 bad_action", async () => {
  const card = addCard({ title: "Choose a mulch", decision: decision(["Mulch", "Compost"]) });
  const drawn = (await summary()).json.items[0];

  const unknown = await act({ key: `card:${card}:nothing`, action: "option:0", nonce: drawn.nonce });
  assert.equal(unknown.status, 404);
  const unoffered = await act({ key: drawn.key, action: "option:9", nonce: drawn.nonce });
  assert.equal(unoffered.status, 400);
  assert.equal(unoffered.json.code, "bad_action");
  const bare = await act({ key: drawn.key, action: "" });
  assert.equal(bare.status, 400);
  assert.equal(bare.json.code, "bad_action");
  assert.equal(chosenOf(card), null, "nothing decided");
});

test("act: a stale nonce is refused 409 stale and nothing is decided", async () => {
  const card = addCard({ title: "Choose a mulch", decision: decision(["Mulch", "Compost"]) });
  const drawn = (await summary()).json.items[0];

  // The card changed after the widget drew it (another tab, another device, a bot).
  const tk = new Database(TASKS);
  try { tk.prepare("UPDATE tasks_items SET updated_at=datetime('now','+2 minutes') WHERE id=?").run(card); }
  finally { tk.close(); }
  // The Board lane is cached for 45 s per process; the act's re-read must see the new state.
  M._resetNeedsCacheForTest();

  const r = await act({ key: drawn.key, action: "option:0", nonce: drawn.nonce });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, "stale");
  assert.equal(chosenOf(card), null, "nothing decided");
  assert.equal(mutationCount("decision"), 0);
});

test("act: a decision answered on another device is never answered a second time", async () => {
  const card = addCard({ title: "Pick a path", decision: decision(["Alpha", "Beta"]) });
  const drawn = (await summary()).json.items[0];

  // Answered elsewhere: chosen written on another device, and the card closed.
  const tk = new Database(TASKS);
  try {
    tk.prepare("UPDATE tasks_items SET status='done', data_json=json_set(data_json,'$.decision.chosen',json(?)) WHERE id=?")
      .run(JSON.stringify({ index: 1, label: "Beta", value: null, other_text: null, decided_at: "2026-11-03T11:59:00.000Z" }), card);
  } finally { tk.close(); }
  M._resetNeedsCacheForTest();

  const r = await act({ key: drawn.key, action: "option:0", nonce: drawn.nonce });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, "stale");
  assert.equal(chosenOf(card).index, 1, "the other device's answer stands");
  assert.equal(mutationCount("decision"), 0, "this device decided nothing");
});

test("act: not_now hides the item for four hours, local scope only, without touching the card", async () => {
  const card = addCard({ title: "Soil test" });
  const result = addResult(card);
  const drawn = (await summary()).json.items[0];

  const r = await act({ key: drawn.key, action: "not_now", nonce: drawn.nonce });
  assert.equal(r.status, 200);
  assert.equal(r.json.summary.items.some((i) => i.key === drawn.key), false, "hidden now");

  assert.deepEqual(JSON.parse(setting("local", "widgets_snoozed")), { [drawn.key]: NOW + 4 * 60 * 60 * 1000 });
  assert.equal(setting("global", "widgets_snoozed"), null, "never the synced table");
  assert.equal(resultRow(result).status, "recorded", "the card was never touched");
  assert.equal(taskRow(card).status, "pending");
  assert.equal(mutationCount("result_decide"), 0);

  CLOCK.t = NOW + 4 * 60 * 60 * 1000 + 1;
  const later = await summary();
  assert.ok(later.json.items.some((i) => i.key === drawn.key), "back once the four hours are up");
});

test("act without the CSRF token is refused 403, and nothing is decided", async () => {
  const card = addCard({ title: "Choose a mulch", decision: decision(["Mulch", "Compost"]) });
  const drawn = (await summary()).json.items[0];

  for (const csrf of [null, "not-the-token"]) {
    const r = await act({ key: drawn.key, action: "option:0", nonce: drawn.nonce }, { csrf });
    assert.equal(r.status, 403, String(csrf));
    assert.match(r.text, /CSRF/);
  }
  assert.equal(chosenOf(card), null);
  assert.equal(mutationCount("decision"), 0);
});

test("act by a non-owner session is 404, with nothing decided", async () => {
  const card = addCard({ title: "Choose a mulch", decision: decision(["Mulch", "Compost"]) });
  const drawn = (await summary()).json.items[0];

  for (const session of ["sso-sess", "onhost-sess", "plain-sess"]) {
    const r = await act({ key: drawn.key, action: "option:0", nonce: drawn.nonce }, { session });
    assert.equal(r.status, 404, session);
  }
  assert.equal(chosenOf(card), null, "nothing decided");
  assert.equal(taskRow(card).status, "pending");
  assert.equal(mutationCount("decision"), 0);
});

test("act: a newer result reported after the widget was drawn is never approved by the old tap", async () => {
  const card = addCard({ title: "Soil test v2" });
  const first = addResult(card);
  const drawn = (await summary()).json.items.find((i) => i.kind === "result");
  addResult(card); // a bot reports a newer result before the owner taps
  const r = await act({ key: drawn.key, action: "accept", nonce: drawn.nonce });
  assert.ok(r.status === 409 || r.status === 404, `refused, got ${r.status}`);
  assert.notEqual(resultRow(first).status, "approved", "the superseded result stays undecided");
});

test("act: the owner's session from this machine itself, or a peer-signed request, is 404 and nothing is decided", async () => {
  const card = addCard({ title: "Soil test v3" });
  const result = addResult(card);
  const drawn = (await summary()).json.items.find((i) => i.kind === "result");
  for (const extra of [{ "x-test-on-box": "1" }, { "x-test-crosshost": "1" }]) {
    const r = await act({ key: drawn.key, action: "accept", nonce: drawn.nonce }, { extra });
    assert.equal(r.status, 404, JSON.stringify(extra));
  }
  assert.notEqual(resultRow(result).status, "approved");
});

test("act: a key longer than 200 characters is refused without a lookup", async () => {
  const r = await act({ key: "card:" + "9".repeat(300) + ":decision", action: "option:0", nonce: "x" });
  assert.ok(r.status === 404 || r.status === 400, `got ${r.status}`);
});
