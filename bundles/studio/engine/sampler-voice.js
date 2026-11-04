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
 * The pitch ratio is the per-frame step through the sample, so the read is a
 * plain double position with linear interpolation: at ratio 1 the voice is
 * sample-exact, at ratio 2 every other sample is read (an octave up, half the
 * length), and a fractional ratio blends the two neighbours. Reversed playback
 * runs the same position backwards from the end of the range.
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

  /** The envelope's stages, in the order a voice moves through them. */
  const STAGE_ATTACK = 0;
  const STAGE_DECAY = 1;
  const STAGE_SUSTAIN = 2;
  const STAGE_RELEASE = 3;
  const STAGE_DONE = 4;

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
      /** The step per frame: 2^(pitch/12), negated when reversed. */
      step: 1,
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
      /** Frames left in a choke (or end-of-range) fade; 0 means "not fading". */
      fadeRemaining: 0,
      /** Whether the read position has left the range (the fade then holds). */
      ending: false,
      /** The last post-filter sample, held through that fade. */
      heldLeft: 0,
      heldRight: 0,
      /** The pad this voice came from, so a live release can find it. */
      trackId: "",
      bankId: "",
      index: 0,
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
   * Start (or restart) a voice on one pad trigger.
   *
   * Everything the voice needs is worked out here, once, so the render loop is
   * plain arithmetic. A range with no frames, or a sample with no PCM, is
   * refused by returning false and leaving the voice silent.
   * @param {object} voice a record from `createVoice()`
   * @param {{channels: Float32Array[], frames?: number, start?: number,
   *          end?: number, reverse?: boolean, pitch?: number,
   *          gainDb?: number, velocity?: number, pan?: number,
   *          attackMs?: number, decayMs?: number, sustain?: number,
   *          releaseMs?: number, filterType?: string, cutoffHz?: number,
   *          resonance?: number, gateFrames?: number, choke?: number,
   *          trackId?: string, bankId?: string, index?: number,
   *          serial?: number, sampleRate: number}} config
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
    const pitch = clamp(finiteOr(settings.pitch, 0), -48, 48);
    const ratio = Math.pow(2, pitch / 12);
    const reverse = settings.reverse === true;
    const pan = panCoefficients(settings.pan);
    const velocity = clamp(finiteOr(settings.velocity, 127), 1, 127);
    const velocityGain = (velocity / 127) * (velocity / 127);

    voice.channels = channels;
    voice.frames = frames;
    voice.start = start;
    voice.end = end;
    voice.reverse = reverse;
    voice.position = reverse ? end - 1 : start;
    voice.step = reverse ? -ratio : ratio;
    voice.gain = dbToLinear(settings.gainDb) * velocityGain;
    voice.panLeft = pan.left;
    voice.panRight = pan.right;

    voice.attackFrames = msToFrames(settings.attackMs, rate);
    voice.decayFrames = msToFrames(settings.decayMs, rate);
    voice.releaseFrames = msToFrames(settings.releaseMs, rate);
    voice.sustain = clamp(finiteOr(settings.sustain, 1), 0, 1);

    // Attack 0 starts at full level; a decay of 0 jumps straight to sustain.
    voice.stage = STAGE_ATTACK;
    voice.level = 0;
    voice.increment = voice.attackFrames > 0 ? 1 / voice.attackFrames : 0;
    if (voice.attackFrames === 0) {
      voice.level = 1;
      if (voice.decayFrames === 0) {
        voice.level = voice.sustain;
        voice.stage = STAGE_SUSTAIN;
      } else {
        voice.stage = STAGE_DECAY;
        voice.increment = (1 - voice.sustain) / voice.decayFrames;
      }
    }

    setFilter(
      voice,
      typeof settings.filterType === "string" ? settings.filterType : "off",
      settings.cutoffHz,
      settings.resonance,
      rate,
    );

    const gateFrames = Number(settings.gateFrames);
    voice.gateRemaining = Number.isFinite(gateFrames) && gateFrames > 0 ? Math.round(gateFrames) : -1;
    voice.fadeRemaining = 0;
    voice.ending = false;
    voice.heldLeft = 0;
    voice.heldRight = 0;
    voice.choke = Math.trunc(finiteOr(settings.choke, 0));
    voice.trackId = typeof settings.trackId === "string" ? settings.trackId : "";
    voice.bankId = typeof settings.bankId === "string" ? settings.bankId : "";
    voice.index = Math.trunc(finiteOr(settings.index, 0));
    voice.serial = Math.trunc(finiteOr(settings.serial, 0));
    voice.sounding = voice.level > 0;
    return true;
  }

  /**
   * Begin the envelope's release. A release of 0 frames stops the voice at once
   * (the very frame the gate ends), which is what `gate` mode's step end means.
   * @param {object} voice
   * @returns {void}
   */
  function releaseVoice(voice) {
    if (!voice.sounding) return;
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
   * @param {object} voice
   * @returns {void}
   */
  function beginFadeOut(voice) {
    if (!voice.sounding) return;
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
        if (voice.decayFrames === 0) {
          voice.level = voice.sustain;
          voice.stage = STAGE_SUSTAIN;
        } else {
          voice.stage = STAGE_DECAY;
          voice.increment = (1 - voice.sustain) / voice.decayFrames;
        }
      }
      return;
    }
    if (voice.stage === STAGE_DECAY) {
      voice.level -= voice.increment;
      if (voice.level <= voice.sustain) {
        voice.level = voice.sustain;
        voice.stage = STAGE_SUSTAIN;
      }
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

  /** One frame of the gate's countdown; at zero the release begins. */
  function countdown(voice) {
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
      countdown(voice);
      if (voice.stage === STAGE_DONE) {
        voice.sounding = false;
        break;
      }

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
          const next = base + 1 < length ? base + 1 : base;

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
        if (voice.fadeRemaining === 0) voice.sounding = false;
      }

      if (audible) {
        const at = offset + frame;
        if (left !== null && leftGain !== 0) left[at] += signalLeft * voice.gain * fade * leftGain;
        if (right !== null && rightGain !== 0) right[at] += signalRight * voice.gain * fade * rightGain;
      }

      advanceEnvelope(voice);
    }
  }

  const api = {
    create: createVoice,
    start: startVoice,
    render: renderVoice,
    release: releaseVoice,
    beginFadeOut: beginFadeOut,
    setFilter: setFilter,
    dbToLinear: dbToLinear,
    msToFrames: msToFrames,
    panCoefficients: panCoefficients,
    FADE_FRAMES: FADE_FRAMES,
    DENORMAL_FLOOR: DENORMAL_FLOOR,
    /** The envelope's release stage, for a caller that asks "is it going away?". */
    STAGE_RELEASE: STAGE_RELEASE,
  };

  if (typeof globalThis !== "undefined") globalThis.StudioSamplerVoice = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();