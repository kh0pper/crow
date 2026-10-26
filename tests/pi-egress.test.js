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

test("the default route reader reads the real kernel tables (no seam) and refuses this host's own address", async () => {
  const { networkInterfaces } = await import("node:os");
  const own = Object.values(networkInterfaces()).flat().map((i) => i.address).find((a) => /^\d+\./.test(a) && !a.startsWith("127."));
  if (!own) return;
  assert.notEqual(egressDenyReason(own), null);
  assert.equal(egressDenyReason("93.184.216.34"), null);
});
