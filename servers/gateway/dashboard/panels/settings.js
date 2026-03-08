/**
 * Settings Panel — Integrations, identity, blog settings, theme, password
 */

import { escapeHtml, statCard, statGrid, section, formField, badge, dataTable } from "../shared/components.js";
import { getProxyStatus } from "../../proxy.js";

export default {
  id: "settings",
  name: "Settings",
  icon: "settings",
  route: "/dashboard/settings",
  navOrder: 90,

  async handler(req, res, { db, layout }) {
    // Handle POST actions
    if (req.method === "POST") {
      const { action } = req.body;

      if (action === "set_theme") {
        await db.execute({
          sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('dashboard_theme', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')",
          args: [req.body.theme, req.body.theme],
        });
        res.json({ ok: true });
        return;
      }

      if (action === "update_blog") {
        const fields = ["blog_title", "blog_tagline", "blog_author", "blog_theme"];
        for (const key of fields) {
          const value = req.body[key];
          if (value !== undefined) {
            await db.execute({
              sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')",
              args: [key, value, value],
            });
          }
        }
        res.redirect("/dashboard/settings");
        return;
      }

      if (action === "change_password") {
        const { scrypt, randomBytes, timingSafeEqual } = await import("node:crypto");
        const { setPassword } = await import("../auth.js");
        const { password, confirm } = req.body;
        if (!password || password.length < 6) {
          // Re-render with error (simplified — redirect back)
          res.redirect("/dashboard/settings?error=short");
          return;
        }
        if (password !== confirm) {
          res.redirect("/dashboard/settings?error=mismatch");
          return;
        }
        await setPassword(password);
        res.redirect("/dashboard/settings?success=password");
        return;
      }
    }

    // Build settings page
    const successMsg = req.query.success === "password"
      ? `<div class="alert alert-success">Password updated.</div>` : "";
    const errorMsg = req.query.error === "short"
      ? `<div class="alert alert-error">Password must be at least 6 characters.</div>`
      : req.query.error === "mismatch"
      ? `<div class="alert alert-error">Passwords don't match.</div>` : "";

    // Integration status
    const proxyStatus = getProxyStatus();
    let integrationRows;
    if (proxyStatus.length === 0) {
      integrationRows = [];
    } else {
      integrationRows = proxyStatus.map((s) => {
        const statusBadge = badge(
          s.status === "connected" ? "Connected" : "Error",
          s.status === "connected" ? "connected" : "error"
        );
        return [
          escapeHtml(s.name || s.id),
          statusBadge,
          `<span class="mono">${s.toolCount || 0} tools</span>`,
        ];
      });
    }
    const integrationsHtml = integrationRows.length > 0
      ? dataTable(["Integration", "Status", "Tools"], integrationRows)
      : `<p style="color:var(--crow-text-muted)">No external integrations configured. Add API keys to your <code>.env</code> file.</p>`;

    // Identity info
    let identityHtml;
    try {
      const { getOrCreateIdentity } = await import("../../../sharing/identity.js");
      const identity = await getOrCreateIdentity();
      identityHtml = `<div style="font-family:'JetBrains Mono',monospace;font-size:0.85rem">
        <div style="margin-bottom:0.5rem"><span style="color:var(--crow-text-muted)">Crow ID:</span> ${escapeHtml(identity.crowId)}</div>
        <div><span style="color:var(--crow-text-muted)">Ed25519:</span> ${escapeHtml(identity.ed25519Public?.slice(0, 16))}...</div>
      </div>`;
    } catch {
      identityHtml = `<p style="color:var(--crow-text-muted)">Identity not available.</p>`;
    }

    // Blog settings
    const blogSettings = await db.execute({
      sql: "SELECT key, value FROM dashboard_settings WHERE key LIKE 'blog_%'",
      args: [],
    });
    const bs = {};
    for (const r of blogSettings.rows) bs[r.key] = r.value;

    const blogForm = `<form method="POST">
      <input type="hidden" name="action" value="update_blog">
      ${formField("Blog Title", "blog_title", { value: bs.blog_title || "Crow Blog", placeholder: "My Blog" })}
      ${formField("Tagline", "blog_tagline", { value: bs.blog_tagline || "", placeholder: "A short description" })}
      ${formField("Default Author", "blog_author", { value: bs.blog_author || "" })}
      ${formField("Theme", "blog_theme", { type: "select", value: bs.blog_theme || "dark", options: [
        { value: "dark", label: "Dark (default)" },
        { value: "light", label: "Light" },
        { value: "serif", label: "Serif" },
      ]})}
      <button type="submit" class="btn btn-primary">Save Blog Settings</button>
    </form>`;

    // Password change
    const passwordForm = `<form method="POST">
      <input type="hidden" name="action" value="change_password">
      ${formField("New Password", "password", { type: "password", required: true, placeholder: "At least 6 characters" })}
      ${formField("Confirm Password", "confirm", { type: "password", required: true })}
      <button type="submit" class="btn btn-secondary">Change Password</button>
    </form>`;

    // Core server stats
    const memoryCount = await db.execute("SELECT COUNT(*) as c FROM memories");
    const sourceCount = await db.execute("SELECT COUNT(*) as c FROM research_sources");
    const contactCount = await db.execute("SELECT COUNT(*) as c FROM contacts WHERE is_blocked = 0");
    const postCount = await db.execute("SELECT COUNT(*) as c FROM blog_posts");

    const stats = statGrid([
      statCard("Memories", memoryCount.rows[0]?.c || 0, { delay: 0 }),
      statCard("Sources", sourceCount.rows[0]?.c || 0, { delay: 50 }),
      statCard("Contacts", contactCount.rows[0]?.c || 0, { delay: 100 }),
      statCard("Posts", postCount.rows[0]?.c || 0, { delay: 150 }),
    ]);

    const content = `
      ${successMsg}${errorMsg}
      ${stats}
      ${section("Integrations", integrationsHtml, { delay: 200 })}
      ${section("Identity", identityHtml, { delay: 250 })}
      ${section("Blog Settings", blogForm, { delay: 300 })}
      ${section("Change Password", passwordForm, { delay: 350 })}
    `;

    return layout({ title: "Settings", content });
  },
};
