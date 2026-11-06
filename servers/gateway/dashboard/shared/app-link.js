/**
 * One rule for "where does this bundle's web UI open from", shared by every
 * link that points at an installed app's UI.
 *
 * Two shapes, straight out of the manifest's `webUI`:
 *   - subpath (default): /proxy/<id><path>, through the gateway, inheriting its
 *     HTTPS + session gate. The proxy route table is built ONCE at boot, so a
 *     bundle installed into a running gateway has no route until it restarts.
 *   - direct: the app cannot live behind a subpath (root-absolute assets), so
 *     it is its own origin on its own port — https://<this hostname>:<port><path>
 *     (Tailscale Serve provides the TLS). The host is only known in the browser,
 *     so the href stays on the dashboard and a click handler opens the real URL.
 *
 * The Nest tile and the "finish this app's setup now" card both use this, so
 * the two can never disagree about where an app lives.
 */
import { escapeHtml } from "./components.js";

/**
 * @param {string} bundleId
 * @param {object|null} webUI the manifest's webUI block
 * @returns {{ href: string, onclick: string, proxyMode: "subpath"|"direct", path: string }}
 *   `href`/`onclick` are ready for an <a> (onclick is "" for a subpath link).
 */
export function appTileLink(bundleId, webUI) {
  const w = webUI && typeof webUI === "object" ? webUI : {};
  const rawPath = typeof w.path === "string" && w.path ? w.path : "/";
  // A path is a path: keep it inside the app's origin even if a manifest is odd.
  const path = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  if (w.proxyMode !== "direct") {
    return { href: `/proxy/${bundleId}${path}`, onclick: "", proxyMode: "subpath", path };
  }
  const port = Number(w.port);
  const js = Number.isInteger(port) && port > 0
    ? `window.open('https://'+location.hostname+':'+${port}+${JSON.stringify(path)},'_blank');return false`
    : "";
  return {
    // No-JS fallback, exactly as before the click handler existed: Extensions.
    href: "/dashboard/extensions",
    onclick: js ? ` onclick="${escapeHtml(js)}"` : "",
    proxyMode: "direct",
    path,
  };
}