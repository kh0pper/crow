/**
 * App catalog: which installed bundles are apps (a web UI or a panel), and which
 * of them a project's bots can use.
 *
 * Reuses the installed.json readers the extension proxy already owns
 * (getProxiedExtensions / getManifest) instead of a third reader.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getManifest, getProxiedExtensions } from "../routes/extension-proxy.js";
import { buildEnvelope } from "../routes/perch.js";
import { remoteServersForBot, remoteBlockName } from "../../../scripts/pi-bots/remote-blocks.mjs";

const TTL_MS = 30_000;
const cache = new Map(); // crowHome -> { at, apps }

/** Test hook: drop the cached catalogs (and optionally inject a clock). */
export function _resetCatalogCache() { cache.clear(); }
let now = () => Date.now();
export function _setClock(fn) { now = fn || (() => Date.now()); }

function installedIds(crowHome) {
  try {
    const p = join(crowHome, "installed.json");
    if (!existsSync(p)) return [];
    return JSON.parse(readFileSync(p, "utf8")).map((e) => e.id).filter(Boolean);
  } catch { return []; }
}

function panelIdOf(manifest, bundleId) {
  if (!manifest?.panel) return null;
  return (typeof manifest.panel === "object" && manifest.panel.id) || bundleId;
}

function build(crowHome) {
  const proxied = new Map(getProxiedExtensions(crowHome).map((e) => [e.id, e]));
  const apps = [];
  for (const id of installedIds(crowHome)) {
    const manifest = getManifest(id, crowHome);
    if (!manifest) continue;
    const ext = proxied.get(id);
    const panel = panelIdOf(manifest, id);
    if (!ext && !panel) continue;
    const mcpServers = Array.isArray(manifest.mcpServers) ? manifest.mcpServers.map(String) : [];
    const label = ext?.label || manifest.name || id;
    if (ext) {
      const direct = ext.proxyMode === "direct";
      const desktopPath = !direct && manifest.desktop?.path ? String(manifest.desktop.path) : null;
      apps.push({
        id,
        label,
        kind: desktopPath ? "desktop" : "page",
        // Direct-mode apps cannot sit behind a subpath proxy, so they keep their own
        // origin. The gateway has no request here, so the host is left as the
        // literal "{host}" token for the caller to fill from the request.
        href: direct ? `http://{host}:${ext.port}${ext.path}` : `/proxy/${id}${ext.path}`,
        desktopPath,
        leaseDeclared: !!desktopPath && manifest.desktop?.lease === true,
        mcpServers,
      });
    } else {
      apps.push({ id, label, kind: "page", href: `/dashboard/${panel}`, desktopPath: null, leaseDeclared: false, mcpServers });
    }
  }
  return apps;
}

/** The installed apps. Cached per process (per CROW_HOME) for 30 s. */
export function listApps({ crowHome }) {
  const hit = cache.get(crowHome);
  if (hit && now() - hit.at < TTL_MS) return hit.apps;
  const apps = build(crowHome);
  cache.set(crowHome, { at: now(), apps });
  return apps;
}

/**
 * Apps any of the given bots can use: an app counts when one of its mcpServers is
 * in some bot's granted-server set.
 *
 * Decision on `crow-core` (the combined router entry, servers/core): it covers the
 * built-in memory/projects/sharing/blog/tasks servers, none of which is a UI
 * bundle, so granting crow-core grants NO bundle apps. A bundle must name its own
 * server(s) in manifest.mcpServers to be reachable.
 */
export function appsForBots(apps, grantedServerSets) {
  const granted = new Set();
  for (const set of grantedServerSets) for (const s of set) granted.add(s);
  return apps.filter((a) => a.mcpServers.some((s) => granted.has(s)));
}

/** Server names a bot def grants (remote blocks excluded). */
export async function grantedServers(db, def) {
  const { tools } = await buildEnvelope(db, def);
  const remote = new Set(remoteServersForBot(def).map((r) => remoteBlockName(r.instanceId, r.canonicalId)));
  const out = new Set();
  for (const { id } of tools) {
    if (!id.startsWith("mcp__")) continue;
    const server = id.slice(5).split("__")[0];
    if (!server || remote.has(server) || server.startsWith("crow-remote-")) continue;
    out.add(server);
  }
  return out;
}

/** Union of apps over the project's bots. */
export async function appsForProject(db, projectId, { crowHome }) {
  const { rows } = await db.execute({ sql: "SELECT bot_id, definition FROM pi_bot_defs WHERE project_id = ?", args: [projectId] });
  const sets = [];
  for (const row of rows) {
    let def = {};
    try { def = JSON.parse(row.definition || "{}") || {}; } catch { /* a corrupt def grants nothing */ }
    sets.push(await grantedServers(db, def));
  }
  return appsForBots(listApps({ crowHome }), sets);
}
