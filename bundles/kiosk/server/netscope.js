/**
 * Where an address is, seen from THIS host — for the stream relay (relay.js).
 *
 * The class of an address comes from the shared classifier (servers/shared/ip-classify.js, through the
 * app root: an installed copy never imports a repo-relative path). This module adds what only the host
 * knows: its own interface addresses, the on-link prefix of every interface, which interface carries
 * the default route (the home LAN), and the tailnet ranges.
 *
 *   - Never public, on any hop of any policy: an address of this host, or any address inside the
 *     on-link prefix of one of its interfaces (its LAN /24, its LAN's global IPv6 /64, every container
 *     bridge, a point-to-point link). From the outside those look "public" or "private"; from here they
 *     are inside the house.
 *   - A home-network station (the operator's tick, spec §13.4) may reach ONLY: an address in the on-link
 *     prefix of the default-route interface (the home LAN), or the tailnet (100.64/10 and Tailscale's
 *     fd7a:115c:a1e0::/48), and never one inside a container bridge, a VM bridge, a point-to-point link
 *     or any other interface's prefix, never this host, never a LAN prefix's network or broadcast address.
 *
 * Read per hop (interfaces change: a VPN comes up, a container network is created). Fail closed: if the
 * interfaces cannot be read, nothing extra is allowed and the ranges still refuse what they refuse.
 */
import { networkInterfaces } from "node:os";
import { readFileSync } from "node:fs";
import { isIP, BlockList } from "node:net";
import { appImport } from "./app-root.js";

const { classifyIp } = await appImport("servers/shared/ip-classify.js");
export { classifyIp };

/** One spelling per address: lower case, no brackets or zone, an IPv4-mapped IPv6 written as its IPv4. */
export function normAddress(address) {
  const s = String(address ?? "").trim().replace(/^\[(.*)\]$/, "$1").split("%")[0].toLowerCase();
  if (isIP(s) === 6) { const c = classifyIp(s); if (c.via === "mapped" && c.v4) return c.v4; }
  return s;
}

/**
 * NOT a public address — the classifier's answer, kept stricter for a relay: an IPv4 carried inside a
 * translated or tunnelled IPv6 form (SIIT, IPv4-compatible, NAT64, 6to4, Teredo) is refused even when
 * that IPv4 is public (this host has no NAT64; those forms only disguise an address).
 * ADDRESS-ONLY, on purpose: the home-network rule in judgeAddress uses it to recognise the LAN's own
 * global IPv6 prefix, which a host-aware test would call not public. The host view belongs to
 * judgeAddress (see its SWAP POINT), never here.
 */
export function isNotPublicAddress(address) {
  const { cls, via } = classifyIp(address);
  return cls !== "public" || (via !== null && via !== "mapped");
}
/** The classes a home-network station may have at all: RFC 1918 (IPv4 only: fec0::/10 site-local is excluded), CGNAT, ULA; plain forms only. */
export function isLocalStreamClass(address) {
  const a = normAddress(address);
  const { cls, via } = classifyIp(a);
  return via === null && (cls === "cgnat" || cls === "ula" || (cls === "private" && isIP(a) === 4));
}

export const TAILNET_RANGES = Object.freeze([["100.64.0.0", 10, "ipv4"], ["fd7a:115c:a1e0::", 48, "ipv6"]]);
const tailnet = new BlockList();
for (const [n, b, f] of TAILNET_RANGES) tailnet.addSubnet(n, b, f);
const fam = (a) => (isIP(a) === 6 ? "ipv6" : "ipv4");
/** Interfaces whose prefixes are the tailnet's, whatever its addresses. */
const TAILNET_NAMES = /^(tailscale\d*|ts\d+)$/;

/** The interfaces that carry a default route (IPv4 and IPv6), from the kernel's routing tables. */
export function readDefaultRouteInterfaces(read = (p) => readFileSync(p, "utf8")) {
  const out = new Set();
  try {
    for (const line of read("/proc/net/route").split("\n").slice(1)) {
      const f = line.trim().split(/\s+/);
      // Destination 00000000 and mask 00000000, flags UP (1) and GATEWAY (2).
      if (f.length > 7 && f[1] === "00000000" && f[7] === "00000000" && (parseInt(f[3], 16) & 3) === 3) out.add(f[0]);
    }
  } catch { /* not Linux, or not readable */ }
  try {
    for (const line of read("/proc/net/ipv6_route").split("\n")) {
      const f = line.trim().split(/\s+/);
      // ::/0 with a next hop that is not :: and not a reject route (flag 0x200).
      if (f.length > 9 && /^0{32}$/.test(f[0]) && f[1] === "00" && !/^0{32}$/.test(f[4]) && (parseInt(f[8], 16) & 0x200) === 0) out.add(f[9]);
    }
  } catch { /* idem */ }
  return out;
}

/**
 * A snapshot of this host's network. interfaces: () → os.networkInterfaces() shape; defaults: () → Set of
 * interface names with a default route. → { own: Set<address>, prefixes: [{ name, family, list: BlockList,
 * net, bits, lan, tailnet }] }
 */
export function readHostNetwork({ interfaces = networkInterfaces, defaults = readDefaultRouteInterfaces } = {}) {
  const own = new Set(), prefixes = [];
  let lanNames = new Set();
  try { lanNames = defaults(); } catch { lanNames = new Set(); }
  let table = {};
  try { table = interfaces() || {}; } catch { table = {}; }
  for (const [name, list] of Object.entries(table)) {
    for (const a of list || []) {
      const address = normAddress(a?.address);
      if (!isIP(address)) continue;
      own.add(address);
      const cidr = String(a?.cidr || "");
      const bits = Number(cidr.split("/")[1]);
      if (!Number.isInteger(bits)) continue;
      const family = fam(address);
      // A host route (/32, /128) is the address itself (own covers it); a 0-length prefix would swallow everything.
      if (bits === 0 || (family === "ipv4" && bits >= 32) || (family === "ipv6" && bits >= 128)) continue;
      // Loopback is refused by class anyway; link-local prefixes are refused by class on every policy.
      const l = new BlockList();
      try { l.addSubnet(address, bits, family); } catch { continue; }
      prefixes.push({ name, family, list: l, address, bits, lan: lanNames.has(name), tailnet: TAILNET_NAMES.test(name) });
    }
  }
  return { own, prefixes };
}

const inPrefix = (p, a) => { try { return p.family === fam(a) && p.list.check(a, p.family); } catch { return false; } };
const v4int = (a) => a.split(".").reduce((n, o) => n * 256 + Number(o), 0);
/** The network or broadcast address of an IPv4 prefix (TCP never reaches either; the policy says "no broadcast"). */
const edgeOf = (p, a) => {
  if (p.family !== "ipv4" || p.bits > 30) return false;
  const size = 2 ** (32 - p.bits), off = v4int(a) % size;
  return off === 0 || off === size - 1;
};

/**
 * Judge one resolved address. → null (allowed) or a refusal code.
 *   local: false — the public rule: not this host, not inside any interface's prefix, and public.
 *   local: true  — a home-network station's own host: not this host; on the home LAN (the default-route
 *                  interface's prefix) or the tailnet; never inside any other interface's prefix.
 * isNotPublic: the public test (injectable for tests whose public stand-ins are documentation addresses).
 */
export function judgeAddress(address, net, { local = false, isNotPublic = isNotPublicAddress } = {}) {
  const a = normAddress(address);
  if (!isIP(a)) return "private_address";
  if (net.own.has(a)) return "own_address";
  const hits = net.prefixes.filter((p) => inPrefix(p, a));
  // SWAP POINT (public rule only): once servers/shared/ip-classify.js exports the host-aware
  // isOwnNetworkIp/isPublicEgressIp, this line also refuses `|| isOwnNetworkIp(a)` (import it beside
  // classifyIp) — one shared view of this host's networks on top of this module's own. Not inside
  // isNotPublicAddress: that would refuse a ticked station on the LAN's own global IPv6 /64.
  if (!local) return hits.length || isNotPublic(a) ? "private_address" : null;
  const { cls, via } = classifyIp(a);
  if (via !== null) return "private_address";
  // Any prefix that is not the home LAN or the tailnet (a container or VM bridge, a point-to-point link): never.
  if (hits.some((p) => !p.lan && !p.tailnet)) return "private_address";
  const lanHit = hits.find((p) => p.lan);
  if (lanHit) {
    if (edgeOf(lanHit, a)) return "private_address";
    // On the home LAN: RFC 1918, CGNAT, ULA, or the LAN's own global IPv6 prefix.
    return cls === "cgnat" || cls === "ula" || !isNotPublic(a) || (cls === "private" && isIP(a) === 4) ? null : "private_address";
  }
  // Not on the LAN: only the tailnet.
  try { if (tailnet.check(a, fam(a)) && (cls === "cgnat" || cls === "ula")) return null; } catch { /* not an address */ }
  return "private_address";
}
