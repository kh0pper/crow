/**
 * Studio engine worklet processor — the SunVox host.
 *
 * `engine-client.js` concatenates four files into ONE module and loads it with
 * `audioWorklet.addModule()`:
 *
 *     sequencer.js + sunvox.js + sunvox_lib_loader.js + studio-processor.js
 *
 * so this file shares a module scope with the vendored SunVox glue (which
 * declares `SunVoxLib`, `svlib`, the `sv_*` functions, `SV_INIT_FLAG_*` and
 * `NOTECMD_NOTE_OFF`) and with the pure sequencer (`StudioSequencer` on
 * `globalThis`). Nothing here is imported: the same source runs in a browser's
 * `AudioWorkletGlobalScope` and in node-web-audio-api's worklet thread.
 *
 * ## One engine, one slot per track
 *
 * One `sv_init()` per processor, then one SunVox slot per track position
 * (0..15). Inside a slot the track's device module feeds a mixer module which
 * feeds SunVox's Output (module 0). Notes arrive as `sv_send_event()` calls,
 * not as pattern data, so the sequencer stays the single authority on *what*
 * sounds and *when*.
 *
 * ## What this was measured against (vendored 2.1.4d WASM build)
 *
 * Facts the code below depends on, all verified against `sv_get_log()`-quiet
 * renders before the tests were written:
 *
 * - **`sv_audio_callback()` mixes every open slot into one stereo buffer.**
 *   There is no per-slot output in the library, so "render each slot and sum
 *   in the worklet" is impossible: per-track gain and pan have to happen
 *   inside SunVox. Each slot therefore carries an `Amplifier` (Volume +
 *   Balance), and this processor's only master stage is the hard clip at
 *   ±1.0. The Amplifier's laws were measured: Volume is linear with 256 =
 *   unity (0..1024, i.e. +12 dB of headroom), and Balance 0..256 puts the far
 *   channel at `balance/128` of the near one. Setting
 *   `Volume = 256 * gain * max(L, R)` and `Balance` from `min(L, R) / max(L, R)`
 *   with `L = cos(θ), R = sin(θ), θ = (pan + 1)π/4` therefore reproduces the
 *   constant-power pan and per-track dB gain exactly (up to integer
 *   quantisation of the two controllers).
 * - **`out_time` must advance.** With `out_time` stuck at 0 the library
 *   returns silence for every callback. This file keeps its own deterministic
 *   clock (`this.clock`, advanced by the frames rendered) rather than
 *   `sv_get_ticks()`, which is wall-clock time and would make two hosts
 *   disagree.
 * - **`sv_set_event_t(slot, 1, 0)` is required for live notes.** With the
 *   default "automatic" event timestamps a note sent by `sv_send_event()` can
 *   land far ahead of the audio we ask for and never sound; pinning the
 *   timestamp to 0 means "process as quickly as possible", i.e. at the start
 *   of the next callback, which is exactly what the sub-block split below
 *   needs to place an event on its own frame.
 * - **Note numbers are 11 semitones below the library's own pitch base.** A
 *   note sent as `nn` sounds at `16.333984375 * 2^((nn + 11) / 12)` Hz, so
 *   MIDI 60 (261.63 Hz) is SunVox note 37, i.e. `nn = p - 23`, and the lowest
 *   playable pitch is MIDI 24 (note 1, 32.7 Hz) — lower pitches are clamped.
 *   The pitch test in `tests/studio-engine.test.js` pins this.
 * - **The default slot volume is 80/256**, so every slot is opened at 256
 *   (100 %) and gain lives on the slot's Amplifier alone.
 * - **`sv_new_module()` / `sv_connect_module()` / `sv_remove_module()` need
 *   the slot lock** (`USE LOCK/UNLOCK!` in the vendor header).
 *
 * The vendored glue is not edited. Its loader starts an engine instance of its
 * own as it is evaluated (`var svlib = SunVoxLib()` with no options), which
 * cannot find the wasm binary in a worklet scope; `startSunVoxEngine()` below
 * lets that promise settle harmlessly and replaces `svlib` with the real one.
 *
 * ## Environment: the glue is told it is not Node
 *
 * `sunvox.js` detects its host at the top of the factory:
 * `ENVIRONMENT_IS_NODE = globalThis.process?.versions?.node && …`. Inside
 * node-web-audio-api's worklet thread that is true (it is a real Node worker
 * thread), and the Node branch then reaches for `require("fs")` and
 * `__dirname`, neither of which exists in an ES module in that scope. The
 * branch we want is the "no host" one (`readAsync`/`readBinary` stay
 * undefined), which works because `Module.wasmBinary` is supplied: the glue
 * never fetches. So the factory is called with `globalThis.process` shadowed
 * for the synchronous prologue in which the detection runs, and restored in a
 * `finally` before the factory's first `await`.
 *
 * ## Block splitting
 *
 * `process()` is handed 128 frames. The sequencer's events for the block are
 * applied at their own frame: the block is rendered in runs, `sv_send_event()`
 * for every event at the cursor, then one `sv_audio_callback()` covering the
 * frames up to the next event. Nothing is allocated per block.
 *
 * ## Messages
 *
 * client → processor: `{type:"song", snapshot}`, `{type:"launchScene", id}`,
 * `{type:"launchClip", id}`, `{type:"stopTrack", id}`, `{type:"stopAll"}`,
 * `{type:"play"}`, `{type:"stop"}`
 * processor → client: `{type:"ready"}`, `{type:"position", bar, beat,
 * sixteenth}` (at most every 50 ms of audio), `{type:"error", error}`
 *
 * ## Parity
 *
 * No Web Audio node shapes sound anywhere in Studio: this processor's output
 * is the engine's mix, hard-clipped, and `engine.node` goes straight to the
 * destination. Two hosts that feed the same song the same number of frames get
 * the same bytes.
 */
(function () {
  "use strict";

  /** The name this file registers, and the name engine-client constructs. */
  const PROCESSOR_NAME = "studio-processor";

  /** A song holds at most this many SunVox tracks (one slot each). */
  const MAX_TRACKS = 16;

  /** The module used for a track whose device names none, or an unknown one. */
  const FALLBACK_DEVICE = "Analog generator";

  /** The mixer module every track's device is routed through (gain + pan). */
  const MIX_MODULE = "Amplifier";

  /** The mixer controller holding the track's gain, and the one holding its pan. */
  const MIX_VOLUME_CTL = "Volume";
  const MIX_BALANCE_CTL = "Balance";

  /** MIDI pitch → SunVox note number (see the header: MIDI 60 is note 37). */
  const MIDI_TO_NOTE = -23;

  /** The lowest and highest note number the library accepts. */
  const LOWEST_NOTE = 1;
  const HIGHEST_NOTE = 127;

  /** Velocity is `1..129` in SunVox; 0 means "the module's default". */
  const LOWEST_VELOCITY = 1;
  const HIGHEST_VELOCITY = 129;

  /** A track's gain is held between these, in dB (mute is not a gain). */
  const LOWEST_GAIN_DB = -96;
  const HIGHEST_GAIN_DB = 24;

  /** The Amplifier's Volume controller runs 0..1024 with 256 = unity. */
  const MIX_UNITY = 256;
  const MIX_VOLUME_MAX = 1024;

  /** The Amplifier's Balance controller runs 0..256 with 128 = centre. */
  const MIX_BALANCE_CENTRE = 128;
  const MIX_BALANCE_MAX = 256;

  /** How much audio between two `position` messages, in seconds. */
  const POSITION_INTERVAL_SECONDS = 0.05;

  /** The smallest block this processor preallocates buffers for. */
  const INITIAL_QUANTUM = 128;

  /** @returns {number} the value held between two bounds. */
  function clamp(value, low, high) {
    if (!Number.isFinite(value)) return low;
    if (value < low) return low;
    if (value > high) return high;
    return value;
  }

  /** @returns {string} the module type a track's device names. */
  function deviceType(track) {
    const device = track && typeof track === "object" ? track.device : null;
    const type = device && typeof device.type === "string" ? device.type.trim() : "";
    return type === "" ? FALLBACK_DEVICE : type;
  }

  /** @returns {object} a track's device parameters as a plain object. */
  function deviceParams(track) {
    const device = track && typeof track === "object" ? track.device : null;
    const params = device && typeof device.params === "object" && device.params ? device.params : null;
    return params || {};
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
   * The two mixer controller values that give one track its gain and pan.
   *
   * The pan is constant-power — `L = cos(θ)`, `R = sin(θ)` with
   * `θ = (pan + 1)π/4` — and the mixer applies it as "near channel at Volume,
   * far channel at Volume × Balance / 128", so the pair below reproduces the
   * law exactly.
   * @param {{gain_db?: number, pan?: number, mute?: boolean}} track
   * @returns {{volume: number, balance: number}} integers for the mixer's
   *   Volume (0..1024, 256 = unity) and Balance (0..256, 128 = centre)
   */
  function mixFor(track) {
    if (track && track.mute === true) return { volume: 0, balance: MIX_BALANCE_CENTRE };
    const gain = Math.pow(10, clamp(Number(track && track.gain_db), LOWEST_GAIN_DB, HIGHEST_GAIN_DB) / 20);
    const pan = clamp(Number(track && track.pan), -1, 1);
    const theta = ((pan + 1) * Math.PI) / 4;
    const left = Math.cos(theta);
    const right = Math.sin(theta);
    const near = Math.max(left, right);
    const far = Math.min(left, right);
    const volume = clamp(Math.round(MIX_UNITY * gain * near), 0, MIX_VOLUME_MAX);
    const ratio = near > 0 ? far / near : 0;
    const balance =
      left >= right
        ? Math.round(MIX_BALANCE_CENTRE * ratio)
        : MIX_BALANCE_MAX - Math.round(MIX_BALANCE_CENTRE * ratio);
    return { volume: volume, balance: clamp(balance, 0, MIX_BALANCE_MAX) };
  }

  /**
   * Start SunVox with a wasm binary, replacing the instance the vendored loader
   * opened while it was being evaluated.
   *
   * The loader does `var svlib = SunVoxLib()` at evaluation time, with no
   * options: in a worklet there is nothing for the glue to fetch the binary
   * with, so that promise rejects. Its rejection is claimed here (it settles in
   * a later microtask, so this is still in time) and `svlib` is pointed at a
   * real engine built from the bytes the client sent.
   * @param {ArrayBuffer|Uint8Array} wasmBinary the vendored sunvox.wasm
   * @returns {Promise<object>} the SunVox module instance
   */
  function startSunVoxEngine(wasmBinary) {
    if (svlib && typeof svlib.catch === "function") svlib.catch(function () {});
    svlib = callSunVoxFactory(wasmBinary);
    return svlib;
  }

  /**
   * Call the vendored `SunVoxLib()` factory with the options a worklet needs.
   *
   * `globalThis.process` is hidden for the synchronous prologue of that call
   * only: it is what the glue's `ENVIRONMENT_IS_NODE` detection reads, and the
   * Node branch would reach for `require("fs")`/`__dirname`, which this scope
   * does not have. Everything after the factory's first `await` sees the real
   * `process` again, and no Node-only path is reachable anyway. See the file
   * header.
   * @param {ArrayBuffer|Uint8Array} wasmBinary
   * @returns {Promise<object>}
   */
  function callSunVoxFactory(wasmBinary) {
    const options = {
      wasmBinary: wasmBinary,
      locateFile: function locateFile() {
        return "";
      },
      print: function print() {},
      printErr: function printErr() {},
    };
    // A host with no `process` at all (a browser worklet) has no Node branch to
    // avoid, so its global is left untouched.
    if (globalThis.process === undefined) return SunVoxLib(options);
    const saved = globalThis.process;
    let promise;
    try {
      globalThis.process = undefined;
      promise = SunVoxLib(options);
    } finally {
      globalThis.process = saved;
    }
    return promise;
  }

  /**
   * One AudioWorkletProcessor that hosts the engine for one song.
   *
   * The sequencer owns time and notes; this class owns the SunVox side: the
   * slots, their modules, the mixer values and the wasm callback.
   */
  class StudioProcessor extends AudioWorkletProcessor {
    /** @param {{processorOptions?: {wasmBinary?: ArrayBuffer|Uint8Array}}} options */
    constructor(options) {
      super();

      const processorOptions = (options && options.processorOptions) || {};

      /** Whether the engine runs and the client has been told. */
      this.ready = false;
      /** The first error that stopped the engine, for `process()`'s silence. */
      this.failure = null;

      /** The pure sequencer for this host's sample rate. */
      this.sequencer = StudioSequencer.create({ sampleRate: sampleRate });

      /** Absolute frame of the next block, so `block()` calls stay contiguous. */
      this.frame = 0;

      /** The deterministic `out_time` the library's callbacks are given. */
      this.clock = 0;

      /** Frames accumulated since the last `position` message. */
      this.sincePosition = 0;
      this.positionEvery = Math.max(1, Math.round(sampleRate * POSITION_INTERVAL_SECONDS));

      /** track id → slot index, rebuilt on every song. */
      this.trackSlots = new Map();

      /** slot index → {track_id, type, module, mixer, volumeCtl, balanceCtl, …}. */
      this.slots = [];

      /** Which slots are open in the engine. */
      this.slotOpen = [];

      /** The interleaved buffer the library writes into; grown, never per block. */
      this.interleaved = new Float32Array(INITIAL_QUANTUM * 2);

      /** Messages that arrived before the engine was ready, in arrival order. */
      this.pending = [];

      this.port.onmessage = (event) => {
        const message = event && event.data;
        if (!message || typeof message !== "object") return;
        // A port delivers what was posted before the processor existed (a host
        // may construct it a moment after the node is built), so anything that
        // arrives before `sv_init()` succeeded waits its turn here and is
        // replayed in arrival order once the engine is up. That keeps a render
        // that posts its song and then waits for `ready` deterministic.
        if (!this.ready && !this.failure) {
          this.pending.push(message);
          return;
        }
        try {
          this.receive(message);
        } catch (error) {
          this.report(error);
        }
      };

      this.start(processorOptions.wasmBinary);
    }

    /**
     * Bring the engine up and tell the client. Failures are reported, never
     * thrown: a worklet that throws in its constructor would take the whole
     * audio thread down.
     * @param {ArrayBuffer|Uint8Array} wasmBinary
     * @returns {Promise<void>}
     */
    async start(wasmBinary) {
      try {
        if (!wasmBinary) throw new Error("no SunVox wasm binary was passed in processorOptions.wasmBinary");
        // `svlib` is the vendored loader's own binding: every `sv_*` function in
        // it reads through that name, so the resolved module instance goes back
        // into it (exactly as the loader's own usage does).
        svlib = await startSunVoxEngine(wasmBinary);
        const version = sv_init(
          0,
          sampleRate,
          2,
          SV_INIT_FLAG_USER_AUDIO_CALLBACK |
            SV_INIT_FLAG_AUDIO_FLOAT32 |
            SV_INIT_FLAG_ONE_THREAD |
            SV_INIT_FLAG_NO_DEBUG_OUTPUT,
        );
        if (!(version >= 0)) throw new Error(`sv_init() failed with ${version}`);
        if (sv_get_sample_rate() !== sampleRate) {
          throw new Error(`the engine runs at ${sv_get_sample_rate()} Hz, not the host's ${sampleRate} Hz`);
        }
        this.ready = true;
        this.port.postMessage({ type: "ready" });
        for (const message of this.pending) {
          try {
            this.receive(message);
          } catch (error) {
            this.report(error);
          }
        }
        this.pending.length = 0;
      } catch (error) {
        this.failure = error;
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
        case "play":
          this.sequencer.play();
          break;
        case "stop":
          this.sequencer.stop();
          break;
        case "flush":
          // Messages are handled in arrival order, so answering here proves
          // every message posted before the flush has been applied.
          this.port.postMessage({ type: "flushed", id: message.id });
          break;
        default:
          break;
      }
    }

    /**
     * Take a new song: the sequencer reads it, then the slots follow it (a
     * track that is new, that changed its device type, or whose position
     * changed gets a rebuilt slot).
     * @param {object} snapshot the song as `server/doc.js`'s `snapshot()` returns it
     * @returns {void}
     */
    setSong(snapshot) {
      if (!this.ready) return;
      const tracks = Array.isArray(snapshot && snapshot.tracks) ? snapshot.tracks : [];
      if (tracks.length > MAX_TRACKS) {
        throw new Error(`A song can have at most ${MAX_TRACKS} tracks.`);
      }
      this.sequencer.setSong(snapshot);
      this.syncSlots(tracks);
    }

    /**
     * Make the engine's slots match the song's tracks: build, retune and tear
     * down as needed, then rebuild the track id → slot map the note path uses.
     * @param {object[]} tracks the song's tracks, in song order
     * @returns {void}
     */
    syncSlots(tracks) {
      const trackSlots = new Map();
      for (let index = 0; index < tracks.length; index += 1) {
        const track = tracks[index] && typeof tracks[index] === "object" ? tracks[index] : {};
        const id = typeof track.id === "string" ? track.id : "";
        const type = deviceType(track);

        let slot = this.slots[index];
        if (!slot || slot.track_id !== id || slot.type !== type) {
          this.destroySlot(index);
          slot = this.buildSlot(index, id, type);
          this.slots[index] = slot;
          if (!slot) continue;
          // A new device starts from the controller defaults: the caches below
          // are empty, so both gain and pan are written again.
          slot.paramsKey = null;
          slot.volume = -1;
          slot.balance = -1;
        }

        this.applyParams(slot, track);
        this.applyMix(slot, track);
        if (id !== "") trackSlots.set(id, index);
      }

      for (let index = tracks.length; index < this.slots.length; index += 1) {
        if (this.slots[index]) this.destroySlot(index);
        this.slots[index] = null;
      }
      this.slots.length = Math.min(this.slots.length, Math.max(0, tracks.length));

      this.trackSlots = trackSlots;
    }

    /**
     * Open a slot if needed and build its two modules: the track's device and
     * the mixer that carries its gain and pan into SunVox's Output.
     * @param {number} index the slot, which is the track's position in the song
     * @param {string} trackId
     * @param {string} type the device's SunVox module type
     * @returns {object|null} the slot's state, or null when nothing could be built
     */
    buildSlot(index, trackId, type) {
      if (index >= MAX_TRACKS) return null;
      if (!this.slotOpen[index]) {
        if (sv_open_slot(index) < 0) return null;
        // Every slot runs at unity; gain belongs to the track's mixer.
        sv_volume(index, MIX_UNITY);
        // An empty song still has to be "playing" for the slot's voices to be
        // mixed; there is no pattern data, so this only keeps the slot awake.
        sv_play_from_beginning(index);
        this.slotOpen[index] = true;
      }

      let module = -1;
      let mixer = -1;
      sv_lock_slot(index);
      try {
        module = sv_new_module(index, type, "device", 512, 512, 0);
        if (module < 0 && type !== FALLBACK_DEVICE) {
          this.report(new Error(`SunVox has no module type "${type}"; the track plays "${FALLBACK_DEVICE}".`));
          module = sv_new_module(index, FALLBACK_DEVICE, "device", 512, 512, 0);
        }
        mixer = sv_new_module(index, MIX_MODULE, "mix", 640, 512, 0);
        if (module >= 0 && mixer >= 0) {
          sv_connect_module(index, module, mixer);
          sv_connect_module(index, mixer, 0);
        }
      } finally {
        sv_unlock_slot(index);
      }

      // Live notes are timestamps "as quickly as possible", which is what lets
      // the sub-block split place an event on its own frame (see the header).
      sv_set_event_t(index, 1, 0);

      if (module < 0 || mixer < 0) {
        this.report(new Error(`could not build slot ${index} for "${type}"`));
        if (module >= 0) sv_remove_module(index, module);
        if (mixer >= 0) sv_remove_module(index, mixer);
        return null;
      }

      return {
        index: index,
        track_id: trackId,
        type: type,
        module: module,
        mixer: mixer,
        volumeCtl: this.ctlIndex(index, mixer, MIX_VOLUME_CTL, 0),
        balanceCtl: this.ctlIndex(index, mixer, MIX_BALANCE_CTL, 1),
        ctlNames: null,
        paramsKey: null,
        volume: -1,
        balance: -1,
      };
    }

    /**
     * Remove a slot's modules and forget it. Removing a module also stops the
     * voices it was playing, so a rebuilt or removed track cannot leave a note
     * ringing.
     * @param {number} index
     * @returns {void}
     */
    destroySlot(index) {
      const slot = this.slots[index];
      if (!slot || !this.slotOpen[index]) return;
      sv_lock_slot(index);
      try {
        if (slot.mixer >= 0) sv_remove_module(index, slot.mixer);
        if (slot.module >= 0) sv_remove_module(index, slot.module);
      } finally {
        sv_unlock_slot(index);
      }
      slot.module = -1;
      slot.mixer = -1;
    }

    /**
     * Write a track's device parameters, by controller name, whenever they
     * changed. Unknown names are ignored (a song carries names, not numbers).
     * @param {object} slot
     * @param {object} track
     * @returns {void}
     */
    applyParams(slot, track) {
      const params = deviceParams(track);
      let key;
      try {
        key = JSON.stringify(params);
      } catch {
        key = null;
      }
      if (key !== null && key === slot.paramsKey) return;
      slot.paramsKey = key;

      for (const name of Object.keys(params)) {
        const value = Number(params[name]);
        if (!Number.isFinite(value)) continue;
        const index = this.ctlIndex(slot.index, slot.module, name, -1, slot);
        if (index < 0) continue;
        sv_set_module_ctl_value(slot.index, slot.module, index, Math.round(value), 1);
      }
    }

    /**
     * Write a track's gain, pan and mute onto its mixer, when they changed.
     * @param {object} slot
     * @param {object} track
     * @returns {void}
     */
    applyMix(slot, track) {
      const mix = mixFor(track);
      if (mix.volume !== slot.volume && slot.volumeCtl >= 0) {
        sv_set_module_ctl_value(slot.index, slot.mixer, slot.volumeCtl, mix.volume, 0);
        slot.volume = mix.volume;
      }
      if (mix.balance !== slot.balance && slot.balanceCtl >= 0) {
        sv_set_module_ctl_value(slot.index, slot.mixer, slot.balanceCtl, mix.balance, 0);
        slot.balance = mix.balance;
      }
    }

    /**
     * The controller index of one module, by name.
     *
     * A device's names are read once per module build and cached on the slot
     * (`state.ctlNames`); the mixer's two controllers are looked up once at
     * build time and their indexes passed in.
     * @param {number} index the slot
     * @param {number} module the module number
     * @param {string} name the controller's name as SunVox spells it
     * @param {number} fallback the index to assume when the name is missing
     * @param {object} [state] the slot state to cache a device's names on
     * @returns {number} the controller index, or the fallback
     */
    ctlIndex(index, module, name, fallback, state) {
      if (module < 0) return fallback;
      let names = state ? state.ctlNames : null;
      if (!names) {
        names = new Map();
        const count = sv_get_number_of_module_ctls(index, module);
        for (let at = 0; at < count; at += 1) {
          const ctlName = sv_get_module_ctl_name(index, module, at);
          if (typeof ctlName !== "string" || ctlName === "") continue;
          if (!names.has(ctlName)) names.set(ctlName, at);
          const lower = ctlName.toLowerCase();
          if (!names.has(lower)) names.set(lower, at);
        }
        if (state) state.ctlNames = names;
      }
      const direct = names.get(name);
      if (direct !== undefined) return direct;
      const lower = names.get(name.toLowerCase());
      return lower === undefined ? fallback : lower;
    }

    /**
     * One block of audio: the sequencer's events, applied on their own frames.
     * @param {Float32Array[][]} inputs unused — the engine is a source
     * @param {Float32Array[][]} outputs `outputs[0]` holds the stereo pair
     * @returns {boolean} true, so the host keeps calling
     */
    process(inputs, outputs) {
      const output = outputs && outputs[0];
      const channels = output && output.length > 0 ? output[0].length : 0;
      if (!output || channels === 0) return true;

      const left = output[0];
      const right = output.length > 1 ? output[1] : null;

      // The sequencer must see every block, ready or not: its events are
      // measured from contiguous frame starts.
      const events = this.sequencer.block(this.frame, channels);

      if (!this.ready || this.failure) {
        left.fill(0);
        if (right) right.fill(0);
        this.frame += channels;
        return true;
      }

      if (this.interleaved.length < channels * 2) {
        this.interleaved = new Float32Array(channels * 2);
      }

      let cursor = 0;
      let next = 0;
      while (cursor < channels) {
        while (next < events.length && events[next].frame <= cursor) {
          this.sendNote(events[next]);
          next += 1;
        }
        const boundary = next < events.length ? Math.min(channels, events[next].frame) : channels;
        const count = boundary > cursor ? boundary - cursor : channels - cursor;
        this.render(count, left, right, cursor);
        cursor += count;
      }

      this.frame += channels;
      this.reportPosition(channels);
      return true;
    }

    /**
     * Render `count` frames of the engine's mix into the output at `offset`,
     * hard-clipped at ±1.0 — 1a's whole master stage.
     * @param {number} count
     * @param {Float32Array} left
     * @param {Float32Array|null} right
     * @param {number} offset
     * @returns {void}
     */
    render(count, left, right, offset) {
      const interleaved = this.interleaved;
      this.clock += count;
      sv_audio_callback(interleaved, count, 0, this.clock);
      for (let at = 0; at < count; at += 1) {
        const l = interleaved[at * 2];
        const r = right ? interleaved[at * 2 + 1] : 0;
        left[offset + at] = l > 1 ? 1 : l < -1 ? -1 : l;
        if (right) right[offset + at] = r > 1 ? 1 : r < -1 ? -1 : r;
      }
    }

    /**
     * Send one sequencer event to its track's slot.
     * @param {{track_id: string, type: string, p: number, v: number}} event
     * @returns {void}
     */
    sendNote(event) {
      const index = this.trackSlots.get(event.track_id);
      if (index === undefined) return;
      const slot = this.slots[index];
      if (!slot || slot.module < 0) return;
      if (event.type === "on") {
        sv_send_event(index, 0, noteFor(event.p), sunvoxVelocity(event.v), slot.module + 1, 0, 0);
      } else {
        sv_send_event(index, 0, NOTECMD_NOTE_OFF, 0, slot.module + 1, 0, 0);
      }
    }

    /**
     * Post the transport position, at most every 50 ms of audio.
     * @param {number} channels the frames the block held
     * @returns {void}
     */
    reportPosition(channels) {
      this.sincePosition += channels;
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
  }

  registerProcessor(PROCESSOR_NAME, StudioProcessor);
})();