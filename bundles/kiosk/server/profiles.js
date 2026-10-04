/**
 * Kiosk voice profiles (spec §7.3, ruling R6). The kiosk STT profile cannot
 * come from a manifest sttProfileSeed: seedProfile() dedups on provider+baseUrl
 * and :8004 already has the large-v3 profile. Created at first approval, with
 * a stable id so it is found again and never duplicated. Never the default.
 */
export const KIOSK_STT_PROFILE_ID = "kiosk-stt-distil-small-en";
export const KIOSK_STT_MODEL = "Systran/faster-distil-whisper-small.en";
const FALLBACK_BASE_URL = "http://localhost:8004/v1";

function parseList(raw) {
  try { const v = JSON.parse(raw || "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
}

export async function ensureKioskSttProfile(db, { readSetting, writeSetting }) {
  const list = parseList(await readSetting(db, "stt_profiles"));
  const existing = list.find((p) => p.id === KIOSK_STT_PROFILE_ID);
  if (existing) return existing;
  const fw = list.find((p) => p.provider === "fasterwhisper");
  const profile = {
    id: KIOSK_STT_PROFILE_ID,
    name: "Kiosk (faster-whisper distil-small.en)",
    provider: "fasterwhisper",
    apiKey: "",
    baseUrl: (fw?.baseUrl || FALLBACK_BASE_URL).trim(),
    defaultModel: KIOSK_STT_MODEL,
    language: "en",
    isDefault: list.length === 0,
  };
  list.push(profile);
  await writeSetting(db, "stt_profiles", JSON.stringify(list));
  return profile;
}

export async function pickKioskTtsProfile(db, { readSetting }) {
  const list = parseList(await readSetting(db, "tts_profiles"));
  return list.find((p) => p.provider === "kokoro") || null;
}
