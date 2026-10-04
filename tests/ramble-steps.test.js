/**
 * Spec 2026-10-04 §5 — crediting a step-counter reading. The phone hands us a
 * hardware counter that accumulates since boot; the server keeps a LOCAL
 * baseline per device and credits the difference, guarding reboots, clamping
 * implausible jumps, capping the day, and never crediting twice.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { startOfLocalDay, localDay } from "../bundles/ramble/server/eggs.js";
import {
  recordStepReading, stepsToday, parseReading, readStepSettings, StepsInputError,
  STEPS_KIND, STEPS_DEFAULTS,
} from "../bundles/ramble/server/steps.js";

// A fixed local day; AT(h, m) is that day at h:m local time.
const DAY0 = startOfLocalDay(Date.UTC(2026, 9, 5, 18));
const AT = (h, m = 0) => DAY0 + h * 3_600_000 + m * 60_000;
const H = 3_600_000;
const DEV = "11111111-2222-3333-4444-555555555555";
const DEV2 = "99999999-8888-7777-6666-555555555555";

async function freshDb() {
  const db = createClient({ url: "file::memory:" });
  await initRambleTables(db);
  return db;
}
const read = (db, r, now, extra = {}) =>
  recordStepReading(db, { device_id: DEV, boot_count: 7, ...r }, { now, ...extra });
const setSetting = (db, key, value) => db.execute({
  sql: "INSERT INTO ramble_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  args: [key, String(value)],
});
async function baseline(db, id = DEV) {
  const { rows } = await db.execute({ sql: "SELECT * FROM ramble_step_devices WHERE device_id = ?", args: [id] });
  return rows[0] ? { counter: Number(rows[0].last_counter), at: Number(rows[0].last_read_at), boot: rows[0].boot_count } : null;
}

test("ramble_step_devices exists and is LOCAL (never in instance sync)", async () => {
  const db = await freshDb();
  await db.execute("SELECT device_id, boot_count, last_counter, last_read_at, created_at, last_total, last_day FROM ramble_step_devices");
  const { SYNCED_TABLES } = await import("../servers/sharing/instance-sync.js");
  assert.ok(!SYNCED_TABLES.includes("ramble_step_devices"));
});

test("first reading from a phone booted BEFORE today takes a baseline and credits nothing", async () => {
  const db = await freshDb();
  const out = await read(db, { counter: 50_000, elapsed_ms: 20 * H }, AT(10));
  assert.deepEqual(out, { credited: 0, reason: "baseline", clamped: false, day: localDay(AT(10)) });
  assert.equal(await stepsToday(db, AT(10)), 0);
  assert.deepEqual(await baseline(db), { counter: 50_000, at: AT(10), boot: 7 });
});

test("first reading from a phone booted TODAY credits the whole counter", async () => {
  const db = await freshDb();
  const out = await read(db, { counter: 3_000, elapsed_ms: 2 * H }, AT(10));
  assert.equal(out.credited, 3_000);
  assert.equal(out.reason, "booted-today");
  assert.equal(await stepsToday(db, AT(10)), 3_000);
});

test("a plain delta credits the difference since the last reading", async () => {
  const db = await freshDb();
  await read(db, { counter: 50_000, elapsed_ms: 20 * H }, AT(10));
  const out = await read(db, { counter: 52_000, elapsed_ms: 21 * H }, AT(11));
  assert.equal(out.credited, 2_000);
  assert.equal(out.reason, "delta");
  assert.equal(await stepsToday(db, AT(11)), 2_000);
});

test("reboot detected by boot_count: the new counter is all new steps", async () => {
  const db = await freshDb();
  await read(db, { counter: 50_000, elapsed_ms: 20 * H }, AT(9));
  const out = await read(db, { counter: 1_500, elapsed_ms: 1 * H, boot_count: 8 }, AT(12));
  assert.equal(out.reason, "reboot");
  assert.equal(out.credited, 1_500);
  assert.equal((await baseline(db)).boot, 8);
});

test("reboot detected by the counter going DOWN when boot_count is unknown", async () => {
  const db = await freshDb();
  await read(db, { counter: 50_000, elapsed_ms: 20 * H, boot_count: null }, AT(9));
  const out = await read(db, { counter: 900, elapsed_ms: 1 * H, boot_count: null }, AT(12));
  assert.equal(out.reason, "reboot");
  assert.equal(out.credited, 900);
});

test("reboot detected by boot TIME: booted after the last reading even though the counter is higher", async () => {
  const db = await freshDb();
  await read(db, { counter: 100, elapsed_ms: 20 * H, boot_count: null }, AT(9));
  // Rebooted at 13:00 and walked 4,000 since: 4,000 > 100, but it is not a delta of 3,900.
  const out = await read(db, { counter: 4_000, elapsed_ms: 2 * H, boot_count: null }, AT(15));
  assert.equal(out.reason, "reboot");
  assert.equal(out.credited, 4_000);
});

test("plausibility: an impossible jump is clamped to steps.max.per.min x minutes, and the excess is DISCARDED", async () => {
  const db = await freshDb();
  await read(db, { counter: 0, elapsed_ms: 20 * H }, AT(10));
  const out = await read(db, { counter: 20_000, elapsed_ms: 20 * H + 10 * 60_000 }, AT(10, 10));
  assert.equal(out.credited, 250 * 10);
  assert.equal(out.clamped, true);
  assert.equal((await baseline(db)).counter, 20_000, "the baseline still advances");
  const next = await read(db, { counter: 20_100, elapsed_ms: 20 * H + 20 * 60_000 }, AT(10, 20));
  assert.equal(next.credited, 100, "nothing banked from the clamp");
});

test("the daily cap holds across devices", async () => {
  const db = await freshDb();
  await setSetting(db, "steps.max.day", 5_000);
  await read(db, { counter: 4_000, elapsed_ms: 3 * H }, AT(10));
  const out = await recordStepReading(db, { device_id: DEV2, counter: 4_000, elapsed_ms: 3 * H, boot_count: 1 }, { now: AT(10) });
  assert.equal(out.credited, 1_000);
  assert.equal(out.clamped, true);
  assert.equal(await stepsToday(db, AT(10)), 5_000);
});

test("device limit: a device beyond steps.devices.per.day is credited nothing", async () => {
  const db = await freshDb();
  await setSetting(db, "steps.devices.per.day", 1);
  await read(db, { counter: 1_000, elapsed_ms: 1 * H }, AT(10));
  const out = await recordStepReading(db, { device_id: DEV2, counter: 1_000, elapsed_ms: 1 * H, boot_count: 1 }, { now: AT(10) });
  assert.deepEqual([out.credited, out.reason], [0, "device-limit"]);
});

test("two readings racing never double-credit (compare-and-swap on the baseline)", async () => {
  const db = await freshDb();
  await read(db, { counter: 50_000, elapsed_ms: 20 * H }, AT(10));
  const [a, b] = await Promise.all([
    read(db, { counter: 51_000, elapsed_ms: 21 * H }, AT(11)),
    read(db, { counter: 51_000, elapsed_ms: 21 * H }, AT(11)),
  ]);
  assert.equal(a.credited + b.credited, 1_000);
  assert.deepEqual([a.reason, b.reason].sort(), ["delta", "raced"]);
  assert.equal(await stepsToday(db, AT(11)), 1_000);
});

test("R4: steps since last night's reading land on the day of the reading", async () => {
  const db = await freshDb();
  await read(db, { counter: 1_000, elapsed_ms: 30 * H }, AT(-3)); // 21:00 the previous day
  const out = await read(db, { counter: 4_000, elapsed_ms: 41 * H }, AT(8));
  assert.equal(out.credited, 3_000);
  assert.equal(await stepsToday(db, AT(8)), 3_000);
  assert.equal(await stepsToday(db, AT(-3)), 0);
});

test("the emitted row carries the full running total for that device and day", async () => {
  const db = await freshDb();
  const ops = [];
  const emit = async (table, op, row) => ops.push({ table, op, row });
  await read(db, { counter: 1_000, elapsed_ms: 1 * H }, AT(10), { emit });
  await read(db, { counter: 1_600, elapsed_ms: 1 * H + 30 * 60_000 }, AT(10, 30), { emit });
  const rows = ops.filter((o) => o.table === "ramble_wallet" && o.row.kind === STEPS_KIND);
  assert.deepEqual(rows.map((o) => [o.op, o.row.key, o.row.delta]), [
    ["update", `${localDay(AT(10))}:${DEV}`, 1_000],
    ["update", `${localDay(AT(10))}:${DEV}`, 1_600],
  ]);
});

test("parseReading rejects junk with StepsInputError", () => {
  const ok = { device_id: DEV, counter: 1, elapsed_ms: 1, boot_count: null };
  assert.deepEqual(parseReading(ok), ok);
  assert.deepEqual(parseReading({ device_id: DEV, counter: 1, elapsed_ms: 1 }), ok, "boot_count is optional");
  for (const bad of [
    null, {}, { ...ok, device_id: "short" }, { ...ok, device_id: 12345678 }, { ...ok, device_id: "x".repeat(65) },
    { ...ok, device_id: "has spaces in it" }, { ...ok, counter: -1 }, { ...ok, counter: 1.5 },
    { ...ok, counter: 100_000_001 }, { ...ok, counter: "5" }, { ...ok, elapsed_ms: "1" }, { ...ok, elapsed_ms: -1 },
    { ...ok, boot_count: -2 }, { ...ok, boot_count: 1.2 },
  ]) {
    assert.throws(() => parseReading(bad), (e) => e instanceof StepsInputError, JSON.stringify(bad));
  }
});

test("readStepSettings: defaults, valid overrides, junk falls back", async () => {
  const db = await freshDb();
  assert.deepEqual(await readStepSettings(db), { ...STEPS_DEFAULTS });
  await setSetting(db, "steps.goal", "8000");
  await setSetting(db, "steps.max.day", "abc");
  await setSetting(db, "steps.badge.min", "0");
  await setSetting(db, "steps.nudge", "0");
  await setSetting(db, "steps.nudge.weekends", "maybe");
  const s = await readStepSettings(db);
  assert.equal(s.goal, 8000);
  assert.equal(s.maxDay, STEPS_DEFAULTS.maxDay);
  assert.equal(s.badgeMin, STEPS_DEFAULTS.badgeMin, "0 is below the floor");
  assert.equal(s.nudge, false);
  assert.equal(s.nudgeWeekends, true);
  await setSetting(db, "steps.goal", "1999");
  assert.equal((await readStepSettings(db)).goal, 6000, "below GOAL_MIN");
});

test("foreign-credit guard: a row that grew behind our back (peer MAX apply) re-baselines and credits nothing", async () => {
  const db = await freshDb();
  await read(db, { counter: 50_000, elapsed_ms: 20 * H }, AT(10));
  assert.equal((await read(db, { counter: 51_000, elapsed_ms: 21 * H }, AT(11))).credited, 1_000);
  await db.execute({
    sql: "UPDATE ramble_wallet SET delta = 1500 WHERE kind = ? AND key = ?",
    args: [STEPS_KIND, `${localDay(AT(11))}:${DEV}`],
  });
  const out = await read(db, { counter: 52_000, elapsed_ms: 22 * H }, AT(12));
  assert.deepEqual([out.credited, out.reason], [0, "foreign"]);
  assert.equal(await stepsToday(db, AT(12)), 1_500);
  const next = await read(db, { counter: 52_500, elapsed_ms: 22 * H + 30 * 60_000 }, AT(12, 30));
  assert.deepEqual([next.credited, next.reason], [500, "delta"]);
  assert.equal(await stepsToday(db, AT(12, 30)), 2_000);
});

test("booted-today first reading where today's row already has steps credits only the unseen part", async () => {
  const db = await freshDb();
  await db.execute({
    sql: "INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES (?, ?, ?, ?)",
    args: [STEPS_KIND, `${localDay(AT(10))}:${DEV}`, 1_000, AT(9)],
  });
  const out = await read(db, { counter: 3_000, elapsed_ms: 2 * H }, AT(10));
  assert.deepEqual([out.credited, out.reason], [2_000, "booted-today"]);
  assert.equal(await stepsToday(db, AT(10)), 3_000);
});

test("readStepSettings: blank, whitespace and exponent/hex forms are junk, not numbers", async () => {
  const db = await freshDb();
  await setSetting(db, "steps.energy.full", "");
  await setSetting(db, "steps.energy.chunk", "  ");
  await setSetting(db, "steps.goal", "8e3");
  await setSetting(db, "steps.max.day", "0x9C40");
  await setSetting(db, "steps.badge.min", " 2500 ");
  const s = await readStepSettings(db);
  assert.equal(s.energyFull, 30);
  assert.equal(s.energyChunk, STEPS_DEFAULTS.energyChunk);
  assert.equal(s.goal, 6000);
  assert.equal(s.maxDay, STEPS_DEFAULTS.maxDay);
  assert.equal(s.badgeMin, 2500, "plain digits with padding still parse");
});
