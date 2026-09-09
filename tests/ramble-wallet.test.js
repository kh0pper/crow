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
import { cellBox } from "../bundles/ramble/server/zones.js";
import { recordSeedPickup, seedBalance, harvestWindow, readWalletSettings, harvestableCells, seedFor, SEED_KIND } from "../bundles/ramble/server/wallet.js";

async function freshDb() {
  const db = createClient({ url: "file::memory:" });
  await initRambleTables(db);
  return db;
}

/**
 * Seed is SPARSE by design — one cell in `seed.rate` bears any. A ledger test
 * that just picks a cell would then pass or fail on the spawn lottery rather
 * than on the ledger, so these tests pin rate 1 (every cell bears seed) and
 * leave the lottery itself to the seedFor tests below.
 */
async function everyCellBears(db) {
  await db.execute("INSERT INTO ramble_settings (key, value) VALUES ('seed.rate', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value");
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
  assert.deepEqual(await readWalletSettings(db), { respawnHours: 24, perPickup: 1, rate: 4 });
  await db.execute("INSERT INTO ramble_settings (key, value) VALUES ('seed.respawn.hours', '6'), ('seed.per.pickup', '3'), ('seed.rate', '2')");
  assert.deepEqual(await readWalletSettings(db), { respawnHours: 6, perPickup: 3, rate: 2 });
  await db.execute("UPDATE ramble_settings SET value = 'banana' WHERE key = 'seed.respawn.hours'");
  await db.execute("UPDATE ramble_settings SET value = '-4' WHERE key = 'seed.per.pickup'");
  await db.execute("UPDATE ramble_settings SET value = '0' WHERE key = 'seed.rate'");
  assert.deepEqual(await readWalletSettings(db), { respawnHours: 24, perPickup: 1, rate: 4 },
    "junk, negatives and a zero rate all fall back — rate 0 would divide the lottery by nothing");
});

test("recordSeedPickup: once per cell per window; the balance is the sum of the ledger", async () => {
  const db = await everyCellBears(await freshDb());
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
  const db = await everyCellBears(await freshDb());
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
  const db = await everyCellBears(await freshDb());
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
  const db = await everyCellBears(await freshDb());
  await recordSeedPickup(db, "9vk79ed", { now: 0 });
  await recordSeedPickup(db, "9vk79ee", { now: 0 });
  await db.execute({
    sql: "INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES (?, ?, ?, ?)",
    args: [SEED_KIND, "spend:hat-1", -2, 0],
  });
  assert.equal(await seedBalance(db), 0, "two earned, two spent");
  assert.equal(await seedBalance(createClient({ url: "file::memory:" })), 0, "no table, no throw");
});

test("harvestableCells: reports the cells whose seed has regrown, so the map can show pips", async () => {
  const db = await everyCellBears(await freshDb());
  const A = "9vk79e9", B = "9vk79ed", C = "9vk79e2";
  const now = 100 * 24 * HOUR;

  // Returns POINTS now, not cell names — the pip sits where the seed is.
  const cellsOf = async (t) => (await harvestableCells(db, [A, B, C], { now: t })).map((p) => p.cell).sort();

  assert.deepEqual(await cellsOf(now), [A, B, C].sort(), "nothing harvested yet, so every cell is offering");

  const spot = (await harvestableCells(db, [A], { now }))[0];
  assert.ok(Number.isFinite(spot.lat) && Number.isFinite(spot.lon), "each offering carries a real position");
  const box = cellBox(A);
  assert.ok(spot.lat > box.south && spot.lat < box.north && spot.lon > box.west && spot.lon < box.east,
    "and that position is strictly INSIDE its own cell");

  await recordSeedPickup(db, A, { now });
  assert.deepEqual(await cellsOf(now), [B, C].sort(), "the harvested cell stops offering inside its window");

  // The NEXT window regrows it — the property the whole pip is advertising.
  assert.deepEqual(await cellsOf(now + 24 * HOUR), [A, B, C].sort(), "seed regrows in the next window");
});

test("harvestableCells: matches on the window, not merely on the cell name", async () => {
  const db = await everyCellBears(await freshDb());
  const cell = "9vk79e9";
  const now = 100 * 24 * HOUR;
  // A row from a DIFFERENT window must not suppress today's pip. A naive
  // "does any row mention this cell" check would get this wrong.
  await recordSeedPickup(db, cell, { now: now - 24 * HOUR });
  assert.deepEqual((await harvestableCells(db, [cell], { now })).map((p) => p.cell), [cell]);
});

test("harvestableCells: junk in, empty out, and never a throw", async () => {
  const db = await everyCellBears(await freshDb());
  assert.deepEqual(await harvestableCells(db, [], { now: 0 }), []);
  assert.deepEqual(await harvestableCells(db, null, { now: 0 }), []);
  assert.deepEqual(await harvestableCells(db, ["nope", 7, null, ""], { now: 0 }), [],
    "a malformed cell is filtered before it can reach SQL");
  assert.deepEqual(await harvestableCells(null, ["9vk79e9"], { now: 0 }), [], "no db is not a crash");
  // now: 0 is a real timestamp, not a missing one — the same trap the ledger
  // guards elsewhere in this file.
  assert.deepEqual((await harvestableCells(db, ["9vk79e9"], { now: 0 })).map((p) => p.cell), ["9vk79e9"]);
});

test("seedFor: sparse, deterministic, and placed inside its own cell", () => {
  // Deterministic: the same cell and window must answer identically forever and
  // on every device, or two Crows would disagree about where seed is and a
  // player could re-roll a cell by walking out and back.
  const a = seedFor("9vk79e9", 20705, { rate: 1 });
  const b = seedFor("9vk79e9", 20705, { rate: 1 });
  assert.deepEqual(a, b, "same cell, same window, same answer");

  const box = cellBox("9vk79e9");
  assert.ok(a.lat > box.south && a.lat < box.north && a.lon > box.west && a.lon < box.east,
    "the seed sits strictly inside its cell, not on the boundary");

  // Not the cell CENTRE — a street's worth of seed centred in every cell reads
  // as a pegboard rather than as something scattered.
  const mid = { lat: (box.south + box.north) / 2, lon: (box.west + box.east) / 2 };
  assert.ok(a.lat !== mid.lat || a.lon !== mid.lon, "and is offset within it");

  // The window is part of the hash, so the same cell moves day to day.
  assert.notDeepEqual(seedFor("9vk79e9", 20706, { rate: 1 }), a, "a new window is a new roll");

  // Sparse: rate 1 means every cell bears seed; a real rate means most do not.
  const cells = [];
  for (const c of ["9vk79e0", "9vk79e1", "9vk79e2", "9vk79e3", "9vk79e4", "9vk79e5",
                   "9vk79e6", "9vk79e7", "9vk79e8", "9vk79e9", "9vk79eb", "9vk79ec",
                   "9vk79ed", "9vk79ee", "9vk79ef", "9vk79eg"]) cells.push(c);
  assert.equal(cells.filter((c) => seedFor(c, 20705, { rate: 1 })).length, cells.length,
    "rate 1 is the every-cell case the ledger tests rely on");
  const bearing = cells.filter((c) => seedFor(c, 20705, { rate: 4 })).length;
  assert.ok(bearing > 0 && bearing < cells.length,
    "rate 4 leaves some cells bearing and most not (" + bearing + " of " + cells.length + ")");

  // Junk must not throw — this runs on every zones fetch.
  assert.equal(seedFor("nope", 20705), null);
  assert.equal(seedFor(null, 20705), null);
  assert.equal(seedFor("9vk79e9", "banana"), null);
  assert.ok(seedFor("9vk79e9", 20705, { rate: 0 }) !== undefined, "a zero rate falls back rather than dividing by nothing");
});

test("a cell that bears no seed pays nothing, so the map never promises what it cannot give", async () => {
  const db = await freshDb();   // real rate, NOT the every-cell fixture
  const now = 100 * 24 * HOUR;
  const { rate } = await readWalletSettings(db);
  const window = harvestWindow(now, 24);

  const barren = ["9vk79e0", "9vk79e1", "9vk79e2", "9vk79e3", "9vk79e4", "9vk79e5",
    "9vk79e6", "9vk79e7", "9vk79e8", "9vk79e9"].find((c) => !seedFor(c, window, { rate }));
  assert.ok(barren, "the fixture needs at least one cell the lottery skipped");

  const got = await recordSeedPickup(db, barren, { now });
  assert.equal(got.picked, false, "walking a barren cell earns nothing");
  assert.equal(await seedBalance(db), 0);
  assert.deepEqual(await harvestableCells(db, [barren], { now }), [],
    "and the map shows no pip there — the harvest and the pip read the SAME rule");
});
