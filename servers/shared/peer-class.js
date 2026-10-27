/**
 * Who is this peer? One classifier for every network decision.
 *
 * It trusts the TCP socket peer, never `req.ip` (which Express rewrites from
 * X-Forwarded-For), so it works the same on an Express request and on a raw
 * WebSocket upgrade `IncomingMessage`. The result is memoised on the request.
 *
 *   via         when                                                         client
 *   local       loopback socket, no forwarding and no tailscale-* headers   the socket
 *   serve       loopback socket owned by a Serve uid (peer-uid.js), no      the XFF address
 *               Funnel header, exactly one XFF value in an overlay range,
 *               X-Forwarded-Host present (the shape tailscaled writes)
 *   funnel      loopback socket owned by a Serve uid, Funnel header,        the XFF address
 *               exactly one XFF value that is a PUBLIC address
 *   proxy       socket listed in CROW_TRUSTED_PROXIES                        rightmost undeclared XFF hop
 *   direct      any other non-loopback socket                                the socket
 *   unverified  any other loopback request (forged or undeclared-proxy      the socket
 *               headers, a Serve/Funnel shape from the wrong uid, a
 *               Funnel shape naming a non-public address)
 *
 * `tailnetLogin` (Tailscale-User-Login) is honoured ONLY for `serve`, and is
 * withheld when the Serve client is itself a declared proxy (a relay such as a
 * public front door chained into Serve cannot vouch for its visitors). Header
 * presence can still only take trust away: the Funnel header is refused by
 * rejectFunneledMiddleware and the gate whoever sent it.
 *
 * The uid check fails closed: an owner that cannot be verified (no
 * /proc/net/tcp, a read error, the row gone) leaves the request unverified.
 *
 * Residuals (also in docs/architecture/dashboard.md): a process running as
 * tailscaled's uid (root) can forge the Serve shape; so can one running as the
 * gateway's uid where the operator opted out (CROW_SERVE_PEER_UIDS=off, e.g. a
 * host without procfs) or listed the gateway's own uid (each warn-logged once);
 * and any local process can reach a port a declared proxy fronts.
 *
 * Node built-ins only. Bundles import it through the app root.
 */
import { isIP } from "node:net";
import { classifyIp, parseIPv6 } from "./ip-classify.js";
import { servePeerVerified, warnOnce } from "./peer-uid.js";

/** Tailscale's address ranges. P2 replaces this with the overlay provider's list. */
export const OVERLAY_RANGES = Object.freeze(["100.64.0.0/10", "fd7a:115c:a1e0::/48"]);

export function headerValues(h) {
  if (h == null) return [];
  return (Array.isArray(h) ? h : [h]).flatMap((v) => String(v).split(","));
}

/** One forwarding-header value -> the bare address it names, or null when it
 * names something that is not an address ("unknown", an obfuscated token). */
export function bareForwardedAddr(v) {
  let x = String(v || "").trim().replace(/^"|"$/g, "");
  if (!x) return "";
  const br = x.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (br) return br[1];
  const v4port = x.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  if (v4port) return v4port[1];
  if (/^[0-9a-f:.]+$/i.test(x) && (x.includes(".") || x.includes(":"))) return x;
  return null;
}

/** Every address a request's forwarding headers name (X-Forwarded-For,
 * X-Real-IP, RFC 7239 Forwarded `for=`). `null` entries mark values that are
 * not addresses. Empty values are skipped. */
export function forwardedAddrs(headers = {}) {
  const out = [];
  for (const v of headerValues(headers["x-forwarded-for"])) { const a = bareForwardedAddr(v); if (a !== "") out.push(a); }
  for (const v of headerValues(headers["x-real-ip"])) { const a = bareForwardedAddr(v); if (a !== "") out.push(a); }
  for (const el of headerValues(headers["forwarded"])) {
    for (const pair of el.split(";")) {
      const m = pair.trim().match(/^for=(.*)$/i);
      if (m) { const a = bareForwardedAddr(m[1]); if (a !== "") out.push(a); }
    }
  }
  return out;
}

/** A v4-mapped IPv6 spelling becomes its IPv4; brackets and whitespace go. */
export function normalizeAddr(a) {
  const s = String(a ?? "").trim().replace(/^\[(.*)\]$/, "$1");
  if (isIP(s) === 6) {
    const c = classifyIp(s);
    if (c.via === "mapped" && c.v4) return c.v4;
  }
  return s;
}

export function isLoopbackAddr(a) {
  const n = normalizeAddr(a);
  return n === "localhost" || (isIP(n) !== 0 && classifyIp(n).cls === "loopback");
}

// ---- numeric ranges (IPv4 as 32-bit, IPv6 as 128-bit BigInt) --------------
function toNum(a) {
  const n = normalizeAddr(a);
  const fam = isIP(n);
  if (fam === 4) return { family: 4, n: BigInt(n.split(".").reduce((x, o) => x * 256 + Number(o), 0)) };
  if (fam === 6) {
    const g = parseIPv6(n);
    if (!g) return null;
    return { family: 6, n: g.reduce((acc, x) => (acc << 16n) | BigInt(x), 0n) };
  }
  return null;
}

function parseRange(entry) {
  const [addr, bitsRaw, extra] = String(entry).split("/");
  if (extra !== undefined) return null;
  if (isIP(String(addr).trim()) === 0) return null;
  const base = toNum(addr);
  if (!base) return null;
  const max = base.family === 4 ? 32 : 128;
  let bits = max;
  if (bitsRaw !== undefined) {
    if (!/^\d{1,3}$/.test(bitsRaw.trim())) return null;
    bits = Number(bitsRaw);
    if (bits > max) return null;
  }
  return { family: base.family, n: base.n, bits, max };
}

function inRange(a, r) {
  if (!a || a.family !== r.family) return false;
  const shift = BigInt(r.max - r.bits);
  return (a.n >> shift) === (r.n >> shift);
}

const OVERLAY = OVERLAY_RANGES.map(parseRange);

export function isOverlayAddr(a) {
  const n = toNum(a);
  return !!n && OVERLAY.some((r) => inRange(n, r));
}

/** A public unicast address: not loopback, RFC1918, overlay, link-local,
 * CGNAT, ULA, unspecified, multicast or documentation/reserved. */
export function isPublicAddr(a) {
  const n = normalizeAddr(a);
  return isIP(n) !== 0 && classifyIp(n).cls === "public" && !isOverlayAddr(n);
}

// ---- CROW_TRUSTED_PROXIES ----------------------------------------------------
// The keywords Express (proxy-addr) understands, so `trust proxy` and this
// classifier agree on every entry.
const KEYWORDS = {
  loopback: ["127.0.0.1/8", "::1/128"],
  linklocal: ["169.254.0.0/16", "fe80::/10"],
  uniquelocal: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"],
};

let proxyCache = { set: false, raw: undefined, list: [], ranges: [] };

function compileProxies(env) {
  const raw = env.CROW_TRUSTED_PROXIES;
  if (env === process.env && proxyCache.set && proxyCache.raw === raw) return proxyCache;
  const list = [];
  const ranges = [];
  for (const e of String(raw ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const kw = KEYWORDS[e.toLowerCase()];
    if (kw) { list.push(e.toLowerCase()); ranges.push(...kw.map(parseRange)); continue; }
    const r = parseRange(e);
    if (!r) { warnOnce(`proxy-entry:${e}`, `[net] WARN CROW_TRUSTED_PROXIES entry "${e}" is not an IP, CIDR or keyword (loopback, linklocal, uniquelocal): skipped`); continue; }
    list.push(e);
    ranges.push(r);
  }
  const out = { set: true, raw, list, ranges };
  if (env === process.env) proxyCache = out;
  return out;
}

/** The validated CROW_TRUSTED_PROXIES entries, for `app.set("trust proxy", …)`.
 * Default: an empty list, which means trust no one. */
export function trustedProxyList(env = process.env) {
  return [...compileProxies(env).list];
}

export function isTrustedProxy(a, env = process.env) {
  const n = toNum(a);
  return !!n && compileProxies(env).ranges.some((r) => inRange(n, r));
}

// ---- the classifier ---------------------------------------------------------
const FORWARDING = ["x-forwarded-for", "x-real-ip", "forwarded", "x-forwarded-host"];
const MEMO = Symbol.for("crow.peer-class");

const present = (v) => v != null && String(v).trim() !== "";

function undeclaredHint(addr) {
  warnOnce("undeclared-peer", `[net] WARN forwarding headers from undeclared peer ${addr}: they are not trusted for the client address (from loopback the request is refused; from another peer a public hop is refused). If this is your reverse proxy, set CROW_TRUSTED_PROXIES (see docs/getting-started/custom-domain.md)`);
}

/** Express proxy-addr semantics: walk X-Forwarded-For from the right while the
 * current address is a declared proxy. */
function proxyClient(sock, headers) {
  let client = sock;
  const xff = headerValues(headers["x-forwarded-for"]).map((v) => v.trim()).filter(Boolean);
  for (const v of xff.reverse()) {
    if (!isTrustedProxy(client)) break;
    const a = bareForwardedAddr(v);
    if (!a) break;
    client = normalizeAddr(a);
  }
  return client;
}

function loginOf(headers) {
  const v = headers["tailscale-user-login"];
  const s = String(Array.isArray(v) ? v[0] : v ?? "").trim().slice(0, 200);
  return s || null;
}

/** → { via, client, hops, socket, tailnetLogin, peerUid }. See the table above. */
export function classifyPeer(req) {
  if (req && req[MEMO]) return req[MEMO];
  const socket = req?.socket || req?.connection || null;
  const headers = req?.headers || {};
  const sock = normalizeAddr(socket?.remoteAddress || "");
  const hops = forwardedAddrs(headers).map((a) => (a === null ? null : normalizeAddr(a)));
  const out = { via: "unverified", client: sock, hops, socket: sock, tailnetLogin: null, peerUid: null };
  const hasFwd = FORWARDING.some((h) => present(headers[h]));
  const hasTs = Object.keys(headers).some((h) => h.toLowerCase().startsWith("tailscale-"));

  if (!sock) {
    // no peer address: stays unverified
  } else if (isTrustedProxy(sock)) {
    out.via = "proxy";
    out.client = proxyClient(sock, headers);
  } else if (!isLoopbackAddr(sock)) {
    out.via = "direct";
    if (hasFwd) undeclaredHint(sock);
  } else if (!hasFwd && !hasTs) {
    out.via = "local";
  } else {
    const xff = headerValues(headers["x-forwarded-for"]).map((v) => v.trim()).filter(Boolean);
    const one = xff.length === 1 ? bareForwardedAddr(xff[0]) : null;
    const single = one ? normalizeAddr(one) : null;
    const funnel = present(headers["tailscale-funnel-request"]);
    let shape = null;
    if (single && funnel && isPublicAddr(single)) shape = "funnel";
    else if (single && !funnel && isOverlayAddr(single) && present(headers["x-forwarded-host"])) shape = "serve";
    if (shape) {
      const v = servePeerVerified(socket);
      out.peerUid = v.uid;
      if (v.ok) {
        out.via = shape;
        out.client = single;
        if (shape === "serve" && !isTrustedProxy(single)) out.tailnetLogin = loginOf(headers);
      } else {
        warnOnce(`serve-uid:${v.uid}`, `[net] WARN Serve-shaped request from uid ${v.uid ?? "unknown"}, not a Serve uid (CROW_SERVE_PEER_UIDS=${process.env.CROW_SERVE_PEER_UIDS || "0"}): treated as unverified`);
      }
    } else if (hasFwd && !funnel) {
      undeclaredHint(sock);
    }
  }
  if (req && typeof req === "object") {
    try { Object.defineProperty(req, MEMO, { value: out, enumerable: false, configurable: true }); } catch {}
  }
  return out;
}

function own(req, key, value) {
  Object.defineProperty(req, key, { value, writable: true, configurable: true, enumerable: true });
}

/**
 * First network middleware: attaches `req.crowPeer`. For Serve and Funnel only,
 * shadows Express's `req.ip` / `req.ips` (and protocol/secure when Serve said
 * https) with the client tailscaled named, so every `req.ip` consumer (rate
 * limits, CrowdSec, the login lockout) sees what it saw before; every other
 * class keeps Express's getters, which honour only CROW_TRUSTED_PROXIES.
 */
export function resolveClientMiddleware() {
  return (req, _res, next) => {
    const p = classifyPeer(req);
    req.crowPeer = p;
    if (p.via === "serve" || p.via === "funnel") {
      own(req, "ip", p.client);
      own(req, "ips", [p.client]);
      if (String(req.headers["x-forwarded-proto"] || "").trim().toLowerCase() === "https") {
        own(req, "protocol", "https");
        own(req, "secure", true);
      }
    }
    next();
  };
}
