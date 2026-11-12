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
} = Session;

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