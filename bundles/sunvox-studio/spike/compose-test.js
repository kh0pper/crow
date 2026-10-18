/**
 * Spike 3 — programmatic composition round-trip (proves sunvox_compose).
 * Builds a tiny project from scratch via the API:
 *   DrumSynth (kick on quarters) + Analog generator (bass line) -> Output
 * Saves it as .sunvox (sv_save), reloads it, renders to WAV offline.
 *
 * Run: node spike/compose-test.js
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
const sv_lock_slot = f("int sv_lock_slot(int s)");
const sv_unlock_slot = f("int sv_unlock_slot(int s)");
const sv_new_module = f("int sv_new_module(int s, const char *type, const char *name, int x, int y, int z)");
const sv_connect_module = f("int sv_connect_module(int s, int src, int dst)");
const sv_get_number_of_modules = f("int sv_get_number_of_modules(int s)");
const sv_get_module_flags = f("uint32 sv_get_module_flags(int s, int mod)");
const sv_get_module_type = f("const char *sv_get_module_type(int s, int mod)");
const sv_get_module_name = f("const char *sv_get_module_name(int s, int mod)");
const sv_get_number_of_module_ctls = f("int sv_get_number_of_module_ctls(int s, int mod)");
const sv_get_module_ctl_name = f("const char *sv_get_module_ctl_name(int s, int mod, int ctl)");
const sv_set_module_ctl_value = f("int sv_set_module_ctl_value(int s, int mod, int ctl, int val, int scaled)");
const sv_new_pattern = f("int sv_new_pattern(int s, int clone, int x, int y, int tracks, int lines, int icon_seed, const char *name)");
const sv_set_pattern_event = f("int sv_set_pattern_event(int s, int pat, int track, int line, int nn, int vv, int mm, int ccee, int xxyy)");
const sv_save = f("int sv_save(int s, const char *filename)");
const sv_load = f("int sv_load(int s, const char *filename)");
const sv_get_song_bpm = f("int sv_get_song_bpm(int s)");
const sv_get_song_tpl = f("int sv_get_song_tpl(int s)");
const sv_get_song_length_frames = f("uint32 sv_get_song_length_frames(int s)");
const sv_set_autostop = f("int sv_set_autostop(int s, int a)");
const sv_play_from_beginning = f("int sv_play_from_beginning(int s)");
const sv_end_of_song = f("int sv_end_of_song(int s)");
const sv_audio_callback = f("int sv_audio_callback(void *buf, int frames, int latency, uint32 out_time)");
const sv_get_ticks = f("uint32 sv_get_ticks(void)");
const sv_stop = f("int sv_stop(int s)");

const RATE = 44100, CH = 2, SLOT = 0, CHUNK = 4096;
const FLAGS = (1 << 0) | (1 << 1) | (1 << 2) | (1 << 4);
const EXIST = 1 << 0;
const note = (oct, semi) => oct * 12 + semi + 1; // SunVox note number

const OUT_PROJECT = path.join(HERE, "composed.sunvox");
const OUT_WAV = path.join(HERE, "composed.wav");

if (sv_init(null, RATE, CH, FLAGS) < 0) { console.error("init failed"); process.exit(1); }
sv_open_slot(SLOT);

// --- what does a fresh slot contain? ---
const n0 = sv_get_number_of_modules(SLOT);
console.log(`fresh slot: ${n0} module slots`);
for (let i = 0; i < n0; i++) {
  if (sv_get_module_flags(SLOT, i) & EXIST) console.log(`  pre-existing module ${i}: ${sv_get_module_type(SLOT, i)} "${sv_get_module_name(SLOT, i)}"`);
}

// --- find or create Output ---
let out = -1;
for (let i = 0; i < sv_get_number_of_modules(SLOT); i++) {
  if ((sv_get_module_flags(SLOT, i) & EXIST) && sv_get_module_type(SLOT, i) === "Output") { out = i; break; }
}
if (out < 0) {
  sv_lock_slot(SLOT); out = sv_new_module(SLOT, "Output", "Output", 512, 800, 0); sv_unlock_slot(SLOT);
  console.log("created Output module:", out);
} else console.log("Output already present at module", out);

// --- instruments ---
function create(type, name, x, y) {
  sv_lock_slot(SLOT);
  const m = sv_new_module(SLOT, type, name, x, y, 0);
  if (m >= 0) sv_connect_module(SLOT, m, out);
  sv_unlock_slot(SLOT);
  if (m < 0) throw new Error(`sv_new_module(${type}) failed: ${m}`);
  return m;
}
const drums = create("DrumSynth", "Kick", 300, 400);
const bass = create("Analog generator", "Bass", 700, 400);

// set Analog generator waveform to sawtooth-ish bass: find "Waveform" ctl (selector)
function setCtlByName(mod, name, val) {
  const n = sv_get_number_of_module_ctls(SLOT, mod);
  for (let c = 0; c < n; c++) {
    if (sv_get_module_ctl_name(SLOT, mod, c) === name) return sv_set_module_ctl_value(SLOT, mod, c, val, 0);
  }
  return null;
}
console.log("bass Waveform ctl set rc:", setCtlByName(bass, "Waveform", 3)); // 3 ~ sawtooth (selector index)
console.log("bass Volume ctl set rc:", setCtlByName(bass, "Volume", 160));

// --- pattern: 1 track drums (four-on-floor), 1 track bass line, 32 lines ---
sv_lock_slot(SLOT);
const pat = sv_new_pattern(SLOT, -1, 0, 0, 2, 32, 42, "main");
sv_unlock_slot(SLOT);
if (pat < 0) { console.error("sv_new_pattern failed", pat); process.exit(1); }
console.log("pattern:", pat);

// DrumSynth: note number selects the preset; C1-ish = kick on most banks
for (let line = 0; line < 32; line += 4) {
  const rc = sv_set_pattern_event(SLOT, pat, 0, line, note(1, 0), 100, drums + 1, 0, 0);
  if (rc < 0) console.error("drum event rc", rc);
}
// bass line: C2 G2 Bb2 F2 (one per bar of 8 lines... simple alternating eighths)
const bassLine = [
  [0, note(2, 0)], [3, note(2, 0)], [6, note(2, 7)], [10, note(2, 10)],
  [16, note(2, 5)], [19, note(2, 5)], [22, note(2, 3)], [26, note(2, 7)],
];
for (const [line, nn] of bassLine) {
  const rc = sv_set_pattern_event(SLOT, pat, 1, line, nn, 90, bass + 1, 0, 0);
  if (rc < 0) console.error("bass event rc", rc);
}

// --- save + reload round-trip ---
if (sv_save(SLOT, OUT_PROJECT) < 0) { console.error("sv_save failed"); process.exit(1); }
console.log(`saved ${OUT_PROJECT} (${fs.statSync(OUT_PROJECT).size} bytes)`);
sv_close_slot(SLOT);
sv_open_slot(SLOT);
if (sv_load(SLOT, OUT_PROJECT) < 0) { console.error("sv_load failed"); process.exit(1); }
console.log(`reloaded: BPM ${sv_get_song_bpm(SLOT)}, TPL ${sv_get_song_tpl(SLOT)}, length ${sv_get_song_length_frames(SLOT)} frames (${(sv_get_song_length_frames(SLOT) / RATE).toFixed(2)}s)`);
const nm = sv_get_number_of_modules(SLOT);
const mods = [];
for (let i = 0; i < nm; i++) if (sv_get_module_flags(SLOT, i) & EXIST) mods.push(`${i}:${sv_get_module_type(SLOT, i)}`);
console.log("modules after reload:", mods.join(", "));

// --- render ---
sv_set_autostop(SLOT, 1);
sv_play_from_beginning(SLOT);
const buf = Buffer.alloc(CHUNK * CH * 2);
const chunks = []; let frames = 0, silent = 0;
while (true) {
  const filled = sv_audio_callback(buf, CHUNK, 0, sv_get_ticks());
  const isSilent = !filled || buf.every((b) => b === 0);
  if (sv_end_of_song(SLOT)) { if (isSilent) silent++; if (silent >= 4 || frames > sv_get_song_length_frames(SLOT) + RATE) break; }
  chunks.push(Buffer.from(buf)); frames += CHUNK;
}
sv_stop(SLOT);
const dataSize = frames * CH * 2;
const hdr = Buffer.alloc(44);
hdr.write("RIFF", 0); hdr.writeUInt32LE(36 + dataSize, 4); hdr.write("WAVE", 8);
hdr.write("fmt ", 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20);
hdr.writeUInt16LE(CH, 22); hdr.writeUInt32LE(RATE, 24); hdr.writeUInt32LE(RATE * CH * 2, 28);
hdr.writeUInt16LE(CH * 2, 32); hdr.writeUInt16LE(16, 34); hdr.write("data", 36); hdr.writeUInt32LE(dataSize, 40);
fs.writeFileSync(OUT_WAV, Buffer.concat([hdr, ...chunks]));

let peak = 0;
const wav = fs.readFileSync(OUT_WAV);
for (let i = 44; i < wav.length - 1; i += 2) { const a = Math.abs(wav.readInt16LE(i)); if (a > peak) peak = a; }
console.log(`rendered ${frames} frames (${(frames / RATE).toFixed(2)}s) peak=${peak} -> ${OUT_WAV}`);

sv_close_slot(SLOT); sv_deinit();
if (peak < 1000) { console.error("SPIKE FAIL: composed render is (near) silent"); process.exit(1); }
console.log("SPIKE PASS: compose -> save -> reload -> render produced audible audio.");
