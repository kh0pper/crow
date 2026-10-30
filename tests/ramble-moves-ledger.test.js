/**
 * Moves design Task 4 — the moves ledger, and Health in place of chores.
 *
 * What is pinned here:
 *   - the points table (pure, so it converges on every device),
 *   - the two daily budgets, and the ONE indoor budget shared by chores,
 *     indoor challenge Dones and indoor logs,
 *   - idempotence: Done twice pays once, the same log twice in a minute pays
 *     once, on the button and under Promise.all,
 *   - midnight: the day the caller passes is the day that is credited,
 *   - the sync invariant: no ramble_wallet row written here ever shrinks,
 *   - and the egg rule: a fortnight of maxed indoor days, no steps and no geo,
 *     never reaches `lay.days` (eggs.js `recordHappyDay`).
 *
 * Chores are NOT deleted by this task — they keep their screen until the moves
 * UI replaces it — but their +8 now comes out of the same indoor budget, so
 * both orderings (chores first, moves first) are tested here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { feed, petState, doChore, FEED_DELTAS, MOVE_FEED_MAX } from "../bundles/ramble/server/pet.js";
import { feedAll } from "../bundles/ramble/server/feed.js";
import { layProgress, LAY_DAYS_DEFAULT, localDay } from "../bundles/ramble/server/eggs.js";
import { rowDelta } from "../bundles/ramble/server/steps.js";
import { ACTIVITY_KINDS } from "../bundles/ramble/server/moves/library.js";
import {
  pointsFor, isOutdoorActivity, recordChallengeDone, recordLog, movesDay, movesRoom,
  MovesInputError, MOVE_DONE_KIND, MOVE_INDOOR_KIND, MOVE_OUTDOOR_KIND, MOVE_LOG_KIND,
  INDOOR_DAILY_CAP, OUTDOOR_DAILY_CAP, SINGLE_ENTRY_MAX,
} from "../bundles/ramble/server/moves/ledger.js";
import { applyRambleWallet } from "../servers/sharing/instance-sync.js";

/** Local noon on a fixed local day, so the whole file is timezone-independent. */
const T0 = new Date(2026, 9, 5, 12, 0, 0).getTime();
const DAY0 = localDay(T0);
const HOUR = 3600 * 1000;

async function freshDb() {
  const db = createClient({ url: "file::memory:" });
  await initRambleTables(db);
  return db;
}

/** A library-shaped entry. `recordChallengeDone` reads id/minutes/activity/indoor. */
function entry(over = {}) {
  return {
    id: "test-entry", kind: "pose", title: "Test entry", minutes: 10, level: 1,
    indoor: true, activity: "yoga", equipment: ["none"], tags: [],
    steps: ["do the thing"], works: [], stretches: [], mistakes: [], skipIf: [],
    easier: null, harder: null, sources: [], reviewed: true, pose: {}, ...over,
  };
}

/** Records every wallet row this module emits, in order. */
function collector(seen) {
  return async (table, op, row) => {
    if (table === "ramble_wallet") seen.push({ op, kind: row.kind, key: row.key, delta: Number(row.delta) });
  };
}

async function eggCount(db) {
  const { rows } = await db.execute({ sql: "SELECT count(*) AS n FROM ramble_eggs", args: [] });
  return Number(rows[0].n);
}

/* ---------------------------------------------------------------- points */

test("pointsFor: minutes/2 by effort, rounded, never more than the single-entry max", () => {
  assert.equal(pointsFor({ activity: "yoga", minutes: 10, effort: "easy" }), 5);
  assert.equal(pointsFor({ activity: "yoga", minutes: 10, effort: "moderate" }), 8);   // 7.5 rounds up
  assert.equal(pointsFor({ activity: "yoga", minutes: 10, effort: "hard" }), 10);
  assert.equal(pointsFor({ activity: "yoga", minutes: 1, effort: "easy" }), 1);
  assert.equal(pointsFor({ activity: "walk", minutes: 30, effort: "moderate" }), SINGLE_ENTRY_MAX);
  assert.equal(pointsFor({ activity: "run", minutes: 60, effort: "hard" }), SINGLE_ENTRY_MAX);
  assert.equal(SINGLE_ENTRY_MAX, 20);
});

test("pointsFor pays 0 for anything outside the fixed vocabularies", () => {
  assert.equal(pointsFor({ activity: "Bike ride with a friend", minutes: 30, effort: "moderate" }), 0);
  assert.equal(pointsFor({ activity: "yoga", minutes: 0, effort: "easy" }), 0);
  assert.equal(pointsFor({ activity: "yoga", minutes: 601, effort: "easy" }), 0);
  assert.equal(pointsFor({ activity: "yoga", minutes: 10.5, effort: "easy" }), 0);
  assert.equal(pointsFor({ activity: "yoga", minutes: 10, effort: "heroic" }), 0);
  assert.equal(pointsFor({}), 0);
});

test("isOutdoorActivity splits the whole activity vocabulary, with nothing unclassified", () => {
  for (const a of ["walk", "jog", "run", "cycle", "sport", "swim", "other"]) {
    assert.equal(isOutdoorActivity(a), true, a);
  }
  for (const a of ["yoga", "band", "bodyweight"]) {
    assert.equal(isOutdoorActivity(a), false, a);
  }
  assert.equal(isOutdoorActivity("nonsense"), false);
  assert.equal(isOutdoorActivity(undefined), false);
  // A new activity must be placed deliberately, never fall through silently.
  const classified = ["walk", "jog", "run", "cycle", "sport", "swim", "other", "yoga", "band", "bodyweight"];
  assert.deepEqual([...ACTIVITY_KINDS].sort(), classified.sort());
});

/* -------------------------------------------------------------- Done once */

test("Done twice the same day pays once", async () => {
  const db = await freshDb();
  const seen = [];
  const emit = collector(seen);
  const first = await recordChallengeDone(db, { day: DAY0, entry: entry({ minutes: 10 }), now: T0, emit });
  assert.deepEqual({ paid: first.paid, already: first.already, day: first.day }, { paid: 8, already: false, day: DAY0 });

  const second = await recordChallengeDone(db, {
    day: DAY0, entry: entry({ minutes: 10 }), now: T0 + 60000, emit,
  });
  assert.equal(second.already, true);
  assert.equal(second.paid, 0);

  assert.equal(await rowDelta(db, MOVE_DONE_KIND, DAY0), 1);
  assert.equal(await rowDelta(db, MOVE_INDOOR_KIND, DAY0), 8);
  assert.equal((await petState(db, { now: T0 + 60000 })).energy, 68, "the bird was fed once");
  assert.equal(seen.filter((r) => r.kind === MOVE_DONE_KIND).length, 1);
});

test("Done twice at the SAME INSTANT pays once (two thumbs, one promise each)", async () => {
  const db = await freshDb();
  const [a, b] = await Promise.all([
    recordChallengeDone(db, { day: DAY0, entry: entry({ minutes: 10 }), now: T0 }),
    recordChallengeDone(db, { day: DAY0, entry: entry({ minutes: 10 }), now: T0 }),
  ]);
  assert.equal(a.paid + b.paid, 8, "exactly one of the two taps pays");
  assert.equal([a.already, b.already].filter(Boolean).length, 1);
  assert.equal(await rowDelta(db, MOVE_DONE_KIND, DAY0), 1);
});

/* --------------------------------------------------------------- budgets */

test("indoor pays stop at 24 for the day, across a challenge Done, logs AND chores", async () => {
  const db = await freshDb();
  const done = await recordChallengeDone(db, { day: DAY0, entry: entry({ minutes: 10 }), now: T0 });
  assert.equal(done.paid, 8);

  // Worth 20; only 16 of the indoor budget is left.
  const log1 = await recordLog(db, { activity: "yoga", minutes: 30, effort: "hard", now: T0 + 60000 });
  assert.equal(log1.points, 20);
  assert.equal(log1.paid, 16);
  assert.equal(log1.already, false);

  const log2 = await recordLog(db, { activity: "bodyweight", minutes: 20, effort: "moderate", now: T0 + 120000 });
  assert.equal(log2.paid, 0, "the budget is gone");
  assert.equal(log2.already, false, "but the log itself is still recorded");

  const chore = await doChore(db, "feed", { now: T0 + 180000 });
  assert.equal(chore.done, true, "a capped chore is still ticked off");
  assert.equal(chore.pet.energy, 60 + INDOOR_DAILY_CAP, "but it pays nothing: the budget is gone");

  assert.equal(await rowDelta(db, MOVE_INDOOR_KIND, DAY0), INDOOR_DAILY_CAP);
  const day = await movesDay(db, { day: DAY0 });
  assert.equal(day.done, true);
  assert.equal(day.indoorPaid, INDOOR_DAILY_CAP);
  assert.equal(day.outdoorPaid, 0);
  assert.deepEqual(day.logs, [
    { activity: "yoga", minutes: 30, effort: "hard", paid: 16 },
    { activity: "bodyweight", minutes: 20, effort: "moderate", paid: 0 },
  ], "the day reads back in the order it was logged, with what each actually paid");
  assert.equal((await petState(db, { now: T0 + 180000 })).energy, 60 + INDOOR_DAILY_CAP);
});

test("outdoor logs stop at 20 for the day and never draw the indoor budget", async () => {
  const db = await freshDb();
  let paid = 0;
  for (let i = 0; i < 6; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const out = await recordLog(db, { activity: "run", minutes: 30, effort: "hard", now: T0 + i * 60000 });
    assert.equal(out.points, SINGLE_ENTRY_MAX);
    paid += out.paid;
  }
  assert.equal(paid, OUTDOOR_DAILY_CAP);
  assert.equal(await rowDelta(db, MOVE_OUTDOOR_KIND, DAY0), OUTDOOR_DAILY_CAP);
  const day = await movesDay(db, { day: DAY0 });
  assert.equal(day.outdoorPaid, OUTDOOR_DAILY_CAP);
  assert.equal(day.indoorPaid, 0);
  assert.equal(day.logs.filter((l) => l.paid > 0).length, 1, "only the first log had budget to take");
});

test("an outdoor log is cut to the remainder, not refused", async () => {
  const db = await freshDb();
  const a = await recordLog(db, { activity: "walk", minutes: 20, effort: "moderate", now: T0 });
  assert.equal(a.paid, 15);
  const b = await recordLog(db, { activity: "walk", minutes: 20, effort: "moderate", now: T0 + 60000 });
  assert.equal(b.paid, OUTDOOR_DAILY_CAP - 15, "the last of the budget");
  assert.equal(b.capped, true);
  assert.equal(await rowDelta(db, MOVE_OUTDOOR_KIND, DAY0), OUTDOOR_DAILY_CAP);
});

test("the same log twice in one minute pays once; the next minute is a new fact", async () => {
  const db = await freshDb();
  const a = await recordLog(db, { activity: "walk", minutes: 20, effort: "moderate", now: T0 });
  const b = await recordLog(db, { activity: "walk", minutes: 20, effort: "moderate", now: T0 + 15000 });
  assert.equal(a.already, false);
  assert.equal(a.key, b.key, "the key is the day, the minute and the parsed result");
  assert.equal(b.already, true);
  assert.equal(b.paid, 0);
  assert.equal(await rowDelta(db, MOVE_OUTDOOR_KIND, DAY0), 15);

  const c = await recordLog(db, { activity: "walk", minutes: 20, effort: "moderate", now: T0 + 60000 });
  assert.equal(c.already, false);
  assert.notEqual(c.key, a.key);
  assert.equal(c.paid, 5, "the outdoor budget's remainder");
});

test("the same log twice at the SAME INSTANT pays once", async () => {
  const db = await freshDb();
  const [a, b] = await Promise.all([
    recordLog(db, { activity: "yoga", minutes: 10, effort: "easy", now: T0 }),
    recordLog(db, { activity: "yoga", minutes: 10, effort: "easy", now: T0 }),
  ]);
  assert.equal(a.paid + b.paid, 5);
  assert.equal(await rowDelta(db, MOVE_INDOOR_KIND, DAY0), 5);
});

test("a log the budget could not pay leaves an honest 0 in the ledger", async () => {
  const db = await freshDb();
  await recordLog(db, { activity: "yoga", minutes: 60, effort: "hard", now: T0 });          // 20
  await recordLog(db, { activity: "band", minutes: 20, effort: "moderate", now: T0 + 60000 }); // 15 -> 4
  const zero = await recordLog(db, { activity: "yoga", minutes: 10, effort: "easy", now: T0 + 120000 });
  assert.equal(zero.paid, 0);
  const { rows } = await db.execute({
    sql: "SELECT delta FROM ramble_wallet WHERE kind = ? AND key = ?",
    args: [MOVE_LOG_KIND, zero.key],
  });
  assert.equal(Number(rows[0].delta), 0, "the marker records what it paid, not what it was worth");
});

/* ----------------------------------------------------------------- chores */

test("chores still exist, still pay 8 first, and together are exactly the indoor budget", async () => {
  assert.equal(FEED_DELTAS.chore, 8, "a chore is nominally 8 ...");
  assert.equal(3 * FEED_DELTAS.chore, INDOOR_DAILY_CAP, "... and three of them are the whole indoor budget");

  const db = await freshDb();
  const a = await doChore(db, "feed", { now: T0 });
  assert.equal(a.done, true);
  assert.equal(a.pet.energy, 60 + FEED_DELTAS.chore);
  assert.equal(await rowDelta(db, MOVE_INDOOR_KIND, DAY0), 8);

  const repeat = await doChore(db, "feed", { now: T0 + 1000 });
  assert.equal(repeat.done, false);
  assert.equal(repeat.pet.energy, 68, "a repeat neither pays nor re-ticks");
  assert.equal(await rowDelta(db, MOVE_INDOOR_KIND, DAY0), 8);

  assert.equal((await doChore(db, "preen", { now: T0 + 2000 })).pet.energy, 76);
  assert.equal((await doChore(db, "play", { now: T0 + 3000 })).pet.energy, 84);
  assert.equal(await rowDelta(db, MOVE_INDOOR_KIND, DAY0), INDOOR_DAILY_CAP);

  const log = await recordLog(db, { activity: "yoga", minutes: 30, effort: "hard", now: T0 + 4000 });
  assert.equal(log.paid, 0, "three chores are the whole indoor budget, exactly as they always were");
  const s = await petState(db, { now: T0 + 4000 });
  assert.equal(s.energy, 84);
  assert.deepEqual(Object.keys(s.chores).sort(), ["day", "feed", "play", "preen"]);
});

test("a day spent on indoor moves leaves the chores the remainder — and still marks them done", async () => {
  const db = await freshDb();
  const log = await recordLog(db, { activity: "yoga", minutes: 60, effort: "hard", now: T0 });
  assert.equal(log.paid, 20);

  const a = await doChore(db, "feed", { now: T0 + 1000 });
  assert.equal(a.done, true);
  assert.equal(a.pet.energy, 80 + (INDOOR_DAILY_CAP - 20), "the remainder of the shared budget");
  assert.equal(await rowDelta(db, MOVE_INDOOR_KIND, DAY0), INDOOR_DAILY_CAP);

  const b = await doChore(db, "preen", { now: T0 + 2000 });
  assert.equal(b.done, true, "never a punishment: the chore is done, the pay is what was left");
  assert.equal(b.chores.preen, true);
  assert.equal(b.pet.energy, 84, "nothing left to pay");
  assert.equal(await rowDelta(db, MOVE_INDOOR_KIND, DAY0), INDOOR_DAILY_CAP, "and the budget never goes over");
});

/* --------------------------------------------------------------- midnight */

test("a challenge picked for day D and Done at 00:02 of D+1 credits D, never both days", async () => {
  const db = await freshDb();
  const picked = new Date(2026, 9, 5, 23, 58).getTime();
  const doneAt = new Date(2026, 9, 6, 0, 2).getTime();
  const dayD = localDay(picked);
  const dayD1 = localDay(doneAt);
  assert.notEqual(dayD, dayD1, "the fixture really does cross local midnight");

  const out = await recordChallengeDone(db, { day: dayD, entry: entry({ minutes: 10 }), now: doneAt });
  assert.equal(out.day, dayD);
  assert.equal(out.paid, 8);
  assert.equal(await rowDelta(db, MOVE_DONE_KIND, dayD), 1);
  assert.equal(await rowDelta(db, MOVE_INDOOR_KIND, dayD), 8);
  assert.equal(await rowDelta(db, MOVE_DONE_KIND, dayD1), null, "the new day is untouched");
  assert.equal(await rowDelta(db, MOVE_INDOOR_KIND, dayD1), null);

  assert.equal((await movesDay(db, { day: dayD })).done, true);
  assert.equal((await movesDay(db, { day: dayD1 })).done, false);

  // D+1's own challenge is a separate fact and still pays.
  const next = await recordChallengeDone(db, { day: dayD1, entry: entry({ minutes: 10 }), now: doneAt + 60000 });
  assert.equal(next.paid, 8);
  assert.equal((await movesDay(db, { day: dayD1 })).indoorPaid, 8);
  assert.equal((await movesDay(db, { day: dayD })).indoorPaid, 8, "and D did not move");
});

test("a Done with no day falls back to the local day of `now`, and a junk day cannot lose the pay", async () => {
  const db = await freshDb();
  const late = new Date(2026, 9, 6, 0, 2).getTime();
  const out = await recordChallengeDone(db, { entry: entry({ minutes: 10 }), now: late });
  assert.equal(out.day, localDay(late));
  const junk = await recordChallengeDone(db, { day: "not-a-day", entry: entry({ minutes: 10 }), now: late + HOUR });
  assert.equal(junk.already, true, "same local day as the fallback above: still one Done per day");
});

/* ------------------------------------------------------------- validation */

test("recordLog and recordChallengeDone reject anything off the fixed vocabulary, writing nothing", async () => {
  const db = await freshDb();
  const bad = [
    () => recordLog(db, { activity: "Bike ride with a friend", minutes: 30, effort: "moderate", now: T0 }),
    () => recordLog(db, { activity: "walk", minutes: 0, effort: "easy", now: T0 }),
    () => recordLog(db, { activity: "walk", minutes: 601, effort: "easy", now: T0 }),
    () => recordLog(db, { activity: "walk", minutes: 30.5, effort: "easy", now: T0 }),
    () => recordLog(db, { activity: "walk", minutes: 30, effort: "gentle", now: T0 }),
    () => recordLog(db, { activity: "walk", minutes: 30, now: T0 }),
    () => recordLog(db, { minutes: 30, effort: "easy", now: T0 }),
    () => recordChallengeDone(db, { day: DAY0, entry: null, now: T0 }),
    () => recordChallengeDone(db, { day: DAY0, entry: { id: "x", activity: "yoga", minutes: 0 }, now: T0 }),
    () => recordChallengeDone(db, { day: DAY0, entry: { minutes: 10, activity: "yoga" }, now: T0 }),
    () => recordChallengeDone(db, { day: DAY0, entry: { id: "x", activity: "strolling", minutes: 10 }, now: T0 }),
  ];
  for (const fn of bad) {
    // eslint-disable-next-line no-await-in-loop
    await assert.rejects(fn, MovesInputError);
  }
  const { rows } = await db.execute({ sql: "SELECT count(*) AS n FROM ramble_wallet", args: [] });
  assert.equal(Number(rows[0].n), 0, "a rejected move writes no ledger row — and stores no free text");
});

/* ------------------------------------------------------------ the pet seam */

test("the `move` feed event is bounded by MOVE_FEED_MAX, not by the energy ceiling", async () => {
  const db = await freshDb();
  await giveHearts(db, 11);   // ceiling 210, so the bound below is what bites
  const a = await feed(db, { type: "move", amount: 1_000_000_000 }, { now: T0 });
  assert.equal(a.energy_max, 210);
  assert.equal(a.energy, 60 + MOVE_FEED_MAX);
});

test("a `move` moves the decay clock (as a chore did); steps still do not", async () => {
  const db = await freshDb();
  const a = await feed(db, { type: "move", amount: 7 }, { now: T0 });
  assert.equal(a.energy, 67);
  assert.equal(a.last_fed_at, T0);
  assert.deepEqual([a.places_week, a.unlocks_week, a.crows_week], [0, 0, 0], "a move bumps no weekly counter");

  const b = await feed(db, { type: "move", amount: 40 }, { now: T0 + 1000 });
  assert.equal(b.energy, 100, "clamped by the ceiling");
  assert.equal(b.last_fed_at, T0 + 1000);

  const c = await feed(db, { type: "move", amount: -5 }, { now: T0 + 2000 });
  assert.equal(c.energy, 100, "a negative move pays nothing");
  assert.equal(c.last_fed_at, T0 + 1000, "and does not move the clock");

  const d = await feed(db, { type: "move", amount: "junk" }, { now: T0 + 3000 });
  assert.equal(d.last_fed_at, T0 + 1000);

  const s = await feed(db, { type: "steps", amount: 5 }, { now: T0 + 4000 });
  assert.equal(s.last_fed_at, T0 + 1000, "R5: readings never reset the decay clock");

  await assert.rejects(() => feed(db, { type: "nonsense" }, { now: T0 }));
});

/* ------------------------------------------------------------- sync safety */

test("no ramble_wallet row written here ever shrinks", async () => {
  const db = await freshDb();
  const seen = [];
  const emit = collector(seen);

  await feedAll(db, { type: "checkin" }, { now: T0, emit });
  await doChore(db, "feed", { now: T0 + 1000, emit });
  await doChore(db, "preen", { now: T0 + 2000, emit });
  await recordChallengeDone(db, { day: DAY0, entry: entry({ minutes: 20 }), now: T0 + 3000, emit });
  await recordLog(db, { activity: "band", minutes: 15, effort: "moderate", now: T0 + 4000, emit });
  await recordLog(db, { activity: "band", minutes: 15, effort: "moderate", now: T0 + 4000, emit });
  await recordLog(db, { activity: "walk", minutes: 45, effort: "hard", now: T0 + 5000, emit });
  await doChore(db, "play", { now: T0 + 6000, emit });
  await recordChallengeDone(db, { day: DAY0, entry: entry({ minutes: 20 }), now: T0 + 7000, emit });
  await recordLog(db, { activity: "swim", minutes: 30, effort: "easy", now: T0 + 8000, emit });

  assert.ok(seen.length > 5, "the sequence really did write ledger rows");
  const last = new Map();
  for (const r of seen) {
    const k = r.kind + "|" + r.key;
    const prev = last.get(k);
    assert.ok(r.delta >= 0, `never a negative delta: ${k}`);
    assert.ok(prev === undefined || r.delta >= prev, `a wallet row shrank: ${k} ${prev} -> ${r.delta}`);
    last.set(k, r.delta);
  }
  // What is on disk is what was last emitted, row for row.
  for (const [k, delta] of last) {
    const cut = k.indexOf("|");
    // eslint-disable-next-line no-await-in-loop
    assert.equal(await rowDelta(db, k.slice(0, cut), k.slice(cut + 1)), delta, k);
  }
});

test("a budget row a merge pushed ABOVE the cap pays nothing and is never written down", async () => {
  const db = await freshDb();
  // Stand-in for two instances each filling their own budget, then syncing.
  await db.execute({
    sql: "INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES (?, ?, ?, ?)",
    args: [MOVE_INDOOR_KIND, DAY0, INDOOR_DAILY_CAP + 6, T0],
  });
  const seen = [];
  const out = await recordLog(db, { activity: "yoga", minutes: 30, effort: "hard", now: T0, emit: collector(seen) });
  assert.equal(out.paid, 0);
  assert.equal(await rowDelta(db, MOVE_INDOOR_KIND, DAY0), INDOOR_DAILY_CAP + 6, "never shrinks");
  assert.equal(seen.filter((r) => r.kind === MOVE_INDOOR_KIND).length, 0, "and is never re-emitted lower");
  assert.equal((await movesDay(db, { day: DAY0 })).indoorPaid, INDOOR_DAILY_CAP, "readers clamp, like stepsToday");
  assert.equal((await movesRoom(db, { day: DAY0, now: T0 })).indoor, 0);
});

test("MULTI-INSTANCE: a peer's move rows converge, and re-applying them changes nothing", async () => {
  const a = await freshDb();
  const b = await freshDb();
  const ops = [];
  const emit = async (table, op, row) => { if (table === "ramble_wallet") ops.push([op, row]); };

  await recordLog(a, { activity: "yoga", minutes: 20, effort: "moderate", now: T0, emit });           // 15
  await recordChallengeDone(a, { day: DAY0, entry: entry({ minutes: 10 }), now: T0 + 60000, emit });  // 8
  await recordLog(a, { activity: "walk", minutes: 20, effort: "easy", now: T0 + 120000, emit });      // 10

  for (const [op, row] of ops) await applyRambleWallet(b, op, row, 1);
  const dayB = await movesDay(b, { day: DAY0 });
  assert.equal(dayB.indoorPaid, 23);
  assert.equal(dayB.outdoorPaid, 10);
  assert.equal(dayB.done, true);
  assert.deepEqual(dayB.logs, [
    { activity: "yoga", minutes: 20, effort: "moderate", paid: 15 },
    { activity: "walk", minutes: 20, effort: "easy", paid: 10 },
  ]);

  // Idempotent re-delivery, and a LATER lamport carrying a SMALLER delta.
  for (const [op, row] of ops) await applyRambleWallet(b, op, row, 2);
  await applyRambleWallet(b, "update", { kind: MOVE_INDOOR_KIND, key: DAY0, delta: 3, created_at: T0 }, 9);
  const again = await movesDay(b, { day: DAY0 });
  assert.equal(again.indoorPaid, 23, "MAX(delta): a peer can never take a day's Health away");
  assert.deepEqual(again.logs, dayB.logs);
});

/* ------------------------------------------------------------ the egg rule */

test("EGG SIMULATION: a fortnight of maxed indoor days, no steps and no geo, never reaches lay.days", async () => {
  const db = await freshDb();
  const seen = [];
  const emit = collector(seen);
  let maxIndoor = 0;

  for (let i = 0; i < 14; i += 1) {
    const t = new Date(2026, 9, 5 + i, 12).getTime();
    // The bird's owed decay lands first, exactly as any panel read applies it:
    // four 6 h intervals per day, -40.
    // eslint-disable-next-line no-await-in-loop
    await petState(db, { now: t });
    // eslint-disable-next-line no-await-in-loop
    await feedAll(db, { type: "checkin" }, { now: t, emit });            // the 5-point check-in
    for (const kind of ["feed", "preen", "play"]) {
      // eslint-disable-next-line no-await-in-loop
      await doChore(db, kind, { now: t, emit });                          // 3 x 8, the old budget
    }
    // Max indoor moves on top: four 60-minute hard logs and a challenge Done,
    // all competing for the same 24.
    for (const m of [1, 2, 3, 4]) {
      // eslint-disable-next-line no-await-in-loop
      await recordLog(db, { activity: m % 2 ? "yoga" : "bodyweight", minutes: 60, effort: "hard", now: t + m * 60000, emit });
    }
    // eslint-disable-next-line no-await-in-loop
    await recordChallengeDone(db, { day: localDay(t), entry: entry({ id: "sim-" + i, minutes: 30 }), now: t + 5 * 60000, emit });

    // eslint-disable-next-line no-await-in-loop
    const day = await movesDay(db, { day: localDay(t) });
    assert.ok(day.indoorPaid <= INDOOR_DAILY_CAP, "the cap holds every day");
    maxIndoor = Math.max(maxIndoor, day.indoorPaid);
    // eslint-disable-next-line no-await-in-loop
    await petState(db, { now: t + 6 * HOUR });
  }

  assert.equal(maxIndoor, INDOOR_DAILY_CAP, "every day really was maxed indoors");
  const { days, needed } = await layProgress(db);
  assert.equal(needed, LAY_DAYS_DEFAULT);
  assert.ok(days < LAY_DAYS_DEFAULT,
    `indoor-only banked ${days} lay days — check-in 5 + indoor moves and chores 24 = 29/day against 40/day of decay must never reach ${LAY_DAYS_DEFAULT}`);
  assert.equal(await eggCount(db), 0, "no egg was ever laid");

  const { rows } = await db.execute({ sql: "SELECT DISTINCT kind FROM ramble_wallet", args: [] });
  assert.deepEqual(rows.map((r) => r.kind).sort(), ["layday", "moveindoor", "movelog", "movedone"].sort(),
    "no steps, no walked badge, no seed: this really was an indoor-only fortnight");
});

/* ------------------------------------------------------------------ helpers */

const HEART_CELLS = ["9vk79ed", "9v6m2xt", "dr5regw", "gcpvj0d", "u33dc0e", "wecnrmd"];

async function giveHearts(db, n) {
  // Ledger rows directly, as tests/ramble-pet.test.js does: these tests are
  // about the moves ledger, not the heart pickup path.
  for (let i = 0; i < n; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await db.execute({
      sql: "INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES ('heart', ?, 1, 0)",
      args: [HEART_CELLS[i % HEART_CELLS.length] + ":moves" + i],
    });
  }
}
