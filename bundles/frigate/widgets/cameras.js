/**
 * The Frigate add-on's widget: its cameras as stills (widgets phase 3, PR 3 — the reference
 * implementation of the add-on widget contract, docs/developers/bundles.md "Widgets").
 *
 * Declared in this bundle's manifest as widget id "cameras", so the grid id is
 * `addon-frigate-cameras`. The gateway imports this file from the INSTALLED copy
 * (`<CROW_HOME>/bundles/frigate/widgets/cameras.js`) at page time, under its own 3 s budget, and
 * hands `load` a frozen `{ lang, now }`. The result is the spec §7.1 summary:
 *
 *   cameras found   { state: "ok", items: [...], more_href }
 *   none            { state: "empty", items: [], more_href }
 *   a failed read   throws — the gateway draws that one cell's error line
 *
 * Two kinds of camera feed this card. A "snapshot camera" is a still a sidecar drops into the
 * folder named by FRIGATE_SNAPSHOT_DIR (`<name>.jpg`, optionally with a `<name>.json` saying when
 * and why): it is drawn from that file, with its reason and time as the item's title, and it is
 * NOT drawn a second time from Frigate. A camera with an entry in FRIGATE_LIVE_SOURCES gets a
 * "Watch live" row that leads to the panel, which is where the live view actually runs — a widget
 * cannot act, so it only links. Only the KEY names of that object are read here; the stream
 * addresses stay in the gateway's environment.
 *
 * The Frigate stills are Frigate's own still route through the gateway's proxy, loaded by the
 * browser; the widget never plays video. A camera switched off is left out: its latest.jpg has
 * nothing to show. A Frigate read that fails (or is still remembered as failed) only throws when
 * there is no snapshot camera to show either.
 *
 * The read is the same client the panel uses (`../server/frigate-api.js` frigateFetch, a relative
 * import that resolves inside the installed bundle too), with a short budget of its own and a
 * failure remembered for a minute so an unreachable Frigate costs one short wait, not one per page
 * view.
 */

/** Stills the widget draws: a 2×2 block, whatever the camera count. */
export const CAMERA_LIMIT = 4;
/** How long the camera list may hold the page, and how long a failed read is remembered. */
export const CAMERA_BUDGET_MS = 1500;
export const CAMERA_FAIL_TTL_MS = 60_000;
/** The panel the card's "Open" link leads to. */
export const FRIGATE_PANEL_HREF = "/dashboard/frigate";
/** An item's title is cut here; the gateway cuts at the same length. */
const TITLE_MAX = 120;
/** The snapshot name rule, kept local so this file reads nothing but key names below. */
const SNAPSHOT_NAME_RE = /^[a-z0-9_-]{1,64}$/;
const RTSP_RE = /^rtsps?:\/\//i;
const LIVE_ROW = { en: "Watch live", es: "Ver en vivo" };

let fetchOverride = null;
let failedUntil = 0;
let snapshotModule = null;

/** Test seam: a stand-in for this bundle's frigateFetch. `null` restores the real client. */
export function _setFetchForTest(fn) { fetchOverride = typeof fn === "function" ? fn : null; }

/** Test hook: forget the remembered failure and the seam. */
export function _resetForTest() { fetchOverride = null; failedUntil = 0; }

/** This bundle's own Frigate client, or the test's stand-in for it. */
async function frigateFetch(path) {
  if (fetchOverride) return fetchOverride(path);
  const mod = await import("../server/frigate-api.js");
  if (!mod || typeof mod.frigateFetch !== "function") throw new Error("frigate client is missing");
  return mod.frigateFetch(path);
}

/** The snapshot folder this instance reads (manifest env var FRIGATE_SNAPSHOT_DIR). */
function snapshotDir() {
  const value = process.env.FRIGATE_SNAPSHOT_DIR;
  return typeof value === "string" ? value : "";
}

/** This bundle's snapshot module, or null: an import that fails just means "no doorbell". */
async function doorbell() {
  if (!snapshotModule) {
    snapshotModule = import("../server/doorbell.js").catch(() => null);
  }
  return snapshotModule;
}

/**
 * The KEY NAMES in FRIGATE_LIVE_SOURCES. The values are stream addresses with credentials in
 * them: each one is only checked for shape and dropped, and nothing here ever returns or keeps it.
 */
function liveSourceNames() {
  const names = new Set();
  const raw = process.env.FRIGATE_LIVE_SOURCES;
  if (typeof raw !== "string" || !raw.trim()) return names;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return names;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return names;
  for (const [name, url] of Object.entries(data)) {
    if (!SNAPSHOT_NAME_RE.test(name)) continue;
    if (typeof url !== "string") continue;
    if (!RTSP_RE.test(url)) continue;
    names.add(name);
  }
  return names;
}

/**
 * Frigate's /api/config `cameras` map as the names a still can be asked for, in the order the config
 * lists them. A camera switched off (`enabled: false`) is left out.
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

/** The still route for one camera, as the gateway's Frigate proxy answers it. */
function stillSrc(name) {
  return `/api/frigate/${encodeURIComponent(name)}/latest.jpg`;
}

/** The still route for one file in the snapshot folder. */
function snapSrc(name) {
  return `/api/frigate/snap/${encodeURIComponent(name)}.jpg`;
}

/** "front_door" → "Front Door": the name as a heading, with its separators turned to spaces. */
function displayName(name) {
  return String(name)
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/(^|\s)([a-z])/g, (all, space, letter) => space + letter.toUpperCase());
}

/**
 * The widget's summary. The one Frigate read (`/api/config`) is bounded here as well as by the
 * gateway's budget, so a container that is down costs a fraction of a cell's wait — and it only
 * costs the cell at all when the snapshot folder has nothing in it either.
 */
export async function load(ctx) {
  const lang = ctx && ctx.lang === "es" ? "es" : "en";
  const now = ctx && Number.isFinite(Number(ctx.now)) ? Number(ctx.now) : Date.now();

  const mod = await doorbell();
  const listed = mod && typeof mod.listSnapshotCameras === "function"
    ? await mod.listSnapshotCameras(snapshotDir()).catch(() => [])
    : [];
  const liveNames = liveSourceNames();

  const items = [];
  const snapshotNames = new Set();
  for (const camera of listed.slice(0, CAMERA_LIMIT)) {
    const name = camera && typeof camera.name === "string" ? camera.name : "";
    if (!SNAPSHOT_NAME_RE.test(name)) continue;
    snapshotNames.add(name);
    const label = mod && typeof mod.snapshotLabel === "function"
      ? mod.snapshotLabel(camera, now, lang)
      : "";
    const base = displayName(name);
    items.push({
      key: name,
      kind: "camera",
      title: (label ? `${base} - ${label}` : base).slice(0, TITLE_MAX),
      image: snapSrc(name),
    });
  }

  for (const name of snapshotNames) {
    if (!liveNames.has(name)) continue;
    items.push({
      key: `${name}-live`,
      kind: "live",
      title: LIVE_ROW[lang],
      href: `${FRIGATE_PANEL_HREF}?live=${encodeURIComponent(name)}`,
    });
  }

  let frigateFailure = null;
  let frigateNames = [];
  if (now < failedUntil) {
    frigateFailure = new Error("frigate was unreachable a moment ago");
  } else {
    let timer = null;
    try {
      const config = await Promise.race([
        Promise.resolve().then(() => frigateFetch("/api/config")),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("camera list timed out")), CAMERA_BUDGET_MS);
          try { timer?.unref?.(); } catch { /* a test's timer need not support unref */ }
        }),
      ]);
      frigateNames = cameraNames(config);
    } catch (err) {
      failedUntil = now + CAMERA_FAIL_TTL_MS;
      frigateFailure = err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // A Frigate that cannot be read is its own cell's error only while there is nothing else to draw.
  if (frigateFailure && snapshotNames.size === 0) throw frigateFailure;

  let room = Math.max(0, CAMERA_LIMIT - items.filter((item) => item.image).length);
  for (const name of frigateNames) {
    if (snapshotNames.has(name)) continue; // already drawn from the snapshot folder
    if (room <= 0) break;
    items.push({
      key: name,
      kind: "camera",
      title: name,
      image: stillSrc(name),
    });
    room -= 1;
  }

  return {
    state: items.length ? "ok" : "empty",
    headline: "",
    items,
    more_href: FRIGATE_PANEL_HREF,
  };
}