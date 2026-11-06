/**
 * "Did this request come from a page on this gateway's own origin?" — the
 * first-run rule the dashboard login applies before it will set the FIRST
 * password (N1a-2).
 *
 * The hole it closes: while no password exists, POST /dashboard/login is
 * handled BEFORE `csrfMiddleware` (an anonymous first-run request carries no
 * `crow_session` cookie, and csrf.js deliberately skips those). A bare-loopback
 * first-run POST needs no setup token either (setup-token.js), so any web page
 * open in the owner's browser could auto-submit a form to
 * http://localhost:3001/dashboard/login and choose the owner's password — and
 * then sign in with it. Nothing about the request body, cookie jar or session
 * separates that page from the owner's own.
 *
 * Two headers the browser's network stack writes, and page script can neither
 * read nor forge, do separate them:
 *
 *   - Sec-Fetch-Site: on every request. Anything but "same-origin" — or "none",
 *     which is a typed URL, a bookmark or a non-browser client — is refused.
 *     "same-site" from another port is another origin and is refused too.
 *   - Origin: on every cross-origin form POST. When present it must name an
 *     origin this gateway answers on:
 *       · the scheme://host:port the request reached — the Host header, plus the
 *         X-Forwarded-Host a same-box proxy (Tailscale Serve, the installer's
 *         Caddy over the proxy socket) names, and
 *       · a configured public origin the gateway already calls its own
 *         (issuer-url.js: CROW_OAUTH_ISSUER_URL → CROW_GATEWAY_URL →
 *         RENDER_EXTERNAL_URL).
 *
 * A request carrying NEITHER header is not a browser page (curl, the installer,
 * a bot with a shell): it is allowed through here and left to the setup-token
 * gate next door, exactly as before.
 *
 * This is the rule the WebSocket guards already apply to a handshake —
 * `upgradeFromOwnOrigin` (routes/extension-proxy.js) and the kiosk session
 * socket (bundles/kiosk/server/session-display.js) — with the two differences
 * the HTTP login needs: a missing Origin keeps working (a WebSocket always
 * carries one, curl does not), and the page's scheme is the fronting proxy's,
 * not the loopback hop's behind it. The Origin check still has no
 * configured-origin notion in either, hence this shared piece.
 *
 * Node built-ins only.
 */
import { issuerSource } from "../issuer-url.js";

/** Schemes a browser page can be served from. "null", file:, data: are opaque origins. */
const WEB_SCHEMES = new Set(["http:", "https:"]);

/** Sec-Fetch-Site values that mean "this page is this gateway, or nobody said": a typed URL /
 * bookmark is "none", the setup page's own form is "same-origin". */
const SAME_ORIGIN_SITES = new Set(["same-origin", "none"]);

/** The refusal the first-run POST answers with (403, text/plain): a plain sentence a browser
 * shows as-is, naming no host or path. */
export const FIRST_RUN_CROSS_ORIGIN_MESSAGE =
  "Refused: the first password can only be set from Crow's own page on this machine. "
  + "Open Crow (or the setup link you were sent) and try again.";

/** Header value(s) → trimmed non-empty strings, comma lists split (X-Forwarded-* style). */
function headerList(value) {
  if (value == null) return [];
  return (Array.isArray(value) ? value : [value])
    .flatMap((v) => String(v).split(","))
    .map((v) => v.trim())
    .filter(Boolean);
}

/** One single-valued header (Origin, Sec-Fetch-Site) → string, first value when repeated. */
function headerOne(value) {
  const first = Array.isArray(value) ? value[0] : value;
  return first == null ? "" : String(first).trim();
}

/** "scheme://host:port" URL-normalised (lowercase host, default port dropped), or null for
 * anything a browser would call an opaque origin ("null", file:, an unparseable value). */
function normalizeOrigin(raw) {
  try {
    const url = new URL(String(raw ?? "").trim());
    return WEB_SCHEMES.has(url.protocol) ? url.origin : null;
  } catch {
    return null;
  }
}

/** The origin this host was reached on under `scheme`, or null when the pair is not a web origin. */
function originFor(scheme, host) {
  return normalizeOrigin(`${scheme}://${host}`);
}

/**
 * The origins this request reached this gateway on: Host, plus every
 * X-Forwarded-Host a proxy in front named.
 *
 * The scheme is read from X-Forwarded-Proto when a proxy set it, else from the
 * socket. A request that came through a proxy which terminated the browser's
 * TLS is counted under BOTH web schemes: Serve and the installer's Caddy do not
 * always forward a proto, and the page's scheme is the proxy's, not the loopback
 * hop's. That costs nothing — a foreign page can be served from neither scheme
 * of this host.
 *
 * @param {object} req Express request
 * @returns {Set<string>} URL-normalised origin strings
 */
export function ownRequestOrigins(req) {
  const headers = req?.headers || {};
  const socketHosts = headerList(headers.host).map((h) => h.toLowerCase());
  const forwardedHosts = headerList(headers["x-forwarded-host"]).map((h) => h.toLowerCase());
  const forwardedProtos = headerList(headers["x-forwarded-proto"])
    .map((p) => p.toLowerCase().replace(/:$/, ""))
    .filter((p) => p === "http" || p === "https");
  const socketProto = String(req?.protocol || "http").toLowerCase().replace(/:$/, "");
  const protocols = new Set(forwardedProtos.length ? forwardedProtos : [socketProto]);
  if (forwardedHosts.length) {
    protocols.add("http");
    protocols.add("https");
  }
  const origins = new Set();
  for (const host of new Set([...socketHosts, ...forwardedHosts])) {
    for (const scheme of protocols) {
      const origin = originFor(scheme, host);
      if (origin) origins.add(origin);
    }
  }
  return origins;
}

/**
 * The configured public origin the gateway already treats as its own, as
 * issuer-url.js resolves it (CROW_OAUTH_ISSUER_URL → CROW_GATEWAY_URL →
 * RENDER_EXTERNAL_URL). Empty when nothing is configured.
 *
 * @param {object} [env] environment to read (tests)
 * @returns {Set<string>} zero or one URL-normalised origin
 */
export function configuredOwnOrigins(env = process.env) {
  const origin = normalizeOrigin(issuerSource(env));
  return new Set(origin ? [origin] : []);
}

/**
 * Does this Origin header value name this gateway?
 *
 * @param {object} req Express request
 * @param {string} raw the Origin header value
 * @param {{ env?: object }} [opts]
 * @returns {boolean} false for an opaque or unparseable Origin ("null", file:, junk)
 */
export function originIsOwn(req, raw, { env = process.env } = {}) {
  const origin = normalizeOrigin(raw);
  if (!origin) return false;
  return ownRequestOrigins(req).has(origin) || configuredOwnOrigins(env).has(origin);
}

/**
 * The first-run gate for a browser-submitted request: true unless the browser
 * says another site sent it (Sec-Fetch-Site) or names another site
 * (Origin). Absent headers keep today's behaviour.
 *
 * @param {object} req Express request
 * @param {{ env?: object }} [opts]
 * @returns {boolean}
 */
export function isSameOriginRequest(req, { env = process.env } = {}) {
  const headers = req?.headers || {};
  if (headers["sec-fetch-site"] !== undefined && headers["sec-fetch-site"] !== null) {
    const site = headerOne(headers["sec-fetch-site"]).toLowerCase();
    if (!SAME_ORIGIN_SITES.has(site)) return false;
  }
  const origin = headerOne(headers.origin);
  if (!origin) return true; // no Origin at all: a script on the box, not a page
  return originIsOwn(req, origin, { env });
}