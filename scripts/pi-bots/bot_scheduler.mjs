#!/usr/bin/env node
/**
 * Crow Bot Builder — bot cron scheduler (Plan B Part 1 Stage 4).
 *
 * The orchestrator's pipeline-runner, trimmed to the one piece pi lacks: a cron
 * that fires recurring bot work. It does NOT spawn pi — on a due schedule it
 * ENQUEUES a bot_jobs row, and the Stage 2 job runner (gateway_runner / bridge_tick)
 * claims + runs + delivers it. So scheduling and execution stay decoupled through
 * the same bot_jobs IPC table.
 *
 * It REPURPOSES the generic `schedules` table:
 *   task            = "pipeline:botcron:<bot_id>"   (C1 — see below)
 *   cron_expression = a standard 5/6-field cron
 *   description     = JSON { goal, deliver_to?, escalate?, label? }   (the job spec)
 *
 * C1 (CRITICAL — gateway-scheduler data-loss race): the gateway's notification
 * scheduler (servers/gateway/scheduler.js) is a SECOND reader of `schedules` and
 * advances next_run for everything that does NOT match `task LIKE 'pipeline:%'`. A
 * bare `bot:%` prefix would be bumped into the future by it and then SKIPPED here.
 * Namespacing UNDER the protected pipeline prefix (`pipeline:botcron:`) makes that
 * scheduler's `NOT LIKE 'pipeline:%'` skip our rows — no edit to the live scheduler.
 * (Distinct from the legacy `pipeline:bot:*` rows Phase D deletes; the Phase D
 * DELETE must exclude `pipeline:botcron:%`.)
 *
 * crow.db opened with busy_timeout only, NO journal_mode pragma (established
 * pattern). next_run is advanced BEFORE the enqueue (no-pile-up: a failed enqueue
 * is not retried every tick), and a per-schedule guard skips a row already mid-tick.
 */
import Database from "better-sqlite3";
import { CronExpressionParser } from "cron-parser";
import { generateJobId } from "./job_runner.mjs";
import { botsDbPath } from "./instance-paths.mjs";

export const BOTCRON_PREFIX = "pipeline:botcron:";

function dbConn() {
  const d = new Database(botsDbPath());
  d.pragma("busy_timeout = 10000");
  return d;
}

/** Next cron occurrence as ISO, or null on an unparseable expression. */
export function computeNextRun(cronExpression, fromDate = new Date()) {
  try {
    return CronExpressionParser.parse(cronExpression, { currentDate: fromDate }).next().toISOString();
  } catch { return null; }
}

/** In-flight guard so a slow tick never double-fires the same schedule. */
const inflight = new Set();

/**
 * One poll tick: enqueue a bot_jobs row for every due bot-cron schedule. Pure DB
 * (no pi). Returns { fired } — how many schedules enqueued a job this tick.
 */
export function tickBotSchedules({ log = () => {} } = {}) {
  const d = dbConn();
  try {
    const now = new Date().toISOString();
    let rows = [];
    try {
      rows = d.prepare(
        "SELECT id, task, cron_expression, description, next_run FROM schedules " +
        "WHERE enabled=1 AND task LIKE ? AND next_run IS NOT NULL AND next_run <= ?"
      ).all(BOTCRON_PREFIX + "%", now);
    } catch { return { fired: 0 }; } // schedules table absent — nothing to do

    let fired = 0;
    for (const s of rows) {
      if (inflight.has(s.id)) { log(`schedule #${s.id} still in-flight — skip`); continue; }
      inflight.add(s.id);
      try {
        const botId = s.task.slice(BOTCRON_PREFIX.length);
        let spec = {};
        try { spec = JSON.parse(s.description || "{}"); } catch { spec = {}; }

        // Advance FIRST (no-pile-up): even a bad spec must not retry every tick.
        const next = computeNextRun(s.cron_expression);
        d.prepare("UPDATE schedules SET last_run=?, next_run=?, updated_at=datetime('now') WHERE id=?")
          .run(now, next, s.id);

        if (!botId || !spec.goal) { log(`schedule #${s.id} missing bot/goal — advanced, not enqueued`); continue; }

        const jobId = generateJobId();
        const deliver = spec.deliver_to == null ? null
          : (typeof spec.deliver_to === "string" ? spec.deliver_to : JSON.stringify(spec.deliver_to));
        d.prepare(
          "INSERT INTO bot_jobs (job_id, bot_id, goal, status, deliver_to, source, schedule_id, escalate) " +
          "VALUES (?,?,?,'queued',?,?,?,?)"
        ).run(jobId, botId, spec.goal, deliver, "schedule", s.id, spec.escalate ? 1 : 0);
        fired++;
        log(`schedule #${s.id} (bot=${botId}) → enqueued job ${jobId}`);
      } catch (e) {
        log(`schedule #${s.id} error: ${(e && e.message) || e}`);
      } finally {
        inflight.delete(s.id);
      }
    }
    return { fired };
  } finally { d.close(); }
}

// CLI: one-shot tick for ops / verification.
if (import.meta.url === "file://" + process.argv[1]) {
  const log = (m) => console.error("[bot-scheduler] " + m);
  const r = tickBotSchedules({ log });
  console.log(JSON.stringify(r));
  process.exit(0);
}
