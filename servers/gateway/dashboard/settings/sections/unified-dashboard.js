/**
 * Settings Section: Unified Multi-Instance Dashboard (Multi-Instance group)
 *
 * Boolean opt-in for the per-instance tabs + carousel rendering at
 * /dashboard. When off, /dashboard falls back to the pre-Phase-2 redirect
 * to the first visible panel.
 *
 * Setting `unified_dashboard_enabled` is in the sync allowlist, so flipping
 * it on one paired instance propagates to every other paired instance.
 */

import { upsertSetting, readSetting } from "../registry.js";

export default {
  id: "unified-dashboard",
  group: "multiInstance",
  icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>`,
  labelKey: "settings.section.unifiedDashboard",
  navOrder: 5,

  async getPreview({ settings }) {
    const v = settings.unified_dashboard_enabled;
    // Default ON — missing setting counts as enabled.
    const enabled = v !== "false";
    return enabled ? "enabled" : "disabled";
  },

  async render({ db }) {
    const v = await readSetting(db, "unified_dashboard_enabled");
    const enabled = v !== "false";
    return `<form method="POST">
      <input type="hidden" name="action" value="set_unified_dashboard">
      <div style="margin-bottom:1rem;color:var(--crow-text-secondary);font-size:0.9rem;line-height:1.5">
        When enabled, <code>/dashboard</code> shows tabs for every trusted paired
        instance and a swipeable carousel of per-instance tile grids. Clicking a
        remote tile opens that instance's own dashboard in a new tab.
        Requires at least one trusted, online paired peer to show the carousel;
        otherwise the dashboard falls back to the single-instance view.
      </div>
      <label style="display:flex;align-items:center;gap:0.6rem;cursor:pointer">
        <input type="checkbox" name="enabled" ${enabled ? "checked" : ""}>
        <span>Enable unified multi-instance dashboard</span>
      </label>
      <div style="margin-top:1.5rem">
        <button type="submit" class="btn btn-secondary">Save</button>
      </div>
    </form>`;
  },

  async handleAction({ req, res, db, action }) {
    if (action !== "set_unified_dashboard") return false;
    const enabled = req.body.enabled === "on";
    await upsertSetting(db, "unified_dashboard_enabled", enabled ? "true" : "false");
    // Reload so the new <body class="unified-off"> state applies cleanly —
    // mid-session toggle otherwise leaves a stale class attribute.
    res.redirectAfterPost("/dashboard/settings?section=unified-dashboard");
    return true;
  },
};
