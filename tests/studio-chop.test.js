/**
 * Studio chop — transient detection and grid slicing.
 *
 * The signals here are built from a seeded xorshift PRNG, never `Math.random`
 * (the DSP rule), so the same loop is analysed on every host and the expected
 * onsets are exact sample positions rather than a guess. A "hit" is a short
 * decaying noise burst over low-level noise, which is what a drum loop's attack
 * looks like to a spectral-flux detector; the hits are placed at known frames
 * and the slices have to start within 5 ms of them.
 *
 * `chop.js` is a classic script, so it is loaded the way a Node caller loads it:
 * `require()` from inside the bundle, where `engine/package.json` marks the
 * directory CommonJS. That is the same file the worker `importScripts`es.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ENGINE_DIR = fileURLToPath(new URL("../bundles/studio/engine/", import.meta.url));
const bundleRequire = createRequire(join(ENGINE_DIR, "x.js"));
const StudioChop = bundleRequire(join(ENGINE_DIR, "chop.js"));

const RATE = 48000;
/** Samples per millisecond at `RATE`. */
const MS = RATE / 1000;
/** The tolerance a detected onset is allowed, in samples (5 ms). */
const TOLERANCE = 5 * MS;

/**
 * A seeded mulberry32: the test's only noise source, so a run is repeatable.
 * (Uniform white noise needs a generator with decent spectral behaviour;
 * xorshift's consecutive values are correlated enough to show up in the flux.)
 * @param {number} seed any integer
 * @returns {() => number} the next value in [0, 1)
 */
function seededRandom(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build a stereo loop of decaying noise bursts over a low-level noise floor.
 *
 * Each hit starts with a short linear attack (its "click") and decays with a
 * time constant, which is the shape a drum attack has and the shape a
 * spectral-flux detector is looking for; it fades out over its last few
 * milliseconds rather than stopping on a step, since a hard cut is itself a
 * broadband click. The two channels are seeded separately, so the mono mix
 * really is an average and not one copied channel.
 *
 * @param {object} settings
 * @param {number[]} settings.levels each hit's peak level, in order
 * @param {number} settings.spacingMs the gap between hit starts
 * @param {number} [settings.leadMs] silence before the first hit
 * @param {number} [settings.decayMs] the burst's decay time constant
 * @param {number} [settings.burstMs] how long a burst rings for
 * @param {number} [settings.noiseLevel] the noise floor between hits
 * @param {number} [settings.seed] the PRNG seed
 * @returns {{channels: Float32Array[], rate: number, starts: number[]}} the
 *   loop, and the exact frame each hit starts on
 */
function clickLoop(settings) {
  const {
    levels,
    spacingMs,
    leadMs = 20,
    decayMs = 40,
    burstMs = 120,
    noiseLevel = 0.003,
    seed = 20261104,
  } = settings;
  const starts = levels.map((_, index) => Math.round(leadMs * MS + index * spacingMs * MS));
  const last = starts.length === 0 ? 0 : starts[starts.length - 1];
  const frames = last + Math.round(burstMs * MS) + Math.round(20 * MS);
  const channels = [new Float32Array(frames), new Float32Array(frames)];
  const burstFrames = Math.round(burstMs * MS);
  const attackFrames = Math.max(1, Math.round(1.5 * MS));
  const releaseFrames = Math.max(1, Math.round(5 * MS));
  for (let channel = 0; channel < channels.length; channel += 1) {
    const data = channels[channel];
    const random = seededRandom(seed + channel * 7919);
    for (let at = 0; at < frames; at += 1) data[at] = (random() * 2 - 1) * noiseLevel;
    for (let hit = 0; hit < starts.length; hit += 1) {
      const start = starts[hit];
      for (let at = 0; at < burstFrames; at += 1) {
        const attack = at < attackFrames ? at / attackFrames : 1;
        const release = at > burstFrames - releaseFrames ? (burstFrames - at) / releaseFrames : 1;
        const envelope = attack * release * Math.exp(-at / (decayMs * MS));
        data[start + at] += (random() * 2 - 1) * levels[hit] * envelope;
      }
    }
  }
  return { channels: channels, rate: RATE, starts: starts };
}

/** @returns {{start_frame: number, end_frame: number}[]} the slices that follow a lead-in */
function afterLeadIn(slices) {
  return slices[0] && slices[0].start_frame === 0 && slices.length > 1 ? slices.slice(1) : slices;
}

test("byHits finds 8 clicks in a synthetic 8-hit loop within 5 ms", () => {
  const loop = clickLoop({ levels: new Array(8).fill(0.8), spacingMs: 250, decayMs: 40 });
  const slices = StudioChop.byHits(loop.channels, loop.rate);

  assert.equal(slices[0].start_frame, 0, "the audio before the first hit is a slice too");
  const found = afterLeadIn(slices).map((slice) => slice.start_frame);
  assert.equal(found.length, 8, `expected 8 hits, found ${found.length}`);
  for (let hit = 0; hit < 8; hit += 1) {
    const offset = Math.abs(found[hit] - loop.starts[hit]);
    assert.ok(
      offset <= TOLERANCE,
      `hit ${hit} is at ${loop.starts[hit]}, found at ${found[hit]} (${offset} frames off)`,
    );
  }

  // The slices tile the sample: each one ends where the next begins, the last
  // at the end of the audio, so no audio is lost and none is repeated.
  for (let index = 1; index < slices.length; index += 1) {
    assert.equal(slices[index].start_frame, slices[index - 1].end_frame);
  }
  assert.equal(slices[slices.length - 1].end_frame, loop.channels[0].length);
});

test("byHits finds nothing in silence", () => {
  const silent = [new Float32Array(RATE), new Float32Array(RATE)];
  assert.deepEqual(StudioChop.byHits(silent, RATE), []);

  // -60 dBFS is the floor: a signal under it is silent too, whatever its shape.
  const quiet = [new Float32Array(RATE)];
  for (let at = 0; at < quiet[0].length; at += 97) quiet[0][at] = 0.0005;
  assert.deepEqual(StudioChop.byHits(quiet, RATE), []);
});

test("byGrid makes equal slices that tile the sample", () => {
  const frames = 48000;
  for (const divisions of [2, 4, 8, 16, 32, 64]) {
    const slices = StudioChop.byGrid(frames, divisions);
    assert.equal(slices.length, divisions);
    assert.equal(slices[0].start_frame, 0);
    assert.equal(slices[slices.length - 1].end_frame, frames);
    for (let index = 0; index < slices.length; index += 1) {
      assert.equal(slices[index].end_frame - slices[index].start_frame, frames / divisions);
      if (index > 0) assert.equal(slices[index].start_frame, slices[index - 1].end_frame);
    }
  }

  // A length that does not divide evenly: the first slices are equal and the
  // last absorbs the remainder, so the pieces still tile [0, frames).
  assert.deepEqual(StudioChop.byGrid(1001, 4), [
    { start_frame: 0, end_frame: 250 },
    { start_frame: 250, end_frame: 500 },
    { start_frame: 500, end_frame: 750 },
    { start_frame: 750, end_frame: 1001 },
  ]);

  assert.throws(() => StudioChop.byGrid(frames, 3), /2, 4, 8, 16, 32 or 64/);
});

test("more than 64 hits are capped at 64", () => {
  const loop = clickLoop({
    levels: new Array(70).fill(0.8),
    spacingMs: 120,
    decayMs: 25,
    burstMs: 60,
  });
  const slices = StudioChop.byHits(loop.channels, loop.rate);

  assert.equal(slices.length, StudioChop.MAX_SLICES, `expected 64 slices, got ${slices.length}`);
  for (let index = 0; index < slices.length; index += 1) {
    assert.ok(
      slices[index].end_frame > slices[index].start_frame,
      `slice ${index} is empty: ${slices[index].start_frame}…${slices[index].end_frame}`,
    );
    if (index > 0) {
      assert.ok(
        slices[index].start_frame > slices[index - 1].start_frame,
        `slice ${index} does not follow slice ${index - 1}`,
      );
      assert.equal(slices[index].start_frame, slices[index - 1].end_frame);
    }
  }
  assert.equal(slices[slices.length - 1].end_frame, loop.channels[0].length);
});

test("higher sensitivity finds at least as many hits", () => {
  const levels = [0.8, 0.02, 0.8, 0.02, 0.8, 0.02, 0.8, 0.02];
  const loop = clickLoop({ levels: levels, spacingMs: 250, decayMs: 30, noiseLevel: 0.004 });
  const low = StudioChop.byHits(loop.channels, loop.rate, { sensitivity: 0 });
  const high = StudioChop.byHits(loop.channels, loop.rate, { sensitivity: 1 });
  assert.ok(
    high.length >= low.length,
    `sensitivity 1 found ${high.length} slices and sensitivity 0 found ${low.length}`,
  );
  assert.ok(high.length >= 1, "the loud hits are found at either setting");
});

test("byHits is deterministic (same input → same slices)", () => {
  const loop = clickLoop({ levels: new Array(6).fill(0.7), spacingMs: 200 });
  const first = StudioChop.byHits(loop.channels, loop.rate);
  const second = StudioChop.byHits(
    loop.channels.map((channel) => Float32Array.from(channel)),
    loop.rate,
  );
  assert.deepEqual(second, first);
  assert.ok(first.length > 1, "the loop is actually chopped, not empty");
});
test("a very short loud sample is one slice", () => {
  const frames = 255;
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) mono[i] = Math.sin(i / 3) * 0.8;
  const slices = StudioChop.byHits([mono], 48000, {});
  assert.deepEqual(slices, [{ start_frame: 0, end_frame: frames }]);
});
