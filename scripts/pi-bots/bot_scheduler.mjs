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
import { generateJobId, ensureBotJobsSchema } from "./job_runner.mjs";
import { botsDbPath } from "./instance-paths.mjs";
import { isVoiceBotId } from "../../servers/shared/voice-bot.js";

export const BOTCRON_PREFIX = "pipeline:botcron:";

// Lazy self-heal of bot_jobs (a fired schedule INSERTs one) — once per process.
// Shares job_runner.mjs's PRAGMA table_info → ALTER-missing-columns → DDL ensure
// (no import cycle: job_runner.mjs never imports this module) so a legacy
// bot_jobs table (no card_id) is migrated in place instead of throwing
// "no such column: card_id" from BOT_JOBS_DDL's partial index.
let _botJobsEnsured = false;
function dbConn() {
  const d = new Database(botsDbPath());
  d.pragma("busy_timeout = 10000");
  if (!_botJobsEnsured) { try { ensureBotJobsSchema(d); _botJobsEnsured = true; } catch {} }
  return d;
}

/** Next cron occurrence as ISO, or null on an unparseable expression. */
export function computeNextRun(cronExpression, fromDate = new Date()) {
  try {
    return CronExpressionParser.parse(cronExpression, { currentDate: fromDate }).next().toISOString();
  } catch { return null; }
}

/**
 * Missed-run grace (owner decision, 2026-10-21): a repeating bot-cron schedule
 * runs late only when its latest due occurrence is at most GRACE old. Beyond
 * that the run is missed: no catch-up, recorded and notified once. Grace is
 * the tolerance for a quick restart or a slow tick, not catch-up.
 * CROW_SCHEDULE_GRACE_MIN, clamped 1..60, default 5.
 */
export function botcronGraceMs(env = process.env) {
  const n = Number(env.CROW_SCHEDULE_GRACE_MIN);
  const min = Number.isFinite(n) && String(env.CROW_SCHEDULE_GRACE_MIN ?? "").trim() !== "" ? Math.min(60, Math.max(1, n)) : 5;
  return min * 60000;
}

/** Cap on the occurrences counted in one missed window. */
export const MISSED_COUNT_CAP = 500;

/**
 * Settle one due repeating schedule (pure). Never assumes `next_run` sits on
 * the cron grid: `due` itself always counts as an occurrence.
 *   last  = the latest occurrence in [due, now] (cron prev() of now, or `due`)
 *   count = occurrences in [due, now], stopped at MISSED_COUNT_CAP (`capped`);
 *           the cap bounds only the count, never which occurrence is `last`
 *   fire  = now - last <= grace (run once now; any earlier ones are skipped)
 *   nextRun = the next occurrence strictly after now (null for a bad cron)
 * A bad cron has one occurrence (`due`) and no next run.
 */
export function settleBotcron(cronExpression, dueIso, nowIso, graceMs) {
  const due = Date.parse(dueIso);
  const now = Date.parse(nowIso);
  let last = due;
  let count = 1;
  let capped = false;
  let nextRun = null;
  try {
    const prev = CronExpressionParser.parse(cronExpression, { currentDate: new Date(now + 1) }).prev().getTime();
    if (prev >= due) last = prev;
    const it = CronExpressionParser.parse(cronExpression, { currentDate: new Date(due) });
    for (;;) {
      const t = it.next().getTime();
      if (t > now) break;
      if (count >= MISSED_COUNT_CAP) { capped = true; break; }
      count++;
    }
    nextRun = computeNextRun(cronExpression, new Date(now));
  } catch { /* unparseable: one occurrence, no next run */ }
  return {
    fire: now - last <= graceMs,
    first: new Date(due).toISOString(),
    last: new Date(last).toISOString(),
    count, capped, nextRun,
  };
}

const fmtWhen = (iso) => {
  try {
    return new Date(iso).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  } catch { return iso; }
};

/**
 * The notification(s) for the missed windows one sweep recorded: one window →
 * "Missed: <bot> routine" with its time(s); two or more → one summary.
 * Returns createNotification option objects (pure, for tests).
 */
export function missedNotifications(windows) {
  if (!Array.isArray(windows) || windows.length === 0) return [];
  const base = { type: "system", source: "scheduler:missed" };
  if (windows.length === 1) {
    const w = windows[0];
    const name = w.bot_name || w.bot_id;
    const when = w.count === 1
      ? `Due ${fmtWhen(w.first)}`
      : `${w.capped ? `${w.count} or more` : w.count} runs due ${fmtWhen(w.first)} to ${fmtWhen(w.last)}`;
    return [{
      ...base,
      title: `Missed: ${name} routine`,
      body: `${when} while Crow wasn't running. Missed runs are not made up; the routine continues on its normal schedule.`,
      action_url: `/dashboard/bot-builder?bot=${encodeURIComponent(w.bot_id)}`,
      schedule_id: w.schedule_id,
      metadata: { missed: w },
    }];
  }
  const names = windows.map((w) => w.bot_name || w.bot_id);
  return [{
    ...base,
    title: `${windows.length} bot routines missed runs while Crow wasn't running`,
    body: `${names.join(", ")}. Missed runs are not made up; each routine continues on its normal schedule.`,
    action_url: "/dashboard/bot-builder",
    metadata: { missed: windows },
  }];
}

/**
 * Default notifier: writes the notification(s) through the shared
 * createNotification on a short-lived busy_timeout-only connection (never
 * createDbClient, which would flip the journal mode of a bots crow.db).
 */
async function defaultNotify(windows) {
  const notes = missedNotifications(windows);
  if (notes.length === 0) return;
  const { createNotification } = await import("../../servers/shared/notifications.js");
  const raw = new Database(botsDbPath());
  raw.pragma("busy_timeout = 10000");
  const client = {
    async execute(arg) {
      const sql = typeof arg === "string" ? arg : arg.sql;
      const args = typeof arg === "string" ? [] : (arg.args || []);
      const st = raw.prepare(sql);
      if (st.reader) return { rows: st.all(...args), rowsAffected: 0, lastInsertRowid: 0 };
      const info = st.run(...args);
      return { rows: [], rowsAffected: info.changes, lastInsertRowid: info.lastInsertRowid };
    },
  };
  try { for (const n of notes) await createNotification(client, n); }
  finally { try { raw.close(); } catch {} }
}

/** In-flight guard so a slow tick never double-fires the same schedule. */
const inflight = new Set();

/**
 * Atomically claim one due schedule row and, within grace, enqueue its job. Safe across
 * processes: the advance is a single autocommit UPDATE guarded by the next_run
 * value that was selected (and enabled=1), so of N tickers racing on the same
 * stale row exactly one sees changes === 1 and enqueues. Advance FIRST: an
 * INSERT failure does not undo the advance (no retry every tick).
 * Returns true only when this call enqueued a job. False means another ticker
 * claimed it, OR this call claimed and advanced it but enqueued nothing (missing
 * bot/goal, voice bot, the schedule's previous run is still queued, or the run
 * was missed: overdue beyond grace, no catch-up). A missed window is handed to
 * `opts.onMissed` (only the claimer sees it, so it is reported once).
 */
export function claimAndEnqueue(d, s, nowIso, log = () => {}, { graceMs = botcronGraceMs(), onMissed = null } = {}) {
  const settle = settleBotcron(s.cron_expression, s.next_run || nowIso, nowIso, graceMs);
  const next = settle.nextRun;
  const res = d.prepare(
    "UPDATE schedules SET last_run=?, next_run=?, updated_at=datetime('now') " +
    "WHERE id=? AND next_run IS ? AND enabled=1"
  ).run(nowIso, next, s.id, s.next_run ?? null);
  if (res.changes !== 1) return false; // another ticker claimed it, or it changed

  const botId = s.task.slice(BOTCRON_PREFIX.length);
  let spec = {};
  try { spec = JSON.parse(s.description || "{}"); } catch { spec = {}; }
  if (!botId || !spec.goal) { log(`schedule #${s.id} missing bot/goal — advanced, not enqueued`); return false; }
  if (isVoiceBotId(botId)) { log(`schedule #${s.id} targets the voice bot, which cannot take background jobs — advanced, not enqueued`); return false; }
  if (!settle.fire) {
    // TODO(schedule panel, PR 4 in the private engineering notes): record this
    // window as a `missed` row in schedule_runs once that table is on main.
    log(`schedule #${s.id} (bot=${botId}) missed ${settle.capped ? settle.count + "+" : settle.count} run(s) ${settle.first} → ${settle.last}; not run (no catch-up)`);
    if (next === null) log(`schedule #${s.id} has an unparseable cron expression — will not tick again`);
    if (onMissed) onMissed({ schedule_id: s.id, bot_id: botId, first: settle.first, last: settle.last, count: settle.count, capped: settle.capped });
    return false;
  }
  if (settle.count > 1) log(`schedule #${s.id} (bot=${botId}) running the occurrence of ${settle.last}; ${settle.count - 1} earlier one(s) skipped`);
  // Coalesce: a schedule whose previous run has not started yet gets no second
  // queued copy (a slow drain never builds a backlog of the same run).
  const pending = d.prepare("SELECT job_id FROM bot_jobs WHERE schedule_id=? AND status='queued' LIMIT 1").get(s.id);
  if (pending) { log(`schedule #${s.id} (bot=${botId}) previous run still queued (${pending.job_id}), skipped — advanced, not enqueued`); return false; }

  const jobId = generateJobId();
  const deliver = spec.deliver_to == null ? null
    : (typeof spec.deliver_to === "string" ? spec.deliver_to : JSON.stringify(spec.deliver_to));
  d.prepare(
    "INSERT INTO bot_jobs (job_id, bot_id, goal, status, deliver_to, source, schedule_id, escalate) " +
    "VALUES (?,?,?,'queued',?,?,?,?)"
  ).run(jobId, botId, spec.goal, deliver, "schedule", s.id, spec.escalate ? 1 : 0);
  log(`schedule #${s.id} (bot=${botId}) → enqueued job ${jobId}`);
  if (next === null) log(`schedule #${s.id} has an unparseable cron expression — ran once, will not tick again`);
  return true;
}

/**
 * One poll tick: enqueue a bot_jobs row for every due bot-cron schedule within
 * grace; a schedule overdue beyond grace is advanced and reported as missed.
 * Pure DB (no pi). Returns { fired, missed }. The missed windows of this sweep
 * go to ONE `notify(windows)` call after the loop (default: write the
 * notification(s)); a notifier error is logged and never undoes a claim.
 */
export function tickBotSchedules({ log = () => {}, notify = defaultNotify, graceMs = botcronGraceMs() } = {}) {
  const d = dbConn();
  const windows = [];
  try {
    const now = new Date().toISOString();
    let rows = [];
    try {
      rows = d.prepare(
        "SELECT id, task, cron_expression, description, next_run FROM schedules " +
        "WHERE enabled=1 AND task LIKE ? AND next_run IS NOT NULL AND next_run <= ?"
      ).all(BOTCRON_PREFIX + "%", now);
    } catch { return { fired: 0, missed: 0 }; } // schedules table absent — nothing to do

    let fired = 0;
    for (const s of rows) {
      if (inflight.has(s.id)) { log(`schedule #${s.id} still in-flight — skip`); continue; }
      inflight.add(s.id);
      try {
        if (claimAndEnqueue(d, s, now, log, { graceMs, onMissed: (w) => windows.push(w) })) fired++;
      } catch (e) {
        log(`schedule #${s.id} error: ${(e && e.message) || e}`);
      } finally {
        inflight.delete(s.id);
      }
    }
    for (const w of windows) {
      try { w.bot_name = d.prepare("SELECT display_name FROM pi_bot_defs WHERE bot_id=?").get(w.bot_id)?.display_name || null; }
      catch { w.bot_name = null; }
    }
    return { fired, missed: windows.length };
  } finally {
    d.close();
    if (windows.length && notify) {
      const fail = (e) => log(`missed-run notification failed (non-fatal): ${(e && e.message) || e}`);
      try { const p = notify(windows); if (p && typeof p.catch === "function") p.catch(fail); }
      catch (e) { fail(e); }
    }
  }
}

// CLI: one-shot tick for ops / verification.
if (import.meta.url === "file://" + process.argv[1]) {
  const log = (m) => console.error("[bot-scheduler] " + m);
  const r = tickBotSchedules({ log });
  console.log(JSON.stringify(r));
  process.exit(0);
}
