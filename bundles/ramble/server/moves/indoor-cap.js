/**
 * The indoor daily budget (moves design Task 4; private engineering notes).
 *
 * ONE combined cap per local day, shared by every indoor earner: the three
 * daily chores (pet.js `doChore`), an indoor challenge Done and an indoor
 * "something else" log (moves/ledger.js). It is the old chores budget — 3 x 8
 * = 24 — with moves added to the same purse rather than given a second one, so
 * the ceiling on indoor Health did not move when moves arrived.
 *
 * ⚠ WHY 24 IS LOAD-BEARING. With the 5-point daily check-in that is 29/day
 * against 40/day of decay (10 per 6 h), so indoor-only activity can never
 * sustain lay days — see the long comment on eggs.js `recordHappyDay`. Raise
 * this number and that invariant breaks; if it ever has to move, move
 * `lay.days` or the decay with it and re-run the simulation in
 * tests/ramble-moves-ledger.test.js.
 *
 * ⚠ SYNC SAFETY. The cap row GROWS and is moved ONLY by compare-and-swap
 * (`casDelta`, steps.js), because instance-sync merges a wallet conflict with
 * MAX(delta) — a growing row converges, a shrinking one does not. A lost race
 * pays 0, so every failure mode under-pays. Two instances that each filled
 * their own cap can sum above it after a merge; readers clamp
 * (`ledger.js movesDay`, exactly like `stepsToday`).
 *
 * WHY A FILE OF ITS OWN. pet.js's `doChore` draws from this budget and
 * ledger.js imports pet.js, so a top-level `pet.js -> ledger.js` import would
 * be a cycle through the module that pays the pet. This file depends only on
 * steps.js's ledger helpers and eggs.js's day helpers. steps.js itself imports
 * pet.js, so a module cycle exists (pet -> indoor-cap -> steps -> pet); it is
 * safe only because every binding is used at call time, never at load.
 */
import { localDay, startOfLocalDay } from "../eggs.js";
import { casDelta, rowDelta } from "../steps.js";

/** Indoor Health from moves AND chores, per local day (the old 3 x 8 chores budget). */
export const INDOOR_DAILY_CAP = 24;
/** Wallet kind: key `<day>`, delta = indoor Health paid that day. Grows, <= cap. */
export const MOVE_INDOOR_KIND = "moveindoor";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A day key for READING: any well-formed date, else today (never throws). */
export function dayKey(day, now) {
  return typeof day === "string" && DAY_RE.test(day) ? day : localDay(now);
}

/**
 * A day key for WRITING (paying): the caller's day when it is today or
 * yesterday (a challenge picked at 23:58 and Done at 00:02 credits the day it
 * was picked for), else today. Yesterday is the day before today's local
 * midnight, which is right across a DST change (a 23 h or 25 h day).
 */
export function capDayKey(day, now) {
  // Only today or yesterday (a challenge picked at 23:58 and done at 00:02).
  // Any other date would open a fresh budget per date and let Health be farmed.
  const today = localDay(now);
  if (typeof day !== "string" || !DAY_RE.test(day)) return today;
  return day === today || day === localDay(startOfLocalDay(now) - 1) ? day : today;
}

/**
 * Take up to `points` out of a day's capped budget: the row moves from what it
 * holds to `min(cap, held + points)` by compare-and-swap, and the caller then
 * pays the pet the `paid` it gets back. Returns
 * `{ paid, capped, raced, total, day }`:
 *   paid   Health the caller may feed the pet (0 when the budget is gone)
 *   capped true when the budget cut the claim short (paid < points)
 *   raced  true when another writer moved the row first — pays 0, and can
 *          only ever under-pay (steps.js `casDelta`)
 *   total  what the row holds after this call
 * Pure with respect to the pet: this writes ONLY the wallet row, and only
 * upwards. `points` is floored at 0 so a junk claim can never write a
 * negative delta into a table merged with MAX.
 */
export async function claimCapped(db, { kind, cap, day, points, now = Date.now(), emit } = {}) {
  const at = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const key = capDayKey(day, at);
  const limit = Number.isFinite(Number(cap)) ? Math.max(0, Math.floor(Number(cap))) : 0;
  const want = Number.isFinite(Number(points)) ? Math.max(0, Math.floor(Number(points))) : 0;

  const existing = await rowDelta(db, kind, key);
  const held = Math.max(0, Number(existing) || 0);
  if (want <= 0) return { paid: 0, capped: false, raced: false, total: held, day: key };

  const target = Math.min(limit, held + want);
  const paid = target - held;
  // A merge of two instances' claims can already sit ABOVE the cap. Never
  // write it back down: pay nothing and leave the row alone.
  if (paid <= 0) return { paid: 0, capped: true, raced: false, total: held, day: key };

  const won = await casDelta(db, kind, key, existing === null ? null : held, target, at, emit);
  if (!won) return { paid: 0, capped: false, raced: true, total: held, day: key };
  return { paid, capped: target < held + want, raced: false, total: target, day: key };
}

/** The indoor budget: `claimCapped` bound to `moveindoor` / INDOOR_DAILY_CAP. */
export async function claimIndoor(db, { day, points, now = Date.now(), emit } = {}) {
  return claimCapped(db, { kind: MOVE_INDOOR_KIND, cap: INDOOR_DAILY_CAP, day, points, now, emit });
}
