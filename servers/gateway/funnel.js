/**
 * Tailscale Funnel allowlist + reject middleware.
 *
 * Shared source of truth for which paths are safe to expose publicly via
 * `tailscale funnel`. Everything NOT in the allowlist gets 403'd when the
 * request carries `Tailscale-Funnel-Request: 1` — defense in depth against
 * a misconfigured `tailscale funnel /` that would otherwise expose the Nest
 * dashboard to the open internet.
 *
 * Add a path here ONLY when you've confirmed:
 *   1. It has no auth dependency on per-origin session cookies.
 *   2. It emits no private data (message counts, peer overviews, files).
 *   3. Its handler has its own rate-limit / resource budget.
 *
 * Callers:
 *   - servers/gateway/index.js  — mounts the middleware on every request.
 *   - tests/*                    — import PUBLIC_FUNNEL_PREFIXES to assert
 *                                   new federation routes never sneak into
 *                                   the allowlist.
 */

export const PUBLIC_FUNNEL_PREFIXES = [
  "/blog",
  "/blog/",
  "/robots.txt",
  "/sitemap.xml",
  "/.well-known/",
  "/favicon.ico",
  "/manifest.json",
];

/**
 * GATEWAY_FUNNEL_PUBLIC_PREFIXES: comma-separated extra entries appended to
 * PUBLIC_FUNNEL_PREFIXES, for deployments that funnel additional public
 * surfaces (e.g. share surfaces under /s). Same semantics as the static list:
 * trailing "/" = subtree prefix, no trailing slash = exact match. The same
 * three conditions at the top of this file apply to every entry added here.
 * Read at middleware creation, not per request.
 */
function envFunnelPrefixes() {
  return (process.env.GATEWAY_FUNNEL_PUBLIC_PREFIXES || "")
    .split(",").map((s) => s.trim()).filter((s) => s.startsWith("/"));
}

/**
 * Express middleware: reject funneled requests to any non-public path.
 *
 * Entries ending with "/" are tree prefixes (subtree match only — path must
 * start with the full prefix including the slash, e.g. "/.well-known/" allows
 * "/.well-known/oauth-authorization-server" but not "/.well-known" bare).
 * Entries without a trailing slash are exact-match only; this blocks lookalikes
 * such as "/robots.txt/" or "/sitemap.xml.gz" from slipping through.
 * Tree paths that also need an exact match carry both forms: "/blog" + "/blog/".
 *
 * @returns {(req, res, next) => void}
 */
export function rejectFunneledMiddleware() {
  const allowed = [...PUBLIC_FUNNEL_PREFIXES, ...envFunnelPrefixes()];
  return (req, res, next) => {
    if (!req.headers["tailscale-funnel-request"]) return next();
    if (process.env.CROW_DASHBOARD_PUBLIC === "true") return next();
    if (
      allowed.some((p) => {
        if (p.endsWith("/")) return req.path.startsWith(p);
        return req.path === p;
      })
    )
      return next();
    res.status(403).type("text/plain").send("Forbidden: private path not reachable via Tailscale Funnel.");
  };
}
