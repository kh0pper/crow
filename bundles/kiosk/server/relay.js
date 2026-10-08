/**
 * The stream relay. The page never gets an upstream URL: the gateway fetches the stream and pipes
 * the bytes to the display's ticket request. Because the gateway makes the request, every upstream
 * carries a HOP POLICY, checked on EVERY hop (the first request and each redirect):
 *
 *   hop = { origin,                      the only origin (scheme, host, port) the FIRST request may go to
 *           path?,                       RegExp | (pathname, search) => boolean: the first request's path shape
 *           redirects,                   how many redirects may be followed in all (0..MAX_REDIRECTS)
 *           redirectTo,                  "public": anywhere that passes the address rule; or a list of origins
 *           private }                    "none": every host must resolve to public addresses only
 *                                        "named": only with a redirectTo LIST — every hop is then at an origin
 *                                        the operator configured, and those hosts may be private
 *
 * Three policies exist (publicHop, localHop, serviceHop below). A station is publicHop unless the
 * operator ticked it as a home-network stream (localHop, spec §13.4). Only an operator-configured
 * service may be private at configured origins. Rules that hold for all:
 *   - Every URL (the first, and each redirect target) goes through the WHATWG URL parser, which
 *     writes an IPv4 host given in decimal, octal or hex in dotted form; a host is never judged from
 *     a raw string. http and https only; no user name or password in the URL; no empty host and no
 *     trailing-dot host.
 *   - Addresses are classified by the shared classifier (servers/shared/ip-classify.js) and judged
 *     against this host's own network (netscope.js): an address of this host, or inside the on-link
 *     prefix of any of its interfaces (its LAN, its LAN's global IPv6 /64, container bridges), is never
 *     public — on EVERY hop of every policy (only a service's configured origins are exempt).
 *   - A redirect is followed by hand, one hop at a time, and checked like the first request.
 *   - A name is resolved ONCE per hop; EVERY address it resolves to is checked, and the connection is
 *     made to the address that was checked (the request's own lookup returns it), so a name that
 *     answers differently a moment later changes nothing.
 *   - A credential (upstream.headers.Authorization) goes to the first hop ONLY: it is dropped on any
 *     redirect, and a redirect from https to http on a policy that carried one is refused.
 *   - What is sent upstream and what is passed to the page are allowlists. Only GET. Only audio.
 *   - Bounded: redirects, 10 s to the final response headers, 30 s without a byte moving.
 * Nothing about the upstream (its URL, address or error text) is ever written to the page.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, BlockList } from "node:net";
import { createReadStream, realpathSync, statSync } from "node:fs";
import { sep } from "node:path";

export const MAX_REDIRECTS = 3;
export const HEADERS_TIMEOUT_MS = 10_000;
export const BODY_IDLE_MS = 30_000;
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const PASS_HEADERS = ["content-length", "content-range", "accept-ranges"];
/** One byte range, as a media element sends it. Read from a header value already cut to 64 characters. */
const RANGE = /^bytes=\d{0,15}-\d{0,15}$/;

export class RelayError extends Error {
  constructor(code, message) { super(message || code); this.name = "RelayError"; this.code = code; }
}

// ── addresses (one classifier: the shared one; this host's view from netscope.js) ─────────────────
import { classifyIp, normAddress, isNotPublicAddress, isLocalStreamClass, readHostNetwork, judgeAddress } from "./netscope.js";
export { readHostNetwork, judgeAddress, normAddress };
const DOCUMENTATION = new BlockList();
for (const [n, b] of [["192.0.2.0", 24], ["198.51.100.0", 24], ["203.0.113.0", 24]]) DOCUMENTATION.addSubnet(n, b, "ipv4");
for (const [n, b] of [["2001:db8::", 32], ["3fff::", 20]]) DOCUMENTATION.addSubnet(n, b, "ipv6");

/**
 * → (address) => true when the address is NOT public (netscope.isNotPublicAddress: the shared classifier,
 * with translated/tunnelled IPv4 forms refused). documentation: false treats the documentation ranges as
 * public; it exists for tests, whose "public" stand-ins come from those ranges.
 */
export function addressClassifier({ documentation = true } = {}) {
  return function isNotPublic(address) {
    if (typeof address !== "string" || address.includes("%")) return true;     // a zone id is a local address by definition
    const a = normAddress(address);
    if (!documentation) { try { if (isIP(a) && DOCUMENTATION.check(a, isIP(a) === 6 ? "ipv6" : "ipv4")) return false; } catch { /* not an address */ } }
    return isNotPublicAddress(a);
  };
}
/** The rule the gateway runs with. */
export const isPrivateAddress = addressClassifier();
/** Could a ticked home-network station ever have this address (its class only; where it is, is judged per hop)? */
export const isLocalStreamAddress = isLocalStreamClass;
/** This host's own addresses (from its interfaces). */
export const hostAddresses = () => readHostNetwork().own;

// ── hop policies ─────────────────────────────────────────────────────────────────────────────────
const bareHost = (u) => { const h = u.hostname.toLowerCase(); return h.startsWith("[") ? h.slice(1, -1) : h; };
/** Why this (parsed) URL may not be fetched whatever the policy says, or null. */
function urlProblem(u) {
  if (u.protocol !== "http:" && u.protocol !== "https:") return "bad_scheme";
  if (u.username || u.password) return "userinfo_refused";
  const host = bareHost(u);
  if (!host || host.endsWith(".")) return "bad_host";
  return null;
}
const parse = (v) => { try { return new URL(String(v)); } catch { return null; } };
const originOf = (v) => { const u = parse(v); return u && !urlProblem(u) ? u.origin : null; };

/** A station: every hop must be public. */
export const publicHop = (url) => ({ origin: originOf(url), redirects: MAX_REDIRECTS, redirectTo: "public", private: "none" });
/**
 * A station the operator ticked as a home-network stream (spec §13.4). The ENTERED host:port may
 * resolve to a home-network or tailnet address (isLocalStreamAddress), never to loopback, link-local,
 * multicast or the gateway's own addresses. A redirect may go to the SAME host:port (checked by the
 * same rule) or to a public address (public rules); never to another private host. No credential is
 * ever sent on this policy.
 */
export const localHop = (url, pinned = []) => ({ origin: originOf(url), redirects: MAX_REDIRECTS, redirectTo: "public", private: "local", pinned: (Array.isArray(pinned) ? pinned : []).map(normAddress).filter((a) => isIP(a)).slice(0, 16) });
/**
 * An operator-configured service (a library server): the first request goes only to its origin and a
 * known path shape; a redirect is allowed only to a configured storage origin, once. Those origins are
 * the only places this policy can reach, so they may be private. With no storage origin there is no
 * redirect at all.
 */
export const serviceHop = ({ origin, path, storage = [] }) => ({ origin: originOf(origin), path, redirects: storage.length ? 1 : 0, redirectTo: storage.map(originOf).filter(Boolean), private: "named" });

function readPolicy(hop) {
  const origin = hop && typeof hop === "object" ? originOf(hop.origin) : null;
  if (!origin) throw new RelayError("bad_policy");
  const list = Array.isArray(hop.redirectTo) ? hop.redirectTo.map(originOf).filter(Boolean) : null;
  if (!list && hop.redirectTo !== "public") throw new RelayError("bad_policy");
  const path = hop.path instanceof RegExp || typeof hop.path === "function" ? hop.path : null;
  if (hop.path != null && !path) throw new RelayError("bad_policy");
  if (hop.private !== "none" && hop.private !== "named" && hop.private !== "local") throw new RelayError("bad_policy");
  // A local stream never combines with a list of origins (it reaches its own host:port and public addresses only).
  if (hop.private === "local" && list) throw new RelayError("bad_policy");
  // Private addresses only where every hop is pinned to a configured origin: never together with "anywhere public".
  if (hop.private === "named" && !list) throw new RelayError("bad_policy");
  const named = hop.private === "named" ? new Set([origin, ...list].map((o) => bareHost(new URL(o)))) : new Set();
  const o = new URL(origin);
  // A local station's addresses were recorded when the operator saved it: a play must resolve to a subset of them.
  const local = hop.private === "local" ? { host: bareHost(o), port: o.port || (o.protocol === "https:" ? "443" : "80"), pinned: new Set((Array.isArray(hop.pinned) ? hop.pinned : []).map(normAddress)) } : null;
  return { origin, path, redirects: Number.isInteger(hop.redirects) ? Math.max(0, Math.min(MAX_REDIRECTS, hop.redirects)) : 0, redirectTo: list || "public", named, local };
}
function checkHop(u, p, hop) {
  const bad = urlProblem(u);
  if (bad) throw new RelayError(bad);
  if (hop === 0) {
    if (u.origin !== p.origin) throw new RelayError("origin_refused");
    if (p.path && !(typeof p.path === "function" ? p.path(u.pathname, u.search) === true : p.path.test(u.pathname + u.search))) throw new RelayError("path_refused");
  } else if (p.redirectTo !== "public" && !p.redirectTo.includes(u.origin)) throw new RelayError("redirect_refused");
}

/** Resolve once, check every address, and return the one the connection will be made to. */
async function pinAddress(u, p, lookup, signal, isPrivate, network) {
  const host = bareHost(u);
  const literal = isIP(host);
  let addrs;
  if (literal) addrs = [{ address: host, family: literal }];
  else {
    try { addrs = await untilAborted(Promise.resolve().then(() => lookup(host, { all: true })), signal); }
    catch (err) { throw err instanceof RelayError ? err : new RelayError("unresolvable"); }
  }
  addrs = (Array.isArray(addrs) ? addrs : [addrs]).filter((a) => a && typeof a.address === "string");
  if (!addrs.length) throw new RelayError("unresolvable");
  // A service's configured origins (the operator's library and its storage) are exempt: they are the only places that policy reaches.
  if (p.named.has(host)) return { address: addrs[0].address, family: isIP(addrs[0].address) || 4 };
  // A local station's own host:port (the first request, or a redirect back to exactly it) is judged by the
  // home-network rule and must resolve inside the address set recorded at Save; every other hop by the
  // public rule. On every hop: never this host, never inside one of its interfaces' prefixes.
  const port = u.port || (u.protocol === "https:" ? "443" : "80");
  const localHere = !!p.local && host === p.local.host && port === p.local.port;
  const net = network();
  for (const a of addrs) {
    if (localHere && !p.local.pinned.has(normAddress(a.address))) throw new RelayError("address_changed");
    const why = judgeAddress(a.address, net, { local: localHere, isNotPublic: isPrivate });
    if (why) throw new RelayError(why);
  }
  return { address: addrs[0].address, family: isIP(addrs[0].address) || 4 };
}
function untilAborted(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const stop = () => reject(new RelayError("aborted"));
    if (signal.aborted) return stop();
    signal.addEventListener("abort", stop, { once: true });
    promise.then((v) => { signal.removeEventListener("abort", stop); resolve(v); }, (e) => { signal.removeEventListener("abort", stop); reject(e); });
  });
}

/** One GET to the pinned address. Resolves with the response once its headers are in. */
function send(u, pinned, headers, { signal, connect }) {
  return new Promise((resolve, reject) => {
    const host = bareHost(u);
    const secure = u.protocol === "https:";
    const port = Number(u.port) || (secure ? 443 : 80);
    const options = {
      method: "GET", host, port, path: u.pathname + u.search, headers, signal,
      // The address that was checked is the address that is dialled: the name is not resolved again.
      lookup: (h, o, cb) => { const done = typeof o === "function" ? o : cb; if (o && typeof o === "object" && o.all) done(null, [pinned]); else done(null, pinned.address, pinned.family); },
      ...(secure && !isIP(host) ? { servername: host } : {}),
      // `connect` exists for tests only (a made-up public name has to reach a local test server). It
      // replaces the socket, never a check: the policy and the address rule have already passed.
      ...(connect ? { createConnection: () => connect({ address: pinned.address, family: pinned.family, port, host, secure }) } : { agent: false }),
    };
    const req = (secure ? httpsRequest : httpRequest)(options);
    req.once("response", (res) => resolve(res));
    req.on("error", (err) => reject(err));          // stays attached: a late socket error must never be unhandled
    req.end();
  });
}

/**
 * lookup(host, { all: true }) → [{ address, family }] (default: the system resolver).
 * connect and isPrivate: tests only (see send and addressClassifier). The gateway builds its relay
 * with no options at all.
 */
export function createRelay({ lookup = dnsLookup, connect = null, isPrivate = isPrivateAddress, network = readHostNetwork, headersTimeoutMs = HEADERS_TIMEOUT_MS, bodyIdleMs = BODY_IDLE_MS } = {}) {
  /**
   * upstream = { url, headers?: { Authorization }, hop }. → { status, headers, body (a readable), hops }.
   * Throws RelayError; the caller owns `body` and must destroy it.
   */
  async function open(upstream, { range, signal } = {}) {
    const policy = readPolicy(upstream?.hop);
    let url = parse(upstream.url);
    if (!url) throw new RelayError("bad_url");
    const auth = typeof upstream.headers?.Authorization === "string" ? upstream.headers.Authorization : typeof upstream.headers?.authorization === "string" ? upstream.headers.authorization : null;
    // A local stream never carries a credential, whatever the caller passed.
    const hadCredential = !!auth && !policy.local;
    let credential = hadCredential ? { Authorization: auth } : null;
    // One deadline for the whole way to the final response headers, redirects included.
    const ctl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, headersTimeoutMs);
    const outer = () => ctl.abort();
    if (signal) { if (signal.aborted) ctl.abort(); else signal.addEventListener("abort", outer, { once: true }); }
    try {
      for (let hop = 0; ; hop += 1) {
        checkHop(url, policy, hop);
        const pinned = await pinAddress(url, policy, lookup, ctl.signal, isPrivate, network);
        const headers = { Accept: "*/*", "Accept-Encoding": "identity", "User-Agent": "crow-kiosk-relay", ...(range ? { Range: range } : {}), ...(credential || {}) };
        let res;
        try { res = await send(url, pinned, headers, { signal: ctl.signal, connect }); }
        catch (err) { throw new RelayError(timedOut ? "headers_timeout" : ctl.signal.aborted ? "aborted" : "unreachable", err?.code || undefined); }
        if (!REDIRECT_CODES.has(res.statusCode)) {
          clearTimeout(timer);
          return { status: res.statusCode, headers: res.headers, body: res, hops: hop };
        }
        const location = res.headers.location;
        res.destroy();
        if (hop >= policy.redirects) throw new RelayError("too_many_redirects");
        if (!location) throw new RelayError("bad_redirect");
        let next;
        try { next = new URL(String(location), url); } catch { throw new RelayError("bad_redirect"); }
        // A policy that carried a credential never steps down from https, and the credential never travels past the first hop.
        if (hadCredential && url.protocol === "https:" && next.protocol === "http:") throw new RelayError("downgrade_refused");
        // A local station never steps down from https either (a same host:port redirect may only upgrade).
        if (policy.local && url.protocol === "https:" && next.protocol === "http:") throw new RelayError("downgrade_refused");
        credential = null;
        url = next;
      }
    } catch (err) {
      clearTimeout(timer);
      ctl.abort();
      if (timedOut) throw new RelayError("headers_timeout");
      throw err instanceof RelayError ? err : new RelayError("unreachable");
    } finally {
      // After the headers are in, the caller's signal ends the body (see toResponse); the deadline no longer does.
      if (signal) signal.removeEventListener("abort", outer);
    }
  }

  const audioType = (type) => { const t = String(type || "").split(";")[0].trim().toLowerCase(); return (t.startsWith("audio/") && !t.includes("mpegurl")) || t === "application/ogg" ? t : null; };
  function refuse(res, code, text) {
    if (res.headersSent) { res.destroy(); return; }
    res.statusCode = code;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(text);
  }

  /**
   * A stored file (upstream = { file, root }): served only when its REAL path (links followed) is
   * still inside the real `root`, it is a regular .mp3, and only as audio/mpeg — checked again at
   * every request, so a file swapped for a link after the ticket was made is not followed out.
   * One byte range per request. → the same codes as toResponse.
   */
  function fileResponse(upstream, req, res, signal) {
    let real = null, size = 0;
    try {
      const root = realpathSync(String(upstream.root)) + sep;
      real = realpathSync(String(upstream.file));
      const st = statSync(real);
      if (!real.startsWith(root) || !real.toLowerCase().endsWith(".mp3") || !st.isFile()) real = null;
      else size = st.size;
    } catch { real = null; }
    if (!real) { refuse(res, 404, "Not found"); return "file_refused"; }
    const asked = typeof req.headers?.range === "string" ? req.headers.range.slice(0, 64) : "";
    let start = 0, end = size - 1, partial = false;
    if (RANGE.test(asked)) {
      const [a, b] = asked.slice(6).split("-");
      if (a === "" && b !== "") { start = Math.max(0, size - Number(b)); }
      else { start = Number(a || 0); if (b !== "") end = Math.min(end, Number(b)); }
      if (!(start <= end && start < size)) { res.setHeader("Content-Range", `bytes */${size}`); refuse(res, 416, "Range not satisfiable"); return "range"; }
      partial = true;
    }
    res.statusCode = partial ? 206 : 200;
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Length", String(end - start + 1));
    if (partial) res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
    const body = createReadStream(real, { start, end });
    const stop = () => body.destroy();
    res.on("close", stop);
    if (signal) { if (signal.aborted) stop(); else signal.addEventListener("abort", () => { stop(); if (!res.writableEnded) res.destroy(); }, { once: true }); }
    body.on("error", () => { if (!res.writableEnded) res.destroy(); });
    body.pipe(res);
    return "ok";
  }

  /**
   * Pipe one upstream to one page request. → the code of what happened ("ok" once the stream is flowing;
   * otherwise why not), for the caller's log. Never throws.
   */
  async function toResponse(upstream, req, res, { signal } = {}) {
    if (req.method !== "GET") { res.setHeader("Allow", "GET"); refuse(res, 405, "Method not allowed"); return "method"; }
    if (upstream && typeof upstream.file === "string") return typeof upstream.root === "string" ? fileResponse(upstream, req, res, signal) : (refuse(res, 404, "Not found"), "file_refused");
    const asked = typeof req.headers?.range === "string" ? req.headers.range.slice(0, 64) : "";
    const ctl = new AbortController();
    const stop = () => ctl.abort();
    res.on("close", stop);
    if (signal) { if (signal.aborted) stop(); else signal.addEventListener("abort", stop, { once: true }); }
    let up;
    try { up = await open(upstream, { range: RANGE.test(asked) ? asked : undefined, signal: ctl.signal }); }
    catch (err) { refuse(res, 502, "Upstream unavailable"); return err?.code || "unreachable"; }
    const body = up.body;
    const end = () => { body.destroy(); if (!res.writableEnded) res.destroy(); };
    if (ctl.signal.aborted) { end(); return "aborted"; }
    ctl.signal.addEventListener("abort", end, { once: true });
    if (up.status !== 200 && up.status !== 206) { body.destroy(); refuse(res, 502, "Upstream unavailable"); return "upstream_status"; }
    const type = audioType(up.headers["content-type"]);
    if (!type) { body.destroy(); refuse(res, 415, "Not an audio stream"); return "not_audio"; }
    res.statusCode = up.status;
    res.setHeader("Content-Type", type);
    for (const h of PASS_HEADERS) { const v = up.headers[h]; if (typeof v === "string" && v.length <= 80) res.setHeader(h, v); }
    // A stream that stops moving (the upstream stalls, or the page stops reading) is let go.
    const idle = setTimeout(end, bodyIdleMs);
    idle.unref?.();
    body.on("data", () => idle.refresh());
    res.on("drain", () => idle.refresh());
    const done = () => clearTimeout(idle);
    body.on("error", () => { done(); if (!res.writableEnded) res.destroy(); });
    body.on("close", done);
    res.on("close", done);
    body.pipe(res);
    return "ok";
  }

  /**
   * Save/Test for a ticked station: resolve the entered host once and judge EVERY address by the
   * home-network rule (no request is made). → { ok: true, addrs } (the set a play must stay inside) |
   * { ok: false, error }.
   */
  async function checkLocal(url) {
    const u = parse(url);
    const bad = u ? urlProblem(u) : "bad_url";
    if (bad) return { ok: false, error: "bad_url" };
    const host = bareHost(u);
    let addrs;
    if (isIP(host)) addrs = [{ address: host }];
    else { try { addrs = await lookup(host, { all: true }); } catch { return { ok: false, error: "unreachable" }; } }
    addrs = (Array.isArray(addrs) ? addrs : [addrs]).filter((a) => a && typeof a.address === "string");
    if (!addrs.length) return { ok: false, error: "unreachable" };
    const net = network();
    for (const a of addrs) { const why = judgeAddress(a.address, net, { local: true, isNotPublic: isPrivate }); if (why) return { ok: false, error: why }; }
    return { ok: true, addrs: [...new Set(addrs.map((a) => normAddress(a.address)))].slice(0, 16) };
  }

  /** Does this upstream answer with audio? Reads the response headers only. → { ok, content_type? , error? } */
  async function probe(upstream) {
    let up;
    try { up = await open(upstream, {}); }
    catch (err) {
      const code = err?.code;
      if (["bad_scheme", "userinfo_refused", "bad_host", "bad_url", "bad_policy"].includes(code)) return { ok: false, error: "bad_url" };
      return { ok: false, error: ["private_address", "own_address", "address_changed", "redirect_refused", "too_many_redirects", "downgrade_refused"].includes(code) ? code : "unreachable" };
    }
    up.body.destroy();
    if (up.status !== 200 && up.status !== 206) return { ok: false, error: "unreachable" };
    const type = audioType(up.headers["content-type"]);
    if (type) return { ok: true, content_type: type };
    // A home-network target's other content types are not echoed: Test is not a way to look around the LAN.
    return upstream?.hop?.private === "local" ? { ok: false, error: "not_audio" } : { ok: false, error: "not_audio", content_type: String(up.headers["content-type"] || "").split(";")[0].trim().toLowerCase().slice(0, 60) };
  }

  return { open, toResponse, probe, checkLocal };
}
