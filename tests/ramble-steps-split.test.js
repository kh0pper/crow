/**
 * Ramble steps: a reading whose interval crosses one or more local midnights
 * splits its credit across those days in proportion to the time spent in each
 * (the counter carries no timestamps, so time is the only fair weight). Before
 * this, the whole delta landed on the day the reading ARRIVED, so last night's
 * steps showed up on this morning's count and the day looked like it never
 * reset.
 *
 * The zone is pinned: the DST cases need a zone that has DST, and CI runs UTC.
 */
process.env.TZ = "America/Chicago";

import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { localDay } from "../bundles/ramble/server/eggs.js";
import { applyRambleWallet } from "../servers/sharing/instance-sync.js";
import {
  recordStepReading, stepsToday, settleDay, localDaySpans, STEPS_KIND, STEP_ENERGY_KIND, STEP_SEED_PREFIX,
} from "../bundles/ramble/server/steps.js";

const H = 3_600_000;
const MIN = 60_000;
const DEV = "11111111-2222-3333-4444-555555555555";
const DEV2 = "99999999-8888-7777-6666-555555555555";
/** Local wall-clock time (month is 1-based here). */
const L = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

async function freshDb() {
  const db = createClient({ url: "file::memory:" });
  await initRambleTables(db);
  return db;
}
/** A reading at `now` from a phone booted long ago (boot_count 7), unless overridden. */
const read = (db, counter, now, extra = {}, opts = {}) => recordStepReading(
  db, { device_id: DEV, boot_count: 7, counter, elapsed_ms: 400 * H, ...extra }, { now, ...opts },
);
async function row(db, day, dev = DEV) {
  const { rows } = await db.execute({ sql: "SELECT delta FROM ramble_wallet WHERE kind = ? AND key = ?", args: [STEPS_KIND, `${day}:${dev}`] });
  return rows.length ? Number(rows[0].delta) : null;
}
const setSetting = (db, key, value) => db.execute({
  sql: "INSERT INTO ramble_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  args: [key, String(value)],
});
const plant = (db, day, n, dev = DEV2) => db.execute({
  sql: "INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES (?, ?, ?, 0) ON CONFLICT(kind, key) DO UPDATE SET delta = excluded.delta",
  args: [STEPS_KIND, `${day}:${dev}`, n],
});

test("localDaySpans splits an interval at local midnights, DST days included", () => {
  assert.deepEqual(localDaySpans(L(2026, 10, 4, 18, 15), L(2026, 10, 5, 11, 7)), [
    { day: "2026-10-04", ms: 5 * H + 45 * MIN },
    { day: "2026-10-05", ms: 11 * H + 7 * MIN },
  ]);
  // 2026-11-01 is a 25-hour day in this zone.
  assert.deepEqual(localDaySpans(L(2026, 10, 31, 23), L(2026, 11, 2, 1)), [
    { day: "2026-10-31", ms: 1 * H }, { day: "2026-11-01", ms: 25 * H }, { day: "2026-11-02", ms: 1 * H },
  ]);
  // 2027-03-14 is a 23-hour day.
  assert.deepEqual(localDaySpans(L(2027, 3, 13, 22), L(2027, 3, 15, 2)), [
    { day: "2027-03-13", ms: 2 * H }, { day: "2027-03-14", ms: 23 * H }, { day: "2027-03-15", ms: 2 * H },
  ]);
  assert.deepEqual(localDaySpans(L(2026, 10, 5, 9), L(2026, 10, 5, 9)), []);
});

test("an evening reading then a late-morning one: the delta splits across the two days by time", async () => {
  const db = await freshDb();
  await read(db, 50_000, L(2026, 10, 4, 18, 15));                      // baseline
  const out = await read(db, 53_521, L(2026, 10, 5, 11, 7));
  // 345 minutes yesterday, 667 today: 3521 * 345/1012 = 1200.3
  assert.equal(out.reason, "delta");
  assert.equal(out.credited, 2_321, "credited is TODAY's share (it drives today's settle)");
  assert.deepEqual(out.earlier, [{ day: "2026-10-04", credited: 1_200 }]);
  assert.equal(await row(db, "2026-10-04"), 1_200);
  assert.equal(await row(db, "2026-10-05"), 2_321);
  assert.equal(await stepsToday(db, L(2026, 10, 5, 11, 7)), 2_321);
  assert.equal(await stepsToday(db, L(2026, 10, 4, 12)), 1_200);
});

test("an earlier day's share ADDS to what that day already had", async () => {
  const db = await freshDb();
  await read(db, 50_000, L(2026, 10, 4, 9));
  await read(db, 55_773, L(2026, 10, 4, 18));                           // 5,773 on the 4th
  await read(db, 57_773, L(2026, 10, 5, 2));                            // 6h on the 4th, 2h on the 5th
  assert.equal(await row(db, "2026-10-04"), 5_773 + 1_500);
  assert.equal(await row(db, "2026-10-05"), 500);
});

test("a reading across two midnights (phone unread for a day) credits all three days", async () => {
  const db = await freshDb();
  await read(db, 10_000, L(2026, 10, 3, 20));
  const out = await read(db, 13_600, L(2026, 10, 5, 8));                // 4h + 24h + 8h = 36h
  assert.equal(out.credited, 800);
  assert.deepEqual(out.earlier, [{ day: "2026-10-03", credited: 400 }, { day: "2026-10-04", credited: 2_400 }]);
  assert.equal(await row(db, "2026-10-03"), 400);
  assert.equal(await row(db, "2026-10-04"), 2_400);
  assert.equal(await row(db, "2026-10-05"), 800);
});

test("same-day readings are untouched by the split (no earlier field)", async () => {
  const db = await freshDb();
  await read(db, 10_000, L(2026, 10, 5, 0, 30));
  const out = await read(db, 11_000, L(2026, 10, 5, 9));
  assert.deepEqual(out, { credited: 1_000, reason: "delta", clamped: false, day: "2026-10-05" });
});

test("reboot after midnight: every step on the new counter belongs to today", async () => {
  const db = await freshDb();
  await read(db, 10_000, L(2026, 10, 4, 22));
  const out = await read(db, 800, L(2026, 10, 5, 6), { boot_count: 8, elapsed_ms: 4 * H });   // booted 02:00
  assert.deepEqual([out.reason, out.credited, out.earlier], ["reboot", 800, undefined]);
  assert.equal(await row(db, "2026-10-04"), null);
});

test("reboot before midnight: the new counter splits from the boot (or the last reading, if later) to now", async () => {
  const db = await freshDb();
  await read(db, 10_000, L(2026, 10, 4, 20), { boot_count: null });
  // Booted 22:00 (after the 20:00 reading): 2h on the 4th, 6h on the 5th.
  let out = await read(db, 800, L(2026, 10, 5, 6), { boot_count: null, elapsed_ms: 8 * H });
  assert.deepEqual([out.reason, out.credited, out.earlier], ["reboot", 600, [{ day: "2026-10-04", credited: 200 }]]);

  const db2 = await freshDb();
  await read(db2, 10_000, L(2026, 10, 4, 22));
  // boot_count says it rebooted, but the boot time (20:00, clock slop) is BEFORE the
  // 22:00 reading: the steps were still walked after that reading.
  out = await read(db2, 800, L(2026, 10, 5, 6), { boot_count: 8, elapsed_ms: 10 * H });
  assert.deepEqual([out.reason, out.credited, out.earlier], ["reboot", 600, [{ day: "2026-10-04", credited: 200 }]]);
});

test("DST fall-back (2026-11-01, 25 h): shares follow real elapsed time", async () => {
  const db = await freshDb();
  await read(db, 0, L(2026, 10, 31, 23));
  const out = await read(db, 2_600, L(2026, 11, 1, 23));               // 25 real hours: 1h on the 31st, 24h on the 1st
  assert.deepEqual(out.earlier, [{ day: "2026-10-31", credited: 104 }]);
  assert.equal(out.credited, 2_496);
});

test("DST spring-forward (2027-03-14, 23 h) across two midnights", async () => {
  const db = await freshDb();
  await read(db, 0, L(2027, 3, 13, 22));
  const out = await read(db, 2_700, L(2027, 3, 15, 2));                // 2h + 23h + 2h = 27h
  assert.deepEqual(out.earlier, [{ day: "2027-03-13", credited: 200 }, { day: "2027-03-14", credited: 2_300 }]);
  assert.equal(out.credited, 200);
});

test("each day's share respects that day's steps.max.day", async () => {
  const db = await freshDb();
  await setSetting(db, "steps.max.day", 1_000);
  await plant(db, "2026-10-04", 900);
  await read(db, 50_000, L(2026, 10, 4, 18, 15));
  const out = await read(db, 53_521, L(2026, 10, 5, 11, 7));
  assert.deepEqual(out.earlier, [{ day: "2026-10-04", credited: 100 }]);
  assert.equal(out.credited, 1_000);
  assert.equal(out.clamped, true);
});

test("the plausibility clamp applies to the whole interval, then splits (each share stays plausible)", async () => {
  const db = await freshDb();
  await read(db, 0, L(2026, 10, 4, 23, 50));
  const out = await read(db, 100_000, L(2026, 10, 5, 0, 10));         // 20 min: at most 5,000
  assert.equal(out.clamped, true);
  assert.deepEqual(out.earlier, [{ day: "2026-10-04", credited: 2_500 }]);
  assert.equal(out.credited, 2_500);
});

test("each day's share respects that day's device limit", async () => {
  const db = await freshDb();
  await setSetting(db, "steps.devices.per.day", 1);
  await plant(db, "2026-10-04", 300);                                  // DEV2 already counted on the 4th
  await read(db, 50_000, L(2026, 10, 4, 18, 15));
  const out = await read(db, 53_521, L(2026, 10, 5, 11, 7));
  assert.deepEqual(out.earlier, [{ day: "2026-10-04", credited: 0 }]);
  assert.equal(out.credited, 2_321);
  assert.equal(await row(db, "2026-10-04"), null);
});

test("a phone unread for weeks: only today and the seven days before it are credited, older shares are dropped", async () => {
  const db = await freshDb();
  await read(db, 0, L(2026, 9, 5, 0));
  const out = await read(db, 30_000, L(2026, 10, 5, 0), { elapsed_ms: 1_120 * H }); // 30 days later, 1,000 a day
  assert.deepEqual(out.earlier.map((e) => e.day), [
    "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04",
  ]);
  assert.equal(out.reason, "delta");
  assert.ok(out.earlier.every((e) => e.credited === 1_000), JSON.stringify(out));
  assert.equal(out.credited, 0);
  const { rows } = await db.execute({ sql: "SELECT count(*) AS n FROM ramble_wallet WHERE kind = ?", args: [STEPS_KIND] });
  assert.equal(Number(rows[0].n), 7);
});

test("one emit per row touched, oldest day first, each with that row's full total", async () => {
  const db = await freshDb();
  const ops = [];
  const emit = async (table, op, r) => ops.push({ table, op, row: r });
  await read(db, 10_000, L(2026, 10, 3, 20), {}, { emit });
  await read(db, 13_600, L(2026, 10, 5, 8), {}, { emit });
  assert.deepEqual(ops.filter((o) => o.row.kind === STEPS_KIND).map((o) => [o.row.key, o.row.delta]), [
    [`2026-10-03:${DEV}`, 400], [`2026-10-04:${DEV}`, 2_400], [`2026-10-05:${DEV}`, 800],
  ]);
});

test("a retried or racing split reading never double-credits", async () => {
  const db = await freshDb();
  await read(db, 50_000, L(2026, 10, 4, 18, 15));
  const now = L(2026, 10, 5, 11, 7);
  const [a, b] = await Promise.all([read(db, 53_521, now), read(db, 53_521, now)]);
  assert.deepEqual([a.reason, b.reason].sort(), ["delta", "raced"]);
  const again = await read(db, 53_521, now + 1_000);
  assert.equal(again.credited, 0);
  assert.equal(await row(db, "2026-10-04"), 1_200);
  assert.equal(await row(db, "2026-10-05"), 2_321);
});

test("foreign guard, next day: today's row grown by a peer still re-baselines after a split", async () => {
  const db = await freshDb();
  await read(db, 50_000, L(2026, 10, 4, 18, 15));
  await read(db, 53_521, L(2026, 10, 5, 11, 7));
  await plant(db, "2026-10-05", 3_000, DEV);                           // a peer credited this phone more today
  const out = await read(db, 54_000, L(2026, 10, 5, 12));
  assert.deepEqual([out.credited, out.reason], [0, "foreign"]);
  assert.deepEqual([(await read(db, 54_100, L(2026, 10, 5, 12, 30))).credited], [100]);
});

test("foreign guard: yesterday's row grown by a peer after our last reading blocks the split", async () => {
  const db = await freshDb();
  await read(db, 50_000, L(2026, 10, 4, 9));
  await read(db, 55_000, L(2026, 10, 4, 18));                          // our row for the 4th: 5,000
  await plant(db, "2026-10-04", 6_000, DEV);                           // a peer credited the evening walk
  const out = await read(db, 57_000, L(2026, 10, 5, 8));
  assert.deepEqual([out.credited, out.reason, out.earlier], [0, "foreign", undefined]);
  assert.equal(await row(db, "2026-10-04"), 6_000);
  assert.equal(await row(db, "2026-10-05"), null);
});

test("foreign guard: a peer's row on a day BETWEEN our last reading and today blocks the split", async () => {
  const db = await freshDb();
  await read(db, 10_000, L(2026, 10, 3, 20));
  await plant(db, "2026-10-04", 700, DEV);
  const out = await read(db, 13_600, L(2026, 10, 5, 8));
  assert.deepEqual([out.credited, out.reason], [0, "foreign"]);
  assert.equal(await row(db, "2026-10-03"), null);
});

test("two instances: A credits the evening, the phone visits B overnight, back on A next morning — no double count", async () => {
  const mk = async () => {
    const db = await freshDb();
    const ops = [];
    return { db, ops, emit: async (t, op, r) => ops.push({ t, op, r: { ...r } }) };
  };
  const A = await mk();
  const B = await mk();
  let lamport = 1;
  const deliver = async (from, to) => {
    for (const { t, op, r } of from.ops.splice(0)) if (t === "ramble_wallet") await applyRambleWallet(to.db, op, r, ++lamport);
  };
  await read(A.db, 50_000, L(2026, 10, 4, 9), {}, { emit: A.emit });
  await read(A.db, 55_000, L(2026, 10, 4, 18), {}, { emit: A.emit });
  await deliver(A, B);
  await read(B.db, 55_500, L(2026, 10, 4, 20), {}, { emit: B.emit }); // B: baseline only
  await read(B.db, 56_500, L(2026, 10, 4, 22), {}, { emit: B.emit }); // B credits 1,000 to the 4th
  await deliver(B, A);
  const out = await read(A.db, 58_000, L(2026, 10, 5, 8), {}, { emit: A.emit });
  assert.equal(out.reason, "foreign");
  assert.equal(await row(A.db, "2026-10-04"), 6_000);
});

test("an earlier day's share pays no energy, seed or badge for that day; today's settle sees only today's share", async () => {
  const db = await freshDb();
  await db.execute("INSERT INTO ramble_pet (owner, energy, last_fed_at) VALUES ('self', 40, NULL)");
  await read(db, 50_000, L(2026, 10, 4, 9));
  await read(db, 55_000, L(2026, 10, 4, 18));
  const now = L(2026, 10, 5, 2);
  await read(db, 59_000, now);                                         // 3,000 to the 4th (8,000 there), 1,000 today
  const settled = await settleDay(db, { now });
  assert.equal(settled.steps, 1_000);
  const { rows } = await db.execute({
    sql: "SELECT kind, key FROM ramble_wallet WHERE (kind = ? AND key = ?) OR (kind = 'seed' AND key = ?) OR (kind = 'walked' AND key = ?)",
    args: [STEP_ENERGY_KIND, "2026-10-04", STEP_SEED_PREFIX + "2026-10-04", "2026-10-04"],
  });
  assert.deepEqual(rows, [], "nothing is paid retroactively for the 4th");
  assert.equal(localDay(now), "2026-10-05");
});
