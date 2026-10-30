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
 * Since Task 4 a chore's +8 comes out of the SAME indoor daily budget as
 * self-reported moves (moves/indoor-cap.js, INDOOR_DAILY_CAP): the three chores
 * are 3 x 8 = 24, which is exactly that budget, so a day whose chores are all
 * done leaves indoor moves nothing, and a day spent on indoor moves leaves the
 * chores the remainder. The chore is still marked done either way — a budget is
 * never a punishment.
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

import { localDay, recordHappyDay } from "./eggs.js";
import { maxEnergy, ENERGY_MAX_BASE_DEFAULT } from "./hearts.js";
// Shared with moves/ledger.js so chores and moves draw from ONE indoor budget.
// This module (not ledger.js) on purpose: ledger.js imports pet.js to pay the
// bird, and indoor-cap.js depends only on steps.js's ledger helpers.
import { claimIndoor } from "./moves/indoor-cap.js";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const DECAY_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const DECAY_PER_INTERVAL = 10;

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

/**
 * Spec 2026-10-04 §6: step energy is a feed whose size varies, so it is not in
 * FEED_DELTAS (Task 4's `move` is the other; see below). Its amount is bounded
 * here, and it never moves `last_fed_at` (R5): readings arrive often, and if
 * each reset the decay clock a bird whose owner opens the app every few hours
 * would never droop at all.
 */
export const STEPS_FEED_MAX = 100;
function stepsAmount(a) {
  const n = Number(a);
  return Number.isInteger(n) ? Math.max(0, Math.min(STEPS_FEED_MAX, n)) : 0;
}

/**
 * Task 4 (moves): a self-reported move pays Health in a variable amount, so
 * like steps its size is bounded here rather than living in FEED_DELTAS. The
 * real ceiling is a day's budget — 24 indoor, 20 outdoor, claimed in
 * moves/ledger.js BEFORE this is ever called — so the bound is the base energy
 * bar: generous enough that retuning a cap can never silently truncate a pay.
 *
 * No feed moves the decay clock any more (see petState): decay is wall-clock.
 */
export const MOVE_FEED_MAX = 100;
function moveAmount(a) {
  const n = Number(a);
  return Number.isInteger(n) ? Math.max(0, Math.min(MOVE_FEED_MAX, n)) : 0;
}

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

/**
 * The ceiling is DERIVED from the heart ledger (spec §3, D6), so it is passed
 * in rather than read here — every caller has already fetched it once, and a
 * second read would risk clamping against a different number than the one the
 * panel is about to draw.
 *
 * ⚠ ASYMMETRIC, DELIBERATELY. An addition stops at the ceiling, but the
 * ceiling NEVER reduces a value that is already above it. instance-sync
 * applies each incoming entry one at a time, in the order it arrived, with no
 * guarantee that a pet row and the wallet rows that justify its energy land
 * together or in any particular relative order — so an instance can apply a
 * synced pet row at energy 150 while it still holds none of the heart rows
 * and computes a ceiling of 100. A symmetric clamp would write the 150 down
 * right there, and last-writer-wins would then carry that loss back to the
 * instance it came from, with no later arrival able to undo it. Decay still
 * brings an over-ceiling bird down normally — it just is not the ceiling that
 * does it.
 */
function clampEnergy(next, previous, max) {
  const ceiling = Math.max(Number.isFinite(max) ? max : ENERGY_MAX_BASE_DEFAULT, previous || 0);
  return Math.max(0, Math.min(ceiling, next));
}

/**
 * The singleton pet row, created if absent. `INSERT ... ON CONFLICT DO
 * NOTHING` rather than SELECT-then-INSERT: the read-then-write pair is not
 * atomic, so two overlapping feeds on a fresh instance both saw "no row",
 * both INSERTed, and the loser threw SQLITE_CONSTRAINT. One statement
 * decides it, and the SELECT after it always finds the row.
 */
async function ensureRow(db) {
  await db.execute({ sql: "INSERT INTO ramble_pet (owner) VALUES ('self') ON CONFLICT(owner) DO NOTHING", args: [] });
  const result = await db.execute({ sql: "SELECT * FROM ramble_pet WHERE owner = 'self'", args: [] });
  return result.rows[0];
}

/**
 * Apply one activity event to the pet. Does a weekly rollover (reset the
 * three counters when `week_start` is null or >= 7 days old) BEFORE applying
 * the event, then a single UPDATE. Throws on an unknown event type.
 *
 * Two events carry their own amount instead of a FEED_DELTAS constant —
 * `steps` (a sensor reading, which never moves the decay clock) and `move`
 * (a self-reported move or a chore, paid out of a daily budget in
 * moves/ledger.js, which DOES move it). Neither bumps a weekly counter.
 */
export async function feed(db, event, { now = Date.now(), emit } = {}) {
  const type = event && event.type;
  const isSteps = type === "steps";
  const isMove = type === "move";
  if (!isSteps && !isMove && !Object.prototype.hasOwnProperty.call(FEED_DELTAS, type)) {
    throw new Error(`unknown pet feed event type: ${type}`);
  }

  // Owed decay lands FIRST, so a feed can never erase it (it used to: a feed
  // reset the clock and the elapsed part-interval was simply forgotten).
  await petState(db, { now });
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

  const delta = isSteps ? stepsAmount(event.amount) : isMove ? moveAmount(event.amount) : FEED_DELTAS[type];
  const max = await maxEnergy(db);
  const energy = clampEnergy(row.energy + delta, row.energy, max);
  const mood = moodFor(energy);

  const counterCol = COUNTER_COLUMN[type];
  if (counterCol === "places_week") places_week += 1;
  else if (counterCol === "unlocks_week") unlocks_week += 1;
  else if (counterCol === "crows_week") crows_week += 1;

  // `last_fed_at` is the DECAY CLOCK (the column keeps its synced name): it only
  // starts here, on a fresh row's first real feed, and from then on moves only in
  // whole decay intervals (petState). Feeding never resets it, so decay is 10 per
  // 6 h of wall time however the feeds are timed (Ramble Moves review, 2026-10-30:
  // a feed every 5 h 50 m used to skip decay entirely and lay eggs indoors).
  const last_fed_at = row.last_fed_at == null && delta > 0 && !isSteps ? now : row.last_fed_at;

  await db.execute({
    sql: `UPDATE ramble_pet SET energy = ?, mood = ?, places_week = ?, unlocks_week = ?, crows_week = ?,
          week_start = ?, last_fed_at = ? WHERE owner = 'self'`,
    args: [energy, mood, places_week, unlocks_week, crows_week, week_start, last_fed_at],
  });

  const updated = await ensureRow(db);
  await safeEmit(emit, "ramble_pet", "update", updated);

  // Phase 3 (spec §4.3): a day counts when the bird is happy while wholly
  // eggless. Idempotent per local day, and a no-op the moment the player
  // holds any egg. `doChore` and the moves ledger both reach this through
  // feed(), so chores, moves and the daily check-in all count.
  await recordHappyDay(db, { now, mood, emit });

  return { owner: "self", mood, energy, energy_max: max, places_week, unlocks_week, crows_week, week_start, last_fed_at };
}

/**
 * Same shape as `feed()`'s return value, built from an already-loaded row
 * (no query, no emit) — used by `doChore`'s no-op-repeat branch and by
 * feed.js's not-credited branch so the caller sees a consistent `pet` shape
 * whether or not a feed happened. Exported for that second caller: returning
 * the raw db row instead leaks `lamport_ts`/`chores_json` into a response
 * that otherwise never carries them. Returns null for a null row.
 */
export function petFromRow(row, energyMax) {
  if (!row) return null;
  return {
    owner: "self",
    mood: row.mood,
    energy: row.energy,
    energy_max: Number.isFinite(energyMax) ? energyMax : ENERGY_MAX_BASE_DEFAULT,
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
 * (nominally +8 energy, via this module's own `feed()` — never `feed.js`,
 * which would be a circular import); a repeat for the same kind on the same
 * day is a no-op (`done: false`). Throws on an unknown chore kind.
 *
 * ⚠ TASK 4: the +8 is CLAIMED, not granted. Chores and self-reported moves
 * share ONE indoor budget per local day (moves/indoor-cap.js,
 * INDOOR_DAILY_CAP = 24 = the old 3 x 8), so a chore pays only what is left of
 * it — possibly 0 — and the chore is marked done either way. Claiming through
 * the shared helper is also what keeps eggs.js's laying invariant true:
 * indoor-only activity tops out at 29/day against 40/day of decay.
 *
 * The claim is the only change to this path: the return shape is untouched
 * (`POST /api/ramble/pet/chore` JSONs it verbatim), the chore still feeds
 * through `feed()` and still resets the decay clock as every positive event
 * does. What a day's budget has left is read from the ledger, not from here
 * (moves/ledger.js `movesDay`/`movesRoom`). moves/ledger.js also applies the
 * bird's OWED decay (`petState`) before paying a move, exactly as steps.js
 * `settleDay` does: a positive feed resets the decay clock, so decay applied
 * afterwards would clamp away the Health just paid. This path keeps feed()'s
 * long-standing behaviour instead, which is what the chore tests are written
 * against.
 */
export async function doChore(db, kind, { now = Date.now(), emit } = {}) {
  if (!CHORES.includes(kind)) {
    throw new Error(`unknown chore kind: ${kind}`);
  }

  const row = await ensureRow(db);
  const chores = readChores(row, now);

  if (chores[kind] === true) {
    return { done: false, chores, pet: petFromRow(row, await maxEnergy(db)) };
  }

  chores[kind] = true;
  await db.execute({
    sql: "UPDATE ramble_pet SET chores_json = ? WHERE owner = 'self'",
    args: [JSON.stringify(chores)],
  });

  // Budget first, then the feed — and the chore stays done whatever the budget
  // says. FEED_DELTAS.chore is the nominal size of the claim.
  const { paid } = await claimIndoor(db, { day: localDay(now), points: FEED_DELTAS.chore, now, emit });
  if (paid <= 0) {
    const after = await ensureRow(db);
    return { done: true, chores, pet: petFromRow(after, await maxEnergy(db)) };
  }
  const pet = await feed(db, { type: "move", amount: paid }, { now, emit });
  return { done: true, chores, pet };
}

/**
 * Read the pet's current state, applying passive decay first (10 energy per
 * full 6h of wall time since the decay clock `last_fed_at` — the stand-in for
 * a quiet_tick radio feed that doesn't exist yet). The clock advances by the
 * whole intervals applied, keeping the remainder, so nothing is ever skipped.
 * Decay is persisted so a second immediate call doesn't subtract again. A fresh
 * row (last_fed_at null) never decays.
 */
export async function petState(db, { now = Date.now() } = {}) {
  const row = await ensureRow(db);
  const max = await maxEnergy(db);

  let energy = row.energy;
  let last_fed_at = row.last_fed_at;
  let decayed = false;

  if (last_fed_at != null) {
    const elapsed = now - last_fed_at;
    if (elapsed >= DECAY_INTERVAL_MS) {
      const intervals = Math.floor(elapsed / DECAY_INTERVAL_MS);
      // `row.energy` as the floor argument, so an over-ceiling bird decays by
      // exactly the intervals elapsed rather than snapping to the ceiling.
      energy = clampEnergy(energy - intervals * DECAY_PER_INTERVAL, row.energy, max);
      last_fed_at = last_fed_at + intervals * DECAY_INTERVAL_MS;
      decayed = true;
    }
  }
  const mood = moodFor(energy);

  if (decayed) {
    await db.execute({
      sql: "UPDATE ramble_pet SET energy = ?, mood = ?, last_fed_at = ? WHERE owner = 'self'",
      args: [energy, mood, last_fed_at],
    });
  }

  return {
    mood,
    energy,
    energy_max: max,
    places_week: row.places_week,
    unlocks_week: row.unlocks_week,
    crows_week: row.crows_week,
    last_fed_at,
    active_egg_id: row.active_egg_id ?? null,
    chores: readChores(row, now),
  };
}
