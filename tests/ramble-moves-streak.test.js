/**
 * Moves design Task 5 — the streak, and the all-cards rule that replaced the
 * old one from the upgrade day on.
 *
 * What is pinned here:
 *   - before an instance's `movestreakv2` day the old rule holds: a day counts
 *     from a Done, from steps at the goal, or from 10+ minutes of logs (alone or
 *     in any combination), and with no such row every day keeps it,
 *   - on and after the OLDEST such row (one per instance, all kept by sync) a
 *     day counts only when it is complete, so a day finished by one card alone
 *     is not a streak day while one finished by every card is,
 *   - `streakState` writes nothing, `ensureStreakV2` writes the upgrade row once
 *     per instance and never again,
 *   - a today that has not qualified yet does not break the streak, and a
 *     missed full day resets it,
 *   - a `moveoff` (paused) day is stepped over: it neither counts nor breaks,
 *   - the streak heart is awarded on each multiple of seven, once per day, and
 *     only on a day that itself qualifies and a later missed day never takes a
 *     heart away,
 *   - junk ledger keys (bad day, unknown activity/effort, malformed movelog
 *     key) never count.
 *
 * Rows are written directly (as tests/ramble-moves-ledger.test.js does for
 * hearts): these tests are about how the streak READS the ledger, not about
 * how each earner writes it (Task 4 covers that).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { localDay } from "../bundles/ramble/server/eggs.js";
import { HEART_KIND, heartsBalance } from "../bundles/ramble/server/hearts.js";
import { rowDelta } from "../bundles/ramble/server/steps.js";
import {
  STREAK_HEART_EVERY, STREAK_HEART_PREFIX, STREAK_LOG_MINUTES, STREAK_V2_KIND,
  awardStreakHeart, ensureStreakV2, streakState,
} from "../bundles/ramble/server/moves/streak.js";
import { MOVE_DONE_KIND, MOVE_LOG_KIND } from "../bundles/ramble/server/moves/ledger.js";
import {
  MOVE_ALL_KIND, MOVE_BAL_KIND, MOVE_NEED_KIND, MOVE_SLOT_KIND,
} from "../bundles/ramble/server/moves/day-complete.js";
import { MOVE_OFF_KIND } from "../bundles/ramble/server/moves/today.js";

/** Local noon, so day arithmetic is timezone-independent. */
function at(offset) {
  return new Date(2026, 9, 20 + offset, 12, 0, 0).getTime();
}

const day = (offset) => localDay(at(offset));

async function freshDb() {
  const db = createClient({ url: "file::memory:" });
  await initRambleTables(db);
  return db;
}

async function fact(db, kind, key, delta = 1, createdAt = 0) {
  await db.execute({
    sql: "INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES (?, ?, ?, ?)",
    args: [kind, key, delta, createdAt],
  });
}

const doneDay = (db, offset) => fact(db, MOVE_DONE_KIND, day(offset), 1, at(offset));
const offDay = (db, offset) => fact(db, MOVE_OFF_KIND, day(offset), 1, at(offset));
/** The day this instance's all-cards rule starts on. */
const upgrade = (db, offset) => fact(db, STREAK_V2_KIND, day(offset), 1, at(offset));

/** A complete day from its rows alone: one card asked for, its slot done, balanced. */
async function completeDayOf(db, dayStr) {
  await fact(db, MOVE_NEED_KIND, dayStr, 1);
  await fact(db, MOVE_SLOT_KIND, `${dayStr}:morning`);
  await fact(db, MOVE_BAL_KIND, dayStr);
}

const completeDay = (db, offset) => completeDayOf(db, day(offset));

/** The keys of one wallet kind, so an assertion says how many rows were written. */
async function rowsOfKind(db, kind) {
  const { rows } = await db.execute({
    sql: "SELECT key FROM ramble_wallet WHERE kind = ? ORDER BY key",
    args: [kind],
  });
  return rows.map((row) => String(row.key));
}

/** How many rows the wallet holds per kind. */
async function walletCounts(db) {
  const { rows } = await db.execute({
    sql: "SELECT kind, count(*) AS n FROM ramble_wallet GROUP BY kind",
    args: [],
  });
  const out = {};
  for (const row of rows) out[String(row.kind)] = Number(row.n);
  return out;
}

function walletCollector() {
  const rows = [];
  return {
    rows,
    emit: async (table, op, row) => {
      if (table === "ramble_wallet") rows.push({ op, kind: row.kind, key: row.key, delta: Number(row.delta) });
    },
  };
}

test("seven days in a row awards one heart, once", async () => {
  const db = await freshDb();
  for (let i = -6; i <= 0; i += 1) await doneDay(db, i);

  const state = await streakState(db, { now: at(0) });
  assert.deepEqual(state, { days: 7, nextHeartAt: STREAK_HEART_EVERY, todayGood: true });
  assert.equal(STREAK_HEART_EVERY, 7);

  const c = walletCollector();
  const first = await awardStreakHeart(db, { now: at(0), emit: c.emit });
  assert.equal(first.awarded, true);
  assert.equal(first.days, 7);
  assert.equal(first.key, "streak:" + day(0));
  assert.equal(await heartsBalance(db), 1);
  assert.deepEqual(c.rows, [{ op: "update", kind: "heart", key: "streak:" + day(0), delta: 1 }]);

  // The same day only ever pays once, on any device.
  const second = await awardStreakHeart(db, { now: at(0) + 60_000 });
  assert.equal(second.awarded, false);
  assert.equal(await heartsBalance(db), 1);
});

test("a moved-off day in the middle is skipped: neither counts nor breaks", async () => {
  const db = await freshDb();
  for (let i = -7; i <= 0; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await (i === -4 ? offDay(db, i) : doneDay(db, i));
  }
  // Seven qualifying days across eight calendar days: the pause is not a miss.
  assert.deepEqual(await streakState(db, { now: at(0) }), { days: 7, nextHeartAt: 7, todayGood: true });
  assert.equal((await awardStreakHeart(db, { now: at(0) })).awarded, true);
});

test("a paused day alone is not a streak day, but it does not break a run either", async () => {
  const db = await freshDb();
  await offDay(db, -1);
  assert.equal((await streakState(db, { now: at(0) })).days, 0);

  const db2 = await freshDb();
  await doneDay(db2, -2);
  await offDay(db2, -1);
  await doneDay(db2, 0);
  assert.equal((await streakState(db2, { now: at(0) })).days, 2, "the pause did not reset the two days around it");
});

test("today counts once it qualifies, and a not-yet-qualifying today does not break the streak", async () => {
  const db = await freshDb();
  await doneDay(db, -2);
  await doneDay(db, -1);
  assert.equal((await streakState(db, { now: at(0) })).days, 2, "today is not over yet");
  await doneDay(db, 0);
  assert.equal((await streakState(db, { now: at(0) })).days, 3);
});

test("a missed full day resets the streak to 0, and hearts already earned stay", async () => {
  const db = await freshDb();
  for (let i = -6; i <= 0; i += 1) await doneDay(db, i);
  assert.equal((await awardStreakHeart(db, { now: at(0) })).awarded, true);
  assert.equal(await heartsBalance(db), 1);

  // The next day has no facts yet: still 7, because today is not over.
  assert.equal((await streakState(db, { now: at(1) })).days, 7);
  // One full missed day later: the run is broken.
  assert.equal((await streakState(db, { now: at(2) })).days, 0);
  assert.equal(await heartsBalance(db), 1, "a missed day never takes a heart away");
  assert.equal((await awardStreakHeart(db, { now: at(2) })).awarded, false);

  // A new day starts a new streak at 1.
  await doneDay(db, 3);
  assert.equal((await streakState(db, { now: at(3) })).days, 1);
  assert.equal((await awardStreakHeart(db, { now: at(3) })).awarded, false);
});

test("a steps-only day counts once the counted steps reach the live goal", async () => {
  const db = await freshDb();
  await fact(db, "steps", day(-1) + ":dev-abc123", 5999, at(-1));
  assert.equal((await streakState(db, { now: at(0) })).days, 0, "one step short is short");

  const db2 = await freshDb();
  await fact(db2, "steps", day(-1) + ":dev-abc123", 6000, at(-1));
  assert.equal((await streakState(db2, { now: at(0) })).days, 1);

  // The goal is read live: a lower goal makes the same day count.
  const db3 = await freshDb();
  await fact(db3, "steps", day(-1) + ":dev-abc123", 3000, at(-1));
  assert.equal((await streakState(db3, { now: at(0) })).days, 0);
  await db3.execute({
    sql: `INSERT INTO ramble_settings (key, value) VALUES ('steps.goal', '3000')
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    args: [],
  });
  assert.equal((await streakState(db3, { now: at(0) })).days, 1);
});

test("steps from every device sum, and a day is clamped like stepsToday", async () => {
  const db = await freshDb();
  await fact(db, "steps", day(-1) + ":dev-abc123", 3000, at(-1));
  await fact(db, "steps", day(-1) + ":dev-def456", 3000, at(-1));
  assert.equal((await streakState(db, { now: at(0) })).days, 1, "two devices' halves make the goal");

  const db2 = await freshDb();
  await fact(db2, "steps", day(-1) + ":dev-abc123", 40000, at(-1));
  await fact(db2, "steps", day(-1) + ":dev-def456", 5000, at(-1));
  await db2.execute({
    sql: `INSERT INTO ramble_settings (key, value) VALUES ('steps.max.day', '1000')
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    args: [],
  });
  assert.equal((await streakState(db2, { now: at(0) })).days, 0,
    "a day clamped below the goal by steps.max.day is not a goal day");
});

test("a day of logs counts from ten minutes in total, not from one entry's length", async () => {
  const db = await freshDb();
  await fact(db, MOVE_LOG_KIND, `${day(-1)}:480:yoga:6:easy`, 5, at(-1));
  await fact(db, MOVE_LOG_KIND, `${day(-1)}:490:band:4:easy`, 3, at(-1));
  assert.equal((await streakState(db, { now: at(0) })).days, 1);

  assert.equal(STREAK_LOG_MINUTES, 10);

  const db2 = await freshDb();
  await fact(db2, MOVE_LOG_KIND, `${day(-1)}:480:yoga:9:easy`, 5, at(-1));
  assert.equal((await streakState(db2, { now: at(0) })).days, 0, "nine minutes is not a streak day");
});

test("junk ledger rows never count: bad days, unknown vocabulary, malformed log keys", async () => {
  const db = await freshDb();
  await fact(db, MOVE_DONE_KIND, "not-a-day", 1, at(-1));
  await fact(db, MOVE_LOG_KIND, `${day(-1)}:480:strolling:30:easy`, 5, at(-1));
  await fact(db, MOVE_LOG_KIND, `${day(-1)}:480:yoga:30:heroic`, 5, at(-1));
  await fact(db, MOVE_LOG_KIND, `${day(-1)}:480:yoga:30`, 5, at(-1));
  await fact(db, MOVE_LOG_KIND, `${day(-1)}:480:yoga:0:easy`, 5, at(-1));
  await fact(db, "steps", `${day(-1)}:dev-abc123`, -500, at(-1));
  assert.equal((await streakState(db, { now: at(0) })).days, 0);
});

test("the heart lands on each multiple of seven, and on nothing else", async () => {
  const db = await freshDb();
  for (let i = -13; i <= 0; i += 1) await doneDay(db, i);

  // Six days in: nothing yet.
  const six = await awardStreakHeart(db, { now: at(-8) });
  assert.equal(six.days, 6);
  assert.equal(six.awarded, false);
  assert.equal(await heartsBalance(db), 0);

  // Day seven.
  const seven = await awardStreakHeart(db, { now: at(-7) });
  assert.equal(seven.awarded, true);
  assert.equal(seven.key, "streak:" + day(-7));
  assert.equal(await heartsBalance(db), 1);

  // Eight days in: a non-multiple, no second heart.
  assert.equal((await awardStreakHeart(db, { now: at(-6) })).awarded, false);
  assert.equal(await heartsBalance(db), 1);

  // Fourteen days in: another heart, under its own day key.
  const fourteen = await awardStreakHeart(db, { now: at(0) });
  assert.equal(fourteen.awarded, true);
  assert.equal(fourteen.days, 14);
  assert.equal(fourteen.key, "streak:" + day(0));
  assert.equal(await heartsBalance(db), 2);
});

test("the same run pays once: no heart until TODAY itself qualifies", async () => {
  const db = await freshDb();
  for (let i = -6; i <= 0; i += 1) await doneDay(db, i);

  assert.equal((await awardStreakHeart(db, { now: at(0) })).awarded, true);
  assert.equal(await heartsBalance(db), 1);

  // The next morning has no facts yet, so the count still reads seven (today
  // is not over) — but today has earned nothing, so nothing is paid.
  const tomorrow = await streakState(db, { now: at(1) });
  assert.equal(tomorrow.days, 7);
  assert.equal(tomorrow.todayGood, false);
  assert.equal((await awardStreakHeart(db, { now: at(1) })).awarded, false);
  assert.equal(await heartsBalance(db), 1, "one run, one heart");

  // A paused day keeps the same seven too (it neither counts nor breaks), and
  // it must not pay for the run either.
  const paused = await freshDb();
  for (let i = -6; i <= 0; i += 1) await doneDay(paused, i);
  assert.equal((await awardStreakHeart(paused, { now: at(0) })).awarded, true);
  await offDay(paused, 1);
  const off = await streakState(paused, { now: at(1) });
  assert.equal(off.days, 7);
  assert.equal(off.todayGood, false);
  assert.equal((await awardStreakHeart(paused, { now: at(1) })).awarded, false);
  assert.equal(await heartsBalance(paused), 1, "a paused day pays nothing");

  // The day the pause ends still pays only when the run reaches a multiple.
  await doneDay(paused, 2);
  assert.equal((await streakState(paused, { now: at(2) })).todayGood, true);
  assert.equal((await awardStreakHeart(paused, { now: at(2) })).awarded, false);
  assert.equal(await heartsBalance(paused), 1);
});

test("no facts at all is a zero streak, and nothing is awarded", async () => {
  const db = await freshDb();
  assert.deepEqual(await streakState(db, { now: at(0) }), {
    days: 0, nextHeartAt: 7, todayGood: false,
  });
  const c = walletCollector();
  assert.equal((await awardStreakHeart(db, { now: at(0), emit: c.emit })).awarded, false);
  assert.equal(c.rows.length, 0);
  assert.equal(await heartsBalance(db), 0);
});

// --- The all-cards rule: from the upgrade day on, only a complete day counts --

test("streakState writes nothing, with and without an instance's upgrade row", async () => {
  const old = await freshDb();
  for (let i = -6; i <= 0; i += 1) await doneDay(old, i);
  const oldBefore = await walletCounts(old);
  assert.equal((await streakState(old, { now: at(0) })).days, 7);
  assert.deepEqual(await walletCounts(old), oldBefore, "a read is a read");

  const upgraded = await freshDb();
  await upgrade(upgraded, -3);
  for (let i = -3; i <= -1; i += 1) await completeDay(upgraded, i);
  const before = await walletCounts(upgraded);
  assert.deepEqual(await streakState(upgraded, { now: at(0) }), {
    days: 3, nextHeartAt: STREAK_HEART_EVERY, todayGood: false,
  });
  assert.deepEqual(await walletCounts(upgraded), before, "a read is a read after the upgrade too");
  assert.deepEqual(await rowsOfKind(upgraded, MOVE_ALL_KIND), [], "no cache row was written");
});

test("with no upgrade row every day keeps the old rule", async () => {
  const db = await freshDb();
  for (let i = -4; i <= 0; i += 1) await doneDay(db, i);
  assert.deepEqual(await streakState(db, { now: at(0) }), {
    days: 5, nextHeartAt: STREAK_HEART_EVERY, todayGood: true,
  });
  assert.deepEqual(await rowsOfKind(db, STREAK_V2_KIND), [], "reading writes no upgrade row");
});

test("ensureStreakV2 writes the upgrade row once per instance, and never again", async () => {
  const db = await freshDb();
  assert.equal(await ensureStreakV2(db, { day: day(0), now: at(0) }), true);
  assert.deepEqual(await rowsOfKind(db, STREAK_V2_KIND), [day(0)]);

  assert.equal(await ensureStreakV2(db, { day: day(1), now: at(1) }), false,
    "the first day stands");
  assert.deepEqual(await rowsOfKind(db, STREAK_V2_KIND), [day(0)]);

  // A row another instance's upgrade left behind is this instance's start too.
  const shared = await freshDb();
  await upgrade(shared, -1);
  assert.equal(await ensureStreakV2(shared, { day: day(0), now: at(0) }), false);
  assert.deepEqual(await rowsOfKind(shared, STREAK_V2_KIND), [day(-1)]);

  // A day string that is not one writes nothing at all.
  const junk = await freshDb();
  assert.equal(await ensureStreakV2(junk, { day: "yesterday", now: at(0) }), false);
  assert.equal(await ensureStreakV2(junk, {}), false);
  assert.deepEqual(await rowsOfKind(junk, STREAK_V2_KIND), []);
});

test("days before the upgrade day keep the old rule, so an upgrade rewrites no past", async () => {
  const db = await freshDb();
  for (let i = -5; i <= -1; i += 1) await doneDay(db, i);
  await upgrade(db, 0);

  assert.equal((await streakState(db, { now: at(0) })).days, 5,
    "five Done-only days still read five on the upgrade day");
  await completeDay(db, 0);
  assert.deepEqual(await streakState(db, { now: at(0) }), {
    days: 6, nextHeartAt: STREAK_HEART_EVERY, todayGood: true,
  });
});

test("two upgrade rows from two instances: the rule starts on the earliest", async () => {
  const early = "2026-11-20";
  const late = "2026-11-23";
  const noon = new Date(2026, 10, 23, 12, 0, 0).getTime();
  const upgraded = async () => {
    const db = await freshDb();
    await fact(db, STREAK_V2_KIND, early, 1, noon);
    await fact(db, STREAK_V2_KIND, late, 1, noon);
    return db;
  };

  // The 21st carries a Done only: on or after the 20th that is not a day, so
  // the run stops there.
  const doneOnly = await upgraded();
  await completeDayOf(doneOnly, early);
  await fact(doneOnly, MOVE_DONE_KIND, "2026-11-21", 1, noon);
  await completeDayOf(doneOnly, "2026-11-22");
  await completeDayOf(doneOnly, late);
  assert.deepEqual(await streakState(doneOnly, { now: noon }), {
    days: 2, nextHeartAt: STREAK_HEART_EVERY, todayGood: true,
  });

  // The same 21st, finished, counts, and the walk reaches back to the 20th.
  const finished = await upgraded();
  await completeDayOf(finished, early);
  await completeDayOf(finished, "2026-11-21");
  await completeDayOf(finished, "2026-11-22");
  await completeDayOf(finished, late);
  assert.deepEqual(await streakState(finished, { now: noon }), {
    days: 4, nextHeartAt: STREAK_HEART_EVERY, todayGood: true,
  });

  // The later row alone leaves the Done-only 21st under the old rule, which is
  // why the earliest key is the one that decides.
  const onlyLate = await freshDb();
  await fact(onlyLate, STREAK_V2_KIND, late, 1, noon);
  await fact(onlyLate, MOVE_DONE_KIND, early, 1, noon);
  await fact(onlyLate, MOVE_DONE_KIND, "2026-11-21", 1, noon);
  await fact(onlyLate, MOVE_DONE_KIND, "2026-11-22", 1, noon);
  await completeDayOf(onlyLate, late);
  assert.equal((await streakState(onlyLate, { now: noon })).days, 4);
});

test("a missed day after the start breaks the run once it is over", async () => {
  const db = await freshDb();
  await upgrade(db, -2);
  await completeDay(db, -2);
  await completeDay(db, -1);

  // Today has no rows yet: the day is not over, so nothing breaks.
  assert.deepEqual(await streakState(db, { now: at(0) }), {
    days: 2, nextHeartAt: STREAK_HEART_EVERY, todayGood: false,
  });
  // A day later that same today was missed.
  assert.deepEqual(await streakState(db, { now: at(1) }), {
    days: 0, nextHeartAt: STREAK_HEART_EVERY, todayGood: false,
  });
  // Finished, it counts.
  await completeDay(db, 0);
  assert.deepEqual(await streakState(db, { now: at(0) }), {
    days: 3, nextHeartAt: STREAK_HEART_EVERY, todayGood: true,
  });
});

test("a paused day after the start neither counts nor breaks", async () => {
  const db = await freshDb();
  await upgrade(db, -3);
  await completeDay(db, -3);
  await offDay(db, -2);
  await completeDay(db, -1);
  await completeDay(db, 0);
  assert.deepEqual(await streakState(db, { now: at(0) }), {
    days: 3, nextHeartAt: STREAK_HEART_EVERY, todayGood: true,
  });
});

test("the heart lands once at a multiple of seven on an all-cards run", async () => {
  const db = await freshDb();
  await upgrade(db, -6);
  for (let i = -6; i <= 0; i += 1) await completeDay(db, i);

  const first = await awardStreakHeart(db, { now: at(0) });
  assert.equal(first.awarded, true);
  assert.equal(first.days, 7);
  assert.equal(first.key, STREAK_HEART_PREFIX + day(0));
  assert.equal(await heartsBalance(db), 1);

  // A second offer of the same day pays nothing.
  assert.equal((await awardStreakHeart(db, { now: at(0) + 60_000 })).awarded, false);
  assert.equal(await heartsBalance(db), 1);
  assert.deepEqual(await rowsOfKind(db, HEART_KIND), [STREAK_HEART_PREFIX + day(0)]);
});

test("a late-start day with one card done is not a streak day under the new rule", async () => {
  // The day first opened at 18:00, so it asked for all three cards and only one
  // of them was finished — plus a Done, which the old rule alone would take.
  const lateStart = async (db) => {
    for (const i of [-3, -2, 0]) {
      await completeDay(db, i);
      await doneDay(db, i);
    }
    await fact(db, MOVE_NEED_KIND, day(-1), 3);
    await fact(db, MOVE_SLOT_KIND, `${day(-1)}:evening`, 1);
    await fact(db, MOVE_BAL_KIND, day(-1), 1);
    await doneDay(db, -1);
  };

  const upgraded = await freshDb();
  await lateStart(upgraded);
  await upgrade(upgraded, -3);
  assert.deepEqual(await streakState(upgraded, { now: at(0) }), {
    days: 1, nextHeartAt: STREAK_HEART_EVERY, todayGood: true,
  }, "one card Done is not a day on or after the upgrade");

  const old = await freshDb();
  await lateStart(old);
  assert.equal((await streakState(old, { now: at(0) })).days, 4,
    "the same Done is a day under the old rule");
});

test("a day finished only by another instance's rows counts with no local cache row", async () => {
  const db = await freshDb();
  await upgrade(db, -2);
  // Rows of a day another instance finished: its need, its slots, its balance,
  // and no `moveall` anywhere (a cache this instance never kept).
  await completeDay(db, -2);
  await completeDay(db, -1);
  await completeDay(db, 0);
  assert.equal(await rowDelta(db, MOVE_ALL_KIND, day(-1)), null, "no local cache row");
  assert.deepEqual(await streakState(db, { now: at(0) }), {
    days: 3, nextHeartAt: STREAK_HEART_EVERY, todayGood: true,
  });
});