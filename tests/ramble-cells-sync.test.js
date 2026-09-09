/**
 * Spec 2026-09-08 §6: ramble_cells and ramble_wallet are APPEND-ONLY facts,
 * not last-writer-wins rows. A cell unlock keeps the EARLIEST timestamp; a
 * ledger row is never overwritten and never deleted. Both replicate to the
 * user's own instances (and, per §2.4, must never reach a contact).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { applyRambleCell, applyRambleWallet } from "../servers/sharing/instance-sync.js";

async function freshDb() {
  const db = createClient({ url: "file::memory:" });
  await initRambleTables(db);
  return db;
}
const rowsOf = async (db, sql) => (await db.execute(sql)).rows;

test("initRambleTables creates ramble_cells and ramble_wallet with the right keys", async () => {
  const db = await freshDb();
  const cells = await rowsOf(db, "PRAGMA table_info(ramble_cells)");
  assert.deepEqual(cells.map((r) => r.name), ["cell", "first_unlocked_at", "lamport_ts"]);
  assert.equal(Number(cells.find((r) => r.name === "cell").pk), 1, "cell is the primary key");
  const wallet = await rowsOf(db, "PRAGMA table_info(ramble_wallet)");
  assert.deepEqual(wallet.map((r) => r.name), ["kind", "key", "delta", "created_at", "lamport_ts"]);
  assert.deepEqual(wallet.filter((r) => Number(r.pk) > 0).map((r) => r.name), ["kind", "key"]);
  await initRambleTables(db); // idempotent
  assert.equal((await rowsOf(db, "PRAGMA table_info(ramble_cells)")).length, 3);
});

test("applyRambleCell: inserts once, keeps the EARLIEST first_unlocked_at, ignores deletes", async () => {
  const db = await freshDb();
  await applyRambleCell(db, "insert", { cell: "9vk79ed", first_unlocked_at: 5000 }, 10);
  let rows = await rowsOf(db, "SELECT * FROM ramble_cells");
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].first_unlocked_at), 5000);

  // A later-arriving row with an EARLIER timestamp wins on the timestamp.
  await applyRambleCell(db, "insert", { cell: "9vk79ed", first_unlocked_at: 1000 }, 20);
  rows = await rowsOf(db, "SELECT * FROM ramble_cells");
  assert.equal(rows.length, 1, "still one row");
  assert.equal(Number(rows[0].first_unlocked_at), 1000, "earliest wins");

  // A later timestamp never pushes it forward.
  await applyRambleCell(db, "insert", { cell: "9vk79ed", first_unlocked_at: 9000 }, 30);
  assert.equal(Number((await rowsOf(db, "SELECT * FROM ramble_cells"))[0].first_unlocked_at), 1000);

  // Unlocking is permanent: a delete envelope must not remove it.
  await applyRambleCell(db, "delete", { cell: "9vk79ed" }, 40);
  assert.equal((await rowsOf(db, "SELECT * FROM ramble_cells")).length, 1, "unlocks are permanent");

  await applyRambleCell(db, "insert", { first_unlocked_at: 1 }, 50); // no cell
  await applyRambleCell(db, "insert", null, 60);
  assert.equal((await rowsOf(db, "SELECT * FROM ramble_cells")).length, 1, "junk is ignored, never thrown");
});

test("applyRambleWallet: the natural key deduplicates, a differing delta resolves to MAX, and deletes are ignored", async () => {
  const db = await freshDb();
  await applyRambleWallet(db, "insert", { kind: "seed", key: "9vk79ed:1", delta: 1, created_at: 100 }, 10);
  await applyRambleWallet(db, "insert", { kind: "seed", key: "9vk79ed:1", delta: 99, created_at: 200 }, 20);
  const rows = await rowsOf(db, "SELECT * FROM ramble_wallet");
  assert.equal(rows.length, 1, "the natural key deduplicates");
  assert.equal(Number(rows[0].delta), 99, "a disagreement resolves to the higher delta, never a silent shrink");
  assert.equal(Number(rows[0].created_at), 100, "the earlier timestamp wins");

  await applyRambleWallet(db, "delete", { kind: "seed", key: "9vk79ed:1" }, 30);
  assert.equal((await rowsOf(db, "SELECT * FROM ramble_wallet")).length, 1, "ledger rows are never deleted");

  await applyRambleWallet(db, "insert", { kind: "seed", delta: 1 }, 40); // no key
  await applyRambleWallet(db, "insert", { key: "x", delta: 1 }, 50);     // no kind
  assert.equal((await rowsOf(db, "SELECT * FROM ramble_wallet")).length, 1);
});

test("applyRambleWallet: a zero created_at is a timestamp, not a missing value", async () => {
  const db = await freshDb();
  await applyRambleWallet(db, "insert", { kind: "seed", key: "9vk79ed:0", delta: 1, created_at: 0 }, 10);
  assert.equal(Number((await rowsOf(db, "SELECT * FROM ramble_wallet"))[0].created_at), 0, "created_at: 0 must not be replaced by the wall clock");
});

test("two instances converge on the union, in either arrival order", async () => {
  const a = await freshDb();
  const b = await freshDb();
  const events = [
    ["insert", { cell: "9vk79e0", first_unlocked_at: 100 }, 1],
    ["insert", { cell: "9vk79e1", first_unlocked_at: 200 }, 2],
    ["insert", { cell: "9vk79e0", first_unlocked_at: 50 }, 3],
  ];
  for (const [op, row, ts] of events) await applyRambleCell(a, op, row, ts);
  for (const [op, row, ts] of [...events].reverse()) await applyRambleCell(b, op, row, ts);
  const read = async (db) => (await db.execute("SELECT cell, first_unlocked_at FROM ramble_cells ORDER BY cell")).rows
    .map((r) => [r.cell, Number(r.first_unlocked_at)]);
  assert.deepEqual(await read(a), await read(b), "order of arrival does not matter");
  assert.deepEqual(await read(a), [["9vk79e0", 50], ["9vk79e1", 200]]);
});

test("applyRambleWallet: two instances converge on the same delta and created_at, in either arrival order", async () => {
  const a = await freshDb();
  const b = await freshDb();
  const events = [
    ["insert", { kind: "seed", key: "9vk79ed", delta: 5, created_at: 1000 }, 1],
    ["insert", { kind: "seed", key: "9vk79ed", delta: 1, created_at: 2000 }, 2],
  ];
  for (const [op, row, ts] of events) await applyRambleWallet(a, op, row, ts);
  for (const [op, row, ts] of [...events].reverse()) await applyRambleWallet(b, op, row, ts);
  const read = async (db) => (await db.execute("SELECT delta, created_at FROM ramble_wallet WHERE kind = 'seed' AND key = '9vk79ed'")).rows
    .map((r) => [Number(r.delta), Number(r.created_at)]);
  assert.deepEqual(await read(a), await read(b), "order of arrival must not leave two instances with different balances");
  assert.deepEqual(await read(a), [[5, 1000]], "the disagreement resolves to the higher delta and the earlier timestamp");
});

test("applyRambleWallet: an identical replay leaves the row untouched", async () => {
  const db = await freshDb();
  const row = { kind: "seed", key: "9vk79ed:1", delta: 3, created_at: 500 };
  for (let i = 0; i < 3; i += 1) await applyRambleWallet(db, "insert", row, 7);
  const rows = await rowsOf(db, "SELECT * FROM ramble_wallet");
  // MAX/MIN make this true algebraically, but a retried delivery inflating a
  // BALANCE is the failure nobody would notice, so assert it rather than imply it.
  assert.equal(rows.length, 1, "a retried delivery must never add a second ledger row");
  assert.equal(Number(rows[0].delta), 3, "and must never inflate the amount");
  assert.equal(Number(rows[0].created_at), 500, "nor move the timestamp");
});

test("applyRambleCell: an identical replay leaves the row untouched", async () => {
  const db = await freshDb();
  const row = { cell: "9vk79ed", first_unlocked_at: 500 };
  for (let i = 0; i < 3; i += 1) await applyRambleCell(db, "insert", row, 7);
  const rows = await rowsOf(db, "SELECT * FROM ramble_cells");
  assert.equal(rows.length, 1, "a retried delivery must never duplicate an unlock");
  assert.equal(Number(rows[0].first_unlocked_at), 500);
});
