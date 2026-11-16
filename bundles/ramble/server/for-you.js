/**
 * Ramble's card for Crow's For You page (moves design; private engineering notes).
 *
 * Crow's For You page never reads Ramble's tables itself: the gateway imports THIS module from
 * the installed bundle (`$CROW_HOME/bundles/ramble/server/for-you.js`) and renders what comes
 * back, the way it reads Media Hub. So this file imports only its own bundle's modules and never
 * a gateway file.
 *
 *   forYouMoves(db, { now, weather, library, lang, emit }) -> {
 *     challenge: { day, title, minutes, why, done, entryId } | null,
 *     off: boolean,
 *     health: { energy, max },      // the bird's Health, energy of max
 *     steps: { today, goal },       // today's counted steps against the live goal
 *     streak: { days },             // consecutive qualifying local days
 *     // The day's own cards, present only when the day was drawn (dayCards did
 *     // not throw and challenges are not off):
 *     slot: string | null,          // the day's Now slot
 *     lengths: [10, 20, 30],        // the chunk lengths the card offers
 *     slots: [{ slot, done }],      // one per NON-empty slot of the day, in order
 *     minutesToday: number,         // whole active minutes filed under the day
 *     week: { total },              // the week's balance so far
 *   }
 *
 * The challenge is today's pick, the same one Ramble's own panel shows: both surfaces call the
 * SAME assembly (moves/today.js todayForSurface), so prefs, the weather switch, the library and
 * the learned flows cannot drift apart, and they read one `moves.today` row, so they can never
 * disagree. The day's cards are drawn first (moves/slots.js dayCards) for the same reason the
 * panel draws them: that draw mirrors the day's Now card into `moves.today`, so the legacy single
 * card here IS the Now card of the day's slots. `weather` is the weather the For You page already
 * loaded ({ rain, temp, code }), passed in by the gateway — this module fetches nothing. Turning
 * weather off (prefs.weather === false) means the picker never sees a forecast on EITHER draw: the
 * day's cards below drop it and so does todayForSurface, the way Ramble's own panel does. Neither
 * surface can be handed a forecast the other ignores. `library` is a seam for tests;
 * production passes none and the picker reads the served (reviewed, licensed) library. `lang`
 * picks the language of the why line.
 *
 * The GET STORES today's card and the day's slot rows (and, with challenges off, the day's pause
 * fact), exactly as Ramble's own panel read does — idempotent, but a write: it does not only read.
 *
 * NO FREE TEXT REACHES HERE OR LEAVES HERE: `why` is built from the picker's fixed reason codes
 * (today.js whyLine), and nothing is written except today's card and the day's pause fact — the
 * same writes the panel's own read makes. `emit` is the caller's sync hook (the gateway's, or
 * Ramble's own routes'); without one the writes stay local and nothing fails. Works without a
 * model.
 */
import { readPrefs, todayForSurface } from "./moves/today.js";
import { dayCards } from "./moves/slots.js";
import { MOVE_MIN_KIND } from "./moves/progress.js";
import { weekState } from "./moves/week.js";
import { streakState } from "./moves/streak.js";
import { petState } from "./pet.js";
import { rowDelta, stepsState } from "./steps.js";

/** The chunk lengths the card offers, shortest first. */
const LENGTHS = Object.freeze([10, 20, 30]);

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

export async function forYouMoves(db, { now = Date.now(), weather = null, library, lang = "en", emit } = {}) {
  // The live prefs are read once, here, so the day's cards are drawn with the
  // same weather switch todayForSurface applies: weather off means the picker
  // is handed no forecast at all, never the page's raw one.
  const prefs = await readPrefs(db);
  const dayWeather = prefs.weather === false ? null : weather;
  // The day's cards are drawn first (moves/slots.js dayCards), because that
  // draw is what mirrors the Now card into the one card `moves.today` carries —
  // the row todayForSurface reads back. A failure drawing them is logged and
  // the card below is still assembled from the stored one. The draw's answer is
  // kept for the day's own fields (slot, lengths, slots, minutesToday, week);
  // an off day or a failed draw reports none of them at all.
  let drawn = null;
  try {
    const day = await dayCards(db, { now, weather: dayWeather, emit, library });
    if (day && day.off !== true) drawn = day;
  } catch (err) {
    try { console.warn(`[ramble for-you] moves day cards unavailable: ${err?.message ?? err}`); } catch {}
  }

  const [today, pet, steps, streak] = await Promise.all([
    todayForSurface(db, { now, weather, emit, library, lang }),
    petState(db, { now }),
    stepsState(db, { now }),
    streakState(db, { now }),
  ]);

  const entry = today && !today.off ? today.entry : null;
  const out = {
    challenge: entry ? {
      day: String(today.day),
      title: String(entry.title || ""),
      minutes: num(entry.minutes),
      why: typeof today.why === "string" ? today.why : "",
      done: !!today.done,
      entryId: String(entry.id || ""),
    } : null,
    // challenges off is a FACT the page states, not a failure: the module still reports Health,
    // today's steps and the streak alongside it.
    off: !!(today && today.off),
    health: { energy: num(pet && pet.energy), max: num(pet && pet.energy_max) },
    steps: { today: num(steps && steps.steps), goal: num(steps && steps.goal) },
    streak: { days: num(streak && streak.days) },
  };

  // The day's own cards. Only a day that was drawn has them: an off day and a
  // failed draw leave the answer above exactly as it always was, so an older
  // reader of this module keeps rendering what it rendered before.
  if (drawn) {
    out.slot = typeof drawn.nowSlot === "string" ? drawn.nowSlot : null;
    out.lengths = [...LENGTHS];
    out.slots = (Array.isArray(drawn.slots) ? drawn.slots : [])
      .filter((item) => item && item.empty !== true)
      .map((item) => ({ slot: String(item.slot), done: item.done === true }));
    // Each of the two reads stands on its own: one failing omits its own field
    // and leaves the other, and the card, untouched.
    try {
      out.minutesToday = num(await rowDelta(db, MOVE_MIN_KIND, String(drawn.day)));
    } catch (err) {
      try { console.warn(`[ramble for-you] moves minutes unavailable: ${err?.message ?? err}`); } catch {}
    }
    try {
      const week = await weekState(db, { now });
      out.week = { total: num(week && week.total) };
    } catch (err) {
      try { console.warn(`[ramble for-you] moves week unavailable: ${err?.message ?? err}`); } catch {}
    }
  }
  return out;
}