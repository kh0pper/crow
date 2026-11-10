/**
 * Take and sample uploads — staging on disk, the streamed WAV, and the internal
 * `take.add` / `sample.add`.
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
 * ## Five kinds of upload, one pipeline
 *
 * `begin` takes a `kind`, and everything downstream follows it:
 *
 *   take    belongs to one clip (`clip_id`), is filed under
 *           `${prefix}studio/<song_id>/takes/<id>.wav` with the reference type
 *           `studio_take`, and `finish` issues `take.add`.
 *   sample  belongs to the song, carries a `name`, an `origin` ("import",
 *           "record" or "resample") and optionally a target pad
 *           (`{track_id, bank_id, index}`), is filed under
 *           `${prefix}studio/<song_id>/samples/<id>.wav` with the reference type
 *           `studio_sample`, and `finish` issues `sample.add` — then, if it named
 *           a pad, `pad.assign_if_empty` as the same author with `cmd_id`
 *           `<id>:assign`. That command is Studio's own (`internal: true`) and
 *           it is the one that decides whether the pad is still free, inside
 *           the hub's per-song queue: a pad the operator filled or cleared
 *           while the upload ran is theirs, and the sample simply stays in the
 *           song (`pad_assign` "skipped"). Both commands are idempotent by
 *           `cmd_id`.
 *           A sample is capped at 60 s of 48 kHz stereo (5,760,000 samples,
 *           frames × channels) and a song may have 128 of them uploading at
 *           once; a take keeps 1b's cap and its 32.
 *   font    is a SoundFont bank the operator brought themselves (plan 1d,
 *           Task 4). It belongs to the song's library, is filed under
 *           `${prefix}studio/<song_id>/library/<library_id>.<ext>` with the
 *           reference type `studio_library`, and `finish` issues `library.add`
 *           as Studio itself (`cmd_id` `<upload_id>:library:<begin nonce>`). A bank is not
 *           PCM: its bytes are the file itself, stored exactly as they arrived
 *           — no WAV header, no rate, channels or frames. The server checks
 *           only its size and its magic bytes (`RIFF`…`sfbk` over the first
 *           twelve) at begin, from the `head` the client declares, and again at
 *           finish, from chunk 0; it never parses a bank. A song may have 8
 *           bank uploads in progress at once, and a bank is at most 512 MB.
 *   nam     is an amp capture: a `.nam` file, stored byte for byte like a bank
 *           (Task 12). It belongs to the library the same way, under
 *           `<library_id>.nam`, and `finish` issues `library.add` with kind
 *           "nam". The server never JSON-parses it either. It checks the head
 *           the client declares at begin, and the stored file's first 4096
 *           bytes again at finish — read across the chunks, because a chunk
 *           boundary is not a file boundary — for the one shape Studio plays: a
 *           JSON object with a top-level `architecture` of "SlimmableContainer"
 *           (a NAM A2 capture), and — at finish, over the whole staged file,
 *           streaming — a `"weights"` key. Another architecture is the plan's
 *           re-export sentence; anything else is "not a NAM capture". **This
 *           check is advisory**: it is a shallow look at the front of a file
 *           that may be hostile, never a parse, and the worklet is the real
 *           parser — it must cope with a `.nam` this check lets through. A
 *           capture is at most 20 MB, and a song may have 8 captures uploading.
 *           A cabinet's entry carries the size of the WAV that was STORED
 *           (header and PCM), not just the PCM: its `sha256` is measured over
 *           that same stored object.
 *   ir      is a cabinet impulse response: decoded in the BROWSER, like a
 *           sample, and stored as the 24-bit WAV this file frames at finish
 *           (Task 12) — `<library_id>.wav` under the same `library/`
 *           directory, reference type `studio_library`, `library.add` with kind
 *           "ir". It is at most 1 second long (frames ≤ the declared rate plus
 *           the two-frame tolerance every check shares, so a 44.1 kHz cabinet
 *           of 44101 frames loads) and 10 MB, and a song may have 16 cabinet
 *           uploads in progress at once. The server's own `decodeAudioData` is
 *           never used: it only ever sees the PCM the page decoded.
 *
 * ## One upload id belongs to one kind
 *
 * An id names one upload for good, so an id whose finished meta is a take is
 * not a new sample's (or the other way round): `begin` refuses it with a
 * conflict that names the kind already there.
 *
 * ## A sample's pad outcome is recorded before the finish answers
 *
 * Whether the sample reached its pad (`"done"`) or the pad was left as the
 * operator had it (`"skipped"`) is written into the staged meta *before* the
 * finish returns, and a retried finish answers with what that record says. So a
 * retried finish never assigns again: a pad the operator cleared or re-filled
 * in between stays exactly as they left it.
 *
 * Everything the take rules protect — the staging directory as the only copy of
 * a recording, fail-closed snapshot reads, one finish at a time, never deleting
 * an object a re-read says the song holds — applies to both kinds unchanged.
 *
 * ## No app modules
 *
 * This file imports nothing from `servers/…`. The database, the storage client,
 * the project ACL, the hub and the song lookup arrive injected, so the same code
 * runs in the gateway, in a test with fakes, and anywhere else the bundle is
 * installed.
 *
 * Errors that have an HTTP meaning carry `error.status` for the routes: 400 for
 * an invalid request, 403 for a refusal from the ACL, 404 for an unknown upload
 * or song, 409 for a conflict (a different chunk, a different meta, a missing
 * chunk, an upload another process is finishing), 413 past a limit, 503 when
 * the song cannot be read, 507 when the project is out of storage quota.
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

/**
 * The sample rates an upload may declare (spec §18). The cabinet IR uses the same
 * four: the plan's `SAMPLE_RATES`, because the page decoded it at one of them.
 */
const TAKE_RATES = Object.freeze([44100, 48000, 88200, 96000]);

/** How many channels a recording may have. */
const MAX_CHANNELS = 2;

/**
 * How many un-finished uploads one song may have at a time, by kind. A take is
 * a long recording and 32 is plenty; an import session can queue many short
 * hits at once, so a sample gets its own, larger cap; a bank or a capture is a
 * big file the operator brings by hand, so 8 of them at once is plenty; and a
 * cabinet is a short file the operator may be auditioning a set of, so it gets
 * 16.
 * @type {Readonly<Object<string, number>>}
 */
const MAX_OPEN_BY_KIND = Object.freeze({ take: 32, sample: 128, font: 8, nam: 8, ir: 16 });

/** The kinds of upload this service stages. */
const UPLOAD_KINDS = Object.freeze(["take", "sample", "font", "nam", "ir"]);

/** The `storage_files.reference_type` each kind is filed under. */
const REFERENCE_TYPES = Object.freeze({
  take: "studio_take",
  sample: "studio_sample",
  font: "studio_library",
  nam: "studio_library",
  ir: "studio_library",
});

/**
 * What became of a sample's pad: the sample is on it, or the pad was left as
 * the operator had it. Recorded in the meta before the finish answers.
 * @type {Readonly<Object<string, string>>}
 */
const PAD_ASSIGN = Object.freeze({ done: "done", skipped: "skipped" });

/** The audit action a finished upload of each kind is recorded with. */
const AUDIT_ACTIONS = Object.freeze({
  take: "studio.take",
  sample: "studio.sample",
  font: "studio.library",
  nam: "studio.library",
  ir: "studio.library",
});

/** The directory of `studio/<song_id>/` each kind's file lives in. */
const KEY_DIRS = Object.freeze({ take: "takes", sample: "samples", font: "library", nam: "library", ir: "library" });

/** The file extensions a SoundFont bank may have (plan 1d, Formats). */
const BANK_EXTENSIONS = Object.freeze(["sf2", "sf3"]);

/** The largest bank the operator may bring: 512 MB (plan 1d, Limits). */
const BANK_MAX_BYTES = 536870912;

/** How many of a bank's first bytes the server checks its magic in. */
const BANK_HEAD_BYTES = 12;

/** What a file whose name says it is not a bank is told. */
const BANK_TYPE_TEXT = "Studio takes SF2 and SF3 banks.";

/** What a file whose first bytes are not a bank is told. */
const NOT_A_BANK_TEXT = "That file is not an SF2 or SF3 bank.";

/** The extension a capture is stored under: `.nam`, whatever the file was called. */
const CAPTURE_EXTENSION = "nam";

/** The largest capture the operator may bring: 20 MB (plan 1d, Limits). */
const CAPTURE_MAX_BYTES = 20971520;

/** How many of a capture's first bytes the server recognises its shape in. */
const CAPTURE_HEAD_BYTES = 4096;

/** The NAM architecture Studio plays: an A2 model (plan 1d, Formats). */
const CAPTURE_ARCHITECTURE = "SlimmableContainer";

/** The top-level key a capture declares its architecture in. */
const CAPTURE_ARCHITECTURE_KEY = "architecture";

/** What a file that is not shaped like a NAM capture is told. */
const NOT_A_CAPTURE_TEXT = "This file is not a NAM capture.";

/**
 * What an older NAM model is told: the plan's sentence, word for word. Studio
 * plays A2 captures only, and says how to get one.
 */
const LEGACY_CAPTURE_TEXT =
  "This capture uses an older NAM format; Studio plays A2 captures. Re-export it with a current NAM trainer.";

/** The largest cabinet IR: 10 MB (plan 1d, Limits). */
const IR_MAX_BYTES = 10485760;

/** The longest cabinet IR: 1 second, after the page has resampled it. */
const IR_MAX_SECONDS = 1;

/**
 * How many frames past the declared rate a cabinet may run and still be one
 * second long: two, everywhere the limit is checked (this route, the page and
 * the engine). A 44.1 kHz IR that is exactly one second long is 44101 frames.
 */
const IR_FRAME_TOLERANCE = 2;
/** Frames past one second a cabinet may run at `rate` (engine/convolver.js's rule). */
function irToleranceAt(rate) {
  return Math.max(IR_FRAME_TOLERANCE, Math.ceil((3 * Number(rate)) / 44100));
}

/** The extension a cabinet is stored under: the WAV the sample path writes. */
const IR_EXTENSION = "wav";

/** Bytes in one megabyte, the unit a bank's size refusal is stated in. */
const MB_BYTES = 1024 * 1024;

/** The longest file name a bank upload may carry (it is only kept for its ext). */
const MAX_FILE_NAME = 260;

/** The most samples (frames × channels) one sample may hold: 60 s, 48 kHz stereo. */
const SAMPLE_MAX_SAMPLES = 5760000;

/** The length the sample cap is stated in, for the refusal's own words. */
const SAMPLE_MAX_SECONDS = 60;

/** How a sample came to be in the song, as `sample.add` accepts it. */
const SAMPLE_ORIGINS = Object.freeze(["import", "record", "resample"]);

/** The longest name a sample may carry (the `sample.add` schema's limit). */
const MAX_NAME = 80;

/** The most pads one bank holds, so a target pad is in range. */
const MAX_PADS = 16;

/** The default cap of one take: 1200 s of 48 kHz stereo. */
const DEFAULT_MAX_TAKE_SECONDS = 1200;

/** The rate the sample cap is stated at (48 kHz, the take format's rate). */
const CAP_RATE = 48000;

/** The channel count the sample cap is stated at (stereo). */
const CAP_CHANNELS = 2;

/** Bytes in one 24-bit sample. */
const BYTES_PER_SAMPLE = 3;

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

/**
 * What a caller is told when the song cannot be read mid-finish: the upload's
 * own kind names what is being kept.
 * @param {string} kind the upload's kind
 * @returns {string}
 */
function songUnreadable(kind) {
  return `Studio could not read the song; the ${kindNoun(kind)} is kept and will finish later.`;
}

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

/**
 * The kind of an upload, refusing anything else by name.
 * @param {unknown} value
 * @returns {"take"|"sample"|"font"|"nam"|"ir"}
 */
function uploadKind(value) {
  if (value === undefined || value === null || value === "") return "take";
  if (value === "take" || value === "sample" || value === "font") return value;
  if (value === "nam" || value === "ir") return value;
  throw badRequest(`An upload is a ${UPLOAD_KINDS.join(" or ")}, not "${String(value)}".`);
}

/**
 * The kind a staged meta belongs to. A meta written before samples existed has
 * none, and is a take.
 * @param {object|null|undefined} meta
 * @returns {"take"|"sample"|"font"|"nam"|"ir"}
 */
function kindOf(meta) {
  const kind = meta?.kind;
  if (kind === "sample" || kind === "font" || kind === "nam" || kind === "ir") return kind;
  return "take";
}

/**
 * Whether a kind's bytes are the file itself, stored exactly as they arrived —
 * no PCM, no rate, no channels and no WAV header. A bank and a capture are.
 * @param {string} kind
 * @returns {boolean}
 */
function isFileKind(kind) {
  return kind === "font" || kind === "nam";
}

/**
 * Whether a kind's finished object is an entry in the song's library, which is
 * what `library.add` is issued for and where the upload's id becomes the
 * entry's.
 * @param {string} kind
 * @returns {boolean}
 */
function isLibraryKind(kind) {
  return kind === "font" || kind === "nam" || kind === "ir";
}

/** @returns {string} "take", "sample", "bank", "capture" or "cabinet", for a refusal's own words. */
function kindNoun(kind) {
  if (kind === "sample") return "sample";
  if (kind === "font") return "bank";
  if (kind === "nam") return "capture";
  if (kind === "ir") return "cabinet";
  return "take";
}

/**
 * Whether a staged meta already records what became of a sample's pad. A retried
 * finish answers with that record and never assigns again.
 * @param {object|null|undefined} meta
 * @returns {boolean}
 */
function isPadAssignRecorded(meta) {
  return meta?.pad_assign === PAD_ASSIGN.done || meta?.pad_assign === PAD_ASSIGN.skipped;
}

/** @returns {string} "Take", "Sample", "Bank", "Capture" or "Cabinet", for a sentence's first word. */
function kindName(kind) {
  if (kind === "sample") return "Sample";
  if (kind === "font") return "Bank";
  if (kind === "nam") return "Capture";
  if (kind === "ir") return "Cabinet";
  return "Take";
}

/**
 * The library entry a bank upload's finish adds, named for its upload: `lib-`
 * plus the upload's uuid is 40 characters, the library id rule's own limit
 * (see `commands/library.js`).
 * @param {string} uploadId
 * @returns {string}
 */
function libraryIdOf(uploadId) {
  return `lib-${uploadId}`.slice(0, 40);
}

/**
 * The id one upload's finished object is held under: a take's and a sample's is
 * the upload's own, and a library file's — a bank, a capture or a cabinet — is
 * the library entry's.
 * @param {string} kind
 * @param {string} uploadId
 * @returns {string}
 */
function objectIdOf(kind, uploadId) {
  return isLibraryKind(kind) ? libraryIdOf(uploadId) : uploadId;
}

/**
 * The most samples (frames × channels) one upload of a kind may hold. A cabinet
 * is capped by its length instead: one second at the rate the page declared,
 * which is `rate × channels` samples.
 * @param {string} kind
 * @param {number} takeCap the service's take cap
 * @param {object|null} [meta] the staged meta, which says a cabinet's rate
 * @returns {number}
 */
function uploadCap(kind, takeCap, meta = null) {
  if (kind === "sample") return SAMPLE_MAX_SAMPLES;
  if (kind === "ir") {
    const rate = Number(meta?.rate);
    const channels = Number(meta?.channels);
    const usable = Number.isInteger(rate) && rate > 0 && Number.isInteger(channels) && channels > 0;
    // A meta with no readable rate can hold nothing: the refusal that follows
    // names the length, and 0 compared against it always refuses.
    //
    // A cabinet is capped by its LENGTH, with the same two-frame tolerance the
    // length check takes: a 44.1 kHz cabinet of 44101 frames is one second's
    // worth, not a file over the cap.
    return usable ? (rate + irToleranceAt(rate)) * channels : 0;
  }
  return takeCap;
}

/**
 * A length in seconds, with one decimal: "2.0".
 * @param {number} seconds
 * @returns {string}
 */
function secondsText(seconds) {
  return (Math.round(seconds * 10) / 10).toFixed(1);
}

/**
 * The plan's own sentence for a cabinet longer than one second.
 * @param {number} frames
 * @param {number} rate
 * @returns {Error} 413
 */
function irLengthRefusal(frames, rate) {
  return tooLarge(
    `An impulse response is at most ${IR_MAX_SECONDS} second long; this one is ${secondsText(frames / rate)} s.`,
  );
}

/**
 * The refusal for an upload of a kind that would hold too many samples. Every
 * limit is named in the words the spec states it in.
 * @param {string} kind the upload's kind
 * @param {number} actual how many samples (frames × channels) it would hold
 * @param {number} takeCap the service's take cap
 * @param {object|null} [meta] the staged meta, which says a cabinet's rate
 * @returns {Error} 413
 */
function capRefusal(kind, actual, takeCap, meta = null) {
  const cap = uploadCap(kind, takeCap, meta);
  if (kind === "sample") {
    return tooLarge(
      `A sample can be at most ${SAMPLE_MAX_SECONDS} s (${groupThousands(cap)} samples at 48 kHz stereo); this one would hold ${groupThousands(actual)}.`,
    );
  }
  if (kind === "ir") {
    const rate = Number(meta?.rate);
    const channels = Number(meta?.channels);
    const frames = channels > 0 ? Math.ceil(actual / channels) : 0;
    return irLengthRefusal(frames, rate > 0 ? rate : 1);
  }
  return tooLarge(
    `A take can hold at most ${groupThousands(cap)} samples (frames × channels); this one would hold ${groupThousands(actual)}.`,
  );
}

/**
 * Whether a bank's first bytes say it is a SoundFont: `RIFF`, four bytes, then
 * `sfbk`. This is the only part of a bank the server ever looks at.
 * @param {Buffer|Uint8Array|null|undefined} bytes
 * @returns {boolean}
 */
function isBankHead(bytes) {
  if (!bytes || bytes.length < BANK_HEAD_BYTES) return false;
  const head = Buffer.from(bytes.subarray(0, BANK_HEAD_BYTES));
  return head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "sfbk";
}

/**
 * The first twelve bytes a bank upload declares at `begin`, refusing a file that
 * does not begin like a bank.
 * @param {unknown} value the base64 of the file's first bytes
 * @returns {Buffer}
 */
function bankHeadOf(value) {
  const bytes = typeof value === "string" ? Buffer.from(value, "base64") : Buffer.alloc(0);
  if (!isBankHead(bytes)) throw badRequest(NOT_A_BANK_TEXT);
  return bytes.subarray(0, BANK_HEAD_BYTES);
}

/**
 * The extension of a bank's declared file name: `sf2` or `sf3`, whatever case
 * the name was written in.
 * @param {unknown} fileName
 * @returns {string}
 */
function bankExtensionOf(fileName) {
  const match = /\.([A-Za-z0-9]+)\s*$/.exec(typeof fileName === "string" ? fileName : "");
  const ext = match ? match[1].toLowerCase() : "";
  if (!BANK_EXTENSIONS.includes(ext)) throw badRequest(BANK_TYPE_TEXT);
  return ext;
}

/**
 * The details a bank upload declares at `begin`: the library entry's name, the
 * file's own name (for its extension), its size, and its first twelve bytes.
 * @param {object} body the begin request
 * @returns {{name: string, file_name: string, ext: string, bytes: number}}
 */
function bankUploadOf(body) {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name === "" || name.length > MAX_NAME) {
    throw badRequest(`A bank upload needs a name of 1-${MAX_NAME} characters.`);
  }
  const fileName = typeof body.file_name === "string" ? body.file_name.trim().slice(0, MAX_FILE_NAME) : "";
  // The extension comes from the name, and is checked before the size: a file
  // Studio cannot play is refused whatever its size.
  const ext = bankExtensionOf(fileName);
  const declared = Number(body.bytes);
  if (!Number.isInteger(declared) || declared <= 0) {
    throw badRequest("A bank upload needs the file's size in bytes.");
  }
  if (declared > BANK_MAX_BYTES) {
    throw tooLarge(`That bank is ${Math.ceil(declared / MB_BYTES)} MB; Studio takes banks up to 512 MB.`);
  }
  bankHeadOf(body.head);
  return { name, file_name: fileName, ext, bytes: declared };
}

/**
 * The extension a staged bank's file is stored under, from the meta `begin`
 * wrote (its file name is the fallback, for a meta that predates `ext`).
 * @param {object} meta
 * @returns {string}
 */
function bankExtOf(meta) {
  if (BANK_EXTENSIONS.includes(meta?.ext)) return meta.ext;
  return bankExtensionOf(meta?.file_name);
}

/**
 * What is wrong with a file that is meant to be a NAM capture, judged from the
 * front of it alone: after optional whitespace the first byte is `{`, the text
 * holds a TOP-LEVEL `"architecture"` key, and that key's string value is the
 * architecture Studio plays.
 *
 * Another architecture value is the plan's re-export sentence — a legacy model
 * is a real capture Studio does not play, and telling the operator to find a
 * current trainer is the useful answer. Anything else (not an object, no
 * top-level `architecture` key, a value that is not a string) is not a capture
 * at all.
 *
 * The file is never parsed: this scans the front of it as text. The check is
 * advisory — the worklet is the real parser, and it must cope with whatever a
 * hostile `.nam` puts in the bytes this look waves through.
 * @param {Buffer|Uint8Array|null|undefined} bytes
 * @returns {string|null} the refusal's message, or null when it is shaped right
 */
function captureProblemOf(bytes) {
  if (!bytes || bytes.length === 0) return NOT_A_CAPTURE_TEXT;
  const text = Buffer.from(bytes.subarray(0, CAPTURE_HEAD_BYTES)).toString("latin1");
  if (!/^\s*\{/.test(text)) return NOT_A_CAPTURE_TEXT;
  const value = topLevelArchitecture(text);
  if (value === null) return NOT_A_CAPTURE_TEXT;
  return value === CAPTURE_ARCHITECTURE ? null : LEGACY_CAPTURE_TEXT;
}

/**
 * The `architecture` value a capture's front declares as a key of its outermost
 * object, or null when the head holds none.
 *
 * A plain search for the key would take a nested `architecture` — one inside a
 * `config` or a `model` object, which a hostile file can write — for the shape
 * Studio plays, so the head is walked by a small scanner instead: brace depth is
 * counted, and braces, quotes and colons inside a string literal are skipped
 * whole. Only a string key at depth 1, followed by `:`, is a candidate; its
 * value must itself be a string that is complete inside the head.
 *
 * Nothing here is `JSON.parse`: the file may be hundreds of megabytes and the
 * only bytes looked at are the ones in the head.
 * @param {string} text the head, as latin1 text
 * @returns {string|null} the value, or null when there is none to read
 */
function topLevelArchitecture(text) {
  let depth = 0;
  let index = 0;
  while (index < text.length) {
    const ch = text[index];
    if (ch === "{") {
      depth += 1;
      index += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      index += 1;
      // The outermost object has closed: a key after it is not its field.
      if (depth <= 0) return null;
      continue;
    }
    if (ch !== '"') {
      index += 1;
      continue;
    }
    const token = readJsonStringToken(text, index);
    // An unterminated string runs past the head, so nothing after it can be read.
    if (!token) return null;
    index = token.end;
    let after = index;
    while (after < text.length && isJsonSpace(text[after])) after += 1;
    // Only a key of the outermost object is the shape's own `architecture`:
    // a string that is a VALUE, or a key one level down, is not.
    if (depth !== 1 || text[after] !== ":") continue;
    let key;
    try {
      key = JSON.parse(token.literal);
    } catch {
      continue;
    }
    if (key !== CAPTURE_ARCHITECTURE_KEY) continue;
    let valueAt = after + 1;
    while (valueAt < text.length && isJsonSpace(text[valueAt])) valueAt += 1;
    if (text[valueAt] !== '"') return null;
    const valueToken = readJsonStringToken(text, valueAt);
    if (!valueToken) return null;
    try {
      const value = JSON.parse(valueToken.literal);
      return typeof value === "string" ? value : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * One JSON string literal at `start`, with its escapes left as written so
 * `JSON.parse` can decode it. Null when the closing quote is past the end.
 * @param {string} text
 * @param {number} start the index of the opening quote
 * @returns {{literal: string, end: number}|null}
 */
function readJsonStringToken(text, start) {
  let index = start + 1;
  while (index < text.length) {
    const ch = text[index];
    if (ch === "\\") {
      // Skip the escaped character whatever it is, a quote included.
      index += 2;
      continue;
    }
    if (ch === '"') {
      return { literal: text.slice(start, index + 1), end: index + 1 };
    }
    index += 1;
  }
  return null;
}

/** @returns {boolean} whether a character is whitespace JSON allows between tokens. */
function isJsonSpace(ch) {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

/**
 * The head a capture upload declares at `begin`, refusing a file Studio cannot
 * play before a byte of it is staged.
 * @param {unknown} value the base64 of the file's first bytes (at most 4096)
 * @returns {Buffer}
 */
function captureHeadOf(value) {
  const bytes = typeof value === "string" ? Buffer.from(value, "base64") : Buffer.alloc(0);
  const problem = captureProblemOf(bytes);
  if (problem) throw badRequest(problem);
  return bytes.subarray(0, CAPTURE_HEAD_BYTES);
}

/**
 * The details a capture upload declares at `begin`: what the library entry is
 * called and how big the file is. A capture has no extension of its own to
 * choose — it is stored as `.nam` — so the file's name is not kept.
 * @param {object} body the begin request
 * @returns {{name: string, bytes: number}}
 */
function captureUploadOf(body) {
  const name = fileUploadNameOf(body.name, "nam");
  const declared = Number(body.bytes);
  if (!Number.isInteger(declared) || declared <= 0) {
    throw badRequest("A capture upload needs the file's size in bytes.");
  }
  if (declared > CAPTURE_MAX_BYTES) {
    throw tooLarge(
      `That capture is ${Math.ceil(declared / MB_BYTES)} MB; Studio takes captures up to 20 MB.`,
    );
  }
  captureHeadOf(body.head);
  return { name, bytes: declared };
}

/**
 * Whether a staged capture holds a `"weights"` key anywhere, read by streaming
 * the bytes once and never parsing them.
 *
 * The capture's own JSON can be hundreds of megabytes of weights, so the file
 * is never held whole and never given to `JSON.parse`. A small overlap between
 * reads keeps a key that straddles two of them visible.
 * @param {string[]} files the chunk files, in index order
 * @returns {Promise<boolean>}
 */
async function captureHasWeights(files) {
  const pattern = /"weights"\s*:/;
  let tail = "";
  for (const file of files) {
    for await (const piece of createReadStream(file)) {
      const text = tail + piece.toString("latin1");
      if (pattern.test(text)) return true;
      tail = text.slice(-64);
    }
  }
  return false;
}

/**
 * Check a finished capture without parsing it: the size it declared at `begin`,
 * the head again (the same check `begin` made, now from the bytes that actually
 * arrived), and a `"weights"` key somewhere in the file.
 *
 * The head is read ACROSS the staged chunks: a chunk boundary is the client's,
 * not the file's, so a first chunk of a handful of bytes must not hide the head
 * that follows it.
 *
 * Called before anything is stored, so a file that fails any of the three leaves
 * nothing behind.
 * @param {string} takeId
 * @param {object} meta the staged meta
 * @param {string[]} files the chunk files, in index order
 * @param {number} totalBytes the bytes the chunks add up to
 * @returns {Promise<void>}
 */
async function assertCaptureFinish(takeId, meta, files, totalBytes) {
  const declared = Number(meta.bytes);
  if (!Number.isInteger(declared) || declared <= 0) {
    throw conflict(`Capture "${takeId}" has no readable size; begin it again.`);
  }
  if (totalBytes !== declared) {
    throw conflict(
      `Capture "${takeId}" was declared ${groupThousands(declared)} bytes, but its chunks add up to ${groupThousands(totalBytes)}.`,
    );
  }
  const problem = captureProblemOf(await headBytesOf(files, CAPTURE_HEAD_BYTES));
  if (problem) throw badRequest(problem);
  if (!(await captureHasWeights(files))) throw badRequest(NOT_A_CAPTURE_TEXT);
}

/**
 * The name a library upload carries (a capture's or a cabinet's), which
 * `library.add` shows and the picker lists.
 * @param {unknown} value
 * @param {string} kind the upload's kind, for the refusal's own words
 * @returns {string}
 */
function fileUploadNameOf(value, kind) {
  const name = typeof value === "string" ? value.trim().slice(0, MAX_NAME) : "";
  if (name === "") throw badRequest(`A ${kindNoun(kind)} upload needs a name of 1-${MAX_NAME} characters.`);
  return name;
}

/**
 * The details a cabinet upload declares at `begin`: its name, and the rate,
 * channels and frames the page decoded it to. A cabinet is PCM like a sample —
 * the page decodes it, this server never does — so its length is checked here,
 * before a byte is staged, and again at finish from the bytes that arrived.
 * @param {object} body the begin request
 * @param {number} rate the declared rate, already checked against the four
 * @param {number} channels the declared channel count, already 1 or 2
 * @returns {{name: string, frames: number}}
 */
function irUploadOf(body, rate, channels) {
  const name = fileUploadNameOf(body.name, "ir");
  const frames = Number(body.frames);
  if (!Number.isInteger(frames) || frames <= 0) {
    throw badRequest("A cabinet upload needs the number of frames it holds.");
  }
  if (frames > rate + irToleranceAt(rate)) throw irLengthRefusal(frames, rate);
  const bytes = frames * channels * BYTES_PER_SAMPLE;
  if (bytes > IR_MAX_BYTES) {
    throw tooLarge(`That cabinet is ${Math.ceil(bytes / MB_BYTES)} MB; Studio takes cabinets up to 10 MB.`);
  }
  if (body.bytes !== undefined) {
    const declared = Number(body.bytes);
    if (!Number.isInteger(declared) || declared <= 0) {
      throw badRequest("A cabinet upload's size is a whole number of bytes.");
    }
    if (declared > IR_MAX_BYTES) {
      throw tooLarge(`That cabinet is ${Math.ceil(declared / MB_BYTES)} MB; Studio takes cabinets up to 10 MB.`);
    }
  }
  return { name, frames };
}

/**
 * The refusal for a chunk that would take a file-kind upload past the size it
 * declared.
 * @param {string} kind the upload's kind
 * @param {number} declared the declared size, in bytes
 * @param {number} staged what is already staged, in bytes
 * @param {number} incoming the refusing chunk's size, in bytes
 * @returns {Error} 413
 */
function filePastDeclared(kind, declared, staged, incoming) {
  return tooLarge(
    `That ${kindNoun(kind)} was declared ${groupThousands(declared)} bytes and ${groupThousands(staged)} are already staged, so a chunk of ${groupThousands(incoming)} bytes would take it past the end.`,
  );
}

/**
 * Check a finished bank without parsing it: the size it declared at `begin`, and
 * the magic bytes at the front of chunk 0 (`RIFF`…`sfbk`). Called before
 * anything is stored, so a file that fails either check leaves nothing behind.
 * @param {string} takeId
 * @param {object} meta the staged meta
 * @param {string} firstFile chunk 0's path
 * @param {number} totalBytes the bytes the chunks add up to
 * @returns {Promise<void>}
 */
async function assertBankFinish(takeId, meta, firstFile, totalBytes) {
  const declared = Number(meta.bytes);
  if (!Number.isInteger(declared) || declared <= 0) {
    throw conflict(`Bank "${takeId}" has no readable size; begin it again.`);
  }
  if (totalBytes !== declared) {
    throw conflict(
      `Bank "${takeId}" was declared ${groupThousands(declared)} bytes, but its chunks add up to ${groupThousands(totalBytes)}.`,
    );
  }
  if (!isBankHead(await firstBytesOf(firstFile, BANK_HEAD_BYTES))) {
    throw badRequest(NOT_A_BANK_TEXT);
  }
}

/**
 * The name a sample upload carries, which `sample.add` needs and shows.
 * @param {unknown} value
 * @returns {string}
 */
function sampleNameOf(value) {
  const name = typeof value === "string" ? value.trim().slice(0, MAX_NAME) : "";
  if (name === "") throw badRequest("A sample upload needs a name.");
  return name;
}

/**
 * How a sample came to be in the song: an import, a recording, or a resample of
 * the engine's own output.
 * @param {unknown} value
 * @returns {string}
 */
function sampleOriginOf(value) {
  const origin = value === undefined || value === null || value === "" ? "import" : String(value);
  if (!SAMPLE_ORIGINS.includes(origin)) {
    throw badRequest(`A sample's origin is one of ${SAMPLE_ORIGINS.join(", ")}.`);
  }
  return origin;
}

/**
 * The pad a finished sample lands on, or null when the upload names none. The
 * fields are written in one fixed order, so a retried `begin` compares equal.
 * @param {unknown} value
 * @returns {{track_id: string, bank_id: string, index: number}|null}
 */
function uploadTarget(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object") throw badRequest("A sample's target pad is an object, or left out.");
  const trackId = typeof value.track_id === "string" ? value.track_id : "";
  const bankId = typeof value.bank_id === "string" ? value.bank_id : "";
  const index = Number(value.index);
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(trackId) || !/^[A-Za-z0-9_-]{1,40}$/.test(bankId)) {
    throw badRequest("A sample's target pad needs a track id and a bank id.");
  }
  if (!Number.isInteger(index) || index < 0 || index >= MAX_PADS) {
    throw badRequest(`A sample's target pad is a whole number from 1 to ${MAX_PADS}.`);
  }
  return { track_id: trackId, bank_id: bankId, index };
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

/**
 * Hash a run of staged files as one stream of bytes, in order: the way a bank's
 * sha256 is measured without the bank ever fitting in memory.
 * @param {string[]} files
 * @returns {Promise<string>} lower-case hex
 */
async function sha256Files(files) {
  const hash = createHash("sha256");
  for (const file of files) {
    for await (const piece of createReadStream(file)) hash.update(piece);
  }
  return hash.digest("hex");
}

/**
 * The sha256 of a WAV this finish writes: its header and then the staged PCM,
 * streamed in order, so a cabinet is hashed as the exact file storage holds.
 * @param {Buffer} header
 * @param {string[]} files
 * @returns {Promise<string>} lower-case hex
 */
async function sha256Wav(header, files) {
  const hash = createHash("sha256");
  hash.update(header);
  for (const file of files) {
    for await (const piece of createReadStream(file)) hash.update(piece);
  }
  return hash.digest("hex");
}

/**
 * The first bytes of one staged file, for a check that only needs the front of
 * it (a bank's magic).
 * @param {string} file
 * @param {number} count
 * @returns {Promise<Buffer>}
 */
async function firstBytesOf(file, count) {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(count);
    const { bytesRead } = await handle.read(buffer, 0, count, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * The first bytes of a run of staged files, read across them in order: the
 * chunks are pieces of one file, so a head that straddles a chunk boundary is
 * read whole.
 * @param {string[]} files the chunk files, in index order
 * @param {number} count how many bytes of the front to read
 * @returns {Promise<Buffer>} fewer bytes only when the files hold fewer
 */
async function headBytesOf(files, count) {
  const pieces = [];
  let have = 0;
  for (const file of files) {
    if (have >= count) break;
    const piece = await firstBytesOf(file, count - have);
    if (piece.length > 0) {
      pieces.push(piece);
      have += piece.length;
    }
  }
  return Buffer.concat(pieces);
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
   * One song's snapshot, failing closed.
   *
   * A finish decides what it may delete from this answer, so an unreadable song
   * is never treated as an empty one: it throws instead, and the staged upload
   * and everything already uploaded stay where they are.
   * @param {string} songId
   * @param {string} kind the upload's kind, for the refusal's own words
   * @returns {Promise<object>} the snapshot (empty when the hub has none)
   * @throws {Error} 503 when the song cannot be read
   */
  async function readSong(songId, kind) {
    let opened;
    try {
      opened = await hub.openSong(songId);
    } catch {
      throw withStatus(songUnreadable(kind), 503);
    }
    const snapshot = opened?.snapshot;
    return snapshot && typeof snapshot === "object" ? snapshot : {};
  }

  /**
   * One container out of a snapshot: a song's takes, its samples, or its
   * library (a bank upload's finished entry).
   * @param {object} snapshot
   * @param {string} kind
   * @returns {Object<string, object>} empty when the song has none
   */
  function songContainer(snapshot, kind) {
    const container = isLibraryKind(kind)
      ? snapshot?.library
      : kind === "sample"
        ? snapshot?.samples
        : snapshot?.takes;
    return container && typeof container === "object" ? container : {};
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
   * How many uploads of one kind one song has begun and not finished. The kinds
   * are counted apart: a long import session never uses up the takes' 32, and a
   * bank upload never uses up either.
   * @param {string} songId
   * @param {string} kind
   * @returns {Promise<number>}
   */
  async function openUploadsFor(songId, kind) {
    const limit = MAX_OPEN_BY_KIND[kind] ?? MAX_OPEN_BY_KIND.take;
    const entries = await readdir(stagingDir, { withFileTypes: true }).catch(() => []);
    let count = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const meta = await readMeta(entry.name);
      if (!meta || meta.song_id !== songId || meta.finished === true) continue;
      if (kindOf(meta) !== kind) continue;
      count += 1;
      // There is no reason to count past the limit.
      if (count >= limit) break;
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
   * Record the beginning of one upload — a recorded take, a sample, a SoundFont
   * bank, an amp capture or a cabinet IR the operator brought.
   *
   * It must come before the chunks: without it the gateway would not know whose
   * upload it is staging, and a chunk is never accepted without a song and a
   * project to check.
   *
   * Idempotent on the same details, so a client that lost the network after its
   * request went out can simply ask again. The same id with different details
   * is a conflict, because the upload that id already owns the staged bytes.
   *
   * A take names the clip it was recorded into. A sample names no clip: it
   * belongs to the song, and may name the pad it should land on. A bank, a
   * capture and a cabinet name neither: they belong to the song's library. A
   * bank declares the file's name, its size and its first twelve bytes; a capture
   * declares its size and the first bytes of its head; a cabinet declares the
   * rate, channels and frames the page decoded it to — so a file Studio cannot
   * play is refused before a byte of it is staged.
   *
   * @param {string} uploadId
   * @param {{kind?: "take"|"sample"|"font"|"nam"|"ir", song_id: string, project_id: number,
   *          clip_id?: string, name?: string, origin?: string,
   *          target?: {track_id: string, bank_id: string, index: number}|null,
   *          file_name?: string, bytes?: number, head?: string, frames?: number,
   *          rate?: number, channels?: number, author?: object,
   *          offset_frames?: number, compensated?: boolean, bpm?: number}} request
   * @returns {Promise<{chunk_bytes: number}>}
   */
  async function begin(uploadId, request = {}) {
    requireTakeId(uploadId);
    const body = request ?? {};
    const kind = uploadKind(body.kind);
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
    } = body;
    const noun = kindNoun(kind);
    // Each kind's own details, checked only where that kind uses them.
    const sampleName = kind === "sample" ? sampleNameOf(body.name) : null;
    const origin = kind === "sample" ? sampleOriginOf(body.origin) : null;
    const target = kind === "sample" ? uploadTarget(body.target) : null;
    const bank = kind === "font" ? bankUploadOf(body) : null;
    const capture = kind === "nam" ? captureUploadOf(body) : null;

    if (typeof songId !== "string" || !SONG_ID_PATTERN.test(songId)) {
      throw badRequest("That is not a valid song id.");
    }
    if (kind === "take" && (typeof clipId !== "string" || clipId === "")) {
      throw badRequest("An upload needs the clip the take was recorded into.");
    }
    const requestedProject = Number(requestedProjectRaw);
    if (!Number.isInteger(requestedProject)) {
      throw badRequest("An upload needs the song's project.");
    }
    // A bank and a capture are files, not PCM: they have no rate and no channel
    // count. A cabinet IS PCM — the page decoded it — so it declares both.
    const sampleRate = isFileKind(kind) ? null : Number(rate);
    if (!isFileKind(kind) && !TAKE_RATES.includes(sampleRate)) {
      throw badRequest(`A ${noun}'s rate is one of ${TAKE_RATES.join(", ")} samples per second.`);
    }
    const channelCount = isFileKind(kind) ? null : Number(channels);
    if (!isFileKind(kind) && (!Number.isInteger(channelCount) || channelCount < 1 || channelCount > MAX_CHANNELS)) {
      throw badRequest(`A ${noun} has 1 or ${MAX_CHANNELS} channels.`);
    }
    // A cabinet's length is its own limit, checked here from what the page says
    // it decoded: at most one second at that rate, and at most 10 MB.
    const cabinet = kind === "ir" ? irUploadOf(body, sampleRate, channelCount) : null;
    // A take is a place in a clip, so where in the timeline it was captured
    // matters; a sample is a one-shot that starts where the operator starts it.
    const offset = kind === "take" ? Number(offsetFrames) : 0;
    if (kind === "take" && (!Number.isInteger(offset) || offset < 0)) {
      throw badRequest("A take's offset is a whole, non-negative number of frames.");
    }
    if (kind === "take" && typeof compensated !== "boolean") {
      throw badRequest("A take's compensated flag is true or false.");
    }
    const actor = normalizeAuthor(author);

    // The project is the song's own. A caller that names another project is
    // asking to file this upload somewhere it does not belong, so it is refused
    // before anything is written.
    const projectId = await songProjectOf(songId);
    if (projectId !== requestedProject) {
      throw badRequest(`That song is not in project ${requestedProject}.`);
    }
    // And the caller must be allowed to put files in that project.
    await assertWrite(projectId);

    // A sample has no tempo of its own: it is a sound, not a place in a bar.
    const stated = Number(statedBpm);
    const bpm = kind === "take" && Number.isFinite(stated) && stated >= 20 && stated <= 300 ? stated : null;

    const existing = await readMeta(uploadId);
    if (existing && existing.finished !== true) {
      const same = sameUpload(existing, {
        kind,
        songId,
        projectId,
        clipId,
        sampleName,
        origin,
        target,
        bank,
        capture,
        cabinet,
        sampleRate,
        channelCount,
        actor,
        offset,
        compensated,
        bpm,
      });
      if (!same) {
        throw conflict(`${kindName(kind)} "${uploadId}" is already being uploaded with different details.`);
      }
      return { chunk_bytes: CHUNK_BYTES };
    }
    if (existing && existing.finished === true) {
      // An id names one upload for good. A finished take's id is not a new
      // sample's, and a finished sample's id is not a new take's: the staged
      // meta, the storage key and the reference type all belong to the first.
      const previousKind = kindOf(existing);
      if (previousKind !== kind) {
        throw conflict(`That id belongs to a ${kindNoun(previousKind)} upload.`);
      }
      // A finished upload whose object has since left the song (an undo, or the
      // clip was removed): start over in a clean directory. The song is read
      // fail-closed, because only its own answer may drop that meta.
      const inSong = songContainer(await readSong(existing.song_id, previousKind), previousKind);
      if (inSong[objectIdOf(previousKind, uploadId)]) return { chunk_bytes: CHUNK_BYTES };
      await rm(takeDir(uploadId), { recursive: true, force: true });
    }

    const openLimit = MAX_OPEN_BY_KIND[kind] ?? MAX_OPEN_BY_KIND.take;
    const open = await openUploadsFor(songId, kind);
    if (open >= openLimit) {
      const what = kind === "sample" ? "sample" : kindNoun(kind);
      throw tooLarge(
        `A song can have at most ${openLimit} ${what} uploads in progress; finish or abandon one before starting another.`,
      );
    }

    // A bank and a capture are not cut on frame boundaries: they are files, and
    // their bytes are whatever the client staged.
    if (!isFileKind(kind)) {
      const frameBytes = channelCount * BYTES_PER_SAMPLE;
      const staged = await stagedBytes(uploadId);
      if (staged % frameBytes !== 0) {
        throw badRequest(
          `The chunks already sent are not whole ${channelCount}-channel frames: ${staged} bytes is not a multiple of ${frameBytes}.`,
        );
      }
    }

    const meta = {
      take_id: uploadId,
      kind,
      song_id: songId,
      project_id: projectId,
      author: actor,
      recorded_at: nowIso(),
      created_at: millisNow(),
    };
    if (kind === "font") {
      meta.name = bank.name;
      meta.file_name = bank.file_name;
      meta.ext = bank.ext;
      meta.bytes = bank.bytes;
    } else if (kind === "nam") {
      meta.name = capture.name;
      meta.bytes = capture.bytes;
    } else if (kind === "ir") {
      meta.name = cabinet.name;
      meta.rate = sampleRate;
      meta.channels = channelCount;
      meta.frames = cabinet.frames;
    } else {
      meta.rate = sampleRate;
      meta.channels = channelCount;
      if (kind === "sample") {
        meta.name = sampleName;
        meta.origin = origin;
        meta.target = target;
      } else {
        meta.clip_id = clipId;
        meta.offset_frames = offset;
        meta.compensated = compensated;
        meta.bpm = bpm ?? (await songTempo(songId)) ?? 120;
      }
    }
    if (isLibraryKind(kind)) {
      // One nonce per begin, carried in the library entry's `cmd_id`: a retried
      // finish of this begin replays its own step, but the same upload id begun
      // again after a remove is a new step, not a replay of the add that was
      // undone.
      meta.attempt = randomUUID();
    }
    await writeMeta(uploadId, meta);
    return { chunk_bytes: CHUNK_BYTES };
  }

  /**
   * Whether a staged meta describes the same upload as this request, compared
   * on the fields its kind carries. `bpm` is only compared when the caller
   * stated one, because a retry that leaves it out means "the same take", not
   * "a different tempo".
   * @param {object} meta
   * @param {{kind: string, songId: string, projectId: number, clipId?: string,
   *          sampleName: (string|null), origin: (string|null),
   *          target: (object|null), bank: (object|null), capture: (object|null),
   *          cabinet: (object|null), sampleRate: number,
   *          channelCount: number, actor: object, offset: number,
   *          compensated: boolean, bpm: number|null}} request
   * @returns {boolean}
   */
  function sameUpload(meta, request) {
    if (kindOf(meta) !== request.kind) return false;
    if (meta.song_id !== request.songId) return false;
    if (Number(meta.project_id) !== request.projectId) return false;
    if (JSON.stringify(normalizeAuthor(meta.author)) !== JSON.stringify(request.actor)) return false;
    // A bank declares no rate or channels: its own details are what a retry has
    // to match.
    if (request.kind === "font") {
      const bank = request.bank ?? {};
      if (meta.name !== bank.name) return false;
      if (meta.file_name !== bank.file_name) return false;
      if (meta.ext !== bank.ext) return false;
      return Number(meta.bytes) === bank.bytes;
    }
    // A capture declares its size and nothing else: its head is checked again
    // for what actually arrived.
    if (request.kind === "nam") {
      const capture = request.capture ?? {};
      if (meta.name !== capture.name) return false;
      return Number(meta.bytes) === capture.bytes;
    }
    // A cabinet is PCM: its name, its length AND the rate and channel count the
    // page decoded it at. A retry that measured another rate or another channel
    // count is another cabinet, not the same upload sent again.
    if (request.kind === "ir") {
      const cabinet = request.cabinet ?? {};
      if (meta.name !== cabinet.name) return false;
      if (Number(meta.frames) !== cabinet.frames) return false;
      if (Number(meta.rate) !== request.sampleRate) return false;
      return Number(meta.channels) === request.channelCount;
    }
    if (Number(meta.rate) !== request.sampleRate) return false;
    if (Number(meta.channels) !== request.channelCount) return false;
    if (request.kind === "sample") {
      if (meta.name !== request.sampleName) return false;
      if (meta.origin !== request.origin) return false;
      return JSON.stringify(meta.target ?? null) === JSON.stringify(request.target ?? null);
    }
    if (meta.clip_id !== request.clipId) return false;
    if (Number(meta.offset_frames ?? 0) !== request.offset) return false;
    if ((meta.compensated === true) !== request.compensated) return false;
    if (request.bpm !== null && Number(meta.bpm) !== request.bpm) return false;
    return true;
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
      throw notFound("Begin the upload before sending its audio.");
    }
    const kind = kindOf(meta);
    // The gate is the song's project, read now: an upload cannot be extended by
    // someone who may not write where its song lives.
    await assertWrite(await songProjectOf(meta.song_id));
    if (meta.finished === true) {
      throw conflict(`${kindName(kind)} "${takeId}" is already finished, so nothing more can be sent to it.`);
    }
    // A bank and a capture have no frames and their own size is their cap: the
    // file the client declared at begin. A take's, a sample's and a cabinet's cap
    // is counted in samples.
    const isFile = isFileKind(kind);
    const channelCount = isFile ? 0 : Number(meta.channels);
    if (!isFile && (!Number.isInteger(channelCount) || channelCount < 1 || channelCount > MAX_CHANNELS)) {
      throw conflict(`${kindName(kind)} "${takeId}" has no readable channel count; begin it again.`);
    }
    let declaredBytes = 0;
    if (isFile) {
      declaredBytes = Number(meta.bytes);
      if (!Number.isInteger(declaredBytes) || declaredBytes <= 0) {
        throw conflict(`${kindName(kind)} "${takeId}" has no readable size; begin it again.`);
      }
    }

    const frameBytes = isFile ? 0 : channelCount * BYTES_PER_SAMPLE;
    const maxBytes = CHUNK_BYTES + frameBytes;
    // No upload of this kind's size can need a chunk past this index.
    const cap = isFile ? 0 : uploadCap(kind, sampleCap, meta);
    const lastIndex = isFile
      ? Math.ceil(declaredBytes / CHUNK_BYTES)
      : Math.ceil((cap * BYTES_PER_SAMPLE) / CHUNK_BYTES);
    if (at > lastIndex) {
      if (isFile) {
        throw tooLarge(
          `That ${kindNoun(kind)} was declared ${groupThousands(declaredBytes)} bytes, so it never needs chunk ${at}.`,
        );
      }
      if (kind === "sample") {
        throw tooLarge(
          `A sample can be at most ${SAMPLE_MAX_SECONDS} s (${groupThousands(cap)} samples at 48 kHz stereo), so it never needs chunk ${at}.`,
        );
      }
      if (kind === "ir") {
        throw tooLarge(
          `An impulse response is at most ${IR_MAX_SECONDS} second long, so it never needs chunk ${at}.`,
        );
      }
      throw tooLarge(
        `A take can hold at most ${groupThousands(cap)} samples (frames × channels), so it never needs chunk ${at}.`,
      );
    }
    if (bytes.byteLength > maxBytes) {
      throw tooLarge(
        isFile
          ? `A ${kindNoun(kind)}'s chunk can be at most ${CHUNK_BYTES} bytes: ${bytes.byteLength} bytes is too much.`
          : `A chunk can be at most ${CHUNK_BYTES} bytes plus one frame: ${bytes.byteLength} bytes is too much.`,
      );
    }
    if (!isFile && bytes.byteLength % frameBytes !== 0) {
      throw badRequest(
        `A chunk covers whole ${channelCount}-channel frames: ${bytes.byteLength} bytes is not a multiple of ${frameBytes}.`,
      );
    }

    // The upload's own cap, in samples: a staged byte is one channel's 24-bit
    // sample, so `cap` samples of PCM weigh `cap × 3` bytes. A bank or a capture
    // is capped by the size it declared instead.
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

    if (isFile && staged + bytes.byteLength > declaredBytes) {
      throw filePastDeclared(kind, declaredBytes, staged, bytes.byteLength);
    }
    if (!isFile && staged + bytes.byteLength > cap * BYTES_PER_SAMPLE) {
      throw capRefusal(kind, Math.ceil((staged + bytes.byteLength) / BYTES_PER_SAMPLE), sampleCap, meta);
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
   * is; a take that never began has no song to check, so it is not found. A bank
   * or a capture has no frames at all: it is a file, and its answer is its chunks.
   *
   * @param {string} takeId
   * @returns {Promise<{begun: boolean, received: Array<{index: number, sha256: string}>,
   *                    frames: (number|null)}>}
   */
  async function status(takeId) {
    requireTakeId(takeId);
    const meta = await readMeta(takeId);
    if (!meta) {
      throw notFound(`There is no upload in progress for "${takeId}"; begin it before asking after it.`);
    }
    await assertWrite(await songProjectOf(meta.song_id));
    const chunks = await listChunks(takeId);
    const received = chunks.map(({ index, sha256 }) => ({ index, sha256 }));
    if (isFileKind(kindOf(meta))) return { begun: true, received, frames: null };
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
          throw conflict(`Upload "${takeId}" is being finished by another process.`);
        }
        // A stale lock: the process that held it is gone.
        await unlink(file).catch(() => {});
      }
    }
    throw conflict(`Upload "${takeId}" is being finished by another process.`);
  }

  /**
   * Finish one upload: stream its WAV into storage, file it, and add it to the
   * song through the hub.
   *
   * One finish per upload at a time: a second call for the same id while one is
   * running in this process awaits it and returns its result.
   *
   * @param {string} takeId
   * @param {{chunk_hashes: string[]}} request the SHA-256 of every chunk, in order
   * @returns {Promise<{take: object}|{sample: object, pad_assigned: boolean}>}
   *   the object now in the song; a sample also says whether its pad holds it
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
   * The body of `finish`, run under the upload's in-process entry and its lock.
   * @param {string} takeId
   * @param {string[]} hashes
   * @returns {Promise<{take: object}|{sample: object, pad_assigned: boolean}>}
   */
  async function finishOnce(takeId, hashes) {
    const staged = await readMeta(takeId);
    if (!staged) {
      throw notFound(`There is no upload in progress for "${takeId}"; begin it before finishing it.`);
    }
    const kind = kindOf(staged);
    const Noun = kindName(kind);
    const noun = kindNoun(kind);

    // The project is the song's, re-read now: an upload begun in one project
    // must not land in storage after its song moved to another.
    const projectId = await songProjectOf(staged.song_id);
    const begunIn = Number(staged.project_id);
    if (projectId !== begunIn) {
      throw conflict(
        `${Noun} "${takeId}" was begun in project ${begunIn}, but its song is in project ${projectId} now; the ${noun} is kept.`,
      );
    }
    await assertWrite(projectId);

    const lock = await acquireFinishLock(takeId);
    try {
      const meta = (await readMeta(takeId)) ?? staged;

      // A retried finish — after a timeout, a reload, or a gateway restart —
      // must not upload the same audio twice nor apply the command again. If
      // the song cannot be read, this throws and nothing is touched.
      const song = await readSong(meta.song_id, kind);
      const inSong = songContainer(song, kind);
      const held = inSong[objectIdOf(kind, takeId)] ?? null;
      if (held) {
        // The sound (or take) is in. A sample also answers what became of its
        // pad, and that answer is the one its first finish recorded BEFORE it
        // returned: the pad is never assigned twice, so a pad the operator
        // cleared or re-filled since keeps what they chose. Only an attempt
        // that stopped between `sample.add` and its own record has none, and it
        // lands the sample now and records that.
        // A library file whose finish stopped after `library.add` but before it
        // was recorded settles now, so its staged copy (up to 512 MB) is dropped
        // instead of waiting for the stale sweep.
        if (isLibraryKind(kind) && meta.finished !== true) {
          return await completeFinish(takeId, meta, held, {
            kind,
            frames: Number(meta.frames) || 0,
            key: typeof meta.storage_key === "string" ? meta.storage_key : String(held.storage_key ?? ""),
            chunks: hashes.length,
          });
        }
        if (kind !== "sample") return finishResult(kind, held);
        if (isPadAssignRecorded(meta)) return finishResult(kind, held, meta.pad_assign);
        const record = held;
        const padAssign = await landOnPad(meta);
        return await completeFinish(takeId, meta, record, {
          kind,
          frames: Number(meta.frames) || Number(record.frames) || 0,
          key: typeof meta.storage_key === "string" ? meta.storage_key : String(record.storage_key ?? ""),
          chunks: hashes.length,
          padAssign,
        });
      }
      if (meta.finished === true) {
        throw conflict(`${Noun} "${takeId}" was finished, but it is no longer in the song.`);
      }

      const isFile = isFileKind(kind);
      const channelCount = isFile ? null : Number(meta.channels);
      const frameBytes = isFile ? 0 : channelCount * BYTES_PER_SAMPLE;
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
      let frames = null;
      if (kind === "font") {
        // A bank is a file, not PCM: the only things checked are the size it
        // declared and the magic bytes at the front of chunk 0. Nothing is
        // stored until both are right.
        await assertBankFinish(takeId, meta, files[0], totalBytes);
      } else if (kind === "nam") {
        // A capture is a file too, and is not parsed either: the head is checked
        // again from the bytes that actually arrived, and one streaming pass
        // looks for the weights key a capture always holds.
        await assertCaptureFinish(takeId, meta, files, totalBytes);
      } else {
        if (totalBytes % frameBytes !== 0) {
          throw badRequest(
            `The chunks do not add up to whole ${channelCount}-channel frames: ${totalBytes} bytes is not a multiple of ${frameBytes}.`,
          );
        }
        frames = totalBytes / frameBytes;
        const samples = frames * channelCount;
        if (samples > uploadCap(kind, sampleCap, meta)) {
          throw capRefusal(kind, samples, sampleCap, meta);
        }
        // A cabinet's own size limit, checked again from what arrived: a page
        // that declared one second and sent more is refused before anything is
        // stored.
        if (kind === "ir" && totalBytes > IR_MAX_BYTES) {
          throw tooLarge(
            `That cabinet is ${Math.ceil(totalBytes / MB_BYTES)} MB; Studio takes cabinets up to 10 MB.`,
          );
        }
      }

      const bucket = typeof storage.defaultBucket === "function" ? storage.defaultBucket() : undefined;
      const prefix = await storagePrefixFor(db, projectId);
      const libraryId = objectIdOf(kind, takeId);
      // A library file's object is named for its entry, so the library file
      // route serves it: `${prefix}studio/<song>/library/<library id>.<ext>`.
      // A bank keeps its own extension, a capture is `.nam`, and a cabinet is the
      // 24-bit WAV the sample path writes.
      const storedName = isLibraryKind(kind)
        ? `${libraryId}.${kind === "font" ? bankExtOf(meta) : kind === "nam" ? CAPTURE_EXTENSION : IR_EXTENSION}`
        : `${takeId}.wav`;
      const key = `${prefix}studio/${meta.song_id}/${KEY_DIRS[kind]}/${storedName}`;
      const contentType = isFile ? "application/octet-stream" : "audio/wav";
      const rate = isFile ? null : Number(meta.rate);

      // The header and then the staged files, streamed: a 1200 s take is 346 MB,
      // and it must never have to fit in one buffer. A bank or a capture has no
      // header: its bytes are the file the operator brought, exactly as they
      // arrived.
      const header = isFile ? null : wavHeader(frames, channelCount, rate);
      const size = (header ? header.byteLength : 0) + totalBytes;
      // The hash is what the library entry says the file is. A bank's or a
      // capture's is taken over the chunks as they sit on disk, so neither is
      // ever held in memory whole; a cabinet's is the WAV that was stored, header
      // and all, because that is the file the library route serves.
      let sha256 = null;
      if (isFile) sha256 = await sha256Files(files);
      else if (kind === "ir") sha256 = await sha256Wav(header, files);

      await serializeUpload(async () => {
        const stats = await storage.getBucketStats(bucket);
        const used = Number(stats?.totalSizeBytes ?? 0);
        // The incoming take counts: the project must still fit after it.
        if (used + size > quotaBytes) {
          throw outOfQuota(`Storage quota exceeded (${quotaText} MB). Delete files to free space.`);
        }
        const stream = Readable.from(isFile ? filePieces(files) : wavPieces(header, files), { objectMode: false });
        await storage.putObjectStream(key, stream, size, { bucket, contentType });

        try {
          // The key is fixed per upload, so a row a crashed attempt left behind
          // is this upload's own row: keep it and carry on.
          await db.execute({
            sql: `INSERT INTO storage_files (s3_key, original_name, mime_type, size_bytes, bucket, reference_type, reference_id, project_id)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(s3_key) DO NOTHING`,
            args: [
              key,
              storedName,
              contentType,
              size,
              bucket,
              REFERENCE_TYPES[kind],
              meta.song_id,
              projectId,
            ],
          });
        } catch (error) {
          // A row that never landed must not leave an untracked object behind —
          // but only once a re-read says the song does not point at it.
          const afterInsert = songContainer(await readSong(meta.song_id, kind), kind);
          if (!afterInsert[objectIdOf(kind, takeId)]) await deleteObjectQuietly(storage, key, bucket);
          throw error;
        }
      });

      // What the upload adds to the song: a take's record, a sample's, or the
      // library entry a bank, a capture or a cabinet becomes.
      const entry = isLibraryKind(kind)
        ? {
            id: libraryId,
            kind,
            name: typeof meta.name === "string" && meta.name !== "" ? meta.name : libraryId,
            source: "upload",
            upload_id: takeId,
            storage_key: key,
            sha256,
            // The size of the object storage holds: for a cabinet, the WAV's
            // header and its PCM, which is also what `sha256` was measured over.
            bytes: size,
            licence: "",
            credit: "",
            author_label: authorLabelOf(meta.author),
          }
        : null;
      const record =
        kind === "sample"
          ? {
              id: takeId,
              storage_key: key,
              rate,
              channels: channelCount,
              frames,
              name: typeof meta.name === "string" ? meta.name : takeId,
              origin: SAMPLE_ORIGINS.includes(meta.origin) ? meta.origin : SAMPLE_ORIGINS[0],
              author_label: authorLabelOf(meta.author),
            }
          : isLibraryKind(kind)
            ? null
            : {
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
      // `take.add`/`sample.add`/`library.add`, and no caller gets to name the
      // storage key. A library file's command carries its begin's nonce in its
      // `cmd_id`, so a finish of a re-begun upload (after a remove) is a new
      // step rather than a replay of the add that was undone.
      const applied = await hub.runCommand({
        song_id: meta.song_id,
        cmd_id: isLibraryKind(kind) ? `${takeId}:library:${String(meta.attempt ?? "")}` : takeId,
        command: isLibraryKind(kind) ? "library.add" : kind === "sample" ? "sample.add" : "take.add",
        args: isLibraryKind(kind)
          ? { entry }
          : kind === "sample"
            ? { sample: record }
            : { clip_id: meta.clip_id, take: record },
        author: meta.author,
        internal: true,
      });

      // Whatever the hub said, the song is the judge; a re-read is the only
      // answer a cleanup may act on.
      const afterAdd = await readSong(meta.song_id, kind);
      const confirmed = songContainer(afterAdd, kind)[objectIdOf(kind, takeId)] ?? null;

      if (!applied || applied.ok !== true) {
        if (confirmed) {
          // The refusal is a replay of a step an earlier attempt applied and
          // never got to clean up after: the upload is in the song, so complete
          // it. The earlier attempt wrote the audit line.
          const padAssign = kind === "sample" ? await padAssignFor(meta) : PAD_ASSIGN.skipped;
          return await completeFinish(takeId, meta, confirmed, {
            kind,
            frames,
            key,
            chunks: hashes.length,
            padAssign,
          });
        }
        // The song does not point at the upload, so the object and its row may
        // go. The staged audio is the only copy of the recording: it stays, so
        // the next finish can try again.
        await deleteObjectQuietly(storage, key, bucket);
        await deleteRowQuietly(db, key, kind);
        throw withStatus(
          String(applied?.error ?? `The song refused that ${noun}.`),
          statusForCode(applied?.code),
        );
      }

      if (!confirmed) {
        // Applied, but the song does not show it: deleting anything now could
        // lose the upload, so everything stays for a later finish.
        throw conflict(
          `${Noun} "${takeId}" was applied, but the song does not show it; the ${noun} is kept and will finish later.`,
        );
      }

      const payload = isLibraryKind(kind)
        ? { storage_key: key, bytes: size, library_id: libraryId }
        : { storage_key: key, seconds: Math.round((frames / rate) * 1000) / 1000 };
      if (isLibraryKind(kind)) {
        // Nothing more: the entry's own id says which file arrived.
      } else if (kind === "sample") {
        payload.sample_id = takeId;
        if (meta.target && typeof meta.target === "object") payload.pad = meta.target;
      } else {
        payload.take_id = takeId;
        payload.clip_id = meta.clip_id;
      }

      await acl.appendAudit(db, {
        project_id: projectId,
        ...auditActor(meta.author),
        action: AUDIT_ACTIONS[kind],
        target: `song:${meta.song_id}`,
        payload,
      });

      // A finished sample may belong on a pad. The pad is asked for inside the
      // command, on the hub's own queue, so a pad the operator filled meanwhile
      // is kept and the sample stays in the song. The outcome is recorded in the
      // meta by `completeFinish`, before this answer goes out.
      const padAssign = kind === "sample" ? await padAssignFor(meta) : PAD_ASSIGN.skipped;
      return await completeFinish(takeId, meta, confirmed, {
        kind,
        frames,
        key,
        chunks: hashes.length,
        padAssign,
      });
    } finally {
      await unlink(lock).catch(() => {});
    }
  }

  /**
   * Put a finished sample on the pad its upload named — if that pad is still
   * free, or already holds this exact sample.
   *
   * The "is it still free?" question is the command's, not this function's: a
   * snapshot read here would answer with the song as it was a moment ago, and
   * the operator's own `pad.assign` may have landed since. So the upload asks
   * `pad.assign_if_empty` — Studio's own command, `internal: true` — and its
   * check runs inside the hub's per-song queue, against the pad as it is now. A
   * pad that holds another sound is refused there ("conflict"), and that
   * refusal is this upload's "skipped": the sample is in the song, the pad is
   * the operator's. `cmd_id` is the upload's id with `":assign"`, so the same
   * assignment cannot apply twice.
   *
   * @param {object} meta the upload's staged meta
   * @returns {Promise<string>} `PAD_ASSIGN.done` or `PAD_ASSIGN.skipped`
   */
  async function landOnPad(meta) {
    const target = meta && typeof meta.target === "object" ? meta.target : null;
    if (!target) return PAD_ASSIGN.skipped;
    const id = String(meta.take_id ?? "");
    const result = await hub.runCommand({
      song_id: meta.song_id,
      cmd_id: `${id}:assign`,
      command: "pad.assign_if_empty",
      args: { track_id: target.track_id, bank_id: target.bank_id, index: target.index, sample_id: id },
      author: meta.author,
      internal: true,
    });
    return result && result.ok === true ? PAD_ASSIGN.done : PAD_ASSIGN.skipped;
  }

  /**
   * What a sample's pad came to: the outcome an earlier attempt recorded, or
   * the assignment made now.
   * @param {object} meta the upload's staged meta
   * @returns {Promise<string>} `PAD_ASSIGN.done` or `PAD_ASSIGN.skipped`
   */
  async function padAssignFor(meta) {
    return isPadAssignRecorded(meta) ? meta.pad_assign : landOnPad(meta);
  }

  /**
   * The answer one finished upload gives its caller: the take itself, a sample
   * with whether its pad holds it now, or the library entry a bank, a capture or
   * a cabinet became.
   * @param {string} kind
   * @param {object} record the object as the song holds it
   * @param {string} [padAssign] what became of the sample's pad
   * @returns {{take: object}|{sample: object, pad_assigned: boolean}|{library: object}}
   */
  function finishResult(kind, record, padAssign = PAD_ASSIGN.skipped) {
    if (kind === "sample") return { sample: record, pad_assigned: padAssign === PAD_ASSIGN.done };
    if (isLibraryKind(kind)) return { library: record };
    return { take: record };
  }

  /**
   * Close out an upload the song has confirmed: mark its meta finished — with
   * what became of a sample's pad, so a retried finish never assigns again —
   * and only then drop the staged audio.
   * @param {string} takeId
   * @param {object} meta
   * @param {object} record the object as the song holds it
   * @param {{kind: string, frames: (number|null), key: string, chunks: number,
   *          padAssign?: string}} finished
   * @returns {Promise<{take: object}|{sample: object, pad_assigned: boolean}|{library: object}>}
   */
  async function completeFinish(takeId, meta, record, { kind, frames, key, chunks, padAssign = PAD_ASSIGN.skipped }) {
    const settled = { ...meta, finished: true, frames, storage_key: key, finished_at: nowIso() };
    if (kind === "sample") settled.pad_assign = padAssign;
    await writeMeta(takeId, settled);
    await dropChunks(takeId, chunks);
    return finishResult(kind, record, padAssign);
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
 * Delete the `storage_files` row of an upload the song does not reference.
 * @param {object} db
 * @param {string} key
 * @param {string} [kind] the upload's kind, which says what the row is filed as
 * @returns {Promise<void>}
 */
async function deleteRowQuietly(db, key, kind = "take") {
  try {
    await db.execute({
      sql: "DELETE FROM storage_files WHERE s3_key = ? AND reference_type = ?",
      args: [key, REFERENCE_TYPES[kind] ?? REFERENCE_TYPES.take],
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

/**
 * The pieces of a bank: its staged chunks, in order, with nothing added. A bank
 * is stored exactly as the operator's file arrived.
 * @param {string[]} files the chunk files, in index order
 * @returns {AsyncGenerator<Buffer>}
 */
async function* filePieces(files) {
  for (const file of files) {
    for await (const piece of createReadStream(file)) yield piece;
  }
}