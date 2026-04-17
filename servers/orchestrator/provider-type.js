/**
 * Map a provider row's `provider_type` column to the ai-adapter key
 * (`servers/gateway/ai/adapters/*`).
 *
 * `provider_type` values live in the `providers` DB column and come from the
 * Add-cloud-provider form. Local-bundle rows leave the column NULL — callers
 * infer the adapter from `bundle_id` + models.json in that case.
 *
 * Alias collapse:
 *   openrouter → openai (OpenRouter speaks the OpenAI chat/completions API)
 *   openai-compat → openai (vLLM, LocalAI, llama.cpp, Meta, etc.)
 *   meta → openai (legacy alias; new rows should use openai-compat)
 */

const TYPE_TO_ADAPTER = {
  openai: "openai",
  openrouter: "openai",
  "openai-compat": "openai",
  meta: "openai",
  anthropic: "anthropic",
  google: "google",
  ollama: "ollama",
};

/**
 * Return the adapter key (openai|anthropic|google|ollama) for a given
 * `provider_type`. Returns null for unknown/missing values so callers can
 * fall back to inference (models.json lookup, bundle_id heuristic).
 *
 * @param {string|null|undefined} providerType
 * @returns {string|null}
 */
export function adapterKeyForType(providerType) {
  if (!providerType) return null;
  return TYPE_TO_ADAPTER[String(providerType).toLowerCase()] || null;
}

/**
 * Known provider_type values, in the order the Add-cloud-provider form
 * should offer them. Collapses the legacy "meta" into openai-compat (the
 * newer canonical label).
 */
export const KNOWN_PROVIDER_TYPES = [
  "openai",
  "anthropic",
  "google",
  "openrouter",
  "openai-compat",
  "ollama",
];
