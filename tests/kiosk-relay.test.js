/**
 * The stream relay, against real HTTP servers on 127.0.0.1. Hosts are made up (example.invalid) and
 * "public" addresses are from the documentation ranges (203.0.113.0/24, 2001:db8::/32). The relay the
 * gateway runs refuses those ranges too, so these tests build theirs with two test-only options:
 *   isPrivate  the production classifier minus the documentation ranges (addressClassifier), so a
 *              made-up public address exists at all;
 *   connect    takes the socket for a made-up public name to the local test server. It replaces the
 *              socket, never a check.
 * Tests that say "production path" use neither.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import * as relayModule from "../bundles/kiosk/server/relay.js";
import { createRelay, isPrivateAddress, addressClassifier, publicHop, serviceHop, localHop, isLocalStreamAddress, hostAddresses, readHostNetwork, judgeAddress, RelayError, MAX_REDIRECTS } from "../bundles/kiosk/server/relay.js";
import { readDefaultRouteInterfaces } from "../bundles/kiosk/server/netscope.js";

/** The production rule without the documentation ranges: what these tests call "public". */
const testClassifier = addressClassifier({ documentation: false });

const servers = [];
after(() => { for (const s of servers) { s.closeAllConnections?.(); s.close(); } });
/** A local HTTP server. → { port, seen: [{ url, headers }], open(): live sockets }. */
async function serve(handler) {
  const seen = [], sockets = new Set();
  const s = http.createServer((req, res) => { seen.push({ url: req.url, method: req.method, headers: req.headers }); handler(req, res, seen.length); });
  s.on("connection", (sock) => { sockets.add(sock); sock.on("close", () => sockets.delete(sock)); });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  servers.push(s);
  return { port: s.address().port, seen, open: () => sockets.size };
}
const audio = (body = "abc", headers = {}) => (req, res) => { res.writeHead(200, { "content-type": "audio/mpeg", ...headers }); res.end(body); };
const redirect = (to) => (req, res) => { res.writeHead(302, { location: typeof to === "function" ? to(req) : to }); res.end(); };
/**
 * names: { "stream.example.invalid": { address: "203.0.113.10" | [..] | () => .., port } }.
 * → { lookup, connect, lookups, dials }: connect goes to the named host's local port.
 */
function world(names) {
  const lookups = [], dials = [];
  return {
    lookups, dials,
    lookup: async (host) => {
      lookups.push(host);
      const e = names[host];
      if (!e) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
      const a = typeof e.address === "function" ? e.address(lookups.filter((h) => h === host).length) : e.address;
      return [].concat(a).map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
    },
    connect: ({ address, port, host }) => { dials.push({ address, port, host }); return net.connect(names[host].port, "127.0.0.1"); },
  };
}
/** A host with no interfaces of note (the tests that are about this host inject their own table). */
const EMPTY_NET = () => ({ own: new Set(), prefixes: [] });
const relayIn = (w, over = {}) => createRelay({ lookup: w.lookup, connect: w.connect, isPrivate: testClassifier, network: EMPTY_NET, ...over });
const codeOf = async (p) => { try { await p; return "ok"; } catch (err) { assert.ok(err instanceof RelayError, String(err)); return err.code; } };
const drain = (body) => new Promise((resolve, reject) => { const c = []; body.on("data", (d) => c.push(d)); body.on("end", () => resolve(Buffer.concat(c).toString())); body.on("error", reject); });
/** A page-facing server that relays every request it gets. → { base, results: [code], revoke() }. */
async function front(relay, upstream) {
  const results = [], ctl = new AbortController();
  const f = await serve(async (req, res) => { results.push(await relay.toResponse(typeof upstream === "function" ? upstream(req) : upstream, req, res, { signal: ctl.signal })); });
  return { base: `http://127.0.0.1:${f.port}`, results, revoke: () => ctl.abort(), open: f.open };
}
const until = async (fn, ms = 2000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error("timed out waiting"); await new Promise((r) => setTimeout(r, 5)); } };

test("address classes (table): everything that is not public unicast is refused — and so is anything that is not an address", () => {
  const NOT_PUBLIC = {
    loopback: ["127.0.0.1", "127.255.255.254", "::1"],
    "this network / unspecified": ["0.0.0.0", "0.1.2.3", "::"],
    "RFC 1918": ["10.1.2.3", "192.168.1.1", "172.16.0.1", "172.31.255.255"],
    "link-local and cloud metadata": ["169.254.169.254", "169.254.0.1", "fe80::1", "fe90::1", "febf::1"],
    "tailnet (CGNAT)": ["100.64.0.1", "100.64.20.5", "100.127.255.255"],
    "protocol, relay and benchmark ranges": ["192.0.0.8", "192.88.99.1", "198.18.0.1", "198.19.255.255", "2001::1", "2001:10::1", "2001:1ff::1"],
    "multicast and reserved": ["224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255", "ff02::1", "ff00::"],
    "unique-local and site-local": ["fc00::1", "fd00::1", "fd12::1", "fec0::1", "feff::1"],
    "IPv4-mapped IPv6 (judged by the IPv4 rules)": ["::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "::ffff:169.254.169.254", "::ffff:100.64.20.5"],
    "IPv4 carried inside IPv6": ["::127.0.0.1", "::7f00:1", "64:ff9b::7f00:1", "64:ff9b::a00:1", "2002:7f00:1::1", "2002:a00:1::"],
    "outside global unicast altogether": ["4000::1", "8000::1", "e000::1", "100::1", "::2", "1::"],
    "a zone id": ["fe80::1%eth0", "2606:4700::1%eth0"],
    "documentation ranges": ["192.0.2.1", "198.51.100.7", "203.0.113.10", "2001:db8::1", "3fff::1", "::ffff:203.0.113.10"],
    "not an address": ["", "not-an-address", "localhost", "1.2.3", "999.1.1.1", "1.2.3.4.5", "[::1]", "0x7f.0.0.1", "2130706433", "127.1", " 127.0.0.1", "127.0.0.1 ", null, undefined, 2130706433, {}, ["127.0.0.1"]],
  };
  for (const [cls, list] of Object.entries(NOT_PUBLIC)) for (const a of list) assert.equal(isPrivateAddress(a), true, `${cls}: ${String(a)}`);
  // The edges of those ranges, one address outside each.
  for (const a of ["172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.1", "198.17.255.255", "198.20.0.1", "192.0.1.1", "169.253.0.1", "169.255.0.1", "223.255.255.255", "126.255.255.255", "128.0.0.1", "11.0.0.1", "9.255.255.255", "2003::1", "3ffe::1", "2001:200::1"]) assert.equal(isPrivateAddress(a), false, a);
  // The tests' own classifier differs from the gateway's in the documentation ranges and in nothing else.
  for (const a of ["203.0.113.10", "198.51.100.7", "192.0.2.1", "2001:db8::1", "::ffff:203.0.113.10"]) assert.deepEqual([isPrivateAddress(a), testClassifier(a)], [true, false], a);
  for (const [cls, list] of Object.entries(NOT_PUBLIC)) if (cls !== "documentation ranges") for (const a of list) assert.equal(testClassifier(a), true, `test classifier, ${cls}: ${String(a)}`);
});

test("the gateway's relay (no options) refuses the documentation ranges too: nothing in production code makes room for a test address", async () => {
  const up = await serve(audio());
  const url = "http://stream.example.invalid/live";
  const w = world({ "stream.example.invalid": { address: "203.0.113.10", port: up.port } });
  assert.equal(await codeOf(createRelay({ lookup: w.lookup, connect: w.connect }).open({ url, hop: publicHop(url) })), "private_address");
  assert.equal(w.dials.length, 0);
});

test("the three policies, written out: a station is public on every hop unless ticked local; a configured service may be private only at its configured origins", async () => {
  assert.deepEqual(publicHop("https://stream.example.invalid/live.mp3"), { origin: "https://stream.example.invalid", redirects: MAX_REDIRECTS, redirectTo: "public", private: "none" });
  const path = /^\/api\/v1\/listen\/[0-9a-f-]{36}\/$/;
  assert.deepEqual(serviceHop({ origin: "http://127.0.0.1:8600/", path, storage: ["http://storage.example.invalid:9000/x"] }), { origin: "http://127.0.0.1:8600", path, redirects: 1, redirectTo: ["http://storage.example.invalid:9000"], private: "named" });
  assert.equal(serviceHop({ origin: "http://127.0.0.1:8600", path }).redirects, 0, "no storage origin: no redirect at all");
  assert.deepEqual(relayModule.localHop("http://radio.lan.example.invalid:8000/live"), { origin: "http://radio.lan.example.invalid:8000", redirects: MAX_REDIRECTS, redirectTo: "public", private: "local", pinned: [] }, "the local-stream policy (spec §13.4)");
  // Hand-built policies that would let "anywhere public" and "private" meet, or that name no rule at all, are not policies.
  const relay = relayIn(world({}));
  const url = "http://192.168.1.20:8000/stream";
  for (const hop of [null, {}, { origin: "file:///etc/passwd", redirectTo: "public", private: "none" }, { origin: "https://stream.example.invalid", private: "none" }, { origin: "https://stream.example.invalid", redirectTo: "public" },
    { origin: "https://stream.example.invalid", redirectTo: "public", private: "none", path: "/x" }, { origin: "http://192.168.1.20:8000", redirects: 3, redirectTo: "public", private: "named" }, { origin: "http://192.168.1.20:8000", redirectTo: "public", private: "entered-host" },
    { origin: "http://user:pw@192.168.1.20:8000", redirectTo: [], private: "named" }, { origin: "http://shed.example.invalid.:8000", redirectTo: [], private: "named" }]) {
    assert.equal(await codeOf(relay.open({ url, hop })), "bad_policy", JSON.stringify(hop));
  }
});

test("bypass forms (table): every way of writing a private or malformed target is refused on the FIRST hop, and nothing is dialled", async () => {
  const up = await serve(audio());
  const w = world({
    "inside.example.invalid": { address: "10.0.0.5", port: up.port },
    "mixed.example.invalid": { address: ["203.0.113.10", "127.0.0.1"], port: up.port },
    "mixed6.example.invalid": { address: ["2001:db8::1", "fe80::1"], port: up.port },
    "mapped.example.invalid": { address: "::ffff:10.0.0.1", port: up.port },
    "nat64.example.invalid": { address: "64:ff9b::a00:1", port: up.port },
    "junk.example.invalid": { address: "not-an-address", port: up.port },
  });
  const relay = relayIn(w);
  const ROWS = [
    ["IPv4-mapped loopback, dotted", "http://[::ffff:127.0.0.1]/x", "private_address"],
    ["IPv4-mapped loopback, hex", "http://[::ffff:7f00:1]/x", "private_address"],
    ["IPv4-mapped RFC 1918", "http://[::ffff:10.0.0.1]/x", "private_address"],
    ["IPv6 loopback", "http://[::1]/x", "private_address"],
    ["IPv6 link-local", "http://[fe80::1]/x", "private_address"],
    ["IPv6 link-local, top of fe80::/10", "http://[febf::1]/x", "private_address"],
    ["IPv6 unique-local", "http://[fd00::1]/x", "private_address"],
    ["unspecified", "http://0.0.0.0/x", "private_address"],
    ["a bare zero", "http://0/x", "private_address"],
    ["decimal IPv4", "http://2130706433/x", "private_address"],
    ["hex IPv4", "http://0x7f.0.0.1/x", "private_address"],
    ["hex IPv4, short", "http://0x7f.1/x", "private_address"],
    ["octal IPv4", "http://017700000001/x", "private_address"],
    ["short IPv4", "http://127.1/x", "private_address"],
    ["cloud metadata", "http://169.254.169.254/latest/meta-data/", "private_address"],
    ["a tailnet address", "http://100.64.20.5:8600/api/v1/users/me/", "private_address"],
    ["loopback with a port", "http://127.0.0.1:8600/api/v1/listen/x/", "private_address"],
    ["a name that resolves private", "https://inside.example.invalid/x", "private_address"],
    ["a name with one public and one private address", "https://mixed.example.invalid/x", "private_address"],
    ["the same over IPv6", "https://mixed6.example.invalid/x", "private_address"],
    ["a name that resolves to a mapped private address", "https://mapped.example.invalid/x", "private_address"],
    ["a name that resolves to NAT64", "https://nat64.example.invalid/x", "private_address"],
    ["a resolver answer that is not an address", "https://junk.example.invalid/x", "private_address"],
    ["a name that does not resolve", "https://nowhere.example.invalid/x", "unresolvable"],
    ["a trailing-dot host", "https://inside.example.invalid./x", "bad_host"],
    ["a trailing-dot loopback name", "http://localhost./x", "bad_host"],
    ["a user name and password", "https://user:pw@stream.example.invalid/x", "userinfo_refused"],
    ["a user name alone", "https://user@stream.example.invalid/x", "userinfo_refused"],
    ["file:", "file:///etc/passwd", "bad_scheme"],
    ["ftp:", "ftp://stream.example.invalid/x", "bad_scheme"],
    ["gopher:", "gopher://stream.example.invalid:70/x", "bad_scheme"],
    ["data:", "data:audio/mpeg;base64,AAAA", "bad_scheme"],
    ["javascript:", "javascript:alert(1)", "bad_scheme"],
    ["not a URL", "//stream.example.invalid/x", "bad_url"],
    ["an empty host", "http:///", "bad_url"],
  ];
  for (const [what, url, code] of ROWS) {
    // The policy is the one a station with exactly this address would get; where no policy can be made of it, a public one for another host.
    const made = publicHop(url);
    const hop = made.origin ? made : { origin: "https://stream.example.invalid", redirects: 0, redirectTo: "public", private: "none" };
    const got = await codeOf(relay.open({ url, hop }));
    assert.ok(got === code || (got === "origin_refused" && !made.origin), `${what} (${url}): ${got}, expected ${code}`);
    assert.notEqual(got, "ok", what);
  }
  assert.equal(up.seen.length, 0);
  assert.equal(w.dials.length, 0, "a refused hop is never dialled");
  // The parser, not the raw string, says what the host is.
  for (const [url, host] of [["http://2130706433/", "127.0.0.1"], ["http://0x7f.1/", "127.0.0.1"], ["http://017700000001/", "127.0.0.1"], ["http://0/", "0.0.0.0"]]) assert.equal(new URL(url).hostname, host);
});

test("bypass forms (table): a public station that REDIRECTS to any of them is refused at that hop — the target is never fetched", async () => {
  const inner = await serve(audio("secret"));
  const TARGETS = [
    ["loopback", `http://127.0.0.1:${inner.port}/x`, "private_address"],
    ["RFC 1918", `http://10.0.0.5:${inner.port}/internal`, "private_address"],
    ["cloud metadata", "http://169.254.169.254/latest/meta-data/", "private_address"],
    ["a tailnet address", `http://100.64.20.5:${inner.port}/api/v1/users/me/`, "private_address"],
    ["IPv6 loopback", "http://[::1]/x", "private_address"],
    ["IPv4-mapped loopback", "http://[::ffff:7f00:1]/x", "private_address"],
    ["decimal IPv4", "http://2130706433/x", "private_address"],
    ["octal IPv4", "http://017700000001/x", "private_address"],
    ["a name that resolves private", "https://inside.example.invalid/x", "private_address"],
    ["a name with a public and a private address", "https://mixed.example.invalid/x", "private_address"],
    ["a trailing-dot host", "https://inside.example.invalid./x", "bad_host"],
    ["a user name and password", "https://user:pw@stream.example.invalid/x", "userinfo_refused"],
    ["file:", "file:///etc/passwd", "bad_scheme"],
    ["ftp:", "ftp://stream.example.invalid/x", "bad_scheme"],
    ["gopher:", "gopher://stream.example.invalid:70/x", "bad_scheme"],
    ["data:", "data:audio/mpeg;base64,AAAA", "bad_scheme"],
  ];
  for (const [what, target, code] of TARGETS) {
    const up = await serve(redirect(target));
    const w = world({ "stream.example.invalid": { address: "203.0.113.10", port: up.port }, "inside.example.invalid": { address: "100.64.20.9", port: inner.port }, "mixed.example.invalid": { address: ["203.0.113.11", "192.168.1.9"], port: inner.port } });
    const url = "https://stream.example.invalid/first";
    assert.equal(await codeOf(relayIn(w).open({ url, hop: publicHop(url) })), code, `${what}: ${target}`);
    assert.equal(w.dials.length, 1, `${what}: only the first hop was dialled`);
  }
  assert.equal(inner.seen.length, 0, "no private hop was ever fetched");
});

test("a public station plays: the name is resolved, every address is public, and the first request goes to the policy's origin or nowhere", async () => {
  const up = await serve(audio());
  const w = world({ "stream.example.invalid": { address: ["203.0.113.10", "2001:db8::10"], port: up.port } });
  const relay = relayIn(w);
  const url = "https://stream.example.invalid/live.mp3";
  const ok = await relay.open({ url, hop: publicHop(url) });
  assert.deepEqual([ok.status, await drain(ok.body), ok.hops], [200, "abc", 0]);
  assert.deepEqual(w.dials, [{ address: "203.0.113.10", port: 443, host: "stream.example.invalid" }]);
  assert.equal(await codeOf(relay.open({ url: "https://other.example.invalid/x", hop: publicHop(url) })), "origin_refused");
  assert.equal(await codeOf(relay.open({ url: "http://stream.example.invalid/live.mp3", hop: publicHop(url) })), "origin_refused", "another scheme is another origin");
  assert.equal(w.dials.length, 1);
});

test("redirects are bounded and well-formed: at most three; none without a location; a relative location resolves; a policy may allow none", async () => {
  const loop = await serve((req, res, n) => redirect(`/r${n}`)(req, res));
  const w = world({ "stream.example.invalid": { address: "203.0.113.10", port: loop.port } });
  const url = "https://stream.example.invalid/a";
  assert.equal(await codeOf(relayIn(w).open({ url, hop: publicHop(url) })), "too_many_redirects");
  assert.equal(loop.seen.length, MAX_REDIRECTS + 1);
  const none = await serve((req, res) => { res.writeHead(302); res.end(); });
  assert.equal(await codeOf(relayIn(world({ "stream.example.invalid": { address: "203.0.113.10", port: none.port } })).open({ url, hop: publicHop(url) })), "bad_redirect");
  const rel = await serve((req, res, n) => (n === 1 ? redirect("../c.mp3")(req, res) : audio("rel")(req, res)));
  const r = await relayIn(world({ "stream.example.invalid": { address: "203.0.113.10", port: rel.port } })).open({ url: "https://stream.example.invalid/a/b", hop: publicHop(url) });
  assert.deepEqual([await drain(r.body), r.hops, rel.seen[1].url], ["rel", 1, "/c.mp3"]);
  const zero = await serve(redirect("/again"));
  assert.equal(await codeOf(relayIn(world({ "stream.example.invalid": { address: "203.0.113.10", port: zero.port } })).open({ url, hop: { ...publicHop(url), redirects: 0 } })), "too_many_redirects", "a policy may allow none");
});

test("a configured service (the credentialed path): first hop only to its origin and path shape, with the credential; exactly one redirect, only to the configured storage origin, WITHOUT the credential", async () => {
  const storage = await serve(audio("track bytes", { "accept-ranges": "bytes" }));
  const lib = await serve(redirect(`http://storage.example.invalid:9000/music/track.mp3?sig=abc`));
  const w = world({ "music.example.invalid": { address: "100.64.20.5", port: lib.port }, "storage.example.invalid": { address: "100.64.20.5", port: storage.port } });
  const path = /^\/api\/v1\/listen\/[0-9a-f-]{36}\/(\?to=mp3)?$/;
  const hop = serviceHop({ origin: "http://music.example.invalid:8600", path, storage: ["http://storage.example.invalid:9000"] });
  const listen = "http://music.example.invalid:8600/api/v1/listen/11111111-2222-3333-4444-555555555555/";
  const up = { url: listen, headers: { Authorization: "Bearer tok-123" }, hop };
  const r = await relayIn(w).open(up, { range: "bytes=0-" });
  assert.deepEqual([r.status, await drain(r.body), r.hops], [200, "track bytes", 1]);
  assert.deepEqual([lib.seen[0].headers.authorization, lib.seen[0].headers.range], ["Bearer tok-123", "bytes=0-"]);
  assert.deepEqual([storage.seen[0].headers.authorization, storage.seen[0].headers.range, storage.seen[0].url], [undefined, "bytes=0-", "/music/track.mp3?sig=abc"], "the storage hop gets the range and never the credential");
  assert.equal((await relayIn(w).open({ ...up, url: `${listen}?to=mp3` })).status, 200);
  // The first hop: another origin, https or another port on the same host, or any other path of the service never leaves the gateway.
  const before = lib.seen.length;
  for (const [url, code] of [["http://music.example.invalid:8600/api/v1/users/me/", "path_refused"], ["http://music.example.invalid:8600/api/v1/listen/../users/me/", "path_refused"], [`${listen}?next=/admin`, "path_refused"],
    [listen.replace("http:", "https:"), "origin_refused"], [listen.replace("music.", "evil."), "origin_refused"], [listen.replace(":8600", ":8601"), "origin_refused"]]) assert.equal(await codeOf(relayIn(w).open({ ...up, url })), code, url);
  assert.equal(lib.seen.length, before, "nothing was sent for a refused first hop");
  // A service reached over https whose storage is plain http: the redirect is a downgrade with a credential attached, and is refused.
  // (A library server is therefore configured at the origin the gateway itself reaches it on, not at a TLS front for it.)
  const tls = serviceHop({ origin: "https://music.example.invalid", path, storage: ["http://storage.example.invalid:9000"] });
  const n = storage.seen.length;
  assert.equal(await codeOf(relayIn(w).open({ url: listen.replace("http://music.example.invalid:8600", "https://music.example.invalid"), headers: { Authorization: "Bearer tok-123" }, hop: tls })), "downgrade_refused");
  assert.equal(storage.seen.length, n);
});

test("a configured service: a redirect anywhere but the storage origin is refused (cloud metadata, loopback, another tailnet address, a public host), and so is a second redirect", async () => {
  const storage = await serve(redirect("http://storage.example.invalid:9000/again"));
  const elsewhere = await serve(audio("never"));
  const path = () => true;
  for (const target of ["http://169.254.169.254/latest/meta-data/", "http://127.0.0.1:8600/api/v1/users/me/", "http://100.64.20.77:9000/x", "https://cdn.example.invalid/x", "http://storage.example.invalid:9001/x", "https://storage.example.invalid:9000/x", "http://music.example.invalid/api/v1/listen/x/"]) {
    const lib = await serve(redirect(target));
    const w = world({ "music.example.invalid": { address: "100.64.20.5", port: lib.port }, "storage.example.invalid": { address: "100.64.20.5", port: storage.port }, "cdn.example.invalid": { address: "203.0.113.20", port: elsewhere.port } });
    const hop = serviceHop({ origin: "http://music.example.invalid", path, storage: ["http://storage.example.invalid:9000"] });
    assert.equal(await codeOf(relayIn(w).open({ url: "http://music.example.invalid/api/v1/listen/x/", headers: { Authorization: "Bearer tok-123" }, hop })), "redirect_refused", target);
    assert.deepEqual(w.dials.map((d) => d.host), ["music.example.invalid"], target);
  }
  assert.equal(elsewhere.seen.length, 0);
  const lib = await serve(redirect("http://storage.example.invalid:9000/one"));
  const w = world({ "music.example.invalid": { address: "100.64.20.5", port: lib.port }, "storage.example.invalid": { address: "100.64.20.5", port: storage.port } });
  assert.equal(await codeOf(relayIn(w).open({ url: "http://music.example.invalid/x", hop: serviceHop({ origin: "http://music.example.invalid", path, storage: ["http://storage.example.invalid:9000"] }) })), "too_many_redirects", "exactly one");
  const none = serviceHop({ origin: "http://music.example.invalid", path });
  assert.equal(await codeOf(relayIn(w).open({ url: "http://music.example.invalid/x", hop: none })), "too_many_redirects", "a service with no storage origin follows none");
});

test("credentials: the first hop only — dropped on ANY redirect (another host, another port, even the same origin); an https to http redirect on a policy that carried one is REFUSED", async () => {
  const seen = [];
  const mk = async (to) => serve((req, res, n) => { seen.push([req.headers.host, req.headers.authorization || null]); return n === 1 && to ? redirect(to)(req, res) : audio()(req, res); });
  const run = async (to, { secure = true } = {}) => {
    seen.length = 0;
    const a = await mk(to), b = await mk(null);
    const w = world({ "music.example.invalid": { address: "203.0.113.5", port: a.port }, "cdn.example.invalid": { address: "203.0.113.6", port: b.port } });
    const url = `${secure ? "https" : "http"}://music.example.invalid/listen/x/`;
    const code = await codeOf(relayIn(w).open({ url, headers: { Authorization: "Bearer tok-123" }, hop: publicHop(url) }).then((r) => { r.body.destroy(); }));
    return { code, auth: seen.map((s) => s[1]) };
  };
  assert.deepEqual(await run("https://cdn.example.invalid/file.mp3"), { code: "ok", auth: ["Bearer tok-123", null] });
  assert.deepEqual(await run("https://music.example.invalid:8443/file.mp3"), { code: "ok", auth: ["Bearer tok-123", null] });
  assert.deepEqual(await run("/elsewhere/file.mp3"), { code: "ok", auth: ["Bearer tok-123", null] }, "even the same origin: the first hop only");
  assert.deepEqual(await run("http://music.example.invalid/listen/x/"), { code: "downgrade_refused", auth: ["Bearer tok-123"] }, "same host, plain http: the token is never re-sent in clear text");
  assert.deepEqual(await run("http://cdn.example.invalid/file.mp3"), { code: "downgrade_refused", auth: ["Bearer tok-123"] });
  assert.deepEqual(await run("https://music.example.invalid/listen/y/", { secure: false }), { code: "ok", auth: ["Bearer tok-123", null] }, "http to https: dropped, not refused");
  // A downgrade LATER in the chain, after the credential is already gone, is refused all the same: the policy carried one.
  {
    seen.length = 0;
    const a = await serve(redirect("https://cdn.example.invalid/one")), b = await serve(redirect("http://cdn.example.invalid/two"));
    const w = world({ "music.example.invalid": { address: "203.0.113.5", port: a.port }, "cdn.example.invalid": { address: "203.0.113.6", port: b.port } });
    const url = "https://music.example.invalid/listen/x/";
    assert.equal(await codeOf(relayIn(w).open({ url, headers: { Authorization: "Bearer tok-123" }, hop: publicHop(url) })), "downgrade_refused");
    assert.deepEqual([a.seen[0].headers.authorization, b.seen[0].headers.authorization, b.seen.length], ["Bearer tok-123", undefined, 1]);
  }
  // With no credential a downgrade is only a redirect, checked like any other hop.
  const a = await serve(redirect("http://cdn.example.invalid/x")), b = await serve(audio("plain"));
  const w = world({ "music.example.invalid": { address: "203.0.113.5", port: a.port }, "cdn.example.invalid": { address: "203.0.113.6", port: b.port } });
  assert.equal(await drain((await relayIn(w).open({ url: "https://music.example.invalid/s", hop: publicHop("https://music.example.invalid/s") })).body), "plain");
  // Only Authorization is a header a source may attach; a Cookie or anything else it puts in headers is never sent.
  const c = await serve(audio());
  const w3 = world({ "music.example.invalid": { address: "203.0.113.5", port: c.port } });
  (await relayIn(w3).open({ url: "https://music.example.invalid/s", headers: { authorization: "Bearer lower", Cookie: "sid=1", "X-Forwarded-For": "127.0.0.1" }, hop: publicHop("https://music.example.invalid/s") })).body.destroy();
  assert.deepEqual([c.seen[0].headers.authorization, c.seen[0].headers.cookie, c.seen[0].headers["x-forwarded-for"]], ["Bearer lower", undefined, undefined]);
});

test("rebinding: a name that answers public and then private is resolved ONCE per hop and dialled at the address that was checked", async () => {
  const up = await serve(audio());
  const w = world({ "flip.example.invalid": { address: (n) => (n === 1 ? "203.0.113.10" : "127.0.0.1"), port: up.port } });
  const url = "http://flip.example.invalid/live";
  (await relayIn(w).open({ url, hop: publicHop(url) })).body.destroy();
  assert.deepEqual(w.lookups, ["flip.example.invalid"], "one resolution for the hop");
  assert.deepEqual(w.dials, [{ address: "203.0.113.10", port: 80, host: "flip.example.invalid" }]);
  // A second request resolves again, sees the private answer, and is refused: a check never rides on an earlier one.
  assert.equal(await codeOf(relayIn(w).open({ url, hop: publicHop(url) })), "private_address");
  assert.equal(w.dials.length, 1);
  // The same on a redirect hop: each hop is one resolution and one checked address.
  const first = await serve(redirect("http://flip2.example.invalid/live")), second = await serve(audio("second"));
  const w2 = world({ "start.example.invalid": { address: "203.0.113.20", port: first.port }, "flip2.example.invalid": { address: (n) => (n === 1 ? "203.0.113.21" : "169.254.169.254"), port: second.port } });
  const u2 = "http://start.example.invalid/a";
  assert.equal(await drain((await relayIn(w2).open({ url: u2, hop: publicHop(u2) })).body), "second");
  assert.deepEqual([w2.lookups, w2.dials.map((d) => d.address)], [["start.example.invalid", "flip2.example.invalid"], ["203.0.113.20", "203.0.113.21"]]);
});

test("production path (no test options): the request's own lookup returns the checked address — the name is not resolved a second time", async () => {
  const up = await serve(audio("pinned"));
  let calls = 0;
  // The second answer is an address nothing listens on; were the name resolved again, the request would fail.
  const lookup = async () => { calls += 1; return [{ address: calls === 1 ? "127.0.0.1" : "192.0.2.99", family: 4 }]; };
  const relay = createRelay({ lookup });
  const origin = `http://library.example.invalid:${up.port}`;
  const r = await relay.open({ url: `${origin}/stream`, hop: serviceHop({ origin, path: /^\/stream$/ }) });
  assert.deepEqual([r.status, await drain(r.body), calls], [200, "pinned", 1]);
  assert.equal(up.seen[0].headers.host, `library.example.invalid:${up.port}`, "the Host header is still the name");
  // An IP literal needs no lookup at all.
  const lit = `http://127.0.0.1:${up.port}`;
  assert.equal(await drain((await createRelay({ lookup: async () => { throw new Error("no lookup for a literal"); } }).open({ url: `${lit}/stream`, hop: serviceHop({ origin: lit, path: /^\/stream$/ }) })).body), "pinned");
  // The same address as a STATION is refused by the same relay: only a configured service reaches a private address.
  // (On the real host 127.0.0.1 is also one of its own addresses, which is said first.)
  assert.ok(["private_address", "own_address"].includes(await codeOf(relay.open({ url: `${lit}/stream`, hop: publicHop(`${lit}/stream`) }))));
});

test("toResponse: audio passes with the caller's Range; what goes upstream and what comes back are allowlists", async () => {
  const up = await serve((req, res) => {
    res.writeHead(req.headers.range ? 206 : 200, { "content-type": "audio/mpeg; charset=x", "content-length": "2", "accept-ranges": "bytes", ...(req.headers.range ? { "content-range": "bytes 0-1/3" } : {}),
      "set-cookie": "sid=1", "icy-name": "A station", "x-powered-by": "x", location: "/x", "access-control-allow-origin": "*" });
    res.end("ab");
  });
  const w = world({ "stream.example.invalid": { address: "203.0.113.10", port: up.port } });
  const url = "https://stream.example.invalid/a.mp3";
  const f = await front(relayIn(w), { url, hop: publicHop(url) });
  const r = await fetch(f.base, { headers: { Range: "bytes=0-1", Cookie: "crow_session=secret", Authorization: "Bearer device-token", "X-Forwarded-For": "10.0.0.1", "Icy-MetaData": "1", Referer: "https://crow.example.invalid/display" } });
  assert.deepEqual([r.status, r.headers.get("content-type"), r.headers.get("content-range"), r.headers.get("accept-ranges"), r.headers.get("content-length"), await r.text()], [206, "audio/mpeg", "bytes 0-1/3", "bytes", "2", "ab"]);
  for (const h of ["set-cookie", "icy-name", "x-powered-by", "location", "access-control-allow-origin"]) assert.equal(r.headers.get(h), null, h);
  assert.deepEqual(Object.keys(up.seen[0].headers).sort(), ["accept", "accept-encoding", "connection", "host", "range", "user-agent"], "nothing of the page's request but its Range goes upstream");
  assert.deepEqual([up.seen[0].headers.range, up.seen[0].headers["accept-encoding"], up.seen[0].headers["user-agent"]], ["bytes=0-1", "identity", "crow-kiosk-relay"]);
  assert.deepEqual(f.results, ["ok"]);
  for (const bad of ["bytes=0-1,5-6", "items=0-1", "bytes=0-1\r\nX-Evil: 1", "bytes=" + "9".repeat(80)]) {
    await (await fetch(f.base, { headers: { Range: bad } }).catch(() => ({ text: async () => "" }))).text();
  }
  assert.ok(up.seen.slice(1).every((s) => s.headers.range === undefined), "a Range that is not one plain byte range is not forwarded");
});

test("toResponse: only audio is relayed — a playlist, a web page, JSON or untyped bytes are 415; an upstream error or a refused hop is a 502 that names nothing", async () => {
  for (const ct of ["application/vnd.apple.mpegurl", "audio/x-mpegurl", "audio/mpegurl", "text/html", "application/json", "application/octet-stream", "video/mp4", ""]) {
    const up = await serve((req, res) => { res.writeHead(200, ct ? { "content-type": ct } : {}); res.end("#EXTM3U"); });
    const w = world({ "stream.example.invalid": { address: "203.0.113.10", port: up.port } });
    const f = await front(relayIn(w), { url: "https://stream.example.invalid/x", hop: publicHop("https://stream.example.invalid/x") });
    const r = await fetch(f.base);
    assert.deepEqual([r.status, await r.text(), f.results[0]], [415, "Not an audio stream", "not_audio"], ct);
  }
  for (const ct of ["audio/mpeg", "audio/aac", "audio/aacp", "audio/ogg", "application/ogg", "audio/flac", "Audio/MPEG"]) {
    const up = await serve((req, res) => { res.writeHead(200, { "content-type": ct }); res.end("x"); });
    const f = await front(relayIn(world({ "stream.example.invalid": { address: "203.0.113.10", port: up.port } })), { url: "https://stream.example.invalid/x", hop: publicHop("https://stream.example.invalid/x") });
    assert.equal((await fetch(f.base)).status, 200, ct);
  }
  const gone = await serve((req, res) => { res.writeHead(404, { "content-type": "audio/mpeg" }); res.end("no"); });
  const f404 = await front(relayIn(world({ "stream.example.invalid": { address: "203.0.113.10", port: gone.port } })), { url: "https://stream.example.invalid/x", hop: publicHop("https://stream.example.invalid/x") });
  const r404 = await fetch(f404.base);
  assert.deepEqual([r404.status, await r404.text(), f404.results[0]], [502, "Upstream unavailable", "upstream_status"]);
  const refused = await front(relayIn(world({ "stream.example.invalid": { address: "10.0.0.5", port: gone.port } })), { url: "https://stream.example.invalid/x", hop: publicHop("https://stream.example.invalid/x") });
  const rr = await fetch(refused.base);
  const body = await rr.text();
  assert.deepEqual([rr.status, refused.results[0]], [502, "private_address"]);
  assert.ok(!body.includes("10.0.0.5") && !body.includes("example.invalid") && !body.includes("private"), "the reason is for the log, never for the page");
  const dead = await front(relayIn(world({})), { url: "https://stream.example.invalid/x", hop: publicHop("https://stream.example.invalid/x") });
  assert.equal((await fetch(dead.base)).status, 502);
});

test("only GET: HEAD, POST and the rest are 405 and open no upstream at all", async () => {
  const up = await serve(audio());
  const w = world({ "stream.example.invalid": { address: "203.0.113.10", port: up.port } });
  const f = await front(relayIn(w), { url: "https://stream.example.invalid/x", hop: publicHop("https://stream.example.invalid/x") });
  for (const method of ["HEAD", "POST", "PUT", "DELETE", "OPTIONS"]) {
    const r = await fetch(f.base, { method });
    assert.deepEqual([r.status, r.headers.get("allow")], [405, "GET"], method);
  }
  assert.deepEqual([up.seen.length, w.dials.length, w.lookups.length], [0, 0, 0]);
  assert.ok(f.results.every((c) => c === "method"));
});

test("an upstream that accepts the connection and never answers is given up after the header timeout, and its socket is closed", async () => {
  const silent = await serve(() => { /* never answers */ });
  const w = world({ "stream.example.invalid": { address: "203.0.113.10", port: silent.port } });
  const relay = relayIn(w, { headersTimeoutMs: 120 });
  const url = "https://stream.example.invalid/x";
  const t0 = Date.now();
  assert.equal(await codeOf(relay.open({ url, hop: publicHop(url) })), "headers_timeout");
  assert.ok(Date.now() - t0 < 1500, "not left pending");
  await until(() => silent.open() === 0);
  // The deadline covers the whole way there: a slow redirect chain does not get a fresh clock per hop.
  const slow = await serve((req, res, n) => setTimeout(() => redirect(`/r${n}`)(req, res), 70));
  assert.equal(await codeOf(relayIn(world({ "stream.example.invalid": { address: "203.0.113.10", port: slow.port } }), { headersTimeoutMs: 120 }).open({ url, hop: publicHop(url) })), "headers_timeout");
  const f = await front(relay, { url, hop: publicHop(url) });
  const r = await fetch(f.base);
  assert.deepEqual([r.status, f.results[0]], [502, "headers_timeout"]);
  // A resolver that never answers is covered by the same deadline.
  assert.equal(await codeOf(createRelay({ lookup: () => new Promise(() => {}), headersTimeoutMs: 80 }).open({ url, hop: publicHop(url) })), "headers_timeout");
});

test("a stream that stops moving is let go after the idle timeout: the page's request ends and the upstream socket is closed", async () => {
  const stall = await serve((req, res) => { res.writeHead(200, { "content-type": "audio/mpeg" }); res.write("some audio"); /* …and then nothing */ });
  const w = world({ "stream.example.invalid": { address: "203.0.113.10", port: stall.port } });
  const f = await front(relayIn(w, { bodyIdleMs: 100 }), { url: "https://stream.example.invalid/x", hop: publicHop("https://stream.example.invalid/x") });
  const r = await fetch(f.base);
  assert.equal(r.status, 200);
  const t0 = Date.now();
  await assert.rejects(r.text(), "the body is cut, not left open");
  assert.ok(Date.now() - t0 < 1500);
  await until(() => stall.open() === 0);
  // A stream that keeps moving outlives several idle periods (a wide idle so a loaded host's timer slip is not a stall).
  let timer = null;
  const live = await serve((req, res) => { res.writeHead(200, { "content-type": "audio/mpeg" }); let n = 0; timer = setInterval(() => { n += 1; res.write("x"); if (n === 8) { clearInterval(timer); res.end(); } }, 150); });
  const f2 = await front(relayIn(world({ "stream.example.invalid": { address: "203.0.113.10", port: live.port } }), { bodyIdleMs: 600 }), { url: "https://stream.example.invalid/x", hop: publicHop("https://stream.example.invalid/x") });
  assert.equal(await (await fetch(f2.base)).text(), "xxxxxxxx");
});

test("the page going away, or the ticket being revoked, releases the upstream at once", async () => {
  const endless = () => serve((req, res) => { res.writeHead(200, { "content-type": "audio/mpeg" }); const t = setInterval(() => res.write("x".repeat(512)), 10); res.on("close", () => clearInterval(t)); });
  const a = await endless();
  const fa = await front(relayIn(world({ "stream.example.invalid": { address: "203.0.113.10", port: a.port } })), { url: "https://stream.example.invalid/x", hop: publicHop("https://stream.example.invalid/x") });
  const ctl = new AbortController();
  const r = await fetch(fa.base, { signal: ctl.signal });
  const reader = r.body.getReader();
  await reader.read();
  assert.equal(a.open(), 1);
  ctl.abort();
  await until(() => a.open() === 0);
  const b = await endless();
  const fb = await front(relayIn(world({ "stream.example.invalid": { address: "203.0.113.10", port: b.port } })), { url: "https://stream.example.invalid/x", hop: publicHop("https://stream.example.invalid/x") });
  const r2 = await fetch(fb.base);
  const rd = r2.body.getReader();
  await rd.read();
  const t0 = Date.now();
  fb.revoke();
  await assert.rejects((async () => { for (;;) { const { done } = await rd.read(); if (done) throw new Error("ended"); } })());
  assert.ok(Date.now() - t0 < 1000, "the page's stream ends with the ticket");
  await until(() => b.open() === 0);
  // Revoked before the upstream answered: nothing is relayed.
  const c = await serve(() => {});
  const fc = await front(relayIn(world({ "stream.example.invalid": { address: "203.0.113.10", port: c.port } })), { url: "https://stream.example.invalid/x", hop: publicHop("https://stream.example.invalid/x") });
  const pending = fetch(fc.base).then((x) => x.status, () => "cut");
  await until(() => c.seen.length === 1);
  fc.revoke();
  assert.ok([502, "cut"].includes(await pending));
  await until(() => c.open() === 0);
});

test("probe: an audio stream is ok with its type; a playlist, a web page, a private address and a dead address are not — and the body is never read", async () => {
  let wrote = 0;
  const up = await serve((req, res) => { res.writeHead(200, { "content-type": req.url === "/list" ? "audio/x-mpegurl" : req.url === "/page" ? "text/html" : "audio/aac" }); const t = setInterval(() => { wrote += 1; res.write("x"); }, 5); res.on("close", () => clearInterval(t)); });
  const w = world({ "stream.example.invalid": { address: "203.0.113.10", port: up.port }, "inside.example.invalid": { address: "192.168.1.9", port: up.port } });
  const relay = relayIn(w);
  const probe = (url, hop = publicHop(url)) => relay.probe({ url, hop });
  assert.deepEqual(await probe("https://stream.example.invalid/live"), { ok: true, content_type: "audio/aac" });
  assert.deepEqual(await probe("https://stream.example.invalid/list"), { ok: false, error: "not_audio", content_type: "audio/x-mpegurl" });
  assert.deepEqual(await probe("https://stream.example.invalid/page"), { ok: false, error: "not_audio", content_type: "text/html" });
  assert.deepEqual(await probe("https://inside.example.invalid/live"), { ok: false, error: "private_address" });
  assert.deepEqual(await probe("http://192.168.1.9/live"), { ok: false, error: "private_address" });
  assert.deepEqual(await probe("ftp://stream.example.invalid/live", { origin: "https://stream.example.invalid", redirects: 0, redirectTo: "public", private: "none" }), { ok: false, error: "bad_url" });
  assert.deepEqual(await probe("https://user:pw@stream.example.invalid/live"), { ok: false, error: "bad_url" });
  assert.deepEqual(await probe("https://nowhere.example.invalid/live"), { ok: false, error: "unreachable" });
  await until(() => up.open() === 0);
  assert.ok(wrote < 200, "the stream was dropped after its headers");
});

// ── this host's own network, and home-network ("local stream") stations: spec §13.4 ─────────────
/**
 * An injected host (never the real one): eth0 carries the default route (the home LAN, with an IPv4 /24,
 * a /16, a /16 and a ULA and a global IPv6 /64), docker0 and a br- bridge and a thunderbolt link are
 * other interfaces, tailscale0 has host routes only (its peers are the tailnet ranges).
 */
const HOST = {
  lo: [{ address: "127.0.0.1", cidr: "127.0.0.1/8" }, { address: "::1", cidr: "::1/128" }],
  eth0: [{ address: "192.168.1.2", cidr: "192.168.1.2/24" }, { address: "10.1.0.2", cidr: "10.1.0.2/16" }, { address: "172.20.0.2", cidr: "172.20.0.2/16" },
    { address: "fd00::2", cidr: "fd00::2/64" }, { address: "2001:db8:1::5", cidr: "2001:db8:1::5/64" }, { address: "fe80::2", cidr: "fe80::2/64" }],
  docker0: [{ address: "172.17.0.1", cidr: "172.17.0.1/16" }],
  "br-3f2a": [{ address: "192.168.250.1", cidr: "192.168.250.1/24" }, { address: "192.168.16.1", cidr: "192.168.16.1/20" }],
  thunderbolt0: [{ address: "10.99.0.1", cidr: "10.99.0.1/30" }],
  tailscale0: [{ address: "100.64.20.9", cidr: "100.64.20.9/32" }, { address: "fd7a:115c:a1e0::9", cidr: "fd7a:115c:a1e0::9/128" }],
};
const hostNet = () => readHostNetwork({ interfaces: () => HOST, defaults: () => new Set(["eth0"]) });

test("this host (re-review F1/F2): its own addresses and every interface's on-link prefix are never public — on every hop of every policy, ticked or not", async () => {
  const net = hostNet();
  assert.equal(net.prefixes.find((p) => p.name === "eth0").lan, true);
  assert.equal(net.prefixes.find((p) => p.name === "docker0").lan, false);
  for (const [a, code] of [["2001:db8:1::5", "own_address"], ["192.168.1.2", "own_address"], ["100.64.20.9", "own_address"], ["::ffff:192.168.1.2", "own_address"],
    ["2001:db8:1::99", "private_address"], ["2001:db8:1::1", "private_address"], ["172.17.0.2", "private_address"], ["192.168.250.7", "private_address"]]) {
    assert.equal(judgeAddress(a, net, { local: false, isNotPublic: testClassifier }), code, `public rule: ${a}`);
  }
  assert.equal(judgeAddress("203.0.113.10", net, { local: false, isNotPublic: testClassifier }), null, "an outside address is public");
  // A public station whose server redirects to this host's global IPv6, or to a neighbour on its /64, or to a container: refused, never dialled.
  const inner = await serve(audio("inside"));
  for (const [target, code] of [["http://[2001:db8:1::5]:8123/", "own_address"], ["http://[2001:db8:1::1]/", "private_address"], ["http://172.17.0.2:9000/", "private_address"], ["http://192.168.1.2:3001/", "own_address"]]) {
    const up = await serve(redirect(target));
    const w = world({ "stream.example.invalid": { address: "203.0.113.10", port: up.port } });
    const url = "https://stream.example.invalid/first";
    assert.equal(await codeOf(relayIn(w, { network: hostNet }).open({ url, hop: publicHop(url) })), code, target);
    assert.equal(w.dials.length, 1, `${target}: only the first hop was dialled`);
  }
  assert.equal(inner.seen.length, 0);
  // A local station's redirect to "public" this-host is refused the same way.
  const lanUp = await serve(redirect("http://[2001:db8:1::5]:8123/"));
  const wl = world({ "radio.lan.example.invalid": { address: "192.168.1.40", port: lanUp.port } });
  const lu = `http://radio.lan.example.invalid:${lanUp.port}/live`;
  assert.equal(await codeOf(relayIn(wl, { network: hostNet }).open({ url: lu, hop: localHop(lu, ["192.168.1.40"]) })), "own_address");
  // A service's configured origins (its loopback library, its storage on this host's tailnet address) stay reachable.
  const lib = await serve(audio("library"));
  const svc = `http://127.0.0.1:${lib.port}`;
  assert.equal(await drain((await createRelay({ network: hostNet }).open({ url: `${svc}/s`, hop: serviceHop({ origin: svc, path: /^\/s$/ }) })).body), "library");
});

test("default-route interfaces are read from the kernel's routing tables (IPv4 and IPv6, never a reject route)", () => {
  const files = {
    "/proc/net/route": "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\neth0\t00000000\t0101A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0\neth0\t0001A8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF\t0\t0\t0\ndocker0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0\n",
    "/proc/net/ipv6_route": "00000000000000000000000000000000 00 00000000000000000000000000000000 00 00000000000000000000000000000000 ffffffff 00000001 00000000 00200200       lo\n00000000000000000000000000000000 00 00000000000000000000000000000000 00 fe800000000000000000000000000001 00000067 00000021 00000000 00000003     wlan0\n",
  };
  assert.deepEqual([...readDefaultRouteInterfaces((f) => files[f])].sort(), ["eth0", "wlan0"]);
  assert.deepEqual([...readDefaultRouteInterfaces(() => { throw new Error("no proc"); })], [], "unreadable: nothing is the LAN (fail closed)");
});

test("local stream (table): with the tick the ENTERED host may be on the home LAN (the default-route interface's prefixes) or the tailnet; nothing else", async () => {
  const net = hostNet();
  const ok = (a) => judgeAddress(a, net, { local: true, isNotPublic: testClassifier });
  const ALLOWED = [["home LAN /24", "192.168.1.40"], ["home LAN /16", "10.1.2.3"], ["home LAN 172.20/16", "172.20.0.5"], ["home LAN ULA", "fd00::5"], ["home LAN global IPv6 /64", "2001:db8:1::77"],
    ["a tailnet peer", "100.101.102.103"], ["a tailnet peer, IPv6", "fd7a:115c:a1e0::77"],
    ["the IPv4-mapped spelling of a LAN host (it IS that IPv4 host; translated forms are refused below)", "::ffff:192.168.1.40"]];
  for (const [what, a] of ALLOWED) assert.equal(ok(a), null, what);
  const REFUSED = [
    ["docker0 container", "172.17.0.2"], ["a br- bridge container", "192.168.250.2"], ["a 192.168.16.0/20 bridge", "192.168.18.4"], ["the thunderbolt peer", "10.99.0.2"],
    ["RFC 1918 not on any interface", "10.200.0.5"], ["ULA not on the LAN", "fd99::1"], ["a public address (a ticked host must stay local)", "203.0.113.10"],
    ["the LAN /24's network address", "192.168.1.0"], ["the LAN /24's broadcast", "192.168.1.255"],
    ["loopback", "127.0.0.1"], ["loopback, other", "127.8.9.10"], ["IPv6 loopback", "::1"], ["link-local (cloud metadata)", "169.254.169.254"], ["IPv6 link-local", "fe80::1"], ["IPv6 link-local, top of fe80::/10", "febf::1"],
    ["site-local fec0::/10", "fec0::1"], ["this network", "0.0.0.0"], ["this network, other", "0.1.2.3"], ["multicast", "224.0.0.1"], ["IPv6 multicast", "ff02::1"], ["broadcast", "255.255.255.255"], ["reserved", "240.0.0.1"],
    ["IPv4-mapped loopback", "::ffff:127.0.0.1"], ["IPv4-mapped metadata", "::ffff:169.254.169.254"], ["SIIT of the LAN", "::ffff:0:c0a8:128"],
    ["NAT64 of the LAN", "64:ff9b::c0a8:128"], ["NAT64 local-use", "64:ff9b:1::a01:203"], ["6to4 of loopback", "2002:7f00:1::1"], ["Teredo", "2001:0:4136:e378:8000:63bf:3fff:fdd2"], ["IPv4-compatible", "::c0a8:128"],
    ["this host on the LAN", "192.168.1.2"], ["this host on the tailnet", "100.64.20.9"], ["this host's tailnet IPv6", "fd7a:115c:a1e0::9"], ["this host's global IPv6", "2001:db8:1::5"],
  ];
  for (const [what, a] of REFUSED) assert.notEqual(ok(a), null, `${what} (${a}) with the tick`);
  // Through the relay: allowed with the tick (and the pinned set), refused without it.
  const up = await serve(audio("lan audio"));
  const w = world({ "lan.example.invalid": { address: "192.168.1.40", port: up.port } });
  const url = `http://lan.example.invalid:${up.port}/live`;
  assert.equal(await drain((await relayIn(w, { network: hostNet }).open({ url, hop: localHop(url, ["192.168.1.40"]) })).body), "lan audio");
  assert.equal(await codeOf(relayIn(w, { network: hostNet }).open({ url, hop: publicHop(url) })), "private_address", "without the tick");
  // Literal hosts too.
  for (const lit of ["http://127.0.0.1:9/x", "http://[::1]:9/x", "http://169.254.169.254/latest/meta-data/", "http://[::ffff:7f00:1]/x", "http://0x7f.1/x", "http://172.17.0.2:9000/x", "http://192.168.1.2:3001/x"]) {
    const got = await codeOf(relayIn(world({}), { network: hostNet }).open({ url: lit, hop: localHop(lit, [new URL(lit).hostname.replace(/^\[|\]$/g, "")]) }));
    assert.ok(got === "private_address" || got === "own_address", `${lit}: ${got}`);
  }
});

test("local stream (F3): a ticked name must resolve inside the address set recorded at Save; a new answer is 'address_changed', even an allowed one", async () => {
  const up = await serve(audio("lan audio"));
  let answer = "192.168.1.40";
  const w = world({ "radio.lan.example.invalid": { address: () => answer, port: up.port } });
  const url = `http://radio.lan.example.invalid:${up.port}/live`;
  const relay = relayIn(w, { network: hostNet });
  assert.equal(await drain((await relay.open({ url, hop: localHop(url, ["192.168.1.40"]) })).body), "lan audio");
  answer = "192.168.1.41";                                  // a different LAN host: refused until the operator saves again
  assert.equal(await codeOf(relay.open({ url, hop: localHop(url, ["192.168.1.40"]) })), "address_changed");
  answer = "203.0.113.10";                                  // a public answer for a ticked name: refused
  assert.equal(await codeOf(relay.open({ url, hop: localHop(url, ["192.168.1.40"]) })), "address_changed");
  assert.equal(await codeOf(relay.open({ url, hop: localHop(url, []) })), "address_changed", "no recorded set: nothing plays");
  // checkLocal (Save/Test): every answer judged by the home-network rule; the set is returned.
  answer = "192.168.1.40";
  assert.deepEqual(await relay.checkLocal(url), { ok: true, addrs: ["192.168.1.40"] });
  const w2 = world({ "mixed.lan.example.invalid": { address: ["192.168.1.40", "203.0.113.10"], port: up.port }, "box.lan.example.invalid": { address: "172.17.0.2", port: up.port } });
  const r2 = relayIn(w2, { network: hostNet });
  assert.deepEqual(await r2.checkLocal("http://mixed.lan.example.invalid/live"), { ok: false, error: "private_address" }, "one public answer refuses a ticked name");
  assert.deepEqual(await r2.checkLocal("http://box.lan.example.invalid/live"), { ok: false, error: "private_address" }, "a container is not the home network");
  assert.deepEqual(await r2.checkLocal("http://192.168.1.2:3001/x"), { ok: false, error: "own_address" });
  assert.deepEqual(await r2.checkLocal("http://nowhere.example.invalid/x"), { ok: false, error: "unreachable" });
});

test("local stream: redirects may go to the SAME host:port (never down from https) or to a public address, never to another private host; the cap holds; no credential is ever sent; the dialled address is the checked one", async () => {
  const target = await serve(audio("ok"));
  let to = null;
  const lan = await serve((req, res) => { if (req.url === "/final") { res.writeHead(200, { "content-type": "audio/mpeg" }); res.end("same host"); } else { res.writeHead(302, { location: to }); res.end(); } });
  const w = world({
    "radio.lan.example.invalid": { address: "192.168.1.40", port: lan.port },
    "other.lan.example.invalid": { address: "192.168.1.41", port: target.port },
    "tailnet.example.invalid": { address: "100.101.102.104", port: target.port },
    "stream.example.invalid": { address: "203.0.113.10", port: target.port },
  });
  const relay = relayIn(w, { network: hostNet });
  const url = `http://radio.lan.example.invalid:${lan.port}/live`;
  const hop = localHop(url, ["192.168.1.40"]);
  to = `http://radio.lan.example.invalid:${lan.port}/final`;
  const same = await relay.open({ url, hop, headers: { Authorization: "Bearer must-not-go" } });
  assert.equal(await drain(same.body), "same host");
  assert.ok(lan.seen.every((x) => !x.headers.authorization), "no credential on a local stream, even if one was passed");
  assert.ok(w.dials.filter((d) => d.host === "radio.lan.example.invalid").every((d) => d.address === "192.168.1.40"), "connected to the checked address");
  to = "https://stream.example.invalid/public.mp3";
  assert.equal(await drain((await relay.open({ url, hop })).body), "ok");
  for (const [what, loc] of [["another LAN host", "http://other.lan.example.invalid/x"], ["a tailnet host", "http://tailnet.example.invalid/x"], ["the same host on another port", `http://radio.lan.example.invalid:${lan.port + 1}/x`],
    ["loopback", "http://127.0.0.1/x"], ["cloud metadata", "http://169.254.169.254/latest/meta-data/"], ["a container", "http://172.17.0.2:9000/"]]) {
    to = loc;
    assert.ok(["private_address", "own_address"].includes(await codeOf(relay.open({ url, hop }))), what);
  }
  to = url;
  assert.equal(await codeOf(relay.open({ url, hop })), "too_many_redirects");
  const page = await serve((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<html>"); });
  const w2 = world({ "page.lan.example.invalid": { address: "10.1.9.9", port: page.port } });
  const pu = `http://page.lan.example.invalid:${page.port}/`;
  const f = await front(relayIn(w2, { network: hostNet }), { url: pu, hop: localHop(pu, ["10.1.9.9"]) });
  assert.equal((await fetch(f.base)).status, 415);
  assert.deepEqual(await relayIn(w2, { network: hostNet }).probe({ url: pu, hop: localHop(pu, ["10.1.9.9"]) }), { ok: false, error: "not_audio" }, "a LAN target's other content types are not echoed");
});

test("local stream: the policy cannot be combined with a list of origins; the classifier is the shared one, stricter on embedded public IPv4", async () => {
  const relay = createRelay({ network: EMPTY_NET });
  assert.equal(await codeOf(relay.open({ url: "http://10.1.2.3/x", hop: { origin: "http://10.1.2.3", redirects: 1, redirectTo: ["http://10.1.2.4"], private: "local" } })), "bad_policy");
  for (const a of ["::ffff:0:808:808", "::808:808", "64:ff9b::808:808", "2002:808:808::", "2001:0:4136:e378:8000:63bf:f7f7:f7f7"]) assert.equal(isPrivateAddress(a), true, `${a}: a disguised public IPv4 is refused`);
  assert.equal(isPrivateAddress("::ffff:8.8.8.8"), false, "the plain mapped form of a public IPv4 is that address");
  assert.equal(isLocalStreamAddress("fec0::1"), false, "site-local is not home network");
  assert.ok(hostAddresses().has("127.0.0.1"), "this host's own addresses come from its interfaces");
});
