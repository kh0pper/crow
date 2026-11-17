/**
 * Studio roll clock — when the next ROLL repeat is due, in frames.
 *
 * `roll-clock.js` is the whole of the roll's timing, so it is tested on its own
 * here: the five straight intervals, the one-frame-at-a-time step that makes a
 * tempo change move only later repeats, and the promise that checking and
 * stepping allocate nothing (the loop runs on the audio thread).
 *
 * It is a classic script, so it is loaded the way a Node caller loads it:
 * `require()` from inside the bundle, where `engine/package.json` marks the
 * directory CommonJS. That is the same file the worklet module concatenates, so
 * the last test evaluates it as one (a `vm` scope with no `module`, the way an
 * `AudioWorkletGlobalScope` has none) and reads the global it defines.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ENGINE_DIR = fileURLToPath(new URL("../bundles/studio/engine/", import.meta.url));
const SOURCE = readFileSync(join(ENGINE_DIR, "roll-clock.js"), "utf8");
const bundleRequire = createRequire(join(ENGINE_DIR, "x.js"));
const RollClock = bundleRequire(join(ENGINE_DIR, "roll-clock.js"));

/** One beat in frames at 120 BPM and 48 kHz. */
const BEAT_FRAMES = 24000;

/** The block size every host runs the engine at. */
const BLOCK_FRAMES = 128;

/**
 * The engine's own loop: fire every repeat that is due inside a block, step the
 * clock by the interval the tempo has at that moment, and move to the block
 * after it.
 *
 * @param {{nextFrame: number}} state
 * @param {number} totalBlocks how many blocks to walk
 * @param {number} bpm the song's tempo
 * @param {number} sampleRate the host's rate
 * @param {string} interval a name from `RollClock.INTERVALS`
 * @returns {number[]} the absolute frame of every repeat that fired
 */
function runBlocks(state, totalBlocks, bpm, sampleRate, interval) {
  const hits = [];
  let blockStart = 0;
  for (let block = 0; block < totalBlocks; block += 1) {
    const blockEnd = blockStart + BLOCK_FRAMES;
    while (RollClock.due(state, blockEnd)) {
      hits.push(state.nextFrame);
      RollClock.next(state, RollClock.intervalFrames(bpm, sampleRate, interval));
    }
    blockStart = blockEnd;
  }
  return hits;
}

test("intervalFrames at 120 BPM / 48 kHz and 1/16 is 6000", () => {
  // A sixteenth at 120 BPM lasts 0.25 beats × 0.5 s a beat = 125 ms, which is
  // 6000 frames at 48 kHz.
  assert.equal(RollClock.intervalFrames(120, 48000, "1/16"), 6000);
  assert.equal(RollClock.intervalFrames(120, 44100, "1/16"), 5513, "the rate is the host's own");
  assert.equal(RollClock.intervalFrames(60, 48000, "1/16"), 12000, "half the tempo, twice the frames");
});

test("all five intervals, each half the one before it", () => {
  assert.deepEqual(
    RollClock.INTERVALS.map((interval) => RollClock.intervalFrames(120, 48000, interval)),
    [BEAT_FRAMES, BEAT_FRAMES / 2, BEAT_FRAMES / 4, BEAT_FRAMES / 8, BEAT_FRAMES / 16],
    "1/4, 1/8, 1/16, 1/32 and 1/64 at 120 BPM / 48 kHz",
  );
  assert.deepEqual(
    RollClock.INTERVALS.map((interval) => RollClock.beats(interval)),
    [1, 0.5, 0.25, 0.125, 0.0625],
    "their lengths in beats",
  );
  assert.deepEqual(
    Array.from(RollClock.INTERVALS),
    ["1/4", "1/8", "1/16", "1/32", "1/64"],
    "the five straight values, in the order a picker shows them",
  );
});

test("two adjacent blocks never repeat or skip a hit", () => {
  const step = RollClock.intervalFrames(120, 48000, "1/16");
  const state = RollClock.create(0);
  const hits = runBlocks(state, 200, 120, 48000, "1/16");

  assert.deepEqual(hits, [0, step, 2 * step, 3 * step, 4 * step], "one repeat every interval, no more");
  for (let at = 1; at < hits.length; at += 1) {
    assert.ok(hits[at] > hits[at - 1], "a repeat never fires twice");
    assert.equal(hits[at] - hits[at - 1], step, "and a block boundary never pushes one off its slot");
  }

  // An interval that is not a whole number of blocks: the hit still lands on its
  // own frame, in whichever block covers it.
  const uneven = RollClock.intervalFrames(140, 48000, "1/16");
  assert.equal(uneven, 5143, "140 BPM rounds a sixteenth to 5143 frames");
  const theirs = runBlocks(RollClock.create(0), 200, 140, 48000, "1/16");
  assert.deepEqual(theirs, [0, uneven, 2 * uneven, 3 * uneven, 4 * uneven]);
});

test("a hit on a block boundary waits for the block it sounds in", () => {
  const state = RollClock.create(0);
  assert.equal(RollClock.due(state, 0), false, "the frame the block ends on is not inside it");
  assert.equal(RollClock.due(state, 1), true);
  RollClock.next(state, BLOCK_FRAMES);
  assert.equal(RollClock.due(state, BLOCK_FRAMES), false, "so it fires in the block after, once");
  assert.equal(RollClock.due(state, BLOCK_FRAMES + 1), true);
});

test("1/64 over one beat gives 16 hits", () => {
  // One beat's worth of repeats, watched up to the beat's own frame: a sixteenth
  // is sixteen repeats, so the sixty-fourth is sixteen to the beat.
  const state = RollClock.create(0);
  const hits = [];
  while (RollClock.due(state, BEAT_FRAMES)) {
    hits.push(state.nextFrame);
    RollClock.next(state, RollClock.intervalFrames(120, 48000, "1/64"));
  }
  assert.equal(hits.length, 16, "a sixty-fourth is sixteen to the beat");
  assert.equal(hits[0], 0);
  assert.equal(hits[15], 22500);
  assert.equal(state.nextFrame, BEAT_FRAMES, "the seventeenth repeat is the next beat's first");
});

test("a tempo change between two calls changes the spacing only from the next hit and no hit fires twice", () => {
  const state = RollClock.create(0);
  const slow = RollClock.intervalFrames(120, 48000, "1/16");
  const fast = RollClock.intervalFrames(140, 48000, "1/16");

  const hits = [state.nextFrame];
  RollClock.next(state, slow);
  hits.push(state.nextFrame);
  assert.equal(hits[1] - hits[0], slow, "the hit that was already placed keeps its spacing");

  // The tempo changes now: every repeat from here is spaced by the new interval,
  // and the standing one is neither moved nor played again.
  for (let at = 0; at < 3; at += 1) {
    assert.equal(RollClock.due(state, state.nextFrame + 1), true);
    RollClock.next(state, fast);
    hits.push(state.nextFrame);
  }

  assert.deepEqual(hits, [0, 6000, 11143, 16286, 21429]);
  for (let at = 1; at < hits.length; at += 1) {
    assert.ok(hits[at] > hits[at - 1], "no hit is played twice");
    assert.equal(hits[at] - hits[at - 1], at === 1 ? slow : fast);
  }
});

test("reanchor puts the next repeat one interval after the frame the roll resumes on", () => {
  const state = RollClock.create(0);
  RollClock.next(state, 6000);
  RollClock.reanchor(state, 9000, 6000);
  assert.equal(state.nextFrame, 15000, "a resume never fires a burst of the repeats a pause swallowed");
  assert.equal(RollClock.due(state, 15000), false);
  assert.equal(RollClock.due(state, 15001), true);
});

test("due/next allocate nothing (no returned objects)", () => {
  const state = RollClock.create(0);
  assert.deepEqual(Object.keys(state), ["nextFrame"], "the clock is the one frame it stands on");
  assert.equal(Array.isArray(state), false, "no arrays: the loop runs on the audio thread");

  assert.equal(typeof RollClock.due(state, 128), "boolean");
  assert.equal(RollClock.next(state, 6000), undefined, "next() answers nothing");
  assert.equal(RollClock.reanchor(state, 0, 6000), undefined, "reanchor() answers nothing");
  assert.equal(state.nextFrame, 6000);
  assert.deepEqual(Object.keys(state), ["nextFrame"], "and neither grows the state");

  for (let at = 0; at < 1000; at += 1) {
    RollClock.due(state, state.nextFrame + BLOCK_FRAMES);
    RollClock.next(state, RollClock.intervalFrames(140, 48000, "1/64"));
  }
  assert.deepEqual(Object.keys(state), ["nextFrame"], "a thousand repeats still leave one number");
});

test("a frame count is never 0, so the engine loop always advances", () => {
  // A step of 0 would spin `while (due)` forever on the audio thread, so
  // anything that cannot be worked out moves the clock by one frame instead.
  for (const interval of ["", "1/3", "bar", undefined]) {
    const frames = RollClock.intervalFrames(120, 48000, interval);
    assert.equal(Number.isFinite(frames), true);
    assert.ok(frames >= 1, `an interval named ${String(interval)} still steps the clock`);
  }
  assert.ok(RollClock.intervalFrames(0, 48000, "1/16") >= 1, "a tempo of 0 falls back rather than dividing by it");
  assert.ok(RollClock.intervalFrames(120, 0, "1/16") >= 1, "and so does a rate that is not a rate");

  const state = RollClock.create(0);
  RollClock.next(state, 0);
  assert.equal(state.nextFrame, 1);
  RollClock.reanchor(state, 0, -5);
  assert.equal(state.nextFrame, 1);
});

test("the file evaluates as a classic script and as require()", async () => {
  // The way the worklet gets it: one module, no `module`, no imports.
  const vm = await import("node:vm");
  assert.equal(/^\s*(import|export)\b/m.test(SOURCE), false, "a classic script has no import or export statement");

  const scope = { console: { log() {}, warn() {}, error() {} } };
  vm.createContext(scope);
  vm.runInContext(SOURCE, scope, { filename: "roll-clock.js" });
  const fromScript = scope.StudioRollClock;
  assert.ok(fromScript, "the classic script defines globalThis.StudioRollClock");

  // The way a Node caller gets it (the same file the worklet concatenates).
  assert.ok(RollClock, "require() hands back the same api");
  assert.deepEqual(Array.from(fromScript.INTERVALS), Array.from(RollClock.INTERVALS));
  for (const interval of RollClock.INTERVALS) {
    assert.equal(
      fromScript.intervalFrames(120, 48000, interval),
      RollClock.intervalFrames(120, 48000, interval),
      "both copies space the same interval the same way",
    );
  }

  // And both copies work the same, so a test's clock is the worklet's clock.
  // (Compared field by field: a `vm` scope's objects have that scope's
  // prototypes, so a deep-equal against this realm's literals is not the point.)
  const state = fromScript.create(0);
  assert.equal(state.nextFrame, 0);
  assert.equal(fromScript.due(state, 1), true);
  fromScript.next(state, fromScript.intervalFrames(120, 48000, "1/16"));
  assert.equal(state.nextFrame, 6000);
  assert.equal(fromScript.due(state, 6000), false);
});