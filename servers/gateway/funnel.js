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
let _warnedLoneSlashFor = null; // log the dropped lone "/" once per env value

function envFunnelPrefixes() {
  const entries = (process.env.GATEWAY_FUNNEL_PUBLIC_PREFIXES || "")
    .split(",").map((s) => s.trim()).filter((s) => s.startsWith("/"));
  // A lone "/" is a subtree prefix of every path: it would open the whole
  // gateway (dashboard included) to the internet. Never honour it.
  if (entries.includes("/") && _warnedLoneSlashFor !== process.env.GATEWAY_FUNNEL_PUBLIC_PREFIXES) {
    _warnedLoneSlashFor = process.env.GATEWAY_FUNNEL_PUBLIC_PREFIXES;
    console.warn('[funnel] GATEWAY_FUNNEL_PUBLIC_PREFIXES contains a lone "/" — ignored: it would make every path public.');
  }
  return entries.filter((s) => s !== "/");
}

/**
 * The allowlist this gateway actually enforces: the static list plus the
 * GATEWAY_FUNNEL_PUBLIC_PREFIXES entries. The middleware below and the Nest
 * exposure check both read it, so the warning and the enforcement agree.
 */
export function effectiveFunnelPrefixes() {
  return [...PUBLIC_FUNNEL_PREFIXES, ...envFunnelPrefixes()];
}

/** Same prefix semantics as the middleware: trailing "/" = subtree, else exact. */
export function isFunnelPublicPath(path, prefixes = effectiveFunnelPrefixes()) {
  return prefixes.some((p) => (p.endsWith("/") ? path.startsWith(p) : path === p));
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
  const allowed = effectiveFunnelPrefixes();
  return (req, res, next) => {
    if (!req.headers["tailscale-funnel-request"]) return next();
    if (process.env.CROW_DASHBOARD_PUBLIC === "true") return next();
    if (isFunnelPublicPath(req.path, allowed)) return next();
    res.status(403).type("text/plain").send("Forbidden: private path not reachable via Tailscale Funnel.");
  };
}
