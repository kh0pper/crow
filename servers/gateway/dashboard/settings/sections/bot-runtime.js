/**
 * Settings Section: Bot Runtime (Multi-Instance group) — F3b.
 *
 * Toggles feature_flags.bot_runtime (local-only; absent from sync-allowlist).
 * When ON, the gateway process itself runs bots (poll Gmail / answer
 * Telegram/Slack/Discord) via bot-runtime.js's in-process bridge tick +
 * supervised Discord child (C4 Task 6) — no separate install step, no
 * restart to flip. The old copy here claimed the runtime units had to be
 * installed first (scripts/pi-bots/install-runtime.sh) — that predates
 * gateway supervision and is false on every default host now; standalone
 * systemd units are only relevant on a host explicitly configured with
 * PIBOT_SUPERVISOR=external (C4 Task 9 reword).
 */
import { readSetting, writeSetting } from "../registry.js";
import { t } from "../../shared/i18n.js";
import { escapeHtml } from "../../shared/components.js";
import { isMpaHost } from "../../../../shared/mpa-detect.js";

async function readFlags(db) {
  const raw = await readSetting(db, "feature_flags");
  if (!raw) return {};
  try { return JSON.parse(raw) || {}; } catch { return {}; }
}

/**
 * The runtime state as the runner sees it: an explicit boolean flag wins,
 * else the host default (isMpaHost). Same rule as botRuntimeActive
 * (panels/bot-runtime-flag.js) and runtime-gate.mjs. Reading the flag with
 * `=== true` alone showed "disabled" on default-on hosts while bots ran, and
 * a Save from that page then wrote `false` and stopped them.
 */
function resolveRuntime(flags) {
  const explicit = typeof flags?.bot_runtime === "boolean";
  return { on: explicit ? flags.bot_runtime : isMpaHost(), explicit };
}

export default {
  id: "bot-runtime",
  group: "advanced",
  icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 9h6v6H9z"/></svg>`,
  labelKey: "settings.section.botRuntime",
  navOrder: 8,

  async getPreview({ db, settings, lang }) {
    let flags = {};
    try {
      flags = db ? await readFlags(db) : (JSON.parse(settings?.feature_flags || "{}") || {});
    } catch {}
    return resolveRuntime(flags).on ? t("settings.enabledOption", lang) : t("settings.disabledOption", lang);
  },

  async render({ db, lang }) {
    const { on, explicit } = resolveRuntime(await readFlags(db));
    const defaultNote = explicit
      ? ""
      : `<div style="margin-top:0.5rem;color:var(--crow-text-muted);font-size:0.8rem">${escapeHtml(t(on ? "settings.botRuntimeDefaultOn" : "settings.botRuntimeDefaultOff", lang))}</div>`;
    return `<form method="POST">
      <input type="hidden" name="action" value="set_bot_runtime">
      <input type="hidden" name="was" value="${on ? "on" : "off"}">
      <div style="margin-bottom:1rem;color:var(--crow-text-secondary);font-size:0.9rem;line-height:1.5">
        ${t("settings.botRuntimeBody", lang)}
      </div>
      <label style="display:flex;align-items:center;gap:0.6rem;cursor:pointer">
        <input type="checkbox" name="enabled" ${on ? "checked" : ""}>
        <span>${escapeHtml(t("settings.botRuntimeCheckbox", lang))}</span>
      </label>
      ${defaultNote}
      <div style="margin-top:1.5rem"><button type="submit" class="btn btn-secondary">${escapeHtml(t("common.save", lang))}</button></div>
    </form>`;
  },

  async handleAction({ req, res, db, action }) {
    if (action !== "set_bot_runtime") return false;
    const flags = await readFlags(db);
    const want = req.body.enabled === "on";
    const shown = req.body.was === "on" ? true : req.body.was === "off" ? false : null;
    const current = resolveRuntime(flags).on;
    // Write only when the operator changed the box (vs what the page showed)
    // AND it differs from the live state. A plain Save is a no-op.
    if ((shown === null || want !== shown) && want !== current) {
      flags.bot_runtime = want;
      await writeSetting(db, "feature_flags", JSON.stringify(flags), { scope: "local" });
    }
    res.redirectAfterPost("/dashboard/settings?section=bot-runtime");
    return true;
  },
};
