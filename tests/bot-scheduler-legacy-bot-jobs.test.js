/**
 * bot_scheduler.mjs is the fifth bot_jobs entry point. Before this fix its
 * lazy dbConn() ran `d.exec(BOT_JOBS_DDL)` DDL-first: against a legacy table
 * (no card_id) the trailing `CREATE INDEX … ON bot_jobs(card_id)` threw
 * "no such column: card_id", and a bare `catch {}` swallowed it — so
 * `_botJobsEnsured` never latched and the ALTER never ran, for the entire
 * process lifetime.
 *
 * This pins the fixed behavior: tickBotSchedules(), driven against a
 * legacy-shaped bot_jobs table, must leave the table migrated (card_id
 * present) and must not throw on a second tick either.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** The pre-card_id table shape, exactly as it exists on installs today. */
const LEGACY_BOT_JOBS_DDL = `
  CREATE TABLE bot_jobs (
    job_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, goal TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued', deliver_to TEXT, source TEXT,
    schedule_id INTEGER, escalate INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0, result TEXT, error TEXT,
    pi_session_id TEXT, tool_calls INTEGER, worker_pid INTEGER,
    claimed_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
    started_at TEXT, ended_at TEXT
  );`;

const dir = mkdtempSync(join(tmpdir(), "botcron-legacy-"));
const dbPath = join(dir, "crow.db");
process.env.CROW_DB_PATH = dbPath;

let scheduler;
before(async () => {
  const init = new Database(dbPath);
  init.exec(`
    CREATE TABLE schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT, task TEXT NOT NULL, cron_expression TEXT NOT NULL,
      description TEXT, enabled INTEGER NOT NULL DEFAULT 1, last_run TEXT, next_run TEXT,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    );`);
  init.exec(LEGACY_BOT_JOBS_DDL);
  init.prepare(
    "INSERT INTO schedules (task, cron_expression, description, enabled, next_run) VALUES (?,?,?,1,?)"
  ).run("pipeline:botcron:botA", "*/5 * * * *", JSON.stringify({ goal: "daily digest" }), "2020-01-01T00:00:00.000Z");
  init.close();

  // Fresh module instance (node --test forks one process per file), so
  // bot_scheduler's module-level _botJobsEnsured starts unlatched here —
  // exactly the state a freshly-restarted pi-bots process would be in.
  scheduler = await import("../scripts/pi-bots/bot_scheduler.mjs");
});
after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

test("tickBotSchedules migrates a legacy bot_jobs table (no throw, card_id added)", () => {
  const cols = () => new Database(dbPath).pragma("table_info(bot_jobs)").map((r) => r.name);
  assert.equal(cols().includes("card_id"), false, "fixture must start legacy-shaped");

  assert.doesNotThrow(() => scheduler.tickBotSchedules());

  assert.ok(cols().includes("card_id"), "ensureBotJobsSchema must ALTER the legacy table before the DDL's card_id index");
  assert.ok(cols().includes("card_action"), "card_action must be added alongside card_id");
});

test("a second tick against the now-migrated table does not throw (idempotent + latched)", () => {
  assert.doesNotThrow(() => scheduler.tickBotSchedules());
});

test("the enqueued job landed despite the legacy shape", () => {
  const c = new Database(dbPath);
  const job = c.prepare("SELECT bot_id, goal, source, card_id FROM bot_jobs WHERE source='schedule'").get();
  c.close();
  assert.equal(job.bot_id, "botA");
  assert.equal(job.goal, "daily digest");
  assert.equal(job.card_id, null, "a schedule-sourced job has no card_id");
});
