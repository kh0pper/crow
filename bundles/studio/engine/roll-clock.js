/**
 * Studio roll clock — when the next ROLL repeat is due, in frames.
 *
 * A ROLL repeats one pad while the operator holds it. The repeats are spaced by
 * a musical interval (a quarter, an eighth, a sixteenth, a thirty-second or a
 * sixty-fourth) at the song's tempo, so the engine needs one number: the frame
 * the next repeat sounds on. This file is that number and nothing else — no
 * arrays, no queues, no clock of its own, no Web Audio: a caller asks whether a
 * repeat is due inside a block, starts it, and moves the clock on.
 *
 * ## Incremental, so a tempo change cannot repeat or skip a hit
 *
 * The state is one frame (`{nextFrame}`), moved on by one interval at a time,
 * and the interval is worked out from the tempo AS IT IS when the repeat fires
 * (`next()` is handed the current interval). A tempo change therefore moves
 * only the repeats after the one that fired: the standing hit stays exactly
 * where it was, and no hit is doubled or dropped. Nothing is recomputed from a
 * musical origin, so a tempo edit never renumbers the hits that already played.
 *
 * The engine's whole loop is
 *
 *     while (RollClock.due(state, blockEnd)) {
 *       fire(state.nextFrame);
 *       RollClock.next(state, RollClock.intervalFrames(bpm, sampleRate, interval));
 *     }
 *
 * and it allocates nothing: `due()` answers a boolean, `next()` and
 * `reanchor()` return nothing, and the state object is created once.
 *
 * ## The intervals
 *
 * The five straight values, in beats: `1/4` is 1, `1/8` 0.5, `1/16` 0.25,
 * `1/32` 0.125 and `1/64` 0.0625, so a repeat is `beats × 60 / bpm × sampleRate`
 * frames rounded once. Their names are `INTERVALS`, in that order, for a page
 * that draws the picker.
 *
 * A frame count is never 0 or fractional nonsense: an interval that cannot be
 * worked out (an unknown name, a tempo that is not a positive number) still
 * moves the clock by ONE frame, because a step of 0 would spin the engine's
 * `while (due)` loop forever on the audio thread.
 *
 * It is a classic script (no `import`/`export`): it assigns
 * `globalThis.StudioRollClock` for the worklet scope and `module.exports` when a
 * CommonJS `module` exists. `engine/package.json` marks that directory
 * `"commonjs"`, so a Node `require()` of this file works inside the bundle's ESM
 * tree; `engine-client.js` also concatenates it into the worklet module (a
 * worklet cannot import), which is why it must not depend on anything.
 */
(function () {
  "use strict";

  /** The tempo a caller that names none rolls at, and the rate it assumes. */
  const DEFAULT_BPM = 120;
  const DEFAULT_SAMPLE_RATE = 48000;

  /** One interval in beats, by the name the page and the song use. */
  const BEATS_PER_INTERVAL = Object.freeze({
    "1/4": 1,
    "1/8": 0.5,
    "1/16": 0.25,
    "1/32": 0.125,
    "1/64": 0.0625,
  });

  /** The five straight values, in the order a picker shows them. */
  const INTERVALS = Object.freeze(["1/4", "1/8", "1/16", "1/32", "1/64"]);

  /**
   * @param {unknown} value
   * @param {number} fallback
   * @returns {number} the value when it is a finite number above 0, else the fallback
   */
  function positive(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
  }

  /**
   * @param {unknown} value
   * @returns {number} a frame as a whole number; 0 when it is not a finite number
   */
  function frame(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.trunc(number) : 0;
  }

  /**
   * @param {unknown} interval a name from `INTERVALS`
   * @returns {number} its length in beats; 0 for a name that is not one of them
   */
  function beats(interval) {
    const name = typeof interval === "string" ? interval : "";
    const value = BEATS_PER_INTERVAL[name];
    return Number.isFinite(value) ? value : 0;
  }

  /**
   * The step one repeat is spaced by, as the clock adds it. A step of 0 would
   * never move the clock, so anything unusable is one frame.
   * @param {unknown} value
   * @returns {number}
   */
  function stepOf(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 1;
  }

  /**
   * How many frames one interval lasts at a tempo, rounded once.
   *
   * @param {number} bpm the song's tempo (an unusable one rolls at 120)
   * @param {number} sampleRate the host's rate (an unusable one assumes 48 kHz)
   * @param {string} interval a name from `INTERVALS`
   * @returns {number} at least 1 frame (see "The intervals" in the header)
   */
  function intervalFrames(bpm, sampleRate, interval) {
    const length = beats(interval);
    const tempo = positive(bpm, DEFAULT_BPM);
    const rate = positive(sampleRate, DEFAULT_SAMPLE_RATE);
    return stepOf(Math.round((length * 60 * rate) / tempo));
  }

  /**
   * One clock, standing at its first repeat.
   * @param {number} startFrame the frame the first repeat sounds on
   * @returns {{nextFrame: number}}
   */
  function create(startFrame) {
    return { nextFrame: frame(startFrame) };
  }

  /**
   * Whether the standing repeat sounds inside this block. The frame the block
   * ENDS on is not inside it: it belongs to the next block, so a hit exactly on
   * a block boundary fires once, in the block it sounds in.
   * @param {{nextFrame: number}} state
   * @param {number} blockEnd the block's exclusive end frame
   * @returns {boolean}
   */
  function due(state, blockEnd) {
    if (!state) return false;
    return state.nextFrame < Number(blockEnd);
  }

  /**
   * Move the clock past the repeat that just fired, by the interval of the
   * tempo it fired at (the caller works it out again for every repeat).
   * @param {{nextFrame: number}} state
   * @param {number} frames
   * @returns {void}
   */
  function next(state, frames) {
    if (!state) return;
    state.nextFrame += stepOf(frames);
  }

  /**
   * Put the clock back to work after a pause: the next repeat is one interval
   * after the frame the roll resumes on, never a burst of the repeats that the
   * pause swallowed.
   * @param {{nextFrame: number}} state
   * @param {number} atFrame the frame the roll resumes on
   * @param {number} frames the interval that frame is in
   * @returns {void}
   */
  function reanchor(state, atFrame, frames) {
    if (!state) return;
    state.nextFrame = frame(atFrame) + stepOf(frames);
  }

  const api = {
    create: create,
    intervalFrames: intervalFrames,
    due: due,
    next: next,
    reanchor: reanchor,
    beats: beats,
    INTERVALS: INTERVALS,
    BEATS_PER_INTERVAL: BEATS_PER_INTERVAL,
  };

  if (typeof globalThis !== "undefined") globalThis.StudioRollClock = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();