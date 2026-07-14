/**
 * Bot Builder — shared gateway fields for the "simple" gateway types
 * (gmail, discord, telegram, slack, none): the per-type credential/allowlist
 * form fields AND the form-body → gateway-record normalization, extracted
 * verbatim from editor.js / api-handlers.js so the Gateways tab and the
 * guided-creation wizard share one source of truth (Item 5 PR1, spec §D3).
 *
 * Device-bound types (glasses, companion) and crow-messages keep their
 * bespoke handling where it was: they need db/device-store/identity context
 * that a pure (gwType, body) mapping cannot have.
 */

import { escapeHtml, formField } from "../../shared/components.js";
import { t } from "../../shared/i18n.js";
import { lines } from "./data-queries.js";

export const SIMPLE_GATEWAY_TYPES = ["gmail", "discord", "telegram", "slack", "none"];

/**
 * Per-type required fields for readiness (spec §D4). gmail requires a
 * non-empty allowlist because its sender wall fails CLOSED
 * (bridge_tick.mjs: empty allowlist = every sender skipped = deaf bot) and a
 * non-empty address because the tick only polls gateways that have one. The
 * other adapters' allowlists fail OPEN on empty (passesAllowlist in
 * gateways/base.mjs), so only their tokens are required.
 */
export const GATEWAY_REQUIRED_FIELDS = {
  gmail: ["address", "allowlist"],
  discord: ["token"],
  telegram: ["token"],
  slack: ["bot_token", "app_token"],
  "crow-messages": [],
  // Voice types work only once a device is bound (the voice turn reads
  // device.bound_bot_id; a type-only record is a UI draft, W1-4).
  glasses: ["device_id"],
  companion: ["device_id"],
  none: [],
};

/**
 * Render the credential/allowlist fields + hint for a simple gateway type.
 * Markup is byte-identical to what the Gateways tab rendered inline before
 * the extraction (labels intentionally unchanged in PR1; PR3 de-jargons).
 *
 * @param {string} gwType - one of SIMPLE_GATEWAY_TYPES
 * @param {object} gw - the existing gateway record ({} for a fresh form)
 * @param {string} lang
 * @returns {{fields: string, hint: string}|null} null when gwType is not a
 *   simple type (caller falls through to its bespoke rendering).
 */
export function renderGatewayFields(gwType, gw, lang) {
  gw = gw || {};
  if (gwType === "discord") {
    return {
      fields:
        `<div class="btb-group"><label>${t("botbuilder.gwLabelBotTokenDiscord", lang)}</label>` +
        `<input type="password" name="gw_token" class="btb-input" autocomplete="off" value="${escapeHtml(gw.token || "")}"></div>` +
        formField("Guild ID (optional)", "gw_guild_id", { value: gw.guild_id || "" }) +
        `<div class="btb-group"><label>${t("botbuilder.gwLabelChannelIds", lang)}</label>` +
        `<textarea name="gw_channel_ids" rows="3" class="btb-textarea">${escapeHtml((gw.channel_ids || []).join("\n"))}</textarea></div>` +
        `<div class="btb-group"><label>${t("botbuilder.gwLabelAllowlistDiscord", lang)}</label>` +
        `<textarea name="gw_allowlist" rows="4" class="btb-textarea">${escapeHtml((gw.allowlist || []).join("\n"))}</textarea></div>`,
      hint: `<p class="btb-hint">${t("botbuilder.gwHintDiscord", lang)}</p>`,
    };
  }
  if (gwType === "telegram") {
    return {
      fields:
        `<div class="btb-group"><label>${t("botbuilder.gwLabelBotTokenTelegram", lang)}</label>` +
        `<input type="password" name="gw_token" class="btb-input" autocomplete="off" value="${escapeHtml(gw.token || "")}"></div>` +
        `<div class="btb-group"><label>${t("botbuilder.gwLabelAllowlistTelegram", lang)}</label>` +
        `<textarea name="gw_allowlist" rows="4" class="btb-textarea">${escapeHtml((gw.allowlist || []).join("\n"))}</textarea></div>` +
        `<div class="btb-group"><label>${t("botbuilder.gwLabelChatIds", lang)}</label>` +
        `<textarea name="gw_chat_ids" rows="3" class="btb-textarea">${escapeHtml((gw.chat_ids || []).join("\n"))}</textarea></div>`,
      hint: `<p class="btb-hint">${t("botbuilder.gwHintTelegram", lang)}</p>`,
    };
  }
  if (gwType === "slack") {
    return {
      fields:
        `<div class="btb-group"><label>${t("botbuilder.gwLabelBotTokenSlack", lang)}</label>` +
        `<input type="password" name="gw_bot_token" class="btb-input" autocomplete="off" value="${escapeHtml(gw.bot_token || "")}"></div>` +
        `<div class="btb-group"><label>${t("botbuilder.gwLabelAppToken", lang)}</label>` +
        `<input type="password" name="gw_app_token" class="btb-input" autocomplete="off" value="${escapeHtml(gw.app_token || "")}"></div>` +
        `<div class="btb-group"><label>${t("botbuilder.gwLabelAllowlistSlack", lang)}</label>` +
        `<textarea name="gw_allowlist" rows="4" class="btb-textarea">${escapeHtml((gw.allowlist || []).join("\n"))}</textarea></div>` +
        `<div class="btb-group"><label>${t("botbuilder.gwLabelChannelIdsSlack", lang)}</label>` +
        `<textarea name="gw_channel_ids" rows="3" class="btb-textarea">${escapeHtml((gw.channel_ids || []).join("\n"))}</textarea></div>`,
      hint: `<p class="btb-hint">${t("botbuilder.gwHintSlack", lang)}</p>`,
    };
  }
  if (gwType === "none") {
    return { fields: "", hint: `<p class="btb-hint">${t("botbuilder.gwHintNone", lang)}</p>` };
  }
  if (gwType === "gmail") {
    return {
      fields:
        formField("Gmail address (+alias)", "gw_address", { value: gw.address || "" }) +
        `<div class="btb-group"><label>Allowlist (one address per line)</label>` +
        `<textarea name="gw_allowlist" rows="4" class="btb-textarea">${escapeHtml((gw.allowlist || []).join("\n"))}</textarea></div>`,
      hint: `<p class="btb-hint">${t("botbuilder.gwHintGmail", lang)}</p>`,
    };
  }
  return null;
}

/**
 * Normalize a POSTed form body into the def.gateways array for a simple
 * gateway type. Record shapes are byte-identical to the pre-extraction
 * save_gateways branches.
 *
 * @param {string} gwType
 * @param {object} body - req.body
 * @returns {object[]|null} the gateways array ([] for "none"), or null when
 *   gwType is not a simple type (caller falls through to bespoke handling).
 */
export function normalizeGatewayFields(gwType, body) {
  const b = body || {};
  if (gwType === "none") return [];
  if (gwType === "discord") {
    return [
      {
        type: "discord",
        token: (b.gw_token || "").trim(),
        guild_id: (b.gw_guild_id || "").trim() || undefined,
        channel_ids: lines(b.gw_channel_ids),
        allowlist: lines(b.gw_allowlist),
      },
    ];
  }
  if (gwType === "telegram") {
    // Telegram long-poll adapter (gateways/telegram.mjs), run by the
    // pibot-gateways host. allowlist = Telegram numeric user IDs.
    return [
      {
        type: "telegram",
        token: (b.gw_token || "").trim(),
        allowlist: lines(b.gw_allowlist),
        chat_ids: lines(b.gw_chat_ids),
      },
    ];
  }
  if (gwType === "slack") {
    // Slack socket-mode adapter (gateways/slack.mjs), run by the
    // pibot-gateways host. Needs BOTH a bot token (xoxb-) and an
    // app-level token (xapp-, connections:write).
    return [
      {
        type: "slack",
        bot_token: (b.gw_bot_token || "").trim(),
        app_token: (b.gw_app_token || "").trim(),
        allowlist: lines(b.gw_allowlist),
        channel_ids: lines(b.gw_channel_ids),
      },
    ];
  }
  if (gwType === "gmail") {
    return [
      {
        type: "gmail",
        address: (b.gw_address || "").trim(),
        allowlist: lines(b.gw_allowlist),
      },
    ];
  }
  return null;
}

/**
 * crow-messages form-body → gateway-record normalization. Lives here (moved
 * from api-handlers.js in Item 5 PR1) because it is normalization like the
 * simple types above, and so the wizard can consume it without an
 * api-handlers ↔ wizard import cycle. api-handlers re-exports it for
 * existing importers.
 */
export function buildCrowMessagesGatewayConfig(b) {
  const gw = {
    type: "crow-messages",
    allow_paired_instances: b.gw_allow_paired_instances === "on" || b.gw_allow_paired_instances === "true",
  };
  const desc = typeof b.gw_description === "string" ? b.gw_description.trim() : "";
  if (desc) gw.description = desc.slice(0, 140);
  return gw;
}

/**
 * Which required fields (per GATEWAY_REQUIRED_FIELDS) are missing/empty on a
 * gateway record. Array fields count as present only when non-empty.
 * Unknown types return [] (no claims about types we don't model).
 */
export function missingGatewayFields(gw) {
  if (!gw || !gw.type) return [];
  const required = GATEWAY_REQUIRED_FIELDS[gw.type];
  if (!required) return [];
  return required.filter((f) => {
    const v = gw[f];
    if (Array.isArray(v)) return v.length === 0;
    return !(typeof v === "string" && v.trim());
  });
}
