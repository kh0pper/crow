/**
 * Studio engine worklet processor — the SunVox host.
 *
 * `engine-client.js` concatenates three files into ONE module and loads it with
 * `audioWorklet.addModule()`:
 *
 *     sequencer.js + sunvox.js + studio-processor.js
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
 * `{type:"play"}`, `{type:"stop"}`, `{type:"flush", id}`,
 * `{type:"nextBarFrame", id}`
 * processor → client: `{type:"ready"}`, `{type:"flushed", id}`, `{type:"error",
 * error}`, `{type:"position", bar, beat, sixteenth}` (at most every 50 ms of
 * audio), `{type:"launched", track_id, clip_id, scene_id, bar, frame}` (one
 * per launch the sequencer applied in that block; see below),
 * `{type:"nextBarFrame", id, frame, bar}`
 *
 * ## Frames the client can count on
 *
 * A `launched` report and a `nextBarFrame` answer are both in the CONTEXT's
 * frames, not this processor's: `currentFrame`, the AudioWorkletGlobalScope
 * global every processor on one AudioContext shares, so a recorder built as a
 * second worklet on the same context arms on the very frame the engine's
 * launch took effect. `bar` is 0-based. The translation from the sequencer's
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

  /** @returns {number} the value held between two bounds. */
  function clamp(value, low, high) {
    if (!Number.isFinite(value)) return low;
    if (value < low) return low;
    if (value > high) return high;
    return value;
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
      this.sequencer.setSong(snapshot);
      this.enqueue(() => this.syncSlots(tracks));
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
        const type = deviceType(track);
        let record = previous[index];
        if (record && (record.track_id !== id || record.type !== type)) {
          this.teardown(record);
          record = null;
        }
        // Building an engine is the only await here; the old record is still in
        // `this.slots` (and so still in the mix) until the swap at the end.
        if (!record) record = await this.buildSlot(index, id, type);
        next.push(record);
        if (record.failed || !record.engine) continue;
        this.applyMix(record, track, anySolo);
        this.applyParams(record, track);
        if (id !== "") trackSlots.set(id, index);
      }

      for (let index = tracks.length; index < previous.length; index += 1) {
        if (previous[index]) this.teardown(previous[index]);
      }

      this.slots = next;
      this.trackSlots = trackSlots;
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
      try {
        this.block(left, right, count);
      } catch (error) {
        this.fail(error);
        left.fill(0);
        if (right) right.fill(0);
      }
      return true;
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
          this.sendNote(events[next]);
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
     * clip at ±1.0 — 1a's whole master stage.
     * @param {number} frames
     * @param {Float32Array} left
     * @param {Float32Array|null} right
     * @param {number} offset
     * @returns {void}
     */
    render(frames, left, right, offset) {
      const slots = this.slots;
      for (let index = 0; index < slots.length; index += 1) {
        const record = slots[index];
        if (!record || !record.engine || record.module < 0) continue;
        // Every engine is rendered every sub-block, muted or not: its voices
        // have to advance with the song, or a track would come back mid-note.
        const interleaved = record.engine.render(
          this.bufferFor(record, frames),
          frames,
          0,
          record.clock,
        );
        record.clock += frames;
        const gainLeft = record.left;
        const gainRight = record.right;
        if (gainLeft === 0 && gainRight === 0) continue;
        for (let at = 0; at < frames; at += 1) {
          left[offset + at] += interleaved[at * 2] * gainLeft;
          if (right) right[offset + at] += interleaved[at * 2 + 1] * gainRight;
        }
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