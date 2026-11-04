/**
 * Studio PCM voices — audio clips, their comps, and the resampler.
 *
 * The renders are the real engine: `node-web-audio-api`'s OfflineAudioContext
 * with the very same `bundles/studio/engine/engine-client.js` the browser and
 * the MCP renderer load. Every take here is synthetic — an impulse at a known
 * frame, or a constant, or a ramp — so the tests can name the frame a sample
 * has to land on rather than guess from a level.
 *
 * Read of rendered audio is always `copyFromChannel()` into a JS-owned array:
 * `getChannelData()` does not work in node-web-audio-api (#714). The take PCM
 * a test hands to `loadAudio()` is copied per render, because the client
 * transfers the arrays to the worklet.
 *
 * At 120 bpm and 48 kHz one beat is 24,000 frames and one bar is 96,000.
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
const StudioResample = bundleRequire(join(ENGINE_DIR, "resample.js"));

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

const SAMPLE_RATE = 48000;
const FRAMES_PER_BEAT = 24000;

/** A take in the document's shape (`server/doc.js`), naming one clip. */
function take(id, overrides = {}) {
  return {
    id,
    clip_id: "clip-1",
    storage_key: `studio/song-1/takes/${id}.wav`,
    rate: SAMPLE_RATE,
    channels: 1,
    frames: 4800,
    offset_frames: 0,
    compensated: false,
    bpm: 120,
    recorded_at: "2026-11-02T12:00:00.000Z",
    author_label: "the operator",
    discarded: false,
    ...overrides,
  };
}

/**
 * One audio song: a single audio track, one scene, one audio clip holding the
 * comp, and the takes the comp names.
 * @param {{comp: object[], takes?: object[], lengthBars?: number, track?: object,
 *          arrangement?: object}} options `arrangement` puts the song on the
 *   timeline instead of in a scene
 * @returns {object} a snapshot in the shape `server/doc.js` writes
 */
function audioSong({ comp, takes = [], lengthBars = 1, track = {}, arrangement = null }) {
  const song = {
    meta: { title: "Audio", bpm: 120, meter: [4, 4], key: "C major" },
    tracks: [
      {
        id: "track-1",
        name: "Guitar",
        color: "#E8C07A",
        device: { engine: "audio" },
        mute: false,
        solo: false,
        gain_db: 0,
        pan: 0,
        locked: false,
        ...track,
      },
    ],
    scenes: [{ id: "scene-1", name: "A" }],
    clips: {
      "clip-1": {
        id: "clip-1",
        track_id: "track-1",
        scene_id: "scene-1",
        name: "Guitar",
        length_bars: lengthBars,
        kind: "audio",
        notes: [],
        comp,
      },
    },
    takes: Object.fromEntries(takes.map((item) => [item.id, item])),
  };
  if (arrangement) song.arrangement = arrangement;
  return song;
}

/** A placement in the snapshot's shape, with 0 fades unless a test sets them. */
function placement(id, trackId, clipId, startBar, bars, over = {}) {
  return {
    id,
    track_id: trackId,
    clip_id: clipId,
    start_bar: startBar,
    bars,
    offset_beats: 0,
    fade_in_beats: 0,
    fade_out_beats: 0,
    ...over,
  };
}

/** A whole arrangement, keyed by placement id the way `doc.js` writes it. */
function arrangementOf(items) {
  return {
    placements: Object.fromEntries(items.map((item) => [item.id, item])),
    markers: {},
    sections: {},
  };
}

/** @param {number} frames @param {number} at @returns {Float32Array} silence with one 1.0 */
function impulse(frames, at) {
  const samples = new Float32Array(frames);
  samples[at] = 1;
  return samples;
}

/** @param {number} frames @param {number} value @returns {Float32Array} a constant */
function constant(frames, value) {
  const samples = new Float32Array(frames);
  samples.fill(value);
  return samples;
}

/** @param {number} frames @returns {Float32Array} 1e-5, 2e-5, … — every sample its own level */
function ramp(frames) {
  const samples = new Float32Array(frames);
  for (let at = 0; at < frames; at += 1) samples[at] = (at + 1) / 100000;
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

/** @param {Float32Array} samples @returns {number} the index of the largest absolute sample */
function peakIndex(samples) {
  let index = 0;
  let peak = 0;
  for (let at = 0; at < samples.length; at += 1) {
    const value = Math.abs(samples[at]);
    if (value > peak) {
      peak = value;
      index = at;
    }
  }
  return index;
}

/** @param {BaseAudioContext} context @returns {Promise<void>} */
async function releaseWorklet(context) {
  try {
    await context.audioWorklet[kWorkletRelease]();
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
async function waitFor(predicate, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!predicate() && Date.now() < deadline) await delay(10);
  return predicate();
}

/**
 * Render one audio song offline in Node: build the engine, hand it the takes,
 * then the song, launch the scene, play, render.
 * @param {object} song
 * @param {{seconds?: number, sampleRate?: number, audio?: object[],
 *          mode?: "session"|"arrangement", fromBar?: number,
 *          onError?: (text: string) => void}} [options] `audio` is one
 *   `{id, channels, rate}` per take to load; `mode: "arrangement"` plays the
 *   song's timeline from `fromBar` instead of launching its scene
 * @returns {Promise<{left: Float32Array, right: Float32Array, sampleRate: number}>}
 */
async function renderAudioSong(
  song,
  { seconds = 1, sampleRate = SAMPLE_RATE, audio = [], mode = "session", fromBar = 0, onError } = {},
) {
  const context = new OfflineAudioContext({
    numberOfChannels: 2,
    length: Math.round(seconds * sampleRate),
    sampleRate,
  });
  let engine = null;
  let rendered = false;
  try {
    engine = await studioEngine.create(context, { assetBytes: ASSETS });
    if (typeof onError === "function") engine.onError(onError);
    for (const item of audio) {
      // A fresh copy per render: loadAudio transfers the buffers to the worklet.
      const channels = item.channels.map((channel) => Float32Array.from(channel));
      await engine.loadAudio(item.id, channels, item.rate);
    }
    engine.setSong(song);
    if (mode === "arrangement") {
      engine.setMode("arrangement");
      engine.seek(fromBar);
    } else {
      engine.launchScene("scene-1");
    }
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
    return { left, right, sampleRate };
  } finally {
    if (engine) engine.dispose();
    if (!rendered) await releaseWorklet(context);
  }
}

/** The centre-pan coefficient the mix applies to a track at 0 dB and pan 0. */
const CENTRE = Math.cos(Math.PI / 4);

test("audio clip plays its take from beat 0 (sample-exact)", async () => {
  const samples = ramp(4800);
  const song = audioSong({
    comp: [{ take_id: "take-1", from_beat: 0, to_beat: 4 }],
    takes: [take("take-1", { frames: 4800 })],
  });
  const { left, right } = await renderAudioSong(song, {
    seconds: 0.2,
    audio: [{ id: "take-1", channels: [samples], rate: SAMPLE_RATE }],
  });

  for (const at of [0, 1, 2, 100, 1234, 4799]) {
    const want = samples[at] * CENTRE;
    assert.ok(
      Math.abs(left[at] - want) < 1e-7,
      `left frame ${at}: expected ${want}, got ${left[at]} (the take has to start on the very first frame)`,
    );
    assert.ok(
      Math.abs(right[at] - want) < 1e-7,
      `right frame ${at}: expected ${want}, got ${right[at]} (a mono take plays to both channels)`,
    );
  }

  // The take runs out at frame 4800: nothing after it, and nothing before 0.
  for (const at of [4800, 5000, 9599]) {
    assert.equal(left[at], 0, `frame ${at} is past the end of the take and has to be silent`);
    assert.equal(right[at], 0, `right frame ${at} is past the end of the take and has to be silent`);
  }
});

test("offset_frames shifts the take earlier by that many frames", async () => {
  const plainSong = audioSong({
    comp: [{ take_id: "plain", from_beat: 0, to_beat: 4 }],
    takes: [take("plain", { frames: 4000 })],
  });
  const plain = await renderAudioSong(plainSong, {
    seconds: 0.1,
    audio: [{ id: "plain", channels: [impulse(4000, 1000)], rate: SAMPLE_RATE }],
  });
  assert.equal(peakIndex(plain.left), 1000, "with no offset the impulse stays where it was recorded");

  // The take's frame `offset_frames` is what sounds at clip beat 0, so the
  // whole take moves earlier by exactly that many frames.
  const offsetSong = audioSong({
    comp: [{ take_id: "offset", from_beat: 0, to_beat: 4 }],
    takes: [take("offset", { frames: 4000, offset_frames: 300 })],
  });
  const shifted = await renderAudioSong(offsetSong, {
    seconds: 0.1,
    audio: [{ id: "offset", channels: [impulse(4000, 1000)], rate: SAMPLE_RATE }],
  });
  assert.equal(peakIndex(shifted.left), 700, "300 frames of offset move the take 300 frames earlier");
});

test("comp switches takes at the boundary with a 64-sample linear crossfade", async () => {
  const song = audioSong({
    comp: [
      { take_id: "first", from_beat: 0, to_beat: 2 },
      { take_id: "second", from_beat: 2, to_beat: 4 },
    ],
    takes: [take("first", { frames: 96000 }), take("second", { frames: 96000 })],
  });
  const { left } = await renderAudioSong(song, {
    seconds: 1.1,
    audio: [
      { id: "first", channels: [constant(96000, 1)], rate: SAMPLE_RATE },
      { id: "second", channels: [constant(96000, 0.5)], rate: SAMPLE_RATE },
    ],
  });

  const boundary = 2 * FRAMES_PER_BEAT; // 48,000: beat 2 of the first bar
  for (const at of [0, 1, 100, boundary - 1]) {
    assert.ok(
      Math.abs(left[at] - CENTRE) < 1e-6,
      `frame ${at} is before the boundary and has to be the first take alone, got ${left[at]}`,
    );
  }

  // The 64 frames of the crossfade: the first take 1 → 0 while the second goes
  // 0 → 1, so their gains add up to one at every frame.
  for (let step = 0; step < 64; step += 1) {
    const want = (1 * (1 - step / 64) + 0.5 * (step / 64)) * CENTRE;
    assert.ok(
      Math.abs(left[boundary + step] - want) < 1e-6,
      `crossfade frame ${step}: expected ${want}, got ${left[boundary + step]}`,
    );
  }

  for (const step of [64, 100, 3000]) {
    const want = 0.5 * CENTRE;
    assert.ok(
      Math.abs(left[boundary + step] - want) < 1e-6,
      `frame ${boundary + step} is past the crossfade and has to be the second take alone, got ${left[boundary + step]}`,
    );
  }
});

test("discarded take is silent", async () => {
  const song = audioSong({
    comp: [{ take_id: "thrown-away", from_beat: 0, to_beat: 4 }],
    takes: [take("thrown-away", { frames: 4800, discarded: true })],
  });
  const { left, right } = await renderAudioSong(song, {
    seconds: 0.2,
    audio: [{ id: "thrown-away", channels: [constant(4800, 0.5)], rate: SAMPLE_RATE }],
  });
  const peak = Math.max(peakOf(left), peakOf(right));
  assert.equal(peak, 0, `a discarded take never sounds, but the render peaked at ${peak}`);
});

test("track gain and pan apply to audio tracks", async () => {
  const song = (over = {}) =>
    audioSong({
      comp: [{ take_id: "take-1", from_beat: 0, to_beat: 4 }],
      takes: [take("take-1", { frames: 4800 })],
      track: over,
    });
  const audio = [{ id: "take-1", channels: [constant(4800, 0.25)], rate: SAMPLE_RATE }];

  const centre = await renderAudioSong(song(), { seconds: 0.1, audio });
  const quiet = await renderAudioSong(song({ gain_db: -6 }), { seconds: 0.1, audio });
  const leftOnly = await renderAudioSong(song({ pan: -1 }), { seconds: 0.1, audio });

  const reference = peakOf(centre.left);
  assert.ok(reference > 0.01 && reference < 0.99, `the 0 dB reference has to be audible, peak was ${reference}`);

  const expected = Math.pow(10, -6 / 20);
  const ratio = peakOf(quiet.left) / reference;
  assert.ok(
    Math.abs(ratio - expected) / expected < 0.001,
    `−6 dB should scale an audio track by ${expected.toFixed(4)}, got ${ratio.toFixed(4)}`,
  );

  // Hard left: the whole level on the left channel (cos 0 = 1) and nothing at all
  // on the right, exactly like a SunVox track panned the same way.
  assert.ok(
    Math.abs(peakOf(leftOnly.left) - 0.25) < 1e-6,
    `a hard-left audio track should peak at its own 0.25, got ${peakOf(leftOnly.left)}`,
  );
  assert.ok(
    peakOf(leftOnly.right) < 1e-9,
    `pan −1 should leave the right channel empty, peak was ${peakOf(leftOnly.right)}`,
  );
});

test("missing take is silent and reported once", async () => {
  const errors = [];
  const song = audioSong({
    comp: [
      { take_id: "ghost", from_beat: 0, to_beat: 1 },
      { take_id: "ghost", from_beat: 2, to_beat: 3 },
    ],
    takes: [],
  });
  const { left, right } = await renderAudioSong(song, {
    seconds: 1.5,
    onError: (text) => errors.push(text),
  });

  const peak = Math.max(peakOf(left), peakOf(right));
  assert.equal(peak, 0, `a take that was never loaded plays silence, but the render peaked at ${peak}`);

  assert.ok(await waitFor(() => errors.length > 0), "expected the missing take to be reported");
  await delay(100);
  assert.equal(errors.length, 1, `expected one report for the take, got ${errors.length}: ${errors.join(" | ")}`);
  assert.match(errors[0], /Take ghost is not loaded yet\./, `unexpected report: ${errors[0]}`);
});

test("44.1 kHz take in a 48 kHz render lands on the same beat", async () => {
  // The same note, 0.1 s into the take, recorded at each rate: the renderer
  // resamples the 44.1 kHz take at load, so both impulses have to land on the
  // frame 0.1 s after the clip started.
  const at48 = impulse(9600, 4800);
  const at441 = impulse(8820, 4410);

  const songAt = (id, rate) =>
    audioSong({
      comp: [{ take_id: id, from_beat: 0, to_beat: 4 }],
      takes: [take(id, { rate, frames: rate === 44100 ? 8820 : 9600 })],
    });

  const native = await renderAudioSong(songAt("native", 48000), {
    seconds: 0.2,
    audio: [{ id: "native", channels: [at48], rate: 48000 }],
  });
  const converted = await renderAudioSong(songAt("converted", 44100), {
    seconds: 0.2,
    audio: [{ id: "converted", channels: [at441], rate: 44100 }],
  });

  assert.equal(peakIndex(native.left), 4800, "a 48 kHz take keeps its own frames");
  const landed = peakIndex(converted.left);
  assert.ok(
    Math.abs(landed - 4800) <= 2,
    `the 44.1 kHz impulse should land at frame 4800 of the 48 kHz render, it landed at ${landed}`,
  );
});

/** @returns {number} the frequency of a sine, from its interpolated upward zero crossings */
function frequencyOf(samples, sampleRate) {
  const crossings = [];
  for (let at = 1; at < samples.length; at += 1) {
    const before = samples[at - 1];
    const now = samples[at];
    if (before < 0 && now >= 0) {
      const span = now - before;
      crossings.push(at - 1 + (span === 0 ? 0 : -before / span));
    }
  }
  assert.ok(crossings.length > 2, "expected a sine with several periods to measure");
  const periods = crossings.length - 1;
  return (periods * sampleRate) / (crossings[crossings.length - 1] - crossings[0]);
}

test("resampler is identity at equal rates and preserves a 1 kHz sine's frequency within 0.1%", () => {
  const original = new Float32Array(1000);
  for (let at = 0; at < original.length; at += 1) original[at] = Math.sin(at / 10);

  const same = StudioResample.toRate([original], 48000, 48000);
  assert.equal(same.length, 1);
  assert.equal(same[0].length, original.length);
  assert.notEqual(same[0], original, "the identity returns copies, so a caller can keep both");
  assert.deepEqual(Array.from(same[0]), Array.from(original));

  for (const [from, to] of [
    [48000, 44100],
    [44100, 48000],
  ]) {
    const sine = new Float32Array(from / 2);
    for (let at = 0; at < sine.length; at += 1) sine[at] = Math.sin((2 * Math.PI * 1000 * at) / from);
    const converted = StudioResample.toRate([sine], from, to);
    assert.equal(converted.length, 1);
    assert.equal(
      converted[0].length,
      Math.round((sine.length * to) / from),
      `a ${from} Hz signal has to keep its duration at ${to} Hz`,
    );
    const measured = frequencyOf(converted[0], to);
    const error = Math.abs(measured - 1000) / 1000;
    assert.ok(
      error < 0.001,
      `${from} → ${to}: expected 1000 Hz within 0.1%, measured ${measured.toFixed(2)} Hz (${(error * 100).toFixed(3)}% off)`,
    );
  }
});

// --- the arrangement --------------------------------------------------------

test("fade in ramps linearly from silence", async () => {
  const frames = 2 * 4 * FRAMES_PER_BEAT; // two bars of take, so the ramp is inside it
  const song = audioSong({
    comp: [{ take_id: "take-1", from_beat: 0, to_beat: 8 }],
    takes: [take("take-1", { frames })],
    lengthBars: 2,
    arrangement: arrangementOf([
      placement("p1", "track-1", "clip-1", 0, 2, { fade_in_beats: 1 }),
    ]),
  });

  const { left } = await renderAudioSong(song, {
    seconds: 0.6,
    mode: "arrangement",
    audio: [{ id: "take-1", channels: [constant(frames, 0.5)], rate: SAMPLE_RATE }],
  });

  // A fade in of one beat is FRAMES_PER_BEAT frames of linear gain, from 0 at
  // the placement's first frame to 1 at the frame one beat later.
  const ramp = FRAMES_PER_BEAT;
  assert.equal(left[0], 0, "a fade in starts from silence");
  for (const at of [1, 100, 3000, ramp / 2, ramp - 1]) {
    const want = 0.5 * (at / ramp) * CENTRE;
    assert.ok(
      Math.abs(left[at] - want) < 1e-6,
      `fade in frame ${at}: expected ${want}, got ${left[at]} (linear from silence to the take's own level)`,
    );
  }
  for (const at of [ramp, ramp + 1, 28000, 28799]) {
    const want = 0.5 * CENTRE;
    assert.ok(
      Math.abs(left[at] - want) < 1e-6,
      `frame ${at} is past the fade and has to be the take at full level, got ${left[at]}`,
    );
  }
});

test("a comp boundary inside a fade out keeps fading", async () => {
  // One two-bar placement that fades out over its last four beats, with the
  // comp switching takes half way through that fade: the ramp has to carry on
  // on the voice the comp boundary starts, not restart at full gain and not
  // drop out with the voice that stops.
  const frames = 2 * 4 * FRAMES_PER_BEAT;
  const song = audioSong({
    comp: [
      { take_id: "first", from_beat: 0, to_beat: 6 },
      { take_id: "second", from_beat: 6, to_beat: 8 },
    ],
    takes: [take("first", { frames }), take("second", { frames })],
    lengthBars: 2,
    arrangement: arrangementOf([placement("p1", "track-1", "clip-1", 0, 2, { fade_out_beats: 4 })]),
  });

  const { left } = await renderAudioSong(song, {
    seconds: 3.6,
    mode: "arrangement",
    audio: [
      { id: "first", channels: [constant(frames, 0.5)], rate: SAMPLE_RATE },
      { id: "second", channels: [constant(frames, 0.5)], rate: SAMPLE_RATE },
    ],
  });

  // The fade out runs over the placement's last four beats (frames 96000 to
  // 192000), and clip beat 6 — the comp boundary — is frame 144000 of it.
  const fadeStart = 4 * FRAMES_PER_BEAT;
  const boundary = 6 * FRAMES_PER_BEAT;
  const fadeFrames = 4 * FRAMES_PER_BEAT;
  for (const at of [fadeStart + 1000, boundary - 100, boundary + 64, boundary + 1000, boundary + 20000]) {
    const gain = 1 - (at - fadeStart) / fadeFrames;
    const want = 0.5 * gain * CENTRE;
    assert.ok(
      Math.abs(left[at] - want) < 1e-3,
      `frame ${at}: expected ${want} (the fade is at ${gain}), got ${left[at]} — the ramp has to continue on the take the comp switched to`,
    );
  }

  // The level cannot have jumped back to full gain at the boundary either.
  assert.ok(left[boundary - 100] < 0.5 * CENTRE, "the fade out is still ramping down before the comp boundary");
});

test("seek into a fade in starts at the faded gain", async () => {
  // A two-bar clip under a four-bar placement that fades in over eight beats:
  // seeking to bar 1 lands on the half-way point of that ramp, so the first
  // frame of the render has to be the take at half level, not at full. The
  // take is three bars long, so nothing runs out under the ramp.
  const frames = 3 * 4 * FRAMES_PER_BEAT;
  const song = audioSong({
    comp: [{ take_id: "take-1", from_beat: 0, to_beat: 8 }],
    takes: [take("take-1", { frames })],
    lengthBars: 2,
    arrangement: arrangementOf([placement("p1", "track-1", "clip-1", 0, 4, { fade_in_beats: 8 })]),
  });

  const { left } = await renderAudioSong(song, {
    seconds: 2.1,
    mode: "arrangement",
    fromBar: 1,
    audio: [{ id: "take-1", channels: [constant(frames, 0.5)], rate: SAMPLE_RATE }],
  });

  // Four of the eight beats of the fade are behind the seek: the gain there is
  // 0.5, and the four beats that are left ramp it back to 1.
  const remaining = 4 * FRAMES_PER_BEAT;
  assert.ok(Math.abs(left[0] - 0.5 * 0.5 * CENTRE) < 1e-6, `frame 0 should be at half the gain, got ${left[0]}`);
  for (const at of [1, 100, 5000, remaining - 1]) {
    const want = 0.5 * (0.5 + 0.5 * (at / remaining)) * CENTRE;
    assert.ok(
      Math.abs(left[at] - want) < 1e-6,
      `frame ${at}: expected ${want}, got ${left[at]} (the ramp continues from where the seek landed)`,
    );
  }
  const past = 0.5 * CENTRE;
  assert.ok(
    Math.abs(left[remaining + 100] - past) < 1e-6,
    `past the fade the take is at full level, got ${left[remaining + 100]}`,
  );
});

test("a split half with a fade out does not silence the next half", async () => {
  // A split where the first half fades out over its own bar: the second half
  // continues the clip exactly, so joining the two would put the whole take on
  // one voice whose gain has reached 0 at the seam — and the second half would
  // play silence. A fade at the seam has to keep the two halves on two voices.
  const frames = 2 * 4 * FRAMES_PER_BEAT;
  const song = audioSong({
    comp: [{ take_id: "take-1", from_beat: 0, to_beat: 8 }],
    takes: [take("take-1", { frames })],
    lengthBars: 2,
    arrangement: arrangementOf([
      placement("p1", "track-1", "clip-1", 0, 1, { fade_out_beats: 4 }),
      placement("p2", "track-1", "clip-1", 1, 1, { offset_beats: 4 }),
    ]),
  });

  const { left } = await renderAudioSong(song, {
    seconds: 4.1,
    mode: "arrangement",
    audio: [{ id: "take-1", channels: [constant(frames, 0.5)], rate: SAMPLE_RATE }],
  });

  const seam = 4 * FRAMES_PER_BEAT;
  const want = 0.5 * CENTRE;
  for (const at of [seam + 100, seam + 1000, seam + 30000, seam + 90000]) {
    assert.ok(
      Math.abs(left[at] - want) < 1e-3,
      `frame ${at} is the second half of the split and has to sound at full level ${want}, got ${left[at]}`,
    );
  }
});

test("split audio placements play without a click", async () => {
  // Two bars of audio in a two-bar clip, so the second half of a split starts
  // four beats into the take — exactly where the first half stopped.
  const frames = 2 * 4 * FRAMES_PER_BEAT;
  const samples = new Float32Array(frames);
  for (let at = 0; at < frames; at += 1) samples[at] = Math.sin(at / 100) * 0.5;

  const songWith = (placements) =>
    audioSong({
      comp: [{ take_id: "take-1", from_beat: 0, to_beat: 8 }],
      takes: [take("take-1", { frames })],
      lengthBars: 2,
      arrangement: arrangementOf(placements),
    });
  const audio = () => [{ id: "take-1", channels: [Float32Array.from(samples)], rate: SAMPLE_RATE }];

  const whole = await renderAudioSong(songWith([placement("p1", "track-1", "clip-1", 0, 2)]), {
    seconds: 2.5,
    mode: "arrangement",
    audio: audio(),
  });
  const halves = await renderAudioSong(
    songWith([
      placement("p1", "track-1", "clip-1", 0, 1),
      placement("p2", "track-1", "clip-1", 1, 1, { offset_beats: 4 }),
    ]),
    { seconds: 2.5, mode: "arrangement", audio: audio() },
  );

  assert.ok(peakOf(whole.left) > 0.01, "the unsplit render has to be audible to compare anything");
  let differing = -1;
  for (let at = 0; at < whole.left.length; at += 1) {
    if (whole.left[at] !== halves.left[at] || whole.right[at] !== halves.right[at]) {
      differing = at;
      break;
    }
  }
  assert.equal(
    differing,
    -1,
    `half ${differing} of the split render differs from the unsplit one (a restart or a crossfade at the split)`,
  );
});