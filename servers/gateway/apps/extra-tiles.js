/**
 * Extra launcher tiles: page links other features add after the app tiles, in
 * the drawer's Apps grid and in a session's apps sheet (R1.2 PR 5's Add-tile hook).
 *
 *   registerLauncherTile({ id, labelKey, icon, when(ctx), href(ctx) })
 *   launcherTiles(ctx) -> [{ id, label, icon, href }]
 *
 * ctx = { scope, projectSlug, lang, canManage }:
 *   scope        "project" | "all" | "unassigned"
 *   projectSlug  the scoped project's slug, or null
 *   canManage    the viewer may change this project (canManageProject below)
 *
 * A tile is always a page link, never embedded. `icon` is an app-icons KEY
 * (lookup only); the label is t(labelKey, lang). Registration order is kept.
 */
import { t } from "../dashboard/shared/i18n.js";

const tiles = [];

export function registerLauncherTile(def) {
  if (!def || typeof def.id !== "string" || !def.id) throw new TypeError("launcher tile needs an id");
  if (typeof def.labelKey !== "string" || typeof def.href !== "function") throw new TypeError(`launcher tile ${def.id}: labelKey and href(ctx) are required`);
  if (tiles.some((x) => x.id === def.id)) throw new Error(`launcher tile ${def.id} is already registered`);
  tiles.push(Object.freeze({ id: def.id, labelKey: def.labelKey, icon: typeof def.icon === "string" ? def.icon : null,
    when: typeof def.when === "function" ? def.when : () => true, href: def.href }));
}

/** True when any tile is registered (lets callers skip the canManage lookup). */
export function hasLauncherTiles() { return tiles.length > 0; }

/** Test hook. */
export function _resetLauncherTiles() { tiles.length = 0; }

export function launcherTiles(ctx) {
  const out = [];
  for (const tile of tiles) {
    let on = false;
    try { on = !!tile.when(ctx); } catch (err) { console.warn(`[launcher] tile ${tile.id} when() threw:`, err.message); }
    if (!on) continue;
    let href = null;
    try { href = tile.href(ctx); } catch (err) { console.warn(`[launcher] tile ${tile.id} href() threw:`, err.message); }
    // Same-origin paths only: a tile is a page in this dashboard.
    if (typeof href !== "string" || !href.startsWith("/") || href.startsWith("//")) continue;
    out.push({ id: tile.id, label: t(tile.labelKey, ctx && ctx.lang), icon: tile.icon, href });
  }
  return out;
}

/**
 * The dashboard user is the local owner, so "may change this project" means
 * the scoped project is a live project_spaces row (the caller resolved it with
 * the live-project rule) whose local member row (contact_id IS NULL, not
 * revoked; servers/shared/project-acl.js) is the owner. Everything, Unassigned
 * and a visited project (no local-owner row) are false.
 */
export async function canManageProject(db, scope) {
  if (!scope || scope.all || scope.unassigned || scope.projectId == null) return false;
  try {
    const { effectiveCapabilities } = await import("../../shared/project-acl.js");
    const eff = await effectiveCapabilities(db, Number(scope.projectId), null);
    return !!eff && eff.role === "owner";
  } catch (err) {
    console.warn("[launcher] canManage lookup failed:", err.message);
    return false;
  }
}
