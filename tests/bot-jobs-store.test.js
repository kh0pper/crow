/**
 * bot_jobs store — Plan B Part 1 (background-job runner persistence layer).
 *
 * Exercises the DB-as-IPC contract without spawning pi: enqueue, the atomic
 * single-row claim, finalize, status read, and stale-claim recovery (the
 * abandoned-job re-queue with an attempts cap that prevents an infinite re-run
 * loop). crow.db here is a throwaway DELETE-mode better-sqlite3 file.
 */
import { test, before, after } from "node:test";
import assert from "node:assert";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = mkdtempSync(join(tmpdir(), "botjobs-test-"));
const dbPath = join(dir, "crow.db");
process.env.CROW_DB_PATH = dbPath;
// Keep the runner's reserved-slot math deterministic regardless of host env.
process.env.PIBOT_MAX_JOB_ATTEMPTS = "3";

// Schema mirror of scripts/init-db.js bot_jobs (kept in sync by intent).
const SCHEMA = `
  CREATE TABLE bot_jobs (
    job_id        TEXT PRIMARY KEY,
    bot_id        TEXT NOT NULL,
    goal          TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'queued',
    deliver_to    TEXT,
    source        TEXT,
    schedule_id   INTEGER,
    escalate      INTEGER NOT NULL DEFAULT 0,
    attempts      INTEGER NOT NULL DEFAULT 0,
    result        TEXT,
    error         TEXT,
    pi_session_id TEXT,
    tool_calls    INTEGER,
    worker_pid    INTEGER,
    claimed_at    TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    started_at    TEXT,
    ended_at      TEXT
  );`;

let mod;
before(async () => {
  const init = new Database(dbPath);
  init.exec(SCHEMA);
  init.close();
  mod = await import("../scripts/pi-bots/job_runner.mjs");
});
after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

function reset() {
  const c = new Database(dbPath);
  c.exec("DELETE FROM bot_jobs;");
  c.close();
}

test("enqueue → claim → finalize → status round-trip", () => {
  reset();
  const id = mod.enqueueJob({ bot_id: "b1", goal: "do a thing", source: "manual" });
  assert.match(id, /^job-/);
  let s = mod.jobStatus(id);
  assert.equal(s.status, "queued");
  assert.equal(s.bot_id, "b1");

  const claimed = mod.claimNextJob(4242);
  assert.equal(claimed.job_id, id);
  assert.equal(claimed.status, "running");
  assert.equal(claimed.attempts, 1, "claim increments attempts");

  s = mod.jobStatus(id);
  assert.equal(s.status, "running");

  mod.finalizeJob(id, { status: "completed", result: "did the thing", error: null, tool_calls: 2, pi_session_id: "sess-1" });
  s = mod.jobStatus(id);
  assert.equal(s.status, "completed");
  assert.equal(s.result, "did the thing");
  assert.equal(s.tool_calls, 2);
  assert.ok(s.ended_at, "ended_at set on finalize");
});

test("atomic claim: one queued job is claimed exactly once", () => {
  reset();
  const a = mod.enqueueJob({ bot_id: "b1", goal: "A" });
  const b = mod.enqueueJob({ bot_id: "b1", goal: "B" });

  const c1 = mod.claimNextJob(1);
  const c2 = mod.claimNextJob(2);
  const c3 = mod.claimNextJob(3);

  const claimedIds = [c1, c2].map((r) => r.job_id).sort();
  assert.deepEqual(claimedIds, [a, b].sort(), "both queued jobs claimed, distinct rows");
  assert.notEqual(c1.job_id, c2.job_id, "no double-claim of the same row");
  assert.equal(c3, null, "no queued rows left → null");
});

test("claim respects FIFO (oldest queued first)", () => {
  reset();
  const first = mod.enqueueJob({ bot_id: "b1", goal: "first" });
  const second = mod.enqueueJob({ bot_id: "b1", goal: "second" });
  assert.equal(mod.claimNextJob().job_id, first);
  assert.equal(mod.claimNextJob().job_id, second);
});

test("stale recovery: dead worker re-queues under the attempts cap", () => {
  reset();
  const id = mod.enqueueJob({ bot_id: "b1", goal: "abandoned" });
  // Simulate a claim by a now-dead host: running, worker_pid unlikely-to-exist, attempts=1.
  const c = new Database(dbPath);
  c.prepare("UPDATE bot_jobs SET status='running', worker_pid=999999, attempts=1, started_at=datetime('now') WHERE job_id=?").run(id);
  c.close();

  mod.recoverStaleClaims(() => {});
  const s = mod.jobStatus(id);
  assert.equal(s.status, "queued", "abandoned (dead worker) job re-queued");
  assert.equal(s.attempts, 1, "attempts preserved across recovery");
});

test("stale recovery: fails (no re-queue) once attempts hit the cap", () => {
  reset();
  const id = mod.enqueueJob({ bot_id: "b1", goal: "wedged" });
  const c = new Database(dbPath);
  c.prepare("UPDATE bot_jobs SET status='running', worker_pid=999999, attempts=3, started_at=datetime('now') WHERE job_id=?").run(id);
  c.close();

  mod.recoverStaleClaims(() => {});
  const s = mod.jobStatus(id);
  assert.equal(s.status, "failed", "max-attempts abandoned job is failed, not re-queued");
  assert.match(s.error || "", /abandoned/);
});

test("stale recovery: a LIVE worker's running job is left untouched", () => {
  reset();
  const id = mod.enqueueJob({ bot_id: "b1", goal: "in-flight" });
  const c = new Database(dbPath);
  // worker_pid = THIS process (definitely alive) → must not be recovered.
  c.prepare("UPDATE bot_jobs SET status='running', worker_pid=?, attempts=1, started_at=datetime('now') WHERE job_id=?").run(process.pid, id);
  c.close();

  mod.recoverStaleClaims(() => {});
  assert.equal(mod.jobStatus(id).status, "running", "live worker's job stays running");
});
