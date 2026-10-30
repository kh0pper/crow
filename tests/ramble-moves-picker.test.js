/**
 * Moves design Task 3 — the challenge picker. Entries here are minimal
 * picker-shaped objects built in-test (they need not pass validateEntry);
 * the shipped library stays EMPTY until Task 10, so nothing here may depend
 * on its contents. The picker is pure, so "randomness" is asserted over
 * many seeded days instead of repeated runs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { slotFor, pickChallenge } from "../bundles/ramble/server/moves/picker.js";

/** A minimal picker-shaped entry; each test overrides exactly what it is about. */
function entry(over = {}) {
  return {
    id: "ex-1",
    kind: "exercise",
    activity: "bodyweight",
    level: 2,
    indoor: true,
    equipment: ["none"],
    skipIf: [],
    reviewed: true,
    ...over,
  };
}

const BASE_PREFS = {
  on: true,
  kinds: [],
  equipment: ["mat", "band", "chair", "wall"],
  limits: [],
  level: 3,
  weather: true,
};

const YOGA_POSE = entry({ id: "yoga-pose", kind: "pose", activity: "yoga", level: 1 });
const YOGA_FLOW = entry({ id: "yoga-flow", kind: "flow", activity: "yoga", level: 1 });
const WALK = entry({ id: "walk-1", kind: "walk", activity: "walk", level: 1, indoor: false });
const JOG = entry({ id: "jog-1", activity: "jog", level: 2, indoor: false });
const BAND = entry({ id: "band-1", activity: "band", equipment: ["band"] });
const SQUAT = entry({ id: "squat-1", skipIf: ["knee"] });
const WRISTY = entry({ id: "wristy-1", skipIf: ["knee", "wrist"] });
const PUSHUP = entry({ id: "pushup-1" });

/** pickChallenge with test defaults; every test overrides only what it is about. */
function pick(over = {}) {
  return pickChallenge({
    day: "2026-09-14",
    hourLocal: 12,
    weather: null,
    prefs: BASE_PREFS,
    history: {},
    library: [YOGA_POSE, WALK, BAND, SQUAT, PUSHUP],
    swap: 0,
    ...over,
  });
}

/** `day` is an opaque seed string; the picker never looks at a clock. */
const days = (n) => Array.from({ length: n }, (_, i) => "day-" + i);
const byId = (lib) => Object.fromEntries(lib.map((e) => [e.id, e]));
const countsOf = (ids) => ids.reduce((m, id) => ((m[id] = (m[id] ?? 0) + 1), m), {});

test("slotFor: early before 9, evening from 17, day otherwise", () => {
  assert.equal(slotFor(0), "early");
  assert.equal(slotFor(6), "early");
  assert.equal(slotFor(8), "early");
  assert.equal(slotFor(8.9), "early");
  assert.equal(slotFor(9), "day");
  assert.equal(slotFor(12), "day");
  assert.equal(slotFor(16.5), "day");
  assert.equal(slotFor(17), "evening");
  assert.equal(slotFor(23), "evening");
});

test("pure: the same input gives the same output, across many days", () => {
  for (const day of days(50)) {
    assert.deepEqual(pick({ day }), pick({ day }));
    assert.deepEqual(pick({ day, swap: 2 }), pick({ day, swap: 2 }));
  }
});

test("swap re-rolls the day when more than one candidate exists", () => {
  const lib = [BAND, PUSHUP]; // equal weight at noon: neither is slot-preferred
  const zero = days(200).map((day) => pick({ day, library: lib }).entryId);
  const one = days(200).map((day) => pick({ day, library: lib, swap: 1 }).entryId);
  assert.ok(zero.some((id, i) => id !== one[i]), "swap 1 must differ from swap 0 on some day");
  assert.deepEqual(
    new Set([...zero, ...one]),
    new Set(["band-1", "pushup-1"]),
    "across seeds and swaps, both candidates get picked",
  );
});

test("a stated limit always wins: knee never returns a skipIf:knee entry", () => {
  const lib = [SQUAT, WRISTY, PUSHUP, BAND, YOGA_POSE];
  const prefs = { ...BASE_PREFS, limits: ["knee"] };
  for (const day of days(500)) {
    for (const swap of [0, 1, 2]) {
      const r = pick({ day, swap, library: lib, prefs });
      assert.ok(r);
      assert.notEqual(r.entryId, "squat-1", "skipIf:knee must never be picked under a knee limit");
      assert.notEqual(r.entryId, "wristy-1", "skipIf is a set: any shared tag excludes");
    }
  }
  // A different limit only excludes entries carrying that tag.
  const wristPrefs = { ...BASE_PREFS, limits: ["wrist"] };
  assert.ok(days(50).some((day) => pick({ day, library: lib, prefs: wristPrefs }).entryId === "squat-1"));
});

test("rain >= 60 never returns an outdoor entry, and reasons say rain_later", () => {
  const lib = [WALK, JOG, PUSHUP, BAND];
  const lookup = byId(lib);
  for (const day of days(100)) {
    for (const swap of [0, 1]) {
      const r = pick({ day, swap, library: lib, weather: { rain: 80, temp: 18, code: "rain" } });
      assert.equal(lookup[r.entryId].indoor, true, "rain: picked an outdoor entry " + r.entryId);
      assert.ok(r.reasons.includes("rain_later"), r.reasons.join(","));
    }
  }
});

test("temp below 2C or above 34C never returns an outdoor entry (cold/hot)", () => {
  const lib = [WALK, JOG, PUSHUP];
  const lookup = byId(lib);
  for (const day of days(50)) {
    const coldR = pick({ day, library: lib, weather: { rain: 0, temp: 1, code: "snow" } });
    assert.equal(lookup[coldR.entryId].indoor, true, "cold: picked outdoor " + coldR.entryId);
    assert.ok(coldR.reasons.includes("cold"));
    const hotR = pick({ day, library: lib, weather: { rain: 0, temp: 35, code: "sun" } });
    assert.equal(lookup[hotR.entryId].indoor, true, "hot: picked outdoor " + hotR.entryId);
    assert.ok(hotR.reasons.includes("hot"));
  }
  // 2C and 34C themselves are fine outdoors; only rain >= 60 is the cutoff.
  assert.ok(days(30).some((day) => pick({ day, library: [WALK], weather: { rain: 59, temp: 2, code: "cloud" } }).entryId === "walk-1"));
  assert.ok(days(30).some((day) => pick({ day, library: [WALK], weather: { rain: 0, temp: 34, code: "sun" } }).entryId === "walk-1"));
});

test("weather is ignored when prefs.weather is false", () => {
  const prefs = { ...BASE_PREFS, weather: false };
  const r = pick({ library: [WALK, JOG], prefs, weather: { rain: 95, temp: -5, code: "snow" } });
  assert.ok(r, "outdoor entries stay pickable with weather off");
  assert.ok(!r.reasons.some((x) => ["rain_later", "cold", "hot"].includes(x)));
  // The same input with weather on has nothing left.
  assert.equal(pick({ library: [WALK, JOG], weather: { rain: 95, temp: -5, code: "snow" } }), null);
});

test("early slot with yoga liked picks yoga; reasons carry slot:early, liked:yoga, easy_day", () => {
  const lib = [YOGA_POSE, PUSHUP, BAND];
  const prefs = { ...BASE_PREFS, kinds: ["yoga", "bodyweight", "band"] }; // all three stay candidates
  let yogaPick = null;
  const counts = {};
  for (const day of days(60)) {
    const r = pick({ day, hourLocal: 6, library: lib, prefs });
    assert.ok(r.reasons.includes("slot:early"), r.reasons.join(","));
    counts[r.entryId] = (counts[r.entryId] ?? 0) + 1;
    if (r.entryId === "yoga-pose" && !yogaPick) yogaPick = r;
  }
  assert.ok(yogaPick, "yoga (slot-preferred, weight x3) should win at least once in 60 days");
  assert.ok(counts["yoga-pose"] > (counts["pushup-1"] ?? 0), "the slot-preferred entry should win most days");
  assert.ok(yogaPick.reasons.includes("liked:yoga"), yogaPick.reasons.join(","));
  assert.ok(yogaPick.reasons.includes("easy_day"), "a level-1 pick is an easy day");
});

test("slot preference is a weight, not a filter: a day with nothing preferred still picks", () => {
  const lib = [PUSHUP, BAND]; // neither is preferred at noon
  for (const day of days(30)) {
    const r = pick({ day, hourLocal: 12, library: lib });
    assert.ok(r);
    assert.ok(r.reasons.includes("slot:day"));
  }
});

test("day slot prefers walk/jog; evening prefers band/bodyweight or a gentle flow", () => {
  const lib = [WALK, YOGA_POSE, BAND];
  const dayCounts = countsOf(days(60).map((d) => pick({ day: d, hourLocal: 12, library: lib }).entryId));
  assert.ok(dayCounts["walk-1"] > (dayCounts["yoga-pose"] ?? 0), "noon should prefer the walk");

  const evCounts = countsOf(days(60).map((d) => pick({ day: d, hourLocal: 18, library: lib }).entryId));
  assert.ok(evCounts["band-1"] > (evCounts["walk-1"] ?? 0), "evening should prefer the band entry");

  // A gentle flow = a yoga flow with level 1; a level-3 flow is not gentle.
  const gentle = YOGA_FLOW;
  const hard = entry({ id: "hard-flow", kind: "flow", activity: "yoga", level: 3 });
  const flowCounts = countsOf(days(60).map((d) => pick({ day: d, hourLocal: 20, library: [gentle, WALK] }).entryId));
  assert.ok(flowCounts["yoga-flow"] > (flowCounts["walk-1"] ?? 0), "evening should prefer the gentle flow");
  const hardCounts = countsOf(days(60).map((d) => pick({ day: d, hourLocal: 20, library: [hard, WALK] }).entryId));
  assert.ok(
    Math.abs((hardCounts["hard-flow"] ?? 0) - (hardCounts["walk-1"] ?? 0)) < 30,
    "a level-3 flow gets no evening boost: both stay near even odds",
  );
});

test("a flow in history.learning gets weight x3 and reasons learning_flow", () => {
  const lib = [YOGA_FLOW, PUSHUP, BAND];
  const history = { done: {}, skipped: {}, learning: ["yoga-flow"] };
  let flowPick = null;
  const counts = {};
  for (const day of days(60)) {
    const r = pick({ day, hourLocal: 12, library: lib, history });
    counts[r.entryId] = (counts[r.entryId] ?? 0) + 1;
    if (r.entryId === "yoga-flow" && !flowPick) flowPick = r;
  }
  assert.ok(flowPick, "the learned flow should win at least once in 60 days");
  assert.ok(flowPick.reasons.includes("learning_flow"), flowPick.reasons.join(","));
  assert.ok(counts["yoga-flow"] > (counts["pushup-1"] ?? 0));
});

test("an entry skipped 3 or more times gets weight x0.3 and rarely comes back", () => {
  const lib = [PUSHUP, BAND];
  const history = { done: {}, skipped: { "band-1": 3 }, learning: [] };
  const counts = countsOf(days(200).map((d) => pick({ day: d, hourLocal: 12, library: lib, history }).entryId));
  assert.ok(
    (counts["pushup-1"] ?? 0) > (counts["band-1"] ?? 0) * 2,
    "weight 1 vs 0.3 should be visible over 200 days: " + JSON.stringify(counts),
  );
  // Skipped twice is NOT yet demoted.
  const twice = { done: {}, skipped: { "band-1": 2 }, learning: [] };
  const even = countsOf(days(200).map((d) => pick({ day: d, hourLocal: 12, library: lib, history: twice }).entryId));
  assert.ok(
    Math.abs((even["pushup-1"] ?? 0) - (even["band-1"] ?? 0)) < 60,
    "below 3 skips both stay near even odds: " + JSON.stringify(even),
  );
});

test("filters: unreviewed, equipment, kinds, level — and null when nothing survives", () => {
  const draft = entry({ id: "draft-1", reviewed: false });
  assert.equal(pick({ library: [draft] }), null, "unreviewed entries are never served");

  // Equipment the user lacks: allowed only when every item is "none" or owned.
  const needsBand = entry({ id: "band-only", activity: "band", equipment: ["band"] });
  const poorPrefs = { ...BASE_PREFS, equipment: [] };
  for (const day of days(50)) {
    assert.equal(pick({ day, library: [needsBand, draft], prefs: poorPrefs }), null);
  }
  assert.ok(days(20).some((day) => pick({ day, library: [needsBand] })?.entryId === "band-only"),
    "with a band in prefs the entry is pickable");

  // kinds, when non-empty, restricts the activities.
  for (const day of days(50)) {
    assert.equal(pick({ day, library: [WALK, PUSHUP], prefs: { ...BASE_PREFS, kinds: ["walk"] } }).entryId, "walk-1");
  }

  // level > prefs.level is out.
  const hard = entry({ id: "hard-1", level: 3 });
  assert.equal(pick({ library: [hard], prefs: { ...BASE_PREFS, level: 1 } }), null);
  assert.equal(pick({ library: [hard], prefs: { ...BASE_PREFS, level: 2 } }), null);
  assert.equal(pick({ library: [hard], prefs: { ...BASE_PREFS, level: 3 } }).entryId, "hard-1");

  // Nothing survives.
  assert.equal(pick({ library: [] }), null);
  assert.equal(pick({ library: [WALK, JOG], weather: { rain: 100, temp: 20, code: "rain" } }), null);
  assert.equal(pick({ library: [SQUAT], prefs: { ...BASE_PREFS, limits: ["knee"] } }), null);
});

test("reasons are fact codes, never prose", () => {
  const lib = [YOGA_POSE, YOGA_FLOW, WALK, JOG, BAND, SQUAT, PUSHUP];
  const shape = /^(slot:early|slot:day|slot:evening|rain_later|cold|hot|liked:[a-z_]+|learning_flow|easy_day)$/;
  for (const day of days(100)) {
    const hourLocal = Number(day.slice(4)) % 24;
    const r = pick({
      day,
      hourLocal,
      library: lib,
      weather: day.endsWith("3") ? { rain: 70, temp: 20, code: "rain" } : null,
      prefs: { ...BASE_PREFS, kinds: ["yoga"] },
      history: { done: {}, skipped: {}, learning: ["yoga-flow"] },
    });
    assert.ok(r);
    assert.equal(r.reasons[0], "slot:" + slotFor(hourLocal));
    for (const reason of r.reasons) assert.match(reason, shape, reason);
  }
});

test("no weather reason without the weather rule applying", () => {
  const lib = [YOGA_POSE, PUSHUP, BAND];
  for (const weather of [null, { rain: 10, temp: 20, code: 1 }, { rain: 59, temp: 2, code: 1 }, { rain: 0, temp: 34, code: 0 }]) {
    for (const day of days(30)) {
      const r = pick({ day, library: lib, weather });
      assert.ok(!r.reasons.some((x) => x === "rain_later" || x === "cold" || x === "hot"), JSON.stringify(weather) + " " + r.reasons.join(","));
    }
  }
});

test("an entry with no level is never picked; junk kinds are ignored, not a filter-everything", () => {
  const { level, ...noLevel } = PUSHUP;
  assert.equal(pick({ day: "2026-11-02", library: [noLevel] }), null);
  assert.ok(pick({ day: "2026-11-02", library: [PUSHUP], prefs: { ...BASE_PREFS, kinds: ["not-a-kind"] } }));
});
