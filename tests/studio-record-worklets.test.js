/**
 * Studio calibration and recording worklets — the loopback measurement and the
 * 24-bit take recorder.
 *
 * Everything runs on `node-web-audio-api`'s OfflineAudioContext with the real
 * `bundles/studio/engine/engine-client.js` and the real worklet files, so the
 * test measures the code the browser and the renderer run.
 *
 * - **Calibration** has no cable to loop back through, so the graph is
 *   `emitter → test-delay (a worklet defined here) → detector`. That is the one
 *   arrangement an OfflineAudioContext allows without a cycle: the emitter
 *   reaches the delay through `calibrate({onEmitter})`, which exists for exactly
 *   this — a host with no interface to plug a cable into.
 * - **Recording** is fed by an `AudioBufferSourceNode` (a signal source, which a
 *   test may use; no Studio code does).
 *
 * Read of rendered audio is always `copyFromChannel()` into a JS-owned array:
 * `getChannelData()` does not work in node-web-audio-api (#714). Nothing here
 * touches `~/.crow`; every temp file is in a fresh `mkdtemp` directory.
 *
 * Frames are the context's own: an OfflineAudioContext starts every node on
 * frame 0, so a buffer sample's index is its frame.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ENGINE_DIR = fileURLToPath(new URL("../bundles/studio/engine/", import.meta.url));
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
  "sunvox.js": readFileSync(join(VENDOR_DIR, "sunvox.js"), "utf8"),
  "studio-processor.js": readFileSync(join(ENGINE_DIR, "studio-processor.js"), "utf8"),
  "sunvox.wasm": readFileSync(join(VENDOR_DIR, "sunvox.wasm")),
};

const EMITTER_SOURCE = readFileSync(join(ENGINE_DIR, "calibrate-emitter.js"), "utf8");
const DETECTOR_SOURCE = readFileSync(join(ENGINE_DIR, "calibrate-detector.js"), "utf8");
const RECORDER_SOURCE = readFileSync(join(ENGINE_DIR, "recorder-processor.js"), "utf8");

const SAMPLE_RATE = 48000;

/**
 * A test-only delay worklet: delays by an exact number of frames and scales by
 * a gain (0 dB or −20 dB is all the calibration test needs). It lives here, not
 * in the bundle: nothing in Studio may shape sound with anything but its own
 * worklets, and a loopback stand-in is a test's business.
 */
const DELAY_SOURCE = `
class TestDelayProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const processorOptions = (options && options.processorOptions) || {};
    this.delay = Math.max(0, Math.round(Number(processorOptions.delay_frames) || 0));
    this.gain = Number.isFinite(Number(processorOptions.gain)) ? Number(processorOptions.gain) : 1;
    this.ring = new Float32Array(Math.max(1, this.delay));
    this.cursor = 0;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    const count = output[0].length;
    const length = this.ring.length;
    for (let channel = 0; channel < output.length; channel += 1) {
      const data = input && input[channel] ? input[channel] : input && input[0] ? input[0] : null;
      const out = output[channel];
      for (let at = 0; at < count; at += 1) {
        const index = (this.cursor + at) % length;
        const delayed = this.ring[index];
        this.ring[index] = data ? data[at] : 0;
        out[at] = delayed * this.gain;
      }
    }
    this.cursor = (this.cursor + count) % length;
    return true;
  }
}

registerProcessor("test-delay", TestDelayProcessor);
`;

/**
 * Write one classic-script worklet module to a private temp dir and add it to a
 * context, the way any host without a served URL has to.
 * @param {BaseAudioContext} context
 * @param {string} name
 * @param {string} source
 * @returns {Promise<void>}
 */
async function addSource(context, name, source) {
  const dir = mkdtempSync(join(tmpdir(), "studio-worklet-"));
  const file = join(dir, `${name}.mjs`);
  writeFileSync(file, source, "utf8");
  await context.audioWorklet.addModule(file);
}

/** @param {BaseAudioContext} context @returns {Promise<void>} */
async function releaseWorklet(context) {
  try {
    // The worklet thread exits when rendering does; a second release would wait
    // for an exit that already happened, so the timer is the safety net.
    await Promise.race([
      context.audioWorklet[kWorkletRelease](),
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
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
async function waitFor(predicate, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!predicate() && Date.now() < deadline) await delay(5);
  return predicate();
}

/**
 * One offline context with the engine on it, released on the way out.
 * @param {number} length frames
 * @param {number} [channels]
 * @returns {{context: BaseAudioContext, engine: object}}
 */
async function openEngine(length, channels = 2) {
  const context = new OfflineAudioContext({ numberOfChannels: channels, length: length, sampleRate: SAMPLE_RATE });
  const engine = await studioEngine.create(context, { assetBytes: ASSETS });
  return { context: context, engine: engine };
}

test("two addModule calls on one Node context both register", async () => {
  const context = new OfflineAudioContext({ numberOfChannels: 2, length: 128, sampleRate: SAMPLE_RATE });
  try {
    await addSource(context, "studio-calibrate-emitter", EMITTER_SOURCE);
    await addSource(context, "studio-recorder", RECORDER_SOURCE);
    // A node can only be constructed for a processor this context has
    // registered, so this is the registration, not the file, being proved.
    const emitter = new AudioWorkletNode(context, "studio-calibrate-emitter", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    const recorder = new AudioWorkletNode(context, "studio-recorder", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: "explicit",
      processorOptions: { channels: 1 },
    });
    assert.ok(emitter.port, "the calibration emitter registered on this context");
    assert.ok(recorder.port, "the recorder registered on the same context");
    // The third file on its own, too: all three ride on one context in Studio.
    await addSource(context, "studio-calibrate-detector", DETECTOR_SOURCE);
    const detector = new AudioWorkletNode(context, "studio-calibrate-detector", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    assert.ok(detector.port, "the calibration detector registered on the same context");
  } finally {
    await releaseWorklet(context);
  }
});

test("calibration measures a 3000-frame loopback within 1 frame at 0 dB and at -20 dB", async () => {
  for (const gain of [1, 0.1]) {
    // 12 clicks at the default 500 ms gap: 10 of them counted, which is the
    // fewest a calibration accepts.
    const { context, engine } = await openEngine(Math.round(7 * SAMPLE_RATE));
    let opened = false;
    try {
      await addSource(context, "test-delay", DELAY_SOURCE);
      const loop = new AudioWorkletNode(context, "test-delay", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: "explicit",
        processorOptions: { delay_frames: 3000, gain: gain },
      });
      const calibrating = engine.calibrate({
        input: loop,
        clicks: 12,
        latencyHint: "interactive",
        sinkId: "default",
        // No cable in an OfflineAudioContext: the emitter feeds the stand-in.
        onEmitter: (emitter) => emitter.connect(loop),
      });
      opened = true;
      const result = await calibrating;
      assert.equal(result.rate, SAMPLE_RATE);
      assert.equal(result.clicks_heard, 10, `at ${gain}: expected 10 heard clicks`);
      assert.ok(
        Math.abs(result.latency_frames - 3000) <= 1,
        `at ${gain}: expected a 3000-frame loopback, got ${result.latency_frames}`,
      );
      assert.equal(result.spread_frames, 0, `at ${gain}: a fixed delay should not spread`);
      assert.equal(result.latencyHint, "interactive");
      assert.equal(result.sinkId, "default");
    } finally {
      engine.dispose();
      if (!opened) await releaseWorklet(context);
    }
  }
});

test("calibration with no loopback is refused naming the cable", async () => {
  const { context, engine } = await openEngine(Math.round(2.5 * SAMPLE_RATE));
  let opened = false;
  try {
    // A gain node with nothing plugged into it is silence: the clicks go out and
    // never come back.
    const silence = context.createGain();
    const calibrating = engine.calibrate({ input: silence, clicks: 3 });
    opened = true;
    await assert.rejects(calibrating, { message: "Check the loopback cable and the input gain." });
  } finally {
    engine.dispose();
    if (!opened) await releaseWorklet(context);
  }
});

/**
 * Record one offline take from a buffer source.
 *
 * @param {{frames: number, channels?: number, arm: number, stop: number,
 *          splits?: number[], sampleOf: (frame: number) => number}} options
 * @returns {Promise<{chunks: object[], done: object}>} `chunks` are
 *   `{bytes, index, segment}` in arrival order
 */
async function recordTake(options) {
  const channels = options.channels === 2 ? 2 : 1;
  // A little past the stop frame: the recorder can only notice the stop on a
  // block that reaches it, and the stop frame is exclusive.
  const length = Math.max(options.frames, options.stop + 512);
  const { context, engine } = await openEngine(length, channels);
  let recorder = null;
  try {
    const samples = new Float32Array(options.frames);
    for (let frame = 0; frame < options.frames; frame += 1) samples[frame] = options.sampleOf(frame);
    const buffer = context.createBuffer(1, options.frames, SAMPLE_RATE);
    buffer.copyToChannel(samples, 0);
    const source = context.createBufferSource();
    source.buffer = buffer;

    const chunks = [];
    let done = null;
    recorder = await engine.createRecorder({ input: source, channels: channels });
    recorder.onChunk((bytes, index, segment) => chunks.push({ bytes: bytes, index: index, segment: segment }));
    recorder.onDone((payload) => {
      done = payload;
    });
    source.start(0);
    recorder.armAt(options.arm);
    if (options.splits) recorder.splitAt(options.splits);
    recorder.stopAt(options.stop);

    await context.startRendering();
    const arrived = await waitFor(() => done !== null);
    assert.ok(arrived, "the recorder should report done when the stop frame is reached");
    return { chunks: chunks, done: done };
  } finally {
    if (recorder) recorder.dispose();
    engine.dispose();
  }
}

/**
 * Read an ArrayBuffer of 24-bit little-endian interleaved PCM back as floats,
 * with the same full scale `server/wav.js` uses.
 * @param {ArrayBuffer} bytes
 * @param {number} channels
 * @returns {Float32Array} interleaved samples
 */
function decode24(bytes, channels) {
  const data = new Uint8Array(bytes);
  const frames = data.length / (3 * channels);
  const samples = new Float32Array(frames * channels);
  let at = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const value = data[at] | (data[at + 1] << 8) | (data[at + 2] << 16);
    samples[index] = (value >= 0x800000 ? value - 0x1000000 : value) / 8388607;
    at += 3;
  }
  return samples;
}

/** @param {number} frame @returns {number} a value no two frames share, in [0, 0.2] */
function uniqueRamp(frame) {
  return (frame + 1) / 100000;
}

/** @param {number} frame @returns {number} a bounded ramp for long renders */
function longRamp(frame) {
  return ((frame % 997) + 1) / 2000;
}

test("recorder starts and stops on the exact frames", async () => {
  const { chunks, done } = await recordTake({
    frames: 8000,
    arm: 1003,
    stop: 3007,
    sampleOf: uniqueRamp,
  });

  assert.deepEqual(done.segments, [{ segment: 0, start_frame: 1003, frames: 2004 }]);
  assert.equal(done.frames, 2004);
  assert.equal(done.start_frame, 1003);
  assert.equal(chunks.length, 1, "2004 mono frames fit in one chunk");
  assert.equal(chunks[0].segment, 0);
  assert.equal(chunks[0].index, 0);

  const samples = decode24(chunks[0].bytes, 1);
  assert.equal(samples.length, 2004);
  for (let at = 0; at < samples.length; at += 1) {
    const expected = uniqueRamp(1003 + at);
    assert.ok(
      Math.abs(samples[at] - expected) <= 3 / 8388607,
      `sample ${at} should be frame ${1003 + at}: expected ${expected}, got ${samples[at]}`,
    );
  }
});

test("recorder chunks are whole frames and concatenate to the input", async () => {
  // 349525 mono frames is one 1 MiB chunk, so this render has to hold two.
  const frames = 400000;
  const { chunks, done } = await recordTake({
    frames: frames,
    arm: 0,
    stop: frames,
    sampleOf: longRamp,
  });

  assert.equal(done.segments.length, 1);
  assert.equal(done.segments[0].frames, frames);
  assert.ok(chunks.length > 1, `expected more than one chunk, got ${chunks.length}`);

  const ordered = chunks.slice().sort((left, right) => left.index - right.index);
  let total = 0;
  for (let at = 0; at < ordered.length; at += 1) {
    const chunk = ordered[at];
    assert.equal(chunk.index, at, "chunk indexes are 0, 1, 2 … in order");
    assert.ok(chunk.bytes.byteLength <= 1048576, `chunk ${at} is over 1 MiB`);
    assert.equal(chunk.bytes.byteLength % 3, 0, `chunk ${at} does not end on a whole frame`);
    total += chunk.bytes.byteLength / 3;
  }
  assert.equal(total, frames);

  const all = new Float32Array(frames);
  let written = 0;
  for (const chunk of ordered) {
    const samples = decode24(chunk.bytes, 1);
    all.set(samples, written);
    written += samples.length;
  }
  assert.equal(written, frames);
  for (let at = 0; at < all.length; at += 1) {
    const expected = longRamp(at);
    assert.ok(
      Math.abs(all[at] - expected) <= 3 / 8388607,
      `concatenated sample ${at} should be ${expected}, got ${all[at]}`,
    );
  }
});

test("splitAt makes takes that start on the given frames", async () => {
  const { chunks, done } = await recordTake({
    frames: 14000,
    arm: 1000,
    stop: 12000,
    splits: [5000, 9000],
    sampleOf: uniqueRamp,
  });

  assert.deepEqual(done.segments, [
    { segment: 0, start_frame: 1000, frames: 4000 },
    { segment: 1, start_frame: 5000, frames: 4000 },
    { segment: 2, start_frame: 9000, frames: 3000 },
  ]);
  assert.equal(done.frames, 11000);

  // One chunk per segment, and each segment's chunk index restarts at 0.
  assert.equal(chunks.length, 3);
  const ordered = chunks.slice().sort((left, right) => left.segment - right.segment);
  for (let at = 0; at < done.segments.length; at += 1) {
    const segment = done.segments[at];
    assert.equal(ordered[at].segment, segment.segment);
    assert.equal(ordered[at].index, 0, "the chunk index restarts for every take");
    const samples = decode24(ordered[at].bytes, 1);
    assert.equal(samples.length, segment.frames);
    for (let index = 0; index < samples.length; index += 1) {
      const expected = uniqueRamp(segment.start_frame + index);
      assert.ok(
        Math.abs(samples[index] - expected) <= 3 / 8388607,
        `segment ${segment.segment} sample ${index} should be frame ${segment.start_frame + index}`,
      );
    }
  }
});