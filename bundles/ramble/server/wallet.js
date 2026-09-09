/**
 * The currency ledger (spec 2026-09-08 §6.1).
 *
 * Balances are NEVER stored as balances. Two instances each writing a running
 * total would lose increments to last-writer-wins, so every earn and spend is
 * an append-only row under a natural idempotent key and the total is derived
 * by summing. This is the same trick ramble_credits already uses for warmth —
 * the difference is that this table replicates, because a wallet has to follow
 * the user across their machines.
 *
 * Bird seed grows in ground the user has already unlocked (spec §2.3): walking
 * a familiar route pays, pacing one cell does not, because the key is the cell
 * AND the window.
 */
import { createHash } from "node:crypto";
import { CELL7_RE } from "./nests.js";
import { decodeGeohash } from "./anchors.js";

export const SEED_KIND = "seed";
export const SEED_SALT = "ramble-seed-v1:";
const RESPAWN_HOURS_DEFAULT = 24;
const PER_PICKUP_DEFAULT = 1;
const SEED_RATE_DEFAULT = 4;

/** Which respawn window `now` falls in. Same cell, same window = already harvested. */
export function harvestWindow(now, hours) {
  const h = Number.isFinite(hours) && hours >= 1 ? hours : RESPAWN_HOURS_DEFAULT;
  return Math.floor(Number(now) / (h * 3600 * 1000));
}

/**
 * Does this cell hold seed in this window, and exactly where in it?
 *
 * Copies `nestFor`'s trick deliberately: a public hash of the cell and the
 * window, so the answer is identical on every device with nothing stored and
 * nothing to sync, and cannot be re-rolled by leaving and coming back.
 *
 * WHY IT IS SPARSE. The first version paid in EVERY unlocked cell, which
 * carpeted the map — a player reported most of the visible seed sat beyond any
 * walk, strung out along a freeway. One cell in `rate` keeps a walkable frame
 * to a handful you can actually reach, and the density is a setting rather
 * than a constant so it can be tuned without a deploy.
 *
 * The position is a hash-derived point INSIDE the cell, not its centre, so a
 * row of seed along a street does not look like a pegboard.
 */
export function seedFor(cell, window, { rate = SEED_RATE_DEFAULT } = {}) {
  if (typeof cell !== "string" || !CELL7_RE.test(cell)) return null;
  if (!Number.isFinite(Number(window))) return null;
  const r = Number.isInteger(rate) && rate >= 1 ? rate : SEED_RATE_DEFAULT;
  const h = createHash("sha256").update(SEED_SALT + cell + ":" + String(window)).digest();
  if (h.readUInt32BE(0) % r !== 0) return null;
  let c;
  try { c = decodeGeohash(cell); } catch { return null; }
  if (!c || !Number.isFinite(c.lat) || !Number.isFinite(c.lon)) return null;
  const fy = h.readUInt32BE(4) / 0x100000000;
  const fx = h.readUInt32BE(8) / 0x100000000;
  return {
    cell,
    lat: c.lat - c.latErr + fy * 2 * c.latErr,
    lon: c.lon - c.lonErr + fx * 2 * c.lonErr,
  };
}

/** Live settings (spec §6.4), each falling back on junk or a negative. */
export async function readWalletSettings(db) {
  const out = { respawnHours: RESPAWN_HOURS_DEFAULT, perPickup: PER_PICKUP_DEFAULT, rate: SEED_RATE_DEFAULT };
  try {
    const { rows } = await db.execute({
      sql: "SELECT key, value FROM ramble_settings WHERE key IN ('seed.respawn.hours', 'seed.per.pickup', 'seed.rate')",
      args: [],
    });
    for (const r of rows || []) {
      const n = parseInt(r.value, 10);
      if (r.key === "seed.respawn.hours" && Number.isInteger(n) && n >= 1) out.respawnHours = n;
      if (r.key === "seed.per.pickup" && Number.isInteger(n) && n >= 0) out.perPickup = n;
      if (r.key === "seed.rate" && Number.isInteger(n) && n >= 1) out.rate = n;
    }
  } catch { /* defaults */ }
  return out;
}

/** Mirrors eggs.js's helper: an emit must never be able to fail the write. */
async function safeEmit(emit, table, op, row) {
  if (typeof emit !== "function") return;
  try { await emit(table, op, row); }
  catch (err) { try { console.warn(`[ramble] emit ${table} failed:`, err?.message); } catch {} }
}

/**
 * Harvest this cell's seed if it has regrown. `picked` is false when it has
 * not. Emits on a real pickup — without that the ledger would sync inbound
 * only and a balance earned on the phone would never reach the desktop.
 */
export async function recordSeedPickup(db, cell, { now = Date.now(), emit } = {}) {
  const none = { picked: false, amount: 0 };
  if (!db || typeof cell !== "string" || !CELL7_RE.test(cell)) return none;
  try {
    const { respawnHours, perPickup, rate } = await readWalletSettings(db);
    // NOT `Number(now) || Date.now()` — that treats `now: 0` as falsy and
    // silently substitutes the real clock, which breaks a replayed pickup at
    // epoch 0 (exercised directly by this file's own tests).
    const at = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    const window = harvestWindow(at, respawnHours);
    // The SAME gate the map draws from. Without this the map would be a liar:
    // it would show seed in one cell in four while every cell quietly paid.
    if (!seedFor(cell, window, { rate })) return none;
    const key = `${cell}:${window}`;
    const res = await db.execute({
      sql: `INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(kind, key) DO NOTHING`,
      args: [SEED_KIND, key, perPickup, at],
    });
    if (Number(res.rowsAffected) === 0) return none;
    await safeEmit(emit, "ramble_wallet", "insert", { kind: SEED_KIND, key, delta: perPickup, created_at: at });
    return { picked: true, amount: perPickup };
  } catch (err) {
    try { console.warn("[ramble] seed pickup failed:", err?.message); } catch {}
    return none;
  }
}

/**
 * Which of these unlocked cells still have seed waiting in the current window,
 * so the map can show the player where walking pays. A cell is harvestable
 * until it has a ledger row for the window it is in.
 *
 * Filtered by the window SUFFIX in SQL rather than by an IN list of composite
 * keys: the ledger grows by roughly one row per cell per day forever, and a
 * suffix match returns only today's handful, while an IN list of every visible
 * cell would also run into SQLite's bound-variable limit once a player has
 * walked a whole town.
 */
export async function harvestableCells(db, cells, { now = Date.now() } = {}) {
  const list = (Array.from(cells || [])).filter((c) => typeof c === "string" && CELL7_RE.test(c));
  if (!db || list.length === 0) return [];
  try {
    const { respawnHours, rate } = await readWalletSettings(db);
    const at = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    const window = harvestWindow(at, respawnHours);
    const suffix = ":" + window;
    const { rows } = await db.execute({
      sql: "SELECT key FROM ramble_wallet WHERE kind = ? AND key LIKE ?",
      args: [SEED_KIND, "%" + suffix],
    });
    const taken = new Set();
    for (const r of rows || []) {
      const key = String(r.key || "");
      if (key.endsWith(suffix)) taken.add(key.slice(0, -suffix.length));
    }
    // Returns POINTS, not cells: the pip sits where the seed actually is,
    // which is a hash-derived spot inside the cell rather than its centre.
    const out = [];
    for (const c of list) {
      if (taken.has(c)) continue;
      const at2 = seedFor(c, window, { rate });
      if (at2) out.push(at2);
    }
    return out;
  } catch (err) {
    // A map that cannot say where seed is should still draw. Never throw here.
    try { console.warn("[ramble] harvestableCells failed:", err?.message); } catch {}
    return [];
  }
}

/** The derived balance: every earn minus every spend. */
export async function seedBalance(db) {
  try {
    const { rows } = await db.execute({
      sql: "SELECT COALESCE(SUM(delta), 0) AS total FROM ramble_wallet WHERE kind = ?",
      args: [SEED_KIND],
    });
    return Number(rows?.[0]?.total) || 0;
  } catch { return 0; }
}
