/**
 * Recording a finished chunk, and the one place a day's completion is settled
 * (moves design Task 2; private engineering notes).
 *
 * TWO CALLS, ONE OF WHICH NEVER WRITES BY ITSELF:
 *   recordSlotDone  the player finished a card (or a chunk beyond the day's
 *                   cards), by their own session, a class, or a stand-in.
 *   settleDay       the day is judged finished: the streak's upgrade row (once
 *                   per instance), the `moveall` cache row and the streak
 *                   heart. Nothing else in moves writes either.
 *
 * OUTDOOR SESSIONS (startOutdoor / finishOutdoor) are the third writer. A walk
 * or jog is a Start/Done session rather than a chunk: its elapsed minutes,
 * capped at an hour, are what pays — through the outdoor day budget only, never
 * CHUNK_MAX — and at ten minutes or more it also stands in for the day's cards,
 * never for the one card a balancing chunk is kept for.
 *
 * STAND-INS (assignStandIn) are the fourth writer. A log or the step goal fills
 * exactly one of the day's open cards; a stand-in never pays (no budget claim,
 * no pet feed).
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
 * session and a class count a balance (`movebal`) here: a walk is not a
 * balance, and a stand-in is somebody else's movement reported on the player's
 * behalf, so `recordSlotDone` never balances a day from a stand-in via. The one
 * exception is `assignStandIn`'s log stand-in: a `yoga`, `band` or `bodyweight`
 * log whose area is a balancing one is the chunk the day was kept open for, and
 * that call writes the `movebal` row itself. The `movebal` row is the day's
 * second half of the completion rule, which is exactly why it may not be earned
 * by proxy.
 *
 * ⚠ EVERY ROW WRITTEN HERE IS THE CONSTANT 1, keyed by day (or day and slot /
 * area), because applyRambleWallet merges a key conflict with MAX(delta). Every
 * write goes through `insertOnce` (steps.js), so the first writer wins and every
 * later one is a no-op that reports itself as not fresh.
 *
 * NOTHING HERE IS A READ PATH. `isDayComplete`, `streakState`, `weekState` and
 * `dayCards` must never call `settleDay`: a read of a day is always a read.
 */
import { localDay, settleHappyDay } from "../eggs.js";
import {
  casDelta, insertOnce, readStepSettings, rowDelta, stepsToday, WALKED_KIND,
} from "../steps.js";
import { feed as petFeed, petState } from "../pet.js";
import {
  MOVE_ALL_KIND, MOVE_BAL_KIND, MOVE_SLOT_KIND, MOVE_STAND_KIND, isDayComplete,
} from "./day-complete.js";
import { MOVE_AREA_KIND, SLOTS } from "./week.js";
import { AREAS, ACTIVITY_KINDS, BALANCE_AREAS } from "./library.js";
import { awardStreakHeart, ensureStreakV2 } from "./streak.js";
import { capDayKey, claimCapped } from "./indoor-cap.js";
import { MOVE_MIN_KIND } from "./progress.js";
import {
  areaFor, CHUNK_RATE, EFFORTS, MOVE_LOG_KIND, MOVE_OUTDOOR_KIND,
  MovesInputError, OUTDOOR_DAILY_CAP,
} from "./ledger.js";

/** Who ran the chunk. `standin-*` is somebody else's movement, reported for the player. */
export const VIA = Object.freeze(["player", "class", "outdoor", "standin-log", "standin-steps"]);

/** The vias that are the player's own session on a chunk, so the one that can balance a day. */
const BALANCE_VIAS = Object.freeze(["player", "class"]);

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

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
 * when it holds, the streak's upgrade row is written the first time this
 * instance sees a complete day, the day's `moveall` cache row is inserted once
 * and the streak heart for that day is offered. The heart is awarded at the
 * day's own local noon when the day is not today, so a day finished just after
 * midnight pays `streak:<yesterday>` rather than opening a new day's run. When
 * the day is not complete nothing is written at all, and a second settle on a
 * complete day writes nothing new: all three rows are keyed by the day.
 */
export async function settleDay(db, { day, now = Date.now(), emit, need } = {}) {
  const at = asAt(now);
  const complete = await isDayComplete(db, day, { need });
  if (!complete) return { complete: false, fresh: false };

  await ensureStreakV2(db, { day: localDay(at), emit, now: at });
  const fresh = await insertOnce(db, MOVE_ALL_KIND, day, 1, at, emit);
  const heartAt = day === localDay(at) ? at : noonOf(day);
  await awardStreakHeart(db, { now: heartAt, emit });
  return { complete: true, fresh };
}

/* ------------------------------------------------------- outdoor sessions */

/**
 * Ramble setting holding this instance's open outdoor session:
 * `{ day, startedAt, entryId, sessionKey, finished, ...result }`.
 *
 * A `local.` key, so it never replicates and is never emitted: it is this
 * instance's own bookkeeping about a session in progress (the same rule as
 * progress.js's start and best records), not a fact about the player.
 */
export const OUTDOOR_SESSION_KEY = "local.moves.outdoor";

/** The most one outdoor session credits, whatever the wall clock says. */
export const OUTDOOR_MINUTES_MAX = 60;

/** The shortest session that stands in for a card, marks the area and badges the walk. */
const CARD_MIN_MINUTES = 10;

/**
 * Health an outdoor session of `minutes` pays: the chunk rate, never the chunk
 * ceiling, because a session's whole length is what it is worth and the day's
 * budget (OUTDOOR_DAILY_CAP) is the only thing that cuts it short. Junk pays 0.
 *
 *   9 min -> 11      10 min -> 12      30 min -> 36      60 min -> 72
 */
export function outdoorPoints(minutes) {
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) return 0;
  return Math.round(CHUNK_RATE * minutes);
}

/**
 * One stored session row as a readable record, or null when it is not one.
 * Every field is checked on its own: a row without a usable start or session
 * key is no session at all, and a result field that is missing reads as its
 * zero value.
 */
function normalizeSession(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (typeof raw.day !== "string" || !DAY_RE.test(raw.day)) return null;
  const startedAt = Number(raw.startedAt);
  if (!Number.isFinite(startedAt)) return null;
  if (typeof raw.sessionKey !== "string" || raw.sessionKey === "") return null;
  const whole = (value) => (Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : 0);
  return {
    day: raw.day,
    startedAt,
    entryId: typeof raw.entryId === "string" && raw.entryId !== "" ? raw.entryId : null,
    sessionKey: raw.sessionKey,
    finished: raw.finished === true,
    minutes: whole(raw.minutes),
    paid: whole(raw.paid),
    filled: Array.isArray(raw.filled) ? raw.filled.filter((slot) => typeof slot === "string") : [],
    needsBalance: raw.needsBalance === true,
  };
}

/** The stored session, or null when there is none (or it cannot be read). */
async function readSession(db) {
  try {
    const { rows } = await db.execute({
      sql: "SELECT value FROM ramble_settings WHERE key = ?",
      args: [OUTDOOR_SESSION_KEY],
    });
    const value = rows[0]?.value;
    if (typeof value !== "string") return null;
    return normalizeSession(JSON.parse(value));
  } catch { return null; }
}

/**
 * Store the session row. Plain `ramble_settings` SQL, and NO emit: a `local.`
 * key is this instance's own, so nothing about it leaves the box.
 */
async function writeSession(db, row) {
  await db.execute({
    sql: `INSERT INTO ramble_settings (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    args: [OUTDOOR_SESSION_KEY, JSON.stringify(row)],
  });
}

/** The stored session for the panel's reload, or null when there is none. */
export async function outdoorState(db) {
  const stored = await readSession(db);
  if (!stored) return null;
  return {
    day: stored.day,
    startedAt: stored.startedAt,
    entryId: stored.entryId,
    sessionKey: stored.sessionKey,
    finished: stored.finished,
  };
}

/**
 * Open an outdoor session: when it started, and the key that names it.
 *
 * IDEMPOTENT while a session of THIS day is open: an unfinished row of the
 * day the start credits is answered exactly as it was written, so a retried or
 * reloaded start keeps its original anchor (and a walk cannot be restarted to
 * shorten itself). A finished row is replaced — the next session of the day is
 * a new session — and so is an unfinished row of any other day, because a Done
 * nobody pressed must not turn the next day's start into one long session.
 *
 * `day` goes through `capDayKey`, so the day a session credits is the one it
 * started on, and an entryId is required: a session with no entry has nothing
 * to show the player.
 */
export async function startOutdoor(db, { day, entryId, now = Date.now() } = {}) {
  const at = asAt(now);
  const d = capDayKey(day, at);
  if (typeof entryId !== "string" || entryId === "") {
    throw new MovesInputError("entryId must be a non-empty string");
  }

  const stored = await readSession(db);
  if (stored && stored.finished !== true && stored.day === d) {
    return { startedAt: stored.startedAt, sessionKey: stored.sessionKey };
  }

  const sessionKey = `${d}:o:${Math.floor(at / 1000)}`;
  await writeSession(db, { day: d, startedAt: at, entryId, sessionKey, finished: false });
  return { startedAt: at, sessionKey };
}

/** How many stand-ins the day already carries: one `movestand` row per slot. */
async function standInCount(db, day) {
  try {
    const { rows } = await db.execute({
      sql: "SELECT key FROM ramble_wallet WHERE kind = ? AND key LIKE ?",
      args: [MOVE_STAND_KIND, `${day}:%`],
    });
    let count = 0;
    for (const row of Array.isArray(rows) ? rows : []) {
      const key = String(row?.key ?? "");
      if (key.slice(0, day.length + 1) !== `${day}:`) continue;
      if (!SLOTS.includes(key.slice(day.length + 1))) continue;
      count += 1;
    }
    return count;
  } catch { return 0; }
}

/**
 * Grow the day's whole-minute row by the minutes a session covered. Best
 * effort, the same shape as progress.js `growMinutes`: a lost compare-and-swap
 * leaves the count short, which under-counts and never blocks a pay.
 */
async function growMinutes(db, day, minutes, { now, emit }) {
  const increase = Math.floor(minutes);
  if (!(increase > 0)) return;
  try {
    const held = await rowDelta(db, MOVE_MIN_KIND, day);
    const from = held === null ? null : Math.max(0, Number(held) || 0);
    await casDelta(db, MOVE_MIN_KIND, day, from, (from ?? 0) + increase, now, emit);
  } catch (err) {
    try { console.warn("[ramble moves] movemin write failed:", err?.message); } catch {}
  }
}

/** The day's cards as this call may use them: only the pay day's, and only if they are a list. */
function usableCards(cards, day) {
  if (!cards || typeof cards !== "object" || Array.isArray(cards)) return null;
  if (cards.day !== day) return null;
  if (!Array.isArray(cards.slots)) return null;
  const need = Number.isInteger(cards.need) && cards.need >= 1 ? cards.need : 0;
  return { need, slots: cards.slots };
}

/** The slot's position in the day, so "in slot order" is the plan's order. */
const bySlotOrder = (a, b) => SLOTS.indexOf(a.slot) - SLOTS.indexOf(b.slot);

/** How a walk prefers a card: the heart one, then a free slot, then the rest. */
function walkRank(area) {
  if (area === "heart") return 0;
  if (area === "free") return 1;
  return 2;
}

const byWalkOrder = (a, b) => walkRank(a.area) - walkRank(b.area) || bySlotOrder(a, b);

/**
 * Fill the cards a walk stands in for, and answer their slot names.
 *
 * `count` is `min(minutes / 10, need - 1 - stand-ins already used, eligible)`
 * and never below 0, so a day can never be filled by walks alone: one card is
 * always left for a balancing chunk, and a stand-in the day already used counts
 * against it. `eligible` is the day's open, non-empty cards ordered heart
 * first, then free, then in slot order — MINUS the last open card a balancing
 * chunk fits (BALANCE_AREAS), which a walk never takes.
 *
 * Each filled card is recorded through `recordSlotDone` with a `walk` entry (so
 * it trains the heart and never balances the day) and one `movestand` row,
 * which is the approved mark of a stand-in such as a walk.
 */
async function fillCards(db, { day, cards, minutes, stands, now, emit }) {
  const filled = [];
  const room = cards.need - 1 - stands;
  if (cards.need < 1 || room <= 0) return filled;

  const open = [];
  for (const item of cards.slots) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    if (!SLOTS.includes(item.slot)) continue;
    if (item.empty === true) continue;
    // Read, not trusted: a card is done when its `moveslot` row exists.
    // eslint-disable-next-line no-await-in-loop
    if ((await rowDelta(db, MOVE_SLOT_KIND, `${day}:${item.slot}`)) !== null) continue;
    open.push(item);
  }

  const balancing = open.filter((item) => BALANCE_AREAS.includes(item.area)).sort(bySlotOrder);
  const keptOpen = balancing.length > 0 ? balancing[balancing.length - 1] : null;
  const eligible = open.filter((item) => item !== keptOpen).sort(byWalkOrder);

  const count = Math.max(0, Math.min(Math.floor(minutes / CARD_MIN_MINUTES), room, eligible.length));
  for (const item of eligible.slice(0, count)) {
    // eslint-disable-next-line no-await-in-loop
    await recordSlotDone(db, {
      day,
      slot: item.slot,
      entry: { kind: "walk", areas: ["heart"] },
      via: "outdoor",
      now,
      emit,
      need: cards.need,
    });
    // eslint-disable-next-line no-await-in-loop
    await insertOnce(db, MOVE_STAND_KIND, `${day}:${item.slot}`, 1, now, emit);
    filled.push(item.slot);
  }
  return filled;
}

/**
 * Finish the open outdoor session: pay it by its minutes, count them, and let a
 * long enough walk stand in for the day's cards.
 *
 * `minutes = min(60, floor((now - startedAt) / 60000))`, and the session's
 * target is `outdoorPoints(minutes)`; it pays `target - what it already paid`
 * through the OUTDOOR day budget, which is the only cap (no CHUNK_MAX, no
 * per-block rounding up), and feeds the pet only when the claim paid something.
 * The pay day is `capDayKey(session.day, now)`, so a session started at 23:50
 * and finished at 00:10 credits the day it started on.
 *
 * At CARD_MIN_MINUTES and over it also marks the day's heart area and writes
 * the `walked` badge fact, settling the happy day when that fact is new, and it
 * fills cards (`fillCards`). The day's cards are PASSED IN as the caller's own
 * `dayCards` result — this module never imports slots.js — and they are used
 * only when they are the PAY day's own draw: a missing set, or one drawn for
 * any other day (the new day's cards handed in by a session finished just
 * after midnight), fills none of them while the pay, the minutes, the heart
 * area and the walked fact still happen.
 *
 * `needsBalance` says the day still wants a balancing chunk: no `movebal` row
 * and the stand-ins plus these cards already reach `need - 1`, so the cards
 * still open are the ones a balance fits.
 *
 * The result is stored ON the session row, so a repeated finish of the same
 * session answers the same minutes and cards, pays 0 and writes nothing.
 * With no session row at all there is nothing to finish: `MovesInputError`.
 */
export async function finishOutdoor(db, { day, now = Date.now(), emit, cards } = {}) {
  // `day` is accepted for the caller's convenience only: the pay day is the
  // SESSION row's day, so a walk finished just after midnight credits the day
  // it started on.
  void day;
  const at = asAt(now);
  const session = await readSession(db);
  if (!session) throw new MovesInputError("start a session first");

  if (session.finished) {
    return {
      minutes: session.minutes,
      filled: [...session.filled],
      paid: 0,
      needsBalance: session.needsBalance,
      walkedNew: false,
    };
  }

  const minutes = Math.max(0, Math.min(OUTDOOR_MINUTES_MAX, Math.floor((at - session.startedAt) / 60000)));
  const d = capDayKey(session.day, at);
  const want = Math.max(0, outdoorPoints(minutes) - session.paid);

  // The budget is claimed FIRST, then the pet is fed — a lost claim, an
  // exhausted budget or a crash between the writes pays 0 (`ledger.js`'s rule).
  let paid = 0;
  if (want > 0) {
    const claim = await claimCapped(db, {
      kind: MOVE_OUTDOOR_KIND, cap: OUTDOOR_DAILY_CAP, day: d, points: want, now: at, emit,
    });
    if (claim.paid > 0) {
      // The bird's owed decay is applied first: decay landing afterwards would
      // clamp the Health just paid away.
      await petState(db, { now: at });
      await petFeed(db, { type: "move", amount: claim.paid }, { now: at, emit });
      paid = claim.paid;
    }
  }

  await growMinutes(db, d, minutes, { now: at, emit });

  let walkedNew = false;
  if (minutes >= CARD_MIN_MINUTES) {
    await insertOnce(db, MOVE_AREA_KIND, `${d}:heart`, 1, at, emit);
    walkedNew = await insertOnce(db, WALKED_KIND, d, 1, at, emit);
    // A long walk is a movement fact, so the day may now count toward laying.
    if (walkedNew) await settleHappyDay(db, { now: at, emit });
  }

  const stands = await standInCount(db, d);
  const dayCardsIn = usableCards(cards, d);
  const filled = dayCardsIn && minutes >= CARD_MIN_MINUTES
    ? await fillCards(db, { day: d, cards: dayCardsIn, minutes, stands, now: at, emit })
    : [];
  const balanced = (await rowDelta(db, MOVE_BAL_KIND, d)) !== null;
  const needsBalance = Boolean(dayCardsIn)
    && dayCardsIn.need >= 1
    && !balanced
    && stands + filled.length >= dayCardsIn.need - 1;

  await writeSession(db, {
    day: session.day,
    startedAt: session.startedAt,
    entryId: session.entryId,
    sessionKey: session.sessionKey,
    finished: true,
    minutes,
    paid,
    filled,
    needsBalance,
  });

  return { minutes, filled, paid, needsBalance, walkedNew };
}

/* --------------------------------------------------------------- stand-ins */

/**
 * Ramble setting holding which stand-ins a day already used, as
 * `{ log: true, steps: true }`.
 *
 * A `local.` key, so it never replicates and is never emitted: it is this
 * instance's own bookkeeping about a day (the same rule as the outdoor session
 * row above), not a fact about the player.
 */
export const STANDIN_DAY_KEY = "local.moves.standin.";

/** The activities whose log can balance a day, when its area is a balancing one. */
const BALANCE_ACTIVITIES = Object.freeze(["yoga", "band", "bodyweight"]);

/** The stand-in flags the day already carries, as `{ log, steps }`. */
async function readStandInFlags(db, day) {
  try {
    const { rows } = await db.execute({
      sql: "SELECT value FROM ramble_settings WHERE key = ?",
      args: [STANDIN_DAY_KEY + day],
    });
    const value = rows[0]?.value;
    if (typeof value !== "string") return { log: false, steps: false };
    const parsed = JSON.parse(value);
    return { log: parsed?.log === true, steps: parsed?.steps === true };
  } catch { return { log: false, steps: false }; }
}

/** Mark one stand-in as used. Plain setting SQL, and NO emit: a local key. */
async function writeStandInFlag(db, day, field) {
  const flags = await readStandInFlags(db, day);
  flags[field] = true;
  await db.execute({
    sql: `INSERT INTO ramble_settings (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    args: [STANDIN_DAY_KEY + day, JSON.stringify(flags)],
  });
}

/** The day's cards as a stand-in may use them, or null when they state no card count. */
function standInCards(cards) {
  if (!cards || typeof cards !== "object" || Array.isArray(cards)) return null;
  if (!Array.isArray(cards.slots)) return null;
  const need = Number.isInteger(cards.need) && cards.need >= 1 ? cards.need : 0;
  if (need < 1) return null;
  return { need, slots: cards.slots };
}

/**
 * The cards a stand-in could still fill: a real pick with no `moveslot` row, in
 * slot order. Read from the wallet, never from the card's own `done` flag.
 */
async function openCards(db, day, slots) {
  const open = [];
  for (const item of slots) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    if (!SLOTS.includes(item.slot)) continue;
    if (item.empty === true) continue;
    if (typeof item.entryId !== "string" || item.entryId === "") continue;
    // eslint-disable-next-line no-await-in-loop
    if ((await rowDelta(db, MOVE_SLOT_KIND, `${day}:${item.slot}`)) !== null) continue;
    open.push(item);
  }
  return open.sort(bySlotOrder);
}

/** The five parts of a `movelog` key of `day`, or null when it is not one. */
function parseLogKey(logKey, day) {
  if (typeof logKey !== "string" || logKey === "") return null;
  if (!logKey.startsWith(`${day}:`)) return null;
  const parts = logKey.split(":");
  if (parts.length !== 5) return null;
  const [keyDay, minute, activity, mins, effort] = parts;
  if (keyDay !== day) return null;
  if (!/^\d+$/.test(minute)) return null;
  const minutes = Number(mins);
  if (!Number.isInteger(minutes) || minutes < 1) return null;
  if (!ACTIVITY_KINDS.includes(activity)) return null;
  if (!EFFORTS.includes(effort)) return null;
  return { day: keyDay, activity, minutes, effort };
}

/**
 * The card a reached step goal fills: the day's midday card, or — on a day
 * without one — the first open heart card, then the first open free one. A
 * midday card that is already Done answers null: the goal never takes a second
 * card of the day.
 */
function stepsSlot(slots, open) {
  const midday = slots.find((item) => item && typeof item === "object" && !Array.isArray(item)
    && item.slot === "midday"
    && item.empty !== true
    && typeof item.entryId === "string" && item.entryId !== "");
  if (midday) return open.find((item) => item.slot === "midday") ?? null;
  return open.find((item) => item.area === "heart")
    ?? open.find((item) => item.area === "free")
    ?? null;
}

/**
 * A log or the step goal stands in for ONE of the day's open cards.
 *
 * The day's cards come from the caller (`{ need, slots }`, moves/slots.js
 * `dayCards`): this module never imports slots.js. Every refusal writes nothing
 * and names itself in `reason`: a day that is not today (`not_today`), a source
 * that is not `log` or `steps` (`bad_source`), a log key that is not one of the
 * day's `movelog` rows (`no_log`) or is under ten minutes (`too_short`), a second
 * stand-in of the same source that day (`already_used`), a step count under the
 * goal (`goal_not_reached`), a named slot that is not an open card (`bad_slot`),
 * no open card at all (`no_card`), and the stand-ins a balancing chunk is kept
 * for (`last_balance`).
 *
 * COUNTING. `movestand` rows are the stand-ins the day has used. A stand-in that
 * is not balancing is allowed only while it leaves one card of `need` open, and
 * never on the last open card a balancing chunk fits (BALANCE_AREAS) while the
 * day has no `movebal` row — so walks, steps and other movement can never fill a
 * day by themselves.
 *
 * WHICH SLOT. A log fills the caller's named slot when one is given, else the
 * open card of its own area (the caller's `area` when it is one of AREAS, else
 * the activity's default from ACTIVITY_AREA), else the first open card. When
 * the card that falls out is the last open one a balancing chunk fits, another
 * open card is taken instead before the day is refused — a named slot is never
 * moved. A log of
 * `yoga`, `band` or `bodyweight` whose area is a balancing one is the balancing
 * chunk itself: it is exempt from the counting rule and writes the `movebal` row.
 * A reached step goal fills the midday card, or the first open heart card and
 * then the first open free one; it never balances. Each source is good for one
 * card a day, kept in the local setting STANDIN_DAY_KEY.
 *
 * Writes, in order: the balance row (balancing logs only), the `movestand` row
 * (once — a second assign for a slot writes nothing), the slot row and the areas
 * through `recordSlotDone`, and the local flag. A stand-in never pays: no budget
 * claim is made and the pet is never fed.
 */
export async function assignStandIn(db, {
  day, slot, source, logKey, area, now = Date.now(), emit, cards,
} = {}) {
  const at = asAt(now);
  const today = localDay(at);
  if (day !== today) return { ok: false, reason: "not_today" };
  if (source !== "log" && source !== "steps") return { ok: false, reason: "bad_source" };

  const plan = standInCards(cards);
  if (!plan) return { ok: false, reason: "no_card" };
  const open = await openCards(db, today, plan.slots);
  if (open.length === 0) return { ok: false, reason: "no_card" };

  const named = typeof slot === "string" && slot !== "" ? slot : null;
  if (named !== null && !open.some((item) => item.slot === named)) {
    return { ok: false, reason: "bad_slot" };
  }

  const flags = await readStandInFlags(db, today);
  let chosen = null;
  let logArea = null;
  let balancing = false;

  if (source === "log") {
    const info = parseLogKey(logKey, today);
    if (!info || (await rowDelta(db, MOVE_LOG_KIND, logKey)) === null) {
      return { ok: false, reason: "no_log" };
    }
    if (info.minutes < CARD_MIN_MINUTES) return { ok: false, reason: "too_short" };
    if (flags.log) return { ok: false, reason: "already_used" };
    logArea = areaFor(info.activity, area);
    balancing = BALANCE_ACTIVITIES.includes(info.activity)
      && logArea !== null
      && BALANCE_AREAS.includes(logArea);
    chosen = named === null ? null : open.find((item) => item.slot === named) ?? null;
    if (!chosen && logArea !== null) chosen = open.find((item) => item.area === logArea) ?? null;
    if (!chosen) chosen = open[0];
  } else {
    if (flags.steps) return { ok: false, reason: "already_used" };
    const settings = await readStepSettings(db);
    if ((await stepsToday(db, at, settings)) < settings.goal) {
      return { ok: false, reason: "goal_not_reached" };
    }
    chosen = stepsSlot(plan.slots, open);
    if (!chosen) return { ok: false, reason: "no_card" };
  }

  if (!balancing) {
    const stands = await standInCount(db, today);
    if (stands + 1 > plan.need - 1) return { ok: false, reason: "last_balance" };
    if ((await rowDelta(db, MOVE_BAL_KIND, today)) === null) {
      const balanceCards = open.filter((item) => BALANCE_AREAS.includes(item.area));
      const last = balanceCards.length > 0 ? balanceCards[balanceCards.length - 1] : null;
      if (last && last.slot === chosen.slot) {
        // The card a balancing chunk is kept for stays open. A stand-in that
        // does not balance may still take another open card, so the day is
        // only refused when there is none left; a slot the caller named is
        // answered as asked and never quietly moved.
        const other = named === null ? open.find((item) => item.slot !== last.slot) ?? null : null;
        if (!other) return { ok: false, reason: "last_balance" };
        chosen = other;
      }
    }
  }

  if (balancing) await insertOnce(db, MOVE_BAL_KIND, today, 1, at, emit);
  await insertOnce(db, MOVE_STAND_KIND, `${today}:${chosen.slot}`, 1, at, emit);
  const areas = source === "steps" ? ["heart"] : (logArea === null ? [] : [logArea]);
  const done = await recordSlotDone(db, {
    day: today,
    slot: chosen.slot,
    entry: { kind: "stand-in", areas },
    via: source === "log" ? "standin-log" : "standin-steps",
    now: at,
    emit,
    need: plan.need,
  });
  await writeStandInFlag(db, today, source);
  return { ok: true, slot: chosen.slot, all: done.all };
}
