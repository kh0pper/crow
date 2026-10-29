/**
 * App catalog: which installed bundles are apps (a web UI or a panel), and which
 * of them a project's bots can use.
 *
 * Reuses the installed.json readers the extension proxy already owns
 * (getProxiedExtensions / getManifest) instead of a third reader.
 */
import { getManifest, getProxiedExtensions, readInstalled } from "../routes/extension-proxy.js";
import { getPanelForBundle } from "../dashboard/panel-registry.js";
import { effectiveCrowMcp } from "../../../scripts/pi-bots/skill-tools.mjs";
import { remoteServersForBot, remoteBlockName } from "../../../scripts/pi-bots/remote-blocks.mjs";
import bus from "../../shared/event-bus.js";

const TTL_MS = 30_000;

/**
 * A desktop path: relative, plain segments, no "..", and its last segment a
 * noVNC page (vnc.html or vnc_lite.html), so a desktop app's tile can only
 * ever frame a VNC viewer, never another page of the app. The ONE rule: the
 * catalog marks an app "desktop" only when its desktop.path passes it, and the
 * tile (app-tile.js) frames only a path that passes it.
 */
const NOVNC_PATH_RE = /^(?:[A-Za-z0-9._~-]+\/)*vnc(?:_lite)?\.html$/;
export function cleanPath(p) {
  const s = String(p == null ? "" : p).replace(/^\/+/, "");
  if (!s || s.length > 200 || !NOVNC_PATH_RE.test(s)) return null;
  if (s.split("/").some((seg) => seg === "." || seg === "..")) return null;
  return s;
}

/**
 * A full-page noVNC link pins its own settings. noVNC saves view_only per
 * origin (app/ui.js initSetting/updateSetting) and every /proxy/<id>/ page
 * shares the dashboard's origin, so after one watch-only tile any later noVNC
 * page would open view-only unless its link says otherwise (the Take over
 * sheet pins the same thing).
 */
export const NOVNC_PAGE_QUERY = "?autoconnect=true&resize=scale&view_only=false";
const cache = new Map(); // crowHome -> { at, apps }

// appsForProject's answers: db -> Map("<crowHome>\0<projectId>" -> { at, apps }).
// Keyed by the db handle too, so two databases never share an answer.
let projectCache = new WeakMap();
function clearProjectApps() { projectCache = new WeakMap(); }
/** Drop every project's cached apps (a bot def was saved: its grants may have changed). */
export function invalidateProjectApps() { clearProjectApps(); }
// Every Bot Builder save (create, wizard, tab saves, toggle, delete) emits
// pibots:defs-changed (bot-builder/defs-changed.js).
try { bus.on("pibots:defs-changed", clearProjectApps); } catch { /* no bus: the 30 s TTL still applies */ }

/** Test hook: drop the cached catalogs (and optionally inject a clock). */
export function _resetCatalogCache() { cache.clear(); clearProjectApps(); }
/** Drop every cached catalog (called when an install or remove rewrites installed.json). */
export function invalidateAppCatalog() { cache.clear(); clearProjectApps(); }
let now = () => Date.now();
export function _setClock(fn) { now = fn || (() => Date.now()); }

function build(crowHome) {
  const proxied = new Map(getProxiedExtensions(crowHome).map((e) => [e.id, e]));
  const apps = [];
  for (const { id } of readInstalled(crowHome)) {
    if (!id) continue;
    const manifest = getManifest(id, crowHome);
    if (!manifest) continue;
    const ext = proxied.get(id);
    // A bundle's panel counts only when the live registry has it (an install not
    // yet enabled in panels.json has none), and the href is that panel's real route.
    const panel = manifest.panel ? getPanelForBundle(id) : undefined;
    if (!ext && !panel) continue;
    const mcpServers = Array.isArray(manifest.mcpServers) ? manifest.mcpServers.map(String) : [];
    // The app's own name first: webUI.label names the web UI ("VNC Viewer"), not the app.
    const label = (typeof manifest.name === "string" && manifest.name) || ext?.label || id;
    // icon: the manifest's icon KEY (shared/app-icons.js resolves it; never markup).
    const icon = typeof manifest.icon === "string" && manifest.icon ? manifest.icon : null;
    const base = { id, label, icon, mcpServers, directPort: null, path: null, fallbackHref: null };
    if (ext) {
      if (ext.proxyMode === "direct") {
        // Cannot sit behind a subpath proxy: the client builds
        // https://<location.hostname>:<directPort><path> (the gateway has no
        // request here); fallbackHref is where it goes when it cannot.
        apps.push({ ...base, kind: "page", href: null, directPort: ext.port, path: ext.path, fallbackHref: "/dashboard/extensions", desktopPath: null, leaseDeclared: false });
      } else {
        // "desktop" only for a declared desktop.path that is a clean noVNC page;
        // anything else is a page app (its tile could never frame it anyway).
        const desktopPath = manifest.desktop?.path ? cleanPath(manifest.desktop.path) : null;
        // A desktop app's page is its noVNC page; a page app whose web UI is
        // itself a noVNC page (a browser from before 1.3.11) gets the same pin.
        const webPath = cleanPath(ext.path);
        const href = desktopPath ? `/proxy/${id}/${desktopPath}${NOVNC_PAGE_QUERY}`
          : webPath ? `/proxy/${id}/${webPath}${NOVNC_PAGE_QUERY}` : `/proxy/${id}${ext.path}`;
        apps.push({
          ...base,
          kind: desktopPath ? "desktop" : "page",
          href,
          desktopPath,
          leaseDeclared: !!desktopPath && manifest.desktop?.lease === true,
        });
      }
    } else {
      apps.push({ ...base, kind: "page", href: panel.route || `/dashboard/${panel.id}`, desktopPath: null, leaseDeclared: false });
    }
  }
  return Object.freeze(apps.map((a) => Object.freeze(a)));
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

/** Lazy: the bridge and the Bot Builder queries are heavy and not needed to list apps. */
async function remoteOn(db) {
  const { remoteInvocationOn } = await import("../dashboard/panels/bot-builder/data-queries.js");
  return remoteInvocationOn(db);
}

/**
 * The tool ids a def really gets: toolAllowlist over a copy whose crow_mcp includes
 * the tools its repo skills grant (the same union the spawn applies).
 */
export async function grantedToolIds(def, { remoteEnabled, crowHome, repoSkillsDir } = {}) {
  const { toolAllowlist } = await import("../../../scripts/pi-bots/bridge.mjs");
  const crow_mcp = effectiveCrowMcp(def, { crowHome, repoSkillsDir });
  const eff = { ...def, tools: { ...(def.tools || {}), crow_mcp } };
  const csv = toolAllowlist(eff, { remoteEnabled: !!remoteEnabled });
  return csv ? csv.split(",").filter(Boolean) : [];
}

/**
 * Server names a bot def grants, excluding its remote blocks. The server is
 * matched against `knownServers` (longest first, so a name containing "__"
 * works), falling back to everything before the first "__".
 */
export async function grantedServers(db, def, { remoteEnabled, crowHome, repoSkillsDir, knownServers = [] } = {}) {
  const on = remoteEnabled ?? (await remoteOn(db));
  const ids = await grantedToolIds(def, { remoteEnabled: on, crowHome, repoSkillsDir });
  const remote = new Set(remoteServersForBot(def).map((r) => remoteBlockName(r.instanceId, r.canonicalId)));
  const known = [...new Set(knownServers)].sort((a, b) => b.length - a.length);
  const out = new Set();
  for (const id of ids) {
    if (!id.startsWith("mcp__")) continue;
    const rest = id.slice(5);
    const server = known.find((k) => rest === k || rest.startsWith(k + "__")) ?? rest.split("__")[0];
    if (server && !remote.has(server)) out.add(server);
  }
  return out;
}

/**
 * Union of apps over the project's enabled bots. Cached per project (and db)
 * for 30 s; a bot-def save or an install clears it.
 */
export async function appsForProject(db, projectId, { crowHome }) {
  const key = String(crowHome) + "\0" + String(projectId);
  let per = (db && typeof db === "object") ? projectCache.get(db) : null;
  const hit = per && per.get(key);
  if (hit && now() - hit.at < TTL_MS) return hit.apps;
  const gen = projectCache;
  const apps = await computeAppsForProject(db, projectId, { crowHome });
  // A save that landed while this was computing cleared the cache: don't refill it with the old answer.
  if (gen === projectCache && db && typeof db === "object") {
    per = projectCache.get(db);
    if (!per) { per = new Map(); projectCache.set(db, per); }
    per.set(key, { at: now(), apps });
  }
  return apps;
}

async function computeAppsForProject(db, projectId, { crowHome }) {
  const apps = listApps({ crowHome });
  const knownServers = apps.flatMap((a) => a.mcpServers);
  const remoteEnabled = await remoteOn(db);
  const { rows } = await db.execute({ sql: "SELECT bot_id, definition FROM pi_bot_defs WHERE project_id = ? AND enabled != 0", args: [projectId] });
  const sets = [];
  for (const row of rows) {
    let def = {};
    try { def = JSON.parse(row.definition || "{}") || {}; } catch { /* a corrupt def grants nothing */ }
    sets.push(await grantedServers(db, def, { remoteEnabled, crowHome, knownServers }));
  }
  return appsForBots(apps, sets);
}
