/**
 * Studio's Faust insert host — the compiled effects, instantiated and driven.
 *
 * The seven Faust effects (plan 1d, Task 7) are compiled to WebAssembly at build
 * time (`tools/build-faust.mjs`, which also lints their licences). This file is
 * what turns those bytes into an insert the processor can run:
 *
 *     await StudioFaustHost.compileModules({ eq: {wasm, json}, … })
 *     const insert = StudioFaustHost.create("eq", rate)
 *     insert.setParams({ low_gain_db: 6 })
 *     insert.process(left, right, frames)   // in place, ≤ 128 frames
 *
 * ## Once per page, one instance per insert
 *
 * `compileModules` runs `WebAssembly.compile` ONCE per effect per page and keeps
 * the module. It is asynchronous, so it is called from a port message — never
 * from `process()` — and `create()` then instantiates synchronously from that
 * module, one instance per insert, each with its own wasm memory and its own
 * state. `process()` only copies a block into the instance's input buffers,
 * calls the effect's `compute`, and copies the result back: no allocation, no
 * throw, no `Math.random`.
 *
 * ## The import object
 *
 * A Faust mono module imports nothing but `env`'s math functions (`_sinf`,
 * `_powf`, `_tanf`, …) and defines and exports its own memory, so this file
 * supplies that same `env` object itself instead of importing faustwasm (the
 * compiler is a build-time devDependency only). A module that wants an import
 * this host does not have is refused at compile time, naming it, rather than
 * failing later inside `create()`.
 *
 * ## Parameters
 *
 * The factory JSON carries one UI item per control: its `address` (which is
 * `/crow-studio-<kind>/<name>`), its `index` — the control's offset in the DSP
 * struct, which is what `setParamValue` takes — and its `min`, `max` and
 * `init`. `create()` builds a table from that, and `setParams` maps the
 * document's plain object onto it: a value outside its range is clamped, a name
 * the effect does not have is ignored, and a value that is not a number leaves
 * that parameter where it was, so turning one knob is one field.
 *
 * A chooser in the document (the filter's `mode`: "lp", "hp", "bp") is an
 * integer control in Faust — `nentry("mode", 0, 0, 2, 1)` — and this file maps
 * the word to its index in the document's `values` list. A worklet cannot
 * import `server/doc.js`, so that list is duplicated here in `CHOICES`, and a
 * test pins the two copies together.
 *
 * ## It is a classic script
 *
 * No `import`/`export`: it assigns `globalThis.StudioFaustHost` for the worklet
 * scope and `module.exports` for a Node `require()` (`engine/package.json` marks
 * the directory `"commonjs"`), and `engine-client.js` concatenates it into the
 * worklet module with the other engine sources.
 *
 * ## What it does not do
 *
 * It does not police the output. A NaN or ±Infinity out of an insert is caught
 * at that insert's output by the processor's own guard (plan 1d, Task 9), which
 * is the one place that knows which track the insert sits on and can say so.
 * Inputs are sanitised here, though, exactly as `engine/dynamics.js` does it: a
 * non-finite sample that reached a Faust delay line would stay in its state for
 * the rest of the session.
 */
(function () {
  "use strict";

  /** The longest block `process()` will take: the processor's own block. */
  const BLOCK = 128;

  /** Below this, an output sample is flushed to exactly 0 (the plan's rule). */
  const DENORMAL_FLOOR = 1e-30;

  /** The rate an insert created without one runs at (the same default as the bus). */
  const DEFAULT_RATE = 48000;

  /** How big a float is in the wasm heap, and the pointer table's cell. */
  const FLOAT_BYTES = 4;

  /**
   * The chooser controls the document holds as words, in the document's order
   * (`EFFECT_PARAMS[kind].params[name].values`). A Faust control can only be a
   * number, so the word's index is the number the effect gets.
   * @type {Readonly<Object<string, Readonly<Object<string, ReadonlyArray<string>>>>>}
   */
  const CHOICES = Object.freeze({
    filter: Object.freeze({ mode: Object.freeze(["lp", "hp", "bp"]) }),
  });

  /**
   * The functions a Faust module imports from `env`, the same set (and the same
   * arithmetic) faustwasm's own instantiator passes: Faust's generated code
   * calls out to the host for `sin`, `pow`, `tan` and the rest. `copysign` and
   * `isinf` are spelled the way faustwasm spells them, because the comparison is
   * the same one the compiler's own runner makes.
   */
  const IMPORTED_FUNCTIONS = Object.freeze({
    // Integer and single-precision versions.
    _abs: Math.abs,
    _acosf: Math.acos,
    _asinf: Math.asin,
    _atanf: Math.atan,
    _atan2f: Math.atan2,
    _ceilf: Math.ceil,
    _cosf: Math.cos,
    _expf: Math.exp,
    _floorf: Math.floor,
    _fmodf: (x, y) => x % y,
    _logf: Math.log,
    _log10f: Math.log10,
    _max_f: Math.max,
    _min_f: Math.min,
    _remainderf: (x, y) => x - Math.round(x / y) * y,
    _powf: Math.pow,
    _roundf: Math.round,
    _sinf: Math.sin,
    _sqrtf: Math.sqrt,
    _tanf: Math.tan,
    _acoshf: Math.acosh,
    _asinhf: Math.asinh,
    _atanhf: Math.atanh,
    _coshf: Math.cosh,
    _sinhf: Math.sinh,
    _tanhf: Math.tanh,
    _isnanf: Number.isNaN,
    _isinff: (x) => !isFinite(x),
    _copysignf: (x, y) => (Math.sign(x) === Math.sign(y) ? x : -x),
    // Double-precision versions.
    _acos: Math.acos,
    _asin: Math.asin,
    _atan: Math.atan,
    _atan2: Math.atan2,
    _ceil: Math.ceil,
    _cos: Math.cos,
    _exp: Math.exp,
    _floor: Math.floor,
    _fmod: (x, y) => x % y,
    _log: Math.log,
    _log10: Math.log10,
    _max_: Math.max,
    _min_: Math.min,
    _remainder: (x, y) => x - Math.round(x / y) * y,
    _pow: Math.pow,
    _round: Math.round,
    _sin: Math.sin,
    _sqrt: Math.sqrt,
    _tan: Math.tan,
    _acosh: Math.acosh,
    _asinh: Math.asinh,
    _atanh: Math.atanh,
    _cosh: Math.cosh,
    _sinh: Math.sinh,
    _tanh: Math.tanh,
    _isnan: Number.isNaN,
    _isinf: (x) => !isFinite(x),
    _copysign: (x, y) => (Math.sign(x) === Math.sign(y) ? x : -x),
  });

  /** The control types a parameter can be: a slider, a number, a button, a box. */
  const PARAM_TYPES = Object.freeze(["hslider", "vslider", "nentry", "button", "checkbox"]);

  /**
   * The compiled effects this page holds: kind → `{module, meta}`. `create()`
   * instantiates from one of these; nothing here is per insert.
   * @type {Map<string, {module: WebAssembly.Module, meta: object}>}
   */
  const MODULES = new Map();

  /**
   * The insert rate's page size, for growing the memory a compiled effect
   * exports when the DSP struct plus the block buffers do not fit.
   */
  const WASM_PAGE_BYTES = 65536;

  /** @returns {number} the value, or 0 when it is not a finite number. */
  function finiteSample(value) {
    // `v - v` is exactly 0 for every finite number (0 and -0 included) and NaN
    // for a NaN or an infinity: the cheapest finiteness test there is.
    return value - value === 0 ? value : 0;
  }

  /** @returns {number} the value, or 0 when it is below the denormal floor. */
  function flush(value) {
    return value > -DENORMAL_FLOOR && value < DENORMAL_FLOOR ? 0 : value;
  }

  /** @returns {number} the value held between two bounds. */
  function clamp(value, low, high) {
    if (!Number.isFinite(value)) return low;
    if (value < low) return low;
    if (value > high) return high;
    return value;
  }

  /** @returns {number} a finite number above zero, else 0. */
  function positive(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
  }

  /**
   * One ArrayBuffer out of what a caller posted: the bytes were transferred, so
   * this is usually the buffer itself.
   * @param {ArrayBuffer|ArrayBufferView} value
   * @returns {ArrayBuffer}
   */
  function arrayBufferOf(value) {
    if (value instanceof ArrayBuffer) return value;
    if (ArrayBuffer.isView(value)) {
      return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    }
    throw new Error("StudioFaustHost: an effect's wasm arrived as something that is not bytes");
  }

  /**
   * The factory JSON of one effect, parsed: the object shape is the compiler's,
   * and a caller may have posted it as a string (a page's fetch) or as an
   * object (a test's file read).
   * @param {string|object|null|undefined} json
   * @returns {object|null}
   */
  function metaOf(json) {
    if (json === null || json === undefined) return null;
    if (typeof json === "string") return JSON.parse(json);
    if (typeof json === "object") return json;
    return null;
  }

  /**
   * Every control of one effect, flattened out of the factory JSON's UI groups:
   * the document's name (the address's last segment), the parameter offset
   * `setParamValue` takes, the range, the default and — for a chooser — the
   * words its numbers mean.
   * @param {object|null} meta the factory JSON
   * @param {string} kind the effect's name, for `CHOICES`
   * @returns {Map<string, {name: string, address: string, index: number,
   *                        min: number, max: number, init: number,
   *                        choices: ReadonlyArray<string>|null}>}
   */
  function controlsOf(meta, kind) {
    const controls = new Map();
    const choices = Object.hasOwn(CHOICES, kind) ? CHOICES[kind] : null;
    const groups = meta && Array.isArray(meta.ui) ? meta.ui : [];

    /** @param {object|object[]} item one UI item, or a list of them */
    const visit = (item) => {
      if (Array.isArray(item)) {
        for (const child of item) visit(child);
        return;
      }
      if (!item || typeof item !== "object") return;
      if (Array.isArray(item.items)) {
        visit(item.items);
        return;
      }
      // A meter (`hbargraph`/`vbargraph`) is an output, not a parameter: this
      // host only writes controls.
      if (!PARAM_TYPES.includes(item.type)) return;
      if (typeof item.index !== "number" || typeof item.address !== "string") return;
      const address = item.address;
      const name = address.slice(address.lastIndexOf("/") + 1);
      const words = choices && Object.hasOwn(choices, name) ? choices[name] : null;
      controls.set(name, {
        name: name,
        address: address,
        index: item.index,
        min: typeof item.min === "number" ? item.min : 0,
        max: typeof item.max === "number" ? item.max : 1,
        init: typeof item.init === "number" ? item.init : 0,
        choices: words,
      });
    };

    for (const group of groups) visit(group);
    return controls;
  }

  /**
   * Compile the effects this page was handed: one `WebAssembly.compile` per
   * effect, once. Called from a port message, outside the audio block, because
   * compiling is asynchronous and `process()` must never wait.
   *
   * @param {Object<string, {wasm: ArrayBuffer|ArrayBufferView, json: string|object}>} modules
   *   one entry per effect: its compiled bytes and its factory JSON
   * @returns {Promise<Object<string, boolean>>} which kinds this page now holds
   * @throws {Error} naming the effect when its bytes will not compile, its JSON
   *   is missing, or it wants an import this host cannot supply
   */
  async function compileModules(modules) {
    const compiled = Object.create(null);
    if (!modules || typeof modules !== "object") return compiled;
    for (const kind of Object.keys(modules)) {
      const item = modules[kind];
      if (!item || typeof item !== "object") continue;
      const meta = metaOf(item.json);
      if (!meta) throw new Error(`StudioFaustHost: the ${kind} effect arrived without its factory JSON`);
      let module;
      try {
        module = await WebAssembly.compile(arrayBufferOf(item.wasm));
      } catch (error) {
        throw new Error(`StudioFaustHost: the ${kind} effect would not compile: ${error?.message || error}`);
      }
      for (const need of WebAssembly.Module.imports(module)) {
        const supplied = need.module === "env" && need.kind === "function" && Object.hasOwn(IMPORTED_FUNCTIONS, need.name);
        const memory = need.module === "env" && need.kind === "memory";
        if (!supplied && !memory) {
          throw new Error(`StudioFaustHost: the ${kind} effect wants an import this host does not have (${need.module}.${need.name})`);
        }
      }
      MODULES.set(kind, { module: module, meta: meta });
      compiled[kind] = true;
    }
    return compiled;
  }

  /**
   * @param {string} kind an effect's name
   * @returns {boolean} whether this page holds a compiled module for it
   */
  function has(kind) {
    return typeof kind === "string" && MODULES.has(kind);
  }

  /** @returns {string[]} the kinds this page holds, sorted. */
  function kinds() {
    return [...MODULES.keys()].sort();
  }

  /**
   * Forget every compiled module. The page calls this when the audio context it
   * compiled for is gone; a test calls it between cases. An insert already
   * created keeps working — it holds its own instance.
   * @returns {void}
   */
  function release() {
    MODULES.clear();
  }

  /**
   * Build one insert: an instance of a compiled effect, with its input and
   * output buffers laid out in the instance's memory once, here.
   *
   * The returned object is the same shape `engine/dynamics.js` returns, so a
   * chain slot does not care which kind of insert it holds.
   *
   * @param {string} kind an effect's name (`eq`, `filter`, `delay`, `reverb`,
   *   `chorus`, `phaser`, `saturation`)
   * @param {number} rate the AudioContext's sample rate, in Hz
   * @returns {{kind: string, rate: number, latencyFrames: number,
   *            setParams: function(object): void,
   *            process: function(Float32Array, Float32Array|null, number): void,
   *            reset: function(): void,
   *            params: function(): Object<string, number|string>}}
   * @throws {Error} when this page holds no compiled module for the kind, or the
   *   module is not a stereo insert (never from `process`)
   */
  function create(kind, rate) {
    const name = typeof kind === "string" ? kind : "";
    const entry = MODULES.get(name);
    if (!entry) throw new Error(`StudioFaustHost: no compiled Faust effect named "${name}" on this page`);
    const meta = entry.meta;
    const inputs = Number(meta.inputs);
    const outputs = Number(meta.outputs);
    if (inputs !== 2 || outputs !== 2) {
      throw new Error(`StudioFaustHost: the ${name} effect is not a stereo insert (${inputs} in, ${outputs} out)`);
    }
    const sampleRate = positive(rate) || DEFAULT_RATE;

    // A memory for a module that ever wants one; a Faust mono module defines and
    // exports its own, and that one is used below.
    const envMemory = new WebAssembly.Memory({ initial: 2 });
    const instance = new WebAssembly.Instance(entry.module, {
      env: Object.assign({}, IMPORTED_FUNCTIONS, { memory: envMemory, memoryBase: 0, tableBase: 0 }),
    });
    const api = instance.exports;
    const memory = api.memory instanceof WebAssembly.Memory ? api.memory : envMemory;

    // The mono layout faustwasm's own instantiator uses, and the one libfaust
    // lays out: the DSP struct at 0, then a table of pointers to the input
    // channels, then one to the outputs, then the sample buffers themselves.
    const audioInputs = Number(meta.size) || 0;
    const audioOutputs = audioInputs + inputs * FLOAT_BYTES;
    const inputBase = audioOutputs + outputs * FLOAT_BYTES;
    const outputBase = inputBase + inputs * BLOCK * FLOAT_BYTES;
    const endBytes = outputBase + outputs * BLOCK * FLOAT_BYTES;
    if (memory.buffer.byteLength < endBytes) {
      const pages = Math.ceil((endBytes - memory.buffer.byteLength) / WASM_PAGE_BYTES);
      memory.grow(pages);
    }

    /** The heap views, rebuilt only when the memory grew (which detaches them). */
    let cachedBuffer = null;
    let heapFloats = null;
    let heapInts = null;

    /** @returns {void} point the views at the instance's current memory. */
    function refreshViews() {
      if (cachedBuffer === memory.buffer) return;
      cachedBuffer = memory.buffer;
      heapFloats = new Float32Array(cachedBuffer);
      heapInts = new Int32Array(cachedBuffer);
      // The channel tables: one pointer per input and per output.
      for (let channel = 0; channel < inputs; channel += 1) {
        heapInts[(audioInputs >> 2) + channel] = inputBase + BLOCK * FLOAT_BYTES * channel;
      }
      for (let channel = 0; channel < outputs; channel += 1) {
        heapInts[(audioOutputs >> 2) + channel] = outputBase + BLOCK * FLOAT_BYTES * channel;
      }
    }
    refreshViews();

    const controls = controlsOf(meta, name);
    /** The parameter values as they are now, by the document's name. */
    const values = {};
    for (const control of controls.values()) values[control.name] = control.init;

    api.init(0, sampleRate);

    /**
     * Take a plain parameter object — one field per parameter, as the document
     * stores it. A value outside its range is clamped, a name the effect does
     * not have is ignored, and a value that is not a number leaves that
     * parameter alone.
     * @param {Object<string, number|string>} plain
     * @returns {void}
     */
    function setParams(plain) {
      const given = plain && typeof plain === "object" ? plain : {};
      for (const key of Object.keys(given)) {
        const control = controls.get(key.slice(key.lastIndexOf("/") + 1));
        if (!control) continue;
        const raw = given[key];
        let numeric;
        if (control.choices) {
          const at = control.choices.indexOf(raw);
          if (at === -1) continue;
          numeric = at;
        } else {
          numeric = Number(raw);
          if (!Number.isFinite(numeric)) continue;
        }
        values[control.name] = clamp(numeric, control.min, control.max);
        api.setParamValue(0, control.index, values[control.name]);
      }
    }

    /**
     * Put the effect back to silence without losing its settings: the DSP's own
     * instance is re-initialised (which resets the user interface), and then
     * every parameter this insert was given is written back.
     * @returns {void}
     */
    function reset() {
      api.instanceInit(0, sampleRate);
      for (const control of controls.values()) {
        api.setParamValue(0, control.index, values[control.name]);
      }
    }

    /** @returns {Object<string, number|string>} the parameters as they are now. */
    function params() {
      const copy = {};
      for (const control of controls.values()) {
        copy[control.name] =
          control.choices && values[control.name] >= 0 && values[control.name] < control.choices.length
            ? control.choices[values[control.name]]
            : values[control.name];
      }
      return copy;
    }

    /**
     * One block through the insert, in place. The block is at most 128 frames
     * (the processor's own); a missing right channel is a mono run, played out
     * of both outputs.
     *
     * @param {Float32Array} left the left channel, read and written in place
     * @param {Float32Array|null} right the right channel, or null for mono
     * @param {number} frames how many frames this run holds
     * @returns {void}
     */
    function process(left, right, frames) {
      if (!left || typeof left.length !== "number") return;
      const count = Math.trunc(Number(frames));
      if (!(count > 0)) return;
      const end = Math.min(left.length, count, BLOCK);
      if (!(end > 0)) return;
      refreshViews();
      const hasRight = Boolean(right) && typeof right.length === "number";
      const rightEnd = hasRight ? Math.min(right.length, end) : 0;
      const inLeft = inputBase >> 2;
      const inRight = inLeft + BLOCK;
      const outLeft = outputBase >> 2;
      const outRight = outLeft + BLOCK;
      for (let index = 0; index < end; index += 1) {
        const value = finiteSample(left[index]);
        heapFloats[inLeft + index] = value;
        heapFloats[inRight + index] = index < rightEnd ? finiteSample(right[index]) : value;
      }
      api.compute(0, end, audioInputs, audioOutputs);
      for (let index = 0; index < end; index += 1) {
        left[index] = flush(heapFloats[outLeft + index]);
        if (hasRight && index < rightEnd) right[index] = flush(heapFloats[outRight + index]);
      }
    }

    return {
      kind: name,
      rate: sampleRate,
      // A Faust effect is a plain block of arithmetic: nothing is delayed, so it
      // may sit on a track or a return (plan 1d: every track and return insert
      // is zero-latency).
      latencyFrames: 0,
      setParams: setParams,
      process: process,
      reset: reset,
      params: params,
    };
  }

  const api = {
    BLOCK: BLOCK,
    CHOICES: CHOICES,
    has: has,
    kinds: kinds,
    compileModules: compileModules,
    create: create,
    release: release,
  };

  if (typeof globalThis !== "undefined") globalThis.StudioFaustHost = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();