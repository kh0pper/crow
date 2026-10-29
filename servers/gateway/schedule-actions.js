/**
 * schedule-actions — what the Schedule panel's buttons do: create a reminder from plain words,
 * pause, resume, run now, delete, and dismiss a run. Each returns { ok, code?, ... } and never
 * throws for a refused request; the panel turns codes into words.
 *
 * Every write re-reads the row first and decides from its CURRENT task, so a stale page can never
 * act on a row whose type changed under it. The briefing row belongs to News (every control is a
 * link there), and a `pipeline:` row that is not a bot routine never runs.
 */
import { ONCE, REMINDER_PREFIX, BOTCRON_PREFIX, scheduleKind, zoneFor, hostZone, cronNext, cadenceMinutes } from "../shared/schedule-core.js";
import { instanceZone, hasRunsTable, hasTzColumn } from "../shared/schedule-store.js";
import { parseWhen } from "../shared/schedule-words.js";
import { isVoiceBotId } from "../shared/voice-bot.js";
import { runNow } from "./scheduler.js";
import { botSpec } from "./schedule-catalog.js";

export const TEXT_MAX = 1000;
const MIN_REMINDER_EVERY = 60;
const iso = (ms) => new Date(ms).toISOString();

async function rowOf(db, id) {
  if (!Number.isInteger(id) || id <= 0) return null;
  const tz = (await hasTzColumn(db)) ? "tz" : "NULL AS tz";
  const { rows } = await db.execute({ sql: `SELECT id, task, cron_expression, description, enabled, next_run, last_run, ${tz} FROM schedules WHERE id = ?`, args: [id] });
  return rows[0] || null;
}

/** The zone a row's next run is computed in (the bot ticker has no zone yet: the host's). */
async function zoneOfRow(db, row) {
  return scheduleKind(row.task) === "bot_routine" ? hostZone() : zoneFor(row.tz, await instanceZone(db));
}

/**
 * Parse the create form's "when" (or its advanced cron field) for a reminder.
 * `tz` is the browser's zone when it sent one; the instance zone otherwise.
 */
export async function previewWhen(db, { when, cron, tz, lang, now = Date.now() }) {
  const zone = zoneFor(tz, await instanceZone(db));
  const text = typeof cron === "string" && cron.trim() ? cron : when;
  return { ...parseWhen(typeof text === "string" ? text : "", { lang, tz: zone, now, type: "reminder" }), zone };
}

/** Create a reminder. → { ok:true, id, words } | { ok:false, code, hint? } */
export async function createReminder(db, { text, when, cron, tz, lang, now = Date.now() }) {
  const body = typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
  if (!body) return { ok: false, code: "empty-text" };
  if (body.length > TEXT_MAX) return { ok: false, code: "text-too-long" };
  // A reminder's words are never a type of their own ("pipeline:…", or News's own task).
  const task = body.toLowerCase().startsWith(REMINDER_PREFIX) ? body : REMINDER_PREFIX + body;
  if (scheduleKind(task) !== "reminder") return { ok: false, code: "bad-text" };
  const words = await previewWhen(db, { when, cron, tz, lang, now });
  if (!words.ok) return { ok: false, code: "bad-when", hint: words.hint, words };
  let nextRun;
  if (words.cron === ONCE) {
    const at = Date.parse(words.at);
    if (!Number.isFinite(at) || at <= now) return { ok: false, code: "bad-when", hint: words.hint, words };
    nextRun = iso(at);
  } else {
    const every = cadenceMinutes(words.cron, words.zone, now);
    if (every !== null && every < MIN_REMINDER_EVERY) return { ok: false, code: "too-frequent", words };
    const next = cronNext(words.cron, words.zone, now);
    if (next === null) return { ok: false, code: "bad-when", words };
    nextRun = iso(next);
  }
  // A zone is stored only when it differs from the instance's: NULL follows the instance.
  const withTz = await hasTzColumn(db);
  const storeTz = withTz && words.zone !== (await instanceZone(db)) ? words.zone : null;
  const r = await db.execute({
    sql: withTz
      ? "INSERT INTO schedules (task, cron_expression, next_run, enabled, tz) VALUES (?, ?, ?, 1, ?)"
      : "INSERT INTO schedules (task, cron_expression, next_run, enabled) VALUES (?, ?, ?, 1)",
    args: withTz ? [task, words.cron, nextRun, storeTz] : [task, words.cron, nextRun],
  });
  return { ok: true, id: Number(r.lastInsertRowid), words };
}

/** Pause. Not for the briefing (News owns it). */
export async function pauseSchedule(db, id) {
  const row = await rowOf(db, id);
  if (!row) return { ok: false, code: "not-found" };
  const kind = scheduleKind(row.task);
  if (kind === "briefing") return { ok: false, code: "owned" };
  await db.execute({ sql: "UPDATE schedules SET enabled = 0, updated_at = datetime('now') WHERE id = ? AND task = ?", args: [id, row.task] });
  return { ok: true, row };
}

/**
 * Resume: next_run is recomputed from now in the row's zone (an old next_run would otherwise
 * be recorded as missed on the next tick). A one-shot keeps its time; one whose time has passed
 * cannot resume ("pick a new time"). A system row never runs, so it never resumes.
 */
export async function resumeSchedule(db, id, { now = Date.now() } = {}) {
  const row = await rowOf(db, id);
  if (!row) return { ok: false, code: "not-found" };
  const kind = scheduleKind(row.task);
  if (kind === "briefing") return { ok: false, code: "owned" };
  if (kind === "system") return { ok: false, code: "not-runnable" };
  let next;
  if (row.cron_expression === ONCE) {
    const at = Date.parse(row.next_run ?? "");
    if (!Number.isFinite(at) || at <= now) return { ok: false, code: "once-passed" };
    next = row.next_run;
  } else {
    const t = cronNext(row.cron_expression, await zoneOfRow(db, row), now);
    if (t === null) return { ok: false, code: "bad-cron" };
    next = iso(t);
  }
  await db.execute({ sql: "UPDATE schedules SET enabled = 1, next_run = ?, updated_at = datetime('now') WHERE id = ? AND task = ?", args: [next, id, row.task] });
  return { ok: true, row };
}

/**
 * Run now. A reminder is delivered now (scheduler.runNow records a run-now run). A bot routine
 * enqueues one bot_jobs row (source 'schedule'), unless one is still queued for it, and records a
 * run-now run carrying the job id; the job's own status is read at render time. Neither changes
 * next_run. `botReady()` says whether bots run here at all (engine installed, runtime on): a job
 * nobody will ever run is refused as cant-run, never reported as queued.
 */
export async function runScheduleNow(db, id, { now = Date.now(), botReady = async () => true } = {}) {
  const row = await rowOf(db, id);
  if (!row) return { ok: false, code: "not-found" };
  const kind = scheduleKind(row.task);
  if (kind === "briefing") return { ok: false, code: "owned" };
  if (kind === "system") return { ok: false, code: "not-runnable" };
  if (kind === "reminder") {
    const r = await runNow(db, row);
    return r.ok ? { ok: true, kind } : { ok: false, code: "delivery-failed", error: r.error };
  }
  const botId = String(row.task).trim().slice(BOTCRON_PREFIX.length);
  const spec = botSpec(row);
  if (!botId || isVoiceBotId(botId)) return { ok: false, code: "cant-run" };
  if (!spec.goal) return { ok: false, code: "cant-run" };
  let def = null;
  try { def = (await db.execute({ sql: "SELECT enabled FROM pi_bot_defs WHERE bot_id = ?", args: [botId] })).rows[0] || null; } catch { def = null; }
  if (!def || !Number(def.enabled)) return { ok: false, code: "cant-run" };
  if (!(await botReady())) return { ok: false, code: "cant-run", why: "no-runtime" };
  let queued;
  try { queued = (await db.execute({ sql: "SELECT job_id FROM bot_jobs WHERE schedule_id = ? AND status = 'queued' LIMIT 1", args: [id] })).rows[0]; } catch { return { ok: false, code: "cant-run" }; }
  if (queued) return { ok: true, kind, already: true, jobId: queued.job_id };
  const jobId = "job-" + now.toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  const deliver = spec.deliver_to == null ? null : typeof spec.deliver_to === "string" ? spec.deliver_to : JSON.stringify(spec.deliver_to);
  const stmts = [{
    // Coalesced in the same statement: no second job while one is still queued.
    // principal 'owner': "Run now" is the owner pressing the button on the Schedule page (plan decision 1).
    // Its one caller (dashboard/panels/schedule.js) refuses every POST unless isOwnerRequest, i.e. the
    // owner's LOCAL password session (local-session.js; an SSO or peer session gets 403), so the stamp
    // holds the Task 16 fix round 1 (I1) rule. A new caller must make the same check first.
    // A job the cron already queued stays as it is (NULL, not the owner's): the coalesce returns it.
    sql: `INSERT INTO bot_jobs (job_id, bot_id, goal, status, deliver_to, source, schedule_id, escalate, principal)
          SELECT ?, ?, ?, 'queued', ?, 'schedule', ?, ?, 'owner' WHERE NOT EXISTS (SELECT 1 FROM bot_jobs WHERE schedule_id = ? AND status = 'queued')`,
    args: [jobId, botId, String(spec.goal), deliver, id, spec.escalate ? 1 : 0, id],
  }];
  if (await hasRunsTable(db)) {
    stmts.push({
      sql: `INSERT INTO schedule_runs (schedule_id, scheduled_for, ran_at, status, source, job_id)
            SELECT ?, NULL, ?, 'ok', 'run-now', ? WHERE EXISTS (SELECT 1 FROM bot_jobs WHERE job_id = ?)`,
      args: [id, iso(now), jobId, jobId],
    });
  }
  const res = await db.batch(stmts, "write");
  if (!Number(res[0]?.rowsAffected || 0)) return { ok: true, kind, already: true };
  return { ok: true, kind, jobId };
}

/**
 * Delete a schedule and its run history in one transaction. Only the exact row the page showed
 * (id AND task), so a row whose type changed meanwhile is left alone; a bot routine only through
 * the pipeline:botcron: guard.
 */
export async function deleteScheduleRow(db, id) {
  const row = await rowOf(db, id);
  if (!row) return { ok: false, code: "not-found" };
  const kind = scheduleKind(row.task);
  if (kind === "briefing") return { ok: false, code: "owned" };
  const guard = kind === "bot_routine" ? " AND task LIKE 'pipeline:botcron:%'" : "";
  const ours = `EXISTS (SELECT 1 FROM schedules WHERE id = ? AND task = ?${guard})`;
  const stmts = [];
  if (await hasRunsTable(db)) stmts.push({ sql: `DELETE FROM schedule_runs WHERE schedule_id = ? AND ${ours}`, args: [id, id, row.task] });
  // A routine's jobs still waiting in the queue go with it (running and finished ones stay as history).
  if (kind === "bot_routine" && (await hasBotJobs(db))) stmts.push({ sql: `DELETE FROM bot_jobs WHERE schedule_id = ? AND status = 'queued' AND ${ours}`, args: [id, id, row.task] });
  stmts.push({ sql: `DELETE FROM schedules WHERE id = ? AND task = ?${guard}`, args: [id, row.task] });
  const res = await db.batch(stmts, "write");
  return Number(res.at(-1)?.rowsAffected || 0) > 0 ? { ok: true, row } : { ok: false, code: "not-found" };
}

async function hasBotJobs(db) {
  try { return (await db.execute({ sql: "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'bot_jobs'", args: [] })).rows.length > 0; } catch { return false; }
}

/**
 * A strip fix that settles a run (Run now on a missed or failed run, Turn back on after an
 * upgrade pause) claims that run first: acknowledged_at is set only if it was still open and the
 * run belongs to this schedule. → true when this request claimed it. A second click (or a
 * second tab) finds it claimed and does nothing, so a reminder is never sent twice.
 */
export async function claimRun(db, runId, scheduleId, { now = Date.now() } = {}) {
  if (!Number.isInteger(runId) || runId <= 0 || !(await hasRunsTable(db))) return false;
  const r = await db.execute({ sql: "UPDATE schedule_runs SET acknowledged_at = ? WHERE id = ? AND schedule_id = ? AND acknowledged_at IS NULL", args: [iso(now), runId, scheduleId] });
  return Number(r.rowsAffected || 0) === 1;
}

/** Undo a claim when the fix itself failed, so the problem stays in the strip. */
export async function releaseRun(db, runId) {
  await db.execute({ sql: "UPDATE schedule_runs SET acknowledged_at = NULL WHERE id = ?", args: [runId] });
}

/** Dismiss a run (a missed window, a failure, an upgrade pause): it leaves the strip. */
export async function ackRun(db, runId, { now = Date.now() } = {}) {
  if (!Number.isInteger(runId) || runId <= 0 || !(await hasRunsTable(db))) return { ok: false, code: "not-found" };
  const r = await db.execute({ sql: "UPDATE schedule_runs SET acknowledged_at = COALESCE(acknowledged_at, ?) WHERE id = ?", args: [iso(now), runId] });
  if (!Number(r.rowsAffected || 0)) return { ok: false, code: "not-found" };
  const s = (await db.execute({ sql: "SELECT schedule_id FROM schedule_runs WHERE id = ?", args: [runId] })).rows[0];
  return { ok: true, scheduleId: s ? Number(s.schedule_id) : null };
}
