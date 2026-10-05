/**
 * Schedule Executor — Runs every 60s, checks for due schedules,
 * updates last_run/next_run so the AI can surface reminders.
 *
 * Follows the same pattern as auto-update.js.
 */

import { CronExpressionParser } from "cron-parser";
import { createNotification, cleanupNotifications } from "../shared/notifications.js";
import { runSchedulerHooks } from "./scheduler-hooks.js";

const CHECK_INTERVAL_MS = 60 * 1000; // Check every 60 seconds

let timer = null;
let db = null;
let _started = false; // Guard: prevents orphaned duplicate intervals from a second startScheduler() call.

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

    // Find enabled schedules that are due. Exclude `pipeline:` prefix rows
    // — those are owned by an external runner that needs to see them as
    // still-due when it polls. (Originally the orchestrator pipeline-runner,
    // retired 2026-06-14; the prefix is now reserved for the pi-bot cron
    // scheduler's `pipeline:botcron:` rows — bot_scheduler.mjs.) If this
    // scheduler advanced next_run first, that runner would observe next_run
    // in the future and silently skip, losing the run (see the 2026-04-22
    // MPA briefing miss).
    const { rows } = await db.execute({
      sql: "SELECT id, cron_expression, task, next_run FROM schedules WHERE enabled = 1 AND (next_run IS NOT NULL AND julianday(next_run) <= julianday(?)) AND task NOT LIKE 'pipeline:%'",
      args: [now],
    });

    for (const schedule of rows) {
      const nextRun = computeNextRun(schedule.cron_expression);
      await db.execute({
        sql: "UPDATE schedules SET last_run = ?, next_run = ?, updated_at = datetime('now') WHERE id = ?",
        args: [now, nextRun, schedule.id],
      });
      console.log(`[scheduler] Fired: #${schedule.id} "${schedule.task}" — next: ${nextRun || "unknown"}`);

      // Create notification for 'reminder:' prefix schedules
      if (schedule.task.startsWith("reminder:")) {
        const reminderText = schedule.task.slice("reminder:".length).trim();
        try {
          await createNotification(db, {
            title: reminderText || "Scheduled reminder",
            type: "reminder",
            source: "scheduler",
            priority: "normal",
            schedule_id: schedule.id,
          });
        } catch (err) {
          console.error(`[scheduler] Failed to create notification for #${schedule.id}:`, err.message);
        }
        // Installed bundles may also deliver a reminder their own way (e.g. speak it on a
        // paired device); each decides from its own settings. See scheduler-hooks.js.
        await runSchedulerHooks("reminder", db, { type: "reminder", text: reminderText || "Scheduled reminder" });
      }
    }

    // Notification retention cleanup (runs each tick, lightweight)
    try {
      await cleanupNotifications(db);
    } catch (err) {
      console.error("[scheduler] Notification cleanup error:", err.message);
    }

    // Per-tick work of installed bundles (registered at their load; none on a gateway
    // that did not load them). A failing hook is logged inside and never stops the tick.
    await runSchedulerHooks("tick", db);

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
 * A second call while already started warns and returns — prevents orphaned
 * duplicate intervals (stopScheduler resets the guard).
 */
export async function startScheduler(database) {
  if (_started) {
    console.warn("[scheduler] startScheduler called while already running — ignoring duplicate call");
    return;
  }
  _started = true;
  db = database;

  // Compute next_run for all enabled schedules on startup. Skip
  // pipeline: prefix rows so we don't overwrite a manual override that
  // was set between runs — pipeline-runner maintains its own
  // last_run/next_run on dispatch, and recomputing here would clobber
  // e.g. a test-fire next_run an operator set via CLI.
  try {
    const { rows } = await db.execute({
      sql: "SELECT id, cron_expression FROM schedules WHERE enabled = 1 AND task NOT LIKE 'pipeline:%'",
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
 * Stop the scheduler. Resets the started flag so startScheduler can be called
 * again (e.g. after a graceful shutdown + restart in tests or process reuse).
 */
export function stopScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  _started = false;
}
