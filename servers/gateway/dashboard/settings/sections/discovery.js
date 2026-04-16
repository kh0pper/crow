/**
 * Settings Section: Contact Discovery
 */

import { formField } from "../../shared/components.js";
import { t } from "../../shared/i18n.js";
import { upsertSetting } from "../registry.js";

export default {
  id: "discovery",
  group: "content",
  icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>`,
  labelKey: "settings.section.discovery",
  navOrder: 20,

  async getPreview({ settings, lang }) {
    return settings.discovery_enabled === "true"
      ? t("settings.enabledOption", lang)
      : t("settings.disabledOption", lang);
  },

  async render({ db, lang }) {
    const result = await db.execute({
      sql: "SELECT key, value FROM dashboard_settings WHERE key LIKE 'discovery_%'",
      args: [],
    });
    const bs = {};
    for (const r of result.rows) bs[r.key] = r.value;

    return `<form method="POST">
      <input type="hidden" name="action" value="update_discovery">
      ${formField(t("settings.contactDiscoveryLabel", lang), "discovery_enabled", { type: "select", value: bs.discovery_enabled || "false", options: [
        { value: "false", label: t("settings.disabled", lang) },
        { value: "true", label: t("settings.enabled", lang) },
      ]})}
      <p style="color:var(--crow-text-muted);font-size:0.85rem;margin:-0.5rem 0 1rem">When enabled, your Crow ID and display name are visible at /discover/profile. Other Crow users can find you and send invite requests.</p>
      ${formField(t("settings.displayName", lang), "discovery_name", { type: "text", value: bs.discovery_name || "", placeholder: t("settings.displayNamePlaceholder", lang) })}
      <button type="submit" class="btn btn-primary">${t("settings.saveDiscoverySettings", lang)}</button>
    </form>`;
  },

  async handleAction({ req, res, db, action }) {
    if (action !== "update_discovery") return false;

    const fields = ["discovery_enabled", "discovery_name"];
    for (const key of fields) {
      const value = req.body[key];
      if (value !== undefined) {
        await upsertSetting(db, key, value);
      }
    }
    res.redirectAfterPost("/dashboard/settings?section=discovery");
    return true;
  },
};
