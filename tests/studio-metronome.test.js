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
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
 *          metronome?: boolean, off?: boolean, tap?: boolean}} options
 *   `metronome` turns it on before Play, `off` turns it on and straight back
 *   off before Play, and `tap` turns a master tap on
 * @returns {Promise<{left: Float32Array, right: Float32Array,
 *                    taps: object[], sampleRate: number}>}
 */
async function renderEngine({
  song,
  seconds = 2,
  sampleRate = SAMPLE_RATE,
  metronome = false,
  off = false,
  tap = false,
} = {}) {
  const context = new OfflineAudioContext({
    numberOfChannels: 2,
    length: Math.round(seconds * sampleRate),
    sampleRate,
  });
  let engine = null;
  let rendered = false;
  const taps = [];
  try {
    engine = await studioEngine.create(context, { assetBytes: ASSETS, namCores: 0 });
    engine.setSong(song);
    if (Array.isArray(song.scenes) && song.scenes.length > 0) engine.launchScene(song.scenes[0].id);
    if (tap) engine.onTap((block) => taps.push(block));
    if (metronome) engine.setMetronome(true);
    if (off) {
      engine.setMetronome(true);
      engine.setMetronome(false);
    }
    engine.play();
    if (tap) engine.tap("master", true);
    engine.node.connect(context.destination);
    await engine.flush();
    const buffer = await context.startRendering();
    rendered = true;
    return { left: channelOf(buffer, 0), right: channelOf(buffer, 1), taps, sampleRate };
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