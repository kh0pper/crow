/**
 * Crow's own dynamics — the compressor, the limiter, the gate and the de-esser.
 *
 * `engine/dynamics.js` is a classic script (no `import`/`export`), so this file
 * requires it exactly as `engine-client.js` will hand it to the worklet and
 * exactly as Node runs it in a render: one insert, one 128-frame block at a
 * time. Nothing here touches a document, a browser or an audio host.
 *
 * What is pinned beyond the plan's five tests:
 *
 * - **The parameter table.** A worklet cannot import `server/doc.js`, so the
 *   four kinds' ranges are duplicated in `dynamics.js`. The duplicates are
 *   compared to the document's copy here: a range can never be widened in one
 *   place and left behind in the other.
 * - **The true-peak filter.** The master limiter must measure a peak the way
 *   the render's own measurement does (`truePeakDb` in `server/loudness.js`),
 *   so its 4× polyphase filter is a copy of that construction and the two meters
 *   are compared on the same audio here.
 * - **No state a sample can poison.** Every insert is fed NaN and ±Infinity and
 *   then a steady tone, and has to come back to exactly what a freshly reset
 *   insert does with that tone — a NaN in a biquad or in the RMS sum would
 *   otherwise stay there for the rest of the session.
 * - **No allocation and no NaN.** Every insert is driven with every parameter at
 *   both ends of its range — one at a time and all at once — over a full-scale
 *   sine and over silence, with typed arrays and `Math.random` counted while it
 *   runs (that counter is the allocation guard), and then for a long stretch with
 *   the heap measured, which catches what is KEPT rather than what is garbage.
 *   `process()` may make neither, and may hand back nothing but finite samples.
 * - **The shapes, not just the levels.** The soft knee, the rms detector, the
 *   master limiter's gain ramp into a peak and across rising crests, the gate's
 *   hold, its smoothed detector and its own `state`/`gain` (read off frame by
 *   frame, which is the only honest way to catch it chattering), and `reset()`
 *   are each checked for what they are supposed to do, at 44100, 48000 and
 *   96000 Hz where the rate can matter.
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

/** The rates a track, a render and a master can run at. */
const RATES = [44100, 48000, 96000];

/** @returns {number} an amplitude as a level in dB. */
function dbOf(amplitude) {
  return amplitude > 0 ? 20 * Math.log10(amplitude) : -Infinity;
}

/** @returns {number} a level in dB as an amplitude. */
function amplitudeOf(db) {
  return Math.pow(10, db / 20);
}

/** @returns {number} how many frames a number of seconds is, at a rate. */
function framesAt(rate, seconds) {
  return Math.round(rate * seconds);
}

/** @returns {number} how many frames a number of seconds is at the default rate. */
function framesOf(seconds) {
  return framesAt(SAMPLE_RATE, seconds);
}

/**
 * The largest sample a limiter at `ceilingDb` may write. The clamp itself runs in
 * doubles, so the last thing that can move it is the block's own grid: the value
 * is rounded to the nearest Float32 on the way out, which may be up to half an
 * ulp above the ceiling. One whole Float32 ulp of headroom is generous and still
 * far under a hundredth of a dB.
 * @param {number} ceilingDb the limiter's ceiling
 * @returns {number} the largest magnitude allowed on the Float32 grid
 */
function float32Ceiling(ceilingDb) {
  const value = Math.fround(amplitudeOf(ceilingDb));
  return value + Math.abs(value) * Math.pow(2, -23);
}

/**
 * A stereo sine, the right channel a little behind the left.
 * @param {number} rate the sample rate
 * @param {number} frames
 * @param {number} hz
 * @param {number} amplitude
 * @returns {{left: Float32Array, right: Float32Array, frames: number}}
 */
function toneAt(rate, frames, hz, amplitude) {
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  const step = (2 * Math.PI * hz) / rate;
  for (let at = 0; at < frames; at += 1) {
    left[at] = amplitude * Math.sin(step * at);
    right[at] = amplitude * Math.sin(step * at + 0.6);
  }
  return { left: left, right: right, frames: frames };
}

/** @returns {{left: Float32Array, right: Float32Array, frames: number}} a sine at the default rate. */
function tone(frames, hz, amplitude) {
  return toneAt(SAMPLE_RATE, frames, hz, amplitude);
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
  // Both tones sit above the threshold, so both are compressed; the level 24 dB
  // over the threshold has to come out 18 dB down at 4:1, the one 12 dB over has
  // to come out 9 dB down, and the step between them shrinks from 12 dB to 3.
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

  for (const rate of RATES) {
    const frames = framesAt(rate, 1.5);
    const from = frames - framesAt(rate, 0.2);

    /** @returns {number} the level of a tone's last fifth of a second, after the insert. */
    function levelOut(amplitude) {
      const insert = StudioDynamics.create("compressor", rate);
      insert.setParams(settings);
      const rendered = render(insert, toneAt(rate, frames, 100, amplitude));
      return dbOf(peakOf(rendered.left, from));
    }

    const loudIn = dbOf(0.5); // -6.0 dBFS: 24 dB over the threshold
    const quietIn = dbOf(0.125); // -18.1 dBFS: 12 dB over it
    const loudOut = levelOut(0.5);
    const quietOut = levelOut(0.125);

    assert.ok(
      Math.abs(loudOut - (loudIn - 18)) < 0.6,
      `at ${rate} Hz a 24 dB overload at 4:1 has to come out 18 dB down, it came out ${(loudOut - loudIn).toFixed(2)} dB`,
    );
    assert.ok(
      Math.abs(quietOut - (quietIn - 9)) < 0.6,
      `at ${rate} Hz a 12 dB overload at 4:1 has to come out 9 dB down, it came out ${(quietOut - quietIn).toFixed(2)} dB`,
    );
    assert.ok(
      Math.abs(loudOut - quietOut - 3) < 0.5,
      `at ${rate} Hz 12 dB more in has to be 12/4 = 3 dB more out, it is ${(loudOut - quietOut).toFixed(2)} dB`,
    );
  }
});

test("the compressor's rms detector reads the window's power, not its peak", () => {
  const base = {
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

  /** @returns {number} the level of a steady tone's last fifth of a second. */
  function levelOut(detect, amplitude, settings) {
    const insert = StudioDynamics.create("compressor", SAMPLE_RATE);
    insert.setParams({ ...base, detect: detect, ...(settings || {}) });
    const rendered = render(insert, tone(frames, 100, amplitude));
    return dbOf(peakOf(rendered.left, from));
  }

  // A sine's rms is 3 dB under its peak, so the rms detector sees 3 dB less
  // overload and takes 3/4 dB less off: the same tone comes out that much LOUDER,
  // because the gain reduction is measured from the window's power and applied to
  // the tone's peak level, which is what the meter reads.
  const rmsIn = dbOf(0.5 / Math.SQRT2); // -9.03 dBFS: 20.97 dB over the threshold
  const expected = dbOf(0.5) - (rmsIn + 30) * (1 - 1 / 4);
  const rmsOut = levelOut("rms", 0.5);
  const peakOut = levelOut("peak", 0.5);
  assert.ok(
    Math.abs(rmsOut - expected) < 0.6,
    `the rms detector has to compress from the window's power, ${expected.toFixed(2)} dBFS, it reads ${rmsOut.toFixed(2)} dBFS`,
  );
  const rmsIsLouderBy = Math.abs(dbOf(1 / Math.SQRT2)) * (1 - 1 / 4); // the 3 dB, scaled by the slope
  assert.ok(
    Math.abs(rmsOut - peakOut - rmsIsLouderBy) < 0.3,
    `a sine's rms is 3 dB under its peak, so rms detection has to come out ${rmsIsLouderBy.toFixed(2)} dB louder, it came out ${(rmsOut - peakOut).toFixed(2)} dB different`,
  );

  // A sparse impulse train is where the two detectors really differ: a high peak
  // with almost no power in the 10 ms window. Peak detection has to squash the
  // spikes, rms detection has to leave them alone because the window's mean does
  // not reach the threshold. A short release, so that whatever the first spike
  // did to the empty window has been forgotten long before the measurement.
  const spikes = silence(framesOf(0.8));
  for (let at = 0; at < spikes.frames; at += framesOf(0.005)) {
    spikes.left[at] = 0.9;
    spikes.right[at] = 0.9;
  }
  const spikeSettings = { threshold_db: -20, attack_ms: 0.1, release_ms: 50 };
  const peakSpikes = StudioDynamics.create("compressor", SAMPLE_RATE);
  peakSpikes.setParams({ ...base, detect: "peak", ...spikeSettings });
  const rmsSpikes = StudioDynamics.create("compressor", SAMPLE_RATE);
  rmsSpikes.setParams({ ...base, detect: "rms", ...spikeSettings });
  const squashed = peakOf(render(peakSpikes, spikes).left, framesOf(0.4));
  const passed = peakOf(render(rmsSpikes, spikes).left, framesOf(0.4));
  assert.ok(squashed < 0.4, `peak detection has to squash -0.9 dBFS spikes under a -20 dB threshold, it left ${squashed}`);
  assert.ok(passed > 0.85, `rms detection has to leave them, their window power is under the threshold; it read ${passed}`);
});

test("a huge sample does not leave the rms detector wrong", () => {
  // The rms detector is a running sum of squares: add 1e18, then subtract it
  // again a window later, and the double that held it has rounded away every
  // small value added beside it (its ulp is 64). The sum comes back as 0 — or, on
  // another signal, as some drift or even a negative number, whose square root is
  // NaN and whose level then reads as silence. Either way the detector would
  // never compress again. The sum is now rebuilt from the window once per wrap,
  // so after a full window a huge sample leaves no trace: the same gain as a
  // fresh insert fed the same tone and nothing else.
  const settings = {
    detect: "rms",
    threshold_db: -20,
    ratio: 4,
    knee_db: 0,
    attack_ms: 0.1,
    release_ms: 5,
    makeup_db: 0,
    sidechain_hp_hz: 0,
  };
  const frames = framesOf(0.4);
  const from = frames - framesOf(0.05);

  const poisoned = tone(frames, 100, 0.5);
  poisoned.left[0] = 1e9;
  poisoned.right[0] = 1e9;
  const insert = StudioDynamics.create("compressor", SAMPLE_RATE);
  insert.setParams(settings);
  const soaked = render(insert, poisoned);

  const twin = StudioDynamics.create("compressor", SAMPLE_RATE);
  twin.setParams(settings);
  const clean = render(twin, tone(frames, 100, 0.5));

  const after = peakOf(soaked.left, from);
  const reference = peakOf(clean.left, from);
  assert.ok(reference > 0.1, `the twin has to be compressing a tone, it reads ${reference}`);
  assert.ok(
    Math.abs(after - reference) < reference * 0.01,
    `after the window a huge sample may not change the rms detector's gain: ${after.toFixed(5)} against a fresh twin's ${reference.toFixed(5)}`,
  );
});

test("a soft knee turns the compressor down inside the knee, smoothly", () => {
  // The knee this compressor uses is the standard quadratic one (Reiss), whose
  // reduction above the threshold is (1/ratio - 1) × (over + knee/2)² / (2 × knee):
  // it starts W/2 BELOW the threshold and joins the ratio line W/2 above it. So
  // "softer" here means it begins earlier and dips slightly deeper than a knee of
  // 0 near the threshold — never less reduction — and the two are equal again at
  // the top of the knee. A knee of 0 is the hard corner the ratio test uses.
  const base = {
    detect: "peak",
    threshold_db: -30,
    ratio: 4,
    attack_ms: 0.1,
    release_ms: 300,
    makeup_db: 0,
    sidechain_hp_hz: 0,
  };
  const frames = framesOf(1.2);
  const from = frames - framesOf(0.2);

  /** @returns {number} how much a tone `over` dB above the threshold is turned down. */
  function reductionOf(kneeDb, over) {
    const amplitude = amplitudeOf(-30 + over);
    const insert = StudioDynamics.create("compressor", SAMPLE_RATE);
    insert.setParams({ ...base, knee_db: kneeDb });
    const rendered = render(insert, tone(frames, 100, amplitude));
    return dbOf(peakOf(rendered.left, from)) - dbOf(peakOf(tone(frames, 100, amplitude).left, from));
  }

  /** @returns {number} the standard quadratic knee's reduction, in dB (negative). */
  function expected(kneeDb, over) {
    const slope = 1 / 4 - 1;
    if (kneeDb === 0) return over > 0 ? slope * over : 0;
    const half = kneeDb / 2;
    if (over <= -half) return 0;
    if (over >= half) return slope * over;
    return (slope * (over + half) * (over + half)) / (2 * kneeDb);
  }

  for (const [kneeDb, over] of [
    [0, 3],
    [12, 3],
    [0, -3],
    [12, -3],
    [0, 6],
    [12, 6],
    [0, 12],
    [12, 12],
  ]) {
    const measured = reductionOf(kneeDb, over);
    const wanted = expected(kneeDb, over);
    assert.ok(
      Math.abs(measured - wanted) < 0.25,
      `a ${kneeDb} dB knee at ${over} dB over the threshold has to reduce by ${wanted.toFixed(2)} dB, it reduced by ${measured.toFixed(2)} dB`,
    );
  }

  // Said as behaviour rather than as a formula: inside the knee the soft one is
  // already working, and at the top of the knee the two are the same line again.
  const softBelow = reductionOf(12, -3);
  const hardBelow = reductionOf(0, -3);
  assert.ok(
    softBelow < -0.15,
    `a 12 dB knee has to be reducing 3 dB under the threshold, it reduced by ${softBelow.toFixed(2)} dB`,
  );
  assert.ok(
    Math.abs(hardBelow) < 0.05,
    `a knee of 0 has to leave a tone under the threshold alone, it moved it by ${hardBelow.toFixed(2)} dB`,
  );
  assert.ok(
    reductionOf(12, 3) < reductionOf(0, 3) - 0.1,
    `inside the knee the soft knee has to be deeper than the corner, it is ${(reductionOf(12, 3) - reductionOf(0, 3)).toFixed(2)} dB`,
  );
  assert.ok(
    Math.abs(reductionOf(12, 6) - reductionOf(0, 6)) < 0.05,
    "at half a knee above the threshold the knee has to join the ratio line",
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
  for (const rate of RATES) {
    // +12 dB hot, and square-ish rather than square: the flat tops carry the
    // harmonics that make a converter's reconstruction filter overshoot, which is
    // exactly what a true-peak detector exists to see.
    const frames = framesAt(rate, 2);
    const hot = { left: new Float32Array(frames), right: new Float32Array(frames), frames: frames };
    for (let at = 0; at < frames; at += 1) {
      const t = at / rate;
      hot.left[at] = 4 * Math.tanh(4 * Math.sin(2 * Math.PI * 221 * t) + 0.3 * Math.sin(2 * Math.PI * 3701 * t));
      hot.right[at] = 4 * Math.tanh(4 * Math.sin(2 * Math.PI * 227 * t + 0.4) + 0.3 * Math.sin(2 * Math.PI * 3301 * t));
    }

    const inputTruePeak = truePeakDb(hot.left, hot.right, frames);
    assert.ok(inputTruePeak > 6, `the signal has to be well over full scale, its true peak is ${inputTruePeak} dBTP`);

    // The limiter's own meter and the render's meter are the same filter: on this
    // signal they have to agree to the last bit's worth of rounding.
    const limiterMeter = StudioDynamics.truePeakDb(hot.left, hot.right, frames);
    assert.ok(
      Math.abs(limiterMeter - inputTruePeak) < 1e-9,
      `the limiter must measure peaks with the render's filter, ${limiterMeter} dBTP against ${inputTruePeak} dBTP`,
    );

    for (const ceilingDb of [-1, -6, -0.1]) {
      const insert = StudioDynamics.create("limiter", rate, { master: true });
      insert.setParams({ ceiling_db: ceilingDb, release_ms: 50 });
      const rendered = render(insert, hot);
      const outTruePeak = truePeakDb(rendered.left, rendered.right, frames);
      assert.ok(
        outTruePeak <= ceilingDb + 0.05,
        `at ${rate} Hz a ${ceilingDb} dBTP ceiling has to hold, the output's true peak is ${outTruePeak} dBTP`,
      );
      assert.ok(
        outTruePeak >= ceilingDb - 1,
        `at ${rate} Hz the limiter has to reach its ceiling, not mute the song: ${outTruePeak} dBTP against ${ceilingDb}`,
      );
      // And the samples themselves are inside the ceiling too — on the Float32
      // grid they come out on, which is one rounding away from the clamp.
      const allowed = float32Ceiling(ceilingDb);
      const loudest = Math.max(peakOf(rendered.left), peakOf(rendered.right));
      assert.ok(
        loudest <= allowed,
        `at ${rate} Hz no sample of a ${ceilingDb} dB-limited signal may sit above it, ${loudest} reads above ${allowed}`,
      );
    }
  }
});

test("the master limiter ramps into a peak instead of stepping", () => {
  // A DC step is the plainest hot transient there is: no zero crossings to divide
  // by, so the gain the limiter applied to a frame is exactly out / the input a
  // lookahead earlier. The old behaviour took the whole reduction in one frame
  // (a 0.7 step here, ~66 frames before the peak was even output).
  for (const rate of RATES) {
    const frames = framesAt(rate, 0.25);
    const from = framesAt(rate, 0.08);
    const to = framesAt(rate, 0.11);
    const signal = { left: new Float32Array(frames), right: new Float32Array(frames), frames: frames };
    for (let at = 0; at < frames; at += 1) {
      const value = at < from ? 0.2 : at < to ? 3 : 0.2;
      signal.left[at] = value;
      signal.right[at] = value;
    }

    const insert = StudioDynamics.create("limiter", rate, { master: true });
    insert.setParams({ ceiling_db: -1, release_ms: 50 });
    const rendered = render(insert, signal);
    const delay = insert.latencyFrames;
    assert.ok(delay > 0, "this is the master limiter, so it has a lookahead to ramp across");

    let previous = 0;
    let previousSeen = false;
    let worstStep = 0;
    let moved = 0;
    for (let at = delay; at < frames; at += 1) {
      const delayedIn = signal.left[at - delay];
      if (delayedIn === 0) continue;
      const gain = rendered.left[at] / delayedIn;
      if (previousSeen) {
        const change = Math.abs(gain - previous);
        if (change > worstStep) worstStep = change;
        if (change > 1e-9) moved += 1;
      }
      previous = gain;
      previousSeen = true;
    }

    // The ramp spreads a whole unit of gain over 7/8 of the lookahead, so one
    // frame may move the gain by at most (8/7) / latencyFrames — 0.016 at 48 kHz
    // for a drop from unity to zero, and this signal's drop is 0.70 over 63
    // frames, i.e. 0.011. The bound below is 1.25× that worst case, so the ramp
    // passes with room; the single-frame step it replaced (0.70) misses it by 35×.
    const bound = 0.02 * (48000 / rate);
    assert.ok(
      worstStep < bound,
      `at ${rate} Hz the limiter may not step its gain: the largest frame-to-frame change is ${worstStep.toFixed(4)} (the ramp allows ${bound.toFixed(4)})`,
    );
    assert.ok(moved > delay, `at ${rate} Hz the reduction has to be spread over frames, it changed on only ${moved} of them`);
    assert.ok(
      Math.max(peakOf(rendered.left), peakOf(rendered.right)) <= float32Ceiling(-1),
      "and a ramped peak is still held inside the ceiling",
    );
  }
});

test("the master limiter holds the ceiling and ramps on rising crests", () => {
  // The window's minimum is not the only deadline in the window, and it is not
  // the first one either. Three bursts, each 2 dB hotter than the last, put a
  // shallower peak nearer the output while the deeper ones are still on their way
  // in: a ramp aimed only at the window minimum (the deepest peak, and the one
  // furthest from the output) is gentler than the nearer peak's own requirement,
  // so the gain is still above it when that peak is handed out — and the clamp
  // that catches it is a step of about a decibel, taken exactly where the ceiling
  // is about the true peak between frames already gone. The ramp has to be steep
  // enough for EVERY frame in the window.
  //
  // The old ramp — the window minimum with its own deadline — fails this without
  // stepping to catch: the gain simply is not low enough while the earlier crest
  // is handed out, and the output's true peak comes out at -0.65 dBTP at 44.1 kHz
  // and -0.78 dBTP at 48 kHz under a -1 dBTP ceiling (and 0.6 dB over it with the
  // bursts 6 dB apart). It does produce a step on other crest spacings; this
  // signal is the one the review asked for.
  const ceilingDb = -1;
  for (const rate of RATES) {
    const frames = framesAt(rate, 0.4);
    const insert = StudioDynamics.create("limiter", rate, { master: true });
    insert.setParams({ ceiling_db: ceilingDb, release_ms: 50 });

    // Square bursts, about 20 frames apart at 48 kHz (the same fraction of the
    // lookahead at any rate, so all three are inside one window while the first
    // is already on its way out), each one 2 dB hotter and all of them over the
    // ceiling. The flat tops carry the inter-sample overshoot a true-peak
    // detector exists to see, and every sample of a burst is ± the burst's
    // amplitude, so out/in is the gain the limiter applied on every one of them.
    const spacing = Math.max(2, Math.round((rate * 20) / SAMPLE_RATE));
    const halfPeriod = Math.max(2, Math.round((rate * 4) / SAMPLE_RATE));
    const burstFrames = halfPeriod * 4;
    const first = framesAt(rate, 0.06);
    const base = amplitudeOf(ceilingDb + 1); // ~1 dB over, before the overshoot
    const signal = silence(frames);
    for (let burst = 0; burst < 3; burst += 1) {
      const amplitude = base * amplitudeOf(2 * burst);
      const start = first + burst * spacing;
      for (let at = 0; at < burstFrames; at += 1) {
        const value = Math.floor(at / halfPeriod) % 2 === 0 ? amplitude : -amplitude;
        signal.left[start + at] = value;
        signal.right[start + at] = value;
      }
    }
    assert.ok(
      truePeakDb(signal.left, signal.right, frames) > ceilingDb + 3,
      `the crests have to be well over the ceiling before a limiter is asked to hold them`,
    );

    const rendered = render(insert, signal);
    const delay = insert.latencyFrames;
    let previous = 0;
    let previousAt = -2;
    let worstStep = 0;
    let worstAt = -1;
    let moved = 0;
    for (let at = delay; at < frames; at += 1) {
      const inputAt = at - delay;
      const delayedIn = signal.left[inputAt];
      if (delayedIn === 0) continue;
      const gain = rendered.left[at] / delayedIn;
      // Only frame-to-frame, never across the silence between two bursts: a
      // change over four frames is four ramp steps, not one.
      if (inputAt - previousAt === 1) {
        const change = Math.abs(gain - previous);
        if (change > worstStep) {
          worstStep = change;
          worstAt = inputAt;
        }
        if (change > 1e-9) moved += 1;
      }
      previous = gain;
      previousAt = inputAt;
    }

    const outTruePeak = truePeakDb(rendered.left, rendered.right, frames);
    assert.ok(
      outTruePeak <= ceilingDb + 0.05,
      `at ${rate} Hz rising crests have to stay inside a ${ceilingDb} dBTP ceiling, the output's true peak is ${outTruePeak} dBTP`,
    );
    // The same per-frame bound the DC-step ramp test uses: a whole unit of gain
    // spread over 7/8 of the lookahead, times 1.25 of slack.
    const bound = 0.02 * (48000 / rate);
    assert.ok(
      worstStep < bound,
      `at ${rate} Hz the limiter may not step its gain on a rising crest: the largest frame-to-frame change is ${worstStep.toFixed(4)} (frame ${worstAt}, the ramp allows ${bound.toFixed(4)})`,
    );
    assert.ok(
      moved > 0,
      `at ${rate} Hz the gain has to move across the crests, it changed on only ${moved} frames`,
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

test("the gate does not chatter on a low tone with no hold", () => {
  // 20 Hz is the worst case: with the raw sample as the detector the gate reads
  // silence twenty-five times a second. |0.5 sin θ| is under -40 dBFS (0.01) for
  // |θ| < 0.02 rad, and 20 Hz at 48 kHz moves 2.6 mrad a frame, so the old raw
  // detector sat under the threshold for about seven frames around every zero
  // crossing — twice per 50 ms period, so roughly eighty times in this two-second
  // run. With hold at 0 every one of those frames closed the gate and the next
  // one opened it again: the old code would report ~80 open→closed transitions
  // below (and a gain down at `range_db`'s 1e-4 on each of those frames), where
  // this test demands 0. The smoothed peak envelope — instant attack, a 10 ms
  // release against a 25 ms half period — never comes near the threshold.
  const insert = StudioDynamics.create("gate", SAMPLE_RATE);
  insert.setParams({
    threshold_db: -40,
    hysteresis_db: 0,
    attack_ms: 0.01,
    hold_ms: 0,
    release_ms: 5,
    range_db: -80,
  });
  const frames = framesOf(2);
  const signal = tone(frames, 20, 0.5); // -6 dBFS, 34 dB over the threshold

  // One frame at a time, reading the gate's own read-only `state` and `gain`.
  // Dividing the output by the input is useless exactly where the old detector
  // failed (the input IS silent at a zero crossing), which is how a test can end
  // up passing the raw-sample detector it was written for: this one watches the
  // gate, so a closure is visible on the frame it happens.
  const left = new Float32Array(1);
  const right = new Float32Array(1);
  let openFrames = 0;
  let closures = 0;
  let lowestGain = 1;
  for (let at = 0; at < frames; at += 1) {
    left[0] = signal.left[at];
    right[0] = signal.right[at];
    insert.process(left, right, 1);
    if (insert.state) {
      openFrames += 1;
      // The first frames are the gate's own attack up to 1, not the tone.
      if (at >= framesOf(0.05) && insert.gain < lowestGain) lowestGain = insert.gain;
    } else if (openFrames > 0) {
      closures += 1;
    }
  }

  assert.ok(
    openFrames >= frames - 1,
    `the gate has to open on a tone 34 dB over its threshold, it was open on ${openFrames} of ${frames} frames`,
  );
  assert.equal(
    closures,
    0,
    `the gate closed ${closures} times after it opened: a low tone chatters without a smoothed detector`,
  );
  assert.ok(
    lowestGain > 0.999,
    `over a tone 34 dB above its threshold the gate's gain has to stay at 1, it fell to ${lowestGain}`,
  );
});

test("the gate turns a sound on and off at its threshold", () => {
  // What a gate has to do, on top of the hysteresis above: a tone over the
  // threshold comes through at its own level, and a tone under it comes through
  // `range_db` down.
  const insert = StudioDynamics.create("gate", SAMPLE_RATE);
  insert.setParams({ threshold_db: -40, hysteresis_db: 3, attack_ms: 0.1, hold_ms: 0, release_ms: 5, range_db: -40 });
  const frames = framesOf(0.5);
  const loud = render(insert, tone(frames, 200, 0.1)); // -20 dBFS
  assert.ok(
    Math.abs(dbOf(peakOf(loud.left, framesOf(0.05))) - dbOf(0.1)) < 0.5,
    `a -20 dBFS tone has to come out at -20 dBFS, it reads ${dbOf(peakOf(loud.left, framesOf(0.05)))} dBFS`,
  );

  insert.reset();
  const quiet = render(insert, tone(frames, 200, amplitudeOf(-60))); // 20 dB under it
  const level = dbOf(peakOf(quiet.left, framesOf(0.1)));
  assert.ok(
    Math.abs(level - (dbOf(amplitudeOf(-60)) - 40)) < 0.5,
    `a -60 dBFS tone has to come out 40 dB down, it reads ${level.toFixed(2)} dBFS`,
  );
});

test("the gate's hold keeps it open after the sound stops", () => {
  // A loud burst, then a probe at -55 dBFS (under the closing threshold) for the
  // rest of the run: the probe's level is the gate's gain, times a known number.
  const threshold = -40;
  const probe = amplitudeOf(-55);
  const total = framesOf(0.6);
  const burst = framesOf(0.2);
  const signal = silence(total);
  const loud = tone(total, 200, 0.1);
  const quiet = tone(total, 200, probe);
  for (let at = 0; at < total; at += 1) {
    signal.left[at] = at < burst ? loud.left[at] : quiet.left[at];
    signal.right[at] = at < burst ? loud.right[at] : quiet.right[at];
  }

  /** @returns {number} the probe's peak between two times, in seconds after the burst. */
  function probeLevel(holdMs, fromSeconds, toSeconds) {
    const insert = StudioDynamics.create("gate", SAMPLE_RATE);
    insert.setParams({
      threshold_db: threshold,
      hysteresis_db: 6,
      attack_ms: 0.5,
      hold_ms: holdMs,
      release_ms: 5,
      range_db: -80,
    });
    const rendered = render(insert, signal);
    return peakOf(rendered.left.slice(burst + framesOf(fromSeconds), burst + framesOf(toSeconds)));
  }

  // Hold 100 ms: 60–90 ms after the burst the detector has fallen under the
  // closing threshold but the hold has not run out, so the probe is still open.
  assert.ok(
    probeLevel(100, 0.06, 0.09) > probe * 0.5,
    `with a 100 ms hold the gate has to still be open 60–90 ms after the burst, the probe reads ${probeLevel(100, 0.06, 0.09)}`,
  );
  // Hold 0: closed within the detector's own ~30 ms fall, so by 60 ms it is shut.
  assert.ok(
    probeLevel(0, 0.06, 0.09) < probe * 0.05,
    `with no hold the gate has to be shut 60–90 ms after the burst, the probe reads ${probeLevel(0, 0.06, 0.09)}`,
  );
  // And both are shut at the range floor once the hold is over.
  for (const holdMs of [0, 100]) {
    assert.ok(
      probeLevel(holdMs, 0.25, 0.3) < probe * 0.01,
      `after its hold a gate has to be ${Math.abs(-80 - dbOf(probe))} dB down, it passes ${dbOf(probeLevel(holdMs, 0.25, 0.3))} dBFS`,
    );
  }
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
  // An impulse on the first frame of a block: a zero-latency insert has to let it
  // out on the first frame of its own output, in full. Every kind answers on its
  // own frame — and for the gate that only means anything once it is open, so it
  // is primed with a loud passage first and the impulse is compared in and out at
  // the same frame.
  for (const kind of KINDS) {
    const insert = StudioDynamics.create(kind, SAMPLE_RATE);
    assert.equal(insert.latencyFrames, 0, `a ${kind} on a track may not delay it`);

    if (kind === "gate") {
      insert.setParams({
        threshold_db: -40,
        hysteresis_db: 3,
        attack_ms: 0.01,
        hold_ms: 50,
        release_ms: 100,
        range_db: -80,
      });
      render(insert, tone(framesOf(0.1), 200, 0.5));
    }

    const impulse = silence(BLOCK);
    impulse.left[0] = 0.5;
    impulse.right[0] = 0.5;
    const rendered = render(insert, impulse);
    // A knob's own attack may move the frame by a fraction of a percent (the
    // compressor's 10 ms attack takes 0.2% off the first frame), but the impulse
    // has to be ANSWERED on its own frame, not later or in part.
    assert.ok(
      Math.abs(rendered.left[0] - impulse.left[0]) < 0.01 * Math.abs(impulse.left[0]),
      `a ${kind} on a track has to answer on the frame it was given: in ${impulse.left[0]}, out ${rendered.left[0]}`,
    );
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
  assert.ok(Math.abs(rendered.left[delay] - 0.5) < 1e-3, "the impulse comes out exactly one lookahead later, in full");
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
    clipped.left[0] <= float32Ceiling(-1) && clipped.left[0] > amplitudeOf(-1) - 1e-6,
    `a track limiter clips at its ceiling on the frame itself, it reads ${clipped.left[0]}`,
  );
});

test("a non-finite sample does not poison any dynamics insert", () => {
  // A NaN or an infinity in a biquad's history, in the RMS running sum or in the
  // lookahead would stay there for good: the de-esser would hand out NaN forever,
  // the compressor would never compress again, and the master limiter would pass
  // a NaN frame. So a block of them goes in, a steady tone follows, and the
  // insert has to be exactly the insert a fresh twin (fed the same tone and
  // nothing else) is once its recovery window is over.
  const head = BLOCK * 2;
  const cases = [
    { label: "compressor", kind: "compressor", hz: 200, amplitude: 0.5, params: {} },
    { label: "compressor in rms mode", kind: "compressor", hz: 200, amplitude: 0.5, params: { detect: "rms" } },
    {
      label: "compressor with its sidechain high-pass on",
      kind: "compressor",
      hz: 200,
      amplitude: 0.5,
      params: { sidechain_hp_hz: 250 },
    },
    { label: "compressor keyed by a sidechain", kind: "compressor", hz: 200, amplitude: 0.5, params: {}, keyed: true },
    { label: "track limiter", kind: "limiter", hz: 200, amplitude: 2, params: {} },
    { label: "master limiter", kind: "limiter", hz: 200, amplitude: 2, params: {}, master: true },
    { label: "gate", kind: "gate", hz: 200, amplitude: 0.5, params: {} },
    { label: "de-esser", kind: "deesser", hz: 7000, amplitude: 0.5, params: {} },
  ];

  for (const one of cases) {
    const tones = framesOf(1.2);
    const recovery = framesOf(0.7); // the tail compared, and well past any settling
    const poisoned = tone(head + tones, one.hz, one.amplitude);
    poisoned.left[1] = NaN;
    poisoned.right[2] = NaN;
    poisoned.left[BLOCK + 1] = Infinity;
    poisoned.right[BLOCK + 2] = -Infinity;
    let key = null;
    if (one.keyed) {
      key = tone(head + tones, one.hz, 0.5);
      key.left[3] = NaN;
      key.right[4] = Infinity;
      key.left[BLOCK + 3] = -Infinity;
    }
    // The same tone without the poisoned head, and the same for the sidechain.
    const clean = { left: poisoned.left.slice(head), right: poisoned.right.slice(head), frames: tones };
    const cleanKey = key ? { left: key.left.slice(head), right: key.right.slice(head), frames: tones } : null;

    const insert = StudioDynamics.create(one.kind, SAMPLE_RATE, { master: one.master });
    insert.setParams(one.params);
    const rendered = render(insert, poisoned, key);
    for (let at = 0; at < rendered.frames; at += 1) {
      assert.ok(
        Number.isFinite(rendered.left[at]) && Number.isFinite(rendered.right[at]),
        `${one.label} handed out ${rendered.left[at]}/${rendered.right[at]} on frame ${at} after a non-finite sample`,
      );
    }

    const twin = StudioDynamics.create(one.kind, SAMPLE_RATE, { master: one.master });
    twin.setParams(one.params);
    const reference = render(twin, clean, cleanKey);
    let diff = 0;
    let level = 0;
    for (let at = tones - recovery; at < tones; at += 1) {
      diff = Math.max(
        diff,
        Math.abs(rendered.left[head + at] - reference.left[at]),
        Math.abs(rendered.right[head + at] - reference.right[at]),
      );
      level = Math.max(level, Math.abs(reference.left[at]), Math.abs(reference.right[at]));
    }
    assert.ok(level > 0.05, `${one.label} has to be playing something to be compared against, the twin reads ${level}`);
    assert.ok(
      diff < 1e-6,
      `${one.label} has to be back to a fresh insert's state after a non-finite block, its tail is ${diff} away from the twin's`,
    );
  }
});

test("lowering the ceiling while playing holds the new ceiling at once", () => {
  // A tone under the old ceiling and over the new one: at -6 dBFS it passes a -1
  // dB ceiling untouched, so nothing in the lookahead is holding it back when the
  // ceiling drops to -6. The frames already on their way out have to be measured
  // against the new ceiling — from the very next sample, not once the old peaks
  // have drained out of the lookahead.
  const total = framesOf(0.6);
  const switchFrame = Math.floor(framesOf(0.3) / BLOCK) * BLOCK;
  const signal = tone(total, 200, 0.6); // -4.4 dBFS
  const insert = StudioDynamics.create("limiter", SAMPLE_RATE, { master: true });
  insert.setParams({ ceiling_db: -1, release_ms: 50 });

  const rendered = { left: new Float32Array(total), right: new Float32Array(total) };
  for (let at = 0; at < total; at += BLOCK) {
    const count = Math.min(BLOCK, total - at);
    if (at === switchFrame) insert.setParams({ ceiling_db: -6 });
    const left = signal.left.slice(at, at + count);
    const right = signal.right.slice(at, at + count);
    insert.process(left, right, count);
    rendered.left.set(left, at);
    rendered.right.set(right, at);
  }

  // Before the change the tone really was passing the -1 dB ceiling untouched.
  const before = dbOf(peakOf(rendered.left.slice(0, switchFrame)));
  assert.ok(Math.abs(before - dbOf(0.6)) < 0.1, `the tone has to be under the old ceiling, it reads ${before} dBFS`);

  const allowed = float32Ceiling(-6);
  const loudest = Math.max(peakOf(rendered.left.slice(switchFrame)), peakOf(rendered.right.slice(switchFrame)));
  assert.ok(
    loudest <= allowed,
    `the lowered ceiling has to hold from the frame it was set, ${loudest} is above ${allowed}`,
  );
  assert.ok(
    dbOf(loudest) > -6 - 0.5,
    `and it must not mute the frame either: it reads ${dbOf(loudest)} dBFS against a -6 dB ceiling`,
  );
});

test("reset() puts every insert back to the state a fresh one starts in", () => {
  // The chain rebuilds with `reset()`, so an insert that was playing has to be
  // indistinguishable from a newly created one — bit for bit, not just "close".
  for (const kind of KINDS) {
    const masters = kind === "limiter" ? [false, true] : [false];
    for (const master of masters) {
      const insert = StudioDynamics.create(kind, SAMPLE_RATE, { master: master });
      const fresh = StudioDynamics.create(kind, SAMPLE_RATE, { master: master });
      const label = `${kind}${master ? " (master)" : ""}`;
      const hz = kind === "deesser" ? 7000 : 200;

      // Drive it somewhere complicated first: a hot tone, then silence, so the
      // envelopes, the filters, the RMS window and the lookahead all hold
      // something that is not the initial state.
      render(insert, tone(framesOf(0.3), hz, 0.9));
      render(insert, silence(framesOf(0.05)));
      insert.reset();

      const probe = tone(framesOf(0.2), hz, 0.3);
      const after = render(insert, probe);
      const reference = render(fresh, probe);
      assert.deepEqual(after.left, reference.left, `a reset ${label} has to sound like a new one`);
      assert.deepEqual(after.right, reference.right, `a reset ${label} has to sound like a new one`);
      // And the parameters survive the reset: a reset insert plays the sound it
      // was set to, it does not go back to the defaults.
      assert.deepEqual(insert.params(), fresh.params(), `a reset ${label} keeps its parameters`);
    }
  }
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
  // Every insert, every parameter at both ends of its range — one at a time, and
  // every parameter at the minimum together and at the maximum together, which is
  // the combination a knob sweep one at a time never reaches — over a full-scale
  // sine and over silence. Each run's blocks are made BEFORE the counters go on,
  // so anything they see is the insert's own doing.
  const sineFrames = BLOCK * 6;
  const quietFrames = BLOCK * 2;
  const cases = [];

  for (const kind of KINDS) {
    // A limiter is both a master limiter and a track clipper, and the two run
    // different code; every other kind has one shape.
    const masters = kind === "limiter" ? [false, true] : [false];
    const allMin = {};
    const allMax = {};
    for (const [name, field] of Object.entries(StudioDynamics.PARAMS[kind].params)) {
      allMin[name] = field.values ? field.values[0] : field.min;
      allMax[name] = field.values ? field.values[field.values.length - 1] : field.max;
    }
    const settings = [];
    for (const [name, field] of Object.entries(StudioDynamics.PARAMS[kind].params)) {
      for (const value of field.values ? field.values : [field.min, field.max]) {
        settings.push([{ [name]: value }, `${name} = ${value}`]);
      }
    }
    settings.push([allMin, "every parameter at its minimum"]);
    settings.push([allMax, "every parameter at its maximum"]);

    for (const master of masters) {
      for (const [params, label] of settings) {
        const insert = StudioDynamics.create(kind, SAMPLE_RATE, { master: master });
        insert.setParams(params);
        const sine = tone(sineFrames, 440, 1);
        const quiet = silence(quietFrames);
        cases.push({
          label: `${kind}${master ? " (master)" : ""} with ${label}`,
          insert: insert,
          sine: blocksFor(insert, sine, true),
          quiet: blocksFor(insert, quiet, false),
        });
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

test("process() retains no heap growth over a long run", () => {
  // What this can see is RETENTION, not allocation. A short-lived object per
  // frame is garbage the young generation scavenges within a few megabytes — it
  // never shows up as a rise in `heapUsed`, so this test would not notice it, and
  // it is not meant to: the allocation guard is the typed-array and `Math.random`
  // counter in the test above. This one is the long-run guard — an object KEPT
  // (a growing array, a cache, one closure per block that outlives its block) is
  // the only thing that moves this number, and over this run a single small
  // retained object per frame would be ~60 MB.
  // `global.gc` is not available in the suite, so the bound has to be generous.
  const blocksPerPass = 200;
  const passes = 10;
  const hot = tone(BLOCK, 200, 0.9);
  const key = tone(BLOCK, 200, 0.5);
  const workLeft = new Float32Array(BLOCK);
  const workRight = new Float32Array(BLOCK);
  const workKeyLeft = new Float32Array(BLOCK);
  const workKeyRight = new Float32Array(BLOCK);
  const inserts = [
    StudioDynamics.create("compressor", SAMPLE_RATE),
    StudioDynamics.create("limiter", SAMPLE_RATE),
    StudioDynamics.create("limiter", SAMPLE_RATE, { master: true }),
    StudioDynamics.create("gate", SAMPLE_RATE),
    StudioDynamics.create("deesser", SAMPLE_RATE),
  ];
  inserts[0].setParams({ detect: "rms", sidechain_hp_hz: 200 });

  /** @param {number} count how many passes to drive */
  function drive(count) {
    for (let pass = 0; pass < count; pass += 1) {
      for (const insert of inserts) {
        const keyed = insert.kind === "compressor";
        for (let block = 0; block < blocksPerPass; block += 1) {
          workLeft.set(hot.left);
          workRight.set(hot.right);
          workKeyLeft.set(key.left);
          workKeyRight.set(key.right);
          insert.process(
            workLeft,
            workRight,
            BLOCK,
            keyed ? workKeyLeft : null,
            keyed ? workKeyRight : null,
          );
        }
      }
    }
  }

  const collect = typeof global.gc === "function" ? global.gc : null;
  drive(1); // warm-up: the JIT's caches and megamorphic call sites, not the audio path
  if (collect) collect();
  const before = process.memoryUsage().heapUsed;
  drive(passes);
  if (collect) collect();
  const growth = process.memoryUsage().heapUsed - before;
  const frames = blocksPerPass * passes * BLOCK * inserts.length;
  assert.ok(
    growth < 24 * 1024 * 1024,
    `${frames} frames later the heap grew by ${(growth / 1048576).toFixed(1)} MB, which is something being kept, not just garbage`,
  );
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
