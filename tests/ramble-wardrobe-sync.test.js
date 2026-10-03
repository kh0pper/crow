/**
 * Spec 2026-09-08 §8: anything that replicates gets an executable,
 * MULTI-INSTANCE test. Two in-memory dbs stand in for two of the user's
 * instances; each instance's emits are captured and applied to the other.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { applyRambleWallet, applyRambleEgg } from "../servers/sharing/instance-sync.js";
import { seedBalance } from "../bundles/ramble/server/wallet.js";
import { buyItem, wearItem, ownedItems, birdOutfit, itemById } from "../bundles/ramble/server/wardrobe.js";

const NOW = 1_760_000_000_000;
async function instance(seed) {
  const db = createClient({ url: "file::memory:" });
  await initRambleTables(db);
  // The SAME earn on both sides, as if it had already synced.
  await db.execute({ sql: "INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES ('seed', 'c:1', ?, ?)", args: [seed, NOW] });
  const ops = [];
  return { db, ops, emit: async (table, op, row) => ops.push({ table, op, row }) };
}
let lamport = 100;
async function deliver(ops, to) {
  for (const { table, op, row } of ops) {
    if (table === "ramble_wallet") await applyRambleWallet(to, op, row, ++lamport);
    else if (table === "ramble_eggs") await applyRambleEgg(to, op, row, ++lamport, "peer");
  }
}

test("a purchase on A reaches B: same balance, same wardrobe", async () => {
  const A = await instance(40), B = await instance(40);
  await buyItem(A.db, "hat.beanie", { now: NOW, emit: A.emit });
  await deliver(A.ops, B.db);
  assert.equal(await seedBalance(B.db), 40 - itemById("hat.beanie").price);
  assert.deepEqual([...await ownedItems(B.db)], ["hat.beanie"]);
});

test("offline on both: different items, any arrival order, identical result (possibly negative)", async () => {
  for (const order of ["AB", "BA"]) {
    const A = await instance(20), B = await instance(20);
    assert.equal((await buyItem(A.db, "scarf.knit", { now: NOW, emit: A.emit })).ok, true);   // 15
    assert.equal((await buyItem(B.db, "glasses.round", { now: NOW, emit: B.emit })).ok, true); // 20
    if (order === "AB") { await deliver(A.ops, B.db); await deliver(B.ops, A.db); }
    else { await deliver(B.ops, A.db); await deliver(A.ops, B.db); }
    const want = 20 - 15 - 20;
    assert.equal(await seedBalance(A.db), want, order);
    assert.equal(await seedBalance(B.db), want, order);
    assert.deepEqual([...await ownedItems(A.db)].sort(), ["glasses.round", "scarf.knit"]);
    assert.deepEqual([...await ownedItems(B.db)].sort(), ["glasses.round", "scarf.knit"]);
    assert.equal((await buyItem(A.db, "hat.bow", { now: NOW })).reason, "short", "a negative balance buys nothing");
  }
});

test("offline on both: the SAME item — owned once, charged twice, both sides agree (accepted, documented)", async () => {
  const A = await instance(30), B = await instance(30);
  await buyItem(A.db, "hat.bow", { now: NOW, emit: A.emit });
  await buyItem(B.db, "hat.bow", { now: NOW, emit: B.emit });
  await deliver(A.ops, B.db); await deliver(B.ops, A.db);
  assert.equal(await seedBalance(A.db), 30 - 16);
  assert.equal(await seedBalance(B.db), 30 - 16);
  assert.deepEqual([...await ownedItems(A.db)], ["hat.bow"]);
});

test("re-delivering the same spend is idempotent (replay cannot inflate or deflate)", async () => {
  const A = await instance(30), B = await instance(30);
  await buyItem(A.db, "hat.bow", { now: NOW, emit: A.emit });
  await deliver(A.ops, B.db); await deliver(A.ops, B.db);
  assert.equal(await seedBalance(B.db), 22);
});

test("an outfit change on A reaches B's copy of the bird", async () => {
  const A = await instance(50), B = await instance(50);
  for (const { db } of [A, B]) {
    await db.execute("INSERT INTO ramble_eggs (egg_id, status, warmth, species, seed, created_at, hatched_at) VALUES ('b1', 'hatched', 100, 'crow', 1, 1, 2)");
  }
  await buyItem(A.db, "glasses.shades", { now: NOW, emit: A.emit });
  await wearItem(A.db, "b1", "glasses", "glasses.shades", { emit: A.emit });
  await deliver(A.ops, B.db);
  assert.deepEqual(await birdOutfit(B.db, "b1"), { glasses: "shades" });
  // Taking it off travels too (the row carries outfit_json: '{}').
  A.ops.length = 0;
  await wearItem(A.db, "b1", "glasses", null, { emit: A.emit });
  await deliver(A.ops, B.db);
  assert.deepEqual(await birdOutfit(B.db, "b1"), {});
  const { rows } = await B.db.execute("SELECT status, species, seed FROM ramble_eggs WHERE egg_id = 'b1'");
  assert.deepEqual({ ...rows[0] }, { status: "hatched", species: "crow", seed: 1 }, "the bird itself is untouched");
});

test("an outfit row reaching an instance whose ramble_eggs predates the column applies, column and all", async () => {
  const old = createClient({ url: "file::memory:" });
  await old.execute(`CREATE TABLE ramble_eggs (
    egg_id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'shelf', warmth INTEGER NOT NULL DEFAULT 0,
    species TEXT, seed INTEGER, found_cell TEXT, found_week TEXT, from_crow_id TEXT,
    created_at INTEGER NOT NULL, hatched_at INTEGER, lamport_ts INTEGER DEFAULT 0, shelf_origin TEXT, lamport_origin TEXT)`);
  await applyRambleEgg(old, "update", {
    egg_id: "b1", status: "hatched", warmth: 100, species: "crow", seed: 1, found_cell: null, found_week: null,
    from_crow_id: null, created_at: 1, hatched_at: 2, shelf_origin: null, outfit_json: '{"hat":"leaf"}',
  }, 500, "peer");
  const { rows } = await old.execute("SELECT outfit_json FROM ramble_eggs WHERE egg_id = 'b1'");
  assert.equal(rows[0].outfit_json, '{"hat":"leaf"}');
});

test("a STALE full row at a higher lamport (outfit_json NULL) cannot wipe a worn outfit", async () => {
  const A = await instance(50), B = await instance(50);
  await A.db.execute("INSERT INTO ramble_eggs (egg_id, status, warmth, species, seed, created_at, hatched_at) VALUES ('b1', 'hatched', 100, 'crow', 1, 1, 2)");
  // B never saw the hatch: it still holds b1 as incubating and keeps crediting warmth.
  await B.db.execute("INSERT INTO ramble_eggs (egg_id, status, warmth, created_at) VALUES ('b1', 'incubating', 40, 1)");
  await buyItem(A.db, "hat.leaf", { now: NOW, emit: A.emit });
  await wearItem(A.db, "b1", "hat", "hat.leaf", { emit: A.emit });
  const { rows } = await B.db.execute("SELECT * FROM ramble_eggs WHERE egg_id = 'b1'");
  const staleRow = { ...rows[0], warmth: 45 };
  delete staleRow.lamport_ts; delete staleRow.lamport_origin;
  assert.equal(staleRow.outfit_json, null, "the stale sender genuinely knows no outfit");
  await applyRambleEgg(A.db, "update", staleRow, 1_000_000, "peer-b");
  assert.deepEqual(await birdOutfit(A.db, "b1"), { hat: "leaf" }, "the outfit survives");
  const { rows: after } = await A.db.execute("SELECT status FROM ramble_eggs WHERE egg_id = 'b1'");
  assert.equal(after[0].status, "hatched");
});

test("a sparse egg row with no outfit_json key leaves a worn outfit alone", async () => {
  const B = await instance(0);
  await B.db.execute(`INSERT INTO ramble_eggs (egg_id, status, warmth, species, seed, created_at, hatched_at, outfit_json)
                      VALUES ('b1', 'hatched', 100, 'crow', 1, 1, 2, '{"hat":"bow"}')`);
  await applyRambleEgg(B.db, "update", { egg_id: "b1", status: "hatched", warmth: 100, created_at: 1 }, 900, "peer");
  assert.deepEqual(await birdOutfit(B.db, "b1"), { hat: "bow" });
});
