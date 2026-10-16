/**
 * First-run password for the Actual server Crow deployed (queue item 30, fix B).
 *
 * Crow generates ACTUAL_SERVER_PASSWORD at install and saves it in the Crow keychain; the
 * postInstall hook (scripts/set-server-password.sh) sets it right away, and this is the
 * fallback when that could not run. A new
 * Actual server has no password yet ("needs bootstrap"), so before the first login we
 * set it: GET /account/needs-bootstrap, and only when it reports bootstrapped:false,
 * POST /account/bootstrap { password }. The server itself refuses a second bootstrap
 * ("already-bootstrapped"), so a server someone already set up is never changed.
 *
 * Only for a LOOPBACK server (the bundle's own container is published on 127.0.0.1).
 * A remote Actual server the user points Crow at is theirs to set up; Crow never sends
 * it a password it chose.
 */

export function isLoopbackUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
  } catch {
    return false;
  }
}

/**
 * The password to log in with: ACTUAL_PASSWORD when set (typed: a server the user runs
 * elsewhere), else ACTUAL_SERVER_PASSWORD (generated for the local server) — but that one
 * only for a loopback URL, so it never leaves this machine.
 */
export function effectivePassword(url, env = process.env) {
  if (env.ACTUAL_PASSWORD) return env.ACTUAL_PASSWORD;
  return isLoopbackUrl(url) ? (env.ACTUAL_SERVER_PASSWORD || "") : "";
}

/**
 * Passwords to try, in order: the typed one, then (loopback only) the generated one. A
 * stale typed value (kept in the gateway .env from an older install) must not lock the
 * user out of the server Crow just set up with the generated password.
 */
export function loginCandidates(url, env = process.env) {
  const out = [env.ACTUAL_PASSWORD, isLoopbackUrl(url) ? env.ACTUAL_SERVER_PASSWORD : ""].filter((v) => typeof v === "string" && v !== "");
  return [...new Set(out)];
}

/**
 * @returns {Promise<"bootstrapped"|"ready"|"skipped">}
 *   bootstrapped  this call set the password
 *   ready         the server already had one
 *   skipped       no password, a non-loopback server, or the check failed (login decides)
 */
export async function ensureBootstrapped(baseUrl, password, { fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
  if (!password || !isLoopbackUrl(baseUrl)) return "skipped";
  const base = String(baseUrl).replace(/\/+$/, "");
  const call = async (path, init = {}) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      return await fetchImpl(`${base}${path}`, { ...init, signal: ctl.signal });
    } finally {
      clearTimeout(timer);
    }
  };
  let state;
  try {
    const res = await call("/account/needs-bootstrap");
    if (!res.ok) return "skipped";
    state = await res.json();
  } catch {
    return "skipped";
  }
  if (state?.data?.bootstrapped !== false) return "ready";
  const res = await call("/account/bootstrap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  let body = null;
  try { body = await res.json(); } catch { /* reason unknown */ }
  if (res.ok && body?.status === "ok") return "bootstrapped";
  if (body?.reason === "already-bootstrapped") return "ready";
  throw new Error(`Could not set the Actual server password (${body?.reason || res.status})`);
}
