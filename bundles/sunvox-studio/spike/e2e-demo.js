/**
 * E2E demo track — composed entirely via the sunvox-studio engine.
 * Two-bar drums + bass + echo lead, 85 BPM, rendered to MP3.
 */
import * as engine from "../server/sunvox-engine.js";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const drums = (track, lines, pat) => {
  const ev = [];
  for (let l = 0; l < lines; l += 4) ev.push({ track, line: l, note: "C2", velocity: 120, module: "kick" }); // four-on-floor
  for (let l = 4; l < lines; l += 8) ev.push({ track, line: l, note: "G2", velocity: 90, module: "snare" }); // backbeat
  for (let l = 2; l < lines; l += 4) ev.push({ track, line: l, note: "A2", velocity: 55, module: "hat" }); // offbeat hats
  return ev;
};

// A minor-ish loop: C - G - Am - F, one chord per half-bar of bass
const bassA = [["C2", 0], ["C3", 4], ["G2", 8], ["G3", 12], ["A2", 16], ["A3", 20], ["F2", 24], ["F3", 28]]
  .map(([n, l]) => ({ track: 1, line: l, note: n, velocity: 95, module: "bass" }));
const leadA = [["E4", 0], ["G4", 3], ["C5", 6], ["B4", 10], ["D5", 14], ["E4", 18], ["A4", 22], ["C5", 26], ["A4", 30]]
  .map(([n, l]) => ({ track: 2, line: l, note: n, velocity: 85, module: "lead" }));
const leadB = [["G4", 0], ["C5", 3], ["E5", 6], ["D5", 10], ["B4", 14], ["A4", 18], ["G4", 22], ["E4", 26], ["G4", 29]]
  .map(([n, l]) => ({ track: 2, line: l, note: n, velocity: 80, module: "lead" }));

const spec = {
  bpm: 85, tpl: 8,
  modules: [
    { id: "kick", type: "DrumSynth", params: { "Bass tone": 60, "Bass length": 60 } },
    { id: "snare", type: "DrumSynth", params: { "Snare tone": 80 } },
    { id: "hat", type: "DrumSynth", params: { "Hihat length": 20 } },
    { id: "bass", type: "Analog generator", params: { Waveform: 3, Volume: 150, Attack: 2, Release: 30 } },
    { id: "bassfilter", type: "Filter", params: { Freq: 90, Resonance: 60 } },
    { id: "lead", type: "Analog generator", params: { Waveform: 1, Volume: 130, Attack: 8, Release: 60 } },
    { id: "echo", type: "Echo", params: { Wet: 110, Feedback: 100, Delay: 6 } },
  ],
  connections: [
    ["bass", "bassfilter", "out"],
    ["lead", "echo", "out"],
  ],
  patterns: [
    { name: "A", tracks: 3, lines: 32, x: 0, y: 0, events: [...drums(0, 32), ...bassA, ...leadA] },
    { name: "B", tracks: 3, lines: 32, x: 32, y: 0, events: [...drums(0, 32), ...bassA, ...leadB] },
  ],
};

const { project, info } = await engine.compose(spec, { name: "crow-lofi-demo" });
const projPath = path.join(HERE, "crow-lofi-demo.sunvox");
fs.writeFileSync(projPath, project);
console.log(`composed: ${projPath} (${project.length}B)`);
console.log(`info: ${info.length_lines} lines, ${info.duration_s}s, effective tempo ${JSON.stringify(info.effective_tempo?.at_line_0)}, modules ${info.modules}, patterns ${info.patterns}`);

const { wav } = await engine.render(project);
const wavPath = "/tmp/crow-lofi-demo.wav";
const mp3Path = "/tmp/crow-lofi-demo.mp3";
fs.writeFileSync(wavPath, wav);
const ff = spawnSync("ffmpeg", ["-y", "-i", wavPath, "-codec:a", "libmp3lame", "-qscale:a", "4", mp3Path], { encoding: "utf8" });
if (ff.status !== 0) throw new Error("ffmpeg failed: " + String(ff.stderr).slice(-300));
console.log(`rendered: ${mp3Path} (${fs.statSync(mp3Path).size}B, ${(wav.length / 4 / 44100).toFixed(1)}s)`);

engine.shutdown();
