/**
 * Ramble feed — the one fan-out from a geo activity event to both the egg
 * ledger (eggs.js's creditWarmth, which may hatch) and the pet's energy
 * (pet.js's feed). Keyed types (visit_place, meet_crow, checkin) only feed
 * the pet on the first credit in the period — a repeat must not double
 * energy. Unkeyed types (mark_left, unlock_mark) and quiet_tick always feed
 * the pet, since they never touch the ledger.
 */

import { creditWarmth } from "./eggs.js";
import { feed as petFeed, petFromRow } from "./pet.js";
import { maxEnergy } from "./hearts.js";

const KEYED_TYPES = new Set(["visit_place", "meet_crow", "checkin"]);
const ACCEPTED_TYPES = new Set(["visit_place", "mark_left", "unlock_mark", "meet_crow", "checkin", "quiet_tick"]);

/**
 * The pet as `petFeed()` would have returned it, without feeding — so both
 * branches below hand the caller the SAME shape. Reading the raw row instead
 * leaked `lamport_ts`/`chores_json` out of every not-credited response.
 */
async function readPet(db) {
  const { rows } = await db.execute({ sql: "SELECT * FROM ramble_pet WHERE owner = 'self'", args: [] });
  return petFromRow(rows[0] ?? null, await maxEnergy(db));
}

export async function feedAll(db, event, { now = Date.now(), emit, onHatch } = {}) {
  if (!event || !ACCEPTED_TYPES.has(event.type)) {
    console.warn(`[ramble feed] unknown feedAll event type: ${event?.type}`);
    const { warmth } = await creditWarmth(db, event, { now, emit });
    const pet = await readPet(db);
    return { credited: false, warmth, hatched: null, pet };
  }

  const { credited, warmth, hatched } = await creditWarmth(db, event, { now, emit });

  if (hatched && onHatch) {
    try { await onHatch(hatched); }
    catch (err) { console.error("[ramble feed] onHatch failed:", err?.message ?? err); }
  }

  const shouldFeedPet = KEYED_TYPES.has(event.type) ? credited === true : true;

  let pet;
  if (shouldFeedPet) {
    pet = await petFeed(db, event, { now, emit });
  } else {
    pet = await readPet(db);
  }

  return { credited, warmth, hatched, pet };
}
