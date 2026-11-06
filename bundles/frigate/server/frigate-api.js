/**
 * Frigate HTTP client — JWT auth flow.
 *
 * Frigate :8971 requires a JWT login via POST /api/login. The token is returned
 * both as a Set-Cookie and (more usefully for Node) in the JSON body. Node's
 * built-in fetch has no cookie jar, so we use the Authorization: Bearer path —
 * same pattern as bundles/actual-budget/panel/routes.js.
 *
 * We assume Frigate is configured with `tls.enabled: false` (our
 * config.yml.example default — the self-signed cert Frigate ships adds no
 * security on loopback). If the operator re-enables TLS, set FRIGATE_URL to
 * an https:// URL and export NODE_TLS_REJECT_UNAUTHORIZED=0 on the MCP server
 * environment (acceptable risk only on tailnet/loopback deployments).
 *
 * Also provides a 30s response cache on GET requests so chatty AI chat polling
 * (e.g. list_events every question) can't drive Frigate to 100% CPU.
 *
 * Logins are serialised: Frigate rate-limits `POST /api/login` (one per second by
 * default), so several concurrent tools starting cold produced one login each and a
 * pile of 429s reported as bad credentials. One in-flight login is shared by every
 * caller, and a 429 is retried after a short pause.
 */

const FRIGATE_URL = () => (process.env.FRIGATE_URL || "http://localhost:8971").replace(/\/+$/, "");
const FRIGATE_USER = () => process.env.FRIGATE_USER || "";
const FRIGATE_PASSWORD = () => process.env.FRIGATE_PASSWORD || "";

const CACHE_TTL_MS = 30_000;
const BAD_CREDENTIALS_MESSAGE = "Frigate login failed — check FRIGATE_USER / FRIGATE_PASSWORD";
const RATE_LIMIT_MESSAGE = "Frigate is rate-limiting logins; try again in a moment";
/** Frigate allows one login per second; wait past that window before trying again. */
const LOGIN_RETRY_MS = 1100;
const LOGIN_MAX_RETRIES = 3;

let authToken = null;
/** The login every waiting caller shares, cleared as soon as it settles. */
let loginInFlight = null;
const cache = new Map(); // key → { data, expires }

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** POST /api/login once, retrying a 429 a few times before giving up. */
async function login() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${FRIGATE_URL()}/api/login`, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user: FRIGATE_USER(), password: FRIGATE_PASSWORD() }),
      });
      if (res.status === 429) {
        if (attempt >= LOGIN_MAX_RETRIES) throw new Error(RATE_LIMIT_MESSAGE);
        await sleep(LOGIN_RETRY_MS);
        continue;
      }
      if (res.status === 401 || res.status === 403) throw new Error(BAD_CREDENTIALS_MESSAGE);
      if (!res.ok) throw new Error(`Frigate login failed: HTTP ${res.status}`);

      // Frigate returns JWT in JSON body AND as cookie; read JSON for the Bearer path.
      const data = await res.json().catch(() => ({}));
      let token = data.access_token || data.token || null;
      // Some builds only set cookie — fall back to cookie-only mode by stashing a sentinel.
      if (!token) {
        const setCookie = res.headers.get("set-cookie") || "";
        const match = setCookie.match(/frigate_token=([^;]+)/);
        if (match) token = match[1];
      }
      if (!token) throw new Error("Frigate /api/login returned no token");
      return token;
    }
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Frigate login timed out");
    if (err.message.includes("fetch failed") || err.message.includes("ECONNREFUSED")) {
      throw new Error(`Cannot reach Frigate at ${FRIGATE_URL()} — is the container running?`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Authenticate with Frigate and obtain a JWT. Cached in-memory; concurrent callers
 * share one in-flight login instead of racing into Frigate's login rate limit.
 * Returns null if no credentials are configured (auth.enabled=false mode).
 */
async function getToken() {
  if (authToken) return authToken;
  if (!FRIGATE_USER() || !FRIGATE_PASSWORD()) return null;

  if (!loginInFlight) {
    loginInFlight = login()
      .then((token) => {
        authToken = token;
        return token;
      })
      .finally(() => {
        loginInFlight = null;
      });
  }
  return loginInFlight;
}

/**
 * Perform an authenticated request against the Frigate API.
 * GETs are cached for 30s unless `opts.nocache` is set.
 */
export async function frigateFetch(path, opts = {}) {
  const method = (opts.method || "GET").toUpperCase();
  const cacheKey = method === "GET" ? `${method} ${path}` : null;

  if (cacheKey && !opts.nocache) {
    const hit = cache.get(cacheKey);
    if (hit && hit.expires > Date.now()) return hit.data;
  }

  const token = await getToken();
  const url = `${FRIGATE_URL()}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const headers = {
      "Content-Type": "application/json",
      ...opts.headers,
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch(url, { ...opts, signal: controller.signal, headers });

    if (res.status === 401) {
      authToken = null; // force re-login on next call
      throw new Error("Frigate authentication expired or invalid — will retry on next request");
    }
    if (!res.ok) {
      if (res.status === 404) throw new Error(`Frigate endpoint not found: ${path}`);
      throw new Error(`Frigate API error: ${res.status} ${res.statusText}`);
    }

    const text = await res.text();
    const data = text ? JSON.parse(text) : {};

    if (cacheKey) {
      cache.set(cacheKey, { data, expires: Date.now() + CACHE_TTL_MS });
    }
    return data;
  } catch (err) {
    if (err.name === "AbortError") throw new Error(`Frigate request timed out: ${path}`);
    if (err.message.includes("fetch failed") || err.message.includes("ECONNREFUSED")) {
      throw new Error(`Cannot reach Frigate at ${FRIGATE_URL()} — is the container running?`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Drop cached responses. Called after mutations so subsequent reads see fresh state.
 */
export function clearCache() {
  cache.clear();
}

/**
 * Expose FRIGATE_URL for snapshot/clip URL builders (they need the base URL).
 */
export function frigateBaseUrl() {
  return FRIGATE_URL();
}
