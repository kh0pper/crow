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
 *
 * Under the switch, one status line from the renderer (buildState / lastOff); after a
 * removal, a flash from a fixed list (?previews_image=removed|in_use|building|failed),
 * never free text from the URL.
 */

import { t } from "../../shared/i18n.js";
import { escapeHtml } from "../../shared/components.js";
import { csrfInput } from "../../shared/csrf.js";
import { previewsEnabled, setPreviewsEnabled, previewRenderer } from "../../../preview/renderer.js";

const BASE = "/dashboard/settings?section=previews";

/** The renderer's last off reason → its status line (anything not listed falls through). */
const OFF_STATUS = {
  no_docker: "settings.previewsStatusNoDocker",
  sandbox_unavailable: "settings.previewsStatusSandbox",
  start_failed: "settings.previewsStatusStartFailed",
  origin_unreachable: "settings.previewsStatusPaused",
};

const IMAGE_FLASH = {
  removed: "settings.previewsImageRemoved",
  in_use: "settings.previewsImageInUse",
  building: "settings.previewsImageBuilding",
  failed: "settings.previewsImageFailed",
};

function statusKey(on, renderer) {
  if (!on) return "settings.previewsStatusOff";
  let b = "absent", off = null;
  try { b = renderer.buildState(); off = renderer.lastOff(); } catch { /* no renderer: idle */ }
  if (b === "building") return "settings.previewsStatusBuilding";
  if (b === "failed") return "settings.previewsStatusBuildFailed";
  if (OFF_STATUS[off]) return OFF_STATUS[off];
  if (b === "ready") return "settings.previewsStatusReady";
  return "settings.previewsStatusIdle";
}

export default {
  id: "previews",
  group: "appearance",
  icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="14" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><polyline points="21 15 16 10 7 18"/></svg>`,
  labelKey: "settings.section.previews",
  navOrder: 30,

  async getPreview() { return ""; },

  async render({ req, db, lang }) {
    const on = await previewsEnabled(db);
    let renderer = null;
    try { renderer = previewRenderer(); } catch { /* status falls back to idle */ }
    const status = t(statusKey(on, renderer), lang);
    const flashKey = IMAGE_FLASH[String(req?.query?.previews_image || "")] || null;
    const flash = flashKey
      ? `<div class="alert ${flashKey === "settings.previewsImageRemoved" ? "alert-success" : "alert-error"}" style="margin-bottom:0.75rem">${escapeHtml(t(flashKey, lang))}</div>`
      : "";
    const row = "display:flex;align-items:center;gap:0.5rem;cursor:pointer;font-size:0.9rem;min-height:44px";
    return `${flash}<form method="POST">
      ${csrfInput(req)}
      <input type="hidden" name="action" value="update_previews">
      <label style="${row}">
        <input type="checkbox" name="previews" value="true"${on ? " checked" : ""} style="accent-color:var(--crow-accent);width:auto"> ${escapeHtml(t("settings.previews", lang))}
      </label>
      <p data-previews-status style="margin:0 0 0.5rem;font-size:0.85rem;color:var(--crow-text-muted)">${escapeHtml(status)}</p>
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
    let flash = "";
    if (on) {
      renderer.prepare().catch(() => {});
    } else {
      await renderer.stop();
      if (req.body.previews_remove_image === "true") {
        const out = await renderer.removeImage();
        const kind = out.removed ? "removed" : out.reason === "in_use" || out.reason === "building" ? out.reason : "failed";
        if (kind === "failed") console.warn(`[preview] the preview image was not removed: ${out.reason}`);
        flash = `&previews_image=${kind}`;
      }
    }
    res.redirectAfterPost(`${BASE}${flash}`);
    return true;
  },
};
