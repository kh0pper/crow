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
import { createServer, connect as netConnect, isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { lookup as dnsLookup } from "node:dns/promises";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

// Default egress (Kevin, D4 2026-10-26: "public and private"): public and
// private (LAN, tailnet, ULA, link-local) destinations are allowed; a bot's
// `egress` list narrows. Always refused, because they are not a destination
// class but a way around another control:
//   - loopback (127/8, 0/8, ::, ::1): host loopback is governed by the
//     PORT allowlist; reaching it through the proxy would skip that list;
//   - this host's own interface addresses (its LAN/tailnet IPs): the same,
//     for every service bound to 0.0.0.0 here;
//   - cloud metadata endpoints (instance credentials);
//   - multicast/reserved (not unicast; nothing to CONNECT to).
// IPv4 embedded in IPv6 (v4-mapped, v4-compatible, NAT64 64:ff9b::/96,
// 6to4 2002::/16) is unwrapped and judged as the IPv4 address.
const METADATA_V4 = new Set(["169.254.169.254", "169.254.170.2", "100.100.100.200"]);
const METADATA_V6 = new Set(["fd00:ec2:0:0:0:0:0:254"]);

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
const v4From = (hi, lo) => [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");

function v4Reason(a, host) {
  const o = a.split(".").map(Number);
  if (METADATA_V4.has(a)) return "cloud metadata endpoint";
  if (host.has(a)) return "this host's own address";
  if (o[0] === 127 || o[0] === 0) return "loopback (use the bot's loopback ports)";
  if (o[0] >= 224) return "not unicast";
  return null;
}

/** null when the relay may connect to `addr`, else the reason it may not. */
export function egressDenyReason(addr, { hostAddrs = [] } = {}) {
  const a = String(addr || "").replace(/^\[|\]$/g, "");
  const fam = isIP(a);
  if (!fam) return "not an IP address";
  const host = new Set(hostAddrs.map((x) => (isIP(x) === 6 ? expand6(x).join(":") : x)));
  if (fam === 4) return v4Reason(a, host);
  const h = expand6(a);
  const key = h.join(":");
  if (h.every((x) => x === 0) || (h.slice(0, 7).every((x) => x === 0) && h[7] === 1)) return "loopback (use the bot's loopback ports)";
  if (METADATA_V6.has(h.map((x) => x.toString(16)).join(":"))) return "cloud metadata endpoint";
  if (host.has(key)) return "this host's own address";
  if (h[0] >= 0xff00) return "not unicast";
  // IPv4 inside IPv6
  if (h.slice(0, 5).every((x) => x === 0) && (h[5] === 0xffff || h[5] === 0)) return v4Reason(v4From(h[6], h[7]), host);
  if (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((x) => x === 0)) return v4Reason(v4From(h[6], h[7]), host);
  if (h[0] === 0x2002) return v4Reason(v4From(h[1], h[2]), host);
  return null;
}

/** This host's interface addresses (refused as egress targets). */
export function hostInterfaceAddresses() {
  try { return Object.values(networkInterfaces()).flat().filter(Boolean).map((i) => i.address); } catch { return []; }
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
  const hostAddrs = o.hostAddrs || hostInterfaceAddresses();
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
    const why = addrs.length ? addrs.map((a) => egressDenyReason(a.address, { hostAddrs })).find(Boolean) : "no address";
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
