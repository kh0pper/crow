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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const BUNDLES_DIR = resolve(dirname(__filename), "..", "..", "bundles");
const MODELS_JSON = resolve(dirname(__filename), "..", "..", "models.json");

// loadProviders() in ../orchestrator/providers.js strips unknown fields like
// mutexGroup + alwaysResident. Read models.json directly so the policy
// annotations are visible.
function loadProviders() {
  try {
    const raw = readFileSync(MODELS_JSON, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`[gpu-orchestrator] failed to read ${MODELS_JSON}: ${err.message}`);
    return { providers: {} };
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

// mutexGroup may be declared at the provider top-level (grackle-* convention)
// OR nested inside models[0] (crow-swap-* convention). Accept both.
function mutexGroupOf(provider) {
  if (!provider) return null;
  return provider.mutexGroup ?? provider.models?.[0]?.mutexGroup ?? null;
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

function alwaysResidentProviders() {
  const cfg = loadProviders();
  return Object.entries(cfg.providers || {})
    .filter(([, v]) => v.alwaysResident === true)
    .map(([n]) => n);
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
    if (v.defaultMember === true) g.default = name;
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
  try {
    return await acquireProvider(providerName);
  } catch (err) {
    console.warn(`[gpu-orchestrator] maybeAcquireLocalProvider(${providerName}) failed: ${err.message}`);
    return false;
  }
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
      if (!sib?.bundleId) continue;
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
  const residents = alwaysResidentProviders();
  if (residents.length === 0) {
    console.log("[gpu-orchestrator] no alwaysResident providers declared");
    startIdleRevertTimer();
    return;
  }
  console.log(`[gpu-orchestrator] ensuring alwaysResident: ${residents.join(", ")}`);
  let embedRecovered = false;
  for (const name of residents) {
    try {
      const p = getProvider(name);
      if (!p?.bundleId) {
        console.warn(`[gpu-orchestrator] ${name} has no bundleId — skipping`);
        continue;
      }
      if (await probeReady(p.baseUrl)) {
        console.log(`[gpu-orchestrator] ${name} already resident`);
        continue;
      }
      console.log(`[gpu-orchestrator] starting ${name} (bundleId=${p.bundleId})`);
      await bundleUp(p.bundleId);
      const ready = await waitForReady(p.baseUrl);
      if (!ready) {
        console.warn(`[gpu-orchestrator] ${name} did NOT warm up in time`);
        continue;
      }
      if (providerHasEmbedModel(p)) embedRecovered = true;
    } catch (err) {
      console.error(`[gpu-orchestrator] failed to bring up ${name}: ${err.message}`);
    }
  }
  startIdleRevertTimer();
  if (embedRecovered) {
    triggerEmbedBackfill(); // fire-and-forget — don't block gateway startup
  }
}
