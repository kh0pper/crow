/**
 * Ramble eggs — warmth credits ledger + hatch (Task 3, spec §2.1).
 *
 * One "incubating" egg exists at a time per instance. Qualifying activity
 * events (visiting a new place, leaving a mark, unlocking one, meeting a
 * nearby crow, checking in) credit warmth toward it, each keyed so the same
 * real-world action only ever counts once per period (a place per ISO week,
 * a check-in per local day, a persona-meeting per ISO week; marks are
 * one-shot events with no natural repeat key and are always credited).
 * `chore`/`quiet_tick` are pet-only events (Task 14's feed()) and never
 * touch the egg or the ledger.
 *
 * When warmth reaches `hatch_at` the egg hatches into a bird (species rolled
 * from bird-svg's ROSTER, seed a uint32 from crypto.randomInt — never
 * Math.random, so the roll can't be predicted or replayed), the next
 * incubating egg starts immediately, and if no bird is active yet
 * (`ramble_pet.active_egg_id IS NULL`) the newly hatched egg becomes it.
 */

import crypto from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { ROSTER } = require("./bird-svg.cjs");

export const WARMTH_DEFAULTS = {
  visit_place: 20,
  mark_left: 15,
  unlock_mark: 10,
  meet_crow: 20,
  checkin: 8,
  hatch_at: 100,
};

async function safeEmit(emit, table, op, row) {
  if (!emit) return;
  try { await emit(table, op, row); }
  catch (err) { console.error(`[ramble eggs] emit(${table}, ${op}) failed:`, err?.message ?? err); }
}

/** Tolerates a missing `ramble_settings` table (fresh db) by returning null. */
async function readSetting(db, key) {
  try {
    const { rows } = await db.execute({ sql: "SELECT value FROM ramble_settings WHERE key = ?", args: [key] });
    return rows[0]?.value ?? null;
  } catch {
    return null;
  }
}

/**
 * Settings `warmth.<k>` override WARMTH_DEFAULTS, parsed as ints only (a
 * non-numeric override is ignored, same as if unset). A negative override is
 * also ignored for the event weights (a weight can't un-credit warmth), and
 * `hatch_at` additionally requires >= 1 (a hatch threshold of 0 or below
 * would hatch every fresh, zero-warmth egg on read).
 */
export async function readWarmthWeights(db) {
  const weights = { ...WARMTH_DEFAULTS };
  for (const key of Object.keys(WARMTH_DEFAULTS)) {
    // eslint-disable-next-line no-await-in-loop
    const raw = await readSetting(db, `warmth.${key}`);
    if (raw == null) continue;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) continue;
    const min = key === "hatch_at" ? 1 : 0;
    if (parsed >= min) weights[key] = parsed;
  }
  return weights;
}

/** ISO-8601 week ("2026-W37"), Thursday rule, using UTC-normalized date math on `ms`. */
export function isoWeek(ms) {
  const d = new Date(ms);
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7; // Mon=1..Sun=7
  date.setUTCDate(date.getUTCDate() + 4 - dayNum); // nearest Thursday
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

/**
 * Anti-abuse ceiling on `meet_crow`: warmth is keyed per (persona, ISO week),
 * and a persona is just an x-only pubkey anyone can mint, so an attacker
 * broadcasting a flood of fresh pubkeys could otherwise force hatch after
 * hatch. At most this many `meet_crow` credits count per LOCAL DAY; meetings
 * over the cap are a pure no-op (no warmth, no ledger row).
 */
export const MEET_CROW_DAILY_CAP = 5;

/** Midnight local time (process timezone) of the day containing `ms`. */
export function startOfLocalDay(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Local calendar day ("2026-09-07") using local-time getters (process timezone). */
export function localDay(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * The credit ledger key for an event, or null (mark_left/unlock_mark: always
 * credited, no repeat key), { skip: true } (chore/quiet_tick: pet-only,
 * never touches the ledger or the egg), or { invalid: true } (a keyed type
 * missing the field its key is built from — `visit_place` without `cell`,
 * `meet_crow` without `persona` — which must NOT fall back to "always
 * credited": that's the `null` sentinel's meaning, reserved for the
 * genuinely unkeyed types). Unknown types fall through to the caller's
 * not-credited handling in creditWarmth (no key is returned or needed since
 * creditWarmth checks the type again before crediting).
 */
export function creditKey(event, { now }) {
  switch (event?.type) {
    case "visit_place":
      if (!event.cell) return { invalid: true };
      return { kind: "visit_place", key: `${event.cell}:${isoWeek(now)}` };
    case "checkin":
      return { kind: "checkin", key: localDay(now) };
    case "meet_crow":
      if (!event.persona) return { invalid: true };
      return { kind: "meet_crow", key: `${event.persona}:${isoWeek(now)}` };
    case "mark_left":
    case "unlock_mark":
      return null;
    case "chore":
    case "quiet_tick":
      return { skip: true };
    default:
      return null;
  }
}

const KNOWN_TYPES = new Set(["visit_place", "checkin", "meet_crow", "mark_left", "unlock_mark"]);

async function getIncubatingEgg(db) {
  const { rows } = await db.execute({ sql: "SELECT * FROM ramble_eggs WHERE status = 'incubating' LIMIT 1", args: [] });
  return rows[0] ?? null;
}

/**
 * Returns the current incubating egg, creating one if none exists. The
 * INSERT ... SELECT ... WHERE NOT EXISTS guard (rather than a unique index)
 * makes this race-free within one process on a single SQLite connection:
 * two overlapping calls each attempt the guarded insert, only one succeeds
 * to insert a row (the second sees the just-inserted row and its WHERE NOT
 * EXISTS fails), and both re-select the same egg.
 */
export async function ensureIncubatingEgg(db, { now, emit } = {}) {
  const eggId = crypto.randomUUID();
  await db.execute({
    sql: `INSERT INTO ramble_eggs (egg_id, status, warmth, created_at)
          SELECT ?, 'incubating', 0, ?
          WHERE NOT EXISTS (SELECT 1 FROM ramble_eggs WHERE status = 'incubating')`,
    args: [eggId, now],
  });
  const egg = await getIncubatingEgg(db);
  if (egg && egg.egg_id === eggId) await safeEmit(emit, "ramble_eggs", "insert", egg);
  return egg;
}

async function getPetRow(db) {
  const { rows } = await db.execute({ sql: "SELECT * FROM ramble_pet WHERE owner = 'self'", args: [] });
  return rows[0] ?? null;
}

/**
 * The singleton pet row, created if absent. `INSERT ... ON CONFLICT DO
 * NOTHING` rather than SELECT-then-INSERT: the read-then-write pair is not
 * atomic, so two overlapping feeds on a fresh instance both saw "no row",
 * both INSERTed, and the loser threw SQLITE_CONSTRAINT (a 500 out of
 * POST /api/ramble/egg/checkin). One statement decides it.
 */
async function ensurePetRow(db) {
  await db.execute({ sql: "INSERT INTO ramble_pet (owner) VALUES ('self') ON CONFLICT(owner) DO NOTHING", args: [] });
  return getPetRow(db);
}

/**
 * Hatches the incubating egg if its warmth has reached hatch_at. The UPDATE
 * that flips this egg to 'hatched' MUST run before the successor egg is
 * inserted: ensureIncubatingEgg's "one incubating egg" guard is a query
 * against the table's current contents, not a schema constraint, so the old
 * egg has to already be out of 'incubating' status before the next insert's
 * WHERE NOT EXISTS check runs.
 */
export async function hatchIfReady(db, { now, emit } = {}) {
  const egg = await getIncubatingEgg(db);
  if (!egg) return null;
  const weights = await readWarmthWeights(db);
  if (egg.warmth < weights.hatch_at) return null;

  const species = ROSTER[crypto.randomInt(ROSTER.length)];
  const seed = crypto.randomInt(0, 2 ** 32);

  await db.execute({
    sql: `UPDATE ramble_eggs SET status = 'hatched', species = ?, seed = ?, hatched_at = ? WHERE egg_id = ?`,
    args: [species, seed, now, egg.egg_id],
  });
  const { rows: hatchedRows } = await db.execute({ sql: "SELECT * FROM ramble_eggs WHERE egg_id = ?", args: [egg.egg_id] });
  const hatchedEgg = hatchedRows[0];
  await safeEmit(emit, "ramble_eggs", "update", hatchedEgg);

  const pet = await ensurePetRow(db);
  if (pet.active_egg_id == null) {
    await db.execute({ sql: "UPDATE ramble_pet SET active_egg_id = ? WHERE owner = 'self'", args: [hatchedEgg.egg_id] });
    const updatedPet = await getPetRow(db);
    await safeEmit(emit, "ramble_pet", "update", updatedPet);
  }

  const nextEgg = await ensureIncubatingEgg(db, { now, emit });
  void nextEgg;

  return hatchedEgg;
}

/**
 * Credits warmth for a qualifying event. The ledger INSERT OR IGNORE runs
 * first and is authoritative: rowsAffected === 0 means this (kind, key) was
 * already credited, so the call is a no-op that reports the egg's current
 * warmth. Only after a successful insert does the egg's warmth get bumped.
 *
 * The not-credited path (unknown type, `chore`/`quiet_tick`, or a keyed type
 * missing its key field) is a PURE READ: it must never create an egg or
 * emit, so a stream of malformed/pet-only events against a fresh instance
 * leaves `ramble_eggs` untouched.
 */
export async function creditWarmth(db, event, { now, emit } = {}) {
  const notCredited = async () => {
    const egg = await getIncubatingEgg(db);
    return { credited: false, warmth: egg ? egg.warmth : 0, hatched: null };
  };

  if (!event || !KNOWN_TYPES.has(event.type)) return notCredited();

  const key = creditKey(event, { now });
  if (key && (key.skip || key.invalid)) return notCredited();

  // Over the daily meet_crow ceiling this is a pure read, same as any other
  // not-credited path: no egg minted, no ledger row, nothing emitted — so a
  // flood of spoofed personas leaves no trace and cannot force a hatch.
  if (event.type === "meet_crow") {
    const { rows } = await db.execute({
      sql: "SELECT count(*) AS n FROM ramble_credits WHERE kind = 'meet_crow' AND credited_at >= ?",
      args: [startOfLocalDay(now)],
    });
    if (Number(rows[0]?.n ?? 0) >= MEET_CROW_DAILY_CAP) return notCredited();
  }

  const egg = await ensureIncubatingEgg(db, { now, emit });

  if (key) {
    const { rowsAffected } = await db.execute({
      sql: "INSERT OR IGNORE INTO ramble_credits (kind, key, credited_at) VALUES (?, ?, ?)",
      args: [key.kind, key.key, now],
    });
    if (rowsAffected === 0) {
      const current = await getIncubatingEgg(db);
      return { credited: false, warmth: current ? current.warmth : egg.warmth, hatched: null };
    }
  }
  // key === null (mark_left/unlock_mark): always credited, no ledger row.

  const weights = await readWarmthWeights(db);
  const delta = weights[event.type] ?? 0;
  const newWarmth = Math.max(0, Math.min(weights.hatch_at, egg.warmth + delta));

  await db.execute({ sql: "UPDATE ramble_eggs SET warmth = ? WHERE egg_id = ?", args: [newWarmth, egg.egg_id] });
  const { rows } = await db.execute({ sql: "SELECT * FROM ramble_eggs WHERE egg_id = ?", args: [egg.egg_id] });
  const updatedEgg = rows[0];
  await safeEmit(emit, "ramble_eggs", "update", updatedEgg);

  const hatched = await hatchIfReady(db, { now, emit });

  return { credited: true, warmth: updatedEgg.warmth, hatched };
}

/** checkin(db, {now, emit}) is creditWarmth for the daily check-in event. */
export async function checkin(db, { now, emit } = {}) {
  return creditWarmth(db, { type: "checkin" }, { now, emit });
}

/**
 * { egg_id, species, seed } for the active hatched bird, or null if none has
 * hatched yet. The `status = 'hatched'` filter is load-bearing, not belt-and-
 * braces: `active_egg_id` replicates via instance sync independently of the
 * egg row it names, so a peer's pointer can arrive (or outlive a convergence
 * demotion) while this instance still holds that egg as `incubating` — and a
 * row with NULL species/seed is not a bird. Every caller (mark authoring,
 * GET /api/ramble/pet) must get null rather than a half-built bird.
 */
export async function activeBird(db) {
  const pet = await getPetRow(db);
  if (!pet || pet.active_egg_id == null) return null;
  const { rows } = await db.execute({
    sql: "SELECT egg_id, species, seed FROM ramble_eggs WHERE egg_id = ? AND status = 'hatched'",
    args: [pet.active_egg_id],
  });
  return rows[0] ?? null;
}

export async function eggState(db, { now } = {}) {
  const egg = await ensureIncubatingEgg(db, { now });
  const weights = await readWarmthWeights(db);
  const percent = weights.hatch_at > 0 ? Math.max(0, Math.min(100, Math.round((egg.warmth / weights.hatch_at) * 100))) : 0;

  const week = isoWeek(now);
  const { rows: placeRows } = await db.execute({
    sql: "SELECT count(*) AS n FROM ramble_credits WHERE kind = 'visit_place' AND key LIKE ?",
    args: [`%:${week}`],
  });
  const newPlacesWeek = placeRows[0]?.n ?? 0;

  const { rows: markRows } = await db.execute({
    sql: "SELECT count(*) AS n FROM ramble_marks WHERE origin = 'local'",
    args: [],
  });
  const firstMark = (markRows[0]?.n ?? 0) > 0;

  const day = localDay(now);
  const { rows: checkinRows } = await db.execute({
    sql: "SELECT count(*) AS n FROM ramble_credits WHERE kind = 'checkin' AND key = ?",
    args: [day],
  });
  const checkedInToday = (checkinRows[0]?.n ?? 0) > 0;

  return {
    egg: { egg_id: egg.egg_id, warmth: egg.warmth, hatch_at: weights.hatch_at, percent },
    checklist: { new_places_week: newPlacesWeek, first_mark: firstMark, checked_in_today: checkedInToday },
  };
}
