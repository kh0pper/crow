/**
 * schedule-core — the pure rules behind Crow's schedules: what type a row is, which zone it runs
 * in, and what to do with a row whose time has come (fire it, or record that it was missed).
 *
 * No I/O and no clock: every function takes `now` (epoch ms). The database side lives in
 * servers/gateway/schedule-store.js; the scheduler loop in servers/gateway/scheduler.js.
 *
 * The type is DERIVED from the task text, never stored: a stored copy could disagree with the
 * task after an edit, and a memory server older than its database would write NULLs. Reminders
 * keep their `reminder:` prefix for good, which old co-hosted code already understands.
 */
import { CronExpressionParser } from "cron-parser";
import { validTimeZone } from "./relative-dates.js";

export const ONCE = "@once"; // one-shot rows: next_run is an absolute ISO time, never recomputed from cron
export const REMINDER_PREFIX = "reminder:";
export const BOTCRON_PREFIX = "pipeline:botcron:";
export const MISSED_CAP = 500; // a missed window counts at most this many occurrences ("500 or more")
const OK_MS = 90_000; // a fire within 90 s of its time is "ok"; later (inside grace) is "late"
/**
 * Default heartbeat slack: a ticker whose previous sweep started at most this long before `due`
 * (and before it) was up at `due`, so a late settle is a stall, not downtime. Each ticker passes
 * max(this, its poll interval) — the gateway scheduler adds its last tick's length too.
 */
export const ALIVE_SLACK_MS = 2 * 60_000;

/**
 * Rows a bundle owns: the gateway never delivers or flags them, and computes their next run in
 * the owner's zone. `zoneSetting` names the per-instance setting (a JSON object) that holds it.
 */
export const SCHEDULE_OWNERS = Object.freeze({
  "media:briefing": Object.freeze({ kind: "briefing", app: "News", tool: "crow_media_schedule_briefing", zoneSetting: Object.freeze({ key: "media_briefing_config", field: "tz" }) }),
});

/** "reminder" | "bot_routine" | "briefing" | "system". */
export function scheduleKind(task) {
  const t = String(task ?? "").trim();
  if (t.startsWith(BOTCRON_PREFIX)) return "bot_routine";
  if (t.startsWith("pipeline:")) return "system"; // never delivered, never run by hand
  if (Object.hasOwn(SCHEDULE_OWNERS, t)) return SCHEDULE_OWNERS[t].kind;
  return "reminder";
}

/** The words a reminder says: the task without an optional leading `reminder:`. */
export function reminderText(task) {
  const t = String(task ?? "").trim();
  return (t.startsWith(REMINDER_PREFIX) ? t.slice(REMINDER_PREFIX.length) : t).trim();
}

export function hostZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

/** The zone a row runs in: its own if valid, else the fallback (the instance zone), else the host's. */
export function zoneFor(tz, fallback) {
  return validTimeZone(tz) || validTimeZone(fallback) || hostZone();
}

function parse(expr, zone, at) {
  return CronExpressionParser.parse(String(expr), { tz: zoneFor(zone), currentDate: new Date(at) });
}

const wallFmt = new Map();
/** "YYYY-MM-DD HH:MM" wall-clock time of `ms` in `zone`. */
function wall(ms, zone) {
  let f = wallFmt.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    wallFmt.set(zone, f);
  }
  return f.format(new Date(ms));
}

/**
 * The second pass of a wall-clock minute that happens twice (clocks going back) is not an
 * occurrence: a job fires once, the first time. cron-parser's next() agrees; its prev() does not.
 */
function isRepeat(ms, zone) {
  const w = wall(ms, zone);
  return w === wall(ms - 3_600_000, zone) || w === wall(ms - 1_800_000, zone);
}

/** The latest real occurrence strictly before `before`. */
function prevReal(expr, zone, before) {
  const it = parse(expr, zone, before);
  for (let k = 0; k < 4; k++) {
    const p = it.prev().getTime();
    if (!isRepeat(p, zoneFor(zone))) return p;
  }
  return null;
}

/**
 * The first occurrence strictly after `from` (ms), or null for an unparseable expression.
 *
 * cron-parser 5.5.0's next() skips the whole spring-forward day when it starts before the change
 * ("0 9 * * *" in America/Chicago from 2026-03-07 20:00Z returns 03-09, not 03-08), while prev()
 * is right there. So the candidate is checked backwards: while a real occurrence exists between
 * `from` and it, that one is the answer.
 */
export function cronNext(expr, zone, from) {
  try {
    let c = parse(expr, zone, from).next().getTime();
    for (let k = 0; k < 4; k++) {
      const p = prevReal(expr, zone, c);
      if (p !== null && p > from && p < c) c = p; else break;
    }
    return c;
  } catch { return null; }
}

/** The latest occurrence at or before `at` (ms), or null. */
export function cronPrev(expr, zone, at) {
  try { return prevReal(expr, zone, at + 1); } catch { return null; }
}

/** How many occurrences fall in (after, to], counting at most `cap`. */
export function countGrid(expr, zone, after, to, cap = MISSED_CAP) {
  let n = 0, t = after;
  while (n < cap) {
    t = cronNext(expr, zone, t);
    if (t === null || t > to) return { n, capped: false };
    n++;
  }
  const more = cronNext(expr, zone, t);
  return { n, capped: cap > 0 && more !== null && more <= to };
}

const WEEK_MIN = 7 * 1440;

/**
 * How often a schedule runs, in minutes: the average gap over the next week, so "0,30 9 * * *"
 * (twice a day, half an hour apart) reads 720, not 30. Under an hour on average, it is the
 * shortest gap instead, which is the honest "every N minutes" for the usual step expressions.
 * Null if unparseable.
 */
export function cadenceMinutes(expr, zone, from) {
  const week = countGrid(expr, zone, from, from + WEEK_MIN * 60_000, 7 * 24 + 1);
  if (week.n === 0) return cronNext(expr, zone, from) === null ? null : WEEK_MIN;
  const avg = Math.floor(WEEK_MIN / week.n);
  if (avg >= 60) return avg;
  let prev = cronNext(expr, zone, from), best = Infinity;
  for (let i = 0; i < 12 && prev !== null; i++) {
    const t = cronNext(expr, zone, prev);
    if (t === null) break;
    best = Math.min(best, t - prev);
    prev = t;
  }
  return Number.isFinite(best) ? Math.min(avg, Math.round(best / 60_000)) : avg;
}

/** The tolerance that lets a run still fire after a short restart: env CROW_SCHEDULE_GRACE_MIN, 1–60, default 5. */
// The ONE grace rule for every Crow ticker (gateway reminders and pi-bot cron alike).
export function graceMs(env = process.env) {
  const raw = String(env?.CROW_SCHEDULE_GRACE_MIN ?? "").trim();
  const n = Number(raw);
  const min = raw === "" || !Number.isFinite(n) ? 5 : Math.min(60, Math.max(1, n));
  return min * 60_000;
}

const isoOf = (t) => (typeof t === "number" ? new Date(t).toISOString() : new Date(Date.parse(t)).toISOString());

/**
 * The schedule_runs row for one missed window, as {sql, args} for either SQLite client
 * (better-sqlite3: d.prepare(sql).run(...args); the gateway client: db.execute({sql, args})).
 * `window` is settleDue's `missed` ({first, last, count, capped}; ms or ISO). The unique
 * (schedule_id, scheduled_for) index makes a second write of the same window a no-op.
 * notified_at stays NULL: the gateway scheduler sends the one notice (mark first, then notify).
 */
export function missedRunInsert(scheduleId, window) {
  const detail = { last_missed: isoOf(window.last) };
  if (window.capped) detail.capped = true;
  return {
    sql: "INSERT OR IGNORE INTO schedule_runs (schedule_id, scheduled_for, status, source, missed_count, detail) VALUES (?, ?, 'missed', 'clock', ?, ?)",
    args: [scheduleId, isoOf(window.first), Math.min(Number(window.count) || 1, MISSED_CAP), JSON.stringify(detail)],
  };
}

/**
 * What to do with a row whose next_run has come. Never assumes next_run sits on the cron grid
 * (an older server, an operator or another zone may have written it): the stored time itself
 * always counts as an occurrence, and the latest occurrence comes from prev(), never from a
 * capped list.
 *
 * @param {{cron_expression:string, next_run:string|null, tz?:string|null}} row
 * @param {number} now epoch ms
 * A missing or unreadable next_run counts as due now (the bot-cron rule).
 *
 * @param {{graceMs:number, zone?:string, aliveAt?:number|null, aliveSlackMs?:number}} opts
 *   zone = the fallback (instance) zone; aliveAt = when this process's previous sweep started
 * @returns {null | { fire:number|null, status:'ok'|'late'|null, late:boolean,
 *   missed:{first:number,last:number,count:number,capped:boolean}|null, nextRun:number|null }}
 */
export function settleDue(row, now, { graceMs: grace, zone, aliveAt = null, aliveSlackMs = ALIVE_SLACK_MS } = {}) {
  let due = Date.parse(row?.next_run ?? "");
  if (!Number.isFinite(due)) due = now;
  if (due > now) return null;
  const statusOf = (t) => (now - t <= OK_MS ? "ok" : "late");

  if (row.cron_expression === ONCE) {
    // One-shots always fire, late if need be (owner decision 2026-10-26; keeps #546).
    return { fire: due, status: statusOf(due), late: now - due > grace, missed: null, nextRun: null };
  }

  const z = zoneFor(row.tz, zone);
  const g = cronPrev(row.cron_expression, z, now);
  const latest = g !== null && g >= due ? g : due;
  // Count one past the cap, so "capped" means MORE than MISSED_CAP occurrences in the window.
  const grid = countGrid(row.cron_expression, z, due, now, MISSED_CAP + 1);
  const total = 1 + grid.n;
  const win = (first, last, k) => ({ first, last, count: Math.min(k, MISSED_CAP), capped: k > MISSED_CAP });
  const nextRun = cronNext(row.cron_expression, z, now);
  // aliveAt < due: a previous tick that started AFTER `due` (a row re-enabled with an old
  // next_run) proves nothing about `due`.
  // A next_run whose time came before this process's previous sweep even started (a row re-enabled
  // with an old next_run) is not a stall: it stays missed (no late catch-up for repeating runs).
  const alive = Number.isFinite(aliveAt) && aliveAt < due && aliveAt >= due - aliveSlackMs;
  const inGrace = now - latest <= grace;

  if (inGrace || alive) {
    let missed = null;
    if (total > 1) {
      const before = cronPrev(row.cron_expression, z, latest - 1);
      missed = win(due, Math.max(due, before ?? due), total - 1);
    }
    return { fire: latest, status: statusOf(latest), late: !inGrace, missed, nextRun };
  }
  return { fire: null, status: null, late: false, missed: win(due, latest, total), nextRun };
}
