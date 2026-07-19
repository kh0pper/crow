/**
 * GPU orchestrator — manages on-demand vLLM bundles that can't all coexist
 * on a single GPU. Declares:
 *
 *   - `alwaysResident: true` providers (in models.json) — ensured up at
 *     gateway startup and kept up.
 *   - `mutexGroup: "<name>"` providers — only one member of the group can
 *     be resident at a time. Acquiring one stops the others.
 *
 * Control plane: `docker compose -f bundles/<bundleId>/docker-compose.yml`.
 * Data plane: readiness probe against `{baseUrl}/models`.
 *
 * Single-flight: only one swap can run at a time (`_swapInFlight` promise).
 * Callers queue behind it via `acquireProvider(name)`.
 *
 * --- Declaring a mutex group ---
 *
 * A `mutexGroup` models SHARED-RESOURCE CONTENTION between bundles. Declare
 * one whenever two bundles cannot both be resident on the same machine at
 * the same time, for ANY reason:
 *
 *   - Same listening port (two containers binding :8003 is a hard conflict).
 *   - Same GPU memory pool (e.g., Strix Halo's 124 GB unified pool — two
 *     65 GB models can't co-exist even if their ports differ).
 *   - Same NUMA domain, same thermal envelope, same PCIe device, etc.
 *
 * Port collision is the obvious case but typically subsumed by the memory
 * case on single-GPU hosts — if two bundles fit in VRAM together but bind
 * the same port, they already can't co-exist. The reverse is NOT true:
 * different-port bundles can still blow out VRAM. Declare the group on
 * the BROADEST shared resource (Apr 2026 hindsight: the original
 * `8003-swap` group on the crow-swap-* providers was too narrow and
 * caused a VRAM exhaustion when crow-chat (:8002) tried to load Qwen3-32B
 * on top of an already-resident :8003 bundle. Now all five crow-*
 * providers share `crow-strix-vram`).
 *
 * Keep `defaultMember: true` on exactly one provider per group if you
 * want idle auto-revert to restore it after a specialist times out.
 *
 * --- Native runtime providers (Item G, Task 9) ---
 *
 * A provider is native iff `gpuPolicy.runtime === "native"` (only
 * `manager.js`'s `registerModel` writes this). Control plane: spawn/kill a
 * local `llama-server` process via `models/runtime.js`'s `startModel`/
 * `stopModel`, not docker compose. Cross-GATEWAY-PROCESS contention for a
 * native model's mutexGroup is arbitrated by an advisory host-wide lock
 * (`models/native-lock.js`'s `acquireHostLock`) that is held for the LIFE
 * of the model's residency — acquired right before a successful start,
 * released exactly once when that process reaches a terminal state
 * (explicit stop, idle-timeout self-stop, or restarts-exhausted), via
 * `startModel`'s `onTerminal` callback. See `acquireOrStartNative`'s doc
 * for the full ordering.
 *
 * KNOWN v1 LIMITATION: this lock arbitrates native-vs-native ONLY. Nothing
 * in the Docker control plane reads it, so a Docker bundle acquired on one
 * gateway process and a native model acquired on ANOTHER gateway process,
 * contending for the same physical GPU/RAM but declared in different
 * mutexGroups, are NOT mutually excluded by anything in this file.
 * Same-PROCESS eviction between the two control planes IS covered in both
 * directions (a native acquire stops a Docker sibling via `bundleStop`; a
 * Docker acquire stops a native sibling via its handle's `stop()`) — only
 * the cross-process case is an open gap, left for a future revision if
 * multi-gateway hosts ever need a unified VRAM ledger.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname, resolve } from "node:path";
import { loadProviders as loadCachedProviders } from "../shared/providers.js";
import { getOwnAddresses, isLocallyOrchestratable } from "../shared/locality.js";
import {
  setResidencyInitialized, recordResidency, releaseResidency,
  pruneResidency, getProviderHealth,
} from "./provider-health.js";
import { resolveDataDir, createDbClient } from "../db.js";
import { loadState, saveState, reconcileOnBoot } from "./models/state.js";
// wasLive-marker plumbing lives in this file (not state.js) so it can reuse
// `startNativeAndAwaitReady`'s ALREADY-resolved `dir` — see
// `persistLivenessMarker`'s doc below for why this deliberately never
// calls the bare `resolveDataDir()` on its own.
import { acquireHostLock } from "./models/native-lock.js";
import { identityProbe, startModel, stopModel, ensureRuntime, nativeReadinessTimeoutMs } from "./models/runtime.js";
import { getCachedProbe, reprobe } from "./models/probe.js";
import { enqueueDownload } from "./models/manager.js";
import { listProvidersAll } from "../shared/providers-db.js";

const __filename = fileURLToPath(import.meta.url);
const BUNDLES_DIR = resolve(dirname(__filename), "..", "..", "bundles");
const MODEL_CATALOG_PATH = resolve(dirname(__filename), "..", "..", "registry", "model-catalog.json");

// mtime-checked cache — `defaultLoadCatalog` runs on every native acquire
// (potentially every chat turn once a native model is warm), so a bare
// readFileSync+JSON.parse per call is wasted work for a file that changes
// only on deploy. Re-reads only when the file's mtime actually moves (an
// `npm run deploy`/git-pull picking up a catalog update), never silently
// staying stale across a long-running gateway process.
let _catalogCache = null;
let _catalogCacheMtimeMs = null;

/** Default `loadCatalogFn` for the native start path — reads the curated
 * catalog's `runtime` block (llama.cpp version pin + per-platform assets)
 * that `ensureRuntime` needs. Injectable so tests never touch the real
 * repo-tracked catalog file (and never see cross-test cache pollution —
 * each test supplies its own `loadCatalogFn`, bypassing this cache
 * entirely). */
function defaultLoadCatalog() {
  let mtimeMs;
  try {
    mtimeMs = statSync(MODEL_CATALOG_PATH).mtimeMs;
  } catch {
    mtimeMs = null;
  }
  if (_catalogCache && mtimeMs !== null && mtimeMs === _catalogCacheMtimeMs) {
    return _catalogCache;
  }
  _catalogCache = JSON.parse(readFileSync(MODEL_CATALOG_PATH, "utf8"));
  _catalogCacheMtimeMs = mtimeMs;
  return _catalogCache;
}

function loadProviders() {
  return loadCachedProviders();
}

// F-INSTALL-10 physical locality gate — implementation lives in
// servers/shared/locality.js (shared with the providers reconciler's
// owner-asserts gate). Re-exported here for existing importers/tests.
export { getOwnAddresses, isLocallyOrchestratable };

const READINESS_TIMEOUT_MS = 240_000;  // vLLM VL warm takes 2.5-3.5 min on 16 GB
const READINESS_POLL_MS = 2_000;
const READINESS_INITIAL_DELAY_MS = 1_000;
const PROBE_TIMEOUT_MS = 2_000;

// -----------------------------------------------------------------------
// Native runtime — typed errors (Item G, Task 9)
// -----------------------------------------------------------------------

/** Thrown when a native provider's port is answering, but NOT as the model
 * we expect (`identityProbe` returned "conflict") — either on the fast
 * path (already-something-else resident) or after a fresh start that bound
 * a port already claimed by an unrelated process. NEVER treated as
 * resident, NEVER routed traffic — see `identityProbe`'s doc for why. */
export class NativePortConflictError extends Error {
  constructor(providerName, baseUrl) {
    super(`native provider "${providerName}" (${baseUrl}) is serving a different model than expected — refusing to route traffic`);
    this.name = "NativePortConflictError";
    this.code = "NATIVE_PORT_CONFLICT";
    this.providerName = providerName;
    this.baseUrl = baseUrl;
  }
}

/** Thrown when `acquireHostLock` returns null for a native provider's mutex
 * group — some other Crow instance (a different gateway process on this
 * same host) currently holds the GPU/RAM for that group. Honest, typed —
 * never silently swallowed into a generic false/null. */
export class NativeHostLockHeldError extends Error {
  constructor(mutexGroup) {
    super(`another Crow instance on this host is using the GPU/RAM (native runtime lock held for "${mutexGroup}")`);
    this.name = "NativeHostLockHeldError";
    this.code = "NATIVE_HOST_LOCK_HELD";
    this.mutexGroup = mutexGroup;
  }
}

const IDLE_REVERT_MS = Number(process.env.GPU_IDLE_REVERT_MS ?? 20 * 60 * 1000);
const IDLE_CHECK_INTERVAL_MS = Number(process.env.GPU_IDLE_CHECK_INTERVAL_MS ?? 2 * 60 * 1000);
const RESIDENCY_POLL_MS = Number(process.env.CROW_PROVIDER_RESIDENCY_POLL_MS ?? 120_000);

let _swapInFlight = Promise.resolve();
let _initialized = false;
let _idleRevertTimer = null;
let _residencyTimer = null;
let _residencyInFlight = false;
let _residencyPollFailing = false; // edge-trigger for the poll's failure warn
const _lastUsedAt = new Map(); // providerName -> epoch ms of last acquireProvider success

// Live `startModel()` handles for native-runtime providers this process has
// started, keyed by provider name. Purely in-memory — reset on gateway
// restart, which is exactly the "simulated restart" case the re-warm path
// (identityProbe against the OS-level port, not this map) must still handle
// correctly: a missing entry here means "we don't have a handle", NOT
// "nothing is listening on that port".
const _nativeHandles = new Map();

/** Test seam — seed/clear a fake native handle without going through a real
 * `startModel()` spawn. Mirrors `_setDeferredResidentsForTest`. */
export function _setNativeHandleForTest(name, handle) {
  if (handle === null || handle === undefined) _nativeHandles.delete(name);
  else _nativeHandles.set(name, handle);
}

/**
 * Read-only accessor for this process's live `startModel()` handle for a
 * native-runtime provider (Item G, Task 12 follow-up from PR G-B's final
 * review: the models panel's stop/delete routes need to reach a live
 * process handle to hand into `manager.js`'s `unregisterModel({
 * runtimeHandle })` / to call `.stop()` directly, and `_nativeHandles` had
 * no public accessor — only the test-only seed/clear setter above).
 * Returns the handle (`{ live, stop(), status(), touch() }`, see
 * `runtime.js`'s `startModel` doc) or `null` if this process has no live
 * handle for `providerName` (nothing started here since boot, or it was
 * already stopped). Deliberately just a getter — no new mutation surface;
 * callers that need to stop it call `.stop()` on the returned handle
 * themselves (mirroring the sibling-eviction code in this same file). */
export function getNativeHandle(providerName) {
  return _nativeHandles.get(providerName) || null;
}

// -----------------------------------------------------------------------
// Bundle control
// -----------------------------------------------------------------------

/**
 * A bundleId is safe iff it is a single path segment: matches
 * /^[A-Za-z0-9][A-Za-z0-9._-]*$/ and is neither "." nor "..". Rejects empty,
 * non-strings, "..", ".", anything with a "/" or "\", and leading "-"/".".
 *
 * `bundleId` arrives from the fleet-synced providers.bundle_id column, so it
 * is attacker-influenceable. join(BUNDLES_DIR, "..", "docker-compose.yml")
 * resolves to the git-tracked repo-root compose file — a compose-exists gate
 * alone would pass for bundleId "..". Enforced INSIDE composeFile so it also
 * hardens the pre-existing bundleUp/bundleStop spawn paths.
 */
export function isSafeBundleId(id) {
  return typeof id === "string"
    && id !== "."
    && id !== ".."
    && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id);
}

export function composeFile(bundleId) {
  if (!isSafeBundleId(bundleId)) {
    throw new Error(`orchestrator: unsafe bundleId ${JSON.stringify(bundleId)}`);
  }
  return join(BUNDLES_DIR, bundleId, "docker-compose.yml");
}

function runDockerCompose(args, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolveP, reject) => {
    const child = spawn("docker", ["compose", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: BUNDLES_DIR,
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (b) => { stdout += b.toString(); });
    child.stderr.on("data", (b) => { stderr += b.toString(); });
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      reject(new Error(`docker compose ${args.join(" ")} timed out`));
    }, timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolveP({ stdout, stderr });
      else reject(new Error(`docker compose ${args.join(" ")} exit ${code}: ${stderr || stdout}`));
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function bundleUp(bundleId) {
  await runDockerCompose(["-f", composeFile(bundleId), "up", "-d"], { timeoutMs: 30_000 });
}

async function bundleStop(bundleId) {
  await runDockerCompose(["-f", composeFile(bundleId), "stop"], { timeoutMs: 30_000 });
}

// -----------------------------------------------------------------------
// Readiness probe
// -----------------------------------------------------------------------

async function probeReady(baseUrl) {
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForReady(baseUrl, { totalTimeoutMs = READINESS_TIMEOUT_MS } = {}) {
  await new Promise((r) => setTimeout(r, READINESS_INITIAL_DELAY_MS));
  const deadline = Date.now() + totalTimeoutMs;
  while (Date.now() < deadline) {
    if (await probeReady(baseUrl)) return true;
    await new Promise((r) => setTimeout(r, READINESS_POLL_MS));
  }
  return false;
}

// -----------------------------------------------------------------------
// Provider/mutex resolution
// -----------------------------------------------------------------------

function getProvider(name, cfg = loadProviders()) {
  return cfg.providers?.[name] || null;
}

function mutexGroupOf(provider) {
  if (!provider) return null;
  return provider.gpuPolicy?.mutexGroup ?? provider.mutexGroup ?? provider.models?.[0]?.mutexGroup ?? null;
}

/** A provider is native iff its gpu_policy JSON declares `runtime: "native"`
 * (see `manager.js`'s `registerModel` — the ONLY writer of this field). */
function isNativeRuntime(provider) {
  return provider?.gpuPolicy?.runtime === "native";
}

/** The llama-server `--alias` this provider serves — its own `models[0].id`,
 * per `registerModel`'s row shape (verbatim from the task brief). */
function nativeAlias(provider) {
  return provider?.models?.[0]?.id ?? null;
}

/** Parse the port out of a native provider's `baseUrl`
 * (`http://127.0.0.1:<port>/v1`). Never re-derived/re-allocated elsewhere —
 * a re-warm after restart MUST bind the exact port the DB row already
 * advertises, not a fresh one from the port pool. */
function portFromBaseUrl(baseUrl) {
  try {
    const port = Number(new URL(baseUrl).port);
    return Number.isFinite(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

function getMutexSiblings(name, cfg = loadProviders()) {
  const p = getProvider(name, cfg);
  const group = mutexGroupOf(p);
  if (!group) return [];
  return Object.entries(cfg.providers || {})
    .filter(([n, v]) => n !== name && mutexGroupOf(v) === group)
    .map(([n]) => n);
}

function isAlwaysResident(v) {
  return v?.gpuPolicy?.alwaysResident === true || v?.alwaysResident === true;
}

/** Every provider name declared alwaysResident in cfg, REGARDLESS of locality.
 *  PURE, no logging. The residency poll needs this for pruneResidency. */
export function declaredAlwaysResident(cfg = loadProviders()) {
  return Object.entries(cfg.providers || {})
    .filter(([, v]) => isAlwaysResident(v))
    .map(([n]) => n);
}

/** Declared alwaysResident AND locally orchestratable. PURE, no logging —
 *  so the 120s poll doesn't re-emit the boot skip line on every tick. */
export function localAlwaysResident(cfg = loadProviders(), ownAddrs = getOwnAddresses()) {
  return Object.entries(cfg.providers || {})
    .filter(([, v]) => isAlwaysResident(v) && isLocallyOrchestratable(v, ownAddrs))
    .map(([n]) => n);
}

export function alwaysResidentProviders(cfg = loadProviders(), ownAddrs = getOwnAddresses()) {
  const local = new Set(localAlwaysResident(cfg, ownAddrs));
  const declared = declaredAlwaysResident(cfg);
  const skipped = declared.filter((n) => !local.has(n));
  if (skipped.length) {
    console.log(`[gpu-orchestrator] skipping alwaysResident provider(s) not hosted on this machine: ${skipped.join(", ")}`);
  }
  return declared.filter((n) => local.has(n));
}

// Map<mutexGroup, { default: string|null, members: Array<{name, baseUrl, bundleId}> }>
function getMutexGroups() {
  const cfg = loadProviders();
  const groups = new Map();
  for (const [name, v] of Object.entries(cfg.providers || {})) {
    const group = mutexGroupOf(v);
    if (!group) continue;
    if (!groups.has(group)) groups.set(group, { default: null, members: [] });
    const g = groups.get(group);
    g.members.push({ name, baseUrl: v.baseUrl, bundleId: v.bundleId });
    if (v.gpuPolicy?.defaultMember === true || v.defaultMember === true) g.default = name;
  }
  return groups;
}

// -----------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------

/**
 * Fast check — is the provider's endpoint currently responsive?
 * Does NOT trigger a swap. Returns boolean.
 */
export async function isProviderReady(providerName) {
  const p = getProvider(providerName);
  if (!p?.baseUrl) return false;
  return probeReady(p.baseUrl);
}

/**
 * Chat-path safe acquire. Returns:
 *   - `null`   if `providerName` is unknown, has no `bundleId`, or its
 *              `host` is not "local" (i.e. the bundle belongs to a peer
 *              instance, not this crow). No-op; caller proceeds.
 *   - `true`   on success (ready or warmed in time).
 *   - `false`  if readiness timed out.
 *
 * Never throws — caller should fall through to the adapter on error.
 *
 * `opts.cfg` overrides the provider config this resolves `providerName`
 * from (tests only; forwarded to `acquireProvider` too — see its doc).
 *
 * `opts.onError`, if given, is invoked with the underlying thrown error
 * whenever this function is about to collapse it into a plain `false`
 * (Item G, PR G-F, defect 4). The tri-state return contract (`null` /
 * `true` / `false`) is relied on verbatim by several other callers
 * (`chat.js`, `llm-router.js`) that never pass `onError` and are
 * completely unaffected — this is an additive, opt-in seam, not a
 * change to what gets returned. `routes/models.js`'s start route is the
 * one caller that passes it, so it can thread the real reason (e.g.
 * `GLIBC_TOO_OLD`) into its 502 response instead of the generic
 * "failed to become ready" message that used to be the only thing a
 * caller ever saw — the actual cause previously reached nothing but
 * this function's own `console.warn` below.
 */
export async function maybeAcquireLocalProvider(providerName, opts = {}) {
  if (!providerName) return null;
  const cfg = opts.cfg || loadProviders();
  const p = getProvider(providerName, cfg);
  if (!p?.bundleId && !isNativeRuntime(p)) return null;
  // host unset defaults to local (matches resolveFromModelsJson).
  if (p.host && p.host !== "local") return null;
  if (!isLocallyOrchestratable(p)) return null; // F-INSTALL-10: not this machine's bundle
  try {
    return await acquireProvider(providerName, opts);
  } catch (err) {
    console.warn(`[gpu-orchestrator] maybeAcquireLocalProvider(${providerName}) failed: ${err.message}`);
    if (typeof opts.onError === "function") {
      try { opts.onError(err); } catch { /* caller's observer must never break this function */ }
    }
    return false;
  }
}

/**
 * Is `providerName` a native (llama.cpp/gateway-supervised) runtime — as
 * opposed to a Docker-bundle provider or a cloud/peer provider? PURE,
 * no I/O. Callers (chat.js) use this ONLY to pick user-facing copy for a
 * `maybeAcquireLocalProvider` failure — never to gate whether to acquire at
 * all (that decision belongs to `acquireProvider`/`maybeAcquireLocalProvider`
 * themselves). Unknown provider name -> false (never throws).
 */
export function isNativeRuntimeProvider(providerName, cfg = loadProviders()) {
  return isNativeRuntime(getProvider(providerName, cfg));
}

/**
 * Map a provider NAME to the bundle-backed provider that should be warmed for it.
 * PURE (takes the loaded providers cfg). Some providers are bundle-less raw-endpoint
 * aliases that share a baseUrl with a bundled provider — e.g. pi resolves to
 * "crow-local" (bundleId null, :8003), but the warmable bundle is "crow-chat"
 * (same :8003). Returns the name to warm (self if it has a bundle, else a local
 * sibling with the same baseUrl that does), or null when nothing is warmable
 * (cloud provider / unknown / no matching bundle).
 */
export function resolveWarmableProviderName(cfg, name, ownAddrs = getOwnAddresses()) {
  const provs = (cfg && cfg.providers) || {};
  const direct = provs[name];
  if (!direct) return null;
  if (direct.bundleId || isNativeRuntime(direct)) {
    if (!isLocallyOrchestratable(direct, ownAddrs)) return null; // F-INSTALL-10
    return name;
  }
  if (direct.host != null && direct.host !== "local") return null; // cloud alias — not warmable
  const base = direct.baseUrl || direct.baseURL || direct.base_url;
  if (!base) return null;
  for (const [n, v] of Object.entries(provs)) {
    if (n === name || !v || !v.bundleId) continue;
    if (!isLocallyOrchestratable(v, ownAddrs)) continue; // F-INSTALL-10
    if ((v.baseUrl || v.baseURL || v.base_url) === base) return n;
  }
  return null;
}

/**
 * Warm the bundle backing `name` (resolving a bundle-less alias to its sibling).
 * Returns the acquire result (true/false/null). Safe for cloud/unknown providers
 * (returns null — no-op). Backs POST /llm/acquire for the pi-bots background-job /
 * bridge warm path; the gateway chat path already warms inline.
 */
export async function warmProviderByName(name) {
  if (!name) return null;
  const target = resolveWarmableProviderName(loadProviders(), name);
  if (!target) return null;
  return maybeAcquireLocalProvider(target);
}

// Test/introspection helpers — exported for smoke scripts.
export const _internals = { getProvider, getMutexSiblings, getMutexGroups, mutexGroupOf };

// -----------------------------------------------------------------------
// Native runtime — acquire path (Item G, Task 9; lock-lifetime + download-
// isolation fixed in review round 1)
// -----------------------------------------------------------------------

// `ensureRuntime` in-flight dedupe, keyed by catalog release — a first
// install's download can take a while; if two callers ask for the same
// release concurrently (e.g. two providers on the same llama.cpp pin,
// acquired at the same moment by two chat turns), the second must await
// the first's already-running install rather than starting a redundant
// second download. `ensureRuntime` is itself idempotent (its manifest
// check + atomic staging-dir rename), so this is a performance/network
// courtesy, not a correctness requirement — but it's cheap to provide.
const _runtimeEnsureInFlight = new Map(); // release key -> Promise<binPath>

/**
 * Resolve the llama-server `binPath` for a native provider. Deliberately
 * called from `acquireProvider`'s native branch BEFORE the `_swapInFlight`
 * chain is ever touched (Task 9 review round 1, finding 2): a first-install
 * download can take minutes, and it must never occupy the single-flight
 * queue that unrelated Docker/native swaps for OTHER providers are waiting
 * behind — only the actual spawn+sibling-swap belongs in that critical
 * section. `ensureRuntime`'s own manifest check makes a repeat call for an
 * already-installed release cheap (no network I/O), so resolving it
 * unconditionally on every acquire — even one that turns out to hit the
 * `identityProbe` fast path and never needs to start anything — is an
 * acceptable, small, constant cost.
 */
async function resolveNativeBinPath(p, opts = {}) {
  const {
    ensureRuntimeFn = ensureRuntime,
    resolveDataDirFn = resolveDataDir,
    loadCatalogFn = defaultLoadCatalog,
    getCachedProbeFn = getCachedProbe,
    reprobeFn = reprobe,
  } = opts;
  const dir = resolveDataDirFn();
  const catalog = loadCatalogFn();
  // Fix 1 (final-review fix wave, CRITICAL): the cache is null until
  // reprobe() runs, and nothing on the production boot path ever calls it
  // — every native acquire threw UNSUPPORTED_PLATFORM(null) forever. Warm
  // it here, once, on a cache miss; reprobe() also populates probe.js's own
  // module cache, so subsequent calls' getCachedProbeFn() sees it warm and
  // never re-probes.
  let probe = getCachedProbeFn();
  if (!probe) {
    probe = await reprobeFn();
  }
  const key = (catalog && catalog.runtime && catalog.runtime.release) || "default";
  if (_runtimeEnsureInFlight.has(key)) return _runtimeEnsureInFlight.get(key);
  const inFlight = Promise.resolve()
    .then(() => ensureRuntimeFn(dir, catalog.runtime, probe))
    .finally(() => {
      if (_runtimeEnsureInFlight.get(key) === inFlight) _runtimeEnsureInFlight.delete(key);
    });
  _runtimeEnsureInFlight.set(key, inFlight);
  return inFlight;
}

/** Poll `identityProbe` until it reports "resident" or "conflict", or the
 * timeout elapses (-> "down"). Mirrors `waitForReady`'s shape for the
 * Docker path, but native readiness is identity-based (is THIS the model
 * we asked for), not just a bare 200. */
async function waitForNativeReady(baseUrl, alias, {
  totalTimeoutMs, pollMs, initialDelayMs, identityProbeFn, fetchImpl,
}) {
  await new Promise((r) => setTimeout(r, initialDelayMs));
  const deadline = Date.now() + totalTimeoutMs;
  while (Date.now() < deadline) {
    const status = await identityProbeFn(baseUrl, alias, fetchImpl);
    if (status === "resident" || status === "conflict") return status;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return "down";
}

/**
 * Persist the "was this model live" marker `state.js`'s
 * `registryEntryRuntimeState` reads to distinguish a deliberately-stopped
 * model from one that's mid-restart-recovery (Task 13 fix round 1, finding
 * c — the panel's "reloading after update" state).
 *
 * Deliberately uses the REAL `loadState`/`saveState` against the EXACT
 * `dir` its caller already resolved (via the injectable `resolveDataDirFn`
 * every existing test in this file stubs to something like
 * `"/fake/crow-home"`) rather than re-resolving `resolveDataDir()` itself —
 * a bare, unmocked `resolveDataDir()` call falls back to the REAL
 * `~/.crow/data` when `CROW_DATA_DIR` isn't set in the calling process,
 * which every test in this file that exercises the native-start path is
 * exactly that case (`node --test <this file>` alone, outside `npm test`'s
 * scratch-CROW_HOME wrapper). Wrapped in try/catch and never throws: this
 * is a UI-only marker, and a fixture/test `dir` that was never meant to be
 * written to must degrade to a harmless no-op (an EACCES/ENOENT at a path
 * like `/fake/crow-home`), never break process supervision or the caller's
 * return value.
 */
function persistLivenessMarker(dir, modelId, { wasLive }) {
  try {
    const state = loadState(dir);
    const entry = state.registry?.[modelId];
    if (!entry) return; // nothing registered under this id — nothing to mark
    state.registry[modelId] = {
      ...entry,
      wasLive,
      lastStoppedAt: wasLive ? null : new Date().toISOString(),
    };
    saveState(dir, state);
  } catch (err) {
    console.warn(`[gpu-orchestrator] failed to persist liveness marker for ${modelId}: ${err.message}`);
  }
}

/**
 * Start a native provider's llama-server process and wait for it to report
 * itself resident. Binds the EXACT port already encoded in `p.baseUrl` —
 * NEVER re-allocates a fresh one from the port pool. A bind failure (the
 * process never reports resident within the timeout) is an honest thrown
 * error, never a silent fallback to a different port.
 *
 * `opts.binPath`, if given, is used as-is (the caller already resolved it
 * via `resolveNativeBinPath` outside the single-flight); otherwise it's
 * resolved inline here (the `ensureResident` boot path calls this directly
 * and isn't queued behind `_swapInFlight`, so there's nothing to protect
 * it from). `opts.onTerminal`, if given, is forwarded verbatim to
 * `startModelFn` — see `runtime.js`'s `startModel` doc.
 *
 * Readiness timeout (Item G, Task 10): `opts.readinessTimeoutMs`, if given,
 * wins outright (tests use this to keep the timeout window short). Absent
 * that, the timeout is SCALED to the model's actual size via
 * `runtime.js`'s `nativeReadinessTimeoutMs(regEntry.sizeMb, opts.storageClass)`
 * — a multi-GB quant honestly gets longer to become ready than the old flat
 * `READINESS_TIMEOUT_MS` gave every native model regardless of size. An
 * older registry entry with no recorded `sizeMb` (registered before this
 * field existed) degrades to that function's `120_000`ms floor, not a
 * crash. `opts.storageClass` defaults to `"ssd"` — see `runtime.js`'s doc
 * for why this is an honest injectable override, not real detection.
 * `opts.nativeReadinessTimeoutMsFn` overrides the formula function itself
 * (test seam only).
 */
async function startNativeAndAwaitReady(providerName, p, opts = {}) {
  const {
    identityProbeFn = identityProbe,
    startModelFn = startModel,
    loadStateFn = loadState,
    resolveDataDirFn = resolveDataDir,
    fetchImpl,
    spawnFn,
    onTerminal,
    binPath: preResolvedBinPath,
    readinessTimeoutMs: readinessTimeoutMsOverride,
    readinessPollMs = READINESS_POLL_MS,
    readinessInitialDelayMs = READINESS_INITIAL_DELAY_MS,
    storageClass = "ssd",
    nativeReadinessTimeoutMsFn = nativeReadinessTimeoutMs,
  } = opts;

  const alias = nativeAlias(p);
  if (!alias) throw new Error(`orchestrator: native provider "${providerName}" has no model alias (models[0].id)`);
  const port = portFromBaseUrl(p.baseUrl);
  if (!port) throw new Error(`orchestrator: native provider "${providerName}" has an unparseable baseUrl port (${p.baseUrl})`);

  const dir = resolveDataDirFn();
  const state = loadStateFn(dir);
  const regEntry = state.registry?.[providerName];
  if (!regEntry?.file) {
    throw new Error(`orchestrator: no model registry entry for native provider "${providerName}" — was it registered?`);
  }
  const ggufPath = join(dir, "models", "blobs", regEntry.file);

  const readinessTimeoutMs = readinessTimeoutMsOverride != null
    ? readinessTimeoutMsOverride
    : nativeReadinessTimeoutMsFn(regEntry.sizeMb, storageClass);

  const binPath = preResolvedBinPath || await resolveNativeBinPath(p, opts);

  // Wrap the caller's onTerminal (if any — `acquireOrStartNative` passes
  // its lock-release closure here) so the SAME single, exactly-once
  // terminal transition also clears the wasLive marker BEFORE the lock
  // frees and BEFORE any restart could happen — finding c above. Reuses
  // this function's own already-resolved `dir`, never re-resolves it.
  const wrappedOnTerminal = (reason) => {
    persistLivenessMarker(dir, providerName, { wasLive: false });
    if (typeof onTerminal === "function") onTerminal(reason);
  };

  console.log(`[gpu-orchestrator] starting native ${providerName} (alias=${alias}, port=${port}, readinessTimeoutMs=${readinessTimeoutMs})`);
  const handle = startModelFn({ binPath, ggufPath, alias, port, spawn: spawnFn, onTerminal: wrappedOnTerminal });
  _nativeHandles.set(providerName, handle);

  const result = await waitForNativeReady(p.baseUrl, alias, {
    totalTimeoutMs: readinessTimeoutMs,
    pollMs: readinessPollMs,
    initialDelayMs: readinessInitialDelayMs,
    identityProbeFn,
    fetchImpl,
  });

  if (result === "resident") {
    console.log(`[gpu-orchestrator] ${providerName} ready`);
    _lastUsedAt.set(providerName, Date.now());
    persistLivenessMarker(dir, providerName, { wasLive: true });
    return true;
  }

  // Fix 5 (final-review fix wave, IMPORTANT): a FRESH start that ends in
  // "down" (readiness timeout) or "conflict" (bound the port but isn't
  // serving OUR alias) must not leave the process it just spawned running,
  // untracked, behind an about-to-be-released lock. Without this,
  // `acquireOrStartNative`'s `finally` still releases the mutex-group lock
  // (this throw means `success` never became `true`), while the loading/
  // misbehaving process kept running with its `_nativeHandles` entry still
  // intact — free lock, live orphan process, exactly the hazard this fix
  // closes. `handle.stop()` fires the handle's own `onTerminal("stopped")`,
  // which (per `acquireOrStartNative`) is ALSO wired to release this same
  // lock — but `release()` is idempotent (see `native-lock.js`), so that
  // and the `finally`'s own release below never double-free anything.
  try {
    await handle.stop();
  } catch (err) {
    console.warn(`[gpu-orchestrator] stop native ${providerName} after readiness failure failed: ${err.message}`);
  }
  if (_nativeHandles.get(providerName) === handle) _nativeHandles.delete(providerName);

  if (result === "conflict") {
    throw new NativePortConflictError(providerName, p.baseUrl);
  }
  // "down" — the process never reported itself resident within the
  // timeout. Never silently rebind on a different port; surface it.
  throw new Error(`orchestrator: native provider "${providerName}" failed to bind port ${port} within ${readinessTimeoutMs}ms — refusing to rebind on a different port`);
}

/**
 * Core native acquire, shared by `acquireProvider`'s native branch AND
 * `ensureResident`'s native branch (Task 9 review round 1: both paths can
 * start a process and therefore both need identical lock discipline).
 * Order (binding — see finding 1 of the review):
 *   1. `identityProbe` fast path — resident -> done, lock never touched
 *      (an already-resident model's lock is already held from ITS start,
 *      by definition below — re-touching it here would open a window
 *      where the lock is briefly free while the model is still up);
 *      conflict -> typed error, no lock ever taken, no traffic routed.
 *   2. Sibling swap — BEFORE taking the lock. A same-mutexGroup sibling
 *      may currently be the one holding this group's lock (locks now
 *      live for the life of a resident native model, not just its
 *      startup); stopping it releases that lock as a side effect of its
 *      own `onTerminal`, so the lock is free for us by the time step 3
 *      asks for it — UNLESS something outside this group's own siblings
 *      holds it, which is a genuine conflict, correctly surfaced by step 3.
 *   3. `acquireHostLock(mutexGroup)` — null -> typed "another Crow
 *      instance..." error.
 *   4. `startNativeAndAwaitReady`, with an `onTerminal` callback wired to
 *      release the lock taken in step 3. On a FAILED start (never became
 *      resident, or a post-start identity conflict), `finally` releases
 *      the lock immediately — ownership was never successfully handed
 *      off. On a SUCCESSFUL start, `finally` does NOT release it: the
 *      lock is now owned by the running process and is released exactly
 *      once, whenever it reaches a terminal state (explicit stop —
 *      including a future sibling swap-out or unregister — idle-timeout
 *      self-stop, or maxRestarts-exhausted unhealthy give-up), per
 *      `runtime.js`'s `startModel` `onTerminal` contract. A gateway
 *      crash mid-residency is covered separately, by `native-lock.js`'s
 *      stale-pid steal on the NEXT acquire.
 *
 * Cross-process Docker-vs-native is a known v1 gap: this lock arbitrates
 * native-vs-native only. A Docker bundle on another gateway process has no
 * way to observe or wait on this lock (nothing in the Docker control plane
 * reads it), so a Docker acquire on one gateway and a native acquire on
 * another, racing for the same physical GPU/RAM but in DIFFERENT
 * mutexGroups, are not mutually excluded by anything in this file. Only
 * same-PROCESS eviction (below, and its Docker-branch mirror in
 * `acquireProvider`) is guaranteed today.
 *
 * @returns {Promise<{freshStart: boolean}>} `freshStart` is `false` when
 *   the fast path found it already resident (nothing new happened —
 *   `ensureResident` uses this to decide whether to report embed
 *   recovery), `true` when this call actually started it.
 */
async function acquireOrStartNative(providerName, p, cfg, opts = {}) {
  const {
    acquireHostLockFn = acquireHostLock,
    identityProbeFn = identityProbe,
    stopModelFn = stopModel,
    bundleStopFn = bundleStop,
    probeReadyFn = probeReady,
    fetchImpl,
  } = opts;

  const alias = nativeAlias(p);
  if (alias) {
    const fastStatus = await identityProbeFn(p.baseUrl, alias, fetchImpl);
    if (fastStatus === "resident") {
      _lastUsedAt.set(providerName, Date.now());
      // Fix 2 (final-review fix wave, CRITICAL): handle.touch() resets
      // runtime.js's idle-stop timer — until this call it had ZERO
      // callers, so a resident native model under continuous active load
      // still got killed by its own idle timer (default 30 min) the
      // instant that timer's initial window elapsed, since nothing ever
      // reset it. This IS the traffic signal that should keep it warm.
      const liveHandle = _nativeHandles.get(providerName);
      if (liveHandle?.live) liveHandle.touch();
      return { freshStart: false };
    }
    if (fastStatus === "conflict") {
      throw new NativePortConflictError(providerName, p.baseUrl);
    }
    // "down" — fall through to sibling swap + lock + start.
  }

  const siblings = getMutexSiblings(providerName, cfg);
  for (const sibName of siblings) {
    const sib = getProvider(sibName, cfg);
    if (!sib || !isLocallyOrchestratable(sib)) continue;
    if (isNativeRuntime(sib)) {
      const sibHandle = _nativeHandles.get(sibName);
      if (sibHandle && sibHandle.live) {
        console.log(`[gpu-orchestrator] swapping out native ${sibName} for ${providerName}`);
        await stopModelFn(sibHandle).catch((err) =>
          console.warn(`[gpu-orchestrator] stop native ${sibName} failed: ${err.message}`)
        );
        _nativeHandles.delete(sibName);
      }
      _lastUsedAt.delete(sibName);
    } else if (sib.bundleId) {
      if (await probeReadyFn(sib.baseUrl)) {
        console.log(`[gpu-orchestrator] swapping out ${sibName} (bundleId=${sib.bundleId}) for ${providerName}`);
        await bundleStopFn(sib.bundleId).catch((err) =>
          console.warn(`[gpu-orchestrator] stop ${sib.bundleId} failed: ${err.message}`)
        );
        _lastUsedAt.delete(sibName);
      }
    }
  }

  const mutexGroup = mutexGroupOf(p) || providerName;
  const release = acquireHostLockFn(mutexGroup);
  if (!release) {
    throw new NativeHostLockHeldError(mutexGroup);
  }

  let success = false;
  try {
    const onTerminal = (reason) => {
      console.log(`[gpu-orchestrator] native ${providerName} lock released (terminal: ${reason})`);
      release();
    };
    await startNativeAndAwaitReady(providerName, p, { ...opts, onTerminal });
    success = true;
    return { freshStart: true };
  } finally {
    // A successful start hands lock ownership off to `onTerminal` above —
    // releasing here too would free it while the model is still resident
    // (finding 1). Only a FAILED start (never reached `success = true`)
    // releases here.
    if (!success) release();
  }
}

/** Thin `acquireProvider`-shaped wrapper — see `acquireOrStartNative`'s
 * doc for the actual logic. `acquireProvider`'s contract is "true on
 * success, throw on failure", so `freshStart` is not surfaced here (only
 * `ensureResident`'s native branch cares about that distinction). */
async function acquireNativeSwap(providerName, p, cfg, opts = {}) {
  await acquireOrStartNative(providerName, p, cfg, opts);
  return true;
}

/**
 * Ensure `providerName` is resident and responsive. Stops mutex siblings
 * first (if any). Waits up to READINESS_TIMEOUT_MS for warmup.
 *
 * Calls are serialized via a single-flight promise — concurrent callers
 * for the same or different providers queue cleanly.
 *
 * Returns true on success, false on timeout. Throws on docker errors.
 *
 * `opts` (native-only; ignored by the Docker branch) forwards injectable
 * seams to the native start path — see `startNativeAndAwaitReady`'s doc.
 * `opts.cfg` overrides the provider config the native branch resolves the
 * target/siblings from (tests only — production always omits it, so
 * `getProvider`/`getMutexSiblings` fall back to the real `loadProviders()`).
 * No existing caller passes `opts`, so Docker-path behavior is unaffected.
 */
export async function acquireProvider(providerName, opts = {}) {
  const cfg = opts.cfg || loadProviders();
  const p = getProvider(providerName, cfg);
  if (!p) throw new Error(`orchestrator: unknown provider "${providerName}"`);

  if (isNativeRuntime(p)) {
    if (!isLocallyOrchestratable(p)) {
      console.warn(`[gpu-orchestrator] refusing to orchestrate ${providerName} — its baseUrl is not on this machine`);
      return null;
    }
    // Resolve the runtime binary BEFORE touching _swapInFlight (Task 9
    // review round 1, finding 2): a first-install download can take
    // minutes and must never occupy the single-flight queue that an
    // unrelated provider's swap is waiting behind. Only the actual
    // spawn+sibling-swap (acquireNativeSwap, via startNativeAndAwaitReady)
    // runs inside the single-flight below.
    const binPath = await resolveNativeBinPath(p, opts);
    const nativeOpts = { ...opts, binPath };
    const nativeSwap = _swapInFlight.then(() => acquireNativeSwap(providerName, p, cfg, nativeOpts));
    _swapInFlight = nativeSwap.catch(() => {});
    return nativeSwap;
  }

  if (!p.bundleId) throw new Error(`orchestrator: provider "${providerName}" has no bundleId`);
  if (!isLocallyOrchestratable(p)) {
    console.warn(`[gpu-orchestrator] refusing to orchestrate ${providerName} — its baseUrl is not on this machine`);
    return null;
  }

  const swap = _swapInFlight.then(async () => {
    // Injectable purely so `acquireProvider ... a Docker provider evicts a
    // resident native sibling` is unit-testable without a real `docker`
    // binary (Task 9 review round 1, finding 3) — every default is the
    // exact real function, so no existing caller's behavior changes.
    const {
      probeReadyFn = probeReady,
      bundleUpFn = bundleUp,
      bundleStopFn = bundleStop,
      stopModelFn = stopModel,
      waitForReadyFn = waitForReady,
    } = opts;

    // Fast path: already resident.
    if (await probeReadyFn(p.baseUrl)) {
      _lastUsedAt.set(providerName, Date.now());
      return true;
    }

    // Stop mutex siblings first. A sibling can be native (Task 9 review
    // round 1, finding 3: same-PROCESS symmetric eviction — a native
    // sibling with a live handle in _nativeHandles is stopped via that
    // handle, same as the native branch's own sibling loop; its
    // `onTerminal` releases the native host lock as a side effect, same as
    // there). Cross-PROCESS Docker-vs-native is NOT covered — see the
    // module doc and `acquireOrStartNative`'s doc for why: the native
    // host lock has no Docker-side reader, so a Docker acquire on one
    // gateway and a native acquire on ANOTHER, contending for the same
    // physical GPU/RAM in different mutexGroups, are not mutually
    // excluded by anything in this file. Only this same-process case is.
    const siblings = getMutexSiblings(providerName, cfg);
    for (const sibName of siblings) {
      const sib = getProvider(sibName, cfg);
      if (!sib || !isLocallyOrchestratable(sib)) continue;
      if (isNativeRuntime(sib)) {
        const sibHandle = _nativeHandles.get(sibName);
        if (sibHandle && sibHandle.live) {
          console.log(`[gpu-orchestrator] swapping out native ${sibName} for ${providerName}`);
          await stopModelFn(sibHandle).catch((err) =>
            console.warn(`[gpu-orchestrator] stop native ${sibName} failed: ${err.message}`)
          );
          _nativeHandles.delete(sibName);
        }
        _lastUsedAt.delete(sibName);
        continue;
      }
      if (!sib.bundleId) continue;
      if (await probeReadyFn(sib.baseUrl)) {
        console.log(`[gpu-orchestrator] swapping out ${sibName} (bundleId=${sib.bundleId}) for ${providerName}`);
        await bundleStopFn(sib.bundleId).catch((err) =>
          console.warn(`[gpu-orchestrator] stop ${sib.bundleId} failed: ${err.message}`)
        );
        _lastUsedAt.delete(sibName);
      }
    }

    // Start target.
    console.log(`[gpu-orchestrator] starting ${providerName} (bundleId=${p.bundleId})`);
    await bundleUpFn(p.bundleId);
    const ready = await waitForReadyFn(p.baseUrl);
    if (ready) {
      console.log(`[gpu-orchestrator] ${providerName} ready`);
      _lastUsedAt.set(providerName, Date.now());
    } else {
      console.warn(`[gpu-orchestrator] ${providerName} did NOT become ready within ${READINESS_TIMEOUT_MS}ms`);
    }
    return ready;
  });

  // Replace the in-flight promise so the next acquire queues behind this.
  _swapInFlight = swap.catch(() => {});
  return swap;
}

/**
 * Idle auto-revert — for each mutex group with a declared defaultMember,
 * if a non-default member is currently resident and has not been acquired
 * within IDLE_REVERT_MS, swap back to the default. Pre-existing residents
 * with no recorded usage get a grace period (timer seeded on first sighting).
 */
async function checkIdleRevert() {
  const groups = getMutexGroups();
  for (const [, group] of groups) {
    if (!group.default) continue;
    for (const m of group.members) {
      if (m.name === group.default) continue;
      if (!m.baseUrl) continue;
      if (!(await probeReady(m.baseUrl))) {
        _lastUsedAt.delete(m.name);
        continue;
      }
      const last = _lastUsedAt.get(m.name);
      if (last === undefined) {
        _lastUsedAt.set(m.name, Date.now()); // seed grace period
        continue;
      }
      const idleFor = Date.now() - last;
      if (idleFor < IDLE_REVERT_MS) continue;
      console.log(`[gpu-orchestrator] ${m.name} idle ${Math.round(idleFor / 1000)}s — reverting to ${group.default}`);
      try {
        await acquireProvider(group.default);
      } catch (err) {
        console.warn(`[gpu-orchestrator] auto-revert to ${group.default} failed: ${err.message}`);
      }
    }
  }
}

export function startIdleRevertTimer() {
  if (_idleRevertTimer) return;
  if (!(IDLE_REVERT_MS > 0) || !(IDLE_CHECK_INTERVAL_MS > 0)) {
    console.log("[gpu-orchestrator] idle auto-revert disabled");
    return;
  }
  _idleRevertTimer = setInterval(() => {
    retryDeferredResidents().catch(() => {});
    checkIdleRevert().catch((err) =>
      console.warn(`[gpu-orchestrator] idle check failed: ${err.message}`)
    );
  }, IDLE_CHECK_INTERVAL_MS);
  _idleRevertTimer.unref?.();
  console.log(`[gpu-orchestrator] idle auto-revert enabled: threshold=${IDLE_REVERT_MS}ms, interval=${IDLE_CHECK_INTERVAL_MS}ms`);
}

function providerHasEmbedModel(provider) {
  return Array.isArray(provider?.models)
    && provider.models.some((m) => m?.task === "embed");
}

async function triggerEmbedBackfill() {
  try {
    const { runBackfill } = await import("../../scripts/backfill-embeddings.js");
    console.log("[gpu-orchestrator] embed recovered — running embedding backfill");
    const result = await runBackfill({
      log: (msg) => console.log(`[gpu-orchestrator/backfill] ${msg}`),
      logError: (msg) => console.warn(`[gpu-orchestrator/backfill] ${msg}`),
    });
    if (!result.ok) {
      console.warn(`[gpu-orchestrator] backfill skipped: ${result.error}`);
      return;
    }
    const perKind = Object.entries(result.perKind).map(([k, n]) => `${k}=${n}`).join(" ");
    console.log(`[gpu-orchestrator] backfill done: total=${result.total} ${perKind}`);
  } catch (err) {
    console.warn(`[gpu-orchestrator] backfill failed: ${err.message}`);
  }
}

let _deferredResidents = new Set();

/** Test seam (R2-C1 tests). */
export function _setDeferredResidentsForTest(names) {
  _deferredResidents = new Set(names);
}

/** Native branch of `ensureResident`: "resident" = process alive (we hold a
 * live handle) AND `identityProbe` confirms it's actually serving our
 * alias (per the task brief's exact definition) — a live process alone
 * isn't enough, matching `identityProbe`'s "never trust a port without
 * confirming what it's serving" stance. Not resident -> start it (no
 * lock/sibling-swap, mirroring the Docker branch's boot-time parity). */
async function ensureNativeResident(name, p, cfg, opts = {}) {
  // Delegates to the SAME core acquireProvider's native branch uses (Task
  // 9 review round 1, finding 1): both paths can start a process and
  // therefore both need identical lock discipline — a boot-time ensure
  // that started a model without taking/holding its mutexGroup's host
  // lock would leave that lock free for a DIFFERENT gateway process to
  // walk right past while this model is genuinely resident.
  const result = await acquireOrStartNative(name, p, cfg, opts);
  if (!result.freshStart) {
    console.log(`[gpu-orchestrator] ${name} already resident`);
    return false;
  }
  return providerHasEmbedModel(p);
}

/** Ensure ONE alwaysResident provider: probe → bundleUp → waitForReady.
 *  Returns true iff it warmed an embed-capable provider (caller may
 *  trigger the embedding backfill). Never throws.
 *
 *  `opts` (native-only) forwards injectable seams to
 *  `ensureNativeResident` — see its doc; ignored by the Docker branch. */
export async function ensureResident(name, cfg = loadProviders(), opts = {}) {
  try {
    const p = (cfg.providers || {})[name];
    if (p && isNativeRuntime(p)) {
      return await ensureNativeResident(name, p, cfg, opts);
    }
    if (!p?.bundleId) {
      console.warn(`[gpu-orchestrator] ${name} has no bundleId — skipping`);
      return false;
    }
    if (await probeReady(p.baseUrl)) {
      console.log(`[gpu-orchestrator] ${name} already resident`);
      return false;
    }
    console.log(`[gpu-orchestrator] starting ${name} (bundleId=${p.bundleId})`);
    await bundleUp(p.bundleId);
    const ready = await waitForReady(p.baseUrl);
    if (!ready) {
      console.warn(`[gpu-orchestrator] ${name} did NOT warm up in time`);
      return false;
    }
    return providerHasEmbedModel(p);
  } catch (err) {
    console.error(`[gpu-orchestrator] failed to bring up ${name}: ${err.message}`);
    return false;
  }
}

/** R2-C1: re-check boot-deferred alwaysResident providers against FRESH own
 *  addresses (tailscale0 may come up after the gateway). Called from the
 *  idle-revert interval. Returns the names ensured this pass. */
export async function retryDeferredResidents({
  cfg = loadProviders(),
  ownAddrs = getOwnAddresses(),
  ensure = ensureResident,
} = {}) {
  if (!_deferredResidents.size) return [];
  const ensured = [];
  let embedRecovered = false;
  for (const name of [..._deferredResidents]) {
    const p = (cfg.providers || {})[name];
    if (!p) { _deferredResidents.delete(name); continue; }
    if (!isLocallyOrchestratable(p, ownAddrs)) continue; // still not ours — stays parked
    _deferredResidents.delete(name);
    console.log(`[gpu-orchestrator] deferred alwaysResident ${name} is now locally hosted — ensuring (its interface came up after boot)`);
    if (await ensure(name, cfg)) embedRecovered = true;
    ensured.push(name);
  }
  if (embedRecovered) triggerEmbedBackfill();
  return ensured;
}

/**
 * Residency poll — the re-poll the original outage lacked. Read-only: probes
 * OWNED alwaysResident providers' baseUrls and records the result into
 * provider-health.js. Never takes the swap lock, never starts/stops a
 * container, and MUST NEVER THROW (the interval callback relies on it).
 *
 * All five inputs are injectable so unit tests never touch the network or the
 * real filesystem.
 *
 * Sticky ownership: once owned, a provider is probed every tick regardless of
 * whether it still passes the locality check — a tailscale0 restart must NOT
 * reset its outage clock, because if tailscale0 is down the provider genuinely
 * is unreachable. Ownership is re-evaluated ONLY when its baseUrl changes.
 */
export async function pollResidency(opts = {}) {
  const probed = [];
  try {
    const cfg = opts.cfg !== undefined ? opts.cfg : loadProviders();
    const ownAddrs = opts.ownAddrs !== undefined ? opts.ownAddrs : getOwnAddresses();
    const probe = opts.probe || probeReady;
    const now = opts.now || Date.now;
    const composeExists = opts.composeExists || ((id) => existsSync(composeFile(id)));

    // Accessing cfg.providers may throw (a getter over a failed DB read); doing
    // it inside this try makes the whole tick a no-op that leaves state intact.
    const declared = declaredAlwaysResident(cfg);
    const local = new Set(localAlwaysResident(cfg, ownAddrs));
    // One snapshot: entries are per-provider independent, and releaseResidency
    // below only ever affects the name being handled.
    const health = getProviderHealth();

    for (const name of declared) {
      const p = cfg.providers[name];
      if (!p) continue;

      // SSRF / path-traversal gate: only providers this machine can actually
      // orchestrate (a safe bundleId whose compose file exists) are probed.
      // Per-runtime: native providers have no bundleId/compose file at all
      // (their control plane is startModel/stopModel, not docker compose)
      // and must NEVER be releaseResidency()'d for lacking one.
      if (!isNativeRuntime(p)) {
        if (!p.bundleId || !isSafeBundleId(p.bundleId)) { releaseResidency(name); continue; }
        let exists = false;
        try { exists = composeExists(p.bundleId); } catch { exists = false; }
        if (!exists) { releaseResidency(name); continue; }
      }

      let prev = health.providers[name];
      // Operator repointed the provider — release and re-evaluate ownership
      // against the new address.
      if (prev?.owned && prev.baseUrl !== p.baseUrl) {
        releaseResidency(name);
        prev = undefined;
      }

      const owned = prev?.owned === true || local.has(name);
      // Not ours (a peer's provider — trap 1) or not yet local (a deferred
      // resident whose interface hasn't come up — trap 2): skip SILENTLY.
      if (!owned) continue;

      let ready = false, error = null;
      try { ready = await probe(p.baseUrl); } catch (e) { error = e; }
      recordResidency(name, { ready, nowMs: now(), baseUrl: p.baseUrl, embed: providerHasEmbedModel(p), error });
      probed.push(name);
    }

    // Prune ONLY names no longer DECLARED alwaysResident — the FULL declared
    // set, NOT `local`. Passing `local` would delete a provider's outage clock
    // the instant its interface flapped; that was the reviewed CRITICAL.
    // Prune only when we actually READ a config. loadProviders() returns
    // {providers:{}} when both the DB and models.json are unreadable, and an
    // empty map is indistinguishable from "every provider was deleted" — so
    // pruning on it would wipe every outage clock and restart the 10-min warn
    // window on each bad tick. Note the gate is "any provider present", not
    // "any alwaysResident present": a config that legitimately drops its last
    // alwaysResident provider still prunes. Defence-in-depth; loadProviders()
    // falls back to an operator-provided models.json / config/models.json
    // when the DB is unreadable (the repo no longer ships one — see
    // models.example.json).
    if (Object.keys(cfg.providers || {}).length > 0) pruneResidency(declared);
  } catch (err) {
    // Edge-triggered so a persistently broken config warns once, not every
    // 120s. Staying silent here would reproduce, inside the silence detector,
    // exactly the silent failure it exists to catch.
    if (!_residencyPollFailing) {
      _residencyPollFailing = true;
      console.warn(`[gpu-orchestrator] residency poll failed: ${err.message}`);
    }
    return probed;
  }
  _residencyPollFailing = false;
  return probed;
}

/**
 * Start the residency monitor: an unref'd interval (CROW_PROVIDER_RESIDENCY_POLL_MS,
 * default 120s) that runs pollResidency. Fires once immediately, then on the
 * interval. Idempotent; in-flight guarded so a slow poll can't stack; the
 * callback catches everything. Set the interval <= 0 to disable.
 */
export function startResidencyMonitor() {
  if (_residencyTimer) return;
  if (!(RESIDENCY_POLL_MS > 0) || !Number.isFinite(RESIDENCY_POLL_MS)) {
    console.log("[gpu-orchestrator] residency monitor disabled");
    return;
  }
  const tick = () => {
    if (_residencyInFlight) return;
    _residencyInFlight = true;
    Promise.resolve()
      .then(() => pollResidency())
      .catch(() => {})
      .finally(() => { _residencyInFlight = false; });
  };
  tick(); // fire one poll immediately (fire-and-forget)
  _residencyTimer = setInterval(() => {
    try { tick(); } catch {}
  }, RESIDENCY_POLL_MS);
  _residencyTimer.unref?.();
}

/** Test hook — clear and null the interval so the suite doesn't leak it. */
export function _stopResidencyMonitor() {
  if (_residencyTimer) { clearInterval(_residencyTimer); _residencyTimer = null; }
  _residencyInFlight = false;
  _residencyPollFailing = false;
}

/** True if a process with this pid appears to be alive on this host — same
 * rule as `native-lock.js`'s (unexported) `defaultIsProcessAlive`: a
 * `kill(pid, 0)` that succeeds, or fails EPERM (exists, owned by someone
 * else), both count as "alive"; only ESRCH means it's genuinely gone.
 * Duplicated locally (4 lines) rather than importing a private helper from
 * `native-lock.js` — this module's only real coupling to that file stays
 * the one function (`acquireHostLock`) the acquire path already needs. */
function defaultIsProcessAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === "EPERM";
  }
}

/**
 * Boot-time native-model reconciliation (final-review fix wave, Fix 3 —
 * IMPORTANT). `state.js`'s `reconcileOnBoot` is a pure function that was
 * never actually invoked from any production boot path — a killed gateway
 * left stale port reservations, unexplained provider-row orphans, and
 * abandoned in-progress GGUF downloads forever. This function is the
 * missing caller: loadState -> reconcileOnBoot (against the live
 * `providers` table, shaped to `{modelId}` for native rows, and a real
 * pid-liveness check) -> saveState (persists freed reservations) -> log
 * `orphanRows` honestly -> re-enqueue every still-journaled download via
 * `manager.js`'s `enqueueDownload`.
 *
 * Re-enqueue caveat (honest limitation, not silently papered over):
 * `state.journal` entries (see `state.js`'s doc) do not record which QUANT
 * a download was for — only `url`/`dest`/`bytesDone`/`expectedSha`.
 * `enqueueDownload` -> `downloadModel` re-derives `url`/`dest` from
 * `resolveEntry(catalog, modelId, quant)`, defaulting `quant` to the
 * model's `default_quant` when omitted (as it is here). A download that
 * was for the default quant (the common case) resumes correctly — its
 * freshly re-derived `url`/`dest` match the journaled ones, so
 * `downloadModel`'s own resume-match check picks up `bytesDone` where it
 * left off. A download for a NON-default quant re-derives a DIFFERENT
 * `url`/`dest`, fails that match, and restarts from scratch instead of
 * truly resuming — a safe degrade (no corruption, no crash), just not a
 * true resume; fixing it would require the journal to record `quant` too,
 * out of scope for this fix.
 *
 * Never throws — every failure mode (provider-row read, the reconcile call
 * itself, an individual re-enqueue) is independently caught and warned, so
 * a broken model-runtime state on one instance can never block gateway
 * boot for anyone. `db`, if omitted, degrades to "no provider rows" (still
 * frees reservations by liveness alone) — needed for callers/tests that
 * don't have a DB handle yet.
 *
 * @returns {Promise<{freedReservations:Array, orphanRows:Array, resumableDownloads:Array}>}
 */
const EMPTY_RECONCILE_PLAN = Object.freeze({ freedReservations: [], orphanRows: [], resumableDownloads: [] });

export async function initNativeModels({
  dir = resolveDataDir(),
  db,
  loadStateFn = loadState,
  saveStateFn = saveState,
  listProvidersAllFn = listProvidersAll,
  isProcessAliveFn = defaultIsProcessAlive,
  reconcileOnBootFn = reconcileOnBoot,
  enqueueDownloadFn = enqueueDownload,
  loadCatalogFn = defaultLoadCatalog,
} = {}) {
  // Whole body wrapped: `reconcileOnBootFn` is an injected seam (a caller's
  // stub, or a future state.js change) just as capable of throwing as the
  // I/O around it — every step here is "convenience/cleanup", never
  // boot-critical, so ANY failure degrades to the empty plan rather than
  // propagating (this function's own promise must never reject).
  try {
    const state = loadStateFn(dir);

    let nativeRows = [];
    if (db) {
      try {
        const rows = await listProvidersAllFn(db);
        nativeRows = rows
          .filter((r) => !r.disabled && r.gpuPolicy?.runtime === "native")
          .map((r) => ({ modelId: r.id }));
      } catch (err) {
        console.warn(`[gpu-orchestrator] native model reconcile: failed to read provider rows: ${err.message}`);
      }
    }

    const plan = reconcileOnBootFn({
      state,
      listProviderRows: () => nativeRows,
      isProcessAlive: isProcessAliveFn,
    });

    if (plan.freedReservations.length) {
      console.log(`[gpu-orchestrator] native model reconcile: freed ${plan.freedReservations.length} stale port reservation(s): ${plan.freedReservations.map((r) => r.modelId).join(", ")}`);
      saveStateFn(dir, state);
    }

    if (plan.orphanRows.length) {
      console.warn(`[gpu-orchestrator] native model reconcile: ${plan.orphanRows.length} provider row(s) with no matching port reservation: ${plan.orphanRows.map((r) => r.modelId).join(", ")}`);
    }

    for (const dl of plan.resumableDownloads) {
      try {
        const catalog = loadCatalogFn();
        console.log(`[gpu-orchestrator] native model reconcile: resuming interrupted download for ${dl.modelId} (${dl.bytesDone || 0} bytes so far)`);
        Promise.resolve(enqueueDownloadFn({ modelId: dl.modelId, dir, catalog })).catch((err) => {
          console.warn(`[gpu-orchestrator] native model reconcile: resume of ${dl.modelId} failed: ${err.message}`);
        });
      } catch (err) {
        console.warn(`[gpu-orchestrator] native model reconcile: could not re-enqueue ${dl.modelId}: ${err.message}`);
      }
    }

    return plan;
  } catch (err) {
    console.warn(`[gpu-orchestrator] native model reconcile failed: ${err.message}`);
    return EMPTY_RECONCILE_PLAN;
  }
}

/**
 * Startup — ensure all alwaysResident providers are up.
 * Non-fatal: logs and continues on error. Call from gateway init.
 *
 * If an embed-capable alwaysResident provider was down at startup and came
 * back up here, fire a non-blocking embedding backfill to catch rows that
 * were inserted while embed was offline.
 */
export async function initOrchestrator() {
  if (_initialized) return;
  _initialized = true;
  // ARM FIRST — before anything that can throw. _initialized is already set,
  // and the caller (post-listen.js) only .catch()es, so a throw below would
  // otherwise leave residency detection permanently disarmed (the exact
  // failure class this feature exists to eliminate).
  setResidencyInitialized();
  startResidencyMonitor();

  // Native-model boot reconciliation (final-review fix wave, Fix 3) — its
  // own dedicated try/catch, deliberately separate from the alwaysResident
  // loop below, so a reconcile failure can never prevent alwaysResident
  // bundles from coming up (and vice versa).
  try {
    const db = createDbClient();
    try {
      await initNativeModels({ db });
    } finally {
      try { db.close(); } catch { /* best effort */ }
    }
  } catch (err) {
    console.warn(`[gpu-orchestrator] native model reconcile failed: ${err.message}`);
  }

  try {
    const cfg = loadProviders();
    const ownAddrs = getOwnAddresses();
    const residents = alwaysResidentProviders(cfg, ownAddrs); // logs the skip line
    _deferredResidents = new Set(
      Object.entries(cfg.providers || {})
        .filter(([, v]) => (v.gpuPolicy?.alwaysResident === true || v.alwaysResident === true)
          && !isLocallyOrchestratable(v, ownAddrs))
        .map(([n]) => n)
    );
    if (residents.length === 0 && _deferredResidents.size === 0) {
      console.log("[gpu-orchestrator] no alwaysResident providers declared");
      startIdleRevertTimer();
      return;
    }
    if (residents.length) {
      console.log(`[gpu-orchestrator] ensuring alwaysResident: ${residents.join(", ")}`);
    }
    let embedRecovered = false;
    for (const name of residents) {
      if (await ensureResident(name, cfg)) embedRecovered = true;
    }
    startIdleRevertTimer();
    if (embedRecovered) {
      triggerEmbedBackfill(); // fire-and-forget — don't block gateway startup
    }
  } catch (err) {
    console.warn(`[gpu-orchestrator] initOrchestrator body failed: ${err.message}`);
  }
}
