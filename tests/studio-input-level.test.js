/**
 * Studio's input level — the meter and the live waveform's columns, on their own.
 *
 * `input-level.js` is plain arithmetic with preallocated buffers, so it is
 * loaded here in plain Node with no audio host at all: a `core` is built by
 * hand, blocks are handed to `process()` exactly as an armed worklet hands them,
 * and the payloads `drain()` returns are read back. Every sample in this file is
 * a constant, a sine or a power of two, so the expected peak, RMS, column
 * minimum and column maximum can be named exactly.
 *
 * It is a classic script, so it is loaded the way a Node caller loads it:
 * `require()` from inside the bundle, where `engine/package.json` marks the
 * directory CommonJS.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ENGINE_DIR = fileURLToPath(new URL("../bundles/studio/engine/", import.meta.url));
const SOURCE = readFileSync(join(ENGINE_DIR, "input-level.js"), "utf8");
const bundleRequire = createRequire(join(ENGINE_DIR, "x.js"));
const StudioInputLevel = bundleRequire(join(ENGINE_DIR, "input-level.js"));

const RATE = 48000;
const BLOCK = 128;

/** @param {object} [over] the settings a test cares about @returns {object} one core */
function makeCore(over = {}) {
  return new StudioInputLevel.InputLevelCore({ sampleRate: RATE, ...over });
}

/** @param {number} frames @param {number} value @returns {Float32Array} a constant block */
function constant(frames, value) {
  const samples = new Float32Array(frames);
  samples.fill(value);
  return samples;
}

/** @param {number} frames @param {number} rateHz @returns {Float32Array} a full-scale sine */
function sine(frames, rateHz) {
  const samples = new Float32Array(frames);
  for (let at = 0; at < frames; at += 1) samples[at] = Math.sin((2 * Math.PI * rateHz * at) / RATE);
  return samples;
}

test("process allocates no arrays: ring and accumulator arrays keep their identity across 1000 blocks of 128 frames", () => {
  const core = makeCore();
  const minRing = core.minRing;
  const maxRing = core.maxRing;
  const frameRing = core.frameRing;
  assert.ok(minRing instanceof Float32Array, "the column minimums are a typed array");
  assert.ok(maxRing instanceof Float32Array, "the column maximums are a typed array");
  assert.ok(frameRing instanceof Float64Array, "the column frames are a Float64Array");

  const block = constant(BLOCK, 0.25);
  let frame = 0;
  for (let index = 0; index < 1000; index += 1) {
    // Nothing is drained here: the ring keeps turning and posts pile up behind
    // the same flag, which is the widest path the audio thread ever runs.
    core.process(frame, block, BLOCK);
    frame += BLOCK;
  }

  assert.equal(core.minRing, minRing, "the same minimums buffer, 128,000 frames later");
  assert.equal(core.maxRing, maxRing, "the same maximums buffer");
  assert.equal(core.frameRing, frameRing, "the same frames buffer");
  const held = core.count;
  assert.equal(held, Math.floor((1000 * BLOCK) / core.colFrames), "the columns that closed are still the ring's own slots");

  // The one allocation is allowed to be the payload `drain()` returns.
  const payload = core.drain();
  assert.ok(payload.cols instanceof Float32Array, "the payload's columns are a Float32Array");
  assert.equal(payload.cols.length, held * 3, "three values per held column");
  assert.equal(core.minRing, minRing, "the ring is the same buffer after a drain");
});

test("a full-scale sine reads peak 1.0 and rms near 0.7071 within 0.01", () => {
  const core = makeCore();
  // 12 kHz at 48 kHz: every fourth sample is exactly ±1.
  core.process(0, sine(4800, 12000), 4800);
  const payload = core.drain();

  assert.ok(Math.abs(payload.peak - 1) <= 0.01, `peak was ${payload.peak}`);
  assert.ok(Math.abs(payload.rms - Math.SQRT1_2) <= 0.01, `rms was ${payload.rms}`);
  assert.equal(payload.frame, 0, "the window starts at the frame it was fed from");
});

test("digital silence reads peak 0, rms 0, no NaN", () => {
  const core = makeCore();
  core.process(0, constant(4800, 0), 4800);
  const payload = core.drain();

  assert.equal(payload.peak, 0, "a window of zeros has no peak");
  assert.equal(payload.rms, 0, "and no power");
  assert.equal(Number.isNaN(payload.rms), false, "and is not NaN");
  assert.equal(Number.isNaN(payload.peak), false, "a zero peak is a zero, not NaN");
  for (let at = 0; at < payload.cols.length; at += 1) {
    assert.equal(Number.isNaN(payload.cols[at]), false, "no NaN in a column of silence");
  }

  // A missing buffer is silence too, the way an unplugged device reads.
  const silent = makeCore();
  silent.process(0, null, 4800);
  const none = silent.drain();
  assert.equal(none.peak, 0, "no samples is no peak");
  assert.equal(none.rms, 0, "no samples is no power");
  assert.equal(none.cols.length, 30, "and columns of zeros still close");
});

test("columns hold the min and max of their colFrames and carry the frame of their first sample", () => {
  const core = makeCore({ colFrames: 10, postFrames: 100, ringCols: 16 });
  const samples = Float32Array.from([
    0.5, -0.5, 0.25, -0.25, 0.125,
    -0.125, 0.75, -0.75, 0.0625, -0.0625,
    0.25, 0.5, -0.5, 0.125, -0.125,
    0.0625, -0.0625, 0.75, -0.75, 0.5,
  ]);
  core.process(1000, samples, samples.length);
  const payload = core.drain();

  assert.equal(payload.cols.length, 6, "two columns of ten frames");
  assert.deepEqual(
    [payload.cols[0], payload.cols[1], payload.cols[2]],
    [1000, -0.75, 0.75],
    "the first column names its own first frame and its extremes",
  );
  assert.deepEqual(
    [payload.cols[3], payload.cols[4], payload.cols[5]],
    [1010, -0.75, 0.75],
    "and the second starts ten frames later",
  );
});

test("drain returns each column once and then none until new ones finish", () => {
  const core = makeCore({ colFrames: 10, postFrames: 100, ringCols: 16 });
  core.process(0, constant(30, 0.5), 30);
  const first = core.drain();
  assert.equal(first.cols.length, 9, "three columns of ten frames");

  const second = core.drain();
  assert.equal(second.cols.length, 0, "a drained core holds nothing to hand over again");
  assert.equal(second.peak, 0, "and its window starts again");

  // A partial column is not a column yet.
  core.process(30, constant(9, 0.5), 9);
  assert.equal(core.drain().cols.length, 0, "nine frames close nothing");
  core.process(39, constant(1, 0.5), 1);
  const third = core.drain();
  assert.equal(third.cols.length, 3, "the tenth frame closes one column");
  assert.equal(third.cols[0], 30, "which starts where the partial column started");
});

test("a 513th column without a drain drops the OLDEST", () => {
  const core = makeCore({ colFrames: 1, postFrames: 100000 });
  const samples = new Float32Array(513);
  for (let at = 0; at < samples.length; at += 1) samples[at] = at / 1024;
  core.process(0, samples, samples.length);

  const payload = core.drain();
  assert.equal(payload.cols.length, 512 * 3, "the ring holds 512 columns, not 513");
  assert.deepEqual(
    [payload.cols[0], payload.cols[1], payload.cols[2]],
    [1, 1 / 1024, 1 / 1024],
    "the column that fell out is the oldest one",
  );
  const last = payload.cols.length - 3;
  assert.deepEqual(
    [payload.cols[last], payload.cols[last + 1], payload.cols[last + 2]],
    [512, 512 / 1024, 512 / 1024],
    "and the newest one is still the last to be handed over",
  );
});

test("a sample of 0.9995 latches clipped until clearClip", () => {
  const core = makeCore();
  core.process(0, constant(1600, 0.5), 1600);
  assert.equal(core.drain().clipped, false, "half scale does not latch CLIP");

  core.process(1600, Float32Array.from([0.9995]), 1);
  assert.equal(core.drain().clipped, true, "0.9995 latches it");
  core.process(1601, constant(1600, 0.5), 1600);
  assert.equal(core.drain().clipped, true, "and a quiet window after it still reads CLIP");

  core.clearClip();
  assert.equal(core.drain().clipped, false, "clearClip lets the latch go");
  core.process(3201, constant(1600, 0.5), 1600);
  assert.equal(core.drain().clipped, false, "and nothing quiet sets it off again");
});

test("NaN and Infinity samples count as 0", () => {
  const core = makeCore({ colFrames: 4, postFrames: 100 });
  core.process(0, Float32Array.from([NaN, Infinity, -Infinity, 0.5]), 4);
  const payload = core.drain();

  assert.equal(payload.peak, 0.5, "the finite sample is the whole peak");
  assert.equal(payload.rms, Math.sqrt(0.25 / 4), "the other three carry no power");
  assert.equal(payload.clipped, false, "and an infinity does not latch CLIP");
  assert.equal(payload.cols.length, 3, "the column still closed");
  assert.deepEqual([payload.cols[1], payload.cols[2]], [0, 0.5], "min and max of the column, as zeros and the real sample");

  // A short block reads the rest of its frames as silence, and never past its end.
  const short = makeCore({ colFrames: 4, postFrames: 100 });
  short.process(0, Float32Array.from([0.25]), 4);
  const padded = short.drain();
  assert.equal(padded.peak, 0.25, "one real sample and three zeros");
  assert.deepEqual([padded.cols[1], padded.cols[2]], [0, 0.25], "the zeros are in the column");
});

test("process returns true about every postFrames and false between", () => {
  const core = makeCore({ postFrames: 1000 });
  const block = constant(BLOCK, 0.5);
  const due = [];
  let frame = 0;
  for (let index = 0; index < 20; index += 1) {
    const isDue = core.process(frame, block, BLOCK);
    due.push(isDue);
    if (isDue) core.drain();
    frame += BLOCK;
  }

  assert.deepEqual(
    due.slice(0, 8),
    [false, false, false, false, false, false, false, true],
    "the eighth 128-frame block carries the thousandth frame",
  );
  assert.deepEqual(
    due.slice(8, 16),
    [false, false, false, false, false, false, false, true],
    "and it comes due again about a thousand frames later",
  );
  assert.equal(core.postDue, false, "draining clears the flag");

  // One call that spans several posts is still one post waiting.
  const wide = makeCore({ postFrames: 1000 });
  assert.equal(wide.process(0, constant(3500, 0.5), 3500), true, "three and a half windows are due");
  assert.equal(wide.drain().rms, 0.5, "and the payload covers every frame fed");
});

test("the file evaluates as a classic script and as require()", async () => {
  // The way the worklet gets it: one module, no `module`, no imports.
  const vm = await import("node:vm");
  assert.equal(/^\s*(import|export)\b/m.test(SOURCE), false, "a classic script has no import or export statement");

  const scope = { console: { log() {}, warn() {}, error() {} } };
  vm.createContext(scope);
  vm.runInContext(SOURCE, scope, { filename: "input-level.js" });
  const fromScript = scope.StudioInputLevel;
  assert.ok(fromScript, "the classic script defines globalThis.StudioInputLevel");

  // The way a Node caller gets it (the same file the worklet loads).
  assert.ok(StudioInputLevel, "require() hands back the same api");
  assert.equal(fromScript.DEFAULT_RATE, StudioInputLevel.DEFAULT_RATE);
  assert.equal(fromScript.DEFAULT_RING_COLS, StudioInputLevel.DEFAULT_RING_COLS);
  assert.equal(fromScript.CLIP_LEVEL, StudioInputLevel.CLIP_LEVEL);

  // And both copies read the same audio the same way.
  const core = new fromScript.InputLevelCore({ sampleRate: RATE });
  core.process(0, constant(480, 0.5), 480);
  const payload = core.drain();
  assert.equal(payload.cols.length, 3, "one 10 ms column");
  assert.deepEqual([payload.peak, payload.rms], [0.5, 0.5], "a constant half-scale block");
  assert.equal(payload.frame, 0, "the window starts at its first frame");
});