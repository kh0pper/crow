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
 * Math.random, so the roll can't be predicted or replayed), the shelf
 * refills the incubating slot if it can (`promoteFromShelf`, spec §4.2 — NO
 * successor is minted any more), and if no bird is active yet
 * (`ramble_pet.active_egg_id IS NULL`) the newly hatched egg becomes it.
 */

import crypto from "node:crypto";
import { createRequire } from "node:module";
import { lockedEggIds } from "./egg-locks.js";

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

export async function getIncubatingEgg(db) {
  const { rows } = await db.execute({ sql: "SELECT * FROM ramble_eggs WHERE status = 'incubating' LIMIT 1", args: [] });
  return rows[0] ?? null;
}

/**
 * Insert a fresh incubating egg. THE ONLY MINTING PRIMITIVE. As of the end of
 * Task 3 the only callers are the starter grant and laying (both deliberate
 * acts) and test fixtures; `flockState` no longer calls it (Task 3 removed
 * that call) and neither does `hatchIfReady`, which promotes from the shelf
 * instead of minting a successor (`promoteFromShelf`, spec §4.2). It was
 * called `ensureIncubatingEgg` and was invoked from four sites, two of them
 * pure reads (`eggState` on every GET /api/ramble/egg, `flockState` on every
 * flock screen), so merely looking at a screen recreated the egg. Read with
 * `getIncubatingEgg` instead; the name is "mint" so that a future caller has
 * to mean it.
 *
 * The INSERT ... SELECT ... WHERE NOT EXISTS guard (rather than a unique
 * index) makes this race-free within one process on a single SQLite
 * connection: two overlapping calls each attempt the guarded insert, only one
 * succeeds, and both re-select the same egg.
 */
export async function mintIncubatingEgg(db, { now, emit } = {}) {
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
 * Refill an empty incubating slot from the shelf (spec §4.2). This is the
 * release valve that makes D3 — warmth vanishing when there is no egg —
 * tolerable: the user is only ever eggless when they genuinely have none.
 *
 * Order is `created_at ASC, egg_id ASC`: a TOTAL order and a pure function of
 * rows that replicate, so two instances reach the same answer independently
 * with nothing to exchange and nothing to emit beyond the row itself.
 *
 * ⚠ NOT the same mechanism as `RAMBLE_EGG_REPROMOTE_SQL` in
 * servers/sharing/instance-sync.js, which promotes ONLY `shelf_origin='sync'`
 * eggs and says a 'user' egg "must never be drafted back in". That is correct
 * FOR SYNC: it is a convergence tie-break carrying no user intent, and
 * drafting a deliberately-parked egg on a sync apply would override a choice
 * the user made. This one is a game rule and DOES take user eggs — that is
 * the point of §4.2. Do not unify them.
 *
 * An egg named by an open swap is skipped: it is promised to a contact, and
 * incubating it would let the user spend it twice.
 *
 * Writes NOTHING when the slot is occupied or nothing is promotable.
 *
 * ⚠ CALLED FROM EXACTLY ONE PLACE: `hatchIfReady`. Never from a read path.
 *
 * Two earlier drafts of this plan called it from `eggState`/`flockState` too,
 * so that a slot emptied by a sync arrival would refill without waiting for a
 * hatch. Both were wrong, and the second was wrong in a subtler way than the
 * first:
 *
 *   1. It is a write during a GET, and `applyRambleEgg` carries an explicit
 *      carve-out (instance-sync.js:855-860) refusing to re-promote on a peer's
 *      USER shelve, because the replacement egg's row "follows in the same
 *      drain" — a GET landing in that window drafts the egg the user just
 *      parked, and it then out-ranks their real choice on both machines.
 *   2. The attempted fix — marking such a promote `shelf_origin = 'sync'` so
 *      it ranks below a real choice — LAUNDERS PROVENANCE. `flock.js:126`
 *      counts `status='shelf' AND shelf_origin='user'` for the nest shelf cap
 *      and `flock.js:253` for `shelf_count`; `instance-sync.js:831` rewrites
 *      a demoted egg to `'sync'` unconditionally; and
 *      `RAMBLE_EGG_REPROMOTE_SQL` drafts `'sync'` eggs only. A user egg
 *      relabelled 'sync' therefore stops consuming a shelf slot, is
 *      under-reported to the user, becomes draftable by the very sync rule
 *      the 'user' mark exists to protect it from, and is mislabelled "came
 *      back from another of your Crows" at `static/ramble.js:1776`.
 *
 * Honest inventory of every way the slot can empty, and what covers it:
 *
 *   - a hatch                  -> covered HERE, and this is the main loop
 *   - `incubateEgg` swap       -> never empties the slot (one conditional
 *                                 UPDATE), and it ends in `hatchIfReady`
 *   - gifting / swapping away  -> the incubating egg is not giftable
 *                                 (`GIFTABLE = {shelf, received}`)
 *   - a gift or swap ARRIVING, or a swap expiring/declining and unlocking
 *     the last shelf egg, while the slot is empty
 *                              -> NOT auto-promoted. The egg sits on the
 *                                 shelf and the panel says so, with a button
 *                                 that incubates it in one tap (Task 7).
 *   - a slot emptied by `applyRambleEgg` while the user holds ONLY 'user'
 *     shelf eggs -> same: `RAMBLE_EGG_REPROMOTE_SQL` drafts
 *                   `shelf_origin='sync'` rows only.
 *
 * ⚠ An earlier draft promoted from `trades.js`'s closing paths to auto-cover
 * rows 4 and 5. It was reverted: promoting inside `expireTrades` strands an
 * in-flight `completed` envelope — the hand-over UPDATE (`WHERE status IN
 * ('shelf','received')`) then matches nothing while `receivedEggStatement`
 * still inserts, so the user keeps BOTH eggs. Manufacturing a free-egg race
 * in the phase whose whole purpose is removing the free egg is not a trade
 * worth making, and the underlying complaint was never "the slot is empty" —
 * it was "the player has no signal and no way back". That is an affordance
 * problem, and it is fixed with an affordance.
 */
/**
 * The egg that WOULD be promoted, or null — a pure read, no writes.
 *
 * Extracted so the promote and the panel's "one's waiting on your shelf" card
 * read exactly ONE rule. A card that offers an egg the promote would not take
 * (or the reverse) is the map/payout split this project has already had to
 * close once in phase 1.
 */
export async function nextPromotable(db) {
  if (await getIncubatingEgg(db)) return null;
  const locked = await lockedEggIds(db);
  const { rows } = await db.execute({
    sql: `SELECT egg_id FROM ramble_eggs
           WHERE status IN ('shelf', 'received')
           ORDER BY created_at ASC, egg_id ASC`,
    args: [],
  });
  return rows.find((r) => !locked.has(r.egg_id)) ?? null;
}

export async function promoteFromShelf(db, { now, emit } = {}) {
  void now;
  const next = await nextPromotable(db);
  if (!next) return null;

  // Guarded exactly like mintIncubatingEgg: the "one incubating egg" rule is
  // a query against the table's contents, not a schema constraint, so two
  // overlapping promotes must not both succeed.
  // The lock is re-checked in SQL, not only in nextPromotable's JS filter, so
  // this matches incubateEgg's own guard (flock.js:189-192) exactly and a swap
  // opened between the peek and the write cannot slip through.
  const { rowsAffected } = await db.execute({
    sql: `UPDATE ramble_eggs SET status = 'incubating', shelf_origin = NULL
           WHERE egg_id = ? AND status IN ('shelf', 'received')
             AND NOT EXISTS (SELECT 1 FROM ramble_eggs WHERE status = 'incubating')
             AND NOT EXISTS (SELECT 1 FROM ramble_trades
                              WHERE my_egg_id = ? AND state IN ('proposed', 'accepted'))`,
    args: [next.egg_id, next.egg_id],
  });
  if (rowsAffected === 0) return null;

  const promoted = await getIncubatingEgg(db);
  if (promoted) await safeEmit(emit, "ramble_eggs", "update", promoted);
  return promoted;
}

/**
 * Hatches the incubating egg if its warmth has reached hatch_at. The UPDATE
 * that flips this egg to 'hatched' MUST run before the shelf is asked to
 * refill the slot: `promoteFromShelf`'s "one incubating egg" guard is a query
 * against the table's current contents, not a schema constraint, so the old
 * egg has to already be out of 'incubating' status before that guard runs.
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

  // Phase 3: the successor egg is NOT minted. The shelf refills the slot if
  // it can; otherwise the player is genuinely eggless and the panel says so.
  await promoteFromShelf(db, { now, emit });

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

  // ⚠ NOT a mint. With no egg the ledger row is STILL written and `credited`
  // is still true, because `credited` means "this key was new" and
  // feedAll's `shouldFeedPet` gate reads it: reporting not-credited here
  // would stop new places, crows and check-ins from feeding the bird for as
  // long as the player is eggless — and laying needs happy days while
  // eggless. The warmth itself vanishes (spec D3) and the key is burned, so
  // the same place cannot bank warmth for a later egg.
  const egg = await getIncubatingEgg(db);

  if (key) {
    const { rowsAffected } = await db.execute({
      sql: "INSERT OR IGNORE INTO ramble_credits (kind, key, credited_at) VALUES (?, ?, ?)",
      args: [key.kind, key.key, now],
    });
    if (rowsAffected === 0) {
      const current = await getIncubatingEgg(db);
      return { credited: false, warmth: current ? current.warmth : 0, hatched: null };
    }
  }

  if (!egg) return { credited: true, warmth: 0, hatched: null };
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

export const LAY_DAYS_DEFAULT = 14;
export const LAYDAY_KIND = "layday";
export const LAY_KIND = "lay";

function intSetting(raw, fallback, min) {
  if (raw == null) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

/** `lay.days` (>= 1, default 14), read live so balance is a config change. */
export async function readLaySettings(db) {
  return { layDays: intSetting(await readSetting(db, "lay.days"), LAY_DAYS_DEFAULT, 1) };
}

/**
 * Does the user hold an egg ANYWHERE — the slot, the shelf, or a gift not yet
 * dealt with? A hatched bird is not an egg: you are not warming it.
 */
export async function hasAnyEggAnywhere(db) {
  const { rows } = await db.execute({
    sql: `SELECT 1 FROM ramble_eggs WHERE status IN ('incubating', 'shelf', 'received') LIMIT 1`,
    args: [],
  });
  return rows.length > 0;
}

/**
 * Happy days banked since the last lay. The count RESETS without deleting a
 * row: `lay` rows mark each laying, and only `layday` rows AFTER the most
 * recent one count. The ledger stays append-only (spec §6.1).
 *
 * ⚠ ORDERED BY `key`, NEVER BY `created_at`. Both are tempting; only one
 * converges. `applyRambleWallet` resolves a conflict with
 * `created_at = MIN(local, incoming)` (instance-sync.js:620), so a sync apply
 * can move a row's timestamp BACKWARDS — across the reset boundary, in either
 * direction — and clock skew between the user's machines is enough to do it
 * on its own. `key` is the local day (`YYYY-MM-DD`), it is half the primary
 * key, it sorts lexically in true date order, and `applyRambleWallet` never
 * rewrites it. Comparing keys therefore yields the same number on every
 * instance from the same rows. It also excludes the lay-day itself, which is
 * correct: the day you laid is spent.
 */
export async function layProgress(db) {
  const { layDays } = await readLaySettings(db);
  const { rows } = await db.execute({
    sql: `SELECT count(*) AS n FROM ramble_wallet
           WHERE kind = ?
             AND key > COALESCE((SELECT MAX(key) FROM ramble_wallet WHERE kind = ?), '')`,
    args: [LAYDAY_KIND, LAY_KIND],
  });
  return { days: Number(rows[0]?.n ?? 0), needed: layDays };
}

/**
 * Count today toward laying, and lay if the threshold is reached (spec §4.3).
 *
 * Called from the pet's read and feed paths, so "ends the day happy" is really
 * "was observed happy on this local day". The alternative — judging the last
 * observation of the day — would punish opening the app after a good walk.
 *
 * Accrues ONLY while the user holds no egg anywhere. Were it always accruing,
 * a player would run dry and lay at once, and the floor would become the main
 * supply instead of a backstop.
 *
 * ⚠ delta is the literal 1. See applyRambleWallet's MAX(delta) rule.
 *
 * ⚠ Called ONLY from the write paths (`feed`, and `doChore` through it) —
 * never from `petState`. `pet.js:18` records the invariant: "petState's
 * decay-on-read write never emits, because a GET must never queue a sync op",
 * and `petState` has no `emit` in scope to pass. A day is therefore earned by
 * DOING something — a walk, a chore, a check-in — not by opening the app,
 * which is also the truer reading of §4.3's "sustained care".
 *
 * ⚠ Laying REQUIRES real movement, and that is a design consequence, not an
 * oversight. Decay is 10 per 6 h (-40/day); the most a player who never posts
 * a location fix can earn is checkin 5 + 3 chores x 8 = 29/day. From the
 * default 60 they bank three happy days and then fall below the 60 threshold
 * for good. Do NOT write, in a comment or a doc, that chores and the check-in
 * alone can reach `lay.days`. They cannot.
 */
export async function recordHappyDay(db, { now = Date.now(), mood, emit } = {}) {
  if (mood !== "happy") return { recorded: false, laid: false };
  if (await hasAnyEggAnywhere(db)) return { recorded: false, laid: false };

  const key = localDay(now);
  const { rowsAffected } = await db.execute({
    sql: `INSERT OR IGNORE INTO ramble_wallet (kind, key, delta, created_at) VALUES (?, ?, 1, ?)`,
    args: [LAYDAY_KIND, key, now],
  });
  if (rowsAffected === 0) return { recorded: false, laid: false };
  await safeEmit(emit, "ramble_wallet", "insert", { kind: LAYDAY_KIND, key, delta: 1, created_at: now });

  const { days, needed } = await layProgress(db);
  if (days < needed) return { recorded: true, laid: false };

  // ⚠ The mint is gated on the `lay` row being NEW. Without checking
  // rowsAffected the dedup key just written would be decorative, and two
  // overlapping calls would each mint an egg.
  const { rowsAffected: laidNow } = await db.execute({
    sql: `INSERT OR IGNORE INTO ramble_wallet (kind, key, delta, created_at) VALUES (?, ?, 1, ?)`,
    args: [LAY_KIND, key, now],
  });
  if (laidNow === 0) return { recorded: true, laid: false };

  await safeEmit(emit, "ramble_wallet", "insert", { kind: LAY_KIND, key, delta: 1, created_at: now });
  await mintIncubatingEgg(db, { now, emit });
  return { recorded: true, laid: true };
}

export async function eggState(db, { now } = {}) {
  const egg = await getIncubatingEgg(db);
  const weights = await readWarmthWeights(db);
  const percent = egg && weights.hatch_at > 0
    ? Math.max(0, Math.min(100, Math.round((egg.warmth / weights.hatch_at) * 100)))
    : 0;

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
    egg: egg
      ? { egg_id: egg.egg_id, warmth: egg.warmth, hatch_at: weights.hatch_at, percent }
      : null,
    checklist: { new_places_week: newPlacesWeek, first_mark: firstMark, checked_in_today: checkedInToday },
  };
}
