/**
 * The artwork proxy's outbound rule: a public address only, resolved ONCE and connected to as
 * resolved (a second lookup could answer differently: DNS rebinding), images only, size-capped,
 * no redirects. The configured music server is the one private origin allowed (its caller
 * passes allowPrivate for that exact origin).
 */
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";

export const ARTWORK_MAX_BYTES = 5 * 1024 * 1024;
export const ARTWORK_TIMEOUT_MS = 10_000;

function v4Private(a) {
  const p = a.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [x, y] = p;
  return x === 0 || x === 10 || x === 127 || (x === 169 && y === 254) || (x === 172 && y >= 16 && y <= 31)
    || (x === 192 && y === 168) || (x === 100 && y >= 64 && y <= 127) || x >= 224;
}

/** True for any address the gateway must not fetch for a device: unspecified, loopback, private, link-local, CGNAT, multicast, and IPv6 equivalents (including v4-mapped). */
export function isPrivateAddress(address) {
  const a = String(address || "").replace(/^\[|\]$/g, "").toLowerCase();
  const kind = isIP(a);
  if (kind === 4) return v4Private(a);
  if (kind !== 6) return true;
  const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return v4Private(mapped[1]);
  if (a === "::" || a === "::1") return true;
  const first = parseInt(a.split(":")[0] || "0", 16);
  return (first & 0xfe00) === 0xfc00     // fc00::/7 unique local
    || (first & 0xffc0) === 0xfe80       // fe80::/10 link-local
    || (first & 0xff00) === 0xff00;      // multicast
}

export class FetchRefused extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}

/**
 * Resolve `url`'s host once; refuse (FetchRefused "host_not_allowed", 403) when any answer is private
 * and allowPrivate is false; then GET it connected to that exact address. → { status, contentType, body: Buffer }.
 * Refuses redirects (502), non-image types (415), bodies over maxBytes (502).
 */
export async function fetchImagePinned(url, { headers = {}, allowPrivate = false, lookup = dnsLookup, maxBytes = ARTWORK_MAX_BYTES, timeoutMs = ARTWORK_TIMEOUT_MS, signal } = {}) {
  const u = new URL(url);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new FetchRefused("unsupported_scheme", 400);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  let addrs;
  try { addrs = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true }); }
  catch { throw new FetchRefused("dns_lookup_failed", 502); }
  if (!addrs.length) throw new FetchRefused("dns_lookup_failed", 502);
  if (!allowPrivate && addrs.some((x) => isPrivateAddress(x.address))) throw new FetchRefused("host_not_allowed", 403);
  const pinned = addrs[0];
  const mod = u.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.get(u, {
      headers,
      timeout: timeoutMs,
      signal,
      // Connect to the address checked above, never a fresh lookup.
      lookup: (_h, opts, cb) => (opts && opts.all ? cb(null, [{ address: pinned.address, family: pinned.family }]) : cb(null, pinned.address, pinned.family)),
    }, (res) => {
      const done = (err) => { res.resume(); reject(err); };
      if (res.statusCode >= 300 && res.statusCode < 400) return done(new FetchRefused("redirect_refused", 502));
      if (res.statusCode < 200 || res.statusCode >= 300) return done(new FetchRefused(`upstream_${res.statusCode}`, 502));
      const type = String(res.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
      if (!type.startsWith("image/")) return done(new FetchRefused("not_an_image", 415));
      const parts = [];
      let n = 0;
      res.on("data", (c) => { n += c.length; if (n > maxBytes) { req.destroy(); reject(new FetchRefused("too_large", 502)); } else parts.push(c); });
      res.on("end", () => { if (n <= maxBytes) resolve({ status: res.statusCode, contentType: type, body: Buffer.concat(parts) }); });
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new FetchRefused("timeout", 504)));
    req.on("error", (err) => reject(err instanceof FetchRefused ? err : new FetchRefused("upstream_error", 502)));
  });
}
