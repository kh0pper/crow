/**
 * Today's challenge and the moves preferences (moves design Task 5; private
 * engineering notes).
 *
 * TWO SYNCED SETTINGS ROWS, plus the small history row that feeds the next
 * pick:
 *   moves.prefs   JSON { on, kinds, equipment, limits, level, weather, cards,
 *                       windows, contactsSeeMoved }
 *         cards = how many cards a day the week plan asks for (1, 2 or 3),
 *         windows = the slot names the user picked, in SLOTS order (empty means
 *         the default slots for that number of cards), contactsSeeMoved =
 *         whether the contacts feed may show that a card was done.
 *   moves.today   JSON { day, entryId, swap, seen, reasons, why }
 *         seen = the entry ids already shown today (the first pick and each
 *         swap), so a swap never re-lands on one; absent on rows written
 *         before it existed, which still read as "just the card on screen".
 *   moves.history JSON { done: {id:count}, skipped: {id:count} }
 *         written when a stored pick rolls over to a new day.
 *
 * Both are `ramble_settings` rows, so they replicate last-writer-wins through
 * applyRambleSetting — the same seam as the step settings. That is what makes
 * two devices agree on the day's challenge: each may pick locally, and after
 * one `moves.today` wins the LWW race both read the same entry back.
 *
 * ⚠ PICKS ARE PURE FUNCTIONS OF (day, hour, weather, prefs, history, swap,
 * exclude). pickChallenge (moves/picker.js) has no clock and no randomness
 * beyond a hash of `day + ":" + swap`, so a stored pick and a freshly computed
 * one agree on every device. A swap passes the ids already shown today as
 * `exclude`, and that list is stored beside the pick (`seen`) in the same
 * synced row, so the swap stays as reproducible as the first pick. Storing
 * `moves.today` is what carries the REUSE across calls
 * and across midnight (the day a challenge was picked for is the day its Done
 * is filed under — recordChallengeDone takes that day from here), not what
 * makes the pick itself stable.
 *
 * ⚠ NO FREE TEXT. `why` is built from the fixed reason-code vocabulary by
 * whyLine, never from anything the user typed. A free-text note ("my knee is
 * sore") is not stored in v1: the user tells the assistant.
 *
 * ⚠ STATED LIMITS ALWAYS WIN. A stored pick is re-examined against the live
 * limits on every read: setting `knee` after a knee-tagged card was stored
 * replaces the card rather than leaving it on screen, and swap never offers
 * one either (the picker filters, this module never bypasses it).
 *
 * Works without a model: Done, Swap and the seeded pick need none, and a
 * "something else" parse that fails falls back to the manual pickers.
 */
import { localDay } from "../eggs.js";
import { rowDelta, insertOnce } from "../steps.js";
import { MOVE_DONE_KIND } from "./ledger.js";
import {
  servedLibrary, entryById, isChunk, ACTIVITY_KINDS, EQUIPMENT, LIMIT_TAGS,
} from "./library.js";
import { pickChallenge } from "./picker.js";
import { learningFlows } from "./learning.js";
import { SLOTS } from "./week.js";

/** Synced setting: JSON prefs. */
export const PREFS_KEY = "moves.prefs";
/** Synced setting: JSON today's pick (and the swap count). */
export const TODAY_KEY = "moves.today";
/** Synced setting: JSON done/skipped counts per entry id. */
export const HISTORY_KEY = "moves.history";

/** Wallet kind: key `<day>`, delta 1 — the user paused challenges that day. */
export const MOVE_OFF_KIND = "moveoff";

/** The most re-rolls one day allows: swap 1, 2 and 3, and the fourth refuses. */
export const MAX_SWAPS = 3;

/**
 * The defaults from the design. `equipment` defaults to "none" plus the wall:
 * "none" marks the entries that need nothing, and the wall is the one thing a
 * plain room already has, so every entry that needs a mat, band or chair is out
 * until the user says they have one. A stored prefs row is never rewritten, so
 * this list only applies where nothing is saved yet. Limits come from
 * library.js's LIMIT_TAGS only.
 *
 * `cards` is three (the full day), and `windows` is empty, which means the
 * default slots for that number of cards. `contactsSeeMoved` starts true, so a
 * finished card is shareable until the user says otherwise.
 */
export const DEFAULT_PREFS = Object.freeze({
  on: true,
  kinds: Object.freeze([]),
  equipment: Object.freeze(["none", "wall"]),
  limits: Object.freeze([]),
  level: 2,
  weather: true,
  cards: 3,
  windows: Object.freeze([]),
  contactsSeeMoved: true,
});

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export class MovesPrefsError extends Error {
  constructor(message) { super(message); this.name = "MovesPrefsError"; }
}

function asAt(now) {
  return Number.isFinite(Number(now)) ? Number(now) : Date.now();
}

/** Mirrors steps.js/eggs.js: an emit must never be able to fail the write. */
async function safeEmit(emit, table, op, row) {
  if (typeof emit !== "function") return;
  try { await emit(table, op, row); }
  catch (err) { try { console.warn(`[ramble moves] emit ${table} failed:`, err?.message); } catch {} }
}

/** A JSON setting, or null when absent/unreadable/junk. */
export async function readJson(db, key) {
  try {
    const { rows } = await db.execute({
      sql: "SELECT value FROM ramble_settings WHERE key = ?",
      args: [key],
    });
    const value = rows[0]?.value;
    if (typeof value !== "string") return null;
    return JSON.parse(value);
  } catch { return null; }
}

/**
 * Write a JSON setting the way steps.js writes its own: the row first, then
 * the emit. `ramble_settings` is a last-writer-wins table, so the copied row
 * carrying the full value is all a peer needs.
 */
export async function writeJson(db, key, obj, emit) {
  const value = JSON.stringify(obj);
  await db.execute({
    sql: `INSERT INTO ramble_settings (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    args: [key, value],
  });
  await safeEmit(emit, "ramble_settings", "update", { key, value });
}

const isVocab = (v, vocab) => typeof v === "string" && vocab.includes(v);

/**
 * The slot names a stored `windows` names, in SLOTS order. Anything that is not
 * a list of slot names reads as no choice at all (the default slots), and a
 * repeat counts once: the list is a set of windows, not a schedule.
 */
function normalizeWindows(raw) {
  if (!Array.isArray(raw)) return [];
  const named = new Set(raw.filter((w) => isVocab(w, SLOTS)));
  return SLOTS.filter((s) => named.has(s));
}

/**
 * Coerce anything that came off disk or the wire into a complete prefs object.
 * Junk in ONE field falls back for that field alone: a peer on a newer version
 * writing a kind this build does not know must not blank the whole set.
 */
function normalizePrefs(raw) {
  const out = {
    ...DEFAULT_PREFS,
    kinds: [],
    equipment: [...DEFAULT_PREFS.equipment],
    limits: [],
    windows: [],
  };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  if (typeof raw.on === "boolean") out.on = raw.on;
  if (typeof raw.weather === "boolean") out.weather = raw.weather;
  if (typeof raw.contactsSeeMoved === "boolean") out.contactsSeeMoved = raw.contactsSeeMoved;
  if ([1, 2, 3].includes(raw.level)) out.level = raw.level;
  if ([1, 2, 3].includes(raw.cards)) out.cards = raw.cards;
  out.windows = normalizeWindows(raw.windows);
  if (Array.isArray(raw.kinds)) {
    out.kinds = raw.kinds.filter((k) => isVocab(k, ACTIVITY_KINDS));
  }
  if (Array.isArray(raw.equipment)) {
    out.equipment = raw.equipment.filter((e) => isVocab(e, EQUIPMENT));
    // Every value unknown (this build cannot read what the peer wrote) is the
    // same statement as no list at all, so it falls back to the defaults
    // ("none" plus the wall). An empty list would rule nothing in or out in
    // the picker and lie to the settings UI.
    if (out.equipment.length === 0) out.equipment = [...DEFAULT_PREFS.equipment];
  }
  if (Array.isArray(raw.limits)) {
    out.limits = raw.limits.filter((t) => isVocab(t, LIMIT_TAGS));
  }
  return out;
}

/** Live prefs, readable on a fresh db (all defaults). */
export async function readPrefs(db) {
  return normalizePrefs(await readJson(db, PREFS_KEY));
}

function checkList(field, value, vocab) {
  if (!Array.isArray(value)) throw new MovesPrefsError(`${field} must be an array`);
  for (const item of value) {
    if (!isVocab(item, vocab)) {
      throw new MovesPrefsError(`${field} must be drawn from ${vocab.join(", ")}; got ${String(item)}`);
    }
  }
  return [...new Set(value)];
}

/**
 * The patch vocabulary IS the shape readPrefs returns: every field there, and
 * nothing else. Derived from DEFAULT_PREFS so the two cannot drift apart.
 */
const PREF_FIELDS = Object.freeze(Object.keys(DEFAULT_PREFS));

/** Strict validation for a write; junk never reaches the synced row. */
function validatePrefsPatch(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new MovesPrefsError("prefs must be an object");
  }
  // A key this build does not know used to be dropped silently, so a typo
  // ("lvl", "limit") looked saved. Name it instead: the patch is a small fixed
  // vocabulary and the caller is owed the field, not a shrug.
  for (const field of Object.keys(patch)) {
    if (!PREF_FIELDS.includes(field)) {
      throw new MovesPrefsError(`unknown prefs field: ${field.slice(0, 40)}`);
    }
  }
  const out = {};
  for (const field of ["on", "weather", "contactsSeeMoved"]) {
    if (patch[field] === undefined) continue;
    if (typeof patch[field] !== "boolean") throw new MovesPrefsError(`${field} must be true or false`);
    out[field] = patch[field];
  }
  if (patch.level !== undefined) {
    if (![1, 2, 3].includes(patch.level)) throw new MovesPrefsError("level must be 1, 2 or 3");
    out.level = patch.level;
  }
  if (patch.cards !== undefined) {
    if (![1, 2, 3].includes(patch.cards)) throw new MovesPrefsError("cards must be 1, 2 or 3");
    out.cards = patch.cards;
  }
  if (patch.windows !== undefined) {
    // A window the plan cannot use is a statement the week cannot honour, so it
    // is refused rather than dropped, and a repeat is folded into one entry.
    if (!Array.isArray(patch.windows)) throw new MovesPrefsError(`windows must be drawn from ${SLOTS.join(", ")}`);
    for (const slot of patch.windows) {
      if (!isVocab(slot, SLOTS)) throw new MovesPrefsError(`windows must be drawn from ${SLOTS.join(", ")}`);
    }
    out.windows = normalizeWindows(patch.windows);
  }
  if (patch.kinds !== undefined) out.kinds = checkList("kinds", patch.kinds, ACTIVITY_KINDS);
  if (patch.equipment !== undefined) out.equipment = checkList("equipment", patch.equipment, EQUIPMENT);
  // The safety vocabulary is the strictest of the three: an unknown limit tag
  // is a statement the picker cannot honour, so it is refused, not stored.
  if (patch.limits !== undefined) out.limits = checkList("limits", patch.limits, LIMIT_TAGS);
  return out;
}

/** Merge a validated patch over the live prefs and store the result. */
export async function writePrefs(db, patch, { emit } = {}) {
  const next = validatePrefsPatch(patch);
  const prefs = { ...(await readPrefs(db)), ...next };
  await writeJson(db, PREFS_KEY, prefs, emit);
  return prefs;
}

/**
 * The entry ids shown today, oldest first: the first pick and every swap of
 * the day. This is the `exclude` list a swap is made with, so Swap can never
 * hand back a card the user has already seen.
 *
 * A stored row written before this list existed carries none; the card on
 * screen is appended here, which is exactly what the old "do not repeat
 * today's card" rule needs, so old settings keep working.
 *
 * The synced row carries at most one id per card a day can show (the pick and
 * MAX_SWAPS swaps). A longer list can only be junk or a newer build, so the
 * NEWEST ids are kept: they are the ones a swap is most likely to re-land on.
 */
export function seenOf(entryId, rawSeen) {
  const out = [];
  for (const id of [...(Array.isArray(rawSeen) ? rawSeen : []), entryId]) {
    if (typeof id !== "string" || id === "" || out.includes(id)) continue;
    out.push(id);
  }
  return out.slice(-(MAX_SWAPS + 1));
}

/** The stored pick for today, or null when absent/junk. */
export function normalizeToday(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (typeof raw.day !== "string" || !DAY_RE.test(raw.day)) return null;
  if (typeof raw.entryId !== "string" || raw.entryId === "") return null;
  // A stored count above the cap can only come from a peer's junk or a newer
  // build: CLAMP it, never reset — resetting to 0 would hand the day fresh
  // swaps on the next read.
  const swap = Number.isInteger(raw.swap) && raw.swap >= 0
    ? Math.min(raw.swap, MAX_SWAPS)
    : 0;
  const reasons = Array.isArray(raw.reasons) ? raw.reasons.filter((r) => typeof r === "string") : [];
  const why = typeof raw.why === "string" ? raw.why : whyLine(reasons);
  // No `seen` (a row from before it existed, or a peer's junk) reads as the
  // card on screen alone — see seenOf.
  const seen = seenOf(raw.entryId, raw.seen);
  return { day: raw.day, entryId: raw.entryId, swap, seen, reasons, why };
}

/** Non-negative integer counts only; a peer's junk entry is dropped. */
function countsOf(raw) {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [id, n] of Object.entries(raw)) {
    if (typeof id !== "string" || id === "") continue;
    const v = Number(n);
    if (Number.isInteger(v) && v > 0) out[id] = Math.min(v, 1_000_000);
  }
  return out;
}

export async function readHistory(db) {
  const raw = await readJson(db, HISTORY_KEY);
  return { done: countsOf(raw?.done), skipped: countsOf(raw?.skipped) };
}

/**
 * The history a pick should be made with, plus whether it needs writing. The
 * stored pick of a day that has rolled over counts as done when that day has a
 * `movedone` row, skipped otherwise. This is the only place entry ids outlive
 * their day — `movedone`'s key is the day alone (Task 4), so "which entry" has
 * to be remembered here.
 *
 * The fold is applied IN MEMORY, and the caller writes it only when it also
 * stores a new card: a day whose library yields nothing must not bank the same
 * rollover again on the next attempt.
 */
export async function historyWithRollover(db, stored) {
  const history = await readHistory(db);
  if (!stored || !stored.entryId) return { history, changed: false };
  const done = (await rowDelta(db, MOVE_DONE_KIND, stored.day)) !== null;
  const bucket = done ? history.done : history.skipped;
  bucket[stored.entryId] = (bucket[stored.entryId] ?? 0) + 1;
  return { history, changed: true };
}

/** A stored card the live limits have since ruled out must not be shown. */
export function blockedByLimits(entry, prefs) {
  if (!entry) return true;
  const tags = Array.isArray(entry.skipIf) ? entry.skipIf : [];
  return tags.some((t) => prefs.limits.includes(t));
}

/** The library a caller reads from: the served (reviewed) set unless injected. */
function libraryOf(library) {
  return Array.isArray(library) ? library : servedLibrary();
}

/**
 * Run the pure picker and resolve the entry, or null when nothing survives —
 * no candidate, or none outside the caller's `exclude` list.
 */
function pickFor({ day, at, prefs, history, swap, weather, library, learning, exclude = [] }) {
  const picked = pickChallenge({
    day,
    hourLocal: new Date(at).getHours(),
    weather,
    prefs,
    history: { done: history.done, skipped: history.skipped, learning },
    library,
    swap,
    exclude,
  });
  if (!picked) return null;
  const entry = entryById(library, picked.entryId);
  if (!entry) return null;
  return { entry, reasons: picked.reasons };
}

async function offState(db, day, at, emit) {
  // A pause is a FACT, keyed by the local day, so the streak can step over it
  // instead of counting it as a miss. insertOnce makes it one row a day.
  await insertOnce(db, MOVE_OFF_KIND, day, 1, at, emit);
  return { day, entry: null, reasons: [], why: "", done: false, off: true, swap: 0, seen: [] };
}

/**
 * Today's challenge, assembled the one way EVERY surface shows it.
 *
 * Ramble's own panel and Crow's For You page each gathered these inputs on
 * their own (For You passed the raw forecast and no learned flows). Two copies
 * of one assembly drift, and a mismatch means one day has two different cards.
 * This is the single assembly both call:
 *   - the live prefs, and `weather` dropped to null when `prefs.weather` is
 *     false (turning weather off must mean the picker never sees a forecast),
 *   - the library (`library` seam, else the served set),
 *   - the learned flows over that library (moves/learning.js).
 * Then it hands them to todayChallenge, which owns the storing and reuse.
 */
export async function todayForSurface(db, {
  now, weather = null, lang = "en", emit, library,
} = {}) {
  const prefs = await readPrefs(db);
  const lib = libraryOf(library);
  const learning = await learningFlows(db, lib);
  return todayChallenge(db, {
    now, weather: prefs.weather === false ? null : weather, lang, emit, library: lib, learning,
  });
}

/**
 * Today's challenge.
 *
 * Returns `{ day, entry, reasons, why, done, off, swap, seen }`, or null when the
 * filters leave nothing to pick (an empty/unreviewed library, or a limit set
 * that excludes every entry — the panel then offers the manual pickers).
 *
 * REUSE: a stored `moves.today` for the same local day is returned as-is when
 * it is still a card — a chunk the library holds and no limit rules out.
 * Anything else is a new day (or a first run): the previous pick is folded into
 * history and a fresh pick is stored. A same-day card the live limits rule out,
 * or one the picker would no longer offer (a pose, a short exercise, a card the
 * library has since dropped), is re-picked carrying the day's stored swap
 * count, so a replacement never reopens the cap, and the day's `seen` list, so
 * a replacement never forgets a card the user saw.
 *
 * When prefs.on is false it writes the day's `moveoff` fact and returns
 * `{ off: true }` — the pause neither counts nor breaks the streak.
 *
 * `library` and `learning` are injectable seams: production surfaces go
 * through todayForSurface (which reads the served library and the learned
 * flows); tests pass both directly.
 */
export async function todayChallenge(db, {
  now = Date.now(), weather = null, emit, library, learning = [], lang = "en",
} = {}) {
  const at = asAt(now);
  const day = localDay(at);
  const prefs = await readPrefs(db);
  if (prefs.on === false) return offState(db, day, at, emit);

  const lib = libraryOf(library);
  const stored = normalizeToday(await readJson(db, TODAY_KEY));

  if (stored && stored.day === day) {
    const entry = entryById(lib, stored.entryId);
    if (entry && isChunk(entry) && !blockedByLimits(entry, prefs)) {
      return {
        day,
        entry,
        reasons: stored.reasons,
        why: whyLine(stored.reasons, lang) || stored.why,
        done: (await rowDelta(db, MOVE_DONE_KIND, day)) !== null,
        off: false,
        swap: stored.swap,
        seen: stored.seen,
      };
    }
  }

  // A stored card for an earlier day is folded into history as part of the
  // pick below; a card for today that a new limit ruled out is simply
  // replaced (it was not declined by the user, so it is not a skip). The
  // replacement keeps today's swap count and seen list: a re-pick must not
  // reopen the cap, and must not forget a card the user already saw.
  const earlier = stored && stored.day !== day ? stored : null;
  const carriedSwap = stored && stored.day === day ? stored.swap : 0;
  const carriedSeen = stored && stored.day === day ? stored.seen : [];
  const { history, changed } = await historyWithRollover(db, earlier);
  const picked = pickFor({
    day, at, prefs, history, swap: carriedSwap, weather, library: lib, learning,
  });
  if (!picked) return null;

  if (changed) await writeJson(db, HISTORY_KEY, history, emit);
  const why = whyLine(picked.reasons, lang);
  const seen = seenOf(picked.entry.id, carriedSeen);
  await writeJson(db, TODAY_KEY, {
    day, entryId: picked.entry.id, swap: carriedSwap, seen, reasons: picked.reasons, why,
  }, emit);
  return {
    day,
    entry: picked.entry,
    reasons: picked.reasons,
    why,
    done: (await rowDelta(db, MOVE_DONE_KIND, day)) !== null,
    off: false,
    swap: carriedSwap,
    seen,
  };
}

/**
 * Swap today's challenge. Bumps the stored `swap`, re-rolls the seeded pick
 * and stores it. At most MAX_SWAPS re-rolls a day: swap 3 is the last one, and
 * the next call returns the same card with `refused: true` and writes nothing.
 *
 * A SWAP NEVER RE-LANDS ON A SHOWN ENTRY. The stored `seen` list (today's card
 * plus every card an earlier swap showed, at most MAX_SWAPS + 1 ids) is handed
 * to the picker as `exclude`, so each re-roll is a different card. When nothing
 * outside that list is eligible — a one-entry library, or limits that leave a
 * single card — the swap refuses the same way the day's last swap refuses: the
 * card on screen stays and nothing is written. There is no separate reason code
 * for it; the panel already treats a refusal as "no swaps left today".
 *
 * The day's `movedone` fact is untouched by a swap — Done is per day, not per
 * card — and a swap after a Done is allowed (the card changes, the pay does
 * not).
 */
export async function swapChallenge(db, {
  now = Date.now(), weather = null, emit, library, learning = [], lang = "en",
} = {}) {
  const at = asAt(now);
  const day = localDay(at);
  const prefs = await readPrefs(db);
  if (prefs.on === false) return offState(db, day, at, emit);

  const lib = libraryOf(library);
  // todayChallenge establishes (and stores) today's card, rolling yesterday's
  // pick into history on the way through; swap only ever re-rolls what is
  // already on screen.
  const today = await todayChallenge(db, { now: at, weather, emit, library: lib, learning, lang });
  if (!today || today.off) return today;

  if (today.swap >= MAX_SWAPS) {
    return { ...today, refused: true };
  }

  const swap = today.swap + 1;
  const history = await readHistory(db);
  // The day's own list: the card on screen and every card an earlier swap
  // already showed. A stored row from before `seen` existed carries only the
  // card on screen, which is still the one a swap must not repeat.
  const seen = seenOf(today.entry.id, today.seen);
  const picked = pickFor({
    day, at, prefs, history, swap, weather, library: lib, learning, exclude: seen,
  });
  // Nothing OUTSIDE the seen list is eligible: a one-entry library, or limits
  // that leave a single card. Keep today's card and answer exactly the way a
  // refused swap answers today — same shape, same `refused`, nothing written.
  if (!picked) return { ...today, refused: true };

  const why = whyLine(picked.reasons, lang);
  const nextSeen = seenOf(picked.entry.id, seen);
  await writeJson(db, TODAY_KEY, {
    day, entryId: picked.entry.id, swap, seen: nextSeen, reasons: picked.reasons, why,
  }, emit);
  return {
    day,
    entry: picked.entry,
    reasons: picked.reasons,
    why,
    done: today.done,
    off: false,
    swap,
    seen: nextSeen,
    refused: false,
  };
}

/**
 * The reason codes as template sentences (en/es). The first two that apply,
 * in order, joined — a short line, not a paragraph. Unknown codes are
 * ignored; a caller can always fall back to its own wording when this is "".
 *
 * Task 7's model-written line replaces this when a model is available; this is
 * the no-model path, so it may only say what the fact codes already say.
 */
const WHY_TEXT = Object.freeze({
  en: Object.freeze({
    "slot:early": "A good way to start the morning.",
    "slot:day": "A good way to break up the day.",
    "slot:evening": "A good way to wind down the day.",
    rain_later: "Rain is likely later.",
    cold: "It's cold out.",
    hot: "It's hot out.",
    "liked:*": "You like this kind.",
    learning_flow: "A flow you're learning.",
    easy_day: "An easy one today.",
  }),
  es: Object.freeze({
    "slot:early": "Una buena forma de empezar la mañana.",
    "slot:day": "Una buena forma de cortar el día.",
    "slot:evening": "Una buena forma de cerrar el día.",
    rain_later: "Es probable que llueva más tarde.",
    cold: "Hace frío afuera.",
    hot: "Hace calor afuera.",
    "liked:*": "Te gusta este tipo.",
    learning_flow: "Un flujo que estás aprendiendo.",
    easy_day: "Uno fácil hoy.",
  }),
});

export function whyLine(reasons, lang = "en") {
  const text = Object.hasOwn(WHY_TEXT, lang) ? WHY_TEXT[lang] : WHY_TEXT.en;
  const out = [];
  for (const reason of Array.isArray(reasons) ? reasons : []) {
    if (typeof reason !== "string") continue;
    const line = Object.hasOwn(text, reason)
      ? text[reason]
      : (reason.startsWith("liked:") ? text["liked:*"] : undefined);
    if (line === undefined) continue;
    out.push(line);
    if (out.length === 2) break;
  }
  return out.join(" ");
}