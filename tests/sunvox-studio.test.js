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

// --- Review fixes (2026-10-19): these run everywhere, no native lib needed. ---

test("sunvox: the koffi native binary is a direct dependency and the lock is in sync", () => {
  // The Extensions page installs bundle deps with --omit=optional; koffi ships
  // its per-platform binary as an OPTIONAL dependency, so without a direct
  // dependency on the linux-x64 package the installed server cannot load.
  const pkg = JSON.parse(fs.readFileSync(path.join(BUNDLE, "package.json"), "utf8"));
  const lock = JSON.parse(fs.readFileSync(path.join(BUNDLE, "package-lock.json"), "utf8"));
  assert.ok(pkg.dependencies["@koromix/koffi-linux-x64"], "linux-x64 koffi binary declared directly");
  assert.equal(pkg.dependencies.koffi, pkg.dependencies["@koromix/koffi-linux-x64"], "koffi and its binary pinned to the same exact version");
  assert.match(pkg.dependencies.koffi, /^\d+\.\d+\.\d+$/, "koffi pinned exactly");
  assert.deepEqual(lock.packages[""].dependencies, pkg.dependencies, "package-lock.json root matches package.json (npm ci would refuse)");
  assert.equal(lock.packages[""].version, pkg.version);
});

test("sunvox: vendored .so matches the pin the engine enforces at load", async () => {
  const mod = await import(pathToFileURL(path.join(BUNDLE, "server", "sunvox-engine.js")).href);
  const got = (await import("node:crypto")).createHash("sha256").update(fs.readFileSync(SO)).digest("hex");
  assert.equal(got, mod.VENDORED_SO_SHA256);
  assert.ok(mod.LIMITS.maxRenderSeconds > 0 && mod.LIMITS.maxRenderSeconds <= 3600);
});

test("sunvox: every vendored copy carries the upstream binary terms and third-party licences", () => {
  for (const dir of [path.join(BUNDLE, "vendor"), path.join(ROOT, "bundles", "songbook", "web", "sunvox")]) {
    assert.match(fs.readFileSync(path.join(dir, "LICENSE.txt"), "utf8"), /MIT license/, dir);
    const notices = fs.readFileSync(path.join(dir, "THIRD-PARTY-NOTICES.txt"), "utf8");
    assert.match(notices, /Powered by SunVox \(modular synth & tracker\)/, `${dir}: attribution line (upstream REQUIREMENT 1)`);
    for (const part of ["sundog.txt", "libflac.txt", "tremor.txt"]) assert.ok(notices.includes(`==== ${part} ====`), `${dir}: ${part} (REQUIREMENT 2)`);
    assert.match(notices, /Xiph\.Org Foundation/i);
  }
});

test("sunvox: filesystem paths are confined to the work dir", async () => {
  const os = await import("node:os");
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "sv-work-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "sv-out-"));
  fs.writeFileSync(path.join(work, "a.sunvox"), "x");
  fs.writeFileSync(path.join(outside, "b.sunvox"), "x");
  fs.symlinkSync(path.join(outside, "b.sunvox"), path.join(work, "link.sunvox"));
  const prev = process.env.SUNVOX_WORKDIR;
  process.env.SUNVOX_WORKDIR = work;
  try {
    const srv = await import(pathToFileURL(path.join(BUNDLE, "server", "server.js")).href + "?confine");
    assert.equal(srv.resolveReadablePath("a.sunvox"), fs.realpathSync(path.join(work, "a.sunvox")));
    assert.throws(() => srv.resolveReadablePath(path.join(outside, "b.sunvox")), /outside the SunVox work dir/);
    assert.throws(() => srv.resolveReadablePath("../" + path.basename(outside) + "/b.sunvox"), /outside the SunVox work dir/);
    assert.throws(() => srv.resolveReadablePath("link.sunvox"), /outside the SunVox work dir/, "symlinks out are refused");
    assert.throws(() => srv.resolveReadablePath("/etc/hostname"), /outside the SunVox work dir|file not found/);
  } finally {
    if (prev === undefined) delete process.env.SUNVOX_WORKDIR; else process.env.SUNVOX_WORKDIR = prev;
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("sunvox: compose bounds and numeric params", { skip: !engine && SKIP_REASON }, async () => {
  const pat = { tracks: 1, lines: 4, events: [] };
  await assert.rejects(() => engine.compose({ modules: [{ id: "g", type: "Analog generator" }], patterns: [{ tracks: 1, lines: 100000, events: [] }] }), /lines: at most/);
  await assert.rejects(() => engine.compose({ modules: [{ id: "g", type: "Analog generator" }], patterns: [{ tracks: 99, lines: 4, events: [] }] }), /tracks: at most/);
  await assert.rejects(() => engine.compose({ modules: Array.from({ length: 500 }, (_, i) => ({ id: "m" + i, type: "Generator" })), patterns: [pat] }), /at most \d+ modules/);
  await assert.rejects(
    () => engine.compose({ modules: [{ id: "g", type: "Analog generator", params: { Waveform: "sawtooth" } }], patterns: [pat] }),
    /must be a number/,
  );
  // The engine stays usable after rejected specs.
  const ok = await engine.compose({ modules: [{ id: "g", type: "Analog generator" }], patterns: [pat] });
  assert.equal(ok.info.patterns, 1);
});

test("sunvox: bpm or tpl alone keeps the other at its default; bad coordinates never leave the slot locked", { skip: !engine && SKIP_REASON }, async () => {
  const mods = [{ id: "g", type: "Analog generator" }];
  const pat = { tracks: 1, lines: 8, events: [{ track: 0, line: 0, note: "C3", module: "g" }] };
  const onlyTpl = await engine.compose({ tpl: 4, modules: mods, patterns: [pat] });
  assert.equal(onlyTpl.info.effective_tempo.at_line_0.tpl, 4);
  assert.equal(onlyTpl.info.effective_tempo.at_line_0.bpm, 125, "bpm stays at the default, not 1");
  const onlyBpm = await engine.compose({ bpm: 90, modules: mods, patterns: [pat] });
  assert.equal(onlyBpm.info.effective_tempo.at_line_0.bpm, 90);
  assert.equal(onlyBpm.info.effective_tempo.at_line_0.tpl, 6, "tpl stays at the default, not 1");
  // A string coordinate is refused before any FFI call; the engine keeps working.
  await assert.rejects(() => engine.compose({ modules: [{ id: "g", type: "Analog generator", x: "left" }], patterns: [pat] }), /module x must be a number/);
  await assert.rejects(() => engine.compose({ modules: mods, patterns: [{ ...pat, x: "0" }] }), /pattern x must be a number/);
  const after = await engine.compose({ modules: mods, patterns: [pat] });
  assert.equal(after.info.patterns, 1, "engine usable after rejected specs (no stuck lock)");
});
