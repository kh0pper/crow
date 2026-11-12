/**
 * Ramble moves — a day FINISHED across two Crow instances (moves design Task 8;
 * private engineering notes).
 *
 * Two in-memory dbs stand in for two of the user's instances. Every row is
 * written by the REAL bundle writer on the instance that wrote it, with that
 * instance's `emit` capturing it; the captured wallet rows are applied to the
 * OTHER instance through the shipped `applyRambleWallet` (plain MAX delta, MIN
 * created_at, no callback) and settings rows through `applyRambleSetting`. No
 * bundle write function is ever run on the receiving side to help a merge, and
 * both instances share a fixed local Thursday (2026-11-12, cards 3, the same
 * library), so the day's cards are the same on both.
 *
 * Every scenario runs in the three merge orders of ORDERS: A's rows first, B's
 * rows first, and both queues snapshotted before either is applied.
 *
 * What is pinned here:
 *   - two instances finishing different slots finish the day on BOTH, with
 *     `isDayComplete` derived from the merged rows and no `moveall` row carried
 *     by the apply at all; one settle per instance then leaves exactly one
 *     `moveall` row and one `streak:<day>` heart on each db, and the seventh day
 *     of a seeded six-day run pays once,
 *   - a `movebal` row alone finishes a day another instance has every card of,
 *     and the apply adds that row (plus the area it trained) and nothing else,
 *   - a `moveneed` disagreement resolves to the wider count, so the instance
 *     that asked for one card no longer calls its single Done a finished day,
 *   - the same slot done on both is one `moveslot` row, not two,
 *   - a `movestand` count that crossed a sync counts against `need - 1`, so a
 *     non-balancing stand-in is refused with `last_balance` while a balancing
 *     log is accepted and completes the day,
 *   - two instances' streak start days both survive the merge and the EARLIEST
 *     one decides the rule on both, so a Done-only day after it is not a day on
 *     either instance while a Done-only day before it keeps the old rule,
 *   - a merged and settled day is still a read: a further settle and a further
 *     open write nothing on either instance, so nothing can ping-pong,
 *   - a `local.` settings row (the outdoor session, the stand-in flags) never
 *     leaves the box that wrote it.
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
import { HEART_KIND, heartsBalance } from "../bundles/ramble/server/hearts.js";
import { applyRambleSetting, applyRambleWallet } from "../servers/sharing/instance-sync.js";
import { recordLog } from "../bundles/ramble/server/moves/ledger.js";
import { MOVE_DONE_KIND } from "../bundles/ramble/server/moves/ledger.js";
import { MOVE_AREA_KIND, SLOTS } from "../bundles/ramble/server/moves/week.js";
import {
  MOVE_ALL_KIND, MOVE_BAL_KIND, MOVE_NEED_KIND, MOVE_SLOT_KIND, MOVE_STAND_KIND,
  isDayComplete,
} from "../bundles/ramble/server/moves/day-complete.js";
import {
  assignStandIn, finishOutdoor, recordSlotDone, settleDay, startOutdoor,
} from "../bundles/ramble/server/moves/day.js";
import {
  STREAK_HEART_EVERY, STREAK_V2_KIND, ensureStreakV2, streakState,
} from "../bundles/ramble/server/moves/streak.js";
import { writePrefs } from "../bundles/ramble/server/moves/today.js";
import { dayCards } from "../bundles/ramble/server/moves/slots.js";

/** A fixed local Thursday: 2026-11-12. */
const THURSDAY = new Date(2026, 10, 12, 18, 0, 0, 0).getTime();
/** The local minutes this file adds to it. */
const M = 60_000;
const DAY = "2026-11-12";

/** The six complete days before DAY, so DAY itself is the seventh of a run. */
const RUN = Object.freeze([
  "2026-11-06", "2026-11-07", "2026-11-08", "2026-11-09", "2026-11-10", "2026-11-11",
]);
/** The day the all-cards rule starts on in that run. */
const UPGRADE = "2026-11-06";

/** The days the streak-start scenario files its rows under. */
const NOV19 = "2026-11-19";
const NOV20 = "2026-11-20";
const NOV21 = "2026-11-21";
const NOV22 = "2026-11-22";
const NOV23 = "2026-11-23";
/** Local noon of each, so day arithmetic is timezone-safe. */
const NOON19 = new Date(2026, 10, 19, 12, 0, 0, 0).getTime();
const NOON20 = new Date(2026, 10, 20, 12, 0, 0, 0).getTime();
const NOON22 = new Date(2026, 10, 22, 12, 0, 0, 0).getTime();
const NOON23 = new Date(2026, 10, 23, 12, 0, 0, 0).getTime();

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

/**
 * One instance: a fresh db, a capture emit that stamps the writing side, and
 * `seen`, every row it ever emitted (so a row that never leaves this box can
 * still be spotted after the queues are drained).
 */
async function instance(name) {
  const db = createClient({ url: "file::memory:" });
  await initRambleTables(db);
  const ops = [];
  const seen = [];
  let seq = 0;
  const emit = async (table, op, row) => {
    seq += 1;
    const lamport = LAMPORT_BASE[name] + seq;
    const captured = { table, op, row: { ...row }, lamport, origin: ORIGIN[name] };
    ops.push(captured);
    seen.push(captured);
    await stampWrote(db, table, op, row, lamport, ORIGIN[name]);
  };
  return { name, db, ops, seen, emit };
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

/** A ledger row written straight into a db, as the streak tests seed theirs. */
async function fact(db, kind, key, delta = 1, createdAt = 0) {
  await db.execute({
    sql: "INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES (?, ?, ?, ?)",
    args: [kind, key, delta, createdAt],
  });
}

/** One complete day from its rows alone: one card asked for, its slot done, balanced. */
async function seedCompleteDay(db, dayStr) {
  await fact(db, MOVE_NEED_KIND, dayStr, 1);
  await fact(db, MOVE_SLOT_KIND, `${dayStr}:morning`, 1);
  await fact(db, MOVE_BAL_KIND, dayStr, 1);
}

/** Six complete days plus the day the all-cards rule starts on. */
async function seedRun(db) {
  for (const dayStr of RUN) {
    // eslint-disable-next-line no-await-in-loop
    await seedCompleteDay(db, dayStr);
  }
  await fact(db, STREAK_V2_KIND, UPGRADE, 1);
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

/** The day's stand-ins, by slot. */
const standKeys = (db) => keysOfKind(db, MOVE_STAND_KIND);

/** The wallet's `moveneed` deltas for a day, as numbers. */
async function needDeltas(db, day = DAY) {
  const { rows } = await db.execute({
    sql: "SELECT delta FROM ramble_wallet WHERE kind = ? AND key = ?",
    args: [MOVE_NEED_KIND, day],
  });
  return rows.map((r) => Number(r.delta));
}

/** Every wallet row as plain values, so one extra row shows up. */
async function walletSnapshot(db) {
  const { rows } = await db.execute({
    sql: "SELECT kind, key, delta FROM ramble_wallet ORDER BY kind, key", args: [],
  });
  return rows.map((r) => [String(r.kind), String(r.key), Number(r.delta)]);
}

/** The rows an apply ADDED, in the snapshot's own order. */
function addedRows(before, after) {
  const held = new Map(before.map(([kind, key, delta]) => [kind + ":" + key, delta]));
  const added = [];
  for (const [kind, key, delta] of after) {
    const had = held.get(kind + ":" + key);
    if (had === undefined) added.push([kind, key, delta]);
    else if (had !== delta) added.push([kind, key, "delta " + had + " -> " + delta]);
  }
  return added;
}

/** No `local.` setting ever leaves the instance that wrote it. */
function assertNoLocalEmit(inst) {
  const offenders = inst.seen.filter((op) => String(op.row?.key ?? "").startsWith("local."));
  assert.deepEqual(offenders, [], "no local. row leaves this box: " + inst.name);
}

/** Both instances open the fixed Thursday with the same prefs and library. */
async function openDay(inst, lib = library()) {
  await writePrefs(inst.db, { cards: 3 });
  return dayCards(inst.db, { now: THURSDAY, library: lib, emit: inst.emit });
}

/* ------------------------------------------------------------------------ */

describe("different slots done on each instance", () => {
  for (const [order, label] of ORDERS) {
    test(`the day completes on both and settles once (${label})`, async () => {
      const lib = library();
      const build = async () => {
        const A = await instance("A");
        const B = await instance("B");
        await openDay(A, lib);
        await openDay(B, lib);
        for (const inst of [A, B]) {
          // eslint-disable-next-line no-await-in-loop
          await seedRun(inst.db);
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
        return { A, B };
      };

      const pair = await build();
      const { A, B } = pair;

      for (const inst of [A, B]) {
        assert.equal(await isDayComplete(inst.db, DAY), false,
          "the day is not finished before the exchange: " + inst.name);
        assert.deepEqual(await keysOfKind(inst.db, MOVE_ALL_KIND), [],
          "and no cache row says otherwise: " + inst.name);
        assert.equal(await heartsBalance(inst.db), 0, "nothing has settled yet: " + inst.name);
      }

      await exchange(pair, order);

      for (const inst of [A, B]) {
        assert.equal(await isDayComplete(inst.db, DAY), true,
          "the other instance's slots finished the day: " + inst.name);
        assert.deepEqual(await keysOfKind(inst.db, MOVE_ALL_KIND), [],
          "completion is derived; the apply carried no moveall row: " + inst.name);
      }

      for (const inst of [A, B]) {
        const settled = await settleDay(inst.db, { day: DAY, now: THURSDAY, emit: inst.emit });
        assert.deepEqual(settled, { complete: true, fresh: true },
          "the finished day settles once: " + inst.name);
      }

      await exchange(pair, order);

      for (const inst of [A, B]) {
        assert.equal(await rowCount(inst.db, MOVE_ALL_KIND, DAY), 1,
          "one moveall row after both settles met: " + inst.name);
        assert.equal(await rowCount(inst.db, HEART_KIND, "streak:" + DAY), 1,
          "one heart row for the seventh day: " + inst.name);
        assert.equal(await heartsBalance(inst.db), 1, "and the balance rose by one: " + inst.name);
        assertNoLocalEmit(inst);
      }
    });
  }
});

describe("a balance row from the other instance", () => {
  for (const [order, label] of ORDERS) {
    test(`the day finishes where the cards are, with no other row written (${label})`, async () => {
      const lib = library();
      const build = async () => {
        const A = await instance("A");
        const B = await instance("B");
        const cardsA = await openDay(A, lib);
        const cardsB = await openDay(B, lib);
        assert.deepEqual(cardsA.slots.map((item) => item.area), ["mobility", "heart", "lower"],
          "the fixed Thursday's plan");
        assert.equal(cardsA.need, 3);

        // B holds every card of the day, from the walk and a stand-in via, so
        // none of them is the player's own session and none can balance it.
        await startOutdoor(B.db, { day: DAY, entryId: "walk-1", now: THURSDAY });
        const walk = await finishOutdoor(B.db, {
          day: DAY, now: THURSDAY + 30 * M, emit: B.emit, cards: cardsB,
        });
        assert.deepEqual(walk.filled, ["midday", "morning"], "a 30-minute walk stands in for two cards");
        await recordSlotDone(B.db, {
          day: DAY,
          slot: "evening",
          entry: { kind: "stand-in", areas: [] },
          via: "standin-steps",
          now: THURSDAY + 31 * M,
          emit: B.emit,
          need: cardsB.need,
        });

        // A's own chunk beyond the day's cards: it closes no slot and balances.
        await recordSlotDone(A.db, {
          day: DAY,
          slot: null,
          entry: { kind: "routine", areas: ["mobility"] },
          via: "player",
          now: THURSDAY + 32 * M,
          emit: A.emit,
          need: cardsA.need,
        });
        return { A, B };
      };

      const pair = await build();
      const { A, B } = pair;

      assert.equal(await rowCount(B.db, MOVE_BAL_KIND, DAY), 0, "B has no balance row of its own");
      assert.deepEqual(await standKeys(B.db), [`${DAY}:midday`, `${DAY}:morning`],
        "B's walk wrote the day's stand-in rows");
      assert.equal(await isDayComplete(B.db, DAY), false, "three cards, and still no balance");

      const before = await walletSnapshot(B.db);
      await exchange(pair, order);
      const after = await walletSnapshot(B.db);

      assert.equal(await isDayComplete(B.db, DAY), true, "A's balance row finished the day on B");
      assert.deepEqual(addedRows(before, after), [
        [MOVE_AREA_KIND, `${DAY}:mobility`, 1],
        [MOVE_BAL_KIND, DAY, 1],
      ], "the apply added the delivered balance and its area, and nothing else");
      assert.equal(await rowCount(B.db, MOVE_SLOT_KIND, `${DAY}:evening`), 1,
        "B's own third card is still one row");

      assert.equal(await isDayComplete(A.db, DAY), true,
        "the slots crossing the other way finished A's day too");
    });
  }
});

describe("a card count two instances disagree about", () => {
  for (const [order, label] of ORDERS) {
    test(`the wider count wins and one Done stops finishing the day (${label})`, async () => {
      const lib = library();
      const build = async () => {
        const A = await instance("A");
        const B = await instance("B");
        await writePrefs(A.db, { cards: 1 });
        await writePrefs(B.db, { cards: 3 });
        const one = await dayCards(A.db, { now: THURSDAY, library: lib, emit: A.emit });
        const three = await dayCards(B.db, { now: THURSDAY, library: lib, emit: B.emit });
        assert.deepEqual([one.need, one.slots.map((item) => item.slot)], [1, ["midday"]],
          "A's day asks for one card");
        assert.deepEqual([three.need, three.slots.map((item) => item.slot)], [3, [...SLOTS]],
          "B's day asks for three");
        await recordSlotDone(A.db, {
          day: DAY,
          slot: "midday",
          entry: { kind: "routine", areas: ["mobility"] },
          via: "player",
          now: THURSDAY,
          emit: A.emit,
          need: one.need,
        });
        return { A, B };
      };

      const pair = await build();
      const { A, B } = pair;
      assert.equal(await isDayComplete(A.db, DAY), true, "one card, finished and balanced, before the exchange");

      await exchange(pair, order);

      for (const inst of [A, B]) {
        assert.deepEqual(await needDeltas(inst.db), [3],
          "the wider count is the one that survives: " + inst.name);
      }
      assert.equal(await isDayComplete(A.db, DAY), false,
        "the single Done no longer finishes a three-card day");
      assert.equal(await rowCount(A.db, MOVE_SLOT_KIND, `${DAY}:midday`), 1,
        "and no card of the day was taken away");
    });
  }
});

describe("the same slot done on both instances", () => {
  for (const [order, label] of ORDERS) {
    test(`one moveslot row per db after the merge (${label})`, async () => {
      const lib = library();
      const build = async () => {
        const A = await instance("A");
        const B = await instance("B");
        await openDay(A, lib);
        await openDay(B, lib);
        await recordSlotDone(A.db, {
          day: DAY,
          slot: "morning",
          entry: { kind: "routine", areas: ["mobility"] },
          via: "player",
          now: THURSDAY,
          emit: A.emit,
        });
        await recordSlotDone(B.db, {
          day: DAY,
          slot: "morning",
          entry: { kind: "routine", areas: ["mobility"] },
          via: "class",
          now: THURSDAY + M,
          emit: B.emit,
        });
        return { A, B };
      };

      const pair = await build();
      const { A, B } = pair;
      for (const inst of [A, B]) {
        assert.equal(await rowCount(inst.db, MOVE_SLOT_KIND, `${DAY}:morning`), 1,
          "one row on each side before the exchange: " + inst.name);
      }

      await exchange(pair, order);

      for (const inst of [A, B]) {
        assert.equal(await rowCount(inst.db, MOVE_SLOT_KIND, `${DAY}:morning`), 1,
          "still one row for the slot: " + inst.name);
        assert.equal(await rowDelta(inst.db, MOVE_SLOT_KIND, `${DAY}:morning`), 1,
          "worth one card: " + inst.name);
        assert.deepEqual(await keysOfKind(inst.db, MOVE_SLOT_KIND), [`${DAY}:morning`],
          "and no second slot was invented: " + inst.name);
      }
    });
  }
});

describe("a walk on one instance, a stand-in on the other", () => {
  for (const [order, label] of ORDERS) {
    test(`the merged stand-in count refuses a second one, a balancing log finishes the day (${label})`, async () => {
      const lib = library();
      const build = async () => {
        const A = await instance("A");
        const B = await instance("B");
        const cardsA = await openDay(A, lib);
        await openDay(B, lib);
        await startOutdoor(A.db, { day: DAY, entryId: "walk-1", now: THURSDAY });
        const walk = await finishOutdoor(A.db, {
          day: DAY, now: THURSDAY + 30 * M, emit: A.emit, cards: cardsA,
        });
        assert.deepEqual(walk.filled, ["midday", "morning"], "the walker stands in for two cards");
        assert.equal(walk.needsBalance, true, "the day still wants a balancing chunk");
        return { A, B };
      };

      const pair = await build();
      const { A, B } = pair;
      assert.deepEqual(await standKeys(A.db), [`${DAY}:midday`, `${DAY}:morning`],
        "the walker's two stand-in rows");
      assert.deepEqual(await standKeys(B.db), [], "B has used none");
      assert.equal(await isDayComplete(B.db, DAY), false);

      await exchange(pair, order);

      assert.deepEqual(await standKeys(B.db), [`${DAY}:midday`, `${DAY}:morning`],
        "the stand-in rows came through the merge");
      const ownStands = B.seen.filter((op) => op.table === "ramble_wallet"
        && op.row?.kind === MOVE_STAND_KIND
        && String(op.row?.key ?? "").startsWith(DAY + ":"));
      assert.deepEqual(ownStands, [], "B wrote no stand-in row of its own");

      const cardsB = await dayCards(B.db, { now: THURSDAY, library: lib });
      assert.equal(cardsB.need, 3);
      const cardsIn = { need: cardsB.need, slots: cardsB.slots };

      const walkLog = await recordLog(B.db, {
        activity: "walk", minutes: 12, effort: "easy", now: THURSDAY + 40 * M, emit: B.emit,
      });
      const refused = await assignStandIn(B.db, {
        day: DAY,
        source: "log",
        logKey: walkLog.key,
        now: THURSDAY + 41 * M,
        emit: B.emit,
        cards: cardsIn,
      });
      assert.deepEqual(refused, { ok: false, reason: "last_balance" },
        "two stand-ins already reach need - 1, so a third is refused");
      assert.deepEqual(await standKeys(B.db), [`${DAY}:midday`, `${DAY}:morning`],
        "the refusal wrote no stand-in row");
      assert.equal(await rowDelta(B.db, MOVE_BAL_KIND, DAY), null, "and it balanced nothing");

      const yogaLog = await recordLog(B.db, {
        activity: "yoga", minutes: 10, effort: "easy", area: "mobility",
        now: THURSDAY + 42 * M, emit: B.emit,
      });
      const accepted = await assignStandIn(B.db, {
        day: DAY,
        source: "log",
        logKey: yogaLog.key,
        area: "mobility",
        now: THURSDAY + 43 * M,
        emit: B.emit,
        cards: cardsIn,
      });
      assert.deepEqual(accepted, { ok: true, slot: "evening", all: true },
        "a balancing log is exempt from the count and finishes the day");
      assert.equal(await isDayComplete(B.db, DAY), true);
      assert.deepEqual(await standKeys(B.db), [`${DAY}:evening`, `${DAY}:midday`, `${DAY}:morning`],
        "the balancing stand-in is marked too");
      assert.equal(await rowDelta(B.db, MOVE_BAL_KIND, DAY), 1, "and it is the day's balance");

      // The same card and balance crossing back finish A's day.
      await deliver(drain(B), A);
      assert.equal(await isDayComplete(A.db, DAY), true,
        "B's card and balance finished A's day");
      assertNoLocalEmit(A);
      assertNoLocalEmit(B);
    });
  }
});

describe("the streak's start day across a sync", () => {
  for (const [order, label] of ORDERS) {
    test(`the earliest start decides the rule on both instances (${label})`, async () => {
      const A = await instance("A");
      const B = await instance("B");
      assert.equal(await ensureStreakV2(A.db, { day: NOV20, now: NOON20, emit: A.emit }), true,
        "A's rule starts on the 20th");
      assert.equal(await ensureStreakV2(B.db, { day: NOV23, now: NOON23, emit: B.emit }), true,
        "B's rule starts on the 23rd");

      // The same ledger on both: the 20th, 22nd and 23rd finished, a Done-only
      // 21st between them, and a Done-only 19th before the earliest start.
      for (const inst of [A, B]) {
        for (const dayStr of [NOV20, NOV22, NOV23]) {
          // eslint-disable-next-line no-await-in-loop
          await seedCompleteDay(inst.db, dayStr);
        }
        // eslint-disable-next-line no-await-in-loop
        await fact(inst.db, MOVE_DONE_KIND, NOV19, 1);
        // eslint-disable-next-line no-await-in-loop
        await fact(inst.db, MOVE_DONE_KIND, NOV21, 1);
      }

      // Before the exchange each instance reads with its own start day, and the
      // 21st therefore reads differently on the two.
      const beforeA = await streakState(A.db, { now: NOON23 });
      const beforeB = await streakState(B.db, { now: NOON23 });
      assert.notDeepEqual(beforeB, beforeA,
        "one instance's own start day is not the other's answer yet");
      assert.deepEqual(beforeA, { days: 2, nextHeartAt: STREAK_HEART_EVERY, todayGood: true },
        "from the 20th the Done-only 21st is not a day");

      const pair = { A, B };
      await exchange(pair, order);

      for (const inst of [A, B]) {
        assert.deepEqual(await keysOfKind(inst.db, STREAK_V2_KIND), [NOV20, NOV23],
          "both start days survive on both: " + inst.name);
      }

      const at23 = [];
      for (const inst of [A, B]) at23.push(await streakState(inst.db, { now: NOON23 }));
      assert.deepEqual(at23[1], at23[0], "the same answer on both instances");
      assert.deepEqual(at23[0], { days: 2, nextHeartAt: STREAK_HEART_EVERY, todayGood: true },
        "the earliest start wins, so the Done-only 21st stops the run on both");

      // Finish the 21st and the run reaches back through the 20th to the 19th,
      // which is before the earliest start day and keeps the old rule.
      for (const inst of [A, B]) {
        // eslint-disable-next-line no-await-in-loop
        await seedCompleteDay(inst.db, NOV21);
      }
      const at22 = [];
      for (const inst of [A, B]) at22.push(await streakState(inst.db, { now: NOON22 }));
      assert.deepEqual(at22[1], at22[0], "the same answer on both instances on the 22nd");
      assert.deepEqual(at22[0], { days: 4, nextHeartAt: STREAK_HEART_EVERY, todayGood: true },
        "four days, so the Done-only 19th still counts under the old rule");
      assert.ok(NOON19 < NOON20, "the 19th is before both start days");
    });
  }
});

describe("a merged and settled day is still a read", () => {
  for (const [order, label] of ORDERS) {
    test(`a further settle and a further open emit nothing (${label})`, async () => {
      const lib = library();
      const build = async () => {
        const A = await instance("A");
        const B = await instance("B");
        await openDay(A, lib);
        await openDay(B, lib);
        await recordSlotDone(A.db, {
          day: DAY,
          slot: "morning",
          entry: { kind: "routine", areas: ["mobility"] },
          via: "player",
          now: THURSDAY,
          emit: A.emit,
        });
        await recordSlotDone(B.db, {
          day: DAY,
          slot: "midday",
          entry: { kind: "routine", areas: ["heart"] },
          via: "class",
          now: THURSDAY + M,
          emit: B.emit,
        });
        await recordSlotDone(B.db, {
          day: DAY,
          slot: "evening",
          entry: { kind: "routine", areas: ["lower"] },
          via: "player",
          now: THURSDAY + 2 * M,
          emit: B.emit,
        });
        return { A, B };
      };

      const pair = await build();
      const { A, B } = pair;
      await exchange(pair, order);
      for (const inst of [A, B]) {
        assert.equal(await isDayComplete(inst.db, DAY), true, "the day is finished: " + inst.name);
      }

      for (const inst of [A, B]) {
        const settled = await settleDay(inst.db, { day: DAY, now: THURSDAY, emit: inst.emit });
        assert.equal(settled.complete, true, "settled: " + inst.name);
      }
      await exchange(pair, order);

      for (const inst of [A, B]) {
        const before = await walletSnapshot(inst.db);
        const { writes, emit } = capture();
        const again = await settleDay(inst.db, { day: DAY, now: THURSDAY, emit });
        assert.deepEqual(again, { complete: true, fresh: false },
          "a second settle finds the row it already kept: " + inst.name);
        const day = await dayCards(inst.db, { now: THURSDAY, library: lib, emit });
        assert.equal(day.need, 3, "the day still holds its cards: " + inst.name);
        assert.equal(await isDayComplete(inst.db, DAY), true);
        assert.deepEqual(writes, [],
          "no wallet row of any kind and no settings row: " + inst.name);
        assert.deepEqual(await walletSnapshot(inst.db), before,
          "the wallet is untouched too: " + inst.name);
      }
    });
  }
});
