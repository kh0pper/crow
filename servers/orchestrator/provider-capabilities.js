/**
 * Tag a provider row with the capabilities it advertises.
 *
 * Driven by two signals:
 *   1. The `provider_type` column (set on cloud rows by the Add form;
 *      NULL on local-bundle rows, where the tag is inferred from the
 *      bundle_id and model IDs).
 *   2. Model-ID heuristics: -embed-, -reranker-, -vl-/-vision-/-vlm-.
 *      These catch the non-cloud cases — grackle-embed, grackle-rerank,
 *      grackle-vision — that have no provider_type.
 *
 * The returned tag set drives compat.js's capability-mismatch check
 * (e.g. "you can't assign grackle-embed to a chat role"). Tags are
 * additive: a provider that has both an embed model and a chat model
 * gets both tags.
 */

/**
 * @typedef {Object} Provider
 * @property {string} id
 * @property {string=} provider_type
 * @property {string=} bundle_id
 * @property {Array<{id: string, mutexGroup?: string, conflictsWith?: string[]}>} [models]
 * @property {boolean=} disabled
 */

const MODEL_ID_HEURISTICS = [
  { tag: "embed",  match: /(^|-)embed(-|$)/i },
  { tag: "rerank", match: /rerank/i },
  { tag: "vision", match: /(^|-)(vl|vlm|vision)(-|$)|mmproj|glm-4[.]\dv/i },
];

/**
 * @param {Provider} provider
 * @returns {{
 *   tags: string[],
 *   mutex_groups: string[],
 *   conflicts_with: string[],
 * }}
 */
export function providerCapabilities(provider) {
  if (!provider) return { tags: [], mutex_groups: [], conflicts_with: [] };

  const tags = new Set();

  // 1. provider_type → base tag
  const pt = (provider.provider_type || "").toLowerCase();
  if (pt === "openai" || pt === "openai-compat" || pt === "openrouter" ||
      pt === "anthropic" || pt === "google" || pt === "ollama" || pt === "meta") {
    tags.add("chat");
  }

  // 2. Model-ID heuristics (pick up embed/rerank/vision for local bundles,
  // and also catches cloud providers whose models list includes e.g. a VLM)
  const models = Array.isArray(provider.models) ? provider.models : [];
  const mutexGroups = new Set();
  const conflicts = new Set();
  for (const m of models) {
    const id = typeof m === "string" ? m : m?.id;
    if (!id) continue;
    for (const h of MODEL_ID_HEURISTICS) {
      if (h.match.test(id)) tags.add(h.tag);
    }
    if (typeof m === "object") {
      if (m.mutexGroup) mutexGroups.add(m.mutexGroup);
      if (Array.isArray(m.conflictsWith)) for (const c of m.conflictsWith) conflicts.add(c);
    }
  }

  // 3. If no special-purpose tag surfaced and we have models, default to chat
  if (tags.size === 0 && models.length > 0) tags.add("chat");

  return {
    tags: [...tags],
    mutex_groups: [...mutexGroups],
    conflicts_with: [...conflicts],
  };
}

/**
 * Convenience: does this provider advertise the given capability?
 * @param {Provider} provider
 * @param {string} tag  — one of "chat" | "vision" | "embed" | "rerank"
 */
export function hasCapability(provider, tag) {
  return providerCapabilities(provider).tags.includes(tag);
}
