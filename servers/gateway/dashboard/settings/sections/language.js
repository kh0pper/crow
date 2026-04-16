/**
 * Settings Section: Language
 */

import { formField } from "../../shared/components.js";
import { t, SUPPORTED_LANGS } from "../../shared/i18n.js";
import { upsertSetting } from "../registry.js";

export default {
  id: "language",
  group: "general",
  icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`,
  labelKey: "settings.section.language",
  navOrder: 20,

  async getPreview({ settings }) {
    const labels = { en: "English", es: "Español" };
    const lang = settings.language || "en";
    return labels[lang] || lang;
  },

  async render({ req, db, lang }) {
    const langResult = await db.execute({
      sql: "SELECT value FROM dashboard_settings WHERE key = 'language'", args: []
    });
    const { parseCookies } = await import("../../auth.js");
    const currentLang = langResult.rows[0]?.value || parseCookies(req).crow_lang || "en";

    const langOptions = SUPPORTED_LANGS.map(code => {
      const labels = { en: "English", es: "Español" };
      return { value: code, label: labels[code] || code };
    });

    return `<form method="POST">
      <input type="hidden" name="action" value="set_language">
      ${formField(t("settings.languageLabel", lang), "language", { type: "select", value: currentLang, options: langOptions })}
      <button type="submit" class="btn btn-secondary">${t("settings.saveLanguage", lang)}</button>
    </form>`;
  },

  async handleAction({ req, res, db, action }) {
    if (action !== "set_language") return false;

    const newLang = SUPPORTED_LANGS.includes(req.body.language) ? req.body.language : "en";
    await upsertSetting(db, "language", newLang);
    const secure = process.env.CROW_HOSTED || process.env.NODE_ENV === "production" ? "; Secure" : "";
    res.setHeader("Set-Cookie", `crow_lang=${newLang}; Path=/; Max-Age=${30*24*60*60}; SameSite=Strict${secure}`);
    res.redirectAfterPost("/dashboard/settings?section=language");
    return true;
  },
};
