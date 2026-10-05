/**
 * The Funkwhale panel's artwork proxy: every hop (the first request and each redirect) passes the
 * same rule, the connection goes to the address that was checked, and only bounded images come
 * back. Real HTTP servers on loopback play the configured Funkwhale and an attacker; every request
 * each receives is recorded, so "was never requested" is observed, not assumed.
 *
 * Loopback is reachable here only through the route's allow-list ("localhost", "127.0.0.1" and
 * the configured Funkwhale host); any other name is resolved by an injected lookup.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import funkwhaleRouter, { fetchArtwork, validateHostOrReject } from "../bundles/funkwhale/panel/routes.js";

const PNG = Buffer.from("89504e470d0a1a0a0000", "hex");
let fw, evil, app;
const seen = { fw: [], evil: [] };

function listen(handler) {
  return new Promise((res) => { const s = http.createServer(handler); s.listen(0, "127.0.0.1", () => res(s)); });
}
const port = (s) => s.address().port;

before(async () => {
  evil = await listen((req, res) => { seen.evil.push({ url: req.url, auth: req.headers.authorization || null }); res.writeHead(200, { "content-type": "image/png" }); res.end(PNG); });
  fw = await listen((req, res) => {
    seen.fw.push({ url: req.url, auth: req.headers.authorization || null });
    const u = new URL(req.url, "http://x");
    switch (u.pathname) {
      case "/cover.png": res.writeHead(200, { "content-type": "image/png" }); return res.end(PNG);
      case "/redir": res.writeHead(302, { location: u.searchParams.get("to") }); return res.end();
      case "/loop": res.writeHead(302, { location: "/loop" }); return res.end();
      case "/page": res.writeHead(200, { "content-type": "text/html" }); return res.end("<p>hi</p>");
      case "/svg": res.writeHead(200, { "content-type": "image/svg+xml" }); return res.end("<svg/>");
      case "/big-declared": res.writeHead(200, { "content-type": "image/jpeg", "content-length": String(64 * 1024) }); return res.end(Buffer.alloc(64 * 1024));
      case "/big-chunked": res.writeHead(200, { "content-type": "image/jpeg" }); res.write(Buffer.alloc(40 * 1024)); return res.end(Buffer.alloc(40 * 1024));
      case "/hang": return; // never answers
      default: res.writeHead(404); return res.end();
    }
  });
  process.env.FUNKWHALE_URL = `http://127.0.0.1:${port(fw)}`;
  process.env.FUNKWHALE_ACCESS_TOKEN = "tok-secret";
  const ex = express();
  ex.use(funkwhaleRouter((_req, _res, next) => next()));
  app = await new Promise((res) => { const s = ex.listen(0, "127.0.0.1", () => res(s)); });
});
after(() => {
  for (const s of [fw, evil, app]) s.closeAllConnections?.(), s.close();
  delete process.env.FUNKWHALE_URL;
  delete process.env.FUNKWHALE_ACCESS_TOKEN;
});

const reset = () => { seen.fw.length = 0; seen.evil.length = 0; };
const fwUrl = (path) => `http://127.0.0.1:${port(fw)}${path}`;
const redirTo = (target) => fwUrl(`/redir?to=${encodeURIComponent(target)}`);
const neverLooked = async () => { throw new Error("must not be looked up"); };
async function refusedWith(p) {
  try { await p; } catch (e) { assert.ok(e.code, `a refusal code expected, got ${e}`); return e.code; }
  assert.fail("expected a refusal");
}

test("the allowed path: an image from the configured Funkwhale, with its token", async () => {
  reset();
  const r = await fetchArtwork(fwUrl("/cover.png"), { lookup: neverLooked });
  assert.equal(r.contentType, "image/png");
  assert.deepEqual(r.body, PNG);
  assert.deepEqual(seen.fw, [{ url: "/cover.png", auth: "Bearer tok-secret" }]);
});

test("every redirect hop is checked with the first hop's rule; refused targets are never requested", async () => {
  const lookups = {
    "rebind.example.test": [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }],
    "dual.example.test": [{ address: "93.184.216.34", family: 4 }, { address: "::1", family: 6 }],
    "meta.example.test": [{ address: "169.254.169.254", family: 4 }],
  };
  const lookup = async (name, opts) => {
    assert.deepEqual(opts, { all: true }, "one lookup, every address family");
    if (!lookups[name]) throw new Error(`unexpected lookup ${name}`);
    return lookups[name];
  };
  const e = port(evil);
  const table = [
    ["http://169.254.169.254/latest/meta-data/", "metadata address"],
    [`http://rebind.example.test:${e}/x.png`, "name answering public and private (rebinding)"],
    [`http://dual.example.test:${e}/x.png`, "public A, private AAAA"],
    [`http://meta.example.test:${e}/x.png`, "name answering the metadata address"],
    [`http://[::ffff:7f00:1]:${e}/x.png`, "hex v4-mapped loopback"],
    [`http://[::ffff:a9fe:a9fe]/`, "hex v4-mapped metadata"],
    [`http://[64:ff9b::a9fe:a9fe]/`, "NAT64 of the metadata address"],
    [`http://[64:ff9b::7f00:1]:${e}/x.png`, "NAT64 of loopback"],
    [`http://[::1]:${e}/x.png`, "IPv6 loopback literal"],
    [`http://[fd7a:115c:a1e0::1]:${e}/x.png`, "unique local"],
    [`http://10.0.0.1:${e}/x.png`, "RFC 1918"],
  ];
  const miss = [];
  for (const [target, why] of table) {
    reset();
    const code = await refusedWith(fetchArtwork(redirTo(target), { lookup }));
    if (code !== "private_host") miss.push(`${why}: ${code}`);
    if (seen.evil.length) miss.push(`${why}: attacker was requested`);
    if (seen.fw.length !== 1) miss.push(`${why}: Funkwhale saw ${seen.fw.length} requests`);
  }
  assert.deepEqual(miss, []);
});

test("the same rule refuses each of those targets as the first hop", async () => {
  const lookup = async (name) => {
    if (name === "dual.example.test") return [{ address: "93.184.216.34", family: 4 }, { address: "fe80::1", family: 6 }];
    throw new Error(`unexpected lookup ${name}`);
  };
  for (const src of ["http://169.254.169.254/", "http://dual.example.test/a.png", "http://[::ffff:a9fe:a9fe]/", "http://[64:ff9b::a9fe:a9fe]/", "http://0x7f.1.2/"]) {
    assert.equal(await refusedWith(fetchArtwork(src, { lookup })), "private_host", src);
  }
  assert.equal(await refusedWith(fetchArtwork("file:///etc/passwd")), "unsupported_scheme");
  assert.equal(await refusedWith(fetchArtwork("not a url")), "invalid_url");
});

test("the connection goes to the checked address: one lookup per hop, never a second one", async () => {
  reset();
  let calls = 0;
  const lookup = async (name) => {
    assert.equal(name, "localhost");
    calls++;
    return calls === 1 ? [{ address: "127.0.0.1", family: 4 }] : [{ address: "10.255.255.1", family: 4 }];
  };
  const r = await fetchArtwork(`http://localhost:${port(fw)}/cover.png`, { lookup });
  assert.deepEqual(r.body, PNG);
  assert.equal(calls, 1);
});

test("the allow-list is exact host-name matching: allowed names pass on a private address, nothing else does", async () => {
  const toLoop = async () => [{ address: "127.0.0.1", family: 4 }];
  assert.equal((await validateHostOrReject("localhost", { lookup: toLoop })).ok, true);
  assert.equal((await validateHostOrReject("127.0.0.1", { lookup: neverLooked })).ok, true);
  for (const h of ["localhost.example.test", "[::1]", "127.0.0.2", "LOCALHOST.", "funkwhale.example.test"]) {
    assert.equal((await validateHostOrReject(h, { lookup: toLoop })).reason, "private_host", h);
  }
  process.env.FUNKWHALE_URL = "http://funkwhale.example.test:5000";
  try {
    assert.equal((await validateHostOrReject("funkwhale.example.test", { lookup: async () => [{ address: "10.0.0.5", family: 4 }] })).ok, true);
  } finally {
    process.env.FUNKWHALE_URL = `http://127.0.0.1:${port(fw)}`;
  }
});

test("the token goes only to the Funkwhale origin, never across a redirect to another origin", async () => {
  reset();
  const r = await fetchArtwork(redirTo(`http://localhost:${port(evil)}/x.png`), { lookup: async () => [{ address: "127.0.0.1", family: 4 }] });
  assert.deepEqual(r.body, PNG);
  assert.equal(seen.fw[0].auth, "Bearer tok-secret");
  assert.deepEqual(seen.evil, [{ url: "/x.png", auth: null }]);
});

test("redirects are capped", async () => {
  reset();
  assert.equal(await refusedWith(fetchArtwork(fwUrl("/loop"), { maxHops: 3 })), "too_many_redirects");
  assert.equal(seen.fw.length, 4, "the first request plus three redirects");
});

test("images only (SVG refused), bounded in size and time", async () => {
  assert.equal(await refusedWith(fetchArtwork(fwUrl("/page"))), "not_an_image");
  assert.equal(await refusedWith(fetchArtwork(fwUrl("/svg"))), "not_an_image");
  assert.equal(await refusedWith(fetchArtwork(fwUrl("/big-declared"), { maxBytes: 32 * 1024 })), "too_large");
  assert.equal(await refusedWith(fetchArtwork(fwUrl("/big-chunked"), { maxBytes: 32 * 1024 })), "too_large");
  assert.equal(await refusedWith(fetchArtwork(fwUrl("/nope"))), "upstream_404");
  const t0 = Date.now();
  assert.equal(await refusedWith(fetchArtwork(fwUrl("/hang"), { timeoutMs: 300 })), "timeout");
  assert.ok(Date.now() - t0 < 3000, "the deadline covers the whole fetch");
});

test("the route answers with the image and nosniff, or a refusal status", async () => {
  const get = (src) => fetch(`http://127.0.0.1:${port(app)}/api/funkwhale/artwork?src=${encodeURIComponent(src)}`);
  const ok = await get(fwUrl("/cover.png"));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-type"), "image/png");
  assert.equal(ok.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await ok.arrayBuffer()), PNG);
  const meta = await get(redirTo("http://169.254.169.254/latest/meta-data/"));
  assert.equal(meta.status, 403);
  assert.deepEqual(await meta.json(), { error: "private_host" });
  assert.equal((await get(fwUrl("/page"))).status, 415);
  assert.equal((await get("ftp://example.test/x")).status, 400);
  assert.equal((await fetch(`http://127.0.0.1:${port(app)}/api/funkwhale/artwork`)).status, 400);
});
