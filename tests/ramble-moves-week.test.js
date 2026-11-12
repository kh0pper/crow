/**
 * Ramble moves — the week plan and the week's balance (moves design Task 4;
 * private engineering notes).
 *
 * What is pinned here:
 *   - the week is an ISO 8601 week of the LOCAL date (Monday first), read the
 *     same on the Monday and on the Sunday, and a new week on the next Monday,
 *   - the seven day strings of a week, and no days at all for a junk week id,
 *   - the plan is fixed and deep-equal on repeat calls: three cards put
 *     mobility in the first slot and heart in the second every day, two cards
 *     spread all five areas over the week, one card follows its own table,
 *   - every day of every plan leaves something for a balancing area to do, and
 *     a named set of slots is used only when it fits the day's card count,
 *   - the week's state is read from the wallet's "movearea" rows: only this
 *     week's days, only real areas, one row per day and area, and the read
 *     writes nothing,
 *   - the weights ask for 3 from an area short of two days and 0.5 from one
 *     that has them, and 1 from everything once the week is full,
 *   - a week of picks built from two-area chunks marks every balancing area on
 *     at least two days, while single-area chunks leave one short.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { AREAS, BALANCE_AREAS } from "../bundles/ramble/server/moves/library.js";
import { pickChunk } from "../bundles/ramble/server/moves/picker.js";
import {
  MOVE_AREA_KIND, SLOTS, areaWeights, defaultSlots, weekDays, weekIdOf, weekPlan, weekState,
} from "../bundles/ramble/server/moves/week.js";

/** Local noon on a fixed local day, so the whole file is timezone-independent. */
const noon = (y, m, d) => new Date(y, m - 1, d, 12, 0, 0, 0).getTime();
const W46 = "2026-W46";
const NOON_W46 = noon(2026, 11, 12);

async function freshDb() {
  const db = createClient({ url: "file::memory:" });
  await initRambleTables(db);
  return db;
}

async function walletRows(db) {
  const result = await db.execute({
    sql: "SELECT COUNT(*) AS n FROM ramble_wallet", args: [],
  });
  return Number(result.rows[0].n);
}

async function insertMark(db, key, { kind = MOVE_AREA_KIND, delta = 1 } = {}) {
  await db.execute({
    sql: "INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES (?, ?, ?, 0)",
    args: [kind, key, delta],
  });
}

/** A picker-shaped chunk; each fixture overrides exactly what it is about. */
function chunk(over = {}) {
  return {
    id: "week-1",
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

test("weekIdOf: the ISO week of the local date, Monday to Sunday", () => {
  assert.equal(weekIdOf(NOON_W46), W46);
  assert.equal(weekIdOf(noon(2026, 1, 1)), "2026-W01");
  assert.equal(weekIdOf(noon(2027, 1, 1)), "2026-W53");
  assert.equal(weekIdOf(noon(2026, 11, 9)), weekIdOf(noon(2026, 11, 15)),
    "the Monday and the Sunday of one week agree");
  assert.equal(weekIdOf(noon(2026, 11, 9)), W46);
  assert.equal(weekIdOf(noon(2026, 11, 15)), W46);
  assert.equal(weekIdOf(noon(2026, 11, 16)), "2026-W47", "the next Monday is a new week");
});

test("weekDays: seven local days, Monday first; a junk week id is no days", () => {
  assert.deepEqual(weekDays(W46), [
    "2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12",
    "2026-11-13", "2026-11-14", "2026-11-15",
  ]);
  assert.equal(weekDays(W46).length, 7);
  assert.deepEqual(weekDays("2027-W01"), [
    "2027-01-04", "2027-01-05", "2027-01-06", "2027-01-07",
    "2027-01-08", "2027-01-09", "2027-01-10",
  ]);
  for (const junk of ["", "nope", "2026-W00", "2026-W54", "2025-W53", "2026-46", "2026W46", null, undefined]) {
    assert.deepEqual(weekDays(junk), [], "no days for " + String(junk));
  }
});

test("weekPlan: fixed tables, deep-equal on repeat calls, every day balanced", () => {
  for (const cards of [1, 2, 3, 7]) {
    assert.deepEqual(weekPlan(W46, cards), weekPlan(W46, cards),
      "the plan never changes between calls: " + cards);
  }

  const three = weekPlan(W46, 3);
  assert.equal(three.length, 7);
  assert.deepEqual(three.map((d) => d.dayIndex), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(three.map((d) => d.slots.morning), new Array(7).fill("mobility"),
    "the first slot is mobility every day");
  assert.deepEqual(three.map((d) => d.slots.midday), new Array(7).fill("heart"),
    "the second slot is heart every day");
  assert.deepEqual(three.map((d) => d.slots.evening),
    ["lower", "upper", "core", "lower", "upper", "core", "free"]);
  assert.deepEqual(Object.keys(three[0].slots), ["morning", "midday", "evening"]);

  const two = weekPlan(W46, 2);
  for (const area of AREAS) {
    const days = two.filter((d) => Object.values(d.slots).includes(area)).length;
    assert.ok(days >= 2, "two cards reach " + area + " on at least two days, got " + days);
  }

  const one = weekPlan(W46, 1);
  assert.deepEqual(one.map((d) => d.slots.midday),
    ["mobility", "lower", "upper", "core", "mobility", "lower", "upper"]);
  for (const day of one) {
    assert.deepEqual(Object.keys(day.slots), ["midday"], "one card only uses the midday slot");
    assert.equal(Object.values(day.slots).includes("heart"), false, "one card never asks for heart");
  }

  for (const plan of [weekPlan(W46, 1), two, three]) {
    for (const day of plan) {
      const areas = Object.values(day.slots);
      assert.ok(areas.some((a) => BALANCE_AREAS.includes(a)),
        "day " + day.dayIndex + " leaves a balancing area to train: " + areas.join(", "));
    }
  }

  assert.deepEqual(defaultSlots(1), ["midday"]);
  assert.deepEqual(defaultSlots(2), ["morning", "evening"]);
  assert.deepEqual(defaultSlots(3), ["morning", "midday", "evening"]);
  assert.deepEqual(defaultSlots(7), ["morning", "midday", "evening"]);
  assert.deepEqual(SLOTS, ["morning", "midday", "evening"]);
});

test("weekPlan: named windows are used when they fit, defaults otherwise", () => {
  const named = weekPlan(W46, 2, ["morning", "evening"]);
  for (const day of named) {
    assert.deepEqual(Object.keys(day.slots), ["morning", "evening"]);
  }
  assert.deepEqual(named.map((d) => d.slots.morning),
    ["mobility", "heart", "core", "heart", "upper", "mobility", "lower"]);
  assert.deepEqual(named.map((d) => d.slots.evening),
    ["lower", "upper", "mobility", "lower", "core", "free", "upper"]);

  const middays = weekPlan(W46, 2, ["midday", "evening"]);
  for (const day of middays) {
    assert.deepEqual(Object.keys(day.slots), ["midday", "evening"]);
  }

  // Wrong length, a duplicate and a name that is not a slot all fall back.
  for (const windows of [["morning"], ["morning", "midday", "evening"], ["morning", "morning"], ["morning", "nope"]]) {
    assert.deepEqual(weekPlan(W46, 2, windows), weekPlan(W46, 2),
      "falls back to the default slots: " + JSON.stringify(windows));
  }
  assert.deepEqual(weekPlan(W46, 2, "morning"), weekPlan(W46, 2),
    "a windows value that is not an array falls back too");

  const seven = weekPlan(W46, 7);
  assert.deepEqual(seven, weekPlan(W46, 3), "a card count of 7 behaves as 3");
  assert.equal(seven[6].slots.evening, "free");
});

test("weekState: a fresh db is an empty week, and the read writes nothing", async () => {
  const db = await freshDb();
  const empty = await weekState(db, { now: NOON_W46 });
  assert.equal(empty.weekId, W46);
  assert.equal(empty.total, 0);
  assert.equal(empty.full, false);
  assert.deepEqual(Object.keys(empty.marks).sort(), [...AREAS].sort());
  for (const area of AREAS) assert.deepEqual(empty.marks[area], []);

  const before = await walletRows(db);
  await weekState(db, { now: NOON_W46 });
  assert.equal(await walletRows(db), before, "reading the week adds no rows");
});

test("weekState: this week's rows only, one mark per day and area, two days count 2", async () => {
  const db = await freshDb();
  await insertMark(db, "2026-11-09:lower");
  let state = await weekState(db, { now: NOON_W46 });
  assert.deepEqual(state.marks.lower, ["2026-11-09"]);
  assert.equal(state.total, 1);
  assert.equal(state.full, false);

  await insertMark(db, "2026-11-10:lower");
  state = await weekState(db, { now: NOON_W46 });
  assert.deepEqual(state.marks.lower, ["2026-11-09", "2026-11-10"], "sorted ascending");
  assert.equal(state.total, 2);

  await insertMark(db, "2026-11-12:lower");
  state = await weekState(db, { now: NOON_W46 });
  assert.deepEqual(state.marks.lower, ["2026-11-09", "2026-11-10", "2026-11-12"]);
  assert.equal(state.total, 2, "a third day of one area still counts 2");

  assert.deepEqual(state.marks.upper, []);
  assert.deepEqual(state.marks.core, []);
  assert.deepEqual(state.marks.heart, []);
  assert.deepEqual(state.marks.mobility, []);
});

test("weekState: another week's rows and malformed keys are ignored", async () => {
  const db = await freshDb();
  await insertMark(db, "2026-11-09:upper");
  // Not this week: the Monday before, the Monday after, and a day string only.
  await insertMark(db, "2026-11-02:upper");
  await insertMark(db, "2026-11-16:upper");
  // In range but not "<day>:<area>" with a real area.
  await insertMark(db, "2026-11-09");
  await insertMark(db, "2026-11-09:upper:extra");
  await insertMark(db, "2026-11-09:tail");
  await insertMark(db, "2026-11-10:Upper");
  await insertMark(db, "not-a-day:core");
  // Right shape, wrong wallet kind.
  await insertMark(db, "2026-11-10:core", { kind: "steps" });

  const state = await weekState(db, { now: NOON_W46 });
  assert.deepEqual(state.marks.upper, ["2026-11-09"]);
  for (const area of ["core", "lower", "heart", "mobility"]) {
    assert.deepEqual(state.marks[area], [], "no stray mark for " + area);
  }
  assert.equal(state.total, 1);
});

test("weekState: two days in every area is a full week", async () => {
  const db = await freshDb();
  for (const area of AREAS) {
    await insertMark(db, "2026-11-09:" + area);
    await insertMark(db, "2026-11-11:" + area);
  }
  const state = await weekState(db, { now: NOON_W46 });
  for (const area of AREAS) {
    assert.deepEqual(state.marks[area], ["2026-11-09", "2026-11-11"]);
  }
  assert.equal(state.total, 10);
  assert.equal(state.full, true);
});

test("areaWeights: 3 while an area is short of two days, 0.5 once it has them", () => {
  const marks = (over) => ({
    upper: [], core: [], lower: [], heart: [], mobility: [], ...over,
  });
  const weights = areaWeights({
    weekId: W46,
    marks: marks({
      upper: ["2026-11-09"],
      lower: ["2026-11-09", "2026-11-10"],
      heart: ["2026-11-09", "2026-11-10", "2026-11-11"],
    }),
    total: 6,
    full: false,
  });
  assert.equal(weights.upper, 3, "one day is still short");
  assert.equal(weights.core, 3, "no day at all is short");
  assert.equal(weights.heart, 0.5, "three days are more than enough");
  assert.equal(weights.lower, 0.5, "two days are enough");
  assert.equal(weights.mobility, 3);

  const full = areaWeights({
    weekId: W46,
    marks: marks({
      upper: ["2026-11-09", "2026-11-10"],
      core: ["2026-11-09", "2026-11-10"],
      lower: ["2026-11-09", "2026-11-10"],
      heart: ["2026-11-09", "2026-11-10"],
      mobility: ["2026-11-09", "2026-11-10"],
    }),
    total: 10,
    full: true,
  });
  for (const area of AREAS) assert.equal(full[area], 1, "a full week asks for nothing extra: " + area);

  for (const junk of [null, undefined, {}, { marks: null }, "nope", 3]) {
    const plain = areaWeights(junk);
    for (const area of AREAS) assert.equal(plain[area], 1, "a junk state asks for nothing: " + area);
  }
});

test("areaWeights: a week that missed mobility and lower asks for the other three areas", async () => {
  const db = await freshDb();
  await insertMark(db, "2026-11-09:mobility");
  await insertMark(db, "2026-11-09:lower");
  await insertMark(db, "2026-11-10:mobility");
  await insertMark(db, "2026-11-10:lower");

  const state = await weekState(db, { now: NOON_W46 });
  const weights = areaWeights(state);
  assert.equal(weights.upper, 3);
  assert.equal(weights.core, 3);
  assert.equal(weights.heart, 3);
  assert.equal(weights.mobility, 0.5);
  assert.equal(weights.lower, 0.5);
  assert.equal(state.full, false);
});

/** The plan's area for the one card on `dayIndex`. */
const oneCardArea = (plan, dayIndex) => plan[dayIndex].slots.midday;

/** The marks object a week state carries, from the day list per area. */
function stateOf(marks) {
  const total = AREAS.reduce((sum, area) => sum + Math.min(2, marks[area].length), 0);
  return { weekId: W46, marks, total, full: total === 10 };
}

/**
 * Play out the week's one card a day: pick a chunk for the day's area with the
 * weights the week so far asks for, then mark every area the pick trains.
 */
function playWeek(library) {
  const days = weekDays(W46);
  const plan = weekPlan(W46, 1);
  const marks = {};
  for (const area of AREAS) marks[area] = [];
  const byId = new Map(library.map((e) => [e.id, e]));

  for (let d = 0; d < 7; d += 1) {
    const day = days[d];
    const area = oneCardArea(plan, d);
    const picked = pickChunk({
      day, slot: "midday", area, weights: areaWeights(stateOf(marks)),
      prefs: {}, library, swap: 0,
    });
    assert.ok(picked, "a chunk is offered for " + area + " on " + day);
    const entry = byId.get(picked.entryId);
    assert.ok(entry, "the pick is in the fixture library: " + picked.entryId);
    for (const trained of entry.areas) {
      if (!marks[trained] || marks[trained].includes(day)) continue;
      marks[trained].push(day);
      marks[trained].sort();
    }
  }
  return { days, marks };
}

test("a week of two-area chunks marks every balancing area on two days", () => {
  const pairs = [
    ["mobility", "core"],
    ["mobility", "upper"],
    ["mobility", "lower"],
    ["core", "upper"],
    ["core", "lower"],
    ["upper", "lower"],
  ];
  const library = pairs.map(([a, b]) => chunk({
    id: "pair-" + a + "-" + b,
    title: "A " + a + " and " + b + " routine",
    areas: [a, b],
  }));
  library.push(chunk({
    id: "whole-body-flow",
    kind: "flow",
    activity: "yoga",
    title: "A whole-body flow",
    areas: [...BALANCE_AREAS],
  }));

  const { days, marks } = playWeek(library);
  assert.equal(days.length, 7);
  for (const area of BALANCE_AREAS) {
    assert.ok(marks[area].length >= 2,
      area + " is marked on " + marks[area].length + " day(s): " + marks[area].join(", "));
    for (const day of marks[area]) assert.ok(days.includes(day), "the mark is in this week: " + day);
  }
});

test("a week of single-area chunks leaves a balancing area short", () => {
  const library = BALANCE_AREAS.map((area) => chunk({
    id: "only-" + area,
    title: "A " + area + " routine",
    areas: [area],
  }));

  const { marks } = playWeek(library);
  const short = BALANCE_AREAS.filter((area) => marks[area].length < 2);
  assert.ok(short.length > 0, "at least one balancing area stays under two days: " + short.join(", "));
});