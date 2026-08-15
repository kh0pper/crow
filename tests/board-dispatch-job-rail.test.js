// tests/board-dispatch-job-rail.test.js
//
// The board DISPATCHES ONTO THE JOB RAIL — and writes NOTHING to the card.
//
// Track 0 deleted the stage machine and with it the dispatcher's card writes:
// execute/plan-dispatch record intent as one queued bot_jobs row
// (source='card', card_id, card_action) and leave tasks_items byte-identical.
// "A bot is working this card" is the LOCK (routes/board-lock.js), derived
// from the live rails; when the job goes terminal the lock simply releases —
// there is nothing to strand and nothing to un-strand, and recovery from a
// dead worker is re-dispatch, not a card reset.
//
// Harness: scratch tasks.db + crow.db via env, ephemeral express server, plain
// fetch. No pi engine is spawned: the enqueue returns before anything could
// claim the job, and nothing in this file runs job_runner.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = mkdtempSync(join(tmpdir(), "board-jobrail-"));
const crowDb = join(dir, "crow.db");
const tasksDb = join(dir, "tasks.db");

process.env.CROW_DB_PATH = crowDb;
process.env.CROW_TASKS_DB_PATH = tasksDb;

// bot_jobs EXACTLY as it looked before card_id/card_action shipped — this is a
// LEGACY install, not a fresh one. It is seeded this way on purpose: the route's
// ensure must migrate it (PRAGMA → ALTER → DDL) before the first INSERT. Running
// BOT_JOBS_DDL first against this table throws "no such column: card_id" on its
// partial index, so a DDL-first ordering fails the very first test below.
const LEGACY_BOT_JOBS = `
  CREATE TABLE bot_jobs (
    job_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, goal TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued', deliver_to TEXT, source TEXT,
    schedule_id INTEGER, escalate INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0, result TEXT, error TEXT,
    pi_session_id TEXT, tool_calls INTEGER, worker_pid INTEGER, claimed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), started_at TEXT, ended_at TEXT);
`;

function seed() {
  const c = new Database(crowDb);
  c.exec(LEGACY_BOT_JOBS);
  c.exec(`CREATE TABLE project_spaces (id INTEGER PRIMARY KEY, name TEXT, slug TEXT,
      workspace_dir TEXT, storage_prefix TEXT, tasks_db_uri TEXT, archived_at TEXT, repo_path TEXT);
    CREATE TABLE pi_bot_defs (bot_id TEXT PRIMARY KEY, display_name TEXT NOT NULL,
      definition TEXT, enabled INTEGER NOT NULL DEFAULT 1, project_id INTEGER);
    CREATE TABLE bot_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT NOT NULL,
      card_id INTEGER, status TEXT NOT NULL DEFAULT 'active', control TEXT NOT NULL DEFAULT 'run',
      pi_session_dir TEXT, kind TEXT NOT NULL DEFAULT 'chat', updated_at TEXT DEFAULT (datetime('now')))`);
  c.prepare("INSERT INTO project_spaces (id, name, slug) VALUES (1, 'proj', 'proj')").run();
  c.prepare("INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES ('r4-assistant','R4','{}',1,1)").run();
  c.close();

  // The CONVERGED (post-0002) shape: no stage column, no status CHECK.
  // board_id present (Track 1: /card/:id/execute now guards WHERE board_id
  // IS NULL, D-T1.8) — every INSERT below omits it, so cards land NULL.
  const t = new Database(tasksDb);
  t.exec(`CREATE TABLE tasks_items (id INTEGER PRIMARY KEY, title TEXT NOT NULL,
    description TEXT, status TEXT NOT NULL DEFAULT 'pending', priority INTEGER DEFAULT 3,
    project_id INTEGER, assigned_bot TEXT, plan_ref TEXT, board_id INTEGER, data_json TEXT NOT NULL DEFAULT '{}',
    archived_at TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT)`);
  const ins = t.prepare("INSERT INTO tasks_items (id,title,project_id,status,assigned_bot) VALUES (?,?,1,?,'r4-assistant')");
  ins.run(120, "execute card", "pending");
  ins.run(121, "plan card", "pending");
  ins.run(122, "finished card", "done");
  t.close();
}

let server, port;
before(async () => {
  seed();
  const { default: express } = await import("express");
  const { default: boardRouter } = await import("../servers/gateway/routes/bot-board-api.js");
  const app = express();
  app.use(express.json());
  app.use(boardRouter((req, res, next) => next())); // auth stub
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  port = server.address().port;
});
after(() => {
  try { server.closeAllConnections?.(); server.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

const post = (path) => fetch(`http://127.0.0.1:${port}${path}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: "{}",
});
function withCrow(fn) {
  const c = new Database(crowDb);
  try { return fn(c); } finally { c.close(); }
}
function withTasks(fn) {
  const t = new Database(tasksDb);
  try { return fn(t); } finally { t.close(); }
}
const jobs = () => withCrow((c) => c.prepare("SELECT * FROM bot_jobs ORDER BY rowid").all());
const wholeCard = (id) => withTasks((t) => t.prepare("SELECT * FROM tasks_items WHERE id=?").get(id));

test("execute enqueues exactly one card-sourced job and leaves the card byte-identical", async () => {
  const before120 = wholeCard(120);

  const res = await post("/dashboard/bot-board-api/card/120/execute");
  assert.equal(res.status, 200, "the legacy table must be migrated by the ensure, not 500 on card_id");
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.dispatched, "r4-assistant");
  assert.ok(body.jobId, "the caller must learn the job id it created");

  const rows = jobs();
  assert.equal(rows.length, 1, "exactly one job per dispatch");
  assert.equal(rows[0].job_id, body.jobId);
  assert.equal(rows[0].card_id, 120, "the job must name its card");
  assert.equal(rows[0].source, "card", "runJob routes on this");
  assert.equal(rows[0].card_action, "execute");
  assert.equal(rows[0].status, "queued", "the worker claims it — the API must not run it inline");
  assert.equal(rows[0].bot_id, "r4-assistant");
  // NULL, not {kind:"card"}: the bot reports through its own writes and the
  // plan file. A dispatcher-side delivery is what inverted card ownership.
  assert.equal(rows[0].deliver_to, null, "a card job has no dispatcher-side delivery");

  // THE Track 0 contract: dispatch records intent on the rail, never on the card.
  assert.deepEqual(wholeCard(120), before120, "dispatch must not write the card — the lock is the working state");
});

test("a second execute while the job is queued is refused, not duplicated", async () => {
  const res = await post("/dashboard/bot-board-api/card/120/execute");
  assert.equal(res.status, 409, "a queued job must lock the card");
  assert.deepEqual(await res.json(), { reason: "bot is working this card" });
  assert.equal(jobs().length, 1, "the card must not accumulate duplicate work");
});

test("execute refuses a card in a terminal status on its board", async () => {
  const res = await post("/dashboard/bot-board-api/card/122/execute");
  assert.equal(res.status, 409, "done/cancelled cards are not dispatchable");
  assert.equal(withCrow((c) => c.prepare("SELECT COUNT(*) n FROM bot_jobs WHERE card_id=122").get().n), 0);
});

test("a terminal job releases the lock with NO card write, and re-execute succeeds", async () => {
  const before120 = wholeCard(120);
  // The worker died / the job failed — mark it terminal directly, as
  // stale-claim recovery would. NOTHING may touch the card for the lock to
  // release: that is the whole point of deleting the un-strand rail.
  withCrow((c) => c.prepare("UPDATE bot_jobs SET status='failed', error='worker died', ended_at=datetime('now')").run());
  assert.deepEqual(wholeCard(120), before120, "job going terminal writes nothing to the card");

  // Recovery is RE-DISPATCH, not a card reset.
  const res = await post("/dashboard/bot-board-api/card/120/execute");
  assert.equal(res.status, 200, "an unlocked, non-terminal card is dispatchable again");
  assert.equal(withCrow((c) => c.prepare("SELECT COUNT(*) n FROM bot_jobs WHERE card_id=120 AND status='queued'").get().n), 1);
  assert.deepEqual(wholeCard(120), before120);
});

test("plan-dispatch route is retired (Track 1 / D-T1.7): 404, no job, card untouched", async () => {
  // The route is DELETED here — plans are records now (plan-service.js),
  // and the drawer never had a plan-dispatch button (its only callers were
  // tests). Card 121 stays seeded to prove the deletion positively, rather
  // than dropping the case.
  const before121 = wholeCard(121);
  const res = await post("/dashboard/bot-board-api/card/121/plan-dispatch");
  assert.equal(res.status, 404, "the route must be gone, not merely refuse");
  const row = withCrow((c) => c.prepare("SELECT * FROM bot_jobs WHERE card_id=121").get());
  assert.equal(row, undefined, "a retired route must not enqueue a job");
  assert.deepEqual(wholeCard(121), before121, "a retired route must not write the card");
});

test("the bot_jobs ensure runs ONCE per process, not on every dispatch", async () => {
  // The ensure's DDL is idempotent by design, so re-running it leaves no trace
  // to assert on. Observe it by DELETING one of the objects it creates: with
  // the once-per-process latch the next dispatch does not restore the index;
  // without it, the whole multi-statement DDL runs again on every request.
  withCrow((c) => c.exec("DROP INDEX idx_bot_jobs_card"));
  withCrow((c) => c.prepare("DELETE FROM bot_jobs").run()); // unlock card 120

  assert.equal((await post("/dashboard/bot-board-api/card/120/execute")).status, 200);

  const idx = withCrow((c) => c.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_bot_jobs_card'").get());
  assert.equal(idx, undefined, "the multi-statement DDL must not re-run on every dispatch request");
  withCrow((c) => c.exec("CREATE INDEX IF NOT EXISTS idx_bot_jobs_card ON bot_jobs(card_id) WHERE card_id IS NOT NULL"));
});

test("a failed enqueue surfaces as an error and the card is untouched", async () => {
  withCrow((c) => c.prepare("DELETE FROM bot_jobs").run());
  const before120 = wholeCard(120);

  // Make the INSERT — and only the INSERT — fail, the way a SQLITE_BUSY would.
  withCrow((c) => c.exec("CREATE TRIGGER bot_jobs_boom BEFORE INSERT ON bot_jobs BEGIN SELECT RAISE(ABORT, 'enqueue exploded'); END"));
  try {
    const res = await post("/dashboard/bot-board-api/card/120/execute");
    assert.equal(res.status, 500, "an enqueue failure must surface as an error, not a silent success");
    assert.match(String((await res.json()).error), /enqueue exploded/);
    assert.equal(jobs().length, 0, "no job was created");
    assert.deepEqual(wholeCard(120), before120, "the card must be exactly as the operator left it");
  } finally {
    withCrow((c) => c.exec("DROP TRIGGER bot_jobs_boom"));
  }
});
