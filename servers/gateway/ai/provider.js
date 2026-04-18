/**
 * AI Provider Registry & Factory
 *
 * Selects and configures the appropriate provider adapter based on
 * AI_PROVIDER env var. Hot-reloads config from .env on each call
 * (with 5-second cache to avoid excessive file reads).
 *
 * Supported providers:
 *   - openai     — OpenAI, OpenRouter, any OpenAI-compatible API
 *   - anthropic  — Anthropic Messages API
 *   - google     — Google Gemini API
 *   - ollama     — Ollama native /api/chat endpoint
 *   - meta       — Meta Llama API (OpenAI-compatible)
 */

import { readEnvFile, resolveEnvPath } from "../env-manager.js";
import { resolveProviderConfig } from "./resolve-profile.js";

// Lazy-loaded adapter modules
const ADAPTER_LOADERS = {
  openai: () => import("./adapters/openai.js"),
  anthropic: () => import("./adapters/anthropic.js"),
  google: () => import("./adapters/google.js"),
  ollama: () => import("./adapters/ollama.js"),
};

/** Provider display names and default models */
export const PROVIDER_INFO = {
  openai: { name: "OpenAI", defaultModel: "gpt-4o", requiresKey: true },
  anthropic: { name: "Anthropic", defaultModel: "claude-sonnet-4-20250514", requiresKey: true },
  google: { name: "Google Gemini", defaultModel: "gemini-2.5-flash", requiresKey: true },
  ollama: { name: "Ollama", defaultModel: "llama3.1", requiresKey: false },
};

/**
 * Collapse any provider-ish label (AI_PROVIDER env, profile.provider,
 * providers.provider_type column) into the canonical adapter loader key.
 * Handles the openrouter / meta / openai-compat → openai aliases in one
 * place so call sites don't drift.
 *
 * Returns null for unknown/missing labels — caller decides whether to
 * throw (adapter creation) or fall back (local-bundle inference).
 *
 * @param {string|null|undefined} label
 * @returns {"openai"|"anthropic"|"google"|"ollama"|null}
 */
export function resolveAdapterKey(label) {
  if (!label) return null;
  const lower = String(label).toLowerCase().trim();
  if (lower === "openrouter" || lower === "meta" || lower === "openai-compat") return "openai";
  if (ADAPTER_LOADERS[lower]) return lower;
  return null;
}

// Config cache (5-second TTL)
let _cachedConfig = null;
let _cacheTimestamp = 0;
const CACHE_TTL_MS = 5000;

/**
 * Read AI provider config from .env file (hot-reload with cache).
 * Returns { provider, apiKey, model, baseUrl } or null if not configured.
 */
export function getProviderConfig() {
  const now = Date.now();
  if (_cachedConfig && (now - _cacheTimestamp) < CACHE_TTL_MS) {
    return _cachedConfig;
  }

  const envPath = resolveEnvPath();
  const { vars } = readEnvFile(envPath);

  const provider = (vars.get("AI_PROVIDER")?.value || "").toLowerCase().trim();
  if (!provider) {
    _cachedConfig = null;
    _cacheTimestamp = now;
    return null;
  }

  _cachedConfig = {
    provider,
    apiKey: vars.get("AI_API_KEY")?.value || "",
    model: vars.get("AI_MODEL")?.value || "",
    baseUrl: vars.get("AI_BASE_URL")?.value || "",
  };
  _cacheTimestamp = now;
  return _cachedConfig;
}

/**
 * Invalidate the config cache (call after .env changes).
 */
export function invalidateConfigCache() {
  _cachedConfig = null;
  _cacheTimestamp = 0;
}

/**
 * Create a provider adapter instance from current config.
 * Returns { adapter, config } or throws if not configured.
 */
export async function createProviderAdapter() {
  const config = getProviderConfig();
  if (!config) {
    throw Object.assign(
      new Error("No AI provider configured. Set AI_PROVIDER in Settings or .env."),
      { code: "not_configured" }
    );
  }

  const { provider, apiKey, model, baseUrl } = config;

  const adapterKey = resolveAdapterKey(provider);
  const loader = adapterKey ? ADAPTER_LOADERS[adapterKey] : null;
  if (!loader) {
    throw Object.assign(
      new Error(`Unknown AI provider: "${provider}". Supported: ${Object.keys(PROVIDER_INFO).join(", ")}`),
      { code: "invalid_provider" }
    );
  }

  // Validate API key requirement
  const info = PROVIDER_INFO[adapterKey];
  if (info?.requiresKey && !apiKey) {
    throw Object.assign(
      new Error(`${info.name} requires an API key. Set AI_API_KEY in Settings or .env.`),
      { code: "missing_key" }
    );
  }

  const adapterModule = await loader();
  const createAdapter = adapterModule.default;

  const adapterConfig = {
    apiKey,
    model: model || info?.defaultModel || "",
    baseUrl: baseUrl || undefined,
  };

  // OpenRouter uses OpenAI adapter with different base URL
  if (provider === "openrouter" && !baseUrl) {
    adapterConfig.baseUrl = "https://openrouter.ai/api/v1";
  }
  if (provider === "meta" && !baseUrl) {
    adapterConfig.baseUrl = "https://api.llama.com/compat/v1/";
  }

  const adapter = createAdapter(adapterConfig);
  return { adapter, config };
}

/**
 * Read AI profiles from dashboard_settings.
 * Returns array of profiles. Use includeKeys: true only for adapter creation.
 */
export async function getAiProfiles(db, { includeKeys = false } = {}) {
  const result = await db.execute({
    sql: "SELECT value FROM dashboard_settings WHERE key = 'ai_profiles'",
    args: [],
  });
  if (!result.rows[0]?.value) return [];
  try {
    const profiles = JSON.parse(result.rows[0].value);
    if (!includeKeys) {
      return profiles.map(({ apiKey, ...rest }) => rest);
    }
    return profiles;
  } catch { return []; }
}

/**
 * Create a provider adapter from a profile config (bypasses .env).
 * Returns { adapter, config } — same shape as createProviderAdapter().
 *
 * Pointer-mode profiles (those with `provider_id` set) resolve via the
 * DB-first resolver when `db` is supplied. Legacy direct-mode profiles
 * use the profile's embedded apiKey/baseUrl/provider fields. After the
 * llm-settings migration strips direct fields from migrated profiles,
 * callers MUST pass `db` to reach their credentials.
 */
export async function createAdapterFromProfile(profile, model, db = null) {
  let providerLabel = profile.provider;
  let apiKey = profile.apiKey;
  let baseUrl = profile.baseUrl;
  let resolvedModel = model || profile.model_id || profile.defaultModel || "";

  if (profile.provider_id && db) {
    const cfg = await resolveProviderConfig(db, profile.provider_id, resolvedModel || null);
    providerLabel = cfg.provider_type || providerLabel || "openai";
    // "none" is the bundle-registered sentinel for local OpenAI-compatible
    // endpoints (vLLM / llama.cpp) that ignore the Bearer token. Pass it
    // through as a truthy value so the requiresKey check doesn't trip.
    apiKey = cfg.apiKey || "none";
    baseUrl = cfg.baseUrl;
    resolvedModel = cfg.model || resolvedModel;
  }

  const adapterKey = resolveAdapterKey(providerLabel);
  const loader = adapterKey ? ADAPTER_LOADERS[adapterKey] : null;
  if (!loader) {
    throw Object.assign(new Error(`Unknown provider: ${providerLabel || "(missing)"}`), { code: "invalid_provider" });
  }

  const info = PROVIDER_INFO[adapterKey];
  if (info?.requiresKey && !apiKey) {
    throw Object.assign(new Error("API key required"), { code: "missing_key" });
  }

  const mod = await loader();
  resolvedModel = resolvedModel || info?.defaultModel || "";
  const adapterConfig = {
    apiKey,
    model: resolvedModel,
    baseUrl: baseUrl || undefined,
  };
  // OpenRouter / Meta default base URLs (mirrors createProviderAdapter logic)
  if (providerLabel === "openrouter" && !baseUrl) {
    adapterConfig.baseUrl = "https://openrouter.ai/api/v1";
  }
  if (providerLabel === "meta" && !baseUrl) {
    adapterConfig.baseUrl = "https://api.llama.com/compat/v1/";
  }

  const adapter = mod.default(adapterConfig);
  return { adapter, config: { provider: providerLabel, model: resolvedModel, baseUrl } };
}

/**
 * Test a specific AI profile by sending a minimal request.
 * Pass `db` so pointer-mode profiles can resolve via the providers DB.
 */
export async function testProfileConnection(profile, db = null) {
  try {
    const { adapter } = await createAdapterFromProfile(profile, profile.defaultModel, db);
    const messages = [{ role: "user", content: "Say 'ok'" }];
    let gotContent = false;
    for await (const event of adapter.chatStream(messages, [], { maxTokens: 10, temperature: 0 })) {
      if (event.type === "content_delta") gotContent = true;
      if (event.type === "done") break;
    }
    return { ok: true, provider: adapter.name, gotContent };
  } catch (err) {
    return { ok: false, error: err.message, code: err.code || "unknown" };
  }
}

/**
 * List available providers with their configuration status.
 */
export function listProviders() {
  const config = getProviderConfig();
  const currentProvider = config?.provider || null;

  return Object.entries(PROVIDER_INFO).map(([id, info]) => ({
    id,
    name: info.name,
    defaultModel: info.defaultModel,
    requiresKey: info.requiresKey,
    configured: currentProvider === id,
  }));
}

/**
 * Get an embedding vector for a text string.
 * Returns Float32Array or null if no embedding provider is available.
 * Supported: OpenAI (text-embedding-3-small), Ollama, Google.
 */
export async function getEmbedding(text) {
  const config = getProviderConfig();
  if (!config) return null;

  const { provider, apiKey, baseUrl } = config;

  try {
    if (provider === "openai" || provider === "openrouter") {
      const url = baseUrl || "https://api.openai.com/v1";
      const res = await fetch(`${url}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "text-embedding-3-small",
          input: text,
        }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      return new Float32Array(data.data?.[0]?.embedding || []);
    }

    if (provider === "ollama") {
      const url = baseUrl || "http://localhost:11434";
      const res = await fetch(`${url}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "nomic-embed-text",
          input: text,
        }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      return new Float32Array(data.embeddings?.[0] || []);
    }

    if (provider === "google") {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: { parts: [{ text }] },
          }),
        }
      );
      if (!res.ok) return null;
      const data = await res.json();
      return new Float32Array(data.embedding?.values || []);
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Test provider connection by sending a minimal request.
 */
export async function testProviderConnection(providerOverride) {
  const config = getProviderConfig();
  if (!config && !providerOverride) {
    return { ok: false, error: "No AI provider configured" };
  }

  try {
    const { adapter } = await createProviderAdapter();

    // Send a minimal test message
    const messages = [{ role: "user", content: "Say 'ok'" }];
    let gotContent = false;

    for await (const event of adapter.chatStream(messages, [], {
      maxTokens: 10,
      temperature: 0,
    })) {
      if (event.type === "content_delta") gotContent = true;
      if (event.type === "done") break;
    }

    return { ok: true, provider: adapter.name, gotContent };
  } catch (err) {
    return {
      ok: false,
      error: err.message,
      code: err.code || "unknown",
    };
  }
}
