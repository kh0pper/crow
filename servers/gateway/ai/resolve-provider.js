/**
 * Thin async wrapper around resolve-profile.js for backward compat.
 *
 * Historically this file was a sync, models.json-only resolver. The LLM
 * consolidation makes it async + DB-first (so cloud providers that only
 * live in the `providers` table — e.g. the ones the migration creates
 * from ai_profiles — can be pointed at by vision-profiles and
 * meta-glasses). Callers must `await` the resolver.
 *
 * Prefer `resolveProviderConfig` from resolve-profile.js in new code.
 */

import {
  resolveProviderConfig as _resolveProviderConfig,
} from "./resolve-profile.js";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createDbClient } from "../../db.js";

const MODELS_JSON_URL = new URL("../../../models.json", import.meta.url);
const MODELS_JSON_PATH = fileURLToPath(MODELS_JSON_URL);

let _cache = { mtimeMs: 0, data: null };
function loadModelsJson() {
  let st;
  try { st = statSync(MODELS_JSON_PATH); }
  catch { return { providers: {} }; }
  if (_cache.data && _cache.mtimeMs === st.mtimeMs) return _cache.data;
  const raw = readFileSync(MODELS_JSON_PATH, "utf8");
  const data = JSON.parse(raw);
  _cache = { mtimeMs: st.mtimeMs, data };
  return data;
}

/**
 * Resolve (provider_id, model_id) → adapter config. Async + DB-first.
 * If `db` is omitted, a fresh libsql client is opened — convenient for
 * existing callers but pass an explicit client if you already have one.
 *
 * @param {string} providerId
 * @param {string} [modelId]
 * @param {object} [db]  optional libsql client
 * @returns {Promise<{ baseUrl, apiKey, model, provider_id }>}
 */
export async function resolveProvider(providerId, modelId, db) {
  const client = db || createDbClient();
  return _resolveProviderConfig(client, providerId, modelId);
}

/**
 * List provider+model IDs for UI dropdowns (models.json view).
 * Stays sync — consumers that need the DB-augmented list use listProvidersAll
 * from providers-db.js directly.
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
 * Orchestrator-default fallback. Honors CROW_ORCHESTRATOR_PROVIDER and
 * CROW_ORCHESTRATOR_MODEL. Stays sync (models.json-only) because the
 * orchestrator's hot path can't easily tolerate a DB round-trip here.
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
