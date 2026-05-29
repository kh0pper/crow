/**
 * CrowClaw — BYOAI Bridge
 *
 * Maps Crow's AI provider configuration to OpenClaw's models.json format.
 * When a bot has ai_source="byoai", its models.json is generated from
 * Crow's AI profiles (database) or env-based provider config.
 *
 * Crow provider config: { provider, apiKey, model, baseUrl }
 * OpenClaw models.json: { providers: { "name": { baseUrl, api, apiKey, models[] } } }
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Map Crow provider names to OpenClaw API types
const PROVIDER_API_MAP = {
  openai: "openai-completions",
  anthropic: "anthropic-messages",
  google: "google-gemini",
  ollama: "ollama",
  openrouter: "openai-completions",
  meta: "openai-completions",
};

// Default base URLs per provider
const DEFAULT_BASE_URLS = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  google: "https://generativelanguage.googleapis.com/v1beta",
  ollama: "http://localhost:11434",
  openrouter: "https://openrouter.ai/api/v1",
  meta: "https://api.llama.com/compat/v1/",
};

// Default models per provider
const DEFAULT_MODELS = {
  openai: "gpt-4o",
  anthropic: "claude-sonnet-4-20250514",
  google: "gemini-2.5-flash",
  ollama: "llama3.1",
  openrouter: "openai/gpt-4o",
  meta: "llama3.1-70b",
};

/**
 * Detect whether a model supports vision (image input).
 * Heuristic based on known model naming patterns.
 */
export function isVisionModel(provider, modelId) {
  const id = modelId.toLowerCase();
  // Local llamacpp deployments launched with --mmproj are multimodal even
  // though their model name doesn't carry a vision marker. Allowlist explicitly.
  if (id === "qwen3.6-35b-a3b") return true;
  if (/^glm-\d+(\.\d+)?v$/.test(id)) return true;        // Z.AI: glm-4.6v, glm-4.5v
  if (/^gpt-4o/.test(id) || /^gpt-4-turbo/.test(id)) return true;  // OpenAI multimodal
  if (/^gemini-/.test(id)) return true;                    // Google Gemini
  if (id.includes("vision")) return true;                  // Ollama vision models
  if (/^llama-4/i.test(id)) return true;                   // Meta Llama 4
  return false;
}

/**
 * Map a base URL to the OpenClaw provider namespace used by `openclaw models` CLI.
 * This enables provider-qualified model IDs (e.g., "zai/glm-4.6v") for set-image.
 */
function openclawProviderFromBaseUrl(baseUrl) {
  if (!baseUrl) return null;
  const url = baseUrl.toLowerCase();
  // Crow-local llamacpp / vLLM endpoints on the Tailscale tailnet.
  // CGNAT range 100.64.0.0/10 — covers grackle, crow, mockingbird, colibri, penguin.
  // Map OpenAI-compatible local endpoints (path includes /v1) to the "openai"
  // namespace so OpenClaw's plugin-registered openai provider can route them.
  // Custom names like "crow-local-${port}" don't work — OpenClaw flags them as
  // "missing" because no plugin manifest declares them.
  const cgnat = url.match(/\/\/100\.(?:6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\.\d+\.\d+:\d+\/v1\b/);
  if (cgnat) return "vllm";
  if (url.includes("z.ai")) return "zai";
  if (url.includes("dashscope")) return "qwen-portal";
  if (url.includes("llama.com")) return "meta";
  if (url.includes("openai.com")) return "openai";
  if (url.includes("anthropic.com")) return "anthropic";
  if (url.includes("googleapis.com") || url.includes("generativelanguage")) return "google";
  if (url.includes("openrouter.ai")) return "openrouter";
  if (url.includes("localhost") || url.includes("127.0.0.1")) return "ollama";
  return null;
}

/**
 * Read Crow's active AI provider config.
 * Imports from Crow's gateway module dynamically.
 * @param {string} crowRoot - Path to ~/crow
 * @returns {{ provider, apiKey, model, baseUrl } | null}
 */
export async function getCrowProviderConfig(crowRoot) {
  const providerPath = join(crowRoot, "servers", "gateway", "ai", "provider.js");
  if (!existsSync(providerPath)) return null;

  try {
    const mod = await import(pathToFileURL(providerPath).href);
    return mod.getProviderConfig();
  } catch {
    return null;
  }
}

/**
 * Read Crow's AI profiles from the database.
 * @param {object} db - @libsql/client instance (Crow's crow.db)
 * @returns {Array<{ id, name, provider, apiKey, baseUrl, defaultModel, models }>}
 */
export async function getCrowAiProfiles(db) {
  try {
    const result = await db.execute({
      sql: "SELECT value FROM dashboard_settings WHERE key = 'ai_profiles'",
      args: [],
    });
    if (!result.rows[0]?.value) return [];
    return JSON.parse(result.rows[0].value);
  } catch {
    return [];
  }
}

/**
 * Convert a Crow provider config to OpenClaw models.json format.
 * Supports both single model (crowConfig.model) and multi-model (crowConfig.models array).
 * @param {{ provider: string, apiKey: string, model: string, models?: string[], baseUrl?: string }} crowConfig
 * @param {string} [profileName] - Name for the provider entry (default: "crow-byoai")
 * @returns {{ providers: object, imageModel: string|null }}
 */
export function crowToOpenClawModels(crowConfig, profileName = "crow-byoai") {
  const { provider, apiKey, model, models, baseUrl } = crowConfig;

  const api = PROVIDER_API_MAP[provider] || "openai-completions";
  const resolvedBaseUrl = baseUrl || DEFAULT_BASE_URLS[provider] || "";

  // Build model list: use models array if provided, otherwise single model
  const modelIds = models && models.length > 0
    ? models
    : [model || DEFAULT_MODELS[provider] || ""];

  let imageModel = null;
  // Resolve OpenClaw provider prefix for CLI commands (e.g., "zai/glm-4.6v")
  const openclawProvider = openclawProviderFromBaseUrl(resolvedBaseUrl);

  const modelEntries = modelIds.map(id => {
    const vision = isVisionModel(provider, id);
    if (vision && !imageModel) {
      imageModel = openclawProvider ? `${openclawProvider}/${id}` : id;
    }
    return {
      id,
      name: id,
      reasoning: false,
      input: vision ? ["text", "image"] : ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 16384,
    };
  });

  return {
    providers: {
      [profileName]: {
        baseUrl: resolvedBaseUrl,
        api,
        apiKey: apiKey || "",
        models: modelEntries,
      },
    },
    imageModel,
  };
}

/**
 * Convert a Crow AI profile to OpenClaw models.json format.
 * Uses the OpenClaw provider namespace (e.g., "zai", "qwen-portal") as the
 * provider key so models.json aligns with OpenClaw's auth profiles.
 * Falls back to crow-{id} if no mapping exists.
 */
export function profileToOpenClawModels(profile) {
  const openclawName = openclawProviderFromBaseUrl(profile.baseUrl) || `crow-${profile.id}`;
  return crowToOpenClawModels({
    provider: profile.provider,
    apiKey: profile.apiKey,
    model: profile.defaultModel,
    models: profile.models,
    baseUrl: profile.baseUrl,
  }, openclawName);
}

/**
 * Discover the correct models.json path via OpenClaw CLI.
 * Uses `openclaw config file` with OPENCLAW_CONFIG_PATH to find the state dir,
 * then resolves agents/main/agent/ as the target.
 * @param {string} configDir - Bot's config directory (contains openclaw.json)
 * @returns {string} Path to the agents/main/agent/ directory
 */
async function discoverAgentDir(configDir) {
  const env = { ...process.env, OPENCLAW_CONFIG_PATH: resolve(configDir, "openclaw.json") };
  const { stdout } = await execFileAsync("openclaw", ["config", "file"], { env, timeout: 5_000 });
  // CLI may return tilde paths (e.g., ~/.openclaw/openclaw.json) — expand them
  const { homedir: getHome } = await import("node:os");
  const configFile = stdout.trim().replace(/^~(?=\/|$)/, getHome());
  const stateDir = resolve(configFile, "..");
  return resolve(stateDir, "agents", "main", "agent");
}

// Namespaces whose providers must live in openclaw.json::models.providers
// (NOT agents/main/agent/models.json::providers) because OpenClaw's custom-local-server
// plugins (vllm, sglang) check openclaw.json at discovery time. Putting the entry in
// agents/main/agent/models.json leaves these plugins unable to find the provider and
// the runtime throws "Unknown model: <ns>/<model>".
// Built-in plugin namespaces (zai, qwen-portal, anthropic, meta, ollama, openai, google)
// work from either location because their plugin catalogs register the models directly.
const OPENCLAW_CONFIG_PROVIDERS = new Set(["vllm", "sglang"]);

/**
 * Merge provider entries into openclaw.json::models.providers (read → merge → write).
 * Preserves surrounding config. Sets models.mode = "merge" if unset (matches canonical
 * shape from buildOpenAICompatibleSelfHostedProviderConfig).
 */
function mergeIntoOpenclawJson(configDir, providers) {
  if (Object.keys(providers).length === 0) return null;
  const configPath = resolve(configDir, "openclaw.json");
  if (!existsSync(configPath)) {
    throw new Error(`openclaw.json not found at ${configPath}; cannot merge custom-local providers`);
  }
  const cfg = JSON.parse(readFileSync(configPath, "utf8"));
  cfg.models = cfg.models ?? {};
  cfg.models.mode = cfg.models.mode ?? "merge";
  cfg.models.providers = { ...(cfg.models.providers ?? {}), ...providers };
  writeFileSync(configPath, JSON.stringify(cfg, null, 2));
  return configPath;
}

/**
 * Write models.json into a bot's config directory, using Crow's AI config.
 * Merges ALL Crow AI profiles when db is available and no specific profile is requested.
 *
 * Two-destination logic: built-in plugin providers go to agents/main/agent/models.json;
 * custom-local-plugin providers (vllm, sglang — see OPENCLAW_CONFIG_PROVIDERS) go to
 * openclaw.json::models.providers. See the block comment above OPENCLAW_CONFIG_PROVIDERS
 * for why.
 *
 * @param {object} opts
 * @param {string} opts.configDir - Bot's config directory
 * @param {string} [opts.crowRoot] - Path to ~/crow (for reading env-based config)
 * @param {object} [opts.db] - DB client (for reading profiles)
 * @param {string} [opts.profileName] - Specific AI profile name to use
 * @returns {{ written: boolean, modelsPath: string, openclawConfigPath: string|null, provider: string, model: string, imageModel: string|null }}
 */
export async function generateModelsJson(opts) {
  const { configDir, crowRoot, db, profileName } = opts;

  let modelsJson;
  let imageModel = null;

  if (profileName && db) {
    // Single named profile
    const profiles = await getCrowAiProfiles(db);
    const profile = profiles.find(p => p.name === profileName);
    if (!profile) throw new Error(`AI profile "${profileName}" not found in Crow`);
    const result = profileToOpenClawModels(profile);
    modelsJson = { providers: result.providers };
    imageModel = result.imageModel;
  } else if (db) {
    // Merge ALL profiles — each becomes a separate provider entry
    const profiles = await getCrowAiProfiles(db);
    if (profiles.length === 0) throw new Error("No AI profiles configured in Crow.");
    modelsJson = { providers: {} };
    for (const profile of profiles) {
      const result = profileToOpenClawModels(profile);
      Object.assign(modelsJson.providers, result.providers);
      if (result.imageModel && !imageModel) imageModel = result.imageModel;
    }
  } else if (crowRoot) {
    // Env-based fallback
    const config = await getCrowProviderConfig(crowRoot);
    if (!config) throw new Error("No AI provider configured in Crow. Set AI_PROVIDER in Crow settings.");
    const result = crowToOpenClawModels(config);
    modelsJson = { providers: result.providers };
    imageModel = result.imageModel;
  } else {
    throw new Error("Either crowRoot or db is required");
  }

  // Split providers by destination. Custom-local-plugin entries get merged into
  // openclaw.json; everything else goes to agents/main/agent/models.json.
  const agentProviders = {};
  const openclawProviders = {};
  for (const [key, value] of Object.entries(modelsJson.providers)) {
    if (OPENCLAW_CONFIG_PROVIDERS.has(key)) {
      openclawProviders[key] = value;
    } else {
      agentProviders[key] = value;
    }
  }

  // Discover correct path via OpenClaw CLI
  let agentsDir;
  try {
    agentsDir = await discoverAgentDir(configDir);
  } catch {
    // Fallback if CLI fails (e.g., no openclaw.json yet during first deploy)
    agentsDir = resolve(configDir, "agents", "main", "agent");
  }

  const { mkdirSync } = await import("node:fs");
  if (!existsSync(agentsDir)) mkdirSync(agentsDir, { recursive: true });

  // Always write agents/main/agent/models.json — even when the custom-local map is
  // the only thing with entries, writing an empty providers map here is fine and
  // keeps the file present for future non-custom-local profiles.
  const modelsPath = resolve(agentsDir, "models.json");
  writeFileSync(modelsPath, JSON.stringify({ providers: agentProviders }, null, 2));

  // Merge custom-local providers into openclaw.json::models.providers.
  const openclawConfigPath = mergeIntoOpenclawJson(configDir, openclawProviders);

  // For the return payload, prefer a custom-local provider key if present (that's
  // what the bot will use); otherwise fall back to the first agent-side provider.
  const mergedKeys = [...Object.keys(openclawProviders), ...Object.keys(agentProviders)];
  const providerKey = mergedKeys[0];
  const providerEntry = openclawProviders[providerKey] ?? agentProviders[providerKey];

  return {
    written: true,
    modelsPath,
    openclawConfigPath,
    provider: providerKey,
    model: providerEntry?.models?.[0]?.id,
    imageModel,
  };
}
