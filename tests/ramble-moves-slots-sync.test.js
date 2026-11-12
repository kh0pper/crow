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
 *     slot as done without writing anything.
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
import { writePrefs } from "../bundles/ramble/server/moves/today.js";
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
