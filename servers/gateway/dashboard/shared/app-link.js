/**
 * One rule for "where does this bundle's web UI open from", shared by every
 * link that points at an installed app's UI.
 *
 * Two shapes, straight out of the manifest's `webUI`:
 *   - subpath (default): /proxy/<id><path>, through the gateway, inheriting its
 *     HTTPS + session gate. The proxy route table is built ONCE at boot, so a
 *     bundle installed into a running gateway has no route until it restarts.
 *     The tile opens it in a NEW TAB through a click handler (returning false
 *     stops Turbo Drive from taking the navigation over in the same tab).
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
 * A path went into a single-quoted JS string: keep it inside that string.
 * (Manifests are authored data, but a quote must never end an attribute early.)
 */
function jsSingleQuoted(text) {
  return String(text).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/**
 * @param {string} bundleId
 * @param {object|null} webUI the manifest's webUI block
 * @returns {{ href: string, onclick: string, proxyMode: "subpath"|"direct", path: string }}
 *   `href`/`onclick` are ready for an <a>; `onclick` is the bare attribute
 *   (leading space included) or "" when the link needs no handler.
 */
export function appTileLink(bundleId, webUI) {
  const w = webUI && typeof webUI === "object" ? webUI : {};
  const rawPath = typeof w.path === "string" && w.path ? w.path : "/";
  // A path is a path: keep it inside the app's origin even if a manifest is odd.
  const path = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  if (w.proxyMode !== "direct") {
    const href = `/proxy/${bundleId}${path}`;
    // The tile's long-standing behaviour: a new tab, and no Turbo Drive
    // interception of the proxied app in this one.
    const js = `window.open('${jsSingleQuoted(href)}','_blank');return false`;
    return { href, onclick: ` onclick="${escapeHtml(js)}"`, proxyMode: "subpath", path };
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
