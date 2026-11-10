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
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
function sineTake(frames) {
  const samples = new Float32Array(frames);
  for (let at = 0; at < frames; at += 1) {
    samples[at] = Math.sin((2 * Math.PI * 220 * at) / SAMPLE_RATE) * 0.3;
  }
  return samples;
}

// --- the engine's own module ------------------------------------------------

/**
 * Compose the worklet module exactly as `engine-client.js` does and evaluate it
 * with stand-in worklet globals, handing back the processor class it registered.
 * @returns {Function} the processor class
 */
let PROCESSOR_CLASS = null;
function processorClass() {
  if (PROCESSOR_CLASS) return PROCESSOR_CLASS;
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
    SAMPLE_RATE,
    0,
  );
  assert.ok(registered, "the module has to register the studio processor");
  PROCESSOR_CLASS = registered.cls;
  return PROCESSOR_CLASS;
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
 * @returns {Promise<{processor: object, posts: object[], post: Function,
 *                    flush: Function, run: Function, blocks: number}>}
 */
async function processorHost() {
  const Loaded = processorClass();
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
 * @returns {Promise<void>}
 */
async function startSong(host, song) {
  host.post({ type: "song", snapshot: song });
  host.post({ type: "audio", take_id: "take-1", channels: [sineTake(SAMPLE_RATE)] });
  await host.flush();
  host.post({ type: "launchScene", id: "scene-1" });
  host.post({ type: "play" });
  await host.flush();
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
    assert.ok(ratio < 1, `four amps have to render faster than real time in Node; ratio ${ratio.toFixed(3)}`);
  } finally {
    if (engine) engine.dispose();
    if (!rendered) await releaseWorklet(context);
  }
});