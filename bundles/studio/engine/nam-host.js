/**
 * Studio's NAM host — Neural Amp Modeler captures, in the engine's one worklet.
 *
 * `neural-amp-modeler-wasm` ships an Emscripten engine (an A2 model's WaveNet in
 * WebAssembly) and a glue that fetches and compiles it. A worklet cannot fetch
 * anything, so the page (or a render) reads `vendor/nam/nam-engine.wasm` and the
 * processor compiles it ONCE per page from those bytes, shared by every amp
 * insert; each amp insert OBJECT then owns one NAM instance id inside that one
 * module (an object, not a document id: a chain edit that crossfades an amp out
 * and back in runs two runners for one insert, and each needs its own state). The
 * model's own JSON also arrives over the port (`{type:"library", kind:"nam"}`),
 * because there is no fetch on the audio thread either (plan 1d, Task 13;
 * spec §16 S6).
 *
 * ## What this file is
 *
 * A classic script like the rest of the engine (`engine-client.js` glues these
 * files into the worklet module), so it assigns `globalThis.StudioNamHost` for
 * the worklet scope and `module.exports` when a CommonJS `module` exists.
 * `engine/package.json` marks the directory `"commonjs"` for that reason.
 *
 * The vendored engine itself is `vendor/nam/nam.js` (built by
 * `tools/build-vendor.mjs`): one import-free script that defines
 * `globalThis.StudioNam = { createNamEngine }`. A checkout that has not run that
 * build has no engine, and this host says so instead of throwing: an amp insert
 * with no engine plays silence and is reported, exactly as one whose capture is
 * missing (Review Focus 1: nothing on the audio thread throws).
 *
 * ## The exports it drives
 *
 *     _nam_createInstance(rate, frames)      one instance id per amp insert object
 *     _nam_getBuffer(id)                     that instance's mono block (128 frames)
 *     _nam_loadModel(id, jsonPtr, slimSize)  0 on success, else _nam_getLastError
 *     _nam_unloadModel(id)  _nam_destroyInstance(id)
 *     _nam_process(id, frames)               in place: the block is the buffer
 *     _nam_isSlimmable(id)  _nam_getSlimmableBreakpointCount/…(id, i)
 *     _nam_setSlimmableSize(id, size)
 *     _nam_getExpectedSampleRate(id)         the rate the capture was trained at
 *     _malloc  _free  HEAPF32  UTF8ToString  stringToUTF8  lengthBytesUTF8
 *
 * ## "Loads when you stop."
 *
 * Parsing a `.nam` (a `JSON.parse` of up to 20 MB, then the engine's own parse)
 * happens ONLY while the transport is stopped (plan 1d, Global Constraints). The
 * PROCESSOR owns that rule — it parks a load that arrives while the song plays,
 * and a capture an amp is ASKED to switch to, and calls `loadModel` on the next
 * Stop (see `loadLibrary` and `attachCapture` in studio-processor.js) — so this
 * host's `loadModel` never has to look at a transport: by the time it runs, the
 * song is stopped. The same JSON is parsed no more than once per library entry:
 * `checkCapture` remembers what `captureProblem` said, keyed by the entry's id, so
 * a second insert that plays the same capture reuses the answer.
 *
 * ## Formats
 *
 * A2 captures only. A capture whose `architecture` is anything else is refused
 * with the plan's sentence, word for word (`LEGACY_CAPTURE_TEXT`), and a file
 * that is not a capture at all with `NOT_A_CAPTURE_TEXT`. Both are thrown to the
 * processor, which reports the reason ONCE and leaves that insert silent (Review
 * Focus 1). Nothing here plays pass-through: a capture that cannot be played is
 * silence, never the dry guitar.
 *
 * ## Slim sizes
 *
 * An A2 capture carries a container of submodels, each covering a range of
 * "slim" sizes; a smaller one is less CPU for a slightly different sound. It is
 * chosen PER PAGE and never written to the document (`slimSizeOf`): a page that
 * reports four cores or fewer gets the smallest submodel, everything else the
 * full model, and a host with no `navigator` at all (a Node render) always the
 * full one — so a render is the sound the document names, and the null test
 * against Chromium compares like with like.
 *
 * ## Sample rate
 *
 * A capture says which rate it was trained at (`_nam_getExpectedSampleRate`).
 * When that is not the context's rate, the amp insert converts its audio to the
 * capture's rate and back with `createBridge` below: the windowed-sinc
 * arithmetic `engine/resample.js` converts takes with, made STREAMING and with a
 * precomputed polyphase table (no trig per sample, nothing allocated).
 *
 * The kernel is SYMMETRIC and centred on the output position, so the converter
 * is a real anti-alias filter: its cutoff sits at 0.95 of the LOWER Nyquist, so
 * 96k↔48k and 44.1k↔48k do not fold anything back into the band. That costs
 * HALF_TAPS of look-ahead, i.e. a real delay — which is why the converter
 * REPORTS it (`latencyFrames`, in its own output frames) instead of claiming
 * zero: the insert adds both converters' delays up, publishes the sum as its
 * own `latencyFrames`, and the runner system primes for it exactly as it does
 * for the master limiter's look-ahead.
 *
 * The conversion is deterministic: only `+ - * /`, `Math.floor`/`Math.round`
 * and the kernel table's build-time `sin`/`cos` (the same discipline
 * `engine/resample.js` states), with a `Float32Array` output — so a page and a
 * render produce the same bits.
 */
(function () {
  "use strict";

  /**
   * What an older NAM model is told: the plan's sentence, word for word (the
   * gateway, the page and the worklet all say the same thing).
   */
  const LEGACY_CAPTURE_TEXT =
    "This capture uses an older NAM format; Studio plays A2 captures. Re-export it with a current NAM trainer.";

  /** What a file that is not a capture at all is told. */
  const NOT_A_CAPTURE_TEXT = "This file is not a NAM capture.";

  /** The NAM architecture Studio plays: an A2 model (plan 1d, Formats). */
  const A2_ARCHITECTURE = "SlimmableContainer";

  /** The top-level key a capture declares its architecture in. */
  const ARCHITECTURE_KEY = "architecture";

  /** What "no slim" means to the engine: negative selects the full model. */
  const FULL_MODEL = -1;

  /** The frames one NAM instance's own block buffer holds (the render quantum). */
  const QUANTUM_FRAMES = 128;

  /** A page at this many cores or fewer gets the smallest submodel. */
  const SLIM_CORES = 4;

  /** How many taps the streaming converter's symmetric kernel has. */
  const BRIDGE_TAPS = 32;

  /** The taps either side of the output position (`BRIDGE_TAPS / 2`). */
  const BRIDGE_HALF = BRIDGE_TAPS / 2;

  /**
   * How many phases the polyphase table holds. The position inside one input
   * frame is rounded onto this grid, so a tap's weight is a table read instead of
   * a `sin` per sample per tap. 512 phases put the quantization at 1/512 of an
   * input frame, far below anything audible.
   */
  const BRIDGE_PHASES = 512;

  /** Where the converter's cutoff sits below the lower Nyquist (as resample.js). */
  const BRIDGE_CUTOFF_SCALE = 0.95;

  /** A node board whose engine reports "unknown" for a capture's rate. */
  const UNKNOWN_RATE = -1;

  /**
   * A `.nam` file's text as a JS string.
   *
   * A capture is up to 20 MB, so the host's own decoder is used when it has one
   * (`TextDecoder`, which every browser worklet and Node have); the hand-written
   * decoder below is the fallback for a host without it. A malformed byte becomes
   * U+FFFD either way, which `JSON.parse` then refuses as the broken capture it
   * is.
   * @param {Uint8Array|ArrayBuffer|ArrayBufferView} value
   * @returns {string}
   */
  function textOfBytes(value) {
    let bytes;
    if (value instanceof Uint8Array) bytes = value;
    else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
    else if (ArrayBuffer.isView(value)) {
      bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    } else return "";
    if (typeof TextDecoder === "function") {
      try {
        return new TextDecoder("utf-8").decode(bytes);
      } catch {
        /* a host that has the name but not the decoder: fall through */
      }
    }
    const parts = [];
    let chunk = "";
    for (let at = 0; at < bytes.length; at += 1) {
      const first = bytes[at];
      if (first < 0x80) {
        chunk += String.fromCharCode(first);
      } else if (first >= 0xc0 && first <= 0xdf && at + 1 < bytes.length) {
        chunk += String.fromCharCode(((first & 0x1f) << 6) | (bytes[at + 1] & 0x3f));
        at += 1;
      } else if (first >= 0xe0 && first <= 0xef && at + 2 < bytes.length) {
        chunk += String.fromCharCode(
          ((first & 0x0f) << 12) | ((bytes[at + 1] & 0x3f) << 6) | (bytes[at + 2] & 0x3f),
        );
        at += 2;
      } else if (first >= 0xf0 && first <= 0xf7 && at + 3 < bytes.length) {
        const code =
          ((first & 0x07) << 18) |
          ((bytes[at + 1] & 0x3f) << 12) |
          ((bytes[at + 2] & 0x3f) << 6) |
          (bytes[at + 3] & 0x3f);
        const offset = code - 0x10000;
        chunk += String.fromCharCode(0xd800 + (offset >> 10), 0xdc00 + (offset & 0x3ff));
        at += 3;
      } else {
        chunk += "\ufffd";
      }
      // Long captures are copied in blocks, so the transient strings stay small.
      if (chunk.length >= 8192) {
        parts.push(chunk);
        chunk = "";
      }
    }
    parts.push(chunk);
    return parts.join("");
  }

  /**
   * The slim size a page should ask for, or the full model.
   *
   * The engine selects the first submodel whose `max_value` is greater than the
   * size it is given, so the smallest submodel is the range below the FIRST
   * breakpoint; the midpoint of that range (half the breakpoint) is what this
   * returns, which cannot round onto the boundary. A page with more than
   * `SLIM_CORES` cores, an unknown core count, and every host without a
   * `navigator` (Node) get the full model.
   * @param {number[]} breakpoints the model's own breakpoints, ascending
   * @param {number} cores how many cores the page reports
   * @returns {number} the size to hand the engine (negative is the full model)
   */
  function slimSizeOf(breakpoints, cores) {
    const count = Number(cores);
    if (!Number.isFinite(count) || count <= 0 || count > SLIM_CORES) return FULL_MODEL;
    const list = Array.isArray(breakpoints) ? breakpoints : [];
    let smallest = Infinity;
    for (const value of list) {
      const number = Number(value);
      if (!Number.isFinite(number) || number <= 0) continue;
      if (number < smallest) smallest = number;
    }
    if (!Number.isFinite(smallest)) return FULL_MODEL;
    return smallest * 0.5;
  }

  /**
   * The cores a PAGE reports: the number `engine-client.js` measured on the main
   * thread and passed to the processor, or — when this host is used on its own
   * (a test) — the nearest `navigator.hardwareConcurrency`.
   *
   * A Node host answers 0 (the full model): Node has a `navigator` with a core
   * count, and a RENDER must not depend on how many cores the machine that
   * rendered it happens to have — its sound is the document's (plan 1d). Never
   * throws: a locked-down worklet scope may not have a `navigator` at all.
   * @returns {number}
   */
  function pageCores() {
    try {
      const versions = globalThis.process && globalThis.process.versions;
      if (versions && versions.node) return 0;
      const navigator = globalThis.navigator;
      const cores = Number(navigator && navigator.hardwareConcurrency);
      return Number.isFinite(cores) && cores > 0 ? cores : 0;
    } catch {
      return 0;
    }
  }

  /** @returns {number} the value when it is a finite number, else 0. */
  function finite(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  /** @returns {number} the value when it is a finite number, else `fallback`. */
  function positive(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
  }

  /**
   * How a capture's own rate is described: `-1` (unknown) and anything
   * unusable mean "the context's rate", which needs no conversion at all.
   * @param {number} expected the engine's answer
   * @param {number} contextRate
   * @returns {number}
   */
  function usableRate(expected, contextRate) {
    const value = Number(expected);
    if (!Number.isFinite(value) || value <= 0 || value === UNKNOWN_RATE) return contextRate;
    return value;
  }

  /**
   * Build one converter's polyphase kernel: `BRIDGE_PHASES` rows of
   * `BRIDGE_TAPS` weights, each row the symmetric Blackman-windowed sinc
   * `resample.js` uses, normalised so a row sums to exactly 1 (a constant input
   * stays the same constant at every phase). Built once, on the message path.
   * @param {number} cutoff cycles per input sample, `0 < cutoff <= 0.5`
   * @returns {Float64Array}
   */
  function bridgeKernel(cutoff) {
    const table = new Float64Array(BRIDGE_PHASES * BRIDGE_TAPS);
    for (let phase = 0; phase < BRIDGE_PHASES; phase += 1) {
      const fraction = phase / BRIDGE_PHASES;
      const row = phase * BRIDGE_TAPS;
      let total = 0;
      for (let tap = 0; tap < BRIDGE_TAPS; tap += 1) {
        // Tap `tap` sits at input index `base - BRIDGE_HALF + 1 + tap`, so its
        // distance from the output position is `fraction + BRIDGE_HALF - 1 - tap`.
        const offset = fraction + BRIDGE_HALF - 1 - tap;
        const across = Math.abs(offset) / BRIDGE_HALF;
        let weight = 0;
        if (across < 1) {
          const window = 0.42 + 0.5 * Math.cos(Math.PI * across) + 0.08 * Math.cos(2 * Math.PI * across);
          const angle = 2 * Math.PI * cutoff * offset;
          weight = 2 * cutoff * (angle === 0 ? 1 : Math.sin(angle) / angle) * window;
        }
        table[row + tap] = weight;
        total += weight;
      }
      if (total !== 0) {
        for (let tap = 0; tap < BRIDGE_TAPS; tap += 1) table[row + tap] /= total;
      }
    }
    return table;
  }

  /**
   * One streaming sample-rate converter (see the file header).
   *
   * The kernel is symmetric: every output sample is the windowed sinc of
   * `BRIDGE_HALF` input frames either side of its position, with the cutoff at
   * 0.95 of the LOWER Nyquist — so a downsample cannot fold anything above the
   * destination's Nyquist back into the band. The weights come from a
   * precomputed polyphase table, so a sample costs `BRIDGE_TAPS` multiplies and
   * no trig at all.
   *
   * Being symmetric costs look-ahead: an output frame at input position `p`
   * needs the input up to `p + BRIDGE_HALF`. So the output stream lags the input
   * stream by `BRIDGE_HALF` input frames, which is
   * `ceil(BRIDGE_HALF / step)` output frames — the number `latencyFrames`
   * reports, so the insert that owns this converter can declare (and prime for)
   * its real delay. The frames before the stream began read as silence, exactly
   * as `StudioResample.toRate` treats a buffer's first and last taps.
   *
   * `process()` is handed the input it has not seen yet and writes up to
   * `outMax` output frames; both sides' counts are driven by one integer output
   * index (`index * step`), so the conversion of a block has the same count
   * whatever block size a host asks for. It allocates nothing per call.
   * @param {{fromRate: number, toRate: number, maxIn?: number, maxOut?: number}} options
   * @returns {{latencyFrames: number, step: number, cutoff: number,
   *            process: function(Float32Array|null, Float32Array|null, number,
   *                            Float32Array, Float32Array|null, number): number,
   *            reset: function(): void, inputFrames: function(): number,
   *            outputFrames: function(): number}}
   */
  function createBridge(options) {
    const from = positive(options && options.fromRate, 0);
    const to = positive(options && options.toRate, 0);
    if (from === 0 || to === 0) throw new Error("StudioNamHost: a converter needs both rates above zero");
    const maxIn = Math.max(1, Math.trunc(positive(options && options.maxIn, QUANTUM_FRAMES)));
    const maxOut = Math.max(1, Math.trunc(positive(options && options.maxOut, QUANTUM_FRAMES)));
    const step = from / to;
    const cutoff = BRIDGE_CUTOFF_SCALE * 0.5 * Math.min(1, to / from);
    const historyFrames = BRIDGE_TAPS;

    /** The kernel, one row per phase: `table[phase * BRIDGE_TAPS + tap]`. */
    const table = bridgeKernel(cutoff);
    /** The last `BRIDGE_TAPS` input frames, oldest first. */
    const history = [new Float32Array(historyFrames), new Float32Array(historyFrames)];
    let historyFilled = 0;
    /** The input pool one call works in: the history, then the new frames. */
    const work = [new Float32Array(historyFrames + maxIn), new Float32Array(historyFrames + maxIn)];

    let index = 0;
    let received = 0;
    let emitted = 0;

    /**
     * Convert what arrived, writing at most `outMax` frames.
     * @param {Float32Array|null} left
     * @param {Float32Array|null} right
     * @param {number} inCount the frames this call brings
     * @param {Float32Array} outLeft
     * @param {Float32Array} outRight
     * @param {number} outMax how many output frames to write at most
     * @returns {number} how many were written
     */
    function process(left, right, inCount, outLeft, outRight, outMax) {
      const count = Math.max(0, Math.trunc(finite(inCount)));
      const limit = Math.max(0, Math.trunc(finite(outMax)));
      const channels = right && outRight ? 2 : 1;
      for (let channel = 0; channel < channels; channel += 1) {
        const source = channel === 0 ? left : right;
        const pool = work[channel];
        const past = history[channel];
        for (let at = 0; at < historyFilled; at += 1) pool[at] = past[at];
        if (source) {
          for (let at = 0; at < count; at += 1) pool[historyFilled + at] = source[at];
        } else {
          pool.fill(0, historyFilled, historyFilled + count);
        }
      }
      // Pool index i is stream index `received - historyFilled + i`; the samples
      // this call brought sit at `historyFilled` onwards.
      const firstAvailable = received - historyFilled;
      const lastAvailable = received + count - 1;
      const availableEnd = historyFilled + count - 1;
      let produced = 0;
      while (produced < limit) {
        const centre = index * step;
        const base = Math.floor(centre);
        // The kernel reaches `BRIDGE_HALF` frames past the output position: until
        // that input has arrived this output frame cannot be made yet. That is
        // the converter's delay, reported as `latencyFrames`.
        if (base + BRIDGE_HALF > lastAvailable) break;
        let phase = Math.round((centre - base) * BRIDGE_PHASES) % BRIDGE_PHASES;
        if (phase < 0) phase += BRIDGE_PHASES;
        const row = phase * BRIDGE_TAPS;
        // The pool index of tap 0 (the frame `BRIDGE_HALF - 1` behind the base).
        const firstTap = base - firstAvailable - BRIDGE_HALF + 1;
        for (let channel = 0; channel < channels; channel += 1) {
          const pool = work[channel];
          let sum = 0;
          for (let tap = 0; tap < BRIDGE_TAPS; tap += 1) {
            const at = firstTap + tap;
            // A tap before the stream began reads as silence, so the kernel runs
            // off that end exactly as it runs off a buffer's first samples.
            if (at < 0 || at > availableEnd) continue;
            sum += pool[at] * table[row + tap];
          }
          if (channel === 0) outLeft[produced] = sum;
          else outRight[produced] = sum;
        }
        index += 1;
        produced += 1;
      }

      // Keep the newest `BRIDGE_TAPS` samples as the next call's history.
      for (let channel = 0; channel < channels; channel += 1) {
        const source = channel === 0 ? left : right;
        const past = history[channel];
        if (count >= historyFrames) {
          for (let at = 0; at < historyFrames; at += 1) past[at] = source ? source[count - historyFrames + at] : 0;
        } else if (count > 0) {
          const keep = Math.min(historyFilled, historyFrames - count);
          for (let at = 0; at < keep; at += 1) past[at] = past[historyFilled - keep + at];
          for (let at = 0; at < count; at += 1) past[keep + at] = source ? source[at] : 0;
        }
      }
      historyFilled = Math.min(historyFrames, historyFilled + count);
      received += count;
      emitted += produced;
      return produced;
    }

    return {
      /**
       * The delay this conversion adds, in its own OUTPUT frames: the kernel's
       * look-ahead, `BRIDGE_HALF` input frames, expressed at the output rate.
       */
      latencyFrames: Math.ceil(BRIDGE_HALF / step),
      step: step,
      cutoff: cutoff,
      process: process,
      reset: function reset() {
        history[0].fill(0);
        history[1].fill(0);
        historyFilled = 0;
        index = 0;
        received = 0;
        emitted = 0;
      },
      inputFrames: function inputFrames() {
        return received;
      },
      outputFrames: function outputFrames() {
        return emitted;
      },
      pendingOutput: function pendingOutput() {
        return Math.ceil(received / step) - emitted;
      },
    };
  }

  /**
   * What is wrong with a capture's text, or null when Studio can play it: a JSON
   * object whose top-level `architecture` is the A2 one and that holds `weights`
   * (the same three things the upload check looks for). Another architecture is
   * the plan's re-export sentence; anything else is not a capture at all.
   * @param {string|Uint8Array} text
   * @returns {string|null}
   */
  function captureProblem(text) {
    const source = typeof text === "string" ? text : textOfBytes(text);
    if (source === "") return NOT_A_CAPTURE_TEXT;
    let parsed = null;
    try {
      parsed = JSON.parse(source);
    } catch {
      return NOT_A_CAPTURE_TEXT;
    }
    if (!parsed || typeof parsed !== "object") return NOT_A_CAPTURE_TEXT;
    const architecture = parsed[ARCHITECTURE_KEY];
    if (typeof architecture !== "string") return NOT_A_CAPTURE_TEXT;
    if (architecture !== A2_ARCHITECTURE) return LEGACY_CAPTURE_TEXT;
    if (!Object.prototype.hasOwnProperty.call(parsed, "weights")) return NOT_A_CAPTURE_TEXT;
    return null;
  }

  /**
   * Build one NAM host: the shared wasm module, one NAM instance per insert, and
   * the model each instance plays.
   * @param {{sampleRate?: number, cores?: number}} [options] `sampleRate` is the
   *   context's rate (the engine's `sampleRate` global in a worklet);
   *   `cores` overrides the page's own core count (a test picks the slim branch)
   * @returns {object}
   */
  function create(options) {
    const settings = options && typeof options === "object" ? options : {};
    const contextRate = positive(settings.sampleRate, 48000);
    const cores = settings.cores === undefined ? pageCores() : positive(settings.cores, 0);

    /** The Emscripten module once it is compiled, or null. */
    let module = null;
    /** The promise of that compile, so two loads share one. */
    let compiling = null;

    /** insert key → its NAM instance id. */
    const instanceIds = new Map();
    /** insert key → the wasm-side mono block view, re-derived when memory grows. */
    const buffers = new Map();
    /** insert key → what its capture is (`{expectedRate, slimmable, loudness}`). */
    const models = new Map();

    /**
     * Library id → `{text, problem}`: what `captureProblem` said about one
     * capture's TEXT. Every insert that plays the same library entry reuses it,
     * so a `.nam` file is parsed once per distinct text rather than once per
     * insert that names it. The text reference is kept too: a capture replaced
     * under the same id is checked again.
     */
    const checked = new Map();

    /**
     * Compile the engine from bytes the page transferred (there is no fetch
     * here), once per page. A second call with different bytes is refused: the
     * module is shared by every amp insert, so it is compiled once.
     * @param {ArrayBuffer|Uint8Array} bytes
     * @returns {Promise<object>} the module
     */
    function setWasm(bytes) {
      if (module) return Promise.resolve(module);
      if (compiling) return compiling;
      if (!bytes || !(bytes.byteLength > 0)) {
        compiling = Promise.reject(new Error("StudioNamHost: no NAM engine bytes were posted"));
        compiling.catch(() => {});
        return compiling;
      }
      const vendor = typeof StudioNam === "object" && StudioNam !== null ? StudioNam : null;
      if (!vendor || typeof vendor.createNamEngine !== "function") {
        compiling = Promise.reject(new Error("StudioNamHost: the vendored NAM engine is not in this engine"));
        compiling.catch(() => {});
        return compiling;
      }
      const binary = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      compiling = vendor
        .createNamEngine({
          wasmBinary: binary,
          // The path is never resolved: the bytes above are what the glue
          // instantiates. This only keeps the glue's own URL guess out of the way.
          locateFile: function locateFile(path) {
            return path;
          },
          print: function print() {},
          printErr: function printErr() {},
        })
        .then((instance) => {
          module = instance;
          return instance;
        });
      return compiling;
    }

    /** @returns {Promise<object>} the module, once the compile finished. */
    function ready() {
      if (module) return Promise.resolve(module);
      if (compiling) return compiling;
      return Promise.reject(new Error("StudioNamHost: no NAM engine bytes were posted"));
    }

    /** @returns {boolean} whether the engine is up (an amp can play). */
    function isReady() {
      return module !== null;
    }

    /**
     * What is wrong with a capture about to be loaded, or null when Studio can
     * play it — `captureProblem` with its answer remembered by library id.
     * @param {string} [libraryId]
     * @param {string} text
     * @returns {string|null}
     */
    function checkCapture(libraryId, text) {
      const source = typeof text === "string" ? text : textOfBytes(text);
      const key = libraryId === undefined || libraryId === null ? "" : String(libraryId);
      if (key === "") return captureProblem(source);
      const known = checked.get(key);
      if (known && known.text === text) return known.problem;
      const problem = captureProblem(source);
      checked.set(key, { text: text, problem: problem });
      return problem;
    }

    /**
     * One insert's instance id, made lazily: an insert that never plays a
     * capture never costs an instance.
     * @param {string} key
     * @returns {number}
     */
    function instanceFor(key) {
      const known = instanceIds.get(key);
      if (known) return known;
      if (!module) throw new Error("StudioNamHost: the NAM engine is not compiled");
      const id = module._nam_createInstance(contextRate, QUANTUM_FRAMES);
      if (!(id > 0)) throw new Error("StudioNamHost: the NAM engine could not start an instance");
      instanceIds.set(key, id);
      buffers.delete(key);
      return id;
    }

    /** @returns {Float32Array|null} one instance's mono block, or null. */
    function bufferFor(key, id) {
      if (!module) return null;
      const held = buffers.get(key);
      if (held && held.buffer === module.HEAPF32.buffer) return held;
      const pointer = module._nam_getBuffer(id);
      if (!pointer) return null;
      const view = module.HEAPF32.subarray(pointer >> 2, (pointer >> 2) + QUANTUM_FRAMES);
      buffers.set(key, view);
      return view;
    }

    /**
     * Load one capture into one insert's NAM instance. Runs on the message
     * path, while the transport is stopped (see the file header).
     *
     * `libraryId` names the library entry the text came from: the check that
     * the text is a capture Studio can play is cached under it, so a second
     * insert that plays the SAME capture does not parse its JSON again.
     * @param {string} key the insert's key (one per amp insert OBJECT)
     * @param {string} jsonText the capture's own JSON
     * @param {string} [libraryId] the capture's library id, for the check cache
     * @returns {{expectedSampleRate: number, slimmable: boolean,
     *            slimSize: number, loudness: number}}
     * @throws {Error} with the plan's sentence for a legacy (or broken) capture
     */
    function loadModel(key, jsonText, libraryId) {
      if (!module) throw new Error("StudioNamHost: the NAM engine is not compiled");
      const text = typeof jsonText === "string" ? jsonText : textOfBytes(jsonText);
      if (text === "") throw new Error(NOT_A_CAPTURE_TEXT);
      const problem = checkCapture(libraryId, text);
      if (problem) throw new Error(problem);
      const id = instanceFor(key);

      // The engine's parse can be a few hundred milliseconds of work; a capture
      // it refuses says why in its own words.
      const bytes = module.lengthBytesUTF8(text) + 1;
      const pointer = module._malloc(bytes);
      if (!pointer) throw new Error("StudioNamHost: out of memory for a capture");
      let loaded = false;
      try {
        module.stringToUTF8(text, pointer, bytes);
        loaded = module._nam_loadModel(id, pointer, FULL_MODEL) !== 0;
        if (!loaded) {
          const message = module.UTF8ToString(module._nam_getLastError());
          throw new Error(message && message !== "" ? message : "This capture could not be loaded.");
        }
      } finally {
        module._free(pointer);
      }

      // Loading may have grown the heap: the block view is read again later
      // through `bufferFor`, which re-derives it when the buffer changed.
      buffers.delete(key);
      const breakpoints = [];
      const count = module._nam_getSlimmableBreakpointCount(id);
      for (let at = 0; at < count; at += 1) breakpoints.push(module._nam_getSlimmableBreakpoint(id, at));
      const slimmable = module._nam_isSlimmable(id) === 1;
      const slimSize = slimmable ? slimSizeOf(breakpoints, cores) : FULL_MODEL;
      if (slimmable && slimSize > FULL_MODEL) module._nam_setSlimmableSize(id, slimSize);
      const info = {
        expectedSampleRate: usableRate(module._nam_getExpectedSampleRate(id), contextRate),
        slimmable: slimmable,
        breakpoints: breakpoints,
        slimSize: slimSize,
        loudness: finite(module._nam_getLoudness(id)),
      };
      models.set(key, info);
      return info;
    }

    /**
     * Let one insert's capture go: its instance is destroyed, so an insert that
     * leaves the song costs nothing.
     * @param {string} key
     * @returns {void}
     */
    function unloadModel(key) {
      const id = instanceIds.get(key);
      instanceIds.delete(key);
      buffers.delete(key);
      models.delete(key);
      if (!id || !module) return;
      try {
        module._nam_unloadModel(id);
        module._nam_destroyInstance(id);
      } catch {
        /* the engine is going away: nothing is left to clean up */
      }
    }

    /** @returns {boolean} whether this insert's instance has a capture. */
    function hasModel(key) {
      return models.has(key);
    }

    /** @returns {object|null} what this insert's capture is, or null. */
    function modelInfo(key) {
      const info = models.get(key);
      return info ? info : null;
    }

    /**
     * Run one insert's capture over a mono block, in place.
     *
     * The engine's block is a fixed 128 frames, so a longer run is handed over
     * in pieces; a host that asks for less than a quantum is served directly
     * (`_nam_process(id, frames)` accepts it).
     *
     * The engine's block view is re-checked after EVERY call: a model that grows
     * the wasm heap (or a rebuilt module) moves `HEAPF32`'s buffer, and a view
     * into the old one would read and write memory the engine no longer uses.
     * @param {string} key
     * @param {Float32Array} input the mono input (the insert's L+R sum)
     * @param {Float32Array} output where the mono output goes (may be `input`)
     * @param {number} frames
     * @returns {boolean} false when this insert has no capture (silence)
     */
    function process(key, input, output, frames) {
      const id = instanceIds.get(key);
      if (!id || !module || !models.has(key)) return false;
      let buffer = bufferFor(key, id);
      if (buffer === null) return false;
      for (let at = 0; at < frames; at += QUANTUM_FRAMES) {
        const count = Math.min(QUANTUM_FRAMES, frames - at);
        for (let frame = 0; frame < count; frame += 1) buffer[frame] = input[at + frame];
        module._nam_process(id, count);
        if (buffer.buffer !== module.HEAPF32.buffer) {
          // The heap grew (or shrank) while this block ran: take the view again
          // before reading the output, and before the next piece writes to it.
          const again = bufferFor(key, id);
          if (again === null) return false;
          buffer = again;
        }
        for (let frame = 0; frame < count; frame += 1) output[at + frame] = buffer[frame];
      }
      return true;
    }

    return {
      sampleRate: contextRate,
      cores: cores,
      setWasm: setWasm,
      ready: ready,
      isReady: isReady,
      checkCapture: checkCapture,
      loadModel: loadModel,
      unloadModel: unloadModel,
      hasModel: hasModel,
      modelInfo: modelInfo,
      process: process,
      instanceCount: function instanceCount() {
        return instanceIds.size;
      },
      instanceKeys: function instanceKeys() {
        return Array.from(instanceIds.keys());
      },
      destroy: function destroy() {
        for (const key of Array.from(instanceIds.keys())) unloadModel(key);
        instanceIds.clear();
        buffers.clear();
        models.clear();
        checked.clear();
        module = null;
        compiling = null;
      },
    };
  }

  const api = {
    create: create,
    createBridge: createBridge,
    captureProblem: captureProblem,
    slimSizeOf: slimSizeOf,
    pageCores: pageCores,
    textOfBytes: textOfBytes,
    LEGACY_CAPTURE_TEXT: LEGACY_CAPTURE_TEXT,
    NOT_A_CAPTURE_TEXT: NOT_A_CAPTURE_TEXT,
    A2_ARCHITECTURE: A2_ARCHITECTURE,
    FULL_MODEL: FULL_MODEL,
    QUANTUM_FRAMES: QUANTUM_FRAMES,
    SLIM_CORES: SLIM_CORES,
    BRIDGE_TAPS: BRIDGE_TAPS,
    BRIDGE_HALF: BRIDGE_HALF,
  };

  if (typeof globalThis !== "undefined") globalThis.StudioNamHost = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();