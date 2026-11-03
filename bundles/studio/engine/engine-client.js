/**
 * Studio engine client — builds the worklet and posts the song to it.
 *
 * The engine is one AudioWorklet node whose processor hosts SunVox and the
 * sequencer (`studio-processor.js`). A worklet cannot `import`, so this file
 * glues three sources into ONE module and hands it to
 * `audioWorklet.addModule()`:
 *
 *     sequencer.js + sunvox.js + studio-processor.js
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
 */
(function () {
  "use strict";

  /** The files that make up the worklet module, in concatenation order. */
  const SOURCE_FILES = ["sequencer.js", "sunvox.js", "studio-processor.js"];

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
   * @param {string} name
   * @param {{assetBase?: string, assetBytes?: object}} options
   * @returns {Promise<string>}
   */
  async function readText(name, options) {
    const supplied = options.assetBytes;
    if (supplied && supplied[name] !== undefined) return textOf(supplied[name]);
    if (!options.assetBase) throw new Error(`StudioEngine: no ${name} in assetBytes and no assetBase`);
    const response = await fetch(joinUrl(options.assetBase, name));
    if (!response.ok) throw new Error(`StudioEngine: could not load ${name} (${response.status})`);
    return response.text();
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
    const errorListeners = new Set();
    const flushes = new Map();
    let flushSeq = 0;
    const post = (message) => node.port.postMessage(message);

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
        errorListeners.clear();
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