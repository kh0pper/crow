/**
 * Settings Section: Device Context
 */

import { escapeHtml, badge, dataTable } from "../../shared/components.js";
import { t } from "../../shared/i18n.js";

export default {
  id: "device-context",
  group: "system",
  icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`,
  labelKey: "settings.section.deviceContext",
  navOrder: 20,

  async getPreview() {
    const deviceId = process.env.CROW_DEVICE_ID || "";
    return deviceId || "Not set";
  },

  async render({ db, lang }) {
    const currentDeviceId = process.env.CROW_DEVICE_ID || "";
    const contextSections = await db.execute({
      sql: "SELECT section_key, section_title, device_id, enabled FROM crow_context ORDER BY sort_order, section_key",
      args: [],
    });

    const globalSections = contextSections.rows.filter((r) => !r.device_id);
    const deviceSections = currentDeviceId
      ? contextSections.rows.filter((r) => r.device_id === currentDeviceId)
      : [];
    const overriddenKeys = new Set(deviceSections.map((r) => r.section_key));

    const contextRows = globalSections.map((s) => {
      const hasOverride = overriddenKeys.has(s.section_key);
      const statusBadge = hasOverride
        ? `${badge(t("settings.overriddenBadge", lang), "connected")}`
        : badge(s.enabled ? t("settings.activeBadge", lang) : t("settings.disabledBadge", lang), s.enabled ? "published" : "draft");
      return [
        escapeHtml(s.section_title),
        `<span class="mono" style="font-size:0.8rem">${escapeHtml(s.section_key)}</span>`,
        statusBadge,
      ];
    });

    const deviceLabel = currentDeviceId
      ? `<span class="mono" style="font-size:0.85rem">${escapeHtml(currentDeviceId)}</span>`
      : `<span style="color:var(--crow-text-muted)">${t("settings.notSetDevice", lang)}</span>`;

    return `
      <div style="margin-bottom:1rem">
        <span style="color:var(--crow-text-muted);font-size:0.85rem">${t("settings.deviceId", lang)}</span> ${deviceLabel}
      </div>
      ${dataTable([t("settings.sectionColumn", lang), t("settings.keyColumn", lang), t("settings.statusColumn", lang)], contextRows)}
      <p style="color:var(--crow-text-muted);font-size:0.8rem;margin-top:0.75rem">
        Set <code>CROW_DEVICE_ID</code> in .env to enable per-device context overrides.
        ${currentDeviceId ? `This device has ${deviceSections.length} override(s). ` : ""}
        Manage context via your AI: <em>"Crow, update my context to prefer Spanish responses"</em> or use the <code>crow_add_context_section</code> / <code>crow_update_context_section</code> tools with a <code>device_id</code>.
      </p>`;
  },

  async handleAction() {
    return false;
  },
};
