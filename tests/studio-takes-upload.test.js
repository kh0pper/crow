/**
 * Take uploads: staging on disk, chunk idempotency, the streamed 24-bit WAV,
 * quota, the internal `take.add`, and the rules that keep a recorded take from
 * being lost (spec §12).
 *
 * Everything here runs against a scratch staging directory, a fake storage
 * client, a fake database, a fake project ACL, a fake hub and a fake song
 * lookup, so nothing touches a real bucket, a real `crow.db` or a real `~/.crow`.
 * The WAV check uses the real `decodeWav`, so the bytes that would have gone to
 * storage are read back and compared sample by sample.
 *
 * The fakes enforce what the real ones do where these rules depend on it: the
 * fake database holds `storage_files.s3_key` UNIQUE (and honours the insert's
 * `ON CONFLICT ... DO NOTHING`), and the fake hub answers a repeated `cmd_id`
 * with the result it gave the first time and refuses a take id that is already
 * in the song.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTakeUploads } from "../bundles/studio/server/takes-upload.js";
import { decodeWav } from "../bundles/studio/server/wav.js";

/** The song, clip and project every take in these tests belongs to. */
const SONG = "song-1";
const CLIP = "clip-1";
const PROJECT = 7;

/** The project's storage prefix, as `project_spaces.storage_prefix` holds it. */
const PREFIX = "projects/7/";

/** Who is recording: the operator, through a dashboard route. */
const AUTHOR = { kind: "human", id: "local", label: "You" };

/** 24-bit signed full scale, the convention `wav.js` encodes with. */
const FULL_SCALE = 8388607;

/** A day in milliseconds, for the sweep checks. */
const DAY = 24 * 60 * 60 * 1000;

/** One megabyte, the unit `quotaMb` is in. */
const MB = 1024 * 1024;

/** The `KSDATAFORMAT_SUBTYPE_PCM` GUID an extensible WAV carries. */
const PCM_GUID = Buffer.from([
  0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71,
]);

/** @returns {string} a fresh scratch staging directory. */
function scratch() {
  return mkdtempSync(join(tmpdir(), "studio-upload-"));
}

/**
 * An object store that records every call and drains the stream it is handed,
 * so a test can decode exactly the bytes the upload would have written.
 * @param {{bucket?: string, usedBytes?: number, delayMs?: number}} [options]
 */
function fakeStorage({ bucket = "crow-files", usedBytes = 0, delayMs = 0 } = {}) {
  const uploads = [];
  const deleted = [];
  const statsCalls = [];
  const store = {
    uploads,
    deleted,
    statsCalls,
    async putObjectStream(key, stream, size, options) {
      // Capture the stream itself before draining it: the point of the upload
      // is that storage receives a stream, never one assembled buffer.
      const pieces = [];
      for await (const piece of stream) pieces.push(Buffer.from(piece));
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      uploads.push({ key, stream, size, options, bytes: Buffer.concat(pieces) });
    },
    async deleteObject(key, target) {
      deleted.push({ key, bucket: target });
    },
    async getBucketStats(target) {
      statsCalls.push(target);
      return { totalSizeBytes: usedBytes };
    },
    defaultBucket() {
      return bucket;
    },
  };
  return store;
}

/**
 * A database client that answers the prefix lookup, keeps `storage_files`
 * rows under `s3_key` UNIQUE (as `scripts/init-db.js` declares it) and records
 * every statement. `failInsert` makes the insert throw, the way a database out
 * of space would.
 * @param {{prefix?: string, failInsert?: boolean}} [options]
 */
function fakeDb({ prefix = PREFIX, failInsert = false } = {}) {
  const statements = [];
  const rows = new Set();
  return {
    statements,
    rows,
    async execute(statement) {
      const sql = typeof statement === "string" ? statement : statement.sql;
      const args = statement && Array.isArray(statement.args) ? statement.args : [];
      statements.push(statement);
      if (/INSERT\s+INTO\s+storage_files/i.test(sql)) {
        if (failInsert) throw new Error("insert failed: no space left on device");
        const key = args[0];
        if (rows.has(key)) {
          // The only duplicate this insert may survive is its own retry.
          if (!/ON\s+CONFLICT\s*\(\s*s3_key\s*\)\s+DO\s+NOTHING/i.test(sql)) {
            throw new Error("UNIQUE constraint failed: storage_files.s3_key");
          }
          return { rows: [] };
        }
        rows.add(key);
        return { rows: [] };
      }
      if (/DELETE\s+FROM\s+storage_files/i.test(sql)) {
        rows.delete(args[0]);
        return { rows: [] };
      }
      if (/storage_prefix/i.test(sql)) return { rows: [{ storage_prefix: prefix }] };
      return { rows: [] };
    },
  };
}

/**
 * A project ACL that records its calls, and can refuse them.
 * @param {{deny?: boolean}} [options]
 */
function fakeAcl({ deny = false } = {}) {
  const calls = [];
  const audits = [];
  return {
    calls,
    audits,
    async assertCapability(db, projectId, objectId, capability) {
      calls.push({ projectId, objectId, capability });
      if (!deny) return { role: "owner" };
      const error = new Error("You cannot write files in this project.");
      error.name = "AclError";
      throw error;
    },
    async appendAudit(db, entry) {
      audits.push(entry);
    },
  };
}

/**
 * A session hub: `openSong` answers with the song's takes and tempo,
 * `runCommand` remembers what it was asked, answers a repeated `cmd_id` with
 * the result it gave the first time, and refuses a take id the song already has.
 *
 * `unreadable` makes `openSong` throw, the way a database or a locked song can.
 * @param {{takes?: object, bpm?: number, refuse?: {code: string, error: string},
 *          unreadable?: boolean}} [options]
 */
function fakeHub({ takes = {}, bpm = 124, refuse = null, unreadable = false } = {}) {
  const commands = [];
  const state = { takes: { ...takes } };
  const answers = new Map();
  return {
    commands,
    state,
    async openSong() {
      if (unreadable) throw new Error("the song's document could not be loaded");
      return {
        doc: null,
        snapshot: { meta: { title: "Test song", bpm }, takes: state.takes, clips: {} },
        snapshot_version: 1,
      };
    },
    async runCommand(request) {
      commands.push(request);
      const seen = answers.get(request.cmd_id);
      if (seen) return seen;
      let result;
      if (refuse) {
        result = { ok: false, code: refuse.code, error: refuse.error };
      } else if (state.takes[request.args.take.id]) {
        result = {
          ok: false,
          code: "invalid",
          error: `A take with id "${request.args.take.id}" already exists in this song.`,
        };
      } else {
        state.takes[request.args.take.id] = {
          ...request.args.take,
          clip_id: request.args.clip_id,
          discarded: false,
        };
        result = { ok: true, entry: { command: request.command }, snapshot_version: 2 };
      }
      answers.set(request.cmd_id, result);
      return result;
    },
  };
}

/**
 * The song table's lookup: a take's project is its song's. `songProject: null`
 * means the song is not there.
 * @param {number|null} project
 */
function fakeSongs(project = PROJECT) {
  return {
    async projectOf() {
      return project;
    },
  };
}

/** @returns {object} a finished upload service plus the fakes it was built on. */
function setup(overrides = {}) {
  const staging = scratch();
  const storage = fakeStorage(overrides.storage);
  const db = fakeDb(overrides.db);
  const acl = fakeAcl(overrides.acl);
  const hub = fakeHub(overrides.hub);
  const songs = fakeSongs(overrides.songProject === undefined ? PROJECT : overrides.songProject);
  const uploads = createTakeUploads({
    stagingDir: staging,
    storage,
    db,
    acl,
    hub,
    songs,
    now: overrides.now ?? (() => Date.now()),
    quotaMb: overrides.quotaMb ?? 5120,
    maxTakeSeconds: overrides.maxTakeSeconds ?? 1200,
    ...(overrides.maxSamples === undefined ? {} : { maxSamples: overrides.maxSamples }),
  });
  return { staging, storage, db, acl, hub, songs, uploads };
}

/** @returns {object} the details a dashboard route would send with `begin`. */
function beginRequest(overrides = {}) {
  return {
    song_id: SONG,
    project_id: PROJECT,
    clip_id: CLIP,
    rate: 48000,
    channels: 2,
    author: AUTHOR,
    ...overrides,
  };
}

/**
 * A deterministic stereo (or mono) signal, in [-1, 1).
 * @param {number} frames
 * @param {number} [channels]
 * @returns {Float32Array[]}
 */
function signal(frames, channels = 2) {
  const out = [];
  for (let channel = 0; channel < channels; channel += 1) {
    const samples = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame += 1) {
      samples[frame] = Math.sin((2 * Math.PI * (frame + 1) * (channel + 3)) / 97) * 0.8;
    }
    out.push(samples);
  }
  return out;
}

/**
 * One range of a signal as interleaved 24-bit little-endian PCM, the way the
 * recorder worklet writes it.
 * @param {Float32Array[]} channels
 * @param {number} [from]
 * @param {number} [to]
 * @returns {Buffer}
 */
function pcm24(channels, from = 0, to = channels[0].length) {
  const frameBytes = channels.length * 3;
  const bytes = Buffer.alloc((to - from) * frameBytes);
  let at = 0;
  for (let frame = from; frame < to; frame += 1) {
    for (const channel of channels) {
      let value = Math.round(Math.max(-1, Math.min(1, channel[frame])) * FULL_SCALE);
      if (value < 0) value += 0x1000000;
      bytes[at] = value & 0xff;
      bytes[at + 1] = (value >> 8) & 0xff;
      bytes[at + 2] = (value >> 16) & 0xff;
      at += 3;
    }
  }
  return bytes;
}

/**
 * What `decodeWav` must give back for one channel: the encoder's own full
 * scale, stored in a Float32Array.
 * @param {Float32Array} samples
 * @param {number} [fullScale]
 * @returns {Float32Array}
 */
function quantised(samples, fullScale = FULL_SCALE) {
  const out = new Float32Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.round(Math.max(-1, Math.min(1, samples[index])) * fullScale);
    // A sample that quantises to zero comes back as +0 from the integer bytes,
    // never as the -0 Math.round() would hand back at 24 bits.
    out[index] = value === 0 ? 0 : value / fullScale;
  }
  return out;
}

/** @returns {string} the hash a client would send for a chunk. */
function hashOf(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Stage a list of chunks, in order.
 * @param {object} uploads
 * @param {string} takeId
 * @param {Buffer[]} chunks
 * @returns {Promise<string[]>} their hashes
 */
async function stageChunks(uploads, takeId, chunks) {
  const hashes = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const { sha256 } = await uploads.putChunk(takeId, index, chunks[index]);
    hashes.push(sha256);
  }
  return hashes;
}

/** @returns {string} the storage key a take is filed under. */
function keyOf(takeId) {
  return `${PREFIX}studio/${SONG}/takes/${takeId}.wav`;
}

/** @returns {string[]} the sorted names in a take's staging directory. */
function stagedNames(staging, takeId) {
  return readdirSync(join(staging, takeId)).sort();
}

/**
 * Build a WAV file by hand, so decoding is checked against bytes this code did
 * not write: `format` 3 makes an IEEE-float file, `extensible` a
 * `WAVE_FORMAT_EXTENSIBLE` one with a PCM sub-format.
 * @param {{rate?: number, bits?: number, format?: number, channels: Float32Array[],
 *          extensible?: boolean, extra?: Buffer|null}} [options]
 * @returns {Buffer}
 */
function buildWav({ rate = 48000, bits = 24, format = 1, channels, extensible = false, extra = null }) {
  const channelCount = channels.length;
  const frames = channels[0].length;
  const bytesPerSample = bits / 8;
  const blockAlign = channelCount * bytesPerSample;
  const data = Buffer.alloc(frames * blockAlign);
  const scale = Math.pow(2, bits - 1) - 1;
  let at = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      const value = Math.max(-1, Math.min(1, channels[channel][frame]));
      if (bits === 32) {
        data.writeFloatLE(value, at);
        at += 4;
        continue;
      }
      const integer = Math.round(value * scale);
      if (bits === 16) {
        data.writeInt16LE(integer, at);
        at += 2;
        continue;
      }
      let v = integer < 0 ? integer + 0x1000000 : integer;
      data[at] = v & 0xff;
      data[at + 1] = (v >> 8) & 0xff;
      data[at + 2] = (v >> 16) & 0xff;
      at += 3;
    }
  }

  const fmtSize = extensible ? 40 : 16;
  const fmt = Buffer.alloc(8 + fmtSize);
  fmt.write("fmt ", 0, "ascii");
  fmt.writeUInt32LE(fmtSize, 4);
  fmt.writeUInt16LE(extensible ? 0xfffe : format, 8);
  fmt.writeUInt16LE(channelCount, 10);
  fmt.writeUInt32LE(rate, 12);
  fmt.writeUInt32LE(rate * blockAlign, 16);
  fmt.writeUInt16LE(blockAlign, 20);
  fmt.writeUInt16LE(bits, 22);
  if (extensible) {
    fmt.writeUInt16LE(22, 24); // cbSize
    fmt.writeUInt16LE(bits, 26); // valid bits per sample
    fmt.writeUInt32LE(channelCount === 2 ? 3 : 4, 28); // channel mask
    PCM_GUID.copy(fmt, 32);
  }

  const dataHeader = Buffer.alloc(8);
  dataHeader.write("data", 0, "ascii");
  dataHeader.writeUInt32LE(data.length, 4);

  const chunks = [fmt, ...(extra ? [extra] : []), dataHeader, data];
  const riff = Buffer.alloc(12);
  riff.write("RIFF", 0, "ascii");
  riff.writeUInt32LE(4 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4);
  riff.write("WAVE", 8, "ascii");
  return Buffer.concat([riff, ...chunks]);
}

/**
 * An unknown chunk for `buildWav`'s `extra`, the way a DAW writes one.
 * @param {string} id
 * @param {string} text
 * @returns {Buffer}
 */
function extraChunk(id, text) {
  let payload = Buffer.from(`${text}\0`, "ascii");
  if (payload.length % 2 === 1) payload = Buffer.concat([payload, Buffer.alloc(1)]);
  const header = Buffer.alloc(8);
  header.write(id, 0, "ascii");
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

test("begin refuses 22050 Hz", async () => {
  const { uploads } = setup();
  await assert.rejects(
    () => uploads.begin(randomUUID(), beginRequest({ rate: 22050 })),
    (error) => {
      assert.equal(error.status, 400);
      assert.match(error.message, /rate/);
      assert.match(error.message, /44100/);
      return true;
    },
  );
});

test("begin refuses a non-UUID id", async () => {
  const { uploads, staging } = setup();
  await assert.rejects(
    () => uploads.begin("../../etc/passwd", beginRequest()),
    (error) => {
      assert.equal(error.status, 400);
      assert.match(error.message, /UUID/);
      return true;
    },
  );
  assert.deepEqual(readdirSync(staging), []);
});

test("begin refuses a project that is not the song's", async () => {
  // The song lives in project 9; the request claims project 7, where the
  // caller may well have `write_files`.
  const { uploads, staging, db } = setup({ songProject: 9 });
  await assert.rejects(
    () => uploads.begin(randomUUID(), beginRequest()),
    (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.message, "That song is not in project 7.");
      return true;
    },
  );
  assert.deepEqual(readdirSync(staging), []);
  assert.equal(db.statements.length, 0);
});

test("begin refuses a caller without write_files", async () => {
  const { uploads, staging, acl } = setup({ acl: { deny: true } });
  const takeId = randomUUID();
  await assert.rejects(
    () => uploads.begin(takeId, beginRequest()),
    (error) => {
      assert.equal(error.status, 403);
      assert.match(error.message, /cannot write files/);
      return true;
    },
  );
  // The project checked is the song's, never one the request named.
  assert.deepEqual(acl.calls, [{ projectId: PROJECT, objectId: null, capability: "write_files" }]);
  assert.deepEqual(readdirSync(staging), []);
});

test("chunk before begin is refused", async () => {
  const { uploads, staging } = setup();
  const takeId = randomUUID();
  await assert.rejects(
    () => uploads.putChunk(takeId, 0, pcm24(signal(16, 2))),
    (error) => {
      assert.equal(error.status, 404);
      assert.equal(error.message, "Begin the take before sending its audio.");
      return true;
    },
  );
  // Nothing was staged: the kata is that the take has a song before it has audio.
  assert.deepEqual(readdirSync(staging), []);
});

test("resent chunk is idempotent", async () => {
  const { uploads } = setup();
  const takeId = randomUUID();
  await uploads.begin(takeId, beginRequest());
  const bytes = pcm24(signal(32, 2));

  const first = await uploads.putChunk(takeId, 0, bytes);
  const second = await uploads.putChunk(takeId, 0, bytes);
  assert.equal(first.sha256, hashOf(bytes));
  assert.deepEqual(second, first);

  const status = await uploads.status(takeId);
  assert.equal(status.received.length, 1);
  assert.equal(status.frames, 32);
});

test("concurrent identical putChunk calls all succeed", async () => {
  const { uploads, staging } = setup();
  const takeId = randomUUID();
  await uploads.begin(takeId, beginRequest());
  const bytes = pcm24(signal(64, 2));

  const results = await Promise.all([
    uploads.putChunk(takeId, 0, bytes),
    uploads.putChunk(takeId, 0, bytes),
    uploads.putChunk(takeId, 0, bytes),
  ]);

  for (const result of results) assert.equal(result.sha256, hashOf(bytes));
  const status = await uploads.status(takeId);
  assert.equal(status.received.length, 1);
  assert.equal(status.frames, 64);
  // One chunk, one sidecar, and no temporary files left behind.
  assert.deepEqual(stagedNames(staging, takeId), ["000000.pcm", "000000.pcm.sha256", "meta.json"]);
});

test("same index different bytes is 409", async () => {
  const { uploads } = setup();
  const takeId = randomUUID();
  await uploads.begin(takeId, beginRequest());
  await uploads.putChunk(takeId, 0, pcm24(signal(16, 2), 0, 16));

  const different = pcm24(signal(16, 2), 0, 8);
  await assert.rejects(
    () => uploads.putChunk(takeId, 0, different),
    (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.message, "chunk 0 was already received with different bytes");
      return true;
    },
  );

  // The first bytes are untouched.
  const status = await uploads.status(takeId);
  assert.equal(status.frames, 16);
});

test("putChunk past the sample cap is refused", async () => {
  const { uploads, staging } = setup();
  const takeId = randomUUID();
  await uploads.begin(takeId, beginRequest());

  // A sparse staged file as heavy as the whole cap: the next chunk takes the
  // take past it without this test writing hundreds of megabytes.
  const cap = 115200000;
  const first = join(staging, takeId, "000000.pcm");
  writeFileSync(first, Buffer.alloc(0));
  truncateSync(first, cap * 3 + 1);

  await assert.rejects(
    () => uploads.putChunk(takeId, 1, pcm24(signal(4, 2))),
    (error) => {
      assert.equal(error.status, 413);
      assert.match(error.message, /115,200,000 samples/);
      return true;
    },
  );
  // Nothing new was staged.
  assert.equal(existsSync(join(staging, takeId, "000001.pcm")), false);
});

test("concurrent chunks cannot together pass the sample cap", async () => {
  const { uploads, staging } = setup();
  const takeId = randomUUID();
  await uploads.begin(takeId, beginRequest());

  // Staged audio one 2-frame chunk short of the cap: of several chunks sent
  // at once, exactly one may land.
  const cap = 115200000;
  const chunk = pcm24(signal(2, 2)); // 2 frames x 2 channels x 3 bytes = 12 bytes
  const first = join(staging, takeId, "000000.pcm");
  writeFileSync(first, Buffer.alloc(0));
  truncateSync(first, cap * 3 - chunk.byteLength);

  const results = await Promise.allSettled([1, 2, 3, 4].map((index) => uploads.putChunk(takeId, index, chunk)));
  const landed = results.filter((result) => result.status === "fulfilled").length;
  const refused = results.filter((result) => result.status === "rejected" && result.reason.status === 413).length;
  assert.equal(landed, 1, "exactly one chunk fits under the cap");
  assert.equal(refused, 3, "the others are refused as too large");
});

test("a chunk index no take of this size could need is refused", async () => {
  const { uploads } = setup();
  const takeId = randomUUID();
  await uploads.begin(takeId, beginRequest());
  const lastIndex = Math.ceil((115200000 * 3) / 1048576);
  await assert.rejects(
    () => uploads.putChunk(takeId, lastIndex + 1, pcm24(signal(2, 2))),
    (error) => error.status === 413,
  );
});

test("finish with a missing chunk names it", async () => {
  const { uploads, storage, hub } = setup();
  const takeId = randomUUID();
  await uploads.begin(takeId, beginRequest());
  const audio = signal(40, 2);
  const chunks = [pcm24(audio, 0, 10), pcm24(audio, 10, 20), pcm24(audio, 20, 30), pcm24(audio, 30, 40)];
  const hashes = await stageChunks(uploads, takeId, chunks.slice(0, 3));

  await assert.rejects(
    () => uploads.finish(takeId, { chunk_hashes: [...hashes, hashOf(chunks[3])] }),
    (error) => {
      assert.equal(error.status, 409);
      assert.match(error.message, /missing chunks 3/);
      return true;
    },
  );
  assert.equal(storage.uploads.length, 0);
  assert.equal(hub.commands.length, 0);
});

test("finish streams a WAV that decodeWav reads back sample-exact", async () => {
  const { uploads, storage } = setup();
  const takeId = randomUUID();
  const audio = signal(1000, 2);
  await uploads.begin(takeId, beginRequest());
  const chunks = [pcm24(audio, 0, 700), pcm24(audio, 700, 1000)];
  const hashes = await stageChunks(uploads, takeId, chunks);

  await uploads.finish(takeId, { chunk_hashes: hashes });

  assert.equal(storage.uploads.length, 1);
  const upload = storage.uploads[0];
  // A stream, not one buffer: the WAV of a long take is hundreds of megabytes.
  assert.equal(Buffer.isBuffer(upload.stream), false);
  assert.equal(typeof upload.stream.pipe, "function");
  assert.equal(upload.size, 44 + 1000 * 2 * 3);
  assert.equal(upload.bytes.length, upload.size);
  assert.deepEqual(upload.options, { bucket: "crow-files", contentType: "audio/wav" });

  const decoded = decodeWav(upload.bytes);
  assert.equal(decoded.rate, 48000);
  assert.equal(decoded.channels.length, 2);
  for (let channel = 0; channel < 2; channel += 1) {
    assert.equal(decoded.channels[channel].length, 1000);
    assert.deepEqual(decoded.channels[channel], quantised(audio[channel]));
  }
});

test("finish applies take.add once with the begin author", async () => {
  const { uploads, storage, db, acl, hub, staging } = setup();
  const takeId = randomUUID();
  const audio = signal(200, 2);
  await uploads.begin(takeId, beginRequest({ offset_frames: 12, compensated: true }));
  const hashes = await stageChunks(uploads, takeId, [pcm24(audio)]);

  const { take } = await uploads.finish(takeId, { chunk_hashes: hashes });
  const key = keyOf(takeId);

  assert.equal(hub.commands.length, 1);
  const command = hub.commands[0];
  assert.equal(command.command, "take.add");
  assert.equal(command.internal, true);
  assert.equal(command.cmd_id, takeId);
  assert.equal(command.song_id, SONG);
  assert.deepEqual(command.author, { kind: "human", id: "local", label: "You" });
  assert.equal(command.args.clip_id, CLIP);
  assert.equal(command.args.take.id, takeId);
  assert.equal(command.args.take.storage_key, key);
  assert.equal(command.args.take.author_label, "You");
  assert.equal(command.args.take.rate, 48000);
  assert.equal(command.args.take.channels, 2);
  assert.equal(command.args.take.frames, 200);
  assert.equal(command.args.take.offset_frames, 12);
  assert.equal(command.args.take.compensated, true);
  assert.equal(command.args.take.bpm, 124);
  assert.equal(command.args.take.discarded, false);

  assert.equal(storage.uploads[0].key, key);
  const insert = db.statements.find(
    (statement) => statement && statement.sql && /INSERT\s+INTO\s+storage_files/i.test(statement.sql),
  );
  assert.ok(insert, "a storage_files row was written");
  assert.match(insert.sql, /ON CONFLICT\(s3_key\) DO NOTHING/);
  assert.equal(insert.args[0], key);
  assert.equal(insert.args[5], "studio_take");
  assert.equal(insert.args[6], SONG);
  assert.equal(insert.args[7], PROJECT);
  assert.equal(insert.args[3], 44 + 200 * 2 * 3);

  assert.equal(acl.audits.length, 1);
  assert.equal(acl.audits[0].action, "studio.take");
  assert.equal(acl.audits[0].actor_type, "local");
  assert.equal(acl.audits[0].payload.take_id, takeId);
  assert.equal(acl.audits[0].payload.clip_id, CLIP);
  assert.equal(acl.audits[0].payload.storage_key, key);
  assert.equal(acl.audits[0].payload.seconds, 0.004);

  assert.equal(take.id, takeId);
  assert.equal(take.storage_key, key);

  // The audio is done with: its staging goes, the tiny meta stays so a retried
  // finish can still find its song.
  assert.deepEqual(stagedNames(staging, takeId), ["meta.json"]);
  const status = await uploads.status(takeId);
  assert.equal(status.frames, 200);
  assert.deepEqual(status.received, []);
});

test("finish twice returns the same take once", async () => {
  const { uploads, storage, hub, acl } = setup();
  const takeId = randomUUID();
  await uploads.begin(takeId, beginRequest());
  const hashes = await stageChunks(uploads, takeId, [pcm24(signal(64, 2))]);

  const first = await uploads.finish(takeId, { chunk_hashes: hashes });
  const second = await uploads.finish(takeId, { chunk_hashes: hashes });

  assert.deepEqual(second, first);
  assert.equal(storage.uploads.length, 1);
  assert.equal(hub.commands.length, 1);
  assert.equal(acl.audits.length, 1);
});

test("two concurrent finish calls keep the take", async () => {
  const { uploads, storage, hub, staging } = setup({ storage: { delayMs: 20 } });
  const takeId = randomUUID();
  await uploads.begin(takeId, beginRequest());
  const hashes = await stageChunks(uploads, takeId, [pcm24(signal(64, 2))]);

  const results = await Promise.all([
    uploads.finish(takeId, { chunk_hashes: hashes }),
    uploads.finish(takeId, { chunk_hashes: hashes }),
  ]);

  // Both callers get the one finish's answer; the take is uploaded and filed
  // exactly once, and the staged audio is gone.
  assert.deepEqual(results[1], results[0]);
  assert.equal(results[0].take.id, takeId);
  assert.ok(hub.state.takes[takeId], "the take is in the song");
  assert.equal(storage.uploads.length, 1);
  assert.equal(hub.commands.length, 1);
  assert.deepEqual(stagedNames(staging, takeId), ["meta.json"]);
});

test("finish retried after the row exists completes the take", async () => {
  // The row of a finish that was killed between the insert and `take.add`:
  // the key is fixed per take, so this attempt must adopt it, not trip over it.
  const { uploads, storage, db, hub, staging } = setup();
  const takeId = randomUUID();
  await uploads.begin(takeId, beginRequest());
  const hashes = await stageChunks(uploads, takeId, [pcm24(signal(64, 2))]);
  const key = keyOf(takeId);
  db.rows.add(key);

  const first = await uploads.finish(takeId, { chunk_hashes: hashes });
  assert.equal(first.take.id, takeId);
  assert.ok(hub.state.takes[takeId]);
  assert.ok(db.rows.has(key));
  assert.deepEqual(stagedNames(staging, takeId), ["meta.json"]);

  const second = await uploads.finish(takeId, { chunk_hashes: hashes });
  assert.deepEqual(second, first);
  assert.equal(storage.uploads.length, 1);
});

test("take.add refused keeps the staging and removes the unreferenced object", async () => {
  const refusal = { code: "limit", error: "A clip can have at most 64 takes." };
  const { uploads, storage, db, hub, staging } = setup({ hub: { refuse: refusal } });
  const takeId = randomUUID();
  await uploads.begin(takeId, beginRequest());
  const hashes = await stageChunks(uploads, takeId, [pcm24(signal(64, 2))]);
  const key = keyOf(takeId);

  await assert.rejects(
    () => uploads.finish(takeId, { chunk_hashes: hashes }),
    (error) => {
      assert.equal(error.status, 413);
      assert.equal(error.message, "A clip can have at most 64 takes.");
      return true;
    },
  );

  // The song does not point at the take, so the object and its row may go.
  assert.deepEqual(storage.deleted, [{ key, bucket: "crow-files" }]);
  assert.equal(db.rows.has(key), false);
  assert.equal(hub.state.takes[takeId], undefined);
  // The staged audio is the only copy of the recording: it stays, ready for
  // the next finish (and the lock is not left behind).
  assert.deepEqual(stagedNames(staging, takeId), ["000000.pcm", "000000.pcm.sha256", "meta.json"]);
});

test("finish fails closed when the song cannot be read", async () => {
  const { uploads, storage, db, hub, staging } = setup({ hub: { unreadable: true } });
  const takeId = randomUUID();
  await uploads.begin(takeId, beginRequest());
  const hashes = await stageChunks(uploads, takeId, [pcm24(signal(64, 2))]);

  await assert.rejects(
    () => uploads.finish(takeId, { chunk_hashes: hashes }),
    (error) => {
      assert.equal(error.status, 503);
      assert.equal(error.message, "Studio could not read the song; the take is kept and will finish later.");
      return true;
    },
  );

  // Nothing was uploaded, nothing was filed, nothing was deleted.
  assert.equal(storage.uploads.length, 0);
  assert.deepEqual(storage.deleted, []);
  assert.equal(db.rows.size, 0);
  assert.equal(db.statements.length, 0);
  assert.equal(hub.commands.length, 0);
  assert.deepEqual(stagedNames(staging, takeId), ["000000.pcm", "000000.pcm.sha256", "meta.json"]);
});

test("storage insert failure deletes the object", async () => {
  const { uploads, storage, hub } = setup({ db: { failInsert: true } });
  const takeId = randomUUID();
  await uploads.begin(takeId, beginRequest());
  const hashes = await stageChunks(uploads, takeId, [pcm24(signal(64, 2))]);

  await assert.rejects(() => uploads.finish(takeId, { chunk_hashes: hashes }), /insert failed/);

  assert.equal(storage.uploads.length, 1);
  assert.deepEqual(storage.deleted, [{ key: keyOf(takeId), bucket: "crow-files" }]);
  assert.equal(hub.commands.length, 0);
});

test("quota exceeded refuses before upload", async () => {
  const { uploads, storage, hub } = setup({ quotaMb: 1, storage: { usedBytes: MB } });
  const takeId = randomUUID();
  await uploads.begin(takeId, beginRequest());
  const hashes = await stageChunks(uploads, takeId, [pcm24(signal(64, 2))]);

  await assert.rejects(
    () => uploads.finish(takeId, { chunk_hashes: hashes }),
    (error) => {
      assert.equal(error.status, 507);
      assert.equal(error.message, "Storage quota exceeded (1 MB). Delete files to free space.");
      return true;
    },
  );
  assert.deepEqual(storage.statsCalls, ["crow-files"]);
  assert.equal(storage.uploads.length, 0);
  assert.equal(hub.commands.length, 0);
});

test("quota counts the incoming take", async () => {
  // The take is 1000 stereo frames of 24-bit PCM: 6000 data bytes, 6044 with
  // its header.
  const size = 44 + 1000 * 2 * 3;
  const audio = pcm24(signal(1000, 2));

  // Under the quota on its own, but not with the incoming take: still refused.
  const over = setup({ quotaMb: 1, storage: { usedBytes: MB - size + 1 } });
  const overTake = randomUUID();
  await over.uploads.begin(overTake, beginRequest());
  const overHashes = await stageChunks(over.uploads, overTake, [audio]);
  await assert.rejects(
    () => over.uploads.finish(overTake, { chunk_hashes: overHashes }),
    (error) => {
      assert.equal(error.status, 507);
      return true;
    },
  );
  assert.equal(over.storage.uploads.length, 0);

  // Exactly filling the quota is allowed: the rule is `used + size > quota`.
  const exactly = setup({ quotaMb: 1, storage: { usedBytes: MB - size } });
  const exactTake = randomUUID();
  await exactly.uploads.begin(exactTake, beginRequest());
  const exactHashes = await stageChunks(exactly.uploads, exactTake, [audio]);
  const { take } = await exactly.uploads.finish(exactTake, { chunk_hashes: exactHashes });
  assert.equal(take.id, exactTake);
  assert.equal(exactly.storage.uploads.length, 1);
});

test("33rd open upload refused", async () => {
  const { uploads } = setup();
  for (let index = 0; index < 32; index += 1) {
    await uploads.begin(randomUUID(), beginRequest());
  }
  await assert.rejects(
    () => uploads.begin(randomUUID(), beginRequest()),
    (error) => {
      assert.equal(error.status, 413);
      assert.match(error.message, /at most 32/);
      return true;
    },
  );
});

test("sweepStale removes only old staging", async () => {
  const { uploads, staging } = setup();
  const fresh = randomUUID();
  const stale = randomUUID();
  await uploads.begin(fresh, beginRequest());
  await uploads.begin(stale, beginRequest());

  const longAgo = (Date.now() - 8 * DAY) / 1000;
  utimesSync(join(staging, stale, "meta.json"), longAgo, longAgo);

  const orphan = join(staging, randomUUID());
  mkdirSync(orphan);
  utimesSync(orphan, longAgo, longAgo);

  const removed = await uploads.sweepStale();
  assert.equal(removed, 2);
  assert.equal(existsSync(join(staging, fresh)), true);
  assert.equal(existsSync(join(staging, stale)), false);
  assert.equal(existsSync(orphan), false);
  assert.deepEqual(readdirSync(staging), [fresh]);
});

test("decodeWav reads 16-bit and 24-bit and refuses float", () => {
  const audio = signal(120, 2);

  const plain24 = buildWav({ rate: 48000, bits: 24, channels: audio });
  const read24 = decodeWav(plain24);
  assert.equal(read24.rate, 48000);
  assert.equal(read24.channels.length, 2);
  assert.deepEqual(read24.channels[0], quantised(audio[0]));
  assert.deepEqual(read24.channels[1], quantised(audio[1]));

  // 16-bit mono at 44.1 kHz with a LIST chunk in front of the audio: unknown
  // chunks are skipped, not refused.
  const mono = [audio[0]];
  const plain16 = buildWav({
    rate: 44100,
    bits: 16,
    channels: mono,
    extra: extraChunk("LIST", "INFOISFT"),
  });
  const read16 = decodeWav(plain16);
  assert.equal(read16.rate, 44100);
  assert.equal(read16.channels.length, 1);
  assert.deepEqual(read16.channels[0], quantised(audio[0], Math.pow(2, 15) - 1));

  // WAVE_FORMAT_EXTENSIBLE wrapping the same PCM sub-format reads the same.
  const extensible = buildWav({ rate: 48000, bits: 24, channels: audio, extensible: true });
  const readExtensible = decodeWav(extensible);
  assert.equal(readExtensible.rate, 48000);
  assert.deepEqual(readExtensible.channels[0], quantised(audio[0]));

  // IEEE float (format 3) is refused by code.
  const float32 = buildWav({ rate: 48000, bits: 32, channels: audio, format: 3 });
  assert.throws(
    () => decodeWav(float32),
    (error) => {
      assert.match(error.message, /format code 3/);
      assert.match(error.message, /IEEE float/);
      return true;
    },
  );
});

test("decodeWav refuses rate 0 and 9 channels", () => {
  const audio = signal(10, 1);

  const noRate = buildWav({ rate: 0, bits: 24, channels: audio });
  assert.throws(
    () => decodeWav(noRate),
    (error) => {
      assert.match(error.message, /sample rate is 0/);
      return true;
    },
  );

  const nineChannels = Array.from({ length: 9 }, () => audio[0]);
  const tooMany = buildWav({ rate: 48000, bits: 24, channels: nineChannels });
  assert.throws(
    () => decodeWav(tooMany),
    (error) => {
      assert.match(error.message, /9 channels/);
      return true;
    },
  );
});