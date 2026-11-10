/**
 * Studio's master meter — momentary, short-term and integrated loudness plus
 * true peak, measured on the audio thread.
 *
 *     StudioMeter.create(rate) → one meter
 *     meter.process(left, right, frames)   // feed it the master, after its inserts
 *     meter.read()                         // fill and return the same object
 *     meter.reset()                        // on Play: integrated starts again
 *
 * The readings are the ones the master strip shows (plan 1d, Task 10) and the
 * ones the processor posts every 100 ms of audio as
 * `{type: "meter", momentary, short_term, integrated, true_peak_db}`:
 *
 * - **momentary** — BS.1770-4 loudness of the last 400 ms (one gating block);
 * - **short-term** — the same over the last 3 s;
 * - **integrated** — the gated loudness of every 400 ms block since the last
 *   `reset()`, which is what "integrated LUFS" means and what a stream turns a
 *   song down to;
 * - **true peak** — the largest true peak since the last `reset()`, held, in
 *   dBTP.
 *
 * ## The integrated measurement is a histogram, not a list
 *
 * A Play can run for hours and an integrated reading is posted every 100 ms, so
 * neither the blocks nor the work of reading them may grow with time. The gating
 * blocks are therefore kept the way libebur128 keeps them: in a FIXED histogram
 * of block powers (`binSum` / `binCount` below), one bin per tenth of a LU from
 * the absolute gate's −70 LUFS up to +5 LUFS, so
 *
 * - a completed block costs one `log10` (to name its bin) and two array adds, and
 *   allocates nothing;
 * - a reading is two walks of those 750 bins with no log per stored block,
 *   whatever the length of the Play;
 * - the memory is one `Float64Array` and one `Uint32Array` of 750, made once —
 *   the bound on a Play is therefore its 32-bit per-bin block count, which is
 *   about thirteen years of continuous audio at ten blocks a second (the
 *   momentary and short-term windows are rings, and were always constant).
 *
 * The one thing quantising costs is that a block is judged by its bin's own mean
 * power, which is worth at most half a bin — 0.05 LU. A test holds the whole
 * measurement to `server/loudness.js` within 0.1 LU.
 *
 * ## It is the render's meter, streamed
 *
 * `server/loudness.js` measures a whole render at once: it filters the audio
 * with the BS.1770 K-weighting (a +4 dB high shelf at 1.68 kHz and an RLB
 * high-pass at 38 Hz, both derived for the rate in hand), sums 400 ms blocks
 * with 75 % overlap into mean-square powers, and gates them (an absolute −70
 * LUFS gate, then a relative −10 LU gate). It measures true peak with a 48-tap
 * 4× polyphase interpolator. This file is the very same arithmetic, run a block
 * at a time so a playing song can be metered without keeping the whole thing in
 * memory:
 *
 * - the two biquads are the same sections with the same coefficients, fed in
 *   the same order, so the filtered signal is the same sample for sample;
 * - the block grid is the same: a 400 ms block is four 100 ms hops counted from
 *   the reset, and the blocks overlap by three quarters exactly as
 *   `integratedLufs()`'s do;
 * - the gates are the same two passes over the same block powers;
 * - the true-peak filter is the same 48-tap Blackman-windowed sinc, built from
 *   the same construction.
 *
 * A test compares the two on the same audio and holds them within 0.1 LU.
 *
 * ## Nothing allocated, nothing thrown, no Math.random
 *
 * Everything is sized in `create()`: the biquads' state, the hop ring, the gating
 * histogram, the true-peak histories and the object `read()` fills in. Nothing
 * in this file grows with the length of a Play, so `process()` never allocates
 * and the cost of a reading never changes. A sample that is not a finite number
 * reads as 0, so one NaN from a broken insert can never live in the meter's
 * state, and every recursive value is flushed to exactly 0 below 1e-30 the way
 * `engine/dynamics.js` and `engine/perf-fx.js` flush theirs.
 *
 * ## It is a classic script
 *
 * No `import`/`export`: it assigns `globalThis.StudioMeter` for the worklet
 * scope and `module.exports` when a CommonJS `module` exists (`engine/package.json`
 * marks the directory `"commonjs"`), and `engine-client.js` concatenates it into
 * the worklet module with the other engine sources. It cannot read
 * `server/loudness.js` (a worklet cannot import), so the constants are
 * duplicated here — and a test pins them.
 */
(function () {
  "use strict";

  /** Below this, a recursive stage's state is flushed to exactly 0. */
  const DENORMAL_FLOOR = 1e-30;

  /** The rate a meter created without one runs at (the same default as the bus). */
  const DEFAULT_RATE = 48000;

  /** The gating block's length, in seconds (BS.1770-4). */
  const BLOCK_SECONDS = 0.4;

  /** Blocks overlap by this fraction, so the hop is a quarter of a block. */
  const BLOCK_OVERLAP = 0.75;

  /** The absolute gate, in LUFS. */
  const ABSOLUTE_GATE_LUFS = -70;

  /** The relative gate is this many LU below the ungated mean. */
  const RELATIVE_GATE_LU = -10;

  /** BS.1770's offset: a 997 Hz 0 dBFS sine in one channel reads -3.01 LUFS. */
  const LOUDNESS_OFFSET = -0.691;

  /** The short-term window, in seconds (EBU R128). */
  const SHORT_TERM_SECONDS = 3;

  /** The K-weighting pre-filter's reference parameters (the 48 kHz published form). */
  const SHELF = Object.freeze({ gain_db: 4.0, f0: 1681.974450955533, q: 0.7071752369554196 });

  /** The RLB high-pass's reference parameters. */
  const HIGHPASS = Object.freeze({ f0: 38.13547087602444, q: 0.5003270373238773 });

  /** The shelf's intermediate gain is `Vh` raised to this exponent. */
  const VB_EXPONENT = 0.4996667741545416;

  /** How many extra samples per input sample the true-peak meter interpolates. */
  const TRUE_PEAK_OVERSAMPLE = 4;

  /** Taps in the interpolation filter's prototype (>= 48, per the plan). */
  const TRUE_PEAK_TAPS = 48;

  /** Taps per polyphase branch, which is also how many frames of history are held. */
  const TRUE_PEAK_TAPS_PER_PHASE = TRUE_PEAK_TAPS / TRUE_PEAK_OVERSAMPLE;

  /** The prototype's centre tap: a multiple of the oversampling factor. */
  const TRUE_PEAK_CENTER = TRUE_PEAK_TAPS / 2;

  /** The polyphase branches, built once (they depend only on the constants). */
  const TRUE_PEAK_PHASES = buildTruePeakPhases();

  /**
   * The lowest loudness the integrated histogram keeps, in LUFS: the absolute
   * gate. A block quieter than this can never pass either gate, so it is not
   * stored at all.
   */
  const HISTOGRAM_FLOOR_LUFS = ABSOLUTE_GATE_LUFS;

  /** The loudest a block is before it goes in the top bin (LUFS). */
  const HISTOGRAM_CEILING_LUFS = 5;

  /** One bin per tenth of a LU: the grid libebur128 buckets gating blocks on. */
  const HISTOGRAM_BIN_LU = 0.1;

  /** How many bins that grid holds: fixed for the meter's whole life. */
  const HISTOGRAM_BINS = Math.round((HISTOGRAM_CEILING_LUFS - HISTOGRAM_FLOOR_LUFS) / HISTOGRAM_BIN_LU);

  /** The relative gate as a factor in the power domain: −10 LU is a tenth the power. */
  const RELATIVE_GATE_POWER = Math.pow(10, RELATIVE_GATE_LU / 10);

  /** @returns {number} the value, or 0 when it is below the denormal floor. */
  function flush(value) {
    return value > -DENORMAL_FLOOR && value < DENORMAL_FLOOR ? 0 : value;
  }

  /**
   * A sample as the audio path may carry it. `v - v` is exactly 0 for every
   * finite double (0 and -0 included) and NaN for a NaN or an infinity.
   * @param {number} value
   * @returns {number} the sample, or 0 when it is not a finite number
   */
  function finiteSample(value) {
    return value - value === 0 ? value : 0;
  }

  /** @returns {number} a finite number above zero, else 0. */
  function positive(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
  }

  /** @returns {number} the loudness of one block's mean-square power, in LUFS. */
  function loudnessOf(power) {
    return power > 0 ? LOUDNESS_OFFSET + 10 * Math.log10(power) : -Infinity;
  }

  /**
   * The biquads of the K-weighting filter, for one rate: the high shelf and the
   * RLB high-pass, in the coefficients `server/loudness.js` derives. A filter
   * whose `a0` is 1 in both sections, so a step is the plain recurrence.
   * @param {number} rate
   * @returns {{shelf: object, highpass: object}}
   */
  function weightingFor(rate) {
    const shelf = highShelfCoefficients(SHELF, rate);
    const highpass = highPassCoefficients(HIGHPASS, rate);
    return { shelf: shelf, highpass: highpass };
  }

  /**
   * The high-shelf pre-filter's biquad coefficients for one sample rate — the
   * same derivation `server/loudness.js` makes (the bilinear transform of an
   * RBJ-style high shelf, with `Vb = Vh^0.4996…`, normalised so a0 is 1).
   * @param {{gain_db: number, f0: number, q: number}} spec
   * @param {number} sampleRate
   * @returns {{b0: number, b1: number, b2: number, a1: number, a2: number}}
   */
  function highShelfCoefficients(spec, sampleRate) {
    const k = Math.tan((Math.PI * spec.f0) / sampleRate);
    const vh = Math.pow(10, spec.gain_db / 20);
    const vb = Math.pow(vh, VB_EXPONENT);
    const a0 = 1 + k / spec.q + k * k;
    return {
      b0: (vh + (vb * k) / spec.q + k * k) / a0,
      b1: (2 * (k * k - vh)) / a0,
      b2: (vh - (vb * k) / spec.q + k * k) / a0,
      a1: (2 * (k * k - 1)) / a0,
      a2: (1 - k / spec.q + k * k) / a0,
    };
  }

  /**
   * The RLB high-pass's biquad coefficients for one sample rate.
   * @param {{f0: number, q: number}} spec
   * @param {number} sampleRate
   * @returns {{b0: number, b1: number, b2: number, a1: number, a2: number}}
   */
  function highPassCoefficients(spec, sampleRate) {
    const k = Math.tan((Math.PI * spec.f0) / sampleRate);
    const a0 = 1 + k / spec.q + k * k;
    return {
      b0: 1 / a0,
      b1: -2 / a0,
      b2: 1 / a0,
      a1: (2 * (k * k - 1)) / a0,
      a2: (1 - k / spec.q + k * k) / a0,
    };
  }

  /**
   * The polyphase branches of the 4× true-peak interpolation filter, built
   * exactly as `server/loudness.js` builds them: a 48-tap Blackman-windowed sinc
   * whose cutoff sits at the input's Nyquist, normalised to unity DC gain per
   * branch.
   * @returns {Float64Array[]} one branch per phase, each summing to ~1
   */
  function buildTruePeakPhases() {
    const taps = new Float64Array(TRUE_PEAK_TAPS);
    const last = TRUE_PEAK_TAPS - 1;
    for (let index = 0; index < TRUE_PEAK_TAPS; index += 1) {
      const distance = (index - TRUE_PEAK_CENTER) / TRUE_PEAK_OVERSAMPLE;
      const sinc = distance === 0 ? 1 : Math.sin(Math.PI * distance) / (Math.PI * distance);
      // Blackman window: ~-58 dB of stopband is plenty for a peak estimate.
      const window =
        0.42 -
        0.5 * Math.cos((2 * Math.PI * index) / last) +
        0.08 * Math.cos((4 * Math.PI * index) / last);
      taps[index] = sinc * window;
    }
    let total = 0;
    for (let index = 0; index < TRUE_PEAK_TAPS; index += 1) total += taps[index];
    // A branch's taps sum to the branch's DC gain, so scaling the prototype to a
    // total of one-per-phase keeps every interpolated sample in the input's own
    // scale (a full-scale square wave must not read louder than 0 dBTP).
    const scale = total === 0 ? 1 : TRUE_PEAK_OVERSAMPLE / total;

    const phases = [];
    for (let phase = 0; phase < TRUE_PEAK_OVERSAMPLE; phase += 1) {
      const branch = new Float64Array(TRUE_PEAK_TAPS_PER_PHASE);
      for (let tap = 0; tap < TRUE_PEAK_TAPS_PER_PHASE; tap += 1) {
        branch[tap] = taps[phase + tap * TRUE_PEAK_OVERSAMPLE] * scale;
      }
      phases.push(branch);
    }
    return phases;
  }

  /**
   * One section's state on two channels (direct form I, like the render's
   * `applyBiquad`): `x1, x2` the two last inputs, `y1, y2` the two last outputs.
   * @returns {Float64Array} `[x1, x2, y1, y2]`, one array per channel
   */
  function newSection() {
    return { left: new Float64Array(4), right: new Float64Array(4) };
  }

  /**
   * One frame through one channel of one section. Every recursive value is
   * flushed, so a filter ringing down to nothing costs nothing.
   * @param {object} section the coefficients and the two channels' histories
   * @param {Float64Array} channel
   * @param {number} input
   * @returns {number} the filtered sample
   */
  function sectionStep(section, channel, input) {
    const out =
      section.b0 * input +
      section.b1 * channel[0] +
      section.b2 * channel[1] -
      section.a1 * channel[2] -
      section.a2 * channel[3];
    channel[1] = channel[0];
    channel[0] = input;
    channel[3] = channel[2];
    channel[2] = flush(out);
    return channel[2];
  }

  /**
   * One frame through the true-peak detector: the largest magnitude the signal
   * reaches on this frame and between this frame and the next. The same ring of
   * twelve frames per channel and the same branches `engine/dynamics.js` (and so
   * the master limiter) use.
   * @param {object} detector
   * @param {number} left
   * @param {number} right
   * @returns {number} the frame's true peak, as a magnitude
   */
  function truePeakStep(detector, left, right) {
    const historyLeft = detector.historyLeft;
    const historyRight = detector.historyRight;
    const at = detector.index;
    historyLeft[at] = left;
    historyRight[at] = right;
    let peak = Math.max(Math.abs(left), Math.abs(right));
    // Phase 0 is the input samples themselves, already taken above.
    for (let phase = 1; phase < TRUE_PEAK_PHASES.length; phase += 1) {
      const branch = TRUE_PEAK_PHASES[phase];
      let sumLeft = 0;
      let sumRight = 0;
      let from = at;
      for (let tap = 0; tap < TRUE_PEAK_TAPS_PER_PHASE; tap += 1) {
        sumLeft += branch[tap] * historyLeft[from];
        sumRight += branch[tap] * historyRight[from];
        from -= 1;
        if (from < 0) from = TRUE_PEAK_TAPS_PER_PHASE - 1;
      }
      const leftValue = Math.abs(sumLeft);
      const rightValue = Math.abs(sumRight);
      if (leftValue > peak) peak = leftValue;
      if (rightValue > peak) peak = rightValue;
    }
    detector.index = at + 1 >= TRUE_PEAK_TAPS_PER_PHASE ? 0 : at + 1;
    return peak;
  }

  /**
   * Build one meter.
   *
   * The readings start at silence (`-Infinity` LUFS, `-Infinity` dBTP) and
   * `reset()` puts them back there: a Play starts its integrated measurement
   * again, exactly as the plan says.
   * @param {number} rate the AudioContext's sample rate, in Hz
   * @returns {{rate: number, blockFrames: number, hopFrames: number,
   *            process: function(Float32Array, Float32Array|null, number): void,
   *            read: function(): {momentary: number, short_term: number,
   *                              integrated: number, true_peak_db: number},
   *            reset: function(): void}}
   */
  function create(rate) {
    const sampleRate = positive(rate) || DEFAULT_RATE;
    const weighting = weightingFor(sampleRate);

    /** The gating block and its hop, in frames, the way `integratedLufs` counts them. */
    const blockFrames = Math.max(1, Math.round(sampleRate * BLOCK_SECONDS));
    const hopFrames = Math.max(1, Math.round(blockFrames * (1 - BLOCK_OVERLAP)));

    /** How many hops one block and the short-term window hold. */
    const blockHops = Math.max(1, Math.round(blockFrames / hopFrames));
    const shortTermHops = Math.max(blockHops, Math.round((sampleRate * SHORT_TERM_SECONDS) / hopFrames));

    // Sized once. `hopRing` is the short-term window's ring of hop energies and
    // holds the momentary window too (it is the last `blockHops` of it), so one
    // ring answers both.
    const hopRing = new Float64Array(shortTermHops);
    let hopCount = 0;
    let hopEnergy = 0;
    let hopFramesFilled = 0;
    let momentarySum = 0;
    let shortTermSum = 0;

    /**
     * The integrated measurement's histogram: per bin, the SUM of the gating-block
     * powers that fell in it and how many blocks that was. Fixed at
     * `HISTOGRAM_BINS` for the meter's whole life, so a Play of any length is
     * measured in constant memory and a reading never walks a block list. Blocks
     * below the absolute gate are not stored: they can never pass either gate.
     */
    const binSum = new Float64Array(HISTOGRAM_BINS);
    const binCount = new Uint32Array(HISTOGRAM_BINS);

    /**
     * What the histogram holds, for a panel or a test: `blocks` is how many gating
     * blocks it has taken since the reset, and `lastReadBins` how many bins the
     * newest integrated reading walked — the cost of a reading, which does not
     * depend on `blocks`.
     */
    const stats = { bins: HISTOGRAM_BINS, blocks: 0, lastReadBins: 0 };

    /** The largest true peak since the last reset, as a magnitude. */
    let peak = 0;

    const shelf = weighting.shelf;
    const highpass = weighting.highpass;
    const shelfState = newSection();
    const highpassState = newSection();
    const detector = {
      historyLeft: new Float64Array(TRUE_PEAK_TAPS_PER_PHASE),
      historyRight: new Float64Array(TRUE_PEAK_TAPS_PER_PHASE),
      index: 0,
    };

    /** The object `read()` fills in: one allocation, at create time. */
    const reading = { momentary: -Infinity, short_term: -Infinity, integrated: -Infinity, true_peak_db: -Infinity };

    /** @returns {void} the integrated measurement's own state, given back. */
    function resetIntegrated() {
      binSum.fill(0);
      binCount.fill(0);
      stats.blocks = 0;
      stats.lastReadBins = 0;
    }

    /**
     * Put the meter back to silence. The histogram is cleared, not reallocated, so
     * a Play never allocates.
     * @returns {void}
     */
    function reset() {
      shelfState.left.fill(0);
      shelfState.right.fill(0);
      highpassState.left.fill(0);
      highpassState.right.fill(0);
      detector.historyLeft.fill(0);
      detector.historyRight.fill(0);
      detector.index = 0;
      hopRing.fill(0);
      hopCount = 0;
      hopEnergy = 0;
      hopFramesFilled = 0;
      momentarySum = 0;
      shortTermSum = 0;
      peak = 0;
      resetIntegrated();
    }

    /**
     * Put one gating block's mean-square power in the histogram: one `log10` (the
     * loudness that names the bin) and two array adds, ten times a second while a
     * song plays. A block at or below the absolute gate is dropped — neither gate
     * could ever let it through.
     * @param {number} power the block's mean-square power
     * @returns {void}
     */
    function storeBlock(power) {
      if (!(power > 0)) return;
      const loudness = loudnessOf(power);
      if (!(loudness > HISTOGRAM_FLOOR_LUFS)) return;
      let bin = Math.floor((loudness - HISTOGRAM_FLOOR_LUFS) / HISTOGRAM_BIN_LU);
      if (bin < 0) bin = 0;
      else if (bin >= HISTOGRAM_BINS) bin = HISTOGRAM_BINS - 1;
      binSum[bin] += power;
      binCount[bin] += 1;
      stats.blocks += 1;
    }

    /**
     * One hop of audio finished: roll it into the two windows, and — every
     * fourth hop — store the 400 ms block the integrated gate reads.
     * @returns {void}
     */
    function completeHop() {
      const slot = hopCount % shortTermHops;
      // The values leaving the two windows are read BEFORE the slot is
      // overwritten: the short-term window lets go of the oldest hop, and the
      // momentary window of the hop `blockHops` back.
      if (hopCount >= shortTermHops) shortTermSum -= hopRing[slot];
      if (hopCount >= blockHops) {
        const leaving = (hopCount - blockHops) % shortTermHops;
        momentarySum -= hopRing[leaving];
      }
      hopRing[slot] = hopEnergy;
      shortTermSum += hopEnergy;
      momentarySum += hopEnergy;
      hopCount += 1;
      hopEnergy = 0;
      hopFramesFilled = 0;
      if (hopCount >= blockHops) {
        // `momentarySum` is exactly the last `blockHops` hops, which is one
        // gating block: the power `server/loudness.js` would put in its list. A
        // block is stored at EVERY hop (the same 75 % overlap it measures), so
        // the gate sees the very same set of blocks a render's does.
        storeBlock(momentarySum / blockFrames);
      }
    }

    /**
     * Feed one block of the master through the meter, in place: nothing is
     * written back, and nothing is allocated.
     * @param {Float32Array|Float64Array} left
     * @param {Float32Array|Float64Array|null} right
     * @param {number} frames
     * @returns {void}
     */
    function process(left, right, frames) {
      if (!left || typeof left.length !== "number") return;
      const count = Math.trunc(Number(frames));
      if (!(count > 0)) return;
      const end = Math.min(left.length, count);
      if (!(end > 0)) return;
      const hasRight = Boolean(right) && typeof right.length === "number";
      const rightEnd = hasRight ? Math.min(right.length, end) : 0;
      for (let index = 0; index < end; index += 1) {
        const inLeft = finiteSample(left[index]);
        const inRight = hasRight && index < rightEnd ? finiteSample(right[index]) : inLeft;

        // The K-weighting: the shelf into the high-pass, per channel, exactly as
        // `applyBiquad(highpass, applyBiquad(shelf, samples))` does it there.
        const shelfLeft = sectionStep(shelf, shelfState.left, inLeft);
        const shelfRight = sectionStep(shelf, shelfState.right, inRight);
        const weightedLeft = sectionStep(highpass, highpassState.left, shelfLeft);
        const weightedRight = sectionStep(highpass, highpassState.right, shelfRight);

        hopEnergy += weightedLeft * weightedLeft + weightedRight * weightedRight;
        hopFramesFilled += 1;
        if (hopFramesFilled >= hopFrames) completeHop();

        const framePeak = truePeakStep(detector, inLeft, inRight);
        if (framePeak > peak) peak = framePeak;
      }
    }

    /**
     * The gated integrated loudness of every block since the reset — the two
     * passes `integratedLufs()` makes, over the histogram instead of the list.
     *
     * The first pass is the mean power of every block above the absolute gate
     * (that is everything the histogram holds); the second keeps only the bins
     * whose own mean power clears the relative gate, ten LU below the first
     * pass's mean. Both are walks of `HISTOGRAM_BINS`, so the reading costs the
     * same after an hour as after a second.
     * @returns {number} LUFS, or -Infinity when no block clears the gates
     */
    function integratedLoudness() {
      stats.lastReadBins = HISTOGRAM_BINS;
      let above = 0;
      let aboveCount = 0;
      for (let bin = 0; bin < HISTOGRAM_BINS; bin += 1) {
        const count = binCount[bin];
        if (count === 0) continue;
        above += binSum[bin];
        aboveCount += count;
      }
      if (aboveCount === 0) return -Infinity;
      const threshold = (above / aboveCount) * RELATIVE_GATE_POWER;
      let gated = 0;
      let gatedCount = 0;
      for (let bin = 0; bin < HISTOGRAM_BINS; bin += 1) {
        const count = binCount[bin];
        if (count === 0) continue;
        const sum = binSum[bin];
        // A bin is judged by the mean of the blocks in it: the only thing the
        // histogram costs, and at most half a bin (0.05 LU) of it.
        if (sum / count <= threshold) continue;
        gated += sum;
        gatedCount += count;
      }
      if (gatedCount === 0) return -Infinity;
      return loudnessOf(gated / gatedCount);
    }

    /**
     * The readings as they stand now, into the same object every time.
     *
     * A window that is not full yet (the first 400 ms of a Play) reads the audio
     * it does hold, so the master strip shows a number from the first hop on
     * instead of nothing.
     * @returns {{momentary: number, short_term: number, integrated: number,
     *            true_peak_db: number}}
     */
    function read() {
      const momentaryHops = hopCount < blockHops ? hopCount : blockHops;
      reading.momentary = momentaryHops > 0 ? loudnessOf(momentarySum / (momentaryHops * hopFrames)) : -Infinity;
      const shortHops = hopCount < shortTermHops ? hopCount : shortTermHops;
      reading.short_term = shortHops > 0 ? loudnessOf(shortTermSum / (shortHops * hopFrames)) : -Infinity;
      reading.integrated = integratedLoudness();
      reading.true_peak_db = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
      return reading;
    }

    return {
      rate: sampleRate,
      blockFrames: blockFrames,
      hopFrames: hopFrames,
      process: process,
      read: read,
      reset: reset,
      stats: stats,
    };
  }

  const api = {
    create: create,
    DENORMAL_FLOOR: DENORMAL_FLOOR,
    BLOCK_SECONDS: BLOCK_SECONDS,
    BLOCK_OVERLAP: BLOCK_OVERLAP,
    ABSOLUTE_GATE_LUFS: ABSOLUTE_GATE_LUFS,
    RELATIVE_GATE_LU: RELATIVE_GATE_LU,
    LOUDNESS_OFFSET: LOUDNESS_OFFSET,
    SHORT_TERM_SECONDS: SHORT_TERM_SECONDS,
    SHELF: SHELF,
    HIGHPASS: HIGHPASS,
    TRUE_PEAK_OVERSAMPLE: TRUE_PEAK_OVERSAMPLE,
    TRUE_PEAK_TAPS: TRUE_PEAK_TAPS,
    TRUE_PEAK_PHASES: Object.freeze(TRUE_PEAK_PHASES),
    HISTOGRAM_BINS: HISTOGRAM_BINS,
    HISTOGRAM_BIN_LU: HISTOGRAM_BIN_LU,
    HISTOGRAM_FLOOR_LUFS: HISTOGRAM_FLOOR_LUFS,
  };

  if (typeof globalThis !== "undefined") globalThis.StudioMeter = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();