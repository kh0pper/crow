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
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import v8 from "node:v8";
import { runInNewContext } from "node:vm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { renderSong, createRenderer, unhostableInserts } from "../bundles/studio/server/render.js";
import { createStudioServer } from "../bundles/studio/server/mcp.js";
import { integratedLufs, truePeakDb } from "../bundles/studio/server/loudness.js";
import { decodeWav, encodeWav24 } from "../bundles/studio/server/wav.js";
import { tinySf2 } from "./fixtures/tiny-sf2.mjs";

const SAMPLE_RATE = 48000;

/**
 * The engine client `render.js` itself builds its engines with (the same
 * CommonJS module, so the same object): the cap test wraps its `create` to see
 * what a render asks for.
 */
const ENGINE_DIR = fileURLToPath(new URL("../bundles/studio/engine/", import.meta.url));
const studioEngine = createRequire(join(ENGINE_DIR, "x.js"))(join(ENGINE_DIR, "engine-client.js"));

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

/**
 * How far apart two renders are: the largest sample difference over both
 * channels. Two renders of the same song are bit-identical, so anything above
 * the float noise means the audio really changed.
 * @param {{left: Float32Array, right: Float32Array}} one
 * @param {{left: Float32Array, right: Float32Array}} other
 * @returns {number}
 */
function largestDifference(one, other) {
  let largest = 0;
  for (const channel of ["left", "right"]) {
    const count = Math.min(one[channel].length, other[channel].length);
    for (let at = 0; at < count; at += 1) {
      const gap = Math.abs(one[channel][at] - other[channel][at]);
      if (gap > largest) largest = gap;
    }
  }
  return largest;
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

test("render passes arrangement mode and from_bar through", async () => {
  const db = fakeDb();
  const storage = fakeStorage();
  const acl = fakeAcl();
  const asked = [];
  const renderer = createRenderer({
    db,
    storage,
    acl,
    maxSeconds: 300,
    now: () => CLOCK,
    renderAudio: async (snapshot, options) => {
      asked.push({ snapshot, options });
      return stubAudio();
    },
  });

  const request = { song_id: "song-1", project_id: PROJECT, snapshot: oneTrackSong(), seconds: 1 };
  await renderer.render({ ...request, mode: "arrangement", from_bar: 9 });
  assert.equal(asked.length, 1);
  assert.equal(asked[0].options.mode, "arrangement", "the timeline view has to reach the renderer");
  assert.equal(asked[0].options.from_bar, 9, "the bar the render starts at has to reach the renderer");

  // A session render says so, and starts at bar 0.
  await renderer.render(request);
  assert.equal(asked[1].options.mode, "session");
  assert.equal(asked[1].options.from_bar, 0);

  // A mode or a bar the engine does not have is refused before anything runs.
  await assert.rejects(renderer.render({ ...request, mode: "solo" }), {
    message: 'A render plays "session" or "arrangement".',
  });
  await assert.rejects(renderer.render({ ...request, mode: "arrangement", from_bar: 1.5 }), {
    message: "A render can start at a whole bar from 0 to 998.",
  });
  await assert.rejects(renderer.render({ ...request, mode: "arrangement", from_bar: 999 }), {
    message: "A render can start at a whole bar from 0 to 998.",
  });
  assert.equal(asked.length, 2, "a refused render never reaches the audio renderer");
  assert.equal(storage.uploads.length, 2, "only the two accepted renders are stored");
  assert.equal(acl.audits.length, 2, "only the two accepted renders are audited");
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

// --- renders with samples ---------------------------------------------------

/** The sample ids the sampler song below holds. */
const SAMPLE_A = "3f2a1b0c-4d5e-4f60-8a71-9b2c3d4e5f60";
const SAMPLE_B = "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d";
const SAMPLE_C = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const SAMPLE_UNUSED = "9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a";

/**
 * The key a sample of one song is stored at: the song's project prefix, then
 * `studio/<song_id>/samples/<sample_id>.wav`.
 * @param {string} sampleId
 * @returns {string}
 */
function sampleKey(sampleId) {
  return `${PREFIX}studio/song-1/samples/${sampleId}.wav`;
}

/** @returns {object} a sample as a snapshot carries it. */
function sampleOf(id, name) {
  return {
    id,
    storage_key: sampleKey(id),
    rate: SAMPLE_RATE,
    channels: 2,
    frames: 4800,
    name,
    origin: "import",
    author_label: "the operator",
    slices: [],
  };
}

/** @returns {object} a pad as a snapshot carries it. */
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

/** @returns {object} a step as a snapshot carries it. */
function stepOf(clipId, patternId, at, index) {
  return { clip_id: clipId, pattern_id: patternId, at, bank_id: "a", index, v: 100, locks: {} };
}

/**
 * A sampler song with two pattern clips: one in scene 1 whose chain plays two
 * patterns over pads 1 and 2, and one in scene 2 over pad 3. A fourth sample is
 * in the song and on no pad a step triggers.
 * @returns {object}
 */
function samplerSong() {
  return {
    meta: { title: "Sampler", bpm: 120, meter: [4, 4], key: "C major" },
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
    scenes: [
      { id: "scene-1", name: "A" },
      { id: "scene-2", name: "B" },
    ],
    clips: {
      "clip-1": {
        id: "clip-1",
        track_id: "sampler-1",
        scene_id: "scene-1",
        name: "Drums",
        kind: "pattern",
        length_steps: 16,
        step_beats: 0.25,
        swing: 0,
        chain: ["a", "b"],
        length_bars: 1,
        notes: [],
      },
      "clip-2": {
        id: "clip-2",
        track_id: "sampler-1",
        scene_id: "scene-2",
        name: "Fill",
        kind: "pattern",
        length_steps: 16,
        step_beats: 0.25,
        swing: 0,
        chain: [],
        length_bars: 1,
        notes: [],
      },
    },
    samples: {
      [SAMPLE_A]: sampleOf(SAMPLE_A, "Kick"),
      [SAMPLE_B]: sampleOf(SAMPLE_B, "Snare"),
      [SAMPLE_C]: sampleOf(SAMPLE_C, "Fill hit"),
      [SAMPLE_UNUSED]: sampleOf(SAMPLE_UNUSED, "Unused"),
    },
    pads: {
      "sampler-1/a/0": padOf(0, SAMPLE_A),
      "sampler-1/a/1": padOf(1, SAMPLE_B),
      "sampler-1/a/2": padOf(2, SAMPLE_C),
      "sampler-1/a/3": padOf(3, SAMPLE_UNUSED),
    },
    patterns: {
      "clip-1/a": { id: "a", clip_id: "clip-1", name: "A", order: 0 },
      "clip-1/b": { id: "b", clip_id: "clip-1", name: "B", order: 1 },
      "clip-2/a": { id: "a", clip_id: "clip-2", name: "A", order: 0 },
    },
    steps: {
      // Two sounds on chain pattern A, the same pad twice, and one on B: three
      // steps, two samples.
      "clip-1/a/0/a.0": stepOf("clip-1", "a", 0, 0),
      "clip-1/a/4/a.1": stepOf("clip-1", "a", 4, 1),
      "clip-1/a/8/a.1": stepOf("clip-1", "a", 8, 1),
      "clip-1/b/0/a.0": stepOf("clip-1", "b", 0, 0),
      // The other scene's clip plays a third sound; pad 4 holds a fourth that no
      // step triggers at all.
      "clip-2/a/0/a.2": stepOf("clip-2", "a", 0, 2),
    },
    arrangement: {
      placements: {
        // Scene 2's clip on the timeline from bar 4, so a window there hears it
        // and a window at bar 0 does not.
        "place-1": { id: "place-1", clip_id: "clip-2", track_id: "sampler-1", start_bar: 4, bars: 4 },
      },
      markers: {},
      sections: {},
    },
  };
}

/** @returns {object} a decoded sample's audio, as a sample reader answers it. */
function sampleAudioOf() {
  return { rate: SAMPLE_RATE, channels: [new Float32Array(4800), new Float32Array(4800)] };
}

/**
 * @param {Float32Array} channel
 * @param {number} from the first frame of the window
 * @param {number} to the frame it stops at (exclusive)
 * @returns {number} the largest absolute sample in that window
 */
function peakIn(channel, from, to) {
  let peak = 0;
  const start = Math.max(0, Math.trunc(from));
  const end = Math.min(channel.length, Math.trunc(to));
  for (let at = start; at < end; at += 1) {
    const value = Math.abs(channel[at]);
    if (value > peak) peak = value;
  }
  return peak;
}

/**
 * The smallest hub client `createStudioServer`'s render tool reads: one song,
 * in one project. A render issues no commands, so nothing else is needed.
 * @param {object} snapshot the song to render
 * @param {number} [projectId]
 * @returns {object}
 */
function renderHub(snapshot, projectId = PROJECT) {
  return {
    async snapshot() {
      return { snapshot, project_id: projectId };
    },
    async command() {
      throw new Error("the render tool issues no commands");
    },
    async listSongs() {
      return [{ id: "song-1", project_id: projectId, title: "Sampler", updated_at: "2026-11-05T00:00:00.000Z" }];
    },
  };
}

test("render loads only the samples its patterns use", async () => {
  const song = samplerSong();
  const asked = [];

  // Session: the launched scene's pattern clip, through its chain. The pads its
  // steps trigger name two samples; the fourth pad's sample is never read.
  const session = await renderSong(song, {
    scene_id: "scene-1",
    seconds: 1,
    sampleAudio: async (sample) => {
      asked.push(sample.id);
      return sampleAudioOf();
    },
  });
  assert.deepEqual(asked, [SAMPLE_A, SAMPLE_B], "only the samples the chain's steps trigger");
  assert.equal(session.seconds, 1);

  // The other scene's clip plays a different sample, and the launch decides:
  // a clip launch reads only that clip's samples.
  const second = [];
  await renderSong(song, {
    clip_id: "clip-2",
    seconds: 1,
    sampleAudio: async (sample) => {
      second.push(sample.id);
      return sampleAudioOf();
    },
  });
  assert.deepEqual(second, [SAMPLE_C], "only the launched clip's sample");

  // Arrangement: the window decides. Clip 2's placement starts at bar 4, so a
  // render from bar 4 hears its sample and one from bar 0 hears none.
  const windowAsked = [];
  await renderSong(song, {
    mode: "arrangement",
    from_bar: 4,
    seconds: 1,
    sampleAudio: async (sample) => {
      windowAsked.push(sample.id);
      return sampleAudioOf();
    },
  });
  assert.deepEqual(windowAsked, [SAMPLE_C], "the arrangement loads the samples of the clips it plays");

  const beforeAsked = [];
  await renderSong(song, {
    mode: "arrangement",
    from_bar: 0,
    seconds: 1,
    sampleAudio: async (sample) => {
      beforeAsked.push(sample.id);
      return sampleAudioOf();
    },
  });
  assert.deepEqual(beforeAsked, [], "a window before the placement reads nothing");
  assert.deepEqual(session.missing_samples, [], "every sample this render heard was loaded");

  // A chain whose entries name no pattern of the clip falls back to the clip's
  // first pattern, exactly as the sequencer does: the steps have to sound.
  const dangling = structuredClone(song);
  dangling.clips["clip-1"].chain = ["gone"];
  const fallback = [];
  await renderSong(dangling, {
    scene_id: "scene-1",
    seconds: 1,
    sampleAudio: async (sample) => {
      fallback.push(sample.id);
      return sampleAudioOf();
    },
  });
  assert.deepEqual(fallback, [SAMPLE_A, SAMPLE_B], "the clip's first pattern still loads its samples");
});

test("a render whose samples pass 256 MB keeps every one", async (t) => {
  // Three samples on three steps of one pattern. `sampleCapBytes` stands in for
  // the browser's 256 MB, lowered so three tiny samples pass it: an engine built
  // with that cap would drop the first sample when the third one loads, and its
  // step would play silence.
  const song = samplerSong();
  song.steps["clip-1/a/12/a.2"] = stepOf("clip-1", "a", 12, 2);

  const frames = 4800;
  // The engine counts one frame of slack per sample for the resampler's rounding.
  const oneSampleBytes = (frames + 1) * 2 * 4;
  const constant = () => new Float32Array(frames).fill(0.3);
  const asked = [];

  // The engine the render builds is watched here: its cap is the window's own
  // sample bytes, not the (lowered) cap it would otherwise start under.
  const built = [];
  const realCreate = studioEngine.create;
  studioEngine.create = async (context, options) => {
    built.push(options);
    return realCreate(context, options);
  };
  t.after(() => {
    studioEngine.create = realCreate;
  });

  const rendered = await renderSong(song, {
    scene_id: "scene-1",
    seconds: 6,
    sampleCapBytes: 2 * oneSampleBytes,
    sampleAudio: async (sample) => {
      asked.push(sample.id);
      return { rate: SAMPLE_RATE, channels: [constant(), constant()] };
    },
  });

  assert.equal(built.length, 1, "the render built one engine");
  assert.equal(
    built[0].maxSampleBytes,
    3 * oneSampleBytes,
    "its cap is room for every sample it loads, not the cap it started under",
  );
  assert.deepEqual(asked, [SAMPLE_A, SAMPLE_B, SAMPLE_C], "every sample the pattern triggers was read");
  assert.deepEqual(rendered.missing_samples, []);

  // Each step sounds. A 16th is 6000 frames at 120 bpm and 48 kHz, and pattern A
  // plays at beats 0-4 and 8-12, so its steps land on 0, 24000, 48000 and
  // 264000 frames. The first one proves the earliest sample was not trimmed
  // away when a later load went past the cap the engine started with.
  assert.ok(peakIn(rendered.left, 0, frames) > 0.05, "the first step sounds, so its sample is still loaded");
  assert.ok(peakIn(rendered.left, 24000, 24000 + frames) > 0.05, "the second step sounds");
  assert.ok(peakIn(rendered.left, 264000, 264000 + frames) > 0.05, "the third step sounds");
});

test("a render needing more than 1 GiB of samples is refused before it starts", async () => {
  const song = samplerSong();
  // Declared frames alone put the window past the budget: the refusal is
  // arithmetic, so nothing is read, decoded or allocated.
  song.samples[SAMPLE_A] = { ...song.samples[SAMPLE_A], frames: 200000000, channels: 2 };
  const asked = [];

  await assert.rejects(
    renderSong(song, {
      scene_id: "scene-1",
      seconds: 1,
      sampleAudio: async (sample) => {
        asked.push(sample.id);
        return sampleAudioOf();
      },
    }),
    { message: /^This render needs \d+ MB of samples; a render holds at most 1024 MB\.$/ },
  );
  assert.deepEqual(asked, [], "no sample is read for a render that cannot hold them");
});

test("a render reports a missing sample", async () => {
  const song = samplerSong();

  // The renderer keeps going — a pad whose sample is gone plays silence (Review
  // Focus 1) — and says which sample it could not hear, and why.
  const rendered = await renderSong(song, {
    scene_id: "scene-1",
    seconds: 1,
    sampleAudio: async (sample) => {
      if (sample.id === SAMPLE_B) {
        throw new Error(`Sample ${sample.id} could not be loaded for this render: no such key.`);
      }
      return sampleAudioOf();
    },
  });
  assert.deepEqual(rendered.missing_samples, [
    { id: SAMPLE_B, reason: `Sample ${SAMPLE_B} could not be loaded for this render: no such key.` },
  ]);
  assert.equal(rendered.seconds, 1, "the render still happened");
  assert.equal(rendered.left.length, SAMPLE_RATE);

  // A pad that names a sample the song does not hold at all is reported too,
  // rather than skipped: the id is all the song can tell us.
  const orphaned = structuredClone(song);
  delete orphaned.samples[SAMPLE_A];
  const orphan = await renderSong(orphaned, {
    scene_id: "scene-1",
    seconds: 1,
    sampleAudio: async () => sampleAudioOf(),
  });
  assert.deepEqual(orphan.missing_samples, [{ id: SAMPLE_A, reason: "the song has no such sample" }]);

  // Through the storage rail: storage has neither sample, so the load names
  // each one, the WAV is still filed and the audit line carries the list.
  const db = fakeDb();
  const storage = fakeStorage();
  const acl = fakeAcl();
  const renderer = createRenderer({ db, storage, acl, maxSeconds: 300, now: () => CLOCK });
  const stored = await renderer.render({
    song_id: "song-1",
    project_id: PROJECT,
    snapshot: song,
    scene_id: "scene-1",
    seconds: 1,
  });
  assert.deepEqual(stored.missing_samples.map((item) => item.id), [SAMPLE_A, SAMPLE_B]);
  for (const item of stored.missing_samples) {
    assert.match(item.reason, new RegExp(`Sample ${item.id} could not be loaded for this render`));
  }
  assert.equal(storage.uploads.length, 1, "the render is still stored");
  const audit = acl.audits.find((entry) => entry.action === "studio.render");
  assert.ok(audit, "the render is audited");
  assert.deepEqual(audit.payload.missing_samples, stored.missing_samples);
  assert.equal(storage.gets.length, 2, "only the two samples the render plays were read");
  assert.deepEqual(
    storage.gets.map((get) => get.key).sort(),
    [sampleKey(SAMPLE_A), sampleKey(SAMPLE_B)].sort(),
  );

  // And the MCP tool hands the list to the agent, in the same words.
  const server = createStudioServer({ hub: renderHub(song), renderer });
  const client = new Client({ name: "studio-render-test", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const answer = await client.callTool({
      name: "studio_render",
      arguments: { song_id: "song-1", scene_id: "scene-1", seconds: 1 },
    });
    assert.notEqual(answer.isError, true, answer.content?.[0]?.text);
    const body = JSON.parse(answer.content[0].text);
    assert.deepEqual(body.missing_samples, stored.missing_samples, "the agent is told what it did not hear");
    assert.ok(body.download_url, "the render's gateway link still comes back");
    assert.equal("url" in body, false, "and never a storage address");
  } finally {
    await client.close();
  }
});

// --- renders with instruments -----------------------------------------------

/** The library ids the instrument tests here use. */
const FONT_UPLOAD = "lib-upload";
const FONT_CATALOG = "lib-catalog";
const FONT_MUTED = "lib-muted";
const FONT_GONE = "lib-gone";

/** The sha256 a catalog entry is trusted by (64 hexadecimal characters). */
const CATALOG_SHA = "c".repeat(64);

/** A missing catalog file's hash, which this instance does not hold. */
const GONE_SHA = "d".repeat(64);

/** The tiny but valid bank the instrument tests render (two of its presets). */
const TINY_FONT = tinySf2();

/**
 * The bank bytes a reader answers with. The engine TRANSFERS the array a load
 * posts (so the worklet owns it and the caller's copy is detached), exactly as
 * `loadSample` does, so every read hands over its own copy — the production
 * readers get one from the disk or the storage stream.
 * @returns {Uint8Array}
 */
function fontBytes() {
  return TINY_FONT.slice();
}

/** The tone preset 0 of the tiny font plays, and the one preset 1 plays. */
const TONE_PROGRAM_0 = 340;
const TONE_PROGRAM_1 = 420;

/**
 * The key an uploaded bank of one song is stored at: the song's project prefix,
 * then `studio/<song_id>/library/<library_id>.<ext>`.
 * @param {string} libraryId
 * @param {{songId?: string, prefix?: string}} [options]
 * @returns {string}
 */
function fontKey(libraryId, { songId = "song-1", prefix = PREFIX } = {}) {
  return `${prefix}studio/${songId}/library/${libraryId}.sf2`;
}

/**
 * A library entry as a snapshot carries it: an upload of the tiny font unless
 * the test says otherwise.
 * @param {string} libraryId
 * @param {object} [overrides]
 * @returns {object}
 */
function fontEntryOf(libraryId, overrides = {}) {
  return {
    id: libraryId,
    kind: "font",
    name: `Font ${libraryId}`,
    source: "upload",
    catalog_id: null,
    storage_key: fontKey(libraryId),
    upload_id: null,
    sha256: "a".repeat(64),
    bytes: TINY_FONT.byteLength,
    licence: "MIT",
    credit: "",
    author_label: "the operator",
    ...overrides,
  };
}

/**
 * A song of soundfont tracks, each holding middle C through the font and preset
 * it names.
 * @param {Array<{id: string, name: string, font_id: string, bank?: number,
 *                program?: number, mute?: boolean}>} tracks
 * @param {object} library
 * @returns {object}
 */
function fontSong(tracks, library) {
  return {
    meta: { title: "Fonts", bpm: 120, meter: [4, 4], key: "C major" },
    tracks: tracks.map((track) => ({
      id: track.id,
      name: track.name,
      color: "#E8C07A",
      device: {
        engine: "soundfont",
        font_id: track.font_id,
        bank: track.bank ?? 0,
        program: track.program ?? 0,
      },
      mute: track.mute === true,
      solo: false,
      gain_db: 0,
      pan: 0,
      locked: false,
    })),
    scenes: [{ id: "scene-1", name: "A" }],
    clips: Object.fromEntries(
      tracks.map((track) => [
        `${track.id}-clip`,
        {
          id: `${track.id}-clip`,
          track_id: track.id,
          scene_id: "scene-1",
          name: "Hold",
          length_bars: 1,
          notes: [{ t: 0, d: 4, p: 60, v: 100 }],
        },
      ]),
    ),
    library,
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
 * A library store that holds the one catalog file a test writes to disk, and
 * nothing else — the shape `createLibraryStore` answers with.
 * @param {string} sha256 the hash it holds
 * @param {string} path where those bytes really are
 * @returns {{holds: Function, fileForHash: Function}}
 */
function fakeLibraryStore(sha256, path) {
  return {
    async holds(hash) {
      return String(hash).toLowerCase() === sha256;
    },
    async fileForHash(hash) {
      return String(hash).toLowerCase() === sha256 ? path : null;
    },
  };
}

/**
 * One insert, as `server/doc.js`'s snapshot carries it: the id, the chain it
 * sits in, its fractional place in that chain, its kind, whether it is bypassed
 * and every parameter.
 * @param {string} id
 * @param {string} owner - `"track:<id>"`, `"return:<id>"` or `"master"`
 * @param {number} order
 * @param {string} kind
 * @param {object} params
 * @param {boolean} [bypass]
 * @returns {object}
 */
function insertOf(id, owner, order, kind, params, bypass = false) {
  return { id, owner, order, kind, bypass, params };
}

test("a render runs every chain", async () => {
  // One song with a track insert, a return with its own insert fed by a send,
  // and a master insert — the three chains the mixer has (plan 1d, Task 9).
  // Each one is switched OFF on its own, and the render has to hear the
  // difference: an insert the render quietly skipped would show up here as two
  // identical mixes.
  const trackFilter = insertOf("ins-filter", "track:track-1", 0, "filter", { mode: "lp", cutoff_hz: 150, resonance: 0.7 });
  const returnSaturation = insertOf("ins-return", "return:verb", 0, "saturation", {
    drive_db: 36,
    tone: 1,
    output_db: 0,
    mix: 1,
  });
  const masterCompressor = insertOf("ins-master", "master", 0, "compressor", {
    detect: "peak",
    threshold_db: -50,
    ratio: 20,
    knee_db: 0,
    attack_ms: 0.5,
    release_ms: 20,
    makeup_db: 0,
    sidechain_hp_hz: 0,
  });

  /**
   * The song with the three chains in it, any of them bypassed.
   * @param {{track?: boolean, ret?: boolean, master?: boolean}} [bypass]
   * @returns {object}
   */
  const mixSong = (bypass = {}) => ({
    ...oneTrackSong(),
    inserts: {
      [trackFilter.id]: { ...trackFilter, bypass: bypass.track === true },
      [returnSaturation.id]: { ...returnSaturation, bypass: bypass.ret === true },
      [masterCompressor.id]: { ...masterCompressor, bypass: bypass.master === true },
    },
    returns: { verb: { id: "verb", name: "Reverb", gain_db: 0, pan: 0, mute: false } },
    sends: { "track-1/verb": { track_id: "track-1", return_id: "verb", level_db: -6, pre: false } },
    master: { gain_db: 0, target: { lufs: -14, true_peak_db: -1 } },
  });

  const render = (bypass) => renderSong(mixSong(bypass), { scene_id: "scene-1", seconds: 2 });

  const all = await render();
  assert.deepEqual(all.effect_problems, [], "every chain ran: no insert had to be skipped");
  assert.deepEqual(all.missing_library, []);
  assert.ok(peakOf(all.left, all.right) > 0.005, "the mixed song sounds, so the comparisons mean something");

  /**
   * How far apart two renders are, over both channels.
   * @param {object} one
   * @param {object} other
   * @returns {number}
   */
  const distance = largestDifference;

  const withoutTrack = await render({ track: true });
  assert.ok(
    distance(all, withoutTrack) > 0.01,
    "bypassing the track's filter has to change the mix the render measures",
  );

  const withoutReturn = await render({ ret: true });
  assert.ok(
    distance(all, withoutReturn) > 0.01,
    "bypassing the return's insert has to change the mix the render measures",
  );

  const withoutMaster = await render({ master: true });
  assert.ok(
    distance(all, withoutMaster) > 0.01,
    "bypassing the master's compressor has to change the mix the render measures",
  );

  // The master chain is measured where it lands: the master compressor squashes
  // the song, so the same audio sums to a quieter true peak with it in.
  assert.ok(
    truePeakDb(all.left, all.right, SAMPLE_RATE) < truePeakDb(withoutMaster.left, withoutMaster.right, SAMPLE_RATE),
    "the master's insert is measured on the final output, not before it",
  );
});

test("a render names a Faust insert it cannot host, and renders anyway", async () => {
  // A checkout that has not run `tools/build-faust.mjs` holds no compiled
  // effects. The insert is not fatal: it passes audio through, the rest of the
  // chain plays, and the render says which insert it could not run (plan 1d,
  // Task 11).
  const phaser = insertOf("ins-phaser", "track:track-1", 0, "phaser", {
    rate_hz: 0.5,
    depth: 1,
    feedback: 0.4,
    mix: 1,
  });
  const song = {
    ...oneTrackSong(),
    inserts: {
      [phaser.id]: phaser,
      // A bypassed insert is skipped by the chain, so it is nothing to report.
      "ins-off": { ...phaser, id: "ins-off", bypass: true },
    },
    returns: { verb: { id: "verb", name: "Reverb", gain_db: 0, pan: 0, mute: false } },
  };

  // The host with no build output names every effect it cannot host, with the
  // effect and the chain it sits in: a fresh checkout's answer, held here
  // against a song rather than against a build that would have to be undone.
  assert.deepEqual(unhostableInserts(song, new Set()), [
    {
      insert_id: "ins-phaser",
      message: 'phaser on Lead could not be built: this render has no compiled "phaser" effect.',
    },
  ]);
  assert.deepEqual(
    unhostableInserts(song, new Set(["phaser"])),
    [],
    "a host that has the module has nothing to report",
  );
  assert.deepEqual(
    unhostableInserts(
      {
        ...song,
        inserts: { ...song.inserts, "ins-rev": insertOf("ins-rev", "return:verb", 0, "reverb", {}) },
      },
      new Set(),
    ).map((problem) => problem.message),
    [
      'phaser on Lead could not be built: this render has no compiled "phaser" effect.',
      'reverb on Reverb could not be built: this render has no compiled "reverb" effect.',
    ],
    "a return's chain is named by the return's name, not its id",
  );

  // This checkout HAS built its effects, so the same song renders with the
  // phaser really in the chain and reports no problem at all.
  const hosted = await renderSong(song, { scene_id: "scene-1", seconds: 1 });
  assert.deepEqual(hosted.effect_problems, []);
  const plain = await renderSong(oneTrackSong(), { scene_id: "scene-1", seconds: 1 });
  assert.ok(
    largestDifference(hosted, plain) > 0.01,
    "the hosted effect changes the audio, so the chain really ran",
  );

  // An insert the ENGINE had to bypass after an invalid sample is reported too,
  // from the processor's own message, and the song still renders around it.
  // (Forcing that here would need an effect that misbehaves, so the fault is fed
  // to the same collector the port feeds: `faultProblems` through a stubbed
  // engine would prove less than the port test the engine has.)
  assert.equal(hosted.seconds, 1, "the render happened");
});

test("a stored render carries the target, meets_target and the metered short-term figure", async () => {
  // The storage rail's half of the mixer's figures (plan 1d, Task 11): the song's
  // own target, whether the master chain's output meets it, and the short-term
  // figure the engine's meter took. The audio renderer is stubbed with a loud
  // sine, so the arithmetic is checked exactly instead of approximately.
  const tone = sine({ seconds: 2, amplitude: 0.5, channels: 2 });
  const db = fakeDb();
  const storage = fakeStorage();
  const acl = fakeAcl();
  const renderer = createRenderer({
    db,
    storage,
    acl,
    maxSeconds: 300,
    now: () => CLOCK,
    renderAudio: async () => ({
      ...tone,
      sampleRate: SAMPLE_RATE,
      seconds: 2,
      short_term_max_lufs: -5.5,
      effect_problems: [{ insert_id: "ins-x", message: "x on Lead produced an invalid sample; it is bypassed." }],
    }),
  });

  const song = {
    ...oneTrackSong(),
    master: { gain_db: 0, target: { lufs: -6, true_peak_db: -3 } },
  };
  const met = await renderer.render({
    song_id: "song-1",
    project_id: PROJECT, snapshot: song, scene_id: "scene-1", seconds: 2,
  });
  // A half-scale sine on both channels reads about -6 LUFS and -6.02 dBTP.
  assert.ok(Math.abs(met.lufs - -6.02) < 0.3, `expected about -6 LUFS, got ${met.lufs}`);
  assert.deepEqual(met.target, { lufs: -6, true_peak_db: -3 });
  assert.deepEqual(met.meets_target, { lufs: true, true_peak: true });
  assert.equal(met.short_term_max_lufs, -5.5, "the engine's own short-term figure comes back untouched");
  assert.deepEqual(met.effect_problems, [
    { insert_id: "ins-x", message: "x on Lead produced an invalid sample; it is bypassed." },
  ]);

  const audit = acl.audits.find((entry) => entry.action === "studio.render");
  assert.deepEqual(audit.payload.target, met.target, "the audit line carries the target");
  assert.deepEqual(audit.payload.meets_target, met.meets_target);
  assert.equal(audit.payload.short_term_max_lufs, -5.5);
  assert.deepEqual(audit.payload.effect_problems, met.effect_problems);

  // A target the mix does not reach says so, field by field: the loudness is far
  // below -14 LUFS and the peak is under the ceiling all the same.
  const silent = createRenderer({
    db: fakeDb(),
    storage: fakeStorage(),
    acl: fakeAcl(),
    maxSeconds: 300,
    now: () => CLOCK,
    renderAudio: async () => stubAudio(),
  });
  const quiet = await silent.render({
    song_id: "song-1", project_id: PROJECT, snapshot: oneTrackSong(), seconds: 1,
  });
  assert.deepEqual(quiet.target, { lufs: -14, true_peak_db: -1 }, "a song without a master reads the reference");
  assert.deepEqual(quiet.meets_target, { lufs: false, true_peak: true }, "silence is quiet, not loud enough");
  assert.equal(quiet.short_term_max_lufs, null, "a stub with no meter reports no short-term figure");
  assert.deepEqual(quiet.effect_problems, []);

  // The renderer remembers the song's last render for `studio_mix`.
  assert.deepEqual(renderer.lastRender("song-1"), {
    integrated_lufs: met.lufs,
    true_peak_db: met.true_peak_db,
    short_term_max_lufs: -5.5,
    target: { lufs: -6, true_peak_db: -3 },
    meets_target: { lufs: true, true_peak: true },
    seconds: 2,
    storage_key: met.storage_key,
  });
  assert.equal(renderer.lastRender("song-2"), null, "a song nothing has rendered has no last render");
});

test("a render loads the fonts its tracks use", async () => {
  // Four tracks: one bank plays on two of them (so it is read once), one bank is
  // only played by a MUTED track (a muted track is still the song's, so its
  // instrument is loaded — and then silence), and one plays a catalog entry this
  // Crow really holds.
  const song = fontSong(
    [
      { id: "piano", name: "Piano", font_id: FONT_UPLOAD, program: 0 },
      { id: "bass", name: "Bass", font_id: FONT_UPLOAD, program: 0 },
      { id: "pad", name: "Pad", font_id: FONT_MUTED, program: 2, mute: true },
      { id: "lead", name: "Lead", font_id: FONT_CATALOG, program: 1 },
    ],
    {
      [FONT_UPLOAD]: fontEntryOf(FONT_UPLOAD, { credit: "Tiny Font by a person" }),
      [FONT_MUTED]: fontEntryOf(FONT_MUTED, { credit: "" }),
      [FONT_CATALOG]: fontEntryOf(FONT_CATALOG, {
        source: "catalog",
        catalog_id: "tiny-test-font",
        storage_key: null,
        sha256: CATALOG_SHA,
        credit: "Tiny Font by a person",
      }),
    },
  );

  const asked = [];
  const rendered = await renderSong(song, {
    scene_id: "scene-1",
    seconds: 1,
    libraryBytes: async (entry) => {
      asked.push(entry.id);
      return fontBytes();
    },
  });

  assert.deepEqual(
    asked,
    [FONT_UPLOAD, FONT_MUTED, FONT_CATALOG],
    "each font the tracks name, once each, in first-use order, the muted track's included",
  );
  assert.deepEqual(rendered.missing_library, [], "every font this render asked for was loaded");
  assert.ok(
    toneAmplitude(rendered.left, 4800, 24000, TONE_PROGRAM_0) > 0.01,
    "the uploaded bank's program 0 (340 Hz) sounds",
  );
  assert.ok(
    toneAmplitude(rendered.left, 4800, 24000, TONE_PROGRAM_1) > 0.01,
    "the catalog bank's program 1 (420 Hz) sounds",
  );
  assert.ok(
    toneAmplitude(rendered.left, 4800, 24000, 500) < 0.005,
    "the muted track's bank is loaded and still plays nothing",
  );
  assert.deepEqual(rendered.credits, ["Tiny Font by a person"], "one credit line, deduped, in first-use order");

  // Through the storage rail, the production reader runs: an upload comes from
  // its own storage key, and a catalog entry only from a verified copy this
  // Crow holds on disk.
  const directory = mkdtempSync(join(tmpdir(), "studio-fonts-"));
  const stored = join(directory, `${CATALOG_SHA}.sf2`);
  writeFileSync(stored, TINY_FONT);
  const db = fakeDb();
  const storage = fakeStorage();
  const acl = fakeAcl();
  storage.objects.set(fontKey(FONT_UPLOAD), TINY_FONT);
  storage.objects.set(fontKey(FONT_MUTED), TINY_FONT);
  const renderer = createRenderer({
    db,
    storage,
    acl,
    library: fakeLibraryStore(CATALOG_SHA, stored),
    maxSeconds: 300,
    now: () => CLOCK,
  });

  const result = await renderer.render({
    song_id: "song-1",
    project_id: PROJECT,
    snapshot: song,
    scene_id: "scene-1",
    seconds: 1,
  });
  assert.deepEqual(result.missing_library, [], "the rail loaded both fonts");
  assert.deepEqual(result.credits, ["Tiny Font by a person"]);
  assert.deepEqual(
    storage.gets.map((get) => get.key),
    [fontKey(FONT_UPLOAD), fontKey(FONT_MUTED)],
    "the uploads are read from their own keys, and the catalog file from the disk",
  );
  const audio = decodeWav(storage.uploads[0].data);
  assert.ok(
    toneAmplitude(audio.channels[0], 4800, 24000, TONE_PROGRAM_0) > 0.01,
    "the stored render really plays the uploaded bank",
  );
  assert.ok(
    toneAmplitude(audio.channels[0], 4800, 24000, TONE_PROGRAM_1) > 0.01,
    "and the catalog bank",
  );
  const audit = acl.audits.find((entry) => entry.action === "studio.render");
  assert.ok(audit, "the render is audited");
  assert.deepEqual(audit.payload.credits, ["Tiny Font by a person"], "the audit line carries the credits too");
  assert.deepEqual(audit.payload.missing_library, []);
});

test("a render reports a missing font", async () => {
  // The song names a catalog file this device never downloaded. Its track plays
  // silence and the render says why; the track on the bank we do hold still
  // sounds, and nothing throws (Review Focus 5).
  const song = fontSong(
    [
      { id: "piano", name: "Piano", font_id: FONT_UPLOAD, program: 0 },
      { id: "pad", name: "Pad", font_id: FONT_GONE, program: 1 },
    ],
    {
      [FONT_UPLOAD]: fontEntryOf(FONT_UPLOAD),
      [FONT_GONE]: fontEntryOf(FONT_GONE, {
        source: "catalog",
        catalog_id: "never-downloaded",
        storage_key: null,
        sha256: GONE_SHA,
      }),
    },
  );

  const asked = [];
  const rendered = await renderSong(song, {
    scene_id: "scene-1",
    seconds: 1,
    libraryBytes: async (entry) => {
      asked.push(entry.id);
      return entry.id === FONT_UPLOAD ? fontBytes() : null;
    },
  });
  assert.deepEqual(asked, [FONT_UPLOAD, FONT_GONE], "both fonts are asked about, once each");
  assert.deepEqual(rendered.missing_library, [{ id: FONT_GONE, reason: "not on this device" }]);
  assert.equal(rendered.seconds, 1, "the render still happened");
  assert.ok(
    toneAmplitude(rendered.left, 4800, 24000, TONE_PROGRAM_0) > 0.01,
    "the bank this device holds still sounds",
  );
  assert.ok(
    toneAmplitude(rendered.left, 4800, 24000, TONE_PROGRAM_1) < 0.005,
    "the missing font's preset is silent",
  );

  // A track that names a font the song's library does not hold at all is
  // reported the same way, and nothing is read for it.
  const orphaned = structuredClone(song);
  delete orphaned.library[FONT_GONE];
  const read = [];
  const orphan = await renderSong(orphaned, {
    scene_id: "scene-1",
    seconds: 1,
    libraryBytes: async (entry) => {
      read.push(entry.id);
      return fontBytes();
    },
  });
  assert.deepEqual(read, [FONT_UPLOAD], "a font the song does not hold is never read");
  assert.deepEqual(orphan.missing_library, [{ id: FONT_GONE, reason: "not on this device" }]);

  // A reader that fails is "could not be read"; the engine's own refusal is
  // passed on in the engine's words.
  const unreadable = await renderSong(song, {
    scene_id: "scene-1",
    seconds: 1,
    libraryBytes: async (entry) => {
      if (entry.id === FONT_GONE) throw new Error("EIO: the disk went away");
      return fontBytes();
    },
  });
  assert.deepEqual(unreadable.missing_library, [{ id: FONT_GONE, reason: "could not be read" }]);

  const refused = await renderSong(song, {
    scene_id: "scene-1",
    seconds: 1,
    libraryBytes: async (entry) => (entry.id === FONT_GONE ? new Uint8Array([0, 1, 2, 3]) : fontBytes()),
  });
  assert.equal(refused.missing_library.length, 1, "a bank that will not parse is missing too");
  assert.equal(refused.missing_library[0].id, FONT_GONE);
  assert.ok(
    refused.missing_library[0].reason !== "not on this device" && refused.missing_library[0].reason !== "could not be read",
    `the engine's own reason is passed on, got ${refused.missing_library[0].reason}`,
  );

  // Through the storage rail: storage holds the upload and the instrument store
  // holds no catalog file, so the result names the catalog font and the audit
  // line carries the same list.
  const db = fakeDb();
  const storage = fakeStorage();
  const acl = fakeAcl();
  storage.objects.set(fontKey(FONT_UPLOAD), TINY_FONT);
  const renderer = createRenderer({
    db,
    storage,
    acl,
    library: fakeLibraryStore(CATALOG_SHA, join(tmpdir(), "this-file-does-not-exist.sf2")),
    maxSeconds: 300,
    now: () => CLOCK,
  });
  const result = await renderer.render({
    song_id: "song-1",
    project_id: PROJECT,
    snapshot: song,
    scene_id: "scene-1",
    seconds: 1,
  });
  assert.deepEqual(result.missing_library, [{ id: FONT_GONE, reason: "not on this device" }]);
  const audit = acl.audits.find((entry) => entry.action === "studio.render");
  assert.deepEqual(audit.payload.missing_library, result.missing_library, "the audit line names the font");
  assert.equal(storage.uploads.length, 1, "the render is still stored");
});

test("a render whose fonts pass 1 GiB is refused before it starts", async () => {
  const MB = 1024 * 1024;
  // Declared file sizes alone put the window past the budget: the refusal is
  // arithmetic, so no font is read, decoded or allocated.
  const song = fontSong(
    [
      { id: "piano", name: "Piano", font_id: FONT_UPLOAD, program: 0 },
      { id: "pad", name: "Pad", font_id: FONT_CATALOG, program: 1 },
    ],
    {
      [FONT_UPLOAD]: fontEntryOf(FONT_UPLOAD, { bytes: 700 * MB }),
      [FONT_CATALOG]: fontEntryOf(FONT_CATALOG, { bytes: 700 * MB }),
    },
  );

  const asked = [];
  await assert.rejects(
    renderSong(song, {
      scene_id: "scene-1",
      seconds: 1,
      libraryBytes: async (entry) => {
        asked.push(entry.id);
        return fontBytes();
      },
    }),
    { message: "This render's instruments need 1400 MB; a render takes up to 1024 MB of instruments." },
  );
  assert.deepEqual(asked, [], "no font is read for a render that cannot hold them");

  // The budget is overridable exactly as the sample cap is (a test names a
  // handful of bytes), and the refusal names the cap it used.
  await assert.rejects(
    renderSong(song, {
      scene_id: "scene-1",
      seconds: 1,
      fontCapBytes: 1024,
      libraryBytes: async () => fontBytes(),
    }),
    { message: "This render's instruments need 1400 MB; a render takes up to 1 MB of instruments." },
  );

  // The same render, inside the budget, is a render: nothing is refused for
  // being merely close to it.
  const under = fontSong(
    [{ id: "piano", name: "Piano", font_id: FONT_UPLOAD, program: 0 }],
    { [FONT_UPLOAD]: fontEntryOf(FONT_UPLOAD, { bytes: 512 * MB }) },
  );
  const rendered = await renderSong(under, {
    scene_id: "scene-1",
    seconds: 1,
    libraryBytes: async () => fontBytes(),
  });
  assert.equal(rendered.seconds, 1);
  assert.deepEqual(rendered.missing_library, []);
});

// --- renders with the starter sounds that ship in the bundle ----------------

/**
 * One starter sound as a song's library entry: the bundled row's own id, name,
 * hash, size and credit, with `source: "bundled"` and no storage key — the file
 * lives in the bundle, not in a song's storage.
 * @param {object} row - one row of `library/bundled.json`
 * @returns {object}
 */
function starterEntry(row) {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    source: "bundled",
    catalog_id: null,
    storage_key: null,
    upload_id: null,
    sha256: row.sha256,
    bytes: row.bytes,
    licence: row.licence,
    credit: row.credit,
    author_label: "You",
  };
}

test("a render plays a starter capture through a starter cabinet", async () => {
  const { createLibraryStore, readBundled } = await import("../bundles/studio/server/library-store.js");
  const { entries } = await readBundled();
  const starter = entries.find((entry) => entry.id === "starter-a2");
  const cabinet = entries.find((entry) => entry.id === "cabinet-ampmix");
  assert.ok(starter, "the bundle ships the starter capture");
  assert.ok(cabinet, "and the starter cabinets");

  // A guitar take through one amp: the capture and the cabinet are the starter
  // sounds, added to the song by the person (a bundled entry, no storage key).
  const song = audioSong([{ scene_id: "scene-1", clip_id: "clip-1", take_id: TAKE_ID }]);
  song.library = { [starter.id]: starterEntry(starter), [cabinet.id]: starterEntry(cabinet) };
  song.inserts = {
    "amp-1": {
      id: "amp-1",
      owner: "track:audio-1",
      order: 1,
      kind: "amp",
      bypass: false,
      params: { model_id: starter.id, ir_id: cabinet.id, input_db: 0, output_db: 0, ir_mix: 1 },
    },
  };

  // The real renderer, with the real instrument store: a bundled file is read
  // from the bundle itself and hashed against its own list on the way in.
  const crowHome = mkdtempSync(join(tmpdir(), "studio-starters-"));
  const storage = fakeStorage();
  storage.objects.set(takeKey(TAKE_ID), takeWav());
  const acl = fakeAcl();
  const renderer = createRenderer({
    db: fakeDb(),
    storage,
    acl,
    library: createLibraryStore({ crowHome }),
    maxSeconds: 300,
    now: () => CLOCK,
  });

  const result = await renderer.render({
    song_id: "song-1",
    project_id: PROJECT,
    snapshot: song,
    scene_id: "scene-1",
    seconds: 1,
  });
  assert.deepEqual(result.missing_library, [], "both starter files were found and loaded");
  const audio = decodeWav(storage.uploads[0].data);
  const peak = peakOf(audio.channels[0], audio.channels[1] || audio.channels[0]);
  assert.ok(peak > 0.001, `the amp has to make sound through the starter cabinet, peak ${peak}`);

  // On a bundle that carries no starter sounds, the same song renders anyway:
  // the insert is silent and both files are named, never thrown (Review Focus 5).
  const bareHome = mkdtempSync(join(tmpdir(), "studio-starters-bare-"));
  const bareList = join(bareHome, "bundled.json");
  writeFileSync(bareList, JSON.stringify({ version: 1, entries: [] }), "utf8");
  const bareStorage = fakeStorage();
  bareStorage.objects.set(takeKey(TAKE_ID), takeWav());
  const bare = createRenderer({
    db: fakeDb(),
    storage: bareStorage,
    acl: fakeAcl(),
    library: createLibraryStore({ crowHome: bareHome, bundledPath: bareList }),
    maxSeconds: 300,
    now: () => CLOCK,
  });
  const missing = await bare.render({
    song_id: "song-1",
    project_id: PROJECT,
    snapshot: song,
    scene_id: "scene-1",
    seconds: 1,
  });
  assert.deepEqual(
    missing.missing_library.map((item) => item.id).sort(),
    [starter.id, cabinet.id].sort(),
    `both starter sounds have to be reported, got ${JSON.stringify(missing.missing_library)}`,
  );
  assert.equal(missing.seconds, 1, "the render still happened");
});

test("a proposed amp is skipped by the render's capture and cabinet list", async () => {
  const { createLibraryStore, readBundled } = await import("../bundles/studio/server/library-store.js");
  const { entries } = await readBundled();
  const starter = entries.find((entry) => entry.id === "starter-a2");
  const cabinet = entries.find((entry) => entry.id === "cabinet-ampmix");
  assert.ok(starter, "the bundle ships the starter capture");
  assert.ok(cabinet, "and the starter cabinets");

  // One guitar take through two amps: the live one plays the starter sounds,
  // and the second is a proposal the operator has not accepted. It names a
  // capture and a cabinet the song's library does not hold at all — a render
  // that counted it would report both as missing, and load nothing anyway.
  const song = audioSong([{ scene_id: "scene-1", clip_id: "clip-1", take_id: TAKE_ID }]);
  song.library = { [starter.id]: starterEntry(starter), [cabinet.id]: starterEntry(cabinet) };
  song.inserts = {
    "amp-live": {
      id: "amp-live",
      owner: "track:audio-1",
      order: 1,
      kind: "amp",
      bypass: false,
      proposed: false,
      set_by: "operator",
      params: { model_id: starter.id, ir_id: cabinet.id, input_db: 0, output_db: 0, ir_mix: 1 },
    },
    "amp-proposed": {
      id: "amp-proposed",
      owner: "track:audio-1",
      order: 2,
      kind: "amp",
      bypass: false,
      proposed: true,
      set_by: "agent",
      params: { model_id: "ghost-capture", ir_id: "ghost-cabinet", input_db: 0, output_db: 0, ir_mix: 1 },
    },
  };

  const crowHome = mkdtempSync(join(tmpdir(), "studio-proposal-"));
  const storage = fakeStorage();
  storage.objects.set(takeKey(TAKE_ID), takeWav());
  const renderer = createRenderer({
    db: fakeDb(),
    storage,
    acl: fakeAcl(),
    library: createLibraryStore({ crowHome }),
    maxSeconds: 300,
    now: () => CLOCK,
  });

  const result = await renderer.render({
    song_id: "song-1",
    project_id: PROJECT,
    snapshot: song,
    scene_id: "scene-1",
    seconds: 1,
  });
  assert.deepEqual(result.missing_library, [], "a proposal is not a missing file");
  const audio = decodeWav(storage.uploads[0].data);
  const peak = peakOf(audio.channels[0], audio.channels[1] || audio.channels[0]);
  assert.ok(peak > 0.001, `the live amp still plays, peak ${peak}`);

  // The same song with the proposal accepted into a LIVE amp: the two files it
  // names are the render's to find, and it says it cannot.
  const live = structuredClone(song);
  live.inserts["amp-proposed"].proposed = false;
  const liveStorage = fakeStorage();
  liveStorage.objects.set(takeKey(TAKE_ID), takeWav());
  const liveRenderer = createRenderer({
    db: fakeDb(),
    storage: liveStorage,
    acl: fakeAcl(),
    library: createLibraryStore({ crowHome }),
    maxSeconds: 300,
    now: () => CLOCK,
  });
  const missing = await liveRenderer.render({
    song_id: "song-1",
    project_id: PROJECT,
    snapshot: live,
    scene_id: "scene-1",
    seconds: 1,
  });
  assert.deepEqual(
    missing.missing_library.map((item) => item.id).sort(),
    ["ghost-cabinet", "ghost-capture"],
    `a live amp's files are the render's business, got ${JSON.stringify(missing.missing_library)}`,
  );
});

test("a song entry that names an older bundled file is missing, not the new sound", async () => {
  // The song's entry names the file it was added with. A bundle that now ships a
  // DIFFERENT file under that id is not that sound, so the cabinet reads as a file
  // this device does not hold and is named in `missing_library` — the same rule
  // the library file route keeps — rather than playing the new file under the old
  // entry's name.
  const { createLibraryStore, readBundled } = await import("../bundles/studio/server/library-store.js");
  const { entries } = await readBundled();
  const starter = entries.find((entry) => entry.id === "starter-a2");
  const cabinet = entries.find((entry) => entry.id === "cabinet-ampmix");
  assert.ok(starter, "the bundle ships the starter capture");
  assert.ok(cabinet, "and the starter cabinets");

  const song = audioSong([{ scene_id: "scene-1", clip_id: "clip-1", take_id: TAKE_ID }]);
  const stale = starterEntry(cabinet);
  // An older file under the same id: what the song was given, before a later
  // bundle replaced it.
  stale.sha256 = "0".repeat(64);
  song.library = { [starter.id]: starterEntry(starter), [cabinet.id]: stale };
  song.inserts = {
    "amp-1": {
      id: "amp-1",
      owner: "track:audio-1",
      order: 1,
      kind: "amp",
      bypass: false,
      params: { model_id: starter.id, ir_id: cabinet.id, input_db: 0, output_db: 0, ir_mix: 1 },
    },
  };

  const crowHome = mkdtempSync(join(tmpdir(), "studio-stale-starter-"));
  const storage = fakeStorage();
  storage.objects.set(takeKey(TAKE_ID), takeWav());
  const renderer = createRenderer({
    db: fakeDb(),
    storage,
    acl: fakeAcl(),
    library: createLibraryStore({ crowHome }),
    maxSeconds: 300,
    now: () => CLOCK,
  });

  const result = await renderer.render({
    song_id: "song-1",
    project_id: PROJECT,
    snapshot: song,
    scene_id: "scene-1",
    seconds: 1,
  });
  assert.deepEqual(
    result.missing_library.map((item) => item.id),
    [cabinet.id],
    `the out-of-date cabinet has to be named, got ${JSON.stringify(result.missing_library)}`,
  );
  assert.equal(
    result.missing_library.some((item) => item.id === starter.id),
    false,
    "the capture the song still matches is not reported",
  );
});