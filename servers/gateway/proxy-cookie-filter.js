/**
 * Proxy cookie policy — ONE rule, shared by every gateway reverse proxy that
 * serves a third-party app on the dashboard's ORIGIN.
 *
 * Crow proxies more than one such app: installed bundles' web UIs at
 * `/proxy/<id>/` (routes/extension-proxy.js) and the AI companion at
 * `/companion/*` (routes/companion-proxy.js). Both hand a request the gateway
 * has already authenticated to code nobody audited, and both hand the answer
 * back to the browser on the dashboard's own origin. So both need the same
 * rules, and having them in two places is how one of them drifts:
 *
 *   1. REQUEST — the browser's `Cookie` header goes upstream with Crow's own
 *      cookies removed (`stripCrowCookiesForBackend`). `crow_session` is a
 *      live, replayable dashboard session; an app must never hold it.
 *   2. RESPONSE — the app's `Set-Cookie` is re-scoped under the app's mount
 *      path, and refused outright for a Crow name (`rewriteProxySetCookie`).
 *   3. WEBSOCKET HANDSHAKE — every `Set-Cookie` in the app's handshake response
 *      is dropped (`stripSetCookieFromHandshake`). A 101 never goes through
 *      http-proxy's `proxyRes` hook — http-proxy writes the upstream's header
 *      block straight to the client socket — so rule 2 would be bypassed by a
 *      `Set-Cookie: crow_session=…` in the 101. The 101 (and a non-upgrade
 *      error response to an upgrade) is a handshake, not a document header, so
 *      it gets the stricter rule: no cookies at all.
 *
 * The Set-Cookie direction is a real PARSER, not a regex (review: the regex
 * version was wrong twice over). RFC 6265 §5.2 splits on ';' and trims spaces
 * around an attribute NAME (`Path =/` is a Path attribute), and §5.3 keeps the
 * LAST occurrence of a repeated attribute. So `a=1; Path=/x; Path =/` — which
 * `/;\s*path=/` never matched — landed `Path=/` on the whole dashboard origin,
 * and `Domain =example.test` survived `/\s*domain=/` the same way. Splitting
 * the header into segments, lower-casing each attribute name and dropping
 * every `path`/`domain` segment has no such blind spot; exactly one `Path` is
 * then written back.
 *
 * A nameless cookie (`=crow_session=abc`) is dropped too: browsers ignore the
 * empty name and SEND the value back as `crow_session=abc`, i.e. a forged
 * dashboard session minted by the proxied app (see setCookieName's note).
 *
 * Crow's names live in ONE list next to this file (`cookie-names.js`), shared
 * with every setter — see tests/extension-proxy-cookies.test.js.
 */
import { isCrowCookieName, stripCrowCookieHeader } from "./cookie-names.js";

/**
 * Remove every `Set-Cookie` header LINE from an HTTP header block (status line
 * + headers + the blank line), leaving every other byte alone.
 *
 * Obsolete line folding is honoured: a continuation line belongs to the header
 * above it, so a folded `Set-Cookie` is dropped whole rather than leaving its
 * tail behind as a header of its own.
 *
 * @param {string} text the header block, binary/latin1
 * @returns {string}
 */
function dropSetCookieLines(text) {
  const end = text.indexOf("\r\n\r\n");
  const head = end === -1 ? text : text.slice(0, end);
  const tail = end === -1 ? "" : text.slice(end);
  const lines = head.split("\r\n");
  const kept = [lines[0]];
  let dropping = false;
  for (const line of lines.slice(1)) {
    if (/^[ \t]/.test(line)) {
      if (!dropping) kept.push(line);
      continue;
    }
    dropping = /^set-cookie[ \t]*:/i.test(line);
    if (!dropping) kept.push(line);
  }
  return kept.join("\r\n") + tail;
}

/** How many bytes to hold back while waiting for the end of a header block. */
const MAX_HANDSHAKE_HEADER_BYTES = 64 * 1024;

/** Marks a socket whose `write` is already filtered (never wrap twice). */
const HANDSHAKE_FILTERED = Symbol.for("crow.proxy.handshake-filtered");

/** A socket write chunk as a Buffer, or null for a type we cannot inspect. */
function chunkToBuffer(chunk, encoding) {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === "string") return Buffer.from(chunk, typeof encoding === "string" ? encoding : "utf8");
  if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  return null;
}

/**
 * Drop every `Set-Cookie` from the WebSocket handshake the app is about to send
 * the browser — call it from the `proxyReqWs` hook, which http-proxy emits
 * BEFORE the upstream's response headers are written to the client socket.
 *
 * http-proxy has no response hook on the upgrade path: it builds a 101 (or an
 * error response) out of the upstream's own headers and calls `socket.write`
 * with it (node_modules/http-proxy/lib/http-proxy/passes/ws-incoming.js). So
 * the only place to filter it is the socket. `write` is wrapped until the first
 * header block (the first `\r\n\r\n`); every `Set-Cookie` line in it is
 * dropped and everything after the header block — the WebSocket frames, in
 * both directions — is passed through byte for byte.
 *
 * ALL cookies are dropped here, not just Crow's: a handshake is not a document
 * response, and nothing on a WebSocket route needs to set one.
 *
 * @param {import('net').Socket} socket the client socket being upgraded
 * @returns {import('net').Socket} the same socket
 */
export function stripSetCookieFromHandshake(socket) {
  if (!socket || typeof socket.write !== "function" || socket[HANDSHAKE_FILTERED]) return socket;
  Object.defineProperty(socket, HANDSHAKE_FILTERED, { value: true, enumerable: false, configurable: true });
  const write = socket.write;
  let pending = [];
  let done = false;

  socket.write = function writeHandshakeFiltered(chunk, encoding, callback) {
    if (done) return write.call(this, chunk, encoding, callback);
    const cb = typeof encoding === "function" ? encoding : callback;
    const buf = chunkToBuffer(chunk, typeof encoding === "function" ? undefined : encoding);
    if (!buf) {
      // Not something we can inspect: stop filtering and pass it through.
      done = true;
      const rest = pending.length ? Buffer.concat(pending) : null;
      pending = [];
      if (rest && rest.length) write.call(this, rest);
      return write.call(this, chunk, encoding, callback);
    }
    pending.push(buf);
    const all = pending.length === 1 ? pending[0] : Buffer.concat(pending);
    const end = all.indexOf("\r\n\r\n");
    if (end === -1) {
      if (all.length <= MAX_HANDSHAKE_HEADER_BYTES) {
        pending = [all];
        return true; // nothing sent yet; backpressure cannot apply
      }
      // Not a header block (or absurdly large): give up and pass it through.
      pending = [];
      done = true;
      const ret = write.call(this, all);
      if (typeof cb === "function") cb();
      return ret;
    }
    pending = [];
    done = true;
    const kept = Buffer.from(dropSetCookieLines(all.subarray(0, end + 4).toString("latin1")), "latin1");
    const rest = all.subarray(end + 4);
    let ret = write.call(this, kept);
    if (rest.length) ret = write.call(this, rest);
    if (typeof cb === "function") cb();
    return ret;
  };
  return socket;
}

/**
 * A cookie NAME as it appears before the first `=`, with RFC 6265 quoting
 * removed (`"crow_session"` → `crow_session`). A quoted name is still that
 * name to a browser, so it must be compared unquoted.
 *
 * @param {unknown} token raw name text
 * @returns {string}
 */
function unquoteName(token) {
  const name = String(token ?? "").trim();
  if (name.length >= 2 && name.startsWith('"') && name.endsWith('"')) return name.slice(1, -1).trim();
  return name;
}

/**
 * The cookie name of a `Set-Cookie` value (`name=value; Path=/…`), or "".
 *
 * @param {unknown} value one `Set-Cookie` header value
 * @returns {string} the unquoted name, "" when there is no `=` in the
 *   `name=value` segment or the name is empty
 */
export function setCookieName(value) {
  const pair = String(value ?? "").split(";")[0].trim();
  const eq = pair.indexOf("=");
  if (eq === -1) return "";
  return unquoteName(pair.slice(0, eq));
}

/**
 * Parse a `Set-Cookie` value the way RFC 6265 §5.2 does — the first segment is
 * `name=value`, every later segment is an attribute whose NAME is the text
 * before the first `=`, trimmed and case-insensitive.
 *
 * `path` is the value of the LAST `Path` attribute (what a browser keeps), or
 * null when the cookie has none; `path`/`domain` attributes are NOT part of
 * `attributes` — the caller writes exactly one Path and never a Domain.
 *
 * `name` is the name EXACTLY as the app wrote it, quotes included: a browser
 * treats `"a"=1` as the cookie `a`, but re-serialising it as `a=1` would silently
 * change what the app sent. Quotes are only removed for the Crow-name
 * comparison (`setCookieName` / `shouldDropSetCookie`).
 *
 * @param {unknown} value one `Set-Cookie` header value
 * @returns {{name: string, value: string, attributes: string[], path: string|null}|null}
 *   null when the header is not a cookie at all (no `=`, or an empty name)
 */
export function parseSetCookie(value) {
  const raw = String(value ?? "");
  if (!raw.trim()) return null;
  const segments = raw.split(";");
  const pair = segments[0].trim();
  const eq = pair.indexOf("=");
  if (eq === -1) return null; // no name=value: not a cookie (a Set-Cookie with no '=')
  const name = pair.slice(0, eq).trim(); // kept verbatim in the output
  if (!unquoteName(name)) return null; // `=crow_session=abc` — see setCookieName / the module note

  const attributes = [];
  let path = null;
  for (const segment of segments.slice(1)) {
    const attr = segment.trim();
    if (!attr) continue;
    const attrEq = attr.indexOf("=");
    const attrName = (attrEq === -1 ? attr : attr.slice(0, attrEq)).trim().toLowerCase();
    if (attrName === "path") {
      path = attrEq === -1 ? "" : attr.slice(attrEq + 1).trim();
      continue; // rewritten, never forwarded as-is
    }
    if (attrName === "domain") continue; // dropped: the page is the dashboard's host
    attributes.push(attr);
  }
  return { name, value: pair.slice(eq + 1).trim(), attributes, path };
}

/**
 * Whether a backend's `Set-Cookie` must be dropped rather than forwarded.
 *
 * Dropped when it is not a cookie at all (empty, or no `=` in the first
 * segment), when its name is empty, or when its name is one of Crow's own
 * (`isCrowCookieName`, quotes removed) — `crow_session`, `crow_csrf`, …
 *
 * @param {unknown} value one `Set-Cookie` header value
 * @returns {boolean}
 */
export function shouldDropSetCookie(value) {
  const raw = String(value ?? "");
  if (!raw.trim()) return true;
  // `=crow_session=abc`: browsers drop the empty name and send the VALUE back
  // as the cookie, so the app would mint `crow_session=abc` on our origin.
  if (raw.split(";")[0].trim().startsWith("=")) return true;
  const name = setCookieName(raw);
  return !name || isCrowCookieName(name);
}

/** Decode `%2e%2e` too — a percent-encoded `..` is still traversal. */
function decodeLoose(path) {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** A Path value that climbs upward (`..`, also percent-encoded) or carries a control char. */
function unsafePathSuffix(path) {
  if (/[\u0000-\u001f\u007f]/.test(path)) return true;
  return [path, decodeLoose(path)].some((p) => p.split(/[/\\]/).some((seg) => seg === ".."));
}

/**
 * The mount-scoped `Path` a backend cookie is re-issued with.
 *
 * `Path=/api` → `/proxy/<id>/api` (the app's own sub-path, preserved — the
 * proxied URL is `…/api` too); `Path=/` or no Path → `/proxy/<id>/`; a Path
 * that is not absolute, or that tries to climb out (`..`), is discarded and
 * the mount root used. A trailing slash on `proxyPath` is tolerated.
 *
 * @param {string} proxyPath the mount path, e.g. "/proxy/browser"
 * @param {string|null} backendPath the app's LAST Path attribute, if any
 * @returns {string} e.g. "/proxy/browser/api"
 */
export function proxyCookiePath(proxyPath, backendPath) {
  const scope = `${String(proxyPath ?? "").replace(/\/+$/, "")}/`;
  if (typeof backendPath !== "string" || backendPath === "") return scope;
  const path = backendPath.trim();
  if (!path.startsWith("/") || unsafePathSuffix(path)) return scope;
  const suffix = path.replace(/^\/+/, "");
  return suffix ? `${scope}${suffix}` : scope;
}

/**
 * A backend's `Set-Cookie` value, re-scoped under the app's mount path, or
 * null when the cookie must be dropped.
 *
 * Every Path attribute is replaced by exactly one scoped Path (the app's LAST
 * Path wins, and its sub-path is kept), every Domain attribute is dropped, and
 * every other attribute is preserved in order. The name is forwarded exactly as
 * the app wrote it (a quoted name keeps its quotes).
 *
 * @param {unknown} value one `Set-Cookie` header value
 * @param {string} proxyPath the mount path, e.g. "/proxy/browser" or "/companion"
 * @returns {string|null} the value to forward, or null to drop it
 */
export function rewriteProxySetCookie(value, proxyPath) {
  if (shouldDropSetCookie(value)) return null;
  const cookie = parseSetCookie(value);
  if (!cookie) return null;
  return [
    `${cookie.name}=${cookie.value}`,
    ...cookie.attributes,
    `Path=${proxyCookiePath(proxyPath, cookie.path)}`,
  ].join("; ");
}

/**
 * Re-scope a whole `Set-Cookie` response header (one value or an array).
 *
 * @param {string|string[]|undefined|null} header `proxyRes.headers["set-cookie"]`
 * @param {string} proxyPath the mount path, e.g. "/proxy/browser"
 * @returns {string[]|null} the values to forward, or null when nothing is left
 *   (the caller then deletes the header rather than sending an empty one)
 */
export function scopeProxySetCookieHeader(header, proxyPath) {
  if (header === undefined || header === null) return null;
  const kept = (Array.isArray(header) ? header : [header])
    .map((value) => rewriteProxySetCookie(value, proxyPath))
    .filter((value) => value !== null);
  return kept.length ? kept : null;
}

/**
 * Remove Crow's own cookies from the `Cookie` header of the request about to
 * be handed to a proxied backend — HTTP and the WebSocket upgrade both.
 *
 * The gateway has already authenticated the request. What it must NOT hand
 * over is the credential itself: a proxied app is third-party code, and
 * `crow_session` is a live dashboard session it could replay from anywhere.
 * Every other cookie (the app's own) is forwarded as-is. If nothing remains,
 * the header is dropped entirely.
 *
 * @param {import('http').ClientRequest} proxyReq the upstream request
 */
export function stripCrowCookiesForBackend(proxyReq) {
  if (!proxyReq || typeof proxyReq.getHeader !== "function") return;
  const header = proxyReq.getHeader("cookie");
  if (header === undefined || header === null) return;
  const remaining = stripCrowCookieHeader(header);
  if (remaining) {
    proxyReq.setHeader("cookie", remaining);
    return;
  }
  if (typeof proxyReq.removeHeader === "function") proxyReq.removeHeader("cookie");
}