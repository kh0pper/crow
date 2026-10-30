/**
 * The moves streak (moves design Task 5; private engineering notes).
 *
 * A day counts when ANY of these is true for that local day:
 *   - a `movedone` row exists (a challenge was marked Done),
 *   - the counted steps reach the live step goal (stepsToday's rule: summed
 *     over devices, clamped at steps.max.day),
 *   - the day's `movelog` rows total at least STREAK_LOG_MINUTES minutes.
 *
 * A `moveoff` day (the user paused challenges) is SKIPPED: it neither counts
 * nor breaks. Today counts as soon as it qualifies, and a today that has not
 * qualified yet does not break the streak — the day is not over.
 *
 * ⚠ ORDERED BY DAY KEY, never by `created_at`, for the same reason eggs.js
 * layProgress is: instance-sync merges `created_at` to the MIN of two
 * instances, so a sync apply can move a timestamp backwards. Keys are local
 * days (`YYYY-MM-DD`) and sort lexically in true date order.
 *
 * The heart is a constant-delta `ramble_wallet` row keyed `streak:<day>`, so
 * the same day's award can only land once on any device and a re-delivery is
 * harmless (hearts.js: every heart row's delta is exactly 1).
 */
import { localDay } from "../eggs.js";
import { insertOnce, readStepSettings, STEPS_KIND } from "../steps.js";
import { HEART_KIND } from "../hearts.js";
import { MOVE_DONE_KIND, MOVE_LOG_KIND, EFFORTS } from "./ledger.js";
import { ACTIVITY_KINDS } from "./library.js";
import { MOVE_OFF_KIND } from "./today.js";

/** A heart every this many consecutive qualifying days. */
export const STREAK_HEART_EVERY = 7;
/** A day's self-reported logs count toward the streak at this many minutes. */
export const STREAK_LOG_MINUTES = 10;
/** Heart ledger key prefix: `streak:<day>`. */
export const STREAK_HEART_PREFIX = "streak:";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function asAt(now) {
  return Number.isFinite(Number(now)) ? Number(now) : Date.now();
}

/** The local day before `dayStr` (`YYYY-MM-DD`), DST-safe via local noon. */
function previousDay(dayStr) {
  const [y, m, d] = dayStr.split("-").map(Number);
  return localDay(new Date(y, m - 1, d - 1, 12, 0, 0).getTime());
}

/**
 * The current streak, read-only. `{ days, nextHeartAt, todayGood }`;
 * `nextHeartAt` is the multiple of seven the next heart sits on, so the panel
 * can render "3 more days" without importing the rule. `todayGood` says today
 * itself qualifies — `days` alone cannot, because a today that has not
 * qualified yet (or is paused) leaves the count at yesterday's value.
 */
export async function streakState(db, { now = Date.now() } = {}) {
  const at = asAt(now);
  const today = localDay(at);
  const settings = await readStepSettings(db);
  const { rows } = await db.execute({
    sql: "SELECT kind, key, delta FROM ramble_wallet WHERE kind IN (?, ?, ?, ?)",
    args: [MOVE_DONE_KIND, MOVE_OFF_KIND, MOVE_LOG_KIND, STEPS_KIND],
  });

  const done = new Set();
  const off = new Set();
  const steps = new Map();     // day -> steps credited
  const minutes = new Map();   // day -> self-reported minutes

  for (const r of rows || []) {
    const kind = String(r.kind);
    const key = String(r.key ?? "");
    if (kind === MOVE_DONE_KIND || kind === MOVE_OFF_KIND) {
      if (!DAY_RE.test(key)) continue;
      if (kind === MOVE_DONE_KIND) done.add(key);
      else off.add(key);
      continue;
    }
    const parts = key.split(":");
    const day = parts[0];
    if (!DAY_RE.test(day)) continue;
    if (kind === STEPS_KIND) {
      const n = Number(r.delta);
      if (!Number.isFinite(n) || n <= 0) continue;
      steps.set(day, (steps.get(day) ?? 0) + n);
    } else if (kind === MOVE_LOG_KIND) {
      // `<day>:<minuteOfDay>:<activity>:<minutes>:<effort>` (ledger.js).
      if (parts.length !== 5) continue;
      const [, , activity, mins, effort] = parts;
      if (!ACTIVITY_KINDS.includes(activity) || !EFFORTS.includes(effort)) continue;
      const n = Number(mins);
      if (!Number.isInteger(n) || n < 1) continue;
      minutes.set(day, (minutes.get(day) ?? 0) + n);
    }
  }

  const good = new Set(done);
  for (const [day, n] of steps) {
    // stepsToday clamps a day's total at the live cap before comparing it to
    // the goal; do the same, or a merged pair of instances could "pass" a goal
    // the panel shows as unmet.
    if (Math.min(settings.maxDay, n) >= settings.goal) good.add(day);
  }
  for (const [day, n] of minutes) {
    if (n >= STREAK_LOG_MINUTES) good.add(day);
  }

  let earliest = null;
  for (const day of [...done, ...off, ...steps.keys(), ...minutes.keys()]) {
    if (earliest === null || day < earliest) earliest = day;
  }
  const todayGood = good.has(today);
  if (earliest === null) return { days: 0, nextHeartAt: STREAK_HEART_EVERY, todayGood: false };

  let days = 0;
  let cursor = today;
  let first = true;
  // Bounded by the days that exist in the ledger (plus today); a day with no
  // rows is the break.
  for (let i = 0; i < 20_000; i += 1) {
    if (good.has(cursor)) days += 1;
    else if (off.has(cursor)) { /* paused: neither counts nor breaks */ }
    else if (first) { /* today may simply not be over yet */ }
    else break;
    first = false;
    if (cursor <= earliest) break;
    cursor = previousDay(cursor);
  }

  return { days, nextHeartAt: STREAK_HEART_EVERY, todayGood };
}

/**
 * Award the streak heart when today brings the streak to a multiple of seven.
 * `todayGood` is required, not just `days % 7`: streakState keeps `days`
 * unchanged while today has not qualified (or is paused), so the morning after
 * a heart — or a paused day — still reads seven and would otherwise pay a
 * second heart for a day that earned nothing. Idempotent by the key
 * (`streak:<day>`): calling twice on the same day awards once, and calling on
 * a non-multiple day awards nothing. A missed day later does not remove a
 * heart already earned — the ledger only grows.
 */
export async function awardStreakHeart(db, { now = Date.now(), emit } = {}) {
  const at = asAt(now);
  const { days, nextHeartAt, todayGood } = await streakState(db, { now: at });
  if (!todayGood || days <= 0 || days % nextHeartAt !== 0) {
    return { awarded: false, days, nextHeartAt, key: null };
  }
  const key = STREAK_HEART_PREFIX + localDay(at);
  const awarded = await insertOnce(db, HEART_KIND, key, 1, at, emit);
  return { awarded, days, nextHeartAt, key: awarded ? key : null };
}