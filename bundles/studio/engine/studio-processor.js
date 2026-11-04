/**
 * Studio engine worklet processor — the SunVox host.
 *
 * `engine-client.js` concatenates four files into ONE module and loads it with
 * `audioWorklet.addModule()`:
 *
 *     sequencer.js + resample.js + sunvox.js + studio-processor.js
 *
 * so this file shares a module scope with the vendored SunVox glue (which
 * declares the `SunVoxLib` factory) and with the pure sequencer
 * (`StudioSequencer` on `globalThis`). Nothing here is imported: the same
 * source runs in a browser's `AudioWorkletGlobalScope` and in
 * node-web-audio-api's worklet thread.
 *
 * ## One SunVox engine per track, mixed in JavaScript
 *
 * `sv_audio_callback()` mixes every open slot of its engine instance into one
 * stereo buffer, and the library's only per-module tap is `sv_get_module_scope2()`'s
 * 16-bit scope — a display trace, not a mixdown. So an exact per-track gain and
 * pan is only possible if each track owns its own engine instance: one
 * `SunVoxLib()` per track (16 at most), each with one open slot, one device
 * module in that slot, connected straight to that engine's Output. Every block
 * renders each engine into its own preallocated buffer and THIS file does the
 * mix:
 *
 *     out += track * 10^(gain_db / 20) * [cos θ, sin θ],  θ = (pan + 1)π/4
 *
 * which is the constant-power pan and a real dB gain (so −60 dB is −60 dB, not
 * a rounded-away controller value). The SunVox side stays at unity: the slot
 * volume is set once, and no gain or pan is ever written to a SunVox volume,
 * balance or amplifier controller. After the sum, one hard clip at ±1.0 is the
 * whole master stage (spec §5.1: no Web Audio node shapes sound).
 *
 * The vendored `sunvox_lib_loader.js` keeps ONE instance in a module-scope
 * `svlib` plus module-scope scratch pointers, so it can back only one engine
 * per realm — it is not part of this worklet module. `bindEngine()` below talks
 * to the `_sv_*` exports directly instead, which is what lets sixteen engines
 * live in one worklet.
 *
 * ## What this depends on (vendored 2.1.4d WASM build)
 *
 * - **`out_time` must advance.** With `out_time` stuck the library returns
 *   silence. Every engine therefore keeps its own frame clock, advanced by the
 *   frames rendered; it is never `sv_get_ticks()`, which is wall-clock time and
 *   would make two hosts disagree.
 * - **`sv_set_event_t(slot, 1, 0)` is required for live notes.** With the
 *   default "automatic" timestamps a note sent by `sv_send_event()` can land
 *   far ahead of the audio we ask for and never sound; pinning the timestamp to
 *   0 means "as quickly as possible", i.e. at the start of the next callback,
 *   which is exactly what the sub-block split below needs.
 * - **Note numbers are 11 semitones below the library's own pitch base.** A
 *   note sent as `nn` sounds at `16.333984375 * 2^((nn + 11) / 12)` Hz, so MIDI
 *   60 (261.63 Hz) is SunVox note 37, i.e. `nn = p - 23`. The pitch test in
 *   `tests/studio-engine.test.js` pins this.
 * - **`sv_send_event()`'s module field is one past the module number**
 *   `sv_new_module()` returned: the device module `M` is addressed as `M + 1`.
 * - **`sv_new_module()` / `sv_connect_module()` / `sv_remove_module()` need the
 *   slot lock** (`USE LOCK/UNLOCK!` in the vendor header), including the
 *   cleanup path of a build that failed.
 *
 * The glue is told it is not Node (see `callSunVoxFactory`): inside
 * node-web-audio-api's worklet thread `globalThis.process` exists, and the Node
 * branch of the factory would reach for `require("fs")`/`__dirname`, neither of
 * which exists in that scope.
 *
 * ## Audio tracks: two PCM voices, not an engine
 *
 * A track whose device is `{engine: "audio"}` plays recorded takes instead of
 * SunVox notes, so it has no engine and no module. Its slot holds two PCM
 * voices: the sequencer alternates between them at consecutive comp segment
 * starts, and when a start lands while the other voice is still sounding the
 * two crossfade linearly over 64 frames — the old one 1 → 0, the new one
 * 0 → 1, sample-exact and independent of the block size, because the ramps are
 * counted in frames and not in blocks. A voice that reaches the end of its
 * take goes silent.
 *
 * A voice's gain can also be ramped by an arrangement placement's fade
 * (`{type:"fade", track_id, voice, frame, from, to, frames}`): the ramp is
 * counted in frames from the frame it was applied at and multiplies the
 * crossfade envelope, so a fade in starts at silence and reaches its top
 * exactly `frames` frames later, whatever block size the host asks for.
 *
 * The PCM arrives already at the context's rate
 * (`{type:"audio", take_id, channels:[Float32Array…]}`, transferred), because
 * resampling is `engine/resample.js`'s business and runs on the client. A
 * start for a take that has not been loaded plays silence and is reported once
 * per take id: "Take <id> is not loaded yet." A mono take plays to both
 * channels; the take's own `take_frame` says where in it to start (it already
 * carries the recorded offset, and may be negative, which is a short silence
 * before the take begins).
 *
 * Track gain, pan, mute and solo apply to an audio track exactly as they do to
 * an engine's output: in the mix below, after the voices are summed.
 *
 * ## Sampler tracks: a pool of pad voices, JS DSP
 *
 * A track whose device is `{engine: "sampler"}` plays a kit of pads instead of
 * notes, and its clips are patterns (see `sequencer.js`). Its slot holds a pool
 * of 16 voices (`sampler-voice.js`, `StudioSamplerVoice`), and a `pad` event
 * starts one:
 *
 *     {frame, type: "pad", track_id, bank_id, index, v, locks, gate_frames}
 *
 * The pad is read from the song's own `pads` container, which `setSong` copies
 * into a flat map; a step's `locks` override the pad's fields for that one
 * voice. The voice plays the pad's slice (or the whole sample), pitched by
 * resampling, through its envelope and its one biquad, then gain and pan.
 *
 * - **The PCM** arrives from the client already at the context's rate
 *   (`{type:"sample", sample_id, channels}`, acknowledged like a take), because
 *   resampling is `resample.js`'s business and runs on the client. A trigger for
 *   a sample that is not loaded plays silence and is reported once per sample
 *   id ("Sample <id> is not loaded yet."), and is also posted as
 *   `{type:"sample_needed", sample_id}` so the client can load it again.
 * - **Voice stealing:** 16 voices per track, 64 for the whole song. The 17th
 *   voice on a track steals that track's oldest, and a start that would take
 *   the song past 64 steals the song's oldest — a voice that is already fading
 *   out (choked, or already releasing) goes before one that is still held. A
 *   track's own steal fades: the stolen voice is moved into one of the track's
 *   two fade tails and rung out over 64 frames while the new voice takes its
 *   slot (with both tails in use it is cut instead — the pool stays 16). The
 *   song-wide steal cuts, so a song past its 64-voice cap really is 64 voices.
 *   Nothing is stolen until the new voice's own range is known to be playable.
 * - **Choke groups:** a start in choke group *n* fades every other sounding
 *   voice of group *n* on that track out over 64 frames.
 * - **Modes:** a `oneshot` pad plays to the end of its range and stops there
 *   (with a 64-frame fade when it is still at level); a `gate` pad releases at
 *   `gate_frames`, the step's own length.
 * - **Live pads:** `{type:"live", track_id, bank_id, index, v, on}` starts or
 *   releases a pad from the panel (on-screen audition, MIDI later). A live
 *   start never goes through history and is never quantized. A release only
 *   releases `gate` voices: a `oneshot` pad that was pressed plays to its end.
 * - **Locks:** every one of a pad's own fields can be locked per step —
 *   `attack_ms`, `decay_ms`, `sustain`, `release_ms`, `pitch`, `gain_db`,
 *   `pan`, `reverse`, `cutoff_hz`, `resonance` and the filter's kind under
 *   `filter_type` — and all of them go through the same `field()` lookup.
 *
 * ## Taps
 *
 * `{type:"tap", target, on}` turns on a copy of the master ("master") or of
 * one track's own output (that track's id) per block, posted as
 * `{type:"tap_block", target, frame, channels}`, `frame` being the context's
 * frame the block's first sample sits on (the same clock `launched` and
 * `nextBarFrame` report). Record-into-pad and resampling use it. A tap is off by
 * default, and off costs nothing at all.
 *
 * ## Block splitting
 *
 * `process()` is handed 128 frames. The sequencer's events for the block are
 * applied at their own frame: the block is rendered in runs, `sv_send_event()`
 * for every event at the cursor, then `sv_audio_callback()` on every track's
 * engine covering the frames up to the next event. Nothing is allocated per
 * block: each engine's callback buffer is allocated once (with the smallest
 * block it will ever be asked for) and only grows if a host asks for a block
 * bigger than the current one.
 *
 * ## `process()` never throws
 *
 * A throw out of an AudioWorkletProcessor takes the host's audio thread down
 * and the graph never recovers, so the block body is guarded: the first throw
 * is reported to the client once, the engine is marked failed, and every later
 * block outputs silence while `process()` keeps returning true. A fault in a
 * client message or in one track's build is reported without stopping the
 * engine — only process-time or start-up faults are fatal.
 *
 * ## Messages
 *
 * client → processor: `{type:"song", snapshot}`, `{type:"launchScene", id}`,
 * `{type:"launchClip", id}`, `{type:"stopTrack", id}`, `{type:"stopAll"}`,
 * `{type:"play"}`, `{type:"stop"}`, `{type:"setMode", mode}`,
 * `{type:"seek", bar}`, `{type:"flush", id}`,
 * `{type:"nextBarFrame", id}`, `{type:"audio", take_id, channels}`,
 * `{type:"audio_unload", take_id}`, `{type:"sample", sample_id, channels}`,
 * `{type:"sample_unload", sample_id}`, `{type:"live", track_id, bank_id,
 * index, v, on}`, `{type:"tap", target, on}`
 * processor → client: `{type:"ready"}`, `{type:"flushed", id}`, `{type:"error",
 * error}`, `{type:"position", bar, beat, sixteenth}` (at most every 50 ms of
 * audio), `{type:"launched", track_id, clip_id, scene_id, bar, frame}` (one
 * per launch the sequencer applied in that block; see below),
 * `{type:"nextBarFrame", id, frame, bar}`, `{type:"audio_loaded", take_id}`
 * (one ack per `audio` message, so the client knows the PCM is in),
 * `{type:"sample_loaded", sample_id}` (one ack per `sample` message),
 * `{type:"sample_needed", sample_id}` (a trigger for a sample that is not
 * loaded, once per sample id), `{type:"tap_block", target, frame, channels}`
 * (while a tap is on, one per block)
 *
 * ## Frames the client can count on
 *
 * A `launched` report and a `nextBarFrame` answer are both in the CONTEXT's
 * frames, not this processor's: `currentFrame`, the AudioWorkletGlobalScope
 * global every processor on one AudioContext shares, so a recorder built as a
 * second worklet on the same context arms on the very frame the engine's
 * launch took effect. A `tap_block` carries its own `frame` in the same clock —
 * the context frame of its first sample — so a resample can cut what it keeps
 * exactly on a bar line instead of counting blocks. `bar` is 0-based. The
 * translation from the sequencer's
 * own frames is measured once, at the first block (see `contextOffset()`).
 *
 * Two message types exist only when `processorOptions.testHooks === true`, and
 * are ignored otherwise: `{type:"__throw"}` arms a throw inside the next
 * `process()` (the failure policy above), and a track whose
 * `device.type` is `"__fail_device"` cannot be built (the retry rule in
 * `syncSlots`).
 *
 * ## Parity
 *
 * Two hosts that feed the same song the same number of frames do the same wasm
 * work and the same float mix in the same order, so they produce the same
 * bytes.
 */
(function () {
  "use strict";

  /** The name this file registers, and the name engine-client constructs. */
  const PROCESSOR_NAME = "studio-processor";

  /** A song holds at most this many tracks, and each track owns one engine. */
  const MAX_TRACKS = 16;

  /** Every track's engine uses this one slot: the track is that engine's song. */
  const SLOT = 0;

  /** A SunVox song's Output module is always module 0. */
  const OUTPUT_MODULE = 0;

  /** The module used for a track whose device names none, or an unknown one. */
  const FALLBACK_DEVICE = "Analog generator";

  /** A device type that only exists under the test hooks (see `buildSlot`). */
  const FAILING_DEVICE = "__fail_device";

  /** MIDI pitch → SunVox note number (see the header: MIDI 60 is note 37). */
  const MIDI_TO_NOTE = -23;

  /** The lowest and highest note number the library accepts. */
  const LOWEST_NOTE = 1;
  const HIGHEST_NOTE = 127;

  /** Velocity is `1..129` in SunVox; 0 means "the module's default". */
  const LOWEST_VELOCITY = 1;
  const HIGHEST_VELOCITY = 129;

  /** SunVox's "all notes off for this module" command. */
  const NOTECMD_NOTE_OFF = 128;

  /**
   * A track's gain is held between these, in dB: the document's range. −60 dB
   * is a real −60 dB in the mix below, never silence (mute is what silences a
   * track).
   */
  const LOWEST_GAIN_DB = -60;
  const HIGHEST_GAIN_DB = 12;

  /** The slot volume every engine runs at: unity, so gain belongs to the mix. */
  const SLOT_VOLUME_UNITY = 256;

  /**
   * `sv_init` flags, inlined because the vendored loader (which defines the
   * `SV_INIT_FLAG_*` names) is not part of this module:
   * no debug output, our own audio callback, float32 samples, one thread.
   */
  const INIT_FLAGS =
    (1 << 0) | /* SV_INIT_FLAG_NO_DEBUG_OUTPUT */
    (1 << 1) | /* SV_INIT_FLAG_USER_AUDIO_CALLBACK */
    (1 << 3) | /* SV_INIT_FLAG_AUDIO_FLOAT32 */
    (1 << 4); /* SV_INIT_FLAG_ONE_THREAD */

  /** How much audio between two `position` messages, in seconds. */
  const POSITION_INTERVAL_SECONDS = 0.05;

  /** The smallest block this processor allocates and primes for. */
  const INITIAL_QUANTUM = 128;

  /** The device engine that marks a track as a PCM one (see `isAudioTrack`). */
  const AUDIO_ENGINE = "audio";

  /** The device engine that marks a track as a sampler one (see `isSamplerTrack`). */
  const SAMPLER_ENGINE = "sampler";

  /** How many voices one sampler track holds, and how many the song may sound. */
  const SAMPLER_VOICES_PER_TRACK = 16;
  const SAMPLER_VOICES_SONG_WIDE = 64;

  /**
   * How many stolen voices one track can ring out at once. The 16 voice slots
   * are all in use when a steal happens, so the stolen voice fades in one of
   * these tails instead of holding the slot it is losing; two cover a steal
   * chain, and past them a stolen voice is simply cut.
   */
  const STOLEN_TAILS_PER_TRACK = 2;

  /**
   * How many bytes of decoded samples may be loaded at once. Past this the
   * least-recently-triggered sample is unloaded (the client reloads it when a
   * `sample_needed` says so).
   */
  const MAX_SAMPLE_BYTES = 256 * 1024 * 1024;

  /**
   * What a trigger for a sample the client has not loaded is reported with,
   * once per sample id.
   * @param {string} sampleId
   * @returns {string}
   */
  function missingSampleText(sampleId) {
    return `Sample ${sampleId} is not loaded yet.`;
  }

  /** How long a comp-boundary crossfade runs, in frames. */
  const VOICE_FADE_FRAMES = 64;

  /** @returns {number} the value held between two bounds. */
  function clamp(value, low, high) {
    if (!Number.isFinite(value)) return low;
    if (value < low) return low;
    if (value > high) return high;
    return value;
  }

  /** @returns {string} an id in the form a Map is keyed by. */
  function asId(value) {
    return value === undefined || value === null ? "" : String(value);
  }

  /**
   * The AudioWorkletGlobalScope's `currentFrame`: the frame the whole context
   * has rendered so far, which every processor on that context reads the same
   * way. A host that does not provide it answers `null`.
   * @returns {number|null}
   */
  function contextFrameNow() {
    // `typeof` on an undeclared identifier is safe and is the only way to ask
    // for a worklet global without assuming the host has one.
    if (typeof currentFrame === "undefined") return null;
    return typeof currentFrame === "number" && Number.isFinite(currentFrame) ? currentFrame : null;
  }

  /** @returns {string} the module type a track's device names. */
  function deviceType(track) {
    const device = track && typeof track === "object" ? track.device : null;
    const type = device && typeof device.type === "string" ? device.type.trim() : "";
    return type === "" ? FALLBACK_DEVICE : type;
  }

  /**
   * Whether a track plays recorded takes instead of a SunVox module. An audio
   * track's device is exactly `{engine: "audio"}` (see `doc.js`).
   * @param {object} track
   * @returns {boolean}
   */
  function isAudioTrack(track) {
    const device = track && typeof track === "object" ? track.device : null;
    return !!(device && typeof device === "object" && device.engine === AUDIO_ENGINE);
  }

  /**
   * Whether a track plays a kit of pads instead of notes or takes. A sampler
   * track's device is exactly `{engine: "sampler"}` (see `doc.js`); its kit
   * lives in the song's own `banks` and `pads`, never inside the device.
   * @param {object} track
   * @returns {boolean}
   */
  function isSamplerTrack(track) {
    const device = track && typeof track === "object" ? track.device : null;
    return !!(device && typeof device === "object" && device.engine === SAMPLER_ENGINE);
  }

  /**
   * The key one pad lives under in the song's `pads` container — the same key
   * `doc.js` writes, so a pad is one lookup and never a walk over the kit.
   * @param {string} trackId
   * @param {string} bankId
   * @param {number} index
   * @returns {string}
   */
  function padKey(trackId, bankId, index) {
    return `${asId(trackId)}/${asId(bankId)}/${Math.trunc(Number(index) || 0)}`;
  }

  /**
   * The key one slice lives under in the song's `slices` container.
   * @param {string} sampleId
   * @param {string} sliceId
   * @returns {string}
   */
  function sliceKey(sampleId, sliceId) {
    return `${asId(sampleId)}/${asId(sliceId)}`;
  }

  /**
   * Copy the channels a client posted into JS-owned `Float32Array`s, dropping
   * anything that is not a channel. A view into a larger buffer is copied, so
   * the voice never reads past its own channel.
   * @param {unknown} channels
   * @returns {Float32Array[]}
   */
  function readChannels(channels) {
    const list = [];
    const raw = Array.isArray(channels) ? channels : [];
    for (const channel of raw) {
      if (channel instanceof Float32Array) list.push(channel);
      else if (ArrayBuffer.isView(channel)) {
        list.push(
          new Float32Array(channel.buffer.slice(channel.byteOffset, channel.byteOffset + channel.byteLength)),
        );
      } else if (Array.isArray(channel)) list.push(Float32Array.from(channel));
    }
    return list;
  }

  /**
   * A silent PCM voice. `position` is the frame of the take it will read next
   * (negative until the take starts); `gain` is its fade envelope. The ramp is
   * advanced once per rendered frame in `advanceFade()`, so it is the same 64
   * frames whatever block size the host asks for. `fade` is a placement's
   * linear gain ramp on top of that envelope (see `startFade`).
   * @returns {object}
   */
  function newVoice() {
    return {
      channels: null,
      position: 0,
      sounding: false,
      gain: 0,
      fadeRemaining: 0,
      fadeStep: 0,
      fadeTarget: 1,
      fade: null,
    };
  }

  /**
   * The gain multiplier a voice's placement fade contributes at this frame
   * (1 when it has none).
   * @param {object} voice
   * @returns {number}
   */
  function fadeGainOf(voice) {
    const fade = voice.fade;
    if (!fade) return 1;
    if (fade.index >= fade.frames) return fade.to;
    return fade.from + ((fade.to - fade.from) * fade.index) / fade.frames;
  }

  /**
   * Advance a voice's placement fade by one frame, after that frame was
   * rendered.
   * @param {object} voice
   */
  function advanceVoiceFade(voice) {
    const fade = voice.fade;
    if (!fade || fade.index >= fade.frames) return;
    fade.index += 1;
  }

  /**
   * Start a linear ramp of one voice's gain, over the crossfade length.
   * @param {object} voice
   * @param {number} target the gain to reach
   */
  function beginFade(voice, target) {
    voice.fadeRemaining = VOICE_FADE_FRAMES;
    voice.fadeStep = (target - voice.gain) / VOICE_FADE_FRAMES;
    voice.fadeTarget = target;
  }

  /**
   * Send one voice out: 1 → 0 over the crossfade length, from wherever its
   * gain is now. A voice already on its way out keeps the ramp it has, so a
   * stop landing after the start that began the crossfade cannot restart it.
   * @param {object} voice
   */
  function beginFadeOut(voice) {
    if (!voice.sounding) return;
    if (voice.fadeRemaining > 0 && voice.fadeTarget === 0) return;
    if (voice.gain <= 0) {
      voice.sounding = false;
      return;
    }
    beginFade(voice, 0);
  }

  /**
   * Advance one voice's envelope by one frame, after that frame was rendered.
   * @param {object} voice
   */
  function advanceFade(voice) {
    if (voice.fadeRemaining <= 0) return;
    voice.fadeRemaining -= 1;
    if (voice.fadeRemaining === 0) {
      voice.gain = voice.fadeTarget;
      if (voice.gain <= 0) voice.sounding = false;
      return;
    }
    voice.gain += voice.fadeStep;
  }

  /** @returns {object} a track's device parameters as a plain object. */
  function deviceParams(track) {
    const device = track && typeof track === "object" ? track.device : null;
    const params = device && typeof device.params === "object" && device.params ? device.params : null;
    return params || {};
  }

  /**
   * A track's gain in dB, clamped to the document's range; a missing or
   * non-finite value means 0 dB.
   * @param {object} track
   * @returns {number} -60..+12
   */
  function gainDbOf(track) {
    const value = Number(track && track.gain_db);
    return Number.isFinite(value) ? clamp(value, LOWEST_GAIN_DB, HIGHEST_GAIN_DB) : 0;
  }

  /**
   * A track's pan, -1 (left) .. 1 (right); a missing or non-finite value means
   * centre.
   * @param {object} track
   * @returns {number} -1..1
   */
  function panOf(track) {
    const value = Number(track && track.pan);
    return Number.isFinite(value) ? clamp(value, -1, 1) : 0;
  }

  /**
   * The SunVox note number for a MIDI pitch.
   * @param {number} pitch MIDI pitch, 0..127
   * @returns {number} a note number the library accepts, 1..127
   */
  function noteFor(pitch) {
    return clamp(Math.round(Number(pitch)) + MIDI_TO_NOTE, LOWEST_NOTE, HIGHEST_NOTE);
  }

  /**
   * The SunVox velocity for a song velocity (1..127).
   *
   * SunVox's velocity range is 1..129 where 0 means "the module's default", so
   * a full-velocity note is 129, not 127.
   * @param {number} velocity
   * @returns {number} 1..129
   */
  function sunvoxVelocity(velocity) {
    const scaled = Math.round((Number(velocity) / 127) * 128) + 1;
    return clamp(scaled, LOWEST_VELOCITY, HIGHEST_VELOCITY);
  }

  /**
   * UTF-8 bytes for a string.
   *
   * `TextEncoder` is not guaranteed in every worklet host (and the SunVox calls
   * below only ever need module and controller names), so this encodes by hand.
   * @param {string} text
   * @returns {Uint8Array}
   */
  function utf8Bytes(text) {
    const bytes = [];
    for (let at = 0; at < text.length; at += 1) {
      let code = text.charCodeAt(at);
      if (code >= 0xd800 && code <= 0xdbff && at + 1 < text.length) {
        const low = text.charCodeAt(at + 1);
        if (low >= 0xdc00 && low <= 0xdfff) {
          code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
          at += 1;
        }
      }
      if (code < 0x80) bytes.push(code);
      else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
      else if (code < 0x10000) {
        bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
      } else {
        bytes.push(
          0xf0 | (code >> 18),
          0x80 | ((code >> 12) & 0x3f),
          0x80 | ((code >> 6) & 0x3f),
          0x80 | (code & 0x3f),
        );
      }
    }
    return new Uint8Array(bytes);
  }

  /**
   * Bind the SunVox calls this processor makes to one Emscripten instance.
   *
   * The vendored loader cannot be used: its `sv_*` functions and its callback
   * and scope scratch pointers are module-scope globals, bound to the single
   * instance it opened for itself. Talking to the `_sv_*` exports directly
   * keeps every instance's buffers in its own heap, which is what makes one
   * engine per track possible at all.
   * @param {object} module the instance `SunVoxLib()` resolved to
   * @returns {object} the calls this processor uses, all bound to `module`
   */
  function bindEngine(module) {
    /** @returns {number} a malloc'd, NUL-terminated UTF-8 C string (0 on failure). */
    function cstring(text) {
      const bytes = utf8Bytes(String(text));
      const pointer = module._malloc(bytes.length + 1);
      if (!pointer) return 0;
      module.HEAPU8.set(bytes, pointer);
      module.HEAPU8[pointer + bytes.length] = 0;
      return pointer;
    }

    return {
      /** @param {number} bytes @returns {number} a wasm pointer, 0 on failure. */
      alloc: function alloc(bytes) {
        return module._malloc(bytes);
      },
      /** @param {number} pointer @returns {void} */
      free: function free(pointer) {
        if (pointer) module._free(pointer);
      },
      /** @returns {number} the library version, or a negative error. */
      init: function init(freq, channels, flags) {
        return module._sv_init(0, freq, channels, flags);
      },
      /** @returns {number} 0 on success. */
      deinit: function deinit() {
        return module._sv_deinit();
      },
      /** @returns {number} Hz */
      sampleRate: function sampleRate() {
        return module._sv_get_sample_rate();
      },
      openSlot: function openSlot(slot) {
        return module._sv_open_slot(slot);
      },
      closeSlot: function closeSlot(slot) {
        return module._sv_close_slot(slot);
      },
      lockSlot: function lockSlot(slot) {
        return module._sv_lock_slot(slot);
      },
      unlockSlot: function unlockSlot(slot) {
        return module._sv_unlock_slot(slot);
      },
      playFromBeginning: function playFromBeginning(slot) {
        return module._sv_play_from_beginning(slot);
      },
      volume: function volume(slot, value) {
        return module._sv_volume(slot, value);
      },
      setEventT: function setEventT(slot, set, time) {
        return module._sv_set_event_t(slot, set, time);
      },
      sendEvent: function sendEvent(slot, track, note, velocity, mod, ctl, ctlValue) {
        return module._sv_send_event(slot, track, note, velocity, mod, ctl, ctlValue);
      },
      newModule: function newModule(slot, type, name, x, y, z) {
        const typePointer = cstring(type);
        const namePointer = cstring(name);
        try {
          return module._sv_new_module(slot, typePointer, namePointer, x, y, z);
        } finally {
          module._free(typePointer);
          module._free(namePointer);
        }
      },
      removeModule: function removeModule(slot, mod) {
        return module._sv_remove_module(slot, mod);
      },
      connectModule: function connectModule(slot, source, destination) {
        return module._sv_connect_module(slot, source, destination);
      },
      ctlCount: function ctlCount(slot, mod) {
        return module._sv_get_number_of_module_ctls(slot, mod);
      },
      /** @returns {string} a controller's name, "" when the index has none. */
      ctlName: function ctlName(slot, mod, ctl) {
        const pointer = module._sv_get_module_ctl_name(slot, mod, ctl);
        return pointer ? module.UTF8ToString(pointer) : "";
      },
      setCtl: function setCtl(slot, mod, ctl, value, scaled) {
        return module._sv_set_module_ctl_value(slot, mod, ctl, value, scaled);
      },
      /**
       * Render `frames` of this engine's mix into a buffer it owns in wasm
       * memory and return a view of the interleaved stereo result.
       * @param {number} pointer the wasm pointer to render into
       * @param {number} frames
       * @param {number} latency
       * @param {number} outTime the engine's frame clock
       * @returns {Float32Array} `frames * 2` interleaved samples
       */
      render: function render(pointer, frames, latency, outTime) {
        module._sv_audio_callback(pointer, frames, latency, outTime);
        // Read the heap view after the call: a growing heap replaces it.
        const start = pointer >> 2;
        return module.HEAPF32.subarray(start, start + frames * 2);
      },
    };
  }

  /**
   * Call the vendored `SunVoxLib()` factory with the options a worklet needs.
   *
   * `globalThis.process` is hidden for the synchronous prologue of that call
   * only: it is what the glue's `ENVIRONMENT_IS_NODE` detection reads, and the
   * Node branch would reach for `require("fs")`/`__dirname`, which this scope
   * does not have. Everything after the factory's first `await` sees the real
   * `process` again, and no Node-only path is reachable anyway. A host with no
   * `process` at all (a browser worklet) needs none of this.
   *
   * When the processor has already compiled the binary, the factory is handed
   * a synchronous `instantiateWasm` so each track's engine instantiates from
   * that one compiled module instead of compiling the bytes again.
   * @param {{wasmBinary: ArrayBuffer|Uint8Array, wasmModule?: WebAssembly.Module}} options
   * @returns {Promise<object>} the Emscripten module instance
   */
  function callSunVoxFactory(options) {
    const settings = {
      wasmBinary: options.wasmBinary,
      locateFile: function locateFile() {
        return "";
      },
      print: function print() {},
      printErr: function printErr() {},
    };
    if (options.wasmModule && typeof WebAssembly === "object") {
      const compiled = options.wasmModule;
      settings.instantiateWasm = function instantiateWasm(imports, done) {
        const instance = new WebAssembly.Instance(compiled, imports);
        done(instance, compiled);
        return instance.exports;
      };
    }
    if (globalThis.process === undefined) return SunVoxLib(settings);
    const saved = globalThis.process;
    let promise;
    try {
      globalThis.process = undefined;
      promise = SunVoxLib(settings);
    } finally {
      globalThis.process = saved;
    }
    return promise;
  }

  /**
   * One AudioWorkletProcessor that hosts the engine for one song: one SunVox
   * engine per track, the pure sequencer, and the mix.
   */
  class StudioProcessor extends AudioWorkletProcessor {
    /**
     * @param {{processorOptions?: {wasmBinary?: ArrayBuffer|Uint8Array, testHooks?: boolean}}} options
     */
    constructor(options) {
      super();

      const processorOptions = (options && options.processorOptions) || {};

      /** Whether the engine runs and the client has been told. */
      this.ready = false;
      /** The first error that stopped the engine, for `process()`'s silence. */
      this.failure = null;
      /** Whether that failure has been reported already (it is reported once). */
      this.failureReported = false;
      /** Test hook: throw inside the next block (see `receive`). */
      this.failNextBlock = false;
      /** Whether the client asked for the test hooks; off unless asked for. */
      this.testHooks = processorOptions.testHooks === true;

      /** The pure sequencer for this host's sample rate. */
      this.sequencer = StudioSequencer.create({ sampleRate: sampleRate });

      /** Absolute frame of the next block, so `block()` calls stay contiguous. */
      this.frame = 0;

      /**
       * The context's frame counter minus this processor's own, measured at
       * the first block (`null` until then). See `contextOffset()`.
       */
      this.frameOffset = null;

      /** Frames accumulated since the last `position` message. */
      this.sincePosition = 0;
      this.positionEvery = Math.max(1, Math.round(sampleRate * POSITION_INTERVAL_SECONDS));

      /** track id → track index, rebuilt on every song. */
      this.trackSlots = new Map();

      /** track index → that track's record (engine, device module, mix gains). */
      this.slots = [];

      /** take id → its decoded PCM, one Float32Array per channel. */
      this.takes = new Map();

      /** Take ids already reported as not loaded, so each is reported once. */
      this.missingTakes = new Set();

      /**
       * sample id → `{channels, frames, bytes, lastUsed}`, the decoded PCM the
       * sampler pads play (at the context's rate; the client resampled it).
       */
      this.samples = new Map();

      /** How many bytes those samples hold together, against `MAX_SAMPLE_BYTES`. */
      this.sampleBytes = 0;

      /** A counter every trigger bumps, so the oldest sample is the least recently played. */
      this.sampleClock = 0;

      /** Sample ids already reported as not loaded, so each is reported once. */
      this.missingSamples = new Set();

      /**
       * The song's pads, slices and sample rates, flattened by `setSong`: the
       * key is the ref id `doc.js` uses (`padKey` / `sliceKey`).
       */
      this.pads = new Map();
      this.slices = new Map();
      this.sampleRates = new Map();

      /** A counter every sampler trigger bumps: the trigger order of the voices. */
      this.voiceSerial = 0;

      /** Whether the master is tapped (record-into-pad / resampling). */
      this.tapMaster = false;

      /** The track whose own output is tapped, or null. */
      this.tapTrackId = null;

      /** track index → its tap's stereo scratch, allocated only while a track is tapped. */
      this.tapIndex = -1;
      this.tapLeft = null;
      this.tapRight = null;

      /** Serialises the async slot work, so songs apply in arrival order. */
      this.queue = Promise.resolve();

      /** Messages that arrived before the engine was ready, in arrival order. */
      this.pending = [];

      /** The wasm bytes, and the module they compiled to once start() ran. */
      this.wasmBinary = null;
      this.wasmModule = null;

      this.port.onmessage = (event) => {
        const message = event && event.data;
        if (!message || typeof message !== "object") return;
        // A port delivers what was posted before the processor existed (a host
        // may construct it a moment after the node is built), so anything that
        // arrives before the wasm compiled waits its turn here and is replayed
        // in arrival order once the engine is up. That keeps a render that
        // posts its song and then waits for `ready` deterministic.
        if (!this.ready && !this.failure) {
          this.pending.push(message);
          return;
        }
        this.handle(message);
      };

      this.start(processorOptions.wasmBinary);
    }

    /**
     * Compile the wasm and tell the client. Failures are reported, never
     * thrown: a worklet that throws in its constructor would take the whole
     * audio thread down.
     * @param {ArrayBuffer|Uint8Array} wasmBinary
     * @returns {Promise<void>}
     */
    async start(wasmBinary) {
      try {
        if (!wasmBinary) throw new Error("no SunVox wasm binary was passed in processorOptions.wasmBinary");
        this.wasmBinary = wasmBinary instanceof Uint8Array ? wasmBinary : new Uint8Array(wasmBinary);
        // One compile for the whole processor: every track's engine
        // instantiates from this module, and a binary that will not compile is
        // reported as a start-up error instead of as unexplained silence.
        this.wasmModule = await WebAssembly.compile(this.wasmBinary);
        this.ready = true;
        this.port.postMessage({ type: "ready" });
        for (const message of this.pending) this.handle(message);
        this.pending.length = 0;
      } catch (error) {
        this.fail(error);
        this.pending.length = 0;
      }
    }

    /**
     * Handle one client message, reporting (never throwing) a fault inside it.
     * @param {object} message
     * @returns {void}
     */
    handle(message) {
      try {
        this.receive(message);
      } catch (error) {
        this.report(error);
      }
    }

    /**
     * One protocol message from the client.
     * @param {object} message
     * @returns {void}
     */
    receive(message) {
      if (!message || typeof message !== "object") return;
      switch (message.type) {
        case "song":
          this.setSong(message.snapshot);
          break;
        case "launchScene":
          this.sequencer.launchScene(message.id);
          break;
        case "launchClip":
          this.sequencer.launchClip(message.id);
          break;
        case "stopTrack":
          this.sequencer.stopTrack(message.id);
          break;
        case "stopAll":
          this.sequencer.stopAll();
          break;
        case "nextBarFrame": {
          // Answered from the sequencer's own clock, moved onto the context's:
          // the frame a recorder should arm at.
          const boundary = this.sequencer.nextBarFrame();
          this.port.postMessage({
            type: "nextBarFrame",
            id: message.id,
            frame: this.contextOffset() + boundary.frame,
            bar: boundary.bar,
          });
          break;
        }
        case "play":
          this.sequencer.play();
          break;
        case "stop":
          this.sequencer.stop();
          break;
        case "setMode":
          this.sequencer.setMode(message.mode);
          break;
        case "seek":
          this.sequencer.seek(message.bar);
          break;
        case "audio":
          this.loadTake(message.take_id, message.channels);
          break;
        case "audio_unload":
          this.takes.delete(asId(message.take_id));
          break;
        case "sample":
          this.loadSample(message.sample_id, message.channels);
          break;
        case "sample_unload":
          this.unloadSample(asId(message.sample_id));
          break;
        case "live":
          this.live(message);
          break;
        case "tap":
          this.setTap(message.target, message.on === true);
          break;
        case "flush":
          // Messages are handled in arrival order and slot work is queued, so
          // answering at the end of the queue proves every message posted
          // before the flush has been applied — engines built and all.
          this.enqueue(() => {
            this.port.postMessage({ type: "flushed", id: message.id });
          });
          break;
        case "__throw":
          // Test hook only: arm a throw inside process(), which is where a real
          // fault (a hostile song, an engine bug) would surface.
          if (this.testHooks) this.failNextBlock = true;
          break;
        default:
          break;
      }
    }

    /**
     * Queue async slot work, keeping arrival order and swallowing a fault (a
     * track that cannot be built must not stop the rest of the song).
     * @param {() => Promise<void>|void} task
     * @returns {void}
     */
    enqueue(task) {
      this.queue = this.queue.then(task).catch((error) => {
        this.report(error);
      });
    }

    /**
     * Store one take's PCM, already at the context's rate, and acknowledge it.
     * A take whose bytes arrive again simply replaces the old ones.
     * @param {string} takeId
     * @param {Float32Array[]|ArrayBufferView[]} channels
     * @returns {void}
     */
    loadTake(takeId, channels) {
      const id = asId(takeId);
      this.takes.set(id, readChannels(channels));
      // A take that arrived late is no longer missing, so it may be reported
      // again only if it goes away a second time.
      this.missingTakes.delete(id);
      this.port.postMessage({ type: "audio_loaded", take_id: id });
    }

    /**
     * Store one sample's PCM, already at the context's rate, and acknowledge it.
     *
     * The song may hold at most `MAX_SAMPLE_BYTES` of decoded samples at once.
     * A load that would go past that unloads the least-recently-triggered
     * samples first (a sample that has not been played since it loaded is the
     * first to go), and the client reloads one when a `sample_needed` says a
     * trigger wanted it.
     * @param {string} sampleId
     * @param {Float32Array[]|ArrayBufferView[]} channels
     * @returns {void}
     */
    loadSample(sampleId, channels) {
      const id = asId(sampleId);
      const list = readChannels(channels);
      let bytes = 0;
      for (const channel of list) bytes += channel.byteLength;
      const frames = list.length > 0 && list[0] ? list[0].length : 0;

      const previous = this.samples.get(id);
      if (previous) this.sampleBytes -= previous.bytes;
      this.sampleBytes += bytes;
      this.samples.set(id, {
        channels: list,
        frames: frames,
        bytes: bytes,
        lastUsed: (this.sampleClock += 1),
      });
      this.missingSamples.delete(id);

      this.trimSamples(id);
      this.port.postMessage({ type: "sample_loaded", sample_id: id });
    }

    /**
     * Drop one sample's PCM from the engine, freeing its bytes.
     * @param {string} sampleId
     * @returns {void}
     */
    unloadSample(sampleId) {
      const id = asId(sampleId);
      const held = this.samples.get(id);
      if (!held) return;
      this.sampleBytes -= held.bytes;
      this.samples.delete(id);
    }

    /**
     * Bring the loaded samples back under the song-wide cap by unloading the
     * least-recently-triggered ones. The sample that was just loaded is never a
     * candidate (a song that would need more than the whole cap for one sample
     * keeps it), so a load always leaves something to play.
     * @param {string} keepId the sample that must stay loaded
     * @returns {void}
     */
    trimSamples(keepId) {
      if (this.sampleBytes <= MAX_SAMPLE_BYTES) return;
      while (this.sampleBytes > MAX_SAMPLE_BYTES) {
        let victim = null;
        for (const [id, held] of this.samples) {
          if (id === keepId) continue;
          if (!victim || held.lastUsed < victim.held.lastUsed) victim = { id: id, held: held };
        }
        if (!victim) return;
        this.sampleBytes -= victim.held.bytes;
        this.samples.delete(victim.id);
      }
    }

    /**
     * Report a sample a trigger wanted but the client has not loaded, once per
     * sample id: a pad with no PCM plays silence, and a looping pattern would
     * otherwise say so on every pass. The `sample_needed` post is what lets the
     * client load it again (see the cap in `trimSamples`).
     * @param {string} sampleId
     * @returns {void}
     */
    reportMissingSample(sampleId) {
      const id = asId(sampleId);
      if (this.missingSamples.has(id)) return;
      this.missingSamples.add(id);
      this.port.postMessage({ type: "sample_needed", sample_id: id });
      this.report(new Error(missingSampleText(id)));
    }

    /**
     * Turn a tap on or off: `"master"` for the mix, or a track's id for that
     * track's own output. Off is the default and costs nothing.
     * @param {unknown} target
     * @param {boolean} on
     * @returns {void}
     */
    setTap(target, on) {
      const name = asId(target);
      if (on) {
        if (name === "master") this.tapMaster = true;
        else if (name !== "") this.tapTrackId = name;
      } else if (name === "master") {
        this.tapMaster = false;
      } else if (this.tapTrackId === name) {
        this.tapTrackId = null;
        this.tapIndex = -1;
      }
      if (this.tapTrackId === null) {
        this.tapIndex = -1;
        this.tapLeft = null;
        this.tapRight = null;
      }
    }

    /**
     * Take a new song: the sequencer reads it at once (so the transport calls
     * that follow are ordered against it), then the tracks' engines follow it.
     * @param {object} snapshot the song as `server/doc.js`'s `snapshot()` returns it
     * @returns {void}
     */
    setSong(snapshot) {
      if (!this.ready) return;
      const tracks = Array.isArray(snapshot && snapshot.tracks) ? snapshot.tracks : [];
      if (tracks.length > MAX_TRACKS) {
        throw new Error(`A song can have at most ${MAX_TRACKS} tracks.`);
      }
      this.readKit(snapshot);
      this.sequencer.setSong(snapshot);
      this.enqueue(() => this.syncSlots(tracks));
    }

    /**
     * Read the sampler's containers off the song into flat maps, so a pad
     * trigger is one lookup. A song written before the sampler existed has
     * none of them, and reads as an empty kit.
     * @param {object} snapshot the song as `server/doc.js`'s `snapshot()` returns it
     * @returns {void}
     */
    readKit(snapshot) {
      const snap = snapshot && typeof snapshot === "object" ? snapshot : {};
      this.pads = new Map();
      this.slices = new Map();
      this.sampleRates = new Map();

      const pads = snap.pads && typeof snap.pads === "object" ? snap.pads : {};
      for (const key of Object.keys(pads)) {
        const pad = pads[key];
        if (pad && typeof pad === "object") this.pads.set(key, pad);
      }
      const slices = snap.slices && typeof snap.slices === "object" ? snap.slices : {};
      for (const key of Object.keys(slices)) {
        const slice = slices[key];
        if (slice && typeof slice === "object") this.slices.set(key, slice);
      }
      const samples = snap.samples && typeof snap.samples === "object" ? snap.samples : {};
      for (const key of Object.keys(samples)) {
        const sample = samples[key];
        const rate = Number(sample && sample.rate);
        this.sampleRates.set(key, Number.isFinite(rate) && rate > 0 ? rate : sampleRate);
      }
    }

    /**
     * Make the tracks' engines match the song, in song order.
     *
     * A track keeps its engine and device as long as its id and device type are
     * unchanged — including a track whose device could NOT be built, which is
     * remembered as failed for that exact (track id, device type) and not
     * retried on every song update. Only a changed type (or id) retries.
     * @param {object[]} tracks the song's tracks, in song order
     * @returns {Promise<void>}
     */
    async syncSlots(tracks) {
      // Solo is a property of the whole song: any soloed track silences the rest.
      let anySolo = false;
      for (const track of tracks) {
        if (track && typeof track === "object" && track.solo === true) anySolo = true;
      }

      const previous = this.slots;
      const next = [];
      const trackSlots = new Map();

      for (let index = 0; index < tracks.length; index += 1) {
        const track = tracks[index] && typeof tracks[index] === "object" ? tracks[index] : {};
        const id = typeof track.id === "string" ? track.id : "";
        const audio = isAudioTrack(track);
        const sampler = !audio && isSamplerTrack(track);
        const type = audio ? AUDIO_ENGINE : sampler ? SAMPLER_ENGINE : deviceType(track);
        let record = previous[index];
        if (
          record &&
          (record.track_id !== id || record.type !== type || !!record.audio !== audio || !!record.sampler !== sampler)
        ) {
          this.teardown(record);
          record = null;
        }
        // Building an engine is the only await here; the old record is still in
        // `this.slots` (and so still in the mix) until the swap at the end.
        if (!record) {
          if (audio) record = this.buildAudioSlot(index, id);
          else if (sampler) record = this.buildSamplerSlot(index, id);
          else record = await this.buildSlot(index, id, type);
        }
        next.push(record);
        if (record.failed) continue;
        if (!record.audio && !record.sampler && !record.engine) continue;
        this.applyMix(record, track, anySolo);
        if (!record.audio && !record.sampler) this.applyParams(record, track);
        if (id !== "") trackSlots.set(id, index);
      }

      for (let index = tracks.length; index < previous.length; index += 1) {
        if (previous[index]) this.teardown(previous[index]);
      }

      this.slots = next;
      this.trackSlots = trackSlots;
    }

    /**
     * Build one audio track's slot: two PCM voices, no engine and no module.
     * Nothing here can fail, so it is synchronous — an audio track is playable
     * as soon as its song arrives.
     * @param {number} index the track's position in the song
     * @param {string} trackId
     * @returns {object} the track's record
     */
    buildAudioSlot(index, trackId) {
      return {
        index: index,
        track_id: trackId,
        type: AUDIO_ENGINE,
        audio: true,
        sampler: false,
        failed: false,
        engine: null,
        module: -1,
        outPtr: 0,
        frames: 0,
        clock: 0,
        ctlNames: null,
        paramsKey: null,
        left: 0,
        right: 0,
        voices: [newVoice(), newVoice()],
      };
    }

    /**
     * Build one sampler track's slot: a pool of `StudioSamplerVoice` records and
     * no engine. Nothing here can fail, so it is synchronous — a sampler track
     * is playable as soon as its song arrives.
     * @param {number} index the track's position in the song
     * @param {string} trackId
     * @returns {object} the track's record
     */
    buildSamplerSlot(index, trackId) {
      const voices = [];
      for (let at = 0; at < SAMPLER_VOICES_PER_TRACK; at += 1) voices.push(StudioSamplerVoice.create());
      return {
        index: index,
        track_id: trackId,
        type: SAMPLER_ENGINE,
        audio: false,
        sampler: true,
        failed: false,
        engine: null,
        module: -1,
        outPtr: 0,
        frames: 0,
        clock: 0,
        ctlNames: null,
        paramsKey: null,
        left: 0,
        right: 0,
        voices: voices,
        /** Stolen voices ringing out their 64-frame fade; empty until one is needed. */
        tails: [],
      };
    }

    /**
     * Build one track's engine: init, prime, open the slot, create the device
     * module and connect it to Output.
     * @param {number} index the track's position in the song
     * @param {string} trackId
     * @param {string} type the device's SunVox module type
     * @returns {Promise<object>} the track's record; `failed` is true when no
     *   device could be built
     */
    async buildSlot(index, trackId, type) {
      const record = {
        index: index,
        track_id: trackId,
        type: type,
        failed: true,
        engine: null,
        module: -1,
        outPtr: 0,
        frames: 0,
        clock: 0,
        ctlNames: null,
        paramsKey: null,
        left: 0,
        right: 0,
      };

      let engine = null;
      try {
        engine = await this.createEngine();
        const version = engine.init(sampleRate, 2, INIT_FLAGS);
        if (!(version >= 0)) throw new Error(`sv_init() failed with ${version}`);
        const engineRate = engine.sampleRate();
        if (engineRate !== sampleRate) {
          throw new Error(`the engine runs at ${engineRate} Hz, not the host's ${sampleRate} Hz`);
        }

        // Prime the callback buffer once, with the smallest block this engine
        // will ever be asked for and before its slot exists: the library sizes
        // its callback buffers from the first call, so no later sub-block can
        // make them grow on the audio thread.
        record.outPtr = engine.alloc(INITIAL_QUANTUM * 2 * 4);
        if (!record.outPtr) throw new Error("could not allocate the engine's block buffer");
        record.frames = INITIAL_QUANTUM;
        engine.render(record.outPtr, INITIAL_QUANTUM, 0, 0);
        record.clock = INITIAL_QUANTUM;

        if (engine.openSlot(SLOT) < 0) throw new Error(`could not open slot ${SLOT}`);
        // The engine's own volume stays at unity: every gain in Studio is the
        // JS mix's business (see the file header).
        engine.volume(SLOT, SLOT_VOLUME_UNITY);
        // There is no pattern data; this only keeps the slot's voices alive.
        engine.playFromBeginning(SLOT);

        let module = -1;
        engine.lockSlot(SLOT);
        try {
          if (this.testHooks && type === FAILING_DEVICE) {
            module = -1;
          } else {
            module = engine.newModule(SLOT, type, "device", 512, 512, 0);
            if (module < 0 && type !== FALLBACK_DEVICE) {
              this.report(new Error(`SunVox has no module type "${type}"; the track plays "${FALLBACK_DEVICE}".`));
              module = engine.newModule(SLOT, FALLBACK_DEVICE, "device", 512, 512, 0);
            }
            if (module >= 0 && engine.connectModule(SLOT, module, OUTPUT_MODULE) < 0) {
              // A device that cannot reach Output never sounds: drop it here,
              // inside the same lock its creation took (the vendor header
              // requires both module calls to run locked).
              engine.removeModule(SLOT, module);
              module = -1;
            }
          }
        } finally {
          engine.unlockSlot(SLOT);
        }

        if (module < 0) throw new Error(`could not build a "${type}" device for track ${trackId || index}`);
        // Live notes are timestamps "as quickly as possible", which is what
        // lets the sub-block split place an event on its own frame.
        engine.setEventT(SLOT, 1, 0);

        record.engine = engine;
        record.module = module;
        record.failed = false;
        return record;
      } catch (error) {
        this.report(error);
        if (engine) this.teardown(record, engine);
        return record;
      }
    }

    /**
     * Remove a record's device (locked, like its creation), free its block
     * buffer and deinit its engine. Safe to call on a half-built record.
     * @param {object} record
     * @param {object} [engine] the engine to use instead of `record.engine`
     * @returns {void}
     */
    teardown(record, engine) {
      if (record.voices) {
        for (const voice of record.voices) {
          voice.sounding = false;
          voice.channels = null;
        }
      }
      if (record.tails) {
        for (const tail of record.tails) {
          tail.sounding = false;
          tail.channels = null;
        }
      }
      const own = engine || record.engine;
      if (!own) return;
      try {
        if (record.module >= 0) {
          own.lockSlot(SLOT);
          try {
            own.removeModule(SLOT, record.module);
          } finally {
            own.unlockSlot(SLOT);
          }
        }
      } catch (error) {
        // The engine is going away; a failed removal has nothing left to clean.
        this.report(error);
      }
      record.module = -1;
      record.engine = null;
      try {
        if (record.outPtr) own.free(record.outPtr);
      } catch (error) {
        this.report(error);
      }
      record.outPtr = 0;
      record.frames = 0;
      try {
        own.deinit();
      } catch (error) {
        this.report(error);
      }
    }

    /**
     * @returns {Promise<object>} a freshly initialised engine, bound to its own
     *   wasm instance
     */
    async createEngine() {
      const instance = await callSunVoxFactory({
        wasmBinary: this.wasmBinary,
        wasmModule: this.wasmModule,
      });
      return bindEngine(instance);
    }

    /**
     * Write a track's device parameters, by controller name, whenever they
     * changed. Unknown names are ignored (a song carries names, not numbers).
     * @param {object} record
     * @param {object} track
     * @returns {void}
     */
    applyParams(record, track) {
      const params = deviceParams(track);
      let key;
      try {
        key = JSON.stringify(params);
      } catch {
        key = null;
      }
      if (key !== null && key === record.paramsKey) return;
      record.paramsKey = key;

      for (const name of Object.keys(params)) {
        const value = Number(params[name]);
        if (!Number.isFinite(value)) continue;
        const ctl = this.ctlIndex(record, name, -1);
        if (ctl < 0) continue;
        record.engine.setCtl(SLOT, record.module, ctl, Math.round(value), 1);
      }
    }

    /**
     * Cache a track's mix coefficients: its gain in dB as a linear factor, and
     * the constant-power pan pair.
     * @param {object} record
     * @param {object} track
     * @param {boolean} anySolo whether any track in the song is soloed
     * @returns {void}
     */
    applyMix(record, track, anySolo) {
      const muted = track.mute === true || (anySolo && track.solo !== true);
      const gain = muted ? 0 : Math.pow(10, gainDbOf(track) / 20);
      const theta = ((panOf(track) + 1) * Math.PI) / 4;
      record.left = gain * Math.cos(theta);
      record.right = gain * Math.sin(theta);
    }

    /**
     * The controller index of one module, by name.
     *
     * A module's names are read once per build and cached on the record.
     * @param {object} record
     * @param {string} name the controller's name as SunVox spells it
     * @param {number} fallback the index to assume when the name is missing
     * @returns {number} the controller index, or the fallback
     */
    ctlIndex(record, name, fallback) {
      if (!record.engine || record.module < 0) return fallback;
      let names = record.ctlNames;
      if (!names) {
        names = new Map();
        const count = record.engine.ctlCount(SLOT, record.module);
        for (let at = 0; at < count; at += 1) {
          const ctlName = record.engine.ctlName(SLOT, record.module, at);
          if (typeof ctlName !== "string" || ctlName === "") continue;
          if (!names.has(ctlName)) names.set(ctlName, at);
          const lower = ctlName.toLowerCase();
          if (!names.has(lower)) names.set(lower, at);
        }
        record.ctlNames = names;
      }
      const direct = names.get(name);
      if (direct !== undefined) return direct;
      const lower = names.get(name.toLowerCase());
      return lower === undefined ? fallback : lower;
    }

    /**
     * One block of audio. A throw here must never reach the host, so the work
     * is guarded: the first fault is reported once, the engine is marked failed
     * and every later block is silence, while `process()` keeps returning true.
     * @param {Float32Array[][]} inputs unused — the engine is a source
     * @param {Float32Array[][]} outputs `outputs[0]` holds the stereo pair
     * @returns {boolean} true, so the host keeps calling
     */
    process(inputs, outputs) {
      const output = outputs && outputs[0];
      const count = output && output.length > 0 ? output[0].length : 0;
      if (!output || count === 0) return true;

      // The context's clock is sampled here, at the top of the block, while
      // `this.frame` still is this block's first frame.
      this.contextOffset();

      const left = output[0];
      const right = output.length > 1 ? output[1] : null;
      // The block's first frame, taken before `block()` advances the counter.
      const firstFrame = this.frame;
      try {
        this.prepareTap(count);
        this.block(left, right, count);
        this.postTap(left, right, count, firstFrame);
      } catch (error) {
        this.fail(error);
        left.fill(0);
        if (right) right.fill(0);
      }
      return true;
    }

    /**
     * Zero the tapped track's scratch buffers at the start of a block, so what
     * `render()` accumulates is that block's own output and nothing else.
     * @param {number} count the frames this block holds
     * @returns {void}
     */
    prepareTap(count) {
      if (this.tapTrackId === null) {
        this.tapIndex = -1;
        return;
      }
      const index = this.trackSlots.get(this.tapTrackId);
      this.tapIndex = index === undefined ? -1 : index;
      if (this.tapIndex < 0) return;
      if (!this.tapLeft || this.tapLeft.length < count) {
        this.tapLeft = new Float32Array(count);
        this.tapRight = new Float32Array(count);
      }
      this.tapLeft.fill(0, 0, count);
      this.tapRight.fill(0, 0, count);
    }

    /**
     * Post a tap's copy of this block: the master (already mixed and clipped)
     * or the tapped track's own output. Nothing is posted while no tap is on.
     *
     * Every block names the CONTEXT frame its first sample sits on, so the
     * caller can cut what it keeps on the frame itself instead of counting.
     * @param {Float32Array} left the master's left channel
     * @param {Float32Array|null} right the master's right channel
     * @param {number} count the frames this block holds
     * @param {number} firstFrame this block's first frame, in the processor's own frames
     * @returns {void}
     */
    postTap(left, right, count, firstFrame) {
      // The block's first frame in the CONTEXT's clock, the same one `launched`
      // and `nextBarFrame` report in.
      const frame = this.contextOffset() + firstFrame;
      if (this.tapMaster) {
        const channels = right ? [left.slice(0, count), right.slice(0, count)] : [left.slice(0, count)];
        this.port.postMessage({ type: "tap_block", target: "master", frame: frame, channels: channels });
      }
      if (this.tapIndex >= 0 && this.tapLeft) {
        this.port.postMessage({
          type: "tap_block",
          target: this.tapTrackId,
          frame: frame,
          channels: [this.tapLeft.slice(0, count), this.tapRight.slice(0, count)],
        });
      }
    }

    /**
     * The block body: the sequencer's events, applied on their own frames.
     * @param {Float32Array} left
     * @param {Float32Array|null} right
     * @param {number} count the frames this block holds
     * @returns {void}
     */
    block(left, right, count) {
      if (this.failNextBlock) {
        this.failNextBlock = false;
        throw new Error("test hook: the processor was asked to fail inside process()");
      }

      // The host may reuse the buffers, so start from silence; the mix sums
      // into them from here.
      left.fill(0);
      if (right) right.fill(0);

      // The sequencer must see every block, ready or not: its events are
      // measured from contiguous frame starts.
      const events = this.sequencer.block(this.frame, count);
      this.reportLaunches(events.launches);

      if (!this.ready || this.failure) {
        this.frame += count;
        return;
      }

      let cursor = 0;
      let next = 0;
      while (cursor < count) {
        while (next < events.length && events[next].frame <= cursor) {
          this.applyEvent(events[next]);
          next += 1;
        }
        const boundary = next < events.length ? Math.min(count, events[next].frame) : count;
        const frames = boundary > cursor ? boundary - cursor : count - cursor;
        this.render(frames, left, right, cursor);
        cursor += frames;
      }

      this.frame += count;
      this.reportPosition(count);
    }

    /**
     * Render `frames` of every track, mix them with their gain and pan, and hard
     * clip at ±1.0 — 1a's whole master stage. An audio track contributes its
     * PCM voices here instead of a SunVox engine, through the very same mix.
     * @param {number} frames
     * @param {Float32Array} left
     * @param {Float32Array|null} right
     * @param {number} offset
     * @returns {void}
     */
    render(frames, left, right, offset) {
      const slots = this.slots;
      const tapped = this.tapIndex;
      for (let index = 0; index < slots.length; index += 1) {
        const record = slots[index];
        if (!record) continue;
        // A tapped track is rendered into its own scratch buffers first, at this
        // sub-run's own offset (a block is rendered in several runs, one per
        // event), and then added from there: the tap carries that track alone
        // and the master is the same sum with the tap on or off. Nothing is
        // copied while no track is tapped.
        if (index === tapped && this.tapLeft) {
          this.renderRecord(record, frames, this.tapLeft, this.tapRight, offset);
          for (let at = 0; at < frames; at += 1) {
            const position = offset + at;
            left[position] += this.tapLeft[position];
            if (right) right[position] += this.tapRight[position];
          }
          continue;
        }
        this.renderRecord(record, frames, left, right, offset);
      }

      for (let at = 0; at < frames; at += 1) {
        const position = offset + at;
        const sample = left[position];
        left[position] = sample > 1 ? 1 : sample < -1 ? -1 : sample;
        if (right) {
          const other = right[position];
          right[position] = other > 1 ? 1 : other < -1 ? -1 : other;
        }
      }
    }

    /**
     * Render one track's own output into a run of frames of a mix: whatever its
     * device is, through the very same track gain and pan.
     * @param {object} record
     * @param {number} frames
     * @param {Float32Array} left
     * @param {Float32Array|null} right
     * @param {number} offset
     * @returns {void}
     */
    renderRecord(record, frames, left, right, offset) {
      if (record.audio) {
        this.renderAudio(record, frames, left, right, offset);
        return;
      }
      if (record.sampler) {
        this.renderSampler(record, frames, left, right, offset);
        return;
      }
      if (!record.engine || record.module < 0) return;
      // Every engine is rendered every sub-block, muted or not: its voices
      // have to advance with the song, or a track would come back mid-note.
      const interleaved = record.engine.render(this.bufferFor(record, frames), frames, 0, record.clock);
      record.clock += frames;
      const gainLeft = record.left;
      const gainRight = record.right;
      if (gainLeft === 0 && gainRight === 0) return;
      for (let at = 0; at < frames; at += 1) {
        left[offset + at] += interleaved[at * 2] * gainLeft;
        if (right) right[offset + at] += interleaved[at * 2 + 1] * gainRight;
      }
    }

    /**
     * Mix one sampler track's voices over a run of frames, with the track's own
     * gain and pan — exactly what an engine's output gets. Every voice is
     * rendered even when the track is silent, so a muted track's pads come back
     * at the right point in their sound instead of mid-note.
     * @param {object} record
     * @param {number} frames
     * @param {Float32Array} left
     * @param {Float32Array|null} right
     * @param {number} offset
     * @returns {void}
     */
    renderSampler(record, frames, left, right, offset) {
      const gainLeft = record.left;
      const gainRight = record.right;
      this.renderVoiceList(record.voices, frames, left, right, offset, gainLeft, gainRight);
      // A stolen voice rings out in a fade tail for 64 frames after its slot was
      // taken (see `retireVoice`), through the very same mix.
      if (record.tails && record.tails.length > 0) {
        this.renderVoiceList(record.tails, frames, left, right, offset, gainLeft, gainRight);
      }
    }

    /**
     * Mix one list of sampler voices over a run of frames, with the track's own
     * gain and pan.
     * @param {object[]} voices
     * @param {number} frames
     * @param {Float32Array} left
     * @param {Float32Array|null} right
     * @param {number} offset
     * @param {number} gainLeft
     * @param {number} gainRight
     * @returns {void}
     */
    renderVoiceList(voices, frames, left, right, offset, gainLeft, gainRight) {
      for (let at = 0; at < voices.length; at += 1) {
        const voice = voices[at];
        if (!voice.sounding) continue;
        StudioSamplerVoice.render(voice, frames, gainLeft === 0 ? null : left, gainRight === 0 ? null : right, offset, gainLeft, gainRight);
      }
    }

    /**
     * Mix one audio track's voices over a run of frames: each sounding voice
     * reads its take at its own position (which may still be negative, a short
     * silence before the take begins), scaled by its fade envelope and then by
     * the track's gain and pan — the very same mix the engines get.
     * @param {object} record
     * @param {number} frames
     * @param {Float32Array} left
     * @param {Float32Array|null} right
     * @param {number} offset
     * @returns {void}
     */
    renderAudio(record, frames, left, right, offset) {
      const voices = record.voices;
      const gainLeft = record.left;
      const gainRight = record.right;
      for (let at = 0; at < voices.length; at += 1) {
        const voice = voices[at];
        if (!voice.sounding) continue;
        const channels = voice.channels;
        const length = channels && channels[0] ? channels[0].length : 0;
        const mono = !channels || channels.length < 2;
        for (let frame = 0; frame < frames; frame += 1) {
          const gain = voice.gain * fadeGainOf(voice);
          const position = voice.position;
          voice.position = position + 1;
          if (position >= 0 && position < length) {
            const sample = channels[0][position];
            if (gainLeft !== 0) left[offset + frame] += sample * gain * gainLeft;
            if (right && gainRight !== 0) {
              right[offset + frame] += (mono ? sample : channels[1][position]) * gain * gainRight;
            }
          }
          advanceFade(voice);
          advanceVoiceFade(voice);
        }
        if (!voice.sounding || voice.position >= length) {
          voice.sounding = false;
          voice.channels = null;
        }
      }
    }

    /**
     * The wasm buffer one track renders into, allocated at the smallest block
     * size and grown only if a host asks for a bigger one.
     * @param {object} record
     * @param {number} frames
     * @returns {number} the wasm pointer
     */
    bufferFor(record, frames) {
      if (record.outPtr && record.frames >= frames) return record.outPtr;
      const size = Math.max(frames, INITIAL_QUANTUM);
      if (record.outPtr) record.engine.free(record.outPtr);
      record.outPtr = record.engine.alloc(size * 2 * 4);
      record.frames = size;
      if (!record.outPtr) throw new Error("could not grow the engine's block buffer");
      return record.outPtr;
    }

    /**
     * Apply one sequencer event at the cursor: an audio start or stop goes to
     * its track's voices, a note on or off to its track's engine.
     * @param {{frame: number, type: string}} event
     * @returns {void}
     */
    applyEvent(event) {
      if (event.type === "audio") this.startVoice(event);
      else if (event.type === "audio_stop") this.stopVoice(event);
      else if (event.type === "fade") this.startFade(event);
      else if (event.type === "pad") this.startPad(event, false);
      else this.sendNote(event);
    }

    /**
     * @param {string} trackId
     * @returns {object|null} the sampler record one track's slot holds
     */
    samplerRecord(trackId) {
      const index = this.trackSlots.get(trackId);
      if (index === undefined) return null;
      const record = this.slots[index];
      return record && record.sampler ? record : null;
    }

    /**
     * Start one pad's voice: a pattern step (`live` false) or a live press.
     *
     * The pad comes from the song's `pads` container and its sample from the
     * sample store; a step's `locks` then override the pad's own fields for this
     * one voice. A pad with no sample is silence and is not a fault; a pad whose
     * sample the client has not loaded is silence and is reported once.
     *
     * A step gives a `gate` pad its `gate_frames` to release at. A live press has
     * no step, so it holds until `liveRelease` for a `gate` pad and plays to the
     * end of its range for a `oneshot` one.
     *
     * Every one of the pad's own fields can be locked for this one voice, and
     * they all go through the same `field()` lookup: `attack_ms`, `decay_ms`,
     * `sustain`, `release_ms`, `pitch`, `gain_db`, `pan`, `reverse`,
     * `cutoff_hz`, `resonance`, and the filter's kind under `filter_type` (the
     * document spells the pad's own one `filter.type`).
     * @param {{track_id: string, bank_id: string, index: number, v: number,
     *          locks?: object, gate_frames?: number}} event
     * @param {boolean} live whether this is a live press rather than a step
     * @returns {void}
     */
    startPad(event, live) {
      const record = this.samplerRecord(event.track_id);
      if (!record) return;
      const bankId = asId(event.bank_id);
      const index = Math.trunc(Number(event.index) || 0);
      const pad = this.pads.get(padKey(event.track_id, bankId, index));
      if (!pad) return;

      const sampleId = asId(pad.sample_id);
      if (sampleId === "") return;
      const stored = this.samples.get(sampleId);
      if (!stored || stored.frames === 0) {
        this.reportMissingSample(sampleId);
        return;
      }

      const locks = event.locks && typeof event.locks === "object" ? event.locks : null;
      const field = (name, fallback) => (locks && locks[name] !== undefined ? locks[name] : fallback);

      const range = this.padRange(pad, stored);
      // An empty range plays nothing, so it must not take (and so steal) a
      // voice: the check is made here, before a slot is chosen, so a start that
      // cannot succeed leaves every sounding voice alone.
      if (!(range.end > range.start)) return;

      stored.lastUsed = this.sampleClock += 1;
      const mode = typeof pad.mode === "string" ? pad.mode : "oneshot";
      const gateFrames = mode === "gate" && !live ? Number(event.gate_frames) : NaN;
      const filter = pad.filter && typeof pad.filter === "object" ? pad.filter : {};
      const filterType = field("filter_type", filter.type);

      const voice = this.takeVoice(record);
      const started = StudioSamplerVoice.start(voice, {
        channels: stored.channels,
        frames: stored.frames,
        start: range.start,
        end: range.end,
        reverse: field("reverse", pad.reverse === true) === true,
        pitch: field("pitch", pad.pitch),
        gainDb: field("gain_db", pad.gain_db),
        velocity: event.v,
        pan: field("pan", pad.pan),
        attackMs: field("attack_ms", pad.attack_ms),
        decayMs: field("decay_ms", pad.decay_ms),
        sustain: field("sustain", pad.sustain),
        releaseMs: field("release_ms", pad.release_ms),
        filterType: typeof filterType === "string" ? filterType : "off",
        cutoffHz: field("cutoff_hz", filter.cutoff_hz),
        resonance: field("resonance", filter.resonance),
        gateFrames: Number.isFinite(gateFrames) ? gateFrames : -1,
        choke: pad.choke,
        mode: mode,
        trackId: asId(event.track_id),
        bankId: bankId,
        index: index,
        serial: (this.voiceSerial += 1),
        sampleRate: sampleRate,
      });
      if (!started) return;

      // A new voice in choke group n cuts every other voice of that group on
      // this track, over the crossfade length.
      const choke = Math.trunc(Number(pad.choke) || 0);
      if (choke > 0) {
        for (const other of record.voices) {
          if (other === voice) continue;
          if (!other.sounding || other.choke !== choke) continue;
          StudioSamplerVoice.beginFadeOut(other);
        }
      }

      this.stealSongWide(voice);
    }

    /**
     * The frames a pad plays inside one loaded sample: its slice when it names
     * one, the whole sample otherwise. A slice's frames are in the sample's own
     * rate (the document's), while the PCM here is at the context's rate, so
     * they are scaled by the ratio of the two.
     * @param {object} pad
     * @param {{frames: number}} stored
     * @returns {{start: number, end: number}}
     */
    padRange(pad, stored) {
      const sampleId = asId(pad.sample_id);
      const sliceId = asId(pad.slice_id);
      if (sliceId === "") return { start: 0, end: stored.frames };
      const slice = this.slices.get(sliceKey(sampleId, sliceId));
      if (!slice) return { start: 0, end: stored.frames };

      const docRate = this.sampleRates.get(sampleId) || sampleRate;
      const scale = sampleRate / docRate;
      const start = Math.max(0, Math.min(stored.frames, Math.trunc(Math.round(Number(slice.start_frame) * scale))));
      const end = Math.max(start, Math.min(stored.frames, Math.trunc(Math.round(Number(slice.end_frame) * scale))));
      return { start: start, end: end };
    }

    /**
     * Pick the voice a new trigger uses: a free one, else this track's oldest —
     * a voice that is already fading out (choked or releasing) goes first.
     *
     * The caller starts the new voice, and has already checked that its range
     * holds frames, so a steal never costs a sounding voice to a start that
     * could not happen.
     * @param {object} record
     * @returns {object} the voice record to overwrite
     */
    takeVoice(record) {
      const voices = record.voices;
      let oldest = voices[0];
      for (const voice of voices) {
        if (!voice.sounding) return voice;
        if (this.stealRank(voice) < this.stealRank(oldest)) oldest = voice;
      }
      this.retireVoice(record, oldest);
      return oldest;
    }

    /**
     * Move a stolen voice into a fade tail so it rings out over 64 frames
     * instead of clicking off, or cut it when both tails already ring.
     *
     * The choice, documented: the 16 slots belong to the 16 sounding voices and
     * the new voice needs this one on its very frame, so a stolen voice cannot
     * keep its slot. It keeps sounding in a fade tail when one is free (the
     * 64-frame ring-out) and is cut when both are in use.
     * @param {object} record
     * @param {object} voice the slot the new voice is about to take
     * @returns {void}
     */
    retireVoice(record, voice) {
      if (!voice.sounding) return;
      const tail = this.tailFor(record);
      if (!tail) return;
      Object.assign(tail, voice);
      // It holds its last sample and fades out: there is nothing left to read.
      tail.ending = true;
      tail.gateRemaining = -1;
      tail.fadeRemaining = StudioSamplerVoice.FADE_FRAMES;
      tail.sounding = true;
    }

    /**
     * @param {object} record
     * @returns {object|null} a tail voice that is free, or a new one while the
     *   track holds fewer than `STOLEN_TAILS_PER_TRACK`; null when none is
     */
    tailFor(record) {
      const tails = record.tails;
      if (!tails) return null;
      for (const tail of tails) if (!tail.sounding) return tail;
      if (tails.length >= STOLEN_TAILS_PER_TRACK) return null;
      const tail = StudioSamplerVoice.create();
      tails.push(tail);
      return tail;
    }

    /**
     * How good a steal candidate a voice is: the lower the value, the sooner it
     * goes. A voice already fading out is never heard again in any case, so it
     * goes before a held one; within a class the oldest goes first.
     * @param {object} voice
     * @returns {number}
     */
    stealRank(voice) {
      const fading = voice.fadeRemaining > 0 || voice.stage === StudioSamplerVoice.STAGE_RELEASE;
      return (fading ? 0 : 1) * 1000000000 + voice.serial;
    }

    /**
     * Keep the whole song inside its 64-voice cap: while too many voices sound,
     * the song's best steal candidate goes — across tracks, choked and releasing
     * ones first, then the oldest anywhere. A cross-track steal cuts rather than
     * fading: the cap is the song's DSP budget, so the frame that trips it plays
     * exactly the surviving voices and nothing else.
     * @param {object} newest the voice this trigger just started (never stolen)
     * @returns {void}
     */
    stealSongWide(newest) {
      let sounding = 0;
      for (const record of this.slots) {
        if (!record || !record.sampler) continue;
        for (const voice of record.voices) if (voice.sounding) sounding += 1;
      }
      while (sounding > SAMPLER_VOICES_SONG_WIDE) {
        let victim = null;
        for (const record of this.slots) {
          if (!record || !record.sampler) continue;
          for (const voice of record.voices) {
            if (!voice.sounding || voice === newest) continue;
            if (!victim || this.stealRank(voice) < this.stealRank(victim)) victim = voice;
          }
        }
        if (!victim) return;
        victim.sounding = false;
        victim.channels = null;
        sounding -= 1;
      }
    }

    /**
     * A live pad message: a press starts the pad's voice (never through
     * history, never quantized), a release lets the `gate` voices that pad
     * started go. A `oneshot` pad keeps playing to the end of its range: letting
     * go of the key does not cut a one-shot sound short.
     * @param {{track_id: string, bank_id: string, index: number, v: number, on: boolean}} event
     * @returns {void}
     */
    live(event) {
      if (event.on !== false) {
        this.startPad(event, true);
        return;
      }
      const record = this.samplerRecord(asId(event.track_id));
      if (!record) return;
      const bankId = asId(event.bank_id);
      const index = Math.trunc(Number(event.index) || 0);
      for (const voice of record.voices) {
        if (!voice.sounding) continue;
        if (voice.mode !== "gate") continue;
        if (voice.bankId !== bankId || voice.index !== index) continue;
        StudioSamplerVoice.release(voice);
      }
    }

    /**
     * Start a take on one of an audio track's voices. When the other voice is
     * still sounding the two crossfade (see the file header); a take that has
     * not been loaded plays silence and is reported once.
     * @param {{track_id: string, take_id: string, take_frame: number, voice: number}} event
     * @returns {void}
     */
    startVoice(event) {
      const record = this.audioRecord(event.track_id);
      if (!record) return;
      const index = event.voice === 1 ? 1 : 0;
      const voice = record.voices[index];
      if (!voice) return;

      const channels = this.takes.get(asId(event.take_id));
      if (!channels || channels.length === 0 || !channels[0] || channels[0].length === 0) {
        this.reportMissingTake(event.take_id);
        return;
      }

      const frame = Number(event.take_frame);
      voice.channels = channels;
      voice.position = Number.isFinite(frame) ? Math.trunc(frame) : 0;
      voice.sounding = true;
      // A start begins a clean envelope: a fade belongs to the voice its own
      // placement started.
      voice.fade = null;

      const other = record.voices[index === 0 ? 1 : 0];
      if (other && other.sounding && other.gain > 0) {
        voice.gain = 0;
        beginFade(voice, 1);
        beginFadeOut(other);
      } else {
        voice.gain = 1;
        voice.fadeRemaining = 0;
        voice.fadeTarget = 1;
      }
    }

    /**
     * Send one audio voice out over the crossfade length.
     * @param {{track_id: string, voice: number}} event
     * @returns {void}
     */
    stopVoice(event) {
      const record = this.audioRecord(event.track_id);
      if (!record) return;
      const voice = record.voices[event.voice === 1 ? 1 : 0];
      if (!voice) return;
      beginFadeOut(voice);
    }

    /**
     * Start a placement's linear gain ramp on one voice.
     *
     * The ramp is counted in frames from this very frame, so it is the same
     * whatever block size the host asks for. A voice that is not sounding has
     * nothing to ramp — the event is ignored, which is right: a fade that runs
     * over silence leaves the voice at its end value by the time it is heard.
     * @param {{track_id: string, voice: number, from: number, to: number, frames: number}} event
     * @returns {void}
     */
    startFade(event) {
      const record = this.audioRecord(event.track_id);
      if (!record) return;
      const voice = record.voices[event.voice === 1 ? 1 : 0];
      if (!voice || !voice.sounding) return;
      const frames = Math.round(Number(event.frames));
      const from = Number(event.from);
      const to = Number(event.to);
      if (!Number.isFinite(frames) || frames <= 0) return;
      if (!Number.isFinite(from) || !Number.isFinite(to)) return;
      voice.fade = { from: from, to: to, frames: frames, index: 0 };
    }

    /**
     * @param {string} trackId
     * @returns {object|null} the audio record one track's slot holds
     */
    audioRecord(trackId) {
      const index = this.trackSlots.get(trackId);
      if (index === undefined) return null;
      const record = this.slots[index];
      return record && record.audio ? record : null;
    }

    /**
     * Report a take the song plays but the client has not loaded yet, once per
     * take id: a voice with no PCM is silence, and a clip that loops would
     * otherwise say so on every pass.
     * @param {string} takeId
     * @returns {void}
     */
    reportMissingTake(takeId) {
      const id = asId(takeId);
      if (this.missingTakes.has(id)) return;
      this.missingTakes.add(id);
      this.report(new Error(`Take ${id} is not loaded yet.`));
    }

    /**
     * Send one sequencer event to its track's device.
     * @param {{track_id: string, type: string, p: number, v: number}} event
     * @returns {void}
     */
    sendNote(event) {
      const index = this.trackSlots.get(event.track_id);
      if (index === undefined) return;
      const record = this.slots[index];
      if (!record || !record.engine || record.module < 0) return;
      const module = record.module + 1;
      if (event.type === "on") {
        record.engine.sendEvent(SLOT, 0, noteFor(event.p), sunvoxVelocity(event.v), module, 0, 0);
      } else {
        record.engine.sendEvent(SLOT, 0, NOTECMD_NOTE_OFF, 0, module, 0, 0);
      }
    }

    /**
     * Post every launch the sequencer applied in this block, in context frames.
     *
     * The sequencer reports a launch with the offset of its boundary inside the
     * block; the frame the client gets is the context's, so a recorder on the
     * same AudioContext can arm on the very frame the launch took effect.
     * @param {Array<object>|undefined} launches the block's launch reports
     * @returns {void}
     */
    reportLaunches(launches) {
      if (!launches || launches.length === 0) return;
      const base = this.contextOffset() + this.frame;
      for (let at = 0; at < launches.length; at += 1) {
        const launch = launches[at];
        this.port.postMessage({
          type: "launched",
          track_id: launch.track_id,
          clip_id: launch.clip_id,
          scene_id: launch.scene_id,
          bar: launch.bar,
          frame: base + launch.frame,
        });
      }
    }

    /**
     * The offset from this processor's frames to the context's.
     *
     * Measured once, at the first block, from the shared `currentFrame` global
     * minus this processor's own `frame`: both counters advance block by block
     * at the same rate, so the difference is constant. It is not re-measured on
     * every block because a host may not advance that global at all
     * (node-web-audio-api keeps it at 0), and re-measuring would drift further
     * away with every block.
     *
     * A host without the global leaves the offset at 0: every frame reported
     * then is this processor's own `this.frame` plus the block offset, which is
     * still one consistent clock.
     * @returns {number}
     */
    contextOffset() {
      if (this.frameOffset === null) {
        const now = contextFrameNow();
        this.frameOffset = now === null ? 0 : now - this.frame;
      }
      return this.frameOffset;
    }

    /**
     * Post the transport position, at most every 50 ms of audio.
     * @param {number} frames the frames the block held
     * @returns {void}
     */
    reportPosition(frames) {
      this.sincePosition += frames;
      if (this.sincePosition < this.positionEvery) return;
      this.sincePosition = 0;
      const position = this.sequencer.position();
      this.port.postMessage({
        type: "position",
        bar: position.bar,
        beat: position.beat,
        sixteenth: position.sixteenth,
      });
    }

    /**
     * Report a failure to the client as a string it can log or throw.
     * @param {unknown} error
     * @returns {void}
     */
    report(error) {
      const text = error && error.message ? error.message : String(error);
      this.port.postMessage({ type: "error", error: text });
    }

    /**
     * Stop the engine: report the fault once and go silent from here on.
     * @param {unknown} error
     * @returns {void}
     */
    fail(error) {
      if (!this.failure) this.failure = error;
      if (this.failureReported) return;
      this.failureReported = true;
      this.report(error);
    }
  }

  registerProcessor(PROCESSOR_NAME, StudioProcessor);
})();