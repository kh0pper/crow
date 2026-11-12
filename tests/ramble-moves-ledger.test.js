/**
 * Moves design Task 4 — the moves ledger, and Health in place of chores.
 *
 * What is pinned here:
 *   - the chunk rate (pure, so it converges on every device): 1.2 Health a
 *     minute, at most 20 for one entry, whatever the effort,
 *   - the two daily budgets of 40, and the ONE indoor budget shared by an
 *     indoor challenge Done and an indoor log,
 *   - mark and pay are two writes: `markChallengeDone` burns the day's Done
 *     and pays nothing, `recordChallengeDone` is that plus one claim,
 *   - idempotence: Done twice pays once, the same log twice in a minute pays
 *     once, on the button and under Promise.all,
 *   - midnight: the day the caller passes is the day that is credited,
 *   - the sync invariant: no ramble_wallet row written here ever shrinks,
 *   - and the egg rule: a lay day needs a REAL-MOVEMENT fact (eggs.js
 *     `hasRealMovement`), not a budget size — so a month of indoor-only days
 *     banks happy days and still never lays, while a walker's fortnight does.
 *
 * The old daily chores are gone. The egg simulations run on recordLog,
 * recordChallengeDone, step readings and the "I walked today" tap only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { feed, petState, MOVE_FEED_MAX } from "../bundles/ramble/server/pet.js";
import { feedAll } from "../bundles/ramble/server/feed.js";
import { layProgress, LAY_DAYS_DEFAULT, LAYDAY_KIND, LAY_KIND, localDay } from "../bundles/ramble/server/eggs.js";
import { rowDelta, recordStepReading, settleDay, recordWalkCheckin } from "../bundles/ramble/server/steps.js";
import { ACTIVITY_KINDS } from "../bundles/ramble/server/moves/library.js";
import {
  pointsFor, chunkPoints, isOutdoorActivity, markChallengeDone, recordChallengeDone, recordLog,
  movesDay, movesRoom, MovesInputError, MOVE_DONE_KIND, MOVE_INDOOR_KIND, MOVE_OUTDOOR_KIND,
  MOVE_LOG_KIND, INDOOR_DAILY_CAP, OUTDOOR_DAILY_CAP, SINGLE_ENTRY_MAX, CHUNK_RATE, CHUNK_MAX,
  ACTIVITY_AREA,
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

/** Every `ramble_wallet` row, ordered, for a whole-table before/after comparison. */
async function walletRows(db) {
  const { rows } = await db.execute({
    sql: "SELECT kind, key, delta, created_at FROM ramble_wallet ORDER BY kind, key",
    args: [],
  });
  return rows.map((r) => ({
    kind: String(r.kind), key: String(r.key), delta: Number(r.delta), created_at: Number(r.created_at),
  }));
}

async function countKind(db, kind) {
  const { rows } = await db.execute({ sql: "SELECT count(*) AS n FROM ramble_wallet WHERE kind = ?", args: [kind] });
  return Number(rows[0].n);
}

async function walletKinds(db) {
  const { rows } = await db.execute({ sql: "SELECT DISTINCT kind FROM ramble_wallet ORDER BY kind", args: [] });
  return rows.map((r) => String(r.kind));
}

/* ---------------------------------------------------------- points */

test("pointsFor: the chunk rate, one chunk's worth, whatever the effort", () => {
  assert.equal(pointsFor({ activity: "yoga", minutes: 10, effort: "easy" }), 12);
  assert.equal(pointsFor({ activity: "yoga", minutes: 10, effort: "moderate" }), 12);
  assert.equal(pointsFor({ activity: "yoga", minutes: 10, effort: "hard" }), 12);
  assert.equal(pointsFor({ activity: "yoga", minutes: 1, effort: "easy" }), 1);
  assert.equal(pointsFor({ activity: "walk", minutes: 30, effort: "moderate" }), SINGLE_ENTRY_MAX);
  assert.equal(pointsFor({ activity: "run", minutes: 60, effort: "hard" }), SINGLE_ENTRY_MAX);
  assert.equal(SINGLE_ENTRY_MAX, CHUNK_MAX);
  assert.equal(SINGLE_ENTRY_MAX, 20);
});

test("chunkPoints: 1.2 a minute, one chunk never worth more than 20, the budgets are 40", () => {
  assert.equal(CHUNK_RATE, 1.2);
  assert.equal(chunkPoints(10), 12);
  assert.equal(chunkPoints(5), 6);
  assert.equal(chunkPoints(15), 18);
  assert.equal(chunkPoints(30), CHUNK_MAX);
  assert.equal(chunkPoints(60), CHUNK_MAX);
  for (const junk of [NaN, -3, 0, Infinity, "x", undefined, null, {}, []]) {
    assert.equal(chunkPoints(junk), 0, `${String(junk)} is worth nothing`);
  }
  assert.equal(INDOOR_DAILY_CAP, 40);
  assert.equal(OUTDOOR_DAILY_CAP, 40);
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
  assert.deepEqual({ paid: first.paid, already: first.already, day: first.day }, { paid: 12, already: false, day: DAY0 });

  const second = await recordChallengeDone(db, {
    day: DAY0, entry: entry({ minutes: 10 }), now: T0 + 60000, emit,
  });
  assert.equal(second.already, true);
  assert.equal(second.paid, 0);

  assert.equal(await rowDelta(db, MOVE_DONE_KIND, DAY0), 1);
  assert.equal(await rowDelta(db, MOVE_INDOOR_KIND, DAY0), 12);
  assert.equal((await petState(db, { now: T0 + 60000 })).energy, 72, "the bird was fed once");
  assert.equal(seen.filter((r) => r.kind === MOVE_DONE_KIND).length, 1);
});

test("Done twice at the SAME INSTANT pays once (two thumbs, one promise each)", async () => {
  const db = await freshDb();
  const [a, b] = await Promise.all([
    recordChallengeDone(db, { day: DAY0, entry: entry({ minutes: 10 }), now: T0 }),
    recordChallengeDone(db, { day: DAY0, entry: entry({ minutes: 10 }), now: T0 }),
  ]);
  assert.equal(a.paid + b.paid, 12, "exactly one of the two taps pays");
  assert.equal([a.already, b.already].filter(Boolean).length, 1);
  assert.equal(await rowDelta(db, MOVE_DONE_KIND, DAY0), 1);
});

/* --------------------------------------------------------------- budgets */

test("indoor pays stop at 40 for the day, across a challenge Done and logs", async () => {
  const db = await freshDb();
  const done = await recordChallengeDone(db, { day: DAY0, entry: entry({ minutes: 10 }), now: T0 });
  assert.equal(done.paid, 12);

  // Worth 20; 28 of the indoor budget is left.
  const log1 = await recordLog(db, { activity: "yoga", minutes: 30, effort: "hard", now: T0 + 60000 });
  assert.equal(log1.points, 20);
  assert.equal(log1.paid, 20);
  assert.equal(log1.already, false);

  const log2 = await recordLog(db, { activity: "bodyweight", minutes: 20, effort: "moderate", now: T0 + 120000 });
  assert.equal(log2.paid, INDOOR_DAILY_CAP - 12 - 20, "the last of the budget");

  const log3 = await recordLog(db, { activity: "band", minutes: 20, effort: "moderate", now: T0 + 180000 });
  assert.equal(log3.paid, 0, "the budget is gone");
  assert.equal(log3.already, false, "but the log itself is still recorded");

  assert.equal(await rowDelta(db, MOVE_INDOOR_KIND, DAY0), INDOOR_DAILY_CAP);
  const day = await movesDay(db, { day: DAY0 });
  assert.equal(day.done, true);
  assert.equal(day.indoorPaid, INDOOR_DAILY_CAP);
  assert.equal(day.outdoorPaid, 0);
  assert.deepEqual(day.logs, [
    { activity: "yoga", minutes: 30, effort: "hard", paid: 20 },
    { activity: "bodyweight", minutes: 20, effort: "moderate", paid: INDOOR_DAILY_CAP - 12 - 20 },
    { activity: "band", minutes: 20, effort: "moderate", paid: 0 },
  ], "the day reads back in the order it was logged, with what each actually paid");
  assert.equal((await petState(db, { now: T0 + 240000 })).energy, 60 + INDOOR_DAILY_CAP);
});

test("outdoor logs stop at 40 for the day and never draw the indoor budget", async () => {
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
  assert.equal(day.logs.filter((l) => l.paid > 0).length, 2, "only the first two logs had budget to take");
});

test("an outdoor log is cut to the remainder, not refused", async () => {
  const db = await freshDb();
  const a = await recordLog(db, { activity: "walk", minutes: 30, effort: "moderate", now: T0 });
  assert.equal(a.paid, 20);
  const b = await recordLog(db, { activity: "walk", minutes: 10, effort: "moderate", now: T0 + 60000 });
  assert.equal(b.paid, 12);
  const c = await recordLog(db, { activity: "walk", minutes: 30, effort: "moderate", now: T0 + 120000 });
  assert.equal(c.paid, OUTDOOR_DAILY_CAP - 32, "the last of the budget");
  assert.equal(c.capped, true);
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
  assert.equal(await rowDelta(db, MOVE_OUTDOOR_KIND, DAY0), 20);

  const c = await recordLog(db, { activity: "walk", minutes: 20, effort: "moderate", now: T0 + 60000 });
  assert.equal(c.already, false);
  assert.notEqual(c.key, a.key);
  assert.equal(c.paid, 20, "a new minute is a new claim against the day's budget");
  assert.equal(await rowDelta(db, MOVE_OUTDOOR_KIND, DAY0), 40);
});

test("the same log twice at the SAME INSTANT pays once", async () => {
  const db = await freshDb();
  const [a, b] = await Promise.all([
    recordLog(db, { activity: "yoga", minutes: 10, effort: "easy", now: T0 }),
    recordLog(db, { activity: "yoga", minutes: 10, effort: "easy", now: T0 }),
  ]);
  assert.equal(a.paid + b.paid, 12);
  assert.equal(await rowDelta(db, MOVE_INDOOR_KIND, DAY0), 12);
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

test("the old chore purse is gone: no chore event pays, and Done + logs still cap at 40", async () => {
  const db = await freshDb();
  await assert.rejects(() => feed(db, { type: "chore" }, { now: T0 }));

  const done = await recordChallengeDone(db, { day: DAY0, entry: entry({ minutes: 10 }), now: T0 });
  assert.equal(done.paid, 12);
  const log = await recordLog(db, { activity: "yoga", minutes: 60, effort: "hard", now: T0 + 1000 });
  assert.equal(log.paid, 20);
  const again = await recordLog(db, { activity: "band", minutes: 30, effort: "hard", now: T0 + 2000 });
  assert.equal(again.paid, INDOOR_DAILY_CAP - done.paid - log.paid, "the rest of the shared budget");
  const empty = await recordLog(db, { activity: "bodyweight", minutes: 30, effort: "hard", now: T0 + 3000 });
  assert.equal(empty.paid, 0, "the purse is empty");
  assert.equal(await rowDelta(db, MOVE_INDOOR_KIND, DAY0), INDOOR_DAILY_CAP);
  const s = await petState(db, { now: T0 + 2000 });
  assert.equal(s.energy, 60 + INDOOR_DAILY_CAP);
});

test("a day spent on indoor moves leaves the challenge the remainder — and the Done still counts", async () => {
  const db = await freshDb();
  const log = await recordLog(db, { activity: "yoga", minutes: 60, effort: "hard", now: T0 });
  assert.equal(log.paid, 20);
  const log2 = await recordLog(db, { activity: "band", minutes: 10, effort: "easy", now: T0 + 60000 });
  assert.equal(log2.paid, 12);

  const done = await recordChallengeDone(db, { day: DAY0, entry: entry({ minutes: 10 }), now: T0 + 120000 });
  assert.equal(done.already, false);
  assert.equal(done.paid, INDOOR_DAILY_CAP - 32, "the remainder of the shared budget");
  assert.equal((await petState(db, { now: T0 + 120000 })).energy, 60 + INDOOR_DAILY_CAP);
  assert.equal(await rowDelta(db, MOVE_INDOOR_KIND, DAY0), INDOOR_DAILY_CAP);

  const day = await movesDay(db, { day: DAY0 });
  assert.equal(day.done, true, "never a punishment: the Done is still a Done");
  assert.equal(day.indoorPaid, INDOOR_DAILY_CAP, "and the budget never goes over");
});

/* ------------------------------------------------------------ mark and pay */

test("markChallengeDone marks the day Done and pays nothing at all", async () => {
  const db = await freshDb();
  await feedAll(db, { type: "checkin" }, { now: T0 });
  // An unrelated wallet row, so "the table is unchanged" is a real comparison.
  await db.execute({
    sql: "INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES ('seed', 'pickup:mark', 9, ?)",
    args: [T0],
  });
  const before = await walletRows(db);
  const energyBefore = (await petState(db, { now: T0 })).energy;
  assert.equal(energyBefore, 65, "the check-in fed the bird; the mark must not");

  const mark = await markChallengeDone(db, { day: DAY0, entry: entry({ minutes: 10 }), now: T0 + 60000 });
  assert.deepEqual(mark, { fresh: true, day: DAY0 });

  const after = await walletRows(db);
  assert.equal(after.length, before.length + 1, "exactly one wallet row was written");
  assert.deepEqual(after.filter((r) => r.kind === MOVE_DONE_KIND), [
    { kind: MOVE_DONE_KIND, key: DAY0, delta: 1, created_at: T0 + 60000 },
  ], "and it is the Done marker");
  assert.deepEqual(after.filter((r) => r.kind !== MOVE_DONE_KIND), before, "every other row is untouched");

  assert.equal(await rowDelta(db, MOVE_INDOOR_KIND, DAY0), null, "no budget row was claimed");
  assert.equal(await rowDelta(db, MOVE_OUTDOOR_KIND, DAY0), null);
  assert.equal((await petState(db, { now: T0 + 60000 })).energy, energyBefore, "the bird was not fed");
  const day = await movesDay(db, { day: DAY0 });
  assert.equal(day.done, true);
  assert.equal(day.indoorPaid, 0, "and nothing was paid");

  const twice = await markChallengeDone(db, { day: DAY0, entry: entry({ minutes: 10 }), now: T0 + 120000 });
  assert.equal(twice.fresh, false, "the mark is once a day");
  assert.equal(await rowDelta(db, MOVE_DONE_KIND, DAY0), 1);
});

test("recordChallengeDone on a 10-minute entry pays 12 and writes the row a mark writes", async () => {
  const marked = await freshDb();
  const paidDb = await freshDb();
  const mark = await markChallengeDone(marked, { day: DAY0, entry: entry({ minutes: 10 }), now: T0 });
  const done = await recordChallengeDone(paidDb, { day: DAY0, entry: entry({ minutes: 10 }), now: T0 });
  assert.equal(mark.fresh, true);
  assert.deepEqual({ paid: done.paid, points: done.points, already: done.already, day: done.day },
    { paid: 12, points: 12, already: false, day: DAY0 });

  assert.deepEqual(
    (await walletRows(paidDb)).filter((r) => r.kind === MOVE_DONE_KIND),
    (await walletRows(marked)).filter((r) => r.kind === MOVE_DONE_KIND),
    "the same movedone row markChallengeDone would have written",
  );
  assert.equal(await rowDelta(paidDb, MOVE_INDOOR_KIND, DAY0), 12, "and the chunk was paid out of the indoor budget");
});

test("markChallengeDone then recordChallengeDone the same day pays nothing", async () => {
  const db = await freshDb();
  await markChallengeDone(db, { day: DAY0, entry: entry({ minutes: 10 }), now: T0 });
  const late = await recordChallengeDone(db, { day: DAY0, entry: entry({ minutes: 10 }), now: T0 + 60000 });
  assert.equal(late.already, true);
  assert.equal(late.paid, 0);
  assert.equal(late.points, 12, "the card is still worth a chunk; it was just not paid on the tap");
  assert.equal(late.day, DAY0);
  assert.equal(await rowDelta(db, MOVE_INDOOR_KIND, DAY0), null, "no budget row was opened");
  assert.equal((await movesDay(db, { day: DAY0 })).indoorPaid, 0, "so the budget reads 0");
  assert.equal((await petState(db, { now: T0 + 60000 })).energy, 60, "and the bird was never fed");
  assert.equal(await rowDelta(db, MOVE_DONE_KIND, DAY0), 1);
});

test("a junk entry is refused before the day's Done is burned", async () => {
  const db = await freshDb();
  const junk = [
    { day: DAY0, entry: null },
    { day: DAY0, entry: { minutes: 10, activity: "yoga" } },
    { day: DAY0, entry: { id: "x", activity: "strolling", minutes: 10 } },
    { day: DAY0, entry: { id: "x", activity: "yoga", minutes: 0 } },
    { day: DAY0, entry: { id: "x", activity: "yoga", minutes: 601 } },
  ];
  for (const args of junk) {
    // eslint-disable-next-line no-await-in-loop
    await assert.rejects(() => markChallengeDone(db, { ...args, now: T0 }), MovesInputError);
    // eslint-disable-next-line no-await-in-loop
    await assert.rejects(() => recordChallengeDone(db, { ...args, now: T0 }), MovesInputError);
  }
  assert.equal(await rowDelta(db, MOVE_DONE_KIND, DAY0), null, "no Done row was spent");
  assert.equal(await rowDelta(db, MOVE_INDOOR_KIND, DAY0), null);
  const ok = await markChallengeDone(db, { day: DAY0, entry: entry({ minutes: 10 }), now: T0 });
  assert.equal(ok.fresh, true, "and the day's one Done is still available");
});

/* ------------------------------------------------------------------- logs */

test("a log pays the chunk rate: 10 minutes 12, 30 minutes 20, 60 minutes 20", async () => {
  const db = await freshDb();
  const a = await recordLog(db, { activity: "yoga", minutes: 10, effort: "easy", now: T0 });
  assert.deepEqual([a.points, a.paid], [12, 12]);
  const b = await recordLog(db, { activity: "yoga", minutes: 30, effort: "moderate", now: T0 + 24 * HOUR });
  assert.deepEqual([b.points, b.paid], [20, 20]);
  const c = await recordLog(db, { activity: "yoga", minutes: 60, effort: "hard", now: T0 + 48 * HOUR });
  assert.deepEqual([c.points, c.paid], [20, 20]);
});

test("a log answers the area it trains: the caller's, the activity's default, or none", async () => {
  assert.equal(Object.isFrozen(ACTIVITY_AREA), true);
  assert.deepEqual({ ...ACTIVITY_AREA }, {
    walk: "heart", jog: "heart", run: "heart", cycle: "heart", swim: "heart", sport: "heart",
    yoga: "mobility", band: "upper", bodyweight: "core", other: null,
  });

  const db = await freshDb();
  const yoga = await recordLog(db, { activity: "yoga", minutes: 10, effort: "easy", now: T0 });
  assert.equal(yoga.area, "mobility", "the activity's own area");

  const walk = await recordLog(db, { activity: "walk", minutes: 10, effort: "easy", now: T0 + 60000 });
  assert.equal(walk.area, "heart");

  const other = await recordLog(db, { activity: "other", minutes: 10, effort: "easy", now: T0 + 120000 });
  assert.equal(other.area, null, "the something-else bucket leans on no area");

  const given = await recordLog(db, {
    activity: "yoga", minutes: 10, effort: "easy", area: "core", now: T0 + 180000,
  });
  assert.equal(given.area, "core", "the caller's own area wins over the activity's");

  const junk = await recordLog(db, {
    activity: "band", minutes: 10, effort: "easy", area: "knees", now: T0 + 240000,
  });
  assert.equal(junk.area, "upper", "an area outside AREAS is ignored");
  assert.match(junk.key, new RegExp(`^${DAY0}:\\d+:band:10:easy$`), "the area never reaches the key");

  const repeat = await recordLog(db, { activity: "yoga", minutes: 10, effort: "easy", now: T0 });
  assert.equal(repeat.already, true);
  assert.equal(repeat.key, yoga.key);
  assert.equal(repeat.area, "mobility", "a repeat answers its area too");
});

test("logs and a Done share one budget of 40 a day, indoor and outdoor separately", async () => {
  const indoor = await freshDb();
  const done = await recordChallengeDone(indoor, { day: DAY0, entry: entry({ minutes: 10 }), now: T0 });
  const a = await recordLog(indoor, { activity: "yoga", minutes: 30, effort: "moderate", now: T0 + 60000 });
  const b = await recordLog(indoor, { activity: "yoga", minutes: 10, effort: "moderate", now: T0 + 120000 });
  const c = await recordLog(indoor, { activity: "band", minutes: 30, effort: "moderate", now: T0 + 180000 });
  assert.deepEqual([done.paid, a.paid, b.paid, c.paid], [12, 20, 8, 0], "12, then 20, then the last 8, then nothing");
  assert.equal(await rowDelta(indoor, MOVE_INDOOR_KIND, DAY0), INDOOR_DAILY_CAP);
  assert.equal(await rowDelta(indoor, MOVE_OUTDOOR_KIND, DAY0), null);

  const outdoor = await freshDb();
  const card = await recordChallengeDone(outdoor, {
    day: DAY0, entry: entry({ minutes: 30, indoor: false, activity: "walk" }), now: T0,
  });
  const d = await recordLog(outdoor, { activity: "walk", minutes: 10, effort: "moderate", now: T0 + 60000 });
  const e = await recordLog(outdoor, { activity: "walk", minutes: 30, effort: "moderate", now: T0 + 120000 });
  const f = await recordLog(outdoor, { activity: "walk", minutes: 30, effort: "moderate", now: T0 + 180000 });
  assert.deepEqual([card.paid, d.paid, e.paid, f.paid], [20, 12, 8, 0]);
  assert.equal(await rowDelta(outdoor, MOVE_OUTDOOR_KIND, DAY0), OUTDOOR_DAILY_CAP);
  assert.equal(await rowDelta(outdoor, MOVE_INDOOR_KIND, DAY0), null, "an outdoor day never draws the indoor budget");
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
  assert.equal(out.paid, 12);
  assert.equal(await rowDelta(db, MOVE_DONE_KIND, dayD), 1);
  assert.equal(await rowDelta(db, MOVE_INDOOR_KIND, dayD), 12);
  assert.equal(await rowDelta(db, MOVE_DONE_KIND, dayD1), null, "the new day is untouched");
  assert.equal(await rowDelta(db, MOVE_INDOOR_KIND, dayD1), null);

  assert.equal((await movesDay(db, { day: dayD })).done, true);
  assert.equal((await movesDay(db, { day: dayD1 })).done, false);

  // D+1's own challenge is a separate fact and still pays.
  const next = await recordChallengeDone(db, { day: dayD1, entry: entry({ minutes: 10 }), now: doneAt + 60000 });
  assert.equal(next.paid, 12);
  assert.equal((await movesDay(db, { day: dayD1 })).indoorPaid, 12);
  assert.equal((await movesDay(db, { day: dayD })).indoorPaid, 12, "and D did not move");
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

test("a `move` starts the decay clock on a fresh bird, and no later feed resets it", async () => {
  const db = await freshDb();
  const a = await feed(db, { type: "move", amount: 7 }, { now: T0 });
  assert.equal(a.energy, 67);
  assert.equal(a.last_fed_at, T0);
  assert.deepEqual([a.places_week, a.unlocks_week, a.crows_week], [0, 0, 0], "a move bumps no weekly counter");

  const b = await feed(db, { type: "move", amount: 40 }, { now: T0 + 1000 });
  assert.equal(b.energy, 100, "clamped by the ceiling");
  assert.equal(b.last_fed_at, T0, "a later feed never resets the clock");

  const c = await feed(db, { type: "move", amount: -5 }, { now: T0 + 2000 });
  assert.equal(c.energy, 100, "a negative move pays nothing");

  const s = await feed(db, { type: "steps", amount: 5 }, { now: T0 + 4000 });
  assert.equal(s.last_fed_at, T0, "R5: readings never touch the decay clock either");

  await assert.rejects(() => feed(db, { type: "nonsense" }, { now: T0 }));
});

test("decay is wall-clock: feeds every 5 h 48 m cannot skip it, and the part-interval is kept", async () => {
  const db = await freshDb();
  const H = 3600 * 1000;
  await feed(db, { type: "move", amount: 40 }, { now: T0 });         // 100, clock starts at T0
  let t = T0;
  for (let i = 0; i < 8; i += 1) {                                   // 8 x 5h48m = 46h24m
    t += 5 * H + 48 * 60 * 1000;
    await feed(db, { type: "move", amount: 1 }, { now: t });         // the old clock-reset trick
  }
  const s = await petState(db, { now: t });
  // 46h24m = 7 whole intervals: -70, +8 paid back, from 100 -> 38 at most.
  assert.ok(s.energy <= 38, "decay landed despite the timed feeds, got " + s.energy);
  assert.equal(s.last_fed_at, T0 + 7 * 6 * H, "the clock moved by whole intervals, keeping the remainder");
});

/* ------------------------------------------------------------- sync safety */

test("no ramble_wallet row written here ever shrinks", async () => {
  const db = await freshDb();
  const seen = [];
  const emit = collector(seen);

  await feedAll(db, { type: "checkin" }, { now: T0, emit });
  await recordLog(db, { activity: "yoga", minutes: 10, effort: "easy", now: T0 + 1000, emit });
  await recordLog(db, { activity: "band", minutes: 10, effort: "easy", now: T0 + 1500, emit });
  await recordChallengeDone(db, { day: DAY0, entry: entry({ minutes: 20 }), now: T0 + 3000, emit });
  await recordLog(db, { activity: "band", minutes: 15, effort: "moderate", now: T0 + 4000, emit });
  await recordLog(db, { activity: "band", minutes: 15, effort: "moderate", now: T0 + 4000, emit });
  await recordLog(db, { activity: "walk", minutes: 45, effort: "hard", now: T0 + 5000, emit });
  await recordLog(db, { activity: "bodyweight", minutes: 12, effort: "moderate", now: T0 + 6000, emit });
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

  await recordLog(a, { activity: "yoga", minutes: 20, effort: "moderate", now: T0, emit });           // 20
  await recordChallengeDone(a, { day: DAY0, entry: entry({ minutes: 10 }), now: T0 + 60000, emit });  // 12
  await recordLog(a, { activity: "walk", minutes: 20, effort: "easy", now: T0 + 120000, emit });      // 20

  for (const [op, row] of ops) await applyRambleWallet(b, op, row, 1);
  const dayB = await movesDay(b, { day: DAY0 });
  assert.equal(dayB.indoorPaid, 32);
  assert.equal(dayB.outdoorPaid, 20);
  assert.equal(dayB.done, true);
  assert.deepEqual(dayB.logs, [
    { activity: "yoga", minutes: 20, effort: "moderate", paid: 20 },
    { activity: "walk", minutes: 20, effort: "easy", paid: 20 },
  ]);

  // Idempotent re-delivery, and a LATER lamport carrying a SMALLER delta.
  for (const [op, row] of ops) await applyRambleWallet(b, op, row, 2);
  await applyRambleWallet(b, "update", { kind: MOVE_INDOOR_KIND, key: DAY0, delta: 3, created_at: T0 }, 9);
  const again = await movesDay(b, { day: DAY0 });
  assert.equal(again.indoorPaid, 32, "MAX(delta): a peer can never take a day's Health away");
  assert.deepEqual(again.logs, dayB.logs);
});

/* ------------------------------------------------------------ the egg rule */

/* -------------------------------------------------------- the simulations */
/**
 * The simulations run on local noons: the pet's owed decay lands, the day is
 * played, then the clock moves 6 h on (as the old simulation did).
 *
 * A CHUNK here is a 10-minute `yoga` log (recordLog, effort moderate) at its own
 * minute offset. The card player that pays per chunk does not exist yet, and a
 * log draws the same indoor budget at the same rate, so it stands in for one.
 */
function simNoon(i) {
  return new Date(2026, 9, 5 + i, 12).getTime();
}

async function chunk(db, t, minute, emit) {
  return recordLog(db, { activity: "yoga", minutes: 10, effort: "moderate", now: t + minute * 60000, emit });
}

/** The state after the day's last feed; the loop then moves the clock 6 h on. */
async function simDayEnd(db, t) {
  const state = await petState(db, { now: t + 10 * 60000 });
  await petState(db, { now: t + 6 * HOUR });
  return state;
}

/** A month of indoor-only noon days: the check-in, then `chunks` 10-minute logs. */
async function indoorOnlyMonth(db, { days = 30, chunks, emit }) {
  let day = null;
  let state = null;
  for (let i = 0; i < days; i += 1) {
    const t = simNoon(i);
    // eslint-disable-next-line no-await-in-loop
    await petState(db, { now: t });
    // eslint-disable-next-line no-await-in-loop
    await feedAll(db, { type: "checkin" }, { now: t, emit });
    for (let m = 1; m <= chunks; m += 1) {
      // eslint-disable-next-line no-await-in-loop
      await chunk(db, t, m, emit);
    }
    // eslint-disable-next-line no-await-in-loop
    state = await simDayEnd(db, t);
    assert.equal(state.mood, "happy", `day ${i + 1}: the last feed left the bird happy (energy ${state.energy})`);
    day = localDay(t);
  }
  return { day, state };
}

/** What an indoor-only month must NOT have: a lay day, an egg, or any movement fact. */
async function assertNoLayDays(db) {
  const { days } = await layProgress(db);
  assert.equal(days, 0, "no lay day was banked");
  assert.equal(await countKind(db, LAYDAY_KIND), 0, "and no layday row exists");
  assert.equal(await eggCount(db), 0, "no egg was laid");
  assert.deepEqual(await walletKinds(db), [MOVE_INDOOR_KIND, MOVE_LOG_KIND],
    "indoor only: no walked row, no moveoutdoor row, nothing outdoors");
}

/** A month of `chunks` 10-minute logs plus the "I walked today" tap and the check-in. */
async function tapMonth(db, { days = 30, chunks, emit }) {
  let last = null;
  for (let i = 0; i < days; i += 1) {
    const t = simNoon(i);
    // eslint-disable-next-line no-await-in-loop
    await petState(db, { now: t });
    // eslint-disable-next-line no-await-in-loop
    await feedAll(db, { type: "checkin" }, { now: t, emit });
    for (let m = 1; m <= chunks; m += 1) {
      // eslint-disable-next-line no-await-in-loop
      await chunk(db, t, m, emit);
    }
    // eslint-disable-next-line no-await-in-loop
    await recordWalkCheckin(db, { now: t + 6 * 60000, emit });
    // eslint-disable-next-line no-await-in-loop
    last = await simDayEnd(db, t);
  }
  return last;
}

/**
 * A walker's day: the check-in, a step reading that reaches the goal, the "I
 * walked today" tap, and one 30-minute outdoor log (20 Health). `extraChunk`
 * adds the 10-minute log the re-run has on top.
 */
async function walkerDay(db, i, emit, { extraChunk = false } = {}) {
  const t = simNoon(i);
  await petState(db, { now: t });
  await feedAll(db, { type: "checkin" }, { now: t, emit });
  await recordStepReading(db, {
    device_id: "sim-dev-" + i, boot_count: 1, counter: 6000, elapsed_ms: 4 * HOUR,
  }, { now: t + 4 * 60000, emit });
  await settleDay(db, { now: t + 4 * 60000, emit });
  await recordWalkCheckin(db, { now: t + 6 * 60000, emit });
  await recordLog(db, { activity: "walk", minutes: 30, effort: "moderate", now: t + 7 * 60000, emit });
  if (extraChunk) await chunk(db, t, 8, emit);
  return simDayEnd(db, t);
}

async function walkerFortnight(db, { extraChunk = false, emit } = {}) {
  let last = null;
  for (let i = 0; i < 14; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    last = await walkerDay(db, i, emit, { extraChunk });
    assert.equal(last.mood, "happy", `day ${i + 1}: the walk left the bird happy (energy ${last.energy})`);
  }
  const { days, needed } = await layProgress(db);
  assert.equal(needed, LAY_DAYS_DEFAULT, "lay.days is at its default");
  assert.equal(days, 0, "the count reset when the egg was laid");
  assert.equal(await countKind(db, LAYDAY_KIND), LAY_DAYS_DEFAULT, "one happy, moving day banked per day");
  assert.equal(await countKind(db, LAY_KIND), 1, "exactly one lay");
  assert.equal(await eggCount(db), 1, "an egg exists");
  assert.equal(await rowDelta(db, LAY_KIND, localDay(simNoon(13))), 1, "laid on the fourteenth day");
  return last;
}

test("EGG SIMULATION A: a month of indoor-only days banks happy days and no lay days", async () => {
  const db = await freshDb();
  const first = await petState(db, { now: T0 });
  // A fresh bird starts at 60 Health (ramble_pet's column default) — exactly the
  // happy line (pet.js moodFor: >= 60).
  assert.equal(first.energy, 60, "the default fresh bird");
  assert.equal(first.mood, "happy");

  const { day, state } = await indoorOnlyMonth(db, { chunks: 3, emit: collector([]) });
  await assertNoLayDays(db);
  assert.equal(state.mood, "happy");
  assert.equal((await movesDay(db, { day })).indoorPaid, 36, "the bird really was fed indoors every day");
});

test("EGG SIMULATION A with a log: four chunks a day, capped at 40, still no lay days", async () => {
  const db = await freshDb();
  const { day, state } = await indoorOnlyMonth(db, { chunks: 4, emit: collector([]) });
  await assertNoLayDays(db);
  assert.equal(state.mood, "happy");
  assert.equal((await movesDay(db, { day })).indoorPaid, INDOOR_DAILY_CAP,
    "four 10-minute chunks (48 worth) stop at the budget of 40");
});

test("EGG SIMULATION B: a walker's fortnight lays on the fourteenth day", async () => {
  const db = await freshDb();
  await walkerFortnight(db, { emit: collector([]) });
});

test("EGG SIMULATION B with a log: the walker's fortnight still lays", async () => {
  const db = await freshDb();
  await walkerFortnight(db, { extraChunk: true, emit: collector([]) });
});

test("EGG SIMULATION C: indoor cards plus the \"I walked today\" tap do bank lay days", async () => {
  const db = await freshDb();
  const last = await tapMonth(db, { chunks: 3, emit: collector([]) });
  assert.equal(last.mood, "happy", `the last day's feeds left the bird happy (energy ${last.energy})`);
  const { needed } = await layProgress(db);
  assert.equal(needed, LAY_DAYS_DEFAULT);
  assert.ok(await countKind(db, LAYDAY_KIND) >= 1, "lay days accrue once there is a movement fact");
  assert.ok(await countKind(db, LAYDAY_KIND) >= LAY_DAYS_DEFAULT, "enough of them to lay");
  assert.equal(await countKind(db, LAY_KIND), 1, "exactly one laying");
  assert.equal(await eggCount(db), 1, "with lay.days at its default an egg is laid within 30 days");
});

test("EGG SIMULATION C with a log: four chunks plus the tap still lay", async () => {
  const db = await freshDb();
  const last = await tapMonth(db, { chunks: 4, emit: collector([]) });
  assert.equal(last.mood, "happy", `the last day's feeds left the bird happy (energy ${last.energy})`);
  assert.ok(await countKind(db, LAYDAY_KIND) >= 1, "lay days accrue once there is a movement fact");
  assert.equal(await countKind(db, LAY_KIND), 1);
  assert.equal(await eggCount(db), 1, "an egg is laid within 30 days");
});

test("EGG SIMULATION C, one chunk a day: the bird slides below happy", async () => {
  const db = await freshDb();
  const last = await tapMonth(db, { chunks: 1, emit: collector([]) });
  assert.notEqual(last.mood, "happy", `energy ${last.energy} at the end of the last day`);
  assert.equal(await eggCount(db), 0, "and it never laid");
});

test("EGG SIMULATION C with a log (two chunks a day in all): the bird ends the month happy", async () => {
  const db = await freshDb();
  const last = await tapMonth(db, { chunks: 2, emit: collector([]) });
  assert.equal(last.mood, "happy", `energy ${last.energy} at the end of the last day`);
});

test("EGG SIMULATION, adversarial timing: feeds just under 6 h apart still bank no lay days", async () => {
  const db = await freshDb();
  const seen = [];
  const emit = collector(seen);
  const STEP = 5 * HOUR + 57 * 60000;          // just under one decay interval
  let t = new Date(2026, 9, 5, 0, 30).getTime();
  const end = t + 21 * 24 * HOUR;
  let n = 0;
  while (t < end) {
    // Rotate the indoor earners: the check-in, a cheap log, another log and a challenge.
    const k = n % 4;
    // eslint-disable-next-line no-await-in-loop
    if (k === 0) await feedAll(db, { type: "checkin" }, { now: t, emit });
    // eslint-disable-next-line no-await-in-loop
    else if (k === 1) await recordLog(db, { activity: "yoga", minutes: 1, effort: "easy", now: t, emit });
    // eslint-disable-next-line no-await-in-loop
    else if (k === 2) await recordLog(db, { activity: "band", minutes: 1, effort: "easy", now: t, emit });
    // eslint-disable-next-line no-await-in-loop
    else await recordChallengeDone(db, { day: localDay(t), entry: entry({ id: "timed-" + n, minutes: 1 }), now: t, emit });
    t += STEP; n += 1;
  }
  // Decay is wall-clock, so the timed feeds cannot out-run it; and even a happy
  // bird banks nothing here, because the loop contains no movement fact at all
  // (no steps, no outdoor log, no place visited) and `recordHappyDay` refuses
  // without one.
  const { days } = await layProgress(db);
  assert.equal(days, 0, `timed indoor play banked ${days} lay days; decay must be wall-clock and a lay day needs movement`);
  assert.equal(await countKind(db, LAYDAY_KIND), 0, "not one layday row");
  assert.equal(await eggCount(db), 0, "no egg was ever laid");
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

test("a Done or a log can only credit today or yesterday; other dates fall to today", async () => {
  const { capDayKey } = await import("../bundles/ramble/server/moves/indoor-cap.js");
  const now = new Date(2026, 9, 30, 0, 2).getTime();
  assert.equal(capDayKey("2026-10-30", now), "2026-10-30");
  assert.equal(capDayKey("2026-10-29", now), "2026-10-29", "the midnight case");
  assert.equal(capDayKey("2026-10-01", now), "2026-10-30", "a past date opens no new budget");
  assert.equal(capDayKey("2027-01-01", now), "2026-10-30", "nor a future one");
});
