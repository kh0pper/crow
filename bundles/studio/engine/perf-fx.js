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
 * - **stutter** — captures one division of a beat (1/4, 1/8 or 1/16 by the
 *   amount) and loops it. The slice it repeats begins at the hold frame: the
 *   bus has not been buffering audio while nothing was held (that is what makes
 *   an idle bus free), so the slice is captured as it plays and loops from the
 *   frame after it. The division is the effect's period, so the repetition is
 *   in time however late in the slice the button went down.
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
 * release and its tail rings out; once the return's peak over a 128-frame block
 * falls below −120 dBFS the state is cleared and the bus is bit-exact dry
 * again. Nothing is ever summed into the signal as `x + 0`, so a −0 sample
 * stays a −0 sample.
 *
 * The whole bus is one `if` when nothing is held and the looper is empty: no
 * state, no buffer and no arithmetic.
 *
 * ## The looper
 *
 * `looper(action)` takes `record`, `overdub`, `play`, `stop` or `clear`, all
 * quantized to the bar. `record` starts on the next bar line and ends on the
 * bar line AFTER the next `play`/`overdub`/`record` (whole bars, at most 8);
 * `play` loops the take mixed into the master; `overdub` adds the live master
 * into the take while it plays; `clear` empties it at once. The take taps the
 * master BEFORE the effects, so a held stutter or reverb is not baked into the
 * loop.
 *
 * The buffer is readable: `take()` answers `{channels, rate, bars}` — whole bars
 * of what has been recorded, which the processor hands to the page through its
 * `looper_take` message.
 *
 * ## Transport
 *
 * `process(left, right, frames, transport)` and `loop(...)` take
 *
 *     transport = {frame, playing, bpm, beatsPerBar, barFrame, offset?}
 *
 * where `frame` is the absolute frame of `left[0]`, `barFrame` is the frame of
 * the bar line the playhead is inside (or `null` when there is no grid: the
 * transport is stopped), and the optional `offset` is the index in `left` this
 * run starts at (the processor renders one block in several runs, one per
 * sequencer event). Everything is worked out from `frame`, so a run split any
 * way at all produces the same frames.
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

  /** A transport a caller that passes none is read as: stopped, at 120 bpm. */
  const DEFAULT_TRANSPORT = Object.freeze({
    frame: 0,
    offset: 0,
    playing: false,
    bpm: DEFAULT_BPM,
    beatsPerBar: BEATS_PER_BAR,
    barFrame: null,
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
    buffer[comb.index] = flush(input + comb.damp * REVERB_FEEDBACK);
    comb.index = comb.index + 1 >= buffer.length ? 0 : comb.index + 1;
    return out;
  }

  /** One frame of a reverb allpass. */
  function allpassFrame(allpass, input) {
    const buffer = allpass.buffer;
    const out = buffer[allpass.index];
    buffer[allpass.index] = flush(input + out * REVERB_ALLPASS_GAIN);
    allpass.index = allpass.index + 1 >= buffer.length ? 0 : allpass.index + 1;
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

    // --- the looper's state ------------------------------------------------

    /** The finished take: `{left, right, frames, bars}` or null. */
    let take = null;

    /** `idle`, `recording`, `playing` or `overdub`. */
    let mode = "idle";

    /** The action waiting for a bar line (`record`, `finish`, `play`, ...). */
    let pendingAction = null;

    /** The recording in progress: its buffer, how much of it is written, its bar. */
    let recLeft = null;
    let recRight = null;
    let recFrames = 0;
    let recBarFrames = 1;
    let recCapacity = 0;

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
        state.sliceLeft = new Float32Array(0);
        state.sliceRight = new Float32Array(0);
        state.sliceFrames = 0;
        state.captured = 0;
        state.capturing = false;
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
        state.tailPeak = 0;
        state.tailFrames = 0;
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
        const frames = Math.max(1, Math.round(beatFrames * division));
        if (state.sliceLeft.length < frames) {
          state.sliceLeft = new Float32Array(frames);
          state.sliceRight = new Float32Array(frames);
        } else {
          state.sliceLeft.fill(0, 0, frames);
          state.sliceRight.fill(0, 0, frames);
        }
        state.division = division;
        state.sliceFrames = frames;
        state.captured = 0;
        state.capturing = true;
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
          // A hold on an effect that is already applied follows the amount (a
          // knob sweep); anything else starts it here, state and all.
          if (state.active && state.held) setAmount(state, item.amount);
          else activate(state, frame, item.amount, transport);
          continue;
        }
        if (!state.active) continue;
        // A second release of an effect that is already on its way out changes
        // nothing, so it cannot restart a crossfade at full wet.
        if (!state.held) continue;
        state.held = false;
        // The reverb throw is a send: closing it leaves the tail to ring. Every
        // other effect hands the dry signal back over the crossfade instead.
        if (state.name !== "reverb_throw") state.releasing = 0;
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
        if (state.capturing) {
          state.sliceLeft[state.captured] = inLeft;
          state.sliceRight[state.captured] = inRight;
          state.captured += 1;
          if (state.captured >= state.sliceFrames) {
            state.capturing = false;
            state.position = 0;
          }
          state.outLeft = inLeft;
          state.outRight = inRight;
          return;
        }
        const at = state.position;
        state.outLeft = state.sliceLeft[at];
        state.outRight = state.sliceRight[at];
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
      for (let at = 0; at < state.combsLeft.length; at += 1) {
        sumLeft += combFrame(state.combsLeft[at], wetInputLeft);
        sumRight += combFrame(state.combsRight[at], wetInputRight);
      }
      let wetLeft = sumLeft / state.combsLeft.length;
      let wetRight = sumRight / state.combsRight.length;
      for (let at = 0; at < state.allpassesLeft.length; at += 1) {
        wetLeft = allpassFrame(state.allpassesLeft[at], wetLeft);
        wetRight = allpassFrame(state.allpassesRight[at], wetRight);
      }
      wetLeft *= REVERB_WET_GAIN;
      wetRight *= REVERB_WET_GAIN;
      if (!(wetLeft === 0)) wetLeft = flush(wetLeft);
      if (!(wetRight === 0)) wetRight = flush(wetRight);
      state.outLeft = wetLeft === 0 ? inLeft : inLeft + wetLeft;
      state.outRight = wetRight === 0 ? inRight : inRight + wetRight;

      // The tail's level is measured over 128-frame blocks: once the send has
      // closed and a whole block is below −120 dBFS, the reverb is dropped and
      // the bus is bit-exact dry from there on.
      const peak = Math.max(Math.abs(wetLeft), Math.abs(wetRight));
      if (peak > state.tailPeak) state.tailPeak = peak;
      state.tailFrames += 1;
      if (state.tailFrames >= TAIL_BLOCK_FRAMES) {
        if (!state.held && state.tailPeak < TAIL_FLOOR) drop(state);
        state.tailPeak = 0;
        state.tailFrames = 0;
      }
    }

    // --- the looper --------------------------------------------------------

    /** @returns {void} forget the take and everything the looper was doing. */
    function clearTake() {
      take = null;
      pendingAction = null;
      position = 0;
      mode = "idle";
      recFrames = 0;
    }

    /**
     * Arm a recording starting here.
     * @param {number} barFrames how long one bar is at the tempo it starts on
     * @returns {void}
     */
    function startRecording(barFrames) {
      recBarFrames = Math.max(1, Math.round(barFrames));
      recCapacity = MAX_LOOP_BARS * recBarFrames;
      if (!recLeft || recLeft.length < recCapacity) {
        recLeft = new Float32Array(recCapacity);
        recRight = new Float32Array(recCapacity);
      }
      recFrames = 0;
      position = 0;
      mode = "recording";
    }

    /**
     * Close the recording: whole bars, at least one and at most eight, then
     * either idle or playing/overdubbing from the top.
     * @param {string} nextMode `idle`, `playing` or `overdub`
     * @returns {void}
     */
    function finishRecording(nextMode) {
      const barFrames = Math.max(1, recBarFrames);
      const bars = clamp(Math.round(recFrames / barFrames), 1, MAX_LOOP_BARS);
      const frames = bars * barFrames;
      const left = new Float32Array(frames);
      const right = new Float32Array(frames);
      const held = Math.min(frames, recFrames);
      if (held > 0 && recLeft && recRight) {
        left.set(recLeft.subarray(0, held));
        right.set(recRight.subarray(0, held));
      }
      take = { left: left, right: right, frames: frames, bars: bars };
      position = 0;
      mode = nextMode;
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
        mode = take ? "playing" : "idle";
        return;
      }
      if (action === "overdub") {
        position = 0;
        mode = take ? "overdub" : "idle";
        return;
      }
      // "stop"
      mode = "idle";
    }

    /**
     * One looper command, quantized to the bar. `record` starts on the next bar
     * line; the next `play`, `overdub` or `record` ends the take on the bar line
     * after it. `clear` empties the take at once, because there is nothing to
     * keep in time.
     * @param {string} action "record", "overdub", "play", "stop" or "clear"
     * @returns {void}
     */
    function looper(action) {
      const what = typeof action === "string" ? action : "";
      if (what === "clear") {
        if (recLeft) {
          recLeft.fill(0);
          recRight.fill(0);
        }
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
        else if (take) pendingAction = "play";
        return;
      }
      if (what === "overdub") {
        if (mode === "recording") pendingAction = "finishoverdub";
        else pendingAction = take ? "overdub" : "record";
        return;
      }
      if (what === "stop") {
        pendingAction = "stop";
        return;
      }
      // Anything else is not a looper command: an unknown action changes nothing.
    }

    /**
     * The take as the page reads it: whole bars of the master, in two channels
     * at this bus's rate. A take that is still recording answers what it has
     * captured so far; a looper that has recorded nothing answers no bars.
     * @returns {{channels: Float32Array[], rate: number, bars: number}}
     */
    function takeSnapshot() {
      if (take) {
        return {
          channels: [Float32Array.from(take.left), Float32Array.from(take.right)],
          rate: sampleRate,
          bars: take.bars,
        };
      }
      const barFrames = recBarFrames;
      const bars =
        mode === "recording" && recFrames > 0 ? clamp(Math.floor(recFrames / barFrames), 0, MAX_LOOP_BARS) : 0;
      const frames = bars * barFrames;
      const left = new Float32Array(frames);
      const right = new Float32Array(frames);
      if (frames > 0 && recLeft && recRight) {
        left.set(recLeft.subarray(0, frames));
        right.set(recRight.subarray(0, frames));
      }
      return { channels: [left, right], rate: sampleRate, bars: bars };
    }

    /**
     * One run of frames through the looper: the take plays into the master, and
     * a recording (or an overdub) takes the master as it was BEFORE the take was
     * mixed in — so a loop never records itself.
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
      const barFrame = Number.isFinite(Number(t.barFrame)) ? Math.trunc(Number(t.barFrame)) : null;

      // Where the next bar line is. A command that lands exactly on one takes
      // effect there; with no grid (the transport is stopped) it takes effect at
      // once, because there is no bar to wait for.
      let nextLine = null;
      if (pendingAction !== null) {
        if (barFrame === null) {
          applyPendingAction(barFrames);
        } else {
          nextLine = barFrame + barFrames;
          if (base + offset === barFrame) applyPendingAction(barFrames);
        }
      }

      const end = Math.min(left.length, offset + count);
      for (let index = offset; index < end; index += 1) {
        const frame = base + index;
        if (nextLine !== null && frame >= nextLine) {
          applyPendingAction(barFrames);
          nextLine += barFrames;
        }
        const dryLeft = left[index];
        const dryRight = right ? right[index] : dryLeft;

        if (mode === "playing" || mode === "overdub") {
          if (take) {
            const at = position < take.frames ? position : 0;
            left[index] = dryLeft + take.left[at];
            if (right) right[index] = dryRight + take.right[at];
            position = at + 1 >= take.frames ? 0 : at + 1;
            if (mode === "overdub") {
              take.left[at] += dryLeft;
              take.right[at] += dryRight;
            }
            continue;
          }
        }

        if (mode === "recording" && recLeft && recRight) {
          recLeft[recFrames] = dryLeft;
          recRight[recFrames] = dryRight;
          recFrames += 1;
          // Eight bars is the whole take: it closes itself there.
          if (recFrames >= recCapacity) finishRecording("idle");
        }
      }
    }

    /**
     * One run of frames through the performance-effects chain, in place.
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
      if (activeCount === 0) return;

      const end = Math.min(left.length, offset + count);
      for (let index = offset; index < end; index += 1) {
        if (activeCount === 0) return;
        const frame = base + index;
        let outLeft = left[index];
        let outRight = right ? right[index] : outLeft;

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
            const mix = (RELEASE_FRAMES - state.releasing) / RELEASE_FRAMES;
            wetLeft = inLeft + (wetLeft - inLeft) * mix;
            wetRight = inRight + (wetRight - inRight) * mix;
            state.releasing += 1;
            if (state.releasing >= RELEASE_FRAMES) drop(state);
          }
          outLeft = wetLeft;
          outRight = wetRight;
        }

        left[index] = outLeft;
        if (right) right[index] = outRight;
      }
    }

    /**
     * How many effects are live right now. Zero means `process()` returns
     * without touching a single frame.
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
      take: takeSnapshot,
      activeCount: liveCount,
      heldNames: heldNames,
    };
  }

  const api = {
    create: create,
    CHAIN: CHAIN,
    RELEASE_FRAMES: RELEASE_FRAMES,
    MAX_LOOP_BARS: MAX_LOOP_BARS,
    TAIL_FLOOR: TAIL_FLOOR,
    TAIL_BLOCK_FRAMES: TAIL_BLOCK_FRAMES,
    DENORMAL_FLOOR: DENORMAL_FLOOR,
    LOFI_SEED: LOFI_SEED,
  };

  if (typeof globalThis !== "undefined") globalThis.StudioPerfFx = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();