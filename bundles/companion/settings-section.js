/**
 * Companion Settings Section: TTS Voice & AI Provider
 * Auto-discovered from ~/.crow/bundles/companion/settings-section.js
 *
 * Avatar selection has been moved to the companion's character selector
 * (Open-LLM-VTuber UI), so users can switch avatars live without a restart.
 * This section manages TTS voice and AI provider (which require a restart).
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { execFileSync } from "child_process";

const BUNDLE_DIR = join(homedir(), ".crow", "bundles", "companion");

/** Read the bundle's .env file as key-value pairs */
function readBundleEnv() {
  const envPath = join(BUNDLE_DIR, ".env");
  if (!existsSync(envPath)) return {};
  const env = {};
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (match) env[match[1]] = match[2];
  }
  return env;
}

/** Write key-value pairs to the bundle's .env file */
function writeBundleEnv(env) {
  const envPath = join(BUNDLE_DIR, ".env");
  const lines = Object.entries(env)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${v}`);
  writeFileSync(envPath, lines.join("\n") + "\n");
}

/** Get the current TTS voice from the bundle env or compose defaults */
function getCurrentVoice() {
  const env = readBundleEnv();
  return env.COMPANION_TTS_VOICE || "en-US-AvaMultilingualNeural";
}

/** Get current AI profile slug from bundle env */
function getCurrentAiProfile() {
  const env = readBundleEnv();
  return env.COMPANION_AI_PROFILE || "";
}

/** Get current AI model override from bundle env */
function getCurrentAiModel() {
  const env = readBundleEnv();
  return env.COMPANION_AI_MODEL || "";
}

/** Read household profiles from env vars */
function getHouseholdProfiles() {
  const env = readBundleEnv();
  const profiles = [];
  for (let i = 1; i <= 4; i++) {
    const name = env[`COMPANION_PROFILE_${i}_NAME`];
    if (!name) continue;
    profiles.push({
      index: i,
      name,
      avatar: env[`COMPANION_PROFILE_${i}_AVATAR`] || "mao_pro",
      voice: env[`COMPANION_PROFILE_${i}_VOICE`] || "en-US-AvaMultilingualNeural",
    });
  }
  return profiles;
}

/** Curated voice list with popular voices grouped by language */
const VOICE_GROUPS = [
  {
    label: "English (US)",
    lang: "en-US",
    voices: [
      { n: "en-US-AvaMultilingualNeural", g: "F", p: "Expressive, Caring, Pleasant, Friendly" },
      { n: "en-US-AndrewMultilingualNeural", g: "M", p: "Warm, Confident, Authentic, Honest" },
      { n: "en-US-EmmaMultilingualNeural", g: "F", p: "Cheerful, Clear, Conversational" },
      { n: "en-US-BrianMultilingualNeural", g: "M", p: "Approachable, Casual, Sincere" },
      { n: "en-US-AriaNeural", g: "F", p: "Positive, Confident" },
      { n: "en-US-JennyNeural", g: "F", p: "Friendly, Considerate, Comfort" },
      { n: "en-US-GuyNeural", g: "M", p: "Passion" },
      { n: "en-US-AnaNeural", g: "F", p: "Cute" },
      { n: "en-US-ChristopherNeural", g: "M", p: "Reliable, Authority" },
      { n: "en-US-EricNeural", g: "M", p: "Rational" },
      { n: "en-US-MichelleNeural", g: "F", p: "Friendly, Pleasant" },
      { n: "en-US-RogerNeural", g: "M", p: "Lively" },
      { n: "en-US-SteffanNeural", g: "M", p: "Rational" },
    ],
  },
  {
    label: "English (UK)",
    lang: "en-GB",
    voices: [
      { n: "en-GB-SoniaNeural", g: "F", p: "Friendly, Positive" },
      { n: "en-GB-RyanNeural", g: "M", p: "Friendly, Positive" },
      { n: "en-GB-LibbyNeural", g: "F", p: "Friendly, Positive" },
      { n: "en-GB-ThomasNeural", g: "M", p: "Friendly, Positive" },
      { n: "en-GB-MaisieNeural", g: "F", p: "Friendly, Positive" },
    ],
  },
  {
    label: "English (Australia)",
    lang: "en-AU",
    voices: [
      { n: "en-AU-NatashaNeural", g: "F", p: "Friendly, Positive" },
      { n: "en-AU-WilliamMultilingualNeural", g: "M", p: "Friendly, Positive" },
    ],
  },
  {
    label: "Spanish",
    lang: "es",
    voices: [
      { n: "es-MX-DaliaNeural", g: "F", p: "Friendly, Positive" },
      { n: "es-MX-JorgeNeural", g: "M", p: "Friendly, Positive" },
      { n: "es-ES-ElviraNeural", g: "F", p: "Friendly, Positive" },
      { n: "es-ES-AlvaroNeural", g: "M", p: "Friendly, Positive" },
    ],
  },
  {
    label: "French",
    lang: "fr",
    voices: [
      { n: "fr-FR-DeniseNeural", g: "F", p: "Friendly, Positive" },
      { n: "fr-FR-HenriNeural", g: "M", p: "Friendly, Positive" },
      { n: "fr-FR-VivienneMultilingualNeural", g: "F", p: "Friendly, Positive" },
      { n: "fr-FR-RemyMultilingualNeural", g: "M", p: "Friendly, Positive" },
    ],
  },
  {
    label: "German",
    lang: "de",
    voices: [
      { n: "de-DE-KatjaNeural", g: "F", p: "Friendly, Positive" },
      { n: "de-DE-ConradNeural", g: "M", p: "Friendly, Positive" },
      { n: "de-DE-SeraphinaMultilingualNeural", g: "F", p: "Friendly, Positive" },
      { n: "de-DE-FlorianMultilingualNeural", g: "M", p: "Friendly, Positive" },
    ],
  },
  {
    label: "Japanese",
    lang: "ja-JP",
    voices: [
      { n: "ja-JP-NanamiNeural", g: "F", p: "Friendly, Positive" },
      { n: "ja-JP-KeitaNeural", g: "M", p: "Friendly, Positive" },
      { n: "ja-JP-MasaruMultilingualNeural", g: "M", p: "Friendly, Positive" },
    ],
  },
  {
    label: "Chinese (Mandarin)",
    lang: "zh-CN",
    voices: [
      { n: "zh-CN-XiaoxiaoNeural", g: "F", p: "Warm" },
      { n: "zh-CN-YunxiNeural", g: "M", p: "Lively, Sunshine" },
      { n: "zh-CN-XiaoyiNeural", g: "F", p: "Lively, Cute" },
      { n: "zh-CN-YunjianNeural", g: "M", p: "Passion, Confident" },
    ],
  },
  {
    label: "Korean",
    lang: "ko-KR",
    voices: [
      { n: "ko-KR-SunHiNeural", g: "F", p: "Friendly, Positive" },
      { n: "ko-KR-InJoonNeural", g: "M", p: "Friendly, Positive" },
      { n: "ko-KR-HyunsuNeural", g: "M", p: "Friendly, Positive" },
    ],
  },
  {
    label: "Portuguese (Brazil)",
    lang: "pt-BR",
    voices: [
      { n: "pt-BR-FranciscaNeural", g: "F", p: "Friendly, Positive" },
      { n: "pt-BR-AntonioNeural", g: "M", p: "Friendly, Positive" },
      { n: "pt-BR-ThalitaMultilingualNeural", g: "F", p: "Friendly, Positive" },
    ],
  },
  {
    label: "Italian",
    lang: "it-IT",
    voices: [
      { n: "it-IT-ElsaNeural", g: "F", p: "Friendly, Positive" },
      { n: "it-IT-DiegoNeural", g: "M", p: "Friendly, Positive" },
      { n: "it-IT-GiuseppeMultilingualNeural", g: "M", p: "Friendly, Positive" },
    ],
  },
  {
    label: "Hindi",
    lang: "hi-IN",
    voices: [
      { n: "hi-IN-SwaraNeural", g: "F", p: "Friendly, Positive" },
      { n: "hi-IN-MadhurNeural", g: "M", p: "Friendly, Positive" },
    ],
  },
];

/** Read AI profiles from DB via the provided db handle */
async function getAiProfiles(db) {
  try {
    const result = await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = 'ai_profiles'", args: [] });
    return result.rows[0]?.value ? JSON.parse(result.rows[0].value) : [];
  } catch { return []; }
}

export default {
  id: "companion-voice",
  group: "content",
  icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>`,
  labelKey: "settings.section.companionVoice",
  navOrder: 45,

  async getPreview() {
    const voice = getCurrentVoice();
    const short = voice.split("-").pop().replace(/Neural$/, "").replace(/Multilingual$/, "");
    return short;
  },

  async render({ req, db }) {
    const currentVoice = getCurrentVoice();
    const savedProfile = getCurrentAiProfile();
    const currentModel = getCurrentAiModel();
    const env = readBundleEnv();
    const customVoice = env.COMPANION_TTS_VOICE_CUSTOM || "";
    const profiles = await getAiProfiles(db);

    // Check if saved profile still exists (may have been deleted from AI Profiles)
    const profileSlugs = profiles.map(p => p.name.toLowerCase().replace(/\s+/g, "_").replace(/\./g, "_"));
    const currentProfile = (savedProfile && profileSlugs.includes(savedProfile)) ? savedProfile : "";
    const profileStale = savedProfile && !currentProfile;

    let html = `<form method="POST">
      <input type="hidden" name="action" value="update_companion_settings">

      <div style="margin-bottom:1.5rem">
        <label style="display:block;font-size:0.8rem;color:var(--crow-text-muted);margin-bottom:8px;font-weight:500">
          AI Provider
        </label>${profileStale ? `
        <p style="font-size:0.8rem;color:var(--crow-error);margin:0 0 12px;padding:8px 12px;border:1px solid var(--crow-error);border-radius:6px;background:rgba(239,68,68,0.1)">
          Previously selected profile "${savedProfile}" no longer exists. Falling back to Auto.
        </p>` : ""}
        <p style="font-size:0.75rem;color:var(--crow-text-muted);margin:0 0 12px">
          Choose which AI profile powers voice chat. Avatar selection is in the companion's character menu.
        </p>`;

    if (profiles.length === 0) {
      html += `<p style="font-size:0.85rem;color:var(--crow-text-muted);padding:12px;border:1px solid var(--crow-border);border-radius:8px;background:var(--crow-bg-elevated)">
          No AI profiles configured. <a href="?section=ai-profiles" style="color:var(--crow-accent)">Add one in AI Profiles</a> first.
        </p>`;
    } else {
      // Auto-detect (let generate-config.py pick the best one)
      const autoChecked = !currentProfile ? " checked" : "";
      html += `<label style="display:flex;align-items:center;gap:8px;padding:10px 14px;border:1px solid var(--crow-border);border-radius:8px;cursor:pointer;font-size:0.85rem;margin-bottom:8px;background:${!currentProfile ? "var(--crow-bg-elevated)" : "transparent"}">
        <input type="radio" name="ai_profile" value=""${autoChecked} style="accent-color:var(--crow-accent);width:auto;margin:0">
        <div>
          <div style="font-weight:500">Auto (recommended)</div>
          <div style="font-size:0.75rem;color:var(--crow-text-muted)">Prefers local models for low latency, falls back to cloud</div>
        </div>
      </label>`;

      for (const p of profiles) {
        const slug = p.name.toLowerCase().replace(/\s+/g, "_").replace(/\./g, "_");
        const checked = slug === currentProfile ? " checked" : "";
        const isLocal = /localhost|127\.0\.0\.1|172\.17/.test(p.baseUrl || "");
        const badge = isLocal ? "Local" : "Cloud";
        const badgeColor = isLocal ? "var(--crow-success)" : "var(--crow-accent)";
        const modelCount = (p.models || []).length;
        html += `<label style="display:flex;align-items:center;gap:8px;padding:10px 14px;border:1px solid var(--crow-border);border-radius:8px;cursor:pointer;font-size:0.85rem;margin-bottom:8px;background:${slug === currentProfile ? "var(--crow-bg-elevated)" : "transparent"}">
          <input type="radio" name="ai_profile" value="${slug}"${checked} style="accent-color:var(--crow-accent);width:auto;margin:0">
          <div style="flex:1">
            <div style="font-weight:500;display:flex;align-items:center;gap:6px">
              ${p.name}
              <span style="font-size:0.65rem;padding:2px 6px;border-radius:4px;background:${badgeColor};color:#fff;font-weight:600">${badge}</span>
            </div>
            <div style="font-size:0.75rem;color:var(--crow-text-muted)">${modelCount} model${modelCount !== 1 ? "s" : ""}</div>
          </div>
        </label>`;

        // Model selector (shown when this profile is selected)
        if (modelCount > 1) {
          const defaultModel = p.defaultModel || p.models[0];
          html += `<div class="profile-models" data-profile="${slug}" style="margin:-4px 0 8px 28px;padding:8px 14px;border:1px solid var(--crow-border);border-radius:8px;display:${slug === currentProfile ? "block" : "none"}">`;
          for (const m of p.models) {
            const mChecked = (slug === currentProfile && currentModel === m) ? " checked" : (slug === currentProfile && !currentModel && m === defaultModel) ? " checked" : "";
            const shortName = m.length > 40 ? m.substring(0, 37) + "..." : m;
            html += `<label style="display:flex;align-items:center;gap:6px;padding:4px 0;cursor:pointer;font-size:0.8rem">
              <input type="radio" name="ai_model_${slug}" value="${m}"${mChecked} style="accent-color:var(--crow-accent);width:auto;margin:0">
              <span>${shortName}</span>
              ${m === defaultModel ? '<span style="font-size:0.65rem;color:var(--crow-text-muted)">(default)</span>' : ""}
            </label>`;
          }
          html += `</div>`;
        }
      }
    }

    html += `</div>

      <div style="margin-bottom:1.5rem">
        <label style="display:block;font-size:0.8rem;color:var(--crow-text-muted);margin-bottom:8px;font-weight:500">
          Household Profiles
        </label>
        <p style="font-size:0.75rem;color:var(--crow-text-muted);margin:0 0 12px">
          Define profiles so each person picks their name, avatar, and voice from the character selector. When profiles are set, the companion auto-groups all connections into one room.
        </p>`;

    const hProfiles = getHouseholdProfiles();
    for (let i = 1; i <= 4; i++) {
      const p = hProfiles.find(hp => hp.index === i);
      const name = p ? p.name : "";
      const avatar = p ? p.avatar : "";
      const voice = p ? p.voice : "";
      const num = i;
      const borderColor = name ? "var(--crow-accent)" : "var(--crow-border)";
      html += `<details style="margin-bottom:8px;border:1px solid ${borderColor};border-radius:8px;overflow:hidden"${name ? " open" : ""}>
        <summary style="padding:10px 14px;cursor:pointer;font-size:0.85rem;font-weight:500;background:var(--crow-bg-elevated)">
          ${name ? name : `Profile ${num} (empty)`}
        </summary>
        <div style="padding:12px 14px;display:flex;flex-direction:column;gap:8px">
          <div>
            <label style="font-size:0.75rem;color:var(--crow-text-muted)">Name</label>
            <input type="text" name="profile_${num}_name" value="${name}" placeholder="e.g. Alex"
              style="width:100%;padding:6px 10px;border:1px solid var(--crow-border);border-radius:6px;background:var(--crow-bg);color:var(--crow-text);font-size:0.85rem;box-sizing:border-box">
          </div>
          <div>
            <label style="font-size:0.75rem;color:var(--crow-text-muted)">Avatar ID</label>
            <input type="text" name="profile_${num}_avatar" value="${avatar}" placeholder="e.g. Cha_AnnoyingParrot, senko, mao_pro"
              style="width:100%;padding:6px 10px;border:1px solid var(--crow-border);border-radius:6px;background:var(--crow-bg);color:var(--crow-text);font-size:0.85rem;box-sizing:border-box">
          </div>
          <div>
            <label style="font-size:0.75rem;color:var(--crow-text-muted)">TTS Voice</label>
            <input type="text" name="profile_${num}_voice" value="${voice}" placeholder="e.g. en-US-AvaMultilingualNeural"
              style="width:100%;padding:6px 10px;border:1px solid var(--crow-border);border-radius:6px;background:var(--crow-bg);color:var(--crow-text);font-size:0.85rem;box-sizing:border-box">
          </div>
        </div>
      </details>`;
    }

    html += `</div>

      <div style="margin-bottom:1.5rem">
        <label style="display:block;font-size:0.8rem;color:var(--crow-text-muted);margin-bottom:8px;font-weight:500">
          TTS Voice
        </label>
        <p style="font-size:0.8rem;color:var(--crow-text-muted);margin:0 0 12px">
          Current: <strong style="color:var(--crow-text)">${currentVoice}</strong>
        </p>`;

    for (const group of VOICE_GROUPS) {
      html += `<details style="margin-bottom:8px;border:1px solid var(--crow-border);border-radius:8px;overflow:hidden"${group.lang === "en-US" ? " open" : ""}>
        <summary style="padding:10px 14px;cursor:pointer;font-size:0.85rem;font-weight:500;background:var(--crow-bg-elevated)">${group.label}</summary>
        <div style="padding:8px 14px">`;

      for (const v of group.voices) {
        const checked = v.n === currentVoice ? " checked" : "";
        const genderIcon = v.g === "F" ? "&#9792;" : "&#9794;";
        const genderColor = v.g === "F" ? "#e879a0" : "#79b8e8";
        const shortName = v.n.split("-").pop().replace(/Neural$/, "").replace(/Multilingual/, " ML");
        html += `<label style="display:flex;align-items:center;gap:8px;padding:6px 0;cursor:pointer;font-size:0.85rem;border-bottom:1px solid var(--crow-border-subtle, rgba(255,255,255,0.05))">
          <input type="radio" name="voice" value="${v.n}"${checked} style="accent-color:var(--crow-accent);width:auto;margin:0">
          <span style="color:${genderColor};font-size:1rem">${genderIcon}</span>
          <span style="font-weight:500">${shortName}</span>
          <span style="color:var(--crow-text-muted);font-size:0.75rem;margin-left:auto">${v.p}</span>
        </label>`;
      }
      html += `</div></details>`;
    }

    // Custom voice input
    html += `<details style="margin-bottom:8px;border:1px solid var(--crow-border);border-radius:8px;overflow:hidden">
      <summary style="padding:10px 14px;cursor:pointer;font-size:0.85rem;font-weight:500;background:var(--crow-bg-elevated)">Custom Voice Name</summary>
      <div style="padding:12px 14px">
        <p style="font-size:0.75rem;color:var(--crow-text-muted);margin:0 0 8px">
          Enter any Edge TTS voice name (run <code>edge-tts --list-voices</code> for full list of 320+ voices)
        </p>
        <input type="text" name="custom_voice" value="${customVoice}" placeholder="e.g. en-IN-NeerjaExpressiveNeural"
          style="width:100%;padding:8px 12px;border:1px solid var(--crow-border);border-radius:6px;background:var(--crow-bg);color:var(--crow-text);font-size:0.85rem;box-sizing:border-box">
        <label style="display:flex;align-items:center;gap:6px;margin-top:8px;font-size:0.8rem;cursor:pointer">
          <input type="radio" name="voice" value="__custom__"${!VOICE_GROUPS.some(g => g.voices.some(v => v.n === currentVoice)) ? " checked" : ""} style="accent-color:var(--crow-accent);width:auto;margin:0">
          Use custom voice
        </label>
      </div>
    </details></div>`;

    html += `<div style="margin-top:1.5rem;display:flex;gap:10px">
        <button type="submit" style="padding:10px 24px;background:var(--crow-accent);color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:0.85rem;font-weight:500">
          Save & Restart Companion
        </button>
      </div>
    </form>
    <script>
      // Show/hide model selectors based on selected profile
      document.querySelectorAll('input[name="ai_profile"]').forEach(function(r) {
        r.addEventListener('change', function() {
          document.querySelectorAll('.profile-models').forEach(function(d) { d.style.display = 'none'; });
          var sel = document.querySelector('.profile-models[data-profile="' + r.value + '"]');
          if (sel) sel.style.display = 'block';
        });
      });
    <\/script>`;

    return html;
  },

  async handleAction({ req, res }) {
    const { action, voice, custom_voice, ai_profile } = req.body;

    if (action !== "update_companion_settings") return false;

    const env = readBundleEnv();

    // Household profiles
    for (let i = 1; i <= 4; i++) {
      const name = (req.body[`profile_${i}_name`] || "").trim();
      const avatar = (req.body[`profile_${i}_avatar`] || "").trim();
      const voice = (req.body[`profile_${i}_voice`] || "").trim();
      if (name) {
        env[`COMPANION_PROFILE_${i}_NAME`] = name;
        if (avatar) env[`COMPANION_PROFILE_${i}_AVATAR`] = avatar;
        if (voice) env[`COMPANION_PROFILE_${i}_VOICE`] = voice;
      } else {
        delete env[`COMPANION_PROFILE_${i}_NAME`];
        delete env[`COMPANION_PROFILE_${i}_AVATAR`];
        delete env[`COMPANION_PROFILE_${i}_VOICE`];
      }
    }

    // AI profile
    if (ai_profile !== undefined) {
      if (ai_profile) {
        env.COMPANION_AI_PROFILE = ai_profile;
        // Check for model override
        const modelKey = `ai_model_${ai_profile}`;
        if (req.body[modelKey]) {
          env.COMPANION_AI_MODEL = req.body[modelKey];
        } else {
          delete env.COMPANION_AI_MODEL;
        }
      } else {
        // Auto mode
        delete env.COMPANION_AI_PROFILE;
        delete env.COMPANION_AI_MODEL;
      }
    }

    // Determine voice
    let selectedVoice;
    if (voice === "__custom__" && custom_voice?.trim()) {
      selectedVoice = custom_voice.trim();
      env.COMPANION_TTS_VOICE_CUSTOM = custom_voice.trim();
    } else if (voice && voice !== "__custom__") {
      selectedVoice = voice;
    }

    if (selectedVoice) {
      env.COMPANION_TTS_VOICE = selectedVoice;
    }

    writeBundleEnv(env);

    // Recreate the companion container to pick up new env vars
    try {
      execFileSync("docker", ["compose", "up", "-d", "--no-build", "--force-recreate"], {
        cwd: BUNDLE_DIR,
        timeout: 60000,
        stdio: "pipe",
      });
    } catch { /* best effort */ }

    res.redirect("?section=companion-voice");
    return true;
  },
};
