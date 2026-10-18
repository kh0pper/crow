/**
 * Spike 2 — module type catalogue generator (feeds sunvox_module_types / sunvox_compose).
 * Instantiates each known SunVox module type in a scratch slot, reads its
 * controller metadata, dumps JSON to spike/module-catalogue.json.
 *
 * Type list from the SunVox 2.1 manual (no enumeration API exists).
 */
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const koffi = require("koffi");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const lib = koffi.load(path.join(HERE, "..", "vendor", "sunvox.so"));
const f = (p) => lib.func(p);

const sv_init = f("int sv_init(const char *c, int sr, int ch, uint32 flags)");
const sv_deinit = f("int sv_deinit(void)");
const sv_open_slot = f("int sv_open_slot(int s)");
const sv_close_slot = f("int sv_close_slot(int s)");
const sv_new_module = f("int sv_new_module(int s, const char *type, const char *name, int x, int y, int z)");
const sv_remove_module = f("int sv_remove_module(int s, int mod)");
const sv_lock_slot = f("int sv_lock_slot(int s)");
const sv_unlock_slot = f("int sv_unlock_slot(int s)");
const sv_get_number_of_module_ctls = f("int sv_get_number_of_module_ctls(int s, int mod)");
const sv_get_module_ctl_name = f("const char *sv_get_module_ctl_name(int s, int mod, int ctl)");
const sv_get_module_ctl_min = f("int sv_get_module_ctl_min(int s, int mod, int ctl, int scaled)");
const sv_get_module_ctl_max = f("int sv_get_module_ctl_max(int s, int mod, int ctl, int scaled)");
const sv_get_module_ctl_type = f("int sv_get_module_ctl_type(int s, int mod, int ctl)");
const sv_get_module_ctl_value = f("int sv_get_module_ctl_value(int s, int mod, int ctl, int scaled)");
const sv_get_module_inputs = f("int sv_get_module_inputs(int s, int mod)"); // skip ptr read
const sv_get_module_flags = f("uint32 sv_get_module_flags(int s, int mod)");

// SunVox 2.1 manual module names (exact spelling matters)
const TYPES = [
  // generators / instruments
  "Analog generator", "Generator", "DrumSynth", "Sampler", "SpectraVoice", "Vorbis player", "Input",
  // effects
  "Echo", "Delay", "Reverb", "Filter", "EQ", "Compressor", "Flanger", "Vibrato", "WaveShaper", "DC Blocker",
  // control / utility
  "LFO", "MultiSynth", "MultiCtl", "Sound2Ctl", "Velocity2Ctl", "Envelope", "Midi2Ctl", "MetaModule",
  // bus
  "Output", "Amplifier",
];

const FLAGS = (1 << 0) | (1 << 1) | (1 << 2) | (1 << 4); // NODEBUG|OFFLINE|INT16|ONE_THREAD
const ver = sv_init(null, 44100, 2, FLAGS);
if (ver < 0) { console.error("sv_init failed", ver); process.exit(1); }
sv_open_slot(0);

const catalogue = {};
const failed = [];
for (const type of TYPES) {
  sv_lock_slot(0);
  const mod = sv_new_module(0, type, "probe", 512, 512, 0);
  sv_unlock_slot(0);
  if (mod < 0) { failed.push(type); continue; }
  const nctls = sv_get_number_of_module_ctls(0, mod);
  const ctls = [];
  for (let c = 0; c < nctls; c++) {
    ctls.push({
      name: sv_get_module_ctl_name(0, mod, c),
      min: sv_get_module_ctl_min(0, mod, c, 0),
      max: sv_get_module_ctl_max(0, mod, c, 0),
      type: sv_get_module_ctl_type(0, mod, c) === 1 ? "selector" : "normal",
      default: sv_get_module_ctl_value(0, mod, c, 0),
    });
  }
  const flags = sv_get_module_flags(0, mod);
  catalogue[type] = {
    inputs: (flags >> 16) & 0xff,
    outputs: (flags >> 24) & 0xff,
    kind: (flags & (1 << 1)) ? "generator" : (flags & (1 << 2)) ? "effect" : "other",
    controllers: ctls,
  };
  sv_lock_slot(0);
  sv_remove_module(0, mod);
  sv_unlock_slot(0);
}
sv_close_slot(0);
sv_deinit();

fs.writeFileSync(path.join(HERE, "module-catalogue.json"), JSON.stringify(catalogue, null, 2));
console.log(`catalogued ${Object.keys(catalogue).length} module types`);
if (failed.length) console.log("FAILED type strings (wrong spelling or unavailable):", failed.join(", "));
for (const [t, m] of Object.entries(catalogue)) {
  console.log(`\n${t} (in:${m.inputs} out:${m.outputs}, ${m.controllers.length} ctls): ${m.controllers.map((c) => c.name).join(", ").slice(0, 160)}`);
}
