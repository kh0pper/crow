/**
 * Settings Section: Blog Settings
 */

import { formField } from "../../shared/components.js";
import { t } from "../../shared/i18n.js";
import { upsertSetting } from "../registry.js";

export default {
  id: "blog",
  group: "content",
  icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`,
  labelKey: "settings.section.blog",
  navOrder: 10,

  async getPreview({ settings }) {
    return settings.blog_title || "Crow Blog";
  },

  async render({ db, lang }) {
    const result = await db.execute({
      sql: "SELECT key, value FROM dashboard_settings WHERE key LIKE 'blog_%'",
      args: [],
    });
    const bs = {};
    for (const r of result.rows) bs[r.key] = r.value;

    return `<form method="POST">
      <input type="hidden" name="action" value="update_blog">
      ${formField(t("settings.blogTitle", lang), "blog_title", { value: bs.blog_title || "Crow Blog", placeholder: "My Blog" })}
      ${formField(t("settings.tagline", lang), "blog_tagline", { value: bs.blog_tagline || "", placeholder: t("settings.taglinePlaceholder", lang) })}
      ${formField(t("settings.defaultAuthor", lang), "blog_author", { value: bs.blog_author || "" })}
      ${formField(t("settings.blogDiscovery", lang), "blog_listed", { type: "select", value: bs.blog_listed || "false", options: [
        { value: "false", label: t("settings.notListed", lang) },
        { value: "true", label: t("settings.listedInRegistry", lang) },
      ]})}
      <p style="color:var(--crow-text-muted);font-size:0.85rem;margin:-0.5rem 0 1rem">When listed, your blog appears in the Crow Blog Registry so other Crow users can discover it.</p>
      <button type="submit" class="btn btn-primary">${t("settings.saveBlogSettings", lang)}</button>
    </form>`;
  },

  async handleAction({ req, res, db, action }) {
    if (action !== "update_blog") return false;

    const fields = ["blog_title", "blog_tagline", "blog_author", "blog_theme", "blog_listed"];
    for (const key of fields) {
      const value = req.body[key];
      if (value !== undefined) {
        await upsertSetting(db, key, value);
      }
    }
    res.redirect("/dashboard/settings?section=blog");
    return true;
  },
};
