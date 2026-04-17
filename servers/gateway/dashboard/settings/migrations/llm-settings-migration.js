/**
 * LLM-consolidation settings migration.
 *
 * Rewrites ai_profiles[] entries from legacy direct-mode (baseUrl + apiKey +
 * models[] + defaultModel) into pointer mode (provider_id + model_id),
 * UPSERTing one `cloud-${provider}-${profile.id}` row into the providers
 * table for each migrated profile. Also folds .env `AI_PROVIDER` / `AI_*`
 * vars into a `cloud-env-default` provider row so CLI callers that read
 * .env keep resolving the same config after the old ai-provider section
 * is deleted.
 *
 * Guarded by `dashboard_settings.llm_settings_migrated`. Each step is
 * independently idempotent (per-profile guard checks `profile.provider_id`
 * before converting), so a partially-failed run re-enters cleanly.
 *
 * Paired-Crow race: the `llm_settings_migrated` flag is deliberately NOT
 * in SYNC_ALLOWLIST — each instance runs its own pass. `ai_profiles` IS
 * synced, but (a) both instances compute the same deterministic row ID
 * `cloud-${provider}-${profile.id}` so the composite UPSERT converges,
 * and (b) the per-profile guard handles the case where Crow B reads a
 * post-rewrite blob that Crow A already shipped. Accepted double-bump of
 * lamport_ts; no mitigation needed.
 */

import { upsertProvider } from "../../../../orchestrator/providers-db.js";
import { resolveEnvPath, readEnvFile } from "../../../env-manager.js";
import { upsertSetting, readSetting } from "../registry.js";

const FLAG_KEY = "llm_settings_migrated";
const ENV_DEFAULT_ID = "cloud-env-default";
const KNOWN_PROVIDERS = new Set([
  "openai", "anthropic", "google", "ollama", "openrouter", "meta", "openai-compat",
]);

/** Collapse the legacy "meta" label into the canonical "openai-compat" tag. */
function normalizeProviderType(p) {
  if (!p) return null;
  const lower = String(p).toLowerCase();
  if (lower === "meta") return "openai-compat";
  return lower;
}

async function isAlreadyMigrated(db) {
  // FLAG_KEY is local-only (not in SYNC_ALLOWLIST); upsertSetting falls
  // back to dashboard_settings_overrides. readSetting checks both tables.
  const value = await readSetting(db, FLAG_KEY);
  return value ? true : false;
}

async function readAiProfiles(db) {
  const { rows } = await db.execute({
    sql: "SELECT value FROM dashboard_settings WHERE key = 'ai_profiles'",
    args: [],
  });
  if (!rows[0]?.value) return [];
  try {
    const parsed = JSON.parse(rows[0].value);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

/**
 * Step 1: rewrite each ai_profiles[] entry into pointer mode.
 * Returns { profiles, rewrote, created } — the updated blob is the
 * caller's responsibility to persist (we batch one write per call).
 */
async function migrateProfiles(db, profiles) {
  let rewrote = 0;
  let created = 0;
  const next = [];

  for (const p of profiles) {
    // Already migrated? Leave alone.
    if (p?.provider_id) { next.push(p); continue; }

    const providerType = normalizeProviderType(p?.provider);
    const hasCreds = typeof p?.baseUrl === "string" && p.baseUrl.length > 0;
    if (!providerType || !KNOWN_PROVIDERS.has(providerType) || !hasCreds) {
      // Not enough info to migrate — leave direct-mode fields in place.
      next.push(p);
      continue;
    }

    const providerId = `cloud-${providerType}-${p.id}`;
    const models = Array.isArray(p.models)
      ? p.models.map((m) => (typeof m === "string" ? { id: m } : m)).filter((m) => m && m.id)
      : [];

    try {
      await upsertProvider(db, {
        id: providerId,
        baseUrl: p.baseUrl,
        apiKey: p.apiKey || null,
        host: "cloud",
        bundleId: null,
        description: `Migrated from AI profile "${p.name || p.id}"`,
        models,
        disabled: false,
        providerType,
      });
      created++;
    } catch (err) {
      console.warn(`[llm-migration] upsert provider ${providerId} failed:`, err.message);
      next.push(p);
      continue;
    }

    // Keep legacy direct-mode fields (provider, apiKey, baseUrl, models)
    // alongside the new pointer fields. chat.js still reads the legacy
    // fields via createAdapterFromProfile; phase 5/7 switches chat to the
    // pointer path and can strip the legacy fields at that point.
    next.push({
      ...p,
      provider_id: providerId,
      model_id: p.defaultModel || null,
    });
    rewrote++;
  }

  return { profiles: next, rewrote, created };
}

/**
 * Step 2: fold .env AI_* vars into `cloud-env-default` + record its id in
 * `dashboard_settings.llm_chat_default_provider_id` (local-only key).
 */
async function migrateEnvDefault(db) {
  let envVars;
  try {
    const envPath = resolveEnvPath();
    envVars = readEnvFile(envPath).vars;
  } catch { return { migrated: false }; }

  const provider = envVars.get("AI_PROVIDER")?.value?.trim()?.toLowerCase();
  if (!provider) return { migrated: false };
  const apiKey = envVars.get("AI_API_KEY")?.value || "";
  const model = envVars.get("AI_MODEL")?.value || "";
  const baseUrl = envVars.get("AI_BASE_URL")?.value || "";

  const providerType = normalizeProviderType(provider);
  if (!KNOWN_PROVIDERS.has(providerType)) return { migrated: false };

  // Resolve baseUrl when missing for known cloud providers — matches the
  // fallbacks provider.js applies when constructing adapters.
  let effectiveBaseUrl = baseUrl;
  if (!effectiveBaseUrl) {
    if (providerType === "openai") effectiveBaseUrl = "https://api.openai.com/v1";
    else if (providerType === "anthropic") effectiveBaseUrl = "https://api.anthropic.com";
    else if (providerType === "google") effectiveBaseUrl = "https://generativelanguage.googleapis.com";
    else if (providerType === "openrouter") effectiveBaseUrl = "https://openrouter.ai/api/v1";
    else if (providerType === "openai-compat") return { migrated: false }; // no sensible default
  }

  try {
    await upsertProvider(db, {
      id: ENV_DEFAULT_ID,
      baseUrl: effectiveBaseUrl,
      apiKey: apiKey || null,
      host: "cloud",
      bundleId: null,
      description: "Migrated from .env AI_* vars",
      models: model ? [{ id: model }] : [],
      disabled: false,
      providerType,
    });
  } catch (err) {
    console.warn("[llm-migration] env-default upsert failed:", err.message);
    return { migrated: false };
  }

  // Record the env-default pointer. llm_chat_default_provider_id is a
  // local-only key (not in SYNC_ALLOWLIST); upsertSetting falls back to
  // dashboard_settings_overrides for non-allowlisted keys.
  try {
    await upsertSetting(db, "llm_chat_default_provider_id", ENV_DEFAULT_ID);
  } catch {}

  return { migrated: true, provider_id: ENV_DEFAULT_ID };
}

/**
 * Entry point. Idempotent. Returns a summary for logging.
 */
export async function migrateLlmSettings(db) {
  if (await isAlreadyMigrated(db)) {
    return { skipped: "already_migrated" };
  }

  const profiles = await readAiProfiles(db);
  const step1 = await migrateProfiles(db, profiles);
  if (step1.rewrote > 0) {
    // Persist rewritten profile list via upsertSetting so the sync-side
    // path fires just like any other ai_profiles write.
    await upsertSetting(db, "ai_profiles", JSON.stringify(step1.profiles));
  }

  const step2 = await migrateEnvDefault(db);

  await upsertSetting(
    db,
    FLAG_KEY,
    JSON.stringify({ at: new Date().toISOString(), version: 1 }),
  );

  return {
    profiles_total: profiles.length,
    profiles_rewrote: step1.rewrote,
    providers_created: step1.created,
    env_default_migrated: !!step2.migrated,
    env_default_provider_id: step2.provider_id || null,
  };
}
