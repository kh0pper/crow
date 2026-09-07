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
 */
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { withinRange, haversineMeters } from "./anchors.js";
import { isoWeek, startOfLocalDay, hatchIfReady, ensureIncubatingEgg, readWarmthWeights } from "./eggs.js";
import { nestFor, cellsInBbox, nestsInCells, NEST_RATE_DEFAULT, CELL7_RE, WEEK_RE } from "./nests.js";

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
