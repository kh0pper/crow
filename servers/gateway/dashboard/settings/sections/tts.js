/**
 * Settings Section: Text-to-Speech
 *
 * Crow-wide TTS voice configuration. Used by media TTS, briefings,
 * and any future TTS consumers.
 */

import { formField } from "../../shared/components.js";
import { t } from "../../shared/i18n.js";
import { upsertSetting } from "../registry.js";

const DEFAULT_VOICE = "en-US-BrianNeural";

const VOICE_OPTIONS = [
  { value: "en-US-BrianNeural", label: "Brian (US)" },
  { value: "en-US-AriaNeural", label: "Aria (US)" },
  { value: "en-US-JennyNeural", label: "Jenny (US)" },
  { value: "en-US-GuyNeural", label: "Guy (US)" },
  { value: "en-US-AndrewNeural", label: "Andrew (US)" },
  { value: "en-US-EmmaNeural", label: "Emma (US)" },
  { value: "en-GB-SoniaNeural", label: "Sonia (UK)" },
  { value: "en-GB-RyanNeural", label: "Ryan (UK)" },
  { value: "en-AU-NatashaNeural", label: "Natasha (AU)" },
  { value: "__custom__", label: "Custom voice ID..." },
];

const VOICE_PATTERN = /^[a-z]{2}-[A-Z]{2,4}-[\w:]+$/;

function voiceLabel(voiceId) {
  const opt = VOICE_OPTIONS.find((o) => o.value === voiceId);
  return opt ? opt.label : voiceId || "Brian (US)";
}

export default {
  id: "tts",
  group: "general",
  icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>`,
  labelKey: "settings.section.tts",
  navOrder: 30,

  async getPreview({ settings }) {
    return voiceLabel(settings.tts_voice);
  },

  async render({ req, db, lang }) {
    const result = await db.execute({
      sql: "SELECT value FROM dashboard_settings WHERE key = 'tts_voice'",
      args: [],
    });
    const currentVoice = result.rows[0]?.value || DEFAULT_VOICE;
    const isCustom = !VOICE_OPTIONS.some((o) => o.value === currentVoice && o.value !== "__custom__");

    const selectValue = isCustom ? "__custom__" : currentVoice;

    return `<form method="POST">
      <input type="hidden" name="action" value="set_tts_voice">
      ${formField(t("settings.ttsVoice", lang), "tts_voice_select", {
        type: "select",
        value: selectValue,
        options: VOICE_OPTIONS,
      })}
      <div id="custom-voice-row" style="margin-top:0.5rem;${isCustom ? "" : "display:none"}">
        ${formField(t("settings.ttsCustomVoice", lang), "tts_voice_custom", {
          type: "text",
          value: isCustom ? currentVoice : "",
        })}
        <p style="font-size:0.75rem;color:var(--crow-text-muted);margin-top:0.25rem">
          Enter any <a href="https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support?tabs=tts" target="_blank" style="color:var(--crow-accent)">Microsoft neural voice ID</a> (e.g., es-MX-DaliaNeural)
        </p>
      </div>
      <button type="submit" class="btn btn-secondary" style="margin-top:0.75rem">${t("settings.save", lang)}</button>
    </form>
    <script>
      (function() {
        var sel = document.querySelector('[name="tts_voice_select"]');
        var row = document.getElementById('custom-voice-row');
        if (sel && row) {
          sel.addEventListener('change', function() {
            row.style.display = sel.value === '__custom__' ? '' : 'none';
          });
        }
      })();
    </script>`;
  },

  async handleAction({ req, res, db, action }) {
    if (action !== "set_tts_voice") return false;

    let voice = req.body.tts_voice_select;
    if (voice === "__custom__") {
      voice = (req.body.tts_voice_custom || "").trim();
      if (!voice || voice.length > 100 || !VOICE_PATTERN.test(voice)) {
        res.redirect("/dashboard/settings?section=tts&error=invalid_voice");
        return true;
      }
    }

    await upsertSetting(db, "tts_voice", voice);
    res.redirect("/dashboard/settings?section=tts");
    return true;
  },
};
