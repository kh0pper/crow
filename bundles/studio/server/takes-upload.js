/**
 * Take uploads — staging on disk, the streamed WAV, and the internal `take.add`.
 *
 * A recording is made in a browser that may be offline, may lose the network
 * mid-take, or may have its tab closed. So the panel sends a take it chose the
 * id of in 1 MiB pieces to the gateway, the gateway stages them on disk
 * (`<stagingDir>/<take_id>/`), and only when the client says "that is all of
 * it" does anything reach storage or the song:
 *
 *   begin    write `meta.json` for the take; it comes before any chunk
 *   putChunk stage one piece, hashed on arrival
 *   status   what has arrived, so a client can resume after a reload
 *   finish   stream the pieces behind a 24-bit WAV header into object storage,
 *            insert the `storage_files` row, then apply `take.add`
 *   sweep    drop staging nobody came back for
 *
 * ## A recorded take is never lost (spec §12)
 *
 * The staging directory is the only copy of a recording that has not reached
 * storage yet, so everything below is ordered to keep it:
 *
 *  - `begin` is idempotent and must come first, so a take always knows its song
 *    and its project before a byte is staged.
 *  - a chunk is written to a private temporary file and hard-linked into place,
 *    so a resent chunk either lands once or is compared byte for byte.
 *  - `finish` takes the song's takes from the hub and **fails closed**: if the
 *    song cannot be read, the take is kept and the call says so (503). Nothing
 *    is deleted on a guess.
 *  - the object and its row are only removed after a re-read says the song does
 *    not reference the take.
 *  - the staged audio is only dropped once a re-read after `take.add` shows the
 *    take in the song.
 *
 * ## One finish per take
 *
 * Within a process a second `finish` for the same id awaits the first and
 * returns its result. Across processes a `finishing.lock` in the take's
 * staging directory, created exclusively, keeps a second process out; a lock
 * older than fifteen minutes belonged to a process that died mid-finish and is
 * replaced.
 *
 * ## Why staging is on disk and not in the database
 *
 * A take is up to 345 MB of PCM. `crow.db` is a synced, backed-up SQLite file,
 * and none of that belongs in it.
 *
 * ## The WAV is never assembled in memory
 *
 * `finish` hands storage a `Readable` that yields the 44-byte header and then
 * each staged chunk file in order, with the total size known up front. Peak
 * memory is one chunk (the duplicate check hashes files as streams too).
 *
 * ## Order inside `finish`
 *
 *   1. read the song's takes (fail closed) and return early if the take is in;
 *   2. stream the WAV to its key, then insert the `storage_files` row
 *      (`ON CONFLICT(s3_key) DO NOTHING`: the key is fixed per take, so a
 *      retried finish finds the row a crashed attempt left and carries on);
 *   3. `take.add` through the hub — `internal: true`, because only Studio
 *      itself may invent a take;
 *   4. re-read the song: a take it does not show is kept, not cleaned up;
 *   5. the `studio.take` audit line;
 *   6. mark the staging finished and drop its chunks.
 *
 * ## No app modules
 *
 * This file imports nothing from `servers/…`. The database, the storage client,
 * the project ACL, the hub and the song lookup arrive injected, so the same code
 * runs in the gateway, in a test with fakes, and anywhere else the bundle is
 * installed.
 *
 * Errors that have an HTTP meaning carry `error.status` for the routes: 400 for
 * an invalid request, 403 for a refusal from the ACL, 404 for an unknown take or
 * song, 409 for a conflict (a different chunk, a different meta, a missing
 * chunk, a take another process is finishing), 413 past a limit, 503 when the
 * song cannot be read, 507 when the project is out of storage quota.
 */

import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, mkdir, open, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { wavHeader } from "./wav.js";

/**
 * The size of one uploaded chunk: 1 MiB. A chunk may exceed it by one frame,
 * because the client cuts its chunks on frame boundaries and a frame is 3 or 6
 * bytes wide.
 * @type {number}
 */
export const CHUNK_BYTES = 1048576;

/** The largest chunk index a take may use (six digits of file name). */
const MAX_CHUNK_INDEX = 99999;

/** The sample rates a take may have been recorded at (spec §18). */
const TAKE_RATES = Object.freeze([44100, 48000, 88200, 96000]);

/** How many channels a recording may have. */
const MAX_CHANNELS = 2;

/** How many un-finished uploads one song may have at a time. */
const MAX_OPEN_UPLOADS = 32;

/** The default cap of one take: 1200 s of 48 kHz stereo. */
const DEFAULT_MAX_TAKE_SECONDS = 1200;

/** The rate the sample cap is stated at (48 kHz, the take format's rate). */
const CAP_RATE = 48000;

/** The channel count the sample cap is stated at (stereo). */
const CAP_CHANNELS = 2;

/** Bytes in one 24-bit sample. */
const BYTES_PER_SAMPLE = 3;

/** The `storage_files.reference_type` a take is filed under. */
const REFERENCE_TYPE = "studio_take";

/** The audit action a finished take is recorded with. */
const AUDIT_ACTION = "studio.take";

/** How long staged chunks nobody finished are kept. */
const STALE_MS = 7 * 24 * 60 * 60 * 1000;

/** The meta file's name inside a take's staging directory. */
const META_FILE = "meta.json";

/** The lock a `finish` holds on one take's staging directory. */
const LOCK_FILE = "finishing.lock";

/** A finish lock older than this belonged to a process that died. */
const LOCK_STALE_MS = 15 * 60 * 1000;

/** The longest author label a take carries (the `take.add` schema's limit). */
const MAX_AUTHOR_LABEL = 80;

/** What a caller is told when the song cannot be read mid-finish. */
const SONG_UNREADABLE = "Studio could not read the song; the take is kept and will finish later.";

/**
 * A take id: the client-generated UUID. It names a staging directory and a
 * storage key segment, so nothing else is accepted anywhere in this module.
 */
const TAKE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * What a song id may look like. It becomes a storage key segment (the same rule
 * `render.js` applies), so anything else is refused before it is used.
 */
const SONG_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** @returns {Error} a request the caller has to fix (400). */
function badRequest(message) {
  return withStatus(message, 400);
}

/** @returns {Error} a take the caller may not touch (403). */
function forbidden(message) {
  return withStatus(message, 403);
}

/** @returns {Error} a take with no upload in progress (404). */
function notFound(message) {
  return withStatus(message, 404);
}

/** @returns {Error} a request that fights the upload's state (409). */
function conflict(message) {
  return withStatus(message, 409);
}

/** @returns {Error} a request past a limit (413). */
function tooLarge(message) {
  return withStatus(message, 413);
}

/** @returns {Error} a project out of storage (507). */
function outOfQuota(message) {
  return withStatus(message, 507);
}

/**
 * Build a refusal a route can map to a status.
 * @param {string} message
 * @param {number} status
 * @returns {Error}
 */
function withStatus(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

/** @returns {string} a count with its thousands separators, e.g. 115,200,000. */
function groupThousands(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** @returns {string} the SHA-256 of a buffer, lower-case hex. */
function sha256Of(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * Hash a staged file without reading it whole into memory.
 * @param {string} file
 * @returns {Promise<string>} lower-case hex, or "" when the file is not there
 */
async function sha256File(file) {
  try {
    const hash = createHash("sha256");
    for await (const piece of createReadStream(file)) hash.update(piece);
    return hash.digest("hex");
  } catch {
    return "";
  }
}

/** @returns {string} the file name of one chunk index, e.g. `000003.pcm`. */
function chunkName(index) {
  return `${String(index).padStart(6, "0")}.pcm`;
}

/**
 * The author a take is stored and audited with.
 *
 * An upload without an author is treated as an agent's (the strictest reading),
 * exactly as the hub does; the take's `author_label` falls back to the id and
 * then to "Studio", because the take record needs a name to show.
 * @param {{kind?: string, id?: string|null, label?: string|null}|null} author
 * @returns {{kind: string, id: (string|null), label: (string|null)}}
 */
function normalizeAuthor(author) {
  if (!author || typeof author !== "object") return { kind: "agent", id: null, label: null };
  return {
    kind: typeof author.kind === "string" && author.kind !== "" ? author.kind : "agent",
    id: author.id == null ? null : String(author.id),
    label: typeof author.label === "string" && author.label !== "" ? author.label : null,
  };
}

/** @returns {string} the label a take shows for who recorded it. */
function authorLabelOf(author) {
  const label = author?.label || author?.id || "Studio";
  return String(label).slice(0, MAX_AUTHOR_LABEL);
}

/**
 * The audit actor for one author, the way `render.js` writes it: a person is
 * `local`, anything else is `bot`.
 * @param {{kind?: string, id?: string|null}} author
 * @returns {{actor_type: string, actor_id: (string|null)}}
 */
function auditActor(author) {
  if (author && author.kind === "human") return { actor_type: "local", actor_id: author.id ?? null };
  return { actor_type: "bot", actor_id: author?.id ?? null };
}

/**
 * The project's storage prefix, which every object of that project is filed
 * under (the same prefix `render.js` and `servers/storage` use).
 * @param {object} db
 * @param {number} projectId
 * @returns {Promise<string>}
 */
async function storagePrefixFor(db, projectId) {
  const { rows } = await db.execute({
    sql: "SELECT storage_prefix FROM project_spaces WHERE id = ?",
    args: [projectId],
  });
  const prefix = rows && rows[0] ? rows[0].storage_prefix : null;
  return typeof prefix === "string" ? prefix : "";
}

/**
 * Create the take-upload service for one gateway process.
 *
 * @param {object} options
 * @param {string} options.stagingDir where unfinished takes are staged, e.g.
 *   `<CROW_HOME>/studio-staging`
 * @param {{putObjectStream: Function, deleteObject: Function,
 *          getBucketStats: Function, defaultBucket: Function}} options.storage
 *   the object storage, injected so this module imports no app code
 * @param {object} options.db a libsql-compatible client (`execute({sql, args})`)
 * @param {{assertCapability: Function, appendAudit: Function}} options.acl the
 *   project ACL
 * @param {{runCommand: Function, openSong: Function}} options.hub the session
 *   hub: `take.add` goes through it, and its snapshot says whether a take is
 *   already in the song
 * @param {{projectOf: (songId: string) => Promise<number|null>}} options.songs
 *   the song table (`studio_songs`): a take's project is always its song's
 * @param {() => (number|Date)} [options.now] the clock
 * @param {number} [options.quotaMb] the storage quota in MB (defaults to
 *   `STORAGE_QUOTA_MB`, else 5120)
 * @param {number} [options.maxSamples] the sample cap of one take; when it is
 *   not passed the cap is `maxTakeSeconds × 48000 × 2`
 * @param {number} [options.maxTakeSeconds] the cap in seconds of 48 kHz stereo
 *   (defaults to `STUDIO_MAX_TAKE_SECONDS`, else 1200)
 * @returns {{begin: Function, putChunk: Function, status: Function,
 *            finish: Function, sweepStale: Function}}
 */
export function createTakeUploads({
  stagingDir,
  storage,
  db,
  acl,
  hub,
  songs,
  now = () => Date.now(),
  quotaMb = Number(process.env.STORAGE_QUOTA_MB || 5120),
  maxSamples,
  maxTakeSeconds = Number(process.env.STUDIO_MAX_TAKE_SECONDS || DEFAULT_MAX_TAKE_SECONDS),
} = {}) {
  if (typeof stagingDir !== "string" || stagingDir === "") {
    throw new TypeError("createTakeUploads needs a staging directory");
  }
  if (!storage || typeof storage.putObjectStream !== "function" || typeof storage.deleteObject !== "function") {
    throw new TypeError("createTakeUploads needs a storage client (putObjectStream, deleteObject, getBucketStats)");
  }
  if (!db || typeof db.execute !== "function") {
    throw new TypeError("createTakeUploads needs a database client");
  }
  if (!acl || typeof acl.assertCapability !== "function" || typeof acl.appendAudit !== "function") {
    throw new TypeError("createTakeUploads needs the project ACL (assertCapability, appendAudit)");
  }
  if (!hub || typeof hub.runCommand !== "function" || typeof hub.openSong !== "function") {
    throw new TypeError("createTakeUploads needs the session hub (runCommand, openSong)");
  }
  if (!songs || typeof songs.projectOf !== "function") {
    throw new TypeError("createTakeUploads needs the song lookup (songs.projectOf)");
  }

  const quotaText = Number.isFinite(Number(quotaMb)) ? Number(quotaMb) : 5120;
  const quotaBytes = quotaText * 1024 * 1024;
  const capSeconds =
    Number.isFinite(Number(maxTakeSeconds)) && Number(maxTakeSeconds) > 0
      ? Number(maxTakeSeconds)
      : DEFAULT_MAX_TAKE_SECONDS;
  const sampleCap =
    Number.isFinite(Number(maxSamples)) && Number(maxSamples) > 0
      ? Math.round(Number(maxSamples))
      : Math.round(capSeconds * CAP_RATE * CAP_CHANNELS);

  /** @type {Map<string, Promise<object>>} the finishes running in this process, by take id. */
  const finishers = new Map();

  /** @type {Promise<unknown>} the queue that makes the quota check and the upload one step. */
  let uploadQueue = Promise.resolve();

  /** @returns {number} the injected clock in milliseconds. */
  function millisNow() {
    const value = now();
    if (value instanceof Date) return value.getTime();
    const milliseconds = Number(value);
    return Number.isFinite(milliseconds) ? milliseconds : Date.now();
  }

  /** @returns {string} the injected clock as an ISO 8601 string. */
  function nowIso() {
    return new Date(millisNow()).toISOString();
  }

  /** @returns {string} a take's staging directory. */
  function takeDir(takeId) {
    return join(stagingDir, takeId);
  }

  /** @returns {string} the path of one chunk. */
  function chunkPath(takeId, index) {
    return join(takeDir(takeId), chunkName(index));
  }

  /** @returns {string} the path of one chunk's recorded hash. */
  function hashPath(takeId, index) {
    return `${chunkPath(takeId, index)}.sha256`;
  }

  /**
   * A private temporary name inside a take's staging directory: two concurrent
   * chunk uploads of one index never share one.
   * @param {string} dir
   * @param {string} tag
   * @returns {string}
   */
  function tempPath(dir, tag) {
    return join(dir, `.${tag}-${randomUUID()}`);
  }

  /**
   * Refuse anything that is not a take id: it is a directory name and a key
   * segment, and the only shape Studio ever creates.
   * @param {unknown} takeId
   * @returns {string} the id
   */
  function requireTakeId(takeId) {
    if (typeof takeId !== "string" || !TAKE_ID_PATTERN.test(takeId)) {
      throw badRequest("A take id is a UUID, like 6f1c1f7a-8f7e-4a4e-9a1d-2b3c4d5e6f70.");
    }
    return takeId;
  }

  /**
   * Read one take's staged meta.
   * @param {string} takeId
   * @returns {Promise<object|null>} null when nothing is staged under that id
   */
  async function readMeta(takeId) {
    try {
      const text = await readFile(join(takeDir(takeId), META_FILE), "utf8");
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  /**
   * Write a take's meta, atomically: a half-written meta is a take nobody can
   * resume, and the gateway may be killed at any moment.
   * @param {string} takeId
   * @param {object} meta
   * @returns {Promise<void>}
   */
  async function writeMeta(takeId, meta) {
    const dir = takeDir(takeId);
    await mkdir(dir, { recursive: true });
    const tmp = join(dir, `${META_FILE}.tmp`);
    await writeFile(tmp, JSON.stringify(meta));
    await rename(tmp, join(dir, META_FILE));
  }

  /**
   * The song's project. A take is filed in its song's project, never in one a
   * caller named (spec §5.9: songs live in projects).
   * @param {string} songId
   * @returns {Promise<number>} the project id
   * @throws {Error} 404 when there is no such song
   */
  async function songProjectOf(songId) {
    const linked = await songs.projectOf(songId);
    const project = Number(linked);
    if (linked == null || !Number.isInteger(project) || project <= 0) {
      throw notFound(`There is no song "${songId}".`);
    }
    return project;
  }

  /**
   * Refuse a caller without `write_files` in the project that owns the take.
   * Every step of an upload goes through this, so a take cannot be begun,
   * extended, inspected or finished by someone who may not write there.
   * @param {number} projectId
   * @returns {Promise<void>}
   * @throws {Error} 403
   */
  async function assertWrite(projectId) {
    try {
      await acl.assertCapability(db, projectId, null, "write_files");
    } catch (error) {
      if (error && (error.name === "AclError" || error.status === 403)) throw forbidden(error.message);
      throw error;
    }
  }

  /**
   * The song's takes, from the hub's snapshot, failing closed.
   *
   * A finish decides what it may delete from this answer, so an unreadable song
   * is never treated as an empty one: it throws instead, and the staged take
   * and everything already uploaded stay where they are.
   * @param {string} songId
   * @returns {Promise<Object<string, object>>}
   * @throws {Error} 503 when the song cannot be read
   */
  async function songTakes(songId) {
    let opened;
    try {
      opened = await hub.openSong(songId);
    } catch {
      throw withStatus(SONG_UNREADABLE, 503);
    }
    const takes = opened?.snapshot?.takes;
    return takes && typeof takes === "object" ? takes : {};
  }

  /**
   * The song's tempo, for a take whose begin call did not name one (the route's
   * body does not carry it, and the take record has to say what tempo it was
   * recorded at).
   * @param {string} songId
   * @returns {Promise<number|null>} 20-300, or null when it cannot be read
   */
  async function songTempo(songId) {
    try {
      const opened = await hub.openSong(songId);
      const bpm = Number(opened?.snapshot?.meta?.bpm);
      return Number.isFinite(bpm) && bpm >= 20 && bpm <= 300 ? bpm : null;
    } catch {
      return null;
    }
  }

  /**
   * How many uploads one song has begun and not finished.
   * @param {string} songId
   * @returns {Promise<number>}
   */
  async function openUploadsFor(songId) {
    const entries = await readdir(stagingDir, { withFileTypes: true }).catch(() => []);
    let count = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const meta = await readMeta(entry.name);
      if (!meta || meta.song_id !== songId || meta.finished === true) continue;
      count += 1;
      // There is no reason to count past the limit.
      if (count >= MAX_OPEN_UPLOADS) break;
    }
    return count;
  }

  /**
   * The bytes already staged for a take, so `begin` can check that they add up
   * to whole frames and `putChunk` can hold the take to its sample cap.
   * @param {string} takeId
   * @returns {Promise<number>}
   */
  async function stagedBytes(takeId) {
    const names = await readdir(takeDir(takeId)).catch(() => []);
    let total = 0;
    for (const name of names) {
      if (!/^\d{6}\.pcm$/.test(name)) continue;
      const info = await stat(join(takeDir(takeId), name)).catch(() => null);
      if (info) total += info.size;
    }
    return total;
  }

  /**
   * Record the beginning of one take's upload.
   *
   * It must come before the chunks: without it the gateway would not know whose
   * take it is staging, and a chunk is never accepted without a song and a
   * project to check.
   *
   * Idempotent on the same details, so a client that lost the network after its
   * request went out can simply ask again. The same id with different details
   * is a conflict, because the take that id already owns the staged bytes.
   *
   * @param {string} takeId
   * @param {{song_id: string, project_id: number, clip_id: string,
   *          rate: number, channels: number, author?: object,
   *          offset_frames?: number, compensated?: boolean, bpm?: number}} request
   * @returns {Promise<{chunk_bytes: number}>}
   */
  async function begin(takeId, request = {}) {
    requireTakeId(takeId);
    const {
      song_id: songId,
      project_id: requestedProjectRaw,
      clip_id: clipId,
      rate,
      channels,
      author = null,
      offset_frames: offsetFrames = 0,
      compensated = false,
      bpm: statedBpm,
    } = request ?? {};

    if (typeof songId !== "string" || !SONG_ID_PATTERN.test(songId)) {
      throw badRequest("That is not a valid song id.");
    }
    if (typeof clipId !== "string" || clipId === "") {
      throw badRequest("An upload needs the clip the take was recorded into.");
    }
    const requestedProject = Number(requestedProjectRaw);
    if (!Number.isInteger(requestedProject)) {
      throw badRequest("An upload needs the song's project.");
    }
    const sampleRate = Number(rate);
    if (!TAKE_RATES.includes(sampleRate)) {
      throw badRequest(`A take's rate is one of ${TAKE_RATES.join(", ")} samples per second.`);
    }
    const channelCount = Number(channels);
    if (!Number.isInteger(channelCount) || channelCount < 1 || channelCount > MAX_CHANNELS) {
      throw badRequest(`A take has 1 or ${MAX_CHANNELS} channels.`);
    }
    const offset = Number(offsetFrames);
    if (!Number.isInteger(offset) || offset < 0) {
      throw badRequest("A take's offset is a whole, non-negative number of frames.");
    }
    if (typeof compensated !== "boolean") {
      throw badRequest("A take's compensated flag is true or false.");
    }
    const actor = normalizeAuthor(author);

    // The project is the song's own. A caller that names another project is
    // asking to file this take somewhere it does not belong, so it is refused
    // before anything is written.
    const projectId = await songProjectOf(songId);
    if (projectId !== requestedProject) {
      throw badRequest(`That song is not in project ${requestedProject}.`);
    }
    // And the caller must be allowed to put files in that project.
    await assertWrite(projectId);

    const stated = Number(statedBpm);
    const bpm = Number.isFinite(stated) && stated >= 20 && stated <= 300 ? stated : null;

    const existing = await readMeta(takeId);
    if (existing && existing.finished !== true) {
      if (!sameUpload(existing, { songId, projectId, clipId, sampleRate, channelCount, actor, offset, compensated, bpm })) {
        throw conflict(`Take "${takeId}" is already being uploaded with different details.`);
      }
      return { chunk_bytes: CHUNK_BYTES };
    }
    if (existing && existing.finished === true) {
      // A finished upload whose take has since left the song (an undo, or the
      // clip was removed): start over in a clean directory. The song is read
      // fail-closed, because only its own answer may drop that meta.
      const takes = await songTakes(existing.song_id);
      if (takes[takeId]) return { chunk_bytes: CHUNK_BYTES };
      await rm(takeDir(takeId), { recursive: true, force: true });
    }

    const open = await openUploadsFor(songId);
    if (open >= MAX_OPEN_UPLOADS) {
      throw tooLarge(
        `A song can have at most ${MAX_OPEN_UPLOADS} uploads in progress; finish or abandon one before starting another.`,
      );
    }

    const frameBytes = channelCount * BYTES_PER_SAMPLE;
    const staged = await stagedBytes(takeId);
    if (staged % frameBytes !== 0) {
      throw badRequest(
        `The chunks already sent are not whole ${channelCount}-channel frames: ${staged} bytes is not a multiple of ${frameBytes}.`,
      );
    }

    const tempo = bpm ?? (await songTempo(songId)) ?? 120;
    const meta = {
      take_id: takeId,
      song_id: songId,
      project_id: projectId,
      clip_id: clipId,
      rate: sampleRate,
      channels: channelCount,
      offset_frames: offset,
      compensated,
      bpm: tempo,
      author: actor,
      recorded_at: nowIso(),
      created_at: millisNow(),
    };
    await writeMeta(takeId, meta);
    return { chunk_bytes: CHUNK_BYTES };
  }

  /**
   * Whether a staged meta describes the same upload as this request. `bpm` is
   * only compared when the caller stated one, because a retry that leaves it
   * out means "the same take", not "a different tempo".
   * @param {object} meta
   * @param {{songId: string, projectId: number, clipId: string, sampleRate: number,
   *          channelCount: number, actor: object, offset: number, compensated: boolean,
   *          bpm: number|null}} request
   * @returns {boolean}
   */
  function sameUpload(meta, request) {
    if (meta.song_id !== request.songId) return false;
    if (Number(meta.project_id) !== request.projectId) return false;
    if (meta.clip_id !== request.clipId) return false;
    if (Number(meta.rate) !== request.sampleRate) return false;
    if (Number(meta.channels) !== request.channelCount) return false;
    if (Number(meta.offset_frames ?? 0) !== request.offset) return false;
    if ((meta.compensated === true) !== request.compensated) return false;
    if (request.bpm !== null && Number(meta.bpm) !== request.bpm) return false;
    return JSON.stringify(normalizeAuthor(meta.author)) === JSON.stringify(request.actor);
  }

  /**
   * Write one file into a take's staging directory atomically.
   *
   * Each call writes its own temporary file and then hard-links it into place;
   * `link` fails if the name exists, so of two concurrent calls exactly one
   * creates the file and the other learns it was already there. The temporary
   * is always removed.
   *
   * @param {string} dir the take's staging directory
   * @param {string} tag a short tag for the temporary's name
   * @param {Buffer|string} body
   * @param {string} file the final path
   * @returns {Promise<boolean>} true when this call put the file there
   */
  async function linkIntoPlace(dir, tag, body, file) {
    const tmp = tempPath(dir, tag);
    await writeFile(tmp, body);
    try {
      await link(tmp, file);
      return true;
    } catch (error) {
      if (error && error.code === "EEXIST") return false;
      throw error;
    } finally {
      await unlink(tmp).catch(() => {});
    }
  }

  /**
   * Stage one chunk of a take.
   *
   * The bytes are 24-bit little-endian interleaved PCM covering whole frames.
   * `begin` must have run: a chunk staged without a song and a project could not
   * be checked against either.
   *
   * @param {string} takeId
   * @param {number} index 0-99999
   * @param {Buffer|Uint8Array} bytes
   * @returns {Promise<{sha256: string}>}
   */
  /**
   * One take's chunk writes, in arrival order. The cap check and the write
   * are then one step per take: two chunks sent at once cannot both pass a
   * check that only one of them fits under.
   * @type {Map<string, Promise<unknown>>}
   */
  const chunkQueues = new Map();

  async function putChunk(takeId, index, bytes) {
    requireTakeId(takeId);
    const before = chunkQueues.get(takeId) ?? Promise.resolve();
    const run = before.catch(() => {}).then(() => putChunkNow(takeId, index, bytes));
    chunkQueues.set(takeId, run);
    try {
      return await run;
    } finally {
      if (chunkQueues.get(takeId) === run) chunkQueues.delete(takeId);
    }
  }

  async function putChunkNow(takeId, index, bytes) {
    const at = Number(index);
    if (!Number.isInteger(at) || at < 0 || at > MAX_CHUNK_INDEX) {
      throw badRequest(`A chunk index is a whole number from 0 to ${MAX_CHUNK_INDEX}.`);
    }
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
      throw badRequest("A chunk needs its bytes.");
    }

    const meta = await readMeta(takeId);
    if (!meta) {
      throw notFound("Begin the take before sending its audio.");
    }
    // The gate is the song's project, read now: a take cannot be extended by
    // someone who may not write where its song lives.
    await assertWrite(await songProjectOf(meta.song_id));
    if (meta.finished === true) {
      throw conflict(`Take "${takeId}" is already finished, so nothing more can be sent to it.`);
    }
    const channelCount = Number(meta.channels);
    if (!Number.isInteger(channelCount) || channelCount < 1 || channelCount > MAX_CHANNELS) {
      throw conflict(`Take "${takeId}" has no readable channel count; begin it again.`);
    }

    const frameBytes = channelCount * BYTES_PER_SAMPLE;
    const maxBytes = CHUNK_BYTES + frameBytes;
    // No take this size can need a chunk past this index.
    const lastIndex = Math.ceil((sampleCap * BYTES_PER_SAMPLE) / CHUNK_BYTES);
    if (at > lastIndex) {
      throw tooLarge(
        `A take can hold at most ${groupThousands(sampleCap)} samples (frames × channels), so it never needs chunk ${at}.`,
      );
    }
    if (bytes.byteLength > maxBytes) {
      throw tooLarge(
        `A chunk can be at most ${CHUNK_BYTES} bytes plus one frame: ${bytes.byteLength} bytes is too much.`,
      );
    }
    if (bytes.byteLength % frameBytes !== 0) {
      throw badRequest(
        `A chunk covers whole ${channelCount}-channel frames: ${bytes.byteLength} bytes is not a multiple of ${frameBytes}.`,
      );
    }

    // The take's own cap, in samples: a staged byte is one channel's 24-bit
    // sample, so `maxSamples` samples of PCM weigh `maxSamples × 3` bytes.
    const staged = await stagedBytes(takeId);
    const buffer = Buffer.from(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength);
    const sha256 = sha256Of(buffer);

    const dir = takeDir(takeId);
    await mkdir(dir, { recursive: true });
    const file = chunkPath(takeId, at);
    const previous = await sha256File(file);
    if (previous !== "") {
      // A resent chunk is not new audio, so it does not count against the cap.
      if (previous === sha256) return { sha256 };
      throw conflict(`chunk ${at} was already received with different bytes`);
    }

    if (staged + bytes.byteLength > sampleCap * BYTES_PER_SAMPLE) {
      throw tooLarge(
        `A take can hold at most ${groupThousands(sampleCap)} samples (frames × channels); this chunk would take it past that.`,
      );
    }

    const placed = await linkIntoPlace(dir, "tmp", buffer, file);
    if (!placed) {
      // Lost the race to another upload of the same index: its bytes are the
      // take's, and they are either the ones we sent or a conflict.
      const existing = await sha256File(file);
      if (existing !== sha256) throw conflict(`chunk ${at} was already received with different bytes`);
    }
    // The hash sidecar is written the same way; a missing one is recomputed
    // from the chunk itself when it is read (`chunkHash`).
    await linkIntoPlace(dir, "sha", sha256, hashPath(takeId, at));
    return { sha256 };
  }

  /**
   * What has arrived for one take, so a client can resume where it stopped.
   *
   * `frames` is null until the take's channel count says how many bytes a frame
   * is; a take that never began has no song to check, so it is not found.
   *
   * @param {string} takeId
   * @returns {Promise<{begun: boolean, received: Array<{index: number, sha256: string}>,
   *                    frames: (number|null)}>}
   */
  async function status(takeId) {
    requireTakeId(takeId);
    const meta = await readMeta(takeId);
    if (!meta) {
      throw notFound(`There is no upload in progress for take "${takeId}"; begin it before asking after it.`);
    }
    await assertWrite(await songProjectOf(meta.song_id));
    const chunks = await listChunks(takeId);
    const received = chunks.map(({ index, sha256 }) => ({ index, sha256 }));
    if (meta.finished === true) {
      const frames = Number.isFinite(Number(meta.frames)) ? Number(meta.frames) : null;
      return { begun: true, received, frames };
    }
    const frameBytes = Number(meta.channels) * BYTES_PER_SAMPLE;
    let bytes = 0;
    for (const chunk of chunks) bytes += chunk.bytes;
    return { begun: true, received, frames: frameBytes > 0 ? Math.floor(bytes / frameBytes) : null };
  }

  /**
   * Every chunk staged for a take, in index order, with its hash.
   * @param {string} takeId
   * @returns {Promise<Array<{index: number, sha256: string, bytes: number}>>}
   */
  async function listChunks(takeId) {
    const dir = takeDir(takeId);
    const names = await readdir(dir).catch(() => []);
    const out = [];
    for (const name of names) {
      const match = /^(\d{6})\.pcm$/.exec(name);
      if (!match) continue;
      const index = Number(match[1]);
      const info = await stat(join(dir, name)).catch(() => null);
      out.push({ index, sha256: await chunkHash(takeId, index), bytes: info ? info.size : 0 });
    }
    out.sort((left, right) => left.index - right.index);
    return out;
  }

  /**
   * A chunk's recorded hash, computed from the file when the sidecar is missing
   * (a process that stopped between the two writes).
   * @param {string} takeId
   * @param {number} index
   * @returns {Promise<string>}
   */
  async function chunkHash(takeId, index) {
    try {
      const text = (await readFile(hashPath(takeId, index), "utf8")).trim();
      if (/^[0-9a-f]{64}$/i.test(text)) return text.toLowerCase();
    } catch {
      /* fall through to hashing the chunk itself */
    }
    return sha256File(chunkPath(takeId, index));
  }

  /**
   * Run one finish's quota check and upload after every other one in this
   * process: two finishes that each read the old `used` figure and then upload
   * would both fit and take the project over its quota.
   * @template T
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  function serializeUpload(task) {
    const run = uploadQueue.then(task, task);
    uploadQueue = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  /**
   * Take one take's finish lock.
   *
   * The lock is a file created with the exclusive flag, so two processes
   * finishing the same take cannot both stream it. A lock older than fifteen
   * minutes belonged to a process that died mid-finish, and is replaced.
   *
   * @param {string} takeId
   * @returns {Promise<string>} the lock's path, to remove when done
   * @throws {Error} 409 when another process holds a fresh lock
   */
  async function acquireFinishLock(takeId) {
    const file = join(takeDir(takeId), LOCK_FILE);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(file, "wx");
        try {
          await handle.writeFile(String(millisNow()));
        } finally {
          await handle.close();
        }
        return file;
      } catch (error) {
        if (!error || error.code !== "EEXIST") throw error;
        const info = await stat(file).catch(() => null);
        if (info && millisNow() - info.mtimeMs < LOCK_STALE_MS) {
          throw conflict(`Take "${takeId}" is being finished by another process.`);
        }
        // A stale lock: the process that held it is gone.
        await unlink(file).catch(() => {});
      }
    }
    throw conflict(`Take "${takeId}" is being finished by another process.`);
  }

  /**
   * Finish one take: stream its WAV into storage, file it, and add it to the
   * song through the hub.
   *
   * One finish per take at a time: a second call for the same id while one is
   * running in this process awaits it and returns its result.
   *
   * @param {string} takeId
   * @param {{chunk_hashes: string[]}} request the SHA-256 of every chunk, in order
   * @returns {Promise<{take: object}>} the take now in the song
   */
  async function finish(takeId, request = {}) {
    requireTakeId(takeId);
    const hashes = Array.isArray(request?.chunk_hashes) ? request.chunk_hashes : null;
    if (!hashes) {
      throw badRequest("Finishing an upload needs the SHA-256 of every chunk, in order.");
    }

    const running = finishers.get(takeId);
    if (running) return running;

    const run = finishOnce(takeId, hashes).finally(() => finishers.delete(takeId));
    finishers.set(takeId, run);
    return run;
  }

  /**
   * The body of `finish`, run under the take's in-process entry and its lock.
   * @param {string} takeId
   * @param {string[]} hashes
   * @returns {Promise<{take: object}>}
   */
  async function finishOnce(takeId, hashes) {
    const staged = await readMeta(takeId);
    if (!staged) {
      throw notFound(`There is no upload in progress for take "${takeId}"; begin it before finishing it.`);
    }

    // The project is the song's, re-read now: a take begun in one project must
    // not land in storage after its song moved to another.
    const projectId = await songProjectOf(staged.song_id);
    const begunIn = Number(staged.project_id);
    if (projectId !== begunIn) {
      throw conflict(
        `Take "${takeId}" was begun in project ${begunIn}, but its song is in project ${projectId} now; the take is kept.`,
      );
    }
    await assertWrite(projectId);

    const lock = await acquireFinishLock(takeId);
    try {
      const meta = (await readMeta(takeId)) ?? staged;

      // A retried finish — after a timeout, a reload, or a gateway restart —
      // must not upload the same audio twice or apply `take.add` again. If the
      // song cannot be read, this throws and nothing is touched.
      const inSong = await songTakes(meta.song_id);
      if (inSong[takeId]) return { take: inSong[takeId] };
      if (meta.finished === true) {
        throw conflict(`Take "${takeId}" was finished, but it is no longer in the song.`);
      }

      const channelCount = Number(meta.channels);
      const frameBytes = channelCount * BYTES_PER_SAMPLE;
      const files = [];
      const missing = [];
      let totalBytes = 0;
      for (let index = 0; index < hashes.length; index += 1) {
        const file = chunkPath(takeId, index);
        const info = await stat(file).catch(() => null);
        if (!info) {
          missing.push(index);
          continue;
        }
        const recorded = await sha256File(file);
        const stated = String(hashes[index] ?? "").toLowerCase();
        if (recorded !== stated) {
          throw conflict(`Chunk ${index} does not match the SHA-256 the client sent; send that chunk again.`);
        }
        files.push(file);
        totalBytes += info.size;
      }
      if (missing.length > 0) {
        throw conflict(`Upload is missing chunks ${missing.join(", ")}; send them before finishing.`);
      }
      if (totalBytes === 0) {
        throw badRequest("An upload with no chunks cannot be finished.");
      }
      if (totalBytes % frameBytes !== 0) {
        throw badRequest(
          `The chunks do not add up to whole ${channelCount}-channel frames: ${totalBytes} bytes is not a multiple of ${frameBytes}.`,
        );
      }

      const frames = totalBytes / frameBytes;
      const samples = frames * channelCount;
      if (samples > sampleCap) {
        throw tooLarge(
          `A take can hold at most ${groupThousands(sampleCap)} samples (frames × channels); this one would hold ${groupThousands(samples)}.`,
        );
      }

      const bucket = typeof storage.defaultBucket === "function" ? storage.defaultBucket() : undefined;
      const prefix = await storagePrefixFor(db, projectId);
      const key = `${prefix}studio/${meta.song_id}/takes/${takeId}.wav`;
      const rate = Number(meta.rate);

      // The header and then the staged files, streamed: a 1200 s take is 346 MB,
      // and it must never have to fit in one buffer.
      const header = wavHeader(frames, channelCount, rate);
      const size = header.byteLength + totalBytes;

      await serializeUpload(async () => {
        const stats = await storage.getBucketStats(bucket);
        const used = Number(stats?.totalSizeBytes ?? 0);
        // The incoming take counts: the project must still fit after it.
        if (used + size > quotaBytes) {
          throw outOfQuota(`Storage quota exceeded (${quotaText} MB). Delete files to free space.`);
        }
        const stream = Readable.from(wavPieces(header, files), { objectMode: false });
        await storage.putObjectStream(key, stream, size, { bucket, contentType: "audio/wav" });

        try {
          // The key is fixed per take, so a row a crashed attempt left behind is
          // this take's own row: keep it and carry on.
          await db.execute({
            sql: `INSERT INTO storage_files (s3_key, original_name, mime_type, size_bytes, bucket, reference_type, reference_id, project_id)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(s3_key) DO NOTHING`,
            args: [
              key,
              `${takeId}.wav`,
              "audio/wav",
              size,
              bucket,
              REFERENCE_TYPE,
              meta.song_id,
              projectId,
            ],
          });
        } catch (error) {
          // A row that never landed must not leave an untracked object behind —
          // but only once a re-read says the song does not point at it.
          const afterInsert = await songTakes(meta.song_id);
          if (!afterInsert[takeId]) await deleteObjectQuietly(storage, key, bucket);
          throw error;
        }
      });

      const take = {
        id: takeId,
        clip_id: meta.clip_id,
        storage_key: key,
        rate,
        channels: channelCount,
        frames,
        offset_frames: Number(meta.offset_frames ?? 0),
        compensated: meta.compensated === true,
        bpm: Number(meta.bpm),
        recorded_at: typeof meta.recorded_at === "string" ? meta.recorded_at : nowIso(),
        author_label: authorLabelOf(meta.author),
        discarded: false,
      };

      // `internal: true`: only the gateway's own finish route may issue
      // `take.add`, and no caller gets to name the storage key.
      const applied = await hub.runCommand({
        song_id: meta.song_id,
        cmd_id: takeId,
        command: "take.add",
        args: { clip_id: meta.clip_id, take },
        author: meta.author,
        internal: true,
      });

      // Whatever the hub said, the song is the judge; a re-read is the only
      // answer a cleanup may act on.
      const afterAdd = await songTakes(meta.song_id);
      const confirmed = afterAdd[takeId] ?? null;

      if (!applied || applied.ok !== true) {
        if (confirmed) {
          // The refusal is a replay of a step an earlier attempt applied and
          // never got to clean up after: the take is in the song, so complete
          // it. The earlier attempt wrote the audit line.
          return await completeFinish(takeId, meta, confirmed, { frames, key, chunks: hashes.length });
        }
        // The song does not point at the take, so the object and its row may go.
        // The staged audio is the only copy of the recording: it stays, so the
        // next finish can try again.
        await deleteObjectQuietly(storage, key, bucket);
        await deleteRowQuietly(db, key);
        throw withStatus(String(applied?.error ?? "The song refused that take."), statusForCode(applied?.code));
      }

      if (!confirmed) {
        // Applied, but the song does not show it: deleting anything now could
        // lose the take, so everything stays for a later finish.
        throw conflict(
          `Take "${takeId}" was applied, but the song does not show it; the take is kept and will finish later.`,
        );
      }

      await acl.appendAudit(db, {
        project_id: projectId,
        ...auditActor(meta.author),
        action: AUDIT_ACTION,
        target: `song:${meta.song_id}`,
        payload: {
          take_id: takeId,
          clip_id: meta.clip_id,
          storage_key: key,
          seconds: Math.round((frames / rate) * 1000) / 1000,
        },
      });

      return await completeFinish(takeId, meta, confirmed, { frames, key, chunks: hashes.length });
    } finally {
      await unlink(lock).catch(() => {});
    }
  }

  /**
   * Close out a take the song has confirmed: mark its meta finished (so a
   * retried finish can find its song) and only then drop the staged audio.
   * @param {string} takeId
   * @param {object} meta
   * @param {object} songTake the take as the song holds it
   * @param {{frames: number, key: string, chunks: number}} finished
   * @returns {Promise<{take: object}>}
   */
  async function completeFinish(takeId, meta, songTake, { frames, key, chunks }) {
    await writeMeta(takeId, { ...meta, finished: true, frames, storage_key: key, finished_at: nowIso() });
    await dropChunks(takeId, chunks);
    return { take: songTake };
  }

  /**
   * Drop every staged chunk of a finished take: the audio now lives in storage,
   * and a second copy on the gateway's disk is only a leak.
   * @param {string} takeId
   * @param {number} [count] how many chunks to unlink (every staged one when
   *   the count is not known)
   * @returns {Promise<void>}
   */
  async function dropChunks(takeId, count) {
    const dir = takeDir(takeId);
    const names = await readdir(dir).catch(() => []);
    const indexes = [];
    for (const name of names) {
      const match = /^(\d{6})\.pcm$/.exec(name);
      if (match) indexes.push(Number(match[1]));
    }
    const last = Number.isInteger(count) ? count - 1 : Math.max(-1, ...indexes);
    for (let index = 0; index <= last; index += 1) {
      await unlink(chunkPath(takeId, index)).catch(() => {});
      await unlink(hashPath(takeId, index)).catch(() => {});
    }
    // A process killed between a temporary write and its link leaves the
    // temporary behind; the chunks above are the audio, these are litter.
    for (const name of await readdir(dir).catch(() => [])) {
      if (/^\.(tmp|sha)-/.test(name)) await unlink(join(dir, name)).catch(() => {});
    }
  }

  /**
   * Remove staging nobody finished: a take older than the window is one the
   * client never came back for (the panel re-begins and re-sends from its own
   * IndexedDB copy when that happens).
   * @param {number} [olderThanMs] how old counts as abandoned (7 days)
   * @returns {Promise<number>} how many staging directories were removed
   */
  async function sweepStale(olderThanMs = STALE_MS) {
    const window = Number.isFinite(Number(olderThanMs)) ? Number(olderThanMs) : STALE_MS;
    const cutoff = millisNow() - window;
    const entries = await readdir(stagingDir, { withFileTypes: true }).catch(() => []);
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = join(stagingDir, entry.name);
      const when = await touchedAt(dir);
      if (when === null || when > cutoff) continue;
      try {
        await rm(dir, { recursive: true, force: true });
        removed += 1;
      } catch {
        /* try again on the next sweep */
      }
    }
    return removed;
  }

  /**
   * When a staging directory was last written: its meta's own time, or the
   * directory's when it never got a meta.
   * @param {string} dir
   * @returns {Promise<number|null>} milliseconds, or null when it is gone
   */
  async function touchedAt(dir) {
    const meta = await stat(join(dir, META_FILE)).catch(() => null);
    if (meta) return meta.mtimeMs;
    const self = await stat(dir).catch(() => null);
    return self ? self.mtimeMs : null;
  }

  return { begin, putChunk, status, finish, sweepStale };
}

/** @returns {number} the HTTP status a hub refusal's code maps to. */
function statusForCode(code) {
  switch (code) {
    case "acl":
    case "human_only":
    case "studio_only":
      return 403;
    case "not_found":
      return 404;
    case "limit":
      return 413;
    case "invalid":
      return 400;
    default:
      return 409;
  }
}

/**
 * Delete one object and swallow a failure: the caller has a worse error to
 * report, and an orphan object is the lesser problem.
 * @param {object} storage
 * @param {string} key
 * @param {string|undefined} bucket
 * @returns {Promise<void>}
 */
async function deleteObjectQuietly(storage, key, bucket) {
  try {
    await storage.deleteObject(key, bucket);
  } catch {
    /* the caller's error is the one that matters */
  }
}

/**
 * Delete the `storage_files` row of a take the song does not reference.
 * @param {object} db
 * @param {string} key
 * @returns {Promise<void>}
 */
async function deleteRowQuietly(db, key) {
  try {
    await db.execute({
      sql: "DELETE FROM storage_files WHERE s3_key = ? AND reference_type = 'studio_take'",
      args: [key],
    });
  } catch {
    /* the caller's error is the one that matters */
  }
}

/**
 * The pieces of a take's WAV, in order: the header, then each chunk file.
 * @param {Buffer} header
 * @param {string[]} files the chunk files, in index order
 * @returns {AsyncGenerator<Buffer>}
 */
async function* wavPieces(header, files) {
  yield header;
  for (const file of files) {
    for await (const piece of createReadStream(file)) yield piece;
  }
}