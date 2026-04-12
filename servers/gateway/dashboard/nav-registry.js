/**
 * Nav Registry — Collapsible category groups for sidebar navigation
 *
 * Stores nav configuration in dashboard_settings (2 keys: nav_groups, nav_panel_assignments).
 * Seeds defaults on first load. Auto-assigns panels not in assignments by manifest category.
 */

import { upsertSetting } from "./settings/registry.js";

/** Default nav groups seeded on first load */
const DEFAULT_NAV_GROUPS = [
  { id: "core", name: "Core", collapsed: false },
  { id: "content", name: "Content", collapsed: false },
  { id: "media", name: "Media", collapsed: false },
  { id: "tools", name: "Tools", collapsed: false },
  { id: "system", name: "System", collapsed: true },
];

/** Default panel-to-group assignments */
const DEFAULT_NAV_PANEL_ASSIGNMENTS = {
  nest: "core",
  contacts: "core",
  memory: "core",
  messages: "core",
  blog: "content",
  projects: "content",
  files: "tools",
  extensions: "tools",
  skills: "tools",
  settings: "system",
};

/** Category field on panel manifest → nav group id */
const CATEGORY_TO_GROUP = {
  core: "core",
  content: "content",
  media: "media",
  ai: "tools",
  social: "core",
  productivity: "tools",
  finance: "tools",
  infrastructure: "tools",
  automation: "tools",
  education: "content",
  system: "system",
};

/**
 * Resolve nav groups for sidebar rendering.
 * Loads from dashboard_settings, seeds defaults if missing, merges with visible panels.
 *
 * @param {object} db - libsql client
 * @param {Array} visiblePanels - from getVisiblePanels()
 * @returns {Array} navGroups: [{ id, name, collapsed, panels: [{ id, name, icon, route, navOrder }] }]
 */
export async function resolveNavGroups(db, visiblePanels) {
  // Load stored config
  const [groupsResult, assignmentsResult] = await Promise.all([
    db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = 'nav_groups'", args: [] }),
    db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = 'nav_panel_assignments'", args: [] }),
  ]);

  let groups;
  let assignments;
  let needsSeed = false;

  if (groupsResult.rows.length === 0 && assignmentsResult.rows.length === 0) {
    // First load — seed defaults
    groups = structuredClone(DEFAULT_NAV_GROUPS);
    assignments = { ...DEFAULT_NAV_PANEL_ASSIGNMENTS };
    needsSeed = true;
  } else {
    try {
      groups = groupsResult.rows.length > 0 ? JSON.parse(groupsResult.rows[0].value) : structuredClone(DEFAULT_NAV_GROUPS);
    } catch {
      groups = structuredClone(DEFAULT_NAV_GROUPS);
    }
    try {
      assignments = assignmentsResult.rows.length > 0 ? JSON.parse(assignmentsResult.rows[0].value) : { ...DEFAULT_NAV_PANEL_ASSIGNMENTS };
    } catch {
      assignments = { ...DEFAULT_NAV_PANEL_ASSIGNMENTS };
    }
  }

  // Auto-assign any panels not in assignments
  let assignmentsChanged = false;
  for (const panel of visiblePanels) {
    if (!(panel.id in assignments)) {
      const groupId = CATEGORY_TO_GROUP[panel.category] || "tools";
      // Make sure the group exists
      if (!groups.find((g) => g.id === groupId)) {
        groups.push({ id: groupId, name: groupId.charAt(0).toUpperCase() + groupId.slice(1), collapsed: false });
      }
      assignments[panel.id] = groupId;
      assignmentsChanged = true;
    }
  }

  if (needsSeed || assignmentsChanged) {
    await Promise.all([
      upsertSetting(db, "nav_groups", JSON.stringify(groups)),
      upsertSetting(db, "nav_panel_assignments", JSON.stringify(assignments)),
    ]);
  }

  // Build panel lookup
  const panelMap = new Map();
  for (const p of visiblePanels) {
    panelMap.set(p.id, p);
  }

  // Build groups with their panels
  const result = groups.map((g) => {
    const groupPanels = [];
    for (const [panelId, groupId] of Object.entries(assignments)) {
      if (groupId === g.id && panelMap.has(panelId)) {
        groupPanels.push(panelMap.get(panelId));
      }
    }
    groupPanels.sort((a, b) => (a.navOrder || 0) - (b.navOrder || 0));
    return {
      id: g.id,
      name: g.name,
      collapsed: g.collapsed,
      panels: groupPanels,
    };
  });

  // Filter out empty groups
  return result.filter((g) => g.panels.length > 0);
}

/**
 * Toggle the collapsed state of a nav group and persist to DB.
 * @param {object} db - libsql client
 * @param {string} groupId - group id to toggle
 */
export async function toggleNavGroupCollapsed(db, groupId) {
  const result = await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = 'nav_groups'", args: [] });
  let groups;
  try {
    groups = result.rows.length > 0 ? JSON.parse(result.rows[0].value) : structuredClone(DEFAULT_NAV_GROUPS);
  } catch {
    groups = structuredClone(DEFAULT_NAV_GROUPS);
  }

  const group = groups.find((g) => g.id === groupId);
  if (group) {
    group.collapsed = !group.collapsed;
    await upsertSetting(db, "nav_groups", JSON.stringify(groups));
  }
}

/**
 * Update nav configuration (groups and/or assignments).
 * @param {object} db - libsql client
 * @param {object} config - { groups?, assignments? }
 */
export async function updateNavConfig(db, { groups, assignments }) {
  const promises = [];
  if (groups) {
    promises.push(upsertSetting(db, "nav_groups", JSON.stringify(groups)));
  }
  if (assignments) {
    promises.push(upsertSetting(db, "nav_panel_assignments", JSON.stringify(assignments)));
  }
  if (promises.length > 0) {
    await Promise.all(promises);
  }
}
