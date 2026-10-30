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
 *   }
 *
 * The challenge is today's pick, the same one Ramble's own panel shows: both surfaces call the
 * SAME assembly (moves/today.js todayForSurface), so prefs, the weather switch, the library and
 * the learned flows cannot drift apart, and they read one `moves.today` row, so they can never
 * disagree. `weather` is the weather the For You page already loaded ({ rain, temp, code }),
 * passed in by the gateway — this module fetches nothing, and todayForSurface drops it when the
 * user turned weather off. `library` is a seam for tests; production passes none and the picker
 * reads the served (reviewed, licensed) library. `lang` picks the language of the why line.
 *
 * The GET STORES today's card (and, with challenges off, the day's pause fact), exactly as
 * Ramble's own panel read does — idempotent, but a write: it does not only read.
 *
 * NO FREE TEXT REACHES HERE OR LEAVES HERE: `why` is built from the picker's fixed reason codes
 * (today.js whyLine), and nothing is written except today's card and the day's pause fact — the
 * same writes the panel's own read makes. `emit` is the caller's sync hook (the gateway's, or
 * Ramble's own routes'); without one the writes stay local and nothing fails. Works without a
 * model.
 */
import { todayForSurface } from "./moves/today.js";
import { streakState } from "./moves/streak.js";
import { petState } from "./pet.js";
import { stepsState } from "./steps.js";

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

export async function forYouMoves(db, { now = Date.now(), weather = null, library, lang = "en", emit } = {}) {
  const [today, pet, steps, streak] = await Promise.all([
    todayForSurface(db, { now, weather, emit, library, lang }),
    petState(db, { now }),
    stepsState(db, { now }),
    streakState(db, { now }),
  ]);

  const entry = today && !today.off ? today.entry : null;
  return {
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
}