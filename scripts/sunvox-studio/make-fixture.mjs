#!/usr/bin/env node
/**
 * Writes tests/fixtures/sunvox/crow-fixture.sunvox: a short song composed by
 * the bundle's own sunvox_compose engine from the fixed spec below. The test
 * fixture is ours (no third-party song in the repo), and the spec is fixed,
 * so the file is byte-for-byte reproducible: tests/sunvox-studio.test.js
 * recomposes FIXTURE_SPEC and checks it matches the committed file.
 *
 * Needs the bundle's deps: npm ci --prefix bundles/sunvox-studio --omit=optional --ignore-scripts
 * Run: node scripts/sunvox-studio/make-fixture.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const FIXTURE_PATH = path.join(ROOT, "tests", "fixtures", "sunvox", "crow-fixture.sunvox");
export const FIXTURE_NAME = "Crow fixture";

const kick = (line) => ({ track: 0, line, note: "C2", velocity: 110, module: "kick" });
const bass = (line, note) => ({ track: 1, line, note, velocity: 90, module: "bass" });

/** Intro (16 lines), then the groove twice: the second groove is a clone. 48 lines at BPM 100 / TPL 6. */
export const FIXTURE_SPEC = Object.freeze({
  bpm: 100,
  tpl: 6,
  modules: [
    { id: "kick", type: "DrumSynth", x: 300, y: 300 },
    { id: "bass", type: "Analog generator", params: { Waveform: 1, Volume: 140 }, x: 300, y: 500 },
    { id: "echo", type: "Echo", params: { Wet: 80 }, x: 500, y: 500 },
  ],
  connections: [["bass", "echo", "out"]],
  patterns: [
    { id: "intro", tracks: 2, lines: 16, events: [kick(0), kick(8), bass(0, "C3")] },
    { id: "groove", tracks: 2, lines: 16, events: [kick(0), kick(4), kick(8), kick(12), bass(0, "C3"), bass(6, "G3"), bass(10, "A#3")] },
  ],
  arrangement: [{ pattern: "intro" }, { pattern: "groove" }, { pattern: "groove" }],
});

export async function composeFixture() {
  const engine = await import(pathToFileURL(path.join(ROOT, "bundles", "sunvox-studio", "server", "sunvox-engine.js")).href);
  return engine.compose(structuredClone(FIXTURE_SPEC), { name: FIXTURE_NAME });
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const { project, info } = await composeFixture();
  fs.mkdirSync(path.dirname(FIXTURE_PATH), { recursive: true });
  fs.writeFileSync(FIXTURE_PATH, project);
  console.log(`wrote ${path.relative(ROOT, FIXTURE_PATH)} (${project.length} bytes): ${info.length_lines} lines, ${info.duration_s} s, ${info.patterns} patterns`);
  process.exit(0);
}
