/**
 * Studio renders: loudness, true peak, the WAV container, and the storage rail
 * around an offline render.
 *
 * The two audio checks use the REAL renderer: `node-web-audio-api`'s
 * OfflineAudioContext with the bundle's own engine, exactly as the MCP server
 * does it. The storage checks inject a fake db, a fake S3 client and a fake
 * project ACL, so nothing here touches a real database, a real bucket or a real
 * `~/.crow`. The queue checks inject an audio renderer that blocks on a gate,
 * so the queue's limits are exercised without rendering four songs.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import v8 from "node:v8";
import { runInNewContext } from "node:vm";
import { renderSong, createRenderer } from "../bundles/studio/server/render.js";
import { integratedLufs, truePeakDb } from "../bundles/studio/server/loudness.js";
import { decodeWav, encodeWav24 } from "../bundles/studio/server/wav.js";

const SAMPLE_RATE = 48000;

/** The project every song in these tests belongs to. */
const PROJECT = 7;

/** Its storage prefix, as `project_spaces.storage_prefix` holds it. */
const PREFIX = "projects/7/";

/** A fixed clock, so a storage key is predictable. */
const CLOCK = 1700000000000;

/**
 * A 997 Hz sine — the frequency BS.1770 calibrates against, and the one the
 * plan's meter checks use.
 * @param {{seconds?: number, amplitude?: number, channels?: 1|2}} [options]
 * @returns {{left: Float32Array, right: Float32Array}}
 */
function sine({ seconds = 10, amplitude = 1, channels = 1 } = {}) {
  const length = Math.round(seconds * SAMPLE_RATE);
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const value = amplitude * Math.sin((2 * Math.PI * 997 * index) / SAMPLE_RATE);
    left[index] = value;
    if (channels === 2) right[index] = value;
  }
  return { left, right };
}

/** @returns {number} the largest absolute sample of both channels. */
function peakOf(left, right) {
  let peak = 0;
  for (const samples of [left, right]) {
    for (let index = 0; index < samples.length; index += 1) {
      const value = Math.abs(samples[index]);
      if (value > peak) peak = value;
    }
  }
  return peak;
}

/** @returns {string} ASCII from a DataView, for the RIFF chunk ids. */
function asciiOf(view, at, length) {
  let text = "";
  for (let index = 0; index < length; index += 1) text += String.fromCharCode(view.getUint8(at + index));
  return text;
}

/** @returns {number} a 24-bit little-endian sample, sign-extended. */
function readSample24(view, at) {
  const value = view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getUint8(at + 2) << 16);
  return value >= 0x800000 ? value - 0x1000000 : value;
}

/**
 * A database client that answers the one SELECT a render makes and records
 * every statement, so a test can inspect the `storage_files` row it would have
 * written. `failInsert` makes the INSERT throw, the way a full disk would.
 * @param {{prefix?: string, failInsert?: boolean}} [options]
 */
function fakeDb({ prefix = PREFIX, failInsert = false } = {}) {
  const statements = [];
  return {
    statements,
    async execute(statement) {
      const sql = typeof statement === "string" ? statement : statement.sql;
      statements.push(statement);
      if (/^\s*SELECT\s+storage_prefix/i.test(sql)) return { rows: [{ storage_prefix: prefix }] };
      if (/INSERT\s+INTO\s+storage_files/i.test(sql)) {
        if (failInsert) throw new Error("insert failed: no space left on device");
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

/** An S3 client that records what it was asked to do, and serves the objects a
 * test puts in `objects` (a take a render has to read back). */
function fakeStorage() {
  const uploads = [];
  const deleted = [];
  const urls = [];
  const objects = new Map();
  const gets = [];
  return {
    uploads,
    deleted,
    urls,
    objects,
    gets,
    async uploadObject(key, data, options) {
      uploads.push({ key, data, options });
    },
    async getPresignedUrl(key, options) {
      urls.push({ key, options });
      return `https://storage.invalid/${key}?signature=test`;
    },
    async deleteObject(key, bucket) {
      deleted.push({ key, bucket });
    },
    async getObject(key, options) {
      gets.push({ key, options });
      const bytes = objects.get(key);
      if (!bytes) {
        const error = new Error(`The specified key does not exist: ${key}`);
        error.code = "NoSuchKey";
        throw error;
      }
      return {
        stat: { size: bytes.length, metaData: {} },
        // An async iterable, the shape minio's readable stream is.
        stream: (async function* streamOnce() {
          yield bytes;
        })(),
      };
    },
  };
}

/** A project ACL that records its calls. */
function fakeAcl() {
  const calls = [];
  const audits = [];
  return {
    calls,
    audits,
    async assertLocalCapability(db, projectId, capability) {
      calls.push({ projectId, capability });
      return { role: "owner" };
    },
    async appendAudit(db, entry) {
      audits.push(entry);
    },
  };
}

/** @returns {{left: Float32Array, right: Float32Array, sampleRate: number, seconds: number}} */
function stubAudio() {
  return {
    left: new Float32Array(480),
    right: new Float32Array(480),
    sampleRate: SAMPLE_RATE,
    seconds: 0.01,
  };
}

/** @returns {object} a song with one Analog generator track, one scene, one clip. */
function oneTrackSong() {
  return {
    meta: { title: "Render test", bpm: 120, meter: [4, 4], key: "C major" },
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
      "clip-1": { id: "clip-1", track_id: "track-1", scene_id: "scene-1", name: "One", length_bars: 1, notes: [{ t: 0, d: 1, p: 60, v: 100 }] },
    },
  };
}

/** @returns {object} a song with nothing in it at all. */
function emptySong() {
  return { meta: { title: "Nothing yet", bpm: 120, meter: [4, 4], key: "C major" }, tracks: [], scenes: [], clips: {} };
}

// --- takes ------------------------------------------------------------------

/** A take id: the UUID a recording client generates (spec §5.7). */
const TAKE_ID = "6f1c1f7a-8f7e-4a4e-9a1d-2b3c4d5e6f70";

/** A second take, for the scene that is not launched. */
const OTHER_TAKE_ID = "0c9c3d2a-1b4e-4f6a-8d7c-5e4f3a2b1c0d";

/** The silence a test take carries before its signal, in frames (50 ms). */
const TAKE_LEAD_FRAMES = 2400;

/** The level of the signal a test take holds after its lead-in. */
const TAKE_LEVEL = 0.5;

/**
 * The key a take of one song is stored at: the song's project prefix, then
 * `studio/<song_id>/takes/<take_id>.wav`.
 * @param {string} takeId
 * @param {{prefix?: string, songId?: string}} [options]
 * @returns {string}
 */
function takeKey(takeId, { prefix = PREFIX, songId = "song-1" } = {}) {
  return `${prefix}studio/${songId}/takes/${takeId}.wav`;
}

/**
 * A 24-bit stereo take the wav encoder built: silence for `lead` frames, then a
 * constant `level`. A step is a signal whose peak and whose first sounding
 * frame are both exact, which is what the render checks below measure.
 * @param {{lead?: number, level?: number, seconds?: number}} [options]
 * @returns {Uint8Array}
 */
function takeWav({ lead = TAKE_LEAD_FRAMES, level = TAKE_LEVEL, seconds = 1 } = {}) {
  const frames = Math.round(seconds * SAMPLE_RATE);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let frame = lead; frame < frames; frame += 1) {
    left[frame] = level;
    right[frame] = level;
  }
  return encodeWav24(left, right, SAMPLE_RATE);
}

/**
 * A song whose one track is an audio track, with an audio clip and one take in
 * each scene that is named.
 * @param {Array<{scene_id: string, clip_id: string, take_id: string,
 *                storage_key?: string, discarded?: boolean}>} parts
 * @returns {object}
 */
function audioSong(parts) {
  const clips = {};
  const takes = {};
  const scenes = [];
  for (const part of parts) {
    if (!scenes.some((scene) => scene.id === part.scene_id)) scenes.push({ id: part.scene_id, name: part.scene_id });
    clips[part.clip_id] = {
      id: part.clip_id,
      track_id: "audio-1",
      scene_id: part.scene_id,
      name: part.clip_id,
      length_bars: 1,
      kind: "audio",
      notes: [],
      comp: [{ take_id: part.take_id, from_beat: 0, to_beat: 4 }],
    };
    takes[part.take_id] = {
      id: part.take_id,
      clip_id: part.clip_id,
      storage_key: part.storage_key ?? takeKey(part.take_id),
      rate: SAMPLE_RATE,
      channels: 2,
      frames: SAMPLE_RATE,
      offset_frames: 0,
      compensated: true,
      bpm: 120,
      recorded_at: "2026-11-03T12:00:00.000Z",
      author_label: "the operator",
      discarded: part.discarded === true,
    };
  }
  return {
    meta: { title: "Takes", bpm: 120, meter: [4, 4], key: "C major" },
    tracks: [
      {
        id: "audio-1",
        name: "Guitar",
        color: "#8FC1E8",
        device: { engine: "audio" },
        mute: false,
        solo: false,
        gain_db: 0,
        pan: 0,
        locked: false,
      },
    ],
    scenes,
    clips,
    takes,
  };
}

/**
 * The peak a take's signal should reach in a render: the track mix is
 * constant-power at pan 0, so one side gets 1/√2 of the take.
 * @param {number} [level]
 * @returns {number}
 */
function expectedMixedPeak(level = TAKE_LEVEL) {
  return level * Math.SQRT1_2;
}

// --- loudness ---------------------------------------------------------------

test("integratedLufs of a 997 Hz full-scale sine on the left channel only is -3.01 ± 0.1", () => {
  const { left, right } = sine();
  const lufs = integratedLufs(left, right, SAMPLE_RATE);
  assert.ok(Math.abs(lufs - -3.01) < 0.1, `expected -3.01 ± 0.1 LUFS, got ${lufs}`);
});

test("same sine on both channels is 0.0 ± 0.1", () => {
  const { left, right } = sine({ channels: 2 });
  const lufs = integratedLufs(left, right, SAMPLE_RATE);
  assert.ok(Math.abs(lufs - 0) < 0.1, `expected 0.0 ± 0.1 LUFS, got ${lufs}`);
});

test("truePeakDb of a 0.5-amplitude sine is -6.02 ± 0.2", () => {
  const { left, right } = sine({ seconds: 1, amplitude: 0.5, channels: 2 });
  const peak = truePeakDb(left, right, SAMPLE_RATE);
  assert.ok(Math.abs(peak - -6.02) < 0.2, `expected -6.02 ± 0.2 dBTP, got ${peak}`);
});

test("silence measures -Infinity for both meters", () => {
  const silence = new Float32Array(SAMPLE_RATE * 2);
  assert.equal(integratedLufs(silence, silence, SAMPLE_RATE), -Infinity);
  assert.equal(truePeakDb(silence, silence, SAMPLE_RATE), -Infinity);
});

// --- wav --------------------------------------------------------------------

test("wav header is 24-bit stereo 48000", () => {
  const frames = 100;
  const left = new Float32Array(frames).fill(0.5);
  const right = new Float32Array(frames).fill(-0.5);
  const wav = encodeWav24(left, right, SAMPLE_RATE);
  const dataBytes = frames * 2 * 3;
  assert.equal(wav.byteLength, 44 + dataBytes);

  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  assert.equal(asciiOf(view, 0, 4), "RIFF");
  assert.equal(view.getUint32(4, true), 36 + dataBytes);
  assert.equal(asciiOf(view, 8, 4), "WAVE");
  assert.equal(asciiOf(view, 12, 4), "fmt ");
  assert.equal(view.getUint32(16, true), 16);
  assert.equal(view.getUint16(20, true), 1, "format 1 is uncompressed PCM");
  assert.equal(view.getUint16(22, true), 2, "two channels");
  assert.equal(view.getUint32(24, true), 48000, "48000 Hz");
  assert.equal(view.getUint32(28, true), 48000 * 6, "byte rate");
  assert.equal(view.getUint16(32, true), 6, "block align");
  assert.equal(view.getUint16(34, true), 24, "24 bits per sample");
  assert.equal(asciiOf(view, 36, 4), "data");
  assert.equal(view.getUint32(40, true), dataBytes);

  assert.equal(readSample24(view, 44), Math.round(0.5 * 8388607));
  assert.equal(readSample24(view, 47), Math.round(-0.5 * 8388607));
  // A sample past full scale is clamped rather than wrapping around.
  const clamped = encodeWav24(new Float32Array([4]), new Float32Array([-4]), SAMPLE_RATE);
  const clampedView = new DataView(clamped.buffer, clamped.byteOffset, clamped.byteLength);
  assert.equal(readSample24(clampedView, 44), 8388607);
  assert.equal(readSample24(clampedView, 47), -8388607);
});

// --- the audio renderer -----------------------------------------------------

test("renderSong with a scene renders that scene's clips (non-silent)", async () => {
  const song = oneTrackSong();

  await assert.rejects(renderSong(song, { scene_id: "scene-1", clip_id: "clip-1", seconds: 1 }), /not both/);

  const scene = await renderSong(song, { scene_id: "scene-1", seconds: 2 });
  assert.equal(scene.seconds, 2);
  assert.equal(scene.left.length, 2 * SAMPLE_RATE);
  const scenePeak = peakOf(scene.left, scene.right);
  assert.ok(scenePeak > 0.01, `expected the scene's C4 to sound, peak was ${scenePeak}`);

  // No scene_id and no clip_id: the first scene that holds a clip is launched.
  const automatic = await renderSong(song, { seconds: 2 });
  const automaticPeak = peakOf(automatic.left, automatic.right);
  assert.ok(automaticPeak > 0.01, `expected the first scene with clips to sound, peak was ${automaticPeak}`);
});

/** Run a full garbage collection, so a freed AudioBuffer really is freed. */
function forceGc() {
  v8.setFlagsFromString("--expose-gc");
  runInNewContext("gc")();
}

test("a render's samples stay put after later renders and a garbage collection", async () => {
  // renderSong must hand back JS-owned copies (copyFromChannel). Reading a
  // render through node-web-audio-api's getChannelData() views let a later
  // render, or a garbage collection on a busy runner, change it afterwards:
  // zeros, another render's audio, or 1e22-sized garbage.
  const song = oneTrackSong();
  const first = await renderSong(song, { scene_id: "scene-1", seconds: 2 });
  const before = Float32Array.from(first.left);
  const beforePeak = peakOf(first.left, first.right);
  assert.ok(beforePeak > 0.01 && beforePeak <= 1, `the first render should sound, peak was ${beforePeak}`);

  for (let round = 0; round < 5; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    forceGc();
    await renderSong(emptySong(), { seconds: 2 });
  }

  let changed = 0;
  for (let index = 0; index < before.length; index += 1) {
    if (!Object.is(before[index], first.left[index])) changed += 1;
  }
  assert.equal(changed, 0, `${changed} samples of an earlier render changed after it returned`);
  assert.equal(peakOf(first.left, first.right), beforePeak);
});

test("a song with no clips renders silence and lufs -Infinity, no throw", async () => {
  const db = fakeDb();
  const storage = fakeStorage();
  const acl = fakeAcl();
  const renderer = createRenderer({ db, storage, acl, maxSeconds: 300, now: () => CLOCK });

  const result = await renderer.render({
    song_id: "song-empty",
    project_id: PROJECT,
    snapshot: emptySong(),
    seconds: 1,
  });

  assert.equal(result.lufs, -Infinity);
  assert.equal(result.true_peak_db, -Infinity);
  assert.equal(storage.uploads.length, 1);
  const uploaded = storage.uploads[0].data;
  const view = new DataView(uploaded.buffer, uploaded.byteOffset, uploaded.byteLength);
  for (let at = 44; at < uploaded.byteLength; at += 1) {
    assert.equal(view.getUint8(at), 0, `expected a silent sample, byte ${at} was not zero`);
  }
  assert.equal(acl.audits.length, 1);
});

// --- the storage rail -------------------------------------------------------

test("render over max seconds refused", async () => {
  const db = fakeDb();
  const storage = fakeStorage();
  const acl = fakeAcl();
  const renderer = createRenderer({ db, storage, acl, maxSeconds: 300, now: () => CLOCK });

  await assert.rejects(
    renderer.render({ song_id: "song-1", project_id: PROJECT, snapshot: oneTrackSong(), seconds: 400 }),
    /300 seconds/,
  );
  assert.equal(acl.calls.length, 0, "the ACL is checked only after the limit");
  assert.equal(storage.uploads.length, 0, "nothing is rendered or uploaded past the limit");
  assert.deepEqual(db.statements, [], "nothing is written past the limit");
});

test("render queue full on fifth concurrent call", async () => {
  const db = fakeDb();
  const storage = fakeStorage();
  const acl = fakeAcl();

  let openGate;
  const gate = new Promise((resolve) => {
    openGate = resolve;
  });
  const renderer = createRenderer({
    db,
    storage,
    acl,
    maxSeconds: 300,
    now: () => CLOCK,
    renderAudio: async () => {
      await gate;
      return stubAudio();
    },
  });

  const request = { song_id: "song-1", project_id: PROJECT, snapshot: oneTrackSong(), seconds: 1 };
  const accepted = [renderer.render(request), renderer.render(request), renderer.render(request), renderer.render(request)];

  // Let the four reach the queue: one runs, three wait.
  await new Promise((resolve) => setTimeout(resolve, 20));

  const fifth = renderer.render(request);
  await assert.rejects(fifth, {
    message: "The render queue is full; try again when the current renders finish.",
  });

  openGate();
  const results = await Promise.all(accepted);
  assert.deepEqual(
    results.map((result) => result.seconds),
    [0.01, 0.01, 0.01, 0.01],
  );
});

test("a render without a project is refused clearly", async () => {
  const db = fakeDb();
  const storage = fakeStorage();
  const acl = fakeAcl();
  const renderer = createRenderer({
    db,
    storage,
    acl,
    maxSeconds: 300,
    now: () => CLOCK,
    renderAudio: async () => stubAudio(),
  });

  for (const project_id of [undefined, null]) {
    await assert.rejects(
      renderer.render({ song_id: "song-1", project_id, snapshot: oneTrackSong(), seconds: 1 }),
      { message: "A render needs the song's project." },
    );
  }

  assert.equal(acl.calls.length, 0, "the ACL is never called without a project");
  assert.equal(storage.uploads.length, 0, "nothing is uploaded");
  assert.equal(acl.audits.length, 0, "nothing is audited");
  assert.deepEqual(db.statements, [], "nothing is written");
});

test("a song id containing a slash or dots is refused before any upload", async () => {
  const db = fakeDb();
  const storage = fakeStorage();
  const acl = fakeAcl();
  const renderer = createRenderer({
    db,
    storage,
    acl,
    maxSeconds: 300,
    now: () => CLOCK,
    renderAudio: async () => stubAudio(),
  });

  for (const song_id of ["x/y", ".."]) {
    await assert.rejects(
      renderer.render({ song_id, project_id: PROJECT, snapshot: oneTrackSong(), seconds: 1 }),
      { message: "That is not a valid song id." },
    );
  }

  assert.equal(acl.calls.length, 0, "an invalid id is refused before the ACL");
  assert.equal(storage.uploads.length, 0, "nothing is uploaded under an invalid id");
  assert.equal(storage.urls.length, 0, "no URL is handed out");
  assert.equal(acl.audits.length, 0, "nothing is audited");
  assert.deepEqual(db.statements, [], "nothing is written");
});

test("a render with no author is audited as bot", async () => {
  const db = fakeDb();
  const storage = fakeStorage();
  const acl = fakeAcl();
  const renderer = createRenderer({
    db,
    storage,
    acl,
    maxSeconds: 300,
    now: () => CLOCK,
    renderAudio: async () => stubAudio(),
  });

  await renderer.render({ song_id: "song-1", project_id: PROJECT, snapshot: oneTrackSong(), seconds: 1 });

  assert.equal(acl.audits.length, 1);
  assert.equal(acl.audits[0].actor_type, "bot");
  assert.equal(acl.audits[0].actor_id, null);
});

test("a failed storage_files insert deletes the uploaded object", async () => {
  const db = fakeDb({ failInsert: true });
  const storage = fakeStorage();
  const acl = fakeAcl();
  const renderer = createRenderer({
    db,
    storage,
    acl,
    maxSeconds: 300,
    now: () => CLOCK,
    renderAudio: async () => stubAudio(),
  });

  await assert.rejects(
    renderer.render({
      song_id: "song-1",
      project_id: PROJECT,
      snapshot: oneTrackSong(),
      scene_id: "scene-1",
      seconds: 1,
    }),
    /no space left on device/,
  );

  assert.equal(storage.uploads.length, 1, "the object was uploaded before the row failed");
  assert.equal(storage.deleted.length, 1, "the orphaned object must be deleted");
  assert.equal(storage.deleted[0].key, storage.uploads[0].key);
  assert.equal(storage.deleted[0].bucket, "crow-files");
  assert.equal(storage.urls.length, 0, "no URL is handed out when the row failed");
  assert.equal(acl.audits.length, 0, "a failed render is not audited as a render");
});

test("a stored render is keyed, filed and audited the way the storage rail expects", async () => {
  const db = fakeDb();
  const storage = fakeStorage();
  const acl = fakeAcl();
  const renderer = createRenderer({
    db,
    storage,
    acl,
    maxSeconds: 300,
    now: () => CLOCK,
    renderAudio: async () => stubAudio(),
  });

  const result = await renderer.render({
    song_id: "song-1",
    project_id: PROJECT,
    snapshot: oneTrackSong(),
    scene_id: "scene-1",
    seconds: 1,
    author: { kind: "human", id: "local", label: "You" },
  });

  assert.equal(result.storage_key, `${PREFIX}studio/song-1/${CLOCK}-Render_test-A.wav`);
  assert.equal(result.url, `https://storage.invalid/${result.storage_key}?signature=test`);
  assert.deepEqual(storage.urls[0].options, { bucket: "crow-files", expiry: 3600 }, "the download URL lives one hour");
  assert.deepEqual(storage.uploads[0].options, { bucket: "crow-files", contentType: "audio/wav" });

  const insert = db.statements.find((statement) => /INSERT\s+INTO\s+storage_files/i.test(statement.sql));
  assert.ok(insert, "the render is filed in storage_files");
  assert.deepEqual(insert.args, [
    result.storage_key,
    "Render_test-A.wav",
    "audio/wav",
    storage.uploads[0].data.length,
    "crow-files",
    "studio_song",
    "song-1",
    PROJECT,
  ]);

  assert.deepEqual(acl.calls, [{ projectId: PROJECT, capability: "write_files" }]);
  assert.equal(acl.audits.length, 1);
  assert.equal(acl.audits[0].action, "studio.render");
  assert.equal(acl.audits[0].target, "song:song-1");
  assert.equal(acl.audits[0].actor_type, "local");
  assert.equal(acl.audits[0].project_id, PROJECT);
});

// --- renders with takes -----------------------------------------------------

test("render of an audio clip includes its take", async () => {
  const song = audioSong([{ scene_id: "scene-1", clip_id: "clip-1", take_id: TAKE_ID }]);
  const take = decodeWav(takeWav());

  const rendered = await renderSong(song, {
    scene_id: "scene-1",
    seconds: 1,
    takeAudio: async (asked) => {
      assert.equal(asked.id, TAKE_ID);
      return { rate: take.rate, channels: take.channels };
    },
  });

  const expected = expectedMixedPeak();
  const peak = peakOf(rendered.left, rendered.right);
  assert.ok(Math.abs(peak - expected) <= expected * 0.01, `expected a peak of ${expected} ±1%, got ${peak}`);

  // The take's own lead-in places its signal: the comp starts at beat 0, so
  // the step lands exactly TAKE_LEAD_FRAMES into the render.
  const firstSounding = rendered.left.findIndex((sample) => Math.abs(sample) > 0.001);
  assert.ok(
    Math.abs(firstSounding - TAKE_LEAD_FRAMES) <= 1,
    `expected the take to sound from frame ${TAKE_LEAD_FRAMES}, it sounded from ${firstSounding}`,
  );
});

test("render refuses a take key outside the song prefix", async () => {
  const db = fakeDb();
  const storage = fakeStorage();
  const acl = fakeAcl();
  const renderer = createRenderer({ db, storage, acl, maxSeconds: 300, now: () => CLOCK });

  // The take names another project's prefix, and that object really is there:
  // the render must refuse the key rather than read it.
  const outside = takeKey(TAKE_ID, { prefix: "projects/8/" });
  storage.objects.set(outside, takeWav());

  await assert.rejects(
    renderer.render({
      song_id: "song-1",
      project_id: PROJECT,
      snapshot: audioSong([
        { scene_id: "scene-1", clip_id: "clip-1", take_id: TAKE_ID, storage_key: outside },
      ]),
      scene_id: "scene-1",
      seconds: 1,
    }),
    { message: `Take ${TAKE_ID} is not stored where Studio keeps this song's takes.` },
  );

  assert.equal(storage.gets.length, 0, "nothing outside the song's own takes is read");
  assert.equal(storage.uploads.length, 0, "nothing is rendered or uploaded");
  assert.equal(acl.audits.length, 0, "a refused render is not audited");
});

test("render with a missing take object names the take", async () => {
  const db = fakeDb();
  const storage = fakeStorage();
  const acl = fakeAcl();
  const renderer = createRenderer({ db, storage, acl, maxSeconds: 300, now: () => CLOCK });

  await assert.rejects(
    renderer.render({
      song_id: "song-1",
      project_id: PROJECT,
      snapshot: audioSong([{ scene_id: "scene-1", clip_id: "clip-1", take_id: TAKE_ID }]),
      scene_id: "scene-1",
      seconds: 1,
    }),
    new RegExp(`Take ${TAKE_ID} could not be loaded for this render`),
  );

  assert.equal(storage.gets.length, 1, "the take's own key was read");
  assert.equal(storage.gets[0].key, takeKey(TAKE_ID));
  assert.equal(storage.uploads.length, 0, "nothing is uploaded");
});

test("render loads only the takes the launched scene uses", async () => {
  const song = audioSong([
    { scene_id: "scene-1", clip_id: "clip-1", take_id: TAKE_ID },
    { scene_id: "scene-2", clip_id: "clip-2", take_id: OTHER_TAKE_ID },
  ]);

  const asked = [];
  const rendered = await renderSong(song, {
    scene_id: "scene-2",
    seconds: 1,
    takeAudio: async (take) => {
      asked.push(take.id);
      return { rate: SAMPLE_RATE, channels: decodeWav(takeWav()).channels };
    },
  });

  assert.deepEqual(asked, [OTHER_TAKE_ID], "only the launched scene's take is read");
  const peak = peakOf(rendered.left, rendered.right);
  const expected = expectedMixedPeak();
  assert.ok(Math.abs(peak - expected) <= expected * 0.01, `expected a peak of ${expected} ±1%, got ${peak}`);
});