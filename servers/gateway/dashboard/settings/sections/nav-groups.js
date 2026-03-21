/**
 * Settings Section: Navigation Groups
 *
 * Manages sidebar nav group configuration — create, rename, delete groups,
 * and move panels between groups.
 */

import { escapeHtml } from "../../shared/components.js";
import { t } from "../../shared/i18n.js";
import { upsertSetting } from "../registry.js";

export default {
  id: "nav-groups",
  group: "general",
  icon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/></svg>`,
  labelKey: "settings.section.navGroups",
  navOrder: 5,

  async getPreview({ settings }) {
    try {
      const groups = JSON.parse(settings.nav_groups || "[]");
      return `${groups.length} ${groups.length === 1 ? "group" : "groups"}`;
    } catch {
      return "Default";
    }
  },

  async render({ req, db, lang }) {
    const [groupsResult, assignmentsResult] = await Promise.all([
      db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = 'nav_groups'", args: [] }),
      db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = 'nav_panel_assignments'", args: [] }),
    ]);

    let groups = [];
    let assignments = {};
    try { groups = JSON.parse(groupsResult.rows[0]?.value || "[]"); } catch { /* empty */ }
    try { assignments = JSON.parse(assignmentsResult.rows[0]?.value || "{}"); } catch { /* empty */ }

    if (groups.length === 0) {
      return `<p style="color:var(--crow-text-muted);font-size:0.9rem;margin-bottom:1rem">${escapeHtml(t("navGroups.noGroups", lang))}</p>
      <form method="POST" style="margin-top:1rem">
        <input type="hidden" name="action" value="create_nav_group">
        <div style="display:flex;gap:0.5rem;align-items:center">
          <input type="text" name="group_name" placeholder="${escapeHtml(t("navGroups.newGroupName", lang))}" required maxlength="30" style="flex:1">
          <button type="submit" class="btn btn-primary">${escapeHtml(t("navGroups.createGroup", lang))}</button>
        </div>
      </form>`;
    }

    // Build reverse map: groupId -> [panelId, ...]
    const groupPanels = {};
    for (const g of groups) groupPanels[g.id] = [];
    for (const [panelId, groupId] of Object.entries(assignments)) {
      if (groupPanels[groupId]) {
        groupPanels[groupId].push(panelId);
      }
    }

    // Group option list for dropdowns
    const groupOptions = groups.map((g) => `<option value="${escapeHtml(g.id)}">${escapeHtml(g.name)}</option>`).join("");

    const groupsHtml = groups.map((g, index) => {
      const panels = groupPanels[g.id] || [];
      const panelsHtml = panels.length > 0
        ? panels.map((pid) => `
          <div style="display:flex;align-items:center;justify-content:space-between;padding:0.4rem 0.75rem;font-size:0.85rem;color:var(--crow-text-secondary);border-bottom:1px solid var(--crow-border-subtle,rgba(255,255,255,0.04))">
            <span>${escapeHtml(pid)}</span>
            <form method="POST" style="display:inline">
              <input type="hidden" name="action" value="move_panel_to_group">
              <input type="hidden" name="panel_id" value="${escapeHtml(pid)}">
              <select name="target_group" onchange="this.form.submit()" style="font-size:0.8rem;padding:0.2rem 0.4rem;background:var(--crow-bg-elevated);color:var(--crow-text-primary);border:1px solid var(--crow-border);border-radius:4px">
                ${groups.map((gg) => `<option value="${escapeHtml(gg.id)}"${gg.id === g.id ? " selected" : ""}>${escapeHtml(gg.name)}</option>`).join("")}
              </select>
            </form>
          </div>`).join("")
        : `<div style="padding:0.5rem 0.75rem;font-size:0.8rem;color:var(--crow-text-muted);font-style:italic">${escapeHtml(t("navGroups.noPanels", lang))}</div>`;

      return `
      <div style="background:var(--crow-bg-surface);border:1px solid var(--crow-border);border-radius:8px;margin-bottom:1rem;overflow:hidden">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:0.75rem;border-bottom:1px solid var(--crow-border);background:var(--crow-bg-elevated)">
          <div style="display:flex;align-items:center;gap:0.5rem">
            <span style="font-weight:600;font-size:0.9rem">${escapeHtml(g.name)}</span>
            <span style="font-size:0.75rem;color:var(--crow-text-muted)">${panels.length} panel${panels.length !== 1 ? "s" : ""}</span>
            ${g.collapsed ? `<span style="font-size:0.7rem;color:var(--crow-text-muted);background:var(--crow-bg-deep);padding:0.1rem 0.4rem;border-radius:4px">${escapeHtml(t("navGroups.collapsed", lang))}</span>` : ""}
          </div>
          <div style="display:flex;gap:0.25rem">
            <form method="POST" style="display:inline">
              <input type="hidden" name="action" value="rename_nav_group">
              <input type="hidden" name="group_id" value="${escapeHtml(g.id)}">
              <input type="text" name="new_name" placeholder="${escapeHtml(g.name)}" maxlength="30" style="width:100px;font-size:0.8rem;padding:0.2rem 0.4rem;background:var(--crow-bg-deep);color:var(--crow-text-primary);border:1px solid var(--crow-border);border-radius:4px">
              <button type="submit" class="btn btn-secondary" style="font-size:0.75rem;padding:0.2rem 0.5rem">${escapeHtml(t("navGroups.rename", lang))}</button>
            </form>
            ${panels.length === 0 ? `
            <form method="POST" style="display:inline">
              <input type="hidden" name="action" value="delete_nav_group">
              <input type="hidden" name="group_id" value="${escapeHtml(g.id)}">
              <button type="submit" class="btn btn-secondary" style="font-size:0.75rem;padding:0.2rem 0.5rem;color:var(--crow-error,#e55)">${escapeHtml(t("common.delete", lang))}</button>
            </form>` : ""}
          </div>
        </div>
        ${panelsHtml}
      </div>`;
    }).join("");

    return `
    <p style="color:var(--crow-text-muted);font-size:0.85rem;margin-bottom:1rem">${escapeHtml(t("navGroups.description", lang))}</p>
    ${groupsHtml}
    <form method="POST" style="margin-top:1rem">
      <input type="hidden" name="action" value="create_nav_group">
      <div style="display:flex;gap:0.5rem;align-items:center">
        <input type="text" name="group_name" placeholder="${escapeHtml(t("navGroups.newGroupName", lang))}" required maxlength="30" style="flex:1">
        <button type="submit" class="btn btn-primary">${escapeHtml(t("navGroups.createGroup", lang))}</button>
      </div>
    </form>`;
  },

  async handleAction({ req, res, db, action }) {
    if (action === "rename_nav_group") {
      const { group_id, new_name } = req.body;
      if (!group_id || !new_name || !new_name.trim()) return false;

      const result = await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = 'nav_groups'", args: [] });
      let groups;
      try { groups = JSON.parse(result.rows[0]?.value || "[]"); } catch { return false; }

      const group = groups.find((g) => g.id === group_id);
      if (group) {
        group.name = new_name.trim().slice(0, 30);
        await upsertSetting(db, "nav_groups", JSON.stringify(groups));
      }
      res.redirect("/dashboard/settings?section=nav-groups");
      return true;
    }

    if (action === "delete_nav_group") {
      const { group_id } = req.body;
      if (!group_id) return false;

      const [groupsResult, assignmentsResult] = await Promise.all([
        db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = 'nav_groups'", args: [] }),
        db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = 'nav_panel_assignments'", args: [] }),
      ]);

      let groups, assignments;
      try { groups = JSON.parse(groupsResult.rows[0]?.value || "[]"); } catch { return false; }
      try { assignments = JSON.parse(assignmentsResult.rows[0]?.value || "{}"); } catch { assignments = {}; }

      // Only delete if no panels assigned
      const hasAssigned = Object.values(assignments).some((gid) => gid === group_id);
      if (hasAssigned) {
        res.redirect("/dashboard/settings?section=nav-groups");
        return true;
      }

      groups = groups.filter((g) => g.id !== group_id);
      await upsertSetting(db, "nav_groups", JSON.stringify(groups));
      res.redirect("/dashboard/settings?section=nav-groups");
      return true;
    }

    if (action === "create_nav_group") {
      const { group_name } = req.body;
      if (!group_name || !group_name.trim()) return false;

      const name = group_name.trim().slice(0, 30);
      const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      if (!id) return false;

      const result = await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = 'nav_groups'", args: [] });
      let groups;
      try { groups = JSON.parse(result.rows[0]?.value || "[]"); } catch { groups = []; }

      // Don't create duplicate
      if (groups.find((g) => g.id === id)) {
        res.redirect("/dashboard/settings?section=nav-groups");
        return true;
      }

      groups.push({ id, name, collapsed: false });
      await upsertSetting(db, "nav_groups", JSON.stringify(groups));
      res.redirect("/dashboard/settings?section=nav-groups");
      return true;
    }

    if (action === "move_panel_to_group") {
      const { panel_id, target_group } = req.body;
      if (!panel_id || !target_group) return false;

      const result = await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = 'nav_panel_assignments'", args: [] });
      let assignments;
      try { assignments = JSON.parse(result.rows[0]?.value || "{}"); } catch { assignments = {}; }

      assignments[panel_id] = target_group;
      await upsertSetting(db, "nav_panel_assignments", JSON.stringify(assignments));
      res.redirect("/dashboard/settings?section=nav-groups");
      return true;
    }

    if (action === "toggle_nav_group") {
      const { group_id } = req.body;
      if (!group_id) return false;

      const { toggleNavGroupCollapsed } = await import("../../nav-registry.js");
      await toggleNavGroupCollapsed(db, group_id);
      res.json({ ok: true });
      return true;
    }

    return false;
  },
};
