/**
 * Studio's cabinet convolver — a zero-latency, uniformly partitioned FFT
 * convolution, deterministic JavaScript.
 *
 * An amp insert plays its capture through a cabinet: a mono or stereo impulse
 * response of at most one second, convoluted with the insert's audio (plan 1d,
 * Task 13). A direct convolution of a one-second IR would be 48 000 multiplies
 * per sample; the FFT is what makes four amps with a cabinet each cheaper than
 * real time in Node.
 *
 * ## Zero latency, by construction
 *
 * The IR's FIRST 128 samples — the first partition — are convolved directly, in
 * the time domain, on the very frame that arrives, so the cabinet's own onset is
 * heard at the moment it is played. The remaining partitions run on 128-frame
 * blocks in the frequency domain, and the block that is being output at time
 * `mB … mB+B` only ever reads the input of blocks `m-1` and earlier (see the
 * alignment below), which is why the whole thing is causal and reports
 * `latencyFrames: 0`: a track insert may not delay its track (plan 1d, DSP
 * rules).
 *
 * ## The alignment, partition by partition
 *
 * The IR is split into partitions `h_k = h[B + kB … B + (k+1)B)`; the head covers
 * `h[0 … B)`. Input block `x_j` is `B` frames. The contribution of `x_j` through
 * `h_k` starts at output frame `jB + B + kB`, i.e. in output block `j+1+k`.
 *
 * With the overlap-save frame `X_j = FFT([x_{j-1}, x_j])` (2B samples, 2B-point
 * FFT) and `H_k = FFT(h_k)` zero-padded to 2B, the second half of
 * `IFFT(X_j · H_k)` is exactly the block of `x_j ⊛ h_k` that begins at output
 * frame `jB`. So for output block `m` the products that matter all use
 * `j = m-1-k`, and the tail is
 *
 *     tail[m] = second half of IFFT( Σ_k X_{m-1-k} · H_k )
 *
 * — ONE inverse FFT per output block and per channel, however many partitions
 * the IR has, because the sum commutes with the transform. Every `X_{m-1-k}` is
 * already computed when block `m` starts (the newest, `X_{m-1}`, needs blocks
 * `m-2` and `m-1`), which is exactly what makes the tail available on time.
 *
 * ## Determinism and allocation
 *
 * Only IEEE double `+ - * /` and `Math.cos`/`Math.sin`, in one fixed order, so
 * Chromium and node-web-audio-api produce the same bits (the parity rule). Every
 * buffer — the spectra, the accumulators, the FFT work arrays, the per-block
 * tails — is allocated once, in `create()`, and `process()` allocates nothing,
 * whatever block size the host asks for.
 */
(function () {
  "use strict";

  /** The longest cabinet: one second after resampling (plan 1d, Formats). */
  const MAX_SECONDS = 1;

  /** Frames per partition, and the FFT size (two partitions). */
  const PARTITION_FRAMES = 128;
  const FFT_FRAMES = PARTITION_FRAMES * 2;

  /**
   * How many frames past its rate a cabinet may run and still be a cabinet:
   * two, everywhere the limit is checked (the server's upload, the page, this
   * engine). A 44.1 kHz IR shipped as exactly one second is 44101 frames, and
   * that is not a cabinet over the limit.
   */
  const FRAME_TOLERANCE = 2;

  /** The most channels an input or an IR may have. */
  const MAX_CHANNELS = 2;

  /** The plan's sentence for a cabinet longer than a second. */
  function tooLongText(count, frequency) {
    const seconds = (Math.round((count / frequency) * 10) / 10).toFixed(1);
    return `An impulse response is at most 1 second long; this one is ${seconds} s.`;
  }

  /**
   * The longest PCM a cabinet read from a file may hold once it has been
   * resampled to the context's rate.
   *
   * The one-second rule is a rule about the FILE: the page and a render check
   * `sourceFrames <= sourceRate + FRAME_TOLERANCE` at the file's own rate, and
   * resampling multiplies that length by `rate / sourceRate`. So the engine
   * accepts exactly the length that follows from a file that passed — a 44.1 kHz
   * starter cabinet of 44101 frames is 176404 frames at 176.4 kHz and 192002 at
   * 192 kHz, and both are cabinets — and refuses a payload whose PCM is longer
   * than its own stated source could ever resample to.
   * @param {unknown} sourceFrames the frames the file held
   * @param {unknown} sourceRate the file's own rate, in Hz
   * @param {unknown} rate the rate the PCM was resampled to, in Hz
   * @returns {number|null} the longest accepted length, or null with no source
   */
  function resampledLimit(sourceFrames, sourceRate, rate) {
    const count = Math.max(0, Math.trunc(Number(sourceFrames) || 0));
    const from = Number(sourceRate);
    const to = Number(rate);
    if (!Number.isFinite(from) || from <= 0) return null;
    if (!Number.isFinite(to) || to <= 0) return null;
    // `Math.ceil`, because `StudioResample.toRate` rounds its output length up
    // or down; the limit is never smaller than what it can produce.
    return Math.ceil((count * to) / from);
  }

  /**
   * The refusal for one cabinet, or null when it is a cabinet.
   *
   * Judged ONCE, at the file's own rate, when the caller says where the PCM came
   * from (`sourceFrames` and `sourceRate`, which the page and a render both
   * pass). Without that, the length is judged at the rate the PCM is in, which
   * is what a caller handing over PCM it made itself has.
   * @param {unknown} frames the frames the PCM holds
   * @param {unknown} rate the rate the PCM is in, in Hz
   * @param {unknown} [sourceFrames] the frames the file held, if the PCM came from one
   * @param {unknown} [sourceRate] the file's own rate, if the PCM came from one
   * @returns {string|null}
   */
  function lengthProblem(frames, rate, sourceFrames, sourceRate) {
    const count = Math.max(0, Math.trunc(Number(frames) || 0));
    const frequency = Number(rate);
    if (!Number.isFinite(frequency) || frequency <= 0) return null;
    const fromRate = Number(sourceRate);
    const fromFrames = Math.max(0, Math.trunc(Number(sourceFrames) || 0));
    if (Number.isFinite(fromRate) && fromRate > 0 && fromFrames > 0) {
      // The rule is about the file. A file that is over the limit is refused
      // with ITS length, whatever the PCM in hand says.
      if (fromFrames > fromRate + FRAME_TOLERANCE) return tooLongText(fromFrames, fromRate);
      const limit = resampledLimit(fromFrames, fromRate, frequency);
      if (limit !== null && count > limit) return tooLongText(count, frequency);
      return null;
    }
    if (count <= frequency + FRAME_TOLERANCE) return null;
    return tooLongText(count, frequency);
  }

  /** @returns {number} the smallest power of two at or above a value. */
  function nextPowerOfTwo(value) {
    let size = 1;
    while (size < value) size *= 2;
    return size;
  }

  /**
   * One iterative radix-2 complex FFT of a fixed size, with its twiddles and its
   * bit-reversal table made once.
   * @param {number} size the transform's size (a power of two)
   * @returns {{forward: function(Float64Array, Float64Array): void,
   *            inverse: function(Float64Array, Float64Array): void}}
   */
  function createFft(size) {
    const reversed = new Uint32Array(size);
    const bits = Math.round(Math.log2(size));
    for (let at = 0; at < size; at += 1) {
      let flipped = 0;
      for (let bit = 0; bit < bits; bit += 1) flipped |= ((at >> bit) & 1) << (bits - 1 - bit);
      reversed[at] = flipped;
    }
    const half = size >> 1;
    const cosTable = new Float64Array(half);
    const sinTable = new Float64Array(half);
    for (let at = 0; at < half; at += 1) {
      cosTable[at] = Math.cos((2 * Math.PI * at) / size);
      sinTable[at] = Math.sin((2 * Math.PI * at) / size);
    }

    /**
     * @param {Float64Array} re
     * @param {Float64Array} im
     * @param {boolean} inverse
     * @returns {void}
     */
    function transform(re, im, inverse) {
      for (let at = 0; at < size; at += 1) {
        const flipped = reversed[at];
        if (flipped <= at) continue;
        const real = re[at];
        re[at] = re[flipped];
        re[flipped] = real;
        const imaginary = im[at];
        im[at] = im[flipped];
        im[flipped] = imaginary;
      }
      for (let span = 2; span <= size; span <<= 1) {
        const halfSpan = span >> 1;
        const stride = size / span;
        for (let start = 0; start < size; start += span) {
          for (let at = 0; at < halfSpan; at += 1) {
            const table = at * stride;
            const wr = cosTable[table];
            const wi = inverse ? sinTable[table] : -sinTable[table];
            const low = start + at;
            const high = low + halfSpan;
            const xr = re[high] * wr - im[high] * wi;
            const xi = re[high] * wi + im[high] * wr;
            re[high] = re[low] - xr;
            im[high] = im[low] - xi;
            re[low] += xr;
            im[low] += xi;
          }
        }
      }
      if (!inverse) return;
      for (let at = 0; at < size; at += 1) {
        re[at] /= size;
        im[at] /= size;
      }
    }

    return {
      forward: function forward(re, im) {
        transform(re, im, false);
      },
      inverse: function inverse(re, im) {
        transform(re, im, true);
      },
    };
  }

  /**
   * Build one cabinet convolver.
   * @param {{channels: Float32Array[]|Float64Array[]|ArrayLike<number>[],
   *          rate: number, sourceFrames?: number,
   *          sourceRate?: number}} options `channels` is the IR's own PCM (one
   *   array for a mono cabinet, two for a stereo one), already at the context's
   *   rate; `sourceFrames`/`sourceRate` say what the file held before it was
   *   resampled, so the one-second rule is applied once, at the file's rate
   * @returns {{latencyFrames: number, frames: number, channels: number,
   *            partitions: number,
   *            process: function(Float32Array, Float32Array|null, number): void,
   *            reset: function(): void}}
   * @throws {Error} when the IR is longer than a second, or holds nothing
   */
  function create(options) {
    const settings = options && typeof options === "object" ? options : {};
    const rate = Number(settings.rate);
    const list = Array.isArray(settings.channels) ? settings.channels : [];
    const usable = [];
    for (const channel of list) {
      if (!channel || typeof channel.length !== "number" || channel.length === 0) continue;
      if (usable.length >= MAX_CHANNELS) break;
      usable.push(channel);
    }
    if (usable.length === 0) throw new Error("An impulse response holds no audio.");
    const frames = usable[0].length;
    // The page (and a render) says where these frames came from, so the length
    // is judged once, at the file's own rate, exactly as the page judged it
    // before it resampled.
    const problem = lengthProblem(frames, rate, settings.sourceFrames, settings.sourceRate);
    if (problem) throw new Error(problem);

    const irChannels = usable.length >= 2 ? 2 : 1;
    const partitions = frames > PARTITION_FRAMES ? Math.ceil((frames - PARTITION_FRAMES) / PARTITION_FRAMES) : 0;
    const fft = createFft(FFT_FRAMES);

    /** The first partition, per IR channel: convolved directly, frame by frame. */
    const head = [];
    /** The remaining partitions' spectra, per IR channel and partition. */
    const partRe = [];
    const partIm = [];
    for (let channel = 0; channel < irChannels; channel += 1) {
      const samples = usable[channel];
      const taps = new Float64Array(PARTITION_FRAMES);
      for (let at = 0; at < PARTITION_FRAMES && at < frames; at += 1) taps[at] = Number(samples[at]) || 0;
      head.push(taps);
      const real = [];
      const imaginary = [];
      if (partitions > 0) {
        const re = new Float64Array(FFT_FRAMES);
        const im = new Float64Array(FFT_FRAMES);
        for (let part = 0; part < partitions; part += 1) {
          re.fill(0);
          im.fill(0);
          const from = PARTITION_FRAMES + part * PARTITION_FRAMES;
          for (let at = 0; at < PARTITION_FRAMES && from + at < frames; at += 1) {
            re[at] = Number(samples[from + at]) || 0;
          }
          fft.forward(re, im);
          real.push(Float64Array.from(re));
          imaginary.push(Float64Array.from(im));
        }
      }
      partRe.push(real);
      partIm.push(imaginary);
    }

    /** One input channel's own state: its spectrum ring and its rolling history. */
    const inputChannels = [];
    for (let channel = 0; channel < MAX_CHANNELS; channel += 1) {
      inputChannels.push({
        ringRe: partitions > 0 ? Array.from({ length: partitions }, () => new Float64Array(FFT_FRAMES)) : [],
        ringIm: partitions > 0 ? Array.from({ length: partitions }, () => new Float64Array(FFT_FRAMES)) : [],
        /** The newest cached spectrum (the last completed block), or -1. */
        newest: -1,
        /** The last 2B input samples, oldest first in reading order. */
        recent: new Float64Array(FFT_FRAMES),
        filled: 0,
        /** The block being output right now: how many of its frames are done. */
        offset: 0,
      });
    }

    /** The tail of the block being output, per output channel. */
    const tail = [new Float64Array(PARTITION_FRAMES), new Float64Array(PARTITION_FRAMES)];

    /** The FFT's own work arrays and accumulator (reused for every channel). */
    const workRe = new Float64Array(FFT_FRAMES);
    const workIm = new Float64Array(FFT_FRAMES);
    const accRe = new Float64Array(FFT_FRAMES);
    const accIm = new Float64Array(FFT_FRAMES);
    const frame = new Float64Array(FFT_FRAMES);

    /**
     * Work out the block that is about to be output: the sum of the products of
     * the previous blocks with their IR partitions, one inverse FFT per channel
     * (see the file header).
     * @returns {void}
     */
    function prepareTail() {
      const outputs = 2;
      for (let channel = 0; channel < outputs; channel += 1) {
        const state = inputChannels[channel];
        const tapsRe = partRe[channel < irChannels ? channel : 0];
        const tapsIm = partIm[channel < irChannels ? channel : 0];
        const out = tail[channel];
        if (partitions === 0 || state.newest < 0) {
          out.fill(0);
          continue;
        }
        accRe.fill(0);
        accIm.fill(0);
        for (let part = 0; part < partitions; part += 1) {
          const slot = state.newest - part;
          if (slot < 0) break;
          const at = slot % partitions;
          const xr = state.ringRe[at];
          const xi = state.ringIm[at];
          const hr = tapsRe[part];
          const hi = tapsIm[part];
          for (let bin = 0; bin < FFT_FRAMES; bin += 1) {
            const xReal = xr[bin];
            const xImag = xi[bin];
            accRe[bin] += xReal * hr[bin] - xImag * hi[bin];
            accIm[bin] += xReal * hi[bin] + xImag * hr[bin];
          }
        }
        fft.inverse(accRe, accIm);
        for (let at = 0; at < PARTITION_FRAMES; at += 1) out[at] = accRe[PARTITION_FRAMES + at];
      }
    }

    /**
     * Close the input block that just ended: its spectrum becomes the newest one
     * in the ring, ready for the blocks that follow (see the header).
     * @param {number} channel
     * @returns {void}
     */
    function storeBlock(channel) {
      if (partitions === 0) return;
      const state = inputChannels[channel];
      const at = (state.newest + 1) % partitions;
      // The last 2B samples ARE the frame [x_{j-1}, x_j] the transform wants.
      for (let index = 0; index < FFT_FRAMES; index += 1) {
        const source = (state.filled + index) % FFT_FRAMES;
        frame[index] = state.recent[source];
      }
      const re = state.ringRe[at];
      const im = state.ringIm[at];
      for (let index = 0; index < FFT_FRAMES; index += 1) {
        re[index] = frame[index];
        im[index] = 0;
      }
      fft.forward(re, im);
      state.newest += 1;
    }

    /**
     * Push one input frame into a channel's rolling history.
     * @param {number} channel
     * @param {number} value
     * @returns {void}
     */
    function pushInput(channel, value) {
      const state = inputChannels[channel];
      state.recent[state.filled] = value;
      state.filled = (state.filled + 1) % FFT_FRAMES;
    }

    /**
     * One channel's head convolution at one frame: the first partition, directly.
     * @param {number} channel
     * @returns {number}
     */
    function headAt(channel) {
      const state = inputChannels[channel];
      const taps = head[channel < irChannels ? channel : 0];
      let sum = 0;
      // recent[] holds the last 2B samples; the newest is one behind `filled`.
      let at = state.filled - 1;
      for (let tap = 0; tap < PARTITION_FRAMES; tap += 1) {
        if (at < 0) at += FFT_FRAMES;
        sum += taps[tap] * state.recent[at];
        at -= 1;
      }
      return sum;
    }

    /**
     * Convolve a run of frames in place. The run may begin and end anywhere
     * inside a block; the block boundaries are this convolver's own, counted from
     * the first frame it ever processed, so a host's block size never changes
     * what is heard.
     * @param {Float32Array} left
     * @param {Float32Array|null} right
     * @param {number} frames
     * @returns {void}
     */
    function process(left, right, frames) {
      const count = Math.max(0, Math.trunc(Number(frames) || 0));
      if (count === 0 || !left) return;
      const stereoIn = right !== null && right !== undefined;
      for (let at = 0; at < count; at += 1) {
        const state = inputChannels[0];
        if (state.offset === 0) prepareTail();
        const inLeft = left[at];
        const inRight = stereoIn ? right[at] : inLeft;
        pushInput(0, inLeft);
        pushInput(1, inRight);
        const outLeft = headAt(0) + tail[0][state.offset];
        const outRight = headAt(1) + tail[1][state.offset];
        left[at] = outLeft;
        if (stereoIn) right[at] = outRight;
        state.offset += 1;
        inputChannels[1].offset = state.offset;
        if (state.offset >= PARTITION_FRAMES) {
          storeBlock(0);
          storeBlock(1);
          state.offset = 0;
          inputChannels[1].offset = 0;
        }
      }
    }

    return {
      latencyFrames: 0,
      frames: frames,
      channels: irChannels,
      partitions: partitions,
      process: process,
      reset: function reset() {
        for (const state of inputChannels) {
          state.recent.fill(0);
          state.filled = 0;
          state.offset = 0;
          state.newest = -1;
          for (const buffer of state.ringRe) buffer.fill(0);
          for (const buffer of state.ringIm) buffer.fill(0);
        }
        tail[0].fill(0);
        tail[1].fill(0);
      },
    };
  }

  const api = {
    create: create,
    lengthProblem: lengthProblem,
    resampledLimit: resampledLimit,
    MAX_SECONDS: MAX_SECONDS,
    LENGTH_TOLERANCE_FRAMES: FRAME_TOLERANCE,
    PARTITION_FRAMES: PARTITION_FRAMES,
    FFT_FRAMES: FFT_FRAMES,
    createFft: createFft,
    nextPowerOfTwo: nextPowerOfTwo,
  };

  if (typeof globalThis !== "undefined") globalThis.StudioConvolver = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();