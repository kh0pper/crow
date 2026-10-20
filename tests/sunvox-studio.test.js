/**
 * sunvox-studio bundle — engine-level tests over the vendored libsunvox.so.
 *
 * The engine cases need koffi in the bundle's own node_modules (CI installs
 * it: npm ci --prefix bundles/sunvox-studio --omit=optional --ignore-scripts)
 * on linux/x86_64. Elsewhere they skip, unless CROW_REQUIRE_SUNVOX_ENGINE=1
 * (set in CI), which turns a missing engine into a failure.
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
const FIXTURE = path.join(ROOT, "tests", "fixtures", "sunvox", "crow-fixture.sunvox");

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
const hasFfmpeg = (() => { try { return (require("node:child_process").spawnSync("ffmpeg", ["-version"]).status === 0); } catch { return false; } })();
// With CROW_REQUIRE_SUNVOX_ENGINE=1 (CI) the mp3/ogg cases run whether or not ffmpeg is there, so a missing ffmpeg fails them.
const NO_FFMPEG = !hasFfmpeg && process.env.CROW_REQUIRE_SUNVOX_ENGINE !== "1" && "ffmpeg not installed";

test("sunvox: the engine loads when CI requires it", { skip: process.env.CROW_REQUIRE_SUNVOX_ENGINE !== "1" && "CROW_REQUIRE_SUNVOX_ENGINE not set" }, () => {
  assert.ok(engine, SKIP_REASON);
});

test("sunvox: the fixture is our own composition, reproducible from its spec", { skip: !engine && SKIP_REASON }, async () => {
  const { composeFixture, FIXTURE_NAME, FIXTURE_SPEC } = await import(pathToFileURL(path.join(ROOT, "scripts", "sunvox-studio", "make-fixture.mjs")).href);
  const { project } = await composeFixture();
  const sha = (b) => require("node:crypto").createHash("sha256").update(b).digest("hex");
  assert.equal(sha(project), sha(fs.readFileSync(FIXTURE)), "recomposing FIXTURE_SPEC gives the committed bytes (run node scripts/sunvox-studio/make-fixture.mjs after an intended change)");
  const info = await engine.info(fs.readFileSync(FIXTURE));
  assert.equal(info.name, FIXTURE_NAME);
  assert.equal(info.format, "sunvox");
  assert.equal(info.version, "2.1.4.3");
  assert.equal(info.engine_version, "2.1.4");
  // Expected values come from the spec and the tracker timing rule, not from
  // reading the file back: lines = the arrangement laid end to end; a line
  // lasts TPL x 2.5 / BPM seconds.
  const spec = FIXTURE_SPEC;
  const linesOf = (id) => spec.patterns.find((p) => p.id === id).lines;
  const songLines = spec.arrangement.reduce((n, a) => n + linesOf(a.pattern), 0);
  assert.deepEqual(info.effective_tempo.at_line_0, { bpm: spec.bpm, tpl: spec.tpl });
  assert.equal(info.length_lines, songLines);
  assert.equal(info.length_frames, Math.round(songLines * spec.tpl * 2.5 / spec.bpm * 44100));
  assert.equal(info.modules, spec.modules.length + 1, "the spec's modules plus Output");
  assert.deepEqual(info.module_list.map((m) => [m.type, m.name, m.x, m.y]), [
    ["Output", "Output", 512, 512], ["DrumSynth", "kick", 300, 300], ["Analog generator", "bass", 300, 500], ["Echo", "echo", 500, 500],
  ]);
  for (const m of info.module_list) assert.match(m.color, /^#[0-9a-f]{6}$/);
  let x = 0;
  assert.deepEqual(info.pattern_list.map((p) => [p.name, p.x, p.y, p.lines]), spec.arrangement.map((a) => { const at = x; x += linesOf(a.pattern); return [a.pattern, at, 0, linesOf(a.pattern)]; }));
  // And it sounds: the render is at least the song long and not silent.
  const r = await engine.render(fs.readFileSync(FIXTURE));
  assert.ok(r.frames >= info.length_frames);
  let peak = 0;
  for (let i = 44; i < r.wav.length - 1; i += 2) peak = Math.max(peak, Math.abs(r.wav.readInt16LE(i)));
  assert.ok(peak > 1000, "fixture render is silent");
});

test("sunvox: the old upstream demo song is gone from the repo and the bundle ships no spike/", () => {
  assert.ok(!fs.existsSync(path.join(BUNDLE, "spike")), "bundles/sunvox-studio/spike must not exist (it shipped in installed copies)");
  const upstreamDemo = "machine 0001"; // the library author's demo song, formerly spike/fixture.sunvox
  assert.ok(!fs.readFileSync(FIXTURE).includes(Buffer.from(upstreamDemo)));
});

test("sunvox: format detection and version strings (no engine needed)", async () => {
  const mod = await import(pathToFileURL(path.join(BUNDLE, "server", "sunvox-engine.js")).href);
  assert.equal(mod.detectFormat(Buffer.from("SVOX\0\0\0\0")), "sunvox");
  assert.equal(mod.detectFormat(Buffer.from("Extended Module: song name here")), "xm");
  const m = Buffer.alloc(1200); m.write("M.K.", 1080, "latin1");
  assert.equal(mod.detectFormat(m), "mod");
  const m8 = Buffer.alloc(1200); m8.write("8CHN", 1080, "latin1");
  assert.equal(mod.detectFormat(m8), "mod");
  assert.equal(mod.detectFormat(Buffer.alloc(1200)), "unknown");
  assert.equal(mod.detectFormat(Buffer.from("RIFF")), "unknown");
  assert.equal(mod.versionString(0x02010403), "2.1.4.3");
  assert.equal(mod.versionString(0x020104, 3), "2.1.4");
  assert.equal(mod.versionString(-1), null);
  assert.equal(mod.colorHex(0x00ffae), "#aeff00");
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
  await assert.rejects(() => engine.compose({ modules: [{ id: "g", type: "Analog generator" }], patterns: [{ tracks: 1, lines: 100000, events: [] }] }), /lines: an integer from 1 to/);
  await assert.rejects(() => engine.compose({ modules: [{ id: "g", type: "Analog generator" }], patterns: [{ tracks: 99, lines: 4, events: [] }] }), /tracks: an integer from 1 to/);
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

test("sunvox: withLock releases the slot lock when the locked call throws", async () => {
  const mod = await import(pathToFileURL(path.join(BUNDLE, "server", "sunvox-engine.js")).href);
  const calls = [];
  const a = { sv_lock_slot: () => calls.push("lock"), sv_unlock_slot: () => calls.push("unlock") };
  assert.throws(() => mod.withLock(a, () => { throw new TypeError("koffi: expected number"); }), /expected number/);
  assert.deepEqual(calls, ["lock", "unlock"]);
  assert.equal(mod.withLock(a, () => 7), 7, "return value passes through");
});

test("sunvox: SUNVOX_READ_DIRS entries resolve against the work dir, and a root of / works", async () => {
  const os = await import("node:os");
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "sv-work2-"));
  fs.mkdirSync(path.join(work, "..", path.basename(work) + "-extra"), { recursive: true });
  const extraDir = path.join(work, "..", path.basename(work) + "-extra");
  fs.writeFileSync(path.join(extraDir, "c.sunvox"), "x");
  const prev = { w: process.env.SUNVOX_WORKDIR, r: process.env.SUNVOX_READ_DIRS };
  process.env.SUNVOX_WORKDIR = work;
  try {
    process.env.SUNVOX_READ_DIRS = "../" + path.basename(extraDir);
    const srv = await import(pathToFileURL(path.join(BUNDLE, "server", "server.js")).href + "?readdirs");
    assert.equal(srv.resolveReadablePath(path.join(extraDir, "c.sunvox")), fs.realpathSync(path.join(extraDir, "c.sunvox")));
    process.env.SUNVOX_READ_DIRS = "/";
    assert.ok(srv.resolveReadablePath(path.join(extraDir, "c.sunvox")), "a root ending in a separator is matched (path logic; the docs warn against configuring /)");
  } finally {
    for (const [k, v] of [["SUNVOX_WORKDIR", prev.w], ["SUNVOX_READ_DIRS", prev.r]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(extraDir, { recursive: true, force: true });
  }
});

test("sunvox: total pattern cells are capped and a null event gets a clear error", { skip: !engine && SKIP_REASON }, async () => {
  const mods = [{ id: "g", type: "Analog generator" }];
  const big = Array.from({ length: 256 }, () => ({ tracks: 32, lines: 4096, events: [] }));
  await assert.rejects(() => engine.compose({ modules: mods, patterns: big }), /cells/);
  await assert.rejects(() => engine.compose({ modules: mods, patterns: [{ tracks: 1, lines: 4, events: [null] }] }), /every pattern event must be an object/);
});

test("sunvox: negative, fractional or huge tracks/lines are refused before the cell total is summed", { skip: !engine && SKIP_REASON }, async () => {
  const mods = [{ id: "g", type: "Analog generator" }];
  // A negative pattern used to subtract from the running cell total and let
  // the next pattern exceed maxCells.
  // 17 full patterns alone exceed maxCells; the old sum minus a trailing
  // negative pattern landed exactly on the cap, so the 17 were allocated.
  const bypass = [...Array.from({ length: 17 }, () => ({ tracks: 32, lines: 4096, events: [] })), { tracks: -32, lines: 4096, events: [] }];
  await assert.rejects(() => engine.compose({ modules: mods, patterns: bypass }), /tracks: an integer from 1 to/);
  for (const bad of [{ tracks: 1, lines: -64 }, { tracks: 0, lines: 4 }, { tracks: 1.5, lines: 4 }, { tracks: 1, lines: 1e9 }, { tracks: 2 ** 40, lines: 4 }, { tracks: "4", lines: 4 }]) {
    await assert.rejects(() => engine.compose({ modules: mods, patterns: [{ ...bad, events: [] }] }), /an integer from 1 to/, JSON.stringify(bad));
  }
  const ok = await engine.compose({ modules: mods, patterns: [{ events: [] }] }); // defaults 1 x 64
  assert.equal(ok.info.pattern_list[0].lines, 64);
});

test("sunvox: event fields are range-checked, never silently wrapped", { skip: !engine && SKIP_REASON }, async () => {
  const mods = [{ id: "g", type: "Analog generator" }];
  const one = (ev) => engine.compose({ modules: mods, patterns: [{ tracks: 2, lines: 8, events: [{ module: "g", note: "C3", ...ev }] }] });
  for (const ev of [{ track: 2 ** 32 + 1 }, { track: 1.7 }, { track: "1" }, { line: -1 }, { ctl: -1 }, { ctl: 300 }, { ctl: 0, ctl_val: 0x10000 }, { effect: 0x1ff }, { effect: 1, effect_param: -5 }]) {
    await assert.rejects(() => one(ev), /must be an integer from/, JSON.stringify(ev));
  }
  const ok = await one({ track: 1, line: 7, effect: 0x0f, effect_param: 4 });
  assert.equal(ok.info.patterns, 1);
});

// --- Completion (2026-10-20): arrangement, song name, controller ranges, sample rate ---

const G = [{ id: "g", type: "Analog generator" }];
const pat = (id, lines = 8, extra = {}) => ({ id, tracks: 2, lines, events: [{ track: 0, line: 0, note: "C3", module: "g" }], ...extra });

test("sunvox: arrangement places patterns in order and repeats become clones", { skip: !engine && SKIP_REASON }, async () => {
  const r = await engine.compose({
    modules: G,
    patterns: [pat("a", 8), pat("b", 4)],
    arrangement: [{ pattern: "a" }, { pattern: "b" }, { pattern: "a", y: 3 }, { pattern: "b", x: 40 }],
  }, { name: "arr" });
  assert.deepEqual(r.info.pattern_list.map((p) => [p.name, p.x, p.y]), [["a", 0, 0], ["b", 8, 0], ["a", 12, 3], ["b", 40, 0]]);
  assert.equal(r.info.length_lines, 44);
});

test("sunvox: arrangement errors are actionable and bounded", { skip: !engine && SKIP_REASON }, async () => {
  const two = [pat("a"), pat("b")];
  await assert.rejects(() => engine.compose({ modules: G, patterns: two, arrangement: [{ pattern: "a" }, { pattern: "zzz" }] }), /unknown pattern "zzz"; patterns: a, b/);
  await assert.rejects(() => engine.compose({ modules: G, patterns: two, arrangement: [{ pattern: "a" }] }), /pattern\(s\) b are not in the arrangement/);
  await assert.rejects(() => engine.compose({ modules: G, patterns: [pat("a"), pat("a")], arrangement: [{ pattern: "a" }] }), /must be unique/);
  await assert.rejects(() => engine.compose({ modules: G, patterns: [pat("a")], arrangement: [{ pattern: "a", x: -1 }] }), /x must be an integer from 0/);
  await assert.rejects(() => engine.compose({ modules: G, patterns: [pat("a")], arrangement: [{ pattern: "a", x: 65537 }] }), /x must be an integer from 0 to 65536/);
  await assert.rejects(() => engine.compose({ modules: G, patterns: [pat("a")], arrangement: [{ pattern: "a", y: 5000 }] }), /y must be an integer/);
  await assert.rejects(() => engine.compose({ modules: G, patterns: [pat("a")], arrangement: [] }), /non-empty array/);
  await assert.rejects(() => engine.compose({ modules: G, patterns: [pat("a")], arrangement: Array.from({ length: 4097 }, () => ({ pattern: "a" })) }), /at most 4096 placements/);
  const ok = await engine.compose({ modules: G, patterns: [pat("a")], arrangement: [{ pattern: "a" }] });
  assert.equal(ok.info.patterns, 1, "engine usable after rejected arrangements");
});

test("sunvox: the tempo goes into the pattern that plays first, whatever the spec order", { skip: !engine && SKIP_REASON }, async () => {
  const r = await engine.compose({
    bpm: 90, tpl: 4, modules: G,
    patterns: [pat("late", 8), pat("early", 8)],
    arrangement: [{ pattern: "late", x: 8 }, { pattern: "early", x: 0 }],
  });
  assert.deepEqual(r.info.effective_tempo.at_line_0, { bpm: 90, tpl: 4 });
  await assert.rejects(() => engine.compose({ bpm: 90, tpl: 4, modules: G, patterns: [{ id: "one", tracks: 1, lines: 8, events: [] }] }), /needs two free tracks/);
});

test("sunvox: the compose name becomes the song name", { skip: !engine && SKIP_REASON }, async () => {
  const r = await engine.compose({ modules: G, patterns: [pat("a")] }, { name: "Late night\nloop" });
  assert.equal(r.info.name, "Late nightloop");
  const info = await engine.info(r.project);
  assert.equal(info.name, "Late nightloop");
});

test("sunvox: module params must lie inside the controller's min..max", { skip: !engine && SKIP_REASON }, async () => {
  const one = (params) => engine.compose({ modules: [{ id: "g", type: "Analog generator", params }], patterns: [pat("a")] });
  await assert.rejects(() => one({ Volume: 257 }), /param "Volume" on "g" must be from 0 to 256/);
  await assert.rejects(() => one({ Volume: -1 }), /must be from 0 to 256/);
  await assert.rejects(() => one({ Waveform: 99 }), /param "Waveform" on "g" must be from 0 to \d+/, "selectors too");
  const ok = await one({ Volume: 256, Waveform: 1 });
  assert.equal(ok.info.modules, 2);
});

test("sunvox: renders at 48000 Hz on request, then back at 44100; other rates are refused", { skip: !engine && SKIP_REASON }, async () => {
  const buf = fs.readFileSync(FIXTURE);
  const hi = await engine.render(buf, { sampleRate: 48000 });
  assert.equal(hi.sample_rate, 48000);
  assert.equal(hi.wav.readUInt32LE(24), 48000, "WAV header rate");
  assert.equal(hi.info.length_frames, 345600, "7.2 s at 48 kHz");
  assert.ok(hi.frames >= 345600);
  const lo = await engine.render(buf);
  assert.equal(lo.wav.readUInt32LE(24), 44100);
  assert.equal(lo.info.length_frames, 317520);
  await assert.rejects(() => engine.render(buf, { sampleRate: 22050 }), /sample_rate must be one of 44100, 48000/);
  const info = await engine.info(buf);
  assert.equal(info.sample_rate, 44100);
});

// --- Tool level (in-memory MCP client, fake storage/db/Funkwhale) ---

async function toolClient(inject, workdir) {
  const prev = process.env.SUNVOX_WORKDIR;
  process.env.SUNVOX_WORKDIR = workdir;
  const srv = await import(pathToFileURL(path.join(BUNDLE, "server", "server.js")).href + `?tools=${encodeURIComponent(workdir)}`);
  if (prev === undefined) delete process.env.SUNVOX_WORKDIR; else process.env.SUNVOX_WORKDIR = prev;
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = srv.createSunvoxServer(inject);
  await server.connect(a);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(b);
  return {
    call: async (name, args) => {
      const r = await client.callTool({ name, arguments: args });
      return { isError: !!r.isError, text: r.content[0].text, json: (() => { try { return JSON.parse(r.content[0].text); } catch { return null; } })() };
    },
    close: () => client.close(),
  };
}
function memS3() {
  const objects = new Map();
  return {
    objects,
    defaultBucket: () => "crow-files",
    getBucketStats: async () => ({ fileCount: objects.size, totalSizeBytes: [...objects.values()].reduce((n, b) => n + b.length, 0) }),
    uploadObject: async (k, d) => { objects.set(k, Buffer.from(d)); },
    deleteObject: async (k) => { objects.delete(k); },
    getPresignedUrl: async (k) => `http://storage.example/crow-files/${k}?X-Amz-Signature=x`,
  };
}
function memDb() {
  const rows = { storage_files: [], notifications: [] };
  return { rows, execute: async ({ sql, args }) => { if (/INSERT INTO storage_files/.test(sql)) rows.storage_files.push(args); return { rows: [] }; } };
}
const tinySpec = { bpm: 120, modules: [{ id: "g", type: "Analog generator" }], patterns: [{ id: "a", tracks: 2, lines: 8, events: [{ track: 0, line: 0, note: "C3", module: "g" }] }] };

test("sunvox tools: compose saves project + render to storage, refuses a same-name overwrite unless asked", { skip: !engine && SKIP_REASON }, async () => {
  const os = await import("node:os");
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "sv-tools-"));
  const s3 = memS3(); const db = memDb(); const notes = [];
  const c = await toolClient({ storage: async () => s3, db: async () => db, createNotification: async (_db, o) => { notes.push(o); return { id: 1 }; } }, work);
  try {
    const r = await c.call("sunvox_compose", { name: "My Loop", render: true, spec: tinySpec, reference_type: "blog_post", notify: true });
    assert.equal(r.isError, false, r.text);
    assert.match(r.json.project_storage_key, /^sunvox-studio\/projects\/\d+-[0-9a-f]{32}-My_Loop\.sunvox$/);
    assert.match(r.json.render_storage_key, /^sunvox-studio\/renders\/\d+-[0-9a-f]{32}-My_Loop-\d+-[0-9a-f]{6}\.wav$/);
    assert.equal(r.json.project_media_path, `/blog/media/${r.json.project_storage_key}`);
    assert.ok(r.json.project_storage_url.startsWith("http://storage.example/"));
    assert.equal(r.json.info.name, "My Loop");
    assert.equal(r.json.notified, true);
    assert.equal(notes[0].source, "sunvox-studio");
    assert.equal(s3.objects.size, 2);
    assert.deepEqual(db.rows.storage_files.map((a) => a[5]), ["blog_post", "blog_post"]);
    assert.ok(s3.objects.get(r.json.project_storage_key).subarray(0, 4).equals(Buffer.from("SVOX")));
    assert.ok(s3.objects.get(r.json.render_storage_key).subarray(0, 4).equals(Buffer.from("RIFF")));

    const again = await c.call("sunvox_compose", { name: "My Loop", spec: tinySpec });
    assert.equal(again.isError, true);
    assert.match(again.text, /already exists.*overwrite: true/);
    const forced = await c.call("sunvox_compose", { name: "My Loop", spec: tinySpec, overwrite: true, save_to_storage: false });
    assert.equal(forced.isError, false, forced.text);
    assert.equal(forced.json.project_storage_key, undefined);
    assert.equal(s3.objects.size, 2, "save_to_storage false stores nothing");
  } finally { await c.close(); fs.rmSync(work, { recursive: true, force: true }); }
});

test("sunvox tools: without storage a render keeps its local path and says why; save_to_storage true fails", { skip: !engine && SKIP_REASON }, async () => {
  const os = await import("node:os");
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "sv-tools-"));
  fs.copyFileSync(FIXTURE, path.join(work, "f.sunvox"));
  const c = await toolClient({ storage: async () => null, db: async () => memDb() }, work);
  try {
    const r = await c.call("sunvox_render", { path: "f.sunvox" });
    assert.equal(r.isError, false, r.text);
    assert.ok(fs.existsSync(r.json.path));
    // duration_s is the audio actually written (the song plus its effect tail), not the song length.
    const wav = fs.readFileSync(r.json.path);
    assert.equal(r.json.duration_s, +((wav.length - 44) / 4 / 44100).toFixed(3));
    assert.equal(r.json.song_duration_s, 7.2);
    assert.match(r.json.storage, /not saved: storage is not available/);
    const strict = await c.call("sunvox_render", { path: "f.sunvox", save_to_storage: true });
    assert.equal(strict.isError, true);
    assert.match(strict.text, /storage is not available/);
    const bad = await c.call("sunvox_render", { path: "f.sunvox", sample_rate: 22050 });
    assert.equal(bad.isError, true, "the schema refuses rates the library cannot render");
  } finally { await c.close(); fs.rmSync(work, { recursive: true, force: true }); }
});

test("sunvox tools: render pushes an mp3 to Funkwhale using only the configured origin", { skip: (!engine && SKIP_REASON) || NO_FFMPEG }, async () => {
  const os = await import("node:os");
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "sv-tools-"));
  fs.copyFileSync(FIXTURE, path.join(work, "f.sunvox"));
  const LIB = "0f8a6c1e-1111-4222-8333-444455556666";
  const UP = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), redirect: init.redirect, auth: init.headers.Authorization });
    if (String(url).endsWith("/api/v1/uploads/")) {
      const f = init.body.get("audio_file");
      assert.ok(Buffer.from(await f.arrayBuffer()).length > 1000);
      return new Response(JSON.stringify({ uuid: UP, import_status: "finished", track: { id: 9 } }), { status: 201 });
    }
    return new Response("{}", { status: 404 });
  };
  const c = await toolClient({ storage: async () => memS3(), db: async () => memDb(), musicConfig: async () => ({ origin: "http://127.0.0.1:5999", token: "tok" }), consumeToken: async () => ({ allowed: true }), fetchImpl }, work);
  try {
    const r = await c.call("sunvox_render", { path: "f.sunvox", format: "mp3", funkwhale_library: LIB });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json.format, "mp3");
    const probe = require("node:child_process").spawnSync("ffprobe", ["-v", "error", "-show_entries", "format_tags=title,artist,album", "-of", "json", r.json.path], { encoding: "utf8" });
    const tags = JSON.parse(probe.stdout).format.tags;
    assert.deepEqual([tags.title, tags.artist, tags.album], ["Crow fixture", "Crow", "SunVox Studio"], "a library import needs title, artist and album tags");
    assert.equal(r.json.funkwhale.funkwhale_upload_uuid, UP);
    assert.equal(r.json.funkwhale.funkwhale_track_id, 9);
    assert.ok(seen.length >= 1 && seen.every((s) => s.url.startsWith("http://127.0.0.1:5999/") && s.redirect === "error" && s.auth === "Bearer tok"));
    const wav = await c.call("sunvox_render", { path: "f.sunvox", funkwhale_library: LIB });
    assert.equal(wav.isError, false, "the render itself succeeds");
    assert.match(wav.json.funkwhale.error, /mp3 or ogg/);
  } finally { await c.close(); fs.rmSync(work, { recursive: true, force: true }); }
});

test("sunvox: the work dir follows the instance data dir, and a '~/' setting expands", async () => {
  const os = await import("node:os");
  const { spawnSync } = await import("node:child_process");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-data-"));
  const url = pathToFileURL(path.join(BUNDLE, "server", "server.js")).href;
  const run = (env) => {
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", `const m = await import(${JSON.stringify(url)}); console.log(m.WORKDIR)`], { env: { ...process.env, CROW_APP_ROOT: ROOT, SUNVOX_WORKDIR: "", ...env }, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  try {
    assert.equal(run({ CROW_DATA_DIR: dataDir }), path.join(dataDir, "sunvox-studio"));
    assert.equal(run({ CROW_DATA_DIR: dataDir, SUNVOX_WORKDIR: "~/music-out" }), path.join(os.homedir(), "music-out"));
    // 0.1.x installs carry the old manifest default in their entry: it means "the default", per instance.
    assert.equal(run({ CROW_DATA_DIR: dataDir, SUNVOX_WORKDIR: "~/.crow/data/sunvox-studio" }), path.join(dataDir, "sunvox-studio"));
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("sunvox: repeats in an arrangement share their notes with the original (clones, not copies)", { skip: !engine && SKIP_REASON }, async () => {
  const { project } = await engine.compose({ modules: G, patterns: [pat("a", 8)], arrangement: [{ pattern: "a" }, { pattern: "a" }, { pattern: "a" }] });
  // A clone adds a timeline entry but no pattern data: three placements of one 8-line
  // pattern save smaller than three separate 8-line patterns with the same notes.
  const copies = await engine.compose({ modules: G, patterns: [pat("a", 8), pat("b", 8), pat("c", 8)], arrangement: [{ pattern: "a" }, { pattern: "b" }, { pattern: "c" }] });
  assert.ok(project.length < copies.project.length, `${project.length} < ${copies.project.length}`);
  const info = await engine.info(project);
  assert.deepEqual(info.pattern_list.map((p) => p.x), [0, 8, 16]);
  const ok = await engine.compose({ modules: G, patterns: [pat("a", 1)], arrangement: Array.from({ length: 4096 }, () => ({ pattern: "a" })) });
  assert.equal(ok.info.patterns, 4096, "the 4096-placement limit itself is accepted");
});

test("sunvox: wipeKeys zeroes every key buffer of an identity", async () => {
  const srv = await import(pathToFileURL(path.join(BUNDLE, "server", "server.js")).href + "?wipe");
  const id = { crowId: "crow:x", seed: Buffer.from([1, 2, 3]), ed25519Priv: new Uint8Array([4, 5]), secp256k1Priv: new Uint8Array([6]) };
  srv.wipeKeys(id);
  assert.deepEqual([...id.seed, ...id.ed25519Priv, ...id.secp256k1Priv], [0, 0, 0, 0, 0, 0]);
  assert.equal(id.crowId, "crow:x");
});

test("sunvox tools: storage_key reads only this bundle's files and blog media, never project or private files", { skip: !engine && SKIP_REASON }, async () => {
  const os = await import("node:os");
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "sv-tools-"));
  const fixture = fs.readFileSync(FIXTURE);
  const rows = {
    "sunvox-studio/projects/1-x-own.sunvox": { reference_type: null, project_id: null },
    "1700-shared.sunvox": { reference_type: "blog_post", project_id: null },
    "1700-private.sunvox": { reference_type: null, project_id: null },
    "proj/1700-secret.sunvox": { reference_type: "blog_post", project_id: 4 },
    "sunvox-studio/projects/in-project.sunvox": { reference_type: null, project_id: 4 },
  };
  const db = { execute: async ({ sql, args }) => (/FROM storage_files WHERE s3_key/.test(sql) ? { rows: rows[args[0]] ? [rows[args[0]]] : [] } : { rows: [] }) };
  const fetched = [];
  const s3 = { ...memS3(), getObject: async (k) => { fetched.push(k); const { Readable } = await import("node:stream"); return { stream: Readable.from([fixture]), stat: { size: fixture.length } }; } };
  const c = await toolClient({ storage: async () => s3, db: async () => db }, work);
  try {
    for (const k of ["sunvox-studio/projects/1-x-own.sunvox", "1700-shared.sunvox"]) {
      const r = await c.call("sunvox_info", { storage_key: k });
      assert.equal(r.isError, false, `${k}: ${r.text}`);
    }
    for (const k of ["1700-private.sunvox", "proj/1700-secret.sunvox", "sunvox-studio/projects/in-project.sunvox", "not-in-the-table.sunvox"]) {
      const r = await c.call("sunvox_render", { storage_key: k, reference_type: "blog_post" });
      assert.equal(r.isError, true, k);
      assert.match(r.text, /is not readable here/);
    }
    assert.deepEqual(fetched, ["sunvox-studio/projects/1-x-own.sunvox", "1700-shared.sunvox"], "refused keys were never fetched");
  } finally { await c.close(); fs.rmSync(work, { recursive: true, force: true }); }
});
