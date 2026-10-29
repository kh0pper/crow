/**
 * The apps launcher's data (R1.2 PR 5): what the drawer's Apps grid, the
 * session's apps sheet and GET /dashboard/shell-api/apps show.
 *
 * Cost per call: one catalog read (catalog.js caches it 30 s) and, for a
 * project, the one pi_bot_defs query appsForProject makes. The canManage
 * lookup runs only when an extra tile is registered.
 */
import { join } from "node:path";
import { homedir } from "node:os";
import { listApps, appsForProject } from "./catalog.js";
import { launcherTiles, hasLauncherTiles, canManageProject } from "./extra-tiles.js";
import { appIconSvg } from "../dashboard/shared/app-icons.js";

export function defaultCrowHome() {
  return process.env.CROW_HOME || join(homedir(), ".crow");
}

/**
 * One app as the launcher sends it. `icon` is trusted markup from the app-icons
 * table (the manifest only names a key). A direct-mode app's href is its
 * fallback page; the client builds https://<hostname>:<directPort><path>.
 */
export function clientApp(a) {
  const out = { id: a.id, label: String(a.label), kind: a.kind, href: a.href || a.fallbackHref || "/dashboard/extensions",
    icon: appIconSvg(a.icon) || appIconSvg("package") };
  if (a.directPort != null) { out.directPort = Number(a.directPort); out.path = String(a.path || "/"); }
  return out;
}

export function clientTile(x) {
  return { id: x.id, label: x.label, href: x.href, icon: appIconSvg(x.icon) || appIconSvg("package") };
}

/**
 * The launcher for a scope (resolveScope's shape: { all } | { unassigned } |
 * { projectId, slug }). A project lists the apps its enabled bots can use;
 * anything else lists every app.
 */
export async function launcherFor(db, scope, { crowHome = defaultCrowHome(), lang = "en" } = {}) {
  const isProject = !!scope && !scope.all && !scope.unassigned && scope.projectId != null;
  const kind = isProject ? "project" : scope && scope.unassigned ? "unassigned" : "all";
  const projectSlug = isProject ? String(scope.slug) : null;
  let apps = [];
  try {
    apps = isProject ? await appsForProject(db, Number(scope.projectId), { crowHome }) : listApps({ crowHome });
  } catch (err) {
    console.warn("[launcher] app catalog failed:", err.message);
  }
  const canManage = hasLauncherTiles() && isProject ? await canManageProject(db, scope) : false;
  const tiles = launcherTiles({ scope: kind, projectSlug, lang, canManage });
  return { scope: kind, projectSlug, apps: apps.map(clientApp), tiles: tiles.map(clientTile) };
}
