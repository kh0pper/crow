/**
 * Ramble pet — geo activity -> crow mood (Task 14, spec §6).
 *
 * feed(db, event) is the character-module seam: geo activity (a place
 * visited, a locked mark unlocked, a nearby crow met) nudges the pet's
 * energy, which derives a mood. petState(db) is the read path and also
 * carries the phase-1 stand-in for a `quiet_tick` radio feed — passive
 * decay applied on read, persisted once so repeated reads don't compound it.
 * doChore(db, kind) is the daily-chores seam: the first `feed`/`preen`/`play`
 * completion of the local day feeds the pet via this module's own `feed()`
 * (never `feed.js` — that would be a circular import); a repeat is a no-op.
 *
 * `ramble_pet` IS in instance-sync's SYNCED_TABLES (servers/sharing/
 * instance-sync.js), keyed on its natural key `owner` (always 'self'), with
 * last-writer-wins conflict resolution on `lamport_ts`. The write paths call
 * an optional `emit("ramble_pet", "update", row)` hook, and `feed`, `doChore`,
 * and eggs.js's hatch path are the ONLY emit call sites — `petState`'s
 * decay-on-read write never emits, because a GET must never queue a sync op.
 * Energy can therefore drift between instances between syncs (each applies
 * its own decay independently); last-writer-wins on the next sync settles it.
 */

import { localDay } from "./eggs.js";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DECAY_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DECAY_PER_INTERVAL = 10;

async function safeEmit(emit, table, op, row) {
  if (!emit) return;
  try { await emit(table, op, row); }
  catch (err) { console.error(`[ramble pet] emit(${table}, ${op}) failed:`, err?.message ?? err); }
}

/** Parses `chores_json`, day-rolling it against `now` without persisting. Never throws. */
function readChores(row, now) {
  let chores;
  try {
    chores = row.chores_json ? JSON.parse(row.chores_json) : {};
  } catch {
    chores = {};
  }
  if (!chores || typeof chores !== "object") chores = {};
  const day = localDay(now);
  if (chores.day !== day) {
    chores = { day, feed: false, preen: false, play: false };
  } else {
    chores = { day, feed: !!chores.feed, preen: !!chores.preen, play: !!chores.play };
  }
  return chores;
}

export const FEED_DELTAS = {
  visit_place: 15,
  unlock_mark: 10,
  meet_crow: 20,
  quiet_tick: -10,
  checkin: 5,
  chore: 8,
  mark_left: 0,
};

/** The three daily chore kinds tracked in `ramble_pet.chores_json`. */
export const CHORES = ["feed", "preen", "play"];

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
export async function feed(db, event, { now = Date.now(), emit } = {}) {
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

  const updated = await ensureRow(db);
  await safeEmit(emit, "ramble_pet", "update", updated);

  return { owner: "self", mood, energy, places_week, unlocks_week, crows_week, week_start, last_fed_at };
}

/**
 * Same shape as `feed()`'s return value, built from an already-loaded row
 * (no query, no emit) — used by `doChore`'s no-op-repeat branch so the
 * caller sees a consistent `pet` shape whether or not a feed happened.
 */
function petFromRow(row) {
  return {
    owner: "self",
    mood: row.mood,
    energy: row.energy,
    places_week: row.places_week,
    unlocks_week: row.unlocks_week,
    crows_week: row.crows_week,
    week_start: row.week_start,
    last_fed_at: row.last_fed_at,
  };
}

/**
 * Complete a daily chore (`feed`, `preen`, or `play`). The first completion
 * of the local day for a given kind persists `chores_json` and feeds the pet
 * (+8 energy, via this module's own `feed()` — never `feed.js`, which would
 * be a circular import); a repeat for the same kind on the same day is a
 * no-op (`done: false`). Throws on an unknown chore kind.
 */
export async function doChore(db, kind, { now = Date.now(), emit } = {}) {
  if (!CHORES.includes(kind)) {
    throw new Error(`unknown chore kind: ${kind}`);
  }

  const row = await ensureRow(db);
  const chores = readChores(row, now);

  if (chores[kind] === true) {
    return { done: false, chores, pet: petFromRow(row) };
  }

  chores[kind] = true;
  await db.execute({
    sql: "UPDATE ramble_pet SET chores_json = ? WHERE owner = 'self'",
    args: [JSON.stringify(chores)],
  });

  const pet = await feed(db, { type: "chore" }, { now, emit });
  return { done: true, chores, pet };
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
    active_egg_id: row.active_egg_id ?? null,
    chores: readChores(row, now),
  };
}
