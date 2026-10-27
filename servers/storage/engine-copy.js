/**
 * Storage engine copier + verifier (MinIO -> Garage and back).
 *
 * Copies every object of one S3 endpoint to another with the exact key, the
 * exact bytes and the metadata that matters (Content-Type, Cache-Control,
 * Content-Disposition, Content-Encoding, Content-Language, every
 * x-amz-meta-*), and proves the copy with evidence that does not come from the
 * copy itself (see verify()).
 *
 * Design rules (the private engineering notes, Garage migration plan §5):
 *  - minio-js on both ends; no other client.
 *  - Bounded memory: each worker owns ONE part buffer of PART_SIZE bytes, so
 *    peak buffer memory is concurrency x PART_SIZE (8 x 64 MiB by default).
 *    Objects above PART_SIZE are sent as a multipart upload that this module
 *    drives itself, so a source stream that ends early (or runs long) is
 *    caught BEFORE the upload is completed, and a failed upload is aborted by
 *    its exact uploadId (Garage has no lifecycle rule to clean strays up).
 *  - State is an append-only JSONL file, one record per copied key:
 *      bucket, key, size, src_etag, sha256, bytes_hashed, dest_etag,
 *      dest_last_modified, done
 *    The last record for a key wins; a torn final line (crash mid-write) is
 *    ignored. dest_etag is what the rollback (reverse) copy compares against:
 *    ETags are never compared across engines when a part count may differ.
 *  - Deletes are carried only on request (forward) or always (reverse), and a
 *    per-bucket guard refuses a delete set larger than min(pct of the bucket,
 *    a key count).
 */

import { createHash } from "node:crypto";
import { openSync, writeSync, fsyncSync, closeSync, readFileSync, existsSync, readdirSync, lstatSync, renameSync, writeFileSync, createReadStream, truncateSync } from "node:fs";
import { join } from "node:path";
import * as Minio from "minio";

export const MiB = 1024 * 1024;
/** Part size for multipart uploads AND the per-worker buffer: the memory cap. */
export const PART_SIZE = 64 * MiB;
export const DEFAULT_CONCURRENCY = 8;
export const MAX_CONCURRENCY = 16;
/** S3 minimum part size (all parts but the last). */
export const MIN_PART_SIZE = 5 * MiB;
export const MAX_PARTS = 10000;
export const DEFAULT_MAX_DELETE_PCT = 1;
export const DEFAULT_MAX_DELETE_KEYS = 100;
export const DEFAULT_IDLE_TIMEOUT_MS = 120_000;

/** Headers carried verbatim from source to destination. */
export const CARRIED_HEADERS = ["content-type", "cache-control", "content-disposition", "content-encoding", "content-language"];
/**
 * Attributes the copier cannot reproduce through a PUT; an object that has one
 * is refused (never silently dropped). None are in use on the source today.
 */
const UNSUPPORTED_HEADERS = [
  "expires", "x-amz-website-redirect-location", "x-amz-tagging-count",
  "x-amz-object-lock-mode", "x-amz-object-lock-retain-until-date", "x-amz-object-lock-legal-hold",
  "x-amz-server-side-encryption", "x-amz-server-side-encryption-customer-algorithm",
];
/**
 * x-amz-meta-<suffix> names that minio-js's strip/re-prefix would turn into a
 * REAL header for any downstream minio-js reader (statObject strips the
 * prefix, putObject only re-adds it to names it does not recognise).
 */
const COLLIDING_META = new Set([...CARRIED_HEADERS, "expires", "x-amz-website-redirect-location", "if-none-match", "if-match", "x-amz-storage-class"]);

export class RefusedError extends Error {
  constructor(reason) { super(reason); this.name = "RefusedError"; this.refused = true; }
}

export const stripEtag = (e) => String(e || "").replace(/^"+|"+$/g, "");
export const isMultipartEtag = (e) => /-\d+$/.test(stripEtag(e));

/**
 * The metadata to carry for an object, from its raw (lower-cased) GET/HEAD
 * response headers. Throws RefusedError for anything that cannot be carried
 * exactly.
 */
export function carriedHeaders(headers) {
  const out = {};
  for (const h of UNSUPPORTED_HEADERS) {
    if (headers[h] != null && headers[h] !== "") throw new RefusedError(`unsupported_attribute:${h}`);
  }
  const sc = headers["x-amz-storage-class"];
  if (sc && sc !== "STANDARD") throw new RefusedError(`unsupported_attribute:x-amz-storage-class=${sc}`);
  for (const h of CARRIED_HEADERS) if (headers[h] != null && headers[h] !== "") out[h] = String(headers[h]);
  for (const [name, value] of Object.entries(headers)) {
    const n = name.toLowerCase();
    if (!n.startsWith("x-amz-meta-")) continue;
    const suffix = n.slice("x-amz-meta-".length);
    if (!suffix) throw new RefusedError("colliding_metadata:x-amz-meta-");
    if (COLLIDING_META.has(suffix) || suffix.startsWith("x-amz-")) throw new RefusedError(`colliding_metadata:${n}`);
    out[n] = String(value);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Endpoint adapter over minio-js. The unit tests implement the same surface
// in memory (tests/helpers/fake-s3-endpoint.mjs).
// ---------------------------------------------------------------------------

/** Parse "http://host:port" / "https://host" / "host:port" into client options. */
export function parseEndpointUrl(url) {
  const s = String(url || "").trim();
  if (!s) throw new Error("endpoint url is required");
  const withScheme = /^https?:\/\//i.test(s) ? s : `http://${s}`;
  const u = new URL(withScheme);
  const useSSL = u.protocol === "https:";
  const port = u.port ? parseInt(u.port, 10) : (useSSL ? 443 : 80);
  if (u.pathname && u.pathname !== "/") throw new Error(`endpoint must not carry a path: ${url}`);
  return { host: u.hostname.replace(/^\[|\]$/g, ""), port, useSSL };
}

export function makeMinioEndpoint({ url, accessKey, secretKey, region = "us-east-1" }) {
  if (!accessKey || !secretKey) throw new Error(`credentials missing for ${url}`);
  const { host, port, useSSL } = parseEndpointUrl(url);
  const client = new Minio.Client({ endPoint: host, port, useSSL, accessKey, secretKey, region, partSize: PART_SIZE });
  const id = `${host}:${port}`;
  return {
    id,
    client,
    async listBuckets() { return (await client.listBuckets()).map((b) => b.name).sort(); },
    async ensureBucket(bucket) {
      if (await client.bucketExists(bucket)) return false;
      await client.makeBucket(bucket, region);
      return true;
    },
    async list(bucket) {
      const out = new Map();
      await new Promise((resolve, reject) => {
        const s = client.listObjectsV2(bucket, "", true);
        s.on("data", (o) => { if (o.name != null) out.set(o.name, { size: Number(o.size), etag: stripEtag(o.etag) }); });
        s.on("error", reject);
        s.on("end", resolve);
      });
      return out;
    },
    async get(bucket, key) {
      const res = await client.getObject(bucket, key);
      return { headers: res.headers, body: res };
    },
    async head(bucket, key) {
      const res = await client.makeRequestAsyncOmit({ method: "HEAD", bucketName: bucket, objectName: key });
      return res.headers;
    },
    async putSingle(bucket, key, buf, headers) {
      const r = await client.putObject(bucket, key, buf, buf.length, { ...headers });
      return { etag: stripEtag(r.etag) };
    },
    async mpInit(bucket, key, headers) { return client.initiateNewMultipartUpload(bucket, key, { ...headers }); },
    async mpPart(bucket, key, uploadId, partNumber, buf) {
      const md5 = createHash("md5").update(buf).digest("base64");
      const r = await client.uploadPart({ bucketName: bucket, objectName: key, uploadID: uploadId, partNumber, headers: { "Content-Length": buf.length, "Content-MD5": md5 } }, buf);
      return { part: partNumber, etag: stripEtag(r.etag) };
    },
    async mpComplete(bucket, key, uploadId, parts) {
      const r = await client.completeMultipartUpload(bucket, key, uploadId, parts);
      return { etag: stripEtag(r.etag) };
    },
    async mpAbort(bucket, key, uploadId) {
      try { await client.abortMultipartUpload(bucket, key, uploadId); }
      catch (e) { if (e?.code !== "NoSuchUpload") throw e; }
    },
    async remove(bucket, key) { await client.removeObject(bucket, key); },
  };
}

// ---------------------------------------------------------------------------
// State log (append-only JSONL)
// ---------------------------------------------------------------------------

const sk = (bucket, key) => `${bucket}\u0000${key}`;

/** Parse a JSONL file; a torn LAST line is ignored, a bad line elsewhere throws. */
export function readJsonl(path) {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); }
    catch (e) {
      const isLast = lines.slice(i + 1).every((l) => !l.trim());
      if (isLast) break; // a crash mid-append: that record never completed
      throw new Error(`${path}: corrupt line ${i + 1}: ${e.message}`);
    }
  }
  return out;
}

/**
 * Before appending to a log a crash may have left mid-line, cut the torn tail
 * off, so the next record does not glue onto it and turn into a corrupt
 * middle line.
 */
function trimTornTail(path) {
  if (!existsSync(path)) return;
  const buf = readFileSync(path);
  if (buf.length === 0 || buf[buf.length - 1] === 0x0a) return;
  truncateSync(path, buf.lastIndexOf(0x0a) + 1);
}

export class StateLog {
  constructor(path, { readOnly = false, fsyncEvery = 50 } = {}) {
    this.path = path;
    this.map = new Map();
    for (const r of readJsonl(path)) if (r && typeof r.bucket === "string" && typeof r.key === "string") this.map.set(sk(r.bucket, r.key), r);
    this.fd = null;
    this.readOnly = readOnly;
    this.fsyncEvery = fsyncEvery;
    this.pending = 0;
  }
  get size() { return this.map.size; }
  get(bucket, key) { return this.map.get(sk(bucket, key)) || null; }
  append(rec) {
    if (this.readOnly) throw new Error("state log is read-only");
    if (this.fd == null) { trimTornTail(this.path); this.fd = openSync(this.path, "a", 0o600); }
    writeSync(this.fd, JSON.stringify(rec) + "\n");
    this.map.set(sk(rec.bucket, rec.key), rec);
    if (++this.pending >= this.fsyncEvery) this.flush();
  }
  flush() { if (this.fd != null && this.pending) { fsyncSync(this.fd); this.pending = 0; } }
  close() { if (this.fd != null) { this.flush(); fsyncSync(this.fd); closeSync(this.fd); this.fd = null; } }
}

/** Side log of multipart uploads this tool opened, so a deadman can abort exactly those. */
export class UploadLog {
  constructor(path) { this.path = path; this.fd = null; }
  _w(rec) {
    if (!this.path) return;
    if (this.fd == null) { trimTornTail(this.path); this.fd = openSync(this.path, "a", 0o600); }
    writeSync(this.fd, JSON.stringify(rec) + "\n");
    fsyncSync(this.fd);
  }
  open(endpoint, bucket, key, uploadId) { this._w({ op: "open", endpoint, bucket, key, uploadId, at: new Date().toISOString() }); }
  close(endpoint, bucket, key, uploadId, how) { this._w({ op: "close", endpoint, bucket, key, uploadId, how, at: new Date().toISOString() }); }
  openUploads() {
    const open = new Map();
    for (const r of readJsonl(this.path)) {
      const k = `${r.endpoint}\u0000${r.bucket}\u0000${r.key}\u0000${r.uploadId}`;
      if (r.op === "open") open.set(k, r); else if (r.op === "close") open.delete(k);
    }
    return [...open.values()];
  }
  closeFd() { if (this.fd != null) { closeSync(this.fd); this.fd = null; } }
}

// ---------------------------------------------------------------------------
// Streaming helpers
// ---------------------------------------------------------------------------

/**
 * Read a body into fixed-size parts using ONE caller-owned buffer. Yields
 * views into that buffer (valid until the next iteration). Hashes and counts
 * every byte; throws if the stream yields more than `expected` bytes or
 * stalls for idleMs.
 */
async function* readParts(body, buffer, partSize, expected, hash, counter, idleMs) {
  let fill = 0;
  let timer = null;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => body.destroy(new Error(`source stream idle for ${idleMs} ms`)), idleMs);
    timer.unref?.();
  };
  arm();
  try {
    for await (const raw of body) {
      arm();
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      counter.bytes += chunk.length;
      if (counter.bytes > expected) throw new Error(`source sent more than ${expected} bytes`);
      hash.update(chunk);
      let off = 0;
      while (off < chunk.length) {
        const n = Math.min(partSize - fill, chunk.length - off);
        chunk.copy(buffer, fill, off, off + n);
        fill += n; off += n;
        if (fill === partSize) {
          // The consumer uploads the part while we are suspended here: the idle
          // timer measures the SOURCE only, so it is off for the upload.
          clearTimeout(timer);
          yield buffer.subarray(0, fill);
          fill = 0;
          arm();
        }
      }
    }
  } finally { clearTimeout(timer); }
  if (fill > 0) yield buffer.subarray(0, fill);
}

/** sha256 + byte count of a body without keeping it. */
async function hashBody(body, idleMs = DEFAULT_IDLE_TIMEOUT_MS) {
  const h = createHash("sha256");
  let bytes = 0;
  let timer = null;
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => body.destroy(new Error(`stream idle for ${idleMs} ms`)), idleMs); timer.unref?.(); };
  arm();
  try {
    for await (const c of body) { arm(); bytes += c.length; h.update(c); }
  } finally { clearTimeout(timer); }
  return { sha256: h.digest("hex"), bytes };
}

async function runPool(items, n, fn, ctl) {
  let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(n, items.length || 1)) }, async (_, w) => {
    while (!ctl.stopped && i < items.length) {
      const item = items[i++];
      await fn(item, w);
    }
  });
  await Promise.all(workers);
}

// ---------------------------------------------------------------------------
// Copy one object
// ---------------------------------------------------------------------------

/**
 * Copy src:bucket/key -> dst:bucket/key. `buffer` is this worker's part
 * buffer (partSize bytes). Returns the state record.
 */
export async function copyObject({ src, dst, bucket, key, buffer, partSize = PART_SIZE, uploads = null, ctl = { stopped: false, bodies: new Set() }, idleMs = DEFAULT_IDLE_TIMEOUT_MS }) {
  const { headers, body } = await src.get(bucket, key);
  ctl.bodies?.add(body);
  let uploadId = null;
  try {
    const size = Number(headers["content-length"]);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`source gave no usable content-length (${headers["content-length"]})`);
    if (size > partSize * MAX_PARTS) throw new RefusedError(`too_large:${size}`);
    const meta = carriedHeaders(headers);
    const srcEtag = stripEtag(headers.etag);
    const hash = createHash("sha256");
    const counter = { bytes: 0 };
    let destEtag;
    if (size <= partSize) {
      let view = Buffer.alloc(0);
      for await (const part of readParts(body, buffer, partSize, size, hash, counter, idleMs)) view = part;
      if (counter.bytes !== size) throw new Error(`short read: bytes_hashed ${counter.bytes} != size ${size}`);
      ({ etag: destEtag } = await dst.putSingle(bucket, key, size === 0 ? Buffer.alloc(0) : view, meta));
    } else {
      uploadId = await dst.mpInit(bucket, key, meta);
      uploads?.open(dst.id, bucket, key, uploadId);
      const parts = [];
      let n = 0;
      for await (const part of readParts(body, buffer, partSize, size, hash, counter, idleMs)) {
        if (ctl.stopped) throw new Error("stopped");
        parts.push(await dst.mpPart(bucket, key, uploadId, ++n, part));
      }
      if (counter.bytes !== size) throw new Error(`short read: bytes_hashed ${counter.bytes} != size ${size}`);
      ({ etag: destEtag } = await dst.mpComplete(bucket, key, uploadId, parts));
      uploads?.close(dst.id, bucket, key, uploadId, "completed");
      uploadId = null;
    }
    const dh = await dst.head(bucket, key);
    if (Number(dh["content-length"]) !== size) {
      await dst.remove(bucket, key).catch(() => {});
      throw new Error(`destination size ${dh["content-length"]} != ${size} after put`);
    }
    return {
      bucket, key, size, src_etag: srcEtag, sha256: hash.digest("hex"), bytes_hashed: counter.bytes,
      dest_etag: stripEtag(dh.etag || destEtag), dest_last_modified: dh["last-modified"] || null,
      done: true, at: new Date().toISOString(),
    };
  } catch (err) {
    if (uploadId) {
      try { await dst.mpAbort(bucket, key, uploadId); uploads?.close(dst.id, bucket, key, uploadId, "aborted"); }
      catch (e) { err.message += ` (and aborting upload ${uploadId} failed: ${e.message})`; }
    }
    throw err;
  } finally {
    ctl.bodies?.delete(body);
    if (!body.destroyed) body.destroy();
  }
}

// ---------------------------------------------------------------------------
// Delete guard
// ---------------------------------------------------------------------------

export function deleteLimit(bucketCount, { maxDeletePct = DEFAULT_MAX_DELETE_PCT, maxDeleteKeys = DEFAULT_MAX_DELETE_KEYS } = {}) {
  // At least one key, so a small bucket's single legitimate delete is not refused.
  return Math.min(Math.max(1, Math.floor((bucketCount * maxDeletePct) / 100)), maxDeleteKeys);
}

// ---------------------------------------------------------------------------
// Sync (forward copy, delta, reverse)
// ---------------------------------------------------------------------------

function newBucketSummary() {
  return { listed: 0, to_copy: 0, copied: 0, skipped: 0, bytes_copied: 0, failed: [], refused: [], vanished: [], deletes_planned: 0, deleted: 0, delete_refused: null };
}

/**
 * Forward copy (src -> dst).
 *   opts.buckets: names, or null for every source bucket
 *   opts.state: StateLog (appended)
 *   opts.delta: require a non-empty state (an incremental run must never turn
 *     into a full re-copy because of a wrong --state path)
 *   opts.propagateDeletes: remove dst keys missing at src (guarded; needs delta)
 *
 * Skip rule (resume + delta): state says done, its src_etag/size match the
 * fresh source listing, and the destination listing still holds that key with
 * the recorded dest_etag and size.
 */
export async function copyAll(opts) {
  const { src, dst, state } = opts;
  if (opts.propagateDeletes && !opts.delta) throw new Error("--propagate-deletes needs --delta");
  if (opts.delta && state.size === 0) throw new Error(`--delta refused: state file ${state.path} has no records`);
  const buckets = opts.buckets || await src.listBuckets();
  return syncBuckets({
    ...opts, buckets, direction: "forward",
    needsCopy: (bucket, key, s, d) => {
      const r = state.get(bucket, key);
      return !(r && r.done && r.src_etag === s.etag && r.size === s.size && d && d.etag === r.dest_etag && d.size === r.size);
    },
    deletes: !!opts.propagateDeletes,
  });
}

/**
 * Rollback copy (Garage -> MinIO). `src` is the engine we switched TO, `dst`
 * the old one. forwardState is read-only. A key is copied back when the Garage
 * object is not the one the forward copy put there (no forward record, or its
 * ETag differs from the recorded dest_etag), or when MinIO no longer holds the
 * original. Deletes are always carried (guarded).
 */
export async function reverseAll(opts) {
  const { src, forwardState, state } = opts;
  if (!forwardState || forwardState.size === 0) throw new Error("--reverse needs the forward state file (it holds dest_etag per key)");
  const buckets = opts.buckets || await src.listBuckets();
  return syncBuckets({
    ...opts, buckets, direction: "reverse",
    needsCopy: (bucket, key, s, d) => {
      const f = forwardState.get(bucket, key);
      if (f && f.done && f.dest_etag === s.etag && f.size === s.size && d && d.etag === f.src_etag && d.size === f.size) return false;
      const r = state.get(bucket, key);
      if (r && r.done && r.src_etag === s.etag && r.size === s.size && d && d.etag === r.dest_etag && d.size === r.size) return false;
      return true;
    },
    deletes: true,
  });
}

async function syncBuckets({ src, dst, state, buckets, needsCopy, deletes, direction, concurrency = DEFAULT_CONCURRENCY, partSize = PART_SIZE, uploads = null, ctl = { stopped: false, bodies: new Set() }, retries = 2, retryDelayMs = 1000, maxDeletePct, maxDeleteKeys, dryRun = false, log = () => {}, idleMs }) {
  if (partSize < MIN_PART_SIZE) throw new Error(`partSize must be >= ${MIN_PART_SIZE}`);
  const conc = Math.max(1, Math.min(MAX_CONCURRENCY, concurrency | 0));
  const summary = { direction, started_at: new Date().toISOString(), buckets: {}, bytes_copied: 0, interrupted: false, ok: false };
  const t0 = Date.now();
  const pool = Array.from({ length: conc }, () => null); // lazily allocated part buffers
  for (const bucket of buckets) {
    if (ctl.stopped) break;
    const b = summary.buckets[bucket] = newBucketSummary();
    const sl = await src.list(bucket);
    if (!dryRun) await dst.ensureBucket(bucket);
    const dl = dryRun ? await dst.list(bucket).catch(() => new Map()) : await dst.list(bucket);
    b.listed = sl.size;
    const todo = [];
    for (const [key, s] of sl) {
      if (needsCopy(bucket, key, s, dl.get(key))) todo.push({ key, s }); else b.skipped++;
    }
    b.to_copy = todo.length;
    log(`[${direction}] ${bucket}: ${sl.size} listed, ${todo.length} to copy, ${b.skipped} unchanged`);
    if (!dryRun) {
      await runPool(todo, conc, async ({ key }, w) => {
        pool[w] ||= Buffer.allocUnsafe(partSize);
        for (let attempt = 0; ; attempt++) {
          try {
            const rec = await copyObject({ src, dst, bucket, key, buffer: pool[w], partSize, uploads, ctl, idleMs });
            rec.direction = direction;
            state.append(rec);
            b.copied++; b.bytes_copied += rec.size; summary.bytes_copied += rec.size;
            return;
          } catch (err) {
            if (err.refused) { b.refused.push({ key, reason: err.message }); return; }
            // Deleted at the source after the listing (live source): not a copy
            // failure; the next delta / the verify listings account for it.
            if (err.code === "NoSuchKey" || err.code === "NotFound") { b.vanished.push(key); return; }
            if (ctl.stopped || attempt >= retries) { b.failed.push({ key, error: err.message }); return; }
            await new Promise((r) => setTimeout(r, retryDelayMs * (attempt + 1)));
          }
        }
      }, ctl);
    }
    if (deletes && !ctl.stopped) {
      const extra = [...dl.keys()].filter((k) => !sl.has(k));
      b.deletes_planned = extra.length;
      const limit = deleteLimit(dl.size, { maxDeletePct, maxDeleteKeys });
      if (extra.length > limit) {
        b.delete_refused = { would_delete: extra.length, limit, sample: extra.slice(0, 20) };
        log(`[${direction}] ${bucket}: REFUSED to delete ${extra.length} keys (limit ${limit})`);
      } else if (!dryRun) {
        for (const key of extra) {
          if (ctl.stopped) break;
          await dst.remove(bucket, key);
          state.append({ bucket, key, deleted: true, done: false, direction, at: new Date().toISOString() });
          b.deleted++;
        }
      }
    }
  }
  state.flush();
  summary.interrupted = !!ctl.stopped;
  summary.seconds = (Date.now() - t0) / 1000;
  summary.mb_per_s = summary.seconds > 0 ? +(summary.bytes_copied / 1e6 / summary.seconds).toFixed(1) : 0;
  summary.ok = !summary.interrupted && Object.values(summary.buckets).every((b) => !b.failed.length && !b.refused.length && !b.delete_refused);
  return summary;
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

const SETS = ["missing", "extra", "size_mismatch", "no_state", "stale_state", "bytes_mismatch", "content_short", "content_mismatch",
  "source_mismatch", "metadata_mismatch", "etag_mismatch", "meta_sha256_mismatch", "checksum_missing", "checksum_mismatch", "read_errors"];
const REPORT_CAP = 1000;

function digestMatches(value, hex) {
  const v = String(value || "").trim();
  if (/^[0-9a-f]{64}$/i.test(v)) return v.toLowerCase() === hex;
  try { return Buffer.from(v, "base64").toString("hex") === hex; } catch { return false; }
}

/**
 * Parse an independent checksum list: one "key<TAB>sha256" per line, the
 * hash optionally prefixed "sha256:" (Funkwhale's music_upload.checksum form:
 * `psql -At -F $'\t' -c "SELECT audio_file, checksum FROM music_upload ..."`).
 * A malformed line, an empty list, or one key with two hashes throws.
 */
export function parseChecksums(text, label = "checksums") {
  const map = new Map();
  text.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    const tab = line.lastIndexOf("\t");
    if (tab <= 0) throw new Error(`${label}: line ${i + 1} has no key<TAB>hash`);
    const key = line.slice(0, tab);
    const hex = line.slice(tab + 1).trim().replace(/^sha256:/i, "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`${label}: line ${i + 1} hash is not sha256 hex`);
    if (map.has(key) && map.get(key) !== hex) throw new Error(`${label}: key ${key} listed with two different hashes`);
    map.set(key, hex);
  });
  if (map.size === 0) throw new Error(`${label}: no entries (an empty export cannot prove anything)`);
  return map;
}

/**
 * Verify dst against src with independent evidence:
 *  - key sets from two fresh listings: missing / extra / size_mismatch
 *  - the state record exists and matches the CURRENT source listing, and its
 *    bytes_hashed equals the listed size (catches a stream that ended early)
 *  - every destination object re-read and hashed; equals the state sha256
 *  - optional rereadSource: every source object re-hashed too
 *  - metadata (carried headers) equal on both sides
 *  - ETags compared only when neither side is multipart ("-N")
 *  - x-amz-meta-sha256, where present, equals the computed hash on both sides
 *  - optional per-bucket checksum lists (e.g. Funkwhale's DB) must all match
 * The report's ok is true only if every set is empty, at least one bucket
 * was verified and every common object was hashed.
 */
export async function verifyAll({ src, dst, state, buckets = null, checksums = {}, rereadSource = false, concurrency = DEFAULT_CONCURRENCY, ctl = { stopped: false }, log = () => {}, idleMs = DEFAULT_IDLE_TIMEOUT_MS }) {
  const t0 = Date.now();
  const srcBuckets = await src.listBuckets();
  const list = buckets || srcBuckets;
  const report = { started_at: new Date().toISOString(), source: src.id, dest: dst.id, buckets: {}, extra_buckets: [], unknown_checksum_buckets: [], totals: { objects: 0, hashed: 0, bytes_hashed: 0, etag_compared: 0, etag_skipped_multipart: 0 }, ok: false };
  const conc = Math.max(1, Math.min(MAX_CONCURRENCY, concurrency | 0));
  const destBuckets = await dst.listBuckets();
  if (!buckets) report.extra_buckets = destBuckets.filter((b) => !srcBuckets.includes(b));
  report.unknown_checksum_buckets = Object.keys(checksums).filter((b) => !list.includes(b));
  for (const bucket of list) {
    if (ctl.stopped) break;
    const sets = Object.fromEntries(SETS.map((s) => [s, []]));
    const add = (set, item) => sets[set].push(item);
    const r = { source_count: 0, dest_count: 0, hashed: 0, bytes_hashed: 0, etag_compared: 0, etag_skipped_multipart: 0, checksum_covered: 0, checksum_unreferenced: 0 };
    const sl = await src.list(bucket);
    const dl = destBuckets.includes(bucket) ? await dst.list(bucket) : new Map();
    r.source_count = sl.size; r.dest_count = dl.size;
    const common = [];
    for (const [key, s] of sl) {
      const d = dl.get(key);
      if (!d) { add("missing", key); continue; }
      if (d.size !== s.size) add("size_mismatch", { key, source: s.size, dest: d.size });
      if (!isMultipartEtag(s.etag) && !isMultipartEtag(d.etag)) {
        r.etag_compared++;
        if (s.etag !== d.etag) add("etag_mismatch", { key, source: s.etag, dest: d.etag });
      } else r.etag_skipped_multipart++;
      const rec = state.get(bucket, key);
      if (!rec || !rec.done) add("no_state", key);
      else if (rec.src_etag !== s.etag || rec.size !== s.size) add("stale_state", { key, state: [rec.size, rec.src_etag], source: [s.size, s.etag] });
      else if (rec.bytes_hashed !== s.size) add("bytes_mismatch", { key, bytes_hashed: rec.bytes_hashed, size: s.size });
      common.push({ key, s, d, rec });
    }
    for (const key of dl.keys()) if (!sl.has(key)) add("extra", key);
    const destHash = new Map();
    await runPool(common, conc, async ({ key, d, rec }) => {
      try {
        const { headers: dh, body } = await dst.get(bucket, key);
        const { sha256, bytes } = await hashBody(body, idleMs);
        destHash.set(key, sha256);
        r.hashed++; r.bytes_hashed += bytes;
        if (bytes !== d.size) add("content_short", { key, bytes, size: d.size });
        if (rec && rec.done && rec.sha256 !== sha256) add("content_mismatch", { key, state: rec.sha256, dest: sha256 });
        let sh;
        if (rereadSource) {
          const g = await src.get(bucket, key);
          sh = g.headers;
          const s2 = await hashBody(g.body, idleMs);
          if (s2.sha256 !== sha256 || s2.bytes !== bytes) add("source_mismatch", { key, source: s2.sha256, dest: sha256 });
        } else sh = await src.head(bucket, key);
        let sm, dm;
        try { sm = carriedHeaders(sh); dm = carriedHeaders(dh); }
        catch (e) { add("metadata_mismatch", { key, error: e.message }); }
        if (sm && dm) {
          const names = new Set([...Object.keys(sm), ...Object.keys(dm)]);
          const diff = [...names].filter((n) => sm[n] !== dm[n] && !(n === "content-type" && !sm[n]));
          if (diff.length) add("metadata_mismatch", { key, fields: diff.map((n) => ({ name: n, source: sm[n] ?? null, dest: dm[n] ?? null })) });
          const ms = sm["x-amz-meta-sha256"];
          if (ms != null && !(digestMatches(ms, sha256) && dm["x-amz-meta-sha256"] === ms)) add("meta_sha256_mismatch", { key, meta: ms, dest_meta: dm["x-amz-meta-sha256"] ?? null, computed: sha256 });
        }
      } catch (e) { add("read_errors", { key, error: e.message }); }
    }, ctl);
    const ck = checksums[bucket];
    if (ck) {
      for (const [key, hex] of ck) {
        if (!dl.has(key)) { add("checksum_missing", key); continue; }
        const got = destHash.get(key);
        if (got == null) continue; // already in read_errors or missing at source (extra)
        if (got !== hex) add("checksum_mismatch", { key, expected: hex, dest: got }); else r.checksum_covered++;
      }
      for (const key of dl.keys()) if (!ck.has(key)) r.checksum_unreferenced++;
    }
    const out = { ...r, ok: SETS.every((s) => sets[s].length === 0) && r.hashed === common.length };
    for (const s of SETS) { out[`${s}_count`] = sets[s].length; out[s] = sets[s].slice(0, REPORT_CAP); }
    report.buckets[bucket] = out;
    for (const k of ["hashed", "bytes_hashed", "etag_compared", "etag_skipped_multipart"]) report.totals[k] += r[k];
    report.totals.objects += r.source_count;
    log(`[verify] ${bucket}: ${out.ok ? "OK" : "FAIL"} (${r.hashed}/${common.length} hashed, ${SETS.filter((s) => sets[s].length).map((s) => `${s}=${sets[s].length}`).join(" ") || "all sets empty"})`);
  }
  report.seconds = (Date.now() - t0) / 1000;
  report.mb_per_s = report.seconds > 0 ? +(report.totals.bytes_hashed / 1e6 / report.seconds).toFixed(1) : 0;
  report.interrupted = !!ctl.stopped;
  report.ok = !ctl.stopped && list.length > 0 && Object.keys(report.buckets).length === list.length
    && Object.values(report.buckets).every((b) => b.ok)
    && report.extra_buckets.length === 0 && report.unknown_checksum_buckets.length === 0;
  return report;
}

// ---------------------------------------------------------------------------
// Abort the multipart uploads this tool left open (deadman path)
// ---------------------------------------------------------------------------

export async function abortOpenUploads({ uploads, endpoints }) {
  const byId = new Map(endpoints.filter(Boolean).map((e) => [e.id, e]));
  const out = { aborted: [], skipped_unknown_endpoint: [], errors: [] };
  for (const u of uploads.openUploads()) {
    const ep = byId.get(u.endpoint);
    if (!ep) { out.skipped_unknown_endpoint.push(u); continue; }
    try { await ep.mpAbort(u.bucket, u.key, u.uploadId); uploads.close(u.endpoint, u.bucket, u.key, u.uploadId, "aborted-by-abort-incomplete"); out.aborted.push(u); }
    catch (e) { out.errors.push({ ...u, error: e.message }); }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Content-addressed directory check (artifacts local store, plan §5.3 a)
// ---------------------------------------------------------------------------

export async function checkContentAddressedDir(dir) {
  const out = { dir, files: 0, ok: false, bad: [], skipped: [] };
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (!st.isFile()) { out.skipped.push(name); continue; }
    out.files++;
    if (!/^[0-9a-f]{64}$/.test(name)) { out.bad.push({ name, error: "name is not sha256 hex" }); continue; }
    const { sha256 } = await hashBody(createReadStream(p));
    if (sha256 !== name) out.bad.push({ name, sha256 });
  }
  out.ok = out.files > 0 && out.bad.length === 0;
  return out;
}

/** Write JSON atomically (tmp + rename), mode 600. */
export function writeJsonAtomic(path, obj) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}
