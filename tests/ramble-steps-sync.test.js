/**
 * Spec 2026-10-04 §4.1, §11: steps replicate as monotone ramble_wallet rows,
 * merged by the EXISTING applyRambleWallet (MAX delta). Two in-memory dbs
 * stand in for two of the user's instances; each one's emits are captured and
 * applied to the other, in both orders.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { applyRambleWallet } from "../servers/sharing/instance-sync.js";
import { startOfLocalDay } from "../bundles/ramble/server/eggs.js";
import { seedBalance } from "../bundles/ramble/server/wallet.js";
import {
  recordStepReading, settleDay, stepsToday, stepsState, recordWalkCheckin,
} from "../bundles/ramble/server/steps.js";

const DAY0 = startOfLocalDay(Date.UTC(2026, 9, 5, 18));
const AT = (h, m = 0) => DAY0 + h * 3_600_000 + m * 60_000;
const H = 3_600_000;
const P1 = "aaaaaaaa-0000-0000-0000-000000000001";
const P2 = "bbbbbbbb-0000-0000-0000-000000000002";

async function instance() {
  const db = createClient({ url: "file::memory:" });
  await initRambleTables(db);
  await db.execute("INSERT INTO ramble_pet (owner, energy) VALUES ('self', 40)");
  const ops = [];
  return { db, ops, emit: async (table, op, row) => ops.push({ table, op, row: { ...row } }) };
}
let lamport = 1000;
/** Apply (and drain) `from`'s captured wallet ops to `to`, optionally reversed. */
async function deliver(from, to, { reverse = false } = {}) {
  const ops = from.ops.splice(0);
  if (reverse) ops.reverse();
  for (const { table, op, row } of ops) {
    if (table === "ramble_wallet") await applyRambleWallet(to.db, op, row, ++lamport);
  }
}
async function readAndSettle(inst, r, now) {
  const out = await recordStepReading(inst.db, { boot_count: 1, ...r }, { now, emit: inst.emit });
  if (out.credited > 0) await settleDay(inst.db, { now, emit: inst.emit });
  return out;
}
const setBoth = async (A, B, key, value) => {
  for (const { db } of [A, B]) {
    await db.execute({ sql: "INSERT INTO ramble_settings (key, value) VALUES (?, ?)", args: [key, String(value)] });
  }
};

for (const reverse of [false, true]) {
  test(`one phone on A, delivered to B (${reverse ? "reversed" : "in order"}): same total, same balance, same badge`, async () => {
    const A = await instance(), B = await instance();
    await readAndSettle(A, { device_id: P1, counter: 3_000, elapsed_ms: 2 * H }, AT(10));
    await readAndSettle(A, { device_id: P1, counter: 7_000, elapsed_ms: 4 * H }, AT(12));
    await deliver(A, B, { reverse });
    assert.equal(await stepsToday(B.db, AT(12)), 7_000);
    assert.equal(await seedBalance(B.db), 3);
    const st = await stepsState(B.db, { now: AT(12) });
    assert.deepEqual([st.walked, st.goal_met, st.energy_today], [true, true, 30]);
  });
}

test("a phone that moves from A to B mid-day: B does not re-add what A already synced, and stays monotone", async () => {
  const A = await instance(), B = await instance();
  await readAndSettle(A, { device_id: P1, counter: 2_000, elapsed_ms: 2 * H }, AT(10));
  await deliver(A, B);
  // Same boot, the phone now talks to B. B has no baseline for it; it booted today.
  const out = await readAndSettle(B, { device_id: P1, counter: 2_600, elapsed_ms: 3 * H }, AT(11));
  assert.equal(out.credited, 600, "only what A had not seen");
  assert.equal(await stepsToday(B.db, AT(11)), 2_600);
  await deliver(B, A);
  assert.equal(await stepsToday(A.db, AT(11)), 2_600, "MAX, not a sum");
});

test("A -> B -> A: a phone that returns to A after B credited it is NOT counted twice (foreign-credit guard)", async () => {
  const A = await instance(), B = await instance();
  await readAndSettle(A, { device_id: P1, counter: 50_000, elapsed_ms: 20 * H }, AT(9));   // A baseline
  await readAndSettle(A, { device_id: P1, counter: 52_000, elapsed_ms: 21 * H }, AT(10));  // A: 2,000
  await deliver(A, B);
  await readAndSettle(B, { device_id: P1, counter: 52_500, elapsed_ms: 22 * H }, AT(11));  // B baseline
  await readAndSettle(B, { device_id: P1, counter: 53_000, elapsed_ms: 23 * H }, AT(12));  // B: 2,500
  await deliver(B, A);
  const back = await readAndSettle(A, { device_id: P1, counter: 53_500, elapsed_ms: 24 * H }, AT(13));
  assert.deepEqual([back.credited, back.reason], [0, "foreign"], "A's baseline is stale: re-baseline, credit nothing");
  assert.equal(await stepsToday(A.db, AT(13)), 2_500, "never more than the steps actually seen (true walk: 3,500; the gaps are lost, never doubled)");
  const next = await readAndSettle(A, { device_id: P1, counter: 54_000, elapsed_ms: 25 * H }, AT(14));
  assert.equal(next.credited, 500, "and from the new baseline A counts normally again");
  await deliver(A, B);
  assert.equal(await stepsToday(B.db, AT(14)), 3_000);
});

test("a phone that moves to B after booting BEFORE today: B takes a baseline and A's count stands", async () => {
  const A = await instance(), B = await instance();
  await readAndSettle(A, { device_id: P1, counter: 50_000, elapsed_ms: 20 * H }, AT(9));
  await readAndSettle(A, { device_id: P1, counter: 52_000, elapsed_ms: 21 * H }, AT(10));
  await deliver(A, B);
  const out = await readAndSettle(B, { device_id: P1, counter: 52_500, elapsed_ms: 22 * H }, AT(11));
  assert.equal(out.reason, "baseline");
  assert.equal(await stepsToday(B.db, AT(11)), 2_000);
  await readAndSettle(B, { device_id: P1, counter: 53_000, elapsed_ms: 23 * H }, AT(12));
  assert.equal(await stepsToday(B.db, AT(12)), 2_500, "B adds on top of the synced total");
});

test("two phones on two instances: totals add, the cap holds after merge, the bonus pays once", async () => {
  const A = await instance(), B = await instance();
  await setBoth(A, B, "steps.max.day", 5_000);
  await readAndSettle(A, { device_id: P1, counter: 4_000, elapsed_ms: 3 * H }, AT(10));
  await readAndSettle(B, { device_id: P2, counter: 4_000, elapsed_ms: 3 * H }, AT(10));
  await deliver(A, B);
  await deliver(B, A);
  for (const I of [A, B]) {
    assert.equal(await stepsToday(I.db, AT(10)), 5_000, "capped on read after a merge");
  }
  // Neither met the 6,000 goal alone; together (capped) they still do not.
  assert.equal(await seedBalance(A.db), 0);
  await setBoth(A, B, "steps.goal", 5_000);
  await settleDay(A.db, { now: AT(10), emit: A.emit });
  await settleDay(B.db, { now: AT(10), emit: B.emit });
  await deliver(A, B);
  await deliver(B, A);
  assert.equal(await seedBalance(A.db), 3, "same key on both sides: one bonus");
  assert.equal(await seedBalance(B.db), 3);
});

test("energy ledgers merge to the larger, and a later settle does not pay the difference twice", async () => {
  const A = await instance(), B = await instance();
  await readAndSettle(A, { device_id: P1, counter: 6_000, elapsed_ms: 3 * H }, AT(10)); // paid 30
  await recordWalkCheckin(B.db, { now: AT(10), emit: B.emit });                          // paid 15
  await deliver(A, B);
  await deliver(B, A);
  for (const I of [A, B]) {
    const st = await stepsState(I.db, { now: AT(10) });
    assert.equal(st.energy_today, 30);
    assert.equal((await settleDay(I.db, { now: AT(10, 5), emit: I.emit })).energyPaid, 0);
  }
});

test("walked and check-in facts dedupe across instances", async () => {
  const A = await instance(), B = await instance();
  await recordWalkCheckin(A.db, { now: AT(9), emit: A.emit });
  await recordWalkCheckin(B.db, { now: AT(10), emit: B.emit });
  await deliver(A, B);
  await deliver(B, A);
  for (const I of [A, B]) {
    const { rows } = await I.db.execute("SELECT kind, key, delta, created_at FROM ramble_wallet WHERE kind IN ('walkcheck', 'walked') ORDER BY kind");
    assert.deepEqual(rows.map((r) => [r.kind, Number(r.delta), Number(r.created_at)]), [["walkcheck", 1, AT(9)], ["walked", 1, AT(9)]]);
  }
});
