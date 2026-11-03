/**
 * Studio engine tests — the worklet that hosts SunVox and the sequencer.
 *
 * The renderer is the real one: `node-web-audio-api`'s OfflineAudioContext for
 * the Node side and headless Chromium (over CDP, like the other live tests) for
 * the browser side, both loading the very same engine through
 * `bundles/studio/engine/engine-client.js`. Nothing here touches the real
 * `~/.crow`, and nothing is written outside a temp directory.
 *
 * Four checks, from the implementation plan:
 *   - a C4 on an Analog generator sounds, and its spectral peak is within 3 %
 *     of 261.6 Hz (this is what pins the MIDI → SunVox note offset);
 *   - a muted track renders silence;
 *   - a 17th track is refused at `setSong` (and 16 tracks — 16 SunVox slots —
 *     still render);
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
  "sunvox_lib_loader.js": readFileSync(join(VENDOR_DIR, "sunvox_lib_loader.js"), "utf8"),
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
  "/assets/sunvox_lib_loader.js": ["text/javascript; charset=utf-8", () => ASSETS["sunvox_lib_loader.js"]],
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