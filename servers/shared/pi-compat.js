/**
 * Pinned facts about pi (@earendil-works/pi-coding-agent), verified by hand
 * against an installed 0.85.1 (roles phase 2, Task 14). Bump PI_PINNED_VERSION
 * only after re-reading the same places in the new release:
 *
 *  - PI_BUILTIN_PROVIDER_IDS: pi-ai `dist/providers/all.js`, builtinProviders()
 *    (the provider registry pi composes at start). A models.json provider whose
 *    id is one of these MERGES with the built-in one (its provider-keyed rules
 *    and auth apply), so Crow's own provider ids must avoid this list.
 *    tests/pi-compat.test.js re-checks the list against an installed 0.85.1.
 *
 *  - piCompatFor: `detectCompat(model)` in the `openai-completions` chunk
 *    (`dist/bundle/chunks/openai-completions-*.js`). pi derives a model's
 *    request quirks from `model.provider` and substrings of `model.baseUrl`.
 *    When a bot reaches a cloud model through the gateway's door, pi sees the
 *    GATEWAY's URL and a Crow provider id, so it derives the generic defaults.
 *    piCompatFor re-derives what pi would have used for the UPSTREAM base URL
 *    and model id, and returns only the flags that differ from those
 *    defaults, as the per-model `compat` object `dist/core/model-config.js`
 *    (OpenAICompletionsCompatSchema) accepts. pi's getCompat() lets each
 *    explicit `model.compat` key win over detection, so writing this object
 *    into models.json reproduces the upstream behaviour exactly, provided the
 *    door's provider id is not a built-in id and the door URL matches none of
 *    the host rules below. It applies to `openai-completions` rows only.
 */

export const PI_PINNED_VERSION = "0.85.1";

export const PI_BUILTIN_PROVIDER_IDS = Object.freeze([
  "amazon-bedrock",
  "ant-ling",
  "anthropic",
  "azure-openai-responses",
  "baseten",
  "cerebras",
  "cloudflare-ai-gateway",
  "cloudflare-workers-ai",
  "deepseek",
  "fireworks",
  "github-copilot",
  "google",
  "google-vertex",
  "groq",
  "huggingface",
  "kimi-coding",
  "minimax",
  "minimax-cn",
  "mistral",
  "moonshotai",
  "moonshotai-cn",
  "nvidia",
  "openai",
  "openai-codex",
  "opencode",
  "opencode-go",
  "openrouter",
  "qwen-token-plan",
  "qwen-token-plan-cn",
  "qwen-token-plan-individual",
  "radius",
  "together",
  "vercel-ai-gateway",
  "xai",
  "xiaomi",
  "xiaomi-token-plan-ams",
  "xiaomi-token-plan-cn",
  "xiaomi-token-plan-sgp",
  "zai",
  "zai-coding-cn",
]);

// A line-for-line transliteration of pi 0.85.1's detectCompat, keeping only
// the keys whose value can vary (the rest are constants pi sets for every
// model: supportsUsageInStreaming, supportsFinishReason, requiresToolResultName,
// requiresAssistantAfterToolResult, requiresThinkingAsText, the empty routing
// and chat-template objects, zaiToolStream, the thinking-token-budget pair,
// supportsOpenAIGrammarTools, sendSessionAffinityHeaders, deferredToolsMode).
// Substring tests are pi's own: case-sensitive `includes` on the whole URL,
// except DeepSeek, which pi lower-cases first.
function detect(provider, baseUrl, modelId) {
  const isZai = provider === "zai" || provider === "zai-coding-cn"
    || baseUrl.includes("api.z.ai") || baseUrl.includes("open.bigmodel.cn");
  const isTogether = provider === "together"
    || baseUrl.includes("api.together.ai") || baseUrl.includes("api.together.xyz");
  const isMoonshot = provider === "moonshotai" || provider === "moonshotai-cn" || baseUrl.includes("api.moonshot.");
  const isOpenRouter = provider === "openrouter" || baseUrl.includes("openrouter.ai");
  const isCloudflareWorkersAI = provider === "cloudflare-workers-ai" || baseUrl.includes("api.cloudflare.com");
  const isCloudflareAiGateway = provider === "cloudflare-ai-gateway" || baseUrl.includes("gateway.ai.cloudflare.com");
  const isNvidia = provider === "nvidia" || baseUrl.includes("integrate.api.nvidia.com");
  const isAntLing = provider === "ant-ling" || baseUrl.includes("api.ant-ling.com");
  const isDeepSeek = provider === "deepseek" || baseUrl.toLowerCase().includes("deepseek.com");
  const isNonStandard = isNvidia
    || provider === "cerebras" || baseUrl.includes("cerebras.ai")
    || provider === "xai" || baseUrl.includes("api.x.ai")
    || isTogether || baseUrl.includes("chutes.ai") || isDeepSeek || isZai || isMoonshot
    || provider === "opencode" || baseUrl.includes("opencode.ai")
    || isCloudflareWorkersAI || isCloudflareAiGateway || isAntLing;
  const useMaxTokens = baseUrl.includes("chutes.ai") || isDeepSeek || isMoonshot
    || isCloudflareAiGateway || isTogether || isNvidia || isAntLing || isZai;
  const isGrok = provider === "xai" || baseUrl.includes("api.x.ai");
  const isOpenRouterDeveloperRoleModel = isOpenRouter
    && (modelId.startsWith("anthropic/") || modelId.startsWith("openai/"));
  // pi keys this one on the provider id alone, not the URL.
  const cacheControlFormat = provider === "openrouter" && modelId.startsWith("anthropic/") ? "anthropic" : undefined;
  return {
    supportsStore: !isNonStandard,
    supportsDeveloperRole: isOpenRouterDeveloperRoleModel || (!isNonStandard && !isOpenRouter),
    supportsReasoningEffort: !isGrok && !isZai && !isMoonshot && !isTogether
      && !isCloudflareAiGateway && !isNvidia && !isAntLing,
    maxTokensField: useMaxTokens ? "max_tokens" : "max_completion_tokens",
    requiresReasoningContentOnAssistantMessages: isDeepSeek,
    thinkingFormat: isDeepSeek ? "deepseek" : isZai ? "zai" : isTogether ? "together"
      : isAntLing ? "ant-ling" : isOpenRouter ? "openrouter" : "openai",
    supportsStrictMode: !isMoonshot && !isTogether && !isCloudflareAiGateway && !isNvidia,
    cacheControlFormat,
    sessionAffinityFormat: isOpenRouter ? "openrouter" : "openai",
    supportsLongCacheRetention: !(isTogether || isCloudflareWorkersAI || isCloudflareAiGateway || isNvidia || isAntLing),
  };
}

// What pi derives for a model it knows nothing about (a non-built-in provider
// id at a URL no rule matches): the door's own view.
const DEFAULTS = detect("", "", "");

/**
 * @param {string} baseUrl  the upstream provider's base URL
 * @param {string} modelId  the upstream model id
 * @returns {object|null} the compat keys that differ from pi's defaults, or
 *   null when pi has no rule for this upstream.
 */
export function piCompatFor(baseUrl, modelId) {
  if (typeof baseUrl !== "string" || !baseUrl) return null;
  const id = typeof modelId === "string" ? modelId : "";
  // Through the door the provider id is Crow's, so the provider-keyed half of
  // pi's rules never fires. Restore the one that has no URL twin: OpenRouter's
  // Anthropic cache control, which pi applies only when provider is
  // "openrouter". Every other provider-keyed rule has a URL alternative.
  const provider = baseUrl.includes("openrouter.ai") ? "openrouter" : "";
  const got = detect(provider, baseUrl, id);
  const out = {};
  for (const [k, v] of Object.entries(got)) {
    if (v !== DEFAULTS[k] && v !== undefined) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}
