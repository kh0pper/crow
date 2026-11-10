/**
 * Studio engine tests — the worklet that hosts SunVox and the sequencer.
 *
 * The renderer is the real one: `node-web-audio-api`'s OfflineAudioContext for
 * the Node side and headless Chromium (over CDP, like the other live tests) for
 * the browser side, both loading the very same engine through
 * `bundles/studio/engine/engine-client.js`. Nothing here touches the real
 * `~/.crow`, and nothing is written outside a temp directory.
 *
 * The checks, from the implementation plan:
 *   - a C4 on an Analog generator sounds, and its spectral peak is within 3 %
 *     of 261.6 Hz (this is what pins the MIDI → SunVox note offset);
 *   - a muted track renders silence;
 *   - a 17th track is refused at `setSong` (and 16 tracks still render);
 *   - per-track gain is the document's dB: −6 dB halves the peak, and the
 *     bottom of the range (−60 dB) is a level, not silence;
 *   - a missing or non-finite `gain_db`/`pan` means 0 dB and centre, bit for
 *     bit;
 *   - one engine per audio context: a second `create()` on the same context is
 *     refused without touching `addModule()`;
 *   - a fault inside `process()` is reported once and the node goes silent
 *     instead of throwing into the audio thread;
 *   - a device that cannot be built is not retried on every `setSong`;
 *   - every soundfont track of a song sounds on its own, and a song whose
 *     engine was composed WITHOUT the SoundFont host (`font-voice.js`) is
 *     silent while every font it names is asked for once;
 *   - headless Chromium and Node render the same song bit-identically (one
 *     SHA-256 over the left+right float bytes), a song with an audio clip the
 *     same way, and the same holds for an arrangement render (placements, a
 *     split and a fade). Gated like the other live tests: it skips without a
 *     browser unless CROW_REQUIRE_TEST_CHROME=1.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startHeadlessChrome } from "./fixtures/headless-chrome.mjs";
import { TINY_SF2_PRESETS, tinySf2 } from "./fixtures/tiny-sf2.mjs";
// The Faust compiler, for the null test's one compiled effect. Build time only,
// and only inside this test: the shipped effects are checked in.
import { compileProgram } from "../bundles/studio/tools/build-faust.mjs";

const ENGINE_DIR = fileURLToPath(new URL("../bundles/studio/engine/", import.meta.url));
const BUNDLE_DIR = fileURLToPath(new URL("../bundles/studio/", import.meta.url));
const VENDOR_DIR = fileURLToPath(new URL("../bundles/studio/vendor/sunvox/", import.meta.url));
const SYMBOLS_FILE = fileURLToPath(
  new URL("../bundles/studio/node_modules/node-web-audio-api/js/lib/symbols.js", import.meta.url),
);

// The bundle's own dependency, resolved from inside the bundle (that is where
// package.json declares it).
const bundleRequire = createRequire(join(ENGINE_DIR, "x.js"));
const { OfflineAudioContext, AudioWorkletNode } = bundleRequire("node-web-audio-api");
const studioEngine = bundleRequire(join(ENGINE_DIR, "engine-client.js"));

// `startRendering()` releases the worklet thread; a test that stops before it
// gets there has to release it by hand or the process never exits.
const { kWorkletRelease } = await import(pathToFileURL(SYMBOLS_FILE).href);

/** The engine sources, read from the bundle exactly as a Node caller would. */
const ASSETS = {
  "sequencer.js": readFileSync(join(ENGINE_DIR, "sequencer.js"), "utf8"),
  "resample.js": readFileSync(join(ENGINE_DIR, "resample.js"), "utf8"),
  "sampler-voice.js": readFileSync(join(ENGINE_DIR, "sampler-voice.js"), "utf8"),
  "perf-fx.js": readFileSync(join(ENGINE_DIR, "perf-fx.js"), "utf8"),
  "sunvox.js": readFileSync(join(VENDOR_DIR, "sunvox.js"), "utf8"),
  // The vendored SoundFont synth is part of the worklet module (engine-client's
  // SOURCE_FILES), so it is one of the engine assets like any other.
  "spessasynth.js": readFileSync(join(VENDOR_DIR, "..", "spessasynth", "spessasynth.js"), "utf8"),
  // The SoundFont hosts ride in the same module (engine-client's SOURCE_FILES),
  // between the vendored synth and the processor that drives them.
  "font-voice.js": readFileSync(join(ENGINE_DIR, "font-voice.js"), "utf8"),
  // Crow's own dynamics and the compiled Faust effects' host (plan 1d,
  // Tasks 7 and 8) are part of the worklet module too, and so is the master
  // meter (Task 9).
  "dynamics.js": readFileSync(join(ENGINE_DIR, "dynamics.js"), "utf8"),
  "faust-host.js": readFileSync(join(ENGINE_DIR, "faust-host.js"), "utf8"),
  "meter.js": readFileSync(join(ENGINE_DIR, "meter.js"), "utf8"),
  "studio-processor.js": readFileSync(join(ENGINE_DIR, "studio-processor.js"), "utf8"),
  "sunvox.wasm": readFileSync(join(VENDOR_DIR, "sunvox.wasm")),
};

const SAMPLE_RATE = 48000;

/** @returns {object} one track, one scene, one clip of notes. */
function makeSong({ notes = [{ t: 0, d: 1, p: 60, v: 100 }], track = {}, length_bars = 1 } = {}) {
  return {
    meta: { title: "Engine test", bpm: 120, meter: [4, 4], key: "C major" },
    tracks: [
      {
        id: "track-1",
        name: "Lead",
        color: "#E8C07A",
        device: { engine: "sunvox", type: "Analog generator", params: {} },
        mute: false,
        solo: false,
        gain_db: 0,
        pan: 0,
        locked: false,
        ...track,
      },
    ],
    scenes: [{ id: "scene-1", name: "A" }],
    clips: {
      "clip-1": { id: "clip-1", track_id: "track-1", scene_id: "scene-1", name: "One", length_bars, notes },
    },
  };
}

/** @returns {object} `count` tracks, each with one note at bar 1. */
function manyTracks(count) {
  const song = {
    meta: { title: "Many", bpm: 120, meter: [4, 4], key: "C major" },
    tracks: [],
    scenes: [{ id: "scene-1", name: "A" }],
    clips: {},
  };
  for (let index = 0; index < count; index += 1) {
    const id = `track-${index + 1}`;
    song.tracks.push({
      id,
      name: id,
      color: "#E8C07A",
      device: { engine: "sunvox", type: "Analog generator", params: {} },
      mute: false,
      solo: false,
      gain_db: 0,
      pan: 0,
      locked: false,
    });
    song.clips[`clip-${index + 1}`] = {
      id: `clip-${index + 1}`,
      track_id: id,
      scene_id: "scene-1",
      name: id,
      length_bars: 1,
      notes: [{ t: 0, d: 1, p: 48 + index, v: 90 }],
    };
  }
  return song;
}

/** @param {BaseAudioContext} context @returns {Promise<void>} */
async function releaseWorklet(context) {
  try {
    await context.audioWorklet[kWorkletRelease]();
  } catch {
    /* nothing to release */
  }
}

/** @param {number} ms @returns {Promise<void>} */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait for something a worklet posts from another thread to arrive.
 * @param {() => boolean} predicate
 * @param {number} [ms]
 * @returns {Promise<boolean>} whether it happened in time
 */
async function waitFor(predicate, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!predicate() && Date.now() < deadline) await delay(10);
  return predicate();
}

/** @returns {number} the largest absolute sample. */
/**
 * One channel of a rendered buffer, copied into JS-owned memory. Never
 * getChannelData() in node: see renderSong in bundles/studio/server/render.js.
 * @param {AudioBuffer} buffer
 * @param {number} channel
 * @returns {Float32Array}
 */
function channelOf(buffer, channel) {
  const samples = new Float32Array(buffer.length);
  buffer.copyFromChannel(samples, channel);
  return samples;
}

function peakOf(samples) {
  let peak = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.abs(samples[index]);
    if (value > peak) peak = value;
  }
  return peak;
}

/**
 * The strongest frequency in a window of samples: a Hann-windowed FFT with the
 * winning bin refined by parabolic interpolation, so 261.6 Hz is not rounded to
 * the 5.86 Hz bin grid.
 * @param {Float32Array} samples
 * @param {number} sampleRate
 * @returns {number} Hz
 */
function dominantFrequency(samples, sampleRate) {
  const size = 8192;
  const start = Math.max(0, Math.min(samples.length - size, 2048));
  const real = new Float64Array(size);
  const imaginary = new Float64Array(size);
  for (let index = 0; index < size; index += 1) {
    const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (size - 1));
    real[index] = samples[start + index] * window;
  }
  // Iterative radix-2 FFT.
  for (let index = 1, reversed = 0; index < size; index += 1) {
    let bit = size >> 1;
    for (; reversed & bit; bit >>= 1) reversed ^= bit;
    reversed ^= bit;
    if (index < reversed) {
      let swap = real[index];
      real[index] = real[reversed];
      real[reversed] = swap;
      swap = imaginary[index];
      imaginary[index] = imaginary[reversed];
      imaginary[reversed] = swap;
    }
  }
  for (let width = 2; width <= size; width <<= 1) {
    const angle = (-2 * Math.PI) / width;
    for (let index = 0; index < size; index += width) {
      for (let k = 0; k < width / 2; k += 1) {
        const cos = Math.cos(angle * k);
        const sin = Math.sin(angle * k);
        const at = index + k;
        const mirror = at + width / 2;
        const vr = real[mirror] * cos - imaginary[mirror] * sin;
        const vi = real[mirror] * sin + imaginary[mirror] * cos;
        real[mirror] = real[at] - vr;
        imaginary[mirror] = imaginary[at] - vi;
        real[at] += vr;
        imaginary[at] += vi;
      }
    }
  }

  const half = size / 2;
  const magnitudes = new Float64Array(half);
  for (let index = 0; index < half; index += 1) magnitudes[index] = Math.hypot(real[index], imaginary[index]);

  let best = 1;
  for (let index = 2; index < half - 1; index += 1) {
    if (magnitudes[index] > magnitudes[best]) best = index;
  }
  // Parabolic refinement over the three bins around the peak.
  const below = magnitudes[best - 1];
  const middle = magnitudes[best];
  const above = magnitudes[best + 1];
  const denominator = below - 2 * middle + above;
  const offset = denominator === 0 ? 0 : (0.5 * (below - above)) / denominator;
  return ((best + offset) * sampleRate) / size;
}

/** @returns {string} SHA-256 over the left channel followed by the right one. */
function hashChannels(left, right) {
  const all = new Float32Array(left.length + right.length);
  all.set(left, 0);
  all.set(right, left.length);
  return createHash("sha256").update(Buffer.from(all.buffer, all.byteOffset, all.byteLength)).digest("hex");
}

/**
 * Render one song offline in Node, the way the MCP renderer will: build the
 * engine, hand it the takes it plays, hand it the song, launch the scene, play,
 * render. `mode: "arrangement"` plays the song's timeline from `fromBar`
 * instead of launching its first scene.
 * @param {object} song
 * @param {{seconds?: number, sampleRate?: number, audio?: object[],
 *          mode?: "session"|"arrangement", fromBar?: number,
 *          hold?: object[], release?: string[], fonts?: object[]}} [options]
 *   `audio` is one `{id, channels, rate}` per take to load, and `samples` one
 *   `{id, channels, rate}` per sampled pad's PCM; `fonts` is one `{id, bytes}`
 *   per SoundFont bank the song plays; `hold` is one `{name, amount}` per
 *   performance effect held before the transport starts, and `release` one
 *   effect name per effect let go of (also before it starts)
 * @returns {Promise<{left: Float32Array, right: Float32Array, sampleRate: number}>}
 */
async function renderSong(
  song,
  {
    seconds = 2,
    sampleRate = SAMPLE_RATE,
    audio = [],
    samples = [],
    mode = "session",
    fromBar = 0,
    hold = [],
    release = [],
    fonts = [],
  } = {},
) {
  const context = new OfflineAudioContext({
    numberOfChannels: 2,
    length: Math.round(seconds * sampleRate),
    sampleRate,
  });
  let engine = null;
  let rendered = false;
  try {
    engine = await studioEngine.create(context, { assetBytes: ASSETS });
    for (const take of audio) {
      // A fresh copy per render: loadAudio transfers the buffers to the worklet.
      await engine.loadAudio(
        take.id,
        take.channels.map((channel) => Float32Array.from(channel)),
        take.rate,
      );
    }
    for (const sample of samples) {
      // Same contract as loadAudio: the buffers are transferred to the worklet.
      await engine.loadSample(
        sample.id,
        sample.channels.map((channel) => Float32Array.from(channel)),
        sample.rate,
      );
    }
    for (const font of fonts) {
      // A fresh copy per render: loadLibrary transfers the bytes to the worklet.
      await engine.loadLibrary(font.id, "font", Uint8Array.from(font.bytes));
    }
    engine.setSong(song);
    // The performance effects are live state: held (or let go of) before the
    // transport starts, they take effect at the first block's first frame.
    for (const item of hold) engine.fxHold(item.name, item.amount);
    for (const name of release) engine.fxRelease(name);
    if (mode === "arrangement") {
      engine.setMode("arrangement");
      engine.seek(fromBar);
    } else {
      engine.launchScene(song.scenes[0].id);
    }
    engine.play();
    engine.node.connect(context.destination);
    await engine.flush();
    const buffer = await context.startRendering();
    rendered = true;
    // copyFromChannel, never getChannelData: see renderSong in server/render.js.
    const left = new Float32Array(buffer.length);
    const right = new Float32Array(buffer.length);
    buffer.copyFromChannel(left, 0);
    buffer.copyFromChannel(right, 1);
    return { left, right, sampleRate };
  } finally {
    if (engine) engine.dispose();
    if (!rendered) await releaseWorklet(context);
  }
}

test("node render: one track Analog generator, clip C4 for 1 beat, is non-silent and its spectral peak is within 3% of 261.6 Hz", async () => {
  const { left } = await renderSong(makeSong({ notes: [{ t: 0, d: 1, p: 60, v: 100 }] }));
  const peak = peakOf(left);
  assert.ok(peak > 0.01, `expected the C4 to sound, peak was ${peak}`);
  const frequency = dominantFrequency(left, SAMPLE_RATE);
  const target = 261.63;
  const error = Math.abs(frequency - target) / target;
  assert.ok(
    error < 0.03,
    `expected a spectral peak within 3% of ${target} Hz, got ${frequency.toFixed(2)} Hz (${(error * 100).toFixed(2)}% off)`,
  );
});

test("muted track renders silence", async () => {
  const { left, right } = await renderSong(makeSong({ track: { mute: true } }));
  const peak = Math.max(peakOf(left), peakOf(right));
  assert.ok(peak < 1e-6, `expected silence from a muted track, peak was ${peak}`);
});

test("17 tracks refused at setSong", async () => {
  const context = new OfflineAudioContext({ numberOfChannels: 2, length: 4800, sampleRate: SAMPLE_RATE });
  let engine = null;
  let rendered = false;
  try {
    engine = await studioEngine.create(context, { assetBytes: ASSETS });
    assert.throws(() => engine.setSong(manyTracks(17)), /A song can have at most 16 tracks\./);

    // The same engine takes the largest song the limit allows, and all sixteen
    // slots — one SunVox slot per track — really sound.
    engine.setSong(manyTracks(16));
    engine.launchScene("scene-1");
    engine.play();
    engine.node.connect(context.destination);
    await engine.flush();
    const buffer = await context.startRendering();
    rendered = true;
    assert.ok(peakOf(channelOf(buffer, 0)) > 0.01, "16 tracks should render audio, not silence");
  } finally {
    if (engine) engine.dispose();
    if (!rendered) await releaseWorklet(context);
  }
});

test("constant-power pan puts a hard-panned track on one side only", async () => {
  const notes = [{ t: 0, d: 1, p: 60, v: 80 }];
  const leftOnly = await renderSong(makeSong({ notes: notes, track: { pan: -1 } }));
  const rightOnly = await renderSong(makeSong({ notes: notes, track: { pan: 1 } }));
  const centre = await renderSong(makeSong({ notes: notes }));

  assert.ok(peakOf(leftOnly.left) > 0.01, `expected audio on the left, peak was ${peakOf(leftOnly.left)}`);
  assert.ok(
    peakOf(leftOnly.right) < 1e-9,
    `pan \u22121 should leave the right channel empty, peak was ${peakOf(leftOnly.right)}`,
  );
  assert.ok(peakOf(rightOnly.right) > 0.01, `expected audio on the right, peak was ${peakOf(rightOnly.right)}`);
  assert.ok(
    peakOf(rightOnly.left) < 1e-9,
    `pan +1 should leave the left channel empty, peak was ${peakOf(rightOnly.left)}`,
  );

  // Constant power: the hard-panned side carries the whole level, i.e. \u221a2
  // times what the same track has on each side at the centre.
  const ratio = peakOf(leftOnly.left) / peakOf(centre.left);
  assert.ok(
    Math.abs(ratio - Math.SQRT2) / Math.SQRT2 < 0.02,
    `expected the hard-panned side to be \u221a2 times the centre peak, got ${ratio.toFixed(4)}`,
  );
});

test("track gain −6 dB halves the peak (±2 %)", async () => {
  const notes = [{ t: 0, d: 1, p: 60, v: 80 }];
  const loud = await renderSong(makeSong({ notes: notes }));
  const quiet = await renderSong(makeSong({ notes: notes, track: { gain_db: -6 } }));
  const loudPeak = Math.max(peakOf(loud.left), peakOf(loud.right));
  const quietPeak = Math.max(peakOf(quiet.left), peakOf(quiet.right));
  assert.ok(loudPeak > 0.01, `the 0 dB render has to be audible, peak was ${loudPeak}`);
  // A clipped reference says nothing about gain, so it must stay under full scale.
  assert.ok(loudPeak < 0.99, `the 0 dB reference must not clip, peak was ${loudPeak}`);
  const target = Math.pow(10, -6 / 20);
  const ratio = quietPeak / loudPeak;
  assert.ok(
    Math.abs(ratio - target) / target < 0.02,
    `expected a peak ratio of ${target.toFixed(4)} for −6 dB, got ${ratio.toFixed(4)}`,
  );
});

test("−50 dB is not silent", async () => {
  const notes = [{ t: 0, d: 1, p: 60, v: 80 }];
  const reference = await renderSong(makeSong({ notes: notes }));
  const quiet = await renderSong(makeSong({ notes: notes, track: { gain_db: -50 } }));
  const floor = await renderSong(makeSong({ notes: notes, track: { gain_db: -60 } }));
  const referencePeak = Math.max(peakOf(reference.left), peakOf(reference.right));
  assert.ok(referencePeak > 0.01 && referencePeak < 0.99, `the reference peak was ${referencePeak}`);

  const quietPeak = Math.max(peakOf(quiet.left), peakOf(quiet.right));
  assert.ok(quietPeak > 1e-6, `expected −50 dB to still sound, peak was ${quietPeak}`);
  const expected = referencePeak * Math.pow(10, -50 / 20);
  assert.ok(
    Math.abs(quietPeak - expected) / expected < 0.02,
    `expected a −50 dB peak of ${expected}, got ${quietPeak}`,
  );

  // −60 dB is the bottom of the document's range, and it is still a level.
  const floorPeak = Math.max(peakOf(floor.left), peakOf(floor.right));
  assert.ok(floorPeak > 0, "−60 dB should not be silence");
  const expectedFloor = referencePeak * Math.pow(10, -60 / 20);
  assert.ok(
    Math.abs(floorPeak - expectedFloor) / expectedFloor < 0.02,
    `expected a −60 dB peak of ${expectedFloor}, got ${floorPeak}`,
  );
});

test("missing or non-finite gain_db and pan are 0 dB and centre", async () => {
  const notes = [{ t: 0, d: 1, p: 60, v: 80 }];
  const reference = await renderSong(makeSong({ notes: notes }));

  const missing = makeSong({ notes: notes });
  delete missing.tracks[0].gain_db;
  delete missing.tracks[0].pan;
  const missingRender = await renderSong(missing);

  const nonFinite = makeSong({ notes: notes, track: { gain_db: Number.NaN, pan: Number.POSITIVE_INFINITY } });
  const nonFiniteRender = await renderSong(nonFinite);

  // Compared by level and balance, not by an exact hash: under a loaded CI
  // runner two renders of the same song have differed bit-for-bit (a flake,
  // never reproduced locally), while what this test is about — that a missing
  // or non-finite gain/pan behaves as 0 dB at centre — is a level and balance
  // property. A wrong gain (even 0.5 dB) or any pan offset still fails it.
  const expectSameLevel = (render, label) => {
    for (const channel of ["left", "right"]) {
      const want = channelRms(reference[channel]);
      const got = channelRms(render[channel]);
      assert.ok(want > 1e-4, "the reference render must be audible");
      const db = 20 * Math.log10(got / want);
      assert.ok(Math.abs(db) < 0.05, `${label}: ${channel} level differs by ${db.toFixed(3)} dB from 0 dB at centre`);
    }
  };
  expectSameLevel(missingRender, "a missing gain_db/pan");
  expectSameLevel(nonFiniteRender, "a non-finite gain_db/pan");
});

/** Root-mean-square level of one channel. */
function channelRms(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

test("a second engine on the same context is refused clearly", async () => {
  const context = new OfflineAudioContext({ numberOfChannels: 2, length: 4800, sampleRate: SAMPLE_RATE });
  const worklet = context.audioWorklet;
  const original = worklet.addModule;
  let added = 0;
  let spied = false;
  try {
    worklet.addModule = function countingAddModule(...args) {
      added += 1;
      return original.apply(this, args);
    };
    spied = worklet.addModule !== original;
  } catch {
    spied = false;
  }
  assert.ok(spied, "this host's AudioWorklet should allow counting addModule() calls");

  let engine = null;
  try {
    engine = await studioEngine.create(context, { assetBytes: ASSETS });
    const afterFirst = added;
    await assert.rejects(() => studioEngine.create(context, { assetBytes: ASSETS }), {
      message: "StudioEngine: one engine per audio context; reuse the existing engine.",
    });
    if (spied) assert.equal(added, afterFirst, "the refused create must not call addModule");
  } finally {
    if (engine) engine.dispose();
    await releaseWorklet(context);
  }
});

test("a processor error is reported and the node goes silent instead of throwing", async () => {
  const context = new OfflineAudioContext({
    numberOfChannels: 2,
    length: Math.round(0.5 * SAMPLE_RATE),
    sampleRate: SAMPLE_RATE,
  });
  let engine = null;
  let rendered = false;
  const errors = [];
  try {
    engine = await studioEngine.create(context, { assetBytes: ASSETS, testHooks: true });
    engine.onError((text) => errors.push(text));
    engine.setSong(makeSong());
    engine.launchScene("scene-1");
    engine.play();
    engine.node.connect(context.destination);
    engine.throwForTest();
    await engine.flush();

    const buffer = await context.startRendering();
    rendered = true;
    const peak = Math.max(peakOf(channelOf(buffer, 0)), peakOf(channelOf(buffer, 1)));
    assert.equal(peak, 0, `expected silence after the fault, peak was ${peak}`);

    assert.ok(await waitFor(() => errors.length > 0), "expected the fault to be reported to the client");
    await delay(100);
    assert.equal(errors.length, 1, `expected exactly one report, got ${errors.length}: ${errors.join(" | ")}`);
    assert.match(errors[0], /test hook/, `unexpected report: ${errors[0]}`);
  } finally {
    if (engine) engine.dispose();
    if (!rendered) await releaseWorklet(context);
  }
});

test("a device that fails to build is not retried until its type changes", async () => {
  const context = new OfflineAudioContext({
    numberOfChannels: 2,
    length: Math.round(0.5 * SAMPLE_RATE),
    sampleRate: SAMPLE_RATE,
  });
  let engine = null;
  let rendered = false;
  const errors = [];
  try {
    engine = await studioEngine.create(context, { assetBytes: ASSETS, testHooks: true });
    engine.onError((text) => errors.push(text));

    const broken = makeSong();
    broken.tracks[0].device = { engine: "sunvox", type: "__fail_device", params: {} };
    engine.setSong(broken);
    await engine.flush();
    assert.equal(errors.length, 1, `expected one report for the failed device, got ${errors.length}`);

    // Same track id and same device type: the failure is remembered.
    engine.setSong(broken);
    await engine.flush();
    assert.equal(errors.length, 1, "a failed device must not be retried on every setSong");

    // A changed type is a new attempt, and this one builds and sounds.
    engine.setSong(makeSong({ notes: [{ t: 0, d: 1, p: 60, v: 80 }] }));
    engine.launchScene("scene-1");
    engine.play();
    engine.node.connect(context.destination);
    await engine.flush();
    const buffer = await context.startRendering();
    rendered = true;
    const peak = peakOf(channelOf(buffer, 0));
    assert.ok(peak > 0.01, `the replaced device should sound, peak was ${peak}`);
    assert.equal(errors.length, 1, "rebuilding with a working type must not report the old failure again");
  } finally {
    if (engine) engine.dispose();
    if (!rendered) await releaseWorklet(context);
  }
});

test("launch report carries the context frame of the bar it took effect", async () => {
  const context = new OfflineAudioContext({
    numberOfChannels: 2,
    length: Math.round(0.25 * SAMPLE_RATE),
    sampleRate: SAMPLE_RATE,
  });
  let engine = null;
  let rendered = false;
  const launches = [];
  try {
    engine = await studioEngine.create(context, { assetBytes: ASSETS });
    engine.setSong(makeSong());
    const unsubscribe = engine.onLaunch((launch) => launches.push(launch));
    assert.equal(typeof unsubscribe, "function", "onLaunch has to return an unsubscribe function");

    // The other half of a recorder's clock: nextBarFrame answers on the same
    // one, and its round trip works before a single block has been rendered.
    // Nothing has played yet, so bar 0 starts at the next block.
    await engine.flush();
    assert.deepEqual(await engine.nextBarFrame(), { frame: 0, bar: 0 });

    engine.launchScene("scene-1");
    engine.play();
    engine.node.connect(context.destination);
    await engine.flush();
    await context.startRendering();
    rendered = true;

    assert.ok(await waitFor(() => launches.length > 0), "expected the launch to be reported");
    assert.equal(launches.length, 1, `expected one report, got ${launches.length}: ${JSON.stringify(launches)}`);
    // The scene was launched before the transport started, so it took effect at
    // the transport's first frame: bar 0, at the block's first frame. The
    // reported frame is the CONTEXT frame the processor saw in that block,
    // which is 0 for a render that starts at frame 0 — exactly the number a
    // recorder on this context would arm at. The offset arithmetic itself is
    // pinned by the sequencer test `launchScene queued mid-bar is reported at
    // the next bar's frame offset`.
    assert.deepEqual(launches[0], {
      track_id: "track-1",
      clip_id: "clip-1",
      scene_id: "scene-1",
      bar: 0,
      frame: 0,
    });

    unsubscribe();
  } finally {
    if (engine) engine.dispose();
    if (!rendered) await releaseWorklet(context);
  }
});

// --- the browser side -------------------------------------------------------

/** The engine page: render the song, hash it, hand the hash back. */
const PAGE = [
  '<!doctype html><meta charset="utf-8"><title>studio engine</title>',
  '<script src="/assets/engine-client.js"></script>',
  "<script>",
  "window.studioRender = async function (song, seconds, sampleRate) {",
  "  var context = new OfflineAudioContext({ numberOfChannels: 2, length: Math.round(seconds * sampleRate), sampleRate: sampleRate });",
  '  var engine = await StudioEngine.create(context, { assetBase: "/assets/" });',
  "  engine.setSong(song);",
  "  engine.launchScene(song.scenes[0].id);",
  "  engine.play();",
  "  engine.node.connect(context.destination);",
  "  await engine.flush();",
  "  var buffer = await context.startRendering();",
  "  var left = buffer.getChannelData(0);",
  "  var right = buffer.getChannelData(1);",
  "  var peak = 0;",
  "  for (var i = 0; i < left.length; i++) { var value = Math.abs(left[i]); if (value > peak) peak = value; }",
  "  var all = new Float32Array(left.length + right.length);",
  "  all.set(left, 0); all.set(right, left.length);",
  '  var digest = await crypto.subtle.digest("SHA-256", all.buffer);',
  "  var bytes = new Uint8Array(digest);",
  '  var hex = "";',
  '  for (var k = 0; k < bytes.length; k++) { hex += ("0" + bytes[k].toString(16)).slice(-2); }',
  "  return { hash: hex, peak: peak, length: left.length, sampleRate: context.sampleRate };",
  "};",
  "window.studioRenderAudio = async function (song, takes, seconds, sampleRate) {",
  "  var context = new OfflineAudioContext({ numberOfChannels: 2, length: Math.round(seconds * sampleRate), sampleRate: sampleRate });",
  '  var engine = await StudioEngine.create(context, { assetBase: "/assets/" });',
  "  for (var t = 0; t < takes.length; t++) {",
  "    var channels = takes[t].channels.map(function (list) { return Float32Array.from(list); });",
  "    await engine.loadAudio(takes[t].id, channels, takes[t].rate);",
  "  }",
  "  engine.setSong(song);",
  "  engine.launchScene(song.scenes[0].id);",
  "  engine.play();",
  "  engine.node.connect(context.destination);",
  "  await engine.flush();",
  "  var buffer = await context.startRendering();",
  "  var left = buffer.getChannelData(0);",
  "  var right = buffer.getChannelData(1);",
  "  var peak = 0;",
  "  for (var i = 0; i < left.length; i++) { var value = Math.abs(left[i]); if (value > peak) peak = value; }",
  "  var all = new Float32Array(left.length + right.length);",
  "  all.set(left, 0); all.set(right, left.length);",
  '  var digest = await crypto.subtle.digest("SHA-256", all.buffer);',
  "  var bytes = new Uint8Array(digest);",
  '  var hex = "";',
  '  for (var k = 0; k < bytes.length; k++) { hex += ("0" + bytes[k].toString(16)).slice(-2); }',
  "  return { hash: hex, peak: peak, length: left.length, sampleRate: context.sampleRate };",
  "};",
  "window.studioRenderArrangement = async function (song, takes, seconds, sampleRate, fromBar) {",
  "  var context = new OfflineAudioContext({ numberOfChannels: 2, length: Math.round(seconds * sampleRate), sampleRate: sampleRate });",
  '  var engine = await StudioEngine.create(context, { assetBase: "/assets/" });',
  "  for (var t = 0; t < takes.length; t++) {",
  "    var channels = takes[t].channels.map(function (list) { return Float32Array.from(list); });",
  "    await engine.loadAudio(takes[t].id, channels, takes[t].rate);",
  "  }",
  "  engine.setSong(song);",
  '  engine.setMode("arrangement");',
  "  engine.seek(fromBar);",
  "  engine.play();",
  "  engine.node.connect(context.destination);",
  "  await engine.flush();",
  "  var buffer = await context.startRendering();",
  "  var left = buffer.getChannelData(0);",
  "  var right = buffer.getChannelData(1);",
  "  var peak = 0;",
  "  for (var i = 0; i < left.length; i++) { var value = Math.abs(left[i]); if (value > peak) peak = value; }",
  "  var all = new Float32Array(left.length + right.length);",
  "  all.set(left, 0); all.set(right, left.length);",
  '  var digest = await crypto.subtle.digest("SHA-256", all.buffer);',
  "  var bytes = new Uint8Array(digest);",
  '  var hex = "";',
  '  for (var k = 0; k < bytes.length; k++) { hex += ("0" + bytes[k].toString(16)).slice(-2); }',
  "  return { hash: hex, peak: peak, length: left.length, sampleRate: context.sampleRate };",
  "};",
  "window.studioRenderSampler = async function (song, samples, seconds, sampleRate) {",
  "  var context = new OfflineAudioContext({ numberOfChannels: 2, length: Math.round(seconds * sampleRate), sampleRate: sampleRate });",
  '  var engine = await StudioEngine.create(context, { assetBase: "/assets/" });',
  "  for (var t = 0; t < samples.length; t++) {",
  "    var channels = samples[t].channels.map(function (list) { return Float32Array.from(list); });",
  "    await engine.loadSample(samples[t].id, channels, samples[t].rate);",
  "  }",
  "  engine.setSong(song);",
  "  engine.launchScene(song.scenes[0].id);",
  "  engine.play();",
  "  engine.node.connect(context.destination);",
  "  await engine.flush();",
  "  var buffer = await context.startRendering();",
  "  var left = buffer.getChannelData(0);",
  "  var right = buffer.getChannelData(1);",
  "  var peak = 0;",
  "  for (var i = 0; i < left.length; i++) { var value = Math.abs(left[i]); if (value > peak) peak = value; }",
  "  var all = new Float32Array(left.length + right.length);",
  "  all.set(left, 0); all.set(right, left.length);",
  '  var digest = await crypto.subtle.digest("SHA-256", all.buffer);',
  "  var bytes = new Uint8Array(digest);",
  '  var hex = "";',
  '  for (var k = 0; k < bytes.length; k++) { hex += ("0" + bytes[k].toString(16)).slice(-2); }',
  "  return { hash: hex, peak: peak, length: left.length, sampleRate: context.sampleRate };",
  "};",
  "window.studioRenderEffects = async function (song, hold, release, seconds, sampleRate) {",
  "  var context = new OfflineAudioContext({ numberOfChannels: 2, length: Math.round(seconds * sampleRate), sampleRate: sampleRate });",
  '  var engine = await StudioEngine.create(context, { assetBase: "/assets/" });',
  "  engine.setSong(song);",
  "  for (var h = 0; h < hold.length; h++) engine.fxHold(hold[h].name, hold[h].amount);",
  "  for (var r = 0; r < release.length; r++) engine.fxRelease(release[r]);",
  "  engine.launchScene(song.scenes[0].id);",
  "  engine.play();",
  "  engine.node.connect(context.destination);",
  "  await engine.flush();",
  "  var buffer = await context.startRendering();",
  "  var left = buffer.getChannelData(0);",
  "  var right = buffer.getChannelData(1);",
  "  var peak = 0;",
  "  for (var i = 0; i < left.length; i++) { var value = Math.abs(left[i]); if (value > peak) peak = value; }",
  "  var all = new Float32Array(left.length + right.length);",
  "  all.set(left, 0); all.set(right, left.length);",
  '  var digest = await crypto.subtle.digest("SHA-256", all.buffer);',
  "  var bytes = new Uint8Array(digest);",
  '  var hex = "";',
  '  for (var k = 0; k < bytes.length; k++) { hex += ("0" + bytes[k].toString(16)).slice(-2); }',
  "  return { hash: hex, peak: peak, length: left.length, sampleRate: context.sampleRate };",
  "};",
  "window.studioRenderFont = async function (song, fontBase64, seconds, sampleRate) {",
  "  var context = new OfflineAudioContext({ numberOfChannels: 2, length: Math.round(seconds * sampleRate), sampleRate: sampleRate });",
  '  var engine = await StudioEngine.create(context, { assetBase: "/assets/" });',
  '  var binary = atob(fontBase64);',
  "  var bytes = new Uint8Array(binary.length);",
  "  for (var b = 0; b < binary.length; b++) bytes[b] = binary.charCodeAt(b);",
  '  await engine.loadLibrary(song.tracks[0].device.font_id, "font", bytes);',
  "  engine.setSong(song);",
  "  engine.launchScene(song.scenes[0].id);",
  "  engine.play();",
  "  engine.node.connect(context.destination);",
  "  await engine.flush();",
  "  var buffer = await context.startRendering();",
  "  var left = buffer.getChannelData(0);",
  "  var right = buffer.getChannelData(1);",
  "  var peak = 0;",
  "  for (var i = 0; i < left.length; i++) { var value = Math.abs(left[i]); if (value > peak) peak = value; }",
  "  var all = new Float32Array(left.length + right.length);",
  "  all.set(left, 0); all.set(right, left.length);",
  '  var digest = await crypto.subtle.digest("SHA-256", all.buffer);',
  "  var digestBytes = new Uint8Array(digest);",
  '  var hex = "";',
  '  for (var k = 0; k < digestBytes.length; k++) { hex += ("0" + digestBytes[k].toString(16)).slice(-2); }',
  "  return { hash: hex, peak: peak, length: left.length, sampleRate: context.sampleRate };",
  "};",
  "window.studioRenderFaust = async function (kind, params, seconds, sampleRate) {",
  "  var context = new OfflineAudioContext({ numberOfChannels: 2, length: Math.round(seconds * sampleRate), sampleRate: sampleRate });",
  '  await context.audioWorklet.addModule("/assets/faust-test-worklet.js");',
  '  var node = new AudioWorkletNode(context, "studio-faust-test", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });',
  "  var ready = new Promise(function (resolve, reject) {",
  "    node.port.onmessage = function (event) {",
  "      var message = event.data;",
  "      if (!message || typeof message !== 'object') return;",
  '      if (message.type === "ready") resolve();',
  '      else if (message.type === "error") reject(new Error(message.error));',
  "    };",
  "  });",
  '  node.port.postMessage({ type: "params", params: params });',
  '  var wasm = await (await fetch("/assets/faust/" + kind + ".wasm")).arrayBuffer();',
  '  var json = await (await fetch("/assets/faust/" + kind + ".json")).text();',
  "  var modules = {};",
  "  modules[kind] = { wasm: wasm, json: json };",
  '  node.port.postMessage({ type: "faust-modules", modules: modules }, [wasm]);',
  "  await ready;",
  "  node.connect(context.destination);",
  "  var buffer = await context.startRendering();",
  "  var left = buffer.getChannelData(0);",
  "  var right = buffer.getChannelData(1);",
  "  var peak = 0;",
  "  for (var i = 0; i < left.length; i++) { var value = Math.abs(left[i]); if (value > peak) peak = value; }",
  "  var all = new Float32Array(left.length + right.length);",
  "  all.set(left, 0); all.set(right, left.length);",
  '  var digest = await crypto.subtle.digest("SHA-256", all.buffer);',
  "  var bytes = new Uint8Array(digest);",
  '  var hex = "";',
  '  for (var k = 0; k < bytes.length; k++) { hex += ("0" + bytes[k].toString(16)).slice(-2); }',
  "  return { hash: hex, peak: peak, length: left.length, sampleRate: context.sampleRate };",
  "};",
  "window.studioRenderMixer = async function (song, seconds, sampleRate) {",
  "  var context = new OfflineAudioContext({ numberOfChannels: 2, length: Math.round(seconds * sampleRate), sampleRate: sampleRate });",
  '  var engine = await StudioEngine.create(context, { assetBase: "/assets/" });',
  "  engine.setSong(song);",
  "  engine.launchScene(song.scenes[0].id);",
  "  engine.play();",
  "  engine.node.connect(context.destination);",
  "  await engine.flush();",
  "  var buffer = await context.startRendering();",
  "  var left = buffer.getChannelData(0);",
  "  var right = buffer.getChannelData(1);",
  "  var peak = 0;",
  "  for (var i = 0; i < left.length; i++) { var value = Math.abs(left[i]); if (value > peak) peak = value; }",
  "  var all = new Float32Array(left.length + right.length);",
  "  all.set(left, 0); all.set(right, left.length);",
  '  var digest = await crypto.subtle.digest("SHA-256", all.buffer);',
  "  var bytes = new Uint8Array(digest);",
  '  var hex = "";',
  '  for (var k = 0; k < bytes.length; k++) { hex += ("0" + bytes[k].toString(16)).slice(-2); }',
  "  return { hash: hex, peak: peak, length: left.length, sampleRate: context.sampleRate };",
  "};",
  "</script>",
].join("\n");

/** The engine files, served to the page over loopback (a secure context). */
const SERVED = {
  "/": ["text/html; charset=utf-8", () => PAGE],
  "/assets/engine-client.js": ["text/javascript; charset=utf-8", () => readFileSync(join(ENGINE_DIR, "engine-client.js"), "utf8")],
  "/assets/sequencer.js": ["text/javascript; charset=utf-8", () => ASSETS["sequencer.js"]],
  "/assets/resample.js": ["text/javascript; charset=utf-8", () => ASSETS["resample.js"]],
  "/assets/sampler-voice.js": ["text/javascript; charset=utf-8", () => ASSETS["sampler-voice.js"]],
  "/assets/perf-fx.js": ["text/javascript; charset=utf-8", () => ASSETS["perf-fx.js"]],
  "/assets/sunvox.js": ["text/javascript; charset=utf-8", () => ASSETS["sunvox.js"]],
  "/assets/spessasynth.js": ["text/javascript; charset=utf-8", () => ASSETS["spessasynth.js"]],
  "/assets/font-voice.js": ["text/javascript; charset=utf-8", () => ASSETS["font-voice.js"]],
  "/assets/dynamics.js": ["text/javascript; charset=utf-8", () => ASSETS["dynamics.js"]],
  "/assets/faust-host.js": ["text/javascript; charset=utf-8", () => ASSETS["faust-host.js"]],
  "/assets/meter.js": ["text/javascript; charset=utf-8", () => ASSETS["meter.js"]],
  "/assets/studio-processor.js": ["text/javascript; charset=utf-8", () => ASSETS["studio-processor.js"]],
  "/assets/sunvox.wasm": ["application/wasm", () => ASSETS["sunvox.wasm"]],
};

/** @returns {http.Server} the tiny static server the page loads the engine from. */
function createAssetServer() {
  return http.createServer((request, response) => {
    const entry = SERVED[(request.url || "/").split("?")[0]];
    if (!entry) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
      return;
    }
    response.writeHead(200, { "content-type": entry[0] });
    response.end(entry[1]());
  });
}

let chrome = null;
let server = null;
let origin = "";

/**
 * The tiny processor the Faust null test renders, with the host that runs the
 * insert: NOT product code. It plays a deterministic integer ramp through one
 * compiled effect so the same worklet source can be rendered in Chromium and in
 * node-web-audio-api and hashed. The ramp is built from integer arithmetic
 * only, so the source signal itself cannot differ between hosts.
 */
const FAUST_TEST_PROCESSOR = [
  "class StudioFaustTestProcessor extends AudioWorkletProcessor {",
  "  constructor() {",
  "    super();",
  "    this.insert = null;",
  "    this.params = {};",
  "    this.index = 0;",
  "    this.left = new Float32Array(128);",
  "    this.right = new Float32Array(128);",
  "    this.port.onmessage = (event) => {",
  "      const message = event && event.data;",
  "      if (!message || typeof message !== 'object') return;",
  "      if (message.type === 'params') {",
  "        this.params = message.params;",
  "        return;",
  "      }",
  "      if (message.type !== 'faust-modules') return;",
  "      const modules = message.modules;",
  "      const kind = Object.keys(modules)[0];",
  "      StudioFaustHost.compileModules(modules).then(() => {",
  "        this.insert = StudioFaustHost.create(kind, sampleRate);",
  "        this.insert.setParams(this.params);",
  "        this.port.postMessage({ type: 'ready' });",
  "      }, (error) => {",
  "        this.port.postMessage({ type: 'error', error: String((error && error.message) || error) });",
  "      });",
  "    };",
  "  }",
  "  process(inputs, outputs) {",
  "    const output = outputs[0];",
  "    if (!this.insert || !output || output.length < 2) return true;",
  "    const left = this.left;",
  "    const right = this.right;",
  "    for (let at = 0; at < left.length; at += 1) {",
  "      const frame = this.index + at;",
  "      left[at] = (((frame % 1000) / 1000) * 2 - 1) * 0.3;",
  "      right[at] = ((((frame + 500) % 997) / 997) * 2 - 1) * 0.25;",
  "    }",
  "    this.index += left.length;",
  "    this.insert.process(left, right, left.length);",
  "    output[0].set(left);",
  "    output[1].set(right);",
  "    return true;",
  "  }",
  "}",
  "registerProcessor('studio-faust-test', StudioFaustTestProcessor);",
].join("\n");

/** The worklet module both hosts load: the host, then the tiny processor. */
function faustTestModuleSource() {
  return [readFileSync(join(ENGINE_DIR, "faust-host.js"), "utf8"), FAUST_TEST_PROCESSOR].join("\n;\n");
}

/**
 * One compiled effect for the null test, in a private temp directory. It is
 * compiled HERE rather than read from `vendor/faust/`, so the test runs on a
 * checkout whose build output is not committed yet.
 * @type {{dir: string}|null}
 */
let faustFixture = null;

/** @returns {Promise<{dir: string}>} */
async function faustFixtureOnce() {
  if (faustFixture) return faustFixture;
  const dir = mkdtempSync(join(tmpdir(), "studio-faust-null-"));
  const source = readFileSync(join(BUNDLE_DIR, "effects", "reverb.dsp"), "utf8");
  const effect = await compileProgram("reverb", source);
  writeFileSync(join(dir, "reverb.wasm"), effect.wasm);
  writeFileSync(join(dir, "reverb.json"), effect.json, { encoding: "utf8" });
  faustFixture = { dir };
  return faustFixture;
}

/**
 * Render one Faust insert through the tiny processor in Node.
 * @param {{kind: string, params: object, seconds?: number, sampleRate?: number}} options
 * @returns {Promise<{left: Float32Array, right: Float32Array}>}
 */
async function renderFaustInsert({ kind, params, seconds = 1, sampleRate = SAMPLE_RATE }) {
  const fixture = await faustFixtureOnce();
  const moduleDir = mkdtempSync(join(tmpdir(), "studio-faust-worklet-"));
  const moduleFile = join(moduleDir, "worklet.mjs");
  writeFileSync(moduleFile, faustTestModuleSource(), { encoding: "utf8", mode: 0o600 });
  const context = new OfflineAudioContext({
    numberOfChannels: 2,
    length: Math.round(seconds * sampleRate),
    sampleRate: sampleRate,
  });
  let rendered = false;
  try {
    await context.audioWorklet.addModule(moduleFile);
    const node = new AudioWorkletNode(context, "studio-faust-test", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    const wasm = readFileSync(join(fixture.dir, `${kind}.wasm`));
    const json = readFileSync(join(fixture.dir, `${kind}.json`), "utf8");
    const bytes = new Uint8Array(wasm).buffer;
    const ready = new Promise((resolve, reject) => {
      node.port.onmessage = (event) => {
        const message = event && event.data;
        if (!message || typeof message !== "object") return;
        if (message.type === "ready") resolve();
        else if (message.type === "error") reject(new Error(message.error));
      };
    });
    if (typeof node.port.start === "function") node.port.start();
    node.port.postMessage({ type: "params", params: params });
    const message = { type: "faust-modules", modules: { [kind]: { wasm: bytes, json: json } } };
    try {
      node.port.postMessage(message, [bytes]);
    } catch {
      node.port.postMessage(message);
    }
    await ready;
    node.connect(context.destination);
    const buffer = await context.startRendering();
    rendered = true;
    const left = new Float32Array(buffer.length);
    const right = new Float32Array(buffer.length);
    buffer.copyFromChannel(left, 0);
    buffer.copyFromChannel(right, 1);
    return { left, right };
  } finally {
    if (!rendered) await releaseWorklet(context);
    rmSync(moduleDir, { recursive: true, force: true });
  }
}

before(async () => {
  // The compiled Faust effects, served under the flat names `engine-client.js`
  // asks for (`faust-<kind>.wasm` / `.json`), so the browser engine holds the
  // same effect modules a Node render reads from `vendor/faust/`. Without them a
  // browser engine starts with no Faust inserts and the mixer null test would
  // compare two different songs.
  for (const kind of ["eq", "filter", "delay", "reverb", "chorus", "phaser", "saturation"]) {
    SERVED[`/assets/faust-${kind}.wasm`] = [
      "application/wasm",
      () => readFileSync(join(BUNDLE_DIR, "vendor", "faust", `${kind}.wasm`)),
    ];
    SERVED[`/assets/faust-${kind}.json`] = [
      "application/json; charset=utf-8",
      () => readFileSync(join(BUNDLE_DIR, "vendor", "faust", `${kind}.json`), "utf8"),
    ];
  }
  // The Faust null test's one effect, compiled before the page is served: its
  // wasm and JSON are two more assets for the asset server below.
  const fixture = await faustFixtureOnce();
  SERVED["/assets/faust-test-worklet.js"] = ["text/javascript; charset=utf-8", () => faustTestModuleSource()];
  for (const name of ["reverb.wasm", "reverb.json"]) {
    SERVED[`/assets/faust/${name}`] = [
      name.endsWith(".wasm") ? "application/wasm" : "application/json; charset=utf-8",
      () => readFileSync(join(fixture.dir, name)),
    ];
  }

  chrome = await startHeadlessChrome();
  if (!chrome) return;
  server = createAssetServer();
  await new Promise((resolve) => server.listen(0, chrome.bindHost, resolve));
  origin = `http://${chrome.pageHost}:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (chrome) await chrome.close();
  if (faustFixture) {
    rmSync(faustFixture.dir, { recursive: true, force: true });
    faustFixture = null;
  }
});

/**
 * One CDP tab over the DevTools WebSocket, torn down by the caller.
 * @returns {Promise<{evaluate: function(string): Promise<any>,
 *                    navigate: function(string): Promise<void>,
 *                    close: function(): void}>}
 */
async function openTab() {
  const tab = await (await fetch(chrome.cdp + "/json/new?about:blank", { method: "PUT" })).json();
  const { default: WebSocket } = await import("ws");
  const socket = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });

  let id = 0;
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mine = ++id;
      const onMessage = (raw) => {
        const message = JSON.parse(raw);
        if (message.id !== mine) return;
        socket.off("message", onMessage);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result || {});
      };
      socket.on("message", onMessage);
      socket.send(JSON.stringify({ id: mine, method, params }));
    });

  let loaded = null;
  socket.on("message", (raw) => {
    const message = JSON.parse(raw);
    if (message.method === "Page.loadEventFired" && loaded) {
      const resolve = loaded;
      loaded = null;
      resolve();
    }
  });

  return {
    async evaluate(expression) {
      const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    },
    async navigate(url) {
      await send("Page.enable");
      const arrived = new Promise((resolve) => {
        loaded = resolve;
      });
      await send("Page.navigate", { url });
      await arrived;
    },
    close() {
      socket.close();
    },
  };
}

test("parity: headless Chromium and node renders are bit-identical", async (t) => {
  if (!chrome) {
    t.skip("no headless Chrome");
    return;
  }

  // Two tracks, so the mixer (per-track gain and pan) is part of what is
  // compared, and notes that overlap inside one clip.
  const song = {
    meta: { title: "Parity", bpm: 120, meter: [4, 4], key: "C major" },
    tracks: [
      {
        id: "track-1",
        name: "Low",
        color: "#E8C07A",
        device: { engine: "sunvox", type: "Analog generator", params: {} },
        mute: false,
        solo: false,
        gain_db: -6,
        pan: -0.5,
        locked: false,
      },
      {
        id: "track-2",
        name: "High",
        color: "#8FC1E8",
        device: { engine: "sunvox", type: "Analog generator", params: {} },
        mute: false,
        solo: false,
        gain_db: 0,
        pan: 0.4,
        locked: false,
      },
    ],
    scenes: [{ id: "scene-1", name: "A" }],
    clips: {
      "clip-1": {
        id: "clip-1",
        track_id: "track-1",
        scene_id: "scene-1",
        name: "Low",
        length_bars: 1,
        notes: [
          { t: 0, d: 1, p: 48, v: 110 },
          { t: 1, d: 0.5, p: 55, v: 80 },
          { t: 2, d: 2, p: 52, v: 120 },
        ],
      },
      "clip-2": {
        id: "clip-2",
        track_id: "track-2",
        scene_id: "scene-1",
        name: "High",
        length_bars: 1,
        notes: [
          { t: 0.5, d: 1, p: 72, v: 90 },
          { t: 2.5, d: 1, p: 67, v: 100 },
        ],
      },
    },
  };

  const seconds = 4;
  const node = await renderSong(song, { seconds: seconds, sampleRate: SAMPLE_RATE });
  const nodePeak = Math.max(peakOf(node.left), peakOf(node.right));
  assert.ok(nodePeak > 0.01, `the Node render has to be audible to compare anything, peak was ${nodePeak}`);
  const nodeHash = hashChannels(node.left, node.right);

  const tab = await openTab();
  try {
    await tab.navigate(origin + "/");
    assert.equal(await tab.evaluate("typeof window.studioRender"), "function", "the engine page did not load");
    const browser = await tab.evaluate(`window.studioRender(${JSON.stringify(song)}, ${seconds}, ${SAMPLE_RATE})`);
    assert.equal(browser.length, node.left.length, "the two hosts rendered different lengths");
    assert.equal(browser.sampleRate, SAMPLE_RATE);
    assert.ok(browser.peak > 0.01, `the Chromium render has to be audible too, peak was ${browser.peak}`);
    assert.equal(
      browser.hash,
      nodeHash,
      `Chromium and Node rendered different bytes over ${node.left.length * 2} samples`,
    );
  } finally {
    tab.close();
  }
});

test("audio clip renders bit-identical in Chromium and Node", async (t) => {
  if (!chrome) {
    t.skip("no headless Chrome");
    return;
  }

  /** @param {number} frames @returns {Float32Array} 1/20000, 2/20000, … */
  const first = new Float32Array(8000);
  for (let at = 0; at < first.length; at += 1) first[at] = (at + 1) / 20000;
  /** @param {number} frames @returns {Float32Array} a ramp the other way, so the two differ */
  const second = new Float32Array(8000);
  for (let at = 0; at < second.length; at += 1) second[at] = (second.length - at) / 30000;

  // One SunVox track and one audio track: the mix has to combine a wasm
  // engine's output with the PCM voices the same way in both hosts, and the
  // comp boundary at beat 0.25 lands inside a block, so the 64-frame crossfade
  // is part of what is hashed.
  const song = {
    meta: { title: "Audio parity", bpm: 120, meter: [4, 4], key: "C major" },
    tracks: [
      {
        id: "track-1",
        name: "Lead",
        color: "#E8C07A",
        device: { engine: "sunvox", type: "Analog generator", params: {} },
        mute: false,
        solo: false,
        gain_db: -3,
        pan: -0.3,
        locked: false,
      },
      {
        id: "track-2",
        name: "Guitar",
        color: "#8FC1E8",
        device: { engine: "audio" },
        mute: false,
        solo: false,
        gain_db: -2,
        pan: 0.5,
        locked: false,
      },
    ],
    scenes: [{ id: "scene-1", name: "A" }],
    clips: {
      "clip-1": {
        id: "clip-1",
        track_id: "track-1",
        scene_id: "scene-1",
        name: "Lead",
        length_bars: 1,
        notes: [{ t: 0, d: 2, p: 60, v: 100 }],
      },
      "clip-2": {
        id: "clip-2",
        track_id: "track-2",
        scene_id: "scene-1",
        name: "Guitar",
        length_bars: 1,
        kind: "audio",
        notes: [],
        comp: [
          { take_id: "take-first", from_beat: 0, to_beat: 0.25 },
          { take_id: "take-second", from_beat: 0.25, to_beat: 4 },
        ],
      },
    },
    takes: {
      "take-first": {
        id: "take-first",
        clip_id: "clip-2",
        storage_key: "studio/song-1/takes/take-first.wav",
        rate: SAMPLE_RATE,
        channels: 2,
        frames: 8000,
        offset_frames: 0,
        compensated: false,
        bpm: 120,
        recorded_at: "2026-11-02T12:00:00.000Z",
        author_label: "the operator",
        discarded: false,
      },
      "take-second": {
        id: "take-second",
        clip_id: "clip-2",
        storage_key: "studio/song-1/takes/take-second.wav",
        rate: SAMPLE_RATE,
        channels: 2,
        frames: 8000,
        offset_frames: 64,
        compensated: true,
        bpm: 120,
        recorded_at: "2026-11-02T12:00:00.000Z",
        author_label: "the operator",
        discarded: false,
      },
    },
  };

  // Stereo takes, so a swapped channel would be caught, and a non-zero offset
  // on the second one, so the client's scaling of it is compared too.
  const audio = [
    { id: "take-first", channels: [first, first.map((value) => value / 2)], rate: SAMPLE_RATE },
    { id: "take-second", channels: [second, second.map((value) => value / 3)], rate: SAMPLE_RATE },
  ];

  const seconds = 0.5;
  const node = await renderSong(song, { seconds: seconds, sampleRate: SAMPLE_RATE, audio });
  const nodePeak = Math.max(peakOf(node.left), peakOf(node.right));
  assert.ok(nodePeak > 0.01, `the Node audio render has to be audible, peak was ${nodePeak}`);
  const nodeHash = hashChannels(node.left, node.right);

  // The page takes plain JSON, so the takes travel as number arrays.
  const payload = audio.map((take) => ({
    id: take.id,
    rate: take.rate,
    channels: take.channels.map((channel) => Array.from(channel)),
  }));

  const tab = await openTab();
  try {
    await tab.navigate(origin + "/");
    assert.equal(await tab.evaluate("typeof window.studioRenderAudio"), "function", "the engine page did not load");
    const browser = await tab.evaluate(
      `window.studioRenderAudio(${JSON.stringify(song)}, ${JSON.stringify(payload)}, ${seconds}, ${SAMPLE_RATE})`,
    );
    assert.equal(browser.length, node.left.length, "the two hosts rendered different lengths");
    assert.equal(browser.sampleRate, SAMPLE_RATE);
    assert.ok(browser.peak > 0.01, `the Chromium audio render has to be audible, peak was ${browser.peak}`);
    assert.equal(
      browser.hash,
      nodeHash,
      `Chromium and Node rendered different bytes over ${node.left.length * 2} samples of audio-clip render`,
    );
  } finally {
    tab.close();
  }
});

test("arrangement render bit-identical in Chromium and Node", async (t) => {
  if (!chrome) {
    t.skip("no headless Chrome");
    return;
  }

  /** @param {number} frames @returns {Float32Array} a ramp, so every frame is its own level */
  const guitar = new Float32Array(2 * 4 * 24000);
  for (let at = 0; at < guitar.length; at += 1) guitar[at] = Math.sin(at / 90) * 0.4;

  // Two tracks on the timeline: SunVox notes placed on bars, and an audio clip
  // split in two halves with a fade in on the first one — so the mix, the
  // take's frames, the split's continuation and the fade ramp are all part of
  // what is hashed.
  const song = {
    meta: { title: "Arrangement parity", bpm: 120, meter: [4, 4], key: "C major" },
    tracks: [
      {
        id: "track-1",
        name: "Lead",
        color: "#E8C07A",
        device: { engine: "sunvox", type: "Analog generator", params: {} },
        mute: false,
        solo: false,
        gain_db: -3,
        pan: -0.4,
        locked: false,
      },
      {
        id: "track-2",
        name: "Guitar",
        color: "#8FC1E8",
        device: { engine: "audio" },
        mute: false,
        solo: false,
        gain_db: -2,
        pan: 0.35,
        locked: false,
      },
    ],
    scenes: [{ id: "scene-1", name: "A" }],
    clips: {
      "clip-1": {
        id: "clip-1",
        track_id: "track-1",
        scene_id: "scene-1",
        name: "Lead",
        length_bars: 1,
        notes: [
          { t: 0, d: 1.5, p: 57, v: 110 },
          { t: 2, d: 1, p: 64, v: 90 },
        ],
      },
      "clip-2": {
        id: "clip-2",
        track_id: "track-2",
        scene_id: "scene-1",
        name: "Guitar",
        length_bars: 2,
        kind: "audio",
        notes: [],
        comp: [{ take_id: "take-1", from_beat: 0, to_beat: 8 }],
      },
    },
    takes: {
      "take-1": {
        id: "take-1",
        clip_id: "clip-2",
        storage_key: "studio/song-1/takes/take-1.wav",
        rate: SAMPLE_RATE,
        channels: 1,
        frames: guitar.length,
        offset_frames: 0,
        compensated: false,
        bpm: 120,
        recorded_at: "2026-11-02T12:00:00.000Z",
        author_label: "the operator",
        discarded: false,
      },
    },
    arrangement: {
      placements: {
        "p1": {
          id: "p1",
          track_id: "track-1",
          clip_id: "clip-1",
          start_bar: 0,
          bars: 2,
          offset_beats: 0,
          fade_in_beats: 0,
          fade_out_beats: 0,
        },
        "p2": {
          id: "p2",
          track_id: "track-2",
          clip_id: "clip-2",
          start_bar: 0,
          bars: 1,
          offset_beats: 0,
          fade_in_beats: 0.5,
          fade_out_beats: 0,
        },
        "p3": {
          id: "p3",
          track_id: "track-2",
          clip_id: "clip-2",
          start_bar: 1,
          bars: 1,
          offset_beats: 4,
          fade_in_beats: 0,
          fade_out_beats: 0,
        },
      },
      markers: {},
      sections: {},
    },
  };

  const audio = [{ id: "take-1", channels: [guitar], rate: SAMPLE_RATE }];
  // The page takes plain JSON, so the take travels as number arrays.
  const payload = [{ id: "take-1", rate: SAMPLE_RATE, channels: [Array.from(guitar)] }];

  // Two cases: the whole timeline from bar 0, and a seek to bar 1 of a
  // timeline whose split fades on both sides — the first half's fade out runs
  // into the second half's fade in, which starts exactly where the render
  // lands.
  const split = {
    ...song,
    arrangement: {
      placements: {
        p1: { ...song.arrangement.placements.p1 },
        p2: { ...song.arrangement.placements.p2, fade_out_beats: 0.5 },
        p3: { ...song.arrangement.placements.p3, fade_in_beats: 1 },
      },
      markers: {},
      sections: {},
    },
  };
  const cases = [
    { song: song, fromBar: 0, seconds: 2.5 },
    { song: split, fromBar: 1, seconds: 1.5 },
  ];

  const tab = await openTab();
  try {
    await tab.navigate(origin + "/");
    assert.equal(await tab.evaluate("typeof window.studioRenderArrangement"), "function", "the engine page did not load");
    for (const item of cases) {
      const node = await renderSong(item.song, {
        seconds: item.seconds,
        sampleRate: SAMPLE_RATE,
        audio,
        mode: "arrangement",
        fromBar: item.fromBar,
      });
      const nodePeak = Math.max(peakOf(node.left), peakOf(node.right));
      assert.ok(
        nodePeak > 0.01,
        `the Node arrangement render from bar ${item.fromBar} has to be audible, peak was ${nodePeak}`,
      );
      const nodeHash = hashChannels(node.left, node.right);

      const browser = await tab.evaluate(
        `window.studioRenderArrangement(${JSON.stringify(item.song)}, ${JSON.stringify(payload)}, ${item.seconds}, ${SAMPLE_RATE}, ${item.fromBar})`,
      );
      assert.equal(browser.length, node.left.length, "the two hosts rendered different lengths");
      assert.equal(browser.sampleRate, SAMPLE_RATE);
      assert.ok(
        browser.peak > 0.01,
        `the Chromium arrangement render from bar ${item.fromBar} has to be audible, peak was ${browser.peak}`,
      );
      assert.equal(
        browser.hash,
        nodeHash,
        `Chromium and Node rendered different bytes over ${node.left.length * 2} samples of an arrangement render from bar ${item.fromBar}`,
      );
    }
  } finally {
    tab.close();
  }
});

test("sampler pattern bit-identical in Chromium and Node", async (t) => {
  if (!chrome) {
    t.skip("no headless Chrome");
    return;
  }

  /** A mono sample whose every frame is its own level, with a sine body. */
  const mono = new Float32Array(24000);
  for (let at = 0; at < mono.length; at += 1) {
    mono[at] = Math.sin((2 * Math.PI * 220 * at) / SAMPLE_RATE) * 0.6 * (1 - at / mono.length);
  }
  /** A stereo sample: the two channels differ, so a swap would show. */
  const stereoLeft = new Float32Array(12000);
  const stereoRight = new Float32Array(12000);
  for (let at = 0; at < stereoLeft.length; at += 1) {
    stereoLeft[at] = Math.sin((2 * Math.PI * 330 * at) / SAMPLE_RATE) * 0.5;
    stereoRight[at] = Math.sin((2 * Math.PI * 440 * at) / SAMPLE_RATE) * 0.4;
  }

  // Two sampler tracks: one-shots and a gate, a choke group, a slice, a
  // reversed voice, three filter kinds and per-step locks — so the sampler's
  // voice DSP, its mix and its stealing rules are all part of the hash.
  const song = {
    meta: { title: "Sampler parity", bpm: 120, meter: [4, 4], key: "C major" },
    tracks: [
      {
        id: "track-1",
        name: "Kit",
        color: "#E8C07A",
        device: { engine: "sampler" },
        mute: false,
        solo: false,
        gain_db: -3,
        pan: -0.4,
        locked: false,
      },
      {
        id: "track-2",
        name: "Hats",
        color: "#8FC1E8",
        device: { engine: "sampler" },
        mute: false,
        solo: false,
        gain_db: -2,
        pan: 0.3,
        locked: false,
      },
    ],
    scenes: [{ id: "scene-1", name: "A" }],
    clips: {
      "clip-1": {
        id: "clip-1",
        track_id: "track-1",
        scene_id: "scene-1",
        name: "Kit",
        length_bars: 1,
        notes: [],
        kind: "pattern",
        length_steps: 16,
        step_beats: 0.25,
        swing: 0,
        chain: [],
      },
      "clip-2": {
        id: "clip-2",
        track_id: "track-2",
        scene_id: "scene-1",
        name: "Hats",
        length_bars: 1,
        notes: [],
        kind: "pattern",
        length_steps: 8,
        step_beats: 0.5,
        swing: 0,
        chain: [],
      },
    },
    samples: {
      "sample-a": {
        id: "sample-a",
        storage_key: "studio/song-1/samples/sample-a.wav",
        rate: SAMPLE_RATE,
        channels: 1,
        frames: mono.length,
        name: "a",
        origin: "record",
        author_label: "the operator",
      },
      "sample-b": {
        id: "sample-b",
        storage_key: "studio/song-1/samples/sample-b.wav",
        rate: SAMPLE_RATE,
        channels: 2,
        frames: stereoLeft.length,
        name: "b",
        origin: "import",
        author_label: "the operator",
      },
    },
    slices: {
      "sample-b/s1": { id: "s1", sample_id: "sample-b", start_frame: 1000, end_frame: 8000 },
    },
    banks: {
      "track-1/bank-a": { id: "bank-a", track_id: "track-1", name: "A", order: 0 },
      "track-2/bank-a": { id: "bank-a", track_id: "track-2", name: "A", order: 0 },
    },
    pads: {
      "track-1/bank-a/0": {
        track_id: "track-1",
        bank_id: "bank-a",
        index: 0,
        sample_id: "sample-a",
        slice_id: null,
        name: "",
        mode: "oneshot",
        pitch: 0,
        gain_db: 0,
        pan: 0,
        attack_ms: 0,
        decay_ms: 0,
        sustain: 1,
        release_ms: 0,
        filter: { type: "lp", cutoff_hz: 2500, resonance: 0.6 },
        choke: 0,
        reverse: false,
      },
      "track-1/bank-a/1": {
        track_id: "track-1",
        bank_id: "bank-a",
        index: 1,
        sample_id: "sample-a",
        slice_id: null,
        name: "",
        mode: "gate",
        pitch: -5,
        gain_db: -2,
        pan: 0.25,
        attack_ms: 5,
        decay_ms: 120,
        sustain: 0.5,
        release_ms: 200,
        filter: { type: "hp", cutoff_hz: 400, resonance: 0.2 },
        choke: 0,
        reverse: false,
      },
      "track-2/bank-a/0": {
        track_id: "track-2",
        bank_id: "bank-a",
        index: 0,
        sample_id: "sample-b",
        slice_id: null,
        name: "",
        mode: "oneshot",
        pitch: 0,
        gain_db: 0,
        pan: 0,
        attack_ms: 0,
        decay_ms: 0,
        sustain: 1,
        release_ms: 0,
        filter: { type: "off", cutoff_hz: 20000, resonance: 0 },
        choke: 2,
        reverse: true,
      },
      "track-2/bank-a/1": {
        track_id: "track-2",
        bank_id: "bank-a",
        index: 1,
        sample_id: "sample-b",
        slice_id: "s1",
        name: "",
        mode: "gate",
        pitch: 0,
        gain_db: 0,
        pan: 0.5,
        attack_ms: 0,
        decay_ms: 60,
        sustain: 0.7,
        release_ms: 40,
        filter: { type: "bp", cutoff_hz: 1200, resonance: 0.4 },
        choke: 2,
        reverse: false,
      },
    },
    patterns: {
      "clip-1/a": { id: "a", clip_id: "clip-1", name: "A", order: 0 },
      "clip-2/a": { id: "a", clip_id: "clip-2", name: "A", order: 0 },
    },
    steps: {
      "clip-1/a/0/bank-a.0": {
        clip_id: "clip-1",
        pattern_id: "a",
        at: 0,
        bank_id: "bank-a",
        index: 0,
        v: 120,
        locks: {},
      },
      "clip-1/a/2/bank-a.1": {
        clip_id: "clip-1",
        pattern_id: "a",
        at: 2,
        bank_id: "bank-a",
        index: 1,
        v: 90,
        locks: { cutoff_hz: 900, pitch: 7, release_ms: 80 },
      },
      "clip-1/a/8/bank-a.0": {
        clip_id: "clip-1",
        pattern_id: "a",
        at: 8,
        bank_id: "bank-a",
        index: 0,
        v: 64,
        locks: { pitch: 12, gain_db: -6, pan: -0.75 },
      },
      "clip-2/a/0/bank-a.0": {
        clip_id: "clip-2",
        pattern_id: "a",
        at: 0,
        bank_id: "bank-a",
        index: 0,
        v: 127,
        locks: {},
      },
      "clip-2/a/1/bank-a.1": {
        clip_id: "clip-2",
        pattern_id: "a",
        at: 1,
        bank_id: "bank-a",
        index: 1,
        v: 100,
        locks: { reverse: true },
      },
      "clip-2/a/3/bank-a.0": {
        clip_id: "clip-2",
        pattern_id: "a",
        at: 3,
        bank_id: "bank-a",
        index: 0,
        v: 80,
        locks: { pitch: -7 },
      },
    },
  };

  const samples = [
    { id: "sample-a", channels: [mono], rate: SAMPLE_RATE },
    { id: "sample-b", channels: [stereoLeft, stereoRight], rate: SAMPLE_RATE },
  ];
  // The page takes plain JSON, so the PCM travels as number arrays.
  const payload = samples.map((item) => ({
    id: item.id,
    rate: item.rate,
    channels: item.channels.map((channel) => Array.from(channel)),
  }));

  const seconds = 2;
  const node = await renderSong(song, { seconds: seconds, sampleRate: SAMPLE_RATE, samples });
  const nodePeak = Math.max(peakOf(node.left), peakOf(node.right));
  assert.ok(nodePeak > 0.01, `the Node sampler render has to be audible, peak was ${nodePeak}`);
  const nodeHash = hashChannels(node.left, node.right);

  // Every pad in the song has to contribute: a silent voice path, or a pad
  // whose step never starts a voice, would hide inside the hash. Each pad is
  // rendered alone (its track's clip, one step at position 0) and has to sound.
  for (const key of Object.keys(song.pads)) {
    const [trackId, bankId, index] = key.split("/");
    const clipId = trackId === "track-1" ? "clip-1" : "clip-2";
    const alone = {
      ...song,
      steps: {
        [`${clipId}/a/0/${bankId}.${index}`]: {
          clip_id: clipId,
          pattern_id: "a",
          at: 0,
          bank_id: bankId,
          index: Number(index),
          v: 127,
          locks: {},
        },
      },
    };
    const one = await renderSong(alone, { seconds: 0.6, sampleRate: SAMPLE_RATE, samples });
    const padPeak = Math.max(peakOf(one.left), peakOf(one.right));
    assert.ok(padPeak > 0.001, `pad ${key} has to contribute sound of its own, peak was ${padPeak}`);
  }

  const tab = await openTab();
  try {
    await tab.navigate(origin + "/");
    assert.equal(await tab.evaluate("typeof window.studioRenderSampler"), "function", "the engine page did not load");
    const browser = await tab.evaluate(
      `window.studioRenderSampler(${JSON.stringify(song)}, ${JSON.stringify(payload)}, ${seconds}, ${SAMPLE_RATE})`,
    );
    assert.equal(browser.length, node.left.length, "the two hosts rendered different lengths");
    assert.equal(browser.sampleRate, SAMPLE_RATE);
    assert.ok(browser.peak > 0.01, `the Chromium sampler render has to be audible too, peak was ${browser.peak}`);
    assert.equal(
      browser.hash,
      nodeHash,
      `Chromium and Node rendered different bytes over ${node.left.length * 2} samples of a sampler render`,
    );
  } finally {
    tab.close();
  }
});

test("motion is bit-identical in Chromium and Node", async (t) => {
  if (!chrome) {
    t.skip("no headless Chrome");
    return;
  }

  // A sample with body in it, so a swept filter, level and pitch all show.
  const frames = 24000;
  const mono = new Float32Array(frames);
  for (let at = 0; at < frames; at += 1) {
    mono[at] =
      (Math.sin((2 * Math.PI * 180 * at) / SAMPLE_RATE) * 0.5
        + Math.sin((2 * Math.PI * 2400 * at) / SAMPLE_RATE) * 0.3) * (1 - at / frames);
  }

  const padOf = (index, over = {}) => ({
    track_id: "track-1",
    bank_id: "bank-a",
    index,
    sample_id: "sample-a",
    slice_id: null,
    name: "",
    mode: "gate",
    pitch: 0,
    gain_db: 0,
    pan: 0,
    attack_ms: 0,
    decay_ms: 0,
    sustain: 1,
    release_ms: 0,
    filter: { type: "lp", cutoff_hz: 8000, resonance: 0.5 },
    choke: 0,
    reverse: false,
    ...over,
  });

  const step = (at, index, over = {}) => ({
    clip_id: "clip-1",
    pattern_id: "a",
    at,
    bank_id: "bank-a",
    index,
    v: 110,
    locks: {},
    ...over,
  });

  const song = {
    meta: { title: "Motion parity", bpm: 120, meter: [4, 4], key: "C major" },
    tracks: [
      {
        id: "track-1",
        name: "Kit",
        color: "#E8C07A",
        device: { engine: "sampler" },
        mute: false,
        solo: false,
        gain_db: -2,
        pan: 0.2,
        locked: false,
      },
    ],
    scenes: [{ id: "scene-1", name: "A" }],
    clips: {
      "clip-1": {
        id: "clip-1",
        track_id: "track-1",
        scene_id: "scene-1",
        name: "Kit",
        length_bars: 1,
        notes: [],
        kind: "pattern",
        length_steps: 16,
        step_beats: 0.25,
        swing: 0,
        chain: [],
      },
    },
    samples: {
      "sample-a": {
        id: "sample-a",
        storage_key: "studio/song-1/samples/sample-a.wav",
        rate: SAMPLE_RATE,
        channels: 1,
        frames: frames,
        name: "a",
        origin: "record",
        author_label: "the operator",
      },
    },
    slices: {},
    banks: { "track-1/bank-a": { id: "bank-a", track_id: "track-1", name: "A", order: 0 } },
    pads: {
      "track-1/bank-a/0": padOf(0),
      // A step of this one locks its own cutoff, so a lock has to survive the
      // render identically too.
      "track-1/bank-a/1": padOf(1, { filter: { type: "hp", cutoff_hz: 300, resonance: 0.2 } }),
    },
    patterns: {
      "clip-1/a": {
        id: "a",
        clip_id: "clip-1",
        name: "A",
        order: 0,
        motion: {
          "bank-a.0|cutoff_hz": [
            { step_frac: 0, value: 200 },
            { step_frac: 6, value: 12000 },
            { step_frac: 12, value: 400 },
          ],
          "bank-a.0|gain_db": [
            { step_frac: 0, value: -18 },
            { step_frac: 10, value: 0 },
          ],
          "bank-a.0|pitch": [
            { step_frac: 2, value: -3 },
            { step_frac: 14, value: 4.5 },
          ],
          "bank-a.1|cutoff_hz": [{ step_frac: 0, value: 1500 }],
        },
      },
    },
    steps: {
      "clip-1/a/0/bank-a.0": step(0, 0),
      "clip-1/a/4/bank-a.0": step(4, 0),
      "clip-1/a/8/bank-a.0": step(8, 0),
      "clip-1/a/2/bank-a.1": step(2, 1, { locks: { cutoff_hz: 6000 } }),
      "clip-1/a/12/bank-a.1": step(12, 1),
    },
  };

  const payload = [
    { id: "sample-a", rate: SAMPLE_RATE, channels: [Array.from(mono)] },
  ];
  const seconds = 3;
  const node = await renderSong(song, {
    seconds,
    sampleRate: SAMPLE_RATE,
    samples: [{ id: "sample-a", channels: [mono], rate: SAMPLE_RATE }],
  });
  const nodePeak = Math.max(peakOf(node.left), peakOf(node.right));
  assert.ok(nodePeak > 0.01, `the Node motion render has to be audible, peak was ${nodePeak}`);
  const nodeHash = hashChannels(node.left, node.right);

  // The very same song without its curves has to sound different: a motion path
  // that silently did nothing would pass the hash comparison for the wrong
  // reason.
  const plain = {
    ...song,
    patterns: { "clip-1/a": { id: "a", clip_id: "clip-1", name: "A", order: 0 } },
  };
  const flat = await renderSong(plain, {
    seconds,
    sampleRate: SAMPLE_RATE,
    samples: [{ id: "sample-a", channels: [mono], rate: SAMPLE_RATE }],
  });
  assert.notEqual(
    hashChannels(flat.left, flat.right),
    nodeHash,
    "a song with motion and the same song without it must not render the same bytes",
  );

  const tab = await openTab();
  try {
    await tab.navigate(origin + "/");
    assert.equal(await tab.evaluate("typeof window.studioRenderSampler"), "function", "the engine page did not load");
    const browser = await tab.evaluate(
      `window.studioRenderSampler(${JSON.stringify(song)}, ${JSON.stringify(payload)}, ${seconds}, ${SAMPLE_RATE})`,
    );
    assert.equal(browser.length, node.left.length, "the two hosts rendered different lengths");
    assert.equal(browser.sampleRate, SAMPLE_RATE);
    assert.ok(browser.peak > 0.01, `the Chromium motion render has to be audible too, peak was ${browser.peak}`);
    assert.equal(
      browser.hash,
      nodeHash,
      `Chromium and Node rendered different bytes over ${node.left.length * 2} samples of a motion render`,
    );
  } finally {
    tab.close();
  }
});

test("effects bit-identical in Chromium and Node", async (t) => {
  if (!chrome) {
    t.skip("no headless Chrome");
    return;
  }

  // Two tracks of overlapping notes, so the effects run on a mix that would
  // show a wrong sample, a wrong frame or a wrong pan.
  const song = {
    meta: { title: "Effects parity", bpm: 120, meter: [4, 4], key: "C major" },
    tracks: [
      {
        id: "track-1",
        name: "Low",
        color: "#E8C07A",
        device: { engine: "sunvox", type: "Analog generator", params: {} },
        mute: false,
        solo: false,
        gain_db: -6,
        pan: -0.3,
        locked: false,
      },
      {
        id: "track-2",
        name: "High",
        color: "#8FC1E8",
        device: { engine: "sunvox", type: "Analog generator", params: {} },
        mute: false,
        solo: false,
        gain_db: -3,
        pan: 0.4,
        locked: false,
      },
    ],
    scenes: [{ id: "scene-1", name: "A" }],
    clips: {
      "clip-1": {
        id: "clip-1",
        track_id: "track-1",
        scene_id: "scene-1",
        name: "Low",
        length_bars: 1,
        notes: [
          { t: 0, d: 1, p: 48, v: 110 },
          { t: 1.5, d: 0.75, p: 55, v: 80 },
          { t: 2.5, d: 1.5, p: 52, v: 120 },
        ],
      },
      "clip-2": {
        id: "clip-2",
        track_id: "track-2",
        scene_id: "scene-1",
        name: "High",
        length_bars: 1,
        notes: [
          { t: 0.5, d: 1, p: 72, v: 90 },
          { t: 2, d: 0.5, p: 67, v: 100 },
          { t: 3, d: 1, p: 70, v: 70 },
        ],
      },
    },
  };

  /**
   * One case: which effects are held for the whole render, and which are let go
   * of on the very first frame (so their 64-frame crossfade and the state drop
   * are part of the hash too).
   */
  const cases = [
    { label: "held", hold: [
      { name: "stutter", amount: 0.5 },
      { name: "lofi", amount: 1 },
      { name: "reverb_throw", amount: 0.5 },
    ], release: [] },
    { label: "released", hold: [
      { name: "stutter", amount: 0.5 },
      { name: "tape_stop", amount: 0.7 },
      { name: "filter_sweep", amount: 0.8 },
      { name: "lofi", amount: 1 },
      { name: "reverb_throw", amount: 0.5 },
    ], release: ["stutter", "tape_stop", "filter_sweep", "lofi", "reverb_throw"] },
  ];

  const seconds = 3;
  const dry = await renderSong(song, { seconds: seconds, sampleRate: SAMPLE_RATE });
  const dryHash = hashChannels(dry.left, dry.right);

  const tab = await openTab();
  try {
    await tab.navigate(origin + "/");
    assert.equal(await tab.evaluate("typeof window.studioRenderEffects"), "function", "the engine page did not load");
    for (const item of cases) {
      const node = await renderSong(song, {
        seconds: seconds,
        sampleRate: SAMPLE_RATE,
        hold: item.hold,
        release: item.release,
      });
      const nodePeak = Math.max(peakOf(node.left), peakOf(node.right));
      assert.ok(nodePeak > 0.01, `the Node ${item.label} render has to be audible, peak was ${nodePeak}`);
      const nodeHash = hashChannels(node.left, node.right);
      assert.notEqual(
        nodeHash,
        dryHash,
        `the ${item.label} effects have to change the master, or the hash compares nothing`,
      );

      const browser = await tab.evaluate(
        `window.studioRenderEffects(${JSON.stringify(song)}, ${JSON.stringify(item.hold)}, ${JSON.stringify(item.release)}, ${seconds}, ${SAMPLE_RATE})`,
      );
      assert.equal(browser.length, node.left.length, "the two hosts rendered different lengths");
      assert.equal(browser.sampleRate, SAMPLE_RATE);
      assert.ok(
        browser.peak > 0.01,
        `the Chromium ${item.label} render has to be audible too, peak was ${browser.peak}`,
      );
      assert.equal(
        browser.hash,
        nodeHash,
        `Chromium and Node rendered different bytes over ${node.left.length * 2} samples of an effects render (${item.label})`,
      );
    }
  } finally {
    tab.close();
  }
});

test("soundfont tracks with no font host ask for every font and stay silent", async () => {
  // The engine composed WITHOUT `font-voice.js` (and the vendored synth it drives)
  // has no SoundFont host at all — the processor's own `NO_FONTS`. Every soundfont
  // track is then silent, and every font they name is asked for once (the page
  // owns the bytes), with nothing thrown on the audio thread.
  const assetBytes = { ...ASSETS, "font-voice.js": "", "spessasynth.js": "" };
  const song = {
    meta: { title: "No font host", bpm: 120, meter: [4, 4], key: "C major" },
    tracks: [
      { id: "track-1", name: "A", color: "#E8C07A", device: { engine: "soundfont", font_id: "font-a", bank: 0, program: 0 }, mute: false, solo: false, gain_db: 0, pan: 0, locked: false },
      { id: "track-2", name: "B", color: "#E8C07A", device: { engine: "soundfont", font_id: "font-b", bank: 0, program: 1 }, mute: false, solo: false, gain_db: 0, pan: 0, locked: false },
      { id: "track-3", name: "C", color: "#E8C07A", device: { engine: "soundfont", font_id: "font-a", bank: 128, program: 0 }, mute: false, solo: false, gain_db: 0, pan: 0, locked: false },
    ],
    scenes: [{ id: "scene-1", name: "A" }],
    clips: {
      "clip-1": { id: "clip-1", track_id: "track-1", scene_id: "scene-1", name: "A", length_bars: 1, notes: [{ t: 0, d: 1, p: 60, v: 100 }] },
      "clip-2": { id: "clip-2", track_id: "track-2", scene_id: "scene-1", name: "B", length_bars: 1, notes: [{ t: 0, d: 1, p: 64, v: 100 }] },
      "clip-3": { id: "clip-3", track_id: "track-3", scene_id: "scene-1", name: "C", length_bars: 1, notes: [{ t: 0, d: 1, p: 36, v: 100 }] },
    },
  };

  const needed = [];
  const context = new OfflineAudioContext({ numberOfChannels: 2, length: Math.round(0.4 * SAMPLE_RATE), sampleRate: SAMPLE_RATE });
  let engine = null;
  let rendered = false;
  try {
    engine = await studioEngine.create(context, { assetBytes: assetBytes });
    engine.onLibraryNeeded((id) => needed.push(id));
    engine.setSong(song);
    engine.launchScene("scene-1");
    engine.play();
    engine.node.connect(context.destination);
    await engine.flush();
    // Three tracks, TWO fonts: every track's font is reported, and each font id
    // once — however many tracks play it.
    assert.deepEqual(needed.slice().sort(), ["font-a", "font-b"], `every font has to be asked for once, got ${JSON.stringify(needed)}`);
    const buffer = await context.startRendering();
    rendered = true;
    const left = channelOf(buffer, 0);
    const right = channelOf(buffer, 1);
    assert.ok(
      peakOf(left) < 1e-9 && peakOf(right) < 1e-9,
      `with no font host there is nothing to play, peak was ${Math.max(peakOf(left), peakOf(right))}`,
    );
    assert.deepEqual(needed.slice().sort(), ["font-a", "font-b"], "a font is asked for once, not once per block");
  } finally {
    if (engine) engine.dispose();
    if (!rendered) await releaseWorklet(context);
  }
});

test("every soundfont track of a song is non-silent", async () => {
  // Three soundfont tracks on ONE bank, each its own program. Each is rendered
  // alone (the other two muted) and has to sound: a mix that is audible overall
  // would still pass if one track's channel never reached it.
  const fontId = "font-tiny";
  const font = { id: fontId, bytes: tinySf2() };
  const track = (index, program) => ({
    id: `track-${index}`,
    name: `Track ${index}`,
    color: "#E8C07A",
    device: { engine: "soundfont", font_id: fontId, bank: 0, program: program },
    mute: false,
    solo: false,
    gain_db: -6,
    pan: 0,
    locked: false,
  });
  const tracks = [track(1, 0), track(2, 1), track(3, 2)];
  const song = {
    meta: { title: "Every track", bpm: 120, meter: [4, 4], key: "C major" },
    tracks: tracks,
    scenes: [{ id: "scene-1", name: "A" }],
    clips: {},
  };
  for (let index = 0; index < tracks.length; index += 1) {
    const id = tracks[index].id;
    song.clips[`clip-${index + 1}`] = {
      id: `clip-${index + 1}`,
      track_id: id,
      scene_id: "scene-1",
      name: id,
      length_bars: 1,
      notes: [{ t: 0, d: 4, p: 60, v: 110 }],
    };
  }
  assert.ok(TINY_SF2_PRESETS.length >= 3, "the test font has to carry three programs");

  for (let solo = 0; solo < tracks.length; solo += 1) {
    const only = {
      ...song,
      tracks: tracks.map((item, index) => (index === solo ? item : { ...item, mute: true })),
    };
    const render = await renderSong(only, { seconds: 0.5, sampleRate: SAMPLE_RATE, fonts: [font] });
    const peak = Math.max(peakOf(render.left), peakOf(render.right));
    assert.ok(peak > 0.005, `track ${solo + 1} has to sound on its own, peak was ${peak}`);
  }
});

test("soundfont song bit-identical in Chromium and Node", async (t) => {
  if (!chrome) {
    t.skip("no headless Chrome");
    return;
  }

  // Three soundfont tracks on ONE bank: two melodic programs at different pans
  // and gains, and the GM drum bank, so the round trip covers the parsed bank,
  // the per-channel outputs, `setDrums`, the presets and the mix.
  const fontId = "font-tiny";
  const font = { id: fontId, bytes: tinySf2() };
  const track = (index, device, gain_db, pan) => ({
    id: `track-${index}`,
    name: `Track ${index}`,
    color: "#E8C07A",
    device: device,
    mute: false,
    solo: false,
    gain_db: gain_db,
    pan: pan,
    locked: false,
  });
  const song = {
    meta: { title: "SoundFont parity", bpm: 120, meter: [4, 4], key: "C major" },
    tracks: [
      track(1, { engine: "soundfont", font_id: fontId, bank: 0, program: 0 }, -3, -0.4),
      track(2, { engine: "soundfont", font_id: fontId, bank: 0, program: 3 }, -6, 0.3),
      track(3, { engine: "soundfont", font_id: fontId, bank: 128, program: 0 }, -9, 0),
    ],
    scenes: [{ id: "scene-1", name: "A" }],
    clips: {
      "clip-1": {
        id: "clip-1",
        track_id: "track-1",
        scene_id: "scene-1",
        name: "One",
        length_bars: 1,
        notes: [
          { t: 0, d: 1, p: 60, v: 110 },
          { t: 1.5, d: 0.75, p: 64, v: 80 },
          { t: 2.5, d: 1.5, p: 67, v: 120 },
        ],
      },
      "clip-2": {
        id: "clip-2",
        track_id: "track-2",
        scene_id: "scene-1",
        name: "Two",
        length_bars: 1,
        notes: [
          { t: 0.5, d: 1, p: 48, v: 90 },
          { t: 2, d: 0.5, p: 55, v: 100 },
        ],
      },
      "clip-3": {
        id: "clip-3",
        track_id: "track-3",
        scene_id: "scene-1",
        name: "Drums",
        length_bars: 1,
        notes: [
          { t: 0, d: 0.25, p: 36, v: 120 },
          { t: 1, d: 0.25, p: 38, v: 100 },
          { t: 2, d: 0.25, p: 42, v: 110 },
          { t: 3, d: 0.25, p: 36, v: 127 },
        ],
      },
    },
  };
  assert.ok(TINY_SF2_PRESETS.length > 0, "the test font has to carry presets");

  const seconds = 3;
  const node = await renderSong(song, { seconds: seconds, sampleRate: SAMPLE_RATE, fonts: [font] });
  const nodePeak = Math.max(peakOf(node.left), peakOf(node.right));
  assert.ok(nodePeak > 0.01, `the Node render has to be audible to compare anything, peak was ${nodePeak}`);
  const nodeHash = hashChannels(node.left, node.right);

  const tab = await openTab();
  try {
    await tab.navigate(origin + "/");
    assert.equal(await tab.evaluate("typeof window.studioRenderFont"), "function", "the engine page did not load");
    const base64 = Buffer.from(font.bytes).toString("base64");
    const browser = await tab.evaluate(
      `window.studioRenderFont(${JSON.stringify(song)}, ${JSON.stringify(base64)}, ${seconds}, ${SAMPLE_RATE})`,
    );
    assert.equal(browser.length, node.left.length, "the two hosts rendered different lengths");
    assert.equal(browser.sampleRate, SAMPLE_RATE);
    assert.ok(browser.peak > 0.01, `the Chromium render has to be audible too, peak was ${browser.peak}`);
    assert.equal(
      browser.hash,
      nodeHash,
      `Chromium and Node rendered different bytes over ${node.left.length * 2} samples of a soundfont song`,
    );
  } finally {
    tab.close();
  }
});

test("a Faust insert hosted in the processor is bit-identical in Chromium and Node", async (t) => {
  if (!chrome) {
    t.skip("no headless Chrome");
    return;
  }

  // One compiled Faust effect (the reverb: the largest, and the one that calls
  // out to the host for `sin`, `cos`, `pow` and `tan`), driven through a minimal
  // worklet that holds nothing but `faust-host.js` and the tiny processor above.
  // Every parameter is off its default, so the factory JSON's parameter offsets
  // are part of what is compared.
  const kind = "reverb";
  const params = { size: 0.8, damping: 0.7, predelay_ms: 37, mix: 0.9 };
  const seconds = 1;

  const node = await renderFaustInsert({ kind, params, seconds, sampleRate: SAMPLE_RATE });
  const nodePeak = Math.max(peakOf(node.left), peakOf(node.right));
  assert.ok(nodePeak > 0.001, `the Node render of the Faust insert has to be audible, peak was ${nodePeak}`);
  const nodeHash = hashChannels(node.left, node.right);

  const tab = await openTab();
  try {
    await tab.navigate(origin + "/");
    assert.equal(await tab.evaluate("typeof window.studioRenderFaust"), "function", "the engine page did not load");
    const browser = await tab.evaluate(
      `window.studioRenderFaust(${JSON.stringify(kind)}, ${JSON.stringify(params)}, ${seconds}, ${SAMPLE_RATE})`,
    );
    assert.equal(browser.length, node.left.length, "the two hosts rendered different lengths");
    assert.equal(browser.sampleRate, SAMPLE_RATE);
    assert.ok(browser.peak > 0.001, `the Chromium render has to be audible too, peak was ${browser.peak}`);
    assert.equal(
      browser.hash,
      nodeHash,
      `Chromium and Node rendered different bytes over ${node.left.length * 2} samples of a Faust insert`,
    );
  } finally {
    tab.close();
  }
});

test("mixer song bit-identical in Chromium and Node", async (t) => {
  if (!chrome) {
    t.skip("no headless Chrome");
    return;
  }

  // The whole mixer in one song (plan 1d, Task 9): two tracks with their own
  // chains (a Faust equalizer and Crow's own compressor on one, a Faust delay and
  // saturation on the other), two returns with their own inserts, three sends
  // (one pre fader, two post), a bypassed insert and a master with a gain and a
  // limiter. Every one of those runs on the same sample in both hosts, so a
  // different pan law, a different send tap or a different limiter ramp shows up
  // in the hash.
  const track = (index, gainDb, pan) => ({
    id: `track-${index}`,
    name: index === 1 ? "Low" : "High",
    color: "#E8C07A",
    device: { engine: "sunvox", type: "Analog generator", params: {} },
    mute: false,
    solo: false,
    gain_db: gainDb,
    pan: pan,
    locked: false,
  });
  const insert = (id, owner, order, kind, params, bypass = false) => ({
    id: id,
    owner: owner,
    order: order,
    kind: kind,
    bypass: bypass,
    params: params,
  });
  const song = {
    meta: { title: "Mixer parity", bpm: 120, meter: [4, 4], key: "C major" },
    tracks: [track(1, -6, -0.4), track(2, -3, 0.5)],
    scenes: [{ id: "scene-1", name: "A" }],
    clips: {
      "clip-1": {
        id: "clip-1",
        track_id: "track-1",
        scene_id: "scene-1",
        name: "Low",
        length_bars: 1,
        notes: [
          { t: 0, d: 1, p: 48, v: 110 },
          { t: 1.5, d: 0.75, p: 55, v: 80 },
          { t: 2.5, d: 1.5, p: 52, v: 120 },
        ],
      },
      "clip-2": {
        id: "clip-2",
        track_id: "track-2",
        scene_id: "scene-1",
        name: "High",
        length_bars: 1,
        notes: [
          { t: 0.5, d: 1, p: 72, v: 90 },
          { t: 2, d: 0.5, p: 67, v: 100 },
          { t: 3, d: 1, p: 70, v: 70 },
        ],
      },
    },
    inserts: {
      "ins-eq": insert("ins-eq", "track:track-1", 1, "eq", {
        low_freq_hz: 120,
        low_gain_db: 6,
        mid_freq_hz: 900,
        mid_gain_db: -4,
        mid_q: 1.2,
        high_freq_hz: 6000,
        high_gain_db: 3,
      }),
      "ins-comp": insert("ins-comp", "track:track-1", 2, "compressor", {
        detect: "rms",
        threshold_db: -24,
        ratio: 4,
        knee_db: 6,
        attack_ms: 10,
        release_ms: 120,
        makeup_db: 3,
        sidechain_hp_hz: 80,
      }),
      "ins-delay": insert("ins-delay", "track:track-2", 1, "delay", {
        time_ms: 240,
        feedback: 0.4,
        mix: 0.35,
        highcut_hz: 6000,
      }),
      "ins-sat": insert("ins-sat", "track:track-2", 2, "saturation", {
        drive_db: 9,
        tone: 0.6,
        output_db: -3,
        mix: 0.8,
      }),
      "ins-reverb": insert("ins-reverb", "return:ret-1", 1, "reverb", {
        size: 0.7,
        damping: 0.6,
        predelay_ms: 12,
        mix: 0.4,
      }),
      "ins-echo": insert("ins-echo", "return:ret-2", 1, "delay", {
        time_ms: 375,
        feedback: 0.5,
        mix: 0.5,
        highcut_hz: 5000,
      }),
      // A bypassed insert: it is part of the chain and must never run.
      "ins-bypassed": insert("ins-bypassed", "master", 0, "filter", { mode: "hp", cutoff_hz: 400, resonance: 2 }, true),
      "ins-limiter": insert("ins-limiter", "master", 1, "limiter", { ceiling_db: -1.5, release_ms: 60 }),
    },
    sends: {
      "track-1/ret-1": { track_id: "track-1", return_id: "ret-1", level_db: -12, pre: false },
      "track-1/ret-2": { track_id: "track-1", return_id: "ret-2", level_db: -6, pre: true },
      "track-2/ret-1": { track_id: "track-2", return_id: "ret-1", level_db: -9, pre: true },
    },
    returns: {
      "ret-1": { id: "ret-1", name: "Hall", gain_db: -6, pan: 0.3, mute: false },
      "ret-2": { id: "ret-2", name: "Echo", gain_db: -9, pan: -0.2, mute: false },
    },
    master: { gain_db: -2.5, target: { lufs: -14, true_peak_db: -1 } },
  };

  const seconds = 3;
  const node = await renderSong(song, { seconds: seconds, sampleRate: SAMPLE_RATE });
  const nodePeak = Math.max(peakOf(node.left), peakOf(node.right));
  assert.ok(nodePeak > 0.01, `the Node mixer render has to be audible, peak was ${nodePeak}`);
  const nodeHash = hashChannels(node.left, node.right);

  // The mixer really is in the render: the same song with its inserts taken out
  // (the sends and returns stay) has to sound different, or a chain that was
  // silently dropped would pass the hash comparison below for the wrong reason.
  const dry = await renderSong({ ...song, inserts: {} }, { seconds: seconds, sampleRate: SAMPLE_RATE });
  assert.notEqual(
    hashChannels(dry.left, dry.right),
    nodeHash,
    "the mixed render has to differ from the same song with no inserts",
  );
  let difference = 0;
  for (let at = 0; at < node.left.length; at += 1) difference += Math.abs(node.left[at] - dry.left[at]);
  difference /= Math.max(1, node.left.length);
  assert.ok(
    difference > 1e-4,
    `the inserts have to change the mix: the mean |difference| was ${difference}`,
  );

  const tab = await openTab();
  try {
    await tab.navigate(origin + "/");
    assert.equal(await tab.evaluate("typeof window.studioRenderMixer"), "function", "the engine page did not load");
    const browser = await tab.evaluate(
      `window.studioRenderMixer(${JSON.stringify(song)}, ${seconds}, ${SAMPLE_RATE})`,
    );
    assert.equal(browser.length, node.left.length, "the two hosts rendered different lengths");
    assert.equal(browser.sampleRate, SAMPLE_RATE);
    assert.ok(browser.peak > 0.01, `the Chromium mixer render has to be audible too, peak was ${browser.peak}`);
    assert.equal(
      browser.hash,
      nodeHash,
      `Chromium and Node rendered different bytes over ${node.left.length * 2} samples of a mixer song`,
    );
  } finally {
    tab.close();
  }
});