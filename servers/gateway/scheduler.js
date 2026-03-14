/**
 * Schedule Executor — Runs every 60s, checks for due schedules,
 * updates last_run/next_run so the AI can surface reminders.
 *
 * Follows the same pattern as auto-update.js.
 */

import { CronExpressionParser } from "cron-parser";

const CHECK_INTERVAL_MS = 60 * 1000; // Check every 60 seconds

let timer = null;
let db = null;

/**
 * Compute the next occurrence from a cron expression.
 * Returns an ISO string, or null if the expression is invalid.
 */
export function computeNextRun(cronExpression, fromDate = new Date()) {
  try {
    const interval = CronExpressionParser.parse(cronExpression, { currentDate: fromDate });
    return interval.next().toISOString();
  } catch {
    return null;
  }
}

/**
 * Check for due schedules and update them.
 */
async function tick() {
  if (!db) return;

  try {
    const now = new Date().toISOString();

    // Find enabled schedules that are due (next_run <= now) or have no next_run computed yet
    const { rows } = await db.execute({
      sql: "SELECT id, cron_expression, task, next_run FROM schedules WHERE enabled = 1 AND (next_run IS NOT NULL AND next_run <= ?)",
      args: [now],
    });

    for (const schedule of rows) {
      const nextRun = computeNextRun(schedule.cron_expression);
      await db.execute({
        sql: "UPDATE schedules SET last_run = ?, next_run = ?, updated_at = datetime('now') WHERE id = ?",
        args: [now, nextRun, schedule.id],
      });
      console.log(`[scheduler] Fired: #${schedule.id} "${schedule.task}" — next: ${nextRun || "unknown"}`);
    }

    // Also compute next_run for any schedules that don't have one yet
    const { rows: needsNextRun } = await db.execute({
      sql: "SELECT id, cron_expression FROM schedules WHERE enabled = 1 AND next_run IS NULL",
      args: [],
    });

    for (const schedule of needsNextRun) {
      const nextRun = computeNextRun(schedule.cron_expression);
      if (nextRun) {
        await db.execute({
          sql: "UPDATE schedules SET next_run = ?, updated_at = datetime('now') WHERE id = ?",
          args: [nextRun, schedule.id],
        });
      }
    }
  } catch (err) {
    console.error("[scheduler] Error:", err.message);
  }
}

/**
 * Start the scheduler. Call after gateway is listening.
 */
export async function startScheduler(database) {
  db = database;

  // Compute next_run for all enabled schedules on startup
  try {
    const { rows } = await db.execute({
      sql: "SELECT id, cron_expression FROM schedules WHERE enabled = 1",
      args: [],
    });

    let updated = 0;
    for (const schedule of rows) {
      const nextRun = computeNextRun(schedule.cron_expression);
      if (nextRun) {
        await db.execute({
          sql: "UPDATE schedules SET next_run = ?, updated_at = datetime('now') WHERE id = ?",
          args: [nextRun, schedule.id],
        });
        updated++;
      }
    }

    if (rows.length > 0) {
      console.log(`[scheduler] ${rows.length} schedule(s) loaded, ${updated} next_run(s) computed`);
    }
  } catch (err) {
    console.error("[scheduler] Failed to initialize:", err.message);
    return;
  }

  // Start the check loop
  timer = setInterval(() => tick(), CHECK_INTERVAL_MS);
  console.log("[scheduler] Running — checking every 60s");
}

/**
 * Stop the scheduler.
 */
export function stopScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
