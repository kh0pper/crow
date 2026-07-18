/**
 * Bot Builder — readiness checklist (Item 5 PR2, spec §D4).
 *
 * The Review tab's default view: one plain-language row per readiness item,
 * each with a status icon and a link to the tab that fixes it. Honesty rules
 * (spec adversarial rounds 1+2):
 *   - Model row validates def.models.default against loadModelOptions(db) —
 *     the same source of truth as every picker — NEVER resolveModel(), which
 *     fail-closes to a hardcoded fallback and cannot report failure. The
 *     not-ready state shows the CONFIGURED key (or "none set"), never the
 *     fallback key.
 *   - Channel row: a present gateway is not a working gateway. Readiness =
 *     the type's GATEWAY_REQUIRED_FIELDS are non-empty (gmail's sender wall
 *     fails CLOSED, so its allowlist is required; discord/telegram/slack
 *     fail open; voice types need a bound device).
 */

import { escapeHtml } from "../../shared/components.js";
import { t, fill } from "../../shared/i18n.js";
import { loadModelOptions } from "./data-queries.js";
import { missingGatewayFields } from "./gateway-fields.js";

const OK = `<span class="btb-ok" aria-hidden="true">&#10003;</span>`;
const WARN = `<span class="btb-status-warn" aria-hidden="true">&#9888;</span>`;
const ERR = `<span class="btb-err" aria-hidden="true">&#10007;</span>`;

function row(icon, label, detail, fixHref, fixLabel) {
  const fix = fixHref ? `<a href="${escapeHtml(fixHref)}">${escapeHtml(fixLabel)}</a>` : "";
  return `<tr><td class="btb-check-icon">${icon}</td><td>${label}</td><td>${detail}</td><td>${fix}</td></tr>`;
}

/**
 * Render the readiness checklist table for a bot.
 * @param {object} db
 * @param {object} bot - pi_bot_defs row (bot_id, enabled, ...)
 * @param {object} def - parsed definition
 * @param {string} lang
 * @returns {Promise<string>} HTML
 */
export async function renderReadiness(db, bot, def, lang) {
  const botId = bot.bot_id;
  const tabHref = (tab) => `/dashboard/bot-builder?bot=${encodeURIComponent(botId)}&tab=${tab}`;
  const fixLabel = t("botbuilder.checkFix", lang);
  const rows = [];

  // ---- Model (spec round-1 C1: loadModelOptions, never resolveModel) ----
  const configured = ((def.models || {}).default || "").trim();
  let modelReady = false;
  try {
    const { opts } = await loadModelOptions(db);
    modelReady = !!configured && opts.some((o) => o.key === configured);
  } catch { modelReady = false; }
  rows.push(row(
    modelReady ? OK : ERR,
    t("botbuilder.checkModel", lang),
    modelReady
      ? `<code>${escapeHtml(configured)}</code>`
      : (configured
          ? fill(t("botbuilder.checkModelUnavailable", lang), { key: escapeHtml(configured) })
          : t("botbuilder.checkModelNone", lang)),
    tabHref("ai"), fixLabel));

  // ---- Channel (spec round-2 MAJOR-B: per-type required fields) ----
  const gw = (def.gateways || []).find((g) => g && g.type) || null;
  if (!gw) {
    rows.push(row(WARN, t("botbuilder.checkChannel", lang),
      t("botbuilder.checkChannelNone", lang), tabHref("gateways"), fixLabel));
  } else {
    const missing = missingGatewayFields(gw);
    if (missing.length) {
      rows.push(row(WARN, t("botbuilder.checkChannel", lang),
        `${escapeHtml(gw.type)} — ` +
        fill(t("botbuilder.checkChannelIncomplete", lang), { fields: escapeHtml(missing.join(", ")) }),
        tabHref("gateways"), fixLabel));
    } else {
      let detail = escapeHtml(gw.type);
      if (gw.type === "gmail") {
        detail += ` — ${escapeHtml(gw.address || "")}, ` +
          fill(t("botbuilder.checkChannelAllowed", lang), { n: (gw.allowlist || []).length });
      } else if (gw.device_id) {
        detail += ` — ${fill(t("botbuilder.checkChannelDevice", lang), { id: escapeHtml(String(gw.device_id)) })}`;
      }
      rows.push(row(OK, t("botbuilder.checkChannel", lang), detail, tabHref("gateways"), fixLabel));
    }
  }

  // ---- Tools ----
  const tools = def.tools || {};
  const nMcp = (tools.crow_mcp || []).length;
  const nBuiltin = (tools.pi_builtin || []).length;
  rows.push(row(OK, t("botbuilder.checkTools", lang),
    fill(t("botbuilder.checkToolsDetail", lang), { mcp: nMcp, builtin: nBuiltin }),
    tabHref("tools"), fixLabel));

  // ---- Skills & prompt ----
  const nSkills = (def.skills || []).length;
  const hasPrompt = !!(def.system_prompt || "").trim();
  rows.push(row(hasPrompt ? OK : WARN, t("botbuilder.checkSkills", lang),
    fill(t("botbuilder.checkSkillsDetail", lang), { n: nSkills }) +
    (hasPrompt ? ` · ${t("botbuilder.checkPromptSet", lang)}` : ` · ${t("botbuilder.checkPromptMissing", lang)}`),
    tabHref("skills"), fixLabel));

  // ---- Permissions ----
  const pp = def.permission_policy || {};
  rows.push(row(OK, t("botbuilder.checkPermissions", lang),
    `bash: <code>${escapeHtml(pp.bash || "deny")}</code> · ` +
    `${t("botbuilder.checkPermSend", lang)}: <code>${escapeHtml(pp.external_send || "draft_only")}</code> · ` +
    `${t("botbuilder.checkPermLearning", lang)}: <code>${escapeHtml(pp.skill_learning || "off")}</code>`,
    tabHref("permissions"), fixLabel));

  // ---- Status (with the toggle, spec §D4) ----
  const statusDetail = bot.enabled
    ? t("botbuilder.checkStatusEnabled", lang)
    : t("botbuilder.checkStatusDisabled", lang);
  rows.push(row(bot.enabled ? OK : WARN, t("botbuilder.checkStatus", lang), statusDetail, null, ""));

  return `<table class="btb-checklist">` +
    `<thead><tr><th></th><th>${t("botbuilder.checkColItem", lang)}</th><th>${t("botbuilder.checkColState", lang)}</th><th></th></tr></thead>` +
    `<tbody>${rows.join("")}</tbody></table>`;
}
