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

/** The stored string, or null when unset or when the settings store cannot be reached. */
export async function readLocalSetting(db, key) {
  try { return await (await reg()).readSetting(db, key); } catch { return null; }
}

export async function writeLocalSetting(db, key, value) {
  return (await reg()).writeSetting(db, key, String(value), { scope: "local" });
}

export async function readJsonSetting(db, key) {
  const raw = await readLocalSetting(db, key);
  if (!raw) return null;
  try { const v = JSON.parse(raw); return v && typeof v === "object" ? v : null; } catch { return null; }
}

/** The instance language as the briefing uses it: "es" for Spanish, otherwise "en". */
export async function instanceLang(db) {
  return String((await readLocalSetting(db, "language")) || "en").toLowerCase().startsWith("es") ? "es" : "en";
}
