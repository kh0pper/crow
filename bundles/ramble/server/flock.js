/**
 * Ramble flock — the db-facing half of nests + the shelf (spec §2.4–2.5).
 *
 * nests.js decides WHERE nests are (pure); this module decides what the user
 * has done about them: claims (one per local day, shelf cap, idempotent per
 * nest), the shelf itself, which egg incubates, which bird is active, and the
 * flock roster. Every egg it creates or moves is written with an explicit
 * `shelf_origin = 'user'` so instance sync never auto-promotes it (Task 1).
 *
 * Claiming credits NO warmth and NO pet energy (deliberate: the egg is the
 * reward; spec §2.1's weight table has no claim row). Do not add feedAll here.
 *
 * Phase 3: received eggs (gifts/swaps) sit on the shelf as their own class
 * and never count toward the claim cap; an egg named by an open trade is
 * locked (trades.js).
 */
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { withinRange, haversineMeters } from "./anchors.js";
import { isoWeek, startOfLocalDay, hatchIfReady, ensureIncubatingEgg, readWarmthWeights } from "./eggs.js";
import { nestFor, cellsInBbox, nestsInCells, NEST_RATE_DEFAULT, CELL7_RE, WEEK_RE } from "./nests.js";
import { isEggLocked, lockedEggIds } from "./egg-locks.js";

const require = createRequire(import.meta.url);
const { ROSTER } = require("./bird-svg.cjs");

export const SHELF_CAP_DEFAULT = 5;
export const CLAIM_RANGE_M = 75;
export const CLAIMS_PER_DAY = 1;

async function safeEmit(emit, table, op, row) {
  if (!emit) return;
  try { await emit(table, op, row); }
  catch (err) { console.error(`[ramble flock] emit(${table}, ${op}) failed:`, err?.message ?? err); }
}

async function readSetting(db, key) {
  try {
    const { rows } = await db.execute({ sql: "SELECT value FROM ramble_settings WHERE key = ?", args: [key] });
    return rows[0]?.value ?? null;
  } catch { return null; }
}

function intSetting(raw, fallback, min) {
  if (raw == null) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

/** `nest.rate` (>= 1, default 24) and `shelf.cap` (>= 0, default 5), read live. */
export async function readFlockSettings(db) {
  return {
    rate: intSetting(await readSetting(db, "nest.rate"), NEST_RATE_DEFAULT, 1),
    shelfCap: intSetting(await readSetting(db, "shelf.cap"), SHELF_CAP_DEFAULT, 0),
  };
}

async function getEgg(db, eggId) {
  const { rows } = await db.execute({ sql: "SELECT * FROM ramble_eggs WHERE egg_id = ?", args: [eggId] });
  return rows[0] ?? null;
}

async function claimedCells(db, week) {
  const { rows } = await db.execute({ sql: "SELECT cell FROM ramble_nest_claims WHERE week = ?", args: [week] });
  return new Set(rows.map((r) => r.cell));
}

/**
 * Nests inside `bbox` for the CURRENT week, each flagged `claimed` for this
 * instance. With `from`, nearest first with `distance_m`. Null = too wide.
 */
export async function listNests(db, bbox, { now = Date.now(), from = null } = {}) {
  const cells = cellsInBbox(bbox);
  if (!cells) return null;
  const week = isoWeek(now);
  const { rate } = await readFlockSettings(db);
  const claimed = await claimedCells(db, week);
  let nests = nestsInCells(cells, week, { rate }).map((n) => ({ ...n, claimed: claimed.has(n.cell) }));
  if (from && typeof from.lat === "number" && typeof from.lon === "number") {
    nests = nests
      .map((n) => ({ ...n, distance_m: Math.round(haversineMeters(from, { lat: n.lat, lon: n.lon })) }))
      .sort((x, y) => x.distance_m - y.distance_m);
  }
  return { week, nests };
}

/**
 * Claim the nest at (cell, week) from `here`. Checks, in order: the week is
 * the current one; a nest exists there; already claimed -> the same egg back
 * (idempotent, distance not re-checked); within 75 m; one claim per local
 * day; shelf cap (counting the user's OWN shelf eggs, shelf_origin='user' —
 * a convergence loser parked by sync is not one of their five spots). The
 * claim row is inserted BEFORE the egg and its PK is the double-tap guard for
 * the SAME nest (like the credits ledger); the daily limit and the cap are
 * read-then-insert, so two concurrent claims of DIFFERENT nests can both
 * pass — accepted, it needs two devices tapping in the same instant. A claim
 * whose egg is missing (crash between the two writes) is healed by writing
 * the egg it names.
 */
export async function claimNest(db, { cell, week, here, now = Date.now(), emit } = {}) {
  if (typeof cell !== "string" || !CELL7_RE.test(cell)) throw new Error("cell must be a 7-character geohash");
  if (typeof week !== "string" || !WEEK_RE.test(week)) throw new Error("week must look like 2026-W37");
  if (week !== isoWeek(now)) return { claimed: false, reason: "stale-week" };

  const { rate, shelfCap } = await readFlockSettings(db);
  const nest = nestFor(cell, week, { rate });
  if (!nest) return { claimed: false, reason: "no-nest" };

  const { rows: prior } = await db.execute({
    sql: "SELECT egg_id FROM ramble_nest_claims WHERE cell = ? AND week = ?", args: [cell, week],
  });
  if (prior[0]) {
    const egg = (await getEgg(db, prior[0].egg_id)) ?? await insertClaimedEgg(db, prior[0].egg_id, cell, week, now, emit);
    return { claimed: true, already: true, egg };
  }

  const anchor = { anchor_kind: "geo", lat: nest.lat, lon: nest.lon, accuracy_m: CLAIM_RANGE_M };
  if (!withinRange(anchor, here)) return { claimed: false, reason: "too-far" };

  const { rows: today } = await db.execute({
    sql: "SELECT count(*) AS n FROM ramble_nest_claims WHERE claimed_at >= ?", args: [startOfLocalDay(now)],
  });
  if (Number(today[0]?.n ?? 0) >= CLAIMS_PER_DAY) return { claimed: false, reason: "daily-limit" };

  const { rows: shelf } = await db.execute({
    sql: "SELECT count(*) AS n FROM ramble_eggs WHERE status = 'shelf' AND shelf_origin = 'user'", args: [],
  });
  if (Number(shelf[0]?.n ?? 0) >= shelfCap) return { claimed: false, reason: "shelf-full" };

  const eggId = crypto.randomUUID();
  const { rowsAffected } = await db.execute({
    sql: "INSERT OR IGNORE INTO ramble_nest_claims (cell, week, egg_id, claimed_at) VALUES (?, ?, ?, ?)",
    args: [cell, week, eggId, now],
  });
  if (rowsAffected === 0) {
    // Lost a same-instance race to another claim of this nest: return theirs.
    const { rows } = await db.execute({ sql: "SELECT egg_id FROM ramble_nest_claims WHERE cell = ? AND week = ?", args: [cell, week] });
    const egg = (await getEgg(db, rows[0].egg_id)) ?? await insertClaimedEgg(db, rows[0].egg_id, cell, week, now, emit);
    return { claimed: true, already: true, egg };
  }
  const egg = await insertClaimedEgg(db, eggId, cell, week, now, emit);
  return { claimed: true, already: false, egg };
}

async function insertClaimedEgg(db, eggId, cell, week, now, emit) {
  await db.execute({
    sql: `INSERT INTO ramble_eggs (egg_id, status, shelf_origin, warmth, found_cell, found_week, created_at)
          VALUES (?, 'shelf', 'user', 0, ?, ?, ?) ON CONFLICT(egg_id) DO NOTHING`,
    args: [eggId, cell, week, now],
  });
  const egg = await getEgg(db, eggId);
  await safeEmit(emit, "ramble_eggs", "insert", egg);
  return egg;
}

async function getPetRow(db) {
  await db.execute({ sql: "INSERT INTO ramble_pet (owner) VALUES ('self') ON CONFLICT(owner) DO NOTHING", args: [] });
  const { rows } = await db.execute({ sql: "SELECT * FROM ramble_pet WHERE owner = 'self'", args: [] });
  return rows[0];
}

/**
 * Make `eggId` (a shelf or received egg) the incubating egg. The previous
 * incubating egg goes to the shelf marked 'user' (the user chose to park it;
 * sync must not draft it back). One conditional statement, so the swap is
 * all-or-nothing: if the target is no longer on the shelf when the write
 * runs, nothing changes and the caller gets the egg's real state. Emits the
 * shelved row first, then the new incubating row — the peer's apply of a
 * user shelve skips re-promotion precisely because the successor is the next
 * op in the drain (Task 1).
 */
export async function incubateEgg(db, eggId, { now = Date.now(), emit } = {}) {
  const target = await getEgg(db, eggId);
  if (!target) return { ok: false, reason: "not-found" };
  if (target.status === "incubating") return { ok: true, already: true, egg: target, shelved: null, hatched: null };
  if (target.status !== "shelf" && target.status !== "received") return { ok: false, reason: "not-an-egg" };
  // An egg named by an open swap is spoken for: it may not move until the
  // trade closes (Task 3 lock rule).
  if (await isEggLocked(db, eggId)) return { ok: false, reason: "in-trade" };

  const { rows: current } = await db.execute({ sql: "SELECT egg_id FROM ramble_eggs WHERE status = 'incubating'", args: [] });
  const { rowsAffected } = await db.execute({
    sql: `UPDATE ramble_eggs
             SET status = CASE WHEN egg_id = ? THEN 'incubating' ELSE 'shelf' END,
                 shelf_origin = CASE WHEN egg_id = ? THEN NULL ELSE 'user' END
           WHERE (status = 'incubating' OR egg_id = ?)
             AND EXISTS (SELECT 1 FROM ramble_eggs WHERE egg_id = ? AND status IN ('shelf', 'received'))
             AND NOT EXISTS (SELECT 1 FROM ramble_trades WHERE my_egg_id = ? AND state IN ('proposed', 'accepted'))`,
    args: [eggId, eggId, eggId, eggId, eggId],
  });
  if (rowsAffected === 0) {
    // The target moved between our read and the write (a concurrent swap or
    // hatch). Nothing was changed; answer for what it is NOW.
    const now_ = await getEgg(db, eggId);
    if (now_ && now_.status === "incubating") return { ok: true, already: true, egg: now_, shelved: null, hatched: null };
    return { ok: false, reason: "not-an-egg" };
  }

  let shelved = null;
  for (const row of current) {
    // eslint-disable-next-line no-await-in-loop
    const s = await getEgg(db, row.egg_id);
    if (s && s.egg_id !== eggId) { shelved = shelved ?? s; await safeEmit(emit, "ramble_eggs", "update", s); }
  }
  const egg = await getEgg(db, eggId);
  await safeEmit(emit, "ramble_eggs", "update", egg);

  const hatched = await hatchIfReady(db, { now, emit });
  return { ok: true, already: false, egg: hatched ? hatched : egg, shelved, hatched };
}

/** Make a hatched egg the active bird (map, header, wire). */
export async function activateBird(db, eggId, { emit } = {}) {
  const egg = await getEgg(db, eggId);
  if (!egg) return { ok: false, reason: "not-found" };
  if (egg.status !== "hatched" || egg.species == null || egg.seed == null) return { ok: false, reason: "not-a-bird" };
  await getPetRow(db);
  await db.execute({ sql: "UPDATE ramble_pet SET active_egg_id = ? WHERE owner = 'self'", args: [eggId] });
  await safeEmit(emit, "ramble_pet", "update", await getPetRow(db));
  return { ok: true, bird: { egg_id: egg.egg_id, species: egg.species, seed: egg.seed } };
}

/** The flock screen's data: hatched birds, unhatched eggs, and the species score. */
export async function flockState(db, { now = Date.now() } = {}) {
  await ensureIncubatingEgg(db, { now });
  const weights = await readWarmthWeights(db);
  const { shelfCap } = await readFlockSettings(db);
  const pet = await getPetRow(db);
  const locked = await lockedEggIds(db);
  const { rows } = await db.execute({ sql: "SELECT * FROM ramble_eggs ORDER BY created_at ASC, egg_id ASC", args: [] });

  const birds = rows
    .filter((r) => r.status === "hatched" && r.species != null && r.seed != null)
    .sort((x, y) => Number(x.hatched_at) - Number(y.hatched_at))
    .map((r) => ({ egg_id: r.egg_id, species: r.species, seed: r.seed, hatched_at: r.hatched_at, active: r.egg_id === pet.active_egg_id }));

  const pct = (w) => Math.max(0, Math.min(100, Math.round((Number(w) / weights.hatch_at) * 100)));
  const eggs = rows
    .filter((r) => r.status === "incubating" || r.status === "shelf" || r.status === "received")
    .sort((x, y) => (x.status === y.status ? 0 : x.status === "incubating" ? -1 : y.status === "incubating" ? 1 : 0))
    .map((r) => ({
      egg_id: r.egg_id, status: r.status, warmth: r.warmth, percent: pct(r.warmth),
      found_cell: r.found_cell ?? null, found_week: r.found_week ?? null, created_at: r.created_at,
      shelf_origin: r.shelf_origin ?? null,
      // Phase 3: who gave it (received eggs), and whether an open swap has it spoken for.
      from_crow_id: r.from_crow_id ?? null,
      locked: locked.has(r.egg_id),
    }));

  return {
    birds,
    eggs,
    shelf_count: eggs.filter((e) => e.status === "shelf" && e.shelf_origin === "user").length,
    shelf_cap: shelfCap,
    species_found: new Set(birds.map((b) => b.species)).size,
    species_total: ROSTER.length,
    species: ROSTER,
  };
}
