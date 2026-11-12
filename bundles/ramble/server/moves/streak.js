/**
 * The moves streak (moves design Task 5 and the all-cards rule; private
 * engineering notes).
 *
 * TWO RULES, ONE PER SIDE OF THE UPGRADE DAY. A `movestreakv2` row marks the
 * first day the all-cards rule applied on an instance, and the OLDEST such row
 * (each instance writes its own) is where the rule starts for this reader:
 *
 *   before it — the old rule: a day counts when ANY of these is true for that
 *               local day:
 *                 - a `movedone` row exists (a challenge was marked Done),
 *                 - the counted steps reach the live step goal (stepsToday's
 *                   rule: summed over devices, clamped at steps.max.day),
 *                 - the day's `movelog` rows total at least STREAK_LOG_MINUTES
 *                   minutes.
 *   on or after it — the all-cards rule: the day counts only when it is one of
 *               `completeDays` (day-complete.js): its `moveneed` rows all
 *               finished and its `movebal` row. One card Done is not a day.
 *
 * With no `movestreakv2` row at all the old rule holds for every day, and a day
 * before the oldest one keeps it too, so an upgrade never rewrites the past.
 *
 * A `movestreakv2` ROW THAT ARRIVES LATER, carrying an EARLIER day, moves the
 * start of the all-cards rule earlier on every instance that receives it — the
 * reader takes the smallest key, whichever instance wrote it — so the days
 * between that day and this instance's own are re-judged by the all-cards rule
 * from then on. A heart already paid is NEVER taken back: the award is a
 * `streak:<day>` row that only grows, so a day a later start re-judges as a
 * break leaves the heart it already earned in place.
 *
 * A `moveoff` day (the user paused challenges) is SKIPPED: it neither counts
 * nor breaks. Today counts as soon as it qualifies, and a today that has not
 * qualified yet does not break the streak — the day is not over.
 *
 * ⚠ THE READ IS READ ONLY. `streakState` writes nothing, so the upgrade row is
 * written by the writers that may write (day.js `settleDay` on a complete day,
 * and the panel's day route) through `ensureStreakV2`, which writes it once per
 * instance and never again.
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
import { completeDays } from "./day-complete.js";

/**
 * Wallet kind: key `<day>`, delta 1 — the first day the all-cards rule applied
 * on the instance that wrote it. Written once per instance; instance-sync keeps
 * every instance's row, which is why the reader takes the SMALLEST key.
 */
export const STREAK_V2_KIND = "movestreakv2";

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
 * Record the day the all-cards rule starts on THIS instance, once.
 *
 * A WRITE path, and the only writer of `movestreakv2`: with no row of that kind
 * at all the day is written (`insertOnce`, so a re-delivery or a second call is
 * a no-op) and true is answered; with a row already there nothing is written.
 * The first day wins for the life of the instance, and a day string that is not
 * one writes nothing. The callers are the writers that may write — day.js
 * `settleDay` on a day it found complete, and the panel's day route — never
 * `streakState`, which stays read only.
 */
export async function ensureStreakV2(db, { day, emit, now = Date.now() } = {}) {
  const at = asAt(now);
  if (typeof day !== "string" || !DAY_RE.test(day)) return false;
  const { rows } = await db.execute({
    sql: "SELECT 1 FROM ramble_wallet WHERE kind = ? LIMIT 1",
    args: [STREAK_V2_KIND],
  });
  if (Array.isArray(rows) && rows.length > 0) return false;
  return insertOnce(db, STREAK_V2_KIND, day, 1, at, emit);
}

/**
 * The current streak, read-only. `{ days, nextHeartAt, todayGood }`;
 * `nextHeartAt` is the multiple of seven the next heart sits on, so the panel
 * can render "3 more days" without importing the rule. `todayGood` says today
 * itself qualifies — `days` alone cannot, because a today that has not
 * qualified yet (or is paused) leaves the count at yesterday's value.
 *
 * Each day is judged by the rule that applied to it: the old one before the
 * oldest `movestreakv2` key, the all-cards rule (`completeDays`) on and after
 * it, and the old one everywhere when there is no such key. Nothing here writes.
 */
export async function streakState(db, { now = Date.now() } = {}) {
  const at = asAt(now);
  const today = localDay(at);
  const settings = await readStepSettings(db);
  const { rows } = await db.execute({
    sql: "SELECT kind, key, delta FROM ramble_wallet WHERE kind IN (?, ?, ?, ?, ?)",
    args: [MOVE_DONE_KIND, MOVE_OFF_KIND, MOVE_LOG_KIND, STEPS_KIND, STREAK_V2_KIND],
  });

  const done = new Set();
  const off = new Set();
  const steps = new Map();     // day -> steps credited
  const minutes = new Map();   // day -> self-reported minutes
  const upgrades = [];         // the `movestreakv2` keys, one per upgraded instance

  for (const r of rows || []) {
    const kind = String(r.kind);
    const key = String(r.key ?? "");
    if (kind === STREAK_V2_KIND) {
      if (DAY_RE.test(key)) upgrades.push(key);
      continue;
    }
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

  // The oldest upgrade key is where the all-cards rule starts. Every instance
  // writes its own and instance-sync keeps them all, so the smallest wins, and
  // the days before it keep the old rule.
  let upgrade = null;
  for (const day of upgrades) {
    if (upgrade === null || day < upgrade) upgrade = day;
  }
  const completed = upgrade === null
    ? null
    : await completeDays(db, { from: upgrade, to: today });
  const isGood = (day) => (upgrade !== null && day >= upgrade ? completed.has(day) : good.has(day));

  let earliest = null;
  for (const day of [...done, ...off, ...steps.keys(), ...minutes.keys(), ...upgrades]) {
    if (earliest === null || day < earliest) earliest = day;
  }
  const todayGood = isGood(today);
  if (earliest === null) return { days: 0, nextHeartAt: STREAK_HEART_EVERY, todayGood };

  let days = 0;
  let cursor = today;
  let first = true;
  // Bounded by the days that exist in the ledger (plus today, and the upgrade
  // keys, so a v2 day with no other row still ends the walk); a day with no
  // rows is the break.
  for (let i = 0; i < 20_000; i += 1) {
    if (isGood(cursor)) days += 1;
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