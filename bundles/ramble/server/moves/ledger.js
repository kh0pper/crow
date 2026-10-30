/**
 * The moves ledger (moves design Task 4; private engineering notes): what a
 * day of self-reported movement pays in Health, and the two daily budgets that
 * bound it.
 *
 * TWO EARNERS, TWO BUDGETS. An indoor challenge Done and an indoor
 * "something else" log draw from ONE indoor budget (INDOOR_DAILY_CAP,
 * moves/indoor-cap.js — 24/day, the old 3 x 8 purse); outdoor logs draw from
 * their own (OUTDOOR_DAILY_CAP, 20/day). Which
 * budget an activity belongs to is the fixed-vocabulary question
 * `isOutdoorActivity` answers, so no model is ever in the loop.
 *
 * HEALTH ONLY, NEVER SEED. Moves pay the pet's energy. The step goal keeps its
 * own seed bonus (steps.js `settleDay`) and nothing here writes a `seed` row.
 *
 * ⚠ EVERY ramble_wallet ROW WRITTEN HERE IS A CONSTANT OR GROWS, because
 * applyRambleWallet merges a key conflict with MAX(delta) (servers/sharing/
 * instance-sync.js). `movedone` is the constant 1; the two cap rows grow by
 * compare-and-swap only; a `movelog` row is inserted at 0 as the dedup marker
 * and then grown once to what it actually paid. Nothing here ever writes a
 * row down.
 *
 * ⚠ NO FREE TEXT, EVER. A "something else" log stores only the parsed
 * fixed-vocabulary result — activity, minutes, effort — and the ledger key is
 * built from those three fields alone. The user's own words ("Bike ride with
 * a friend…") are never stored, never emitted and never logged, on any path,
 * including the error paths.
 *
 * THE PAY RULE, same shape as steps.js `settleDay`: the cap row moves FIRST, by
 * compare-and-swap; then `petState` applies the decay the bird is already owed
 * (a `move` feed resets the decay clock, so decay applied afterwards would
 * clamp the Health just paid away); then the pet is fed the increment. A lost
 * compare-and-swap, an exhausted budget or a crash between the two writes pays
 * 0 — every failure mode under-pays, never over-pays.
 */
import { localDay, startOfLocalDay } from "../eggs.js";
import { insertOnce, casDelta } from "../steps.js";
import { feed as petFeed, petState } from "../pet.js";
import { ACTIVITY_KINDS } from "./library.js";
import { claimCapped, claimIndoor, capDayKey, dayKey, INDOOR_DAILY_CAP, MOVE_INDOOR_KIND } from "./indoor-cap.js";

// ledger.js is the moves surface the routes and the panel import; the indoor
// budget lives in its own module so the cap is bookkeeping only, with no
// dependency on the pet-payment path.
export { claimCapped, claimIndoor, capDayKey, INDOOR_DAILY_CAP, MOVE_INDOOR_KIND } from "./indoor-cap.js";

/** Wallet kind: key `<day>`, delta 1 — today's challenge was marked Done. */
export const MOVE_DONE_KIND = "movedone";
/** Wallet kind: key `<day>`, delta = outdoor Health paid that day. Grows, <= cap. */
export const MOVE_OUTDOOR_KIND = "moveoutdoor";
/** Outdoor self-reported activity, per local day. */
export const OUTDOOR_DAILY_CAP = 20;
/**
 * Wallet kind: key `<day>:<minuteOfDay>:<activity>:<minutes>:<effort>`, delta =
 * the Health this log paid. The key IS the dedup: the same parsed activity in
 * the same minute of the same local day is one fact, however many times the
 * button is tapped or however many devices sync it.
 */
export const MOVE_LOG_KIND = "movelog";

/** The most Health one logged activity is worth before the daily budget bites. */
export const SINGLE_ENTRY_MAX = 20;
/** Same ceiling the library puts on an entry's `minutes` (library.js). */
export const LOG_MINUTES_MAX = 600;
/** The fixed effort vocabulary. No free text reaches the ledger. */
export const EFFORTS = Object.freeze(["easy", "moderate", "hard"]);
/** A challenge Done is always counted as moderate: the picker chose its size. */
export const CHALLENGE_EFFORT = "moderate";

const EFFORT_MULT = Object.freeze({ easy: 1, moderate: 1.5, hard: 2 });

/**
 * Outdoor by ACTIVITY, from library.js's fixed vocabulary. `other` counts as
 * outdoor: it is the "something else" bucket a walk or a swim is most often
 * parsed into, and the outdoor budget is the tighter of the two only because
 * it is the one a step counter can corroborate — an uncorroborated claim
 * belongs in the smaller purse, not the larger.
 */
const OUTDOOR_ACTIVITIES = Object.freeze(["walk", "jog", "run", "cycle", "sport", "swim", "other"]);

export class MovesInputError extends Error {
  constructor(message) { super(message); this.name = "MovesInputError"; }
}

export function isOutdoorActivity(activity) {
  return OUTDOOR_ACTIVITIES.includes(activity);
}

/**
 * Health one activity is worth: minutes/2, x1 easy / x1.5 moderate / x2 hard,
 * rounded, and never more than SINGLE_ENTRY_MAX for a single entry. Pure — the
 * same three fields give the same integer on every device, which is what makes
 * a `movelog` delta converge under MAX. Anything outside the fixed vocabularies
 * is worth 0 (a caller must not silently pay for junk; `recordLog` throws).
 *
 *   10 min easy      -> 5      10 min moderate  -> 8      10 min hard -> 10
 *   30 min moderate  -> 20 (22.5 rounds to 23, then the single-entry max bites)
 *   60 min hard      -> 20
 */
export function pointsFor({ activity, minutes, effort } = {}) {
  if (!ACTIVITY_KINDS.includes(activity)) return 0;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > LOG_MINUTES_MAX) return 0;
  const mult = Object.hasOwn(EFFORT_MULT, effort) ? EFFORT_MULT[effort] : null;
  if (mult === null) return 0;
  return Math.max(0, Math.min(SINGLE_ENTRY_MAX, Math.round((minutes / 2) * mult)));
}

/**
 * Which budget a library entry draws from. `indoor` is a validated field of
 * every entry (library.js); `activity` is the fallback for a hand-built entry
 * (a test fixture, or an entry that predates the field).
 */
function entryIsOutdoor(entry) {
  if (typeof entry?.indoor === "boolean") return !entry.indoor;
  return isOutdoorActivity(entry?.activity);
}

/** Minute of the local day, for the `movelog` key. DST-safe: days run 23-25 h. */
function minuteOfDay(now) {
  return Math.max(0, Math.floor((now - startOfLocalDay(now)) / 60000));
}

/**
 * Claim the budget, then pay the pet — the pay rule in the header. A claim of
 * 0 (budget gone, or a lost race) writes no pet row at all: feeding 0 would
 * still emit a `ramble_pet` update and re-run the happy-day check for nothing.
 */
async function pay(db, claim, { now, emit }) {
  if (claim.paid <= 0) return 0;
  await petState(db, { now });
  await petFeed(db, { type: "move", amount: claim.paid }, { now, emit });
  return claim.paid;
}

/**
 * Mark today's challenge Done and pay it. IDEMPOTENT PER DAY: the `movedone`
 * row is claimed first, so a double tap — or the same day's Done arriving from
 * two devices — pays once and every later call reports `already`.
 *
 * `day` is the day the challenge was PICKED for, and it is the caller's job to
 * pass it (Task 5 reads it off `moves.today`). That is the whole midnight rule:
 * picked at 23:58, Done at 00:02, the Health and the `movedone` fact are filed
 * under the day it was picked for, never under both days. A missing or junk
 * `day` falls back to the local day of `now`.
 *
 * Content gating is NOT this function's job: the server only ever hands out
 * entries from `servedLibrary` (reviewed, licensed). What is checked here is
 * that the entry can be paid at all, and that check runs BEFORE the day's Done
 * row is burned — a junk entry must not spend the player's one Done.
 */
export async function recordChallengeDone(db, { day, entry, now = Date.now(), emit } = {}) {
  const at = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const d = capDayKey(day, at);
  if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || entry.id === "") {
    throw new MovesInputError("a library entry is required");
  }
  const points = pointsFor({ activity: entry.activity, minutes: entry.minutes, effort: CHALLENGE_EFFORT });
  if (points <= 0) {
    throw new MovesInputError("an entry needs an activity from the fixed vocabulary and minutes from 1 to "
      + LOG_MINUTES_MAX);
  }

  const fresh = await insertOnce(db, MOVE_DONE_KIND, d, 1, at, emit);
  if (!fresh) return { paid: 0, already: true, day: d, points, capped: false };

  const outdoor = entryIsOutdoor(entry);
  const claim = outdoor
    ? await claimCapped(db, { kind: MOVE_OUTDOOR_KIND, cap: OUTDOOR_DAILY_CAP, day: d, points, now: at, emit })
    : await claimIndoor(db, { day: d, points, now: at, emit });
  const paid = await pay(db, claim, { now: at, emit });
  return { paid, already: false, day: d, points, capped: claim.capped, outdoor };
}

/**
 * Log a self-reported activity — the parsed result of a "something else", or a
 * manual pick from the fixed vocabulary. Validates hard (throws
 * `MovesInputError`): the key is built from these three fields, so a junk value
 * would either poison the ledger or quietly pay nothing at all.
 *
 * IDEMPOTENT PER MINUTE: the `movelog` row is inserted at delta 0 as the dedup
 * marker BEFORE the budget is claimed, so the same parsed activity logged twice
 * in the same minute pays once, and so a double tap can never claim budget it
 * then has to give back (a wallet row is never written down). The marker is then
 * grown once, by compare-and-swap, to the Health it actually paid — which is
 * what `movesDay` reports per log, and why the day's logs always sum to no more
 * than the budget row says was paid.
 *
 * Returns `{ paid, key, already, day, points }`: `points` is what the activity
 * is worth, `paid` what the day's budget allowed (they differ at the cap, and
 * `paid` is 0 for a repeat).
 */
export async function recordLog(db, { activity, minutes, effort, now = Date.now(), emit } = {}) {
  const at = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  if (!ACTIVITY_KINDS.includes(activity)) {
    throw new MovesInputError("activity must be one of " + ACTIVITY_KINDS.join(", "));
  }
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > LOG_MINUTES_MAX) {
    throw new MovesInputError("minutes must be a whole number from 1 to " + LOG_MINUTES_MAX);
  }
  if (!EFFORTS.includes(effort)) {
    throw new MovesInputError("effort must be one of " + EFFORTS.join(", "));
  }

  const day = localDay(at);
  const key = day + ":" + minuteOfDay(at) + ":" + activity + ":" + minutes + ":" + effort;
  const points = pointsFor({ activity, minutes, effort });

  const fresh = await insertOnce(db, MOVE_LOG_KIND, key, 0, at, emit);
  if (!fresh) return { paid: 0, key, already: true, day, points: 0 };

  const claim = isOutdoorActivity(activity)
    ? await claimCapped(db, { kind: MOVE_OUTDOOR_KIND, cap: OUTDOOR_DAILY_CAP, day, points, now: at, emit })
    : await claimIndoor(db, { day, points, now: at, emit });

  let paid = 0;
  if (claim.paid > 0) {
    // Grow the marker to what was paid (never shrink it), then pay the pet.
    if (await casDelta(db, MOVE_LOG_KIND, key, 0, claim.paid, at, emit)) paid = claim.paid;
  }
  await pay(db, { paid }, { now: at, emit });
  return { paid, key, already: false, day, points, capped: claim.capped };
}

/**
 * One local day as the panel shows it. Read-only, and CLAMPED: two instances
 * that each filled their own budget locally can sum above the cap after a
 * merge, so every reader reports at most the cap (the same rule as
 * `stepsToday`). `day` defaults to today.
 */
export async function movesDay(db, { day, now = Date.now() } = {}) {
  const at = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const d = dayKey(day, at);
  const { rows } = await db.execute({
    sql: "SELECT kind, key, delta FROM ramble_wallet WHERE kind IN (?, ?, ?) OR (kind = ? AND key LIKE ?)",
    args: [MOVE_DONE_KIND, MOVE_INDOOR_KIND, MOVE_OUTDOOR_KIND, MOVE_LOG_KIND, d + ":%"],
  });
  const one = (kind) => rows.find((r) => r.kind === kind && String(r.key) === d);
  const seen = [];
  for (const r of rows) {
    if (r.kind !== MOVE_LOG_KIND) continue;
    const parts = String(r.key).split(":");
    if (parts.length !== 5 || parts[0] !== d) continue;
    const [minute, activity, mins, effort] = parts.slice(1);
    if (!ACTIVITY_KINDS.includes(activity) || !EFFORTS.includes(effort)) continue;
    const minutes = Number(mins);
    if (!Number.isInteger(minutes)) continue;
    seen.push({
      // Keys start with `<day>:<minuteOfDay>`, and minuteOfDay is not
      // zero-padded, so the day's logs sort by the parsed minute, never
      // lexically. The minute is a sort key only — it is not part of the
      // shape callers get.
      order: Number.isInteger(Number(minute)) ? Number(minute) : 0,
      log: { activity, minutes, effort, paid: Math.max(0, Number(r.delta) || 0) },
    });
  }
  seen.sort((a, b) => a.order - b.order);
  return {
    day: d,
    done: one(MOVE_DONE_KIND) !== undefined,
    indoorPaid: Math.min(INDOOR_DAILY_CAP, Number(one(MOVE_INDOOR_KIND)?.delta) || 0),
    outdoorPaid: Math.min(OUTDOOR_DAILY_CAP, Number(one(MOVE_OUTDOOR_KIND)?.delta) || 0),
    logs: seen.map((s) => s.log),
  };
}

/** What is left of each budget today — the number a "harder" offer must respect. */
export async function movesRoom(db, { day, now = Date.now() } = {}) {
  const d = await movesDay(db, { day, now });
  return {
    day: d.day,
    indoor: Math.max(0, INDOOR_DAILY_CAP - d.indoorPaid),
    outdoor: Math.max(0, OUTDOOR_DAILY_CAP - d.outdoorPaid),
  };
}
