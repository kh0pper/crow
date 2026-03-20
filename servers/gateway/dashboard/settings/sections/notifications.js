/**
 * Settings Section: Notifications
 */

import { escapeHtml } from "../../shared/components.js";
import { t } from "../../shared/i18n.js";
import { upsertSetting } from "../registry.js";

export default {
  id: "notifications",
  group: "general",
  icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>`,
  labelKey: "settings.section.notifications",
  navOrder: 30,

  async getPreview({ settings, lang }) {
    let prefs = { types_enabled: ["reminder", "media", "peer", "system"] };
    try {
      if (settings.notification_prefs) prefs = JSON.parse(settings.notification_prefs);
    } catch {}
    const enabled = prefs.types_enabled?.length || 0;
    return `${enabled} of 4 enabled`;
  },

  async render({ req, db, lang }) {
    let notifPrefs = { types_enabled: ["reminder", "media", "peer", "system"] };
    try {
      const { rows } = await db.execute({
        sql: "SELECT value FROM dashboard_settings WHERE key = 'notification_prefs'",
        args: [],
      });
      if (rows.length > 0) notifPrefs = JSON.parse(rows[0].value);
    } catch {}

    const notifTypes = [
      { key: "reminder", label: t("settings.notifReminder", lang) },
      { key: "media", label: t("settings.notifMedia", lang) },
      { key: "peer", label: t("settings.notifPeer", lang) },
      { key: "system", label: t("settings.notifSystem", lang) },
    ];

    const checkboxes = notifTypes.map(({ key, label }) => {
      const checked = notifPrefs.types_enabled?.includes(key) ? "checked" : "";
      return `<label style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.5rem;cursor:pointer">
        <input type="checkbox" name="type_${key}" value="1" ${checked} style="accent-color:var(--crow-accent)"> ${escapeHtml(label)}
      </label>`;
    }).join("");

    return `<form method="POST" action="/dashboard/settings">
      <input type="hidden" name="_csrf" value="${req.csrfToken}" />
      <input type="hidden" name="action" value="save_notification_prefs" />
      <p style="color:var(--crow-text-muted);font-size:0.85rem;margin-bottom:0.75rem">${t("settings.notifTypes", lang)}</p>
      ${checkboxes}
      <button type="submit" class="btn btn-primary" style="margin-top:0.5rem">${t("common.save", lang)}</button>
    </form>`;
  },

  async handleAction({ req, res, db, action }) {
    if (action !== "save_notification_prefs") return false;

    const typesEnabled = [];
    if (req.body.type_reminder) typesEnabled.push("reminder");
    if (req.body.type_media) typesEnabled.push("media");
    if (req.body.type_peer) typesEnabled.push("peer");
    if (req.body.type_system) typesEnabled.push("system");
    const prefs = JSON.stringify({ types_enabled: typesEnabled });
    await upsertSetting(db, "notification_prefs", prefs);
    res.redirect("/dashboard/settings?section=notifications");
    return true;
  },
};
