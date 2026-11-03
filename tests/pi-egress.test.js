// Queue item 19, step 2c: the egress relay a contained bot's network goes
// through. Unit tests over a real unix socket; the upstream "internet" is a
// loopback server reached through a lookup seam.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, connect } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { mkdtempSync, rmSync, realpathSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startEgressRelay, egressDenyReason, hostAllowed, readLocalTable } from "../scripts/pi-bots/pi_egress.mjs";

/** An own-host view with no addresses (the seam every CONNECT test pins). */
const NO_LOCAL = { v4: [], v6: [], v4Failed: false, v6Failed: false };
/** A global-unicast fixture (the same address the relay tests have always used). */
const PUB = "93.184.216.34";
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "crow-egress-")));
const closers = [];
after(async () => { for (const c of closers) await c(); rmSync(scratch, { recursive: true, force: true }); });

function echoServer(tag = "") {
  return new Promise((resolve) => {
    const srv = createServer((c) => c.on("data", (d) => c.write(tag + d.toString())));
    srv.listen(0, "127.0.0.1", () => { closers.push(() => new Promise((r) => srv.close(() => r()))); resolve(srv.address().port); });
  });
}
/** An HTTP upstream standing in for the gateway (the gateway port is served over the doors only). */
function httpServer(tag = "OK") {
  return new Promise((resolve) => {
    const srv = createHttpServer((req, res) => {
      if (req.url === "/llm/v1/big") { res.writeHead(200, { "content-length": 200000 }); res.end("y".repeat(200000)); return; }
      res.writeHead(200, { "content-type": "text/plain", "content-length": Buffer.byteLength(tag) });
      res.end(tag);
    });
    srv.listen(0, "127.0.0.1", () => { closers.push(() => new Promise((r) => srv.close(() => r()))); resolve(srv.address().port); });
  });
}
function talk(sockPath, first, then = null, { timeout = 3000 } = {}) {
  return new Promise((resolve) => {
    const c = connect(sockPath);
    let buf = "";
    const done = () => { try { c.destroy(); } catch {} resolve(buf); };
    c.on("connect", () => c.write(first));
    c.on("data", (d) => {
      buf += d.toString();
      if (then && /\r\n\r\n/.test(buf) && !c._sent) { c._sent = true; c.write(then); }
      else if (!then || c._sent) setTimeout(done, 50);
    });
    c.on("error", done); c.on("close", done);
    setTimeout(done, timeout);
  });
}
let n = 0;
async function relay(opts) {
  const logs = [];
  // The own-host view is a seam here (the kernel read is not a test subject):
  // the real one is covered by readLocalTable's own tests below.
  const r = await startEgressRelay({ dir: join(scratch, "r" + (++n)), botId: "bot-x", log: (l) => logs.push(l), local: NO_LOCAL, ...opts });
  closers.push(() => r.close());
  return { r, logs };
}

// ---- Task 7: the closed network ----

test("closed: LAN and tailnet refused", () => {
  const o = { local: NO_LOCAL };
  const denied = {
    "10.1.2.3": /private network/, "172.20.0.5": /private network/, "192.168.1.9": /private network/,
    "100.101.102.103": /tailnet\/CGNAT/, "fd7a:115c:a1e0::1": /private network/, "fc00::5": /private network/,
    "fe80::1": /link-local/, "169.254.169.254": /cloud metadata/, "::ffff:10.1.2.3": /private network/,
    "64:ff9b::a01:203": /private network/,
  };
  for (const [a, re] of Object.entries(denied)) assert.match(String(egressDenyReason(a, o)), re, a);
});

test("public allowed", async () => {
  const up = await echoServer("U:");
  const { r } = await relay({ lookup: async () => [{ address: PUB, family: 4 }],
    _connectOverride: () => ({ host: "127.0.0.1", port: up }) });
  const out = await talk(r.socketPath, "PROXY\nCONNECT api.example.com:443 HTTP/1.1\r\nHost: api.example.com:443\r\n\r\n", "ping");
  assert.match(out, /^HTTP\/1\.1 200/);
  assert.match(out, /U:ping$/);
  assert.equal(egressDenyReason(PUB, { local: NO_LOCAL }), null);
  // Any refused address refuses the whole name (no DNS rebinding).
  const mixed = await relay({ lookup: async () => [{ address: PUB, family: 4 }, { address: "10.1.2.3", family: 4 }] });
  assert.match(await talk(mixed.r.socketPath, "PROXY\nCONNECT a.example.com:443 HTTP/1.1\r\n\r\n"), /^HTTP\/1\.1 403/);
});

test("own public address refused", async () => {
  const own = "93.184.216.99";
  const local = { v4: [own + "/32"], v6: [], v4Failed: false, v6Failed: false };
  assert.equal(egressDenyReason(own, { local: NO_LOCAL }), null, "not an own address without the table");
  assert.equal(egressDenyReason(own, { local }), "this host");
  assert.equal(egressDenyReason(own, { local: NO_LOCAL, hostAddrs: [own] }), "this host", "hostAddrs is still a seam");
  const { r } = await relay({ local, lookup: async () => [{ address: own, family: 4 }] });
  assert.match(await talk(r.socketPath, "PROXY\nCONNECT own.example.com:443 HTTP/1.1\r\n\r\n"), /^HTTP\/1\.1 403/);
});

test("local table from ip, fib_trie fallback", () => {
  const ip4 = [
    { type: "local", dst: "127.0.0.1", dev: "lo" }, { type: "local", dst: "10.20.30.40", dev: "eth0" },
    { type: "broadcast", dst: "10.20.30.255", dev: "eth0" }, { type: "local", dst: "10.20.30.0/24", dev: "lo" },
  ];
  const ip6 = [{ type: "local", dst: "::1", dev: "lo" }, { type: "local", dst: "fd00::5", dev: "eth0" }];
  // The MAIN table: one on-link network per family, plus a default route via a
  // router (a gateway is not on-link and must not be counted).
  const ip4Main = [
    { dst: "default", gateway: "192.0.2.1", dev: "eth0" },
    { dst: "192.0.2.0/24", dev: "eth0", scope: "link" },
  ];
  const ip6Main = [{ dst: "2001:db9:10:20::/64", dev: "eth0", protocol: "ra" }];
  const run = (args) => {
    const main = args.includes("main"), v6 = args.includes("-6");
    if (main) return v6 ? ip6Main : ip4Main;
    return v6 ? ip6 : ip4;
  };
  const t = readLocalTable({ run, readFile: () => { throw new Error("ip(8) worked: no procfs fallback expected"); } });
  assert.deepEqual(t, {
    v4: ["127.0.0.1", "10.20.30.40", "10.20.30.255", "10.20.30.0/24"], v6: ["::1", "fd00::5"],
    onLink4: ["192.0.2.0/24"], onLink6: ["2001:db9:10:20::/64"],
    v4Failed: false, v6Failed: false, onLinkFailed: false,
  });

  // ip(8) unusable: the procfs fallbacks, byte shapes as the kernel prints them.
  const trie = [
    "Local:", "  +-- 0.0.0.0/0 3 0 2", "     |-- 10.20.30.40", "        /32 host LOCAL",
    "     |-- 10.20.30.255", "        /32 host LOCAL", "     |-- 10.20.30.0", "        /24 host LOCAL",
    "     |-- 10.20.30.255", "        /32 link BROADCAST",
  ].join("\n");
  const v6route = [
    "00000000000000000000000000000000 00 00000000000000000000000000000000 00 00000000000000000000000000000000 00000400 00000001 00000000 00200200 lo",
    "00000000000000000000000000000001 80 00000000000000000000000000000000 00 00000000000000000000000000000000 00000400 00000001 00000000 80200001 lo",
    "20010db8000000000000000000000005 80 00000000000000000000000000000000 00 00000000000000000000000000000000 00000400 00000001 00000000 80200001 eth0",
  ].join("\n");
  // /proc/net/route: little-endian hex destination and mask, gateway 00000000
  // for an on-link network (the header line first, as the kernel prints it).
  const procRoute = [
    "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT",
    "eth0\t000200C0\t00000000\t0001\t0\t0\t0\t00FFFFFF\t0\t0\t0",
    "eth0\t00000000\t010200C0\t0003\t0\t0\t0\t00000000\t0\t0\t0",
  ].join("\n");
  const fail = () => { throw new Error("ip: not found"); };
  const procfs = (p) => (p === "/proc/net/fib_trie" ? trie : p === "/proc/net/route" ? procRoute : v6route);
  const t2 = readLocalTable({ run: fail, readFile: procfs });
  assert.deepEqual(t2.v4, ["10.20.30.40", "10.20.30.255", "10.20.30.0/24"], "|-- addr followed by /NN host LOCAL");
  assert.deepEqual(t2.v6, ["::1", "2001:db8::5"], "rows with RTF_LOCAL (0x80000000) in column 9");
  assert.deepEqual([t2.v4Failed, t2.v6Failed, t2.onLinkFailed], [false, false, false]);
  // C0.00.02.00 little-endian is 192.0.2.0/24; the default route (zero mask) is not on-link.
  assert.deepEqual(t2.onLink4, ["192.0.2.0/24"], JSON.stringify(t2.onLink4));
  assert.deepEqual(t2.onLink6, [], "every ipv6_route row here is local, loopback or default");

  // A kernel booted without IPv6 (EAFNOSUPPORT, no ipv6_route) is NOT a failure.
  const eaf = () => { throw Object.assign(new Error("RTNETLINK answers: Address family not supported by protocol"), { stderr: "Address family not supported by protocol" }); };
  const t3 = readLocalTable({ run: (args) => (args.includes("-6") ? eaf() : ip4),
    readFile: () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); } });
  assert.deepEqual([t3.v6, t3.v6Failed], [[], false]);
  assert.equal(t3.v4Failed, false);
  assert.equal(t3.onLinkFailed, false, "no IPv6 on this kernel: no on-link IPv6 rows to miss");
});

test("unreadable local table fails closed", async () => {
  const fail = () => { throw new Error("netlink down"); };
  const t = readLocalTable({ run: fail, readFile: fail });
  assert.deepEqual([t.v4, t.v6, t.v4Failed, t.v6Failed], [[], [], true, true]);
  // Every target, IPv4 and IPv6 alike, and one log line per relay.
  const { r, logs } = await relay({ local: t, lookup: async () => [{ address: PUB, family: 4 }] });
  assert.match(await talk(r.socketPath, "PROXY\nCONNECT a.example.com:443 HTTP/1.1\r\n\r\n"), /^HTTP\/1\.1 403/);
  assert.match(await talk(r.socketPath, "PROXY\nCONNECT [2606:4700:4700::1111]:443 HTTP/1.1\r\n\r\n"), /^HTTP\/1\.1 403/);
  assert.equal(logs.filter((l) => l.includes("own-host view unreadable: refusing every target")).length, 1);
  assert.match(String(egressDenyReason(PUB, { local: t })), /own-host view unreadable/);
  assert.match(String(egressDenyReason("2606:4700:4700::1111", { local: t })), /own-host view unreadable/);

  // IPv6 sources failing alone: IPv6 targets refused, public IPv4 still allowed.
  const v6bad = { v4: ["127.0.0.1"], v6: [], v4Failed: false, v6Failed: true };
  assert.equal(egressDenyReason(PUB, { local: v6bad }), null, "public IPv4 is unaffected");
  assert.match(String(egressDenyReason("2606:4700:4700::1111", { local: v6bad })), /own-host view unreadable/);
  const up = await echoServer("U:");
  const { r: r6 } = await relay({ local: v6bad, lookup: async () => [{ address: PUB, family: 4 }],
    _connectOverride: () => ({ host: "127.0.0.1", port: up }) });
  const out = await talk(r6.socketPath, "PROXY\nCONNECT a.example.com:443 HTTP/1.1\r\n\r\n", "ping");
  assert.match(out, /^HTTP\/1\.1 200/);
  assert.match(out, /U:ping$/);
  assert.match(await talk(r6.socketPath, "PROXY\nCONNECT [2606:4700:4700::1111]:443 HTTP/1.1\r\n\r\n"), /^HTTP\/1\.1 403/);
});

test("no interface enumeration", () => {
  const src = readFileSync(new URL("../scripts/pi-bots/pi_egress.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /networkInterfaces/);
});

test("hostAllowed: no list = any host; a list narrows to exact names and *.suffix", () => {
  assert.equal(hostAllowed("api.example.com", null), true);
  assert.equal(hostAllowed("api.example.com", ["api.example.com"]), true);
  assert.equal(hostAllowed("x.example.com", ["*.example.com"]), true);
  assert.equal(hostAllowed("example.com", ["*.example.com"]), false);
  assert.equal(hostAllowed("evil-example.com", ["*.example.com"]), false);
  assert.equal(hostAllowed("API.EXAMPLE.COM.", ["api.example.com"]), true, "case and trailing dot normalized");
});

test("PORT: the gateway port is served over the doors, and any other loopback port is refused", async () => {
  const gw = await httpServer("OK"), other = await echoServer("B:");
  const { r, logs } = await relay({ gatewayPort: gw });
  assert.match(await talk(r.socketPath, `PORT ${gw}\nGET /llm/v1/models HTTP/1.1\r\nHost: x\r\n\r\n`), /^HTTP\/1\.1 200/);
  assert.match(await talk(r.socketPath, `PORT ${gw}\nGET /internal/actor-sign HTTP/1.1\r\nHost: x\r\n\r\n`), /^HTTP\/1\.1 403/);
  assert.equal(await talk(r.socketPath, `PORT ${other}\nhello`), "", "not the gateway port: closed");
  assert.ok(logs.some((l) => /deny 127\.0\.0\.1:\d+.*not the bot's gateway port/.test(l)));
});

test("PROXY CONNECT: a public host (via the lookup seam) is allowed and tunnelled; the response is 200", async () => {
  const up = await echoServer("U:");
  // The seam maps a public-looking address to the local test upstream.
  const { r, logs } = await relay({ lookup: async () => [{ address: PUB, family: 4 }],
    _connectOverride: (addr, port) => ({ host: "127.0.0.1", port: up }), egressPorts: [443] });
  const out = await talk(r.socketPath, "PROXY\nCONNECT api.example.com:443 HTTP/1.1\r\nHost: api.example.com:443\r\n\r\n", "ping");
  assert.match(out, /^HTTP\/1\.1 200/);
  assert.match(out, /U:ping$/);
  assert.ok(logs.some((l) => /bot=bot-x allow api\.example\.com:443/.test(l)));
});

test("PROXY CONNECT: a rebinding name, a refused literal, a disallowed port and a host off the list are refused", async () => {
  const mk = async (lookup, extra = {}) => (await relay({ lookup, egressPorts: [443], ...extra })).r;
  const rebinding = await mk(async () => [{ address: PUB, family: 4 }, { address: "127.0.0.1", family: 4 }]);
  assert.match(await talk(rebinding.socketPath, "PROXY\nCONNECT a.example.com:443 HTTP/1.1\r\n\r\n"), /^HTTP\/1\.1 403/);
  const lit = await mk(async () => { throw new Error("no lookup for literals"); });
  for (const t of ["127.0.0.1:443", "[::1]:443", "10.20.30.40:443", "169.254.169.254:443", "[::ffff:127.0.0.1]:443", "100.64.20.5:443"]) {
    assert.match(await talk(lit.socketPath, `PROXY\nCONNECT ${t} HTTP/1.1\r\n\r\n`), /^HTTP\/1\.1 403/, t);
  }
  const pub = await mk(async () => [{ address: PUB, family: 4 }]);
  assert.match(await talk(pub.socketPath, "PROXY\nCONNECT a.example.com:22 HTTP/1.1\r\n\r\n"), /^HTTP\/1\.1 403/, "port 22");
  const listed = await mk(async () => [{ address: PUB, family: 4 }], { egressAllow: ["api.example.com"] });
  assert.match(await talk(listed.socketPath, "PROXY\nCONNECT other.example.com:443 HTTP/1.1\r\n\r\n"), /^HTTP\/1\.1 403/);
  const listedLan = await mk(async () => [{ address: "192.168.1.20", family: 4 }], { egressAllow: ["api.example.com"] });
  assert.match(await talk(listedLan.socketPath, "PROXY\nCONNECT nas.home.arpa:443 HTTP/1.1\r\n\r\n"), /^HTTP\/1\.1 403/, "the egress list narrows further");
});

test("PROXY: only CONNECT; an oversize or unterminated head is refused", async () => {
  const { r } = await relay({ lookup: async () => [{ address: PUB, family: 4 }], headTimeoutMs: 300 });
  assert.match(await talk(r.socketPath, "PROXY\nGET http://a.example.com/ HTTP/1.1\r\n\r\n"), /^HTTP\/1\.1 405/);
  assert.match(await talk(r.socketPath, "PROXY\nCONNECT " + "a".repeat(20000) + ":443 HTTP/1.1\r\n\r\n"), /^HTTP\/1\.1 (400|431)/);
  assert.match(await talk(r.socketPath, "PROXY\nCONNECT bad_host!:443 HTTP/1.1\r\n\r\n"), /^HTTP\/1\.1 400/, "not a hostname");
  assert.equal(await talk(r.socketPath, "PROXY\nCONNECT a.example.com:443 HTTP/1.1\r\n", null, { timeout: 1500 }), "", "no blank line: dropped after the head timeout");
  assert.equal(await talk(r.socketPath, "BOGUS\n"), "", "unknown verb: closed");
});

test("connection cap per spawn, one log line per (decision, host)", async () => {
  const gw = await httpServer("OK");
  const req = "GET /llm/v1/models HTTP/1.1\r\nHost: x\r\n\r\n";
  const { r, logs } = await relay({ gatewayPort: gw, maxConns: 1 });
  const a = connect(r.socketPath); await new Promise((res) => a.on("connect", res)); a.write(`PORT ${gw}\n`);
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(await talk(r.socketPath, `PORT ${gw}\n${req}`), "", "second concurrent connection refused");
  a.destroy();
  await new Promise((res) => setTimeout(res, 50));
  assert.match(await talk(r.socketPath, `PORT ${gw}\n${req}`), /^HTTP\/1\.1 200/);
  await new Promise((res) => setTimeout(res, 50));
  assert.match(await talk(r.socketPath, `PORT ${gw}\n${req}`), /^HTTP\/1\.1 200/);
  assert.equal(logs.filter((l) => / allow 127\.0\.0\.1:/.test(l)).length, 1, "logged once");
});

test("the socket lives in a 0700 dir, and close() removes it", async () => {
  const { statSync, existsSync } = await import("node:fs");
  const { r } = await relay({ loopbackPorts: [] });
  assert.equal(statSync(r.dir).mode & 0o777, 0o700);
  await r.close();
  assert.equal(existsSync(r.dir), false);
});

// ---- code/security review fixes ----

test("a server error after listening is logged, never thrown (the spawner must not crash)", async () => {
  const { r, logs } = await relay({ loopbackPorts: [] });
  r._server.emit("error", Object.assign(new Error("accept EMFILE"), { code: "EMFILE" }));
  r._server.emit("error", Object.assign(new Error("accept EMFILE"), { code: "EMFILE" }));
  assert.equal(logs.filter((l) => /relay error: accept EMFILE/.test(l)).length, 2);
});

test("a client that leaves during the DNS lookup opens no upstream connection", async () => {
  let accepted = 0;
  const upSrv = createServer((c) => { accepted++; c.end(); });
  const upPort = await new Promise((res) => upSrv.listen(0, "127.0.0.1", () => res(upSrv.address().port)));
  closers.push(() => new Promise((res) => upSrv.close(() => res())));
  const { r } = await relay({ lookup: () => new Promise((res) => setTimeout(() => res([{ address: PUB, family: 4 }]), 300)),
    _connectOverride: () => ({ host: "127.0.0.1", port: upPort }) });
  const c = connect(r.socketPath);
  await new Promise((res) => c.on("connect", res));
  c.write("PROXY\nCONNECT a.example.com:443 HTTP/1.1\r\n\r\n");
  c.destroy();
  await new Promise((res) => setTimeout(res, 600));
  assert.equal(accepted, 0);
});

test("half-close: a client that sends FIN and waits still gets the whole reply", async () => {
  const gw = await httpServer("OK");
  const { r } = await relay({ gatewayPort: gw });
  const out = await new Promise((resolve) => {
    const c = connect({ path: r.socketPath, allowHalfOpen: true });
    let b = "";
    c.on("connect", () => { c.write(`PORT ${gw}\nGET /llm/v1/big HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`); c.end(); });
    c.on("data", (d) => b += d);
    c.on("end", () => resolve(b));
    setTimeout(() => resolve(b || "TIMEOUT"), 3000);
  });
  assert.match(out, /^HTTP\/1\.1 200/, out.slice(0, 40));
  assert.ok(out.includes("y".repeat(200000)), "the whole body arrived after the client's FIN");
});

test("every checked address is tried in order (a dual-stack host whose first address has no route)", async () => {
  const up = await echoServer("U:");
  const tried = [];
  const { r } = await relay({ lookup: async () => [{ address: "2606:4700:4700::1111", family: 6 }, { address: PUB, family: 4 }],
    _connectOverride: (addr) => { tried.push(addr); return addr.includes(":") ? { host: "127.0.0.1", port: 1 } : { host: "127.0.0.1", port: up }; } });
  const out = await talk(r.socketPath, "PROXY\nCONNECT a.example.com:443 HTTP/1.1\r\n\r\n", "ping");
  assert.match(out, /^HTTP\/1\.1 200/);
  assert.match(out, /U:ping$/);
  assert.deepEqual(tried, ["2606:4700:4700::1111", PUB]);
});

test("port 80 is not proxied by default (CONNECT is for TLS)", async () => {
  const { r } = await relay({ lookup: async () => [{ address: PUB, family: 4 }] });
  assert.match(await talk(r.socketPath, "PROXY\nCONNECT a.example.com:80 HTTP/1.1\r\n\r\n"), /^HTTP\/1\.1 403/);
});

test("decision logging is bounded: distinct-host spraying cannot grow the spawner's memory", async () => {
  const { r, logs } = await relay({ lookup: async () => [{ address: "127.0.0.1", family: 4 }] });
  for (let i = 0; i < 1010; i++) await talk(r.socketPath, `PROXY\nCONNECT h${i}.example.com:443 HTTP/1.1\r\n\r\n`, null, { timeout: 500 });
  assert.equal(logs.filter((l) => / deny h\d+/.test(l)).length, 1000);
  assert.equal(logs.filter((l) => /further decisions are not logged/.test(l)).length, 1);
});

// ---- automated security review: every IPv6 form that embeds IPv4 ----
// 169.254.169.254 = a9fe:a9fe; 127.0.0.1 = 7f00:0001; Teredo stores the
// client address XOR ffff:ffff (169.254.169.254 -> 5601:5601).
test("no IPv6 wrapping gets the metadata address or loopback through", () => {
  const o = { local: NO_LOCAL };
  const forms = {
    "::ffff:a9fe:a9fe": "mapped", "::a9fe:a9fe": "compatible", "::ffff:0:a9fe:a9fe": "SIIT ::ffff:0:0:0/96",
    "64:ff9b::a9fe:a9fe": "NAT64 well-known", "64:ff9b:1::a9fe:a9fe": "NAT64 local-use /48 (embeds 0.0.0.0)",
    "64:ff9b:1:a9fe:a9:fe00::": "NAT64 /48 RFC 6052 layout", "2002:a9fe:a9fe::1": "6to4",
    "2001:0:a9fe:a9fe::1": "Teredo server field", "2001:0:4136:e378:8000:63bf:5601:5601": "Teredo client field",
    "100::a9fe:a9fe": "discard-only 100::/64", "::ffff:0:7f00:1": "SIIT loopback", "2001:0:4136:e378:8000:63bf:80ff:fffe": "Teredo client 127.0.0.1",
  };
  for (const [a, label] of Object.entries(forms)) assert.notEqual(egressDenyReason(a, o), null, label + " " + a);
  // Teredo whose server and client fields are both public addresses.
  assert.equal(egressDenyReason("2001:0:d6b:15c8:8000:63bf:e1e1:e1e1", o), null, "a Teredo address of public endpoints is not refused");
  assert.equal(egressDenyReason("64:ff9b::808:808", o), null, "NAT64 of a public address is allowed");
});

test("a narrowed egress list cannot be bypassed with an IP literal in any IPv6 form of a private address", async () => {
  const { r } = await relay({ lookup: async () => [], egressAllow: ["api.example.com"], hostAddrs: [] });
  for (const lit of ["192.168.1.20", "[::ffff:192.168.1.20]", "[::ffff:0:c0a8:114]", "[64:ff9b::c0a8:114]", "[2002:c0a8:114::1]"]) {
    assert.match(await talk(r.socketPath, `PROXY\nCONNECT ${lit}:443 HTTP/1.1\r\n\r\n`), /^HTTP\/1\.1 403/, lit);
  }
});

test("metadata and host plumbing: all of 169.254/16, Azure WireServer, AWS fd00:ec2::/64, GCP v6, Tailscale's 100.100.100.0/24 and quad100 v6", () => {
  const o = { local: NO_LOCAL };
  for (const a of ["169.254.169.254", "169.254.170.23", "169.254.169.253", "169.254.1.1", "168.63.129.16", "fd00:ec2::23", "fd00:ec2::254",
    "fd20:ce::254", "100.100.100.100", "100.100.100.200", "fd7a:115c:a1e0::53", "64:ff9b::a9fe:a9fe"]) {
    assert.notEqual(egressDenyReason(a, o), null, a);
  }
});

test("address spellings: uppercase, expanded, zone ids all judged the same", () => {
  const o = { local: NO_LOCAL };
  for (const a of ["::FFFF:127.0.0.1", "0:0:0:0:0:ffff:7f00:1", "FD7A:115C:A1E0:0:0:0:0:1", "::ffff:10.20.30.40", "2002:0a14:1e28::1", "64:ff9b::a14:1e28"]) {
    assert.notEqual(egressDenyReason(a, o), null, a);
  }
  assert.match(String(egressDenyReason("fe80::1%eth0", o)), /link-local/, "link-local, with a zone id");
});

test("odd IPv4 spellings (octal, short) go through the real resolver and are refused once resolved", async () => {
  const { r } = await relay();
  for (const t of ["0177.0.0.1", "127.1", "0x7f.0.0.1"]) {
    const out = await talk(r.socketPath, `PROXY\nCONNECT ${t}:443 HTTP/1.1\r\n\r\n`);
    assert.match(out, /^HTTP\/1\.1 (403|502|400)/, t + " → " + out.split("\r\n")[0]);
    assert.doesNotMatch(out, /^HTTP\/1\.1 200/, t);
  }
});

// ---- automated security review: the own-host view comes from the kernel ----

test("the host's own 6to4 / Teredo / NAT64 address is refused even when the embedded IPv4 is clean", () => {
  const own = ["2002:5db8:d822::1", "2001:0:d6b:15c8:8000:63bf:e1e1:e1e1", "64:ff9b::808:808"];
  for (const a of own) assert.equal(egressDenyReason(a, { local: NO_LOCAL }), null, a + " is public on its own");
  const local = { v4: [], v6: own, v4Failed: false, v6Failed: false };
  for (const a of own) assert.match(String(egressDenyReason(a, { local })), /this host/, a);
});

test("the local-table cache never turns a failed read into a success within its TTL; a reset re-reads", async () => {
  const { _setLocalTableReaderForTest, _resetLocalTableCacheForTest } = await import("../scripts/pi-bots/pi_egress.mjs");
  let fail = true;
  _setLocalTableReaderForTest(() => { if (fail) throw new Error("netlink"); return { v4: ["127.0.0.1"], v6: [], v4Failed: false, v6Failed: false }; });
  try {
    _resetLocalTableCacheForTest();
    assert.match(String(egressDenyReason(PUB)), /own-host view unreadable/);
    fail = false;
    assert.match(String(egressDenyReason(PUB)), /own-host view unreadable/, "still the cached failure");
    _resetLocalTableCacheForTest();
    assert.equal(egressDenyReason(PUB), null, "re-read succeeds");
  } finally {
    _setLocalTableReaderForTest(null);
    _resetLocalTableCacheForTest();
  }
});

test("operator-listed extra refused networks (e.g. Kubernetes ClusterIP ranges) are refused", async () => {
  const o = { local: NO_LOCAL, denyNets: ["10.43.0.0/16", "fd00:43::/64"] };
  assert.match(String(egressDenyReason("10.43.0.10", o)), /operator-denied/);
  assert.match(String(egressDenyReason("fd00:43::1", o)), /operator-denied/);
  assert.equal(egressDenyReason(PUB, o), null, "a public address outside the list is unaffected");
  const { r } = await relay({ lookup: async () => [{ address: "10.43.0.10", family: 4 }], denyNets: ["10.43.0.0/16"] });
  assert.match(await talk(r.socketPath, "PROXY\nCONNECT svc.cluster.local:443 HTTP/1.1\r\n\r\n"), /^HTTP\/1\.1 403/);
});

test("a local-table entry with an unrecognised dst shape makes the view fail closed", () => {
  const local = { v4: ["weird//x"], v6: [], v4Failed: false, v6Failed: false };
  assert.match(String(egressDenyReason(PUB, { local })), /own-host view unreadable/);
  assert.match(String(egressDenyReason("10.20.30.50", { local })), /private network/, "a known range keeps its own reason");
});

test("an unreadable operator deny entry refuses EVERY destination (public too), and a match says operator-denied", async () => {
  const o = { local: NO_LOCAL, denyNets: ["203.0.113.5/32x"] };
  assert.match(String(egressDenyReason("203.0.113.5", o)), /operator deny list/);
  assert.match(String(egressDenyReason(PUB, o)), /operator deny list/);
  assert.match(String(egressDenyReason("203.0.113.5", { local: NO_LOCAL, denyNets: ["203.0.113.5/32"] })), /operator-denied network/);
  const { r, logs } = await relay({ lookup: async () => [{ address: PUB, family: 4 }], denyNets: ["nope"] });
  assert.match(await talk(r.socketPath, "PROXY\nCONNECT a.example.com:443 HTTP/1.1\r\n\r\n"), /^HTTP\/1\.1 403/);
  assert.ok(logs.some((l) => /CROW_PI_EGRESS_DENY_NETS.*unreadable/.test(l)), "logged loudly at relay start");
});


// ---- automated findings on intermediate commits ----
test("the operator deny list applies to every IPv4-in-IPv6 form too", () => {
  const o = { local: NO_LOCAL, denyNets: ["10.9.0.0/16"] };
  for (const a of ["10.9.1.1", "::ffff:10.9.1.1", "::10.9.1.1", "::ffff:0:10.9.1.1", "64:ff9b::10.9.1.1", "2002:0a09:0101::1",
    "2001:0:4136:e378:8000:63bf:f5f6:fefe"]) {
    assert.match(String(egressDenyReason(a, o)), /operator-denied/, a);
  }
  assert.equal(egressDenyReason("::ffff:93.184.216.34", { local: NO_LOCAL }), null, "a public address outside the list is allowed");
});

test("a deny entry written in IPv4-mapped IPv6 form covers the IPv4 network and all its other wrappings", () => {
  const o = { local: NO_LOCAL, denyNets: ["::ffff:10.9.0.0/112"] };
  for (const a of ["10.9.1.1", "::ffff:10.9.1.1", "::10.9.1.1", "64:ff9b::a09:101", "2002:a09:101::1"]) assert.match(String(egressDenyReason(a, o)), /operator-denied/, a);
  assert.equal(egressDenyReason(PUB, o), null);
});

test("ISATAP addresses are judged by their embedded IPv4; a deny entry with two prefixes is unreadable", () => {
  const o = { local: NO_LOCAL, denyNets: ["10.9.0.0/16"] };
  assert.match(String(egressDenyReason("2001:db8::5efe:10.9.1.1", o)), /operator-denied/);
  assert.match(String(egressDenyReason("2001:db8::200:5efe:a9fe:a9fe", o)), /metadata/);
  assert.match(String(egressDenyReason(PUB, { ...o, denyNets: ["10.9.0.0/16/1"] })), /unreadable entry/);
});

// ---- automated security review: networks this host is directly attached to ----
// Every other machine on the LAN has a global address, and nothing in that
// address says so: the MAIN table's on-link rows (and the /64 of an own global
// IPv6 address) are what catches them.
// The fixture is 2001:db9::/32 rather than RFC 3849's 2001:db8::/32 for the
// CONTROL address only: 2001:db8::/32 is refused as a documentation range, so
// a control inside it could not show "not on-link => allowed".
const view = (v = {}) => ({ v4: [], v6: [], onLink4: [], onLink6: [], v4Failed: false, v6Failed: false, onLinkFailed: false, ...v });

test("a LAN neighbour's global IPv6 address is refused (on-link /64)", async () => {
  const local = view({ v6: ["2001:db9:10:20::5/128"], onLink6: ["2001:db9:10:20::/64"] });
  assert.equal(egressDenyReason("2001:db9:10:20::f2b1", { local }), "this host's network", "the neighbour shares the on-link /64");
  assert.equal(egressDenyReason("2001:db9:10:21::f2b1", { local }), null, "the neighbouring /64 is off-link and allowed");
  assert.equal(egressDenyReason("2001:db9:10:20::5", { local }), "this host", "this host's own address keeps its own reason");
  // The on-link rule is not a general documentation-range refusal in disguise:
  // the same style of fixture on a documentation prefix is refused for the
  // on-link reason, before the range checks.
  const doc = view({ v6: ["2001:db8:10:20::5/128"], onLink6: ["2001:db8:10:20::/64"] });
  assert.equal(egressDenyReason("2001:db8:10:20::f2b1", { local: doc }), "this host's network");
  assert.match(String(egressDenyReason("2001:db8:99::1", { local: doc })), /documentation range/, "and nothing wider is swept in");
  // Through the relay: a refused name opens nothing.
  const { r, logs } = await relay({ local, lookup: async () => [{ address: "2001:db9:10:20::f2b1", family: 6 }] });
  assert.match(await talk(r.socketPath, "PROXY\nCONNECT nas.example.com:443 HTTP/1.1\r\n\r\n"), /^HTTP\/1\.1 403/);
  assert.ok(logs.some((l) => /deny nas\.example\.com:443 \(this host's network\)/.test(l)), logs.join("\n"));
});

test("the /64 of an own global IPv6 address is refused even without a main-table row", () => {
  const local = view({ v6: ["2001:db9:10:30::5/128"] });
  assert.equal(egressDenyReason("2001:db9:10:30::7", { local }), "this host's network", "derived from the own address alone");
  assert.equal(egressDenyReason("2001:db9:10:31::7", { local }), null, "a different /64 is not ours");
  // A non-global own address adds nothing: the range checks keep their reason.
  const ula = view({ v6: ["fd00:20::5/128"] });
  assert.equal(egressDenyReason("fd00:20::7", { local: ula }), "private network");
  const linkLocal = view({ v6: ["fe80::5/128"] });
  assert.equal(egressDenyReason("fe80::7", { local: linkLocal }), "link-local");
});

test("on-link IPv4 from the main table is refused", () => {
  // A public /24 this host sits on (RFC 5737), and the neighbouring /24 as the
  // control: nothing but the on-link row can refuse a documentation-range
  // neighbour here, and the relay checks the row before the range list.
  const local = view({ v4: ["10.20.30.40/32"], onLink4: ["203.0.113.0/24"] });
  assert.equal(egressDenyReason("203.0.113.7", { local }), "this host's network", "a public /24 this host sits on");
  assert.equal(egressDenyReason("203.0.114.7", { local }), null, "the next /24 over: off-link and allowed");
  assert.match(String(egressDenyReason("203.0.113.7", { local: NO_LOCAL })), /documentation range/, "without the on-link row it is only a range refusal");
  // The fixture from the review, same rule.
  const doc = view({ onLink4: ["198.51.100.0/24"] });
  assert.equal(egressDenyReason("198.51.100.7", { local: doc }), "this host's network");
});

test("main table unreadable fails closed", () => {
  const ip4 = [{ type: "local", dst: "127.0.0.1", dev: "lo" }];
  const ip6 = [{ type: "local", dst: "::1", dev: "lo" }];
  const t = readLocalTable({
    run: (args) => { if (args.includes("main")) throw new Error("netlink down"); return args.includes("-6") ? ip6 : ip4; },
    readFile: () => { throw new Error("no procfs here"); },
  });
  assert.equal(t.onLinkFailed, true);
  assert.deepEqual([t.v4Failed, t.v6Failed], [true, true], "both families fail closed");
  assert.match(String(egressDenyReason(PUB, { local: t })), /own-host view unreadable/);
  assert.match(String(egressDenyReason("2606:4700:4700::1111", { local: t })), /own-host view unreadable/);
  // Only the IPv4 on-link read failing leaves IPv6 usable, and vice versa.
  const t4 = readLocalTable({
    run: (args) => {
      if (args.includes("main")) {
        if (args.includes("-6")) return [{ dst: "2001:db9:10:20::/64", dev: "eth0" }];
        throw new Error("v4 main down");
      }
      return args.includes("-6") ? ip6 : ip4;
    },
    readFile: () => { throw new Error("no procfs here"); },
  });
  assert.deepEqual([t4.v4Failed, t4.v6Failed, t4.onLinkFailed], [true, false, true]);
  assert.match(String(egressDenyReason(PUB, { local: t4 })), /own-host view unreadable/, "the failed IPv4 view refuses every target (the rule above)");
});

test("the real kernel reader on this host", (t) => {
  const ipPresent = ["/usr/sbin/ip", "/sbin/ip", "/usr/bin/ip", "/bin/ip"].some((p) => { try { return statSync(p).isFile(); } catch { return false; } });
  const triePresent = (() => { try { return statSync("/proc/net/fib_trie").isFile(); } catch { return false; } })();
  if (!ipPresent && !triePresent) { t.skip("neither ip(8) nor /proc/net/fib_trie on this host"); return; }
  const r = readLocalTable();
  assert.equal(r.v4Failed, false, "the real reader works here: " + JSON.stringify(r));
  assert.ok(r.v4.includes("127.0.0.1"), "loopback is always an own address: " + r.v4.join(","));
  assert.ok(Array.isArray(r.onLink4) && Array.isArray(r.onLink6), "both on-link lists are reported");
});

// ---- S5: no gateway port, no PORT line ----
test("with no gateway port every PORT line is refused", async () => {
  const { r, logs } = await relay({});
  for (const port of [0, 80, 443, 3001]) {
    assert.equal(await talk(r.socketPath, `PORT ${port}\nGET /llm/v1/models HTTP/1.1\r\nHost: x\r\n\r\n`), "", `PORT ${port}: closed`);
  }
  assert.ok(logs.some((l) => /deny 127\.0\.0\.1:\d+ \(no gateway port\)/.test(l)), logs.join("\n"));
});