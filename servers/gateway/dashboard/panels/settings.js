/**
 * Settings Panel — iOS/Android-style grouped menu with sub-pages
 *
 * Thin orchestrator that delegates to section modules in ../settings/sections/.
 * The sidebar toggleTheme() in layout.js POSTs set_theme/set_theme_mode here —
 * POST dispatch happens BEFORE the ?section check so it works from any page.
 */

import { t } from "../shared/i18n.js";
import { escapeHtml } from "../shared/components.js";
import {
  registerSettingsSection,
  getSettingsSections,
  getSettingsSection,
  dispatchAction,
  loadAddonSettings,
} from "../settings/registry.js";
import { checkSyncKeyDrift } from "../settings/sync-allowlist.js";
import { renderSettingsMenu } from "../settings/menu-renderer.js";

// Import all built-in sections
import themeSection from "../settings/sections/theme.js";
import languageSection from "../settings/sections/language.js";
import notificationsSection from "../settings/sections/notifications.js";
import portsSection from "../settings/sections/ports.js";
import pairedInstancesSection from "../settings/sections/paired-instances.js";
import syncProfilesSection from "../settings/sections/sync-profiles.js";
import sharedStorageSection from "../settings/sections/shared-storage.js";
import auditLogSection from "../settings/sections/audit-log.js";
import sharedContextSection from "../settings/sections/shared-context.js";
import connectionsSection from "../settings/sections/connections.js";
import helpSetupSection from "../settings/sections/help-setup.js";
import integrationsSection from "../settings/sections/integrations.js";
import blogSection from "../settings/sections/blog.js";
import discoverySection from "../settings/sections/discovery.js";
import updatesSection from "../settings/sections/updates.js";
import deviceContextSection from "../settings/sections/device-context.js";
import identitySection from "../settings/sections/identity.js";
import passwordSection from "../settings/sections/password.js";
import twoFactorSection from "../settings/sections/two-factor.js";
import navGroupsSection from "../settings/sections/nav-groups.js";
import llmSection from "../settings/sections/llm.js";
import unifiedDashboardSection from "../settings/sections/unified-dashboard.js";
// NOTE: ai-provider.js + providers.js deleted; their responsibilities are
// absorbed by llmSection.providers-tab (cloud add + registry view). The
// four remaining profile sections (ai-profiles, tts-profiles, stt-profiles,
// vision-profiles) still exist as files but are no longer registered
// here — llmSection.profiles-tab composes them so there's ONE AI entry
// in the Settings menu per the plan's verification target.

// Register built-in sections
registerSettingsSection(navGroupsSection);
registerSettingsSection(themeSection);
registerSettingsSection(languageSection);
registerSettingsSection(llmSection);
registerSettingsSection(notificationsSection);
registerSettingsSection(portsSection);
registerSettingsSection(unifiedDashboardSection);
registerSettingsSection(pairedInstancesSection);
registerSettingsSection(syncProfilesSection);
registerSettingsSection(sharedStorageSection);
registerSettingsSection(auditLogSection);
registerSettingsSection(sharedContextSection);
registerSettingsSection(connectionsSection);
registerSettingsSection(helpSetupSection);
registerSettingsSection(integrationsSection);
registerSettingsSection(blogSection);
registerSettingsSection(discoverySection);
registerSettingsSection(updatesSection);
registerSettingsSection(deviceContextSection);
registerSettingsSection(identitySection);
registerSettingsSection(passwordSection);
registerSettingsSection(twoFactorSection);

// Load add-on settings (async, non-blocking), then run the advisory
// sync-allowlist drift check once every section (built-in + add-on) is
// registered. Advisory only — never blocks startup.
loadAddonSettings()
  .catch(err => console.warn("[settings] Add-on settings load error:", err.message))
  .finally(() => {
    try { checkSyncKeyDrift(getSettingsSections()); } catch (err) {
      console.warn("[settings] sync-allowlist drift check failed:", err.message);
    }
  });

export default {
  id: "settings",
  name: "Settings",
  icon: "settings",
  route: "/dashboard/settings",
  navOrder: 90,
  category: "system",

  async handler(req, res, { db, layout, lang }) {
    const sectionId = req.query.section;

    // POST: dispatch to sections (must happen before section check
    // so sidebar theme toggle works from any dashboard page)
    if (req.method === "POST") {
      const { action } = req.body;
      const handled = await dispatchAction(getSettingsSections(), { req, res, db, action });
      if (handled) return;
    }

    // Sub-page: render individual section
    if (sectionId) {
      // Alias map: resolve deprecated section ids to their replacements.
      const SECTION_ALIASES = {
        tts: "tts-profiles",
        "companion-voice": "companion",
      };
      const resolvedId = SECTION_ALIASES[sectionId] || sectionId;
      const section = getSettingsSection(resolvedId);
      if (!section) return res.redirect("/dashboard/settings");
      const html = await section.render({ req, res, db, lang });
      const sectionLabel = t(section.labelKey, lang);
      // Breadcrumb: "← Settings / <Section>" so the active location is obvious
      // on every sub-page (self-contained styles; no dependency on the menu CSS).
      const crumb = `<style>
        .settings-breadcrumb { display:flex; align-items:center; gap:0.4rem; font-size:0.9rem; margin-bottom:1rem; }
        .settings-breadcrumb a { color:var(--crow-accent); text-decoration:none; display:inline-flex; align-items:center; gap:0.3rem; }
        .settings-breadcrumb a:hover { text-decoration:underline; }
        .settings-breadcrumb-sep { color:var(--crow-text-muted); }
        .settings-breadcrumb-current { color:var(--crow-text-muted); }
      </style>
      <nav class="settings-breadcrumb" aria-label="Breadcrumb">
        <a href="/dashboard/settings">&larr; ${escapeHtml(t("settings.backToSettings", lang))}</a>
        <span class="settings-breadcrumb-sep">/</span>
        <span class="settings-breadcrumb-current">${escapeHtml(sectionLabel)}</span>
      </nav>`;
      return layout({ title: sectionLabel, content: crumb + html });
    }

    // Main menu: grouped menu rows
    const menu = await renderSettingsMenu(getSettingsSections(), db, lang);
    return layout({ title: t("settings.pageTitle", lang), content: menu });
  },
};
