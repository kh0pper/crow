/**
 * Media settings: per-instance values in the gateway's settings store, reached through the app
 * root so this works from an installed copy and from the stdio child alike. None of these keys is
 * in the sync allowlist, so they are stored as local (per-instance) values and never leave the host.
 */
import { appImport } from "./app-root.js";

export const CONFIG_KEY = "media_briefing_config";
export const JOB_STATE_KEY = "media_job_state";
export const TTS_PROFILE_KEY = "media_tts_profile_id";
export const TTS_VOICE_ES_KEY = "media_tts_voice_es";

let registry = null;
async function reg() { return (registry ||= await appImport("servers/gateway/dashboard/settings/registry.js")); }

/**
 * The stored string, or null when unset or when the settings store cannot be reached.
 * A failed read is never silent: it names the key and the error, never the value (a setting can
 * be a secret), so a store the process cannot reach (a walled child whose instance id is masked)
 * shows up in the log instead of looking like "unset". `strict: true` rethrows instead of null,
 * for a caller that must not go on without the value (the briefing schedule does).
 */
export async function readLocalSetting(db, key, { strict = false } = {}) {
  try {
    return await (await reg()).readSetting(db, key);
  } catch (err) {
    console.error(`[media] settings read failed for ${key}: ${String(err?.message || err).slice(0, 160)}`);
    if (strict) throw err;
    return null;
  }
}

export async function writeLocalSetting(db, key, value) {
  return (await reg()).writeSetting(db, key, String(value), { scope: "local" });
}

export async function readJsonSetting(db, key, opts) {
  const raw = await readLocalSetting(db, key, opts);
  if (!raw) return null;
  try { const v = JSON.parse(raw); return v && typeof v === "object" ? v : null; } catch { return null; }
}

/** The instance language as the briefing uses it: "es" for Spanish, otherwise "en". */
export async function instanceLang(db) {
  return String((await readLocalSetting(db, "language")) || "en").toLowerCase().startsWith("es") ? "es" : "en";
}
