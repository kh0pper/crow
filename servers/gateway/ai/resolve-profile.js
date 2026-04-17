/**
 * DB-first profile/provider resolver.
 *
 * When a profile stores `{ provider_id, model_id }` instead of raw
 * `{ baseUrl, apiKey, model }`, this helper pulls current values from the
 * providers DB table (primary source of truth) and falls back to models.json
 * (for providers that haven't been migrated to the DB yet, or for tests).
 *
 * This supersedes the older `resolve-provider.js`, which is models.json-only
 * and therefore cannot resolve DB-only cloud providers. `resolve-provider.js`
 * is kept as a thin backwards-compat wrapper during the phased rollout.
 */

import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MODELS_JSON_URL = new URL("../../../models.json", import.meta.url);
const MODELS_JSON_PATH = fileURLToPath(MODELS_JSON_URL);

let _cache = { mtimeMs: 0, data: null };

function loadModelsJson() {
  let st;
  try { st = statSync(MODELS_JSON_PATH); }
  catch { return { providers: {} }; }
  if (_cache.data && _cache.mtimeMs === st.mtimeMs) return _cache.data;
  try {
    const raw = readFileSync(MODELS_JSON_PATH, "utf8");
    const data = JSON.parse(raw);
    _cache = { mtimeMs: st.mtimeMs, data };
    return data;
  } catch { return { providers: {} }; }
}

function firstModelId(models) {
  if (!Array.isArray(models)) return null;
  const m = models[0];
  if (!m) return null;
  return typeof m === "string" ? m : m.id || null;
}

async function resolveFromDb(db, providerId, modelId) {
  if (!db) return null;
  let rows;
  try {
    ({ rows } = await db.execute({
      sql: "SELECT * FROM providers WHERE id = ? AND disabled = 0",
      args: [providerId],
    }));
  } catch { return null; }
  if (!rows?.length) return null;
  const r = rows[0];
  let models = [];
  try { models = JSON.parse(r.models || "[]"); } catch {}

  let pickedModel = modelId;
  if (!pickedModel) pickedModel = firstModelId(models);
  else if (models.length && !models.some((m) => (typeof m === "string" ? m : m.id) === modelId)) {
    // Listed models don't include the requested one — still honor the request
    // (the model list in models.json is often just warm-starts, not exhaustive).
    pickedModel = modelId;
  }

  return {
    baseUrl: r.base_url,
    apiKey: r.api_key || "none",
    model: pickedModel,
    provider_id: providerId,
    provider_type: r.provider_type || null,
    host: r.host || "local",
  };
}

function resolveFromModelsJson(providerId, modelId) {
  const cfg = loadModelsJson();
  const provider = cfg?.providers?.[providerId];
  if (!provider) return null;
  let pickedModel = modelId;
  if (!pickedModel) pickedModel = firstModelId(provider.models);
  return {
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey || "none",
    model: pickedModel,
    provider_id: providerId,
    provider_type: null,
    host: provider.host || "local",
  };
}

/**
 * Resolve a (provider_id, model_id) pair to an adapter-ready config.
 * DB-first; falls back to models.json. Throws when neither has the provider.
 *
 * @param {object} db            libsql client (optional; null ⇒ models.json-only)
 * @param {string} providerId
 * @param {string} [modelId]     if omitted, uses the provider's first model
 * @returns {Promise<{ baseUrl, apiKey, model, provider_id, provider_type, host }>}
 */
export async function resolveProviderConfig(db, providerId, modelId) {
  if (!providerId) throw new Error("providerId required");
  const fromDb = await resolveFromDb(db, providerId, modelId);
  if (fromDb) return fromDb;
  const fromJson = resolveFromModelsJson(providerId, modelId);
  if (fromJson) return fromJson;
  throw new Error(`provider "${providerId}" not found in DB or models.json`);
}

/**
 * Resolve a profile's pointer (or direct) fields to an adapter-ready config.
 * Profiles may store `{ provider_id, model_id }` (pointer) OR legacy direct
 * fields `{ provider, baseUrl, apiKey, defaultModel }`.
 *
 * @param {object} profile
 * @param {object} db
 * @returns {Promise<{ baseUrl, apiKey, model, provider_id?, adapter? }>}
 */
export async function resolveProfileToConfig(profile, db) {
  if (profile?.provider_id) {
    return resolveProviderConfig(db, profile.provider_id, profile.model_id || profile.defaultModel);
  }
  // Legacy direct-mode: the profile carries its own apiKey/baseUrl/model.
  return {
    baseUrl: profile?.baseUrl || "",
    apiKey: profile?.apiKey || "none",
    model: profile?.defaultModel || profile?.model || "",
    provider_id: null,
    provider_type: profile?.provider || null,
    host: "local",
  };
}
