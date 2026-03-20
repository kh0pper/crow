/**
 * Settings Section Registry — Manages settings sections for the Crow's Nest settings panel.
 * Mirrors the panel-registry.js pattern.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

/** @type {Map<string, object>} */
const sections = new Map();

/** Group definitions with order and i18n label keys */
export const GROUPS = {
  general:     { order: 10, labelKey: "settings.group.general" },
  ai:          { order: 20, labelKey: "settings.group.ai" },
  connections: { order: 30, labelKey: "settings.group.connections" },
  content:     { order: 40, labelKey: "settings.group.content" },
  system:      { order: 50, labelKey: "settings.group.system" },
  account:     { order: 60, labelKey: "settings.group.account" },
};

/**
 * Register a settings section.
 * @param {object} manifest - Section module default export
 */
export function registerSettingsSection(manifest) {
  sections.set(manifest.id, manifest);
}

/**
 * Get all registered sections sorted by group order then navOrder.
 */
export function getSettingsSections() {
  return [...sections.values()].sort((a, b) => {
    const groupA = GROUPS[a.group]?.order || 99;
    const groupB = GROUPS[b.group]?.order || 99;
    if (groupA !== groupB) return groupA - groupB;
    return (a.navOrder || 0) - (b.navOrder || 0);
  });
}

/**
 * Get a section by ID.
 */
export function getSettingsSection(id) {
  return sections.get(id);
}

/**
 * Dispatch a POST action to sections sequentially until one handles it.
 * @returns {boolean} true if a section handled the action
 */
export async function dispatchAction(sectionsList, { req, res, db, action }) {
  for (const section of sectionsList) {
    if (section.handleAction) {
      const handled = await section.handleAction({ req, res, db, action });
      if (handled) return true;
    }
  }
  return false;
}

/**
 * Load add-on settings sections from ~/.crow/bundles/<id>/settings-section.js
 */
export async function loadAddonSettings() {
  const crowDir = join(homedir(), ".crow");
  const installedPath = join(crowDir, "installed.json");

  if (!existsSync(installedPath)) return;

  let installed;
  try {
    installed = JSON.parse(readFileSync(installedPath, "utf8"));
    if (!Array.isArray(installed)) return;
  } catch {
    return;
  }

  for (const addon of installed) {
    const id = typeof addon === "string" ? addon : addon?.id;
    if (!id) continue;

    const sectionPath = join(crowDir, "bundles", id, "settings-section.js");
    if (!existsSync(sectionPath)) continue;

    try {
      const mod = await import(sectionPath);
      const manifest = mod.default || mod;
      if (manifest && manifest.id && manifest.render) {
        registerSettingsSection(manifest);
      }
    } catch (err) {
      console.warn(`[settings] Failed to load add-on settings for ${id}:`, err.message);
    }
  }
}

/**
 * Shared upsert helper for dashboard_settings table.
 */
export async function upsertSetting(db, key, value) {
  await db.execute({
    sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')",
    args: [key, value, value],
  });
}
