/**
 * The SunVox module catalogue, generated in Node from the vendored WASM engine.
 *
 * An agent needs the controller names and ranges before it can design a sound
 * (`track.set_device` takes a module type plus controller values), so Studio
 * answers with something the native library would have to be asked: the type
 * list, whether each type is a generator or an effect, and every controller's
 * name, range, kind and default. The answer is generated ONCE per process
 * directly from the engine the songs actually play through — the same WASM the
 * browser worklet hosts — so it can never drift from a hand-written table.
 *
 * ## How the engine is loaded here
 *
 * The vendored build is an Emscripten classic script (`sunvox.js`, which sets
 * `module.exports`) plus the library's own flat `sv_*` wrapper
 * (`sunvox_lib_loader.js`). Neither is a module, so both sources are read and
 * evaluated together inside one ordinary function, with the four names the
 * Emscripten Node path looks for (`require`, `__dirname`, `__filename`,
 * `module`) passed as parameters. That is the proven main-thread loading style:
 * no worker, no `AudioWorkletGlobalScope`, no browser — just `sv_init` in
 * offline mode and `sv_new_module` per type, which is all a catalogue needs.
 *
 * The engine runs with `SV_INIT_FLAG_OFFLINE` (it pulls audio through
 * `sv_audio_callback` itself and opens no device), `SV_INIT_FLAG_AUDIO_FLOAT32`,
 * `SV_INIT_FLAG_ONE_THREAD` and `SV_INIT_FLAG_NO_DEBUG_OUTPUT`. One slot is
 * opened, each type is created in it, read and removed, and the slot is closed
 * again; the module instance stays loaded for the life of the process.
 *
 * ## Phase 1a: only generators can be a track
 *
 * A Studio track plays notes, so only a module whose flags carry the generator
 * bit is a valid device in 1a. `GENERATOR_TYPES` is that set, filled from the
 * same flags as the catalogue (it is a live ESM binding: it is empty until
 * `moduleCatalogue()` has run, then holds the real list).
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { INSTRUMENT_TYPES } from "./doc.js";

/** This bundle's directory (bundles/studio). */
const BUNDLE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Where the vendored SunVox runtime lives. */
const VENDOR_DIR = join(BUNDLE_DIR, "vendor", "sunvox");

/** The Emscripten glue and the library's `sv_*` wrapper, in load order. */
const GLUE_FILE = "sunvox.js";
const LOADER_FILE = "sunvox_lib_loader.js";

/** The one slot the catalogue probes module types in. */
const SLOT = 0;

/** The rate the engine is initialised at; only module metadata is read. */
const SAMPLE_RATE = 48000;

/** Stereo, as every Studio engine is. */
const CHANNELS = 2;

/**
 * `SV_INIT_FLAG_NO_DEBUG_OUTPUT | SV_INIT_FLAG_OFFLINE | SV_INIT_FLAG_AUDIO_FLOAT32
 * | SV_INIT_FLAG_ONE_THREAD` (vendor `sunvox.h`: bits 0, 1, 3 and 4). Offline is
 * the same bit as USER_AUDIO_CALLBACK: the caller pulls the frames.
 */
const INIT_FLAGS = (1 << 0) | (1 << 1) | (1 << 3) | (1 << 4);

/** `SV_MODULE_FLAG_GENERATOR` — the module produces sound of its own. */
const GENERATOR_FLAG = 1 << 1;

/** `SV_MODULE_FLAG_EFFECT` — the module shapes other modules' sound. */
const EFFECT_FLAG = 1 << 2;

/**
 * Every SunVox module type, in the order SunVox Studio's catalogue lists them
 * (`bundles/sunvox-studio/server/sunvox-engine.js`). The list is the probe
 * order only: a type the engine refuses is simply absent from the result.
 */
export const MODULE_TYPES = Object.freeze([
  "Analog generator",
  "Generator",
  "DrumSynth",
  "Sampler",
  "SpectraVoice",
  "Vorbis player",
  "Input",
  "Echo",
  "Delay",
  "Reverb",
  "Filter",
  "EQ",
  "Compressor",
  "Flanger",
  "Vibrato",
  "WaveShaper",
  "DC Blocker",
  "LFO",
  "MultiSynth",
  "MultiCtl",
  "Sound2Ctl",
  "Velocity2Ctl",
  "MetaModule",
  "Amplifier",
]);

/**
 * The types that may be a track device in 1a — the ones whose flags carry the
 * generator bit. Empty until `moduleCatalogue()` has run; an ESM consumer sees
 * the filled value afterwards (it is a live binding).
 * @type {readonly string[]}
 */
export let GENERATOR_TYPES = Object.freeze([]);

/** The cached catalogue promise: the engine is asked once per process. */
let cataloguePromise = null;

/** The loaded engine wrapper, once. */
let enginePromise = null;

/**
 * Load the vendored engine and wait until its WASM instance is ready.
 *
 * Reads the two sources and evaluates them in one function scope, handing the
 * Emscripten glue the Node names it looks for. The returned object is the small
 * `sv_*` surface the catalogue needs; `ready()` resolves the loader's own
 * module promise, after which every function call is synchronous.
 *
 * @returns {Promise<object>} the engine wrapper
 */
function loadEngine() {
  if (enginePromise) return enginePromise;
  enginePromise = (async () => {
    const glue = readFileSync(join(VENDOR_DIR, GLUE_FILE), "utf8");
    const loader = readFileSync(join(VENDOR_DIR, LOADER_FILE), "utf8");
    const body = [
      glue,
      ";\n",
      loader,
      ";\n",
      // `svlib` is the loader's module promise; `ready()` replaces it with the
      // resolved instance so the wrapper's functions work synchronously.
      `return {
        ready: async () => { svlib = await svlib; },
        sv_init,
        sv_deinit,
        sv_open_slot,
        sv_close_slot,
        sv_lock_slot,
        sv_unlock_slot,
        sv_new_module,
        sv_remove_module,
        sv_get_module_flags,
        sv_get_number_of_module_ctls,
        sv_get_module_ctl_name,
        sv_get_module_ctl_min,
        sv_get_module_ctl_max,
        sv_get_module_ctl_type,
        sv_get_module_ctl_value,
      };`,
    ].join("");
    // The Emscripten glue is a classic script: no imports, no `import.meta`,
    // and a Node path that resolves the wasm beside `__filename`.
    const factory = new Function("require", "__dirname", "__filename", "module", "exports", body);
    const module = { exports: {} };
    const engine = factory(
      createRequire(import.meta.url),
      VENDOR_DIR,
      join(VENDOR_DIR, GLUE_FILE),
      module,
      module.exports,
    );
    await engine.ready();
    return engine;
  })().catch((err) => {
    // A failed load must not be cached as a permanently broken catalogue.
    enginePromise = null;
    throw err;
  });
  return enginePromise;
}

/**
 * Run one slot-mutating call under the slot lock (the library requires it for
 * module creation and removal).
 * @param {object} engine
 * @param {Function} fn
 * @returns {any}
 */
function withSlotLock(engine, fn) {
  engine.sv_lock_slot(SLOT);
  try {
    return fn();
  } finally {
    engine.sv_unlock_slot(SLOT);
  }
}

/**
 * Ask the engine for every module type and its controllers.
 *
 * @returns {Promise<{modules: Object<string, {kind: string, controllers: Array<{name: string, min: number, max: number, kind: string, default: number}>}>}>}
 * @throws {Error} when the engine cannot start at all
 */
async function buildCatalogue() {
  const engine = await loadEngine();
  // `sv_init` returns the packed library version (0x020104 for 2.1.4); only a
  // negative answer is a failure.
  if (engine.sv_init(0, SAMPLE_RATE, CHANNELS, INIT_FLAGS) < 0) {
    throw new Error("Studio: the SunVox engine would not start.");
  }
  if (engine.sv_open_slot(SLOT) < 0) {
    engine.sv_deinit();
    throw new Error("Studio: the SunVox engine would not open a slot.");
  }

  const modules = {};
  const generators = [];
  try {
    for (const type of MODULE_TYPES) {
      const moduleIndex = withSlotLock(engine, () => engine.sv_new_module(SLOT, type, "probe", 512, 512, 0));
      if (moduleIndex < 0) continue; // a type this build does not have
      try {
        const flags = engine.sv_get_module_flags(SLOT, moduleIndex);
        const controllers = [];
        const count = engine.sv_get_number_of_module_ctls(SLOT, moduleIndex);
        for (let ctl = 0; ctl < count; ctl += 1) {
          controllers.push({
            name: engine.sv_get_module_ctl_name(SLOT, moduleIndex, ctl),
            min: engine.sv_get_module_ctl_min(SLOT, moduleIndex, ctl, 0),
            max: engine.sv_get_module_ctl_max(SLOT, moduleIndex, ctl, 0),
            kind: engine.sv_get_module_ctl_type(SLOT, moduleIndex, ctl) === 1 ? "selector" : "normal",
            default: engine.sv_get_module_ctl_value(SLOT, moduleIndex, ctl, 0),
          });
        }
        const kind = (flags & GENERATOR_FLAG)
          ? "generator"
          : (flags & EFFECT_FLAG)
            ? "effect"
            : "other";
        modules[type] = { kind, controllers };
        if (kind === "generator") generators.push(type);
      } finally {
        withSlotLock(engine, () => engine.sv_remove_module(SLOT, moduleIndex));
      }
    }
  } finally {
    engine.sv_close_slot(SLOT);
  }

  // Only the self-contained synths are valid track instruments in 1a.
  GENERATOR_TYPES = Object.freeze(generators.filter((type) => INSTRUMENT_TYPES.includes(type)));
  return { modules };
}

/**
 * The SunVox module catalogue for this process.
 *
 * The first call builds it (loading the WASM engine); every later call returns
 * the same promise, so the engine is asked exactly once. A build that fails is
 * not remembered, so a transient failure can be retried.
 *
 * @returns {Promise<{modules: Object<string, {kind: string, controllers: Array<{name: string, min: number, max: number, kind: string, default: number}>}>}>}
 */
export function moduleCatalogue() {
  if (!cataloguePromise) {
    cataloguePromise = buildCatalogue().catch((err) => {
      cataloguePromise = null;
      throw err;
    });
  }
  return cataloguePromise;
}