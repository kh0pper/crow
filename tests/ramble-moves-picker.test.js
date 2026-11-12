/**
 * Moves design Task 3 — the challenge picker. Entries here are minimal
 * picker-shaped objects built in-test (they need not pass validateEntry);
 * the shipped library stays EMPTY until Task 10, so nothing here may depend
 * on its contents. The picker is pure, so "randomness" is asserted over
 * many seeded days instead of repeated runs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { slotFor, pickChallenge, pickChunk } from "../bundles/ramble/server/moves/picker.js";

/** A minimal picker-shaped entry; each test overrides exactly what it is about. */
function entry(over = {}) {
  return {
    id: "ex-1",
    kind: "routine",
    activity: "bodyweight",
    level: 2,
    minutes: 10,
    indoor: true,
    equipment: ["none"],
    areas: ["core"],
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
    library: [YOGA_FLOW, WALK, BAND, SQUAT, PUSHUP],
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
  const lib = [SQUAT, WRISTY, PUSHUP, BAND, YOGA_FLOW];
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
  const lib = [YOGA_FLOW, PUSHUP, BAND];
  const prefs = { ...BASE_PREFS, kinds: ["yoga", "bodyweight", "band"] }; // all three stay candidates
  let yogaPick = null;
  const counts = {};
  for (const day of days(60)) {
    const r = pick({ day, hourLocal: 6, library: lib, prefs });
    assert.ok(r.reasons.includes("slot:early"), r.reasons.join(","));
    counts[r.entryId] = (counts[r.entryId] ?? 0) + 1;
    if (r.entryId === "yoga-flow" && !yogaPick) yogaPick = r;
  }
  assert.ok(yogaPick, "yoga (slot-preferred, weight x3) should win at least once in 60 days");
  assert.ok(counts["yoga-flow"] > (counts["pushup-1"] ?? 0), "the slot-preferred entry should win most days");
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
  const lib = [WALK, YOGA_FLOW, BAND];
  const dayCounts = countsOf(days(60).map((d) => pick({ day: d, hourLocal: 12, library: lib }).entryId));
  assert.ok(dayCounts["walk-1"] > (dayCounts["yoga-flow"] ?? 0), "noon should prefer the walk");

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
  const lib = [YOGA_FLOW, WALK, JOG, BAND, SQUAT, PUSHUP];
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
  const lib = [YOGA_FLOW, PUSHUP, BAND];
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

/* ------------------------------------------------------------------ *
 * pickChunk: the slot-and-area pick behind a day's chunk (moves Task 4).
 * ------------------------------------------------------------------ */

/** A chunk that tags the given areas; kind flow so the learning rule can bite. */
function chunk(id, areas, over = {}) {
  return entry({ id, kind: "flow", activity: "yoga", areas, ...over });
}

/** pickChunk with test defaults; every test overrides only what it is about. */
function pickC(over = {}) {
  return pickChunk({
    day: "2026-09-14",
    slot: "midday",
    area: "free",
    weights: {},
    weather: null,
    prefs: BASE_PREFS,
    history: {},
    library: [chunk("core-1", ["core"])],
    swap: 0,
    ...over,
  });
}

test("pickChunk: pure and deterministic, and different seeds vary the pick", () => {
  const library = [chunk("c-a", ["core"]), chunk("c-b", ["core"]), chunk("c-c", ["core"])];
  for (const day of days(40)) {
    for (const swap of [0, 1, 2]) {
      for (const slot of ["morning", "midday", "evening"]) {
        assert.deepEqual(
          pickC({ day, swap, slot, area: "core", library }),
          pickC({ day, swap, slot, area: "core", library }),
        );
      }
    }
  }
  const seen = new Set(days(40).map((day) => pickC({ day, area: "core", library }).entryId));
  assert.equal(seen.size, 3, "over 40 seeds every candidate gets its turn: " + [...seen].join(","));
});

test("pickChunk: the library's order never matters", () => {
  const library = [
    chunk("o-1", ["core"]),
    chunk("o-2", ["core", "upper"]),
    chunk("o-3", ["mobility"]),
    chunk("o-4", ["upper"]),
  ];
  const backwards = [...library].reverse();
  for (const day of days(50)) {
    for (const area of ["core", "upper", "heart", "free"]) {
      const opts = { day, area, weights: { upper: 3 }, swap: day.length % 3 };
      assert.deepEqual(pickC({ ...opts, library }), pickC({ ...opts, library: backwards }), day + " " + area);
    }
  }
});

test("pickChunk: poses and short exercises are never picked", () => {
  const pose = entry({ id: "pose-1", kind: "pose", minutes: 1, areas: ["mobility"] });
  const short = entry({ id: "short-1", kind: "exercise", minutes: 5, areas: ["upper"] });
  const flow = chunk("flow-1", ["mobility"]);
  for (const day of days(30)) {
    for (const area of ["mobility", "upper", "free"]) {
      assert.equal(pickC({ day, area, library: [pose, short] }), null, "nothing short of a chunk is a chunk");
      assert.equal(pickC({ day, area, library: [pose, short, flow] }).entryId, "flow-1");
    }
  }
});

test("pickChunk: area lower only ever returns a chunk that tags lower", () => {
  const library = [chunk("lower-1", ["lower"]), chunk("core-1", ["core"]), chunk("mixed-1", ["core", "lower"])];
  const tagsLower = new Set(["lower-1", "mixed-1"]);
  for (const day of days(60)) {
    for (const swap of [0, 1]) {
      const r = pickC({ day, swap, area: "lower", library });
      assert.ok(tagsLower.has(r.entryId), "picked " + r.entryId + " for lower");
      assert.equal(r.area, "lower");
    }
  }
});

test("pickChunk: an area with no chunk falls back to mobility, then core, then null", () => {
  const mobility = chunk("mob-1", ["mobility"]);
  const core = chunk("core-1", ["core"]);
  const upper = chunk("upper-1", ["upper"]);
  const lower = chunk("lower-1", ["lower"]);
  for (const day of days(20)) {
    const viaMobility = pickC({ day, area: "upper", library: [mobility, core] });
    assert.equal(viaMobility.entryId, "mob-1");
    assert.equal(viaMobility.area, "mobility", "the area says which one was used");

    const viaCore = pickC({ day, area: "upper", library: [core] });
    assert.equal(viaCore.entryId, "core-1");
    assert.equal(viaCore.area, "core");

    // A real upper chunk is preferred over any fallback.
    assert.equal(pickC({ day, area: "upper", library: [mobility, core, upper] }).area, "upper");

    // Nothing in the area, mobility or core: nothing at all.
    assert.equal(pickC({ day, area: "heart", library: [upper, lower] }), null);
  }
});

test("pickChunk: a chunk that also trains a x3 area wins over area-only chunks", () => {
  const library = [chunk("core-a", ["core"]), chunk("core-b", ["core"]), chunk("core-upper", ["core", "upper"])];
  for (const day of days(120)) {
    for (const swap of [0, 1, 2]) {
      const r = pickC({ day, swap, area: "core", weights: { upper: 3 }, library });
      assert.equal(r.entryId, "core-upper", day + " swap " + swap);
      assert.equal(r.area, "core");
    }
  }
});

test("pickChunk: the free area follows the weights", () => {
  const upper = chunk("upper-1", ["upper"]);
  const core = chunk("core-1", ["core"]);
  const weights = { upper: 3, core: 0.5 };
  const picks = days(60).map((day) => pickC({ day, area: "free", weights, library: [upper, core] }));
  for (const r of picks) assert.equal(r.area, "free");
  const counts = countsOf(picks.map((r) => r.entryId));
  assert.equal((counts["upper-1"] ?? 0) + (counts["core-1"] ?? 0), 60);
  assert.ok((counts["core-1"] ?? 0) > 0, "a lighter weight still gets picked: " + JSON.stringify(counts));
  assert.ok(
    (counts["upper-1"] ?? 0) >= 4 * (counts["core-1"] ?? 0),
    "weight 3 vs 0.5 should show over 60 days: " + JSON.stringify(counts),
  );
});

test("pickChunk: exclude removes ids", () => {
  const library = [chunk("x-1", ["core"]), chunk("x-2", ["core"])];
  for (const day of days(40)) {
    assert.equal(pickC({ day, area: "core", library, exclude: ["x-1"] }).entryId, "x-2");
    assert.equal(pickC({ day, area: "free", library, exclude: ["x-2"] }).entryId, "x-1");
  }
  assert.equal(pickC({ area: "core", library, exclude: ["x-1", "x-2"] }), null);
  assert.equal(pickC({ area: "core", library, exclude: ["x-1", "x-2", "junk", 7, ""] }), null);
});

test("pickChunk: a stated limit removes entries whose skipIf carries that tag", () => {
  const knee = chunk("knee-1", ["core"], { skipIf: ["knee"] });
  const clear = chunk("clear-1", ["core"]);
  const prefs = { ...BASE_PREFS, limits: ["knee"] };
  for (const day of days(40)) {
    assert.equal(pickC({ day, area: "core", prefs, library: [knee, clear] }).entryId, "clear-1");
    assert.equal(pickC({ day, area: "free", prefs, library: [knee, clear] }).entryId, "clear-1");
  }
  assert.equal(pickC({ area: "core", prefs, library: [knee] }), null);
});

test("pickChunk: rain keeps only indoor chunks", () => {
  const outdoor = chunk("out-1", ["heart"], { indoor: false });
  const indoor = chunk("in-1", ["heart"], { indoor: true });
  const weather = { rain: 80, temp: 18, code: "rain" };
  for (const day of days(40)) {
    const r = pickC({ day, area: "heart", weather, library: [outdoor, indoor] });
    assert.equal(r.entryId, "in-1");
    assert.ok(r.reasons.includes("rain_later"), r.reasons.join(","));
    assert.equal(pickC({ day, area: "free", weather, library: [outdoor, indoor] }).entryId, "in-1");
  }
  assert.equal(pickC({ area: "heart", weather, library: [outdoor] }), null);
});

test("pickChunk: reasons carry the slot code and the same fact codes as pickChallenge", () => {
  const library = [chunk("core-1", ["core"])];
  const codes = { morning: "slot:early", midday: "slot:day", evening: "slot:evening" };
  for (const [slot, code] of Object.entries(codes)) {
    assert.equal(pickC({ slot, area: "core", library }).reasons[0], code);
  }
  const learned = chunk("learn-flow", ["core"], { level: 1 });
  const r = pickC({
    area: "core",
    library: [learned],
    prefs: { ...BASE_PREFS, kinds: ["yoga"] },
    history: { done: {}, skipped: {}, learning: ["learn-flow"] },
  });
  assert.deepEqual(r.reasons, ["slot:day", "liked:yoga", "learning_flow", "easy_day"]);
});

test("pickChunk: an unknown slot or area is null, not a throw", () => {
  const library = [chunk("core-1", ["core"])];
  for (const slot of ["", "noon", "MORNING", null, undefined, 7]) {
    assert.equal(pickC({ slot, area: "core", library }), null, "slot " + String(slot));
  }
  for (const area of ["", "legs", "Free", null, undefined]) {
    assert.equal(pickC({ area, library }), null, "area " + String(area));
  }
  assert.deepEqual(pickC(), { entryId: "core-1", area: "free", reasons: ["slot:day"] });
});
