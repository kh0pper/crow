/**
 * Take uploads: staging on disk, chunk idempotency, the streamed 24-bit WAV,
 * quota and the internal `take.add`.
 *
 * Everything here runs against a scratch staging directory, a fake storage
 * client, a fake database, a fake project ACL and a fake hub, so nothing
 * touches a real bucket, a real `crow.db` or a real `~/.crow`. The WAV check
 * uses the real `decodeWav`, so the bytes that would have gone to storage are
 * read back and compared sample by sample.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, utimesSync } from "node:fs";
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
 * @param {{bucket?: string, usedBytes?: number}} [options]
 */
function fakeStorage({ bucket = "crow-files", usedBytes = 0 } = {}) {
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
 * A database client that answers the prefix lookup and records every
 * statement. `failInsert` makes the `storage_files` insert throw, the way a
 * database out of space would.
 * @param {{prefix?: string, failInsert?: boolean}} [options]
 */
function fakeDb({ prefix = PREFIX, failInsert = false } = {}) {
  const statements = [];
  return {
    statements,
    async execute(statement) {
      const sql = typeof statement === "string" ? statement : statement.sql;
      statements.push(statement);
      if (/INSERT\s+INTO\s+storage_files/i.test(sql)) {
        if (failInsert) throw new Error("insert failed: no space left on device");
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
 * A session hub: `openSong` answers with the song's takes and tempo, and
 * `runCommand` remembers what it was asked and (unless told to refuse) puts the
 * take into the snapshot.
 * @param {{takes?: object, bpm?: number, refuse?: {code: string, error: string}}} [options]
 */
function fakeHub({ takes = {}, bpm = 124, refuse = null } = {}) {
  const commands = [];
  const state = { takes: { ...takes } };
  return {
    commands,
    state,
    async openSong() {
      return {
        doc: null,
        snapshot: { meta: { title: "Test song", bpm }, takes: state.takes, clips: {} },
        snapshot_version: 1,
      };
    },
    async runCommand(request) {
      commands.push(request);
      if (refuse) return { ok: false, code: refuse.code, error: refuse.error };
      const take = { ...request.args.take, clip_id: request.args.clip_id, discarded: false };
      state.takes[take.id] = take;
      return { ok: true, entry: { command: request.command }, snapshot_version: 2 };
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
  const uploads = createTakeUploads({
    stagingDir: staging,
    storage,
    db,
    acl,
    hub,
    now: overrides.now ?? (() => Date.now()),
    quotaMb: overrides.quotaMb ?? 5120,
    maxSamples: overrides.maxSamples ?? 115200000,
  });
  return { staging, storage, db, acl, hub, uploads };
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

test("begin after chunks is accepted", async () => {
  const { uploads } = setup();
  const takeId = randomUUID();
  const audio = signal(100, 2);
  const chunks = [pcm24(audio, 0, 60), pcm24(audio, 60, 100)];

  // Chunks first: the client was offline when it began recording, so nothing
  // but the id is known yet.
  for (let index = 0; index < chunks.length; index += 1) {
    await uploads.putChunk(takeId, index, chunks[index]);
  }
  const before = await uploads.status(takeId);
  assert.equal(before.begun, false);
  assert.equal(before.frames, null);
  assert.equal(before.received.length, 2);

  const begun = await uploads.begin(takeId, beginRequest());
  assert.deepEqual(begun, { chunk_bytes: 1048576 });

  const after = await uploads.status(takeId);
  assert.equal(after.begun, true);
  assert.equal(after.frames, 100);
  assert.deepEqual(
    after.received.map((chunk) => chunk.index),
    [0, 1],
  );
  assert.equal(after.received[0].sha256, hashOf(chunks[0]));
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
  const key = `${PREFIX}studio/${SONG}/takes/${takeId}.wav`;

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
  const insert = db.statements.find((statement) => statement && statement.sql && /INSERT\s+INTO\s+storage_files/i.test(statement.sql));
  assert.ok(insert, "a storage_files row was written");
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
  const day = join(staging, takeId);
  assert.deepEqual(readdirSync(day), ["meta.json"]);
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

test("storage insert failure deletes the object", async () => {
  const { uploads, storage, hub } = setup({ db: { failInsert: true } });
  const takeId = randomUUID();
  await uploads.begin(takeId, beginRequest());
  const hashes = await stageChunks(uploads, takeId, [pcm24(signal(64, 2))]);

  await assert.rejects(() => uploads.finish(takeId, { chunk_hashes: hashes }), /insert failed/);

  const key = `${PREFIX}studio/${SONG}/takes/${takeId}.wav`;
  assert.equal(storage.uploads.length, 1);
  assert.deepEqual(storage.deleted, [{ key, bucket: "crow-files" }]);
  assert.equal(hub.commands.length, 0);
});

test("quota exceeded refuses before upload", async () => {
  const { uploads, storage, hub } = setup({ quotaMb: 1, storage: { usedBytes: 1024 * 1024 } });
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