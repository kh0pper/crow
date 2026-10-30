/**
 * The challenge picker (moves design Task 3; private engineering notes):
 * one library entry becomes today's challenge, chosen from the day, the
 * local hour, the weather, the user's prefs and their history.
 *
 * PURE AND DETERMINISTIC. No Math.random, no clock, no I/O. The only
 * randomness is an FNV-1a hash of `day + ":" + swap`, so the same inputs
 * always give the same pick on any device (sync-safe: two devices that
 * compute the same day agree), and Swap re-rolls the day by bumping `swap`.
 *
 * `reasons` are fact codes, never prose:
 *   "slot:early" | "slot:day" | "slot:evening"  the local slot the pick was made for
 *   "rain_later" | "cold" | "hot"               weather pushed the pick indoors
 *   "liked:<activity>"                          the picked activity is in prefs.kinds
 *   "learning_flow"                             the pick is a flow the user is learning
 *   "easy_day"                                  the picked entry is level 1
 */
import { LIMIT_TAGS } from "./library.js";

/** early is before 9, evening is from 17, day otherwise. */
export function slotFor(hourLocal) {
  const h = Number(hourLocal);
  if (!Number.isFinite(h)) return "day";
  if (h < 9) return "early";
  if (h >= 17) return "evening";
  return "day";
}

/**
 * FNV-1a, 32-bit, then murmur3's fmix32 finalizer. FNV alone barely moves the
 * HIGH bits when only the last character differs ("<day>:0" vs "<day>:1"), and
 * the pick reads the high bits, so Swap almost never changed the challenge.
 */
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Slot preferences are WEIGHTS (x3), never a hard filter — a day with
 * nothing preferred still picks something:
 *   early   -> yoga (a pose or a flow)
 *   day     -> walk / jog / run
 *   evening -> band / bodyweight, or a gentle (level 1) yoga flow
 */
const SLOT_LIKES = {
  early: (e) => e.activity === "yoga" && (e.kind === "pose" || e.kind === "flow"),
  day: (e) => e.activity === "walk" || e.activity === "jog" || e.activity === "run",
  evening: (e) => e.activity === "band" || e.activity === "bodyweight"
    || (e.activity === "yoga" && e.kind === "flow" && e.level === 1),
};

const RAIN_PCT = 60; // rain >= 60% -> indoor only
const COLD_C = 2;    // temp < 2°C   -> indoor only
const HOT_C = 34;    // temp > 34°C  -> indoor only

/**
 * Pick today's challenge. Returns { entryId, reasons } or null when nothing
 * survives the filters. Inputs:
 *   day        opaque local-day string (the picker never looks at a clock)
 *   hourLocal  0-23, for the slot
 *   weather    { rain: 0..100, temp, code } | null
 *   prefs      { on, kinds, equipment, limits, level, weather } (kinds = the kinds the user likes)
 *   history    { done: {id:count}, skipped: {id:count}, learning: [flowId] }
 *   library    array of entries (see library.js for the shape)
 *   swap       0 for the first pick of the day, +1 per Swap
 */
export function pickChallenge({
  day, hourLocal = 12, weather = null, prefs = {}, history = {}, library = [], swap = 0,
} = {}) {
  const slot = slotFor(hourLocal);
  const kinds = Array.isArray(prefs.kinds) ? prefs.kinds : [];
  const equipment = Array.isArray(prefs.equipment) ? prefs.equipment : [];
  // Stated limits always win; only the fixed vocabulary (library.js) counts.
  const limits = (Array.isArray(prefs.limits) ? prefs.limits : []).filter((t) => LIMIT_TAGS.includes(t));
  const level = [1, 2, 3].includes(prefs.level) ? prefs.level : 3;
  const liked = kinds;
  const skipped = history.skipped && typeof history.skipped === "object" ? history.skipped : {};
  const learning = Array.isArray(history.learning) ? history.learning : [];

  // Weather is a HARD indoor-only rule, unless the user turned it off
  // (prefs.weather === false).
  const w = weather && prefs.weather !== false ? weather : null;
  const temp = w && typeof w.temp === "number" && Number.isFinite(w.temp) ? w.temp : null;
  const rain = !!w && Number(w.rain) >= RAIN_PCT;
  const cold = temp !== null && temp < COLD_C;
  const hot = temp !== null && temp > HOT_C;
  const indoorOnly = rain || cold || hot;

  // Rule 1: filter. Rules 2 and 4: weight.
  const candidates = [];
  for (const e of Array.isArray(library) ? library : []) {
    if (!e || typeof e !== "object" || e.reviewed !== true) continue;
    if ((Array.isArray(e.skipIf) ? e.skipIf : []).some((t) => limits.includes(t))) continue;
    if (kinds.length > 0 && !kinds.includes(e.activity)) continue;
    if (e.level > level) continue;
    if (!(Array.isArray(e.equipment) ? e.equipment : []).every((x) => x === "none" || equipment.includes(x))) continue;
    if (indoorOnly && e.indoor !== true) continue;
    let weight = 1;
    if (SLOT_LIKES[slot](e)) weight *= 3;
    if (e.kind === "flow" && learning.includes(e.id)) weight *= 3;
    if (Number(skipped[e.id]) >= 3) weight *= 0.3;
    candidates.push({ entry: e, weight });
  }
  // Rule 6: null when nothing survives.
  if (candidates.length === 0) return null;

  // Rule 5: a weighted pick by the seeded hash. Sort by id first so the
  // result never depends on the library's order.
  candidates.sort((a, b) => (a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0));
  const seed = fnv1a(String(day) + ":" + String(swap));
  const total = candidates.reduce((sum, c) => sum + c.weight, 0);
  let at = (seed / 0x100000000) * total;
  let chosen = candidates[candidates.length - 1].entry;
  for (const c of candidates) {
    at -= c.weight;
    if (at < 0) { chosen = c.entry; break; }
  }

  const reasons = ["slot:" + slot];
  if (rain) reasons.push("rain_later");
  if (cold) reasons.push("cold");
  if (hot) reasons.push("hot");
  if (liked.includes(chosen.activity)) reasons.push("liked:" + chosen.activity);
  if (chosen.kind === "flow" && learning.includes(chosen.id)) reasons.push("learning_flow");
  if (chosen.level === 1) reasons.push("easy_day");
  return { entryId: chosen.id, reasons };
}
