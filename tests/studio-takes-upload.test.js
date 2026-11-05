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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
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
 * A session hub: `openSong` answers with the song's takes, samples, pads and
 * library, `runCommand` remembers what it was asked, answers a repeated
 * `cmd_id` with the result it gave the first time, and refuses an id the song
 * already has.
 *
 * `take.add`, `sample.add`, `library.add` and the pad assignments behave the way
 * the real ones do where these tests depend on it: an object is added once, a
 * pad points at the sample an assignment names, `pad.assign_if_empty`
 * (Studio's own) refuses a pad that already holds another sound, and
 * `library.add` refuses past a song's own caps (256 entries, 32 fonts) with the
 * sentences the real command uses.
 *
 * `runCommand` is the hub's per-song queue: one command at a time, in arrival
 * order, so a command's own check sees every write that reached the song before
 * it — which is what makes the empty-only assignment a real guard and not a
 * check against a stale read. `openSong` hands back a DEEP COPY of the song, as
 * a snapshot read is: a test that wants to prove something was re-read cannot
 * be fooled by a snapshot that changes under it.
 *
 * `unreadable` makes `openSong` throw, the way a database or a locked song can.
 * @param {{takes?: object, samples?: object, pads?: object, library?: object,
 *          bpm?: number, refuse?: {code: string, error: string},
 *          unreadable?: boolean}} [options]
 */
function fakeHub({ takes = {}, samples = {}, pads = {}, library = {}, bpm = 124, refuse = null, unreadable = false } = {}) {
  const commands = [];
  const state = { takes: { ...takes }, samples: { ...samples }, pads: { ...pads }, library: { ...library } };
  const answers = new Map();
  let queue = Promise.resolve();

  /** @returns {object} the result of one command, as the hub would report it */
  function apply(request) {
    if (refuse) return { ok: false, code: refuse.code, error: refuse.error };
    if (request.command === "library.add") {
      const entry = request.args?.entry;
      if (!entry || typeof entry.id !== "string" || entry.id === "") {
        return { ok: false, code: "invalid", error: "that entry has no id" };
      }
      if (state.library[entry.id]) {
        return {
          ok: false,
          code: "invalid",
          error: `The library already holds an entry with id "${entry.id}".`,
        };
      }
      const entries = Object.values(state.library);
      if (entries.length >= 256) {
        return { ok: false, code: "limit", error: `A song's library can hold at most 256 entries.` };
      }
      if (entry.kind === "font" && entries.filter((held) => held.kind === "font").length >= 32) {
        return { ok: false, code: "limit", error: "A song can hold at most 32 fonts." };
      }
      state.library[entry.id] = { ...entry };
      return { ok: true, entry: { command: request.command }, snapshot_version: 2 };
    }
    if (request.command === "sample.add") {
      const sample = request.args.sample;
      if (state.samples[sample.id]) {
        return {
          ok: false,
          code: "invalid",
          error: `A sample with id "${sample.id}" already exists in this song.`,
        };
      }
      state.samples[sample.id] = { ...sample };
      return { ok: true, entry: { command: request.command }, snapshot_version: 2 };
    }
    if (request.command === "pad.assign" || request.command === "pad.assign_if_empty") {
      const args = request.args;
      const key = `${args.track_id}/${args.bank_id}/${args.index}`;
      if (request.command === "pad.assign_if_empty" && request.internal !== true) {
        return {
          ok: false,
          code: "studio_only",
          error: "This command can only be run by Studio itself.",
        };
      }
      const pad = state.pads[key];
      if (!pad) return { ok: false, code: "not_found", error: "there is no such pad" };
      if (!state.samples[args.sample_id]) {
        return { ok: false, code: "not_found", error: "there is no such sample" };
      }
      if (request.command === "pad.assign_if_empty") {
        const held = pad.sample_id;
        if (typeof held === "string" && held !== "" && held !== args.sample_id) {
          return { ok: false, code: "conflict", error: "That pad already holds a sound." };
        }
      }
      pad.sample_id = args.sample_id;
      return { ok: true, entry: { command: request.command }, snapshot_version: 3 };
    }
    if (state.takes[request.args.take.id]) {
      return {
        ok: false,
        code: "invalid",
        error: `A take with id "${request.args.take.id}" already exists in this song.`,
      };
    }
    state.takes[request.args.take.id] = {
      ...request.args.take,
      clip_id: request.args.clip_id,
      discarded: false,
    };
    return { ok: true, entry: { command: request.command }, snapshot_version: 2 };
  }

  return {
    commands,
    state,
    async openSong() {
      if (unreadable) throw new Error("the song's document could not be loaded");
      return {
        doc: null,
        // A snapshot is a read of the song at one moment, never a live view.
        snapshot: structuredClone({
          meta: { title: "Test song", bpm },
          takes: state.takes,
          samples: state.samples,
          pads: state.pads,
          library: state.library,
          clips: {},
        }),
        snapshot_version: 1,
      };
    },
    /**
     * The hub's per-song queue, with its `cmd_id` de-duplication: a repeated
     * id is answered with the result it gave the first time.
     * @param {object} request
     * @returns {Promise<object>}
     */
    runCommand(request) {
      commands.push(request);
      const run = queue.then(() => {
        const seen = answers.get(request.cmd_id);
        if (seen) return seen;
        const result = apply(request);
        answers.set(request.cmd_id, result);
        return result;
      });
      queue = run.then(
        () => {},
        () => {},
      );
      return run;
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

/** The sampler track, bank and pad a sample upload lands on in these tests. */
const TRACK = "track-1";
const BANK = "a";
const PAD_INDEX = 3;

/** @returns {string} the key the song's pads are held under. */
function padKeyOf(index = PAD_INDEX) {
  return `${TRACK}/${BANK}/${index}`;
}

/** @returns {object} an empty pad, the way a snapshot holds one. */
function emptyPad() {
  return { track_id: TRACK, bank_id: BANK, index: PAD_INDEX, sample_id: null, slice_id: null, name: "Pad 4" };
}

/** @returns {object} the details a sample upload sends with `begin`. */
function sampleRequest(overrides = {}) {
  return {
    kind: "sample",
    song_id: SONG,
    project_id: PROJECT,
    rate: 48000,
    channels: 2,
    author: AUTHOR,
    name: "Kick",
    origin: "import",
    ...overrides,
  };
}

/** @returns {string} the storage key a sample is filed under. */
function sampleKeyOf(sampleId) {
  return `${PREFIX}studio/${SONG}/samples/${sampleId}.wav`;
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
      assert.equal(error.message, "Begin the upload before sending its audio.");
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

// --- samples ----------------------------------------------------------------

test("a sample upload finishes as sample.add under the samples prefix", async () => {
  const { uploads, storage, db, acl, hub, staging } = setup();
  const sampleId = randomUUID();
  const audio = signal(300, 2);
  await uploads.begin(sampleId, sampleRequest({ name: "Kick", origin: "import" }));
  const hashes = await stageChunks(uploads, sampleId, [pcm24(audio)]);

  const finished = await uploads.finish(sampleId, { chunk_hashes: hashes });
  const key = sampleKeyOf(sampleId);

  // One `sample.add`, internal, from the person at the page, under the id the
  // client chose — never a caller's storage key.
  assert.equal(hub.commands.length, 1);
  const command = hub.commands[0];
  assert.equal(command.command, "sample.add");
  assert.equal(command.internal, true);
  assert.equal(command.cmd_id, sampleId);
  assert.equal(command.song_id, SONG);
  assert.deepEqual(command.author, AUTHOR);
  assert.deepEqual(command.args, {
    sample: {
      id: sampleId,
      storage_key: key,
      rate: 48000,
      channels: 2,
      frames: 300,
      name: "Kick",
      origin: "import",
      author_label: "You",
    },
  });

  // The audio went to the samples directory, filed as a sample.
  assert.equal(storage.uploads.length, 1);
  assert.equal(storage.uploads[0].key, key);
  const decoded = decodeWav(storage.uploads[0].bytes);
  assert.equal(decoded.rate, 48000);
  assert.equal(decoded.channels.length, 2);
  assert.deepEqual(decoded.channels[0], quantised(audio[0]));

  const insert = db.statements.find(
    (statement) => statement && statement.sql && /INSERT\s+INTO\s+storage_files/i.test(statement.sql),
  );
  assert.ok(insert, "a storage_files row was written");
  assert.equal(insert.args[0], key);
  assert.equal(insert.args[5], "studio_sample");
  assert.equal(insert.args[6], SONG);
  assert.equal(insert.args[7], PROJECT);

  assert.equal(acl.audits.length, 1);
  assert.equal(acl.audits[0].action, "studio.sample");
  assert.equal(acl.audits[0].actor_type, "local");
  assert.equal(acl.audits[0].payload.sample_id, sampleId);
  assert.equal(acl.audits[0].payload.storage_key, key);
  assert.equal(acl.audits[0].payload.seconds, 0.006);

  assert.equal(finished.sample.id, sampleId);
  assert.equal(finished.sample.storage_key, key);
  assert.equal(finished.sample.frames, 300);
  assert.equal(finished.pad_assigned, false, "an upload with no target pad assigns nothing");
  assert.ok(hub.state.samples[sampleId], "the sample is in the song");
  assert.deepEqual(stagedNames(staging, sampleId), ["meta.json"]);
});

test("a sample over 60 s is refused naming the limit", async () => {
  const { uploads, staging } = setup();
  const sampleId = randomUUID();
  await uploads.begin(sampleId, sampleRequest());

  // A sparse staged file as heavy as the whole cap — 5,760,000 samples of
  // 24-bit PCM — so the next chunk would take the sample past it without this
  // test writing seventeen megabytes.
  const full = join(staging, sampleId, "000000.pcm");
  writeFileSync(full, Buffer.alloc(0));
  truncateSync(full, 5760000 * 3);

  await assert.rejects(
    () => uploads.putChunk(sampleId, 1, pcm24(signal(4, 2))),
    (error) => {
      assert.equal(error.status, 413);
      assert.match(error.message, /60 s/);
      assert.match(error.message, /5,760,000/);
      return true;
    },
  );
  assert.equal(existsSync(join(staging, sampleId, "000001.pcm")), false);
});

test("a sample finishes and lands on its pad even after the page closed", async () => {
  const { uploads, hub } = setup({ hub: { pads: { [padKeyOf()]: emptyPad() } } });
  const sampleId = randomUUID();
  const target = { track_id: TRACK, bank_id: BANK, index: PAD_INDEX };
  await uploads.begin(sampleId, sampleRequest({ target }));
  const hashes = await stageChunks(uploads, sampleId, [pcm24(signal(64, 2))]);

  // The finish runs from the staged chunks alone: the browser that sent them is
  // gone, and the sample still reaches its pad.
  const first = await uploads.finish(sampleId, { chunk_hashes: hashes });
  assert.deepEqual(
    hub.commands.map((command) => command.command),
    ["sample.add", "pad.assign_if_empty"],
  );
  const assign = hub.commands[1];
  assert.equal(assign.cmd_id, `${sampleId}:assign`);
  assert.equal(assign.internal, true, "the empty-only assignment is Studio's own step");
  assert.deepEqual(assign.args, {
    track_id: TRACK,
    bank_id: BANK,
    index: PAD_INDEX,
    sample_id: sampleId,
  });
  assert.deepEqual(assign.author, AUTHOR, "the assignment is the begin author's");
  assert.equal(first.pad_assigned, true);
  assert.equal(hub.state.pads[padKeyOf()].sample_id, sampleId);

  // A retried finish returns the same sample and assigns nothing again.
  const second = await uploads.finish(sampleId, { chunk_hashes: hashes });
  assert.equal(hub.commands.length, 2, "no second pad.assign");
  assert.deepEqual(second, first);
});

test("a sample's pad assignment is skipped when the pad changed meanwhile", async () => {
  const otherId = randomUUID();
  const { uploads, hub } = setup({ hub: { pads: { [padKeyOf()]: { ...emptyPad(), sample_id: otherId } } } });
  const sampleId = randomUUID();
  await uploads.begin(sampleId, sampleRequest({ target: { track_id: TRACK, bank_id: BANK, index: PAD_INDEX } }));
  const hashes = await stageChunks(uploads, sampleId, [pcm24(signal(64, 2))]);

  const finished = await uploads.finish(sampleId, { chunk_hashes: hashes });

  // The pad was given another sound while the upload ran. The assignment is
  // still asked for — the question is settled inside the hub's queue — and it
  // is refused there, so the sample stays in the song and the pad is left
  // exactly as it is.
  assert.deepEqual(
    hub.commands.map((command) => command.command),
    ["sample.add", "pad.assign_if_empty"],
  );
  assert.equal(finished.pad_assigned, false);
  assert.ok(hub.state.samples[sampleId], "the sample is in the song");
  assert.equal(hub.state.pads[padKeyOf()].sample_id, otherId, "the pad keeps the sound it was given");
  assert.equal(finished.sample.id, sampleId);
});

test("a pad filled by the operator just before the upload finishes keeps the operator's sound", async () => {
  // The pad is free when the upload begins and the sample is in the song when
  // the finish runs: the only thing between them is the operator's own choice.
  const operatorPick = randomUUID();
  const { uploads, hub } = setup({
    hub: {
      pads: { [padKeyOf()]: emptyPad() },
      samples: { [operatorPick]: { id: operatorPick, name: "Operator hit" } },
    },
  });
  const sampleId = randomUUID();
  await uploads.begin(sampleId, sampleRequest({ target: { track_id: TRACK, bank_id: BANK, index: PAD_INDEX } }));
  const hashes = await stageChunks(uploads, sampleId, [pcm24(signal(64, 2))]);

  // The operator's pad edit reaches the song after the finish read it and
  // before the upload's own assignment runs. A check against that read would
  // hand the upload the pad; the check has to run where the write does.
  const runCommand = hub.runCommand.bind(hub);
  let raced = false;
  hub.runCommand = (request) => {
    if (!raced && request.command === "pad.assign_if_empty") {
      raced = true;
      hub.state.pads[padKeyOf()].sample_id = operatorPick;
    }
    return runCommand(request);
  };

  const finished = await uploads.finish(sampleId, { chunk_hashes: hashes });

  assert.equal(raced, true, "the upload did ask for its pad");
  assert.equal(finished.pad_assigned, false, "the assignment was skipped, not applied");
  assert.equal(hub.state.pads[padKeyOf()].sample_id, operatorPick, "the operator's sound stayed");
  assert.ok(hub.state.samples[sampleId], "the sample is still in the song");
  assert.deepEqual(
    hub.commands.map((command) => command.command),
    ["sample.add", "pad.assign_if_empty"],
  );
});

test("a retried finish does not refill a pad the operator cleared", async () => {
  const { uploads, hub } = setup({ hub: { pads: { [padKeyOf()]: emptyPad() } } });
  const sampleId = randomUUID();
  await uploads.begin(sampleId, sampleRequest({ target: { track_id: TRACK, bank_id: BANK, index: PAD_INDEX } }));
  const hashes = await stageChunks(uploads, sampleId, [pcm24(signal(64, 2))]);

  const first = await uploads.finish(sampleId, { chunk_hashes: hashes });
  assert.equal(first.pad_assigned, true);

  // The operator takes the sound off the pad, then the client retries the
  // finish (a reload, a lost answer). The first finish recorded what it did, so
  // the retry answers with that record and never touches the pad again.
  hub.state.pads[padKeyOf()].sample_id = null;
  const second = await uploads.finish(sampleId, { chunk_hashes: hashes });

  assert.equal(second.pad_assigned, true, "the retry reports what the first finish came to");
  assert.deepEqual(second.sample, first.sample);
  assert.equal(hub.state.pads[padKeyOf()].sample_id, null, "the pad the operator cleared stays cleared");
  assert.equal(
    hub.commands.filter((command) => command.command === "pad.assign_if_empty").length,
    1,
    "no second assignment was asked for",
  );
});

test("a sample id that belongs to a take is refused", async () => {
  const { uploads, staging } = setup();
  const id = randomUUID();

  // A finished take owns its id: the staging directory, the storage key and the
  // reference type are all the take's, so the same id cannot become a sample.
  await uploads.begin(id, beginRequest());
  const hashes = await stageChunks(uploads, id, [pcm24(signal(64, 2))]);
  await uploads.finish(id, { chunk_hashes: hashes });

  await assert.rejects(
    () => uploads.begin(id, sampleRequest()),
    (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.message, "That id belongs to a take upload.");
      return true;
    },
  );
  // Nothing of the take was disturbed by the attempt.
  assert.deepEqual(stagedNames(staging, id), ["meta.json"]);
  assert.equal(JSON.parse(readFileSync(join(staging, id, "meta.json"), "utf8")).kind, "take");
});

test("two finishes racing on one sample assign once", async () => {
  // Two finishes of ONE upload: the second joins the first and answers with its
  // result, so the pad is assigned once.
  const { uploads, hub } = setup({ hub: { pads: { [padKeyOf()]: emptyPad() } } });
  const sampleId = randomUUID();
  await uploads.begin(sampleId, sampleRequest({ target: { track_id: TRACK, bank_id: BANK, index: PAD_INDEX } }));
  const hashes = await stageChunks(uploads, sampleId, [pcm24(signal(64, 2))]);

  const [first, second] = await Promise.all([
    uploads.finish(sampleId, { chunk_hashes: hashes }),
    uploads.finish(sampleId, { chunk_hashes: hashes }),
  ]);
  assert.equal(first.pad_assigned, true);
  assert.deepEqual(second, first);
  assert.equal(
    hub.commands.filter((command) => command.command === "pad.assign_if_empty").length,
    1,
    "one assignment for one sample",
  );

  // Two DIFFERENT uploads finishing at once on one free pad: the empty-only
  // check runs inside the hub's queue, so exactly one of them lands and the pad
  // holds that one sound.
  const raceIndex = 2;
  const racePad = { ...emptyPad(), index: raceIndex };
  hub.state.pads[padKeyOf(raceIndex)] = racePad;
  const raceTarget = { track_id: TRACK, bank_id: BANK, index: raceIndex };
  const rivals = [randomUUID(), randomUUID()];
  const rivalHashes = [];
  for (const [at, rival] of rivals.entries()) {
    await uploads.begin(rival, sampleRequest({ name: `Rival ${at + 1}`, target: raceTarget }));
    rivalHashes.push(await stageChunks(uploads, rival, [pcm24(signal(64, 2))]));
  }
  const racing = await Promise.all(
    rivals.map((rival, at) => uploads.finish(rival, { chunk_hashes: rivalHashes[at] })),
  );

  const winners = racing.filter((result) => result.pad_assigned === true);
  assert.equal(winners.length, 1, "exactly one of the two racing finishes took the pad");
  assert.equal(hub.state.pads[padKeyOf(raceIndex)].sample_id, winners[0].sample.id);
  for (const result of racing) assert.ok(hub.state.samples[result.sample.id], "both samples are in the song");
});

test("a hostile kind is refused", async () => {
  const { uploads, staging } = setup();

  // A kind is one of the three Studio has, and nothing else: a different case, a
  // padded or empty-looking string, or a name inherited from Object.prototype
  // (which a lookup table would answer for) is refused by name before a byte of
  // meta is written.
  for (const kind of ["Sample", "take ", " take", "__proto__", "constructor", "toString"]) {
    const id = randomUUID();
    await assert.rejects(
      () => uploads.begin(id, sampleRequest({ kind })),
      (error) => {
        assert.equal(error.status, 400);
        assert.match(error.message, /take or sample/);
        assert.ok(error.message.includes(`"${kind}"`), `the refusal names "${kind}"`);
        return true;
      },
    );
    assert.deepEqual(readdirSync(staging), [], `"${kind}" staged nothing`);
  }
});

test("importing 40 hits at once does not hit the take cap", async () => {
  const { uploads } = setup();

  // 40 samples uploading at once is an ordinary import session, and samples are
  // counted apart from takes.
  for (let index = 0; index < 40; index += 1) {
    const begun = await uploads.begin(randomUUID(), sampleRequest({ name: `Hit ${index + 1}` }));
    assert.equal(begun.chunk_bytes, 1048576);
  }
  // The takes' own cap is untouched by them.
  const take = await uploads.begin(randomUUID(), beginRequest());
  assert.equal(take.chunk_bytes, 1048576);
});

// --- banks ------------------------------------------------------------------

/**
 * A small fake bank: the SoundFont magic (`RIFF`, four bytes, `sfbk`) and a
 * deterministic tail, so the file is recognisable and its hash is the test's
 * own.
 * @param {number} [length]
 * @returns {Buffer}
 */
function bankBytes(length = 3000) {
  const bytes = Buffer.alloc(length);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(Math.max(0, length - 8), 4);
  bytes.write("sfbk", 8, "ascii");
  for (let at = 12; at < length; at += 1) bytes[at] = (at * 37) % 251;
  return bytes;
}

/** @returns {string} the base64 of a file's first twelve bytes, as `begin` takes it. */
function bankHead(bytes) {
  return Buffer.from(bytes).subarray(0, 12).toString("base64");
}

/** @returns {object} the details a bank upload sends with `begin`. */
function bankRequest(overrides = {}) {
  const file = bankBytes(4096);
  return {
    kind: "font",
    song_id: SONG,
    project_id: PROJECT,
    author: AUTHOR,
    name: "My Bank",
    file_name: "My Bank.sf2",
    bytes: file.length,
    head: bankHead(file),
    ...overrides,
  };
}

/** @returns {string} the storage key a bank is filed under. */
function bankKeyOf(id, ext = "sf2") {
  return `${PREFIX}studio/${SONG}/library/lib-${id}.${ext}`;
}

test("a bank upload is refused before it starts when it is not SF2/SF3", async () => {
  const { uploads, staging } = setup();

  // A file whose first twelve bytes are not `RIFF`…`sfbk`.
  const notBank = bankBytes(4096);
  notBank.write("RIFX", 0, "ascii");
  await assert.rejects(
    () => uploads.begin(randomUUID(), bankRequest({ head: bankHead(notBank) })),
    (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.message, "That file is not an SF2 or SF3 bank.");
      return true;
    },
  );
  assert.deepEqual(readdirSync(staging), [], "a file that is not a bank staged nothing");

  // A file whose own name is neither `.sf2` nor `.sf3`.
  await assert.rejects(
    () => uploads.begin(randomUUID(), bankRequest({ file_name: "My Bank.sfz" })),
    (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.message, "Studio takes SF2 and SF3 banks.");
      return true;
    },
  );
  assert.deepEqual(readdirSync(staging), [], "a file Studio cannot play staged nothing");

  // A declared size past 512 MB, refused by name.
  await assert.rejects(
    () => uploads.begin(randomUUID(), bankRequest({ bytes: 536870913 })),
    (error) => {
      assert.equal(error.status, 413);
      assert.equal(error.message, "That bank is 513 MB; Studio takes banks up to 512 MB.");
      return true;
    },
  );
  assert.deepEqual(readdirSync(staging), [], "a bank past the limit staged nothing");
});

test("the server refuses a non-bank at finish", async () => {
  const { uploads, storage, hub, staging } = setup();
  const id = randomUUID();
  const file = bankBytes(2048);

  // The client declares a bank's first bytes — and then sends something else of
  // the same size, with no SoundFont magic anywhere in front.
  await uploads.begin(id, bankRequest({ bytes: file.length, head: bankHead(file) }));
  const hashes = await stageChunks(uploads, id, [Buffer.alloc(file.length, 7)]);

  await assert.rejects(
    () => uploads.finish(id, { chunk_hashes: hashes }),
    (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.message, "That file is not an SF2 or SF3 bank.");
      return true;
    },
  );
  assert.equal(storage.uploads.length, 0, "nothing reached storage");
  assert.equal(hub.commands.length, 0, "no library entry was added");
  assert.deepEqual(storage.deleted, [], "and nothing had to be deleted");
  // The staged bytes are still the only copy: a corrected upload can finish.
  assert.deepEqual(stagedNames(staging, id), ["000000.pcm", "000000.pcm.sha256", "meta.json"]);
});

test("a bank chunk past the declared size is refused", async () => {
  const { uploads, staging } = setup();
  const id = randomUUID();
  const file = bankBytes(64);
  await uploads.begin(id, bankRequest({ bytes: file.length, head: bankHead(file) }));

  // The first chunk fills the bank exactly; the next byte of it does not exist.
  await uploads.putChunk(id, 0, file);
  await assert.rejects(
    () => uploads.putChunk(id, 1, Buffer.alloc(16, 1)),
    (error) => {
      assert.equal(error.status, 413);
      assert.match(error.message, /declared 64 bytes/);
      return true;
    },
  );
  assert.equal(existsSync(join(staging, id, "000001.pcm")), false);
});

test("a bank whose chunks fall short of its declared size is refused at finish", async () => {
  const { uploads, storage, hub } = setup();
  const id = randomUUID();
  const file = bankBytes(3000);
  await uploads.begin(id, bankRequest({ bytes: file.length, head: bankHead(file) }));
  const hashes = await stageChunks(uploads, id, [file.subarray(0, 2000)]);
  await assert.rejects(() => uploads.finish(id, { chunk_hashes: hashes }), (error) => {
    assert.equal(error.status, 409);
    return true;
  });
  assert.equal(storage.uploads.length, 0, "nothing reached storage");
  assert.equal(hub.commands.length, 0, "no library entry was added");
});

test("a bank upload is refused for a caller who may not write in the project", async () => {
  const { uploads, staging } = setup({ acl: { deny: true } });
  const file = bankBytes(64);
  await assert.rejects(() => uploads.begin(randomUUID(), bankRequest({ bytes: file.length, head: bankHead(file) })), (error) => {
    assert.equal(error.status, 403);
    return true;
  });
  assert.deepEqual(readdirSync(staging), []);
});

test("the same bank upload begun again after a remove is a new step", async () => {
  const { uploads, hub } = setup();
  const id = randomUUID();
  const file = bankBytes(64);
  await uploads.begin(id, bankRequest({ bytes: file.length, head: bankHead(file) }));
  let hashes = await stageChunks(uploads, id, [file]);
  await uploads.finish(id, { chunk_hashes: hashes });
  const first = hub.commands[0].cmd_id;

  // The operator removes the bank; the page sends the same file under the same id.
  delete hub.state.library[`lib-${id}`];
  await uploads.begin(id, bankRequest({ bytes: file.length, head: bankHead(file) }));
  hashes = await stageChunks(uploads, id, [file]);
  await uploads.finish(id, { chunk_hashes: hashes });
  assert.equal(hub.commands.length, 2);
  assert.notEqual(hub.commands[1].cmd_id, first, "not a replay of the undone add");
  assert.ok(hub.state.library[`lib-${id}`], "the bank is back in the song");
});

test("a finished bank upload adds one library entry", async () => {
  const { uploads, storage, db, acl, hub, staging } = setup();
  const id = randomUUID();
  const file = bankBytes(3000);
  const libraryId = `lib-${id}`;
  const key = bankKeyOf(id);

  await uploads.begin(id, bankRequest({ name: "My Bank", bytes: file.length, head: bankHead(file) }));
  const hashes = await stageChunks(uploads, id, [file.subarray(0, 2000), file.subarray(2000)]);

  const finished = await uploads.finish(id, { chunk_hashes: hashes });

  // One `library.add`, internal, from the person at the page, under the entry's
  // own id and the key the finish wrote — never a caller's storage key.
  assert.equal(hub.commands.length, 1);
  const command = hub.commands[0];
  assert.equal(command.command, "library.add");
  assert.equal(command.internal, true);
  assert.match(command.cmd_id, new RegExp(`^${id}:library:[0-9a-f-]{36}$`));
  assert.equal(command.song_id, SONG);
  assert.deepEqual(command.author, AUTHOR);
  assert.deepEqual(command.args.entry, {
    id: libraryId,
    kind: "font",
    name: "My Bank",
    source: "upload",
    upload_id: id,
    storage_key: key,
    sha256: hashOf(file),
    bytes: file.length,
    licence: "",
    credit: "",
    author_label: "You",
  });

  // The bank itself, whole and with nothing added: not a WAV, no header.
  assert.equal(storage.uploads.length, 1);
  const upload = storage.uploads[0];
  assert.equal(upload.key, key);
  assert.match(key, /\/library\/lib-[0-9a-f-]{36}\.sf2$/);
  assert.equal(upload.size, file.length);
  assert.deepEqual(upload.bytes, file);
  assert.deepEqual(upload.options, { bucket: "crow-files", contentType: "application/octet-stream" });

  const insert = db.statements.find(
    (statement) => statement && statement.sql && /INSERT\s+INTO\s+storage_files/i.test(statement.sql),
  );
  assert.ok(insert, "a storage_files row was written");
  assert.equal(insert.args[0], key);
  assert.equal(insert.args[1], `${libraryId}.sf2`);
  assert.equal(insert.args[2], "application/octet-stream");
  assert.equal(insert.args[3], file.length);
  assert.equal(insert.args[5], "studio_library");
  assert.equal(insert.args[6], SONG);
  assert.equal(insert.args[7], PROJECT);

  assert.equal(acl.audits.length, 1);
  assert.equal(acl.audits[0].action, "studio.library");
  assert.equal(acl.audits[0].actor_type, "local");
  assert.equal(acl.audits[0].payload.library_id, libraryId);
  assert.equal(acl.audits[0].payload.storage_key, key);
  assert.equal(acl.audits[0].payload.bytes, file.length);

  assert.equal(finished.library.id, libraryId);
  assert.equal(finished.library.sha256, hashOf(file));
  assert.equal(finished.library.bytes, file.length);
  assert.ok(hub.state.library[libraryId], "the entry is in the song");
  assert.deepEqual(stagedNames(staging, id), ["meta.json"]);

  // A retried finish answers with the recorded entry and adds nothing again.
  const second = await uploads.finish(id, { chunk_hashes: hashes });
  assert.deepEqual(second, finished);
  assert.equal(hub.commands.length, 1, "no second library.add");
  assert.equal(storage.uploads.length, 1, "no second upload");
  assert.equal(acl.audits.length, 1, "no second audit line");
});

test("a bank past the song's font limit is refused at finish and leaves nothing stored", async () => {
  // A song already holding its 32 fonts: the 33rd is `library.add`'s to refuse,
  // and the upload must leave nothing behind when it does.
  const fonts = {};
  for (let index = 0; index < 32; index += 1) {
    fonts[`lib-font-${index}`] = { id: `lib-font-${index}`, kind: "font", name: `Font ${index + 1}` };
  }
  const { uploads, storage, db, acl, hub } = setup({ hub: { library: fonts } });
  const id = randomUUID();
  const file = bankBytes(1024);
  const key = bankKeyOf(id);

  await uploads.begin(id, bankRequest({ bytes: file.length, head: bankHead(file) }));
  const hashes = await stageChunks(uploads, id, [file]);

  await assert.rejects(
    () => uploads.finish(id, { chunk_hashes: hashes }),
    (error) => {
      assert.equal(error.status, 413);
      assert.equal(error.message, "A song can hold at most 32 fonts.");
      return true;
    },
  );

  // The stored object and its row go, and the song never gained the entry.
  assert.deepEqual(storage.deleted, [{ key, bucket: "crow-files" }]);
  assert.equal(db.rows.has(key), false);
  assert.equal(hub.state.library[`lib-${id}`], undefined);
  assert.equal(Object.keys(hub.state.library).length, 32);
  assert.equal(acl.audits.length, 0);
});

test("a bank id that belongs to a sample upload is refused", async () => {
  const { uploads, staging } = setup();
  const id = randomUUID();

  // A finished sample owns its id: the staging, the key and the reference type
  // are all the sample's, so the same id cannot become a bank.
  await uploads.begin(id, sampleRequest());
  const hashes = await stageChunks(uploads, id, [pcm24(signal(32, 2))]);
  await uploads.finish(id, { chunk_hashes: hashes });

  const file = bankBytes(64);
  await assert.rejects(
    () => uploads.begin(id, bankRequest({ bytes: file.length, head: bankHead(file) })),
    (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.message, "That id belongs to a sample upload.");
      return true;
    },
  );
  assert.equal(JSON.parse(readFileSync(join(staging, id, "meta.json"), "utf8")).kind, "sample");
});