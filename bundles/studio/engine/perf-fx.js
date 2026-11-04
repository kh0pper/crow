/**
 * Studio performance-effects bus — the hold-to-apply effects and the looper.
 *
 * The five effects sit on the master bus and are held by a button (a panel pad,
 * a MIDI pedal later): while a button is down its effect is applied to the whole
 * mix, and letting go hands the dry signal back. They are live state, never
 * part of the song: no command, no history step and no undo ever sees them, and
 * nothing but `release()` — not a scene launch, not a transport stop, not a
 * pattern change — ends one.
 *
 *     tracks → master mix → looper → performance bus → clip/limit → output
 *
 * The processor calls `loop()` first — the looper taps the master BEFORE any
 * effect and mixes its own take back in — then `process()`, then the clip. The
 * master tap a recorder listens to is downstream of both, so what it copies is
 * what the room hears.
 *
 * It is a classic script (no `import`/`export`): it assigns
 * `globalThis.StudioPerfFx` for the worklet scope and `module.exports` when a
 * CommonJS `module` exists. `engine/package.json` marks that directory
 * `"commonjs"`, so a Node `require()` of this file works inside the bundle's
 * ESM tree; `engine-client.js` also concatenates it into the worklet module (a
 * worklet cannot import), which is why it must not depend on anything.
 *
 * ## The chain
 *
 * Holding several effects chains them in this fixed order, whatever order they
 * were pressed in:
 *
 *     stutter → tape_stop → filter_sweep → lofi → reverb_throw
 *
 * - **filter_sweep** — one resonant (Q 4) state-variable filter whose cutoff
 *   sweeps exponentially from 20 kHz down to 200 Hz as the amount goes 0 → 1,
 *   as a low pass up to 0.5 and a high pass above it.
 * - **lofi** — bit depth 16 → 4 bits, a sample-and-hold whose factor runs 1 → 8
 *   frames, and a −60 dBFS × amount noise floor from an xorshift32 PRNG seeded
 *   0x9E3779B9 afresh on every hold.
 * - **stutter** — repeats one division of a beat (1/4, 1/8 or 1/16 by the
 *   amount) ON the beat grid. The slice is the division the hold frame sits
 *   inside, `[boundary, boundary + division)`, and it repeats from `boundary +
 *   division` on, so every repeat begins exactly on a division line however
 *   late inside the division the button went down. The bus keeps a trailing
 *   ring of one quarter of a beat at the slowest tempo a song may run at (20
 *   bpm) — allocated once in `create()`, never on a hold, and written one frame
 *   per frame — so the part of the slice that has already played is repeated
 *   out of the ring and only the rest is captured live, the live signal passing
 *   through until `boundary + division`. With no bar line (a stopped transport)
 *   the hold frame is the boundary.
 * - **tape_stop** — the read head slows linearly from speed 1 to speed 0 over
 *   exactly one beat from the hold frame, reading a ring buffer with linear
 *   interpolation, and the output is silence from the frame the speed reaches
 *   0. Because the head only ever lags the write head inside one beat, the ring
 *   it needs is allocated on the hold and is never filled while idle.
 * - **reverb_throw** — a send into a deterministic Schroeder reverb (four
 *   parallel combs 1557/1617/1491/1422 frames at 44.1 kHz, feedback 0.84,
 *   damping 0.2, then two allpasses 225/556 at g 0.5, the lengths scaled to the
 *   host's rate). Its return adds to the dry signal, so the tail keeps ringing
 *   after the button is released.
 *
 * ## Release
 *
 * Every effect except the reverb throw crossfades wet → dry linearly over
 * exactly 64 frames from the frame after the release, and is then dropped with
 * its state: from 64 frames after the release the bus writes nothing at all,
 * so the output equals its input bit for bit. The reverb's send closes on
 * release and its tail rings out. Its delay lines are the tail: once the peak
 * of what they hold (and of the return) over a 128-frame block falls below
 * −120 dBFS, AND the longest comb plus the longest allpass have had time to
 * empty since the send closed — the very first quiet block of a ring still full
 * of a loud signal is not a finished tail — the state is cleared and the bus is
 * bit-exact dry again. Nothing is ever summed into the signal as `x + 0`, so a
 * −0 sample stays a −0 sample.
 *
 * A **re-hold** while an effect is still applied continues from the state it is
 * in: a hold on an effect that is already held follows the amount (a knob
 * sweep), a hold during the crossfade reverses the crossfade at the same rate —
 * from the wet level it had reached, so there is no click — and a hold on a
 * reverb that is ringing its tail reopens the send without clearing it. A
 * release during such a ramp back up carries on down from where the mix is.
 *
 * The bus costs one store per channel per frame while the playhead runs (the
 * stutter's trailing ring, above) and nothing else when no effect is held and
 * the looper is empty: no other state is read or written and the master is
 * bit-exact.
 *
 * ## The looper
 *
 * `looper(action)` takes `record`, `overdub`, `play`, `stop` or `clear`, all
 * quantized to the bar. `record` starts on the next bar line and ends on the
 * bar line AFTER the next `play`/`overdub`/`record` (whole bars, at most 8);
 * `play` loops the take mixed into the master; `overdub` adds the live master
 * into the take while it plays; `stop` during a recording keeps the whole bars
 * it captured (and discards it if it captured none) and leaves it for a later
 * `play`/`overdub`; `clear` empties it at once. The take taps the master BEFORE
 * the effects, so a held stutter or reverb is not baked into the loop.
 *
 * **The audio thread allocates nothing for the looper.** The buffers are the
 * main thread's: `setLooperBuffers(left, right)` adopts a pair sized for eight
 * bars at the song's current tempo, and a recording that would pass the end of
 * them ends at the last whole bar that fits. `takeLooperBuffers()` hands those
 * buffers back — whole bars of the master as `{left, right, frames, bars,
 * rate}` — with the looper detached from them; while they are away the looper
 * contributes silence (the dry master still passes through) and keeps its
 * position, so it carries on from where it was when the same buffers come back
 * through `setLooperBuffers`. The take is rare and short, which is why the
 * handover is a transfer and not a copy; the page makes its own copy (clipped
 * to [−1, 1], because the looper taps the mix before the clip).
 *
 * ## Transport
 *
 * `process(left, right, frames, transport)` and `loop(...)` take
 *
 *     transport = {frame, playing, bpm, beatsPerBar, barFrame, nextBarFrame, offset?}
 *
 * where `frame` is the absolute frame of `left[0]`, `barFrame` is the frame of
 * the bar line the playhead is inside, `nextBarFrame` the NEXT real bar line on
 * the sequencer's own grid (a tempo change moves it: it is never assumed to be
 * `barFrame + barFrames` at the current tempo), and the optional `offset` is the
 * index in `left` this run starts at (the processor renders one block in
 * several runs, one per sequencer event). Both bar fields are `null` when there
 * is no grid (the transport is stopped) and are read as null when missing;
 * `Number(null)` is never allowed to turn a stopped transport into bar 0.
 * Everything is worked out from `frame`, so a run split any way at all produces
 * the same frames.
 *
 * ## Why it is bit-identical in Chromium and Node
 *
 * Only IEEE double `+ - * /`, `Math.abs`, `Math.floor`, `Math.round`, `Math.tan`
 * and `Math.pow`, in a fixed order, with `Float32Array` samples in and out. No
 * `Math.random` (the lo-fi noise is the seeded xorshift32), no
 * `Float32Array.prototype.sort`, no table built from a host-specific value:
 * both hosts run the same V8 and produce the same bits.
 *
 * ## No denormals
 *
 * Every recursive stage — the state-variable filter's two states per channel,
 * the reverb's combs and allpasses — is flushed to exactly 0 below 1e-30, so a
 * decaying tail cannot cost a CPU spike on one machine and not another.
 */
(function () {
  "use strict";

  /** Below this, a recursive stage's state is flushed to exactly 0. */
  const DENORMAL_FLOOR = 1e-30;

  /** How long a releasing effect crossfades wet → dry, in frames. */
  const RELEASE_FRAMES = 64;

  /** The reverb's tail is cleared once a block's peak is below this (−120 dBFS). */
  const TAIL_FLOOR = 1e-6;

  /** How many frames the reverb's tail peak is measured over. */
  const TAIL_BLOCK_FRAMES = 128;

  /** The rate a bus created without one runs at. */
  const DEFAULT_RATE = 48000;

  /** The tempo a transport without a usable one is measured at. */
  const DEFAULT_BPM = 120;

  /** Four beats to the bar, as everywhere in Studio. */
  const BEATS_PER_BAR = 4;

  /** The order effects are chained in, whatever order they were held in. */
  const CHAIN = Object.freeze(["stutter", "tape_stop", "filter_sweep", "lofi", "reverb_throw"]);

  /** The filter sweep's ends, in Hz, and its resonance. */
  const SWEEP_HIGHEST_HZ = 20000;
  const SWEEP_LOWEST_HZ = 200;
  const SWEEP_Q = 4;

  /** Above this amount the sweep is a high pass rather than a low pass. */
  const SWEEP_HIGH_PASS_FROM = 0.5;

  /** Lo-fi's ends: 16 bits down to 4, and a hold of 1 frame up to 8. */
  const LOFI_HIGHEST_BITS = 16;
  const LOFI_LOWEST_BITS = 4;
  const LOFI_HIGHEST_HOLD = 8;

  /** The lo-fi noise floor at full amount, in dB, and the PRNG seed. */
  const LOFI_NOISE_DB = -60;
  const LOFI_SEED = 0x9e3779b9;

  /** Stutter's divisions of a beat, by amount: below 0.34, below 0.67, else. */
  const STUTTER_QUARTER = 0.25;
  const STUTTER_EIGHTH = 0.125;
  const STUTTER_SIXTEENTH = 0.0625;

  /** The reverb's delay lengths at 44.1 kHz, its feedback and its damping. */
  const REVERB_COMB_FRAMES = Object.freeze([1557, 1617, 1491, 1422]);
  const REVERB_ALLPASS_FRAMES = Object.freeze([225, 556]);
  const REVERB_FEEDBACK = 0.84;
  const REVERB_DAMPING = 0.2;
  const REVERB_ALLPASS_GAIN = 0.5;

  /** The rate those lengths are quoted at, and the wet return's level. */
  const REVERB_REFERENCE_RATE = 44100;
  const REVERB_WET_GAIN = 0.3;

  /** The longest take the looper records, in bars. */
  const MAX_LOOP_BARS = 8;

  /**
   * The slowest tempo a song may run at, in bpm. The stutter's trailing ring is
   * sized for one quarter of a beat at this tempo, which is the longest slice a
   * stutter can ask for.
   */
  const SLOWEST_BPM = 20;

  /** A transport a caller that passes none is read as: stopped, at 120 bpm. */
  const DEFAULT_TRANSPORT = Object.freeze({
    frame: 0,
    offset: 0,
    playing: false,
    bpm: DEFAULT_BPM,
    beatsPerBar: BEATS_PER_BAR,
    barFrame: null,
    nextBarFrame: null,
  });

  /** @returns {number} the value when it is a finite number, else the fallback. */
  function finiteOr(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

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
   * A transport frame as a whole number, or null when the transport has none.
   *
   * A stopped transport reports `barFrame`/`nextBarFrame` as null, and a caller
   * that omits one means the same thing. `Number(null)` is 0, so a null must be
   * caught here: reading it as bar 0 would quantize a stopped looper to a bar
   * line that does not exist.
   * @param {unknown} value
   * @returns {number|null}
   */
  function frameOrNull(value) {
    if (value === null || value === undefined) return null;
    const number = Number(value);
    return Number.isFinite(number) ? Math.trunc(number) : null;
  }

  /**
   * An amount as the 0..1 the effects read: a missing or non-finite amount is 0.
   * @param {unknown} value
   * @returns {number}
   */
  function amountOf(value) {
    return clamp(finiteOr(value, 0), 0, 1);
  }

  /**
   * How many frames one beat lasts at a tempo.
   * @param {number} bpm
   * @param {number} rate
   * @returns {number}
   */
  function beatFramesAt(bpm, rate) {
    const tempo = positive(bpm) || DEFAULT_BPM;
    return (rate * 60) / tempo;
  }

  /**
   * How many frames one bar lasts at a tempo.
   * @param {number} bpm
   * @param {number} rate
   * @param {number} beatsPerBar
   * @returns {number}
   */
  function barFramesAt(bpm, rate, beatsPerBar) {
    const beats = positive(beatsPerBar) || BEATS_PER_BAR;
    return beatFramesAt(bpm, rate) * beats;
  }

  // --- the effects' own arithmetic -----------------------------------------

  /**
   * One division of a beat, by the stutter's amount.
   * @param {number} amount 0..1
   * @returns {number} the division, as a fraction of a beat
   */
  function stutterDivisionOf(amount) {
    if (amount < 0.34) return STUTTER_QUARTER;
    if (amount < 0.67) return STUTTER_EIGHTH;
    return STUTTER_SIXTEENTH;
  }

  /**
   * The next value of an xorshift32 PRNG, in [-1, 1).
   * @param {object} state the record holding `seed`
   * @returns {number}
   */
  function nextNoise(state) {
    let x = state.seed;
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    state.seed = x;
    return x / 2147483648 - 1;
  }

  /**
   * The filter sweep's coefficients for one amount (the TPT state-variable
   * filter, which stays stable at any cutoff, unlike the naive Chamberlin form
   * at 20 kHz).
   *
   * The cutoff is exponential from 20 kHz down to 200 Hz. Below 0.5 the filter
   * takes its low-pass output and above it the high-pass one, so a full sweep is
   * a resonance that closes and then opens again.
   * @param {object} state the sweep's record
   * @param {number} amount 0..1
   * @param {number} rate the host's sample rate
   * @returns {void}
   */
  function setSweep(state, amount, rate) {
    const sweep = clamp(amount, 0, 1);
    const cutoff = clamp(
      SWEEP_HIGHEST_HZ * Math.pow(SWEEP_LOWEST_HZ / SWEEP_HIGHEST_HZ, sweep),
      10,
      rate * 0.45,
    );
    const g = Math.tan((Math.PI * cutoff) / rate);
    const k = 1 / SWEEP_Q;
    const a1 = 1 / (1 + g * (g + k));
    const a2 = g * a1;
    state.k = k;
    state.a1 = a1;
    state.a2 = a2;
    state.a3 = g * a2;
    state.highPass = sweep >= SWEEP_HIGH_PASS_FROM;
    state.cutoffHz = cutoff;
  }

  /** One channel of the sweep's state-variable low/high pass, one frame. */
  function sweepChannel(state, input, which) {
    const ic1 = which === 0 ? state.ic1Left : state.ic1Right;
    const ic2 = which === 0 ? state.ic2Left : state.ic2Right;
    const v3 = flush(input - ic2);
    const v1 = state.a1 * ic1 + state.a2 * v3;
    const v2 = ic2 + state.a2 * ic1 + state.a3 * v3;
    const nextIc1 = flush(2 * v1 - ic1);
    const nextIc2 = flush(2 * v2 - ic2);
    if (which === 0) {
      state.ic1Left = nextIc1;
      state.ic2Left = nextIc2;
    } else {
      state.ic1Right = nextIc1;
      state.ic2Right = nextIc2;
    }
    const out = state.highPass ? input - state.k * v1 - v2 : v2;
    return flush(out);
  }

  /**
   * The lo-fi amount as its three parameters: the quantiser's scale, the
   * sample-and-hold length and the noise floor's level.
   * @param {object} state the lo-fi record
   * @param {number} amount 0..1
   * @returns {void}
   */
  function setLofi(state, amount) {
    const lofi = clamp(amount, 0, 1);
    const bits = LOFI_HIGHEST_BITS - (LOFI_HIGHEST_BITS - LOFI_LOWEST_BITS) * lofi;
    state.scale = Math.pow(2, bits - 1);
    state.holdFrames = 1 + Math.round((LOFI_HIGHEST_HOLD - 1) * lofi);
    state.noiseLevel = Math.pow(10, LOFI_NOISE_DB / 20) * lofi;
  }

  /** @returns {number} one sample quantised to a bit depth of `scale` levels. */
  function quantise(value, scale) {
    return Math.round(finiteOr(value, 0) * scale) / scale;
  }

  /** @returns {object} a comb, with its own delay line and damping store. */
  function createComb(frames) {
    return { buffer: new Float32Array(frames), index: 0, damp: 0 };
  }

  /** @returns {object} an allpass, with its own delay line. */
  function createAllpass(frames) {
    return { buffer: new Float32Array(frames), index: 0 };
  }

  /** One frame of a reverb comb (a delay with a damped feedback loop). */
  function combFrame(comb, input) {
    const buffer = comb.buffer;
    const out = buffer[comb.index];
    comb.damp = flush(out * (1 - REVERB_DAMPING) + comb.damp * REVERB_DAMPING);
    const written = flush(input + comb.damp * REVERB_FEEDBACK);
    buffer[comb.index] = written;
    comb.index = comb.index + 1 >= buffer.length ? 0 : comb.index + 1;
    // What the line holds this frame, for the tail measurement: a line full of
    // signal is a tail that has not finished, whatever the return happens to
    // cancel to.
    comb.level = Math.max(Math.abs(out), Math.abs(written));
    return out;
  }

  /** One frame of a reverb allpass. */
  function allpassFrame(allpass, input) {
    const buffer = allpass.buffer;
    const out = buffer[allpass.index];
    const written = flush(input + out * REVERB_ALLPASS_GAIN);
    buffer[allpass.index] = written;
    allpass.index = allpass.index + 1 >= buffer.length ? 0 : allpass.index + 1;
    allpass.level = Math.max(Math.abs(out), Math.abs(written));
    return out - input;
  }

  /**
   * Scale a delay length quoted at 44.1 kHz to a host's rate.
   * @param {number} frames
   * @param {number} rate
   * @returns {number}
   */
  function scaledDelay(frames, rate) {
    return Math.max(1, Math.round((frames * rate) / REVERB_REFERENCE_RATE));
  }

  /**
   * Build a performance-effects bus for one host's sample rate.
   * @param {number} rate the AudioContext's sample rate, in Hz
   * @returns {{hold: function(string, number): void,
   *            release: function(string): void,
   *            process: function(Float32Array, Float32Array|null, number, object): void,
   *            loop: function(Float32Array, Float32Array|null, number, object): void,
   *            looper: function(string): void,
   *            take: function(): {channels: Float32Array[], rate: number, bars: number},
   *            activeCount: function(): number,
   *            heldNames: function(): string[]}}
   */
  function create(rate) {
    const sampleRate = positive(rate) || DEFAULT_RATE;

    /** The effect states, created on first use and kept in CHAIN order. */
    const states = [];

    /** How many of them are live: 0 means the bus costs nothing at all. */
    let activeCount = 0;

    /** Effect changes waiting for the next block's first frame. */
    const pending = [];

    // --- the stutter's trailing ring --------------------------------------
    //
    // One quarter of a beat at the slowest tempo a song may run at: the longest
    // slice a stutter can ask for, already behind the hold frame when the button
    // goes down. Allocated here, once, so a hold never allocates on the audio
    // thread; the slice itself is copied into its own fixed buffer out of it.
    const ringFrames = Math.max(1, Math.ceil((sampleRate * 60) / SLOWEST_BPM / 4));
    const ringLeft = new Float32Array(ringFrames);
    const ringRight = new Float32Array(ringFrames);

    /** Where the next frame of the master goes in the ring. */
    let ringIndex = 0;

    /**
     * How many frames the ring holds without a gap, ending at the frame the next
     * write goes to. It restarts at 0 whenever the ring is not written (a stopped
     * transport), so a slice never begins with audio from before a gap.
     */
    let ringFilled = 0;

    /** The stutter's slice, copied out of the ring and the live signal. */
    const stutterLeft = new Float32Array(ringFrames);
    const stutterRight = new Float32Array(ringFrames);

    // --- the looper's state ------------------------------------------------

    /**
     * The main thread's buffers, `{left, right}`, or null while they are away on
     * a take (or before the page has sent any). The looper allocates none.
     */
    let buffers = null;

    /** `idle`, `recording`, `playing` or `overdub`. */
    let mode = "idle";

    /** The action waiting for a bar line (`record`, `finish`, `play`, ...). */
    let pendingAction = null;

    /** How many frames of the recording in progress have been written. */
    let recFrames = 0;

    /** How many frames one bar was when the recording started. */
    let recBarFrames = 1;

    /** How many frames a recording may fill: whole bars, at most eight. */
    let recCapacity = 0;

    /** The take's length in whole bars and in frames; 0 when there is none. */
    let takeBars = 0;
    let takeFrames = 0;

    /** Where the take is reading, in frames from its own first one. */
    let position = 0;

    // --- the effects ------------------------------------------------------

    /**
     * An idle effect record. `releasing` is −1 while the effect is held and the
     * number of frames since the release while it fades out.
     * @param {string} name
     * @returns {object}
     */
    function newState(name) {
      return {
        name: name,
        active: false,
        held: false,
        amount: 0,
        releasing: -1,
        lastAmount: -1,
      };
    }

    /** @returns {object|null} the state of one effect, created on first use. */
    function stateFor(name) {
      for (let at = 0; at < states.length; at += 1) {
        if (states[at].name === name) return states[at];
      }
      if (CHAIN.indexOf(name) === -1) return null;
      const state = newState(name);
      if (name === "lofi") {
        state.seed = LOFI_SEED;
        state.scale = Math.pow(2, LOFI_HIGHEST_BITS - 1);
        state.holdFrames = 1;
        state.holdCounter = 0;
        state.noiseLevel = 0;
        state.heldLeft = 0;
        state.heldRight = 0;
      } else if (name === "filter_sweep") {
        state.ic1Left = 0;
        state.ic2Left = 0;
        state.ic1Right = 0;
        state.ic2Right = 0;
        state.highPass = false;
        state.cutoffHz = SWEEP_HIGHEST_HZ;
        state.k = 1 / SWEEP_Q;
        state.a1 = 0;
        state.a2 = 0;
        state.a3 = 0;
      } else if (name === "stutter") {
        state.sliceFrames = 0;
        state.captured = 0;
        state.division = STUTTER_EIGHTH;
        state.position = 0;
      } else if (name === "tape_stop") {
        state.ringLeft = new Float32Array(0);
        state.ringRight = new Float32Array(0);
        state.ringFrames = 0;
        state.writeIndex = 0;
        state.readPosition = 0;
        state.startFrame = 0;
        state.rampFrames = 1;
      } else {
        state.combsLeft = [];
        state.combsRight = [];
        state.allpassesLeft = [];
        state.allpassesRight = [];
        for (let at = 0; at < REVERB_COMB_FRAMES.length; at += 1) {
          state.combsLeft.push(createComb(scaledDelay(REVERB_COMB_FRAMES[at], sampleRate)));
          state.combsRight.push(createComb(scaledDelay(REVERB_COMB_FRAMES[at], sampleRate)));
        }
        for (let at = 0; at < REVERB_ALLPASS_FRAMES.length; at += 1) {
          state.allpassesLeft.push(createAllpass(scaledDelay(REVERB_ALLPASS_FRAMES[at], sampleRate)));
          state.allpassesRight.push(createAllpass(scaledDelay(REVERB_ALLPASS_FRAMES[at], sampleRate)));
        }
        // A tail cannot be finished before its longest comb plus its longest
        // allpass has had time to empty: the lines hold the loudest part of the
        // return, and a block of quiet output over a full line is not a tail's end.
        let longest = 0;
        for (let at = 0; at < REVERB_COMB_FRAMES.length; at += 1) {
          longest = Math.max(longest, scaledDelay(REVERB_COMB_FRAMES[at], sampleRate));
        }
        let allpassLongest = 0;
        for (let at = 0; at < REVERB_ALLPASS_FRAMES.length; at += 1) {
          allpassLongest = Math.max(allpassLongest, scaledDelay(REVERB_ALLPASS_FRAMES[at], sampleRate));
        }
        state.settleFrames = longest + allpassLongest;
        state.tailPeak = 0;
        state.tailFrames = 0;
        state.tailSince = 0;
      }
      states.push(state);
      states.sort(byChainOrder);
      return state;
    }

    /** @returns {number} where a state sits in the fixed chain order. */
    function byChainOrder(left, right) {
      return CHAIN.indexOf(left.name) - CHAIN.indexOf(right.name);
    }

    /** @returns {void} empty the reverb's delay lines, so a new throw starts clean. */
    function clearReverb(state) {
      for (const comb of state.combsLeft) comb.buffer.fill(0);
      for (const comb of state.combsRight) comb.buffer.fill(0);
      for (const allpass of state.allpassesLeft) allpass.buffer.fill(0);
      for (const allpass of state.allpassesRight) allpass.buffer.fill(0);
      for (const comb of state.combsLeft) {
        comb.index = 0;
        comb.damp = 0;
      }
      for (const comb of state.combsRight) {
        comb.index = 0;
        comb.damp = 0;
      }
      for (const allpass of state.allpassesLeft) allpass.index = 0;
      for (const allpass of state.allpassesRight) allpass.index = 0;
      state.tailPeak = 0;
      state.tailFrames = 0;
      state.tailSince = 0;
    }

    /**
     * Start (or restart) one effect at a frame: its state is reset, and the
     * effects that need the clock are anchored on this very frame.
     * @param {object} state
     * @param {number} frame the absolute frame the hold takes effect at
     * @param {number} amount 0..1
     * @param {object} transport
     * @returns {void}
     */
    function activate(state, frame, amount, transport) {
      state.held = true;
      state.releasing = -1;
      if (!state.active) {
        state.active = true;
        activeCount += 1;
      }
      state.amount = amount;
      state.lastAmount = amount;

      if (state.name === "stutter") {
        const division = stutterDivisionOf(amount);
        const beatFrames = beatFramesAt(transport.bpm, sampleRate);
        const wanted = Math.max(1, Math.round(beatFrames * division));
        // The slice is never longer than the ring: at any tempo a song may run at
        // (20 bpm up) the ring is exactly one quarter-beat long, so this only
        // bites below the slowest tempo the song rules allow.
        const frames = Math.min(wanted, ringFrames);
        const barFrame = frameOrNull(transport.barFrame);
        // The division boundary the hold frame sits in. With no bar line there is
        // no grid to land on, so the hold frame IS the boundary.
        let boundary = frame;
        if (barFrame !== null && frame > barFrame) {
          boundary = barFrame + Math.floor((frame - barFrame) / frames) * frames;
        }
        // How much of the slice has already played: the part that is in the ring.
        const wantedReady = Math.max(0, Math.min(frames, frame - boundary));
        let ready = Math.min(wantedReady, ringFilled);
        if (ready < wantedReady) {
          // The playhead has not run that long: align on the oldest frame the ring
          // really holds, so a repeat never starts with audio from before a gap.
          boundary = frame - ready;
          if (ready < 0) ready = 0;
        }
        let slot = ringIndex - ready;
        while (slot < 0) slot += ringFrames;
        for (let at = 0; at < ready; at += 1) {
          let from = slot + at;
          while (from >= ringFrames) from -= ringFrames;
          stutterLeft[at] = ringLeft[from];
          stutterRight[at] = ringRight[from];
        }
        state.division = division;
        state.sliceFrames = frames;
        state.captured = ready;
        state.position = 0;
        return;
      }

      if (state.name === "tape_stop") {
        const beatFrames = Math.max(1, Math.round(beatFramesAt(transport.bpm, sampleRate)));
        const ring = beatFrames + 2;
        if (state.ringFrames !== ring) {
          state.ringLeft = new Float32Array(ring);
          state.ringRight = new Float32Array(ring);
          state.ringFrames = ring;
        } else {
          state.ringLeft.fill(0);
          state.ringRight.fill(0);
        }
        state.writeIndex = 0;
        state.readPosition = 0;
        state.startFrame = frame;
        state.rampFrames = beatFrames;
        return;
      }

      if (state.name === "filter_sweep") {
        state.ic1Left = 0;
        state.ic2Left = 0;
        state.ic1Right = 0;
        state.ic2Right = 0;
        setSweep(state, amount, sampleRate);
        return;
      }

      if (state.name === "lofi") {
        state.seed = LOFI_SEED;
        state.holdCounter = 0;
        state.heldLeft = 0;
        state.heldRight = 0;
        setLofi(state, amount);
        return;
      }

      clearReverb(state);
    }

    /**
     * Follow a live amount change (a knob sweep while the button is held). Every
     * effect that reads its amount continuously is re-parameterised; the
     * stutter's division and the tape stop's ramp are fixed at the hold.
     * @param {object} state
     * @param {number} amount
     * @returns {void}
     */
    function setAmount(state, amount) {
      if (state.lastAmount === amount) return;
      state.lastAmount = amount;
      state.amount = amount;
      if (state.name === "filter_sweep") setSweep(state, amount, sampleRate);
      else if (state.name === "lofi") setLofi(state, amount);
    }

    /**
     * Take one effect out of the chain: it stops being applied and its state is
     * dropped, so the signal passes through it untouched from the next frame.
     * @param {object} state
     * @returns {void}
     */
    function drop(state) {
      if (!state.active) return;
      state.active = false;
      state.held = false;
      state.releasing = -1;
      state.amount = 0;
      state.lastAmount = -1;
      if (state.name === "reverb_throw") clearReverb(state);
      activeCount -= 1;
    }

    /**
     * Hold one effect at an amount. The change takes effect at the next block's
     * first frame; an unknown name is ignored.
     * @param {string} name one of `CHAIN`
     * @param {number} amount 0..1
     * @returns {void}
     */
    function hold(name, amount) {
      const key = typeof name === "string" ? name : String(name === undefined || name === null ? "" : name);
      if (CHAIN.indexOf(key) === -1) return;
      pending.push({ on: true, name: key, amount: amountOf(amount) });
    }

    /**
     * Let one effect go. A held effect crossfades back to dry over 64 frames
     * (the reverb throw closes its send and rings out); a name that is not held
     * is ignored.
     * @param {string} name
     * @returns {void}
     */
    function release(name) {
      const key = typeof name === "string" ? name : String(name === undefined || name === null ? "" : name);
      if (CHAIN.indexOf(key) === -1) return;
      pending.push({ on: false, name: key, amount: 0 });
    }

    /**
     * Apply the queued holds and releases at one frame.
     * @param {number} frame the absolute frame the next run starts at
     * @param {object} transport
     * @returns {void}
     */
    function applyPending(frame, transport) {
      if (pending.length === 0) return;
      for (let at = 0; at < pending.length; at += 1) {
        const item = pending[at];
        const state = stateFor(item.name);
        if (!state) continue;
        if (item.on) {
          // A hold on an effect that is still applied — held, crossfading back to
          // dry, or (the reverb) ringing its tail — continues from the state it is
          // in: a knob sweep follows the amount, a re-hold picks the wet signal up
          // where it is instead of restarting it with a click, and a reverb send
          // reopens without clearing the tail it is still ringing. Only an effect
          // that has been dropped is started again, state and all.
          if (state.active) {
            state.held = true;
            if (state.name === "reverb_throw") state.tailSince = 0;
            setAmount(state, item.amount);
          } else {
            activate(state, frame, item.amount, transport);
          }
          continue;
        }
        if (!state.active) continue;
        // A second release of an effect that is already on its way out changes
        // nothing, so it cannot restart a crossfade at full wet.
        if (!state.held) continue;
        state.held = false;
        // The reverb throw is a send: closing it leaves the tail to ring. Every
        // other effect hands the dry signal back over the crossfade instead —
        // continuing a fade it was already in the middle of, so releasing during a
        // re-hold's ramp back up never jumps either.
        if (state.name !== "reverb_throw" && state.releasing < 0) state.releasing = 0;
      }
      pending.length = 0;
    }

    // --- the effects' per-frame work --------------------------------------

    /**
     * One frame through one effect: writes `state.outLeft`/`state.outRight`.
     * @param {object} state
     * @param {number} inLeft
     * @param {number} inRight
     * @param {number} frame the absolute frame
     * @returns {void}
     */
    function stepEffect(state, inLeft, inRight, frame) {
      if (state.name === "stutter") {
        if (state.captured < state.sliceFrames) {
          // The slice is still filling: the live signal passes through, and the
          // frame it fills from now on is the one this very frame plays.
          stutterLeft[state.captured] = inLeft;
          stutterRight[state.captured] = inRight;
          state.captured += 1;
          state.outLeft = inLeft;
          state.outRight = inRight;
          return;
        }
        const at = state.position;
        state.outLeft = stutterLeft[at];
        state.outRight = stutterRight[at];
        state.position = at + 1 >= state.sliceFrames ? 0 : at + 1;
        return;
      }

      if (state.name === "tape_stop") {
        const size = state.ringFrames;
        state.ringLeft[state.writeIndex] = inLeft;
        state.ringRight[state.writeIndex] = inRight;
        state.writeIndex = state.writeIndex + 1 >= size ? 0 : state.writeIndex + 1;
        const passed = frame - state.startFrame;
        if (passed < 0 || passed >= state.rampFrames) {
          state.outLeft = 0;
          state.outRight = 0;
          return;
        }
        const speed = 1 - passed / state.rampFrames;
        const read = state.readPosition;
        const base = Math.floor(read);
        const fraction = read - base;
        const here = base % size;
        const next = here + 1 >= size ? 0 : here + 1;
        const left = state.ringLeft[here] + (state.ringLeft[next] - state.ringLeft[here]) * fraction;
        const right = state.ringRight[here] + (state.ringRight[next] - state.ringRight[here]) * fraction;
        state.outLeft = flush(left);
        state.outRight = flush(right);
        state.readPosition = read + speed;
        return;
      }

      if (state.name === "filter_sweep") {
        state.outLeft = sweepChannel(state, inLeft, 0);
        state.outRight = sweepChannel(state, inRight, 1);
        return;
      }

      if (state.name === "lofi") {
        const noiseLeft = nextNoise(state) * state.noiseLevel;
        const noiseRight = nextNoise(state) * state.noiseLevel;
        if (state.holdCounter === 0) {
          state.heldLeft = quantise(inLeft + noiseLeft, state.scale);
          state.heldRight = quantise(inRight + noiseRight, state.scale);
        }
        state.holdCounter = state.holdCounter + 1 >= state.holdFrames ? 0 : state.holdCounter + 1;
        state.outLeft = state.heldLeft;
        state.outRight = state.heldRight;
        return;
      }

      // reverb_throw: a send, whose return adds to the dry signal.
      const send = state.held ? state.amount : 0;
      const wetInputLeft = inLeft * send;
      const wetInputRight = inRight * send;
      let sumLeft = 0;
      let sumRight = 0;
      // The loudest sample any of the delay lines holds this frame. The tail lives
      // in the lines, not in the return: an allpass can cancel the return to
      // nothing while the lines are still full, so the level is measured on both.
      let linePeak = 0;
      for (let at = 0; at < state.combsLeft.length; at += 1) {
        const combLeft = state.combsLeft[at];
        const combRight = state.combsRight[at];
        sumLeft += combFrame(combLeft, wetInputLeft);
        sumRight += combFrame(combRight, wetInputRight);
        if (combLeft.level > linePeak) linePeak = combLeft.level;
        if (combRight.level > linePeak) linePeak = combRight.level;
      }
      let wetLeft = sumLeft / state.combsLeft.length;
      let wetRight = sumRight / state.combsRight.length;
      for (let at = 0; at < state.allpassesLeft.length; at += 1) {
        const allpassLeft = state.allpassesLeft[at];
        const allpassRight = state.allpassesRight[at];
        wetLeft = allpassFrame(allpassLeft, wetLeft);
        wetRight = allpassFrame(allpassRight, wetRight);
        if (allpassLeft.level > linePeak) linePeak = allpassLeft.level;
        if (allpassRight.level > linePeak) linePeak = allpassRight.level;
      }
      wetLeft *= REVERB_WET_GAIN;
      wetRight *= REVERB_WET_GAIN;
      if (!(wetLeft === 0)) wetLeft = flush(wetLeft);
      if (!(wetRight === 0)) wetRight = flush(wetRight);
      state.outLeft = wetLeft === 0 ? inLeft : inLeft + wetLeft;
      state.outRight = wetRight === 0 ? inRight : inRight + wetRight;

      // The tail's level is measured over 128-frame blocks, on the return AND on
      // the delay lines. Once the send has closed, a whole block is below
      // −120 dBFS, and the longest comb plus the longest allpass have had time to
      // empty since it closed, the reverb is dropped and the bus is bit-exact dry
      // from there on. The settle time is what keeps a short throw's tail: the
      // first quiet block of a line that is still full of a loud signal is not the
      // end of the tail.
      const peak = Math.max(Math.abs(wetLeft), Math.abs(wetRight), linePeak);
      if (peak > state.tailPeak) state.tailPeak = peak;
      state.tailFrames += 1;
      if (state.held) state.tailSince = 0;
      else state.tailSince += 1;
      if (state.tailFrames >= TAIL_BLOCK_FRAMES) {
        if (!state.held && state.tailSince >= state.settleFrames && state.tailPeak < TAIL_FLOOR) drop(state);
        state.tailPeak = 0;
        state.tailFrames = 0;
      }
    }

    // --- the looper --------------------------------------------------------

    /** @returns {void} forget the take and everything the looper was doing. */
    function clearTake() {
      pendingAction = null;
      position = 0;
      mode = "idle";
      recFrames = 0;
      takeBars = 0;
      takeFrames = 0;
    }

    /**
     * Adopt the main thread's buffers: the pair the looper records into and plays
     * out of. The page sends them (transferred) before the first record, again
     * when the song slows down enough that eight bars no longer fit, and back
     * again after a take; the audio thread never allocates one.
     *
     * A larger pair that arrives while the looper holds a take (or is part way
     * through a recording) keeps what it holds: the frames are copied over once,
     * here, on the message path. The pair that comes back from a take is the pair
     * that went out, so there is nothing to copy then.
     * @param {Float32Array} left
     * @param {Float32Array} right
     * @returns {void}
     */
    function setLooperBuffers(left, right) {
      if (!left || !right) return;
      if (typeof left.length !== "number" || typeof right.length !== "number") return;
      if (left.length !== right.length) return;
      const previous = buffers;
      buffers = { left: left, right: right };
      if (previous && previous.left !== left) {
        const keep = Math.max(takeFrames, mode === "recording" ? recFrames : 0);
        if (keep > 0) {
          const count = Math.min(keep, left.length, previous.left.length);
          for (let at = 0; at < count; at += 1) {
            left[at] = previous.left[at];
            right[at] = previous.right[at];
          }
        }
      }
      const barFrames = Math.max(1, recBarFrames);
      const fits = Math.floor(left.length / barFrames);
      if (takeFrames === 0) takeBars = 0;
      if (takeBars > fits) {
        takeBars = Math.max(0, fits);
        takeFrames = takeBars * barFrames;
      }
      if (recCapacity > left.length) recCapacity = Math.floor(left.length / barFrames) * barFrames;
    }

    /**
     * Hand the looper's buffers to the main thread: whole bars of the master as
     * `{left, right, frames, bars, rate}`, with the looper detached from them.
     * The page copies what it needs and hands the same pair straight back through
     * `setLooperBuffers`. While they are away the looper contributes silence (the
     * dry master still passes through) and keeps its position, so it carries on
     * from where it was when they come back. A looper that already handed them
     * out has nothing to give.
     * @returns {{left: Float32Array, right: Float32Array, frames: number,
     *            bars: number, rate: number}|null}
     */
    function takeLooperBuffers() {
      if (!buffers) return null;
      const barFrames = Math.max(1, recBarFrames);
      let bars = takeBars;
      let frames = takeFrames;
      if (mode === "recording") {
        // A recording answers the whole bars it has captured so far.
        bars = clamp(Math.floor(recFrames / barFrames), 0, MAX_LOOP_BARS);
        frames = bars * barFrames;
      }
      if (frames > buffers.left.length) {
        bars = 0;
        frames = 0;
      }
      const handed = { left: buffers.left, right: buffers.right, frames: frames, bars: bars, rate: sampleRate };
      buffers = null;
      return handed;
    }

    /**
     * Arm a recording starting here. The buffer is the main thread's: a recording
     * that would pass its end closes at the last whole bar that fits (and never
     * starts at all when not even one bar fits).
     * @param {number} barFrames how long one bar is at the tempo it starts on
     * @returns {void}
     */
    function startRecording(barFrames) {
      if (!buffers) return;
      const length = buffers.left.length;
      recBarFrames = Math.max(1, Math.round(barFrames));
      const fits = Math.floor(length / recBarFrames);
      if (fits < 1) return;
      recCapacity = Math.min(fits, MAX_LOOP_BARS) * recBarFrames;
      recFrames = 0;
      takeBars = 0;
      takeFrames = 0;
      position = 0;
      mode = "recording";
    }

    /**
     * Close the recording: whole bars, at least one and at most eight, then
     * either idle or playing/overdubbing from the top. Nothing is copied: the take
     * is a length over the buffers it was recorded into, and the frames past what
     * was recorded are silenced so a shorter take never plays an older one.
     * @param {string} nextMode `idle`, `playing` or `overdub`
     * @param {number} [wholeBars] the bars to keep (the last whole ones); the
     *   rounded count is used when the caller names none
     * @returns {void}
     */
    function finishRecording(nextMode, wholeBars) {
      const barFrames = Math.max(1, recBarFrames);
      const bars =
        wholeBars === undefined
          ? clamp(Math.round(recFrames / barFrames), 1, MAX_LOOP_BARS)
          : clamp(wholeBars, 1, MAX_LOOP_BARS);
      const frames = Math.min(bars * barFrames, buffers ? buffers.left.length : 0);
      if (frames > 0 && buffers) {
        const held = Math.min(frames, recFrames);
        for (let at = held; at < frames; at += 1) {
          buffers.left[at] = 0;
          buffers.right[at] = 0;
        }
      }
      takeBars = frames > 0 ? bars : 0;
      takeFrames = frames;
      recFrames = 0;
      position = 0;
      mode = frames > 0 ? nextMode : "idle";
    }

    /**
     * Stop during a recording: keep the whole bars it captured — at least one, so
     * the take is playable — or discard it when it never finished one.
     * @returns {void}
     */
    function stopRecording() {
      const barFrames = Math.max(1, recBarFrames);
      const bars = Math.floor(recFrames / barFrames);
      if (bars < 1) {
        takeBars = 0;
        takeFrames = 0;
        recFrames = 0;
        return;
      }
      finishRecording("idle", Math.min(bars, MAX_LOOP_BARS));
    }

    /**
     * Do what the pending action asked for, on a bar line.
     * @param {number} barFrames the length of one bar here
     * @returns {void}
     */
    function applyPendingAction(barFrames) {
      const action = pendingAction;
      if (action === null) return;
      pendingAction = null;
      if (action === "record") {
        startRecording(barFrames);
        return;
      }
      if (action === "finish" || action === "finishplay" || action === "finishoverdub") {
        finishRecording(action === "finish" ? "idle" : action === "finishplay" ? "playing" : "overdub");
        return;
      }
      if (action === "play") {
        position = 0;
        mode = takeFrames > 0 ? "playing" : "idle";
        return;
      }
      if (action === "overdub") {
        position = 0;
        mode = takeFrames > 0 ? "overdub" : "idle";
        return;
      }
      // "stop"
      if (mode === "recording") stopRecording();
      mode = "idle";
    }

    /**
     * One looper command, quantized to the bar. `record` starts on the next bar
     * line; the next `play`, `overdub` or `record` ends the take on the bar line
     * after it. `stop` during a recording keeps the whole bars it captured and
     * leaves them for a later `play`/`overdub`. `clear` empties the take at once,
     * because there is nothing to keep in time.
     * @param {string} action "record", "overdub", "play", "stop" or "clear"
     * @returns {void}
     */
    function looper(action) {
      const what = typeof action === "string" ? action : "";
      if (what === "clear") {
        clearTake();
        return;
      }
      if (what === "record") {
        // A second record ends the take the first one started.
        pendingAction = mode === "recording" ? "finish" : "record";
        return;
      }
      if (what === "play") {
        if (mode === "recording") pendingAction = "finishplay";
        else if (takeFrames > 0) pendingAction = "play";
        return;
      }
      if (what === "overdub") {
        if (mode === "recording") pendingAction = "finishoverdub";
        else pendingAction = takeFrames > 0 ? "overdub" : "record";
        return;
      }
      if (what === "stop") {
        pendingAction = "stop";
        return;
      }
      // Anything else is not a looper command: an unknown action changes nothing.
    }

    /**
     * One run of frames through the looper: the take plays into the master, and
     * a recording (or an overdub) takes the master as it was BEFORE the take was
     * mixed in — so a loop never records itself.
     *
     * A command is quantized to the sequencer's OWN next bar line, the one the
     * transport reports: never `barFrame + barFrames` at the current tempo, which
     * a tempo change (or a fractional bar) would put a frame or a whole bar away
     * from the grid the rest of the song plays on. With no bar line the transport
     * has no grid and the command takes effect at once, on this run's first frame.
     * @param {Float32Array} left
     * @param {Float32Array|null} right
     * @param {number} frames how many frames this run holds
     * @param {object} transport
     * @returns {void}
     */
    function loop(left, right, frames, transport) {
      const count = Math.trunc(Number(frames));
      if (!(count > 0) || !left) return;
      if (mode === "idle" && pendingAction === null) return;

      const t = transport && typeof transport === "object" ? transport : DEFAULT_TRANSPORT;
      const offset = Math.max(0, Math.trunc(finiteOr(t.offset, 0)));
      const base = Math.trunc(finiteOr(t.frame, 0));
      const barFrames = Math.max(1, Math.round(barFramesAt(t.bpm, sampleRate, t.beatsPerBar)));
      const barFrame = frameOrNull(t.barFrame);
      const nextBarLine = frameOrNull(t.nextBarFrame);

      // Where the next bar line is: the sequencer's own, when the transport names
      // one; otherwise the one bar after the line the playhead is inside. A
      // command that lands exactly on a line takes effect there; with no grid (the
      // transport is stopped) it takes effect at once, because there is no bar to
      // wait for.
      let nextLine = -1;
      if (pendingAction !== null) {
        if (barFrame === null) {
          applyPendingAction(barFrames);
        } else {
          let line = nextBarLine !== null && nextBarLine >= barFrame ? nextBarLine : barFrame + barFrames;
          // A run can start past the line the transport named (the block is
          // rendered in several runs): the command then waits for the next one,
          // it never takes effect in the past.
          while (line < base + offset) line += barFrames;
          if (line === base + offset) {
            applyPendingAction(barFrames);
            nextLine = line + barFrames;
          } else {
            nextLine = line;
          }
        }
      }

      const end = Math.min(left.length, offset + count);
      for (let index = offset; index < end; index += 1) {
        const frame = base + index;
        if (nextLine >= 0 && frame >= nextLine) {
          applyPendingAction(barFrames);
          nextLine += barFrames;
        }
        const dryLeft = left[index];
        const dryRight = right ? right[index] : dryLeft;

        if (mode === "playing" || mode === "overdub") {
          if (buffers && takeFrames > 0) {
            const at = position < takeFrames ? position : 0;
            left[index] = dryLeft + buffers.left[at];
            if (right) right[index] = dryRight + buffers.right[at];
            position = at + 1 >= takeFrames ? 0 : at + 1;
            if (mode === "overdub") {
              buffers.left[at] += dryLeft;
              buffers.right[at] += dryRight;
            }
            continue;
          }
        }

        if (mode === "recording" && buffers) {
          buffers.left[recFrames] = dryLeft;
          buffers.right[recFrames] = dryRight;
          recFrames += 1;
          // The buffers are the whole take: it closes itself at their last whole bar.
          if (recFrames >= recCapacity) finishRecording("idle");
        }
      }
    }

    /**
     * One frame of the master into the stutter's trailing ring.
     * @param {number} left
     * @param {number} right
     * @returns {void}
     */
    function writeRing(left, right) {
      ringLeft[ringIndex] = left;
      ringRight[ringIndex] = right;
      ringIndex = ringIndex + 1 >= ringFrames ? 0 : ringIndex + 1;
      if (ringFilled < ringFrames) ringFilled += 1;
    }

    /**
     * One run of frames through the performance-effects chain, in place.
     *
     * The stutter's trailing ring is written on every frame the playhead runs —
     * the only work an idle bus does, so a hold part way through a division can
     * repeat the part that has already played. The effects themselves, the
     * pending holds and releases, cost nothing while nothing is held.
     * @param {Float32Array} left
     * @param {Float32Array|null} right
     * @param {number} frames how many frames this run holds
     * @param {object} transport
     * @returns {void}
     */
    function process(left, right, frames, transport) {
      const count = Math.trunc(Number(frames));
      if (!(count > 0) || !left) return;

      const t = transport && typeof transport === "object" ? transport : DEFAULT_TRANSPORT;
      const offset = Math.max(0, Math.trunc(finiteOr(t.offset, 0)));
      const base = Math.trunc(finiteOr(t.frame, 0));

      applyPending(base + offset, t);
      const end = Math.min(left.length, offset + count);
      // A stopped transport has no grid to repeat on, so nothing needs the ring;
      // dropping what it holds keeps a later slice from starting on stale audio.
      const ringRuns = t.playing === true;
      if (!ringRuns) ringFilled = 0;

      if (activeCount === 0) {
        if (!ringRuns) return;
        for (let index = offset; index < end; index += 1) {
          const inLeft = left[index];
          writeRing(inLeft, right ? right[index] : inLeft);
        }
        return;
      }

      for (let index = offset; index < end; index += 1) {
        const frame = base + index;
        let outLeft = left[index];
        let outRight = right ? right[index] : outLeft;
        if (ringRuns) writeRing(outLeft, outRight);
        if (activeCount === 0) continue;

        for (let at = 0; at < states.length; at += 1) {
          const state = states[at];
          if (!state.active) continue;
          const inLeft = outLeft;
          const inRight = outRight;
          stepEffect(state, inLeft, inRight, frame);
          let wetLeft = state.outLeft;
          let wetRight = state.outRight;
          if (state.releasing >= 0) {
            // The crossfade: full wet on the release frame, and dry again by
            // the 64th — where the effect is dropped and the frame is untouched.
            // A re-hold reverses it at the very same rate, so picking an effect
            // back up mid-fade never jumps.
            const mix = (RELEASE_FRAMES - state.releasing) / RELEASE_FRAMES;
            wetLeft = inLeft + (wetLeft - inLeft) * mix;
            wetRight = inRight + (wetRight - inRight) * mix;
            if (state.held) {
              state.releasing = state.releasing > 0 ? state.releasing - 1 : -1;
            } else {
              state.releasing += 1;
              if (state.releasing >= RELEASE_FRAMES) drop(state);
            }
          }
          outLeft = wetLeft;
          outRight = wetRight;
        }

        left[index] = outLeft;
        if (right) right[index] = outRight;
      }
    }

    /**
     * How many effects are live right now. Zero means `process()` has nothing to
     * do but the stutter's trailing ring.
     * @returns {number}
     */
    function liveCount() {
      return activeCount;
    }

    /** @returns {string[]} the effects that are currently applied, in chain order. */
    function heldNames() {
      const names = [];
      for (let at = 0; at < states.length; at += 1) {
        const state = states[at];
        if (!state.active) continue;
        names.push(state.name + (state.held ? "" : ":release"));
      }
      return names;
    }

    return {
      hold: hold,
      release: release,
      process: process,
      loop: loop,
      looper: looper,
      setLooperBuffers: setLooperBuffers,
      takeLooperBuffers: takeLooperBuffers,
      activeCount: liveCount,
      heldNames: heldNames,
    };
  }

  const api = {
    create: create,
    CHAIN: CHAIN,
    RELEASE_FRAMES: RELEASE_FRAMES,
    MAX_LOOP_BARS: MAX_LOOP_BARS,
    SLOWEST_BPM: SLOWEST_BPM,
    TAIL_FLOOR: TAIL_FLOOR,
    TAIL_BLOCK_FRAMES: TAIL_BLOCK_FRAMES,
    DENORMAL_FLOOR: DENORMAL_FLOOR,
    LOFI_SEED: LOFI_SEED,
  };

  if (typeof globalThis !== "undefined") globalThis.StudioPerfFx = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();