/**
 * Ramble moves — two Crow instances and the pairs the day-sync file does not
 * cover (moves design Task 9.7; private engineering notes).
 *
 * Two in-memory dbs stand in for two of the user's instances. A row is written
 * only by the REAL bundle writer on the instance that wrote it, with that
 * instance's `emit` capturing it; the captured rows are then applied to the
 * OTHER instance through the shipped `applyRambleWallet` (MAX delta, MIN
 * created_at, no callback) and `applyRambleSetting` (last-writer-wins on the
 * envelope's lamport). No bundle writer is ever run on the receiving side to
 * help a merge. Both instances share a fixed local Thursday (2026-11-12, cards
 * 3, the same library), so the day's cards are the same on both.
 *
 * Every scenario runs in the three merge orders of ORDERS: A's rows first, B's
 * rows first, and both queues snapshotted before either is applied.
 *
 * What is pinned here:
 *   - the first scenario: a `moveneed` disagreement widens the day, so the
 *     instance that finished a one-card day no longer holds a finished day, and
 *     its `dayCards` re-read asks for all three slots with a pick in each and
 *     writes no `moveneed` row,
 *   - the same card paid on both instances is ONE `movecard` row holding the
 *     larger pay, one `moveindoor` row holding the larger claim, and a
 *     `movesDay` that reports it under the daily cap,
 *   - two extras of one entry started in different seconds build different card
 *     keys, so both card rows survive a merge and the day counts two extras,
 *   - an older instance's `moves.today` and `movedone` rows reach a newer one
 *     without finishing the day it drew for itself, and its `movestreakv2` row
 *     travels while the apply invents none,
 *   - a reader that keeps only the wallet kinds a 0.16.x bundle knew answers
 *     from `movedone` alone, and the full wallet answers differently because
 *     the newer kinds (the all-cards rule) are there,
 *   - different slots done on each instance complete the day on both, with
 *     `isDayComplete` derived from the merged rows and no `moveall` row carried
 *     by the apply; one settle per instance then leaves one `streak:<day>`
 *     heart row on each db, and
 *   - the vacuity guard: a predicate that never answers "complete" fails that
 *     scenario, so the scenario passing with the real `isDayComplete` is an
 *     answer about the rows rather than a no-op.
 *
 * The shipped library is filled elsewhere, so every test injects its own
 * chunks. The clock is a fixed local Thursday, so nothing here depends on the
 * machine's timezone.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { rowDelta } from "../bundles/ramble/server/steps.js";
import { applyRambleSetting, applyRambleWallet } from "../servers/sharing/instance-sync.js";
import { HEART_KIND, heartsBalance } from "../bundles/ramble/server/hearts.js";
import { MOVE_DONE_KIND, movesDay, recordChallengeDone } from "../bundles/ramble/server/moves/ledger.js";
import { SLOTS } from "../bundles/ramble/server/moves/week.js";
import {
  MOVE_ALL_KIND, MOVE_BAL_KIND, MOVE_NEED_KIND, MOVE_SLOT_KIND, isDayComplete,
} from "../bundles/ramble/server/moves/day-complete.js";
import { recordSlotDone, settleDay } from "../bundles/ramble/server/moves/day.js";
import { MOVE_INDOOR_KIND } from "../bundles/ramble/server/moves/indoor-cap.js";
import {
  STREAK_HEART_EVERY, STREAK_V2_KIND, ensureStreakV2, streakState,
} from "../bundles/ramble/server/moves/streak.js";
import { todayChallenge, writePrefs } from "../bundles/ramble/server/moves/today.js";
import { dayCards } from "../bundles/ramble/server/moves/slots.js";
import {
  MOVE_CARD_KIND, extraCardKey, extrasCount, recordProgress, startChunk,
} from "../bundles/ramble/server/moves/progress.js";

/** A fixed local Thursday: 2026-11-12. */
const THURSDAY = new Date(2026, 10, 12, 18, 0, 0, 0).getTime();
/** The local minutes this file adds to it. */
const M = 60_000;
const DAY = "2026-11-12";

/** The days the older instance's ledger files its Done rows under. */
const NOV10 = "2026-11-10";
const NOV11 = "2026-11-11";
/** The three Done days, the newest of which is the fixed Thursday itself. */
const DONE_DAYS = Object.freeze([NOV10, NOV11, DAY]);

/** The six complete days before DAY, so the run ends on the fixed Thursday. */
const RUN = Object.freeze([
  "2026-11-06", "2026-11-07", "2026-11-08", "2026-11-09", "2026-11-10", "2026-11-11",
]);
/** The day the all-cards rule starts on in that run. */
const UPGRADE = "2026-11-06";

/** Local noon of the fixed Thursday. */
const NOON12 = new Date(2026, 10, 12, 12, 0, 0, 0).getTime();

/** Local noon of a `YYYY-MM-DD` day string, so day arithmetic is timezone-safe. */
function noonOf(dayStr) {
  const [y, m, d] = dayStr.split("-").map(Number);
  return new Date(y, m - 1, d, 12, 0, 0, 0).getTime();
}

/**
 * The lamport space of each instance. A's writes are all older than B's, so
 * the LWW winner is the same whichever order the rows travel in; inside one
 * instance the numbers only ever grow.
 */
const LAMPORT_BASE = Object.freeze({ A: 1_000_000, B: 2_000_000 });
const ORIGIN = Object.freeze({ A: "instance-a", B: "instance-b" });

/** The three merge orders every scenario runs in. */
const ORDERS = Object.freeze([
  ["a-first", "A's rows delivered first"],
  ["b-first", "B's rows delivered first"],
  ["mutual", "both queues snapshotted, then both applied"],
]);

/** A picker-shaped chunk; each test overrides exactly what it is about. */
function chunk(over = {}) {
  return {
    id: "chunk-1",
    kind: "routine",
    title: "A test routine",
    minutes: 10,
    level: 1,
    indoor: true,
    activity: "bodyweight",
    equipment: ["none"],
    tags: [],
    areas: ["mobility"],
    steps: ["do the thing"],
    works: [],
    stretches: [],
    mistakes: [],
    skipIf: [],
    easier: null,
    harder: null,
    sources: [],
    reviewed: true,
    ...over,
  };
}

/**
 * One eligible chunk for every area the fixed Thursday's three cards ask for
 * (mobility, heart, lower), plus one for upper.
 */
function library() {
  return [
    chunk({ id: "mob-1", areas: ["mobility", "core"] }),
    chunk({ id: "heart-1", areas: ["heart"] }),
    chunk({ id: "low-1", areas: ["lower"] }),
    chunk({ id: "up-1", areas: ["upper"] }),
  ];
}

/**
 * A library wide enough for a week of cards: two chunks in every area and no
 * chunk in two, so a slot whose planned area an earlier slot already took still
 * has one candidate left.
 */
function runLibrary() {
  return [
    chunk({ id: "mob-1", areas: ["mobility"] }),
    chunk({ id: "mob-2", areas: ["mobility"] }),
    chunk({ id: "core-1", areas: ["core"] }),
    chunk({ id: "core-2", areas: ["core"] }),
    chunk({ id: "low-1", areas: ["lower"] }),
    chunk({ id: "low-2", areas: ["lower"] }),
    chunk({ id: "heart-1", areas: ["heart"] }),
    chunk({ id: "heart-2", areas: ["heart"] }),
    chunk({ id: "up-1", areas: ["upper"] }),
    chunk({ id: "up-2", areas: ["upper"] }),
  ];
}

/**
 * Stamp the writing db's settings row with the lamport its emit carries (the
 * real emit path does this in stampSql). Without it every local row reads as
 * lamport 0 and an LWW merge would depend on which side happened to receive
 * first.
 */
async function stampWrote(db, table, op, row, lamport, origin) {
  if (op === "delete" || table !== "ramble_settings") return;
  if (!row || typeof row.key !== "string") return;
  await db.execute({
    sql: "UPDATE ramble_settings SET lamport_ts = ?, lamport_origin = ? WHERE key = ?",
    args: [lamport, origin, row.key],
  });
}

/** One instance: a fresh db, and a capture emit that stamps the writing side. */
async function instance(name) {
  const db = createClient({ url: "file::memory:" });
  await initRambleTables(db);
  const ops = [];
  let seq = 0;
  const emit = async (table, op, row) => {
    seq += 1;
    const lamport = LAMPORT_BASE[name] + seq;
    ops.push({ table, op, row: { ...row }, lamport, origin: ORIGIN[name] });
    await stampWrote(db, table, op, row, lamport, ORIGIN[name]);
  };
  return { name, db, ops, emit };
}

/** Everything this instance wrote since the last drain. */
const drain = (inst) => inst.ops.splice(0);

/** Apply captured rows to the other side, through the shipped merge handlers. */
async function deliver(rows, to) {
  for (const { table, op, row, lamport, origin } of rows) {
    if (table === "ramble_wallet") await applyRambleWallet(to.db, op, row, lamport);
    else if (table === "ramble_settings") await applyRambleSetting(to.db, op, row, lamport, origin);
  }
}

/** Merge the pair in one of the three orders. Declared writes stay put. */
async function exchange({ A, B }, order) {
  if (order === "a-first") {
    await deliver(drain(A), B);
    await deliver(drain(B), A);
  } else if (order === "b-first") {
    await deliver(drain(B), A);
    await deliver(drain(A), B);
  } else {
    const fromA = drain(A);
    const fromB = drain(B);
    await deliver(fromA, B);
    await deliver(fromB, A);
  }
}

/** A capture emit that only records what a read wrote. */
function capture() {
  const writes = [];
  const emit = async (table, op, row) => { writes.push({ table, op, row: { ...row } }); };
  return { writes, emit };
}

/** A ledger row written straight into a db, as the streak seeding does. */
async function fact(db, kind, key, delta = 1, createdAt = 0) {
  await db.execute({
    sql: "INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES (?, ?, ?, ?)",
    args: [kind, key, delta, createdAt],
  });
}

/** A day with every card, its balance and its completion cache, as rows alone. */
async function seedFullDay(db, dayStr) {
  await fact(db, MOVE_NEED_KIND, dayStr, 3);
  for (const slot of SLOTS) {
    // eslint-disable-next-line no-await-in-loop
    await fact(db, MOVE_SLOT_KIND, `${dayStr}:${slot}`, 1);
  }
  await fact(db, MOVE_BAL_KIND, dayStr, 1);
  await fact(db, MOVE_ALL_KIND, dayStr, 1);
}

/** Six complete days, the all-cards start day, and the three Done days. */
async function seedNewKinds(db) {
  await fact(db, STREAK_V2_KIND, UPGRADE, 1);
  for (const dayStr of RUN) {
    // eslint-disable-next-line no-await-in-loop
    await seedFullDay(db, dayStr);
  }
  for (const dayStr of DONE_DAYS) {
    // eslint-disable-next-line no-await-in-loop
    await fact(db, MOVE_DONE_KIND, dayStr, 1);
  }
}

/** One complete day from its rows alone: one card asked for, finished, and balanced. */
async function seedCompleteDay(db, dayStr) {
  await fact(db, MOVE_NEED_KIND, dayStr, 1);
  await fact(db, MOVE_SLOT_KIND, `${dayStr}:morning`, 1);
  await fact(db, MOVE_BAL_KIND, dayStr, 1);
}

/** Six complete days and the all-cards start day, so the fixed Thursday is the seventh. */
async function seedRun(db) {
  await fact(db, STREAK_V2_KIND, UPGRADE, 1);
  for (const dayStr of RUN) {
    // eslint-disable-next-line no-await-in-loop
    await seedCompleteDay(db, dayStr);
  }
}

/** The keys of one wallet kind, sorted, so an assertion says how many rows there are. */
async function keysOfKind(db, kind) {
  const { rows } = await db.execute({
    sql: "SELECT key FROM ramble_wallet WHERE kind = ? ORDER BY key", args: [kind],
  });
  return rows.map((row) => String(row.key));
}

/** How many rows (kind, key) holds — one, or more if a merge duplicated it. */
async function rowCount(db, kind, key) {
  const { rows } = await db.execute({
    sql: "SELECT count(*) AS n FROM ramble_wallet WHERE kind = ? AND key = ?",
    args: [kind, key],
  });
  return Number(rows[0]?.n) || 0;
}

/** How many `moveall` rows a db holds: the completion cache, which no apply carries. */
async function moveallRows(db) {
  return (await keysOfKind(db, MOVE_ALL_KIND)).length;
}

/** The wallet's `moveneed` deltas for a day, as numbers. */
async function needDeltas(db, day = DAY) {
  const { rows } = await db.execute({
    sql: "SELECT delta FROM ramble_wallet WHERE kind = ? AND key = ?",
    args: [MOVE_NEED_KIND, day],
  });
  return rows.map((r) => Number(r.delta));
}

/** Both instances open the fixed Thursday with the same prefs and library. */
async function openDay(inst, lib = library()) {
  await writePrefs(inst.db, { cards: 3 });
  return dayCards(inst.db, { now: THURSDAY, library: lib, emit: inst.emit });
}

/**
 * The first scenario's body: both instances open the fixed Thursday, A closes
 * the morning and the midday card and B the evening one, and the exchange is
 * expected to finish the day on both.
 *
 * A's morning card is closed through a balancing area (mobility, as the day-sync
 * scenario does), so the `movebal` row the rule also wants is on the wallet
 * before the exchange and the exchange is about the slot rows alone.
 *
 * `isComplete` is the predicate the assertions use, so a caller can hand in one
 * that never answers "complete" and watch the scenario fail.
 */
async function completesTheDay(pair, order, isComplete = isDayComplete) {
  const lib = library();
  const { A, B } = pair;
  for (const inst of [A, B]) {
    // eslint-disable-next-line no-await-in-loop
    const cards = await openDay(inst, lib);
    assert.equal(cards.need, 3, "the fixed Thursday asks for three cards: " + inst.name);
    assert.deepEqual(cards.slots.map((item) => item.area), ["mobility", "heart", "lower"],
      "and its plan is a balancing area, the heart one and the legs: " + inst.name);
  }

  await recordSlotDone(A.db, {
    day: DAY,
    slot: "morning",
    entry: { kind: "routine", areas: ["mobility"] },
    via: "player",
    now: THURSDAY,
    emit: A.emit,
  });
  await recordSlotDone(A.db, {
    day: DAY,
    slot: "midday",
    entry: { kind: "routine", areas: ["heart"] },
    via: "class",
    now: THURSDAY,
    emit: A.emit,
  });
  await recordSlotDone(B.db, {
    day: DAY,
    slot: "evening",
    entry: { kind: "routine", areas: ["lower"] },
    via: "player",
    now: THURSDAY,
    emit: B.emit,
  });

  assert.equal(await isComplete(A.db, DAY), false,
    "A holds two of the day's three slot rows and the third is on B: " + A.name);
  assert.equal(await isComplete(B.db, DAY), false,
    "B holds one of the day's three slot rows and the other two are on A: " + B.name);

  const cacheRows = { A: await moveallRows(A.db), B: await moveallRows(B.db) };

  await exchange(pair, order);

  for (const inst of [A, B]) {
    assert.equal(await isComplete(inst.db, DAY), true,
      "the merged slot rows reach the day's demand, so completion is derived on this db: "
        + inst.name);
    assert.equal(await moveallRows(inst.db), cacheRows[inst.name],
      "the apply wrote no moveall row: the result is derived, not carried: " + inst.name);
    assert.equal(await rowCount(inst.db, MOVE_ALL_KIND, DAY), 0,
      "and no moveall row for the day arrived from the other instance: " + inst.name);
  }
}

/** The three Done days, each written by the real Done writer on that instance. */
async function writeMovedone(inst) {
  for (const dayStr of DONE_DAYS) {
    // eslint-disable-next-line no-await-in-loop
    const out = await recordChallengeDone(inst.db, {
      day: dayStr,
      entry: chunk({ id: "mob-1" }),
      now: noonOf(dayStr),
      emit: inst.emit,
    });
    assert.deepEqual({ paid: out.paid, already: out.already }, { paid: 12, already: false },
      "a ten-minute indoor Done pays its chunk once, under its own day: " + dayStr);
  }
}

/** A run of six finished days and the all-cards start day, by the current writers. */
async function writeNewKinds(inst, lib) {
  assert.equal(await ensureStreakV2(inst.db, { day: UPGRADE, now: noonOf(UPGRADE), emit: inst.emit }), true,
    "the all-cards start day is written on the first finished day of the run");
  await writePrefs(inst.db, { cards: 3 });
  for (const dayStr of RUN) {
    const noon = noonOf(dayStr);
    // eslint-disable-next-line no-await-in-loop
    const cards = await dayCards(inst.db, { now: noon, library: lib, emit: inst.emit });
    assert.equal(cards.need, 3, "the day asks for all three slots: " + dayStr);
    assert.deepEqual(cards.slots.map((item) => item.slot), [...SLOTS],
      "and holds a card in each of them: " + dayStr);
    for (const item of cards.slots) {
      // eslint-disable-next-line no-await-in-loop
      await recordSlotDone(inst.db, {
        day: dayStr,
        slot: item.slot,
        entry: { kind: "routine", areas: [item.area] },
        via: "player",
        now: noon,
        emit: inst.emit,
        need: cards.need,
      });
    }
  }
}

/**
 * The wallet kinds a 0.16.x bundle knew. A reader of that build asks for these
 * and nothing else, so a shared `execute` can answer it from a newer wallet.
 */
const OLD_KINDS = new Set(["movedone", "moveoff", "movelog", "steps"]);

/**
 * A reader shaped like the older bundle's: `execute` forwards to `db` and then
 * keeps only the rows whose kind that build knew. A settings row carries no
 * `kind`, so a filtered read falls back to the step defaults, which matter only
 * where a day was counted by steps.
 */
function legacyReader(db) {
  return {
    async execute(query) {
      const result = await db.execute(query);
      const rows = Array.isArray(result.rows) ? result.rows : [];
      return { ...result, rows: rows.filter((row) => OLD_KINDS.has(String(row?.kind ?? ""))) };
    },
  };
}

/** The answer a db holding only the three Done days gives at the Thursday's noon. */
async function movedoneOnlyStreak() {
  const db = createClient({ url: "file::memory:" });
  await initRambleTables(db);
  for (const dayStr of DONE_DAYS) {
    // eslint-disable-next-line no-await-in-loop
    await fact(db, MOVE_DONE_KIND, dayStr, 1);
  }
  return streakState(db, { now: NOON12 });
}

/** The answer a fresh db holding only these Done days and one all-cards start day gives. */
async function movedoneWithStart(doneDays, startDay) {
  const db = createClient({ url: "file::memory:" });
  await initRambleTables(db);
  for (const dayStr of doneDays) {
    // eslint-disable-next-line no-await-in-loop
    await fact(db, MOVE_DONE_KIND, dayStr, 1);
  }
  await fact(db, STREAK_V2_KIND, startDay, 1);
  return streakState(db, { now: NOON12 });
}

/**
 * Both reads of one wallet: the older-shaped one answers from `movedone` alone,
 * and the full one is a different number because the newer kinds (the
 * all-cards rule) are in the same wallet.
 */
async function assertOlderReaderAnswer(db, label) {
  const fromDoneOnly = await movedoneOnlyStreak();
  assert.deepEqual(fromDoneOnly, { days: 3, nextHeartAt: STREAK_HEART_EVERY, todayGood: true },
    "three Done days in a row read as a three-day run, today included");

  const legacy = await streakState(legacyReader(db), { now: NOON12 });
  assert.deepEqual(legacy, fromDoneOnly,
    "a reader that keeps only the kinds a 0.16.x bundle knew answers from movedone alone: " + label);

  const full = await streakState(db, { now: NOON12 });
  assert.notDeepEqual(full, fromDoneOnly,
    "the newer kinds are in this wallet and they change the answer: " + label);
  assert.deepEqual(full, { days: 6, nextHeartAt: STREAK_HEART_EVERY, todayGood: false },
    "on and after the all-cards start day only a complete day counts: " + label);
}

/* ------------------------------------------------------------------------ */

/**
 * The first scenario, extending the day-sync card-count test: the count
 * disagreement itself belongs to that test, and what this one adds is that the
 * widened day's re-read holds a pick in EVERY slot, and that `dayCards` never
 * rewrites the `moveneed` row the day already holds.
 */
describe("a card count two instances disagree about", () => {
  for (const [order, label] of ORDERS) {
    test(`the wider count survives and the one-card day stops being finished (${label})`, async () => {
      const lib = library();
      const A = await instance("A");
      const B = await instance("B");
      await writePrefs(A.db, { cards: 1 });
      await writePrefs(B.db, { cards: 3 });
      const one = await dayCards(A.db, { now: THURSDAY, library: lib, emit: A.emit });
      const three = await dayCards(B.db, { now: THURSDAY, library: lib, emit: B.emit });
      assert.deepEqual([one.need, one.slots.map((item) => item.slot)], [1, ["midday"]],
        "A's day asks for the one card its prefs name");
      assert.deepEqual([three.need, three.slots.map((item) => item.slot)], [3, [...SLOTS]],
        "B's day asks for all three slots");
      await recordSlotDone(A.db, {
        day: DAY,
        slot: "midday",
        entry: { kind: "routine", areas: ["mobility"] },
        via: "player",
        now: THURSDAY,
        emit: A.emit,
        need: one.need,
      });

      const pair = { A, B };
      assert.equal(await isDayComplete(A.db, DAY), true,
        "one card and the player's own balancing chunk finish A's day before the exchange");

      await exchange(pair, order);

      for (const inst of [A, B]) {
        assert.deepEqual(await needDeltas(inst.db), [3],
          "applyRambleWallet merges moveneed by MAX, so the wider count is the day's: " + inst.name);
      }

      const { writes, emit } = capture();
      const day = await dayCards(A.db, { now: THURSDAY, library: lib, emit });
      assert.deepEqual(day.slots.map((item) => item.slot), [...SLOTS],
        "the widened day re-reads every slot its count names");
      assert.equal(day.need, 3, "and asks for three cards");
      for (const item of day.slots) {
        assert.ok(typeof item.entryId === "string" && item.entryId !== "",
          "the widened day holds a pick in " + item.slot);
      }
      assert.equal(await isDayComplete(A.db, DAY), false,
        "one closed card no longer reaches a three-card day's requirement");
      const needWrites = writes.filter((w) => w.table === "ramble_wallet"
        && w.row?.kind === MOVE_NEED_KIND);
      assert.deepEqual(needWrites, [],
        "dayCards never rewrites a moveneed row the day already holds");
    });
  }
});

describe("the same card paid on both instances", () => {
  for (const [order, label] of ORDERS) {
    test(`one card row holding the larger pay, one day row, one budget claim (${label})`, async () => {
      const lib = library();
      const A = await instance("A");
      const B = await instance("B");
      await openDay(A, lib);
      await openDay(B, lib);
      const key = `${DAY}:morning`;
      const entry = chunk({ id: "mob-1" });

      await startChunk(A.db, { cardKey: key, entryId: entry.id, plannedSeconds: 600, now: THURSDAY });
      await recordProgress(A.db, {
        day: DAY, cardKey: key, entry, activeSeconds: 600, now: THURSDAY + 11 * M, emit: A.emit,
      });
      await startChunk(B.db, { cardKey: key, entryId: entry.id, plannedSeconds: 600, now: THURSDAY });
      await recordProgress(B.db, {
        day: DAY, cardKey: key, entry, activeSeconds: 300, now: THURSDAY + 11 * M, emit: B.emit,
      });

      assert.equal(await rowDelta(A.db, MOVE_CARD_KIND, key), 12,
        "ten active minutes pay the chunk rate: 12");
      assert.equal(await rowDelta(B.db, MOVE_CARD_KIND, key), 6,
        "five active minutes pay half of that for the same card");
      for (const inst of [A, B]) {
        assert.equal(await rowCount(inst.db, MOVE_CARD_KIND, key), 1,
          "one card row on each side before the exchange: " + inst.name);
      }

      const pair = { A, B };
      await exchange(pair, order);

      for (const inst of [A, B]) {
        assert.equal(await rowCount(inst.db, MOVE_CARD_KIND, key), 1,
          "a card row is keyed by its card key, so the two pays meet in ONE row: " + inst.name);
        assert.equal(await rowDelta(inst.db, MOVE_CARD_KIND, key), 12,
          "and MAX keeps the larger pay: " + inst.name);
        const day = await movesDay(inst.db, { day: DAY, now: THURSDAY });
        assert.equal(day.indoorPaid, 12,
          "the day's indoor claim is the larger of the two, read through the cap: " + inst.name);
        assert.equal(await rowDelta(inst.db, MOVE_INDOOR_KIND, DAY), 12,
          "the moveindoor row merged by MAX to the larger claim: " + inst.name);
      }
    });
  }
});

describe("extras never collide", () => {
  for (const [order, label] of ORDERS) {
    test(`two extras of one entry started seconds apart stay two cards (${label})`, async () => {
      const lib = library();
      const A = await instance("A");
      const B = await instance("B");
      await openDay(A, lib);
      await openDay(B, lib);
      const entry = chunk({ id: "mob-1" });
      const keyA = extraCardKey(DAY, entry.id, THURSDAY);
      const keyB = extraCardKey(DAY, entry.id, THURSDAY + 5000);
      assert.notEqual(keyA, keyB,
        "the start second is what makes an extra's card key unique across instances");

      await startChunk(A.db, { cardKey: keyA, entryId: entry.id, plannedSeconds: 600, now: THURSDAY });
      await recordProgress(A.db, {
        day: DAY, cardKey: keyA, entry, activeSeconds: 600, now: THURSDAY + 11 * M, emit: A.emit,
      });
      await startChunk(B.db, {
        cardKey: keyB, entryId: entry.id, plannedSeconds: 600, now: THURSDAY + 5000,
      });
      await recordProgress(B.db, {
        day: DAY, cardKey: keyB, entry, activeSeconds: 300, now: THURSDAY + 12 * M, emit: B.emit,
      });

      for (const inst of [A, B]) {
        assert.equal(await extrasCount(inst.db, DAY), 1,
          "one extra paid so far, counted from the card keys the db holds: " + inst.name);
      }

      const pair = { A, B };
      await exchange(pair, order);

      for (const inst of [A, B]) {
        assert.equal(await extrasCount(inst.db, DAY), 2,
          "two card keys, so both extras count after the merge: " + inst.name);
        assert.equal(await rowDelta(inst.db, MOVE_CARD_KIND, keyA), 12,
          "A's extra keeps the pay it made under its own key: " + inst.name);
        assert.equal(await rowDelta(inst.db, MOVE_CARD_KIND, keyB), 6,
          "B's extra keeps its own pay, keyed a few seconds later: " + inst.name);
      }
    });
  }
});

describe("an older instance's rows reach a newer one", () => {
  for (const [order, label] of ORDERS) {
    test(`the old rows land, finish no day, and the new streak start travels (${label})`, async () => {
      const lib = library();
      const O = await instance("A");
      const N = await instance("B");

      const picked = await todayChallenge(O.db, { now: THURSDAY, emit: O.emit, library: lib });
      assert.ok(picked?.entry, "the older instance stored its own moves.today card");
      const past = await recordChallengeDone(O.db, {
        day: NOV11,
        entry: chunk({ id: "mob-1" }),
        now: noonOf(NOV11),
        emit: O.emit,
      });
      assert.deepEqual({ paid: past.paid, already: past.already }, { paid: 12, already: false },
        "the older instance's Done for a past day paid its indoor chunk once");
      const onDay = await recordChallengeDone(O.db, {
        day: DAY,
        entry: chunk({ id: "mob-1" }),
        now: THURSDAY,
        emit: O.emit,
      });
      assert.deepEqual({ paid: onDay.paid, already: onDay.already }, { paid: 12, already: false },
        "and its Done filed under the fixed Thursday paid once under that day");

      await openDay(N, lib);
      assert.equal(await ensureStreakV2(N.db, { day: DAY, now: THURSDAY, emit: N.emit }), true,
        "the newer instance wrote its all-cards start day as the day itself");

      const pair = { A: O, B: N };
      await assert.doesNotReject(async () => { await exchange(pair, order); },
        "the shipped handlers take an older instance's rows without a throw");

      assert.equal(await rowCount(N.db, MOVE_DONE_KIND, DAY), 1,
        "the older instance's Done for the day itself arrived as a movedone row");
      assert.equal(await isDayComplete(N.db, DAY), false,
        "a Done completes nothing: completion is derived from moveneed, moveslot and movebal");
      for (const [inst, who] of [[O, "the older instance"], [N, "the newer instance"]]) {
        // eslint-disable-next-line no-await-in-loop
        assert.equal(await rowCount(inst.db, MOVE_ALL_KIND, DAY), 0,
          "no moveall cache row for the day arrived through the apply: " + who);
      }
      assert.equal(await rowCount(N.db, MOVE_DONE_KIND, NOV11), 1,
        "the older instance's Done for the past day is a fact the apply kept too");

      const expected = await movedoneWithStart([NOV11, DAY], DAY);
      const answer = await streakState(N.db, { now: THURSDAY });
      assert.deepEqual(answer, expected,
        "the streak reads exactly as a fresh db holding only those two Done rows and the start day");
      assert.equal(answer.days, 1,
        "the past Done counts under the old rule and the Done-only start day does not count at all");
      assert.equal(answer.todayGood, false,
        "and the start day is not good while it holds no card rows of its own");

      assert.deepEqual(await keysOfKind(O.db, STREAK_V2_KIND), [DAY],
        "the newer instance's start day arrived and the apply invented no other");
    });
  }
});

describe("a newer instance's rows read by an older-shaped reader", () => {
  test("a wallet holding the newer kinds answers differently from its movedone rows alone", async () => {
    const db = createClient({ url: "file::memory:" });
    await initRambleTables(db);
    await seedNewKinds(db);
    assert.deepEqual(await keysOfKind(db, STREAK_V2_KIND), [UPGRADE],
      "the all-cards rule starts on the sixth of November in this wallet");
    await assertOlderReaderAnswer(db, "the single instance");
  });

  for (const [order, label] of ORDERS) {
    test(`the newer kinds cross the merge and only they change the answer (${label})`, async () => {
      const lib = runLibrary();
      const A = await instance("A");
      const B = await instance("B");
      await writeMovedone(A);
      await writeNewKinds(B, lib);

      const pair = { A, B };
      await exchange(pair, order);

      for (const inst of [A, B]) {
        assert.deepEqual(await keysOfKind(inst.db, STREAK_V2_KIND), [UPGRADE],
          "the newer instance's start day reached this wallet: " + inst.name);
        await assertOlderReaderAnswer(inst.db, inst.name);
      }
    });
  }
});

describe("different slots done on each instance complete the day on both", () => {
  for (const [order, label] of ORDERS) {
    test(`the derived day completes both wallets and settles once (${label})`, async () => {
      const A = await instance("A");
      const B = await instance("B");
      for (const inst of [A, B]) {
        // eslint-disable-next-line no-await-in-loop
        await seedRun(inst.db);
      }

      const pair = { A, B };
      await completesTheDay(pair, order);

      const before = { A: await heartsBalance(A.db), B: await heartsBalance(B.db) };
      for (const inst of [A, B]) {
        // eslint-disable-next-line no-await-in-loop
        const settled = await settleDay(inst.db, { day: DAY, now: THURSDAY, emit: inst.emit });
        assert.deepEqual(settled, { complete: true, fresh: true },
          "the derived complete day settles once on this instance: " + inst.name);
      }

      await exchange(pair, order);

      const rises = [];
      for (const inst of [A, B]) {
        assert.equal(await rowCount(inst.db, HEART_KIND, "streak:" + DAY), 1,
          "one streak heart row for the seventh day, whichever settle wrote it: " + inst.name);
        rises.push((await heartsBalance(inst.db)) - before[inst.name]);
      }
      assert.deepEqual(rises, [1, 1],
        "heartsBalance rose by the same one heart on both dbs after the second exchange");
    });
  }
});

/**
 * The guard keeps the first scenario from passing as a no-op: a predicate that
 * never answers "complete" must make that same scenario reject, so its passing
 * with the real `isDayComplete` is an answer about the merged rows.
 */
describe("the vacuity guard", () => {
  test("a predicate that never says complete fails the scenario, the real one resolves", async () => {
    const fresh = async () => ({ A: await instance("A"), B: await instance("B") });

    await assert.rejects(async () => {
      await completesTheDay(await fresh(), "a-first", async () => false);
    }, { message: /completion is derived on this db/ });

    await assert.doesNotReject(async () => {
      await completesTheDay(await fresh(), "a-first");
    }, "the real isDayComplete resolves on the same scenario and a fresh pair");
  });
});