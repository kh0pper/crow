/**
 * Studio engine client — builds the worklet and posts the song to it.
 *
 * The engine is one AudioWorklet node whose processor hosts SunVox and the
 * sequencer (`studio-processor.js`). A worklet cannot `import`, so this file
 * glues four sources into ONE module and hands it to
 * `audioWorklet.addModule()`:
 *
 *     sequencer.js + resample.js + sunvox.js + studio-processor.js
 *
 * `resample.js` rides along so the worklet scope has the very same resampler a
 * page does (`StudioResample`), even though the conversion itself happens on
 * the client side of the port, before the PCM is handed over.
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
 * - `flush()` resolves once every message posted before it has been applied.
 * - `loadAudio(take_id, channels, rate)` hands the processor one take's PCM,
 *   resampled here to the context's rate when the take was recorded at another
 *   one, and resolves when the processor has it. `unloadAudio(take_id)` drops
 *   it again.
 */
(function () {
  "use strict";

  /** The files that make up the worklet module, in concatenation order. */
  const SOURCE_FILES = ["sequencer.js", "resample.js", "sunvox.js", "studio-processor.js"];

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

  /** How long to wait for the worklet to report ready. */
  const READY_TIMEOUT_MS = 20000;

  /** A song can have at most this many SunVox tracks (one engine each). */
  const MAX_TRACKS = 16;

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
      // outside this module's own directory.
      if (name !== path.basename(name)) return null;
      const file = path.join(__dirname, name);
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
   *          testHooks?: boolean}} options
   *   `assetBase` is a URL prefix the engine files are fetched from;
   *   `assetBytes` is a map of file name → string/Uint8Array, which wins over
   *   `assetBase` for the names it holds (Node callers read the files
   *   themselves); `testHooks` arms the processor's test-only faults
   * @returns {Promise<{node: AudioWorkletNode,
   *                    setSong: function(object): void,
   *                    launchScene: function(string): void,
   *                    launchClip: function(string): void,
   *                    stopTrack: function(string): void,
   *                    stopAll: function(): void,
   *                    play: function(): void,
   *                    stop: function(): void,
   *                    flush: function(): Promise<void>,
   *                    onPosition: function(function): function,
   *                    onLaunch: function(function): function,
   *                    nextBarFrame: function(): Promise<{frame: number, bar: number}>,
   *                    onError: function(function): function,
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
      // two test-only faults (see `throwForTest`).
      processorOptions: { wasmBinary: wasmBinary, testHooks: opts.testHooks === true },
    });

    const listeners = new Set();
    const launchListeners = new Set();
    const errorListeners = new Set();
    const flushes = new Map();
    let flushSeq = 0;
    const barRequests = new Map();
    let barSeq = 0;
    /** take id → resolvers waiting for the processor's `audio_loaded`. */
    const pendingAudio = new Map();
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
        const resolveTake = pendingAudio.get(message.take_id);
        if (resolveTake) {
          pendingAudio.delete(message.take_id);
          resolveTake();
        }
        return;
      }
      // A failure after start-up (a device that cannot be built, a refused
      // song) has no caller to throw to; it is handed to whoever registered an
      // error listener and logged, instead of stopping the audio thread.
      if (message.type === "error") {
        const text = String(message.error);
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
      }
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
       * Hand the engine one take's PCM, already decoded.
       *
       * The processor plays takes at the context's own rate, so a take recorded
       * at another rate is converted here first, on the client, with
       * `resample.js` — never by the context or by `decodeAudioData` (the parity
       * rule). The channels are transferred rather than copied, so the caller
       * must not use the arrays it passed after the promise resolves.
       *
       * TODO(Task 7): the panel runs this conversion in a Worker, so a long
       * take does not block the page; this inline path is what the panel falls
       * back to and what a Node render uses.
       * @param {string} takeId
       * @param {Float32Array[]} channels the take's decoded samples, one per channel
       * @param {number} rate the rate those samples are at, in Hz
       * @returns {Promise<void>} resolves when the processor has the PCM
       */
      loadAudio(takeId, channels, rate) {
        const id = String(takeId);
        const list = [];
        for (const channel of Array.isArray(channels) ? channels : []) {
          list.push(channel instanceof Float32Array ? channel : Float32Array.from(channel));
        }
        const from = Number(rate);
        const pcm =
          Number.isFinite(from) && from > 0 && from !== context.sampleRate
            ? resamplerOf().toRate(list, from, context.sampleRate)
            : list;

        // One transfer per underlying buffer: two views of one buffer would
        // ask the port to transfer it twice.
        const transfer = [];
        for (const channel of pcm) {
          if (channel.buffer instanceof ArrayBuffer && transfer.indexOf(channel.buffer) === -1) {
            transfer.push(channel.buffer);
          }
        }

        return new Promise((resolve) => {
          pendingAudio.set(id, resolve);
          post({ type: "audio", take_id: id, channels: pcm }, transfer);
        });
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
       * Stop listening and leave the graph. The caller owns the context and the
       * node's connections; this only drops this client's port handler.
       * @returns {void}
       */
      dispose() {
        listeners.clear();
        launchListeners.clear();
        errorListeners.clear();
        pendingAudio.clear();
        node.port.onmessage = null;
      },
    };
  }

  const api = {
    create: createStudioEngine,
    createStudioEngine: createStudioEngine,
    SOURCE_FILES: SOURCE_FILES,
    composeEngineModule: composeEngineModule,
    PROCESSOR_NAME: PROCESSOR_NAME,
  };

  if (typeof globalThis !== "undefined") globalThis.StudioEngine = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();