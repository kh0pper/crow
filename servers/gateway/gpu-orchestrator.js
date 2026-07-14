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
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname, resolve } from "node:path";
import { loadProviders as loadCachedProviders } from "../shared/providers.js";
import { getOwnAddresses, isLocallyOrchestratable } from "../shared/locality.js";
import {
  setResidencyInitialized, recordResidency, releaseResidency,
  pruneResidency, getProviderHealth,
} from "./provider-health.js";

const __filename = fileURLToPath(import.meta.url);
const BUNDLES_DIR = resolve(dirname(__filename), "..", "..", "bundles");

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

function getProvider(name) {
  const cfg = loadProviders();
  return cfg.providers?.[name] || null;
}

function mutexGroupOf(provider) {
  if (!provider) return null;
  return provider.gpuPolicy?.mutexGroup ?? provider.mutexGroup ?? provider.models?.[0]?.mutexGroup ?? null;
}

function getMutexSiblings(name) {
  const p = getProvider(name);
  const group = mutexGroupOf(p);
  if (!group) return [];
  const cfg = loadProviders();
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
 */
export async function maybeAcquireLocalProvider(providerName) {
  if (!providerName) return null;
  const p = getProvider(providerName);
  if (!p?.bundleId) return null;
  // host unset defaults to local (matches resolveFromModelsJson).
  if (p.host && p.host !== "local") return null;
  if (!isLocallyOrchestratable(p)) return null; // F-INSTALL-10: not this machine's bundle
  try {
    return await acquireProvider(providerName);
  } catch (err) {
    console.warn(`[gpu-orchestrator] maybeAcquireLocalProvider(${providerName}) failed: ${err.message}`);
    return false;
  }
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
  if (direct.bundleId) {
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

/**
 * Ensure `providerName` is resident and responsive. Stops mutex siblings
 * first (if any). Waits up to READINESS_TIMEOUT_MS for warmup.
 *
 * Calls are serialized via a single-flight promise — concurrent callers
 * for the same or different providers queue cleanly.
 *
 * Returns true on success, false on timeout. Throws on docker errors.
 */
export async function acquireProvider(providerName) {
  const p = getProvider(providerName);
  if (!p) throw new Error(`orchestrator: unknown provider "${providerName}"`);
  if (!p.bundleId) throw new Error(`orchestrator: provider "${providerName}" has no bundleId`);
  if (!isLocallyOrchestratable(p)) {
    console.warn(`[gpu-orchestrator] refusing to orchestrate ${providerName} — its baseUrl is not on this machine`);
    return null;
  }

  const swap = _swapInFlight.then(async () => {
    // Fast path: already resident.
    if (await probeReady(p.baseUrl)) {
      _lastUsedAt.set(providerName, Date.now());
      return true;
    }

    // Stop mutex siblings first.
    const siblings = getMutexSiblings(providerName);
    for (const sibName of siblings) {
      const sib = getProvider(sibName);
      if (!sib?.bundleId || !isLocallyOrchestratable(sib)) continue;
      if (await probeReady(sib.baseUrl)) {
        console.log(`[gpu-orchestrator] swapping out ${sibName} (bundleId=${sib.bundleId}) for ${providerName}`);
        await bundleStop(sib.bundleId).catch((err) =>
          console.warn(`[gpu-orchestrator] stop ${sib.bundleId} failed: ${err.message}`)
        );
        _lastUsedAt.delete(sibName);
      }
    }

    // Start target.
    console.log(`[gpu-orchestrator] starting ${providerName} (bundleId=${p.bundleId})`);
    await bundleUp(p.bundleId);
    const ready = await waitForReady(p.baseUrl);
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

/** Ensure ONE alwaysResident provider: probe → bundleUp → waitForReady.
 *  Returns true iff it warmed an embed-capable provider (caller may
 *  trigger the embedding backfill). Never throws. */
async function ensureResident(name, cfg = loadProviders()) {
  try {
    const p = (cfg.providers || {})[name];
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
      if (!p.bundleId || !isSafeBundleId(p.bundleId)) { releaseResidency(name); continue; }
      let exists = false;
      try { exists = composeExists(p.bundleId); } catch { exists = false; }
      if (!exists) { releaseResidency(name); continue; }

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
