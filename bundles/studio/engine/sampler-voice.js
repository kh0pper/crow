/**
 * Studio sampler voice — one played pad, in plain JavaScript.
 *
 * A sampler track's slot owns a pool of these (16 voices, see
 * `studio-processor.js`): a step's pad trigger, or a live pad press, starts one,
 * and the voice plays a slice of a sample (or the whole of it) through its
 * envelope and its filter, then hands the processor a stereo pair to mix like
 * any other track's output.
 *
 * It is a classic script (no `import`/`export`): it assigns
 * `globalThis.StudioSamplerVoice` for the worklet scope and `module.exports`
 * when a CommonJS `module` exists. `engine/package.json` marks that directory
 * `"commonjs"`, so a Node `require()` of this file works inside the bundle's
 * ESM tree; `engine-client.js` also concatenates it into the worklet module
 * (a worklet cannot import), which is why it must not depend on anything.
 *
 * ## Signal path
 *
 *     sample (linear interpolation at 2^(pitch/12))
 *       → ADSR (linear segments, milliseconds → frames)
 *       → one biquad (RBJ cookbook coefficients, pages 5–6)
 *       → gain (dB) × (v/127)²
 *       → constant-power pan (unity at centre: the track's pan positions it)
 *
 * The step is the per-frame distance through the sample, so the read is a plain
 * double position with linear interpolation: at a step of 1 the voice is
 * sample-exact, at 2 every other sample is read (an octave up, half the length),
 * and a fractional step blends the two neighbours. Reversed playback runs the
 * same position backwards from the end of the range. The blended neighbour is
 * held inside the range (end − 1 forwards, start backwards), so a voice never
 * reads into the slice next door.
 *
 * The step is three things kept apart and multiplied in one place
 * (`refreshStep`): `dir` (the initial reverse sign, +1 or −1), `speed` (a
 * multiplier, for varispeed and tempo sync) and `pitch_semis`. A pitch sweep only
 * has to move `pitch_semis` and ask for the product again, and a ping-pong that
 * turns around only flips `dir`.
 *
 * A `loop` voice wraps at its range end: forwards, past the last frame to the
 * first; backwards, past the first frame to the last. A `pingpong` voice mirrors
 * the step that would have left the range and turns around, so it reads the same
 * range out and back. Both keep `looping` set until the voice is released (or
 * faded), which is what makes a released voice end in the ordinary way.
 *
 * A voice ends in exactly three ways: its envelope reaches DONE (a release
 * finished, or a decay bottomed out at sustain 0), its read range runs out, or —
 * in a loop — its envelope runs out (a looping voice is never left alive and
 * silent at level 0). A start therefore sounds from its own first frame, even
 * while an attack is still climbing from 0.
 *
 * ## The hold stage
 *
 * A pad with a `hold_ms` asks its voice to sit at level 1 for that long between
 * the attack and the decay (the SP-404's HOLD-style sustain). It is a stage of
 * its own, `STAGE_HOLD`, numbered AFTER the four the voice already had so the
 * numbers a processor reads (its own attack/decay/sustain) never move: a voice
 * in a hold is in none of the stages motion applies an envelope time to. A
 * countdown that ends during the hold (a gate's) releases the voice from where
 * it stands, exactly as it would in any other stage. A hold of 0 frames is no
 * stage at all, and such a voice renders exactly as it did before the stage
 * existed.
 *
 * ## The HOLD latch
 *
 * `held` is the operator's HOLD on a voice: a Gate pad's press latched so it
 * keeps sounding after the finger is gone. `hold()` raises it, and a held voice
 * ignores both a release and its own gate countdown, so nothing but a deliberate
 * ending takes it away: `releaseHeld()` clears the flag and runs the ordinary
 * release, a fade (`beginFadeOut`) drops it on its way out, and a start clears
 * it, so a reused slot never comes back held.
 *
 * ## Pause-all
 *
 * The operator's Pause-all (`pause()`) ducks a voice to silence over
 * `FADE_FRAMES` while the voice still advances, and then freezes it: the read
 * position, the envelope and the gate countdown all stand still, and nothing is
 * written at all. `resume()` ramps the level back up over the same 64 frames
 * from the very frame it stopped on, so nothing jumps and no voice is cut at
 * full level. `pauseLevel` is the ducking multiplier the render loop applies;
 * `pauseFrames` and `pauseStep` are the ramp in progress.
 *
 * A voice that is already on its way out (its range ran out, or it is fading)
 * is not paused: a fade is short, and a pause would keep a dead voice alive. For
 * the same reason a stolen voice's tail never carries `paused`.
 *
 * A voice STARTED under Pause-all (M22) is created paused: silent and frozen
 * from its own first frame, with no ramp to run, and heard when it is resumed.
 * Its hit and its light still fire, because the voice really did start.
 *
 * ## A live reverse flip
 *
 * `flipReverse` turns a sounding voice round where it stands: it negates `dir`
 * and works the step out again, and it does not touch the read position, so the
 * voice carries on from the frame it was about to read (there is no jump). A
 * voice that is not looping then runs to the end it now heads for and ends
 * there; a looping voice turns at that end as it always does.
 *
 * ## Why it is bit-identical in Chromium and Node
 *
 * Only IEEE double `+ - * /`, `Math.pow`, `Math.cos`, `Math.sin`, `Math.floor`
 * and `Math.round`, in a fixed order, with `Float32Array` samples in and out.
 * No `Math.random`, no table built from a host-specific value, no
 * `Math.fround` shortcut: both hosts run the same V8 and produce the same bits.
 *
 * ## No denormals
 *
 * A decaying filter's state goes subnormal and costs a CPU spike on some
 * machines, so every value a recursive filter holds (its two input and two
 * output states, and its result) is flushed to exactly 0 below 1e-30.
 */
(function () {
  "use strict";

  /** Below this, a recursive filter's state is flushed to exactly 0. */
  const DENORMAL_FLOOR = 1e-30;

  /** How long a choke (and a range that runs out at level) fades for, in frames. */
  const FADE_FRAMES = 64;

  /**
   * The shortest range a loop can turn around in, in frames. A range of one frame
   * has no second frame to come back to, so a voice in one runs out instead of
   * spinning in place.
   */
  const SHORTEST_LOOP_FRAMES = 2;

  /**
   * How many times one frame may wrap or reflect before the voice gives up and
   * runs out. A step this side of sane turns once or twice; the cap is here so a
   * pathological speed leaves the voice rather than spinning the audio thread.
   */
  const MOST_LOOP_TURNS = 1024;

  /**
   * How much of one frame's decay step the level may still sit above its target
   * and count as arrived, as a fraction of that step. A decay subtracts a
   * rounded increment frame after frame, so the last subtraction can leave a few
   * ulps above the target; taken as sound they would be a voice that is meant to
   * be at level 0 rendering a silent-but-nonzero frame (M23).
   */
  const LEVEL_ARRIVED = 1e-6;

  /** The speed multiplier is held inside these bounds (0 and below have no meaning). */
  const LOWEST_SPEED = 0.01;
  const HIGHEST_SPEED = 16;

  /** The envelope's stages, in the order a voice moves through them. */
  const STAGE_ATTACK = 0;
  const STAGE_DECAY = 1;
  const STAGE_SUSTAIN = 2;
  const STAGE_RELEASE = 3;
  const STAGE_DONE = 4;
  /**
   * The hold stage: level 1, held for the pad's `hold_ms`, between the attack
   * and the decay. A NEW number, after the four above, so the numbers a caller
   * already reads stay where they are: a voice in a hold is in none of them.
   */
  const STAGE_HOLD = 5;

  /** The pad filter kinds, as `doc.js` spells them; "off" filters nothing. */
  const FILTER_OFF = 0;
  const FILTER_LP = 1;
  const FILTER_HP = 2;
  const FILTER_BP = 3;

  /** The lowest and highest cutoff the coefficients are worked out for, in Hz. */
  const LOWEST_CUTOFF_HZ = 20;

  /** The filter's Q at resonance 0, and how much a resonance of 1 adds. */
  const LOWEST_Q = 0.5;
  const Q_RANGE = 9.5;

  /** @returns {number} the value when it is a finite number, else the fallback. */
  function finiteOr(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  /** @returns {number} the value held between two bounds. */
  function clamp(value, low, high) {
    if (!Number.isFinite(value)) return low;
    if (value < low) return low;
    if (value > high) return high;
    return value;
  }

  /**
   * A gain in dB as a linear factor (the document's own dB, not a controller
   * value: −60 dB really is −60 dB).
   * @param {number} db
   * @returns {number}
   */
  function dbToLinear(db) {
    return Math.pow(10, clamp(finiteOr(db, 0), -120, 24) / 20);
  }

  /**
   * Milliseconds as whole frames, at least 0.
   * @param {number} ms
   * @param {number} sampleRate
   * @returns {number}
   */
  function msToFrames(ms, sampleRate) {
    const frames = Math.round((clamp(finiteOr(ms, 0), 0, 60000) / 1000) * sampleRate);
    return frames > 0 ? frames : 0;
  }

  /**
   * The constant-power pan pair for a pan position, normalised so that centre
   * passes at unity.
   *
   * A plain `cos/sin` pair would lose 3 dB against a hard-panned pad when the
   * track's own pan multiplies it again (the mix owns that pan), so the pair is
   * scaled by √2: both sides get 1 at centre, one side gets √2 at hard pan, and
   * the squares still add up to a constant 2.
   * @param {number} pan -1 (left) .. 1 (right)
   * @returns {{left: number, right: number}}
   */
  function panCoefficients(pan) {
    const theta = ((clamp(finiteOr(pan, 0), -1, 1) + 1) * Math.PI) / 4;
    return { left: Math.SQRT2 * Math.cos(theta), right: Math.SQRT2 * Math.sin(theta) };
  }

  /**
   * One filter kind as the number the render loop switches on.
   * @param {string} type "off", "lp", "hp" or "bp"
   * @returns {number}
   */
  function filterNumber(type) {
    if (type === "lp") return FILTER_LP;
    if (type === "hp") return FILTER_HP;
    if (type === "bp") return FILTER_BP;
    return FILTER_OFF;
  }

  /**
   * An idle voice. `createVoice()` is called once per slot and the record is
   * reused for every trigger, so a steady pattern allocates nothing.
   * @returns {object}
   */
  function createVoice() {
    return {
      /** Whether this voice currently sounds (the processor's pool reads it). */
      sounding: false,
      /** Trigger order, for the oldest-voice rule (the processor sets it). */
      serial: 0,
      /** The sample's PCM at the context's rate, one Float32Array per channel. */
      channels: null,
      /** Frames in that PCM (a shorter second channel simply reads as silence). */
      frames: 0,
      /** The playback range in sample frames: `start` inclusive, `end` exclusive. */
      start: 0,
      end: 0,
      reverse: false,
      /** The read position, in sample frames, in doubles. */
      position: 0,
      /** The step per frame, as `refreshStep` works it out: dir × speed × 2^(pitch/12). */
      step: 1,
      /** The direction the position moves in: −1 when the voice started reversed. */
      dir: 1,
      /** The speed multiplier (varispeed and tempo sync), 1 for an untouched pad. */
      speed: 1,
      /** The pitch, in semitones, kept apart from the speed that also moves it. */
      pitch_semis: 0,
      /** "off", "loop" or "pingpong", as the pad's Loop setting spells it. */
      loop: "off",
      /** Whether the voice is turning at its range ends (cleared by a release or a fade). */
      looping: false,
      /**
       * The operator's live state on this voice: `held` (a HOLD latch, raised by
       * `hold()` and let go by `releaseHeld()`) and `paused` (Pause-all). The
       * processor raises them; a voice that is on its way out (a fade, a steal,
       * a reused slot) drops them here, so a dead voice never keeps a pad held or
       * paused.
       */
      held: false,
      paused: false,
      /**
       * Pause-all's ramp: `pauseLevel` is the ducking multiplier the render loop
       * applies (1 audible, 0 silent), `pauseFrames` the frames left of the
       * 64-frame ramp in progress and `pauseStep` its per-frame increment. A
       * voice that is `paused` with no ramp left and no level stands frozen:
       * silent, with its position, its envelope and its gate countdown held
       * exactly where they were.
       */
      pauseLevel: 1,
      pauseFrames: 0,
      pauseStep: 0,
      /** dB gain × (velocity/127)², and the constant-power pan pair. */
      gain: 0,
      panLeft: 1,
      panRight: 1,
      /** The envelope's segments, in frames, and where it is in them. */
      attackFrames: 0,
      decayFrames: 0,
      releaseFrames: 0,
      sustain: 1,
      stage: STAGE_DONE,
      level: 0,
      increment: 0,
      /** The biquad: its kind and its normalised coefficients. */
      filterType: FILTER_OFF,
      b0: 0,
      b1: 0,
      b2: 0,
      a1: 0,
      a2: 0,
      /** One pair of input and output states per channel (two channels). */
      x1a: 0,
      x2a: 0,
      y1a: 0,
      y2a: 0,
      x1b: 0,
      x2b: 0,
      y1b: 0,
      y2b: 0,
      /** Frames left before a gate-mode voice releases; -1 means "no gate". */
      gateRemaining: -1,
      /** Frames of the hold stage still to run; 0 when the voice has no hold. */
      holdFrames: 0,
      /** "oneshot" plays to its range end; "gate" releases on a live release. */
      mode: "oneshot",
      /** Frames left in a choke (or end-of-range) fade; 0 means "not fading". */
      fadeRemaining: 0,
      /** Whether the read position has left the range (the fade then holds). */
      ending: false,
      /** The last post-filter sample, held through that fade. */
      heldLeft: 0,
      heldRight: 0,
      /** The pad whose sample this voice plays, so a live release can find it. */
      trackId: "",
      bankId: "",
      index: 0,
      /**
       * The pad that was actually PRESSED, and so the one the page lights and a
       * lifted finger releases. It equals `index` for an ordinary press; a
       * chromatic or 16-velocity press sounds the selected pad's sample from
       * every pad of the grid, so one sample pad can carry several presses at
       * once and each keeps its own source pad.
       */
      source_index: 0,
      /**
       * The sound this voice started with: the sample's id and, when its pad
       * named one, the slice's. The processor sets them at the start (they are
       * references to ids already in hand, so a start allocates nothing) and
       * compares them with the pad's own on every song, so a cleared or
       * repointed pad ends the voice instead of leaving it playing a sound the
       * song no longer has.
       */
      sample_id: "",
      slice_id: "",
      /** Its choke group (0 = none), so a new voice can cut it. */
      choke: 0,
    };
  }

  /**
   * Work out the biquad's coefficients (RBJ cookbook) and reset its state.
   *
   * One filter, three kinds: a low pass, a high pass or a constant-peak-gain
   * band pass. Resonance 0..1 maps onto Q = 0.5 + resonance × 9.5.
   * @param {object} voice
   * @param {string} type "off", "lp", "hp" or "bp"
   * @param {number} cutoffHz
   * @param {number} resonance 0..1
   * @param {number} sampleRate
   * @returns {void}
   */
  function setFilter(voice, type, cutoffHz, resonance, sampleRate) {
    voice.filterType = filterNumber(type);
    voice.x1a = 0;
    voice.x2a = 0;
    voice.y1a = 0;
    voice.y2a = 0;
    voice.x1b = 0;
    voice.x2b = 0;
    voice.y1b = 0;
    voice.y2b = 0;
    if (voice.filterType === FILTER_OFF) return;

    const rate = finiteOr(sampleRate, 48000);
    // Below the lowest cutoff and above just under Nyquist the coefficients
    // stop meaning anything, so the cutoff is held inside both.
    const highest = rate * 0.45;
    const cutoff = clamp(finiteOr(cutoffHz, highest), LOWEST_CUTOFF_HZ, Math.max(LOWEST_CUTOFF_HZ, highest));
    const q = LOWEST_Q + clamp(finiteOr(resonance, 0), 0, 1) * Q_RANGE;

    const w0 = (2 * Math.PI * cutoff) / rate;
    const cosw0 = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * q);
    const a0 = 1 + alpha;
    const a1 = -2 * cosw0;
    const a2 = 1 - alpha;

    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    if (voice.filterType === FILTER_LP) {
      b0 = (1 - cosw0) / 2;
      b1 = 1 - cosw0;
      b2 = b0;
    } else if (voice.filterType === FILTER_HP) {
      b0 = (1 + cosw0) / 2;
      b1 = -(1 + cosw0);
      b2 = b0;
    } else {
      // Constant 0 dB peak gain: b0 = alpha, b2 = -alpha, b1 = 0.
      b0 = alpha;
      b1 = 0;
      b2 = -alpha;
    }

    voice.b0 = b0 / a0;
    voice.b1 = b1 / a0;
    voice.b2 = b2 / a0;
    voice.a1 = a1 / a0;
    voice.a2 = a2 / a0;
  }

  /** @returns {number} the value flushed to 0 when it is below the floor. */
  function flush(value) {
    return value > -DENORMAL_FLOOR && value < DENORMAL_FLOOR ? 0 : value;
  }

  /**
   * Take the envelope to its sustain stage, or end the voice when the sustain
   * level is 0: a decay all the way down leaves nothing to hear, so the voice
   * is DONE and its slot is free again.
   * @param {object} voice
   * @returns {void}
   */
  function settleAtSustain(voice) {
    if (voice.sustain > 0) {
      voice.stage = STAGE_SUSTAIN;
      voice.level = voice.sustain;
      return;
    }
    voice.level = 0;
    voice.stage = STAGE_DONE;
    voice.sounding = false;
    voice.looping = false;
  }

  /**
   * Work the voice's step out from the three things it is made of. This is the
   * only place that product exists: a start sets the three, a pitch sweep moves
   * `pitch_semis`, and a ping-pong that turns around flips `dir`.
   * @param {object} voice
   * @returns {void}
   */
  function refreshStep(voice) {
    voice.step = voice.dir * voice.speed * Math.pow(2, voice.pitch_semis / 12);
  }

  /**
   * Keep a looping voice inside its read range, one frame before it is read: a
   * plain loop jumps from one end to the other, a ping-pong mirrors the step that
   * would have left the range and turns around (a direction change, so the step
   * is worked out again).
   *
   * A range too short to turn in, or a step so big it never comes back, ends the
   * loop: the voice then runs out exactly as it would without Loop.
   * @param {object} voice
   * @param {number} bound the exclusive end of the frames there are to read
   * @returns {void}
   */
  function holdLoop(voice, bound) {
    if (bound - voice.start < SHORTEST_LOOP_FRAMES) {
      voice.looping = false;
      return;
    }
    const span = bound - voice.start;
    for (let turn = 0; turn < MOST_LOOP_TURNS; turn += 1) {
      const position = voice.position;
      if (position >= voice.start && position < bound) return;
      if (voice.loop === "pingpong") {
        // Mirrored about the end frame that was read last (or the start frame),
        // so neither end is heard twice on the way round.
        if (position >= bound) {
          voice.position = 2 * (bound - 1) - position;
          voice.dir = -1;
        } else {
          voice.position = 2 * voice.start - position;
          voice.dir = 1;
        }
        refreshStep(voice);
        continue;
      }
      voice.position = position >= bound ? position - span : position + span;
    }
    if (voice.position < voice.start || voice.position >= bound) voice.looping = false;
  }

  /**
   * Start (or restart) a voice on one pad trigger.
   *
   * Everything the voice needs is worked out here, once, so the render loop is
   * plain arithmetic. A range with no frames, or a sample with no PCM, is
   * refused by returning false and leaving the voice silent. A `paused` start is
   * the one Pause-all asks for (M22): the voice is silent and frozen from this
   * frame, and it is heard when the pause is let go.
   * @param {object} voice a record from `createVoice()`
   * @param {{channels: Float32Array[], frames?: number, start?: number,
   *          end?: number, reverse?: boolean, pitch?: number,
   *          gainDb?: number, velocity?: number, pan?: number,
   *          attackMs?: number, decayMs?: number, sustain?: number,
   *          releaseMs?: number, holdMs?: number, filterType?: string, cutoffHz?: number,
   *          resonance?: number, gateFrames?: number, choke?: number,
   *          mode?: string, loop?: string, speed?: number, paused?: boolean,
   *          trackId?: string, bankId?: string, index?: number,
   *          source_index?: number, serial?: number, sampleRate: number}} config
   * @returns {boolean} whether the voice started
   */
  function startVoice(voice, config) {
    const settings = config || {};
    const channels = Array.isArray(settings.channels) ? settings.channels : [];
    const first = channels[0];
    if (!first || first.length === 0) return false;

    const frames = Math.min(first.length, Math.max(0, Math.trunc(finiteOr(settings.frames, first.length))));
    const start = Math.trunc(clamp(finiteOr(settings.start, 0), 0, frames));
    const end = Math.trunc(clamp(finiteOr(settings.end, frames), start, frames));
    if (!(end > start)) return false;

    const rate = finiteOr(settings.sampleRate, 48000);
    const reverse = settings.reverse === true;
    const loop =
      settings.loop === "loop" || settings.loop === "pingpong" ? settings.loop : "off";
    const pan = panCoefficients(settings.pan);
    const velocity = clamp(finiteOr(settings.velocity, 127), 1, 127);
    const velocityGain = (velocity / 127) * (velocity / 127);

    voice.channels = channels;
    voice.frames = frames;
    voice.start = start;
    voice.end = end;
    voice.reverse = reverse;
    voice.position = reverse ? end - 1 : start;
    voice.dir = reverse ? -1 : 1;
    voice.speed = clamp(finiteOr(settings.speed, 1), LOWEST_SPEED, HIGHEST_SPEED);
    voice.pitch_semis = clamp(finiteOr(settings.pitch, 0), -48, 48);
    refreshStep(voice);
    voice.loop = loop;
    voice.looping = loop !== "off";
    // A start is a clean slot: whatever live state the voice it reuses carried
    // (a HOLD latch, Pause-all) belongs to the trigger that has just ended. A
    // start made WHILE Pause-all is on (M22) is the exception: it is created
    // paused, silent and frozen from its own first frame, and it ramps up on
    // resume like any other. Neither leaves a ramp running.
    voice.held = false;
    voice.paused = settings.paused === true;
    voice.pauseLevel = voice.paused ? 0 : 1;
    voice.pauseFrames = 0;
    voice.pauseStep = 0;
    voice.gain = dbToLinear(settings.gainDb) * velocityGain;
    voice.panLeft = pan.left;
    voice.panRight = pan.right;

    voice.attackFrames = msToFrames(settings.attackMs, rate);
    voice.decayFrames = msToFrames(settings.decayMs, rate);
    voice.releaseFrames = msToFrames(settings.releaseMs, rate);
    voice.sustain = clamp(finiteOr(settings.sustain, 1), 0, 1);
    // A hold of 0 frames is no stage at all: such a voice never enters it, and
    // renders exactly as it did before the stage existed.
    voice.holdFrames = msToFrames(settings.holdMs, rate);

    // Attack 0 starts at full level; a decay of 0 jumps straight to sustain.
    // A started voice sounds from its very first frame, even at level 0 while
    // an attack climbs: only DONE or the end of its range ends it, or an
    // attacked pad would be dropped on the frame it was triggered.
    voice.stage = STAGE_ATTACK;
    voice.level = 0;
    voice.increment = voice.attackFrames > 0 ? 1 / voice.attackFrames : 0;
    voice.sounding = true;
    if (voice.attackFrames === 0) {
      voice.level = 1;
      beginAfterAttack(voice);
    }

    setFilter(
      voice,
      typeof settings.filterType === "string" ? settings.filterType : "off",
      settings.cutoffHz,
      settings.resonance,
      rate,
    );

    const gateFrames = Number(settings.gateFrames);
    voice.mode = settings.mode === "gate" ? "gate" : "oneshot";
    voice.gateRemaining = Number.isFinite(gateFrames) && gateFrames > 0 ? Math.round(gateFrames) : -1;
    voice.fadeRemaining = 0;
    voice.ending = false;
    voice.heldLeft = 0;
    voice.heldRight = 0;
    voice.choke = Math.trunc(finiteOr(settings.choke, 0));
    voice.trackId = typeof settings.trackId === "string" ? settings.trackId : "";
    voice.bankId = typeof settings.bankId === "string" ? settings.bankId : "";
    voice.index = Math.trunc(finiteOr(settings.index, 0));
    // A start that names no source pad is a press on the pad whose sample it
    // plays, which is exactly what every start was before source pads existed.
    voice.source_index = Math.trunc(finiteOr(settings.source_index, voice.index));
    voice.serial = Math.trunc(finiteOr(settings.serial, 0));
    return true;
  }

  /**
   * Leave the attack for what comes next: the hold, if the pad asked for one,
   * or the decay (settling at the sustain when the decay is 0 frames).
   * @param {object} voice
   * @returns {void}
   */
  function beginAfterAttack(voice) {
    if (voice.holdFrames > 0) {
      voice.stage = STAGE_HOLD;
      voice.level = 1;
      voice.increment = 0;
      return;
    }
    if (voice.decayFrames === 0) {
      settleAtSustain(voice);
      return;
    }
    voice.stage = STAGE_DECAY;
    voice.increment = (1 - voice.sustain) / voice.decayFrames;
  }

  /**
   * Turn a sounding voice round where it stands (a Reverse flipped while the pad
   * plays). The position is NOT touched: the voice carries on from the frame it
   * was about to read, so nothing jumps, and only the step's sign changes. A
   * voice that is not looping then runs to the end it now heads for and ends
   * there; a looping or ping-pong voice turns at that end as it always does.
   * @param {object} voice
   * @returns {void}
   */
  function flipReverse(voice) {
    voice.dir = voice.dir < 0 ? 1 : -1;
    refreshStep(voice);
  }

  /**
   * Latch a voice: a HOLD keeps it sounding past the operator letting go and
   * past its own gate countdown, until `releaseHeld` lets the latch go. A voice
   * that is not sounding has nothing to latch.
   * @param {object} voice
   * @returns {void}
   */
  function holdVoice(voice) {
    if (!voice.sounding) return;
    voice.held = true;
  }

  /**
   * Let a HOLD go: clear the latch and run the ordinary release from wherever
   * the voice stands. This is the only way a held voice is released (a plain
   * `release` leaves it alone, which is what makes HOLD a hold), so every path
   * that must end a held voice — a Stop, a pad the song no longer has — comes
   * through here.
   * @param {object} voice
   * @returns {void}
   */
  function releaseHeldVoice(voice) {
    if (!voice.sounding) return;
    voice.held = false;
    releaseVoice(voice);
  }

  /**
   * Raise Pause-all on a voice: its level ramps to 0 over `FADE_FRAMES` while it
   * still advances, and it then stands frozen until `resumeVoice` lets it go.
   *
   * A voice that is already on its way out is not paused: one whose range ran
   * out (`ending`), and one that is fading (a choke, a steal) — those carry
   * `fadeRemaining`, and a pause would freeze the very ramp that is meant to end
   * them. A voice that is already paused keeps the ramp it has.
   * @param {object} voice
   * @returns {void}
   */
  function pauseVoice(voice) {
    if (!voice.sounding) return;
    if (voice.ending || voice.fadeRemaining > 0) return;
    if (voice.paused) return;
    voice.paused = true;
    if (!(voice.pauseLevel > 0)) {
      // Already silent — a voice that started under Pause-all (M22): there is
      // nothing to ramp down, so it is frozen where it stands.
      voice.pauseLevel = 0;
      voice.pauseFrames = 0;
      voice.pauseStep = 0;
      return;
    }
    voice.pauseFrames = FADE_FRAMES;
    voice.pauseStep = -voice.pauseLevel / FADE_FRAMES;
  }

  /**
   * Let Pause-all go on a voice: the level ramps back up to 1 over
   * `FADE_FRAMES` from the frame it was frozen on, and the voice advances again
   * while it climbs, so the resume is continuous with the pause.
   *
   * A voice that is not paused has nothing to resume, and a voice that is on its
   * way out is left to finish its fade.
   * @param {object} voice
   * @returns {void}
   */
  function resumeVoice(voice) {
    if (!voice.sounding) return;
    if (!voice.paused) return;
    voice.paused = false;
    if (voice.pauseLevel >= 1) {
      voice.pauseLevel = 1;
      voice.pauseFrames = 0;
      voice.pauseStep = 0;
      return;
    }
    voice.pauseFrames = FADE_FRAMES;
    voice.pauseStep = (1 - voice.pauseLevel) / FADE_FRAMES;
  }

  /**
   * Whether Pause-all has a voice standing still: it was ramped down to silence
   * and the ramp is over, so the render loop leaves everything it holds — its
   * read position, its envelope, its gate countdown — exactly as it is and
   * writes nothing for it.
   *
   * A voice with a fade still running is never frozen: that fade is what ends
   * it, so it runs on (silently) to its own end instead of being kept alive at
   * level 0 by a pause it can no longer reach.
   * @param {object} voice
   * @returns {boolean}
   */
  function frozenByPause(voice) {
    if (voice.paused !== true) return false;
    if (voice.pauseFrames > 0 || voice.pauseLevel > 0) return false;
    return !(voice.fadeRemaining > 0);
  }

  /**
   * Step the pause ramp on by one frame, after that frame was rendered. The
   * ramp's last step lands on its target exactly, so a voice is never left a
   * rounding error away from silence (or from full level).
   * @param {object} voice
   * @returns {void}
   */
  function advancePause(voice) {
    if (voice.pauseFrames === 0) return;
    voice.pauseLevel += voice.pauseStep;
    voice.pauseFrames -= 1;
    if (voice.pauseFrames === 0) {
      voice.pauseLevel = voice.pauseStep < 0 ? 0 : 1;
      voice.pauseStep = 0;
    }
  }

  /**
   * Begin the envelope's release. A release of 0 frames stops the voice at once
   * (the very frame the gate ends), which is what `gate` mode's step end means.
   *
   * A held voice ignores it: the operator's HOLD outranks letting go of the pad
   * (and the gate that would have ended it), and `releaseHeld` is what takes the
   * latch away and releases.
   * @param {object} voice
   * @returns {void}
   */
  function releaseVoice(voice) {
    if (!voice.sounding || voice.held) return;
    voice.looping = false;
    // A release ends the hold: whether it comes from a gate's countdown or from
    // the player letting go, the voice goes to its release from here, never on
    // through the decay, so there is no hold left to run.
    voice.holdFrames = 0;
    if (voice.stage === STAGE_RELEASE || voice.stage === STAGE_DONE) return;
    if (voice.releaseFrames <= 0) {
      voice.level = 0;
      voice.stage = STAGE_DONE;
      voice.sounding = false;
      return;
    }
    voice.stage = STAGE_RELEASE;
    voice.increment = voice.level / voice.releaseFrames;
  }

  /**
   * Fade a voice out over 64 frames (a choke group cutting it, or its range
   * running out at level). A voice already on its way out keeps its ramp.
   *
   * A voice on its way out holds nothing: the fade ends the loop, the HOLD latch
   * and Pause-all alike, so its ramp runs to its end instead of being kept alive
   * by a state the operator can no longer reach.
   * @param {object} voice
   * @returns {void}
   */
  function beginFadeOut(voice) {
    if (!voice.sounding) return;
    voice.looping = false;
    voice.held = false;
    voice.paused = false;
    if (voice.fadeRemaining > 0) return;
    voice.fadeRemaining = FADE_FRAMES;
  }

  /**
   * Advance the envelope by one frame, after that frame was rendered.
   * @param {object} voice
   * @returns {void}
   */
  function advanceEnvelope(voice) {
    if (voice.stage === STAGE_ATTACK) {
      voice.level += voice.increment;
      if (voice.level >= 1) {
        voice.level = 1;
        beginAfterAttack(voice);
      }
      return;
    }
    if (voice.stage === STAGE_HOLD) {
      voice.holdFrames -= 1;
      if (voice.holdFrames > 0) return;
      voice.holdFrames = 0;
      if (voice.decayFrames === 0) {
        settleAtSustain(voice);
        return;
      }
      voice.stage = STAGE_DECAY;
      voice.increment = (1 - voice.sustain) / voice.decayFrames;
      // Fall through: the frame the hold ends on is the decay's own first frame,
      // so its first step down lands here and the level stayed at 1 for exactly
      // the hold's frames.
    }
    if (voice.stage === STAGE_DECAY) {
      voice.level -= voice.increment;
      // The decay's last step lands on the sustain exactly, whatever the rounding
      // of the subtractions added up to, so a sustain of 0 ends the voice on the
      // frame the decay reaches it instead of one frame of rounding later (M23).
      if (voice.level - voice.sustain <= voice.increment * LEVEL_ARRIVED) settleAtSustain(voice);
      return;
    }
    if (voice.stage === STAGE_RELEASE) {
      voice.level -= voice.increment;
      if (voice.level <= 0) {
        voice.level = 0;
        voice.stage = STAGE_DONE;
        voice.sounding = false;
      }
    }
  }

  /**
   * One frame of the gate's countdown; at zero the release begins. A held voice
   * has no countdown: its gate would end it, and a HOLD is what keeps it on.
   */
  function countdown(voice) {
    if (voice.held) return;
    if (voice.gateRemaining > 0) {
      voice.gateRemaining -= 1;
      return;
    }
    if (voice.gateRemaining === 0) {
      voice.gateRemaining = -1;
      releaseVoice(voice);
    }
  }

  /**
   * Render one voice into a run of frames, adding to the mix.
   *
   * `gainLeft`/`gainRight` are the track's mix coefficients (its gain and its
   * constant-power pan), which this multiplies with the voice's own pan; the
   * voice's dB and velocity gain are already in `voice.gain`.
   * @param {object} voice
   * @param {number} frames how many frames this run holds
   * @param {Float32Array|null} left the mix's left channel, `null` to advance only
   * @param {Float32Array|null} right the mix's right channel (may be null)
   * @param {number} offset where the run starts in those channels
   * @param {number} gainLeft the track's left mix coefficient
   * @param {number} gainRight the track's right mix coefficient
   * @returns {void}
   */
  function renderVoice(voice, frames, left, right, offset, gainLeft, gainRight) {
    if (!voice.sounding) return;
    const channels = voice.channels;
    const channel0 = channels && channels[0];
    if (!channel0 || channel0.length === 0) {
      voice.sounding = false;
      return;
    }
    const channel1 = channels.length > 1 && channels[1] && channels[1].length > 0 ? channels[1] : null;
    const mono = channel1 === null;
    // Both channels are read at the same position, so the run stops where the
    // shorter one does (a sample of unequal channels is not a channel swap).
    const length = Math.min(voice.frames, channel0.length, mono ? channel0.length : channel1.length);

    // The pan is the voice's; the track's own gain and pan are the mix's.
    const leftGain = gainLeft * voice.panLeft;
    const rightGain = gainRight * voice.panRight;
    const audible = left !== null || right !== null;

    for (let frame = 0; frame < frames; frame += 1) {
      if (!voice.sounding) break;
      // A voice Pause-all has ramped down and frozen stands exactly where it is:
      // nothing advances and nothing is heard until it is resumed (M17). It
      // stands still for the whole block, so the render leaves early rather than
      // walking the rest of the frames for nothing.
      if (frozenByPause(voice)) break;
      countdown(voice);
      if (voice.stage === STAGE_DONE) {
        voice.sounding = false;
        voice.looping = false;
        break;
      }

      // A looping voice turns at its range ends instead of running out of them.
      if (voice.looping) holdLoop(voice, Math.min(voice.end, length));

      let signalLeft = 0;
      let signalRight = 0;

      if (voice.ending) {
        signalLeft = voice.heldLeft;
        signalRight = voice.heldRight;
      } else {
        const position = voice.position;
        if (position < voice.start || position >= voice.end || position >= length) {
          // The range has run out: hold the last sample for the 64-frame fade
          // (a voice still at level would otherwise click), then stop.
          voice.ending = true;
          voice.looping = false;
          if (voice.level <= 0) {
            voice.sounding = false;
            break;
          }
          if (voice.fadeRemaining === 0) voice.fadeRemaining = FADE_FRAMES;
          signalLeft = voice.heldLeft;
          signalRight = voice.heldRight;
        } else {
          const base = Math.floor(position);
          const fraction = position - base;
          // The neighbour never leaves the voice's own range: a forward read
          // stops at end − 1, a reversed one at start, so the last frame of a
          // slice cannot bleed the next slice's audio into it. A shorter second
          // channel caps it too (both channels are read at one position).
          const limit = Math.min(voice.dir < 0 ? voice.start : voice.end - 1, length - 1);
          const next = base + 1 > limit ? (limit > base ? limit : base) : base + 1;

          const a = channel0[base];
          const raw =
            fraction === 0 ? a : a + (channel0[next] - a) * fraction;
          let rawRight = raw;
          if (!mono) {
            const b = channel1[base];
            rawRight = fraction === 0 ? b : b + (channel1[next] - b) * fraction;
          }

          let valueLeft = raw * voice.level;
          let valueRight = mono ? valueLeft : rawRight * voice.level;

          if (voice.filterType !== FILTER_OFF) {
            const outLeft =
              voice.b0 * valueLeft +
              voice.b1 * voice.x1a +
              voice.b2 * voice.x2a -
              voice.a1 * voice.y1a -
              voice.a2 * voice.y2a;
            voice.x2a = voice.x1a;
            voice.x1a = flush(valueLeft);
            voice.y2a = voice.y1a;
            voice.y1a = flush(outLeft);
            valueLeft = voice.y1a;

            if (mono) {
              valueRight = valueLeft;
            } else {
              const outRight =
                voice.b0 * valueRight +
                voice.b1 * voice.x1b +
                voice.b2 * voice.x2b -
                voice.a1 * voice.y1b -
                voice.a2 * voice.y2b;
              voice.x2b = voice.x1b;
              voice.x1b = flush(valueRight);
              voice.y2b = voice.y1b;
              voice.y1b = flush(outRight);
              valueRight = voice.y1b;
            }
          }

          signalLeft = valueLeft;
          signalRight = valueRight;
          voice.heldLeft = flush(signalLeft);
          voice.heldRight = flush(signalRight);
          voice.position = position + voice.step;
        }
      }

      let fade = 1;
      if (voice.fadeRemaining > 0) {
        fade = voice.fadeRemaining / FADE_FRAMES;
        voice.fadeRemaining -= 1;
        if (voice.fadeRemaining === 0) {
          // The last frame of the fade: a voice that has faded all the way out
          // is dead, so it holds nothing and is not paused or looping either.
          voice.sounding = false;
          voice.looping = false;
          voice.held = false;
          voice.paused = false;
        }
      }

      if (audible) {
        const at = offset + frame;
        const duck = voice.pauseLevel;
        if (left !== null && leftGain !== 0) left[at] += signalLeft * voice.gain * fade * duck * leftGain;
        if (right !== null && rightGain !== 0) right[at] += signalRight * voice.gain * fade * duck * rightGain;
      }

      advanceEnvelope(voice);
      advancePause(voice);
    }
  }

  const api = {
    create: createVoice,
    start: startVoice,
    render: renderVoice,
    release: releaseVoice,
    /** Latch a sounding voice (HOLD), and let that latch go again. */
    hold: holdVoice,
    releaseHeld: releaseHeldVoice,
    /** Pause-all on one voice: ramp it down and freeze it, and let it go again. */
    pause: pauseVoice,
    resume: resumeVoice,
    beginFadeOut: beginFadeOut,
    flipReverse: flipReverse,
    refreshStep: refreshStep,
    setFilter: setFilter,
    dbToLinear: dbToLinear,
    msToFrames: msToFrames,
    panCoefficients: panCoefficients,
    FADE_FRAMES: FADE_FRAMES,
    DENORMAL_FLOOR: DENORMAL_FLOOR,
    /** The shortest range a loop can turn around in, in frames. */
    SHORTEST_LOOP_FRAMES: SHORTEST_LOOP_FRAMES,
    /** The envelope's release stage, for a caller that asks "is it going away?". */
    STAGE_RELEASE: STAGE_RELEASE,
    /**
     * The hold stage (level 1 between the attack and the decay), for a caller
     * that asks "is it holding?" — and so that no caller has to hard-code 5.
     */
    STAGE_HOLD: STAGE_HOLD,
  };

  if (typeof globalThis !== "undefined") globalThis.StudioSamplerVoice = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();