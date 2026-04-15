/**
 * Settings Panel — iOS/Android-style grouped menu with sub-pages
 *
 * Thin orchestrator that delegates to section modules in ../settings/sections/.
 * The sidebar toggleTheme() in layout.js POSTs set_theme/set_theme_mode here —
 * POST dispatch happens BEFORE the ?section check so it works from any page.
 */

import { t } from "../shared/i18n.js";
import {
  registerSettingsSection,
  getSettingsSections,
  getSettingsSection,
  dispatchAction,
  loadAddonSettings,
} from "../settings/registry.js";
import { renderSettingsMenu } from "../settings/menu-renderer.js";

// Import all built-in sections
import themeSection from "../settings/sections/theme.js";
import languageSection from "../settings/sections/language.js";
import notificationsSection from "../settings/sections/notifications.js";
import aiProviderSection from "../settings/sections/ai-provider.js";
import providersSection from "../settings/sections/providers.js";
import pairedInstancesSection from "../settings/sections/paired-instances.js";
import syncProfilesSection from "../settings/sections/sync-profiles.js";
import auditLogSection from "../settings/sections/audit-log.js";
import sharedContextSection from "../settings/sections/shared-context.js";
import aiProfilesSection from "../settings/sections/ai-profiles.js";
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
import ttsProfilesSection from "../settings/sections/tts-profiles.js";
import sttProfilesSection from "../settings/sections/stt-profiles.js";
import visionProfilesSection from "../settings/sections/vision-profiles.js";

// Register built-in sections
registerSettingsSection(navGroupsSection);
registerSettingsSection(themeSection);
registerSettingsSection(languageSection);
registerSettingsSection(ttsProfilesSection);
registerSettingsSection(sttProfilesSection);
registerSettingsSection(visionProfilesSection);
registerSettingsSection(notificationsSection);
registerSettingsSection(aiProviderSection);
registerSettingsSection(providersSection);
registerSettingsSection(pairedInstancesSection);
registerSettingsSection(syncProfilesSection);
registerSettingsSection(auditLogSection);
registerSettingsSection(sharedContextSection);
registerSettingsSection(aiProfilesSection);
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

// Load add-on settings (async, non-blocking)
loadAddonSettings().catch(err => console.warn("[settings] Add-on settings load error:", err.message));

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
      const back = `<a href="/dashboard/settings" class="settings-back">&larr; ${t("settings.backToSettings", lang)}</a>`;
      return layout({ title: t(section.labelKey, lang), content: back + html });
    }

    // Main menu: grouped menu rows
    const menu = await renderSettingsMenu(getSettingsSections(), db, lang);
    return layout({ title: t("settings.pageTitle", lang), content: menu });
  },
};
