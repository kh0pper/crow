/**
 * CSRF Double-Submit Validator
 *
 * Guards state-changing dashboard requests against cross-site forgery.
 *
 * How it works:
 *   1. `auth.js:setSessionCookie()` sets two cookies on login:
 *        - `crow_session`  (HttpOnly, SameSite=Lax) — the session token
 *        - `crow_csrf`     (not HttpOnly, SameSite=Lax) — a random per-session value
 *   2. Authenticated clients must echo the `crow_csrf` value back on every
 *      state-changing request, either:
 *        - via the `X-Crow-Csrf` header (Turbo-driven or AJAX submits), OR
 *        - via a `_csrf` body field (classic `<form>` POST).
 *   3. The middleware compares `req.cookies.crow_csrf` (which a cross-site
 *      attacker cannot read, even though SameSite=Lax lets it be SENT) against
 *      the echoed value. A mismatch → 403.
 *
 * Deliberately skipped:
 *   - GET / HEAD / OPTIONS (non-state-changing).
 *   - Requests without `crow_session` cookie: pre-auth flows (login / reset /
 *     2fa setup) don't yet have a CSRF cookie. Those flows have their own
 *     rate-limit + lockout defenses in `auth.js`.
 *   - HMAC-signed peer calls (`X-Crow-Signature` header): cross-host auth is
 *     a strictly stronger check.
 *   - Ratchet kill-switch: `CROW_CSRF_STRICT=0` disables validation globally.
 *     Cookie is still issued so forms and Turbo listener keep working; the
 *     middleware just no-ops. Read per-request so it responds to a hot flip.
 *
 * Populates `req.csrfToken = req.cookies.crow_csrf` so existing form templates
 * that already reference it (e.g. `notifications.js:215`) render a real token.
 *
 * Mount AFTER the cross-host bypass and AFTER `dashboardAuth` so it only sees
 * session-authenticated requests.
 */

import { parseCookies } from "../auth.js";

const CSRF_COOKIE = "crow_csrf";
const HEADER_NAME = "x-crow-csrf";
const BODY_FIELD = "_csrf";
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "DELETE", "PATCH"]);

function strictMode() {
  return process.env.CROW_CSRF_STRICT !== "0";
}

/**
 * Constant-time string comparison. Avoids timing leaks when the attacker can
 * observe response time differences.
 */
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Express middleware. Rejects state-changing requests that lack a matching
 * CSRF token when the caller is session-authenticated.
 */
export function csrfMiddleware(req, res, next) {
  // Always populate req.csrfToken when the cookie is present so templates
  // can render it, independent of strict-mode or request method.
  const cookies = parseCookies(req);
  if (cookies[CSRF_COOKIE]) {
    req.csrfToken = cookies[CSRF_COOKIE];
  }

  // Read-only method → nothing to validate.
  if (!STATE_CHANGING_METHODS.has(req.method)) return next();

  // HMAC-signed peer request → bundle router / federation router handle auth.
  if (req.headers["x-crow-signature"]) return next();

  // Pre-auth flow (no session yet) → login/reset/2fa handlers own their own
  // defenses (rate-limit, lockout).
  if (!cookies.crow_session) return next();

  // Rollback escape hatch: cookie still set, validation bypassed.
  if (!strictMode()) return next();

  const cookieValue = cookies[CSRF_COOKIE];
  if (!cookieValue) {
    return res.status(403).type("text/plain").send("CSRF token missing.");
  }

  const headerValue = req.headers[HEADER_NAME];
  const bodyValue = req.body && typeof req.body === "object" ? req.body[BODY_FIELD] : null;
  const presented = headerValue || bodyValue;

  if (!presented || !safeEqual(String(presented), cookieValue)) {
    return res.status(403).type("text/plain").send("CSRF token mismatch.");
  }

  return next();
}

/**
 * Emit a hidden input carrying the CSRF token. For classic `<form>` submits
 * that don't go through Turbo's auto-header-attach path.
 */
export function csrfInput(req) {
  const token = req && req.csrfToken ? String(req.csrfToken) : "";
  return `<input type="hidden" name="_csrf" value="${token}">`;
}
