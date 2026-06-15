/**
 * Map a provider row's `provider_type` column to the ai-adapter key
 * (`servers/gateway/ai/adapters/*`).
 *
 * `provider_type` values live in the `providers` DB column and come from the
 * Add-cloud-provider form. Local-bundle rows leave the column NULL — callers
 * infer the adapter from `bundle_id` + models.json in that case.
 *
 * Delegates to provider.js::resolveAdapterKey so the
 * openrouter/meta/openai-compat → openai aliasing lives in exactly one place.
 */

import { resolveAdapterKey } from "../gateway/ai/provider.js";

/**
 * Return the adapter key (openai|anthropic|google|ollama) for a given
 * `provider_type`. Returns null for unknown/missing values so callers can
 * fall back to inference (models.json lookup, bundle_id heuristic).
 *
 * @param {string|null|undefined} providerType
 * @returns {string|null}
 */
export function adapterKeyForType(providerType) {
  return resolveAdapterKey(providerType);
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
