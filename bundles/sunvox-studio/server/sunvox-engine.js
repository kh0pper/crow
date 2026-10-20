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
import { createHash } from "node:crypto";

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

/** sha256 of the vendored linux x86_64 libsunvox 2.1.4d (vendor/sunvox.so). */
export const VENDORED_SO_SHA256 = "291b24de4461b0942ff45c364bdc9d3fdf7845038a496cfa5ca34872c952006b";

/**
 * Resource limits. A render holds its PCM in memory (4 bytes/frame at
 * 44.1 kHz stereo int16, about 10.6 MB per minute), so the default cap of
 * 20 minutes keeps one render near 210 MB. SUNVOX_MAX_RENDER_SECONDS raises
 * or lowers it (hard ceiling 60 min). Compose specs are bounded so a single
 * call cannot ask the engine for unbounded patterns or events.
 */
const envInt = (k, d) => { const v = parseInt(process.env[k] || "", 10); return Number.isFinite(v) && v > 0 ? v : d; };
export const LIMITS = Object.freeze({
  maxRenderSeconds: Math.min(envInt("SUNVOX_MAX_RENDER_SECONDS", 20 * 60), 60 * 60),
  maxModules: 128,
  maxPatterns: 256,
  maxTracks: 32,
  maxLines: 4096,
  maxEvents: 65536,
  maxCells: 2 * 1024 * 1024, // tracks x lines summed over all patterns
  maxArrangement: 4096, // placements on the timeline (repeats are clones sharing data)
  maxTimelineX: 1024 * 1024, // the line a placement may start at
  maxTimelineY: 1024, // |y| of a placement (timeline rows)
});

/**
 * Output sample rates a render may ask for. The library falls back to 44100
 * for anything lower (verified: 22050 and 32000 render at 44100), and higher
 * rates would raise the render memory ceiling past the 20-minute budget.
 */
export const SAMPLE_RATES = Object.freeze([44100, 48000]);

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
  // The vendored library is hash-pinned (spec §4.4). An operator-supplied
  // SUNVOX_LIB_PATH is their own choice and is not checked against the pin.
  if (!process.env.SUNVOX_LIB_PATH) {
    const got = createHash("sha256").update(fs.readFileSync(soPath)).digest("hex");
    if (got !== VENDORED_SO_SHA256) throw new Error(`vendor/sunvox.so sha256 ${got} does not match the pinned ${VENDORED_SO_SHA256} — refusing to load`);
  }
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
    sv_set_song_name: f("int sv_set_song_name(int slot, const char *name)"),
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
    sv_get_module_xy: f("uint32 sv_get_module_xy(int slot, int mod)"),
    sv_get_module_color: f("int sv_get_module_color(int slot, int mod)"),
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
    sv_get_pattern_x: f("int sv_get_pattern_x(int slot, int pat)"),
    sv_get_pattern_y: f("int sv_get_pattern_y(int slot, int pat)"),
    sv_set_pattern_xy: f("int sv_set_pattern_xy(int slot, int pat, int x, int y)"),
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

/** The engine at `rate` (re-initialised when a render asks for another rate;
 *  callers hold the serial queue, and no slot is open between ops). */
function ensureEngine(rate = 44100) {
  const a = loadLib();
  if (!SAMPLE_RATES.includes(rate)) throw new Error(`sample_rate must be one of ${SAMPLE_RATES.join(", ")}, got ${JSON.stringify(rate)}`);
  if (engineVersion >= 0 && sampleRate === rate) return a;
  if (engineVersion >= 0) { a.sv_deinit(); engineVersion = -1; }
  const ver = a.sv_init(null, rate, 2,
    SV_INIT_FLAG_NO_DEBUG_OUTPUT | SV_INIT_FLAG_OFFLINE | SV_INIT_FLAG_AUDIO_INT16 | SV_INIT_FLAG_ONE_THREAD);
  if (ver < 0) throw new Error(`sv_init failed: ${ver}`);
  engineVersion = ver;
  sampleRate = a.sv_get_sample_rate() || rate;
  if (sampleRate !== rate) throw new Error(`the engine runs at ${sampleRate} Hz, not the requested ${rate} Hz`);
  return a;
}

/** A packed version as a dotted string: 4 bytes for a project's base version
 *  (sv_get_base_version 0x02010403 → "2.1.4.3"), 3 for the engine (sv_init
 *  0x020104 → "2.1.4"). */
export function versionString(v, parts = 4) {
  if (!Number.isInteger(v) || v < 0) return null;
  const out = [];
  for (let i = parts - 1; i >= 0; i--) out.push((v >>> (8 * i)) & 0xff);
  return out.join(".");
}

/**
 * The file format from its first bytes: SunVox projects start with "SVOX",
 * FastTracker XM with "Extended Module:", ProTracker-style MOD files carry a
 * four-character tag at offset 1080 (M.K., FLT4, 8CHN, ...).
 */
export function detectFormat(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  if (b.length >= 4 && b.toString("latin1", 0, 4) === "SVOX") return "sunvox";
  if (b.length >= 17 && b.toString("latin1", 0, 17) === "Extended Module: ") return "xm";
  if (b.length >= 1084) {
    const tag = b.toString("latin1", 1080, 1084);
    if (/^(M\.K\.|M!K!|M&K!|FLT[48]|FA0[468]|CD81|OKTA|OCTA|TDZ[1-9]|\dCHN|\d\dCH|\d\dCN)$/.test(tag)) return "mod";
  }
  return "unknown";
}

const signed16 = (v) => ((v & 0xffff) ^ 0x8000) - 0x8000;
/** "#rrggbb" from the engine's 0xBBGGRR. */
export function colorHex(bgr) {
  const r = bgr & 0xff, g = (bgr >> 8) & 0xff, b = (bgr >> 16) & 0xff;
  return "#" + [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("");
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

/** Run a mutator under the slot lock; the lock is released even if the FFI
 *  call throws (koffi throws on a non-numeric int argument). */
export function withLock(a, fn) {
  a.sv_lock_slot(SLOT);
  try { return fn(); } finally { a.sv_unlock_slot(SLOT); }
}

/** A finite integer from a spec field, or the default; anything else is an error. */
function int(v, d, what) {
  if (v === undefined || v === null) return d;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${what} must be a number, got ${JSON.stringify(v)}`);
  return Math.trunc(v);
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
    const xy = a.sv_get_module_xy(SLOT, i);
    modules.push({
      num: i,
      type: a.sv_get_module_type(SLOT, i),
      name: a.sv_get_module_name(SLOT, i),
      kind: flags & SV_MODULE_FLAG_GENERATOR ? "generator" : flags & SV_MODULE_FLAG_EFFECT ? "effect" : "other",
      controllers: a.sv_get_number_of_module_ctls(SLOT, i),
      x: signed16(xy),
      y: signed16(xy >>> 16),
      color: colorHex(a.sv_get_module_color(SLOT, i)),
    });
  }
  const patterns = [];
  for (let i = 0; i < patSlots; i++) {
    const lines = a.sv_get_pattern_lines(SLOT, i);
    if (!(lines > 0)) continue;
    patterns.push({ num: i, name: a.sv_get_pattern_name(SLOT, i), tracks: a.sv_get_pattern_tracks(SLOT, i), lines, x: a.sv_get_pattern_x(SLOT, i), y: a.sv_get_pattern_y(SLOT, i) });
  }
  const baseVersion = a.sv_get_base_version(SLOT);
  return {
    name: a.sv_get_song_name(SLOT),
    version: versionString(baseVersion),
    base_version: baseVersion >= 0 ? `0x${baseVersion.toString(16)}` : null,
    engine_version: versionString(engineVersion, 3),
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
      return { format: detectFormat(buf), ...readInfo(a) };
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
    if (frames > sampleRate * LIMITS.maxRenderSeconds + maxTailFrames + CHUNK_FRAMES) { // the pre-check bounds the song; allow its tail
      a.sv_stop(SLOT);
      throw new Error(`render exceeded ${LIMITS.maxRenderSeconds} s (SUNVOX_MAX_RENDER_SECONDS) — project too long or never ends`);
    }
  }
  a.sv_stop(SLOT);
  return { chunks, frames };
}

function wavEncode(chunks, frames) {
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
  return Buffer.concat([hdr, ...chunks]); // one copy: the chunks are never joined separately
}

/** sunvox_render: offline render → WAV Buffer + info, at `sampleRate` (44100 or 48000). */
export function render(buf, { sampleRate: rate = 44100 } = {}) {
  return serial(() => {
    const a = ensureEngine(rate);
    a.sv_open_slot(SLOT);
    try {
      loadBuffer(a, buf);
      const infoObj = readInfo(a);
      if (infoObj.length_frames > sampleRate * LIMITS.maxRenderSeconds) {
        throw new Error(`project is ${infoObj.duration_s} s long; renders are capped at ${LIMITS.maxRenderSeconds} s (SUNVOX_MAX_RENDER_SECONDS)`);
      }
      const { chunks, frames } = renderFrames(a, sampleRate * 2);
      return { info: { format: detectFormat(buf), ...infoObj }, wav: wavEncode(chunks, frames), frames, sample_rate: sampleRate };
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
 *                             ctl?, ctl_val?, effect?, effect_param?, note_off? }] }],
 *     arrangement?: [{ pattern (id or name), x?, y? }, ...] }   // see planArrangement
 * Modules whose id never appears as a chain source are auto-connected to Output.
 * Module params must lie inside each controller's min..max. The tool's name
 * becomes the project's song name.
 * bpm/tpl are applied via tracker speed effects at line 0 of the pattern that plays first
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
    if (spec.modules.length > LIMITS.maxModules) throw new Error(`spec.modules: at most ${LIMITS.maxModules} modules`);
    if (spec.patterns.length > LIMITS.maxPatterns) throw new Error(`spec.patterns: at most ${LIMITS.maxPatterns} patterns`);
    let eventCount = 0;
    let cells = 0;
    for (const p of spec.patterns) {
      if (!p || typeof p !== "object") throw new Error("every pattern must be an object");
      // tracks/lines: integers in [1, max] after the defaults (1 track, 64
      // lines). Checked before summing so a negative value cannot lower the
      // cell total and slip past maxCells.
      const tracks = p.tracks === undefined || p.tracks === null ? 1 : p.tracks;
      const lines = p.lines === undefined || p.lines === null ? 64 : p.lines;
      if (!Number.isInteger(tracks) || tracks < 1 || tracks > LIMITS.maxTracks) throw new Error(`pattern tracks: an integer from 1 to ${LIMITS.maxTracks}, got ${JSON.stringify(p.tracks)}`);
      if (!Number.isInteger(lines) || lines < 1 || lines > LIMITS.maxLines) throw new Error(`pattern lines: an integer from 1 to ${LIMITS.maxLines}, got ${JSON.stringify(p.lines)}`);
      if (p.events !== undefined && !Array.isArray(p.events)) throw new Error("pattern events must be an array");
      if ((p.events || []).some((ev) => !ev || typeof ev !== "object")) throw new Error("every pattern event must be an object");
      cells += tracks * lines;
      eventCount += (p.events || []).length;
    }
    if (eventCount > LIMITS.maxEvents) throw new Error(`spec has ${eventCount} events; at most ${LIMITS.maxEvents}`);
    if (cells > LIMITS.maxCells) throw new Error(`spec patterns total ${cells} cells (tracks x lines); at most ${LIMITS.maxCells}`);
    const placements = planArrangement(spec);
    const songName = cleanSongName(name);

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
          withLock(a, () => a.sv_remove_pattern(SLOT, i));
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
        const mod = withLock(a, () => a.sv_new_module(SLOT, String(m.type), String(m.name || m.id), int(m.x, 512, "module x"), int(m.y, 400, "module y"), 0));
        if (mod < 0) throw new Error(`sv_new_module failed for type "${m.type}" (rc=${mod}). Use sunvox_module_types for valid types.`);
        ids.set(m.id, mod);
        for (const [pname, pval] of Object.entries(m.params || {})) {
          const c = findCtl(a, mod, pname);
          // Controller values are numbers (selectors are indexes): a string
          // such as "sawtooth" used to coerce silently to 0.
          if (typeof pval !== "number" || !Number.isFinite(pval)) {
            throw new Error(`param "${pname}" on "${m.id}" must be a number (selectors take an index; see sunvox_module_types for min/max), got ${JSON.stringify(pval)}`);
          }
          const v = Math.trunc(pval);
          const lo = a.sv_get_module_ctl_min(SLOT, mod, c, 0), hi = a.sv_get_module_ctl_max(SLOT, mod, c, 0);
          if (v < lo || v > hi) throw new Error(`param "${pname}" on "${m.id}" must be from ${lo} to ${hi} (see sunvox_module_types), got ${JSON.stringify(pval)}`);
          const rc = a.sv_set_module_ctl_value(SLOT, mod, c, v, 0);
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
          const rc = withLock(a, () => a.sv_connect_module(SLOT, src, dst));
          if (rc < 0) throw new Error(`connect ${chain[i]} -> ${chain[i + 1]} failed (rc=${rc})`);
        }
      }
      // auto-connect unconnected modules to Output
      for (const [id, mod] of ids) {
        if (chainSources.has(id)) continue;
        withLock(a, () => a.sv_connect_module(SLOT, mod, outMod));
      }

      // --- patterns ---
      // The icon seed is derived from the pattern's name and index (it used to
      // be random), so the same spec always saves the same bytes.
      const patNums = []; // spec index -> pattern number
      for (const [pi, p] of spec.patterns.entries()) {
        const tracks = p.tracks | 0 || 1;
        const lines = p.lines | 0 || 64;
        if (tracks < 1 || lines < 1) throw new Error("pattern tracks/lines must be >= 1");
        const pname = String(p.name || p.id || "pattern");
        const pat = withLock(a, () => a.sv_new_pattern(SLOT, -1, int(p.x, 0, "pattern x"), int(p.y, 0, "pattern y"), tracks, lines, iconSeed(pname, pi), pname));
        if (pat < 0) throw new Error(`sv_new_pattern failed (rc=${pat})`);
        patNums.push(pat);
        for (const ev of p.events || []) {
          const range = (v, lo, hi, what) => {
            if (!Number.isInteger(v) || v < lo || v > hi) throw new Error(`${what} must be an integer from ${lo} to ${hi}, got ${JSON.stringify(v)}`);
            return v;
          };
          const track = range(ev.track ?? 0, 0, tracks - 1, `event track (pattern has ${tracks})`);
          const line = range(ev.line ?? 0, 0, lines - 1, `event line (pattern has ${lines})`);
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
          if (ev.ctl !== undefined) { ccee = (range(ev.ctl, 0, 126, "event ctl") + 1) << 8; xxyy = range(ev.ctl_val ?? 0, 0, 0xffff, "event ctl_val"); }
          else if (ev.effect !== undefined) { ccee = range(ev.effect, 0, 0xff, "event effect"); xxyy = range(ev.effect_param ?? 0, 0, 0xffff, "event effect_param"); }
          const rc = a.sv_set_pattern_event(SLOT, pat, track, line, nn, vv, mm, ccee, xxyy);
          if (rc < 0) throw new Error(`set event at pattern ${pat} track ${track} line ${line} failed (rc=${rc})`);
        }
      }

      // --- arrangement: first placement moves the pattern, repeats are clones ---
      // Every placement was validated by planArrangement before the slot opened.
      if (placements) {
        const placed = new Set();
        for (const pl of placements) {
          const src = patNums[pl.index];
          if (!placed.has(pl.index)) {
            placed.add(pl.index);
            const rc = withLock(a, () => a.sv_set_pattern_xy(SLOT, src, pl.x, pl.y));
            if (rc < 0) throw new Error(`placing pattern "${pl.ref}" failed (rc=${rc})`);
          } else {
            const p = spec.patterns[pl.index];
            const clone = withLock(a, () => a.sv_new_pattern(SLOT, src, pl.x, pl.y, a.sv_get_pattern_tracks(SLOT, src), a.sv_get_pattern_lines(SLOT, src), iconSeed(String(p.name || p.id || "pattern"), pl.index), String(p.name || p.id || "pattern")));
            if (clone < 0) throw new Error(`repeating pattern "${pl.ref}" at line ${pl.x} failed (rc=${clone})`);
          }
        }
      }

      // The tempo goes into the pattern that plays FIRST (lowest x, then lowest
      // y), so it takes hold from the start of the song whatever the spec order.
      let firstPat = -1;
      {
        // Scan every pattern slot, clones included (a repeat placed earlier
        // than its original shares the original's data, so either works).
        let best = null;
        const nSlots = a.sv_get_number_of_patterns(SLOT);
        for (let pat = 0; pat < nSlots; pat++) {
          if (!(a.sv_get_pattern_lines(SLOT, pat) > 0)) continue;
          const x = a.sv_get_pattern_x(SLOT, pat), y = a.sv_get_pattern_y(SLOT, pat);
          if (!best || x < best.x || (x === best.x && y < best.y)) best = { pat, x, y };
        }
        firstPat = best.pat;
      }

      // --- tempo via speed effects merged into line 0 of the first pattern ---
      // Effect codes per the SunVox manual: 0x1F = Set BPM to XXYY;
      // 0x0F = Set playing speed (YY: 1..0x1F = TPL). sv_set_pattern_event
      // writes only non-negative values, so nn/vv/mm = -1 merge the effect
      // into a cell WITHOUT clobbering an existing note. Cells whose ctl
      // column (3) is already taken are skipped.
      // Each value is placed only when the spec gives it: a missing bpm or tpl
      // keeps the engine default (125/6) instead of collapsing to 1.
      const bpm = spec.bpm == null ? 0 : Math.max(1, Math.min(999, int(spec.bpm, 0, "spec.bpm")));
      const tpl = spec.tpl == null ? 0 : Math.max(1, Math.min(31, int(spec.tpl, 0, "spec.tpl")));
      if (bpm || tpl) {
        const firstTracks = a.sv_get_pattern_tracks(SLOT, firstPat);
        const place = (ee, xxyy) => {
          for (let tr = 0; tr < firstTracks; tr++) {
            if (a.sv_get_pattern_event(SLOT, firstPat, tr, 0, 3) !== 0) continue; // ctl/effect column occupied
            const rc = a.sv_set_pattern_event(SLOT, firstPat, tr, 0, -1, -1, -1, ee, xxyy);
            if (rc < 0) throw new Error(`tempo effect 0x${ee.toString(16)} failed (rc=${rc})`);
            return;
          }
          throw new Error("no free effect column in line 0 of the pattern that plays first for the tempo effect: setting both bpm and tpl needs two free tracks there; give that pattern another track, or set only one of them");
        };
        if (bpm) place(0x1f, bpm);
        if (tpl) place(0x0f, tpl);
      }

      if (songName) check(a.sv_set_song_name(SLOT, songName), "sv_set_song_name");

      // --- save to temp, reload, verify ---
      const tmpDir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "sunvox-"));
      let project;
      try {
        const tmp = path.join(tmpDir, `${sanitizeName(name)}.sunvox`);
        check(a.sv_save(SLOT, tmp), "sv_save");
        a.sv_close_slot(SLOT);
        a.sv_open_slot(SLOT);
        check(a.sv_load(SLOT, tmp), "sv_load (reload of composed project)");
        project = fs.readFileSync(tmp);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
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

/** The project's song name: the compose name without control characters, at most 80 chars. */
function cleanSongName(n) {
  return String(n ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80);
}

/** A stable icon seed for a pattern (FNV-1a of name and index, 0..999999). */
function iconSeed(name, index) {
  let h = 0x811c9dc5;
  for (const ch of `${index}:${name}`) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h % 1000000;
}

/**
 * Validate spec.arrangement and lay it out. → null when the spec has none,
 * else [{ index, ref, x, y }] in placement order. Each entry names a pattern
 * by its id (or name, when it has no id); a missing x starts right after the
 * previous placement (first: line 0), a missing y is 0. With an arrangement,
 * every spec pattern must be placed at least once: SunVox has no pattern pool,
 * so an unplaced pattern would still play at its own x/y.
 */
export function planArrangement(spec) {
  const arr = spec.arrangement;
  if (arr === undefined || arr === null) return null;
  if (!Array.isArray(arr) || arr.length === 0) throw new Error("spec.arrangement must be a non-empty array of { pattern, x?, y? }");
  if (arr.length > LIMITS.maxArrangement) throw new Error(`spec.arrangement: at most ${LIMITS.maxArrangement} placements`);
  const keys = new Map(); // ref -> spec index
  spec.patterns.forEach((p, i) => {
    const key = p.id !== undefined && p.id !== null ? String(p.id) : p.name ? String(p.name) : null;
    if (key === null) throw new Error(`with an arrangement, every pattern needs an id (pattern ${i} has none)`);
    if (keys.has(key)) throw new Error(`with an arrangement, pattern ids must be unique ("${key}" repeats)`);
    keys.set(key, i);
  });
  const out = [];
  let nextX = 0;
  for (const [n, e] of arr.entries()) {
    if (!e || typeof e !== "object") throw new Error(`arrangement entry ${n} must be an object { pattern, x?, y? }`);
    const ref = e.pattern === undefined || e.pattern === null ? null : String(e.pattern);
    if (ref === null || !keys.has(ref)) throw new Error(`arrangement entry ${n} names unknown pattern ${JSON.stringify(e.pattern)}; patterns: ${[...keys.keys()].join(", ")}`);
    const index = keys.get(ref);
    const x = e.x === undefined || e.x === null ? nextX : e.x;
    const y = e.y === undefined || e.y === null ? 0 : e.y;
    if (!Number.isInteger(x) || x < 0 || x > LIMITS.maxTimelineX) throw new Error(`arrangement entry ${n}: x must be an integer from 0 to ${LIMITS.maxTimelineX}, got ${JSON.stringify(e.x)}`);
    if (!Number.isInteger(y) || Math.abs(y) > LIMITS.maxTimelineY) throw new Error(`arrangement entry ${n}: y must be an integer from -${LIMITS.maxTimelineY} to ${LIMITS.maxTimelineY}, got ${JSON.stringify(e.y)}`);
    const lines = spec.patterns[index].lines ?? 64;
    nextX = x + lines;
    out.push({ index, ref, x, y });
  }
  const unplaced = [...keys].filter(([, i]) => !out.some((pl) => pl.index === i)).map(([k]) => k);
  if (unplaced.length) throw new Error(`pattern(s) ${unplaced.join(", ")} are not in the arrangement; place them or remove them (every SunVox pattern sits on the timeline)`);
  return out;
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
        const mod = withLock(a, () => a.sv_new_module(SLOT, type, "probe", 512, 512, 0));
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
        withLock(a, () => a.sv_remove_module(SLOT, mod));
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
