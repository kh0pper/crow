/**
 * Settings Section: Theme
 *
 * IMPORTANT: The sidebar toggleTheme() in layout.js POSTs set_theme / set_theme_mode
 * from every dashboard page. These AJAX handlers must remain working.
 */

import { formField } from "../../shared/components.js";
import { upsertSetting } from "../registry.js";

export default {
  id: "theme",
  group: "general",
  icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`,
  labelKey: "settings.section.theme",
  navOrder: 10,

  async getPreview({ settings }) {
    const mode = settings.blog_theme_mode || "dark";
    const glass = settings.blog_theme_glass === "true";
    const parts = [mode.charAt(0).toUpperCase() + mode.slice(1)];
    if (glass) parts.push("Glass");
    return parts.join(" + ");
  },

  async render({ db, lang }) {
    const result = await db.execute({
      sql: "SELECT key, value FROM dashboard_settings WHERE key LIKE 'blog_theme_%'",
      args: [],
    });
    const bs = {};
    for (const r of result.rows) bs[r.key] = r.value;

    const currentThemeMode = bs.blog_theme_mode || "dark";
    const currentGlass = bs.blog_theme_glass === "true";
    const currentSerif = bs.blog_theme_serif !== "false";
    const currentDashMode = bs.blog_theme_dashboard_mode || "";
    const currentBlogMode = bs.blog_theme_blog_mode || "";

    return `<form method="POST">
      <input type="hidden" name="action" value="update_theme">
      <div style="display:flex;flex-wrap:wrap;gap:1.5rem;margin-bottom:1.25rem">
        <div style="flex:1;min-width:160px">
          <label style="display:block;font-size:0.8rem;color:var(--crow-text-muted);margin-bottom:6px;font-weight:500">Color Mode</label>
          <div style="display:flex;gap:0.5rem">
            <label style="display:flex;align-items:center;gap:0.4rem;cursor:pointer;font-size:0.9rem">
              <input type="radio" name="theme_mode" value="dark"${currentThemeMode === "dark" ? " checked" : ""} style="accent-color:var(--crow-accent);width:auto"> Dark
            </label>
            <label style="display:flex;align-items:center;gap:0.4rem;cursor:pointer;font-size:0.9rem">
              <input type="radio" name="theme_mode" value="light"${currentThemeMode === "light" ? " checked" : ""} style="accent-color:var(--crow-accent);width:auto"> Light
            </label>
          </div>
        </div>
        <div style="flex:1;min-width:160px">
          <label style="display:block;font-size:0.8rem;color:var(--crow-text-muted);margin-bottom:6px;font-weight:500">Glass Style</label>
          <label style="display:flex;align-items:center;gap:0.4rem;cursor:pointer;font-size:0.9rem">
            <input type="checkbox" name="theme_glass" value="true"${currentGlass ? " checked" : ""} style="accent-color:var(--crow-accent);width:auto"> Enable glass aesthetic
          </label>
        </div>
        <div style="flex:1;min-width:160px">
          <label style="display:block;font-size:0.8rem;color:var(--crow-text-muted);margin-bottom:6px;font-weight:500">Serif Headings</label>
          <label style="display:flex;align-items:center;gap:0.4rem;cursor:pointer;font-size:0.9rem">
            <input type="checkbox" name="theme_serif" value="true"${currentSerif ? " checked" : ""} style="accent-color:var(--crow-accent);width:auto"> Use Fraunces for headings
          </label>
        </div>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:1rem;margin-bottom:1.25rem">
        ${formField("Dashboard Override", "theme_dashboard_mode", { type: "select", value: currentDashMode, options: [
          { value: "", label: "Use global" },
          { value: "dark", label: "Dark" },
          { value: "light", label: "Light" },
        ]})}
        ${formField("Blog Override", "theme_blog_mode", { type: "select", value: currentBlogMode, options: [
          { value: "", label: "Use global" },
          { value: "dark", label: "Dark" },
          { value: "light", label: "Light" },
        ]})}
      </div>
      <p style="color:var(--crow-text-muted);font-size:0.8rem;margin-bottom:1rem">Glass adds iOS-inspired blur and transparency. Per-surface overrides let you run the dashboard in dark while the blog is light (or vice versa). Songbook follows the blog theme.</p>
      <button type="submit" class="btn btn-primary">Save Theme</button>
    </form>
    <script>
    // Handle unchecked checkboxes (send "false" instead of omitting)
    document.querySelector('form [name="action"][value="update_theme"]')?.closest('form')?.addEventListener('submit', function(e) {
      if (!this.querySelector('[name="theme_glass"]:checked')) {
        var h = document.createElement('input'); h.type='hidden'; h.name='theme_glass'; h.value='false';
        this.appendChild(h);
      }
      if (!this.querySelector('[name="theme_serif"]:checked')) {
        var h = document.createElement('input'); h.type='hidden'; h.name='theme_serif'; h.value='false';
        this.appendChild(h);
      }
    });
    <\/script>`;
  },

  async handleAction({ req, res, db, action }) {
    if (action === "set_theme") {
      await upsertSetting(db, "dashboard_theme", req.body.theme);
      res.json({ ok: true });
      return true;
    }

    if (action === "set_kiosk") {
      await upsertSetting(db, "kiosk_mode", req.body.kiosk === "true" ? "true" : "false");
      res.json({ ok: true });
      return true;
    }

    if (action === "set_theme_mode") {
      const mode = req.body.mode === "light" ? "light" : "dark";
      await upsertSetting(db, "blog_theme_mode", mode);
      res.json({ ok: true });
      return true;
    }

    if (action === "update_theme") {
      const themeFields = {
        blog_theme_mode: req.body.theme_mode,
        blog_theme_glass: req.body.theme_glass,
        blog_theme_serif: req.body.theme_serif,
        blog_theme_dashboard_mode: req.body.theme_dashboard_mode,
        blog_theme_blog_mode: req.body.theme_blog_mode,
      };
      for (const [key, value] of Object.entries(themeFields)) {
        if (value !== undefined) {
          await upsertSetting(db, key, value);
        }
      }
      res.redirectAfterPost("/dashboard/settings?section=theme");
      return true;
    }

    return false;
  },
};
