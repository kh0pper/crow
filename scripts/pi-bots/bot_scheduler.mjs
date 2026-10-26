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

/** Default heartbeat slack; the ticker passes max(this, its poll interval). */
export const ALIVE_SLACK_MS = 2 * 60000;

/**
 * Settle one due repeating schedule (pure). Never assumes `next_run` sits on
 * the cron grid: `due` itself always counts as an occurrence. An unparseable
 * `next_run` counts as due now.
 *   L (fireAt) = the latest occurrence in [due, now] (cron prev() of now, or `due`)
 *   n          = occurrences in [due, now]
 *   fire       = now - L <= grace, OR this process was alive around `due`
 *                (`aliveAt`, its own last successful sweep, >= due - aliveSlackMs):
 *                past grace that is a LATE fire (`late`), since a stall, clock
 *                jump or host suspend inside a live process is not "missed
 *                while Crow wasn't running".
 *   missed     = the window that is not run, or null:
 *                firing:  n > 1 ? { first: due, last: max(due, prev(L)), count: n-1 } : null
 *                missing: { first: due, last: L, count: n }
 *                `count` stops at MISSED_COUNT_CAP (`capped`); the cap never
 *                changes which occurrence is L or `last`.
 *   nextRun    = the next occurrence strictly after now (null for a bad cron,
 *                which has one occurrence, `due`)
 */
export function settleBotcron(cronExpression, dueIso, nowIso, graceMs, { aliveAt = null, aliveSlackMs = ALIVE_SLACK_MS } = {}) {
  const now = Date.parse(nowIso);
  let due = Date.parse(dueIso);
  if (!Number.isFinite(due)) due = now;
  let last = due;
  let n = 1;
  let nextRun = null;
  let prevOfLast = null;
  const LIMIT = MISSED_COUNT_CAP + 2; // enough to tell "more than the cap" for n and n-1
  try {
    const prev = CronExpressionParser.parse(cronExpression, { currentDate: new Date(now + 1) }).prev().getTime();
    if (prev >= due) last = prev;
    const it = CronExpressionParser.parse(cronExpression, { currentDate: new Date(due) });
    while (n < LIMIT) {
      const t = it.next().getTime();
      if (t > now) break;
      n++;
    }
    if (last > due) prevOfLast = CronExpressionParser.parse(cronExpression, { currentDate: new Date(last) }).prev().getTime();
    nextRun = computeNextRun(cronExpression, new Date(now));
  } catch { /* unparseable: one occurrence, no next run */ }
  const aliveMs = aliveAt == null ? NaN : (typeof aliveAt === "number" ? aliveAt : Date.parse(aliveAt));
  const alive = Number.isFinite(aliveMs) && aliveMs >= due - aliveSlackMs;
  const inGrace = now - last <= graceMs;
  const fire = inGrace || alive;
  const window = (lastMs, k) => ({
    first: new Date(due).toISOString(),
    last: new Date(lastMs).toISOString(),
    count: Math.min(k, MISSED_COUNT_CAP),
    capped: k > MISSED_COUNT_CAP,
  });
  let missed = null;
  if (!fire) missed = window(last, n);
  else if (n > 1) missed = window(Math.max(due, prevOfLast ?? due), n - 1);
  return {
    fire,
    late: !inGrace && alive,
    fireAt: new Date(last).toISOString(),
    count: Math.min(n, MISSED_COUNT_CAP),
    missed,
    nextRun,
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
  // TODO(schedule panel, PR 1 in the private engineering notes): translate these
  // strings through instanceLang() once that helper lands.
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
export function claimAndEnqueue(d, s, nowIso, log = () => {}, { graceMs = botcronGraceMs(), onMissed = null, aliveAt = null, aliveSlackMs = ALIVE_SLACK_MS } = {}) {
  const settle = settleBotcron(s.cron_expression, s.next_run || nowIso, nowIso, graceMs, { aliveAt, aliveSlackMs });
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
  if (settle.missed) {
    // TODO(schedule panel, PR 4 in the private engineering notes): record this
    // window as a `missed` row in schedule_runs once that table is on main.
    const m = settle.missed;
    log(`schedule #${s.id} (bot=${botId}) missed ${m.capped ? m.count + "+" : m.count} run(s) ${m.first} → ${m.last}; not run (no catch-up)`);
    if (onMissed) onMissed({ schedule_id: s.id, bot_id: botId, ...m });
  }
  if (!settle.fire) {
    if (next === null) log(`schedule #${s.id} has an unparseable cron expression — will not tick again`);
    return false;
  }
  if (settle.late) log(`schedule #${s.id} (bot=${botId}) running late: due ${settle.fireAt}, this process was ticking around then`);
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
 * go to ONE `notify(windows)` call after the loop. `aliveAt` (ms or ISO) is the
 * caller's own last successful sweep; null (a first sweep after boot, the CLI)
 * means "not alive around due" (default: write the
 * notification(s)); a notifier error is logged and never undoes a claim.
 */
export function tickBotSchedules({
  log = () => {}, notify = defaultNotify, graceMs = botcronGraceMs(),
  aliveAt = null, aliveSlackMs = ALIVE_SLACK_MS, now: nowOpt = null,
} = {}) {
  const d = dbConn();
  const windows = [];
  let notified = Promise.resolve();
  // `notified` resolves (never rejects) once the notifier is done; non-enumerable
  // so the CLI's JSON output stays { fired, missed }.
  const result = (r) => Object.defineProperty(r, "notified", { get: () => notified, enumerable: false });
  try {
    const now = nowOpt == null ? new Date().toISOString() : new Date(nowOpt).toISOString();
    let rows = [];
    try {
      rows = d.prepare(
        "SELECT id, task, cron_expression, description, next_run FROM schedules " +
        "WHERE enabled=1 AND task LIKE ? AND next_run IS NOT NULL AND next_run <= ?"
      ).all(BOTCRON_PREFIX + "%", now);
    } catch { return result({ fired: 0, missed: 0 }); } // schedules table absent — nothing to do

    let fired = 0;
    for (const s of rows) {
      if (inflight.has(s.id)) { log(`schedule #${s.id} still in-flight — skip`); continue; }
      inflight.add(s.id);
      try {
        if (claimAndEnqueue(d, s, now, log, { graceMs, aliveAt, aliveSlackMs, onMissed: (w) => windows.push(w) })) fired++;
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
    return result({ fired, missed: windows.length });
  } finally {
    d.close();
    if (windows.length && notify) {
      const fail = (e) => log(`missed-run notification failed (non-fatal): ${(e && e.message) || e}`);
      try { notified = Promise.resolve(notify(windows)).then(() => {}, fail); }
      catch (e) { fail(e); }
    }
  }
}

// CLI: one-shot tick for ops / verification.
if (import.meta.url === "file://" + process.argv[1]) {
  const log = (m) => console.error("[bot-scheduler] " + m);
  (async () => {
    const r = tickBotSchedules({ log });
    await r.notified; // a claimed missed window is never dropped by exiting first
    console.log(JSON.stringify(r));
    process.exit(0);
  })();
}
