/**
 * Studio amp engine tests — NAM captures and cabinets inside the worklet, and
 * monitoring through the chain (plan 1d, Task 13).
 *
 * An amp insert is the one insert whose sound is a library FILE the operator
 * chose: a NAM capture (`model_id`) through a cabinet IR (`ir_id`), with an
 * input trim, an output trim and an IR mix (`server/doc.js`'s `AMP_PARAMS`).
 * This file pins how the ENGINE plays one:
 *
 *   - an amp insert plays its capture through its cabinet, and the cabinet
 *     really is a convolution (the same capture without it sounds different);
 *   - the convolver matches a direct convolution within 1e-6, which is what its
 *     partitioned FFT has to be worth;
 *   - a legacy (non-A2) capture plays SILENCE and says why ONCE, in the plan's
 *     sentence (Review Focus 1) — never the dry signal;
 *   - a capture posted while the song plays waits for Stop ("Loads when you
 *     stop."), and the insert is silent until then;
 *   - an amp whose capture is not on this device is silent and asks for it once
 *     (Review Focus 5), and a capture that *was* loaded is used the moment the
 *     library has it;
 *   - a cabinet longer than a second is refused with the plan's sentence;
 *   - monitoring through the chain plays the capture through the armed track's
 *     inserts while the take is still recorded DRY by a recorder tapping the
 *     input outside the engine;
 *   - four amps with a cabinet each render faster than real time in Node (the
 *     plan's CPU gate for this task), and the ratio is printed.
 *
 * Two hosts, both the real engine:
 *
 *   - **full renders** through node-web-audio-api's `OfflineAudioContext`, the
 *     way an MCP render runs it (the capture and the cabinet are handed over with
 *     `loadLibrary`, exactly as `server/render.js` does);
 *   - a **stand-in worklet scope**: `studio-processor.js` composed exactly as
 *     `engine-client.js` composes it, evaluated in this thread with the worklet
 *     globals it reads, so a test can post a message between two blocks — which
 *     is the only way to observe "the next block's first frame" honestly.
 *
 * The capture is the real A2 model in `tests/fixtures/nam/a2-example.nam` (MIT,
 * see its README); the legacy one is built here from the same JSON's shape with
 * another architecture, which is what an older trainer writes.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startHeadlessChrome } from "./fixtures/headless-chrome.mjs";

const ENGINE_DIR = fileURLToPath(new URL("../bundles/studio/engine/", import.meta.url));
const BUNDLE_DIR = fileURLToPath(new URL("../bundles/studio/", import.meta.url));
const VENDOR_DIR = fileURLToPath(new URL("../bundles/studio/vendor/sunvox/", import.meta.url));
const SPESSA_DIR = fileURLToPath(new URL("../bundles/studio/vendor/spessasynth/", import.meta.url));
const NAM_DIR = fileURLToPath(new URL("../bundles/studio/vendor/nam/", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./fixtures/nam/a2-example.nam", import.meta.url));
const SYMBOLS_FILE = fileURLToPath(
  new URL("../bundles/studio/node_modules/node-web-audio-api/js/lib/symbols.js", import.meta.url),
);

// The bundle's own dependency, resolved from inside the bundle (that is where
// package.json declares it).
const bundleRequire = createRequire(join(ENGINE_DIR, "x.js"));
const { OfflineAudioContext } = bundleRequire("node-web-audio-api");
const studioEngine = bundleRequire(join(ENGINE_DIR, "engine-client.js"));
const namHostApi = bundleRequire(join(ENGINE_DIR, "nam-host.js"));
const convolverApi = bundleRequire(join(ENGINE_DIR, "convolver.js"));
// The page's own resampler: the PCM a cabinet arrives as is what a page builds
// with this very file, so a length test uses it too.
const resampleApi = bundleRequire(join(ENGINE_DIR, "resample.js"));

// The server's own renderer and WAV encoder: a render's amp files are read and
// decoded the way `server/render.js` does it (plan 1d, Task 13).
const { renderSong: renderStudioSong } = await import("../bundles/studio/server/render.js");
const { encodeWav24 } = await import("../bundles/studio/server/wav.js");

// `startRendering()` releases the worklet thread; a test that stops before it
// gets there has to release it by hand or the process never exits.
const { kWorkletRelease } = await import(pathToFileURL(SYMBOLS_FILE).href);

const SAMPLE_RATE = 48000;
const BLOCK = 128;

/** The A2 capture every test here plays, and what the song calls it. */
const CAPTURE_TEXT = readFileSync(FIXTURE, "utf8");
const CAPTURE_BYTES = new Uint8Array(readFileSync(FIXTURE));
const CAPTURE_ID = "capture-a2";

/** The cabinet: a short, bright, decaying IR at the context's rate. */
const CABINET_ID = "ir-cab";
const CABINET_RATE = SAMPLE_RATE;
const CABINET_FRAMES = 2400;
const CABINET = new Float32Array(CABINET_FRAMES);
for (let at = 0; at < CABINET_FRAMES; at += 1) {
  CABINET[at] = Math.exp(-at / 400) * Math.sin((2 * Math.PI * 1800 * at) / CABINET_RATE) * 0.4;
}
CABINET[0] = 0.9;

/** A legacy capture: the same shape with an architecture Studio does not play. */
const LEGACY_TEXT = JSON.stringify({ ...JSON.parse(CAPTURE_TEXT), architecture: "WaveNet" });
const LEGACY_ID = "capture-legacy";

/** The plan's sentence for an older capture, word for word. */
const LEGACY_SENTENCE =
  "This capture uses an older NAM format; Studio plays A2 captures. Re-export it with a current NAM trainer.";

/** The engine sources, read from the bundle exactly as a Node caller would. */
const ASSETS = {
  "sequencer.js": readFileSync(join(ENGINE_DIR, "sequencer.js"), "utf8"),
  "resample.js": readFileSync(join(ENGINE_DIR, "resample.js"), "utf8"),
  "sampler-voice.js": readFileSync(join(ENGINE_DIR, "sampler-voice.js"), "utf8"),
  "perf-fx.js": readFileSync(join(ENGINE_DIR, "perf-fx.js"), "utf8"),
  "sunvox.js": readFileSync(join(VENDOR_DIR, "sunvox.js"), "utf8"),
  "spessasynth.js": readFileSync(join(SPESSA_DIR, "spessasynth.js"), "utf8"),
  "font-voice.js": readFileSync(join(ENGINE_DIR, "font-voice.js"), "utf8"),
  "dynamics.js": readFileSync(join(ENGINE_DIR, "dynamics.js"), "utf8"),
  "faust-host.js": readFileSync(join(ENGINE_DIR, "faust-host.js"), "utf8"),
  "meter.js": readFileSync(join(ENGINE_DIR, "meter.js"), "utf8"),
  "nam.js": readFileSync(join(NAM_DIR, "nam.js"), "utf8"),
  "nam-host.js": readFileSync(join(ENGINE_DIR, "nam-host.js"), "utf8"),
  "convolver.js": readFileSync(join(ENGINE_DIR, "convolver.js"), "utf8"),
  "studio-processor.js": readFileSync(join(ENGINE_DIR, "studio-processor.js"), "utf8"),
  "sunvox.wasm": readFileSync(join(VENDOR_DIR, "sunvox.wasm")),
  "nam-engine.wasm": readFileSync(join(NAM_DIR, "nam-engine.wasm")),
};

/** The smallest valid wasm module: enough for the processor's own SunVox compile. */
const EMPTY_WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

// --- small numeric helpers --------------------------------------------------

/** @param {Float32Array} samples @returns {number} the largest absolute sample. */
function peakOf(samples) {
  let peak = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.abs(samples[index]);
    if (value > peak) peak = value;
  }
  return peak;
}

/** @param {Float32Array} samples @returns {number} the root mean square. */
function rmsOf(samples) {
  let total = 0;
  for (let index = 0; index < samples.length; index += 1) total += samples[index] * samples[index];
  return Math.sqrt(total / Math.max(1, samples.length));
}

/**
 * @param {Float32Array} left
 * @param {Float32Array} right
 * @returns {number} the largest difference between two equal-length signals
 */
function differenceOf(left, right) {
  let worst = 0;
  const count = Math.min(left.length, right.length);
  for (let at = 0; at < count; at += 1) {
    const diff = Math.abs(left[at] - right[at]);
    if (diff > worst) worst = diff;
  }
  return worst;
}

/** @returns {Float32Array} `frames` of a 220 Hz sine at 0.3, the DI signal. */
function sineTake(frames, rate = SAMPLE_RATE) {
  const samples = new Float32Array(frames);
  for (let at = 0; at < frames; at += 1) {
    samples[at] = Math.sin((2 * Math.PI * 220 * at) / rate) * 0.3;
  }
  return samples;
}

// --- the engine's own module ------------------------------------------------

/**
 * Compose the worklet module exactly as `engine-client.js` does and evaluate it
 * with stand-in worklet globals, handing back the processor class it registered.
 * @param {number} [rate] the context's sample rate
 * @returns {Function} the processor class
 */
const PROCESSOR_CLASSES = new Map();
function processorClass(rate = SAMPLE_RATE) {
  const known = PROCESSOR_CLASSES.get(rate);
  if (known) return known;
  const texts = studioEngine.SOURCE_FILES.map((name) => ASSETS[name]);
  const source = studioEngine.composeEngineModule(texts);
  let registered = null;
  // The worklet globals `studio-processor.js` reads. `sampleRate` and
  // `currentFrame` are bare identifiers there, so they are parameters here.
  class StandInProcessor {
    constructor() {
      this.port = { onmessage: null, postMessage: () => {}, start: () => {} };
    }
  }
  const evaluate = new Function("AudioWorkletProcessor", "registerProcessor", "sampleRate", "currentFrame", source);
  evaluate(
    StandInProcessor,
    (name, cls) => {
      registered = { name: name, cls: cls };
    },
    rate,
    0,
  );
  assert.ok(registered, "the module has to register the studio processor");
  PROCESSOR_CLASSES.set(rate, registered.cls);
  return registered.cls;
}

/** @returns {Promise<void>} a macrotask, so promise work settles. */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 1));
}

/**
 * Wait for something the processor posted to arrive.
 * @param {() => boolean} predicate
 * @param {number} [ms]
 * @returns {Promise<boolean>} whether it happened in time
 */
async function waitFor(predicate, ms = 10000) {
  const deadline = Date.now() + ms;
  while (!predicate() && Date.now() < deadline) await settle();
  return predicate();
}

/**
 * One processor running the real worklet code, with helpers to post messages
 * between blocks and to render them by hand.
 * @param {number} [rate] the context's sample rate
 * @returns {Promise<{processor: object, posts: object[], post: Function,
 *                    flush: Function, run: Function, blocks: number}>}
 */
async function processorHost(rate = SAMPLE_RATE) {
  const Loaded = processorClass(rate);
  const posts = [];
  const processor = new Loaded({ processorOptions: { wasmBinary: EMPTY_WASM } });
  processor.port.postMessage = (message) => posts.push(message);
  // The NAM engine's bytes come over the port like everything else (the worklet
  // has no fetch), so this is the very path a page takes.
  processor.port.onmessage({ data: { type: "nam-wasm", bytes: Uint8Array.from(ASSETS["nam-engine.wasm"]) } });
  await settle();
  const ready = await waitFor(() => posts.some((message) => message.type === "ready"));
  assert.ok(ready, `the processor has to come up and report ready, it posted ${JSON.stringify(posts)}`);

  /** @param {object} message @returns {void} */
  const post = (message) => {
    processor.port.onmessage({ data: message });
  };

  let flushSeq = 0;
  /** @returns {Promise<void>} resolves once everything posted before it is applied. */
  const flush = async () => {
    flushSeq += 1;
    const id = flushSeq;
    post({ type: "flush", id: id });
    const applied = await waitFor(() => posts.some((message) => message.type === "flushed" && message.id === id));
    if (!applied) throw new Error("the processor never answered a flush");
  };

  let rendered = 0;
  /**
   * Render `blocks` blocks of 128 frames and hand back what came out.
   * @param {number} blocks
   * @returns {{left: Float32Array, right: Float32Array}}
   */
  const run = (blocks) => {
    const total = blocks * BLOCK;
    const left = new Float32Array(total);
    const right = new Float32Array(total);
    for (let index = 0; index < blocks; index += 1) {
      const start = index * BLOCK;
      processor.process([], [[left.subarray(start, start + BLOCK), right.subarray(start, start + BLOCK)]]);
    }
    rendered += blocks;
    return { left: left, right: right };
  };

  return {
    processor: processor,
    posts: posts,
    post: post,
    flush: flush,
    run: run,
    get blocks() {
      return rendered;
    },
  };
}

/** @param {object[]} posts @param {string} type @returns {object[]} */
function postsOfType(posts, type) {
  return posts.filter((message) => message.type === type);
}

/** @returns {number} the frames one beat lasts at a tempo. */
function framesPerBeat(bpm) {
  return Math.round((SAMPLE_RATE * 60) / bpm);
}

/**
 * One amp insert on one track.
 * @param {object} [params] the amp's parameters
 * @param {object} [over] the insert's own fields
 * @returns {object}
 */
function ampInsert(params = {}, over = {}) {
  return {
    id: "insert-amp",
    owner: "track:track-1",
    kind: "amp",
    order: 0,
    bypass: false,
    params: {
      model_id: CAPTURE_ID,
      ir_id: "",
      input_db: 0,
      output_db: 0,
      ir_mix: 1,
      ...params,
    },
    ...over,
  };
}

/**
 * A song of one audio track playing one bar of `take-1`, with the inserts given.
 * @param {object[]} inserts
 * @param {{gain_db?: number, length_bars?: number}} [options]
 * @returns {object}
 */
function ampSong(inserts, options = {}) {
  const container = {};
  for (const insert of inserts) container[insert.id] = insert;
  return {
    meta: { title: "Amp test", bpm: 125, meter: [4, 4], key: "C major" },
    tracks: [
      {
        id: "track-1",
        name: "Guitar",
        color: "#E8C07A",
        device: { engine: "audio" },
        mute: false,
        solo: false,
        gain_db: options.gain_db === undefined ? 0 : options.gain_db,
        pan: 0,
        locked: false,
      },
    ],
    scenes: [{ id: "scene-1", name: "A" }],
    clips: {
      "clip-1": {
        id: "clip-1",
        track_id: "track-1",
        scene_id: "scene-1",
        name: "DI",
        length_bars: options.length_bars === undefined ? 1 : options.length_bars,
        kind: "audio",
        notes: [],
        comp: [{ take_id: "take-1", from_beat: 0, to_beat: 4 }],
      },
    },
    inserts: container,
    library: {
      [CAPTURE_ID]: { id: CAPTURE_ID, kind: "nam", name: "A2 capture", source: "upload" },
      [CABINET_ID]: { id: CABINET_ID, kind: "ir", name: "Cabinet", source: "upload" },
    },
  };
}

/**
 * Post the cabinet as the page does: decoded PCM at the context's rate.
 * @param {object} host a `processorHost()`
 * @param {number} [requestId]
 * @returns {void}
 */
function postCabinet(host, requestId = "cabinet") {
  host.post({
    type: "library",
    request_id: requestId,
    library_id: CABINET_ID,
    kind: "ir",
    channels: [Float32Array.from(CABINET)],
    rate: CABINET_RATE,
  });
}

/**
 * Post the A2 capture as the page does: the `.nam` file's own bytes.
 * @param {object} host
 * @param {number|string} [requestId]
 * @param {string} [libraryId]
 * @param {string} [text]
 * @returns {void}
 */
function postCapture(host, requestId = "capture", libraryId = CAPTURE_ID, text = CAPTURE_TEXT) {
  host.post({
    type: "library",
    request_id: requestId,
    library_id: libraryId,
    kind: "nam",
    bytes: new TextEncoder().encode(text),
  });
}

/**
 * Start one song: the song, one bar of DI, the scene, Play.
 * @param {object} host
 * @param {object} song
 * @param {number} [rate]
 * @returns {Promise<void>}
 */
async function startSong(host, song, rate = SAMPLE_RATE) {
  host.post({ type: "song", snapshot: song });
  host.post({ type: "audio", take_id: "take-1", channels: [sineTake(rate)] });
  await host.flush();
  host.post({ type: "launchScene", id: "scene-1" });
  host.post({ type: "play" });
  await host.flush();
}

/**
 * Every runner a chain holds, the paths a blend is fading and the runners an edit
 * has retired included.
 * @param {object[]} chain
 * @param {object[]} [out]
 * @returns {object[]}
 */
function chainRunners(chain, out = []) {
  for (const node of chain || []) {
    if (!node) continue;
    if (node.blend) {
      chainRunners(node.leaving, out);
      chainRunners(node.fresh, out);
      continue;
    }
    out.push(node);
  }
  return out;
}

/**
 * One insert's runner, from the live chains of every owner.
 * @param {object} host
 * @param {string} insertId
 * @param {string} [trackId] the track whose chain to look in (every owner if absent)
 * @returns {object[]} every runner of that insert the chains still hold
 */
function runnersOf(host, insertId, trackId = undefined) {
  const found = [];
  const records = [host.processor.masterRecord, ...host.processor.returns, ...host.processor.slots];
  for (const record of records) {
    if (!record) continue;
    if (trackId !== undefined && record.track_id !== trackId) continue;
    for (const runner of chainRunners(record.chain)) {
      if (runner.id === insertId && runner.insert) found.push(runner);
    }
  }
  return found;
}

/**
 * The state of one amp insert (`params()`), from the chain that is playing it.
 * @param {object} host
 * @param {string} [insertId]
 * @param {string} [trackId]
 * @returns {object}
 */
function ampStateOf(host, insertId = "insert-amp", trackId = "track-1") {
  const runners = runnersOf(host, insertId, trackId);
  assert.ok(runners.length > 0, `the amp insert ${insertId} has to be in the chain`);
  return runners[0].insert.params();
}

// --- full renders through the real engine -----------------------------------

/**
 * Render one song offline in Node, the way an MCP render does: build the
 * engine, hand it the capture and the cabinet its amp inserts name, hand it the
 * song, launch the scene, play, render.
 * @param {object} song
 * @param {{seconds?: number, capture?: boolean, cabinet?: boolean}} [options]
 * @returns {Promise<{left: Float32Array, right: Float32Array, sampleRate: number,
 *                    millis: number}>}
 */
async function renderSong(song, options = {}) {
  const seconds = options.seconds === undefined ? 1 : options.seconds;
  const context = new OfflineAudioContext({
    numberOfChannels: 2,
    length: Math.round(seconds * SAMPLE_RATE),
    sampleRate: SAMPLE_RATE,
  });
  let engine = null;
  let rendered = false;
  const started = Date.now();
  try {
    engine = await studioEngine.create(context, { assetBytes: ASSETS });
    if (options.capture !== false) {
      const result = await engine.loadLibrary(CAPTURE_ID, "nam", Uint8Array.from(CAPTURE_BYTES));
      assert.equal(result.status, "loaded", `the capture has to load, it came back ${JSON.stringify(result)}`);
    }
    if (options.cabinet === true) {
      const result = await engine.loadLibrary(CABINET_ID, "ir", [Float32Array.from(CABINET)]);
      assert.equal(result.status, "loaded", `the cabinet has to load, it came back ${JSON.stringify(result)}`);
    }
    await engine.loadAudio("take-1", [sineTake(Math.round(seconds * SAMPLE_RATE))], SAMPLE_RATE);
    engine.setSong(song);
    engine.launchScene(song.scenes[0].id);
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
    return { left: left, right: right, sampleRate: SAMPLE_RATE, millis: Date.now() - started };
  } finally {
    if (engine) engine.dispose();
    if (!rendered) await releaseWorklet(context);
  }
}

/** @param {BaseAudioContext} context @returns {Promise<void>} */
async function releaseWorklet(context) {
  try {
    await context.audioWorklet[kWorkletRelease]();
  } catch {
    /* nothing to release */
  }
}

// --- the tests --------------------------------------------------------------

test("an amp insert plays its capture through its cabinet", async () => {
  const dry = await renderSong(ampSong([]), { seconds: 1 });
  assert.ok(peakOf(dry.left) > 0.05, `the DI has to be audible to compare anything, peak ${peakOf(dry.left)}`);

  const amped = await renderSong(ampSong([ampInsert()]), { seconds: 1 });
  const ampedPeak = peakOf(amped.left);
  assert.ok(ampedPeak > 0.001, `the capture has to make sound, peak ${ampedPeak}`);
  const change = differenceOf(amped.left, dry.left);
  assert.ok(
    change > 0.001,
    `the capture has to CHANGE the signal; the largest difference from the dry render was ${change}`,
  );

  // The cabinet is a convolution of the capture's output: the same capture with
  // an IR sounds different, and with the IR mix at 0 it is the capture alone.
  const cabinet = await renderSong(ampSong([ampInsert({ ir_id: CABINET_ID })]), {
    seconds: 1,
    cabinet: true,
  });
  assert.ok(peakOf(cabinet.left) > 0.001, `the amp through a cabinet has to sound, peak ${peakOf(cabinet.left)}`);
  const cabinetChange = differenceOf(cabinet.left, amped.left);
  assert.ok(
    cabinetChange > 0.001,
    `the cabinet has to change the sound; the largest difference was ${cabinetChange}`,
  );

  const dryMix = await renderSong(ampSong([ampInsert({ ir_id: CABINET_ID, ir_mix: 0 })]), {
    seconds: 1,
    cabinet: true,
  });
  const dryMixChange = differenceOf(dryMix.left, amped.left);
  assert.ok(
    dryMixChange < 1e-6,
    `an IR mix of 0 is the capture with no cabinet at all; the largest difference was ${dryMixChange}`,
  );
});

test("the convolver matches direct convolution within 1e-6", () => {
  const ir = new Float32Array(3000);
  for (let at = 0; at < ir.length; at += 1) {
    ir[at] = Math.exp(-at / 300) * Math.sin((2 * Math.PI * 900 * at) / SAMPLE_RATE) * 0.5;
  }
  ir[0] = 1;
  const convolver = convolverApi.create({ channels: [ir], rate: SAMPLE_RATE });
  assert.equal(convolver.latencyFrames, 0, "the first partition is direct, so the convolver is zero latency");

  const frames = 8192;
  const input = new Float32Array(frames);
  for (let at = 0; at < frames; at += 1) {
    input[at] = Math.sin((2 * Math.PI * 220 * at) / SAMPLE_RATE) * 0.3 + Math.sin(at / 5) * 0.1;
  }
  const left = Float32Array.from(input);
  const right = Float32Array.from(input);
  // Runs of 1, 32, 128 and 200 frames, so the block boundaries are the
  // convolver's own and never the caller's.
  const sizes = [1, 32, 128, 200, 64];
  let at = 0;
  let step = 0;
  while (at < frames) {
    const count = Math.min(sizes[step % sizes.length], frames - at);
    convolver.process(left.subarray(at, at + count), right.subarray(at, at + count), count);
    at += count;
    step += 1;
  }

  let worst = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    for (let tap = 0; tap < ir.length && tap <= frame; tap += 1) sum += ir[tap] * input[frame - tap];
    worst = Math.max(worst, Math.abs(sum - left[frame]));
  }
  assert.ok(worst < 1e-6, `the partitioned convolver has to match a direct one; the worst difference was ${worst}`);

  // A cabinet longer than a second is refused with the plan's sentence.
  const tooLong = new Float32Array(SAMPLE_RATE + 4800);
  assert.equal(
    convolverApi.lengthProblem(tooLong.length, SAMPLE_RATE),
    "An impulse response is at most 1 second long; this one is 1.1 s.",
  );
  assert.throws(() => convolverApi.create({ channels: [tooLong], rate: SAMPLE_RATE }), /at most 1 second long/);
});

test("a starter cabinet loads at 44.1, 48, 96, 176.4 and 192 kHz", async () => {
  // The five starter cabinets ship as 24-bit stereo 44.1 kHz files of 44101
  // frames: exactly one second plus one frame. The page checks the FILE at its
  // own rate (44101 <= 44100 + 2), but the engine used to re-check the RESAMPLED
  // PCM at the context's rate, where those frames are 176404 at 176.4 kHz — and
  // refused a cabinet the page had just accepted. The rule is now judged once,
  // at the file's rate, and the engine accepts the length that follows from it.
  const STARTER_RATE = 44100;
  const STARTER_FRAMES = 44101;
  const starter = new Float32Array(STARTER_FRAMES);
  starter[0] = 0.9;
  for (let at = 1; at < STARTER_FRAMES; at += 1) {
    starter[at] = Math.exp(-at / 4000) * Math.sin((2 * Math.PI * 1200 * at) / STARTER_RATE) * 0.3;
  }

  for (const rate of [44100, 48000, 96000, 176400, 192000]) {
    const channels =
      rate === STARTER_RATE ? [Float32Array.from(starter)] : resampleApi.toRate([starter], STARTER_RATE, rate);
    const convolver = convolverApi.create({
      channels: channels,
      rate: rate,
      sourceFrames: STARTER_FRAMES,
      sourceRate: STARTER_RATE,
    });
    assert.equal(convolver.frames, channels[0].length, `the whole cabinet is kept at ${rate} Hz`);
    assert.equal(convolver.latencyFrames, 0, "and it is still zero latency");
  }

  // The very length the old check refused: 44.1 kHz frames resampled to 176.4 kHz
  // is longer than a second AT THAT RATE, and is still the same cabinet.
  const high = resampleApi.toRate([starter], STARTER_RATE, 176400);
  assert.equal(high[0].length, 176404, "44101 frames at 44.1 kHz are 176404 at 176.4 kHz");
  // The tolerance grows with the rate (max(2, ceil(3·rate/44100)) frames), so
  // even judged at the context rate alone the converted starter fits.
  assert.equal(convolverApi.lengthProblem(high[0].length, 176400), null);
  assert.equal(convolverApi.lengthProblem(high[0].length, 176400, STARTER_FRAMES, STARTER_RATE), null);

  // The rule is still a rule: a payload that claims a short file and carries far
  // more PCM than that file could resample to is refused.
  assert.match(
    String(convolverApi.lengthProblem(200000, 192000, STARTER_FRAMES, STARTER_RATE)),
    /at most 1 second long/,
  );
  // ... and a file that really is over a second is refused with ITS length.
  assert.equal(
    convolverApi.lengthProblem(52800, 48000, 52800, 48000),
    "An impulse response is at most 1 second long; this one is 1.1 s.",
  );

  // The engine's own message path, at the two rates that used to refuse it: the
  // page sends the file's rate and length with the PCM, and the cabinet loads.
  for (const rate of [176400, 192000]) {
    const host = await processorHost(rate);
    const channels = resampleApi.toRate([starter], STARTER_RATE, rate);
    host.post({
      type: "library",
      request_id: `starter-${rate}`,
      library_id: "ir-starter",
      kind: "ir",
      channels: channels,
      rate: rate,
      source_rate: STARTER_RATE,
      source_frames: STARTER_FRAMES,
    });
    await host.flush();
    const answer = postsOfType(host.posts, "library_loaded").filter(
      (message) => message.request_id === `starter-${rate}`,
    );
    assert.equal(answer.length, 1, `the load has to be answered at ${rate} Hz, got ${JSON.stringify(host.posts)}`);
    assert.equal(answer[0].ok, true, `a 44.1 kHz starter cabinet has to load at ${rate} Hz`);
  }
});

test("a legacy capture plays silence and says why once", async () => {
  const host = await processorHost();
  postCapture(host, "legacy", LEGACY_ID, LEGACY_TEXT);
  await host.flush();

  const failed = postsOfType(host.posts, "library_failed").filter((message) => message.library_id === LEGACY_ID);
  assert.equal(failed.length, 1, `a legacy capture has to be reported once, got ${JSON.stringify(failed)}`);
  assert.equal(failed[0].reason, LEGACY_SENTENCE, "the plan's sentence, word for word");

  const answer = postsOfType(host.posts, "library_loaded").filter((message) => message.request_id === "legacy");
  assert.equal(answer.length, 1, `the load has to be answered, got ${JSON.stringify(answer)}`);
  assert.equal(answer[0].ok, false);
  assert.equal(answer[0].reason, LEGACY_SENTENCE);

  // The song that names it plays silence, and the sentence is not repeated.
  await startSong(host, ampSong([ampInsert({ model_id: LEGACY_ID })]));
  const silence = host.run(64);
  assert.ok(peakOf(silence.left) < 1e-9, `a legacy capture has to be SILENT, peak ${peakOf(silence.left)}`);
  assert.ok(peakOf(silence.right) < 1e-9, "silent on both sides");
  assert.equal(
    postsOfType(host.posts, "library_failed").filter((message) => message.library_id === LEGACY_ID).length,
    1,
    "the same legacy capture is not reported twice",
  );
});

test("a load while playing waits for stop", async () => {
  const host = await processorHost();
  await startSong(host, ampSong([ampInsert()]));

  // Play first, then post the capture: it is parsed only while the transport is
  // stopped, so the page is told "Loads when you stop." and the insert is silent.
  postCapture(host, "while-playing");
  await host.flush();
  assert.deepEqual(
    postsOfType(host.posts, "library_deferred").filter((message) => message.request_id === "while-playing"),
    [{ type: "library_deferred", library_id: CAPTURE_ID, request_id: "while-playing" }],
    "a capture posted while the song plays has to be deferred",
  );
  const silent = host.run(8);
  assert.ok(peakOf(silent.left) < 1e-9, `a deferred capture must not play, peak ${peakOf(silent.left)}`);

  // Stop parses it, and the same take plays through the capture after that.
  host.post({ type: "stop" });
  await host.flush();
  assert.equal(
    postsOfType(host.posts, "library_loaded").filter((message) => message.library_id === CAPTURE_ID && message.ok)
      .length,
    1,
    "Stop has to parse the capture that waited",
  );

  host.post({ type: "play" });
  await host.flush();
  const playing = host.run(64);
  assert.ok(peakOf(playing.left) > 0.001, `the capture that waited for Stop has to sound, peak ${peakOf(playing.left)}`);
});

test("an amp whose capture is not on this device is silent and says so", async () => {
  const host = await processorHost();
  await startSong(host, ampSong([ampInsert()]));

  const silent = host.run(32);
  assert.ok(peakOf(silent.left) < 1e-9, `an amp with no capture here has to be silent, peak ${peakOf(silent.left)}`);
  const needed = postsOfType(host.posts, "library_needed").filter((message) => message.library_id === CAPTURE_ID);
  assert.equal(needed.length, 1, `the engine has to ask for it once, got ${JSON.stringify(needed)}`);

  // A capture that arrives makes the SAME song sound. It lands while the song
  // plays, so it waits for Stop ("Loads when you stop.") and the next Play plays
  // it: an amp insert reads the library as it is, never as it was when the
  // insert was built.
  postCapture(host, "late", CAPTURE_ID);
  await host.flush();
  host.post({ type: "stop" });
  await host.flush();
  host.post({ type: "play" });
  await host.flush();
  const playing = host.run(64);
  assert.ok(peakOf(playing.left) > 0.001, `the capture that arrived has to play, peak ${peakOf(playing.left)}`);
});

test("a cabinet over a second is refused with the plan's sentence", async () => {
  const host = await processorHost();
  const tooLong = new Float32Array(SAMPLE_RATE + 4800);
  tooLong[0] = 1;
  host.post({
    type: "library",
    request_id: "long-ic",
    library_id: "ir-long",
    kind: "ir",
    channels: [tooLong],
    rate: SAMPLE_RATE,
  });
  await host.flush();
  const answer = postsOfType(host.posts, "library_loaded").filter((message) => message.request_id === "long-ic");
  assert.equal(answer.length, 1, `the load has to be answered, got ${JSON.stringify(answer)}`);
  assert.equal(answer[0].ok, false);
  assert.equal(answer[0].reason, "An impulse response is at most 1 second long; this one is 1.1 s.");
});

test("monitoring through the chain plays the amp while the take is recorded dry", async () => {
  const host = await processorHost();
  postCapture(host, "monitor", CAPTURE_ID);
  host.post({ type: "song", snapshot: ampSong([ampInsert()]) });
  host.post({ type: "audio", take_id: "take-1", channels: [new Float32Array(SAMPLE_RATE)] });
  await host.flush();
  host.post({ type: "monitor", track_id: "track-1", on: true });
  host.post({ type: "launchScene", id: "scene-1" });
  host.post({ type: "play" });
  await host.flush();

  // The input the interface sends: the DI. The engine is handed it as its own
  // `inputs[0]`, exactly as an AudioWorkletNode hands a connected input over.
  const blocks = 8;
  const input = sineTake(blocks * BLOCK);
  const inputLeft = Float32Array.from(input);
  const inputRight = Float32Array.from(input);
  const left = new Float32Array(blocks * BLOCK);
  const right = new Float32Array(blocks * BLOCK);
  for (let index = 0; index < blocks; index += 1) {
    const start = index * BLOCK;
    host.processor.process(
      [[input.subarray(start, start + BLOCK), input.subarray(start, start + BLOCK)]],
      [[left.subarray(start, start + BLOCK), right.subarray(start, start + BLOCK)]],
    );
  }

  // What is heard is the CAPTURE (monitoring through the chain), at the track's
  // own fader: not the dry input.
  assert.ok(peakOf(left) > 0.001, `monitoring has to be audible, peak ${peakOf(left)}`);
  const scaled = new Float32Array(input.length);
  for (let at = 0; at < input.length; at += 1) scaled[at] = input[at] * Math.SQRT1_2;
  assert.ok(
    differenceOf(left, scaled) > 0.001,
    "what is heard has to be the CAPTURE, not the dry input through the fader",
  );

  // ... and the input the engine was handed is untouched, bit for bit: the dry
  // signal is what the recorder taps, because nothing in the engine writes it.
  assert.equal(differenceOf(inputLeft, inputRight), 0, "the two input channels stay as they arrived");
  assert.equal(
    differenceOf(input, sineTake(input.length)),
    0,
    "the engine must not write into the input it was handed: that is the take's signal",
  );

  // The recorder worklet, driven on that very signal, encodes the dry input
  // sample for sample at 24 bits — the take is the DI, never the amp.
  const recorded = recordDry(input);
  assert.ok(
    recorded.length >= input.length - 8,
    `the take has to hold the input, it holds ${recorded.length} (${JSON.stringify(
      messagesOfLastRecording.map((message) => ({
        type: message.type,
        error: message.error,
        bytes: message.bytes && message.bytes.byteLength,
        frames: message.frames,
        segments: message.segments,
      })),
    )})`,
  );
  const worst = differenceOf(recorded.subarray(0, input.length), input);
  assert.ok(worst < 1e-6, `the take has to be the dry input; the largest difference was ${worst}`);
  assert.ok(rmsOf(recorded) > 0.1, "the take has to hold the performance");
});

/**
 * Run the real recorder worklet over one channel of input, in this thread, and
 * hand back the 24-bit PCM it wrote as floats. It is the same file the page
 * loads with its own `addModule()`, driven block by block.
 * @param {Float32Array} input
 * @returns {Float32Array}
 */
let messagesOfLastRecording = [];
function recordDry(input) {
  let registered = null;
  class StandInRecorder {
    constructor() {
      this.port = { onmessage: null, postMessage: () => {}, start: () => {} };
    }
  }
  const source = readFileSync(join(ENGINE_DIR, "recorder-processor.js"), "utf8");
  const evaluate = new Function(
    "AudioWorkletProcessor",
    "registerProcessor",
    "sampleRate",
    "currentFrame",
    source,
  );
  evaluate(
    StandInRecorder,
    (name, cls) => {
      registered = cls;
    },
    SAMPLE_RATE,
    0,
  );
  assert.ok(registered, "the recorder worklet has to register its processor");
  const messages = [];
  const recorder = new registered({ processorOptions: { channels: 1 } });
  recorder.port.postMessage = (message) => messages.push(message);
  recorder.port.onmessage({ data: { type: "arm", frame: 0 } });
  recorder.port.onmessage({ data: { type: "stop", frame: input.length } });
  const silent = new Float32Array(BLOCK);
  const padded = new Float32Array(input.length + BLOCK);
  padded.set(input);
  // One block past the stop frame, so the recorder reaches it and flushes.
  for (let at = 0; at < padded.length; at += BLOCK) {
    const count = Math.min(BLOCK, padded.length - at);
    const piece = padded.subarray(at, at + count);
    recorder.process([[piece, piece]], [[silent.subarray(0, count), silent.subarray(0, count)]]);
  }
  messagesOfLastRecording = messages;
  return decodeRecorderChunks(messages.filter((message) => message.type === "chunk"));
}
/**
 * The recorder's 24-bit little-endian chunks as one float channel.
 * @param {Array<{type: string, bytes: ArrayBuffer, segment: number, index: number}>} chunks
 * @returns {Float32Array}
 */
function decodeRecorderChunks(chunks) {
  const ordered = chunks
    .slice()
    .sort((left, right) => (left.segment === right.segment ? left.index - right.index : left.segment - right.segment));
  let total = 0;
  for (const chunk of ordered) total += chunk.bytes.byteLength / 3;
  const samples = new Float32Array(total);
  let at = 0;
  for (const chunk of ordered) {
    const view = new DataView(chunk.bytes);
    for (let offset = 0; offset + 3 <= view.byteLength; offset += 3) {
      let value = view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16);
      if (value & 0x800000) value -= 0x1000000;
      samples[at] = value / 8388607;
      at += 1;
    }
  }
  return samples.subarray(0, at);
}

test("the slim size is a page's choice, and a render keeps the full capture", async () => {
  // Plan 1d: a lighter size is an A2 capture's `slimSize`, chosen PER PAGE and
  // never written to the document — a phone or a Chromebook gets the smallest
  // submodel, and a host with no `navigator` at all (a Node render) the full one,
  // so a render is the sound the document names.
  assert.equal(namHostApi.slimSizeOf([0.5, 1], 4), 0.25, "four cores is the smallest submodel's midpoint");
  assert.ok(namHostApi.slimSizeOf([0.5, 1], 4) < 0.5, "a size below the first breakpoint selects it");
  assert.equal(namHostApi.slimSizeOf([0.5, 1], 8), -1, "more than four cores is the full model");
  assert.equal(namHostApi.slimSizeOf([0.5, 1], 0), -1, "a host with no core count is the full model");
  assert.equal(namHostApi.slimSizeOf([], 4), -1, "a capture with no breakpoints is not slimmable");

  const wasm = new Uint8Array(ASSETS["nam-engine.wasm"]);
  const render = namHostApi.create({ sampleRate: SAMPLE_RATE });
  assert.equal(render.cores, 0, "a Node render reports no cores");
  await render.setWasm(wasm);
  const full = render.loadModel("insert:1", CAPTURE_TEXT);
  if (full.slimmable) assert.equal(full.slimSize, -1, "a render plays the full capture");
  render.destroy();

  const phone = namHostApi.create({ sampleRate: SAMPLE_RATE, cores: 4 });
  await phone.setWasm(wasm);
  const slim = phone.loadModel("insert:1", CAPTURE_TEXT);
  if (slim.slimmable) {
    assert.ok(slim.slimSize >= 0, "a four-core page asks for a slim size");
    for (const breakpoint of slim.breakpoints) {
      assert.ok(slim.slimSize < breakpoint, "the slim size sits below every breakpoint, so it selects the smallest");
    }
  }
  phone.destroy();
});

test("a render loads the capture and the cabinet an amp insert names", async () => {
  // The server renderer reads a render's files itself (`libraryBytes`), decodes a
  // cabinet's stored 24-bit WAV, resamples it to the render's rate and hands both
  // to the engine before Play — the page's own two steps. A file this device does
  // not hold leaves the insert silent and is named in `missing_library`.
  const song = ampSong([ampInsert({ ir_id: CABINET_ID })]);
  const take = sineTake(SAMPLE_RATE);
  const libraryBytes = async (entry) => {
    if (entry.kind === "nam") return Uint8Array.from(CAPTURE_BYTES);
    const right = new Float32Array(CABINET.length);
    for (let at = 0; at < CABINET.length; at += 1) right[at] = CABINET[at] * 0.5;
    return encodeWav24(CABINET, right, SAMPLE_RATE);
  };

  const heard = await renderStudioSong(song, {
    seconds: 1,
    sampleRate: SAMPLE_RATE,
    takeAudio: async () => ({ rate: SAMPLE_RATE, channels: [Float32Array.from(take)] }),
    libraryBytes: libraryBytes,
  });
  assert.deepEqual(heard.missing_library, [], "both files were there, so nothing is missing");
  assert.ok(peakOf(heard.left) > 0.001, `the rendered amp has to sound, peak ${peakOf(heard.left)}`);

  // The same song on a device that holds neither file: the insert is silent and
  // both entries are named, never thrown.
  const missing = await renderStudioSong(song, {
    seconds: 1,
    sampleRate: SAMPLE_RATE,
    takeAudio: async () => ({ rate: SAMPLE_RATE, channels: [Float32Array.from(take)] }),
    libraryBytes: async () => null,
  });
  assert.deepEqual(
    missing.missing_library.map((item) => item.id).sort(),
    [CAPTURE_ID, CABINET_ID].sort(),
    `both files have to be reported, got ${JSON.stringify(missing.missing_library)}`,
  );
  assert.ok(peakOf(missing.left) < 1e-9, `a silent amp renders silence, peak ${peakOf(missing.left)}`);
});

test("four amps render faster than real time in Node", async () => {
  // Four tracks, each with its own amp insert and cabinet: the plan's CPU gate
  // for this task. Every insert is a separate NAM instance in the one shared
  // wasm module, and every cabinet its own partitioned convolution.
  const seconds = 30;
  const tracks = [];
  const inserts = {};
  const clips = {};
  for (let index = 1; index <= 4; index += 1) {
    const id = `track-${index}`;
    tracks.push({
      id: id,
      name: `Amp ${index}`,
      color: "#8FC1E8",
      device: { engine: "audio" },
      mute: false,
      solo: false,
      gain_db: -12,
      pan: 0,
      locked: false,
    });
    inserts[`insert-${index}`] = {
      id: `insert-${index}`,
      owner: `track:${id}`,
      kind: "amp",
      order: 0,
      bypass: false,
      params: { model_id: CAPTURE_ID, ir_id: CABINET_ID, input_db: 0, output_db: 0, ir_mix: 1 },
    };
    clips[`clip-${index}`] = {
      id: `clip-${index}`,
      track_id: id,
      scene_id: "scene-1",
      name: "DI",
      length_bars: 1,
      kind: "audio",
      notes: [],
      comp: [{ take_id: `take-${index}`, from_beat: 0, to_beat: 4 }],
    };
  }
  const song = {
    meta: { title: "Four amps", bpm: 125, meter: [4, 4], key: "C major" },
    tracks: tracks,
    scenes: [{ id: "scene-1", name: "A" }],
    clips: clips,
    inserts: inserts,
    library: {
      [CAPTURE_ID]: { id: CAPTURE_ID, kind: "nam", name: "A2 capture", source: "upload" },
      [CABINET_ID]: { id: CABINET_ID, kind: "ir", name: "Cabinet", source: "upload" },
    },
  };

  const context = new OfflineAudioContext({
    numberOfChannels: 2,
    length: Math.round(seconds * SAMPLE_RATE),
    sampleRate: SAMPLE_RATE,
  });
  let engine = null;
  let rendered = false;
  const started = Date.now();
  try {
    engine = await studioEngine.create(context, { assetBytes: ASSETS });
    for (let index = 1; index <= 4; index += 1) {
      const answer = await engine.loadLibrary(CAPTURE_ID, "nam", Uint8Array.from(CAPTURE_BYTES));
      assert.equal(answer.status, "loaded");
      const cabinet = await engine.loadLibrary(CABINET_ID, "ir", [Float32Array.from(CABINET)]);
      assert.equal(cabinet.status, "loaded");
      const take = sineTake(SAMPLE_RATE);
      for (let at = 0; at < take.length; at += 1) take[at] *= 0.5 + index / 8;
      await engine.loadAudio(`take-${index}`, [take], SAMPLE_RATE);
    }
    engine.setSong(song);
    engine.launchScene("scene-1");
    engine.play();
    engine.node.connect(context.destination);
    await engine.flush();
    const buffer = await context.startRendering();
    rendered = true;
    const left = new Float32Array(buffer.length);
    buffer.copyFromChannel(left, 0);
    const millis = Date.now() - started;
    const ratio = millis / (seconds * 1000);
    console.log(
      `four amps: ${(millis / 1000).toFixed(2)} s of work for ${seconds} s of audio (ratio ${ratio.toFixed(3)})`,
    );
    assert.ok(peakOf(left) > 0.001, `the four amps have to make sound, peak ${peakOf(left)}`);
    // The plan's gate is "faster than real time on crow". A shared CI runner,
    // busy with the whole suite in parallel, gets a wider bound that still
    // catches a pathological slowdown without failing on noisy neighbours.
    const bound = process.env.CI ? 3 : 1;
    assert.ok(ratio < bound, `four amps have to render faster than ${bound}× real time here; ratio ${ratio.toFixed(3)}`);
  } finally {
    if (engine) engine.dispose();
    if (!rendered) await releaseWorklet(context);
  }
});

// --- the review's fixes: attach once, per-object instances, the rate bridge ---

/** A second capture library id, playing the same A2 fixture. */
const CAPTURE_B_ID = "capture-a2-b";

/** One compressor insert, the second half of a chain a reorder can be observed in. */
function compressorInsert(order) {
  return {
    id: "insert-comp",
    owner: "track:track-1",
    kind: "compressor",
    order: order,
    bypass: false,
    params: {},
  };
}

/**
 * The frames of a run that are not silent, for a continuity check: a gap is a
 * stretch of blocks with nothing in them.
 * @param {Float32Array} samples
 * @returns {number} how many blocks of 128 hold no signal at all
 */
function silentBlocks(samples) {
  let silent = 0;
  for (let at = 0; at + BLOCK <= samples.length; at += BLOCK) {
    let peak = 0;
    for (let frame = at; frame < at + BLOCK; frame += 1) {
      const value = Math.abs(samples[frame]);
      if (value > peak) peak = value;
    }
    if (peak === 0) silent += 1;
  }
  return silent;
}

test("moving a fader while an amp plays does not reload its capture or cabinet", async () => {
  // A song snapshot used to re-attach every amp: the capture's JSON was parsed
  // again, the model copied into the wasm heap, the cabinet's FFTs rebuilt — on
  // the message path, under a PLAYING runner. A snapshot that changed nothing
  // about the amp has to cost nothing at all.
  const host = await processorHost();
  postCapture(host, "fader-capture");
  postCabinet(host, "fader-ir");
  await host.flush();
  const song = ampSong([ampInsert({ ir_id: CABINET_ID })]);
  await startSong(host, song);

  const before = ampStateOf(host);
  assert.equal(before.attached, true, "the capture has to be attached");
  assert.equal(before.capture_loads, 1, "one capture load so far");
  assert.equal(before.cabinet_loads, 1, "one cabinet built so far");
  const beforeRun = host.run(32);
  const beforePeak = peakOf(beforeRun.left);
  assert.ok(beforePeak > 0.001, `the amp has to sound before the fader moves, peak ${beforePeak}`);

  // One fader move: the same capture, the same cabinet, one number changed.
  song.tracks[0].gain_db = -6;
  host.post({ type: "song", snapshot: song });
  await host.flush();

  const after = ampStateOf(host);
  assert.equal(after.capture_loads, 1, `a fader move must not reload the capture, loads ${after.capture_loads}`);
  assert.equal(after.cabinet_loads, 1, `a fader move must not rebuild the cabinet, builds ${after.cabinet_loads}`);
  assert.equal(after.attached, true, "and the amp keeps playing its capture");

  const afterRun = host.run(32);
  const afterPeak = peakOf(afterRun.left);
  // −6 dB is half the level, and it is a HALF, not silence: the insert was not
  // torn down and rebuilt between the two runs.
  const ratio = afterPeak / beforePeak;
  assert.ok(ratio > 0.4 && ratio < 0.6, `−6 dB is about half the peak, got a ratio of ${ratio}`);
  assert.equal(silentBlocks(afterRun.left), 0, "the output stays continuous across the snapshot");
});

test("changing an amp's capture while playing waits for stop", async () => {
  const host = await processorHost();
  postCapture(host, "two-captures", CAPTURE_ID);
  postCapture(host, "two-captures-b", CAPTURE_B_ID);
  await host.flush();
  const song = ampSong([ampInsert()]);
  await startSong(host, song);

  const playing = ampStateOf(host);
  assert.equal(playing.capture_loads, 1, "the first capture loaded once");
  assert.ok(peakOf(host.run(8).left) > 0.001, "the amp plays its first capture");

  // The operator picks another capture mid-performance: it is parked, the amp
  // keeps playing what it has, and nothing is parsed until Stop.
  song.inserts["insert-amp"].params.model_id = CAPTURE_B_ID;
  host.post({ type: "song", snapshot: song });
  await host.flush();
  const parked = ampStateOf(host);
  assert.equal(parked.model_id, CAPTURE_B_ID, "the document's new capture is what the insert names");
  assert.equal(parked.parked, true, "and the change waits for Stop (\"Loads when you stop.\")");
  assert.equal(parked.capture_loads, 1, "nothing was loaded while the song played");
  assert.equal(parked.attached, true, "the amp keeps the capture it was playing");
  assert.ok(peakOf(host.run(16).left) > 0.001, "so it is still audible while it waits");

  host.post({ type: "stop" });
  await host.flush();
  const stopped = ampStateOf(host);
  assert.equal(stopped.parked, false, "Stop applies the change");
  assert.equal(stopped.capture_loads, 2, `Stop loads the new capture once, loads ${stopped.capture_loads}`);
  assert.equal(stopped.attached, true);

  host.post({ type: "play" });
  await host.flush();
  assert.ok(peakOf(host.run(64).left) > 0.001, "and the new capture plays from the next Play");
});

test("reordering a chain with an amp while playing loads nothing", async () => {
  // A reorder crossfades the old chain against the new one. The arriving amp
  // runner TAKES OVER the leaving runner's already-loaded NAM instance and
  // state — it is moved, not duplicated — so no capture is parsed, no 20 MB
  // string is copied into the wasm heap and no bridge table is built on the
  // render thread while the song plays.
  const host = await processorHost();
  postCapture(host, "reorder-capture");
  await host.flush();
  const song = ampSong([ampInsert({}, { order: 0 }), compressorInsert(1)]);
  await startSong(host, song);

  const namHost = host.processor.namHost;
  assert.ok(namHost, "the NAM host is up");
  const before = runnersOf(host, "insert-amp");
  assert.equal(before.length, 1, "one amp runner before the edit");
  const firstKey = before[0].insert.instanceKey();
  assert.equal(namHost.instanceCount(), 1, `one instance before the edit, got ${namHost.instanceCount()}`);
  assert.equal(ampStateOf(host).capture_loads, 1, "one capture load so far");
  assert.ok(peakOf(host.run(16).left) > 0.001, "the amp plays before the edit");

  // From here on, every load the render path could ask for is counted.
  const realLoad = namHost.loadModel.bind(namHost);
  let loadsWhilePlaying = 0;
  namHost.loadModel = (...args) => {
    loadsWhilePlaying += 1;
    return realLoad(...args);
  };

  // The same two inserts in the other order: the whole chain is one blend.
  song.inserts["insert-amp"].order = 1;
  song.inserts["insert-comp"].order = 0;
  host.post({ type: "song", snapshot: song });
  await host.flush();

  assert.equal(loadsWhilePlaying, 0, `a reorder must load nothing while playing, loads ${loadsWhilePlaying}`);
  const during = runnersOf(host, "insert-amp");
  assert.equal(during.length, 1, `the amp insert was MOVED, so one runner holds it, got ${during.length}`);
  assert.equal(during[0].insert.instanceKey(), firstKey, "the arriving runner took the leaving runner's instance");
  assert.equal(namHost.instanceCount(), 1, `still one instance during the fade, got ${namHost.instanceCount()}`);
  assert.equal(ampStateOf(host).capture_loads, 1, "and the capture was not loaded again");
  // The arriving amp plays (nothing stops mid-fade), and one NAM state per block
  // is advanced once.
  assert.ok(peakOf(host.run(8).left) > 0.001, "the amp is audible through the fade");

  // The fade is 64 frames; once it has arrived, a snapshot folds the blend away.
  host.run(8);
  song.meta.title = "Amp test, folded";
  host.post({ type: "song", snapshot: song });
  await host.flush();
  assert.equal(runnersOf(host, "insert-amp").length, 1, "the blend folded away");
  assert.equal(namHost.instanceCount(), 1, `the instance is kept, got ${namHost.instanceCount()}`);
  assert.ok(peakOf(host.run(16).left) > 0.001, "and the amp still plays");
  assert.equal(loadsWhilePlaying, 0, "nothing loaded at any point while the song played");
});

test("a new amp added while playing stays silent until stop and then loads", async () => {
  // A chain edit that brings in a DIFFERENT amp has nothing already-loaded to
  // move. It is parked SILENT until Stop ("Loads when you stop.") — never a
  // capture load on the render thread.
  const host = await processorHost();
  postCapture(host, "late-amp");
  await host.flush();
  const song = ampSong([compressorInsert(0)]);
  await startSong(host, song);

  const namHost = host.processor.namHost === null ? null : host.processor.namHost;
  let loadsWhilePlaying = 0;
  const watch = (hostNow) => {
    const realLoad = hostNow.loadModel.bind(hostNow);
    hostNow.loadModel = (...args) => {
      loadsWhilePlaying += 1;
      return realLoad(...args);
    };
  };
  if (namHost !== null) watch(namHost);

  // A brand new amp insert, with a capture, arrives during playback.
  song.inserts["insert-amp"] = ampInsert({}, { order: 1 });
  host.post({ type: "song", snapshot: song });
  await host.flush();

  if (namHost === null) watch(host.processor.namHost);
  const parked = ampStateOf(host);
  assert.equal(parked.parked, true, "the new amp waits for Stop");
  assert.equal(parked.attached, false, "and has nothing attached while the song plays");
  assert.equal(parked.capture_loads, 0, "nothing was loaded while playing");
  assert.equal(loadsWhilePlaying, 0, `the render path asked for no capture, loads ${loadsWhilePlaying}`);
  // The amp is SILENT, never the dry signal, while it waits.
  host.run(24);
  const silent = host.run(4);
  assert.ok(peakOf(silent.left) < 1e-9, `a parked amp is silence, peak ${peakOf(silent.left)}`);

  host.post({ type: "stop" });
  await host.flush();
  const stopped = ampStateOf(host);
  assert.equal(stopped.parked, false, "Stop applies the load");
  assert.equal(stopped.attached, true, "and the capture is attached");
  assert.equal(stopped.capture_loads, 1, `Stop loads it once, loads ${stopped.capture_loads}`);

  host.post({ type: "play" });
  await host.flush();
  assert.ok(peakOf(host.run(64).left) > 0.001, "and it plays from the next Play");
});

/**
 * Drive one convert-through-and-back conversion deterministically and hand back
 * its last frames. The very same function runs in Node and in Chromium, which is
 * what the parity test below compares — so it uses no trig and no host API.
 * @param {object} host the nam host module (`createBridge`)
 * @returns {number[]} the conversion's last 2048 output frames
 */
function bridgeParityRun(host) {
  const BLOCKS = 24;
  const IN = 128;
  const MID = 160;
  const up = host.createBridge({ fromRate: 44100, toRate: 48000, maxIn: IN, maxOut: MID });
  const down = host.createBridge({ fromRate: 48000, toRate: 44100, maxIn: MID, maxOut: IN });
  const left = new Float32Array(IN);
  const right = new Float32Array(IN);
  const midLeft = new Float32Array(MID);
  const midRight = new Float32Array(MID);
  const outLeft = new Float32Array(IN);
  const outRight = new Float32Array(IN);
  const collected = [];
  let seed = 12345;
  for (let block = 0; block < BLOCKS; block += 1) {
    for (let at = 0; at < IN; at += 1) {
      // A deterministic noise-ish signal, with no Math.random and no trig.
      seed = (seed * 1103515245 + 12345) % 2147483648;
      const value = (seed / 1073741824 - 1) * 0.4;
      left[at] = value;
      right[at] = value * 0.25;
    }
    const produced = up.process(left, right, IN, midLeft, midRight, MID);
    const back = down.process(midLeft, midRight, produced, outLeft, outRight, IN);
    for (let at = 0; at < back; at += 1) collected.push(outLeft[at]);
  }
  return collected.slice(Math.max(0, collected.length - 2048));
}

/** @param {number[]} samples @returns {string} a SHA-256 over their float bits. */
function hashSamples(samples) {
  const bytes = Float32Array.from(samples);
  return createHash("sha256").update(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)).digest("hex");
}

let chrome = null;
before(async () => {
  chrome = await startHeadlessChrome();
});
after(async () => {
  if (chrome) await chrome.close();
});

/**
 * One Chromium tab driven over CDP, enough to evaluate a script in a blank page.
 * @returns {Promise<{evaluate: Function, close: Function}>}
 */
async function openTab() {
  const created = await (await fetch(chrome.cdp + "/json/new?about:blank", { method: "PUT" })).json();
  const { default: WebSocket } = await import("ws");
  const ws = new WebSocket(created.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  let id = 0;
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mine = (id += 1);
      const onMessage = (raw) => {
        const message = JSON.parse(raw);
        if (message.id !== mine) return;
        ws.off("message", onMessage);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result || {});
      };
      ws.on("message", onMessage);
      ws.send(JSON.stringify({ id: mine, method: method, params: params }));
    });
  const evaluate = async (expression) => {
    const answer = await send("Runtime.evaluate", { expression: expression, returnByValue: true, awaitPromise: true });
    if (answer.exceptionDetails) throw new Error(answer.exceptionDetails.text || "the page threw");
    return answer.result.value;
  };
  return {
    evaluate: evaluate,
    close: async () => {
      ws.close();
      await fetch(chrome.cdp + "/json/close/" + created.id).catch(() => {});
    },
  };
}

test("the rate bridge is bit-identical in Chromium and Node", async (t) => {
  // The bridge is the one piece of an amp's path whose arithmetic could differ
  // between a page and a render: a polyphase table built from sin/cos, and a
  // per-sample loop of multiplies. Running the SAME driver in both hosts pins
  // that they agree bit for bit.
  const node = bridgeParityRun(namHostApi);
  assert.equal(hashSamples(node), hashSamples(bridgeParityRun(namHostApi)), "the same input twice is the same bits");
  assert.ok(peakOf(Float32Array.from(node)) > 1e-4, "the conversion has to carry signal to compare anything");
  if (!chrome) {
    t.skip("no headless Chrome");
    return;
  }
  const tab = await openTab();
  try {
    await tab.evaluate(ASSETS["nam-host.js"]);
    assert.equal(await tab.evaluate("typeof globalThis.StudioNamHost"), "object", "the host script runs in the page");
    const browser = await tab.evaluate(`(${bridgeParityRun.toString()})(globalThis.StudioNamHost)`);
    assert.equal(browser.length, node.length, "both hosts produced the same number of frames");
    assert.equal(
      hashSamples(browser),
      hashSamples(node),
      `Chromium and Node converted different bits over ${node.length} frames`,
    );
  } finally {
    await tab.close();
  }
});

/**
 * Fit `A·sin(2πft) + B·cos(2πft)` to a signal and hand back what is left over,
 * relative to the tone's own amplitude.
 * @param {Float32Array} samples
 * @param {number} frequency
 * @param {number} rate
 * @returns {number} the residual's RMS as a fraction of the tone's amplitude
 */
function toneResidualOf(samples, frequency, rate) {
  let sines = 0;
  let cosines = 0;
  let squareSines = 0;
  let squareCosines = 0;
  let cross = 0;
  for (let at = 0; at < samples.length; at += 1) {
    const angle = (2 * Math.PI * frequency * at) / rate;
    const sine = Math.sin(angle);
    const cosine = Math.cos(angle);
    const value = samples[at];
    sines += value * sine;
    cosines += value * cosine;
    squareSines += sine * sine;
    squareCosines += cosine * cosine;
    cross += sine * cosine;
  }
  const determinant = squareSines * squareCosines - cross * cross;
  if (determinant === 0) return Infinity;
  const a = (sines * squareCosines - cosines * cross) / determinant;
  const b = (cosines * squareSines - sines * cross) / determinant;
  let residual = 0;
  for (let at = 0; at < samples.length; at += 1) {
    const angle = (2 * Math.PI * frequency * at) / rate;
    const error = samples[at] - (a * Math.sin(angle) + b * Math.cos(angle));
    residual += error * error;
  }
  const amplitude = Math.sqrt(a * a + b * b);
  return amplitude === 0 ? Infinity : Math.sqrt(residual / samples.length) / amplitude;
}

test("an amp at 44.1 kHz with a 48 kHz capture reports its delay and does not alias", async () => {
  // A capture at another rate needs a real converter, and a real converter needs
  // look-ahead: the amp says so through `latencyFrames` instead of claiming zero,
  // so the runner system primes for it.
  const rate = 44100;
  const host = await processorHost(rate);
  postCapture(host, "rate-44");
  await host.flush();
  const song = ampSong([ampInsert()]);
  await startSong(host, song, rate);

  const state = ampStateOf(host);
  assert.equal(state.capture_rate, 48000, "the fixture capture is trained at 48 kHz");
  assert.equal(state.converted, true, "so the insert converts");
  assert.ok(state.latency_frames > 0, `a converted amp reports its delay, got ${state.latency_frames}`);
  // The kernel's 16-frame half-span, counted at each converter's output: 18 model
  // frames on the way in (17 context frames) and 15 on the way out.
  const inFrames = Math.ceil(Math.ceil(16 / (rate / 48000)) * (rate / 48000));
  const outFrames = Math.ceil(16 / (48000 / rate));
  assert.equal(
    state.latency_frames,
    inFrames + outFrames,
    `the delay is the two converters' look-ahead (${inFrames} + ${outFrames}), got ${state.latency_frames}`,
  );
  assert.ok(peakOf(host.run(64).left) > 0.001, "and the converted amp still makes sound");

  // The converter itself: a 20 kHz tone at 44.1 kHz through a 48 kHz capture and
  // back. A linear, symmetric converter returns that tone and nothing else; a
  // one-sided kernel modulates it and leaves the difference all over the band.
  // The residual is everything that is NOT the tone, as a fraction of it.
  const frames = 8192;
  const convert = (frequency) => {
    const up = namHostApi.createBridge({ fromRate: rate, toRate: 48000, maxIn: 128, maxOut: 160 });
    const down = namHostApi.createBridge({ fromRate: 48000, toRate: rate, maxIn: 160, maxOut: 128 });
    const input = new Float32Array(128);
    const midLeft = new Float32Array(160);
    const midRight = new Float32Array(160);
    const outLeft = new Float32Array(128);
    const outRight = new Float32Array(128);
    const collected = [];
    for (let block = 0; block * 128 < frames; block += 1) {
      for (let at = 0; at < 128; at += 1) {
        input[at] = Math.sin((2 * Math.PI * frequency * (block * 128 + at)) / rate) * 0.5;
      }
      const produced = up.process(input, input, 128, midLeft, midRight, 160);
      const back = down.process(midLeft, midRight, produced, outLeft, outRight, 128);
      for (let at = 0; at < back; at += 1) collected.push(outLeft[at]);
    }
    // The first frames are the converter filling its look-ahead: measure the
    // steady state, where a conversion's own delay has run off.
    return Float32Array.from(collected.slice(1024, 1024 + 4096));
  };
  const reference = toneResidualOf(convert(1000), 1000, rate);
  const high = toneResidualOf(convert(20000), 20000, rate);
  assert.ok(reference < 0.01, `a 1 kHz tone survives the conversion almost exactly, residual ${reference}`);
  assert.ok(
    high < 0.05,
    `a 20 kHz tone at 44.1 kHz must not smear into the band (residual ${high} of the tone, 1 kHz reference ${reference})`,
  );
});

test("the monitor delay includes the master limiter", async () => {
  // What the operator hears while monitoring runs through the armed track's chain
  // AND the master's, so the limiter's 1.5 ms look-ahead is part of the delay the
  // page adds to the round trip it measured.
  const host = await processorHost();
  postCapture(host, "monitor-latency");
  await host.flush();
  const song = ampSong([ampInsert()]);
  song.inserts["insert-limiter"] = {
    id: "insert-limiter",
    owner: "master",
    kind: "limiter",
    order: 0,
    bypass: false,
    params: {},
  };
  host.post({ type: "song", snapshot: song });
  host.post({ type: "monitor", track_id: "track-1", on: true });
  await host.flush();
  // One block, so the master chain's own reading is the running one.
  host.run(2);
  const masterFrames = Math.round(0.0015 * SAMPLE_RATE);
  const masterMs = (masterFrames / SAMPLE_RATE) * 1000;
  const posted = postsOfType(host.posts, "monitor_latency").filter((message) => message.track_id === "track-1");
  assert.ok(posted.length > 0, `the engine has to post the chain's delay, got ${JSON.stringify(host.posts.slice(-6))}`);
  const last = posted[posted.length - 1];
  assert.ok(
    Math.abs(last.ms - masterMs) < 1e-9,
    `the monitor delay has to be the limiter's look-ahead (${masterMs} ms), got ${last.ms} ms`,
  );
});

/**
 * A song of two audio tracks, each playing its own bar of the same tone, with one
 * amp insert per track.
 * @param {object[]} inserts
 * @returns {object}
 */
function twoTrackAmpSong(inserts) {
  const song = ampSong(inserts);
  song.tracks.push({
    id: "track-2",
    name: "Guitar 2",
    color: "#8FC1E8",
    device: { engine: "audio" },
    mute: false,
    solo: false,
    gain_db: 0,
    pan: 0,
    locked: false,
  });
  song.clips["clip-2"] = {
    id: "clip-2",
    track_id: "track-2",
    scene_id: "scene-1",
    name: "DI 2",
    length_bars: 1,
    kind: "audio",
    notes: [],
    comp: [{ take_id: "take-1", from_beat: 0, to_beat: 4 }],
  };
  return song;
}

test("one trapping amp does not mark the other amps failed", async () => {
  // A wasm trap used to take the whole processor down (and with it every track).
  // Now it stops the amp that trapped — SILENT, never the dry signal — says so
  // once, and POISONS the shared module: every other amp reads silence while the
  // module is rebuilt, but is NOT marked failed. When the song stops they are
  // re-attached to the rebuilt module and play again (a capture is loaded only
  // while the transport is stopped).
  const host = await processorHost();
  postCapture(host, "trap-capture");
  await host.flush();
  const song = twoTrackAmpSong([
    ampInsert({}, { id: "insert-amp", owner: "track:track-1", order: 0 }),
    ampInsert({}, { id: "insert-amp-2", owner: "track:track-2", order: 0 }),
  ]);
  await startSong(host, song);

  const first = runnersOf(host, "insert-amp", "track-1")[0];
  const trappedKey = first.insert.instanceKey();
  assert.ok(peakOf(host.run(16).left) > 0.001, "both amps play before the trap");

  // The test seam: the engine's own process, throwing once for ONE instance.
  const namHost = host.processor.namHost;
  const real = namHost.process.bind(namHost);
  let armed = true;
  namHost.process = (key, input, output, frames) => {
    if (armed && key === trappedKey) {
      armed = false;
      throw new Error("a wasm trap");
    }
    return real(key, input, output, frames);
  };
  const trapped = host.run(4);
  // The module is poisoned, so the OTHER amp is silent too (without being marked
  // failed): the audio thread never plays a wounded module.
  assert.ok(peakOf(trapped.left) < 1e-9, `a poisoned module plays silence, peak ${peakOf(trapped.left)}`);
  const faulted = postsOfType(host.posts, "insert_fault").filter((message) => message.insert_id === "insert-amp");
  assert.equal(faulted.length, 1, `the trap is reported once, got ${JSON.stringify(faulted)}`);
  assert.equal(faulted[0].message, "amp on Guitar stopped: its capture could not be played.");

  await host.flush();
  const stopped = ampStateOf(host, "insert-amp", "track-1");
  assert.equal(stopped.failed, true, "the amp that trapped is stopped");
  assert.equal(stopped.attached, false, "with nothing attached");
  const healthy = ampStateOf(host, "insert-amp-2", "track-2");
  assert.equal(healthy.failed, false, "the other amp is NOT marked failed by another amp's trap");
  assert.equal(healthy.attached, false, "it waits for Stop: nothing loads while the song plays");
  assert.equal(
    postsOfType(host.posts, "library_failed").filter((message) => message.library_id === CAPTURE_ID).length,
    0,
    "a trap belongs to one insert, never to the capture for every amp",
  );
  assert.ok(host.processor.namHost !== namHost, "the shared module was rebuilt");
  assert.equal(host.processor.namHost.instanceCount(), 0, "and no capture was loaded into it while playing");
  const waiting = host.run(16);
  assert.ok(peakOf(waiting.left) < 1e-9, `every amp is silent until Stop, peak ${peakOf(waiting.left)}`);

  host.post({ type: "stop" });
  await host.flush();
  const reattached = ampStateOf(host, "insert-amp-2", "track-2");
  assert.equal(reattached.failed, false, "the healthy amp is still untouched");
  assert.equal(reattached.attached, true, "and is re-attached to the rebuilt module at Stop");
  assert.equal(host.processor.namHost.instanceCount(), 1, "only the healthy amp has an instance again");
  host.post({ type: "play" });
  await host.flush();
  assert.ok(peakOf(host.run(64).left) > 0.001, "the healthy amp plays again; the trapped one stays silent");
});

test("an amp whose capture produces a bad sample is silent, never dry", async () => {
  // Review Focus 1: a capture that cannot be played is silence. The NaN guard
  // used to bypass an insert to the signal it was given, which for an amp is the
  // dry guitar — the one thing the insert may never become.
  const host = await processorHost();
  postCapture(host, "nan-capture");
  await host.flush();
  await startSong(host, ampSong([ampInsert()]));
  assert.ok(peakOf(host.run(8).left) > 0.001, "the amp plays first");

  const namHost = host.processor.namHost;
  const real = namHost.process.bind(namHost);
  let armed = true;
  namHost.process = (key, input, output, frames) => {
    const played = real(key, input, output, frames);
    if (armed) {
      armed = false;
      for (let at = 0; at < frames; at += 1) output[at] = Number.NaN;
    }
    return played;
  };
  const bad = host.run(4);
  assert.ok(peakOf(bad.left) < 1e-9, `the bad block is silence, peak ${peakOf(bad.left)}`);
  const after = host.run(16);
  assert.ok(peakOf(after.left) < 1e-9, `and it stays silent, peak ${peakOf(after.left)} (never the dry signal)`);
  assert.equal(ampStateOf(host).failed, true, "the insert is stopped, not bypassed");
  assert.equal(
    postsOfType(host.posts, "insert_fault").filter((message) => message.insert_id === "insert-amp").length,
    1,
    "and it is said once",
  );
});

test("monitoring a stereo input with the signal on one side keeps its level", async () => {
  // The armed track's 1b input selection says this is a ONE-channel input, so
  // the amp's mono sum feeds that channel unscaled. (A stereo pair is
  // (L+R)/2; the selection decides, never the signal's peaks.)
  /**
   * @param {Float32Array} left
   * @param {Float32Array} right
   * @returns {Promise<number>} the peak monitoring heard
   */
  const heard = async (left, right) => {
    const host = await processorHost();
    postCapture(host, "monitor-level");
    host.post({ type: "song", snapshot: ampSong([ampInsert()]) });
    host.post({ type: "audio", take_id: "take-1", channels: [new Float32Array(SAMPLE_RATE)] });
    await host.flush();
    host.post({ type: "monitor", track_id: "track-1", on: true, channels: 1 });
    host.post({ type: "launchScene", id: "scene-1" });
    host.post({ type: "play" });
    await host.flush();
    const blocks = 64;
    const outLeft = new Float32Array(blocks * BLOCK);
    const outRight = new Float32Array(blocks * BLOCK);
    for (let index = 0; index < blocks; index += 1) {
      const start = index * BLOCK;
      host.processor.process(
        [[left.subarray(start, start + BLOCK), right.subarray(start, start + BLOCK)]],
        [[outLeft.subarray(start, start + BLOCK), outRight.subarray(start, start + BLOCK)]],
      );
    }
    return peakOf(outLeft.subarray(blocks * BLOCK - 16 * BLOCK));
  };
  const blocks = 64;
  const tone = sineTake(blocks * BLOCK);
  const silence = new Float32Array(blocks * BLOCK);
  const oneSided = await heard(tone, silence);
  const bothSides = await heard(tone, tone);
  assert.ok(oneSided > 0.001, `monitoring has to be audible, peak ${oneSided}`);
  const ratio = oneSided / bothSides;
  assert.ok(
    ratio > 0.8 && ratio < 1.25,
    `a one-channel selection feeds its channel unscaled (ratio ${ratio} to the same signal on both)`,
  );
});

test("a one-channel input feeds the amp unscaled and never switches scale", async () => {
  // The old mono sum looked at each 128-frame piece's peaks and divided by two
  // only when BOTH sides had one — a noisy or gated right channel flips that at
  // every piece boundary, which is a 6 dB step every few milliseconds. The
  // selection is fixed, so a right channel that alternates between silence and
  // a tiny noise floor changes nothing at all.
  const blocks = 64;
  const tone = sineTake(blocks * BLOCK);
  const noise = new Float32Array(blocks * BLOCK);
  for (let at = 0; at < noise.length; at += 1) noise[at] = Math.sin(at / 7) * 1e-6;
  /**
   * @param {(block: number) => Float32Array} rightOf
   * @returns {Promise<Float32Array>} the amp's output
   */
  const heard = async (rightOf) => {
    const host = await processorHost();
    postCapture(host, "monitor-scale");
    host.post({ type: "song", snapshot: ampSong([ampInsert()]) });
    host.post({ type: "audio", take_id: "take-1", channels: [new Float32Array(SAMPLE_RATE)] });
    await host.flush();
    host.post({ type: "monitor", track_id: "track-1", on: true, channels: 1 });
    host.post({ type: "launchScene", id: "scene-1" });
    host.post({ type: "play" });
    await host.flush();
    const outLeft = new Float32Array(blocks * BLOCK);
    const outRight = new Float32Array(blocks * BLOCK);
    for (let index = 0; index < blocks; index += 1) {
      const start = index * BLOCK;
      host.processor.process(
        [[tone.subarray(start, start + BLOCK), rightOf(index).subarray(start, start + BLOCK)]],
        [[outLeft.subarray(start, start + BLOCK), outRight.subarray(start, start + BLOCK)]],
      );
    }
    return outLeft;
  };
  const silentRight = await heard(() => new Float32Array(blocks * BLOCK));
  const noisyRight = await heard(() => noise);
  const rmsSilent = rmsOf(silentRight.subarray(32 * BLOCK));
  const rmsNoisy = rmsOf(noisyRight.subarray(32 * BLOCK));
  assert.ok(rmsSilent > 0.001, `the amp has to make sound, rms ${rmsSilent}`);
  assert.ok(
    rmsNoisy / rmsSilent > 0.98 && rmsNoisy / rmsSilent < 1.02,
    `a nonzero right channel must not change the mono scale (ratio ${rmsNoisy / rmsSilent})`,
  );

  // Alternating silence and noise on the right, block by block: a peak-driven
  // scale would alternate half/full here. The fixed selection does not move.
  const alternating = new Float32Array(blocks * BLOCK);
  for (let at = 0; at < alternating.length; at += 1) {
    if (Math.floor(at / BLOCK) % 2 === 1) alternating[at] = Math.sin(at / 7) * 1e-6;
  }
  const flipped = await heard(() => alternating);
  let lowest = Infinity;
  let highest = 0;
  for (let at = 32 * BLOCK; at + BLOCK <= flipped.length; at += BLOCK) {
    const rms = rmsOf(flipped.subarray(at, at + BLOCK));
    if (rms < lowest) lowest = rms;
    if (rms > highest) highest = rms;
  }
  assert.ok(highest / lowest < 1.25, `no 6 dB scale step between pieces (ratio ${highest / lowest})`);
});

/**
 * One 44.1 kHz ↔ 48 kHz bridge pair, exactly the two converters an amp at
 * 44.1 kHz around a 48 kHz capture builds.
 * @returns {{up: object, down: object}}
 */
function rateBridgePair() {
  return {
    up: namHostApi.createBridge({ fromRate: 44100, toRate: 48000, maxIn: 128, maxOut: 160 }),
    down: namHostApi.createBridge({ fromRate: 48000, toRate: 44100, maxIn: 160, maxOut: 128 }),
  };
}

/**
 * Run one impulse through a bridge pair and hand back the conversion.
 * @param {{up: object, down: object}} pair
 * @param {number} [blocks]
 * @returns {Float32Array}
 */
function impulseThroughBridge(pair, blocks = 8) {
  const input = new Float32Array(128);
  const midLeft = new Float32Array(160);
  const midRight = new Float32Array(160);
  const outLeft = new Float32Array(128);
  const outRight = new Float32Array(128);
  const collected = [];
  for (let block = 0; block < blocks; block += 1) {
    input.fill(0);
    if (block === 0) input[0] = 1;
    const produced = pair.up.process(input, input, 128, midLeft, midRight, 160);
    const back = pair.down.process(midLeft, midRight, produced, outLeft, outRight, 128);
    assert.equal(back, 128, `the out bridge has to yield a whole 128-frame block from call ${block + 1}`);
    for (let at = 0; at < back; at += 1) collected.push(outLeft[at]);
  }
  return Float32Array.from(collected);
}

test("a rate-bridged amp has a constant delay from its first block", () => {
  // The out bridge used to return 121, 127, 128, 129… frames from call to call
  // and filled the missing tail of its first block with silence, which is a hole
  // in the middle of a block on every reset. Both bridges are pre-rolled with
  // their own look-ahead, so the first call is a whole block and the delay is a
  // constant `latencyFrames` — from the first sample, and again after reset.
  const pair = rateBridgePair();
  const first = impulseThroughBridge(pair);
  let peakAt = 0;
  let peak = 0;
  for (let at = 0; at < first.length; at += 1) {
    const value = Math.abs(first[at]);
    if (value > peak) {
      peak = value;
      peakAt = at;
    }
  }
  assert.ok(peak > 0.01, `the impulse has to come through, peak ${peak}`);
  const expected = Math.ceil(pair.up.latencyFrames * (44100 / 48000)) + pair.down.latencyFrames;
  assert.ok(
    Math.abs(peakAt - expected) <= 2,
    `the amp's rate bridge delays by its reported ${expected} frames, the impulse peaked at ${peakAt}`,
  );

  // reset() restores the very same pipeline: the next first block has the same
  // timing and the same samples, not a short block with a hole in it.
  pair.up.reset();
  pair.down.reset();
  const afterReset = impulseThroughBridge(pair);
  assert.equal(differenceOf(first, afterReset), 0, "reset restores the bridge bit for bit");

  // A fresh pair agrees with the one that has been running: the delay is the
  // rate pair's, never a property of how many blocks came before.
  const fresh = impulseThroughBridge(rateBridgePair());
  assert.equal(differenceOf(first, fresh), 0, "a fresh bridge has the same first-block timing");
});

test("the rate bridge has no periodic one-sample slips", () => {
  // 44.1 → 48 is 147/160 of an input frame per output frame. The phase used to
  // be rounded onto 512 rows and a fraction that rounded up to 512 was left on
  // row 0 at the OLD base, slipping the read a whole sample at the 147/160
  // period. A sine through the pair is fitted to sin/cos (a constant fractional
  // delay is a phase shift); a slip is a per-sample error spike.
  const pair = rateBridgePair();
  const frequency = 5000;
  const blocks = 160;
  const input = new Float32Array(128);
  const midLeft = new Float32Array(160);
  const midRight = new Float32Array(160);
  const outLeft = new Float32Array(128);
  const outRight = new Float32Array(128);
  const collected = [];
  for (let block = 0; block < blocks; block += 1) {
    for (let at = 0; at < 128; at += 1) {
      input[at] = Math.sin((2 * Math.PI * frequency * (block * 128 + at)) / 44100) * 0.5;
    }
    const produced = pair.up.process(input, input, 128, midLeft, midRight, 160);
    const back = pair.down.process(midLeft, midRight, produced, outLeft, outRight, 128);
    assert.equal(back, 128, `the out bridge yields a whole block on call ${block + 1}`);
    for (let at = 0; at < back; at += 1) collected.push(outLeft[at]);
  }

  const start = 2048;
  const count = 16384;
  const measured = collected.slice(start, start + count);
  let sines = 0;
  let cosines = 0;
  let squareSines = 0;
  let squareCosines = 0;
  let cross = 0;
  for (let at = 0; at < measured.length; at += 1) {
    const angle = (2 * Math.PI * frequency * (start + at)) / 44100;
    const sine = Math.sin(angle);
    const cosine = Math.cos(angle);
    const value = measured[at];
    sines += value * sine;
    cosines += value * cosine;
    squareSines += sine * sine;
    squareCosines += cosine * cosine;
    cross += sine * cosine;
  }
  const determinant = squareSines * squareCosines - cross * cross;
  const a = (sines * squareCosines - cosines * cross) / determinant;
  const b = (cosines * squareSines - sines * cross) / determinant;
  const amplitude = Math.sqrt(a * a + b * b);
  let worst = 0;
  for (let at = 0; at < measured.length; at += 1) {
    const angle = (2 * Math.PI * frequency * (start + at)) / 44100;
    const error = Math.abs(measured[at] - (a * Math.sin(angle) + b * Math.cos(angle)));
    if (error > worst) worst = error;
  }
  assert.ok(amplitude > 0.01, `the tone has to survive the conversion, amplitude ${amplitude}`);
  assert.ok(
    worst / amplitude < 0.02,
    `a 5 kHz tone must not slip a sample at the 147/160 period (worst ${worst / amplitude} of the tone)`,
  );
});

test("monitor latency re-posts when an amp's latency changes outside a snapshot", async () => {
  // A capture finishing its parse (or a parked change applied at Stop) can move
  // the monitored track's amp latency with no song snapshot at all. The page's
  // round-trip number has to follow it then too.
  const rate = 44100;
  const host = await processorHost(rate);
  const nativeId = "capture-a2-44100";
  const nativeText = CAPTURE_TEXT.replace(/"sample_rate":\s*48000(?:\.0)?/g, '"sample_rate": 44100');
  postCapture(host, "native", nativeId, nativeText);
  await host.flush();

  const song = ampSong([ampInsert()]);
  host.post({ type: "song", snapshot: song });
  host.post({ type: "audio", take_id: "take-1", channels: [sineTake(rate)] });
  await host.flush();
  host.post({ type: "monitor", track_id: "track-1", on: true, channels: 2 });
  await host.flush();

  const latencies = () =>
    postsOfType(host.posts, "monitor_latency").filter((message) => message.track_id === "track-1");
  const last = () => {
    const list = latencies();
    return list[list.length - 1];
  };
  assert.equal(last().ms, 0, "nothing is loaded yet, so the chain adds nothing");

  // The capture finishes its parse while the transport is stopped: rebindAmps()
  // attaches it and the converted amp's latency appears — with no snapshot.
  postCapture(host, "converted", CAPTURE_ID);
  await host.flush();
  const converted = last();
  assert.ok(converted.ms > 0, `loading a converted capture has to re-post the delay, got ${converted.ms} ms`);

  // Now a parked change applied at Stop: back to the context-rate capture, which
  // needs no conversion, so the delay goes back to zero then.
  host.post({ type: "play" });
  await host.flush();
  song.inserts["insert-amp"].params.model_id = nativeId;
  host.post({ type: "song", snapshot: song });
  await host.flush();
  assert.equal(last().ms, converted.ms, "a parked change does not move the number while it waits");
  host.post({ type: "stop" });
  await host.flush();
  assert.equal(last().ms, 0, "Stop applies the change and re-posts the amp's new latency");
});

// --- delay compensation (plugin delay compensation for track chains) ---------

/** How many frames a chain edit's crossfade runs (`CHAIN_FADE_FRAMES`). */
const CHAIN_FADE = 64;

/**
 * One click in a take: one loud frame and two decaying ones after it. Where a
 * track's click comes out is what compensation is about, so the shape of it only
 * has to be short.
 * @param {number} frames
 * @param {number} at
 * @param {number} [level]
 * @returns {Float32Array}
 */
function clickTake(frames, at, level = 0.5) {
  const take = new Float32Array(frames);
  take[at] = level;
  take[at + 1] = level * 0.5;
  take[at + 2] = level * 0.25;
  return take;
}

/** @returns {number} the frame the largest |sample| of a run sits on. */
function peakFrameOf(samples) {
  let frame = -1;
  let peak = 0;
  for (let at = 0; at < samples.length; at += 1) {
    const value = Math.abs(samples[at]);
    if (value > peak) {
      peak = value;
      frame = at;
    }
  }
  return frame;
}

/**
 * The largest frame-to-frame step of a stretch of a run: what a click in the
 * signal would be, and what a fade must not make.
 * @param {Float32Array} samples
 * @param {number} from
 * @param {number} to
 * @returns {number}
 */
function largestStepOf(samples, from, to) {
  let step = 0;
  const end = Math.min(to === undefined ? samples.length : to, samples.length);
  for (let at = Math.max(1, from); at < end; at += 1) {
    const value = Math.abs(samples[at] - samples[at - 1]);
    if (value > step) step = value;
  }
  return step;
}

/**
 * One tap's blocks as one timeline. A track tap is stamped with the frame its
 * first sample sits on and the blocks arrive one per block in order, so an index
 * in this array IS the processor frame the tapped track played that sample at.
 * @param {object[]} posts
 * @param {string} target
 * @returns {Float32Array}
 */
function tapTimeline(posts, target) {
  const blocks = postsOfType(posts, "tap_block").filter((message) => message.target === target);
  const samples = new Float32Array(blocks.length * BLOCK);
  for (let index = 0; index < blocks.length; index += 1) samples.set(blocks[index].channels[0], index * BLOCK);
  return samples;
}

/**
 * Play one song whose every track plays the same click take, with one target
 * tapped, and hand back where that target's click came out.
 * @param {object} song
 * @param {{rate?: number, at?: number, tap?: string, blocks?: number, take?: Float32Array,
 *          monitor?: string, disableCompensation?: boolean}} [options]
 *   `disableCompensation` zeroes every track's compensation before the first
 *   block, which is the engine as it was before compensation existed: it is how a
 *   test proves its own assertion can fail
 * @returns {Promise<{host: object, samples: Float32Array, peak: number, rate: number, at: number}>}
 */
async function clickRun(song, options = {}) {
  const rate = options.rate === undefined ? 44100 : options.rate;
  const at = options.at === undefined ? 1000 : options.at;
  const target = options.tap === undefined ? "track-1" : options.tap;
  const take = options.take === undefined ? clickTake(Math.round(rate * 0.25), at) : options.take;
  const host = await processorHost(rate);
  postCapture(host, `pdc-${target}`);
  await host.flush();
  host.post({ type: "song", snapshot: song });
  host.post({ type: "audio", take_id: "take-1", channels: [take] });
  await host.flush();
  if (options.monitor !== undefined) host.post({ type: "monitor", track_id: options.monitor, on: true });
  host.post({ type: "tap", target: target, on: true });
  await host.flush();
  if (options.disableCompensation === true) {
    for (const record of host.processor.slots) {
      record.compensation = 0;
      record.compensationFrom = 0;
      record.compensationFade = 0;
    }
    host.processor.mixDelayFrames = 0;
  }
  host.post({ type: "launchScene", id: "scene-1" });
  host.post({ type: "play" });
  await host.flush();
  host.run(options.blocks === undefined ? 64 : options.blocks);
  const samples = tapTimeline(host.posts, target);
  return { host: host, samples: samples, peak: peakFrameOf(samples), rate: rate, at: at };
}

/** @returns {number[]} every `master_latency` number a run posted, in order. */
function masterLatencyPosts(host) {
  return postsOfType(host.posts, "master_latency").map((message) => message.ms);
}

/** @returns {number} the last `monitor_latency` number posted for one track. */
function lastMonitorMs(host, trackId) {
  const posted = postsOfType(host.posts, "monitor_latency").filter((message) => message.track_id === trackId);
  assert.ok(posted.length > 0, `the engine has to post the monitor delay of ${trackId}`);
  return posted[posted.length - 1].ms;
}

/**
 * The master limiter's lookahead, in frames, at a rate.
 * @param {number} rate
 * @returns {number}
 */
function limiterFramesAt(rate) {
  return Math.max(1, Math.round(0.0015 * rate));
}

test("delay compensation holds a dry track back by exactly an amp's reported latency", async () => {
  // A 48 kHz capture played in a 44.1 kHz context goes through two rate bridges,
  // and both of them look ahead: the amp reports that as its `latencyFrames` and
  // its own track really carries it. Plugin delay compensation puts the SAME
  // number of frames on every other track's delay line, so a dry doubled track
  // leaves the mixer on the amp's click line instead of arriving ~0.7 ms early
  // and combing with it.
  //
  // Measured on the frame the click lands on, never on the posted number. What a
  // capture does to the sound ON TOP of its reported latency (a NAM model has a
  // receptive field of its own, which no rate report knows) is why the amp's own
  // click is compared only to itself: it is the same samples either way.
  const rate = 44100;
  const song = twoTrackAmpSong([ampInsert()]);

  const amp = await clickRun(song, { rate: rate, tap: "track-1" });
  const latency = ampStateOf(amp.host, "insert-amp", "track-1").latency_frames;
  assert.ok(latency > 0, `a 48 kHz capture in a 44.1 kHz context converts and reports its delay, got ${latency}`);
  assert.equal(
    amp.host.processor.slots[0].compensation,
    0,
    "the track with the longest chain is what the others are measured against, so nothing is put back on it",
  );

  const dry = await clickRun(song, { rate: rate, tap: "track-2" });
  assert.equal(
    dry.host.processor.slots[1].compensation,
    latency,
    `the dry track's own line holds back the amp's reported latency (${latency} frames)`,
  );
  assert.equal(
    dry.peak,
    dry.at + latency,
    `the dry track's click has to land ${latency} frames after the take's (frame ${dry.at}), it landed at ${dry.peak}`,
  );

  // The amp's own click does not move when another track joins the song: it
  // holds the longest chain in both, so its compensation is 0 in both.
  const alone = await clickRun(ampSong([ampInsert()]), { rate: rate, tap: "track-1" });
  assert.equal(amp.peak, alone.peak, "the longest chain's own click is the same with and without the dry track beside it");

  // And the assertion can fail: with the compensation taken out, the dry track is
  // where the take put it, so the frames the compensation adds ARE the reported
  // latency — the offset the dry track had before it.
  const uncompensated = await clickRun(song, { rate: rate, tap: "track-2", disableCompensation: true });
  assert.equal(uncompensated.peak, uncompensated.at, "without compensation the dry click is not held back at all");
  assert.equal(
    dry.peak - uncompensated.peak,
    latency,
    "the frames compensation adds to the dry track are exactly the amp's reported latency",
  );

  // How far apart the two clicks still are: the capture's own delay, which is
  // not part of the chain's latency report — and far less than what was put back.
  const captureDelay = amp.peak - (amp.at + latency);
  assert.ok(
    captureDelay >= 0 && captureDelay < latency,
    `the capture's own shift (${captureDelay} frames) is not the chain's reported delay (${latency}), so it is left over`,
  );
});

test("the reported master latency is the limiter plus the tracks' compensation", async () => {
  const rate = 44100;
  const limiterFrames = limiterFramesAt(rate);

  // No amp anywhere: no track chain delays anything, so the whole path's delay is
  // 0 and there is nothing to post.
  const plain = await clickRun(twoTrackAmpSong([]), { rate: rate, tap: "track-2", blocks: 8 });
  assert.equal(plain.host.processor.mixDelayFrames, 0, "nothing on any track chain delays anything");
  assert.deepEqual(masterLatencyPosts(plain.host), [], "a path with no delay posts no latency at all");

  // One converted amp on one track: the whole mix runs that many frames late.
  const ampOnly = await clickRun(twoTrackAmpSong([ampInsert()]), { rate: rate, tap: "track-1", blocks: 8 });
  const latency = ampStateOf(ampOnly.host, "insert-amp", "track-1").latency_frames;
  assert.equal(ampOnly.host.processor.masterLatencyFrames, 0, "no limiter, so the master chain adds nothing");
  assert.equal(ampOnly.host.processor.mixDelayFrames, latency, "the mix runs the longest chain's latency late");
  const ampMs = masterLatencyPosts(ampOnly.host);
  assert.equal(ampMs.length, 1, `the number is posted once per change, got ${JSON.stringify(ampMs)}`);
  assert.ok(
    Math.abs(ampMs[0] - (latency / rate) * 1000) < 1e-9,
    `the amp's chain is the whole path's delay: ${latency} frames is ${(latency / rate) * 1000} ms, got ${ampMs[0]} ms`,
  );

  // The master limiter's lookahead is on top of that, not instead of it.
  const limitedSong = twoTrackAmpSong([ampInsert()]);
  limitedSong.inserts["insert-limiter"] = {
    id: "insert-limiter",
    owner: "master",
    kind: "limiter",
    order: 0,
    bypass: false,
    params: {},
  };
  const limited = await clickRun(limitedSong, { rate: rate, tap: "track-1", blocks: 8 });
  const total = limited.host.processor.masterLatencyFrames + limited.host.processor.mixDelayFrames;
  assert.equal(limited.host.processor.masterLatencyFrames, limiterFrames, "the master chain's own delay is the limiter's lookahead");
  assert.equal(limited.host.processor.mixDelayFrames, latency, "and the mix's is the amp's chain");
  const limitedMs = masterLatencyPosts(limited.host);
  const latest = limitedMs[limitedMs.length - 1];
  assert.ok(
    Math.abs(latest - (total / rate) * 1000) < 1e-9,
    `the posted number is the whole path (${limiterFrames} + ${latency} = ${total} frames is ${(total / rate) * 1000} ms), got ${latest} ms`,
  );
});

test("the meter reading and a master tap carry the whole path's delay", async () => {
  const rate = 44100;
  const limiterFrames = limiterFramesAt(rate);
  const song = twoTrackAmpSong([ampInsert()]);
  song.inserts["insert-limiter"] = {
    id: "insert-limiter",
    owner: "master",
    kind: "limiter",
    order: 0,
    bypass: false,
    params: {},
  };
  const run = await clickRun(song, { rate: rate, tap: "master", blocks: 40 });
  const total = run.host.processor.masterLatencyFrames + run.host.processor.mixDelayFrames;
  assert.ok(total > limiterFrames, `the tracks' compensation is part of the total, which is ${total} frames`);

  // A master tap is moved back by the whole path's delay: its first block sits
  // before the song started, on the pre-roll the master chain and the tracks'
  // lines are still filling.
  const taps = postsOfType(run.host.posts, "tap_block").filter((message) => message.target === "master");
  assert.ok(taps.length > 0, "a master tap posts one block per block");
  assert.equal(taps[0].frame, -total, `the tap's first frame is the whole path's delay back (-${total})`);

  // A meter reading names the same number, so the strip and a take agree.
  const readings = postsOfType(run.host.posts, "meter");
  assert.ok(readings.length > 0, `a playing song meters, it posted ${JSON.stringify(run.host.posts.slice(-4))}`);
  const latest = readings[readings.length - 1];
  assert.ok(
    Math.abs(latest.latency_ms - (total / rate) * 1000) < 1e-9,
    `a reading names the whole path (${(total / rate) * 1000} ms), got ${latest.latency_ms} ms`,
  );
});

test("monitoring keeps reporting its own path, never the mix's compensation", async () => {
  const rate = 44100;
  const limiterFrames = limiterFramesAt(rate);
  // The monitored track has ONE amp; the other track has TWO in series, so the
  // mix runs later than the monitored track's own chain: the two numbers differ.
  const song = twoTrackAmpSong([
    ampInsert({}, { id: "insert-amp", owner: "track:track-1", order: 0 }),
    ampInsert({}, { id: "insert-amp-2a", owner: "track:track-2", order: 0 }),
    ampInsert({}, { id: "insert-amp-2b", owner: "track:track-2", order: 1 }),
  ]);
  song.inserts["insert-limiter"] = {
    id: "insert-limiter",
    owner: "master",
    kind: "limiter",
    order: 0,
    bypass: false,
    params: {},
  };
  const run = await clickRun(song, { rate: rate, tap: "track-1", monitor: "track-1", blocks: 8 });
  const own = ampStateOf(run.host, "insert-amp", "track-1").latency_frames;
  const mix = run.host.processor.mixDelayFrames;
  assert.equal(mix, 2 * own, `the longest chain is the other track's two amps (${2 * own} frames)`);

  // What the operator hears is the input through the armed track AND the master,
  // so the monitor's number is its own chain plus the limiter — a track that is
  // being monitored holds no compensation back, so there is none to add.
  const monitorMs = lastMonitorMs(run.host, "track-1");
  assert.ok(
    Math.abs(monitorMs - ((own + limiterFrames) / rate) * 1000) < 1e-9,
    `the monitor's number is the track's own chain plus the limiter (${own} + ${limiterFrames} frames), got ${monitorMs} ms`,
  );

  const latencies = masterLatencyPosts(run.host);
  const totalMs = latencies[latencies.length - 1];
  assert.ok(
    Math.abs(totalMs - ((mix + limiterFrames) / rate) * 1000) < 1e-9,
    `the whole path is the mix's compensation plus the limiter (${mix} + ${limiterFrames} frames), got ${totalMs} ms`,
  );
  assert.ok(totalMs > monitorMs, "the mix's number is the larger one, so the monitor's is not it");
});

test("a monitored track's backing runs early by the longest chain minus its own", async () => {
  const rate = 44100;

  // ONE amp in the song: the monitored track holds the longest chain, so its own
  // backing waits for nothing and its compensation is 0 with monitoring on and off.
  const oneAmp = twoTrackAmpSong([ampInsert()]);
  const monitoredOne = await clickRun(oneAmp, { rate: rate, tap: "track-1", monitor: "track-1" });
  const own = ampStateOf(monitoredOne.host, "insert-amp", "track-1").latency_frames;
  assert.equal(monitoredOne.host.processor.mixDelayFrames, own, "the monitored track holds the song's longest chain");
  assert.equal(
    monitoredOne.host.processor.slots[0].compensation,
    0,
    "a monitored track sits behind no delay line of its own",
  );
  const freeOne = await clickRun(oneAmp, { rate: rate, tap: "track-1" });
  assert.equal(
    freeOne.peak,
    monitoredOne.peak,
    "with one amp in the song, monitoring changes nothing: the compensation is 0 either way",
  );
  // And that click is where the same amp track puts it with no other track in the
  // song at all: its own chain's delay, and nothing added to it.
  const alone = await clickRun(ampSong([ampInsert()]), { rate: rate, tap: "track-1" });
  assert.equal(monitoredOne.peak, alone.peak, "monitoring adds nothing to the track's own chain's delay");

  // A SECOND track whose chain is longer: the mix now runs later than this
  // track's own chain, and its backing runs exactly that much early.
  const longer = twoTrackAmpSong([
    ampInsert({}, { id: "insert-amp", owner: "track:track-1", order: 0 }),
    ampInsert({}, { id: "insert-amp-2a", owner: "track:track-2", order: 0 }),
    ampInsert({}, { id: "insert-amp-2b", owner: "track:track-2", order: 1 }),
  ]);
  const monitored = await clickRun(longer, { rate: rate, tap: "track-1", monitor: "track-1" });
  const longest = monitored.host.processor.mixDelayFrames;
  assert.equal(longest, 2 * own, `the longest chain is the other track's two amps (${2 * own} frames)`);
  assert.equal(
    monitored.host.processor.slots[0].compensation,
    0,
    "monitoring keeps its own track at minimum latency, whatever the others cost",
  );
  assert.equal(
    monitored.peak,
    monitoredOne.peak,
    "monitored, the track's own output is not moved by what the other track's chain costs",
  );

  // Without monitoring the same track waits for the longest chain, so it is late
  // by the difference — exactly `Lmax − its own`.
  const free = await clickRun(longer, { rate: rate, tap: "track-1" });
  assert.equal(
    free.host.processor.slots[0].compensation,
    longest - own,
    `the track is held back by Lmax − its own chain (${longest} − ${own} frames)`,
  );
  assert.equal(
    free.peak - monitored.peak,
    longest - own,
    `the monitored backing runs early by Lmax − its own chain (${longest - own} frames), it ran early by ${free.peak - monitored.peak}`,
  );
});

test("a compensation that moves is a crossfade, not a click", async () => {
  const rate = 44100;
  const host = await processorHost(rate);
  postCapture(host, "fade-capture");
  await host.flush();
  const song = twoTrackAmpSong([ampInsert({}, { owner: "track:track-2", id: "insert-amp" })]);
  // Track 2 plays a silent take of its own: the only audible signal is track 1's
  // tone, so the only thing the edit changes in the audio is track 1's delay.
  song.clips["clip-2"].comp = [{ take_id: "take-2", from_beat: 0, to_beat: 4 }];
  host.post({ type: "song", snapshot: song });
  const tone = new Float32Array(rate);
  for (let at = 0; at < tone.length; at += 1) tone[at] = Math.sin((2 * Math.PI * 220 * at) / rate) * 0.3;
  host.post({ type: "audio", take_id: "take-1", channels: [tone] });
  host.post({ type: "audio", take_id: "take-2", channels: [new Float32Array(rate)] });
  await host.flush();
  host.post({ type: "launchScene", id: "scene-1" });
  host.post({ type: "play" });
  await host.flush();

  const record = host.processor.slots[0];
  const latency = ampStateOf(host, "insert-amp", "track-2").latency_frames;
  assert.ok(latency > 0, `the amp has to report a delay to compensate, got ${latency}`);
  assert.equal(record.compensation, latency, "while the song plays, the dry track waits for the amp's chain");

  // The signal's own slope, measured on the steady tone the edit will move.
  const before = host.run(20);
  assert.equal(record.compensationFade, 0, "a settled compensation runs no fade");
  const songStep = largestStepOf(before.left, 10 * BLOCK, 20 * BLOCK);

  // Bypassing the amp takes its latency out of the song, so the dry track's
  // compensation has to move back to 0 — while the transport is playing.
  const bypassed = JSON.parse(JSON.stringify(song));
  bypassed.inserts["insert-amp"].bypass = true;
  host.post({ type: "song", snapshot: bypassed });
  await host.flush();
  assert.equal(record.compensation, 0, "with the amp bypassed nothing delays the song, so nothing is compensated");
  assert.equal(record.compensationFrom, latency, "the fade starts at the tap the track was at");
  assert.equal(record.compensationFade, CHAIN_FADE, `the fade runs ${CHAIN_FADE} frames`);

  const edited = host.run(4);
  assert.equal(record.compensationFade, 0, `one block is longer than the ${CHAIN_FADE}-frame fade, so it has finished`);
  const fadeStep = largestStepOf(edited.left, 1, CHAIN_FADE);
  assert.ok(
    fadeStep <= songStep * 2,
    `the fade has to be no steeper than the signal's own slope (${fadeStep} against ${songStep} per frame)`,
  );

  // The step a switch would have been: the two taps are the same tone this far
  // apart, and the ramp spreads it over the fade instead.
  let tapGap = 0;
  for (let at = latency; at < 20 * BLOCK; at += 1) {
    const gap = Math.abs(before.left[at] - before.left[at - latency]);
    if (gap > tapGap) tapGap = gap;
  }
  assert.ok(
    tapGap > songStep * 10,
    `a switch between the two taps would be a click (${tapGap} against the tone's ${songStep} per frame)`,
  );
  assert.deepEqual(
    masterLatencyPosts(host).slice(-1),
    [0],
    "the whole path's delay follows the compensation back to 0",
  );
});