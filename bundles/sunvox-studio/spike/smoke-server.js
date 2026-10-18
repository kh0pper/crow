/**
 * Smoke test for the real server modules (engine + tool layer).
 * Verifies: info matches upstream reference for the fixture; compose
 * round-trips including the BPM/TPL effect 0x09 (unverified until now);
 * render produces audible audio; module catalogue generates.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as engine from "../server/sunvox-engine.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "fixture.sunvox");

// 1. info on fixture — known-good upstream values
const info = await engine.info(fs.readFileSync(FIXTURE));
assert.equal(info.bpm, 125);
assert.equal(info.tpl, 4);
assert.equal(info.length_frames, 1368864);
assert.equal(info.length_lines, 260);
assert.ok(info.modules >= 26);
console.log(`info OK: "${info.name}" bpm=${info.bpm} tpl=${info.tpl} ${info.duration_s}s modules=${info.modules} patterns=${info.patterns}`);

// 2. compose — with explicit bpm/tpl to prove effect 0x09 works
const spec = {
  bpm: 90, tpl: 8,
  modules: [
    { id: "kick", type: "DrumSynth" },
    { id: "bass", type: "Analog generator", params: { Waveform: 3, Volume: 160 } },
    { id: "echo", type: "Echo", params: { Wet: 96 } },
  ],
  connections: [["bass", "echo", "out"]],
  patterns: [
    {
      name: "main", tracks: 2, lines: 32, x: 0, y: 0,
      events: [
        { track: 0, line: 0, note: "C2", velocity: 110, module: "kick" },
        { track: 0, line: 8, note: "C2", velocity: 110, module: "kick" },
        { track: 0, line: 16, note: "C2", velocity: 110, module: "kick" },
        { track: 0, line: 24, note: "C2", velocity: 110, module: "kick" },
        { track: 1, line: 0, note: "C3", velocity: 90, module: "bass" },
        { track: 1, line: 6, note: "G3", velocity: 90, module: "bass" },
        { track: 1, line: 12, note: "A#2", velocity: 90, module: "bass" },
      ],
    },
  ],
};
const composed = await engine.compose(spec, { name: "smoke-test" });
console.log(`compose OK: ${composed.project.length} bytes; after reload: header bpm=${composed.info.bpm}/${composed.info.tpl}, effective=${JSON.stringify(composed.info.effective_tempo)}, modules=${composed.info.modules} patterns=${composed.info.patterns}`);
assert.equal(composed.info.effective_tempo?.bpm, 90, "BPM effect 0x1F did not apply (time map)");
assert.equal(composed.info.effective_tempo?.tpl, 8, "TPL effect 0x0F did not apply (time map)");
assert.equal(composed.info.modules, 4); // kick + bass + echo + auto Output
assert.equal(composed.info.patterns, 1); // default empty pattern removed

// 3. render the composed project — must be audible and match the engine's own length
const rendered = await engine.render(composed.project);
let peak = 0;
for (let i = 44; i < rendered.wav.length - 1; i += 2) {
  const a = Math.abs(rendered.wav.readInt16LE(i));
  if (a > peak) peak = a;
}
const songS = composed.info.length_frames / 44100;
const gotS = rendered.frames / 44100;
console.log(`render OK: ${gotS.toFixed(2)}s audio (engine song length ${songS.toFixed(2)}s), peak=${peak}`);
assert.ok(peak > 1000, "composed render is silent");
assert.ok(gotS >= songS && gotS <= songS + 3, "render duration outside song length + tail window");
// sanity: 32 lines at bpm 90 should be a few seconds, not minutes
assert.ok(songS > 1 && songS < 30, `song length ${songS}s implausible for 32 lines`);

// 4. module catalogue
const cat = await engine.moduleCatalogue();
const types = Object.keys(cat.modules);
assert.ok(types.includes("DrumSynth") && types.includes("Analog generator") && types.includes("Echo"));
assert.ok(!types.includes("Output"), "Output must not be creatable/listed as compose type");
console.log(`catalogue OK: ${types.length} module types`);

// 5. error paths enumerate valid options
await assert.rejects(
  () => engine.compose({ modules: [{ id: "x", type: "NoSuchModule" }], patterns: [{ tracks: 1, lines: 4, events: [] }] }),
  /sv_new_module failed.*NoSuchModule/,
);
await assert.rejects(
  () => engine.compose({
    modules: [{ id: "g", type: "Analog generator", params: { Bogus: 1 } }],
    patterns: [{ tracks: 1, lines: 4, events: [] }],
  }),
  /no controller "Bogus".*Valid:/,
);
console.log("error paths OK: unknown type + unknown param produce actionable errors");

engine.shutdown();
console.log("\nSMOKE PASS: engine layer ready for MCP wiring.");
