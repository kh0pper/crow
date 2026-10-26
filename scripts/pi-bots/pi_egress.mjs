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
 *               CONNECT; ports from egressPorts (default 443, 80); the host
 *               must resolve ONLY to public addresses (every address checked,
 *               the checked one connected: no DNS rebinding); IP literals the
 *               same; an `egress` list (exact or *.suffix) narrows further.
 *
 * Every decision is logged once per (decision, host:port) per spawn,
 * `[pi-egress] bot=<id> allow|deny <host>:<port> (<reason>)`. A per-spawn
 * connection cap bounds what one bot can open.
 */
import { createServer, connect as netConnect, isIP, BlockList } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

// Separate lists: a BlockList also matches IPv4 addresses against IPv4-mapped
// IPv6 rules, so ::ffff:0:0/96 in one shared list would block all of IPv4.
const NON_PUBLIC_V4 = new BlockList();
const NON_PUBLIC_V6 = new BlockList();
for (const [a, p] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]]) NON_PUBLIC_V4.addSubnet(a, p, "ipv4");
for (const [a, p] of [["::", 96] /* :: , ::1, v4-compatible */, ["::ffff:0:0", 96] /* v4-mapped */, ["64:ff9b::", 96],
  ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10],
  ["ff00::", 8]]) NON_PUBLIC_V6.addSubnet(a, p, "ipv6");

/** True only for a globally routable unicast address. */
export function isPublicAddress(addr) {
  const a = String(addr || "").replace(/^\[|\]$/g, "");
  const fam = isIP(a);
  if (!fam) return false;
  return fam === 4 ? !NON_PUBLIC_V4.check(a, "ipv4") : !NON_PUBLIC_V6.check(a, "ipv6");
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
  const ports = new Set((o.egressPorts || [443, 80]).map(Number));
  const allow = Array.isArray(o.egressAllow) ? o.egressAllow : null;
  const maxConns = o.maxConns ?? 64;
  const headTimeoutMs = o.headTimeoutMs ?? 10000;
  const lookup = o.lookup || ((h) => dnsLookup(h, { all: true, verbatim: true }));
  const log = o.log || ((l) => console.error(l));
  const logged = new Set();
  const note = (decision, target, reason) => {
    const key = decision + " " + target;
    if (logged.has(key)) return;
    logged.add(key);
    log(`[pi-egress] bot=${o.botId || "?"} ${decision} ${target}${reason ? " (" + reason + ")" : ""}`);
  };
  let live = 0;
  const sockets = new Set();

  const splice = (client, host, port, preface) => {
    const target = o._connectOverride ? o._connectOverride(host, port) : { host, port };
    const up = netConnect(target);
    sockets.add(up);
    up.on("connect", () => {
      if (preface) client.write(preface);
      client.pipe(up); up.pipe(client);
    });
    const end = () => { try { client.destroy(); } catch {} try { up.destroy(); } catch {} };
    up.on("error", () => { if (preface) { try { client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"); } catch {} } end(); });
    up.on("close", end); client.on("close", end); client.on("error", end);
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
    if (!addrs.length || addrs.some((a) => !isPublicAddress(a.address))) {
      note("deny", target, "resolves to a non-public address");
      return refuse(c, 403, "Forbidden");
    }
    note("allow", target);
    splice(c, addrs[0].address, port, "HTTP/1.1 200 Connection Established\r\n\r\n");
  }

  const server = createServer((c) => {
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
          splice(c, "127.0.0.1", port, null);
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
  const ready = new Promise((resolve, reject) => {
    server.once("error", (e) => { log(`[pi-egress] bot=${o.botId || "?"} relay failed to listen: ${e.message}`); reject(e); });
    server.listen(socketPath, () => { try { chmodSync(socketPath, 0o600); } catch {} resolve(); });
  });
  ready.catch(() => {});
  return {
    dir, socketPath, ready,
    close: () => new Promise((resolve) => {
      for (const s of sockets) { try { s.destroy(); } catch {} }
      server.close(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} resolve(); });
    }),
  };
}
