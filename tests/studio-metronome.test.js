/**
 * Studio's engine metronome: a click on every quarter-note beat, added to the
 * engine's OUTPUT and nowhere else.
 *
 * Every audio check here runs the REAL engine — `node-web-audio-api`'s
 * OfflineAudioContext with the bundle's own worklet, built the way
 * `tests/studio-engine.test.js` builds it — so what is measured is the audio the
 * operator hears from the panel, not a stand-in. The one exception is the last
 * assertion of the render test, which reads `server/render.js`'s source to pin
 * that the render path can never ask for a click.
 *
 * The checks:
 *   - the metronome is off by default (an empty song renders pure silence);
 *   - with it on, a click lands on every quarter note, the first beat of an
 *     engine bar is the accent (louder and higher), and a tempo change moves the
 *     clicks with the sequencer's own clock;
 *   - a song whose `meta.meter` is 3/4 still clicks on quarters with an accent
 *     every fourth one: the engine's bars are four beats, and the click follows
 *     what the engine plays;
 *   - the click is a monitor signal: a master tap carries none of it;
 *   - a render is click-free: `server/render.js` and an engine that never
 *     receives `setMetronome` produce the very same bytes, and turning the
 *     metronome on really does change the engine's output (so the comparison
 *     proves something);
 *   - turning it off before Play leaves the output silent.
 *
 * The count-in (R1, R5) lives here too, because a count-in is the same monitor
 * signal on the same output: its clicks land on a grid of their own with the
 * metronome switched off, the metronome's own beats follow their toggle after it,
 * and a master tap and the meter hold none of it. The last case counts the arrays
 * the count-in's block path builds, in a stand-in worklet scope whose array
 * constructors count, so "it allocates nothing per block" is a number rather
 * than a claim.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import { renderSong as renderThroughServer } from "../bundles/studio/server/render.js";

const ENGINE_DIR = fileURLToPath(new URL("../bundles/studio/engine/", import.meta.url));
const VENDOR_DIR = fileURLToPath(new URL("../bundles/studio/vendor/sunvox/", import.meta.url));
const NAM_DIR = fileURLToPath(new URL("../bundles/studio/vendor/nam/", import.meta.url));
const SYMBOLS_FILE = fileURLToPath(
  new URL("../bundles/studio/node_modules/node-web-audio-api/js/lib/symbols.js", import.meta.url),
);

// The bundle's own dependency, resolved from inside the bundle (that is where
// package.json declares it).
const bundleRequire = createRequire(join(ENGINE_DIR, "x.js"));
const { OfflineAudioContext } = bundleRequire("node-web-audio-api");
const studioEngine = bundleRequire(join(ENGINE_DIR, "engine-client.js"));

// `startRendering()` releases the worklet thread; a render that stops before it
// gets there has to release it by hand or the process never exits.
const { kWorkletRelease } = await import(pathToFileURL(SYMBOLS_FILE).href);

/** The engine sources, read from the bundle exactly as a Node caller would. */
const ASSETS = {
  "sequencer.js": readFileSync(join(ENGINE_DIR, "sequencer.js"), "utf8"),
  "resample.js": readFileSync(join(ENGINE_DIR, "resample.js"), "utf8"),
  "sampler-voice.js": readFileSync(join(ENGINE_DIR, "sampler-voice.js"), "utf8"),
  "pad-events.js": readFileSync(join(ENGINE_DIR, "pad-events.js"), "utf8"),
  "roll-clock.js": readFileSync(join(ENGINE_DIR, "roll-clock.js"), "utf8"),
  "perf-fx.js": readFileSync(join(ENGINE_DIR, "perf-fx.js"), "utf8"),
  "sunvox.js": readFileSync(join(VENDOR_DIR, "sunvox.js"), "utf8"),
  "spessasynth.js": readFileSync(join(VENDOR_DIR, "..", "spessasynth", "spessasynth.js"), "utf8"),
  "font-voice.js": readFileSync(join(ENGINE_DIR, "font-voice.js"), "utf8"),
  "dynamics.js": readFileSync(join(ENGINE_DIR, "dynamics.js"), "utf8"),
  "faust-host.js": readFileSync(join(ENGINE_DIR, "faust-host.js"), "utf8"),
  "meter.js": readFileSync(join(ENGINE_DIR, "meter.js"), "utf8"),
  "nam.js": readFileSync(join(NAM_DIR, "nam.js"), "utf8"),
  "nam-host.js": readFileSync(join(ENGINE_DIR, "nam-host.js"), "utf8"),
  "convolver.js": readFileSync(join(ENGINE_DIR, "convolver.js"), "utf8"),
  "nam-engine.wasm": readFileSync(join(NAM_DIR, "nam-engine.wasm")),
  "studio-processor.js": readFileSync(join(ENGINE_DIR, "studio-processor.js"), "utf8"),
  "sunvox.wasm": readFileSync(join(VENDOR_DIR, "sunvox.wasm")),
};

const SAMPLE_RATE = 48000;

/** What a click has to reach before it counts as one (its quietest peaks). */
const ONSET_THRESHOLD = 0.05;

/**
 * How long the output has to stay under the threshold before a loud sample is a
 * NEW click: longer than one cycle of the lowest click (48 frames at 1 kHz), far
 * shorter than the shortest gap between two beats.
 */
const ONSET_GAP = 800;

/** An accent's peak and a plain beat's, as the processor makes them. */
const ACCENT_PEAK = 0.5;
const PLAIN_PEAK = 0.35;

/** @param {{bpm?: number, meter?: number[]}} [options] @returns {object} a song with no tracks and no clips. */
function emptySong({ bpm = 120, meter = [4, 4] } = {}) {
  return {
    meta: { title: "Metronome", bpm, meter, key: "C major" },
    tracks: [],
    scenes: [{ id: "scene-1", name: "A" }],
    clips: {},
  };
}

/**
 * @param {{bpm?: number, meter?: number[]}} [options]
 * @returns {object} one track with one clip holding a single note on beat 0.
 */
function oneNoteSong({ bpm = 120, meter = [4, 4] } = {}) {
  return {
    meta: { title: "Metronome", bpm, meter, key: "C major" },
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
      },
    ],
    scenes: [{ id: "scene-1", name: "A" }],
    clips: {
      "clip-1": {
        id: "clip-1",
        track_id: "track-1",
        scene_id: "scene-1",
        name: "One",
        length_bars: 1,
        notes: [{ t: 0, d: 1, p: 60, v: 100 }],
      },
    },
  };
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

/**
 * Render one song offline through the real engine, the way the panel does:
 * build the engine, hand it the song, launch its first scene, play, render.
 * @param {{song: object, seconds?: number, sampleRate?: number,
 *          metronome?: boolean, off?: boolean, tap?: boolean,
 *          countIn?: number, meter?: boolean}} options
 *   `metronome` turns it on before Play, `off` turns it on and straight back
 *   off before Play, `tap` turns a master tap on, `countIn` plays with that many
 *   bars of count-in, and `meter` follows the master meter's readings
 * @returns {Promise<{left: Float32Array, right: Float32Array,
 *                    taps: object[], readings: object[], countIns: object[],
 *                    sampleRate: number}>}
 */
async function renderEngine({
  song,
  seconds = 2,
  sampleRate = SAMPLE_RATE,
  metronome = false,
  off = false,
  tap = false,
  countIn = 0,
  meter = false,
} = {}) {
  const context = new OfflineAudioContext({
    numberOfChannels: 2,
    length: Math.round(seconds * sampleRate),
    sampleRate,
  });
  let engine = null;
  let rendered = false;
  const taps = [];
  const readings = [];
  const countIns = [];
  try {
    engine = await studioEngine.create(context, { assetBytes: ASSETS, namCores: 0 });
    engine.setSong(song);
    if (Array.isArray(song.scenes) && song.scenes.length > 0) engine.launchScene(song.scenes[0].id);
    if (tap) engine.onTap((block) => taps.push(block));
    if (meter) engine.onMeter((reading) => readings.push(reading));
    if (countIn > 0) engine.onCountIn((event) => countIns.push(event));
    if (metronome) engine.setMetronome(true);
    if (off) {
      engine.setMetronome(true);
      engine.setMetronome(false);
    }
    if (countIn > 0) engine.play({ countInBars: countIn });
    else engine.play();
    if (tap) engine.tap("master", true);
    engine.node.connect(context.destination);
    await engine.flush();
    const buffer = await context.startRendering();
    rendered = true;
    return { left: channelOf(buffer, 0), right: channelOf(buffer, 1), taps, readings, countIns, sampleRate };
  } finally {
    if (engine) engine.dispose();
    if (!rendered) await releaseWorklet(context);
  }
}

/**
 * The frames a click starts on: the first sample above the threshold after at
 * least `ONSET_GAP` frames of quiet. A sine dips through zero twice a cycle,
 * which is why the quiet has to be long enough to mean silence.
 * @param {Float32Array} samples
 * @returns {number[]} absolute frame indices, in order
 */
function onsetsOf(samples) {
  const onsets = [];
  let lastLoud = -Infinity;
  for (let at = 0; at < samples.length; at += 1) {
    if (Math.abs(samples[at]) <= ONSET_THRESHOLD) continue;
    if (at - lastLoud > ONSET_GAP) onsets.push(at);
    lastLoud = at;
  }
  return onsets;
}

/** @returns {number} the largest absolute sample in [from, to). */
function peakIn(samples, from, to) {
  let peak = 0;
  const end = Math.min(samples.length, to);
  for (let at = Math.max(0, from); at < end; at += 1) {
    const value = Math.abs(samples[at]);
    if (value > peak) peak = value;
  }
  return peak;
}

/** @returns {string} SHA-256 over the left channel followed by the right one. */
function hashChannels(left, right) {
  const all = new Float32Array(left.length + right.length);
  all.set(left, 0);
  all.set(right, left.length);
  return createHash("sha256").update(Buffer.from(all.buffer, all.byteOffset, all.byteLength)).digest("hex");
}

/** @param {Float32Array} samples @param {string} label @returns {void} */
function assertSilent(samples, label) {
  for (let at = 0; at < samples.length; at += 1) {
    assert.equal(samples[at], 0, `${label}: frame ${at} is ${samples[at]}, not silence`);
  }
}

/** @param {number[]} onsets @param {number[]} expected @returns {void} */
function assertOnsets(onsets, expected) {
  assert.equal(onsets.length, expected.length, `expected clicks at [${expected}], got [${onsets}]`);
  for (let at = 0; at < expected.length; at += 1) {
    assert.ok(
      Math.abs(onsets[at] - expected[at]) <= 2,
      `click ${at + 1} starts at frame ${onsets[at]}, expected ${expected[at]} (±2)`,
    );
  }
}

test("the metronome is off by default: an empty song renders pure silence", async () => {
  const { left, right } = await renderEngine({ song: emptySong(), seconds: 2 });
  assertSilent(left, "left");
  assertSilent(right, "right");
});

test("with the metronome on, a click lands on every quarter note and the first beat of each engine bar is the accent", async () => {
  // 3 s at 120 bpm is six quarter notes: 0, 24000, 48000, 72000, 96000, 120000
  // frames (48000 * 60 / 120 = 24000 frames a beat). The fifth one starts the
  // second bar, so it is an accent again.
  const { left, right } = await renderEngine({ song: emptySong(), seconds: 3, metronome: true });
  const expected = [0, 24000, 48000, 72000, 96000, 120000];
  assertOnsets(onsetsOf(left), expected);
  assertOnsets(onsetsOf(right), expected);

  const peaks = expected.map((frame) => peakIn(left, frame, frame + 64));
  for (const frame of [0, 96000]) {
    const peak = peakIn(left, frame, frame + 64);
    assert.ok(peak > ACCENT_PEAK * 0.9, `the accent at frame ${frame} should peak near ${ACCENT_PEAK}, it peaked ${peak}`);
  }
  for (const frame of [24000, 48000, 72000, 120000]) {
    const peak = peakIn(left, frame, frame + 64);
    assert.ok(peak > PLAIN_PEAK * 0.9, `the click at frame ${frame} should peak near ${PLAIN_PEAK}, it peaked ${peak}`);
    assert.ok(peak < ACCENT_PEAK * 0.9, `the click at frame ${frame} is not an accent, it peaked ${peak}`);
  }
  assert.ok(peaks[0] > peaks[1], `the first beat has to be louder than the second (${peaks[0]} vs ${peaks[1]})`);
});

test("a tempo change moves the clicks with the sequencer's clock", async () => {
  // 90 bpm: 48000 * 60 / 90 = 32000 frames a beat. 2.5 s is four of them.
  const { left } = await renderEngine({ song: emptySong({ bpm: 90 }), seconds: 2.5, metronome: true });
  assertOnsets(onsetsOf(left), [0, 32000, 64000, 96000]);
});

test("a 3/4 song still clicks on quarter beats, accented every fourth one, because the engine's bars are four beats", async () => {
  // The engine ignores `meta.meter` (time-signature support in the engine is a
  // separate gap), so the click has to follow the four-beat bars the engine
  // really plays: clicks on 0, 24000, 48000, … with the accent on 0 and 96000.
  const { left } = await renderEngine({
    song: emptySong({ meter: [3, 4] }),
    seconds: 3,
    metronome: true,
  });
  const expected = [0, 24000, 48000, 72000, 96000, 120000];
  assertOnsets(onsetsOf(left), expected);
  for (const frame of [0, 96000]) {
    const peak = peakIn(left, frame, frame + 64);
    assert.ok(peak > ACCENT_PEAK * 0.9, `frame ${frame} starts an engine bar, so it is an accent, it peaked ${peak}`);
  }
  for (const frame of [24000, 48000, 72000, 120000]) {
    const peak = peakIn(left, frame, frame + 64);
    assert.ok(peak < ACCENT_PEAK * 0.9, `frame ${frame} is not a bar line, so it is no accent, it peaked ${peak}`);
  }
});

test("the master tap never contains the click", async () => {
  const { left, taps } = await renderEngine({ song: emptySong(), seconds: 2, metronome: true, tap: true });
  // The click IS in the output…
  assert.ok(onsetsOf(left).length >= 4, `the metronome has to be sounding to compare anything, onsets: ${onsetsOf(left)}`);
  // …and the master tap, taken BEFORE the click is added, holds silence.
  assert.ok(taps.length > 0, "the master tap delivered no blocks");
  for (const block of taps) {
    assert.equal(block.target, "master", "the tap names the master");
    for (const channel of block.channels) assertSilent(channel, `tap of ${block.channels.length} channels`);
  }
});

test("a render is click-free: server/render.js and an engine never told about the metronome render the same bytes", async () => {
  const song = oneNoteSong();
  const seconds = 2;

  // The project's real render path: `server/render.js` builds its own engine and
  // never sends `{type:"metronome"}`, so its render holds no click.
  const rendered = await renderThroughServer(song, { scene_id: "scene-1", seconds });
  const renderedHash = hashChannels(rendered.left, rendered.right);
  assert.ok(peakIn(rendered.left, 0, rendered.left.length) > 0.01, "the render has to be audible to compare anything");

  // The same song through the engine this test drives, with the metronome never
  // sent: bit-for-bit the same audio.
  const plain = await renderEngine({ song, seconds });
  assert.equal(
    hashChannels(plain.left, plain.right),
    renderedHash,
    `a render and an engine that was never told about the metronome differ over ${plain.left.length * 2} samples`,
  );

  // And the metronome really does reach the engine's output, so the comparison
  // above is not passing because `setMetronome` does nothing.
  const clicked = await renderEngine({ song, seconds, metronome: true });
  assert.notEqual(
    hashChannels(clicked.left, clicked.right),
    renderedHash,
    "the metronome has to change the engine's output, or this test proves nothing",
  );

  // The render path cannot ask for a click at all.
  const renderSource = readFileSync(fileURLToPath(new URL("../bundles/studio/server/render.js", import.meta.url)), "utf8");
  assert.ok(!/metronome/i.test(renderSource), "server/render.js must never reference the metronome");
});

test("turning the metronome off after turning it on leaves the output silent", async () => {
  const { left, right } = await renderEngine({ song: emptySong(), seconds: 2, off: true });
  assertSilent(left, "left");
  assertSilent(right, "right");
});

// --- the count-in -------------------------------------------------------------

/**
 * The count-in's own click grid, in frames: click `i` (0-based) sits at
 * `playFrame - (beats - i) * fpb`, and the song starts on `playFrame`.
 * @param {number} playFrame
 * @param {number} beats how many beats the count-in counts
 * @param {number} fpb frames per beat
 * @returns {number[]}
 */
function countInGrid(playFrame, beats, fpb) {
  const frames = [];
  for (let index = 0; index < beats; index += 1) frames.push(Math.round(playFrame - (beats - index) * fpb));
  return frames;
}

test("count_in: one bar of clicks on their own grid, with the metronome off, and the song on the announced frame", async () => {
  // At 120 bpm one beat is 24,000 frames and one bar is 96,000, which is 750
  // blocks of 128 — so the play frame is exactly four beats after the message.
  const fpb = 24000;
  const beats = 4;
  const playFrame = 4 * fpb;
  const expected = countInGrid(playFrame, beats, fpb);
  assert.deepEqual(expected, [0, 24000, 48000, 72000], "the count-in's grid, in frames");

  // The metronome is OFF: the count-in clicks anyway, and nothing follows them.
  const off = await renderEngine({ song: emptySong(), seconds: 3, countIn: 1 });
  assertOnsets(onsetsOf(off.left), expected);
  assertOnsets(onsetsOf(off.right), expected);

  // The first beat of the count-in bar is the accent, the others are plain.
  const accentPeak = peakIn(off.left, expected[0], expected[0] + 64);
  assert.ok(
    Math.abs(accentPeak - ACCENT_PEAK) < 0.01,
    `the first count-in click should peak near ${ACCENT_PEAK}, it peaked ${accentPeak}`,
  );
  for (const frame of expected.slice(1)) {
    const peak = peakIn(off.left, frame, frame + 64);
    assert.ok(Math.abs(peak - PLAIN_PEAK) < 0.01, `the click at ${frame} should peak near ${PLAIN_PEAK}, it peaked ${peak}`);
  }

  // Nothing follows the last count-in click: the song is empty and the metronome
  // is off, so the count-in is the whole sound.
  assert.equal(
    peakIn(off.left, expected[expected.length - 1] + 1300, off.left.length),
    0,
    "the count-in is the only sound, and it stops one beat before the song",
  );

  // The engine announced the frame the song starts on, before the first click.
  assert.ok(off.countIns.length > 0, "the count-in was announced");
  assert.equal(off.countIns[0].type, "count_in_start", "the start comes first");
  assert.equal(off.countIns[0].play_frame, playFrame, "and it names the frame the song starts on");

  // With the metronome ON, the beats after the count-in follow the toggle: the
  // song's own click is on the very same grid from its first downbeat on.
  const on = await renderEngine({ song: emptySong(), seconds: 3, countIn: 1, metronome: true });
  const withClicks = [...expected, 96000, 120000];
  assertOnsets(onsetsOf(on.left), withClicks);
  const downbeat = peakIn(on.left, 96000, 96000 + 64);
  assert.ok(
    Math.abs(downbeat - ACCENT_PEAK) < 0.01,
    `the song's first beat is an accent like any other bar line, it peaked ${downbeat}`,
  );
});

test("count_in: a master tap and the meter hold none of the click", async () => {
  const { left, taps, readings } = await renderEngine({
    song: emptySong(),
    seconds: 3,
    countIn: 1,
    metronome: true,
    tap: true,
    meter: true,
  });
  // The clicks have to be sounding, or the comparison proves nothing.
  assert.ok(onsetsOf(left).length >= 6, `the count-in and the click have to be heard, onsets: ${onsetsOf(left)}`);

  assert.ok(taps.length > 0, "the master tap delivered no blocks");
  for (const block of taps) {
    assert.equal(block.target, "master", "the tap names the master");
    for (const channel of block.channels) assertSilent(channel, `tap of ${block.channels.length} channels`);
  }

  // The meter only reads while the transport runs, so it can hold nothing of the
  // count-in at all — and after the song starts, an empty song is silence.
  for (const reading of readings) {
    assert.ok(
      !(reading.momentary > -70),
      `a momentary reading of ${reading.momentary} LUFS would carry click energy`,
    );
    assert.ok(
      !(reading.true_peak_db > -60),
      `a true peak of ${reading.true_peak_db} dBTP would carry click energy`,
    );
  }

  // A render never plays with a count-in: `server/render.js` cannot ask for one.
  const renderSource = readFileSync(fileURLToPath(new URL("../bundles/studio/server/render.js", import.meta.url)), "utf8");
  assert.ok(!/count_in|countInBars|cancelCountIn|onCountIn/.test(renderSource), "server/render.js must never ask for a count-in");
});

/**
 * The files a processor needs to exist at all: the hosts `studio-processor.js`
 * guards (the fonts, Faust, NAM, cabinets and the master meter) are left out, so
 * a song with no tracks needs none of them.
 */
const COUNT_IN_FILES = [
  "sequencer.js",
  "resample.js",
  "sampler-voice.js",
  "pad-events.js",
  "roll-clock.js",
  "perf-fx.js",
  "studio-processor.js",
];

/** The smallest valid wasm module: enough for the processor's own compile. */
const EMPTY_WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

/** The block this host hands the processor. */
const COUNT_IN_BLOCK = 128;

/** @returns {Promise<void>} a macrotask, so the compile's promise work settles */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 1));
}

/**
 * Wait for something the processor posts to arrive.
 * @param {() => boolean} predicate
 * @param {number} [ms]
 * @returns {Promise<boolean>} whether it happened in time
 */
async function waitFor(predicate, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!predicate() && Date.now() < deadline) await settle();
  return predicate();
}

/**
 * One Studio processor in a bare worklet-like scope, with the array constructors
 * it would allocate through replaced by counting subclasses — the way the level
 * core's own no-allocation case counts them. Every `Float32Array`, `Float64Array`
 * and `Array` the block path builds inside the evaluated module is counted; an
 * array LITERAL is the scope's own intrinsic array and is never counted (the
 * same limit the level core's case documents).
 * @returns {Promise<{send: Function, scope: object, processor: object, counts: object}>}
 */
async function countingProcessor() {
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
  let Processor = null;
  /** @type {any} */
  const scope = {
    console: { log() {}, warn() {}, error() {} },
    sampleRate: SAMPLE_RATE,
    currentFrame: 0,
    WebAssembly,
    Float32Array: CountingFloat32Array,
    Float64Array: CountingFloat64Array,
    Array: CountingArray,
    AudioWorkletProcessor: class {
      constructor() {
        this.port = {
          postMessage: (message) => scope.posts.push(message),
          onmessage: null,
          start() {},
        };
      }
    },
    registerProcessor: (_name, registered) => {
      Processor = registered;
    },
    posts: [],
  };
  vm.createContext(scope);
  const source = studioEngine.composeEngineModule(COUNT_IN_FILES.map((name) => ASSETS[name]));
  vm.runInContext(source, scope, { filename: "studio-engine.js" });
  assert.ok(Processor, "the module has to register the studio processor");
  const processor = new Processor({ processorOptions: { wasmBinary: EMPTY_WASM } });
  const ready = await waitFor(() => scope.posts.some((message) => message.type === "ready"));
  assert.ok(ready, `the processor has to come up and report ready, it posted ${JSON.stringify(scope.posts)}`);
  return {
    scope: scope,
    processor: processor,
    counts: counts,
    send: (message) => processor.port.onmessage({ data: message }),
  };
}

test("count_in: the count-in path creates no array or object per block", async () => {
  const counter = await countingProcessor();
  // The counters really are wired to the module's own constructors: building the
  // processor made some.
  assert.ok(
    counter.counts.Float64Array + counter.counts.Array > 0,
    "the counting constructors have to be the ones the processor builds through",
  );
  counter.send({ type: "song", snapshot: emptySong() });

  // One warm-up block: the mixer's scratch is sized once per block size, which
  // is the same one-off the level core's rings are.
  const output = [new Float32Array(COUNT_IN_BLOCK), new Float32Array(COUNT_IN_BLOCK)];
  counter.processor.process([], [output]);

  counter.send({ type: "play", count_in_bars: 1 });
  const start = counter.scope.posts.find((message) => message.type === "count_in_start");
  assert.ok(start, "the count-in was accepted");
  // One bar of count-in from the frame the warm-up left behind, on a block start.
  const playFrame = start.play_frame;
  assert.equal(playFrame, COUNT_IN_BLOCK + 4 * 24000, "one bar of count-in at 120 bpm, on a block's first frame");
  for (const name of Object.keys(counter.counts)) counter.counts[name] = 0;

  // A bar of count-in and a little of the song: 760 blocks of 128 frames.
  const blocks = 760;
  let frame = COUNT_IN_BLOCK;
  for (let index = 0; index < blocks; index += 1) {
    counter.scope.currentFrame = frame;
    counter.processor.process([], [output]);
    frame += COUNT_IN_BLOCK;
  }

  assert.deepEqual(
    { ...counter.counts },
    { Float32Array: 0, Float64Array: 0, Array: 0 },
    "the count-in's block path builds no array at all, per block or otherwise",
  );

  // The only messages the blocks posted are the count-in's own, one per click,
  // and the transport's position and meter posts: nothing is built per block.
  const posted = counter.scope.posts.filter((message) => message.type !== "ready");
  const countIn = posted.filter((message) => message.type.indexOf("count_in") === 0);
  assert.deepEqual(
    countIn.map((message) => message.type),
    ["count_in_start", "count_in", "count_in", "count_in", "count_in", "count_in_done"],
    "one start, four clicks and one done",
  );
  assert.deepEqual(countIn.slice(1, 5).map((message) => message.frame), countInGrid(playFrame, 4, 24000));
  const other = posted.filter((message) => ["position", "meter", "launched", "count_in_start", "count_in", "count_in_done"].indexOf(message.type) === -1);
  assert.deepEqual(other, [], "no other message is posted while a count-in runs");
});