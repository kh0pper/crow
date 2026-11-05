/**
 * Studio sampler voices — pads, slices, pitch, gates, chokes and voice stealing.
 *
 * The renders are the real engine: `node-web-audio-api`'s OfflineAudioContext
 * with the very same `bundles/studio/engine/engine-client.js` the browser and
 * the MCP renderer load. Every sample here is synthetic — a ramp, a constant or
 * an impulse — so a test can name the exact frame and level a pad has to produce
 * instead of guessing from a shape.
 *
 * Read of rendered audio is always `copyFromChannel()` into a JS-owned array:
 * `getChannelData()` does not work in node-web-audio-api (#714). The sample PCM
 * a test hands to `loadSample()` is copied per render, because the client
 * transfers the arrays to the worklet.
 *
 * At 120 bpm and 48 kHz one beat is 24,000 frames, one 16th is 6,000 and one
 * bar is 96,000. The mix's centre-pan coefficient is `cos(π/4)`, and a voice's
 * gain is `10^(gain_db/20) × (v/127)²`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
const { OfflineAudioContext } = bundleRequire("node-web-audio-api");
const studioEngine = bundleRequire(join(ENGINE_DIR, "engine-client.js"));
const StudioSequencer = bundleRequire(join(ENGINE_DIR, "sequencer.js"));

// `startRendering()` releases the worklet thread; a test that stops before it
// gets there has to release it by hand or the process never exits.
const { kWorkletRelease } = await import(pathToFileURL(SYMBOLS_FILE).href);

/** The engine sources, read from the bundle exactly as a Node caller would. */
const ASSETS = {
  "sequencer.js": readFileSync(join(ENGINE_DIR, "sequencer.js"), "utf8"),
  "resample.js": readFileSync(join(ENGINE_DIR, "resample.js"), "utf8"),
  "sampler-voice.js": readFileSync(join(ENGINE_DIR, "sampler-voice.js"), "utf8"),
  "sunvox.js": readFileSync(join(VENDOR_DIR, "sunvox.js"), "utf8"),
  "studio-processor.js": readFileSync(join(ENGINE_DIR, "studio-processor.js"), "utf8"),
  "sunvox.wasm": readFileSync(join(VENDOR_DIR, "sunvox.wasm")),
};

const SAMPLE_RATE = 48000;
const FRAMES_PER_BEAT = 24000;
const FRAMES_PER_SIXTEENTH = FRAMES_PER_BEAT / 4;
const SAMPLE_ID = "sample-1";
const BANK = "bank-a";
const CENTRE = Math.cos(Math.PI / 4);

// --- song pieces in the snapshot's shape (`server/doc.js`) ------------------

/** A sampler track. */
function track(id, over = {}) {
  return {
    id,
    name: id,
    color: "#E8C07A",
    device: { engine: "sampler" },
    mute: false,
    solo: false,
    gain_db: 0,
    pan: 0,
    locked: false,
    ...over,
  };
}

/** A pattern clip of one pattern, "a": nothing plays but its steps. */
function patternClip(id, trackId, over = {}) {
  const lengthSteps = over.length_steps === undefined ? 16 : over.length_steps;
  const stepBeats = over.step_beats === undefined ? 0.25 : over.step_beats;
  return {
    id,
    track_id: trackId,
    scene_id: "scene-1",
    name: id,
    length_bars: Math.max(1, Math.ceil((lengthSteps * stepBeats) / 4)),
    notes: [],
    kind: "pattern",
    length_steps: lengthSteps,
    step_beats: stepBeats,
    swing: 0,
    chain: [],
    ...over,
  };
}

/** A clip of notes, for the SunVox tracks a dense song mixes in. */
function noteClip(id, trackId, notes) {
  return { id, track_id: trackId, scene_id: "scene-1", name: id, length_bars: 1, notes };
}

/** One pad of a kit, with every field `doc.js` writes. */
function pad(trackId, index, over = {}) {
  return {
    track_id: trackId,
    bank_id: BANK,
    index,
    sample_id: SAMPLE_ID,
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
    choke: 0,
    reverse: false,
    ...over,
  };
}

/** One step of the pattern "a", at one position, on one pad. */
function step(clipId, at, index, over = {}) {
  return {
    clip_id: clipId,
    pattern_id: "a",
    at,
    bank_id: BANK,
    index,
    v: 100,
    locks: {},
    ...over,
  };
}

/** A sample in the document's shape: the audio itself never lives in the song. */
function sampleDoc(id, frames, over = {}) {
  return {
    id,
    storage_key: `studio/song-1/samples/${id}.wav`,
    rate: SAMPLE_RATE,
    channels: 1,
    frames,
    name: id,
    origin: "record",
    author_label: "the operator",
    ...over,
  };
}

/** A slice in the document's shape. */
function sliceDoc(sampleId, id, startFrame, endFrame) {
  return { id, sample_id: sampleId, start_frame: startFrame, end_frame: endFrame };
}

/** @returns {string} the key one pad lives under in the song's `pads`. */
function padKeyOf(item) {
  return `${item.track_id}/${item.bank_id}/${item.index}`;
}

/** @returns {string} the key one step lives under in the song's `steps`. */
function stepKeyOf(item) {
  return `${item.clip_id}/${item.pattern_id}/${item.at}/${item.bank_id}.${item.index}`;
}

/**
 * One sampler song: one scene, the tracks, their clips, the kit and the steps.
 * @param {{tracks: object[], clips: object[], steps: object[], pads: object[],
 *          samples?: object, slices?: object, patterns?: object}} options
 * @returns {object} a snapshot in the shape `server/doc.js` writes
 */
function samplerSong({ tracks, clips, steps, pads, samples = {}, slices = {}, patterns = null }) {
  return {
    meta: { title: "Sampler engine test", bpm: 120, meter: [4, 4], key: "C major" },
    tracks,
    scenes: [{ id: "scene-1", name: "A" }],
    clips: Object.fromEntries(clips.map((clip) => [clip.id, clip])),
    takes: {},
    samples,
    slices,
    banks: Object.fromEntries(tracks.map((item) => [`${item.id}/${BANK}`, { id: BANK, track_id: item.id, name: "A", order: 0 }])),
    pads: Object.fromEntries(pads.map((item) => [padKeyOf(item), item])),
    patterns:
      patterns ||
      Object.fromEntries(
        clips
          .filter((clip) => clip.kind === "pattern")
          .map((clip) => [`${clip.id}/a`, { id: "a", clip_id: clip.id, name: "A", order: 0 }]),
      ),
    steps: Object.fromEntries(steps.map((item) => [stepKeyOf(item), item])),
  };
}

// --- rendering --------------------------------------------------------------

/** @param {number} frames @returns {Float32Array} 1e-5, 2e-5, … */
function ramp(frames) {
  const samples = new Float32Array(frames);
  for (let at = 0; at < frames; at += 1) samples[at] = (at + 1) / 100000;
  return samples;
}

/** @param {number} frames @param {number} value @returns {Float32Array} a constant */
function constant(frames, value) {
  const samples = new Float32Array(frames);
  samples.fill(value);
  return samples;
}

/** @param {Float32Array} samples @returns {number} the largest absolute sample */
function peakOf(samples) {
  let peak = 0;
  for (let at = 0; at < samples.length; at += 1) {
    const value = Math.abs(samples[at]);
    if (value > peak) peak = value;
  }
  return peak;
}

/** @param {Float32Array} samples @returns {number} the largest absolute sample over a range */
function peakBetween(samples, from, to) {
  return peakOf(samples.subarray(from, to));
}

/**
 * The step position the motion descriptors of a render put on one frame, read
 * exactly the way the processor reads it: from the song's clock alone.
 * @param {Array<{frame: number, motion: object}>} starts the descriptors, in frame order
 * @param {number} frame an absolute frame
 * @returns {number|null} the step position, or null when no curve stands there
 */
function stepFracAt(starts, frame) {
  let standing = null;
  for (let at = 0; at < starts.length; at += 1) {
    if (starts[at].frame > frame) break;
    standing = starts[at].motion;
  }
  if (!standing || !standing.lanes) return null;
  const beat = (frame - standing.origin_frame) / standing.frames_per_beat;
  return (beat - standing.slot_start_beat) / standing.step_beats;
}

/**
 * Every motion descriptor a render produces, as absolute frames, at one block
 * size. A different block size has to describe the very same curve for the very
 * same frame; that is what makes the rendered sweep block-size independent.
 * @param {object} song
 * @param {number} blockSize
 * @param {number} frames
 * @returns {Array<{frame: number, motion: object}>}
 */
function motionStarts(song, blockSize, frames) {
  const seq = StudioSequencer.create({ sampleRate: SAMPLE_RATE });
  seq.setSong(song);
  seq.launchScene("scene-1");
  seq.play();
  const starts = [];
  for (let at = 0; at < frames; at += blockSize) {
    const count = Math.min(blockSize, frames - at);
    for (const motion of seq.block(at, count).motions) starts.push({ frame: at + motion.frame, motion });
  }
  return starts;
}

/** @param {BaseAudioContext} context @returns {Promise<void>} */
async function releaseWorklet(context) {
  try {
    await context.audioWorklet[kWorkletRelease]();
  } catch {
    /* nothing to release */
  }
}

/**
 * Render one sampler song offline: build the engine, hand it the samples, then
 * the song, launch its scene, play, render. `tap` turns a tap on before the
 * transport starts, and `onTap` sees every `{target, frame, channels}` block it
 * posts.
 * @param {object} song
 * @param {{seconds?: number, samples?: object[], onError?: (text: string) => void,
 *          onSampleNeeded?: (sampleId: string) => void, tap?: string|null,
 *          onTap?: (tap: {target: string, frame: number, channels: Float32Array[]}) => void}} [options]
 *   `samples` is one `{id, channels}` per sample to load, each at the context's rate
 * @returns {Promise<{left: Float32Array, right: Float32Array, taps: object[]}>}
 */
async function renderSamplerSong(
  song,
  { seconds = 1, samples = [], onError, onSampleNeeded, tap = null, onTap = null } = {},
) {
  const context = new OfflineAudioContext({
    numberOfChannels: 2,
    length: Math.round(seconds * SAMPLE_RATE),
    sampleRate: SAMPLE_RATE,
  });
  let engine = null;
  let rendered = false;
  const taps = [];
  try {
    engine = await studioEngine.create(context, { assetBytes: ASSETS });
    if (typeof onError === "function") engine.onError(onError);
    if (typeof onSampleNeeded === "function") engine.onSampleNeeded(onSampleNeeded);
    if (typeof onTap === "function") {
      engine.onTap((block) => {
        taps.push(block);
        onTap(block);
      });
    } else {
      engine.onTap((block) => taps.push(block));
    }
    for (const item of samples) {
      // A fresh copy per render: loadSample transfers the buffers to the worklet.
      await engine.loadSample(
        item.id,
        item.channels.map((channel) => Float32Array.from(channel)),
        SAMPLE_RATE,
      );
    }
    engine.setSong(song);
    if (tap) engine.tap(tap, true);
    engine.launchScene("scene-1");
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
    return { left, right, taps };
  } finally {
    if (engine) engine.dispose();
    if (!rendered) await releaseWorklet(context);
  }
}

/** Assert one rendered frame against what the voice has to have produced. */
function assertLevel(actual, expected, what, tolerance = 1e-6) {
  assert.ok(
    Math.abs(actual - expected) < tolerance,
    `${what}: expected ${expected}, got ${actual}`,
  );
}

/**
 * Press and release one pad through the engine's live messages, before the
 * render starts: a live note goes straight to a voice and is never quantized.
 * @param {object} song
 * @param {{seconds?: number, samples?: object[], index?: number}} [options]
 * @returns {Promise<{left: Float32Array, right: Float32Array}>}
 */
async function renderLivePad(song, { seconds = 0.4, samples = [], index = 0 } = {}) {
  const context = new OfflineAudioContext({
    numberOfChannels: 2,
    length: Math.round(seconds * SAMPLE_RATE),
    sampleRate: SAMPLE_RATE,
  });
  let engine = null;
  let rendered = false;
  try {
    engine = await studioEngine.create(context, { assetBytes: ASSETS });
    for (const item of samples) {
      await engine.loadSample(
        item.id,
        item.channels.map((channel) => Float32Array.from(channel)),
        SAMPLE_RATE,
      );
    }
    engine.setSong(song);
    engine.play();
    engine.node.connect(context.destination);
    // The track's slot is built by the song; the press waits for it.
    await engine.flush();
    engine.livePad("track-1", BANK, index, 127);
    await engine.flush();
    engine.liveRelease("track-1", BANK, index);
    await engine.flush();
    const buffer = await context.startRendering();
    rendered = true;
    const left = new Float32Array(buffer.length);
    const right = new Float32Array(buffer.length);
    buffer.copyFromChannel(left, 0);
    buffer.copyFromChannel(right, 1);
    return { left, right };
  } finally {
    if (engine) engine.dispose();
    if (!rendered) await releaseWorklet(context);
  }
}

// --- the processor itself, at any block size --------------------------------

/**
 * The engine module the way `engine-client.js` joins it: the six sources, one
 * module, so a test can instantiate the processor itself.
 */
const PROCESSOR_MODULE = studioEngine.composeEngineModule([
  ASSETS["sequencer.js"],
  ASSETS["resample.js"],
  ASSETS["sampler-voice.js"],
  readFileSync(join(ENGINE_DIR, "perf-fx.js"), "utf8"),
  ASSETS["sunvox.js"],
  ASSETS["studio-processor.js"],
]);

/**
 * One Studio processor in a stand-in AudioWorkletGlobalScope.
 *
 * The offline host only ever hands the processor 128 frames (the render
 * quantum), so a value that depends on the FRAME and not on the block can only
 * be proved by calling `process()` with blocks of another size. This is that
 * host: a `sampleRate`, a `port`, and `process()` driven block by block.
 * @param {object} song a snapshot, as `server/doc.js` writes it
 * @param {Array<{id: string, channels: Float32Array[]}>} samples copied in like `loadSample`
 * @returns {Promise<{process: function(number, number): Promise<{left: Float32Array, right: Float32Array}>,
 *                    errors: string[]}>}
 */
async function createProcessor(song, samples) {
  const vm = await import("node:vm");
  const messages = [];
  let settleReady = null;
  const ready = new Promise((resolve) => {
    settleReady = resolve;
  });
  const scope = {
    sampleRate: SAMPLE_RATE,
    currentFrame: 0,
    WebAssembly,
    console: { log() {}, warn() {}, error() {} },
    AudioWorkletProcessor: class {
      constructor() {
        this.port = {
          postMessage: (message) => {
            messages.push(message);
            if (message && message.type === "ready") settleReady();
          },
          onmessage: null,
        };
      }
    },
    registerProcessor: (name, Processor) => {
      scope.__processor = Processor;
    },
  };
  vm.createContext(scope);
  vm.runInContext(PROCESSOR_MODULE, scope, { filename: "studio-engine.js" });
  const processor = new scope.__processor({
    processorOptions: { wasmBinary: new Uint8Array(ASSETS["sunvox.wasm"]) },
  });
  await ready;

  const post = (message) => processor.port.onmessage({ data: message });
  for (const item of samples) {
    post({
      type: "sample",
      sample_id: item.id,
      channels: item.channels.map((channel) => Array.from(channel)),
    });
  }
  post({ type: "song", snapshot: song });
  // The slot work is queued behind the messages; a flush answers after it.
  await new Promise((resolve) => {
    const answer = () => {
      if (messages.some((message) => message && message.type === "flushed")) resolve();
      else setTimeout(answer, 1);
    };
    post({ type: "flush", id: 1 });
    answer();
  });
  post({ type: "launchScene", id: "scene-1" });
  post({ type: "play" });

  return {
    errors: messages.filter((message) => message && message.type === "error").map((message) => message.error),
    /** Post one protocol message, the way the worklet's port does. */
    post,
    /** @returns {Promise<{left: Float32Array, right: Float32Array}>} the mix, in `blockSize` blocks */
    async process(blockSize, frames) {
      const left = new Float32Array(frames);
      const right = new Float32Array(frames);
      for (let at = 0; at < frames; at += blockSize) {
        const count = Math.min(blockSize, frames - at);
        const blockLeft = new Float32Array(count);
        const blockRight = new Float32Array(count);
        processor.process([], [[blockLeft, blockRight]]);
        left.set(blockLeft, at);
        right.set(blockRight, at);
      }
      return { left, right };
    },
  };
}

/**
 * Render one song through the processor itself, at one block size.
 * @param {object} song
 * @param {number} blockSize
 * @param {number} frames
 * @param {Array<{id: string, channels: Float32Array[]}>} [samples]
 * @returns {Promise<{left: Float32Array, right: Float32Array}>}
 */
async function renderProcessor(song, blockSize, frames, samples = []) {
  const engine = await createProcessor(song, samples);
  const rendered = await engine.process(blockSize, frames);
  assert.deepEqual(engine.errors, [], "the processor must render without reporting a fault");
  return rendered;
}

// --- the tests --------------------------------------------------------------

test("a pad plays its slice sample-exact", async () => {
  const samples = ramp(4800);
  const song = samplerSong({
    tracks: [track("track-1")],
    clips: [patternClip("clip-1", "track-1")],
    pads: [pad("track-1", 0, { slice_id: "s1" })],
    samples: { [SAMPLE_ID]: sampleDoc(SAMPLE_ID, 4800) },
    slices: { [`${SAMPLE_ID}/s1`]: sliceDoc(SAMPLE_ID, "s1", 1000, 3000) },
    steps: [step("clip-1", 0, 0, { v: 127 })],
  });

  const { left, right } = await renderSamplerSong(song, {
    seconds: 0.1,
    samples: [{ id: SAMPLE_ID, channels: [samples] }],
  });

  // Slice frames 1000 to 3000 sound from the very first frame, sample-exact.
  for (const at of [0, 1, 2, 100, 1000, 1999]) {
    const want = samples[1000 + at] * CENTRE;
    assert.ok(
      Math.abs(left[at] - want) < 1e-7,
      `left frame ${at}: expected ${want}, got ${left[at]} (the slice has to start on the trigger frame)`,
    );
    assert.ok(
      Math.abs(right[at] - want) < 1e-7,
      `right frame ${at}: expected ${want}, got ${right[at]} (a mono sample plays to both channels)`,
    );
  }

  // The slice runs out at frame 2000: it holds for its 64-frame fade and stops.
  for (const at of [2100, 2500, 4799]) {
    assert.equal(left[at], 0, `frame ${at} is past the slice's end and has to be silent`);
  }
});

test("pitch +12 plays an octave up at half length", async () => {
  // An odd length whose last sample is 0, so the octave-up voice reads
  // positions 0, 2, 4, … and its very last read lands on that zero.
  const samples = ramp(2001);
  samples[2000] = 0;

  const song = samplerSong({
    tracks: [track("track-1")],
    clips: [patternClip("clip-1", "track-1")],
    pads: [pad("track-1", 0, { pitch: 12 })],
    samples: { [SAMPLE_ID]: sampleDoc(SAMPLE_ID, 2001) },
    steps: [step("clip-1", 0, 0, { v: 127 })],
  });

  const { left } = await renderSamplerSong(song, {
    seconds: 0.1,
    samples: [{ id: SAMPLE_ID, channels: [samples] }],
  });

  for (const at of [0, 1, 2, 100, 500, 999]) {
    const want = samples[at * 2] * CENTRE;
    assert.ok(
      Math.abs(left[at] - want) < 1e-7,
      `frame ${at} should read sample ${at * 2}: expected ${want}, got ${left[at]}`,
    );
  }

  // Half the length: the last frame of the sound is 1000, and frame 1001 on is
  // silence (the fade holds that zero).
  assertLevel(left[1000], 0, "frame 1000 reads the sample's own last frame, which is zero");
  for (const at of [1001, 1100, 1500]) {
    assert.equal(left[at], 0, `frame ${at} is past half the sample and has to be silent`);
  }
});

test("gate mode releases at the step end", async () => {
  const samples = constant(48000, 0.5);
  const song = samplerSong({
    tracks: [track("track-1")],
    clips: [patternClip("clip-1", "track-1")],
    pads: [pad("track-1", 0, { mode: "gate" })],
    samples: { [SAMPLE_ID]: sampleDoc(SAMPLE_ID, 48000) },
    // One step, so there is exactly one trigger in this render.
    steps: [step("clip-1", 0, 0, { v: 127 })],
  });

  const { left } = await renderSamplerSong(song, {
    seconds: 0.4,
    samples: [{ id: SAMPLE_ID, channels: [samples] }],
  });

  // A 16th step is 6000 frames: the voice sounds for all of them and releases
  // on the very frame the step ends (a release of 0 ms is an immediate stop).
  const gate = FRAMES_PER_SIXTEENTH;
  for (const at of [0, 1, 3000, gate - 1]) {
    assertLevel(left[at], 0.5 * CENTRE, `frame ${at} is inside the gate`);
  }
  for (const at of [gate, gate + 1, gate + 500, 19199]) {
    assert.equal(left[at], 0, `frame ${at} is past the gate and has to be silent`);
  }
});

test("choke group cuts the open hat within 64 frames", async () => {
  const samples = constant(48000, 0.5);
  const song = samplerSong({
    tracks: [track("track-1")],
    clips: [patternClip("clip-1", "track-1")],
    pads: [
      pad("track-1", 0, { choke: 1 }),
      // The same sound, 6 dB down, so the two voices can be told apart.
      pad("track-1", 1, { choke: 1, gain_db: -6 }),
    ],
    samples: { [SAMPLE_ID]: sampleDoc(SAMPLE_ID, 48000) },
    steps: [step("clip-1", 0, 0, { v: 127 }), step("clip-1", 1, 1, { v: 127 })],
  });

  const { left } = await renderSamplerSong(song, {
    seconds: 0.4,
    samples: [{ id: SAMPLE_ID, channels: [samples] }],
  });

  const open = 0.5 * CENTRE;
  const choked = open * Math.pow(10, -6 / 20);
  const trigger = FRAMES_PER_SIXTEENTH;

  // Before the second hit, the open hat alone.
  for (const at of [0, 1, trigger - 1]) {
    assertLevel(left[at], open, `frame ${at} is the open hat alone`);
  }

  // On its own frame the new voice starts at full level and the open hat is
  // still there; 64 frames later the choke has taken it away.
  assertLevel(left[trigger], open + choked, "the choke's own frame still holds both voices");
  assert.ok(
    left[trigger + 63] < left[trigger],
    `the choked voice has to be on its way out by frame ${trigger + 63}, got ${left[trigger + 63]}`,
  );
  for (const at of [trigger + 64, trigger + 65, trigger + 2000]) {
    assertLevel(left[at], choked, `frame ${at} is past the 64-frame choke and has to be the new voice alone`);
  }
});

test("the 17th voice steals the oldest", async () => {
  // One long constant, so every voice is still sounding when the 17th lands.
  const samples = constant(144000, 0.5);
  const song = samplerSong({
    tracks: [track("track-1")],
    clips: [patternClip("clip-1", "track-1", { length_steps: 32 })],
    pads: [pad("track-1", 0)],
    samples: { [SAMPLE_ID]: sampleDoc(SAMPLE_ID, 144000) },
    // 17 steps of rising velocity: each voice's gain is (v/127)², so the sum
    // says which voices are sounding.
    steps: Array.from({ length: 17 }, (unused, at) => step("clip-1", at, 0, { v: at + 1 })),
  });

  const { left } = await renderSamplerSong(song, {
    seconds: 2.1,
    samples: [{ id: SAMPLE_ID, channels: [samples] }],
  });

  const gain = (velocity) => (velocity / 127) * (velocity / 127);
  const sum = (from, to) => {
    let total = 0;
    for (let velocity = from; velocity <= to; velocity += 1) total += gain(velocity);
    return total;
  };

  // 16 voices (velocities 1..16) sound before the 17th trigger.
  assertLevel(
    left[16 * FRAMES_PER_SIXTEENTH - 500],
    0.5 * CENTRE * sum(1, 16),
    "16 voices sound before the 17th trigger",
  );
  // The 17th steals the oldest, the velocity-1 voice, so velocities 2..17 sound.
  assertLevel(
    left[16 * FRAMES_PER_SIXTEENTH + 500],
    0.5 * CENTRE * sum(2, 17),
    "the 17th voice has to have replaced the oldest one",
  );
});

test("the song-wide 64-voice cap steals across tracks", async () => {
  const samples = constant(48000, 0.5);
  // Five tracks, 16 pads each, all triggered on the same frame: 80 voices for a
  // 64-voice song. The first track's pads are full velocity and the rest are
  // velocity 1, so the level says exactly which voices survived.
  const tracks = [];
  const clips = [];
  const pads = [];
  const steps = [];
  for (let index = 0; index < 5; index += 1) {
    const trackId = `track-${index + 1}`;
    const clipId = `clip-${index + 1}`;
    tracks.push(track(trackId));
    clips.push(patternClip(clipId, trackId));
    for (let padIndex = 0; padIndex < 16; padIndex += 1) {
      pads.push(pad(trackId, padIndex));
      steps.push(step(clipId, 0, padIndex, { v: index === 0 ? 127 : 1 }));
    }
  }

  const song = samplerSong({
    tracks,
    clips,
    pads,
    steps,
    samples: { [SAMPLE_ID]: sampleDoc(SAMPLE_ID, 48000) },
  });

  const { left } = await renderSamplerSong(song, {
    seconds: 0.2,
    samples: [{ id: SAMPLE_ID, channels: [samples] }],
  });

  // The oldest 16 voices are the whole first track, so the 64 that survive are
  // tracks 2..5 at velocity 1.
  const expected = 0.5 * CENTRE * 64 * Math.pow(1 / 127, 2);
  for (const at of [0, 1, 500, 9000]) {
    assertLevel(left[at], expected, `frame ${at} should hold exactly the 64 newest voices`);
  }
});

test("a lock changes only its step's voice", async () => {
  // A short constant: the first voice is over long before the second lands.
  const samples = constant(4000, 0.5);
  const song = samplerSong({
    tracks: [track("track-1")],
    clips: [patternClip("clip-1", "track-1")],
    pads: [pad("track-1", 0)],
    samples: { [SAMPLE_ID]: sampleDoc(SAMPLE_ID, 4000) },
    steps: [
      step("clip-1", 0, 0, { v: 127 }),
      // Half-way through the bar, 20 dB down: the lock belongs to this voice.
      step("clip-1", 8, 0, { v: 127, locks: { gain_db: -20 } }),
    ],
  });

  const { left } = await renderSamplerSong(song, {
    seconds: 1.2,
    samples: [{ id: SAMPLE_ID, channels: [samples] }],
  });

  for (const at of [0, 1, 3999]) {
    assertLevel(left[at], 0.5 * CENTRE, `frame ${at} is the unlocked step's voice`);
  }
  assert.equal(left[20000], 0, "the first voice's sample has run out before the locked step");

  const locked = 8 * FRAMES_PER_SIXTEENTH;
  const quiet = 0.5 * Math.pow(10, -20 / 20) * CENTRE;
  for (const at of [locked, locked + 1, locked + 3999]) {
    assertLevel(left[at], quiet, `frame ${at} is the locked step's voice`);
  }
});

test("an attacked pad ramps up linearly over its attack", async () => {
  // 5 ms of attack at 48 kHz is exactly 240 frames.
  const ATTACK = 240;
  const song = samplerSong({
    tracks: [track("track-1")],
    clips: [patternClip("clip-1", "track-1")],
    pads: [pad("track-1", 0, { attack_ms: 5 })],
    samples: { [SAMPLE_ID]: sampleDoc(SAMPLE_ID, 4800) },
    steps: [step("clip-1", 0, 0, { v: 127 })],
  });

  const { left } = await renderSamplerSong(song, {
    seconds: 0.2,
    samples: [{ id: SAMPLE_ID, channels: [constant(4800, 0.5)] }],
  });

  const full = 0.5 * CENTRE;
  // The attack starts at silence and climbs one frame at a time: a voice that
  // starts at level 0 is still a voice that started.
  assertLevel(left[0], 0, "the attack's own frame is silence", 1e-9);
  for (const at of [1, 60, 120, 239]) {
    assertLevel(left[at], (full * at) / ATTACK, `frame ${at} is that far up the attack`, 1e-7);
  }
  for (const at of [ATTACK, 1000, 4799]) {
    assertLevel(left[at], full, `frame ${at} is past the attack and at full level`, 1e-7);
  }
  for (const at of [4900, 5000]) {
    assert.equal(left[at], 0, `frame ${at} is past the sample and has to be silent`);
  }
});

test("attack, sustain and filter type locks apply to their step", async () => {
  // Four 16ths on one pad, each 4000 frames long: no voice overlaps the next.
  const song = samplerSong({
    tracks: [track("track-1")],
    clips: [patternClip("clip-1", "track-1")],
    pads: [pad("track-1", 0)],
    samples: { [SAMPLE_ID]: sampleDoc(SAMPLE_ID, 4000) },
    steps: [
      step("clip-1", 0, 0, { v: 127 }),
      step("clip-1", 4, 0, { v: 127, locks: { attack_ms: 5 } }),
      step("clip-1", 8, 0, { v: 127, locks: { sustain: 0.5 } }),
      step("clip-1", 12, 0, { v: 127, locks: { filter_type: "hp", cutoff_hz: 1000 } }),
    ],
  });

  const { left } = await renderSamplerSong(song, {
    seconds: 1.7,
    samples: [{ id: SAMPLE_ID, channels: [constant(4000, 0.5)] }],
  });

  const full = 0.5 * CENTRE;
  // The pad itself: no attack, no filter.
  for (const at of [0, 1, 1000, 3999]) {
    assertLevel(left[at], full, `frame ${at} is the unlocked step's voice`, 1e-7);
  }

  // An `attack_ms` lock climbs over 240 frames instead of starting at full.
  const attacked = 4 * FRAMES_PER_SIXTEENTH;
  assertLevel(left[attacked], 0, "the locked attack's frame is silence", 1e-9);
  assertLevel(left[attacked + 120], full * 0.5, "the locked attack is half way up at 120 frames", 1e-7);
  assertLevel(left[attacked + 239], (full * 239) / 240, "the locked attack is not over at 239 frames", 1e-7);
  assertLevel(left[attacked + 240], full, "the locked attack is over at 240 frames", 1e-7);

  // A `sustain` lock settles the whole voice at half level (a decay of 0 jumps
  // straight there).
  const sustained = 8 * FRAMES_PER_SIXTEENTH;
  for (const at of [sustained, sustained + 1, sustained + 2000, sustained + 3999]) {
    assertLevel(left[at], full * 0.5, `frame ${at} is the sustain lock's half level`, 1e-7);
  }

  // A `filter_type` lock gives this voice a high pass, which a constant sample
  // cannot get through, where the same pad without the lock passes it whole.
  const filtered = 12 * FRAMES_PER_SIXTEENTH;
  for (const at of [filtered + 1000, filtered + 2000, filtered + 3999]) {
    assert.ok(
      Math.abs(left[at]) < 1e-6,
      `frame ${at} is behind the locked high pass and has to be silent, got ${left[at]}`,
    );
  }
});

test("a decayed-out voice frees its slot", async () => {
  // A sample long enough to outlast the pattern, so only an envelope can end a
  // voice.
  const sampleFrames = 200000;
  const song = samplerSong({
    tracks: [track("track-1")],
    clips: [patternClip("clip-1", "track-1", { length_steps: 32 })],
    pads: [
      // This decay bottoms out at sustain 0: 480 frames and the voice is over.
      pad("track-1", 0, { decay_ms: 10, sustain: 0 }),
      pad("track-1", 1),
    ],
    samples: { [SAMPLE_ID]: sampleDoc(SAMPLE_ID, sampleFrames) },
    steps: [
      // 15 held voices fill 15 slots... (velocity 20 keeps 16 of them inside
      // the master's ±1 clip, so the level still counts voices)
      ...Array.from({ length: 15 }, (unused, at) => step("clip-1", at, 1, { v: 20 })),
      // ...and the 16th goes to a voice that decays away to nothing.
      step("clip-1", 15, 0, { v: 20 }),
      // One 16th after it has gone, a new held voice has to find its slot free
      // rather than steal one of the 15 that still sound.
      step("clip-1", 16, 1, { v: 20 }),
    ],
  });

  const { left } = await renderSamplerSong(song, {
    seconds: 2.2,
    samples: [{ id: SAMPLE_ID, channels: [constant(sampleFrames, 0.5)] }],
  });

  const full = 0.5 * CENTRE * Math.pow(20 / 127, 2);
  assertLevel(
    left[15 * FRAMES_PER_SIXTEENTH + 480 + 1000],
    15 * full,
    "the decayed voice contributes nothing after its decay",
    1e-6,
  );
  assertLevel(
    left[16 * FRAMES_PER_SIXTEENTH + 1000],
    16 * full,
    "the 16th voice takes the freed slot instead of stealing a sounding one",
    1e-6,
  );
});

test("a steal fades the stolen voice out over 64 frames", async () => {
  // The oldest voice is loud and the rest are at velocity 1, so the level says
  // whether the stolen one is still ringing or gone at once.
  const samples = constant(144000, 0.5);
  const song = samplerSong({
    tracks: [track("track-1")],
    clips: [patternClip("clip-1", "track-1", { length_steps: 32 })],
    pads: [pad("track-1", 0)],
    samples: { [SAMPLE_ID]: sampleDoc(SAMPLE_ID, 144000) },
    steps: [
      step("clip-1", 0, 0, { v: 100 }),
      ...Array.from({ length: 15 }, (unused, at) => step("clip-1", at + 1, 0, { v: 1 })),
      // The 17th voice steals the loud one; a new voice needs the slot now.
      step("clip-1", 16, 0, { v: 1 }),
    ],
  });

  const { left } = await renderSamplerSong(song, {
    seconds: 2.1,
    samples: [{ id: SAMPLE_ID, channels: [samples] }],
  });

  const gain = (velocity) => (velocity / 127) * (velocity / 127);
  const base = 0.5 * CENTRE;
  const trigger = 16 * FRAMES_PER_SIXTEENTH;
  // On its own frame the stolen voice still sounds at full level (the fade has
  // not started yet) beside the new one.
  assertLevel(
    left[trigger],
    base * (gain(100) + 16 * gain(1)),
    "the stolen voice is still there on the trigger frame",
    1e-6,
  );
  // 64 frames later it is gone, without a click: it faded instead of being cut.
  assertLevel(
    left[trigger + 64],
    base * 16 * gain(1),
    "the stolen voice is gone 64 frames later",
    1e-6,
  );
});

test("a stolen voice's tail keeps the values it was swept to", async () => {
  const FRAMES = 105600;
  const samples = constant(FRAMES, 0.5);
  // The pad's OWN level is -60 dB: a voice that keeps the pad's field is all but
  // silent, while the curve sweeps the pad's voices to unity. So the level says
  // whether a stolen voice's tail went on at the value it was stolen with, or
  // jumped back to the pad's own during its fade.
  const song = samplerSong({
    tracks: [track("track-1")],
    clips: [patternClip("clip-1", "track-1", { length_steps: 32 })],
    pads: [pad("track-1", 0, { gain_db: -60 })],
    samples: { [SAMPLE_ID]: sampleDoc(SAMPLE_ID, FRAMES) },
    steps: [
      step("clip-1", 0, 0, { v: 100 }),
      ...Array.from({ length: 15 }, (unused, at) => step("clip-1", at + 1, 0, { v: 1 })),
      // The 17th voice steals the loud one, which has been swept to unity.
      step("clip-1", 16, 0, { v: 1 }),
    ],
    patterns: {
      "clip-1/a": {
        id: "a",
        clip_id: "clip-1",
        name: "A",
        order: 0,
        motion: { [`${BANK}.0|gain_db`]: [{ step_frac: 0, value: 0 }] },
      },
    },
  });

  const { left } = await renderSamplerSong(song, {
    seconds: 2.2,
    samples: [{ id: SAMPLE_ID, channels: [samples] }],
  });

  const gain = (velocity) => (velocity / 127) * (velocity / 127);
  const base = 0.5 * CENTRE;
  const trigger = 16 * FRAMES_PER_SIXTEENTH;
  // A couple of frames into the fade the tail is still at the value it was
  // stolen with (a linear 1 → 0 ramp over 64 frames), far above the pad's own
  // -60 dB. A tail that got its pad's field back would be inaudible here.
  assert.ok(
    left[trigger + 8] > 0.1,
    `the tail has to keep the swept level it was stolen with, level was ${left[trigger + 8]}`,
  );
  assert.ok(
    left[trigger + 8] < base * (gain(100) + 16 * gain(1)),
    "and it is already on its way down, not held at full",
  );
  // 64 frames later it is gone, exactly as a steal without a curve goes.
  assertLevel(
    left[trigger + 64],
    base * (16 * gain(1) + 0.001 * gain(100)),
    "the tail is cut off at the end of its fade",
    2e-3,
  );
});

test("an empty range never steals a voice", async () => {
  // A slice whose end is its start has nothing to play: its trigger must leave
  // the 16 sounding voices exactly as they were.
  const samples = constant(144000, 0.5);
  const song = samplerSong({
    tracks: [track("track-1")],
    clips: [patternClip("clip-1", "track-1", { length_steps: 32 })],
    pads: [pad("track-1", 0), pad("track-1", 1, { slice_id: "empty" })],
    samples: { [SAMPLE_ID]: sampleDoc(SAMPLE_ID, 144000) },
    slices: { [`${SAMPLE_ID}/empty`]: sliceDoc(SAMPLE_ID, "empty", 1000, 1000) },
    steps: [
      ...Array.from({ length: 16 }, (unused, at) => step("clip-1", at, 0, { v: at + 1 })),
      step("clip-1", 16, 1, { v: 127 }),
    ],
  });

  const { left } = await renderSamplerSong(song, {
    seconds: 2.1,
    samples: [{ id: SAMPLE_ID, channels: [samples] }],
  });

  const gain = (velocity) => (velocity / 127) * (velocity / 127);
  let everything = 0;
  for (let velocity = 1; velocity <= 16; velocity += 1) everything += gain(velocity);
  assertLevel(
    left[16 * FRAMES_PER_SIXTEENTH + 500],
    0.5 * CENTRE * everything,
    "a trigger with nothing to play leaves every sounding voice alone",
    1e-6,
  );
});

test("the last frame of a slice does not read the next slice", async () => {  // The frame just past the slice is loud: reading one frame too far would
  // blend 0.9 into the slice's own 0.1.
  const frames = 1200;
  const pcm = constant(frames, 0.9);
  pcm.fill(0.1, 0, 1000);
  const pitch = 7;
  const ratio = Math.pow(2, pitch / 12);

  const song = samplerSong({
    tracks: [track("track-1")],
    clips: [patternClip("clip-1", "track-1")],
    pads: [pad("track-1", 0, { slice_id: "s1", pitch })],
    samples: { [SAMPLE_ID]: sampleDoc(SAMPLE_ID, frames) },
    slices: { [`${SAMPLE_ID}/s1`]: sliceDoc(SAMPLE_ID, "s1", 0, 1000) },
    steps: [step("clip-1", 0, 0, { v: 127 })],
  });

  const { left } = await renderSamplerSong(song, {
    seconds: 0.05,
    samples: [{ id: SAMPLE_ID, channels: [pcm] }],
  });

  // The pitch is fractional, so frame reads land between sample frames: the
  // last frame inside the slice lands on sample 999 with a fraction left over,
  // which is exactly the read that used to reach past the slice.
  let lastInside = -1;
  let sawFraction = false;
  for (let at = 0; at < 700; at += 1) {
    const position = at * ratio;
    if (position >= 1000) break;
    const base = Math.floor(position);
    lastInside = at;
    if (base === 999 && position - base > 0.05) sawFraction = true;
  }
  assert.ok(sawFraction, "the test needs a frame that lands on the slice's last sample with a fraction left");
  assert.equal(Math.floor(lastInside * ratio), 999, "the last frame inside the slice reads its last sample");

  const full = 0.1 * CENTRE;
  for (let at = 0; at <= lastInside; at += 1) {
    assertLevel(left[at], full, `frame ${at} reads only the slice's own 0.1`, 1e-7);
  }
});

test("a pad whose sample is missing is silent and reported once", async () => {
  const errors = [];
  const needed = [];
  const song = samplerSong({
    tracks: [track("track-1")],
    // Two steps on the same (unloaded) pad: a looping pattern would report on
    // every pass, and it says so once.
    clips: [patternClip("clip-1", "track-1", { length_steps: 4 })],
    pads: [pad("track-1", 0, { sample_id: "not-loaded" })],
    samples: { "not-loaded": sampleDoc("not-loaded", 4800) },
    steps: [step("clip-1", 0, 0), step("clip-1", 2, 0)],
  });

  const { left, right } = await renderSamplerSong(song, {
    seconds: 1,
    onError: (text) => errors.push(text),
    onSampleNeeded: (id) => needed.push(id),
  });

  assert.equal(peakOf(left), 0, "a pad whose sample is not loaded plays nothing");
  assert.equal(peakOf(right), 0, "a pad whose sample is not loaded plays nothing on the right either");
  assert.deepEqual(errors, ["Sample not-loaded is not loaded yet."], "it is reported exactly once");
  assert.deepEqual(needed, ["not-loaded"], "and the client is asked for the sample exactly once");
});

test("a recorded cutoff sweep plays back on the next loop", async () => {
  const FRAMES_PER_BAR = FRAMES_PER_BEAT * 4;
  const STEPS = 16;
  const STEP_FRAMES = FRAMES_PER_SIXTEENTH;

  // A 4 kHz tone: a low pass at 200 Hz all but removes it and a low pass above
  // it passes it whole, so the rendered level says what the cutoff was at that
  // frame. One 16th long, so no two voices overlap.
  const sampleFrames = STEP_FRAMES;
  const pcm = new Float32Array(sampleFrames);
  for (let at = 0; at < sampleFrames; at += 1) {
    pcm[at] = Math.sin((2 * Math.PI * 4000 * at) / SAMPLE_RATE) * 0.5;
  }

  // The curve: shut at 200 Hz until step 7.5, then wide open at 16 kHz on step
  // 8, and back down towards 200 Hz over the rest of the loop (the wrap).
  const song = samplerSong({
    tracks: [track("track-1")],
    clips: [patternClip("clip-1", "track-1", { length_steps: STEPS })],
    pads: [
      pad("track-1", 0, { filter: { type: "lp", cutoff_hz: 20000, resonance: 0 } }),
    ],
    samples: { [SAMPLE_ID]: sampleDoc(SAMPLE_ID, sampleFrames) },
    steps: [step("clip-1", 0, 0, { v: 127 }), step("clip-1", 8, 0, { v: 127 })],
    patterns: {
      "clip-1/a": {
        id: "a",
        clip_id: "clip-1",
        name: "A",
        order: 0,
        motion: {
          [`${BANK}.0|cutoff_hz`]: [
            { step_frac: 0, value: 200 },
            { step_frac: 7.5, value: 200 },
            { step_frac: 8, value: 16000 },
          ],
        },
      },
    },
  });

  const seconds = (2 * FRAMES_PER_BAR) / SAMPLE_RATE;
  const { left } = await renderSamplerSong(song, {
    seconds,
    samples: [{ id: SAMPLE_ID, channels: [pcm] }],
  });

  // The first voice plays through a shut filter and the second one, half a bar
  // in, through an open one: the sweep is audible inside one loop.
  assert.ok(
    peakBetween(left, 0, STEP_FRAMES) < 0.05,
    `the sweep's start has to be shut, peak was ${peakBetween(left, 0, STEP_FRAMES)}`,
  );
  assert.ok(
    peakBetween(left, 8 * STEP_FRAMES, 9 * STEP_FRAMES) > 0.2,
    `the sweep's middle has to be open, peak was ${peakBetween(left, 8 * STEP_FRAMES, 9 * STEP_FRAMES)}`,
  );

  // And the next loop plays the very same sweep: every frame of bar two is the
  // frame of bar one, sample for sample.
  assert.deepEqual(
    left.subarray(FRAMES_PER_BAR, FRAMES_PER_BAR * 2),
    left.subarray(0, FRAMES_PER_BAR),
    "the second pass of the loop has to be the first pass, frame for frame",
  );

  // The value of a lane depends on the frame and not on where the host put a
  // block boundary: the descriptors of a 128-frame render and a 97-frame one
  // put the very same step position on every frame of the loop.
  const frames = FRAMES_PER_BAR * 2;
  const even = motionStarts(song, 128, frames);
  const odd = motionStarts(song, 97, frames);
  assert.ok(even.length > 0, "the curve has to be described at all");
  assert.ok(odd.length > 0, "the curve has to be described at the odd block size too");
  let sawCurve = false;
  for (let frame = 0; frame < frames; frame += 1) {
    const a = stepFracAt(even, frame);
    const b = stepFracAt(odd, frame);
    assert.equal(a, b, `frame ${frame}: block sizes 128 and 97 disagree on the step position`);
    if (a !== null) sawCurve = true;
  }
  assert.ok(sawCurve, "the frames have to be inside the curve");

  // And the SOUND is the same too: the processor itself, handed 128-frame blocks
  // and then 97-frame ones, renders the very same samples. A curve read per
  // frame would already agree here, but a curve read per BLOCK would not: that
  // is what the sub-step grid is for.
  const evenAudio = await renderProcessor(song, 128, frames, [{ id: SAMPLE_ID, channels: [pcm] }]);
  const oddAudio = await renderProcessor(song, 97, frames, [{ id: SAMPLE_ID, channels: [pcm] }]);
  assert.ok(peakOf(evenAudio.left) > 0.01, `the swept render has to be audible, peak was ${peakOf(evenAudio.left)}`);
  let firstDifference = -1;
  for (let at = 0; at < frames; at += 1) {
    if (evenAudio.left[at] === oddAudio.left[at]) continue;
    firstDifference = at;
    break;
  }
  assert.equal(
    firstDifference,
    -1,
    `block sizes 128 and 97 must render the same audio, first difference at frame ${firstDifference}: ${evenAudio.left[firstDifference]} vs ${oddAudio.left[firstDifference]}`,
  );
  assert.deepEqual(oddAudio.left, evenAudio.left, "every left sample is the same at both block sizes");
  assert.deepEqual(oddAudio.right, evenAudio.right, "and so is every right sample");

  // And the very same song WITHOUT that lane has to render different samples: a
  // curve that silently did nothing would pass every check above, because two
  // renders of nothing are as equal as two renders of a sweep.
  const plain = JSON.parse(JSON.stringify(song));
  plain.patterns["clip-1/a"].motion = {};
  const flatAudio = await renderProcessor(plain, 128, frames, [{ id: SAMPLE_ID, channels: [pcm] }]);
  let laneDifference = -1;
  for (let at = 0; at < frames; at += 1) {
    if (evenAudio.left[at] === flatAudio.left[at]) continue;
    laneDifference = at;
    break;
  }
  assert.notEqual(
    laneDifference,
    -1,
    "the same song without its lane must not render the same samples as the sweep",
  );
});

test("a step lock beats motion, motion beats the pad", async () => {
  const FRAMES_PER_BAR = FRAMES_PER_BEAT * 4;
  const STEPS = 16;
  const STEP_FRAMES = FRAMES_PER_SIXTEENTH;

  // The same 4 kHz tone: a shut low pass is silent and an open one passes it, so
  // each step's level says which of the three values won.
  const sampleFrames = STEP_FRAMES;
  const pcm = new Float32Array(sampleFrames);
  for (let at = 0; at < sampleFrames; at += 1) {
    pcm[at] = Math.sin((2 * Math.PI * 4000 * at) / SAMPLE_RATE) * 0.5;
  }

  const song = samplerSong({
    tracks: [track("track-1")],
    // The PAD says 20 kHz: a voice that keeps the pad's own field is loud from its
    // first frame.
    clips: [patternClip("clip-1", "track-1", { length_steps: STEPS })],
    pads: [pad("track-1", 0, { filter: { type: "lp", cutoff_hz: 20000, resonance: 0 } })],
    samples: { [SAMPLE_ID]: sampleDoc(SAMPLE_ID, sampleFrames) },
    steps: [
      // Step 0 has no lock: the CURVE beats the pad, and its first frames are shut.
      step("clip-1", 0, 0, { v: 127 }),
      // Step 8 locks 16 kHz: the lock beats the curve (whose own value there is
      // its 200 Hz point).
      step("clip-1", 8, 0, { v: 127, locks: { cutoff_hz: 16000 } }),
    ],
    patterns: {
      "clip-1/a": {
        id: "a",
        clip_id: "clip-1",
        name: "A",
        order: 0,
        // Three points, so the lane INTERPOLATES: shut at 200 Hz on step 0, wide
        // open one step later, and back down on step 8. A lane with one point
        // would be a constant and could not tell a read curve from a skipped one.
        motion: {
          [`${BANK}.0|cutoff_hz`]: [
            { step_frac: 0, value: 200 },
            { step_frac: 1, value: 16000 },
            { step_frac: 8, value: 200 },
          ],
        },
      },
    },
  });

  const { left } = await renderSamplerSong(song, {
    seconds: (FRAMES_PER_BAR * 2) / SAMPLE_RATE,
    samples: [{ id: SAMPLE_ID, channels: [pcm] }],
  });

  // Motion beats the pad: with its own 20 kHz this voice would be loud from frame
  // 0, and the curve's 200 Hz keeps its first frames shut.
  assert.ok(
    peakBetween(left, 0, 120) < 0.01,
    `motion has to beat the pad's own 20 kHz, peak was ${peakBetween(left, 0, 120)}`,
  );
  // The lane really does interpolate: the same voice is wide open by the end of
  // its one step, because the curve rose from 200 Hz to 16 kHz across it.
  assert.ok(
    peakBetween(left, STEP_FRAMES - 300, STEP_FRAMES) > 0.2,
    `the interpolated curve has to open across the step, peak was ${peakBetween(left, STEP_FRAMES - 300, STEP_FRAMES)}`,
  );
  // The lock beats motion: this one voice keeps its own 16 kHz, though the curve
  // stands at its 200 Hz point on step 8.
  assert.ok(
    peakBetween(left, 8 * STEP_FRAMES, 9 * STEP_FRAMES) > 0.2,
    `the lock has to beat the curve's 200 Hz, peak was ${peakBetween(left, 8 * STEP_FRAMES, 9 * STEP_FRAMES)}`,
  );
});

test("a dense sampler song renders faster than real time in Node", async () => {
  const SECONDS = 8;

  // Two-second samples, so every voice of a track's pool is still sounding
  // when the next 16th lands: four full pools (the song's whole 64-voice cap),
  // each voice through a filter and an envelope, plus four SunVox tracks
  // playing a note per beat. A song that has to keep up with the clock.
  const sampleFrames = 2 * SAMPLE_RATE;
  const samples = [];
  const sampleDocs = {};
  for (let index = 0; index < 16; index += 1) {
    const pcm = new Float32Array(sampleFrames);
    for (let at = 0; at < sampleFrames; at += 1) {
      pcm[at] = Math.sin((2 * Math.PI * (180 + index * 40) * at) / SAMPLE_RATE) * 0.4 * (1 - at / sampleFrames);
    }
    samples.push({ id: `sample-${index + 1}`, channels: [pcm] });
    sampleDocs[`sample-${index + 1}`] = sampleDoc(`sample-${index + 1}`, sampleFrames);
  }

  const tracks = [];
  const clips = [];
  const pads = [];
  const steps = [];
  for (let index = 0; index < 4; index += 1) {
    const trackId = `sampler-${index + 1}`;
    const clipId = `pattern-${index + 1}`;
    tracks.push(track(trackId, { pan: index * 0.4 - 0.6 }));
    clips.push(patternClip(clipId, trackId));
    for (let padIndex = 0; padIndex < 16; padIndex += 1) {
      pads.push(
        pad(trackId, padIndex, {
          sample_id: `sample-${padIndex + 1}`,
          decay_ms: 100,
          sustain: 0.6,
          release_ms: 100,
          filter: { type: "lp", cutoff_hz: 3000, resonance: 0.5 },
        }),
      );
      // One 16th per pad: the pool fills, and then stays full.
      steps.push(step(clipId, padIndex, padIndex, { v: 70 + ((padIndex * 7) % 50) }));
    }
  }
  for (let index = 0; index < 4; index += 1) {
    const trackId = `synth-${index + 1}`;
    const clipId = `notes-${index + 1}`;
    tracks.push({
      id: trackId,
      name: trackId,
      color: "#8FC1E8",
      device: { engine: "sunvox", type: "Analog generator", params: {} },
      mute: false,
      solo: false,
      gain_db: -6,
      pan: 0,
      locked: false,
    });
    clips.push(
      noteClip(
        clipId,
        trackId,
        [0, 1, 2, 3].map((beat) => ({ t: beat, d: 0.75, p: 48 + index * 7 + beat, v: 90 })),
      ),
    );
  }

  const song = samplerSong({ tracks, clips, pads, steps, samples: sampleDocs });

  const context = new OfflineAudioContext({
    numberOfChannels: 2,
    length: Math.round(SECONDS * SAMPLE_RATE),
    sampleRate: SAMPLE_RATE,
  });
  let engine = null;
  let rendered = false;
  try {
    engine = await studioEngine.create(context, { assetBytes: ASSETS });
    for (const item of samples) {
      await engine.loadSample(
        item.id,
        item.channels.map((channel) => Float32Array.from(channel)),
        SAMPLE_RATE,
      );
    }
    engine.setSong(song);
    engine.launchScene("scene-1");
    engine.play();
    engine.node.connect(context.destination);
    await engine.flush();

    // Only the render is timed: building the song and loading its PCM is the
    // page's work, not the DSP's.
    const started = performance.now();
    const buffer = await context.startRendering();
    const elapsed = performance.now() - started;
    rendered = true;

    const left = new Float32Array(buffer.length);
    const right = new Float32Array(buffer.length);
    buffer.copyFromChannel(left, 0);
    buffer.copyFromChannel(right, 1);
    assert.ok(peakOf(left) > 0.01, `the dense song has to be audible, peak was ${peakOf(left)}`);
    assert.ok(peakOf(right) > 0.01, `the dense song has to be audible on the right too, peak was ${peakOf(right)}`);
    assert.ok(
      elapsed < SECONDS * 1000,
      `a ${SECONDS} s dense sampler song has to render faster than real time, took ${Math.round(elapsed)} ms`,
    );
  } finally {
    if (engine) engine.dispose();
    if (!rendered) await releaseWorklet(context);
  }
});

test("a dense song with 4096-point motion lanes renders faster than real time in Node", async () => {
  const SECONDS = 8;

  // The same dense song as above — four full sampler pools through filters and
  // envelopes, plus four SunVox tracks — but every sampler track's pattern sweeps
  // two fields of its first four pads in 4096-point curves. A lane that long is
  // read once per pad per sub-step: read once per voice and per frame, the same
  // song cannot keep up with the clock.
  const sampleFrames = 2 * SAMPLE_RATE;
  const samples = [];
  const sampleDocs = {};
  for (let index = 0; index < 16; index += 1) {
    const pcm = new Float32Array(sampleFrames);
    for (let at = 0; at < sampleFrames; at += 1) {
      pcm[at] = Math.sin((2 * Math.PI * (180 + index * 40) * at) / SAMPLE_RATE) * 0.4 * (1 - at / sampleFrames);
    }
    samples.push({ id: `sample-${index + 1}`, channels: [pcm] });
    sampleDocs[`sample-${index + 1}`] = sampleDoc(`sample-${index + 1}`, sampleFrames);
  }

  const tracks = [];
  const clips = [];
  const pads = [];
  const steps = [];
  for (let index = 0; index < 4; index += 1) {
    const trackId = `sampler-${index + 1}`;
    const clipId = `pattern-${index + 1}`;
    tracks.push(track(trackId, { pan: index * 0.4 - 0.6 }));
    clips.push(patternClip(clipId, trackId));
    for (let padIndex = 0; padIndex < 16; padIndex += 1) {
      pads.push(
        pad(trackId, padIndex, {
          sample_id: `sample-${padIndex + 1}`,
          decay_ms: 100,
          sustain: 0.6,
          release_ms: 100,
          filter: { type: "lp", cutoff_hz: 3000, resonance: 0.5 },
        }),
      );
      steps.push(step(clipId, padIndex, padIndex, { v: 70 + ((padIndex * 7) % 50) }));
    }
  }
  for (let index = 0; index < 4; index += 1) {
    const trackId = `synth-${index + 1}`;
    const clipId = `notes-${index + 1}`;
    tracks.push({
      id: trackId,
      name: trackId,
      color: "#8FC1E8",
      device: { engine: "sunvox", type: "Analog generator", params: {} },
      mute: false,
      solo: false,
      gain_db: -6,
      pan: 0,
      locked: false,
    });
    clips.push(
      noteClip(
        clipId,
        trackId,
        [0, 1, 2, 3].map((beat) => ({ t: beat, d: 0.75, p: 48 + index * 7 + beat, v: 90 })),
      ),
    );
  }

  const song = samplerSong({ tracks, clips, pads, steps, samples: sampleDocs });

  // 4096 points on every lane of four pads, on both fields of the filter: 32
  // lanes of 4096 points, read on the sub-step grid.
  for (const key of Object.keys(song.patterns)) {
    const motion = {};
    for (let index = 0; index < 4; index += 1) {
      for (const param of ["cutoff_hz", "resonance"]) {
        const points = [];
        for (let at = 0; at < 4096; at += 1) {
          points.push({
            step_frac: (at * 16) / 4096,
            value: param === "cutoff_hz" ? 500 + (at % 7) * 1000 : 0.3 + 0.1 * (at % 5),
          });
        }
        motion[`${BANK}.${index}|${param}`] = points;
      }
    }
    song.patterns[key].motion = motion;
  }

  const context = new OfflineAudioContext({
    numberOfChannels: 2,
    length: Math.round(SECONDS * SAMPLE_RATE),
    sampleRate: SAMPLE_RATE,
  });
  let engine = null;
  let rendered = false;
  try {
    engine = await studioEngine.create(context, { assetBytes: ASSETS });
    for (const item of samples) {
      await engine.loadSample(
        item.id,
        item.channels.map((channel) => Float32Array.from(channel)),
        SAMPLE_RATE,
      );
    }
    engine.setSong(song);
    engine.launchScene("scene-1");
    engine.play();
    engine.node.connect(context.destination);
    await engine.flush();

    const started = performance.now();
    const buffer = await context.startRendering();
    const elapsed = performance.now() - started;
    rendered = true;

    const left = new Float32Array(buffer.length);
    const right = new Float32Array(buffer.length);
    buffer.copyFromChannel(left, 0);
    buffer.copyFromChannel(right, 1);
    assert.ok(peakOf(left) > 0.01, `the swept dense song has to be audible, peak was ${peakOf(left)}`);
    assert.ok(peakOf(right) > 0.01, `the swept dense song has to be audible on the right too, peak was ${peakOf(right)}`);
    assert.ok(
      elapsed < SECONDS * 1000,
      `a ${SECONDS} s dense song with 4096-point lanes has to render faster than real time, took ${Math.round(elapsed)} ms`,
    );
  } finally {
    if (engine) engine.dispose();
    if (!rendered) await releaseWorklet(context);
  }
});

test("a curve that stops applying gives the voice back its pad's value", async () => {
  const STEP_FRAMES = FRAMES_PER_SIXTEENTH;

  // A 4 kHz tone through a low pass: shut at 200 Hz, wide open at 20 kHz.
  const pcm = new Float32Array(STEP_FRAMES);
  for (let at = 0; at < STEP_FRAMES; at += 1) {
    pcm[at] = Math.sin((2 * Math.PI * 4000 * at) / SAMPLE_RATE) * 0.5;
  }

  const song = samplerSong({
    tracks: [track("track-1")],
    // The PAD says 20 kHz: the voice is loud whenever the curve is not holding it.
    clips: [patternClip("clip-1", "track-1")],
    pads: [pad("track-1", 0, { filter: { type: "lp", cutoff_hz: 20000, resonance: 0 } })],
    samples: { [SAMPLE_ID]: sampleDoc(SAMPLE_ID, STEP_FRAMES) },
    steps: [step("clip-1", 0, 0, { v: 127 })],
    patterns: {
      "clip-1/a": {
        id: "a",
        clip_id: "clip-1",
        name: "A",
        order: 0,
        // Shut for the whole loop: while it stands, the voice is inaudible.
        motion: { [`${BANK}.0|cutoff_hz`]: [{ step_frac: 0, value: 200 }] },
      },
    },
  });

  const engine = await createProcessor(song, [{ id: SAMPLE_ID, channels: [pcm] }]);
  const held = await engine.process(128, 4000);
  assert.ok(
    peakOf(held.left) < 0.01,
    `the curve has to hold the voice shut while it stands, peak was ${peakOf(held.left)}`,
  );

  // The transport stops: the curve stops applying, and the very same voice goes
  // back to its pad's own 20 kHz on the next sub-step instead of holding a stale
  // swept value.
  engine.post({ type: "stop" });
  const after = await engine.process(128, 8000);
  assert.deepEqual(engine.errors, [], "the processor must not report a fault");
  assert.ok(
    peakOf(after.left) > 0.2,
    `the voice has to be heard through its pad's own filter again, peak was ${peakOf(after.left)}`,
  );
});

test("clearing one of two lanes restores that parameter", async () => {
  const FRAMES = 48000;

  // A 4 kHz tone through a low pass: shut at 200 Hz, wide open at the pad's own
  // 20 kHz. One 127-velocity step on a sample long enough to outlast the test,
  // so the very same voice is heard across all three phases.
  const pcm = new Float32Array(FRAMES);
  for (let at = 0; at < FRAMES; at += 1) {
    pcm[at] = Math.sin((2 * Math.PI * 4000 * at) / SAMPLE_RATE) * 0.5;
  }

  const song = samplerSong({
    tracks: [track("track-1")],
    clips: [patternClip("clip-1", "track-1", { length_steps: 32 })],
    pads: [pad("track-1", 0, { filter: { type: "lp", cutoff_hz: 20000, resonance: 0 } })],
    samples: { [SAMPLE_ID]: sampleDoc(SAMPLE_ID, FRAMES) },
    steps: [step("clip-1", 0, 0, { v: 127 })],
    patterns: {
      "clip-1/a": {
        id: "a",
        clip_id: "clip-1",
        name: "A",
        order: 0,
        // Two lanes on the same pad: the cutoff's 200 Hz keeps the voice shut
        // while the pan lane beside it sweeps too.
        motion: {
          [`${BANK}.0|cutoff_hz`]: [{ step_frac: 0, value: 200 }],
          [`${BANK}.0|pan`]: [{ step_frac: 0, value: 0 }],
        },
      },
    },
  });

  const engine = await createProcessor(song, [{ id: SAMPLE_ID, channels: [pcm] }]);
  const both = await engine.process(128, 3000);
  assert.ok(
    peakOf(both.left) < 0.01,
    `the standing cutoff lane has to hold the voice shut, peak was ${peakOf(both.left)}`,
  );

  // The cutoff lane is cleared while the PAN lane of the very same pad keeps
  // sweeping: that one parameter goes back to the pad's own 20 kHz on the next
  // sub-step, even though a lane still sweeps the voice.
  const cleared = JSON.parse(JSON.stringify(song));
  cleared.patterns["clip-1/a"].motion = { [`${BANK}.0|pan`]: [{ step_frac: 0, value: 0 }] };
  engine.post({ type: "song", snapshot: cleared });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const open = await engine.process(128, 4000);
  assert.ok(
    peakOf(open.left) > 0.2,
    `the cleared cutoff has to go back to the pad's own 20 kHz while the pan lane still sweeps, peak was ${peakOf(open.left)}`,
  );

  // Clearing the pan lane too changes nothing more: the voice was already on its
  // pad's own values, one field at a time.
  const none = JSON.parse(JSON.stringify(song));
  none.patterns["clip-1/a"].motion = {};
  engine.post({ type: "song", snapshot: none });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const restored = await engine.process(128, 4000);
  assert.deepEqual(engine.errors, [], "the processor must not report a fault");
  assert.ok(
    peakOf(restored.left) > 0.2,
    `the voice stays on its pad's own values after the last lane goes, peak was ${peakOf(restored.left)}`,
  );
});

test("a tap delivers the track's blocks to the client", async () => {
  const song = samplerSong({
    tracks: [track("track-1")],
    clips: [patternClip("clip-1", "track-1")],
    pads: [pad("track-1", 0)],
    samples: { [SAMPLE_ID]: sampleDoc(SAMPLE_ID, 48000) },
    steps: [step("clip-1", 0, 0, { v: 127 })],
  });

  const { left, taps } = await renderSamplerSong(song, {
    seconds: 0.3,
    samples: [{ id: SAMPLE_ID, channels: [constant(48000, 0.4)] }],
    tap: "track-1",
  });

  assert.ok(taps.length >= 2, `a tap posts one block at a time, got ${taps.length}`);
  for (const tap of taps) {
    assert.equal(tap.target, "track-1", "every block names the tapped track");
    assert.equal(typeof tap.frame, "number", "every block names the frame it starts on");
    assert.ok(Array.isArray(tap.channels), "a tap delivers the block's channels");
    assert.equal(tap.channels.length, 2, "a tap delivers the stereo pair");
  }

  // One track, no clipping: what the tap delivers is that track's output, and
  // so is the master.
  const delivered = [];
  for (const tap of taps) {
    for (let at = 0; at < tap.channels[0].length; at += 1) delivered.push(tap.channels[0][at]);
  }
  assert.ok(
    delivered.length >= left.length,
    `the tap has to cover the whole render, got ${delivered.length} of ${left.length} frames`,
  );
  for (let at = 0; at < left.length; at += 1) {
    assert.equal(delivered[at], left[at], `tap frame ${at} has to be that frame of the track's own output`);
  }
});

test("a tap block carries the frame it starts on", async () => {
  const song = samplerSong({
    tracks: [track("track-1")],
    clips: [patternClip("clip-1", "track-1")],
    pads: [pad("track-1", 0)],
    samples: { [SAMPLE_ID]: sampleDoc(SAMPLE_ID, 48000) },
    steps: [step("clip-1", 0, 0, { v: 127 })],
  });

  const { taps } = await renderSamplerSong(song, {
    seconds: 0.3,
    samples: [{ id: SAMPLE_ID, channels: [constant(48000, 0.4)] }],
    tap: "master",
  });

  assert.ok(taps.length >= 2, `a tap posts one block at a time, got ${taps.length}`);
  // The frames are contiguous from the render's first frame, and each block
  // names its own first frame: a resample can cut on them instead of counting.
  let expected = 0;
  for (const tap of taps) {
    assert.equal(
      tap.frame,
      expected,
      `the block starting at frame ${expected} has to say so, got ${tap.frame}`,
    );
    expected += tap.channels[0].length;
  }
  assert.ok(expected >= Math.round(0.3 * SAMPLE_RATE), `the blocks cover the render, got ${expected} frames`);
});

test("tap on and tap off render the same master", async () => {
  const samples = [{ id: SAMPLE_ID, channels: [constant(48000, 0.1)] }];
  const song = samplerSong({
    tracks: [track("track-1")],
    clips: [patternClip("clip-1", "track-1")],
    pads: [pad("track-1", 0), pad("track-1", 1)],
    samples: { [SAMPLE_ID]: sampleDoc(SAMPLE_ID, 48000) },
    // Two 16ths: 6000 frames is not a whole number of 128-frame blocks, so the
    // second event lands in the middle of one and splits it in two.
    steps: [step("clip-1", 0, 0, { v: 127 }), step("clip-1", 1, 1, { v: 127 })],
  });

  const off = await renderSamplerSong(song, { seconds: 0.5, samples });
  const on = await renderSamplerSong(song, { seconds: 0.5, samples, tap: "track-1" });

  assert.ok(peakOf(off.left) > 0.01, `the song has to be audible, peak was ${peakOf(off.left)}`);
  let worst = 0;
  let firstDifference = -1;
  for (let at = 0; at < off.left.length; at += 1) {
    const difference = Math.abs(off.left[at] - on.left[at]);
    if (difference > worst) worst = difference;
    if (difference !== 0 && firstDifference < 0) firstDifference = at;
  }
  assert.equal(
    worst,
    0,
    `a tap must not change the mix it copies, first difference at frame ${firstDifference}`,
  );
  assert.deepEqual(off.right, on.right, "the right channel is the same with the tap on or off");
});

test("releasing a live oneshot pad lets it finish", async () => {
  // 12000 frames (0.25 s): the release lands long before the sound is over.
  const frames = 12000;
  const samples = [{ id: SAMPLE_ID, channels: [constant(frames, 0.5)] }];
  const songFor = (mode) =>
    samplerSong({
      tracks: [track("track-1")],
      clips: [],
      pads: [pad("track-1", 0, { mode })],
      samples: { [SAMPLE_ID]: sampleDoc(SAMPLE_ID, frames) },
      steps: [],
    });

  const oneshot = await renderLivePad(songFor("oneshot"), { seconds: 0.35, samples });
  const full = 0.5 * CENTRE;
  for (const at of [0, 1, 6000, frames - 1]) {
    assertLevel(oneshot.left[at], full, `frame ${at}: a oneshot pad plays to its end after the release`, 1e-6);
  }
  for (const at of [frames + 100, frames + 1000]) {
    assert.equal(oneshot.left[at], 0, `frame ${at} is past the sample and has to be silent`);
  }

  // A gate pad, released before its end, stops on the release frame instead.
  const gate = await renderLivePad(songFor("gate"), { seconds: 0.35, samples });
  for (const at of [0, 1, 100, 1000]) {
    assert.equal(gate.left[at], 0, `frame ${at}: a live gate pad is released by liveRelease`);
  }
});