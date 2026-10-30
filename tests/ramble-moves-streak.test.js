/**
 * Moves design Task 5 — the streak.
 *
 * What is pinned here:
 *   - a day counts from a Done, from steps at the goal, or from 10+ minutes of
 *     self-reported logs (alone or in any combination),
 *   - a today that has not qualified yet does not break the streak, and a
 *     missed full day resets it,
 *   - a `moveoff` (paused) day is stepped over: it neither counts nor breaks,
 *   - the streak heart is awarded on each multiple of seven, once per day, and
 *     only on a day that itself qualifies (a morning with no facts yet, or a
 *     paused day, must not pay a second heart for the same run),
 *     and a later missed day never takes a heart away,
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
import { heartsBalance } from "../bundles/ramble/server/hearts.js";
import {
  streakState, awardStreakHeart, STREAK_HEART_EVERY, STREAK_LOG_MINUTES,
} from "../bundles/ramble/server/moves/streak.js";
import { MOVE_DONE_KIND, MOVE_LOG_KIND } from "../bundles/ramble/server/moves/ledger.js";
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