/**
 * The artifact origin (spec §3.2, §5.1; D13). A separate, minimal node:http
 * listener that serves artifact CONTENT only, under /v/<view-token>/<path>.
 *
 * Deliberately NOT Express and NOT the gateway app: it shares no middleware,
 * session handling or Funnel-prefix allowlist with the dashboard (no
 * sessionFromRequest, no dashboardAuth, no GATEWAY_FUNNEL_PUBLIC_PREFIXES).
 *
 * Rules on EVERY response (200, 304-free, 404, 403, 405, 500, HEAD):
 *   - a CSP with a `sandbox` directive (policy.js) — a top-level load is an
 *     opaque origin too (review E14);
 *   - nosniff, no-referrer, no-store, noindex;
 *   - never Set-Cookie, never a redirect (no 3xx is ever produced).
 * Node's own parse errors (malformed request line → 400, oversized headers →
 * 431) bypass the request handler; a `clientError` handler writes them with
 * the same base headers. A connection that times out is destroyed WITHOUT any
 * response (documented residual: there are no bytes to protect).
 * The Cookie header is removed from every header view (`headers`, the lazily
 * cached `headersDistinct`, and `rawHeaders`) before anything else looks at
 * the request, and nothing here logs request headers or paths (paths carry
 * tokens).
 * Any request carrying Tailscale-Funnel-Request gets 403 (the origin is never
 * public; CROW_DASHBOARD_PUBLIC does not override this).
 * Range requests are not honoured: the full body is returned with 200.
 * The CSP source base is `publicBase`, else the fixed loopback fallback
 * `http://localhost:<port>` — NEVER derived from the request's Host header
 * (review L3: a forged Host cannot widen script-src).
 */
import http from "node:http";
import { cspFor, baseHeaders, isScriptedType, effectiveType } from "./policy.js";
import { TOKEN_RE } from "./view-tokens.js";
import { anchorHelperSource } from "./anchor-helper.js";

const ROUTE_RE = /^\/v\/([A-Za-z0-9_-]{43})\/([^?#]*)(?:\?[^#]*)?$/;
const HELPER_PATH = "__crow/anchor-helper.js";
const MAX_PATH_LEN = 512;

/** Peer classifier — the dashboard's isAllowedNetwork rule without its cookie
 *  leg, without the tailscale-user-login leg (review L4: the header is
 *  client-supplied, and the socket address already covers every real path —
 *  Serve proxies from loopback) and without the CROW_DASHBOARD_PUBLIC
 *  override. Loopback is allowed: the listener binds loopback and is reached
 *  through Tailscale Serve (which proxies from 127.0.0.1) or, on the
 *  fallback, from this machine only. */
export function artifactRequestAllowed(req) {
  if (req.headers["tailscale-funnel-request"] != null) return false;
  const a = String(req.socket?.remoteAddress || "").replace(/^::ffff:/, "");
  if (a === "127.0.0.1" || a === "::1") return true;
  if (/^10\./.test(a) || /^192\.168\./.test(a) || /^172\.(1[6-9]|2\d|3[01])\./.test(a)) return true;
  const p = a.split(".").map(Number);
  return p.length === 4 && p[0] === 100 && p[1] >= 64 && p[1] <= 127;
}

/** Decode and validate the in-version path; null when it is not a plain,
 *  normalised relative path. "" means the version's index.html. */
export function cleanRelPath(raw) {
  if (raw.length > MAX_PATH_LEN) return null;
  if (raw === "") return "index.html";
  const segs = raw.split("/");
  const out = [];
  for (const enc of segs) {
    let s;
    try { s = decodeURIComponent(enc); } catch { return null; }
    if (s === "" || s === "." || s === ".." || /[\\/\0]/.test(s) || /[\u0000-\u001f]/.test(s)) return null;
    out.push(s);
  }
  return out.join("/");
}

/**
 * Helper placement WITHOUT parsing the page (security review: no parser
 * differentials). The helper goes at a fixed spot: after an optional BOM,
 * leading whitespace and a `<!doctype …>` (so standards mode is kept), else at
 * byte 0. Placement is NOT a security decision: nothing here grants or removes
 * a capability (the CSP header does that). If bot markup stops the helper from
 * running, the viewer gets no hello and trips `no-hello` (fail closed).
 */
export function injectHelper(html, nonce) {
  const tag = `<script src="${HELPER_PATH}?n=${encodeURIComponent(nonce)}"></script>`;
  let i = html.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (i < html.length && i < 4096 && (html[i] === " " || html[i] === "\n" || html[i] === "\r" || html[i] === "\t" || html[i] === "\f")) i++;
  if (html.slice(i, i + 9).toLowerCase() === "<!doctype") {
    const e = html.indexOf(">", i);
    if (e >= 0 && e - i < 1024) return html.slice(0, e + 1) + tag + html.slice(e + 1);
  }
  return html.slice(0, i) + tag + html.slice(i);
}

/**
 * @param {object} o
 * @param {{ check(token: string): any }} o.tokens  view-token store
 * @param {(q: { artifactId: string, versionN: number, path: string }) => Promise<{ body: Buffer|string, contentType: string }|null>} o.resolveContent
 * @param {string|null} o.publicBase  the absolute origin the browser uses
 *   (e.g. https://artifacts.example.ts.net). null → `fallbackBase` is used.
 * @param {string|null} o.fallbackBase  the fixed loopback origin
 *   (http://localhost:<port>); never the request's Host header (review L3).
 * @param {(ev: { status: number }) => void} [o.onResponse]  metrics hook (status only).
 */
export function createArtifactOriginHandler({ tokens, resolveContent, publicBase = null, fallbackBase = null, onResponse = () => {} }) {
  const strictCsp = cspFor(null);
  const base = publicBase || fallbackBase || "http://localhost";
  function send(res, status, { csp = strictCsp, headers = {}, body = "", head = false } = {}) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    res.writeHead(status, { ...baseHeaders(csp), "content-length": String(buf.length), ...headers });
    res.end(head ? undefined : buf);
    try { onResponse({ status }); } catch {}
  }

  return async function handle(req, res) {
    // First lines, before any handler or log can see it (spec §5.1): strip the
    // dashboard's cookie from EVERY header view (review L2). Order matters:
    // headersDistinct is built lazily from rawHeaders and then cached, so it is
    // touched before rawHeaders is spliced.
    delete req.headers.cookie;
    try { delete req.headersDistinct.cookie; } catch {}
    const rh = req.rawHeaders;
    if (Array.isArray(rh)) {
      for (let i = 0; i + 1 < rh.length; i += 2) {
        if (String(rh[i]).toLowerCase() === "cookie") { rh.splice(i, 2); i -= 2; }
      }
    }
    const head = req.method === "HEAD";
    try {
      if (req.method !== "GET" && !head) return send(res, 405, { headers: { allow: "GET, HEAD" }, body: "method not allowed", head });
      if (!artifactRequestAllowed(req)) return send(res, 403, { body: "forbidden", head });
      const m = ROUTE_RE.exec(req.url || "");
      if (!m || !TOKEN_RE.test(m[1])) return send(res, 404, { body: "not found", head });
      const grant = tokens.check(m[1]);
      if (!grant) return send(res, 404, { body: "not found", head });
      const rel = cleanRelPath(m[2]);
      if (rel == null) return send(res, 404, { body: "not found", head });

      const tokenBase = `${base}/v/${m[1]}/`;
      const type = effectiveType(grant.type, grant.scriptsOff);   // D20
      const csp = cspFor(type, { tokenBase, frameAncestors: grant.dashboardOrigin });
      const scripted = isScriptedType(type);
      // Module scripts from an opaque origin are CORS requests (Origin: null),
      // so scripted 200s carry ACAO * (never with credentials) — spec §5.2.
      const cors = scripted ? { "access-control-allow-origin": "*" } : {};

      if (rel === HELPER_PATH) {
        if (!scripted) return send(res, 404, { csp, body: "not found", head });
        return send(res, 200, { csp, headers: { "content-type": "text/javascript; charset=utf-8", ...cors }, body: anchorHelperSource(grant.nonce), head });
      }
      const c = await resolveContent({ artifactId: grant.artifactId, versionN: grant.versionN, path: rel });
      if (!c) return send(res, 404, { csp, body: "not found", head });
      let body = c.body;
      // Scripts-off (D20) is enforced by the CSP header alone: no markup is
      // rewritten for safety anywhere on this listener.
      if (scripted && /^text\/html/i.test(c.contentType)) body = injectHelper(Buffer.isBuffer(body) ? body.toString("utf8") : String(body), grant.nonce);
      return send(res, 200, { csp, headers: { "content-type": c.contentType, ...cors }, body, head });
    } catch {
      return send(res, 500, { body: "error", head });
    }
  };
}

/**
 * Node writes its own parse-error responses (400 malformed, 431 oversized
 * headers) unless a `clientError` handler answers first — the defaults carry
 * no CSP and no nosniff, which breaks the "every response" rule (review L1).
 * A timed-out connection emits no clientError and is destroyed silently: no
 * response exists to carry headers (documented residual).
 */
function clientErrorResponse(err, sock) {
  try {
    if (!sock || !sock.writable) return void sock?.destroy?.();
    const overflow = err && err.code === "HPE_HEADER_OVERFLOW";
    const heads = { ...baseHeaders(cspFor(null)), "content-length": "0", connection: "close" };
    const lines = Object.entries(heads).map(([k, v]) => `${k}: ${v}`).join("\r\n");
    sock.end(`HTTP/1.1 ${overflow ? "431 Request Header Fields Too Large" : "400 Bad Request"}\r\n${lines}\r\n\r\n`);
  } catch { try { sock?.destroy?.(); } catch {} }
}

/** Start the listener. Returns the http.Server (caller owns close()). */
export async function startArtifactOrigin({ port, host = "127.0.0.1", ...opts }) {
  const server = http.createServer();
  // Bound header sizes; no keep-alive games: plain defaults are fine for a
  // read-only content server.
  server.headersTimeout = 10000;
  server.requestTimeout = 30000;
  server.on("clientError", clientErrorResponse);
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
  // The fallback CSP base is the origin browsers actually use in fallback
  // mode — http://localhost:<actual port> — never the request's Host header.
  const fallbackBase = opts.fallbackBase || (opts.publicBase ? null : `http://localhost:${server.address().port}`);
  server.on("request", createArtifactOriginHandler({ ...opts, fallbackBase }));
  return server;
}
