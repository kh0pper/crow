/**
 * Studio calibration, recording and metering worklets — the loopback
 * measurement, the 24-bit take recorder and the input meter's reading.
 *
 * Everything runs on `node-web-audio-api`'s OfflineAudioContext with the real
 * `bundles/studio/engine/engine-client.js` and the real worklet files, so the
 * test measures the code the browser and the renderer run. The meter's own
 * reading is also driven block by block in a bare worklet-like scope, where the
 * arrays it allocates can be counted.
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
import vm from "node:vm";
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
const INPUT_LEVEL_SOURCE = readFileSync(join(ENGINE_DIR, "input-level.js"), "utf8");
const INPUT_METER_SOURCE = readFileSync(join(ENGINE_DIR, "input-meter-processor.js"), "utf8");

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
/**
 * Load recorder-processor.js in a bare worklet-like scope and return a
 * processor that the test drives block by block. `currentFrame` is the
 * scope's, so the test decides what "now" is when a message arrives.
 * @param {number} channels
 */
function bareRecorder(channels) {
  const source = readFileSync(join(ENGINE_DIR, "recorder-processor.js"), "utf8");
  let Processor = null;
  const scope = {
    sampleRate: SAMPLE_RATE,
    currentFrame: 0,
    AudioWorkletProcessor: class {
      constructor() {
        this.port = { postMessage: (message) => scope.posted.push(message), onmessage: null };
      }
    },
    registerProcessor: (_name, ctor) => {
      Processor = ctor;
    },
    posted: [],
  };
  vm.runInNewContext(source, scope);
  const processor = new Processor({ processorOptions: { channels } });
  return {
    scope,
    send: (message) => processor.port.onmessage({ data: message }),
    run(fromFrame, frames, sampleOf) {
      for (let at = 0; at < frames; at += 128) {
        scope.currentFrame = fromFrame + at;
        const input = new Float32Array(128);
        for (let i = 0; i < 128; i += 1) input[i] = sampleOf(fromFrame + at + i);
        processor.process([[input]], [[new Float32Array(128)]]);
      }
    },
  };
}

test("an arm frame that already played starts the take exactly there, from the pre-roll", () => {
  const rec = bareRecorder(1);
  const ramp = (frame) => ((frame % 4096) - 2048) / 4096;
  // The launch happened at frame 9600; its report reaches the recorder about
  // 0.5 s later, as a real launch report does (after the frame has played).
  // Blocks are 128 frames, so "now" is a whole number of blocks.
  const now = 263 * 128; // 33664
  rec.run(0, now, ramp);
  rec.send({ type: "arm", frame: 9600 });
  rec.send({ type: "stop", frame: 9600 + 48000 });
  rec.run(now, 48000, ramp);

  const done = rec.scope.posted.find((message) => message.type === "done");
  assert.ok(done, "the recorder reported done");
  assert.equal(done.segments[0].start_frame, 9600);
  assert.equal(done.segments[0].frames, 48000, "the whole take, from its arm frame");
  const bytes = new Uint8Array(rec.scope.posted.find((message) => message.type === "chunk" && message.index === 0).bytes);
  const samples = decode24(bytes.buffer, 1);
  for (const at of [0, 1, 1000, 23999, 24000, 47999]) {
    assert.ok(
      Math.abs(samples[at] - ramp(9600 + at)) <= 3 / 8388607,
      `take sample ${at} should be input frame ${9600 + at}`,
    );
  }
});

test("an arm frame older than the pre-roll starts on its frame with silence for the missing part", () => {
  const rec = bareRecorder(1);
  const one = () => 0.5;
  const preroll = 4 * SAMPLE_RATE;
  const now = Math.ceil((1024 + preroll + 4096) / 128) * 128;
  rec.run(0, now, one);
  rec.send({ type: "arm", frame: 1024 });
  rec.send({ type: "stop", frame: 1024 + preroll + 8192 });
  rec.run(now, 8192 + 1024, one);
  const done = rec.scope.posted.find((message) => message.type === "done");
  assert.equal(done.segments[0].start_frame, 1024);
  assert.equal(done.segments[0].frames, preroll + 8192);
  const first = decode24(rec.scope.posted.find((message) => message.type === "chunk" && message.index === 0).bytes, 1);
  assert.equal(first[0], 0, "frames older than the pre-roll are silence");
  assert.ok(Math.abs(first[first.length - 1] - 0.5) < 1e-6, "kept frames are the input");
});

/**
 * `input-level.js` makes every buffer it uses in its constructor, so a count of
 * the arrays a block creates is a count of the arrays the audio thread makes.
 * The wrappers below are injected INTO the worklet-like scope as its
 * `Float32Array`, `Float64Array` and `Array`, which is what the core and the
 * meter construct through. Array LITERALS are not counted, and cannot be: a
 * literal in the evaluated source makes the scope's own intrinsic array, not the
 * global `Array` binding the wrappers replace.
 * @returns {{counts: object, globals: object}}
 */
function countingArrays() {
  const counts = { Float32Array: 0, Float64Array: 0, Array: 0 };
  class CountingFloat32Array extends Float32Array {
    constructor(...args) {
      super(...args);
      counts.Float32Array += 1;
    }
  }
  class CountingFloat64Array extends Float64Array {
    constructor(...args) {
      super(...args);
      counts.Float64Array += 1;
    }
  }
  class CountingArray extends Array {
    constructor(...args) {
      super(...args);
      counts.Array += 1;
    }
  }
  return {
    counts: counts,
    globals: { Float32Array: CountingFloat32Array, Float64Array: CountingFloat64Array, Array: CountingArray },
  };
}

/**
 * Load `input-level.js` and `input-meter-processor.js` in a bare worklet-like
 * scope (no `module`, no imports, counting array constructors) and return a
 * processor the test drives block by block.
 * @param {number} channels
 */
function bareMeter(channels) {
  const counting = countingArrays();
  let Processor = null;
  /** @type {any} */
  const scope = {
    console: { log() {}, warn() {}, error() {} },
    sampleRate: SAMPLE_RATE,
    currentFrame: 0,
    Float32Array: counting.globals.Float32Array,
    Float64Array: counting.globals.Float64Array,
    Array: counting.globals.Array,
    AudioWorkletProcessor: class {
      constructor() {
        this.port = {
          postMessage: (...args) => {
            scope.posts.push(args);
          },
          onmessage: null,
        };
      }
    },
    registerProcessor: (_name, ctor) => {
      Processor = ctor;
    },
    posts: [],
  };
  vm.createContext(scope);
  // The core first, the way WORKLET_FILES loads them: the meter reads its global.
  vm.runInContext(INPUT_LEVEL_SOURCE, scope, { filename: "input-level.js" });
  vm.runInContext(INPUT_METER_SOURCE, scope, { filename: "input-meter-processor.js" });
  assert.ok(scope.StudioInputLevel, "input-level.js hands the meter its core");
  const processor = new Processor({ processorOptions: { channels: channels } });
  // One silence output per channel, reused: the test's own blocks are not part
  // of the count (they are made in this realm, not the scope's constructors).
  const output = [new Float32Array(128)];
  return {
    scope: scope,
    processor: processor,
    counts: counting.counts,
    send: (message) => processor.port.onmessage({ data: message }),
    levels: () => scope.posts.filter((args) => args[0] && args[0].type === "level").map((args) => args[0]),
    /** @param {number} fromFrame @param {number} frames @param {(frame: number) => number} sampleOf */
    run(fromFrame, frames, sampleOf) {
      for (let at = 0; at + 128 <= frames; at += 128) {
        scope.currentFrame = fromFrame + at;
        const input = new Float32Array(128);
        for (let index = 0; index < 128; index += 1) input[index] = sampleOf(fromFrame + at + index);
        processor.process([[input]], [output]);
      }
    },
    /**
     * The same, as a stereo arm's input arrives: one block per channel.
     * @param {number} fromFrame @param {number} frames
     * @param {(frame: number) => number} leftOf
     * @param {(frame: number) => number} rightOf
     */
    runStereo(fromFrame, frames, leftOf, rightOf) {
      for (let at = 0; at + 128 <= frames; at += 128) {
        scope.currentFrame = fromFrame + at;
        const left = new Float32Array(128);
        const right = new Float32Array(128);
        for (let index = 0; index < 128; index += 1) {
          left[index] = leftOf(fromFrame + at + index);
          right[index] = rightOf(fromFrame + at + index);
        }
        processor.process([[left, right]], [output]);
      }
    },
  };
}

/** @param {number} frame @returns {number} a bounded sample no two frames share */
function meterRamp(frame) {
  return ((frame % 1000) - 500) / 2000;
}

test("process creates no typed array of its own: one payload per post, and the core's arrays keep their identity", () => {
  const meter = bareMeter(1);
  const core = meter.processor.core;
  const minRing = core.minRing;
  const maxRing = core.maxRing;
  const frameRing = core.frameRing;
  assert.ok(minRing instanceof Float32Array, "the core's buffers were made in its constructor");

  // Count from here: the constructor's own buffers are behind us.
  for (const name of Object.keys(meter.counts)) meter.counts[name] = 0;

  // A hidden lane makes nothing at all: no window, no payload, no post.
  meter.run(0, 1000 * 128, meterRamp);
  assert.deepEqual({ ...meter.counts }, { Float32Array: 0, Float64Array: 0, Array: 0 });
  assert.deepEqual(meter.scope.posts, []);

  // Shown, the one allocation per post is the payload's `cols` — the object a
  // structured clone carries — and nothing per block.
  meter.send({ type: "on" });
  meter.run(1000 * 128, 1000 * 128, meterRamp);
  const levels = meter.levels();
  assert.ok(levels.length > 0, "a shown lane posts");
  assert.equal(meter.counts.Float32Array, levels.length, "one Float32Array per post, none per block");
  assert.equal(meter.counts.Float64Array, 0, "the column frames are the ring's own buffer");
  assert.equal(meter.counts.Array, 0, "no array is built by the block path");
  for (const level of levels) assert.equal(level.cols.length % 3, 0, "columns are frame, min, max");

  assert.equal(core.minRing, minRing, "the same minimums buffer, 128,000 frames later");
  assert.equal(core.maxRing, maxRing, "the same maximums buffer");
  assert.equal(core.frameRing, frameRing, "the same frames buffer");
});

test("the meter posts nothing until on, and nothing after off", () => {
  const meter = bareMeter(1);
  const half = () => 0.5;

  meter.run(0, 32 * 128, half);
  assert.deepEqual(meter.scope.posts, [], "a lane nobody showed is silent");

  meter.send({ type: "on" });
  meter.run(32 * 128, 64 * 128, half);
  assert.ok(meter.levels().length > 0, "turning it on starts the posts");

  meter.send({ type: "off" });
  const posted = meter.scope.posts.length;
  meter.run(96 * 128, 200 * 128, half);
  assert.equal(meter.scope.posts.length, posted, "turning it off stops them");
});

test("a level post carries exactly one payload object", () => {
  const meter = bareMeter(1);
  meter.send({ type: "on" });
  meter.run(0, 64 * 128, (frame) => Math.sin(frame / 10) * 0.25);
  const levels = meter.levels();
  assert.ok(levels.length > 0, "the meter posted");

  for (const args of meter.scope.posts) {
    assert.equal(args.length, 1, "one argument per post: the payload, and nothing beside it");
    const payload = args[0];
    assert.deepEqual(
      Object.keys(payload).sort(),
      ["clearSeq", "clipped", "cols", "frame", "peak", "rms", "type"],
      "the payload is the drained reading, under one type",
    );
    assert.equal(payload.type, "level");
    assert.equal(typeof payload.frame, "number");
    assert.equal(typeof payload.peak, "number");
    assert.equal(typeof payload.rms, "number");
    assert.equal(typeof payload.clipped, "boolean");
    assert.equal(typeof payload.clearSeq, "number", "the clear sequence rides on the payload as a plain number");
    assert.ok(payload.cols instanceof Float32Array, "the columns travel as one typed array");
  }
});

test("a clear message lets the CLIP latch go", () => {
  const meter = bareMeter(1);
  meter.send({ type: "on" });
  meter.run(0, 16 * 128, () => 1);
  assert.equal(meter.levels().some((level) => level.clipped), true, "a full-scale sample latches CLIP");

  meter.send({ type: "clear" });
  const before = meter.levels().length;
  meter.run(16 * 128, 32 * 128, () => 0.25);
  const after = meter.levels().slice(before);
  assert.ok(after.length > 0, "it keeps posting after a clear");
  assert.deepEqual(after.map((level) => level.clipped), after.map(() => false), "and nothing quiet latches it again");
  assert.deepEqual(
    after.map((level) => level.clearSeq),
    after.map(() => 0),
    "a clear that named no sequence is sequence 0",
  );
});

test("a clear names its sequence, and every reading after it carries it", () => {
  const meter = bareMeter(1);
  meter.send({ type: "on" });
  meter.run(0, 16 * 128, () => 1);
  const latched = meter.levels();
  assert.equal(latched.some((level) => level.clipped), true, "a full-scale sample latches CLIP");
  assert.deepEqual(
    latched.map((level) => level.clearSeq),
    latched.map(() => 0),
    "and nothing has named a clear yet",
  );

  meter.send({ type: "clear", seq: 3 });
  let before = meter.levels().length;
  meter.run(16 * 128, 32 * 128, () => 0.25);
  const after = meter.levels().slice(before);
  assert.ok(after.length > 0, "it keeps posting after the clear");
  assert.deepEqual(after.map((level) => level.clearSeq), after.map(() => 3), "every reading carries sequence 3");
  assert.deepEqual(after.map((level) => level.clipped), after.map(() => false), "and the latch is let go");

  // The latch can be set again by a later sample, and the sequence stays where
  // the last clear put it: a reading this page takes now is never mistaken for
  // one taken before its clear.
  before = meter.levels().length;
  meter.run(32 * 128, 16 * 128, () => 1);
  const relatched = meter.levels().slice(before);
  assert.equal(relatched.some((level) => level.clipped), true, "a full-scale sample latches it again");
  assert.deepEqual(relatched.map((level) => level.clearSeq), relatched.map(() => 3), "under the same sequence");

  // A clear that names no sequence is sequence 0, not the sequence before it.
  meter.send({ type: "clear" });
  before = meter.levels().length;
  meter.run(48 * 128, 16 * 128, () => 0.25);
  const unnamed = meter.levels().slice(before);
  assert.ok(unnamed.length > 0, "it keeps posting after the clear");
  assert.deepEqual(unnamed.map((level) => level.clearSeq), unnamed.map(() => 0), "a clear with no sequence is 0");
  assert.deepEqual(unnamed.map((level) => level.clipped), unnamed.map(() => false), "and it still lets the latch go");
});

test("a stereo arm meters a signal that only reaches the right channel", () => {
  const meter = bareMeter(2);
  meter.send({ type: "on" });
  // Silence on the left, a constant negative reading on the right.
  meter.runStereo(0, 32 * 128, () => 0, () => -0.5);

  const levels = meter.levels();
  assert.ok(levels.length > 0, "the meter posted");
  for (const level of levels) {
    assert.ok(Math.abs(level.peak - 0.5) <= 1e-6, `the right channel is the peak, was ${level.peak}`);
    // Two channels of squares, one of them silent: the whole reading's RMS.
    assert.ok(Math.abs(level.rms - 0.5 / Math.SQRT2) <= 1e-6, `the rms covers both channels, was ${level.rms}`);
    assert.equal(level.clipped, false, "half scale does not latch CLIP");
    for (let at = 0; at + 2 < level.cols.length; at += 3) {
      assert.equal(level.cols[at + 1], -0.5, `column ${at / 3} takes the right channel's minimum`);
      assert.equal(level.cols[at + 2], 0, `column ${at / 3} and the left channel's maximum`);
    }
  }

  // A mono arm is unchanged: one channel, its own reading.
  const mono = bareMeter(1);
  mono.send({ type: "on" });
  mono.run(0, 32 * 128, () => -0.5);
  for (const level of mono.levels()) {
    assert.ok(Math.abs(level.peak - 0.5) <= 1e-6, "a mono reading is its one channel");
    assert.ok(Math.abs(level.rms - 0.5) <= 1e-6, "with no second channel folded in");
  }
});

test("showing a lane again starts from an empty ring, so no stale column is posted", () => {
  const meter = bareMeter(1);
  const half = () => 0.5;
  meter.send({ type: "on" });
  // Nine blocks are 1152 frames: two 480-frame columns have closed and no post
  // is due yet (a post is 1600 frames), so both are still in the ring.
  meter.run(0, 9 * 128, half);
  assert.equal(meter.levels().length, 0, "no post was due yet");
  assert.equal(meter.processor.core.count, 2, "two columns are waiting in the ring");

  meter.send({ type: "off" });
  meter.send({ type: "on" });
  assert.equal(meter.processor.core.count, 0, "showing the lane again empties the ring");
  assert.equal(meter.processor.core.head, 0, "and starts at its first slot");

  meter.run(9 * 128, 13 * 128, half);
  const levels = meter.levels();
  assert.equal(levels.length, 1, "one post came due");
  const cols = levels[0].cols;
  assert.equal(cols.length, 3 * 3, "three columns closed after the lane was shown again");
  assert.equal(cols[0], 9 * 128, "the first one starts on the block the lane was shown on");
  for (let at = 0; at + 2 < cols.length; at += 3) {
    assert.ok(cols[at] >= 9 * 128, `column ${at / 3} is not one from before the lane was hidden`);
  }
});
