/**
 * sunvox-studio bundle — engine-level tests over the vendored libsunvox.so.
 *
 * Skips cleanly when the native pieces are unavailable (no koffi installed
 * in the bundle dir, non-linux/x86_64 host, or vendor/sunvox.so missing),
 * so CI and non-primary machines stay green.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = path.join(ROOT, "bundles", "sunvox-studio");
const SO = path.join(BUNDLE, "vendor", "sunvox.so");
const FIXTURE = path.join(BUNDLE, "spike", "fixture.sunvox");

const require = createRequire(import.meta.url);
function nativeAvailable() {
  if (process.platform !== "linux" || process.arch !== "x64") return false;
  if (!fs.existsSync(SO) || !fs.existsSync(FIXTURE)) return false;
  try { require(path.join(BUNDLE, "node_modules", "koffi")); return true; } catch { return false; }
}

const SKIP_REASON = "sunvox native lib unavailable (need linux/x64 + bundle npm install + vendor/sunvox.so)";
const engine = nativeAvailable()
  ? await import(pathToFileURL(path.join(BUNDLE, "server", "sunvox-engine.js")).href)
  : null;

test("sunvox: engine reports info matching upstream reference for fixture", { skip: !engine && SKIP_REASON }, async () => {
  const info = await engine.info(fs.readFileSync(FIXTURE));
  // Reference values published on warmplace.ru/soft/sunvox/jsplay for this file.
  assert.equal(info.bpm, 125);
  assert.equal(info.tpl, 4);
  assert.equal(info.length_frames, 1368864);
  assert.equal(info.length_lines, 260);
  assert.ok(info.modules >= 26);
  assert.ok(info.module_list.some((m) => m.type === "DrumSynth"));
});

test("sunvox: compose round-trips with tempo, modules, patterns; render is audible", { skip: !engine && SKIP_REASON }, async () => {
  const spec = {
    bpm: 90, tpl: 8,
    modules: [
      { id: "kick", type: "DrumSynth" },
      { id: "bass", type: "Analog generator", params: { Waveform: 3, Volume: 160 } },
      { id: "echo", type: "Echo", params: { Wet: 96 } },
    ],
    connections: [["bass", "echo", "out"]],
    patterns: [{
      name: "main", tracks: 2, lines: 32, x: 0, y: 0,
      events: [
        { track: 0, line: 0, note: "C2", velocity: 110, module: "kick" },
        { track: 0, line: 8, note: "C2", velocity: 110, module: "kick" },
        { track: 1, line: 0, note: "C3", velocity: 90, module: "bass" },
        { track: 1, line: 6, note: "G3", velocity: 90, module: "bass" },
      ],
    }],
  };
  const composed = await engine.compose(spec, { name: "repo-test" });
  assert.equal(composed.info.modules, 4); // 3 created + auto Output at 0
  assert.equal(composed.info.patterns, 1); // fresh-slot default pattern removed
  assert.equal(composed.info.effective_tempo.at_line_0.bpm, 90); // effect 0x1F
  assert.equal(composed.info.effective_tempo.at_line_0.tpl, 8); // effect 0x0F
  assert.ok(composed.project.length > 500);

  const rendered = await engine.render(composed.project);
  let peak = 0;
  for (let i = 44; i < rendered.wav.length - 1; i += 2) {
    const a = Math.abs(rendered.wav.readInt16LE(i));
    if (a > peak) peak = a;
  }
  assert.ok(peak > 1000, "rendered compose is silent");
  const songS = composed.info.length_frames / 44100;
  const gotS = rendered.frames / 44100;
  assert.ok(gotS >= songS && gotS <= songS + 3, "render length outside song + tail");
});

test("sunvox: compose errors are actionable", { skip: !engine && SKIP_REASON }, async () => {
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
  await assert.rejects(
    () => engine.compose({
      modules: [{ id: "out", type: "DrumSynth" }],
      patterns: [{ tracks: 1, lines: 4, events: [] }],
    }),
    /reserved/,
  );
});

test("sunvox: note parsing", { skip: !engine && SKIP_REASON }, () => {
  assert.equal(engine.parseNote("C0"), 1);
  assert.equal(engine.parseNote("C3"), 37);
  assert.equal(engine.parseNote("F#4"), 55);
  assert.equal(engine.parseNote("Bb2"), 35);
  assert.equal(engine.parseNote(60), 60);
  assert.throws(() => engine.parseNote("H3"), /cannot parse note/);
  assert.throws(() => engine.parseNote(200), /out of range/);
});

test("sunvox: module catalogue covers core types and excludes Output", { skip: !engine && SKIP_REASON }, async () => {
  const cat = await engine.moduleCatalogue();
  const types = Object.keys(cat.modules);
  for (const t of ["Analog generator", "DrumSynth", "Sampler", "Echo", "Reverb", "Filter", "LFO", "MultiSynth"]) {
    assert.ok(types.includes(t), `missing ${t}`);
  }
  assert.ok(!types.includes("Output"));
  assert.ok(cat.modules["Analog generator"].controllers.some((c) => c.name === "Waveform"));
});
