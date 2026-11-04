/**
 * Studio resampler — windowed-sinc sample-rate conversion, pure JavaScript.
 *
 * A take is recorded at whatever rate the recording context ran at, and it is
 * played into a context that may be at another rate. Nothing in Studio lets a
 * Web Audio node or `decodeAudioData` do that conversion (spec §5.1, the parity
 * rule): the audio that reaches a PCM voice is the same bytes in a browser and
 * in a Node render, so the conversion has to be OUR arithmetic.
 *
 * It is a classic script (no `import`/`export`): it assigns
 * `globalThis.StudioResample` for the worklet/page scope and `module.exports`
 * when a CommonJS `module` exists. `engine/package.json` marks that directory
 * `"commonjs"` so a Node `require()` of this file works inside the bundle's
 * ESM tree.
 *
 * ## The filter
 *
 * 32 taps, 16 either side of the output sample's position in the input, each
 * one a sinc at the cutoff times a Blackman window, plus a normalisation so a
 * constant input stays constant (the window otherwise costs a few percent of
 * the level). The cutoff is `min(fromRate, toRate) / 2 * 0.95`: at or below
 * Nyquist for both rates, with a little room for the window's transition band.
 *
 * The kernel spans a fixed 16 input samples either side, whatever the ratio.
 * That is right for the ratios Studio meets (44.1/48/88.2/96 kHz, at most
 * about 2:1); a much larger downsampling ratio would get a wide transition
 * band and weak alias rejection, and would need a kernel that scales with it.
 *
 * ## Why it is bit-identical in Chromium and Node
 *
 * Only `Math.floor`, `Math.round`, `Math.sin`, `Math.cos` and IEEE double
 * `+ - * /`, summed in a fixed tap order, with `Float32Array` output. There is
 * no `Math.fround` shortcut, no lookup table built from a host-specific value
 * and no `Math.random`; both hosts run the same V8, and the same inputs produce
 * the same bits. The fade and voice bookkeeping that uses this lives in
 * `studio-processor.js` and is integer arithmetic for the same reason.
 */
(function () {
  "use strict";

  /** Taps on each side of the interpolation point, so 32 taps in all. */
  const HALF_TAPS = 16;

  /** The whole kernel: `HALF_TAPS` behind, `HALF_TAPS` ahead. */
  const TAPS = HALF_TAPS * 2;

  /** The first tap's position, in input samples, relative to the point. */
  const FIRST_TAP = -(HALF_TAPS - 1);

  /** Where the cutoff sits below the lower Nyquist, leaving room for the window. */
  const CUTOFF_SCALE = 0.95;

  /** The downsampling bandwidth, normalised to the input rate. */
  const MAX_CUTOFF = 0.5;

  /** @returns {number} the value when it is a finite number above zero, else 0. */
  function positive(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
  }

  /**
   * One tap of the kernel: a sinc at `cutoff` (cycles per input sample) times a
   * Blackman window over the whole 32-tap span.
   * @param {number} offset the tap's distance from the interpolation point, in input samples
   * @param {number} cutoff cycles per input sample, `0 < cutoff <= 0.5`
   * @returns {number} the tap's weight
   */
  function weightAt(offset, cutoff) {
    const across = Math.abs(offset) / HALF_TAPS;
    if (across >= 1) return 0;
    // Blackman in its centred form: 1 at the centre, 0 at either end of the
    // span, so the window costs nothing at the interpolation point itself.
    const window =
      0.42 + 0.5 * Math.cos(Math.PI * across) + 0.08 * Math.cos(2 * Math.PI * across);
    const angle = 2 * Math.PI * cutoff * offset;
    const sinc = angle === 0 ? 1 : Math.sin(angle) / angle;
    return 2 * cutoff * sinc * window;
  }

  /**
   * Convert channels from one sample rate to another.
   *
   * The output length is `round(input.length * toRate / fromRate)`, which is
   * the same duration in seconds. Equal rates return copies of the input, so a
   * take recorded in the context's own rate is played back untouched.
   *
   * @param {Float32Array[]} channels the input channels, one array each
   * @param {number} fromRate the rate `channels` are at, in Hz
   * @param {number} toRate the rate to convert to, in Hz
   * @returns {Float32Array[]} new channels, one per input channel
   */
  function toRate(channels, fromRate, toRate) {
    const list = Array.isArray(channels) ? channels : [];
    const from = positive(fromRate);
    const to = positive(toRate);
    if (from === 0 || to === 0) {
      throw new Error("StudioResample: both rates have to be numbers above zero");
    }
    if (list.length === 0) return [];

    if (from === to) {
      // The identity is worth its own branch: it is the common case (a take
      // recorded at the context's rate), and it has to be exact.
      const copies = [];
      for (let channel = 0; channel < list.length; channel += 1) {
        copies.push(Float32Array.from(list[channel]));
      }
      return copies;
    }

    const inputLength = list[0] ? list[0].length : 0;
    const outputLength = Math.round((inputLength * to) / from);
    // Input samples per output sample. Not a whole number in general, which is
    // exactly why the taps are placed per output sample rather than by copying.
    const step = from / to;
    const cutoff = CUTOFF_SCALE * MAX_CUTOFF * Math.min(1, to / from);

    // The taps' weights depend only on the output index, so they are worked
    // out once per output sample and shared by every channel (same values,
    // same summing order: the result is unchanged, the trig work is not
    // repeated per channel). Channels are expected to be the same length; a
    // shorter one simply finds fewer taps inside it.
    const output = [];
    for (let channel = 0; channel < list.length; channel += 1) {
      output.push(new Float32Array(outputLength));
    }
    const weights = new Float64Array(TAPS);
    for (let index = 0; index < outputLength; index += 1) {
      const centre = index * step;
      const base = Math.floor(centre);
      for (let tap = 0; tap < TAPS; tap += 1) {
        const source = base + FIRST_TAP + tap;
        weights[tap] = source < 0 ? 0 : weightAt(centre - source, cutoff);
      }
      for (let channel = 0; channel < list.length; channel += 1) {
        const input = list[channel];
        const length = input ? input.length : 0;
        let sum = 0;
        let total = 0;
        for (let tap = 0; tap < TAPS; tap += 1) {
          const source = base + FIRST_TAP + tap;
          if (source < 0 || source >= length) continue;
          const weight = weights[tap];
          sum += input[source] * weight;
          total += weight;
        }
        // Dividing by the taps that were actually there keeps the level right
        // where the kernel runs off the end of the input, and makes a constant
        // input convert to the same constant.
        output[channel][index] = total === 0 ? 0 : sum / total;
      }
    }
    return output;
  }

  const api = { toRate: toRate, TAPS: TAPS, HALF_TAPS: HALF_TAPS };

  if (typeof globalThis !== "undefined") globalThis.StudioResample = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();