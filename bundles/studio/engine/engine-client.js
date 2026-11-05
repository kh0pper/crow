/**
 * Studio engine client — builds the worklet and posts the song to it.
 *
 * The engine is one AudioWorklet node whose processor hosts SunVox and the
 * sequencer (`studio-processor.js`). A worklet cannot `import`, so this file
 * glues these sources into ONE module and hands it to
 * `audioWorklet.addModule()`:
 *
 *     sequencer.js + resample.js + sampler-voice.js + perf-fx.js + sunvox.js
 *       + spessasynth.js + font-voice.js + studio-processor.js
 *
 * `resample.js` rides along so the worklet scope has the very same resampler a
 * page does (`StudioResample`), even though the conversion itself happens on
 * the client side of the port, before the PCM is handed over. `sampler-voice.js`
 * is the sampler's voice DSP, and `perf-fx.js` the performance-effects bus and
 * its looper, which the processor uses in that same scope. `spessasynth.js` is
 * the vendored SoundFont synth: one import-free classic script that defines
 * `globalThis.StudioSpessa` (see `vendor/spessasynth/`), which is the only shape
 * a worklet can load; `font-voice.js` is the host that drives it, one synth per
 * font with one MIDI channel per track (plan 1d).
 *
 * The vendored `sunvox_lib_loader.js` is deliberately NOT one of them: it keeps
 * one SunVox instance in a module-scope `svlib` (plus scratch pointers into
 * that instance's heap), so it can back only one engine per realm, while the
 * processor needs one engine per track. It talks to the `_sv_*` exports
 * directly instead.
 *
 * ## One engine per context
 *
 * `addModule()` registers the processor name on a context, and a context that
 * has been given it cannot take it again. A second `create()` on the same
 * context is therefore refused with a clear error instead of failing later
 * inside `addModule()`: reuse the engine you already have.

 * In a browser that module is a `Blob` URL; in Node it is a file in
 * `os.tmpdir()`, because node-web-audio-api's `addModule()` takes a path (or an
 * http URL) and imports it. The sources come from `assetBase` (fetched, e.g.
 * `/dashboard/studio/assets/`) or from `assetBytes` (a map of name →
 * string/Uint8Array, which is how the MCP renderer feeds its own files in).
 *
 * It is a classic script (no `import`/`export`): it assigns
 * `globalThis.StudioEngine` for the dashboard panel and `module.exports` when
 * a CommonJS `module` exists, so Node can `require()` the same file the browser
 * `<script>` tag loads. `engine/package.json` marks this directory
 * `"type": "commonjs"` for that reason.
 *
 * ## The graph
 *
 * `engine.node` has no inputs and one stereo output, and it is NOT connected to
 * anything by this file: the caller connects it to the destination. No Web
 * Audio node shapes sound anywhere in Studio (spec §5.1) — the worklet's output
 * is the engine's mix, hard-clipped, and that is the whole master bus.
 *
 * ## Ready
 *
 * The processor posts `{type:"ready"}` on its port once the wasm binary has
 * compiled. Each track's SunVox engine is created from that compiled module
 * when the song arrives (one engine per track, see `studio-processor.js`), and
 * `flush()` resolves only after that work is done, so an offline render that
 * waits for both and then calls `startRendering()` renders a deterministic
 * number of frames after the engine came up.
 *
 * ## The calibration and recording worklets
 *
 * Two more AudioWorkletProcessors ride on the same context, each loaded from its
 * own file with its own `addModule()` (never as part of the engine module, so an
 * engine that failed to come up cannot take them with it):
 *
 * - `calibrate-emitter.js` (`studio-calibrate-emitter`) clicks a loopback cable;
 * - `calibrate-detector.js` (`studio-calibrate-detector`) finds those clicks by
 *   cross-correlation and reports each one's lag in frames;
 * - `recorder-processor.js` (`studio-recorder`) turns an input into 24-bit PCM
 *   chunks of a take.
 *
 * `loadStudioWorklets()` below adds them once per context and remembers the
 * promise in a WeakMap, so two recorders (or a recorder and a calibration) on
 * one context do not register the same processor twice. In a browser each is
 * fetched from `${assetBase}<file>`; in Node it is read from `assetBytes` or
 * from the files next to this module (the same fallback the engine sources
 * use) and handed to `addModule()` as a private temp file.
 *
 * ## Messages
 *
 * The client's side of the port protocol (the processor's header has the
 * whole list):
 *
 * - `onPosition(listener)` follows `{type:"position", bar, beat, sixteenth}`,
 *   posted at most every 50 ms of audio.
 * - `onLaunch(listener)` follows `{type:"launched", track_id, clip_id,
 *   scene_id, bar, frame}`: one report per launch or stop the sequencer
 *   APPLIED, `frame` being the frame of the whole AudioContext (the worklet's
 *   shared `currentFrame`) where it took effect and `bar` the 0-based bar. A
 *   recorder on the same context arms from that frame.
 * - `nextBarFrame()` asks for the next bar boundary on the same clock and
 *   resolves `{frame, bar}` (0-based bar; while the transport is stopped, the
 *   frame bar 0 would start at).
 * - `setMode("session" | "arrangement")` and `seek(bar)` choose what the
 *   transport plays: the session grid, where launches arm clips, or the song's
 *   arrangement, where its placements sound on their bars. Switching mode
 *   closes every sounding note and voice; `seek()` moves the arrangement
 *   playhead, and the next block plays from that bar.
 * - `flush()` resolves once every message posted before it has been applied.
 * - `loadAudio(take_id, channels, rate)` hands the processor one take's PCM,
 *   resampled here to the context's rate when the take was recorded at another
 *   one, and resolves when the processor has it. `unloadAudio(take_id)` drops
 *   it again.
 * - `loadSample(sample_id, channels, rate)` does the very same for one sampled
 *   pad's PCM, into the processor's own sample store, and
 *   `unloadSample(sample_id)` drops it again. The song may hold 256 MB of
 *   decoded samples at once (the browser's cap; `create()` takes
 *   `maxSampleBytes` for a host that knows how much its own song needs, which
 *   an offline render does): past that the engine drops the least-recently
 *   played one, and `onSampleNeeded(listener)` says which sample a trigger
 *   wanted so the page can load it back.
 * - `loadLibrary(id, kind, bytes)` hands the engine one library FILE — a
 *   SoundFont bank today (`kind: "font"`), a capture or cabinet later —
 *   transferred rather than copied, and resolves with what became of it:
 *   `{status: "loaded" | "deferred" | "failed", reason?}`. There is no fetch on
 *   the audio thread, so the page (or a render) reads the file and posts it
 *   here. Banks are parsed ONLY while the transport is stopped (the plan's
 *   loading rule): a load posted while the song plays is answered `deferred` and
 *   parsed on the next `stop()`, which is what the page's "Loads when you stop."
 *   says. `unloadLibrary(id)` drops one file again (and cancels a load of it that
 *   has not been parsed yet), and `onLibraryNeeded(listener)` follows the fonts a
 *   track wanted but the engine does not hold, so the page can load them (or
 *   offer a download). The processor holds at most 1 GiB of banks per page
 *   (`maxFontBytes` on `create()` for a host that knows its own window), counted
 *   as the files plus their decoded sample data: past it the least recently
 *   played font no track of the song plays is dropped and requested again, and a
 *   load the song's own fonts leave no room for comes back `failed` with the
 *   reason to show.
 * - `livePad(track_id, bank, index, v)` and `liveRelease(track_id, bank, index)`
 *   audition a pad from the panel: straight to the voice, never through a
 *   command or a history step, and never quantized.
 * - `tap(target, on)` turns a copy of the master (`"master"`) or of one track's
 *   own output (`track_id`) on, per block, as `{type:"tap_block", target, frame,
 *   channels}`: `frame` is the context frame the block's first sample sits on,
 *   the same clock `launched` and `nextBarFrame` report in. What record-into-pad
 *   and resampling listen to. Off by default. `onTap(listener)` follows those
 *   blocks as `{target, frame, channels}`; it resolves to an unsubscribe. A tap
 *   never changes the mix it copies, and a MASTER tap copies it after the
 *   performance bus, so what it records is what the room hears.
 * - `fxHold(name, amount)` and `fxRelease(name)` hold or let go one performance
 *   effect (`filter_sweep`, `lofi`, `stutter`, `tape_stop`, `reverb_throw`).
 *   They are live state, never a command or a history step, and they take effect
 *   at the next block's first frame. Nothing else releases them.
 * - `looper(action)` drives the master looper: `record`, `overdub`, `play`,
 *   `stop` or `clear`, all quantized to the sequencer's next bar line.
 *   `looperTake()` resolves with `{channels, rate, bars}` — whole bars of the
 *   master the looper recorded, clipped to [−1, 1], which record-into-pad turns
 *   into a pad's sample. The looper's buffers are this page's (the audio thread
 *   allocates none): eight bars at the song's tempo are sent before the first
 *   record, and handed back and forth around a take.
 */
(function () {
  "use strict";

  /** The files that make up the worklet module, in concatenation order. */
  const SOURCE_FILES = [
    "sequencer.js",
    "resample.js",
    "sampler-voice.js",
    "perf-fx.js",
    "sunvox.js",
    // The vendored SoundFont synth, before the processor that hosts it: it is
    // one import-free classic script that defines globalThis.StudioSpessa.
    "spessasynth.js",
    // The SoundFont hosts: one synth per font, one MIDI channel per track (see
    // font-voice.js). Before the processor that hosts them.
    "font-voice.js",
    "studio-processor.js",
  ];

  /**
   * The engine sources that live outside this directory: the vendored scripts
   * `SOURCE_FILES` names, as paths from here. A Node caller that supplies no
   * `assetBytes` for one of them (a test that predates it passes only the files
   * it knows) is still handed the very same file a browser is served.
   * @type {Readonly<Object<string, string[]>>}
   */
  const VENDORED_SOURCES = Object.freeze({
    "sunvox.js": ["..", "vendor", "sunvox", "sunvox.js"],
    "spessasynth.js": ["..", "vendor", "spessasynth", "spessasynth.js"],
  });

  /**
   * The audio contexts that already have the Studio processor registered. A
   * WeakSet, so a discarded context is not kept alive by this bookkeeping.
   */
  const ENGINE_CONTEXTS = new WeakSet();

  /** What a second `create()` on the same context is told. */
  const ONE_ENGINE_ERROR = "StudioEngine: one engine per audio context; reuse the existing engine.";

  /** The wasm binary, passed to the processor as `processorOptions.wasmBinary`. */
  const WASM_FILE = "sunvox.wasm";

  /** The processor name `studio-processor.js` registers. */
  const PROCESSOR_NAME = "studio-processor";

  /**
   * The worklet files loaded separately from the engine module, in load order.
   * Each is a classic script with one `registerProcessor()` call.
   */
  const WORKLET_FILES = Object.freeze([
    "calibrate-emitter.js",
    "calibrate-detector.js",
    "recorder-processor.js",
  ]);

  /** The processor names those files register. */
  const CALIBRATE_EMITTER_PROCESSOR = "studio-calibrate-emitter";
  const CALIBRATE_DETECTOR_PROCESSOR = "studio-calibrate-detector";
  const RECORDER_PROCESSOR = "studio-recorder";

  /**
   * The audio contexts whose calibration and recording worklets are added. The
   * value is the promise of that work, so concurrent callers share one load and
   * a failed load can be retried. A WeakMap, so a discarded context is not kept
   * alive by this bookkeeping.
   * @type {WeakMap<BaseAudioContext, Promise<void>>}
   */
  const WORKLET_CONTEXTS = new WeakMap();

  /**
   * The resampling workers this page has, one per asset base. A worker keeps
   * its own copy of `resample.js`, so a long take is converted off the page's
   * main thread (a frozen panel is a frozen transport and a frozen history).
   * @type {Map<string, {worker: Worker, pending: Map<number, object>}>}
   */
  const RESAMPLE_WORKERS = new Map();

  /** The id of the last conversion sent to a worker. */
  let RESAMPLE_SEQ = 0;

  /** How many clicks a calibration plays when the caller names none. */
  const DEFAULT_CALIBRATION_CLICKS = 16;

  /** The first clicks of a calibration are not measured: a cold chain is noisy. */
  const IGNORED_CALIBRATION_CLICKS = 2;

  /** Fewer heard clicks than this and there is no measurement to trust. */
  const MIN_CALIBRATION_CLICKS = 10;

  /** The gap between calibration clicks when the caller names none, in seconds. */
  const DEFAULT_CALIBRATION_INTERVAL_SECONDS = 0.5;

  /** A loopback whose lags spread wider than this (in seconds) is not stable. */
  const MAX_CALIBRATION_SPREAD_SECONDS = 0.002;

  /** What a calibration that measured nothing usable is refused with. */
  const CALIBRATION_REFUSAL = "Check the loopback cable and the input gain.";

  /** How long to wait for the worklet to report ready. */
  const READY_TIMEOUT_MS = 20000;

  /** A song can have at most this many SunVox tracks (one engine each). */
  const MAX_TRACKS = 16;

  /** Four beats to the bar, everywhere in Studio. */
  const BEATS_PER_BAR = 4;

  /** The tempo a song without a usable `meta.bpm` is measured at. */
  const DEFAULT_BPM = 120;

  /** How many bars the looper's buffers hold: the longest take it records. */
  const LOOPER_BARS = 8;

  /**
   * The page's own copy of one looper-take channel, clipped to [−1, 1].
   *
   * The looper taps the master BEFORE the clip, so a take can hold values past
   * full scale; what the page keeps is clipped, so a pad made from a take is
   * never louder than full scale. The copy is the page's: the processor's buffers
   * are handed straight back, and the looper plays on from them.
   * @param {Float32Array|ArrayBufferView|null} buffer the transferred channel
   * @param {number} frames how many frames of it to copy
   * @returns {Float32Array} the clipped copy (empty when there is no buffer)
   */
  function copyLooperChannel(buffer, frames) {
    const length = Math.max(0, Math.trunc(Number(frames) || 0));
    const copy = new Float32Array(length);
    if (!buffer || typeof buffer.length !== "number") return copy;
    const count = Math.min(length, buffer.length);
    for (let at = 0; at < count; at += 1) {
      const value = buffer[at];
      copy[at] = value > 1 ? 1 : value < -1 ? -1 : value;
    }
    return copy;
  }

  /** @returns {boolean} whether this script runs in Node rather than a browser. */
  function isNode() {
    return typeof process !== "undefined" && !!(process && process.versions && process.versions.node);
  }

  /** @returns {Function|null} Node's `require`, when this script has one. */
  function nodeRequire() {
    return typeof require === "function" ? require : null;
  }

  /** @returns {string} a URL for one asset under a base, with one separator. */
  function joinUrl(base, name) {
    const text = String(base);
    return text.endsWith("/") ? text + name : text + "/" + name;
  }

  /** @returns {string} text from a string, ArrayBuffer or typed array. */
  function textOf(value) {
    if (typeof value === "string") return value;
    if (value && typeof value === "object") {
      if (typeof value.textContent === "string") return value.textContent;
      if (value instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(value));
      if (ArrayBuffer.isView(value)) return new TextDecoder().decode(value);
    }
    throw new Error("StudioEngine: expected text or bytes");
  }

  /** @returns {Uint8Array} bytes from bytes, an ArrayBuffer or text. */
  function bytesOf(value) {
    if (typeof value === "string") return new TextEncoder().encode(value);
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    throw new Error("StudioEngine: expected bytes");
  }

  /**
   * Read one source file as text, from `assetBytes` when the caller supplied
   * bytes, else from `assetBase` over fetch.
   *
   * A Node caller that names neither (the offline renderer predates
   * `resample.js` and passes only the files it knows) is served the copy that
   * sits next to this module: the engine sources are its own neighbours, so the
   * file it left out is still the same file the render is meant to run.
   * @param {string} name
   * @param {{assetBase?: string, assetBytes?: object}} options
   * @returns {Promise<string>}
   */
  async function readText(name, options) {
    const supplied = options.assetBytes;
    if (supplied && supplied[name] !== undefined) return textOf(supplied[name]);
    if (!options.assetBase) {
      const local = readLocalText(name);
      if (local !== null) return local;
      throw new Error(`StudioEngine: no ${name} in assetBytes and no assetBase`);
    }
    const response = await fetch(joinUrl(options.assetBase, name));
    if (!response.ok) throw new Error(`StudioEngine: could not load ${name} (${response.status})`);
    return response.text();
  }

  /**
   * One engine source file from the directory this module lives in, in Node.
   * @param {string} name
   * @returns {string|null} the text, or null when this host has no such file
   */
  function readLocalText(name) {
    const req = nodeRequire();
    if (!req || typeof __dirname !== "string" || __dirname === "") return null;
    try {
      const fs = req("node:fs");
      const path = req("node:path");
      // Only a plain file name: a caller's name is never turned into a path
      // outside this module's own directory. A vendored source's path is fixed
      // here, never taken from the caller.
      if (name !== path.basename(name)) return null;
      const file = VENDORED_SOURCES[name]
        ? path.join(__dirname, ...VENDORED_SOURCES[name])
        : path.join(__dirname, name);
      if (!fs.existsSync(file)) return null;
      return fs.readFileSync(file, "utf8");
    } catch {
      return null;
    }
  }

  /**
   * Read the wasm binary.
   * @param {{assetBase?: string, assetBytes?: object}} options
   * @returns {Promise<ArrayBuffer>}
   */
  async function readWasm(options) {
    const supplied = options.assetBytes;
    if (supplied && supplied[WASM_FILE] !== undefined) {
      const bytes = bytesOf(supplied[WASM_FILE]);
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
    if (!options.assetBase) throw new Error(`StudioEngine: no ${WASM_FILE} in assetBytes and no assetBase`);
    const response = await fetch(joinUrl(options.assetBase, WASM_FILE));
    if (!response.ok) throw new Error(`StudioEngine: could not load ${WASM_FILE} (${response.status})`);
    return response.arrayBuffer();
  }

  /** A counter so two engines in one Node process never share a temp path. */
  /**
   * Write the glue module to a temp file and return its path.
   *
   * node-web-audio-api imports the path it is given, so the file has to exist
   * for the whole `addModule()` call. The name ends in `.mjs` so Node treats it
   * as an ES module whatever is above `os.tmpdir()`.
   * @param {string} source
   * @returns {{path: string, remove: () => void}}
   */
  function writeTempModule(source) {
    const fs = nodeRequire()("node:fs");
    const os = nodeRequire()("node:os");
    const path = nodeRequire()("node:path");
    // A private 0700 directory per module and an exclusive 0600 create: a
    // predictable name in the shared tmp dir could be pre-created or swapped
    // by another local user, and this file is imported as code.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-engine-"));
    const file = path.join(dir, "engine.mjs");
    fs.writeFileSync(file, source, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return {
      path: file,
      remove: function remove() {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          /* the module is imported; a leftover private dir in tmp is harmless */
        }
      },
    };
  }

  /**
   * Whether a value is a `MediaStream` (a microphone or interface input).
   * @param {unknown} value
   * @returns {boolean}
   */
  function isMediaStream(value) {
    if (!value || typeof value !== "object") return false;
    if (typeof MediaStream !== "undefined" && value instanceof MediaStream) return true;
    // node-web-audio-api's MediaStream is not a DOM global, but it is shaped
    // the same way; an AudioNode has `connect` and no tracks.
    return typeof value.getAudioTracks === "function";
  }

  /**
   * @param {unknown} value a caller's number
   * @param {number} fallback the value to use when it is not a number
   * @param {number} minimum the smallest value allowed
   * @returns {number} a whole number, at least `minimum`
   */
  function wholeAtLeast(value, fallback, minimum) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    const whole = Math.round(number);
    return whole < minimum ? minimum : whole;
  }

  /**
   * @param {unknown} value a frame a caller asked for
   * @param {string} what the method's name, for the error
   * @returns {number} a whole frame number
   */
  function frameNumber(value, what) {
    const frame = Number(value);
    if (!Number.isFinite(frame)) throw new Error(`StudioEngine: ${what} needs a frame number`);
    return Math.trunc(frame);
  }

  /**
   * The median of an ascending list of whole frames.
   * @param {number[]} sorted
   * @returns {number}
   */
  function medianOf(sorted) {
    if (sorted.length === 0) return 0;
    const middle = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) return sorted[middle];
    return Math.round((sorted[middle - 1] + sorted[middle]) / 2);
  }

  /**
   * Add one of `WORKLET_FILES` to a context: a URL in a browser, a private temp
   * file in Node (where `addModule()` takes a path).
   * @param {BaseAudioContext} context
   * @param {string} name
   * @param {{assetBase?: string, assetBytes?: object}} options
   * @returns {Promise<void>}
   */
  async function addWorkletFile(context, name, options) {
    const opts = options || {};
    if (isNode()) {
      const source = await readText(name, opts);
      const temp = writeTempModule(source);
      try {
        await context.audioWorklet.addModule(temp.path);
      } finally {
        temp.remove();
      }
      return;
    }
    if (!opts.assetBase) throw new Error(`StudioEngine: loading ${name} needs an assetBase in this host`);
    await context.audioWorklet.addModule(joinUrl(opts.assetBase, name));
  }

  /**
   * Add the calibration and recording worklets to a context, once. A second
   * call on the same context (a recorder after a calibration, two recorders)
   * waits for the first load instead of registering anything again.
   * @param {BaseAudioContext} context
   * @param {{assetBase?: string, assetBytes?: object}} [options]
   * @returns {Promise<void>}
   */
  function loadStudioWorklets(context, options) {
    if (!context || !context.audioWorklet) {
      throw new Error("StudioEngine: a context with audioWorklet is required");
    }
    const loading = WORKLET_CONTEXTS.get(context);
    if (loading) return loading;
    const pending = (async () => {
      for (const name of WORKLET_FILES) await addWorkletFile(context, name, options);
    })();
    WORKLET_CONTEXTS.set(context, pending);
    // A failed load registered nothing, so a retry on this context is honest.
    pending.catch(() => WORKLET_CONTEXTS.delete(context));
    return pending;
  }

  /**
   * The resampler this host has: the page (or worklet) global in a browser,
   * this module's neighbour in Node. It is the same arithmetic either way — see
   * `resample.js`.
   * @returns {{toRate: function(Float32Array[], number, number): Float32Array[]}}
   */
  function resamplerOf() {
    const shared = typeof globalThis !== "undefined" ? globalThis.StudioResample : null;
    if (shared && typeof shared.toRate === "function") return shared;
    const req = nodeRequire();
    if (req) {
      try {
        const local = req("./resample.js");
        if (local && typeof local.toRate === "function") return local;
      } catch {
        /* fall through to the error below */
      }
    }
    throw new Error("StudioEngine: resampling needs StudioResample (engine/resample.js) in this host");
  }

  /**
   * This host's resampling worker, built on first use.
   *
   * A worker is the only way to keep a long take's conversion off the page's
   * main thread. A host without `Worker` (Node), a refusal to construct one,
   * or a failed error are all answered with null, and the caller converts
   * inline instead.
   * @param {string} assetBase the URL prefix the worker's own script is at
   * @returns {{worker: Worker, pending: Map<number, object>}|null}
   */
  function resampleWorker(assetBase) {
    const url = joinUrl(assetBase, "resample-worker.js");
    const held = RESAMPLE_WORKERS.get(url);
    if (held) return held;
    if (typeof Worker !== "function") return null;
    let worker = null;
    try {
      worker = new Worker(url);
    } catch {
      return null;
    }
    const entry = { worker: worker, pending: new Map() };
    worker.onmessage = (event) => {
      const message = event && event.data;
      if (!message || typeof message !== "object" || message.id === undefined) return;
      const settle = entry.pending.get(message.id);
      if (!settle) return;
      entry.pending.delete(message.id);
      if (message.error) settle.reject(new Error("StudioEngine: " + String(message.error)));
      else settle.resolve(message.channels);
    };
    // A worker that never loads (a 404, a policy refusal) rejects the loads
    // waiting on it and is forgotten, so the next one converts inline.
    worker.onerror = () => {
      const waiting = Array.from(entry.pending.values());
      entry.pending.clear();
      RESAMPLE_WORKERS.delete(url);
      try {
        worker.terminate();
      } catch {
        /* already gone */
      }
      for (const settle of waiting) settle.reject(new Error("StudioEngine: the resampling worker failed"));
    };
    RESAMPLE_WORKERS.set(url, entry);
    return entry;
  }

  /**
   * Convert one take's channels in the page's resampling worker.
   *
   * The input arrays are copied by the port rather than transferred: a worker
   * that fails after it has received them would otherwise leave the caller's
   * fallback with detached buffers. The worker's own output IS transferred.
   * @param {string} assetBase
   * @param {Float32Array[]} channels
   * @param {number} from the rate they are at, in Hz
   * @param {number} to the rate they are wanted at, in Hz
   * @returns {Promise<Float32Array[]>}
   */
  function resampleInWorker(assetBase, channels, from, to) {
    const entry = resampleWorker(assetBase);
    if (!entry) return Promise.reject(new Error("StudioEngine: this host has no resampling worker"));
    const id = (RESAMPLE_SEQ += 1);
    return new Promise((resolve, reject) => {
      entry.pending.set(id, { resolve: resolve, reject: reject });
      try {
        entry.worker.postMessage({ id: id, channels: channels, from: from, to: to });
      } catch (error) {
        entry.pending.delete(id);
        reject(error);
      }
    });
  }

  /**
   * `addModule()` with a Blob URL in a browser and a temp file in Node.
   * @param {BaseAudioContext} context
   * @param {string} source
   * @returns {Promise<void>}
   */
  async function addEngineModule(context, source) {
    if (isNode()) {
      const temp = writeTempModule(source);
      try {
        await context.audioWorklet.addModule(temp.path);
      } finally {
        temp.remove();
      }
      return;
    }
    if (typeof Blob !== "function" || typeof URL === "undefined" || !URL.createObjectURL) {
      throw new Error("StudioEngine: this host has neither require() nor Blob URLs");
    }
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    try {
      await context.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /** @returns {Function} the AudioWorkletNode constructor of this host. */
  function workletNodeClass() {
    if (typeof globalThis.AudioWorkletNode === "function") return globalThis.AudioWorkletNode;
    const req = nodeRequire();
    if (req) {
      const module = req("node-web-audio-api");
      if (module && typeof module.AudioWorkletNode === "function") return module.AudioWorkletNode;
    }
    throw new Error("StudioEngine: no AudioWorkletNode in this host");
  }

  /**
   * Wait for the processor's `ready`, failing on `error` or a timeout.
   * @param {AudioWorkletNode} node
   * @param {number} timeoutMs
   * @returns {Promise<void>}
   */
  function awaitReady(node, timeoutMs) {
    return new Promise((resolve, reject) => {
      let timer = null;
      const done = (settle, value) => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
        // `onmessage` is used rather than addEventListener because it starts
        // the port on both hosts (Node's MessagePort does not auto-start an
        // addEventListener subscriber).
        node.port.onmessage = null;
        settle(value);
      };
      timer = setTimeout(() => {
        done(reject, new Error(`StudioEngine: the engine was not ready within ${timeoutMs} ms`));
      }, timeoutMs);
      node.port.onmessage = (event) => {
        const message = event && event.data;
        if (!message || typeof message !== "object") return;
        if (message.type === "ready") done(resolve, undefined);
        else if (message.type === "error") done(reject, new Error("StudioEngine: " + message.error));
      };
      if (typeof node.port.start === "function") node.port.start();
    });
  }

  /**
   * Build the engine's worklet module and wait for the engine to come up.
   *
   * @param {BaseAudioContext} context an AudioContext or OfflineAudioContext
   * @param {{assetBase?: string, assetBytes?: object, readyTimeoutMs?: number,
   *          testHooks?: boolean, maxSampleBytes?: number, maxFontBytes?: number}} options
   *   `assetBase` is a URL prefix the engine files are fetched from;
   *   `assetBytes` is a map of file name → string/Uint8Array, which wins over
   *   `assetBase` for the names it holds (Node callers read the files
   *   themselves); `testHooks` arms the processor's test-only faults;
   *   `maxSampleBytes` is the song-wide cap on decoded samples, the browser's
   *   256 MB when omitted (an offline render passes the bytes its window needs);
   *   `maxFontBytes` is the cap on the library banks parsed in the engine, the
   *   plan's 1 GiB when omitted (an offline render passes its own font window)
   * @returns {Promise<{node: AudioWorkletNode,
   *                    setSong: function(object): void,
   *                    launchScene: function(string): void,
   *                    launchClip: function(string): void,
   *                    stopTrack: function(string): void,
   *                    stopAll: function(): void,
   *                    play: function(): void,
   *                    stop: function(): void,
   *                    setMode: function(string): void,
   *                    seek: function(number): void,
   *                    flush: function(): Promise<void>,
   *                    onPosition: function(function): function,
   *                    onLaunch: function(function): function,
   *                    nextBarFrame: function(): Promise<{frame: number, bar: number}>,
   *                    onTap: function(function): function,
  *                    loadLibrary: function(string, string, Uint8Array): Promise<{status: string, reason?: string}>,
 *                    unloadLibrary: function(string): void,
 *                    onLibraryNeeded: function(function): function,
   *                    fxHold: function(string, number): void,
   *                    fxRelease: function(string): void,
   *                    looper: function(string): void,
   *                    looperTake: function(): Promise<{channels: Float32Array[],
   *                      rate: number, bars: number}>,
   *                    onError: function(function): function,
   *                    calibrate: function(object): Promise<object>,
   *                    createRecorder: function(object): Promise<object>,
   *                    throwForTest: function(): void,
   *                    dispose: function(): void}>}
   */
  /**
   * The worklet module: the source files joined in order. One blank line and a
   * semicolon between files: every one of them is a classic script that relies
   * on its own final expression, and the SunVox glue ends without a trailing
   * semicolon.
   * @param {string[]} texts - the SOURCE_FILES contents, in order
   * @returns {string}
   */
  function composeEngineModule(texts) {
    return texts.join("\n;\n");
  }

  /**
   * A loopback calibration: click out of the destination, listen on `input`,
   * and measure the lag of each click the detector finds.
   *
   * `options.input` is a MediaStream (wrapped in a MediaStreamAudioSourceNode —
   * allowed as an input source only) or, in a Node test, an AudioNode. The
   * clicks go out through the emitter on frame `first_frame` and every
   * `interval_frames` after that; the first two are ignored, and the rest give
   * the median lag, the spread and how many were heard.
   *
   * An offline context renders nothing on its own, so this starts
   * `startRendering()` itself in that case (and waits for it). A realtime
   * context just plays.
   *
   * @param {BaseAudioContext} context
   * @param {{assetBase?: string, assetBytes?: object}} engineOptions
   * @param {{input?: MediaStream|AudioNode, clicks?: number, latencyHint?: string,
   *          sinkId?: string, interval?: number,
   *          onEmitter?: function(AudioWorkletNode): void}} [options]
   *   `interval` is the gap between clicks in milliseconds; `onEmitter` is
   *   handed the emitter node so a host without a cable (a Node test) can route
   *   it through a stand-in delay. `latencyHint` and `sinkId` are only reported
   *   back in the result: they describe the context the caller made, which is
   *   what the panel stores the measurement under
   * @param {(text: string) => void} notifyError
   * @returns {Promise<{latency_frames: number, rate: number, spread_frames: number,
   *                    clicks_heard: number, latencyHint: string|null,
   *                    sinkId: string|null}>}
   */
  async function runCalibration(context, engineOptions, options, notifyError) {
    const settings = options || {};
    const input = settings.input;
    if (!input) throw new Error("StudioEngine: calibrate needs an input (a MediaStream or an AudioNode)");

    const clicks = wholeAtLeast(settings.clicks, DEFAULT_CALIBRATION_CLICKS, 1);
    const intervalFrames = wholeAtLeast(
      settings.interval === undefined || settings.interval === null
        ? undefined
        : (Number(settings.interval) * context.sampleRate) / 1000,
      Math.round(context.sampleRate * DEFAULT_CALIBRATION_INTERVAL_SECONDS),
      1,
    );
    // Only the clicks after the first two are measured; a caller asking for 2 or
    // fewer has nothing counted at all.
    const counted = Math.max(0, clicks - IGNORED_CALIBRATION_CLICKS);

    await loadStudioWorklets(context, engineOptions);
    const Node = workletNodeClass();
    const emitter = new Node(context, CALIBRATE_EMITTER_PROCESSOR, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { interval_frames: intervalFrames, first_frame: intervalFrames, clicks: clicks },
    });
    const detector = new Node(context, CALIBRATE_DETECTOR_PROCESSOR, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });

    let source = null;
    let alone = null;
    let rendering = null;
    let renderError = null;
    let timer = null;
    const responses = new Map();
    let resolveResponses = null;
    const allAnswered = new Promise((resolve) => {
      resolveResponses = resolve;
    });
    const checkAnswers = () => {
      if (responses.size >= counted) resolveResponses(undefined);
    };

    try {
      if (typeof input.connect === "function") {
        input.connect(detector);
      } else if (isMediaStream(input)) {
        if (typeof context.createMediaStreamSource !== "function") {
          throw new Error("StudioEngine: this host cannot read a MediaStream");
        }
        source = context.createMediaStreamSource(input);
        source.connect(detector);
      } else {
        throw new Error("StudioEngine: calibrate needs a MediaStream or an AudioNode as its input");
      }

      // The detector outputs silence; the gain of 0 is only there so the graph
      // pulls the detector on a host that runs nothing unreachable.
      alone = context.createGain();
      alone.gain.value = 0;
      detector.connect(alone);
      alone.connect(context.destination);

      emitter.connect(context.destination);
      if (typeof settings.onEmitter === "function") settings.onEmitter(emitter);

      let seen = 0;
      emitter.port.onmessage = (event) => {
        const message = event && event.data;
        if (!message || typeof message !== "object") return;
        if (message.type === "error") {
          notifyError(String(message.error));
          return;
        }
        if (message.type !== "click") return;
        seen += 1;
        if (seen <= IGNORED_CALIBRATION_CLICKS) return;
        detector.port.postMessage({ type: "expect", frame: message.frame });
      };
      detector.port.onmessage = (event) => {
        const message = event && event.data;
        if (!message || typeof message !== "object") return;
        if (message.type === "error") {
          notifyError(String(message.error));
          return;
        }
        if (message.type !== "heard" && message.type !== "missed") return;
        if (responses.has(message.frame)) return;
        responses.set(
          message.frame,
          message.type === "heard"
            ? { heard: true, lag: Math.round(Number(message.lag_frames)) }
            : { heard: false },
        );
        checkAnswers();
      };
      if (typeof emitter.port.start === "function") emitter.port.start();
      if (typeof detector.port.start === "function") detector.port.start();

      // An offline context renders nothing until it is told to; a realtime one
      // is already running. Either way, a realtime calibration that never
      // finishes gets a wall-clock guard instead of hanging for ever.
      const offline = typeof context.startRendering === "function";
      if (offline) {
        rendering = context
          .startRendering()
          .then(
            () => undefined,
            (error) => {
              renderError = error;
            },
          )
          .then(() => {
            // Let the reports posted before the render ended reach this thread,
            // then settle with what arrived: the rest were never measured.
            setTimeout(() => resolveResponses(undefined), 0);
          });
      } else {
        const schedule = (clicks * intervalFrames * 1000) / context.sampleRate;
        timer = setTimeout(() => resolveResponses(undefined), Math.round(schedule * 1.5) + 1000);
      }
      if (counted === 0) resolveResponses(undefined);

      await allAnswered;
      if (rendering) await rendering;
      if (renderError) throw renderError;

      const lags = [];
      for (const answer of responses.values()) if (answer.heard) lags.push(answer.lag);
      lags.sort((left, right) => left - right);
      const result = {
        latency_frames: medianOf(lags),
        rate: context.sampleRate,
        spread_frames: lags.length > 1 ? lags[lags.length - 1] - lags[0] : 0,
        clicks_heard: lags.length,
        latencyHint: settings.latencyHint === undefined || settings.latencyHint === null ? null : settings.latencyHint,
        sinkId: settings.sinkId === undefined || settings.sinkId === null ? null : settings.sinkId,
      };
      if (lags.length < MIN_CALIBRATION_CLICKS || result.spread_frames > Math.round(MAX_CALIBRATION_SPREAD_SECONDS * context.sampleRate)) {
        throw new Error(CALIBRATION_REFUSAL);
      }
      return result;
    } finally {
      if (timer !== null) clearTimeout(timer);
      try {
        emitter.port.onmessage = null;
      } catch {
        /* nothing to drop */
      }
      try {
        detector.port.onmessage = null;
      } catch {
        /* nothing to drop */
      }
      try {
        emitter.disconnect();
      } catch {
        /* never connected */
      }
      try {
        detector.disconnect();
      } catch {
        /* never connected */
      }
      if (alone) {
        try {
          alone.disconnect();
        } catch {
          /* never connected */
        }
      }
      if (source) {
        try {
          source.disconnect();
        } catch {
          /* never connected */
        }
      }
    }
  }

  /**
   * A recorder on this context: an input in, 24-bit take chunks out.
   *
   * The caller arms it on a frame the engine reported (`onLaunch`, Task 2) and
   * stops it on a frame it computes itself (a take's `offset_frames` included,
   * so the compensated take keeps its tail). `splitAt` cuts one recording into
   * one take segment per loop pass.
   *
   * @param {BaseAudioContext} context
   * @param {{assetBase?: string, assetBytes?: object}} engineOptions
   * @param {{input?: MediaStream|AudioNode, channels?: number}} [options]
   * @param {(text: string) => void} notifyError
   * @returns {Promise<{node: AudioWorkletNode,
   *                    armAt: function(number): void,
   *                    stopAt: function(number): void,
   *                    splitAt: function(number[]): void,
   *                    onChunk: function(function): function,
   *                    onDone: function(function): function,
   *                    dispose: function(): void}>}
   */
  async function runRecorder(context, engineOptions, options, notifyError) {
    const settings = options || {};
    const input = settings.input;
    if (!input) throw new Error("StudioEngine: createRecorder needs an input (a MediaStream or an AudioNode)");
    const channels = Number(settings.channels) === 2 ? 2 : 1;

    await loadStudioWorklets(context, engineOptions);
    const Node = workletNodeClass();
    const node = new Node(context, RECORDER_PROCESSOR, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: channels,
      channelCountMode: "explicit",
      processorOptions: { channels: channels },
    });

    let source = null;
    // The recorder writes silence to its output, but a host only runs the
    // processors the destination can reach, so it is connected through a gain of
    // 0. A gain node is plumbing (it shapes nothing), which the parity rule
    // allows.
    const alone = context.createGain();
    alone.gain.value = 0;
    if (typeof input.connect === "function") {
      input.connect(node);
    } else if (isMediaStream(input)) {
      if (typeof context.createMediaStreamSource !== "function") {
        throw new Error("StudioEngine: this host cannot read a MediaStream");
      }
      source = context.createMediaStreamSource(input);
      source.connect(node);
    } else {
      throw new Error("StudioEngine: createRecorder needs a MediaStream or an AudioNode as its input");
    }
    node.connect(alone);
    alone.connect(context.destination);

    const chunkListeners = new Set();
    const doneListeners = new Set();
    node.port.onmessage = (event) => {
      const message = event && event.data;
      if (!message || typeof message !== "object") return;
      if (message.type === "chunk") {
        for (const listener of chunkListeners) {
          try {
            listener(message.bytes, message.index, message.segment);
          } catch {
            /* one bad listener must not lose the chunk for the others */
          }
        }
        return;
      }
      if (message.type === "done") {
        const segments = Array.isArray(message.segments) ? message.segments : [];
        let frames = 0;
        for (const segment of segments) frames += Number(segment.frames) || 0;
        const done = {
          segments: segments,
          frames: frames,
          start_frame: segments.length > 0 ? segments[0].start_frame : null,
        };
        for (const listener of doneListeners) {
          try {
            listener(done);
          } catch {
            /* one bad listener must not hide the end from the others */
          }
        }
        return;
      }
      if (message.type === "error") notifyError(String(message.error));
    };
    if (typeof node.port.start === "function") node.port.start();

    const post = (message) => node.port.postMessage(message);

    return {
      node: node,

      /** @param {number} frame the context frame to start capturing at @returns {void} */
      armAt(frame) {
        post({ type: "arm", frame: frameNumber(frame, "armAt") });
      },

      /** @param {number} frame the context frame to stop at (exclusive) @returns {void} */
      stopAt(frame) {
        post({ type: "stop", frame: frameNumber(frame, "stopAt") });
      },

      /**
       * Start a new take segment at each of these context frames (loop record).
       * @param {number[]} frames
       * @returns {void}
       */
      splitAt(frames) {
        const list = [];
        for (const value of Array.isArray(frames) ? frames : []) list.push(frameNumber(value, "splitAt"));
        post({ type: "split", frames: list });
      },

      /**
       * Follow the take's chunks: `listener(bytes, index, segment)`, where
       * `bytes` is a transferred ArrayBuffer of 24-bit little-endian interleaved
       * PCM covering whole frames, at most 1 MiB.
       * @param {(bytes: ArrayBuffer, index: number, segment: number) => void} listener
       * @returns {() => void} unsubscribe
       */
      onChunk(listener) {
        if (typeof listener !== "function") return function noop() {};
        chunkListeners.add(listener);
        return function unsubscribe() {
          chunkListeners.delete(listener);
        };
      },

      /**
       * Follow the end of the take: `listener({segments, frames, start_frame})`.
       * @param {(done: {segments: object[], frames: number,
       *                start_frame: number|null}) => void} listener
       * @returns {() => void} unsubscribe
       */
      onDone(listener) {
        if (typeof listener !== "function") return function noop() {};
        doneListeners.add(listener);
        return function unsubscribe() {
          doneListeners.delete(listener);
        };
      },

      /**
       * Leave the graph and drop this recorder's callbacks. The caller owns the
       * input stream and the context.
       * @returns {void}
       */
      dispose() {
        chunkListeners.clear();
        doneListeners.clear();
        node.port.onmessage = null;
        try {
          node.disconnect();
        } catch {
          /* never connected */
        }
        try {
          alone.disconnect();
        } catch {
          /* never connected */
        }
        if (source) {
          try {
            source.disconnect();
          } catch {
            /* never connected */
          }
        }
      },
    };
  }

  async function createStudioEngine(context, options) {
    if (!context || !context.audioWorklet) throw new Error("StudioEngine: a context with audioWorklet is required");
    const opts = options || {};

    if (ENGINE_CONTEXTS.has(context)) throw new Error(ONE_ENGINE_ERROR);

    // A browser page under a Content-Security-Policy cannot load a worklet
    // from a blob: URL, so it passes `moduleUrl`: the same composed module,
    // served same-origin by the gateway (bundles/studio/server/web.js).
    const texts = [];
    if (!opts.moduleUrl) {
      for (const name of SOURCE_FILES) {
        texts.push(await readText(name, opts));
      }
    }
    const wasmBinary = await readWasm(opts);

    // Claimed synchronously before the registration (and checked again, since
    // the reads above awaited), so two concurrent calls cannot both get as far
    // as `addModule()` and a failure to read an asset does not leave the
    // context unusable.
    if (ENGINE_CONTEXTS.has(context)) throw new Error(ONE_ENGINE_ERROR);
    ENGINE_CONTEXTS.add(context);

    try {
      // One blank line and a semicolon between files: every one of them is a
      // classic script that relies on its own final expression, and the SunVox
      // glue in particular ends without a trailing semicolon.
      if (opts.moduleUrl) await context.audioWorklet.addModule(opts.moduleUrl);
      else await addEngineModule(context, composeEngineModule(texts));
    } catch (error) {
      // Nothing was registered, so a retry on this context is honest.
      ENGINE_CONTEXTS.delete(context);
      throw error;
    }

    const Node = workletNodeClass();
    const node = new Node(context, PROCESSOR_NAME, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      // `testHooks` is off unless a caller asks for it; it arms the processor's
      // two test-only faults (see `throwForTest`). `maxSampleBytes` is left out
      // when the caller names none, so the processor keeps its own 256 MB cap.
      processorOptions: {
        wasmBinary: wasmBinary,
        testHooks: opts.testHooks === true,
        ...(Number(opts.maxSampleBytes) > 0 ? { maxSampleBytes: Number(opts.maxSampleBytes) } : {}),
        ...(Number(opts.maxFontBytes) > 0 ? { maxFontBytes: Number(opts.maxFontBytes) } : {}),
      },
    });

    const listeners = new Set();
    const launchListeners = new Set();
    const errorListeners = new Set();
    const sampleNeededListeners = new Set();
    const libraryNeededListeners = new Set();
    const tapListeners = new Set();
    /**
     * Hand one failure to the error listeners and the console: a fault after
     * start-up has no caller to throw to.
     * @param {string} text
     * @returns {void}
     */
    const notifyError = (text) => {
      for (const listener of errorListeners) {
        try {
          listener(text);
        } catch {
          /* one bad listener must not hide the failure from the others */
        }
      }
      if (typeof console !== "undefined" && typeof console.error === "function") {
        console.error("StudioEngine: " + text);
      }
    };
    const flushes = new Map();
    let flushSeq = 0;
    const barRequests = new Map();
    let barSeq = 0;
    /** take id → resolvers waiting for the processor's `audio_loaded`. */
    const pendingAudio = new Map();
    /** sample id → resolvers waiting for the processor's `sample_loaded`. */
    const pendingSamples = new Map();
    /** request id → the resolver waiting for that load's `library_loaded` / `library_deferred`. */
    const pendingLibrary = new Map();
    let librarySeq = 0;
    /** request id → the resolver waiting for the processor's `looper_buffer`. */
    const pendingLooper = new Map();
    let looperSeq = 0;
    /**
     * The frames the looper's buffers hold in the processor; 0 before the page has
     * sent any. The processor allocates none of its own, so the page keeps this
     * pair sized for eight bars at the song's tempo.
     */
    let looperBufferFrames = 0;
    /** The tempo the song is at, as the last `setSong` read it. */
    let looperSongBpm = DEFAULT_BPM;
    const post = (message, transfer) => {
      if (transfer && transfer.length > 0) {
        try {
          node.port.postMessage(message, transfer);
          return;
        } catch {
          // A host whose port will not take a transfer list still gets the
          // message, just by copying it.
        }
      }
      node.port.postMessage(message);
    };

    /**
     * Hand the processor a fresh pair of looper buffers, transferred rather than
     * copied.
     * @param {Float32Array} left
     * @param {Float32Array} right
     * @returns {void}
     */
    const sendLooperBuffers = (left, right) => {
      post({ type: "looper_buffers", left: left, right: right }, [left.buffer, right.buffer]);
    };

    /**
     * Make sure the processor's looper buffers hold eight bars at the song's
     * current tempo: they are sent before anything records into them, and again,
     * larger, when the song slows down far enough that eight bars no longer fit.
     * Never while a take is out — the looper is detached from its buffers then,
     * and the take hands the same pair back.
     * @param {number} bpm
     * @returns {void}
     */
    const ensureLooperBuffers = (bpm) => {
      const tempo = Number(bpm);
      const usable = Number.isFinite(tempo) && tempo > 0 ? tempo : DEFAULT_BPM;
      if (pendingLooper.size > 0) return;
      const needed = Math.ceil((context.sampleRate * 60 * BEATS_PER_BAR * LOOPER_BARS) / usable);
      if (needed <= looperBufferFrames) return;
      looperBufferFrames = needed;
      sendLooperBuffers(new Float32Array(needed), new Float32Array(needed));
    };

    try {
      await awaitReady(node, opts.readyTimeoutMs || READY_TIMEOUT_MS);
    } catch (error) {
      try {
        node.disconnect();
      } catch {
        /* never connected */
      }
      throw error;
    }

    node.port.onmessage = (event) => {
      const message = event && event.data;
      if (!message || typeof message !== "object") return;
      if (message.type === "flushed") {
        const resolveFlush = flushes.get(message.id);
        if (resolveFlush) {
          flushes.delete(message.id);
          resolveFlush();
        }
        return;
      }
      if (message.type === "position") {
        const position = { bar: message.bar, beat: message.beat, sixteenth: message.sixteenth };
        for (const listener of listeners) {
          try {
            listener(position);
          } catch {
            /* one bad listener must not stop the transport's clock */
          }
        }
        return;
      }
      if (message.type === "launched") {
        const launch = {
          track_id: message.track_id,
          clip_id: message.clip_id === null || message.clip_id === undefined ? null : message.clip_id,
          scene_id: message.scene_id === null || message.scene_id === undefined ? null : message.scene_id,
          bar: message.bar,
          frame: message.frame,
        };
        for (const listener of launchListeners) {
          try {
            listener(launch);
          } catch {
            /* one bad listener must not stop the others hearing about it */
          }
        }
        return;
      }
      if (message.type === "nextBarFrame") {
        const resolveFrame = barRequests.get(message.id);
        if (resolveFrame) {
          barRequests.delete(message.id);
          resolveFrame({ frame: message.frame, bar: message.bar });
        }
        return;
      }
      if (message.type === "audio_loaded") {
        // One ack per `audio` message, in order: resolve the oldest load of
        // that take still waiting, so a re-load never strands an earlier one.
        const waiting = pendingAudio.get(message.take_id);
        if (waiting && waiting.length > 0) {
          const resolveTake = waiting.shift();
          if (waiting.length === 0) pendingAudio.delete(message.take_id);
          resolveTake();
        }
        return;
      }
      if (message.type === "sample_loaded") {
        const waiting = pendingSamples.get(message.sample_id);
        if (waiting && waiting.length > 0) {
          const resolveSample = waiting.shift();
          if (waiting.length === 0) pendingSamples.delete(message.sample_id);
          resolveSample();
        }
        return;
      }
      if (message.type === "library_loaded" || message.type === "library_deferred") {
        // One ack per library message, matched by the request id the load was
        // posted with: a later load of the same font never answers an earlier
        // one. A load resolves with what became of it — `loaded`, `deferred` (it
        // waits for Stop) or `failed` (with the reason the processor gave, which
        // is also posted once per font id as `library_failed`).
        const waiting = pendingLibrary.get(message.request_id);
        if (waiting === undefined) return;
        pendingLibrary.delete(message.request_id);
        if (message.type === "library_deferred") {
          waiting({ status: "deferred" });
          return;
        }
        if (message.ok === false) {
          const reason = message.reason === undefined ? "" : String(message.reason);
          waiting({ status: "failed", reason: reason });
          return;
        }
        waiting({ status: "loaded" });
        return;
      }
      if (message.type === "library_failed") {
        // A bank that will not parse (or that failed while rendering): its tracks
        // are silent and the processor reports it once per font id.
        notifyError(`The instrument ${message.library_id} could not be read: ${message.reason}`);
        return;
      }
      if (message.type === "library_needed") {
        // A track's font is not loaded on this device (never fetched, still
        // uploading, or dropped by the engine's font cap): the page owns the
        // bytes, so it loads them — or offers the download.
        const id = String(message.library_id);
        for (const listener of libraryNeededListeners) {
          try {
            listener(id);
          } catch {
            /* one bad listener must not stop the others hearing about it */
          }
        }
        return;
      }
      if (message.type === "looper_buffer") {
        // The looper's whole bars of the master, for a take this client asked for.
        // The buffers arrive transferred and go straight back: the page keeps only
        // its own copy of the loop's frames (clipped to [−1, 1]), so the looper
        // keeps playing from what it had once they return.
        const left = message.left instanceof Float32Array ? message.left : null;
        const right = message.right instanceof Float32Array ? message.right : null;
        const frames = Math.max(0, Math.trunc(Number(message.frames) || 0));
        const channelFrames = left && right ? Math.min(frames, left.length, right.length) : 0;
        const channels = [
          copyLooperChannel(left, channelFrames),
          copyLooperChannel(right, channelFrames),
        ];
        const rate = Number(message.rate);
        const bars = Number(message.bars);
        if (left && right) {
          try {
            sendLooperBuffers(left, right);
            // A tempo that dropped while the take was out needs its larger buffers
            // now: the looper copies what it holds into the bigger pair.
            ensureLooperBuffers(looperSongBpm);
          } catch {
            // A host that will not take them back leaves the looper silent rather
            // than taking the message path down; the page's copy is already made.
          }
        }
        const waiting = pendingLooper.get(message.id);
        if (waiting) {
          pendingLooper.delete(message.id);
          waiting({
            channels: channels,
            rate: Number.isFinite(rate) ? rate : context.sampleRate,
            bars: Number.isFinite(bars) ? bars : 0,
          });
        }
        return;
      }
      if (message.type === "tap_block") {
        // A tap's copy of one block, for record-into-pad and resampling. The
        // frame is the context frame of the block's first sample: a resample
        // cuts what it keeps on that frame, never by counting blocks.
        const frame = Number(message.frame);
        const tap = {
          target: String(message.target),
          frame: Number.isFinite(frame) ? Math.trunc(frame) : 0,
          channels: Array.isArray(message.channels) ? message.channels : [],
        };
        for (const listener of tapListeners) {
          try {
            listener(tap);
          } catch {
            /* one bad listener must not stop the others hearing about it */
          }
        }
        return;
      }
      if (message.type === "sample_needed") {
        // A trigger wanted a sample the engine does not have (it was unloaded
        // to stay inside the song's byte cap, or it never arrived): the page
        // owns the decoded PCM, so it loads it again.
        const id = String(message.sample_id);
        for (const listener of sampleNeededListeners) {
          try {
            listener(id);
          } catch {
            /* one bad listener must not stop the others hearing about it */
          }
        }
        return;
      }
      // A failure after start-up (a device that cannot be built, a refused
      // song) has no caller to throw to; it is handed to whoever registered an
      // error listener and logged, instead of stopping the audio thread.
      if (message.type === "error") {
        // A failure after start-up (a device that cannot be built, a refused
        // song) has no caller to throw to; it is handed to whoever registered
        // an error listener and logged, instead of stopping the audio thread.
        notifyError(String(message.error));
      }
    };

    /**
     * Hand the processor one object's channels, resampled to the context's rate
     * when they are at another one, and resolve when it acknowledges them.
     *
     * The conversion is `resample.js`'s (the parity rule: no Web Audio node and
     * no `decodeAudioData` ever resamples), in the page's worker when there is
     * one and inline otherwise. `type`/`field` name the port message and the
     * field that carries the id, so takes and samples take the very same path.
     * @param {string} type the port message type ("audio" or "sample")
     * @param {string} field the message field naming the object
     * @param {string} id the take or sample id
     * @param {Map<string, Function[]>} pending the acks still waited for
     * @param {Float32Array[]} channels
     * @param {number} rate the rate those channels are at, in Hz
     * @returns {Promise<void>}
     */
    const sendPcm = (type, field, id, pending, channels, rate) => {
      const list = [];
      for (const channel of Array.isArray(channels) ? channels : []) {
        // A view into a larger buffer is copied: transferring it would hand
        // the processor (and detach here) the whole underlying buffer.
        if (channel instanceof Float32Array) {
          list.push(channel.byteLength === channel.buffer.byteLength ? channel : channel.slice());
        } else {
          list.push(Float32Array.from(channel));
        }
      }
      const from = Number(rate);

      const deliver = (pcm) => {
        // One transfer per underlying buffer: two views of one buffer would ask
        // the port to transfer it twice.
        const transfer = [];
        for (const channel of pcm) {
          if (channel.buffer instanceof ArrayBuffer && transfer.indexOf(channel.buffer) === -1) {
            transfer.push(channel.buffer);
          }
        }
        return new Promise((resolve) => {
          const waiting = pending.get(id) || [];
          waiting.push(resolve);
          pending.set(id, waiting);
          const message = { type: type, channels: pcm };
          message[field] = id;
          post(message, transfer);
        });
      };

      if (!Number.isFinite(from) || from <= 0 || from === context.sampleRate) return deliver(list);

      const convert =
        opts.assetBase && !isNode()
          ? resampleInWorker(opts.assetBase, list, from, context.sampleRate).catch(() =>
              resamplerOf().toRate(list, from, context.sampleRate),
            )
          : Promise.resolve(resamplerOf().toRate(list, from, context.sampleRate));
      return convert.then(deliver);
    };

    return {
      node: node,

      /**
       * Replace the song. The processor refuses more than 16 tracks; so does
       * this, before anything is posted.
       * @param {object} snapshot
       * @returns {void}
       */
      setSong(snapshot) {
        const tracks = snapshot && Array.isArray(snapshot.tracks) ? snapshot.tracks : [];
        if (tracks.length > MAX_TRACKS) throw new Error(`A song can have at most ${MAX_TRACKS} tracks.`);
        post({ type: "song", snapshot: snapshot });
        // The looper's buffers are the page's, so they are sized off this song's
        // tempo before anything can record into them.
        const meta = snapshot && typeof snapshot.meta === "object" && snapshot.meta ? snapshot.meta : {};
        const bpm = Number(meta.bpm);
        looperSongBpm = Number.isFinite(bpm) && bpm > 0 ? bpm : DEFAULT_BPM;
        // Only a looper that is in use holds buffers: an engine that just plays (an
        // offline render, say) never allocates eight bars of them. They are sent
        // before the first record instead, and grown here if the song slowed down.
        if (looperBufferFrames > 0) ensureLooperBuffers(looperSongBpm);
      },

      /** @param {string} id @returns {void} */
      launchScene(id) {
        post({ type: "launchScene", id: id });
      },

      /** @param {string} id @returns {void} */
      launchClip(id) {
        post({ type: "launchClip", id: id });
      },

      /** @param {string} id @returns {void} */
      stopTrack(id) {
        post({ type: "stopTrack", id: id });
      },

      /** @returns {void} */
      stopAll() {
        post({ type: "stopAll" });
      },

      /** @returns {void} */
      play() {
        post({ type: "play" });
      },

      /** @returns {void} */
      stop() {
        post({ type: "stop" });
      },

      /**
       * Choose what the transport plays: the session grid (`"session"`, the
       * default, where `launchScene`/`launchClip` arm clips) or the song's
       * arrangement (`"arrangement"`, where its placements sound on their
       * bars and launches are ignored). Switching closes every sounding note
       * and voice and resets what each track plays.
       * @param {"session"|"arrangement"} mode anything else means `"session"`
       * @returns {void}
       */
      setMode(mode) {
        post({ type: "setMode", mode: mode === "arrangement" ? "arrangement" : "session" });
      },

      /**
       * Move the arrangement playhead to a bar. The next block plays from that
       * bar — the takes the timeline holds there start at that very frame —
       * and the notes and voices that were sounding are closed first.
       * @param {number} bar the 0-based bar; anything below 0 is bar 0
       * @returns {void}
       */
      seek(bar) {
        post({ type: "seek", bar: Number(bar) });
      },

      /**
       * Resolve once the processor has applied every message posted before
       * this call. Port messages are asynchronous, so an offline render must
       * await this between its last command and startRendering(), or the
       * render can begin before the song arrives (a browser's
       * OfflineAudioContext does).
       * @returns {Promise<void>}
       */
      flush() {
        const id = ++flushSeq;
        return new Promise((resolve) => {
          flushes.set(id, resolve);
          post({ type: "flush", id: id });
        });
      },

      /**
       * Follow the transport position.
       * @param {(position: {bar: number, beat: number, sixteenth: number}) => void} listener
       * @returns {() => void} unsubscribe
       */
      onPosition(listener) {
        if (typeof listener !== "function") return function noop() {};
        listeners.add(listener);
        return function unsubscribe() {
          listeners.delete(listener);
        };
      },

      /**
       * Follow the launches the engine applied: one report per launch or stop,
       * with the AudioContext frame it took effect at and its 0-based bar. This
       * is what a recorder arms from, so it is never rounded or resequenced
       * here.
       * @param {(launch: {track_id: string, clip_id: string|null,
       *                   scene_id: string|null, bar: number, frame: number}) => void} listener
       * @returns {() => void} unsubscribe
       */
      onLaunch(listener) {
        if (typeof listener !== "function") return function noop() {};
        launchListeners.add(listener);
        return function unsubscribe() {
          launchListeners.delete(listener);
        };
      },

      /**
       * The next bar boundary, on the engine's clock: `frame` is an
       * AudioContext frame and `bar` is the 0-based bar it belongs to. While
       * the transport is stopped this is the frame bar 0 would start at. It is
       * the same boundary the sequencer quantizes launches to, so a recorder
       * that arms here and a launch report name the very same frame.
       *
       * Resolves when the processor answers; a processor that has failed never
       * does, so callers should not depend on it after an error.
       * @returns {Promise<{frame: number, bar: number}>}
       */
      nextBarFrame() {
        const id = ++barSeq;
        return new Promise((resolve) => {
          barRequests.set(id, resolve);
          post({ type: "nextBarFrame", id: id });
        });
      },

      /**
       * Hand the processor one object's PCM, already decoded.
       *
       * The processor plays takes and samples at the context's own rate, so
       * PCM recorded (or imported) at another rate is converted here first, on
       * the client, with `resample.js` — never by the context or by
       * `decodeAudioData` (the parity rule). In a browser the conversion runs in
       * the page's resampling worker (`${assetBase}resample-worker.js`), so a
       * long take does not block the panel; a host without one (Node, a worker
       * that would not load) converts inline with the very same file.
       *
       * The converted channels are transferred to the processor rather copied,
       * so the caller must not use the arrays it passed after the promise
       * resolves.
       * @param {string} takeId
       * @param {Float32Array[]} channels the take's decoded samples, one per channel
       * @param {number} rate the rate those samples are at, in Hz
       * @returns {Promise<void>} resolves when the processor has the PCM
       */
      loadAudio(takeId, channels, rate) {
        return sendPcm("audio", "take_id", String(takeId), pendingAudio, channels, rate);
      },

      /**
       * Hand the engine one sampled pad's PCM, resampled to the context's rate
       * exactly as `loadAudio` does, into the processor's sample store. The
       * promise resolves when the processor has it.
       *
       * The channels are transferred, so the caller must not use the arrays it
       * passed once this resolves (the page keeps its own copy, which is what a
       * reload after a `sample_needed` needs).
       * @param {string} sampleId
       * @param {Float32Array[]} channels the sample's decoded PCM, one per channel
       * @param {number} rate the rate those samples are at, in Hz
       * @returns {Promise<void>} resolves when the processor has the PCM
       */
      loadSample(sampleId, channels, rate) {
        return sendPcm("sample", "sample_id", String(sampleId), pendingSamples, channels, rate);
      },

      /**
       * Drop one take's PCM from the engine (a comp that no longer uses it).
       * @param {string} takeId
       * @returns {void}
       */
      unloadAudio(takeId) {
        post({ type: "audio_unload", take_id: String(takeId) });
      },

      /**
       * Drop one sampled pad's PCM from the engine.
       * @param {string} sampleId
       * @returns {void}
       */
      unloadSample(sampleId) {
        post({ type: "sample_unload", sample_id: String(sampleId) });
      },

      /**
       * Follow the samples a trigger wanted but the engine did not have: the
       * song holds at most 256 MB of decoded samples, so the least-recently
       * played one is unloaded and the page loads it back when a pattern asks
       * for it again.
       * @param {(sampleId: string) => void} listener
       * @returns {() => void} unsubscribe
       */
      onSampleNeeded(listener) {
        if (typeof listener !== "function") return function noop() {};
        sampleNeededListeners.add(listener);
        return function unsubscribe() {
          sampleNeededListeners.delete(listener);
        };
      },

      /**
       * Hand the processor one library FILE, already read (there is no fetch in
       * the worklet): a SoundFont bank today (`kind: "font"`). The bytes are
       * transferred, so the caller must not use the array it passed once this
       * resolves.
       *
       * A bank is parsed only while the transport is stopped (the plan's loading
       * rule). A load posted while the song plays is parked and parsed on the
       * next `stop()`, and resolves `{status: "deferred"}` at once — the page
       * shows "Loads when you stop." in the meantime. Each load carries its own
       * request id, so its promise settles for THAT load and never for another
       * load of the same font.
       * @param {string} libraryId
       * @param {string} kind `"font"` (a capture or cabinet is acknowledged and
       *   left to the host that reads them)
       * @param {Uint8Array|ArrayBuffer|ArrayBufferView} bytes the file itself
       * @returns {Promise<{status: "loaded"|"deferred"|"failed", reason?: string}>}
       *   `failed` carries why: a bank that will not parse, one with no
       *   instruments, or one the song's own fonts have left no room for; an
       *   empty id is refused here, before anything is posted
       */
      loadLibrary(libraryId, kind, bytes) {
        // An empty id names nothing: answer at once, without posting a message
        // the processor would only have to ignore.
        if (libraryId === undefined || libraryId === null || String(libraryId) === "") {
          return Promise.resolve({ status: "failed", reason: "A library load needs an id." });
        }
        const id = String(libraryId);
        const data = bytesOf(bytes);
        // A view into a larger buffer is copied: transferring it would hand the
        // processor (and detach here) the whole underlying buffer.
        const payload = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? data : data.slice();
        librarySeq += 1;
        const requestId = librarySeq;
        return new Promise((resolve) => {
          pendingLibrary.set(requestId, resolve);
          post(
            { type: "library", request_id: requestId, library_id: id, kind: String(kind || "font"), bytes: payload },
            [payload.buffer],
          );
        });
      },

      /**
       * Drop one library file's bytes from the engine (a font the song no longer
       * plays). A track that still names it asks for it again, exactly as an
       * evicted font does.
       * @param {string} libraryId
       * @returns {void}
       */
      unloadLibrary(libraryId) {
        post({ type: "library_unload", library_id: String(libraryId) });
      },

      /**
       * Follow the fonts a track wanted but the engine does not hold: one per
       * font id, once — the page loads the file it has, or offers the download
       * for one it does not.
       * @param {(libraryId: string) => void} listener
       * @returns {() => void} unsubscribe
       */
      onLibraryNeeded(listener) {
        if (typeof listener !== "function") return function noop() {};
        libraryNeededListeners.add(listener);
        return function unsubscribe() {
          libraryNeededListeners.delete(listener);
        };
      },

      /**
       * Audition one pad: a live trigger that goes straight to a voice, never
       * through a command or a history step, and is never quantized to the bar.
       * A `oneshot` pad plays to its end; a `gate` pad holds until
       * `liveRelease`.
       * @param {string} trackId
       * @param {string} bankId
       * @param {number} index the pad, 0-15
       * @param {number} velocity 1-127
       * @returns {void}
       */
      livePad(trackId, bankId, index, velocity) {
        const v = Number(velocity);
        post({
          type: "live",
          track_id: String(trackId),
          bank_id: bankId === undefined || bankId === null ? "" : String(bankId),
          index: Math.trunc(Number(index) || 0),
          v: Number.isFinite(v) ? v : 127,
          on: true,
        });
      },

      /**
       * Release the `gate` voices one pad's live presses started. A `oneshot`
       * voice is left alone: a one-shot pad plays to the end of its range, as
       * `livePad` says.
       * @param {string} trackId
       * @param {string} bankId
       * @param {number} index the pad, 0-15
       * @returns {void}
       */
      liveRelease(trackId, bankId, index) {
        post({
          type: "live",
          track_id: String(trackId),
          bank_id: bankId === undefined || bankId === null ? "" : String(bankId),
          index: Math.trunc(Number(index) || 0),
          v: 0,
          on: false,
        });
      },

      /**
       * Turn a tap on or off: `"master"` for the mix, or a track's id for that
       * track's own output. While a tap is on the processor posts one
       * `{type:"tap_block", target, frame, channels}` per block, which is what
       * record-into-pad and resampling record. Off by default, and off costs
       * nothing.
       * @param {string} target "master" or a track id
       * @param {boolean} on
       * @returns {void}
       */
      tap(target, on) {
        post({ type: "tap", target: String(target), on: on === true });
      },

      /**
       * Hold one performance effect on the master bus. The effect is live state:
       * it never enters the song, never becomes a history step, and nothing but
       * `fxRelease` (a scene launch, a transport stop, a pattern change) ends it.
       *
       * `amount` is 0..1 and means what the effect makes of it; a `fxHold` on an
       * effect that is already held follows the amount, which is how a knob
       * sweeps the filter.
       * @param {"filter_sweep"|"lofi"|"stutter"|"tape_stop"|"reverb_throw"} name
       * @param {number} amount 0..1
       * @returns {void}
       */
      fxHold(name, amount) {
        const value = Number(amount);
        post({ type: "fx", name: String(name), amount: Number.isFinite(value) ? value : 0, on: true });
      },

      /**
       * Let one performance effect go: it crossfades back to the dry master over
       * 64 frames (the reverb throw closes its send and rings out).
       * @param {string} name
       * @returns {void}
       */
      fxRelease(name) {
        post({ type: "fx", name: String(name), amount: 0, on: false });
      },

      /**
       * One looper command on the master bus, quantized to the sequencer's next bar
       * line: `record` starts there, the next `play`/`overdub`/`record` ends the
       * take on the bar line after it, `play` loops it into the master, `overdub`
       * adds the live master into it, `clear` empties it.
       *
       * The looper's buffers are this page's (the audio thread allocates none), so a
       * command that records sends a pair sized for eight bars at the song's tempo
       * first — before the bar line it is quantized to, on the same port.
       * @param {"record"|"overdub"|"play"|"stop"|"clear"} action
       * @returns {void}
       */
      looper(action) {
        const what = String(action);
        if (what === "record" || what === "overdub") ensureLooperBuffers(looperSongBpm);
        post({ type: "looper", action: what });
      },

      /**
       * The looper's take: whole bars of the master it recorded, in two channels
       * at the context's rate, clipped to [−1, 1]. Record-into-pad turns it into a
       * sample.
       *
       * The processor transfers its looper buffers here; this copies the loop's
       * frames out of them and transfers the same buffers straight back, so the
       * looper plays on from where it was. While they are away (a moment, and only
       * for a take) the looper contributes silence.
       *
       * Resolves when the processor answers, with a snapshot of the take at the
       * moment it read the request: a take that is still recording answers the
       * whole bars it has captured so far, and a looper that has recorded nothing
       * answers no bars.
       * @returns {Promise<{channels: Float32Array[], rate: number, bars: number}>}
       */
      looperTake() {
        const id = ++looperSeq;
        return new Promise((resolve) => {
          pendingLooper.set(id, resolve);
          post({ type: "looper_take", id: id });
        });
      },

      /**
       * Follow a tap: one `{target, frame, channels}` per block while one is on,
       * `target` being "master" or the tapped track's id, `frame` the context
       * frame of the block's first sample, and `channels` the block's own copies
       * (the tap never shares its mix's buffers).
       * @param {(tap: {target: string, frame: number, channels: Float32Array[]}) => void} listener
       * @returns {() => void} unsubscribe
       */
      onTap(listener) {
        if (typeof listener !== "function") return function noop() {};
        tapListeners.add(listener);
        return function unsubscribe() {
          tapListeners.delete(listener);
        };
      },

      /**
       * Follow the engine's failures (a device that could not be built, a song
       * the processor refused, a fault it survived). They are also logged.
       * @param {(text: string) => void} listener
       * @returns {() => void} unsubscribe
       */
      onError(listener) {
        if (typeof listener !== "function") return function noop() {};
        errorListeners.add(listener);
        return function unsubscribe() {
          errorListeners.delete(listener);
        };
      },

      /**
       * Test hook: ask the processor to throw inside its next `process()`, to
       * prove the block body's guard reports once and goes silent instead of
       * taking the host's audio thread down. Refused unless the engine was
       * created with `{testHooks: true}`, because the processor ignores the
       * message in that case and a silent no-op would be a lie.
       * @returns {void}
       */
      throwForTest() {
        if (opts.testHooks !== true) throw new Error("StudioEngine: test hooks are not enabled on this engine");
        post({ type: "__throw" });
      },

      /**
       * Measure the round trip of a loopback cable, in context frames.
       *
       * The emitter clicks, the detector finds each click by cross-correlation
       * and reports its lag; the first two clicks are ignored and the median of
       * the rest is the answer. Fewer than 10 heard clicks, or lags spread over
       * more than 2 ms, is refused with "Check the loopback cable and the input
       * gain." Both nodes are cleaned up either way.
       *
       * `latencyHint` and `sinkId` are echoed into the result rather than applied
       * here: they belong to the context the caller created, and the panel keys
       * the stored measurement on them.
       * @param {{input: MediaStream|AudioNode, clicks?: number, latencyHint?: string,
       *          sinkId?: string, interval?: number,
       *          onEmitter?: function(AudioWorkletNode): void}} options
       * @returns {Promise<{latency_frames: number, rate: number,
       *                    spread_frames: number, clicks_heard: number,
       *                    latencyHint: string|null, sinkId: string|null}>}
       */
      calibrate(options) {
        return runCalibration(context, opts, options, notifyError);
      },

      /**
       * Build a recorder on this context: `{armAt, stopAt, splitAt, onChunk,
       * onDone, dispose}` (see `runRecorder` above for the whole contract).
       * @param {{input: MediaStream|AudioNode, channels?: number}} options
       * @returns {Promise<object>}
       */
      createRecorder(options) {
        return runRecorder(context, opts, options, notifyError);
      },

      /**
       * Stop listening and leave the graph. The caller owns the context and the
       * node's connections; this only drops this client's port handler.
       * @returns {void}
       */
      dispose() {
        listeners.clear();
        launchListeners.clear();
        errorListeners.clear();
        sampleNeededListeners.clear();
        libraryNeededListeners.clear();
        tapListeners.clear();
        pendingAudio.clear();
        pendingSamples.clear();
        pendingLibrary.clear();
        pendingLooper.clear();
        node.port.onmessage = null;
      },
    };
  }

  const api = {
    create: createStudioEngine,
    createStudioEngine: createStudioEngine,
    copyLooperChannel: copyLooperChannel,
    SOURCE_FILES: SOURCE_FILES,
    WORKLET_FILES: WORKLET_FILES,
    composeEngineModule: composeEngineModule,
    PROCESSOR_NAME: PROCESSOR_NAME,
    CALIBRATE_EMITTER_PROCESSOR: CALIBRATE_EMITTER_PROCESSOR,
    CALIBRATE_DETECTOR_PROCESSOR: CALIBRATE_DETECTOR_PROCESSOR,
    RECORDER_PROCESSOR: RECORDER_PROCESSOR,
    CALIBRATION_REFUSAL: CALIBRATION_REFUSAL,
    loadWorklets: loadStudioWorklets,
  };

  if (typeof globalThis !== "undefined") globalThis.StudioEngine = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();