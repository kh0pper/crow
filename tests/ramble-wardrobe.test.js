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
import { ACCESSORIES, itemById, ownedItems, buyItem, earnedItemId, WEEKFULL_KIND } from "../bundles/ramble/server/wardrobe.js";
import { createRequire } from "node:module";
const Bird = createRequire(import.meta.url)("../bundles/ramble/server/bird-svg.cjs");

const NOW = 1_760_000_000_000;
/** The shop rows: everything the user can buy. An earned item is in the
 * catalogue (it is drawable and wearable) but is never one of these. */
const OFFERED = ACCESSORIES.filter((it) => it.earned !== true);
async function freshDb(seed = 0) {
  const db = createClient({ url: "file::memory:" });
  await initRambleTables(db);
  if (seed) {
    await db.execute({ sql: "INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES ('seed', 'grant:test', ?, ?)", args: [seed, NOW] });
  }
  return db;
}
/** A whole-body week, as the ledger records it: one row per ISO week id. */
async function weekfull(db, weekId) {
  await db.execute({ sql: "INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES (?, ?, 1, ?)", args: [WEEKFULL_KIND, weekId, NOW] });
}

test("the catalogue: unique ids, every slot/value is drawable, a price on what is sold and none on what is earned", () => {
  const ids = new Set();
  for (const it of ACCESSORIES) {
    assert.ok(!ids.has(it.id), `duplicate ${it.id}`); ids.add(it.id);
    assert.equal(it.id, `${it.slot}.${it.value}`);
    assert.ok(Bird.OUTFIT_SLOTS[it.slot].includes(it.value), `${it.id} has art`);
    if (it.earned === true) assert.ok(!("price" in it), `${it.id} is earned, never sold`);
    else assert.ok(Number.isInteger(it.price) && it.price > 0, `${it.id} is sold for a whole, positive price`);
    assert.ok(typeof it.name === "string" && it.name.length > 0);
  }
  for (const slot of Object.keys(Bird.OUTFIT_SLOTS)) for (const v of Bird.OUTFIT_SLOTS[slot]) {
    assert.ok(itemById(`${slot}.${v}`), `every drawable ${slot}.${v} is in the catalogue`);
  }
  assert.equal(itemById("hat.monocle"), null);
  assert.equal(itemById("__proto__"), null);
  assert.equal(OFFERED.length, ACCESSORIES.length - 5, "five kerchiefs are earned, the rest are sold");
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
  const pricey = OFFERED.find((i) => i.price > 10);
  assert.deepEqual(await buyItem(db, pricey.id, { now: NOW, emit }), { ok: false, reason: "short", balance: 10 });
  const cheap = OFFERED.find((i) => i.price <= 10);
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
  assert.equal(w.items.length, OFFERED.length);
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
  assert.equal(w.items.length, OFFERED.length);
});

/* ------------------------- the earned week kerchief ---------------------- */

test("earnedItemId: the week of the month of the ISO week's Thursday", () => {
  assert.equal(earnedItemId("2026-W46"), "scarf.kerchief2"); // Thursday 2026-11-12
  assert.equal(earnedItemId("2026-W45"), "scarf.kerchief1"); // Thursday 2026-11-05
  assert.equal(earnedItemId("2026-W44"), "scarf.kerchief5"); // Thursday 2026-10-29
  assert.equal(earnedItemId("2026-W49"), "scarf.kerchief1"); // Thursday 2026-12-03
  assert.equal(earnedItemId("2026-W53"), "scarf.kerchief5"); // Thursday 2026-12-31
  assert.equal(earnedItemId("2026-W01"), "scarf.kerchief1"); // Thursday 2026-01-01
  for (const junk of ["junk", "", "2026-W00", "2026-W54", "2026-W4", "2026W46", "26-W46", "2021-W53", null, undefined, 2026, {}, ["2026-W46"]]) {
    assert.equal(earnedItemId(junk), null, String(junk));
  }
});

test("a weekfull row grants its kerchief, and nothing else", async () => {
  const db = await freshDb(0);
  await weekfull(db, "2026-W46");
  assert.deepEqual([...await ownedItems(db)], ["scarf.kerchief2"]);
  assert.equal(await seedBalance(db), 0, "earning a kerchief is not seed");
  await weekfull(db, "not-a-week");
  assert.deepEqual([...await ownedItems(db)], ["scarf.kerchief2"], "a key that is no week grants nothing");
});

test("two weeks in different months grant two kerchiefs; the same week of the month is one item", async () => {
  const db = await freshDb(0);
  await weekfull(db, "2026-W46"); // November, week 2 (Thursday 2026-11-12)
  await weekfull(db, "2026-W44"); // October, week 5 (Thursday 2026-10-29)
  assert.deepEqual([...await ownedItems(db)].sort(), ["scarf.kerchief2", "scarf.kerchief5"]);
  await weekfull(db, "2026-W50"); // December, week 2 too (Thursday 2026-12-10)
  assert.deepEqual([...await ownedItems(db)].sort(), ["scarf.kerchief2", "scarf.kerchief5"], "one id per week of the month");
});

test("an earned item cannot be bought at any price: refused before anything is written or emitted", async () => {
  const db = await freshDb(1000);
  const emitted = [];
  const out = await buyItem(db, "scarf.kerchief1", { now: NOW, purchaseId: "e1", emit: async (...a) => emitted.push(a) });
  assert.deepEqual(out, { ok: false, reason: "earned", balance: 1000 });
  assert.deepEqual(emitted, [], "nothing emitted");
  const { rows } = await db.execute("SELECT kind, key, delta FROM ramble_wallet WHERE kind = 'spend'");
  assert.equal(rows.length, 0, "no spend row");
  assert.equal(await seedBalance(db), 1000, "the balance is untouched");
  assert.deepEqual([...await ownedItems(db)], [], "and asking for it does not grant it");
});

test("a granted kerchief can be worn; an ungranted one is refused", async () => {
  const db = await freshDb(100);
  await hatched(db, "b1");
  assert.equal((await wearItem(db, "b1", "scarf", "scarf.kerchief3", {})).reason, "not-owned");
  await weekfull(db, "2026-W46");
  assert.deepEqual(await wearItem(db, "b1", "scarf", "scarf.kerchief2", {}), { ok: true, outfit: { scarf: "kerchief2" } });
  assert.deepEqual(await birdOutfit(db, "b1"), { scarf: "kerchief2" });
});

test("wardrobeState hides an unowned kerchief and shows an owned one", async () => {
  const db = await freshDb(0);
  let w = await wardrobeState(db);
  assert.equal(w.items.some((i) => i.id === "scarf.kerchief1"), false, "not a shop row before it is earned");
  assert.equal(w.items.length, OFFERED.length);
  await weekfull(db, "2026-W45");
  w = await wardrobeState(db);
  const k = w.items.find((i) => i.id === "scarf.kerchief1");
  assert.ok(k, "listed once it is earned");
  assert.equal(k.owned, true);
  assert.equal(k.earned, true);
  assert.equal("price" in k, false);
  assert.equal(w.items.length, OFFERED.length + 1);
  assert.equal(w.items.some((i) => i.id === "scarf.kerchief2"), false, "another week's kerchief stays hidden");
});

/* ------------------------------ the drawing ------------------------------- */

const KERCHIEFS = [
  { value: "kerchief1", colour: "#f6d365", trim: "#2b2350", dots: 1 },
  { value: "kerchief2", colour: "#f2925a", trim: "#2b2350", dots: 2 },
  { value: "kerchief3", colour: "#2f9467", trim: "#fff8e6", dots: 3 },
  { value: "kerchief4", colour: "#3558bd", trim: "#fff8e6", dots: 4 },
  { value: "kerchief5", colour: "#5a2a6c", trim: "#fff8e6", dots: 5 },
];

test("the drawn kerchief: the week's own colour, its dot count, and five different drawings", () => {
  const g = Bird.rollGenome(2, "crow");
  const seen = new Set();
  for (const k of KERCHIEFS) {
    const svg = Bird.drawBird(Bird.applyOutfit(g, { scarf: k.value }));
    assert.ok(Bird.OUTFIT_SLOTS.scarf.includes(k.value), `${k.value} is a drawable scarf value`);
    assert.ok(svg.includes(`fill="${k.colour}"`), `${k.value} is drawn in its own colour`);
    assert.ok(svg.includes(`stroke="${k.trim}"`), `${k.value} carries its own trim`);
    assert.equal((svg.match(/r="2\.3"/g) || []).length, k.dots, `${k.value} counts the week of the month`);
    assert.equal(svg.indexOf(k.value), -1, "the value is compared, never written into the markup");
    assert.ok(!seen.has(svg), `${k.value} is its own drawing`);
    seen.add(svg);
  }
  assert.equal(seen.size, 5);
});

test("the bought scarves draw as before: the bird's accent stroke, the stripe dash, no week dots", () => {
  const g = Bird.rollGenome(2, "crow");
  const knit = Bird.drawBird(Bird.applyOutfit(g, { scarf: "knit" }));
  assert.ok(knit.includes(`stroke="${g.accent}" stroke-width="10"`), "the knit keeps the bird's own accent");
  assert.equal(knit.indexOf('r="2.3"'), -1, "a bought scarf carries no week dots");
  const stripe = Bird.drawBird(Bird.applyOutfit(g, { scarf: "stripe" }));
  assert.ok(stripe.includes(`stroke="${g.accent}" stroke-width="10"`));
  assert.ok(stripe.includes('stroke-dasharray="6 5"'));
  const ker = Bird.drawBird(Bird.applyOutfit(g, { scarf: "kerchief1" }));
  assert.equal((ker.match(/stroke-width="10"/g) || []).length, 1, "the kerchief replaces the scarf, it does not stack on it");
});
