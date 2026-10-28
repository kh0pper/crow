/**
 * Fetch a web page for citation: the guarded request (this half) and, later in this file, the
 * page extraction built on it. Shared by the research server and the reader bundle (bundles
 * import it through the app root, never a relative path).
 *
 * The URLs come from bots, which may be prompt-injected, so the request is an SSRF guard first:
 *
 * - Scheme: only http: and https:. A URL carrying credentials (`user:pass@`) is refused.
 * - Address: every connection goes through `guardedLookup`, which resolves the name ONCE and hands
 *   the socket exactly the addresses it checked. There is no second resolution between the check
 *   and the connect, so a DNS answer that changes between calls (rebinding) cannot steer the
 *   socket somewhere unchecked: the connected IP is the checked IP. `agent: false` gives each hop a
 *   fresh socket, so no pooled connection skips the lookup. Node does not call `lookup` for an
 *   IP-literal host, so literals are checked up front, before `request()`.
 * - Redirects: followed by hand, at most MAX_REDIRECTS, and every hop re-runs the scheme,
 *   credential and address checks.
 * - Size: a declared Content-Length over `maxBytes` is refused before the body is read; otherwise
 *   the DECOMPRESSED bytes are counted while streaming and the stream is destroyed when they pass
 *   `maxBytes` (a small gzip bomb trips it). Over the cap is an error; there is no partial result.
 * - Time: one AbortSignal.timeout is created when the call starts and covers every hop and every
 *   body read, so a slow redirect chain or a server dripping a byte at a time cannot hold the
 *   caller past `timeoutMs`. The abort surfaces as ETIMEDOUT.
 *
 * Errors carry `code`: EBADURL, EBLOCKED, EREDIRECTS, ETOOBIG, EBADENCODING, ETIMEDOUT, or the
 * DNS/socket code (ENOTFOUND, ECONNREFUSED, ...). Non-2xx responses resolve; the caller decides.
 *
 * `allowPrivate` exists only for the reader's operator opt-out. The research server never passes
 * it: bots choose its URLs.
 */
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import zlib from "node:zlib";
import { isIP } from "node:net";
import { pipeline } from "node:stream/promises";
import { isPublicEgressIp } from "./ip-classify.js";
import { createHash } from "node:crypto";
import { extractInWorker } from "./fetch-page-worker.js";

export const FETCH_TIMEOUT_MS = 15000;
export const MAX_PAGE_BYTES = 5 * 1024 * 1024;
export const MAX_REDIRECTS = 5;
export const USER_AGENT = "Mozilla/5.0 (compatible; Crow-Research/1.0)";

const DEFAULT_ACCEPT = "text/html, application/xhtml+xml, text/plain;q=0.9, application/pdf;q=0.8, */*;q=0.5";

const fail = (code, message) => Object.assign(new Error(message), { code });

/**
 * A dns.lookup-shaped function that resolves once, refuses the whole answer if any address is not
 * allowed, and returns exactly the checked addresses to the socket.
 */
function guardedLookup({ lookup, isAllowedAddress }) {
  return (hostname, options, callback) => {
    if (typeof options === "function") { callback = options; options = {}; }
    lookup(hostname, { ...options, all: true }, (err, addrs) => {
      if (err) return callback(err);
      const list = (Array.isArray(addrs) ? addrs : [addrs]).map((a) => (typeof a === "string" ? { address: a, family: isIP(a) } : a));
      const bad = list.find((a) => !isAllowedAddress(a.address));
      if (!list.length || bad) {
        return callback(fail("EBLOCKED", `${hostname} resolves to a non-public address (${bad ? bad.address : "none"})`));
      }
      if (options && options.all) return callback(null, list); // autoSelectFamily path
      callback(null, list[0].address, list[0].family);
    });
  };
}

/** Parse (against `base` for a redirect) and vet one hop's URL. Throws EBADURL / EBLOCKED. */
function checkHop(href, isAllowedAddress, base) {
  let url;
  try { url = new URL(href, base); } catch { throw fail("EBADURL", `not a valid URL: ${String(href).slice(0, 200)}`); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw fail("EBADURL", `unsupported URL scheme: ${url.protocol}`);
  if (url.username || url.password) throw fail("EBADURL", "URLs with credentials are refused");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw fail("EBADURL", "URL has no host");
  if (isIP(host) && !isAllowedAddress(host)) throw fail("EBLOCKED", `${host} is a non-public address`);
  return url;
}

/** Send one GET; resolves with the response (headers in, body unread). */
function requestOnce(url, { accept, lookup, signal }) {
  const mod = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(url, {
      method: "GET",
      headers: { "User-Agent": USER_AGENT, Accept: accept, "Accept-Encoding": "gzip, deflate, br" },
      lookup,
      agent: false,
      signal,
    });
    req.once("response", resolve);
    req.once("error", reject);
    req.end();
  });
}

function decoderFor(encoding) {
  const enc = String(encoding || "").trim().toLowerCase();
  if (!enc || enc === "identity") return null;
  if (enc === "gzip" || enc === "x-gzip") return zlib.createGunzip();
  if (enc === "deflate") return zlib.createInflate();
  if (enc === "br") return zlib.createBrotliDecompress();
  throw fail("EBADENCODING", `unsupported Content-Encoding: ${enc.slice(0, 100)}`);
}

/** Read the (decompressed) body, failing with ETOOBIG as soon as it passes maxBytes. */
async function readBody(res, { maxBytes, signal }) {
  const declared = Number(res.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) {
    res.destroy();
    throw fail("ETOOBIG", `declared Content-Length ${declared} exceeds ${maxBytes} bytes`);
  }
  let decoder;
  try { decoder = decoderFor(res.headers["content-encoding"]); } catch (err) { res.destroy(); throw err; }
  const chunks = [];
  let total = 0;
  const sink = async function (source) {
    for await (const chunk of source) {
      total += chunk.length;
      if (total > maxBytes) throw fail("ETOOBIG", `response body exceeds ${maxBytes} bytes`);
      chunks.push(chunk);
    }
  };
  await (decoder ? pipeline(res, decoder, sink, { signal }) : pipeline(res, sink, { signal }));
  return Buffer.concat(chunks);
}

function parseContentType(header) {
  const raw = String(header || "");
  const content_type = raw.split(";")[0].trim().toLowerCase();
  const m = raw.match(/;\s*charset\s*=\s*"?([^";\s]+)"?/i);
  return { content_type, charset: m ? m[1].toLowerCase() : null };
}

const GUARD_CODES = new Set(["EBADURL", "EBLOCKED", "EREDIRECTS", "ETOOBIG", "EBADENCODING"]);
const isAbort = (err) => err && (err.name === "AbortError" || err.name === "TimeoutError" || err.code === "ABORT_ERR");

/**
 * GET a URL through the SSRF guard. See the file header for the contract.
 * @returns {Promise<{final_url: string, http_status: number, content_type: string, charset: string|null, buffer: Buffer}>}
 */
export async function guardedRequest(url, opts = {}) {
  const {
    maxBytes = MAX_PAGE_BYTES,
    timeoutMs = FETCH_TIMEOUT_MS,
    accept = DEFAULT_ACCEPT,
    allowPrivate = false,
    lookup = dns.lookup,
  } = opts;
  const isAllowedAddress = allowPrivate ? () => true : (opts.isAllowedAddress || isPublicEgressIp);
  const signal = AbortSignal.timeout(timeoutMs); // ONE deadline for every hop and body read
  const connectLookup = guardedLookup({ lookup, isAllowedAddress });

  try {
    let current = checkHop(url, isAllowedAddress);
    for (let hop = 0; ; hop++) {
      const res = await requestOnce(current, { accept, lookup: connectLookup, signal });
      const status = res.statusCode;
      const location = res.headers.location;
      if (status >= 300 && status < 400 && location) {
        res.destroy(); // never read a redirect body
        if (hop >= MAX_REDIRECTS) throw fail("EREDIRECTS", `more than ${MAX_REDIRECTS} redirects`);
        current = checkHop(location, isAllowedAddress, current);
        continue;
      }
      const buffer = await readBody(res, { maxBytes, signal });
      return { final_url: current.href, http_status: status, ...parseContentType(res.headers["content-type"]), buffer };
    }
  } catch (err) {
    // A guard refusal wins over a deadline that fired after it; any other failure once the
    // deadline has passed (AbortError, TimeoutError, a socket torn down by the abort) is ETIMEDOUT.
    if (GUARD_CODES.has(err?.code)) throw err;
    if (isAbort(err) || signal.aborted) throw Object.assign(fail("ETIMEDOUT", `timed out after ${timeoutMs} ms`), { cause: err });
    throw err;
  }
}

export const EXTRACT_TIMEOUT_MS = 10000;
export const FETCHED_TEXT_MAX = 200000;
export const PREVIEW_CHARS = 1200;
export const REFETCH_AFTER_DAYS = 30;
export const FULL_TEXT_MARKER = "\n\n[crow: full page text]\n\n";

/**
 * Whether a stored fetched_text may be a cut copy of its page. fetchPage cuts at FETCHED_TEXT_MAX,
 * except when the cap lands inside the full-text marker: it then stores the readable text alone,
 * up to FULL_TEXT_MARKER.length chars short of the cap. Conservative: a page that happens to end
 * in that window reads as maybe-cut, so a quote not found there is "not checked", never a misquote.
 */
export function storedTextMaybeTruncated(text) {
  return String(text || "").length > FETCHED_TEXT_MAX - FULL_TEXT_MARKER.length;
}

/** Split stored fetched text back into the readable part and the full-body part. */
export function splitFetchedText(text) {
  const s = String(text || "");
  const i = s.indexOf(FULL_TEXT_MARKER);
  if (i < 0) return { readable: s, body: s };
  return { readable: s.slice(0, i), body: s.slice(i + FULL_TEXT_MARKER.length) };
}

const REASONS = {
  EBLOCKED: "the address is not public",
  ENOTFOUND: "could not resolve the host",
  EAI_AGAIN: "could not resolve the host",
  ETIMEDOUT: "timed out",
  ETOOBIG: "the page is over 5 MB",
  EREDIRECTS: "too many redirects",
  EBADURL: "only http and https URLs",
  EBADENCODING: "the page uses an unsupported compression",
  ECONNREFUSED: "the server refused the connection",
  Z_DATA_ERROR: "the page's compressed data is corrupt",
};
const reasonFor = (err) => REASONS[err?.code] || `the page could not be fetched (${err?.code || "unknown error"})`;

function decode(buffer, charset) {
  let dec;
  try { dec = new TextDecoder(charset || "utf-8", { fatal: false }); } catch { dec = new TextDecoder("utf-8", { fatal: false }); }
  return dec.decode(buffer);
}

const sha256hex = (s) => createHash("sha256").update(s).digest("hex");

/**
 * Fetch a page and extract citable text. Never throws.
 * @returns {Promise<object>} on failure { ok: false, fetch_status: "failed", reason, final_url,
 *   http_status }; on success { ok: true, fetch_status: "fetched" | "fetched_no_text", final_url,
 *   http_status, content_type, fetched_at, text, readable_text, truncated, sha256 }
 */
export async function fetchPage(url, opts = {}) {
  const { extractTimeoutMs = EXTRACT_TIMEOUT_MS, workerUrl, ...reqOpts } = opts;
  let res;
  try {
    res = await guardedRequest(url, reqOpts);
  } catch (err) {
    return { ok: false, fetch_status: "failed", reason: reasonFor(err), final_url: null, http_status: null };
  }
  const failed = (reason) => ({ ok: false, fetch_status: "failed", reason, final_url: res.final_url, http_status: res.http_status });
  if (res.http_status < 200 || res.http_status >= 300) return failed(`HTTP ${res.http_status}`);

  const base = { ok: true, final_url: res.final_url, http_status: res.http_status, content_type: res.content_type, fetched_at: new Date().toISOString() };
  const noText = () => ({ ...base, fetch_status: "fetched_no_text", text: null, readable_text: "", truncated: false, sha256: null });

  let readable;
  let body;
  if (res.content_type === "text/html" || res.content_type === "application/xhtml+xml") {
    const html = decode(res.buffer, res.charset);
    const out = await extractInWorker(html, res.final_url, { timeoutMs: extractTimeoutMs, ...(workerUrl ? { workerUrl } : {}) });
    if (out.error) return failed(out.error === "extract_timeout" ? "extraction timed out" : "extraction failed");
    ({ readable, body } = out);
    if (!readable && !body) return noText();
  } else if (res.content_type === "text/plain" || res.content_type === "text/markdown") {
    readable = body = decode(res.buffer, res.charset);
    if (!readable.trim()) return noText();
  } else {
    return noText();
  }

  let truncated = false;
  let text;
  if (body === readable) {
    text = readable;
  } else if (readable.length + FULL_TEXT_MARKER.length >= FETCHED_TEXT_MAX) {
    // The cap lands inside the readable text or the marker: keep only the readable text (a
    // partial marker would store a half-split copy), cut below if needed.
    text = readable;
    truncated = true;
  } else {
    text = readable + FULL_TEXT_MARKER + body;
  }
  if (text.length > FETCHED_TEXT_MAX) { text = text.slice(0, FETCHED_TEXT_MAX); truncated = true; }
  const readable_text = text.length >= readable.length ? readable : text; // readable may itself be cut
  return { ...base, fetch_status: "fetched", text, readable_text, truncated, sha256: sha256hex(text) };
}
