/**
 * The take routes: begin, chunks, status, finish, and the audio route that
 * plays a finished take back.
 *
 * What is real here: `express` and its raw-body parser, `createStudioWeb`'s
 * router, and `createTakeUploads` over a scratch staging directory — so the
 * hashing, the staged bytes, the streamed WAV and the internal `take.add` are
 * the gateway's own code. What is a fake: object storage (an in-memory object
 * map that also stands in for the bucket statistics quota is read from), the
 * database (the `storage_files` rows and the project's `storage_prefix`), the
 * project ACL, the session hub (a song is a project id and a map of takes), and
 * the dashboard auth the gateway injects, narrowed to the three things these
 * routes read from it: the Funnel header denies, a session cookie is required,
 * and one CSRF value is accepted.
 *
 * The audio route hands the finished WAV to `decodeWav`, so the bytes that
 * would have gone to a bucket are read back through the real decoder.
 *
 * The network gate is the REAL one (`servers/gateway/dashboard/auth.js`), not a
 * hand-rolled header check: the test server is always reached over loopback,
 * which bare loopback never passes, so this file declares loopback a trusted
 * proxy — the shape a same-box reverse proxy has — and names a private client
 * in `x-forwarded-for` on every request. The Funnel header is then refused by
 * the gate itself, which is what these tests are pinning.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import express from "express";
import { WebSocketServer } from "ws";
import { createTakeStorage } from "../bundles/studio/server/take-storage.js";
import { createTakeUploads } from "../bundles/studio/server/takes-upload.js";
import { createStudioWeb } from "../bundles/studio/server/web.js";
import { decodeWav } from "../bundles/studio/server/wav.js";
import { isAllowedNetwork } from "../servers/gateway/dashboard/auth.js";

// A test server is reached over loopback, which the real gate refuses on its
// own (bare loopback is how a same-box process reaches a private route).
// Declaring loopback a trusted proxy — a supported deployment shape — lets this
// file name a private client per request and still exercise the real gate.
process.env.CROW_TRUSTED_PROXIES = "loopback";
delete process.env.CROW_DASHBOARD_PUBLIC;

/** The private client every request in this file says it came from. */
const CLIENT = "10.0.0.5";

/** The forwarding header that names `CLIENT` to the trusted loopback proxy. */
const FORWARDED = Object.freeze({ "x-forwarded-for": CLIENT });

/** The song every take in these tests was recorded into. */
const SONG = "song-1";

/** A second song in the same project, for the "wrong song" checks. */
const OTHER_SONG = "song-2";

/** The clip the takes were recorded into. */
const CLIP = "clip-1";

/** The project both songs live in. */
const PROJECT = 7;

/** The project's storage prefix, as `project_spaces.storage_prefix` holds it. */
const PREFIX = "projects/7/";

/** One take id: a client-generated UUID, the only shape the routes accept. */
const TAKE = "6f1c1f7a-8f7e-4a4e-9a1d-2b3c4d5e6f70";

/** A second take id, for the take that belongs to the other song. */
const OTHER_TAKE = "1b3c5d7e-9f10-4a2b-8c4d-6e8f0a2b4c6d";

/** One sample id: a UUID an import or recording client generated. */
const SAMPLE = "3f2a1b0c-4d5e-4f60-8a71-9b2c3d4e5f60";

/** A second sample id, for the sample that belongs to the other song. */
const OTHER_SAMPLE = "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d";

/** The chunk size the routes advertise (1 MiB). */
const CHUNK_BYTES = 1048576;

/** One stereo 24-bit frame is six bytes. */
const FRAME_BYTES = 6;

/** The session cookie the fake dashboard auth accepts. */
const SESSION = "crow_session=good";

/** The CSRF value the fake dashboard auth accepts. */
const CSRF = "csrf-ok";

/** The Funnel header tailscaled sets on public traffic; it must never pass. */
const FUNNEL = Object.freeze({ "tailscale-funnel-request": "1" });

/** What every take route answers when this instance has no object storage. */
const STORAGE_UNAVAILABLE = "Crow storage is not available on this instance.";

/** @returns {string} the one storage key a take of a song may be played from. */
function takeKey(songId, takeId) {
  return `${PREFIX}studio/${songId}/takes/${takeId}.wav`;
}

/** @returns {string} the one storage key a sample of a song may be played from. */
function sampleKey(songId, sampleId) {
  return `${PREFIX}studio/${songId}/samples/${sampleId}.wav`;
}

/** @returns {string} the SHA-256 a client would send for one chunk. */
function hashOf(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * A deterministic signal as interleaved 24-bit little-endian PCM, the bytes the
 * recorder worklet sends: `frames` frames of `channelCount` channels.
 * @param {number} frames
 * @param {number} [channelCount]
 * @returns {Buffer}
 */
function pcm24(frames, channelCount = 2) {
  const bytes = Buffer.alloc(frames * channelCount * 3);
  let at = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      let value = Math.round(Math.sin(((frame + 1) * (channel + 1)) / 7) * 8000000);
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
 * An object store in memory. `uploadUnavailable` makes it the adapter a gateway
 * with no shared storage hands the upload service: staging still works, and
 * every call that would reach the bucket refuses with a 503.
 * @param {{uploadUnavailable?: boolean}} [options]
 */
function fakeStorage({ uploadUnavailable = false } = {}) {
  /** @type {Map<string, Buffer>} */
  const objects = new Map();
  const uploads = [];
  return {
    objects,
    uploads,
    async putObjectStream(key, stream, size, options) {
      if (uploadUnavailable) {
        const error = new Error("Crow storage is not available on this instance.");
        error.status = 503;
        throw error;
      }
      const pieces = [];
      for await (const piece of stream) pieces.push(Buffer.from(piece));
      const bytes = Buffer.concat(pieces);
      objects.set(key, bytes);
      uploads.push({ key, size, options, bytes });
    },
    async deleteObject(key) {
      objects.delete(key);
    },
    async getBucketStats() {
      let totalSizeBytes = 0;
      for (const bytes of objects.values()) totalSizeBytes += bytes.length;
      return { fileCount: objects.size, totalSizeBytes };
    },
    defaultBucket() {
      return "crow-files";
    },
  };
}

/**
 * A stand-in for `servers/storage/s3-client.js`: `isConfigured()` answers from
 * `state.configured`, so a test can flip the instance from "no Shared Storage"
 * to "configured" the way the Nest's save handler does, and `getClient()`
 * answers null until it is. `state.failPut` makes the bucket call fail the way
 * a lost connection does (no HTTP meaning of its own).
 */
function fakeS3Module() {
  const state = { configured: false, failPut: null, puts: [], deletes: [], stats: [], buckets: [], gets: [] };
  const sdk = {
    async putObject(bucket, key, stream, size, metaData) {
      if (state.failPut) throw state.failPut;
      state.puts.push({ bucket, key, size, metaData });
    },
  };
  return {
    state,
    module: {
      isConfigured: () => state.configured === true,
      getClient: () => (state.configured ? sdk : null),
      defaultBucket: () => "crow-files",
      async ensureBucket(bucket) {
        state.buckets.push(bucket);
      },
      async deleteObject(key, bucket) {
        state.deletes.push({ key, bucket });
      },
      async getBucketStats(bucket) {
        state.stats.push(bucket);
        return { fileCount: 2, totalSizeBytes: 5 };
      },
      async getObject(key, options) {
        state.gets.push({ key, options });
        return { stream: Readable.from([Buffer.from("wav")]), stat: { size: 3 } };
      },
    },
  };
}

/**
 * The playback adapter the audio route streams through: `getObject` answers
 * from the same object map, and records which keys were asked for.
 * @param {ReturnType<typeof fakeStorage>} storage
 */
function takeStorageOf(storage) {
  const requested = [];
  return {
    requested,
    defaultBucket: () => "crow-files",
    storagePrefixFor: async () => PREFIX,
    async getObject(key, options) {
      requested.push({ key, bucket: options?.bucket });
      const bytes = storage.objects.get(key);
      if (!bytes) throw new Error(`there is no object at ${key}`);
      return { stream: Readable.from([bytes]), stat: { size: bytes.length } };
    },
  };
}

/**
 * A database client with the three statements the upload service runs: the
 * `storage_files` row (with `s3_key` unique), its deletion, and the project's
 * storage prefix.
 */
function fakeDb() {
  const rows = new Set();
  return {
    rows,
    async execute(statement) {
      const sql = typeof statement === "string" ? statement : statement.sql;
      const args = statement && Array.isArray(statement.args) ? statement.args : [];
      if (/INSERT\s+INTO\s+storage_files/i.test(sql)) {
        rows.add(args[0]);
        return { rows: [] };
      }
      if (/DELETE\s+FROM\s+storage_files/i.test(sql)) {
        rows.delete(args[0]);
        return { rows: [] };
      }
      if (/storage_prefix/i.test(sql)) return { rows: [{ storage_prefix: PREFIX }] };
      return { rows: [] };
    },
  };
}

/** A project ACL that allows everything and remembers the audit lines. */
function fakeAcl() {
  const audits = [];
  return {
    audits,
    async assertCapability() {
      return { role: "owner" };
    },
    async appendAudit(_db, entry) {
      audits.push(entry);
    },
  };
}

/**
 * A session hub with what the web layer asks of it: the song list (a song's
 * project) and a song's snapshot (its takes, samples and pads). `take.add`
 * stores the take in the song and refuses an id the song already has, as the
 * real hub's de-duplication does. `songRow(id)` is the single-row lookup the
 * routes prefer, so a test can prove the audio route asks for one song instead
 * of listing them all.
 * @param {{takes?: object, otherTakes?: object, samples?: object,
 *          otherSamples?: object, pads?: object}} [options]
 */
function fakeHub({ takes = {}, otherTakes = {}, samples = {}, otherSamples = {}, pads = {} } = {}) {
  const commands = [];
  const songRows = [];
  const state = {
    [SONG]: { project_id: PROJECT, takes: { ...takes }, samples: { ...samples }, pads: { ...pads } },
    [OTHER_SONG]: { project_id: PROJECT, takes: { ...otherTakes }, samples: { ...otherSamples }, pads: {} },
  };
  return {
    commands,
    songRows,
    state,
    async songRow(songId) {
      songRows.push(String(songId));
      const song = state[songId];
      return song ? { id: songId, project_id: song.project_id } : null;
    },
    async listSongs() {
      return Object.entries(state).map(([id, song]) => ({
        id,
        project_id: song.project_id,
        title: id,
        updated_at: null,
      }));
    },
    async openSong(songId) {
      const song = state[songId];
      if (!song) {
        const error = new Error(`There is no song "${songId}".`);
        error.code = "not_found";
        throw error;
      }
      return {
        doc: null,
        snapshot: {
          meta: { title: songId, bpm: 120 },
          takes: song.takes,
          samples: song.samples,
          pads: song.pads,
          clips: {},
        },
        snapshot_version: 1,
      };
    },
    async runCommand(request) {
      commands.push(request);
      const song = state[request.song_id];
      const id = request.args?.take?.id;
      if (!song || !id) return { ok: false, code: "invalid", error: "that take has no song" };
      if (song.takes[id]) {
        return { ok: false, code: "invalid", error: `A take with id "${id}" already exists in this song.` };
      }
      song.takes[id] = { ...request.args.take, clip_id: request.args.clip_id, discarded: false };
      return { ok: true, entry: { command: request.command }, snapshot_version: 2 };
    },
  };
}

/** @returns {string|null} one cookie's value out of a Cookie header. */
function cookieOf(header, name) {
  for (const part of String(header || "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

/**
 * The dashboard session check the gateway hands the router
 * (`servers/gateway/dashboard/auth.js`), narrowed to these tests: the REAL
 * network rule answers first — so the Funnel header is refused by the gate
 * itself, and an off-network caller is refused the same way — and the page's
 * CSRF value is the only one accepted.
 */
function dashboardAuth(req, res, next) {
  if (!isAllowedNetwork(req)) {
    return res.status(403).type("html").send("Access Denied");
  }
  if (cookieOf(req.headers.cookie, "crow_session") !== "good") {
    return res.status(403).type("html").send("Access Denied");
  }
  return next();
}

/**
 * Boot a gateway-shaped server for one test: the real upload service over a
 * scratch staging directory, a real express app, and the fakes above.
 * @param {import("node:test").TestContext} t
 * @param {{uploadUnavailable?: boolean, playback?: boolean, takes?: object,
 *          otherTakes?: object, samples?: object, otherSamples?: object,
 *          pads?: object, audioStorage?: object|null}} [options]
 *   `audioStorage` replaces the playback adapter the audio route streams
 *   through, so a test can make storage refuse, hide an object, or stream
 *   slowly; null with `playback: false` is an instance with no storage.
 */
async function boot(
  t,
  {
    uploadUnavailable = false,
    playback = true,
    takes = {},
    otherTakes = {},
    samples = {},
    otherSamples = {},
    pads = {},
    audioStorage = null,
  } = {},
) {
  const db = fakeDb();
  const acl = fakeAcl();
  const hub = fakeHub({ takes, otherTakes, samples, otherSamples, pads });
  const storage = fakeStorage({ uploadUnavailable });
  const playbackStorage = audioStorage ?? (playback ? takeStorageOf(storage) : null);
  const staging = mkdtempSync(join(tmpdir(), "studio-takes-routes-"));

  const takeUploads = createTakeUploads({
    stagingDir: staging,
    storage,
    db,
    acl,
    hub,
    songs: {
      projectOf: async (songId) => (songId in hub.state ? hub.state[songId].project_id : null),
    },
    now: () => Date.now(),
    quotaMb: 5120,
  });

  const web = createStudioWeb({
    hub,
    Router: express.Router,
    WebSocketServer,
    auth: {
      // The real gate, as the gateway injects it (the WebSocket asks it too).
      isAllowedNetwork,
      sessionFromRequest: (req) => cookieOf(req.headers.cookie, "crow_session"),
      verifySession: async (token) => token === "good",
      csrfTokenAccepted: (_req, presented) => presented === CSRF,
      classifyPeer: () => ({ via: "remote" }),
    },
    crowHome: mkdtempSync(join(tmpdir(), "studio-takes-home-")),
    bundleDir: null,
    takeUploads,
    takeStorage: playbackStorage,
    // What the panel loader injects: the store's single-row song lookup.
    songRowOf: (songId) => hub.songRow(songId),
    // What the panel loader hands the web layer: the gateway's own byte parser
    // for the chunk route, with the limit the web layer names.
    rawBody: (limit) => express.raw({ type: () => true, limit, inflate: false }),
  });

  const app = express();
  // The gateway parses JSON for every route before the panel router (1 MB cap).
  app.use(express.json({ limit: "1mb" }));
  app.use(web.router(dashboardAuth));

  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  );

  return {
    base: `http://127.0.0.1:${server.address().port}`,
    port: server.address().port,
    db,
    acl,
    hub,
    storage,
    staging,
    takeUploads,
    playbackStorage,
  };
}

/** @returns {object} the details the panel sends with `begin`. */
function beginBody(overrides = {}) {
  return { song_id: SONG, project_id: PROJECT, clip_id: CLIP, rate: 48000, channels: 2, ...overrides };
}

/**
 * One dashboard request to the take routes, as the Studio page sends it: the
 * session cookie, the CSRF header, the forwarding header the trusted loopback
 * proxy adds, and a JSON body.
 * @returns {Promise<{status: number, body: object|null, text: string, headers: Headers}>}
 */
async function call(base, path, { method = "GET", body, headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      cookie: SESSION,
      "x-crow-csrf": CSRF,
      ...FORWARDED,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed, text, headers: response.headers };
}

/** PUT one chunk as raw bytes, the way the worklet's uploader does. */
async function sendChunk(base, takeId, index, bytes, headers = {}) {
  const response = await fetch(`${base}/api/studio/takes/${takeId}/chunks/${index}`, {
    method: "PUT",
    headers: {
      cookie: SESSION,
      "x-crow-csrf": CSRF,
      "content-type": "application/octet-stream",
      ...FORWARDED,
      ...headers,
    },
    body: bytes,
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed, text };
}

/** GET one take's audio, keeping the headers and the bytes. */
async function fetchAudio(base, songId, takeId, headers = {}) {
  return fetchAudioAt(base, `/api/studio/songs/${songId}/takes/${takeId}/audio`, headers);
}

/** GET one sample's audio, keeping the headers and the bytes. */
async function fetchSampleAudio(base, songId, sampleId, headers = {}) {
  return fetchAudioAt(base, `/api/studio/songs/${songId}/samples/${sampleId}/audio`, headers);
}

/** GET one stored audio route, keeping the headers and the bytes. */
async function fetchAudioAt(base, path, headers = {}) {
  const response = await fetch(`${base}${path}`, {
    headers: { cookie: SESSION, ...FORWARDED, ...headers },
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  let parsed = null;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    parsed = null;
  }
  return { status: response.status, headers: response.headers, bytes, body: parsed };
}

test("chunk route refuses a body over 1 MiB naming the limit", async (t) => {
  const { base } = await boot(t);
  const begun = await call(base, `/api/studio/takes/${TAKE}`, { method: "PUT", body: beginBody() });
  assert.equal(begun.status, 200);

  // 1 MiB plus a frame is allowed (the client cuts chunks on frame boundaries),
  // so a chunk just over 1 MiB still lands.
  const allowed = await sendChunk(base, TAKE, 0, Buffer.alloc(CHUNK_BYTES + 2));
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.sha256, hashOf(Buffer.alloc(CHUNK_BYTES + 2)));

  const tooBig = await sendChunk(base, TAKE, 1, Buffer.alloc(CHUNK_BYTES + 7));
  assert.equal(tooBig.status, 413);
  assert.deepEqual(tooBig.body, { error: "A take chunk can be at most 1 MiB." });
});

test("chunk PUT with a JSON body is refused with 415", async (t) => {
  const { base, hub, staging } = await boot(t);
  const begun = await call(base, `/api/studio/takes/${TAKE}`, { method: "PUT", body: beginBody() });
  assert.equal(begun.status, 200);

  // The gateway's JSON parser runs before this router, so a chunk sent as JSON
  // reaches the route as an object: the bytes are gone, and staging an empty
  // chunk would silently drop the audio.
  const json = await call(base, `/api/studio/takes/${TAKE}/chunks/0`, {
    method: "PUT",
    body: { chunk: "this is not audio" },
  });
  assert.equal(json.status, 415);
  assert.deepEqual(json.body, { error: "Send a take chunk as raw audio bytes." });
  assert.equal(existsSync(join(staging, TAKE, "000000.pcm")), false);

  const status = await call(base, `/api/studio/takes/${TAKE}`);
  assert.equal(status.status, 200);
  assert.deepEqual(status.body.received, []);
  assert.equal(hub.commands.length, 0);
});

test("chunk and begin PUTs need CSRF", async (t) => {
  const { base, hub, staging } = await boot(t);

  const begunWithout = await call(base, `/api/studio/takes/${TAKE}`, {
    method: "PUT",
    body: beginBody(),
    headers: { "x-crow-csrf": "not-the-token" },
  });
  assert.equal(begunWithout.status, 403);
  assert.deepEqual(begunWithout.body, { error: "csrf" });
  // Nothing was staged and nothing reached the song.
  assert.deepEqual(readdirSync(staging), []);
  assert.equal(hub.commands.length, 0);

  // A begun take, so the chunk route would have somewhere to put the bytes.
  const begun = await call(base, `/api/studio/takes/${TAKE}`, { method: "PUT", body: beginBody() });
  assert.equal(begun.status, 200);

  const chunkWithout = await sendChunk(base, TAKE, 0, pcm24(1), { "x-crow-csrf": "not-the-token" });
  assert.equal(chunkWithout.status, 403);
  assert.deepEqual(chunkWithout.body, { error: "csrf" });
  assert.equal(existsSync(join(staging, TAKE, "000000.pcm")), false);
  assert.equal(hub.commands.length, 0);
});

test("finish route needs CSRF", async (t) => {
  const { base, hub } = await boot(t);
  const begun = await call(base, `/api/studio/takes/${TAKE}`, { method: "PUT", body: beginBody() });
  assert.equal(begun.status, 200);

  const refused = await call(base, `/api/studio/takes/${TAKE}/finish`, {
    method: "POST",
    body: { chunk_hashes: [] },
    headers: { "x-crow-csrf": "not-the-token" },
  });
  assert.equal(refused.status, 403);
  assert.deepEqual(refused.body, { error: "csrf" });
  // Nothing reached the service: no take was applied to the song.
  assert.equal(hub.commands.length, 0);

  // The page's own token gets past the check and reaches the service, which
  // refuses an upload with no chunks of its own accord.
  const accepted = await call(base, `/api/studio/takes/${TAKE}/finish`, {
    method: "POST",
    body: { chunk_hashes: [] },
  });
  assert.equal(accepted.status, 400);
});

test("audio route refuses a take of another song", async (t) => {
  const { base, playbackStorage } = await boot(t, {
    // This song holds a take whose key names the other song's takes directory,
    // and the other song holds a perfectly good take of its own.
    takes: { [TAKE]: { id: TAKE, clip_id: CLIP, storage_key: takeKey(OTHER_SONG, TAKE) } },
    otherTakes: { [OTHER_TAKE]: { id: OTHER_TAKE, clip_id: CLIP, storage_key: takeKey(OTHER_SONG, OTHER_TAKE) } },
  });
  const otherSongsTake = await fetchAudio(base, SONG, OTHER_TAKE);
  assert.equal(otherSongsTake.status, 404);
  assert.deepEqual(otherSongsTake.body, { error: `There is no take ${OTHER_TAKE} in this song.` });

  const keyOutsideTheSong = await fetchAudio(base, SONG, TAKE);
  assert.equal(keyOutsideTheSong.status, 404);
  assert.deepEqual(keyOutsideTheSong.body, { error: `There is no take ${TAKE} in this song.` });

  // Neither request reached storage: the key was refused, not fetched and then
  // hidden.
  assert.deepEqual(playbackStorage.requested, []);
});

test("the sample route refuses another song's sample", async (t) => {
  const { base, playbackStorage } = await boot(t, {
    // This song holds a sample whose key names the other song's samples
    // directory, and the other song holds a perfectly good sample of its own.
    samples: {
      [SAMPLE]: { id: SAMPLE, storage_key: sampleKey(OTHER_SONG, SAMPLE), rate: 48000, channels: 2, frames: 8 },
    },
    otherSamples: {
      [OTHER_SAMPLE]: {
        id: OTHER_SAMPLE,
        storage_key: sampleKey(OTHER_SONG, OTHER_SAMPLE),
        rate: 48000,
        channels: 2,
        frames: 8,
      },
    },
  });
  const otherSongsSample = await fetchSampleAudio(base, SONG, OTHER_SAMPLE);
  assert.equal(otherSongsSample.status, 404);
  assert.deepEqual(otherSongsSample.body, { error: `There is no sample ${OTHER_SAMPLE} in this song.` });

  const keyOutsideTheSong = await fetchSampleAudio(base, SONG, SAMPLE);
  assert.equal(keyOutsideTheSong.status, 404);
  assert.deepEqual(keyOutsideTheSong.body, { error: `There is no sample ${SAMPLE} in this song.` });

  // Neither request reached storage: the key was refused, not fetched and then
  // hidden. `samples/` and `takes/` are separate: a take route cannot reach a
  // sample either.
  assert.deepEqual(playbackStorage.requested, []);

  // A sample of this song, at the key `finish` writes, streams back the way a
  // take does.
  const good = await boot(t, {
    samples: {
      [SAMPLE]: { id: SAMPLE, storage_key: sampleKey(SONG, SAMPLE), rate: 48000, channels: 2, frames: 8 },
    },
  });
  const bytes = pcm24(8);
  good.storage.objects.set(sampleKey(SONG, SAMPLE), bytes);

  const played = await fetchSampleAudio(good.base, SONG, SAMPLE);
  assert.equal(played.status, 200);
  assert.equal(played.headers.get("content-type"), "audio/wav");
  assert.equal(played.headers.get("cache-control"), "private, max-age=31536000, immutable");
  assert.equal(played.headers.get("content-length"), String(bytes.length));
  assert.deepEqual(played.bytes, bytes);
  assert.deepEqual(
    good.playbackStorage.requested.map((entry) => entry.key),
    [sampleKey(SONG, SAMPLE)],
  );
});

test("audio route streams the take with immutable caching", async (t) => {
  const key = takeKey(SONG, TAKE);
  const bytes = pcm24(8);
  const { base, hub, storage, playbackStorage } = await boot(t, {
    takes: { [TAKE]: { id: TAKE, clip_id: CLIP, storage_key: key, frames: 8, rate: 48000 } },
  });
  storage.objects.set(key, bytes);

  const played = await fetchAudio(base, SONG, TAKE);
  assert.equal(played.status, 200);
  assert.equal(played.headers.get("content-type"), "audio/wav");
  assert.equal(played.headers.get("cache-control"), "private, max-age=31536000, immutable");
  assert.equal(played.headers.get("content-length"), String(bytes.length));
  assert.deepEqual(played.bytes, bytes);
  assert.deepEqual(
    playbackStorage.requested.map((entry) => entry.key),
    [key],
  );
  // One song was asked for by id, not the whole song list.
  assert.deepEqual(hub.songRows, [SONG]);
});

test("audio route answers 503 without audio headers when storage fails", async (t) => {
  const key = takeKey(SONG, TAKE);
  const takes = { [TAKE]: { id: TAKE, clip_id: CLIP, storage_key: key, frames: 8, rate: 48000 } };

  // Storage that cannot be reached at all: the driver's own error names an
  // address, so it must never reach the caller (or `errorText`).
  const unreachable = await boot(t, {
    takes,
    audioStorage: {
      defaultBucket: () => "crow-files",
      storagePrefixFor: async () => PREFIX,
      async getObject() {
        throw new Error(`connect ECONNREFUSED while reading ${key}`);
      },
    },
  });
  const refused = await fetchAudio(unreachable.base, SONG, TAKE);
  assert.equal(refused.status, 503);
  assert.deepEqual(refused.body, { error: STORAGE_UNAVAILABLE });
  assert.match(refused.headers.get("content-type"), /^application\/json/);
  assert.equal(refused.headers.get("cache-control"), null, "no take is cached for a year when none could be read");

  // Storage that opened the object and then failed before its first byte: the
  // response is still a clean 503, with no audio headers on it.
  const brokenStream = await boot(t, {
    takes,
    audioStorage: {
      defaultBucket: () => "crow-files",
      storagePrefixFor: async () => PREFIX,
      async getObject() {
        const stream = new Readable({
          read() {
            this.destroy(new Error("the object store dropped the connection"));
          },
        });
        return { stream, stat: { size: 4096 } };
      },
    },
  });
  const broken = await fetchAudio(brokenStream.base, SONG, TAKE);
  assert.equal(broken.status, 503);
  assert.deepEqual(broken.body, { error: STORAGE_UNAVAILABLE });
  assert.match(broken.headers.get("content-type"), /^application\/json/);
  assert.equal(broken.headers.get("cache-control"), null);
  assert.notEqual(broken.headers.get("content-length"), "4096");
});

test("audio route answers 404 when the object is missing in storage", async (t) => {
  const key = takeKey(SONG, TAKE);
  const missingObject = (code) => ({
    defaultBucket: () => "crow-files",
    storagePrefixFor: async () => PREFIX,
    async getObject() {
      const error = new Error("The specified key does not exist.");
      error.code = code;
      throw error;
    },
  });

  // minio.js spells it NotFound; the S3 API spells it NoSuchKey.
  for (const code of ["NotFound", "NoSuchKey"]) {
    const { base } = await boot(t, { takes: { [TAKE]: { id: TAKE, clip_id: CLIP, storage_key: key } }, audioStorage: missingObject(code) });
    const played = await fetchAudio(base, SONG, TAKE);
    assert.equal(played.status, 404, code);
    assert.deepEqual(played.body, { error: `There is no take ${TAKE} in this song.` }, code);
    assert.equal(played.headers.get("cache-control"), null, code);
  }
});

test("audio route survives a client abort mid-stream", async (t) => {
  const key = takeKey(SONG, TAKE);
  /** @type {import("node:stream").Readable|null} the stream the route was handed */
  let handed = null;
  const { port } = await boot(t, {
    takes: { [TAKE]: { id: TAKE, clip_id: CLIP, storage_key: key } },
    audioStorage: {
      defaultBucket: () => "crow-files",
      storagePrefixFor: async () => PREFIX,
      async getObject() {
        handed = new Readable({
          read() {
            // A slow drip, so the page can go away in the middle of the WAV.
            setTimeout(() => this.push(Buffer.alloc(1024, 7)), 5);
          },
        });
        return { stream: handed, stat: { size: 1024 * 1024 } };
      },
    },
  });

  const rejections = [];
  const onRejection = (err) => rejections.push(err);
  process.on("unhandledRejection", onRejection);
  t.after(() => process.off("unhandledRejection", onRejection));

  await new Promise((resolve) => {
    const req = httpRequest({
      host: "127.0.0.1",
      port,
      path: `/api/studio/songs/${SONG}/takes/${TAKE}/audio`,
      headers: { cookie: SESSION, ...FORWARDED },
    });
    req.on("response", (res) => {
      res.once("data", () => {
        // The tab was closed after the first piece of the WAV arrived.
        req.destroy();
        resolve();
      });
      res.on("error", () => {});
    });
    // Destroying our own request is the test's own doing, not a failure.
    req.on("error", () => {});
    req.end();
  });

  // The route tears the source stream down instead of leaving it running, and
  // nothing it did became an unhandled rejection.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(handed, "the route opened the object");
  assert.equal(handed.destroyed, true, "the source stream is destroyed with the response");
  assert.deepEqual(rejections, []);
});

// The refusal below is the real `isAllowedNetwork` from the dashboard's auth
// module answering `dashboardAuth` — not a header check written for this test —
// so a route that lost the gate would be caught here.
test("funnel header refused on every take route", async (t) => {
  const key = takeKey(SONG, TAKE);
  const { base, hub, storage, staging } = await boot(t, {
    takes: { [TAKE]: { id: TAKE, clip_id: CLIP, storage_key: key } },
  });
  storage.objects.set(key, pcm24(4));

  const responses = [
    await call(base, `/api/studio/takes/${TAKE}`, { method: "PUT", body: beginBody(), headers: FUNNEL }),
    await sendChunk(base, TAKE, 0, pcm24(1), FUNNEL),
    await call(base, `/api/studio/takes/${TAKE}`, { headers: FUNNEL }),
    await call(base, `/api/studio/takes/${TAKE}/finish`, {
      method: "POST",
      body: { chunk_hashes: [] },
      headers: FUNNEL,
    }),
    await fetchAudio(base, SONG, TAKE, FUNNEL),
    await fetchSampleAudio(base, SONG, SAMPLE, FUNNEL),
  ];
  for (const response of responses) assert.equal(response.status, 403);

  // Nothing behind the gate ran: no take was staged and none was applied.
  assert.equal(hub.commands.length, 0);
  assert.deepEqual(readdirSync(staging), []);
});

test("routes work with storage unavailable: begin and chunks stage, finish says storage is not available", async (t) => {
  const { base, staging } = await boot(t, { uploadUnavailable: true, playback: false });

  const begun = await call(base, `/api/studio/takes/${TAKE}`, { method: "PUT", body: beginBody() });
  assert.equal(begun.status, 200);
  assert.equal(begun.body.chunk_bytes, CHUNK_BYTES);

  const bytes = pcm24(4);
  const chunk = await sendChunk(base, TAKE, 0, bytes);
  assert.equal(chunk.status, 200);
  assert.equal(chunk.body.sha256, hashOf(bytes));
  // The audio is on disk: storage being down does not lose the recording.
  assert.equal(existsSync(join(staging, TAKE, "000000.pcm")), true);

  const finished = await call(base, `/api/studio/takes/${TAKE}/finish`, {
    method: "POST",
    body: { chunk_hashes: [hashOf(bytes)] },
  });
  assert.equal(finished.status, 503);
  assert.deepEqual(finished.body, { error: "Crow storage is not available on this instance." });
  // The staged take is still there, so a later finish can try again.
  assert.equal(existsSync(join(staging, TAKE, "000000.pcm")), true);

  // And there is no storage to play a take from either.
  const played = await fetchAudio(base, SONG, TAKE);
  assert.equal(played.status, 503);
  assert.deepEqual(played.body, { error: "Crow storage is not available on this instance." });
});

test("begin, chunks and finish through the routes put the take in the song", async (t) => {
  const key = takeKey(SONG, TAKE);
  const { base, hub, storage, db, acl } = await boot(t);

  const begun = await call(base, `/api/studio/takes/${TAKE}`, {
    method: "PUT",
    body: beginBody({ offset_frames: 96, compensated: true, bpm: 124 }),
  });
  assert.equal(begun.status, 200);
  assert.equal(begun.body.chunk_bytes, CHUNK_BYTES);

  const chunks = [pcm24(1, 2), pcm24(3, 2)];
  const hashes = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const sent = await sendChunk(base, TAKE, index, chunks[index]);
    assert.equal(sent.status, 200);
    assert.equal(sent.body.sha256, hashOf(chunks[index]));
    hashes.push(sent.body.sha256);
  }

  const status = await call(base, `/api/studio/takes/${TAKE}`);
  assert.equal(status.status, 200);
  assert.equal(status.body.begun, true);
  assert.deepEqual(status.body.received.map((entry) => entry.index), [0, 1]);
  assert.equal(status.body.frames, 4);

  const finished = await call(base, `/api/studio/takes/${TAKE}/finish`, {
    method: "POST",
    body: { chunk_hashes: hashes },
  });
  assert.equal(finished.status, 200);
  const take = finished.body.take;
  assert.equal(take.id, TAKE);
  assert.equal(take.storage_key, key);
  assert.equal(take.frames, 4);
  assert.equal(take.rate, 48000);
  assert.equal(take.channels, 2);
  assert.equal(take.offset_frames, 96);
  assert.equal(take.compensated, true);
  assert.equal(take.bpm, 124);
  assert.equal(take.author_label, "You");

  // The song holds it, applied once, internally, by the person at the page.
  const opened = await hub.openSong(SONG);
  assert.ok(opened.snapshot.takes[TAKE], "the take is in the song");
  assert.equal(hub.commands.length, 1);
  assert.equal(hub.commands[0].command, "take.add");
  assert.equal(hub.commands[0].cmd_id, TAKE);
  assert.equal(hub.commands[0].internal, true);
  assert.deepEqual(hub.commands[0].author, { kind: "human", id: "local", label: "You" });
  assert.equal(acl.audits.length, 1);
  assert.equal(acl.audits[0].action, "studio.take");
  assert.equal(db.rows.has(key), true);

  // What reached storage is a WAV the real decoder reads back as four frames.
  const uploaded = storage.objects.get(key);
  assert.ok(uploaded, "the WAV reached storage");
  const decoded = decodeWav(uploaded);
  assert.equal(decoded.rate, 48000);
  assert.equal(decoded.channels.length, 2);
  assert.equal(decoded.channels[0].length, 4);
  assert.equal(decoded.channels[1].length, 4);

  // And the audio route now streams it back.
  const played = await fetchAudio(base, SONG, TAKE);
  assert.equal(played.status, 200);
  assert.deepEqual(played.bytes, uploaded);
  assert.equal(played.headers.get("cache-control"), "private, max-age=31536000, immutable");
});

test("storage configured after boot is picked up without a restart", async (t) => {
  const { state, module: s3 } = fakeS3Module();
  const storage = createTakeStorage({ client: s3, db: fakeDb() });
  const isUnavailable = (err) => {
    assert.equal(err?.status, 503);
    assert.equal(err?.message, STORAGE_UNAVAILABLE);
    return true;
  };

  // The gateway booted before Shared Storage was set up: this instance has no
  // object storage at all, and every call says so in one sentence.
  await assert.rejects(storage.putObjectStream("k.wav", Readable.from([Buffer.from([1])]), 1), isUnavailable);
  await assert.rejects(storage.getBucketStats(), isUnavailable);
  await assert.rejects(storage.deleteObject("k.wav"), isUnavailable);
  await assert.rejects(storage.getObject("k.wav"), isUnavailable);
  assert.equal(storage.defaultBucket(), "crow-files");
  assert.deepEqual(state.puts, []);

  // The operator saved Shared Storage in the Nest (a fresh config plus
  // `resetStorageClient()`): the very next call is served from the bucket,
  // with nothing restarted and no adapter rebuilt.
  state.configured = true;

  await storage.putObjectStream("k.wav", Readable.from([Buffer.from([1, 2, 3])]), 3, { contentType: "audio/wav" });
  assert.deepEqual(state.puts, [
    { bucket: "crow-files", key: "k.wav", size: 3, metaData: { "Content-Type": "audio/wav" } },
  ]);
  assert.deepEqual(await storage.getBucketStats(), { fileCount: 2, totalSizeBytes: 5 });
  await storage.deleteObject("k.wav");
  assert.deepEqual(state.deletes, [{ key: "k.wav", bucket: "crow-files" }]);
  const { stream, stat } = await storage.getObject("k.wav");
  const pieces = [];
  for await (const piece of stream) pieces.push(piece);
  assert.equal(Buffer.concat(pieces).toString(), "wav");
  assert.equal(stat.size, 3);

  // A bucket call that fails with no HTTP meaning of its own is the same 503
  // sentence: the driver's message names an endpoint, so it only goes to the
  // log.
  state.failPut = new Error("socket hang up (storage.example:9000)");
  await assert.rejects(
    storage.putObjectStream("k.wav", Readable.from([Buffer.from([1])]), 1),
    isUnavailable,
  );

  // A refusal that already has a status keeps it: this adapter never flattens
  // somebody else's answer into a 503.
  const outOfQuota = Object.assign(new Error("Storage quota exceeded (5120 MB)."), { status: 507 });
  state.failPut = outOfQuota;
  await assert.rejects(storage.putObjectStream("k.wav", Readable.from([Buffer.from([1])]), 1), (err) => {
    assert.equal(err, outOfQuota);
    return true;
  });
});