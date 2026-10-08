/**
 * Bot Builder — Basics tab: name, persona, models, and ONE channel picker.
 *
 * Every channel's fields are rendered, each in its own
 * <fieldset data-channel=…>; only the saved channel's fieldset is enabled.
 * Disabled fieldsets never submit, so same-named inputs of other channels
 * (gw_token, gw_allowlist, gw_device_id …) cannot leak into a save. A small
 * ES5 script swaps the fieldsets when the picker changes — the form is never
 * auto-submitted. Without JS the saved channel's fields show and a changed
 * type saves as a type-only draft (the long-standing W1-4 behaviour).
 *
 * Inline script rule (panel convention): no literal backtick anywhere in the
 * emitted script, ES5 only.
 */
import { escapeHtml, actionBar } from "../../shared/components.js";
import { csrfInput } from "../../shared/csrf.js";
import { t, fill } from "../../shared/i18n.js";
import { getTtsProfiles } from "../../../ai/tts/index.js";
import { getSttProfiles } from "../../../ai/stt/index.js";
import { loadModelOptions, loadVisionProfiles } from "./data-queries.js";
import { renderGatewayFields, engineGateRequiredDomFields } from "./gateway-fields.js";
import { ENGINE_CHANNELS } from "../../../bot-engine-status.js";
import { isEngineAbsent } from "./engine-gate.js";
import { card } from "./ui.js";

export const CHANNEL_TYPES = ["gmail", "discord", "telegram", "slack", "glasses", "companion", "crow-messages", "perch", "none"];

function modelOptions(byProv, sel, lang) {
  // A stored model this Crow no longer offers stays selected (and saved) as
  // itself — a save never quietly switches or drops a model.
  const known = Object.values(byProv).some((list) => list.some((m) => m.key === sel));
  const missing = sel && !known
    ? `<option value="${escapeHtml(sel)}" selected>${escapeHtml(fill(t("botbuilder.bxModelMissing", lang), { key: sel }))}</option>` : "";
  return missing + Object.keys(byProv).map((p) =>
    `<optgroup label="${escapeHtml(p)}">` +
    byProv[p].map((m) =>
      `<option value="${escapeHtml(m.key)}"${m.key === sel ? " selected" : ""}>${escapeHtml(m.label)}` +
      `${m.piKnown === false ? " (" + escapeHtml(t("botbuilder.modelNotInEngine", lang)) + ")" : ""}</option>`).join("") +
    `</optgroup>`).join("");
}

async function deviceOptions(db, botId, selId, lang, { markGlasses = false } = {}) {
  let devices = [];
  try {
    const { listDevices } = await import("../../../../shared/device-store.js");
    devices = (await listDevices(db).catch(() => [])).filter((d) => d.device_kind !== "kiosk");
  } catch { devices = []; }
  const opts = `<option value="">${escapeHtml(t("botbuilder.bxSelectDevice", lang))}</option>` +
    devices.map((d) => {
      const boundElse = d.bound_bot_id && d.bound_bot_id !== botId
        ? ` — ${escapeHtml(fill(t("botbuilder.bxBoundTo", lang), { bot: d.bound_bot_id }))}` : "";
      const kind = markGlasses && (d.device_kind || "glasses") !== "companion" ? ` [${escapeHtml(t("botbuilder.bxGlassesTag", lang))}]` : "";
      return `<option value="${escapeHtml(String(d.id))}"${String(d.id) === String(selId || "") ? " selected" : ""}>` +
        `${escapeHtml(d.name || String(d.id))}${kind}${boundElse}</option>`;
    }).join("") +
    // A saved device this Crow no longer lists stays selected (and saved)
    // until the operator picks another — never silently unbound by a save.
    (selId && !devices.some((d) => String(d.id) === String(selId))
      ? `<option value="${escapeHtml(String(selId))}" selected>${escapeHtml(fill(t("botbuilder.bxDeviceMissing", lang), { id: String(selId) }))}</option>` : "");
  return { devices, opts };
}

function field(label, inner, hint = "", id = "") {
  return `<div class="btb-group">${id ? `<label for="${escapeHtml(id)}">` : "<label>"}${escapeHtml(label)}</label>${inner}` +
    (hint ? `<p class="btb-hint">${escapeHtml(hint)}</p>` : "") + `</div>`;
}

export async function renderBasics(ctx) {
  const { req, db, bot, def, botId, lang, hidden } = ctx;
  const { opts: mOpts, error: mErr } = await loadModelOptions(db);
  const byProv = {};
  for (const o of mOpts) (byProv[o.provider] = byProv[o.provider] || []).push(o);
  const models = def.models || {};

  const who = card(t("botbuilder.bxWhoTitle", lang),
    field(t("botbuilder.bxName", lang),
      `<input type="text" id="bx-name" name="display_name" class="btb-input" maxlength="80" required value="${escapeHtml(bot.display_name || "")}">`, "", "bx-name") +
    field(t("botbuilder.bxPersona", lang),
      `<textarea id="bx-persona" name="system_prompt" rows="8" class="btb-textarea btb-textarea-wide btb-textarea-prose">${escapeHtml(def.system_prompt || "")}</textarea>`,
      t("botbuilder.bxPersonaHint", lang), "bx-persona"),
    t("botbuilder.bxWhoLead", lang));

  const modelCard = card(t("botbuilder.bxModelTitle", lang),
    (mErr ? `<p class="btb-warn">${escapeHtml(mErr)}</p>` : "") +
    field(t("botbuilder.bxModel", lang),
      `<select id="bx-model" name="model_default" class="btb-select">` +
      (models.default ? "" : `<option value="" selected>${escapeHtml(t("botbuilder.bxModelInstanceDefault", lang))}</option>`) +
      `${modelOptions(byProv, models.default, lang)}</select>`, "", "bx-model") +
    field(t("botbuilder.bxStronger", lang),
      `<select id="bx-esc" name="model_escalation" class="btb-select"><option value="">${escapeHtml(t("botbuilder.bxNone", lang))}</option>${modelOptions(byProv, models.escalation, lang)}</select>`,
      t("botbuilder.bxStrongerHint", lang), "bx-esc") +
    field(t("botbuilder.bxVoiceModel", lang),
      `<select id="bx-voice" name="fast_voice_model" class="btb-select"><option value="">${escapeHtml(t("botbuilder.bxVoiceSame", lang))}</option>${modelOptions(byProv, def.fast_voice_model, lang)}</select>`,
      t("botbuilder.bxVoiceModelHint", lang), "bx-voice"));

  // ---- channel ----
  const gw = (def.gateways && def.gateways[0]) || {};
  const savedType = def.gateways && def.gateways[0] ? (gw.type || "gmail") : "none";
  // A stored type this editor does not manage (e.g. a "coming soon" one)
  // stays selectable as itself and is never rewritten by a Basics save.
  const curType = savedType;
  const types = CHANNEL_TYPES.includes(savedType) ? CHANNEL_TYPES : [...CHANNEL_TYPES, savedType];
  const typeLabel = {
    gmail: "Gmail", discord: "Discord", telegram: "Telegram", slack: "Slack",
    glasses: t("botbuilder.bxChGlasses", lang), companion: t("botbuilder.bxChCompanion", lang),
    "crow-messages": t("botbuilder.bxChCrowMessages", lang), perch: t("botbuilder.gwOptPerch", lang),
    none: t("botbuilder.gwOptNone", lang),
  };
  if (!typeLabel[curType]) typeLabel[curType] = curType;
  const typeOpts = types.map((v) =>
    `<option value="${escapeHtml(v)}"${v === curType ? " selected" : ""}>${escapeHtml(typeLabel[v])}</option>`).join("");

  const sets = [];
  for (const type of types) {
    const rec = type === curType ? gw : {};
    let inner = "";
    const simple = renderGatewayFields(type, rec, lang);
    if (simple) {
      inner = simple.fields + simple.hint;
    } else if (type === "glasses") {
      const { devices, opts } = await deviceOptions(db, botId, rec.device_id, lang);
      const selDev = devices.find((d) => String(d.id) === String(rec.device_id || "")) || null;
      const [ttsP, sttP, visionP] = await Promise.all([
        getTtsProfiles(db).catch(() => []), getSttProfiles(db).catch(() => []), loadVisionProfiles(db),
      ]);
      const profileSel = (name, label, profiles, selId) =>
        `<label class="btb-inline-field">${escapeHtml(label)} <select name="${name}" class="btb-select"><option value="">${escapeHtml(t("botbuilder.bxDeviceDefault", lang))}</option>` +
        profiles.map((p) => `<option value="${escapeHtml(String(p.id))}"${String(p.id) === String(selId || "") ? " selected" : ""}>${escapeHtml(p.name || String(p.id))}</option>`).join("") +
        // a profile the device still holds but the list no longer offers stays selected
        (selId && !profiles.some((p) => String(p.id) === String(selId))
          ? `<option value="${escapeHtml(String(selId))}" selected>${escapeHtml(fill(t("botbuilder.bxProfileMissing", lang), { id: String(selId) }))}</option>` : "") +
        `</select></label>`;
      let noVoiceWarn = "";
      try {
        const { voiceUnavailableSelections } = await import("../../../ai/tool-executor.js");
        const unavailable = voiceUnavailableSelections(def);
        if (unavailable.length) {
          noVoiceWarn = `<p class="btb-notice-warn">${fill(t("botbuilder.warnNoVoiceTools", lang), { tools: `<code>${unavailable.map(escapeHtml).join("</code>, <code>")}</code>` })}</p>`;
        }
      } catch { /* tool-executor unavailable */ }
      inner =
        field(t("botbuilder.gwLabelPairedDevice", lang), `<select name="gw_device_id" class="btb-select">${opts}</select>`,
          devices.length ? "" : t("botbuilder.hintNoGlassesDevices", lang)) +
        `<div class="btb-group"><label>${escapeHtml(t("botbuilder.bxVoices", lang))}</label><div class="btb-inline-fields">` +
        profileSel("gw_stt_profile_id", t("botbuilder.bxStt", lang), sttP, selDev && selDev.stt_profile_id) +
        profileSel("gw_tts_profile_id", t("botbuilder.bxTts", lang), ttsP, selDev && selDev.tts_profile_id) +
        profileSel("gw_vision_profile_id", t("botbuilder.bxVision", lang), visionP, selDev && selDev.vision_profile_id) +
        `</div><p class="btb-hint">${escapeHtml(t("botbuilder.bxVoicesHint", lang))}</p></div>` +
        noVoiceWarn + `<p class="btb-hint">${t("botbuilder.gwHintGlasses", lang)}</p>`;
    } else if (type === "companion") {
      const { opts } = await deviceOptions(db, botId, rec.device_id, lang, { markGlasses: true });
      const cf = def.companion_features || {};
      const chk = (v) => (v ? " checked" : "");
      inner =
        field(t("botbuilder.gwLabelPairedKiosk", lang), `<select name="gw_device_id" class="btb-select">${opts}</select>`) +
        field(t("botbuilder.gwLabelNewKiosk", lang),
          `<input type="text" name="gw_new_kiosk_name" class="btb-input" placeholder="${escapeHtml(t("botbuilder.gwPlaceholderNewKiosk", lang))}">`,
          t("botbuilder.gwHintNewKiosk", lang)) +
        field(t("botbuilder.gwLabelAvatarModel", lang),
          `<input type="text" name="gw_avatar_model" class="btb-input" value="${escapeHtml(cf.avatar_model || "")}">`) +
        `<div class="btb-group"><label>${escapeHtml(t("botbuilder.bxKioskFeatures", lang))}</label><div class="btb-checkbox-group btb-checkbox-col">` +
        `<label class="btb-checkbox"><input type="checkbox" name="gw_avatar_animation"${chk(cf.avatar_animation)}> ${escapeHtml(t("botbuilder.bxFeatAnimation", lang))}</label>` +
        `<label class="btb-checkbox"><input type="checkbox" name="gw_pet_mode"${chk(cf.pet_mode)}> ${escapeHtml(t("botbuilder.bxFeatPet", lang))}</label>` +
        `<label class="btb-checkbox"><input type="checkbox" name="gw_social_chat"${chk(cf.social_chat)}> ${escapeHtml(t("botbuilder.bxFeatSocial", lang))}</label>` +
        `<label class="btb-checkbox"><input type="checkbox" name="gw_memory_integration"${chk(cf.memory_integration)}> ${escapeHtml(t("botbuilder.bxFeatMemory", lang))}</label>` +
        `<label class="btb-checkbox"><input type="checkbox" name="gw_face_tracking"${chk(cf.face_tracking !== false)}> ${escapeHtml(t("botbuilder.bxFeatFace", lang))}</label>` +
        `</div></div>` +
        `<p class="btb-hint">${t("botbuilder.gwHintHousehold", lang)}</p><p class="btb-hint">${t("botbuilder.gwHintCompanion", lang)}</p>`;
    } else if (type === "crow-messages") {
      const allowPaired = rec.allow_paired_instances === true;
      inner =
        `<div class="btb-group"><label class="btb-checkbox"><input type="checkbox" name="gw_allow_paired_instances"${allowPaired ? " checked" : ""}> ` +
        `${escapeHtml(t("botbuilder.cmAllowPaired", lang))}</label></div>` +
        field(t("botbuilder.cmTaglineLabel", lang),
          `<input type="text" name="gw_description" class="btb-input" maxlength="140" value="${escapeHtml(typeof rec.description === "string" ? rec.description : "")}" placeholder="${escapeHtml(t("botbuilder.cmTaglinePlaceholder", lang))}">`,
          t("botbuilder.cmTaglineHint", lang)) +
        `<p class="btb-hint">${escapeHtml(t("botbuilder.cmHint", lang))}</p>` +
        (savedType === "crow-messages" ? "" : `<p class="btb-notice-info">${escapeHtml(t("botbuilder.bxCmSaveFirst", lang))}</p>`);
    } else {
      inner = `<p class="btb-hint">${escapeHtml(t("botbuilder.bxChUnmanaged", lang))}</p>`;
    }
    const on = type === curType;
    sets.push(`<fieldset class="btb-channel" data-channel="${escapeHtml(type)}"${on ? "" : " disabled hidden"}>` +
      `<legend class="btb-sr">${escapeHtml(typeLabel[type])}</legend>${inner}</fieldset>`);
  }

  // Engine gate (client intercept): armed while the engine is absent; the
  // client checks the LIVE type and that type's required fields, and only
  // intercepts when the channel record changed from what was rendered.
  const reqMap = {};
  for (const ch of ENGINE_CHANNELS) reqMap[ch] = engineGateRequiredDomFields(ch);
  const gateAttrs = isEngineAbsent()
    ? ` data-engine-gate="1" data-engine-channels="${escapeHtml(ENGINE_CHANNELS.join(","))}" data-engine-required-fields-json="${escapeHtml(JSON.stringify(reqMap))}"`
    : "";

  const channelCard = card(t("botbuilder.bxChannelTitle", lang),
    field(t("botbuilder.bxChannel", lang),
      `<select id="bx-channel" name="gw_type" class="btb-select" data-btb-channel-picker="1">${typeOpts}</select>`, "", "bx-channel") +
    sets.join("") +
    `<noscript><p class="btb-hint">${escapeHtml(t("botbuilder.bxNoScript", lang))}</p></noscript>`,
    t("botbuilder.bxChannelLead", lang));

  let cmExtra = "";
  if (savedType === "crow-messages") cmExtra = await renderCrowMessagesManage(req, db, botId, lang);

  return `<form method="POST" class="btb-form" id="btb-basics-form"${gateAttrs}>${hidden("basics")}` +
    who + modelCard + channelCard +
    actionBar(`<button type="submit" class="btb-btn">${escapeHtml(t("botbuilder.bxSave", lang))}</button>`) +
    `</form>` + cmExtra + channelPickerScript();
}

function channelPickerScript() {
  return `<script>(function(){
    var sel=document.querySelector('[data-btb-channel-picker]');
    if(!sel) return;
    sel.addEventListener('change',function(){
      var sets=document.querySelectorAll('fieldset.btb-channel');
      for(var i=0;i<sets.length;i++){
        var on=sets[i].getAttribute('data-channel')===sel.value;
        sets[i].disabled=!on; sets[i].hidden=!on;
      }
    });
  })();</script>`;
}

// Crow Messages sharing + who-can-message: separate forms, so they live
// OUTSIDE the Basics form, and only once the channel is saved.
async function renderCrowMessagesManage(req, db, botId, lang) {
  const admin = await import("./crow-messages-admin.js");
  let botCrowId = "";
  try { botCrowId = admin.botIdentityFor(botId).crowId; } catch { botCrowId = ""; }
  const actInputs = (act) =>
    `<input type="hidden" name="action" value="${escapeHtml(act)}">` +
    `<input type="hidden" name="bot_id" value="${escapeHtml(botId)}">${csrfInput(req)}`;
  let shareBlock = "";
  try {
    const active = await admin.getActiveInvite(db, botId);
    if (active) {
      const code = await admin.buildInviteCode(db, botId, active.token);
      const relLink = `/dashboard/messages?bot_invite=${encodeURIComponent(code)}`;
      const base = (process.env.CROW_GATEWAY_URL
        || (req.get ? `${req.protocol || "http"}://${req.get("host")}` : "")).replace(/\/+$/, "");
      const shareUrl = base ? base + relLink : relLink;
      let qrImg = "";
      try {
        const QRCode = (await import("qrcode")).default;
        const dataUrl = await QRCode.toDataURL(shareUrl, { width: 220, margin: 1 });
        qrImg = `<img src="${dataUrl}" alt="${escapeHtml(t("botbuilder.bxShareQrAlt", lang))}" width="220" height="220" style="image-rendering:pixelated;max-width:100%;height:auto">`;
      } catch { /* qr optional */ }
      shareBlock =
        `<div class="btb-group"><label>${escapeHtml(t("botbuilder.cmShareLabel", lang))}</label>` +
        `<p class="btb-hint">${escapeHtml(t("botbuilder.cmShareHint", lang))}</p>` +
        `<textarea class="btb-textarea" rows="3" readonly onclick="this.select()">${escapeHtml(shareUrl)}</textarea>` +
        `<p class="btb-hint"><a href="${escapeHtml(relLink)}">${escapeHtml(t("botbuilder.cmOpenLink", lang))}</a></p>` +
        (qrImg ? `<div style="margin:.5rem 0">${qrImg}</div>` : "") + `</div>`;
    }
  } catch { shareBlock = ""; }
  const shareActions =
    `<div class="btb-group btb-actions-row">` +
    `<form method="POST">${actInputs("gw_share")}<button type="submit" class="btb-btn">${escapeHtml(t("botbuilder.cmShareBtn", lang))}</button></form>` +
    `<form method="POST">${actInputs("gw_newlink")}<button type="submit" class="btb-btn btb-btn-sec">${escapeHtml(t("botbuilder.cmNewLinkBtn", lang))}</button></form>` +
    `</div>`;
  let aclList = "";
  try {
    const acl = await admin.listAcl(db, botId);
    const items = acl.map((r) => {
      const label = escapeHtml(r.display_name || r.crow_id || r.sender_pubkey.slice(0, 12) + "…");
      return `<li><span>${label}</span> <form method="POST" style="display:inline">${actInputs("gw_remove")}` +
        `<input type="hidden" name="sender_pubkey" value="${escapeHtml(r.sender_pubkey)}">` +
        `<button type="submit" class="btb-btn btb-btn-sec btb-btn-sm">${escapeHtml(t("botbuilder.cmRemove", lang))}</button></form></li>`;
    }).join("");
    aclList = `<div class="btb-group"><label>${escapeHtml(t("botbuilder.cmWhoCanMessage", lang))}</label>` +
      (items ? `<ul class="btb-plain-list">${items}</ul>` : `<p class="btb-hint">${escapeHtml(t("botbuilder.cmNobodyYet", lang))}</p>`) + `</div>`;
  } catch { aclList = ""; }
  const advanced =
    `<details class="btb-details"><summary>${escapeHtml(t("botbuilder.cmAdvanced", lang))}</summary>` +
    (botCrowId ? `<p class="btb-hint">${escapeHtml(t("botbuilder.cmRawAddress", lang))}: <code>${escapeHtml(botCrowId)}</code></p>` : "") +
    `<form method="POST">${actInputs("gw_advanced_add")}` +
    `<div class="btb-group"><label>${escapeHtml(t("botbuilder.cmManualPubkey", lang))}</label>` +
    `<input type="text" name="sender_pubkey" class="btb-input" placeholder="${escapeHtml(t("botbuilder.cmPubkeyPlaceholder", lang))}"></div>` +
    `<div class="btb-group"><label>${escapeHtml(t("botbuilder.cmManualName", lang))}</label>` +
    `<input type="text" name="display_name" class="btb-input"></div>` +
    `<button type="submit" class="btb-btn">${escapeHtml(t("botbuilder.cmManualAdd", lang))}</button></form></details>`;
  return `<div class="btb-cm-manage">` + card(t("botbuilder.bxCmManageTitle", lang), shareBlock + shareActions + aclList + advanced) + `</div>`;
}
