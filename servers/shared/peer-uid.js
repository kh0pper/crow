/**
 * Which local uid owns the far end of a loopback TCP connection?
 *
 * Tailscale Serve and Funnel reach the gateway from 127.0.0.1, and so does
 * every other process on the box (a bot shell runs as the gateway's own uid).
 * The headers Serve writes (X-Forwarded-For, X-Forwarded-Host,
 * Tailscale-User-Login) are therefore only meaningful when the connection was
 * opened by tailscaled. On Linux the kernel says who opened it: the client-side
 * row of the same connection in /proc/net/tcp (or tcp6) carries the owning uid.
 *
 *   - The CLIENT-side row is the one whose local address is our socket's remote
 *     end. The server-side row of the same connection carries the gateway's
 *     uid, so the direction matters.
 *   - Only ESTABLISHED rows (state 01) count: TIME_WAIT rows are orphans owned
 *     by uid 0, and a reused tuple must never pick one of those up.
 *   - The answer is memoised per socket object (never per address or port):
 *     the uid of a connection cannot change during its life.
 *
 * CROW_SERVE_PEER_UIDS: comma list of numeric uids tailscaled runs as
 * (default "0"). FAIL CLOSED: when the owner cannot be verified (no
 * /proc/net/tcp, a read error, the row not found), the request is NOT treated
 * as Serve or Funnel; it falls through to the plain peer-address rules. Hosts
 * without procfs (macOS, Windows native) that want Serve's headers honoured
 * opt in explicitly with CROW_SERVE_PEER_UIDS=off (shape-only), which logs a
 * one-time warning.
 *
 * Node built-ins only. Imported by bundles through the app root.
 */
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { parseIPv6 } from "./ip-classify.js";

const READER = Symbol.for("crow.peer-uid.reader");
const memo = new WeakMap();
const warned = new Set();

export function warnOnce(key, msg) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(msg);
}

/** Tests only: forget which warnings were already printed. */
export function resetPeerWarningsForTests() { warned.clear(); }

/** Tests only: install (fn(name) → text, where name is "tcp" or "tcp6") or clear (null) the procfs reader. */
export function setProcNetReaderForTests(fn) {
  if (typeof fn === "function") globalThis[READER] = fn;
  else delete globalThis[READER];
}

function readTable(name) {
  const override = globalThis[READER];
  if (typeof override === "function") return override(name);
  return readFileSync(`/proc/net/${name}`, "utf8");
}

const hex2 = (n) => n.toString(16).padStart(2, "0");

/** "a.b.c.d" → the /proc/net/tcp spelling (the u32 in host order, little-endian). */
export function procV4Hex(addr) {
  const p = addr.split(".").map(Number);
  return [p[3], p[2], p[1], p[0]].map(hex2).join("").toUpperCase();
}

/** IPv6 literal → the /proc/net/tcp6 spelling (four u32 words, each little-endian). */
export function procV6Hex(addr) {
  const g = parseIPv6(addr);
  if (!g) return null;
  const bytes = g.flatMap((x) => [x >> 8, x & 0xff]);
  let out = "";
  for (let w = 0; w < 4; w++) out += [bytes[4 * w + 3], bytes[4 * w + 2], bytes[4 * w + 1], bytes[4 * w]].map(hex2).join("");
  return out.toUpperCase();
}

const portHex = (p) => p.toString(16).padStart(4, "0").toUpperCase();

/** The v4 address embedded in a v4-mapped IPv6 spelling, or null. */
function mappedV4(addr) {
  const g = parseIPv6(addr);
  if (!g || !g.slice(0, 5).every((x) => x === 0) || g[5] !== 0xffff) return null;
  return [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff].join(".");
}

/** Where to look for the client-side row: [{ table, local, rem }]. */
function candidates(ra, rp, la, lp) {
  const out = [];
  const fam = isIP(ra);
  if (fam === 4 && isIP(la) === 4) {
    out.push({ table: "tcp", local: `${procV4Hex(ra)}:${portHex(rp)}`, rem: `${procV4Hex(la)}:${portHex(lp)}` });
  } else if (fam === 6) {
    const r4 = mappedV4(ra), l4 = mappedV4(la);
    // A dual-stack listener sees an IPv4 client as ::ffff:a.b.c.d; the client's own row is in tcp.
    if (r4 && l4) out.push({ table: "tcp", local: `${procV4Hex(r4)}:${portHex(rp)}`, rem: `${procV4Hex(l4)}:${portHex(lp)}` });
    const rh = procV6Hex(ra), lh = procV6Hex(la);
    if (rh && lh) out.push({ table: "tcp6", local: `${rh}:${portHex(rp)}`, rem: `${lh}:${portHex(lp)}` });
  }
  return out;
}

function lookup(socket) {
  const ra = String(socket.remoteAddress || ""), la = String(socket.localAddress || "");
  const rp = socket.remotePort, lp = socket.localPort;
  if (!ra || !la || !Number.isInteger(rp) || !Number.isInteger(lp)) return { uid: null, unavailable: false };
  const want = candidates(ra, rp, la, lp);
  if (!want.length) return { uid: null, unavailable: false };
  let failed = 0;
  for (const { table, local, rem } of want) {
    let text;
    try { text = readTable(table); } catch { failed++; continue; }
    const hits = [];
    for (const line of String(text).split("\n")) {
      const f = line.trim().split(/\s+/);
      if (f.length < 8 || !/^\d+:$/.test(f[0])) continue; // header or junk
      if (f[1].toUpperCase() === local && f[2].toUpperCase() === rem && f[3] === "01") hits.push(f);
    }
    if (hits.length === 1 && /^\d+$/.test(hits[0][7])) return { uid: Number(hits[0][7]), unavailable: false };
    if (hits.length > 1) return { uid: null, unavailable: false }; // impossible for ESTABLISHED; refuse anyway
  }
  return { uid: null, unavailable: failed === want.length };
}

/** → { uid: number|null, unavailable: boolean }; memoised per socket object. */
export function peerUid(socket) {
  if (!socket || typeof socket !== "object") return { uid: null, unavailable: false };
  const hit = memo.get(socket);
  if (hit) return hit;
  const r = lookup(socket);
  memo.set(socket, r);
  return r;
}

let uidCache = { set: false, raw: undefined, val: [0] };

/** CROW_SERVE_PEER_UIDS → array of numeric uids (default [0]), or null for "off". */
export function servePeerUids(env = process.env) {
  const raw = env.CROW_SERVE_PEER_UIDS;
  if (uidCache.set && uidCache.raw === raw) return uidCache.val;
  let val;
  const s = String(raw ?? "").trim();
  if (!s) val = [0];
  else if (s.toLowerCase() === "off") val = null;
  else {
    val = [];
    for (const e of s.split(",").map((x) => x.trim()).filter(Boolean)) {
      if (/^\d+$/.test(e)) val.push(Number(e));
      else warnOnce(`uid-entry:${e}`, `[net] WARN CROW_SERVE_PEER_UIDS entry "${e}" is not a numeric uid: skipped`);
    }
  }
  if (val && typeof process.getuid === "function" && val.includes(process.getuid())) {
    warnOnce(`uid-self:${s}`, `[net] WARN CROW_SERVE_PEER_UIDS includes the gateway's own uid (${process.getuid()}): processes running as the gateway's user can forge tailnet identity`);
  }
  uidCache = { set: true, raw, val };
  return val;
}

/** May this loopback socket speak for Serve/Funnel? → { ok, uid }. Fails closed. */
export function servePeerVerified(socket) {
  const uids = servePeerUids();
  if (uids === null) {
    warnOnce("uid-check-off", "[net] WARN CROW_SERVE_PEER_UIDS=off: Serve/Funnel headers are accepted on their shape alone, without verifying the socket owner; local processes can forge tailnet identity");
    return { ok: true, uid: null };
  }
  const r = peerUid(socket);
  if (r.unavailable) {
    warnOnce("no-procfs", "[net] WARN cannot verify the Serve peer's uid (/proc/net/tcp unreadable): Serve/Funnel-shaped requests are treated as unverified. On a host without procfs, set CROW_SERVE_PEER_UIDS=off to accept Serve's headers on their shape alone");
  }
  return { ok: r.uid !== null && uids.includes(r.uid), uid: r.uid };
}
