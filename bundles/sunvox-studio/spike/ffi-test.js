/**
 * SunVox FFI spike — proves sunvox_info + sunvox_render over the vendored
 * libsunvox.so using koffi, fully offline (no audio device).
 *
 * Fixture: spike/fixture.sunvox ("machine 0001" by NightRadio, from the
 * upstream js demo). Known-good reference values from warmplace.ru/jsplay:
 *   BPM 125, TPL 4, 1368864 frames, 260 lines, 26 module slots, 16 pattern slots.
 *
 * Run: node spike/ffi-test.js
 */
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const koffi = require("koffi");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SO = path.join(HERE, "..", "vendor", "sunvox.so");
const FIXTURE = path.join(HERE, "fixture.sunvox");
const OUT_WAV = path.join(HERE, "fixture-render.wav");

// --- flags (vendor/sunvox.h) ---
const SV_INIT_FLAG_NO_DEBUG_OUTPUT = 1 << 0;
const SV_INIT_FLAG_OFFLINE = 1 << 1;
const SV_INIT_FLAG_AUDIO_INT16 = 1 << 2;
const SV_INIT_FLAG_ONE_THREAD = 1 << 4;
const SV_MODULE_FLAG_EXISTS = 1 << 0;

const lib = koffi.load(SO);
const f = (proto) => lib.func(proto);

const sv_init = f("int sv_init(const char *config, int sample_rate, int channels, uint32 flags)");
const sv_deinit = f("int sv_deinit(void)");
const sv_open_slot = f("int sv_open_slot(int slot)");
const sv_close_slot = f("int sv_close_slot(int slot)");
const sv_load = f("int sv_load(int slot, const char *filename)");
const sv_get_song_name = f("const char *sv_get_song_name(int slot)");
const sv_get_song_bpm = f("int sv_get_song_bpm(int slot)");
const sv_get_song_tpl = f("int sv_get_song_tpl(int slot)");
const sv_get_song_length_frames = f("uint32 sv_get_song_length_frames(int slot)");
const sv_get_song_length_lines = f("uint32 sv_get_song_length_lines(int slot)");
const sv_get_number_of_modules = f("int sv_get_number_of_modules(int slot)");
const sv_get_number_of_patterns = f("int sv_get_number_of_patterns(int slot)");
const sv_get_module_flags = f("uint32 sv_get_module_flags(int slot, int mod)");
const sv_get_module_type = f("const char *sv_get_module_type(int slot, int mod)");
const sv_get_module_name = f("const char *sv_get_module_name(int slot, int mod)");
const sv_get_pattern_name = f("const char *sv_get_pattern_name(int slot, int pat)");
const sv_get_pattern_tracks = f("int sv_get_pattern_tracks(int slot, int pat)");
const sv_get_pattern_lines = f("int sv_get_pattern_lines(int slot, int pat)");
const sv_set_autostop = f("int sv_set_autostop(int slot, int autostop)");
const sv_play_from_beginning = f("int sv_play_from_beginning(int slot)");
const sv_end_of_song = f("int sv_end_of_song(int slot)");
const sv_audio_callback = f("int sv_audio_callback(void *buf, int frames, int latency, uint32 out_time)");
const sv_get_ticks = f("uint32 sv_get_ticks(void)");
const sv_get_sample_rate = f("int sv_get_sample_rate(void)");
const sv_stop = f("int sv_stop(int slot)");
const sv_get_log = f("const char *sv_get_log(int size)");

const SAMPLE_RATE = 44100;
const CHANNELS = 2;
const SLOT = 0;
const CHUNK_FRAMES = 4096;

function writeWav(file, pcmChunks, totalFrames) {
  const dataSize = totalFrames * CHANNELS * 2;
  const hdr = Buffer.alloc(44);
  hdr.write("RIFF", 0);
  hdr.writeUInt32LE(36 + dataSize, 4);
  hdr.write("WAVE", 8);
  hdr.write("fmt ", 12);
  hdr.writeUInt32LE(16, 16);
  hdr.writeUInt16LE(1, 20); // PCM
  hdr.writeUInt16LE(CHANNELS, 22);
  hdr.writeUInt32LE(SAMPLE_RATE, 24);
  hdr.writeUInt32LE(SAMPLE_RATE * CHANNELS * 2, 28);
  hdr.writeUInt16LE(CHANNELS * 2, 32);
  hdr.writeUInt16LE(16, 34);
  hdr.write("data", 36);
  hdr.writeUInt32LE(dataSize, 40);
  fs.writeFileSync(file, Buffer.concat([hdr, ...pcmChunks]));
}

function check(rc, what) {
  if (rc < 0) throw new Error(`${what} failed: ${rc}`);
  return rc;
}

// --- init ---
const ver = sv_init(null, SAMPLE_RATE, CHANNELS,
  SV_INIT_FLAG_NO_DEBUG_OUTPUT | SV_INIT_FLAG_OFFLINE | SV_INIT_FLAG_AUDIO_INT16 | SV_INIT_FLAG_ONE_THREAD);
if (ver < 0) { console.error("sv_init failed:", ver); process.exit(1); }
console.log(`engine version: 0x${ver.toString(16)} (major=${ver >> 16}, minor=${(ver >> 8) & 0xff}, patch=${ver & 0xff})`);
console.log(`actual sample rate: ${sv_get_sample_rate()}`);

check(sv_open_slot(SLOT), "sv_open_slot");
check(sv_load(SLOT, FIXTURE), "sv_load");

// --- sunvox_info equivalent ---
const modSlots = sv_get_number_of_modules(SLOT);
const patSlots = sv_get_number_of_patterns(SLOT);
const modules = [];
for (let i = 0; i < modSlots; i++) {
  if (!(sv_get_module_flags(SLOT, i) & SV_MODULE_FLAG_EXISTS)) continue;
  modules.push({ num: i, type: sv_get_module_type(SLOT, i), name: sv_get_module_name(SLOT, i) });
}
const patterns = [];
for (let i = 0; i < patSlots; i++) {
  const lines = sv_get_pattern_lines(SLOT, i);
  if (!(lines > 0)) continue;
  patterns.push({ num: i, name: sv_get_pattern_name(SLOT, i), tracks: sv_get_pattern_tracks(SLOT, i), lines });
}
const info = {
  name: sv_get_song_name(SLOT),
  bpm: sv_get_song_bpm(SLOT),
  tpl: sv_get_song_tpl(SLOT),
  length_frames: sv_get_song_length_frames(SLOT),
  length_lines: sv_get_song_length_lines(SLOT),
  module_slots: modSlots, modules: modules.length,
  pattern_slots: patSlots, patterns: patterns.length,
};
console.log("\n--- sunvox_info ---");
console.log(JSON.stringify(info, null, 2));
console.log("module types:", [...new Set(modules.map((m) => m.type))].join(", "));
console.log("pattern names:", patterns.map((p) => p.name || `(pat ${p.num})`).slice(0, 8).join(", "), "…");

// --- sunvox_render equivalent ---
console.log("\n--- sunvox_render ---");
sv_set_autostop(SLOT, 1);
sv_play_from_beginning(SLOT);
const buf = Buffer.alloc(CHUNK_FRAMES * CHANNELS * 2);
const chunks = [];
let totalFrames = 0;
let silentRuns = 0;
const t0 = Date.now();
while (true) {
  const filled = sv_audio_callback(buf, CHUNK_FRAMES, 0, sv_get_ticks());
  const isSilent = !filled || buf.every((b) => b === 0);
  if (sv_end_of_song(SLOT)) {
    // render a tail until 8 consecutive silent chunks (reverb/delay decay) or 2s
    if (isSilent) silentRuns++;
    if (silentRuns >= 8 || totalFrames > info.length_frames + SAMPLE_RATE * 2) break;
  }
  chunks.push(Buffer.from(buf));
  totalFrames += CHUNK_FRAMES;
}
sv_stop(SLOT);
const ms = Date.now() - t0;
writeWav(OUT_WAV, chunks, totalFrames);
console.log(`rendered ${totalFrames} frames (${(totalFrames / SAMPLE_RATE).toFixed(2)}s) in ${ms}ms — ${(totalFrames / SAMPLE_RATE / (ms / 1000)).toFixed(1)}x realtime`);
console.log(`song length was ${info.length_frames} frames (${(info.length_frames / SAMPLE_RATE).toFixed(2)}s)`);
console.log(`wav: ${OUT_WAV} (${fs.statSync(OUT_WAV).size} bytes)`);

sv_close_slot(SLOT);
sv_deinit();

// --- pass/fail against known-good reference ---
const expect = { bpm: 125, tpl: 4, length_frames: 1368864, length_lines: 260 };
const fails = [];
for (const [k, v] of Object.entries(expect)) if (info[k] !== v) fails.push(`${k}: got ${info[k]}, want ${v}`);
if (Math.abs(totalFrames - info.length_frames) > SAMPLE_RATE * 3) fails.push(`render length ${totalFrames} too far from ${info.length_frames}`); // tail: reverb/delay decay + silent-run detection
if (fails.length) { console.error("\nSPIKE FAIL:", fails.join("; ")); process.exit(1); }
console.log("\nSPIKE PASS: info matches upstream reference; offline render complete.");
