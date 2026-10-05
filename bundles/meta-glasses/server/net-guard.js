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
import { appImport } from "./app-root.js";

const { isPublicEgressIp } = await appImport("servers/shared/ip-classify.js");

export const ARTWORK_MAX_BYTES = 5 * 1024 * 1024;
export const ARTWORK_TIMEOUT_MS = 10_000;

/**
 * True for any address the gateway must not fetch for a device: anything that is not public
 * unicast, in any spelling (v4-mapped/compatible/NAT64/6to4/Teredo IPv6 included), and anything
 * unparseable, plus this host's own addresses and its on-link neighbours (isPublicEgressIp in
 * servers/shared/ip-classify.js).
 */
export function isPrivateAddress(address) {
  return !isPublicEgressIp(address);
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
