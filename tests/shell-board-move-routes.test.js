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
/**
 * What the Board rendered for a card (finding 1): its newest result id and
 * its ask version, read from stored state now, as the page would show them.
 */
async function seen(id) {
  const { cardVersion } = await import("../servers/gateway/dashboard/panels/board/lanes.js");
  const t = new Database(TASKS);
  try {
    const c = t.prepare("SELECT action_needed, updated_at FROM tasks_items WHERE id=?").get(id);
    const r = t.prepare("SELECT id FROM board_results WHERE item_id=? ORDER BY id DESC LIMIT 1").get(id);
    return { seen_result_id: r ? Number(r.id) : null, seen_version: c ? cardVersion(c) : null };
  } finally { t.close(); }
}
/** POST a lane move. Unless the body names them, it carries what the board shows now (seen()). */
async function move(id, body, headers = AUTHED) {
  if (body && typeof body === "object" && !("seen_result_id" in body) && !("seen_version" in body) && Number.isInteger(Number(id))) {
    body = { ...(await seen(id)), ...body };
  }
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
function addResult(itemId, status = "recorded", outcome = "success") {
  const t = new Database(TASKS);
  const id = Number(t.prepare("INSERT INTO board_results (item_id, actor_kind, actor_id, outcome, status) VALUES (?, 'bot', 'scout', ?, ?)")
    .run(itemId, outcome, status).lastInsertRowid);
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

// The HTTP contract for a double drop: one 200, one 409 stale, one move.
// Under the synchronous driver two requests do not interleave inside the
// handler, so this does not exercise the write guard; the two-client tests
// below do, by reading with both before writing with either.
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

// ---- Ruling P10: the write itself is guarded on the state read ----
// Two separate tasks.db clients on the same file (two processes' worth of
// connections) each read the lane, then each write. The in-process
// serializer is not involved: exactly one write lands, the other is stale.

async function twoClients() {
  const { createDbClient } = await import("../servers/db.js");
  const { laneState, applyLanePlan } = await import("../servers/gateway/routes/shell-api.js");
  const { movePlan } = await import("../servers/gateway/dashboard/panels/board/lanes.js");
  const a = createDbClient(TASKS), b = createDbClient(TASKS), cdb = createDbClient(DB_FILE);
  const plan = (st, to) => movePlan(st.card, st.def, { locked: st.locked, latestResult: st.latestResult }, to);
  const close = () => { for (const c of [a, b, cdb]) { try { c.close(); } catch {} } };
  return { a, b, cdb, laneState, applyLanePlan, plan, close };
}
const settle = (p) => p.then(() => ({ ok: true }), (e) => ({ ok: false, e }));

test("two clients racing up next -> done: one move lands, the other is stale", async () => {
  const id = addCard();
  const k = await twoClients();
  try {
    const sa = await k.laneState(k.a, k.cdb, id);
    const sb = await k.laneState(k.b, k.cdb, id);
    assert.equal(sa.lane, "up_next"); assert.equal(sb.lane, "up_next");
    const pa = k.plan(sa, "done"), pb = k.plan(sb, "done");
    assert.deepEqual(pa, { action: "move", status: "done" });
    const ra = await settle(k.applyLanePlan(k.a, k.cdb, id, sa, pa));
    const rb = await settle(k.applyLanePlan(k.b, k.cdb, id, sb, pb));
    assert.equal(ra.ok, true);
    assert.equal(rb.ok, false);
    assert.equal(rb.e.code, "stale"); assert.equal(rb.e.http, 409);
    assert.equal(card(id).status, "done");
    assert.deepEqual(verbs(id), ["move"], "one move recorded");
  } finally { k.close(); }
});

test("a lane move never overwrites a classic move made after its read", async () => {
  const id = addCard();
  const k = await twoClients();
  try {
    const st = await k.laneState(k.a, k.cdb, id);
    const t = new Database(TASKS);
    t.prepare("UPDATE tasks_items SET status='cancelled' WHERE id=?").run(id); // the classic board, elsewhere
    t.close();
    const r = await settle(k.applyLanePlan(k.a, k.cdb, id, st, k.plan(st, "done")));
    assert.equal(r.ok, false); assert.equal(r.e.code, "stale");
    assert.equal(card(id).status, "cancelled");
    assert.deepEqual(verbs(id), []);
  } finally { k.close(); }
});

test("two clients racing clear_ask: one clear lands, the other is stale", async () => {
  const id = addCard({ action: "check the numbers" });
  const k = await twoClients();
  try {
    const sa = await k.laneState(k.a, k.cdb, id);
    const sb = await k.laneState(k.b, k.cdb, id);
    const pa = k.plan(sa, "up_next"), pb = k.plan(sb, "up_next");
    assert.deepEqual(pa, { action: "clear_ask" });
    const ra = await settle(k.applyLanePlan(k.a, k.cdb, id, sa, pa));
    const rb = await settle(k.applyLanePlan(k.b, k.cdb, id, sb, pb));
    assert.equal(ra.ok, true);
    assert.equal(rb.ok, false); assert.equal(rb.e.code, "stale"); assert.equal(rb.e.http, 409);
    assert.equal(card(id).action_needed, null);
    assert.deepEqual(verbs(id), ["update"], "one clear recorded");
  } finally { k.close(); }
});

test("clear_ask never wipes a new ask a bot wrote after the read", async () => {
  const id = addCard({ action: "first ask" });
  const k = await twoClients();
  try {
    const st = await k.laneState(k.a, k.cdb, id);
    const t = new Database(TASKS);
    t.prepare("UPDATE tasks_items SET action_needed='a newer ask' WHERE id=?").run(id); // a bot, elsewhere
    t.close();
    const r = await settle(k.applyLanePlan(k.a, k.cdb, id, st, k.plan(st, "up_next")));
    assert.equal(r.ok, false); assert.equal(r.e.code, "stale");
    assert.equal(card(id).action_needed, "a newer ask");
    assert.deepEqual(verbs(id), []);
  } finally { k.close(); }
});

test("the clear_ask UPDATE itself is guarded: a new ask between its read and its write survives", async () => {
  const id = addCard({ action: "first ask" });
  const k = await twoClients();
  try {
    const st = await k.laneState(k.a, k.cdb, id);
    // A seam on client a: just before its UPDATE runs, another connection
    // writes a new ask (after updateCard's own read).
    const raced = {
      execute: async (q) => {
        if (/^UPDATE tasks_items/.test(q.sql || "")) {
          await k.b.execute({ sql: "UPDATE tasks_items SET action_needed='a newer ask' WHERE id=?", args: [id] });
        }
        return k.a.execute(q);
      },
    };
    const r = await settle(k.applyLanePlan(raced, k.cdb, id, st, k.plan(st, "up_next")));
    assert.equal(r.ok, false); assert.equal(r.e.code, "stale");
    assert.equal(card(id).action_needed, "a newer ask");
    assert.deepEqual(verbs(id), []);
  } finally { k.close(); }
});

test("accept racing a classic move: approved, the classic move kept, and the lane write is stale", async () => {
  const id = addCard();
  const rid = addResult(id);
  const k = await twoClients();
  try {
    const st = await k.laneState(k.a, k.cdb, id);
    const plan = k.plan(st, "done");
    assert.equal(plan.action, "accept");
    let fired = false;
    // After the approval, just before the move's UPDATE, the classic board
    // (client b) cancels the card.
    const raced = {
      execute: async (q) => {
        if (!fired && /^UPDATE tasks_items/.test(q.sql || "")) {
          fired = true;
          await k.b.execute({ sql: "UPDATE tasks_items SET status='cancelled' WHERE id=?", args: [id] });
        }
        return k.a.execute(q);
      },
    };
    const r = await settle(k.applyLanePlan(raced, k.cdb, id, st, plan));
    assert.ok(fired, "the seam fired");
    assert.equal(r.ok, false); assert.equal(r.e.code, "stale"); assert.equal(r.e.http, 409);
    assert.equal(card(id).status, "cancelled");
    assert.equal(result(rid).status, "approved");
    assert.deepEqual(verbs(id), ["result_decide"]);
  } finally { k.close(); }
  // The route's answer for a card in that state: its real lane, Done.
  const again = await move(id, { to: "done", from: "needs_you" });
  assert.deepEqual(again.body, { error: "stale", lane: "done" });
});

// ---- Final review finding 1: a move acts only on what the operator saw ----

test("a result reported after the board was drawn is never accepted: 409 stale, nothing approved or moved", async () => {
  const id = addCard();
  const r1 = addResult(id);
  const sawR1 = await seen(id);
  assert.equal(sawR1.seen_result_id, r1);
  const r2 = addResult(id); // a bot reports again while the board is open
  const r = await move(id, { to: "done", from: "needs_you", ...sawR1 });
  assert.equal(r.status, 409);
  assert.deepEqual(r.body, { error: "stale", lane: "needs_you" });
  assert.equal(result(r1).status, "recorded");
  assert.equal(result(r2).status, "recorded");
  assert.equal(card(id).status, "pending");
  assert.deepEqual(verbs(id), [], "nothing written");
});

test("an ask-only card dropped on Done after a bot reported is stale, never an approval", async () => {
  const id = addCard({ action: "sign off" });
  const saw = await seen(id);
  assert.equal(saw.seen_result_id, null);
  const rid = addResult(id);
  const r = await move(id, { to: "done", from: "needs_you", ...saw });
  assert.equal(r.status, 409);
  assert.deepEqual(r.body, { error: "stale", lane: "needs_you" });
  assert.equal(result(rid).status, "recorded");
  assert.equal(card(id).status, "pending");
  assert.deepEqual(verbs(id), []);
});

test("a changed ask is stale, for clear_ask and for a move to Done", async () => {
  const id = addCard({ action: "first ask" });
  const saw = await seen(id);
  const t = new Database(TASKS);
  t.prepare("UPDATE tasks_items SET action_needed='a newer ask', updated_at=datetime('now','+1 second') WHERE id=?").run(id);
  t.close();
  for (const to of ["up_next", "done"]) {
    const r = await move(id, { to, from: "needs_you", ...saw });
    assert.equal(r.status, 409, to);
    assert.deepEqual(r.body, { error: "stale", lane: "needs_you" }, to);
  }
  assert.equal(card(id).action_needed, "a newer ask");
  assert.equal(card(id).status, "pending");
  assert.deepEqual(verbs(id), []);
  // The same ask re-written (same text, a later updated_at) is a new version too.
  const id2 = addCard({ action: "same ask" });
  const saw2 = await seen(id2);
  const t2 = new Database(TASKS);
  t2.prepare("UPDATE tasks_items SET updated_at=datetime('now','+5 seconds') WHERE id=?").run(id2);
  t2.close();
  assert.equal((await move(id2, { to: "up_next", from: "needs_you", ...saw2 })).status, 409);
  assert.equal(card(id2).action_needed, "same ask");
});

test("a move without what the page showed (an old page) is stale, never applied", async () => {
  const id = addCard();
  const r = await move(id, { to: "done", from: "up_next", seen_result_id: null });
  assert.equal(r.status, 409);
  assert.deepEqual(r.body, { error: "stale", lane: "up_next" });
  const bad = await move(id, { to: "done", from: "up_next", seen_result_id: "x", seen_version: 5 });
  assert.equal(bad.status, 409);
  assert.equal(card(id).status, "pending");
  assert.deepEqual(verbs(id), []);
});

// ---- Final review finding 3 (operator ruling): a failure needs a confirm ----

test("accepting a failed result needs accept_failure: refused without it, accepted with it", async () => {
  const id = addCard();
  const rid = addResult(id, "recorded", "failure");
  const r = await move(id, { to: "done", from: "needs_you" });
  assert.equal(r.status, 409);
  assert.deepEqual(r.body, { error: "refused", reason: "confirm_failure" });
  assert.equal(result(rid).status, "recorded");
  assert.equal(card(id).status, "pending");
  assert.deepEqual(verbs(id), []);
  // accept_failure must be exactly true.
  assert.deepEqual((await move(id, { to: "done", from: "needs_you", accept_failure: "yes" })).body, { error: "refused", reason: "confirm_failure" });

  const ok = await move(id, { to: "done", from: "needs_you", accept_failure: true });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { ok: true, lane: "done" });
  assert.deepEqual(result(rid), { status: "approved", decided_via: "dashboard" });
  assert.equal(card(id).status, "done");
  assert.deepEqual(verbs(id), ["result_decide", "move"]);

  // A success result never asks.
  const s = addCard();
  addResult(s, "recorded", "success");
  assert.equal((await move(s, { to: "done", from: "needs_you" })).status, 200);
});

test("a partial result asks too (Ruling P16): refused without accept_failure, accepted with it", async () => {
  const id = addCard();
  const rid = addResult(id, "recorded", "partial");
  const r = await move(id, { to: "done", from: "needs_you" });
  assert.equal(r.status, 409);
  assert.deepEqual(r.body, { error: "refused", reason: "confirm_failure" });
  assert.equal(result(rid).status, "recorded");
  assert.equal(card(id).status, "pending");
  assert.deepEqual(verbs(id), []);
  const ok = await move(id, { to: "done", from: "needs_you", accept_failure: true });
  assert.deepEqual(ok.body, { ok: true, lane: "done" });
  assert.deepEqual(result(rid), { status: "approved", decided_via: "dashboard" });
  assert.equal(card(id).status, "done");
  // accept_failure on a success is harmless, and a success never needs it.
  const s = addCard();
  const sr = addResult(s, "recorded", "success");
  assert.deepEqual((await move(s, { to: "done", from: "needs_you" })).body, { ok: true, lane: "done" });
  assert.equal(result(sr).status, "approved");
});

// ---- Final review item 7: decideResult's UPDATE is the guard, not its SELECT ----

test("decideResult: a decision landing between its read and its write wins; the loser writes nothing", async () => {
  const id = addCard();
  const rid = addResult(id);
  const { decideResult } = await import("../servers/gateway/board/result-service.js");
  const { createDbClient } = await import("../servers/db.js");
  const a = createDbClient(TASKS), b = createDbClient(TASKS);
  try {
    let fired = false;
    // The loser's SELECT has seen 'recorded'; just before its UPDATE runs,
    // another connection rejects the result.
    const raced = {
      execute: async (q) => {
        if (!fired && /^UPDATE board_results/.test(q.sql || "")) {
          fired = true;
          await b.execute({ sql: "UPDATE board_results SET status='rejected', decided_via='classic' WHERE id=?", args: [rid] });
        }
        return a.execute(q);
      },
    };
    const r = await settle(decideResult(raced, id, rid, "approved", { kind: "human", id: null }, "dashboard"));
    assert.ok(fired, "the seam fired after the SELECT passed");
    assert.equal(r.ok, false);
    assert.equal(r.e.code, "already_decided"); assert.equal(r.e.http, 409);
    assert.deepEqual(result(rid), { status: "rejected", decided_via: "classic" }, "the winner's decision stands");
    assert.deepEqual(verbs(id), [], "the loser records no result_decide");
  } finally { a.close(); b.close(); }
});
