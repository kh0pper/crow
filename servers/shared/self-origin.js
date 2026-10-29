/**
 * Does this request come from this machine itself?
 *
 * The owner's turn (local-session.js) is never granted to a request that
 * starts on this host. A browser container on host networking, a console on
 * the box, a script or a bot with a shell can set any header, cookie or user
 * agent it likes, and through Tailscale Serve it even carries the owner's real
 * tailnet login. What none of them can change is where its packets come from,
 * so the rule is on the request's client address alone:
 *
 *   via (classifyPeer)  client checked
 *   direct              the TCP socket address
 *   serve               the tailnet client Serve names (only trusted when the
 *                       loopback socket belongs to tailscaled; classifyPeer)
 *   proxy               the client a CROW_TRUSTED_PROXIES proxy forwarded, but
 *                       only when the proxy itself is another machine. A proxy
 *                       on this box (loopback, an own address, a bridge) can't
 *                       be told apart from any local process writing the same
 *                       header, so it is "this machine" (no owner's turn behind
 *                       a same-box Caddy/nginx; docs/getting-started/custom-domain.md)
 *   local, unverified,  none: always "this machine" (loopback with no client
 *   funnel              we can trust, or a public Funnel visitor)
 *
 * The client is "this machine" when it is any address of any interface here
 * (virtual and tailnet ones included), lies inside the subnet of a container
 * or VM bridge interface (docker0, br-*, virbr*, ...) that no LAN interface
 * covers more specifically, is loopback or unspecified, or cannot be
 * parsed. An unreadable or empty interface table also counts as "this
 * machine". Every doubt resolves to "this machine", which only ever takes the
 * owner's turn away.
 *
 * Residual (stated, not closed here): a bot that relays through ANOTHER
 * machine (ssh/socat to a peer host, or raven's bots over the direct link) is
 * off-box. A session it minted on this box is still 'dashboard onhost' and
 * never the owner, but a fresh login it makes from the other host is a plain
 * owner session. That is guarded only by the dashboard password's secrecy:
 * the password saved in the shared browser profile and the pre-change
 * session it holds (removed by the browser sign-out), and ~/.crow being
 * readable by the gateway's user (the bot-containment work).
 *
 * Node built-ins only. Bundles reach it through the app root.
 */
import { networkInterfaces } from "node:os";
import { isIP } from "node:net";
import { classifyIp, parseIPv6 } from "./ip-classify.js";
import { classifyPeer, normalizeAddr } from "./peer-class.js";
import { warnOnce } from "./peer-uid.js";

/** Container and VM bridges and taps: anything on their subnet runs on this machine. Broader than
 * locality.js's VIRTUAL_IF_RE on purpose: that one answers "is this provider URL ours", this one
 * "could this client be a guest on this box". */
const BRIDGE_IF_RE = /^(docker|br-|veth|virbr|vnet|vmnet|vboxnet|lxc|lxd|incus|cni|podman|mpqemubr|multipass|tap|macvtap)/;
const TTL_MS = 5_000;
/** The interface-table test hook ip-classify.js already honours (setInterfaceTableForTests). */
const IFACE_OVERRIDE = Symbol.for("crow.ip-classify.interfaces");

let cache = { at: 0, table: null };

/** → { table, cached }. A throw propagates: the caller fails closed. */
function readTable({ fresh = false } = {}) {
  const override = globalThis[IFACE_OVERRIDE];
  if (typeof override === "function") return { table: override(), cached: false };
  const now = Date.now();
  if (!fresh && cache.table && now - cache.at <= TTL_MS) return { table: cache.table, cached: true };
  const table = networkInterfaces();
  cache = { at: now, table };
  return { table, cached: false };
}

/** Address -> { family, n } (a v4-mapped spelling compares as its IPv4), or null. */
function toNum(address) {
  const s = normalizeAddr(String(address ?? "").replace(/%.*$/, ""));
  if (isIP(s) === 4) return { family: 4, n: BigInt(s.split(".").reduce((x, o) => x * 256 + Number(o), 0)) };
  const g = parseIPv6(s);
  if (!g) return null;
  return { family: 6, n: g.reduce((acc, x) => (acc << 16n) | BigInt(x), 0n) };
}

function prefixOf(entry, family) {
  const fromCidr = Number(String(entry?.cidr || "").split("/")[1]);
  if (Number.isInteger(fromCidr)) return fromCidr;
  const mask = toNum(entry?.netmask);
  if (!mask || mask.family !== family) return null;
  let bits = 0;
  for (let n = mask.n; n > 0n; n >>= 1n) bits += Number(n & 1n);
  return bits;
}

function sameNet(a, b, prefix) {
  if (a.family !== b.family) return false;
  const shift = BigInt((a.family === 4 ? 32 : 128) - prefix);
  return (a.n >> shift) === (b.n >> shift);
}

/** Interface table → [{ name, bridge, own, prefix }] for every usable address. */
function nets(table) {
  const out = [];
  for (const [name, list] of Object.entries(table || {})) {
    for (const e of list || []) {
      const own = toNum(e?.address);
      if (!own) continue;
      out.push({ name, bridge: BRIDGE_IF_RE.test(name), own, prefix: prefixOf(e, own.family), loopback: classifyIp(normalizeAddr(String(e.address))).cls === "loopback" });
    }
  }
  return out;
}

/** One table's answer for these candidate numbers: true (this machine) or false. */
function selfIn(table, candidates) {
  const list = nets(table);
  if (!list.length) return true; // nothing usable: undeterminable
  for (const c of candidates) {
    if (list.some((x) => x.own.family === c.family && x.own.n === c.n)) return true;
    // A bridge subnet covering the client, unless a LAN (non-bridge) interface covers it MORE
    // specifically: then the kernel routes the reply out the LAN (longest prefix), so no guest on
    // the overlapping bridge could hold this connection. An equal prefix is a routing tie, so it
    // stays "this machine". A bridge with no readable prefix covers everything.
    for (const b of list) {
      if (!b.bridge || b.own.family !== c.family) continue;
      if (b.prefix == null) return true;
      if (!sameNet(c, b.own, b.prefix)) continue;
      const lan = list.some((x) => !x.bridge && x.own.family === c.family && x.prefix != null && x.prefix > b.prefix && sameNet(c, x.own, x.prefix));
      if (!lan) return true;
    }
  }
  return false;
}

/**
 * The client address this request really comes from, or null when there is
 * none we can trust (see the table above).
 */
export function effectiveClient(req, opts = {}) {
  const p = classifyPeer(req);
  if (p.via === "direct") return p.socket || null;
  if (p.via === "serve") return p.client || null;
  if (p.via === "proxy") {
    // A declared proxy on this box can't vouch for anyone: any local process opens the same
    // socket and writes the same X-Forwarded-For (Serve is trusted only because peer-uid.js
    // checks tailscaled's uid; nothing checks a same-box proxy's).
    if (isSelfAddress(p.socket, opts)) return null;
    return p.client || null;
  }
  return null;
}

/**
 * True when `address` is this machine: one of its interface addresses, inside
 * a bridge subnet (longest prefix wins against a LAN interface), loopback or
 * unspecified, or unparseable. `interfaces` (an os.networkInterfaces()-shaped
 * table) is for tests. Any error -> true.
 */
export function isSelfAddress(address, { interfaces } = {}) {
  try {
    if (address == null || String(address).trim() === "") return true;
    const a = toNum(address);
    if (!a) return true;
    const candidates = [a];
    const { cls, v4 } = classifyIp(normalizeAddr(String(address).replace(/%.*$/, "")));
    if (cls === "loopback" || cls === "unspecified" || cls === "invalid") return true;
    if (v4) {
      const e = toNum(v4);
      if (e) candidates.push(e);
      const ec = classifyIp(v4).cls;
      if (ec === "loopback" || ec === "unspecified") return true;
    }
    if (interfaces) return selfIn(interfaces, candidates);
    const first = readTable();
    if (selfIn(first.table, candidates)) return true;
    // "Not this machine" from a cached table: re-read once, so an interface created in the last
    // few seconds (a new compose bridge) can only ever add "this machine".
    if (first.cached) return selfIn(readTable({ fresh: true }).table, candidates);
    return false;
  } catch {
    return true;
  }
}

/** True when the request comes from this machine (or we cannot tell). Never throws. */
export function isSelfOrigin(req, opts = {}) {
  try {
    return isSelfAddress(effectiveClient(req, opts), opts);
  } catch {
    return true;
  }
}

export const BRIDGE_OVERLAP_WARNING = "[net] WARN a container or VM bridge subnet overlaps this machine's LAN subnet: a LAN client in the overlap that no LAN interface covers more specifically counts as this machine, so it never gets the owner's turn (connected services, phone approvals). Use Tailscale Serve, or move the bridge to another subnet (docker default-address-pools).";

/**
 * Logs BRIDGE_OVERLAP_WARNING once when any bridge subnet overlaps a non-bridge interface's subnet
 * (gateway start). Returns true when the overlap exists. Never throws.
 */
export function warnBridgeOverlap({ interfaces, log } = {}) {
  try {
    const list = nets(interfaces || readTable().table);
    // Two subnets overlap when they agree on the shorter prefix. Loopback is not a LAN.
    const overlap = list.some((b) => b.bridge && b.prefix != null && list.some((x) => !x.bridge && !x.loopback && x.prefix != null
      && x.own.family === b.own.family && sameNet(x.own, b.own, Math.min(x.prefix, b.prefix))));
    if (overlap) {
      if (log) log(BRIDGE_OVERLAP_WARNING);
      else warnOnce("bridge-lan-overlap", BRIDGE_OVERLAP_WARNING);
    }
    return overlap;
  } catch {
    return false;
  }
}

/** Tests only: forget the cached interface table. */
export function resetSelfOriginCacheForTests() {
  cache = { at: 0, table: null };
}
