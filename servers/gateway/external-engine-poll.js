/**
 * External-engine poll (spec docs/superpowers/specs/2026-09-23-external-engine-provider-design.md §2.3).
 *
 * Every CROW_EXTERNAL_ENGINE_POLL_MS (default 60 s; <= 0 disables), for every
 * ENABLED provider row marked gpu_policy.engine.managed === "external":
 * GET <base_url>/models — no auth header, 3 s timeout, 2xx = ready — and
 * record the result in provider-health.js's `external` map.
 *
 * READ-ONLY by construction: one GET per engine per tick, no retry within a
 * tick, and nothing ever reacts to the result (no start, no route-away).
 * pi-lab cleared it for any time, windows included (spec §2.6).
 *
 * PER INSTANCE: each instance probes from its own network position; a peer
 * the firewall keeps off the engine's LAN reports its own truth.
 *
 * Armed by initOrchestrator() right after the residency monitor. The scratch
 * test suite sets CROW_EXTERNAL_ENGINE_POLL_MS=0 (scripts/run-suite.mjs).
 */
import { loadProviders } from "../shared/providers.js";
import { isExternalEngine, externalEngineInfo } from "../shared/provider-engine.js";
import { recordExternal, pruneExternal } from "./provider-health.js";

export const EXTERNAL_ENGINE_PROBE_TIMEOUT_MS = 3_000;
export const DEFAULT_EXTERNAL_ENGINE_POLL_MS = 60_000;
/** The `_source` loadProvidersFromDb() sets. Anything else is the models.json
 *  fallback loadProviders() serves while its cache is null or the DB read
 *  fails — it carries no markers, so trusting it would prune every clock. */
export const DB_PROVIDERS_SOURCE = "db:providers";

let _timer = null;
let _inFlight = false;
let _failing = false; // edge-trigger for the poll's failure warn

/** Interval from env; unset/empty/non-numeric → the 60 s default. */
export function externalEnginePollMs(env = process.env) {
  const raw = env.CROW_EXTERNAL_ENGINE_POLL_MS;
  if (raw === undefined || raw === "") return DEFAULT_EXTERNAL_ENGINE_POLL_MS;
  const n = Number(raw);
  return Number.isFinite(n) ? n : DEFAULT_EXTERNAL_ENGINE_POLL_MS;
}

/** `<base_url>/models` for an http(s) base_url, else null (never fetched). */
export function externalModelsUrl(baseUrl) {
  let u;
  try { u = new URL(String(baseUrl)); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  return String(baseUrl).replace(/\/+$/, "") + "/models";
}

/**
 * One read-only probe. Never throws. The timeout is enforced by a race as
 * well as the abort signal, so a fetch that ignores the signal still cannot
 * hold the tick open past `timeoutMs`.
 */
export async function probeExternalEngine(baseUrl, {
  fetchImpl = globalThis.fetch,
  timeoutMs = EXTERNAL_ENGINE_PROBE_TIMEOUT_MS,
} = {}) {
  const url = externalModelsUrl(baseUrl);
  if (!url) return { ready: false, error: "unsupported base_url" };
  const ac = new AbortController();
  let timer = null;
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      reject(new Error(`timeout after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    // Deliberately NO headers: the engine has no auth (spec §3) and a row's
    // api_key must never be sent to a LAN box on a timer.
    const res = await Promise.race([fetchImpl(url, { method: "GET", signal: ac.signal }), timedOut]);
    // Fire-and-forget: releasing the body must never extend the tick past the race.
    try { res?.body?.cancel?.()?.catch?.(() => {}); } catch { /* the body is irrelevant */ }
    if (res && res.ok) return { ready: true, error: null };
    return { ready: false, error: `http ${res?.status ?? "?"}` };
  } catch (err) {
    return { ready: false, error: err?.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One tick. Returns the names probed. MUST NEVER THROW (the interval relies
 * on it). Probes AND prunes only when the config came from the DB
 * (review round 1, C1): after invalidateProvidersCache() or a DB error,
 * loadProviders() serves the models.json fallback — non-empty, no markers —
 * and pruning on it would wipe every ready-once clock. Such a tick is a no-op.
 */
export async function pollExternalEngines(opts = {}) {
  const probed = [];
  try {
    const cfg = opts.cfg !== undefined ? opts.cfg : loadProviders();
    if (cfg?._source !== DB_PROVIDERS_SOURCE) return probed;
    const fetchImpl = opts.fetchImpl || globalThis.fetch;
    const now = opts.now || Date.now;
    const timeoutMs = opts.timeoutMs ?? EXTERNAL_ENGINE_PROBE_TIMEOUT_MS;
    const providers = cfg.providers || {};
    // `!p.disabled` is belt-and-braces: loadProvidersFromDb's own query already
    // selects `disabled = 0`, so every row reaching `providers` here is already
    // enabled. Kept in case `cfg` is ever a test/injected fixture built by hand.
    const targets = Object.entries(providers).filter(([, p]) => p && !p.disabled && isExternalEngine(p));
    const results = await Promise.all(targets.map(async ([name, p]) => ({
      name, p, r: await probeExternalEngine(p.baseUrl, { fetchImpl, timeoutMs }),
    })));
    for (const { name, p, r } of results) {
      const info = externalEngineInfo(p);
      recordExternal(name, {
        ready: r.ready, nowMs: now(), baseUrl: p.baseUrl,
        engineHost: info.host, label: info.label, error: r.error,
      });
      probed.push(name);
    }
    pruneExternal(targets.map(([n]) => n)); // DB-sourced: an absent/disabled row really is gone
  } catch (err) {
    if (!_failing) {
      _failing = true;
      console.warn(`[external-engines] poll failed: ${err.message}`);
    }
    return probed;
  }
  _failing = false;
  return probed;
}

/**
 * Arm the poll: one tick now, then every `intervalMs`. Idempotent, in-flight
 * guarded, unref'd. Returns true when armed by THIS call.
 */
export function startExternalEngineMonitor({ intervalMs = externalEnginePollMs(), poll = pollExternalEngines } = {}) {
  if (_timer) return false;
  if (!(intervalMs > 0) || !Number.isFinite(intervalMs)) {
    console.log("[external-engines] read-only poll disabled (CROW_EXTERNAL_ENGINE_POLL_MS <= 0)");
    return false;
  }
  const tick = () => {
    if (_inFlight) return;
    _inFlight = true;
    Promise.resolve()
      .then(() => poll())
      .catch(() => {})
      .finally(() => { _inFlight = false; });
  };
  tick();
  _timer = setInterval(() => {
    try { tick(); } catch {}
  }, intervalMs);
  _timer.unref?.();
  console.log(`[external-engines] read-only poll armed: every ${intervalMs}ms`);
  return true;
}

/** Test hook — clear the interval so the suite never leaks it. */
export function _stopExternalEngineMonitor() {
  if (_timer) { clearInterval(_timer); _timer = null; }
  _inFlight = false;
  _failing = false;
}
