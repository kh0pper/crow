/**
 * Session display only — kiosk.js imports this on demand, in session mode, so a paired display
 * never asks for it. The SERVER-BOUND CSRF token: an HMAC over the dashboard session, from
 * GET /dashboard/csrf. Never a cookie. Cached for the page's life, so a reconnect costs no fetch.
 */
let token = "";
export async function loadCsrf() {
  if (token) return token;
  try {
    const r = await fetch("/dashboard/csrf", { credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" } });
    if (r.ok) { const j = await r.json().catch(() => null); if (j && typeof j.token === "string") token = j.token; }
  } catch { /* offline: the hello carries an empty token and the socket is refused */ }
  return token;
}