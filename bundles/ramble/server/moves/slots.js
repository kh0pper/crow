/**
 * The day's cards (moves design Task 4; private engineering notes): which
 * chunk sits in each of the day's slots, how many cards the day asks for, and
 * which slot is "now".
 *
 * THREE KINDS OF STATE, each with the merge rule that suits it:
 *   moveneed          wallet row, key `<day>`, delta 1-3 — how many cards the
 *                     day asks for. Written ONCE per day and merged by MAX, so
 *                     a second instance that asked for more cards widens the
 *                     day instead of being overwritten by it.
 *   moves.slot.<slot> synced setting, JSON { day, entryId, area, reasons,
 *                     swap, seen } — the slot's chunk. Last-writer-wins like
 *                     the rest of the moves settings, and the row carries its
 *                     own day so a stale row is re-picked rather than shown.
 *   moves.week        synced setting, JSON { weekId, cards, days } — the week
 *                     the day belongs to, written once when the week turns.
 *
 * PICKS ARE PURE: each slot's chunk comes from pickChunk (moves/picker.js),
 * whose only randomness is a hash of `day:slot:swap`. Two devices that open
 * the same day draw the same three cards, and a slot that already holds a
 * usable pick for today is REUSED, never re-rolled — the row is what keeps a
 * card still while the user is looking at it.
 *
 * ⚠ A STORED PICK IS RE-EXAMINED ON EVERY READ. A slot whose entry left the
 * library, or that a stated limit has since ruled out, is re-picked (keeping
 * the day's swap count and seen list); the picker's filters do the ruling out,
 * this module never offers an entry they refused.
 *
 * ⚠ EARLIER SLOTS ARE EXCLUDED FROM LATER ONES. The ids already chosen for the
 * day's earlier slots are handed to the picker as `exclude`, so two cards of
 * one day are never the same chunk (a slot left with nothing else eligible is
 * empty, never a repeat).
 *
 * ⚠ THIS MODULE DOES NOT SETTLE ANYTHING. It writes no area marks, no
 * completion and no streak: a card is finished somewhere else, and the rows
 * this module reads for the day's flags (`moveslot`, `movestand`) are written
 * there too.
 */
import { localDay } from "../eggs.js";
import { rowDelta, insertOnce } from "../steps.js";
import { servedLibrary, entryById, AREAS } from "./library.js";
import { pickChunk, slotFor } from "./picker.js";
import {
  DEFAULT_PREFS, HISTORY_KEY, MAX_SWAPS, TODAY_KEY,
  blockedByLimits, historyWithRollover, normalizeToday, readJson, readPrefs, seenOf,
  whyLine, writeJson,
} from "./today.js";
import { learningFlows } from "./learning.js";
import {
  SLOTS, areaWeights, defaultSlots, weekDays, weekIdOf, weekPlan, weekState,
} from "./week.js";

/** The three slot names, re-exported so a caller needs one import for the day. */
export { SLOTS };

/** Wallet kind: key `<day>`, delta 1-3 — how many cards the day asks for. Grows, MAX. */
export const MOVE_NEED_KIND = "moveneed";
/** Synced setting prefix: `moves.slot.<slot>` holds that slot's pick. */
export const SLOT_KEY_PREFIX = "moves.slot.";
/** Synced setting: JSON { weekId, cards, days } — the week this day belongs to. */
export const WEEK_KEY = "moves.week";

/** Wallet kind: key `<day>:<slot>`, delta 1 — that slot's card was finished. */
const MOVE_SLOT_KIND = "moveslot";
/** Wallet kind: key `<day>:<slot>`, delta 1 — a stand-in was done for that slot. */
const MOVE_STAND_IN_KIND = "movestand";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** The most cards a day can ask for, and the clamp of a stored `moveneed` row. */
const MAX_CARDS = SLOTS.length;
/** The area the week plan uses for a slot it leaves open. */
const FREE_AREA = "free";

/** The card count the plan is built for: 1, 2 or 3 (junk reads as the default). */
function cardsOf(prefs) {
  const cards = prefs && typeof prefs === "object" ? prefs.cards : undefined;
  return [1, 2, 3].includes(cards) ? cards : DEFAULT_PREFS.cards;
}

/**
 * The slot names the day uses. `prefs.windows` is honoured only when it names
 * as many DISTINCT slots as the day has cards; anything else (a wrong length, a
 * repeat, a name that is not a slot, a value that is not a list) reads as no
 * choice at all, and the default slots for that card count apply. Always in
 * SLOTS order, so the day reads the same way on every device.
 */
export function enabledSlots(prefs) {
  const cards = cardsOf(prefs);
  const windows = prefs && typeof prefs === "object" ? prefs.windows : undefined;
  if (Array.isArray(windows) && windows.length === cards) {
    const named = new Set(windows.filter((w) => SLOTS.includes(w)));
    if (named.size === cards && named.size === windows.length) {
      return SLOTS.filter((slot) => named.has(slot));
    }
  }
  return defaultSlots(cards);
}

/** The card count a stored `moveneed` row states, or null when it states none. */
function needOf(delta) {
  if (delta === null || delta === undefined) return null;
  const n = Number(delta);
  if (!Number.isInteger(n)) return null;
  if (n < 1 || n > MAX_CARDS) return null;
  return n;
}

/**
 * One stored slot row, or null when it cannot be read as a pick. Every field is
 * checked on its own: a row with a junk area is no pick at all (the slot is
 * re-picked), while a row without a usable swap count or seen list still is one
 * (those are clamped and rebuilt instead of thrown away).
 */
function normalizeSlotRow(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (typeof raw.day !== "string" || !DAY_RE.test(raw.day)) return null;
  if (typeof raw.entryId !== "string" || raw.entryId === "") return null;
  const area = raw.area === FREE_AREA || AREAS.includes(raw.area) ? raw.area : null;
  if (area === null) return null;
  const swap = Number.isInteger(raw.swap) && raw.swap >= 0
    ? Math.min(raw.swap, MAX_SWAPS)
    : 0;
  const reasons = Array.isArray(raw.reasons) ? raw.reasons.filter((r) => typeof r === "string") : [];
  return { day: raw.day, entryId: raw.entryId, area, reasons, swap, seen: seenOf(raw.entryId, raw.seen) };
}

/**
 * The slot a caller should treat as "now".
 *
 * The local hour names a slot: early is the morning, day the midday, evening the
 * evening. A day whose cards do not include that slot falls forward to the next
 * slot it does have, and to its last slot when nothing comes after — so a
 * one-card day always has a now.
 */
function nowSlotOf(slotNames, at) {
  if (slotNames.length === 0) return null;
  const code = slotFor(new Date(at).getHours());
  const wanted = code === "early" ? "morning" : code === "day" ? "midday" : "evening";
  if (slotNames.includes(wanted)) return wanted;
  const after = slotNames.filter((slot) => SLOTS.indexOf(slot) > SLOTS.indexOf(wanted));
  return after.length > 0 ? after[0] : slotNames[slotNames.length - 1];
}

/**
 * The day's cards, and the writes that keep them.
 *
 * Returns `{ day, need, nowSlot, slots }`, where `need` is the day's card count
 * (0 when nothing could be picked) and each `slots[]` item is
 * `{ slot, entryId, area, plannedArea, reasons, swap, seen, done, standIn, empty }`
 * — `plannedArea` is what the week plan asked the slot for, `area` the area the
 * card actually trains (the picker falls back when an area has no eligible
 * chunk), and `entryId` is null for a slot left empty.
 *
 * Writes, in order: the week's row when the week turns, one slot row per
 * re-picked slot, the day's `moveneed` row once, the folded history when an
 * earlier day's card rolls over, and the Now card into `moves.today`. A day
 * whose slots are all already stored writes nothing at all — the second open of
 * a day is a read.
 *
 * When prefs.on is false it writes nothing and answers `{ off: true }` with no
 * slots: a paused day has no cards to draw.
 */
export async function dayCards(db, {
  now = Date.now(), weather = null, library, emit, lang = "en",
} = {}) {
  const at = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const day = localDay(at);
  const prefs = await readPrefs(db);
  const lib = Array.isArray(library) ? library : servedLibrary();
  if (prefs.on === false) return { day, need: 0, nowSlot: null, slots: [], off: true };

  // The day's card count. A stored row WINS over the prefs (a peer that asked
  // for more cards widens this day too, and the two instances agree), and the
  // slots beyond the user's own choice come from the rest of SLOTS in order.
  const existing = needOf(await rowDelta(db, MOVE_NEED_KIND, day));
  const base = enabledSlots(prefs);
  const order = [...base, ...SLOTS.filter((slot) => !base.includes(slot))];
  const slotNames = existing === null ? base : order.slice(0, existing);

  const weekId = weekIdOf(at);
  const plan = weekPlan(weekId, slotNames.length, slotNames);
  const dayIndex = weekDays(weekId).indexOf(day);
  const planned = plan[dayIndex] ?? { slots: {} };

  const storedWeek = await readJson(db, WEEK_KEY);
  if (!storedWeek || typeof storedWeek !== "object" || Array.isArray(storedWeek)
    || storedWeek.weekId !== weekId) {
    await writeJson(db, WEEK_KEY, {
      weekId,
      cards: prefs.cards,
      days: weekPlan(weekId, prefs.cards, enabledSlots(prefs)),
    }, emit);
  }
  const weights = areaWeights(await weekState(db, { now: at }));

  // An earlier day's card is folded into history IN MEMORY here; it is written
  // only alongside a new card, so a day that yields nothing banks nothing.
  const stored = normalizeToday(await readJson(db, TODAY_KEY));
  const earlier = stored && stored.day !== day ? stored : null;
  const { history, changed } = await historyWithRollover(db, earlier);
  const learning = await learningFlows(db, lib);
  const pickHistory = { done: history.done, skipped: history.skipped, learning };

  const chosen = [];
  const slots = [];
  for (const slot of slotNames) {
    const plannedArea = planned.slots[slot];
    const row = normalizeSlotRow(await readJson(db, SLOT_KEY_PREFIX + slot));
    const held = row && row.day === day ? entryById(lib, row.entryId) : null;

    // A pick that is still usable today stays exactly as it is.
    if (held && !blockedByLimits(held, prefs)) {
      chosen.push(row.entryId);
      slots.push({
        slot,
        entryId: row.entryId,
        area: row.area,
        plannedArea,
        reasons: row.reasons,
        swap: row.swap,
        seen: row.seen,
        empty: false,
      });
      continue;
    }

    // A re-pick keeps today's swap count and seen list (a replacement must not
    // reopen the swap cap or forget a card the user already saw), and never
    // offers an entry an earlier slot of this day already took.
    const sameDay = Boolean(row) && row.day === day;
    const swap = sameDay ? row.swap : 0;
    const seen = sameDay ? row.seen : [];
    const picked = pickChunk({
      day,
      slot,
      area: plannedArea,
      weights,
      weather,
      prefs,
      history: pickHistory,
      library: lib,
      swap,
      exclude: [...seen, ...chosen],
    });
    if (!picked) {
      slots.push({
        slot,
        entryId: null,
        area: plannedArea,
        plannedArea,
        reasons: [],
        swap,
        seen,
        empty: true,
      });
      continue;
    }
    const nextSeen = seenOf(picked.entryId, seen);
    await writeJson(db, SLOT_KEY_PREFIX + slot, {
      day,
      entryId: picked.entryId,
      area: picked.area,
      reasons: picked.reasons,
      swap,
      seen: nextSeen,
    }, emit);
    chosen.push(picked.entryId);
    slots.push({
      slot,
      entryId: picked.entryId,
      area: picked.area,
      plannedArea,
      reasons: picked.reasons,
      swap,
      seen: nextSeen,
      empty: false,
    });
  }

  // The day's flags live in the wallet and are written elsewhere; here they are
  // only read, one pair of keys per slot.
  for (const item of slots) {
    const key = `${day}:${item.slot}`;
    item.done = (await rowDelta(db, MOVE_SLOT_KIND, key)) !== null;
    item.standIn = (await rowDelta(db, MOVE_STAND_IN_KIND, key)) !== null;
  }

  // The card count is a FACT of the day, written once and merged by MAX, and
  // never written for a day that could not be given a single card.
  const picks = slots.filter((item) => item.entryId !== null).length;
  let need = existing ?? 0;
  if (picks > 0 && existing === null) {
    await insertOnce(db, MOVE_NEED_KIND, day, picks, at, emit);
    // A concurrent writer or a sync merge may hold a larger value by now.
    need = needOf(await rowDelta(db, MOVE_NEED_KIND, day)) ?? picks;
  }

  // The Now card is the one `moves.today` carries, so the rest of moves (Done,
  // Swap, the streak) keeps reading one card a day the way it always has.
  const nowSlot = nowSlotOf(slotNames, at);
  const nowItem = nowSlot === null ? null : slots.find((item) => item.slot === nowSlot) ?? null;
  if (nowItem && nowItem.entryId !== null) {
    const same = stored !== null && stored.day === day && stored.entryId === nowItem.entryId;
    if (!same) {
      if (changed) await writeJson(db, HISTORY_KEY, history, emit);
      await writeJson(db, TODAY_KEY, {
        day,
        entryId: nowItem.entryId,
        swap: nowItem.swap,
        seen: nowItem.seen,
        reasons: nowItem.reasons,
        why: whyLine(nowItem.reasons, lang),
      }, emit);
    }
  }

  return { day, need, nowSlot, slots };
}