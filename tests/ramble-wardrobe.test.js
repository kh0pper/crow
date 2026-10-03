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

test("with seed to spare, the owned guard (not the balance) stops a double charge", async () => {
  const item = itemById("hat.beanie");
  const db = await freshDb(item.price * 4);
  const [a, b] = await Promise.all([
    buyItem(db, item.id, { now: NOW, purchaseId: "c1" }),
    buyItem(db, item.id, { now: NOW, purchaseId: "c2" }),
  ]);
  assert.equal([a, b].filter((r) => r.ok).length, 1, "concurrent double tap: one wins");
  const again = await buyItem(db, item.id, { now: NOW, purchaseId: "c3" });
  assert.equal(again.ok, false);
  assert.equal(again.reason, "owned");
  assert.equal(again.balance, item.price * 3);
  const { rows } = await db.execute("SELECT count(*) AS n FROM ramble_wallet WHERE kind = 'spend'");
  assert.equal(Number(rows[0].n), 1, "exactly one spend row");
  assert.equal(await seedBalance(db), item.price * 3);
});

import { parseOutfit, birdOutfit, wearItem, wardrobeState } from "../bundles/ramble/server/wardrobe.js";
import { flockState } from "../bundles/ramble/server/flock.js";
import { activeBird } from "../bundles/ramble/server/eggs.js";

async function hatched(db, eggId, { species = "crow", seed = 1, active = false } = {}) {
  await db.execute({ sql: "INSERT INTO ramble_eggs (egg_id, status, warmth, species, seed, created_at, hatched_at) VALUES (?, 'hatched', 100, ?, ?, 1, 2)", args: [eggId, species, seed] });
  if (active) await db.execute({ sql: "INSERT INTO ramble_pet (owner, active_egg_id) VALUES ('self', ?) ON CONFLICT(owner) DO UPDATE SET active_egg_id = excluded.active_egg_id", args: [eggId] });
}

test("parseOutfit: only known slot/value pairs, a plain object, never throws", () => {
  assert.deepEqual(parseOutfit('{"hat":"bow","scarf":"knit","glasses":"shades"}'), { hat: "bow", scarf: "knit", glasses: "shades" });
  for (const junk of [null, undefined, "", "{", "[]", "42", '"hat"', '{"hat":"monocle"}', '{"wings":"big"}', '{"hat":7}', '{"__proto__":{"hat":"bow"}}']) {
    assert.deepEqual(parseOutfit(junk), {}, String(junk));
  }
  assert.deepEqual(parseOutfit('{"hat":"bow","glasses":"monocle"}'), { hat: "bow" }, "a future value is dropped, the rest kept");
});

test("the column exists after init and is idempotent", async () => {
  const db = await freshDb();
  await initRambleTables(db);
  const { rows } = await db.execute("PRAGMA table_info(ramble_eggs)");
  assert.ok(rows.some((r) => r.name === "outfit_json"));
});

test("wearing: owned item on a hatched bird; full row emitted; per-bird; take off restores", async () => {
  const db = await freshDb(100);
  await hatched(db, "b1", { active: true });
  await hatched(db, "b2", { seed: 2 });
  await buyItem(db, "hat.beanie", { now: NOW });
  await buyItem(db, "scarf.knit", { now: NOW });
  const emitted = [];
  const emit = async (t, op, row) => emitted.push({ t, op, row });

  let out = await wearItem(db, "b1", "hat", "hat.beanie", { emit });
  assert.deepEqual(out, { ok: true, outfit: { hat: "beanie" } });
  out = await wearItem(db, "b1", "scarf", "scarf.knit", { emit });
  assert.deepEqual(out.outfit, { hat: "beanie", scarf: "knit" });
  assert.equal(emitted.length, 2);
  assert.equal(emitted[1].t, "ramble_eggs");
  assert.equal(emitted[1].op, "update");
  assert.equal(emitted[1].row.egg_id, "b1");
  assert.equal(emitted[1].row.status, "hatched", "the FULL row rides the wire");
  assert.deepEqual(JSON.parse(emitted[1].row.outfit_json), { hat: "beanie", scarf: "knit" });

  // D11: the same item on another bird, each remembers its own.
  assert.equal((await wearItem(db, "b2", "hat", "hat.beanie", { emit })).ok, true);
  assert.deepEqual(await birdOutfit(db, "b2"), { hat: "beanie" });
  out = await wearItem(db, "b1", "hat", null, { emit });
  assert.deepEqual(out.outfit, { scarf: "knit" });
  assert.deepEqual(await birdOutfit(db, "b2"), { hat: "beanie" }, "b2 untouched");
  await wearItem(db, "b1", "scarf", null, { emit });
  const { rows } = await db.execute("SELECT outfit_json FROM ramble_eggs WHERE egg_id = 'b1'");
  assert.equal(rows[0].outfit_json, "{}", "wearing nothing is '{}' — NULL is reserved for 'sender knows nothing' (sync COALESCE)");
});

test("two overlapping wears on different slots both land (one atomic statement each)", async () => {
  const db = await freshDb(100);
  await hatched(db, "b1");
  await buyItem(db, "hat.bow", { now: NOW });
  await buyItem(db, "glasses.round", { now: NOW });
  await Promise.all([
    wearItem(db, "b1", "hat", "hat.bow", {}),
    wearItem(db, "b1", "glasses", "glasses.round", {}),
  ]);
  assert.deepEqual(await birdOutfit(db, "b1"), { hat: "bow", glasses: "round" });
});

test("wearing over a CORRUPT stored outfit starts from {} instead of failing", async () => {
  const db = await freshDb(100);
  await hatched(db, "b1");
  await buyItem(db, "hat.bow", { now: NOW });
  await db.execute("UPDATE ramble_eggs SET outfit_json = '{broken' WHERE egg_id = 'b1'");
  assert.deepEqual(await wearItem(db, "b1", "hat", "hat.bow", {}), { ok: true, outfit: { hat: "bow" } });
});

test("wearing refusals", async () => {
  const db = await freshDb(100);
  await hatched(db, "b1");
  await db.execute("INSERT INTO ramble_eggs (egg_id, status, warmth, created_at) VALUES ('e1', 'incubating', 3, 1)");
  await buyItem(db, "hat.bow", { now: NOW });
  const r = (eggId, slot, item) => wearItem(db, eggId, slot, item, {});
  assert.equal((await r("nope", "hat", "hat.bow")).reason, "not-found");
  assert.equal((await r("e1", "hat", "hat.bow")).reason, "not-a-bird");
  assert.equal((await r("b1", "wings", "hat.bow")).reason, "bad-slot");
  assert.equal((await r("b1", "__proto__", "hat.bow")).reason, "bad-slot");
  assert.equal((await r("b1", "hat", "hat.monocle")).reason, "unknown-item");
  assert.equal((await r("b1", "scarf", "hat.bow")).reason, "wrong-slot");
  assert.equal((await r("b1", "hat", "hat.leaf")).reason, "not-owned");
});

test("D10: activeBird (what public marks are authored from) never carries an outfit", async () => {
  const db = await freshDb(100);
  await hatched(db, "b1", { species: "magpie", seed: 4242, active: true });
  await buyItem(db, "glasses.shades", { now: NOW });
  await wearItem(db, "b1", "glasses", "glasses.shades", {});
  assert.deepEqual({ ...(await activeBird(db)) }, { egg_id: "b1", species: "magpie", seed: 4242 });
});

test("wardrobeState and flockState carry the outfit; a corrupt outfit_json reads as {}", async () => {
  const db = await freshDb(30);
  await hatched(db, "b1", { active: true });
  await hatched(db, "b2", { seed: 2 });
  await buyItem(db, "hat.bow", { now: NOW });
  await wearItem(db, "b1", "hat", "hat.bow", {});
  await db.execute("UPDATE ramble_eggs SET outfit_json = '{broken' WHERE egg_id = 'b2'");
  const w = await wardrobeState(db);
  assert.equal(w.seed, 30 - itemById("hat.bow").price);
  assert.equal(w.items.length, ACCESSORIES.length);
  assert.equal(w.items.find((i) => i.id === "hat.bow").owned, true);
  assert.equal(w.items.find((i) => i.id === "hat.leaf").owned, false);
  assert.deepEqual(w.active, { egg_id: "b1", species: "crow", seed: 1, outfit: { hat: "bow" } });
  const f = await flockState(db, { now: NOW });
  assert.deepEqual(f.birds.find((b) => b.egg_id === "b1").outfit, { hat: "bow" });
  assert.deepEqual(f.birds.find((b) => b.egg_id === "b2").outfit, {});
});

test("wardrobeState with no hatched bird: active is null, the shop still lists", async () => {
  const db = await freshDb(5);
  const w = await wardrobeState(db);
  assert.equal(w.active, null);
  assert.equal(w.seed, 5);
  assert.equal(w.items.length, ACCESSORIES.length);
});
