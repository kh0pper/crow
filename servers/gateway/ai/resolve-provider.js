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
import { createDbClient } from "../../db.js";
import { loadProviders as loadCachedProviders } from "../../shared/providers.js";

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

export function listProviders() {
  const cfg = loadCachedProviders();
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

export function resolveOrchestratorDefault() {
  const cfg = loadCachedProviders();
  const providers = cfg?.providers || {};
  const envProvider = process.env.CROW_ORCHESTRATOR_PROVIDER;
  const providerId = envProvider && providers[envProvider]
    ? envProvider
    : Object.keys(providers)[0];
  if (!providerId) throw new Error("provider registry has no providers");
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
  if (!modelId) throw new Error(`provider registry: provider "${providerId}" has no models`);
  return {
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey || "none",
    model: modelId,
    provider_id: providerId,
  };
}
