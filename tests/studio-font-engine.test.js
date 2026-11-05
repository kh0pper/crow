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
 *     frame, and it RELEASES the notes it replaces instead of cutting them;
 *   - a font this device does not have is silent, and the engine says so once
 *     (`library_needed`) so the page can offer the download;
 *   - a bank that arrives while the transport runs waits for Stop
 *     (`library_deferred`), and so does a bank whose queued job finds the
 *     playhead running;
 *   - a bank that will not parse, one with no instruments, and one the song's own
 *     fonts leave no room for are silent and reported once (`library_failed`);
 *   - every font load is answered for its own request id, and unloading a font
 *     cancels a load of it that has not been parsed yet;
 *   - a cap on the fonts counts the files AND their decoded samples, evicts only
 *     fonts no track of the song plays, and decodes every sample at load so the
 *     audio thread never decodes;
 *   - the synth's own effects never reach a track (the host reads the channel's
 *     dry pair, never the synth's main pair);
 *   - with no font host at all (a module composed without `font-voice.js`) every
 *     soundfont track's font is still reported, once per id;
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
import { TINY_SF2_DECODED_BYTES, TINY_SF2_PRESETS, tinySf2 } from "./fixtures/tiny-sf2.mjs";
import { TINY_SF3_DECODED_BYTES, TINY_SF3_DECODED_SAMPLES, TINY_SF3_SAMPLE_RATE, tinySf3 } from "./fixtures/tiny-sf3.mjs";

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

/** A real SF3 bank (Ogg Vorbis samples), built once from the committed fixture. */
const SF3_BYTES = tinySf3();
const SF3_ID = "font-sf3";

/** What one font counts against the cap: its file's bytes plus its decoded samples. */
const FONT_FOOTPRINT = FONT_BYTES.byteLength + TINY_SF2_DECODED_BYTES;

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
 * The files of a module built WITHOUT the SoundFont host (and the synth it
 * needs): every soundfont track in such an engine goes through `NO_FONTS`.
 * @type {ReadonlyArray<string>}
 */
const NO_FONT_FILES = Object.freeze([
  "sequencer.js",
  "resample.js",
  "sampler-voice.js",
  "perf-fx.js",
  "studio-processor.js",
]);

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

/** @param {Float32Array} samples @returns {number} the mean sample (DC offset). */
function meanOf(samples) {
  let total = 0;
  for (let index = 0; index < samples.length; index += 1) total += samples[index];
  return total / samples.length;
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
      const result = await engine.loadLibrary(font.id, "font", Uint8Array.from(font.bytes));
      assert.equal(
        result.status,
        "loaded",
        `the bank a render needs has to load, it came back ${JSON.stringify(result)}`,
      );
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

/** The composed modules, evaluated once per process: each carries a 2 MB synth. */
const PROCESSOR_CLASSES = new Map();

/**
 * Compose the worklet module exactly as `engine-client.js` does and evaluate it
 * with stand-in worklet globals, handing back the processor class it registered.
 * @param {boolean} [withoutFontHost] compose it WITHOUT the SoundFont host and
 *   the vendored synth (the engine's `NO_FONTS` path)
 * @returns {{name: string, cls: Function}}
 */
function processorClass(withoutFontHost = false) {
  const cached = PROCESSOR_CLASSES.get(withoutFontHost);
  if (cached) return cached;
  const names = withoutFontHost ? NO_FONT_FILES : engineClientApi().SOURCE_FILES;
  const texts = names.map((name) => ASSETS[name]);
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
  PROCESSOR_CLASSES.set(withoutFontHost, registered);
  return registered;
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
 * @param {{maxFontBytes?: number, withoutFontHost?: boolean}} [options]
 * @returns {Promise<{processor: object, posts: object[], post: Function,
 *                    flush: Function, run: Function}>}
 */
async function processorHost(options = {}) {
  const loaded = processorClass(options.withoutFontHost === true);
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

/** @param {object[]} posts @param {string} type @param {unknown} requestId @returns {object[]} */
function answersTo(posts, requestId) {
  return posts.filter(
    (message) => (message.type === "library_loaded" || message.type === "library_deferred") && message.request_id === requestId,
  );
}

/**
 * A font host of its own (no processor around it), loaded with the test bank.
 * @param {{maxBytes?: number}} [options]
 * @returns {Promise<object>} the host
 */
async function loadedHost(options = {}) {
  processorClass();
  const host = globalThis.StudioFontVoice.create(SAMPLE_RATE, options);
  await host.load(FONT_ID, Uint8Array.from(FONT_BYTES));
  return host;
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
  host.post({ type: "library", request_id: 1, library_id: FONT_ID, kind: "font", bytes: Uint8Array.from(FONT_BYTES) });
  // The load is parsed while the transport is stopped, exactly as a page (or a
  // render) waits for it before pressing Play.
  await host.flush();
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

test("a program change releases held notes instead of cutting them", async () => {
  // The long preset (program 8) has a four-second release. A program change on
  // the channel a held note is ringing on has to send that note a note-off: the
  // release then plays out. `stopAllNotes(true)` — cutting it — would leave the
  // next block silent, which is exactly what this test refuses.
  const host = await processorHost();
  const notes = [{ t: 0, d: 8, p: 60, v: 100 }];
  const longRelease = (program) =>
    fontSong([fontTrack(0, { device: { engine: "soundfont", font_id: FONT_ID, bank: 0, program: program } })], {
      bpm: 125,
      notes: notes,
    });

  host.post({ type: "song", snapshot: longRelease(8) });
  host.post({ type: "library", request_id: 1, library_id: FONT_ID, kind: "font", bytes: Uint8Array.from(FONT_BYTES) });
  await host.flush();
  host.post({ type: "launchScene", id: "scene-1" });
  host.post({ type: "play" });
  await host.flush();

  const held = host.run(16);
  assertTone(held.left, 0, 2048, toneOf(0, 8), undefined, "the held note before the change");

  // The program changes while the note is held: the note is released, so the
  // block right after the change still carries its tail.
  host.post({ type: "song", snapshot: longRelease(0) });
  await host.flush();

  const after = host.run(384);
  const early = peakOf(after.left.subarray(0, 2048));
  assert.ok(
    early > 0.01,
    `the released note has to keep sounding after the program change, peak was ${early}`,
  );
  // ... and it decays: a second later it is well down, and still not cut (a cut
  // would be exactly zero on the very first frame).
  const late = peakOf(after.left.subarray(after.left.length - 2048));
  assert.ok(late < early / 2, `the released tail has to decay, it went from ${early} to ${late}`);
  assert.ok(late > 0, "a four-second release is still sounding a second later");
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
  host.post({ type: "library", request_id: "while-playing", library_id: FONT_ID, kind: "font", bytes: Uint8Array.from(FONT_BYTES) });
  await host.flush();
  assert.equal(postsOfType(host.posts, "library_deferred").length, 1, "a load while playing has to be deferred");
  assert.equal(postsOfType(host.posts, "library_loaded").length, 0, "a deferred load must not parse yet");
  assert.deepEqual(answersTo(host.posts, "while-playing"), [
    { type: "library_deferred", library_id: FONT_ID, request_id: "while-playing" },
  ]);
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

test("a font queued before play is not parsed while playing", async () => {
  // The load is posted while the transport is stopped, so it goes straight onto
  // the work queue — and the playhead starts before that job runs. Parsing is
  // only allowed while stopped, so the job has to look again when it runs and
  // put the bank back in the deferred queue.
  const host = await processorHost();
  host.post({ type: "song", snapshot: fontSong([fontTrack(0)], { bpm: 125 }) });
  host.post({ type: "library", request_id: "queued-then-play", library_id: FONT_ID, kind: "font", bytes: Uint8Array.from(FONT_BYTES) });
  host.post({ type: "launchScene", id: "scene-1" });
  host.post({ type: "play" });
  await host.flush();

  assert.equal(host.processor.fonts === null ? 0 : host.processor.fonts.fontCount, 0, "a bank must not parse while playing");
  assert.equal(postsOfType(host.posts, "library_loaded").length, 0, "a load that went back to the queue must not be acked loaded");
  assert.deepEqual(answersTo(host.posts, "queued-then-play"), [
    { type: "library_deferred", library_id: FONT_ID, request_id: "queued-then-play" },
  ]);
  const silent = host.run(4);
  assert.ok(peakOf(silent.left) < 1e-9, `the font has to stay silent while it waits, peak was ${peakOf(silent.left)}`);

  // Stop parses it, and it plays after that.
  host.post({ type: "stop" });
  await host.flush();
  assert.equal(
    postsOfType(host.posts, "library_loaded").filter((message) => message.library_id === FONT_ID && message.ok).length,
    1,
    "Stop has to parse the bank the queued job handed back",
  );
  host.post({ type: "play" });
  await host.flush();
  const playing = host.run(16);
  assertTone(playing.left, 0, 2048, toneOf(0, 0), undefined, "the bank that waited for the next Stop");
});

test("a font that fails to parse is silent and reported once", async () => {
  const host = await processorHost();
  const garbage = new TextEncoder().encode("RIFF0000not a bank at all");
  host.post({ type: "library", request_id: "broken", library_id: "font-broken", kind: "font", bytes: garbage });
  await host.flush();

  const failed = postsOfType(host.posts, "library_failed");
  assert.equal(failed.length, 1, `expected one library_failed, got ${JSON.stringify(failed)}`);
  assert.equal(failed[0].library_id, "font-broken");
  assert.ok(String(failed[0].reason).length > 0, "the report has to say why");
  // The load's own request is answered too, with the same reason.
  const answer = answersTo(host.posts, "broken");
  assert.equal(answer.length, 1, `expected one ack for the broken load, got ${JSON.stringify(answer)}`);
  assert.equal(answer[0].ok, false);
  assert.equal(answer[0].reason, failed[0].reason);

  // Asking again changes nothing: one report per font id, and no throw — and the
  // second load is answered for ITS OWN request.
  host.post({ type: "library", request_id: "broken-again", library_id: "font-broken", kind: "font", bytes: garbage });
  await host.flush();
  assert.equal(postsOfType(host.posts, "library_failed").length, 1, "a second load of a broken bank must not report again");
  const again = answersTo(host.posts, "broken-again");
  assert.equal(again.length, 1, `the second load has to be answered, got ${JSON.stringify(again)}`);
  assert.equal(again[0].ok, false);

  // The song that plays it is silent (the track is pointed at the broken font).
  host.post({ type: "song", snapshot: fontSong([fontTrack(0, { device: { engine: "soundfont", font_id: "font-broken", bank: 0, program: 0 } })], { bpm: 125 }) });
  host.post({ type: "launchScene", id: "scene-1" });
  host.post({ type: "play" });
  await host.flush();
  const silent = host.run(16);
  assert.ok(peakOf(silent.left) < 1e-9, `a broken bank has to play silence, peak was ${peakOf(silent.left)}`);
  const stillSilent = host.run(4);
  assert.ok(peakOf(stillSilent.left) < 1e-9, "the failed font stays silent");
});

test("a bank with no presets is reported", async () => {
  const host = await processorHost();
  const empty = tinySf2({ presets: [] });
  host.post({ type: "song", snapshot: fontSong([fontTrack(0)], { bpm: 125 }) });
  host.post({ type: "library", request_id: "empty", library_id: FONT_ID, kind: "font", bytes: Uint8Array.from(empty) });
  await host.flush();
  host.post({ type: "launchScene", id: "scene-1" });
  host.post({ type: "play" });
  await host.flush();

  const failed = postsOfType(host.posts, "library_failed");
  assert.equal(failed.length, 1, `expected one library_failed, got ${JSON.stringify(failed)}`);
  assert.equal(failed[0].library_id, FONT_ID);
  assert.equal(failed[0].reason, "This bank has no instruments.");
  const answer = answersTo(host.posts, "empty");
  assert.equal(answer.length, 1);
  assert.equal(answer[0].ok, false);
  assert.equal(answer[0].reason, "This bank has no instruments.");
  assert.equal(host.processor.fonts === null ? 0 : host.processor.fonts.fontCount, 0, "a bank with no preset is not held");

  const silent = host.run(8);
  assert.ok(peakOf(silent.left) < 1e-9, `a bank with nothing to play has to be silent, peak was ${peakOf(silent.left)}`);
});

test("each font load is answered for its own request", async () => {
  const host = await processorHost();
  host.post({ type: "song", snapshot: fontSong([fontTrack(0)], { bpm: 125 }) });

  // Two loads of ONE font id, each with its own request: the good one loads, the
  // broken one after it fails, and neither answer is taken for the other's.
  host.post({ type: "library", request_id: "req-good", library_id: FONT_ID, kind: "font", bytes: Uint8Array.from(FONT_BYTES) });
  await host.flush();
  const good = answersTo(host.posts, "req-good");
  assert.equal(good.length, 1, `the good load has to be answered once, got ${JSON.stringify(good)}`);
  // Its presets are the bank's own, which the instrument picker lists (the
  // presets themselves are pinned by "a loaded bank lists its presets").
  const { presets, ...answer } = good[0];
  assert.deepEqual(answer, { type: "library_loaded", library_id: FONT_ID, ok: true, request_id: "req-good" });
  assert.equal(Array.isArray(presets) && presets.length, TINY_SF2_PRESETS.length, "a loaded bank lists its presets");

  const garbage = new TextEncoder().encode("RIFF0000not a bank at all");
  host.post({ type: "library", request_id: "req-bad", library_id: FONT_ID, kind: "font", bytes: garbage });
  await host.flush();
  const bad = answersTo(host.posts, "req-bad");
  assert.equal(bad.length, 1, `the second load has to be answered once, got ${JSON.stringify(bad)}`);
  assert.equal(bad[0].ok, false);
  // A refused reload leaves the bank that was already loaded alone.
  assert.equal(host.processor.fonts.fontCount, 1);
  assert.deepEqual(host.processor.fonts.loadedIds(), [FONT_ID]);

  // Two loads of one id while playing: the older request is answered, the newer
  // waits for Stop. Neither is dropped on the floor.
  host.post({ type: "play" });
  await host.flush();
  host.post({ type: "library", request_id: "req-old", library_id: "font-late", kind: "font", bytes: Uint8Array.from(FONT_BYTES) });
  host.post({ type: "library", request_id: "req-new", library_id: "font-late", kind: "font", bytes: Uint8Array.from(FONT_BYTES) });
  await host.flush();
  const older = answersTo(host.posts, "req-old");
  assert.equal(older.length, 1, `the superseded request has to be answered once, got ${JSON.stringify(older)}`);
  assert.equal(older[0].type, "library_deferred");
  assert.deepEqual(answersTo(host.posts, "req-new"), [
    { type: "library_deferred", library_id: "font-late", request_id: "req-new" },
  ]);
});

test("unloading a font cancels a load of it that was never parsed", async () => {
  // A load queued while stopped, and an unload of the same font posted before
  // the queue reaches it: nothing is parsed, and the load's own request is
  // answered so the page is not left waiting.
  const host = await processorHost();
  host.post({ type: "song", snapshot: fontSong([fontTrack(0)], { bpm: 125 }) });
  host.post({ type: "library", request_id: "doomed", library_id: FONT_ID, kind: "font", bytes: Uint8Array.from(FONT_BYTES) });
  host.post({ type: "library_unload", library_id: FONT_ID });
  await host.flush();

  assert.equal(host.processor.fonts === null ? 0 : host.processor.fonts.fontCount, 0, "a cancelled load must not parse");
  const cancelled = answersTo(host.posts, "doomed");
  assert.equal(cancelled.length, 1, `the cancelled load has to be answered, got ${JSON.stringify(cancelled)}`);
  assert.equal(cancelled[0].ok, false);
  const silent = host.run(4);
  assert.ok(peakOf(silent.left) < 1e-9, "the cancelled font is not there to play");

  // The same for a load that was waiting for Stop.
  const deferredHost = await processorHost();
  deferredHost.post({ type: "song", snapshot: fontSong([fontTrack(0)], { bpm: 125 }) });
  deferredHost.post({ type: "launchScene", id: "scene-1" });
  deferredHost.post({ type: "play" });
  await deferredHost.flush();
  deferredHost.post({ type: "library", request_id: "parked", library_id: FONT_ID, kind: "font", bytes: Uint8Array.from(FONT_BYTES) });
  await deferredHost.flush();
  deferredHost.post({ type: "library_unload", library_id: FONT_ID });
  await deferredHost.flush();
  const parked = answersTo(deferredHost.posts, "parked");
  assert.equal(parked.length, 2, `a deferred load has its deferred answer and then its cancel, got ${JSON.stringify(parked)}`);
  assert.equal(parked[1].ok, false);
  deferredHost.post({ type: "stop" });
  await deferredHost.flush();
  assert.equal(
    postsOfType(deferredHost.posts, "library_loaded").filter((message) => message.ok).length,
    0,
    "a cancelled deferred load must not parse on Stop",
  );
});

test("eight tracks on one bank load it once and mix separately", async () => {
  // (1) The host's own contract: ONE parsed bank, one MIDI channel per track in
  // snapshot order, and a stereo pair per track that holds that track and not
  // its neighbours. `process()` is the documented interface, so it is used here
  // exactly as the processor uses it.
  const host = await loadedHost();
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
  run.post({ type: "library", request_id: 1, library_id: FONT_ID, kind: "font", bytes: Uint8Array.from(FONT_BYTES) });
  await run.flush();
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

test("deleting a track does not move or cut another track's held note", async () => {
  // Both tracks hold the four-second-release program, on channels 0 and 1.
  // Deleting the first track must not move the second one's note: with channels
  // assigned by snapshot order the second track slid from channel 1 to channel
  // 0, its held note was released where it was and its output went silent. A
  // sticky channel keeps it exactly where it was, at exactly its level.
  const host = await loadedHost();
  const spec = (trackId) => ({ track_id: trackId, font_id: FONT_ID, bank: 0, program: 8 });
  host.assign([spec("track-a"), spec("track-b")]);
  assert.equal(host.channelFor("track-a"), 0, "the first track holds channel 0");
  assert.equal(host.channelFor("track-b"), 1, "the second track holds channel 1");

  host.noteOn("track-a", 60, 100);
  host.noteOn("track-b", 60, 100);
  // A window of a whole number of the tone's cycles (98 at 980 Hz), so the
  // measurement does not depend on the phase it starts at. One window is a
  // warm-up; the next is the level the note has settled at.
  const window = 4800;
  host.process(window);
  const beforeOut = host.process(window);
  const before = toneAmplitude(beforeOut.get("track-b").left, 0, window, toneOf(0, 8));
  assert.ok(before > 0.01, `the second track has to be sounding before the delete, it reads ${before}`);

  // Delete the first track: the second one keeps channel 1 and its held note.
  host.assign([spec("track-b")]);
  assert.equal(host.channelFor("track-b"), 1, "a track keeps its channel when another one is deleted");

  const afterOut = host.process(window);
  const after = toneAmplitude(afterOut.get("track-b").left, 0, window, toneOf(0, 8));
  assert.ok(after > 0.01, `the surviving track's next block has to be non-silent, it reads ${after}`);
  assert.ok(
    Math.abs(after - before) <= before / 100,
    `the held note must not move or be cut: it went from ${before} to ${after}`,
  );
  host.destroy();
});

test("a removed track's tail does not play through the next track", async () => {
  // A track leaves the song while a four-second release is ringing. Its channel
  // keeps draining (rendered) so the release is not cut, but its output is gone;
  // no other track may inherit that tail.
  const host = await loadedHost();
  const longTrack = { track_id: "track-a", font_id: FONT_ID, bank: 0, program: 8 };
  const shortTrack = { track_id: "track-b", font_id: FONT_ID, bank: 0, program: 1 };
  host.assign([longTrack, shortTrack]);
  host.noteOn("track-a", 60, 100);
  host.noteOn("track-b", 60, 100);
  const beforeOut = host.process(2048);
  assert.ok(
    toneAmplitude(beforeOut.get("track-b").left, 0, 2048, toneOf(0, 1)) > 0.01,
    "the surviving track has to be sounding before the delete",
  );

  host.assign([shortTrack]);
  const afterOut = host.process(8192);
  const own = toneAmplitude(afterOut.get("track-b").left, 0, 8192, toneOf(0, 1));
  const leaked = toneAmplitude(afterOut.get("track-b").left, 0, 8192, toneOf(0, 8));
  assert.ok(own > 0.01, `the next track still plays its own program, it reads ${own}`);
  assert.ok(
    leaked < own / 20,
    `a removed track's release must not be routed into another track, it leaks ${leaked} against ${own}`,
  );
  host.destroy();
});

test("a draining channel is not handed to a new track until its voices end", async () => {
  // A removed track's channel is released and keeps ringing, so it is not free
  // for a new track yet. Once its release has ended it is the lowest free
  // channel again.
  const host = await loadedHost();
  const longTrack = { track_id: "track-a", font_id: FONT_ID, bank: 0, program: 8 };
  const shortTrack = { track_id: "track-b", font_id: FONT_ID, bank: 0, program: 1 };
  host.assign([longTrack, shortTrack]);
  host.noteOn("track-a", 60, 100);
  host.process(2048);

  // Remove track A: channel 0 starts draining (a four-second release).
  host.assign([shortTrack]);
  const newcomer = { track_id: "track-c", font_id: FONT_ID, bank: 0, program: 2 };
  host.assign([shortTrack, newcomer]);
  assert.equal(host.channelFor("track-b"), 1, "the surviving track keeps channel 1");
  assert.equal(host.channelFor("track-c"), 2, "a draining channel must not be handed to a new track");

  // Five seconds later the release is over: channel 0 is free for the next one.
  host.process(SAMPLE_RATE * 5);
  const later = { track_id: "track-d", font_id: FONT_ID, bank: 0, program: 3 };
  host.assign([shortTrack, newcomer, later]);
  assert.equal(host.channelFor("track-b"), 1, "no channel moves when a drain ends");
  assert.equal(host.channelFor("track-c"), 2, "no channel moves when a drain ends");
  assert.equal(host.channelFor("track-d"), 0, "a drained channel is the lowest free channel again");
  host.destroy();
});

test("a new track takes a draining channel only after an all-sound-off", async () => {
  // Sixteen tracks on one font fill every channel. The track on channel 15 is
  // removed while its long release rings, and a new track arrives: there is no
  // free channel left, so it takes the draining one after an all-sound-off on
  // that channel (the only forced cut this engine makes).
  const host = await loadedHost();
  const specs = [];
  for (let index = 1; index <= 15; index += 1) {
    specs.push({ track_id: `track-${index}`, font_id: FONT_ID, bank: 0, program: index - 1 });
  }
  specs.push({ track_id: "track-16", font_id: FONT_ID, bank: 0, program: 8 });
  host.assign(specs);
  for (const spec of specs) host.noteOn(spec.track_id, 60, 100);
  assert.equal(host.channelFor("track-16"), 15, "the sixteenth track holds channel 15");
  host.process(2048);

  // Remove it: channel 15 drains (its four-second release is still ringing).
  host.assign(specs.slice(0, 15));
  host.process(2048);

  const newcomer = { track_id: "track-new", font_id: FONT_ID, bank: 0, program: 2 };
  host.assign([...specs.slice(0, 15), newcomer]);
  assert.equal(
    host.channelFor("track-new"),
    15,
    "with every other channel owned, a new track takes the draining one",
  );
  host.noteOn("track-new", 60, 100);
  const out = host.process(4096);
  const own = toneAmplitude(out.get("track-new").left, 0, 4096, toneOf(0, 2));
  const cut = toneAmplitude(out.get("track-new").left, 0, 4096, toneOf(0, 8));
  assert.ok(own > 0.01, `the new track's program has to sound, it reads ${own}`);
  assert.ok(cut < own / 20, `the all-sound-off has to cut the old tail, it reads ${cut} against ${own}`);
  host.destroy();
});

test("a font change releases the old font's held notes on the same track", async () => {
  // The track moves from a long-release preset in one bank to a new program in
  // another. The old bank keeps rendering its channel INTO THE SAME TRACK until
  // the release has rung out; the new program starts at once.
  processorClass();
  const host = globalThis.StudioFontVoice.create(SAMPLE_RATE, {});
  await host.load("font-a", Uint8Array.from(FONT_BYTES));
  await host.load("font-b", Uint8Array.from(FONT_BYTES));

  host.assign([{ track_id: "track-1", font_id: "font-a", bank: 0, program: 8 }]);
  host.noteOn("track-1", 60, 100);
  const held = host.process(2048);
  const before = toneAmplitude(held.get("track-1").left, 0, 2048, toneOf(0, 8));
  assert.ok(before > 0.01, `the old font's note has to be held first, it reads ${before}`);

  host.assign([{ track_id: "track-1", font_id: "font-b", bank: 0, program: 0 }]);
  host.noteOn("track-1", 60, 100);
  const changed = host.process(4096);
  const released = toneAmplitude(changed.get("track-1").left, 0, 4096, toneOf(0, 8));
  const fresh = toneAmplitude(changed.get("track-1").left, 0, 4096, toneOf(0, 0));
  assert.ok(
    released > before / 2,
    `the old font's released note has to keep sounding through the same track, it reads ${released} against ${before}`,
  );
  assert.ok(fresh > 0.01, `the new font's program has to start, it reads ${fresh}`);

  // The release is four seconds long: after five it is gone, and the new note
  // (a looped sample) still sounds.
  host.process(SAMPLE_RATE * 5);
  const later = host.process(4096);
  const gone = toneAmplitude(later.get("track-1").left, 0, 4096, toneOf(0, 8));
  const stillFresh = toneAmplitude(later.get("track-1").left, 0, 4096, toneOf(0, 0));
  assert.ok(gone < before / 20, `the old font's release has to end, it reads ${gone}`);
  assert.ok(stillFresh > 0.01, `the new font's note is still sounding, it reads ${stillFresh}`);
  host.destroy();
});

test("a drain that ends while playing allocates nothing", async () => {
  // A track that changes font leaves its old channel draining INTO ITS OWN pair.
  // When that drain ends inside `process()`, the run settles the font, drops the
  // route and stops rendering the old font — and it may not allocate a thing
  // while it does: no `tracks.values()` iterator and no `splice` result. The run
  // hands back the same map, and the track keeps the very same buffers, before
  // and after the drain ends.
  processorClass();
  const host = globalThis.StudioFontVoice.create(SAMPLE_RATE, {});
  await host.load("font-a", Uint8Array.from(FONT_BYTES));
  await host.load("font-b", Uint8Array.from(FONT_BYTES));

  const onB = { track_id: "track-1", font_id: "font-b", bank: 0, program: 1 };
  host.assign([{ track_id: "track-1", font_id: "font-a", bank: 0, program: 8 }]);
  host.noteOn("track-1", 60, 100);
  host.process(4096);
  assert.equal(host.channelFor("track-1"), 0, "the track holds channel 0 of font-a");

  // The font change: font-a's channel 0 is released and keeps ringing into the
  // same track (a drain) for its four-second release.
  host.assign([onB]);
  const started = host.process(4096);
  assert.ok(
    toneAmplitude(started.get("track-1").left, 0, 4096, toneOf(0, 8)) > 0.01,
    "the old font's release has to be routed into the track as the drain starts",
  );

  // The probe: a Map iterator created from here on is an allocation the per-run
  // path may not make (and the one a drain end used to create).
  const mapProto = Map.prototype;
  const realValues = mapProto.values;
  const realEntries = mapProto.entries;
  const realKeys = mapProto.keys;
  const realIterator = mapProto[Symbol.iterator];
  let iterators = 0;
  const counting = (real) =>
    function countedIterator(...args) {
      iterators += 1;
      return real.apply(this, args);
    };
  mapProto.values = counting(realValues);
  mapProto.entries = counting(realEntries);
  mapProto.keys = counting(realKeys);
  mapProto[Symbol.iterator] = counting(realIterator);
  try {
    const map = host.process(4096);
    const pair = host.outputFor("track-1");
    // Five seconds of runs: the four-second release ends somewhere inside them.
    const chunks = Math.ceil((SAMPLE_RATE * 5) / 4096);
    for (let index = 0; index < chunks; index += 1) {
      const out = host.process(4096);
      assert.equal(out, map, "a run hands back its own map, never a new one");
      assert.equal(out.get("track-1"), pair, "a track keeps its pair across the drain end");
    }
  } finally {
    mapProto.values = realValues;
    mapProto.entries = realEntries;
    mapProto.keys = realKeys;
    mapProto[Symbol.iterator] = realIterator;
  }
  assert.equal(iterators, 0, "a run must create no Map iterator, not even the one a drain end used to create");

  // The drain really did end inside those runs: font-a's channel 0 is free (and
  // is not drained into track-1 any more), so a new track takes it.
  host.assign([onB, { track_id: "track-2", font_id: "font-a", bank: 0, program: 0 }]);
  assert.equal(host.channelFor("track-1"), 0, "the track keeps its own channel on font-b");
  assert.equal(host.channelFor("track-2"), 0, "a drained channel is the lowest free channel again");
  host.destroy();
});

test("an sf3 bank is fully decoded when it loads", async () => {
  // The REAL compressed path: an SF3 bank whose smpl chunk is Ogg Vorbis, made
  // from the committed `tests/fixtures/tiny-sine.ogg`. Every sample has to be
  // decoded before the song plays, and playing a note must not decode anything.
  processorClass();
  const host = globalThis.StudioFontVoice.create(SAMPLE_RATE, {});
  await host.load(SF3_ID, Uint8Array.from(SF3_BYTES));

  const stats = host.stats(SF3_ID);
  assert.ok(stats, "a loaded font has to report what it holds");
  assert.equal(stats.samples, 1, "the sf3 fixture carries one sample");
  assert.equal(TINY_SF3_DECODED_SAMPLES, Math.round(0.25 * TINY_SF3_SAMPLE_RATE), "the fixture is the 0.25 s sine");
  assert.equal(stats.decoded, stats.samples, `every sample has to be decoded at load, ${stats.decoded}/${stats.samples} were`);
  assert.equal(stats.decodedBytes, TINY_SF3_DECODED_BYTES, "the decoded data is Float32 sample data, all of it");
  assert.equal(stats.rawBytes, SF3_BYTES.byteLength);

  // Every sample holds its decoded Float32 data BEFORE play. This is the state
  // that makes a note impossible to decode later.
  const synth = host.fontSynth(SF3_ID);
  assert.ok(synth, "the host has to hold the bank's synth");
  const samples = synth.soundBankManager.soundBankList[0].soundBank.samples;
  assert.equal(samples.length, stats.samples);
  for (const sample of samples) {
    assert.ok(sample.audioData instanceof Float32Array, "every sample has to carry its decoded data before play");
    assert.equal(sample.audioData.length, TINY_SF3_DECODED_SAMPLES, "the Ogg stream has to decode to its granule length");
    assert.equal(sample.sampleRate, TINY_SF3_SAMPLE_RATE);
  }

  // Spy on the two decode entry points the vendored synth has. Playing the bank
  // may call getAudioData() (it returns the cache), but it must never reach a
  // decode.
  let decodes = 0;
  for (const sample of samples) {
    const decodeVorbis = sample.decodeVorbis;
    sample.decodeVorbis = function decodeSpy(...args) {
      decodes += 1;
      return decodeVorbis.apply(this, args);
    };
    const decodeS16LE = sample.decodeS16LE;
    sample.decodeS16LE = function decodeSpy(...args) {
      decodes += 1;
      return decodeS16LE.apply(this, args);
    };
  }

  host.assign([{ track_id: "track-1", font_id: SF3_ID, bank: 0, program: 0 }]);
  host.noteOn("track-1", 60, 100);
  const out = host.process(4096);
  host.noteOff("track-1", 60);
  assert.ok(peakOf(out.get("track-1").left) > 0.001, "the decoded sf3 bank has to be audible");
  assert.equal(decodes, 0, "playing a note must decode nothing: every sample was decoded at load");
  assert.deepEqual(host.stats(SF3_ID), stats, "nothing may decode while the song plays");
  assert.equal(host.bytes, stats.rawBytes + stats.decodedBytes);
  host.destroy();
});

test("an sf3 bank whose samples cannot be decoded fails at load", async () => {
  // Every sample of an SF3 bank is decoded at load. A sample that carries data
  // the decoder cannot read must not be skipped: the bank is not half-loaded with
  // silent samples, it fails as a WHOLE, with the reason the page shows, and
  // nothing of it is held.
  const host = await processorHost();
  const samplePrototype = globalThis.StudioSpessa.BasicSample.prototype;
  const real = samplePrototype.getAudioData;
  let attempts = 0;
  samplePrototype.getAudioData = function undecodable() {
    attempts += 1;
    throw new Error("the Ogg decoder could not read this sample");
  };
  try {
    host.post({
      type: "song",
      snapshot: fontSong([
        fontTrack(0, { device: { engine: "soundfont", font_id: SF3_ID, bank: 0, program: 0 } }),
      ], { bpm: 125 }),
    });
    host.post({ type: "library", request_id: "undecodable", library_id: SF3_ID, kind: "font", bytes: Uint8Array.from(SF3_BYTES) });
    await host.flush();
  } finally {
    samplePrototype.getAudioData = real;
  }
  assert.ok(attempts > 0, "the load has to have tried to decode the bank's samples");

  const failed = postsOfType(host.posts, "library_failed");
  assert.equal(failed.length, 1, `expected one library_failed, got ${JSON.stringify(failed)}`);
  assert.equal(failed[0].library_id, SF3_ID);
  assert.equal(failed[0].reason, "Studio could not read this bank's compressed samples.");
  const answer = answersTo(host.posts, "undecodable");
  assert.equal(answer.length, 1, `the load has to be answered once, got ${JSON.stringify(answer)}`);
  assert.equal(answer[0].ok, false);
  assert.equal(answer[0].reason, failed[0].reason);
  assert.equal(host.processor.fonts.fontCount, 0, "a bank with undecodable samples is not held");
  assert.equal(host.processor.fonts.bytes, 0, "and it counts nothing against the cap");

  host.post({ type: "launchScene", id: "scene-1" });
  host.post({ type: "play" });
  await host.flush();
  const silent = host.run(8);
  assert.ok(peakOf(silent.left) < 1e-9, `a bank that would not decode has to be silent, peak was ${peakOf(silent.left)}`);
});

test("decoded samples count against the cap", async () => {
  // A cap that holds the FILE but not its decoded samples: the font is refused,
  // because a font costs the host its bytes AND the Float32 data it decoded them
  // into.
  const fileOnly = loadedCapHost(FONT_BYTES.byteLength + TINY_SF2_DECODED_BYTES - 1);
  await assert.rejects(
    () => fileOnly.load(FONT_ID, Uint8Array.from(FONT_BYTES)),
    { message: /This song's instruments need more than .* MB; remove an instrument or use a smaller bank\./ },
    "a cap that only holds the file has to refuse the font",
  );
  assert.equal(fileOnly.fontCount, 0, "a refused font leaves nothing behind");
  assert.equal(fileOnly.bytes, 0, "a refused font counts nothing against the cap");

  // One byte more of room and the very same bank loads, holding exactly its file
  // plus its decoded samples — which is more than the file alone.
  const fits = loadedCapHost(FONT_BYTES.byteLength + TINY_SF2_DECODED_BYTES);
  await fits.load(FONT_ID, Uint8Array.from(FONT_BYTES));
  assert.equal(fits.bytes, FONT_FOOTPRINT, "the cap has to count the decoded samples on top of the file");
  assert.ok(fits.bytes > FONT_BYTES.byteLength, "the decoded samples are what makes up the rest");
});

/**
 * A font host of its own with a cap, ready for a test to load into.
 * @param {number} maxBytes
 * @returns {object} the host
 */
function loadedCapHost(maxBytes) {
  processorClass();
  return globalThis.StudioFontVoice.create(SAMPLE_RATE, { maxBytes: maxBytes });
}

/**
 * Replace the vendored Vorbis decoder's ready promise with one this test
 * settles by hand, so Play can arrive while the parse job is waiting for the
 * decoder. Restore it in a `finally`.
 * @returns {{resolve: function(): void, restore: function(): void}}
 */
function deferDecoderReady() {
  processorClass();
  const bank = globalThis.StudioSpessa.BasicSoundBank;
  const real = bank.ready;
  let release = null;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  bank.ready = pending;
  return {
    resolve() {
      release();
    },
    restore() {
      bank.ready = real;
    },
  };
}

/**
 * A font host whose `load` a test settles by hand, so a bank can be held
 * MID-PARSE (the processor's job is inside `await load`) deterministically.
 * Installed by replacing the processor instance's own `fontHost`.
 * @returns {{host: object, started: boolean, resolve: function(): void,
 *   reject: function(Error): void}}
 */
function gatedFontHost() {
  let settle = null;
  const host = {
    ready: function ready() {
      return Promise.resolve();
    },
    load: function load() {
      return new Promise((resolve, reject) => {
        settle = { resolve: resolve, reject: reject };
      });
    },
    unload: function unload() {},
    assign: function assign() {},
    missing: function missing() {
      return [];
    },
    takeFailures: function takeFailures() {
      return [];
    },
    takeEvicted: function takeEvicted() {
      return [];
    },
    isLoaded: function isLoaded() {
      return false;
    },
    loadedIds: function loadedIds() {
      return [];
    },
  };
  return {
    host: host,
    get started() {
      return settle !== null;
    },
    resolve() {
      settle.resolve();
    },
    reject(error) {
      settle.reject(error);
    },
  };
}

test("a font whose bytes alone cannot fit is refused before it is parsed", async () => {
  // The raw file alone is already past the room left under the cap: there is no
  // point parsing it or decoding a sample, so the refusal happens first.
  processorClass();
  const loader = globalThis.StudioSpessa.SoundBankLoader;
  const real = loader.fromArrayBuffer;
  let parses = 0;
  loader.fromArrayBuffer = function countingParse(...args) {
    parses += 1;
    return real.apply(this, args);
  };
  try {
    const host = loadedCapHost(FONT_BYTES.byteLength - 1);
    await assert.rejects(() => host.load(FONT_ID, Uint8Array.from(FONT_BYTES)), {
      message: /This song's instruments need more than .* MB; remove an instrument or use a smaller bank\./,
    });
    assert.equal(parses, 0, "a font that cannot fit must be refused before its bank is parsed");
    assert.equal(host.fontCount, 0);
    assert.equal(host.bytes, 0);
    host.destroy();
  } finally {
    loader.fromArrayBuffer = real;
  }
});

test("a reload releases the old copy before decoding the new one", async () => {
  // A reload of the same id must not keep the copy it replaces in memory while
  // it decodes the new one: the old font's bytes are gone by the first decode.
  processorClass();
  const host = globalThis.StudioFontVoice.create(SAMPLE_RATE, {});
  await host.load(SF3_ID, Uint8Array.from(SF3_BYTES));
  assert.ok(host.bytes > 0, "the first load has to hold its bytes");

  const samplePrototype = globalThis.StudioSpessa.BasicSample.prototype;
  const real = samplePrototype.decodeVorbis;
  let bytesDuringDecode = -1;
  samplePrototype.decodeVorbis = function spyDecode(...args) {
    bytesDuringDecode = host.bytes;
    return real.apply(this, args);
  };
  try {
    await host.load(SF3_ID, Uint8Array.from(SF3_BYTES));
  } finally {
    samplePrototype.decodeVorbis = real;
  }
  assert.equal(bytesDuringDecode, 0, "the copy being replaced has to be released before the new one is decoded");
  assert.ok(host.bytes > 0, "the reloaded font is held after it decodes");
  host.destroy();
});

test("a reload refused for the cap leaves its tracks asking for the font", async () => {
  // The cap holds the font's file AND its decoded samples, exactly. A reload with
  // a bigger bank releases the copy it replaces before decoding the new one — and
  // then finds no room for the decoded data. The tracks that played the font must
  // not keep a channel of a copy that is gone: they are re-bound, so the font is
  // reported missing again instead of playing nothing in silence.
  processorClass();
  const host = globalThis.StudioFontVoice.create(SAMPLE_RATE, { maxBytes: FONT_FOOTPRINT });
  host.assign([{ track_id: "track-1", font_id: FONT_ID, bank: 0, program: 0 }]);
  await host.load(FONT_ID, Uint8Array.from(FONT_BYTES));
  assert.equal(host.channelFor("track-1"), 0, "the loaded font gives its track a channel");
  assert.deepEqual(host.missing(), [], "a font that is loaded is not missing");

  // One preset more than the cap holds: the file alone still fits, its decoded
  // samples do not, so the refusal comes AFTER the old copy has been released.
  const bigger = tinySf2({
    presets: [...TINY_SF2_PRESETS, { name: "Sine 1060", bank: 0, program: 9, freq: 1060 }],
  });
  assert.ok(bigger.byteLength <= FONT_FOOTPRINT, "the bigger bank's file alone has to fit under the cap");
  await assert.rejects(() => host.load(FONT_ID, Uint8Array.from(bigger)), {
    message: /^This song's instruments need more than .* MB; remove an instrument or use a smaller bank\.$/,
  });

  assert.equal(host.fontCount, 0, "the copy the reload replaced is gone");
  assert.equal(host.bytes, 0, "and it counts nothing against the cap");
  assert.equal(host.channelFor("track-1"), null, "the track may not keep a channel of a font that is not there");
  assert.deepEqual(host.missing(), [FONT_ID], "the refused font has to be asked for again");

  // Silence until the font arrives…
  const silent = host.process(4096);
  assert.ok(peakOf(silent.get("track-1").left) < 1e-9, "a track whose font was refused is silent");
  // …and a load that fits plays that track again.
  await host.load(FONT_ID, Uint8Array.from(FONT_BYTES));
  host.noteOn("track-1", 60, 100);
  const back = host.process(4096);
  assert.ok(peakOf(back.get("track-1").left) > 0.01, "the font that fits again has to play its track");
  host.destroy();
});

test("a play that arrives while the decoder is getting ready defers the parse", async () => {
  // The parse job awaits the Vorbis decoder before it parses. Play can arrive
  // while it waits: the transport is read again after that await, and the bank
  // goes back to the deferred queue without being parsed.
  const host = await processorHost();
  const gate = deferDecoderReady();
  try {
    host.post({ type: "song", snapshot: fontSong([fontTrack(0)], { bpm: 125 }) });
    await host.flush();
    host.post({ type: "library", request_id: "slow-decoder", library_id: FONT_ID, kind: "font", bytes: Uint8Array.from(FONT_BYTES) });
    // Let the queued job reach its wait for the decoder.
    await settle();
    host.post({ type: "play" });
    await settle();
    gate.resolve();
    await host.flush();

    assert.equal(host.processor.fonts === null ? 0 : host.processor.fonts.fontCount, 0, "a bank must not parse once Play arrived");
    assert.equal(postsOfType(host.posts, "library_loaded").length, 0, "a deferred load must not be acked loaded");
    assert.deepEqual(answersTo(host.posts, "slow-decoder"), [
      { type: "library_deferred", library_id: FONT_ID, request_id: "slow-decoder" },
    ]);
  } finally {
    gate.restore();
  }
});

test("an unload mid-parse discards the parse result silently", async () => {
  // A bank held MID-PARSE (the parse job is inside `await load`) and then
  // unloaded: the load was already answered when it was cancelled, so its late
  // result — a success or a failure — must not answer again or post
  // library_failed.
  for (const failing of [false, true]) {
    const host = await processorHost();
    const gate = gatedFontHost();
    host.processor.fontHost = () => gate.host;
    host.post({ type: "song", snapshot: fontSong([fontTrack(0)], { bpm: 125 }) });
    await host.flush();

    host.post({ type: "library", request_id: "doomed-parse", library_id: FONT_ID, kind: "font", bytes: Uint8Array.from(FONT_BYTES) });
    const started = await waitFor(() => gate.started);
    assert.ok(started, "the parse job has to reach the load before the unload is posted");
    host.post({ type: "library_unload", library_id: FONT_ID });
    await settle();
    // The parse finishes AFTER its cancellation, one way or the other.
    if (failing) gate.reject(Object.assign(new Error("no room for this bank"), { code: "font_cap" }));
    else gate.resolve();
    await host.flush();

    const answers = answersTo(host.posts, "doomed-parse");
    assert.equal(answers.length, 1, `the cancelled load is answered once (failing=${failing}), got ${JSON.stringify(answers)}`);
    assert.equal(answers[0].ok, false);
    assert.equal(
      postsOfType(host.posts, "library_failed").length,
      0,
      `a cancelled parse must not report a failure (failing=${failing})`,
    );
  }
});

test("a font refused for the cap is asked for again when the room comes back", async () => {
  // The song plays two banks and the cap holds only one, so the second is
  // refused. When the first track leaves the song there is room again: the
  // refusal has to be forgotten and the font asked for once more.
  const first = { engine: "soundfont", font_id: "font-first", bank: 0, program: 0 };
  const second = { engine: "soundfont", font_id: "font-second", bank: 0, program: 0 };
  const both = fontSong([
    fontTrack(0, { device: first }),
    fontTrack(1, { device: second }),
  ], { bpm: 125 });
  const secondOnly = fontSong([fontTrack(1, { device: second })], { bpm: 125 });

  const host = await processorHost({ maxFontBytes: FONT_FOOTPRINT });
  host.post({ type: "song", snapshot: both });
  host.post({ type: "library", request_id: "first", library_id: "font-first", kind: "font", bytes: Uint8Array.from(FONT_BYTES) });
  await host.flush();
  host.post({ type: "library", request_id: "second", library_id: "font-second", kind: "font", bytes: Uint8Array.from(FONT_BYTES) });
  await host.flush();
  assert.equal(answersTo(host.posts, "second")[0].ok, false, "the second font does not fit while the first is loaded");
  const neededBefore = postsOfType(host.posts, "library_needed").filter((message) => message.library_id === "font-second").length;

  // The song's font set shrinks to the refused one: room is back (the first
  // font is no longer needed and may be evicted), so it is asked for again.
  host.post({ type: "song", snapshot: secondOnly });
  await host.flush();
  const neededAfter = postsOfType(host.posts, "library_needed").filter((message) => message.library_id === "font-second").length;
  assert.equal(neededAfter, neededBefore + 1, "the refused font has to be reported as needed again");

  host.post({ type: "library", request_id: "second-again", library_id: "font-second", kind: "font", bytes: Uint8Array.from(FONT_BYTES) });
  await host.flush();
  const again = answersTo(host.posts, "second-again");
  assert.equal(again.length, 1);
  assert.equal(again[0].ok, true, `the font has to load now that there is room, got ${JSON.stringify(again[0])}`);
  assert.ok(host.processor.fonts.isLoaded("font-second"));
});

test("unloading a font re-asks for one the cap refused", async () => {
  // The other half of the retry: an explicit unload of the bank that was using
  // the room also makes the refused bank worth asking for again.
  const first = { engine: "soundfont", font_id: "font-first", bank: 0, program: 0 };
  const second = { engine: "soundfont", font_id: "font-second", bank: 0, program: 0 };
  const song = fontSong([
    fontTrack(0, { device: first }),
    fontTrack(1, { device: second }),
  ], { bpm: 125 });

  const host = await processorHost({ maxFontBytes: FONT_FOOTPRINT });
  host.post({ type: "song", snapshot: song });
  host.post({ type: "library", request_id: "first", library_id: "font-first", kind: "font", bytes: Uint8Array.from(FONT_BYTES) });
  await host.flush();
  host.post({ type: "library", request_id: "second", library_id: "font-second", kind: "font", bytes: Uint8Array.from(FONT_BYTES) });
  await host.flush();
  assert.equal(answersTo(host.posts, "second")[0].ok, false);
  const neededBefore = postsOfType(host.posts, "library_needed").filter((message) => message.library_id === "font-second").length;

  host.post({ type: "library_unload", library_id: "font-first" });
  await host.flush();
  const neededAfter = postsOfType(host.posts, "library_needed").filter((message) => message.library_id === "font-second").length;
  assert.equal(neededAfter, neededBefore + 1, "unloading the other bank has to make the refused one needed again");
});

test("an engine with no font host keeps each processor's own tracks", async () => {
  // The no-op host is per PROCESSOR: two engines in one process must not share
  // (or clear) each other's soundfont tracks.
  const first = await processorHost({ withoutFontHost: true });
  const second = await processorHost({ withoutFontHost: true });
  const songA = fontSong([fontTrack(0, { device: { engine: "soundfont", font_id: "font-a", bank: 0, program: 0 } })], { bpm: 125 });
  const songB = fontSong([fontTrack(0, { device: { engine: "soundfont", font_id: "font-b", bank: 0, program: 0 } })], { bpm: 125 });
  first.post({ type: "song", snapshot: songA });
  await first.flush();
  second.post({ type: "song", snapshot: songB });
  await second.flush();

  assert.deepEqual(first.processor.fonts.missing(), ["font-a"], "the first processor keeps its own tracks");
  assert.deepEqual(second.processor.fonts.missing(), ["font-b"], "the second processor keeps its own tracks");
  first.processor.fonts.destroy();
  assert.deepEqual(second.processor.fonts.missing(), ["font-b"], "destroying one no-op host must not clear another's tracks");
  assert.deepEqual(
    postsOfType(first.posts, "library_needed").map((message) => message.library_id),
    ["font-a"],
  );
  assert.deepEqual(
    postsOfType(second.posts, "library_needed").map((message) => message.library_id),
    ["font-b"],
  );
});

test("an empty library id fails without posting anything", async () => {
  // A load with no id names nothing: the client answers it at once and posts
  // nothing the processor would have to ignore.
  const context = new OfflineAudioContext({ numberOfChannels: 2, length: 128, sampleRate: SAMPLE_RATE });
  let engine = null;
  try {
    engine = await studioEngine.create(context, { assetBytes: ASSETS });
    let posted = 0;
    const port = engine.node.port;
    const realPost = port.postMessage.bind(port);
    port.postMessage = function countingPost(...args) {
      posted += 1;
      return realPost(...args);
    };
    const result = await engine.loadLibrary("", "font", new Uint8Array(4));
    assert.deepEqual(result, { status: "failed", reason: "A library load needs an id." });
    assert.equal(posted, 0, "an empty library id must not post a message");
  } finally {
    if (engine) engine.dispose();
    await releaseWorklet(context);
  }
});

test("two fonts over the cap do not evict each other", async () => {
  // One font's footprint of room. The song plays two fonts, so neither may be
  // pushed out to make room for the other: the load is refused with the reason
  // the page shows. A font no track of the song plays is evicted as usual.
  const host = await processorHost({ maxFontBytes: FONT_FOOTPRINT });
  const tracks = [
    fontTrack(0, { device: { engine: "soundfont", font_id: "font-first", bank: 0, program: 0 } }),
    fontTrack(1, { device: { engine: "soundfont", font_id: "font-second", bank: 0, program: 1 } }),
  ];
  host.post({ type: "song", snapshot: fontSong(tracks, { bpm: 125 }) });

  // A font nothing plays goes first: it is the only thing the cap may take.
  host.post({ type: "library", request_id: "unused", library_id: "font-unused", kind: "font", bytes: Uint8Array.from(FONT_BYTES) });
  await host.flush();
  assert.deepEqual(host.processor.fonts.loadedIds(), ["font-unused"]);

  // The song's own first font takes the room the unused one was using.
  host.post({ type: "library", request_id: "first", library_id: "font-first", kind: "font", bytes: Uint8Array.from(FONT_BYTES) });
  await host.flush();
  assert.deepEqual(host.processor.fonts.loadedIds(), ["font-first"], "an unused font is evicted to make room");
  assert.equal(answersTo(host.posts, "first")[0].ok, true);

  // The song's second font has no room left, and the first one may not go.
  host.post({ type: "library", request_id: "second", library_id: "font-second", kind: "font", bytes: Uint8Array.from(FONT_BYTES) });
  await host.flush();
  assert.deepEqual(host.processor.fonts.loadedIds(), ["font-first"], "a font the song plays is never evicted");
  const refused = answersTo(host.posts, "second");
  assert.equal(refused.length, 1);
  assert.equal(refused[0].ok, false);
  assert.match(
    String(refused[0].reason),
    /^This song's instruments need more than .* MB; remove an instrument or use a smaller bank\.$/,
    `the refusal has to say what to do, it said ${refused[0].reason}`,
  );
  const failed = postsOfType(host.posts, "library_failed");
  assert.equal(failed.length, 1, `expected one library_failed, got ${JSON.stringify(failed)}`);
  assert.equal(failed[0].library_id, "font-second");

  // The font the song kept still plays; the refused one's track is silent.
  host.post({ type: "launchScene", id: "scene-1" });
  host.post({ type: "play" });
  await host.flush();
  const out = host.run(32);
  const kept = toneAmplitude(out.left, 0, 4096, toneOf(0, 0));
  const refusedTone = toneAmplitude(out.left, 0, 4096, toneOf(0, 1));
  assert.ok(kept > 0.01, `the font that stayed loaded has to play its track, it reads ${kept}`);
  assert.ok(
    refusedTone < kept / 20,
    `the refused font's track has to be silent, it reads ${refusedTone} against ${kept}`,
  );
});

test("a font with no font host is reported once and allocates nothing per block", async () => {
  // A module composed without `font-voice.js` has no synth at all: every
  // soundfont track is silent, and every font they name is reported (once per
  // id) so the page can say what is missing. Nothing is allocated per block.
  const host = await processorHost({ withoutFontHost: true });
  const tracks = [
    fontTrack(0, { device: { engine: "soundfont", font_id: "font-a", bank: 0, program: 0 } }),
    fontTrack(1, { device: { engine: "soundfont", font_id: "font-b", bank: 0, program: 1 } }),
    fontTrack(2, { device: { engine: "soundfont", font_id: "font-a", bank: 128, program: 0 } }),
  ];
  host.post({ type: "song", snapshot: fontSong(tracks, { bpm: 125 }) });
  host.post({ type: "launchScene", id: "scene-1" });
  host.post({ type: "play" });
  await host.flush();

  const needed = postsOfType(host.posts, "library_needed").map((message) => message.library_id);
  assert.deepEqual(needed.sort(), ["font-a", "font-b"], `every font has to be asked for once, got ${JSON.stringify(needed)}`);
  host.run(8);
  assert.equal(
    postsOfType(host.posts, "library_needed").length,
    2,
    "a font already asked for is not asked for again on every block",
  );
  const silent = host.run(8);
  assert.ok(peakOf(silent.left) < 1e-9, `there is nothing to play them, so they are silent, peak was ${peakOf(silent.left)}`);

  // The per-run path is allocation-free: the same (empty) map and the same
  // (empty) lists come back every time.
  const fonts = host.processor.fonts;
  assert.equal(fonts.process(128), fonts.process(128), "a host with no synth must hand back the same map every run");
  assert.equal(fonts.takeEvicted(), fonts.takeEvicted(), "and the same (empty) eviction list");
  assert.equal(fonts.takeFailures(), fonts.takeFailures(), "and the same (empty) failure list");
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
});

test("the synth's own main pair is never mixed into a track", async () => {
  // A reverb-send comparison (0 vs 127) CANNOT fail: `channelOutputs` is
  // documented as each channel's DRY data, and even with `effectsEnabled: true`
  // the synth writes reverb/chorus/delay into its own main pair and effect
  // blocks only, never into a channel's dry pair. So the test gives the synth's
  // main L/R a distinct signal instead: the wrapper writes a ±0.5 DC offset
  // into the main pair after the synth has rendered (which is exactly what a
  // live effect's wet output would look like there) and the track's output must
  // stay BIT-IDENTICAL to the dry render. A host that read the main pair — or
  // an engine that passed effects through — would show the DC at once.
  const dry = await renderReleasedNote({ injectMain: false });
  const injected = await renderReleasedNote({ injectMain: true });
  assert.ok(injected.frames > 0, "the test has to have written its signal into the main pair");
  assert.deepEqual(injected.samples, dry.samples, "the synth's main L/R must never reach a track");
  assert.ok(
    Math.abs(meanOf(dry.samples.subarray(0, 4096))) < 0.001,
    `the track carries the dry note, not the main pair's DC: mean was ${meanOf(dry.samples.subarray(0, 4096))}`,
  );

  // And the released tail is a real release, not a cut: it sounds right after
  // the note off, and it decays.
  const early = peakOf(dry.samples.subarray(2048, 4096));
  const late = peakOf(dry.samples.subarray(dry.samples.length - 2048));
  assert.ok(early > 0.01, `the released note has to still sound, peak was ${early}`);
  assert.ok(late < early / 2, `the release has to decay, it went from ${early} to ${late}`);
});

/**
 * Render the long-release preset's note held for 2048 frames and then released
 * for a second. With `injectMain`, the synth's main pair is overwritten with a
 * distinct DC signal after every render, so anything that read it would show.
 * @param {{injectMain?: boolean}} [options]
 * @returns {Promise<{samples: Float32Array, frames: number}>} the track's own
 *   (dry) left channel, and how many frames of main signal were written
 */
async function renderReleasedNote(options = {}) {
  const host = await loadedHost();
  host.assign([{ track_id: "track-1", font_id: FONT_ID, bank: 0, program: 8 }]);
  const synth = host.fontSynth(FONT_ID);
  assert.ok(synth, "the host has to hold the bank's synth");
  let frames = 0;
  if (options.injectMain === true) {
    const realProcess = synth.process.bind(synth);
    synth.process = function processWithMainSignal(left, right, start, count, channels) {
      realProcess(left, right, start, count, channels);
      left.fill(0.5, start, start + count);
      right.fill(-0.5, start, start + count);
      frames += count;
    };
  }
  host.noteOn("track-1", 60, 100);
  const heldFrames = 2048;
  const tailFrames = SAMPLE_RATE;
  const out = new Float32Array(heldFrames + tailFrames);
  host.process(heldFrames);
  out.set(host.outputFor("track-1").left.subarray(0, heldFrames), 0);
  host.noteOff("track-1", 60);
  for (let at = 0; at < tailFrames; at += 512) {
    const count = Math.min(512, tailFrames - at);
    host.process(count);
    out.set(host.outputFor("track-1").left.subarray(0, count), heldFrames + at);
  }
  return { samples: out, frames: frames };
}

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

test("every soundfont track of a song sounds on its own", async () => {
  // Three tracks on one bank, told apart by program. Each is rendered alone (the
  // others muted) and has to sound: a channel that never reaches its track — the
  // per-run path rendering only some of a font's channels — would hide inside a
  // mix that is still audible.
  const tracks = [fontTrack(0, { gain_db: -6 }), fontTrack(1, { gain_db: -6 }), fontTrack(2, { gain_db: -6 })];
  for (let solo = 0; solo < tracks.length; solo += 1) {
    const muted = tracks.map((track, index) => (index === solo ? track : { ...track, mute: true }));
    const render = await renderSong(fontSong(muted), { seconds: 0.5, fonts: [{ id: FONT_ID, bytes: FONT_BYTES }] });
    assertTone(
      render.left,
      2048,
      8192,
      toneOf(0, solo),
      undefined,
      `track ${solo + 1} has to sound on its own`,
      0.005,
    );
  }
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

test("a loaded bank lists its presets", async () => {
  // The page's instrument picker lists a bank's own presets, and only the engine
  // can read them. A load's answer therefore carries them: `{bank, program,
  // name}`, sorted by bank and then program, with the GM drum bank as 128
  // whatever number the file wrote its kit with. They are read on the message
  // path — when the load is answered — and never inside `process()`.
  const host = await processorHost();
  host.post({ type: "song", snapshot: fontSong([fontTrack(0)], { bpm: 125 }) });
  host.post({ type: "library", request_id: "presets", library_id: FONT_ID, kind: "font", bytes: Uint8Array.from(FONT_BYTES) });
  await host.flush();

  const answers = postsOfType(host.posts, "library_loaded").filter((message) => message.request_id === "presets");
  assert.equal(answers.length, 1, `the load has to be answered once, got ${JSON.stringify(answers)}`);
  assert.equal(answers[0].ok, true);
  assert.deepEqual(
    answers[0].presets,
    TINY_SF2_PRESETS.map((preset) => ({ bank: preset.bank, program: preset.program, name: preset.name })),
    "the bank's presets, in bank then program order",
  );
  // Bank 128 is the drum bank, and it sorts last.
  assert.equal(answers[0].presets[answers[0].presets.length - 1].bank, 128);
  // A failed load has no presets to name, and says why instead.
  const corrupt = await processorHost();
  corrupt.post({ type: "song", snapshot: fontSong([fontTrack(0)], { bpm: 125 }) });
  corrupt.post({
    type: "library",
    request_id: "empty",
    library_id: FONT_ID,
    kind: "font",
    bytes: tinySf2({ presets: [] }),
  });
  await corrupt.flush();
  const refused = postsOfType(corrupt.posts, "library_loaded").filter((message) => message.request_id === "empty");
  assert.equal(refused.length, 1);
  assert.equal(refused[0].ok, false);
  assert.equal(refused[0].presets, undefined, "a bank that would not load lists nothing");
  assert.match(String(refused[0].reason), /no instruments/);
});