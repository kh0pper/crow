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
import { fileURLToPath } from "node:url";
import { join, dirname, resolve } from "node:path";
import { networkInterfaces } from "node:os";
import { loadProviders as loadCachedProviders } from "../shared/providers.js";

const __filename = fileURLToPath(import.meta.url);
const BUNDLES_DIR = resolve(dirname(__filename), "..", "..", "bundles");

function loadProviders() {
  return loadCachedProviders();
}

/**
 * F-INSTALL-10 — physical locality gate.
 *
 * The orchestrator's job is `docker compose up/stop` on THIS machine, so the
 * only trustworthy signal is whether the provider's baseUrl points AT this
 * machine (loopback or one of our own interface addresses). The providers
 * `host` column cannot be used: it syncs fleet-wide with the seeding
 * instance's perspective baked in (live fleet: grackle's own embed row says
 * host='grackle-5fc01ac74463b6f4', crow's bundles say 'local' everywhere),
 * so a host-string gate either breaks a peer keeping its own bundle resident
 * or lets a fresh install start the maintainer-lab's bundles.
 */
// Bridge/virtual interfaces carry SHARED-SUBNET gateway IPs (every docker
// host has 172.17.0.1; libvirt ships 192.168.122.1) — never machine identity
// (R2-M1). Skip them so a peer's hypothetical bridge-IP baseUrl can't
// false-match here.
const VIRTUAL_IF_RE = /^(docker|br-|veth|virbr|vmnet|lxc|cni)/;

export function getOwnAddresses() {
  const own = new Set(["localhost", "127.0.0.1", "::1"]);
  try {
    for (const [ifname, addrs] of Object.entries(networkInterfaces())) {
      if (VIRTUAL_IF_RE.test(ifname)) continue;
      for (const a of addrs || []) own.add(a.address);
    }
  } catch {}
  return own;
}

export function isLocallyOrchestratable(p, ownAddrs = getOwnAddresses()) {
  if (!p?.baseUrl) return false;
  try {
    // WHATWG URL keeps brackets on IPv6 hostnames ("[::1]"); interface
    // addresses don't have them.
    const h = new URL(p.baseUrl).hostname.replace(/^\[|\]$/g, "");
    return ownAddrs.has(h);
  } catch {
    return false;
  }
}

const READINESS_TIMEOUT_MS = 240_000;  // vLLM VL warm takes 2.5-3.5 min on 16 GB
const READINESS_POLL_MS = 2_000;
const READINESS_INITIAL_DELAY_MS = 1_000;
const PROBE_TIMEOUT_MS = 2_000;

const IDLE_REVERT_MS = Number(process.env.GPU_IDLE_REVERT_MS ?? 20 * 60 * 1000);
const IDLE_CHECK_INTERVAL_MS = Number(process.env.GPU_IDLE_CHECK_INTERVAL_MS ?? 2 * 60 * 1000);

let _swapInFlight = Promise.resolve();
let _initialized = false;
let _idleRevertTimer = null;
const _lastUsedAt = new Map(); // providerName -> epoch ms of last acquireProvider success

// -----------------------------------------------------------------------
// Bundle control
// -----------------------------------------------------------------------

function composeFile(bundleId) {
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

export function alwaysResidentProviders(cfg = loadProviders(), ownAddrs = getOwnAddresses()) {
  const entries = Object.entries(cfg.providers || {})
    .filter(([, v]) => v.gpuPolicy?.alwaysResident === true || v.alwaysResident === true);
  const skipped = entries.filter(([, v]) => !isLocallyOrchestratable(v, ownAddrs)).map(([n]) => n);
  if (skipped.length) {
    console.log(`[gpu-orchestrator] skipping alwaysResident provider(s) not hosted on this machine: ${skipped.join(", ")}`);
  }
  return entries.filter(([, v]) => isLocallyOrchestratable(v, ownAddrs)).map(([n]) => n);
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
}
