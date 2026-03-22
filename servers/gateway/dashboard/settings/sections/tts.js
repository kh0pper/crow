/**
 * Settings Section: Text-to-Speech
 *
 * Crow-wide TTS voice configuration with a browsable voice catalog.
 * Fetches all available voices from Microsoft's Edge TTS API,
 * organized by language with search, gender filter, and preview.
 */

import { escapeHtml } from "../../shared/components.js";
import { t } from "../../shared/i18n.js";
import { upsertSetting } from "../registry.js";

const DEFAULT_VOICE = "en-US-BrianNeural";
const VOICE_LIST_URL = "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const VOICE_PATTERN = /^[a-z]{2,3}-[A-Z]{2,4}(-[a-z]+)?-[\w:]+$/;

// Cache voice list in memory (refreshed on gateway restart)
let _voiceCache = null;
let _voiceCacheTime = 0;
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24h

// Locale display names
const LOCALE_NAMES = {
  "af-ZA": "Afrikaans", "am-ET": "Amharic", "ar-AE": "Arabic (UAE)", "ar-EG": "Arabic (Egypt)",
  "ar-SA": "Arabic (Saudi Arabia)", "az-AZ": "Azerbaijani", "bg-BG": "Bulgarian", "bn-BD": "Bangla (Bangladesh)",
  "bn-IN": "Bangla (India)", "bs-BA": "Bosnian", "ca-ES": "Catalan", "cs-CZ": "Czech",
  "cy-GB": "Welsh", "da-DK": "Danish", "de-AT": "German (Austria)", "de-CH": "German (Switzerland)",
  "de-DE": "German (Germany)", "el-GR": "Greek", "en-AU": "English (Australia)", "en-CA": "English (Canada)",
  "en-GB": "English (UK)", "en-HK": "English (Hong Kong)", "en-IE": "English (Ireland)",
  "en-IN": "English (India)", "en-KE": "English (Kenya)", "en-NG": "English (Nigeria)",
  "en-NZ": "English (New Zealand)", "en-PH": "English (Philippines)", "en-SG": "English (Singapore)",
  "en-US": "English (US)", "en-ZA": "English (South Africa)",
  "es-AR": "Spanish (Argentina)", "es-BO": "Spanish (Bolivia)", "es-CL": "Spanish (Chile)",
  "es-CO": "Spanish (Colombia)", "es-CR": "Spanish (Costa Rica)", "es-CU": "Spanish (Cuba)",
  "es-DO": "Spanish (Dominican Republic)", "es-EC": "Spanish (Ecuador)", "es-ES": "Spanish (Spain)",
  "es-GQ": "Spanish (Equatorial Guinea)", "es-GT": "Spanish (Guatemala)", "es-HN": "Spanish (Honduras)",
  "es-MX": "Spanish (Mexico)", "es-NI": "Spanish (Nicaragua)", "es-PA": "Spanish (Panama)",
  "es-PE": "Spanish (Peru)", "es-PR": "Spanish (Puerto Rico)", "es-PY": "Spanish (Paraguay)",
  "es-SV": "Spanish (El Salvador)", "es-US": "Spanish (US)", "es-UY": "Spanish (Uruguay)",
  "es-VE": "Spanish (Venezuela)", "et-EE": "Estonian", "fa-IR": "Persian", "fi-FI": "Finnish",
  "fil-PH": "Filipino", "fr-BE": "French (Belgium)", "fr-CA": "French (Canada)",
  "fr-CH": "French (Switzerland)", "fr-FR": "French (France)", "ga-IE": "Irish",
  "gl-ES": "Galician", "gu-IN": "Gujarati", "he-IL": "Hebrew", "hi-IN": "Hindi",
  "hr-HR": "Croatian", "hu-HU": "Hungarian", "id-ID": "Indonesian", "is-IS": "Icelandic",
  "it-IT": "Italian", "ja-JP": "Japanese", "jv-ID": "Javanese", "ka-GE": "Georgian",
  "kk-KZ": "Kazakh", "km-KH": "Khmer", "kn-IN": "Kannada", "ko-KR": "Korean",
  "lo-LA": "Lao", "lt-LT": "Lithuanian", "lv-LV": "Latvian", "mk-MK": "Macedonian",
  "ml-IN": "Malayalam", "mn-MN": "Mongolian", "mr-IN": "Marathi", "ms-MY": "Malay",
  "mt-MT": "Maltese", "my-MM": "Myanmar", "nb-NO": "Norwegian", "ne-NP": "Nepali",
  "nl-BE": "Dutch (Belgium)", "nl-NL": "Dutch (Netherlands)", "pl-PL": "Polish",
  "ps-AF": "Pashto", "pt-BR": "Portuguese (Brazil)", "pt-PT": "Portuguese (Portugal)",
  "ro-RO": "Romanian", "ru-RU": "Russian", "si-LK": "Sinhala", "sk-SK": "Slovak",
  "sl-SI": "Slovenian", "so-SO": "Somali", "sq-AL": "Albanian", "sr-RS": "Serbian",
  "su-ID": "Sundanese", "sv-SE": "Swedish", "sw-KE": "Swahili (Kenya)",
  "sw-TZ": "Swahili (Tanzania)", "ta-IN": "Tamil (India)", "ta-LK": "Tamil (Sri Lanka)",
  "ta-MY": "Tamil (Malaysia)", "ta-SG": "Tamil (Singapore)", "te-IN": "Telugu",
  "th-TH": "Thai", "tr-TR": "Turkish", "uk-UA": "Ukrainian", "ur-IN": "Urdu (India)",
  "ur-PK": "Urdu (Pakistan)", "uz-UZ": "Uzbek", "vi-VN": "Vietnamese",
  "zh-CN": "Chinese (Mandarin)", "zh-HK": "Chinese (Cantonese)", "zh-TW": "Chinese (Taiwanese)",
  "zu-ZA": "Zulu",
};

async function fetchVoices() {
  if (_voiceCache && Date.now() - _voiceCacheTime < CACHE_TTL) return _voiceCache;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const resp = await fetch(VOICE_LIST_URL, { signal: controller.signal });
    clearTimeout(timeout);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    _voiceCache = await resp.json();
    _voiceCacheTime = Date.now();
    return _voiceCache;
  } catch {
    return _voiceCache || [];
  }
}

function voiceDisplayName(shortName) {
  const parts = shortName.split("-");
  return parts.slice(2).join("-").replace("Neural", "").replace("Multilingual", " (Multilingual)") || shortName;
}

function localeName(locale) {
  return LOCALE_NAMES[locale] || locale;
}

export default {
  id: "tts",
  group: "general",
  icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>`,
  labelKey: "settings.section.tts",
  navOrder: 30,

  async getPreview({ settings }) {
    const voice = settings.tts_voice || DEFAULT_VOICE;
    const name = voiceDisplayName(voice);
    const locale = voice.split("-").slice(0, 2).join("-");
    return `${name} (${locale})`;
  },

  async render({ req, db, lang }) {
    const result = await db.execute({
      sql: "SELECT value FROM dashboard_settings WHERE key = 'tts_voice'",
      args: [],
    });
    const currentVoice = result.rows[0]?.value || DEFAULT_VOICE;

    const voices = await fetchVoices();

    // Group by language
    const byLang = {};
    for (const v of voices) {
      const locale = v.Locale || v.ShortName.split("-").slice(0, 2).join("-");
      if (!byLang[locale]) byLang[locale] = [];
      byLang[locale].push(v);
    }

    // Sort: current voice language first, then English, Spanish, then alphabetical
    const currentLocale = currentVoice.split("-").slice(0, 2).join("-");
    const sortedLocales = Object.keys(byLang).sort((a, b) => {
      if (a === currentLocale) return -1;
      if (b === currentLocale) return 1;
      const aLang = a.split("-")[0];
      const bLang = b.split("-")[0];
      if (aLang === "en" && bLang !== "en") return -1;
      if (bLang === "en" && aLang !== "en") return 1;
      if (aLang === "es" && bLang !== "es") return -1;
      if (bLang === "es" && aLang !== "es") return 1;
      return localeName(a).localeCompare(localeName(b));
    });

    // Build voice data as JSON for client-side rendering
    const voiceData = sortedLocales.map(locale => ({
      locale,
      label: localeName(locale),
      voices: byLang[locale].map(v => ({
        id: v.ShortName,
        name: voiceDisplayName(v.ShortName),
        gender: v.Gender,
        personalities: v.VoiceTag?.VoicePersonalities || [],
      })).sort((a, b) => a.name.localeCompare(b.name)),
    }));

    // Server-render the voice list as static HTML (no innerHTML needed)
    let listHtml = "";
    for (const group of voiceData) {
      listHtml += `<div class="tts-lang-header" data-locale="${escapeHtml(group.locale)}" style="padding:0.4rem 0.75rem;background:var(--crow-bg-deep);border-bottom:1px solid var(--crow-border);position:sticky;top:0;z-index:1">`;
      listHtml += `<strong style="font-size:0.8rem;color:var(--crow-text-secondary)">${escapeHtml(group.label)}</strong>`;
      listHtml += ` <span style="font-size:0.7rem;color:var(--crow-text-muted)">(${group.voices.length})</span></div>`;

      for (const v of group.voices) {
        const isActive = v.id === currentVoice;
        const bg = isActive ? "var(--crow-accent-muted)" : "transparent";
        const gIcon = v.gender === "Female" ? "\u2640" : "\u2642";
        const gColor = v.gender === "Female" ? "#e879a0" : "#79b8e8";
        const tags = v.personalities.slice(0, 3).map(p =>
          `<span style="font-size:0.65rem;padding:0.1rem 0.35rem;background:var(--crow-bg-deep);border-radius:3px;color:var(--crow-text-muted)">${escapeHtml(p)}</span>`
        ).join(" ");

        listHtml += `<div class="tts-voice-row" data-voice="${escapeHtml(v.id)}" data-name="${escapeHtml(v.name)}" data-gender="${escapeHtml(v.gender)}" data-locale="${escapeHtml(group.locale)}" style="display:flex;align-items:center;gap:0.5rem;padding:0.5rem 0.75rem;cursor:pointer;border-bottom:1px solid var(--crow-border);background:${bg}">`;
        listHtml += `<span style="color:${gColor};font-size:0.9rem;width:1.2rem;text-align:center">${gIcon}</span>`;
        listHtml += `<div style="flex:1;min-width:0">`;
        listHtml += `<div style="font-size:0.85rem;color:var(--crow-text-primary)">${escapeHtml(v.name)}</div>`;
        listHtml += `<div style="font-size:0.7rem;color:var(--crow-text-muted);display:flex;gap:0.3rem;align-items:center;flex-wrap:wrap">${escapeHtml(v.id)} ${tags}</div>`;
        listHtml += `</div>`;
        if (isActive) listHtml += `<span style="color:var(--crow-accent);font-size:0.85rem">\u2713</span>`;
        listHtml += `</div>`;
      }
    }

    return `
      <form method="POST" id="tts-form">
        <input type="hidden" name="action" value="set_tts_voice">
        <input type="hidden" name="tts_voice" id="tts-voice-input" value="${escapeHtml(currentVoice)}">
      </form>

      <div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:1rem;flex-wrap:wrap">
        <div style="flex:1;min-width:200px">
          <input type="text" id="tts-search" placeholder="${t("settings.ttsSearchVoices", lang)}"
            style="width:100%;padding:0.5rem 0.75rem;background:var(--crow-bg-deep);border:1px solid var(--crow-border);border-radius:var(--crow-radius-pill);color:var(--crow-text-primary);font-size:0.85rem">
        </div>
        <select id="tts-gender-filter" style="padding:0.5rem;background:var(--crow-bg-deep);border:1px solid var(--crow-border);border-radius:var(--crow-radius-pill);color:var(--crow-text-primary);font-size:0.85rem">
          <option value="all">${t("settings.ttsAllGenders", lang)}</option>
          <option value="Female">${t("settings.ttsFemale", lang)}</option>
          <option value="Male">${t("settings.ttsMale", lang)}</option>
        </select>
      </div>

      <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:1rem;padding:0.6rem 0.75rem;background:var(--crow-bg-elevated);border-radius:var(--crow-radius-pill);border:1px solid var(--crow-accent-muted)">
        <span style="font-size:0.8rem;color:var(--crow-text-muted)">${t("settings.ttsCurrentVoice", lang)}:</span>
        <strong id="tts-current-label" style="font-size:0.9rem;color:var(--crow-text-primary)">${escapeHtml(voiceDisplayName(currentVoice))}</strong>
        <span style="font-size:0.75rem;color:var(--crow-text-muted)" id="tts-current-id">${escapeHtml(currentVoice)}</span>
      </div>

      <div id="tts-voice-list" style="max-height:55vh;overflow-y:auto;border:1px solid var(--crow-border);border-radius:var(--crow-radius-card)">${listHtml}</div>

      <script>
      (function() {
        var listEl = document.getElementById('tts-voice-list');
        var searchEl = document.getElementById('tts-search');
        var genderEl = document.getElementById('tts-gender-filter');
        var hiddenInput = document.getElementById('tts-voice-input');
        var form = document.getElementById('tts-form');
        var rows = listEl.querySelectorAll('.tts-voice-row');
        var headers = listEl.querySelectorAll('.tts-lang-header');

        function applyFilter() {
          var query = (searchEl.value || '').toLowerCase();
          var gender = genderEl.value;
          var visibleLocales = new Set();

          rows.forEach(function(row) {
            var show = true;
            if (gender !== 'all' && row.dataset.gender !== gender) show = false;
            if (query) {
              var hay = (row.dataset.name + ' ' + row.dataset.voice + ' ' + row.dataset.locale).toLowerCase();
              if (hay.indexOf(query) === -1) show = false;
            }
            row.style.display = show ? '' : 'none';
            if (show) visibleLocales.add(row.dataset.locale);
          });

          headers.forEach(function(h) {
            h.style.display = visibleLocales.has(h.dataset.locale) ? '' : 'none';
          });
        }

        rows.forEach(function(row) {
          row.addEventListener('click', function() {
            hiddenInput.value = row.dataset.voice;
            form.submit();
          });
          row.addEventListener('mouseover', function() {
            if (row.querySelector('span[style*="accent"]')) return;
            row.style.background = 'var(--crow-bg-elevated)';
          });
          row.addEventListener('mouseout', function() {
            if (row.querySelector('span[style*="accent"]')) return;
            row.style.background = 'transparent';
          });
        });

        searchEl.addEventListener('input', applyFilter);
        genderEl.addEventListener('change', applyFilter);
      })();
      </script>`;
  },

  async handleAction({ req, res, db, action }) {
    if (action !== "set_tts_voice") return false;

    const voice = (req.body.tts_voice || "").trim();
    if (!voice || voice.length > 100 || !VOICE_PATTERN.test(voice)) {
      res.redirect("/dashboard/settings?section=tts&error=invalid_voice");
      return true;
    }

    await upsertSetting(db, "tts_voice", voice);
    res.redirect("/dashboard/settings?section=tts");
    return true;
  },
};
