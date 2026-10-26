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
 *   PORT <n>\n  splice to 127.0.0.1:<n> on the host, only for the spawn's
 *               loopback allowlist (its gateway port, a loopback model
 *               provider, loopback URLs in its own MCP config). Nothing else
 *               on loopback: other instances, unused model servers, a
 *               browser's DevTools port, adb.
 *   PROXY\n     an HTTP CONNECT request follows (the bot's HTTPS_PROXY). Only
 *               CONNECT; ports from egressPorts (default 443); public AND
 *               private destinations are allowed (D4), but no address the
 *               host resolves to may be loopback, this host's own address, a
 *               cloud metadata endpoint or non-unicast (every address checked,
 *               the checked one connected: no DNS rebinding); IP literals the
 *               same; an `egress` list (exact or *.suffix) narrows further.
 *
 * Every decision is logged once per (decision, host:port) per spawn,
 * `[pi-egress] bot=<id> allow|deny <host>:<port> (<reason>)`. A per-spawn
 * connection cap bounds what one bot can open.
 */
import { createServer, connect as netConnect, isIP, BlockList } from "node:net";
import { networkInterfaces } from "node:os";
import { spawnSync } from "node:child_process";
import { lookup as dnsLookup } from "node:dns/promises";
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

// Default egress (operator decision D4, 2026-10-26: "public and private"):
// public and private (LAN, tailnet, ULA) destinations are allowed; a bot's
// `egress` list narrows. Always refused, because each is a way around another
// control rather than a destination class:
//   - loopback (127/8, 0/8, ::, ::1): host loopback is governed by the PORT
//     allowlist; reaching it through the proxy would skip that list;
//   - this host: its own interface addresses (every service bound to
//     0.0.0.0), the subnets of its virtual bridges (containers and VMs, which
//     host-originated traffic reaches without passing DOCKER-USER), its subnet
//     broadcasts, and tailscaled's local services (100.100.100.0/24,
//     fd7a:115c:a1e0::53);
//   - cloud metadata and host plumbing: all of 169.254.0.0/16, Azure's
//     168.63.129.16, AWS fd00:ec2::/64, GCP fd20:ce::254;
//   - multicast/reserved (not unicast).
// The local view comes from the kernel route tables (local addresses and
// broadcasts on every interface, up or down; connected subnets of virtual
// bridges, including ones with no carrier), cached 5 s, plus
// os.networkInterfaces() as an extra source. If either cannot be read, every
// private target is refused (fail closed), docker0 and libvirt's default
// subnets by name too.
// IPv4 embedded in IPv6 (v4-mapped, v4-compatible, SIIT, NAT64 64:ff9b::/96,
// 6to4 2002::/16, both Teredo fields) is unwrapped and judged as the IPv4
// address; the NAT64 local-use /48 and the discard prefix are refused.
// Zone ids are stripped (the CONNECT parser refuses '%' anyway).
const PLUMBING_V4 = new BlockList();
for (const [a, p] of [["169.254.0.0", 16], ["168.63.129.16", 32], ["100.100.100.0", 24]]) PLUMBING_V4.addSubnet(a, p, "ipv4");
const PRIVATE_V4 = new BlockList();
for (const [a, p] of [["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16], ["100.64.0.0", 10], ["198.18.0.0", 15]]) PRIVATE_V4.addSubnet(a, p, "ipv4");
/** Interfaces whose subnets are containers/VMs on this host. */
const VIRTUAL_IF = /^(docker\d*|br-|virbr|podman|cni|veth|lxcbr|lxdbr|incusbr|flannel|cali|vxlan|vnet|tap|tun)/;

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
const v4Int = (a) => a.split(".").reduce((n, o) => n * 256 + Number(o), 0);
const intV4 = (n) => [24, 16, 8, 0].map((b) => (n >>> b) & 255).join(".");

const IP_CANDIDATES = ["/usr/sbin/ip", "/sbin/ip", "/usr/bin/ip", "/bin/ip"];
/**
 * The kernel's view: the local table (every local and broadcast address, on
 * every interface, up or down) and the main table (directly connected
 * subnets, including bridges with no carrier, which os.networkInterfaces()
 * does not list). Throws when it cannot be read.
 */
export function readKernelRoutes() {
  const ip = IP_CANDIDATES.find((p) => existsSync(p));
  if (!ip) throw new Error("ip(8) not found");
  const run = (args) => {
    const r = spawnSync(ip, ["-j", ...args], { encoding: "utf8", timeout: 2000 });
    if (r.status !== 0) throw new Error("ip " + args.join(" ") + ": exit " + r.status);
    const v = JSON.parse(r.stdout || "null");
    if (!Array.isArray(v)) throw new Error("ip " + args.join(" ") + ": not a list");
    return v;
  };
  // IPv6 switched off at boot (ipv6.disable=1) is a host without IPv6 tables,
  // not a failed read.
  const v6 = existsSync("/proc/net/if_inet6");
  let links = [];
  try { links = run(["-d", "link"]); } catch { /* the name list still applies */ }
  return parseKernelTables({
    local4: run(["route", "show", "table", "local"]), local6: v6 ? run(["-6", "route", "show", "table", "local"]) : null,
    main4: run(["route"]), main6: v6 ? run(["-6", "route"]) : null, links,
  });
}

/** Device kinds that carry containers/VMs on this host. Not tun (VPNs such as the tailnet) or wireguard. */
const VIRTUAL_KINDS = new Set(["bridge", "veth", "vxlan", "geneve", "macvlan", "ipvlan", "macvtap"]);
export function deviceKindIsVirtual(kind) { return VIRTUAL_KINDS.has(String(kind || "")); }

/**
 * Combine the raw `ip -j` outputs. Throws when the IPv4 local table is not
 * plausible (no `lo` entry), so an empty successful read cannot pass for a
 * host with no addresses.
 */
export function parseKernelTables({ local4, local6, main4, main6, links }) {
  if (!Array.isArray(local4) || !local4.some((r) => r && r.dev === "lo")) throw new Error("kernel local table has no lo entry");
  const virtualDevs = new Set();
  for (const l of links || []) {
    const kind = l && l.linkinfo && l.linkinfo.info_kind;
    if (l && l.ifname && deviceKindIsVirtual(kind)) virtualDevs.add(l.ifname);
  }
  return { local: [...local4, ...(local6 || [])], main: [...(main4 || []), ...(main6 || [])], virtualDevs };
}

/** Kernel tables are cached briefly (interfaces come and go; a spawn makes many decisions). */
const ROUTES_TTL_MS = 5000;
let routesCache = null; // { at, value } | { at, error }
function cachedKernelRoutes() {
  const now = Date.now();
  if (!routesCache || now - routesCache.at > ROUTES_TTL_MS) {
    try { routesCache = { at: now, value: readKernelRoutes() }; } catch (e) { routesCache = { at: now, error: e }; }
  }
  if (routesCache.error) throw routesCache.error;
  return routesCache.value;
}
/** Test seam. */
export function _resetRoutesCacheForTest() { routesCache = null; }

/** Defaults refused by name when the kernel tables cannot be read (docker0, libvirt's default). */
const FALLBACK_BRIDGES_V4 = [["172.17.0.0", 16], ["192.168.122.0", 24]];

/**
 * This host's view: own addresses, virtual-bridge subnets, broadcasts.
 * Sources: the kernel route tables (o.routes seam), then
 * os.networkInterfaces() (o.interfaces seam) as an extra, then o.hostAddrs.
 * `failed` when either source cannot be read: the caller refuses every
 * private target then.
 */
function localView(o = {}) {
  const addrs = new Set(), bcast = new Set();
  const nets4 = new BlockList(), nets6 = new BlockList();
  let failed = false;
  const addAddr = (a) => { const x = String(a || "").split("%")[0]; if (isIP(x)) addrs.add(isIP(x) === 6 ? key6(x) : x); };
  // A dst is an address or address/prefix; `ip -j route` prints host routes
  // without the /32 or /128. Returns false for a shape it does not know.
  const addNet = (cidr) => {
    const parts = String(cidr || "").split("/");
    if (parts.length > 2) return false;
    const [net, plen] = parts;
    const fam = isIP(net);
    if (!fam) return false;
    if (plen !== undefined && !/^\d+$/.test(plen)) return false;
    const len = plen === undefined ? (fam === 4 ? 32 : 128) : Number(plen);
    if (len > (fam === 4 ? 32 : 128)) return false;
    try { (fam === 4 ? nets4 : nets6).addSubnet(net, len, fam === 4 ? "ipv4" : "ipv6"); } catch { return false; }
    return true;
  };
  // 1. kernel tables
  try {
    const t = (o.routes || cachedKernelRoutes)();
    for (const r of t.local || []) {
      const dst = String(r.dst || "");
      if (r.type === "local" || r.type === "anycast") {
        // a CIDR here (local 10.0.0.0/8) is a whole subnet this host owns
        if (dst.includes("/")) { if (!addNet(dst)) failed = true; }
        else if (isIP(dst.split("%")[0])) addAddr(dst);
        else failed = true;
      } else if (r.type === "broadcast") {
        if (isIP(dst) === 4) bcast.add(dst); else failed = true;
      }
    }
    for (const r of t.main || []) {
      const dev = String(r.dev || "");
      if (r.dst && r.dst !== "default" && (VIRTUAL_IF.test(dev) || (t.virtualDevs && t.virtualDevs.has(dev)))) addNet(r.dst);
    }
  } catch {
    failed = true;
    for (const [a, p] of FALLBACK_BRIDGES_V4) nets4.addSubnet(a, p, "ipv4");
  }
  // 2. interfaces (extra source; also covers a kernel table read in a namespace that hides some)
  try {
    const ifs = (o.interfaces || networkInterfaces)();
    for (const [name, list] of Object.entries(ifs || {})) {
      for (const i of list || []) {
        const addr = String(i.address || "").split("%")[0];
        if (!isIP(addr)) continue;
        addAddr(addr);
        const plen = Number(String(i.cidr || "").split("/")[1]);
        if (!Number.isInteger(plen)) continue;
        if (VIRTUAL_IF.test(name)) addNet(addr + "/" + plen);
        if (isIP(addr) === 4 && plen < 31) {
          const mask = plen === 0 ? 0 : (0xffffffff << (32 - plen)) >>> 0;
          bcast.add(intV4(((v4Int(addr) & mask) | (~mask >>> 0)) >>> 0));
        }
      }
    }
  } catch { failed = true; }
  // 3. explicit own addresses, honoured on every path
  for (const a of o.hostAddrs || []) addAddr(a);
  return { addrs, bcast, nets4, nets6, failed };
}

function v4Reason(a, L) {
  const o = a.split(".").map(Number);
  if (o[0] === 127 || o[0] === 0) return "loopback (use the bot's loopback ports)";
  if (PLUMBING_V4.check(a, "ipv4")) return "cloud metadata / host plumbing";
  if (o[0] >= 224) return "not unicast";
  if (L.addrs.has(a)) return "this host's own address";
  if (L.nets4.check(a, "ipv4")) return "a container/VM bridge on this host";
  if (L.bcast.has(a)) return "a local subnet broadcast";
  if (L.failed && PRIVATE_V4.check(a, "ipv4")) return "private target refused: this host's addresses cannot be determined";
  return null;
}

/**
 * null when the relay may connect to `addr`, else the reason it may not.
 * o.interfaces: networkInterfaces-shaped seam; o.hostAddrs: extra own addresses.
 */
export function egressDenyReason(addr, o = {}) {
  const a = String(addr || "").replace(/^\[|\]$/g, "").split("%")[0];
  const fam = isIP(a);
  if (!fam) return "not an IP address";
  const L = o.view || localView(o);
  if (fam === 4) return v4Reason(a, L);
  const h = expand6(a);
  const zero = (x, y) => h.slice(x, y).every((v) => v === 0);
  if (zero(0, 8) || (zero(0, 7) && h[7] === 1)) return "loopback (use the bot's loopback ports)";
  if (h[0] >= 0xff00) return "not unicast";
  if ((h[0] === 0xfd00 && h[1] === 0xec2 && zero(2, 4)) || key6(a) === key6("fd20:ce::254") || key6(a) === key6("fd7a:115c:a1e0::53")) {
    return "cloud metadata / host plumbing";
  }
  // IPv4 inside IPv6: every prefix known to embed an IPv4 address is judged
  // by that address, or refused when the embedding cannot be read reliably.
  if (zero(0, 5) && (h[5] === 0xffff || h[5] === 0)) return v4Reason(v4From(h[6], h[7]), L);       // ::ffff:a.b.c.d, ::a.b.c.d
  if (zero(0, 4) && h[4] === 0xffff && h[5] === 0) return v4Reason(v4From(h[6], h[7]), L);        // SIIT ::ffff:0:a.b.c.d
  if (h[0] === 0x64 && h[1] === 0xff9b && zero(2, 6)) return v4Reason(v4From(h[6], h[7]), L);      // NAT64 64:ff9b::/96
  if (h[0] === 0x64 && h[1] === 0xff9b && h[2] === 1) return "NAT64 local-use prefix (embedded IPv4 not reliably readable)";
  if (h[0] === 0x2002) return v4Reason(v4From(h[1], h[2]), L);                                    // 6to4
  if (h[0] === 0x2001 && h[1] === 0) {                                                            // Teredo: server, and client XOR ffff:ffff
    return v4Reason(v4From(h[2], h[3]), L) || v4Reason(v4From(h[6] ^ 0xffff, h[7] ^ 0xffff), L);
  }
  if (h[0] === 0x100 && zero(1, 4)) return "discard-only prefix (100::/64)";
  const isPrivate6 = (h[0] & 0xfe00) === 0xfc00 || (h[0] & 0xffc0) === 0xfe80;
  if (L.addrs.has(key6(a))) return "this host's own address";
  if (L.nets6.check(a, "ipv6")) return "a container/VM bridge on this host";
  if (L.failed && isPrivate6) return "private target refused: this host's addresses cannot be determined";
  return null;
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
 * @param {number[]} o.loopbackPorts
 * @param {string[]|null} o.egressAllow
 * @param {number[]} [o.egressPorts=[443,80]]
 * @param {number} [o.maxConns=64]
 * @param {number} [o.headTimeoutMs=10000]
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
  const loopback = new Set((o.loopbackPorts || []).map(Number).filter((p) => p > 0 && p < 65536));
  // CONNECT is for TLS; plain http:// needs an absolute-form GET, which this
  // relay does not proxy. 443 by default.
  const ports = new Set((o.egressPorts || [443]).map(Number));
  const allow = Array.isArray(o.egressAllow) ? o.egressAllow : null;
  const local = { interfaces: o.interfaces, routes: o.routes, hostAddrs: o.hostAddrs };
  const maxConns = o.maxConns ?? 64;
  const headTimeoutMs = o.headTimeoutMs ?? 10000;
  const lookup = o.lookup || ((h) => dnsLookup(h, { all: true, verbatim: true }));
  const log = o.log || ((l) => console.error(l));
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
  const sockets = new Set();

  /**
   * Splice client <-> upstream. Candidates are already-checked addresses,
   * tried in order (dual-stack hosts whose first address has no route). Ends
   * are propagated gracefully (half-close kept); each side is destroyed only
   * on error or once both directions are done.
   */
  const splice = (client, candidates, port, preface) => {
    let i = 0;
    const tryNext = () => {
      if (client.destroyed) return;
      const addr = candidates[i++];
      const target = o._connectOverride ? o._connectOverride(addr, port) : { host: addr, port, allowHalfOpen: true };
      const up = netConnect({ ...target, allowHalfOpen: true });
      sockets.add(up);
      up.once("close", () => sockets.delete(up));
      let connected = false;
      up.once("connect", () => {
        connected = true;
        if (client.destroyed) { up.destroy(); return; }
        if (preface) client.write(preface);
        client.pipe(up); up.pipe(client);
      });
      up.on("error", () => {
        if (!connected && i < candidates.length && !client.destroyed) { up.destroy(); tryNext(); return; }
        if (!connected && preface) { try { client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"); } catch {} }
        else { try { client.destroy(); } catch {} }
        up.destroy();
      });
      client.on("error", () => { try { up.destroy(); } catch {} });
      client.once("close", () => { if (!up.destroyed) up.end(); setTimeout(() => up.destroy(), 30000).unref(); });
      up.once("close", () => { if (connected && !client.destroyed) { client.end(); setTimeout(() => client.destroy(), 30000).unref(); } });
    };
    tryNext();
  };

  const refuse = (c, status, text) => { try { c.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`); } catch {} };

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
          if (!loopback.has(port)) { note("deny", "127.0.0.1:" + port, "loopback port not allowed"); c.destroy(); return; }
          note("allow", "127.0.0.1:" + port);
          // Paused until splice() pipes it (pipe resumes); bytes that came
          // with the header line go back on the stream first.
          c.pause();
          if (buf.length) c.unshift(buf);
          splice(c, ["127.0.0.1"], port, null);
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
