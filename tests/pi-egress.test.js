// Queue item 19, step 2c: the egress relay a contained bot's network goes
// through. Unit tests over a real unix socket; the upstream "internet" is a
// loopback server reached through a lookup seam.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, connect } from "node:net";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startEgressRelay, egressDenyReason, hostAllowed } from "../scripts/pi-bots/pi_egress.mjs";

const NO_ROUTES = () => ({ local: [], main: [] });
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "crow-egress-")));
const closers = [];
after(async () => { for (const c of closers) await c(); rmSync(scratch, { recursive: true, force: true }); });

function echoServer(tag = "") {
  return new Promise((resolve) => {
    const srv = createServer((c) => c.on("data", (d) => c.write(tag + d.toString())));
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
  const r = await startEgressRelay({ dir: join(scratch, "r" + (++n)), botId: "bot-x", log: (l) => logs.push(l), ...opts });
  closers.push(() => r.close());
  return { r, logs };
}

// Note: tests pin NO_ROUTES, so fe80::1 reads as allowed here; on a real host
// every veth/bridge carries fe80::/64 in its routes, so link-local targets are
// refused there (over-blocking, accepted).
test("egressDenyReason (D4 = public and private): LAN, tailnet, ULA and public are allowed; loopback, this host, metadata and non-unicast are not, in every v6 wrapping", () => {
  const host = ["10.0.0.237", "100.64.20.5", "fd7a:115c:a1e0::1"];
  for (const a of ["1.1.1.1", "93.184.216.34", "2606:4700:4700::1111", "10.1.2.3", "172.16.0.1", "192.168.1.1",
    "100.64.0.1", "fc00::1", "fe80::1", "198.18.0.1", "::ffff:10.0.0.5"]) {
    assert.equal(egressDenyReason(a, { hostAddrs: host, interfaces: () => ({}), routes: NO_ROUTES }), null, a);
  }
  const denied = {
    "127.0.0.1": /loopback/, "127.9.9.9": /loopback/, "0.0.0.0": /loopback/, "::1": /loopback/, "::": /loopback/,
    "::ffff:127.0.0.1": /loopback/, "::127.0.0.1": /loopback/, "64:ff9b::7f00:1": /loopback/, "2002:7f00:1::1": /loopback/,
    "10.0.0.237": /this host/, "100.64.20.5": /this host/, "fd7a:115c:a1e0::1": /this host/, "::ffff:10.0.0.237": /this host/,
    "169.254.169.254": /metadata/, "169.254.170.2": /metadata/, "100.100.100.200": /metadata/, "fd00:ec2::254": /metadata/,
    "::ffff:169.254.169.254": /metadata/, "169.254.1.1": /plumbing/,
    "224.0.0.1": /not unicast/, "240.0.0.1": /not unicast/, "255.255.255.255": /not unicast/, "ff02::1": /not unicast/,
    "not-an-ip": /not an IP/,
  };
  for (const [a, re] of Object.entries(denied)) assert.match(String(egressDenyReason(a, { hostAddrs: host, interfaces: () => ({}), routes: NO_ROUTES })), re, a);
});

test("hostAllowed: no list = any host; a list narrows to exact names and *.suffix", () => {
  assert.equal(hostAllowed("api.example.com", null), true);
  assert.equal(hostAllowed("api.example.com", ["api.example.com"]), true);
  assert.equal(hostAllowed("x.example.com", ["*.example.com"]), true);
  assert.equal(hostAllowed("example.com", ["*.example.com"]), false);
  assert.equal(hostAllowed("evil-example.com", ["*.example.com"]), false);
  assert.equal(hostAllowed("API.EXAMPLE.COM.", ["api.example.com"]), true, "case and trailing dot normalized");
});

test("PORT: an allowed loopback port is spliced, any other is refused", async () => {
  const ok = await echoServer("A:"), other = await echoServer("B:");
  const { r, logs } = await relay({ loopbackPorts: [ok] });
  assert.equal(await talk(r.socketPath, `PORT ${ok}\nhello`), "A:hello");
  assert.equal(await talk(r.socketPath, `PORT ${other}\nhello`), "", "not in the allowlist: closed");
  assert.ok(logs.some((l) => /deny 127\.0\.0\.1:\d+.*loopback port not allowed/.test(l)));
});

test("PROXY CONNECT: a public host (via the lookup seam) is allowed and tunnelled; the response is 200", async () => {
  const up = await echoServer("U:");
  // The seam maps a public-looking address to the local test upstream.
  const { r, logs } = await relay({ lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    _connectOverride: (addr, port) => ({ host: "127.0.0.1", port: up }), egressPorts: [443] });
  const out = await talk(r.socketPath, "PROXY\nCONNECT api.example.com:443 HTTP/1.1\r\nHost: api.example.com:443\r\n\r\n", "ping");
  assert.match(out, /^HTTP\/1\.1 200/);
  assert.match(out, /U:ping$/);
  assert.ok(logs.some((l) => /bot=bot-x allow api\.example\.com:443/.test(l)));
});

test("PROXY CONNECT: private (LAN/tailnet) targets are allowed by default; loopback, this host, metadata, a rebinding name, a disallowed port and a host off the list are refused", async () => {
  const mk = async (lookup, extra = {}) => (await relay({ lookup, egressPorts: [443], hostAddrs: ["10.0.0.237"], interfaces: () => ({}), routes: NO_ROUTES, ...extra })).r;
  const up = await echoServer("LAN:");
  const lan = await mk(async () => [{ address: "192.168.1.20", family: 4 }], { _connectOverride: () => ({ host: "127.0.0.1", port: up }) });
  const lanOut = await talk(lan.socketPath, "PROXY\nCONNECT nas.home.arpa:443 HTTP/1.1\r\n\r\n", "ping");
  assert.match(lanOut, /^HTTP\/1\.1 200/); assert.match(lanOut, /LAN:ping$/);
  const rebinding = await mk(async () => [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }]);
  assert.match(await talk(rebinding.socketPath, "PROXY\nCONNECT a.example.com:443 HTTP/1.1\r\n\r\n"), /^HTTP\/1\.1 403/);
  const lit = await mk(async () => { throw new Error("no lookup for literals"); });
  for (const t of ["127.0.0.1:443", "[::1]:443", "10.0.0.237:443", "169.254.169.254:443", "[::ffff:127.0.0.1]:443"]) {
    assert.match(await talk(lit.socketPath, `PROXY\nCONNECT ${t} HTTP/1.1\r\n\r\n`), /^HTTP\/1\.1 403/, t);
  }
  const pub = await mk(async () => [{ address: "93.184.216.34", family: 4 }]);
  assert.match(await talk(pub.socketPath, "PROXY\nCONNECT a.example.com:22 HTTP/1.1\r\n\r\n"), /^HTTP\/1\.1 403/, "port 22");
  const listed = await mk(async () => [{ address: "93.184.216.34", family: 4 }], { egressAllow: ["api.example.com"] });
  assert.match(await talk(listed.socketPath, "PROXY\nCONNECT other.example.com:443 HTTP/1.1\r\n\r\n"), /^HTTP\/1\.1 403/);
  const listedLan = await mk(async () => [{ address: "192.168.1.20", family: 4 }], { egressAllow: ["api.example.com"] });
  assert.match(await talk(listedLan.socketPath, "PROXY\nCONNECT nas.home.arpa:443 HTTP/1.1\r\n\r\n"), /^HTTP\/1\.1 403/, "the egress list narrows private targets too");
});

test("the relay denies this host's own interface addresses by default (os.networkInterfaces)", async () => {
  const { networkInterfaces } = await import("node:os");
  const own = Object.values(networkInterfaces()).flat().map((i) => i.address).find((a) => !a.startsWith("127.") && a !== "::1" && !a.startsWith("fe80"));
  if (!own) return;
  const { r } = await relay({ lookup: async () => [] });
  const t = own.includes(":") ? `[${own}]:443` : `${own}:443`;
  assert.match(await talk(r.socketPath, `PROXY\nCONNECT ${t} HTTP/1.1\r\n\r\n`), /^HTTP\/1\.1 403/);
});

test("PROXY: only CONNECT; an oversize or unterminated head is refused", async () => {
  const { r } = await relay({ lookup: async () => [{ address: "93.184.216.34", family: 4 }], headTimeoutMs: 300 });
  assert.match(await talk(r.socketPath, "PROXY\nGET http://a.example.com/ HTTP/1.1\r\n\r\n"), /^HTTP\/1\.1 405/);
  assert.match(await talk(r.socketPath, "PROXY\nCONNECT " + "a".repeat(20000) + ":443 HTTP/1.1\r\n\r\n"), /^HTTP\/1\.1 (400|431)/);
  assert.match(await talk(r.socketPath, "PROXY\nCONNECT bad_host!:443 HTTP/1.1\r\n\r\n"), /^HTTP\/1\.1 400/, "not a hostname");
  assert.equal(await talk(r.socketPath, "PROXY\nCONNECT a.example.com:443 HTTP/1.1\r\n", null, { timeout: 1500 }), "", "no blank line: dropped after the head timeout");
  assert.equal(await talk(r.socketPath, "BOGUS\n"), "", "unknown verb: closed");
});

test("connection cap per spawn, one log line per (decision, host)", async () => {
  const up = await echoServer("U:");
  const { r, logs } = await relay({ loopbackPorts: [up], maxConns: 1 });
  const a = connect(r.socketPath); await new Promise((res) => a.on("connect", res)); a.write(`PORT ${up}\n`);
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(await talk(r.socketPath, `PORT ${up}\nx`), "", "second concurrent connection refused");
  a.destroy();
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(await talk(r.socketPath, `PORT ${up}\ny`), "U:y");
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(await talk(r.socketPath, `PORT ${up}\nz`), "U:z");
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
  const { r } = await relay({ lookup: () => new Promise((res) => setTimeout(() => res([{ address: "93.184.216.34", family: 4 }]), 300)),
    _connectOverride: () => ({ host: "127.0.0.1", port: upPort }) });
  const c = connect(r.socketPath);
  await new Promise((res) => c.on("connect", res));
  c.write("PROXY\nCONNECT a.example.com:443 HTTP/1.1\r\n\r\n");
  c.destroy();
  await new Promise((res) => setTimeout(res, 600));
  assert.equal(accepted, 0);
});

test("half-close: a client that sends FIN and waits still gets the whole reply", async () => {
  const upSrv = createServer({ allowHalfOpen: true }, (c) => { let b = ""; c.on("data", (d) => b += d); c.on("end", () => { c.end("REPLY:" + b + ":" + "x".repeat(200000).length); }); });
  const upPort = await new Promise((res) => upSrv.listen(0, "127.0.0.1", () => res(upSrv.address().port)));
  closers.push(() => new Promise((res) => upSrv.close(() => res())));
  const { r } = await relay({ loopbackPorts: [upPort] });
  const out = await new Promise((resolve) => {
    const c = connect({ path: r.socketPath, allowHalfOpen: true });
    let b = "";
    c.on("connect", () => { c.write(`PORT ${upPort}\nhello`); c.end(); });
    c.on("data", (d) => b += d);
    c.on("end", () => resolve(b));
    setTimeout(() => resolve(b || "TIMEOUT"), 3000);
  });
  assert.equal(out, "REPLY:hello:200000");
});

test("every checked address is tried in order (a dual-stack host whose first address has no route)", async () => {
  const up = await echoServer("U:");
  const tried = [];
  const { r } = await relay({ lookup: async () => [{ address: "2606:4700:4700::1111", family: 6 }, { address: "93.184.216.34", family: 4 }],
    _connectOverride: (addr) => { tried.push(addr); return addr.includes(":") ? { host: "127.0.0.1", port: 1 } : { host: "127.0.0.1", port: up }; } });
  const out = await talk(r.socketPath, "PROXY\nCONNECT a.example.com:443 HTTP/1.1\r\n\r\n", "ping");
  assert.match(out, /^HTTP\/1\.1 200/);
  assert.match(out, /U:ping$/);
  assert.deepEqual(tried, ["2606:4700:4700::1111", "93.184.216.34"]);
});

test("port 80 is not proxied by default (CONNECT is for TLS)", async () => {
  const { r } = await relay({ lookup: async () => [{ address: "93.184.216.34", family: 4 }] });
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
  const forms = {
    "::ffff:a9fe:a9fe": "mapped", "::a9fe:a9fe": "compatible", "::ffff:0:a9fe:a9fe": "SIIT ::ffff:0:0:0/96",
    "64:ff9b::a9fe:a9fe": "NAT64 well-known", "64:ff9b:1::a9fe:a9fe": "NAT64 local-use /48 (embedding not reliably readable)",
    "64:ff9b:1:a9fe:a9:fe00::": "NAT64 /48 RFC 6052 layout", "2002:a9fe:a9fe::1": "6to4",
    "2001:0:a9fe:a9fe::1": "Teredo server field", "2001:0:4136:e378:8000:63bf:5601:5601": "Teredo client field",
    "100::a9fe:a9fe": "discard-only 100::/64", "::ffff:0:7f00:1": "SIIT loopback", "2001:0:4136:e378:8000:63bf:80ff:fffe": "Teredo client 127.0.0.1",
  };
  for (const [a, label] of Object.entries(forms)) assert.notEqual(egressDenyReason(a), null, label + " " + a);
  assert.equal(egressDenyReason("2001:0:4136:e378:8000:63bf:3fff:fdd2"), null, "a Teredo address of public endpoints is not refused");
  assert.equal(egressDenyReason("64:ff9b::808:808"), null, "NAT64 of a public address is allowed");
});

test("a narrowed egress list cannot be bypassed with an IP literal in any IPv6 form of a private address", async () => {
  const { r } = await relay({ lookup: async () => [], egressAllow: ["api.example.com"], hostAddrs: [], interfaces: () => ({}), routes: NO_ROUTES });
  for (const lit of ["192.168.1.20", "[::ffff:192.168.1.20]", "[::ffff:0:c0a8:114]", "[64:ff9b::c0a8:114]", "[2002:c0a8:114::1]"]) {
    assert.match(await talk(r.socketPath, `PROXY\nCONNECT ${lit}:443 HTTP/1.1\r\n\r\n`), /^HTTP\/1\.1 403/, lit);
  }
});

// ---- re-review of the public-and-private default ----
const IFACES = {
  lo: [{ address: "127.0.0.1", cidr: "127.0.0.1/8", family: "IPv4", internal: true }],
  eno1: [{ address: "10.0.0.237", cidr: "10.0.0.237/24", family: "IPv4" }, { address: "fe80::1", cidr: "fe80::1/64", family: "IPv6" }],
  tailscale0: [{ address: "100.64.20.5", cidr: "100.64.20.5/32", family: "IPv4" }, { address: "fd7a:115c:a1e0::1", cidr: "fd7a:115c:a1e0::1/128", family: "IPv6" }],
  docker0: [{ address: "172.17.0.1", cidr: "172.17.0.1/16", family: "IPv4" }],
  "br-abc123": [{ address: "172.30.0.1", cidr: "172.30.0.1/24", family: "IPv4" }],
  virbr0: [{ address: "192.168.122.1", cidr: "192.168.122.1/24", family: "IPv4" }],
};

test("local virtual bridges (containers, VMs) are this host: refused; the physical LAN and tailnet subnets are not", () => {
  const o = { interfaces: () => IFACES, routes: NO_ROUTES };
  for (const a of ["172.17.0.2", "172.30.0.9", "192.168.122.50", "::ffff:172.17.0.2"]) assert.match(String(egressDenyReason(a, o)), /container|this host/, a);
  for (const a of ["10.0.0.50", "100.64.20.9", "192.168.1.20"]) assert.equal(egressDenyReason(a, o), null, a);
  assert.match(String(egressDenyReason("10.0.0.255", o)), /broadcast/, "a local subnet broadcast");
});

test("metadata and host plumbing: all of 169.254/16, Azure WireServer, AWS fd00:ec2::/64, GCP v6, Tailscale's 100.100.100.0/24 and quad100 v6", () => {
  const o = { interfaces: () => IFACES, routes: NO_ROUTES };
  for (const a of ["169.254.169.254", "169.254.170.23", "169.254.169.253", "169.254.1.1", "168.63.129.16", "fd00:ec2::23", "fd00:ec2::254",
    "fd20:ce::254", "100.100.100.100", "100.100.100.200", "fd7a:115c:a1e0::53", "64:ff9b::a9fe:a9fe"]) {
    assert.notEqual(egressDenyReason(a, o), null, a);
  }
});

test("address spellings: uppercase, expanded, zone ids all judged the same", () => {
  const o = { interfaces: () => IFACES, routes: NO_ROUTES };
  for (const a of ["::FFFF:127.0.0.1", "0:0:0:0:0:ffff:7f00:1", "FD7A:115C:A1E0:0:0:0:0:1", "::ffff:10.0.0.237", "2002:0a00:00ed::1", "64:ff9b::a00:ed"]) {
    assert.notEqual(egressDenyReason(a, o), null, a);
  }
  assert.notEqual(egressDenyReason("fe80::1%eno1", o), null, "the host's own link-local, with a zone id");
});

test("the own-host check fails CLOSED: if the interfaces cannot be read, every private target is refused (public still allowed)", () => {
  const o = { interfaces: () => { throw new Error("boom"); }, routes: NO_ROUTES };
  assert.match(String(egressDenyReason("10.0.0.50", o)), /cannot be determined/);
  assert.match(String(egressDenyReason("fd12::1", o)), /cannot be determined/);
  assert.equal(egressDenyReason("93.184.216.34", o), null);
});

test("odd IPv4 spellings (octal, short) go through the real resolver and are refused once resolved", async () => {
  const { r } = await relay({ interfaces: () => ({}), routes: NO_ROUTES });
  for (const t of ["0177.0.0.1", "127.1", "0x7f.0.0.1"]) {
    const out = await talk(r.socketPath, `PROXY\nCONNECT ${t}:443 HTTP/1.1\r\n\r\n`);
    assert.match(out, /^HTTP\/1\.1 (403|502|400)/, t + " → " + out.split("\r\n")[0]);
    assert.doesNotMatch(out, /^HTTP\/1\.1 200/, t);
  }
});


// ---- automated security review: the own-host view comes from the kernel ----
const ROUTES = () => ({
  local: [
    { type: "local", dst: "10.0.0.237", dev: "eno1" }, { type: "broadcast", dst: "10.0.0.255", dev: "eno1" },
    { type: "local", dst: "172.18.0.1", dev: "br-down1" }, { type: "local", dst: "fd7a:115c:a1e0::9", dev: "tailscale0" },
  ],
  main: [
    { dst: "default", dev: "eno1" }, { dst: "10.0.0.0/24", dev: "eno1" },
    { dst: "172.18.0.0/16", dev: "br-down1", flags: ["linkdown"] }, { dst: "192.168.48.0/20", dev: "br-down2", flags: ["linkdown"] },
    { dst: "fd00:dead::/64", dev: "docker0" },
  ],
});

test("a bridge that is DOWN (only in the kernel routes, not in networkInterfaces) is still this host", () => {
  const o = { interfaces: () => ({}), routes: ROUTES };
  for (const a of ["172.18.0.5", "192.168.50.7", "fd00:dead::5", "10.0.0.237", "10.0.0.255", "fd7a:115c:a1e0::9", "172.18.0.1"]) {
    assert.notEqual(egressDenyReason(a, o), null, a);
  }
  for (const a of ["10.0.0.50", "192.168.1.20", "93.184.216.34"]) assert.equal(egressDenyReason(a, o), null, a + " (LAN subnet on a physical NIC, other private, public)");
});

test("if the kernel routes cannot be read: every private target is refused, docker/libvirt defaults named, public still allowed, hostAddrs still honoured", () => {
  const o = { interfaces: () => IFACES, routes: () => { throw new Error("ip: not found"); }, hostAddrs: ["93.184.216.99"] };
  for (const a of ["10.0.0.50", "172.17.0.2", "192.168.122.5", "fd12::1"]) assert.notEqual(egressDenyReason(a, o), null, a);
  assert.equal(egressDenyReason("93.184.216.34", o), null, "public still allowed");
  assert.match(String(egressDenyReason("93.184.216.99", o)), /this host/, "hostAddrs honoured when the kernel read fails");
  assert.match(String(egressDenyReason("93.184.216.99", { interfaces: () => ({}), routes: ROUTES, hostAddrs: ["93.184.216.99"] })), /this host/, "and when it works");
});

test("the real kernel reader: a non-empty local table with a lo entry, and a live bridge refused AS a bridge (not by fail-closed)", async () => {
  const { readKernelRoutes } = await import("../scripts/pi-bots/pi_egress.mjs");
  let t;
  try { t = readKernelRoutes(); } catch (e) { return; } // no ip(8) here (CI containers): the seams cover the logic
  assert.ok(t.local.length > 0 && t.local.some((r) => r.dev === "lo"), "local table read");
  const bridge = t.main.find((r) => r.dst && r.dst.includes("/") && isIPv4Net(r.dst) && t.virtualDevs.has(r.dev));
  if (!bridge) return; // no bridge on this host
  const probe = bridge.dst.split("/")[0].replace(/\.0$/, ".9");
  assert.match(String(egressDenyReason(probe)), /container\/VM bridge|this host/, probe + " via " + bridge.dev);
  assert.equal(egressDenyReason("93.184.216.34"), null);
});
const isIPv4Net = (c) => /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(c);

test("local-table CIDRs (local/anycast 10.0.0.0/8) are owned subnets; a bare anycast is an own address; host routes without a prefix count as /32 and /128", () => {
  const routes = () => ({
    local: [{ type: "local", dst: "10.200.0.0/16", dev: "lo" }, { type: "anycast", dst: "fd00:aaaa::/64", dev: "eth0" },
      { type: "anycast", dst: "10.0.0.0", dev: "eno1" }],
    main: [{ dst: "10.244.3.17", dev: "cali123" }, { dst: "fd00:cafe::9", dev: "flannel.1" }, { dst: "10.66.0.0/24", dev: "tap0" }],
  });
  const o = { interfaces: () => ({}), routes };
  for (const a of ["10.200.5.5", "fd00:aaaa::7", "10.0.0.0", "10.244.3.17", "fd00:cafe::9", "10.66.0.9"]) assert.notEqual(egressDenyReason(a, o), null, a);
  assert.equal(egressDenyReason("10.244.3.18", o), null, "a /32 host route covers only its address");
  assert.equal(egressDenyReason("10.0.0.50", o), null);
});

test("a local-table entry with an unrecognised dst shape makes the view fail closed", () => {
  const o = { interfaces: () => ({}), routes: () => ({ local: [{ type: "local", dst: "weird//x", dev: "lo" }], main: [] }) };
  assert.match(String(egressDenyReason("10.0.0.50", o)), /cannot be determined/);
  assert.equal(egressDenyReason("93.184.216.34", o), null);
});


test("virtual devices are found by kernel device KIND too (a Docker bridge with a custom name, cilium), but a tun VPN (the tailnet) is not a bridge", () => {
  const routes = () => ({
    local: [{ type: "local", dst: "127.0.0.1", dev: "lo" }],
    main: [{ dst: "10.77.0.0/16", dev: "crowbr0" }, { dst: "10.78.0.0/16", dev: "cilium_host" }, { dst: "fd7a:115c:a1e0::5", dev: "tailscale0" },
      { dst: "10.79.0.0/24", dev: "eno1" }],
    virtualDevs: new Set(["crowbr0", "cilium_host"]),
  });
  const o = { interfaces: () => ({}), routes };
  assert.notEqual(egressDenyReason("10.77.1.1", o), null, "custom-named bridge");
  assert.notEqual(egressDenyReason("10.78.1.1", o), null, "cilium");
  assert.equal(egressDenyReason("fd7a:115c:a1e0::5", o), null, "a tailnet peer stays allowed (D4)");
  assert.equal(egressDenyReason("10.79.0.9", o), null, "a physical NIC's LAN stays allowed");
});

test("deviceKindIsVirtual: bridge/veth/vxlan/geneve/macvlan/ipvlan/macvtap are virtual; tun (VPNs), wireguard and physical are not", async () => {
  const { deviceKindIsVirtual } = await import("../scripts/pi-bots/pi_egress.mjs");
  for (const k of ["bridge", "veth", "vxlan", "geneve", "macvlan", "ipvlan", "macvtap"]) assert.equal(deviceKindIsVirtual(k), true, k);
  for (const k of ["tun", "wireguard", undefined, ""]) assert.equal(deviceKindIsVirtual(k), false, String(k));
});

test("parseKernelTables: IPv6 disabled is not a failure; an IPv4 local table without lo is", async () => {
  const { parseKernelTables } = await import("../scripts/pi-bots/pi_egress.mjs");
  const ok = parseKernelTables({ local4: [{ type: "local", dst: "127.0.0.1", dev: "lo" }], local6: null, main4: [], main6: null, links: [] });
  assert.deepEqual(ok.local.length, 1);
  assert.throws(() => parseKernelTables({ local4: [], local6: [], main4: [], main6: [], links: [] }), /no lo entry/);
});

test("IPv6 tables: skipped only on EAFNOSUPPORT; any other v6 read failure refuses private IPv6", async () => {
  const { readV6Tables } = await import("../scripts/pi-bots/pi_egress.mjs");
  const v6If = () => ({ eno1: [{ address: "fd12::5", family: "IPv6", cidr: "fd12::5/64" }] });
  const v4OnlyIf = () => ({ eno1: [{ address: "10.0.0.5", family: "IPv4", cidr: "10.0.0.5/24" }] });
  const fail = (msg) => () => { throw Object.assign(new Error(msg), { stderr: msg }); };
  const ok = readV6Tables(() => [{ type: "local", dst: "::1", dev: "lo" }], { interfaces: v6If });
  assert.equal(ok.v6Failed, false); assert.equal(ok.local6.length, 1);
  const eaf = readV6Tables(fail("RTNETLINK answers: Address family not supported by protocol"), { interfaces: v6If });
  assert.deepEqual([eaf.local6, eaf.main6, eaf.v6Failed], [null, null, false], "EAFNOSUPPORT: no IPv6 on this kernel");
  const none = readV6Tables(fail("something else"), { interfaces: v4OnlyIf });
  assert.deepEqual([none.local6, none.v6Failed], [null, true], "a v4-only interface list proves nothing (IPv6 can sit on a down interface): fail closed");
  const bad = readV6Tables(fail("something else"), { interfaces: v6If });
  assert.equal(bad.v6Failed, true, "IPv6 present but unreadable: fail closed");
});

test("a v6-only read failure refuses private IPv6 targets, while IPv4 decisions stay normal", () => {
  const routes = () => ({ local: [{ type: "local", dst: "10.0.0.237", dev: "eno1" }], main: [], v6Failed: true });
  const o = { interfaces: () => ({}), routes };
  assert.match(String(egressDenyReason("fd12::9", o)), /cannot be determined/);
  assert.match(String(egressDenyReason("fe80::9", o)), /cannot be determined/);
  assert.equal(egressDenyReason("2606:4700:4700::1111", o), null, "public IPv6 still allowed");
  assert.equal(egressDenyReason("10.0.0.50", o), null, "IPv4 LAN unaffected");
  assert.notEqual(egressDenyReason("10.0.0.237", o), null);
});


test("a VPN tun device (OpenVPN tun0) is a remote network, allowed under D4; tap/vnet (VM devices) are this host", () => {
  const routes = () => ({ local: [{ type: "local", dst: "127.0.0.1", dev: "lo" }], main: [{ dst: "10.66.0.0/24", dev: "tun0" }, { dst: "10.67.0.0/24", dev: "vnet3" }] });
  const o = { interfaces: () => ({}), routes };
  assert.equal(egressDenyReason("10.66.0.5", o), null);
  assert.notEqual(egressDenyReason("10.67.0.5", o), null);
});

test("a bridge with a PHYSICAL port (the LAN NIC enslaved to br0/vmbr0) is the LAN, not a container bridge", async () => {
  const { parseKernelTables } = await import("../scripts/pi-bots/pi_egress.mjs");
  const t = parseKernelTables({
    local4: [{ type: "local", dst: "127.0.0.1", dev: "lo" }, { type: "local", dst: "10.0.0.237", dev: "vmbr0" }],
    main4: [{ dst: "10.0.0.0/24", dev: "vmbr0" }, { dst: "172.18.0.0/16", dev: "br-x" }],
    links: [{ ifname: "lo" }, { ifname: "eno1", master: "vmbr0", parentbus: "pci" }, { ifname: "vmbr0", linkinfo: { info_kind: "bridge" } },
      { ifname: "br-x", linkinfo: { info_kind: "bridge" } }, { ifname: "veth1", master: "br-x", linkinfo: { info_kind: "veth" } }],
  });
  assert.equal(t.virtualDevs.has("vmbr0"), false);
  assert.equal(t.virtualDevs.has("br-x"), true);
  const o = { interfaces: () => ({}), routes: () => t };
  assert.equal(egressDenyReason("10.0.0.50", o), null, "the LAN behind the bridge stays allowed");
  assert.notEqual(egressDenyReason("10.0.0.237", o), null, "the host's own address on it is still refused");
  assert.notEqual(egressDenyReason("172.18.0.5", o), null);
});

test("the host's own 6to4 / Teredo / NAT64 address is refused even when the embedded IPv4 is clean", () => {
  const own = ["2002:5db8:d822::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "64:ff9b::808:808"];
  const routes = () => ({ local: [{ type: "local", dst: "127.0.0.1", dev: "lo" }, ...own.map((a) => ({ type: "local", dst: a, dev: "sit0" }))], main: [] });
  for (const a of own) assert.match(String(egressDenyReason(a, { interfaces: () => ({}), routes })), /this host/, a);
});

test("a failed link read, or a virtual-device route the parser cannot read, fails the view closed", async () => {
  const { parseKernelTables } = await import("../scripts/pi-bots/pi_egress.mjs");
  const t = parseKernelTables({ local4: [{ type: "local", dst: "127.0.0.1", dev: "lo" }], main4: [], links: null, linksFailed: true });
  assert.match(String(egressDenyReason("10.0.0.50", { interfaces: () => ({}), routes: () => t })), /cannot be determined/);
  const bad = () => ({ local: [{ type: "local", dst: "127.0.0.1", dev: "lo" }], main: [{ dst: "garbage", dev: "br-x" }] });
  assert.match(String(egressDenyReason("10.0.0.50", { interfaces: () => ({}), routes: bad })), /cannot be determined/);
});

test("the route cache never turns a failed read into a success within its TTL; a reset re-reads", async () => {
  const { _setKernelReaderForTest, _resetRoutesCacheForTest } = await import("../scripts/pi-bots/pi_egress.mjs");
  let fail = true;
  _setKernelReaderForTest(() => { if (fail) throw new Error("netlink"); return { local: [{ type: "local", dst: "127.0.0.1", dev: "lo" }], main: [] }; });
  try {
    _resetRoutesCacheForTest();
    const o = { interfaces: () => ({}) };
    assert.match(String(egressDenyReason("10.0.0.50", o)), /cannot be determined/);
    fail = false;
    assert.match(String(egressDenyReason("10.0.0.50", o)), /cannot be determined/, "still the cached failure");
    _resetRoutesCacheForTest();
    assert.equal(egressDenyReason("10.0.0.50", o), null, "re-read succeeds");
  } finally {
    _setKernelReaderForTest(null);
    _resetRoutesCacheForTest();
  }
});

test("VirtualBox/VMware host-only nets (by name) and Open vSwitch bridges (by kind) are this host", () => {
  const routes = () => ({ local: [{ type: "local", dst: "127.0.0.1", dev: "lo" }],
    main: [{ dst: "192.168.56.0/24", dev: "vboxnet0" }, { dst: "172.16.99.0/24", dev: "vmnet8" }, { dst: "10.50.0.0/24", dev: "ovsbr1" }],
    virtualDevs: new Set(["ovsbr1"]) });
  const o = { interfaces: () => ({}), routes };
  for (const a of ["192.168.56.101", "172.16.99.128", "10.50.0.5"]) assert.notEqual(egressDenyReason(a, o), null, a);
});

test("openvswitch is a virtual device kind", async () => {
  const { deviceKindIsVirtual } = await import("../scripts/pi-bots/pi_egress.mjs");
  assert.equal(deviceKindIsVirtual("openvswitch"), true);
});

test("routes from every table count (table all): a container subnet routed only in a VRF table is still this host; non-unicast entries are ignored", () => {
  const routes = () => ({ local: [{ type: "local", dst: "127.0.0.1", dev: "lo" }],
    main: [{ dst: "10.90.0.0/24", dev: "br-vrf", table: "100" }, { type: "local", dst: "10.0.0.237", dev: "eno1", table: "local" },
      { type: "multicast", dst: "ff00::/8", dev: "veth9", table: "local" }] });
  const o = { interfaces: () => ({}), routes };
  assert.notEqual(egressDenyReason("10.90.0.4", o), null);
  assert.equal(egressDenyReason("10.0.0.50", o), null);
});

test("operator-listed extra refused networks (e.g. Kubernetes ClusterIP ranges) are refused", async () => {
  assert.notEqual(egressDenyReason("10.43.0.10", { interfaces: () => ({}), routes: NO_ROUTES_LO, denyNets: ["10.43.0.0/16", "fd00:43::/64"] }), null);
  assert.notEqual(egressDenyReason("fd00:43::1", { interfaces: () => ({}), routes: NO_ROUTES_LO, denyNets: ["10.43.0.0/16", "fd00:43::/64"] }), null);
  assert.equal(egressDenyReason("10.44.0.10", { interfaces: () => ({}), routes: NO_ROUTES_LO, denyNets: ["10.43.0.0/16"] }), null);
  const { r } = await relay({ lookup: async () => [{ address: "10.43.0.10", family: 4 }], interfaces: () => ({}), routes: NO_ROUTES_LO, denyNets: ["10.43.0.0/16"] });
  assert.match(await talk(r.socketPath, "PROXY\nCONNECT svc.cluster.local:443 HTTP/1.1\r\n\r\n"), /^HTTP\/1\.1 403/);
});
const NO_ROUTES_LO = () => ({ local: [{ type: "local", dst: "127.0.0.1", dev: "lo" }], main: [] });

test("the name-based interface path never exempts an explicit virtual name, even with a physical-bridge mark", () => {
  const routes = () => ({ local: [{ type: "local", dst: "127.0.0.1", dev: "lo" }], main: [], physicalBridges: new Set(["br-lan"]) });
  const ifs = () => ({ "br-lan": [{ address: "10.0.0.237", family: "IPv4", cidr: "10.0.0.237/24" }] });
  const o = { interfaces: ifs, routes };
  assert.notEqual(egressDenyReason("10.0.0.50", o), null, "br-* is an explicit container-bridge name");
  assert.notEqual(egressDenyReason("10.0.0.237", o), null);
});

test("an unreadable operator deny entry refuses EVERY destination (public too), and a match says operator-denied", async () => {
  const o = { interfaces: () => ({}), routes: NO_ROUTES_LO, denyNets: ["203.0.113.5/32x"] };
  assert.match(String(egressDenyReason("203.0.113.5", o)), /operator deny list/);
  assert.match(String(egressDenyReason("93.184.216.34", o)), /operator deny list/);
  assert.match(String(egressDenyReason("203.0.113.5", { ...o, denyNets: ["203.0.113.5/32"] })), /operator-denied network/);
  const { r, logs } = await relay({ lookup: async () => [{ address: "93.184.216.34", family: 4 }], interfaces: () => ({}), routes: NO_ROUTES_LO, denyNets: ["nope"] });
  assert.match(await talk(r.socketPath, "PROXY\nCONNECT a.example.com:443 HTTP/1.1\r\n\r\n"), /^HTTP\/1\.1 403/);
  assert.ok(logs.some((l) => /CROW_PI_EGRESS_DENY_NETS.*unreadable/.test(l)), "logged loudly at relay start");
});


// ---- automated findings on intermediate commits ----
test("the operator deny list applies to every IPv4-in-IPv6 form too", () => {
  const o = { interfaces: () => ({}), routes: NO_ROUTES_LO, denyNets: ["10.9.0.0/16"] };
  for (const a of ["10.9.1.1", "::ffff:10.9.1.1", "::10.9.1.1", "::ffff:0:10.9.1.1", "64:ff9b::10.9.1.1", "2002:0a09:0101::1",
    "2001:0:4136:e378:8000:63bf:f5f6:fefe"]) {
    assert.match(String(egressDenyReason(a, o)), /operator-denied/, a);
  }
  assert.equal(egressDenyReason("::ffff:10.8.1.1", o), null);
});

test("the physical-port exemption needs a POSITIVELY physical port, and never overrides the explicit virtual names", async () => {
  const { parseKernelTables } = await import("../scripts/pi-bots/pi_egress.mjs");
  const base = { local4: [{ type: "local", dst: "127.0.0.1", dev: "lo" }] };
  const unknown = parseKernelTables({ ...base, main4: [{ dst: "172.30.0.0/16", dev: "br-x" }, { dst: "10.50.0.0/24", dev: "lanbr" }],
    links: [{ ifname: "lo" }, { ifname: "br-x", linkinfo: { info_kind: "bridge" } }, { ifname: "p1", master: "br-x" },
      { ifname: "lanbr", linkinfo: { info_kind: "bridge" } }, { ifname: "p2", master: "lanbr" }],
    isPhysical: () => false });
  const o1 = { interfaces: () => ({}), routes: () => unknown };
  assert.notEqual(egressDenyReason("172.30.0.5", o1), null, "a port of unknown type is not physical");
  assert.notEqual(egressDenyReason("10.50.0.5", o1), null);
  const phys = parseKernelTables({ ...base, main4: [{ dst: "172.30.0.0/16", dev: "docker0" }, { dst: "10.50.0.0/24", dev: "lanbr" }],
    links: [{ ifname: "lo" }, { ifname: "docker0", linkinfo: { info_kind: "bridge" } }, { ifname: "eth9", master: "docker0", parentbus: "pci" },
      { ifname: "lanbr", linkinfo: { info_kind: "bridge" } }, { ifname: "eno1", master: "lanbr", parentbus: "pci" }] });
  const o2 = { interfaces: () => ({}), routes: () => phys };
  assert.notEqual(egressDenyReason("172.30.0.5", o2), null, "docker0 stays refused even with a physical port (explicit name)");
  assert.equal(egressDenyReason("10.50.0.5", o2), null, "a bridge with a positively physical port (parentbus) is the LAN");
});
