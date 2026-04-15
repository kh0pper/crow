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

let _swapInFlight = Promise.resolve();
let _initialized = false;

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

function getMutexSiblings(name) {
  const p = getProvider(name);
  if (!p?.mutexGroup) return [];
  const cfg = loadProviders();
  return Object.entries(cfg.providers || {})
    .filter(([n, v]) => n !== name && v.mutexGroup === p.mutexGroup)
    .map(([n]) => n);
}

function alwaysResidentProviders() {
  const cfg = loadProviders();
  return Object.entries(cfg.providers || {})
    .filter(([, v]) => v.alwaysResident === true)
    .map(([n]) => n);
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
    if (await probeReady(p.baseUrl)) return true;

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
      }
    }

    // Start target.
    console.log(`[gpu-orchestrator] starting ${providerName} (bundleId=${p.bundleId})`);
    await bundleUp(p.bundleId);
    const ready = await waitForReady(p.baseUrl);
    if (ready) console.log(`[gpu-orchestrator] ${providerName} ready`);
    else console.warn(`[gpu-orchestrator] ${providerName} did NOT become ready within ${READINESS_TIMEOUT_MS}ms`);
    return ready;
  });

  // Replace the in-flight promise so the next acquire queues behind this.
  _swapInFlight = swap.catch(() => {});
  return swap;
}

/**
 * Startup — ensure all alwaysResident providers are up.
 * Non-fatal: logs and continues on error. Call from gateway init.
 */
export async function initOrchestrator() {
  if (_initialized) return;
  _initialized = true;
  const residents = alwaysResidentProviders();
  if (residents.length === 0) {
    console.log("[gpu-orchestrator] no alwaysResident providers declared");
    return;
  }
  console.log(`[gpu-orchestrator] ensuring alwaysResident: ${residents.join(", ")}`);
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
      if (!ready) console.warn(`[gpu-orchestrator] ${name} did NOT warm up in time`);
    } catch (err) {
      console.error(`[gpu-orchestrator] failed to bring up ${name}: ${err.message}`);
    }
  }
}
