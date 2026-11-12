/**
 * Ramble moves — a day's cards across two Crow instances (moves design Task 6;
 * private engineering notes).
 *
 * Two in-memory dbs stand in for two of the user's instances. Each side's emits
 * are captured and applied to the OTHER side through the shipped
 * applyRambleWallet / applyRambleSetting; no bundle write is ever run on the
 * receiving side to help a merge. The emitting db stamps its own settings row
 * with the lamport its emit carries, exactly as the real emit path does, so a
 * settings row is LWW on the same envelope a peer sees. Wallet rows merge by
 * MIN/MAX on their own columns, so they need no stamp.
 *
 * Every scenario runs in three merge orders: A's rows delivered first, B's
 * rows delivered first, and both queues snapshotted before either is applied.
 *
 * What is pinned here:
 *   - moveneed is a MAX fact: one instance asking for a single card and the
 *     other (stale) for three leaves BOTH days three cards wide,
 *   - with identical inputs both instances draw the same day, slot by slot,
 *     before and after the merge,
 *   - a slot row is last-writer-wins: two weathers, two picks, one value on
 *     both sides, and the merged pick is reused rather than re-picked,
 *   - moveneed is never rewritten by a later read,
 *   - a slot row for a day that has passed is replaced by today's pick,
 *   - moves.week converges to one row with one weekId,
 *   - a Done flag crosses as a wallet row and the receiving instance reads the
 *     slot as done without writing anything,
 *   - a merged day is a read: a further open on either instance emits no row at
 *     all, settings or wallet, so nothing can ping-pong,
 *   - two instances' lamports interleaved across one day (a slot row older than
 *     one instance's `moves.today` row, newer than the other's) still leave one
 *     midday row and one `moves.today` on both sides, and one read reconciles the
 *     Now slot with `moves.today`,
 *   - a day wider than an instance's library can fill keeps the wider moveneed
 *     while that instance's day asks only for the picks it holds,
 *   - a paused instance receives a day another instance drew and stays off.
 *
 * The interleaving scenario pins three rows to exact lamports (pinRow), because
 * the per-instance counter alone always puts one instance's writes above the
 * other's.
 *
 * The shipped library is filled elsewhere, so every test injects its own
 * chunks. The clock is a fixed local Thursday, so nothing here depends on the
 * machine's timezone.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { rowDelta, insertOnce } from "../bundles/ramble/server/steps.js";
import { applyRambleSetting, applyRambleWallet } from "../servers/sharing/instance-sync.js";
import { SLOTS, weekPlan } from "../bundles/ramble/server/moves/week.js";
import { TODAY_KEY, writePrefs } from "../bundles/ramble/server/moves/today.js";
import {
  MOVE_NEED_KIND, SLOT_KEY_PREFIX, WEEK_KEY, dayCards, enabledSlots,
} from "../bundles/ramble/server/moves/slots.js";

/** A fixed local Thursday: 2026-11-12, in ISO week 2026-W46. */
const THURSDAY = new Date(2026, 10, 12, 18, 0, 0, 0).getTime();
/** The local Wednesday before it: 2026-11-11, the same ISO week. */
const WEDNESDAY = new Date(2026, 10, 11, 12, 0, 0, 0).getTime();
const DAY = "2026-11-12";
const WED = "2026-11-11";
const W46 = "2026-W46";

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

/** One eligible chunk for every area a three-card Thursday asks for. */
function library() {
  return [
    chunk({ id: "mob-1", areas: ["mobility", "core"] }),
    chunk({ id: "heart-1", areas: ["heart"] }),
    chunk({ id: "low-1", areas: ["lower"] }),
    chunk({ id: "up-1", areas: ["upper"] }),
  ];
}

/**
 * A library where the weather decides the midday pick: the only heart chunk is
 * outdoor-only, so a rainy instance falls back to the mobility chunks while a
 * dry one takes the heart chunk.
 */
function weatherLibrary() {
  return [
    chunk({ id: "mob-1", areas: ["mobility"] }),
    chunk({ id: "mob-2", areas: ["mobility"] }),
    chunk({ id: "heart-out-1", areas: ["heart"], indoor: false }),
    chunk({ id: "low-1", areas: ["lower"] }),
  ];
}

/**
 * A second library, so two instances picking the same day land on different
 * entries for every slot.
 */
function otherLibrary() {
  return [
    chunk({ id: "mob-9", areas: ["mobility", "core"] }),
    chunk({ id: "heart-9", areas: ["heart"] }),
    chunk({ id: "low-9", areas: ["lower"] }),
    chunk({ id: "up-9", areas: ["upper"] }),
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

/**
 * Build a pair (already holding its own writes), then merge it in one of the
 * three orders. `build` may return extra fields alongside A and B; they come
 * back untouched.
 */
async function converge(build, order) {
  const pair = await build();
  const { A, B } = pair;
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
  return pair;
}

async function readJson(db, key) {
  const { rows } = await db.execute({
    sql: "SELECT value FROM ramble_settings WHERE key = ?", args: [key],
  });
  const value = rows[0]?.value;
  if (typeof value !== "string") return null;
  return JSON.parse(value);
}

async function readRaw(db, key) {
  const { rows } = await db.execute({
    sql: "SELECT value FROM ramble_settings WHERE key = ?", args: [key],
  });
  return rows[0]?.value ?? null;
}

async function settingRowCount(db, key) {
  const { rows } = await db.execute({
    sql: "SELECT key FROM ramble_settings WHERE key = ?", args: [key],
  });
  return rows.length;
}

/** The lamport a settings row carries, so a scenario can name the winner. */
async function readStamp(db, key) {
  const { rows } = await db.execute({
    sql: "SELECT lamport_ts FROM ramble_settings WHERE key = ?", args: [key],
  });
  return rows[0] ? Number(rows[0].lamport_ts) : null;
}

/**
 * Pin one settings row to an exact lamport (and value, when given), both in the
 * db the writing instance keeps and in the row it will emit. The per-instance
 * counter always numbers one instance's writes above the other's, so only a pin
 * can put one instance's slot row BETWEEN two of the other's rows.
 */
async function pinRow(inst, key, { lamport, value }) {
  const kept = inst.ops.filter((op) => !(op.table === "ramble_settings" && op.row?.key === key));
  inst.ops.splice(0, inst.ops.length, ...kept);
  const pinned = value ?? await readRaw(inst.db, key);
  await inst.db.execute({
    sql: "UPDATE ramble_settings SET value = ?, lamport_ts = ?, lamport_origin = ? WHERE key = ?",
    args: [pinned, lamport, ORIGIN[inst.name], key],
  });
  inst.ops.push({
    table: "ramble_settings", op: "update", row: { key, value: pinned },
    lamport, origin: ORIGIN[inst.name],
  });
}

/** A capture emit that only records what a read wrote. */
function capture() {
  const writes = [];
  const emit = async (table, op, row) => { writes.push({ table, op, row: { ...row } }); };
  return { writes, emit };
}

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

/** One slot per name, as `[slot, entryId, area]`, for a slot-by-slot compare. */
const shapeOf = (result) => result.slots.map((item) => [item.slot, item.entryId, item.area]);

const slotNamed = (result, name) => result.slots.find((item) => item.slot === name) ?? null;

/** A asks for one card, B (its prefs still saying three) for three. */
async function needFixture() {
  const A = await instance("A");
  const B = await instance("B");
  await writePrefs(A.db, { cards: 1 });
  await writePrefs(B.db, { cards: 3 });
  const lib = library();
  const one = await dayCards(A.db, { now: THURSDAY, library: lib, emit: A.emit });
  const three = await dayCards(B.db, { now: THURSDAY, library: lib, emit: B.emit });
  assert.deepEqual([one.need, one.slots.map((item) => item.slot)], [1, ["midday"]],
    "A's day is one card");
  assert.deepEqual([three.need, three.slots.map((item) => item.slot)], [3, [...SLOTS]],
    "B's day is three cards");
  return { A, B };
}

/** Both instances open the same day with identical prefs and inputs. */
async function sameDayFixture(lib = library()) {
  const A = await instance("A");
  const B = await instance("B");
  await writePrefs(A.db, { cards: 3 });
  await writePrefs(B.db, { cards: 3 });
  const first = await dayCards(A.db, { now: THURSDAY, library: lib, emit: A.emit });
  const other = await dayCards(B.db, { now: THURSDAY, library: lib, emit: B.emit });
  return { A, B, first, other };
}

/* ------------------------------------------------------------------------ */

describe("moveneed across two instances", () => {
  for (const [order, label] of ORDERS) {
    test(`one card against three merges to three (${label})`, async () => {
      const { A, B } = await converge(needFixture, order);
      for (const inst of [A, B]) {
        assert.deepEqual(await needDeltas(inst.db), [3],
          "the day asks for the wider count, not the last writer's: " + inst.name);
        const day = await dayCards(inst.db, { now: THURSDAY, library: library() });
        assert.equal(day.need, 3, "three cards asked for: " + inst.name);
        assert.deepEqual(day.slots.map((item) => item.slot), [...SLOTS]);
        for (const item of day.slots) {
          assert.ok(item.entryId, "a card in every slot: " + item.slot + " on " + inst.name);
          assert.equal(item.empty, false);
        }
      }
    });
  }

  for (const [order, label] of ORDERS) {
    test(`a later read writes no moveneed row (${label})`, async () => {
      const { A, B } = await converge(needFixture, order);
      for (const inst of [A, B]) {
        const before = await walletSnapshot(inst.db);
        const day = await dayCards(inst.db, { now: THURSDAY, library: library() });
        assert.equal(day.need, 3);
        assert.deepEqual(await walletSnapshot(inst.db), before,
          "no wallet row changes on the second open: " + inst.name);
        assert.deepEqual(await needDeltas(inst.db), [3], "still one row: " + inst.name);
      }
    });
  }
});

describe("identical inputs, one day", () => {
  for (const [order, label] of ORDERS) {
    test(`both instances draw the same cards slot by slot (${label})`, async () => {
      const lib = library();
      const pair = await converge(() => sameDayFixture(lib), order);
      const { A, B, first, other } = pair;

      assert.deepEqual(shapeOf(other), shapeOf(first), "before any merge");
      for (const item of first.slots) {
        assert.ok(item.entryId, "a card in every slot: " + item.slot);
      }

      const readA = await dayCards(A.db, { now: THURSDAY, library: lib });
      const readB = await dayCards(B.db, { now: THURSDAY, library: lib });
      assert.deepEqual(shapeOf(readB), shapeOf(readA), "after the merge");
      assert.deepEqual(shapeOf(readA), shapeOf(first), "and the day did not move");
      assert.deepEqual(readA.slots.map((item) => item.slot), [...SLOTS]);
    });
  }
});

describe("one slot, two weathers", () => {
  for (const [order, label] of ORDERS) {
    test(`the slot row is last-writer-wins and the merged pick is reused (${label})`, async () => {
      const lib = weatherLibrary();
      const build = async () => {
        const A = await instance("A");
        const B = await instance("B");
        const rainy = await dayCards(A.db, {
          now: THURSDAY, library: lib, weather: { rain: 80 }, emit: A.emit,
        });
        const dry = await dayCards(B.db, { now: THURSDAY, library: lib, emit: B.emit });
        return { A, B, rainy, dry };
      };
      const { A, B, rainy, dry } = await converge(build, order);

      const rainyMidday = slotNamed(rainy, "midday");
      const dryMidday = slotNamed(dry, "midday");
      assert.equal(dryMidday.entryId, "heart-out-1", "the dry instance takes the outdoor chunk");
      assert.equal(dryMidday.area, "heart");
      assert.notEqual(rainyMidday.entryId, dryMidday.entryId, "the rain keeps it off the other side");
      assert.equal(rainyMidday.area, "mobility", "that instance's heart slot falls back");

      const values = [];
      for (const inst of [A, B]) {
        const raw = await readRaw(inst.db, SLOT_KEY_PREFIX + "midday");
        const row = await readJson(inst.db, SLOT_KEY_PREFIX + "midday");
        assert.equal(row.day, DAY);
        assert.equal(row.entryId, dryMidday.entryId, "the later write wins here: " + inst.name);
        values.push(raw);
      }
      assert.equal(values[1], values[0], "both instances hold one slot value");

      for (const inst of [A, B]) {
        const writes = [];
        const day = await dayCards(inst.db, {
          now: THURSDAY, library: lib, weather: null,
          emit: async (table, op, row) => writes.push({ table, op, row: { ...row } }),
        });
        assert.equal(slotNamed(day, "midday").entryId, dryMidday.entryId,
          "the merged pick is what the day shows: " + inst.name);
        const slotWrites = writes.filter((w) => w.table === "ramble_settings"
          && String(w.row.key).startsWith(SLOT_KEY_PREFIX));
        assert.deepEqual(slotWrites, [], "the stored pick is reused, not re-picked: " + inst.name);
      }
    });
  }
});

describe("a slot row for a day that has passed", () => {
  for (const [order, label] of ORDERS) {
    test(`today's pick replaces yesterday's on both instances (${label})`, async () => {
      const lib = library();
      const build = async () => {
        const A = await instance("A");
        const B = await instance("B");
        const wedA = await dayCards(A.db, { now: WEDNESDAY, library: lib, emit: A.emit });
        const wedB = await dayCards(B.db, { now: WEDNESDAY, library: lib, emit: B.emit });
        assert.equal(wedA.day, WED);
        assert.equal(wedB.day, WED);
        return { A, B };
      };
      const { A, B } = await converge(build, order);

      for (const inst of [A, B]) {
        const stored = await readJson(inst.db, SLOT_KEY_PREFIX + "morning");
        assert.equal(stored.day, WED, "the stored row is yesterday's: " + inst.name);
      }

      const days = [];
      for (const inst of [A, B]) {
        const writes = [];
        const today = await dayCards(inst.db, {
          now: THURSDAY, library: lib,
          emit: async (table, op, row) => writes.push({ table, op, row: { ...row } }),
        });
        assert.equal(today.day, DAY);
        assert.deepEqual(today.slots.map((item) => item.slot), [...SLOTS]);
        for (const item of today.slots) {
          assert.ok(item.entryId, "a card in every slot: " + item.slot + " on " + inst.name);
        }
        const written = writes.filter((w) => w.table === "ramble_settings"
          && String(w.row.key).startsWith(SLOT_KEY_PREFIX));
        assert.deepEqual(written.map((w) => w.row.key).sort(),
          SLOTS.map((slot) => SLOT_KEY_PREFIX + slot).sort(),
          "every slot was re-picked once: " + inst.name);
        for (const slot of SLOTS) {
          const row = await readJson(inst.db, SLOT_KEY_PREFIX + slot);
          assert.equal(row.day, DAY, "today's pick replaced yesterday's: " + slot + " on " + inst.name);
          assert.equal(row.entryId, slotNamed(today, slot).entryId);
        }
        days.push(today);
      }
      assert.deepEqual(shapeOf(days[1]), shapeOf(days[0]), "both instances drew the same day");
    });
  }
});

describe("the week row", () => {
  for (const [order, label] of ORDERS) {
    test(`one moves.week value with one weekId (${label})`, async () => {
      const lib = library();
      const { A, B } = await converge(() => sameDayFixture(lib), order);

      const weeks = [];
      for (const inst of [A, B]) {
        assert.equal(await settingRowCount(inst.db, WEEK_KEY), 1, "one row: " + inst.name);
        const week = await readJson(inst.db, WEEK_KEY);
        assert.equal(week.weekId, W46);
        assert.equal(week.cards, 3);
        assert.deepEqual(week.days, weekPlan(W46, 3, enabledSlots({ cards: 3 })));
        weeks.push(week);
      }
      assert.deepEqual(weeks[1], weeks[0], "both instances hold the same week");
    });
  }
});

describe("a Done flag by sync", () => {
  for (const [order, label] of ORDERS) {
    test(`the receiving instance reports the slot done and writes nothing (${label})`, async () => {
      const lib = library();
      const { A, B } = await converge(() => sameDayFixture(lib), order);
      const key = `${DAY}:morning`;

      await insertOnce(A.db, "moveslot", key, 1, THURSDAY, A.emit);
      await deliver(drain(A), B);
      assert.equal(await rowDelta(B.db, "moveslot", key), 1, "the fact arrived as one wallet row");

      const before = await walletSnapshot(B.db);
      const writes = [];
      const day = await dayCards(B.db, {
        now: THURSDAY, library: lib,
        emit: async (table, op, row) => writes.push({ table, op, row: { ...row } }),
      });
      const morning = slotNamed(day, "morning");
      assert.equal(morning.done, true, "B reads the slot as done");
      assert.equal(slotNamed(day, "midday").done, false, "and only that slot");
      assert.equal(slotNamed(day, "evening").done, false);
      assert.deepEqual(writes, [], "B writes nothing for it");
      assert.deepEqual(await walletSnapshot(B.db), before, "and no wallet row");
    });
  }
});

describe("a merged day is a read", () => {
  for (const [order, label] of ORDERS) {
    test(`a further open on either instance emits nothing (${label})`, async () => {
      const lib = library();
      const { A, B } = await converge(() => sameDayFixture(lib), order);

      for (const inst of [A, B]) {
        const before = await walletSnapshot(inst.db);
        for (let round = 0; round < 2; round += 1) {
          const { writes, emit } = capture();
          const day = await dayCards(inst.db, { now: THURSDAY, library: lib, emit });
          assert.deepEqual(writes, [],
            "no settings row of any key and no wallet row: " + inst.name);
          assert.deepEqual(day.slots.map((item) => item.slot), [...SLOTS],
            "the day still holds every slot: " + inst.name);
          assert.equal(day.need, 3);
        }
        assert.deepEqual(await walletSnapshot(inst.db), before,
          "the wallet is untouched too: " + inst.name);
        assert.deepEqual(await needDeltas(inst.db), [3], "still one row: " + inst.name);
      }
    });
  }
});

describe("interleaved lamports", () => {
  for (const [order, label] of ORDERS) {
    test(`one midday row and one moves.today, then one read reconciles the Now slot (${label})`, async () => {
      const libA = library();
      const libB = otherLibrary();
      const build = async () => {
        const A = await instance("A");
        const B = await instance("B");
        await writePrefs(A.db, { cards: 3 });
        await writePrefs(B.db, { cards: 3 });
        const dayA = await dayCards(A.db, { now: THURSDAY, library: libA, emit: A.emit });
        const dayB = await dayCards(B.db, { now: THURSDAY, library: libB, emit: B.emit });
        const middayA = slotNamed(dayA, "midday").entryId;
        const middayB = slotNamed(dayB, "midday").entryId;
        assert.notEqual(middayA, middayB, "the two instances drew different midday cards");

        // B's midday row at 10, A's at 15, B's moves.today at 20: A's slot row
        // sits between B's two rows, and B's moves.today is the newest of all.
        await pinRow(A, SLOT_KEY_PREFIX + "midday", { lamport: 15 });
        await pinRow(A, TODAY_KEY, { lamport: 12 });
        await pinRow(B, SLOT_KEY_PREFIX + "midday", { lamport: 10 });
        await pinRow(B, TODAY_KEY, {
          lamport: 20,
          value: JSON.stringify({
            day: DAY, entryId: middayA, swap: 0, seen: [middayA], reasons: [],
          }),
        });
        return { A, B, middayA };
      };
      const { A, B, middayA } = await converge(build, order);
      const lib = [...libA, ...libB];

      const middayRows = [];
      const todayRows = [];
      for (const inst of [A, B]) {
        assert.equal(await readStamp(inst.db, SLOT_KEY_PREFIX + "midday"), 15,
          "A's older midday row outlives B's: " + inst.name);
        assert.equal(await readStamp(inst.db, TODAY_KEY), 20,
          "B's newer moves.today outlives A's: " + inst.name);
        assert.equal((await readJson(inst.db, SLOT_KEY_PREFIX + "midday")).entryId, middayA,
          "the midday row is one value: " + inst.name);
        assert.equal((await readJson(inst.db, TODAY_KEY)).entryId, middayA,
          "and moves.today is the row B wrote: " + inst.name);
        middayRows.push(await readRaw(inst.db, SLOT_KEY_PREFIX + "midday"));
        todayRows.push(await readRaw(inst.db, TODAY_KEY));
      }
      assert.equal(middayRows[1], middayRows[0], "both instances hold the same midday row");
      assert.equal(todayRows[1], todayRows[0], "both instances hold the same moves.today");

      const nowCards = [];
      for (const inst of [A, B]) {
        const { writes, emit } = capture();
        const day = await dayCards(inst.db, { now: THURSDAY, library: lib, emit });
        assert.equal(writes.length, 1, "one row, the Now mirror: " + inst.name);
        assert.equal(writes[0].row.key, TODAY_KEY, "and it is moves.today: " + inst.name);
        const nowEntry = slotNamed(day, day.nowSlot).entryId;
        assert.equal(nowEntry, slotNamed(day, "evening").entryId, "the Now slot is the evening one");
        assert.equal((await readJson(inst.db, TODAY_KEY)).entryId, nowEntry,
          "moves.today holds the Now slot's card: " + inst.name);
        nowCards.push(nowEntry);
      }
      assert.equal(nowCards[1], nowCards[0], "both instances name the same Now card");

      for (const inst of [A, B]) {
        const { writes, emit } = capture();
        await dayCards(inst.db, { now: THURSDAY, library: lib, emit });
        assert.deepEqual(writes, [], "the reconciled day writes nothing: " + inst.name);
      }
    });
  }
});

describe("a day wider than one instance can fill", () => {
  for (const [order, label] of ORDERS) {
    test(`moveneed keeps the MAX and each day asks only for its picks (${label})`, async () => {
      const build = async () => {
        const A = await instance("A");
        const B = await instance("B");
        const libA = library();
        // No heart, mobility or core chunk: B's midday slot asks for heart and
        // falls back to mobility then core, so that slot comes back empty.
        const libB = [
          chunk({ id: "low-9", areas: ["lower"] }),
          chunk({ id: "up-9", areas: ["upper"] }),
        ];
        await writePrefs(A.db, { cards: 3 });
        await writePrefs(B.db, { cards: 3 });
        const full = await dayCards(A.db, { now: THURSDAY, library: libA, emit: A.emit });
        const thin = await dayCards(B.db, { now: THURSDAY, library: libB, emit: B.emit });
        assert.deepEqual([full.need, thin.need], [3, 1], "one day fills, the other cannot");
        assert.equal(slotNamed(thin, "midday").empty, true, "B's midday slot is empty");
        return { A, B, libA, libB };
      };
      const { A, B, libA, libB } = await converge(build, order);

      for (const inst of [A, B]) {
        assert.deepEqual(await needDeltas(inst.db), [3],
          "the wider count is the one that survives: " + inst.name);
      }

      const needs = [];
      for (const [inst, lib] of [[A, libA], [B, libB]]) {
        const day = await dayCards(inst.db, { now: THURSDAY, library: lib });
        const picks = day.slots.filter((item) => item.entryId !== null).length;
        assert.equal(day.need, picks,
          "the day asks for the cards it holds, never more: " + inst.name);
        assert.ok(day.need <= day.slots.length, "and never past its slots: " + inst.name);
        needs.push(day.need);
      }
      assert.deepEqual(needs, [3, 1], "the full day keeps three, the thin one asks for one");
    });
  }
});

describe("a paused day", () => {
  for (const [order, label] of ORDERS) {
    test(`a drawn day lands on the paused instance and its day stays off (${label})`, async () => {
      const lib = library();
      const build = async () => {
        const A = await instance("A");
        const B = await instance("B");
        await writePrefs(A.db, { on: false });
        await writePrefs(B.db, { on: true, cards: 3 });
        const day = await dayCards(B.db, { now: THURSDAY, library: lib, emit: B.emit });
        assert.deepEqual(day.slots.map((item) => item.slot), [...SLOTS]);
        return { A, B, day };
      };
      const { A, B, day } = await converge(build, order);

      for (const inst of [A, B]) {
        for (const slot of SLOTS) {
          const row = await readJson(inst.db, SLOT_KEY_PREFIX + slot);
          assert.ok(row, "the drawn slot reached both instances: " + slot + " on " + inst.name);
          assert.equal(row.day, DAY);
          assert.equal(row.entryId, slotNamed(day, slot).entryId,
            "B's pick is intact on " + inst.name + " for " + slot);
        }
      }

      const before = [];
      for (const slot of SLOTS) before.push(await readRaw(A.db, SLOT_KEY_PREFIX + slot));

      const { writes, emit } = capture();
      const paused = await dayCards(A.db, { now: THURSDAY, library: lib, emit });
      assert.equal(paused.off, true, "A is still paused");
      assert.deepEqual(paused.slots, [], "a paused day has no cards");
      assert.equal(paused.need, 0);
      assert.deepEqual(writes, [], "a paused day writes nothing");

      const after = [];
      for (const slot of SLOTS) after.push(await readRaw(A.db, SLOT_KEY_PREFIX + slot));
      assert.deepEqual(after, before, "the pause did not touch the drawn slots");
    });
  }
});
