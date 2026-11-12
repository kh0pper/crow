/**
 * Recording a finished chunk, and the one place a day's completion is settled
 * (moves design Task 2; private engineering notes).
 *
 * TWO CALLS, ONE OF WHICH NEVER WRITES BY ITSELF:
 *   recordSlotDone  the player finished a card (or a chunk beyond the day's
 *                   cards), by their own session, a class, or a stand-in.
 *   settleDay       the day is judged finished: the `moveall` cache row and the
 *                   streak heart. Nothing else in moves writes either.
 *
 * WHY COMPLETION IS NEVER STORED BY THE PICKER. The wallet sync applies a row
 * from another instance by plain MIN/MAX with no callback, so nothing runs when
 * a row arrives. `isDayComplete` (day-complete.js) derives the answer from the
 * rows; this module is the writer that adds the one cache row and the one heart,
 * and both are keyed so a re-delivery or a second settle changes nothing.
 *
 * THE MIDNIGHT RULE. A chunk picked at 23:55 and finished at 00:05 arrives with
 * YESTERDAY's date and is filed under it, so that day's slot closes and today's
 * cards stay open. `capDayKey` (indoor-cap.js) is the one place that decides
 * which days a write may land on: today, or yesterday, never older — an old
 * date would let a chunk fill a day that is already in the past.
 *
 * VIA is the fixed vocabulary of who ran the chunk. Only the player's own
 * session and a class count a balance (`movebal`): a walk is not a balance, and
 * a stand-in is somebody else's movement reported on the player's behalf, so it
 * never balances a day. The `movebal` row is the day's second half of the
 * completion rule, which is exactly why it may not be earned by proxy.
 *
 * ⚠ EVERY ROW WRITTEN HERE IS THE CONSTANT 1, keyed by day (or day and slot /
 * area), because applyRambleWallet merges a key conflict with MAX(delta). Every
 * write goes through `insertOnce` (steps.js), so the first writer wins and every
 * later one is a no-op that reports itself as not fresh.
 *
 * NOTHING HERE IS A READ PATH. `isDayComplete`, `streakState`, `weekState` and
 * `dayCards` must never call `settleDay`: a read of a day is always a read.
 */
import { localDay } from "../eggs.js";
import { insertOnce } from "../steps.js";
import { MOVE_ALL_KIND, MOVE_BAL_KIND, MOVE_SLOT_KIND, isDayComplete } from "./day-complete.js";
import { MOVE_AREA_KIND, SLOTS } from "./week.js";
import { AREAS, BALANCE_AREAS } from "./library.js";
import { awardStreakHeart } from "./streak.js";
import { capDayKey } from "./indoor-cap.js";
import { MovesInputError } from "./ledger.js";

/** Who ran the chunk. `standin-*` is somebody else's movement, reported for the player. */
export const VIA = Object.freeze(["player", "class", "outdoor", "standin-log", "standin-steps"]);

/** The vias that are the player's own session on a chunk, so the one that can balance a day. */
const BALANCE_VIAS = Object.freeze(["player", "class"]);

function asAt(now) {
  return Number.isFinite(Number(now)) ? Number(now) : Date.now();
}

/** Local noon of a `YYYY-MM-DD` day string, DST-safe for day arithmetic. */
function noonOf(dayStr) {
  const [y, m, d] = String(dayStr).split("-").map(Number);
  return new Date(y, m - 1, d, 12, 0, 0, 0).getTime();
}

/** The distinct areas a chunk trains, kept only where they are one of the five. */
function countedAreas(entry) {
  const out = [];
  for (const area of entry.areas) {
    if (AREAS.includes(area) && !out.includes(area)) out.push(area);
  }
  return out;
}

/**
 * Record that one chunk is finished, then settle the day.
 *
 * `slot` is one of morning|midday|evening — the card it closes — or null for a
 * chunk beyond the day's cards, which trains its areas and may balance the day
 * but closes no slot. `via` is one of VIA; `entry` is the finished entry, of
 * which only `kind` and `areas` are read.
 *
 * Writes, all keyed so a repeat is a no-op:
 *   moveslot   `<day>:<slot>` — one row per closed slot (only when `slot` is named)
 *   movearea   `<day>:<area>` — one row per area the chunk trains
 *   movebal    `<day>` — the day was balanced: only the player's own session or
 *              a class, never a walk, and only for a chunk that works the legs
 *              or the middle (BALANCE_AREAS)
 *
 * Returns `{ fresh, all }`: `fresh` is whether THIS call created the slot row
 * (for a chunk with no slot: whether it created any of its rows), `all` whether
 * the day is now complete. A junk via, slot or entry throws `MovesInputError`
 * before anything is written.
 */
export async function recordSlotDone(db, { day, slot, entry, via, now = Date.now(), emit, need } = {}) {
  const at = asAt(now);
  if (!VIA.includes(via)) {
    throw new MovesInputError("via must be one of " + VIA.join(", "));
  }
  if (slot !== null && slot !== undefined && !SLOTS.includes(slot)) {
    throw new MovesInputError("slot must be one of " + SLOTS.join(", ") + ", or null for a chunk beyond the day");
  }
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new MovesInputError("the finished entry is required");
  }
  if (typeof entry.kind !== "string" || entry.kind === "") {
    throw new MovesInputError("entry.kind must be a non-empty string");
  }
  if (!Array.isArray(entry.areas) || !entry.areas.every((area) => typeof area === "string")) {
    throw new MovesInputError("entry.areas must be an array of areas");
  }

  const d = capDayKey(day, at);
  const slotName = slot === undefined ? null : slot;
  let fresh = false;
  if (slotName !== null) {
    fresh = await insertOnce(db, MOVE_SLOT_KIND, `${d}:${slotName}`, 1, at, emit);
  }

  const areas = countedAreas(entry);
  let created = false;
  for (const area of areas) {
    // eslint-disable-next-line no-await-in-loop
    if (await insertOnce(db, MOVE_AREA_KIND, `${d}:${area}`, 1, at, emit)) created = true;
  }
  const balanced = BALANCE_VIAS.includes(via)
    && entry.kind !== "walk"
    && areas.some((area) => BALANCE_AREAS.includes(area));
  if (balanced && await insertOnce(db, MOVE_BAL_KIND, d, 1, at, emit)) created = true;
  if (slotName === null) fresh = created;

  const settled = await settleDay(db, { day: d, now: at, emit, need });
  return { fresh, all: settled.complete };
}

/**
 * Settle `day`: the ONLY place completion causes a write.
 *
 * `complete = isDayComplete(db, day, { need })` — derived, never stored — and
 * when it holds, the day's `moveall` cache row is inserted once and the streak
 * heart for that day is offered. The heart is awarded at the day's own local
 * noon when the day is not today, so a day finished just after midnight pays
 * `streak:<yesterday>` rather than opening a new day's run. When the day is not
 * complete nothing is written at all, and a second settle on a complete day
 * writes nothing new: both rows are keyed by the day.
 */
export async function settleDay(db, { day, now = Date.now(), emit, need } = {}) {
  const at = asAt(now);
  const complete = await isDayComplete(db, day, { need });
  if (!complete) return { complete: false, fresh: false };

  const fresh = await insertOnce(db, MOVE_ALL_KIND, day, 1, at, emit);
  const heartAt = day === localDay(at) ? at : noonOf(day);
  await awardStreakHeart(db, { now: heartAt, emit });
  return { complete: true, fresh };
}
