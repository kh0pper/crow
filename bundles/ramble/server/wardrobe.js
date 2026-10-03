/**
 * The wardrobe (spec 2026-09-08 §5, decisions D7, D10, D11).
 *
 * Bird seed buys accessories. A purchase is a SPEND row in the replicated
 * ramble_wallet ledger, keyed `<itemId>:<purchaseId>` — unique per purchase,
 * because applyRambleWallet settles a key conflict with MAX(delta), which must
 * never arbitrate money (see its comment). Ownership is DERIVED from those
 * rows, so the wardrobe follows the user across their own instances for free.
 *
 * Shared wardrobe, per-bird outfit (D11): buy once, any bird may wear it, and
 * each bird's outfit lives on its own ramble_eggs row (outfit_json).
 *
 * Contacts-only (D10): an outfit reaches contacts through the profile picture
 * and NOTHING else. eggs.js activeBird() — what public marks are authored from
 * — deliberately never carries it.
 */
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { seedBalance, SPEND_KIND } from "./wallet.js";

const require = createRequire(import.meta.url);
const { OUTFIT_SLOTS } = require("./bird-svg.cjs");

/** Prices are in bird seed. Seed is ~1 per harvested cell (seed.rate 4, a day
 * to regrow), so a first hat is a couple of days of ordinary walking. */
export const ACCESSORIES = Object.freeze([
  { id: "hat.bow", slot: "hat", value: "bow", name: "Bow", price: 8 },
  { id: "hat.leaf", slot: "hat", value: "leaf", name: "Leaf", price: 8 },
  { id: "hat.beanie", slot: "hat", value: "beanie", name: "Beanie", price: 12 },
  { id: "scarf.knit", slot: "scarf", value: "knit", name: "Knitted scarf", price: 15 },
  { id: "scarf.stripe", slot: "scarf", value: "stripe", name: "Striped scarf", price: 20 },
  { id: "glasses.round", slot: "glasses", value: "round", name: "Round glasses", price: 20 },
  { id: "glasses.shades", slot: "glasses", value: "shades", name: "Shades", price: 25 },
].map((it) => Object.freeze(it)));

const BY_ID = new Map(ACCESSORIES.map((it) => [it.id, it]));

export function itemById(id) {
  return typeof id === "string" && BY_ID.has(id) ? BY_ID.get(id) : null;
}

async function safeEmit(emit, table, op, row) {
  if (typeof emit !== "function") return;
  try { await emit(table, op, row); }
  catch (err) { try { console.warn(`[ramble] emit ${table} failed:`, err?.message); } catch {} }
}

/** Item ids the user owns, derived from spend rows. Unknown ids (another
 * version's catalogue) are skipped: not wearable here, still paid for. */
export async function ownedItems(db) {
  const out = new Set();
  try {
    const { rows } = await db.execute({ sql: "SELECT key FROM ramble_wallet WHERE kind = ?", args: [SPEND_KIND] });
    for (const r of rows || []) {
      const key = String(r.key || "");
      const cut = key.lastIndexOf(":");
      const id = cut > 0 ? key.slice(0, cut) : "";
      if (BY_ID.has(id)) out.add(id);
    }
  } catch { /* nothing owned */ }
  return out;
}

/**
 * Buy one item. ONE conditional INSERT decides it — not owned yet AND the
 * derived balance covers the price — so a double tap cannot charge twice and
 * a check-then-write race cannot overdraw. Only a real purchase emits.
 */
export async function buyItem(db, itemId, { now = Date.now(), emit, purchaseId } = {}) {
  const item = itemById(itemId);
  if (!item) return { ok: false, reason: "unknown-item", balance: await seedBalance(db) };
  const prefix = item.id + ":";
  const key = prefix + (typeof purchaseId === "string" && purchaseId ? purchaseId : randomUUID());
  const at = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const res = await db.execute({
    sql: `INSERT INTO ramble_wallet (kind, key, delta, created_at)
          SELECT ?, ?, ?, ?
           WHERE NOT EXISTS (SELECT 1 FROM ramble_wallet WHERE kind = ? AND substr(key, 1, ?) = ?)
             AND (SELECT COALESCE(SUM(delta), 0) FROM ramble_wallet WHERE kind IN ('seed', ?)) >= ?
          ON CONFLICT(kind, key) DO NOTHING`,
    args: [SPEND_KIND, key, -item.price, at, SPEND_KIND, prefix.length, prefix, SPEND_KIND, item.price],
  });
  const balance = await seedBalance(db);
  if (Number(res.rowsAffected) === 0) {
    return { ok: false, reason: (await ownedItems(db)).has(item.id) ? "owned" : "short", balance };
  }
  await safeEmit(emit, "ramble_wallet", "insert", { kind: SPEND_KIND, key, delta: -item.price, created_at: at });
  return { ok: true, item, balance };
}

/** A stored outfit -> a plain object of KNOWN slot/value pairs. Never throws. */
export function parseOutfit(json) {
  const out = {};
  if (typeof json !== "string" || json === "") return out;
  let raw;
  try { raw = JSON.parse(json); } catch { return out; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const slot of Object.keys(OUTFIT_SLOTS)) {
    if (!Object.prototype.hasOwnProperty.call(raw, slot)) continue;
    const v = raw[slot];
    if (typeof v === "string" && OUTFIT_SLOTS[slot].includes(v)) out[slot] = v;
  }
  return out;
}

async function getEgg(db, eggId) {
  const { rows } = await db.execute({ sql: "SELECT * FROM ramble_eggs WHERE egg_id = ?", args: [eggId] });
  return rows[0] ?? null;
}

let _wearChain = Promise.resolve();

export async function birdOutfit(db, eggId) {
  try {
    const { rows } = await db.execute({ sql: "SELECT outfit_json FROM ramble_eggs WHERE egg_id = ?", args: [eggId] });
    return parseOutfit(rows[0]?.outfit_json ?? null);
  } catch { return {}; }
}

/** Put an owned item on a hatched bird, or (itemId null) take a slot off. */
export async function wearItem(db, eggId, slot, itemId, { emit } = {}) {
  if (typeof slot !== "string" || !Object.prototype.hasOwnProperty.call(OUTFIT_SLOTS, slot)) return { ok: false, reason: "bad-slot" };
  const egg = await getEgg(db, eggId);
  if (!egg) return { ok: false, reason: "not-found" };
  if (egg.status !== "hatched" || egg.species == null || egg.seed == null) return { ok: false, reason: "not-a-bird" };
  // ONE statement per change, applied to whatever is stored NOW — a read,
  // merge-in-JS, write-back would let two quick taps on different slots lose
  // one of them. `slot` is whitelisted above, so building the JSON path from
  // it is safe. A corrupt stored value restarts from '{}'. Never NULL: NULL
  // means "sender knows nothing" to the sync COALESCE (Global Constraints).
  const base = "CASE WHEN outfit_json IS NOT NULL AND json_valid(outfit_json) AND json_type(outfit_json) = 'object' THEN outfit_json ELSE '{}' END";
  let sql, args;
  if (itemId === null) {
    sql = `UPDATE ramble_eggs SET outfit_json = json_remove(${base}, ?) WHERE egg_id = ? AND status = 'hatched'`;
    args = ["$." + slot, eggId];
  } else {
    const item = itemById(itemId);
    if (!item) return { ok: false, reason: "unknown-item" };
    if (item.slot !== slot) return { ok: false, reason: "wrong-slot" };
    if (!(await ownedItems(db)).has(item.id)) return { ok: false, reason: "not-owned" };
    sql = `UPDATE ramble_eggs SET outfit_json = json_set(${base}, ?, ?) WHERE egg_id = ? AND status = 'hatched'`;
    args = ["$." + slot, item.value, eggId];
  }
  // Update -> read -> emit is SERIALIZED per process: the emit mints its sync
  // stamp after several awaits, so two overlapping wears could otherwise emit
  // the older snapshot with the newer stamp and leave the user's other
  // instances one change behind.
  const step = _wearChain.then(async () => {
    const res = await db.execute({ sql, args });
    if (Number(res.rowsAffected) === 0) return { ok: false, reason: "not-found" }; // deleted by a sync apply mid-flight
    const row = await getEgg(db, eggId);
    if (!row) return { ok: false, reason: "not-found" };
    await safeEmit(emit, "ramble_eggs", "update", row);
    return { ok: true, outfit: parseOutfit(row.outfit_json ?? null) };
  });
  _wearChain = step.catch(() => {});
  return step;
}

/** The shop sheet's one read. `active` is the bird you are, with its outfit. */
export async function wardrobeState(db) {
  const owned = await ownedItems(db);
  let active = null;
  try {
    const { rows } = await db.execute({
      sql: `SELECT e.egg_id, e.species, e.seed, e.outfit_json FROM ramble_pet p
            JOIN ramble_eggs e ON e.egg_id = p.active_egg_id
            WHERE p.owner = 'self' AND e.status = 'hatched' AND e.species IS NOT NULL AND e.seed IS NOT NULL LIMIT 1`,
      args: [],
    });
    const r = rows[0];
    if (r) active = { egg_id: r.egg_id, species: r.species, seed: Number(r.seed), outfit: parseOutfit(r.outfit_json ?? null) };
  } catch { active = null; }
  return {
    seed: await seedBalance(db),
    items: ACCESSORIES.map((it) => ({ ...it, owned: owned.has(it.id) })),
    active,
  };
}
