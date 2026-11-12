/**
 * Moves design Task 1.2 — routines, shared blocks, landmarks and the chunk
 * rule (private engineering notes §5.1).
 *
 * Every entry here is built in-test against a small fixture library; nothing
 * reads the shipped moves library except the one check that the shipped
 * directory drafts cleanly.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHUNK_MIN_MINUTES, STAGES_MAX, DEFAULT_MAX_ROUNDS,
  plannedSeconds, isChunk, validateEntry, validateDrafts,
} from "../bundles/ramble/server/moves/library.js";

const SHIPPED_LIBRARY = join(dirname(fileURLToPath(import.meta.url)), "..", "bundles", "ramble", "server", "moves", "library");

/** A minimal valid entry. Every test mutates exactly one thing from here. */
function base(over = {}) {
  return {
    id: "pose-test",
    kind: "pose",
    title: "Test pose",
    minutes: 1,
    level: 1,
    indoor: true,
    activity: "yoga",
    equipment: ["none"],
    tags: [],
    areas: ["mobility"],
    steps: ["Stand tall."],
    works: [],
    stretches: [],
    mistakes: [],
    skipIf: [],
    easier: null,
    harder: null,
    sources: [{ title: "Ramble test fixture", url: "", license: "CC0" }],
    reviewed: true,
    pose: {},
    ...over,
  };
}

const pose = (id, over = {}) => base({ id, ...over });

function exercise(id, over = {}) {
  const e = base({ id, kind: "exercise", activity: "band", ...over });
  delete e.pose;
  return e;
}

const POSE_IDS = ["pose-a", "pose-b", "pose-c", "pose-d", "pose-e", "pose-f"];

/** The fixture library: six reviewed poses, two exercises, one draft pose. */
const LIB = [
  ...POSE_IDS.map((id) => pose(id)),
  exercise("ex-band", { equipment: ["band"], skipIf: ["shoulder"] }),
  exercise("ex-plain"),
  pose("pose-draft", { reviewed: false }),
];

const items = (ids, holdSeconds = 30) => ids.map((id) => ({ id, holdSeconds }));

/** Three blocks that plan to 11 minutes at the default rounds. */
function blocks(over = {}) {
  return {
    warmup: [
      { id: "pose-a", seconds: 60 },
      { id: "pose-b", seconds: 60 },
    ],
    main: [
      { id: "pose-c", seconds: 60, restSeconds: 10 },
      { id: "ex-plain", seconds: 60, restSeconds: 10 },
      { id: "pose-a", seconds: 60, restSeconds: 10 },
    ],
    cooldown: [
      { id: "pose-d", seconds: 60 },
      { id: "pose-e", seconds: 60 },
    ],
    ...over,
  };
}

/** A valid 11-minute routine: 120s warm-up + 2 x 210s main + 120s cool-down. */
function routine(over = {}) {
  const r = base({
    id: "routine-test",
    kind: "routine",
    title: "Test routine",
    minutes: 11,
    activity: "yoga",
    indoor: true,
    equipment: ["none"],
    steps: ["Work through the blocks in order."],
    blocks: blocks(),
    rounds: 2,
    ...over,
  });
  delete r.pose;
  return r;
}

function flowEntry(over = {}) {
  const f = base({
    id: "flow-test",
    kind: "flow",
    minutes: 5,
    activity: "yoga",
    equipment: ["mat"],
    steps: ["Move through each pose in order."],
    flow: items(POSE_IDS.slice(0, 5), 60),
    ...over,
  });
  delete f.pose;
  return f;
}

function walkEntry(over = {}) {
  const w = base({ id: "walk-test", kind: "walk", minutes: 20, activity: "walk", indoor: false, ...over });
  delete w.pose;
  return w;
}

function landmark(over = {}) {
  const l = base({
    id: "landmark-test",
    kind: "landmark",
    minutes: 10,
    activity: "walk",
    indoor: false,
    landmark: "park",
    reachMeters: 100,
    ...over,
  });
  delete l.pose;
  return l;
}

const has = (result, needle) => result.errors.some((e) => e.includes(needle));

/** Run `fn` with console.warn captured; returns [result, warnings[]]. */
function captureWarnings(fn) {
  const warnings = [];
  const orig = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try { return [fn(), warnings]; } finally { console.warn = orig; }
}

const TEMP_DIRS = [];
function tempDir() {
  const d = mkdtempSync(join(tmpdir(), "ramble-moves-chunks-"));
  TEMP_DIRS.push(d);
  return d;
}
after(() => { for (const d of TEMP_DIRS) rmSync(d, { recursive: true, force: true }); });

test("a routine over reviewed steps and matching seconds validates", () => {
  assert.deepEqual(validateEntry(routine(), LIB), { ok: true, errors: [] });
  assert.equal(DEFAULT_MAX_ROUNDS, 2);
});

test("a routine step naming an unknown id is rejected", () => {
  const r = routine();
  r.blocks.main[1] = { id: "pose-nope", seconds: 60, restSeconds: 10 };
  const v = validateEntry(r, LIB);
  assert.equal(v.ok, false);
  assert.ok(has(v, "pose-nope"), v.errors.join("; "));
});

test("a routine step naming an unreviewed entry is rejected unless drafts are allowed", () => {
  const r = routine();
  r.blocks.main[0] = { id: "pose-draft", seconds: 60, restSeconds: 10 };

  const strict = validateEntry(r, LIB);
  assert.equal(strict.ok, false);
  assert.ok(has(strict, "pose-draft"), strict.errors.join("; "));
  assert.ok(has(strict, "not reviewed"), strict.errors.join("; "));

  assert.deepEqual(validateEntry(r, LIB, { allowUnreviewed: true }), { ok: true, errors: [] });
});

test("a routine step must name a pose, an exercise or a walk", () => {
  const flow = flowEntry({ id: "flow-fixture" });
  const r = routine();
  r.blocks.cooldown[1] = { id: "flow-fixture", seconds: 60 };
  const v = validateEntry(r, [...LIB, flow]);
  assert.equal(v.ok, false);
  assert.ok(has(v, "flow-fixture"), v.errors.join("; "));
  assert.ok(has(v, "pose, exercise or walk"), v.errors.join("; "));
});

test("a routine's skipIf must carry every limit tag of its steps", () => {
  const r = routine();
  r.blocks.main[1] = { id: "ex-band", seconds: 60, restSeconds: 10 };
  r.equipment = ["none", "band"];

  const missing = validateEntry(r, LIB);
  assert.equal(missing.ok, false);
  assert.ok(has(missing, "shoulder"), missing.errors.join("; "));

  r.skipIf = ["shoulder"];
  assert.deepEqual(validateEntry(r, LIB), { ok: true, errors: [] });
});

test("a routine's equipment must cover every step's equipment", () => {
  const r = routine({ skipIf: ["shoulder"] });
  r.blocks.main[1] = { id: "ex-band", seconds: 60, restSeconds: 10 };

  const missing = validateEntry(r, LIB);
  assert.equal(missing.ok, false);
  assert.ok(has(missing, "band"), missing.errors.join("; "));

  r.equipment = ["none", "band"];
  assert.deepEqual(validateEntry(r, LIB), { ok: true, errors: [] });
});

test("a routine's minutes must sit within 15% of its planned block time", () => {
  assert.equal(validateEntry(routine({ minutes: 13 }), LIB).ok, false);
  const off = validateEntry(routine({ minutes: 13 }), LIB);
  assert.ok(off.errors.some((e) => e.includes("15%") || e.includes("planned")), off.errors.join("; "));

  // 11 planned minutes: 12 and 10 are inside the band, 13 is not.
  assert.equal(validateEntry(routine({ minutes: 12 }), LIB).ok, true);
  assert.equal(validateEntry(routine({ minutes: 10 }), LIB).ok, true);
});

test("a routine and a landmark are chunks: minutes must reach the minimum", () => {
  const shortRoutine = validateEntry(routine({ minutes: 9 }), LIB);
  assert.equal(shortRoutine.ok, false);
  assert.ok(has(shortRoutine, String(CHUNK_MIN_MINUTES)), shortRoutine.errors.join("; "));

  const shortLandmark = validateEntry(landmark({ minutes: 9 }), LIB);
  assert.equal(shortLandmark.ok, false);
  assert.ok(shortLandmark.errors.some((e) => e.includes("minutes")), shortLandmark.errors.join("; "));
});

test("a routine without a warm-up or a cool-down block is rejected", () => {
  const noWarmup = routine();
  delete noWarmup.blocks.warmup;
  const warm = validateEntry(noWarmup, LIB);
  assert.equal(warm.ok, false);
  assert.ok(has(warm, "warmup"), warm.errors.join("; "));

  const noCooldown = routine();
  delete noCooldown.blocks.cooldown;
  const cool = validateEntry(noCooldown, LIB);
  assert.equal(cool.ok, false);
  assert.ok(has(cool, "cooldown"), cool.errors.join("; "));

  const noBlocks = routine();
  delete noBlocks.blocks;
  assert.equal(validateEntry(noBlocks).ok, false, "even the shape pass needs the blocks object");
  assert.equal(validateEntry(noBlocks, LIB).ok, false);
});

test("isChunk: openers and closers are never cards, long entries are", () => {
  const opener = flowEntry({
    id: "flow-opener",
    block: "warmup",
    minutes: 12,
    flow: items(POSE_IDS.slice(0, 3), 60),
  });
  assert.equal(validateEntry(opener, LIB).ok, true);
  assert.equal(isChunk(opener), false, "a block entry is part of a routine, never a card");

  assert.equal(isChunk(walkEntry({ minutes: 20 })), true);

  const shortFlow = flowEntry({ minutes: 5 });
  assert.equal(validateEntry(shortFlow, LIB).ok, true);
  assert.equal(isChunk(shortFlow), false);

  assert.equal(isChunk(routine()), true, "an 11-minute routine is a chunk");
  assert.equal(isChunk(pose("pose-long", { minutes: 30 })), false);
  assert.equal(isChunk(null), false);
});

test("a routine carries at most four stages", () => {
  const four = routine({ stages: [{}, {}, {}, {}] });
  assert.equal(validateEntry(four, LIB).ok, true);

  const five = routine({ stages: [{}, {}, {}, {}, {}] });
  const v = validateEntry(five, LIB);
  assert.equal(v.ok, false);
  assert.ok(has(v, "stages"), v.errors.join("; "));
  assert.equal(STAGES_MAX, 4);
});

test("a landmark's kind and reach must be in range", () => {
  assert.equal(validateEntry(landmark(), LIB).ok, true);
  assert.equal(validateEntry(landmark({ reachMeters: 10 }), LIB).ok, true);
  assert.equal(validateEntry(landmark({ reachMeters: 500 }), LIB).ok, true);

  assert.equal(validateEntry(landmark({ landmark: "volcano" }), LIB).ok, false);
  const near = validateEntry(landmark({ reachMeters: 9 }), LIB);
  assert.equal(near.ok, false);
  assert.ok(has(near, "reachMeters"), near.errors.join("; "));
  assert.equal(validateEntry(landmark({ reachMeters: 501 }), LIB).ok, false);
  assert.equal(validateEntry(landmark({ reachMeters: 12.5 }), LIB).ok, false);
});

test("anatomy ids resolve only when a vocabulary is handed in", () => {
  const anatomy = [{
    main: "quad",
    working: ["quad", "glute"],
    lengthening: ["hamstring"],
    bones: [],
    nerves: [],
  }];
  const entry = pose("pose-anatomy", { anatomy });

  assert.equal(validateEntry(entry).ok, true, "no vocabulary, no id check");
  assert.equal(validateEntry(entry, null, { vocab: ["quad", "glute", "hamstring"] }).ok, true);

  const unknown = validateEntry(entry, null, { vocab: ["quad", "glute"] });
  assert.equal(unknown.ok, false);
  assert.ok(has(unknown, "hamstring"), unknown.errors.join("; "));

  // A vocabulary of records reads the same as one of plain ids.
  assert.equal(validateEntry(entry, null, { vocab: [{ id: "quad" }, { id: "glute" }, { id: "hamstring" }] }).ok, true);
  assert.equal(validateEntry(pose("pose-anatomy-2", { anatomy: "quad" })).ok, false);
});

test("plannedSeconds counts blocks, rounds and holds", () => {
  const r = routine();
  assert.equal(plannedSeconds(r), 660, "11 minutes at the default rounds");
  assert.equal(plannedSeconds(r, LIB), 660, "the library argument changes nothing");
  assert.equal(plannedSeconds(r, null, { rounds: 3 }), 870, "the main block once more");
  assert.equal(plannedSeconds(flowEntry({ flow: items(POSE_IDS.slice(0, 5), 60) })), 300);
  assert.equal(plannedSeconds(walkEntry({ minutes: 20 })), 1200);
});

test("validateDrafts accepts draft entries over unreviewed steps", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "pose-draft.json"), JSON.stringify(pose("pose-draft", { reviewed: false })));
  writeFileSync(join(dir, "routine-draft.json"), JSON.stringify(routine({
    id: "routine-draft",
    reviewed: false,
    blocks: {
      warmup: [{ id: "pose-draft", seconds: 60 }, { id: "pose-draft", seconds: 60 }],
      main: [
        { id: "pose-draft", seconds: 60, restSeconds: 10 },
        { id: "pose-draft", seconds: 60, restSeconds: 10 },
        { id: "pose-draft", seconds: 60, restSeconds: 10 },
      ],
      cooldown: [{ id: "pose-draft", seconds: 60 }, { id: "pose-draft", seconds: 60 }],
    },
  })));

  const [result, warnings] = captureWarnings(() => validateDrafts(dir));
  assert.deepEqual(warnings, [], "drafts are reported, never warned about");
  assert.deepEqual(result, { ok: true, errors: [] });
});

test("validateDrafts reports a broken file by name and a duplicate id", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "broken.json"), "{not json");
  writeFileSync(join(dir, "pose-one.json"), JSON.stringify(pose("pose-dup")));
  writeFileSync(join(dir, "pose-two.json"), JSON.stringify(pose("pose-dup")));

  const result = validateDrafts(dir);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.file === "broken.json"), JSON.stringify(result.errors));
  assert.ok(result.errors.some((e) => e.file === "pose-two.json" && e.error.includes("duplicate")), JSON.stringify(result.errors));
  assert.ok(result.errors.every((e) => typeof e.error === "string" && e.error !== ""));
});

test("validateDrafts on the shipped library directory finds nothing to report", () => {
  const result = validateDrafts();
  assert.deepEqual(result, { ok: true, errors: [] });
  assert.equal(validateDrafts(SHIPPED_LIBRARY).ok, true);
});

test("a block flow may be shorter than a plain flow, which keeps the 5-pose floor", () => {
  const closer = flowEntry({
    id: "flow-closer",
    block: "cooldown",
    minutes: 3,
    flow: items(["pose-a", "pose-b", "pose-c"], 60),
  });
  assert.deepEqual(validateEntry(closer, LIB), { ok: true, errors: [] });

  const plain = flowEntry({ id: "flow-plain", minutes: 3, flow: items(["pose-a", "pose-b", "pose-c"], 60) });
  const v = validateEntry(plain, LIB);
  assert.equal(v.ok, false);
  assert.ok(has(v, "flow"), v.errors.join("; "));

  const offVocabulary = flowEntry({ id: "flow-bad-block", block: "main", minutes: 3 });
  assert.equal(validateEntry(offVocabulary, LIB).ok, false);
  assert.equal(validateEntry(routine({ block: "warmup" }), LIB).ok, false, "a routine never carries a block");
});