/**
 * Spec 2026-09-08 §4.3 — the laying floor.
 *
 * The count accrues ONLY while the user has no eggs at all. Were it always
 * accruing, a player would run dry and lay almost immediately, undercutting
 * nests as the real supply.
 *
 * Rows live in ramble_wallet with delta ALWAYS the literal 1: applyRambleWallet
 * resolves conflicts with MAX(delta), which is only convergent when the value
 * cannot differ between instances for the same key.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import {
  mintIncubatingEgg, getIncubatingEgg, recordHappyDay, layProgress,
  hasAnyEggAnywhere, readLaySettings, LAY_DAYS_DEFAULT, localDay,
} from "../bundles/ramble/server/eggs.js";
import { applyRambleWallet } from "../servers/sharing/instance-sync.js";

const DAY = 86400000;
const T0 = Date.UTC(2026, 8, 9, 12, 0, 0);

async function freshDb() {
  const db = createClient({ url: ":memory:" });
  await initRambleTables(db);
  return db;
}
async function eggCount(db) {
  const { rows } = await db.execute({ sql: "SELECT count(*) AS n FROM ramble_eggs", args: [] });
  return Number(rows[0].n);
}
async function setLayDays(db, n) {
  await db.execute({ sql: "INSERT INTO ramble_settings (key, value) VALUES ('lay.days', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", args: [String(n)] });
}

test("the default is the spec's 14", async () => {
  const db = await freshDb();
  assert.equal(LAY_DAYS_DEFAULT, 14);
  assert.deepEqual(await readLaySettings(db), { layDays: 14 });
  await setLayDays(db, 10);
  assert.deepEqual(await readLaySettings(db), { layDays: 10 });
  await setLayDays(db, 0);
  assert.deepEqual(await readLaySettings(db), { layDays: 14 }, "a junk setting falls back");
});

test("hasAnyEggAnywhere counts eggs, not birds", async () => {
  const db = await freshDb();
  assert.equal(await hasAnyEggAnywhere(db), false);
  await mintIncubatingEgg(db, { now: T0 });
  assert.equal(await hasAnyEggAnywhere(db), true);

  const db2 = await freshDb();
  await db2.execute({
    sql: `INSERT INTO ramble_eggs (egg_id, status, species, seed, warmth, created_at, hatched_at)
          VALUES ('bird', 'hatched', 'wren', 7, 100, ?, ?)`, args: [T0, T0],
  });
  assert.equal(await hasAnyEggAnywhere(db2), false, "a hatched bird is not an egg you are warming");
});

test("a happy day accrues ONLY while eggless, and only once per local day", async () => {
  const db = await freshDb();
  const first = await recordHappyDay(db, { now: T0, mood: "happy" });
  assert.equal(first.recorded, true);
  assert.equal((await layProgress(db)).days, 1);

  const again = await recordHappyDay(db, { now: T0 + 3600000, mood: "happy" });
  assert.equal(again.recorded, false, "same local day");
  assert.equal((await layProgress(db)).days, 1);

  await recordHappyDay(db, { now: T0 + DAY, mood: "tired" });
  assert.equal((await layProgress(db)).days, 1, "a tired day does not count");

  await mintIncubatingEgg(db, { now: T0 + 2 * DAY });
  await recordHappyDay(db, { now: T0 + 2 * DAY, mood: "happy" });
  assert.equal((await layProgress(db)).days, 1, "with an egg in hand, nothing accrues");
});

test("days need NOT be consecutive", async () => {
  const db = await freshDb();
  await setLayDays(db, 3);
  await recordHappyDay(db, { now: T0, mood: "happy" });
  await recordHappyDay(db, { now: T0 + DAY, mood: "alarmed" });
  await recordHappyDay(db, { now: T0 + 5 * DAY, mood: "happy" });
  assert.equal((await layProgress(db)).days, 2, "one bad day did not erase the streak");
  assert.equal(await eggCount(db), 0);
});

test("at the threshold the bird lays, and the count resets", async () => {
  const db = await freshDb();
  await setLayDays(db, 3);
  await recordHappyDay(db, { now: T0, mood: "happy" });
  await recordHappyDay(db, { now: T0 + DAY, mood: "happy" });
  assert.equal(await eggCount(db), 0, "not yet");

  const out = await recordHappyDay(db, { now: T0 + 2 * DAY, mood: "happy" });
  assert.equal(out.laid, true);
  assert.equal(await eggCount(db), 1);
  const egg = await getIncubatingEgg(db);
  assert.ok(egg, "the laid egg goes straight into the empty slot");
  assert.equal(egg.warmth, 0);

  assert.equal((await layProgress(db)).days, 0, "the count reset without deleting a single row");
  const { rows } = await db.execute({ sql: "SELECT count(*) AS n FROM ramble_wallet WHERE kind = 'layday'", args: [] });
  assert.equal(Number(rows[0].n), 3, "the ledger is append-only");
});

test("after laying, the count starts again only once the player is eggless again", async () => {
  const db = await freshDb();
  await setLayDays(db, 2);
  await recordHappyDay(db, { now: T0, mood: "happy" });
  await recordHappyDay(db, { now: T0 + DAY, mood: "happy" });
  assert.equal(await eggCount(db), 1);

  await recordHappyDay(db, { now: T0 + 2 * DAY, mood: "happy" });
  assert.equal((await layProgress(db)).days, 0, "holding an egg, nothing accrues");

  await db.execute({ sql: "DELETE FROM ramble_eggs", args: [] });   // stand-in for hatching it away
  await recordHappyDay(db, { now: T0 + 3 * DAY, mood: "happy" });
  assert.equal((await layProgress(db)).days, 1, "eggless again: the counter resumes from zero");
});

test("every layday row carries delta exactly 1, whatever lay.days is set to", async () => {
  const db = await freshDb();
  await setLayDays(db, 25);
  await recordHappyDay(db, { now: T0, mood: "happy" });
  const { rows } = await db.execute({ sql: "SELECT delta FROM ramble_wallet WHERE kind = 'layday'", args: [] });
  assert.equal(Number(rows[0].delta), 1, "MAX(delta) is only convergent on a constant");
});

test("layProgress reports what the panel needs", async () => {
  const db = await freshDb();
  assert.deepEqual(await layProgress(db), { days: 0, needed: 14 });
  await recordHappyDay(db, { now: T0, mood: "happy" });
  assert.deepEqual(await layProgress(db), { days: 1, needed: 14 });
});

/* ------------------------------------------------------- multi-instance
 * Spec §8: "every currency ledger replicates, so both need multi-instance
 * tests, not single-database ones." A sync defect already cost this project
 * real data; prose review is not sufficient here. The pattern below follows
 * tests/ramble-cells-sync.test.js.
 */

test("MULTI-INSTANCE: a peer's layday rows converge to the same count", async () => {
  const a = await freshDb();
  const b = await freshDb();
  await setLayDays(a, 5); await setLayDays(b, 5);

  const rows = [];
  const emit = (table, op, row) => { if (table === "ramble_wallet") rows.push(row); };
  await recordHappyDay(a, { now: T0, mood: "happy", emit });
  await recordHappyDay(a, { now: T0 + DAY, mood: "happy", emit });

  for (const r of rows) await applyRambleWallet(b, "insert", r, 1);
  assert.equal((await layProgress(b)).days, 2, "b sees a's days");
  assert.equal((await layProgress(a)).days, 2, "and a is unchanged");
});

test("MULTI-INSTANCE: created_at going BACKWARDS on apply must not change the count", async () => {
  // applyRambleWallet does created_at = MIN(local, incoming). This is exactly
  // why layProgress orders by `key` and not by `created_at`: an apply can move
  // a row's timestamp across the reset boundary, and clock skew between the
  // user's own machines is enough to do it.
  const db = await freshDb();
  await setLayDays(db, 99);
  await recordHappyDay(db, { now: T0, mood: "happy" });
  await recordHappyDay(db, { now: T0 + DAY, mood: "happy" });
  const before = (await layProgress(db)).days;

  await applyRambleWallet(db, "insert",
    { kind: "layday", key: localDay(T0 + DAY), delta: 1, created_at: 0 }, 9);

  assert.equal((await layProgress(db)).days, before,
    "a rewritten created_at must not move a day in or out of the count");
});

test("MULTI-INSTANCE: a peer's lay row resets this instance's count too", async () => {
  const db = await freshDb();
  await setLayDays(db, 99);
  await recordHappyDay(db, { now: T0, mood: "happy" });
  await recordHappyDay(db, { now: T0 + DAY, mood: "happy" });
  assert.equal((await layProgress(db)).days, 2);

  // The peer laid on the later day.
  await applyRambleWallet(db, "insert",
    { kind: "lay", key: localDay(T0 + DAY), delta: 1, created_at: T0 + DAY }, 5);

  assert.equal((await layProgress(db)).days, 0,
    "both instances agree the count is spent, with nothing deleted");
});
