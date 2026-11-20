/**
 * CSRF validation — a SERVER-BOUND token, not a double-submit cookie.
 *
 * How it works now (2026-11-19, queue item #51 PR-1):
 *
 *   1. The token is `HMAC-SHA256(csrf.key, session id)`, base64url. The secret
 *      lives in `<CROW_HOME>/secrets/csrf.key` (csrf-secret.js, 0600); the
 *      session id is the HttpOnly `__Host-crow_session` / `crow_session` cookie.
 *      Neither is readable by page script, so a token cannot be computed — or
 *      copied — by anything that can run in the owner's browser.
 *   2. It is DELIVERED to the page, never left in a cookie: a
 *      `<meta name="crow-csrf" content="…">` in every dashboard layout and
 *      `GET /dashboard/csrf` (JSON, no-store) for long-lived pages. The client
 *      helper is `window.crowCsrf()` / `window.crowCsrfRefresh()`
 *      (public/csrf-client.js); on a 403 refusal the layout's fetch wrapper
 *      refreshes it once and retries.
 *   3. Clients echo it back on every state-changing request, either via the
 *      `X-Crow-Csrf` header (Turbo, fetch) or a `_csrf` body field (classic
 *      `<form>`). The middleware recomputes the HMAC from the authenticated
 *      session and compares in constant time.
 *
 * WHY the old double-submit cookie is gone: `ts.net` is a public suffix, so every
 * host on the tailnet (`<instance>.ts.net`, `<instance>-apps.ts.net`, a
 * compromised extension's page) is the SAME SITE as the dashboard. A same-site
 * host can set `Domain=<tailnet>.ts.net` cookies and SameSite=Lax still sends the
 * session on its POSTs. Comparing the echoed value to a non-HttpOnly cookie was
 * therefore forgeable by anything same-site; an HMAC keyed by a secret the
 * attacker never sees is not.
 *
 * Deliberately skipped:
 *   - GET / HEAD / OPTIONS (non-state-changing).
 *   - Requests with no session cookie: pre-auth flows (login / reset / 2fa
 *     setup) have no session to bind a token to. Those flows have their own
 *     rate-limit + lockout defenses in `auth.js`.
 *   - HMAC-signed peer calls (`X-Crow-Signature` header): cross-host auth is
 *     a strictly stronger check.
 *   - Ratchet kill-switch: `CROW_CSRF_STRICT=0` disables validation globally.
 *     Read per-request so it responds to a hot flip.
 *
 * Populates `req.csrfToken` so the form templates that reference it render a
 * real token.
 *
 * Mount AFTER the cross-host bypass and AFTER `dashboardAuth` so it only sees
 * session-authenticated requests.
 */

import { createHmac } from "node:crypto";
import { sessionTokenFromRequest } from "../auth.js";
import { escapeHtml } from "./components.js";
import { csrfSecret } from "./csrf-secret.js";

const HEADER_NAME = "x-crow-csrf";
const BODY_FIELD = "_csrf";
/** Response header naming WHY a request was refused, so the client wrapper can
 *  refresh the token once and retry (`X-Crow-Csrf-Refusal: mismatch`). */
export const REFUSAL_HEADER = "X-Crow-Csrf-Refusal";
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "DELETE", "PATCH"]);

function strictMode() {
  return process.env.CROW_CSRF_STRICT !== "0";
}

/**
 * The CSRF token for a session id: base64url HMAC-SHA256 of the session token
 * under the instance's CSRF secret. Empty string for no session.
 *
 * @param {string|null|undefined} sessionToken the raw session cookie value
 * @returns {string}
 */
export function csrfTokenForSession(sessionToken) {
  if (typeof sessionToken !== "string" || !sessionToken) return "";
  return createHmac("sha256", csrfSecret()).update(sessionToken).digest("base64url");
}

/**
 * The CSRF token the request's own session should echo (see
 * sessionTokenFromRequest: `__Host-crow_session` over HTTPS, plain otherwise).
 *
 * @param {object} req
 * @returns {string} empty when the request carries no session
 */
export function csrfTokenForRequest(req) {
  return csrfTokenForSession(sessionTokenFromRequest(req));
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
  // Populate req.csrfToken on every request so templates (and the layout's
  // <meta name="crow-csrf">) can render it, independent of strict-mode or
  // request method.
  const token = csrfTokenForRequest(req);
  if (token) req.csrfToken = token;

  const refusal = csrfRefusal(req);
  if (!refusal) return next();
  try { res.setHeader(REFUSAL_HEADER, refusal); } catch { /* a bare test response */ }
  return res.status(403).type("text/plain").send(REFUSAL_MESSAGES[refusal]);
}

const REFUSAL_MESSAGES = {
  missing: "CSRF token missing.",
  absent: "CSRF token mismatch.",
  mismatch: "CSRF token mismatch.",
};

/**
 * The verdict for an Express request. `null` when the request may proceed —
 * read-only method, HMAC-signed peer call, no session cookie (pre-auth flow),
 * the `CROW_CSRF_STRICT=0` kill-switch, or a matching token — otherwise WHY it
 * is refused:
 *   - `"missing"`  the request's session yields no token at all (no session);
 *   - `"absent"`   the session is there but the request echoed no token;
 *   - `"mismatch"` a token WAS echoed and is not this session's — the shape of a
 *                  stale page, and the only case a route can usefully answer by
 *                  sending the viewer back to a freshly rendered one.
 * Exported because a route that wants to answer a mismatch its own way must ask
 * the exact same question rather than re-implement the comparison: POST
 * /dashboard/logout redirects a stale form to its confirm page instead of the
 * plain-text 403 (see dashboard/index.js).
 * @param {object} req
 * @returns {null|"missing"|"absent"|"mismatch"}
 */
export function csrfRefusal(req) {
  // Read-only method → nothing to validate.
  if (!STATE_CHANGING_METHODS.has(req.method)) return null;

  // HMAC-signed peer request → bundle router / federation router handle auth.
  if (req.headers["x-crow-signature"]) return null;

  // Pre-auth flow (no session yet) → login/reset/2fa handlers own their own
  // defenses (rate-limit, lockout).
  const expected = csrfTokenForRequest(req);
  if (!expected) return null;

  // Rollback escape hatch.
  if (!strictMode()) return null;

  const headerValue = req.headers[HEADER_NAME];
  const bodyValue = req.body && typeof req.body === "object" ? req.body[BODY_FIELD] : null;
  const presented = headerValue || bodyValue;

  if (!presented) return "absent";
  return safeEqual(String(presented), expected) ? null : "mismatch";
}

/**
 * The same rule for a caller that is not an Express request: a WebSocket whose
 * first frame carries the token. `req` is the upgrade request (its Cookie header
 * holds the session); `presented` is the value the page echoed. Honors the
 * `CROW_CSRF_STRICT=0` kill-switch exactly like the middleware. The caller must
 * already have verified the session.
 */
export function csrfTokenAccepted(req, presented) {
  if (!strictMode()) return true;
  const expected = csrfTokenForRequest(req);
  if (!expected || typeof presented !== "string" || !presented) return false;
  return safeEqual(presented, expected);
}

/**
 * The same comparison WITHOUT the `CROW_CSRF_STRICT` kill-switch, for the flows
 * that must stay forgery-proof even with the dashboard's rollback switch off
 * (the OAuth consent grant, oauth-consent.js). Still server-bound: it recomputes
 * the token from the session the caller already verified.
 */
export function csrfTokenMatches(req, presented) {
  const expected = csrfTokenForRequest(req);
  if (!expected || typeof presented !== "string" || !presented) return false;
  return safeEqual(presented, expected);
}

/**
 * Emit a hidden input carrying the CSRF token. For classic `<form>` submits
 * that don't go through Turbo's auto-header-attach path.
 */
export function csrfInput(req) {
  const token = req && req.csrfToken ? String(req.csrfToken) : "";
  return `<input type="hidden" name="_csrf" value="${escapeHtml(token)}">`;
}

/** The bytes for the `<meta name="crow-csrf">` tag a page renders (layout.js). */
export function csrfMetaTag(token) {
  return `<meta name="crow-csrf" content="${escapeHtml(typeof token === "string" ? token : "")}">`;
}