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
import { ENGINE_CHANNELS } from "../../../bot-engine-status.js";
import { resolveEngineStatus, resolveBotRuntimeStatus } from "./engine-gate.js";
import { botRuntimeActive } from "../bot-runtime-flag.js";

const OK = `<span class="btb-ok" aria-hidden="true">&#10003;</span>`;
const WARN = `<span class="btb-status-warn" aria-hidden="true">&#9888;</span>`;
const ERR = `<span class="btb-err" aria-hidden="true">&#10007;</span>`;

function row(icon, label, detail, fixHref, fixLabel) {
  const fix = fixHref ? `<a href="${escapeHtml(fixHref)}">${escapeHtml(fixLabel)}</a>` : "";
  return `<tr><td class="btb-check-icon">${icon}</td><td>${label}</td><td>${detail}</td><td>${fix}</td></tr>`;
}

// Same row shape as row() above, but the fix cell is already-built HTML
// (a button wired to a client hook) rather than a plain link — used by the
// "Bot engine" row's absent/disarmed states below, which act via JS hooks
// instead of navigating to another tab.
function rowRawFix(icon, label, detail, fixHtml) {
  return `<tr><td class="btb-check-icon">${icon}</td><td>${label}</td><td>${detail}</td><td>${fixHtml || ""}</td></tr>`;
}

/**
 * "Bot engine" row (C4 Task 9). Shown ONLY when this bot has at least one
 * ENGINE_CHANNELS-type gateway (gmail/discord/telegram/slack) — voice/device
 * and crow-messages gateways never need pi installed. Five states, in the
 * SAME precedence order as engineStatus() itself (bot-engine-status.js):
 * installing > absent > unhealthy > ready, with "ready" splitting further
 * into "disarmed" (engine present, but nothing will poll it — the
 * bot_runtime flag is off) vs plain ready. Reuses the exact pins
 * resolveEngineStatus()/resolveBotRuntimeStatus() from engine-gate.js so one
 * _setEngineStatusForTest/_setBotRuntimeStatusForTest call in a test arms
 * this row the same way it arms the Gateways-tab save gate (Task 7/8).
 */
async function renderEngineRow(db, def, lang, tabHref, fixLabel) {
  const hasEngineChannel = (def.gateways || []).some((g) => g && ENGINE_CHANNELS.includes(g.type));
  if (!hasEngineChannel) return "";

  const label = t("botbuilder.checkEngine", lang);
  const status = resolveEngineStatus();

  if (status.state === "installing") {
    return row(WARN, label, t("botbuilder.checkEngineInstalling", lang), tabHref("gateways"), fixLabel);
  }

  if (status.state === "absent") {
    const installBtn =
      `<button type="button" class="btb-btn btb-btn-sm btb-btn-inline" onclick="window.__crowEngineGateOpen()">` +
      `${escapeHtml(t("botbuilder.engineGateInstallBtn", lang))}</button>`;
    return rowRawFix(ERR, label, t("botbuilder.checkEngineAbsent", lang), installBtn);
  }

  if (status.state === "unhealthy") {
    const detail = fill(t("botbuilder.checkEngineUnhealthy", lang), {
      error: escapeHtml(status.error || t("botbuilder.engineGateUnknownError", lang)),
      retryAt: escapeHtml(status.retryAt || "—"),
    });
    return row(ERR, label, detail, tabHref("gateways"), fixLabel);
  }

  // status.state === "ready" — split disarmed vs plain ready per the
  // SAME predicate the Gateways-tab save gate uses (api-handlers.js): only
  // runtime mode "gateway" self-supervises off the bot_runtime flag; a mode
  // of "external" or "disabled" never disarms (nothing here would poll
  // regardless of the flag's value).
  const runtime = resolveBotRuntimeStatus();
  if (runtime.mode === "gateway") {
    const flagOn = await botRuntimeActive(db);
    if (!flagOn) {
      const enableBtn =
        `<button type="button" id="bot-runtime-enable-btn" class="btb-btn btb-btn-sm btb-btn-inline">` +
        `${escapeHtml(t("botbuilder.runtimeOffEnableBtn", lang))}</button> ` +
        `<span id="bot-runtime-enable-status" class="btb-hint"></span>`;
      return rowRawFix(WARN, label, t("botbuilder.checkEngineDisarmed", lang), enableBtn);
    }
  }

  let detail = fill(t("botbuilder.checkEngineReady", lang), { source: escapeHtml(status.source || "") });
  if (runtime.mode === "external") {
    detail += ` · ${t("botbuilder.checkEngineExternalNote", lang)}`;
  }
  return row(OK, label, detail, tabHref("gateways"), fixLabel);
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

  // ---- Bot engine (C4 Task 9) — only when a gateway needs pi installed ----
  const engineRow = await renderEngineRow(db, def, lang, tabHref, fixLabel);
  if (engineRow) rows.push(engineRow);

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
