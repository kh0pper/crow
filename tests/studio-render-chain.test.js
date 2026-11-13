/**
 * Studio — a scene render follows the clip's pattern chain.
 *
 * Kevin's acceptance (the private engineering notes): a scene whose clip has
 * the chain A, B, A at 120 bpm, rendered for 6 s, is three bars with A in bar 1,
 * B in bar 2 and A in bar 3 — not one bar of A. The first tests here render that
 * song through the REAL renderer (`node-web-audio-api` + the bundle's engine),
 * find the hits in the rendered audio and compare their frames with the bar and
 * step each one belongs to.
 *
 * The rest pin the CONTROLLER RULING that came with the item: a scene or clip
 * render that names no `seconds` lasts one full pass of the longest pattern
 * chain among the clips it launches (a clip render: that clip's chain), at the
 * song's tempo, never less than one bar — derived in exactly one place
 * (`render.js` `render()`), capped by the same render limit an explicit length
 * is, and never overriding a length the caller did give. Arrangement renders
 * still have to say how much.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderSong, createRenderer } from "../bundles/studio/server/render.js";

const SAMPLE_RATE = 48000;
const PROJECT = 7;
const PREFIX = "projects/7/";
const CLOCK = 1700000000000;

/** Two sample ids, so A and B are audibly different sounds. */
const SAMPLE_A = "3f2a1b0c-4d5e-4f60-8a71-9b2c3d4e5f61";
const SAMPLE_B = "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0e";

/**
 * The frames a sample's own audio lasts: 100 ms at 48 kHz, short enough that the
 * silence between two hits is unmistakable.
 */
const SAMPLE_FRAMES = 4800;

// --- the song ---------------------------------------------------------------

/** @returns {object} a sample as a snapshot carries it. */
function sampleOf(id, name) {
  return {
    id,
    storage_key: `${PREFIX}studio/song-1/samples/${id}.wav`,
    rate: SAMPLE_RATE,
    channels: 2,
    frames: SAMPLE_FRAMES,
    name,
    origin: "import",
    author_label: "the operator",
    slices: [],
  };
}

/** @returns {object} one pad of the kit. */
function padOf(index, sampleId) {
  return {
    track_id: "sampler-1",
    bank_id: "a",
    index,
    sample_id: sampleId,
    slice_id: null,
    name: `Pad ${index + 1}`,
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
  };
}

/** @returns {object} one step of a pattern. */
function stepOf(clipId, patternId, at, index) {
  return { clip_id: clipId, pattern_id: patternId, at, bank_id: "a", index, v: 100, locks: {} };
}

/**
 * One pattern clip on one sampler track whose chain is A, B, A. Each pattern is
 * one bar of sixteen steps at 120 bpm; A hits pad 1 on its first step and B hits
 * pad 2 on its ninth, so a render says which pattern played from the sound it
 * heard and where that sound landed.
 * @param {{chain?: string[]}} [options]
 * @returns {object}
 */
function chainSong({ chain = ["a", "b", "a"] } = {}) {
  return {
    meta: { title: "Chain", bpm: 120, meter: [4, 4], key: "C major" },
    tracks: [
      {
        id: "sampler-1",
        name: "Drums",
        color: "#E8A07A",
        device: { engine: "sampler" },
        mute: false,
        solo: false,
        gain_db: 0,
        pan: 0,
        locked: false,
      },
    ],
    scenes: [{ id: "scene-1", name: "Verse" }],
    clips: {
      "clip-1": {
        id: "clip-1",
        track_id: "sampler-1",
        scene_id: "scene-1",
        name: "Chain clip",
        kind: "pattern",
        length_steps: 16,
        step_beats: 0.25,
        swing: 0,
        chain: [...chain],
        // What `doc.js` derives for a one-bar loop; a snapshot carries it.
        length_bars: 1,
        notes: [],
      },
    },
    samples: {
      [SAMPLE_A]: sampleOf(SAMPLE_A, "Kick"),
      [SAMPLE_B]: sampleOf(SAMPLE_B, "Snare"),
    },
    pads: {
      "sampler-1/a/0": padOf(0, SAMPLE_A),
      "sampler-1/a/1": padOf(1, SAMPLE_B),
    },
    patterns: {
      "clip-1/a": { id: "a", clip_id: "clip-1", name: "A", order: 0 },
      "clip-1/b": { id: "b", clip_id: "clip-1", name: "B", order: 1 },
    },
    steps: {
      // A: pad 1 on step 1. B: pad 2 on step 9. Nothing else sounds.
      "clip-1/a/0/a.0": stepOf("clip-1", "a", 0, 0),
      "clip-1/b/8/a.1": stepOf("clip-1", "b", 8, 1),
    },
  };
}

// --- reading the rendered audio --------------------------------------------

/** A constant 100 ms burst, the sound a hit makes in these renders. */
function hitAudio() {
  return {
    rate: SAMPLE_RATE,
    channels: [new Float32Array(SAMPLE_FRAMES).fill(0.4), new Float32Array(SAMPLE_FRAMES).fill(0.4)],
  };
}

/**
 * The first frame of every run of sound in a channel, in seconds.
 * @param {Float32Array} channel
 * @param {number} [threshold] what counts as sound
 * @returns {number[]}
 */
function onsetsOf(channel, threshold = 0.05) {
  const onsets = [];
  let sounding = false;
  for (let frame = 0; frame < channel.length; frame += 1) {
    const loud = Math.abs(channel[frame]) > threshold;
    if (loud && !sounding) onsets.push(frame / SAMPLE_RATE);
    sounding = loud;
  }
  return onsets;
}

/** The tolerance a hit's frame is compared with: a few ms, well under a step. */
const HIT_TOLERANCE = 0.01;

/**
 * Assert that one hit landed where it was written (a bar and a step of 120 bpm).
 * @param {number[]} onsets
 * @param {number} index
 * @param {number} bar one-based
 * @param {number} step one-based (sixteenth note)
 */
function assertHitAt(onsets, index, bar, step) {
  const expected = (bar - 1) * 2 + ((step - 1) * 0.125);
  const found = onsets[index];
  assert.equal(typeof found, "number", `no hit ${index + 1}: found ${JSON.stringify(onsets)}`);
  assert.ok(
    Math.abs(found - expected) <= HIT_TOLERANCE,
    `hit ${index + 1} should land at bar ${bar} step ${step} (${expected} s), it landed at ${found} s`,
  );
}

// --- the acceptance: a chain render plays A, B, A ---------------------------

test("a scene render plays the clip's whole chain: A in bar 1, B in bar 2, A in bar 3", async () => {
  const song = chainSong();

  const rendered = await renderSong(song, {
    scene_id: "scene-1",
    seconds: 6,
    sampleRate: SAMPLE_RATE,
    sampleAudio: async () => hitAudio(),
  });

  assert.equal(rendered.seconds, 6, "three bars at 120 bpm is six seconds");
  assert.equal(rendered.left.length, 6 * SAMPLE_RATE);
  assert.deepEqual(rendered.missing_samples, [], "both pads' samples were loaded");

  const onsets = onsetsOf(rendered.left);
  assert.equal(onsets.length, 3, `three hits and nothing else, found ${JSON.stringify(onsets)}`);
  assertHitAt(onsets, 0, 1, 1);
  assertHitAt(onsets, 1, 2, 9);
  assertHitAt(onsets, 2, 3, 1);
});

test("a two-second render of the same song holds only pattern A's bar", async () => {
  const rendered = await renderSong(chainSong(), {
    scene_id: "scene-1",
    seconds: 2,
    sampleRate: SAMPLE_RATE,
    sampleAudio: async () => hitAudio(),
  });

  const onsets = onsetsOf(rendered.left);
  assert.equal(onsets.length, 1, `one hit and nothing else, found ${JSON.stringify(onsets)}`);
  assertHitAt(onsets, 0, 1, 1);
});

// --- the controller ruling: an omitted length is one pass -------------------

/** A database client that answers the one SELECT a render makes. */
function fakeDb() {
  return {
    async execute(statement) {
      const sql = typeof statement === "string" ? statement : statement.sql;
      if (/^\s*SELECT\s+storage_prefix/i.test(sql)) return { rows: [{ storage_prefix: PREFIX }] };
      return { rows: [] };
    },
  };
}

/** An S3 client that records what was asked of it. */
function fakeStorage() {
  return {
    uploads: [],
    async uploadObject(key, data, options) {
      this.uploads.push({ key, data, options });
    },
    async getPresignedUrl(key) {
      return `https://storage.invalid/${key}?signature=test`;
    },
    async deleteObject() {},
  };
}

/** A project ACL that allows everything. */
function fakeAcl() {
  return {
    async assertLocalCapability() {
      return { role: "owner" };
    },
    async appendAudit() {},
  };
}

/** @returns {object} the audio a stubbed renderer answers with. */
function stubAudio() {
  return { left: new Float32Array(480), right: new Float32Array(480), sampleRate: SAMPLE_RATE, seconds: 0.01 };
}

/**
 * A renderer whose audio side is stubbed: it records what `renderSong` would
 * have been asked, so the LENGTH the renderer derived can be read directly.
 * @param {{maxSeconds?: number}} [options]
 * @returns {{renderer: object, asked: object[]}}
 */
function lengthRenderer({ maxSeconds = 300 } = {}) {
  const asked = [];
  const renderer = createRenderer({
    db: fakeDb(),
    storage: fakeStorage(),
    acl: fakeAcl(),
    maxSeconds,
    now: () => CLOCK,
    renderAudio: async (snapshot, options) => {
      asked.push(options);
      return stubAudio();
    },
  });
  return { renderer, asked };
}

/** A song with one scene and two pattern clips, each with its own chain. */
function twoClipScene() {
  const song = chainSong({ chain: ["a", "b", "a"] });
  song.clips["clip-2"] = {
    id: "clip-2",
    track_id: "sampler-1",
    scene_id: "scene-1",
    name: "Fill",
    kind: "pattern",
    length_steps: 16,
    step_beats: 0.25,
    swing: 0,
    chain: ["a", "b"],
    length_bars: 1,
    notes: [],
  };
  song.patterns["clip-2/a"] = { id: "a", clip_id: "clip-2", name: "A", order: 0 };
  song.patterns["clip-2/b"] = { id: "b", clip_id: "clip-2", name: "B", order: 1 };
  song.steps["clip-2/a/0/a.0"] = stepOf("clip-2", "a", 0, 0);
  return song;
}

test("an omitted length renders one full pass of the chain: A, B, A is three bars", async () => {
  const { renderer, asked } = lengthRenderer();
  const result = await renderer.render({
    song_id: "song-1",
    project_id: PROJECT,
    snapshot: chainSong(),
    scene_id: "scene-1",
  });

  assert.equal(asked.length, 1);
  assert.equal(asked[0].seconds, 6, "three one-bar slots at 120 bpm is six seconds");
  assert.equal(result.seconds, 0.01, "the stubbed audio's own figure is what comes back");
});

test("an omitted length on a clip render is that clip's own chain", async () => {
  const { renderer, asked } = lengthRenderer();
  await renderer.render({
    song_id: "song-1",
    project_id: PROJECT,
    snapshot: chainSong(),
    clip_id: "clip-1",
  });
  assert.equal(asked[0].seconds, 6, "the clip's chain is the three patterns");
});

test("a one-pattern clip with no chain is one bar", async () => {
  const { renderer, asked } = lengthRenderer();
  await renderer.render({
    song_id: "song-1",
    project_id: PROJECT,
    snapshot: chainSong({ chain: [] }),
    clip_id: "clip-1",
  });
  assert.equal(asked[0].seconds, 2, "one bar at 120 bpm");
});

test("a scene whose clips have chains of three and two patterns renders three bars", async () => {
  const { renderer, asked } = lengthRenderer();
  await renderer.render({
    song_id: "song-1",
    project_id: PROJECT,
    snapshot: twoClipScene(),
    scene_id: "scene-1",
  });
  assert.equal(asked[0].seconds, 6, "the LONGEST chain decides, not the first one met");
});

test("an explicit length always wins over the derived one", async () => {
  const { renderer, asked } = lengthRenderer();
  await renderer.render({
    song_id: "song-1",
    project_id: PROJECT,
    snapshot: chainSong(),
    scene_id: "scene-1",
    seconds: 2,
  });
  assert.equal(asked[0].seconds, 2, "a length the caller gave is the length rendered");
});

test("a derived length is capped by the render limit exactly as an explicit one is", async () => {
  const { renderer, asked } = lengthRenderer({ maxSeconds: 5 });

  // Twenty one-bar slots at 120 bpm would be forty seconds: past the limit.
  const long = chainSong({ chain: new Array(20).fill("a") });
  await assert.rejects(
    renderer.render({ song_id: "song-1", project_id: PROJECT, snapshot: long, scene_id: "scene-1" }),
    /A render can be at most 5 seconds long\./,
  );
  assert.deepEqual(asked, [], "nothing is rendered past the limit");

  // And a length the caller gives is refused by the very same sentence.
  await assert.rejects(
    renderer.render({
      song_id: "song-1",
      project_id: PROJECT,
      snapshot: chainSong(),
      scene_id: "scene-1",
      seconds: 20,
    }),
    /A render can be at most 5 seconds long\./,
  );
});

test("an omitted length on a song with no clips still renders one bar", async () => {
  const song = chainSong();
  song.clips = {};
  song.patterns = {};
  song.steps = {};

  const { renderer, asked } = lengthRenderer();
  await renderer.render({ song_id: "song-1", project_id: PROJECT, snapshot: song });
  assert.equal(asked[0].seconds, 2, "no clip to measure, so the floor of one bar applies");
});

test("an arrangement render still has to say how long", async () => {
  const { renderer, asked } = lengthRenderer();
  await assert.rejects(
    renderer.render({
      song_id: "song-1",
      project_id: PROJECT,
      snapshot: chainSong(),
      mode: "arrangement",
      from_bar: 0,
    }),
    /A render can be at most 300 seconds long\./,
  );
  assert.deepEqual(asked, [], "no arrangement render is derived: the caller names its window");
});