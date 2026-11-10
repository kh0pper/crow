/**
 * Crow's own dynamics — the compressor, the limiter, the gate and the de-esser.
 *
 * These four inserts are the ones a sidechain, an envelope and a gain computer
 * describe completely, so they are plain JavaScript rather than Faust wasm
 * (plan 1d, Task 8): one insert per chain slot, driven by the processor one
 * 128-frame block at a time.
 *
 *     StudioDynamics.create(kind, rate, {master}) → one insert
 *
 * `kind` is one of `KINDS`. `{master: true}` is what makes a `limiter` the
 * master limiter: it gets a 1.5 ms lookahead and a true-peak detector, while a
 * limiter on a track or a return is a zero-latency sample-peak clipper. Every
 * other kind is zero-latency wherever it sits, because no track insert may
 * delay its track (plan 1d: "all track and return inserts are zero-latency").
 *
 * The insert's own members:
 *
 *     setParams({...})                     one plain object, validated and clamped
 *     process(left, right, frames, sc, sc) in place on Float32Array blocks
 *     reset()                              back to silence, no parameter change
 *     latencyFrames                        0, or round(0.0015 × rate) for the master limiter
 *     state / gain                         (gate only, read-only) whether it is open, and
 *                                          the gain its envelope is applying — for tests
 *                                          and for a meter
 *
 * ## It is a classic script
 *
 * No `import`/`export`: it assigns `globalThis.StudioDynamics` for the worklet
 * scope and `module.exports` when a CommonJS `module` exists. `engine/package.json`
 * marks that directory `"commonjs"`, so a Node `require()` of this file works
 * inside the bundle's ESM tree, and `engine-client.js` also concatenates it into
 * the worklet module (a worklet cannot import), which is why it must not depend
 * on anything. It cannot read `server/doc.js` either, so the four kinds'
 * parameter ranges are duplicated here in `PARAMS` — frozen, and pinned to the
 * document's copy by a test, because the panel's insert editor and this file
 * have to agree on every range.
 *
 * ## The four effects
 *
 * - **compressor** — feed-forward and stereo-linked. The detector reads
 *   `max(|L|, |R|)` for peak, or the mean of L²/R² over a 10 ms window for rms;
 *   an optional second-order high-pass cleans the detector's input (never the
 *   audio), and an external sidechain pair, when `process()` is given one,
 *   replaces that input altogether. The gain computer uses the standard
 *   quadratic soft knee, the reduction is smoothed as dB by one attack/release
 *   pole, and the makeup gain is added after it.
 * - **limiter** — on the master, a brickwall: the audio is delayed by
 *   `latencyFrames`, the true peak of the UNDELAYED input is measured through
 *   the same 4× polyphase filter `server/loudness.js` measures it with, and the
 *   gain is ramped DOWN in a straight line steep enough for EVERY frame in the
 *   lookahead window: each frame's own requirement has to be reached
 *   `rampLead` frames before that frame is output, so the slope is the steepest
 *   of those deadlines — not the one the window's minimum asks for. (Those are
 *   not the same deadline: a shallower peak nearer the output and a deeper one
 *   still entering the window share a window but not a deadline, and a line
 *   aimed only at the deeper minimum is still above the shallower requirement
 *   when the shallower frame is handed out.) The gain is then released upward
 *   per `release_ms`. So the reduction is in place when a peak reaches the
 *   output — the inter-sample peaks the detector finds between the frames it
 *   already saw included — and no sample passes the ceiling. (A step a
 *   millisecond before a peak is audible; a ramp that is already there when the
 *   peak is output is not.) A ceiling lowered mid-play is the one deliberate
 *   exception: it holds at once, in a step, not once the old peaks have drained
 *   out of the lookahead.
 *   "The ceiling" means the ceiling as that 4× estimator reads it: a 4×
 *   oversampled true-peak meter reconstructs the waveform between samples only
 *   up to its own oversampling, and under-reads audio whose energy sits very
 *   close to Nyquist (well above a quarter of the sample rate). No sample-domain
 *   limiter can promise more than its meter sees, and this one shares
 *   `loudness.js`'s meter on purpose, so a render's measurement agrees with it.
 *   On a track it is the zero-latency version the plan asks for: a hard clip at
 *   the ceiling.
 * - **gate** — opens when the detector rises above the threshold, closes when
 *   it falls below `threshold − hysteresis`, and its gain follows an
 *   attack/hold/release envelope whose closed floor is `range_db`. The detector
 *   is a peak envelope of the linked pair — instant attack, ~10 ms release —
 *   not the raw sample, so a low tone does not chatter at its zero crossings
 *   when `hold_ms` is 0. Whether it is open and what gain it is applying are
 *   readable from outside as `state` and `gain` — read-only, for tests and for
 *   a meter.
 * - **de-esser** — a split-band compressor: a second-order band-pass at
 *   `freq_hz` drives the detector, and the reduction is applied to the band
 *   above `freq_hz × 0.7` only. The split is subtractive (the high band is
 *   `input − low`), so with no reduction the output is the input again.
 *
 * ## No allocation, no throws, no surprises
 *
 * Everything is sized in `create()` — the lookahead ring, the true-peak
 * histories, the RMS window, the filters' states — so `process()` allocates
 * nothing, throws nothing and calls no `Math.random`. (The rms detector does
 * re-add its window once per full wrap, to throw away the running sum's
 * rounding drift; that is a pass over memory `create()` already made.) The state
 * is `Float64Array` and plain doubles throughout, and every recursive state
 * variable is flushed to exactly 0 below 1e-30, the way `engine/perf-fx.js`
 * flushes its own: a decaying tail cannot cost a CPU spike on one machine and
 * not another.
 *
 * A sample that is not a finite number reads as 0 before it touches anything.
 * One NaN or ±Infinity in a biquad, in the RMS running sum or in the limiter's
 * lookahead would stay in that state for good — the de-esser would hiss NaN
 * forever, the compressor would never compress again — so every input sample,
 * audio and sidechain, is sanitised at the top of its frame loop, and the
 * master limiter's output clamp turns a non-finite frame into silence rather
 * than passing it on.
 *
 * A parameter object may be partial and may be wrong: a number outside its range
 * is clamped, a name the kind does not have is ignored, and a value that is not
 * a number leaves the parameter where it was — so turning one knob needs one
 * field and nothing else.
 */
(function () {
  "use strict";

  /** Below this, a recursive stage's state is flushed to exactly 0. */
  const DENORMAL_FLOOR = 1e-30;

  /** The rate an insert created without one runs at (the same default as the bus). */
  const DEFAULT_RATE = 48000;

  /** The four dynamics this file provides, in the order a menu lists them. */
  const KINDS = Object.freeze(["compressor", "limiter", "gate", "deesser"]);

  /** The level a detector reads when it hears nothing. Never -Infinity, never NaN. */
  const MIN_LEVEL_DB = -240;

  /**
   * The level a detector reads at most. +120 dBFS is far above anything a
   * Float32 buffer can carry without its squares overflowing, and holding the
   * level finite keeps a huge-but-legal sample from turning a gain into NaN one
   * frame later (`-Infinity + Infinity`).
   */
  const MAX_LEVEL_DB = 120;

  /** Below this amplitude a detector reads nothing at all. */
  const SILENCE_LEVEL = 1e-12;

  /** The master limiter's lookahead, in seconds: 1.5 ms, the plan's number. */
  const MASTER_LOOKAHEAD_SECONDS = 0.0015;

  /**
   * How much of that lookahead the master limiter's ramp finishes early, as a
   * fraction of it. The gain is where a peak needs it a little BEFORE the peak
   * is output, so the true peak the interpolation finds between the samples is
   * inside the ceiling too, not only the sample that carries it.
   */
  const LIMITER_RAMP_LEAD_FRACTION = 1 / 8;

  /**
   * The fewest frames that early lead may be. The true-peak detector's
   * interpolation lags the samples it describes: the value it reports for the
   * peak BETWEEN two frames is only known six frames later (twelve taps per
   * phase, centred on the sixth), so a peak's gain has to be in place at least
   * six frames before the peak's own frame is handed out — plus a margin, so a
   * ramp is still a ramp at the end. Hence a floor of 8 at any rate, with an
   * eighth of the lookahead above it (`round(L/8)`: 8 frames at 44.1 kHz,
   * 9 at 48 kHz, 18 at 96 kHz).
   */
  const LIMITER_RAMP_LEAD_MIN_FRAMES = 8;

  /**
   * The gate's detector release, in seconds: a peak envelope that follows the
   * waveform's peaks, not the waveform. Raw |sample| crosses zero twice per
   * period, so with no hold a low tone would chatter; 10 ms of release is far
   * shorter than any gap between the peaks of the tones a gate is used on and
   * far longer than a zero crossing.
   */
  const GATE_DETECTOR_RELEASE_SECONDS = 0.01;

  /** The compressor's RMS window: 10 ms of the squared signal. */
  const RMS_WINDOW_SECONDS = 0.01;

  /** A Butterworth second-order section's Q, for the sidechain high-pass and the crossover. */
  const BUTTERWORTH_Q = 0.7071067811865476;

  /** The de-esser's band-pass resonance, and where its crossover sits relative to `freq_hz`. */
  const DEESSER_Q = 2;
  const DEESSER_CROSSOVER_FRACTION = 0.7;

  /**
   * The de-esser's own smoothing, in seconds. The effect has no attack or release
   * of its own (its three parameters are the band, the threshold and the ratio),
   * so the gain it applies is smoothed by a fixed fast attack and a fixed short
   * release: quick enough to catch an "s", slow enough not to buzz.
   */
  const DEESSER_ATTACK_SECONDS = 0.001;
  const DEESSER_RELEASE_SECONDS = 0.04;

  /** How many extra points per sample the true-peak detector interpolates. */
  const TRUE_PEAK_OVERSAMPLE = 4;

  /** Taps in the true-peak interpolation filter's prototype (the plan's >= 48). */
  const TRUE_PEAK_TAPS = 48;

  /** Taps per polyphase branch, which is also how many frames of history are held. */
  const TRUE_PEAK_TAPS_PER_PHASE = TRUE_PEAK_TAPS / TRUE_PEAK_OVERSAMPLE;

  /** The prototype's centre tap: a multiple of the oversampling factor. */
  const TRUE_PEAK_CENTER = TRUE_PEAK_TAPS / 2;

  /** The polyphase branches, built once (they depend only on the constants). */
  const TRUE_PEAK_PHASES = buildTruePeakPhases();

  /**
   * Freeze a value and everything inside it, so a table a reader shares cannot be
   * edited by one of them. Plain objects and arrays only.
   * @template T
   * @param {T} value
   * @returns {T}
   */
  function deepFreeze(value) {
    if (value === null || typeof value !== "object") return value;
    for (const item of Object.values(value)) deepFreeze(item);
    return Object.freeze(value);
  }

  /**
   * The four dynamics' parameters and ranges — a copy of `EFFECT_PARAMS` in
   * `server/doc.js` for `compressor`, `limiter`, `gate` and `deesser`, exactly
   * as the document holds them: `{min, max, default, unit}` for a number,
   * `{values, default}` for a chooser.
   *
   * A worklet cannot import the document's module, so the table is duplicated
   * here and a test holds the two copies together: a range must never be
   * widened in one place and not the other.
   * @type {Readonly<Object<string, Readonly<{label: string, params: Readonly<Object<string, any>>}>>>}
   */
  const PARAMS = deepFreeze({
    compressor: {
      label: "compressor",
      params: {
        detect: { values: ["peak", "rms"], default: "peak" },
        threshold_db: { min: -60, max: 0, default: -18, unit: "dB" },
        ratio: { min: 1, max: 20, default: 4, unit: "" },
        knee_db: { min: 0, max: 12, default: 6, unit: "dB" },
        attack_ms: { min: 0.1, max: 100, default: 10, unit: "ms" },
        release_ms: { min: 5, max: 2000, default: 100, unit: "ms" },
        makeup_db: { min: 0, max: 24, default: 0, unit: "dB" },
        sidechain_hp_hz: { min: 0, max: 500, default: 0, unit: "Hz" },
      },
    },
    limiter: {
      label: "limiter",
      params: {
        ceiling_db: { min: -6, max: -0.1, default: -1, unit: "dB" },
        release_ms: { min: 1, max: 1000, default: 50, unit: "ms" },
      },
    },
    gate: {
      label: "gate",
      params: {
        threshold_db: { min: -80, max: 0, default: -40, unit: "dB" },
        hysteresis_db: { min: 0, max: 12, default: 3, unit: "dB" },
        attack_ms: { min: 0.01, max: 50, default: 1, unit: "ms" },
        hold_ms: { min: 0, max: 500, default: 20, unit: "ms" },
        release_ms: { min: 5, max: 2000, default: 100, unit: "ms" },
        range_db: { min: -80, max: 0, default: -80, unit: "dB" },
      },
    },
    deesser: {
      label: "de-esser",
      params: {
        freq_hz: { min: 4000, max: 10000, default: 6500, unit: "Hz" },
        threshold_db: { min: -60, max: 0, default: -24, unit: "dB" },
        ratio: { min: 1, max: 20, default: 4, unit: "" },
      },
    },
  });

  /** @returns {number} a finite number above zero, else 0. */
  function positive(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
  }

  /** @returns {number} the value held between two bounds. */
  function clamp(value, low, high) {
    if (!Number.isFinite(value)) return low;
    if (value < low) return low;
    if (value > high) return high;
    return value;
  }

  /** @returns {number} the value, or 0 when it is below the denormal floor. */
  function flush(value) {
    return value > -DENORMAL_FLOOR && value < DENORMAL_FLOOR ? 0 : value;
  }

  /**
   * A sample as the audio path may carry it. `v - v` is exactly 0 for every
   * finite double (0 and -0 included) and NaN for a NaN or an infinity, so this
   * is the cheapest finiteness test there is — and a non-finite sample has to
   * become 0 before it reaches a recursive stage, where it would never leave.
   * @param {number} value a sample as it arrived
   * @returns {number} the sample, or 0 when it is not a finite number
   */
  function finiteSample(value) {
    return value - value === 0 ? value : 0;
  }

  /**
   * A sample held inside ±a ceiling, and never NaN: a value that is not a number
   * (only a broken state could make one here) comes out as 0 rather than being
   * handed to the next stage, where a recursive insert would keep it forever.
   * @param {number} value the sample
   * @param {number} ceiling the largest magnitude allowed, above zero
   * @returns {number} the sample, clipped and finite
   */
  function clampCeiling(value, ceiling) {
    if (!(value <= ceiling)) return value > ceiling ? ceiling : 0;
    if (value < -ceiling) return -ceiling;
    return value;
  }

  /** @returns {number} a level in dB as a linear gain. */
  function dbToGain(db) {
    return Math.pow(10, db / 20);
  }

  /**
   * @param {number} amplitude a detector's reading
   * @returns {number} its level in dB, held between `MIN_LEVEL_DB` and
   *   `MAX_LEVEL_DB` so it is never -Infinity, never NaN and never big enough to
   *   overflow the gain it is turned into
   */
  function levelOf(amplitude) {
    if (!(amplitude > SILENCE_LEVEL)) return MIN_LEVEL_DB;
    const db = 20 * Math.log10(amplitude);
    return db < MAX_LEVEL_DB ? db : MAX_LEVEL_DB;
  }

  /**
   * A one-pole smoothing coefficient for a time constant in milliseconds.
   * @param {number} milliseconds the time constant
   * @param {number} rate the host's sample rate
   * @returns {number} the fraction of the way to the target one frame moves
   */
  function onePoleCoefficient(milliseconds, rate) {
    const frames = Math.max(1e-6, (Math.max(0, Number(milliseconds) || 0) / 1000) * rate);
    const coefficient = 1 - Math.exp(-1 / frames);
    return coefficient > 1 ? 1 : coefficient;
  }

  /**
   * The polyphase branches of the 4× true-peak interpolation filter, built
   * exactly as `server/loudness.js` builds them: a 48-tap Blackman-windowed sinc
   * whose cutoff sits at the input's Nyquist, normalised to unity DC gain per
   * branch. The master limiter must measure a peak the same way a render's
   * measurement reports one, so these numbers are a copy — a test compares the
   * two filters on the same audio and holds them equal.
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
   * The state of one true-peak detector: the last twelve frames of each channel
   * (twelve taps per phase) and where the next one goes.
   * @returns {{historyLeft: Float64Array, historyRight: Float64Array, index: number}}
   */
  function createTruePeakState() {
    return {
      historyLeft: new Float64Array(TRUE_PEAK_TAPS_PER_PHASE),
      historyRight: new Float64Array(TRUE_PEAK_TAPS_PER_PHASE),
      index: 0,
    };
  }

  /**
   * One frame through the true-peak detector: the largest magnitude the signal
   * reaches on this frame and between this frame and the next.
   * @param {object} detector the detector's state (see `createTruePeakState`)
   * @param {number} left this frame's left sample
   * @param {number} right this frame's right sample
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
   * The true peak of a whole block, in dBTP, measured with the very filter the
   * master limiter uses. The render's measurement (`truePeakDb` in
   * `server/loudness.js`) computes the same number from the same coefficients,
   * which is how a test holds this copy and that one together. Not for the
   * audio path: it makes the detector's state, so `process()` never calls it.
   * @param {Float32Array|Float64Array|number[]|null} left
   * @param {Float32Array|Float64Array|number[]|null} right
   * @param {number} frames how many frames of them to measure
   * @returns {number} dBTP, or -Infinity for silence
   */
  function truePeakDb(left, right, frames) {
    const count = Math.min(
      Math.max(0, Math.trunc(Number(frames) || 0)),
      left && typeof left.length === "number" ? left.length : 0,
    );
    const detector = createTruePeakState();
    let peak = 0;
    for (let index = 0; index < count; index += 1) {
      const leftValue = finiteSample(left ? left[index] : 0);
      const rightValue =
        right && typeof right.length === "number" ? finiteSample(right[index]) : leftValue;
      const framePeak = truePeakStep(detector, leftValue, rightValue);
      if (framePeak > peak) peak = framePeak;
    }
    return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
  }

  // --- the filters the four effects lean on ---------------------------------

  /**
   * The state of one second-order section on two channels (direct form I).
   * @returns {object} the coefficients plus one `x1/x2/y1/y2` history per channel
   */
  function createBiquadState() {
    return {
      b0: 0,
      b1: 0,
      b2: 0,
      a1: 0,
      a2: 0,
      left: { x1: 0, x2: 0, y1: 0, y2: 0 },
      right: { x1: 0, x2: 0, y1: 0, y2: 0 },
    };
  }

  /**
   * One frame through one channel of a second-order section. Every recursive
   * term is flushed, so a filter ringing down to nothing costs nothing.
   * @param {object} section the section's coefficients and state
   * @param {object} channel which channel's history (`section.left`/`section.right`)
   * @param {number} input
   * @returns {number} the filtered sample
   */
  function biquadStep(section, channel, input) {
    const out =
      section.b0 * input +
      section.b1 * channel.x1 +
      section.b2 * channel.x2 -
      section.a1 * channel.y1 -
      section.a2 * channel.y2;
    channel.x2 = channel.x1;
    channel.x1 = input;
    channel.y2 = channel.y1;
    channel.y1 = flush(out);
    return flush(out);
  }

  /** @returns {void} put one section's history back to silence, coefficients untouched. */
  function clearBiquad(section) {
    section.left.x1 = 0;
    section.left.x2 = 0;
    section.left.y1 = 0;
    section.left.y2 = 0;
    section.right.x1 = 0;
    section.right.x2 = 0;
    section.right.y1 = 0;
    section.right.y2 = 0;
  }

  /**
   * A cutoff held below the Nyquist frequency, whatever a parameter or a rate asks for.
   * @param {number} hz
   * @param {number} rate
   * @returns {number}
   */
  function safeCutoff(hz, rate) {
    return clamp(hz, 1, rate * 0.45);
  }

  /**
   * A second-order high-pass in the RBJ form, pre-warped by the bilinear
   * transform (the "tan" form), so it is stable at any cutoff.
   * @param {object} section the section to write
   * @param {number} frequency the corner frequency, in Hz
   * @param {number} q the section's Q
   * @param {number} rate the host's sample rate
   * @returns {void}
   */
  function setHighPass(section, frequency, q, rate) {
    const k = Math.tan((Math.PI * safeCutoff(frequency, rate)) / rate);
    const a0 = 1 + k / q + k * k;
    section.b0 = 1 / a0;
    section.b1 = -2 / a0;
    section.b2 = 1 / a0;
    section.a1 = (2 * (k * k - 1)) / a0;
    section.a2 = (1 - k / q + k * k) / a0;
  }

  /**
   * A second-order low-pass in the same form.
   * @param {object} section the section to write
   * @param {number} frequency the corner frequency, in Hz
   * @param {number} q the section's Q
   * @param {number} rate the host's sample rate
   * @returns {void}
   */
  function setLowPass(section, frequency, q, rate) {
    const k = Math.tan((Math.PI * safeCutoff(frequency, rate)) / rate);
    const a0 = 1 + k / q + k * k;
    const gain = k * k;
    section.b0 = gain / a0;
    section.b1 = (2 * gain) / a0;
    section.b2 = gain / a0;
    section.a1 = (2 * (k * k - 1)) / a0;
    section.a2 = (1 - k / q + k * k) / a0;
  }

  /**
   * A second-order band-pass in the same form, normalised to a gain of one at
   * its centre frequency (so the detector it drives reads the band's own level).
   * @param {object} section the section to write
   * @param {number} frequency the centre frequency, in Hz
   * @param {number} q the section's Q
   * @param {number} rate the host's sample rate
   * @returns {void}
   */
  function setBandPass(section, frequency, q, rate) {
    const k = Math.tan((Math.PI * safeCutoff(frequency, rate)) / rate);
    const a0 = 1 + k / q + k * k;
    section.b0 = k / q / a0;
    section.b1 = 0;
    section.b2 = -k / q / a0;
    section.a1 = (2 * (k * k - 1)) / a0;
    section.a2 = (1 - k / q + k * k) / a0;
  }

  // --- one insert -----------------------------------------------------------

  /**
   * Build one dynamics insert.
   *
   * The returned object is the insert the processor holds: `setParams` once per
   * change, `process` on every block, `reset` when the chain is rebuilt. A gate
   * also answers `state` and `gain` (read-only, see above).
   * @param {"compressor"|"limiter"|"gate"|"deesser"} kind which dynamics this is
   * @param {number} rate the AudioContext's sample rate, in Hz
   * @param {{master?: boolean}} [options] `master: true` makes a limiter the
   *   master limiter (1.5 ms lookahead, true-peak detection); every other insert
   *   ignores it, and every kind but the master limiter is zero-latency
   * @returns {{kind: string, rate: number, latencyFrames: number,
   *            setParams: function(object): void,
   *            process: function(Float32Array, Float32Array|null, number,
   *                             Float32Array|null, Float32Array|null): void,
   *            reset: function(): void,
   *            params: function(): Object<string, number|string>,
   *            state?: boolean, gain?: number}}
   * @throws {Error} when `kind` is not one of `KINDS` (never from `process`)
   */
  function create(kind, rate, options) {
    const name = typeof kind === "string" ? kind : "";
    if (KINDS.indexOf(name) === -1) {
      throw new Error(`"${name}" is not one of Crow's dynamics (${KINDS.join(", ")}).`);
    }
    const sampleRate = positive(rate) || DEFAULT_RATE;
    const master = Boolean(options && options.master === true);

    /** The kind's parameters as they are now, defaults to begin with. */
    const values = {};
    for (const [key, field] of Object.entries(PARAMS[name].params)) values[key] = field.default;

    /** How many frames this insert delays its audio by (0 for everything else). */
    const lookaheadFrames =
      name === "limiter" && master ? Math.max(1, Math.round(MASTER_LOOKAHEAD_SECONDS * sampleRate)) : 0;
    const latencyFrames = lookaheadFrames;

    // Everything below is sized here, once: `process()` allocates nothing.

    /** The compressor's state. */
    const compressor = {
      thresholdDb: -18,
      ratio: 4,
      kneeDb: 6,
      makeupDb: 0,
      peakDetect: true,
      attackCoefficient: 0,
      releaseCoefficient: 0,
      sidechainHighPass: false,
      highPassHz: 0,
      highPass: createBiquadState(),
      gainDb: 0,
      rmsRing: new Float64Array(Math.max(1, Math.round(sampleRate * RMS_WINDOW_SECONDS))),
      rmsIndex: 0,
      rmsFilled: 0,
      rmsSum: 0,
    };

    /** The limiter's state (the track clipper uses only `ceilingLinear`). */
    const limiter = {
      ceilingLinear: dbToGain(-1),
      releaseCoefficient: 0,
      // The audio, delayed by the lookahead, and the gains the lookahead window
      // asks for. A ring of `lookahead + 1` gains is one frame more than the
      // delay, so the window holds the frame being output AND every frame still
      // to come before it reaches the output.
      delayLeft: new Float64Array(Math.max(1, lookaheadFrames)),
      delayRight: new Float64Array(Math.max(1, lookaheadFrames)),
      delayIndex: 0,
      requiredRing: new Float64Array(lookaheadFrames + 1),
      // The peak each of those frames carried, so a ceiling lowered mid-stream
      // can be re-applied to the frames still on their way out.
      peakRing: new Float64Array(lookaheadFrames + 1),
      requiredIndex: 0,
      // How many frames before the frame a ramp is aimed at the ramp lands: never
      // less than the true-peak filter's own lag plus a margin, so the gain is not
      // still arriving when the frames a peak sits between are output.
      rampLead: Math.max(
        LIMITER_RAMP_LEAD_MIN_FRAMES,
        Math.round(lookaheadFrames * LIMITER_RAMP_LEAD_FRACTION),
      ),
      gain: 1,
      detector: createTruePeakState(),
    };

    /** The gate's state. */
    const gate = {
      thresholdDb: -40,
      closeDb: -43,
      attackCoefficient: 0,
      releaseCoefficient: 0,
      holdFrames: 0,
      holdCounter: 0,
      rangeGain: dbToGain(-80),
      detectorCoefficient: 0,
      envelope: 0,
      open: false,
      gain: 0,
    };

    /** The de-esser's state. */
    const deesser = {
      thresholdDb: -24,
      ratio: 4,
      attackCoefficient: onePoleCoefficient(DEESSER_ATTACK_SECONDS * 1000, sampleRate),
      releaseCoefficient: onePoleCoefficient(DEESSER_RELEASE_SECONDS * 1000, sampleRate),
      bandPass: createBiquadState(),
      lowPass: createBiquadState(),
      gain: 1,
    };

    /**
     * One numeric parameter out of a caller's object: clamped into its range,
     * and left where it was when the caller did not send a usable number.
     * @param {object} plain the caller's plain parameter object
     * @param {string} key the parameter's name
     * @param {number} current the value it has now
     * @returns {number}
     */
    function numericOf(plain, key, current) {
      const field = PARAMS[name].params[key];
      const raw = plain[key];
      if (!field || raw === undefined || raw === null) return current;
      const number = Number(raw);
      if (!Number.isFinite(number)) return current;
      return clamp(number, field.min, field.max);
    }

    /** Recompute what a parameter change means for the compressor. @returns {void} */
    function refreshCompressor() {
      compressor.thresholdDb = values.threshold_db;
      compressor.ratio = values.ratio;
      compressor.kneeDb = values.knee_db;
      compressor.makeupDb = values.makeup_db;
      compressor.peakDetect = String(values.detect) !== "rms";
      compressor.attackCoefficient = onePoleCoefficient(values.attack_ms, sampleRate);
      compressor.releaseCoefficient = onePoleCoefficient(values.release_ms, sampleRate);
      compressor.sidechainHighPass = values.sidechain_hp_hz > 0;
      const highPassHz = compressor.sidechainHighPass ? values.sidechain_hp_hz : 0;
      if (highPassHz !== compressor.highPassHz) {
        // A section that was not running (its corner was 0) — or that ran at
        // another corner — starts from silence: its old history would ring a
        // band nobody asked for, and a filter switched on mid-stream would
        // otherwise crackle for a moment.
        if (highPassHz > 0) setHighPass(compressor.highPass, highPassHz, BUTTERWORTH_Q, sampleRate);
        clearBiquad(compressor.highPass);
        compressor.highPassHz = highPassHz;
      }
    }

    /**
     * The requirement each frame still in the lookahead window asks for, from the
     * peak it carried, and the gain held at or below the smallest of them.
     * @returns {void}
     */
    function recomputeLimiterRequirements() {
      const ceiling = limiter.ceilingLinear;
      const requested = limiter.requiredRing;
      let lowest = 1;
      for (let at = 0; at < requested.length; at += 1) {
        const peak = limiter.peakRing[at];
        const needed = peak > ceiling ? ceiling / peak : 1;
        const value = needed > 0 && needed <= 1 ? needed : 1;
        requested[at] = value;
        if (value < lowest) lowest = value;
      }
      if (limiter.gain > lowest) {
        // Lowering the ceiling mid-play steps the gain at once, and that is the
        // requirement — the new ceiling holds from the very next sample, not
        // once the old peaks have drained out of the lookahead. The ramp is for
        // peaks that can be seen coming; a ceiling that just moved cannot be.
        limiter.gain = lowest;
      }
    }

    /** Recompute what a parameter change means for the limiter. @returns {void} */
    function refreshLimiter() {
      const ceiling = dbToGain(values.ceiling_db);
      const ceilingChanged = ceiling !== limiter.ceilingLinear;
      limiter.ceilingLinear = ceiling;
      limiter.releaseCoefficient = onePoleCoefficient(values.release_ms, sampleRate);
      // A ceiling changed while the song plays has to hold AT ONCE, so the frames
      // still on their way to the output are measured against the new one: each
      // stored requirement is recomputed from the peak its frame carried.
      if (ceilingChanged) recomputeLimiterRequirements();
    }

    /** Recompute what a parameter change means for the gate. @returns {void} */
    function refreshGate() {
      gate.thresholdDb = values.threshold_db;
      gate.closeDb = values.threshold_db - values.hysteresis_db;
      gate.attackCoefficient = onePoleCoefficient(values.attack_ms, sampleRate);
      gate.releaseCoefficient = onePoleCoefficient(values.release_ms, sampleRate);
      gate.holdFrames = Math.max(0, Math.round((values.hold_ms / 1000) * sampleRate));
      gate.rangeGain = dbToGain(values.range_db);
      gate.detectorCoefficient = onePoleCoefficient(GATE_DETECTOR_RELEASE_SECONDS * 1000, sampleRate);
    }

    /** Recompute what a parameter change means for the de-esser. @returns {void} */
    function refreshDeesser() {
      deesser.thresholdDb = values.threshold_db;
      deesser.ratio = values.ratio;
      setBandPass(deesser.bandPass, values.freq_hz, DEESSER_Q, sampleRate);
      setLowPass(deesser.lowPass, values.freq_hz * DEESSER_CROSSOVER_FRACTION, BUTTERWORTH_Q, sampleRate);
    }

    /** @returns {void} the kind's derived values from its current parameters. */
    function refresh() {
      if (name === "compressor") refreshCompressor();
      else if (name === "limiter") refreshLimiter();
      else if (name === "gate") refreshGate();
      else refreshDeesser();
    }

    /**
     * Take a plain parameter object — one field per parameter, as the document
     * stores it. A value outside its range is clamped, a name this kind does not
     * have is ignored, and a value that is not a number leaves that parameter
     * alone, so one knob turn is one field. The filters and envelopes keep the
     * state they are in: turning a knob never clicks.
     * @param {Object<string, number|string>} plain
     * @returns {void}
     */
    function setParams(plain) {
      const given = plain && typeof plain === "object" ? plain : {};
      for (const [key, field] of Object.entries(PARAMS[name].params)) {
        if (field.values) {
          if (field.values.indexOf(given[key]) !== -1) values[key] = given[key];
        } else {
          values[key] = numericOf(given, key, values[key]);
        }
      }
      refresh();
    }

    /**
     * Put every recursive stage back to silence. The parameters are untouched,
     * so an insert that is reset plays the sound it was set to.
     * @returns {void}
     */
    function reset() {
      if (name === "compressor") {
        clearBiquad(compressor.highPass);
        compressor.gainDb = 0;
        compressor.rmsRing.fill(0);
        compressor.rmsIndex = 0;
        compressor.rmsFilled = 0;
        compressor.rmsSum = 0;
        return;
      }
      if (name === "limiter") {
        limiter.delayLeft.fill(0);
        limiter.delayRight.fill(0);
        limiter.delayIndex = 0;
        // One, not zero: an empty window asks for no reduction, and a window of
        // zeros would fade the first few frames of the output in from silence.
        limiter.requiredRing.fill(1);
        limiter.peakRing.fill(0);
        limiter.requiredIndex = 0;
        limiter.gain = 1;
        limiter.detector.historyLeft.fill(0);
        limiter.detector.historyRight.fill(0);
        limiter.detector.index = 0;
        return;
      }
      if (name === "gate") {
        gate.gain = gate.rangeGain;
        gate.envelope = 0;
        gate.open = false;
        gate.holdCounter = 0;
        return;
      }
      clearBiquad(deesser.bandPass);
      clearBiquad(deesser.lowPass);
      deesser.gain = 1;
    }

    /** @returns {Object<string, number|string>} a copy of the parameters as they are now. */
    function params() {
      return { ...values };
    }

    /**
     * The frame being worked on, written instead of returned: `process()` may
     * not allocate, and an object literal per frame is an allocation.
     */
    const frame = { outLeft: 0, outRight: 0, gain: 1 };

    /**
     * One frame of the compressor: the detector, the knee, the smoothed gain.
     * Writes `frame`.
     * @param {number} inLeft
     * @param {number} inRight
     * @param {number} detectLeft the detector's left input (the sidechain's when there is one)
     * @param {number} detectRight
     * @returns {void}
     */
    function compressorFrame(inLeft, inRight, detectLeft, detectRight) {
      let left = detectLeft;
      let right = detectRight;
      if (compressor.sidechainHighPass) {
        left = biquadStep(compressor.highPass, compressor.highPass.left, left);
        right = biquadStep(compressor.highPass, compressor.highPass.right, right);
      }
      let levelDb;
      if (compressor.peakDetect) {
        levelDb = levelOf(Math.max(Math.abs(left), Math.abs(right)));
      } else {
        // The mean of L²/R² over the last 10 ms: a ring of the squares, so the
        // window is exactly that long however long the host's blocks are.
        const size = compressor.rmsRing.length;
        const power = (left * left + right * right) * 0.5;
        compressor.rmsSum -= compressor.rmsRing[compressor.rmsIndex];
        compressor.rmsRing[compressor.rmsIndex] = power;
        const wrapped = compressor.rmsIndex + 1 >= size;
        compressor.rmsIndex = wrapped ? 0 : compressor.rmsIndex + 1;
        compressor.rmsSum += power;
        if (compressor.rmsFilled < size) compressor.rmsFilled += 1;
        if (wrapped) {
          // Once per full window, add the ring up again from scratch. A running
          // sum that adds a huge sample and later subtracts it does not come
          // back to what it was: the rounding error of every addition next to it
          // stays, so the sum drifts and can even end up negative — and a
          // negative mean turns into a NaN level and a detector that never
          // compresses again. One O(window) pass every 10 ms throws the drift
          // away (no allocation: the ring is the one `create()` made).
          let sum = 0;
          for (let at = 0; at < size; at += 1) sum += compressor.rmsRing[at];
          compressor.rmsSum = sum;
        }
        // A sum of squares is never negative; holding it there keeps a rounding
        // excursion from reaching the square root.
        compressor.rmsSum = compressor.rmsSum > 0 ? flush(compressor.rmsSum) : 0;
        // The same floor and ceiling a peak reading gets: a mean power of 0 is
        // MIN_LEVEL_DB, and a huge one cannot turn the gain into a NaN later.
        levelDb = levelOf(Math.sqrt(compressor.rmsSum / compressor.rmsFilled));
      }
      // A broken detector reads as silence rather than poisoning the gain.
      if (!(levelDb > MIN_LEVEL_DB)) levelDb = MIN_LEVEL_DB;

      // The standard quadratic soft knee: no reduction under the knee, the
      // ratio above it, and a smooth quadratic join across `knee_db`.
      const over = levelDb - compressor.thresholdDb;
      const halfKnee = compressor.kneeDb * 0.5;
      const slope = 1 / compressor.ratio - 1;
      let targetDb;
      if (over <= -halfKnee) targetDb = 0;
      else if (over >= halfKnee) targetDb = slope * over;
      else {
        const into = over + halfKnee;
        targetDb = (slope * into * into) / (2 * compressor.kneeDb);
      }

      const coefficient =
        targetDb < compressor.gainDb ? compressor.attackCoefficient : compressor.releaseCoefficient;
      compressor.gainDb = flush(compressor.gainDb + coefficient * (targetDb - compressor.gainDb));

      const gain = dbToGain(compressor.gainDb + compressor.makeupDb);
      frame.gain = gain;
      frame.outLeft = inLeft * gain;
      frame.outRight = inRight * gain;
    }

    /**
     * One frame of the master limiter: the true peak of the input, the smallest
     * gain the lookahead window can survive, and the delayed audio scaled by it.
     * Writes `frame`.
     * @param {number} inLeft
     * @param {number} inRight
     * @returns {void}
     */
    function limiterMasterFrame(inLeft, inRight) {
      // What this frame needs: the ceiling over the peak it carries, between
      // samples as well as on them.
      const peak = truePeakStep(limiter.detector, inLeft, inRight);
      const required = peak > limiter.ceilingLinear ? limiter.ceilingLinear / peak : 1;

      // The window's rings run in lockstep with the delay line, so once the new
      // frame is written the write pointer is the OLDEST slot — the frame being
      // output on this one, and the samples it should have been scaled by.
      const requested = limiter.requiredRing;
      const written = limiter.requiredIndex;
      limiter.peakRing[written] = peak;
      requested[written] = required > 0 && required <= 1 ? required : 1;
      limiter.requiredIndex = written + 1 >= requested.length ? 0 : written + 1;

      // The smallest gain anything in the lookahead window asks for, and how many
      // frames there are before the frame that asks for it is handed out. The
      // window covers the frame being output and every frame still to come, which
      // is why the reduction is already in place when a peak reaches the output.
      const length = requested.length;
      const nowRequired = requested[limiter.requiredIndex];
      const held = limiter.gain;
      let target = nowRequired;
      // A straight line down has to be at EVERY slot's own requirement by the
      // time that slot is output, so the line's slope is the steepest of those
      // deadlines — not the one the window's minimum asks for. They differ
      // whenever a deeper peak is further away than a shallower one: aiming at
      // the minimum alone leaves the gain above the nearer, shallower
      // requirement when that frame is handed out, and the clamp below then takes
      // the difference in one step — at the very moment the true peak between the
      // frames already output is what the ceiling is about. Subtracting
      // `rampLead` makes every line land early rather than on the frame itself
      // (`max(1, …)`: a slot inside the lead can only be met now, which is what
      // the clamp is for). Slot 0 is the frame being output, so its line has one
      // frame — the same promise the clamp makes, taken here so the ramp above is
      // decided the same way.
      let steepest = held > nowRequired ? held - nowRequired : 0;
      for (let ahead = 1; ahead < length; ahead += 1) {
        const slot =
          limiter.requiredIndex + ahead >= length
            ? limiter.requiredIndex + ahead - length
            : limiter.requiredIndex + ahead;
        const value = requested[slot];
        if (value < target) target = value;
        if (value < held) {
          const remaining = ahead - limiter.rampLead;
          const frames = remaining > 1 ? remaining : 1;
          const slope = (held - value) / frames;
          if (slope > steepest) steepest = slope;
        }
      }

      if (target < limiter.gain) {
        // Down in a straight line, not in a step, and never below the window's
        // minimum. Recomputing the slope every frame keeps the line straight as
        // the window moves; a nearer or deeper peak arriving mid-ramp steepens it
        // instead of being waited for.
        const next = held - steepest;
        limiter.gain = next > target ? next : target;
      } else {
        // Up per `release_ms`, which is slow enough to be a pole, not a step.
        limiter.gain = flush(limiter.gain + limiter.releaseCoefficient * (target - limiter.gain));
      }

      // The gain the frame being output actually gets. With the slope above this
      // clamp does not bind — the ramp is at each slot's requirement a whole lead
      // before that slot arrives — but it stays as the hard promise: what leaves
      // is never above what the frame being output asked for, not even on the
      // frame a ceiling dropped or a window no ramp could have anticipated.
      const gain = limiter.gain < nowRequired ? limiter.gain : nowRequired;

      // The delayed audio, out of the same slot the new frame goes into.
      const at = limiter.delayIndex;
      const delayedLeft = limiter.delayLeft[at];
      const delayedRight = limiter.delayRight[at];
      limiter.delayLeft[at] = inLeft;
      limiter.delayRight[at] = inRight;
      limiter.delayIndex = at + 1 >= limiter.delayLeft.length ? 0 : at + 1;

      // A last clamp at the ceiling: the ramp can only ever be at or below what
      // the window asked for, so this is a belt to the guaranteed braces — and it
      // is the one place a non-finite frame stops, rather than being played.
      frame.outLeft = clampCeiling(delayedLeft * gain, limiter.ceilingLinear);
      frame.outRight = clampCeiling(delayedRight * gain, limiter.ceilingLinear);
      frame.gain = gain;
    }

    /**
     * One frame of a track's limiter: no lookahead, so nothing can be seen
     * coming — a hard clip at the ceiling, which is what a zero-latency limiter
     * on a track is. Writes `frame`.
     * @param {number} inLeft
     * @param {number} inRight
     * @returns {void}
     */
    function limiterTrackFrame(inLeft, inRight) {
      frame.outLeft = clampCeiling(inLeft, limiter.ceilingLinear);
      frame.outRight = clampCeiling(inRight, limiter.ceilingLinear);
    }

    /**
     * One frame of the gate: the hysteresis that decides whether it is open and
     * the attack/hold/release envelope that decides how far. Writes `frame`.
     * @param {number} inLeft
     * @param {number} inRight
     * @returns {void}
     */
    function gateFrame(inLeft, inRight) {
      // The detector is the linked pair's peak ENVELOPE — instant attack, a 10 ms
      // release — not the raw sample. Raw |sample| crosses zero twice a period,
      // so on a low tone (or with hold at 0) the gate would chatter at every
      // crossing; the envelope follows the waveform's peaks instead.
      const magnitude = Math.max(Math.abs(inLeft), Math.abs(inRight));
      if (magnitude > gate.envelope) gate.envelope = magnitude;
      else gate.envelope = flush(gate.envelope + gate.detectorCoefficient * (magnitude - gate.envelope));

      const levelDb = levelOf(gate.envelope);
      if (gate.open) {
        if (levelDb < gate.closeDb) {
          // Below the closing threshold: the hold counts down, and only then
          // does the gate let go.
          if (gate.holdCounter > 0) gate.holdCounter -= 1;
          else gate.open = false;
        } else {
          gate.holdCounter = gate.holdFrames;
        }
      } else if (levelDb > gate.thresholdDb) {
        gate.open = true;
        gate.holdCounter = gate.holdFrames;
      }

      const target = gate.open ? 1 : gate.rangeGain;
      const coefficient = target > gate.gain ? gate.attackCoefficient : gate.releaseCoefficient;
      gate.gain = flush(gate.gain + coefficient * (target - gate.gain));
      frame.gain = gate.gain;
      frame.outLeft = inLeft * gate.gain;
      frame.outRight = inRight * gate.gain;
    }

    /**
     * One frame of the de-esser: the band drives the detector, the reduction is
     * applied to the high band, and the two bands add back up. Writes `frame`.
     * @param {number} inLeft
     * @param {number} inRight
     * @returns {void}
     */
    function deesserFrame(inLeft, inRight) {
      const bandLeft = biquadStep(deesser.bandPass, deesser.bandPass.left, inLeft);
      const bandRight = biquadStep(deesser.bandPass, deesser.bandPass.right, inRight);
      const levelDb = levelOf(Math.max(Math.abs(bandLeft), Math.abs(bandRight)));
      const over = levelDb - deesser.thresholdDb;
      const target = over > 0 ? dbToGain((1 / deesser.ratio - 1) * over) : 1;
      const coefficient = target < deesser.gain ? deesser.attackCoefficient : deesser.releaseCoefficient;
      deesser.gain = flush(deesser.gain + coefficient * (target - deesser.gain));

      // A subtractive split: the high band is the input minus the low one, so
      // with no reduction the two add straight back up to the input.
      const lowLeft = biquadStep(deesser.lowPass, deesser.lowPass.left, inLeft);
      const lowRight = biquadStep(deesser.lowPass, deesser.lowPass.right, inRight);
      frame.outLeft = lowLeft + (inLeft - lowLeft) * deesser.gain;
      frame.outRight = lowRight + (inRight - lowRight) * deesser.gain;
    }

    /**
     * One run of frames through the insert, in place. The blocks are up to 128
     * frames (the processor's own), the sidechain pair is optional, and a
     * missing right channel is a mono run.
     *
     * Every sample is sanitised on the way in (audio and sidechain alike): a NaN
     * or an infinity from a buffer someone forgot to clear would live in a
     * filter's state or in an envelope for the rest of the session, so it reads
     * as 0 instead — see `finiteSample`.
     * @param {Float32Array} left the left channel, read and written in place
     * @param {Float32Array|null} right the right channel, or null for mono
     * @param {number} frames how many frames this run holds
     * @param {Float32Array|null} [sidechainLeft] the compressor's external
     *   detector input; when given it replaces the audio in the detector
     * @param {Float32Array|null} [sidechainRight] the sidechain's right channel
     * @returns {void}
     */
    function process(left, right, frames, sidechainLeft, sidechainRight) {
      if (!left || typeof left.length !== "number") return;
      const count = Math.trunc(Number(frames));
      if (!(count > 0)) return;
      const end = Math.min(left.length, count);
      if (!(end > 0)) return;
      const hasRight = Boolean(right) && typeof right.length === "number";
      const rightEnd = hasRight ? Math.min(right.length, end) : 0;

      if (name === "compressor") {
        const hasSidechain = Boolean(sidechainLeft) && typeof sidechainLeft.length === "number";
        const sidechainEnd = hasSidechain ? Math.min(sidechainLeft.length, end) : 0;
        const hasSidechainRight = hasSidechain && Boolean(sidechainRight) && typeof sidechainRight.length === "number";
        const sidechainRightEnd = hasSidechainRight ? Math.min(sidechainRight.length, end) : 0;
        for (let index = 0; index < end; index += 1) {
          const inLeft = finiteSample(left[index]);
          const inRight = hasRight && index < rightEnd ? finiteSample(right[index]) : inLeft;
          const detectLeft =
            hasSidechain && index < sidechainEnd ? finiteSample(sidechainLeft[index]) : inLeft;
          const detectRight =
            hasSidechainRight && index < sidechainRightEnd
              ? finiteSample(sidechainRight[index])
              : detectLeft;
          compressorFrame(inLeft, inRight, detectLeft, detectRight);
          left[index] = frame.outLeft;
          if (hasRight && index < rightEnd) right[index] = frame.outRight;
        }
        return;
      }

      if (name === "limiter") {
        const master = lookaheadFrames > 0;
        for (let index = 0; index < end; index += 1) {
          const inLeft = finiteSample(left[index]);
          const inRight = hasRight && index < rightEnd ? finiteSample(right[index]) : inLeft;
          if (master) limiterMasterFrame(inLeft, inRight);
          else limiterTrackFrame(inLeft, inRight);
          left[index] = frame.outLeft;
          if (hasRight && index < rightEnd) right[index] = frame.outRight;
        }
        return;
      }

      if (name === "gate") {
        for (let index = 0; index < end; index += 1) {
          const inLeft = finiteSample(left[index]);
          const inRight = hasRight && index < rightEnd ? finiteSample(right[index]) : inLeft;
          gateFrame(inLeft, inRight);
          left[index] = frame.outLeft;
          if (hasRight && index < rightEnd) right[index] = frame.outRight;
        }
        return;
      }

      for (let index = 0; index < end; index += 1) {
        const inLeft = finiteSample(left[index]);
        const inRight = hasRight && index < rightEnd ? finiteSample(right[index]) : inLeft;
        deesserFrame(inLeft, inRight);
        left[index] = frame.outLeft;
        if (hasRight && index < rightEnd) right[index] = frame.outRight;
      }
    }

    refresh();
    reset();

    const insert = {
      kind: name,
      rate: sampleRate,
      latencyFrames: latencyFrames,
      setParams: setParams,
      process: process,
      reset: reset,
      params: params,
    };

    if (name === "gate") {
      // The gate's own state, read-only: `state` is whether its hysteresis has it
      // open, `gain` is the gain its envelope is applying on this frame (1 open,
      // `range_db`'s gain shut). For tests and for a meter — reading either
      // allocates nothing and there is no setter, so nothing outside can move the
      // audio path's state.
      Object.defineProperty(insert, "state", {
        enumerable: true,
        get: function () {
          return gate.open;
        },
      });
      Object.defineProperty(insert, "gain", {
        enumerable: true,
        get: function () {
          return gate.gain;
        },
      });
    }

    return insert;
  }

  const api = {
    create: create,
    KINDS: KINDS,
    PARAMS: PARAMS,
    DENORMAL_FLOOR: DENORMAL_FLOOR,
    MASTER_LOOKAHEAD_SECONDS: MASTER_LOOKAHEAD_SECONDS,
    TRUE_PEAK_OVERSAMPLE: TRUE_PEAK_OVERSAMPLE,
    TRUE_PEAK_PHASES: Object.freeze(TRUE_PEAK_PHASES),
    truePeakDb: truePeakDb,
  };

  if (typeof globalThis !== "undefined") globalThis.StudioDynamics = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();