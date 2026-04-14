/**
 * Reranker client for grackle-rerank (Qwen3-Reranker-0.6B via vLLM-CUDA).
 *
 * Used after hybrid FTS+vector retrieval to reorder top-K candidates
 * by cross-encoder relevance. Falls through to identity order if the
 * reranker is offline — search still works, just with less-refined order.
 */

import { loadProviders } from "../orchestrator/providers.js";

const DEFAULT_PROVIDER = "grackle-rerank";
const RERANK_TIMEOUT_MS = 10_000;

function resolveRerankConfig(providerName = DEFAULT_PROVIDER) {
  const cfg = loadProviders();
  const p = cfg.providers?.[providerName];
  if (!p || !p.baseUrl) {
    throw new Error(`rerank provider "${providerName}" not configured`);
  }
  const model = p.models?.[0]?.id || "default";
  return { baseUrl: p.baseUrl, apiKey: p.apiKey, model, name: providerName };
}

/**
 * Rerank a list of candidate documents against a query.
 *
 * @param {string} query
 * @param {Array<{id: any, text: string, ...any}>} candidates
 * @param {object} opts
 * @param {number} [opts.topK=10]
 * @param {string} [opts.providerName]
 * @returns {Promise<Array>} sorted desc by relevance_score, augmented with { relevance: number }
 *   On reranker failure, returns candidates in original order without a relevance field.
 */
export async function rerank(query, candidates, { topK = 10, providerName = DEFAULT_PROVIDER } = {}) {
  if (!candidates || candidates.length === 0) return [];

  let cfg;
  try {
    cfg = resolveRerankConfig(providerName);
  } catch {
    return candidates.slice(0, topK); // no provider, fallback
  }

  const body = JSON.stringify({
    model: cfg.model,
    query,
    documents: candidates.map((c) => c.text || ""),
  });
  const headers = { "Content-Type": "application/json" };
  if (cfg.apiKey && cfg.apiKey !== "none") {
    headers.Authorization = `Bearer ${cfg.apiKey}`;
  }

  try {
    const res = await fetch(cfg.baseUrl.replace(/\/+$/, "") + "/rerank", {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(RERANK_TIMEOUT_MS),
    });
    if (!res.ok) return candidates.slice(0, topK);
    const json = await res.json();
    const results = json.results || [];
    // vLLM rerank returns [{index, document:{text}, relevance_score}]
    const reranked = results
      .map((r) => ({
        ...candidates[r.index],
        relevance: r.relevance_score,
      }))
      .sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0))
      .slice(0, topK);
    return reranked;
  } catch {
    // On any error fall back to original order
    return candidates.slice(0, topK);
  }
}
