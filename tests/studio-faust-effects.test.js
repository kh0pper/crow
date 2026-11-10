/**
 * Studio's Faust effects and their licence lint (plan 1d, Task 7).
 *
 * The seven Faust inserts are compiled to WebAssembly at build time by
 * `tools/build-faust.mjs`, which also refuses any effect that uses a Faust
 * library function whose licence Crow may not ship. These tests pin four things:
 *
 *   1. **The lint.** Two fixtures compile and must be refused — one GPL-3.0-only
 *      function (`co.FFcompressor_N_chan`), one AGPL-3.0-only (`ba.processArray`)
 *      — plus a unit pass over the allowlist itself, so a spelling that must be
 *      let through (or refused) is tested without a compiler.
 *   2. **The parameters.** Each compiled effect's controls are exactly the song
 *      document's `EFFECT_PARAMS` entry for its kind: the same names, the same
 *      ranges, the same defaults (a chooser's words become 0..n-1, and its word's
 *      index is the default). A range must never be widened in one place and
 *      left behind in the other.
 *   3. **The numbers.** Every effect, driven through `engine/faust-host.js` at
 *      44.1, 48 and 96 kHz with every parameter at the bottom of its range and
 *      then at the top, stays finite on a full-scale sine — and passes audio,
 *      so a silent instance cannot hide behind "no NaN".
 *   4. **The checked-in build.** A fresh compile of every shipped effect is
 *      byte-identical to `vendor/faust/`, licences and notices included. That
 *      last one needs `node bundles/studio/tools/build-faust.mjs` to have been
 *      run; until the output is committed it fails, naming the files.
 *
 * The tests that need compiled effects compile into a temporary directory of
 * their own, so they pass on a checkout whose `vendor/faust/` is not there yet.
 * The null test that hosts a Faust insert in a real worklet lives beside the
 * other parity tests in `tests/studio-engine.test.js`, where the headless-Chrome
 * harness is.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

// The document's copy of the parameter table — what a compiled effect has to
// agree with — and the engine kinds it lists.
import { EFFECT_KINDS, EFFECT_PARAMS } from "../bundles/studio/server/doc.js";
// The render's asset list must ask for the same effects the engine asks for.
import { FAUST_KINDS as RENDER_FAUST_KINDS } from "../bundles/studio/server/render.js";
import {
  VENDOR_DIR,
  buildFaust,
  compileEffect,
  compileProgram,
  effectKinds,
  isAllowedLicence,
  lintMeta,
  staleOutput,
  writeFaust,
} from "../bundles/studio/tools/build-faust.mjs";

const BUNDLE_DIR = fileURLToPath(new URL("../bundles/studio/", import.meta.url));
const FIXTURES = fileURLToPath(new URL("./fixtures/faust/", import.meta.url));
const HOST_FILE = join(BUNDLE_DIR, "engine", "faust-host.js");

// The bundle's own resolution, from inside the bundle (that is where the
// package's `"commonjs"` override for `engine/` applies).
const bundleRequire = createRequire(join(BUNDLE_DIR, "engine", "x.js"));
const StudioFaustHost = bundleRequire(HOST_FILE);
const studioEngine = bundleRequire(join(BUNDLE_DIR, "engine", "engine-client.js"));
const { OfflineAudioContext } = bundleRequire("node-web-audio-api");

/**
 * node-web-audio-api's worklet release symbol: a test that stops before
 * `startRendering()` has to release the worklet thread by hand.
 * @returns {Promise<symbol|null>}
 */
async function workletReleaseSymbol() {
  try {
    const entry = bundleRequire.resolve("node-web-audio-api");
    const module = await import(
      pathToFileURL(join(entry, "..", "js", "lib", "symbols.js")).href,
    );
    return module.kWorkletRelease || null;
  } catch {
    return null;
  }
}

/** The seven Faust kinds, in the document's order (the dynamics are JS). */
const FAUST_KINDS = ["eq", "filter", "delay", "reverb", "chorus", "phaser", "saturation"];

/** The rates a browser, a render and a 96 kHz interface run at. */
const RATES = [44100, 48000, 96000];

/** The processor's block: what an insert is handed at a time. */
const BLOCK = 128;

/** The build's output, and the compiled effect modules the host tests use. */
let built = null;
let tempDir = "";

/**
 * The value of every one of a kind's parameters, as the song document holds
 * them, all at one end of their range: `values[0]` for a chooser, else the
 * range's low or high end.
 * @param {string} kind
 * @param {"min"|"max"} end
 * @returns {Object<string, number|string>}
 */
function everyParamAt(kind, end) {
  const params = EFFECT_PARAMS[kind].params;
  const plain = {};
  for (const [name, spec] of Object.entries(params)) {
    if (spec.values) plain[name] = end === "min" ? spec.values[0] : spec.values[spec.values.length - 1];
    else plain[name] = end === "min" ? spec.min : spec.max;
  }
  return plain;
}

/**
 * A stereo sine the insert has to survive: full scale, with the right channel a
 * quarter cycle behind the left.
 * @param {number} rate
 * @param {number} index the block's first frame, so blocks continue a waveform
 * @param {Float32Array} left
 * @param {Float32Array} right
 * @param {number} frames
 * @returns {void}
 */
function fillTone(rate, index, left, right, frames) {
  const step = (2 * Math.PI * 220) / rate;
  for (let at = 0; at < frames; at += 1) {
    const phase = step * (index + at);
    left[at] = Math.sin(phase);
    right[at] = Math.sin(phase + Math.PI / 2);
  }
}

/** @returns {number} how many frames the run wrote that were silence. */
function silentFrames(samples, frames) {
  let silent = 0;
  for (let at = 0; at < frames; at += 1) if (samples[at] === 0) silent += 1;
  return silent;
}

/** @returns {number} how many frames of two channels are not finite numbers. */
function nonFiniteFrames(left, right, frames) {
  let bad = 0;
  for (let at = 0; at < frames; at += 1) {
    const leftValue = left[at];
    const rightValue = right[at];
    if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue)) bad += 1;
  }
  return bad;
}

before(async () => {
  // One fresh build in memory: it compiles all seven (and lints them), and the
  // files go into a temporary directory of this test's own, so nothing here
  // depends on `vendor/faust/` having been committed.
  built = await buildFaust();
  tempDir = mkdtempSync(join(tmpdir(), "studio-faust-"));
  writeFaust(built, tempDir);
  const modules = {};
  for (const kind of effectKinds()) {
    modules[kind] = {
      wasm: readFileSync(join(tempDir, `${kind}.wasm`)),
      json: readFileSync(join(tempDir, `${kind}.json`), "utf8"),
    };
  }
  await StudioFaustHost.compileModules(modules);
});

after(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  StudioFaustHost.release();
});

// --- the licence lint -------------------------------------------------------

test("the lint refuses a GPL-only function", async () => {
  const source = readFileSync(join(FIXTURES, "gpl-compressor.dsp"), "utf8");
  const fixture = await compileProgram("gpl-compressor", source);

  assert.equal(fixture.lint.ok, false, "a program using a GPL-only function must not pass the lint");
  const named = fixture.lint.refused.map((item) => item.function);
  assert.ok(
    named.includes("compressors.lib/FFcompressor_N_chan"),
    `the refusal must name the function, named: ${named.join(", ")}`,
  );
  for (const item of fixture.lint.refused) {
    assert.match(item.licence, /^GPL-/, `unexpected licence in the refusal: ${JSON.stringify(item)}`);
  }

  // And the build refuses it, with a sentence naming the function and its
  // licence — that is what a .dsp that used a `co.*` compressor would print.
  await assert.rejects(
    () => compileEffect("gpl-compressor", source),
    (error) => {
      assert.match(error.message, /gpl-compressor\.dsp/);
      assert.match(error.message, /compressors\.lib\/FFcompressor_N_chan/);
      assert.match(error.message, /GPL-3\.0-only/);
      return true;
    },
  );
});

test("the lint refuses an AGPL function", async () => {
  const source = readFileSync(join(FIXTURES, "agpl-process-array.dsp"), "utf8");
  const fixture = await compileProgram("agpl-process-array", source);

  assert.equal(fixture.lint.ok, false, "a program using an AGPL-only function must not pass the lint");
  const named = fixture.lint.refused.map((item) => item.function);
  assert.ok(
    named.includes("basics.lib/processArray"),
    `the refusal must name the function, named: ${named.join(", ")}`,
  );
  assert.ok(
    fixture.lint.refused.some((item) => item.licence === "AGPL-3.0-only"),
    `expected an AGPL-3.0-only refusal, got ${JSON.stringify(fixture.lint.refused)}`,
  );
  await assert.rejects(() => compileEffect("agpl-process-array", source), /processArray.*AGPL-3\.0-only/);
});

test("the allowlist is the permissive licences, and only those", () => {
  // Everything a Faust library declares that Crow may ship, in every spelling
  // the libraries use (STK-4.3 is `LicenseRef-STK-4.3` per function and plain
  // `STK-4.3` at the library level; the LGPL-with-Faust-exception id likewise).
  for (const licence of [
    "MIT",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "LicenseRef-STK-4.3",
    "STK-4.3",
    "LicenseRef-LGPL-2.1-or-later-with-Faust-exception",
    "LicenseRef-LGPL-2.1-only-with-Faust-exception",
    "LGPL-2.1+ with-Faust-exception",
    "LGPL with exception",
  ]) {
    assert.equal(isAllowedLicence(licence), true, `${licence} must be allowed`);
  }
  for (const licence of ["GPL-3.0-only", "GPL-2.0-or-later", "AGPL-3.0-only", "LGPL-3.0-only", "", "unknown"]) {
    assert.equal(isAllowedLicence(licence), false, `${licence} must be refused`);
  }

  // A function entry, a library-level entry, and both key spellings.
  const mixed = lintMeta([
    { "filters.lib/low_shelf:license": "LicenseRef-STK-4.3" },
    { "reverbs.lib/jpverb:license": "MIT" },
    { "signals.lib/onePoleSwitching:licence": "LicenseRef-STK-4.3" },
    { "maths.lib/license": "LicenseRef-LGPL-2.1-or-later-with-Faust-exception" },
  ]);
  assert.equal(mixed.ok, true, JSON.stringify(mixed.refused));
  assert.deepEqual(
    mixed.accepted.map((item) => item.function),
    ["filters.lib/low_shelf", "reverbs.lib/jpverb", "signals.lib/onePoleSwitching", "maths.lib"],
  );

  // A meta that names no licence at all is refused as unknown, not waved through.
  const silent = lintMeta([{ name: "crow-something" }]);
  assert.equal(silent.ok, false);
  assert.equal(silent.unknown, true);
  assert.equal(silent.refused[0].licence, "unknown");

  // A non-licence key is not a licence claim (a program's own name, a control's
  // declared label).
  assert.equal(lintMeta([{ name: "x", "ui/lib/thing:unit": "Hz" }]).unknown, true);
});

// --- the shipped effects ----------------------------------------------------

test("every shipped effect passes the lint and matches its compiled output", async () => {
  const kinds = effectKinds();
  assert.deepEqual(kinds, [...FAUST_KINDS].sort(), "the shipped effects must be the document's seven Faust kinds");
  assert.deepEqual(
    [...RENDER_FAUST_KINDS].sort(),
    kinds,
    "a render must load the same Faust effects the engine asks for",
  );

  for (const kind of kinds) {
    const source = readFileSync(join(BUNDLE_DIR, "effects", `${kind}.dsp`), "utf8");
    const effect = await compileProgram(kind, source);
    assert.equal(effect.lint.ok, true, `${kind}.dsp: ${JSON.stringify(effect.lint.refused)}`);
    assert.ok(effect.lint.accepted.length > 0, `${kind}.dsp must carry at least one licence entry`);
  }

  // A fresh compile has to be what is checked in — wasm bytes, factory JSON,
  // the licence table and the notices. Until the build has been run this is
  // where that shows, and the message says what to run.
  const stale = staleOutput(built);
  assert.deepEqual(
    stale,
    [],
    `the checked-in Faust output is stale; run: node bundles/studio/tools/build-faust.mjs\n  ${stale.join("\n  ")}`,
  );

  // The licences honestly came from a compiled meta, and the STK text from the
  // compiler package's own copy of the Faust libraries.
  const licences = JSON.parse(readFileSync(join(VENDOR_DIR, "LICENSES.json"), "utf8"));
  assert.deepEqual(Object.keys(licences), [...kinds].sort());
  for (const kind of kinds) {
    assert.ok(licences[kind].length > 0, `${kind} must list the licences its functions declared`);
    const names = licences[kind].map((item) => item.function);
    assert.deepEqual(names, [...names].sort(), `${kind}'s licence entries must be sorted`);
    assert.equal(new Set(names).size, names.length, `${kind}'s licence entries must be unique`);
    for (const item of licences[kind]) {
      assert.equal(isAllowedLicence(item.licence), true, `${kind}: ${item.function} is ${item.licence}`);
    }
  }

  const notices = readFileSync(join(VENDOR_DIR, "NOTICES.md"), "utf8");
  assert.match(notices, /STK 4\.3/, "NOTICES.md must carry the STK 4.3 section");
  assert.match(notices, /Permission is hereby granted/, "NOTICES.md must carry the STK 4.3 text verbatim");
  assert.match(notices, /reverbs\.lib\/jpverb/, "NOTICES.md must list the functions each effect uses");

  // The banner names the compiler and its licence.
  const readme = readFileSync(join(VENDOR_DIR, "README.md"), "utf8");
  const manifest = JSON.parse(
    readFileSync(join(BUNDLE_DIR, "..", "..", "node_modules", "@grame", "faustwasm", "package.json"), "utf8"),
  );
  assert.match(readme, new RegExp(`@grame/faustwasm ${manifest.version}`), "the banner must name faustwasm's version");
  assert.match(readme, new RegExp(String(manifest.license).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(
    readFileSync(join(VENDOR_DIR, "LICENSE-faustwasm.txt"), "utf8"),
    readFileSync(join(BUNDLE_DIR, "..", "..", "node_modules", "@grame", "faustwasm", "COPYING.txt"), "utf8"),
    "faustwasm's licence must be copied verbatim",
  );
});

test("every Faust effect exposes exactly the document's parameters", async () => {
  // The kinds the document lists that are Faust ones, and only those.
  const dynamics = ["compressor", "limiter", "gate", "deesser"];
  assert.deepEqual(
    EFFECT_KINDS.filter((kind) => !dynamics.includes(kind)),
    FAUST_KINDS,
    "the document's Faust kinds and this task's seven must be the same list",
  );

  for (const kind of FAUST_KINDS) {
    const source = readFileSync(join(BUNDLE_DIR, "effects", `${kind}.dsp`), "utf8");
    const effect = await compileProgram(kind, source);
    const meta = JSON.parse(effect.json);
    const controls = new Map();
    const visit = (item) => {
      if (Array.isArray(item)) return item.forEach(visit);
      if (!item || typeof item !== "object") return;
      if (Array.isArray(item.items)) return visit(item.items);
      const address = String(item.address || "");
      controls.set(address.slice(address.lastIndexOf("/") + 1), item);
    };
    visit(meta.ui);

    const spec = EFFECT_PARAMS[kind].params;
    assert.deepEqual(
      [...controls.keys()].sort(),
      Object.keys(spec).sort(),
      `${kind}: the compiled controls must be exactly the document's parameters`,
    );
    for (const [name, field] of Object.entries(spec)) {
      const control = controls.get(name);
      if (field.values) {
        // A chooser is an integer control: 0..n-1, and the default is the
        // word's index in the document's list.
        assert.equal(control.min, 0, `${kind}.${name}: a chooser starts at 0`);
        assert.equal(control.max, field.values.length - 1, `${kind}.${name}: a chooser ends at values.length - 1`);
        assert.equal(control.init, field.values.indexOf(field.default), `${kind}.${name}: default index`);
        assert.deepEqual(
          StudioFaustHost.CHOICES[kind] && StudioFaustHost.CHOICES[kind][name],
          field.values,
          `${kind}.${name}: the host's word list must be the document's`,
        );
      } else {
        assert.equal(control.min, field.min, `${kind}.${name}: minimum`);
        assert.equal(control.max, field.max, `${kind}.${name}: maximum`);
        assert.equal(control.init, field.default, `${kind}.${name}: default`);
      }
      assert.equal(typeof control.index, "number", `${kind}.${name}: needs a parameter offset`);
    }
  }
});

test("each effect processes a sine without NaN at its extremes", () => {
  // Long enough for the slowest effect to have spoken: the reverb at its
  // largest size with 200 ms of predelay is still silent for the first fifth of
  // a second, and "it passed audio" has to be measured after that.
  const blocks = 400;
  for (const rate of RATES) {
    for (const kind of FAUST_KINDS) {
      const insert = StudioFaustHost.create(kind, rate);
      assert.equal(insert.latencyFrames, 0, `${kind} must be a zero-latency insert`);
      for (const end of ["min", "max"]) {
        insert.reset();
        insert.setParams(everyParamAt(kind, end));
        const left = new Float32Array(BLOCK);
        const right = new Float32Array(BLOCK);
        let written = 0;
        for (let block = 0; block < blocks; block += 1) {
          fillTone(rate, block * BLOCK, left, right, BLOCK);
          insert.process(left, right, BLOCK);
          assert.equal(
            nonFiniteFrames(left, right, BLOCK),
            0,
            `${kind} at ${rate} Hz with every parameter at its ${end} produced a non-finite sample`,
          );
          written += BLOCK - silentFrames(left, BLOCK);
        }
        assert.ok(written > 0, `${kind} at ${rate} Hz with every parameter at its ${end} passed no audio at all`);
      }
    }
  }
});

test("an insert's settings are clamped, ignored when unknown, and independent per instance", () => {
  const slow = StudioFaustHost.create("delay", 48000);
  // Out of range is clamped; an unknown name is ignored; a non-number leaves
  // that parameter alone.
  slow.setParams({ time_ms: 10_000, feedback: -5, nonsense: 1, mix: "loud" });
  assert.equal(slow.params().time_ms, 2000, "a time past the range clamps to the range's top");
  assert.equal(slow.params().feedback, 0, "a feedback below the range clamps to the range's bottom");
  assert.equal(slow.params().mix, EFFECT_PARAMS.delay.params.mix.default, "a non-number leaves the value alone");
  assert.equal(slow.params().nonsense, undefined, "an unknown name is ignored");

  // Two instances of one kind share a compiled module, never a state: one delay
  // with a long feedback tail and one without cannot render the same audio.
  const wet = StudioFaustHost.create("delay", 48000);
  const dry = StudioFaustHost.create("delay", 48000);
  wet.setParams({ time_ms: 10, feedback: 0.8, mix: 0.5 });
  dry.setParams({ time_ms: 10, feedback: 0, mix: 0.5 });
  const leftWet = new Float32Array(BLOCK);
  const leftDry = new Float32Array(BLOCK);
  const rightWet = new Float32Array(BLOCK);
  const rightDry = new Float32Array(BLOCK);
  let differs = false;
  for (let block = 0; block < 16; block += 1) {
    fillTone(48000, block * BLOCK, leftWet, rightWet, BLOCK);
    leftDry.set(leftWet);
    rightDry.set(rightWet);
    wet.process(leftWet, rightWet, BLOCK);
    dry.process(leftDry, rightDry, BLOCK);
    for (let at = 0; at < BLOCK; at += 1) if (leftWet[at] !== leftDry[at]) differs = true;
  }
  assert.ok(differs, "two delay instances with different feedback must not render identical audio");
});

test("the Faust host is a classic script that brings its own imports", () => {
  const source = readFileSync(HOST_FILE, "utf8");
  // The prose may mention `require()`; the code may not call it.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(code, /^\s*import\s/m, "the host must not import anything");
  assert.doesNotMatch(code, /^\s*export\s/m, "the host must not export anything");
  assert.doesNotMatch(code, /\brequire\s*\(/, "the host must not call require()");
  assert.doesNotMatch(code, /@grame\/faustwasm/, "the host must not depend on the compiler package");
  // It is the classic-script shape the worklet module needs: a global, and a
  // CommonJS export for the Node side of the same test.
  assert.match(source, /globalThis\.StudioFaustHost\s*=/, "the host must publish globalThis.StudioFaustHost");
  assert.match(source, /module\.exports\s*=/, "the host must export itself in CommonJS");

  // A kind that was never compiled is refused by name, and creating one throws
  // rather than failing somewhere inside process().
  assert.equal(StudioFaustHost.has("compressor"), false, "the JS dynamics are not Faust effects");
  assert.throws(() => StudioFaustHost.create("compressor", 48000), /no compiled Faust effect named "compressor"/);
});

// --- the engine's half of the wire ------------------------------------------

/**
 * One short engine render with the given asset map, answering every fault the
 * processor reported. This exercises engine-client's `faust-modules` message all
 * the way into `StudioFaustHost.compileModules`, inside a real worklet.
 * @param {object} assets the `assetBytes` map (the SunVox wasm is supplied too)
 * @returns {Promise<string[]>} what the engine reported
 */
async function engineErrorsWith(assets) {
  const sampleRate = 48000;
  const context = new OfflineAudioContext({ numberOfChannels: 2, length: 2400, sampleRate: sampleRate });
  let engine = null;
  let rendered = false;
  const errors = [];
  try {
    engine = await studioEngine.create(context, {
      assetBytes: { "sunvox.wasm": readFileSync(join(BUNDLE_DIR, "vendor", "sunvox", "sunvox.wasm")), ...assets },
    });
    engine.onError((text) => errors.push(text));
    engine.setSong({
      meta: { title: "Faust wire", bpm: 120, meter: [4, 4], key: "C major" },
      tracks: [],
      scenes: [{ id: "scene-1", name: "A" }],
      clips: {},
    });
    engine.launchScene("scene-1");
    engine.play();
    engine.node.connect(context.destination);
    await engine.flush();
    await context.startRendering();
    rendered = true;
    return errors;
  } finally {
    if (engine) engine.dispose();
    if (!rendered) {
      const symbol = await workletReleaseSymbol();
      try {
        if (symbol) await context.audioWorklet[symbol]();
      } catch {
        /* nothing to release */
      }
    }
  }
}

test("the engine hands its compiled effects to the processor", async () => {
  const wasm = readFileSync(join(tempDir, "reverb.wasm"));
  const json = readFileSync(join(tempDir, "reverb.json"), "utf8");

  // A good pair: the processor compiles it and reports nothing.
  const quiet = await engineErrorsWith({
    "faust-reverb.wasm": wasm,
    "faust-reverb.json": json,
  });
  assert.deepEqual(quiet, [], `the engine reported ${quiet.join(" | ")}`);

  // A corrupt one: the bytes still travel and the processor's compile refuses
  // them, which is reported rather than thrown into the audio thread. This is
  // what proves the message reached `StudioFaustHost.compileModules` at all.
  const corrupt = Uint8Array.from(wasm);
  corrupt[0] = 0x00;
  corrupt[1] = 0x00;
  corrupt[2] = 0x00;
  corrupt[3] = 0x00;
  const reported = await engineErrorsWith({
    "faust-reverb.wasm": corrupt,
    "faust-reverb.json": json,
  });
  assert.ok(reported.length > 0, "a corrupt effect has to be reported, not swallowed");
  assert.match(reported.join(" | "), /reverb/, "the report has to name the effect");
});