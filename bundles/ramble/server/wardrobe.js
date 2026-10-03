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
