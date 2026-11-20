/**
 * The fetch-metadata gate for cookie-authenticated state-changing requests.
 *
 * WHY (queue item #51 PR-1): `ts.net` is a public suffix, so every host on the
 * tailnet is the SAME SITE as the dashboard and SameSite=Lax will send the
 * owner's session on a POST from any of them. The server-bound CSRF token
 * (dashboard/shared/csrf.js) is the real defence; this is the second lock, and
 * the one that also covers routes that never reach csrfMiddleware.
 *
 * The rule, for POST/PUT/PATCH/DELETE on a cookie-authenticated mount
 * (`/dashboard`, `/api`, `/proxy/<id>`, `/apps/<name>`) when the request carries
 * a dashboard session cookie:
 *   - `Sec-Fetch-Site: same-site` / `cross-site` → refused. Browsers write this
 *     header; page script cannot. "same-origin" and "none" (a typed URL) pass.
 *   - No `Sec-Fetch-Site` at all → `Origin`, when present, must name this
 *     gateway's own origin (isSameOriginRequest in same-origin.js: Host, the
 *     X-Forwarded-Host a same-box proxy names, or a configured public origin).
 *   - NEITHER header → allowed. That is curl, a bot with a shell, an installer,
 *     or a native client using a bearer token: a script writes whatever headers
 *     it likes, so these headers are only a defence against BROWSERS, and this
 *     gate only ever refuses the browser-shaped request.
 *
 * Requests with no session cookie are untouched: bearer/MCP clients, the login
 * POST, the password reset and every HMAC-signed peer call keep working exactly
 * as they did.
 *
 * Mounted app-wide in servers/gateway/index.js, before the routers; it scopes
 * itself to the cookie-authenticated path prefixes (GATED_PREFIXES below).
 *
 * A note on the shapes it must NOT break: Tailscale Serve, the installer's
 * Caddy over the proxy socket, a LAN address and a raw-IP https URL all show a
 * real browser the same origin it asked for, so `Sec-Fetch-Site` is
 * "same-origin" and `Origin` (when sent at all) names that same host — every one
 * of them passes.
 */
import { sessionTokenFromRequest } from "./auth.js";
import { isSameOriginRequest } from "./same-origin.js";

const GATED_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
// Every cookie-authenticated mount outside the CSRF rail: the dashboard, the
// API, the extension web-UI proxy (`/proxy/<id>`, dashboard session), and the
// authenticated static apps (`/apps/<name>`, dashboard session).
const GATED_PREFIXES = ["/dashboard", "/api", "/proxy", "/apps"];

/** The refusal body (403, text/plain): a plain sentence, naming no host or path. */
export const FETCH_METADATA_REFUSAL = "Refused: this request came from another site.";

/**
 * The path this gate compares, in the form Express's router actually matches.
 *
 * Express routing is case-INSENSITIVE by default and a normalising router sees
 * `//dashboard//x` the same as `/dashboard/x`, so a raw, case-sensitive
 * `req.path` comparison would let `/DASHBOARD/...` or `/Api/...` reach the
 * handler while skipping this gate. Decode once (as Express does for route
 * params), collapse repeated slashes, and lower-case. A malformed escape keeps
 * the raw text, which still matches a gated prefix if it starts with one.
 *
 * @param {string} rawPath
 * @returns {string}
 */
function normalizedPath(rawPath) {
  let path = String(rawPath || "");
  try { path = decodeURIComponent(path); } catch { /* malformed escape: compare the raw text */ }
  return path.replace(/\\/g, "/").replace(/\/{2,}/g, "/").toLowerCase();
}

function gatedPath(rawPath) {
  const path = normalizedPath(rawPath);
  return GATED_PREFIXES.some((p) => path === p || path.startsWith(p + "/"));
}

/**
 * Express middleware. `opts.log` is the refusal logger (tests pass a collector;
 * the default writes ONE line with the method, the path and the header values
 * that refused it — never a body, never a token).
 */
export function fetchMetadataGate({ log = console.warn } = {}) {
  return function fetchMetadataGateMiddleware(req, res, next) {
    const method = String(req.method || "").toUpperCase();
    if (!GATED_METHODS.has(method)) return next();
    if (!gatedPath(req.path)) return next();
    if (!sessionTokenFromRequest(req)) return next();
    if (isSameOriginRequest(req)) return next();
    try {
      log(`[csrf] refused a ${method} ${req.path} from another site (sec-fetch-site=${req.headers["sec-fetch-site"] || "-"}, origin=${req.headers.origin || "-"})`);
    } catch { /* logging must never decide the request */ }
    return res.status(403).type("text/plain").send(FETCH_METADATA_REFUSAL);
  };
}