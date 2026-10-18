/**
 * sunvox-engine.js — FFI wrapper over the vendored libsunvox.so (koffi).
 *
 * Everything runs OFFLINE (no audio device): SV_INIT_FLAG_OFFLINE pulls
 * samples via sv_audio_callback. One engine instance per process; every
 * public op is serialised through a promise queue because the lib's slot
 * model is process-global and mutators require slot locking.
 *
 * Proven by spikes 1–3 (info/render exact-match vs upstream reference,
 * compose round-trip audible; see the private engineering notes).
 */
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));

// --- init flags (vendor/sunvox.h) ---
const SV_INIT_FLAG_NO_DEBUG_OUTPUT = 1 << 0;
const SV_INIT_FLAG_OFFLINE = 1 << 1;
const SV_INIT_FLAG_AUDIO_INT16 = 1 << 2;
const SV_INIT_FLAG_ONE_THREAD = 1 << 4;
const SV_MODULE_FLAG_EXISTS = 1 << 0;
const SV_MODULE_FLAG_GENERATOR = 1 << 1;
const SV_MODULE_FLAG_EFFECT = 1 << 2;
const NOTECMD_NOTE_OFF = 128;

const SLOT = 0;
const CHUNK_FRAMES = 4096;

let koffiLib = null;
let api = null;
let engineVersion = -1;
let sampleRate = 44100;
let queue = Promise.resolve();
let catalogueCache = null;

/** Serialise all engine ops (single offline engine, one slot). */
function serial(op) {
  const run = queue.then(op, op);
  queue = run.then(() => {}, () => {});
  return run;
}

function loadLib() {
  if (api) return api;
  const koffi = require("koffi");
  const soPath = process.env.SUNVOX_LIB_PATH || path.join(HERE, "..", "vendor", "sunvox.so");
  if (!fs.existsSync(soPath)) throw new Error(`libsunvox not found at ${soPath}`);
  koffiLib = koffi.load(soPath);
  const f = (proto) => koffiLib.func(proto);
  api = {
    sv_init: f("int sv_init(const char *config, int sample_rate, int channels, uint32 flags)"),
    sv_deinit: f("int sv_deinit(void)"),
    sv_open_slot: f("int sv_open_slot(int slot)"),
    sv_close_slot: f("int sv_close_slot(int slot)"),
    sv_lock_slot: f("int sv_lock_slot(int slot)"),
    sv_unlock_slot: f("int sv_unlock_slot(int slot)"),
    sv_load: f("int sv_load(int slot, const char *filename)"),
    sv_load_from_memory: f("int sv_load_from_memory(int slot, void *data, uint32 data_size)"),
    sv_save: f("int sv_save(int slot, const char *filename)"),
    sv_get_song_name: f("const char *sv_get_song_name(int slot)"),
    sv_get_base_version: f("int sv_get_base_version(int slot)"),
    sv_get_song_bpm: f("int sv_get_song_bpm(int slot)"),
    sv_get_song_tpl: f("int sv_get_song_tpl(int slot)"),
    sv_get_song_length_frames: f("uint32 sv_get_song_length_frames(int slot)"),
    sv_get_song_length_lines: f("uint32 sv_get_song_length_lines(int slot)"),
    sv_get_number_of_modules: f("int sv_get_number_of_modules(int slot)"),
    sv_get_number_of_patterns: f("int sv_get_number_of_patterns(int slot)"),
    sv_new_module: f("int sv_new_module(int slot, const char *type, const char *name, int x, int y, int z)"),
    sv_remove_module: f("int sv_remove_module(int slot, int mod)"),
    sv_connect_module: f("int sv_connect_module(int slot, int src, int dst)"),
    sv_get_module_flags: f("uint32 sv_get_module_flags(int slot, int mod)"),
    sv_get_module_type: f("const char *sv_get_module_type(int slot, int mod)"),
    sv_get_module_name: f("const char *sv_get_module_name(int slot, int mod)"),
    sv_get_number_of_module_ctls: f("int sv_get_number_of_module_ctls(int slot, int mod)"),
    sv_get_module_ctl_name: f("const char *sv_get_module_ctl_name(int slot, int mod, int ctl)"),
    sv_get_module_ctl_min: f("int sv_get_module_ctl_min(int slot, int mod, int ctl, int scaled)"),
    sv_get_module_ctl_max: f("int sv_get_module_ctl_max(int slot, int mod, int ctl, int scaled)"),
    sv_get_module_ctl_type: f("int sv_get_module_ctl_type(int slot, int mod, int ctl)"),
    sv_get_module_ctl_value: f("int sv_get_module_ctl_value(int slot, int mod, int ctl, int scaled)"),
    sv_set_module_ctl_value: f("int sv_set_module_ctl_value(int slot, int mod, int ctl, int val, int scaled)"),
    sv_new_pattern: f("int sv_new_pattern(int slot, int clone, int x, int y, int tracks, int lines, int icon_seed, const char *name)"),
    sv_remove_pattern: f("int sv_remove_pattern(int slot, int pat)"),
    sv_set_pattern_event: f("int sv_set_pattern_event(int slot, int pat, int track, int line, int nn, int vv, int mm, int ccee, int xxyy)"),
    sv_get_pattern_name: f("const char *sv_get_pattern_name(int slot, int pat)"),
    sv_get_pattern_tracks: f("int sv_get_pattern_tracks(int slot, int pat)"),
    sv_get_pattern_lines: f("int sv_get_pattern_lines(int slot, int pat)"),
    sv_get_pattern_event: f("int sv_get_pattern_event(int slot, int pat, int track, int line, int column)"),
    sv_get_time_map: f("int sv_get_time_map(int slot, int start_line, int len, uint32 *dest, int flags)"),
    sv_set_autostop: f("int sv_set_autostop(int slot, int autostop)"),
    sv_play_from_beginning: f("int sv_play_from_beginning(int slot)"),
    sv_end_of_song: f("int sv_end_of_song(int slot)"),
    sv_audio_callback: f("int sv_audio_callback(void *buf, int frames, int latency, uint32 out_time)"),
    sv_get_ticks: f("uint32 sv_get_ticks(void)"),
    sv_get_sample_rate: f("int sv_get_sample_rate(void)"),
    sv_stop: f("int sv_stop(int slot)"),
    sv_get_log: f("const char *sv_get_log(int size)"),
  };
  return api;
}

function ensureEngine() {
  const a = loadLib();
  if (engineVersion >= 0) return a;
  const ver = a.sv_init(null, 44100, 2,
    SV_INIT_FLAG_NO_DEBUG_OUTPUT | SV_INIT_FLAG_OFFLINE | SV_INIT_FLAG_AUDIO_INT16 | SV_INIT_FLAG_ONE_THREAD);
  if (ver < 0) throw new Error(`sv_init failed: ${ver}`);
  engineVersion = ver;
  sampleRate = a.sv_get_sample_rate() || 44100;
  return a;
}

export function engineInfo() {
  return serial(() => {
    const a = ensureEngine();
    return {
      engine_version: `0x${engineVersion.toString(16)}`,
      sample_rate: sampleRate,
      lib_path: process.env.SUNVOX_LIB_PATH || path.join(HERE, "..", "vendor", "sunvox.so"),
    };
  });
}

function check(rc, what) {
  if (rc < 0) throw new Error(`${what} failed (rc=${rc}). Engine log tail: ${String(api?.sv_get_log?.(500) || "").slice(-300)}`);
  return rc;
}

/** Load a project from a Buffer into the slot (caller holds the serial queue). */
function loadBuffer(a, buf) {
  // Copy into a stable allocation — koffi passes the Buffer pointer directly.
  const data = Buffer.from(buf);
  check(a.sv_load_from_memory(SLOT, data, data.length), "sv_load_from_memory");
}

/**
 * Effective tempo via the time map (SV_TIME_MAP_SPEED = 0):
 * dest[X] = BPM | (TPL << 16) at the beginning of line X. Unlike
 * sv_get_song_bpm (project header), this reflects speed effects
 * (0x1F BPM / 0x0F TPL). Reports line 0 and the last line of a short
 * window so a caller can see where a tempo change takes hold.
 */
function effectiveTempo(a) {
  try {
    const len = a.sv_get_song_length_lines(SLOT) || 1;
    const window = Math.min(8, len);
    const dest = new Uint32Array(window);
    const rc = a.sv_get_time_map(SLOT, 0, window, dest, 0);
    if (rc < 0) return null;
    const unpack = (v) => ({ bpm: v & 0xffff, tpl: (v >> 16) & 0xffff });
    return { at_line_0: unpack(dest[0]), at_line: window - 1, ...unpack(dest[window - 1]) };
  } catch {
    return null;
  }
}

function readInfo(a) {
  const modSlots = a.sv_get_number_of_modules(SLOT);
  const patSlots = a.sv_get_number_of_patterns(SLOT);
  const modules = [];
  for (let i = 0; i < modSlots; i++) {
    const flags = a.sv_get_module_flags(SLOT, i);
    if (!(flags & SV_MODULE_FLAG_EXISTS)) continue;
    modules.push({
      num: i,
      type: a.sv_get_module_type(SLOT, i),
      name: a.sv_get_module_name(SLOT, i),
      kind: flags & SV_MODULE_FLAG_GENERATOR ? "generator" : flags & SV_MODULE_FLAG_EFFECT ? "effect" : "other",
      controllers: a.sv_get_number_of_module_ctls(SLOT, i),
    });
  }
  const patterns = [];
  for (let i = 0; i < patSlots; i++) {
    const lines = a.sv_get_pattern_lines(SLOT, i);
    if (!(lines > 0)) continue;
    patterns.push({ num: i, name: a.sv_get_pattern_name(SLOT, i), tracks: a.sv_get_pattern_tracks(SLOT, i), lines });
  }
  return {
    name: a.sv_get_song_name(SLOT),
    bpm: a.sv_get_song_bpm(SLOT),
    tpl: a.sv_get_song_tpl(SLOT),
    effective_tempo: effectiveTempo(a),
    length_frames: a.sv_get_song_length_frames(SLOT),
    length_lines: a.sv_get_song_length_lines(SLOT),
    duration_s: +(a.sv_get_song_length_frames(SLOT) / sampleRate).toFixed(3),
    sample_rate: sampleRate,
    modules: modules.length,
    module_list: modules,
    patterns: patterns.length,
    pattern_list: patterns,
  };
}

/** sunvox_info: structured metadata for a .sunvox/.xm/.mod file. */
export function info(buf) {
  return serial(() => {
    const a = ensureEngine();
    a.sv_open_slot(SLOT);
    try {
      loadBuffer(a, buf);
      return readInfo(a);
    } finally {
      a.sv_close_slot(SLOT);
    }
  });
}

function renderFrames(a, maxTailFrames) {
  a.sv_set_autostop(SLOT, 1);
  a.sv_play_from_beginning(SLOT);
  const buf = Buffer.alloc(CHUNK_FRAMES * 2 * 2);
  const chunks = [];
  let frames = 0;
  let silentRuns = 0;
  const songLen = a.sv_get_song_length_frames(SLOT);
  while (true) {
    const filled = a.sv_audio_callback(buf, CHUNK_FRAMES, 0, a.sv_get_ticks());
    const isSilent = !filled || buf.every((b) => b === 0);
    if (a.sv_end_of_song(SLOT)) {
      if (isSilent) silentRuns++;
      if (silentRuns >= 8 || frames > songLen + maxTailFrames) break;
    }
    chunks.push(Buffer.from(buf));
    frames += CHUNK_FRAMES;
    if (frames > sampleRate * 3600 * 4) throw new Error("render exceeded 4h — runaway project?");
  }
  a.sv_stop(SLOT);
  return { pcm: Buffer.concat(chunks), frames };
}

function wavEncode(pcm, frames) {
  const dataSize = frames * 2 * 2;
  const hdr = Buffer.alloc(44);
  hdr.write("RIFF", 0);
  hdr.writeUInt32LE(36 + Math.min(dataSize, 0xffffffff - 36), 4);
  hdr.write("WAVE", 8);
  hdr.write("fmt ", 12);
  hdr.writeUInt32LE(16, 16);
  hdr.writeUInt16LE(1, 20);
  hdr.writeUInt16LE(2, 22);
  hdr.writeUInt32LE(sampleRate, 24);
  hdr.writeUInt32LE(sampleRate * 4, 28);
  hdr.writeUInt16LE(4, 32);
  hdr.writeUInt16LE(16, 34);
  hdr.write("data", 36);
  hdr.writeUInt32LE(dataSize, 40);
  return Buffer.concat([hdr, pcm]);
}

/** sunvox_render: offline render → WAV Buffer + info. */
export function render(buf) {
  return serial(() => {
    const a = ensureEngine();
    a.sv_open_slot(SLOT);
    try {
      loadBuffer(a, buf);
      const infoObj = readInfo(a);
      const { pcm, frames } = renderFrames(a, sampleRate * 2);
      return { info: infoObj, wav: wavEncode(pcm, frames), frames };
    } finally {
      a.sv_close_slot(SLOT);
    }
  });
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

const SEMITONES = { C: 0, "C#": 1, DB: 1, D: 2, "D#": 3, EB: 3, E: 4, F: 5, "F#": 6, GB: 6, G: 7, "G#": 8, AB: 8, A: 9, "A#": 10, BB: 10, B: 11 };

/** "C#4" | "Bb2" | 60 → SunVox note number (C0 = 1). */
export function parseNote(n) {
  if (typeof n === "number") {
    if (n < 1 || n > 127) throw new Error(`note number out of range: ${n}`);
    return n;
  }
  const m = /^([A-Ga-g][#b]?)(-?\d)$/.exec(String(n).trim());
  if (!m) throw new Error(`cannot parse note "${n}" (use e.g. C3, F#4, Bb2, or 1..127)`);
  const key = m[1].toUpperCase().replace("B", "B").replace("#", "#");
  const norm = m[1][1] === "b" ? m[1][0].toUpperCase() + "B" : m[1].toUpperCase();
  const semi = SEMITONES[norm] ?? SEMITONES[key];
  if (semi === undefined) throw new Error(`unknown note name "${n}"`);
  const oct = parseInt(m[2], 10);
  const num = oct * 12 + semi + 1;
  if (num < 1 || num > 127) throw new Error(`note "${n}" out of range (num=${num})`);
  return num;
}

function findCtl(a, mod, name) {
  const n = a.sv_get_number_of_module_ctls(SLOT, mod);
  for (let c = 0; c < n; c++) {
    if (String(a.sv_get_module_ctl_name(SLOT, mod, c)).toLowerCase() === String(name).toLowerCase()) return c;
  }
  const valid = [];
  for (let c = 0; c < n; c++) valid.push(a.sv_get_module_ctl_name(SLOT, mod, c));
  throw new Error(`module ${mod}: no controller "${name}". Valid: ${valid.join(", ")}`);
}

/**
 * sunvox_compose: build a project from a constrained JSON spec.
 * Returns { project: Buffer (.sunvox bytes), info } — the slot holds the
 * fresh project (Output auto-exists at module 0), then it is saved to a
 * temp file, reloaded and described.
 *
 * Spec:
 *   { bpm?, tpl?,
 *     modules: [{ id, type, name?, params?: {ctlName: value}, x?, y? }],
 *     connections?: [[idOrOut, idOrOut, ...], ...],   // chains; "out" = Output
 *     patterns: [{ id?, name?, tracks, lines, x?, y?,
 *                  events: [{ track, line, note?, velocity?, module (id),
 *                             ctl?, ctl_val?, effect?, effect_param?, note_off? }] }] }
 * Modules whose id never appears as a chain source are auto-connected to Output.
 * bpm/tpl are applied via tracker speed effects at the first pattern's line 0
 * (0x1F "Set BPM to XXYY" in a free cell; TPL via 0x0F "Set playing speed").
 * NOTE: these affect PLAYBACK speed from line 0 on — sv_get_song_bpm() still
 * reports the project header default (125/6); effective tempo is verified via
 * sv_get_time_map(SV_TIME_MAP_SPEED).
 */
export function compose(spec, { name = "crow-compose" } = {}) {
  return serial(() => {
    const a = ensureEngine();
    if (!spec || typeof spec !== "object") throw new Error("spec must be an object");
    if (!Array.isArray(spec.modules) || spec.modules.length === 0) throw new Error("spec.modules must be a non-empty array");
    if (!Array.isArray(spec.patterns) || spec.patterns.length === 0) throw new Error("spec.patterns must be a non-empty array");

    a.sv_open_slot(SLOT);
    try {
      // Output auto-exists at module 0 in a fresh slot.
      let outMod = -1;
      const n0 = a.sv_get_number_of_modules(SLOT);
      for (let i = 0; i < n0; i++) {
        if ((a.sv_get_module_flags(SLOT, i) & SV_MODULE_FLAG_EXISTS) && a.sv_get_module_type(SLOT, i) === "Output") { outMod = i; break; }
      }
      if (outMod < 0) throw new Error("fresh slot has no Output module — unexpected engine state");

      // Remove the fresh project's default empty pattern so the composed
      // project contains exactly the spec's patterns.
      const patSlots0 = a.sv_get_number_of_patterns(SLOT);
      for (let i = patSlots0 - 1; i >= 0; i--) {
        if (a.sv_get_pattern_lines(SLOT, i) > 0) {
          a.sv_lock_slot(SLOT);
          a.sv_remove_pattern(SLOT, i);
          a.sv_unlock_slot(SLOT);
        }
      }

      // --- modules ---
      const ids = new Map(); // spec id -> module number
      const seenTypes = new Set();
      for (const m of spec.modules) {
        if (!m || typeof m.id !== "string" || !m.id) throw new Error("every module needs a string id");
        if (ids.has(m.id)) throw new Error(`duplicate module id "${m.id}"`);
        if (/^out(put)?$/i.test(m.id)) throw new Error(`module id "${m.id}" is reserved (Output is module 0, referenced as "out")`);
        if (String(m.type).toLowerCase() === "output") throw new Error("do not create an Output module — it exists automatically; connect chains to \"out\"");
        seenTypes.add(m.type);
        a.sv_lock_slot(SLOT);
        const mod = a.sv_new_module(SLOT, String(m.type), String(m.name || m.id), m.x ?? 512, m.y ?? 400, 0);
        a.sv_unlock_slot(SLOT);
        if (mod < 0) throw new Error(`sv_new_module failed for type "${m.type}" (rc=${mod}). Use sunvox_module_types for valid types.`);
        ids.set(m.id, mod);
        for (const [pname, pval] of Object.entries(m.params || {})) {
          const c = findCtl(a, mod, pname);
          const rc = a.sv_set_module_ctl_value(SLOT, mod, c, pval | 0, 0);
          if (rc < 0) throw new Error(`set param "${pname}" on "${m.id}" failed (rc=${rc})`);
        }
      }

      // --- connections ---
      const resolveId = (id) => {
        if (/^out(put)?$/i.test(String(id))) return outMod;
        const mod = ids.get(id);
        if (mod === undefined) throw new Error(`connection references unknown module id "${id}"`);
        return mod;
      };
      const chainSources = new Set();
      for (const chain of spec.connections || []) {
        if (!Array.isArray(chain) || chain.length < 2) throw new Error("each connection must be a chain of >= 2 module ids");
        for (let i = 0; i < chain.length - 1; i++) {
          const src = resolveId(chain[i]);
          const dst = resolveId(chain[i + 1]);
          chainSources.add(chain[i]);
          a.sv_lock_slot(SLOT);
          const rc = a.sv_connect_module(SLOT, src, dst);
          a.sv_unlock_slot(SLOT);
          if (rc < 0) throw new Error(`connect ${chain[i]} -> ${chain[i + 1]} failed (rc=${rc})`);
        }
      }
      // auto-connect unconnected modules to Output
      for (const [id, mod] of ids) {
        if (chainSources.has(id)) continue;
        a.sv_lock_slot(SLOT);
        a.sv_connect_module(SLOT, mod, outMod);
        a.sv_unlock_slot(SLOT);
      }

      // --- patterns ---
      let firstPat = -1;
      for (const p of spec.patterns) {
        const tracks = p.tracks | 0 || 1;
        const lines = p.lines | 0 || 64;
        if (tracks < 1 || lines < 1) throw new Error("pattern tracks/lines must be >= 1");
        a.sv_lock_slot(SLOT);
        const pat = a.sv_new_pattern(SLOT, -1, p.x ?? 0, p.y ?? 0, tracks, lines, Math.floor(Math.random() * 1e6), String(p.name || p.id || "pattern"));
        a.sv_unlock_slot(SLOT);
        if (pat < 0) throw new Error(`sv_new_pattern failed (rc=${pat})`);
        if (firstPat < 0) firstPat = pat;
        for (const ev of p.events || []) {
          const track = ev.track | 0;
          const line = ev.line | 0;
          if (track < 0 || track >= tracks) throw new Error(`event track ${track} out of range (pattern has ${tracks})`);
          if (line < 0 || line >= lines) throw new Error(`event line ${line} out of range (pattern has ${lines})`);
          let nn = 0;
          if (ev.note_off) nn = NOTECMD_NOTE_OFF;
          else if (ev.note !== undefined && ev.note !== null) nn = parseNote(ev.note);
          const vv = Math.max(0, Math.min(129, ev.velocity === undefined ? 0 : ev.velocity | 0));
          let mm = 0;
          if (ev.module !== undefined) {
            const mod = ids.get(ev.module);
            if (mod === undefined) throw new Error(`event references unknown module id "${ev.module}"`);
            mm = mod + 1;
          }
          let ccee = 0;
          let xxyy = 0;
          if (ev.ctl !== undefined) { ccee = ((ev.ctl | 0) + 1) << 8; xxyy = ev.ctl_val | 0; }
          else if (ev.effect !== undefined) { ccee = ev.effect | 0; xxyy = ev.effect_param | 0; }
          const rc = a.sv_set_pattern_event(SLOT, pat, track, line, nn, vv, mm, ccee, xxyy);
          if (rc < 0) throw new Error(`set event at pattern ${pat} track ${track} line ${line} failed (rc=${rc})`);
        }
      }

      // --- tempo via speed effects merged into line 0 of the first pattern ---
      // Effect codes per the SunVox manual: 0x1F = Set BPM to XXYY;
      // 0x0F = Set playing speed (YY: 1..0x1F = TPL). sv_set_pattern_event
      // writes only non-negative values, so nn/vv/mm = -1 merge the effect
      // into a cell WITHOUT clobbering an existing note. Cells whose ctl
      // column (3) is already taken are skipped.
      if (spec.bpm || spec.tpl) {
        const bpm = Math.max(1, Math.min(65535, spec.bpm | 0 || 0));
        const tpl = Math.max(1, Math.min(31, spec.tpl | 0 || 0));
        const firstTracks = a.sv_get_pattern_tracks(SLOT, firstPat);
        const place = (ee, xxyy) => {
          for (let tr = 0; tr < firstTracks; tr++) {
            if (a.sv_get_pattern_event(SLOT, firstPat, tr, 0, 3) !== 0) continue; // ctl/effect column occupied
            const rc = a.sv_set_pattern_event(SLOT, firstPat, tr, 0, -1, -1, -1, ee, xxyy);
            if (rc < 0) throw new Error(`tempo effect 0x${ee.toString(16)} failed (rc=${rc})`);
            return;
          }
          throw new Error("no free ctl column in the first pattern's line 0 for the tempo effect");
        };
        if (bpm) place(0x1f, bpm);
        if (tpl) place(0x0f, tpl);
      }

      // --- save to temp, reload, verify ---
      const tmp = path.join(fs.mkdtempSync(path.join(require("node:os").tmpdir(), "sunvox-")), `${sanitizeName(name)}.sunvox`);
      check(a.sv_save(SLOT, tmp), "sv_save");
      a.sv_close_slot(SLOT);
      a.sv_open_slot(SLOT);
      check(a.sv_load(SLOT, tmp), "sv_load (reload of composed project)");
      const project = fs.readFileSync(tmp);
      fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
      const infoObj = readInfo(a);
      a.sv_close_slot(SLOT);
      return { project, info: infoObj };
    } catch (err) {
      try { a.sv_close_slot(SLOT); } catch {}
      throw err;
    }
  });
}

function sanitizeName(n) {
  return String(n).replace(/[^a-zA-Z0-9 _.-]/g, "").slice(0, 80) || "crow-compose";
}

/** sunvox_module_types: live-generate the module/controller catalogue. */
export function moduleCatalogue() {
  return serial(() => {
    if (catalogueCache) return catalogueCache;
    const a = ensureEngine();
    const TYPES = [
      "Analog generator", "Generator", "DrumSynth", "Sampler", "SpectraVoice", "Vorbis player", "Input",
      "Echo", "Delay", "Reverb", "Filter", "EQ", "Compressor", "Flanger", "Vibrato", "WaveShaper", "DC Blocker",
      "LFO", "MultiSynth", "MultiCtl", "Sound2Ctl", "Velocity2Ctl", "MetaModule", "Amplifier",
    ];
    a.sv_open_slot(SLOT);
    try {
      const cat = {};
      for (const type of TYPES) {
        a.sv_lock_slot(SLOT);
        const mod = a.sv_new_module(SLOT, type, "probe", 512, 512, 0);
        a.sv_unlock_slot(SLOT);
        if (mod < 0) continue;
        const nctls = a.sv_get_number_of_module_ctls(SLOT, mod);
        const ctls = [];
        for (let c = 0; c < nctls; c++) {
          ctls.push({
            name: a.sv_get_module_ctl_name(SLOT, mod, c),
            min: a.sv_get_module_ctl_min(SLOT, mod, c, 0),
            max: a.sv_get_module_ctl_max(SLOT, mod, c, 0),
            kind: a.sv_get_module_ctl_type(SLOT, mod, c) === 1 ? "selector" : "normal",
            default: a.sv_get_module_ctl_value(SLOT, mod, c, 0),
          });
        }
        const flags = a.sv_get_module_flags(SLOT, mod);
        cat[type] = {
          kind: flags & SV_MODULE_FLAG_GENERATOR ? "generator" : flags & SV_MODULE_FLAG_EFFECT ? "effect" : "other",
          controllers: ctls,
        };
        a.sv_lock_slot(SLOT);
        a.sv_remove_module(SLOT, mod);
        a.sv_unlock_slot(SLOT);
      }
      catalogueCache = { output_note: "Output exists automatically at module 0 in every project; reference it as \"out\" in connections.", modules: cat };
      return catalogueCache;
    } finally {
      a.sv_close_slot(SLOT);
    }
  });
}

export function shutdown() {
  if (engineVersion < 0) return;
  try { api.sv_deinit(); } catch {}
  engineVersion = -1;
}
