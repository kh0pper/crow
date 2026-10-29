/**
 * The nine "Add a provider" presets (roles phase 2b).
 *
 * Each preset is what the add-provider flow needs to test a pasted key and
 * write one providers row: the base URL (or variants), the adapter type, how
 * the key is sent, the path that proves the key works (`testPath`) and the
 * path that lists models (`modelsPath`). Paths are relative to the base URL.
 *
 * Optional fields, for a provider that does not fit that shape:
 *   - `testRequest` {method:"POST", path, body}: the key test is this one
 *     request instead of a GET `testPath` (a provider with no listing).
 *   - `modelsPath: null`: no model list; the sheet offers the preset's
 *     recommended ids instead, and a typed name is allowed.
 *   - `probe` {toolChoice, extraBody}: how "Test the picks" asks for the tool
 *     call (default `tool_choice: "required"`, no extra body).
 *   - `variantLabelKey`: the i18n label of the variant choice (default "Your plan").
 *   - `keyNoteKey`: an i18n note shown under the key field for this preset.
 *   - `keyRejectedKey`: the i18n line for a rejected key on this preset.
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
 *   - modelstudio (Alibaba Cloud Model Studio, the hosted Qwen API): the
 *     OpenAI-compatible `compatible-mode/v1` base on the DashScope domain, one
 *     variant per region. A key is bound to the region it was created in (a
 *     key used in another region gets 401 invalid_api_key). No models-list
 *     endpoint is documented, so the key is tested with a one-token chat call
 *     on the cheapest recommended model and there is no listing. The docs say
 *     Qwen models refuse `tool_choice: "required"` (and so does any model in
 *     thinking mode; DeepSeek there thinks by default), so the probe asks with
 *     "auto" and `enable_thinking: false`, and still passes only on a real
 *     crow_probe call. Singapore (`intl`) is the default and the only region
 *     with a free quota. Coding Plan and Token Plan keys are not offered.
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
    id: "modelstudio", label: "Alibaba Model Studio (Qwen)", labelKey: "providers.preset.modelstudio",
    providerType: "openai",
    variants: [
      { id: "intl", label: "Alibaba Model Studio (Singapore)", labelKey: "providers.preset.modelstudio.intl", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1" },
      { id: "us", label: "Alibaba Model Studio (US, Virginia)", labelKey: "providers.preset.modelstudio.us", baseUrl: "https://dashscope-us.aliyuncs.com/compatible-mode/v1" },
      { id: "cn", label: "Alibaba Model Studio (China, Beijing)", labelKey: "providers.preset.modelstudio.cn", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
      { id: "hk", label: "Alibaba Model Studio (China, Hong Kong)", labelKey: "providers.preset.modelstudio.hk", baseUrl: "https://cn-hongkong.dashscope.aliyuncs.com/compatible-mode/v1" },
    ],
    authStyle: "bearer",
    testRequest: {
      method: "POST", path: "/chat/completions",
      body: { model: "qwen3.8-flash", messages: [{ role: "user", content: "ok" }], max_tokens: 1 },
    },
    modelsPath: null,
    probe: { toolChoice: "auto", extraBody: { enable_thinking: false } },
    keyHint: "sk-...",
    variantLabelKey: "models.add.region",
    keyNoteKey: "providers.preset.modelstudio.keyNote",
    keyRejectedKey: "models.add.test.key_rejected_region",
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
