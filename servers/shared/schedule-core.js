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
const ALIVE_MS = 2 * 60_000; // this process ticked this close before `due`: a stall, not downtime

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

/** The shortest gap, in minutes, between the next few occurrences after `from` (null if unparseable). */
export function cadenceMinutes(expr, zone, from, samples = 12) {
  let prev = cronNext(expr, zone, from), best = Infinity;
  if (prev === null) return null;
  for (let i = 0; i < samples; i++) {
    const t = cronNext(expr, zone, prev);
    if (t === null) break;
    best = Math.min(best, t - prev);
    prev = t;
  }
  return Number.isFinite(best) ? Math.round(best / 60_000) : null;
}

/** The tolerance that lets a run still fire after a short restart: env CROW_SCHEDULE_GRACE_MIN, 1–60, default 5. */
export function graceMs(env = process.env) {
  const n = Number(env?.CROW_SCHEDULE_GRACE_MIN);
  const min = env?.CROW_SCHEDULE_GRACE_MIN === undefined || !Number.isFinite(n) ? 5 : Math.min(60, Math.max(1, n));
  return min * 60_000;
}

/**
 * What to do with a row whose next_run has come. Never assumes next_run sits on the cron grid
 * (an older server, an operator or another zone may have written it): the stored time itself
 * always counts as an occurrence, and the latest occurrence comes from prev(), never from a
 * capped list.
 *
 * @param {{cron_expression:string, next_run:string|null, tz?:string|null}} row
 * @param {number} now epoch ms
 * @param {{graceMs:number, zone?:string, aliveAt?:number|null}} opts zone = the fallback (instance) zone
 * @returns {null | { fire:number|null, status:'ok'|'late'|null, late:boolean,
 *   missed:{first:number,last:number,count:number,capped:boolean}|null, nextRun:number|null }}
 */
export function settleDue(row, now, { graceMs: grace, zone, aliveAt = null } = {}) {
  const due = Date.parse(row?.next_run ?? "");
  if (!Number.isFinite(due) || due > now) return null;
  const statusOf = (t) => (now - t <= OK_MS ? "ok" : "late");

  if (row.cron_expression === ONCE) {
    // One-shots always fire, late if need be (owner decision 2026-10-26; keeps #546).
    return { fire: due, status: statusOf(due), late: now - due > grace, missed: null, nextRun: null };
  }

  const z = zoneFor(row.tz, zone);
  const g = cronPrev(row.cron_expression, z, now);
  const latest = g !== null && g >= due ? g : due;
  const grid = countGrid(row.cron_expression, z, due, now, MISSED_CAP);
  const total = 1 + grid.n;
  const nextRun = cronNext(row.cron_expression, z, now);
  const alive = Number.isFinite(aliveAt) && aliveAt >= due - ALIVE_MS;

  if (now - latest <= grace || alive) {
    let missed = null;
    if (total > 1) {
      const before = cronPrev(row.cron_expression, z, latest - 1);
      missed = { first: due, last: Math.max(due, before ?? due), count: grid.capped ? MISSED_CAP : total - 1, capped: grid.capped };
    }
    return { fire: latest, status: statusOf(latest), late: false, missed, nextRun };
  }
  return { fire: null, status: null, late: false, missed: { first: due, last: latest, count: grid.capped ? MISSED_CAP : total, capped: grid.capped }, nextRun };
}
