/**
 * GGUF model download + registration pipeline (Item G, native model
 * runtime, Tasks 6-7).
 *
 * Everything above `// --- provider registration (Task 7) ---` is the
 * download engine (Task 6) — it only ever touches the filesystem +
 * `state.js`'s `journal` map, never the DB. Below that marker, Task 7 turns
 * a downloaded blob into a running llama.cpp provider row (`registerModel`),
 * tears one down (`unregisterModel`), and answers "what points at this
 * provider" for the delete-confirmation dialog (`providerBindings`).
 *
 * Two layers (Task 6, downloads):
 *
 *   - `fetchModelBlob()` — the raw download engine. Given a ready URL and a
 *     destination path, it streams the response straight to disk (NEVER
 *     buffered whole in memory), hashes incrementally with a single
 *     `crypto.createHash("sha256")` fed from the same chunks as they're
 *     written, follows redirects manually (checking the host allowlist on
 *     EVERY hop, not just the first, and rejecting any non-https hop outside an
 *     explicit test-only escape — a bare hostname check alone would still
 *     let a plain `http:` URL through, or let a redirect silently downgrade
 *     an https request to http), and re-hashes an on-disk prefix from
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
 * bandwidth at once. It is also idempotent per `modelId`: a second enqueue
 * for a model already queued/downloading returns the SAME promise rather
 * than starting a second writer on the same destination file.
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

import { allocatePort, loadState, releasePort, saveState } from "./state.js";
import { disableProvider, listProvidersAll, upsertProvider } from "../../shared/providers-db.js";
import { invalidateProvidersCache } from "../../shared/providers.js";

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

/** Shared typed error for redirect-handling protocol violations: a
 * non-https URL at a hop that isn't explicitly test-escaped (see
 * `insecureHttpHosts`), a redirect response with no Location header, or
 * exceeding `maxRedirects`. `code` distinguishes the three cases so
 * callers can tell them apart without string-matching `message`. */
export class DownloadProtocolError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "DownloadProtocolError";
    this.code = code;
  }
}

/** Thrown when a GGUF download's underlying socket sits idle (no bytes
 * sent or received) for longer than `timeoutMs` — final-review fix wave,
 * Fix 4 (IMPORTANT). Mirrors `runtime.js`'s `RuntimeDownloadTimeoutError`
 * as its own distinct type (not a `DownloadProtocolError` — a stalled
 * connection is not a protocol violation, it's a liveness failure) so
 * callers can tell the two apart without string-matching `message`. Two
 * phases are covered independently: a connect/header-wait stall (before
 * any response arrives — Node's own per-request socket `timeout` option,
 * `requestOnce`'s `req.on("timeout", ...)`) and a stalled body mid-stream
 * (after headers, `streamToFile`'s own JS-level idle timer, reset on every
 * `res` `"data"` event — deliberately NOT reusing Node's socket-timeout
 * event for this phase, since that event stays armed for the socket's
 * whole lifetime and racing it against a second, independent watchdog
 * would make which typed error wins nondeterministic; see `requestOnce`'s
 * `req.setTimeout(0)` call once headers arrive). Like `DiskFullError` (and
 * unlike `ChecksumError`), the partial file is deliberately KEPT on disk —
 * `downloadModel`'s journal already makes a timeout resumable, exactly
 * like any other mid-download failure. */
export class DownloadTimeoutError extends Error {
  constructor(url, timeoutMs) {
    super(`Download stalled (no socket activity for ${timeoutMs}ms): ${url}`);
    this.name = "DownloadTimeoutError";
    this.code = "DOWNLOAD_TIMEOUT";
    this.url = url;
    this.timeoutMs = timeoutMs;
  }
}

/** Default socket-idle timeout for a GGUF download hop (~120s, matching
 * `runtime.js`'s `DEFAULT_RUNTIME_DOWNLOAD_TIMEOUT_MS`). Injectable end to
 * end via `fetchModelBlob({ timeoutMs })` / `downloadModel({ timeoutMs })`. */
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 120_000;

/** Thrown by `registerModel` when a provider row already exists at the
 * target id and was NOT registered by this native runtime for this catalog
 * model — e.g. a user's cloud/bundle provider that happens to share the
 * catalog's model id. Registration refuses to overwrite it: no upsert is
 * attempted and no port reservation is left behind (the port is allocated
 * AFTER this check passes, never before). */
export class ProviderIdConflictError extends Error {
  constructor(modelId) {
    super(`A provider with id "${modelId}" already exists and was not registered by this native runtime for this model — refusing to overwrite it.`);
    this.name = "ProviderIdConflictError";
    this.code = "PROVIDER_ID_CONFLICT";
    this.modelId = modelId;
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

/**
 * `timeoutMs`, if given, arms Node's per-request socket-idle timer for the
 * connect/header-wait phase ONLY: once headers arrive (the response
 * callback fires), `req.setTimeout(0)` disarms it immediately — body-phase
 * stalls are watched independently by `streamToFile`'s own JS-level idle
 * timer (see `DownloadTimeoutError`'s doc for why two independent
 * mechanisms, not one shared across both phases).
 */
function requestOnce(urlStr, { headers, lookup, timeoutMs }) {
  return new Promise((resolvePromise, reject) => {
    const urlObj = new URL(urlStr);
    const transport = urlObj.protocol === "https:" ? https : http;
    const req = transport.request(urlObj, { method: "GET", headers, lookup, timeout: timeoutMs }, (res) => {
      req.setTimeout(0);
      resolvePromise({ req, res });
    });
    if (timeoutMs) {
      req.once("timeout", () => {
        req.destroy(new DownloadTimeoutError(urlStr, timeoutMs));
      });
    }
    req.on("error", reject);
    req.end();
  });
}

/** Follow redirects manually, re-checking the host allowlist AND the
 * https-only protocol requirement on every hop (including the first)
 * before connecting. Returns the final 200/206 response. `maxRedirects`
 * bounds the number of redirect hops (not counting the initial request).
 *
 * `insecureHttpHosts` is a test-only escape (default `[]`, i.e. https is
 * required everywhere in production): a hop whose URL is `http:` is only
 * allowed through when its hostname is literally in this list. Without
 * this, a plain `http:` URL to an allowlisted host would download fine,
 * and — worse — a redirect could silently downgrade an https request to
 * http on any later hop; checking protocol independently on every hop
 * (not just validating the initial URL) closes both holes. */
async function openStream({ url, headers, lookup, maxRedirects, insecureHttpHosts = [], timeoutMs }) {
  let currentUrl = url;
  // eslint-disable-next-line no-await-in-loop -- redirect hops are
  // inherently sequential: each hop's Location header depends on the
  // previous response, and each hop must be allowlist/protocol-checked
  // before the NEXT connection is made — parallelizing would defeat that.
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const urlObj = new URL(currentUrl);
    if (!isAllowedHost(urlObj.hostname)) {
      throw new HostNotAllowedError(urlObj.hostname);
    }
    if (urlObj.protocol !== "https:") {
      const escaped = urlObj.protocol === "http:" && insecureHttpHosts.includes(urlObj.hostname);
      if (!escaped) {
        throw new DownloadProtocolError(
          `Refusing non-https URL (${urlObj.protocol}) for host ${urlObj.hostname} — pass insecureHttpHosts to explicitly allow this host (tests only; never set in production)`,
          "INSECURE_PROTOCOL",
        );
      }
    }
    // eslint-disable-next-line no-await-in-loop
    const { res } = await requestOnce(currentUrl, { headers, lookup, timeoutMs });
    if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
      res.resume(); // discard redirect body
      const location = res.headers.location;
      if (!location) {
        throw new DownloadProtocolError(
          `Redirect response (${res.statusCode}) with no Location header from ${currentUrl}`,
          "REDIRECT_NO_LOCATION",
        );
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
  throw new DownloadProtocolError(`Too many redirects (> ${maxRedirects}) downloading ${url}`, "TOO_MANY_REDIRECTS");
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

/**
 * `timeoutMs`, if given, arms an idle watchdog (Fix 4, final-review fix
 * wave) that resets on every `res` `"data"` event: if `timeoutMs` elapses
 * with no bytes received, `fail()`s with a `DownloadTimeoutError` — the
 * body-phase half of the two-phase mechanism `requestOnce`'s doc describes
 * (this half is a plain JS timer, deliberately independent of Node's own
 * socket-timeout event, which `requestOnce` disarms once headers arrive).
 * `url` is passed through only for the error message.
 */
function streamToFile({ res, dest, resumeFrom, hash, onBytes, createWriteStream, timeoutMs, url }) {
  return new Promise((resolvePromise, reject) => {
    const writeStream = createWriteStream(dest, {
      flags: resumeFrom > 0 ? "r+" : "w",
      start: resumeFrom,
    });
    let bytesDone = resumeFrom;
    let settled = false;
    let idleTimer = null;

    const clearIdleTimer = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearIdleTimer();
      err.bytesDone = bytesDone;
      try { res.destroy(); } catch { /* already gone */ }
      try { writeStream.destroy(); } catch { /* already gone */ }
      reject(err);
    };

    const resetIdleTimer = () => {
      if (!timeoutMs) return;
      clearIdleTimer();
      idleTimer = setTimeout(() => fail(new DownloadTimeoutError(url, timeoutMs)), timeoutMs);
    };
    resetIdleTimer(); // start the clock immediately — a body that never sends a first byte is also a stall

    res.on("data", (chunk) => {
      if (settled) return;
      resetIdleTimer();
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
      clearIdleTimer();
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
 *   - `insecureHttpHosts`: test-only escape from the https-only
 *     requirement (default `[]` — https is mandatory everywhere in
 *     production). See `openStream` doc for why every hop is checked
 *     independently.
 *   - `timeoutMs`: socket-idle timeout (final-review fix wave, Fix 4),
 *     default `DEFAULT_DOWNLOAD_TIMEOUT_MS` (120s) — covers both a
 *     connect/header-wait stall and a stalled body mid-stream (see
 *     `DownloadTimeoutError`'s doc for the two-phase mechanism). Without
 *     this, a dropped/black-holed TCP connection left the download's
 *     promise (and everything awaiting it, including `enqueueDownload`'s
 *     serial queue) unsettled forever.
 *
 * Returns `{ path, sha256, bytesDone }`. Throws `HostNotAllowedError`,
 * `DownloadProtocolError` (insecure protocol / bad redirect), `ChecksumError`
 * (dest already deleted), `DiskFullError`, or `DownloadTimeoutError` (both
 * dest KEPT for resume) as documented above; any other stream error is
 * rethrown as-is with a `.bytesDone` property attached so callers can
 * journal progress before propagating.
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
  insecureHttpHosts = [],
  timeoutMs = DEFAULT_DOWNLOAD_TIMEOUT_MS,
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

  const { res } = await openStream({ url, headers, lookup, maxRedirects, insecureHttpHosts, timeoutMs });
  const totalBytes = parseTotalBytes(res.headers, effectiveResumeFrom);

  let bytesDone;
  try {
    ({ bytesDone } = await streamToFile({
      res,
      dest,
      resumeFrom: effectiveResumeFrom,
      hash,
      createWriteStream,
      timeoutMs,
      url,
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
 * `baseUrl`, `lookup`, and `insecureHttpHosts` exist purely for tests —
 * production never sets them (real huggingface.co, real DNS, https
 * required everywhere). `timeoutMs` (Fix 4) passes through to
 * `fetchModelBlob`'s socket-idle timeout — default `DEFAULT_DOWNLOAD_TIMEOUT_MS`
 * unless overridden.
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
  insecureHttpHosts,
  timeoutMs,
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
      insecureHttpHosts,
      timeoutMs,
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
const inFlightByModelId = new Map();

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
 *
 * Idempotent per `modelId`: calling this again for a `modelId` that
 * already has a job queued or running returns the SAME promise instead of
 * enqueueing a second job. Without this, `CROW_MODEL_DL_CONCURRENCY=2`
 * (or even concurrency 1 with two rapid calls before the first is
 * dequeued) could run two downloads for the same model concurrently —
 * two writers racing on the same `dest` file. The dedup entry is cleared
 * once the job settles, so a later call (after completion) starts a
 * genuinely fresh job.
 */
export function enqueueDownload(params) {
  const key = params && params.modelId;
  if (key && inFlightByModelId.has(key)) {
    return inFlightByModelId.get(key);
  }
  const promise = new Promise((resolvePromise, reject) => {
    downloadQueue.push({ params, resolve: resolvePromise, reject });
    pumpDownloadQueue();
  });
  if (key) {
    const tracked = promise.finally(() => {
      if (inFlightByModelId.get(key) === tracked) inFlightByModelId.delete(key);
    });
    inFlightByModelId.set(key, tracked);
    return tracked;
  }
  return promise;
}

// ---------------------------------------------------------------------------
// --- provider registration (Task 7) ---
// ---------------------------------------------------------------------------
//
// This section turns a downloaded GGUF into a running provider row and
// tears it back down. Real-schema facts this code was written against
// (`scripts/init-db.js`, `servers/shared/providers-db.js` — read those
// files before changing any of this):
//
//   - `providers` has NO hard-delete helper — only `disableProvider(db, id)`
//     (soft-delete: `disabled = 1`, preserves history for instance-sync).
//     `unregisterModel`'s "delete provider row" step is therefore a soft
//     delete, matching every other provider-removal path in this codebase
//     (`unregisterProvidersByBundle`) rather than inventing a hard DELETE.
//   - `providers.gpu_policy` is a TEXT column added by a later migration
//     (`addColumnIfMissing`, not the original CREATE TABLE) holding a JSON
//     blob — there is no dedicated "runtime" or "mutex_group" column, so
//     "native" marking and the mutex group both ride inside that JSON, per
//     the task spec's "no schema changes" constraint.
//   - There is no `ai_profiles` or `bots` TABLE. AI chat profiles are a
//     JSON array stored at `dashboard_settings.value` under
//     `key = 'ai_profiles'` (see `servers/gateway/dashboard/settings/
//     sections/llm/ai-profiles.js`); a pointer-mode profile carries
//     `provider_id` (+ `model_id`) directly. Bots are rows in
//     `pi_bot_defs(bot_id, display_name, definition, ...)` where
//     `definition` is a JSON blob whose `models.default` / `models.escalation`
//     / `fast_voice_model` fields hold `"<providerId>/<modelId>"` strings
//     (see `servers/gateway/dashboard/panels/bot-builder/data-queries.js`
//     `loadModelOptions` — it builds exactly that key shape). `providerBindings`
//     below reads both real locations directly; there was no queryable
//     `provider_id` column to join against for bots.
//
// A registered model's provider `id` is the catalog `modelId` itself (e.g.
// "qwen3-4b") — stable, already namespaced by the curated catalog, and the
// natural key `state.js`'s `registry` map and `reconcileOnBoot`'s
// `listProviderRows().modelId` shaping both key off of.

/** Runtime marker + provider id → catalog model id, unused elsewhere. */
const NATIVE_RUNTIME = "native";

/** Default mutex group for a chat-class native model when no existing
 * enabled provider row (native or otherwise) already claims a chat-class
 * mutex group to join. */
const DEFAULT_CHAT_MUTEX_GROUP = "local-llm";

/**
 * A provider row (as returned by `listProvidersAll`) counts as a
 * "chat-class member" of its mutex group when at least one of its `models[]`
 * entries carries `task === "chat"`. Rows without a mutex group, disabled
 * rows, and rows with no chat-tagged model entries are not counted.
 */
function isChatClassRow(row) {
  return Array.isArray(row.models) && row.models.some((m) => m && m.task === "chat");
}

/**
 * mutexGroup rule for a newly-registering chat-class model (spec verbatim):
 * join the existing group with the most chat-class members; if no enabled
 * provider row has any chat-class member in a group, fall back to
 * `DEFAULT_CHAT_MUTEX_GROUP`. Ties keep the first group encountered in
 * `existingRows` order (stable — `listProvidersAll` orders by
 * `disabled ASC, id`, so ties resolve alphabetically by provider id).
 * Pure function of the rows already in the registry — the row being
 * registered is never included (call this BEFORE inserting it).
 */
export function pickChatMutexGroup(existingRows) {
  const counts = new Map();
  for (const row of existingRows) {
    if (row.disabled) continue;
    const group = row.gpuPolicy?.mutexGroup;
    if (!group) continue;
    if (!isChatClassRow(row)) continue;
    counts.set(group, (counts.get(group) || 0) + 1);
  }
  let best = null;
  let bestCount = 0;
  for (const [group, count] of counts) {
    if (count > bestCount) {
      best = group;
      bestCount = count;
    }
  }
  return best || DEFAULT_CHAT_MUTEX_GROUP;
}

/**
 * Register a downloaded model as a native-runtime provider row.
 *
 * Order (binding — later tasks' process supervisor depends on this exact
 * sequence): allocate + bind-test the port → persist the reservation +
 * registry entry to state.json → insert the provider row with its FINAL
 * `base_url` (the port never changes after this point — no placeholder,
 * no later "update base_url once the process is up") → invalidate the
 * providers cache LAST, so no reader can observe a cache miss that
 * refetches a still-mid-write row.
 *
 * The `dir`-scoped `state.registry[modelId]` entry this writes (`file`,
 * `quant`, `catalogId`, `registeredAt`, `sizeMb`) is what lets
 * `unregisterModel` find the on-disk blob to delete without needing a
 * `catalog` argument of its own — the registry entry IS the durable record
 * of which file this modelId's row corresponds to. `sizeMb` (the quant's
 * catalog `size_mb`, MB, may be a float) is read back by
 * `gpu-orchestrator.js`'s native acquire path to scale the readiness
 * timeout to the model's actual size (Item G, Task 10) — it is NOT used by
 * `unregisterModel` or anything else in this file.
 *
 * Injectable seams (`allocatePortFn`/`listProvidersAllFn`/`upsertProviderFn`/
 * `invalidateCacheFn`) default to the real implementations; tests use them
 * to observe call order without needing to intercept module internals.
 *
 * Provider-id collision guard: `modelId` doubles as the provider row's `id`
 * (see the section header comment), which means a user's own cloud/bundle
 * provider could already occupy that id by coincidence — an unrelated row
 * that this call must never clobber. BEFORE anything else (before even
 * allocating a port, so a rejected call never leaks a reservation), any
 * existing row at this id is checked for ownership: it's "ours" only if its
 * `gpu_policy.runtime === "native"` AND its own `models[]` array already
 * carries an entry for this catalog model's id (i.e. it's a row THIS
 * registration path wrote, for THIS model — the row itself is the durable
 * record, deliberately NOT the local, ephemeral `state.registry` map,
 * which `unregisterModel` clears on every teardown; ownership must survive
 * a register→unregister→re-register cycle on the same instance). Anything
 * else (a foreign provider, or a native-tagged row for a different model)
 * throws `ProviderIdConflictError` with the existing row completely
 * untouched.
 *
 * @throws {ProviderIdConflictError} if a provider already exists at this id
 *   and isn't a prior registration of this same model by this runtime.
 * @returns {Promise<object>} the registered provider row shape:
 *   `{ id, baseUrl, port, apiKey, host, bundleId, description, models,
 *      gpuPolicy, disabled, lamport_ts }`
 */
export async function registerModel({
  modelId,
  quant,
  catalog,
  db,
  dir,
  allocatePortFn = allocatePort,
  listProvidersAllFn = listProvidersAll,
  upsertProviderFn = upsertProvider,
  invalidateCacheFn = invalidateProvidersCache,
}) {
  const { model, quantEntry } = resolveEntry(catalog, modelId, quant);

  const state = loadState(dir);

  // Collision guard — read-only, runs BEFORE any state/DB mutation (in
  // particular before allocatePortFn, so a rejected call leaves no
  // reservation behind to clean up).
  const existingRows = await listProvidersAllFn(db);
  const existingRow = existingRows.find((r) => r.id === modelId);
  if (existingRow) {
    const isOurs = existingRow.gpuPolicy?.runtime === NATIVE_RUNTIME
      && Array.isArray(existingRow.models)
      && existingRow.models.some((m) => m && m.id === model.id);
    if (!isOurs) {
      throw new ProviderIdConflictError(modelId);
    }
  }

  const port = await allocatePortFn(state, modelId, { crowHome: dir, pid: process.pid });
  state.registry[modelId] = {
    file: sanitizeFilename(quantEntry.file),
    quant: quantEntry.quant,
    catalogId: model.id,
    registeredAt: new Date().toISOString(),
    sizeMb: Number.isFinite(quantEntry.size_mb) ? quantEntry.size_mb : null,
  };
  saveState(dir, state);

  const gpuPolicy = { runtime: NATIVE_RUNTIME };
  if (model.task === "chat") {
    // Exclude this model's own (pre-existing, legitimate-re-register) row
    // from the mutex-group count — it must never vote for its own group.
    const otherRows = existingRows.filter((r) => r.id !== modelId);
    gpuPolicy.mutexGroup = pickChatMutexGroup(otherRows);
  }
  // embed-class (and any other non-chat task): no mutexGroup key at all —
  // embedding servers don't contend for the chat mutex group.

  const baseUrl = `http://127.0.0.1:${port}/v1`;
  const models = [{ id: model.id, task: model.task, contextLen: model.context_len }];
  const description = `${model.family} ${quantEntry.quant} (native)`;

  const upserted = await upsertProviderFn(db, {
    id: modelId,
    baseUrl,
    apiKey: null,
    host: "local",
    bundleId: null,
    description,
    models,
    disabled: false,
    providerType: "openai-compat",
    gpuPolicy,
  });

  await invalidateCacheFn();

  return {
    id: modelId,
    baseUrl,
    port,
    apiKey: null,
    host: "local",
    bundleId: null,
    description,
    models,
    gpuPolicy,
    disabled: false,
    lamport_ts: upserted.lamport_ts,
  };
}

/**
 * Tear down a registered native model: stop its process (if a live runtime
 * handle is given — no process supervisor exists yet as of Task 7, this is
 * a forward-looking seam for the task that adds one), free its port
 * reservation, delete its blob, soft-delete its provider row, and
 * invalidate the providers cache. Order is binding (asserted via injected
 * spies in tests) — each step only starts once the previous one has
 * settled.
 *
 * `runtimeHandle`, if given, is duck-typed as `{ live: boolean, stop():
 * Promise<void> }` — `stop()` is only called when `live` is truthy.
 *
 * Injectable seams mirror `registerModel`'s pattern.
 *
 * @returns {Promise<{ modelId, deleted: boolean, disabled: boolean }>}
 */
export async function unregisterModel({
  modelId,
  db,
  dir,
  runtimeHandle,
  releasePortFn = releasePort,
  unlinkFn = unlinkSync,
  disableProviderFn = disableProvider,
  invalidateCacheFn = invalidateProvidersCache,
}) {
  if (runtimeHandle && runtimeHandle.live) {
    await runtimeHandle.stop();
  }

  const state = loadState(dir);
  releasePortFn(state, modelId);
  const regEntry = state.registry[modelId];
  delete state.registry[modelId];
  saveState(dir, state);

  let deleted = false;
  if (regEntry?.file) {
    const dest = join(modelsBlobDir(dir), regEntry.file);
    try {
      unlinkFn(dest);
      deleted = true;
    } catch (err) {
      if (err && err.code !== "ENOENT") throw err;
    }
  }

  const result = await disableProviderFn(db, modelId);
  await invalidateCacheFn();

  return { modelId, deleted, disabled: !!result?.ok };
}

/**
 * What currently points at provider `providerId`, for the delete
 * confirmation ("this will break N profiles and M bots") dialog.
 *
 * Reads the two REAL locations that reference a provider id (see the
 * section header comment above for why there is no `provider_id` column to
 * query directly):
 *   - `dashboard_settings` row keyed `'ai_profiles'` (JSON array; pointer-mode
 *     entries carry `provider_id`).
 *   - `pi_bot_defs.definition` (JSON per row; `models.default`,
 *     `models.escalation`, `fast_voice_model` carry `"<providerId>/<modelId>"`).
 *
 * Missing table/row/malformed JSON in either location resolves to an empty
 * list for that half rather than throwing — a fresh install with no
 * `pi_bot_defs` table (MPA-only, per `bot-board/data-queries.js`) must still
 * answer this query.
 *
 * @returns {Promise<{ profiles: Array<object>, bots: Array<{bot_id,display_name}> }>}
 */
export async function providerBindings(db, providerId) {
  const profiles = [];
  try {
    const { rows } = await db.execute({
      sql: "SELECT value FROM dashboard_settings WHERE key = 'ai_profiles'",
      args: [],
    });
    const parsed = JSON.parse(rows[0]?.value || "[]");
    if (Array.isArray(parsed)) {
      for (const p of parsed) {
        if (p && p.provider_id === providerId) profiles.push(p);
      }
    }
  } catch {
    /* no dashboard_settings row, or corrupt JSON -> no profile bindings found */
  }

  const bots = [];
  try {
    const { rows } = await db.execute({
      sql: "SELECT bot_id, display_name, definition FROM pi_bot_defs",
      args: [],
    });
    const prefix = `${providerId}/`;
    for (const row of rows) {
      let def;
      try { def = JSON.parse(row.definition || "{}"); } catch { def = {}; }
      const keys = [def?.models?.default, def?.models?.escalation, def?.fast_voice_model];
      const bound = keys.some((k) => typeof k === "string" && k.startsWith(prefix));
      if (bound) bots.push({ bot_id: row.bot_id, display_name: row.display_name });
    }
  } catch {
    /* pi_bot_defs missing on this instance (primary gateway) -> no bot bindings */
  }

  return { profiles, bots };
}
