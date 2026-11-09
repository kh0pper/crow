/**
 * Crow's own dynamics — the compressor, the limiter, the gate and the de-esser.
 *
 * `engine/dynamics.js` is a classic script (no `import`/`export`), so this file
 * requires it exactly as `engine-client.js` will hand it to the worklet and
 * exactly as Node runs it in a render: one insert, one 128-frame block at a
 * time. Nothing here touches a document, a browser or an audio host.
 *
 * Three things are pinned beyond the plan's five tests:
 *
 * - **The parameter table.** A worklet cannot import `server/doc.js`, so the
 *   four kinds' ranges are duplicated in `dynamics.js`. The duplicates are
 *   compared to the document's copy here: a range can never be widened in one
 *   place and left behind in the other.
 * - **The true-peak filter.** The master limiter must measure a peak the way
 *   the render's own measurement does (`truePeakDb` in `server/loudness.js`),
 *   so its 4× polyphase filter is a copy of that construction and the two meters
 *   are compared on the same audio here.
 * - **No allocation and no NaN.** Every insert is driven with every parameter at
 *   both ends of its range over a full-scale sine and over silence, with typed
 *   arrays and `Math.random` counted while it runs: `process()` may make
 *   neither, and may hand back nothing but finite samples.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The document's copy of the parameter table, and the render's true-peak meter:
// the two things `engine/dynamics.js` has to agree with.
import { EFFECT_PARAMS } from "../bundles/studio/server/doc.js";
import { truePeakDb } from "../bundles/studio/server/loudness.js";

const ENGINE_DIR = fileURLToPath(new URL("../bundles/studio/engine/", import.meta.url));

// The bundle's own resolution, from inside the bundle (that is where the
// package's `"commonjs"` override for `engine/` applies).
const bundleRequire = createRequire(join(ENGINE_DIR, "x.js"));
const StudioDynamics = bundleRequire(join(ENGINE_DIR, "dynamics.js"));

const SAMPLE_RATE = 48000;
const BLOCK = 128;
const KINDS = ["compressor", "limiter", "gate", "deesser"];

/** @returns {number} an amplitude as a level in dB. */
function dbOf(amplitude) {
  return amplitude > 0 ? 20 * Math.log10(amplitude) : -Infinity;
}

/** @returns {number} a level in dB as an amplitude. */
function amplitudeOf(db) {
  return Math.pow(10, db / 20);
}

/** @returns {number} how many frames a number of seconds is. */
function framesOf(seconds) {
  return Math.round(SAMPLE_RATE * seconds);
}

/**
 * A stereo sine, the right channel a little behind the left.
 * @param {number} frames
 * @param {number} hz
 * @param {number} amplitude
 * @returns {{left: Float32Array, right: Float32Array, frames: number}}
 */
function tone(frames, hz, amplitude) {
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  const step = (2 * Math.PI * hz) / SAMPLE_RATE;
  for (let at = 0; at < frames; at += 1) {
    left[at] = amplitude * Math.sin(step * at);
    right[at] = amplitude * Math.sin(step * at + 0.6);
  }
  return { left: left, right: right, frames: frames };
}

/** @returns {{left: Float32Array, right: Float32Array, frames: number}} silence. */
function silence(frames) {
  return { left: new Float32Array(frames), right: new Float32Array(frames), frames: frames };
}

/**
 * The largest magnitude of one channel, from a frame on.
 * @param {Float32Array} samples
 * @param {number} [from] the first frame counted
 * @returns {number}
 */
function peakOf(samples, from) {
  let peak = 0;
  const start = Math.max(0, Math.trunc(from || 0));
  for (let at = start; at < samples.length; at += 1) {
    const value = Math.abs(samples[at]);
    if (!(value <= peak)) peak = value;
  }
  return peak;
}

/**
 * Drive one insert over a whole signal, one 128-frame block at a time, the way
 * the processor does: copy the block in, process it in place, copy it out.
 * @param {object} insert
 * @param {{left: Float32Array, right: Float32Array, frames: number}} signal
 * @param {{left: Float32Array, right: Float32Array}|null} [sidechain]
 * @returns {{left: Float32Array, right: Float32Array, frames: number}}
 */
function render(insert, signal, sidechain) {
  const frames = signal.frames;
  const outLeft = new Float32Array(frames);
  const outRight = new Float32Array(frames);
  for (let at = 0; at < frames; at += BLOCK) {
    const count = Math.min(BLOCK, frames - at);
    const left = new Float32Array(count);
    const right = new Float32Array(count);
    for (let index = 0; index < count; index += 1) {
      left[index] = signal.left[at + index];
      right[index] = signal.right[at + index];
    }
    let sidechainLeft = null;
    let sidechainRight = null;
    if (sidechain) {
      sidechainLeft = new Float32Array(count);
      sidechainRight = new Float32Array(count);
      for (let index = 0; index < count; index += 1) {
        sidechainLeft[index] = sidechain.left[at + index];
        sidechainRight[index] = sidechain.right[at + index];
      }
    }
    insert.process(left, right, count, sidechainLeft, sidechainRight);
    for (let index = 0; index < count; index += 1) {
      outLeft[at + index] = left[index];
      outRight[at + index] = right[index];
    }
  }
  return { left: outLeft, right: outRight, frames: frames };
}

// --- the plan's five tests -------------------------------------------------

test("the compressor reaches its ratio on a steady tone", () => {
  // Both tones sit above the threshold, so both are compressed; the level 12 dB
  // higher is 12 dB over the threshold while the other is only 12 dB over it, so
  // a ratio of 4 puts them 12 / 4 = 3 dB apart instead of 12.
  const settings = {
    detect: "peak",
    threshold_db: -30,
    ratio: 4,
    knee_db: 0,
    attack_ms: 0.1,
    release_ms: 500,
    makeup_db: 0,
    sidechain_hp_hz: 0,
  };
  const frames = framesOf(1.5);
  const from = frames - framesOf(0.2);

  /** @returns {number} the level of a tone's last fifth of a second, after the insert. */
  function levelOut(amplitude) {
    const insert = StudioDynamics.create("compressor", SAMPLE_RATE);
    insert.setParams(settings);
    const rendered = render(insert, tone(frames, 100, amplitude));
    return dbOf(peakOf(rendered.left, from));
  }

  const loudIn = dbOf(0.5); // -6.0 dBFS: 24 dB over the threshold
  const quietIn = dbOf(0.125); // -18.1 dBFS: 12 dB over it
  const loudOut = levelOut(0.5);
  const quietOut = levelOut(0.125);

  assert.ok(
    Math.abs(loudOut - (loudIn - 18)) < 0.6,
    `a 24 dB overload at 4:1 has to come out 18 dB down, it came out ${(loudOut - loudIn).toFixed(2)} dB`,
  );
  assert.ok(
    Math.abs(quietOut - (quietIn - 9)) < 0.6,
    `a 12 dB overload at 4:1 has to come out 9 dB down, it came out ${(quietOut - quietIn).toFixed(2)} dB`,
  );
  assert.ok(
    Math.abs(loudOut - quietOut - 3) < 0.5,
    `12 dB more in has to be 12/4 = 3 dB more out, it is ${(loudOut - quietOut).toFixed(2)} dB`,
  );
});

test("an external sidechain replaces the compressor's detector input", () => {
  // The audio is under the threshold, so on its own it is left alone; a sidechain
  // pair is 34 dB louder, so the detector asks for the same gain from that.
  const settings = {
    detect: "peak",
    threshold_db: -30,
    ratio: 4,
    knee_db: 0,
    attack_ms: 0.1,
    release_ms: 500,
    makeup_db: 0,
    sidechain_hp_hz: 0,
  };
  const frames = framesOf(1);
  const from = frames - framesOf(0.2);
  const audio = tone(frames, 100, 0.01); // -40 dBFS
  const key = tone(frames, 100, 0.5); // -6 dBFS

  const plain = StudioDynamics.create("compressor", SAMPLE_RATE);
  plain.setParams(settings);
  const alone = dbOf(peakOf(render(plain, audio).left, from));

  const keyed = StudioDynamics.create("compressor", SAMPLE_RATE);
  keyed.setParams(settings);
  const ducked = dbOf(peakOf(render(keyed, audio, key).left, from));

  assert.ok(Math.abs(alone - dbOf(0.01)) < 0.3, `with no sidechain the quiet audio is untouched, it reads ${alone} dB`);
  assert.ok(
    Math.abs(ducked - (dbOf(0.01) - 18)) < 0.6,
    `with the sidechain keying it the audio has to come out 18 dB down, it came out ${(ducked - dbOf(0.01)).toFixed(2)} dB`,
  );
});

test("the master limiter never passes its ceiling, measured with loudness.js's true peak", () => {
  // +12 dB hot, and square-ish rather than square: the flat tops carry the
  // harmonics that make a converter's reconstruction filter overshoot, which is
  // exactly what a true-peak detector exists to see.
  const frames = framesOf(2);
  const hot = { left: new Float32Array(frames), right: new Float32Array(frames), frames: frames };
  for (let at = 0; at < frames; at += 1) {
    const t = at / SAMPLE_RATE;
    hot.left[at] = 4 * Math.tanh(4 * Math.sin(2 * Math.PI * 221 * t) + 0.3 * Math.sin(2 * Math.PI * 3701 * t));
    hot.right[at] = 4 * Math.tanh(4 * Math.sin(2 * Math.PI * 227 * t + 0.4) + 0.3 * Math.sin(2 * Math.PI * 3301 * t));
  }

  const inputTruePeak = truePeakDb(hot.left, hot.right, SAMPLE_RATE);
  assert.ok(inputTruePeak > 6, `the signal has to be well over full scale, its true peak is ${inputTruePeak} dBTP`);

  // The limiter's own meter and the render's meter are the same filter: on this
  // signal they have to agree to the last bit's worth of rounding.
  const limiterMeter = StudioDynamics.truePeakDb(hot.left, hot.right, frames);
  assert.ok(
    Math.abs(limiterMeter - inputTruePeak) < 1e-9,
    `the limiter must measure peaks with the render's filter, ${limiterMeter} dBTP against ${inputTruePeak} dBTP`,
  );

  for (const ceilingDb of [-1, -6, -0.1]) {
    const insert = StudioDynamics.create("limiter", SAMPLE_RATE, { master: true });
    insert.setParams({ ceiling_db: ceilingDb, release_ms: 50 });
    const rendered = render(insert, hot);
    const outTruePeak = truePeakDb(rendered.left, rendered.right, SAMPLE_RATE);
    assert.ok(
      outTruePeak <= ceilingDb + 0.05,
      `a ${ceilingDb} dBTP ceiling has to hold, the output's true peak is ${outTruePeak} dBTP`,
    );
    assert.ok(
      outTruePeak >= ceilingDb - 1,
      `the limiter has to reach its ceiling, not mute the song: ${outTruePeak} dBTP against ${ceilingDb}`,
    );
    // And the samples themselves are inside the ceiling too.
    assert.ok(
      peakOf(rendered.left) <= amplitudeOf(ceilingDb) && peakOf(rendered.right) <= amplitudeOf(ceilingDb),
      `no sample of a limited signal may sit above ${ceilingDb} dBFS`,
    );
  }
});

test("the gate closes below threshold and opens with hysteresis", () => {
  const settings = {
    threshold_db: -40,
    hysteresis_db: 6, // so it only closes below -46 dB
    attack_ms: 0.5,
    hold_ms: 20,
    release_ms: 20,
    range_db: -80,
  };
  const betweenDb = -43; // above the closing threshold, below the opening one
  const between = amplitudeOf(betweenDb);

  // A gate that has never opened stays shut at a level under its threshold.
  const cold = StudioDynamics.create("gate", SAMPLE_RATE);
  cold.setParams(settings);
  const never = render(cold, tone(framesOf(0.5), 200, between));
  assert.ok(
    peakOf(never.left) < 1e-4,
    `a closed gate holds a -43 dBFS tone 80 dB down, it passed ${dbOf(peakOf(never.left))} dBFS`,
  );

  // Opened by a loud passage, the same level is inside the hysteresis band and
  // passes.
  const warm = StudioDynamics.create("gate", SAMPLE_RATE);
  warm.setParams(settings);
  const opened = render(warm, tone(framesOf(0.3), 200, 0.1)); // -20 dBFS: wide open
  assert.ok(
    peakOf(opened.left, opened.frames - framesOf(0.05)) > 0.05,
    "a -20 dBFS tone has to open the gate",
  );
  const held = render(warm, tone(framesOf(0.4), 200, between));
  assert.ok(
    peakOf(held.left, framesOf(0.1)) > between * 0.5,
    `an open gate stays open at -43 dBFS (its hysteresis ends at -46), it reads ${dbOf(peakOf(held.left, framesOf(0.1)))} dBFS`,
  );

  // And below the closing threshold it shuts, after its hold and its release.
  const shut = render(warm, tone(framesOf(0.6), 200, amplitudeOf(-55)));
  assert.ok(
    peakOf(shut.left, framesOf(0.4)) < 1e-4,
    `a -55 dBFS tone is under -46 dBFS, so the gate closes; it reads ${dbOf(peakOf(shut.left, framesOf(0.4)))} dBFS`,
  );
});

test("the de-esser cuts sibilance but not a 1 kHz tone", () => {
  const settings = { freq_hz: 6500, threshold_db: -30, ratio: 6 };
  const frames = framesOf(0.6);
  const from = frames - framesOf(0.2);

  // Sibilance: 7 kHz, right in the band the detector listens to.
  const sibilant = tone(frames, 7000, 0.5);
  const desser = StudioDynamics.create("deesser", SAMPLE_RATE);
  desser.setParams(settings);
  const cut = render(desser, sibilant);
  const reduction = dbOf(peakOf(cut.left, from)) - dbOf(peakOf(sibilant.left, from));
  assert.ok(reduction < -6, `7 kHz has to be held down, it changed by ${reduction.toFixed(2)} dB`);

  // A 1 kHz tone lives under the crossover, so the reduction can only reach the
  // sliver of it in the high band: its level has to keep its shape.
  const low = tone(frames, 1000, 0.5);
  const flat = StudioDynamics.create("deesser", SAMPLE_RATE);
  flat.setParams(settings);
  const passed = render(flat, low);
  const moved = dbOf(peakOf(passed.left, from)) - dbOf(peakOf(low.left, from));
  assert.ok(Math.abs(moved) < 0.5, `a 1 kHz tone has to stay where it is, it moved by ${moved.toFixed(2)} dB`);

  // And with no reduction the split is transparent: the high band is the input
  // minus the low one, so the two add straight back up to the input.
  const quiet = tone(frames, 1000, 0.1); // under the threshold, so nothing reduces
  const clear = StudioDynamics.create("deesser", SAMPLE_RATE);
  clear.setParams(settings);
  const untouched = render(clear, quiet);
  let worst = 0;
  for (let at = 0; at < frames; at += 1) {
    worst = Math.max(
      worst,
      Math.abs(untouched.left[at] - quiet.left[at]),
      Math.abs(untouched.right[at] - quiet.right[at]),
    );
  }
  assert.ok(worst < 1e-6, `with no reduction the de-esser has to be the input again, it moved by ${worst}`);
});

test("track inserts add no latency", () => {
  // An impulse on the first frame of a block: a zero-latency insert has to let
  // it out on the first frame of its own output.
  for (const kind of KINDS) {
    const insert = StudioDynamics.create(kind, SAMPLE_RATE);
    assert.equal(insert.latencyFrames, 0, `a ${kind} on a track may not delay it`);

    const impulse = silence(BLOCK);
    impulse.left[0] = 0.5;
    impulse.right[0] = 0.5;
    const rendered = render(insert, impulse);
    assert.notEqual(rendered.left[0], 0, `a ${kind} on a track has to answer on the frame it was given`);
    assert.equal(peakOf(rendered.left), Math.abs(rendered.left[0]), `a ${kind} may not smear an impulse later`);
  }

  // The master limiter is the one insert that may delay: its lookahead.
  const master = StudioDynamics.create("limiter", SAMPLE_RATE, { master: true });
  assert.equal(master.latencyFrames, Math.round(0.0015 * SAMPLE_RATE));
  assert.ok(master.latencyFrames > 0, "the master limiter's lookahead has to be real");
});

// --- the rulings' own tests ------------------------------------------------

test("the master limiter's latency is 1.5 ms", () => {
  for (const rate of [44100, 48000, 88200, 96000]) {
    const insert = StudioDynamics.create("limiter", rate, { master: true });
    assert.equal(insert.latencyFrames, Math.round(0.0015 * rate), `at ${rate} Hz the lookahead is `);
  }
  // And it really delays by that much: an impulse comes out that many frames later.
  const insert = StudioDynamics.create("limiter", SAMPLE_RATE, { master: true });
  const delay = insert.latencyFrames;
  const impulse = silence(delay + BLOCK);
  impulse.left[0] = 0.5;
  impulse.right[0] = 0.5;
  const rendered = render(insert, impulse);
  for (let at = 0; at < delay; at += 1) {
    assert.equal(rendered.left[at], 0, `the master limiter may not answer before its lookahead is through (frame ${at})`);
  }
  assert.ok(Math.abs(rendered.left[delay] - 0.5) < 1e-6, "the impulse comes out exactly one lookahead later, in full");
  assert.equal(peakOf(rendered.left, delay + 1), 0, "and nothing of it is left behind");

  // A limiter that is NOT on the master is the zero-latency clipper: it answers
  // on the frame it was given, and it holds the ceiling there.
  const track = StudioDynamics.create("limiter", SAMPLE_RATE);
  assert.equal(track.latencyFrames, 0);
  const passed = render(track, impulse);
  assert.ok(Math.abs(passed.left[0] - 0.5) < 1e-6, "a track limiter passes what is under its ceiling on the frame itself");
  assert.equal(peakOf(passed.left, 1), 0, "and adds nothing after it");

  const loud = silence(BLOCK);
  loud.left[0] = 2;
  loud.right[0] = 2;
  const clipped = render(track, loud);
  assert.ok(
    Math.abs(clipped.left[0] - amplitudeOf(-1)) < 1e-6,
    `a track limiter clips at its ceiling on the frame itself, it reads ${clipped.left[0]}`,
  );
});

test("the dynamics param table matches the document's", () => {
  // The worklet cannot import `server/doc.js`, so the four kinds' ranges are
  // duplicated in `dynamics.js` — and may never drift from the document's copy.
  assert.deepEqual([...StudioDynamics.KINDS], KINDS);
  assert.deepEqual(Object.keys(StudioDynamics.PARAMS), KINDS);
  for (const kind of KINDS) {
    assert.ok(EFFECT_PARAMS[kind], `the document has to know the ${kind}`);
    assert.deepEqual(
      StudioDynamics.PARAMS[kind],
      EFFECT_PARAMS[kind],
      `the engine's ${kind} table has to be the document's, field for field`,
    );
  }
  assert.ok(Object.isFrozen(StudioDynamics.PARAMS), "the table is shared, so it has to be frozen");
  assert.ok(Object.isFrozen(StudioDynamics.KINDS), "the kind list is shared, so it has to be frozen");
});

test("no dynamics insert allocates or produces NaN at its parameter extremes", () => {
  // Every insert, every parameter at both ends of its range, over a full-scale
  // sine and over silence. Each run's blocks are made BEFORE the counters go on,
  // so anything they see is the insert's own doing.
  const sineFrames = BLOCK * 6;
  const quietFrames = BLOCK * 2;
  const cases = [];

  for (const kind of KINDS) {
    // A limiter is both a master limiter and a track clipper, and the two run
    // different code; every other kind has one shape.
    const masters = kind === "limiter" ? [false, true] : [false];
    for (const master of masters) {
      for (const [name, field] of Object.entries(StudioDynamics.PARAMS[kind].params)) {
        const values = field.values ? field.values : [field.min, field.max];
        for (const value of values) {
          const insert = StudioDynamics.create(kind, SAMPLE_RATE, { master: master });
          insert.setParams({ [name]: value });
          const sine = tone(sineFrames, 440, 1);
          const quiet = silence(quietFrames);
          cases.push({
            label: `${kind}${master ? " (master)" : ""} with ${name} = ${value}`,
            insert: insert,
            sine: blocksFor(insert, sine, true),
            quiet: blocksFor(insert, quiet, false),
          });
        }
      }
    }
  }

  const counters = countAllocations(() => {
    for (const one of cases) {
      for (const pass of [one.sine, one.quiet]) {
        one.insert.reset();
        for (const block of pass.blocks) {
          one.insert.process(block.left, block.right, block.frames, block.sidechainLeft, block.sidechainRight);
          for (let index = 0; index < block.frames; index += 1) {
            const left = block.left[index];
            const right = block.right[index];
            assert.ok(Number.isFinite(left), `${one.label} produced ${left} on a sample`);
            assert.ok(Number.isFinite(right), `${one.label} produced ${right} on a sample`);
          }
        }
      }
    }
  });

  assert.equal(counters.typedArrays, 0, "process() may not make a typed array");
  assert.equal(counters.random, 0, "no insert may call Math.random");

  /**
   * One signal as the block list `process()` is driven with: fresh buffers per
   * case, and a sidechain pair for the compressor so the external key's path is
   * covered too.
   * @param {object} insert
   * @param {{left: Float32Array, right: Float32Array, frames: number}} signal
   * @param {boolean} sidechain whether to give the compressor a key
   * @returns {{blocks: object[]}}
   */
  function blocksFor(insert, signal, sidechain) {
    const keyed = sidechain && insert.kind === "compressor";
    const blocks = [];
    for (let at = 0; at < signal.frames; at += BLOCK) {
      const count = Math.min(BLOCK, signal.frames - at);
      const left = new Float32Array(count);
      const right = new Float32Array(count);
      for (let index = 0; index < count; index += 1) {
        left[index] = signal.left[at + index];
        right[index] = signal.right[at + index];
      }
      blocks.push({
        left: left,
        right: right,
        frames: count,
        sidechainLeft: keyed ? left.slice() : null,
        sidechainRight: keyed ? right.slice() : null,
      });
    }
    return { blocks: blocks };
  }
});

/**
 * Run something with typed arrays and `Math.random` counted.
 * @param {function(): void} run
 * @returns {{typedArrays: number, random: number}}
 */
function countAllocations(run) {
  const RealFloat32Array = globalThis.Float32Array;
  const RealFloat64Array = globalThis.Float64Array;
  const realRandom = Math.random;
  let typedArrays = 0;
  let random = 0;

  function CountingFloat32Array(...args) {
    typedArrays += 1;
    return new RealFloat32Array(...args);
  }
  CountingFloat32Array.prototype = RealFloat32Array.prototype;
  function CountingFloat64Array(...args) {
    typedArrays += 1;
    return new RealFloat64Array(...args);
  }
  CountingFloat64Array.prototype = RealFloat64Array.prototype;

  globalThis.Float32Array = CountingFloat32Array;
  globalThis.Float64Array = CountingFloat64Array;
  Math.random = function countedRandom() {
    random += 1;
    return realRandom();
  };
  try {
    run();
  } finally {
    globalThis.Float32Array = RealFloat32Array;
    globalThis.Float64Array = RealFloat64Array;
    Math.random = realRandom;
  }
  return { typedArrays: typedArrays, random: random };
}