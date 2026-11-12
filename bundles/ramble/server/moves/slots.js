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
 *
 * SWAP IS PER SLOT (swapSlot). One card is re-rolled by bumping its own `swap`
 * and growing its own `seen` list, so the other cards of the day stay put and
 * a slot never shows an entry it already showed. The cap, the refusal shape
 * and the refusal-without-writing rule are today.js's: a swap that cannot
 * produce a new card answers the card on screen with `refused: true`.
 */
import { localDay } from "../eggs.js";
import { rowDelta, insertOnce } from "../steps.js";
import { MOVE_NEED_KIND, MOVE_SLOT_KIND, MOVE_STAND_KIND } from "./day-complete.js";
import { servedLibrary, entryById, AREAS } from "./library.js";
import { pickChunk, slotFor } from "./picker.js";
import {
  DEFAULT_PREFS, HISTORY_KEY, MAX_SWAPS, TODAY_KEY,
  blockedByLimits, historyWithRollover, normalizeToday, readHistory, readJson, readPrefs,
  seenOf, whyLine, writeJson,
} from "./today.js";
import { learningFlows } from "./learning.js";
import {
  SLOTS, areaWeights, defaultSlots, weekDays, weekIdOf, weekPlan, weekState,
} from "./week.js";

/** The three slot names, re-exported so a caller needs one import for the day. */
export { SLOTS };

/** Wallet kind: key `<day>`, delta 1-3 — how many cards the day asks for. Grows, MAX. */
export { MOVE_NEED_KIND };
/** Synced setting prefix: `moves.slot.<slot>` holds that slot's pick. */
export const SLOT_KEY_PREFIX = "moves.slot.";
/** Synced setting: JSON { weekId, cards, days } — the week this day belongs to. */
export const WEEK_KEY = "moves.week";

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

/** The area weights for the day's week, read from the marks it holds so far. */
async function dayWeights(db, at) {
  return areaWeights(await weekState(db, { now: at }));
}

/** Whether the stored `moves.today` row already carries `item` for `day`. */
function nowStoredAs(stored, day, item) {
  return stored !== null && stored.day === day && stored.entryId === item.entryId;
}

/**
 * The Now mirror: store `item` as the one card `moves.today` carries, so the
 * rest of moves (Done, Swap, the streak) keeps reading one card a day.
 */
async function writeToday(db, { day, item, emit, lang }) {
  await writeJson(db, TODAY_KEY, {
    day,
    entryId: item.entryId,
    swap: item.swap,
    seen: item.seen,
    reasons: item.reasons,
    why: whyLine(item.reasons, lang),
  }, emit);
}

/**
 * The day's cards, and the writes that keep them.
 *
 * Returns `{ day, need, nowSlot, slots }`, where `need` is the day's card count
 * and each `slots[]` item is `{ slot, entryId, area, plannedArea, reasons,
 * swap, seen, done, standIn, empty }`
 * — `plannedArea` is what the week plan asked the slot for, `area` the area the
 * card actually trains (the picker falls back when an area has no eligible
 * chunk), and `entryId` is null for a slot left empty.
 *
 * `need` is capped by the slots that actually hold a pick: it is the smaller of
 * the day's `moveneed` row and the number of slots with an `entryId`, so a day
 * that could only fill two of its three slots asks for two (0 when nothing
 * could be picked). The `moveneed` row itself is never rewritten by this cap —
 * it stays the count the day asked for.
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
  // for more cards widens this day too, and the two instances agree).
  const existing = needOf(await rowDelta(db, MOVE_NEED_KIND, day));
  const base = enabledSlots(prefs);
  const order = [...base, ...SLOTS.filter((slot) => !base.includes(slot))];

  // The day's slots. Before the day has a card count they are the user's own
  // choice, empty ones included. Once it has one, they are the slots that
  // already hold a stored pick for TODAY — a slot that was empty when the day
  // was first drawn is simply not part of it — read in SLOTS order, and widened
  // up to that count by the next slots of `order`, so a peer that asked for more
  // cards still gets a full day. A slot row for another day says nothing about
  // this one.
  let slotNames = base;
  if (existing !== null) {
    slotNames = [];
    for (const slot of SLOTS) {
      const row = normalizeSlotRow(await readJson(db, SLOT_KEY_PREFIX + slot));
      if (row && row.day === day) slotNames.push(slot);
    }
    for (const slot of order) {
      if (slotNames.length >= existing) break;
      if (!slotNames.includes(slot)) slotNames.push(slot);
    }
    slotNames.sort((a, b) => SLOTS.indexOf(a) - SLOTS.indexOf(b));
  }

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
  const weights = await dayWeights(db, at);

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
    item.standIn = (await rowDelta(db, MOVE_STAND_KIND, key)) !== null;
  }

  // The card count is a FACT of the day, written once and merged by MAX, and
  // never written for a day that could not be given a single card. The answer
  // is capped by the picks the day actually holds: a day that could fill two of
  // its three slots asks for two, while the row keeps the count it was written
  // with.
  const picks = slots.filter((item) => item.entryId !== null).length;
  let asked = existing;
  if (picks > 0 && existing === null) {
    await insertOnce(db, MOVE_NEED_KIND, day, picks, at, emit);
    // A concurrent writer or a sync merge may hold a larger value by now.
    asked = needOf(await rowDelta(db, MOVE_NEED_KIND, day)) ?? picks;
  }
  const need = Math.min(asked ?? 0, picks);

  // The Now card is the one `moves.today` carries, so the rest of moves (Done,
  // Swap, the streak) keeps reading one card a day the way it always has.
  const nowSlot = nowSlotOf(slotNames, at);
  const nowItem = nowSlot === null ? null : slots.find((item) => item.slot === nowSlot) ?? null;
  if (nowItem && nowItem.entryId !== null && !nowStoredAs(stored, day, nowItem)) {
    if (changed) await writeJson(db, HISTORY_KEY, history, emit);
    await writeToday(db, { day, item: nowItem, emit, lang });
  }

  return { day, need, nowSlot, slots };
}

/** The entry ids the day's other slots hold, as the swap's extra exclude list. */
function otherSlotIds(slots, slot) {
  const ids = [];
  for (const item of slots) {
    if (item.slot === slot) continue;
    if (typeof item.entryId === "string" && item.entryId !== "") ids.push(item.entryId);
  }
  return ids;
}

/**
 * Swap one of the day's cards.
 *
 * The day is established first, exactly as a read of it would be (`dayCards`),
 * so a swap is a re-roll of what is already on screen and never a way to draw a
 * card the day would not have drawn. The slot then gets one new chunk:
 *
 *   swap       item.swap + 1, so the picker's seed moves
 *   exclude    the slot's own `seen` list plus every other slot's entryId, so
 *              a swap neither repeats a card the slot showed nor hands out a
 *              chunk another card of the day already holds
 *   area       the slot's PLANNED area, so a swap keeps the week's balance
 *
 * A card that is Done is not swapped, and the day's cap is today.js's
 * MAX_SWAPS: the last allowed swap is swap MAX_SWAPS, and the next call answers
 * the card on screen with `refused: true`. Nothing outside the exclude list
 * being eligible refuses the same way. Every refusal, and every request for a
 * slot that is not one of the day's cards (an off day, a name that is not a
 * slot, a slot of another card count, a slot left empty), writes nothing at
 * all.
 *
 * A successful swap writes the slot row, and mirrors it into `moves.today` when
 * the slot is the day's Now card — the same mirror `dayCards` writes. The day's
 * `moveneed` row, its other slot rows, its `moveslot`/`movestand` flags and
 * `moves.history` are all left alone: a swap is one card, not a new day.
 */
export async function swapSlot(db, {
  slot, now = Date.now(), weather = null, library, emit, lang = "en",
} = {}) {
  const at = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const out = await dayCards(db, { now: at, weather, library, emit, lang });
  const slots = Array.isArray(out.slots) ? out.slots : [];
  const item = slots.find((s) => s.slot === slot) ?? null;

  // Not a card of this day: a paused day, a name that is not a slot, a slot the
  // day's card count left out, or a slot nothing could be picked for.
  if (out.off || !item || item.empty || !item.entryId) {
    return { day: out.day, slot, refused: true, empty: true };
  }
  if (item.done === true || item.swap >= MAX_SWAPS) {
    return { ...item, day: out.day, refused: true };
  }

  const swap = item.swap + 1;
  const prefs = await readPrefs(db);
  const lib = Array.isArray(library) ? library : servedLibrary();
  // The history a swap picks with is the stored one: the day already holds its
  // cards, so nothing rolls over here and nothing is folded.
  const history = await readHistory(db);
  const learning = await learningFlows(db, lib);
  const weights = await dayWeights(db, at);
  const exclude = [...item.seen, ...otherSlotIds(slots, slot)];

  const picked = pickChunk({
    day: out.day,
    slot,
    area: item.plannedArea,
    weights,
    weather,
    prefs,
    history: { done: history.done, skipped: history.skipped, learning },
    library: lib,
    swap,
    exclude,
  });
  // Nothing outside the exclude list is eligible: a one-chunk library, or
  // limits that leave a single card. The card on screen stays, nothing written.
  if (!picked) return { ...item, day: out.day, refused: true };

  const seen = seenOf(picked.entryId, item.seen);
  await writeJson(db, SLOT_KEY_PREFIX + slot, {
    day: out.day,
    entryId: picked.entryId,
    area: picked.area,
    reasons: picked.reasons,
    swap,
    seen,
  }, emit);

  const next = {
    slot,
    entryId: picked.entryId,
    area: picked.area,
    plannedArea: item.plannedArea,
    reasons: picked.reasons,
    swap,
    seen,
    done: false,
    standIn: item.standIn,
    empty: false,
  };
  if (slot === out.nowSlot) await writeToday(db, { day: out.day, item: next, emit, lang });
  return { ...next, day: out.day, refused: false };
}
