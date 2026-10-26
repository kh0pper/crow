/**
 * Schedule Executor — runs every 60 s: fires due reminders, records every run in schedule_runs,
 * records repeating runs missed while Crow was not running (never made up), and notifies about
 * misses, failures and upgrade pauses exactly once.
 *
 * Types come from the task text (servers/shared/schedule-core.js):
 *   reminder     plain text or "reminder:<text>"  → delivered here (notification + reminder hooks)
 *   bot_routine  "pipeline:botcron:<bot>"          → the bot ticker's; never touched here
 *   system       any other "pipeline:"             → inert; never touched here
 *   briefing     an owner task ("media:briefing")  → its bundle runs it; here only next_run
 *                                                    advances, in the owner's zone
 *
 * Doctrine: every claim is a guarded UPDATE and runs BEFORE delivery, in the same transaction as
 * the run record. A crash in between can drop one delivery or one notice but never double it.
 */

import { createNotification, cleanupNotifications } from "../shared/notifications.js";
import { runSchedulerHooks } from "./scheduler-hooks.js";
import { ONCE, scheduleKind, reminderText, settleDue, graceMs, cronNext, zoneFor, missedRunInsert, ALIVE_SLACK_MS, BOTCRON_PREFIX } from "../shared/schedule-core.js";
import { instanceZone, instanceLang, ownerZone, hasRunsTable, hasTzColumn } from "../shared/schedule-store.js";
import { fmt } from "../shared/relative-dates.js";

const CHECK_INTERVAL_MS = 60 * 1000;
const RETENTION_EVERY = 60; // ticks between run-history prunes (and at boot)
const REQUEST_TTL = "-1 hour";

let timer = null;
let db = null;
let _started = false; // Guard: prevents orphaned duplicate intervals from a second startScheduler() call.
let _now = () => Date.now();
let aliveAt = null; // when THIS process's previous tick started: a stall inside a live process is late, not missed
let tickStartedAt = null;
let lastTickMs = 0; // how long the previous tick took (hooks included): widens the heartbeat slack
const RUNNING_TTL = "-10 minutes"; // a 'running' run older than this was cut off by a crash
let ticksSinceRetention = RETENTION_EVERY;

const iso = (ms) => new Date(ms).toISOString();
/** A claim stamp in SQLite's datetime text shape, with milliseconds. */
const stamp = (ms) => iso(ms).replace("T", " ").replace("Z", "");

const STR = {
  en: {
    fallback: "Scheduled reminder",
    late: " (late)",
    missedOne: (t) => `Missed reminder: ${t}`,
    missedBody: (when) => `Due ${when} while Crow wasn't running.`,
    missedManyBody: (n, a, b) => `Due ${n} times, ${a} → ${b}, while Crow wasn't running.`,
    failedOne: (t) => `Reminder failed: ${t}`,
    pausedOne: (t) => `Paused during the upgrade: ${t}`,
    pausedFrequent: (m) => `It would have notified every ${m} minutes. Ask Crow to turn it back on if you want it.`,
    pausedSystem: "It belonged to a retired runner and could never run.",
    summaryMissed: (n) => `${n} schedules missed runs while Crow wasn't running`,
    summaryMixed: (n) => `${n} schedules need a look`,
    summaryBots: (n) => `${n} bot routines missed runs while Crow wasn't running`,
    missedBot: (b) => `Missed: ${b} routine`,
    summaryBody: "Ask Crow to list your schedules to see them.",
    deleted: "A deleted schedule",
  },
  es: {
    fallback: "Recordatorio programado",
    late: " (tarde)",
    missedOne: (t) => `Recordatorio perdido: ${t}`,
    missedBody: (when) => `Tocaba ${when} mientras Crow no estaba en marcha.`,
    missedManyBody: (n, a, b) => `Tocaba ${n} veces, ${a} → ${b}, mientras Crow no estaba en marcha.`,
    failedOne: (t) => `Falló el recordatorio: ${t}`,
    pausedOne: (t) => `En pausa por la actualización: ${t}`,
    pausedFrequent: (m) => `Habría avisado cada ${m} minutos. Pide a Crow que lo reactive si lo quieres.`,
    pausedSystem: "Pertenecía a un ejecutor retirado y nunca podía ejecutarse.",
    summaryMissed: (n) => `${n} programaciones no se ejecutaron mientras Crow no estaba en marcha`,
    summaryMixed: (n) => `${n} programaciones necesitan revisión`,
    summaryBots: (n) => `${n} rutinas de bot no se ejecutaron mientras Crow no estaba en marcha`,
    missedBot: (b) => `No se ejecutó: rutina ${b}`,
    summaryBody: "Pide a Crow la lista de tus programaciones para verlas.",
    deleted: "Una programación borrada",
  },
};

/**
 * Compute the next occurrence from a cron expression, in `zone` (default: the host zone).
 * Returns an ISO string, or null if the expression is invalid.
 */
export function computeNextRun(cronExpression, fromDate = new Date(), zone = null) {
  const t = cronNext(cronExpression, zone, fromDate.getTime());
  return t === null ? null : iso(t);
}

let _compute = computeNextRun; // indirection so tests can observe/replace it

/** The zone a row runs in: an owner's zone for a bundle row, else its own, else the instance's. */
async function rowZone(row, zone) {
  return scheduleKind(row.task) === "briefing" ? ownerZone(db, row.task, zone) : zoneFor(row.tz, zone);
}

/** Notification + reminder hooks. → null, or the error message when the notification failed. */
async function deliverReminder(db, schedule, { late = false, lang = "en" } = {}) {
  const text = reminderText(schedule.task) || STR[lang].fallback;
  let error = null;
  try {
    await createNotification(db, {
      title: late ? text + STR[lang].late : text,
      type: "reminder",
      source: "scheduler",
      priority: "normal",
      schedule_id: schedule.id,
    });
  } catch (err) {
    error = String(err?.message || err).slice(0, 200);
    console.error(`[scheduler] Failed to create notification for #${schedule.id}:`, error);
  }
  // Installed bundles may also deliver a reminder their own way (e.g. speak it on a
  // paired device); each decides from its own settings. See scheduler-hooks.js.
  await runSchedulerHooks("reminder", db, { type: "reminder", text: reminderText(schedule.task) || "Scheduled reminder", late: !!late });
  return error;
}

/**
 * Run a schedule now (the panel's Run now, and requested runs from the memory server). Reminders
 * only for now; it never changes next_run. → { ok, runId?, error? }
 */
export async function runNow(database, schedule, { runId = null } = {}) {
  const db = database; // local: never rebinds the scheduler's own handle
  const finish = async (status, detail) => {
    if (!(await hasRunsTable(db))) return null;
    if (runId) {
      await db.execute({ sql: "UPDATE schedule_runs SET status = ?, ran_at = ?, detail = ? WHERE id = ?", args: [status, iso(_now()), detail, runId] });
      return runId;
    }
    const r = await db.execute({
      sql: "INSERT INTO schedule_runs (schedule_id, scheduled_for, ran_at, status, source, detail) VALUES (?, NULL, ?, ?, 'run-now', ?)",
      args: [schedule?.id ?? null, iso(_now()), status, detail],
    });
    return Number(r.lastInsertRowid);
  };
  if (!schedule) return { ok: false, error: "deleted", runId: await finish("failed", JSON.stringify({ error: "deleted" })) };
  const kind = scheduleKind(schedule.task);
  if (kind !== "reminder") {
    const error = kind === "briefing" ? "owned by its app" : kind === "bot_routine" ? "bot routines run from Bot Builder" : "not runnable";
    if (runId) await finish("failed", JSON.stringify({ error }));
    return { ok: false, error };
  }
  const error = await deliverReminder(db, schedule, { lang: await instanceLang(db) });
  const id = await finish(error ? "failed" : "ok", error ? JSON.stringify({ error }) : null);
  return { ok: !error, runId: id, error };
}

/** Advance a bundle-owned row: next_run only, in the owner's zone. Nothing is recorded or sent. */
async function advanceOwned(row, now, zone) {
  const next = cronNext(row.cron_expression, await rowZone(row, zone), now);
  await db.execute({
    sql: "UPDATE schedules SET last_run = ?, next_run = ?, updated_at = datetime('now') WHERE id = ? AND next_run IS ?",
    args: [iso(now), next === null ? null : iso(next), row.id, row.next_run],
  });
}

/** Settle one due reminder row: claim + record in one transaction, then deliver if this tick won. */
async function settleReminder(row, now, { zone, grace, runs, lang }) {
  // Slack as the bot-cron ticker computes it — max(2 min, the poll interval) — plus the previous
  // tick's own length, since this ticker runs bundle hooks inside its tick.
  const aliveSlackMs = Math.max(ALIVE_SLACK_MS, CHECK_INTERVAL_MS + lastTickMs);
  const s = settleDue(row, now, { graceMs: grace, zone, aliveAt, aliveSlackMs });
  if (!s) return;
  const once = row.cron_expression === ONCE;
  const claimStamp = stamp(now);
  const nextRun = once ? row.next_run : (s.nextRun === null ? null : iso(s.nextRun));
  const stmts = [{
    sql: `UPDATE schedules SET last_run = COALESCE(?, last_run), next_run = ?, enabled = ?, updated_at = ?
          WHERE id = ? AND next_run IS ? AND enabled = 1`,
    args: [s.fire === null ? null : iso(now), nextRun, once ? 0 : 1, claimStamp, row.id, row.next_run],
  }];
  // Each record is written only if THIS claim's state is what the row now holds.
  const ours = "EXISTS (SELECT 1 FROM schedules WHERE id = ? AND updated_at = ? AND next_run IS ?)";
  if (runs && s.missed) {
    // The shared row shape (missedRunInsert), written only if this claim won.
    const m = missedRunInsert(row.id, s.missed);
    stmts.push({
      sql: m.sql.replace(/VALUES \((.*)\)$/, `SELECT $1 WHERE ${ours}`),
      args: [...m.args, row.id, claimStamp, nextRun],
    });
  }
  if (runs && s.fire !== null) {
    stmts.push({
      sql: `INSERT OR IGNORE INTO schedule_runs (schedule_id, scheduled_for, ran_at, status, source, detail)
            SELECT ?, ?, ?, ?, 'clock', ? WHERE ${ours}`,
      args: [row.id, iso(s.fire), iso(now), s.status, JSON.stringify({ late_ms: now - s.fire }), row.id, claimStamp, nextRun],
    });
  }
  const res = await db.batch(stmts, "write");
  if (Number(res[0]?.rowsAffected || 0) !== 1) return; // another tick or process claimed it
  if (s.fire === null) {
    console.log(`[scheduler] Missed: #${row.id} (${s.missed.count}) — next: ${nextRun || "unknown"}`);
    return;
  }
  console.log(`[scheduler] Fired${once ? " one-shot" : ""}: #${row.id} "${row.task}"${s.late ? " (late)" : ""}${once ? "" : ` — next: ${nextRun || "unknown"}`}`);
  const error = await deliverReminder(db, row, { late: s.late, lang });
  if (error && runs) {
    await db.execute({
      sql: "UPDATE schedule_runs SET status = 'failed', detail = ? WHERE schedule_id = ? AND scheduled_for = ?",
      args: [JSON.stringify({ error }), row.id, iso(s.fire)],
    });
  }
}

/** Execute 'requested' runs (written by the memory server's run_now), each claimed first. */
async function drainRequests() {
  await db.execute({
    sql: `UPDATE schedule_runs SET status = 'failed', detail = '{"error":"interrupted"}'
          WHERE status = 'running' AND julianday(COALESCE(ran_at, created_at)) < julianday(?, '${RUNNING_TTL}')`,
    args: [iso(_now())],
  });
  await db.execute({
    sql: `UPDATE schedule_runs SET status = 'failed', detail = '{"error":"no runner"}', ran_at = ?
          WHERE status = 'requested' AND julianday(created_at) < julianday('now', '${REQUEST_TTL}')`,
    args: [iso(_now())],
  });
  const { rows } = await db.execute({ sql: "SELECT id, schedule_id FROM schedule_runs WHERE status = 'requested' ORDER BY id LIMIT 20", args: [] });
  for (const r of rows) {
    const claim = await db.execute({ sql: "UPDATE schedule_runs SET status = 'running', ran_at = ? WHERE id = ? AND status = 'requested'", args: [iso(_now()), r.id] });
    if (!claim.rowsAffected) continue;
    const s = (await db.execute({ sql: "SELECT * FROM schedules WHERE id = ?", args: [r.schedule_id] })).rows[0] || null;
    await runNow(db, s, { runId: r.id });
  }
}

function whenText(ms, zone, lang) {
  return fmt(lang === "es" ? "es-ES" : "en-US", { weekday: "short", hour: "numeric", minute: "2-digit" }, ms, zone);
}

/** Mark first, then notify only for the rows this tick marked (a crash loop or a second process cannot double a notice). */
async function notifyOnce(now, { zone, lang }) {
  const tz = (await hasTzColumn(db)) ? "s.tz" : "NULL";
  const { rows: candidates } = await db.execute({
    sql: `SELECT r.id, r.schedule_id, r.status, r.scheduled_for, r.missed_count, r.detail, s.task, s.cron_expression, ${tz} AS tz
          FROM schedule_runs r LEFT JOIN schedules s ON s.id = r.schedule_id
          WHERE r.status IN ('missed', 'failed', 'paused') AND r.notified_at IS NULL ORDER BY r.id LIMIT 50`,
    args: [],
  });
  if (!candidates.length) return;
  const marks = candidates.map(() => "?").join(",");
  const { rows: won } = await db.execute({
    sql: `UPDATE schedule_runs SET notified_at = ? WHERE id IN (${marks}) AND notified_at IS NULL RETURNING id`,
    args: [iso(now), ...candidates.map((c) => c.id)],
  });
  const mine = new Set(won.map((w) => Number(w.id)));
  const claimed = candidates.filter((c) => mine.has(Number(c.id)));
  if (!claimed.length) return;
  const S = STR[lang];
  const base = { source: "scheduler:missed", priority: "normal" };
  if (claimed.length > 1) {
    const allMissed = claimed.every((c) => c.status === "missed");
    const allBots = allMissed && claimed.every((c) => scheduleKind(c.task) === "bot_routine");
    // No action_url until the Schedule page exists (panel PR 2).
    await createNotification(db, { ...base, type: "system", title: allBots ? S.summaryBots(claimed.length) : allMissed ? S.summaryMissed(claimed.length) : S.summaryMixed(claimed.length), body: S.summaryBody });
    return;
  }
  const c = claimed[0];
  const bot = scheduleKind(c.task) === "bot_routine" ? String(c.task).trim().slice(BOTCRON_PREFIX.length) : null;
  const text = c.task ? (bot ?? (reminderText(c.task) || S.fallback)) : S.deleted;
  let detail = {};
  try { detail = JSON.parse(c.detail || "{}") || {}; } catch {}
  const z = zoneFor(c.tz, zone);
  const one = { ...base, schedule_id: c.task ? Number(c.schedule_id) : null };
  if (c.status === "paused") {
    await createNotification(db, { ...one, type: "system", title: S.pausedOne(text), body: detail.reason === "frequent" ? S.pausedFrequent(detail.every_min) : S.pausedSystem });
  } else if (c.status === "failed") {
    await createNotification(db, { ...one, type: "reminder", title: S.failedOne(text), body: detail.error ? String(detail.error).slice(0, 200) : null });
  } else {
    const first = Date.parse(c.scheduled_for);
    const last = Date.parse(detail.last_missed || c.scheduled_for);
    const count = Number(c.missed_count || 1);
    const body = count > 1 ? S.missedManyBody(detail.capped ? `${count}+` : count, whenText(first, z, lang), whenText(last, z, lang)) : S.missedBody(whenText(first, z, lang));
    await createNotification(db, { ...one, type: bot ? "system" : "reminder", title: bot ? S.missedBot(bot) : S.missedOne(text), body });
  }
}

/** Retention: orphans; older than 90 days beyond the newest 20; anything beyond the newest 500. */
async function pruneRuns() {
  await db.execute({ sql: "DELETE FROM schedule_runs WHERE schedule_id NOT IN (SELECT id FROM schedules)", args: [] });
  await db.execute({
    sql: `DELETE FROM schedule_runs WHERE id IN (
            SELECT id FROM (SELECT id, created_at, ROW_NUMBER() OVER (PARTITION BY schedule_id ORDER BY id DESC) AS rn FROM schedule_runs)
            WHERE rn > 500 OR (rn > 20 AND julianday(created_at) < julianday('now', '-90 days')))`,
    args: [],
  });
}

/** Due rows → fire or record a miss; requested runs; notify once. Also the boot pass. */
async function settlePass() {
  const now = _now();
  const zone = await instanceZone(db);
  const lang = await instanceLang(db);
  const runs = await hasRunsTable(db);
  const tz = (await hasTzColumn(db)) ? "tz" : "NULL AS tz";
  const grace = graceMs();

  // Exclude `pipeline:` rows in SQL, whatever the type function says: they belong to an external
  // runner (today the pi-bot cron scheduler's `pipeline:botcron:` rows, bot_scheduler.mjs) that
  // must see them as still due when it polls; advancing them here would lose the run (the
  // 2026-04-22 MPA briefing miss).
  const { rows } = await db.execute({
    sql: `SELECT id, cron_expression, task, next_run, ${tz} FROM schedules
          WHERE enabled = 1 AND next_run IS NOT NULL AND julianday(next_run) <= julianday(?) AND task NOT LIKE 'pipeline:%'`,
    args: [iso(now)],
  });
  for (const row of rows) {
    try {
      const kind = scheduleKind(row.task);
      if (kind === "briefing") await advanceOwned(row, now, zone);
      else if (kind === "reminder") await settleReminder(row, now, { zone, grace, runs, lang });
    } catch (err) {
      console.error(`[scheduler] #${row.id}: ${err.message}`);
    }
  }
  if (runs) {
    await drainRequests();
    await notifyOnce(now, { zone, lang });
  }
}

/**
 * Check for due schedules and update them.
 */
async function tick() {
  if (!db) return;

  // The heartbeat is the START of the previous tick, so a slow hook in that tick cannot make a
  // row that came due meanwhile look like downtime.
  aliveAt = tickStartedAt;
  tickStartedAt = _now();
  const startedAt = tickStartedAt;
  try {
    await settlePass();

    if (++ticksSinceRetention >= RETENTION_EVERY && (await hasRunsTable(db))) {
      ticksSinceRetention = 0;
      await pruneRuns();
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
    const zone = await instanceZone(db);
    const tz = (await hasTzColumn(db)) ? "tz" : "NULL AS tz";
    const { rows: needsNextRun } = await db.execute({
      sql: `SELECT id, cron_expression, task, ${tz} FROM schedules WHERE enabled = 1 AND next_run IS NULL AND cron_expression != '@once'`,
      args: [],
    });

    for (const schedule of needsNextRun) {
      const nextRun = _compute(schedule.cron_expression, new Date(_now()), await rowZone(schedule, zone));
      if (nextRun) {
        await db.execute({
          sql: "UPDATE schedules SET next_run = ?, updated_at = datetime('now') WHERE id = ? AND next_run IS NULL",
          args: [nextRun, schedule.id],
        });
      }
    }
  } catch (err) {
    console.error("[scheduler] Error:", err.message);
  }
  lastTickMs = Math.max(0, _now() - startedAt);
}

/**
 * Compute next_run for enabled schedules on startup, in each row's zone. Returns false if it failed.
 *
 * - A row whose next_run is already PAST is left alone: the first tick settles it (fires it within
 *   grace, else records the miss). Recomputing it from now would drop the run without a trace.
 * - `@once` rows are skipped: their next_run is absolute.
 * - `pipeline:` rows are skipped so a manual override set between runs is not clobbered — their
 *   runner maintains its own last_run/next_run.
 */
async function bootRecompute() {
  try {
    const now = _now();
    const zone = await instanceZone(db);
    const tz = (await hasTzColumn(db)) ? "tz" : "NULL AS tz";
    const { rows } = await db.execute({
      sql: `SELECT id, cron_expression, task, next_run, ${tz} FROM schedules WHERE enabled = 1 AND task NOT LIKE 'pipeline:%' AND cron_expression != '@once'`,
      args: [],
    });

    let updated = 0;
    for (const schedule of rows) {
      const at = Date.parse(schedule.next_run ?? "");
      if (Number.isFinite(at) && at <= now) continue;
      const nextRun = _compute(schedule.cron_expression, new Date(now), await rowZone(schedule, zone));
      if (nextRun) {
        await db.execute({
          sql: "UPDATE schedules SET next_run = ?, updated_at = datetime('now') WHERE id = ? AND next_run IS ?",
          args: [nextRun, schedule.id, schedule.next_run ?? null],
        });
        updated++;
      }
    }

    if (rows.length > 0) {
      console.log(`[scheduler] ${rows.length} schedule(s) loaded, ${updated} next_run(s) computed`);
    }
  } catch (err) {
    console.error("[scheduler] Failed to initialize:", err.message);
    return false;
  }
  return true;
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

  if (!(await bootRecompute())) return;

  // Settle what came due while the gateway was down now, not 60 s from now (a short restart
  // stays inside grace). Only the settle pass: bundle tick hooks wait for the first interval.
  try { await settlePass(); } catch (err) { console.error("[scheduler] Boot settle failed:", err.message); }

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

// Test seams (not used in production). Each binds the module to the given db.
export async function _tickForTest(database) { db = database; await tick(); }
export async function _bootRecomputeForTest(database) { db = database; return bootRecompute(); }
/** Replace the next-run computation (tests); returns a function that restores it. */
export function _setComputeNextRunForTest(fn) { _compute = fn; return () => { _compute = computeNextRun; }; }
/** Replace the clock (tests); null restores Date.now. */
export function _setNowForTest(fn) { _now = fn || (() => Date.now()); }
/** Forget in-process state between tests (heartbeat, retention counter). */
export function _resetForTest() { aliveAt = null; tickStartedAt = null; lastTickMs = 0; ticksSinceRetention = RETENTION_EVERY; }
