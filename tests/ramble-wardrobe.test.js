/**
 * Spec 2026-09-08 §5, §6.1 — the wardrobe ledger. A purchase is a spend row
 * in ramble_wallet keyed uniquely per purchase; ownership and the seed
 * balance are both DERIVED, never stored.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { seedBalance, SPEND_KIND } from "../bundles/ramble/server/wallet.js";
import { ACCESSORIES, itemById, ownedItems, buyItem } from "../bundles/ramble/server/wardrobe.js";
import { createRequire } from "node:module";
const Bird = createRequire(import.meta.url)("../bundles/ramble/server/bird-svg.cjs");

const NOW = 1_760_000_000_000;
async function freshDb(seed = 0) {
  const db = createClient({ url: "file::memory:" });
  await initRambleTables(db);
  if (seed) {
    await db.execute({ sql: "INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES ('seed', 'grant:test', ?, ?)", args: [seed, NOW] });
  }
  return db;
}

test("the catalogue: unique ids, every slot/value is drawable, every price a positive integer", () => {
  const ids = new Set();
  for (const it of ACCESSORIES) {
    assert.ok(!ids.has(it.id), `duplicate ${it.id}`); ids.add(it.id);
    assert.equal(it.id, `${it.slot}.${it.value}`);
    assert.ok(Bird.OUTFIT_SLOTS[it.slot].includes(it.value), `${it.id} has art`);
    assert.ok(Number.isInteger(it.price) && it.price > 0);
    assert.ok(typeof it.name === "string" && it.name.length > 0);
  }
  for (const slot of Object.keys(Bird.OUTFIT_SLOTS)) for (const v of Bird.OUTFIT_SLOTS[slot]) {
    assert.ok(itemById(`${slot}.${v}`), `every drawable ${slot}.${v} is for sale`);
  }
  assert.equal(itemById("hat.monocle"), null);
  assert.equal(itemById("__proto__"), null);
});

test("buying writes ONE spend row keyed per purchase, emits it, and the balance drops", async () => {
  const db = await freshDb(50);
  const emitted = [];
  const out = await buyItem(db, "hat.beanie", { now: NOW, purchaseId: "p1", emit: async (t, op, row) => emitted.push({ t, op, row }) });
  const price = itemById("hat.beanie").price;
  assert.equal(out.ok, true);
  assert.equal(out.balance, 50 - price);
  assert.equal(await seedBalance(db), 50 - price, "seedBalance subtracts spends");
  const { rows } = await db.execute("SELECT kind, key, delta, created_at FROM ramble_wallet WHERE kind = 'spend'");
  assert.deepEqual(rows.map((r) => ({ ...r })), [{ kind: SPEND_KIND, key: "hat.beanie:p1", delta: -price, created_at: NOW }]);
  assert.deepEqual(emitted, [{ t: "ramble_wallet", op: "insert", row: { kind: "spend", key: "hat.beanie:p1", delta: -price, created_at: NOW } }]);
  assert.deepEqual([...await ownedItems(db)], ["hat.beanie"]);
});

test("refusals: unknown item, already owned, not enough seed — nothing written, nothing emitted", async () => {
  const db = await freshDb(10);
  const emitted = [];
  const emit = async (...a) => emitted.push(a);
  assert.deepEqual(await buyItem(db, "hat.monocle", { now: NOW, emit }), { ok: false, reason: "unknown-item", balance: 10 });
  const pricey = ACCESSORIES.find((i) => i.price > 10);
  assert.deepEqual(await buyItem(db, pricey.id, { now: NOW, emit }), { ok: false, reason: "short", balance: 10 });
  const cheap = ACCESSORIES.find((i) => i.price <= 10);
  assert.equal((await buyItem(db, cheap.id, { now: NOW, emit, purchaseId: "a" })).ok, true);
  const again = await buyItem(db, cheap.id, { now: NOW, emit, purchaseId: "b" });
  assert.equal(again.ok, false);
  assert.equal(again.reason, "owned");
  assert.equal(emitted.length, 1, "only the one real purchase emitted");
});

test("exactly-enough seed buys; a double tap (two concurrent buys) charges once", async () => {
  const item = itemById("hat.bow");
  const db = await freshDb(item.price);
  const [a, b] = await Promise.all([
    buyItem(db, item.id, { now: NOW, purchaseId: "x" }),
    buyItem(db, item.id, { now: NOW, purchaseId: "y" }),
  ]);
  assert.equal([a, b].filter((r) => r.ok).length, 1, "one wins");
  assert.equal(await seedBalance(db), 0);
  const { rows } = await db.execute("SELECT count(*) AS n FROM ramble_wallet WHERE kind = 'spend'");
  assert.equal(Number(rows[0].n), 1);
});

test("a negative balance (two instances spent the same seed) refuses further buys and owned items stay owned", async () => {
  const db = await freshDb(0);
  await db.execute({ sql: "INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES ('spend', 'hat.bow:p1', -8, ?)", args: [NOW] });
  assert.equal(await seedBalance(db), -8);
  assert.ok((await ownedItems(db)).has("hat.bow"));
  assert.equal((await buyItem(db, "hat.leaf", { now: NOW })).reason, "short");
});

test("ownedItems ignores spend rows for items no longer (or not yet) in this catalogue", async () => {
  const db = await freshDb(0);
  await db.execute({ sql: "INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES ('spend', 'glasses.monocle:p9', -40, ?)", args: [NOW] });
  assert.deepEqual([...await ownedItems(db)], [], "unknown to this version: not wearable here");
  assert.equal(await seedBalance(db), -40, "but the seed it cost is still spent");
});
