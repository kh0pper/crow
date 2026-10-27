/**
 * Settings Section: Previews in Make
 *
 * The on/off switch for the preview renderer (servers/gateway/preview/renderer.js), a
 * small sandboxed, networkless browser that draws previews. The setting is
 * `previews_enabled`, local-only; an absent value means off. Off stops the renderer at
 * once, and removes the shared preview image only when asked (and only when no preview
 * container from any instance is running it). On starts the image build in the
 * background. The POST goes through /dashboard/settings, behind dashboardAuth and
 * csrfMiddleware like every section form.
 */

import { t } from "../../shared/i18n.js";
import { escapeHtml } from "../../shared/components.js";
import { csrfInput } from "../../shared/csrf.js";
import { previewsEnabled, setPreviewsEnabled, previewRenderer } from "../../../preview/renderer.js";

export default {
  id: "previews",
  group: "appearance",
  icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="14" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><polyline points="21 15 16 10 7 18"/></svg>`,
  labelKey: "settings.section.previews",
  navOrder: 30,

  async getPreview() { return ""; },

  async render({ req, db, lang }) {
    const on = await previewsEnabled(db);
    const row = "display:flex;align-items:center;gap:0.5rem;cursor:pointer;font-size:0.9rem;min-height:44px";
    return `<form method="POST">
      ${csrfInput(req)}
      <input type="hidden" name="action" value="update_previews">
      <label style="${row}">
        <input type="checkbox" name="previews" value="true"${on ? " checked" : ""} style="accent-color:var(--crow-accent);width:auto"> ${escapeHtml(t("settings.previews", lang))}
      </label>
      <label style="${row};color:var(--crow-text-muted)">
        <input type="checkbox" name="previews_remove_image" value="true" style="accent-color:var(--crow-accent);width:auto"> ${escapeHtml(t("settings.previewsRemoveImage", lang))}
      </label>
      <button type="submit" class="btn btn-secondary">${escapeHtml(t("common.save", lang))}</button>
    </form>`;
  },

  async handleAction({ req, res, db, action }) {
    if (action !== "update_previews") return false;
    const on = req.body.previews === "true";
    await setPreviewsEnabled(db, on);
    const renderer = previewRenderer();
    if (on) {
      renderer.prepare().catch(() => {});
    } else {
      await renderer.stop();
      if (req.body.previews_remove_image === "true") await renderer.removeImage();
    }
    res.redirectAfterPost("/dashboard/settings?section=previews");
    return true;
  },
};
