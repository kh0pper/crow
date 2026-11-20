/**
 * Crow's own cookie names — ONE list, shared by everything that SETS them and
 * by the extension proxy that must never let them through.
 *
 * Why this file exists (queue item #51): `servers/gateway/routes/extension-proxy.js`
 * serves installed bundles' web UIs at `/proxy/<id>/` on the dashboard's own
 * origin, and used to forward the browser's `Cookie` header unchanged. So every
 * proxied backend — an app nobody audited — received the owner's raw
 * `crow_session` (a live dashboard session, replayable from anywhere). The proxy
 * now strips these names from the forwarded request (HTTP and the WebSocket
 * upgrade) and refuses to forward a response `Set-Cookie` for any of them. A list
 * that drifted from the setters would silently reopen that hole, so the setters
 * import their names from here and `tests/extension-proxy-cookies.test.js` greps
 * the gateway for any `crow_*` name appearing next to `Set-Cookie` and asserts it
 * is covered.
 *
 * `crow_csrf` no longer exists as a cookie (2026-11-19, queue item #51 PR-1: the
 * CSRF token is server-bound — HMAC(secret, session id), served in a `<meta
 * name="crow-csrf">` tag and `GET /dashboard/csrf`). It stays on this list so a
 * release that upgrades from an older build still has the stale cookie stripped
 * from proxied requests and cannot have it re-set through the proxy.
 *
 * A LEAF module on purpose: it imports nothing, so any gateway module (auth, the
 * shell, the proxy) can import it without an import cycle.
 */

export const SESSION_COOKIE = "crow_session";          // dashboard session token over plain HTTP (auth.js)
// The same session over HTTPS: a `__Host-` cookie is host-only (no Domain=) and
// Secure, so a sibling host on the tailnet — `ts.net` is a public suffix, so any
// `<x>.<tailnet>.ts.net` is the SAME SITE — cannot toss or overwrite it. auth.js
// sets this one whenever the request arrived over TLS and reads it in preference
// to the plain name there.
export const HOST_SESSION_COOKIE = "__Host-crow_session";
export const CSRF_COOKIE = "crow_csrf";                // retired: never set; still stripped from proxied requests
export const PENDING_2FA_COOKIE = "crow_pending_2fa";  // in-flight second factor (dashboard/index.js)
export const TRUSTED_2FA_COOKIE = "crow_2fa_trusted";  // "this device passed 2FA" (dashboard/index.js)
export const LANG_COOKIE = "crow_lang";                // dashboard language (settings/sections/language.js)
export const MODE_COOKIE = "crow_mode";                // new/classic shell, per device (shell/mode.js)
export const TRY_COOKIE = "crow_try_new";               // one-time "try the new shell" card (shell/mode.js)
export const SCOPE_COOKIE = "crow_scope";              // shell scope, per device (shell/mode.js)

/**
 * The shell's per-device cookies carry a per-instance suffix so co-hosted
 * gateways never read each other's (`cookieName()` in shell/mode.js):
 * `crow_mode_1a2b3c4d`, or `crow_mode_local` before the instance id exists.
 */
const INSTANCE_SCOPED_COOKIES = Object.freeze([MODE_COOKIE, TRY_COOKIE, SCOPE_COOKIE]);
const INSTANCE_SUFFIX_RE = /_(?:local|[0-9a-f]{8})$/;

/** Every Crow cookie name, unsuffixed (the shell ones may also appear suffixed). */
export const CROW_COOKIE_NAMES = Object.freeze([
  SESSION_COOKIE,
  HOST_SESSION_COOKIE,
  CSRF_COOKIE,
  PENDING_2FA_COOKIE,
  TRUSTED_2FA_COOKIE,
  LANG_COOKIE,
  MODE_COOKIE,
  TRY_COOKIE,
  SCOPE_COOKIE,
]);

/**
 * Whether `name` is one of Crow's cookies — including a shell cookie carrying
 * its per-instance suffix.
 *
 * @param {unknown} name a cookie name (as it appears before the first `=`)
 * @returns {boolean}
 */
export function isCrowCookieName(name) {
  const n = typeof name === "string" ? name.trim() : "";
  if (!n) return false;
  if (CROW_COOKIE_NAMES.includes(n)) return true;
  const m = INSTANCE_SUFFIX_RE.exec(n);
  return m !== null && INSTANCE_SCOPED_COOKIES.includes(n.slice(0, m.index));
}

/**
 * A `Cookie` request header with Crow's own cookies removed, every other cookie
 * kept as it was.
 *
 * @param {string|string[]|undefined|null} header the raw `Cookie` header
 * @returns {string|null} the header to forward, or null when nothing is left
 *   (the caller then drops the header entirely rather than sending an empty one)
 */
export function stripCrowCookieHeader(header) {
  const raw = Array.isArray(header) ? header.join("; ") : typeof header === "string" ? header : "";
  if (!raw.trim()) return null;
  const kept = raw
    .split(";")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .filter((pair) => {
      const eq = pair.indexOf("=");
      return !isCrowCookieName(eq === -1 ? pair : pair.slice(0, eq));
    });
  return kept.length ? kept.join("; ") : null;
}