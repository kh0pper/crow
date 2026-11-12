/**
 * The week plan (moves design Task 4; private engineering notes): which body
 * area each of a day's slots asks for, and how much of the week's balance the
 * wallet shows so far.
 *
 * The plan is a FIXED table, not a search: given the number of cards a day the
 * user has chosen, the slots and the areas they train are the same for every
 * week, so the surface is deterministic and two devices draw the same week.
 * `windows` only renames the slots; it never invents a plan the tables do not
 * hold.
 *
 * The wallet side is READ ONLY. A finished card writes one
 * "movearea" row per area it trains (key "<day>:<area>", delta 1), and the
 * week's state is derived from those rows — the same append-only shape as the
 * rest of the currency ledger, so nothing here can lose a mark to a merge.
 *
 * Days are LOCAL days and weeks are ISO 8601 weeks (Monday first) of the local
 * date, matching what the rest of Ramble files its rows under. All date
 * arithmetic runs at local noon, so a DST change inside a week never shifts a
 * day string.
 */
import { localDay } from "../eggs.js";
import { AREAS } from "./library.js";

/** The three chunk slots of a day, in play order. */
export const SLOTS = Object.freeze(["morning", "midday", "evening"]);

/** The wallet kind that records one area trained on one day. */
export const MOVE_AREA_KIND = "movearea";

const DAY_MS = 86400000;
const WEEK_ID = /^(\d{4})-W(\d{2})$/;
const DAY_STR = /^(\d{4})-(\d{2})-(\d{2})$/;

/** How many cards a day the plan is built for: 1, 2 or 3 (anything else is 3). */
function cardsOf(cards) {
  return cards === 1 || cards === 2 ? cards : 3;
}

/** A local-noon Date for "YYYY-MM-DD", or null when the string is not a real day. */
function noonOf(dayStr) {
  const m = DAY_STR.exec(String(dayStr ?? ""));
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const date = new Date(y, mo - 1, d, 12, 0, 0, 0);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return date;
}

/** ISO weekday of a Date: Monday 1 .. Sunday 7. */
const isoDayOf = (date) => ((date.getDay() + 6) % 7) + 1;

/** The Monday of ISO week 1 of `year`, at local noon. */
function firstMonday(year) {
  const jan4 = new Date(year, 0, 4, 12, 0, 0, 0);
  return new Date(year, 0, 5 - isoDayOf(jan4), 12, 0, 0, 0);
}

/** A copy of `date`, shifted by `days` local days (local noon throughout). */
function plusDays(date, days) {
  const out = new Date(date.getTime());
  out.setDate(out.getDate() + days);
  return out;
}

/**
 * The slots a day uses when the user has not named their own, for 1, 2 or 3
 * cards. Two cards are a morning and an evening; one sits in the middle of the
 * day; anything that is not 1 or 2 is three cards.
 */
export function defaultSlots(cards) {
  const n = cardsOf(cards);
  if (n === 1) return ["midday"];
  if (n === 2) return ["morning", "evening"];
  return [...SLOTS];
}

/** The ISO week of the local date of `now`, as "YYYY-Www". */
export function weekIdOf(now) {
  const noon = noonOf(localDay(now));
  if (!noon) return "";
  // The Thursday of the day's week decides the week-year (ISO 8601).
  const thursday = plusDays(noon, 4 - isoDayOf(noon));
  const weekYear = thursday.getFullYear();
  const monday = firstMonday(weekYear);
  const week = Math.round((thursday.getTime() - monday.getTime()) / (7 * DAY_MS)) + 1;
  return `${weekYear}-W${String(week).padStart(2, "0")}`;
}

/**
 * The seven local day strings of an ISO week, Monday first. A week id that is
 * not a real week (bad shape, week 0, or a week 53 that the year does not
 * have) comes back as an empty list.
 */
export function weekDays(weekId) {
  const m = WEEK_ID.exec(String(weekId ?? ""));
  if (!m) return [];
  const year = Number(m[1]);
  const week = Number(m[2]);
  if (!Number.isInteger(year) || !Number.isInteger(week) || week < 1 || week > 53) return [];
  const monday = plusDays(firstMonday(year), (week - 1) * 7);
  const days = [];
  for (let i = 0; i < 7; i += 1) {
    const noon = plusDays(monday, i);
    days.push(localDay(noon.getTime()));
  }
  // A week 53 the year does not have rolls into the next week-year's week 1;
  // the round trip is what tells the two apart.
  const noon = noonOf(days[0]);
  if (!noon || weekIdOf(noon.getTime()) !== weekId) return [];
  return days;
}

/** Three cards: the third slot's area, by day 0 (Monday) to 6 (Sunday). */
const THIRD_AREA_BY_DAY = Object.freeze([
  "lower", "upper", "core", "lower", "upper", "core", "free",
]);

/** Two cards: the first and second slot's areas, by day. */
const PAIR_BY_DAY = Object.freeze([
  ["mobility", "lower"],
  ["heart", "upper"],
  ["core", "mobility"],
  ["heart", "lower"],
  ["upper", "core"],
  ["mobility", "free"],
  ["lower", "upper"],
]);

/** One card: the slot's area, by day. */
const ONE_AREA_BY_DAY = Object.freeze([
  "mobility", "lower", "upper", "core", "mobility", "lower", "upper",
]);

/**
 * The slot names a plan uses: `windows` when it names distinct slots of the
 * right count, the defaults otherwise, always in SLOTS order.
 */
function slotsFor(cards, windows) {
  const n = cardsOf(cards);
  if (Array.isArray(windows) && windows.length === n) {
    const named = new Set(windows.filter((w) => SLOTS.includes(w)));
    if (named.size === n) return SLOTS.filter((s) => named.has(s));
  }
  return defaultSlots(n);
}

/**
 * The week's plan: seven { dayIndex, slots } entries, dayIndex 0 = Monday. The
 * area of each slot comes from the fixed tables above; the week id is only
 * carried by the caller and never changes the shape of the plan.
 */
export function weekPlan(weekId, cards, windows) {
  const n = cardsOf(cards);
  const slots = slotsFor(n, windows);
  const plan = [];
  for (let d = 0; d < 7; d += 1) {
    const areas = n === 3
      ? ["mobility", "heart", THIRD_AREA_BY_DAY[d]]
      : n === 2
        ? PAIR_BY_DAY[d]
        : [ONE_AREA_BY_DAY[d]];
    const daySlots = {};
    slots.forEach((slot, i) => { daySlots[slot] = areas[i]; });
    plan.push({ dayIndex: d, slots: daySlots });
  }
  return plan;
}

/** The empty marks object: one list of day strings per area. */
function emptyMarks() {
  const marks = {};
  for (const area of AREAS) marks[area] = [];
  return marks;
}

/** The total the marks add up to: each area counts at most two days. */
function totalOf(marks) {
  return AREAS.reduce((sum, area) => sum + Math.min(2, marks[area].length), 0);
}

/** Add one day to an area's list, keeping it sorted and free of repeats. */
function addMark(marks, area, day) {
  const days = marks[area];
  if (days.includes(day)) return;
  days.push(day);
  days.sort();
}

/**
 * The week's balance so far, read from the "movearea" rows: which days mark
 * each area, the total (0 to 10) and whether the week is full. One query for
 * the whole week; nothing here writes.
 */
export async function weekState(db, { now } = {}) {
  const weekId = weekIdOf(now);
  const days = weekDays(weekId);
  const marks = emptyMarks();
  if (days.length === 0) return { weekId, marks, total: 0, full: false };

  const inWeek = new Set(days);
  const result = await db.execute({
    sql: "SELECT key FROM ramble_wallet WHERE kind = ? AND key >= ? AND key < ?",
    args: [MOVE_AREA_KIND, days[0], days[days.length - 1] + "~"],
  });
  for (const row of Array.isArray(result?.rows) ? result.rows : []) {
    const parts = String(row?.key ?? "").split(":");
    if (parts.length !== 2) continue;
    const [day, area] = parts;
    if (!inWeek.has(day)) continue;
    if (!AREAS.includes(area)) continue;
    addMark(marks, area, day);
  }

  const total = totalOf(marks);
  return { weekId, marks, total, full: total === 10 };
}

/**
 * How much each area asks for next: 1 when the week is full, otherwise 3 for
 * an area still short of two days and 0.5 for one that has them. An unreadable
 * state asks for nothing in particular, so every area comes back as 1.
 */
export function areaWeights(state) {
  const weights = {};
  for (const area of AREAS) weights[area] = 1;
  if (!state || typeof state !== "object") return weights;
  const marks = state.marks && typeof state.marks === "object" ? state.marks : null;
  if (!marks || state.full === true) return weights;
  for (const area of AREAS) {
    const days = Array.isArray(marks[area]) ? marks[area] : [];
    weights[area] = days.length >= 2 ? 0.5 : 3;
  }
  return weights;
}