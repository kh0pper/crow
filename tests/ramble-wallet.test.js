/**
 * Spec 2026-09-08 §6.1: bird seed is a LEDGER, never a stored balance. A
 * pickup is keyed by cell and window, so re-posting the same position inside
 * one window is free and a replay from another instance collapses into the
 * same row. The balance is derived by summing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { recordSeedPickup, seedBalance, harvestWindow, readWalletSettings, SEED_KIND } from "../bundles/ramble/server/wallet.js";

async function freshDb() {
  const db = createClient({ url: "file::memory:" });
  await initRambleTables(db);
  return db;
}
const HOUR = 3600 * 1000;

test("harvestWindow: the same window inside the period, the next one after it", () => {
  assert.equal(harvestWindow(0, 24), 0);
  assert.equal(harvestWindow(23 * HOUR, 24), 0);
  assert.equal(harvestWindow(24 * HOUR, 24), 1);
  assert.equal(harvestWindow(49 * HOUR, 24), 2);
  assert.equal(harvestWindow(3 * HOUR, 1), 3, "a shorter period makes more windows");
});

test("readWalletSettings: defaults, live overrides, and junk falling back", async () => {
  const db = await freshDb();
  assert.deepEqual(await readWalletSettings(db), { respawnHours: 24, perPickup: 1 });
  await db.execute("INSERT INTO ramble_settings (key, value) VALUES ('seed.respawn.hours', '6'), ('seed.per.pickup', '3')");
  assert.deepEqual(await readWalletSettings(db), { respawnHours: 6, perPickup: 3 });
  await db.execute("UPDATE ramble_settings SET value = 'banana' WHERE key = 'seed.respawn.hours'");
  await db.execute("UPDATE ramble_settings SET value = '-4' WHERE key = 'seed.per.pickup'");
  assert.deepEqual(await readWalletSettings(db), { respawnHours: 24, perPickup: 1 }, "junk and negatives fall back");
});

test("recordSeedPickup: once per cell per window; the balance is the sum of the ledger", async () => {
  const db = await freshDb();
  assert.equal(await seedBalance(db), 0);

  assert.deepEqual(await recordSeedPickup(db, "9vk79ed", { now: 0 }), { picked: true, amount: 1 });
  assert.deepEqual(await recordSeedPickup(db, "9vk79ed", { now: HOUR }), { picked: false, amount: 0 }, "same window, already taken");
  assert.equal(await seedBalance(db), 1);

  assert.deepEqual(await recordSeedPickup(db, "9vk79ee", { now: HOUR }), { picked: true, amount: 1 }, "a different cell is its own patch");
  assert.equal(await seedBalance(db), 2);

  assert.deepEqual(await recordSeedPickup(db, "9vk79ed", { now: 25 * HOUR }), { picked: true, amount: 1 }, "it regrows next window");
  assert.equal(await seedBalance(db), 3);

  const keys = (await db.execute("SELECT kind, key FROM ramble_wallet ORDER BY key")).rows;
  assert.ok(keys.every((r) => r.kind === SEED_KIND));
  assert.deepEqual(keys.map((r) => r.key), ["9vk79ed:0", "9vk79ed:1", "9vk79ee:0"]);
});

test("recordSeedPickup EMITS on a real pickup, and never on a no-op", async () => {
  const db = await freshDb();
  const emitted = [];
  const emit = async (table, op, row) => { emitted.push({ table, op, key: row.key, delta: row.delta }); };
  await recordSeedPickup(db, "9vk79ed", { now: 0, emit });
  assert.deepEqual(emitted, [{ table: "ramble_wallet", op: "insert", key: "9vk79ed:0", delta: 1 }],
    "the outbound half exists — a registered table with no emit replicates NOTHING");
  await recordSeedPickup(db, "9vk79ed", { now: HOUR, emit });
  assert.equal(emitted.length, 1, "an already-harvested cell emits nothing");
  const boom = async () => { throw new Error("relay down"); };
  assert.equal((await recordSeedPickup(db, "9vk79ee", { now: 0, emit: boom })).picked, true,
    "a failed emit never fails the pickup");
});

test("recordSeedPickup: junk is refused without throwing, and honours seed.per.pickup", async () => {
  const db = await freshDb();
  for (const bad of ["nope", "", null, 7]) {
    assert.deepEqual(await recordSeedPickup(db, bad, { now: 0 }), { picked: false, amount: 0 }, String(bad));
  }
  assert.equal(await seedBalance(db), 0);
  await db.execute("INSERT INTO ramble_settings (key, value) VALUES ('seed.per.pickup', '5')");
  assert.deepEqual(await recordSeedPickup(db, "9vk79ed", { now: 0 }), { picked: true, amount: 5 });
  assert.equal(await seedBalance(db), 5);
  assert.deepEqual(await recordSeedPickup(null, "9vk79ed", { now: 0 }), { picked: false, amount: 0 }, "no db, no throw");
});

test("seedBalance nets spends against earns, and never throws on a bare database", async () => {
  const db = await freshDb();
  await recordSeedPickup(db, "9vk79ed", { now: 0 });
  await recordSeedPickup(db, "9vk79ee", { now: 0 });
  await db.execute({
    sql: "INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES (?, ?, ?, ?)",
    args: [SEED_KIND, "spend:hat-1", -2, 0],
  });
  assert.equal(await seedBalance(db), 0, "two earned, two spent");
  assert.equal(await seedBalance(createClient({ url: "file::memory:" })), 0, "no table, no throw");
});
