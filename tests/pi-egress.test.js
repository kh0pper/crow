// Queue item 19, step 2c: the egress relay a contained bot's network goes
// through. Unit tests over a real unix socket; the upstream "internet" is a
// loopback server reached through a lookup seam.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, connect } from "node:net";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startEgressRelay, isPublicAddress, hostAllowed } from "../scripts/pi-bots/pi_egress.mjs";

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

test("isPublicAddress: private, loopback, link-local, CGNAT, special and v6 forms are not public", () => {
  for (const a of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "100.64.0.1", "169.254.1.1", "0.0.0.0", "198.18.0.1",
    "192.0.0.1", "240.0.0.1", "224.0.0.1", "255.255.255.255", "::1", "::", "fc00::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1",
    "::ffff:10.0.0.1", "64:ff9b::a00:1", "2002:a00:1::1", "::a00:1", "2001:db8::1", "100::1"]) {
    assert.equal(isPublicAddress(a), false, a);
  }
  for (const a of ["1.1.1.1", "93.184.216.34", "2606:4700:4700::1111"]) assert.equal(isPublicAddress(a), true, a);
  assert.equal(isPublicAddress("not-an-ip"), false);
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

test("PROXY CONNECT: refused for a name resolving to a private address (any of them), an IP literal in a private range, a disallowed port, a host off the list", async () => {
  const mk = async (lookup, extra = {}) => (await relay({ lookup, egressPorts: [443], ...extra })).r;
  const rebinding = await mk(async () => [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }]);
  assert.match(await talk(rebinding.socketPath, "PROXY\nCONNECT a.example.com:443 HTTP/1.1\r\n\r\n"), /^HTTP\/1\.1 403/);
  const lit = await mk(async () => { throw new Error("no lookup for literals"); });
  assert.match(await talk(lit.socketPath, "PROXY\nCONNECT 10.0.0.5:443 HTTP/1.1\r\n\r\n"), /^HTTP\/1\.1 403/);
  assert.match(await talk(lit.socketPath, "PROXY\nCONNECT [::1]:443 HTTP/1.1\r\n\r\n"), /^HTTP\/1\.1 403/);
  const pub = await mk(async () => [{ address: "93.184.216.34", family: 4 }]);
  assert.match(await talk(pub.socketPath, "PROXY\nCONNECT a.example.com:22 HTTP/1.1\r\n\r\n"), /^HTTP\/1\.1 403/, "port 22");
  const listed = await mk(async () => [{ address: "93.184.216.34", family: 4 }], { egressAllow: ["api.example.com"] });
  assert.match(await talk(listed.socketPath, "PROXY\nCONNECT other.example.com:443 HTTP/1.1\r\n\r\n"), /^HTTP\/1\.1 403/);
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
