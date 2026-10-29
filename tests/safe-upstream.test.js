/**
 * safe-upstream — the one outbound path for provider requests (roles phase 2b, Task 9).
 *
 * A fake HTTP server on 127.0.0.1 counts every hit; DNS is an injected
 * lookupFn, so no real name is ever resolved and no real provider is called.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

import { safeRequest, readJson, guardedLookup, addressRefused, ownAddresses, preflightRefused } from "../servers/gateway/models/safe-upstream.js";
import { setInterfaceTableForTests } from "../servers/shared/ip-classify.js";

function fakeServer(handler = (req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); }) {
  const hits = [];
  const server = createServer((req, res) => { hits.push(req.url); handler(req, res); });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    server, hits, port: server.address().port,
    close: () => new Promise((r) => server.close(r)),
  })));
}

const answer = (address) => (name, opts, cb) => {
  if (opts && opts.all) cb(null, [{ address, family: address.includes(":") ? 6 : 4 }]);
  else cb(null, address, address.includes(":") ? 6 : 4);
};

test("literal non-public hosts refused (N2)", async () => {
  const s = await fakeServer();
  try {
    for (const host of ["0.0.0.0", "[::]", "[64:ff9b::7f00:1]", "127.0.0.1", "[::ffff:127.0.0.1]", "[2002:7f00:1::]"]) {
      await assert.rejects(
        safeRequest(`http://${host}:${s.port}/v1`, { mode: "cloud", timeoutMs: 2000 }),
        (e) => e.code === "FORBIDDEN_TARGET",
        host,
      );
    }
    assert.equal(s.hits.length, 0);
  } finally { await s.close(); }
});

test("dns to loopback refused, both lookup callback forms", async () => {
  const s = await fakeServer();
  try {
    const arrayForm = (name, opts, cb) => cb(null, [{ address: "127.0.0.1", family: 4 }]);
    const singleForm = (name, opts, cb) => cb(null, "127.0.0.1", 4);
    for (const lookupFn of [arrayForm, singleForm]) {
      await assert.rejects(
        safeRequest(`http://up.example.com:${s.port}/v1`, { mode: "cloud", lookupFn, timeoutMs: 2000 }),
        (e) => e.code === "UPSTREAM_ADDRESS_REFUSED",
      );
    }
    assert.equal(s.hits.length, 0);
  } finally { await s.close(); }
});

test("guarded lookup: one bad address in an all:true answer refuses the lot; single form is honoured", async () => {
  const mixed = (name, opts, cb) => cb(null, [{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.5", family: 4 }]);
  const lk = guardedLookup({ mode: "cloud", lookupFn: mixed, port: 443 });
  const err = await new Promise((r) => lk("up.example.com", { all: true }, (e) => r(e)));
  assert.equal(err?.code, "UPSTREAM_ADDRESS_REFUSED");

  const good = guardedLookup({ mode: "cloud", lookupFn: answer("8.8.8.8"), port: 443 });
  const single = await new Promise((r) => good("up.example.com", {}, (e, a, f) => r({ e, a, f })));
  assert.deepEqual(single, { e: null, a: "8.8.8.8", f: 4 });
  const all = await new Promise((r) => good("up.example.com", { all: true }, (e, a) => r({ e, a })));
  assert.deepEqual(all, { e: null, a: [{ address: "8.8.8.8", family: 4 }] });
  // A lookupFn that ignores all:true and answers in the single form still gets an array back.
  const ignoring = guardedLookup({ mode: "cloud", lookupFn: (n, o, cb) => cb(null, "8.8.8.8", 4), port: 443 });
  const coerced = await new Promise((r) => ignoring("up.example.com", { all: true }, (e, a) => r(a)));
  assert.deepEqual(coerced, [{ address: "8.8.8.8", family: 4 }]);
});

/** A transport stub that runs the lookup the way net.connect does, then answers 200. */
function stubTransport() {
  const seen = [];
  return {
    seen,
    request(opts, onResponse) {
      const req = new EventEmitter();
      req.setTimeout = () => req;
      req.write = () => true;
      req.destroy = (err) => { if (err) req.emit("error", err); };
      req.end = () => {
        opts.lookup(opts.hostname, { all: true }, (err, addrs) => {
          if (err) return req.emit("error", err);
          seen.push(addrs);
          const res = Readable.from([Buffer.from("{}")]);
          res.statusCode = 200; res.headers = {};
          onResponse(res);
        });
      };
      return req;
    },
  };
}

test("other mode allows the LAN, not the metadata address", async () => {
  const t = stubTransport();
  const ok = await safeRequest("http://llm.lan.example:11434/v1/models", { mode: "other", lookupFn: answer("192.168.1.20"), transport: t, timeoutMs: 2000 });
  assert.equal(ok.status, 200);
  assert.deepEqual(t.seen, [[{ address: "192.168.1.20", family: 4 }]]);

  await assert.rejects(
    safeRequest("http://llm.lan.example:11434/v1/models", { mode: "other", lookupFn: answer("169.254.169.254"), transport: t, timeoutMs: 2000 }),
    (e) => e.code === "UPSTREAM_ADDRESS_REFUSED",
  );
  // The same LAN address is refused in cloud mode.
  await assert.rejects(
    safeRequest("http://llm.lan.example:11434/v1/models", { mode: "cloud", lookupFn: answer("192.168.1.20"), transport: t, timeoutMs: 2000 }),
    (e) => e.code === "UPSTREAM_ADDRESS_REFUSED",
  );
  assert.equal(t.seen.length, 1);
});

test("address rule: other mode refuses unspecified, link-local, metadata and this gateway's own port", () => {
  const own = new Set(["127.0.0.1", "::1", "localhost"]);
  const refused = (a, port = 8080) => addressRefused(a, { mode: "other", port, gatewayPortValue: 3001, ownAddrs: own });
  assert.equal(refused("192.168.1.20"), false);
  assert.equal(refused("127.0.0.1", 11434), false);   // a local llama-server is legitimate
  assert.equal(refused("0.0.0.0"), true);
  assert.equal(refused("::"), true);
  assert.equal(refused("fe80::1"), true);
  assert.equal(refused("169.254.169.254"), true);
  assert.equal(refused("::ffff:169.254.169.254"), true);
  assert.equal(refused("100.100.100.200"), true);      // a cloud metadata address outside link-local
  assert.equal(refused("127.0.0.1", 3001), true);      // this gateway itself
  assert.equal(refused("::ffff:127.0.0.1", 3001), true);
  // cloud mode: only public, never own.
  const cloud = (a) => addressRefused(a, { mode: "cloud", port: 443, gatewayPortValue: 3001, ownAddrs: new Set(["198.51.100.7"]) });
  assert.equal(cloud("8.8.8.8"), false);
  assert.equal(cloud("10.0.0.5"), true);
  assert.equal(cloud("100.64.20.3"), true);
});

test("allowAddressFn is a narrow exception for one test name", async () => {
  const s = await fakeServer();
  try {
    const allow = (name, addr) => name === "fake.test" && addr === "127.0.0.1";
    const r = await safeRequest(`http://fake.test:${s.port}/v1/models`, { mode: "cloud", lookupFn: answer("127.0.0.1"), allowAddressFn: allow, timeoutMs: 2000 });
    assert.equal(r.status, 200);
    assert.deepEqual(await readJson(r), {});
    await assert.rejects(
      safeRequest(`http://other.test:${s.port}/v1/models`, { mode: "cloud", lookupFn: answer("127.0.0.1"), allowAddressFn: allow, timeoutMs: 2000 }),
      (e) => e.code === "UPSTREAM_ADDRESS_REFUSED",
    );
    assert.deepEqual(s.hits, ["/v1/models"]);
  } finally { await s.close(); }
});

test("no redirects: a 307 comes back as is and its target gets zero hits", async () => {
  let port;
  const s = await fakeServer((req, res) => {
    if (req.url === "/start") { res.writeHead(307, { location: `http://fake.test:${port}/target` }); res.end(); return; }
    res.writeHead(200); res.end("{}");
  });
  port = s.port;
  try {
    const r = await safeRequest(`http://fake.test:${port}/start`, {
      mode: "cloud", lookupFn: answer("127.0.0.1"), allowAddressFn: (n) => n === "fake.test", timeoutMs: 2000,
    });
    assert.equal(r.status, 307);
    r.stream.resume();
    await new Promise((res) => setTimeout(res, 50));
    assert.deepEqual(s.hits, ["/start"]);
  } finally { await s.close(); }
});

test("capped body: readJson on a 3 MB body rejects too_large", async () => {
  const big = Buffer.alloc(3_000_000, 0x20);
  const s = await fakeServer((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(big); });
  try {
    const r = await safeRequest(`http://fake.test:${s.port}/v1/models`, {
      mode: "cloud", lookupFn: answer("127.0.0.1"), allowAddressFn: (n) => n === "fake.test", timeoutMs: 4000,
    });
    await assert.rejects(readJson(r), (e) => e.code === "too_large");
  } finally { await s.close(); }
  // A stream without a content-length is capped as it is read.
  await assert.rejects(readJson(Readable.from([big.subarray(0, 1_500_000), big.subarray(0, 1_500_000)])), (e) => e.code === "too_large");
  await assert.rejects(readJson(Readable.from([Buffer.from("not json")])), (e) => e.code === "bad_json");
});

test("bad url and timeout", async () => {
  await assert.rejects(safeRequest("ftp://x/v1", { mode: "cloud" }), (e) => e.code === "BAD_URL");
  await assert.rejects(safeRequest("not a url", { mode: "cloud" }), (e) => e.code === "BAD_URL");
  const s = await fakeServer(() => { /* never answers */ });
  try {
    await assert.rejects(
      safeRequest(`http://fake.test:${s.port}/v1`, { mode: "cloud", lookupFn: answer("127.0.0.1"), allowAddressFn: (n) => n === "fake.test", timeoutMs: 150 }),
      (e) => e.code === "TIMEOUT",
    );
  } finally { s.server.closeAllConnections(); await s.close(); }
});

test("a slow-drip body cannot outlast timeoutMs (headers and body share one deadline)", async () => {
  const s = await fakeServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    const t = setInterval(() => { if (!res.write(" ")) {} }, 300);
    res.on("close", () => clearInterval(t));
  });
  try {
    const started = Date.now();
    const r = await safeRequest(`http://fake.test:${s.port}/v1/models`, {
      mode: "cloud", lookupFn: answer("127.0.0.1"), allowAddressFn: (n) => n === "fake.test", timeoutMs: 1000,
    });
    await assert.rejects(readJson(r), (e) => e.code === "TIMEOUT");
    const took = Date.now() - started;
    assert.ok(took < 1500, `took ${took} ms`);
    assert.ok(took >= 900, `took ${took} ms`);
  } finally { s.server.closeAllConnections(); await s.close(); }
});

test("own addresses include docker and bridge interfaces, for the gateway-port rule", () => {
  const table = {
    lo: [{ address: "127.0.0.1", family: "IPv4" }],
    docker0: [{ address: "172.17.0.1", family: "IPv4" }],
    "br-0a1b2c": [{ address: "192.168.250.1", family: "IPv4" }],
    eth0: [{ address: "100.64.20.5", family: "IPv4" }, { address: "fe80::1%eth0", family: "IPv6" }],
  };
  const own = ownAddresses(table);
  for (const a of ["172.17.0.1", "192.168.250.1", "100.64.20.5", "fe80::1", "localhost"]) assert.ok(own.has(a), a);
  const rule = (a, port) => addressRefused(a, { mode: "other", port, gatewayPortValue: 3001, ownAddrs: own });
  assert.equal(rule("172.17.0.1", 3001), true);
  assert.equal(rule("192.168.250.1", 3001), true);
  assert.equal(rule("100.64.20.5", 3001), true);
  assert.equal(rule("172.17.0.1", 11434), false);    // a server in a container on another port is fine
  assert.equal(rule("192.168.1.20", 3001), false);   // another box on the LAN on the same port is fine
  assert.equal(preflightRefused("http://172.17.0.1:3001/v1", { mode: "other", gatewayPortValue: 3001, ownAddrs: own }), "FORBIDDEN_TARGET");
  assert.equal(preflightRefused("http://localhost:3001/v1", { mode: "other", gatewayPortValue: 3001, ownAddrs: own }), "FORBIDDEN_TARGET");
  assert.equal(preflightRefused("http://localhost:11434/v1", { mode: "other", gatewayPortValue: 3001, ownAddrs: own }), null);
  assert.equal(preflightRefused("ftp://x/", { mode: "other" }), "BAD_URL");
});

test("cloud mode refuses this box's own public address and its on-link neighbours", () => {
  const cloud = (a, ownAddrs = new Set()) => addressRefused(a, { mode: "cloud", port: 443, gatewayPortValue: 3001, ownAddrs });
  // 8.8.4.4 is public: only the own-address branch can refuse it.
  assert.equal(cloud("8.8.4.4"), false);
  assert.equal(cloud("8.8.4.4", new Set(["8.8.4.4"])), true);
  assert.equal(cloud("::ffff:8.8.4.4", new Set(["8.8.4.4"])), true);
  setInterfaceTableForTests(() => ({ eth0: [{ address: "8.8.4.10", netmask: "255.255.255.0", cidr: "8.8.4.10/24", family: "IPv4" }] }));
  try {
    assert.equal(cloud("8.8.4.77"), true);   // on-link with this box
    assert.equal(cloud("8.8.8.8"), false);
  } finally { setInterfaceTableForTests(null); }
});

test("a string or Buffer body is sent with Content-Length, never chunked (F8)", async () => {
  const seen = [];
  const s = await fakeServer((req, res) => {
    let got = "";
    req.on("data", (c) => { got += c; });
    req.on("end", () => {
      seen.push({ len: req.headers["content-length"], te: req.headers["transfer-encoding"], got });
      res.writeHead(200, { "content-type": "application/json" }); res.end("{}");
    });
  });
  try {
    const opts = { method: "POST", mode: "cloud", lookupFn: answer("127.0.0.1"), allowAddressFn: (n) => n === "fake.test", timeoutMs: 2000 };
    const text = JSON.stringify({ model: "m", input: "é ok" });
    const a = await safeRequest(`http://fake.test:${s.port}/v1/embeddings`, { ...opts, headers: { "content-type": "application/json" }, body: text });
    await readJson(a);
    const b = await safeRequest(`http://fake.test:${s.port}/v1/embeddings`, { ...opts, body: Buffer.from("abc") });
    await readJson(b);
    assert.deepEqual(seen, [
      { len: String(Buffer.byteLength(text)), te: undefined, got: text },
      { len: "3", te: undefined, got: "abc" },
    ]);
  } finally { await s.close(); }
});
