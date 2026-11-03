/**
 * Egress relay for contained pi spawns (queue item 19, migration step 2c).
 *
 * A contained bot runs in a network namespace with only `lo` (bwrap
 * --unshare-net). Its one way out is a unix socket, bound into the sandbox,
 * whose other end is this relay in the SPAWNING process (gateway or bot
 * runner). Policy is enforced here, outside the sandbox; the in-sandbox
 * forwarder (pi_netns_entry.mjs) is a convenience a bot gains nothing by
 * killing or replacing.
 *
 * Each connection starts with one line:
 *   PORT <n>\n  speak HTTP to 127.0.0.1:<n> from this relay. Only the spawn's
 *               own gateway port, and there only the bot doors
 *               (servers/shared/bot-doors.js): every request on the
 *               connection, keep-alive included, is judged by one HTTP
 *               parser, upgrades and CONNECT are refused, and every upstream
 *               socket carries the relay mark (127.0.77.1), which the gateway
 *               refuses for /internal. Nothing else on loopback is reachable:
 *               other instances, unused model servers, a browser's DevTools
 *               port, adb.
 *   PROXY\n     an HTTP CONNECT request follows (the bot's HTTPS_PROXY). Only
 *               CONNECT, on ports from egressPorts (default 443), and the
 *               network is CLOSED (the operator's ruling): a destination is
 *               reachable only when EVERY address the name resolves to is
 *               global unicast, is not one of this host's own addresses and is
 *               not in the operator's deny list. Nothing on the LAN, the
 *               tailnet, loopback, cloud metadata or this host is reachable; a
 *               bot that needs a lab service gets a door for it. Every address
 *               is checked and the checked one connected (no DNS rebinding);
 *               IP literals the same; an `egress` list (exact or *.suffix)
 *               narrows further.
 *
 * Every decision is logged once per (decision, host:port) per spawn,
 * `[pi-egress] bot=<id> allow|deny <host>:<port> (<reason>)`. A per-spawn
 * connection cap bounds what one bot can open.
 */
import { createServer, connect as netConnect, isIP, BlockList } from "node:net";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { isDoorPath, RELAY_SOURCE_V4 } from "../../servers/shared/bot-doors.js";
import { spawnSync } from "node:child_process";
import { lookup as dnsLookup } from "node:dns/promises";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

// The closed network (the operator's ruling, spec §10): a CONNECT reaches a
// destination only when EVERY address its name resolves to is global unicast,
// is not one of this host's own addresses and is not in the operator's deny
// list. Every special-purpose range is refused, because each is a way around
// another control rather than a destination class: the LAN and the tailnet
// (100.64/10, fd7a:115c:a1e0::/48) are the operator's own network, loopback is
// governed by the PORT door allowlist, cloud metadata is credentials, and
// multicast/reserved/documentation ranges are not destinations a bot has any
// business reaching. A bot that needs a lab service gets a door for it.
// The own-host view is the kernel's LOCAL table only (readLocalTable): an
// interface list can omit an address on a link with no carrier.
// Networks this host is DIRECTLY attached to are refused too: every other
// machine on a LAN has a global address of its own, and nothing in that address
// says so. They come from the MAIN table (a row with a dst other than `default`
// and no gateway, e.g. `192.0.2.0/24 dev eth0 scope link`), and the /64 of every
// global IPv6 address this host owns is refused as well — even with no on-link
// row, whatever prefix the router announces.
// IPv4 embedded in IPv6 (v4-mapped, v4-compatible, SIIT, NAT64, 6to4, both
// Teredo fields, ISATAP) is unwrapped and judged as the IPv4 address; the
// discard prefix is refused. Zone ids are stripped (the CONNECT parser refuses
// '%' anyway).
// Not detectable from this host's tables, so an operator lists them in
// CROW_PI_EGRESS_DENY_NETS (spawner env, comma-separated CIDRs): Kubernetes
// service ranges, a network-specific NAT64 prefix, a router that hairpins the
// host's public address back to it.
/** [network, prefix length, reason] — every IPv4 range that is not global unicast. */
const SPECIAL_V4 = [
  // metadata and host plumbing first: 100.100.100.0/24 sits inside 100.64/10
  ["169.254.0.0", 16, "cloud metadata"], ["168.63.129.16", 32, "cloud metadata"], ["100.100.100.0", 24, "cloud metadata"],
  ["127.0.0.0", 8, "loopback"],
  ["0.0.0.0", 8, "not unicast"],
  ["10.0.0.0", 8, "private network"], ["172.16.0.0", 12, "private network"], ["192.168.0.0", 16, "private network"],
  ["100.64.0.0", 10, "tailnet/CGNAT"],
  ["192.0.0.0", 24, "reserved"], ["192.0.2.0", 24, "documentation range"],
  ["192.31.196.0", 24, "reserved"], ["192.52.193.0", 24, "reserved"], ["192.88.99.0", 24, "reserved"],
  ["192.175.48.0", 24, "reserved"], ["198.51.100.0", 24, "documentation range"], ["203.0.113.0", 24, "documentation range"],
  ["198.18.0.0", 15, "benchmarking range"],
  ["224.0.0.0", 4, "not unicast"], ["240.0.0.0", 4, "not unicast"],
].map(([net, plen, why]) => { const b = new BlockList(); b.addSubnet(net, plen, "ipv4"); return [b, why]; });

function expand6(a) {
  let s = String(a).toLowerCase().split("%")[0];
  const dot = s.lastIndexOf(".");
  if (dot > 0) {
    const lastColon = s.lastIndexOf(":");
    const q = s.slice(lastColon + 1).split(".").map(Number);
    s = s.slice(0, lastColon + 1) + ((q[0] << 8) | q[1]).toString(16) + ":" + ((q[2] << 8) | q[3]).toString(16);
  }
  const [head, tail] = s.includes("::") ? s.split("::") : [s, null];
  const h = head ? head.split(":") : [];
  const t = tail === null ? [] : (tail ? tail.split(":") : []);
  const fill = tail === null ? [] : Array(8 - h.length - t.length).fill("0");
  return [...h, ...fill, ...t].map((x) => parseInt(x || "0", 16));
}
const key6 = (a) => expand6(a).join(":");
const v4From = (hi, lo) => [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");

const IP_CANDIDATES = ["/usr/sbin/ip", "/sbin/ip", "/usr/bin/ip", "/bin/ip"];

/** `ip -j <args>`, parsed; throws when ip(8) is missing or the read fails. */
function ipJson(args) {
  const ip = IP_CANDIDATES.find((p) => existsSync(p));
  if (!ip) throw new Error("ip(8) not found");
  const r = spawnSync(ip, ["-j", ...args], { encoding: "utf8", timeout: 2000 });
  if (r.status !== 0) throw Object.assign(new Error("ip " + args.join(" ") + ": exit " + r.status), { stderr: String(r.stderr || "") });
  const v = JSON.parse(r.stdout || "null");
  if (!Array.isArray(v)) throw new Error("ip " + args.join(" ") + ": not a list");
  return v;
}

/** The dst of every local-table row: that table is about this host alone. */
function parseLocalRows(rows) {
  const out = [];
  for (const r of rows || []) {
    const dst = String((r && r.dst) || "").split("%")[0];
    if (dst && isIP(dst.split("/")[0])) out.push(dst);
  }
  return out;
}

/** /proc/net/fib_trie: a `|-- a.b.c.d` line followed by `/NN host LOCAL` (a /32 is an address, a shorter prefix a subnet this host owns). */
function parseFibTrie(text) {
  const out = [];
  let cand = null;
  for (const line of String(text || "").split("\n")) {
    const m = /^\s*\|--\s+(\d{1,3}(?:\.\d{1,3}){3})\s*$/.exec(line);
    if (m) { cand = m[1]; continue; }
    const p = /^\s*\/(\d{1,2})\s+host\s+LOCAL\b/.exec(line);
    if (p) {
      const plen = Number(p[1]);
      if (cand && plen <= 32) out.push(plen === 32 ? cand : cand + "/" + plen);
      cand = null;
      continue;
    }
    if (line.trim()) cand = null;
  }
  return out;
}

function hex6(h) {
  const s = String(h || "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(s)) return null;
  return s.match(/.{4}/g).map((x) => parseInt(x, 16));
}

/** RFC 5952 form: lowercase, no leading zeros, the longest (first) zero run as "::". */
function fmt6(h) {
  const g = h.map((x) => x.toString(16));
  let best = -1, bestLen = 1;
  for (let i = 0; i < 8;) {
    if (h[i] !== 0) { i++; continue; }
    let j = i;
    while (j < 8 && h[j] === 0) j++;
    if (j - i > bestLen) { best = i; bestLen = j - i; }
    i = j;
  }
  if (best < 0) return g.join(":");
  return g.slice(0, best).join(":") + "::" + g.slice(best + bestLen).join(":");
}

/** /proc/net/ipv6_route: rows whose flags carry RTF_LOCAL (0x80000000) are own addresses. */
function parseIpv6Route(text) {
  const out = [];
  for (const line of String(text || "").split("\n")) {
    const c = line.trim().split(/\s+/);
    if (c.length < 10) continue;
    if (!(parseInt(c[8], 16) & 0x80000000)) continue;
    const g = hex6(c[0]);
    const plen = parseInt(c[1], 16);
    if (!g || !(plen >= 0 && plen <= 128)) continue;
    const addr = fmt6(g);
    out.push(plen === 128 ? addr : addr + "/" + plen);
  }
  return out;
}

/** Route types that are not a link this host sits on. */
const NOT_A_LINK = new Set(["unreachable", "blackhole", "prohibit", "throw", "multicast"]);

/**
 * The dst of every MAIN-table row that is a network on a link this host sits
 * on: a dst other than `default` and no gateway between, e.g.
 * `192.0.2.0/24 dev eth0 scope link` or `2001:db8:10:20::/64 dev eth0 proto ra`.
 */
function parseOnLinkRows(rows) {
  const out = [];
  for (const r of rows || []) {
    const dst = String((r && r.dst) || "").split("%")[0];
    if (!dst || dst === "default") continue;
    if (r.gateway) continue; // a route THROUGH a router, not onto the link
    if (r.type && NOT_A_LINK.has(String(r.type))) continue;
    if (!isIP(dst.split("/")[0])) continue;
    out.push(dst);
  }
  return out;
}

/** An 8-digit little-endian hex IPv4 field (/proc/net/route), as four octets. */
function hex4le(h) {
  const s = String(h || "");
  if (!/^[0-9a-f]{8}$/i.test(s)) return null;
  return [6, 4, 2, 0].map((i) => parseInt(s.slice(i, i + 2), 16));
}

/**
 * /proc/net/route (the ip(8)-less fallback for the MAIN table): Destination and
 * Mask are little-endian hex, and a Gateway of 00000000 means the network is
 * on-link rather than behind a router.
 */
function parseProcRoute(text) {
  const out = [];
  for (const line of String(text || "").split("\n").slice(1)) {
    const c = line.trim().split(/\s+/);
    if (c.length < 8) continue;
    if (!/^0{8}$/.test(c[2])) continue;
    const d = hex4le(c[1]), m = hex4le(c[7]);
    if (!d || !m) continue;
    const plen = m.reduce((n, o) => n + (o.toString(2).split("1").length - 1), 0);
    if (plen < 1) continue; // the default route is not a network of its own
    out.push(d.map((o, i) => o & m[i]).join(".") + "/" + plen);
  }
  return out;
}

/**
 * /proc/net/ipv6_route (the ip(8)-less fallback for the MAIN table): a next hop
 * of all zeros with a prefix shorter than /128 is a network on a link. RTF_LOCAL
 * rows are own addresses, not networks.
 */
function parseIpv6OnLink(text) {
  const out = [];
  for (const line of String(text || "").split("\n")) {
    const c = line.trim().split(/\s+/);
    if (c.length < 10) continue;
    if (parseInt(c[8], 16) & 0x80000000) continue;
    const plen = parseInt(c[1], 16);
    if (!(plen > 0 && plen < 128)) continue;
    if (!/^0{32}$/.test(c[4].toLowerCase())) continue; // a next hop: via a router
    const g = hex6(c[0]);
    if (g) out.push(fmt6(g) + "/" + plen);
  }
  return out;
}

/** Did this read fail because the kernel has no IPv6 at all (not a failure)? */
function noV6Kernel(e) {
  const t = String((e && (e.stderr || e.message)) || "");
  return !!(e && (e.code === "ENOENT" || /address family not supported|EAFNOSUPPORT/i.test(t)));
}

/**
 * Is the /64 of this own IPv6 address a global-unicast network? The non-global
 * ranges are refused by their own reason anyway, and a neighbour on them should
 * keep that reason rather than gain a vaguer one.
 */
function global6(h) {
  if ((h[0] & 0xfe00) === 0xfc00) return false; // ULA
  if ((h[0] & 0xffc0) === 0xfe80) return false; // link-local
  if ((h[0] & 0xffc0) === 0xfec0) return false; // site-local
  if ((h[0] & 0xff00) === 0xff00) return false; // multicast
  if (h[0] === 0x100 && h.slice(1, 4).every((x) => x === 0)) return false; // discard-only
  if (h[0] === 0x2001 && (h[1] === 2 || h[1] === 0x0db8)) return false; // benchmarking / documentation
  if (h[0] === 0x3fff && (h[1] & 0xf000) === 0) return false; // documentation
  return true;
}

/**
 * This host's own addresses and prefixes, from the kernel's LOCAL table ONLY:
 * `ip -j [-6] route show table local`, falling back to /proc/net/fib_trie and
 * /proc/net/ipv6_route. The OS interface list is deliberately not a source: it
 * omits an address on an interface with no carrier (a bridge that comes up
 * later), which is the hole the S2c review named.
 *
 * The networks this host is directly attached to come from the MAIN table (see
 * parseOnLinkRows), because every other machine on one of them has a global
 * address that no range check would recognise.
 *
 * A family that cannot be read is REPORTED, never hidden: the caller refuses
 * that family's targets (every target when IPv4 fails). A kernel with no IPv6
 * (EAFNOSUPPORT, or no /proc/net/ipv6_route) is not a failure. o.run/o.readFile
 * are test seams.
 * @returns {{v4: string[], v6: string[], onLink4: string[], onLink6: string[], v4Failed: boolean, v6Failed: boolean, onLinkFailed: boolean}}
 */
export function readLocalTable(o = {}) {
  const run = o.run || ipJson;
  const readFile = o.readFile || ((p) => readFileSync(p, "utf8"));
  let noV6 = false;
  let v4 = null;
  try { v4 = parseLocalRows(run(["route", "show", "table", "local"])); } catch { v4 = null; }
  // An empty successful read is a parse that failed, not a host without
  // addresses: the LOCAL table always carries at least loopback.
  if (!v4 || !v4.length) {
    try { v4 = parseFibTrie(readFile("/proc/net/fib_trie")); } catch { v4 = null; }
  }
  const v4Failed = !v4 || !v4.length;
  if (v4Failed) v4 = [];
  let v6 = null, v6Failed = false;
  try { v6 = parseLocalRows(run(["-6", "route", "show", "table", "local"])); }
  catch (e) { v6 = null; noV6 = noV6Kernel(e); }
  if (!v6 || !v6.length) {
    try {
      v6 = parseIpv6Route(readFile("/proc/net/ipv6_route"));
      if (!v6.length) v6Failed = true;
    } catch (e) {
      v6 = [];
      // A kernel booted without IPv6 has no ipv6_route file at all.
      if (e && e.code === "ENOENT") noV6 = true;
      else v6Failed = true;
    }
  }
  // The networks on this host's links: the MAIN table, read the same two ways.
  const mainTable = (args, proc, fromRows, fromProc) => {
    let rows = null;
    try { rows = fromRows(run(args)); } catch { rows = null; }
    if (!rows) { try { rows = fromProc(readFile(proc)); } catch { rows = null; } }
    return Array.isArray(rows) ? rows : null;
  };
  const onLink4 = mainTable(["route", "show", "table", "main"], "/proc/net/route", parseOnLinkRows, parseProcRoute);
  const onLink6 = mainTable(["-6", "route", "show", "table", "main"], "/proc/net/ipv6_route", parseOnLinkRows, parseIpv6OnLink);
  const onLink4Failed = !onLink4, onLink6Failed = !onLink6;
  return {
    v4, v6,
    onLink4: onLink4 || [],
    onLink6: onLink6 || [],
    // A family whose on-link read failed fails closed like its own-host read: a
    // view that cannot list the networks this host sits on cannot be trusted to
    // let anything out. A kernel with no IPv6 has no on-link rows to miss.
    v4Failed: v4Failed || onLink4Failed,
    v6Failed: v6Failed || (onLink6Failed && !noV6),
    onLinkFailed: onLink4Failed || (onLink6Failed && !noV6),
  };
}

/** The local table is cached briefly (addresses come and go; a spawn makes many decisions). */
const LOCAL_TTL_MS = 5000;
let localCache = null; // { at, value }
let localTableReader = null; // test seam
/** Test seam: replace the kernel reader (null restores it). */
export function _setLocalTableReaderForTest(fn) { localTableReader = fn; }
/** Test seam: forget the cached read. */
export function _resetLocalTableCacheForTest() { localCache = null; }
function cachedLocalTable() {
  const now = Date.now();
  if (!localCache || now - localCache.at > LOCAL_TTL_MS) {
    let value = null;
    // A failure is cached AS a failure and is never remembered as a success.
    try { value = (localTableReader || readLocalTable)(); } catch { value = null; }
    if (!value || typeof value !== "object") value = { v4: [], v6: [], onLink4: [], onLink6: [], v4Failed: true, v6Failed: true, onLinkFailed: true };
    localCache = { at: now, value };
  }
  return localCache.value;
}

/**
 * This host's view: the addresses and prefixes the kernel's LOCAL table says
 * it owns (o.local, a readLocalTable result), plus o.hostAddrs (extra own
 * addresses, e.g. a router that hairpins the host's public address back to
 * it), plus the networks it sits on (the MAIN table's on-link rows, and the
 * /64 of every own global IPv6 address). There is no interface enumeration and
 * no bridge/VM name or kind logic: under the closed network every private range
 * is refused anyway, and the kernel table finds an address on an interface with
 * no carrier.
 */
function localView(o = {}) {
  const t = o.local || cachedLocalTable();
  const addrs = new Set();
  const own6 = []; // bare own IPv6 addresses, for the /64 rule below
  const nets4 = new BlockList(), nets6 = new BlockList();
  const onLink4 = new BlockList(), onLink6 = new BlockList();
  let failed = !!t.v4Failed, failed6 = !!t.v6Failed;
  const add = (x) => {
    const s = String(x || "").split("%")[0];
    const parts = s.split("/");
    if (parts.length > 2) { failed = failed6 = true; return; }
    const fam = isIP(parts[0]);
    // An entry the relay cannot read fails the view closed: a source that
    // emits garbage cannot be trusted to have listed every own address.
    if (!fam) { failed = failed6 = true; return; }
    const max = fam === 4 ? 32 : 128;
    const plen = parts.length === 2 ? (/^\d+$/.test(parts[1]) ? Number(parts[1]) : NaN) : max;
    if (!(plen <= max)) { failed = failed6 = true; return; }
    if (plen === max) {
      addrs.add(fam === 6 ? key6(parts[0]) : parts[0]);
      if (fam === 6) own6.push(parts[0]);
    } else { try { (fam === 4 ? nets4 : nets6).addSubnet(parts[0], plen, fam === 4 ? "ipv4" : "ipv6"); } catch { failed = failed6 = true; } }
  };
  for (const a of t.v4 || []) add(a);
  for (const a of t.v6 || []) add(a);
  for (const a of o.hostAddrs || []) add(a);
  // The networks this host is directly attached to. Every other machine on one
  // of them is a neighbour with an address of its own, and nothing in that
  // address says which link it sits on: refused as this host's network.
  const addNet = (x, fam) => {
    const s = String(x || "").split("%")[0];
    const parts = s.split("/");
    const max = fam === 4 ? 32 : 128;
    const plen = parts.length === 2 ? (/^\d+$/.test(parts[1]) ? Number(parts[1]) : NaN) : max;
    if (!isIP(parts[0]) || !(plen <= max)) { failed = failed6 = true; return; }
    try { (fam === 4 ? onLink4 : onLink6).addSubnet(parts[0], plen, fam === 4 ? "ipv4" : "ipv6"); }
    catch { failed = failed6 = true; }
  };
  for (const n of t.onLink4 || []) addNet(n, 4);
  for (const n of t.onLink6 || []) addNet(n, 6);
  // The /64 of every global IPv6 address this host owns, announced by a router
  // or not: a neighbour shares it, and only the local table knows about it.
  for (const a of own6) {
    const h = expand6(a);
    if (global6(h)) onLink6.addSubnet(fmt6([h[0], h[1], h[2], h[3], 0, 0, 0, 0]), 64, "ipv6");
  }
  // operator-listed networks that lead back into this host but are not
  // visible in its tables (Kubernetes ClusterIP ranges DNAT'd in nat
  // OUTPUT, a network-specific NAT64 prefix): refused like an own address.
  const deny4 = new BlockList(), deny6 = new BlockList();
  let denyBroken = false;
  for (const n of o.denyNets || []) {
    const parts = String(n).trim().split("/");
    if (parts.length > 2) { denyBroken = true; continue; }
    const [net, plen] = parts;
    const fam = isIP(net);
    const len = plen === undefined ? (fam === 4 ? 32 : 128) : (/^\d+$/.test(plen) ? Number(plen) : NaN);
    if (!fam || !(len <= (fam === 4 ? 32 : 128))) { denyBroken = true; continue; }
    try { (fam === 4 ? deny4 : deny6).addSubnet(net, len, fam === 4 ? "ipv4" : "ipv6"); } catch { denyBroken = true; continue; }
    // An entry written as IPv4-mapped IPv6 (::ffff:a.b.c.d/96+) also denies
    // the IPv4 network, so its other wrappings and the bare address are covered.
    if (fam === 6 && len >= 96) {
      const h = expand6(net);
      if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) {
        try { deny4.addSubnet(v4From(h[6], h[7]), len - 96, "ipv4"); } catch { denyBroken = true; }
      }
    }
  }
  return { addrs, nets4, nets6, onLink4, onLink6, failed, failed6, deny4, deny6, denyBroken };
}

function v4Reason(a, L) {
  // The operator deny list first, so every IPv4-in-IPv6 path gets it too.
  if (L.deny4 && L.deny4.check(a, "ipv4")) return "operator-denied network";
  if (L.addrs.has(a) || L.nets4.check(a, "ipv4")) return "this host";
  // A network this host is directly attached to, BEFORE the range list: a lab
  // numbered out of a documentation range is still the operator's LAN, and the
  // neighbour's address is only recognisable by the network it sits on.
  if (L.onLink4 && L.onLink4.check(a, "ipv4")) return "this host's network";
  for (const [net, why] of SPECIAL_V4) if (net.check(a, "ipv4")) return why;
  if (L.failed) return "own-host view unreadable";
  return null;
}

function v6Reason(a, L) {
  const h = expand6(a);
  const zero = (x, y) => h.slice(x, y).every((v) => v === 0);
  // Unspecified and loopback first: an embedded-IPv4 reading of ::1 would
  // otherwise say "not unicast" and hide the real reason.
  if (zero(0, 8)) return "not unicast";
  if (zero(0, 7) && h[7] === 1) return "loopback";
  // Cloud metadata and host plumbing: ULA endpoints, not peers.
  if ((h[0] === 0xfd00 && h[1] === 0x0ec2 && zero(2, 4)) || key6(a) === key6("fd20:ce::254") || key6(a) === key6("fd7a:115c:a1e0::53")) {
    return "cloud metadata";
  }
  // IPv4 inside IPv6: every prefix known to embed an IPv4 address is judged by
  // that address (and, when that is clean, still by the checks below: this host
  // may own a 6to4/Teredo/NAT64 address). Judged BEFORE the range checks so a
  // wrapper around an operator-denied address keeps that specific reason.
  let embedded = null;
  if (zero(0, 5) && (h[5] === 0xffff || h[5] === 0)) embedded = v4Reason(v4From(h[6], h[7]), L);       // ::ffff:a.b.c.d, ::a.b.c.d
  else if (zero(0, 4) && h[4] === 0xffff && h[5] === 0) embedded = v4Reason(v4From(h[6], h[7]), L);   // SIIT ::ffff:0:a.b.c.d
  else if (h[0] === 0x64 && h[1] === 0xff9b && zero(2, 6)) embedded = v4Reason(v4From(h[6], h[7]), L); // NAT64 64:ff9b::/96
  else if (h[0] === 0x64 && h[1] === 0xff9b && h[2] === 1) {
    // NAT64 local-use /48 (RFC 6052): the u octet (bits 64-71) must be zero;
    // then the IPv4 sits in bits 48-63 and 72-87. An unreadable layout is
    // refused rather than guessed at.
    if (h[4] >> 8) return "NAT64 local-use prefix (embedding unreadable)";
    embedded = v4Reason(v4From(h[3], ((h[4] & 0xff) << 8) | (h[5] >> 8)), L);
  }
  else if (h[0] === 0x2002) embedded = v4Reason(v4From(h[1], h[2]), L);                                // 6to4
  else if (h[0] === 0x2001 && h[1] === 0) {                                                            // Teredo: server, and client XOR ffff:ffff
    embedded = v4Reason(v4From(h[2], h[3]), L) || v4Reason(v4From(h[6] ^ 0xffff, h[7] ^ 0xffff), L);
  }
  else if ((h[4] === 0 || h[4] === 0x200) && h[5] === 0x5efe) embedded = v4Reason(v4From(h[6], h[7]), L);   // ISATAP ::0:5efe:a.b.c.d
  if (embedded) return embedded;
  // One of this host's own addresses, then a network this host is directly
  // attached to (a LAN neighbour's global address shares this host's /64). Both
  // are more specific than the ranges below, which cannot tell a neighbour from
  // any other host on the internet.
  if (L.addrs.has(key6(a)) || L.nets6.check(a, "ipv6")) return "this host";
  if (L.onLink6 && L.onLink6.check(a, "ipv6")) return "this host's network";
  // Address classes that say what the address IS, whatever link it is on.
  if ((h[0] & 0xfe00) === 0xfc00) return "private network";  // fc00::/7 ULA (the tailnet's fd7a:115c:a1e0::/48 is in it)
  if ((h[0] & 0xffc0) === 0xfe80) return "link-local";       // fe80::/10
  if ((h[0] & 0xffc0) === 0xfec0) return "site-local";       // fec0::/10 (deprecated)
  if ((h[0] & 0xff00) === 0xff00) return "not unicast";      // ff00::/8 multicast
  // Every remaining IPv6 range that is not global unicast.
  if (h[0] === 0x100 && zero(1, 4)) return "discard-only prefix";
  if (h[0] === 0x2001 && h[1] === 2) return "benchmarking range";            // 2001:2::/48
  if (h[0] === 0x2001 && h[1] === 0x0db8) return "documentation range";       // 2001:db8::/32
  if (h[0] === 0x3fff && (h[1] & 0xf000) === 0) return "documentation range"; // 3fff::/20
  if (L.failed || L.failed6) return "own-host view unreadable";
  return null;
}

/**
 * null when the relay may connect to `addr`, else the reason it may not. The
 * network is closed: only a global-unicast address that is not this host's own
 * and not in the operator's deny list passes. o.local is a readLocalTable
 * result (default: the cached kernel read); o.hostAddrs adds own addresses;
 * o.denyNets is the operator list.
 */
export function egressDenyReason(addr, o = {}) {
  const a = String(addr || "").replace(/^\[|\]$/g, "").split("%")[0];
  const fam = isIP(a);
  if (!fam) return "not an IP address";
  const L = o.view || localView(o);
  // The operator's deny list is a stated intent: an entry that cannot be read
  // refuses everything rather than silently not refusing what it meant.
  if (L.denyBroken) return "operator deny list (CROW_PI_EGRESS_DENY_NETS) has an unreadable entry: refusing all targets";
  if (fam === 6 && L.deny6 && L.deny6.check(a, "ipv6")) return "operator-denied network";
  return fam === 4 ? v4Reason(a, L) : v6Reason(a, L);
}

const norm = (h) => String(h || "").trim().toLowerCase().replace(/\.$/, "");
/** No list: any host. A list: exact names and "*.suffix" (not the bare suffix). */
export function hostAllowed(host, list) {
  if (!Array.isArray(list)) return true;
  const h = norm(host);
  return list.some((p) => {
    const q = norm(p);
    if (q.startsWith("*.")) return h.endsWith(q.slice(1)) && h.length > q.length - 1;
    return h === q;
  });
}

const MAX_HEAD = 16 * 1024;
const MAX_LOGGED = 1000;
const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/**
 * @param {object} o
 * @param {string} o.dir            fresh dir for the socket (created 0700, removed on close)
 * @param {string} o.botId
 * @param {number} o.gatewayPort    the one loopback port served, over the doors only
 * @param {boolean} [o.doorFilter=true]  test seam: false forwards without the door check
 * @param {string[]|null} o.egressAllow
 * @param {number[]} [o.egressPorts=[443]]
 * @param {object} [o.local]        readLocalTable result (test seam); default: the cached kernel LOCAL table
 * @param {string[]} [o.hostAddrs]  extra own addresses
 * @param {string[]} [o.denyNets]   operator-denied networks (default CROW_PI_EGRESS_DENY_NETS)
 * @param {number} [o.maxConns=64]
 * @param {number} [o.maxUpstream=maxConns]  requests in flight upstream, relay-wide
 * @param {number} [o.headTimeoutMs=10000]
 * @param {number} [o.idleMs=120000]  idle keep-alive timeout on a door connection
 * @param {Function} [o.lookup]     async (host) => [{address, family}]
 * @param {Function} [o.log]
 * @returns {Promise<{dir, socketPath, close: () => Promise<void>}>}
 */
export async function startEgressRelay(o) {
  const r = createEgressRelay(o);
  await r.ready;
  return r;
}

/**
 * Synchronous start (PiRpc spawns synchronously): the socket is bound by the
 * time pi can connect; `ready` settles when it is listening. A bind failure
 * leaves the bot with no network at all (fail closed) and is logged.
 */
export function createEgressRelay(o) {
  const dir = o.dir;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const socketPath = join(dir, "relay.sock");
  // The gateway port is the ONE loopback port a contained bot reaches, and
  // only over the doors below: nothing else on loopback is policy here.
  const gatewayPort = Number(o.gatewayPort) || 0;
  // Test seam: false still forwards through node:http and still sets the mark,
  // but skips the door check — the way to prove the gateway-side guard alone.
  const doorFilter = o.doorFilter !== false;
  // CONNECT is for TLS; plain http:// needs an absolute-form GET, which this
  // relay does not proxy. 443 by default.
  const ports = new Set((o.egressPorts || [443]).map(Number));
  const allow = Array.isArray(o.egressAllow) ? o.egressAllow : null;
  const log = o.log || ((l) => console.error(l));
  const local = { local: o.local, hostAddrs: o.hostAddrs,
    denyNets: o.denyNets || String(process.env.CROW_PI_EGRESS_DENY_NETS || "").split(",").map((x) => x.trim()).filter(Boolean) };
  if (local.denyNets.length && localView({ local: { v4: [], v6: [], v4Failed: false, v6Failed: false }, denyNets: local.denyNets }).denyBroken) {
    log(`[pi-egress] bot=${o.botId || "?"} CROW_PI_EGRESS_DENY_NETS has an unreadable entry: this relay refuses every target until it is fixed`);
  }
  // One line per relay when this host's own addresses cannot be read: from
  // then every target is refused, which the operator must see in the log.
  let ownHostViewLogged = false;
  const noteOwnHostView = (view) => {
    if (!view.failed || ownHostViewLogged) return;
    ownHostViewLogged = true;
    log(`[pi-egress] bot=${o.botId || "?"} own-host view unreadable: refusing every target`);
  };
  const maxConns = o.maxConns ?? 64;
  // Relay-wide cap on requests in flight upstream: one bot connection holds at
  // most one at a time (below), and every connection together no more than this.
  const maxUpstream = o.maxUpstream ?? maxConns;
  const headTimeoutMs = o.headTimeoutMs ?? 10000;
  const idleMs = o.idleMs ?? 120000;
  const lookup = o.lookup || ((h) => dnsLookup(h, { all: true, verbatim: true }));
  // One line per (decision, target), bounded: a bot that sprays distinct
  // hosts must not grow the spawner's memory (one summary line instead).
  const logged = new Set();
  let suppressed = 0;
  const note = (decision, target, reason) => {
    const key = decision + " " + target;
    if (logged.has(key)) return;
    if (logged.size >= MAX_LOGGED) {
      if (suppressed++ === 0) log(`[pi-egress] bot=${o.botId || "?"} more than ${MAX_LOGGED} distinct targets; further decisions are not logged`);
      return;
    }
    logged.add(key);
    log(`[pi-egress] bot=${o.botId || "?"} ${decision} ${target}${reason ? " (" + reason + ")" : ""}`);
  };
  let live = 0;
  let upstreamLive = 0;
  const sockets = new Set();

  /**
   * Splice client <-> upstream. Candidates are already-checked addresses,
   * tried in order (dual-stack hosts whose first address has no route). Ends
   * are propagated gracefully (half-close kept); each side is destroyed only
   * on error or once both directions are done.
   */
  const splice = (client, candidates, port, preface) => {
    let i = 0;
    let up = null;
    // The client's own listeners are registered ONCE, outside the retry loop:
    // a second attempt must not stack another pair on the same socket.
    const dropUp = () => { try { if (up && !up.destroyed) up.destroy(); } catch {} };
    client.on("error", dropUp);
    client.once("close", () => {
      if (up && !up.destroyed) up.end();
      const t = setTimeout(dropUp, 30000);
      if (t.unref) t.unref();
    });
    const tryNext = () => {
      if (client.destroyed) return;
      const addr = candidates[i++];
      const target = o._connectOverride ? o._connectOverride(addr, port) : { host: addr, port, allowHalfOpen: true };
      up = netConnect({ ...target, allowHalfOpen: true });
      const mine = up;
      sockets.add(mine);
      mine.once("close", () => sockets.delete(mine));
      let connected = false;
      mine.once("connect", () => {
        connected = true;
        if (client.destroyed) { mine.destroy(); return; }
        if (preface) client.write(preface);
        client.pipe(mine); mine.pipe(client);
      });
      mine.on("error", () => {
        if (!connected && i < candidates.length && !client.destroyed) { mine.destroy(); tryNext(); return; }
        if (!connected && preface) { try { client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"); } catch {} }
        else { try { client.destroy(); } catch {} }
        mine.destroy();
      });
      mine.once("close", () => { if (connected && !client.destroyed) { client.end(); setTimeout(() => client.destroy(), 30000).unref(); } });
    };
    tryNext();
  };

  const refuse = (c, status, text) => { try { c.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`); } catch {} };

  // ---- the doors (containment PR 6) ---------------------------------------
  // The gateway port is no longer spliced. One node:http parser terminates the
  // bot's connection, so EVERY request on it is judged (a spliced connection
  // carried a second request past any one-shot check), upgrades never reach
  // the gateway, and each upstream socket is opened from RELAY_SOURCE_V4 — the
  // mark the gateway refuses for /internal (middleware/internal-guard.js) and
  // the #614 caller check refuses outright. This process runs outside the
  // sandbox, so a bot cannot choose its own source address.
  // A client that sends its request and then FIN must still get the reply (a
  // hand-rolled bot HTTP client may half-close). Node reads this off the
  // server, not from createServer() options.
  const doors = createHttpServer({ requestTimeout: 0, headersTimeout: 60000 });
  doors.httpAllowHalfOpen = true;
  // One connection may hold 1000 requests; beyond that the parser stops
  // (a cheap bound on a bot that never stops asking on one socket).
  doors.maxRequestsPerSocket = 1000;
  // What the relay advertises (Keep-Alive: timeout=) is what it enforces.
  doors.keepAliveTimeout = idleMs;
  // Per-connection pipeline bound: one request in flight, this many waiting.
  const MAX_QUEUED = 8;
  // Methods with no body: nothing here can frame one for the gateway's wire.
  const BODILESS = new Set(["GET", "HEAD", "DELETE", "OPTIONS", "TRACE"]);
  // Hop-by-hop headers belong to the relay's own hop: passing them through
  // would let a body be framed twice (transfer-encoding) or a connection be
  // kept alive in a way the parser here has no say over.
  const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-connection", "proxy-authenticate",
    "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
  // Headers that tell the gateway who a request came from (a proxy hop, a
  // Tailscale Serve login, a client address). The relay is the only hop a
  // contained bot has, so a bot never gets to speak for one: classifyPeer
  // would otherwise read a forged Serve shape (X-Forwarded-For + -Host) and a
  // Tailscale-User-Login off a door request.
  const IDENTITY = /^(?:forwarded|x-forwarded-.*|x-real-ip|x-client-ip|true-client-ip|cf-connecting-ip|tailscale-.*)$/;
  const targetOf = (req) => `${req.method} ${String(req.url || "").slice(0, 80)}`;
  const endToEnd = (from, { request = false } = {}) => {
    const out = {};
    for (const [k, v] of Object.entries(from || {})) {
      if (HOP_BY_HOP.has(k)) continue;
      if (request && IDENTITY.test(k)) continue;
      out[k] = v;
    }
    return out;
  };

  /** A refusal the relay writes itself: nothing is opened upstream, and the
   *  connection does not survive it (`Connection: close`). */
  function refuseWith(req, res, status, code, reason) {
    note("deny", targetOf(req), reason);
    const body = JSON.stringify({ error: code });
    try {
      res.shouldKeepAlive = false;
      res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body), connection: "close" });
      res.end(body);
    } catch { try { req.socket.destroy(); } catch {} }
  }

  /** A path/method the doors do not serve. */
  function refuseDoor(req, res, reason) { refuseWith(req, res, 403, "forbidden", reason); }

  /** More work than the relay will carry (a full pipeline queue, the upstream
   *  cap): nothing is opened upstream. */
  function refuseUnavailable(req, res, reason) { refuseWith(req, res, 503, "unavailable", reason); }

  /** A raw-socket refusal ('upgrade', 'connect'): no HTTP parser owns it yet. */
  function refuseRaw(req, socket, reason) {
    note("deny", targetOf(req), reason);
    try { socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); } catch {}
    const t = setTimeout(() => { try { socket.destroy(); } catch {} }, 1000);
    if (t.unref) t.unref();
  }

  /** Upstream trouble (including a failed bind of the mark): fail closed. */
  function failDoor(req, res, e) {
    note("deny", targetOf(req), "upstream " + ((e && e.code) || "error"));
    if (res.headersSent) { try { res.destroy(); } catch {} return; }
    const body = JSON.stringify({ error: "bad gateway" });
    try {
      res.shouldKeepAlive = false;
      res.writeHead(502, { "content-type": "application/json", "content-length": Buffer.byteLength(body), connection: "close" });
      res.end(body);
    } catch { try { req.socket.destroy(); } catch {} }
  }

  /** The headers sent upstream: end-to-end only, and a body is always framed. */
  function upstreamHeaders(req) {
    const out = endToEnd(req.headers, { request: true });
    // The client's own framing is hop-by-hop and was stripped above. A decoded
    // body written after headers with no framing is a SECOND request on the
    // gateway's wire, so re-declare what the client already used.
    if (req.headers["transfer-encoding"] !== undefined && req.headers["content-length"] === undefined) {
      out["transfer-encoding"] = "chunked";
    }
    return out;
  }

  function forwardDoor(req, res) {
    // Relay-wide: a flood of bot connections must not become a flood of
    // upstream sockets either.
    if (upstreamLive >= maxUpstream) return refuseUnavailable(req, res, "relay upstream cap " + maxUpstream);
    let up;
    try {
      up = httpRequest({
        host: "127.0.0.1", port: gatewayPort, localAddress: RELAY_SOURCE_V4,
        method: req.method, path: req.url, headers: upstreamHeaders(req),
        // No pooling: the mark belongs to this request's socket, and a pooled
        // socket would outlive the request that earned it.
        agent: false,
      });
    } catch (e) { return failDoor(req, res, e); }
    upstreamLive++;
    let released = false;
    const release = () => { if (!released) { released = true; upstreamLive--; } };
    up.on("error", (e) => { release(); failDoor(req, res, e); });
    up.on("close", release);
    up.on("response", (ur) => {
      try {
        res.writeHead(ur.statusCode || 502, endToEnd(ur.headers));
        // Streamed both ways: an SSE answer arrives chunk by chunk and no body
        // is ever held whole in this process.
        ur.pipe(res);
        // An upstream that dies mid-body would leave the bot's connection
        // half-answered for the rest of the spawn: destroy it, so the bot's
        // own client sees a reset and not a body that never ends.
        const cut = () => { if (!ur.complete) { try { res.destroy(); } catch {} } };
        ur.on("error", cut);
        ur.on("aborted", cut);
        ur.on("close", cut);
      } catch (e) { try { ur.destroy(); } catch {} failDoor(req, res, e); }
    });
    // The bot hung up (or the socket died): stop the other leg too, so an SSE
    // stream nobody reads does not hold sockets for the rest of the spawn.
    res.on("close", () => { try { up.destroy(); } catch {} });
    req.pipe(up);
  }

  /**
   * One request in flight per bot connection. Pipelining used to dial one
   * upstream socket per request the moment it arrived (1,500 sockets from one
   * connection in a probe). Node answers pipelined requests in order, so the
   * extra ones wait here and each starts when the previous response has
   * finished or closed; past MAX_QUEUED the rest is refused.
   */
  const perSocket = new WeakMap(); // socket -> { busy, queue }
  const connState = (socket) => {
    let st = perSocket.get(socket);
    if (!st) {
      st = { busy: false, queue: [] };
      perSocket.set(socket, st);
      socket.once("close", () => { st.busy = false; st.queue.length = 0; });
    }
    return st;
  };

  /** Judge one request and answer it: the whole decision lives here. */
  function serveOne(req, res) {
    const upgrade = req.headers.upgrade !== undefined
      || /(?:^|,)\s*upgrade\s*(?:,|$)/i.test(String(req.headers.connection || ""));
    if (req.method === "CONNECT" || upgrade) return refuseDoor(req, res, "upgrade refused");
    // A body on a bodiless method has no framing this hop may forward (the
    // client's own is hop-by-hop), so it would land raw after the headers as a
    // second request on the gateway's wire. Refused, nothing opened upstream.
    if (BODILESS.has(req.method)
      && (req.headers["transfer-encoding"] !== undefined || Number(req.headers["content-length"] || 0) > 0)) {
      return refuseWith(req, res, 400, "bad request", "body on a bodiless method");
    }
    if (doorFilter && !isDoorPath(req.url)) return refuseDoor(req, res, "not a door");
    forwardDoor(req, res);
  }

  /** Start one request, and start the next queued one once its response is done. */
  function startOne(req, res, st) {
    if (req.socket.destroyed) { st.busy = false; return; }
    st.busy = true;
    // No timeout while a request is in flight: an SSE stream is long by design.
    req.socket.setTimeout(0);
    let done = false;
    const next = () => {
      if (done) return;
      done = true;
      st.busy = false;
      const q = st.queue.shift();
      if (q) return startOne(q.req, q.res, st);
      // Keep-alive and nothing in flight: an idle connection is closed here.
      // (no callback: enterDoors registered the one timeout handler)
      req.socket.setTimeout(idleMs);
    };
    res.on("finish", next);
    res.on("close", next);
    serveOne(req, res);
  }

  doors.on("request", (req, res) => {
    // The first request ends the absolute head timer (enterDoors).
    const ht = headTimers.get(req.socket);
    if (ht) { clearTimeout(ht); headTimers.delete(req.socket); }
    const st = connState(req.socket);
    if (st.busy) {
      if (st.queue.length >= MAX_QUEUED) return refuseUnavailable(req, res, "too many pipelined requests");
      st.queue.push({ req, res });
      return;
    }
    startOne(req, res, st);
  });
  // Node hands these two off the request event; neither may reach the gateway.
  doors.on("upgrade", (req, socket) => refuseRaw(req, socket, "upgrade refused"));
  doors.on("connect", (req, socket) => refuseRaw(req, socket, "CONNECT refused"));
  doors.on("clientError", (err, socket) => {
    if (!socket.writable || (err && err.code === "ECONNRESET")) { try { socket.destroy(); } catch {} return; }
    try { socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); } catch { try { socket.destroy(); } catch {} }
  });

  /** Hand the bot's connection to the HTTP parser once the PORT line is read. */
  const headTimers = new WeakMap();
  const enterDoors = (c) => {
    doors.emit("connection", c);
    // The doors server never listens, so node's own timeout checker never runs
    // for it. The first head gets an ABSOLUTE timer (a trickled header cannot
    // keep it alive), cleared by the first request. After that the socket's
    // idle timeout takes over (startOne), set without a callback: the ONE
    // handler is registered here, so a long keep-alive session never piles up
    // timeout listeners. It is off while a request is in flight (SSE is long).
    const ht = setTimeout(() => { try { c.destroy(); } catch {} }, headTimeoutMs);
    if (ht.unref) ht.unref();
    headTimers.set(c, ht);
    c.once("close", () => { clearTimeout(ht); headTimers.delete(c); });
    c.on("timeout", () => { try { c.destroy(); } catch {} });
    // The parser attaches its own readers; a socket paused for the PORT line
    // must be resumed explicitly (a 'data' listener alone does not unpause it).
    c.resume();
  };

  async function handleProxy(c, head) {
    const first = head.split("\r\n")[0] || "";
    const m = first.match(/^(\S+)\s+(\S+)\s+HTTP\/1\.[01]$/);
    if (!m) return refuse(c, 400, "Bad Request");
    if (m[1] !== "CONNECT") { note("deny", m[1] + " " + m[2].slice(0, 80), "only CONNECT"); return refuse(c, 405, "Method Not Allowed"); }
    const hp = m[2].match(/^\[([0-9a-fA-F:.]+)\]:(\d+)$/) || m[2].match(/^([^:\[\]]+):(\d+)$/);
    if (!hp) return refuse(c, 400, "Bad Request");
    const host = norm(hp[1]), port = Number(hp[2]);
    if (!isIP(host) && !HOSTNAME_RE.test(host)) return refuse(c, 400, "Bad Request");
    const target = host + ":" + port;
    if (!ports.has(port)) { note("deny", target, "port not allowed"); return refuse(c, 403, "Forbidden"); }
    if (!hostAllowed(host, allow)) { note("deny", target, "host not in the bot's egress list"); return refuse(c, 403, "Forbidden"); }
    let addrs;
    if (isIP(host)) addrs = [{ address: host, family: isIP(host) }];
    else {
      try { addrs = await lookup(host); } catch { note("deny", target, "does not resolve"); return refuse(c, 502, "Bad Gateway"); }
    }
    const view = localView(local); // one host view per CONNECT
    noteOwnHostView(view);
    const why = addrs.length ? addrs.map((a) => egressDenyReason(a.address, { view })).find(Boolean) : "no address";
    if (why) {
      note("deny", target, why);
      return refuse(c, 403, "Forbidden");
    }
    // The client left during the lookup (half-open sockets see only 'end'):
    // no tunnel is worth opening for a client that has nothing more to send.
    if (c.destroyed || c.readableEnded) { try { c.destroy(); } catch {} return; }
    note("allow", target);
    splice(c, addrs.map((a) => a.address), port, "HTTP/1.1 200 Connection Established\r\n\r\n");
  }

  const server = createServer({ allowHalfOpen: true }, (c) => {
    sockets.add(c);
    c.on("close", () => { sockets.delete(c); });
    if (live >= maxConns) { note("deny", "connection", "per-spawn connection cap " + maxConns); c.destroy(); return; }
    live++;
    c.once("close", () => { live--; });
    let buf = Buffer.alloc(0);
    let verb = null;
    const timer = setTimeout(() => c.destroy(), headTimeoutMs);
    if (timer.unref) timer.unref();
    c.once("close", () => clearTimeout(timer));
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      if (verb === null) {
        const nl = buf.indexOf(10);
        if (nl < 0) { if (buf.length > 64) { clearTimeout(timer); c.destroy(); } return; }
        verb = buf.subarray(0, nl).toString("latin1");
        buf = buf.subarray(nl + 1);
        const pm = verb.match(/^PORT (\d{1,5})$/);
        if (pm) {
          c.removeListener("data", onData); clearTimeout(timer);
          const port = Number(pm[1]);
          if (!gatewayPort || port !== gatewayPort) {
            // No other loopback port is served at all: the one a contained bot
            // reaches is its own gateway's, and there only the doors. With no
            // gateway port there is no PORT line to serve, 0 included.
            note("deny", "127.0.0.1:" + port, gatewayPort ? "not the bot's gateway port" : "no gateway port");
            c.destroy();
            return;
          }
          note("allow", "127.0.0.1:" + port);
          // Paused until the HTTP parser owns it; bytes that came with the
          // header line (usually a whole request) go back on the stream first.
          c.pause();
          if (buf.length) c.unshift(buf);
          enterDoors(c);
          return;
        }
        if (verb !== "PROXY") { clearTimeout(timer); c.destroy(); return; }
      }
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0 ? buf.length > MAX_HEAD : end > MAX_HEAD) {
        clearTimeout(timer); c.removeListener("data", onData); refuse(c, 431, "Request Header Fields Too Large");
        return;
      }
      if (end < 0) return;
      clearTimeout(timer);
      c.removeListener("data", onData);
      const head = buf.subarray(0, end).toString("latin1");
      const rest = buf.subarray(end + 4);
      c.pause();
      if (rest.length) c.unshift(rest);
      handleProxy(c, head).catch(() => c.destroy());
    };
    c.on("data", onData);
    c.on("error", () => {});
  });
  let listening = false;
  const ready = new Promise((resolve, reject) => {
    // A persistent handler: accept errors (EMFILE, ENFILE) after listening must
    // never be unhandled, which would kill the gateway or bot runner.
    server.on("error", (e) => {
      if (!listening) { log(`[pi-egress] bot=${o.botId || "?"} relay failed to listen: ${e.message}`); reject(e); }
      else log(`[pi-egress] bot=${o.botId || "?"} relay error: ${e.message}`);
    });
    server.listen(socketPath, () => { listening = true; try { chmodSync(socketPath, 0o600); } catch {} resolve(); });
  });
  ready.catch(() => {});
  return {
    dir, socketPath, ready, _server: server, _sockets: sockets,
    close: () => new Promise((resolve) => {
      for (const s of sockets) { try { s.destroy(); } catch {} }
      server.close(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} resolve(); });
    }),
  };
}
