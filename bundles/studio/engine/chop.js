/**
 * Studio chop — transient detection ("by hits") and grid slicing, plain JS.
 *
 * A chopped sample is a list of `{start_frame, end_frame}` ranges, and the pads
 * then play those ranges (see `sampler-voice.js`). Two ways to get one:
 *
 *   `byHits` listens for the attacks in a loop — a drum break has eight of them
 *   and a sampler wants a pad per hit — with spectral flux over a short-time
 *   Fourier transform and an adaptive threshold;
 *
 *   `byGrid` cuts a sample into 2, 4, 8, 16, 32 or 64 equal pieces.
 *
 * Hand chopping needs none of this: the panel edits a sample's slices directly
 * and sends one `sample.set_slices`.
 *
 * It is a classic script (no `import`/`export`): it assigns
 * `globalThis.StudioChop` for the worker/page scope and `module.exports` when a
 * CommonJS `module` exists. `engine/package.json` marks that directory
 * `"commonjs"`, so a Node `require()` of this file works inside the bundle's
 * ESM tree, and `chop-worker.js` pulls it in with `importScripts` so a browser
 * runs the very same arithmetic.
 *
 * ## The analysis
 *
 * The channels are averaged to one mono signal (so a chopped stereo file and a
 * chopped mono file of the same take agree). Frames are 1024 samples of a
 * periodic Hann window, hop 256, and each frame is CENTRED on its hop position:
 * frame `i` covers samples `i*256 - 512 … i*256 + 511`, zero-padded outside the
 * signal. Centring matters. A frame that only starts at the hop position fills
 * with the attack from its right edge, where the window weighs almost nothing,
 * so its magnitude rise peaks about two hops before the hit and every detected
 * onset lands early; with the frame centred on the hop, the rise peaks on the
 * hop nearest the attack, which is what "onset frame = hop index × 256" is
 * meant to mean. Each onset is then moved back to the nearest preceding zero
 * crossing within 128 samples, so a slice starts on a crossing and not on a step
 * of sample value (that click would be audible on every pad hit).
 *
 * The spectrum comes from a radix-2 FFT written here, in place, on two
 * `Float64Array`s. No library, no lookup table built from a host value: the
 * twiddles are `Math.cos`/`Math.sin` of `2πk/1024` computed once per run.
 *
 * ## The threshold
 *
 * Spectral flux is the sum over bins of the positive magnitude differences to
 * the previous frame (frame -1 counts as silence, so a sample that starts with
 * a hit finds its first onset at 0). A fixed threshold would be wrong for both
 * a quiet break and a loud one, so each frame's threshold is local:
 *
 *     median(flux over ±8 frames) + k × MAD(±8),  k = 0.5 + (1 − sensitivity) × 3.5
 *
 * The median and the median absolute deviation ignore the very peaks they are
 * testing, so a frame's own onset cannot raise its own threshold. Sensitivity 1
 * is `k = 0.5` (everything a little above the local noise gets through),
 * sensitivity 0 is `k = 4` (only unambiguous attacks).
 *
 * An onset is a local maximum of the flux that is above its threshold and at
 * least `minGapMs` after the previous one — the gap is what keeps a cymbal's
 * noisy rise from becoming four slices. The threshold carries a relative margin
 * on top (`THRESHOLD_MARGIN`): a steady noise floor's flux hovers a few percent
 * above its own median now and then, which the MAD term alone does not clear,
 * while an attack clears it hundreds of times over. When more than 64 onsets
 * survive, the 64 strongest are kept (the pad-bank limit) and put back in time
 * order.
 *
 * ## Determinism
 *
 * Only IEEE double `+ - * /`, `Math.sqrt`, `Math.cos`, `Math.sin`, `Math.abs`
 * and `Math.floor`, in a fixed order, over `Float64Array` working space, with
 * fixed-order loops and no `Math.random`. Chromium and Node run the same V8, so
 * the same channels produce the same slices in both.
 */
(function () {
  "use strict";

  /** Samples per analysis frame (a power of two, as the FFT requires). */
  const FFT_SIZE = 1024;

  /** Samples between frame centres. */
  const HOP = 256;

  /** How far a centred frame reaches either side of its hop position. */
  const HALF_WINDOW = FFT_SIZE / 2;

  /** Bins 0…512 inclusive: a real signal's spectrum is symmetric above that. */
  const BIN_COUNT = FFT_SIZE / 2 + 1;

  /** Frames either side of a frame that its threshold is measured over. */
  const NEIGHBOURHOOD = 8;

  /** The most slices a sample may have (the limit in `server/doc.js`). */
  const MAX_SLICES = 64;

  /** A peak below this amplitude is -60 dBFS: below it, a sample is silent. */
  const SILENCE_PEAK = 0.001;

  /** Audio before the first onset is its own slice only past this much time. */
  const LEAD_IN_MS = 10;

  /** How far back from a detected onset a zero crossing is looked for, in samples. */
  const ZERO_CROSSING_BACK = 128;

  /** The threshold multiplier at sensitivity 0.5. */
  const DEFAULT_SENSITIVITY = 0.5;

  /** The smallest gap between two onsets, in milliseconds. */
  const DEFAULT_MIN_GAP_MS = 40;

  /** The threshold multiplier at sensitivity 1 (the lowest one). */
  const THRESHOLD_BASE = 0.5;

  /** How much of the multiplier sensitivity 0 adds. */
  const THRESHOLD_RANGE = 3.5;

  /**
   * How far above the local median-plus-MAD bar an onset has to sit, as a
   * factor. A noise floor's flux is not Gaussian: its MAD is a few percent of
   * its median, yet its loudest frames run ten percent or more above it, so a
   * bare median + k·MAD line is straddled by noise on every quiet stretch of a
   * sample. An attack clears the line by two orders of magnitude, so half again
   * costs nothing real and excludes what the floor does on its own.
   */
  const THRESHOLD_MARGIN = 1.5;

  /** The divisions `byGrid` accepts. */
  const GRID_DIVISIONS = [2, 4, 8, 16, 32, 64];

  /** @returns {number} the value when it is a finite number, else the fallback. */
  function finiteOr(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  /** @returns {number} the value held between two bounds. */
  function clamp(value, low, high) {
    if (value < low) return low;
    if (value > high) return high;
    return value;
  }

  /**
   * Average the channels to one mono signal, the longest channel's length.
   *
   * A missing or shorter channel counts as silence, so the divisor is always
   * the number of channels: a stereo take mixed down is at its real level
   * rather than doubled.
   *
   * @param {Float32Array[]|Float64Array[]} channels the sample's channels
   * @returns {Float64Array} the mono mix, in doubles so the arithmetic is one path
   */
  function monoMix(channels) {
    const list = Array.isArray(channels) ? channels : [];
    if (list.length === 0) return new Float64Array(0);
    let frames = 0;
    for (let channel = 0; channel < list.length; channel += 1) {
      const source = list[channel];
      const length = source && typeof source.length === "number" ? source.length : 0;
      if (length > frames) frames = length;
    }
    const mono = new Float64Array(frames);
    for (let channel = 0; channel < list.length; channel += 1) {
      const source = list[channel];
      if (!source) continue;
      const length = Math.min(source.length, frames);
      for (let at = 0; at < length; at += 1) mono[at] += source[at];
    }
    for (let at = 0; at < frames; at += 1) mono[at] /= list.length;
    return mono;
  }

  /** @returns {Float64Array} a periodic Hann window over one analysis frame. */
  function analysisWindow() {
    const window = new Float64Array(FFT_SIZE);
    for (let at = 0; at < FFT_SIZE; at += 1) {
      window[at] = 0.5 - 0.5 * Math.cos((2 * Math.PI * at) / FFT_SIZE);
    }
    return window;
  }

  /**
   * The forward transform's twiddles for every butterfly stage.
   * @returns {{cos: Float64Array, sin: Float64Array}} `cos`/`sin` of `2πk/FFT_SIZE`
   */
  function twiddles() {
    const half = FFT_SIZE / 2;
    const cos = new Float64Array(half);
    const sin = new Float64Array(half);
    for (let at = 0; at < half; at += 1) {
      const angle = (2 * Math.PI * at) / FFT_SIZE;
      cos[at] = Math.cos(angle);
      sin[at] = Math.sin(angle);
    }
    return { cos: cos, sin: sin };
  }

  /**
   * In-place radix-2 Cooley–Tukey FFT of `FFT_SIZE` complex points.
   *
   * The twiddles are indexed from the table rather than computed per butterfly,
   * so the factors used are the same numbers on every stage of every run. The
   * imaginary part of a real input starts at zero; nothing here looks at it.
   *
   * @param {Float64Array} re real parts, length `FFT_SIZE`
   * @param {Float64Array} im imaginary parts, length `FFT_SIZE`
   * @param {Float64Array} cos the twiddle cosines
   * @param {Float64Array} sin the twiddle sines
   */
  function transform(re, im, cos, sin) {
    const size = re.length;
    for (let point = 1, reversed = 0; point < size; point += 1) {
      let bit = size >> 1;
      for (; reversed & bit; bit >>= 1) reversed ^= bit;
      reversed ^= bit;
      if (point < reversed) {
        const swappedRe = re[point];
        re[point] = re[reversed];
        re[reversed] = swappedRe;
        const swappedIm = im[point];
        im[point] = im[reversed];
        im[reversed] = swappedIm;
      }
    }
    for (let span = 2; span <= size; span <<= 1) {
      const half = span >> 1;
      const stride = size / span;
      for (let start = 0; start < size; start += span) {
        for (let at = 0; at < half; at += 1) {
          const twiddle = at * stride;
          const factorRe = cos[twiddle];
          const factorIm = -sin[twiddle];
          const low = start + at;
          const high = low + half;
          // (re, im) × (cos, -sin): e^(-2πi·k/n), the forward transform.
          const productRe = re[high] * factorRe - im[high] * factorIm;
          const productIm = re[high] * factorIm + im[high] * factorRe;
          re[high] = re[low] - productRe;
          im[high] = im[low] - productIm;
          re[low] += productRe;
          im[low] += productIm;
        }
      }
    }
  }

  /**
   * The spectral flux of a mono signal, one value per hop position.
   *
   * Frame `0` is compared against silence, so a sample whose first sample is a
   * hit still has an onset at 0 instead of none at all.
   *
   * @param {Float64Array} mono the mono mix
   * @returns {Float64Array} the flux at every hop position, `floor(frames/HOP)+1` long
   */
  function spectralFlux(mono) {
    const frames = Math.floor(mono.length / HOP) + 1;
    const flux = new Float64Array(frames);
    const window = analysisWindow();
    const { cos, sin } = twiddles();
    const re = new Float64Array(FFT_SIZE);
    const im = new Float64Array(FFT_SIZE);
    let previous = new Float64Array(BIN_COUNT);
    let current = new Float64Array(BIN_COUNT);

    for (let frame = 0; frame < frames; frame += 1) {
      const centre = frame * HOP;
      for (let at = 0; at < FFT_SIZE; at += 1) {
        const source = centre - HALF_WINDOW + at;
        re[at] = source >= 0 && source < mono.length ? mono[source] * window[at] : 0;
        im[at] = 0;
      }
      transform(re, im, cos, sin);
      for (let bin = 0; bin < BIN_COUNT; bin += 1) {
        current[bin] = Math.sqrt(re[bin] * re[bin] + im[bin] * im[bin]);
      }
      let rise = 0;
      for (let bin = 0; bin < BIN_COUNT; bin += 1) {
        const difference = current[bin] - previous[bin];
        if (difference > 0) rise += difference;
      }
      flux[frame] = rise;
      const swap = previous;
      previous = current;
      current = swap;
    }
    return flux;
  }

  /**
   * The middle value of a set of numbers (the mean of the two middle ones when
   * the count is even). The input is copied: callers keep their arrays.
   * @param {Float64Array} values the list to take the middle of
   * @returns {number} the median
   */
  function medianOf(values) {
    if (values.length === 0) return 0;
    const sorted = Float64Array.from(values).sort();
    const middle = sorted.length >> 1;
    if (sorted.length % 2 === 1) return sorted[middle];
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }

  /**
   * Each frame's own onset threshold: the local median plus `k` local MADs.
   * @param {Float64Array} flux the spectral flux
   * @param {number} sensitivity 0..1, where 1 is the lowest threshold
   * @returns {Float64Array} the threshold at every hop position
   */
  function adaptiveThresholds(flux, sensitivity) {
    const scale = THRESHOLD_BASE + (1 - sensitivity) * THRESHOLD_RANGE;
    const thresholds = new Float64Array(flux.length);
    for (let frame = 0; frame < flux.length; frame += 1) {
      const low = Math.max(0, frame - NEIGHBOURHOOD);
      const high = Math.min(flux.length - 1, frame + NEIGHBOURHOOD);
      const span = high - low + 1;
      const values = new Float64Array(span);
      for (let at = 0; at < span; at += 1) values[at] = flux[low + at];
      const median = medianOf(values);
      for (let at = 0; at < span; at += 1) values[at] = Math.abs(values[at] - median);
      thresholds[frame] = (median + scale * medianOf(values)) * THRESHOLD_MARGIN;
    }
    return thresholds;
  }

  /**
   * The nearest zero crossing at or before a position, within a fixed reach.
   * @param {Float64Array} mono the mono mix
   * @param {number} position the frame position to walk back from
   * @returns {number} the crossing's sample index, or `position` when there is none
   */
  function zeroCrossingBefore(mono, position) {
    const from = Math.min(position, mono.length - 1);
    const low = Math.max(1, from - ZERO_CROSSING_BACK);
    for (let at = from; at >= low; at -= 1) {
      const previous = mono[at - 1];
      const current = mono[at];
      if ((previous < 0 && current >= 0) || (previous >= 0 && current < 0)) return at;
    }
    return position;
  }

  /**
   * Every local flux maximum above its threshold, one per frame, in time order.
   * @param {Float64Array} mono the mono mix
   * @param {Float64Array} flux the spectral flux
   * @param {Float64Array} thresholds each frame's threshold
   * @returns {{start_frame: number, strength: number}[]} the candidates
   */
  function pickOnsets(mono, flux, thresholds) {
    const onsets = [];
    for (let frame = 0; frame < flux.length; frame += 1) {
      const strength = flux[frame];
      if (!(strength > thresholds[frame]) || !(strength > 0)) continue;
      // A local maximum, counted on the left strictly so a flat run of equal
      // values is one onset (its first frame) and not one per hop.
      if (frame > 0 && !(strength > flux[frame - 1])) continue;
      if (frame + 1 < flux.length && strength < flux[frame + 1]) continue;
      onsets.push({ start_frame: zeroCrossingBefore(mono, frame * HOP), strength: strength });
    }
    onsets.sort((left, right) => left.start_frame - right.start_frame);
    return onsets;
  }

  /**
   * Chop a sample at its attacks.
   *
   * Slices run from each onset to the next and the last runs to the end of the
   * sample. Audio before the first onset is its own slice when the first onset
   * is more than 10 ms in (a pick-up before the first hit is material too), and
   * that lead-in slice is the first to give way to the 64-slice limit.
   *
   * @param {Float32Array[]} channels the sample's channels
   * @param {number} rate the sample's rate, in Hz
   * @param {{sensitivity?: number, minGapMs?: number}} [options]
   *   sensitivity 0..1 (0.5 by default: higher finds more hits) and the smallest
   *   gap allowed between two onsets in milliseconds (40 by default)
   * @returns {{start_frame: number, end_frame: number}[]} the slices, in time order,
   *   or `[]` for a silent sample or one with no detected attack
   */
  function byHits(channels, rate, options) {
    const sampleRate = Number(rate);
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
      throw new Error("StudioChop: byHits needs a sample rate above zero");
    }
    const settings = options && typeof options === "object" ? options : {};
    const sensitivity = clamp(finiteOr(settings.sensitivity, DEFAULT_SENSITIVITY), 0, 1);
    const minGapMs = Math.max(0, finiteOr(settings.minGapMs, DEFAULT_MIN_GAP_MS));

    const mono = monoMix(channels);
    if (mono.length === 0) return [];
    let peak = 0;
    for (let at = 0; at < mono.length; at += 1) {
      const level = Math.abs(mono[at]);
      if (level > peak) peak = level;
    }
    // -60 dBFS: below that there is nothing to find, whatever the noise floor
    // of the analysis would say about it.
    if (peak < SILENCE_PEAK) return [];

    const flux = spectralFlux(mono);
    const thresholds = adaptiveThresholds(flux, sensitivity);
    const candidates = pickOnsets(mono, flux, thresholds);

    const minGapFrames = Math.round((sampleRate * minGapMs) / 1000);
    const spaced = [];
    let previous = -Infinity;
    for (let index = 0; index < candidates.length; index += 1) {
      const onset = candidates[index];
      // At least one frame apart whatever the caller asks for: a slice of no
      // length is not a slice, and two onsets refined onto one crossing are not
      // two onsets.
      if (onset.start_frame - previous < Math.max(1, minGapFrames)) continue;
      // An onset on the very last frame would leave an empty slice behind it.
      if (onset.start_frame >= mono.length) continue;
      spaced.push(onset);
      previous = onset.start_frame;
    }
    // A sound too short for the analysis to find an onset in (a few hundred
    // frames) is still a sound: it is one slice, the whole of it.
    if (spaced.length === 0) return [{ start_frame: 0, end_frame: mono.length }];

    let onsets = spaced;
    if (onsets.length > MAX_SLICES) {
      onsets = Array.from(onsets)
        .sort((left, right) => right.strength - left.strength)
        .slice(0, MAX_SLICES)
        .sort((left, right) => left.start_frame - right.start_frame);
    }

    const leadInFrames = Math.round((sampleRate * LEAD_IN_MS) / 1000);
    const slices = [];
    if (onsets[0].start_frame > leadInFrames) {
      slices.push({ start_frame: 0, end_frame: onsets[0].start_frame });
    }
    for (let index = 0; index < onsets.length; index += 1) {
      const start = onsets[index].start_frame;
      const end = index + 1 < onsets.length ? onsets[index + 1].start_frame : mono.length;
      slices.push({ start_frame: start, end_frame: end });
    }
    // Keeping the 64 strongest onsets can still leave 65 slices when a lead-in
    // slice sits in front of them; the lead-in is the one that goes.
    while (slices.length > MAX_SLICES) slices.shift();
    return slices;
  }

  /**
   * Cut a sample into equal pieces.
   *
   * The pieces tile `[0, frames)` exactly: the last one takes the remainder, so
   * no sample of the source is lost to rounding. A sample shorter than the
   * number of divisions gives the trailing pieces no length rather than
   * overlapping ones.
   *
   * @param {number} frames the sample's length, in samples
   * @param {number} divisions one of 2, 4, 8, 16, 32 or 64
   * @returns {{start_frame: number, end_frame: number}[]} one slice per division
   */
  function byGrid(frames, divisions) {
    const total = Number(frames);
    if (!Number.isFinite(total) || total < 0) {
      throw new Error("StudioChop: byGrid needs a sample length of zero or more");
    }
    const count = Number(divisions);
    if (GRID_DIVISIONS.indexOf(count) === -1) {
      throw new Error("StudioChop: byGrid divides a sample into 2, 4, 8, 16, 32 or 64 slices");
    }
    const length = Math.floor(total);
    const step = Math.max(1, Math.floor(length / count));
    const slices = [];
    for (let index = 0; index < count; index += 1) {
      const start = Math.min(index * step, length);
      const end = index === count - 1 ? length : Math.min((index + 1) * step, length);
      slices.push({ start_frame: start, end_frame: end });
    }
    return slices;
  }

  const api = {
    byHits: byHits,
    byGrid: byGrid,
    FFT_SIZE: FFT_SIZE,
    HOP: HOP,
    MAX_SLICES: MAX_SLICES,
    GRID_DIVISIONS: GRID_DIVISIONS,
  };

  if (typeof globalThis !== "undefined") globalThis.StudioChop = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();