/**
 * Moves session engine Task 2.1 — compiling a chain of chunks into a timeline
 * (private engineering notes §5.2).
 *
 * The library here is built in-test from small fixtures; nothing here reads
 * the shipped moves library.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const SESSION_PATH = join(
  dirname(fileURLToPath(import.meta.url)), "..",
  "bundles", "ramble", "server", "moves", "session.cjs",
);
const Session = require(SESSION_PATH);
const {
  SessionError, SESSION_MAX_SECONDS, REST_HINT_SECONDS, TRANSITION_SECONDS,
  SWITCH_SECONDS, CHUNK_BREAK_SECONDS, DEFAULT_FLOW_ROUNDS, MIN_STAGE_SECONDS,
  compileSession, compileTimeline, chunksOf,
  createClock, extend, isChunkDone, canExtend,
} = Session;

const ROUTES_PATH = join(
  dirname(fileURLToPath(import.meta.url)), "..",
  "bundles", "ramble", "panel", "routes.js",
);

/* ---------- fixture library ---------- */

const POSE_IDS = ["pose-a", "pose-b", "pose-c", "pose-d", "pose-e", "pose-f"];

function poseEntry(id, over = {}) {
  const index = POSE_IDS.indexOf(id);
  return {
    id,
    kind: "pose",
    minutes: 1,
    pose: { rootAngle: index < 0 ? 60 : index * 5 },
    steps: [{ text: id + " text", cue: id + " cue", say: id + " say" }],
    anatomy: [{ main: "quad" }],
    ...over,
  };
}

function exerciseEntry(id, over = {}) {
  return {
    id,
    kind: "exercise",
    minutes: 1,
    steps: [{ text: id + " text", cue: id + " cue", say: id + " say" }],
    anatomy: [{ main: "glute" }],
    ...over,
  };
}

/** Warm-up 2 x 60s, main 3 x (60s + 10s rest), cool-down 2 x 60s = 660s at 2 rounds. */
function routineBlocks(over = {}) {
  return {
    warmup: [
      { id: "pose-a", seconds: 60 },
      { id: "pose-b", seconds: 60 },
    ],
    main: [
      { id: "pose-c", seconds: 60, restSeconds: 10 },
      { id: "ex-reps", seconds: 60, restSeconds: 10 },
      { id: "pose-a", seconds: 60, restSeconds: 10 },
    ],
    cooldown: [
      { id: "pose-d", seconds: 60 },
      { id: "pose-e", seconds: 60 },
    ],
    ...over,
  };
}

function routineEntry(id, over = {}) {
  return {
    id,
    kind: "routine",
    minutes: 11,
    rounds: 2,
    steps: [{ text: "blocks in order", cue: "blocks", say: "work through the blocks" }],
    blocks: routineBlocks(),
    ...over,
  };
}

const SIDE_BLOCKS = routineBlocks({
  warmup: [
    { id: "pose-side", seconds: 45 },
    { id: "pose-b", seconds: 60 },
  ],
});

const LIB = [
  ...POSE_IDS.map((id) => poseEntry(id)),
  poseEntry("pose-side", { perSide: true }),
  exerciseEntry("ex-reps", { reps: 10, poses: [{ rootAngle: 1 }, { rootAngle: 2 }] }),
  exerciseEntry("ex-timed", { poses: [{ rootAngle: 3 }, { rootAngle: 4 }] }),
  routineEntry("routine-a"),
  routineEntry("routine-b"),
  routineEntry("routine-c"),
  routineEntry("routine-side", { blocks: SIDE_BLOCKS }),
  routineEntry("routine-stage", { stages: [{ rounds: 1 }, { reps: 4 }] }),
  routineEntry("routine-hard-a", { level: 3, areas: ["knees", "ankles"] }),
  routineEntry("routine-hard-b", { level: 3, areas: ["knees"] }),
  routineEntry("routine-hard-c", { level: 3, areas: ["shoulders"] }),
  routineEntry("routine-easy", { level: 2, areas: ["knees"] }),
  routineEntry("routine-missing-step", {
    blocks: routineBlocks({ main: [{ id: "pose-nope", seconds: 60 }] }),
  }),
  routineEntry("routine-timed", {
    blocks: routineBlocks({ main: [{ id: "ex-timed", seconds: 60 }] }),
  }),
  {
    id: "flow-a",
    kind: "flow",
    minutes: 10,
    steps: [{ text: "flow text", cue: "flow cue", say: "flow say" }],
    flow: [
      { id: "pose-a", holdSeconds: 40 },
      { id: "pose-b", holdSeconds: 40 },
      { id: "pose-c", holdSeconds: 40 },
      { id: "pose-d", holdSeconds: 40 },
    ],
  },
  {
    id: "flow-short",
    kind: "flow",
    minutes: 5,
    steps: ["short flow"],
    flow: [{ id: "pose-a", holdSeconds: 60 }],
  },
  {
    id: "flow-opener",
    kind: "flow",
    block: "warmup",
    minutes: 12,
    steps: ["opener"],
    flow: [{ id: "pose-a", holdSeconds: 60 }, { id: "pose-b", holdSeconds: 60 }],
  },
  { id: "walk-a", kind: "walk", minutes: 20, steps: [{ text: "walk text", cue: "walk", say: "walk on" }] },
  { id: "landmark-a", kind: "landmark", minutes: 12, landmark: "park", reachMeters: 100, steps: ["landmark"] },
];

const LIB_BY_ID = new Map(LIB.map((entry) => [entry.id, entry]));

const CHAIN3 = [
  { chunkId: "routine-a" },
  { chunkId: "routine-b" },
  { chunkId: "routine-c" },
];

/* ---------- helpers over a compiled timeline ---------- */

const activeSegments = (timeline) => timeline.segments.filter((s) => s.active);
const blocksOf = (timeline) => activeSegments(timeline).map((s) => s.block);
const typesOf = (timeline) => timeline.segments.map((s) => s.type);
const deep = (value) => JSON.parse(JSON.stringify(value));

/** A segment with the block it belongs to left out. */
const withoutBlock = (segment) => {
  const copy = { ...segment };
  delete copy.block;
  return copy;
};

/** Where a recompiled timeline parts company with an old one, block aside. */
function firstChangedIgnoringBlock(fresh, old) {
  const common = Math.min(fresh.length, old.length);
  for (let i = 0; i < common; i += 1) {
    if (JSON.stringify(withoutBlock(fresh[i])) !== JSON.stringify(withoutBlock(old[i]))) return i;
  }
  return old.length;
}

/* ---------- tests ---------- */

test("the same input compiles to a deep-equal timeline and leaves the library alone", () => {
  const libraryBefore = deep(LIB);
  const opts = { guidance: "full", stage: 0, perSideOrder: "left" };

  const first = compileSession(CHAIN3, LIB, opts);
  const second = compileSession(CHAIN3, LIB, opts);

  assert.deepEqual(first, second);
  assert.deepEqual(LIB, libraryBefore, "the entries are read, never written");
  assert.deepEqual(first.chain, [
    { chunkId: "routine-a", extraRounds: 0 },
    { chunkId: "routine-b", extraRounds: 0 },
    { chunkId: "routine-c", extraRounds: 0 },
  ]);
  assert.deepEqual(first.opts, { guidance: "full", stage: 0, perSideOrder: "left" });

  // A Map library compiles to the same timeline, and the one-chunk call agrees.
  assert.deepEqual(compileSession(CHAIN3, LIB_BY_ID, opts), first);
  assert.deepEqual(
    compileTimeline("routine-a", LIB, opts),
    compileSession([{ chunkId: "routine-a", extraRounds: 0 }], LIB, opts),
  );
});

test("a routine compiles to warm-up, then main times its rounds, then cool-down", () => {
  const timeline = compileTimeline("routine-a", LIB);

  assert.deepEqual(blocksOf(timeline), [
    "warmup", "warmup",
    "main", "main", "main", "main", "main", "main",
    "cooldown", "cooldown",
  ]);
  assert.equal(timeline.chunks.length, 1);
  assert.deepEqual(timeline.chunks[0], { chunkId: "routine-a", index: 0, plannedSeconds: 660 });
  assert.equal(timeline.totalSeconds, 660 + 9 * TRANSITION_SECONDS, "nine moves into nine steps");
  assert.equal(typesOf(timeline).filter((t) => t === "rest").length, 6);
  assert.equal(typesOf(timeline).filter((t) => t === "chunk-break").length, 0);
});

test("a chain of three has one warm-up, one cool-down and a break between chunks", () => {
  const timeline = compileSession(CHAIN3, LIB);

  const runs = [];
  for (const segment of activeSegments(timeline)) {
    if (runs[runs.length - 1] !== segment.block) runs.push(segment.block);
  }
  assert.deepEqual(runs, ["warmup", "main", "cooldown"]);

  assert.ok(timeline.segments.filter((s) => s.block === "warmup").every((s) => s.chunkIndex === 0));
  assert.ok(timeline.segments.filter((s) => s.block === "cooldown").every((s) => s.chunkIndex === 2));

  const breaks = timeline.segments.filter((s) => s.type === "chunk-break");
  assert.equal(breaks.length, 2);
  assert.deepEqual(breaks.map((s) => s.chunkIndex), [0, 1]);
  assert.ok(breaks.every((s) => s.seconds === CHUNK_BREAK_SECONDS && s.active === false));

  // Each break sits right before the next chunk's first step, which then has no
  // transition of its own in front of it.
  for (const index of [1, 2]) {
    const first = timeline.segments.findIndex((s) => s.chunkIndex === index);
    assert.equal(timeline.segments[first - 1].type, "chunk-break", "chunk " + index);
  }

  assert.deepEqual(timeline.chunks.map((c) => c.chunkId), ["routine-a", "routine-b", "routine-c"]);
  assert.deepEqual(
    timeline.chunks.map((c) => c.plannedSeconds),
    [540, 420, 540],
    "only the first chunk warms up and only the last one cools down",
  );
});

test("extraRounds adds one round of the main block and nothing else", () => {
  const base = compileTimeline("routine-a", LIB);
  const extra = compileSession([{ chunkId: "routine-a", extraRounds: 1 }], LIB);

  const mainOf = (timeline) => timeline.segments.filter((s) => s.block === "main");
  const baseMain = mainOf(base);
  const extraMain = mainOf(extra);

  assert.equal(extraMain.length - baseMain.length, 9, "3 steps with a transition and a rest each");
  assert.deepEqual(
    baseMain,
    [...extraMain.slice(0, 9), ...extraMain.slice(18)],
    "the rounds before and after the added one are unchanged",
  );
  assert.deepEqual(
    base.segments.filter((s) => s.block !== "main"),
    extra.segments.filter((s) => s.block !== "main"),
    "warm-up and cool-down are untouched",
  );
  assert.equal(extra.chunks[0].plannedSeconds, base.chunks[0].plannedSeconds + 210);
  assert.equal(extra.chain[0].extraRounds, 1);
  assert.deepEqual(extra.chain, [{ chunkId: "routine-a", extraRounds: 1 }]);
});

test("a perSide pose is held twice with a switch between, in either order", () => {
  const timeline = compileTimeline("routine-side", LIB);
  const sides = timeline.segments.filter((s) => s.side !== null);
  assert.deepEqual(sides.map((s) => s.side), ["left", "right"]);
  assert.deepEqual(sides.map((s) => s.seconds), [23, 22]);
  assert.equal(sides[0].seconds + sides[1].seconds, 45);
  assert.equal(sides[0].toPose, sides[1].toPose);
  assert.equal(sides[0].stepIndex, 0);

  const switchIndex = timeline.segments.indexOf(sides[0]) + 1;
  assert.equal(timeline.segments[switchIndex].type, "switch-sides");
  assert.equal(timeline.segments[switchIndex].seconds, SWITCH_SECONDS);
  assert.equal(timeline.segments[switchIndex].active, false);
  assert.equal(timeline.segments[switchIndex + 1].type, "hold");

  const flipped = compileTimeline("routine-side", LIB, { perSideOrder: "right" });
  const flippedSides = flipped.segments.filter((s) => s.side !== null);
  assert.deepEqual(flippedSides.map((s) => s.side), ["right", "left"]);
  assert.deepEqual(flippedSides.map((s) => s.seconds), [23, 22]);
});

test("a flow compiles as holds, its first round halved and marked warm-up", () => {
  assert.equal(DEFAULT_FLOW_ROUNDS, 2);
  const timeline = compileTimeline("flow-a", LIB);
  const holds = timeline.segments.filter((s) => s.type === "hold");

  assert.equal(holds.length, 8, "four poses over the default two rounds");
  assert.deepEqual(holds.map((s) => s.seconds), [20, 20, 20, 20, 40, 40, 40, 40]);
  assert.deepEqual(holds.map((s) => s.block), [
    "warmup", "warmup", "warmup", "warmup",
    "main", "main", "main", "cooldown",
  ]);
  assert.equal(timeline.chunks[0].plannedSeconds, 20 * 4 + 40 * 4);
  assert.deepEqual(holds.map((s) => s.entryId), [
    "pose-a", "pose-b", "pose-c", "pose-d",
    "pose-a", "pose-b", "pose-c", "pose-d",
  ]);

  // The same flow mid-chain keeps its holds whole and cools nothing down.
  const middle = compileSession([{ chunkId: "routine-a" }, { chunkId: "flow-a" }, { chunkId: "routine-b" }], LIB);
  const middleHolds = middle.segments.filter((s) => s.type === "hold" && s.chunkIndex === 1);
  assert.ok(middleHolds.every((s) => s.block === "main"));
  assert.ok(middleHolds.every((s) => s.seconds === 40));
});

test("memory guidance leaves say empty except at the two ends", () => {
  const full = compileSession(CHAIN3, LIB);
  const memory = compileSession(CHAIN3, LIB, { guidance: "memory" });
  const last = memory.segments.length - 1;

  assert.ok(full.segments.some((s) => s.say !== ""), "the library text is carried in full");
  assert.notEqual(memory.segments[0].say, "", "the opener speaks");
  assert.notEqual(memory.segments[last].say, "", "the closer speaks");
  memory.segments.forEach((segment, index) => {
    if (index === 0 || index === last) {
      assert.equal(segment.say, full.segments[index].say);
      return;
    }
    assert.equal(segment.say, "");
  });
  memory.segments.forEach((segment, index) => {
    assert.equal(segment.cue, full.segments[index].cue, "cue is never blanked by guidance");
  });

  // The other guidance values leave the text as compiled.
  assert.deepEqual(compileSession(CHAIN3, LIB, { guidance: "names" }).segments, full.segments);
  assert.deepEqual(compileSession(CHAIN3, LIB, { guidance: "first" }).segments, full.segments);
});

test("a stage changes reps or rounds and never sinks the chunk under 600s", () => {
  assert.equal(MIN_STAGE_SECONDS, 600);
  const plain = compileTimeline("routine-stage", LIB);
  assert.equal(plain.chunks[0].plannedSeconds, 660);
  assert.ok(plain.segments.filter((s) => s.type === "reps").every((s) => s.reps === 10));

  // Stage 0 asks for one round: 450s, so the floor lifts it back to two.
  const floored = compileTimeline("routine-stage", LIB, { stage: 0 });
  assert.ok(floored.chunks[0].plannedSeconds >= 600, "got " + floored.chunks[0].plannedSeconds);
  assert.ok(floored.chunks[0].plannedSeconds >= Math.min(MIN_STAGE_SECONDS, plain.chunks[0].plannedSeconds));
  assert.equal(
    floored.segments.filter((s) => s.active && s.block === "main").length,
    plain.segments.filter((s) => s.active && s.block === "main").length,
  );

  // Stage 1 asks for four reps in the main block.
  const staged = compileTimeline("routine-stage", LIB, { stage: 1 });
  const reps = staged.segments.filter((s) => s.type === "reps");
  assert.ok(reps.length > 0);
  assert.ok(reps.every((s) => s.reps === 4));
  assert.ok(reps.every((s) => s.block === "main"));
  assert.equal(staged.chunks[0].plannedSeconds, 660, "reps alone do not move the clock");

  // An index with no stage behind it changes nothing.
  assert.deepEqual(compileTimeline("routine-stage", LIB, { stage: 9 }).segments, plain.segments);
  assert.deepEqual(
    compileTimeline("routine-a", LIB, { stage: 0 }).segments,
    compileTimeline("routine-a", LIB).segments,
  );
  assert.deepEqual(
    compileTimeline("routine-stage", LIB, { perSideOrder: "left" }),
    compileTimeline("routine-stage", LIB),
  );
});

test("a bad chain, an unknown id and a short entry each raise a named error", () => {
  const fails = (fn, code) => assert.throws(fn, (err) => {
    assert.ok(err instanceof SessionError, "a SessionError");
    assert.ok(err instanceof Error, "still an Error");
    assert.equal(err.code, code);
    assert.equal(typeof err.message, "string");
    return true;
  });

  fails(() => compileTimeline("pose-nope", LIB), "unknown_chunk");
  fails(() => compileTimeline(undefined, LIB), "bad_chain");
  fails(() => compileSession([], LIB), "bad_chain");
  fails(() => compileSession("routine-a", LIB), "bad_chain");
  fails(() => compileSession([{ extraRounds: 1 }], LIB), "bad_chain");
  fails(() => compileSession([{ chunkId: "routine-a" }, { chunkId: "flow-nope" }], LIB), "unknown_chunk");

  // Not a card: too short, a shared block, a pose.
  fails(() => compileTimeline("flow-short", LIB), "not_a_chunk");
  fails(() => compileTimeline("flow-opener", LIB), "not_a_chunk");
  fails(() => compileTimeline("pose-a", LIB), "not_a_chunk");

  fails(() => compileTimeline("routine-missing-step", LIB), "unknown_step");
  assert.equal(SESSION_MAX_SECONDS, 3600);
  assert.equal(REST_HINT_SECONDS, 1800);
});

test("the module carries no ESM syntax and loads with require and in a vm window", () => {
  const source = readFileSync(SESSION_PATH, "utf8");
  assert.equal(/^[ \t]*(?:import|export)\b/m.test(source), false, "no import/export statement");

  assert.equal(typeof compileSession, "function", "loaded through createRequire");

  const sandbox = { window: {} };
  vm.runInNewContext(source, sandbox);
  const inWindow = sandbox.window.RambleSession;
  assert.equal(typeof inWindow, "object");
  assert.equal(typeof inWindow.compileSession, "function");
  assert.equal(typeof inWindow.chunksOf, "function");
  assert.equal(inWindow.SESSION_MAX_SECONDS, 3600);

  const outer = compileSession(CHAIN3, LIB);
  const inner = inWindow.compileSession(CHAIN3, LIB);
  assert.deepEqual(deep(inner), deep(outer), "the same compile either side of the boundary");
});

test("every segment has the whole shape and the counts agree with the segments", () => {
  const KEYS = [
    "type", "chunkIndex", "block", "entryId", "stepIndex", "seconds", "active",
    "fromPose", "toPose", "reps", "side", "cue", "say", "anatomyStep",
  ].sort();
  const COUNTED = new Set(["hold", "reps", "timed", "rest"]);
  const timeline = compileSession(CHAIN3, LIB);

  for (const segment of timeline.segments) {
    assert.deepEqual(Object.keys(segment).sort(), KEYS, segment.type);
    assert.equal(segment.active, ["hold", "reps", "timed"].includes(segment.type), segment.type);
    assert.ok(["warmup", "main", "cooldown"].includes(segment.block), segment.type);
    assert.equal(typeof segment.seconds, "number");
    assert.ok(segment.seconds >= 0);
    assert.ok([null, "left", "right"].includes(segment.side));
    assert.ok(segment.reps === null || typeof segment.reps === "number");
    if (COUNTED.has(segment.type)) {
      assert.ok(Number.isInteger(segment.chunkIndex));
    } else {
      assert.equal(segment.stepIndex, null, segment.type);
      assert.equal(segment.cue, "");
      assert.equal(segment.say, "");
      assert.equal(segment.anatomyStep, null);
    }
  }

  timeline.chunks.forEach((chunk, index) => {
    const sum = timeline.segments
      .filter((s) => s.chunkIndex === index && COUNTED.has(s.type))
      .reduce((total, s) => total + s.seconds, 0);
    assert.equal(chunk.plannedSeconds, sum, "chunk " + index);
  });
  assert.deepEqual(timeline.chunks, chunksOf(timeline.chain, timeline.segments));
  assert.equal(
    timeline.totalSeconds,
    timeline.segments.reduce((total, s) => total + s.seconds, 0),
  );
  assert.ok(timeline.totalSeconds > timeline.chunks.reduce((t, c) => t + c.plannedSeconds, 0));

  // Poses flow on: an active segment starts where the one before it ended,
  // unless the entry brings its own key positions.
  let previous = null;
  timeline.segments.forEach((segment, index) => {
    if (!segment.active) return;
    if (segment.type === "hold") assert.equal(segment.fromPose, previous, "segment " + index);
    previous = segment.toPose;
  });

  // A walk and a landmark are one moving stretch with no pose.
  const walk = compileTimeline("walk-a", LIB);
  assert.deepEqual(typesOf(walk), ["timed"]);
  assert.equal(walk.segments[0].seconds, 20 * 60);
  assert.equal(walk.segments[0].block, "main");
  assert.equal(walk.segments[0].toPose, null);
  assert.equal(walk.chunks[0].plannedSeconds, 1200);

  const landmark = compileTimeline("landmark-a", LIB);
  assert.equal(landmark.segments.length, 1);
  assert.equal(landmark.segments[0].seconds, 12 * 60);

  // A held pose speaks its entry's own step and carries its anatomy record.
  const firstWork = timeline.segments.find((s) => s.active);
  assert.equal(firstWork.entryId, "pose-a");
  assert.equal(firstWork.stepIndex, 0);
  assert.equal(firstWork.cue, "pose-a cue");
  assert.equal(firstWork.say, "pose-a say");
  assert.deepEqual(firstWork.anatomyStep, { main: "quad" });

  // An exercise without reps is a timed stretch between its two key positions.
  const timed = compileTimeline("routine-timed", LIB);
  const timedSegment = timed.segments.find((s) => s.entryId === "ex-timed");
  assert.equal(timedSegment.type, "timed");
  assert.equal(timedSegment.active, true);
  assert.equal(timedSegment.reps, null);
  assert.deepEqual(timedSegment.fromPose, { rootAngle: 3 });
  assert.deepEqual(timedSegment.toPose, { rootAngle: 4 });
  assert.equal(timedSegment.seconds, 60);
});

/* ---------------------------------------------------- the clock (Task 2.2) */

/** A clock on an injected millisecond reading the test advances by hand. */
function makeClock(timeline) {
  let nowMs = 0;
  const clock = createClock({ timeline, now: () => nowMs });
  return {
    clock,
    advance(seconds) { nowMs += seconds * 1000; },
  };
}

const sumSeconds = (segments) => segments.reduce((total, s) => total + s.seconds, 0);
const activeTotalOf = (segments) =>
  segments.filter((s) => s.active).reduce((total, s) => total + s.seconds, 0);

/** Active seconds a span of running time adds from a position in the timeline. */
function activeGain(segments, index, segmentElapsed, span) {
  let left = span;
  let active = 0;
  let i = index;
  let at = segmentElapsed;
  while (left > 0 && i < segments.length) {
    const full = segments[i].seconds;
    const step = Math.min(full - at, left);
    if (segments[i].active) active += step;
    at += step;
    left -= step;
    if (at >= full) {
      i += 1;
      at = 0;
    }
  }
  return active;
}

test("tick walks through segment boundaries, one segment event per boundary", () => {
  const timeline = compileTimeline("routine-a", LIB);
  const { clock, advance } = makeClock(timeline);
  const events = [];
  clock.on((event) => { if (event.type === "segment") events.push(event); });

  const start = clock.state();
  assert.equal(start.segmentIndex, 0);
  assert.equal(start.segmentElapsed, 0);
  assert.equal(start.elapsed, 0);
  assert.equal(start.paused, true, "a fresh clock is paused");
  assert.equal(start.ended, false);

  clock.play();
  advance(timeline.segments[0].seconds);
  const afterFirst = clock.tick();
  assert.equal(afterFirst.segmentIndex, 1, "the clock really moved on");
  assert.ok(events.length > 0, "the clock really announced the move");
  assert.equal(events.length, 1);
  assert.equal(events[0].segmentIndex, 1);
  assert.equal(events[0].cause, "tick");
  assert.equal(events[0].state.segmentIndex, 1);
  assert.equal(afterFirst.segmentElapsed, 0);

  // One span covering three boundaries: three events with consecutive indexes.
  const span = sumSeconds(timeline.segments.slice(1, 4));
  advance(span);
  const afterSpan = clock.tick();
  assert.deepEqual(events.map((e) => e.segmentIndex), [1, 2, 3, 4]);
  assert.equal(afterSpan.segmentIndex, 4);
  assert.equal(afterSpan.segmentElapsed, 0);
  assert.equal(afterSpan.elapsed, timeline.segments[0].seconds + span);
});

test("active seconds grow only inside active segments", () => {
  const timeline = compileTimeline("routine-a", LIB);
  const { clock, advance } = makeClock(timeline);
  clock.play();

  const covered = timeline.segments.slice(0, 12);
  const span = sumSeconds(covered);
  const expected = activeTotalOf(covered);
  assert.ok(covered.some((s) => s.type === "transition"), "a transition is crossed");
  assert.ok(covered.some((s) => s.type === "rest"), "a rest is crossed");

  advance(span);
  const state = clock.tick();
  assert.equal(state.segmentIndex, 12);
  assert.equal(state.segmentElapsed, 0);
  assert.equal(state.elapsed, span);
  assert.deepEqual(state.activeSeconds, [expected], "one number per chunk");
  assert.equal(expected, 5 * 60, "the five holds in there, and nothing for moves or rests");
  assert.ok(expected < span, "the quiet segments added nothing to the count");
});

test("pause freezes every count", () => {
  const timeline = compileTimeline("routine-a", LIB);
  const { clock, advance } = makeClock(timeline);
  clock.play();

  advance(30);
  clock.tick();
  const paused = clock.pause();
  assert.equal(paused.paused, true);
  assert.equal(paused.segmentIndex, 0);
  assert.equal(paused.segmentElapsed, 30);
  assert.equal(paused.elapsed, 30);
  assert.deepEqual(paused.activeSeconds, [30]);

  advance(100);
  const after = clock.tick();
  assert.deepEqual(after, paused, "100 s of wall time moved nothing");
});

test("skip moves on and never counts the remainder of the skipped segment", () => {
  const timeline = compileTimeline("routine-a", LIB);
  const { clock, advance } = makeClock(timeline);
  const events = [];
  clock.on((event) => { if (event.type === "segment") events.push(event); });

  clock.play();
  advance(20);
  const running = clock.tick();
  assert.equal(running.activeSeconds[0], 20);

  const skipped = clock.skip();
  assert.equal(skipped.segmentIndex, 1);
  assert.equal(skipped.segmentElapsed, 0);
  assert.equal(skipped.activeSeconds[0], 20, "the 40 s left in the hold never counts");
  assert.equal(skipped.elapsed, 20, "skipping is not running time");
  assert.equal(events.length, 1);
  assert.equal(events[0].cause, "skip");
  assert.equal(events[0].segmentIndex, 1);

  // Skipping the last segment ends the session.
  const last = timeline.segments.length - 1;
  clock.seek(last);
  const endings = [];
  clock.on((event) => { if (event.type === "end") endings.push(event); });
  const atEnd = clock.skip();
  assert.equal(atEnd.ended, true);
  assert.equal(atEnd.paused, true);
  assert.equal(atEnd.segmentIndex, last);
  assert.equal(atEnd.segmentElapsed, timeline.segments[last].seconds);
  assert.equal(endings.length, 1);
});

test("back returns to the previous non-transition segment without lowering the counts", () => {
  const timeline = compileTimeline("routine-a", LIB);
  const { clock, advance } = makeClock(timeline);
  clock.play();

  advance(timeline.segments[0].seconds + timeline.segments[1].seconds);
  const atTwo = clock.tick();
  assert.equal(atTwo.segmentIndex, 2);
  assert.equal(atTwo.activeSeconds[0], timeline.segments[0].seconds);

  const back = clock.back();
  assert.equal(timeline.segments[1].type, "transition");
  assert.equal(back.segmentIndex, 0, "index 1 is a move, so back steps past it");
  assert.equal(back.segmentElapsed, 0);
  assert.equal(back.elapsed, atTwo.elapsed);
  assert.equal(back.activeSeconds[0], atTwo.activeSeconds[0], "active time never shrinks");

  const again = clock.back();
  assert.equal(again.segmentIndex, 0, "at the head of the session, back restarts segment 0");
  assert.equal(again.segmentElapsed, 0);
  assert.equal(again.activeSeconds[0], atTwo.activeSeconds[0]);
});

test("seek sets the position and every listener sees the same index", () => {
  const timeline = compileTimeline("routine-a", LIB);
  const { clock } = makeClock(timeline);
  const one = [];
  const two = [];
  clock.on((event) => { if (event.type === "segment") one.push({ index: event.segmentIndex, cause: event.cause }); });
  clock.on((event) => { if (event.type === "segment") two.push({ index: event.segmentIndex, cause: event.cause }); });

  const target = 4;
  const state = clock.seek(target);
  assert.equal(state.segmentIndex, target);
  assert.equal(state.segmentElapsed, 0);
  assert.deepEqual(one, [{ index: target, cause: "seek" }]);
  assert.deepEqual(two, one, "both listeners were told the same segment");
  assert.equal(clock.state().segmentIndex, target);

  assert.equal(clock.seek(9999).segmentIndex, timeline.segments.length - 1, "clamped at the end");
  assert.equal(clock.seek(-5).segmentIndex, 0, "clamped at the start");

  const fails = (fn) => assert.throws(fn, (err) => {
    assert.ok(err instanceof SessionError);
    assert.equal(err.code, "bad_index");
    return true;
  });
  fails(() => clock.seek("x"));
  fails(() => clock.seek(1.5));
  fails(() => clock.seek());
});

test("running through everything ends the clock, once", () => {
  const timeline = compileTimeline("routine-a", LIB);
  assert.ok(timeline.totalSeconds >= 600, "a routine worth a session");
  const { clock, advance } = makeClock(timeline);
  const types = [];
  clock.on((event) => types.push(event.type));
  clock.play();

  advance(timeline.totalSeconds);
  const state = clock.tick();
  const last = timeline.segments.length - 1;
  const activeTotal = activeTotalOf(timeline.segments);

  assert.equal(state.ended, true);
  assert.equal(state.paused, true);
  assert.equal(state.segmentIndex, last);
  assert.equal(state.segmentElapsed, timeline.segments[last].seconds);
  assert.equal(state.elapsed, timeline.totalSeconds);
  assert.equal(state.activeSeconds[0], activeTotal, "every active second, and no other");
  assert.equal(types.filter((t) => t === "end").length, 1);
  assert.equal(
    types.filter((t) => t === "segment").length,
    timeline.segments.length - 1,
    "one segment event per boundary crossed",
  );

  advance(10);
  const later = clock.tick();
  assert.deepEqual(later, state, "an ended clock does not move");
  assert.equal(types.filter((t) => t === "end").length, 1, "the end is announced once");
});

test("a stretch that runs past the end adds only the time it spent", () => {
  const timeline = compileTimeline("routine-a", LIB);
  const { clock, advance } = makeClock(timeline);
  clock.play();

  advance(timeline.totalSeconds + 10);
  const state = clock.tick();
  const last = timeline.segments[timeline.segments.length - 1];

  assert.equal(state.ended, true);
  assert.equal(state.elapsed, timeline.totalSeconds, "the ten seconds after the end are dropped");
  assert.equal(state.activeSeconds[0], activeTotalOf(timeline.segments));
  assert.equal(state.segmentElapsed, last.seconds);
});

test("play and setTimeline account for the time since the last read", () => {
  const timeline = compileTimeline("routine-a", LIB);

  const again = makeClock(timeline);
  again.clock.play();
  again.advance(5);
  again.clock.play();
  again.advance(3);
  assert.equal(again.clock.tick().elapsed, 8, "the five seconds before a second play() still count");

  const swapped = makeClock(timeline);
  swapped.clock.play();
  swapped.advance(5);
  swapped.clock.setTimeline(timeline);
  swapped.advance(3);
  assert.equal(swapped.clock.tick().elapsed, 8, "the five seconds before the swap still count");
});

test("setTimeline never drops a count already earned", () => {
  const twoChunks = compileSession([{ chunkId: "routine-a" }, { chunkId: "walk-a" }], LIB);
  const oneChunk = compileTimeline("routine-a", LIB);

  const { clock, advance } = makeClock(twoChunks);
  clock.play();
  advance(twoChunks.segments[0].seconds + twoChunks.segments[1].seconds);
  const running = clock.tick();
  assert.equal(running.activeSeconds.length, 2);
  const earned = running.activeSeconds.slice();
  assert.ok(earned[0] > 0);

  const shrunk = clock.setTimeline(oneChunk);
  assert.equal(shrunk.activeSeconds.length, 2, "the longer of the two arrays is kept");
  assert.deepEqual(shrunk.activeSeconds, earned, "no earned second is dropped");

  // The other way round: the array grows, by zeros, to the new chunk count.
  const grown = makeClock(oneChunk);
  grown.clock.play();
  grown.advance(10);
  grown.clock.tick();
  const wider = grown.clock.setTimeline(twoChunks);
  assert.deepEqual(wider.activeSeconds, [10, 0]);
});

test("extend with a round mid-session keeps elapsed and activeSeconds", () => {
  const base = compileSession([{ chunkId: "routine-a" }], LIB);
  const { clock, advance } = makeClock(base);
  clock.play();

  clock.seek(4);
  advance(30);
  const running = clock.tick();
  assert.equal(running.segmentIndex, 4);
  assert.equal(running.segmentElapsed, 30);
  assert.deepEqual(running.activeSeconds, [30]);

  const extended = extend(base, running, LIB, { addRound: true });
  const fresh = compileSession([{ chunkId: "routine-a", extraRounds: 1 }], LIB);
  assert.deepEqual(extended.chain, [{ chunkId: "routine-a", extraRounds: 1 }]);
  assert.equal(
    extended.chunks[0].plannedSeconds,
    base.chunks[0].plannedSeconds + 210,
    "one main round of three steps with their rests",
  );
  assert.equal(extended.totalSeconds, fresh.totalSeconds);
  assert.equal(extended.totalSeconds - base.totalSeconds, 210 + 3 * TRANSITION_SECONDS);
  assert.equal(
    extended.segments.filter((s) => s.active && s.block === "main").length,
    base.segments.filter((s) => s.active && s.block === "main").length + 3,
  );

  const after = clock.setTimeline(extended);
  assert.equal(after.elapsed, running.elapsed);
  assert.deepEqual(after.activeSeconds, running.activeSeconds);
  assert.equal(after.segmentIndex, running.segmentIndex);
  assert.equal(after.segmentElapsed, running.segmentElapsed);
  assert.equal(after.ended, false);
  assert.equal(after.paused, false, "the swap does not pause the player");

  // The clock keeps counting on the longer timeline.
  const gained = activeGain(extended.segments, 4, 30, 60);
  advance(60);
  const later = clock.tick();
  assert.equal(later.elapsed, running.elapsed + 60);
  assert.equal(later.activeSeconds[0], running.activeSeconds[0] + gained);
});

test("extend at the end appends a chunk and setTimeline un-ends at the first new segment", () => {
  const base = compileTimeline("walk-a", LIB);
  assert.equal(base.segments.length, 1);
  const { clock, advance } = makeClock(base);
  clock.play();
  advance(base.totalSeconds);
  const ended = clock.tick();
  assert.equal(ended.ended, true);

  const extended = extend(base, ended, LIB, { addChunk: "walk-a" });
  assert.equal(extended.chain.length, 2);
  assert.equal(extended.chunks.length, 2, "a second chunk to count for");
  assert.deepEqual(extended.chunks.map((c) => c.chunkId), ["walk-a", "walk-a"]);
  assert.equal(extended.chunks[0].plannedSeconds, base.chunks[0].plannedSeconds);
  assert.equal(extended.chunks[1].plannedSeconds, base.chunks[0].plannedSeconds);
  assert.deepEqual(
    extended.segments.slice(0, base.segments.length),
    base.segments,
    "what was already played is untouched",
  );
  assert.ok(extended.totalSeconds > base.totalSeconds);

  const resumed = clock.setTimeline(extended);
  assert.equal(resumed.ended, false);
  assert.equal(resumed.paused, true, "it waits to be played again");
  assert.equal(resumed.segmentIndex, base.segments.length, "the first new segment");
  assert.equal(resumed.segmentElapsed, 0);
  assert.equal(resumed.elapsed, ended.elapsed);
  assert.equal(resumed.activeSeconds.length, 2);
  assert.equal(resumed.activeSeconds[0], ended.activeSeconds[0]);
  assert.equal(resumed.activeSeconds[1], 0);
});

test("extend never mutates the timeline it is given", () => {
  const base = compileSession([{ chunkId: "walk-a" }, { chunkId: "routine-a" }], LIB);
  const before = deep(base);

  const byRound = extend(base, { segmentIndex: 2 }, LIB, { addRound: true });
  const byChunk = extend(base, { segmentIndex: 2 }, LIB, { addChunk: "routine-b" });

  assert.deepEqual(deep(base), before, "the input timeline is read, never written");
  assert.equal(byRound.chain.length, base.chain.length);
  assert.equal(byRound.chain[base.chain.length - 1].extraRounds, 1);
  assert.equal(byChunk.chain.length, base.chain.length + 1);
  assert.equal(byChunk.chain[byChunk.chain.length - 1].chunkId, "routine-b");
  assert.notEqual(byRound.chain, base.chain);
  assert.notEqual(byRound.segments, base.segments);
  assert.deepEqual(byChunk.opts, base.opts, "the timeline's own opts carry over");
  assert.notEqual(byChunk.chain[0], base.chain[0], "the chain items are copies too");
});

test("a round added to a finished flow never replays its closing hold", () => {
  const old = compileTimeline("flow-a", LIB);
  const fresh = compileSession([{ chunkId: "flow-a", extraRounds: 1 }], LIB);
  const last = old.segments.length - 1;

  // The closing hold of the old flow is a plain hold once a round follows it,
  // and that is the only thing about it that changes.
  assert.equal(old.segments[last].type, "hold");
  assert.equal(old.segments[last].block, "cooldown");
  assert.equal(fresh.segments[last].type, "hold");
  assert.equal(fresh.segments[last].block, "main");
  assert.deepEqual(withoutBlock(fresh.segments[last]), withoutBlock(old.segments[last]));

  const extended = extend(old, { segmentIndex: last }, LIB, { addRound: true });

  assert.equal(extended.segments.length, fresh.segments.length, "the fresh compile, no hold twice");
  assert.deepEqual(
    extended.segments.slice(0, old.segments.length).map(withoutBlock),
    old.segments.map(withoutBlock),
    "what was played is still the old timeline's own holds",
  );
  assert.deepEqual(extended.segments.map(withoutBlock), fresh.segments.map(withoutBlock));

  const COUNTED = new Set(["hold", "reps", "timed", "rest"]);
  const countedSum = extended.segments
    .filter((s) => COUNTED.has(s.type))
    .reduce((total, s) => total + s.seconds, 0);
  assert.equal(extended.chunks[0].plannedSeconds, fresh.chunks[0].plannedSeconds);
  assert.equal(countedSum, extended.chunks[0].plannedSeconds, "every hold in the result counted once");
});

test("a round added to a finished routine keeps every old segment and adds a main round", () => {
  const old = compileTimeline("routine-a", LIB);
  const fresh = compileSession([{ chunkId: "routine-a", extraRounds: 1 }], LIB);
  const at = old.segments.findIndex((s) => s.block === "cooldown");
  assert.ok(at > 0, "the routine cools down at all");

  const extended = extend(old, { segmentIndex: old.segments.length - 1 }, LIB, { addRound: true });

  assert.deepEqual(
    extended.segments.slice(0, old.segments.length),
    old.segments,
    "every played segment is kept exactly as played, block included",
  );
  assert.equal(extended.segments[old.segments.length].block, "main", "the new round follows");
  assert.equal(extended.segments[extended.segments.length - 1].block, "cooldown");
  assert.equal(
    extended.segments.length,
    old.segments.length + (fresh.segments.length - at),
    "only the part from the old cool-down onwards is recompiled",
  );
});

test("a round added at the first cool-down segment carries on into a main round", () => {
  const old = compileTimeline("routine-a", LIB);
  const at = old.segments.findIndex((s) => s.block === "cooldown");

  const extended = extend(old, { segmentIndex: at }, LIB, { addRound: true });

  assert.deepEqual(extended.segments.slice(0, at + 1), old.segments.slice(0, at + 1));
  assert.equal(extended.segments[at + 1].block, "main");
  assert.ok(extended.segments.length > old.segments.length);
});

test("a routine added after a finished flow repeats no played segment", () => {
  const old = compileSession([{ chunkId: "routine-a" }, { chunkId: "flow-a" }], LIB);
  const fresh = compileSession(
    [{ chunkId: "routine-a" }, { chunkId: "flow-a" }, { chunkId: "routine-b" }],
    LIB,
  );
  const at = firstChangedIgnoringBlock(fresh.segments, old.segments);
  assert.equal(at, old.segments.length, "the played segment range is a prefix, block aside");

  const extended = extend(old, { segmentIndex: old.segments.length - 1 }, LIB, { addChunk: "routine-b" });

  assert.equal(extended.segments.length, old.segments.length + (fresh.segments.length - at));
  assert.equal(extended.segments.length, fresh.segments.length);

  for (let i = 1; i < extended.segments.length; i += 1) {
    const before = extended.segments[i - 1];
    const after = extended.segments[i];
    const repeat = before.type === "hold" && after.type === "hold"
      && before.chunkIndex === after.chunkIndex
      && before.entryId === after.entryId
      && before.stepIndex === after.stepIndex;
    assert.equal(repeat, false, "segment " + i + " repeats the segment before it");
  }

  // The flow's closing hold is now a plain hold, but it is still one hold.
  const holdsOf = (timeline) => timeline.segments.filter(
    (s) => s.type === "hold" && s.chunkIndex === 1 && s.entryId === "pose-d",
  ).length;
  assert.equal(holdsOf(extended), holdsOf(old));
});

test("a round cannot be added to a walk or a landmark", () => {
  for (const chunkId of ["walk-a", "landmark-a"]) {
    const timeline = compileTimeline(chunkId, LIB);
    assert.throws(
      () => extend(timeline, { segmentIndex: 0 }, LIB, { addRound: true }),
      (err) => {
        assert.ok(err instanceof SessionError, chunkId + " raises a SessionError");
        assert.equal(err.code, "no_rounds");
        return true;
      },
    );
    assert.deepEqual(
      canExtend(timeline, { segmentIndex: 0 }, LIB, { addRound: true }),
      { ok: false, reason: "max_rounds" },
      chunkId + " is still refused as having no rounds",
    );
  }
});

test("a flow of two rounds takes one more and refuses a fourth", () => {
  const flow = compileTimeline("flow-a", LIB);
  assert.equal(flow.chain[0].extraRounds, 0);

  assert.deepEqual(
    canExtend(flow, { segmentIndex: 0 }, LIB, { addRound: true }),
    { ok: true, reason: null },
    "two rounds may become three",
  );

  const threeRounds = compileSession([{ chunkId: "flow-a", extraRounds: 1 }], LIB);
  assert.equal(threeRounds.chain[0].extraRounds, 1);
  assert.deepEqual(
    canExtend(threeRounds, { segmentIndex: 0 }, LIB, { addRound: true }),
    { ok: false, reason: "max_rounds" },
    "three may not become four",
  );
});

test("canExtend refuses at the cap, past maxRounds and for hard back-to-back areas", () => {
  // max_session: three 20-minute walks are the cap, a fourth passes it.
  const walks = compileSession(
    [{ chunkId: "walk-a" }, { chunkId: "walk-a" }, { chunkId: "walk-a" }],
    LIB,
  );
  assert.equal(
    walks.chunks.reduce((total, c) => total + c.plannedSeconds, 0),
    SESSION_MAX_SECONDS,
  );
  assert.deepEqual(
    canExtend(walks, { segmentIndex: 0 }, LIB, { addChunk: "walk-a" }),
    { ok: false, reason: "max_session" },
  );
  assert.deepEqual(
    canExtend(walks, { segmentIndex: 0 }, LIB, { addChunk: "landmark-a" }),
    { ok: false, reason: "max_session" },
    "a session already at the cap refuses everything",
  );

  // max_rounds: routine-a runs two rounds and may take one more, no more.
  const plain = compileTimeline("routine-a", LIB);
  assert.deepEqual(canExtend(plain, { segmentIndex: 2 }, LIB, { addRound: true }), { ok: true, reason: null });
  const oneExtra = compileSession([{ chunkId: "routine-a", extraRounds: 1 }], LIB);
  assert.deepEqual(
    canExtend(oneExtra, { segmentIndex: 2 }, LIB, { addRound: true }),
    { ok: false, reason: "max_rounds" },
  );
  const walk = compileTimeline("walk-a", LIB);
  assert.deepEqual(
    canExtend(walk, { segmentIndex: 0 }, LIB, { addRound: true }),
    { ok: false, reason: "max_rounds" },
    "a walk has no rounds",
  );

  // hard_same_area: two level-3 chunks that share an area never sit together.
  const hard = compileTimeline("routine-hard-a", LIB);
  assert.deepEqual(
    canExtend(hard, { segmentIndex: 0 }, LIB, { addChunk: "routine-hard-b" }),
    { ok: false, reason: "hard_same_area" },
  );
  assert.deepEqual(
    canExtend(hard, { segmentIndex: 0 }, LIB, { addChunk: "routine-hard-c" }),
    { ok: true, reason: null },
    "different areas are fine",
  );
  assert.deepEqual(
    canExtend(hard, { segmentIndex: 0 }, LIB, { addChunk: "routine-easy" }),
    { ok: true, reason: null },
    "a level-2 chunk is never refused",
  );

  // Everything else is allowed.
  assert.deepEqual(
    canExtend(plain, { segmentIndex: 0 }, LIB, { addChunk: "flow-a" }),
    { ok: true, reason: null },
  );

  assert.throws(
    () => extend(plain, { segmentIndex: 0 }, LIB, { addChunk: "walk-nope" }),
    (err) => err instanceof SessionError && err.code === "unknown_chunk",
  );
  assert.throws(
    () => canExtend(plain, { segmentIndex: 0 }, LIB, { addChunk: "walk-nope" }),
    (err) => err instanceof SessionError && err.code === "unknown_chunk",
  );
});

test("half of a chunk's planned time is done", () => {
  assert.equal(isChunkDone(600, 299), false);
  assert.equal(isChunkDone(600, 300), true);
  assert.equal(isChunkDone(900, 450), true);
  assert.equal(isChunkDone(0, 100), false, "no planned time is never done");
  assert.equal(isChunkDone(-10, 100), false);
  assert.equal(isChunkDone(NaN, 100), false);
  assert.equal(isChunkDone(Infinity, 100), false);
});

test("a listener that throws does not stop the others or the clock", () => {
  const timeline = compileTimeline("routine-a", LIB);
  const { clock, advance } = makeClock(timeline);
  const heard = [];
  clock.on(() => { throw new Error("boom"); });
  clock.on((event) => heard.push(event.type));

  clock.play();
  assert.ok(heard.includes("play"));

  advance(timeline.segments[0].seconds);
  const state = clock.tick();
  assert.ok(heard.includes("segment"));
  assert.equal(state.segmentIndex, 1, "the clock kept its own time");
  assert.equal(state.activeSeconds[0], timeline.segments[0].seconds);
});

test("the session route sits above the static catch-all and serves server/moves/session.cjs", () => {
  const routes = readFileSync(ROUTES_PATH, "utf8");
  const figureAt = routes.indexOf('"/ramble/static/figure.js"');
  const sessionAt = routes.indexOf('"/ramble/static/session.js"');
  const catchAllAt = routes.indexOf('"/ramble/static/:file"');
  assert.ok(sessionAt > 0, "the session route exists");
  assert.ok(sessionAt > figureAt, "it sits right after the figure route");
  assert.ok(catchAllAt > sessionAt, "it must be registered before the :file catch-all");
  assert.ok(
    routes.includes('join(SERVER_DIR, "moves", "session.cjs")'),
    "it serves the shared engine, not a copy",
  );
});