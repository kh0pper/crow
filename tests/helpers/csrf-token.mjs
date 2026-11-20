/**
 * Test helper: the SERVER-BOUND CSRF token for a session.
 *
 * Since queue item #51 PR-1 the dashboard's CSRF token is
 * HMAC-SHA256(<CROW_HOME>/secrets/csrf.key, session id), not a value read from
 * the retired `crow_csrf` cookie. A test that drives a real csrfMiddleware (or a
 * route that checks the token itself) computes it here, through the real module,
 * so the token always matches what the server would issue.
 *
 * Synchronous on purpose: a fixture that builds its header map in a plain
 * expression (authHeaders(token)) must be able to call it without awaiting.
 *
 * The suite runs every process with a scratch CROW_HOME, so the key is the
 * suite's own and no test can touch a real instance's.
 */
import { csrfTokenForSession } from "../../servers/gateway/dashboard/shared/csrf.js";

/** The CSRF token for a session id. */
export function csrfTokenFor(sessionToken) {
  return csrfTokenForSession(sessionToken);
}

/** The `X-Crow-Csrf` value for a session, for use in a fetch/request header map. */
export function csrfHeaders(sessionToken) {
  return { "x-crow-csrf": csrfTokenForSession(sessionToken) };
}