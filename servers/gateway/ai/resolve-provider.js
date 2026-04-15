/**
 * Resolve AI / vision profile pointers against the local models.json registry.
 *
 * When a profile stores `{ provider_id, model_id }` instead of raw
 * `{ baseUrl, apiKey, model }`, this helper pulls the current values from
 * models.json so profiles stay in sync with orchestrator config without
 * manual edits.
 *
 * Cached by mtime. If the user edits models.json, the next call reloads.
 */

import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const MODELS_JSON_URL = new URL("../../../models.json", import.meta.url);
const MODELS_JSON_PATH = fileURLToPath(MODELS_JSON_URL);

let _cache = { mtimeMs: 0, data: null };

function loadModelsJson() {
  let st;
  try { st = statSync(MODELS_JSON_PATH); }
  catch (err) { throw new Error(`models.json not found at ${MODELS_JSON_PATH}: ${err.message}`); }
  if (_cache.data && _cache.mtimeMs === st.mtimeMs) return _cache.data;
  const raw = readFileSync(MODELS_JSON_PATH, "utf8");
  const data = JSON.parse(raw);
  _cache = { mtimeMs: st.mtimeMs, data };
  return data;
}

/**
 * Resolve (provider_id, model_id) to a provider config.
 * @param {string} providerId
 * @param {string} [modelId] — if omitted, first model in provider's models[] is used
 * @returns {{ baseUrl: string, apiKey: string, model: string, provider_id: string }}
 */
export function resolveProvider(providerId, modelId) {
  const cfg = loadModelsJson();
  const provider = cfg?.providers?.[providerId];
  if (!provider) throw new Error(`models.json: provider "${providerId}" not found`);
  let modelEntry;
  if (modelId) {
    modelEntry = (provider.models || []).find(m => m.id === modelId);
    if (!modelEntry) throw new Error(`models.json: model "${modelId}" not in provider "${providerId}"`);
  } else {
    modelEntry = (provider.models || [])[0];
    if (!modelEntry) throw new Error(`models.json: provider "${providerId}" has no models`);
  }
  return {
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey || "none",
    model: modelEntry.id,
    provider_id: providerId,
  };
}

/**
 * List provider+model IDs for UI dropdowns.
 */
export function listProviders() {
  const cfg = loadModelsJson();
  const out = [];
  for (const [id, p] of Object.entries(cfg?.providers || {})) {
    out.push({
      id,
      baseUrl: p.baseUrl,
      models: (p.models || []).map(m => ({ id: m.id, warm: !!m.warm, onDemand: !!m.onDemand })),
    });
  }
  return out;
}

/**
 * Orchestrator-default fallback. Honors CROW_ORCHESTRATOR_PROVIDER and, when
 * the resolved provider matches that env var, CROW_ORCHESTRATOR_MODEL.
 * Otherwise picks the provider's first warm model (or first listed).
 * @returns {{ baseUrl: string, apiKey: string, model: string, provider_id: string }}
 */
export function resolveOrchestratorDefault() {
  const cfg = loadModelsJson();
  const providers = cfg?.providers || {};
  const envProvider = process.env.CROW_ORCHESTRATOR_PROVIDER;
  const providerId = envProvider && providers[envProvider]
    ? envProvider
    : Object.keys(providers)[0];
  if (!providerId) throw new Error("models.json has no providers");
  const provider = providers[providerId];
  let modelId;
  if (providerId === envProvider && process.env.CROW_ORCHESTRATOR_MODEL) {
    const m = (provider.models || []).find(m => m.id === process.env.CROW_ORCHESTRATOR_MODEL);
    if (m) modelId = m.id;
  }
  if (!modelId) {
    const warm = (provider.models || []).find(m => m.warm);
    modelId = (warm || provider.models?.[0])?.id;
  }
  if (!modelId) throw new Error(`models.json: provider "${providerId}" has no models`);
  return {
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey || "none",
    model: modelId,
    provider_id: providerId,
  };
}
