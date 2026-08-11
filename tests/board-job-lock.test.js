// tests/board-job-lock.test.js
//
// The board card lock has TWO rails: a bot_sessions row (the conversational
// bridge) and an unfinished bot_jobs row (the job rail). Three predicates read
// it — the JSON API's single-card re-check, the SSR/SSE board render, and the
// no-JS action=move handler — and they must agree, because a card the API
// refuses to write must also be drawn locked and must not be movable by hand.
//
// The fixture rows are seeded directly rather than dispatched, so the predicate
// is tested against states (running, completed, doubly-held) that a fresh
// enqueue cannot produce. No pi engine is spawned.
//
// Harness: scratch tasks.db + crow.db via env, ephemeral express server, plain
// fetch — the same idiom as tests/board-stage-api.test.js.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
// The REAL bot_jobs DDL — a hand-copied CREATE TABLE here could drift from the
// column set the predicate queries.
import { BOT_JOBS_DDL } from "../scripts/pi-bots/bot-jobs-schema.mjs";

const dir = mkdtempSync(join(tmpdir(), "board-job-lock-"));
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
process.env.CROW_DB_PATH = join(dir, "crow.db");

// Seed BEFORE importing anything that reads the env at module load.
{
  const t = new Database(process.env.CROW_TASKS_DB_PATH);
  t.exec(`CREATE TABLE tasks_items (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
    description TEXT, status TEXT NOT NULL DEFAULT 'pending', priority INTEGER DEFAULT 3,
    due_date TEXT, owner TEXT, tags TEXT, parent_id INTEGER, project_id INTEGER,
    stage TEXT, assigned_bot TEXT, plan_ref TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')), completed_at TEXT)`);
  const ins = t.prepare(
    "INSERT INTO tasks_items (id, title, project_id, assigned_bot, stage, status) VALUES (?,?,1,'scout',?,?)"
  );
  ins.run(1, "queued-job card", "executing", "in_progress");   // force-unlock case
  ins.run(2, "lock-map card", "executing", "in_progress");     // lockMapFor case
  ins.run(3, "running-job card", "executing", "in_progress");  // action=move case
  ins.run(4, "free card", "ready", "pending");                 // control: never locked
  ins.run(5, "session card", "executing", "in_progress");      // session rail, still locked
  ins.run(6, "old session card", "backlog", "pending");        // session rail, finished
  // Card 7 belongs to the action=move test alone. Card 3 exists to be REFUSED
  // by force-unlock; if that refusal ever regresses, card 3 becomes unlocked
  // and the move test would start passing/failing for the wrong reason.
  ins.run(7, "move-refused card", "executing", "in_progress");
  t.close();

  const c = new Database(process.env.CROW_DB_PATH);
  c.exec(`CREATE TABLE project_spaces (id INTEGER PRIMARY KEY, name TEXT, slug TEXT,
      workspace_dir TEXT, storage_prefix TEXT, tasks_db_uri TEXT, archived_at TEXT, repo_path TEXT);
    CREATE TABLE pi_bot_defs (bot_id TEXT PRIMARY KEY, display_name TEXT NOT NULL,
      definition TEXT, enabled INTEGER NOT NULL DEFAULT 1, project_id INTEGER);
    CREATE TABLE bot_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT NOT NULL,
      card_id INTEGER, status TEXT NOT NULL DEFAULT 'active', control TEXT NOT NULL DEFAULT 'run',
      pi_session_dir TEXT, kind TEXT NOT NULL DEFAULT 'chat', updated_at TEXT DEFAULT (datetime('now')))`);
  c.exec(BOT_JOBS_DDL);
  c.prepare("INSERT INTO project_spaces (id, name, slug) VALUES (1, 'proj', 'proj')").run();
  c.prepare("INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES ('scout','Scout','{}',1,1)").run();

  const job = c.prepare(
    "INSERT INTO bot_jobs (job_id, bot_id, goal, status, source, card_id, card_action, worker_pid) VALUES (?,?,?,?,'card',?,?,?)"
  );
  job.run("job-queued-1", "scout", "execute #1", "queued", 1, "execute", null);
  job.run("job-queued-2", "scout", "execute #2", "queued", 2, "execute", null);
  // A running job whose worker is THIS process — provably alive, so the
  // fail-closed half of force-unlock has something real to refuse.
  job.run("job-running-3", "scout", "execute #3", "running", 3, "execute", process.pid);
  // Terminal jobs must NOT lock: card 4 stays free with a completed job on it.
  job.run("job-done-4", "scout", "execute #4", "completed", 4, "execute", null);
  job.run("job-running-7", "scout", "execute #7", "running", 7, "execute", process.pid);

  c.prepare("INSERT INTO bot_sessions (bot_id, card_id, status) VALUES ('scout', 5, 'active')").run();
  c.prepare("INSERT INTO bot_sessions (bot_id, card_id, status) VALUES ('scout', 6, 'done')").run();
  c.close();
}

const tasksDb = () => new Database(process.env.CROW_TASKS_DB_PATH);
const crowDb = () => new Database(process.env.CROW_DB_PATH);

let server, base, createDbClient;
before(async () => {
  const { default: express } = await import("express");
  const { default: botBoardApiRouter } = await import("../servers/gateway/routes/bot-board-api.js");
  ({ createDbClient } = await import("../servers/db.js"));
  const app = express();
  app.use(express.json());
  app.use(botBoardApiRouter((req, res, next) => next())); // auth stub
  await new Promise((r) => { server = app.listen(0, r); });
  base = "http://127.0.0.1:" + server.address().port + "/dashboard/bot-board-api";
});
after(() => server && server.close());

// ---------------------------------------------------------------------------
// 1. force-unlock releases a JOB-rail lock (the Critical finding).
// ---------------------------------------------------------------------------
test("force-unlock releases a card held by a queued job, and the card is workable again", async () => {
  // Precondition: the card really is locked — an ordinary write is refused.
  const blocked = await fetch(base + "/card/1/move", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "pending" }),
  });
  assert.equal(blocked.status, 409, "a queued job must lock the card against writes");

  const r = await fetch(base + "/card/1/force-unlock", { method: "POST" });
  const body = await r.json();
  assert.notEqual(r.status, 409, "force-unlock must not report a job-locked card as unlocked: " + JSON.stringify(body));
  assert.equal(r.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.rail, "job");
  assert.equal(body.cleared, 1);

  // The job is terminal, with the operator's reason recorded, so the runner can
  // never claim it and re-take the card.
  const c = crowDb();
  const job = c.prepare("SELECT status, error, ended_at FROM bot_jobs WHERE job_id='job-queued-1'").get();
  c.close();
  assert.equal(job.status, "failed");
  assert.match(String(job.error), /force-unlock/i);
  assert.ok(job.ended_at, "a terminated job must carry ended_at");

  // The card was un-stranded out of stage='executing' — no manual SQL needed.
  const t = tasksDb();
  const card = t.prepare("SELECT stage, status FROM tasks_items WHERE id=1").get();
  t.close();
  assert.deepEqual([card.stage, card.status], ["backlog", "pending"]);
  assert.equal(body.card_reset, true);

  // And the same write that was refused above now goes through.
  const nowOk = await fetch(base + "/card/1/move", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "pending" }),
  });
  assert.equal(nowOk.status, 200, "the lock must actually be gone");

  // Execute's gate still requires stage='ready' until Task 4 deletes the stage
  // machine; seed it directly (the move-by-stage rail that used to do this is
  // already gone).
  const tReady = tasksDb();
  tReady.prepare("UPDATE tasks_items SET stage='ready' WHERE id=1").run();
  tReady.close();

  // Dispatch enqueues a job now — nothing is spawned, so the old
  // CROW_BOARD_DISPATCH_DRYRUN seam is gone with the spawn it guarded.
  const exec = await fetch(base + "/card/1/execute", { method: "POST" });
  assert.equal(exec.status, 200, "execute must be possible again after a force-unlock");
  // The new job re-locks card 1 — which is the correct end state, and what the
  // later cross-predicate tests will see.
  const c2 = crowDb();
  assert.equal(c2.prepare("SELECT COUNT(*) n FROM bot_jobs WHERE card_id=1 AND status='queued'").get().n, 1);
  c2.close();
});

test("force-unlock refuses a running job whose worker is alive (fail-closed)", async () => {
  const r = await fetch(base + "/card/3/force-unlock", { method: "POST" });
  assert.equal(r.status, 409);
  assert.match(String((await r.json()).reason), /still alive/i);
  const c = crowDb();
  assert.equal(c.prepare("SELECT status FROM bot_jobs WHERE job_id='job-running-3'").get().status, "running");
  c.close();
});

// ---------------------------------------------------------------------------
// 2. The board RENDER predicate sees the job rail.
// ---------------------------------------------------------------------------
test("lockMapFor marks a job-locked card locked, and a terminal job unlocked", async () => {
  const { lockMapFor } = await import("../servers/gateway/dashboard/panels/bot-board/data-queries.js");
  const db = createDbClient();
  try {
    const m = await lockMapFor(db, [2, 4, 5, 6]);
    assert.equal(m.get(2), true, "a queued job must draw the lock badge / block the drag");
    assert.equal(m.get(4), false, "a completed job is not a lock");
    assert.equal(m.get(5), true, "the session rail still locks");
    assert.equal(m.get(6), false, "a finished session does not lock");
  } finally { db.close(); }
});

// ---------------------------------------------------------------------------
// 3. The no-JS action=move handler sees the job rail.
// ---------------------------------------------------------------------------
test("action=move is refused on a card with a running job", async () => {
  const { handleBotBoardPost } = await import("../servers/gateway/dashboard/panels/bot-board/api-handlers.js");
  const db = createDbClient();
  let redirected = null;
  const res = { redirectAfterPost(url) { redirected = url; return true; } };
  try {
    await handleBotBoardPost({ body: { action: "move", card_id: 7, status: "done" } }, res, { db });
  } finally { db.close(); }
  assert.match(String(redirected), /err=locked/, "a manual move must not race the bot's own tasks_* write");

  const t = tasksDb();
  const card = t.prepare("SELECT status, completed_at FROM tasks_items WHERE id=7").get();
  t.close();
  assert.equal(card.status, "in_progress", "the card must not have moved");
  assert.equal(card.completed_at, null);
});

test("action=move still works on an unlocked card", async () => {
  const { handleBotBoardPost } = await import("../servers/gateway/dashboard/panels/bot-board/api-handlers.js");
  const db = createDbClient();
  let redirected = null;
  const res = { redirectAfterPost(url) { redirected = url; return true; } };
  try {
    await handleBotBoardPost({ body: { action: "move", card_id: 4, status: "done" } }, res, { db });
  } finally { db.close(); }
  assert.doesNotMatch(String(redirected), /err=/, "a card with only a completed job is movable");
  const t = tasksDb();
  assert.equal(t.prepare("SELECT status FROM tasks_items WHERE id=4").get().status, "done");
  t.close();
});

// ---------------------------------------------------------------------------
// 4. Both rails are normally held AT ONCE for a running card job: the job runs
//    bridge.handleInbound in-process, and handleInbound upserts a bot_sessions
//    row with this card_id BEFORE it spawns pi. pi is spawned detached, so a
//    dead worker does NOT imply a dead pi.
// ---------------------------------------------------------------------------

// A process whose /proc entry piLiveness() will match: comm 'node' and a
// cmdline containing `--session-dir <dir>`.
function spawnFakePi(sessionDir) {
  const script = join(dir, "fake-pi.cjs");
  writeFileSync(script, "setTimeout(function () {}, 60000);\n");
  return spawn(process.execPath, [script, "--session-dir", sessionDir], { stdio: "ignore" });
}
// piLiveness()'s own scan, so the test waits for exactly the condition the
// route will evaluate rather than for a sleep that might be too short.
function piVisible(sessionDir) {
  const needle = "--session-dir " + sessionDir;
  for (const pid of readdirSync("/proc").filter((n) => /^\d+$/.test(n))) {
    try {
      if (readFileSync("/proc/" + pid + "/comm", "utf8").trim() !== "node") continue;
      if (readFileSync("/proc/" + pid + "/cmdline").toString("utf8").replace(/\0/g, " ").includes(needle)) return true;
    } catch { /* exited mid-scan */ }
  }
  return false;
}
async function waitFor(fn, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}
// A pid that is provably gone, so the worker-liveness gate reads 'dead' and the
// request reaches the session-rail gate under test.
async function deadPid() {
  const corpse = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
  const pid = corpse.pid;
  await new Promise((r) => corpse.on("exit", r));
  return pid;
}

test("a running job with a live pi is refused, and clearing it never rewrites the card", async () => {
  const sessionDir = join(dir, "pi-session-8");
  mkdirSync(sessionDir, { recursive: true });
  const worker = await deadPid();

  const t = tasksDb();
  t.prepare("INSERT INTO tasks_items (id, title, project_id, assigned_bot, stage, status) VALUES (8,'orphaned-pi card',1,'scout','executing','in_progress')").run();
  t.close();
  const c = crowDb();
  c.prepare("INSERT INTO bot_jobs (job_id, bot_id, goal, status, source, card_id, card_action, worker_pid) VALUES ('job-running-8','scout','execute #8','running','card',8,'execute',?)").run(worker);
  c.prepare("INSERT INTO bot_sessions (bot_id, card_id, status, pi_session_dir) VALUES ('scout', 8, 'active', ?)").run(sessionDir);
  c.close();

  const fakePi = spawnFakePi(sessionDir);
  try {
    assert.ok(await waitFor(() => piVisible(sessionDir)), "fixture: the fake pi must be visible in /proc");

    // (a) The worker is dead, so the pid gate passes — but pi is detached and
    // outlived it. Without the session-rail lookup this would unlock.
    const r = await fetch(base + "/card/8/force-unlock", { method: "POST" });
    assert.equal(r.status, 409, "a live pi for this card must block the job-rail force-unlock");
    assert.match(String((await r.json()).reason), /live pi|confirmed dead/i);
    const c1 = crowDb();
    assert.equal(c1.prepare("SELECT status FROM bot_jobs WHERE job_id='job-running-8'").get().status, "running");
    c1.close();
    const t1 = tasksDb();
    assert.equal(t1.prepare("SELECT stage FROM tasks_items WHERE id=8").get().stage, "executing");
    t1.close();
  } finally {
    fakePi.kill("SIGKILL");
    await new Promise((r) => fakePi.on("exit", r));
  }
  assert.ok(await waitFor(() => !piVisible(sessionDir)), "fixture: the fake pi must be gone");

  // (b) pi is dead now, so the job can be terminated — but the bot_sessions row
  // still holds the card, so the card row must NOT be rewritten.
  const r2 = await fetch(base + "/card/8/force-unlock", { method: "POST" });
  const body = await r2.json();
  assert.equal(r2.status, 200);
  assert.equal(body.cleared, 1);
  assert.equal(body.card_reset, false, "the card must not be reset while the session rail still holds it");
  assert.equal(body.session_lock && body.session_lock.status, "active");
  const t2 = tasksDb();
  assert.equal(t2.prepare("SELECT stage FROM tasks_items WHERE id=8").get().stage, "executing");
  t2.close();
  // ...and the card is still locked, by the other rail, which keeps its own gates.
  const stillLocked = await fetch(base + "/card/8/move", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "pending" }),
  });
  assert.equal(stillLocked.status, 409);
});

// ---------------------------------------------------------------------------
// 5. The SSE tick is a FOURTH reader of this predicate. The panel client diffs
//    the stream snapshot against the SSR render's data-locked attribute and
//    reloads on any difference — so a narrower predicate here does not mis-draw
//    a badge, it makes the board reload forever without converging.
// ---------------------------------------------------------------------------
test("the SSE bot-board tick's lock snapshot agrees with the rendered board", async () => {
  const { default: express } = await import("express");
  const { default: streamsRouter } = await import("../servers/gateway/routes/streams.js");
  const { lockMapFor } = await import("../servers/gateway/dashboard/panels/bot-board/data-queries.js");

  const app = express();
  app.use((req, res, next) => { req.dashboardSession = "test-session"; next(); });
  app.use(streamsRouter((req, res, next) => next())); // auth stub
  const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const url = "http://127.0.0.1:" + srv.address().port + "/dashboard/streams/bot-board?project=1";

  const ctrl = new AbortController();
  let snapshot = null;
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const m = buf.match(/^data: (\{.*\})$/m);
      if (m) { snapshot = JSON.parse(m[1]); break; }
    }
    await reader.cancel();
  } finally {
    ctrl.abort();
    await new Promise((r) => srv.close(r));
  }
  assert.ok(snapshot && Array.isArray(snapshot.cards), "no SSE snapshot arrived");

  const ids = snapshot.cards.map((c) => Number(c.id));
  const db = createDbClient();
  let expected;
  try {
    const m = await lockMapFor(db, ids);
    expected = ids.filter((id) => m.get(id));
  } finally { db.close(); }
  const fromStream = Object.keys(snapshot.locks || {}).map(Number).sort((a, b) => a - b);
  assert.deepEqual(fromStream, expected.sort((a, b) => a - b),
    "the SSE snapshot and the rendered board must agree, or the panel client reloads forever");
  // Not vacuous: the fixture must actually contain job-rail locks at this point.
  assert.ok(expected.length > 0, "fixture must contain at least one locked card");
});

// ---------------------------------------------------------------------------
// 6. The three predicates are ONE predicate. This is the test that fails if a
//    fourth copy is ever pasted back in.
// ---------------------------------------------------------------------------
test("the single-card and batched forms agree on every card", async () => {
  const { lockState } = await import("../servers/gateway/routes/board-lock.js");
  const { lockMapFor } = await import("../servers/gateway/dashboard/panels/bot-board/data-queries.js");
  const ids = [1, 2, 3, 4, 5, 6, 7, 8, 999];
  const db = createDbClient();
  try {
    const m = await lockMapFor(db, ids);
    for (const id of ids) {
      const single = (await lockState(db, id)).locked;
      assert.equal(m.get(id), single, "batched and single-card lock predicates disagree on card " + id);
    }
    // Not vacuous: the set under test must contain both answers.
    const answers = new Set(ids.map((id) => m.get(id)));
    assert.ok(answers.has(true) && answers.has(false), "fixture must cover locked AND unlocked cards");
  } finally { db.close(); }
});
