/**
 * Spec 2026-09-08 §6.1, §8 — the heart ledger.
 *
 * Hearts are append-only rows in ramble_wallet under kind 'heart'. There is no
 * heart TABLE and no stored balance: the count and the maximum energy derived
 * from it are both read out of the ledger, which is what makes them converge
 * across the user's own instances for free.
 *
 * ⚠ rate 1 throughout, so every cell in a fixture holds a heart and no test
 * depends on a cell that happens to hash lucky (the phase 1 lesson).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { applyRambleWallet } from "../servers/sharing/instance-sync.js";
import {
  HEART_KIND, heartCandidates, wildWindow,
  recordHeartPickup, availableHearts, heartsBalance, maxEnergy,
} from "../bundles/ramble/server/hearts.js";

const NOW = 1_757_000_000_000;
// Six real, distinct geohash-7 cells, checked with decodeGeohash while this
// was written: Houston, Texas hill country, New York, London, Berlin, Hong
// Kong. At rate 1 every one of them holds a heart, so this fixture is exactly
// what it looks like — no cell here was chosen for hashing lucky.
const CELLS = ["9vk79ed", "9v6m2xt", "dr5regw", "gcpvj0d", "u33dc0e", "wecnrmd"];

// `per` and `cap` are used by the energy tests below; `rate`/`wildRate` are
// pinned per-test so no test depends on a cell that happens to hash lucky.
async function freshDb({ rate = 1, wildRate = 999999, base, per, cap } = {}) {
  const db = createClient({ url: "file::memory:" });
  await initRambleTables(db);
  const put = (k, v) => db.execute({
    sql: "INSERT INTO ramble_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    args: [k, String(v)],
  });
  await put("heart.rate", rate);
  await put("heart.wild.rate", wildRate);
  if (base != null) await put("energy.max.base", base);
  if (per != null) await put("energy.max.per.heart", per);
  if (cap != null) await put("energy.max.cap", cap);
  return db;
}

async function unlock(db, cells, at = NOW) {
  for (const c of cells) {
    await db.execute({
      sql: "INSERT INTO ramble_cells (cell, first_unlocked_at) VALUES (?, ?) ON CONFLICT(cell) DO NOTHING",
      args: [c, at],
    });
  }
}

const walletRows = async (db) =>
  (await db.execute({ sql: "SELECT * FROM ramble_wallet WHERE kind = ? ORDER BY key", args: [HEART_KIND] })).rows;

test("a heart is NEVER granted in a cell that is not unlocked — fail closed", async () => {
  const db = await freshDb();
  const out = await recordHeartPickup(db, CELLS[0], { now: NOW });
  assert.deepEqual(out, { picked: false, amount: 0 });
  assert.equal((await walletRows(db)).length, 0, "no row, so no heart");
  assert.equal(await heartsBalance(db), 0);
});

test("the first pickup writes exactly one row with delta 1, and emits it", async () => {
  const db = await freshDb();
  await unlock(db, [CELLS[0]]);
  const seen = [];
  const emit = (table, op, row) => { seen.push({ table, op, row }); };

  const out = await recordHeartPickup(db, CELLS[0], { now: NOW, emit });
  assert.deepEqual(out, { picked: true, amount: 1, source: "first" });

  const rows = await walletRows(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, CELLS[0], "a first heart is keyed by the bare cell");
  assert.equal(Number(rows[0].delta), 1, "delta is a COUNT of containers, never an energy amount");
  assert.equal(Number(rows[0].created_at), NOW);

  assert.equal(seen.length, 1, "the outbound half: without this the ledger syncs one way only");
  assert.equal(seen[0].table, "ramble_wallet");
  assert.equal(seen[0].op, "insert");
  assert.equal(seen[0].row.kind, HEART_KIND);
  assert.equal(seen[0].row.delta, 1);
});

test("the permanent heart is gone for good — a second visit pays nothing, ever", async () => {
  const db = await freshDb();
  await unlock(db, [CELLS[0]]);
  await recordHeartPickup(db, CELLS[0], { now: NOW });

  assert.deepEqual(await recordHeartPickup(db, CELLS[0], { now: NOW }), { picked: false, amount: 0 });
  const muchLater = NOW + 400 * 24 * 3600 * 1000;
  assert.deepEqual(heartCandidates(CELLS[0], wildWindow(muchLater, 30), { rate: 1, wildRate: 999999 })
    .map((c) => c.source), ["first"], "precondition: the wild source is silent, even 400 days out");
  assert.deepEqual(await recordHeartPickup(db, CELLS[0], { now: muchLater }), { picked: false, amount: 0 });
  assert.equal((await walletRows(db)).length, 1);
});

test("a wild heart regrows: once per window, again in the next", async () => {
  // No first hearts at all, so every hit here is unambiguously a wild one.
  const db = await freshDb({ rate: 999999, wildRate: 1 });
  await unlock(db, [CELLS[0]]);
  const day = 24 * 3600 * 1000;
  // Asserted, not assumed: a surprise first heart at this rate would otherwise
  // fail below as a baffling "source" mismatch.
  assert.deepEqual(heartCandidates(CELLS[0], wildWindow(NOW, 30), { rate: 999999, wildRate: 999999 }), [],
    "precondition: neither source hits at these rates");

  const first = await recordHeartPickup(db, CELLS[0], { now: NOW });
  assert.deepEqual(first, { picked: true, amount: 1, source: "wild" });
  assert.deepEqual(await recordHeartPickup(db, CELLS[0], { now: NOW + day }), { picked: false, amount: 0 },
    "still the same 30-day window");

  const next = await recordHeartPickup(db, CELLS[0], { now: NOW + 31 * day });
  assert.deepEqual(next, { picked: true, amount: 1, source: "wild" });

  const rows = await walletRows(db);
  assert.equal(rows.length, 2);
  for (const r of rows) assert.match(String(r.key), /^[0-9b-hjkmnp-z]{7}:\d+$/, "wild keys carry their window");
});

test("THE SAME RULE: what the map draws is exactly what a walk would grant", async () => {
  // The phase 1 defect, made executable. A heart shown but not granted (or
  // granted but never shown) is the bug that shipped in the seed layer.
  const db = await freshDb();
  await unlock(db, CELLS);

  const drawn = await availableHearts(db, CELLS, { now: NOW });
  assert.equal(drawn.length, CELLS.length, "rate 1: every unlocked cell in the fixture");
  for (const spot of drawn) {
    assert.deepEqual(spot, heartCandidates(spot.cell, wildWindow(NOW, 30), { rate: 1, wildRate: 999999 })[0],
      "the map draws the candidate itself, not a re-derived guess");
  }

  // Take three of them, then assert the two readers STILL agree.
  const taken = CELLS.slice(0, 3);
  for (const c of taken) {
    assert.equal((await recordHeartPickup(db, c, { now: NOW })).picked, true);
  }
  const after = await availableHearts(db, CELLS, { now: NOW });
  assert.deepEqual(after.map((s) => s.cell).sort(), CELLS.slice(3).sort(),
    "a collected heart leaves the map");
  for (const c of taken) {
    assert.equal((await recordHeartPickup(db, c, { now: NOW })).picked, false,
      "and a cell the map no longer draws grants nothing");
  }
  for (const c of CELLS.slice(3)) {
    assert.equal((await recordHeartPickup(db, c, { now: NOW })).picked, true,
      "while every cell the map still draws does grant");
  }
});

test("availableHearts never leaves unlocked ground, and never throws on junk", async () => {
  const db = await freshDb();
  await unlock(db, [CELLS[0]]);
  const asked = [CELLS[0], CELLS[1], "not-a-cell", "", null, 7];
  const drawn = await availableHearts(db, asked, { now: NOW });
  assert.deepEqual(drawn.map((s) => s.cell), [CELLS[0]],
    "a cell the caller has not unlocked is not drawn even when it is asked for");
  assert.deepEqual(await availableHearts(db, [], { now: NOW }), []);
  assert.deepEqual(await availableHearts(db, null, { now: NOW }), []);
});

test("heartsBalance counts containers; maxEnergy derives the bar and honours the cap", async () => {
  const db = await freshDb({ rate: 1, base: 100, per: 10, cap: 130 });
  assert.equal(await heartsBalance(db), 0);
  assert.equal(await maxEnergy(db), 100, "no hearts: the base");

  await unlock(db, CELLS);
  for (const c of CELLS.slice(0, 2)) await recordHeartPickup(db, c, { now: NOW });
  assert.equal(await heartsBalance(db), 2);
  assert.equal(await maxEnergy(db), 120, "base + hearts x per-heart");

  for (const c of CELLS.slice(2)) await recordHeartPickup(db, c, { now: NOW });
  assert.equal(await heartsBalance(db), 6);
  assert.equal(await maxEnergy(db), 130, "the cap holds");
});

test("seed rows are not hearts and hearts are not seed", async () => {
  const db = await freshDb();
  await unlock(db, [CELLS[0]]);
  await db.execute({
    sql: "INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES ('seed', ?, 5, ?)",
    args: [CELLS[0] + ":1", NOW],
  });
  await recordHeartPickup(db, CELLS[0], { now: NOW });
  assert.equal(await heartsBalance(db), 1, "the seed pile does not inflate the heart count");
});

test("a cell grows a WILD heart after its permanent one is taken", async () => {
  // ⚠ The defect the plan review caught. An `a || b` candidate keeps returning
  // the taken permanent heart and never reaches the wild source, so at the
  // default rate one cell in three would be sterile forever. Both sources hit
  // here (rate 1, wildRate 1), which is the only configuration that can tell
  // the two implementations apart — every other test in this file silences one
  // source to isolate the other, and that is exactly how this hid.
  const db = await freshDb({ rate: 1, wildRate: 1 });
  await unlock(db, [CELLS[0]]);

  const first = await recordHeartPickup(db, CELLS[0], { now: NOW });
  assert.deepEqual(first, { picked: true, amount: 1, source: "first" });

  const wild = await recordHeartPickup(db, CELLS[0], { now: NOW });
  assert.deepEqual(wild, { picked: true, amount: 1, source: "wild" },
    "the wild heart in the same window is still there to take");

  assert.deepEqual(await recordHeartPickup(db, CELLS[0], { now: NOW }), { picked: false, amount: 0 },
    "and now the cell really is empty for this window");

  const day = 24 * 3600 * 1000;
  const nextWindow = await recordHeartPickup(db, CELLS[0], { now: NOW + 31 * day });
  assert.deepEqual(nextWindow, { picked: true, amount: 1, source: "wild" },
    "next window, the wild heart comes round again — as the doc comment promises");

  // And the map agrees at every step, which is the whole point.
  assert.deepEqual(await availableHearts(db, [CELLS[0]], { now: NOW }), []);
  assert.equal((await availableHearts(db, [CELLS[0]], { now: NOW + 62 * day })).length, 1);
});

test("a heart row is worth ONE container even when a heart is worth 25 energy", async () => {
  // The assertion that would actually fail if someone later stored energy in
  // the row. Asserting that MAX(delta) of two identical 1s is 1 proves nothing.
  const db = await freshDb({ rate: 1, per: 25 });
  await unlock(db, [CELLS[0]]);
  await recordHeartPickup(db, CELLS[0], { now: NOW });
  const rows = await walletRows(db);
  assert.equal(Number(rows[0].delta), 1, "delta is a COUNT; the energy per heart lives in a setting");
  assert.equal(await heartsBalance(db), 1);
  assert.equal(await maxEnergy(db), 125, "and the setting is what values it");
});

test("two instances converge on the same heart count whatever order rows arrive in", async () => {
  // Spec §8: anything that replicates needs a multi-instance test, not a
  // single-database one. delta is a constant 1, so MAX(delta) — which phase 1
  // had to fix for seed — is safe here BY CONSTRUCTION. This test is what says
  // so out loud.
  const rows = [
    { kind: HEART_KIND, key: CELLS[0], delta: 1, created_at: NOW },
    { kind: HEART_KIND, key: CELLS[1], delta: 1, created_at: NOW + 10 },
    { kind: HEART_KIND, key: CELLS[2] + ":610", delta: 1, created_at: NOW + 20 },
  ];
  const a = await freshDb();
  const b = await freshDb();
  for (let i = 0; i < rows.length; i++) await applyRambleWallet(a, "insert", rows[i], 10 + i);
  for (let i = rows.length - 1; i >= 0; i--) await applyRambleWallet(b, "insert", rows[i], 10 + i);
  // And a duplicate arriving late on both.
  await applyRambleWallet(a, "insert", rows[0], 99);
  await applyRambleWallet(b, "insert", rows[0], 99);

  assert.equal(await heartsBalance(a), 3);
  assert.equal(await heartsBalance(b), 3);
  assert.equal(await maxEnergy(a), await maxEnergy(b));
  for (const r of await walletRows(a)) assert.equal(Number(r.delta), 1, "no row ever grew");
});
