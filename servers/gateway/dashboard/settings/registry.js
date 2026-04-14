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
  general:       { order: 10, labelKey: "settings.group.general" },
  ai:            { order: 20, labelKey: "settings.group.ai" },
  connections:   { order: 30, labelKey: "settings.group.connections" },
  content:       { order: 40, labelKey: "settings.group.content" },
  multiInstance: { order: 45, labelKey: "settings.group.multiInstance" },
  system:        { order: 50, labelKey: "settings.group.system" },
  account:       { order: 60, labelKey: "settings.group.account" },
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

import { isSyncable } from "./sync-allowlist.js";
import { getOrCreateLocalInstanceId } from "../../instance-registry.js";

// Optional InstanceSyncManager injection so writeSetting() can broadcast
// mutations to paired peers. See servers/gateway/index.js startup wiring.
let _settingsSyncManager = null;
export function setSettingsSyncManager(mgr) { _settingsSyncManager = mgr || null; }
async function emitSettingsSync(op, row) {
  if (!_settingsSyncManager) return;
  try { await _settingsSyncManager.emitChange("dashboard_settings", op, row); } catch {}
}

/**
 * Read a setting with scope resolution.
 * Per-instance override (dashboard_settings_overrides row for this instance) wins;
 * otherwise falls back to the global row in dashboard_settings.
 *
 * @param {import("@libsql/client").Client} db
 * @param {string} key
 * @returns {Promise<string|null>}
 */
export async function readSetting(db, key) {
  const localId = getOrCreateLocalInstanceId();
  const override = await db.execute({
    sql: `SELECT value FROM dashboard_settings_overrides WHERE key = ? AND instance_id = ?`,
    args: [key, localId],
  });
  if (override.rows[0]?.value !== undefined) return override.rows[0].value;
  const globalRow = await db.execute({
    sql: `SELECT value FROM dashboard_settings WHERE key = ?`,
    args: [key],
  });
  return globalRow.rows[0]?.value ?? null;
}

/**
 * Read multiple settings matching a LIKE pattern (e.g. "integration_%").
 * Applies the same scope resolution per-key.
 */
export async function readSettings(db, pattern) {
  const localId = getOrCreateLocalInstanceId();
  const out = new Map();
  const globals = await db.execute({
    sql: `SELECT key, value FROM dashboard_settings WHERE key LIKE ?`,
    args: [pattern],
  });
  for (const r of globals.rows) out.set(r.key, r.value);
  const overrides = await db.execute({
    sql: `SELECT key, value FROM dashboard_settings_overrides WHERE key LIKE ? AND instance_id = ?`,
    args: [pattern, localId],
  });
  for (const r of overrides.rows) out.set(r.key, r.value);
  return out;
}

/**
 * Write a setting with explicit scope.
 *
 * scope:
 *   - "global" → dashboard_settings row (synced if key in SYNC_ALLOWLIST).
 *     Also clears any local override for this instance so the global row is effective.
 *   - "local"  → dashboard_settings_overrides row keyed by (key, instance_id).
 *     Never syncs. Takes precedence over the global row on reads.
 *
 * allowLocalFallback: when scope="global" and the key is NOT in the allowlist,
 * silently downgrade to local. Default true (preserves legacy upsertSetting behavior).
 */
export async function writeSetting(db, key, value, opts = {}) {
  const { scope = "global", allowLocalFallback = true } = opts;

  let effectiveScope = scope;
  if (scope === "global" && !isSyncable(key)) {
    if (!allowLocalFallback) {
      const err = new Error(`Setting key "${key}" is not in the sync allowlist (fail-closed).`);
      err.code = "NotSyncable";
      throw err;
    }
    effectiveScope = "local";
  }

  if (effectiveScope === "local") {
    const localId = getOrCreateLocalInstanceId();
    await db.execute({
      sql: `INSERT INTO dashboard_settings_overrides (key, instance_id, value, updated_at)
            VALUES (?, ?, ?, datetime('now'))
            ON CONFLICT(key, instance_id) DO UPDATE SET
              value = excluded.value, updated_at = datetime('now')`,
      args: [key, localId, value],
    });
    return { scope: "local", instance_id: localId };
  }

  // global — upsert into dashboard_settings (PK on key, untouched for backward compat).
  await db.execute({
    sql: `INSERT INTO dashboard_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    args: [key, value],
  });
  // Emit to peers — filter happens inside InstanceSyncManager.
  await emitSettingsSync("update", { key, value, instance_id: null });
  return { scope: "global", instance_id: null };
}

/**
 * Delete a per-instance override, restoring the global row as the effective value.
 */
export async function deleteLocalSetting(db, key) {
  const localId = getOrCreateLocalInstanceId();
  await db.execute({
    sql: `DELETE FROM dashboard_settings_overrides WHERE key = ? AND instance_id = ?`,
    args: [key, localId],
  });
}

/**
 * Resolve current scope of a key: "local" if an override exists for this instance,
 * "global" if only the global row exists, "none" if neither.
 */
export async function getSettingScope(db, key) {
  const localId = getOrCreateLocalInstanceId();
  const override = await db.execute({
    sql: `SELECT 1 FROM dashboard_settings_overrides WHERE key = ? AND instance_id = ?`,
    args: [key, localId],
  });
  if (override.rows.length > 0) return "local";
  const globalRow = await db.execute({
    sql: `SELECT 1 FROM dashboard_settings WHERE key = ?`,
    args: [key],
  });
  if (globalRow.rows.length > 0) return "global";
  return "none";
}

export { isSyncable };

/**
 * Legacy shared upsert helper for dashboard_settings table.
 * Writes to the "global" scope. For allowlisted keys this means the row
 * replicates to peers; for non-allowlisted keys it silently falls back
 * to local scope (preserves prior local-only behavior).
 */
export async function upsertSetting(db, key, value) {
  await writeSetting(db, key, value, { scope: "global", allowLocalFallback: true });
}
