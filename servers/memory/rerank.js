/**
 * Reranker client. Provider is host-neutral: see resolveDefaultRerankProvider.
 *
 * Used after hybrid FTS+vector retrieval to reorder top-K candidates
 * by cross-encoder relevance. Falls through to identity order if the
 * reranker is offline — search still works, just with less-refined order.
 */

import { loadProviders } from "../shared/providers.js";
import { resolveProviderForTask, RERANK_TASKS } from "../shared/provider-task.js";
import { loadProviderFromDb } from "./embeddings.js";

const RERANK_TIMEOUT_MS = 10_000;
const RERANK_TASK_SET = new Set(RERANK_TASKS);

/** CROW_RERANK_PROVIDER env → dashboard_settings 'rerank_provider' → lowest-id
 *  enabled provider with a rerank/score-tagged model → null (spec 2026-09-24). */
export async function resolveDefaultRerankProvider() {
  return resolveProviderForTask({ tasks: RERANK_TASKS, envVar: "CROW_RERANK_PROVIDER", settingKey: "rerank_provider" });
}

async function resolveRerankConfig(providerName) {
  if (!providerName) throw new Error("no rerank provider");
  let p = loadProviders().providers?.[providerName];
  if (!p || !p.baseUrl) p = await loadProviderFromDb(providerName); // cold cache / DB-only row
  if (!p || !p.baseUrl) throw new Error(`rerank provider "${providerName}" not configured`);
  const models = Array.isArray(p.models) ? p.models : [];
  const rerankModel = models.find((m) => m && RERANK_TASK_SET.has(m.task)) || models[0];
  const model = rerankModel?.id || "default";
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
export async function rerank(query, candidates, { topK = 10, providerName } = {}) {
  if (!candidates || candidates.length === 0) return [];
  providerName = providerName || (await resolveDefaultRerankProvider());

  let cfg;
  try {
    cfg = await resolveRerankConfig(providerName);
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
