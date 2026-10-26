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
import { generateJobId, ensureBotJobsSchema } from "./job_runner.mjs";
import { botsDbPath } from "./instance-paths.mjs";
import { isVoiceBotId } from "../../servers/shared/voice-bot.js";
import { BOTCRON_PREFIX, settleDue, graceMs, ALIVE_SLACK_MS, missedRunInsert, cronNext } from "../../servers/shared/schedule-core.js";

export { BOTCRON_PREFIX };

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

/** Next cron occurrence as ISO (host zone unless `zone` is given), or null on an unparseable expression. */
export function computeNextRun(cronExpression, fromDate = new Date(), zone = null) {
  const t = cronNext(cronExpression, zone, fromDate.getTime());
  return t === null ? null : new Date(t).toISOString();
}

/** In-flight guard so a slow tick never double-fires the same schedule. */
const inflight = new Set();

/**
 * Atomically claim one due schedule row and, when the shared rule says it
 * fires, enqueue its job. What to do comes from schedule-core's settleDue, the
 * ONE rule every Crow ticker uses (missed repeating runs are never made up):
 *   fire  → enqueue one job for the latest occurrence (late when past grace on a
 *           live heartbeat); any earlier occurrences are a missed window
 *   !fire → nothing runs; the whole window is missed
 * The claim is a single autocommit UPDATE guarded by the next_run value that was
 * selected (and enabled=1): of N tickers racing on the same row exactly one sees
 * changes === 1. Only that claimer records the missed window (a schedule_runs
 * row via missedRunInsert, on the same connection); the gateway scheduler's
 * sweep sends the one notice. Advance FIRST: an INSERT failure does not undo
 * the advance (no retry every tick).
 * Returns true only when this call enqueued a job. `onMissed(window)` is called
 * (claimer only) for a missed window, whether or not the row could be written.
 */
export function claimAndEnqueue(d, s, nowIso, log = () => {}, {
  graceMs: grace = graceMs(), aliveAt = null, aliveSlackMs = ALIVE_SLACK_MS, zone, onMissed = null,
} = {}) {
  const now = Date.parse(nowIso);
  const settle = settleDue(
    { cron_expression: s.cron_expression, next_run: s.next_run, tz: s.tz ?? null },
    now, { graceMs: grace, aliveAt, aliveSlackMs, zone },
  );
  if (!settle) return false; // not due (next_run in the future)
  const next = settle.nextRun == null ? null : new Date(settle.nextRun).toISOString();
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
    const m = settle.missed;
    log(`schedule #${s.id} (bot=${botId}) missed ${m.capped ? m.count + "+" : m.count} run(s) ` +
      `${new Date(m.first).toISOString()} → ${new Date(m.last).toISOString()}; not run (no catch-up)`);
    if (onMissed) onMissed(m);
    try {
      const { sql, args } = missedRunInsert(s.id, m);
      d.prepare(sql).run(...args);
    } catch (e) {
      // A DB that has not run the schedule_runs migration yet: the window is logged only.
      log(`schedule #${s.id} missed window not recorded: ${(e && e.message) || e}`);
    }
  }
  if (settle.fire == null) {
    if (next === null) log(`schedule #${s.id} has an unparseable cron expression — will not tick again`);
    return false;
  }
  if (settle.late) log(`schedule #${s.id} (bot=${botId}) running late: due ${new Date(settle.fire).toISOString()}, this process was ticking around then`);
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
 * One poll tick: settle every due bot-cron schedule (enqueue, or record a
 * missed window). Pure DB (no pi). Returns { fired, missed }: jobs enqueued and
 * missed windows recorded by this tick. `aliveAt` (ms) is the caller's own last
 * successful sweep; null (a first sweep after boot, the CLI) means "not alive
 * around due". Notices for missed windows come from the gateway scheduler's
 * sweep (or the CLI's own sweep when no gateway ticker holds the lease).
 */
export function tickBotSchedules({
  log = () => {}, graceMs: grace = graceMs(), aliveAt = null, aliveSlackMs = ALIVE_SLACK_MS, now: nowOpt = null, zone,
} = {}) {
  const d = dbConn();
  try {
    const now = nowOpt == null ? new Date().toISOString() : new Date(nowOpt).toISOString();
    let rows = [];
    try {
      const hasTz = d.prepare("PRAGMA table_info(schedules)").all().some((c) => c.name === "tz");
      rows = d.prepare(
        `SELECT id, task, cron_expression, description, next_run${hasTz ? ", tz" : ""} FROM schedules ` +
        "WHERE enabled=1 AND task LIKE ? AND next_run IS NOT NULL AND next_run <= ?"
      ).all(BOTCRON_PREFIX + "%", now);
    } catch { return { fired: 0, missed: 0 }; } // schedules table absent — nothing to do

    let fired = 0;
    let missed = 0;
    for (const s of rows) {
      if (inflight.has(s.id)) { log(`schedule #${s.id} still in-flight — skip`); continue; }
      inflight.add(s.id);
      try {
        if (claimAndEnqueue(d, s, now, log, { graceMs: grace, aliveAt, aliveSlackMs, zone, onMissed: () => missed++ })) fired++;
      } catch (e) {
        log(`schedule #${s.id} error: ${(e && e.message) || e}`);
      } finally {
        inflight.delete(s.id);
      }
    }
    return { fired, missed };
  } finally { d.close(); }
}

/**
 * Small libsql-shaped adapter (async execute → {rows, rowsAffected, lastInsertRowid})
 * over a busy_timeout-only better-sqlite3 connection, so gateway helpers that
 * expect the gateway client can run here without createDbClient (which would
 * flip a bots crow.db's journal mode).
 */
export function asyncClient(raw) {
  return {
    async execute(arg) {
      const sql = typeof arg === "string" ? arg : arg.sql;
      const args = typeof arg === "string" ? [] : (arg.args || []);
      const st = raw.prepare(sql);
      if (st.reader) return { rows: st.all(...args), rowsAffected: 0, lastInsertRowid: 0 };
      const info = st.run(...args);
      return { rows: [], rowsAffected: info.changes, lastInsertRowid: info.lastInsertRowid };
    },
  };
}

/**
 * The one-shot CLI tick. After the tick, if no gateway ticker holds this
 * instance's bot-cron lease, nothing else will send the notices for the windows
 * just recorded, so this run sweeps them itself (sweepMissedNotices, the same
 * mark-first-then-notify claim the gateway scheduler uses). With a live lease
 * the rows are left for that ticker's gateway sweep.
 * Seams: tick, leaseHeld(), sweep(client), openDb().
 */
export async function runCliTick({
  log = () => {},
  tick = tickBotSchedules,
  leaseHeld = null,
  sweep = null,
  openDb = () => { const r = new Database(botsDbPath()); r.pragma("busy_timeout = 10000"); return r; },
} = {}) {
  const r = tick({ log });
  const held = leaseHeld
    ? await leaseHeld()
    : (await import("./botcron-lease.mjs")).botcronLeaseHeld({ dir: (await import("./instance-paths.mjs")).botsDataDir() });
  if (held) {
    log("a live bot-cron ticker holds the lease; its gateway sends the missed-run notices");
    return { ...r, swept: false };
  }
  const doSweep = sweep || (async (client) => (await import("../../servers/gateway/scheduler.js")).sweepMissedNotices(client));
  const raw = openDb();
  try {
    const out = await doSweep(asyncClient(raw));
    const n = (out && Array.isArray(out.claimed)) ? out.claimed.length : 0;
    if (n) log(`sent the notice for ${n} missed/failed run(s)`);
  } catch (e) {
    log(`missed-run notice sweep failed (non-fatal): ${(e && e.message) || e}`);
  } finally { try { raw.close(); } catch {} }
  return { ...r, swept: true };
}

// CLI: one-shot tick for ops / verification.
if (import.meta.url === "file://" + process.argv[1]) {
  const log = (m) => console.error("[bot-scheduler] " + m);
  runCliTick({ log }).then((r) => { console.log(JSON.stringify(r)); process.exit(0); },
    (e) => { log("error: " + ((e && e.message) || e)); process.exit(1); });
}
