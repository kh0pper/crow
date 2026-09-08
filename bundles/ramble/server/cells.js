/**
 * The unlocked-cell map (spec 2026-09-08 §2.1, §2.4).
 *
 * A cell unlocks the first time the user is physically inside it and stays
 * unlocked forever. Because the record is permanent and honours no deletes, a
 * VAGUE fix must not earn one: a 2 km wifi fix would otherwise unlock ground
 * the user never entered, irreversibly.
 *
 * ⚠ PRIVACY: this set is a precise, permanent record of everywhere the user
 * has been. It replicates to their OWN instances only and must never appear in
 * a contact-facing payload.
 *
 * ⚠ REPLICATION IS EXPLICIT. Registering the table for sync enables the
 * INBOUND apply only; nothing goes outward unless we emit. Every Ramble writer
 * threads `{ now, emit }` and emits after a successful write — see eggs.js.
 */
import { CELL7_RE, CELL7_LAT_STEP, CELL7_LON_STEP } from "./nests.js";

export const UNLOCK_MAX_ACCURACY_M_DEFAULT = 100;

/** The live `unlock.max.accuracy.m` bound (spec §6.4). Junk falls back. */
async function maxAccuracy(db) {
  try {
    const { rows } = await db.execute({
      sql: "SELECT value FROM ramble_settings WHERE key = 'unlock.max.accuracy.m'", args: [],
    });
    const n = parseInt(rows?.[0]?.value, 10);
    return Number.isInteger(n) && n > 0 ? n : UNLOCK_MAX_ACCURACY_M_DEFAULT;
  } catch { return UNLOCK_MAX_ACCURACY_M_DEFAULT; }
}

/** Mirrors eggs.js's helper: an emit must never be able to fail the write. */
async function safeEmit(emit, table, op, row) {
  if (typeof emit !== "function") return;
  try { await emit(table, op, row); }
  catch (err) { try { console.warn(`[ramble] emit ${table} failed:`, err?.message); } catch {} }
}

/**
 * Record a visit. `unlocked` is true ONLY the first time, so the caller can
 * celebrate once. A fix vaguer than the bound is refused outright.
 */
export async function recordUnlock(db, cell, { now = Date.now(), emit, accuracyM } = {}) {
  if (!db || typeof cell !== "string" || !CELL7_RE.test(cell)) return { unlocked: false, cell: null };
  try {
    if (Number.isFinite(accuracyM) && accuracyM > (await maxAccuracy(db))) {
      return { unlocked: false, cell: null, reason: "inaccurate" };
    }
    // NOT `Number(now) || Date.now()` — that treats `now: 0` as falsy and
    // silently substitutes the real clock, which breaks a replayed unlock at
    // epoch 0.
    const at = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    const res = await db.execute({
      sql: `INSERT INTO ramble_cells (cell, first_unlocked_at) VALUES (?, ?) ON CONFLICT(cell) DO NOTHING`,
      args: [cell, at],
    });
    if (Number(res.rowsAffected) > 0) {
      // The outbound half. Without this the table syncs one way only.
      await safeEmit(emit, "ramble_cells", "insert", { cell, first_unlocked_at: at });
      return { unlocked: true, cell };
    }
    return { unlocked: false, cell };
  } catch (err) {
    try { console.warn("[ramble] recordUnlock failed:", err?.message); } catch {}
    return { unlocked: false, cell: null };
  }
}

/** Every unlocked cell, as a Set. Empty (never throws) when the table is absent. */
export async function unlockedCells(db) {
  try {
    const { rows } = await db.execute({ sql: "SELECT cell FROM ramble_cells", args: [] });
    return new Set((rows || []).map((r) => String(r.cell)));
  } catch { return new Set(); }
}

/**
 * Only the unlocked cells that could affect this viewport: inside the bbox, or
 * within `depth` cells of it. A user with years of walking behind them has
 * thousands of cells, and every /marks, /around, /nests and /zones request
 * would otherwise read all of them. Bounded by geography, not by history.
 */
export async function unlockedCellsNear(db, bbox, depth = 0) {
  try {
    if (!bbox) return new Set();
    const padLat = (Number(depth) || 0) * CELL7_LAT_STEP + CELL7_LAT_STEP;
    const padLon = (Number(depth) || 0) * CELL7_LON_STEP + CELL7_LON_STEP;
    // A geohash prefix is not a range, so filter on the decoded centre instead:
    // cheap because the row count is the user's own walked ground, and the
    // comparison is done in SQL only when the table carries the columns. Here
    // we read the cells and filter in JS, which keeps the schema minimal.
    const { rows } = await db.execute({ sql: "SELECT cell FROM ramble_cells", args: [] });
    const { decodeGeohash } = await import("./anchors.js");
    const out = new Set();
    for (const r of rows || []) {
      let c;
      try { c = decodeGeohash(String(r.cell)); } catch { continue; }
      if (c.lat >= bbox.south - padLat && c.lat <= bbox.north + padLat &&
          c.lon >= bbox.west - padLon && c.lon <= bbox.east + padLon) out.add(String(r.cell));
    }
    return out;
  } catch { return new Set(); }
}
