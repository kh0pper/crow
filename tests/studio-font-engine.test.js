/**
 * Studio font engine tests — SoundFont tracks in the worklet.
 *
 * A soundfont track's device is `{engine: "soundfont", font_id, bank, program}`
 * (plan 1d, Task 1): the instrument is a library font plus a preset inside it.
 * This file pins how the ENGINE plays one (plan 1d, Task 3):
 *
 *   - a soundfont track plays the program its device names, and bank 128 is the
 *     GM drum bank (`setDrums`, never channel 9);
 *   - one bank parsed once, one MIDI channel per track, each track's own stereo
 *     pair through the very same gain/pan/mute/solo path (so eight tracks on one
 *     bank mix separately);
 *   - a program set while the song plays takes effect at the next block's first
 *     frame;
 *   - a font this device does not have is silent, and the engine says so once
 *     (`library_needed`) so the page can offer the download;
 *   - a bank that arrives while the transport runs waits for Stop
 *     (`library_deferred`), and is parsed then;
 *   - a bank that will not parse is silent and reported once;
 *   - a dense soundfont song renders faster than real time in Node.
 *
 * Two hosts are used, both of them the real engine:
 *
 *   - **full renders** through node-web-audio-api's `OfflineAudioContext`, the
 *     way an MCP render runs the engine (the bank is handed over with
 *     `loadLibrary`, exactly as `server/render.js` will from Task 5);
 *   - a **stand-in worklet scope**: `studio-processor.js` composed exactly as
 *     `engine-client.js` composes it, evaluated in this thread with the worklet
 *     globals it reads, so a test can post a message between two blocks — which
 *     is the only way to observe "the next block's first frame" honestly.
 *
 * The bank is built in the test (`tests/fixtures/tiny-sf2.mjs`): nothing is
 * downloaded, and every preset is a seamless sine loop, so one channel's tone
 * can be told from another's by frequency.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TINY_SF2_PRESETS, tinySf2 } from "./fixtures/tiny-sf2.mjs";

const ENGINE_DIR = fileURLToPath(new URL("../bundles/studio/engine/", import.meta.url));
const VENDOR_DIR = fileURLToPath(new URL("../bundles/studio/vendor/sunvox/", import.meta.url));
const SPESSA_DIR = fileURLToPath(new URL("../bundles/studio/vendor/spessasynth/", import.meta.url));
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

const SAMPLE_RATE = 48000;
const BLOCK = 128;

/** The bank every test in this file plays, built once. */
const FONT_BYTES = tinySf2();
const FONT_ID = "font-tiny";

/** The tone one preset of `TINY_SF2_PRESETS` plays. */
function toneOf(bank, program) {
  const preset = TINY_SF2_PRESETS.find((item) => item.bank === bank && item.program === program);
  assert.ok(preset, `the test font has no preset ${bank}:${program}`);
  return preset.freq;
}

/** The engine sources, read from the bundle exactly as a Node caller would. */
const ASSETS = {
  "sequencer.js": readFileSync(join(ENGINE_DIR, "sequencer.js"), "utf8"),
  "resample.js": readFileSync(join(ENGINE_DIR, "resample.js"), "utf8"),
  "sampler-voice.js": readFileSync(join(ENGINE_DIR, "sampler-voice.js"), "utf8"),
  "perf-fx.js": readFileSync(join(ENGINE_DIR, "perf-fx.js"), "utf8"),
  "sunvox.js": readFileSync(join(VENDOR_DIR, "sunvox.js"), "utf8"),
  "spessasynth.js": readFileSync(join(SPESSA_DIR, "spessasynth.js"), "utf8"),
  "font-voice.js": readFileSync(join(ENGINE_DIR, "font-voice.js"), "utf8"),
  "studio-processor.js": readFileSync(join(ENGINE_DIR, "studio-processor.js"), "utf8"),
  "sunvox.wasm": readFileSync(join(VENDOR_DIR, "sunvox.wasm")),
};

/**
 * One soundfont track.
 * @param {number} index 0-based, for the id and the program
 * @param {object} [overrides]
 * @returns {object}
 */
function fontTrack(index, overrides = {}) {
  return {
    id: `track-${index + 1}`,
    name: `Track ${index + 1}`,
    color: "#E8C07A",
    device: { engine: "soundfont", font_id: FONT_ID, bank: 0, program: index },
    mute: false,
    solo: false,
    gain_db: 0,
    pan: 0,
    locked: false,
    ...overrides,
  };
}

/**
 * A song of soundfont tracks, each with one clip of notes.
 * @param {object[]} tracks
 * @param {{bpm?: number, notes?: object[], length_bars?: number}} [options]
 * @returns {object}
 */
function fontSong(tracks, { bpm = 125, notes = [{ t: 0, d: 4, p: 60, v: 100 }], length_bars = 1 } = {}) {
  const clips = {};
  tracks.forEach((track, index) => {
    clips[`clip-${index + 1}`] = {
      id: `clip-${index + 1}`,
      track_id: track.id,
      scene_id: "scene-1",
      name: track.name,
      length_bars: length_bars,
      notes: notes,
    };
  });
  return {
    meta: { title: "Font test", bpm: bpm, meter: [4, 4], key: "C major" },
    tracks: tracks,
    scenes: [{ id: "scene-1", name: "A" }],
    clips: clips,
    library: {
      [FONT_ID]: {
        id: FONT_ID,
        kind: "font",
        name: "Tiny Test Font",
        source: "upload",
        sha256: "",
        bytes: FONT_BYTES.byteLength,
        licence: "test",
        credit: "",
        author_label: "",
      },
    },
  };
}

/**
 * The amplitude of one frequency in a window of samples: a Hann-windowed
 * single-bin DFT, scaled so a pure tone of amplitude A reads back A.
 * @param {Float32Array} samples
 * @param {number} from the first frame of the window
 * @param {number} count the frames in it
 * @param {number} freq Hz
 * @param {number} [rate]
 * @returns {number}
 */
function toneAmplitude(samples, from, count, freq, rate = SAMPLE_RATE) {
  let real = 0;
  let imaginary = 0;
  let windowSum = 0;
  for (let frame = 0; frame < count; frame += 1) {
    const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * frame) / (count - 1));
    const phase = (2 * Math.PI * freq * frame) / rate;
    const value = samples[from + frame] * window;
    real += value * Math.cos(phase);
    imaginary -= value * Math.sin(phase);
    windowSum += window;
  }
  return (2 * Math.hypot(real, imaginary)) / windowSum;
}

/**
 * Assert that one window plays one tone and not another: the wanted frequency is
 * there at level, and the unwanted one is far below it.
 * @param {Float32Array} samples
 * @param {number} from
 * @param {number} count
 * @param {number} wanted Hz
 * @param {number} [unwanted] Hz
 * @param {string} [what] what to say when it fails
 * @param {number} [minimum] the level a present tone has to reach
 * @returns {void}
 */
function assertTone(samples, from, count, wanted, unwanted, what = "", minimum = 0.01) {
  const level = toneAmplitude(samples, from, count, wanted);
  assert.ok(level > minimum, `${what}: expected the ${wanted} Hz tone to sound, it reads ${level.toFixed(4)}`);
  if (unwanted !== undefined) {
    const other = toneAmplitude(samples, from, count, unwanted);
    assert.ok(
      other < level / 10,
      `${what}: expected ${wanted} Hz and not ${unwanted} Hz, they read ${level.toFixed(4)} and ${other.toFixed(4)}`,
    );
  }
}

/** @param {Float32Array} samples @returns {number} the largest absolute sample. */
function peakOf(samples) {
  let peak = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.abs(samples[index]);
    if (value > peak) peak = value;
  }
  return peak;
}

/** @returns {number} `count` frames' of a song at a tempo, in frames. */
function framesPerBeat(bpm) {
  return Math.round((SAMPLE_RATE * 60) / bpm);
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
 * Render one song offline in Node, the way the MCP renderer will: build the
 * engine, hand it the fonts its tracks name, hand it the song, launch the scene,
 * play, render.
 * @param {object} song
 * @param {{seconds?: number, sampleRate?: number, fonts?: object[],
 *          needListener?: function(string): void}} [options]
 *   `fonts` is one `{id, bytes}` per bank to load before the song; `needListener`
 *   follows the engine's `library_needed`
 * @returns {Promise<{left: Float32Array, right: Float32Array, sampleRate: number}>}
 */
async function renderSong(song, { seconds = 2, sampleRate = SAMPLE_RATE, fonts = [], needListener = null } = {}) {
  const context = new OfflineAudioContext({
    numberOfChannels: 2,
    length: Math.round(seconds * sampleRate),
    sampleRate,
  });
  let engine = null;
  let rendered = false;
  try {
    engine = await studioEngine.create(context, { assetBytes: ASSETS });
    if (needListener) engine.onLibraryNeeded(needListener);
    for (const font of fonts) {
      // A fresh copy per render: loadLibrary transfers the bytes.
      await engine.loadLibrary(font.id, "font", Uint8Array.from(font.bytes));
    }
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
    return { left: left, right: right, sampleRate: sampleRate };
  } finally {
    if (engine) engine.dispose();
    if (!rendered) await releaseWorklet(context);
  }
}

// --- the processor in a stand-in worklet scope ------------------------------

/** The smallest valid wasm module: enough for the processor's own compile. */
const EMPTY_WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

/** @returns {object} the engine client's classic script, as a Node module. */
function engineClientApi() {
  return bundleRequire(join(ENGINE_DIR, "engine-client.js"));
}

/** The composed module, evaluated once per process: it carries a 2 MB synth. */
let PROCESSOR_CLASS = null;

/**
 * Compose the worklet module exactly as `engine-client.js` does and evaluate it
 * with stand-in worklet globals, handing back the processor class it registered.
 * @returns {{name: string, cls: Function}}
 */
function processorClass() {
  if (PROCESSOR_CLASS) return PROCESSOR_CLASS;
  const texts = engineClientApi().SOURCE_FILES.map((name) => ASSETS[name]);
  const source = engineClientApi().composeEngineModule(texts);
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
  PROCESSOR_CLASS = registered;
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
async function waitFor(predicate, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!predicate() && Date.now() < deadline) await settle();
  return predicate();
}

/**
 * One processor running the real worklet code, with helpers to post messages
 * between blocks and to render them by hand.
 * @param {{maxFontBytes?: number}} [options]
 * @returns {Promise<{processor: object, posts: object[], post: Function,
 *                    flush: Function, run: Function}>}
 */
async function processorHost(options = {}) {
  const loaded = processorClass();
  const posts = [];
  const processor = new loaded.cls({
    processorOptions: {
      wasmBinary: EMPTY_WASM,
      ...(options.maxFontBytes > 0 ? { maxFontBytes: options.maxFontBytes } : {}),
    },
  });
  processor.port.postMessage = (message) => posts.push(message);
  await settle();
  const ready = await waitFor(() => posts.some((message) => message.type === "ready"));
  assert.ok(ready, `the processor has to come up and report ready, it posted ${JSON.stringify(posts)}`);

  /** @param {object} message @returns {void} */
  const post = (message) => {
    processor.port.onmessage({ data: message });
  };

  let flushSeq = 0;
  /** @returns {Promise<void>} resolves once the processor applied everything posted before it. */
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
    /** @returns {number} how many blocks this host has rendered. */
    get blocks() {
      return rendered;
    },
  };
}

/** @param {object[]} posts @param {string} type @returns {object[]} */
function postsOfType(posts, type) {
  return posts.filter((message) => message.type === type);
}

test("a program set while playing takes effect at the next block", async () => {
  // 125 bpm at 48 kHz is exactly 180 blocks a beat, so a note placed on beat 1
  // starts on a block's first frame and "the next block" is a fact, not a guess.
  const host = await processorHost();
  const song = fontSong([fontTrack(0)], {
    bpm: 125,
    notes: [
      { t: 0, d: 1, p: 60, v: 100 },
      { t: 1, d: 1, p: 60, v: 100 },
    ],
  });
  const beatFrames = framesPerBeat(125);
  assert.equal(beatFrames / BLOCK, 180, "a beat has to be a whole number of blocks");

  host.post({ type: "song", snapshot: song });
  host.post({ type: "library", library_id: FONT_ID, kind: "font", bytes: Uint8Array.from(FONT_BYTES) });
  host.post({ type: "launchScene", id: "scene-1" });
  host.post({ type: "play" });
  await host.flush();

  const first = host.run(beatFrames / BLOCK);
  // The first beat is program 0's tone.
  assertTone(first.left, BLOCK, beatFrames - BLOCK, toneOf(0, 0), toneOf(0, 1), "the first beat");

  // The program changes between two blocks, while the transport runs: the very
  // next block's first frame is where the new preset has to be in force, and
  // that block is where the second note starts.
  host.post({ type: "song", snapshot: fontSong([fontTrack(0, { device: { engine: "soundfont", font_id: FONT_ID, bank: 0, program: 1 } })], {
    bpm: 125,
    notes: [
      { t: 0, d: 1, p: 60, v: 100 },
      { t: 1, d: 1, p: 60, v: 100 },
    ],
  }) });
  await host.flush();

  const second = host.run(16);
  // The window starts ON the frame the new note sounds: had the program change
  // slipped one block later, the old tone would be in here too.
  assertTone(second.left, 0, 2048, toneOf(0, 1), toneOf(0, 0), "the beat after the change");
});

test("a font requested while playing loads when you stop", async () => {
  const host = await processorHost();
  const song = fontSong([fontTrack(0)], { bpm: 125 });
  host.post({ type: "song", snapshot: song });
  host.post({ type: "launchScene", id: "scene-1" });
  host.post({ type: "play" });
  await host.flush();

  // No bank on this device: the track is silent and the engine asks for it once.
  const silent = host.run(4);
  assert.ok(peakOf(silent.left) < 1e-9, `a track whose font is missing has to be silent, peak was ${peakOf(silent.left)}`);
  assert.equal(
    postsOfType(host.posts, "library_needed").filter((message) => message.library_id === FONT_ID).length,
    1,
    `expected one library_needed for ${FONT_ID}, got ${JSON.stringify(postsOfType(host.posts, "library_needed"))}`,
  );

  // The same font posted while the song plays waits for Stop.
  host.post({ type: "library", library_id: FONT_ID, kind: "font", bytes: Uint8Array.from(FONT_BYTES) });
  await host.flush();
  assert.equal(postsOfType(host.posts, "library_deferred").length, 1, "a load while playing has to be deferred");
  assert.equal(postsOfType(host.posts, "library_loaded").length, 0, "a deferred load must not parse yet");
  const stillSilent = host.run(4);
  assert.ok(peakOf(stillSilent.left) < 1e-9, "a deferred font must not sound before Stop");

  // Stop parses it, and the next Play plays it.
  host.post({ type: "stop" });
  await host.flush();
  assert.equal(
    postsOfType(host.posts, "library_loaded").filter((message) => message.library_id === FONT_ID && message.ok).length,
    1,
    "Stop has to parse the font that waited",
  );

  host.post({ type: "play" });
  await host.flush();
  const playing = host.run(16);
  assertTone(playing.left, 0, 2048, toneOf(0, 0), undefined, "the font that waited for Stop");
  assert.equal(postsOfType(host.posts, "library_needed").length, 1, "a font that arrived is not asked for again");
});

test("a font that fails to parse is silent and reported once", async () => {
  const host = await processorHost();
  const song = fontSong([fontTrack(0)], { bpm: 125 });
  host.post({ type: "song", snapshot: song });
  const garbage = new TextEncoder().encode("RIFF0000not a bank at all");
  host.post({ type: "library", library_id: "font-broken", kind: "font", bytes: garbage });
  // The song names a different font id, so point one track at the broken one.
  host.post({ type: "song", snapshot: fontSong([fontTrack(0, { device: { engine: "soundfont", font_id: "font-broken", bank: 0, program: 0 } })], { bpm: 125 }) });
  host.post({ type: "launchScene", id: "scene-1" });
  host.post({ type: "play" });
  await host.flush();

  const failed = postsOfType(host.posts, "library_failed");
  assert.equal(failed.length, 1, `expected one library_failed, got ${JSON.stringify(failed)}`);
  assert.equal(failed[0].library_id, "font-broken");
  assert.ok(String(failed[0].reason).length > 0, "the report has to say why");

  const silent = host.run(16);
  assert.ok(peakOf(silent.left) < 1e-9, `a broken bank has to play silence, peak was ${peakOf(silent.left)}`);

  // Asking again changes nothing: one report per font id, and no throw.
  host.post({ type: "library", library_id: "font-broken", kind: "font", bytes: garbage });
  await host.flush();
  assert.equal(postsOfType(host.posts, "library_failed").length, 1, "a second load of a broken bank must not report again");
  const stillSilent = host.run(4);
  assert.ok(peakOf(stillSilent.left) < 1e-9, "the failed font stays silent");
});

test("eight tracks on one bank load it once and mix separately", async () => {
  // (1) The host's own contract: ONE parsed bank, one MIDI channel per track in
  // snapshot order, and a stereo pair per track that holds that track and not
  // its neighbours. `process()` is the documented interface, so it is used here
  // exactly as the processor uses it.
  processorClass();
  const host = globalThis.StudioFontVoice.create(SAMPLE_RATE);
  await host.load(FONT_ID, Uint8Array.from(FONT_BYTES));
  const specs = [];
  for (let index = 0; index < 8; index += 1) {
    specs.push({ track_id: `track-${index + 1}`, font_id: FONT_ID, bank: 0, program: index });
  }
  host.assign(specs);
  for (let index = 0; index < 8; index += 1) {
    assert.equal(host.channelFor(`track-${index + 1}`), index, `track ${index + 1} has to hold channel ${index}`);
    host.noteOn(`track-${index + 1}`, 60, 100);
  }
  assert.equal(host.fontCount, 1, "eight tracks on one font have to parse it once");
  assert.deepEqual(host.loadedIds(), [FONT_ID]);
  const outputs = host.process(8192);
  for (let index = 0; index < 8; index += 1) {
    const pair = outputs.get(`track-${index + 1}`);
    assert.ok(pair && pair.left.length >= 8192, `track ${index + 1} has to have a stereo pair of its own`);
    const own = toneAmplitude(pair.left, 0, 8192, toneOf(0, index));
    assert.ok(own > 0.01, `track ${index + 1} has to play its own program ${index}, it reads ${own}`);
    // Every other program of the same bank is NOT in this track's pair: the
    // channels are separate, so nothing of one track leaks into another.
    for (let other = 0; other < 8; other += 1) {
      if (other === index) continue;
      const leak = toneAmplitude(pair.left, 0, 8192, toneOf(0, other));
      assert.ok(
        leak < own / 20,
        `track ${index + 1} must hold program ${index} and not program ${other}, they read ${own} and ${leak}`,
      );
    }
    // Mono samples come out of the synth on both sides of the channel.
    assert.equal(pair.right.length, pair.left.length);
  }

  // (2) The same eight tracks through the processor: one bank, eight channels, a
  // tone each, all at one level, and a mute that reaches only its own track.
  const tracks = [];
  for (let index = 0; index < 8; index += 1) {
    // −12 dB each, so eight tones of this bank sum well under full scale (none
    // of them is clipped) and each still reads at level on its own.
    tracks.push(fontTrack(index, { gain_db: -12 }));
  }
  const run = await processorHost();
  run.post({ type: "song", snapshot: fontSong(tracks, { bpm: 125 }) });
  run.post({ type: "library", library_id: FONT_ID, kind: "font", bytes: Uint8Array.from(FONT_BYTES) });
  run.post({ type: "launchScene", id: "scene-1" });
  run.post({ type: "play" });
  await run.flush();

  assert.equal(run.processor.fonts.fontCount, 1, "eight tracks on one font have to parse it once");
  assert.deepEqual(run.processor.fonts.loadedIds(), [FONT_ID]);
  for (let index = 0; index < 8; index += 1) {
    assert.equal(
      run.processor.fonts.channelFor(`track-${index + 1}`),
      index,
      `track ${index + 1} has to hold channel ${index}, the channels go in snapshot order`,
    );
  }

  const mixed = run.run(64);
  const levels = [];
  for (let index = 0; index < 8; index += 1) {
    const level = toneAmplitude(mixed.left, 0, 8192, toneOf(0, index));
    assert.ok(level > 0.004, `program ${index} has to be in the mix, it reads ${level}`);
    levels.push(level);
  }
  for (const level of levels) {
    assert.ok(
      Math.abs(level - levels[0]) < levels[0] / 50,
      `all eight tracks stand at one level, they read ${levels.map((value) => value.toFixed(5)).join(", ")}`,
    );
  }

  // Muting ONE track takes that one out and leaves the other seven exactly as
  // they were: each track's audio is its own channel, through its own fader.
  const muted = tracks.map((track, index) => (index === 7 ? { ...track, mute: true } : track));
  run.post({ type: "song", snapshot: fontSong(muted, { bpm: 125 }) });
  await run.flush();
  const afterMute = run.run(64);
  const mutedLevel = toneAmplitude(afterMute.left, 0, 8192, toneOf(0, 7));
  assert.ok(
    mutedLevel < levels[7] / 1000,
    `the muted track has to be gone (60 dB down), its tone reads ${mutedLevel} against ${levels[7]}`,
  );
  for (let index = 0; index < 7; index += 1) {
    const now = toneAmplitude(afterMute.left, 0, 8192, toneOf(0, index));
    assert.ok(
      Math.abs(now - levels[index]) < levels[index] / 100,
      `track ${index + 1} has to be untouched by the mute, it went from ${levels[index]} to ${now}`,
    );
  }
});

test("a font the memory cap pushes out is asked for again", async () => {
  // One bank's worth of room: loading a second font has to push the first one
  // out, and the track that plays it has to ask for it again.
  const host = await processorHost({ maxFontBytes: FONT_BYTES.byteLength });
  const tracks = [
    fontTrack(0, { device: { engine: "soundfont", font_id: "font-first", bank: 0, program: 0 } }),
    fontTrack(1, { device: { engine: "soundfont", font_id: "font-second", bank: 0, program: 1 } }),
  ];
  host.post({ type: "song", snapshot: fontSong(tracks, { bpm: 125 }) });
  host.post({ type: "library", library_id: "font-first", kind: "font", bytes: Uint8Array.from(FONT_BYTES) });
  await host.flush();
  host.post({ type: "library", library_id: "font-second", kind: "font", bytes: Uint8Array.from(FONT_BYTES) });
  host.post({ type: "launchScene", id: "scene-1" });
  host.post({ type: "play" });
  await host.flush();

  assert.equal(host.processor.fonts.fontCount, 1, "only one bank fits under the cap");
  assert.deepEqual(host.processor.fonts.loadedIds(), ["font-second"], "the font that arrived last is the one held");
  const asked = postsOfType(host.posts, "library_needed").map((message) => message.library_id);
  assert.ok(asked.includes("font-first"), `the evicted font has to be asked for again, got ${JSON.stringify(asked)}`);

  // The track whose font stayed plays; the one the cap pushed out is silent.
  const out = host.run(32);
  const kept = toneAmplitude(out.left, 0, 4096, toneOf(0, 1));
  const gone = toneAmplitude(out.left, 0, 4096, toneOf(0, 0));
  assert.ok(kept > 0.01, `the font that is still loaded has to play its track, it reads ${kept}`);
  assert.ok(
    gone < kept / 20,
    `the evicted font's track has to be silent until it is loaded again, it reads ${gone} against ${kept}`,
  );
});

// --- full renders through node-web-audio-api --------------------------------

test("a soundfont track plays its program", async () => {
  const melodic = await renderSong(fontSong([fontTrack(0)]), { seconds: 1, fonts: [{ id: FONT_ID, bytes: FONT_BYTES }] });
  assert.ok(peakOf(melodic.left) > 0.01, `a soundfont track has to sound, peak was ${peakOf(melodic.left)}`);
  assertTone(melodic.left, 2048, 8192, toneOf(0, 0), toneOf(0, 1), "bank 0 program 0");

  // Another program of the same bank is another instrument.
  const other = fontSong([fontTrack(0, { device: { engine: "soundfont", font_id: FONT_ID, bank: 0, program: 1 } })]);
  const played = await renderSong(other, { seconds: 1, fonts: [{ id: FONT_ID, bytes: FONT_BYTES }] });
  assertTone(played.left, 2048, 8192, toneOf(0, 1), toneOf(0, 0), "bank 0 program 1");

  // Bank 128 is the GM drum bank: the engine sets drums on that track's own
  // channel, so the drum preset is what sounds — not bank 0's program 0.
  const drums = fontSong([fontTrack(0, { device: { engine: "soundfont", font_id: FONT_ID, bank: 128, program: 0 } })]);
  const drummed = await renderSong(drums, { seconds: 1, fonts: [{ id: FONT_ID, bytes: FONT_BYTES }] });
  assertTone(drummed.left, 2048, 8192, toneOf(128, 0), toneOf(0, 0), "bank 128 program 0 (the drums)");

  // The synth's own effects stay out of the mix: a note that stops leaves
  // silence behind it, not the bank's reverb tail (a channel's reverb send is on
  // by default, so an enabled synth would be audible here).
  const short = fontSong([fontTrack(0)], { notes: [{ t: 0, d: 0.25, p: 60, v: 100 }] });
  const after = await renderSong(short, { seconds: 1, fonts: [{ id: FONT_ID, bytes: FONT_BYTES }] });
  const noteFrames = Math.round(framesPerBeat(125) * 0.25);
  assert.ok(peakOf(after.left) > 0.01, `the short note has to sound first, peak was ${peakOf(after.left)}`);
  let tail = 0;
  for (let frame = noteFrames + SAMPLE_RATE * 0.1; frame < after.left.length; frame += 1) {
    const value = Math.abs(after.left[frame]);
    if (value > tail) tail = value;
  }
  assert.ok(tail < 1e-6, `the synth's own effects have to stay out of the mix, the tail peaks at ${tail}`);
});

test("a font not on this device is silent and offers the download", async () => {
  const needed = [];
  const song = fontSong([fontTrack(0)]);
  const render = await renderSong(song, { seconds: 0.5, needListener: (id) => needed.push(id) });
  assert.ok(
    peakOf(render.left) < 1e-9 && peakOf(render.right) < 1e-9,
    `a track whose bank is not on this device has to be silent, peak was ${peakOf(render.left)}`,
  );
  assert.deepEqual(needed, [FONT_ID], "the engine has to say which font it is missing, once");

  // The very same song, with the bank handed over, plays: the silence was the
  // missing file and nothing else.
  const loaded = await renderSong(song, { seconds: 0.5, fonts: [{ id: FONT_ID, bytes: FONT_BYTES }] });
  assert.ok(peakOf(loaded.left) > 0.01, `the same song with its font loaded has to sound, peak was ${peakOf(loaded.left)}`);
});

test("a dense soundfont song renders faster than real time in Node", async () => {
  const SECONDS = 30;
  // Eight soundfont tracks on ONE bank, a four-note chord every beat: 32 voices
  // at once through one parsed bank and its eight channels.
  const tracks = [];
  for (let index = 0; index < 8; index += 1) tracks.push(fontTrack(index, { gain_db: -20 }));
  const chords = [];
  for (let beat = 0; beat < 60; beat += 1) {
    for (const pitch of [48, 55, 60, 64]) chords.push({ t: beat, d: 1, p: pitch, v: 90 });
  }
  const song = fontSong(tracks, { bpm: 120, notes: chords, length_bars: 16 });

  const context = new OfflineAudioContext({
    numberOfChannels: 2,
    length: Math.round(SECONDS * SAMPLE_RATE),
    sampleRate: SAMPLE_RATE,
  });
  let engine = null;
  let rendered = false;
  try {
    engine = await studioEngine.create(context, { assetBytes: ASSETS });
    await engine.loadLibrary(FONT_ID, "font", Uint8Array.from(FONT_BYTES));
    engine.setSong(song);
    engine.launchScene("scene-1");
    engine.play();
    engine.node.connect(context.destination);
    await engine.flush();

    // Only the render is timed: parsing the bank and building the song are the
    // page's work, not the DSP's.
    const started = performance.now();
    const buffer = await context.startRendering();
    const elapsed = performance.now() - started;
    rendered = true;
    const left = new Float32Array(buffer.length);
    buffer.copyFromChannel(left, 0);
    assert.ok(peakOf(left) > 0.01, `the dense song has to be audible, peak was ${peakOf(left)}`);
    assert.ok(
      elapsed < SECONDS * 1000,
      `a ${SECONDS} s dense soundfont song has to render faster than real time, took ${Math.round(elapsed)} ms`,
    );
  } finally {
    if (engine) engine.dispose();
    if (!rendered) await releaseWorklet(context);
  }
});