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
 *    On top of that mirror, piCompatFor applies Crow's own table of known
 *    upstream quirks pi has no rule for yet (KNOWN_UPSTREAM_QUIRKS below).
 *    Those cannot live in detect(): it must stay a faithful copy of pi's
 *    rules, and a Crow-only entry there would read as pi behaviour and
 *    drift silently from the installed pi (the live test checks it).
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

/**
 * The namespace of the pi providers that reach a consented cloud row through
 * the gateway's cloud door (roles phase 2, Task 17): `crow-c-<rowId>`. No pi
 * built-in id starts with it (tests/pi-models-sync.test.js checks), so
 * a door entry never merges with a built-in provider and its auth.
 */
export const DOOR_ID_PREFIX = "crow-c-";
export const doorEntryId = (rowId) => DOOR_ID_PREFIX + rowId;

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

// Crow-side upstream quirks pi 0.85.1 has NO rule for. piCompatFor applies the
// matching entry on top of what it derived from pi's rules, so a door entry
// carries the flag pi should have used for the UPSTREAM url.
//
// `hosts` are matched against the URL's parsed HOST only (never a substring of
// the whole string), with a single trailing dot (the fully-qualified form)
// stripped first: the host equals an entry or is a subdomain of it. So
// `dashscope-intl.aliyuncs.com`, `token-plan.ap-southeast-1.maas.aliyuncs.com`
// and `aliyuncs.com.` match, while `aliyuncs.com.evil.example`,
// `notaliyuncs.com` and a path that merely contains the name do not.
//
//  - aliyuncs.com — Alibaba Cloud Model Studio / DashScope, whose
//    OpenAI-compatible endpoint (`.../compatible-mode/v1`) rejects a
//    `developer` message role with HTTP 400: "developer is not one of
//    ['system', 'assistant', 'user', 'tool', 'function']". pi sends the system
//    prompt as a developer message unless the flag is off, and through the
//    door pi only ever sees the gateway URL, which none of pi's own rules
//    match — so without this every request through the door failed upstream.
const KNOWN_UPSTREAM_QUIRKS = Object.freeze([
  Object.freeze({ hosts: Object.freeze(["aliyuncs.com"]), compat: Object.freeze({ supportsDeveloperRole: false }) }),
]);

/** Apply KNOWN_UPSTREAM_QUIRKS to `got` in place. An unparseable baseUrl
 * matches nothing (an empty host), leaving today's behaviour untouched. */
function applyKnownUpstreamQuirks(baseUrl, got) {
  let host;
  try { host = new URL(baseUrl).hostname.toLowerCase(); } catch { return got; }
  // A fully-qualified host keeps its trailing dot in URL.hostname; one dot is
  // not part of the name. Only a single one: `aliyuncs.com..` stays unmatched.
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (!host) return got;
  for (const q of KNOWN_UPSTREAM_QUIRKS) {
    if (q.hosts.some((h) => host === h || host.endsWith("." + h))) Object.assign(got, q.compat);
  }
  return got;
}

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
  applyKnownUpstreamQuirks(baseUrl, got);
  // Diff against pi's defaults AFTER the quirks, so the contract holds even
  // when a quirk happens to agree with a rule pi already has.
  const out = {};
  for (const [k, v] of Object.entries(got)) {
    if (v !== DEFAULTS[k] && v !== undefined) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}
