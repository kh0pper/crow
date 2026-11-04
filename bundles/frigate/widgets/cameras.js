/**
 * The Frigate add-on's widget: its cameras as stills (widgets phase 3, PR 3 — the reference
 * implementation of the add-on widget contract, docs/developers/bundles.md "Widgets").
 *
 * Declared in this bundle's manifest as widget id "cameras", so the grid id is
 * `addon-frigate-cameras`. The gateway imports this file from the INSTALLED copy
 * (`<CROW_HOME>/bundles/frigate/widgets/cameras.js`) at page time, under its own 3 s budget, and
 * hands `load` a frozen `{ lang, now }`. The result is the spec §7.1 summary:
 *
 *   cameras found   { state: "ok", items: [{ key, kind: "camera", title, image }], more_href }
 *   none            { state: "empty", items: [], more_href }
 *   a failed read   throws — the gateway draws that one cell's error line
 *
 * The images are Frigate's own still route through the gateway's proxy, loaded by the browser; the
 * widget never plays video. A camera switched off is left out: its latest.jpg has nothing to show.
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

let fetchOverride = null;
let failedUntil = 0;

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

/**
 * The widget's summary. The one Frigate read (`/api/config`) is bounded here as well as by the
 * gateway's budget, so a container that is down costs a fraction of a cell's wait.
 */
export async function load(ctx) {
  const now = ctx && Number.isFinite(Number(ctx.now)) ? Number(ctx.now) : Date.now();
  if (now < failedUntil) throw new Error("frigate was unreachable a moment ago");
  let timer = null;
  let config;
  try {
    config = await Promise.race([
      Promise.resolve().then(() => frigateFetch("/api/config")),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("camera list timed out")), CAMERA_BUDGET_MS);
        try { timer?.unref?.(); } catch { /* a test's timer need not support unref */ }
      }),
    ]);
  } catch (err) {
    failedUntil = now + CAMERA_FAIL_TTL_MS;
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
  const names = cameraNames(config).slice(0, CAMERA_LIMIT);
  return {
    state: names.length ? "ok" : "empty",
    headline: "",
    items: names.map((name) => ({
      key: name,
      kind: "camera",
      title: name,
      image: stillSrc(name),
    })),
    more_href: FRIGATE_PANEL_HREF,
  };
}