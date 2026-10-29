/**
 * The eight "Add a provider" presets (roles phase 2b).
 *
 * Each preset is what the add-provider flow needs to test a pasted key and
 * write one providers row: the base URL (or variants), the adapter type, how
 * the key is sent, the path that proves the key works (`testPath`) and the
 * path that lists models (`modelsPath`). Paths are relative to the base URL.
 *
 * Every URL, path and header here was checked against the provider's own
 * docs on 2026-10-28; the pages are recorded in the `docs_urls` of
 * registry/provider-recommendations.json. Notes:
 *   - openrouter: `/models` answers without a key, so the key is tested with
 *     `GET /key` (Bearer), which needs one.
 *   - anthropic: `GET /v1/models` with `x-api-key` and `anthropic-version`.
 *     The docs now call `x-api-key` a "legacy fallback, still supported" and
 *     list 2026-10-21 as the latest version; 2023-06-01 stays a listed
 *     version and is what the anthropic adapter sends, so the test request
 *     matches the requests that follow it.
 *   - together: the docs base URL is now `https://api.together.ai/v1`;
 *     `api.together.xyz` (the older domain, still the default in several
 *     clients) is kept in `aliases` so existing rows are recognised.
 *   - zai: no models-list or key-check endpoint is documented. Both paths are
 *     `/models`, confirmed live 2026-10-28 on both bases (200 with a key,
 *     401 with a bad one).
 *   - other: any OpenAI-compatible server; the URL is typed by the user. The
 *     key may be empty (a local Ollama or llama-server needs none).
 *
 * Labels: `labelKey` is the i18n key; `label` is the English provider name
 * (a proper noun), used where a stored description needs plain text.
 */

const deepFreeze = (o) => {
  for (const v of Object.values(o)) if (v && typeof v === "object") deepFreeze(v);
  return Object.freeze(o);
};

export const ANTHROPIC_VERSION = "2023-06-01";

export const PROVIDER_PRESETS = deepFreeze([
  {
    id: "openrouter", label: "OpenRouter", labelKey: "providers.preset.openrouter",
    providerType: "openai", baseUrl: "https://openrouter.ai/api/v1",
    authStyle: "bearer", testPath: "/key", modelsPath: "/models", keyHint: "sk-or-...",
  },
  {
    id: "anthropic", label: "Anthropic", labelKey: "providers.preset.anthropic",
    providerType: "anthropic", baseUrl: "https://api.anthropic.com",
    authStyle: "anthropic", testPath: "/v1/models", modelsPath: "/v1/models", keyHint: "sk-ant-...",
  },
  {
    id: "openai", label: "OpenAI", labelKey: "providers.preset.openai",
    providerType: "openai", baseUrl: "https://api.openai.com/v1",
    authStyle: "bearer", testPath: "/models", modelsPath: "/models", keyHint: "sk-...",
  },
  {
    id: "google", label: "Google AI Studio", labelKey: "providers.preset.google",
    providerType: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    authStyle: "bearer", testPath: "/models", modelsPath: "/models", keyHint: "AIza...",
  },
  {
    id: "zai", label: "Z.AI", labelKey: "providers.preset.zai",
    providerType: "openai",
    variants: [
      { id: "payg", label: "Z.AI (pay as you go)", labelKey: "providers.preset.zai.payg", baseUrl: "https://api.z.ai/api/paas/v4" },
      { id: "coding", label: "Z.AI (GLM Coding Plan)", labelKey: "providers.preset.zai.coding", baseUrl: "https://api.z.ai/api/coding/paas/v4" },
    ],
    authStyle: "bearer", testPath: "/models", modelsPath: "/models", keyHint: "",
  },
  {
    id: "groq", label: "Groq", labelKey: "providers.preset.groq",
    providerType: "openai", baseUrl: "https://api.groq.com/openai/v1",
    authStyle: "bearer", testPath: "/models", modelsPath: "/models", keyHint: "gsk_...",
  },
  {
    id: "together", label: "Together AI", labelKey: "providers.preset.together",
    providerType: "openai", baseUrl: "https://api.together.ai/v1",
    aliases: ["https://api.together.xyz/v1"],
    authStyle: "bearer", testPath: "/models", modelsPath: "/models", keyHint: "",
  },
  {
    id: "other", label: "Other (OpenAI-compatible)", labelKey: "providers.preset.other",
    providerType: "openai-compat",
    authStyle: "bearer", testPath: "/models", modelsPath: "/models", keyHint: "",
  },
]);

const BY_ID = new Map(PROVIDER_PRESETS.map((p) => [p.id, p]));

export function presetById(id) {
  return BY_ID.get(id) || null;
}

/** Lowercase scheme and host, drop trailing slashes. Not a URL parser: a bad string normalises to itself. */
export function normalizeBaseUrl(url) {
  if (typeof url !== "string") return "";
  const s = url.trim().replace(/\/+$/, "");
  const m = s.match(/^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)(.*)$/i);
  return m ? m[1].toLowerCase() + m[2] : s;
}

/** Every base URL a preset answers to (main, variants, aliases), normalised. */
export function presetBaseUrls(preset) {
  const urls = [];
  if (preset.baseUrl) urls.push(preset.baseUrl);
  for (const v of preset.variants || []) urls.push(v.baseUrl);
  for (const a of preset.aliases || []) urls.push(a);
  return urls.map(normalizeBaseUrl);
}
