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
  STEPS_KIND, STEPS_DEFAULTS, settleDay, recordWalkCheckin, stepsState, walkedToday, writeStepSettings,
  touchHome, STEP_ENERGY_KIND, WALKED_KIND, HOME_KEY,
} from "../bundles/ramble/server/steps.js";
import { feed } from "../bundles/ramble/server/pet.js";
import { seedBalance, harvestableCells } from "../bundles/ramble/server/wallet.js";
import { buyItem } from "../bundles/ramble/server/wardrobe.js";

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

test("steps since last night's reading split across the two days by time (3 h yesterday, 8 h today)", async () => {
  const db = await freshDb();
  await read(db, { counter: 1_000, elapsed_ms: 30 * H }, AT(-3)); // 21:00 the previous day
  const out = await read(db, { counter: 4_000, elapsed_ms: 41 * H }, AT(8));
  assert.equal(out.credited, 2_182);
  assert.deepEqual(out.earlier, [{ day: localDay(AT(-3)), credited: 818 }]);
  assert.equal(await stepsToday(db, AT(8)), 2_182);
  assert.equal(await stepsToday(db, AT(-3)), 818);
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

// add to imports:
//   import { feed, petState } from "../bundles/ramble/server/pet.js";
//   import { seedBalance, harvestableCells } from "../bundles/ramble/server/wallet.js";
//   and from steps.js also: settleDay, recordWalkCheckin, stepsState, walkedToday, writeStepSettings,
//   touchHome, STEP_ENERGY_KIND, WALKED_KIND, HOME_KEY

async function petRow(db) {
  const { rows } = await db.execute("SELECT energy, last_fed_at, places_week FROM ramble_pet WHERE owner = 'self'");
  return { energy: Number(rows[0].energy), last_fed_at: rows[0].last_fed_at == null ? null : Number(rows[0].last_fed_at), places_week: Number(rows[0].places_week) };
}
async function seedPet(db, energy, lastFedAt) {
  await db.execute({
    sql: "INSERT INTO ramble_pet (owner, energy, last_fed_at) VALUES ('self', ?, ?) ON CONFLICT(owner) DO UPDATE SET energy = excluded.energy, last_fed_at = excluded.last_fed_at",
    args: [energy, lastFedAt],
  });
}
/** Put `n` steps on today's ledger for a second device, bypassing the sensor maths. */
const plantSteps = (db, now, n, dev = DEV2) => db.execute({
  sql: "INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES ('steps', ?, ?, ?) ON CONFLICT(kind, key) DO UPDATE SET delta = excluded.delta",
  args: [`${localDay(now)}:${dev}`, n, now],
});

test("feed({type:'steps'}) adds a bounded amount and never touches last_fed_at or the weekly counters (R5)", async () => {
  const db = await freshDb();
  await seedPet(db, 40, AT(6));
  await feed(db, { type: "steps", amount: 7 }, { now: AT(9) });
  assert.deepEqual(await petRow(db), { energy: 47, last_fed_at: AT(6), places_week: 0 });
  await feed(db, { type: "steps", amount: -5 }, { now: AT(9) });
  await feed(db, { type: "steps", amount: "junk" }, { now: AT(9) });
  await feed(db, { type: "steps", amount: 2.5 }, { now: AT(9) });
  assert.equal((await petRow(db)).energy, 47, "junk amounts pay nothing");
  await feed(db, { type: "steps", amount: 1e9 }, { now: AT(9) });
  assert.equal((await petRow(db)).energy, 100, "bounded, then clamped by the heart ceiling");
  await assert.rejects(() => feed(db, { type: "stepz" }, { now: AT(9) }), /unknown pet feed event type/);
});

test("energy grows with progress in chunks, reaches energy.full at the goal, and stops there", async () => {
  const db = await freshDb();
  await seedPet(db, 50, AT(8));   // fed at 8: no decay interval (6 h) elapses before the last paying settle at 12
  await plantSteps(db, AT(9), 1_000);
  let out = await settleDay(db, { now: AT(9) });
  assert.equal(out.energyPaid, 5, "floor(30 * 1000/6000) = 5, one chunk");
  await plantSteps(db, AT(10), 1_500);
  out = await settleDay(db, { now: AT(10) });
  assert.equal(out.energyPaid, 0, "target 7: an increment of 2 is under the chunk");
  await plantSteps(db, AT(12), 6_500);
  out = await settleDay(db, { now: AT(12) });
  assert.equal(out.energyPaid, 25);
  await plantSteps(db, AT(14), 9_000);
  out = await settleDay(db, { now: AT(14) });
  assert.equal(out.energyPaid, 0, "never past energy.full");
  assert.deepEqual(await petRow(db), { energy: 80, last_fed_at: AT(8), places_week: 0 });
  assert.equal(Number((await db.execute({ sql: "SELECT delta FROM ramble_wallet WHERE kind = ? AND key = ?", args: [STEP_ENERGY_KIND, localDay(AT(14))] })).rows[0].delta), 30);
});

test("the check-in pays a floor that counted steps rise above but never add to, and never pays seed", async () => {
  const db = await freshDb();
  await seedPet(db, 20, AT(7));   // no decay interval elapses before the last paying settle at 12
  let out = await recordWalkCheckin(db, { now: AT(9) });
  assert.deepEqual([out.already, out.energyPaid, out.seedBonus, out.walked, out.walkedNew], [false, 15, 0, true, true]);
  out = await recordWalkCheckin(db, { now: AT(9, 5) });
  assert.deepEqual([out.already, out.energyPaid, out.walkedNew], [true, 0, false]);
  await plantSteps(db, AT(10), 3_000);   // step target 15 = the floor
  assert.equal((await settleDay(db, { now: AT(10) })).energyPaid, 0);
  await plantSteps(db, AT(11), 4_000);   // step target 20
  assert.equal((await settleDay(db, { now: AT(11) })).energyPaid, 5);
  assert.equal(await seedBalance(db), 0, "a check-in alone never pays seed (S3)");
  await plantSteps(db, AT(12), 6_000);
  out = await settleDay(db, { now: AT(12) });
  assert.deepEqual([out.energyPaid, out.seedBonus], [10, 3]);
  assert.equal((await petRow(db)).energy, 50);
});

test("the seed bonus pays once a day; lowering the goal under today's steps completes it", async () => {
  const db = await freshDb();
  await plantSteps(db, AT(10), 4_000);
  assert.equal((await settleDay(db, { now: AT(10) })).seedBonus, 0);
  const st = await writeStepSettings(db, { goal: 4_000 }, { now: AT(10) });
  assert.equal(st.goal_met, true);
  assert.equal(st.settled.seedBonus, 3);
  assert.equal((await writeStepSettings(db, { goal: 3_500 }, { now: AT(10) })).settled.seedBonus, 0, "once a day");
  assert.equal(await seedBalance(db), 3);
});

test("the bonus row counts toward the balance and is never mistaken for harvestable seed", async () => {
  const db = await freshDb();
  const cells = ["9vg4e2s", "9vg4e2t", "9vg4e2u", "9vg4e2v", "9vg4e2w", "9vg4e2x", "9vg4e2y", "9vg4e2z"];
  const before = await harvestableCells(db, cells, { now: AT(10) });
  assert.ok(before.length > 0);
  await plantSteps(db, AT(10), 7_000);
  await settleDay(db, { now: AT(10) });
  assert.equal(await seedBalance(db), 3);
  assert.deepEqual(await harvestableCells(db, cells, { now: AT(10) }), before);
});

test("the badge: min(goal, badge.min) counted steps, or a check-in; the new-fact flag fires once", async () => {
  const db = await freshDb();
  await plantSteps(db, AT(10), 1_999);
  assert.equal((await settleDay(db, { now: AT(10) })).walked, false);
  assert.equal(await walkedToday(db, { now: AT(10) }), false);
  await plantSteps(db, AT(11), 2_000);
  let out = await settleDay(db, { now: AT(11) });
  assert.deepEqual([out.walked, out.walkedNew], [true, true]);
  out = await settleDay(db, { now: AT(11, 5) });
  assert.deepEqual([out.walked, out.walkedNew], [true, false]);
  assert.equal(await walkedToday(db, { now: AT(11) }), true);
  assert.equal(await walkedToday(db, { now: AT(11) + 24 * H }), false, "tomorrow starts unwalked");
  // The goal floor is 2,000 (= the default badge.min), so a goal can only be
  // the lower line when badge.min has been raised above it.
  const db2 = await freshDb();
  await setSetting(db2, "steps.badge.min", 5_000);
  await writeStepSettings(db2, { goal: 4_000 }, { now: AT(10) });
  await plantSteps(db2, AT(10), 3_999);
  assert.equal((await settleDay(db2, { now: AT(10) })).walked, false);
  await plantSteps(db2, AT(10, 5), 4_000);
  assert.equal((await settleDay(db2, { now: AT(10, 5) })).walked, true, "a goal under badge.min is its own badge line");
});

test("step energy is clamped by the heart-derived ceiling", async () => {
  const db = await freshDb();
  await seedPet(db, 95, AT(6));
  await plantSteps(db, AT(12), 6_000);
  await settleDay(db, { now: AT(12) });
  assert.equal((await petRow(db)).energy, 100);
});

test("stepsState reports the day without writing anything", async () => {
  const db = await freshDb();
  await plantSteps(db, AT(10), 3_000);
  const st = await stepsState(db, { now: AT(10) });
  assert.deepEqual(st, {
    day: localDay(AT(10)), goal: 6000, steps: 3000, progress: 0.5, goal_met: false,
    checked_in: false, walked: false, energy_today: 0, energy_full: 30, seed_today: 0, goal_seed: 3,
    counted_devices: 1, settings: { goal: 6000, nudge: true, nudge_weekends: true },
  });
  assert.equal((await db.execute("SELECT count(*) AS n FROM ramble_wallet WHERE kind != 'steps'")).rows[0].n, 0);
});

test("writeStepSettings validates, persists, and emits each setting", async () => {
  const db = await freshDb();
  const ops = [];
  const emit = async (table, op, row) => ops.push({ table, op, row });
  for (const bad of [{}, { goal: 1_999 }, { goal: 30_001 }, { goal: 6000.5 }, { goal: "6000" }, { nudge: "yes" }, { nudge_weekends: 1 }, null]) {
    await assert.rejects(() => writeStepSettings(db, bad, { now: AT(10), emit }), (e) => e.name === "StepsInputError", JSON.stringify(bad));
  }
  const st = await writeStepSettings(db, { goal: 7_500, nudge: false, nudge_weekends: false }, { now: AT(10), emit });
  assert.deepEqual(st.settings, { goal: 7500, nudge: false, nudge_weekends: false });
  assert.deepEqual(ops.filter((o) => o.table === "ramble_settings").map((o) => [o.row.key, o.row.value]),
    [["steps.goal", "7500"], ["steps.nudge", "0"], ["steps.nudge.weekends", "0"]]);
});

test("touchHome writes the local-only steps-home marker without emitting", async () => {
  const db = await freshDb();
  await touchHome(db, { now: AT(10) });
  const { rows } = await db.execute({ sql: "SELECT value FROM ramble_settings WHERE key = ?", args: [HOME_KEY] });
  assert.equal(Number(rows[0].value), AT(10));
  assert.ok(HOME_KEY.startsWith("local."), "instance sync drops local. keys in both directions");
});

test("the goal seed bonus counts toward buying in the wardrobe (balance 9 + 3 bonus buys a 12-seed hat)", async () => {
  const db = await freshDb();
  await db.execute({ sql: "INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES ('seed', 'pickup:test', 9, ?)", args: [AT(8)] });
  assert.equal(await seedBalance(db), 9);
  const before = await buyItem(db, "hat.beanie", { now: AT(9), purchaseId: "p1" });
  assert.deepEqual([before.ok, before.reason], [false, "short"], "9 seed cannot buy a 12-seed hat");
  await plantSteps(db, AT(10), 6_000);
  assert.equal((await settleDay(db, { now: AT(10) })).seedBonus, 3);
  const after = await buyItem(db, "hat.beanie", { now: AT(11), purchaseId: "p2" });
  assert.equal(after.ok, true, "affordable only because of the bonus");
  assert.equal(after.balance, 0);
});

test("settleDay applies the pet's owed decay BEFORE paying step energy (final review 2026-10-04)", async () => {
  const db = await freshDb();
  const now = AT(18);
  await seedPet(db, 20, now - 48 * H);
  await recordWalkCheckin(db, { now });
  const { petState } = await import("../bundles/ramble/server/pet.js");
  const st = await petState(db, { now });
  assert.equal(st.energy, 15, "decay is applied first, then the +15 check-in survives");
});
