/**
 * Studio's input level — the meter and the live waveform of a take's input, on
 * the audio thread.
 *
 *     const core = new InputLevelCore({ sampleRate: rate });
 *     core.process(frameStart, samples, count)   // the armed input, block by block
 *     core.drain()                               // one payload, when it says so
 *     core.clearClip()                           // the CLIP latch let go
 *     core.reset()                               // a new take: the ring starts empty
 *
 * The reading is the DRY input: the take is what the input plays, and the meter,
 * the peak hold and the live waveform show that same signal, so the lane says
 * "input 1 · amp on" and means it. Nothing here is the master's meter
 * (`engine/meter.js`) and nothing here is post-effect.
 *
 * ## What one post carries
 *
 * `process()` returns true about every `postFrames` (a thirtieth of a second by
 * default) and `drain()` then hands back one payload:
 *
 *     { frame, peak, rms, clipped, cols }
 *
 * - `frame` — the CONTEXT frame of the first sample of the post window, carried
 *   the way `recorder-processor.js` carries it, never a wall clock. The page maps
 *   a frame to song time as `frame - rec.offset_frames`, so the waveform lines up
 *   with where the take will sit.
 * - `peak` — the largest magnitude in the window, linear (0..1 at full scale).
 * - `rms` — the window's root mean square, linear. One sum of squares per
 *   window, one square root per drain: never one per sample.
 * - `clipped` — true once any sample has reached 0.999 in magnitude, and true
 *   until `clearClip()`. A latch, not a window reading.
 * - `cols` — the finished columns since the last drain, as `3 * n` values of
 *   `frame, min, max`: each column's first-sample frame and the smallest and
 *   largest sample in it, oldest first. A new `Float32Array` per payload,
 *   because structured clone moves exactly one object; `process()` itself makes
 *   none.
 *
 * ## Nothing allocated while the audio runs
 *
 * Every buffer is made in the constructor: a ring of `ringCols` (512 by default
 * — 5.1 s at 10 ms a column) with one `Float32Array` for the column minimums,
 * one for the maximums and one `Float64Array` of frames, plus scalar
 * accumulators for the column in progress and the post window. A full ring drops
 * the OLDEST column: the newest span of audio is the one a lane draws. `drain()`
 * is the only place that allocates, and only the payload it returns.
 *
 * A `null`, short or missing `samples` reads as silence (zeros), and a sample
 * that is not a finite number reads as 0 — so one NaN from an unplugged device
 * can never live in the state or reach the meter.
 *
 * ## It is a classic script
 *
 * No `import`/`export`: it assigns `globalThis.StudioInputLevel` for the worklet
 * scope and `module.exports` when a CommonJS `module` exists (`engine/package.json`
 * marks the directory `"commonjs"`), and `engine-client.js` loads it by its own
 * `addModule` with the other engine sources.
 */
(function () {
  "use strict";

  /** The rate a core made without one accumulates at. */
  const DEFAULT_RATE = 48000;

  /** One column is this long, in seconds: ten milliseconds, a lane column. */
  const COLUMN_SECONDS = 0.01;

  /** How many columns the ring holds when a caller names none. */
  const DEFAULT_RING_COLS = 512;

  /** A post is due about this often, in seconds (thirty times a second). */
  const POST_SECONDS = 1 / 30;

  /** At or above this magnitude a sample latches CLIP. */
  const CLIP_LEVEL = 0.999;

  /**
   * A sample as the input path may carry it. `v - v` is exactly 0 for every
   * finite double (0 and -0 included) and NaN for a NaN or an infinity.
   * @param {number} value
   * @returns {number} the sample, or 0 when it is not a finite number
   */
  function finiteSample(value) {
    return value - value === 0 ? value : 0;
  }

  /** @returns {number} a finite number above zero, else the fallback. */
  function positive(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
  }

  /**
   * One input level core. Allocate one per armed input, built before the first
   * block and used from the audio thread.
   * @param {{sampleRate?: number, colFrames?: number, postFrames?: number,
   *          ringCols?: number}} [options] the rate and, for a caller that wants
   *   a different grid, the column and post lengths and the ring's size
   */
  function InputLevelCore(options) {
    if (!(this instanceof InputLevelCore)) return new InputLevelCore(options);
    const settings = options || {};
    const sampleRate = positive(settings.sampleRate, DEFAULT_RATE);

    /** The rate the frames count at, in Hz. */
    this.sampleRate = sampleRate;

    /** Frames per column, and per post window: the grid every reading uses. */
    this.colFrames = Math.max(1, Math.round(positive(settings.colFrames, sampleRate * COLUMN_SECONDS)));
    this.postFrames = Math.max(1, Math.round(positive(settings.postFrames, sampleRate * POST_SECONDS)));

    /** How many columns the ring holds: fixed for the core's whole life. */
    this.ringCols = Math.max(1, Math.round(positive(settings.ringCols, DEFAULT_RING_COLS)));

    /**
     * The ring, made once. `head` is the slot of the oldest column held and
     * `count` how many are held, so a full ring overwrites its oldest.
     */
    this.minRing = new Float32Array(this.ringCols);
    this.maxRing = new Float32Array(this.ringCols);
    this.frameRing = new Float64Array(this.ringCols);
    this.head = 0;
    this.count = 0;

    /** The column in progress: its first-sample frame, its extremes, its length. */
    this.columnStart = 0;
    this.columnFrames = 0;
    this.columnMin = 0;
    this.columnMax = 0;

    /** The post window in progress: its first-sample frame, peak, power and length. */
    this.postStart = 0;
    this.postPeak = 0;
    this.postSumSq = 0;
    this.postCount = 0;

    /** Frames since the last post was due, and whether one is waiting to be drained. */
    this.postElapsed = 0;
    this.postDue = false;

    /** The CLIP latch: set by a full-scale sample, let go only by `clearClip()`. */
    this.clipped = false;
  }

  /**
   * Finish the column in progress: put its frame, minimum and maximum in the
   * ring at the slot after the ones already held, dropping the oldest column
   * when the ring is full.
   * @returns {void}
   */
  InputLevelCore.prototype.closeColumn = function () {
    if (this.count >= this.ringCols) {
      this.head += 1;
      if (this.head >= this.ringCols) this.head = 0;
      this.count -= 1;
    }
    let slot = this.head + this.count;
    if (slot >= this.ringCols) slot -= this.ringCols;
    this.frameRing[slot] = this.columnStart;
    this.minRing[slot] = this.columnMin;
    this.maxRing[slot] = this.columnMax;
    this.count += 1;
    this.columnFrames = 0;
  };

  /**
   * Feed one block of the armed input through the core. Nothing is written back
   * and nothing is allocated: the block only moves the scalars and, when a
   * column or a post window closes, the ring.
   * @param {number} frameStart the context frame of `samples[0]`
   * @param {Float32Array|null} samples the input, or null for silence
   * @param {number} count frames in the block
   * @returns {boolean} true when a post is due (and until it is drained)
   */
  InputLevelCore.prototype.process = function (frameStart, samples, count) {
    const total = Math.trunc(Number(count));
    const start = Number(frameStart);
    if (!(total > 0)) return this.postDue;
    const length = samples && typeof samples.length === "number" ? samples.length : 0;
    const colFrames = this.colFrames;

    for (let index = 0; index < total; index += 1) {
      const sample = index < length ? finiteSample(samples[index]) : 0;
      const frame = start + index;
      const magnitude = sample < 0 ? -sample : sample;

      if (magnitude >= CLIP_LEVEL) this.clipped = true;
      if (magnitude > this.postPeak) this.postPeak = magnitude;
      this.postSumSq += sample * sample;
      if (this.postCount === 0) this.postStart = frame;
      this.postCount += 1;

      if (this.columnFrames === 0) {
        this.columnStart = frame;
        this.columnMin = sample;
        this.columnMax = sample;
      } else if (sample < this.columnMin) this.columnMin = sample;
      else if (sample > this.columnMax) this.columnMax = sample;
      this.columnFrames += 1;
      if (this.columnFrames >= colFrames) this.closeColumn();
    }

    this.postElapsed += total;
    while (this.postElapsed >= this.postFrames) {
      this.postElapsed -= this.postFrames;
      this.postDue = true;
    }
    return this.postDue;
  };

  /**
   * Take one payload: the post window's frame, peak, RMS and CLIP latch, and a
   * new `Float32Array` of the columns finished since the last drain. The window
   * accumulators start again; the CLIP latch does not (only `clearClip()` lets it
   * go).
   * @returns {{frame: number, peak: number, rms: number, clipped: boolean,
   *            cols: Float32Array}}
   */
  InputLevelCore.prototype.drain = function () {
    const finished = this.count;
    const cols = new Float32Array(finished * 3);
    let slot = this.head;
    for (let index = 0; index < finished; index += 1) {
      const at = index * 3;
      cols[at] = this.frameRing[slot];
      cols[at + 1] = this.minRing[slot];
      cols[at + 2] = this.maxRing[slot];
      slot += 1;
      if (slot >= this.ringCols) slot = 0;
    }
    this.head = slot;
    this.count = 0;

    const windowFrames = this.postCount;
    const payload = {
      frame: this.postStart,
      peak: this.postPeak,
      rms: windowFrames > 0 ? Math.sqrt(this.postSumSq / windowFrames) : 0,
      clipped: this.clipped,
      cols: cols,
    };

    this.postPeak = 0;
    this.postSumSq = 0;
    this.postCount = 0;
    this.postDue = false;
    return payload;
  };

  /** Let the CLIP latch go: the next reading can latch it again. */
  InputLevelCore.prototype.clearClip = function () {
    this.clipped = false;
  };

  /** Put the core back to how it was built: an empty ring, silence, no latch. */
  InputLevelCore.prototype.reset = function () {
    this.minRing.fill(0);
    this.maxRing.fill(0);
    this.frameRing.fill(0);
    this.head = 0;
    this.count = 0;
    this.columnStart = 0;
    this.columnFrames = 0;
    this.columnMin = 0;
    this.columnMax = 0;
    this.postStart = 0;
    this.postPeak = 0;
    this.postSumSq = 0;
    this.postCount = 0;
    this.postElapsed = 0;
    this.postDue = false;
    this.clipped = false;
  };

  const api = {
    InputLevelCore: InputLevelCore,
    DEFAULT_RATE: DEFAULT_RATE,
    DEFAULT_RING_COLS: DEFAULT_RING_COLS,
    COLUMN_SECONDS: COLUMN_SECONDS,
    POST_SECONDS: POST_SECONDS,
    CLIP_LEVEL: CLIP_LEVEL,
  };

  if (typeof globalThis !== "undefined") globalThis.StudioInputLevel = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();