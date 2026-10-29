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
 *   proxy               the client a CROW_TRUSTED_PROXIES proxy forwarded
 *   local, unverified,  none: always "this machine" (loopback with no client
 *   funnel              we can trust, or a public Funnel visitor)
 *
 * The client is "this machine" when it is any address of any interface here
 * (virtual and tailnet ones included), lies inside the subnet of a container
 * or VM bridge interface (docker0, br-*, virbr*, ...), is loopback or
 * unspecified, or cannot be parsed. An unreadable or empty interface table
 * also counts as "this machine". Every doubt resolves to "this machine",
 * which only ever takes the owner's turn away.
 *
 * Node built-ins only. Bundles reach it through the app root.
 */
import { networkInterfaces } from "node:os";
import { isIP } from "node:net";
import { classifyIp, parseIPv6 } from "./ip-classify.js";
import { classifyPeer, normalizeAddr } from "./peer-class.js";

/** Container and VM bridges: anything on their subnet runs on this machine. */
const BRIDGE_IF_RE = /^(docker|br-|veth|virbr|vmnet|lxc|lxd|incus|cni|podman)/;
const TTL_MS = 5_000;
/** The interface-table test hook ip-classify.js already honours (setInterfaceTableForTests). */
const IFACE_OVERRIDE = Symbol.for("crow.ip-classify.interfaces");

let cache = { at: 0, table: null };

function readTable() {
  const override = globalThis[IFACE_OVERRIDE];
  if (typeof override === "function") return override();
  const now = Date.now();
  if (cache.table && now - cache.at <= TTL_MS) return cache.table;
  const table = networkInterfaces(); // a throw propagates: the caller fails closed
  cache = { at: now, table };
  return table;
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

/**
 * The client address this request really comes from, or null when there is
 * none we can trust (see the table above).
 */
export function effectiveClient(req) {
  const p = classifyPeer(req);
  if (p.via === "direct") return p.socket || null;
  if (p.via === "serve" || p.via === "proxy") return p.client || null;
  return null;
}

/**
 * True when `address` is this machine: one of its interface addresses, inside
 * a bridge subnet, loopback/unspecified, or unparseable. `interfaces` (an
 * os.networkInterfaces()-shaped table) is for tests. Any error -> true.
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
    const table = interfaces || readTable();
    const entries = Object.entries(table || {});
    if (!entries.length) return true;
    let any = false;
    for (const [name, list] of entries) {
      for (const e of list || []) {
        const own = toNum(e?.address);
        if (!own) continue;
        any = true;
        if (candidates.some((c) => c.family === own.family && c.n === own.n)) return true;
        if (BRIDGE_IF_RE.test(name)) {
          const prefix = prefixOf(e, own.family);
          if (prefix == null || candidates.some((c) => sameNet(c, own, prefix))) return true;
        }
      }
    }
    return !any;
  } catch {
    return true;
  }
}

/** True when the request comes from this machine (or we cannot tell). Never throws. */
export function isSelfOrigin(req, opts = {}) {
  try {
    return isSelfAddress(effectiveClient(req), opts);
  } catch {
    return true;
  }
}

/** Tests only: forget the cached interface table. */
export function resetSelfOriginCacheForTests() {
  cache = { at: 0, table: null };
}
