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
 * the song, launch its scene, play, render.
 * @param {object} song
 * @param {{seconds?: number, samples?: object[], onError?: (text: string) => void,
 *          onSampleNeeded?: (sampleId: string) => void}} [options] `samples` is
 *   one `{id, channels}` per sample to load, each at the context's rate
 * @returns {Promise<{left: Float32Array, right: Float32Array}>}
 */
async function renderSamplerSong(song, { seconds = 1, samples = [], onError, onSampleNeeded } = {}) {
  const context = new OfflineAudioContext({
    numberOfChannels: 2,
    length: Math.round(seconds * SAMPLE_RATE),
    sampleRate: SAMPLE_RATE,
  });
  let engine = null;
  let rendered = false;
  try {
    engine = await studioEngine.create(context, { assetBytes: ASSETS });
    if (typeof onError === "function") engine.onError(onError);
    if (typeof onSampleNeeded === "function") engine.onSampleNeeded(onSampleNeeded);
    for (const item of samples) {
      // A fresh copy per render: loadSample transfers the buffers to the worklet.
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
    const buffer = await context.startRendering();
    rendered = true;
    // copyFromChannel, never getChannelData: see renderSong in server/render.js.
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

/** Assert one rendered frame against what the voice has to have produced. */
function assertLevel(actual, expected, what, tolerance = 1e-6) {
  assert.ok(
    Math.abs(actual - expected) < tolerance,
    `${what}: expected ${expected}, got ${actual}`,
  );
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

test("a dense sampler song renders faster than real time in Node", async () => {
  const SECONDS = 30;

  // Eight short pads, four sampler tracks playing 16ths across them with a
  // filter and an envelope on every voice, and four SunVox tracks playing a
  // note per beat: a song that has to keep up with the clock.
  const samples = [];
  const sampleDocs = {};
  for (let index = 0; index < 8; index += 1) {
    const frames = 9600;
    const pcm = new Float32Array(frames);
    for (let at = 0; at < frames; at += 1) {
      pcm[at] = Math.sin((2 * Math.PI * (180 + index * 40) * at) / SAMPLE_RATE) * 0.4 * (1 - at / frames);
    }
    samples.push({ id: `sample-${index + 1}`, channels: [pcm] });
    sampleDocs[`sample-${index + 1}`] = sampleDoc(`sample-${index + 1}`, frames);
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
    for (let padIndex = 0; padIndex < 8; padIndex += 1) {
      pads.push(
        pad(trackId, padIndex, {
          sample_id: `sample-${padIndex + 1}`,
          decay_ms: 100,
          sustain: 0.6,
          release_ms: 100,
          filter: { type: "lp", cutoff_hz: 3000, resonance: 0.5 },
        }),
      );
    }
    for (let at = 0; at < 16; at += 1) {
      steps.push(step(clipId, at, at % 8, { v: 70 + ((at * 7) % 50) }));
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

  const started = Date.now();
  const { left, right } = await renderSamplerSong(song, { seconds: SECONDS, samples });
  const elapsed = Date.now() - started;

  assert.ok(peakOf(left) > 0.01, `the dense song has to be audible, peak was ${peakOf(left)}`);
  assert.ok(peakOf(right) > 0.01, `the dense song has to be audible on the right too, peak was ${peakOf(right)}`);
  assert.ok(
    elapsed < SECONDS * 1000,
    `a ${SECONDS} s dense sampler song has to render faster than real time, took ${elapsed} ms`,
  );
});