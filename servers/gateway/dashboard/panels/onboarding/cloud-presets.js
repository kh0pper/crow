/**
 * Cloud-provider presets for the onboarding wizard's AI step (C1/C3 Task 7).
 *
 * A small, curated set of paste-a-key options — NOT the full provider list
 * Settings -> Providers supports. Each preset carries exactly what the
 * onboarding form needs: a base URL, a `providerType` that resolves to a
 * real adapter, a default model (editable in the form, so a stale name
 * never blocks setup), and a placeholder key hint.
 *
 * `providerType` verification (per adapter, at build time):
 *   - "openai"    -> servers/gateway/ai/adapters/openai.js via
 *     resolveAdapterKey() (servers/gateway/ai/provider.js) — the direct
 *     adapter key. openai/groq/openrouter all resolve here (OpenAI-
 *     compatible endpoints, different baseUrl only).
 *   - "anthropic" -> servers/gateway/ai/adapters/anthropic.js. Verified live
 *     end to end: resolveAdapterKey("anthropic") returns "anthropic"
 *     directly (it is a real ADAPTER_LOADERS key, not one of the
 *     openrouter/meta/openai-compat aliases collapsed to "openai"), and
 *     routes/chat.js's pseudoProfile path (chat.js:591-666) passes
 *     `cfg.provider_type` straight through as `pseudoProfile.provider` — so
 *     a DB row with provider_type: "anthropic" reaches the real Anthropic
 *     adapter with no fallback needed. The adapter's own DEFAULT_BASE_URL
 *     ("https://api.anthropic.com") matches this preset's baseUrl exactly.
 *     The brief's openai-compat fallback / drop-the-preset contingency was
 *     NOT needed.
 *   - "google" (this preset) uses providerType "openai" against Google's
 *     documented OpenAI-compatible endpoint
 *     (generativelanguage.googleapis.com/v1beta/openai) rather than the
 *     dedicated "google" adapter key — both exist and work, but routing
 *     through the openai adapter needs no adapter-specific request
 *     translation for a simple chat-completions call, matching how this
 *     preset table already read before verification.
 */

export const CLOUD_PRESETS = [
  { id: "openai",      label: "OpenAI",              baseUrl: "https://api.openai.com/v1",                 providerType: "openai",    defaultModel: "gpt-4o-mini",        keyHint: "sk-..." },
  { id: "anthropic",   label: "Anthropic",           baseUrl: "https://api.anthropic.com",                 providerType: "anthropic", defaultModel: "claude-sonnet-5",  keyHint: "sk-ant-..." },
  { id: "google",      label: "Google AI Studio",    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", providerType: "openai", defaultModel: "gemini-2.5-flash", keyHint: "AIza..." },
  { id: "groq",        label: "Groq",                baseUrl: "https://api.groq.com/openai/v1",            providerType: "openai",    defaultModel: "llama-3.3-70b-versatile", keyHint: "gsk_..." },
  { id: "openrouter",  label: "OpenRouter",          baseUrl: "https://openrouter.ai/api/v1",              providerType: "openai",    defaultModel: "openrouter/auto",    keyHint: "sk-or-..." },
];
