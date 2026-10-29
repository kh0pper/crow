/**
 * The one outbound path for requests to a model provider (roles phase 2b, N3):
 * key tests, pick probes and the door all go through `safeRequest`.
 *
 * What it guarantees:
 *   - One request, never a redirect: a 3xx comes back as is, and callers
 *     treat it as an error. Node's http client does not follow redirects, so
 *     nothing here has to undo that.
 *   - Every address the connection could use is checked at connect time, by
 *     a custom `lookup` that wraps the resolver. A name that resolves to a
 *     refused address is refused before any socket opens (no DNS-rebinding
 *     window between a check and the connect). Each request gets its own
 *     socket (`agent: false`), so a pooled socket opened by some other code
 *     path is never reused here.
 *   - An IP-literal host never reaches `lookup`, so it is checked up front by
 *     the same rule.
 *
 * The rule, by mode:
 *   - "cloud": the address must be public (`isPublicIp`), and neither this
 *     box's own address nor on one of its on-link networks.
 *   - "other" (a server the user typed, often on their LAN): only the
 *     unspecified address, link-local, cloud metadata, multicast, and this
 *     gateway's own port on a loopback or own address are refused.
 *
 * Error codes (on `err.code`): BAD_URL, FORBIDDEN_TARGET (a literal host),
 * UPSTREAM_ADDRESS_REFUSED (a resolved address), TIMEOUT, or the socket's own
 * code (ECONNREFUSED, ENOTFOUND, …). Error messages never carry headers, so a
 * key in a header cannot leak through them.
 */
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { classifyIp, isPublicIp, isOwnNetworkIp } from "../../shared/ip-classify.js";
import { getOwnAddresses } from "../../shared/locality.js";
import { isForbiddenTarget, canonicalTargetHost } from "./door-resolve.js";
import { gatewayPort } from "./door.js";

const fail = (code, message) => Object.assign(new Error(message), { code });

const OTHER_REFUSED_CLASSES = new Set(["unspecified", "linklocal", "multicast", "invalid"]);
const LOOPBACKISH = new Set(["loopback", "unspecified"]);

function bracketed(a) { return a.includes(":") ? `[${a}]` : a; }

/**
 * Every address bound on this box: loopback names plus EVERY interface,
 * docker/bridge ones included. `getOwnAddresses()` skips virtual interfaces
 * on purpose (they are not machine identity), but the gateway binds 0.0.0.0,
 * so it answers on a bridge address too. `table` is for tests.
 */
export function ownAddresses(table) {
  const own = new Set(getOwnAddresses());
  let t = table;
  if (!t) { try { t = networkInterfaces(); } catch { t = {}; } }
  for (const entries of Object.values(t || {})) {
    for (const e of entries || []) if (e?.address) own.add(String(e.address).replace(/%.*$/, ""));
  }
  return own;
}

/**
 * True when `address` (an IP literal) may not be dialled in `mode` on `port`.
 * `ownAddrs` and `gatewayPortValue` default to this box; tests pass them in.
 */
export function addressRefused(address, { mode = "cloud", port, gatewayPortValue = gatewayPort(), ownAddrs = ownAddresses() } = {}) {
  const a = String(address ?? "").replace(/^\[|\]$/g, "");
  const { cls, v4 } = classifyIp(a);
  const own = ownAddrs.has(a) || (v4 != null && ownAddrs.has(v4));
  if (mode === "cloud") return !isPublicIp(a) || own || isOwnNetworkIp(a);
  if (OTHER_REFUSED_CLASSES.has(cls)) return true;
  // Cloud metadata endpoints outside link-local (fd00:ec2::254, 100.100.100.200, …).
  if (isForbiddenTarget(`http://${bracketed(canonicalTargetHost(a))}/`)) return true;
  if (Number(port) === Number(gatewayPortValue) && (LOOPBACKISH.has(cls) || own)) return true;
  return false;
}

/**
 * A `lookup` for http.request: resolves with `lookupFn`, refuses the whole
 * answer when any address is refused, and answers in the form the caller
 * asked for (`all: true` → an array, as Node 24's autoSelectFamily asks;
 * otherwise one address and family), whichever form `lookupFn` used.
 */
export function guardedLookup({ mode = "cloud", lookupFn = dns.lookup, allowAddressFn = () => false, port, gatewayPortValue, ownAddrs } = {}) {
  return function lookup(hostname, options, callback) {
    if (typeof options === "function") { callback = options; options = {}; }
    const opts = typeof options === "number" ? { family: options } : (options || {});
    lookupFn(hostname, opts, (err, address, family) => {
      if (err) return callback(err);
      const list = Array.isArray(address)
        ? address.map((x) => ({ address: x.address, family: x.family ?? isIP(x.address) }))
        : [{ address, family: family ?? isIP(address) }];
      if (!list.length || list.some((x) => !x.address)) return callback(fail("ENOTFOUND", `no address for ${hostname}`));
      for (const x of list) {
        if (allowAddressFn(hostname, x.address)) continue;
        if (addressRefused(x.address, { mode, port, gatewayPortValue, ownAddrs })) {
          return callback(fail("UPSTREAM_ADDRESS_REFUSED", `${hostname} resolves to an address Crow will not contact`));
        }
      }
      if (opts.all) callback(null, list);
      else callback(null, list[0].address, list[0].family);
    });
  };
}

const isLocalhostName = (h) => h === "localhost" || h.endsWith(".localhost");

/**
 * The checks that need no DNS, shared by `safeRequest` and the key test:
 * `null` when the URL may go on to a lookup, else "BAD_URL" (not http(s), or
 * credentials in it) or "FORBIDDEN_TARGET" (metadata/link-local, or an IP
 * literal, or a `localhost` name, refused by `addressRefused`).
 */
export function preflightRefused(url, { mode = "cloud", gatewayPortValue, ownAddrs } = {}) {
  let u;
  try { u = url instanceof URL ? url : new URL(url); } catch { return "BAD_URL"; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "BAD_URL";
  if (u.username || u.password) return "BAD_URL";
  if (isForbiddenTarget(u.href)) return "FORBIDDEN_TARGET";
  const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  // A localhost name always means loopback (RFC 6761), so it is judged as one before any lookup.
  const literal = isIP(host) ? host : isLocalhostName(host) ? "127.0.0.1" : null;
  if (literal && addressRefused(literal, { mode, port, gatewayPortValue, ownAddrs })) return "FORBIDDEN_TARGET";
  return null;
}

/**
 * One request. Resolves `{status, headers, stream, deadline}` once the
 * response headers arrive; the caller reads (or destroys) `stream`.
 * `deadline` (epoch ms, start + timeoutMs) is the request's total budget:
 * `readJson` enforces it on the body, so a slow-drip body cannot outlast it.
 * `safeRequest` itself does not cut a body short, because the door streams.
 * `transport` is a test seam standing in for node:http / node:https.
 */
export function safeRequest(url, {
  method = "GET", headers = {}, body, mode = "cloud", timeoutMs = 8000,
  lookupFn = dns.lookup, allowAddressFn = () => false, transport,
} = {}) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const refused = preflightRefused(url, { mode });
    if (refused === "BAD_URL") return reject(fail("BAD_URL", "not an http(s) URL Crow can use"));
    if (refused) return reject(fail("FORBIDDEN_TARGET", "Crow will not contact that address"));
    const u = new URL(url);
    const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
    const host = u.hostname.replace(/^\[|\]$/g, "");
    const lib = transport || (u.protocol === "https:" ? https : http);
    // A string or Buffer body goes out with its length, never chunked (some
    // "Other" servers refuse a chunked POST).
    const sized = typeof body === "string" || Buffer.isBuffer(body);
    const hasLength = Object.keys(headers || {}).some((h) => h.toLowerCase() === "content-length");
    const sendHeaders = sized && !hasLength ? { ...headers, "content-length": Buffer.byteLength(body) } : headers;
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };
    const req = lib.request({
      protocol: u.protocol, hostname: host, port, method,
      path: u.pathname + u.search, headers: sendHeaders, agent: false,
      lookup: guardedLookup({ mode, lookupFn, allowAddressFn, port }),
    }, (res) => done(resolve, { status: res.statusCode, headers: res.headers, stream: res, deadline }));
    const timer = setTimeout(() => req.destroy(fail("TIMEOUT", `no answer in ${timeoutMs} ms`)), timeoutMs);
    req.setTimeout(timeoutMs, () => req.destroy(fail("TIMEOUT", `idle for ${timeoutMs} ms`)));
    req.on("error", (err) => done(reject, err));
    if (body != null) req.write(body);
    req.end();
  });
}

/**
 * Read a response body (a `safeRequest` result or a bare stream) as JSON, at
 * most `maxBytes`, finished by `deadline` (epoch ms; defaults to the
 * request's own deadline, or now + `timeoutMs` when given). Past the deadline
 * the stream is destroyed and the read rejects TIMEOUT.
 */
export function readJson(res, { maxBytes = 2_000_000, timeoutMs, deadline } = {}) {
  const stream = res?.stream || res;
  const until = deadline ?? (timeoutMs != null ? Date.now() + timeoutMs : res?.deadline);
  return new Promise((resolve, reject) => {
    let finished = false;
    let timer = null;
    const end = (fn, v, { destroy = false } = {}) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (destroy) stream.destroy?.();
      fn(v);
    };
    const declared = Number(res?.headers?.["content-length"]);
    if (Number.isFinite(declared) && declared > maxBytes) {
      return end(reject, fail("too_large", "response body too large"), { destroy: true });
    }
    if (until != null) {
      timer = setTimeout(() => end(reject, fail("TIMEOUT", "the answer did not finish in time"), { destroy: true }),
        Math.max(0, until - Date.now()));
    }
    const chunks = [];
    let size = 0;
    stream.on("data", (c) => {
      if (finished) return;
      size += c.length;
      if (size > maxBytes) return end(reject, fail("too_large", "response body too large"), { destroy: true });
      chunks.push(c);
    });
    stream.on("error", (err) => end(reject, err));
    stream.on("end", () => {
      let parsed;
      try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return end(reject, fail("bad_json", "response is not JSON")); }
      end(resolve, parsed);
    });
  });
}
