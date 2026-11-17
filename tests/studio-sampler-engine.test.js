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
const StudioPadEvents = bundleRequire(join(ENGINE_DIR, "pad-events.js"));

// `startRendering()` releases the worklet thread; a test that stops before it
// gets there has to release it by hand or the process never exits.
const { kWorkletRelease } = await import(pathToFileURL(SYMBOLS_FILE).href);

/** The engine sources, read from the bundle exactly as a Node caller would. */
const ASSETS = {
  "sequencer.js": readFileSync(join(ENGINE_DIR, "sequencer.js"), "utf8"),
  "resample.js": readFileSync(join(ENGINE_DIR, "resample.js"), "utf8"),
  "sampler-voice.js": readFileSync(join(ENGINE_DIR, "sampler-voice.js"), "utf8"),
  "pad-events.js": readFileSync(join(ENGINE_DIR, "pad-events.js"), "utf8"),
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
 * The `pad_events` posts a processor made, each one's own event list: the engine
 * posts ONE message per block that started a voice, never one per hit.
 * @param {object[]} messages
 * @returns {object[][]}
 */
function padEventPosts(messages) {
  const posts = [];
  for (const message of messages) {
    if (message && message.type === "pad_events") posts.push(message.events);
  }
  return posts;
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
  ASSETS["pad-events.js"],
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
    /** Every message the processor posted, in order (a `pad_events` post included). */
    messages: messages,
    /** The processor itself, so a test can read (or flag) one voice's live state. */
    processor: processor,
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

// --- pad events: the engine tells the page about every hit -------------------

/** One sampler song with `count` pads (0..count-1) on one track and no steps. */
function padSong(count, { pads = [], steps = [], clips = [] } = {}) {
  const all = [];
  for (let index = 0; index < count; index += 1) all.push(pad("track-1", index));
  return samplerSong({
    tracks: [track("track-1")],
    clips,
    pads: all.concat(pads),
    samples: { [SAMPLE_ID]: sampleDoc(SAMPLE_ID, 48000) },
    steps,
  });
}

/** @returns {object[]} the events of every `pad_events` post, flattened. */
function allPadEvents(messages) {
  const events = [];
  for (const post of padEventPosts(messages)) for (const event of post) events.push(event);
  return events;
}

/** @returns {object[]} only the `state` events of every post, flattened. */
function stateEvents(messages) {
  return allPadEvents(messages).filter((event) => event.kind === "state");
}

/**
 * One state event as the page reads it, in this realm's own plain values: the
 * processor runs in another realm, so its objects are compared field by field.
 * @param {object[]} events
 * @param {(event: object) => boolean} [keep]
 * @returns {Array<[string, string, number, number]>} track, bank, pad, state
 */
function statePairs(events, keep) {
  const pairs = [];
  for (const event of events) {
    if (typeof keep === "function" && !keep(event)) continue;
    pairs.push([event.track_id, event.bank_id, event.index, event.state]);
  }
  return pairs;
}

test("a step on pad 3 produces one hit at the step's frame with the step velocity", async () => {
  const samples = [{ id: SAMPLE_ID, channels: [constant(48000, 0.5)] }];
  const song = padSong(0, {
    pads: [pad("track-1", 3)],
    clips: [patternClip("clip-1", "track-1")],
    // One step, a 16th into the bar: 24000 frames at 120 bpm.
    steps: [step("clip-1", 4, 3, { v: 90 })],
  });
  const stepFrame = 4 * FRAMES_PER_SIXTEENTH;

  // The frame is the frame, not a block: it has to be the same whatever size of
  // block the host asks the processor for (24000 is not a multiple of 128).
  for (const blockSize of [128, 100]) {
    const engine = await createProcessor(song, samples);
    engine.post({ type: "pad_events_on", on: true });
    const { left } = await engine.process(blockSize, 30000);
    assert.deepEqual(engine.errors, [], `the processor must render block ${blockSize} without a fault`);

    const posts = padEventPosts(engine.messages);
    assert.equal(posts.length, 1, `one block started a voice, so one post, got ${posts.length}`);
    // The pad's light state rides the same post as its hit, so the hit is the
    // event of kind "hit".
    const hits = posts[0].filter((event) => event.kind === "hit");
    assert.equal(hits.length, 1, `one step is one hit, got ${hits.length}`);
    const hit = hits[0];
    assert.equal(hit.frame, stepFrame, `the hit has to stand on the step's own frame (block ${blockSize})`);
    assert.equal(hit.track_id, "track-1");
    assert.equal(hit.bank_id, BANK);
    assert.equal(hit.index, 3, "the event names the pad, not the voice's slot");
    assert.equal(hit.kind, "hit");
    assert.equal(hit.v, 90, "the effective velocity is the step's own");

    // The frame the report names is the frame the hit is HEARD on: silence right
    // before it, and the voice's first sample on it.
    assert.equal(left[stepFrame - 1], 0, `frame ${stepFrame - 1} is still silence`);
    const expected = 0.5 * Math.pow(90 / 127, 2) * CENTRE;
    assertLevel(left[stepFrame], expected, `frame ${stepFrame} is the hit's own first frame`);
  }
});

test("a live press and a controller press produce the same event shape", async () => {
  const samples = [{ id: SAMPLE_ID, channels: [constant(48000, 0.5)] }];
  const song = padSong(2);
  const engine = await createProcessor(song, samples);
  engine.post({ type: "pad_events_on", on: true });
  // A press on the panel's pads and a press from a controller are the very same
  // live message, and both go through the one `startPad` a step does.
  engine.post({ type: "live", track_id: "track-1", bank_id: BANK, index: 0, v: 127, on: true });
  engine.post({ type: "live", track_id: "track-1", bank_id: BANK, index: 1, v: 64, on: true });
  await engine.process(128, 128);

  const posts = padEventPosts(engine.messages);
  assert.equal(posts.length, 1, `both presses start in one block, so one post, got ${posts.length}`);
  // Only the hits: the pads' light states come in the very same post.
  const events = posts[0].filter((event) => event.kind === "hit");
  assert.equal(events.length, 2);
  assert.deepEqual(
    Object.keys(events[1]).sort(),
    Object.keys(events[0]).sort(),
    "a panel press and a controller press have to say the same thing",
  );
  assert.deepEqual(Object.keys(events[0]).sort(), ["bank_id", "frame", "index", "kind", "track_id", "v"]);
  // Read field by field: the processor runs in another realm here, so its
  // objects' prototypes are not this realm's and a deep-equal of the objects
  // themselves would compare the wrong thing.
  assert.deepEqual(
    Array.from(events, (event) => [event.frame, event.track_id, event.bank_id, event.index, event.kind, event.v]),
    [
      [0, "track-1", BANK, 0, "hit", 127],
      [0, "track-1", BANK, 1, "hit", 64],
    ],
    "a live press lands on the next block's first frame, the frame it sounds on",
  );
});

test("sixteen hits in one block make one post", async () => {
  const indices = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
  const samples = [{ id: SAMPLE_ID, channels: [constant(48000, 0.5)] }];
  const engine = await createProcessor(padSong(16), samples);
  engine.post({ type: "pad_events_on", on: true });
  for (const index of indices) {
    engine.post({ type: "live", track_id: "track-1", bank_id: BANK, index, v: 100, on: true });
  }
  await engine.process(128, 128);

  const posts = padEventPosts(engine.messages);
  assert.equal(posts.length, 1, `a block's hits are ONE post, not one each, got ${posts.length}`);
  const hits = posts[0].filter((event) => event.kind === "hit");
  assert.equal(hits.length, 16, `all sixteen hits are in it, got ${hits.length}`);
  assert.deepEqual(
    Array.from(hits, (event) => event.index),
    indices,
    "the events keep the order the voices started in",
  );
  // The pads' light states are read once, after the block rendered, and posted
  // in the same message: one message per block, whatever it carries.
  assert.equal(
    posts[0].filter((event) => event.kind === "state" && event.state === StudioPadEvents.STATE_ON).length,
    16,
    "and the same post lights all sixteen pads once",
  );
});

test("no listener: nothing is posted", async () => {
  const samples = [{ id: SAMPLE_ID, channels: [constant(48000, 0.5)] }];
  const engine = await createProcessor(padSong(16), samples);
  // No `pad_events_on`: this page never subscribed to the lights.
  for (let index = 0; index < 16; index += 1) {
    engine.post({ type: "live", track_id: "track-1", bank_id: BANK, index, v: 100, on: true });
  }
  const { left } = await engine.process(128, 128);

  assert.deepEqual(padEventPosts(engine.messages), [], "a page that never subscribed gets no pad events");
  assert.ok(peakOf(left) > 0.01, "and the pads still sound: only the reporting is off");
  // No listener means no scan at all: a sounding pad's packed state is still
  // untouched, so the block paid nothing for lights nobody draws.
  assert.equal(engine.processor.padStates.size, 1, "the song's one bank is still read");
  for (const bank of engine.processor.padStates.values()) {
    assert.deepEqual(
      Array.from(bank.codes),
      [0, 0],
      "a block with no listener must not walk the voices for the lights",
    );
  }
});

test("a one-shot's natural end emits one off", async () => {
  // 400 frames of constant: the voice reads 0..399, holds its last sample for
  // its 64-frame fade and is over at frame 464 — inside the block that starts
  // at frame 384.
  const samples = [{ id: SAMPLE_ID, channels: [constant(400, 0.5)] }];
  const engine = await createProcessor(padSong(1), samples);
  engine.post({ type: "pad_events_on", on: true });
  engine.post({ type: "live", track_id: "track-1", bank_id: BANK, index: 0, v: 127, on: true });
  await engine.process(128, 1024);

  assert.deepEqual(engine.errors, [], "the processor must render without a fault");
  const states = stateEvents(engine.messages);
  assert.deepEqual(
    Array.from(states, (event) => [event.index, event.state, event.frame]),
    [
      [0, StudioPadEvents.STATE_ON, 0],
      [0, StudioPadEvents.STATE_OFF, 384],
    ],
    "the pad lights on its hit's block and goes off once, in the block its voice ended in",
  );
  assert.deepEqual(
    statePairs(states),
    [
      ["track-1", BANK, 0, StudioPadEvents.STATE_ON],
      ["track-1", BANK, 0, StudioPadEvents.STATE_OFF],
    ],
    "a state event names the pad it belongs to",
  );
  assert.equal(allPadEvents(engine.messages).filter((event) => event.kind === "hit").length, 1);
});

test("a gate release emits one off after the release ends", async () => {
  // 100 ms of release is 4800 frames: released on frame 512, the voice is over
  // at 5312, inside the block that starts at frame 5248.
  const samples = [{ id: SAMPLE_ID, channels: [constant(48000, 0.5)] }];
  const song = samplerSong({
    tracks: [track("track-1")],
    clips: [],
    pads: [pad("track-1", 0, { mode: "gate", release_ms: 100 })],
    samples: { [SAMPLE_ID]: sampleDoc(SAMPLE_ID, 48000) },
    steps: [],
  });
  const engine = await createProcessor(song, samples);
  engine.post({ type: "pad_events_on", on: true });
  engine.post({ type: "live", track_id: "track-1", bank_id: BANK, index: 0, v: 127, on: true });
  await engine.process(128, 512);
  engine.post({ type: "live", track_id: "track-1", bank_id: BANK, index: 0, v: 127, on: false });
  await engine.process(128, 128 * 60);

  assert.deepEqual(engine.errors, [], "the processor must render without a fault");
  const states = stateEvents(engine.messages);
  assert.deepEqual(
    Array.from(states, (event) => [event.index, event.state, event.frame]),
    [
      [0, StudioPadEvents.STATE_ON, 0],
      [0, StudioPadEvents.STATE_OFF, 5248],
    ],
    "the pad stays lit through the release and goes off once its tail is over",
  );
});

test("a hit on a pad that is already sounding emits no second on", async () => {
  const samples = [{ id: SAMPLE_ID, channels: [constant(48000, 0.5)] }];
  const engine = await createProcessor(padSong(1), samples);
  engine.post({ type: "pad_events_on", on: true });
  engine.post({ type: "live", track_id: "track-1", bank_id: BANK, index: 0, v: 127, on: true });
  await engine.process(128, 512);
  engine.post({ type: "live", track_id: "track-1", bank_id: BANK, index: 0, v: 90, on: true });
  await engine.process(128, 512);

  const events = allPadEvents(engine.messages);
  assert.equal(events.filter((event) => event.kind === "hit").length, 2, "both presses are hits");
  assert.deepEqual(
    statePairs(stateEvents(engine.messages)),
    [["track-1", BANK, 0, StudioPadEvents.STATE_ON]],
    "a pad that never went dark has nothing to report the second time",
  );
});

test("a voice stolen by a 17th hit on the track emits exactly one off for its pad once its tail ends", async () => {
  const samples = [{ id: SAMPLE_ID, channels: [constant(48000, 0.5)] }];
  const engine = await createProcessor(padSong(16), samples);
  engine.post({ type: "pad_events_on", on: true });
  // Fifteen voices fill fifteen slots in the first block.
  for (let index = 0; index < 15; index += 1) {
    engine.post({ type: "live", track_id: "track-1", bank_id: BANK, index, v: 100, on: true });
  }
  await engine.process(128, 128);
  // The sixteenth fills the pool, and the seventeenth takes the oldest slot —
  // pad 0's — which rings on in a fade tail for 64 frames.
  engine.post({ type: "live", track_id: "track-1", bank_id: BANK, index: 15, v: 100, on: true });
  engine.post({ type: "live", track_id: "track-1", bank_id: BANK, index: 1, v: 100, on: true });
  await engine.process(128, 384);

  const states = stateEvents(engine.messages);
  const offs = states.filter((event) => event.state === StudioPadEvents.STATE_OFF);
  assert.equal(offs.length, 1, `one voiced pad goes dark, got ${offs.length} offs`);
  assert.equal(offs[0].index, 0, "the stolen voice's own pad is the one that goes off");
  assert.equal(offs[0].frame, 128, "and it goes off in the block its 64-frame tail ended in");
  // Pad 1's light never blinks: its pad is still sounding when the new voice
  // lands on it.
  assert.deepEqual(
    Array.from(states, (event) => [event.index, event.state, event.frame]).filter((event) => event[0] === 1),
    [[1, StudioPadEvents.STATE_ON, 0]],
    "a re-trigger over a sounding pad reports nothing new",
  );
  assert.equal(
    states.filter((event) => event.state === StudioPadEvents.STATE_ON).length,
    16,
    "every pad that started lights exactly once",
  );
});

test("the 64-voice song-wide cut emits exactly one off for each cut pad in that block", async () => {
  const samples = [{ id: SAMPLE_ID, channels: [constant(48000, 0.5)] }];
  // Five tracks of sixteen pads, all on one long sample: sixteen voices sound
  // in the first block and sixty-four more land in the second, so the song's
  // cap cuts the sixteen that were there first.
  const tracks = [];
  const pads = [];
  for (let index = 0; index < 5; index += 1) {
    const trackId = `track-${index + 1}`;
    tracks.push(track(trackId));
    for (let padIndex = 0; padIndex < 16; padIndex += 1) pads.push(pad(trackId, padIndex));
  }
  const song = samplerSong({ tracks, clips: [], pads, steps: [], samples: { [SAMPLE_ID]: sampleDoc(SAMPLE_ID, 48000) } });
  const engine = await createProcessor(song, samples);
  engine.post({ type: "pad_events_on", on: true });
  for (let padIndex = 0; padIndex < 16; padIndex += 1) {
    engine.post({ type: "live", track_id: "track-1", bank_id: BANK, index: padIndex, v: 100, on: true });
  }
  await engine.process(128, 128);
  for (let index = 1; index < 5; index += 1) {
    for (let padIndex = 0; padIndex < 16; padIndex += 1) {
      engine.post({
        type: "live",
        track_id: `track-${index + 1}`,
        bank_id: BANK,
        index: padIndex,
        v: 100,
        on: true,
      });
    }
  }
  await engine.process(128, 256);

  assert.deepEqual(engine.errors, [], "the processor must render without a fault");
  const states = stateEvents(engine.messages);
  const offs = states.filter((event) => event.state === StudioPadEvents.STATE_OFF);
  assert.equal(offs.length, 16, `the sixteen cut voices go off once each, got ${offs.length}`);
  assert.deepEqual(
    statePairs(offs),
    Array.from({ length: 16 }, (unused, padIndex) => ["track-1", BANK, padIndex, StudioPadEvents.STATE_OFF]),
    "the sixteen oldest voices — the first track's whole bank — are the ones the cap cut",
  );
  for (const off of offs) assert.equal(off.frame, 128, "they were all cut in the block the cap tripped in");
  // The sixty-four that survived light their pads once and stay lit.
  assert.equal(
    states.filter((event) => event.state === StudioPadEvents.STATE_ON).length,
    80,
    "every pad that started its own voice lights once",
  );
});

test("a mute-group (choke) cut emits exactly one off", async () => {
  const samples = [{ id: SAMPLE_ID, channels: [constant(48000, 0.5)] }];
  const song = samplerSong({
    tracks: [track("track-1")],
    clips: [],
    pads: [pad("track-1", 0, { choke: 1 }), pad("track-1", 1, { choke: 1 })],
    samples: { [SAMPLE_ID]: sampleDoc(SAMPLE_ID, 48000) },
    steps: [],
  });
  const engine = await createProcessor(song, samples);
  engine.post({ type: "pad_events_on", on: true });
  engine.post({ type: "live", track_id: "track-1", bank_id: BANK, index: 0, v: 100, on: true });
  await engine.process(128, 512);
  // The second pad of the group cuts the first over the 64-frame crossfade: the
  // choked voice ends inside the block that starts at frame 512.
  engine.post({ type: "live", track_id: "track-1", bank_id: BANK, index: 1, v: 100, on: true });
  await engine.process(128, 384);

  const states = stateEvents(engine.messages);
  const offs = states.filter((event) => event.state === StudioPadEvents.STATE_OFF);
  assert.deepEqual(
    statePairs(offs),
    [["track-1", BANK, 0, StudioPadEvents.STATE_OFF]],
    "only the choked pad goes dark, and exactly once",
  );
  assert.equal(offs[0].frame, 512, "it goes off in the block its fade ended in");
  assert.deepEqual(
    statePairs(states.filter((event) => event.state === StudioPadEvents.STATE_ON)),
    [
      ["track-1", BANK, 0, StudioPadEvents.STATE_ON],
      ["track-1", BANK, 1, StudioPadEvents.STATE_ON],
    ],
    "the pad that cut it lights and stays lit",
  );
});

test("setSong removing the sample emits exactly one off", async () => {
  const samples = [{ id: SAMPLE_ID, channels: [constant(48000, 0.5)] }];
  const engine = await createProcessor(padSong(1), samples);
  engine.post({ type: "pad_events_on", on: true });
  engine.post({ type: "live", track_id: "track-1", bank_id: BANK, index: 0, v: 127, on: true });
  await engine.process(128, 384);
  const lit = stateEvents(engine.messages);
  assert.deepEqual(statePairs(lit), [["track-1", BANK, 0, StudioPadEvents.STATE_ON]], "the pad is lit first");

  // A song without the sampler track (and so without its sample) is opened: the
  // tracks' records are rebuilt and the voice it was playing is cut, off the
  // render path entirely.
  const cleared = samplerSong({ tracks: [], clips: [], pads: [], steps: [], samples: {} });
  engine.post({ type: "song", snapshot: cleared });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await engine.process(128, 256);

  const offs = stateEvents(engine.messages).filter((event) => event.state === StudioPadEvents.STATE_OFF);
  assert.equal(offs.length, 1, `the pad the song dropped goes off exactly once, got ${offs.length}`);
  assert.equal(offs[0].index, 0);
  assert.equal(offs[0].track_id, "track-1");
  assert.equal(offs[0].frame, 384, "and it goes off in the first block after the song changed");
});

test("a pad that loses only its sample keeps playing to its natural end", async () => {
  // 400 frames of constant: the voice reads 0..399, holds its last sample for its
  // 64-frame fade and is over at frame 464 — inside the block that starts at 384.
  const samples = [{ id: SAMPLE_ID, channels: [constant(400, 0.5)] }];
  const song = samplerSong({
    tracks: [track("track-1")],
    clips: [],
    pads: [pad("track-1", 0)],
    samples: { [SAMPLE_ID]: sampleDoc(SAMPLE_ID, 400) },
    steps: [],
  });
  const engine = await createProcessor(song, samples);
  engine.post({ type: "pad_events_on", on: true });
  engine.post({ type: "live", track_id: "track-1", bank_id: BANK, index: 0, v: 127, on: true });
  const first = await engine.process(128, 384);

  assert.deepEqual(
    statePairs(stateEvents(engine.messages)),
    [["track-1", BANK, 0, StudioPadEvents.STATE_ON]],
    "the pad lights on its hit's block and stays lit",
  );
  assert.ok(peakOf(first.left) > 0.01, "and the voice is sounding");

  // The sample is taken off the pad while the voice is still sounding. The track
  // and its bank stay, only the sound goes: the pad names no sample any more,
  // the song holds none, and the page unloads the PCM it was holding.
  const lost = samplerSong({
    tracks: [track("track-1")],
    clips: [],
    pads: [pad("track-1", 0, { sample_id: null })],
    samples: {},
    steps: [],
  });
  engine.post({ type: "song", snapshot: lost });
  engine.post({ type: "sample_unload", sample_id: SAMPLE_ID });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = await engine.process(128, 256);

  assert.deepEqual(engine.errors, [], "the processor must render without a fault");
  // The block that holds the voice's natural end: still sounding at its first
  // frame, and silent from the frame its fade ended on.
  assert.ok(peakBetween(second.left, 0, 16) > 0.01, "the voice plays on to its natural end");
  assert.equal(peakOf(second.left.subarray(80)), 0, "and nothing sounds after its last fade frame");

  const states = stateEvents(engine.messages);
  const offs = states.filter((event) => event.state === StudioPadEvents.STATE_OFF);
  assert.equal(offs.length, 1, `the pad that lost its sample goes off exactly once, got ${offs.length}`);
  assert.deepEqual(
    statePairs(offs),
    [["track-1", BANK, 0, StudioPadEvents.STATE_OFF]],
    "and it is the pad whose sample went, not the track's whole bank",
  );
  assert.equal(offs[0].frame, 384, "off in the block its voice ended in: never early, never twice");
});

test("two voices of one pad ending in different blocks emit one off, at the second", async () => {
  // The first voice is over at 464 and the second (started on frame 128) at 592:
  // the pad is dark only from the block that starts at 512.
  const samples = [{ id: SAMPLE_ID, channels: [constant(400, 0.5)] }];
  const engine = await createProcessor(padSong(1), samples);
  engine.post({ type: "pad_events_on", on: true });
  engine.post({ type: "live", track_id: "track-1", bank_id: BANK, index: 0, v: 127, on: true });
  await engine.process(128, 128);
  engine.post({ type: "live", track_id: "track-1", bank_id: BANK, index: 0, v: 127, on: true });
  await engine.process(128, 640);

  const states = stateEvents(engine.messages);
  const offs = states.filter((event) => event.state === StudioPadEvents.STATE_OFF);
  assert.deepEqual(
    Array.from(offs, (event) => [event.index, event.state, event.frame]),
    [[0, StudioPadEvents.STATE_OFF, 512]],
    "the light stays on until the pad's LAST voice is gone, and goes off once",
  );
  assert.equal(
    states.filter((event) => event.state === StudioPadEvents.STATE_ON).length,
    1,
    "and it lit once, not once per voice",
  );
});

test("a voice flagged looping then held gives loop, then held, then off", async () => {
  const samples = [{ id: SAMPLE_ID, channels: [constant(48000, 0.5)] }];
  const engine = await createProcessor(padSong(1), samples);
  engine.post({ type: "pad_events_on", on: true });
  engine.post({ type: "live", track_id: "track-1", bank_id: BANK, index: 0, v: 127, on: true });
  await engine.process(128, 128);

  // The flags a loop and a held pad raise (set here, as the engine will once the
  // playback modes land): the scan reads them off the voice itself.
  const record = engine.processor.slots[0];
  const voice = record.voices[0];
  assert.equal(voice.sounding, true, "the pad's voice has to be the sounding one");
  voice.looping = true;
  await engine.process(128, 128);
  voice.held = true;
  await engine.process(128, 128);
  voice.held = false;
  voice.looping = false;
  voice.sounding = false;
  await engine.process(128, 128);

  assert.deepEqual(
    Array.from(stateEvents(engine.messages), (event) => [event.index, event.state, event.frame]),
    [
      [0, StudioPadEvents.STATE_ON, 0],
      [0, StudioPadEvents.STATE_LOOP, 128],
      [0, StudioPadEvents.STATE_HELD, 256],
      [0, StudioPadEvents.STATE_OFF, 384],
    ],
    "a pad reads the highest state any of its sounding voices holds, and off when none does",
  );
});

test("the scan allocates nothing during a block (the bank arrays are the same objects before and after 1000 blocks)", async () => {
  const samples = [{ id: SAMPLE_ID, channels: [constant(48000, 0.5)] }];
  const engine = await createProcessor(padSong(1), samples);
  engine.post({ type: "pad_events_on", on: true });
  engine.post({ type: "live", track_id: "track-1", bank_id: BANK, index: 0, v: 127, on: true });
  await engine.process(128, 128);

  const states = engine.processor.padStates;
  const banks = Array.from(states.values());
  assert.equal(banks.length, 1, "the song's one bank got one state entry");
  const codes = banks[0].codes;
  assert.equal(codes.length, 2, "one packed state for the last block and one for this one");

  // 1000 blocks of a sounding pad: the sample runs out at 48064, so the scan
  // really does walk the voices and report the light going off in the middle.
  await engine.process(128, 128 * 1000);

  assert.equal(engine.processor.padStates, states, "the song's bank map is never rebuilt by a block");
  const after = Array.from(engine.processor.padStates.values());
  assert.equal(after.length, 1);
  assert.equal(after[0], banks[0], "the bank entry is the very object it was");
  assert.equal(after[0].codes, codes, "and so is its packed state array");
  assert.deepEqual(
    Array.from(stateEvents(engine.messages), (event) => [event.index, event.state]),
    [
      [0, StudioPadEvents.STATE_ON],
      [0, StudioPadEvents.STATE_OFF],
    ],
    "the scan ran, so the identities above are worth something",
  );
});

test("the position post carries a frame", async () => {
  const engine = await createProcessor(padSong(1), []);
  // A `position` report lands at most every 50 ms of audio: 2400 frames here.
  await engine.process(128, 3000);
  const positions = engine.messages.filter((message) => message && message.type === "position");
  assert.ok(positions.length >= 1, "a running transport has to report its position");
  const first = positions[0];
  assert.equal(typeof first.frame, "number", "the report has to say which frame it is for");
  // 2400 frames of audio: the 19th 128-frame block is the first one to reach it,
  // so the report is for the block that starts at frame 18 × 128.
  assert.equal(first.frame, 18 * 128);
  for (const position of positions) {
    assert.equal(position.frame % 128, 0, `frame ${position.frame} is a block start`);
    assert.equal(typeof position.sixteenth, "number", "the report still carries the position it used to");
  }
});

// --- playback modes, loops and clip ownership -------------------------------

/** One voice at velocity 127 playing a constant 0.5 sample. */
const ONE_VOICE = 0.5 * CENTRE;

/**
 * One song of one sampler track: its pads, its steps and its clips, over one
 * sample of `frames` frames. A test that plays a pad by hand gives it no clips.
 * `patterns` is only passed when a test gives its pattern motion lanes.
 * @param {{pads: object[], steps?: object[], clips?: object[], frames?: number,
 *          patterns?: object|null}} options
 * @returns {object}
 */
function kitSong({ pads, steps = [], clips = [], frames = 48000, patterns = null }) {
  return samplerSong({
    tracks: [track("track-1")],
    clips,
    pads,
    samples: { [SAMPLE_ID]: sampleDoc(SAMPLE_ID, frames) },
    steps,
    patterns,
  });
}

/**
 * One sampler song of two scenes, each with a pattern clip of its own on the
 * track: a scene launch is what turns the track over from one to the other, and
 * neither clip has a step unless the test gives `clip-1` one.
 * @param {object[]} [steps] the steps of the first clip, `clip-1`
 * @returns {object}
 */
function twoSceneSong(steps = []) {
  const song = kitSong({
    pads: [pad("track-1", 0, { loop: "loop" })],
    frames: 4800,
    clips: [patternClip("clip-1", "track-1"), patternClip("clip-2", "track-1", { scene_id: "scene-2" })],
    steps,
  });
  song.scenes = [
    { id: "scene-1", name: "A" },
    { id: "scene-2", name: "B" },
  ];
  return song;
}

/**
 * Press or let go of one pad between blocks: it takes effect on the next block's
 * first frame, exactly as the panel's live message does.
 * @param {object} engine a processor from `createProcessor`
 * @param {number} index
 * @param {boolean} [on]
 * @returns {void}
 */
function pressPad(engine, index, on = true) {
  engine.post({ type: "live", track_id: "track-1", bank_id: BANK, index, v: on ? 127 : 0, on });
}

test("M1 gate: plays while it is held and the release runs the envelope's release", async () => {
  const song = kitSong({ pads: [pad("track-1", 0, { mode: "gate", release_ms: 5 })] });
  const engine = await createProcessor(song, [{ id: SAMPLE_ID, channels: [constant(48000, 0.5)] }]);

  const quiet = await engine.process(128, 512);
  assert.equal(peakOf(quiet.left), 0, "a gate pad is silent until it is pressed");

  pressPad(engine, 0);
  const held = await engine.process(128, 512);
  for (const at of [0, 1, 200, 511]) assertLevel(held.left[at], ONE_VOICE, `frame ${at} is inside the gate`);

  // 5 ms of release is 240 frames: the level falls one frame at a time, and the
  // voice is over when it reaches 0.
  pressPad(engine, 0, false);
  const released = await engine.process(128, 512);
  for (const at of [0, 60, 120, 239]) {
    assertLevel(released.left[at], (ONE_VOICE * (240 - at)) / 240, `frame ${at} is that far into the release`, 1e-7);
  }
  // The last step of a linear release lands a rounding error short of 0, so the
  // frame it lands on is silence to the last bit and the ones after it are 0.
  assert.ok(Math.abs(released.left[240]) < 1e-12, `frame 240 is the end of the release, got ${released.left[240]}`);
  for (const at of [242, 300, 511]) {
    assert.equal(released.left[at], 0, `frame ${at} is past the release and has to be silent`);
  }
});

test("M2 normal without loop: a second press fades the first voice and starts a new one, and a step on a normal pad restarts the same way", async () => {
  const song = kitSong({ pads: [pad("track-1", 0, { mode: "normal" })] });
  const samples = [{ id: SAMPLE_ID, channels: [constant(48000, 0.5)] }];
  const engine = await createProcessor(song, samples);

  pressPad(engine, 0);
  const first = await engine.process(128, 512);
  for (const at of [0, 100, 511]) assertLevel(first.left[at], ONE_VOICE, `frame ${at} is the pad's one voice`);

  // The second press starts a new voice and fades the earlier one over the
  // crossfade length: on its own frame both still sound, 64 frames later only
  // the new one does.
  pressPad(engine, 0);
  const second = await engine.process(128, 128);
  assertLevel(second.left[0], 2 * ONE_VOICE, "the press's own frame still holds both voices");
  assertLevel(second.left[63], ONE_VOICE * (1 + 1 / 64), "the earlier voice is on its way out at frame 63", 1e-7);
  for (const at of [64, 65, 127]) {
    assertLevel(second.left[at], ONE_VOICE, `frame ${512 + at} is the new voice alone`);
  }

  // A step on a normal pad restarts the very same way: two 16ths, one pad.
  const stepped = await createProcessor(
    kitSong({
      pads: [pad("track-1", 0, { mode: "normal" })],
      clips: [patternClip("clip-1", "track-1")],
      steps: [step("clip-1", 0, 0, { v: 127 }), step("clip-1", 1, 0, { v: 127 })],
    }),
    samples,
  );
  const rendered = await stepped.process(128, FRAMES_PER_SIXTEENTH + 128);
  assertLevel(
    rendered.left[FRAMES_PER_SIXTEENTH - 1],
    ONE_VOICE,
    "the first step's voice sounds alone until the second step",
  );
  assertLevel(
    rendered.left[FRAMES_PER_SIXTEENTH],
    2 * ONE_VOICE,
    "the second step's own frame still holds both voices",
  );
  assertLevel(
    rendered.left[FRAMES_PER_SIXTEENTH + 64],
    ONE_VOICE,
    "and the first one has faded out 64 frames later",
  );
});

test("M3 one-shot: a second press overlaps and the first keeps playing", async () => {
  const song = kitSong({ pads: [pad("track-1", 0)] });
  const engine = await createProcessor(song, [{ id: SAMPLE_ID, channels: [constant(48000, 0.5)] }]);

  pressPad(engine, 0);
  await engine.process(128, 512);
  pressPad(engine, 0);
  const both = await engine.process(128, 512);
  for (const at of [0, 1, 63, 64, 100, 511]) {
    assertLevel(both.left[at], 2 * ONE_VOICE, `frame ${512 + at} holds both one-shot voices`);
  }
});

test("M4 gate+loop: loops while held and ends at release; a step's gate_frames ends it", async () => {
  const samples = [{ id: SAMPLE_ID, channels: [constant(4800, 0.5)] }];
  const song = kitSong({ pads: [pad("track-1", 0, { mode: "gate", loop: "loop" })], frames: 4800 });
  const engine = await createProcessor(song, samples);

  pressPad(engine, 0);
  const held = await engine.process(128, 20000);
  for (const at of [0, 4799, 4800, 9600, 19999]) {
    assertLevel(held.left[at], ONE_VOICE, `frame ${at} is the loop, past the sample's own end`);
  }

  pressPad(engine, 0, false);
  const released = await engine.process(128, 1000);
  assert.equal(peakOf(released.left), 0, "letting go ends the loop instead of toggling it");

  // A step on the same pad loops for the step's own gate, then lets go.
  const stepped = await createProcessor(
    kitSong({
      pads: [pad("track-1", 0, { mode: "gate", loop: "loop" })],
      frames: 4800,
      clips: [patternClip("clip-1", "track-1")],
      steps: [step("clip-1", 0, 0, { v: 127 })],
    }),
    samples,
  );
  const gated = await stepped.process(128, 8000);
  for (const at of [0, 4800, 5999]) {
    assertLevel(gated.left[at], ONE_VOICE, `frame ${at} is inside the step's gate`);
  }
  for (const at of [6000, 6001, 7999]) {
    assert.equal(gated.left[at], 0, `frame ${at} is past the step's gate and has to be silent`);
  }
});

test("M5 one-shot+loop: a live press starts it, the next press releases it, no overlap", async () => {
  const song = kitSong({ pads: [pad("track-1", 0, { loop: "loop" })], frames: 4800 });
  const engine = await createProcessor(song, [{ id: SAMPLE_ID, channels: [constant(4800, 0.5)] }]);

  pressPad(engine, 0);
  const running = await engine.process(128, 12000);
  for (const at of [0, 4799, 4800, 9000, 11999]) {
    assertLevel(running.left[at], ONE_VOICE, `frame ${at} is one looping voice, past the sample's end`);
  }

  pressPad(engine, 0);
  const stopped = await engine.process(128, 2000);
  assert.equal(peakOf(stopped.left), 0, "the next press ends the loop and starts nothing");
});

test("M6 normal+loop: a press starts the loop, the next press stops it, and it does not restart on a press", async () => {
  // A ramp makes a restart visible: it would put the read back on the sample's
  // own first frame, which is a level a constant could not tell apart.
  const frames = 4800;
  const song = kitSong({ pads: [pad("track-1", 0, { mode: "normal", loop: "loop" })], frames });
  const engine = await createProcessor(song, [{ id: SAMPLE_ID, channels: [ramp(frames)] }]);

  pressPad(engine, 0);
  const running = await engine.process(128, 9600);
  assertLevel(running.left[0], (1 / 100000) * CENTRE, "frame 0 reads the ramp's first sample");
  assertLevel(running.left[4799], (4800 / 100000) * CENTRE, "the range's last sample, 4800 frames later");
  assertLevel(running.left[4800], (1 / 100000) * CENTRE, "and the loop wrapped back to the start on its own");
  assertLevel(running.left[5000], (201 / 100000) * CENTRE, "carrying on from there");

  pressPad(engine, 0);
  const stopped = await engine.process(128, 2000);
  assert.equal(peakOf(stopped.left), 0, "the second press stops the loop instead of restarting it");
});

test("M7 a step on a looping pad starts it once and the next steps do not restart or stop it", async () => {
  const frames = 4800;
  const song = kitSong({
    pads: [pad("track-1", 0, { loop: "loop" })],
    frames,
    clips: [patternClip("clip-1", "track-1")],
    steps: [step("clip-1", 0, 0, { v: 127 }), step("clip-1", 4, 0, { v: 127 })],
  });
  const engine = await createProcessor(song, [{ id: SAMPLE_ID, channels: [ramp(frames)] }]);
  engine.post({ type: "pad_events_on", on: true });

  const out = await engine.process(128, 6200);
  assertLevel(out.left[0], (1 / 100000) * CENTRE, "the first step starts the loop");
  // 6000 frames later the read is 1200 frames into the loop, not back at its
  // start: the second step neither restarted it nor stopped it.
  assertLevel(out.left[FRAMES_PER_SIXTEENTH], (1201 / 100000) * CENTRE, "the next step leaves it running");
  assert.equal(
    allPadEvents(engine.messages).filter((event) => event.kind === "hit").length,
    1,
    "only the first step started a voice",
  );
});

test("M7 a step-started loop stops when its clip stops, when a scene launch replaces the clip on its track, and on Stop, and a relaunch of the same clip leaves it playing", async () => {
  const samples = [{ id: SAMPLE_ID, channels: [constant(4800, 0.5)] }];
  const FRAMES_PER_BAR = FRAMES_PER_BEAT * 4;
  const stepOf = [step("clip-1", 0, 0, { v: 127 })];

  /** One song whose step has started its loop, after one bar of it. */
  const afterOneBar = async () => {
    const engine = await createProcessor(twoSceneSong(stepOf), samples);
    const first = await engine.process(128, FRAMES_PER_BAR);
    assertLevel(
      first.left[FRAMES_PER_BAR - 1],
      ONE_VOICE,
      "the step has to have started a loop that outlives its own sample",
    );
    return engine;
  };

  // A relaunch of the very clip it plays is no change at all.
  const same = await afterOneBar();
  same.post({ type: "launchScene", id: "scene-1" });
  const playingOn = await same.process(128, 2000);
  assert.deepEqual(same.errors, [], "the processor must render without a fault");
  assertLevel(playingOn.left[0], ONE_VOICE, "a relaunch of the same clip leaves the loop playing");
  assertLevel(playingOn.left[1999], ONE_VOICE, "and it keeps looping");

  // A scene launch that replaces the clip on its track ends it at that bar.
  const replaced = await afterOneBar();
  replaced.post({ type: "launchScene", id: "scene-2" });
  const afterReplace = await replaced.process(128, 2000);
  assert.deepEqual(replaced.errors, [], "the processor must render without a fault");
  assert.equal(peakOf(afterReplace.left), 0, "the loop a replaced clip started ends at the boundary");

  // So does the clip stopping.
  const stoppedClip = await afterOneBar();
  stoppedClip.post({ type: "stopTrack", id: "track-1" });
  const afterStopTrack = await stoppedClip.process(128, 2000);
  assert.deepEqual(stoppedClip.errors, [], "the processor must render without a fault");
  assert.equal(peakOf(afterStopTrack.left), 0, "the loop ends with the clip that started it");

  // And Stop, which releases the live state outright.
  const stopped = await afterOneBar();
  stopped.post({ type: "stop" });
  const afterStop = await stopped.process(128, 2000);
  assert.equal(peakOf(afterStop.left), 0, "Stop ends the loop");
});

test("M7 a live-pressed loop survives a scene launch", async () => {
  const FRAMES_PER_BAR = FRAMES_PER_BEAT * 4;
  const engine = await createProcessor(twoSceneSong(), [{ id: SAMPLE_ID, channels: [constant(4800, 0.5)] }]);

  pressPad(engine, 0);
  const running = await engine.process(128, FRAMES_PER_BAR);
  assertLevel(running.left[FRAMES_PER_BAR - 1], ONE_VOICE, "the live press started a loop");

  // The launch replaces the track's clip: a loop the operator started by hand
  // belongs to no clip and is not the launch's to end.
  engine.post({ type: "launchScene", id: "scene-2" });
  const after = await engine.process(128, 2000);
  assert.deepEqual(engine.errors, [], "the processor must render without a fault");
  assertLevel(after.left[0], ONE_VOICE, "a scene launch leaves a live-pressed loop alone");
  assertLevel(after.left[1999], ONE_VOICE, "and it keeps looping");
});

test("M8 reverse+loop runs backwards and wraps at the range start", async () => {
  const frames = 4800;
  const song = kitSong({ pads: [pad("track-1", 0, { loop: "loop", reverse: true })], frames });
  const engine = await createProcessor(song, [{ id: SAMPLE_ID, channels: [ramp(frames)] }]);

  pressPad(engine, 0);
  const out = await engine.process(128, 10000);
  assertLevel(out.left[0], (4800 / 100000) * CENTRE, "frame 0 reads the range's last sample");
  assertLevel(out.left[100], (4700 / 100000) * CENTRE, "100 frames in, it has read 100 frames backwards");
  assertLevel(out.left[4799], (1 / 100000) * CENTRE, "the range's first sample is the last one it reads");
  assertLevel(out.left[4800], (4800 / 100000) * CENTRE, "and it wraps round to the range's end");
  assertLevel(out.left[9999], (4401 / 100000) * CENTRE, "then carries on backwards from there");
});

test("M9 reverse+pingpong starts backwards and reflects at each end", async () => {
  const frames = 4800;
  const song = kitSong({ pads: [pad("track-1", 0, { loop: "pingpong", reverse: true })], frames });
  const engine = await createProcessor(song, [{ id: SAMPLE_ID, channels: [ramp(frames)] }]);

  pressPad(engine, 0);
  const out = await engine.process(128, 10000);
  assertLevel(out.left[0], (4800 / 100000) * CENTRE, "frame 0 reads the range's last sample");
  assertLevel(out.left[4799], (1 / 100000) * CENTRE, "and it reaches the range's first sample");
  assertLevel(out.left[4800], (2 / 100000) * CENTRE, "the reflection reads the frame next to it");
  assertLevel(out.left[9000], (4202 / 100000) * CENTRE, "coming back up the range");
  assertLevel(out.left[9598], (4800 / 100000) * CENTRE, "and it reaches the range's end again");
  assertLevel(out.left[9599], (4799 / 100000) * CENTRE, "reflecting there too");
});

test("M16 Stop and resetLive release every loop", async () => {
  const song = kitSong({
    pads: [pad("track-1", 0, { loop: "loop" }), pad("track-1", 1, { loop: "pingpong" })],
    frames: 4800,
  });
  const samples = [{ id: SAMPLE_ID, channels: [constant(4800, 0.5)] }];
  const engine = await createProcessor(song, samples);

  pressPad(engine, 0);
  pressPad(engine, 1);
  const running = await engine.process(128, 9000);
  assertLevel(running.left[8999], 2 * ONE_VOICE, "both loops sound, past their samples' ends");

  engine.post({ type: "stop" });
  const stopped = await engine.process(128, 1000);
  assert.deepEqual(engine.errors, [], "the processor must render without a fault");
  assert.equal(peakOf(stopped.left), 0, "Stop releases every loop");

  pressPad(engine, 0);
  pressPad(engine, 1);
  const again = await engine.process(128, 9000);
  assertLevel(again.left[8999], 2 * ONE_VOICE, "a press starts them again");

  engine.post({ type: "reset_live" });
  const reset = await engine.process(128, 1000);
  assert.equal(peakOf(reset.left), 0, "resetLive releases every loop too");
});

test("resetLive releases the pads' loops through the engine client", async () => {
  const frames = 4800;
  const song = kitSong({ pads: [pad("track-1", 0, { loop: "loop" })], frames });
  const samples = [constant(frames, 0.5)];

  /**
   * One render of that song: a live press starts its loop, and `reset` says
   * whether the client releases it before the render starts.
   * @param {boolean} reset
   * @returns {Promise<Float32Array>} the render's left channel
   */
  const render = async (reset) => {
    const context = new OfflineAudioContext({
      numberOfChannels: 2,
      length: Math.round(0.3 * SAMPLE_RATE),
      sampleRate: SAMPLE_RATE,
    });
    let engine = null;
    let rendered = false;
    try {
      engine = await studioEngine.create(context, { assetBytes: ASSETS });
      await engine.loadSample(SAMPLE_ID, samples.map((channel) => Float32Array.from(channel)), SAMPLE_RATE);
      engine.setSong(song);
      engine.play();
      engine.node.connect(context.destination);
      // The track's slot is built by the song; the press waits for it.
      await engine.flush();
      engine.livePad("track-1", BANK, 0, 127);
      await engine.flush();
      if (reset) engine.resetLive();
      await engine.flush();
      const buffer = await context.startRendering();
      rendered = true;
      const left = new Float32Array(buffer.length);
      buffer.copyFromChannel(left, 0);
      return left;
    } finally {
      if (engine) engine.dispose();
      if (!rendered) await releaseWorklet(context);
    }
  };

  // The loop outlives the sample's own 4800 frames when the client leaves it
  // alone, and is gone from the render's first frame when it does not.
  const kept = await render(false);
  assertLevel(kept[frames + 1000], ONE_VOICE, "the press started a loop that plays past the sample's end");
  const released = await render(true);
  assert.equal(peakOf(released), 0, "resetLive releases it");
});

test("M16 an ordinary setSong from an unrelated edit changes nothing: a running loop and its lights continue", async () => {
  const song = kitSong({
    pads: [pad("track-1", 0, { loop: "loop" }), pad("track-1", 1)],
    frames: 4800,
  });
  const engine = await createProcessor(song, [{ id: SAMPLE_ID, channels: [constant(4800, 0.5)] }]);
  engine.post({ type: "pad_events_on", on: true });

  pressPad(engine, 0);
  const running = await engine.process(128, 9000);
  assertLevel(running.left[8999], ONE_VOICE, "the live press started a loop");
  assert.deepEqual(
    statePairs(stateEvents(engine.messages)),
    [["track-1", BANK, 0, StudioPadEvents.STATE_LOOP]],
    "and its light reads loop",
  );

  // An edit that touches ANOTHER pad is no business of the loop's: it plays on
  // and its light never blinks.
  const edited = JSON.parse(JSON.stringify(song));
  edited.pads[padKeyOf(pad("track-1", 1))].gain_db = -6;
  engine.post({ type: "song", snapshot: edited });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const after = await engine.process(128, 2000);
  assert.deepEqual(engine.errors, [], "the processor must render without a fault");
  assertLevel(after.left[1999], ONE_VOICE, "the loop plays on through an unrelated edit");
  assert.equal(
    stateEvents(engine.messages).filter((event) => event.state === StudioPadEvents.STATE_OFF).length,
    0,
    "and its light never went off",
  );
});

test("M16 setSong that removes the pad's sample ends only that pad's voices", async () => {
  const song = kitSong({
    pads: [pad("track-1", 0, { loop: "loop" }), pad("track-1", 1, { gain_db: -6 })],
    frames: 48000,
  });
  const engine = await createProcessor(song, [{ id: SAMPLE_ID, channels: [constant(48000, 0.5)] }]);
  engine.post({ type: "pad_events_on", on: true });

  const quiet = ONE_VOICE * Math.pow(10, -6 / 20);
  pressPad(engine, 0);
  pressPad(engine, 1);
  const running = await engine.process(128, 512);
  assertLevel(running.left[511], ONE_VOICE + quiet, "the loop and the one-shot both sound");

  // The pad goes, and the sample only it played with it. The other pad of the
  // bank keeps its own voice: a song change only ends what the new song no
  // longer has.
  const without = JSON.parse(JSON.stringify(song));
  delete without.pads[padKeyOf(pad("track-1", 0))];
  delete without.samples[SAMPLE_ID];
  engine.post({ type: "song", snapshot: without });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const after = await engine.process(128, 1000);
  assert.deepEqual(engine.errors, [], "the processor must render without a fault");
  assertLevel(after.left[999], quiet, "only the pad that is still in the song sounds");
  assert.deepEqual(
    statePairs(stateEvents(engine.messages).filter((event) => event.state === StudioPadEvents.STATE_OFF)),
    [["track-1", BANK, 0, StudioPadEvents.STATE_OFF]],
    "and only the gone pad's light goes off",
  );
});

test("M23 a looping voice with sustain 0 ends when the envelope reaches 0 and emits one off", async () => {
  const song = kitSong({ pads: [pad("track-1", 0, { loop: "loop", decay_ms: 10, sustain: 0 })] });
  const engine = await createProcessor(song, [{ id: SAMPLE_ID, channels: [constant(48000, 0.5)] }]);
  engine.post({ type: "pad_events_on", on: true });

  pressPad(engine, 0);
  const out = await engine.process(128, 1024);
  assert.deepEqual(engine.errors, [], "the processor must render without a fault");
  // 10 ms of decay is 480 frames: the voice sounds while the decay runs and is
  // gone once the envelope reaches 0, instead of looping on at level 0.
  assert.ok(peakBetween(out.left, 0, 470) > 0.01, "the voice sounds while its decay runs");
  assert.equal(peakOf(out.left.subarray(490)), 0, "and it is gone once the envelope reaches 0");

  const offs = stateEvents(engine.messages).filter((event) => event.state === StudioPadEvents.STATE_OFF);
  assert.equal(offs.length, 1, `the looping voice's light goes off exactly once, got ${offs.length}`);
  assert.deepEqual(statePairs(offs), [["track-1", BANK, 0, StudioPadEvents.STATE_OFF]]);
});

// --- playback settings: speed, tempo sync, fixed velocity, hold, mute groups --

/** A gain in dB as the linear factor the engine uses (`dbToLinear`). */
function dbGain(db) {
  return Math.pow(10, db / 20);
}

test("speed_pct 200 plays an octave up in half the frames", async () => {
  // The same shape the pitch test uses: an odd length whose last sample is 0, so
  // a voice that reads every OTHER frame lands on that zero with its very last
  // read and the half-length is exact.
  const frames = 4801;
  const samples = ramp(frames);
  samples[frames - 1] = 0;

  const song = kitSong({ pads: [pad("track-1", 0, { speed_pct: 200 })], frames });
  const engine = await createProcessor(song, [{ id: SAMPLE_ID, channels: [samples] }]);

  pressPad(engine, 0);
  const out = await engine.process(128, 4000);
  assert.deepEqual(engine.errors, [], "the processor must render without a fault");

  // Twice the read per frame is an octave up (the pitch moves with the speed)
  // and half the length: frame `at` reads sample `at * 2`.
  for (const at of [0, 1, 2, 100, 2399]) {
    assertLevel(out.left[at], samples[at * 2] * CENTRE, `frame ${at} reads sample ${at * 2}`, 1e-7);
  }

  assertLevel(out.left[2400], 0, "frame 2400 reads the sample's own last frame, which is zero");
  for (const at of [2401, 2500, 3999]) {
    assert.equal(out.left[at], 0, `frame ${at} is past half the sample and has to be silent`);
  }
});

test("bpm_sync with source 100 BPM at song 120 BPM runs 1.2x, and with source_bpm_x10 0 it is ignored", async () => {
  // A ramp is read exactly through the voice's linear interpolation: at a step
  // of 1.2 frame `at` holds sample (1.2 * at), whatever the fraction.
  const frames = 48000;
  const samples = ramp(frames);

  /** One render of a synced pad, pressed live, over `frames` frames of audio. */
  const render = async (sourceBpmX10) => {
    const song = kitSong({
      pads: [pad("track-1", 0, { bpm_sync: true, source_bpm_x10: sourceBpmX10 })],
      frames,
    });
    const engine = await createProcessor(song, [{ id: SAMPLE_ID, channels: [Float32Array.from(samples)] }]);
    pressPad(engine, 0);
    const out = await engine.process(128, 2400);
    assert.deepEqual(engine.errors, [], "the processor must render without a fault");
    return out;
  };

  // A 100 BPM sample in a 120 BPM song runs at 120/100 = 1.2x: the pitch (and
  // with it the read rate) follows the speed.
  const synced = await render(1000);
  for (const at of [0, 1, 100, 1001, 2399]) {
    const want = ((1.2 * at + 1) / 100000) * CENTRE;
    assertLevel(synced.left[at], want, `frame ${at} reads 1.2 frames ahead`, 1e-7);
  }

  // A source of 0 means the tempo is not known, so the setting is ignored: the
  // voice plays at the pad's own 100 %.
  const unsynced = await render(0);
  for (const at of [0, 1, 100, 2399]) {
    assertLevel(unsynced.left[at], ((at + 1) / 100000) * CENTRE, `frame ${at} reads its own frame`, 1e-7);
  }
  assert.notEqual(
    synced.left[1000],
    unsynced.left[1000],
    "a known source tempo has to change the speed; an unknown one has to leave it alone",
  );
});

test("hold_ms 10 holds level 1 for 480 frames", async () => {
  // The pad settles at sustain 0.5 with a decay of 0, so without the hold its
  // level would drop to 0.5 on the very frame it starts.
  const song = kitSong({ pads: [pad("track-1", 0, { hold_ms: 10, sustain: 0.5 })] });
  const engine = await createProcessor(song, [{ id: SAMPLE_ID, channels: [constant(48000, 0.5)] }]);

  pressPad(engine, 0);
  const out = await engine.process(128, 1200);
  assert.deepEqual(engine.errors, [], "the processor must render without a fault");

  // 10 ms at 48 kHz is exactly 480 frames of level 1.
  for (const at of [0, 1, 479]) {
    assertLevel(out.left[at], ONE_VOICE, `frame ${at} is inside the hold`);
  }
  for (const at of [480, 481, 1000]) {
    assertLevel(out.left[at], ONE_VOICE * 0.5, `frame ${at} is past the hold and at the pad's sustain`);
  }
});

test("mute group 9 and 10 cut each other and leave group 1 alone", async () => {
  // Mute groups are the pad's plain `choke` integer: 9 and 10 are I and J, the
  // two the range gained, and they behave exactly as A..H do — a start in group
  // n fades the other voices of THAT group out, and never touches another one.
  const song = kitSong({
    pads: [
      pad("track-1", 0, { choke: 1 }),
      pad("track-1", 1, { choke: 9, gain_db: -6 }),
      pad("track-1", 2, { choke: 9, gain_db: -12 }),
      pad("track-1", 3, { choke: 10, gain_db: -18 }),
      pad("track-1", 4, { choke: 10, gain_db: -24 }),
    ],
    frames: 48000,
    clips: [patternClip("clip-1", "track-1")],
    steps: [
      step("clip-1", 0, 0, { v: 127 }),
      step("clip-1", 1, 1, { v: 127 }),
      step("clip-1", 2, 2, { v: 127 }),
      step("clip-1", 3, 3, { v: 127 }),
      step("clip-1", 4, 4, { v: 127 }),
    ],
  });
  const engine = await createProcessor(song, [{ id: SAMPLE_ID, channels: [constant(48000, 0.5)] }]);
  const out = await engine.process(128, 30000);
  assert.deepEqual(engine.errors, [], "the processor must render without a fault");

  const group1 = ONE_VOICE;
  const nineA = ONE_VOICE * dbGain(-6);
  const nineB = ONE_VOICE * dbGain(-12);
  const tenA = ONE_VOICE * dbGain(-18);
  const tenB = ONE_VOICE * dbGain(-24);
  const at = (stepIndex) => stepIndex * FRAMES_PER_SIXTEENTH;

  assertLevel(out.left[at(1) - 1], group1, "the group 1 pad plays alone before the next step");
  assertLevel(out.left[at(1)], group1 + nineA, "a group 9 start does not cut the group 1 voice");
  assertLevel(out.left[at(2) - 1], group1 + nineA, "and the group 9 voice is still there a step later");
  assertLevel(out.left[at(2)], group1 + nineA + nineB, "the next group 9 start's own frame still holds both");
  assertLevel(out.left[at(2) + 64], group1 + nineB, "64 frames later the earlier group 9 voice is gone");
  assertLevel(out.left[at(3)], group1 + nineB + tenA, "a group 10 start sits beside the group 9 voice");
  assertLevel(out.left[at(4)], group1 + nineB + tenA + tenB, "the second group 10 start still holds both of its group");
  assertLevel(out.left[at(4) + 64], group1 + nineB + tenB, "and the earlier group 10 voice is gone");
  assertLevel(
    out.left[at(5) - 1],
    group1 + nineB + tenB,
    "the group 1 voice the first step started is still sounding at the end",
  );
});

test("fixed_velocity makes a v 20 step as loud as v 127 and the hit event reports 127", async () => {
  const song = kitSong({
    pads: [pad("track-1", 0, { fixed_velocity: true }), pad("track-1", 1)],
    frames: 4800,
    clips: [patternClip("clip-1", "track-1")],
    // The same velocity-20 step on both pads, half a bar apart so the two voices
    // never overlap.
    steps: [step("clip-1", 0, 0, { v: 20 }), step("clip-1", 8, 1, { v: 20 })],
  });
  const engine = await createProcessor(song, [{ id: SAMPLE_ID, channels: [constant(4800, 0.5)] }]);
  engine.post({ type: "pad_events_on", on: true });

  const out = await engine.process(128, 9 * FRAMES_PER_SIXTEENTH);
  assert.deepEqual(engine.errors, [], "the processor must render without a fault");

  // The pad with the flag plays the step at full level, the one without it keeps
  // the step's own velocity.
  for (const at of [0, 1, 4799]) {
    assertLevel(out.left[at], ONE_VOICE, `frame ${at}: a fixed-velocity pad plays a v 20 step at full level`);
  }
  const quiet = ONE_VOICE * Math.pow(20 / 127, 2);
  const second = 8 * FRAMES_PER_SIXTEENTH;
  for (const at of [second, second + 1, second + 4799]) {
    assertLevel(out.left[at], quiet, `frame ${at}: a pad without the flag keeps the step's velocity`);
  }

  // The hit event is the velocity the voice really plays at, so the page's own
  // reading of the hit and a gain lane's `velocity_gain` are full too.
  assert.deepEqual(
    allPadEvents(engine.messages)
      .filter((event) => event.kind === "hit")
      .map((event) => [event.index, event.v]),
    [
      [0, 127],
      [1, 20],
    ],
    "the fixed pad's hit reports 127 and the other pad's its own step velocity",
  );
});

test("keep_pitch true on a pad changes nothing (ignored)", async () => {
  const frames = 4800;
  // A speed of 150 % with a +7 semitone pitch: a varispeed voice of this pad runs
  // out well inside the render, so the whole voice is compared, fade included.
  const songFor = (keepPitch) =>
    kitSong({
      pads: [pad("track-1", 0, { speed_pct: 150, pitch: 7, keep_pitch: keepPitch })],
      frames,
      clips: [patternClip("clip-1", "track-1")],
      steps: [step("clip-1", 0, 0, { v: 127 })],
    });

  const ignored = await renderProcessor(songFor(true), 128, 6000, [
    { id: SAMPLE_ID, channels: [constant(frames, 0.5)] },
  ]);
  const plain = await renderProcessor(songFor(false), 128, 6000, [
    { id: SAMPLE_ID, channels: [constant(frames, 0.5)] },
  ]);

  assert.ok(peakOf(ignored.left) > 0.01, "the pad has to sound, so the two renders really are compared");
  assert.deepEqual(ignored.left, plain.left, "keep_pitch is reserved: it moves no sample of the left channel");
  assert.deepEqual(ignored.right, plain.right, "and none of the right channel");
});

// --- motion lanes with the pad's own speed and direction; the steal order ----

/**
 * One track's sampler record, as the processor holds it: its voices, its fade
 * tails and its bank state entries.
 * @param {object} engine a processor from `createProcessor`
 * @param {string} trackId
 * @returns {object}
 */
function recordOf(engine, trackId) {
  const record = engine.processor.samplerRecord(trackId);
  assert.ok(record, `the song has to have built ${trackId}'s sampler slot`);
  return record;
}

/** @returns {object[]} the voices of one record that sound right now (this realm's array). */
function soundingOf(record) {
  return Array.from(record.voices).filter((voice) => voice.sounding);
}

/** @returns {object[]} the fade tails of one record that still ring out. */
function tailsOf(record) {
  return Array.from(record.tails || []).filter((voice) => voice.sounding);
}

test("a pitch lane on a speed_pct 150 pad keeps the 1.5x speed", async () => {
  const frames = 48000;
  const samples = ramp(frames);

  // A ramp is read through the voice's own linear interpolation, so a frame's
  // level names the position it read: at a step of 1.5 frames, frame `at` holds
  // sample 1.5 × at (sample n of `ramp` is (n + 1) / 100000).
  const song = kitSong({
    pads: [pad("track-1", 0, { speed_pct: 150 })],
    frames,
    clips: [patternClip("clip-1", "track-1")],
    steps: [step("clip-1", 0, 0, { v: 127 })],
    patterns: {
      "clip-1/a": {
        id: "a",
        clip_id: "clip-1",
        name: "A",
        order: 0,
        // A standing pitch lane on the very pad, at the pad's own 0 semitones:
        // the speed the lane must stack on is the only thing left to hear.
        motion: { [`${BANK}.0|pitch`]: [{ step_frac: 0, value: 0 }] },
      },
    },
  });
  const engine = await createProcessor(song, [{ id: SAMPLE_ID, channels: [Float32Array.from(samples)] }]);

  const out = await engine.process(128, 2400);
  assert.deepEqual(engine.errors, [], "the processor must render without a fault");
  for (const at of [0, 1, 2, 100, 1001, 2399]) {
    assertLevel(
      out.left[at],
      ((1.5 * at + 1) / 100000) * CENTRE,
      `frame ${at} reads 1.5 frames ahead, the pad's Speed 150 % under the lane`,
      1e-7,
    );
  }
});

test("a pitch lane on a ping-pong pad still reflects", async () => {
  const frames = 4800;
  const samples = [Float32Array.from(ramp(frames))];

  /** The same ping-pong song, with the standing pitch lane or without it. */
  const songFor = (withLane) =>
    kitSong({
      pads: [pad("track-1", 0, { loop: "pingpong" })],
      frames,
      clips: [patternClip("clip-1", "track-1")],
      steps: [step("clip-1", 0, 0, { v: 127 })],
      patterns: {
        "clip-1/a": {
          id: "a",
          clip_id: "clip-1",
          name: "A",
          order: 0,
          motion: withLane ? { [`${BANK}.0|pitch`]: [{ step_frac: 0, value: 0 }] } : {},
        },
      },
    });

  const lane = await renderProcessor(songFor(true), 128, 10000, [{ id: SAMPLE_ID, channels: samples }]);
  const plain = await renderProcessor(songFor(false), 128, 10000, [{ id: SAMPLE_ID, channels: samples }]);

  // The range's end is reflected, not wrapped: 4799, then the frame beside it.
  assertLevel(lane.left[4799], (4800 / 100000) * CENTRE, "frame 4799 reads the range's last sample", 1e-7);
  assertLevel(lane.left[4800], (4799 / 100000) * CENTRE, "the ping-pong reflects there instead of wrapping", 1e-7);
  assertLevel(lane.left[4801], (4798 / 100000) * CENTRE, "and reads the frame beside the end going back", 1e-7);
  // And so is the start, a loop later: 1, then up the range again.
  assertLevel(lane.left[9599], (2 / 100000) * CENTRE, "the reflection at the range's start reads its second sample", 1e-7);
  assertLevel(lane.left[9600], (3 / 100000) * CENTRE, "and the voice carries on up the range", 1e-7);

  // A pitch lane at 0 semitones changes no sample at all — the direction
  // included: the swept song is the very audio of the song without the lane.
  assert.deepEqual(lane.left, plain.left, "the pitch lane leaves every sample of the ping-pong alone");
  assert.deepEqual(lane.right, plain.right, "and every sample of the right channel");
});

test("clearing the pitch lane restores pitch, speed and direction", async () => {
  const frames = 9600;
  const samples = ramp(frames);

  const song = kitSong({
    pads: [pad("track-1", 0, { speed_pct: 150, reverse: true, loop: "pingpong" })],
    frames,
    clips: [patternClip("clip-1", "track-1")],
    steps: [step("clip-1", 0, 0, { v: 127 })],
    patterns: {
      "clip-1/a": {
        id: "a",
        clip_id: "clip-1",
        name: "A",
        order: 0,
        motion: { [`${BANK}.0|pitch`]: [{ step_frac: 0, value: 12 }] },
      },
    },
  });
  const engine = await createProcessor(song, [{ id: SAMPLE_ID, channels: [Float32Array.from(samples)] }]);

  // +12 semitones on a 150 % pad is 3 frames a frame, and the pad is reversed:
  // the voice reads backwards from the range's last sample at 9599.
  const swept = await engine.process(128, 4000);
  for (const at of [0, 1, 2]) {
    assertLevel(
      swept.left[at],
      ((9599 - 3 * at + 1) / 100000) * CENTRE,
      `frame ${at} reads 3 frames backwards under the lane`,
      1e-7,
    );
  }
  // (… 3, 2, then -1 reflects to 1) — the voice turns at the range's start.
  assertLevel(swept.left[3199], (3 / 100000) * CENTRE, "frame 3199 reads the range's third sample", 1e-7);
  assertLevel(swept.left[3200], (2 / 100000) * CENTRE, "the ping-pong reflects at the range's start", 1e-7);
  assertLevel(swept.left[3201], (5 / 100000) * CENTRE, "and heads back up the range at 3 frames a frame", 1e-7);
  assertLevel(swept.left[3999], (2399 / 100000) * CENTRE, "frame 3999 is where that has got to", 1e-7);

  // The lane is cleared: the pad's own pitch (0) is back, and with it the pad's
  // own 1.5× speed. The direction the ping-pong turned in is NOT reset: the
  // voice carries on up the range from where it stands (2401) at 1.5 a frame.
  const cleared = JSON.parse(JSON.stringify(song));
  cleared.patterns["clip-1/a"].motion = {};
  engine.post({ type: "song", snapshot: cleared });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const restored = await engine.process(128, 2000);
  assert.deepEqual(engine.errors, [], "the processor must render without a fault");
  for (const [at, position] of [[0, 2401], [1, 2402.5], [2, 2404], [500, 3151], [1999, 5399.5]]) {
    assertLevel(
      restored.left[at],
      ((position + 1) / 100000) * CENTRE,
      `frame ${4000 + at} reads position ${position} at the pad's own pitch and speed`,
      1e-7,
    );
  }
});

test("a gain lane on a fixed_velocity pad plays at full level", async () => {
  const song = kitSong({
    pads: [pad("track-1", 0, { fixed_velocity: true }), pad("track-1", 1)],
    frames: 4800,
    clips: [patternClip("clip-1", "track-1")],
    // The same velocity-20 step on both pads, half a bar apart.
    steps: [step("clip-1", 0, 0, { v: 20 }), step("clip-1", 8, 1, { v: 20 })],
    patterns: {
      "clip-1/a": {
        id: "a",
        clip_id: "clip-1",
        name: "A",
        order: 0,
        // A gain lane at 0 dB on each pad: it scales the voice's velocity gain,
        // which is full on the pad the flag covers and the step's own on the
        // other one.
        motion: {
          [`${BANK}.0|gain_db`]: [{ step_frac: 0, value: 0 }],
          [`${BANK}.1|gain_db`]: [{ step_frac: 0, value: 0 }],
        },
      },
    },
  });
  const engine = await createProcessor(song, [{ id: SAMPLE_ID, channels: [constant(4800, 0.5)] }]);

  const out = await engine.process(128, 9 * FRAMES_PER_SIXTEENTH);
  assert.deepEqual(engine.errors, [], "the processor must render without a fault");
  for (const at of [0, 1, 4799]) {
    assertLevel(out.left[at], ONE_VOICE, `frame ${at}: the fixed pad plays a v 20 step at full level under its lane`);
  }
  const quiet = ONE_VOICE * Math.pow(20 / 127, 2);
  const second = 8 * FRAMES_PER_SIXTEENTH;
  for (const at of [second, second + 1, second + 4799]) {
    assertLevel(
      out.left[at],
      quiet,
      `frame ${at}: the pad without the flag keeps the step's own velocity under the same lane`,
    );
  }
});

test("a loop survives 16 one-shot hits on its track and the 17th hit takes a one-shot", async () => {
  // Sixteen voices at full level would reach the master's clip, so each one is
  // set 24 dB down: their sum stays inside it and a level still counts them.
  const QUIET_DB = -24;
  const pads = [pad("track-1", 0, { loop: "loop", gain_db: QUIET_DB })];
  for (let index = 1; index < 16; index += 1) pads.push(pad("track-1", index, { gain_db: QUIET_DB }));
  const song = kitSong({ pads });
  const engine = await createProcessor(song, [{ id: SAMPLE_ID, channels: [constant(48000, 0.5)] }]);
  const oneVoice = 0.5 * dbGain(QUIET_DB) * CENTRE;

  // The operator's loop, then fifteen one-shots: the track's pool is full.
  pressPad(engine, 0);
  for (let index = 1; index < 16; index += 1) pressPad(engine, index);
  const full = await engine.process(128, 512);
  assertLevel(full.left[511], 16 * oneVoice, "sixteen voices sound, the loop among them", 1e-7);

  // The seventeenth hit has nowhere to go but the oldest ONE-SHOT: the loop the
  // operator started by hand is not what a press takes.
  pressPad(engine, 1);
  await engine.process(128, 32);
  const record = recordOf(engine, "track-1");
  assert.deepEqual(
    tailsOf(record).map((voice) => voice.index),
    [1],
    "the oldest one-shot, pad 1's first voice, is the one the seventeenth hit took",
  );

  const after = await engine.process(128, 480);
  assert.deepEqual(engine.errors, [], "the processor must render without a fault");
  const sounding = soundingOf(record);
  assert.equal(sounding.length, 16, "the track still holds its sixteen voices");
  assert.deepEqual(
    sounding.filter((voice) => voice.index === 0).map((voice) => voice.looping),
    [true],
    "and the loop is one of them, still turning at its range's end",
  );
  assertLevel(after.left[479], 16 * oneVoice, "and sixteen voices still sound, the loop included", 1e-7);
});

test("when all 16 voices loop, the 17th hit steals the oldest loop and A1b emits exactly one off for it", async () => {
  const pads = [];
  for (let index = 0; index < 15; index += 1) pads.push(pad("track-1", index, { loop: "loop" }));
  // A Gate + Loop pad starts a new loop on every press instead of toggling, so
  // it is how a seventeenth voice can be asked for while every slot loops.
  pads.push(pad("track-1", 15, { mode: "gate", loop: "loop" }));
  const song = kitSong({ pads });
  const engine = await createProcessor(song, [{ id: SAMPLE_ID, channels: [constant(48000, 0.5)] }]);
  engine.post({ type: "pad_events_on", on: true });

  for (let index = 0; index < 16; index += 1) pressPad(engine, index);
  await engine.process(128, 128);
  const record = recordOf(engine, "track-1");
  assert.equal(
    soundingOf(record).filter((voice) => voice.looping).length,
    16,
    "all sixteen voices of the track loop",
  );

  // Every slot is a loop, so the oldest loop goes: pad 0's.
  pressPad(engine, 15);
  await engine.process(128, 32);
  assert.deepEqual(
    tailsOf(record).map((voice) => [voice.index, voice.looping]),
    [[0, false]],
    "the oldest loop is the one taken, and its tail does not loop",
  );
  assert.equal(soundingOf(record).filter((voice) => voice.index === 0).length, 0, "pad 0 lost its voice at once");
  assert.equal(soundingOf(record).length, 16, "and the track still holds sixteen voices");

  await engine.process(128, 256);
  assert.equal(tailsOf(record).length, 0, "the tail is over after its fade");
  const offs = stateEvents(engine.messages).filter((event) => event.state === StudioPadEvents.STATE_OFF);
  assert.deepEqual(
    statePairs(offs),
    [["track-1", BANK, 0, StudioPadEvents.STATE_OFF]],
    "pad 0's light goes off exactly once, and no other pad's does",
  );
});

test("a loop survives the song-wide cap while any unprotected voice exists", async () => {
  // Four full tracks (64 voices) and a fifth one to start the 65th voice on.
  const trackIds = ["track-1", "track-2", "track-3", "track-4", "track-5"];
  const pads = [];
  for (const trackId of trackIds.slice(0, 4)) {
    for (let index = 0; index < 16; index += 1) {
      const looping = trackId === "track-1" && index === 0;
      pads.push(pad(trackId, index, looping ? { loop: "loop", gain_db: -36 } : { gain_db: -36 }));
    }
  }
  pads.push(pad("track-5", 0, { gain_db: -36 }));
  const song = samplerSong({
    tracks: trackIds.map((id) => track(id)),
    clips: [],
    pads,
    samples: { [SAMPLE_ID]: sampleDoc(SAMPLE_ID, 48000) },
    steps: [],
  });
  const engine = await createProcessor(song, [{ id: SAMPLE_ID, channels: [constant(48000, 0.5)] }]);

  const press = (trackId, index) =>
    engine.post({ type: "live", track_id: trackId, bank_id: BANK, index, v: 127, on: true });
  const songVoices = () => {
    let total = 0;
    for (const trackId of trackIds) total += soundingOf(recordOf(engine, trackId)).length;
    return total;
  };

  // The operator's loop first: it is the oldest voice of the song, and the one
  // the cap must still not take.
  press("track-1", 0);
  for (const trackId of trackIds.slice(0, 4)) {
    for (let index = 0; index < 16; index += 1) {
      if (trackId === "track-1" && index === 0) continue;
      press(trackId, index);
    }
  }
  await engine.process(128, 32);
  assert.equal(songVoices(), 64, "the song is at its 64-voice cap");

  // A track with a free slot, so this start takes the song past the cap.
  press("track-5", 0);
  const after = await engine.process(128, 256);
  assert.deepEqual(engine.errors, [], "the processor must render without a fault");
  assert.equal(songVoices(), 64, "the cap holds the song at 64 voices");
  const loopTrack = recordOf(engine, "track-1");
  assert.deepEqual(
    soundingOf(loopTrack).filter((voice) => voice.index === 0).map((voice) => voice.looping),
    [true],
    "the operator's loop survives the cap",
  );
  assert.equal(
    soundingOf(loopTrack).filter((voice) => voice.index === 1).length,
    0,
    "and the voice the cap took is the oldest unprotected one, pad 1 of the same track",
  );
  assert.ok(peakOf(after.left) > 0.1, `the capped song still sounds, peak was ${peakOf(after.left)}`);
});

test("a stolen looping voice's tail does not loop and ends within its fade", async () => {
  const pads = [];
  for (let index = 0; index < 16; index += 1) pads.push(pad("track-1", index, { mode: "gate", loop: "loop" }));
  const song = kitSong({ pads });
  const engine = await createProcessor(song, [{ id: SAMPLE_ID, channels: [constant(48000, 0.5)] }]);

  for (let index = 0; index < 16; index += 1) pressPad(engine, index);
  await engine.process(128, 128);

  // Every slot loops, so the seventeenth press takes the oldest loop.
  pressPad(engine, 0);
  await engine.process(128, 32);
  const record = recordOf(engine, "track-1");
  const tails = tailsOf(record);
  assert.equal(tails.length, 1, "the stolen loop rings out in one fade tail");
  assert.equal(tails[0].loop, "loop", "the voice it came from was a loop");
  assert.equal(tails[0].looping, false, "but the tail itself does not keep looping");
  assert.equal(tails[0].ending, true, "it holds its last sample and fades instead");

  await engine.process(128, 64);
  assert.equal(tailsOf(record).length, 0, "and it is over within its 64-frame fade");
  // The voice that took the slot loops on, so the pad's sound did not stop with
  // the tail.
  assert.equal(
    soundingOf(record).filter((voice) => voice.index === 0).length,
    1,
    "pad 0's new voice loops on where the tail left off",
  );
});

test("a stolen voice that carried held and paused (flags set by the test) leaves a tail with both false and A1b emits exactly one off", async () => {
  const pads = [];
  for (let index = 0; index < 16; index += 1) pads.push(pad("track-1", index, { mode: "gate", loop: "loop" }));
  const song = kitSong({ pads });
  const engine = await createProcessor(song, [{ id: SAMPLE_ID, channels: [constant(48000, 0.5)] }]);
  engine.post({ type: "pad_events_on", on: true });

  for (let index = 0; index < 16; index += 1) pressPad(engine, index);
  await engine.process(128, 128);

  // HOLD and Pause-all are live flags on the voice (C1a, C1b): the oldest voice
  // of the track carries both here, so the tail it becomes is what is read.
  const record = recordOf(engine, "track-1");
  const flagged = soundingOf(record).filter((voice) => voice.index === 0);
  assert.equal(flagged.length, 1, "pad 0 has the one voice its press started");
  flagged[0].held = true;
  flagged[0].paused = true;

  // Every slot loops, so the oldest goes: the flagged voice.
  pressPad(engine, 1);
  await engine.process(128, 32);
  const tails = tailsOf(record);
  assert.equal(tails.length, 1, "the stolen voice rings out in one tail");
  assert.equal(tails[0].index, 0, "and it is pad 0's voice");
  assert.equal(tails[0].held, false, "the tail holds nothing");
  assert.equal(tails[0].paused, false, "and it is not paused, so its fade runs to its end");
  assert.equal(tails[0].looping, false, "and it does not loop");

  await engine.process(128, 256);
  assert.equal(tailsOf(record).length, 0, "the tail is over after its fade");
  const offs = stateEvents(engine.messages).filter((event) => event.state === StudioPadEvents.STATE_OFF);
  assert.deepEqual(
    statePairs(offs),
    [["track-1", BANK, 0, StudioPadEvents.STATE_OFF]],
    "pad 0's light goes off exactly once as its last voice goes",
  );
});

// --- a sounding voice follows its pad: tempo and Reverse (B4c) ---------------

/**
 * The level a voice reads off `ramp` when it stands on `position`: the sample is
 * blended linearly, so a frame's level names the position it read.
 * @param {number} position
 * @returns {number}
 */
function rampLevel(position) {
  return ((position + 1) / 100000) * CENTRE;
}

test("M11 a tempo change at 120 to 150 BPM speeds a running bpm_sync loop by 1.25x within one block and leaves a non-synced loop alone", async () => {
  const frames = 48000;
  const song = kitSong({
    pads: [
      // A 100 BPM sample, synced: 120 / 100 = 1.2x at the song's own tempo.
      pad("track-1", 0, { loop: "loop", bpm_sync: true, source_bpm_x10: 1000 }),
      // The same loop without the setting: the tempo is no business of its own.
      pad("track-1", 1, { loop: "loop" }),
    ],
    frames,
  });
  const engine = await createProcessor(song, [{ id: SAMPLE_ID, channels: [Float32Array.from(ramp(frames))] }]);

  pressPad(engine, 0);
  pressPad(engine, 1);
  await engine.process(128, 2400);
  const record = recordOf(engine, "track-1");
  const synced = soundingOf(record).filter((voice) => voice.index === 0)[0];
  const plain = soundingOf(record).filter((voice) => voice.index === 1)[0];
  assertLevel(synced.speed, 1.2, "a 100 BPM sample in a 120 BPM song runs at 1.2x", 1e-12);
  assertLevel(plain.speed, 1, "a loop that names no source tempo keeps the pad's own speed", 1e-12);
  // The positions the two voices stand on: the frame each one reads next.
  const syncedStart = synced.position;
  const plainStart = plain.position;

  // The song moves to 150 BPM. The synced loop follows it from the next block on
  // (150 / 100 = 1.5x, a quarter faster than 1.2x) and the plain one goes on at
  // its own 1x.
  const faster = JSON.parse(JSON.stringify(song));
  faster.meta.bpm = 150;
  engine.post({ type: "song", snapshot: faster });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const after = await engine.process(128, 512);
  assert.deepEqual(engine.errors, [], "the processor must render without a fault");
  assertLevel(synced.speed, 1.5, "the new tempo reaches the running loop in the next block", 1e-12);
  assertLevel(plain.speed, 1, "and leaves a loop that is not synced at its own speed", 1e-12);
  for (const at of [0, 1, 100, 511]) {
    const expected = rampLevel(syncedStart + 1.5 * at) + rampLevel(plainStart + at);
    assertLevel(
      after.left[at],
      expected,
      `frame ${at}: the synced loop reads 1.5 a frame and the plain one its own 1`,
      1e-7,
    );
  }
});

test("a tempo change with a pitch lane running keeps the lane's pitch", async () => {
  const frames = 48000;
  const song = kitSong({
    pads: [pad("track-1", 0, { bpm_sync: true, source_bpm_x10: 1000 })],
    frames,
    clips: [patternClip("clip-1", "track-1", { length_steps: 32 })],
    steps: [step("clip-1", 0, 0, { v: 127 })],
    patterns: {
      "clip-1/a": {
        id: "a",
        clip_id: "clip-1",
        name: "A",
        order: 0,
        // One standing point: the lane holds this pad an octave up.
        motion: { [`${BANK}.0|pitch`]: [{ step_frac: 0, value: 12 }] },
      },
    },
  });
  const engine = await createProcessor(song, [{ id: SAMPLE_ID, channels: [Float32Array.from(ramp(frames))] }]);

  // The step's voice runs at 1.2x (a 100 BPM source in a 120 BPM song), doubled
  // by the lane's octave.
  await engine.process(128, 2400);
  const voice = soundingOf(recordOf(engine, "track-1")).filter((entry) => entry.index === 0)[0];
  assertLevel(voice.step, 2.4, "the lane's octave on top of the synced 1.2x", 1e-9);
  const start = voice.position;

  const faster = JSON.parse(JSON.stringify(song));
  faster.meta.bpm = 150;
  engine.post({ type: "song", snapshot: faster });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const after = await engine.process(128, 512);
  assert.deepEqual(engine.errors, [], "the processor must render without a fault");
  // 1.5x under the lane's octave is 3 frames a frame: a reconcile that put the
  // pitch back to the pad's own 0 would read 1.5 a frame instead.
  assertLevel(voice.step, 3, "the lane's pitch is kept as the new tempo is applied under it", 1e-9);
  for (const at of [0, 1, 100, 511]) {
    assertLevel(after.left[at], rampLevel(start + 3 * at), `frame ${at} reads 3 frames ahead`, 1e-7);
  }
});

test("M10 toggling reverse in the song while a pad sounds flips that pad's voices and no others", async () => {
  const frames = 48000;
  const song = kitSong({
    pads: [pad("track-1", 0, { loop: "loop" }), pad("track-1", 1, { loop: "loop" })],
    frames,
  });
  const engine = await createProcessor(song, [{ id: SAMPLE_ID, channels: [Float32Array.from(ramp(frames))] }]);

  pressPad(engine, 0);
  pressPad(engine, 1);
  await engine.process(128, 128);
  const record = recordOf(engine, "track-1");
  const flipped = soundingOf(record).filter((voice) => voice.index === 0)[0];
  const other = soundingOf(record).filter((voice) => voice.index === 1)[0];
  // Both loops read one frame a frame, so both stand on frame 128 after 128
  // frames: the frame each one reads next.
  const flippedStart = flipped.position;
  const otherStart = other.position;
  assertLevel(flippedStart, 128, "the loop has read one frame for every frame", 1e-9);

  // Reverse is switched on for pad 0 alone, in the song.
  const reversed = JSON.parse(JSON.stringify(song));
  reversed.pads[padKeyOf(pad("track-1", 0))].reverse = true;
  engine.post({ type: "song", snapshot: reversed });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const after = await engine.process(128, 100);
  assert.deepEqual(engine.errors, [], "the processor must render without a fault");
  // No jump: the frame the flip lands on reads the position the voice stood on.
  assertLevel(
    after.left[0],
    rampLevel(flippedStart) + rampLevel(otherStart),
    "the flipped voice carries on from the frame it was about to read",
    1e-7,
  );
  for (const at of [1, 50, 99]) {
    const expected = rampLevel(flippedStart - at) + rampLevel(otherStart + at);
    assertLevel(after.left[at], expected, `frame ${at}: pad 0 runs backwards and pad 1 on forwards`, 1e-7);
  }
});

test("M10 a locked-reverse step voice is not flipped", async () => {
  const frames = 4800;
  const song = kitSong({
    pads: [pad("track-1", 0)],
    frames,
    clips: [patternClip("clip-1", "track-1", { length_steps: 32 })],
    steps: [step("clip-1", 0, 0, { v: 127, locks: { reverse: true } })],
  });
  const engine = await createProcessor(song, [{ id: SAMPLE_ID, channels: [Float32Array.from(ramp(frames))] }]);

  // The step's lock starts the voice reversed: frame 0 reads the range's last
  // sample, and 128 frames in the voice stands on 4671.
  await engine.process(128, 128);
  const voice = soundingOf(recordOf(engine, "track-1"))[0];
  assert.equal(voice.locked.indexOf("reverse") >= 0, true, "the step's voice carries the reverse lock");
  const start = voice.position;
  assertLevel(start, 4671, "the reversed voice has read 128 frames backwards", 1e-9);

  // The pad's own Reverse is switched on. This voice keeps the direction its own
  // step asked for: the lock beats the pad, before and after the edit.
  const flipped = JSON.parse(JSON.stringify(song));
  flipped.pads[padKeyOf(pad("track-1", 0))].reverse = true;
  engine.post({ type: "song", snapshot: flipped });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const after = await engine.process(128, 100);
  assert.deepEqual(engine.errors, [], "the processor must render without a fault");
  for (const at of [0, 1, 50, 99]) {
    assertLevel(
      after.left[at],
      rampLevel(start - at),
      `frame ${at} keeps the direction the step's lock asked for`,
      1e-7,
    );
  }
});

test("M10 an unrelated edit does not flip a ping-pong voice that has reflected", async () => {
  const frames = 4800;
  const song = kitSong({
    pads: [pad("track-1", 0, { loop: "pingpong" }), pad("track-1", 1, { gain_db: -6 })],
    frames,
  });
  const engine = await createProcessor(song, [{ id: SAMPLE_ID, channels: [Float32Array.from(ramp(frames))] }]);

  // Past the range's end: the ping-pong has reflected, so its own `dir` is −1
  // while the pad's Reverse is still off.
  pressPad(engine, 0);
  await engine.process(128, 4900);
  const voice = soundingOf(recordOf(engine, "track-1")).filter((entry) => entry.index === 0)[0];
  assert.equal(voice.dir, -1, "the voice reflected at the range's end");
  const start = voice.position;
  assertLevel(start, 4698, "and it has come 100 frames back down from there", 1e-9);

  // An edit that has nothing to do with the loop: another pad's gain.
  const edited = JSON.parse(JSON.stringify(song));
  edited.pads[padKeyOf(pad("track-1", 1))].gain_db = -12;
  engine.post({ type: "song", snapshot: edited });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const after = await engine.process(128, 100);
  assert.deepEqual(engine.errors, [], "the processor must render without a fault");
  for (const at of [0, 1, 50, 99]) {
    assertLevel(after.left[at], rampLevel(start - at), `frame ${at} carries on down the range, not back up it`, 1e-7);
  }
});

test("no tempo change and no pad change: the reconcile does no voice scan", async () => {
  const frames = 48000;
  const song = kitSong({
    pads: [pad("track-1", 0, { loop: "loop", bpm_sync: true, source_bpm_x10: 1000 })],
    frames,
  });
  const engine = await createProcessor(song, [{ id: SAMPLE_ID, channels: [Float32Array.from(ramp(frames))] }]);

  pressPad(engine, 0);
  await engine.process(128, 384);
  const voice = soundingOf(recordOf(engine, "track-1"))[0];
  assertLevel(voice.speed, 1.2, "the synced loop runs at the song's own 120 BPM", 1e-12);

  // A voice is only ever given its speed by its own start or by the reconcile, so
  // a speed nothing recomputes is still standing after a block. The step is left
  // alone, so the audio goes on exactly as it was.
  voice.speed = 0.5;
  await engine.process(128, 128);
  assertLevel(
    voice.speed,
    0.5,
    "a block with no tempo change must not walk the voices for their speed",
    1e-12,
  );
  await engine.process(128, 128);
  assertLevel(voice.speed, 0.5, "and neither does the block after it", 1e-12);

  // The scan is there when the tempo does move: the very same voice follows.
  const faster = JSON.parse(JSON.stringify(song));
  faster.meta.bpm = 150;
  engine.post({ type: "song", snapshot: faster });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await engine.process(128, 128);
  assertLevel(voice.speed, 1.5, "a tempo change is what makes the reconcile walk the voices", 1e-12);
});