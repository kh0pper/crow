/**
 * GGUF model download + registration pipeline (Item G, native model
 * runtime, Tasks 6-7; Task 13 fix round 1 added Browse-Hugging-Face
 * downloads and a typed HTTP-status error).
 *
 * Everything above `// --- provider registration (Task 7) ---` is the
 * download engine (Task 6) — it only ever touches the filesystem +
 * `state.js`'s `journal` map, never the DB. Below that marker, Task 7 turns
 * a downloaded blob into a running llama.cpp provider row (`registerModel`),
 * tears one down (`unregisterModel`), and answers "what points at this
 * provider" for the delete-confirmation dialog (`providerBindings`).
 *
 * The "Browse Hugging Face — un-vetted-repo downloads" section (search for
 * that heading below, just above `deleteModel`) is Task 13 fix round 1:
 * `downloadHfFile`/`fetchHfPathInfo` let the panel's advanced search tab
 * download an arbitrary GGUF file the operator picked, verified against a
 * sha256 fetched live from Hugging Face — reusing this same download
 * engine (`downloadModel`) via a synthetic one-model catalog, not a
 * parallel implementation.
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
 *   - `downloadModel()` — the orchestrator. Resolves a catalog entry to the
 *     ordered list of files it needs (`planFiles`: the quant's primary
 *     part, then its `shards`, then the model's `companions` — schema v2,
 *     multi-part GGUFs + mmproj/mtp sidecars), each with its own URL,
 *     sanitized on-disk destination and sha256; consults the journal (from
 *     `state.js`) to decide, PER FILE, whether it is finished, resumable or
 *     fresh; and journals progress (throttled) back through `loadState`/
 *     `saveState` so a killed process can pick up where it left off. This
 *     is the layer real callers (the model panel, Task 7's provider
 *     registration) use. A legacy single-file entry plans exactly one
 *     file and behaves exactly as before.
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
import { basename, dirname, join } from "node:path";

import { allocatePort, loadState, releasePort, saveState, registryKey, findRegistryEntryForProvider } from "./state.js";
import { disableProvider, listProvidersAll, upsertProvider } from "../../shared/providers-db.js";
import { invalidateProvidersCache, invalidateAndRefreshProvidersCache } from "../../shared/providers.js";
import { validateLaunch } from "./launch.js";
import { doorBaseUrl, gatewayPort } from "./door.js";
import { getOwnTailnetIp } from "../../shared/tailnet-ip.js";
import { getOrCreateLocalInstanceId } from "../instance-registry.js";

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
  constructor(expectedSha, actualSha, file) {
    super(`Checksum mismatch: expected ${expectedSha}, got ${actualSha}${file ? ` for ${basename(String(file))}` : ""}`);
    this.name = "ChecksumError";
    this.code = "CHECKSUM_MISMATCH";
    this.expectedSha = expectedSha;
    this.actualSha = actualSha;
    /** Destination path of the file that failed verification (multi-part
     * downloads: names WHICH part, since the verified earlier parts are
     * kept on disk). */
    this.file = file || null;
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

/** Thrown when a download hop returns a non-redirect, non-200/206 HTTP
 * status (Task 13 fix round 1, finding d). Replaces a bare `Error` so
 * callers can branch on `.statusCode`/`.code` (`"HTTP_403"`, `"HTTP_404"`,
 * ...) instead of string-matching the message — the panel's gated-model
 * retry copy in particular needs to detect "this was specifically a 403"
 * without parsing free text that could drift. */
export class HttpStatusError extends Error {
  constructor(statusCode, url) {
    super(`Unexpected HTTP status ${statusCode} downloading ${url}`);
    this.name = "HttpStatusError";
    this.code = `HTTP_${statusCode}`;
    this.statusCode = statusCode;
  }
}

/** Thrown by `fetchHfPathInfo` on a non-2xx response from Hugging Face's
 * paths-info API (network error, or the API itself refusing/erroring —
 * confirmed live: a repo Hugging Face won't resolve returns 401, not 404,
 * so this is intentionally NOT statusCode-specific). */
export class HfMetadataError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = "HfMetadataError";
    this.code = "HF_METADATA_ERROR";
    this.statusCode = statusCode ?? null;
  }
}

/** Thrown when the requested file does not appear in the repo at all —
 * confirmed live: Hugging Face's paths-info API answers a nonexistent path
 * inside a real repo with `200 []`, not a 404, so this must be detected by
 * an empty/missing result, not inferred from the HTTP status. */
export class HfFileNotFoundError extends Error {
  constructor(hfRepo, file) {
    super(`File not found in Hugging Face repo ${hfRepo}: ${file}`);
    this.name = "HfFileNotFoundError";
    this.code = "HF_FILE_NOT_FOUND";
  }
}

/** Thrown when Hugging Face reports the requested file with no LFS `oid` —
 * i.e. it isn't an LFS-tracked object, so there is no content-hash we can
 * verify a download against (a non-LFS `oid` is a git blob SHA-1 over a
 * git-wrapped object, not a bare-content sha256 — it would never match
 * `fetchModelBlob`'s streamed sha256 of the raw bytes, so trusting it would
 * be actively misleading, not just weaker). The un-vetted/advanced-tab
 * download path never downloads a file it cannot verify. */
export class NoVerifiableChecksumError extends Error {
  constructor(file) {
    super(`This file has no verifiable checksum (not LFS-tracked): ${file}`);
    this.name = "NoVerifiableChecksumError";
    this.code = "NO_VERIFIABLE_CHECKSUM";
  }
}

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

/** Thrown by `adoptModel` when weights already on disk don't match the
 * catalog's expectation for a given quant/companion/shard — either the
 * file is missing outright, or its sha256 (verified mode) or byte size
 * (unverified mode, `allowUnverified: true`) doesn't line up. */
export class AdoptMismatchError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "AdoptMismatchError";
    this.code = code;
    Object.assign(this, details);
  }
}

/** sha256 of a file's contents, hex-encoded, computed by streaming (never
 * loads the whole file into memory — model weights can be tens of GB). */
export function hashFileSha256(path, { createReadStreamImpl = createReadStream } = {}) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStreamImpl(path)
      .on("data", (c) => hash.update(c))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

function sizeMatches(actualBytes, sizeMb) {
  const expected = sizeMb * 1e6;
  return Math.abs(actualBytes - expected) <= expected * 0.005;
}

/** Verify one adopted file against its catalog expectation. Returns `true`
 * if the check was a sha256 match (verified mode), `false` if it was a
 * size-only match (unverified mode). Throws `AdoptMismatchError` (missing
 * file / sha mismatch / size mismatch) otherwise. */
async function checkAdoptFile({ path, expectedSha, sizeMb, allowUnverified, hashFileFn, statFn, what }) {
  let st;
  try {
    st = statFn(path);
  } catch {
    throw new AdoptMismatchError(`${what}: file not found at ${path}`, "ADOPT_FILE_MISSING", { file: path });
  }
  if (!allowUnverified) {
    const actual = await hashFileFn(path);
    if (actual !== expectedSha) {
      throw new AdoptMismatchError(`${what}: sha256 of ${path} is ${actual}, expected ${expectedSha}`, "ADOPT_SHA_MISMATCH", { file: path, expected: expectedSha, actual });
    }
    return true;
  }
  if (!sizeMatches(st.size, sizeMb)) {
    throw new AdoptMismatchError(`${what}: ${path} is ${st.size} bytes, expected about ${Math.round(sizeMb * 1e6)}`, "ADOPT_SIZE_MISMATCH", { file: path, expected: Math.round(sizeMb * 1e6), actual: st.size });
  }
  return false;
}

/** Register weights that are ALREADY on disk (never downloaded or copied
 * by this module) — the "adopt" path for pre-existing installs. Verified
 * mode (default) hashes `path` and every catalog companion/shard against
 * the catalog's recorded sha256; `allowUnverified: true` instead accepts a
 * byte-size match within 0.5%, for the case where re-hashing a huge file
 * isn't worth it and the operator already trusts the provenance. Delegates
 * the actual registry/DB write to `registerModel`, which spreads
 * `registryExtra` last so `path/adopted/verified/companions/shardFiles`
 * here override its planned-file defaults. */
export async function adoptModel({
  modelId,
  quant,
  path,
  companionPaths = {},
  catalog,
  allowUnverified = false,
  hashFileFn = hashFileSha256,
  statFn = statSync,
  ...registerOpts
}) {
  const { model, quantEntry } = resolveEntry(catalog, modelId, quant);
  const what = `${model.id} ${quantEntry.quant} (${quantEntry.file})`;
  const shards = Array.isArray(quantEntry.shards) ? quantEntry.shards : [];
  const primarySizeMb = quantEntry.size_mb - shards.reduce((s, x) => s + x.size_mb, 0);
  const verifiedPrimary = await checkAdoptFile({
    path,
    expectedSha: quantEntry.sha256,
    sizeMb: primarySizeMb,
    allowUnverified,
    hashFileFn,
    statFn,
    what,
  });

  const shardFiles = [];
  for (const shard of shards) {
    const shardPath = join(dirname(path), basename(shard.file));
    await checkAdoptFile({
      path: shardPath,
      expectedSha: shard.sha256,
      sizeMb: shard.size_mb,
      allowUnverified,
      hashFileFn,
      statFn,
      what: `${what} shard ${basename(shard.file)}`,
    });
    shardFiles.push(basename(shard.file));
  }

  const companions = [];
  for (const c of Array.isArray(model.companions) ? model.companions : []) {
    const cPath = companionPaths[c.kind];
    if (!cPath) {
      throw new AdoptMismatchError(`${what}: catalog companion ${c.kind} (${c.file}) needs a path`, "ADOPT_COMPANION_MISSING", { kind: c.kind, file: c.file });
    }
    await checkAdoptFile({
      path: cPath,
      expectedSha: c.sha256,
      sizeMb: c.size_mb,
      allowUnverified,
      hashFileFn,
      statFn,
      what: `${what} companion ${c.kind}`,
    });
    companions.push({ kind: c.kind, file: basename(cPath), path: cPath });
  }

  const verified = verifiedPrimary === true;
  const result = await registerModel({
    modelId,
    quant,
    catalog,
    ...registerOpts,
    registryExtra: { ...(registerOpts.registryExtra || {}), path, adopted: true, verified, companions, shardFiles },
  });
  return { ...result, adopted: true, verified };
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
      throw new HttpStatusError(res.statusCode, currentUrl);
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
  extraHeaders,
}) {
  assertNotSymlink(dest);

  const hash = createHash("sha256");
  const onDiskSize = existsSync(dest) ? statSync(dest).size : 0;
  const effectiveResumeFrom = Math.min(resumeFrom, onDiskSize);
  if (effectiveResumeFrom > 0) {
    truncateSync(dest, effectiveResumeFrom);
    await rehashPrefix(dest, effectiveResumeFrom, hash);
  }

  // `extraHeaders` (e.g. an HF `Authorization: Bearer <token>` for a gated
  // repo — Task 13 fix round 1) is caller-supplied and merged first, so the
  // Range header this function computes for a resume can never be
  // shadowed by it.
  const headers = { ...(extraHeaders || {}) };
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
    throw new ChecksumError(expectedSha, sha256, dest);
  }
  return { path: dest, sha256, bytesDone };
}

// ---------------------------------------------------------------------------
// Layer 2: catalog + journal orchestration
// ---------------------------------------------------------------------------

function modelsBlobDir(dir) {
  return join(dir, "models", "blobs");
}

/** On-disk basename for a companion file. Namespaced by the model id
 * because every vision repo ships its projector under the SAME name
 * (`mmproj-F16.gguf`) and the blob dir is flat — two vision models
 * installed side by side must never overwrite each other's projector. */
export function companionFilename(modelId, file) {
  return sanitizeFilename(`${modelId}--${sanitizeFilename(file)}`);
}

/**
 * The ordered list of files a catalog quant needs on disk (schema v2):
 * the quant's primary part, then each `shards[i]` (parts 2..n of a
 * multi-part GGUF, in catalog order), then each of the model's
 * `companions` (mmproj / mtp sidecars). Pure: no I/O.
 *
 * Each entry: `{ url, dest, expectedSha, sizeMb, role, kind? }` —
 * `role` is "primary" | "shard" | "companion", `kind` is the companion
 * kind ("mmproj" | "mtp") and absent otherwise. `dest` is the sanitized
 * basename, joined under `blobDir` when one is given. `sizeMb` for the
 * primary is the quant's TOTAL `size_mb` minus its shards (the catalog
 * records the total on the quant), so the entries' sizes sum to the whole
 * download — used to seed cumulative progress before every part has been
 * HEAD-ed. `baseUrl` is the test-only override `downloadModel` accepts.
 */
export function planFiles(model, quantEntry, { baseUrl, blobDir } = {}) {
  const url = (file) => (baseUrl ? buildDownloadUrl(model.hf_repo, file, baseUrl) : buildDownloadUrl(model.hf_repo, file));
  const place = (name) => (blobDir ? join(blobDir, name) : name);
  const num = (n) => (typeof n === "number" && Number.isFinite(n) ? n : null);

  const shards = Array.isArray(quantEntry.shards) ? quantEntry.shards : [];
  const companions = Array.isArray(model.companions) ? model.companions : [];

  const shardTotal = shards.reduce((acc, sh) => acc + (num(sh.size_mb) || 0), 0);
  const total = num(quantEntry.size_mb);
  const primarySize = total == null ? null : Math.max(0, total - shardTotal);

  const plan = [{
    url: url(quantEntry.file),
    dest: place(sanitizeFilename(quantEntry.file)),
    expectedSha: quantEntry.sha256 || null,
    sizeMb: primarySize,
    role: "primary",
  }];
  for (const sh of shards) {
    plan.push({
      url: url(sh.file),
      dest: place(sanitizeFilename(sh.file)),
      expectedSha: sh.sha256 || null,
      sizeMb: num(sh.size_mb),
      role: "shard",
    });
  }
  for (const c of companions) {
    plan.push({
      url: url(c.file),
      dest: place(companionFilename(model.id, c.file)),
      expectedSha: c.sha256 || null,
      sizeMb: num(c.size_mb),
      role: "companion",
      kind: c.kind,
    });
  }
  return plan;
}

/** Normalize a journal entry to its per-file list. Entries written before
 * the multi-file journal (`{url,dest,bytesDone,expectedSha,startedAt}`,
 * no `files`) are read as a one-file list — never a crash. */
function journalFiles(entry) {
  if (!entry || typeof entry !== "object") return [];
  if (Array.isArray(entry.files)) return entry.files.filter((f) => f && typeof f === "object");
  if (entry.url && entry.dest) {
    return [{ url: entry.url, dest: entry.dest, bytesDone: entry.bytesDone || 0, expectedSha: entry.expectedSha ?? null, done: false }];
  }
  return [];
}

/**
 * Download every file a model's quant needs (see `planFiles`), journaling
 * progress to `state.js` so a killed/restarted process can resume. See
 * module doc for the full contract; `dir` is the injected CROW_HOME/data
 * dir (never guessed).
 *
 * Journal entry shape (`state.journal[modelId]`):
 *   `{ url, dest, bytesDone, expectedSha, startedAt,
 *      files: [ { url, dest, bytesDone, expectedSha, done }, ... ] }`
 * `files` is one record per planned file, in download order; a file with
 * `done:true` was fully downloaded AND sha-verified and is skipped on
 * resume. The top-level `url`/`dest`/`bytesDone`/`expectedSha` mirror the
 * file currently in flight so every pre-existing single-file reader
 * (`state.js`'s `resumableDownloads`, the panel's progress view) keeps
 * working unchanged. An old-shape entry with no `files` is read as a
 * one-file list (`journalFiles`).
 *
 * `onProgress({ bytesDone, totalBytes, file, fileIndex, fileCount })` —
 * `bytesDone`/`totalBytes` are CUMULATIVE across all files (finished files
 * count in full; not-yet-started files contribute their catalog size);
 * `file` is the in-flight file's basename.
 *
 * Returns `{ path, sha256, files: [ { path, sha256 }, ... ] }` — `path`/
 * `sha256` are the primary part's (the pre-v2 return shape), `files` lists
 * every part in plan order.
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
  extraHeaders,
}) {
  const { model, quantEntry } = resolveEntry(catalog, modelId, quant);
  const blobDir = modelsBlobDir(dir);
  mkdirSync(blobDir, { recursive: true });
  const plan = planFiles(model, quantEntry, { baseUrl, blobDir });
  for (const f of plan) assertNotSymlink(f.dest);

  const initialState = loadState(dir);
  const prior = journalFiles(initialState.journal[modelId]);
  let matchedPrior = false;
  const files = plan.map((f) => {
    const p = prior.find((e) => e.url === f.url && e.dest === f.dest);
    if (p) matchedPrior = true;
    return {
      url: f.url,
      dest: f.dest,
      expectedSha: f.expectedSha,
      sizeMb: f.sizeMb,
      bytesDone: p ? (p.bytesDone || 0) : 0,
      done: !!(p && p.done === true),
      sha256: p && p.done === true ? (p.expectedSha ?? null) : null,
    };
  });
  const startedAt = (matchedPrior && initialState.journal[modelId]?.startedAt) || new Date().toISOString();

  const journalEntry = (idx) => {
    const cur = files[idx] || files[files.length - 1];
    return {
      url: cur.url,
      dest: cur.dest,
      bytesDone: cur.bytesDone,
      expectedSha: cur.expectedSha,
      startedAt,
      files: files.map(({ url, dest, bytesDone, expectedSha, done }) => ({ url, dest, bytesDone, expectedSha, done })),
    };
  };

  // Persisting reloads state fresh each time (rather than reusing one
  // in-memory object across the whole download) to minimize — though not
  // fully eliminate — clobbering a concurrent download's journal entry
  // when CROW_MODEL_DL_CONCURRENCY=2. state.json has no real locking; this
  // is a known, accepted v1 limitation (matches state.js's own
  // documented tradeoffs), not something this task solves.
  const persistJournal = (idx) => {
    const s = loadState(dir);
    s.journal[modelId] = journalEntry(idx);
    saveState(dir, s);
  };
  const clearJournal = () => {
    const s = loadState(dir);
    delete s.journal[modelId];
    saveState(dir, s);
  };

  // Seed/refresh the journal entry immediately, before any network I/O, so
  // even an interruption in the first instant leaves a resumable record.
  persistJournal(files.findIndex((f) => !f.done));

  const estimateBytes = (f) => (f.sizeMb == null ? 0 : Math.round(f.sizeMb * 1_000_000));

  for (let idx = 0; idx < files.length; idx++) {
    const f = files[idx];
    if (f.done) continue;

    let liveTotal = null;
    let lastSave = Date.now();
    const cumulative = () => {
      let bytesDone = 0;
      let totalBytes = 0;
      files.forEach((g, i) => {
        if (i === idx) {
          bytesDone += g.bytesDone;
          totalBytes += liveTotal != null ? liveTotal : estimateBytes(g);
        } else if (g.done) {
          bytesDone += g.bytesDone;
          totalBytes += g.bytesDone;
        } else {
          totalBytes += estimateBytes(g);
        }
      });
      return { bytesDone, totalBytes };
    };
    const wrappedOnProgress = ({ bytesDone, totalBytes }) => {
      f.bytesDone = bytesDone;
      if (totalBytes != null) liveTotal = totalBytes;
      if (typeof onProgress === "function") {
        onProgress({ ...cumulative(), file: basename(f.dest), fileIndex: idx, fileCount: files.length });
      }
      const now = Date.now();
      if (now - lastSave >= journalIntervalMs) {
        lastSave = now;
        persistJournal(idx);
      }
    };

    try {
      const result = await fetchModelBlob({
        url: f.url,
        dest: f.dest,
        resumeFrom: f.bytesDone,
        expectedSha: f.expectedSha,
        lookup,
        maxRedirects,
        createWriteStream,
        insecureHttpHosts,
        timeoutMs,
        extraHeaders,
        onProgress: wrappedOnProgress,
      });
      f.bytesDone = result.bytesDone;
      f.done = true;
      f.sha256 = result.sha256;
      if (idx < files.length - 1) persistJournal(idx + 1);
    } catch (err) {
      if (err instanceof ChecksumError) {
        // fetchModelBlob already deleted the bad file — its record is
        // equally stale. Earlier parts that verified are KEPT on disk and
        // stay `done` in the journal so a retry only re-fetches this one;
        // when nothing was verified yet, drop the entry rather than
        // offering a "resume" that would re-download from scratch anyway.
        f.bytesDone = 0;
        f.done = false;
        if (files.some((g) => g.done)) persistJournal(idx);
        else clearJournal();
        throw err;
      }
      // Any other failure (host refused, interrupted connection, disk full,
      // ...): flush the latest known bytesDone unconditionally, bypassing
      // the throttle, so a subsequent call always resumes from an accurate
      // point rather than losing up to journalIntervalMs of progress.
      if (typeof err.bytesDone === "number") f.bytesDone = err.bytesDone;
      persistJournal(idx);
      throw err;
    }
  }

  clearJournal();
  return {
    path: files[0].dest,
    sha256: files[0].sha256,
    files: files.map((f) => ({ path: f.dest, sha256: f.sha256 })),
  };
}

// ---------------------------------------------------------------------------
// Browse Hugging Face — un-vetted-repo downloads (Task 13 fix round 1,
// finding 1: Kevin decided to build this in-PR).
//
// The curated path above trusts a PR-reviewed, sha256-pinned catalog entry.
// This path has no such review — the operator is choosing an arbitrary
// GGUF file out of Hugging Face's public search. The ONE non-negotiable
// safety property this section exists to guarantee: a file is NEVER
// downloaded (or, having been downloaded, never registered as a runnable
// provider) without an independently-fetched, verified sha256 to check it
// against. Hugging Face's `paths-info` API is queried BEFORE any byte of
// the file itself is requested; if it reports no LFS `oid` for the path
// (i.e. the file isn't LFS-tracked — a git-blob `oid` is a SHA-1 over a
// git-wrapped object, not a content sha256, and would never match anyway),
// this refuses outright rather than downloading something it cannot verify.
// ---------------------------------------------------------------------------

/** Strict shape check for a Hugging Face repo id: exactly `owner/name`, two
 * path segments, conservative charset (letters/digits/`_`/`.`/`-`) — no
 * traversal, no query strings, no extra segments. Reused by
 * `routes/models.js`'s `POST /hf-download` 400 gate so the shape rule lives
 * in exactly one place. */
const HF_REPO_SHAPE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,96}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,96}$/;
export function isValidHfRepoId(hfRepo) {
  return typeof hfRepo === "string" && HF_REPO_SHAPE_RE.test(hfRepo);
}

/** Strict shape check for a single filename requested from a Hugging Face
 * repo: no path separators (so it can never escape the repo root or the
 * on-disk blobs dir once handed to `sanitizeFilename`), not `.`/`..`,
 * conservative charset. */
const HF_FILE_SHAPE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$/;
export function isValidHfFilename(file) {
  if (typeof file !== "string" || !file) return false;
  if (file.includes("/") || file.includes("\\")) return false;
  if (file === "." || file === "..") return false;
  return HF_FILE_SHAPE_RE.test(file);
}

/** Reduce a Hugging Face filename to a safe, DB-friendly provider/model id:
 * strip the `.gguf` extension, lowercase, collapse any run of characters
 * outside `[a-z0-9._-]` into a single `-`, trim leading/trailing `-`.
 * `registerModel`'s provider-id collision guard applies to whatever this
 * returns exactly as it does for a curated catalog id — no special-casing
 * needed there (Task 13 fix round 1, finding 1). */
export function deriveModelIdFromFilename(file) {
  const base = String(file ?? "").replace(/\.gguf$/i, "");
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  if (!slug) {
    throw new UnsafeDestinationError(`Could not derive a model id from filename: ${JSON.stringify(file)}`);
  }
  return slug;
}

/**
 * Query Hugging Face's `paths-info` API for one file's LFS sha256 + size,
 * BEFORE downloading anything. Confirmed against the real API (2026-07-19):
 * `POST {hfApiBase}/api/models/{hfRepo}/paths-info/main` with
 * `{paths:[file], expand:true}` returns `[{path, size, oid, lfs:{oid,
 * size}}]` for a file that exists — `lfs.oid` IS the content sha256 for an
 * LFS-tracked object (independently verified: matches the catalog's own
 * pinned sha256 for `qwen3-4b`'s Q4_K_M file byte-for-byte). A path that
 * doesn't exist in an otherwise-valid repo answers `200 []`, not a 404 —
 * `HfFileNotFoundError` covers that case explicitly rather than trusting
 * the HTTP status. A non-LFS file has no `lfs` key at all — `sha256` comes
 * back `null` and the caller (`downloadHfFile`) refuses to proceed.
 *
 * @returns {Promise<{sha256: string|null, sizeBytes: number|null}>}
 */
export async function fetchHfPathInfo({
  hfRepo,
  file,
  hfApiBase = "https://huggingface.co",
  hfToken,
  fetchImpl = fetch,
  timeoutMs = 8000,
}) {
  const url = `${hfApiBase}/api/models/${hfRepo}/paths-info/main`;
  let res;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(hfToken ? { Authorization: `Bearer ${hfToken}` } : {}),
      },
      body: JSON.stringify({ paths: [file], expand: true }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // Covers network errors AND AbortSignal.timeout() firing — matches
    // routes/models.js's existing /hf-search collapse-to-one-code pattern.
    throw new HfMetadataError(`Hugging Face metadata request failed: ${err.message || err}`);
  }
  if (!res.ok) {
    throw new HfMetadataError(`Hugging Face metadata request failed (${res.status})`, res.status);
  }
  let body;
  try {
    body = await res.json();
  } catch (err) {
    throw new HfMetadataError(`Hugging Face metadata response was not valid JSON: ${err.message}`);
  }
  const entry = Array.isArray(body) ? body.find((e) => e && e.path === file) : null;
  if (!entry) {
    throw new HfFileNotFoundError(hfRepo, file);
  }
  const sha256 = entry.lfs && typeof entry.lfs.oid === "string" ? entry.lfs.oid : null;
  const sizeBytes = typeof entry.size === "number"
    ? entry.size
    : (entry.lfs && typeof entry.lfs.size === "number" ? entry.lfs.size : null);
  return { sha256, sizeBytes };
}

/**
 * Download one arbitrary GGUF file out of a Hugging Face repo the operator
 * picked from the Browse-Hugging-Face search tab — not a curated catalog
 * entry. Verifies the file's sha256 (fetched via `fetchHfPathInfo`, BEFORE
 * any download traffic) and refuses outright if Hugging Face reports none
 * (`NoVerifiableChecksumError` — see module doc above). Reuses the exact
 * same journaled, resumable, incrementally-hashed engine curated downloads
 * use (`downloadModel`) by building a one-model, one-quant SYNTHETIC
 * catalog around the verified file — every safety property `downloadModel`/
 * `fetchModelBlob` already have (host allowlist, https-only, symlink
 * refusal, incremental sha256, resumable journal, disk-full/timeout
 * handling) applies unchanged; nothing here re-implements any of it.
 *
 * `hfToken`, if given, is forwarded as `Authorization: Bearer <token>` to
 * BOTH the metadata call and the actual file download (`extraHeaders`,
 * threaded through `downloadModel`/`fetchModelBlob` — Task 13 fix round 1)
 * — required for a gated repo's file to download at all.
 *
 * @returns {Promise<{path: string, sha256: string, modelId: string,
 *   sizeMb: number|null, catalog: object}>} `catalog` is the synthetic
 *   catalog this call built — the caller (routes/models.js) passes it
 *   straight through to `registerModel`, which needs a catalog to resolve
 *   the same entry back out of.
 */
export async function downloadHfFile({
  hfRepo,
  file,
  dir,
  onProgress,
  hfToken,
  hfApiBase,
  fetchHfPathInfoFn = fetchHfPathInfo,
  downloadModelFn = downloadModel,
  lookup,
  baseUrl,
  maxRedirects,
  createWriteStream,
  journalIntervalMs,
  insecureHttpHosts,
  timeoutMs,
}) {
  if (!isValidHfRepoId(hfRepo)) {
    throw new UnsafeDestinationError(`Invalid Hugging Face repo id: ${JSON.stringify(hfRepo)}`);
  }
  if (!isValidHfFilename(file)) {
    throw new UnsafeDestinationError(`Invalid Hugging Face file name: ${JSON.stringify(file)}`);
  }

  const { sha256, sizeBytes } = await fetchHfPathInfoFn({ hfRepo, file, hfApiBase, hfToken });
  if (!sha256) {
    throw new NoVerifiableChecksumError(file);
  }

  const modelId = deriveModelIdFromFilename(file);
  // Decimal MB (bytes / 1e6), matching the curated catalog's own size_mb
  // convention — independently confirmed live against qwen3-4b's pinned
  // catalog entry (2497280256 bytes -> 2497.28, exactly the catalog's
  // size_mb). Used both as this synthetic quant's `size_mb` (fed into
  // `fitBadge` by the route) and, via `registerModel`, as the registry
  // entry's `sizeMb` that scales the native readiness timeout.
  const sizeMb = typeof sizeBytes === "number" ? sizeBytes / 1_000_000 : null;

  const catalog = {
    models: [{
      id: modelId,
      family: hfRepo.split("/")[1] || hfRepo,
      hf_repo: hfRepo,
      task: "chat",
      context_len: null,
      default_quant: "hf",
      quants: [{ file, quant: "hf", sha256, size_mb: sizeMb, min_ram_mb: sizeMb, min_vram_mb: 0 }],
    }],
  };

  const extraHeaders = hfToken ? { Authorization: `Bearer ${hfToken}` } : undefined;

  const result = await downloadModelFn({
    modelId,
    quant: "hf",
    dir,
    catalog,
    onProgress,
    lookup,
    baseUrl,
    maxRedirects,
    createWriteStream,
    journalIntervalMs,
    insecureHttpHosts,
    timeoutMs,
    extraHeaders,
  });

  return { ...result, modelId, sizeMb, catalog };
}

/**
 * Remove a downloaded model's blob — every part and companion file
 * `planFiles` names — (and its journal entry, if any) from `dir`. Task 7
 * extends this to also unregister the corresponding provider row; this
 * task's version only ever touches the filesystem + `state.js`.
 * `deleted` is true when at least one file was actually removed; `path`
 * is the primary part's.
 */
export function deleteModel({ modelId, quant, dir, catalog }) {
  const { model, quantEntry } = resolveEntry(catalog, modelId, quant);
  const plan = planFiles(model, quantEntry, { blobDir: modelsBlobDir(dir) });
  const dest = plan[0].dest;

  // Every part and companion, not just the primary (schema v2).
  let deleted = false;
  for (const f of plan) {
    try {
      unlinkSync(f.dest);
      deleted = true;
    } catch (err) {
      if (err && err.code !== "ENOENT") throw err;
    }
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
 * entries carries `task === "chat"` or `task === "vision"` (Task 8: a
 * vision model shares the GPU/VRAM budget with chat models, so it joins the
 * same mutex group by default). Rows without a mutex group, disabled
 * rows, and rows with no chat/vision-tagged model entries are not counted.
 */
function isChatClassRow(row) {
  return Array.isArray(row.models) && row.models.some((m) => m && (m.task === "chat" || m.task === "vision"));
}

/** Thrown by `registerModel` when a `launch` override fails
 * `validateLaunch` against the catalog model's `context_len` (and mtp
 * companion presence, for `spec`). */
export class InvalidLaunchError extends Error {
  constructor(errors) {
    super(`invalid launch override: ${errors.join("; ")}`);
    this.name = "InvalidLaunchError";
    this.code = "INVALID_LAUNCH";
    this.errors = errors;
  }
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
 * Task 8 generalizes this from "one catalog model = one provider row" to
 * roles/variants: `providerId` (defaults to `modelId`, so every pre-Task-8
 * call site is unaffected) is the row's `id` — a caller can register the
 * SAME catalog model+quant under several provider ids (e.g. "v-solo" and
 * "v-copilot", two `launch` variants) or under a role id decoupled from
 * the catalog id entirely (e.g. "crow-chat"). The on-disk weights and the
 * `state.registry` entry, however, are keyed by `registryKey(catalogId,
 * quant)` — `"<catalogId>@<quant>"` — NOT by `providerId`, so N provider
 * rows can share one registry entry (and therefore one set of files);
 * `unregisterModel` only deletes the entry/files once no other enabled
 * native row still references that key (see below).
 *
 * Order (binding — later tasks' process supervisor depends on this exact
 * sequence): allocate + bind-test the port (skipped/reused when an
 * existing native row at `providerId` already advertises one — see
 * "Conversion" below) → persist the reservation + registry entry to
 * state.json → insert the provider row with its FINAL `base_url` (the door
 * URL; the port never changes after this point — no placeholder, no later
 * "update base_url once the process is up") → invalidate the providers
 * cache LAST, so no reader can observe a cache miss that refetches a
 * still-mid-write row.
 *
 * `base_url` is now the DOOR url (`doorBaseUrl({ tailnetIp, port:
 * gatewayPortFn() })` — routed through the gateway's `/llm/v1`, not the
 * model's own port directly). The model's own port still lives at
 * `gpu_policy.port` and is still returned as `port`. When `tailnetIpFn()`
 * has no tailnet ip, the door falls back to loopback and `gpu_policy`
 * carries `local_only: true` so callers know this instance isn't reachable
 * over the tailnet.
 *
 * Conversion: `providerId` may already name an existing BUNDLE row (a
 * user's llamacpp-container provider for this same slot, e.g. converting
 * "crow-chat" from a Docker bundle to a native download). That's allowed
 * — the existing row is snapshotted to `state.conversions[providerId]`
 * (`{ at, row }`) before being overwritten, `bundle_id` is cleared, and
 * (when `mutexGroup` is left to auto-resolve) the converted row's own
 * `gpuPolicy.mutexGroup` is inherited rather than recomputed, since the
 * row was almost certainly already sharing a VRAM budget with other rows.
 * A foreign non-bundle, non-native row (e.g. a cloud provider) at
 * `providerId` is still refused — see the collision guard below.
 *
 * `launch`, if given, is validated with `validateLaunch()` against the
 * catalog model's `context_len` (and mtp-companion presence, for `spec`)
 * and thrown as `InvalidLaunchError` (`code: "INVALID_LAUNCH"`) on
 * failure — validated BEFORE any state/DB mutation, same as the collision
 * guard, so a rejected call leaves nothing behind.
 *
 * `mutexGroup`: `undefined` (the default) auto-resolves — chat/vision
 * models join `pickChatMutexGroup()`'s pick (or the converted row's
 * existing group, see above); every other task gets no mutexGroup key at
 * all. `null` means "explicitly none" (even for a chat/vision model — an
 * `alwaysResident` model deliberately outside the shared VRAM budget, say).
 * A non-empty string wins outright.
 *
 * The `dir`-scoped `state.registry[registryKey(catalogId, quant)]` entry
 * this writes (`file`, `quant`, `catalogId`, `registeredAt`, `sizeMb`) is
 * what lets `unregisterModel` find the on-disk blob to delete without
 * needing a `catalog` argument of its own — the registry entry IS the
 * durable record of which files this catalogId+quant corresponds to.
 * `sizeMb` (the quant's catalog `size_mb`, MB, may be a float) is read back
 * by `gpu-orchestrator.js`'s native acquire path to scale the readiness
 * timeout to the model's actual size (Item G, Task 10) — it is NOT used by
 * `unregisterModel` or anything else in this file. Two more fields ride the
 * same object but are NOT written here: `wasLive`/`lastStoppedAt`
 * (Task 13 fix round 1, finding c) are set by `gpu-orchestrator.js` the
 * first time the model actually becomes resident, not at registration time
 * — a freshly-registered, never-started model correctly has neither. A
 * re-register of an already-registered key preserves the existing entry's
 * `registeredAt` (and any other fields not explicitly overwritten here) —
 * only `registryExtra` (below) and the recomputed file lists change.
 *
 * `registryExtra` (Task 13 fix round 1, finding 1), if given, is
 * shallow-merged onto the registry entry LAST (after every field above,
 * including a pre-existing entry's carried-over fields) — this is how the
 * model-adopt flow (Task 9) marks a registry entry `{ path, adopted:
 * true, verified, companions }` for weights that live outside the managed
 * blobs dir and must never be unlinked by `unregisterModel` (see below).
 * The `POST /hf-download` handler passes `{ source: "hf-browser" }` so the
 * panel/registry can tell a Browse-Hugging-Face registration apart from a
 * curated one. Defaults to `{}` (no-op) so every existing call site is
 * unaffected.
 *
 * Injectable seams (`allocatePortFn`/`listProvidersAllFn`/`upsertProviderFn`/
 * `invalidateCacheFn`/`ownInstanceIdFn`/`tailnetIpFn`/`gatewayPortFn`)
 * default to the real implementations; tests use them to observe call
 * order / pin deterministic values without needing to intercept module
 * internals. `invalidateCacheFn` defaults to
 * `invalidateAndRefreshProvidersCache` (Item G, PR G-F, defect 2), NOT the
 * plain sync `invalidateProvidersCache` — this function's caller (the
 * download-then-register route, or any caller that immediately turns
 * around and asks whether the model it just registered is startable)
 * needs the row to be visible in the very next `loadProviders()` call,
 * which the plain invalidate can't guarantee (it only clears the cache;
 * the next `loadProviders()` call fires an un-awaited background DB
 * refresh and returns the stale/fallback snapshot in the meantime).
 * Awaiting the real refresh here closes that window.
 *
 * Provider-id collision guard: `providerId` (defaulting to `modelId`) is
 * the provider row's `id`, which means a user's own cloud/bundle provider
 * could already occupy that id by coincidence — an unrelated row that this
 * call must never clobber. BEFORE anything else (before even allocating a
 * port, so a rejected call never leaks a reservation), any existing row at
 * this id is checked: it's "ours" (a prior registration of this exact
 * catalog model by this runtime — ownership must survive a
 * register→unregister→re-register cycle on the same instance) if its
 * `gpu_policy.runtime === "native"` AND its own `models[]` array already
 * carries an entry for this catalog model's id; it's a convertible BUNDLE
 * row if it carries a `bundle_id`; anything else (a foreign provider, or a
 * native-tagged row for a different model) throws `ProviderIdConflictError`
 * with the existing row completely untouched.
 *
 * @throws {ProviderIdConflictError} if a provider already exists at this id
 *   and isn't a prior registration of this same model by this runtime, or
 *   a convertible bundle row.
 * @throws {InvalidLaunchError} if `launch` fails `validateLaunch()`.
 * @returns {Promise<object>} `{ id, providerId, registryKey, baseUrl
 *   (door), doorUrl, port, apiKey, host, bundleId, description, models,
 *   gpuPolicy, disabled, converted, lamport_ts }`
 */
export async function registerModel({
  modelId,
  quant,
  catalog,
  db,
  dir,
  providerId = modelId,
  launch = null,
  mutexGroup,
  alwaysResident = false,
  defaultMember = false,
  registryExtra = {},
  ownInstanceIdFn = getOrCreateLocalInstanceId,
  tailnetIpFn = getOwnTailnetIp,
  gatewayPortFn = gatewayPort,
  allocatePortFn = allocatePort,
  listProvidersAllFn = listProvidersAll,
  upsertProviderFn = upsertProvider,
  invalidateCacheFn = invalidateAndRefreshProvidersCache,
}) {
  const { model, quantEntry } = resolveEntry(catalog, modelId, quant);
  const key = registryKey(model.id, quantEntry.quant);

  if (launch !== null && launch !== undefined) {
    const hasMtp = (Array.isArray(model.tags) && model.tags.includes("mtp"))
      || (Array.isArray(model.companions) && model.companions.some((c) => c && c.kind === "mtp"));
    const errs = validateLaunch(launch, { contextLen: model.context_len, label: "launch", hasMtp });
    if (errs.length) throw new InvalidLaunchError(errs);
  }

  const state = loadState(dir);

  // Collision / conversion guard — read-only, runs BEFORE any state/DB
  // mutation (in particular before allocatePortFn, so a rejected call
  // leaves no reservation behind to clean up).
  const existingRows = await listProvidersAllFn(db);
  const existingRow = existingRows.find((r) => r.id === providerId) || null;
  let converted = false;
  if (existingRow) {
    const isOurs = existingRow.gpuPolicy?.runtime === NATIVE_RUNTIME
      && Array.isArray(existingRow.models)
      && existingRow.models.some((m) => m && m.id === model.id);
    const isBundleRow = !!existingRow.bundleId;
    if (!isOurs && !isBundleRow) throw new ProviderIdConflictError(providerId);
    converted = isBundleRow;
  }

  // Port: keep the port an existing native row already advertises (a
  // re-register of the same providerId); a fresh row (or a converted
  // bundle row, which never had a native port) allocates. Reusing the
  // port never calls allocatePortFn (reallocating could hand back a
  // DIFFERENT port if the existing one is currently bound by a LIVE
  // process — see the doc comment above), but the reservation is still
  // re-recorded below if a prior unregisterModel (or a fresh state.json)
  // left `state.reservations` without it, so a disabled-but-present row's
  // port is never left un-reserved after this call returns.
  const existingPort = existingRow?.gpuPolicy?.runtime === NATIVE_RUNTIME ? Number(existingRow.gpuPolicy.port) : NaN;
  const port = Number.isInteger(existingPort) && existingPort > 0
    ? existingPort
    : await allocatePortFn(state, providerId, { crowHome: dir, pid: process.pid });
  if (!state.reservations[providerId]) {
    state.reservations[providerId] = { port, owner: { crowHome: dir, pid: process.pid }, createdAt: new Date().toISOString() };
  }

  if (converted) {
    // Snapshot the bundle row being replaced so an operator can see/restore
    // what this providerId used to be (Task 9's adopt/convert UI reads this).
    state.conversions[providerId] = {
      at: new Date().toISOString(),
      row: {
        id: existingRow.id,
        base_url: existingRow.baseUrl,
        api_key: existingRow.apiKey ?? null,
        host: existingRow.host,
        bundle_id: existingRow.bundleId,
        description: existingRow.description ?? null,
        models: existingRow.models,
        provider_type: existingRow.provider_type ?? null,
        gpu_policy: existingRow.gpuPolicy ?? null,
        disabled: !!existingRow.disabled,
      },
    };
  }

  // Schema v2: the row records every on-disk file the install owns —
  // `shardFiles` (parts 2..n of a multi-part GGUF; llama-server finds them
  // beside the primary) and `companions` (mmproj → `--mmproj` on native
  // start; mtp kept beside the model) — so `unregisterModel` can remove
  // them all. Both are empty arrays for a plain single-file quant. Keyed
  // by `registryKey`, NOT `providerId` — a second variant of the same
  // catalog model+quant shares this same entry.
  const plannedFiles = planFiles(model, quantEntry);
  state.registry[key] = {
    ...(state.registry[key] || {}),
    file: sanitizeFilename(quantEntry.file),
    quant: quantEntry.quant,
    catalogId: model.id,
    registeredAt: state.registry[key]?.registeredAt || new Date().toISOString(),
    sizeMb: Number.isFinite(quantEntry.size_mb) ? quantEntry.size_mb : null,
    shardFiles: plannedFiles.filter((f) => f.role === "shard").map((f) => f.dest),
    companions: plannedFiles.filter((f) => f.role === "companion").map((f) => ({ kind: f.kind, file: f.dest })),
    ...registryExtra,
  };
  saveState(dir, state);

  const owner = ownInstanceIdFn();
  const tailnetIp = tailnetIpFn();
  const gpuPolicy = {
    runtime: NATIVE_RUNTIME,
    catalogId: model.id,
    quant: quantEntry.quant,
    port,
    owner,
    alwaysResident: !!alwaysResident,
    defaultMember: !!defaultMember,
  };
  if (!tailnetIp) gpuPolicy.local_only = true;
  if (launch !== null && launch !== undefined) gpuPolicy.launch = launch;

  if (mutexGroup === undefined) {
    if (model.task === "chat" || model.task === "vision") {
      // A converted bundle row inherits its own prior mutex group (it was
      // almost certainly already sharing a VRAM budget); otherwise resolve
      // the usual way, excluding this providerId's own (pre-existing,
      // legitimate-re-register) row from the count — it must never vote
      // for its own group.
      const inherited = converted ? existingRow.gpuPolicy?.mutexGroup : null;
      gpuPolicy.mutexGroup = inherited || pickChatMutexGroup(existingRows.filter((r) => r.id !== providerId));
    }
    // embed-class (and any other non-chat/vision task): no mutexGroup key
    // at all — embedding servers don't contend for the chat mutex group.
  } else if (typeof mutexGroup === "string" && mutexGroup) {
    gpuPolicy.mutexGroup = mutexGroup;
  } // mutexGroup === null -> explicitly none, no key at all

  const baseUrl = doorBaseUrl({ tailnetIp, port: gatewayPortFn() });
  const models = [{
    id: model.id,
    task: model.task,
    contextLen: model.context_len,
    ...(model.chat_template_kwargs && typeof model.chat_template_kwargs === "object"
      ? { chatTemplateKwargs: model.chat_template_kwargs }
      : {}),
  }];
  const description = `${model.family} ${quantEntry.quant} (native)`;

  const upserted = await upsertProviderFn(db, {
    id: providerId,
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
    id: providerId,
    providerId,
    registryKey: key,
    baseUrl,
    doorUrl: baseUrl,
    port,
    apiKey: null,
    host: "local",
    bundleId: null,
    description,
    models,
    gpuPolicy,
    disabled: false,
    converted,
    lamport_ts: upserted.lamport_ts,
  };
}

/**
 * Tear down a registered native model: stop its process (if a live runtime
 * handle is given — no process supervisor exists yet as of Task 7, this is
 * a forward-looking seam for the task that adds one), free its port
 * reservation, delete its blob (every part and companion the registry row
 * names) — UNLESS another enabled row still references the same registry
 * key (variants sharing weights, Task 8) or the entry is `adopted` (Task
 * 9: weights outside the managed blobs dir that this pipeline never
 * downloaded and must never delete) — soft-delete its provider row, and
 * invalidate the providers cache. Order is binding (asserted via injected
 * spies in tests) — each step only starts once the previous one has
 * settled.
 *
 * `modelId` here is really the provider row's `id` (a role or variant, not
 * necessarily a catalog id — see `registerModel`'s `providerId`). The
 * registry key to act on is resolved from THIS row's own
 * `gpu_policy.{catalogId,quant}` (`findRegistryEntryForProvider`), falling
 * back to the bare `modelId` for a legacy row that predates the
 * `<catalogId>@<quant>` keying (or one already gone from the DB — the row
 * is looked up in `listProvidersAllFn`, and its absence is not an error).
 * Once the key is known, every OTHER enabled row whose own
 * `gpu_policy.{catalogId,quant}` maps to that same key is a still-live
 * reference: if any exist, the registry entry (and therefore the on-disk
 * weights) survive this teardown — only this row's provider entry is
 * disabled/released. The registry entry (and, unless adopted, the files it
 * names) is removed only when this is the LAST reference.
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
  listProvidersAllFn = listProvidersAll,
}) {
  if (runtimeHandle && runtimeHandle.live) {
    await runtimeHandle.stop();
  }

  const state = loadState(dir);
  releasePortFn(state, modelId);

  const rows = await listProvidersAllFn(db);
  const self = rows.find((r) => r.id === modelId) || null;
  const found = self ? findRegistryEntryForProvider(state, self) : null;
  const key = found ? found.key : modelId;
  const regEntry = state.registry[key];
  const otherRefs = rows.filter((r) => r.id !== modelId && !r.disabled && r.gpuPolicy?.runtime === NATIVE_RUNTIME
    && r.gpuPolicy.catalogId && r.gpuPolicy.quant && registryKey(r.gpuPolicy.catalogId, r.gpuPolicy.quant) === key);
  const lastReference = otherRefs.length === 0;
  if (lastReference) delete state.registry[key];
  saveState(dir, state);

  // Primary part, then shards, then companions (schema v2) — a legacy row
  // with neither field unlinks exactly its one file, as before. An
  // `adopted` entry (Task 9) is never unlinked — those weights live
  // outside the managed blobs dir and this pipeline doesn't own them.
  // `regEntry.path`, when present, is the adopted file's absolute path;
  // otherwise every name is a basename resolved under `modelsBlobDir`.
  let deleted = false;
  if (lastReference && regEntry?.file && !regEntry.adopted) {
    const primary = regEntry.path || join(modelsBlobDir(dir), regEntry.file);
    const owned = [
      primary,
      ...(Array.isArray(regEntry.shardFiles) ? regEntry.shardFiles.map((n) => join(modelsBlobDir(dir), n)) : []),
      ...(Array.isArray(regEntry.companions)
        ? regEntry.companions.map((c) => c && (c.path || (c.file && join(modelsBlobDir(dir), c.file))))
        : []),
    ].filter((p) => typeof p === "string" && p.length > 0);
    for (const dest of owned) {
      try {
        unlinkFn(dest);
        deleted = true;
      } catch (err) {
        if (err && err.code !== "ENOENT") throw err;
      }
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
