/**
 * llama.cpp binary asset management + llama-server child supervision
 * (Item G, native model runtime, Task 8).
 *
 * Two layers:
 *
 *   - Asset layer (`resolveAsset`, `ensureRuntime`): turns a hardware probe
 *     (`servers/gateway/models/probe.js` shapes) plus the catalog's
 *     `runtime` block (`registry/model-catalog.json`) into a downloaded,
 *     checksum-verified, executable `llama-server` binary on disk under
 *     `<dir>/runtimes/llamacpp/<release>/`. Runtime binaries ship from
 *     github.com/ggml-org/llama.cpp releases — a DIFFERENT host allowlist
 *     from `manager.js`'s huggingface.co-only GGUF allowlist, so this
 *     module owns its own (`isAllowedRuntimeHost`) rather than importing
 *     `manager.js`'s (which is hardcoded to HF and not injectable). The
 *     redirect-following / streaming-hash / typed-error PATTERN mirrors
 *     `manager.js`'s `fetchModelBlob` deliberately, minus resume support:
 *     runtime archives are tens of MB (not the multi-GB GGUF files
 *     `manager.js` handles), so a killed download just restarts rather
 *     than resuming.
 *
 *   - Process layer (`startModel`, `stopModel`, `identityProbe`): spawns
 *     and supervises the `llama-server` child (own process group, restart
 *     with backoff, idle-timeout auto-stop, status snapshot for the
 *     panel), and answers "is the model this port is *actually* serving
 *     the one we think it is" for boot-time reconciliation.
 *
 * `dir` is always caller-injected (same convention as `state.js` and
 * `manager.js`) — never a hardcoded `~/.crow/...`.
 */

import { createHash } from "node:crypto";
import { execFileSync as execFileSyncNode, spawn as spawnCb } from "node:child_process";
import {
  chmodSync,
  createWriteStream as fsCreateWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import https from "node:https";
import { join, relative } from "node:path";

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

/** Thrown by `resolveAsset` (wrapped in its `{ error }` return, never
 * thrown directly by that function — see its doc) for every "can't
 * honestly pick an asset" case: unsupported platform/arch, no catalog
 * entry for the resolved key, or glibc too old for every candidate.
 * `code` is one of UNSUPPORTED_PLATFORM | NO_ASSET | GLIBC_TOO_OLD. */
export class RuntimeAssetError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "RuntimeAssetError";
    this.code = code;
    Object.assign(this, details);
  }
}

/** Thrown when a runtime-asset URL (initial or any redirect hop) resolves
 * to a host outside {@link isAllowedRuntimeHost}. */
export class RuntimeHostNotAllowedError extends Error {
  constructor(hostname) {
    super(`Host not allowed for runtime asset download: ${hostname}`);
    this.name = "RuntimeHostNotAllowedError";
    this.code = "HOST_NOT_ALLOWED";
    this.hostname = hostname;
  }
}

/** Thrown when a downloaded archive's sha256 does not match the catalog's
 * declared value. The partial file is deleted before this is thrown — a
 * mismatched archive is never left on disk, never extracted, and never
 * chmod+x'd. */
export class RuntimeChecksumError extends Error {
  constructor(expectedSha, actualSha) {
    super(`Runtime asset checksum mismatch: expected ${expectedSha}, got ${actualSha}`);
    this.name = "RuntimeChecksumError";
    this.code = "CHECKSUM_MISMATCH";
    this.expectedSha = expectedSha;
    this.actualSha = actualSha;
  }
}

/** Mirrors `manager.js`'s `DownloadProtocolError`: a non-https hop that
 * isn't explicitly test-escaped, a redirect with no Location header, or
 * exceeding the redirect cap. */
export class RuntimeDownloadProtocolError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "RuntimeDownloadProtocolError";
    this.code = code;
  }
}

/** Thrown when extraction completed but no file named `binaryName` was
 * found anywhere under the release directory — a corrupt/unexpected
 * archive layout. */
export class RuntimeExtractionError extends Error {
  constructor(message) {
    super(message);
    this.name = "RuntimeExtractionError";
    this.code = "EXTRACTION_FAILED";
  }
}

// ---------------------------------------------------------------------------
// glibc parsing (pure — mirrors probe.js's exported-pure-parser convention)
// ---------------------------------------------------------------------------

/**
 * Parse the glibc version out of `ldd --version` output. Both the vanilla
 * GNU output ("ldd (GNU libc) 2.35") and Debian/Ubuntu's patched form
 * ("ldd (Ubuntu GLIBC 2.35-0ubuntu3.8) 2.35") end their first line with
 * the bare "MAJOR.MINOR" — the regex anchors on that trailing token
 * rather than the first number seen, since the parenthetical package
 * string can itself contain a version-shaped number before it.
 * Returns `{ major, minor }` or `null` if unparseable/empty.
 */
export function parseGlibcVersion(lddOutput) {
  if (!lddOutput) return null;
  const firstLine = String(lddOutput).split("\n")[0] || "";
  const m = /(\d+)\.(\d+)\s*$/.exec(firstLine.trim());
  if (!m) return null;
  return { major: Number.parseInt(m[1], 10), minor: Number.parseInt(m[2], 10) };
}

/** True iff `actual` ({major,minor}, possibly null) satisfies `required`
 * (a "MAJOR.MINOR" string from the catalog, e.g. "2.34"). Missing/
 * unparseable `actual` never satisfies anything — undetectable is not
 * "assume it's fine", matching `probe.js`'s fail-closed fit-badge stance. */
export function glibcAtLeast(actual, required) {
  if (!actual || !required) return false;
  const parts = String(required).split(".").map((n) => Number.parseInt(n, 10));
  const reqMajor = parts[0];
  const reqMinor = parts[1] || 0;
  if (actual.major !== reqMajor) return actual.major > reqMajor;
  return actual.minor >= reqMinor;
}

// ---------------------------------------------------------------------------
// resolveAsset
// ---------------------------------------------------------------------------

const LINUX_VULKAN_KEY = "linux-x64-vulkan";
const LINUX_CPU_KEY = "linux-x64-cpu";
const DEFAULT_RUNTIME_BASE_URL = "https://github.com/ggml-org/llama.cpp";

/** Build a GitHub release-asset download URL. `baseUrl` defaults to the
 * real llama.cpp repo origin; tests override it to point at a local
 * fixture server while keeping the literal "github.com" hostname (and
 * therefore the allowlist check) realistic — see `manager.js`'s
 * `buildDownloadUrl` for the identical pattern. */
export function buildRuntimeDownloadUrl(release, file, baseUrl = DEFAULT_RUNTIME_BASE_URL) {
  return `${baseUrl}/releases/download/${release}/${file}`;
}

/**
 * Pick which catalog `runtime.assets` entry to install for this host,
 * honestly — never a guess. Pure/synchronous: every external fact
 * (`ldd --version` output, CPU architecture) is passed in via `opts`
 * rather than probed here, so this is unit-testable without a real host.
 *
 * Rules (spec verbatim):
 *   - `probe.platform` outside {"linux","darwin"} -> `UNSUPPORTED_PLATFORM`.
 *   - darwin: arch (from `opts.arch`, else `probe.arch`, else
 *     `process.arch` — `Probe` itself carries no arch field, hardware
 *     probing doesn't need one since it's a build-time host fact, not
 *     something requiring detection) picks darwin-arm64/darwin-x64; an
 *     arch that's neither -> `UNSUPPORTED_PLATFORM`.
 *   - linux + `probe.wsl2 === true` -> forces the cpu asset REGARDLESS of
 *     `probe.accel` — defense in depth on top of `probe.js` already
 *     forcing `accel:"cpu"` under WSL2 (this function never trusts accel
 *     alone for the wsl2 case, in case a probe object reaches here from
 *     somewhere that didn't apply that rule).
 *   - linux, not wsl2, `accel` in {"vulkan","cuda"}: try the vulkan asset
 *     (the only GPU-accelerated linux build the catalog ships — llama.cpp's
 *     Vulkan backend also runs on NVIDIA hardware, so a "cuda" probe result
 *     still resolves to the vulkan asset). Requires
 *     `glibcAtLeast(parseGlibcVersion(opts.lddOutput), asset.min_glibc)`;
 *     if that fails (too old, OR undetectable — unparseable/missing
 *     `opts.lddOutput` is treated the same as "too old" here: an unproven
 *     minimum is never assumed met), falls through to the cpu asset below
 *     rather than failing outright.
 *   - cpu asset: also glibc-gated (the catalog declares `min_glibc` on
 *     the cpu asset too). If the host doesn't meet even the cpu asset's
 *     requirement, that's `GLIBC_TOO_OLD` — an honest error, never a guess.
 *
 * @returns {{key:string,url:string,sha256:string}|{error:RuntimeAssetError}}
 */
export function resolveAsset(probe, runtimeBlock, opts = {}) {
  const assets = (runtimeBlock && runtimeBlock.assets) || {};
  const release = runtimeBlock && runtimeBlock.release;
  const { lddOutput, arch, baseUrl } = opts;

  if (!probe || (probe.platform !== "linux" && probe.platform !== "darwin")) {
    return {
      error: new RuntimeAssetError(
        `Unsupported platform for native runtime: ${probe && probe.platform}`,
        "UNSUPPORTED_PLATFORM",
        { platform: probe && probe.platform },
      ),
    };
  }

  if (probe.platform === "darwin") {
    const effectiveArch = arch || probe.arch || process.arch;
    const key = effectiveArch === "arm64" ? "darwin-arm64" : effectiveArch === "x64" ? "darwin-x64" : null;
    if (!key) {
      return {
        error: new RuntimeAssetError(
          `Unsupported darwin architecture: ${effectiveArch}`,
          "UNSUPPORTED_PLATFORM",
          { platform: "darwin", arch: effectiveArch },
        ),
      };
    }
    const asset = assets[key];
    if (!asset) {
      return { error: new RuntimeAssetError(`No runtime asset for "${key}" in catalog`, "NO_ASSET", { key }) };
    }
    return { key, url: buildRuntimeDownloadUrl(release, asset.file, baseUrl), sha256: asset.sha256 };
  }

  // linux
  const forceCpu = probe.wsl2 === true;
  const wantsGpu = !forceCpu && (probe.accel === "vulkan" || probe.accel === "cuda");

  if (wantsGpu) {
    const vkAsset = assets[LINUX_VULKAN_KEY];
    if (!vkAsset) {
      return { error: new RuntimeAssetError(`No runtime asset for "${LINUX_VULKAN_KEY}" in catalog`, "NO_ASSET", { key: LINUX_VULKAN_KEY }) };
    }
    if (glibcAtLeast(parseGlibcVersion(lddOutput), vkAsset.min_glibc)) {
      return { key: LINUX_VULKAN_KEY, url: buildRuntimeDownloadUrl(release, vkAsset.file, baseUrl), sha256: vkAsset.sha256 };
    }
    // Too old (or undetectable) for the GPU build — fall through to cpu.
  }

  const cpuAsset = assets[LINUX_CPU_KEY];
  if (!cpuAsset) {
    return { error: new RuntimeAssetError(`No runtime asset for "${LINUX_CPU_KEY}" in catalog`, "NO_ASSET", { key: LINUX_CPU_KEY }) };
  }
  if (cpuAsset.min_glibc && !glibcAtLeast(parseGlibcVersion(lddOutput), cpuAsset.min_glibc)) {
    return {
      error: new RuntimeAssetError(
        `glibc too old for any linux runtime asset (need >= ${cpuAsset.min_glibc})`,
        "GLIBC_TOO_OLD",
        { required: cpuAsset.min_glibc, detected: parseGlibcVersion(lddOutput) },
      ),
    };
  }
  return { key: LINUX_CPU_KEY, url: buildRuntimeDownloadUrl(release, cpuAsset.file, baseUrl), sha256: cpuAsset.sha256 };
}

// ---------------------------------------------------------------------------
// Runtime asset download (own allowlist — see module doc)
// ---------------------------------------------------------------------------

const RUNTIME_ALLOWED_HOSTS = new Set(["github.com", "objects.githubusercontent.com"]);

/** True iff `hostname` is exactly "github.com" or "objects.githubusercontent.com"
 * (GitHub's release-asset redirect target). No subdomain wildcarding —
 * these are the two literal hosts a llama.cpp release download hits. */
export function isAllowedRuntimeHost(hostname) {
  if (typeof hostname !== "string" || hostname.length === 0) return false;
  return RUNTIME_ALLOWED_HOSTS.has(hostname.toLowerCase());
}

function requestOnce(urlStr, { lookup }) {
  return new Promise((resolvePromise, reject) => {
    const urlObj = new URL(urlStr);
    const transport = urlObj.protocol === "https:" ? https : http;
    const req = transport.request(urlObj, { method: "GET", lookup }, (res) => resolvePromise({ res }));
    req.on("error", reject);
    req.end();
  });
}

/** Follow redirects manually, re-checking the host allowlist AND the
 * https-only requirement on every hop (see `manager.js`'s `openStream`
 * for why every hop, not just the first). `insecureHttpHosts` is the
 * same test-only escape as `manager.js` (default `[]` — https required
 * everywhere in production). */
async function openRuntimeStream({ url, lookup, maxRedirects, insecureHttpHosts = [] }) {
  let currentUrl = url;
  // eslint-disable-next-line no-await-in-loop -- sequential by nature, see manager.js's identical loop.
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const urlObj = new URL(currentUrl);
    if (!isAllowedRuntimeHost(urlObj.hostname)) {
      throw new RuntimeHostNotAllowedError(urlObj.hostname);
    }
    if (urlObj.protocol !== "https:") {
      const escaped = urlObj.protocol === "http:" && insecureHttpHosts.includes(urlObj.hostname);
      if (!escaped) {
        throw new RuntimeDownloadProtocolError(
          `Refusing non-https URL (${urlObj.protocol}) for host ${urlObj.hostname} — pass insecureHttpHosts to explicitly allow this host (tests only; never set in production)`,
          "INSECURE_PROTOCOL",
        );
      }
    }
    // eslint-disable-next-line no-await-in-loop
    const { res } = await requestOnce(currentUrl, { lookup });
    if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
      res.resume();
      const location = res.headers.location;
      if (!location) {
        throw new RuntimeDownloadProtocolError(`Redirect response (${res.statusCode}) with no Location header from ${currentUrl}`, "REDIRECT_NO_LOCATION");
      }
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    if (res.statusCode !== 200) {
      res.resume();
      throw new Error(`Unexpected HTTP status ${res.statusCode} downloading ${currentUrl}`);
    }
    return res;
  }
  throw new RuntimeDownloadProtocolError(`Too many redirects (> ${maxRedirects}) downloading ${url}`, "TOO_MANY_REDIRECTS");
}

/**
 * Download a runtime asset archive to `dest`, hashing incrementally
 * (never buffered whole in memory) and verifying against `expectedSha`
 * BEFORE returning. On checksum mismatch, or on any stream/network error
 * mid-download (connection drop, ENOSPC, ...), the partial file is
 * deleted before the error propagates — never left on disk to be
 * mistaken for a good (or resumable) one. Unlike `manager.js`'s GGUF
 * downloads, there is no journal here to resume against: runtime
 * archives are tens of MB, so a caller that wants to retry just calls
 * this again from scratch (see module doc for why resume isn't worth
 * the complexity here).
 */
export async function downloadRuntimeAsset({
  url,
  dest,
  expectedSha,
  lookup,
  maxRedirects = 5,
  createWriteStream = fsCreateWriteStream,
  insecureHttpHosts = [],
}) {
  const res = await openRuntimeStream({ url, lookup, maxRedirects, insecureHttpHosts });
  const hash = createHash("sha256");
  try {
    await new Promise((resolvePromise, reject) => {
      const ws = createWriteStream(dest);
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        try {
          res.destroy();
        } catch {
          /* already gone */
        }
        try {
          ws.destroy();
        } catch {
          /* already gone */
        }
        reject(err);
      };
      res.on("data", (chunk) => hash.update(chunk));
      res.on("error", fail);
      res.on("aborted", () => fail(new Error("Download aborted by remote server")));
      ws.on("error", fail);
      res.pipe(ws);
      ws.on("finish", () => {
        if (settled) return;
        settled = true;
        resolvePromise();
      });
    });
  } catch (err) {
    // Stream/network failure mid-download (not a checksum mismatch — that
    // case is handled below, after a successful stream completion). The
    // partial file is never left behind for a later caller to mistake
    // for a complete or resumable download.
    try {
      unlinkSync(dest);
    } catch {
      /* already gone, or never created */
    }
    throw err;
  }

  const sha256 = hash.digest("hex");
  if (expectedSha && sha256.toLowerCase() !== String(expectedSha).toLowerCase()) {
    try {
      unlinkSync(dest);
    } catch {
      /* best effort */
    }
    throw new RuntimeChecksumError(expectedSha, sha256);
  }
  return { path: dest, sha256 };
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/** Extract a `.tar.gz` runtime archive with the system `tar` binary (no
 * new npm dependency — Node has no built-in tar reader). Injectable via
 * `ensureRuntime`'s `extract` option so tests never depend on a real
 * downloaded archive's internal layout; production always uses this. */
function defaultExtractTarGz({ archivePath, destDir, execFileSyncImpl = execFileSyncNode }) {
  mkdirSync(destDir, { recursive: true });
  execFileSyncImpl("tar", ["-xzf", archivePath, "-C", destDir], { stdio: "ignore" });
}

function findBinaryRecursive(fsMod, dir, name) {
  let entries;
  try {
    entries = fsMod.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findBinaryRecursive(fsMod, full, name);
      if (found) return found;
    } else if (entry.name === name) {
      return full;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// ensureRuntime
// ---------------------------------------------------------------------------

/**
 * Ensure a working `llama-server` binary exists under
 * `<dir>/runtimes/llamacpp/<runtimeBlock.release>/` for this host, and
 * return its path. Idempotent: a prior successful install for the exact
 * same resolved asset (key + sha256) is detected via a small manifest
 * file and reused without re-downloading.
 *
 * Binding order — an unverified binary is NEVER made executable, let
 * alone spawned, AND the final `releaseDir` never observably contains a
 * partial install:
 *   1. `resolveAsset` (throws its wrapped error on failure — see below).
 *   2. Download the archive to a scratch file next to (not inside)
 *      `releaseDir`; `downloadRuntimeAsset` verifies its sha256 AND
 *      cleans up after itself on any failure (mismatch or mid-stream
 *      error) before this function proceeds.
 *   3. Extract (`tar`) into a STAGING directory
 *      (`<parent>/.extract-<key>-<release>.tmp`), never directly into
 *      `releaseDir`. A disk-full or killed process mid-tar leaves only a
 *      stray staging directory next to `releaseDir` — `releaseDir`
 *      itself is untouched, so a later run can never mistake a
 *      half-extracted archive for a complete install.
 *   4. Locate the `binaryName` file (default `"llama-server"`) anywhere
 *      under the staging directory.
 *   5. `chmodFn(stagedBinPath, 0o755)` — the ONLY point in this function
 *      that makes anything executable, and it only runs after steps
 *      2-4 have all succeeded. The manifest is ALSO written into the
 *      staging directory at this point (not into `releaseDir` yet) so it
 *      finalizes together with the binary in the next step — a reader
 *      can never observe a `releaseDir` with a binary but no manifest,
 *      or a manifest with no binary.
 *   6. Finalize with a single `renameSync(stagingDir, releaseDir)` — an
 *      atomic swap on the same filesystem. Any stale `releaseDir` left
 *      by an old/corrupt manifest is cleared first (POSIX `rename` onto
 *      a non-empty directory fails with `ENOTEMPTY`).
 *
 * `resolveAsset` itself returns `{ error }` rather than throwing (see its
 * doc); this function is the one that turns that into an actual throw,
 * since `ensureRuntime` is the point where an action was actually
 * attempted, matching this codebase's convention of throwing typed
 * errors at the point of a real mutation (see `manager.js`).
 *
 * @returns {Promise<string>} the executable binary's path.
 */
export async function ensureRuntime(dir, runtimeBlock, probe, opts = {}) {
  const {
    lddOutput,
    arch,
    lookup,
    maxRedirects = 5,
    createWriteStream = fsCreateWriteStream,
    insecureHttpHosts = [],
    baseUrl,
    download = downloadRuntimeAsset,
    extract = defaultExtractTarGz,
    binaryName = "llama-server",
    chmodFn = chmodSync,
    fs = { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync, rmSync, renameSync },
  } = opts;

  const resolved = resolveAsset(probe, runtimeBlock, { lddOutput, arch, baseUrl });
  if (resolved.error) throw resolved.error;

  const runtimesDir = join(dir, "runtimes", "llamacpp");
  const releaseDir = join(runtimesDir, runtimeBlock.release);
  const manifestPath = join(releaseDir, ".crow-runtime-installed.json");

  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      const candidateBinPath = manifest && manifest.relBinPath ? join(releaseDir, manifest.relBinPath) : null;
      if (
        manifest
        && manifest.key === resolved.key
        && manifest.sha256 === resolved.sha256
        && candidateBinPath
        && fs.existsSync(candidateBinPath)
      ) {
        return candidateBinPath; // already installed for this exact asset
      }
    } catch {
      /* corrupt manifest — fall through and reinstall */
    }
  }

  fs.mkdirSync(runtimesDir, { recursive: true });
  const archivePath = join(runtimesDir, `.download-${resolved.key}-${runtimeBlock.release}.tmp`);
  const stagingDir = join(runtimesDir, `.extract-${resolved.key}-${runtimeBlock.release}.tmp`);

  // Step 2: download + verify. Throws before anything below runs on a
  // checksum mismatch, host-not-allowed, protocol violation, or
  // mid-stream failure (and never leaves the partial archive behind
  // either — see `downloadRuntimeAsset`).
  await download({
    url: resolved.url,
    dest: archivePath,
    expectedSha: resolved.sha256,
    lookup,
    maxRedirects,
    createWriteStream,
    insecureHttpHosts,
  });

  // Only now (download verified) do we touch the staging extract dir —
  // clear any leftover from a previous crashed/killed attempt first.
  try {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  fs.mkdirSync(stagingDir, { recursive: true });

  // Step 3: extract into staging, never into releaseDir.
  extract({ archivePath, destDir: stagingDir });
  try {
    fs.unlinkSync(archivePath);
  } catch {
    /* best-effort cleanup of the staging archive */
  }

  // Step 4: locate, within staging.
  const stagedBinPath = findBinaryRecursive(fs, stagingDir, binaryName);
  if (!stagedBinPath) {
    try {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    throw new RuntimeExtractionError(`Extracted ${resolved.key} but found no "${binaryName}" binary under ${stagingDir}`);
  }

  // Step 5: the ONLY chmod+x in this function, only after 2-4 succeeded.
  chmodFn(stagedBinPath, 0o755);

  const relBinPath = relative(stagingDir, stagedBinPath);
  fs.writeFileSync(
    join(stagingDir, ".crow-runtime-installed.json"),
    JSON.stringify({ key: resolved.key, sha256: resolved.sha256, relBinPath, installedAt: new Date().toISOString() }, null, 2),
  );

  // Step 6: atomic(-ish) finalize — a single rename swaps the
  // fully-populated staging dir into place. Clear any stale releaseDir
  // first (POSIX rename onto an existing non-empty directory fails with
  // ENOTEMPTY).
  try {
    fs.rmSync(releaseDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  fs.renameSync(stagingDir, releaseDir);

  return join(releaseDir, relBinPath);
}

// ---------------------------------------------------------------------------
// setpriv availability probe
// ---------------------------------------------------------------------------

let _setprivCache;

/** Probe whether the `setpriv` binary (util-linux) is available on this
 * host, once — result is cached module-wide after the first real call
 * (production never re-execs it per model start). `force:true` bypasses
 * the cache (test-only, so a suite can exercise both outcomes in the
 * same process); `execFileSyncImpl` is injectable so tests never invoke
 * a real binary. */
export function probeSetprivAvailable(opts = {}) {
  const { execFileSyncImpl = execFileSyncNode, force = false } = opts;
  if (!force && _setprivCache !== undefined) return _setprivCache;
  try {
    execFileSyncImpl("setpriv", ["--version"], { stdio: "ignore" });
    _setprivCache = true;
  } catch {
    _setprivCache = false;
  }
  return _setprivCache;
}

/** Test-only: clear the module-wide setpriv-probe cache. */
export function __resetSetprivProbeCacheForTest() {
  _setprivCache = undefined;
}

// ---------------------------------------------------------------------------
// Process supervision
// ---------------------------------------------------------------------------

/** Default per-model idle timeout, minutes: `CROW_MODEL_IDLE_MIN` env var
 * (positive integer), else 30. */
export function defaultIdleMinutes() {
  const raw = Number.parseInt(process.env.CROW_MODEL_IDLE_MIN, 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 30;
}

/** Build the llama-server CLI args. MUST (per spec) include
 * `--alias <alias> --port <port> --host <host>`; also includes
 * `--model <ggufPath>` (the actual model-to-serve flag — implied by
 * `ggufPath` being a required `startModel` input, not separately called
 * out in the spec's "MUST include" list because that list is about the
 * identity/networking flags a caller can verify without knowing
 * llama-server's full CLI surface). */
export function buildLlamaServerArgs({ ggufPath, alias, port, host = "127.0.0.1", extraArgs = [] }) {
  return ["--model", ggufPath, "--alias", alias, "--port", String(port), "--host", host, ...extraArgs];
}

// Status snapshot registry for the panel (Task 9 wires this into
// gpu-orchestrator). Keyed by alias — `startModel` registers on start,
// `stop()` deregisters once the process has actually stopped.
const activeHandles = new Map();

/** Every currently-tracked model's `status()` snapshot, for the panel. */
export function getStatusSnapshot() {
  return Array.from(activeHandles.values()).map((h) => h.status());
}

/**
 * Spawn and supervise a llama-server child process.
 *
 * Returns a handle satisfying `{ live: boolean, stop(): Promise<void> }`
 * (the seam `manager.js`'s `unregisterModel({ runtimeHandle })` expects,
 * per Task 7) plus `status()` (snapshot for the panel) and `touch()`
 * (reset the idle timer on observed activity — callers wire this to
 * request traffic; Task 8 itself never calls it).
 *
 * Supervision:
 *   - Own process group (`detached: true`, mirroring `scripts/pi-bots/
 *     bridge.mjs`'s pi-supervision pattern) so `stop()` can
 *     `process.kill(-pid, "SIGTERM")` the whole tree, falling back to a
 *     direct child kill if the pgroup is already gone.
 *   - Wrapped in `setpriv --pdeathsig=SIGTERM <binPath> ...` IFF setpriv
 *     is available (probed via `probeSetprivAvailable()`, injectable via
 *     `setprivAvailable`) — belt-and-braces process-group supervision:
 *     if crow's own gateway process dies uncleanly (no chance to run its
 *     `stop()`/SIGTERM-the-group path), `--pdeathsig` still gets the
 *     child a SIGTERM directly from the kernel.
 *   - Restart-with-backoff on an unexpected exit: up to `maxRestarts`
 *     (default 3) restarts, each waiting `backoffMs(attemptIndex)`
 *     (default exponential, capped at 30s) before respawning. On the
 *     `maxRestarts`-th unexpected exit, gives up: `state` becomes
 *     `"unhealthy"`, `lastError` retained, no further respawn.
 *   - Idle timer: stops the process after `idleMinutes` (default
 *     `defaultIdleMinutes()`) of no `touch()` calls, UNLESS `keepWarm` or
 *     `alwaysResident` is set (idle timer never scheduled at all in that
 *     case) or `idleMinutes <= 0`.
 *
 * `spawn`/`setTimeoutFn`/`clearTimeoutFn`/`setprivAvailable` are all
 * injectable so tests never touch a real process or a real clock.
 */
export function startModel({
  binPath,
  ggufPath,
  alias,
  port,
  host = "127.0.0.1",
  extraArgs = [],
  spawn = spawnCb,
  keepWarm = false,
  alwaysResident = false,
  idleMinutes = defaultIdleMinutes(),
  setprivAvailable = probeSetprivAvailable(),
  maxRestarts = 3,
  backoffMs = (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}) {
  const idleDisabled = !!keepWarm || !!alwaysResident || !(idleMinutes > 0);

  const handle = {
    alias,
    port,
    live: false,
    state: "starting",
    restartCount: 0,
    lastError: null,
    startedAt: null,
    child: null,
    _idleTimer: null,
    _restartTimer: null,
    _stopped: false,
  };

  function resetIdleTimer() {
    if (idleDisabled) return;
    if (handle._idleTimer) clearTimeoutFn(handle._idleTimer);
    handle._idleTimer = setTimeoutFn(() => handle.stop(), idleMinutes * 60 * 1000);
  }

  function spawnChild() {
    const args = buildLlamaServerArgs({ ggufPath, alias, port, host, extraArgs });
    const [cmd, cmdArgs] = setprivAvailable
      ? ["setpriv", ["--pdeathsig=SIGTERM", binPath, ...args]]
      : [binPath, args];
    const child = spawn(cmd, cmdArgs, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    handle.child = child;
    handle.live = true;
    handle.state = "running";
    handle.startedAt = new Date().toISOString();

    child.on("error", (err) => {
      handle.lastError = err && err.message;
    });
    child.on("exit", (code, signal) => {
      handle.live = false;
      handle.child = null;
      if (handle._stopped) {
        handle.state = "stopped";
        activeHandles.delete(alias);
        return;
      }
      handle.lastError = `exited (code=${code}, signal=${signal})`;
      if (handle.restartCount >= maxRestarts) {
        handle.state = "unhealthy";
        return;
      }
      handle.restartCount += 1;
      handle.state = "restarting";
      const delay = backoffMs(handle.restartCount - 1);
      handle._restartTimer = setTimeoutFn(() => {
        if (!handle._stopped) spawnChild();
      }, delay);
    });

    resetIdleTimer();
  }

  handle.status = function status() {
    return {
      alias,
      port,
      state: handle.state,
      live: handle.live,
      restartCount: handle.restartCount,
      lastError: handle.lastError,
      startedAt: handle.startedAt,
      pid: handle.child ? handle.child.pid : null,
    };
  };

  handle.touch = function touch() {
    resetIdleTimer();
  };

  handle.stop = function stop() {
    handle._stopped = true;
    if (handle._idleTimer) clearTimeoutFn(handle._idleTimer);
    if (handle._restartTimer) clearTimeoutFn(handle._restartTimer);
    activeHandles.delete(alias);
    if (!handle.child) {
      handle.state = "stopped";
      handle.live = false;
      return Promise.resolve();
    }
    const child = handle.child;
    const pid = child.pid;
    const exited = new Promise((resolvePromise) => child.once("exit", resolvePromise));
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }
    return exited.then(() => {
      handle.state = "stopped";
      handle.live = false;
    });
  };

  activeHandles.set(alias, handle);
  spawnChild();
  return handle;
}

/** Thin wrapper matching the spec's named export; identical to
 * `handle.stop()`. */
export function stopModel(handle) {
  return handle.stop();
}

// ---------------------------------------------------------------------------
// identityProbe
// ---------------------------------------------------------------------------

/**
 * Ask a (supposedly) running llama-server "who are you actually serving"
 * and compare against `alias`. Used at boot / before trusting a port
 * reservation: a process IS listening, but is it OUR model?
 *
 * `${baseUrl}/models` (brief-literal path) — a real llama-server exposes
 * this at `/v1/models`, so a production `baseUrl` already carries the
 * `/v1` suffix (matching the provider `base_url` shape `manager.js`
 * writes, `http://127.0.0.1:<port>/v1`); this function itself is
 * path-agnostic, it just appends "/models" to whatever it's given.
 *
 * - Connection refused / fetch throws -> `"down"`.
 * - Non-2xx status, or a body that isn't parseable JSON -> `"down"`
 *   (something's listening but isn't answering like a model server).
 * - `data.data[0].id === alias` -> `"resident"`.
 * - Anything else that DID respond successfully (including an empty
 *   `data` array, or a present-but-different id) -> `"conflict"`.
 *   **Deliberately never `"resident"` for this branch** — a live server
 *   that isn't provably serving `alias` must never be reported as if it
 *   were; a caller that trusted a false "resident" here could hand off
 *   requests to a completely different model without knowing it.
 *
 * @returns {Promise<"resident"|"conflict"|"down">}
 */
export async function identityProbe(baseUrl, alias, fetchImpl = fetch) {
  let res;
  try {
    res = await fetchImpl(`${baseUrl}/models`);
  } catch {
    return "down";
  }
  if (!res || !res.ok) return "down";
  let data;
  try {
    data = await res.json();
  } catch {
    return "down";
  }
  const servedId = data && Array.isArray(data.data) && data.data[0] && data.data[0].id;
  if (servedId === alias) return "resident";
  return "conflict";
}
