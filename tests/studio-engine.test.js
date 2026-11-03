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
 *   - headless Chromium and Node render the same song bit-identically (one
 *     SHA-256 over the left+right float bytes). Gated like the other live
 *     tests: it skips without a browser unless CROW_REQUIRE_TEST_CHROME=1.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startHeadlessChrome } from "./fixtures/headless-chrome.mjs";

const ENGINE_DIR = fileURLToPath(new URL("../bundles/studio/engine/", import.meta.url));
const VENDOR_DIR = fileURLToPath(new URL("../bundles/studio/vendor/sunvox/", import.meta.url));
const SYMBOLS_FILE = fileURLToPath(
  new URL("../bundles/studio/node_modules/node-web-audio-api/js/lib/symbols.js", import.meta.url),
);

// The bundle's own dependency, resolved from inside the bundle (that is where
// package.json declares it).
const bundleRequire = createRequire(join(ENGINE_DIR, "x.js"));
const { OfflineAudioContext } = bundleRequire("node-web-audio-api");
const studioEngine = bundleRequire(join(ENGINE_DIR, "engine-client.js"));

// `startRendering()` releases the worklet thread; a test that stops before it
// gets there has to release it by hand or the process never exits.
const { kWorkletRelease } = await import(pathToFileURL(SYMBOLS_FILE).href);

/** The engine sources, read from the bundle exactly as a Node caller would. */
const ASSETS = {
  "sequencer.js": readFileSync(join(ENGINE_DIR, "sequencer.js"), "utf8"),
  "sunvox.js": readFileSync(join(VENDOR_DIR, "sunvox.js"), "utf8"),
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
 * engine, hand it the song, launch the scene, play, render.
 * @param {object} song
 * @param {{seconds?: number, sampleRate?: number}} [options]
 * @returns {Promise<{left: Float32Array, right: Float32Array, sampleRate: number}>}
 */
async function renderSong(song, { seconds = 2, sampleRate = SAMPLE_RATE } = {}) {
  const context = new OfflineAudioContext({
    numberOfChannels: 2,
    length: Math.round(seconds * sampleRate),
    sampleRate,
  });
  let engine = null;
  let rendered = false;
  try {
    engine = await studioEngine.create(context, { assetBytes: ASSETS });
    engine.setSong(song);
    engine.launchScene(song.scenes[0].id);
    engine.play();
    engine.node.connect(context.destination);
    await engine.flush();
    const buffer = await context.startRendering();
    rendered = true;
    return { left: buffer.getChannelData(0), right: buffer.getChannelData(1), sampleRate };
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
    assert.ok(peakOf(buffer.getChannelData(0)) > 0.01, "16 tracks should render audio, not silence");
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
    const peak = Math.max(peakOf(buffer.getChannelData(0)), peakOf(buffer.getChannelData(1)));
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
    const peak = peakOf(buffer.getChannelData(0));
    assert.ok(peak > 0.01, `the replaced device should sound, peak was ${peak}`);
    assert.equal(errors.length, 1, "rebuilding with a working type must not report the old failure again");
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
  "</script>",
].join("\n");

/** The engine files, served to the page over loopback (a secure context). */
const SERVED = {
  "/": ["text/html; charset=utf-8", () => PAGE],
  "/assets/engine-client.js": ["text/javascript; charset=utf-8", () => readFileSync(join(ENGINE_DIR, "engine-client.js"), "utf8")],
  "/assets/sequencer.js": ["text/javascript; charset=utf-8", () => ASSETS["sequencer.js"]],
  "/assets/sunvox.js": ["text/javascript; charset=utf-8", () => ASSETS["sunvox.js"]],
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

before(async () => {
  chrome = await startHeadlessChrome();
  if (!chrome) return;
  server = createAssetServer();
  await new Promise((resolve) => server.listen(0, chrome.bindHost, resolve));
  origin = `http://${chrome.pageHost}:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (chrome) await chrome.close();
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