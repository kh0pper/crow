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
 * `exclude` is part of the INPUT, never a re-roll: entry ids the caller has
 * already shown today (today's card and every earlier swap) are removed before
 * the roll, so Swap can never land back on the card it replaced. Same day,
 * same prefs, same history, same swap and the same exclude always give the
 * same pick. When the exclude list removes every candidate the answer is null —
 * the caller decides what to do, this module never quietly hands back an
 * excluded entry.
 *
 * `reasons` are fact codes, never prose:
 *   "slot:early" | "slot:day" | "slot:evening"  the local slot the pick was made for
 *   "rain_later" | "cold" | "hot"               weather pushed the pick indoors
 *   "liked:<activity>"                          the picked activity is in prefs.kinds
 *   "learning_flow"                             the pick is a flow the user is learning
 *   "easy_day"                                  the picked entry is level 1
 */
import { LIMIT_TAGS, ACTIVITY_KINDS, AREAS, isChunk } from "./library.js";

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

/** The three chunk slots, and the reason code each one reports. */
const CHUNK_SLOTS = Object.freeze(["morning", "midday", "evening"]);
const SLOT_CODES = Object.freeze({ morning: "early", midday: "day", evening: "evening" });
/** Where a requested area falls back to when it has no chunk, in order. */
const CHUNK_FALLBACK_AREAS = Object.freeze(["mobility", "core"]);

/** The areas an entry claims to train, as a list (junk is no areas at all). */
const areasOf = (entry) => (Array.isArray(entry.areas) ? entry.areas : []);

/**
 * The normalized prefs/history/weather/exclude values the filters read. Both
 * picks share it so "eligible" means exactly the same thing to each.
 */
function pickerInputs(prefs, history, weather, exclude) {
  const p = prefs && typeof prefs === "object" ? prefs : {};
  const h = history && typeof history === "object" ? history : {};
  const kinds = (Array.isArray(p.kinds) ? p.kinds : []).filter((k) => ACTIVITY_KINDS.includes(k));
  const equipment = Array.isArray(p.equipment) ? p.equipment : [];
  // Stated limits always win; only the fixed vocabulary (library.js) counts.
  const limits = (Array.isArray(p.limits) ? p.limits : []).filter((t) => LIMIT_TAGS.includes(t));
  const level = [1, 2, 3].includes(p.level) ? p.level : 3;
  const skipped = h.skipped && typeof h.skipped === "object" ? h.skipped : {};
  const learning = Array.isArray(h.learning) ? h.learning : [];
  // Junk in the exclude list is dropped rather than turned into a filter that
  // excludes everything: only non-empty string ids can match an entry.
  const excluded = new Set(
    (Array.isArray(exclude) ? exclude : []).filter((id) => typeof id === "string" && id !== ""),
  );
  // Weather is a HARD indoor-only rule, unless the user turned it off
  // (prefs.weather === false).
  const w = weather && p.weather !== false ? weather : null;
  const temp = w && typeof w.temp === "number" && Number.isFinite(w.temp) ? w.temp : null;
  const rain = !!w && Number(w.rain) >= RAIN_PCT;
  const cold = temp !== null && temp < COLD_C;
  const hot = temp !== null && temp > HOT_C;
  return {
    kinds, equipment, limits, level, skipped, learning, excluded,
    rain, cold, hot, indoorOnly: rain || cold || hot,
  };
}

/** Whether one library entry may be offered at all under these inputs. */
function eligible(entry, f) {
  if (!entry || typeof entry !== "object" || entry.reviewed !== true) return false;
  if (!isChunk(entry)) return false; // a card is a chunk; poses and short exercises stay for Learn
  if (f.excluded.has(entry.id)) return false; // a swap must not re-land on a shown entry
  if ((Array.isArray(entry.skipIf) ? entry.skipIf : []).some((t) => f.limits.includes(t))) return false;
  if (f.kinds.length > 0 && !f.kinds.includes(entry.activity)) return false;
  if (!(entry.level <= f.level)) return false; // a missing or odd level never passes
  if (!(Array.isArray(entry.equipment) ? entry.equipment : [])
    .every((x) => x === "none" || f.equipment.includes(x))) return false;
  if (f.indoorOnly && entry.indoor !== true) return false;
  return true;
}

/** The reasons array both picks build from one chosen entry. */
function reasonsFor(chosen, f, slotCode) {
  const reasons = ["slot:" + slotCode];
  if (f.rain) reasons.push("rain_later");
  if (f.cold) reasons.push("cold");
  if (f.hot) reasons.push("hot");
  if (f.kinds.includes(chosen.activity)) reasons.push("liked:" + chosen.activity);
  if (chosen.kind === "flow" && f.learning.includes(chosen.id)) reasons.push("learning_flow");
  if (chosen.level === 1) reasons.push("easy_day");
  return reasons;
}

/** Candidates by id, so the library's own order never reaches the roll. */
const byEntryId = (a, b) => (a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0);

/** The seeded weighted roll: the hash picks a slice of the total weight. */
function roll(candidates, seed) {
  const total = candidates.reduce((sum, c) => sum + c.weight, 0);
  let at = (seed / 0x100000000) * total;
  let chosen = candidates[candidates.length - 1].entry;
  for (const c of candidates) {
    at -= c.weight;
    if (at < 0) { chosen = c.entry; break; }
  }
  return chosen;
}

/** One area's weight; anything missing or unreadable counts as 1. */
function areaWeight(weights, area) {
  const v = weights[area];
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 1;
}

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
 *   exclude    entry ids that must NOT be picked (the day's `seen` list);
 *              optional, and part of the deterministic input
 */
export function pickChallenge({
  day, hourLocal = 12, weather = null, prefs = {}, history = {}, library = [], swap = 0,
  exclude = [],
} = {}) {
  const slot = slotFor(hourLocal);
  const f = pickerInputs(prefs, history, weather, exclude);
  const { skipped, learning } = f;

  // Rule 1: filter. Rules 2 and 4: weight.
  const candidates = [];
  for (const e of Array.isArray(library) ? library : []) {
    if (!eligible(e, f)) continue;
    let weight = 1;
    if (SLOT_LIKES[slot](e)) weight *= 3;
    if (e.kind === "flow" && learning.includes(e.id)) weight *= 3;
    if (Number(skipped[e.id]) >= 3) weight *= 0.3;
    candidates.push({ entry: e, weight });
  }
  // Rule 6: null when nothing survives — including when the caller's exclude
  // list took the last candidate away (a swap with nothing else eligible).
  if (candidates.length === 0) return null;

  // Rule 5: a weighted pick by the seeded hash. Sort by id first so the
  // result never depends on the library's order.
  candidates.sort(byEntryId);
  const seed = fnv1a(String(day) + ":" + String(swap));
  const chosen = roll(candidates, seed);
  return { entryId: chosen.id, reasons: reasonsFor(chosen, f, slot) };
}

/**
 * Pick one chunk for a slot and a body area (moves design Task 4; private
 * engineering notes). Returns { entryId, area, reasons } or null.
 *
 * PURE AND DETERMINISTIC, like pickChallenge: the only randomness is the
 * FNV-1a hash of `day:slot:swap`, so the same inputs agree on every device.
 *
 * Eligibility is pickChallenge's exactly (same prefs handling, same weather
 * rule, chunks only). The area is a PREFERENCE the caller states, never a
 * hard guarantee: an area with no eligible chunk falls back to mobility, then
 * core, then null, and the returned `area` names the area actually used.
 *
 *   area    one of the AREAS, or "free"
 *   weights { <area>: 3 | 1 | 0.5 }, a missing area counts as 1
 *   slot    "morning" | "midday" | "evening" (junk slot or area -> null)
 *
 * In a named area every candidate rolls at weight 1 (x0.3 skipped three
 * times, x3 a flow the user is learning), but a chunk that ALSO trains an
 * area weighted 3 is preferred while any such chunk is eligible. In "free"
 * the candidate's own areas set the weight (its largest, missing = 1).
 */
export function pickChunk({
  day, slot, area, weights = {}, weather = null, prefs = {}, history = {}, library = [],
  swap = 0, exclude = [],
} = {}) {
  if (!CHUNK_SLOTS.includes(slot)) return null;
  const free = area === "free";
  if (!free && !AREAS.includes(area)) return null;
  const w = weights && typeof weights === "object" ? weights : {};

  const f = pickerInputs(prefs, history, weather, exclude);
  const pool = (Array.isArray(library) ? library : []).filter((e) => eligible(e, f));
  if (pool.length === 0) return null;

  let usedArea = area;
  let entries = pool;
  if (!free) {
    entries = pool.filter((e) => areasOf(e).includes(area));
    if (entries.length === 0) {
      for (const fallback of CHUNK_FALLBACK_AREAS) {
        entries = pool.filter((e) => areasOf(e).includes(fallback));
        if (entries.length > 0) { usedArea = fallback; break; }
      }
    }
    if (entries.length === 0) return null;
  }

  let candidates;
  if (free) {
    candidates = entries.map((e) => {
      const areas = areasOf(e);
      let weight = areas.length > 0
        ? Math.max(...areas.map((a) => areaWeight(w, a)))
        : 1;
      if (Number(f.skipped[e.id]) >= 3) weight *= 0.3;
      if (e.kind === "flow" && f.learning.includes(e.id)) weight *= 3;
      return { entry: e, weight };
    });
  } else {
    candidates = entries.map((e) => {
      let weight = 1;
      if (Number(f.skipped[e.id]) >= 3) weight *= 0.3;
      if (e.kind === "flow" && f.learning.includes(e.id)) weight *= 3;
      return { entry: e, weight };
    });
    // Balance: a chunk that also trains another area weighted 3 is the better
    // use of the slot's time, so it is kept while any such chunk is eligible.
    const scored = candidates.map((c) => ({
      c,
      score: areasOf(c.entry).filter((a) => a !== usedArea && areaWeight(w, a) === 3).length,
    }));
    const best = Math.max(...scored.map((s) => s.score));
    if (best > 0) candidates = scored.filter((s) => s.score === best).map((s) => s.c);
  }
  if (candidates.length === 0) return null;

  candidates.sort(byEntryId);
  const seed = fnv1a(String(day) + ":" + String(slot) + ":" + String(swap));
  const chosen = roll(candidates, seed);
  return { entryId: chosen.id, area: usedArea, reasons: reasonsFor(chosen, f, SLOT_CODES[slot]) };
}
