/**
 * The in-Crow widgets' data (widgets phase 3, PR 2): Messages, cameras and the three launchers
 * (apps, projects, bots). The markup they draw lives in widgets/more-html.js; this file only reads.
 *
 *   loadMessages(db, { list })        the five latest conversations, from the Messages panel's OWN
 *                                     reader (panels/messages/data-queries.js
 *                                     getUnifiedConversationList) — no second opinion about what a
 *                                     conversation is, and therefore the same deep links the
 *                                     messages page already answers (?open= / ?openRoom= / ?ai=);
 *   loadCameras({ crowHome })         the installed Frigate bundle's camera list, read through the
 *                                     bundle's own server module (frigate-api.js frigateFetch) — the
 *                                     same Frigate /api/config the panel's /api/frigate/cameras
 *                                     route reads, without an HTTP self-call carrying a session.
 *                                     The still images are the route's own
 *                                     /api/frigate/:camera/latest.jpg, loaded by the browser;
 *   loadApps(db, { crowHome, lang })  the existing launcher (apps/launcher.js launcherFor: the app
 *                                     catalog plus its extra tiles) as a 12-tile grid;
 *   loadProjects(db)                  the active projects (servers/shared/shell-items.js
 *                                     activeProjects) → /dashboard/project/<slug>;
 *   loadBots(db)                      the ENABLED bot defs (skills-used-by.js loadBotRows) →
 *                                     /dashboard/bot-builder?bot=<id>.
 *
 * Every loader's failure is its own widget's error cell (widgets/registry.js loadWidgets catches):
 * a throw here never costs the page. `null`/`undefined` is not a failure — it is "nothing read".
 *
 * Same-site only (Review focus 5): every href a launcher tile or a conversation row carries goes
 * through sameSiteHref, and anything else is DROPPED, never rendered. A launcher tile is a page in
 * this dashboard; a link that would leave the site has no business on the grid.
 *
 * Camera and the panels' own seams: _setFrigateModuleForTest stands in for the whole bundle module
 * (install check included), exactly as For You's moves seam does. The `list`/`launcher`/`projects`/
 * `rows` options are the same kind of seam, taken as arguments so a test never needs a real store.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveCrowHome } from "../../shared/crow-home.js";
import { installedBundleIds } from "../skills-catalog.js";
import { getUnifiedConversationList } from "../dashboard/panels/messages/data-queries.js";
import { launcherFor } from "../apps/launcher.js";
import { activeProjects } from "../../shared/shell-items.js";
import { loadBotRows } from "../skills-used-by.js";

/** Conversations the Messages widget draws (spec §7.4: the five most recent). */
export const MESSAGES_LIMIT = 5;
/** Stills the camera widget draws: a 2×2 block, whatever the camera count. */
export const CAMERA_LIMIT = 4;
/** Tiles a launcher widget draws before "See all". */
export const TILES_LIMIT = 12;

/** The widget's own read needs the request's database; a missing one is a failure, not an empty state. */
function requireDb(db, widget) {
  if (!db || typeof db.execute !== "function") throw new Error(`${widget}: no database for this request`);
  return db;
}

/**
 * A same-site href: exactly one leading "/" and never "//" (a protocol-relative URL leaves the
 * site). Anything else is null, and the caller drops the row.
 */
export function sameSiteHref(href) {
  const s = typeof href === "string" ? href : "";
  // One leading "/", not "//" or "/\\" (browsers read both as another host), and no control characters.
  return /^\/(?![\/\\])[^\x00-\x1f\\]*$/.test(s) ? s : null;
}

/**
 * A conversation's deep link, in the form the messages page already answers
 * (panels/messages/client.js): a peer's numeric contact id, a room's numeric group id, an AI
 * conversation's id. Anything else — an id that is not a number — opens the list instead of
 * inventing a query the page would ignore.
 */
export function messagesHref(item) {
  const id = item && item.id != null ? String(item.id) : "";
  const kind = item && typeof item.type === "string" ? item.type : "";
  if (!/^\d+$/.test(id)) {
    // The unified list names a room "room-<groupId>"; the page's openRoom takes the group id.
    const fromId = /^room-(\d+)$/.exec(id);
    if (kind === "room" && fromId) return `/dashboard/messages?openRoom=${fromId[1]}`;
    return "/dashboard/messages";
  }
  if (kind === "peer") return `/dashboard/messages?open=${id}`;
  if (kind === "room") {
    const group = item && item.groupId != null ? String(item.groupId) : id;
    return `/dashboard/messages?openRoom=${group}`;
  }
  if (kind === "ai") return `/dashboard/messages?ai=${id}`;
  return "/dashboard/messages";
}

/**
 * The five latest conversations, each with the name, the unread count, when it last moved and the
 * deep link that opens it. `list` is the Messages panel's reader (a seam for tests only).
 */
export async function loadMessages(db, { list = getUnifiedConversationList, limit = MESSAGES_LIMIT } = {}) {
  requireDb(db, "messages");
  const read = (await list(db)) || {};
  const items = Array.isArray(read.items) ? read.items : [];
  const conversations = [];
  for (const item of items) {
    if (!item) continue;
    conversations.push({
      kind: typeof item.type === "string" ? item.type : "",
      id: item.id == null ? "" : String(item.id),
      name: String(item.displayName == null ? "" : item.displayName),
      unread: Number(item.unread) || 0,
      at: item.lastActivity || null,
      href: messagesHref(item),
    });
    if (conversations.length >= limit) break;
  }
  return { conversations, totalUnread: Number(read.totalUnread) || 0 };
}

// ─── the camera ─────────────────────────────────────────────────────────────

let frigateOverride = null;

/** Test seam: a stand-in for the installed bundle's server module ({ frigateFetch }); null restores. */
export function _setFrigateModuleForTest(mod) { frigateOverride = mod || null; }

/** The installed Frigate bundle's own Frigate client module, or null when the copy has no such file. */
export async function frigateModule(crowHome) {
  if (frigateOverride) return frigateOverride;
  const file = join(crowHome || resolveCrowHome(), "bundles", "frigate", "server", "frigate-api.js");
  if (!existsSync(file)) return null;
  return import(pathToFileURL(file).href);
}

/** True when the Frigate bundle is installed (or a test stands in for it): the camera widget's offer. */
export function frigateInstalled(crowHome) {
  if (frigateOverride) return true;
  try { return installedBundleIds(crowHome || resolveCrowHome()).includes("frigate"); } catch { return false; }
}

/**
 * Frigate's /api/config `cameras` map as the names a still can be asked for, in the order the config
 * lists them. A camera switched off is left out: its latest.jpg has nothing to show.
 */
export function cameraNames(config) {
  const cameras = config && typeof config === "object" ? config.cameras : null;
  if (!cameras || typeof cameras !== "object") return [];
  const out = [];
  for (const [name, cam] of Object.entries(cameras)) {
    const n = String(name == null ? "" : name).trim();
    if (!n) continue;
    if (cam && typeof cam === "object" && cam.enabled === false) continue;
    out.push(n);
  }
  return out;
}

/**
 * The camera widget's data. `state`:
 *   "ok"      there are stills to draw (`cameras`, at most CAMERA_LIMIT, plus `total`);
 *   "empty"   Frigate answered and lists no camera;
 *   "panel"   the bundle has no server module to read the list with — the widget is a link to the
 *             Frigate panel, never a broken tile.
 * A read that THROWS is left to the registry: it is that cell's error line, and the page is
 * untouched. Nothing here reaches the network; the bundle module owns the one Frigate call.
 */
/** How long the camera list may hold the page, and how long a failed read is remembered. */
export const CAMERA_BUDGET_MS = 1500;
export const CAMERA_FAIL_TTL_MS = 60_000;
let cameraFailedUntil = 0;
/** Test hook: forget a remembered failure. */
export function _resetCameraFailureForTest() { cameraFailedUntil = 0; }

export async function loadCameras({ crowHome = resolveCrowHome(), limit = CAMERA_LIMIT, now = Date.now(), budgetMs = CAMERA_BUDGET_MS } = {}) {
  const mod = await frigateModule(crowHome);
  if (!mod || typeof mod.frigateFetch !== "function") return { cameras: [], total: 0, state: "panel" };
  // An unreachable Frigate must not cost every page view the widget timeout: a short budget, and a
  // failure remembered for a minute (the widget then links to the Frigate panel at once).
  if (now < cameraFailedUntil) return { cameras: [], total: 0, state: "panel" };
  let timer;
  let config;
  try {
    config = await Promise.race([
      Promise.resolve().then(() => mod.frigateFetch("/api/config")),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("camera list timed out")), budgetMs); timer.unref?.(); }),
    ]);
  } catch (err) {
    cameraFailedUntil = now + CAMERA_FAIL_TTL_MS;
    throw err;
  } finally {
    clearTimeout(timer);
  }
  const names = cameraNames(config);
  return {
    cameras: names.slice(0, limit),
    total: names.length,
    state: names.length ? "ok" : "empty",
  };
}

// ─── the launchers ──────────────────────────────────────────────────────────

/**
 * Rows → tiles `{ id, label, href }`. A row whose href is not same-site is DROPPED (never rendered
 * with a fallback): a launcher tile that leaves the dashboard is not a launcher tile.
 */
export function launcherItems(rows, hrefOf) {
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row) continue;
    let raw = null;
    try { raw = hrefOf(row); } catch { raw = null; }
    const href = sameSiteHref(raw);
    if (!href) continue;
    const label = String(row.label == null ? "" : row.label);
    out.push({ id: String(row.id == null || row.id === "" ? href : row.id), label, href });
  }
  return out;
}

/** The apps launcher's tiles: the app catalog, then the extra page tiles, at most TILES_LIMIT. */
export async function loadApps(db, {
  crowHome = resolveCrowHome(), lang = "en", launcher = launcherFor, limit = TILES_LIMIT,
} = {}) {
  requireDb(db, "apps");
  const loaded = (await launcher(db, { all: true }, { crowHome, lang })) || {};
  const items = [
    ...launcherItems(loaded.apps, (a) => a && a.href),
    ...launcherItems(loaded.tiles, (x) => x && x.href),
  ];
  return { items: items.slice(0, limit), total: items.length };
}

/** The active projects: one tile each, linking to that project's home. */
export async function loadProjects(db, { projects = activeProjects, limit = TILES_LIMIT } = {}) {
  requireDb(db, "projects");
  const rows = (await projects(db)) || [];
  const entries = (Array.isArray(rows) ? rows : []).map((p) => ({
    id: p && p.id != null ? p.id : "",
    label: p && p.name != null ? p.name : "",
    href: p && p.slug ? `/dashboard/project/${encodeURIComponent(String(p.slug))}` : "",
  }));
  const items = launcherItems(entries, (p) => p.href);
  return { items: items.slice(0, limit), total: items.length };
}

/** The ENABLED bots: one tile each, opening that bot in Bot Builder. A paused bot is not offered. */
export async function loadBots(db, { rows = loadBotRows, limit = TILES_LIMIT } = {}) {
  requireDb(db, "bots");
  const list = (await rows(db)) || [];
  const entries = (Array.isArray(list) ? list : [])
    .filter((r) => r && Number(r.enabled) !== 0)
    .map((r) => ({
      id: r.bot_id == null ? "" : r.bot_id,
      label: r.display_name || (r.bot_id == null ? "" : String(r.bot_id)),
      href: r.bot_id ? `/dashboard/bot-builder?bot=${encodeURIComponent(String(r.bot_id))}` : "",
    }));
  const items = launcherItems(entries, (b) => b.href);
  return { items: items.slice(0, limit), total: items.length };
}