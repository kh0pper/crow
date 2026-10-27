/**
 * Redesign P3, Task 3.3 — POST /dashboard/shell-api/cards/:id/lane: a lane
 * move is exactly one real write (a status move, accept = approve + done, or
 * clearing an ask), the server recomputes the card's lane from stored state,
 * and a move no real write expresses is refused with a reason.
 *
 * Harness: an init-db'd scratch crow.db (CROW_DATA_DIR, never the operator's
 * ~/.crow) and a scratch tasks.db brought through migrations 0001–0004 by the
 * runner (0001–0003 marked done over a hand-seeded post-0003 shape, the
 * board-archive idiom). The router is mounted behind the REAL csrfMiddleware
 * and a session-checking auth stub, as dashboard/index.js orders them
 * (tests/shell-api-routes.test.js's pattern).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const dir = mkdtempSync(join(tmpdir(), "shell-board-move-"));
process.env.CROW_DATA_DIR = dir;
process.env.CROW_HOME = join(dir, "home");
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
delete process.env.CROW_DB_PATH;
mkdirSync(process.env.CROW_HOME, { recursive: true });

const REPO = new URL("..", import.meta.url).pathname;
const TASKS = process.env.CROW_TASKS_DB_PATH;
const DB_FILE = join(dir, "crow.db");

let server, base;

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: REPO,
  });
  const tk = new Database(TASKS);
  tk.exec(`CREATE TABLE IF NOT EXISTS tasks_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    priority INTEGER DEFAULT 3,
    due_date TEXT, phase TEXT, owner TEXT, tags TEXT,
    parent_id INTEGER, project_id INTEGER,
    assigned_bot TEXT, board_id INTEGER, bot_id TEXT,
    action_needed TEXT, next_followup_date TEXT,
    processing_lease TEXT, processing_lease_status TEXT,
    autonomy TEXT NOT NULL DEFAULT 'gated',
    archived_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT,
    data_json TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE board_defs (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE,
    project_id INTEGER UNIQUE, display_name TEXT NOT NULL, status_values TEXT NOT NULL,
    terminal_values TEXT NOT NULL, fields_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  // Project 7's board ships to "shipped" and reopens to "todo".
  tk.prepare("INSERT INTO board_defs (project_id, display_name, status_values, terminal_values) VALUES (7, 'Ship', ?, ?)")
    .run('["todo","doing","shipped","dropped"]', '["shipped","dropped"]');
  tk.close();
  {
    const c = new Database(DB_FILE);
    c.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, sha TEXT)");
    for (const id of ["0001-board-stages", "0002-board-defs", "0003-tracker-convergence"]) {
      c.prepare("INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, datetime('now'))").run(id);
    }
    c.close();
  }
  const migDir = join(dir, "migrations");
  mkdirSync(migDir);
  for (const f of ["0001-board-stages.mjs", "0002-board-defs.mjs", "0003-tracker-convergence.mjs", "0004-track1-card-model.mjs"]) {
    symlinkSync(join(REPO, "scripts", "migrations", f), join(migDir, f));
  }
  const { runMigrations } = await import("../scripts/migrations/runner.mjs");
  await runMigrations({ migrationsDir: migDir, dbPath: DB_FILE, tasksDbPath: TASKS, sha: "test", log: () => {} });

  const { shellApiRouter } = await import("../servers/gateway/routes/shell-api.js");
  const { csrfMiddleware } = await import("../servers/gateway/dashboard/shared/csrf.js");
  const { parseCookies } = await import("../servers/gateway/dashboard/auth.js");
  const { default: express } = await import("express");
  const auth = (req, res, next) => {
    if (parseCookies(req).crow_session === "good") return next();
    return res.redirect("/dashboard/login");
  };
  const app = express();
  app.use(express.json());
  const router = express.Router();
  router.use("/dashboard", csrfMiddleware);
  router.use(shellApiRouter(auth));
  app.use(router);
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = "http://127.0.0.1:" + server.address().port + "/dashboard";
});

after(() => { if (server) server.close(); rmSync(dir, { recursive: true, force: true }); });

const AUTHED = { cookie: "crow_session=good; crow_csrf=tok", "x-crow-csrf": "tok" };
async function move(id, body, headers = AUTHED) {
  const r = await fetch(base + "/shell-api/cards/" + id + "/lane", {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  return { status: r.status, location: r.headers.get("location"), body: await r.json().catch(() => null) };
}

function addCard({ status = "pending", project = null, action = null, data = "{}" } = {}) {
  const t = new Database(TASKS);
  const id = Number(t.prepare("INSERT INTO tasks_items (title, status, project_id, action_needed, data_json) VALUES ('c', ?, ?, ?, ?)")
    .run(status, project, action, data).lastInsertRowid);
  t.close();
  return id;
}
function addResult(itemId, status = "recorded") {
  const t = new Database(TASKS);
  const id = Number(t.prepare("INSERT INTO board_results (item_id, actor_kind, actor_id, outcome, status) VALUES (?, 'bot', 'scout', 'success', ?)")
    .run(itemId, status).lastInsertRowid);
  t.close();
  return id;
}
function card(id) {
  const t = new Database(TASKS);
  const row = t.prepare("SELECT status, action_needed, completed_at FROM tasks_items WHERE id=?").get(id);
  t.close();
  return row;
}
function result(id) {
  const t = new Database(TASKS);
  const row = t.prepare("SELECT status, decided_via FROM board_results WHERE id=?").get(id);
  t.close();
  return row;
}
function verbs(id) {
  const t = new Database(TASKS);
  const rows = t.prepare("SELECT verb FROM board_mutations WHERE item_id=? ORDER BY id").all(id).map((r) => r.verb);
  t.close();
  return rows;
}
function hold(id) {
  const c = new Database(DB_FILE);
  c.prepare("INSERT INTO bot_sessions (bot_id, card_id, status, kind) VALUES ('hank', ?, 'active', 'chat')").run(id);
  c.close();
}

test("up next -> done moves the card to its board's done status", async () => {
  const id = addCard();
  const r = await move(id, { to: "done", from: "up_next" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, lane: "done" });
  assert.equal(card(id).status, "done");
  assert.ok(card(id).completed_at);
  assert.deepEqual(verbs(id), ["move"]);

  // A custom board ships, and reopens to its first open status.
  const c7 = addCard({ status: "doing", project: 7 });
  assert.equal((await move(c7, { to: "done", from: "up_next" })).status, 200);
  assert.equal(card(c7).status, "shipped");
  const back = await move(c7, { to: "up_next", from: "done" });
  assert.deepEqual(back.body, { ok: true, lane: "up_next" });
  assert.equal(card(c7).status, "todo");
});

test("the lane route refuses a stale from", async () => {
  const id = addCard();
  // Moved to Done in classic meanwhile.
  const t = new Database(TASKS);
  t.prepare("UPDATE tasks_items SET status='done' WHERE id=?").run(id);
  t.close();
  const r = await move(id, { to: "done", from: "up_next" });
  assert.equal(r.status, 409);
  assert.deepEqual(r.body, { error: "stale", lane: "done" });
  assert.deepEqual(verbs(id), [], "nothing written");
});

test("two parallel drops into Done make one move", async () => {
  const id = addCard();
  const out = await Promise.all([move(id, { to: "done", from: "up_next" }), move(id, { to: "done", from: "up_next" })]);
  assert.deepEqual(out.map((o) => o.status).sort(), [200, 409]);
  const lost = out.find((o) => o.status === 409);
  assert.deepEqual(lost.body, { error: "stale", lane: "done" });
  assert.deepEqual(verbs(id), ["move"], "one move recorded");
});

test("the lane route needs CSRF", async () => {
  const id = addCard();
  const r = await move(id, { to: "done", from: "up_next" }, { cookie: "crow_session=good; crow_csrf=tok" });
  assert.equal(r.status, 403);
  const forged = await move(id, { to: "done", from: "up_next" }, { cookie: "crow_session=good; crow_csrf=tok", "x-crow-csrf": "other" });
  assert.equal(forged.status, 403);
  assert.equal(card(id).status, "pending");
  assert.deepEqual(verbs(id), []);
});

test("the lane route needs a dashboard session", async () => {
  const id = addCard();
  const r = await move(id, { to: "done", from: "up_next" }, {});
  assert.equal(r.status, 302);
  assert.equal(r.location, "/dashboard/login");
  assert.equal(card(id).status, "pending");
});

test("needs you with a recorded result -> done accepts it: approve + done", async () => {
  const id = addCard();
  const rid = addResult(id);
  const r = await move(id, { to: "done", from: "needs_you" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, lane: "done" });
  assert.equal(card(id).status, "done");
  assert.deepEqual(result(rid), { status: "approved", decided_via: "dashboard" });
  assert.deepEqual(verbs(id), ["result_decide", "move"]);
});

test("needs you with a recorded result -> up next is refused: review it first", async () => {
  const id = addCard();
  const rid = addResult(id);
  const r = await move(id, { to: "up_next", from: "needs_you" });
  assert.equal(r.status, 409);
  assert.deepEqual(r.body, { error: "refused", reason: "use_review" });
  assert.equal(result(rid).status, "recorded");
  assert.deepEqual(verbs(id), []);
});

test("an ask -> up next clears it; an ask -> done moves the card", async () => {
  const a = addCard({ action: "check the numbers" });
  const r = await move(a, { to: "up_next", from: "needs_you" });
  assert.deepEqual(r.body, { ok: true, lane: "up_next" });
  assert.equal(card(a).action_needed, null);
  assert.equal(card(a).status, "pending");
  assert.deepEqual(verbs(a), ["update"]);

  const b = addCard({ action: "sign off" });
  const r2 = await move(b, { to: "done", from: "needs_you" });
  assert.deepEqual(r2.body, { ok: true, lane: "done" });
  assert.equal(card(b).status, "done");
});

test("an open decision wins over a recorded result (Ruling P2)", async () => {
  const data = JSON.stringify({ decision: { question: "q", options: [{ label: "a" }, { label: "b" }] } });
  const id = addCard({ data });
  const rid = addResult(id);
  for (const to of ["done", "up_next"]) {
    const r = await move(id, { to, from: "needs_you" });
    assert.equal(r.status, 409);
    assert.deepEqual(r.body, { error: "refused", reason: "answer_first" });
  }
  assert.equal(result(rid).status, "recorded");
  assert.equal(card(id).status, "pending");
});

test("into Working and Needs you are refused; a held card does not move", async () => {
  const id = addCard();
  assert.deepEqual((await move(id, { to: "working", from: "up_next" })).body, { error: "refused", reason: "needs_session" });
  assert.deepEqual((await move(id, { to: "needs_you", from: "up_next" })).body, { error: "refused", reason: "needs_reason" });
  hold(id);
  assert.deepEqual((await move(id, { to: "done", from: "up_next" })).body, { error: "stale", lane: "working" });
  const r = await move(id, { to: "done", from: "working" });
  assert.equal(r.status, 409);
  assert.deepEqual(r.body, { error: "refused", reason: "locked" });
  assert.equal(card(id).status, "pending");
  assert.deepEqual(verbs(id), []);
});

test("same lane is a no-op", async () => {
  const id = addCard();
  const r = await move(id, { to: "up_next", from: "up_next" });
  assert.deepEqual(r.body, { ok: true, lane: "up_next" });
  assert.deepEqual(verbs(id), []);
});

test("bad input: 400 for an unknown lane or id, 404 for a missing or archived card", async () => {
  const id = addCard();
  assert.equal((await move(id, { to: "nowhere", from: "up_next" })).status, 400);
  assert.equal((await move(id, { to: "done", from: "elsewhere" })).status, 400);
  assert.equal((await move(id, { to: "done" })).status, 400);
  assert.equal((await move("abc", { to: "done", from: "up_next" })).status, 400);
  assert.equal((await move(999999, { to: "done", from: "up_next" })).status, 404);
  const t = new Database(TASKS);
  t.prepare("UPDATE tasks_items SET archived_at=datetime('now') WHERE id=?").run(id);
  t.close();
  assert.equal((await move(id, { to: "done", from: "up_next" })).status, 404);
});
