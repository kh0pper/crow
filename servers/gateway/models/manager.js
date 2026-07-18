/**
 * GGUF model download pipeline (Item G, native model runtime, Task 6).
 *
 * This is the first half of the "manager" module — downloads only. Task 7
 * extends this same file with provider registration (turning a downloaded
 * blob into a running llama.cpp provider row); the seam is deliberately
 * kept clean: everything above `// --- provider registration (Task 7) ---`
 * (not present yet) only ever touches the filesystem + `state.js`'s
 * `journal` map, never the DB.
 *
 * Two layers:
 *
 *   - `fetchModelBlob()` — the raw download engine. Given a ready URL and a
 *     destination path, it streams the response straight to disk (NEVER
 *     buffered whole in memory), hashes incrementally with a single
 *     `crypto.createHash("sha256")` fed from the same chunks as they're
 *     written, follows redirects manually (checking the host allowlist on
 *     EVERY hop, not just the first), and re-hashes an on-disk prefix from
 *     scratch when resuming (a streaming hash object has no way to "resume"
 *     — the only way to get a correct final digest after a partial file is
 *     to re-feed the bytes already on disk into a fresh hash before
 *     appending the rest). Knows nothing about `state.js` or catalogs.
 *
 *   - `downloadModel()` — the orchestrator. Resolves a catalog entry to a
 *     URL + a sanitized on-disk destination, consults the journal (from
 *     `state.js`) to decide whether this is a fresh download or a resume,
 *     and journals progress (throttled) back through `loadState`/
 *     `saveState` so a killed process can pick up where it left off. This
 *     is the layer real callers (the model panel, Task 7's provider
 *     registration) use.
 *
 * `enqueueDownload()` is a module-level serial queue over `downloadModel`:
 * concurrency defaults to 1 and is honored up to a max of 2 via
 * `CROW_MODEL_DL_CONCURRENCY` — GGUF downloads are multi-gigabyte and this
 * host's disk/network don't benefit from more parallelism than that, and
 * unbounded concurrency would let a chatty panel starve every download of
 * bandwidth at once.
 *
 * `dir` is always injected by the caller (same convention as `state.js`:
 * production passes `resolveDataDir()`, tests pass an `fs.mkdtempSync`
 * scratch dir) — this module never guesses a path itself.
 */

import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream as fsCreateWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  statSync,
  truncateSync,
  unlinkSync,
} from "node:fs";
import http from "node:http";
import https from "node:https";
import { basename, join } from "node:path";

import { loadState, saveState } from "./state.js";

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

/** Thrown when a URL (initial or any redirect hop) resolves to a host
 * outside the allowlist — see `isAllowedHost`. */
export class HostNotAllowedError extends Error {
  constructor(hostname) {
    super(`Host not allowed for model download: ${hostname}`);
    this.name = "HostNotAllowedError";
    this.code = "HOST_NOT_ALLOWED";
    this.hostname = hostname;
  }
}

/** Thrown when the completed download's sha256 does not match the
 * catalog's `expectedSha`. The partial/completed file is deleted before
 * this is thrown — a mismatched blob is never left on disk to be
 * mistaken for a good one. */
export class ChecksumError extends Error {
  constructor(expectedSha, actualSha) {
    super(`Checksum mismatch: expected ${expectedSha}, got ${actualSha}`);
    this.name = "ChecksumError";
    this.code = "CHECKSUM_MISMATCH";
    this.expectedSha = expectedSha;
    this.actualSha = actualSha;
  }
}

/** Thrown when the write stream fails with ENOSPC. Unlike ChecksumError,
 * the partial file is deliberately KEPT on disk so a later call can
 * resume once space is freed. */
export class DiskFullError extends Error {
  constructor(cause) {
    super("No space left on device while writing model file");
    this.name = "DiskFullError";
    this.code = "DISK_FULL";
    if (cause) this.cause = cause;
  }
}

/** Thrown when the resolved destination path already exists as a symlink
 * (refuse to write/append through it — could point anywhere on the host),
 * or when a catalog filename would resolve outside the injected models
 * directory. */
export class UnsafeDestinationError extends Error {
  constructor(message) {
    super(message);
    this.name = "UnsafeDestinationError";
    this.code = "UNSAFE_DESTINATION";
  }
}

// ---------------------------------------------------------------------------
// Host allowlist
// ---------------------------------------------------------------------------

const ALLOWED_HOST_EXACT = new Set(["huggingface.co"]);
const ALLOWED_HOST_SUFFIXES = [".huggingface.co", ".hf.co"];

/**
 * True iff `hostname` is exactly "huggingface.co", a subdomain of
 * huggingface.co, or a subdomain of hf.co. Suffix match requires a
 * literal "." boundary — `String.endsWith(".huggingface.co")` — so
 * "evilhuggingface.co" (no dot before the label) correctly fails; a bare
 * "hf.co" apex also fails (only ".hf.co" is in the suffix list, "hf.co"
 * itself is not in the exact set — intentional, matches the spec's
 * allowlist literally).
 */
export function isAllowedHost(hostname) {
  if (typeof hostname !== "string" || hostname.length === 0) return false;
  const host = hostname.toLowerCase();
  if (ALLOWED_HOST_EXACT.has(host)) return true;
  return ALLOWED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Build a Hugging Face "resolve" download URL. `baseUrl` defaults to the
 * real huggingface.co origin and is only ever overridden by tests (to
 * point at a local fixture server while keeping the hostname text — and
 * therefore the allowlist check — realistic). */
export function buildDownloadUrl(hfRepo, file, baseUrl = "https://huggingface.co") {
  return `${baseUrl}/${hfRepo}/resolve/main/${file}`;
}

/** Reduce a catalog filename to a safe, flat basename: no directories, no
 * traversal. Catalog files are curated (Task 2's validator already gates
 * them), but this is defense in depth — a destination path is always
 * `<modelsDir>/<sanitizeFilename(file)>`, never anything the filename
 * string itself could redirect elsewhere. */
export function sanitizeFilename(name) {
  const base = basename(String(name ?? ""));
  if (!base || base === "." || base === "..") {
    throw new UnsafeDestinationError(`Unsafe model filename: ${JSON.stringify(name)}`);
  }
  return base;
}

/** Look up a model + quant entry in a parsed model-catalog.json object.
 * `quant` defaults to the model's `default_quant`. */
export function resolveEntry(catalog, modelId, quant) {
  const model = (catalog?.models || []).find((m) => m.id === modelId);
  if (!model) throw new Error(`Unknown model id in catalog: ${modelId}`);
  const quantId = quant || model.default_quant;
  const quantEntry = (model.quants || []).find((q) => q.quant === quantId);
  if (!quantEntry) throw new Error(`Unknown quant "${quantId}" for model ${modelId}`);
  return { model, quantEntry };
}

function assertNotSymlink(dest) {
  let st;
  try {
    st = lstatSync(dest);
  } catch (err) {
    if (err && err.code === "ENOENT") return;
    throw err;
  }
  if (st.isSymbolicLink()) {
    throw new UnsafeDestinationError(`Refusing to write through symlink at destination: ${dest}`);
  }
}

function parseTotalBytes(headers, resumeFrom) {
  const contentRange = headers["content-range"];
  if (contentRange) {
    const m = /\/(\d+)\s*$/.exec(String(contentRange));
    if (m) return Number(m[1]);
  }
  const contentLength = headers["content-length"];
  if (contentLength != null) return resumeFrom + Number(contentLength);
  return null;
}

// ---------------------------------------------------------------------------
// Layer 1: raw download engine
// ---------------------------------------------------------------------------

function requestOnce(urlStr, { headers, lookup }) {
  return new Promise((resolvePromise, reject) => {
    const urlObj = new URL(urlStr);
    const transport = urlObj.protocol === "https:" ? https : http;
    const req = transport.request(urlObj, { method: "GET", headers, lookup }, (res) => {
      resolvePromise({ req, res });
    });
    req.on("error", reject);
    req.end();
  });
}

/** Follow redirects manually, re-checking the host allowlist on every hop
 * (including the first) before connecting. Returns the final 200/206
 * response. `maxRedirects` bounds the number of redirect hops (not
 * counting the initial request). */
async function openStream({ url, headers, lookup, maxRedirects }) {
  let currentUrl = url;
  // eslint-disable-next-line no-await-in-loop -- redirect hops are
  // inherently sequential: each hop's Location header depends on the
  // previous response, and each hop must be allowlist-checked before the
  // NEXT connection is made — parallelizing would defeat the check.
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const urlObj = new URL(currentUrl);
    if (!isAllowedHost(urlObj.hostname)) {
      throw new HostNotAllowedError(urlObj.hostname);
    }
    // eslint-disable-next-line no-await-in-loop
    const { res } = await requestOnce(currentUrl, { headers, lookup });
    if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
      res.resume(); // discard redirect body
      const location = res.headers.location;
      if (!location) {
        throw new Error(`Redirect response (${res.statusCode}) with no Location header from ${currentUrl}`);
      }
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    if (res.statusCode !== 200 && res.statusCode !== 206) {
      res.resume();
      throw new Error(`Unexpected HTTP status ${res.statusCode} downloading ${currentUrl}`);
    }
    return { res, finalUrl: currentUrl };
  }
  throw new Error(`Too many redirects (> ${maxRedirects}) downloading ${url}`);
}

/** Re-hash the on-disk prefix `[0, resumeFrom)` of `dest` into `hash`
 * (streamed, not buffered whole). Must run BEFORE any new bytes are
 * appended — a streaming hash object has no "seek", so the only way to
 * get a correct final digest is to replay the existing prefix through a
 * fresh hash first. */
function rehashPrefix(dest, resumeFrom, hash) {
  if (resumeFrom <= 0) return Promise.resolve();
  return new Promise((resolvePromise, reject) => {
    const rs = createReadStream(dest, { start: 0, end: resumeFrom - 1 });
    rs.on("data", (chunk) => hash.update(chunk));
    rs.on("end", resolvePromise);
    rs.on("error", reject);
  });
}

function streamToFile({ res, dest, resumeFrom, hash, onBytes, createWriteStream }) {
  return new Promise((resolvePromise, reject) => {
    const writeStream = createWriteStream(dest, {
      flags: resumeFrom > 0 ? "r+" : "w",
      start: resumeFrom,
    });
    let bytesDone = resumeFrom;
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      err.bytesDone = bytesDone;
      try { res.destroy(); } catch { /* already gone */ }
      try { writeStream.destroy(); } catch { /* already gone */ }
      reject(err);
    };

    res.on("data", (chunk) => {
      if (settled) return;
      hash.update(chunk);
      bytesDone += chunk.length;
      const ok = writeStream.write(chunk);
      onBytes(bytesDone);
      if (!ok) {
        res.pause();
        writeStream.once("drain", () => res.resume());
      }
    });
    res.on("error", fail);
    res.on("aborted", () => fail(new Error("Download aborted by remote server")));
    res.on("close", () => {
      if (!settled && res.complete === false) {
        fail(new Error("Connection closed before response completed"));
      }
    });

    writeStream.on("error", (err) => {
      if (err && err.code === "ENOSPC") fail(new DiskFullError(err));
      else fail(err);
    });

    res.on("end", () => {
      if (settled) return;
      settled = true;
      writeStream.end(() => resolvePromise({ bytesDone }));
    });
  });
}

/**
 * Raw download engine: stream `url` to `dest`, hashing incrementally,
 * honoring the host allowlist on every hop, resuming from `resumeFrom`
 * bytes (re-hashing the on-disk prefix first) when given a nonzero
 * `resumeFrom`. Never buffers the whole file in memory.
 *
 * Options:
 *   - `lookup`: injected DNS resolver (Node's standard http/https request
 *     option) — production leaves it unset (real DNS); tests pass one that
 *     forces every hostname to 127.0.0.1 so allowlist tests can use real
 *     hostnames (huggingface.co, evil.example.com, ...) against a local
 *     fixture server with zero real network traffic.
 *   - `createWriteStream`: injected write-stream factory, defaults to
 *     `fs.createWriteStream` — tests override it to force an ENOSPC error
 *     deterministically instead of actually filling the disk.
 *
 * Returns `{ path, sha256, bytesDone }`. Throws `HostNotAllowedError`,
 * `ChecksumError` (dest already deleted), or `DiskFullError` (dest KEPT
 * for resume) as documented above; any other stream error is rethrown
 * as-is with a `.bytesDone` property attached so callers can journal
 * progress before propagating.
 */
export async function fetchModelBlob({
  url,
  dest,
  resumeFrom = 0,
  expectedSha,
  onProgress,
  lookup,
  maxRedirects = 5,
  createWriteStream = fsCreateWriteStream,
}) {
  assertNotSymlink(dest);

  const hash = createHash("sha256");
  const onDiskSize = existsSync(dest) ? statSync(dest).size : 0;
  const effectiveResumeFrom = Math.min(resumeFrom, onDiskSize);
  if (effectiveResumeFrom > 0) {
    truncateSync(dest, effectiveResumeFrom);
    await rehashPrefix(dest, effectiveResumeFrom, hash);
  }

  const headers = {};
  if (effectiveResumeFrom > 0) headers.Range = `bytes=${effectiveResumeFrom}-`;

  const { res } = await openStream({ url, headers, lookup, maxRedirects });
  const totalBytes = parseTotalBytes(res.headers, effectiveResumeFrom);

  let bytesDone;
  try {
    ({ bytesDone } = await streamToFile({
      res,
      dest,
      resumeFrom: effectiveResumeFrom,
      hash,
      createWriteStream,
      onBytes: (n) => {
        bytesDone = n;
        if (typeof onProgress === "function") onProgress({ bytesDone: n, totalBytes });
      },
    }));
  } catch (err) {
    if (typeof err.bytesDone !== "number") err.bytesDone = bytesDone ?? effectiveResumeFrom;
    throw err;
  }

  const sha256 = hash.digest("hex");
  if (expectedSha && sha256.toLowerCase() !== String(expectedSha).toLowerCase()) {
    try { unlinkSync(dest); } catch { /* best effort */ }
    throw new ChecksumError(expectedSha, sha256);
  }
  return { path: dest, sha256, bytesDone };
}

// ---------------------------------------------------------------------------
// Layer 2: catalog + journal orchestration
// ---------------------------------------------------------------------------

function modelsBlobDir(dir) {
  return join(dir, "models", "blobs");
}

/**
 * Download a model's quant file, journaling progress to `state.js` so a
 * killed/restarted process can resume. See module doc for the full
 * contract; `dir` is the injected CROW_HOME/data dir (never guessed).
 *
 * `baseUrl` and `lookup` exist purely for tests — production never sets
 * them (real huggingface.co, real DNS).
 */
export async function downloadModel({
  modelId,
  quant,
  dir,
  catalog,
  onProgress,
  lookup,
  baseUrl,
  maxRedirects = 5,
  createWriteStream,
  journalIntervalMs = 1000,
}) {
  const { model, quantEntry } = resolveEntry(catalog, modelId, quant);
  const blobDir = modelsBlobDir(dir);
  mkdirSync(blobDir, { recursive: true });
  const dest = join(blobDir, sanitizeFilename(quantEntry.file));
  assertNotSymlink(dest);

  const url = baseUrl ? buildDownloadUrl(model.hf_repo, quantEntry.file, baseUrl) : buildDownloadUrl(model.hf_repo, quantEntry.file);
  const expectedSha = quantEntry.sha256 || null;

  const initialState = loadState(dir);
  const existingEntry = initialState.journal[modelId];
  const resumeFrom = existingEntry && existingEntry.url === url && existingEntry.dest === dest ? existingEntry.bytesDone || 0 : 0;
  const startedAt = (existingEntry && existingEntry.url === url && existingEntry.dest === dest && existingEntry.startedAt) || new Date().toISOString();

  // Seed/refresh the journal entry immediately, before any network I/O, so
  // even an interruption in the first instant leaves a resumable record.
  initialState.journal[modelId] = { url, dest, bytesDone: resumeFrom, expectedSha, startedAt };
  saveState(dir, initialState);

  // Persisting reloads state fresh each time (rather than reusing one
  // in-memory object across the whole download) to minimize — though not
  // fully eliminate — clobbering a concurrent download's journal entry
  // when CROW_MODEL_DL_CONCURRENCY=2. state.json has no real locking; this
  // is a known, accepted v1 limitation (matches state.js's own
  // documented tradeoffs), not something this task solves.
  const persistJournal = (bytesDone) => {
    const s = loadState(dir);
    s.journal[modelId] = { url, dest, bytesDone, expectedSha, startedAt };
    saveState(dir, s);
  };

  let lastSave = Date.now();
  const wrappedOnProgress = ({ bytesDone, totalBytes }) => {
    if (typeof onProgress === "function") onProgress({ bytesDone, totalBytes });
    const now = Date.now();
    if (now - lastSave >= journalIntervalMs) {
      lastSave = now;
      persistJournal(bytesDone);
    }
  };

  try {
    const result = await fetchModelBlob({
      url,
      dest,
      resumeFrom,
      expectedSha,
      lookup,
      maxRedirects,
      createWriteStream,
      onProgress: wrappedOnProgress,
    });
    const s = loadState(dir);
    delete s.journal[modelId];
    saveState(dir, s);
    return { path: result.path, sha256: result.sha256 };
  } catch (err) {
    if (err instanceof ChecksumError) {
      // fetchModelBlob already deleted the bad file — the journal entry
      // for it is equally stale, drop it rather than offering a "resume"
      // that would just re-download from scratch anyway.
      const s = loadState(dir);
      delete s.journal[modelId];
      saveState(dir, s);
      throw err;
    }
    // Any other failure (host refused, interrupted connection, disk full,
    // ...): flush the latest known bytesDone unconditionally, bypassing
    // the throttle, so a subsequent call always resumes from an accurate
    // point rather than losing up to journalIntervalMs of progress.
    const bytesDone = typeof err.bytesDone === "number" ? err.bytesDone : resumeFrom;
    persistJournal(bytesDone);
    throw err;
  }
}

/**
 * Remove a downloaded model's blob (and its journal entry, if any) from
 * `dir`. Task 7 extends this to also unregister the corresponding
 * provider row; this task's version only ever touches the filesystem +
 * `state.js`.
 */
export function deleteModel({ modelId, quant, dir, catalog }) {
  const { quantEntry } = resolveEntry(catalog, modelId, quant);
  const dest = join(modelsBlobDir(dir), sanitizeFilename(quantEntry.file));

  let deleted = false;
  try {
    unlinkSync(dest);
    deleted = true;
  } catch (err) {
    if (err && err.code !== "ENOENT") throw err;
  }

  const state = loadState(dir);
  if (state.journal[modelId]) {
    delete state.journal[modelId];
    saveState(dir, state);
  }

  return { path: dest, deleted };
}

// ---------------------------------------------------------------------------
// Module-level serial download queue
// ---------------------------------------------------------------------------

const downloadQueue = [];
let activeDownloads = 0;

/** Concurrency for `enqueueDownload`: `CROW_MODEL_DL_CONCURRENCY`, clamped
 * to [1, 2]. Non-numeric/missing/less-than-1 falls back to 1. */
export function getDownloadConcurrency() {
  const raw = Number.parseInt(process.env.CROW_MODEL_DL_CONCURRENCY, 10);
  if (!Number.isFinite(raw) || raw < 1) return 1;
  return Math.min(raw, 2);
}

function pumpDownloadQueue() {
  while (activeDownloads < getDownloadConcurrency() && downloadQueue.length > 0) {
    const job = downloadQueue.shift();
    activeDownloads++;
    downloadModel(job.params).then(
      (result) => {
        activeDownloads--;
        job.resolve(result);
        pumpDownloadQueue();
      },
      (err) => {
        activeDownloads--;
        job.reject(err);
        pumpDownloadQueue();
      },
    );
  }
}

/**
 * Enqueue a `downloadModel(params)` call on the module-level serial queue.
 * With the default concurrency of 1, two enqueued downloads never overlap
 * — the second's HTTP request is not opened until the first has fully
 * settled (resolved or rejected).
 */
export function enqueueDownload(params) {
  return new Promise((resolvePromise, reject) => {
    downloadQueue.push({ params, resolve: resolvePromise, reject });
    pumpDownloadQueue();
  });
}
