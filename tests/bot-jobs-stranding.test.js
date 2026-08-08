/**
 * A board card must never be left stuck in stage='executing' when its worker is
 * gone. That stuck card IS the bug the job rail was adopted to prevent, so every
 * way a card job can end has to un-strand it.
 *
 * FOUR terminal paths, and the last two are the ones that hide:
 *   1. recoverStaleClaims — the job was abandoned past MAX_JOB_ATTEMPTS. It will
 *      never run again, so nothing else will ever touch the card.
 *   2. runAndFinalize's failure branch, reached from tickJobs …
 *   3. … and from runOnce (the --run-once CLI body).
 *   4. COMPLETED WITHOUT PROGRESS: runCardExecute maps two bridge outcomes —
 *      'deferred' (pi capacity) and 'stopped' (a session with control='stop') —
 *      onto a SUCCESSFUL result. Correctly: neither is a failure and neither
 *      should burn a retry. But neither did the card's work either, and the
 *      board flipped the card to 'executing' before the job ran, so paths 1-3
 *      never see them. These are iterated from the exported NO_PROGRESS_ACTIONS
 *      set, so adding a third member without wiring it fails this file.
 *
 * WHAT THIS FILE ALSO PINS
 *  - The card is reset to backlog/pending, NEVER to done. The bot writes its own
 *    terminal state through the tasks_* tools; a dispatcher that marks cards done
 *    from an exit code inverts card ownership (tried once, reverted).
 *  - The write lands in the card's OWN database. A per-project space's
 *    tasks_db_uri wins over the instance tasks.db, so the fixture puts the card
 *    in a project db and a DECOY row with the same id in the global one: an
 *    implementation that reaches for TASKS_DB unconditionally fails twice over.
 *  - A failure to reset is LOGGED. A silently swallowed SQLITE_BUSY leaves the
 *    card stuck with no trace — exactly the failure mode being removed.
 *  - A job re-queued UNDER the attempts cap does NOT reset its card: it is about
 *    to run again and the card is legitimately still executing.
 *
 * Nothing here spawns pi. The bridge is the REAL module (so the db resolution
 * and the reset itself are under test) with only handleInbound/planCard —
 * the members that would spawn an engine — replaced.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BOT_JOBS_DDL } from "../scripts/pi-bots/bot-jobs-schema.mjs";

const dir = mkdtempSync(join(tmpdir(), "botjobs-strand-"));
const CROW_DB = join(dir, "crow.db");
const PROJECT_TASKS_DB = join(dir, "project-tasks.db"); // where the card really lives
const GLOBAL_TASKS_DB = join(dir, "tasks.db");          // decoy: the instance default
const UNOPENABLE_TASKS_DB = join(dir, "no-such-dir", "tasks.db"); // forces a reset failure

process.env.CROW_DB_PATH = CROW_DB;
process.env.CROW_TASKS_DB_PATH = GLOBAL_TASKS_DB;
process.env.PIBOT_MAX_JOB_ATTEMPTS = "3";
// tickJobs' reserved-slot gate reads maxPi at module load. crow is a real
// pi-bots host, so an unpinned cap could make the tick skip as 'busy'.
process.env.PIBOT_MAX_PI = "99";

const CARD_ID = 5;
const TASKS_DDL = `CREATE TABLE tasks_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT,
  status TEXT NOT NULL DEFAULT 'pending', priority INTEGER DEFAULT 3, due_date TEXT,
  owner TEXT, tags TEXT, parent_id INTEGER, project_id INTEGER,
  stage TEXT, assigned_bot TEXT, plan_ref TEXT,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT)`;

let runner, realBridge;

before(async () => {
  for (const p of [PROJECT_TASKS_DB, GLOBAL_TASKS_DB]) {
    const t = new Database(p);
    t.exec(TASKS_DDL);
    t.prepare("INSERT INTO tasks_items (id, title, project_id) VALUES (?, 'card five', 1)").run(CARD_ID);
    t.close();
  }
  const c = new Database(CROW_DB);
  c.exec(BOT_JOBS_DDL);
  c.exec(`CREATE TABLE project_spaces (id INTEGER PRIMARY KEY, name TEXT, slug TEXT,
      workspace_dir TEXT, storage_prefix TEXT, tasks_db_uri TEXT, archived_at TEXT, repo_path TEXT);
    CREATE TABLE pi_bot_defs (bot_id TEXT PRIMARY KEY, display_name TEXT NOT NULL,
      definition TEXT, enabled INTEGER NOT NULL DEFAULT 1, project_id INTEGER)`);
  c.prepare("INSERT INTO project_spaces (id, name, slug, tasks_db_uri) VALUES (1,'proj','proj',?)").run(PROJECT_TASKS_DB);
  c.prepare("INSERT INTO project_spaces (id, name, slug, tasks_db_uri) VALUES (2,'broken','broken',?)").run(UNOPENABLE_TASKS_DB);
  c.prepare("INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES ('b1','Scout','{}',1,1)").run();
  c.prepare("INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES ('b-bad','Broken','{}',1,2)").run();
  c.close();

  runner = await import("../scripts/pi-bots/job_runner.mjs");
  realBridge = await import("../scripts/pi-bots/bridge.mjs");
});
after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

/** The real bridge with only the engine-spawning members replaced. */
function bridgeWith(over) {
  return Object.assign({}, realBridge, {
    planCard: async () => { throw new Error("planCard must not be reached in this case"); },
    handleInbound: async () => { throw new Error("handleInbound must not be reached in this case"); },
  }, over);
}

function stage(dbPath = PROJECT_TASKS_DB) {
  const c = new Database(dbPath);
  try { return c.prepare("SELECT stage, status FROM tasks_items WHERE id=?").get(CARD_ID); }
  finally { c.close(); }
}

/** Put the world back: card executing in BOTH dbs, no jobs. */
function reset() {
  for (const p of [PROJECT_TASKS_DB, GLOBAL_TASKS_DB]) {
    const t = new Database(p);
    t.prepare("UPDATE tasks_items SET stage='executing', status='in_progress' WHERE id=?").run(CARD_ID);
    t.close();
  }
  const c = new Database(CROW_DB);
  c.exec("DELETE FROM bot_jobs;");
  c.close();
}

/** Seed a card job row directly (the gateway is what INSERTs these in prod). */
function seedJob(row) {
  const c = new Database(CROW_DB);
  c.prepare(`INSERT INTO bot_jobs (job_id, bot_id, goal, status, source, card_id, card_action,
      attempts, worker_pid, started_at)
    VALUES (@job_id, @bot_id, @goal, @status, @source, @card_id, @card_action, @attempts, @worker_pid,
      CASE WHEN @status='running' THEN datetime('now') ELSE NULL END)`).run(Object.assign({
    goal: "execute #" + CARD_ID, status: "queued", source: "card", card_id: CARD_ID,
    card_action: "execute", attempts: 0, worker_pid: null, bot_id: "b1",
  }, row));
  c.close();
}

const jobRow = (id) => {
  const c = new Database(CROW_DB);
  try { return c.prepare("SELECT * FROM bot_jobs WHERE job_id=?").get(id); } finally { c.close(); }
};

// ---------------------------------------------------------------- path 1

test("recoverStaleClaims un-strands the card when a card job is abandoned for good", async () => {
  reset();
  // A card job claimed by a host that then died: worker_pid not alive, already
  // at the attempts cap, card sitting in 'executing'.
  seedJob({ job_id: "j-abandoned", status: "running", attempts: 3, worker_pid: 999999 });

  await runner.recoverStaleClaims(() => {});

  const j = jobRow("j-abandoned");
  assert.equal(j.status, "failed", "an abandoned job past the cap is failed, not re-queued");
  const s = stage();
  assert.notEqual(s.stage, "executing",
    "the card MUST NOT be left executing — no worker will ever come back for it");
  assert.deepEqual(s, { stage: "backlog", status: "pending" });
  // Never 'done': the bot owns its own terminal state via tasks_*.
  assert.notEqual(s.status, "done");
  // The write landed in the PROJECT's db, not the instance default.
  assert.equal(stage(GLOBAL_TASKS_DB).stage, "executing",
    "the global tasks.db must be untouched — the card lives in the project's own db");
});

test("a card job re-queued UNDER the attempts cap keeps its card executing", async () => {
  reset();
  seedJob({ job_id: "j-retry", status: "running", attempts: 1, worker_pid: 999999 });

  await runner.recoverStaleClaims(() => {});

  assert.equal(jobRow("j-retry").status, "queued", "under the cap the job is re-queued");
  assert.equal(stage().stage, "executing",
    "the job is about to run again — resetting here would fight the retry");
});

test("a reset that cannot be performed is LOGGED, never silently swallowed", async () => {
  reset();
  // b-bad's project points at an unopenable path, so the reset throws inside
  // the bridge. A bare catch {} here is what leaves a card stuck with no trace.
  seedJob({ job_id: "j-badbot", bot_id: "b-bad", status: "running", attempts: 3, worker_pid: 999999 });
  const lines = [];

  await runner.recoverStaleClaims((m) => lines.push(String(m)));

  assert.equal(jobRow("j-badbot").status, "failed");
  assert.ok(lines.some((l) => /FAILED/.test(l) && l.includes(String(CARD_ID))),
    "a failed un-strand must be greppable; got: " + JSON.stringify(lines));
  assert.ok(lines.some((l) => /stuck/i.test(l)),
    "the log must say the card may be stuck; got: " + JSON.stringify(lines));
});

// ---------------------------------------------------------------- path 4

test("a card job that COMPLETES without progress un-strands its card", async () => {
  // deferred (pi capacity) and stopped (control='stop') both finish as
  // SUCCESSFUL jobs having done none of the card's work, so no failure path
  // ever sees them. Iterated from the exported set on purpose: a third such
  // action added to the bridge without wiring fails right here.
  assert.ok(runner.NO_PROGRESS_ACTIONS.size >= 2, "the no-progress set must not be emptied");
  for (const action of runner.NO_PROGRESS_ACTIONS) {
    reset();
    const bridge = bridgeWith({
      handleInbound: async (o) => {
        await o.sendReply("(" + action + ")");
        return { action, reason: "pi-capacity" };
      },
    });
    const r = await runner.runJob(
      { job_id: "j-" + action, bot_id: "b1", source: "card", card_action: "execute", card_id: CARD_ID },
      { log: () => {}, bridge },
    );

    assert.ok(r && typeof r.result === "string",
      `'${action}' must still COMPLETE the job — throwing would burn a retry attempt`);
    assert.equal(stage().stage, "backlog",
      `'${action}' did none of the card's work; leaving it executing strands it forever`);
    assert.equal(stage().status, "pending");
    assert.equal(stage(GLOBAL_TASKS_DB).stage, "executing", "wrong database");
  }
});

test("an execute that DID the work leaves the card alone", async () => {
  // The guard on the above: the dispatcher's only card write is a rescue. When
  // the bot actually ran, the bot's own tasks_* writes + statusToStage own the
  // card, and a dispatcher reset here would undo them.
  reset();
  const bridge = bridgeWith({
    handleInbound: async (o) => { await o.sendReply("Card done"); return { action: "executed", toolCalls: [] }; },
  });
  await runner.runJob(
    { job_id: "j-executed", bot_id: "b1", source: "card", card_action: "execute", card_id: CARD_ID },
    { log: () => {}, bridge },
  );
  assert.equal(stage().stage, "executing", "a real execution's card state belongs to the bot, not the dispatcher");
});

test("a DEFERRED PLAN job is not reset a second time", async () => {
  // planCard already calls resetStrandedCardBestEffort on its own deferral, so
  // the runner must not pile a second reset on top. Proven by leaving the card
  // as planCard's stub found it: if the runner reset it too, it would be backlog.
  reset();
  const bridge = bridgeWith({ planCard: async () => ({ action: "deferred", reason: "pi-capacity" }) });
  const r = await runner.runJob(
    { job_id: "j-plandefer", bot_id: "b1", source: "card", card_action: "plan", card_id: CARD_ID },
    { log: () => {}, bridge },
  );
  assert.equal(r.result, "deferred: pi-capacity");
  assert.equal(stage().stage, "executing",
    "the plan path's reset is planCard's job — a second one here is a double write");
});

// ------------------------------------------------------------- paths 2 & 3

for (const [name, drive] of [
  ["tickJobs", (opts) => runner.tickJobs(opts)],
  ["runOnce", (opts) => runner.runOnce(opts)],
]) {
  test(`${name}: a card job whose bridge turn errored un-strands the card`, async () => {
    reset();
    seedJob({ job_id: "j-fail-" + name, status: "queued" });
    const bridge = bridgeWith({
      handleInbound: async () => ({ action: "error", error: "pi died" }),
    });

    const out = await drive({ log: () => {}, bridge });

    assert.equal(out.status, "failed", `${name} must finalize the job as failed`);
    assert.equal(stage().stage, "backlog",
      "the turn died with the card in executing and nothing running");
    assert.equal(stage().status, "pending");
    assert.equal(stage(GLOBAL_TASKS_DB).stage, "executing", "wrong database");
  });
}

// ------------------------------------------- the un-strand must not roll back

/**
 * The mirror of "the dispatcher never sets done": the dispatcher never UN-sets
 * it either. handleInbound's error catch is POST-turn and also wraps the
 * statusToStage reconcile, so a pi.prompt timeout AFTER the bot has already
 * written status='done' through its own tasks_* tools yields action:'error'
 * with the card at stage='executing', status='done'. Un-stranding that would
 * discard finished work.
 */
for (const terminal of ["done", "cancelled"]) {
  test(`a failed card job does NOT roll back a card the bot already left '${terminal}'`, async () => {
    reset();
    const t = new Database(PROJECT_TASKS_DB);
    // stage is still 'executing' precisely because the reconcile never ran.
    t.prepare("UPDATE tasks_items SET stage='executing', status=? WHERE id=?").run(terminal, CARD_ID);
    t.close();
    seedJob({ job_id: "j-terminal-" + terminal, status: "queued" });
    const lines = [];
    const bridge = bridgeWith({ handleInbound: async () => ({ action: "error", error: "turn timed out" }) });

    const out = await runner.runOnce({ log: (m) => lines.push(String(m)), bridge });

    assert.equal(out.status, "failed", "the job still fails — only the CARD is left alone");
    assert.equal(stage().status, terminal,
      `the bot's '${terminal}' is its own terminal state; the dispatcher must not overwrite it`);
    assert.notEqual(stage().stage, "backlog", "no rollback of completed work");
    assert.ok(lines.some((l) => /NOT un-stranded/.test(l) && l.includes(String(CARD_ID))),
      "a skipped un-strand must be visible, not silent; got: " + JSON.stringify(lines));
  });
}

test("the terminal-status guard covers every terminal status the stage model defines", async () => {
  // The guard is spelled out in SQL (deriving it at runtime would turn a
  // missing STAGE_TO_STATUS entry into 'pending', which would disable
  // un-stranding entirely). This test is what keeps the literal honest: add a
  // third terminal stage to board-stages.js and it fails here, pointing at the
  // UPDATE that needs it.
  const { TERMINAL_STAGES, stageToStatus } = await import("../servers/gateway/routes/board-stages.js");
  const terminalStatuses = [...TERMINAL_STAGES].map(stageToStatus);
  assert.deepEqual(terminalStatuses.sort(), ["cancelled", "done"],
    "a new terminal stage must also be added to resetStrandedCardBestEffort's WHERE clause");

  // And prove each one is actually refused by the real reset, not just listed.
  for (const status of terminalStatuses) {
    reset();
    const t = new Database(PROJECT_TASKS_DB);
    t.prepare("UPDATE tasks_items SET status=? WHERE id=?").run(status, CARD_ID);
    t.close();
    assert.equal(realBridge.resetStrandedCardBestEffort(PROJECT_TASKS_DB, CARD_ID, () => {}), false,
      `the reset must report false (no row moved) for status='${status}'`);
    assert.equal(stage().status, status);
  }
});

test("planCard's pre-session call sites are unaffected by the terminal guard", async () => {
  // Verified rather than assumed (fix-round-1 requirement). The plan-dispatch
  // route refuses anything not in Backlog and writes stage='planning',
  // status='pending' BEFORE spawning, so every card planCard can reset carries
  // a non-terminal status and the guard never blocks it.
  reset();
  const t = new Database(PROJECT_TASKS_DB);
  t.prepare("UPDATE tasks_items SET stage='planning', status='pending' WHERE id=?").run(CARD_ID);
  t.close();
  assert.equal(realBridge.resetStrandedCardBestEffort(PROJECT_TASKS_DB, CARD_ID, () => {}), true,
    "a planning/pending card must still reset — this is planCard's early-refusal path");
  assert.deepEqual(stage(), { stage: "backlog", status: "pending" });
});

test("a failing NON-card job touches no card at all", async () => {
  reset();
  const c = new Database(CROW_DB);
  c.prepare("INSERT INTO bot_jobs (job_id, bot_id, goal, status, source) VALUES ('j-plain','b1','heartbeat','queued','schedule')").run();
  c.close();
  const bridge = bridgeWith({ loadBot: () => { throw new Error("boom"); } });

  const out = await runner.runOnce({ log: () => {}, bridge });

  assert.equal(out.status, "failed");
  assert.equal(stage().stage, "executing", "a card-less failure must not rewrite anybody's card");
  assert.equal(stage(GLOBAL_TASKS_DB).stage, "executing");
});
