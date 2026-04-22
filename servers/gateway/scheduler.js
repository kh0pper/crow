/**
 * Schedule Executor — Runs every 60s, checks for due schedules,
 * updates last_run/next_run so the AI can surface reminders.
 *
 * Follows the same pattern as auto-update.js.
 */

import { CronExpressionParser } from "cron-parser";
import { createNotification, cleanupNotifications } from "../shared/notifications.js";
import { readSetting } from "./dashboard/settings/registry.js";

const CHECK_INTERVAL_MS = 60 * 1000; // Check every 60 seconds

let timer = null;
let db = null;

/**
 * Phase 3 helper: push a TTS message to glasses if the operator opted in
 * for this notification type and not in quiet hours. Silent on "absent"
 * or "mutex_timeout"; logs but doesn't throw.
 */
async function maybeDeliverToGlasses(database, type, text) {
  try {
    const toggleKey = `meta_glasses_voice_notify_${type}`;
    const toggleRaw = await readSetting(database, toggleKey);
    if (toggleRaw !== "1" && toggleRaw !== "true") return;
    const quietRaw = await readSetting(database, "meta_glasses_voice_quiet_hours");
    let rt;
    try {
      const mod = await import("../../bundles/meta-glasses/panel/routes.js");
      rt = mod;
    } catch { return; }
    if (rt.isQuietHours && rt.isQuietHours(quietRaw || "")) return;
    // Deliver to every paired, present device. Scheduler doesn't (yet)
    // scope reminders to a particular device, so broadcast opt-in.
    const { createDbClient } = await import("../db.js");
    const devDb = createDbClient();
    try {
      // Device list lives in dashboard_settings['meta_glasses_devices'] (JSON array).
      const raw = await readSetting(devDb, "meta_glasses_devices");
      if (!raw) return;
      let devices = [];
      try { devices = JSON.parse(raw); } catch { return; }
      for (const d of devices) {
        if (!d?.id) continue;
        const res = await rt.pushTtsToDevice(d.id, text);
        if (res?.delivered) console.log(`[scheduler] glasses voice: delivered to ${d.id}`);
      }
    } finally {
      try { devDb.close(); } catch {}
    }
  } catch (err) {
    console.warn("[scheduler] glasses voice error:", err.message);
  }
}

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
    // — those are owned by the orchestrator pipeline-runner, which needs
    // to see them as still-due when it polls. If this scheduler advanced
    // next_run first, pipeline-runner would observe next_run in the
    // future and silently skip, losing the pipeline run (see the
    // 2026-04-22 MPA briefing miss).
    const { rows } = await db.execute({
      sql: "SELECT id, cron_expression, task, next_run FROM schedules WHERE enabled = 1 AND (next_run IS NOT NULL AND next_run <= ?) AND task NOT LIKE 'pipeline:%'",
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
        // Phase 3: glasses voice delivery (default off). Opt-in per type via
        // dashboard_settings key meta_glasses_voice_notify_{type} = "1". Quiet
        // hours silence voice (Nest entry remains).
        await maybeDeliverToGlasses(db, "reminder", reminderText || "Scheduled reminder")
          .catch(err => console.warn("[scheduler] glasses voice notify:", err.message));
      }
    }

    // Notification retention cleanup (runs each tick, lightweight)
    try {
      await cleanupNotifications(db);
    } catch (err) {
      console.error("[scheduler] Notification cleanup error:", err.message);
    }

    // Phase 6 C.2: meta-glasses caption backfill. Runs every tick on
    // the primary gateway to keep note-attach fill-in lag at seconds
    // rather than hours. Lightweight — only touches rows in
    // glasses_caption_backfill (typically 0 or a handful).
    try {
      const PORT = Number(process.env.CROW_GATEWAY_PORT || 3002);
      if (PORT === 3002) {
        const { runCaptionBackfill } = await import("../../bundles/meta-glasses/panel/routes.js");
        await runCaptionBackfill(db).catch(() => {});
      }
    } catch {}

    // Phase 5 B.4: meta-glasses photo retention. Runs once per day during
    // the 03:00 hour. Gated to the primary `crow-gateway` (port 3002)
    // because `crow-finance-gateway` (port 3003) runs the same scheduler
    // loop and would double-fire. The CAS UPDATE below claims the day
    // atomically — any tick in the 03:00 hour can win, so a gateway
    // restart at 03:15 doesn't lose the day. The dashboard_settings key
    // `meta_glasses_last_retention_run` is exclusively owned by this
    // cron; a GLOB guard rejects non-ISO values to defend against
    // accidental corruption from a debug session.
    try {
      const PORT = Number(process.env.CROW_GATEWAY_PORT || 3002);
      const isPrimaryGateway = PORT === 3002;
      const nowDate = new Date();
      if (isPrimaryGateway && nowDate.getHours() === 3) {
        const today = nowDate.toISOString().slice(0, 10);
        const claim = await db.execute({
          sql: `INSERT INTO dashboard_settings (key, value, updated_at)
                VALUES ('meta_glasses_last_retention_run', ?, datetime('now'))
                ON CONFLICT(key) DO UPDATE SET
                  value = excluded.value, updated_at = datetime('now')
                WHERE
                  value GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
                  AND value < excluded.value`,
          args: [today],
        });
        if (Number(claim.rowsAffected || 0) >= 1) {
          try {
            const { runPhotoRetention } = await import("../../bundles/meta-glasses/panel/routes.js");
            const summary = await runPhotoRetention(db);
            console.log(`[scheduler] meta-glasses retention: ${JSON.stringify(summary)}`);
          } catch (err) {
            console.warn(`[scheduler] meta-glasses retention failed: ${err.message}`);
          }
        }
      }
    } catch (err) {
      console.warn(`[scheduler] retention CAS error: ${err.message}`);
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
 * Stop the scheduler.
 */
export function stopScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
