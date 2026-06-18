/**
 * Metering core — pure cost computation + price-rule selection.
 *
 * This is the backend-independent heart of the paid-inference meter: given
 * token counts and a matching price rule, compute the USD cost; given a set
 * of price rules and a (provider, model) key, pick the best-matching rule.
 *
 * Kept dependency-free so it's trivially unit-testable and reusable across
 * every inference surface (dashboard chat, the /llm proxy, pi-bots).
 */

/**
 * Compute the USD cost of a single inference call.
 *
 * `cachedTokens` are treated as a SUBSET of `inputTokens` (matching how
 * OpenAI/Anthropic report cached prompt tokens): the cached portion is billed
 * at the cache-read rate when the rule provides one, the rest at the input
 * rate. Output tokens are always billed at the output rate.
 *
 * @param {{inputTokens?:number, outputTokens?:number, cachedTokens?:number}} tokens
 * @param {{input_cost_per_1m:number, output_cost_per_1m:number, cache_read_cost_per_1m?:number|null}} rule
 * @returns {number} cost in USD
 */
export function computeCost({ inputTokens = 0, outputTokens = 0, cachedTokens = 0 }, rule) {
  const cached = Math.min(cachedTokens, inputTokens);
  const uncachedInput = inputTokens - cached;
  const cacheRate =
    rule.cache_read_cost_per_1m != null ? rule.cache_read_cost_per_1m : rule.input_cost_per_1m;

  return (
    (uncachedInput / 1_000_000) * rule.input_cost_per_1m +
    (cached / 1_000_000) * cacheRate +
    (outputTokens / 1_000_000) * rule.output_cost_per_1m
  );
}

/**
 * Pick the best-matching price rule for a (provider, model) key.
 *
 * Precedence, most specific first:
 *   1. provider_id   + model_id
 *   2. provider_id   + "*"        (any model for this exact provider row)
 *   3. provider_type + model_id   (any provider of this type, this model)
 *   4. provider_type + "*"        (any provider of this type, any model)
 *
 * @param {Array<object>} rules
 * @param {{providerId?:string|null, providerType?:string|null, modelId?:string|null}} key
 * @returns {object|null} the highest-precedence matching rule, or null
 */
export function selectPriceRule(rules, { providerId = null, providerType = null, modelId = null }) {
  let best = null;
  let bestScore = 0;

  for (const rule of rules) {
    const idMatch = rule.provider_id != null && rule.provider_id === providerId;
    const typeMatch = rule.provider_type != null && rule.provider_type === providerType;
    const modelMatch = rule.model_id === modelId;
    const wildcardModel = rule.model_id === "*";

    let score = 0;
    if (idMatch && modelMatch) score = 4;
    else if (idMatch && wildcardModel) score = 3;
    else if (typeMatch && modelMatch) score = 2;
    else if (typeMatch && wildcardModel) score = 1;

    if (score > bestScore) {
      best = rule;
      bestScore = score;
    }
  }

  return best;
}

/**
 * Map an OpenAI-style usage object to our token shape.
 * @param {object} u  { prompt_tokens, completion_tokens, prompt_tokens_details? }
 */
function mapOpenAIUsage(u) {
  return {
    inputTokens: u.prompt_tokens || 0,
    outputTokens: u.completion_tokens || 0,
    cachedTokens: u.prompt_tokens_details?.cached_tokens || 0,
  };
}

/**
 * Extract token usage from a captured OpenAI-compatible response body —
 * either a non-streaming JSON object or a streamed SSE transcript (where the
 * `usage` block rides the final `include_usage` chunk). Returns null when no
 * usage is present (e.g. a stream that didn't request include_usage).
 *
 * Used by the /llm proxy tap to meter companion/glasses traffic.
 *
 * @param {string} rawText  the full upstream response body
 * @returns {{inputTokens:number, outputTokens:number, cachedTokens:number}|null}
 */
export function extractUsageFromOpenAIResponse(rawText) {
  if (!rawText || typeof rawText !== "string") return null;

  // Non-streaming: the whole body is one JSON object with a top-level usage.
  try {
    const obj = JSON.parse(rawText);
    if (obj && obj.usage) return mapOpenAIUsage(obj.usage);
  } catch {
    // not plain JSON — fall through to SSE parsing
  }

  // Streaming SSE: scan `data:` frames, keep the last one carrying usage.
  let found = null;
  for (const line of rawText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const chunk = JSON.parse(payload);
      if (chunk && chunk.usage) found = mapOpenAIUsage(chunk.usage);
    } catch {
      // skip unparseable frame
    }
  }
  return found;
}

/**
 * Load the currently-in-force price rules (effective_to IS NULL).
 *
 * @param {{execute:Function}} db  a libsql client
 * @returns {Promise<Array<object>>}
 */
export async function loadPricingRules(db) {
  const { rows } = await db.execute(
    "SELECT * FROM pricing_rules WHERE effective_to IS NULL",
  );
  return rows;
}

/**
 * Record one metered inference call into usage_events.
 *
 * Looks up the matching price rule and computes cost. If no rule matches, the
 * event is STILL written (priced=0, computed_cost_usd NULL) so unmatched usage
 * is surfaced for backfill rather than silently dropped — completeness is the
 * whole point of the meter.
 *
 * @param {{execute:Function}} db  a libsql client
 * @param {object} event
 * @returns {Promise<{priced:boolean, cost:number|null}>}
 */
export async function recordUsageEvent(db, event) {
  const {
    tenantId = null,
    conversationId = null,
    messageId = null,
    surface = "chat",
    providerId = null,
    providerType = null,
    modelId = null,
    inputTokens = 0,
    outputTokens = 0,
    cachedTokens = 0,
    requestId = null,
  } = event;

  const rules = await loadPricingRules(db);
  const rule = selectPriceRule(rules, { providerId, providerType, modelId });

  let cost = null;
  let priced = 0;
  if (rule) {
    cost = computeCost({ inputTokens, outputTokens, cachedTokens }, rule);
    priced = 1;
  }

  await db.execute({
    sql: `INSERT INTO usage_events
            (tenant_id, conversation_id, message_id, surface, provider_id, provider_type,
             model_id, input_tokens, output_tokens, cached_tokens, computed_cost_usd, priced, request_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      tenantId,
      conversationId,
      messageId,
      surface,
      providerId,
      providerType,
      modelId,
      inputTokens,
      outputTokens,
      cachedTokens,
      cost,
      priced,
      requestId,
    ],
  });

  return { priced: priced === 1, cost };
}
