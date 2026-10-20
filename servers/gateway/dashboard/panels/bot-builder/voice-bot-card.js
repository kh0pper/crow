/**
 * Bot Builder — Crow's card (PR 1). The reserved voice bot (crow.voice)
 * answers every voice surface, so it is no ordinary bot: its card comes first
 * in the list, carries a "Voice" chip, its model and what it can do by voice,
 * and one button, Customise, to its own editor (voice-bot-editor.js). It has
 * no ⋯ menu: Crow cannot be deleted, given a board or a card, or "used for
 * voice" (it already is). Empty fields are left out, never dashed.
 */
import { escapeHtml } from "../../shared/components.js";
import { t } from "../../shared/i18n.js";
import { friendlyModel } from "../../shared/bot-display.js";
import { CROW_VOICE_BOT_ID, normalizeVoiceSettings } from "../../../../shared/voice-bot.js";
import { abilityLineHtml } from "./voice-use.js";

export const VOICE_EDITOR_HREF = `/dashboard/bot-builder?bot=${encodeURIComponent(CROW_VOICE_BOT_ID)}`;

/**
 * @param row  the pi_bot_defs row (bot_id, display_name, enabled, definition)
 * @param opts { lang, req, providerRows, kioskAvailable } — kioskAvailable adds the
 *             abilities line (voice-use.js fills it from the Kiosk listing).
 */
export function voiceBotCardHtml(row, { lang = "en", req = null, providerRows = [], kioskAvailable = false } = {}) {
  void req;   // the card has no form (no CSRF token needed)
  let def = {};
  try { def = JSON.parse(row.definition || "{}") || {}; } catch { def = {}; }
  const name = row.display_name || "Crow";
  const modelKey = normalizeVoiceSettings(def).fast_voice_model || "";
  const model = friendlyModel(modelKey, providerRows);
  const on = Number(row.enabled) === 1;
  const dot = on ? ["on", t("botbuilder.dotOn", lang)] : ["off", t("botbuilder.dotOff", lang)];
  const initial = (Array.from(String(name).trim())[0] || "C").toUpperCase();
  const meta = [
    `<span class="btb-vchip">${escapeHtml(t("botbuilder.voiceChip", lang))}</span>`,
    model ? `<span class="btb-mchip" title="${escapeHtml(modelKey)}">${escapeHtml(model)}</span>` : "",
  ].filter(Boolean).join("");
  return `<div class="btb-botcard btb-botcard-voice" role="listitem" data-bot="${escapeHtml(CROW_VOICE_BOT_ID)}">` +
    `<div class="btb-botcard-top"><span class="btb-av btb-av-l btb-hue-0" aria-hidden="true">${escapeHtml(initial)}</span>` +
    `<div class="btb-botcard-tm">` +
    `<div class="btb-botcard-name"><span title="${escapeHtml(CROW_VOICE_BOT_ID)}">${escapeHtml(name)}</span>` +
    `<span class="btb-dot btb-dot-${dot[0]}" role="img" aria-label="${escapeHtml(dot[1])}" title="${escapeHtml(dot[1])}"></span></div>` +
    `<div class="btb-botcard-purpose">${escapeHtml(t("botbuilder.voiceCardPurpose", lang))}</div>` +
    `</div></div>` +
    `<div class="btb-botcard-meta">${meta}</div>` +
    (kioskAvailable ? abilityLineHtml(CROW_VOICE_BOT_ID) : "") +
    `<div class="btb-botcard-foot">` +
    `<a class="btn btn-primary btn-sm" href="${VOICE_EDITOR_HREF}">${escapeHtml(t("botbuilder.voiceCustomise", lang))}</a>` +
    `</div></div>`;
}
