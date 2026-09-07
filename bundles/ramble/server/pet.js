/**
 * Ramble pet — geo activity -> crow mood (Task 14, spec §6).
 *
 * feed(db, event) is the character-module seam: geo activity (a place
 * visited, a locked mark unlocked, a nearby crow met) nudges the pet's
 * energy, which derives a mood. petState(db) is the read path and also
 * carries the phase-1 stand-in for a `quiet_tick` radio feed — passive
 * decay applied on read, persisted once so repeated reads don't compound it.
 *
 * Per-instance state (ramble_pet is NOT in instance-sync's SYNCED_TABLES):
 * each instance's pet reflects only that instance's own activity.
 */

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DECAY_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DECAY_PER_INTERVAL = 10;

export const FEED_DELTAS = {
  visit_place: 15,
  unlock_mark: 10,
  meet_crow: 20,
  quiet_tick: -10,
};

/** Which weekly counter a positive event bumps. quiet_tick bumps none. */
const COUNTER_COLUMN = {
  visit_place: "places_week",
  unlock_mark: "unlocks_week",
  meet_crow: "crows_week",
};

export function moodFor(energy) {
  if (energy >= 60) return "happy";
  if (energy >= 30) return "tired";
  return "alarmed";
}

function clampEnergy(v) {
  return Math.max(0, Math.min(100, v));
}

async function ensureRow(db) {
  const result = await db.execute({ sql: "SELECT * FROM ramble_pet WHERE owner = 'self'", args: [] });
  if (result.rows.length > 0) return result.rows[0];
  await db.execute({ sql: "INSERT INTO ramble_pet (owner) VALUES ('self')", args: [] });
  const reread = await db.execute({ sql: "SELECT * FROM ramble_pet WHERE owner = 'self'", args: [] });
  return reread.rows[0];
}

/**
 * Apply one geo-activity event to the pet. Does a weekly rollover (reset the
 * three counters when `week_start` is null or >= 7 days old) BEFORE applying
 * the event, then a single UPDATE. Throws on an unknown event type.
 */
export async function feed(db, event, { now = Date.now() } = {}) {
  const type = event && event.type;
  if (!Object.prototype.hasOwnProperty.call(FEED_DELTAS, type)) {
    throw new Error(`unknown pet feed event type: ${type}`);
  }

  const row = await ensureRow(db);

  let places_week = row.places_week;
  let unlocks_week = row.unlocks_week;
  let crows_week = row.crows_week;
  let week_start = row.week_start;

  if (week_start == null || now - week_start >= WEEK_MS) {
    places_week = 0;
    unlocks_week = 0;
    crows_week = 0;
    week_start = now;
  }

  const delta = FEED_DELTAS[type];
  const energy = clampEnergy(row.energy + delta);
  const mood = moodFor(energy);

  const counterCol = COUNTER_COLUMN[type];
  if (counterCol === "places_week") places_week += 1;
  else if (counterCol === "unlocks_week") unlocks_week += 1;
  else if (counterCol === "crows_week") crows_week += 1;

  const last_fed_at = delta > 0 ? now : row.last_fed_at;

  await db.execute({
    sql: `UPDATE ramble_pet SET energy = ?, mood = ?, places_week = ?, unlocks_week = ?, crows_week = ?,
          week_start = ?, last_fed_at = ? WHERE owner = 'self'`,
    args: [energy, mood, places_week, unlocks_week, crows_week, week_start, last_fed_at],
  });

  return { owner: "self", mood, energy, places_week, unlocks_week, crows_week, week_start, last_fed_at };
}

/**
 * Read the pet's current state, applying passive decay first (10 energy per
 * full 6h since last_fed_at — the stand-in for a quiet_tick radio feed that
 * doesn't exist yet). Decay is persisted so a second immediate call doesn't
 * subtract again. A fresh row (last_fed_at null) never decays.
 */
export async function petState(db, { now = Date.now() } = {}) {
  const row = await ensureRow(db);

  let energy = row.energy;
  let mood = row.mood;
  let last_fed_at = row.last_fed_at;

  if (last_fed_at != null) {
    const elapsed = now - last_fed_at;
    if (elapsed >= DECAY_INTERVAL_MS) {
      const intervals = Math.floor(elapsed / DECAY_INTERVAL_MS);
      energy = clampEnergy(energy - intervals * DECAY_PER_INTERVAL);
      mood = moodFor(energy);
      last_fed_at = now;
      await db.execute({
        sql: "UPDATE ramble_pet SET energy = ?, mood = ?, last_fed_at = ? WHERE owner = 'self'",
        args: [energy, mood, last_fed_at],
      });
    }
  }

  return {
    mood,
    energy,
    places_week: row.places_week,
    unlocks_week: row.unlocks_week,
    crows_week: row.crows_week,
    last_fed_at,
  };
}
