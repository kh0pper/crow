import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import {
  classifyPeer, isOverlayAddr, isPublicAddr, trustedProxyList, isTrustedProxy, resolveClientMiddleware, OVERLAY_RANGES,
} from "../servers/shared/peer-class.js";
import {
  peerUid, servePeerUids, setProcNetReaderForTests, resetPeerWarningsForTests, procV4Hex, procV6Hex,
} from "../servers/shared/peer-uid.js";

// ---- procfs fixtures ------------------------------------------------------
const HEADER = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
const port = (p) => p.toString(16).padStart(4, "0").toUpperCase();
const row = (i, local, rem, st, uid) => `   ${i}: ${local} ${rem} ${st} 00000000:00000000 00:00000000 00000000 ${String(uid).padStart(5)}        0 ${1000 + i} 1 0000000000000000 20 4 30 10 -1`;
const v4 = (a, p) => `${procV4Hex(a)}:${port(p)}`;
const v6 = (a, p) => `${procV6Hex(a)}:${port(p)}`;

/** A /proc/net/tcp with the client-side row (uid `clientUid`, state `st`) and the server-side row (uid 1000). */
function tcpTable({ client = ["127.0.0.1", 40000], server = ["127.0.0.1", 3001], clientUid = 0, st = "01", serverRow = true } = {}) {
  const rows = [HEADER, row(0, v4(...client), v4(...server), st, clientUid)];
  if (serverRow) rows.push(row(1, v4(...server), v4(...client), "01", 1000));
  return rows.join("\n") + "\n";
}

const SOCK = (over = {}) => ({ remoteAddress: "127.0.0.1", remotePort: 40000, localAddress: "127.0.0.1", localPort: 3001, ...over });
const SERVE = (xff = "100.64.20.5", extra = {}) => ({ "x-forwarded-for": xff, "x-forwarded-host": "crow.example.ts.net:8444", "x-forwarded-proto": "https", ...extra });
const mk = (headers = {}, socket = SOCK()) => ({ headers, socket });

let reads;
function useTables(tables) {
  reads = 0;
  setProcNetReaderForTests((name) => {
    reads++;
    if (!(name in tables)) { const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; }
    return tables[name];
  });
}

const ENV_KEYS = ["CROW_SERVE_PEER_UIDS", "CROW_TRUSTED_PROXIES", "CROW_ALLOWED_IPS", "CROW_DASHBOARD_PUBLIC"];
let saved;
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  resetPeerWarningsForTests();
  useTables({ tcp: tcpTable(), tcp6: HEADER + "\n" });
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  setProcNetReaderForTests(null);
});

function spyWarn(fn) {
  const orig = console.warn;
  const lines = [];
  console.warn = (...a) => lines.push(a.join(" "));
  try { fn(); } finally { console.warn = orig; }
  return lines;
}

// ---- address helpers ------------------------------------------------------
test("overlay ranges: the IPv4 CGNAT block and the Tailscale IPv6 ULA /48 (also v4-mapped)", () => {
  assert.deepEqual([...OVERLAY_RANGES], ["100.64.0.0/10", "fd7a:115c:a1e0::/48"]);
  for (const a of ["100.64.0.1", "100.127.255.255", "::ffff:100.64.20.5", "fd7a:115c:a1e0::1", "FD7A:115C:A1E0:ab12::9"]) assert.ok(isOverlayAddr(a), a);
  for (const a of ["100.63.255.255", "100.128.0.0", "10.0.0.9", "fd7a:115c:a1e1::1", "fd00::1", "127.0.0.1", "", "junk"]) assert.ok(!isOverlayAddr(a), a);
});

test("public addresses: loopback, RFC1918, overlay, link-local, CGNAT, ULA, documentation and multicast are not public", () => {
  for (const a of ["8.8.8.8", "1.1.1.1", "2606:4700::1111"]) assert.ok(isPublicAddr(a), a);
  for (const a of ["127.0.0.1", "10.0.0.9", "192.168.1.5", "100.101.102.103", "fd7a:115c:a1e0::1", "169.254.1.1", "::1", "198.51.100.7", "203.0.113.7", "224.0.0.1", "0.0.0.0", "fc00::1", "garbage", ""]) assert.ok(!isPublicAddr(a), a);
});

// ---- the classifier ------------------------------------------------------
test("local: a bare loopback request with no forwarding or tailscale headers; procfs never read", () => {
  const p = classifyPeer(mk({ host: "localhost:3001" }));
  assert.equal(p.via, "local");
  assert.equal(p.client, "127.0.0.1");
  assert.equal(reads, 0);
});

test("serve: loopback + one overlay XFF + X-Forwarded-Host + client row owned by uid 0", () => {
  const p = classifyPeer(mk(SERVE("100.64.20.5", { "tailscale-user-login": "alex@example.com" })));
  assert.equal(p.via, "serve");
  assert.equal(p.client, "100.64.20.5");
  assert.equal(p.tailnetLogin, "alex@example.com");
  assert.equal(p.peerUid, 0);
});

test("serve: a tagged node (no login) and an IPv6 tailnet client are still serve", () => {
  assert.equal(classifyPeer(mk(SERVE())).via, "serve");
  assert.equal(classifyPeer(mk(SERVE())).tailnetLogin, null);
  const p6 = classifyPeer(mk(SERVE("fd7a:115c:a1e0::1")));
  assert.equal(p6.via, "serve");
  assert.equal(p6.client, "fd7a:115c:a1e0::1");
});

test("serve shape broken → unverified: two XFF values, no X-Forwarded-Host, a non-overlay XFF", () => {
  assert.equal(classifyPeer(mk(SERVE("100.64.20.5, 100.64.20.6"))).via, "unverified");
  const noHost = SERVE(); delete noHost["x-forwarded-host"];
  assert.equal(classifyPeer(mk(noHost)).via, "unverified");
  assert.equal(classifyPeer(mk(SERVE("10.0.0.9"))).via, "unverified");
});

test("lane A (b): a forged XFF from loopback with no declared proxy is unverified and its client is the socket", () => {
  const p = classifyPeer(mk({ "x-forwarded-for": "10.0.0.9" }));
  assert.equal(p.via, "unverified");
  assert.equal(p.client, "127.0.0.1");
});

test("socket owner: a Serve shape whose client row belongs to the gateway's uid is unverified (the bot case)", () => {
  useTables({ tcp: tcpTable({ clientUid: 1000 }) });
  const lines = spyWarn(() => {
    const p = classifyPeer(mk(SERVE("100.64.20.5", { "tailscale-user-login": "owner@example.com" })));
    assert.equal(p.via, "unverified");
    assert.equal(p.tailnetLogin, null);
    assert.equal(p.client, "127.0.0.1");
    assert.equal(p.peerUid, 1000);
  });
  assert.equal(lines.filter((l) => l.includes("Serve-shaped request from uid 1000")).length, 1);
});

test("socket owner: a Funnel shape from the wrong uid is unverified", () => {
  useTables({ tcp: tcpTable({ clientUid: 1000 }) });
  spyWarn(() => assert.equal(classifyPeer(mk({ "tailscale-funnel-request": "?1", "x-forwarded-for": "8.8.8.8", "x-forwarded-host": "crow.example.ts.net" })).via, "unverified"));
});

test("socket owner: the CLIENT-side row is the one read, not the server-side row of the same connection", () => {
  // Only the two mirrored rows exist: client side uid 0, server side uid 1000.
  useTables({ tcp: tcpTable({ clientUid: 0 }) });
  assert.equal(classifyPeer(mk(SERVE())).via, "serve");
  // Swap: the row matching our socket's remote end as LOCAL is uid 1000 → refused.
  useTables({ tcp: [HEADER, row(0, v4("127.0.0.1", 40000), v4("127.0.0.1", 3001), "01", 1000), row(1, v4("127.0.0.1", 3001), v4("127.0.0.1", 40000), "01", 0)].join("\n") });
  spyWarn(() => assert.equal(classifyPeer(mk(SERVE(), SOCK({ remotePort: 40000 }))).via, "unverified"));
});

test("socket owner: a matching tuple only in TIME_WAIT (state 06, uid 0) does not count", () => {
  useTables({ tcp: tcpTable({ st: "06", serverRow: false }) });
  spyWarn(() => assert.equal(classifyPeer(mk(SERVE())).via, "unverified"));
});

test("socket owner: a v4-mapped socket address finds the client's IPv4 row, or its tcp6 row", () => {
  const sock = SOCK({ remoteAddress: "::ffff:127.0.0.1", localAddress: "::ffff:127.0.0.1" });
  assert.equal(classifyPeer(mk(SERVE(), sock)).via, "serve");
  useTables({ tcp: HEADER + "\n", tcp6: [HEADER, row(0, v6("::ffff:127.0.0.1", 40000), v6("::ffff:127.0.0.1", 3001), "01", 0)].join("\n") });
  assert.equal(classifyPeer(mk(SERVE(), { ...sock })).via, "serve");
  // ::1 is looked up in tcp6
  useTables({ tcp6: [HEADER, row(0, v6("::1", 40001), v6("::1", 3001), "01", 0)].join("\n") });
  assert.equal(classifyPeer(mk(SERVE(), SOCK({ remoteAddress: "::1", localAddress: "::1", remotePort: 40001 }))).via, "serve");
  assert.equal(procV6Hex("::1"), "00000000000000000000000001000000");
  assert.equal(procV6Hex("::ffff:127.0.0.1"), "0000000000000000FFFF00000100007F");
});

test("fail closed: procfs unreadable → unverified (no Tailscale-* trust), with ONE warning naming the opt-in", () => {
  useTables({});
  const lines = spyWarn(() => {
    const p = classifyPeer(mk(SERVE("100.64.20.5", { "tailscale-user-login": "owner@example.com" })));
    assert.equal(p.via, "unverified");
    assert.equal(p.tailnetLogin, null);
    assert.equal(p.client, "127.0.0.1");
    assert.equal(classifyPeer(mk(SERVE(), SOCK({ remotePort: 40002 }))).via, "unverified");
    assert.equal(classifyPeer(mk({ "tailscale-funnel-request": "?1", "x-forwarded-for": "8.8.8.8" }, SOCK({ remotePort: 40004 }))).via, "unverified");
  });
  assert.equal(lines.filter((l) => l.includes("cannot verify the Serve peer's uid")).length, 1);
  assert.ok(lines.some((l) => l.includes("CROW_SERVE_PEER_UIDS=off")));
});

test("fail closed: a read error (EACCES) or a missing row → unverified", () => {
  setProcNetReaderForTests(() => { const e = new Error("EACCES"); e.code = "EACCES"; throw e; });
  spyWarn(() => assert.equal(classifyPeer(mk(SERVE())).via, "unverified"));
  useTables({ tcp: HEADER + "\n", tcp6: HEADER + "\n" }); // readable, but the connection is gone (race)
  spyWarn(() => assert.equal(classifyPeer(mk(SERVE(), SOCK({ remotePort: 40005 }))).via, "unverified"));
});

test("explicit opt-in CROW_SERVE_PEER_UIDS=off: shape-only Serve accepted, with ONE warning", () => {
  process.env.CROW_SERVE_PEER_UIDS = "off";
  useTables({});
  const lines = spyWarn(() => {
    assert.equal(classifyPeer(mk(SERVE("100.64.20.5", { "tailscale-user-login": "a@example.com" }))).via, "serve");
    assert.equal(classifyPeer(mk(SERVE(), SOCK({ remotePort: 40003 }))).via, "serve");
  });
  assert.equal(lines.filter((l) => l.includes("CROW_SERVE_PEER_UIDS=off")).length, 1);
  assert.equal(reads, 0, "procfs is not read when the check is off");
});

test("CROW_SERVE_PEER_UIDS parsing: list, a skipped non-numeric entry warned once", () => {
  process.env.CROW_SERVE_PEER_UIDS = "1000,0";
  assert.deepEqual(servePeerUids(), [1000, 0]);
  process.env.CROW_SERVE_PEER_UIDS = "0, tailscale ,";
  const lines = spyWarn(() => { assert.deepEqual(servePeerUids(), [0]); assert.deepEqual(servePeerUids({ CROW_SERVE_PEER_UIDS: "0, tailscale ," }), [0]); });
  assert.equal(lines.filter((l) => l.includes('"tailscale"')).length, 1);
  process.env.CROW_SERVE_PEER_UIDS = "off";
  assert.equal(servePeerUids(), null);
  delete process.env.CROW_SERVE_PEER_UIDS;
  assert.deepEqual(servePeerUids(), [0]);
});

test("memoised per socket: two lookups on one socket read procfs once; a new socket reads again", () => {
  const s = SOCK();
  peerUid(s); peerUid(s);
  assert.equal(reads, 1);
  peerUid(SOCK());
  assert.equal(reads, 2);
});

test("review risk 1: a row procfs repeated between read() chunks (same inode) still counts once", () => {
  const client = row(0, v4("127.0.0.1", 40000), v4("127.0.0.1", 3001), "01", 0);
  useTables({ tcp: [HEADER, client, client, row(1, v4("127.0.0.1", 3001), v4("127.0.0.1", 40000), "01", 1000)].join("\n") });
  assert.equal(classifyPeer(mk(SERVE())).via, "serve");
  // Two DIFFERENT live sockets on one tuple with different owners: refused.
  useTables({ tcp: [HEADER, row(0, v4("127.0.0.1", 40000), v4("127.0.0.1", 3001), "01", 0), row(7, v4("127.0.0.1", 40000), v4("127.0.0.1", 3001), "01", 1000)].join("\n") });
  spyWarn(() => assert.equal(classifyPeer(mk(SERVE(), SOCK())).via, "unverified"));
});

test("review risk 1: a row procfs skipped is found on the one re-read", () => {
  let n = 0;
  setProcNetReaderForTests((name) => (name === "tcp" ? (n++ === 0 ? HEADER + "\n" : tcpTable()) : HEADER + "\n"));
  assert.equal(classifyPeer(mk(SERVE())).via, "serve");
  assert.equal(n, 2);
});

test("review risk 1: a miss is never memoised — the same pooled socket is verified on its next request", () => {
  const s = SOCK();
  useTables({ tcp: HEADER + "\n", tcp6: HEADER + "\n" });
  spyWarn(() => assert.equal(classifyPeer(mk(SERVE(), s)).via, "unverified"));
  useTables({ tcp: tcpTable() });
  assert.equal(classifyPeer(mk(SERVE(), s)).via, "serve", "a later request on the same connection recovers");
  const before = reads;
  assert.equal(classifyPeer(mk(SERVE(), s)).via, "serve");
  assert.equal(reads, before, "a confirmed uid is memoised");
});

test("funnel: loopback + funnel header + one PUBLIC XFF → funnel, client = the public address, no login", () => {
  const p = classifyPeer(mk({ "tailscale-funnel-request": "?1", "x-forwarded-for": "8.8.8.8", "x-forwarded-host": "crow.example.ts.net", "tailscale-user-login": "forged@example.com" }));
  assert.equal(p.via, "funnel");
  assert.equal(p.client, "8.8.8.8");
  assert.equal(p.tailnetLogin, null);
});

test("review critical 4: a Funnel shape with a non-public XFF is unverified and keeps the socket as client", () => {
  for (const xff of ["127.0.0.1", "10.0.0.9", "192.168.1.5", "100.101.102.103", "fd7a:115c:a1e0::1", "169.254.1.1", "::1", "198.51.100.7"]) {
    const p = classifyPeer(mk({ "tailscale-funnel-request": "?1", "x-forwarded-for": xff }));
    assert.equal(p.via, "unverified", xff);
    assert.equal(p.client, "127.0.0.1", xff);
  }
});

test("direct: a non-loopback socket is the client whatever the headers say; tailscale headers carry nothing", () => {
  const p = classifyPeer(mk({ "x-forwarded-for": "10.0.0.9", "tailscale-user-login": "forged@example.com" }, { remoteAddress: "203.0.113.7" }));
  assert.equal(p.via, "direct");
  assert.equal(p.client, "203.0.113.7");
  assert.equal(p.tailnetLogin, null);
  assert.deepEqual(p.hops, ["10.0.0.9"]);
  assert.equal(reads, 0, "procfs is only read for loopback Serve/Funnel shapes");
});

test("declared proxy: CROW_TRUSTED_PROXIES=loopback → client is the rightmost undeclared XFF hop; login ignored", () => {
  process.env.CROW_TRUSTED_PROXIES = "loopback";
  const p = classifyPeer(mk({ "x-forwarded-for": "1.2.3.4, 10.0.0.9", "tailscale-user-login": "a@b" }));
  assert.equal(p.via, "proxy");
  assert.equal(p.client, "10.0.0.9");
  assert.equal(p.tailnetLogin, null);
  // Serve traffic on a box that declared loopback: still a proxy, identity not honoured.
  const s = classifyPeer(mk(SERVE("100.64.20.5", { "tailscale-user-login": "a@b" })));
  assert.equal(s.via, "proxy");
  assert.equal(s.client, "100.64.20.5");
  assert.equal(s.tailnetLogin, null);
});

test("declared bridge gateway (the household container behind docker-proxy): proxy with the Serve tailnet XFF as client", () => {
  process.env.CROW_TRUSTED_PROXIES = "172.18.0.1";
  const p = classifyPeer(mk({ "x-forwarded-for": "100.64.20.7", "x-forwarded-host": "crow.example.ts.net:8453" }, { remoteAddress: "::ffff:172.18.0.1" }));
  assert.equal(p.via, "proxy");
  assert.equal(p.client, "100.64.20.7");
});

test("§3.9 the r4 front door: a Serve shape whose client is a declared relay is serve, but its login is withheld", () => {
  process.env.CROW_TRUSTED_PROXIES = "100.64.20.9,fd7a:115c:a1e0::9";
  const p = classifyPeer(mk(SERVE("100.64.20.9", { "tailscale-user-login": "owner@example.com" })));
  assert.equal(p.via, "serve");
  assert.equal(p.client, "100.64.20.9");
  assert.equal(p.tailnetLogin, null);
  const p6 = classifyPeer(mk(SERVE("fd7a:115c:a1e0::9", { "tailscale-user-login": "owner@example.com" }), SOCK()));
  assert.equal(p6.tailnetLogin, null);
  const other = classifyPeer(mk(SERVE("100.64.20.5", { "tailscale-user-login": "alex@example.com" }), SOCK()));
  assert.equal(other.tailnetLogin, "alex@example.com", "another tailnet client keeps its login");
});

test("CROW_TRUSTED_PROXIES parsing: keywords, CIDRs and IPs kept; an invalid entry warned once and dropped", () => {
  const lines = spyWarn(() => {
    assert.deepEqual(trustedProxyList({ CROW_TRUSTED_PROXIES: " loopback, 172.18.0.1, 10.1.0.0/16, fd7a:115c:a1e0::9, nope, 10.0.0.0/40 " }), ["loopback", "172.18.0.1", "10.1.0.0/16", "fd7a:115c:a1e0::9"]);
    trustedProxyList({ CROW_TRUSTED_PROXIES: " loopback, 172.18.0.1, 10.1.0.0/16, fd7a:115c:a1e0::9, nope, 10.0.0.0/40 " });
  });
  assert.equal(lines.filter((l) => l.includes('"nope"')).length, 1);
  assert.equal(lines.filter((l) => l.includes('"10.0.0.0/40"')).length, 1);
  assert.deepEqual(trustedProxyList({}), [], "default: trust no one");
  process.env.CROW_TRUSTED_PROXIES = "10.1.0.0/16,uniquelocal";
  assert.ok(isTrustedProxy("10.1.2.3"));
  assert.ok(isTrustedProxy("::ffff:10.1.2.3"));
  assert.ok(isTrustedProxy("fd00::5"));
  assert.ok(!isTrustedProxy("127.0.0.1"));
});

test("hint log: forwarding headers from an undeclared peer warn once per reason", () => {
  const lines = spyWarn(() => {
    classifyPeer(mk({ "x-forwarded-for": "10.0.0.9" }));
    classifyPeer(mk({ "x-forwarded-for": "10.0.0.8" }));
    classifyPeer(mk({ "x-forwarded-for": "203.0.113.9" }, { remoteAddress: "172.18.0.1" }));
  });
  assert.equal(lines.filter((l) => l.includes("forwarding headers from undeclared peer")).length, 1);
  assert.ok(lines[0].includes("CROW_TRUSTED_PROXIES"));
});

test("raw upgrade shape: an IncomingMessage-like object with no ip classifies the same", () => {
  const raw = { headers: SERVE(), socket: SOCK() };
  assert.equal("ip" in raw, false);
  assert.equal(classifyPeer(raw).via, "serve");
  // connection-only fallback (older call sites)
  assert.equal(classifyPeer({ headers: {}, connection: { remoteAddress: "10.0.0.5" } }).client, "10.0.0.5");
});

test("resolveClientMiddleware: serve/funnel shadow req.ip, req.ips, protocol and secure; others keep Express's getters", () => {
  const mw = resolveClientMiddleware();
  const proto = { get ip() { return "getter"; }, get protocol() { return "http"; }, get secure() { return false; } };
  const req = Object.assign(Object.create(proto), { headers: SERVE(), socket: SOCK() });
  let n = 0;
  mw(req, {}, () => n++);
  assert.equal(n, 1);
  assert.equal(req.crowPeer.via, "serve");
  assert.equal(req.ip, "100.64.20.5");
  assert.deepEqual(req.ips, ["100.64.20.5"]);
  assert.equal(req.protocol, "https");
  assert.equal(req.secure, true);
  const loc = Object.assign(Object.create(proto), { headers: {}, socket: SOCK({ remotePort: 40100 }) });
  mw(loc, {}, () => n++);
  assert.equal(loc.crowPeer.via, "local");
  assert.equal(loc.ip, "getter");
});

// ---- the live case: a real loopback connection from this process ---------
test("live (Linux): a Serve-shaped request from this test process's own socket is unverified by default", { skip: process.platform !== "linux" }, async () => {
  setProcNetReaderForTests(null);
  const seen = [];
  const server = net.createServer((s) => { seen.push(s); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const client = net.connect(server.address().port, "127.0.0.1");
  await new Promise((r) => client.on("connect", r));
  while (!seen.length) await new Promise((r) => setTimeout(r, 5));
  try {
    const t0 = process.hrtime.bigint();
    const uid = peerUid(seen[0]).uid;
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    console.log(`[peer-uid] live lookup: ${ms.toFixed(2)} ms`);
    assert.equal(uid, process.getuid(), "the client-side row carries this process's uid");
    const lines = spyWarn(() => assert.equal(classifyPeer({ headers: SERVE("100.64.20.5", { "tailscale-user-login": "owner@example.com" }), socket: seen[0] }).via, process.getuid() === 0 ? "serve" : "unverified"));
    assert.ok(process.getuid() === 0 || lines.length >= 1);
  } finally {
    client.destroy();
    for (const s of seen) s.destroy();
    await new Promise((r) => server.close(r));
  }
});
