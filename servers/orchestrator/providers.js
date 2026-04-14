/**
 * Provider registry loader + health matrix.
 *
 * Loads `models.json` from the same search paths as server.js and exposes:
 *   - loadProviders()             — returns the parsed providers map
 *   - probeProvider(name, cfg)    — liveness probe (GET /v1/models with timeout)
 *   - healthMatrix()              — probes all providers in parallel, returns a matrix
 *
 * Also exports an Express handler `providersHealthHandler` for mounting at
 * /api/providers/health. The handler is meant to sit behind dashboard auth.
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const SEARCH_PATHS = [
  resolve(__dirname, "../../models.json"),
  resolve(__dirname, "../../bundles/crowclaw/config/agents/main/models.json"),
  resolve(__dirname, "../../config/models.json"),
];

/**
 * Load models.json from the first path that exists.
 * @returns {{providers: Record<string, object>, $schemaVersion?: string}}
 */
export function loadProviders() {
  for (const p of SEARCH_PATHS) {
    try {
      const raw = readFileSync(p, "utf-8");
      const cfg = JSON.parse(raw);
      return { ...cfg, _source: p };
    } catch {
      // try next
    }
  }
  return { providers: {}, _source: null };
}

/**
 * Probe a single provider's /v1/models endpoint.
 * Returns { ok, status, latencyMs, models?, error? }.
 */
export async function probeProvider(name, cfg, { timeoutMs = 3000 } = {}) {
  const started = Date.now();
  const out = { name, baseUrl: cfg.baseUrl, host: cfg.host || "local" };

  if (!cfg.baseUrl) {
    return { ...out, ok: false, error: "no baseUrl" };
  }

  // Construct /v1/models URL from the provider's baseUrl
  // baseUrl is expected to be ".../v1" — append "/models"
  const url = cfg.baseUrl.replace(/\/+$/, "") + "/models";

  try {
    const headers = {};
    if (cfg.apiKey && cfg.apiKey !== "none") {
      headers.Authorization = `Bearer ${cfg.apiKey}`;
    }
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      return { ...out, ok: false, status: res.status, latencyMs, error: `http ${res.status}` };
    }
    let models = [];
    try {
      const body = await res.json();
      if (Array.isArray(body?.data)) {
        models = body.data.map((m) => m.id).filter(Boolean);
      }
    } catch {
      // Non-JSON response is still "ok" for liveness
    }
    return { ...out, ok: true, status: res.status, latencyMs, models };
  } catch (err) {
    const latencyMs = Date.now() - started;
    return {
      ...out,
      ok: false,
      latencyMs,
      error: err.name === "TimeoutError" ? "timeout" : String(err.message || err),
    };
  }
}

/**
 * Probe all providers in parallel.
 * @returns {Promise<{providers: Record<string, object>, summary: {total, ok, failed}, source: string|null}>}
 */
export async function healthMatrix({ timeoutMs = 3000 } = {}) {
  const cfg = loadProviders();
  const providers = cfg.providers || {};
  const names = Object.keys(providers);
  const results = await Promise.all(
    names.map((name) => probeProvider(name, providers[name], { timeoutMs }))
  );
  const map = {};
  let ok = 0;
  for (const r of results) {
    map[r.name] = r;
    if (r.ok) ok += 1;
  }
  return {
    source: cfg._source,
    summary: { total: names.length, ok, failed: names.length - ok },
    providers: map,
  };
}

/**
 * Express handler for GET /api/providers/health.
 * Honors ?timeout=<ms> query param (capped at 10000).
 */
export async function providersHealthHandler(req, res) {
  const q = Number(req.query?.timeout);
  const timeoutMs = Number.isFinite(q) ? Math.min(Math.max(q, 500), 10000) : 3000;
  try {
    const matrix = await healthMatrix({ timeoutMs });
    res.json(matrix);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
}
