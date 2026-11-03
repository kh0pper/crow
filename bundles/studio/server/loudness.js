/**
 * Loudness measurement — ITU-R BS.1770-4 integrated loudness, plus a 4x
 * oversampled true-peak estimate.
 *
 * A render the agent cannot hear is measured instead: `integratedLufs()` says
 * how loud the whole thing reads on the BS.1770 scale (the number streaming
 * services normalise to) and `truePeakDb()` says how close it comes to
 * clipping once a real converter's reconstruction filter has had its say.
 *
 * ## The K-weighting filter
 *
 * Two biquads in series: a high-shelf pre-filter (the "head" model, +4 dB above
 * ~1.7 kHz) and an RLB high-pass at ~38 Hz (the "acoustic" model). The standard
 * publishes the coefficients only for 48 kHz, so they are DERIVED here for the
 * sample rate actually in hand, from the reference implementation's parameters
 * (`pyloudnorm` / libebur128), with the bilinear transform pre-warped by
 * `K = tan(pi f0 / fs)`:
 *
 *   shelf   f0 = 1681.974450955533 Hz, Q = 0.7071752369554196, gain = +4 dB
 *   highpass f0 = 38.13547087602444 Hz, Q = 0.5003270373238773
 *
 * with the shelf's intermediate gain `Vb = Vh^0.4996667741545416`. At 48 kHz
 * the derived numbers come out at the published ones, which is why a 997 Hz
 * full-scale sine in one channel reads -3.01 LUFS and in both channels 0.0.
 *
 * ## Gating
 *
 * Blocks are 400 ms with 75 % overlap (a 100 ms hop). Each block's weighted
 * mean square becomes a loudness, blocks below the absolute gate (-70 LUFS) are
 * dropped, the mean of what is left sets the relative gate (-10 LU below it),
 * and the result is the loudness of the mean power of the blocks that clear
 * both gates. Silence — no block clearing either gate — is `-Infinity`, not a
 * number, so a caller can tell "no audio" from "very quiet".
 *
 * Channel weights are 1.0 for left and right; 1a is stereo only, and the 5.1
 * weight table does not apply.
 *
 * No I/O and no dependencies: both functions take plain sample arrays.
 */

/** The high-shelf pre-filter's reference parameters (48 kHz published form). */
const SHELF = Object.freeze({ gain_db: 4.0, f0: 1681.974450955533, q: 0.7071752369554196 });

/** The RLB high-pass's reference parameters. */
const HIGHPASS = Object.freeze({ f0: 38.13547087602444, q: 0.5003270373238773 });

/** The shelf's intermediate gain is `Vh` raised to this exponent. */
const VB_EXPONENT = 0.4996667741545416;

/** One gating block, in seconds. */
const BLOCK_SECONDS = 0.4;

/** Blocks overlap by this fraction, so the hop is a quarter of a block. */
const BLOCK_OVERLAP = 0.75;

/** The absolute gate, in LUFS. */
const ABSOLUTE_GATE_LUFS = -70;

/** The relative gate is this many LU below the ungated mean. */
const RELATIVE_GATE_LU = -10;

/** BS.1770's offset: a 997 Hz 0 dBFS sine in one channel reads -3.01 LUFS. */
const LOUDNESS_OFFSET = -0.691;

/** Weights per channel: left and right both count fully. */
const CHANNEL_WEIGHTS = Object.freeze([1.0, 1.0]);

/** How many extra samples per input sample the true-peak meter interpolates. */
const TRUE_PEAK_OVERSAMPLE = 4;

/** Taps in the interpolation filter's prototype (>= 48, per the plan). */
const TRUE_PEAK_TAPS = 48;

/** Taps per polyphase branch. */
const TRUE_PEAK_TAPS_PER_PHASE = TRUE_PEAK_TAPS / TRUE_PEAK_OVERSAMPLE;

/**
 * The prototype's centre tap. A multiple of the oversampling factor, so the
 * phase-0 branch is a pure delay and reconstructs the original samples.
 */
const TRUE_PEAK_CENTER = TRUE_PEAK_TAPS / 2;

/** The polyphase branches, built once (they depend only on the constants). */
const TRUE_PEAK_PHASES = buildInterpolationPhases();

/**
 * Integrated loudness of a stereo signal, in LUFS.
 *
 * @param {Float32Array|Float64Array|number[]} left the left channel
 * @param {Float32Array|Float64Array|number[]} right the right channel
 * @param {number} sampleRate samples per second
 * @returns {number} LUFS, or `-Infinity` when the signal is silence (or
 *   shorter than one 400 ms gating block)
 */
export function integratedLufs(left, right, sampleRate) {
  const rate = Number(sampleRate);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error("integratedLufs needs a positive sample rate");

  const inputs = [left, right].filter((samples) => samples && typeof samples.length === "number" && samples.length > 0);
  if (inputs.length === 0) return -Infinity;

  const shelf = highShelfCoefficients(SHELF, rate);
  const highpass = highPassCoefficients(HIGHPASS, rate);
  const filtered = inputs.map((samples) => applyBiquad(highpass, applyBiquad(shelf, samples)));

  const blockSize = Math.max(1, Math.round(rate * BLOCK_SECONDS));
  const hop = Math.max(1, Math.round(blockSize * (1 - BLOCK_OVERLAP)));
  const frames = Math.min(...filtered.map((channel) => channel.length));
  if (frames < blockSize) return -Infinity;

  // One weighted mean-square power per block, the gate's unit of currency.
  const powers = [];
  for (let start = 0; start + blockSize <= frames; start += hop) {
    let power = 0;
    for (let channel = 0; channel < filtered.length; channel += 1) {
      const samples = filtered[channel];
      let energy = 0;
      for (let index = start; index < start + blockSize; index += 1) energy += samples[index] * samples[index];
      power += CHANNEL_WEIGHTS[channel] * (energy / blockSize);
    }
    powers.push(power);
  }

  const aboveAbsoluteGate = powers.filter((power) => loudnessOf(power) > ABSOLUTE_GATE_LUFS);
  if (aboveAbsoluteGate.length === 0) return -Infinity;

  const absoluteMean = mean(aboveAbsoluteGate);
  const relativeThreshold = loudnessOf(absoluteMean) + RELATIVE_GATE_LU;

  const gated = powers.filter(
    (power) => loudnessOf(power) > ABSOLUTE_GATE_LUFS && loudnessOf(power) > relativeThreshold,
  );
  if (gated.length === 0) return -Infinity;

  return loudnessOf(mean(gated));
}

/**
 * True peak in dBTP: the largest magnitude the signal reaches between samples,
 * estimated by 4x oversampling with a windowed-sinc polyphase filter.
 *
 * The interpolation filter is a 48-tap Blackman-windowed sinc whose cutoff sits
 * at the input's Nyquist, normalised to unity DC gain per branch. Phases 1..3
 * are the values a converter's reconstruction filter would put between the
 * input samples; phase 0 would only repeat them, so it is skipped.
 *
 * @param {Float32Array|Float64Array|number[]} left
 * @param {Float32Array|Float64Array|number[]} right
 * @param {number} sampleRate samples per second (part of the signature so a
 *   caller cannot forget which rate the samples are in; the filter is built
 *   from the oversampling factor alone)
 * @returns {number} dBTP, or `-Infinity` for silence
 */
export function truePeakDb(left, right, sampleRate) {
  const rate = Number(sampleRate);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error("truePeakDb needs a positive sample rate");

  let peak = 0;
  for (const samples of [left, right]) {
    if (!samples || typeof samples.length !== "number") continue;
    const channelPeak = interpolatedPeak(samples);
    if (channelPeak > peak) peak = channelPeak;
  }
  return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
}

/**
 * The largest magnitude in one channel, between samples as well as on them.
 * @param {Float32Array|Float64Array|number[]} samples
 * @returns {number}
 */
function interpolatedPeak(samples) {
  let peak = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.abs(samples[index]);
    if (value > peak) peak = value;
  }
  // Phase 0 is the input samples again (delayed by the filter's centre), and
  // the loop above already took their largest magnitude.
  for (let phase = 1; phase < TRUE_PEAK_PHASES.length; phase += 1) {
    const branch = TRUE_PEAK_PHASES[phase];
    for (let index = 0; index < samples.length; index += 1) {
      let sum = 0;
      for (let tap = 0; tap < branch.length; tap += 1) {
        const at = index - tap;
        if (at < 0) break; // earlier samples are zero, and so is every later tap
        sum += samples[at] * branch[tap];
      }
      const value = Math.abs(sum);
      if (value > peak) peak = value;
    }
  }
  return peak;
}

/**
 * The polyphase branches of the 4x interpolation filter.
 * @returns {Float64Array[]} one branch per phase, each summing to ~1
 */
function buildInterpolationPhases() {
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
 * The high-shelf pre-filter's biquad coefficients for one sample rate.
 *
 * The bilinear transform of an RBJ-style high shelf, with the intermediate gain
 * `Vb = Vh^0.4996…` that the reference implementation uses (it puts the shelf's
 * knee where the standard's 48 kHz numbers put it). The result is normalised so
 * `a0` is 1.
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
 * Run one biquad over a channel (direct form I, transposed state).
 * @param {{b0: number, b1: number, b2: number, a1: number, a2: number}} coefficients
 * @param {Float32Array|Float64Array|number[]} samples
 * @returns {Float64Array} a new array of the same length
 */
function applyBiquad(coefficients, samples) {
  const { b0, b1, b2, a1, a2 } = coefficients;
  const out = new Float64Array(samples.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const x = samples[index];
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    out[index] = y;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
  }
  return out;
}

/**
 * The loudness of one block's weighted mean-square power.
 * @param {number} power
 * @returns {number} LUFS, or `-Infinity` for a silent block
 */
function loudnessOf(power) {
  return power > 0 ? LOUDNESS_OFFSET + 10 * Math.log10(power) : -Infinity;
}

/**
 * @param {number[]} values
 * @returns {number}
 */
function mean(values) {
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}