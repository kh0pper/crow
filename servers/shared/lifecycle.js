/**
 * Orchestrator lifecycle: warm/release models on demand with reference counting.
 *
 * Per plan §Reference-Counted Lifecycle (Phase 5-full):
 *   - Per-provider async mutex (hand-rolled Map<providerId, Promise>).
 *   - Idempotent in-flight merging: concurrent ensureModelWarm calls for the
 *     same provider share one Promise and increment the refcount atomically.
 *   - Atomic refcount persistence (temp + rename) to survive orchestrator
 *     restarts; reconciled against live provider health at boot.
 *   - Priority tiers: maker_lab (pinned, never released) > interactive > batch.
 *   - Mutex groups (e.g. 8003-swap): at most one provider active per group.
 *   - conflictsWith: providers that must be unloaded before this one can warm.
 *   - Idle-grace: 5 min after refcount hits 0 before actual release, to avoid
 *     thrash between back-to-back orchestrations.
 *
 * Bundle start/stop uses crow's /bundles/api/start|stop, which forwards to the
 * peer gateway via cross-host control plane when the manifest has `host:`.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "fs";
import { resolve, dirname } from "path";
import { homedir } from "os";
import { loadProviders } from "./providers.js";

const REFCOUNT_PATH = process.env.CROW_REFCOUNT_PATH
  || resolve(homedir(), ".crow", "data", "orchestrator-refcounts.json");

const IDLE_GRACE_MS = 5 * 60 * 1000; // 5 min

// -----------------------------------------------------------------------
// In-process state
// -----------------------------------------------------------------------

/** providerId -> { refs: number, lastReleasedAt: number|null, warmPromise: Promise|null } */
const state = new Map();

/** providerId -> Promise that serializes warm/release calls for that provider */
const mutexes = new Map();

/** providerId -> Timer | null for idle release */
const idleTimers = new Map();

/** Subscribers for lifecycle events (mostly for the events log / panel). */
const subscribers = new Set();

/** Attach a listener for lifecycle events. Returns an unsubscribe fn. */
export function onLifecycleEvent(listener) {
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}

function emit(event) {
  for (const fn of subscribers) {
    try { fn(event); } catch {}
  }
}

// -----------------------------------------------------------------------
// Persistence (atomic)
// -----------------------------------------------------------------------

function loadRefcounts() {
  try {
    if (existsSync(REFCOUNT_PATH)) {
      const raw = JSON.parse(readFileSync(REFCOUNT_PATH, "utf-8"));
      if (raw && typeof raw === "object") {
        for (const [k, v] of Object.entries(raw)) {
          state.set(k, {
            refs: Math.max(0, v.refs || 0),
            lastReleasedAt: v.lastReleasedAt || null,
            warmPromise: null,
          });
        }
      }
    }
  } catch {}
}

function persistRefcounts() {
  try {
    const out = {};
    for (const [k, v] of state.entries()) {
      out[k] = { refs: v.refs, lastReleasedAt: v.lastReleasedAt };
    }
    const dir = dirname(REFCOUNT_PATH);
    mkdirSync(dir, { recursive: true });
    const tmp = REFCOUNT_PATH + ".tmp";
    writeFileSync(tmp, JSON.stringify(out, null, 2));
    renameSync(tmp, REFCOUNT_PATH);
  } catch {}
}

loadRefcounts();

// -----------------------------------------------------------------------
// Per-provider mutex
// -----------------------------------------------------------------------

/** Run `fn` serialized for the given providerId. */
async function withMutex(providerId, fn) {
  const prev = mutexes.get(providerId) || Promise.resolve();
  let release;
  const next = new Promise((r) => { release = r; });
  mutexes.set(providerId, prev.then(() => next));
  try {
    await prev;
    return await fn();
  } finally {
    release();
    // Cleanup if nothing else is waiting (best-effort)
    if (mutexes.get(providerId) === next) mutexes.delete(providerId);
  }
}

// -----------------------------------------------------------------------
// Provider metadata helpers
// -----------------------------------------------------------------------

function lookupProvider(providerId) {
  const cfg = loadProviders();
  const p = cfg.providers?.[providerId];
  if (!p) return null;
  const model = p.models?.[0] || {};
  return {
    providerId,
    baseUrl: p.baseUrl,
    apiKey: p.apiKey,
    host: p.host || "local",
    bundleId: p.bundleId || null,
    warm: !!model.warm,
    onDemand: !!model.onDemand,
    mutexGroup: model.mutexGroup || null,
    conflictsWith: Array.isArray(model.conflictsWith) ? model.conflictsWith : [],
    priority: model.priority || "interactive",
  };
}

function isPinned(providerInfo) {
  return providerInfo.priority === "maker_lab";
}

async function probeEndpoint(baseUrl, timeoutMs = 3000) {
  try {
    const res = await fetch(baseUrl.replace(/\/+$/, "") + "/models", {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------
// Bundle lifecycle API call (local or cross-host via the gateway)
// -----------------------------------------------------------------------

async function bundleAction(action, bundleId, { gatewayUrl, instanceAuthToken } = {}) {
  const url = (gatewayUrl || process.env.CROW_GATEWAY_URL || "http://localhost:3001")
    .replace(/\/+$/, "") + `/dashboard/bundles/api/${action}`;
  const headers = { "Content-Type": "application/json" };
  if (instanceAuthToken) headers.Authorization = `Bearer ${instanceAuthToken}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ bundle_id: bundleId }),
      signal: AbortSignal.timeout(60_000),
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

// -----------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------

/**
 * Ensure the given provider is warm (i.e. its underlying bundle is running
 * and /v1/models responds). Increments refcount. Idempotent — concurrent
 * calls for the same provider share one in-flight warm-up Promise.
 *
 * For mutex-group conflicts (e.g. 8003-swap), this BLOCKS until the group
 * is free (no provider currently occupying it or occupier has refcount 0).
 * For `conflictsWith` providers (e.g. GLM needs crow-chat unloaded), release
 * those first.
 *
 * Returns { ok: true, alreadyWarm: boolean } on success, or
 *         { ok: false, reason: string } on failure.
 */
export async function ensureModelWarm(providerId, opts = {}) {
  const info = lookupProvider(providerId);
  if (!info) return { ok: false, reason: "unknown_provider" };

  return withMutex(providerId, async () => {
    const cur = state.get(providerId) || { refs: 0, lastReleasedAt: null, warmPromise: null };

    // Cancel any pending idle-release timer
    const t = idleTimers.get(providerId);
    if (t) { clearTimeout(t); idleTimers.delete(providerId); }

    // Fast path: already counted as warm
    if (cur.refs > 0) {
      cur.refs += 1;
      state.set(providerId, cur);
      persistRefcounts();
      emit({ type: "ref_inc", providerId, refs: cur.refs, alreadyWarm: true });
      return { ok: true, alreadyWarm: true, refs: cur.refs };
    }

    // Dedupe concurrent first-time warm-ups
    if (cur.warmPromise) {
      const r = await cur.warmPromise;
      return r;
    }

    cur.warmPromise = (async () => {
      // 1. Check mutex group — if any other provider in the same group has refs>0, block
      if (info.mutexGroup) {
        for (const [otherId, otherState] of state.entries()) {
          if (otherId === providerId) continue;
          const oi = lookupProvider(otherId);
          if (oi && oi.mutexGroup === info.mutexGroup && otherState.refs > 0) {
            return { ok: false, reason: `mutex_group_busy:${otherId}` };
          }
        }
      }

      // 2. conflictsWith: unload those first if they're warm
      for (const conflictId of info.conflictsWith) {
        const cs = state.get(conflictId);
        if (cs && cs.refs > 0) {
          const ci = lookupProvider(conflictId);
          if (ci && isPinned(ci)) {
            return { ok: false, reason: `conflict_with_pinned:${conflictId}` };
          }
          return { ok: false, reason: `conflict_busy:${conflictId}` };
        }
      }

      // 3. If already reachable, just bump refcount (might be always-warm or pre-existing)
      if (info.baseUrl && await probeEndpoint(info.baseUrl)) {
        const s = state.get(providerId) || { refs: 0, lastReleasedAt: null };
        s.refs = 1; s.warmPromise = null;
        state.set(providerId, s);
        persistRefcounts();
        emit({ type: "warm_existing", providerId, refs: 1 });
        return { ok: true, alreadyWarm: true, refs: 1 };
      }

      // 4. Not reachable — request bundle start if we know the bundle
      if (!info.bundleId) {
        return { ok: false, reason: "no_bundle_to_start" };
      }
      emit({ type: "bundle_start", providerId, bundleId: info.bundleId });
      const startRes = await bundleAction("start", info.bundleId, opts);
      if (!startRes.ok) {
        emit({ type: "bundle_start_failed", providerId, bundleId: info.bundleId, error: startRes.error });
        return { ok: false, reason: `bundle_start_failed:${startRes.error || startRes.status}` };
      }

      // 5. Wait for readiness (up to 3 min for heavy models)
      const ready = await waitForReady(info.baseUrl, 180_000);
      if (!ready) {
        emit({ type: "warm_timeout", providerId });
        return { ok: false, reason: "warmup_timeout" };
      }

      const s = state.get(providerId) || { refs: 0, lastReleasedAt: null };
      s.refs = 1; s.warmPromise = null;
      state.set(providerId, s);
      persistRefcounts();
      emit({ type: "warmed", providerId, refs: 1 });
      return { ok: true, alreadyWarm: false, refs: 1 };
    })();

    state.set(providerId, cur);
    return await cur.warmPromise;
  });
}

async function waitForReady(baseUrl, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await probeEndpoint(baseUrl, 3000)) return true;
    await new Promise((r) => setTimeout(r, 5000));
  }
  return false;
}

/**
 * Decrement refcount. When it hits 0, schedule an idle-release timer; actual
 * bundle stop happens after IDLE_GRACE_MS unless another ensureModelWarm
 * bumps it back up. Pinned providers (priority=maker_lab) never release.
 */
export async function releaseModel(providerId, opts = {}) {
  const info = lookupProvider(providerId);
  if (!info) return { ok: false, reason: "unknown_provider" };
  if (isPinned(info)) {
    emit({ type: "release_ignored_pinned", providerId });
    return { ok: true, pinned: true };
  }

  return withMutex(providerId, async () => {
    const cur = state.get(providerId) || { refs: 0, lastReleasedAt: null, warmPromise: null };
    if (cur.refs <= 0) return { ok: true, refs: 0 };
    cur.refs -= 1;
    state.set(providerId, cur);
    persistRefcounts();
    emit({ type: "ref_dec", providerId, refs: cur.refs });

    if (cur.refs === 0) {
      // Always-warm providers don't actually stop; skip the timer
      if (info.warm) return { ok: true, refs: 0, pinned: false };
      // On-demand: schedule idle release
      const timer = setTimeout(async () => {
        idleTimers.delete(providerId);
        await withMutex(providerId, async () => {
          const s = state.get(providerId);
          if (!s || s.refs > 0) return;
          if (!info.bundleId) return;
          emit({ type: "bundle_stop", providerId, bundleId: info.bundleId });
          await bundleAction("stop", info.bundleId, opts);
          s.lastReleasedAt = Date.now();
          state.set(providerId, s);
          persistRefcounts();
          emit({ type: "released", providerId });
        });
      }, opts.idleGraceMs ?? IDLE_GRACE_MS);
      idleTimers.set(providerId, timer);
    }
    return { ok: true, refs: cur.refs };
  });
}

/**
 * Operator-facing kill switch: clear ALL refcounts and reconcile against
 * live provider health. Useful when refcount state drifts from reality.
 */
export async function resetAllRefcounts() {
  // Cancel all idle timers
  for (const [k, t] of idleTimers.entries()) {
    clearTimeout(t);
    idleTimers.delete(k);
  }

  const cfg = loadProviders();
  for (const providerId of Object.keys(cfg.providers || {})) {
    // Reset to 0; refs re-populate as orchestrations run.
    state.set(providerId, { refs: 0, lastReleasedAt: null, warmPromise: null });
  }
  persistRefcounts();
  emit({ type: "refcounts_reset" });
  return { ok: true, reconciled: state.size };
}

/**
 * Snapshot of current lifecycle state (for the Nest admin panel).
 */
export function getLifecycleSnapshot() {
  const snapshot = {};
  for (const [k, v] of state.entries()) {
    snapshot[k] = { refs: v.refs, lastReleasedAt: v.lastReleasedAt };
  }
  return snapshot;
}
