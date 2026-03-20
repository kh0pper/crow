/**
 * Settings Section: Identity
 */

import { escapeHtml } from "../../shared/components.js";
import { t } from "../../shared/i18n.js";

export default {
  id: "identity",
  group: "system",
  icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`,
  labelKey: "settings.section.identity",
  navOrder: 30,

  async getPreview() {
    try {
      const { getOrCreateIdentity } = await import("../../../../sharing/identity.js");
      const identity = await getOrCreateIdentity();
      return identity.crowId?.slice(0, 12) + "..." || "";
    } catch {
      return "";
    }
  },

  async render({ lang }) {
    try {
      const { getOrCreateIdentity } = await import("../../../../sharing/identity.js");
      const identity = await getOrCreateIdentity();
      return `<div style="font-family:'JetBrains Mono',monospace;font-size:0.85rem">
        <div style="margin-bottom:0.5rem"><span style="color:var(--crow-text-muted)">${t("settings.crowId", lang)}</span> ${escapeHtml(identity.crowId)}</div>
        <div><span style="color:var(--crow-text-muted)">${t("settings.ed25519", lang)}</span> ${escapeHtml(identity.ed25519Public?.slice(0, 16))}...</div>
      </div>`;
    } catch {
      return `<p style="color:var(--crow-text-muted)">${t("settings.identityNotAvailable", lang)}</p>`;
    }
  },

  async handleAction() {
    return false;
  },
};
