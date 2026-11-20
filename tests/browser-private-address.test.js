// The bot browser runs with host networking, so a page it is sent to can reach
// 127.0.0.1 services, the tailnet, the LAN and cloud metadata. These tests pin
// the private-address rules the browser add-on refuses on, in every spelling an
// address can be written in, plus the Playwright guard and the node-side fetch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import {
  classifyIp,
  parseHost,
  parseExceptions,
  checkUrl,
  refusalResult,
  installPrivateAddressGuard,
  GUARD_MARKER,
  blankPagesOnExit,
  blankPageSafely,
  guardedFetch,
  resolveChecked,
  pinnedLookup,
  exceptionsFromEnv,
} from "../bundles/browser/server/private-address.js";
import { addExitTask, runExitTasks } from "../bundles/browser/server/exit-tasks.js";

const SERVER_JS = new URL("../bundles/browser/server/server.js", import.meta.url);
const MANIFEST = new URL("../bundles/browser/manifest.json", import.meta.url);

// ---------------------------------------------------------------------------
// fakes (Playwright is not installed for the test suite)
// ---------------------------------------------------------------------------

const flush = () => new Promise((r) => setTimeout(r, 0));

/** A resolver stub: a map of host -> addresses | Error | function, with a call counter. */
function resolverFor(map) {
  const counter = { calls: 0, hosts: [] };
  const resolve = async (host) => {
    counter.calls += 1;
    counter.hosts.push(host);
    const answer = map[host];
    if (answer instanceof Error) throw answer;
    if (typeof answer === "function") return answer(host);
    if (answer === undefined) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    return answer;
  };
  return { resolve, counter };
}

function fakeGuardContext() {
  const routes = [];
  const wsRoutes = [];
  const listeners = new Map();
  const initScripts = [];
  return {
    routes,
    wsRoutes,
    listeners,
    initScripts,
    route(pattern, handler) { routes.push({ pattern, handler }); },
    routeWebSocket(pattern, handler) { wsRoutes.push({ pattern, handler }); },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
    },
    addInitScript(script) { initScripts.push(script); },
  };
}

function fakeRoute(url) {
  const calls = [];
  const request = {
    url: () => url,
    method: () => "GET",
    resourceType: () => "document",
    isNavigationRequest: () => true,
  };
  return {
    calls,
    request: () => request,
    async continue() { calls.push({ kind: "continue" }); },
    async abort(code) { calls.push({ kind: "abort", code }); },
  };
}

/** Run the recorded catch-all route handler the way Playwright would. */
async function callRoute(handler, url) {
  const route = fakeRoute(url);
  await handler(route, route.request());
  return route;
}

/** Run the recorded websocket route handler the way Playwright would. */
async function callWs(handler, url) {
  const calls = [];
  const ws = {
    calls,
    url: () => url,
    async close(...args) { calls.push({ kind: "close", args }); },
    async connectToServer() { calls.push({ kind: "connect" }); },
  };
  await handler(ws);
  return ws;
}

function fakeResponse({ url, serverAddr }) {
  const rec = { gotos: [] };
  const page = { goto: async (target) => { rec.gotos.push(target); } };
  const frame = { page: () => page };
  return {
    rec,
    url: () => url,
    serverAddr: async () => serverAddr,
    frame: () => frame,
  };
}

/** fetchImpl stub routing on the exact URL. */
function fakeFetchRouter(routes) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    const answer = routes[String(url)];
    if (!answer) throw new Error(`unexpected fetch: ${url}`);
    return typeof answer === "function" ? answer() : answer;
  };
  return { impl, calls };
}

// ---------------------------------------------------------------------------
// classifyIp
// ---------------------------------------------------------------------------

test("classifyIp names every non-public range, in every spelling", () => {
  const blocked = [
    // IPv4
    ["0.0.0.0", /unspecified/i],
    ["0.255.255.255", /unspecified/i],
    ["127.0.0.1", /loopback/i],
    ["127.255.255.254", /loopback/i],
    ["10.0.0.1", /private/i],
    ["10.255.255.255", /private/i],
    ["172.16.0.1", /private/i],
    ["172.31.255.255", /private/i],
    ["192.168.1.1", /private/i],
    ["192.168.255.255", /private/i],
    ["100.64.0.1", /tailnet|cgnat|carrier/i],
    ["100.127.255.255", /tailnet|cgnat|carrier/i],
    ["169.254.1.1", /link.?local/i],
    ["169.254.255.255", /link.?local/i],
    ["198.18.0.1", /reserved|benchmark/i],
    ["198.19.255.255", /reserved|benchmark/i],
    ["224.0.0.1", /multicast/i],
    ["239.255.255.255", /multicast/i],
    ["240.0.0.1", /reserved|multicast/i],
    ["255.255.255.255", /reserved|multicast/i],
    // IPv6
    ["::", /unspecified/i],
    ["::1", /loopback/i],
    ["[::1]", /loopback/i],
    ["fe80::1", /link.?local/i],
    ["FE80::ABCD", /link.?local/i],
    ["fe80::1%eth0", /link.?local/i],
    ["fec0::1", /site.?local/i],
    ["fc00::1", /unique.?local|private/i],
    ["fd12:3456::1", /unique.?local|private/i],
    ["ff02::1", /multicast/i],
    ["ff05::1:3", /multicast/i],
    // IPv4-mapped
    ["::ffff:127.0.0.1", /loopback/i],
    ["::ffff:7f00:1", /loopback/i],
    ["::FFFF:10.0.0.1", /private/i],
    ["::ffff:c0a8:101", /private/i],
    ["0:0:0:0:0:ffff:100.64.0.1", /tailnet|cgnat|carrier/i],
    // IPv4-compatible / NAT64 / 6to4
    ["::10.0.0.1", /private/i],
    ["64:ff9b::7f00:1", /loopback/i],
    ["2002:7f00:1::1", /loopback/i],
    // cloud metadata
    ["169.254.169.254", /metadata/i],
    ["::ffff:169.254.169.254", /metadata/i],
    ["fd00:ec2::254", /metadata/i],
    ["fd00:ec2::1", /metadata/i],
    ["100.100.100.200", /metadata/i],
  ];
  for (const [ip, reason] of blocked) assert.match(String(classifyIp(ip)), reason, ip);
});

test("classifyIp returns null for public addresses", () => {
  for (const ip of [
    "8.8.8.8",
    "1.1.1.1",
    "172.15.255.255",
    "172.32.0.1",
    "100.63.255.255",
    "100.128.0.1",
    "192.167.1.1",
    "169.253.1.1",
    "2606:4700:4700::1111",
    "::ffff:8.8.8.8",
    "64:ff9b::808:808",
    "2002:808:808::1",
  ]) assert.equal(classifyIp(ip), null, ip);
});

test("classifyIp refuses the reserved, documentation, Teredo, discard and local-use NAT64 ranges", () => {
  const blocked = [
    // 192.0.0.0/24: metadata at .192, reserved everywhere else
    ["192.0.0.0", /reserved/i],
    ["192.0.0.1", /reserved/i],
    ["192.0.0.192", /metadata/i],
    ["192.0.0.255", /reserved/i],
    // documentation ranges
    ["192.0.2.0", /documentation/i],
    ["192.0.2.1", /documentation/i],
    ["192.0.2.255", /documentation/i],
    ["198.51.100.0", /documentation/i],
    ["198.51.100.1", /documentation/i],
    ["198.51.100.255", /documentation/i],
    ["203.0.113.0", /documentation/i],
    ["203.0.113.1", /documentation/i],
    ["203.0.113.255", /documentation/i],
    // 6to4 relay anycast
    ["192.88.99.0", /reserved/i],
    ["192.88.99.1", /reserved/i],
    ["192.88.99.255", /reserved/i],
    // IPv6 documentation, Teredo and discard
    ["2001:db8::", /documentation/i],
    ["2001:db8::1", /documentation/i],
    ["2001:db8:ffff:ffff:ffff:ffff:ffff:ffff", /documentation/i],
    ["2001::1", /teredo|reserved/i],
    ["2001:0:4136:e378:8000:63bf:3fff:fdd2", /teredo|reserved/i],
    ["100::", /discard/i],
    ["100::1", /discard/i],
    ["100::ffff:ffff:ffff:ffff", /discard/i],
    // 64:ff9b:1::/48 is judged by the IPv4 address in its low 32 bits
    ["64:ff9b:1::7f00:1", /loopback/i],
    ["64:ff9b:1::a00:1", /private/i],
    ["64:ff9b:1::", /unspecified|reserved/i],
  ];
  for (const [ip, reason] of blocked) assert.match(String(classifyIp(ip)), reason, ip);
});

test("classifyIp still allows the addresses just outside those ranges", () => {
  for (const ip of [
    "192.0.1.1",
    "192.0.3.1",
    "198.51.99.1",
    "198.51.101.1",
    "203.0.112.1",
    "203.0.114.1",
    "192.88.98.1",
    "192.88.100.1",
    "2001:db7::1",
    "2001:db9::1",
    "101::1",
    "64:ff9b:2::808:808",
    "64:ff9b:1::808:808",
  ]) assert.equal(classifyIp(ip), null, ip);
});

test("classifyIp throws a TypeError for input that is not an address", () => {
  for (const bad of ["", "example.com", "not an ip", "1.2.3.4.5", "256.1.1.1", "::gg", "127.0.0.1/8"]) {
    assert.throws(() => classifyIp(bad), TypeError, bad);
  }
});

test("classifyIp judges SIIT and ISATAP forms by the IPv4 address they carry", () => {
  for (const [ip, reason] of [
    // ::ffff:0:0:0/96 (SIIT / IPv4-translated)
    ["::ffff:0:7f00:1", /loopback/i],
    ["::ffff:0:10.0.0.1", /private/i],
    ["::ffff:0:c0a8:101", /private/i],
    ["::ffff:0:a9fe:a9fe", /metadata/i],
    // ISATAP: interface id 0000:5efe:a.b.c.d or 0200:5efe:a.b.c.d, any prefix
    ["2001:db9::5efe:7f00:1", /loopback/i],
    ["2001:db9::5efe:a00:1", /private/i],
    ["2001:db9:0:0:200:5efe:7f00:1", /loopback/i],
    ["fd00:1234::5efe:a9fe:a9fe", /metadata/i],
  ]) assert.match(String(classifyIp(ip)), reason, ip);

  // the same forms carrying a public IPv4 address stay public
  for (const ip of [
    "::ffff:0:808:808",
    "::ffff:0:2606:4700",
    "2606:4700::5efe:808:808",
    "2001:db9::5efe:8.8.8.8",
    "2606:4700:0:0:200:5efe:808:808",
  ]) assert.equal(classifyIp(ip), null, ip);
});

test("classifyIp names the metadata endpoints that look like ordinary public addresses", () => {
  for (const ip of ["168.63.129.16", "192.0.0.192"]) {
    assert.match(String(classifyIp(ip)), /metadata/i, ip);
  }
  // its neighbours are ordinary addresses, not metadata
  for (const ip of ["168.63.129.15", "168.63.129.17", "168.63.130.16", "192.0.0.191", "192.0.0.193"]) {
    assert.doesNotMatch(String(classifyIp(ip) ?? ""), /metadata/i, ip);
  }
});

// ---------------------------------------------------------------------------
// parseHost
// ---------------------------------------------------------------------------

test("parseHost turns every inet_aton IPv4 encoding into a dotted quad", () => {
  const encodings = [
    ["2130706433", "127.0.0.1"],
    ["0x7f000001", "127.0.0.1"],
    ["0x7f.0.0.1", "127.0.0.1"],
    ["017700000001", "127.0.0.1"],
    ["0177.0.0.1", "127.0.0.1"],
    ["127.1", "127.0.0.1"],
    ["127.0.1", "127.0.0.1"],
    ["0x7f.1", "127.0.0.1"],
    ["0", "0.0.0.0"],
    ["4294967295", "255.255.255.255"],
    ["127.0.0.1.", "127.0.0.1"],
  ];
  for (const [input, ip] of encodings) {
    const got = parseHost(input);
    assert.equal(got.kind, "ip", input);
    assert.equal(got.ip, ip, input);
  }
});

test("parseHost strips IPv6 brackets and keeps names as names", () => {
  const v6 = parseHost("[::1]");
  assert.equal(v6.kind, "ip");
  assert.match(String(classifyIp(v6.ip)), /loopback/i, "[::1]");

  const mapped = parseHost("[::FFFF:7f00:1]");
  assert.equal(mapped.kind, "ip");
  assert.match(String(classifyIp(mapped.ip)), /loopback/i, "[::FFFF:7f00:1]");

  for (const [input, name] of [
    ["LOCALHOST.", "localhost"],
    ["example.com", "example.com"],
    ["1.2.3.4.5", "1.2.3.4.5"],
    ["999.1.1.1", "999.1.1.1"],
    ["08.1.1.1", "08.1.1.1"],
  ]) {
    const got = parseHost(input);
    assert.equal(got.kind, "name", input);
    assert.equal(got.name, name, input);
  }
});

// ---------------------------------------------------------------------------
// checkUrl: literal addresses
// ---------------------------------------------------------------------------

test("checkUrl refuses literal private addresses in every encoding without resolving", async () => {
  const { resolve, counter } = resolverFor({});
  for (const url of [
    "http://2130706433/",
    "http://0x7f000001/",
    "http://0x7f.0.0.1/",
    "http://017700000001/",
    "http://0177.0.0.1/",
    "http://127.1/",
    "http://127.0.1/",
    "http://0x7f.1/",
    "http://0/",
    "http://4294967295/",
    "http://127.0.0.1:3001/x",
    "http://[::ffff:7f00:1]/",
    "http://[::1]:8080/",
    "http://10.0.0.1/",
  ]) {
    const got = await checkUrl(url, { resolve });
    assert.equal(got.ok, false, url);
    assert.ok(typeof got.reason === "string" && got.reason.length > 0, url);
    assert.ok(typeof got.host === "string", url);
  }
  assert.equal(counter.calls, 0);
});

test("checkUrl refuses localhost, *.localhost and metadata names without resolving", async () => {
  const { resolve, counter } = resolverFor({});
  for (const [url, reason] of [
    ["http://localhost/", /loopback|local/i],
    ["http://a.localhost/", /loopback|local/i],
    ["http://metadata.google.internal/", /metadata/i],
    ["http://metadata/", /metadata/i],
    ["http://metadata.goog/", /metadata/i],
    ["http://instance-data/", /metadata/i],
  ]) {
    const got = await checkUrl(url, { resolve });
    assert.equal(got.ok, false, url);
    assert.match(got.reason, reason, url);
  }
  assert.equal(counter.calls, 0);
});

// ---------------------------------------------------------------------------
// checkUrl: resolution
// ---------------------------------------------------------------------------

test("checkUrl resolves names and refuses any non-public answer", async () => {
  const { resolve } = resolverFor({
    "public.example": ["8.8.8.8"],
    "mixed.example": ["8.8.8.8", "10.0.0.5"],
    "mapped.example": ["::ffff:127.0.0.1"],
    "empty.example": [],
    "boom.example": new Error("ENOTFOUND"),
  });

  assert.equal((await checkUrl("http://public.example/", { resolve })).ok, true);

  const mixed = await checkUrl("http://mixed.example/", { resolve });
  assert.equal(mixed.ok, false);
  assert.match(mixed.reason, /private/i);
  assert.equal(mixed.address, "10.0.0.5");

  const mapped = await checkUrl("http://mapped.example/", { resolve });
  assert.equal(mapped.ok, false);
  assert.match(String(mapped.address), /127\.0\.0\.1/);

  for (const host of ["empty.example", "boom.example"]) {
    const got = await checkUrl(`http://${host}/`, { resolve });
    assert.equal(got.ok, false, host);
    assert.match(got.reason, /host did not resolve/i, host);
  }
});

test("checkUrl caches a name for a while and opts.noCache bypasses the cache", async () => {
  const cached = resolverFor({ "cache-once.example": ["8.8.8.8"] });
  assert.equal((await checkUrl("http://cache-once.example/a", { resolve: cached.resolve })).ok, true);
  assert.equal((await checkUrl("http://cache-once.example/b", { resolve: cached.resolve })).ok, true);
  assert.equal(cached.counter.calls, 1);

  const fresh = resolverFor({ "cache-never.example": ["8.8.8.8"] });
  assert.equal((await checkUrl("http://cache-never.example/a", { resolve: fresh.resolve, noCache: true })).ok, true);
  assert.equal((await checkUrl("http://cache-never.example/b", { resolve: fresh.resolve, noCache: true })).ok, true);
  assert.equal(fresh.counter.calls, 2);
});

// ---------------------------------------------------------------------------
// checkUrl: schemes
// ---------------------------------------------------------------------------

test("navigate mode allows only http(s)/ws(s) and about:blank", async () => {
  for (const [url, scheme] of [
    ["file:///etc/passwd", "file:"],
    ["view-source:http://example.com", "view-source:"],
    ["data:text/html,hi", "data:"],
    ["javascript:alert(1)", "javascript:"],
    ["about:srcdoc", "about:"],
    ["chrome://settings", "chrome:"],
    ["ftp://example.com/", "ftp:"],
  ]) {
    const got = await checkUrl(url);
    assert.equal(got.ok, false, url);
    assert.match(got.reason, /scheme not allowed/i, url);
    assert.ok(got.reason.includes(scheme), `${url} -> ${got.reason}`);
  }
  assert.equal((await checkUrl("about:blank")).ok, true);
});

test("subrequest mode allows data:, blob: and about:blank but not file:", async () => {
  assert.equal((await checkUrl("data:text/html,hi", { mode: "subrequest" })).ok, true);
  assert.equal((await checkUrl("blob:https://example.com/8f3a", { mode: "subrequest" })).ok, true);
  assert.equal((await checkUrl("about:blank", { mode: "subrequest" })).ok, true);

  const file = await checkUrl("file:///etc/passwd", { mode: "subrequest" });
  assert.equal(file.ok, false);
  assert.match(file.reason, /scheme not allowed/i);
});

test("checkUrl refuses an unparseable URL as an invalid URL", async () => {
  const got = await checkUrl("not a url");
  assert.equal(got.ok, false);
  assert.match(got.reason, /invalid URL/i);
});

// ---------------------------------------------------------------------------
// exceptions
// ---------------------------------------------------------------------------

test("parseExceptions keeps hosts and cidrs and reports the rejects", () => {
  const parsed = parseExceptions("192.168.1.50, 10.1.0.0/16, intranet.example, fd00::/8 , bogus//x");
  assert.ok(parsed.hosts.has("intranet.example"));
  assert.ok(parsed.cidrs.length >= 2, "the two CIDR entries are kept");
  assert.ok(Array.isArray(parsed.rejected));

  const rejectedText = parsed.rejected
    .map((r) => (typeof r === "string" ? r : JSON.stringify(r)))
    .join(" ");
  assert.match(rejectedText, /bogus/);

  const empty = parseExceptions(undefined);
  assert.equal(empty.hosts.size, 0);
  assert.equal(empty.cidrs.length, 0);
  assert.equal(empty.rejected.length, 0);

  assert.equal(exceptionsFromEnv({}).hosts.size, 0);
  const fromEnv = exceptionsFromEnv({ CROW_BROWSER_ALLOW_PRIVATE: "192.168.1.50, intranet.example" });
  assert.ok(fromEnv.hosts.has("intranet.example"));
});

test("checkUrl honours an excepted address, CIDR and host name", async () => {
  const exceptions = parseExceptions("192.168.1.50, 10.1.0.0/16, intranet.example, fd00::/8");

  assert.equal((await checkUrl("http://192.168.1.50/", { exceptions })).ok, true);
  assert.equal((await checkUrl("http://10.1.2.3/", { exceptions })).ok, true);
  assert.equal((await checkUrl("http://[fd12:3456::1]/", { exceptions })).ok, true);

  const { resolve } = resolverFor({ "intranet.example": ["10.1.2.3"] });
  assert.equal((await checkUrl("http://intranet.example/", { exceptions, resolve })).ok, true);

  // without the list, the same address is refused
  assert.equal((await checkUrl("http://192.168.1.50/")).ok, false);
  // an address the owner did not list stays refused
  assert.equal((await checkUrl("http://10.2.0.1/", { exceptions })).ok, false);
});

test("one excepted address does not permit a second private answer", async () => {
  const exceptions = parseExceptions("10.1.0.0/16");
  const { resolve } = resolverFor({ "two-private.example": ["10.1.2.3", "10.9.9.9"] });
  const got = await checkUrl("http://two-private.example/", { exceptions, resolve });
  assert.equal(got.ok, false);
  assert.match(got.reason, /private/i);
});

test("parseExceptions rejects a range whose prefix has whitespace or is not a number", () => {
  const parsed = parseExceptions("10.0.0.1/ 8, 10.2.0.0/16, 10.3.0.0/x, 10.4.0.0/8x, 10.5.0.0/ 16");

  assert.equal(parsed.cidrs.length, 1, "only the well-formed range is kept: " + JSON.stringify(parsed.cidrs));
  const rejected = parsed.rejected.join(" | ");
  for (const bad of [/10\.0\.0\.1\/\s*8/, /10\.3\.0\.0\/x/, /10\.4\.0\.0\/8x/, /10\.5\.0\.0\/\s*16/]) {
    assert.match(rejected, bad);
  }
  // a stray prefix length is reported, never read as an address of its own
  assert.ok(!parsed.hosts.has("0.0.0.8"), "the stray 8 did not become an exception");

  // the whitespace-separated list Crow documents still works
  const spaced = parseExceptions("10.9.0.0/16 intranet.example 192.168.1.50");
  assert.equal(spaced.cidrs.length, 1);
  assert.ok(spaced.hosts.has("intranet.example"));
  assert.ok(spaced.hosts.has("192.168.1.50"));
  assert.deepEqual(spaced.rejected, []);
});

test("metadata is never excepted, even by a covering CIDR or by name", async () => {
  const cidr = parseExceptions("169.254.0.0/16");
  const byCidr = await checkUrl("http://169.254.169.254/latest/meta-data/", { exceptions: cidr });
  assert.equal(byCidr.ok, false);
  assert.match(byCidr.reason, /metadata/i);

  const byName = parseExceptions("metadata.google.internal");
  const nameGot = await checkUrl("http://metadata.google.internal/", { exceptions: byName });
  assert.equal(nameGot.ok, false);
  assert.match(nameGot.reason, /metadata/i);

  // a plain link-local address is not metadata, so the list does apply to it
  assert.equal((await checkUrl("http://169.254.1.1/", { exceptions: cidr })).ok, true);
});

test("the wireserver and 192.0.0.192 stay refused even under a range that covers them", async () => {
  const exceptions = parseExceptions("168.63.129.0/24,192.0.0.0/24");
  assert.ok(exceptions.cidrs.length >= 2, "both ranges parsed");

  for (const host of ["168.63.129.16", "192.0.0.192"]) {
    const plain = await checkUrl(`http://${host}/`);
    assert.equal(plain.ok, false, host);
    assert.match(plain.reason, /metadata/i, host);

    const excepted = await checkUrl(`http://${host}/`, { exceptions });
    assert.equal(excepted.ok, false, `${host} with a covering range`);
    assert.match(excepted.reason, /metadata/i, `${host} with a covering range`);
  }
});

// ---------------------------------------------------------------------------
// installPrivateAddressGuard
// ---------------------------------------------------------------------------

/** The answer a stub resolver gives every public-looking name that should pass. */
const PUBLIC_ANSWER = ["93.184.216.34"];

test("the guard installs a catch-all route, a websocket route, a response listener and an init script", async () => {
  const ctx = fakeGuardContext();
  const guard = await installPrivateAddressGuard(ctx, { resolve: resolverFor({}).resolve });

  assert.equal(ctx.routes.length, 1);
  assert.equal(ctx.routes[0].pattern, "**/*");
  assert.equal(typeof ctx.routes[0].handler, "function");
  assert.equal(ctx.wsRoutes.length, 1);
  assert.equal(typeof ctx.wsRoutes[0].handler, "function");
  assert.ok(ctx.listeners.has("response"));
  assert.equal(typeof ctx.listeners.get("response")[0], "function");
  assert.ok(ctx.initScripts.length >= 1);

  assert.equal(typeof guard.takeRefusal, "function");
  assert.ok(Array.isArray(guard.refusals));
});

test("the installed init script carries GUARD_MARKER as its first line", async () => {
  const ctx = fakeGuardContext();
  await installPrivateAddressGuard(ctx, { resolve: resolverFor({}).resolve });

  const installed = ctx.initScripts[0];
  // Playwright is given source text (a string, or `{ content }`); a function is
  // accepted too, and its source is what Chromium would evaluate.
  const text = typeof installed === "function"
    ? installed.toString()
    : (installed && typeof installed === "object" && typeof installed.content === "string"
      ? installed.content
      : String(installed));

  assert.ok(
    text.includes(GUARD_MARKER),
    `the script text Chromium receives has to carry the marker, so a relay can verify a real guard is ` +
      `installed instead of trusting any script at all (got: ${JSON.stringify(text.slice(0, 120))})`,
  );
  assert.equal(
    text.split("\n")[0].trim(),
    `// ${GUARD_MARKER}`,
    `the marker is the script's leading line comment (got: ${JSON.stringify(text.slice(0, 120))})`,
  );

  // The marker rides in front of the guard's page-world half, which still runs
  // exactly as before.
  const run = new Function("navigator", "window", "self", "ServiceWorkerContainer", text);
  class FakeServiceWorkerContainer {
    register() { return Promise.resolve({ scope: "/" }); }
  }
  const container = new FakeServiceWorkerContainer();
  const navigator = { serviceWorker: container };
  run(navigator, navigator, navigator, FakeServiceWorkerContainer);
  await assert.rejects(Promise.resolve(container.register("/sw.js")), /service workers are disabled/i);
});

test("the route handler continues public requests and aborts private ones, hop by hop", async () => {
  const ctx = fakeGuardContext();
  await installPrivateAddressGuard(ctx, {
    resolve: resolverFor({ "guard-private.example": ["10.0.0.5"], "example.com": PUBLIC_ANSWER }).resolve,
  });
  const handler = ctx.routes[0].handler;

  const pub = await callRoute(handler, "https://example.com/page");
  assert.deepEqual(pub.calls, [{ kind: "continue" }]);

  const loop = await callRoute(handler, "http://127.0.0.1:3001/x");
  assert.deepEqual(loop.calls, [{ kind: "abort", code: "blockedbyclient" }]);

  const resolved = await callRoute(handler, "http://guard-private.example/");
  assert.deepEqual(resolved.calls, [{ kind: "abort", code: "blockedbyclient" }]);

  // a redirect hop, a subframe and a popup all arrive at the same handler
  const hopOk = await callRoute(handler, "https://example.com/next");
  assert.deepEqual(hopOk.calls, [{ kind: "continue" }]);
  const hopPrivate = await callRoute(handler, "http://10.0.0.5/admin");
  assert.deepEqual(hopPrivate.calls, [{ kind: "abort", code: "blockedbyclient" }]);
  assert.equal(ctx.routes.length, 1);
});

test("a route whose request cannot be read is aborted, never left hanging", async () => {
  const ctx = fakeGuardContext();
  await installPrivateAddressGuard(ctx, { resolve: resolverFor({}).resolve });
  const handler = ctx.routes[0].handler;

  const calls = [];
  const route = {
    request() { throw new Error("Target page, context or browser has been closed"); },
    async abort(code) { calls.push({ kind: "abort", code }); },
    async continue() { calls.push({ kind: "continue" }); },
  };
  await handler(route);
  assert.deepEqual(calls, [{ kind: "abort", code: "blockedbyclient" }]);

  // a request object that throws on url() is refused the same way
  const urlThrows = [];
  const second = {
    request: () => ({ url() { throw new Error("no url"); } }),
    async abort(code) { urlThrows.push({ kind: "abort", code }); },
    async continue() { urlThrows.push({ kind: "continue" }); },
  };
  await handler(second);
  assert.deepEqual(urlThrows, [{ kind: "abort", code: "blockedbyclient" }]);
});

test("checkAddress refuses an address string it cannot parse", async () => {
  const ctx = fakeGuardContext();
  const guard = await installPrivateAddressGuard(ctx, { resolve: resolverFor({}).resolve });

  for (const bad of ["", "not-an-address", "1.2.3.4.5", "::gg", "example.com"]) {
    const verdict = guard.checkAddress(bad, "example.com");
    assert.equal(verdict.ok, false, bad);
    assert.equal(verdict.reason, "unparseable address", bad);
  }
  assert.equal(guard.checkAddress("8.8.8.8", "example.com").ok, true);
});

test("the route handler aborts a name whose lookup fails and records the refusal", async () => {
  const ctx = fakeGuardContext();
  const guard = await installPrivateAddressGuard(ctx, {
    resolve: resolverFor({ "unresolved-route.example": new Error("getaddrinfo EAI_AGAIN unresolved-route.example") }).resolve,
  });
  const handler = ctx.routes[0].handler;

  const flaky = await callRoute(handler, "https://unresolved-route.example/x");
  assert.deepEqual(flaky.calls, [{ kind: "abort", code: "blockedbyclient" }]);

  const refusal = guard.takeRefusal();
  assert.ok(refusal, "the failed lookup is recorded");
  assert.equal(refusal.host, "unresolved-route.example");
  assert.equal(refusal.reason, "host did not resolve");
  assert.equal(guard.takeRefusal(), null);
});

test("the websocket handler closes private sockets and connects public ones", async () => {
  const ctx = fakeGuardContext();
  await installPrivateAddressGuard(ctx, { resolve: resolverFor({ "example.com": PUBLIC_ANSWER }).resolve });
  const handler = ctx.wsRoutes[0].handler;

  const priv = await callWs(handler, "ws://10.0.0.1/");
  const closed = priv.calls.find((c) => c.kind === "close");
  assert.ok(closed, "a private socket is closed");
  const code = closed.args[0]?.code ?? closed.args[0] ?? closed.args[1];
  assert.equal(code, 1008);
  assert.ok(!priv.calls.some((c) => c.kind === "connect"));

  const pub = await callWs(handler, "wss://example.com/socket");
  assert.ok(pub.calls.some((c) => c.kind === "connect"));
  assert.ok(!pub.calls.some((c) => c.kind === "close"));
});

test("the websocket handler closes a name whose lookup fails and records the refusal", async () => {
  const ctx = fakeGuardContext();
  const guard = await installPrivateAddressGuard(ctx, {
    resolve: resolverFor({ "unresolved-ws.example": new Error("getaddrinfo EAI_AGAIN unresolved-ws.example") }).resolve,
  });
  const handler = ctx.wsRoutes[0].handler;

  const flaky = await callWs(handler, "wss://unresolved-ws.example/socket");
  const closed = flaky.calls.find((c) => c.kind === "close");
  assert.ok(closed, "a socket to a name we cannot resolve is closed");
  const code = closed.args[0]?.code ?? closed.args[0] ?? closed.args[1];
  assert.equal(code, 1008);
  assert.ok(!flaky.calls.some((c) => c.kind === "connect"));

  const refusal = guard.takeRefusal();
  assert.ok(refusal, "the failed lookup is recorded");
  assert.equal(refusal.host, "unresolved-ws.example");
  assert.equal(refusal.reason, "host did not resolve");
  assert.equal(guard.takeRefusal(), null);
});

test("a response answered by a private server address sends the page to about:blank", async () => {
  const ctx = fakeGuardContext();
  const guard = await installPrivateAddressGuard(ctx, { resolve: resolverFor({}).resolve });
  const onResponse = ctx.listeners.get("response")[0];

  const rebind = fakeResponse({ url: "https://rebind.example/x", serverAddr: { ipAddress: "127.0.0.1", port: 80 } });
  await onResponse(rebind);
  await flush();
  assert.ok(rebind.rec.gotos.includes("about:blank"));
  const refusal = guard.takeRefusal();
  assert.ok(refusal, "the rebinding response is recorded");
  assert.equal(refusal.host, "rebind.example");
  assert.ok(typeof refusal.reason === "string" && refusal.reason.length > 0);
  assert.equal(guard.takeRefusal(), null);

  const clean = fakeResponse({ url: "https://clean.example/x", serverAddr: { ipAddress: "8.8.8.8", port: 443 } });
  await onResponse(clean);
  await flush();
  assert.deepEqual(clean.rec.gotos, []);
  assert.equal(guard.takeRefusal(), null);

  const none = fakeResponse({ url: "https://none.example/x", serverAddr: null });
  await onResponse(none);
  await flush();
  assert.deepEqual(none.rec.gotos, []);
  assert.equal(guard.takeRefusal(), null);
});

test("a name that answered with a private server address is refused on every later request", async () => {
  const ctx = fakeGuardContext();
  const { resolve } = resolverFor({ "rebind.example": PUBLIC_ANSWER, "fine.example": PUBLIC_ANSWER });
  const guard = await installPrivateAddressGuard(ctx, { resolve });
  const onResponse = ctx.listeners.get("response")[0];
  const handler = ctx.routes[0].handler;

  // Before the violation the route continues.
  const first = await callRoute(handler, "https://rebind.example/first");
  assert.deepEqual(first.calls, [{ kind: "continue" }]);

  const rebound = fakeResponse({ url: "https://rebind.example/first", serverAddr: { ipAddress: "10.0.0.5", port: 443 } });
  await onResponse(rebound);
  await flush();
  assert.ok(rebound.rec.gotos.includes("about:blank"), "the page is blanked");
  const recorded = guard.takeRefusal();
  assert.ok(recorded, "the rebound response is recorded");
  assert.equal(recorded.host, "rebind.example");

  // A later request to the same host is refused at the route level, even though
  // the resolver now says the name is public.
  const later = await callRoute(handler, "https://rebind.example/other");
  assert.deepEqual(later.calls, [{ kind: "abort", code: "blockedbyclient" }]);
  const refusal = guard.takeRefusal();
  assert.ok(refusal, "the poisoned host refusal is recorded");
  assert.equal(refusal.host, "rebind.example");
  assert.equal(refusal.reason, "host resolved to a private address");

  // A different host is unaffected.
  const other = await callRoute(handler, "https://fine.example/x");
  assert.deepEqual(other.calls, [{ kind: "continue" }]);
});

test("the poison on a rebound host expires after five minutes", async () => {
  let clock = 1_700_000_000_000;
  const ctx = fakeGuardContext();
  const { resolve } = resolverFor({ "rebind.example": PUBLIC_ANSWER });
  await installPrivateAddressGuard(ctx, { resolve, now: () => clock });
  const onResponse = ctx.listeners.get("response")[0];
  const handler = ctx.routes[0].handler;

  await onResponse(fakeResponse({ url: "https://rebind.example/x", serverAddr: { ipAddress: "10.0.0.5", port: 443 } }));
  await flush();

  const refusedNow = await callRoute(handler, "https://rebind.example/other");
  assert.deepEqual(refusedNow.calls, [{ kind: "abort", code: "blockedbyclient" }]);

  clock += 4 * 60 * 1000;
  const refusedLater = await callRoute(handler, "https://rebind.example/third");
  assert.deepEqual(refusedLater.calls, [{ kind: "abort", code: "blockedbyclient" }]);

  clock += 61 * 1000;
  const allowed = await callRoute(handler, "https://rebind.example/fourth");
  assert.deepEqual(allowed.calls, [{ kind: "continue" }]);
});

test("takeRefusal reports only the refusal of the URL it is asked about, unless { any: true }", async () => {
  const ctx = fakeGuardContext();
  const guard = await installPrivateAddressGuard(ctx, { resolve: resolverFor({}).resolve });
  const handler = ctx.routes[0].handler;

  await callRoute(handler, "http://10.0.0.5/stale");
  assert.equal(guard.takeRefusal(60_000, { url: "https://example.com/page" }), null,
    "another host's refusal is not this navigation's");

  await callRoute(handler, "http://127.0.0.1/wanted");
  const mine = guard.takeRefusal(60_000, { url: "http://127.0.0.1/wanted" });
  assert.ok(mine);
  assert.equal(mine.host, "127.0.0.1");
  assert.equal(guard.takeRefusal(60_000, { url: "http://127.0.0.1/wanted" }), null);
});

test("a refusal on a redirect hop to another host is still reported with { any: true }", async () => {
  const ctx = fakeGuardContext();
  const { resolve } = resolverFor({ "redirect.example": PUBLIC_ANSWER });
  const guard = await installPrivateAddressGuard(ctx, { resolve });
  const handler = ctx.routes[0].handler;

  await callRoute(handler, "http://169.254.169.254/latest/meta-data/");
  assert.equal(guard.takeRefusal(60_000, { url: "https://redirect.example/start" }), null,
    "the refused hop is a different host than the navigated one");

  guard.clearRefusals();
  await callRoute(handler, "https://redirect.example/start");
  await callRoute(handler, "http://169.254.169.254/latest/meta-data/");
  const hop = guard.takeRefusal(60_000, { any: true });
  assert.ok(hop, "the hop is reported when the caller does not care which host it was");
  assert.match(hop.reason, /metadata/i);
});

test("clearRefusals forgets what earlier tool calls recorded", async () => {
  const ctx = fakeGuardContext();
  const guard = await installPrivateAddressGuard(ctx, { resolve: resolverFor({}).resolve });
  const handler = ctx.routes[0].handler;

  await callRoute(handler, "http://10.0.0.5/a");
  guard.clearRefusals();
  assert.equal(guard.takeRefusal(60_000, { any: true }), null);

  await callRoute(handler, "http://10.0.0.5/b");
  assert.ok(guard.takeRefusal(60_000, { any: true }));
});

test("takeRefusal returns the newest refusal once and forgets stale ones", async () => {
  const ctx = fakeGuardContext();
  const guard = await installPrivateAddressGuard(ctx, { resolve: resolverFor({}).resolve });
  const handler = ctx.routes[0].handler;

  await callRoute(handler, "http://127.0.0.1/a");
  await callRoute(handler, "http://10.0.0.5/b");

  const newest = guard.takeRefusal();
  assert.ok(newest);
  assert.equal(newest.host, "10.0.0.5");
  assert.equal(guard.takeRefusal(), null);

  await callRoute(handler, "http://192.168.1.9/c");
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(guard.takeRefusal(10), null);
});

test("the init script makes register reject on the instance and on the prototype", async () => {
  const ctx = fakeGuardContext();
  await installPrivateAddressGuard(ctx, { resolve: resolverFor({}).resolve });

  const script = ctx.initScripts[0];
  const body = typeof script === "function" ? `(${script.toString()})();` : String(script);
  const run = new Function("navigator", "window", "self", "ServiceWorkerContainer", body);

  class FakeServiceWorkerContainer {
    register() { return Promise.resolve({ scope: "/" }); }
  }
  const container = new FakeServiceWorkerContainer();
  const navigator = { serviceWorker: container };
  run(navigator, navigator, navigator, FakeServiceWorkerContainer);

  // the page's own container
  await assert.rejects(Promise.resolve(container.register("/sw.js")), /service workers are disabled/i);
  // and the prototype, reached by a container the instance patch never saw
  await assert.rejects(
    Promise.resolve(FakeServiceWorkerContainer.prototype.register.call({}, "/sw.js")),
    /service workers are disabled/i,
  );
});

const WEBRTC_NAMES = ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCIceTransport", "RTCDataChannel"];

/** The init script's body, ready to run against fake globals. */
function initScriptRunner(script) {
  const body = typeof script === "function" ? `(${script.toString()})();` : String(script);
  return new Function("navigator", "window", "self", "ServiceWorkerContainer", body);
}

test("the init script makes every WebRTC constructor throw in the frame", async () => {
  const ctx = fakeGuardContext();
  await installPrivateAddressGuard(ctx, { resolve: resolverFor({}).resolve });
  const run = initScriptRunner(ctx.initScripts[0]);

  class FakePeerConnection { constructor() { this.opened = true; } }
  class FakeIceTransport { constructor() { this.opened = true; } }
  class FakeDataChannel { constructor() { this.opened = true; } }
  const navigator = { serviceWorker: null };
  const win = {
    RTCPeerConnection: FakePeerConnection,
    webkitRTCPeerConnection: FakePeerConnection,
    RTCIceTransport: FakeIceTransport,
    RTCDataChannel: FakeDataChannel,
  };
  run(navigator, win, win, undefined);

  for (const name of WEBRTC_NAMES) {
    assert.equal(typeof win[name], "function", name + " is replaced by a constructor");
    assert.throws(
      () => new win[name](),
      (err) => err instanceof TypeError && /WebRTC is disabled by Crow's private-address rule/.test(err.message),
      name + " throws a TypeError",
    );
  }

  // The original prototypes' constructors are replaced too, so a class reached
  // through an existing prototype chain cannot build a peer connection either.
  for (const Original of [FakePeerConnection, FakeIceTransport, FakeDataChannel]) {
    assert.throws(() => new Original.prototype.constructor(), /WebRTC is disabled/);
  }

  // A frame where the API is not present yet still gets refusing stubs.
  const emptyNavigator = { serviceWorker: null };
  const emptyWin = {};
  run(emptyNavigator, emptyWin, emptyWin, undefined);
  for (const name of WEBRTC_NAMES) {
    assert.throws(() => new emptyWin[name](), TypeError, name + " is stubbed where the API is absent");
  }
});

// ---------------------------------------------------------------------------
// blankPagesOnExit: the guard dies with this process
// ---------------------------------------------------------------------------

/**
 * A fake BrowserContext whose pages — and the fresh survivor `newPage()` creates —
 * append to ONE ordered event log, so BOTH the sequence of the cleanup and the
 * survivor's untouchedness are observable.
 *
 * The pages that exist before the cleanup are named "0", "1", …; the page
 * `context.newPage()` creates is named "survivor". `context.pages()` is a
 * snapshot of the live list, like the real one: a survivor it has just made shows
 * up in it, so an implementation that walks `pages()` instead of the pages it
 * started with would blank and close the survivor too — which must not happen.
 *
 * Options, all optional and all keyed by the page's name:
 *   failGoto(name)     that page's goto REJECTS: the page never blanks
 *   uncommitted(name)  that page's goto RESOLVES but url() is still the old
 *                      document: the about:blank commit was never observed
 *   failNewPage        context.newPage() rejects: no survivor can be made
 *   crashThrows        the browser session rejects Browser.crash, so no page and
 *                      no browser ends up closed (there is no Browser.close
 *                      fallback: a close fires the close-time beacons)
 *   neverGoto(name)    that page's goto NEVER settles: a navigation that hangs
 *   closed(name)       that page's isClosed() answers true: it is already gone
 *   attachable(name)   the page offers context().newCDPSession(), like a real one,
 *                      and logs `attach:<name>` when the attach is attempted
 *   failAttach(name)   that newCDPSession REJECTS, so no deny-all session exists
 *                      (only meaningful together with attachable(name))
 *   crashHangs         Browser.crash never answers, like a real crash
 *   browserDetachThrows the browser-level session's detach() REJECTS (it is only ever
 *                      called by code that has to swallow that)
 *   onGoto(name, addPage, dropPage)
 *                      runs when that page's goto starts, so a test can add a page
 *                      to the context — or take one out of context.pages() — in
 *                      the middle of the cleanup
 */
function fakeExitContext(pageCount, opts = {}) {
  const {
    failGoto = () => false,
    uncommitted = () => false,
    neverGoto = () => false,
    closed = () => false,
    attachable = () => false,
    failAttach = () => false,
    failNewPage = false,
    crashThrows = false,
    crashHangs = false,
    browserDetachThrows = false,
    onGoto = () => {},
  } = opts;
  const log = [];
  const pages = [];
  const dropped = new Set();

  /**
   * Take a page OUT of `context.pages()`, the way a real BrowserContext stops
   * listing a page once it is closed: the page object still exists, but nothing
   * reads it out of the context any more. Its isClosed() answers true as well.
   */
  const dropPage = (name) => {
    dropped.add(name);
    const at = pages.findIndex((candidate) => candidate.rec.name === name);
    if (at >= 0) pages.splice(at, 1);
  };

  const addPage = (name) => {
    const rec = { name, url: `http://127.0.0.1:9/${name}`, gotos: [], closes: 0 };
    const page = {
      rec,
      url: () => rec.url,
      isClosed: () => dropped.has(name) || closed(name),
      async goto(target) {
        rec.gotos.push(target);
        log.push(`goto:${name}:start`);
        onGoto(name, addPage, dropPage);
        // A navigation that never settles: the cleanup spends its whole budget on this.
        if (neverGoto(name)) await new Promise(() => {});
        await flush(); // a real goto() is a round trip: without awaiting it, order would be luck
        if (failGoto(name)) {
          log.push(`goto:${name}:rejected`);
          throw new Error(`page ${name} crashed`);
        }
        // A resolved goto is only a blanked page once the commit shows: a
        // navigation can resolve without the about:blank document ever committing.
        if (!uncommitted(name)) rec.url = target;
        log.push(`goto:${name}:end`);
      },
      async close() {
        rec.closes += 1;
        log.push(`close:${name}`);
      },
    };
    if (attachable(name)) {
      page.context = () => ({
        async newCDPSession() {
          log.push(`attach:${name}`);
          if (failAttach(name)) {
            log.push(`attach:${name}:rejected`);
            throw new Error(`no CDP session can be opened for page ${name}`);
          }
          return {
            on(event) { log.push(`attach:${name}:on:${event}`); },
            async send(method) { log.push(`attach:${name}:send:${method}`); },
          };
        },
      });
    }
    pages.push(page);
    return page;
  };

  const old = [];
  for (let i = 0; i < pageCount; i++) old.push(addPage(String(i)));

  const context = {
    pages: () => pages.slice(),
    browser: () => ({
      async newBrowserCDPSession() {
        log.push("browser:newSession");
        return {
          async send(method) {
            log.push(`browser:send:${method}`);
            // A real crash never answers: the socket dies with the browser.
            if (method === "Browser.crash" && crashHangs) await new Promise(() => {});
            if (method === "Browser.crash" && crashThrows) throw new Error("Browser.crash refused");
          },
          // A real browser-level session is detached by whoever opened it once it is
          // done with it. Nothing calls this today, so the log only grows when a
          // caller actually detaches (backward compatible with every test above).
          async detach() {
            log.push("browser:detach");
            if (browserDetachThrows) {
              log.push("browser:detach:rejected");
              throw new Error("the browser session could not be detached");
            }
          },
        };
      },
    }),
    async newPage() {
      log.push("newPage");
      if (failNewPage) throw new Error("no new page: the browser is going");
      return addPage("survivor");
    },
  };

  const survivor = () => pages.find((p) => p.rec.name === "survivor");
  return { log, pages, old, context, survivor, addPage, dropPage };
}

/** A fake process (and its stdin) that no event can terminate. */
function fakeProcess() {
  const proc = new EventEmitter();
  proc.stdin = new EventEmitter();
  return proc;
}

const EXIT_EVENTS = [
  ["stdin close", (proc) => proc.stdin.emit("close")],
  ["stdin end", (proc) => proc.stdin.emit("end")],
  ["SIGTERM", (proc) => proc.emit("SIGTERM")],
  ["SIGINT", (proc) => proc.emit("SIGINT")],
  ["beforeExit", (proc) => proc.emit("beforeExit")],
];

test("blankPagesOnExit creates the fresh survivor FIRST and closes every old page, on each way out", async () => {
  for (const [name, emit] of EXIT_EVENTS) {
    const proc = fakeProcess();
    const { log, old, context, survivor } = fakeExitContext(3);
    const run = blankPagesOnExit(() => context, { proc });

    emit(proc);
    // Await the cleanup itself, not a fixed number of ticks: the fake's per-page
    // goto costs one timer tick, so counting flushes would only ever cover as
    // many pages as ticks given.
    await run();

    assert.deepEqual(
      old.map((p) => p.rec.gotos),
      [["about:blank"], ["about:blank"], ["about:blank"]],
      `${name}: every OLD page is blanked`,
    );
    assert.deepEqual(
      old.map((p) => p.rec.closes),
      [1, 1, 1],
      `${name}: every old page is closed, index 0 included — an old page that survives keeps its ` +
        "history and back-forward cache, so a Back press restores the bot's page",
    );

    const fresh = survivor();
    assert.ok(fresh, `${name}: a fresh survivor page was created (log: ${log.join(", ")})`);
    assert.equal(fresh.rec.gotos.length, 0, `${name}: the survivor is never navigated (log: ${log.join(", ")})`);
    assert.equal(fresh.rec.closes, 0, `${name}: the survivor is never closed — it is the only page left`);
    assert.equal(
      log.filter((e) => e === "newPage").length,
      1,
      `${name}: exactly one survivor is created (log: ${log.join(", ")})`,
    );
    assert.equal(
      log[0],
      "browser:newSession",
      `${name}: the browser session is opened FIRST, so a cleanup that runs out of budget can still crash the ` +
        `browser (log: ${log.join(", ")})`,
    );
    assert.equal(
      log[1],
      "newPage",
      `${name}: the survivor exists BEFORE any old page is navigated or closed (log: ${log.join(", ")})`,
    );
    assert.deepEqual(
      log.filter((e) => e.startsWith("browser:send")),
      [],
      `${name}: nothing failed, so the browser is not killed (log: ${log.join(", ")})`,
    );
  }
});

test("a second exit event does nothing: the pages are cleaned up once", async () => {
  const proc = fakeProcess();
  const { log, old, context, survivor } = fakeExitContext(2);
  const run = blankPagesOnExit(() => context, { proc });

  proc.stdin.emit("close");
  proc.stdin.emit("close");
  proc.emit("beforeExit");
  proc.emit("SIGTERM");
  proc.emit("SIGINT");
  // The cleanup is once-only, so this awaits the single run all five events share.
  await run();

  assert.deepEqual(old.map((p) => p.rec.gotos.length), [1, 1], "each old page is blanked once");
  assert.deepEqual(old.map((p) => p.rec.closes), [1, 1], "each old page is closed once");
  assert.equal(log.filter((e) => e === "newPage").length, 1, "one survivor, not one per exit event");
  assert.equal(survivor().rec.closes, 0, "the survivor is left alone");
  assert.ok(!log.some((e) => e.startsWith("browser:send")), "nothing failed, so the browser is not killed");
});

// FAIL CLOSED: a page whose blank did not commit is NEVER closed. A close fires its
// pagehide/unload beacons exactly like the navigation would, and with the blank
// failed there is nothing in front of them — so the only safe end for that page is
// the death of the browser it lives in.
test("a page whose blank REJECTS is never closed: the cleanup crashes the browser instead", async () => {
  const proc = fakeProcess();
  const { log, old, context, survivor } = fakeExitContext(1, { failGoto: (name) => name === "0" });
  const run = blankPagesOnExit(() => context, { proc, budgetMs: 500 });

  proc.stdin.emit("end");
  await run();

  assert.equal(
    old[0].rec.closes,
    0,
    `page 0 was closed after its blank failed — that close fires its pagehide beacons with nothing to stop ` +
      `them (log: ${log.join(", ")})`,
  );
  assert.ok(log.includes("goto:0:rejected"), `the blank was attempted and rejected (log: ${log.join(", ")})`);
  assert.equal(
    log.filter((e) => e === "browser:send:Browser.crash").length,
    1,
    `the browser is crashed exactly once, which takes the unblankaable page with it (log: ${log.join(", ")})`,
  );
  assert.ok(!log.includes("browser:send:Browser.close"), "Browser.close is never sent, even as a fallback");
  assert.equal(survivor().rec.closes, 0, "the survivor was not closed on the way to the crash");
});

test("a page whose blank RESOLVES without committing about:blank is never closed either", async () => {
  const proc = fakeProcess();
  const { log, old, context } = fakeExitContext(1, { uncommitted: (name) => name === "0" });
  const run = blankPagesOnExit(() => context, { proc, budgetMs: 500 });

  proc.stdin.emit("close");
  await run();

  assert.equal(
    old[0].url(),
    "http://127.0.0.1:9/0",
    "the fake page's url() never became about:blank, so the commit was never observed",
  );
  assert.equal(
    old[0].rec.closes,
    0,
    `a goto that resolved is not a blanked page: closing it now would fire the bot page's beacons (log: ${log.join(", ")})`,
  );
  assert.equal(
    log.filter((e) => e === "browser:send:Browser.crash").length,
    1,
    `the browser is crashed exactly once (log: ${log.join(", ")})`,
  );
});

test("blankPagesOnExit is a no-op when there is no context yet", async () => {
  const proc = fakeProcess();
  const run = blankPagesOnExit(() => null, { proc, budgetMs: 50 });
  proc.emit("beforeExit");
  await assert.doesNotReject(run());
});

test("blankPagesOnExit blanks each old page, waits for its about:blank commit, then closes it — one at a time", async () => {
  const proc = fakeProcess();
  const { log, context } = fakeExitContext(3);
  const run = blankPagesOnExit(() => context, { proc });

  proc.stdin.emit("close");
  await run();

  // The whole sequence, which is every property at once:
  //   - the fresh survivor comes FIRST, before any old page is touched;
  //   - every old page (index 0 too) is blanked and then closed;
  //   - a page is closed only after its goto RESOLVED (goto:N:end);
  //   - the pages are handled one at a time (no page N+1 goto starts before
  //     page N has been closed).
  assert.deepEqual(
    log,
    [
      "browser:newSession",
      "newPage",
      "goto:0:start", "goto:0:end", "close:0",
      "goto:1:start", "goto:1:end", "close:1",
      "goto:2:start", "goto:2:end", "close:2",
    ],
    `expected session-then-survivor-then-blank-then-close, sequentially (got ${log.join(", ")})`,
  );
  for (let i = 0; i < 3; i++) {
    const committed = log.indexOf(`goto:${i}:end`);
    const closed = log.indexOf(`close:${i}`);
    assert.ok(committed >= 0, `page ${i} was blanked (log: ${log.join(", ")})`);
    assert.ok(closed > committed, `page ${i}: the about:blank commit came before close() (log: ${log.join(", ")})`);
  }
});

test("blankPagesOnExit closes the single old page too: the fresh survivor is what keeps the browser alive", async () => {
  const proc = fakeProcess();
  const { log, old, context, survivor } = fakeExitContext(1);
  const run = blankPagesOnExit(() => context, { proc, budgetMs: 500 });

  proc.stdin.emit("close");
  await run();

  assert.deepEqual(
    log,
    ["browser:newSession", "newPage", "goto:0:start", "goto:0:end", "close:0"],
    `no old page survives the cleanup, not even when it is the only one (got ${log.join(", ")})`,
  );
  assert.equal(old[0].rec.closes, 1, "the old page is closed: its history and back-forward cache would let Back restore the bot's page");
  assert.equal(survivor().rec.closes, 0, "the survivor is the page that is left behind");
  assert.ok(!log.some((e) => e.startsWith("browser:send")), "the survivor exists, so the browser need not be killed");
});

// FAIL CLOSED, and never `Browser.close`: closing the browser closes its live
// pages, and every one of those closes fires exactly the pagehide/unload beacons
// this cleanup exists to stop. So a crash that cannot be sent leaves the pages
// alone and says so once, through console.error.
/** Capture console.error for one call, so "one log line" is assertable, not guessed. */
async function captureConsoleError(fn) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => { lines.push(args.map((arg) => String(arg)).join(" ")); };
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return lines;
}

test("a Browser.crash that throws sends NO Browser.close: nothing is closed, one line is logged", async () => {
  const proc = fakeProcess();
  const { log, old, context, survivor } = fakeExitContext(1, { failGoto: () => true, crashThrows: true });
  const run = blankPagesOnExit(() => context, { proc, budgetMs: 500 });

  const lines = await captureConsoleError(async () => {
    proc.stdin.emit("close");
    await run();
  });

  assert.deepEqual(
    log.filter((e) => e.startsWith("browser:send")),
    ["browser:send:Browser.crash"],
    `a refused crash must NOT fall back to Browser.close: that closes the live pages and their close-time ` +
      `beacons fire with nothing in front of them (got ${log.join(", ")})`,
  );
  assert.equal(old[0].rec.closes, 0, `the page is never closed (got ${log.join(", ")})`);
  assert.equal(survivor().rec.closes, 0, "the survivor is not closed either");
  assert.equal(
    lines.length,
    1,
    `exactly one line names the failed crash (got ${JSON.stringify(lines)}; log: ${log.join(", ")})`,
  );
  assert.match(lines[0], /crash/i, `the line has to name the failed crash (got ${JSON.stringify(lines[0])})`);
});

test("a survivor that cannot be created and a crash that throws still sends no Browser.close", async () => {
  const proc = fakeProcess();
  const { log, old, context } = fakeExitContext(2, { failNewPage: true, crashThrows: true });
  const run = blankPagesOnExit(() => context, { proc, budgetMs: 500 });

  const lines = await captureConsoleError(async () => {
    proc.stdin.emit("close");
    await run();
  });

  assert.deepEqual(
    log,
    ["browser:newSession", "newPage", "browser:send:Browser.crash"],
    `the survivor-failure path is the same rule: crash, never close (got ${log.join(", ")})`,
  );
  assert.deepEqual(old.map((p) => p.rec.closes), [0, 0], `no old page is closed (got ${log.join(", ")})`);
  assert.equal(lines.length, 1, `exactly one line names the failed crash (got ${JSON.stringify(lines)})`);
});

test("a survivor that cannot be created closes nothing, navigates nothing and kills the browser", async () => {
  const proc = fakeProcess();
  const { log, old, context } = fakeExitContext(2, { failNewPage: true });
  const run = blankPagesOnExit(() => context, { proc, budgetMs: 500 });

  proc.stdin.emit("close");
  await run();

  assert.deepEqual(log.filter((e) => e.startsWith("goto:")), [], `no old page is navigated (log: ${log.join(", ")})`);
  assert.deepEqual(old.map((p) => p.rec.closes), [0, 0], `no old page is closed (log: ${log.join(", ")})`);
  assert.deepEqual(
    log,
    ["browser:newSession", "newPage", "browser:send:Browser.crash"],
    `without a survivor the browser is the only thing that can end safely (got ${log.join(", ")})`,
  );
});

test("blankPagesOnExit does nothing at all for a context with no pages", async () => {
  const proc = fakeProcess();
  const { log, context } = fakeExitContext(0);
  const run = blankPagesOnExit(() => context, { proc, budgetMs: 500 });

  proc.stdin.emit("close");
  await run();

  assert.deepEqual(
    log.filter((e) => e !== "browser:newSession"),
    [],
    `no page to protect: no survivor is made and nothing is killed (got ${log.join(", ")})`,
  );
});

// ---------------------------------------------------------------------------
// blankPageSafely: a mid-session blank that does not leak
// ---------------------------------------------------------------------------

/**
 * A fake page with a fake CDP session, logging every step in ONE ordered log, so
 * the attach-blank-detach sequence (and not only its outcome) is observable.
 */
function fakeBlankablePage({ failGoto = false, withContext = true, failAttach = false } = {}) {
  const log = [];
  // When the goto ended and when the detach ran, for the grace-period tests.
  const marks = { gotoEnd: null, detach: null };
  const cdp = {
    on(event, fn) {
      log.push(`on:${event}`);
      this.pausedHandler = fn;
    },
    async send(method) { log.push(`send:${method}`); },
    async detach() {
      marks.detach = Date.now();
      log.push("detach");
    },
  };
  let url = "http://127.0.0.1:9/private";
  const page = {
    log,
    marks,
    cdp,
    url: () => url,
    async goto(target) {
      log.push(`goto:${target}`);
      if (failGoto) throw new Error("page crashed");
      url = target;
      marks.gotoEnd = Date.now();
    },
  };
  if (withContext) {
    page.context = () => ({
      async newCDPSession() {
        log.push("newCDPSession");
        if (failAttach) throw new Error("no CDP session can be opened for this page");
        return cdp;
      },
    });
  }
  return page;
}

test("blankPageSafely attaches a deny-all session, blanks the page, then detaches it", async () => {
  const page = fakeBlankablePage();

  await blankPageSafely(page);

  assert.deepEqual(page.log, [
    "newCDPSession",
    "on:Fetch.requestPaused",
    "send:Fetch.enable",
    "goto:about:blank",
    "detach",
  ], `the session has to be attached BEFORE the goto and detached AFTER it (got ${page.log.join(", ")})`);

  // The session it attached is a deny-all: every paused request is failed.
  page.cdp.pausedHandler({ requestId: "r-1" });
  await flush();
  assert.deepEqual(page.log.slice(-1), ["send:Fetch.failRequest"], "a paused request is failed, not continued");
});

test("blankPageSafely propagates a goto rejection and still detaches the session", async () => {
  const page = fakeBlankablePage({ failGoto: true });

  await assert.rejects(blankPageSafely(page), /page crashed/);

  assert.equal(page.log[page.log.length - 1], "detach", `the session is detached even when the goto fails (got ${page.log.join(", ")})`);
  assert.ok(page.log.includes("goto:about:blank"), "the goto was attempted");
});

test("blankPageSafely skips the session cleanly on a page with no context()", async () => {
  const page = fakeBlankablePage({ withContext: false });

  await blankPageSafely(page);

  assert.deepEqual(page.log, ["goto:about:blank"], "no session to attach: the page is simply blanked");
});

test("blankPagesOnExit leaves its deny-all session attached, unlike blankPageSafely", async () => {
  const proc = fakeProcess();
  const page = fakeBlankablePage();
  // The survivor the cleanup creates first: an untouched about:blank tab, so the
  // old page can be closed without being the browser's last page.
  const survivorPage = { url: () => "about:blank", goto: async () => {}, close: async () => {} };
  const context = {
    pages: () => [page],
    newPage: async () => survivorPage,
    browser: () => ({ newBrowserCDPSession: async () => ({ send: async () => {} }) }),
  };
  const run = blankPagesOnExit(() => context, { proc, budgetMs: 500 });

  proc.stdin.emit("close");
  await run();

  // The exit path is exiting: a detach would release anything still paused. And
  // because this page is never reused, its OWN session gets the round-trip-free
  // network-stack block as well — the Fetch fail is a round trip through this
  // process, and the target can die before it lands (I14 #1).
  assert.deepEqual(page.log, [
    "newCDPSession",
    "on:Fetch.requestPaused",
    "send:Fetch.enable",
    "send:Network.enable",
    "send:Network.setBlockedURLs",
    "goto:about:blank",
  ], `the exit path never detaches, and blocks the page's own network stack (got ${page.log.join(", ")})`);
});

// ---------------------------------------------------------------------------
// the exit-cleanup findings (r4)
//
// The guard's lifetime is what makes the private-address rule hold after this
// process is gone. These pin the ways the cleanup can silently stop protecting
// a page. Each "nothing happened" test has a CONTROL next to it that uses the
// same fake and shows the thing DOES happen once its condition is flipped, so a
// zero can never be vacuous.
// ---------------------------------------------------------------------------

// (r4 #1) A cleanup that spends its whole budget is a cleanup whose pages were
// never blanked, so their pagehide/unload beacons are still armed: the browser
// has to die. A real crash never answers, so the cleanup may not wait for one.
test("(r4 #1) the budget expiring crashes the browser exactly once, without closing page 0", async () => {
  const proc = fakeProcess();
  const { log, old, context, survivor } = fakeExitContext(2, {
    neverGoto: (name) => name === "0",
    crashHangs: true,
  });
  const run = blankPagesOnExit(() => context, { proc, budgetMs: 50 });

  proc.stdin.emit("close");
  const started = Date.now();
  await run();
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 500, `the cleanup has to be let go at its budget, not wait for the dead browser (took ${elapsed} ms)`);
  assert.equal(
    log.filter((e) => e === "browser:send:Browser.crash").length,
    1,
    `a cleanup that ran out of budget leaves armed pages behind and has to crash the browser exactly once ` +
      `(log: ${log.join(", ")})`,
  );
  assert.equal(
    old[0].rec.closes,
    0,
    `page 0 was never blanked, so closing it fires its beacons with nothing in front of them ` +
      `(log: ${log.join(", ")})`,
  );
  assert.equal(survivor().rec.closes, 0, `the survivor is not closed on the way to the crash (log: ${log.join(", ")})`);

  const sessionAt = log.indexOf("browser:newSession");
  const gotoAt = log.indexOf("goto:0:start");
  assert.notEqual(sessionAt, -1, `the cleanup opens the browser session itself (log: ${log.join(", ")})`);
  assert.notEqual(gotoAt, -1, `page 0's goto was started (log: ${log.join(", ")})`);
  assert.ok(
    gotoAt > sessionAt,
    `the session has to be opened at the START of the cleanup: the budget can run out while a goto is still ` +
      `pending, and then there is no time left to open one (log: ${log.join(", ")})`,
  );
});

test("(r4 #1 CONTROL) a cleanup that finishes inside its budget sends no crash at all", async () => {
  const proc = fakeProcess();
  const { log, old, context, survivor } = fakeExitContext(2);
  const run = blankPagesOnExit(() => context, { proc, budgetMs: 1000 });

  proc.stdin.emit("close");
  await run();

  assert.deepEqual(
    log.filter((e) => e.startsWith("browser:send")),
    [],
    `the same fake logs a crash when one is sent; here nothing failed, so nothing is killed (log: ${log.join(", ")})`,
  );
  assert.deepEqual(old.map((p) => p.rec.gotos), [["about:blank"], ["about:blank"]], `both pages were blanked (log: ${log.join(", ")})`);
  assert.deepEqual(old.map((p) => p.rec.closes), [1, 1], `both pages were closed (log: ${log.join(", ")})`);
  assert.equal(survivor().rec.closes, 0, "the survivor is left alone");
});

// (r4 #3) A page that HAS a context and a CDP endpoint but whose deny-all session
// cannot be attached is not protected at all: navigating it would fire the very
// pagehide beacons the session exists to fail. Fail closed.
test("(r4 #3) a page whose deny-all attach REJECTS is never navigated or closed: the browser is crashed", async () => {
  const proc = fakeProcess();
  const { log, old, context, survivor } = fakeExitContext(2, {
    attachable: () => true,
    failAttach: (name) => name === "0",
  });
  const run = blankPagesOnExit(() => context, { proc, budgetMs: 500 });

  proc.stdin.emit("close");
  await run();

  assert.ok(log.includes("attach:0:rejected"), `page 0 was reached and its attach rejected (log: ${log.join(", ")})`);
  assert.deepEqual(
    old[0].rec.gotos,
    [],
    `an unattached page must not be navigated: its pagehide beacons would ride the blank out to the ` +
      `server (log: ${log.join(", ")})`,
  );
  assert.equal(old[0].rec.closes, 0, `an unattached page must not be closed either (log: ${log.join(", ")})`);
  assert.equal(
    log.filter((e) => e === "browser:send:Browser.crash").length,
    1,
    `the only safe end for a page that cannot be denied every request is the death of the browser ` +
      `(log: ${log.join(", ")})`,
  );
  assert.equal(survivor().rec.closes, 0, `the survivor is not closed on the way to the crash (log: ${log.join(", ")})`);
});

test("(r4 #3) blankPageSafely REJECTS when the deny-all session cannot be attached, and never gotos", async () => {
  const page = fakeBlankablePage({ failAttach: true });

  await assert.rejects(blankPageSafely(page), (err) => err instanceof Error);

  assert.deepEqual(
    page.log.filter((e) => e.startsWith("goto:")),
    [],
    `the page has no deny-all session in front of it, so blanking it would leak (got ${page.log.join(", ")})`,
  );
});

test("(r4 #3 CONTROL) a page with no context() at all still has nothing to attach, and is blanked and closed", async () => {
  const proc = fakeProcess();
  const { log, old, context } = fakeExitContext(1); // attachable: () => false
  const run = blankPagesOnExit(() => context, { proc, budgetMs: 500 });

  proc.stdin.emit("close");
  await run();

  assert.deepEqual(old[0].rec.gotos, ["about:blank"], `a page with no CDP endpoint is blanked as before (log: ${log.join(", ")})`);
  assert.equal(old[0].rec.closes, 1, `and closed as before (log: ${log.join(", ")})`);
  assert.deepEqual(
    log.filter((e) => e.startsWith("browser:send")),
    [],
    `nothing failed, so the browser is not killed (log: ${log.join(", ")})`,
  );

  // …and blankPageSafely still simply blanks it (the pre-existing test pins the
  // same thing; this is the side-by-side control for the rejection above).
  const plain = fakeBlankablePage({ withContext: false });
  await blankPageSafely(plain);
  assert.deepEqual(plain.log, ["goto:about:blank"], `no session to attach: the page is simply blanked (got ${plain.log.join(", ")})`);
});

// (r4 #4) A page that is already closed has nothing left to protect: blanking it
// throws, which would crash a browser that has nothing to answer for — and stop
// the pages behind it being cleaned.
test("(r4 #4) a page whose isClosed() is true is skipped, and the pages after it are still cleaned", async () => {
  const proc = fakeProcess();
  const { log, old, context, survivor } = fakeExitContext(3, { closed: (name) => name === "1" });
  const run = blankPagesOnExit(() => context, { proc, budgetMs: 500 });

  proc.stdin.emit("close");
  await run();

  assert.deepEqual(old[1].rec.gotos, [], `a page that is already gone is not navigated (log: ${log.join(", ")})`);
  assert.equal(old[1].rec.closes, 0, `and not closed (log: ${log.join(", ")})`);
  assert.deepEqual(
    log.filter((e) => e.startsWith("browser:send")),
    [],
    `a closed page is nothing to fail closed about, so no crash (log: ${log.join(", ")})`,
  );
  assert.deepEqual(old[0].rec.gotos, ["about:blank"], `the page before it is still blanked (log: ${log.join(", ")})`);
  assert.equal(old[0].rec.closes, 1, `the page before it is still closed (log: ${log.join(", ")})`);
  assert.deepEqual(old[2].rec.gotos, ["about:blank"], `the page AFTER it is still blanked (log: ${log.join(", ")})`);
  assert.equal(old[2].rec.closes, 1, `the page AFTER it is still closed (log: ${log.join(", ")})`);
  assert.equal(survivor().rec.closes, 0, `the survivor is left alone (log: ${log.join(", ")})`);
});

test("(r4 #4 CONTROL) the same page with isClosed() false is blanked and closed", async () => {
  const proc = fakeProcess();
  const { log, old, context } = fakeExitContext(3, { closed: () => false });
  const run = blankPagesOnExit(() => context, { proc, budgetMs: 500 });

  proc.stdin.emit("close");
  await run();

  assert.deepEqual(old[1].rec.gotos, ["about:blank"], `the page is blanked (log: ${log.join(", ")})`);
  assert.equal(old[1].rec.closes, 1, `the page is closed (log: ${log.join(", ")})`);
});

// (r4 #5) The listeners and the cleanup stay per proc: a second call hands back the
// cleanup that already exists. The PAIRS under it are per server — and the M3 rule
// makes a LEGACY registration's pair its getter FUNCTION, so two legacy
// registrations with DIFFERENT getters are two pairs and both contexts are cleaned
// (they used to be merged into one, keeping only the newest getter). Re-registering
// the SAME getter, or the same ownership, swaps that one pair's getter and adds no
// pair.
test("(r4 #5) a second blankPagesOnExit on the same proc registers the listeners once, and two legacy getters are two pairs each cleaned once", async () => {
  const proc = fakeProcess();
  const a = fakeExitContext(1);
  const b = fakeExitContext(1);
  // The getter FUNCTIONS, not just calls: in the legacy mode a pair's identity is the
  // getter itself, so handing the same function over again is the same pair.
  const getA = () => a.context;
  const getB = () => b.context;
  const runA = blankPagesOnExit(getA, { proc, budgetMs: 500 });
  const runB = blankPagesOnExit(getB, { proc, budgetMs: 500 });

  for (const [label, emitter, event] of [
    ["SIGTERM", proc, "SIGTERM"],
    ["SIGINT", proc, "SIGINT"],
    ["beforeExit", proc, "beforeExit"],
    ["stdin close", proc.stdin, "close"],
    ["stdin end", proc.stdin, "end"],
  ]) {
    assert.equal(
      emitter.listenerCount(event),
      1,
      `${label}: registered exactly once, however many times blankPagesOnExit is called (got ` +
        `${emitter.listenerCount(event)})`,
    );
  }
  assert.equal(runA, runB, "the same cleanup is handed back, so a caller cannot run a second one");

  // The SAME getter again: it swaps that one pair's getter, it does not add a third
  // pair (which would clean b's context a second time).
  assert.equal(
    blankPagesOnExit(getB, { proc, budgetMs: 500 }),
    runA,
    "a re-registration with the same getter is still the same one cleanup and the same pair",
  );

  proc.stdin.emit("close");
  await runB();

  assert.deepEqual(
    a.old.map((p) => p.rec.gotos),
    [["about:blank"]],
    `two legacy registrations with different getters are two pairs, so the first getter's context is cleaned too (got ${a.log.join(", ")})`,
  );
  assert.deepEqual(a.old.map((p) => p.rec.closes), [1], `the first getter's page is closed exactly once (got ${a.log.join(", ")})`);
  assert.deepEqual(b.old.map((p) => p.rec.gotos), [["about:blank"]], `the second getter's page is blanked (got ${b.log.join(", ")})`);
  assert.deepEqual(
    b.old.map((p) => p.rec.closes),
    [1],
    `the second getter's page is closed exactly once — the same getter re-registered did not add a pair (got ${b.log.join(", ")})`,
  );
});

test("(r4 #5 CONTROL) a different proc gets its own listeners and its own cleanup", async () => {
  const procA = fakeProcess();
  const procB = fakeProcess();
  const a = fakeExitContext(1);
  const b = fakeExitContext(1);
  const runA = blankPagesOnExit(() => a.context, { proc: procA, budgetMs: 500 });
  const runB = blankPagesOnExit(() => b.context, { proc: procB, budgetMs: 500 });

  assert.equal(procA.listenerCount("SIGTERM"), 1, "procA has its own listener");
  assert.equal(procB.listenerCount("SIGTERM"), 1, "procB has its own listener");
  assert.equal(procB.stdin.listenerCount("close"), 1, "procB's stdin has its own listener");
  assert.notEqual(runA, runB, "two procs are two registrations");

  procA.stdin.emit("close");
  await runA();
  assert.deepEqual(a.old.map((p) => p.rec.closes), [1], `procA's cleanup cleans getA (got ${a.log.join(", ")})`);
  assert.deepEqual(b.old.map((p) => p.rec.closes), [0], `procB's cleanup has not run (got ${b.log.join(", ")})`);
});

// (r4 #7) A page's pagehide/unload requests can still be in flight when the
// about:blank navigation resolves. Detaching the session right then releases
// anything still paused and re-opens the leak the session was attached to stop.
test("(r4 #7) blankPageSafely keeps the deny-all session attached for the grace period after the blank", async () => {
  const page = fakeBlankablePage();

  await blankPageSafely(page, { graceMs: 80 });

  assert.notEqual(page.marks.gotoEnd, null, `the fake goto ran (log: ${page.log.join(", ")})`);
  assert.notEqual(page.marks.detach, null, `the session was detached (log: ${page.log.join(", ")})`);
  const gap = page.marks.detach - page.marks.gotoEnd;
  assert.ok(
    gap >= 70,
    `detach came ${gap} ms after the goto resolved: the deny-all session has to outlive the blank by the ` +
      `grace period, or a pagehide request still in flight rides the blank through (log: ${page.log.join(", ")})`,
  );
});

test("(r4 #7 CONTROL) graceMs: 0 detaches straight away", async () => {
  const page = fakeBlankablePage();

  await blankPageSafely(page, { graceMs: 0 });

  assert.notEqual(page.marks.gotoEnd, null, `the fake goto ran (log: ${page.log.join(", ")})`);
  assert.notEqual(page.marks.detach, null, `the session was detached (log: ${page.log.join(", ")})`);
  const gap = page.marks.detach - page.marks.gotoEnd;
  assert.ok(gap >= 0 && gap < 40, `with no grace period the detach follows the goto at once (it came ${gap} ms later)`);
  assert.equal(page.log[page.log.length - 1], "detach", `the session is still detached (log: ${page.log.join(", ")})`);
});

// (r4 #8) A page the old page opens while it is being blanked is a page with a
// live document and no survivor of its own: it has to be blanked and closed too.
test("(r4 #8) a page opened while page 0 is being blanked is blanked and closed as well", async () => {
  const proc = fakeProcess();
  let late = null;
  const exit = fakeExitContext(2, {
    onGoto: (name, addPage) => {
      if (name === "0" && !late) late = addPage("late");
    },
  });
  const run = blankPagesOnExit(() => exit.context, { proc, budgetMs: 500 });

  proc.stdin.emit("close");
  await run();

  assert.ok(late, "the fake did add a page during the cleanup");
  assert.deepEqual(
    late.rec.gotos,
    ["about:blank"],
    `a page that appeared during the cleanup is blanked too (log: ${exit.log.join(", ")})`,
  );
  assert.equal(late.rec.closes, 1, `…and closed, or it is the one page left behind unguarded (log: ${exit.log.join(", ")})`);
  assert.deepEqual(exit.old.map((p) => p.rec.closes), [1, 1], `the pages that were there first are still cleaned (log: ${exit.log.join(", ")})`);
  assert.equal(exit.survivor().rec.closes, 0, `the survivor is never touched (log: ${exit.log.join(", ")})`);
  assert.deepEqual(exit.survivor().rec.gotos, [], `the survivor is never navigated (log: ${exit.log.join(", ")})`);
});

test("(r4 #8) a page opened while a late page is being blanked is handled too", async () => {
  const proc = fakeProcess();
  let late = null;
  let latest = null;
  const exit = fakeExitContext(1, {
    onGoto: (name, addPage) => {
      if (name === "0" && !late) { late = addPage("late"); return; }
      if (name === "late" && !latest) { latest = addPage("late2"); }
    },
  });
  const run = blankPagesOnExit(() => exit.context, { proc, budgetMs: 500 });

  proc.stdin.emit("close");
  await run();

  assert.ok(late, "the fake added the first late page during the cleanup");
  assert.deepEqual(late.rec.gotos, ["about:blank"], `the first late page is blanked (log: ${exit.log.join(", ")})`);
  assert.equal(late.rec.closes, 1, `the first late page is closed (log: ${exit.log.join(", ")})`);
  assert.deepEqual(
    latest?.rec.gotos ?? [],
    ["about:blank"],
    `the page that appeared while "late" was being blanked is blanked too: the loop over pages() has to keep ` +
      `going until nothing is left unprocessed (log: ${exit.log.join(", ")})`,
  );
  assert.equal(latest?.rec.closes ?? 0, 1, `…and closed as well, not left behind unguarded (log: ${exit.log.join(", ")})`);
  assert.equal(exit.survivor().rec.closes, 0, `the survivor is never touched (log: ${exit.log.join(", ")})`);
});

test("(r4 #8 CONTROL) with nothing added during the cleanup, only the original pages are touched", async () => {
  const proc = fakeProcess();
  const { log, pages, old, context, survivor } = fakeExitContext(2);
  const run = blankPagesOnExit(() => context, { proc, budgetMs: 500 });

  proc.stdin.emit("close");
  await run();

  assert.equal(pages.length, 3, `no page but the survivor was created (2 originals + survivor, got ${pages.length})`);
  assert.deepEqual(old.map((p) => p.rec.gotos), [["about:blank"], ["about:blank"]], `the original pages are blanked (log: ${log.join(", ")})`);
  assert.deepEqual(old.map((p) => p.rec.closes), [1, 1], `the original pages are closed (log: ${log.join(", ")})`);
  assert.equal(survivor().rec.closes, 0, `the survivor is never touched (log: ${log.join(", ")})`);
});

// ---------------------------------------------------------------------------
// guardedFetch
// ---------------------------------------------------------------------------

test("guardedFetch fetches a public URL and follows a public redirect", async () => {
  const { impl, calls } = fakeFetchRouter({
    "http://8.8.8.8/doc.pdf": () => new Response(null, { status: 302, headers: { location: "http://1.1.1.1/final.pdf" } }),
    "http://1.1.1.1/final.pdf": () => new Response("done", { status: 200 }),
  });

  const res = await guardedFetch("http://8.8.8.8/doc.pdf", { fetchImpl: impl });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "done");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].opts.redirect, "manual");
});

test("guardedFetch refuses a redirect into a private address before the second hop", async () => {
  const { impl, calls } = fakeFetchRouter({
    "http://8.8.8.8/doc.pdf": () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/secret" } }),
  });

  await assert.rejects(guardedFetch("http://8.8.8.8/doc.pdf", { fetchImpl: impl }), /private/i);
  assert.equal(calls.length, 1);
});

test("guardedFetch gives up on a redirect chain longer than maxRedirects", async () => {
  const hops = ["8.8.8.8", "1.1.1.1", "8.8.4.4", "9.9.9.9", "149.112.112.112", "208.67.222.222", "208.67.220.220"];
  const routes = {};
  for (let i = 0; i < hops.length - 1; i++) {
    routes[`http://${hops[i]}/r.pdf`] = () =>
      new Response(null, { status: 302, headers: { location: `http://${hops[i + 1]}/r.pdf` } });
  }
  routes[`http://${hops[hops.length - 1]}/r.pdf`] = () => new Response("end", { status: 200 });
  const { impl, calls } = fakeFetchRouter(routes);

  await assert.rejects(guardedFetch(`http://${hops[0]}/r.pdf`, { fetchImpl: impl }));
  assert.ok(calls.length <= hops.length);
});

test("guardedFetch refuses a private first URL without calling fetch", async () => {
  const { impl, calls } = fakeFetchRouter({});
  await assert.rejects(guardedFetch("http://127.0.0.1/x.pdf", { fetchImpl: impl }), /private/i);
  assert.equal(calls.length, 0);
});

// --- the default (pinned) fetch implementation ------------------------------

/** A throwaway HTTP server on 127.0.0.1 that records what reached it. */
async function startLocalServer(handler) {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push({ url: req.url, host: req.headers.host });
    handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    hits,
    port,
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(resolve);
    }),
  };
}

test("resolveChecked returns the addresses it judged, and the refusal otherwise", async () => {
  const { resolve } = resolverFor({ "checked.example": ["8.8.8.8", "1.1.1.1"] });

  const ok = await resolveChecked("http://checked.example/x", { resolve, noCache: true });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.addresses, ["8.8.8.8", "1.1.1.1"]);

  const literal = await resolveChecked("http://127.0.0.1/x", { resolve });
  assert.equal(literal.ok, false);
  assert.match(literal.reason, /loopback/i);

  const excepted = await resolveChecked("http://127.0.0.1/x", { exceptions: parseExceptions("127.0.0.1") });
  assert.equal(excepted.ok, true);
  assert.deepEqual(excepted.addresses, ["127.0.0.1"]);
});

/** Call a node-style lookup and collect its answer. */
function callLookup(lookup, hostname, opts) {
  return new Promise((resolve, reject) => {
    const cb = (err, address, family) => {
      if (err) reject(err); else resolve({ address, family });
    };
    if (opts === undefined) lookup(hostname, cb); else lookup(hostname, opts, cb);
  });
}

test("pinnedLookup answers with the checked addresses for a hostname, honouring opts.all", async () => {
  const lookup = pinnedLookup(["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"]);

  const all = await callLookup(lookup, "example.com", { all: true });
  assert.deepEqual(all.address, [
    { address: "93.184.216.34", family: 4 },
    { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
  ]);

  const one = await callLookup(lookup, "example.com", {});
  assert.equal(one.address, "93.184.216.34");
  assert.equal(one.family, 4);

  const cbOnly = await callLookup(lookup, "example.com");
  assert.equal(cbOnly.address, "93.184.216.34");
});

test("pinnedLookup refuses a private address the exception list does not cover", async () => {
  const refused = pinnedLookup(["10.0.0.5"]);
  await assert.rejects(callLookup(refused, "intranet.example", { all: true }), /private/i);

  const allowed = pinnedLookup(["10.0.0.5"], { exceptions: parseExceptions("10.0.0.0/8") });
  const answer = await callLookup(allowed, "intranet.example", { all: true });
  assert.deepEqual(answer.address, [{ address: "10.0.0.5", family: 4 }]);

  // metadata is never excepted, even by a range that covers it
  const metadata = pinnedLookup(["169.254.169.254"], { exceptions: parseExceptions("169.254.0.0/16") });
  await assert.rejects(callLookup(metadata, "metadata.example", { all: true }), /metadata/i);

  // A host NAME the owner listed excepts what it resolves to, exactly as checkUrl
  // decided, so the PDF tool agrees with the browser instead of refusing it.
  const byName = pinnedLookup(["127.0.0.1"], { nameExcepted: true });
  const nameAnswer = await callLookup(byName, "intranet.example", { all: true });
  assert.deepEqual(nameAnswer.address, [{ address: "127.0.0.1", family: 4 }]);

  // …but a name exception never covers a cloud-metadata address.
  const metadataByName = pinnedLookup(["169.254.169.254"], { nameExcepted: true, exceptions: parseExceptions("intranet.example") });
  await assert.rejects(callLookup(metadataByName, "intranet.example", { all: true }), /metadata/i);
});

test("the default fetch reaches a checked 127.0.0.1 address that the owner excepted", async () => {
  const local = await startLocalServer((req, res) => {
    res.writeHead(200, { "content-type": "application/pdf" });
    res.end("PDF-BYTES");
  });
  try {
    const res = await guardedFetch(`${local.base}/doc.pdf`, { exceptions: parseExceptions("127.0.0.1") });
    assert.equal(res.ok, true);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "PDF-BYTES");
    assert.deepEqual(local.hits.map((h) => h.url), ["/doc.pdf"]);
  } finally {
    await local.close();
  }
});

test("the default fetch connects to the checked address and never resolves the name again", async () => {
  const local = await startLocalServer((req, res) => res.end("ok"));
  const { resolve, counter } = resolverFor({ "pinned-name.example": ["127.0.0.1"] });
  try {
    const res = await guardedFetch(`http://pinned-name.example:${local.port}/x`, {
      exceptions: parseExceptions("127.0.0.1"),
      resolve,
    });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "ok");
    assert.equal(counter.calls, 1, "the name is resolved once, by the check");
    assert.deepEqual(local.hits.map((h) => h.url), ["/x"]);
  } finally {
    await local.close();
  }
});

test("the default fetch judges each redirect hop before connecting", async () => {
  const local = await startLocalServer((req, res) => {
    res.writeHead(302, { location: "http://127.0.0.2/secret" });
    res.end();
  });
  try {
    await assert.rejects(guardedFetch(`${local.base}/r.pdf`, { exceptions: parseExceptions("127.0.0.1") }), /loopback|private/i);
    assert.equal(local.hits.length, 1, "only the checked hop was connected to");
  } finally {
    await local.close();
  }
});

test("the default fetch reaches a host name the owner excepted, and refuses one it did not", async () => {
  const local = await startLocalServer((req, res) => res.end("EXCEPTED"));
  const { resolve } = resolverFor({ "intranet.example": ["127.0.0.1"], "other.example": ["127.0.0.1"] });
  const exceptions = parseExceptions("intranet.example");
  try {
    // checkUrl allowed the NAME, so the pinned lookup must allow what it resolved to.
    const res = await guardedFetch(`http://intranet.example:${local.port}/doc.pdf`, { exceptions, resolve, noCache: true });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "EXCEPTED");
    assert.deepEqual(local.hits.map((h) => h.url), ["/doc.pdf"]);

    // A name that is not on the list reaches nothing, even at the same address.
    await assert.rejects(
      guardedFetch(`http://other.example:${local.port}/doc.pdf`, { exceptions, resolve, noCache: true }),
      /loopback|private|Blocked/i,
    );
    assert.equal(local.hits.length, 1, "the non-excepted name never reached the server");
  } finally {
    await local.close();
  }
});

test("guardedFetch gives up on the whole fetch at its deadline, not just on a quiet hop", async () => {
  // The server accepts the request and never answers: only an overall deadline
  // can end this (the per-hop idle timeout is 30 s).
  const local = await startLocalServer(() => { /* never responds */ });
  const started = Date.now();
  try {
    await assert.rejects(
      guardedFetch(`${local.base}/slow.pdf`, { exceptions: parseExceptions("127.0.0.1"), deadlineMs: 150 }),
      /gave up after/i,
    );
    assert.ok(Date.now() - started < 5000, "the deadline ended the fetch");
    assert.equal(local.hits.length, 1, "the request was made, then abandoned");
  } finally {
    await local.close();
  }
});

// ---------------------------------------------------------------------------
// refusalResult
// ---------------------------------------------------------------------------

test("refusalResult is an MCP error that names the host, the reason and the setting", () => {
  const r = refusalResult({ ok: false, reason: "private network", host: "10.1.2.3", address: "10.1.2.3" });

  assert.equal(r.isError, true);
  assert.ok(Array.isArray(r.content));
  assert.equal(r.content[0].type, "text");
  const text = r.content[0].text;
  assert.ok(text.startsWith("Blocked: Crow's browser does not load private or local-network addresses"));
  assert.match(text, /10\.1\.2\.3/);
  assert.match(text, /private network/);
  assert.match(text, /CROW_BROWSER_ALLOW_PRIVATE/);
});

// ---------------------------------------------------------------------------
// static wiring of the server
// ---------------------------------------------------------------------------

/** The slice of source between two markers (marker strings included). */
function sliceBetween(src, start, end) {
  const i = src.indexOf(start);
  assert.notEqual(i, -1, `missing ${start}`);
  const j = src.indexOf(end, i + start.length);
  return j === -1 ? src.slice(i) : src.slice(i, j);
}

test("server.js wires the private-address guard into navigate, session restore, the reader and the PDF tool", () => {
  const src = readFileSync(SERVER_JS, "utf8");

  assert.match(src, /from\s+["']\.\/private-address\.js["']/);
  assert.match(src, /installPrivateAddressGuard\s*\(/);

  // navigate: checkUrl before the load, refusal reported from the catch
  const navigate = sliceBetween(src, '"crow_browser_navigate"', '"crow_browser_screenshot"');
  const navCheck = navigate.indexOf("checkUrl(");
  const navGoto = navigate.indexOf(".goto(");
  assert.notEqual(navCheck, -1, "navigate calls checkUrl");
  assert.notEqual(navGoto, -1, "navigate still calls goto");
  assert.ok(navCheck < navGoto, "checkUrl runs before goto");
  assert.match(navigate, /takeRefusal\(/);

  // session restore: the saved URL is checked before it is loaded
  const session = sliceBetween(src, '"crow_browser_load_session"', '"crow_browser_discover_selectors"');
  const sessCheck = session.indexOf("checkUrl(");
  const sessGoto = session.indexOf("p.goto(sessionData.url");
  assert.notEqual(sessCheck, -1, "load_session calls checkUrl");
  assert.notEqual(sessGoto, -1, "load_session still restores the URL");
  assert.ok(sessCheck < sessGoto, "checkUrl runs before the restore goto");

  // the reader ladder: each candidate is checked before it is loaded
  const article = sliceBetween(src, '"crow_browser_extract_article"', '"crow_browser_extract_pdf"');
  const articleCheck = article.indexOf("checkUrl(");
  const articleGoto = article.indexOf("p.goto(candidateUrl(m)");
  assert.notEqual(articleCheck, -1, "extract_article calls checkUrl");
  assert.notEqual(articleGoto, -1, "extract_article still loads a candidate");
  assert.ok(articleCheck < articleGoto, "checkUrl runs before the candidate goto");

  // the guard's own lifetime: the pages are blanked when this process goes away
  const blanked = src.indexOf("blankPagesOnExit(");
  const installed = src.indexOf("installPrivateAddressGuard(");
  assert.notEqual(blanked, -1, "server.js blanks the pages when the MCP process exits");
  assert.ok(blanked > installed, "the exit hook is wired after the guard is installed");

  // the PDF tool fetches through guardedFetch, never bare fetch
  const pdf = sliceBetween(src, '"crow_browser_extract_pdf"', '"crow_browser_capture_responses"');
  assert.match(pdf, /guardedFetch\(/);
  assert.doesNotMatch(pdf, /await fetch\(url_or_path/);
});

test("the browser bundle declares CROW_BROWSER_ALLOW_PRIVATE so the owner can allow a host", () => {
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  assert.ok(Array.isArray(manifest.server.envKeys));
  assert.ok(manifest.server.envKeys.includes("CROW_BROWSER_ALLOW_PRIVATE"));
});

// ---------------------------------------------------------------------------
// OOPIF frames: the network is blocked at the frame's own target (I13)
//
// A frame's Fetch deny-all session fails a paused request over a ROUND TRIP
// through this process, and the frame's target is torn down while the page
// navigates: on a live run the session died first ("Target page, context or
// browser has been closed") and the paused pagehide/unload requests were
// released to the private server. Network.setBlockedURLs is enforced inside the
// frame's own network stack with no round trip, so every OOPIF frame session
// gets `Network.enable` + `Network.setBlockedURLs { urls: ["*"] }` as well, and
// the Fetch handler stays. A failure of either is a failed attach.
// ---------------------------------------------------------------------------

/**
 * A fake page with `frames()`/`mainFrame()` and ONE fake CDP session per target.
 *
 * Each session records its sends as `{ method, params }` AND appends to one
 * ordered `log`, so a test can see both the per-target sequence and where it sits
 * against the page's goto. `frames` describes the child frames as
 * `{ name, behaviour }`, where behaviour is:
 *
 *   "ok" (the default)  a normal out-of-process frame with its own session
 *   "sameProcess"       newCDPSession rejects with Playwright's "This frame does
 *                       not have a separate CDP session…" message
 *   "otherError"        newCDPSession rejects with anything else
 *   "networkEnableFails"   Network.enable rejects on that frame's session
 *   "blockedUrlsFails"     Network.setBlockedURLs rejects on that frame's session
 */
function fakeFramePage({ frames = [], failGoto = false } = {}) {
  const log = [];
  const sessions = new Map();
  const marks = { gotoEnd: null };
  let url = "http://127.0.0.1:9/private";

  const makeSession = (target, behaviour) => {
    const session = {
      target,
      behaviour,
      pausedHandler: null,
      sends: [],
      on(event, fn) {
        log.push(`${target}:on:${event}`);
        if (event === "Fetch.requestPaused") session.pausedHandler = fn;
      },
      async send(method, params) {
        session.sends.push({ method, params });
        log.push(`${target}:send:${method}`);
        if (method === "Network.enable" && behaviour === "networkEnableFails") {
          throw new Error(`Network.enable refused on ${target}`);
        }
        if (method === "Network.setBlockedURLs" && behaviour === "blockedUrlsFails") {
          throw new Error(`Network.setBlockedURLs refused on ${target}`);
        }
      },
      async detach() {
        log.push(`${target}:detach`);
      },
    };
    sessions.set(target, session);
    return session;
  };

  const main = { name: "main" };
  const children = frames.map((frame) => ({ ...frame }));
  const page = {
    log,
    marks,
    sessions,
    mainFrame: () => main,
    frames: () => [main, ...children],
    url: () => url,
    async goto(target) {
      log.push(`goto:${target}`);
      if (failGoto) throw new Error("page crashed");
      url = target;
      marks.gotoEnd = Date.now();
    },
    context: () => ({
      async newCDPSession(target) {
        // `attachDenyAllSession` opens the page's own session with the PAGE as the
        // target, and a frame's with the frame.
        const name = target === main || target === page ? "main" : target.name;
        log.push(`attach:${name}`);
        const behaviour = name === "main" ? "ok" : (target.behaviour || "ok");
        if (behaviour === "sameProcess") {
          throw new Error(
            "This frame does not have a separate CDP session, it is a part of the parent frame's session",
          );
        }
        if (behaviour === "otherError") throw new Error(`no CDP session for frame ${name}`);
        return makeSession(name, behaviour);
      },
    }),
  };
  return page;
}

/**
 * A fake BrowserContext around one fake page (plus the fresh survivor
 * `newPage()` makes), so the exit cleanup can be run against the same fake and
 * its crash-vs-close decision observed in the page's own log.
 */
function fakeExitContextFor(page) {
  const log = page.log;
  page.isClosed = () => false;
  page.close = async () => { log.push("page:close"); };
  const pages = [page];
  const survivor = {
    url: () => "about:blank",
    isClosed: () => false,
    goto: async () => { log.push("goto:survivor"); },
    close: async () => { log.push("close:survivor"); },
  };
  const context = {
    pages: () => pages.slice(),
    async newPage() {
      log.push("newPage");
      pages.push(survivor);
      return survivor;
    },
    browser: () => ({
      async newBrowserCDPSession() {
        log.push("browser:newSession");
        return { async send(method) { log.push(`browser:send:${method}`); } };
      },
    }),
  };
  return { context, survivor };
}

const NETWORK_BLOCK = ["Fetch.enable", "Network.enable", "Network.setBlockedURLs"];

test("(I13) blankPageSafely blocks the network at an OOPIF frame's own target, not only through Fetch", async () => {
  const page = fakeFramePage({ frames: [{ name: "oopif" }] });

  await blankPageSafely(page, { graceMs: 0 });

  const frameSession = page.sessions.get("oopif");
  const pageSession = page.sessions.get("main");
  assert.ok(frameSession, `the OOPIF frame got its own session (log: ${page.log.join(", ")})`);
  assert.deepEqual(
    frameSession.sends.map((send) => send.method),
    NETWORK_BLOCK,
    `the frame's own target gets the Fetch deny-all AND the network-stack block, in that order ` +
      `(got ${frameSession.sends.map((send) => send.method).join(", ")})`,
  );
  assert.deepEqual(
    frameSession.sends.at(-1).params,
    { urls: ["*"] },
    `the network block covers every URL (got ${JSON.stringify(frameSession.sends.at(-1).params)})`,
  );
  assert.deepEqual(
    pageSession.sends.map((send) => send.method),
    ["Fetch.enable"],
    `the page's own session keeps the Fetch deny-all and is not given a second layer ` +
      `(got ${pageSession.sends.map((send) => send.method).join(", ")})`,
  );

  const gotoAt = page.log.indexOf("goto:about:blank");
  assert.notEqual(gotoAt, -1, `the page was blanked (log: ${page.log.join(", ")})`);
  for (const method of NETWORK_BLOCK) {
    const at = page.log.indexOf(`oopif:send:${method}`);
    assert.notEqual(at, -1, `the frame session got ${method} (log: ${page.log.join(", ")})`);
    assert.ok(
      at < gotoAt,
      `${method} lands on the frame session BEFORE the blank navigation — that navigation is what tears ` +
        `the frame's target down (log: ${page.log.join(", ")})`,
    );
  }

  const frameDetach = page.log.indexOf("oopif:detach");
  const pageDetach = page.log.indexOf("main:detach");
  assert.ok(frameDetach > gotoAt, `the frame session is detached after the blank (log: ${page.log.join(", ")})`);
  assert.ok(pageDetach > gotoAt, `the page session is detached after the blank (log: ${page.log.join(", ")})`);

  // The Fetch handler stays attached as well: belt and braces.
  assert.equal(typeof frameSession.pausedHandler, "function", "the frame keeps its Fetch deny-all handler too");
  frameSession.pausedHandler({ requestId: "r-1" });
  await flush();
  assert.deepEqual(
    frameSession.sends.at(-1),
    { method: "Fetch.failRequest", params: { requestId: "r-1", errorReason: "BlockedByClient" } },
    `a request the Fetch layer manages to fail is failed, not continued (log: ${page.log.join(", ")})`,
  );
});

test("(I13 CONTROL) a page with no frames has only the page session, and no network-stack block", async () => {
  const page = fakeFramePage({ frames: [] });

  await blankPageSafely(page, { graceMs: 0 });

  assert.deepEqual([...page.sessions.keys()], ["main"], `one session, for the page (log: ${page.log.join(", ")})`);
  assert.deepEqual(
    page.sessions.get("main").sends.map((send) => send.method),
    ["Fetch.enable"],
    `with no frame there is nothing to block at the network stack (got ${page.log.join(", ")})`,
  );
  assert.deepEqual(
    page.log.filter((entry) => entry.includes(":send:Network.")),
    [],
    `no Network.* is sent when there is no OOPIF frame (log: ${page.log.join(", ")})`,
  );
  assert.deepEqual(
    page.log.filter((entry) => entry.endsWith(":detach")),
    ["main:detach"],
    `the one session made is detached (log: ${page.log.join(", ")})`,
  );
  assert.ok(page.log.includes("goto:about:blank"), `the page is blanked as before (log: ${page.log.join(", ")})`);
});

test("(I13) a same-process frame's 'no separate CDP session' error is ignored and the page still blanks", async () => {
  const page = fakeFramePage({ frames: [{ name: "sameproc", behaviour: "sameProcess" }] });

  await blankPageSafely(page, { graceMs: 0 });

  assert.ok(page.log.includes("attach:sameproc"), `the frame was asked for a session (log: ${page.log.join(", ")})`);
  assert.deepEqual(
    [...page.sessions.keys()],
    ["main"],
    `a same-process frame has no session of its own, and none is invented (log: ${page.log.join(", ")})`,
  );
  assert.equal(
    page.log.filter((entry) => entry === "goto:about:blank").length,
    1,
    `the page is still blanked exactly once (log: ${page.log.join(", ")})`,
  );
  assert.ok(
    page.log.indexOf("main:detach") > page.log.indexOf("goto:about:blank"),
    `the page's session is detached after the blank (log: ${page.log.join(", ")})`,
  );
});

test("(I13 CONTROL) any other frame-session error fails the attach: no goto, and the exit cleanup crashes the browser", async () => {
  const page = fakeFramePage({ frames: [{ name: "broken", behaviour: "otherError" }] });

  await assert.rejects(blankPageSafely(page, { graceMs: 0 }), /no CDP session for frame broken/);
  assert.deepEqual(
    page.log.filter((entry) => entry.startsWith("goto:")),
    [],
    `a page whose frames could not all be guarded is never navigated (log: ${page.log.join(", ")})`,
  );
  assert.ok(page.log.includes("main:detach"), `the session made before the failure is released (log: ${page.log.join(", ")})`);

  const proc = fakeProcess();
  const { context, survivor } = fakeExitContextFor(page);
  const run = blankPagesOnExit(() => context, { proc, budgetMs: 500 });

  proc.stdin.emit("close");
  await run();

  assert.deepEqual(
    page.log.filter((entry) => entry.startsWith("goto:")),
    [],
    `the exit cleanup does not navigate a page it could not guard (log: ${page.log.join(", ")})`,
  );
  assert.ok(
    !page.log.includes("page:close"),
    `and never closes it: a close fires the very beacons nothing is in front of (log: ${page.log.join(", ")})`,
  );
  assert.ok(
    page.log.includes("browser:send:Browser.crash"),
    `the browser is crashed instead (log: ${page.log.join(", ")})`,
  );
  assert.ok(
    !page.log.includes("goto:survivor") && !page.log.includes("close:survivor"),
    `the survivor is untouched (log: ${page.log.join(", ")})`,
  );
  assert.ok(survivor, "the fake did make a survivor");
});

test("(I13) Network.enable or Network.setBlockedURLs rejecting on a frame session is a failed attach", async () => {
  for (const [behaviour, pattern] of [
    ["networkEnableFails", /Network\.enable refused on oopif/],
    ["blockedUrlsFails", /Network\.setBlockedURLs refused on oopif/],
  ]) {
    const page = fakeFramePage({ frames: [{ name: "oopif", behaviour }] });

    await assert.rejects(blankPageSafely(page, { graceMs: 0 }), pattern);
    assert.deepEqual(
      page.log.filter((entry) => entry.startsWith("goto:")),
      [],
      `${behaviour}: the page is not navigated with a frame block half applied (log: ${page.log.join(", ")})`,
    );
    assert.deepEqual(
      page.log.filter((entry) => entry.endsWith(":detach")).sort(),
      ["main:detach", "oopif:detach"],
      `${behaviour}: everything the failed attach made is released (log: ${page.log.join(", ")})`,
    );

    const proc = fakeProcess();
    const { context } = fakeExitContextFor(page);
    const run = blankPagesOnExit(() => context, { proc, budgetMs: 500 });

    proc.stdin.emit("close");
    await run();

    assert.deepEqual(
      page.log.filter((entry) => entry.startsWith("goto:")),
      [],
      `${behaviour}: the exit cleanup does not navigate the page either (log: ${page.log.join(", ")})`,
    );
    assert.ok(
      !page.log.includes("page:close"),
      `${behaviour}: and never closes it (log: ${page.log.join(", ")})`,
    );
    assert.ok(
      page.log.includes("browser:send:Browser.crash"),
      `${behaviour}: the browser is crashed instead (log: ${page.log.join(", ")})`,
    );
  }
});

// ---------------------------------------------------------------------------
// the exit path's own page session, and the budget (I14)
//
// 1. The PAGE's session on the exit path used to have only the Fetch deny-all,
//    which has the same round-trip race that was measured on OOPIF frames: the
//    target can die before Fetch.failRequest lands, and the paused unload
//    requests are released. The exit path therefore passes `permanent: true`, so
//    the page's own session gets Network.enable + Network.setBlockedURLs as well.
//    blankPageSafely must NOT: its page is reused after the detach, and a block
//    in that page's own network stack would outlive the detach.
// 2. The budget can expire while `newBrowserCDPSession()` is still pending. That
//    is not "no session": the crash has to wait for it (up to the crash grace)
//    instead of giving up and leaving the browser alive with armed pages.
// 3. A cleanup that ran out of budget says so on console.error.
// ---------------------------------------------------------------------------

test("(I14 #1) the exit path blocks the PAGE's own session in its network stack too, before the goto", async () => {
  const page = fakeFramePage({ frames: [] });
  const proc = fakeProcess();
  const { context } = fakeExitContextFor(page);
  const run = blankPagesOnExit(() => context, { proc, budgetMs: 500 });

  proc.stdin.emit("close");
  await run();

  const pageSession = page.sessions.get("main");
  assert.ok(pageSession, `the page got its session (log: ${page.log.join(", ")})`);
  assert.deepEqual(
    pageSession.sends.map((send) => send.method),
    ["Fetch.enable", "Network.enable", "Network.setBlockedURLs"],
    `the exit path's page session needs the round-trip-free block as well as the Fetch deny-all ` +
      `(got ${pageSession.sends.map((send) => send.method).join(", ")})`,
  );
  assert.deepEqual(
    pageSession.sends.at(-1).params,
    { urls: ["*"] },
    `the block covers every URL (got ${JSON.stringify(pageSession.sends.at(-1).params)})`,
  );

  const gotoAt = page.log.indexOf("goto:about:blank");
  assert.notEqual(gotoAt, -1, `the page was blanked (log: ${page.log.join(", ")})`);
  for (const method of ["Fetch.enable", "Network.enable", "Network.setBlockedURLs"]) {
    const at = page.log.indexOf(`main:send:${method}`);
    assert.notEqual(at, -1, `the page session got ${method} (log: ${page.log.join(", ")})`);
    assert.ok(
      at < gotoAt,
      `${method} lands on the page session BEFORE the blank navigation — that navigation is what can tear ` +
        `the target down under a paused request (log: ${page.log.join(", ")})`,
    );
  }
  assert.ok(
    pageSession.sends.some((send) => send.method === "Fetch.enable"),
    `the page keeps its Fetch deny-all too (belt and braces, log: ${page.log.join(", ")})`,
  );
  pageSession.pausedHandler({ requestId: "r-1" });
  await flush();
  assert.deepEqual(
    pageSession.sends.at(-1),
    { method: "Fetch.failRequest", params: { requestId: "r-1", errorReason: "BlockedByClient" } },
    `a request the Fetch layer reaches is still failed, not continued (log: ${page.log.join(", ")})`,
  );
});

test("(I14 #1 CONTROL) blankPageSafely's page session gets NO network-stack block: its page is reused after the detach", async () => {
  const page = fakeFramePage({ frames: [] });

  await blankPageSafely(page, { graceMs: 0 });

  assert.deepEqual(
    page.sessions.get("main").sends.map((send) => send.method),
    ["Fetch.enable"],
    `the same fake shows the block above when the attach is permanent; a page that outlives the detach must not ` +
      `get a block that stays in its own network stack (got ${page.log.join(", ")})`,
  );
  assert.deepEqual(
    page.log.filter((entry) => entry.includes(":send:Network.")),
    [],
    `no Network.* on the page's session here (log: ${page.log.join(", ")})`,
  );
});

/**
 * A context whose ONE old page cannot be blanked in time, around a browser session
 * that takes `opts.sessionDelayMs` to open (or never opens, when it is `Infinity`).
 * Everything the cleanup does lands in the returned `log`.
 */
function fakeSlowSessionContext({ sessionDelayMs = 0 } = {}) {
  const log = [];
  const page = {
    url: () => "http://127.0.0.1:9/0",
    isClosed: () => false,
    async goto() { log.push("goto:0"); },
    async close() { log.push("close:0"); },
  };
  const context = {
    pages: () => [page],
    async newPage() {
      log.push("newPage");
      return { url: () => "about:blank", async goto() {}, async close() {} };
    },
    browser: () => ({
      newBrowserCDPSession() {
        log.push("newSession:start");
        return new Promise((resolve) => {
          if (sessionDelayMs === Infinity) return; // never opens
          setTimeout(() => {
            log.push("newSession:ready");
            resolve({
              async send(method) { log.push(`browser:send:${method}`); },
            });
          }, sessionDelayMs);
        });
      },
    }),
  };
  return { log, context, page };
}

test("(I14 #2) a budget that expires while the browser session is still OPENING still sends Browser.crash, exactly once", async () => {
  // The session opens at 60 ms; the whole budget is 20 ms, so the budget is
  // guaranteed to fire while `newBrowserCDPSession()` is still pending.
  const { log, context } = fakeSlowSessionContext({ sessionDelayMs: 60 });
  const proc = fakeProcess();
  const run = blankPagesOnExit(() => context, { proc, budgetMs: 20 });

  proc.stdin.emit("close");
  const lines = await captureConsoleError(() => run());

  assert.ok(log.includes("newSession:ready"), `the session did open, after the budget (log: ${log.join(", ")})`);
  assert.equal(
    log.filter((entry) => entry === "browser:send:Browser.crash").length,
    1,
    `a budget that fires mid-open is not "no session": the crash has to be sent once it arrives, and only once ` +
      `(log: ${log.join(", ")})`,
  );
  assert.deepEqual(
    lines.filter((line) => /could not crash the browser/.test(line)),
    [],
    `the crash was sent, so nothing gives up (lines: ${lines.join(" | ")})`,
  );
  assert.equal(
    lines.filter((line) => /ran out of its 20 ms budget/.test(line)).length,
    1,
    `and the budget still says so once (lines: ${lines.join(" | ")})`,
  );
  assert.deepEqual(
    log.filter((entry) => entry === "close:0"),
    [],
    `page 0 was never blanked, so it is not closed on the way to the crash (log: ${log.join(", ")})`,
  );
});

test("(I14 #2 CONTROL) a session that NEVER opens: no crash, one give-up line, and run() lets go within budget + grace", async () => {
  const { log, context } = fakeSlowSessionContext({ sessionDelayMs: Infinity });
  const proc = fakeProcess();
  const run = blankPagesOnExit(() => context, { proc, budgetMs: 20 });

  proc.stdin.emit("close");
  const started = Date.now();
  const lines = await captureConsoleError(() => run());
  const elapsed = Date.now() - started;

  assert.deepEqual(
    log.filter((entry) => entry.startsWith("browser:send")),
    [],
    `nothing was sent: there was never a session to send it over (log: ${log.join(", ")})`,
  );
  assert.equal(
    lines.filter((line) => /could not crash the browser \(no browser CDP session is open\)/.test(line)).length,
    1,
    `the give-up is one line, and it names the missing session (lines: ${lines.join(" | ")})`,
  );
  assert.equal(
    lines.filter((line) => /ran out of its 20 ms budget/.test(line)).length,
    1,
    `the budget line is the other one (lines: ${lines.join(" | ")})`,
  );
  assert.ok(
    elapsed < 20 + 300 + 500,
    `waiting for a session that never arrives is bounded by the crash grace, so run() still lets go ` +
      `(took ${elapsed} ms)`,
  );
});

test("(I14 #3) a cleanup that runs out of budget says so, once, on console.error", async () => {
  const proc = fakeProcess();
  const { context } = fakeExitContext(1, { neverGoto: () => true, crashHangs: true });
  const run = blankPagesOnExit(() => context, { proc, budgetMs: 30 });

  const lines = await captureConsoleError(async () => {
    proc.stdin.emit("close");
    await run();
  });

  assert.equal(
    lines.filter((line) => /ran out of its 30 ms budget/.test(line)).length,
    1,
    `the budget expiring is what makes the browser crash, so it has to be visible once (lines: ${lines.join(" | ")})`,
  );
});

test("(I14 #3 CONTROL) the same cleanup inside its budget logs nothing at all", async () => {
  const proc = fakeProcess();
  const { log, context } = fakeExitContext(2);
  const run = blankPagesOnExit(() => context, { proc, budgetMs: 1000 });

  const lines = await captureConsoleError(async () => {
    proc.stdin.emit("close");
    await run();
  });

  assert.deepEqual(lines, [], `nothing went wrong, so nothing is logged (log: ${log.join(", ")})`);
});

// (I14 #5) The exit cleanup has to be on the SHARED exit promise (exit-tasks.js),
// because the lease guard's SIGTERM/SIGINT exit awaits that promise and would
// otherwise cut the cleanup off half way. Source text alone cannot show it landed
// there, so this drives the real thing: no `opts.proc`, then `runExitTasks()`.
//
// ORDER MATTERS between this test and its control: the shared promise snapshots
// its tasks on the FIRST run, so the registration has to happen before any call
// here — and the control, which calls it too, must come after.
test("(I14 #5) blankPagesOnExit on the real process adds ONE task to the shared exit promise, and runExitTasks() runs it", async () => {
  const events = ["SIGTERM", "SIGINT", "beforeExit"];
  const before = new Map(events.map((event) => [event, new Set(process.listeners(event))]));
  const stdin = process.stdin || null;
  const stdinBefore = stdin ? new Set([...stdin.listeners("close"), ...stdin.listeners("end")]) : new Set();

  const dropNew = (target, event, keep) => {
    if (!target || typeof target.listeners !== "function") return;
    for (const listener of target.listeners(event)) {
      if (!keep.has(listener)) target.removeListener(event, listener);
    }
  };

  let calls = 0;
  try {
    // No opts.proc: the real process, the only registration the shared instance gets.
    blankPagesOnExit(() => { calls += 1; return null; }, { budgetMs: 50 });
    await runExitTasks();
  } finally {
    // Only the listeners THIS test added: never removeAllListeners, which would
    // take the test runner's own listeners with it.
    for (const event of events) dropNew(process, event, before.get(event));
    if (stdin) {
      dropNew(stdin, "close", stdinBefore);
      dropNew(stdin, "end", stdinBefore);
    }
  }

  assert.equal(
    calls,
    1,
    `the shared exit promise has to run this cleanup exactly once (a second registration would call the getter ` +
      `twice, none would leave it uncalled) — got ${calls}`,
  );
});

test("(I14 #5 CONTROL) an injected fake proc's cleanup is NOT on the shared exit promise", async () => {
  // The shared promise was run by the test above; this shows that a fake proc's
  // registration never reaches it — while the same cleanup IS live on the proc it
  // was registered with, so the zero below is not a broken cleanup.
  const first = runExitTasks();
  const proc = fakeProcess();
  let calls = 0;
  const run = blankPagesOnExit(() => { calls += 1; return null; }, { proc, budgetMs: 50 });

  assert.equal(runExitTasks(), first, "the shared exit promise is one promise, however often it is asked for");
  await runExitTasks();
  assert.equal(calls, 0, `the shared exit promise does not run a fake proc's cleanup (calls: ${calls})`);

  // The observable the zero rests on: the snapshot is taken on the first run, so a
  // task registered later is ignored for it. (This sentinel must never run.)
  let sentinel = 0;
  addExitTask(() => { sentinel += 1; });
  await runExitTasks();
  assert.equal(sentinel, 0, "a task added after the run started is not part of it");

  // …and the cleanup is real: its own proc's exit event runs it.
  proc.stdin.emit("close");
  await run();
  assert.equal(calls, 1, `the fake proc's own exit event runs its cleanup (calls: ${calls})`);
});

// ---------------------------------------------------------------------------
// the exit cleanup and the old document's unload work (closing too early)
//
// `blankAndCloseOnePage` closes a page as soon as its about:blank navigation has
// resolved. When that navigation swaps the renderer, the OLD document's
// pagehide/unload handlers run asynchronously in the old renderer AFTER the goto
// resolved, and Chromium bounds that work at about 500 ms — the same reason
// `blankPageSafely` keeps its deny-all session attached for BLANK_GRACE_MS. The
// exit path has to give the old document that much time before `page.close()`
// destroys the target and with it the deny-all session.
// ---------------------------------------------------------------------------

/**
 * A fake exit context whose pages record when their blank committed and when
 * they were closed, and which models a request the OLD document sends `lateMs`
 * after its about:blank navigation resolved:
 *
 *   - the request is BLOCKED while something is still in front of it (the
 *     page's deny-all session, which lives in the page's target);
 *   - it is a LEAK once `page.close()` has torn that target down, because the
 *     session went with it and the request leaves with nothing in front of it.
 *
 * `lateMs: 0` means the old document sends nothing after the blank.
 */
function fakeUnloadExitContext(pageCount, { lateMs = 0 } = {}) {
  const log = [];
  const pages = [];

  const addPage = (name) => {
    const rec = {
      name,
      url: `http://127.0.0.1:9/${name}`,
      gotos: [],
      closes: 0,
      blankedAt: null,
      closedAt: null,
      lateSends: 0,
      blocked: 0,
      leaks: 0,
    };
    // Closing the page tears its target down, and the deny-all CDP session lives
    // in that target: one flag says whether anything still guards a request.
    let guarded = true;
    const session = {
      on() {},
      async send() {},
      async detach() {
        guarded = false;
        log.push(`detach:${name}`);
      },
    };
    const page = {
      rec,
      url: () => rec.url,
      isClosed: () => false,
      frames: () => [],
      context: () => ({
        async newCDPSession() {
          log.push(`attach:${name}`);
          return session;
        },
      }),
      async goto(target) {
        rec.gotos.push(target);
        log.push(`goto:${name}:start`);
        await flush();
        rec.url = target;
        rec.blankedAt = Date.now();
        log.push(`goto:${name}:end`);
        if (lateMs > 0) {
          setTimeout(() => {
            rec.lateSends += 1;
            if (guarded) {
              rec.blocked += 1;
              log.push(`blocked:${name}`);
            } else {
              rec.leaks += 1;
              log.push(`leak:${name}`);
            }
          }, lateMs);
        }
      },
      async close() {
        rec.closes += 1;
        rec.closedAt = Date.now();
        guarded = false;
        log.push(`close:${name}`);
      },
    };
    pages.push(page);
    return page;
  };

  const old = [];
  for (let i = 0; i < pageCount; i++) old.push(addPage(String(i)));

  const context = {
    pages: () => pages.slice(),
    async newPage() {
      log.push("newPage");
      return addPage("survivor");
    },
    browser: () => ({
      async newBrowserCDPSession() {
        log.push("browser:newSession");
        return { async send(method) { log.push(`browser:send:${method}`); } };
      },
    }),
  };

  return { log, old, context };
}

test("exit cleanup: a page is not closed until its old document's unload work can have finished", async () => {
  const proc = fakeProcess();
  const exit = fakeUnloadExitContext(1);
  const run = blankPagesOnExit(() => exit.context, { proc, budgetMs: 5000 });

  proc.stdin.emit("close");
  await run();

  const rec = exit.old[0].rec;
  assert.deepEqual(rec.gotos, ["about:blank"], `the old page is blanked (log: ${exit.log.join(", ")})`);
  assert.equal(rec.closes, 1, `the old page is still closed (log: ${exit.log.join(", ")})`);
  assert.notEqual(rec.blankedAt, null, `the fake blank committed (log: ${exit.log.join(", ")})`);
  const gap = rec.closedAt - rec.blankedAt;
  assert.ok(
    gap >= 450,
    `the page was closed ${gap} ms after its about:blank commit. The old document's pagehide/unload handlers ` +
      "run in the old renderer after the blank resolves, and Chromium bounds that work at about 500 ms: a close " +
      "before then destroys the target and its deny-all session while a handler can still send " +
      `(log: ${exit.log.join(", ")})`,
  );
  assert.deepEqual(
    exit.log.filter((entry) => entry.startsWith("browser:send")),
    [],
    `nothing failed, so the browser is not killed (log: ${exit.log.join(", ")})`,
  );
});

test("exit cleanup: a request the old document sends after the blank is blocked, never leaked", async () => {
  const proc = fakeProcess();
  const lateMs = 200;
  const exit = fakeUnloadExitContext(1, { lateMs });
  const run = blankPagesOnExit(() => exit.context, { proc, budgetMs: 5000 });

  proc.stdin.emit("close");
  await run();

  // The old document's request lands after the cleanup itself has returned on a
  // cleanup that closes too early, so wait for it rather than assuming it ran.
  const rec = exit.old[0].rec;
  const deadline = Date.now() + lateMs + 1000;
  while (rec.lateSends === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(rec.lateSends, 1, `the fake old document did send after the blank (log: ${exit.log.join(", ")})`);
  assert.equal(rec.leaks, 0, `a send ${lateMs} ms after the blank found nothing in front of it: the page was ` +
    `closed while its old document could still be unloading (log: ${exit.log.join(", ")})`);
  assert.equal(
    rec.blocked,
    1,
    `the send is what the deny-all session has to fail, so it has to reach one that is still attached ` +
      `(log: ${exit.log.join(", ")})`,
  );
  assert.equal(rec.closes, 1, `the page is still closed once the grace is over (log: ${exit.log.join(", ")})`);
});

test("exit cleanup: three pages share one grace period, and every page is still closed", async () => {
  const proc = fakeProcess();
  const exit = fakeUnloadExitContext(3);
  const run = blankPagesOnExit(() => exit.context, { proc, budgetMs: 5000 });

  proc.stdin.emit("close");
  await run();

  assert.deepEqual(
    exit.old.map((page) => page.rec.closes),
    [1, 1, 1],
    `every old page is closed (log: ${exit.log.join(", ")})`,
  );
  for (const page of exit.old) {
    assert.notEqual(page.rec.blankedAt, null, `page ${page.rec.name} was blanked (log: ${exit.log.join(", ")})`);
    const gap = page.rec.closedAt - page.rec.blankedAt;
    assert.ok(
      gap >= 450,
      `page ${page.rec.name} was closed ${gap} ms after its own blank, not after the grace ` +
        `(log: ${exit.log.join(", ")})`,
    );
  }

  const firstBlank = Math.min(...exit.old.map((page) => page.rec.blankedAt));
  const lastClose = Math.max(...exit.old.map((page) => page.rec.closedAt));
  assert.ok(
    lastClose - firstBlank < 1500,
    `three pages took ${lastClose - firstBlank} ms from the first blank to the last close: the graces have to ` +
      "overlap (one grace for the pages being blanked), not add up to three of them " +
      `(log: ${exit.log.join(", ")})`,
  );
});

test("exit cleanup: a page whose blank did not commit is not closed, and the grace does not delay its crash", async () => {
  const proc = fakeProcess();
  const { log, old, context } = fakeExitContext(2, { uncommitted: (name) => name === "0" });
  const run = blankPagesOnExit(() => context, { proc, budgetMs: 500 });

  const started = Date.now();
  proc.stdin.emit("close");
  await run();
  const elapsed = Date.now() - started;

  assert.equal(
    old[0].rec.closes,
    0,
    `a goto that resolved without committing about:blank is not a blanked page: the old document is still ` +
      `there, so a close would fire its beacons with nothing in front of them (log: ${log.join(", ")})`,
  );
  assert.equal(
    log.filter((entry) => entry === "browser:send:Browser.crash").length,
    1,
    `the browser is crashed instead, exactly once (log: ${log.join(", ")})`,
  );
  assert.deepEqual(old[1].rec.gotos, [], `the page behind it is not navigated either (log: ${log.join(", ")})`);
  assert.ok(
    elapsed < 300,
    `the cleanup took ${elapsed} ms to reach its crash: the grace belongs to a blank that COMMITTED, and this ` +
      `one never did (log: ${log.join(", ")})`,
  );
});

// ---------------------------------------------------------------------------
// a page that ARRIVES while the closes are being waited out
//
// The page loop stops as soon as a re-read of `context.pages()` finds nothing left
// to handle, and the cleanup then waits out the grace of the closes it scheduled
// (UNLOAD_GRACE_MS, 500 ms per page, counted from that page's own commit). A page
// the old document opens in that window — a popup, a new tab — is a live page with
// no deny-all session of its own and no survivor to fall back on, and "only closes
// are left" is a fact about the pages that were READ, not about the ones that
// appear afterwards. The same holds for the budget path, which reads that flag to
// decide between crashing and waiting.
// ---------------------------------------------------------------------------

/**
 * A fake exit context whose pages record when their OWN blank committed and when
 * they were closed (so "closed no earlier than its own grace after its own blank"
 * is measurable), and which ADDS pages to `context.pages()` `arrivalDelayMs` after
 * the first old page's blank commits — i.e. while that page's close is still inside
 * its grace.
 *
 * `latePages` names those arrivals: `{ name, owner }`, and `neverBlanks: true` for
 * one whose about:blank navigation never settles (a page that is still unblanked
 * when the cleanup's budget runs out). `owner` is the class the fake `ownership`
 * answers with ("bot" by default), so the same fake drives the legacy mode (no
 * ownership: every page is the bot's) and the ownership mode (only the bot's pages
 * are touched, and an operator page is left exactly as it is).
 */
function fakeLateArrivalContext({ pageCount = 1, arrivalDelayMs = 100, latePages = [] } = {}) {
  const log = [];
  const pages = [];
  const records = new Map();
  const owners = new Map();
  let arrivalsAdded = false;

  const addPage = (name, owner, { neverBlanks = false } = {}) => {
    const rec = {
      name,
      url: `http://127.0.0.1:9/${name}`,
      gotos: [],
      closes: 0,
      attached: 0,
      isClosedProbes: 0,
      blankedAt: null,
      closedAt: null,
    };
    records.set(name, rec);
    // The deny-all session lives in the page's target: attaching it is what the
    // cleanup has to do BEFORE it navigates a page whose old document can send.
    const session = { on() {}, async send() {}, async detach() { log.push(`detach:${name}`); } };
    const page = {
      rec,
      url: () => rec.url,
      isClosed: () => { rec.isClosedProbes += 1; return false; },
      frames: () => [],
      context: () => ({
        async newCDPSession() {
          rec.attached += 1;
          log.push(`attach:${name}`);
          return session;
        },
      }),
      async goto(target) {
        rec.gotos.push(target);
        log.push(`goto:${name}:start`);
        // A navigation that never settles: this page is still unblanked when the
        // cleanup's budget runs out.
        if (neverBlanks) {
          await new Promise(() => {});
          return;
        }
        await flush();
        rec.url = target;
        rec.blankedAt = Date.now();
        log.push(`goto:${name}:end`);
        if (name === "0") addArrivals();
      },
      async close() {
        rec.closes += 1;
        rec.closedAt = Date.now();
        log.push(`close:${name}`);
      },
    };
    owners.set(page, owner);
    pages.push(page);
    return page;
  };

  const addArrivals = () => {
    if (arrivalsAdded) return;
    arrivalsAdded = true;
    setTimeout(() => {
      for (const arrival of latePages) {
        addPage(arrival.name, arrival.owner || "bot", { neverBlanks: arrival.neverBlanks === true });
      }
    }, arrivalDelayMs);
  };

  const old = [];
  for (let i = 0; i < pageCount; i++) old.push(addPage(String(i), "bot"));

  const context = {
    pages: () => pages.slice(),
    async newPage() {
      log.push("newPage");
      return addPage("survivor", "operator");
    },
    browser: () => ({
      async newBrowserCDPSession() {
        log.push("browser:newSession");
        return { async send(method) { log.push(`browser:send:${method}`); } };
      },
    }),
  };

  // The seams `blankOwnedPages` reads: classify / settle / classifying, plus the
  // two reporting counts `ownsBotWork` uses (an ownership that cannot answer them
  // is read as pending-work-means-bot-work, which is not what this fake is about).
  const ownership = {
    classify: (page) => owners.get(page) || "uncertain",
    async settle() {},
    classifying: () => false,
    botPageCount: () => Array.from(owners.values()).filter((owner) => owner === "bot").length,
    unresolvedMarks: () => 0,
    pending: () => false,
  };

  return { log, old, pages, records, context, ownership };
}

// (legacy mode) The one old page is blanked at ~0 ms, so its close is scheduled for
// its commit + 500 ms and the cleanup spends that window waiting. A page that lands
// in that window is exactly as unprotected as one that landed before the loop ran.
test("exit cleanup: a page that arrives while a close is pending is blanked and closed too", async () => {
  const proc = fakeProcess();
  const exit = fakeLateArrivalContext({ pageCount: 1, arrivalDelayMs: 100, latePages: [{ name: "late" }] });
  const run = blankPagesOnExit(() => exit.context, { proc, budgetMs: 5000 });

  proc.stdin.emit("close");
  await run();

  const late = exit.records.get("late");
  assert.ok(late, `the fake did add a page while the first page's close was pending (log: ${exit.log.join(", ")})`);
  assert.deepEqual(
    late.gotos,
    ["about:blank"],
    `a page that appeared while the cleanup was only waiting out closes is a live page with a document of ` +
      `its own: it has to be blanked, not left as it arrived (got ${JSON.stringify(late.gotos)}; log: ${exit.log.join(", ")})`,
  );
  assert.equal(
    late.attached,
    1,
    `and it has to be given the deny-all session BEFORE that blank, or its old document's pagehide/unload ` +
      `requests leave unguarded (got ${late.attached}; log: ${exit.log.join(", ")})`,
  );
  assert.equal(
    late.closes,
    1,
    `and closed, or it is the one page left behind after the routes went with this process ` +
      `(got ${late.closes}; log: ${exit.log.join(", ")})`,
  );
  assert.notEqual(late.blankedAt, null, `the late page's blank committed (log: ${exit.log.join(", ")})`);
  const gap = late.closedAt - late.blankedAt;
  assert.ok(
    gap >= 450,
    `the late page was closed ${gap} ms after ITS OWN about:blank commit: its old document's unload work can ` +
      `still be running, so its close needs its own grace too (log: ${exit.log.join(", ")})`,
  );
  assert.equal(exit.records.get("0").closes, 1, `the page that was there first is still closed as before (log: ${exit.log.join(", ")})`);
  assert.deepEqual(
    exit.log.filter((entry) => entry.startsWith("browser:send")),
    [],
    `nothing failed, so the browser is not killed (log: ${exit.log.join(", ")})`,
  );
});

// (legacy mode, budget) The budget expires at 300 ms, while page 0's close is still
// pending and the arriving page has not been blanked. "Only closes are left" was
// true of the pages the loop READ; it says nothing about an arrival, so trusting it
// here ends the cleanup with an armed page rather than crashing the browser.
test("exit cleanup: a budget that expires while a NEW page is still unblanked crashes the browser", async () => {
  const proc = fakeProcess();
  const exit = fakeLateArrivalContext({
    pageCount: 1,
    arrivalDelayMs: 100,
    latePages: [{ name: "late", neverBlanks: true }],
  });
  const run = blankPagesOnExit(() => exit.context, { proc, budgetMs: 300 });

  const lines = await captureConsoleError(async () => {
    proc.stdin.emit("close");
    await run();
  });

  assert.equal(
    exit.log.filter((entry) => entry === "browser:send:Browser.crash").length,
    1,
    `a page that arrived after the loop stopped finding pages is still unblanked when the budget runs out, so ` +
      `the browser is the only safe end for it — exactly one crash (got ` +
      `${exit.log.filter((entry) => entry === "browser:send:Browser.crash").length}; log: ${exit.log.join(", ")})`,
  );
  assert.equal(
    lines.filter((line) => /ran out of its 300 ms budget/.test(line)).length,
    1,
    `and the budget says so once, instead of the cleanup reading as finished (lines: ${lines.join(" | ")})`,
  );
  assert.equal(
    exit.records.get("late").closes,
    0,
    `the arriving page's blank never committed, so it is not closed on the way to the crash ` +
      `(log: ${exit.log.join(", ")})`,
  );
  assert.deepEqual(
    exit.log.filter((entry) => entry.startsWith("close:late")),
    [],
    `no close of the unblanked arrival fires its pagehide beacons (log: ${exit.log.join(", ")})`,
  );
});

// (ownership mode) The same window, with the classes narrowed: the bot's arrival is
// the bot's whatever moment it appears in, and an operator-classified arrival is
// still left alone — no CDP session, no navigation, no close, not even isClosed().
test("exit cleanup (ownership): a bot page arriving during the close phase is blanked, an operator page arriving then is left alone", async () => {
  const proc = fakeProcess();
  const exit = fakeLateArrivalContext({
    pageCount: 1,
    arrivalDelayMs: 100,
    latePages: [
      { name: "late-bot", owner: "bot" },
      { name: "late-operator", owner: "operator" },
    ],
  });
  const run = blankPagesOnExit(() => exit.context, { proc, budgetMs: 5000, ownership: exit.ownership });

  proc.stdin.emit("close");
  await run();

  const bot = exit.records.get("late-bot");
  assert.ok(bot, `the fake did add a bot page during the close phase (log: ${exit.log.join(", ")})`);
  assert.deepEqual(
    bot.gotos,
    ["about:blank"],
    `a BOT page that appeared while only closes were left has to be blanked like any other: its document is ` +
      `the bot's, and the survivor made for the first page is not a stand-in for it ` +
      `(got ${JSON.stringify(bot.gotos)}; log: ${exit.log.join(", ")})`,
  );
  assert.equal(
    bot.attached,
    1,
    `and given the deny-all session before that blank (got ${bot.attached}; log: ${exit.log.join(", ")})`,
  );
  assert.equal(bot.closes, 1, `and closed (got ${bot.closes}; log: ${exit.log.join(", ")})`);
  assert.notEqual(bot.blankedAt, null, `the late bot page's blank committed (log: ${exit.log.join(", ")})`);
  const gap = bot.closedAt - bot.blankedAt;
  assert.ok(
    gap >= 450,
    `the late bot page was closed ${gap} ms after ITS OWN about:blank commit, not before its own grace ` +
      `(log: ${exit.log.join(", ")})`,
  );

  const operator = exit.records.get("late-operator");
  assert.ok(operator, `the fake did add an operator page during the close phase (log: ${exit.log.join(", ")})`);
  assert.deepEqual(
    operator.gotos,
    [],
    `an OPERATOR page is never navigated, whatever moment it appears in (got ${JSON.stringify(operator.gotos)}; ` +
      `log: ${exit.log.join(", ")})`,
  );
  assert.equal(operator.closes, 0, `and never closed (got ${operator.closes}; log: ${exit.log.join(", ")})`);
  assert.equal(
    operator.attached,
    0,
    `and never even given a CDP session, which could be written to (got ${operator.attached}; log: ${exit.log.join(", ")})`,
  );
  assert.equal(
    operator.isClosedProbes,
    0,
    `and not probed at all: the operator's page is left exactly as it is (got ${operator.isClosedProbes} isClosed() ` +
      `calls; log: ${exit.log.join(", ")})`,
  );

  assert.equal(exit.records.get("0").closes, 1, `the bot page that was there first is still cleaned (log: ${exit.log.join(", ")})`);
  assert.deepEqual(
    exit.log.filter((entry) => entry.startsWith("browser:send")),
    [],
    `nothing failed, so the browser is not killed (log: ${exit.log.join(", ")})`,
  );
});

// ---------------------------------------------------------------------------
// the budget's exemption, and the two holes in it
//
// When the budget expires, `everyPageHandled()` decides between crashing the
// browser and waiting a cleanup's remaining closes out. Two things it must not
// read as "handled":
//
//   HOLE 1  a page whose url() answers "about:blank" is NOT a page this cleanup
//           blanked. A page can arrive already at about:blank (or navigate itself
//           back to it) with a live document of its own; nothing attached a
//           deny-all session to it and it was never offered a goto, so its
//           pagehide/unload beacons are as armed as any other page's.
//   HOLE 2  the exemption's own wait is BOUNDED (UNLOAD_GRACE_MS +
//           CRASH_GRACE_MS). A close that never answers makes that bound the end
//           of the WAIT, not the end of the danger: when the time runs out with a
//           page still open, the browser has to be crashed, or the cleanup lets
//           the process go with an unclosed page behind it.
// ---------------------------------------------------------------------------

/**
 * A fake exit context for the budget's exemption.
 *
 * ONE old page ("0") that blanks at once, so its close is SCHEDULED and still
 * pending when the budget expires, plus the survivor `context.newPage()` makes,
 * plus the pages `arrivals` names — added to `context.pages()` `delayMs` after the
 * fake is made, i.e. while page 0's close is still inside its grace and after the
 * cleanup's page loop has already found nothing left.
 *
 * An arrival says what it is when the budget reads it:
 *   { name, delayMs, url }  url is what its url() answers — "about:blank" for a
 *                           page that arrived already there, with a live document
 *                           and no goto of this cleanup's behind it
 *   closed: true            isClosed() answers true (a page that is already gone)
 *   owner: "operator"       the class the fake ownership answers with ("bot" by
 *                           default), so the same fake drives both modes
 *
 * `closeHangs: true` makes the OLD page's page.close() a promise that never
 * settles: the close is issued and never answers. The browser session's
 * Browser.crash never answers either, like a real one, and `timing.crashAt` is the
 * moment that send happened, so a test can say WHEN the browser was crashed.
 */
function fakeGraceExitContext({ arrivals = [], closeHangs = false } = {}) {
  const log = [];
  const pages = [];
  const records = new Map();
  const owners = new Map();
  const timing = { crashAt: null };

  const addPage = (name, opts = {}) => {
    const rec = {
      name,
      // A page that arrives at about:blank was never blanked BY THIS CLEANUP: there
      // is no goto of its own and no deny-all session in front of it.
      url: opts.url === undefined ? `http://127.0.0.1:9/${name}` : opts.url,
      gotos: [],
      closes: 0,
      attached: 0,
      blankedAt: null,
      closeAt: null,
      closedAt: null,
      isClosed: opts.closed === true,
    };
    records.set(name, rec);
    const session = { on() {}, async send() {}, async detach() { log.push(`detach:${name}`); } };
    const page = {
      rec,
      url: () => rec.url,
      isClosed: () => rec.isClosed,
      frames: () => [],
      context: () => ({
        async newCDPSession() {
          rec.attached += 1;
          log.push(`attach:${name}`);
          return session;
        },
      }),
      async goto(target) {
        rec.gotos.push(target);
        log.push(`goto:${name}:start`);
        await flush();
        rec.url = target;
        rec.blankedAt = Date.now();
        log.push(`goto:${name}:end`);
      },
      async close() {
        rec.closes += 1;
        rec.closeAt = Date.now();
        log.push(`close:${name}`);
        // A close that never answers: the cleanup's wait for it can only end at its
        // own bound.
        if (opts.closeHangs === true) await new Promise(() => {});
        rec.closedAt = Date.now();
        log.push(`close:${name}:done`);
      },
    };
    owners.set(page, opts.owner || "bot");
    pages.push(page);
    return page;
  };

  const old = addPage("0", { closeHangs });

  for (const arrival of arrivals) {
    setTimeout(() => { addPage(arrival.name, arrival); }, arrival.delayMs === undefined ? 50 : arrival.delayMs);
  }

  const context = {
    pages: () => pages.slice(),
    async newPage() {
      log.push("newPage");
      return addPage("survivor", { url: "about:blank", owner: "operator" });
    },
    browser: () => ({
      async newBrowserCDPSession() {
        log.push("browser:newSession");
        return {
          async send(method) {
            log.push(`browser:send:${method}`);
            // A real crash never answers: the socket dies with the browser.
            if (method === "Browser.crash") {
              timing.crashAt = Date.now();
              await new Promise(() => {});
            }
          },
        };
      },
    }),
  };

  // The seams `blankOwnedPages` reads, plus the two reporting counts `ownsBotWork`
  // uses (an ownership that cannot answer them is read as pending-work-means-bot-work,
  // which is not what this fake is about).
  const ownership = {
    classify: (page) => owners.get(page) || "uncertain",
    async settle() {},
    classifying: () => false,
    botPageCount: () => Array.from(owners.values()).filter((owner) => owner === "bot").length,
    unresolvedMarks: () => 0,
    pending: () => false,
  };

  return { log, old, pages, records, timing, context, ownership };
}

// The budget expires at 400 ms with page 0 already blanked (its close scheduled for
// its commit + 750 ms) and a page that arrived at 50 ms sitting at about:blank, never
// blanked by this cleanup. That page is a live document with no deny-all session and
// no goto behind it, so the browser has to be crashed.
test("(HOLE 1) a budget that expires over an UNBLANKED page sitting at about:blank crashes the browser", async () => {
  const proc = fakeProcess();
  const exit = fakeGraceExitContext({
    arrivals: [{ name: "arrived-blank", url: "about:blank", delayMs: 50 }],
  });
  const run = blankPagesOnExit(() => exit.context, { proc, budgetMs: 400 });

  const started = Date.now();
  proc.stdin.emit("close");
  await run();

  const page0 = exit.records.get("0");
  const arrived = exit.records.get("arrived-blank");
  assert.ok(arrived, `the fake did add a page while page 0's close was pending (log: ${exit.log.join(", ")})`);
  assert.notEqual(page0.blankedAt, null, `page 0 was blanked, so its close is pending (log: ${exit.log.join(", ")})`);
  assert.ok(
    page0.closeAt === null || exit.timing.crashAt === null || page0.closeAt > exit.timing.crashAt,
    `page 0's close was still inside its grace when the browser was crashed — that is the state the exemption ` +
      `exists for (close issued at +${page0.closeAt === null ? "-" : page0.closeAt - started} ms, crash sent at ` +
      `+${exit.timing.crashAt === null ? "-" : exit.timing.crashAt - started} ms; log: ${exit.log.join(", ")})`,
  );
  assert.equal(
    crashSends(exit.log),
    1,
    `the page that arrived at about:blank was never blanked by this cleanup: nothing attached a deny-all session ` +
      "to it and it was never navigated, so its pagehide/unload beacons are armed exactly like an untouched " +
      "page's and the browser has to be crashed — exactly once (crash sends: " +
      `${crashSends(exit.log)}; log: ${exit.log.join(", ")})`,
  );
  assert.deepEqual(
    arrived.gotos,
    [],
    `the arriving page's blank never started: the budget expired while page 0's close was still inside its ` +
      `grace, so the exemption is being asked about a page this cleanup has not touched at all ` +
      `(got ${JSON.stringify(arrived.gotos)}; log: ${exit.log.join(", ")})`,
  );
});

/** How many times this log says a Browser.crash was sent (the exemption's observable). */
function crashSends(log) {
  return log.filter((entry) => entry === "browser:send:Browser.crash").length;
}

// The same page set in the ownership mode: the arrival is the bot's, so it is a page
// this cleanup owes a blank, and an unblanked page at about:blank is not that blank.
test("(HOLE 1, ownership) the same unblanked about:blank arrival crashes the browser in ownership mode", async () => {
  const proc = fakeProcess();
  const exit = fakeGraceExitContext({
    arrivals: [{ name: "arrived-blank", url: "about:blank", delayMs: 50, owner: "bot" }],
  });
  const run = blankPagesOnExit(() => exit.context, { proc, budgetMs: 400, ownership: exit.ownership });

  proc.stdin.emit("close");
  await run();

  const arrived = exit.records.get("arrived-blank");
  assert.ok(arrived, `the fake did add a bot page while page 0's close was pending (log: ${exit.log.join(", ")})`);
  assert.equal(
    crashSends(exit.log),
    1,
    `a BOT page sitting at about:blank that this cleanup never blanked is not a handled page: the browser has to ` +
      `be crashed, exactly once (crash sends: ${crashSends(exit.log)}; log: ${exit.log.join(", ")})`,
  );
  assert.equal(
    arrived.attached,
    0,
    `the arriving page was never given a deny-all session before the budget, so its document is unguarded ` +
      `(got ${arrived.attached}; log: ${exit.log.join(", ")})`,
  );
  assert.deepEqual(
    arrived.gotos,
    [],
    `and never navigated: it arrived at about:blank on its own (got ${JSON.stringify(arrived.gotos)}; ` +
      `log: ${exit.log.join(", ")})`,
  );
});

// CONTROL for HOLE 1: the exemption still works. Page 0 is blanked and its close is
// pending, the page that arrived is already closed (isClosed() true), and the survivor
// is the cleanup's own — so every page that exists is handled and there is nothing to
// crash about.
test("(HOLE 1 CONTROL) a blanked page with a pending close, a closed page and the survivor do not crash the browser", async () => {
  const proc = fakeProcess();
  const exit = fakeGraceExitContext({
    arrivals: [{ name: "closed-arrival", url: "http://127.0.0.1:9/closed", closed: true, delayMs: 50 }],
  });
  const run = blankPagesOnExit(() => exit.context, { proc, budgetMs: 400 });

  const started = Date.now();
  proc.stdin.emit("close");
  await run();
  const elapsed = Date.now() - started;

  assert.ok(exit.records.get("closed-arrival"), `the fake did add a page during the close grace (log: ${exit.log.join(", ")})`);
  assert.deepEqual(
    exit.log.filter((entry) => entry.startsWith("browser:send")),
    [],
    `every page that exists is handled — page 0 is blanked, the arrival is already closed, the survivor is the ` +
      `cleanup's own — so the exemption holds and the browser is NOT crashed (log: ${exit.log.join(", ")})`,
  );
  assert.equal(exit.records.get("0").closes, 1, `page 0's close is still issued once its grace is over (log: ${exit.log.join(", ")})`);
  assert.notEqual(exit.records.get("0").closedAt, null, `and it answered (log: ${exit.log.join(", ")})`);
  assert.equal(
    exit.records.get("closed-arrival").closes,
    0,
    `a page whose isClosed() is true is left alone: there is nothing to close (got ` +
      `${exit.records.get("closed-arrival").closes}; log: ${exit.log.join(", ")})`,
  );
  assert.deepEqual(
    exit.records.get("closed-arrival").gotos,
    [],
    `and nothing to navigate (got ${JSON.stringify(exit.records.get("closed-arrival").gotos)}; log: ${exit.log.join(", ")})`,
  );
  assert.equal(exit.records.get("survivor").closes, 0, `the survivor is never closed (log: ${exit.log.join(", ")})`);
  assert.ok(elapsed < 400 + 1050 + 1000, `the cleanup resolved instead of hanging (took ${elapsed} ms; log: ${exit.log.join(", ")})`);
});

// HOLE 2: every page is handled (page 0 blanked, its close issued) and that close never
// answers. The exemption's wait is bounded, so the bound is reached with a page still
// open: the browser has to be crashed rather than the process let go.
test("(HOLE 2) the exemption's bounded wait crashes the browser when a page's close never answers", async () => {
  const proc = fakeProcess();
  const exit = fakeGraceExitContext({ closeHangs: true });
  const run = blankPagesOnExit(() => exit.context, { proc, budgetMs: 300 });

  const started = Date.now();
  proc.stdin.emit("close");
  await run();
  const elapsed = Date.now() - started;

  const page0 = exit.records.get("0");
  assert.notEqual(page0.blankedAt, null, `page 0 was blanked (log: ${exit.log.join(", ")})`);
  assert.notEqual(page0.closeAt, null, `its close was issued once its grace was over (log: ${exit.log.join(", ")})`);
  assert.equal(page0.closedAt, null, `the fake's close never answered, which is the case this is about (log: ${exit.log.join(", ")})`);
  assert.equal(
    crashSends(exit.log),
    1,
    `the cleanup's wait for that close ran out with the page still OPEN: the browser has to be crashed — ` +
      `exactly once — instead of the process being let go with an unclosed page behind it ` +
      `(crash sends: ${crashSends(exit.log)}; log: ${exit.log.join(", ")})`,
  );
  assert.ok(
    exit.timing.crashAt !== null && exit.timing.crashAt - started >= 1000,
    `the crash belongs AFTER the bound (UNLOAD_GRACE_MS + CRASH_GRACE_MS), not on the budget itself: the pages ` +
      `were blanked and their closes issued, so crashing at the budget would destroy a browser the cleanup had ` +
      `already made safe (budget 300 ms, crash sent at ` +
      `+${exit.timing.crashAt === null ? "never" : exit.timing.crashAt - started} ms; log: ${exit.log.join(", ")})`,
  );
  assert.ok(
    elapsed < 300 + 1050 + 300 + 1000,
    `the cleanup still resolved (took ${elapsed} ms): a close that never answers must not hold it open ` +
      `(log: ${exit.log.join(", ")})`,
  );
});

// CONTROL for HOLE 2: the same budget, the same pending close, but the close answers
// inside the bound — nothing is left open, so nothing is crashed.
test("(HOLE 2 CONTROL) a close that answers inside the bound sends no crash", async () => {
  const proc = fakeProcess();
  const exit = fakeGraceExitContext();
  const run = blankPagesOnExit(() => exit.context, { proc, budgetMs: 300 });

  proc.stdin.emit("close");
  await run();

  assert.deepEqual(
    exit.log.filter((entry) => entry.startsWith("browser:send")),
    [],
    `the same fake logs a crash once the wait runs out; here every close answered in time, so the browser is ` +
      `left alive (log: ${exit.log.join(", ")})`,
  );
  assert.equal(exit.records.get("0").closes, 1, `page 0's close was issued once (log: ${exit.log.join(", ")})`);
  assert.notEqual(exit.records.get("0").closedAt, null, `and it answered (log: ${exit.log.join(", ")})`);
});

// ===========================================================================
// TG1 — two more ways the exit cleanup can leave a page behind
//
//   GAP 3  a page whose class could not be DECIDED is not a page of nobody's:
//          `ownership.classify(page)` throwing is the one answer that proves
//          nothing, and today it is read as "not the bot's" in the close-phase
//          re-read (the page is skipped and never cleaned) and as a rejection
//          of the whole cleanup in `blankOwnedPages` (nothing is cleaned at
//          all). A throwing classification has to count as BOT.
//   GAP 4  the fresh survivor is made only when EVERY page at the start is the
//          bot's. An operator page that was there then and is gone by the time
//          a bot page's close is issued leaves that close as the context's LAST
//          page, and in headful Chromium closing the last page exits the
//          browser. Before issuing a close that would leave no other live page,
//          the cleanup has to make a fresh about:blank page first (and crash the
//          browser instead when it cannot).
//
// Each gap has a CONTROL next to it: the same fake with the condition flipped,
// showing the difference the fix has to make (an operator page is left alone, a
// bot page is cleaned, an operator page still open means no stray tab).
// ===========================================================================

// A NAMESPACE import, and deliberately not a named one: `closeGuardedPages` does
// not exist yet, and a named import of a missing export is a load-time
// SyntaxError that would take this whole file down — every control in it too.
// Read as a property, a missing export is `undefined`, and the assertion that
// names it is what fails.
import * as privateAddressModule from "../bundles/browser/server/private-address.js";

/**
 * A fake page ownership: `classify(page)` is the caller's rule, and every other
 * seam the cleanup reads answers "nothing of the bot's is in flight".
 */
function fakeOwnership(classify) {
  return {
    classify,
    async settle() {},
    classifying: () => false,
    botPageCount: () => 0,
    unresolvedMarks: () => 0,
    pending: () => false,
  };
}

/** The class a page of `fakeExitContext` is given, by its name. */
function ownerByName(table) {
  return (page) => {
    const name = page && page.rec ? page.rec.name : "";
    const owner = table[name];
    if (owner === "throw") throw new Error(`ownership.classify failed for page ${name}`);
    return owner || "uncertain";
  };
}

// ---------------------------------------------------------------------------
// GAP 3 — a classification that throws is BOT, not nobody
// ---------------------------------------------------------------------------

test("(gap 3) a page whose classify THROWS in the first read is blanked and closed like the bot's", async () => {
  const proc = fakeProcess();
  const exit = fakeExitContext(2);
  const ownership = fakeOwnership(ownerByName({ 0: "bot", 1: "throw", survivor: "operator" }));
  const run = blankPagesOnExit(() => exit.context, { proc, budgetMs: 5000, ownership });

  proc.stdin.emit("close");
  await run();

  const throwing = exit.old[1].rec;
  assert.deepEqual(
    throwing.gotos,
    ["about:blank"],
    `a classification that THROWS proves nothing about the page, so it cannot be read as "not the bot's": ` +
      `the page goes unblanked and unclosed behind routes that die with this process (got ` +
      `${JSON.stringify(throwing.gotos)}; log: ${exit.log.join(", ")})`,
  );
  assert.equal(
    throwing.closes,
    1,
    `and it is closed, behind the deny-all session the blank put in front of it (got ${throwing.closes}; ` +
      `log: ${exit.log.join(", ")})`,
  );
  assert.deepEqual(
    exit.log.filter((entry) => entry.startsWith("browser:send")),
    [],
    `nothing failed: this page can be blanked like any other, so there is nothing to crash the browser about ` +
      `(log: ${exit.log.join(", ")})`,
  );
});

test("(gap 3 CONTROL) an OPERATOR page next to it is still left alone, and the bot's page is still cleaned", async () => {
  const proc = fakeProcess();
  const exit = fakeExitContext(2);
  const ownership = fakeOwnership(ownerByName({ 0: "operator", 1: "bot", survivor: "operator" }));
  const run = blankPagesOnExit(() => exit.context, { proc, budgetMs: 5000, ownership });

  proc.stdin.emit("close");
  await run();

  const operator = exit.old[0].rec;
  assert.deepEqual(
    operator.gotos,
    [],
    `an OPERATOR page is never navigated, whatever its neighbour does (got ${JSON.stringify(operator.gotos)}; ` +
      `log: ${exit.log.join(", ")})`,
  );
  assert.equal(operator.closes, 0, `and never closed (got ${operator.closes}; log: ${exit.log.join(", ")})`);
  assert.deepEqual(
    exit.old[1].rec.gotos,
    ["about:blank"],
    `the bot's page next to it is blanked as before (got ${JSON.stringify(exit.old[1].rec.gotos)}; ` +
      `log: ${exit.log.join(", ")})`,
  );
  assert.equal(exit.old[1].rec.closes, 1, `and closed (log: ${exit.log.join(", ")})`);
});

test("(gap 3) a page that arrives during another page's goto and THROWS when classified is still cleaned", async () => {
  const proc = fakeProcess();
  let late = null;
  const exit = fakeExitContext(1, {
    onGoto: (name, addPage) => {
      if (name === "0" && !late) late = addPage("late");
    },
  });
  const ownership = fakeOwnership(ownerByName({ 0: "bot", late: "throw", survivor: "operator" }));
  const run = blankPagesOnExit(() => exit.context, { proc, budgetMs: 5000, ownership });

  proc.stdin.emit("close");
  await run();

  assert.ok(late, `the fake did add a page while page 0 was being blanked (log: ${exit.log.join(", ")})`);
  assert.deepEqual(
    late.rec.gotos,
    ["about:blank"],
    `a page that appeared while the cleanup was running is the bot's unless something proves otherwise: a ` +
      `classification that throws proves nothing, so the page has to be blanked rather than skipped ` +
      `(got ${JSON.stringify(late.rec.gotos)}; log: ${exit.log.join(", ")})`,
  );
  assert.equal(
    late.rec.closes,
    1,
    `and closed (got ${late.rec.closes}; log: ${exit.log.join(", ")})`,
  );
  assert.equal(exit.old[0].rec.closes, 1, `the page it appeared behind is still cleaned (log: ${exit.log.join(", ")})`);
  assert.deepEqual(
    exit.log.filter((entry) => entry.startsWith("browser:send")),
    [],
    `nothing here failed: a page that only needed a decision is not a reason to crash the browser ` +
      `(log: ${exit.log.join(", ")})`,
  );
});

test("(gap 3 CONTROL) the same late page, classified BOT, is blanked and closed", async () => {
  const proc = fakeProcess();
  let late = null;
  const exit = fakeExitContext(1, {
    onGoto: (name, addPage) => {
      if (name === "0" && !late) late = addPage("late");
    },
  });
  const ownership = fakeOwnership(ownerByName({ 0: "bot", late: "bot", survivor: "operator" }));
  const run = blankPagesOnExit(() => exit.context, { proc, budgetMs: 5000, ownership });

  proc.stdin.emit("close");
  await run();

  assert.ok(late, `the fake did add a page while page 0 was being blanked (log: ${exit.log.join(", ")})`);
  assert.deepEqual(late.rec.gotos, ["about:blank"], `a BOT page is blanked (got ${JSON.stringify(late.rec.gotos)}; log: ${exit.log.join(", ")})`);
  assert.equal(late.rec.closes, 1, `and closed (got ${late.rec.closes}; log: ${exit.log.join(", ")})`);
});

// The close-phase re-read only ever sees a page that appeared AFTER the page loop
// stopped finding pages — that is, while a close was waiting out its grace. Page 0
// is attachable, so its close is scheduled for its commit + the unload grace and
// the cleanup spends that window waiting; the arriving page lands inside it.
test("(gap 3) a page that arrives while a close is pending and THROWS when classified is still cleaned", async () => {
  const proc = fakeProcess();
  let late = null;
  const exit = fakeExitContext(1, {
    attachable: () => true,
    onGoto: (name, addPage) => {
      if (name === "0" && !late) setTimeout(() => { late = addPage("late"); }, 100);
    },
  });
  const ownership = fakeOwnership(ownerByName({ 0: "bot", late: "throw", survivor: "operator" }));
  const run = blankPagesOnExit(() => exit.context, { proc, budgetMs: 5000, ownership });

  proc.stdin.emit("close");
  await run();

  assert.ok(late, `the fake did add a page while page 0's close was inside its grace (log: ${exit.log.join(", ")})`);
  assert.deepEqual(
    late.rec.gotos,
    ["about:blank"],
    `the close-phase re-read offers this page, and a classification that throws cannot be taken for "not the ` +
      `bot's" there either: an unblanked page is exactly what the cleanup exists for (got ` +
      `${JSON.stringify(late.rec.gotos)}; log: ${exit.log.join(", ")})`,
  );
  assert.equal(late.rec.closes, 1, `and closed (got ${late.rec.closes}; log: ${exit.log.join(", ")})`);
  assert.deepEqual(
    exit.log.filter((entry) => entry.startsWith("browser:send")),
    [],
    `nothing failed, so the browser is not killed (log: ${exit.log.join(", ")})`,
  );
});

test("(gap 3 CONTROL) the same close-phase arrival, classified BOT, is blanked and closed", async () => {
  const proc = fakeProcess();
  let late = null;
  const exit = fakeExitContext(1, {
    attachable: () => true,
    onGoto: (name, addPage) => {
      if (name === "0" && !late) setTimeout(() => { late = addPage("late"); }, 100);
    },
  });
  const ownership = fakeOwnership(ownerByName({ 0: "bot", late: "bot", survivor: "operator" }));
  const run = blankPagesOnExit(() => exit.context, { proc, budgetMs: 5000, ownership });

  proc.stdin.emit("close");
  await run();

  assert.ok(late, `the fake did add a page while page 0's close was inside its grace (log: ${exit.log.join(", ")})`);
  assert.deepEqual(
    late.rec.gotos,
    ["about:blank"],
    `the close phase blanks a BOT page that arrived after the loop (got ${JSON.stringify(late.rec.gotos)}; ` +
      `log: ${exit.log.join(", ")})`,
  );
  assert.equal(late.rec.closes, 1, `and closes it (got ${late.rec.closes}; log: ${exit.log.join(", ")})`);
});

// ---------------------------------------------------------------------------
// GAP 4 — never make a bot page the context's last page
// ---------------------------------------------------------------------------

const indexOfLog = (log, entry) => log.indexOf(entry);

test("(gap 4) a fresh page is made BEFORE a bot page's close when the operator's page is gone by then", async () => {
  const proc = fakeProcess();
  // The operator's page is there at the start (so no survivor is made for the
  // first read) and is REMOVED from context.pages() while page 1 is being
  // blanked — what a real context does once that page is closed — so by the time
  // page 1's close is issued the context lists no operator page at all. That a
  // page is gone is visible from pages() alone, without asking that page
  // anything.
  const exit = fakeExitContext(2, {
    onGoto: (name, addPage, dropPage) => { if (name === "1") dropPage("0"); },
  });
  const ownership = fakeOwnership(ownerByName({ 0: "operator", 1: "bot", survivor: "operator" }));
  const run = blankPagesOnExit(() => exit.context, { proc, budgetMs: 5000, ownership });

  proc.stdin.emit("close");
  await run();

  const closeAt = indexOfLog(exit.log, "close:1");
  const newPageAt = indexOfLog(exit.log, "newPage");
  assert.notEqual(closeAt, -1, `page 1 is the bot's and is still closed (log: ${exit.log.join(", ")})`);
  assert.notEqual(
    newPageAt,
    -1,
    `the operator's page is gone when page 1's close is issued, so that close is the context's LAST page — and ` +
      `in headful Chromium closing the last page exits the browser. A fresh about:blank page has to be made ` +
      `first (no newPage in the log: ${exit.log.join(", ")})`,
  );
  assert.ok(
    newPageAt < closeAt,
    `the fresh page has to exist BEFORE the close it keeps the browser alive across (newPage at ${newPageAt}, ` +
      `close:1 at ${closeAt}; log: ${exit.log.join(", ")})`,
  );
  const fresh = exit.survivor();
  assert.ok(fresh, `the fake did make a page (log: ${exit.log.join(", ")})`);
  assert.equal(fresh.rec.closes, 0, `the fresh page is a survivor: the cleanup never closes it (log: ${exit.log.join(", ")})`);
  assert.deepEqual(
    fresh.rec.gotos,
    [],
    `and never navigates it (got ${JSON.stringify(fresh.rec.gotos)}; log: ${exit.log.join(", ")})`,
  );
  assert.deepEqual(
    exit.log.filter((entry) => entry.startsWith("browser:send")),
    [],
    `nothing failed, so the browser is not killed (log: ${exit.log.join(", ")})`,
  );
});

test("(gap 4) when that fresh page cannot be made, the bot page is NOT closed and the browser is crashed", async () => {
  const proc = fakeProcess();
  // Same shape as the test above: the operator's page leaves context.pages()
  // while page 1 is being blanked, so page 1's close would be the context's last.
  const exit = fakeExitContext(2, {
    failNewPage: true,
    onGoto: (name, addPage, dropPage) => { if (name === "1") dropPage("0"); },
  });
  const ownership = fakeOwnership(ownerByName({ 0: "operator", 1: "bot", survivor: "operator" }));
  const run = blankPagesOnExit(() => exit.context, { proc, budgetMs: 5000, ownership });

  proc.stdin.emit("close");
  await run();

  assert.equal(
    exit.old[1].rec.closes,
    0,
    `a close that would leave the context with no page at all exits the browser, and every page in it whose ` +
      `pagehide/unload beacons were never stopped fires them: the page is NOT closed (got ` +
      `${exit.old[1].rec.closes}; log: ${exit.log.join(", ")})`,
  );
  assert.equal(
    crashSends(exit.log),
    1,
    `with no page that can be made in front of the close, the only safe end is the browser's death — exactly ` +
      `one Browser.crash (crash sends: ${crashSends(exit.log)}; log: ${exit.log.join(", ")})`,
  );
});

test("(gap 4) a bot page that arrives late, as the only page left, is closed behind a fresh survivor too", async () => {
  const proc = fakeProcess();
  let late = null;
  // The operator's page leaves context.pages() as page 1 is blanked, and the bot
  // page that arrives then is the only one left besides it.
  const exit = fakeExitContext(2, {
    onGoto: (name, addPage, dropPage) => {
      if (name === "1") {
        dropPage("0");
        if (!late) late = addPage("late");
      }
    },
  });
  const ownership = fakeOwnership(ownerByName({ 0: "operator", 1: "bot", late: "bot", survivor: "operator" }));
  const run = blankPagesOnExit(() => exit.context, { proc, budgetMs: 5000, ownership });

  proc.stdin.emit("close");
  await run();

  assert.ok(late, `the fake did add a bot page while page 1 was being blanked (log: ${exit.log.join(", ")})`);
  const newPageAt = indexOfLog(exit.log, "newPage");
  assert.notEqual(
    newPageAt,
    -1,
    `two bot pages and no operator page left: whichever of them is closed last would be the context's LAST ` +
      `page, so a fresh about:blank page has to exist before the closes (no newPage in the log: ` +
      `${exit.log.join(", ")})`,
  );
  for (const name of ["1", "late"]) {
    const closeAt = indexOfLog(exit.log, `close:${name}`);
    assert.notEqual(closeAt, -1, `page ${name} is the bot's and is still closed (log: ${exit.log.join(", ")})`);
    assert.ok(
      newPageAt < closeAt,
      `the fresh page has to exist before close:${name} (newPage at ${newPageAt}, close:${name} at ${closeAt}; ` +
        `log: ${exit.log.join(", ")})`,
    );
  }
  const fresh = exit.survivor();
  assert.ok(fresh, `the fake did make a fresh page (log: ${exit.log.join(", ")})`);
  assert.equal(fresh.rec.closes, 0, `the fresh page is never closed by the cleanup (log: ${exit.log.join(", ")})`);
});

// CONTROL: the survivor rule is narrowed, not replaced. An operator page that is
// still open keeps the browser alive on its own, and a fresh blank tab made
// "just in case" on every turn would pile up in the window the operator is
// looking at.
test("(gap 4 CONTROL) with an operator page still open at close time, no fresh page is made", async () => {
  const proc = fakeProcess();
  const exit = fakeExitContext(2);
  const ownership = fakeOwnership(ownerByName({ 0: "operator", 1: "bot", survivor: "operator" }));
  const run = blankPagesOnExit(() => exit.context, { proc, budgetMs: 5000, ownership });

  proc.stdin.emit("close");
  await run();

  assert.deepEqual(
    exit.log.filter((entry) => entry === "newPage"),
    [],
    `the operator's page is live when the bot's page is closed, so the browser has a page in front of it: a ` +
      `fresh tab here would be a stray blank tab per turn (log: ${exit.log.join(", ")})`,
  );
  assert.equal(exit.old[1].rec.closes, 1, `the bot's page is still closed (log: ${exit.log.join(", ")})`);
  assert.deepEqual(exit.old[0].rec.gotos, [], `and the operator's page is untouched (log: ${exit.log.join(", ")})`);
  assert.equal(exit.old[0].rec.closes, 0, `and still open (log: ${exit.log.join(", ")})`);
});

// CONTROL: the survivor that IS needed is still made first, before any page is
// navigated or closed.
test("(gap 4 CONTROL) with every page the bot's, the fresh survivor still comes before any goto or close", async () => {
  const proc = fakeProcess();
  const exit = fakeExitContext(2);
  const ownership = fakeOwnership(ownerByName({ 0: "bot", 1: "bot", survivor: "operator" }));
  const run = blankPagesOnExit(() => exit.context, { proc, budgetMs: 5000, ownership });

  proc.stdin.emit("close");
  await run();

  const newPageAt = indexOfLog(exit.log, "newPage");
  assert.notEqual(newPageAt, -1, `every page is the bot's, so a survivor is needed (log: ${exit.log.join(", ")})`);
  assert.equal(exit.log.filter((entry) => entry === "newPage").length, 1, `exactly one (log: ${exit.log.join(", ")})`);
  for (const [name] of [[0], [1]]) {
    const gotoAt = indexOfLog(exit.log, `goto:${name}:start`);
    const closeAt = indexOfLog(exit.log, `close:${name}`);
    assert.ok(newPageAt < gotoAt, `newPage comes before goto:${name}:start (log: ${exit.log.join(", ")})`);
    assert.ok(newPageAt < closeAt, `and before close:${name} (log: ${exit.log.join(", ")})`);
  }
  const fresh = exit.survivor();
  assert.ok(fresh, `the fake did make a survivor (log: ${exit.log.join(", ")})`);
  assert.equal(fresh.rec.closes, 0, `the survivor is never closed (log: ${exit.log.join(", ")})`);
});

// ===========================================================================
// GAP 2 — a restart or a proxy change has to close the browser's pages through
// the same safe path as the exit
//
// `crow_browser_launch` replaces the browser on a proxy change and on a restart.
// Today it calls `browser.close()`, which closes the live pages, and every one
// of those closes fires exactly the pagehide/unload beacons the exit cleanup
// exists to stop. The pages need the exit path's own order — deny-all session,
// about:blank, then the close after the grace — behind an API that can be called
// again later in the same process: `closeGuardedPages(getContext, {ownership})`.
// ===========================================================================

/** The export GAP 2 is about, or a failure that names it. */
function requireCloseGuardedPages() {
  const fn = privateAddressModule.closeGuardedPages;
  assert.equal(
    typeof fn,
    "function",
    "private-address.js has to export closeGuardedPages(getContext, { ownership }): crow_browser_launch replaces " +
      "the browser on a proxy change and on a restart, and the pages it replaces need the same deny-all session, " +
      "about:blank and delayed close the exit path runs — with fresh state per call, off the process's exit " +
      "listeners and off the shared exit tasks, answering { ok } so the caller knows whether the pages were " +
      "cleaned or the browser had to be crashed",
  );
  return fn;
}

/**
 * A fake BrowserContext for `closeGuardedPages`: every page knows its class, a
 * close takes it OUT of `context.pages()` (a real one does), and every step lands
 * in one ordered log.
 */
function fakeGuardedCloseContext(opts = {}) {
  const initial = opts.pages || [{ name: "0", owner: "bot" }];
  const failNewPage = opts.failNewPage === true;
  const failGoto = typeof opts.failGoto === "function" ? opts.failGoto : () => false;
  const log = [];
  const live = [];
  const records = new Map();

  const addPage = (name, owner) => {
    const rec = { name, owner, url: `http://127.0.0.1:9/${name}`, gotos: [], closes: 0, attached: 0, closed: false };
    records.set(name, rec);
    const session = { on() {}, async send() {}, async detach() { log.push(`detach:${name}`); } };
    const page = {
      rec,
      url: () => rec.url,
      isClosed: () => rec.closed,
      frames: () => [],
      context: () => ({
        async newCDPSession() {
          rec.attached += 1;
          log.push(`attach:${name}`);
          return session;
        },
      }),
      async goto(target) {
        rec.gotos.push(target);
        log.push(`goto:${name}:start`);
        await flush();
        if (failGoto(name)) {
          log.push(`goto:${name}:rejected`);
          throw new Error(`the blank of page ${name} failed`);
        }
        rec.url = target;
        log.push(`goto:${name}:end`);
      },
      async close() {
        rec.closes += 1;
        rec.closed = true;
        log.push(`close:${name}`);
        const at = live.indexOf(page);
        if (at >= 0) live.splice(at, 1);
      },
    };
    live.push(page);
    return page;
  };

  for (const spec of initial) addPage(spec.name, spec.owner || "bot");

  const context = {
    pages: () => live.slice(),
    async newPage() {
      log.push("newPage");
      if (failNewPage) throw new Error("no new page can be made in this browser");
      return addPage(`survivor-${live.length}`, "operator");
    },
    browser: () => ({
      async newBrowserCDPSession() {
        log.push("browser:newSession");
        return { async send(method) { log.push(`browser:send:${method}`); } };
      },
    }),
  };

  const ownership = fakeOwnership((page) => (page && page.rec ? page.rec.owner : "uncertain"));
  return { log, live, records, context, ownership, addPage };
}

test("(gap 2) closeGuardedPages cleans a bot page through deny-all, about:blank, then the close, behind a fresh survivor", async () => {
  const closeGuardedPages = requireCloseGuardedPages();
  const fake = fakeGuardedCloseContext({ pages: [{ name: "0", owner: "bot" }] });

  const result = await closeGuardedPages(() => fake.context, { ownership: fake.ownership });

  assert.deepEqual(result, { ok: true }, `nothing failed, so the answer is { ok: true } (got ${JSON.stringify(result)})`);

  const rec = fake.records.get("0");
  const newPageAt = indexOfLog(fake.log, "newPage");
  const attachAt = indexOfLog(fake.log, "attach:0");
  const gotoAt = indexOfLog(fake.log, "goto:0:start");
  const closeAt = indexOfLog(fake.log, "close:0");
  assert.notEqual(newPageAt, -1, `every page is the bot's, so the fresh survivor comes first (log: ${fake.log.join(", ")})`);
  assert.notEqual(attachAt, -1, `the deny-all session is attached to the page (log: ${fake.log.join(", ")})`);
  assert.deepEqual(rec.gotos, ["about:blank"], `the page is blanked (got ${JSON.stringify(rec.gotos)}; log: ${fake.log.join(", ")})`);
  assert.equal(rec.closes, 1, `and closed (got ${rec.closes}; log: ${fake.log.join(", ")})`);
  assert.ok(
    newPageAt < attachAt && attachAt < gotoAt && gotoAt < closeAt,
    `the order is survivor, deny-all session, about:blank, close (newPage ${newPageAt}, attach ${attachAt}, ` +
      `goto ${gotoAt}, close ${closeAt}; log: ${fake.log.join(", ")})`,
  );
  assert.equal(
    fake.live.filter((page) => page.rec.owner !== "operator").length,
    0,
    `no page of the bot's is left in the context (log: ${fake.log.join(", ")})`,
  );
});

test("(gap 2) a second call on the same context cleans the second call's pages: the state is fresh, not memoised", async () => {
  const closeGuardedPages = requireCloseGuardedPages();
  const fake = fakeGuardedCloseContext({ pages: [{ name: "0", owner: "bot" }] });

  const first = await closeGuardedPages(() => fake.context, { ownership: fake.ownership });
  assert.deepEqual(first, { ok: true }, `the first call cleaned its page (got ${JSON.stringify(first)})`);
  assert.equal(fake.records.get("0").closes, 1, `page 0 was closed by the first call (log: ${fake.log.join(", ")})`);

  // A page the bot drove AFTER the restart path ran: the second call has to see it.
  const late = fake.addPage("1", "bot");
  const second = await closeGuardedPages(() => fake.context, { ownership: fake.ownership });

  assert.deepEqual(
    second,
    { ok: true },
    `a second call answers for its OWN run: an already-settled cleanup handed back again would report the ` +
      `first call's outcome (got ${JSON.stringify(second)})`,
  );
  assert.deepEqual(
    late.rec.gotos,
    ["about:blank"],
    `the page that exists at the second call is blanked there: the handled/blanked bookkeeping and the survivor ` +
      `are per call, so a page the bot drove after the first call is still cleaned (got ` +
      `${JSON.stringify(late.rec.gotos)}; log: ${fake.log.join(", ")})`,
  );
  assert.equal(late.rec.closes, 1, `and closed (got ${late.rec.closes}; log: ${fake.log.join(", ")})`);
});

test("(gap 2) a survivor that cannot be made, or a blank that fails, answers { ok: false } and closes nothing", async () => {
  const closeGuardedPages = requireCloseGuardedPages();

  const noSurvivor = fakeGuardedCloseContext({ pages: [{ name: "0", owner: "bot" }], failNewPage: true });
  const survivorless = await closeGuardedPages(() => noSurvivor.context, { ownership: noSurvivor.ownership });
  assert.deepEqual(
    survivorless,
    { ok: false },
    `without a page in front of them every close is the browser's last page, so the caller has to be told the ` +
      `pages were NOT cleaned (got ${JSON.stringify(survivorless)}; log: ${noSurvivor.log.join(", ")})`,
  );
  assert.equal(
    noSurvivor.records.get("0").closes,
    0,
    `and the page is not closed on that path (got ${noSurvivor.records.get("0").closes}; ` +
      `log: ${noSurvivor.log.join(", ")})`,
  );
  assert.equal(
    crashSends(noSurvivor.log),
    1,
    `the crash path is the safe end there (crash sends: ${crashSends(noSurvivor.log)}; ` +
      `log: ${noSurvivor.log.join(", ")})`,
  );

  const failedGoto = fakeGuardedCloseContext({ pages: [{ name: "0", owner: "bot" }], failGoto: () => true });
  const unblanked = await closeGuardedPages(() => failedGoto.context, { ownership: failedGoto.ownership });
  assert.deepEqual(
    unblanked,
    { ok: false },
    `a page whose blank failed is never closed, and the browser is crashed: the answer says the cleanup did ` +
      `not succeed (got ${JSON.stringify(unblanked)}; log: ${failedGoto.log.join(", ")})`,
  );
  assert.equal(
    failedGoto.records.get("0").closes,
    0,
    `the failing page is not closed (got ${failedGoto.records.get("0").closes}; log: ${failedGoto.log.join(", ")})`,
  );
  assert.equal(
    crashSends(failedGoto.log),
    1,
    `exactly one Browser.crash (crash sends: ${crashSends(failedGoto.log)}; log: ${failedGoto.log.join(", ")})`,
  );
});

test("(gap 2) with no context yet there is nothing to clean, and the answer is { ok: true }", async () => {
  const closeGuardedPages = requireCloseGuardedPages();

  const result = await closeGuardedPages(() => null);

  assert.deepEqual(
    result,
    { ok: true },
    `a launcher that has not connected yet has no page to clean, and nothing about that is a failure ` +
      `(got ${JSON.stringify(result)})`,
  );
});

test("(gap 2) an operator page is left alone, exactly as the exit path leaves it", async () => {
  const closeGuardedPages = requireCloseGuardedPages();
  const fake = fakeGuardedCloseContext({
    pages: [{ name: "0", owner: "operator" }, { name: "1", owner: "bot" }],
  });

  const result = await closeGuardedPages(() => fake.context, { ownership: fake.ownership });

  assert.deepEqual(result, { ok: true }, `the bot's page was cleaned (got ${JSON.stringify(result)})`);
  const operator = fake.records.get("0");
  assert.deepEqual(operator.gotos, [], `the operator's page is never navigated (got ${JSON.stringify(operator.gotos)})`);
  assert.equal(operator.closes, 0, `and never closed (got ${operator.closes}; log: ${fake.log.join(", ")})`);
  assert.equal(operator.attached, 0, `and never given a CDP session, which could be written to (got ${operator.attached})`);
  assert.equal(fake.records.get("1").closes, 1, `the bot's page is closed (log: ${fake.log.join(", ")})`);
});

// The launcher itself is not read from here: the launch tool's two branches go
// through `closePagesBeforeRestart` (bundles/browser/server/safe-restart.js), which
// tells "the pages were closed" from "the browser is gone" from "the browser is
// still there with its pages possibly unguarded". That contract — the import, both
// branches, the refusal, and the connection dropped only when `dropConnection` says
// the browser is really gone — is pinned statically in
// tests/browser-safe-restart.test.js, next to the helper it is about.

// ===========================================================================
// TG3 — the round-1 findings on the Opus review
//
//   M3  closeGuardedPages reads `failed()` too early. `run()` can resolve through
//       the budget exemption while the cleanup's WORK promise is still in its
//       close-phase loop, so a killBrowser that lands after that point is not in
//       `ok`. The answer has to wait for the work to settle, bounded by the
//       cleanup's own worst case (EXIT_CLEANUP_WORST_CASE_MS).
//   M4  closeGuardedPages opens a browser-level CDP session
//       (`newBrowserCDPSession`) for the crash and never detaches it. Every call
//       has to detach it at the end — ok or not — swallowing the failure.
//   M5  The "no method is called on an operator page" claim is not pinned (a),
//       the last-page check's serialisation is not pinned (b), and two concurrent
//       closeGuardedPages calls on one context may interleave (c).
//
// (a) and (b) are REGRESSION tests: they are green today and are here so the
// claims they pin cannot be broken silently.
// ===========================================================================

/** A plain timer wait, kept out of the module scope's names. */
const pauseMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// M3 — the verdict is read only once the cleanup's work has settled
// ---------------------------------------------------------------------------

// The run() promise can resolve through the budget's exemption (a small budgetMs,
// every page handled, no close pending) while the cleanup's own work promise is
// still in its close-phase loop. Here that loop is parked inside a settle() that a
// still-running classification holds open; when it finally answers, the page it
// then blanks fails its goto and the cleanup crashes the browser — AFTER
// closeGuardedPages has already answered. Reading `failed()` at that point answers
// ok:true for a browser that was crashed.
//
test("(M3) a crash that lands after run() resolved through the budget exemption is still reported as { ok: false }", async () => {
  const closeGuardedPages = requireCloseGuardedPages();
  const budgetMs = 300;

  let late = null;
  let gateOpen = false;
  let settleCalls = 0;
  let releaseGate = () => {};
  const gate = new Promise((resolve) => { releaseGate = resolve; });

  const exit = fakeExitContext(1, {
    attachable: () => true,
    failGoto: (name) => name === "late",
    onGoto: (name, addPage) => {
      if (name !== "0") return;
      // A bot page arrives while page 0's close is waiting out its grace. Its class
      // is decided only once the gate below opens, which is what a real settle() is
      // waiting for when a classification is still in flight.
      setTimeout(() => { late = addPage("late"); }, 100);
    },
  });

  const ownership = {
    classify: (page) => {
      const name = page && page.rec ? page.rec.name : "";
      if (name === "late") return gateOpen ? "bot" : "uncertain";
      return name === "0" ? "bot" : "operator";
    },
    async settle() {
      settleCalls += 1;
      // The first three settles are the page walk (the first read, then one per loop
      // turn). The close phase's re-read runs well after the 100 ms arrival, and its
      // settle is the one still running when the budget expires.
      if (late && settleCalls >= 4) await gate;
    },
    classifying: () => false,
    botPageCount: () => 1,
    unresolvedMarks: () => 0,
    pending: () => false,
  };

  const call = closeGuardedPages(() => exit.context, { ownership, budgetMs });

  // The budget expires at 300 ms and the exemption is decided again at
  // budgetMs + UNLOAD_GRACE_MS + CRASH_GRACE_MS = 1350 ms. By 1900 ms a run that
  // answered from the exemption has long since read the verdict of a cleanup that
  // is still parked — which is exactly the read this test is about.
  await pauseMs(1900);
  assert.ok(late, `the fake did add a page during the close grace (log: ${exit.log.join(", ")})`);
  gateOpen = true;
  releaseGate();

  const result = await call;

  assert.deepEqual(
    result,
    { ok: false },
    `the cleanup was still running when run() resolved through the exemption, and the page it went on to blank ` +
      `crashed the browser: the answer has to wait for the cleanup's work (bounded by EXIT_CLEANUP_WORST_CASE_MS) ` +
      `before it reads failed(), or it says the pages were cleaned while the browser was crashed ` +
      `(got ${JSON.stringify(result)}; log: ${exit.log.join(", ")})`,
  );
  assert.deepEqual(
    late.rec.gotos,
    ["about:blank"],
    `the late page was blanked by that still-running work, and its blank failed (got ` +
      `${JSON.stringify(late.rec.gotos)}; log: ${exit.log.join(", ")})`,
  );
  assert.equal(
    crashSends(exit.log),
    1,
    `the crash is what happened after run() resolved (crash sends: ${crashSends(exit.log)}; log: ${exit.log.join(", ")})`,
  );
});

test("(M3 CONTROL) a clean run is { ok: true }", async () => {
  const closeGuardedPages = requireCloseGuardedPages();
  const exit = fakeExitContext(1, { attachable: () => true });
  const ownership = fakeOwnership(ownerByName({ 0: "bot", survivor: "operator" }));

  const result = await closeGuardedPages(() => exit.context, { ownership, budgetMs: 5000 });

  assert.deepEqual(
    result,
    { ok: true },
    `a cleanup that blanked and closed its page and was never crashed answers ok:true, so waiting for the work ` +
      `must not turn a clean run into a failure (got ${JSON.stringify(result)}; log: ${exit.log.join(", ")})`,
  );
  assert.equal(exit.old[0].rec.closes, 1, `the page was closed (log: ${exit.log.join(", ")})`);
  assert.deepEqual(
    exit.log.filter((entry) => entry.startsWith("browser:send")),
    [],
    `and nothing was crashed (log: ${exit.log.join(", ")})`,
  );
});

// ---------------------------------------------------------------------------
// M4 — the browser-level CDP session is detached at the end of every call
// ---------------------------------------------------------------------------

test("(M4) the browser-level CDP session closeGuardedPages opens is detached once at the end of the call", async () => {
  const closeGuardedPages = requireCloseGuardedPages();
  const exit = fakeExitContext(1, { attachable: () => true });
  const ownership = fakeOwnership(ownerByName({ 0: "bot", survivor: "operator" }));

  const result = await closeGuardedPages(() => exit.context, { ownership, budgetMs: 5000 });

  assert.deepEqual(result, { ok: true }, `the page was cleaned (got ${JSON.stringify(result)}; log: ${exit.log.join(", ")})`);
  assert.ok(
    exit.log.includes("browser:newSession"),
    `the cleanup opens a browser-level session for the crash it may need (log: ${exit.log.join(", ")})`,
  );
  assert.equal(
    exit.log.filter((entry) => entry === "browser:detach").length,
    1,
    `that session is opened by closeGuardedPages and has to be released when the call is done: one detach per ` +
      `call, no leak of a CDP session per restart (detaches: ` +
      `${exit.log.filter((entry) => entry === "browser:detach").length}; log: ${exit.log.join(", ")})`,
  );
});

test("(M4) the session is detached on the crash path too, and a detach that fails does not change the answer", async () => {
  const closeGuardedPages = requireCloseGuardedPages();
  const exit = fakeExitContext(1, { failGoto: () => true, browserDetachThrows: true });
  const ownership = fakeOwnership(ownerByName({ 0: "bot", survivor: "operator" }));

  const result = await closeGuardedPages(() => exit.context, { ownership, budgetMs: 5000 });

  assert.deepEqual(
    result,
    { ok: false },
    `a page whose blank failed is never closed and the browser is crashed, so the answer is false (got ` +
      `${JSON.stringify(result)}; log: ${exit.log.join(", ")})`,
  );
  assert.equal(
    exit.log.filter((entry) => entry === "browser:detach").length,
    1,
    `the detach belongs at the END of every call, including the one that ended in the crash path: a session left ` +
      `open per failed restart is a leak (detaches: ` +
      `${exit.log.filter((entry) => entry === "browser:detach").length}; log: ${exit.log.join(", ")})`,
  );
  assert.ok(
    exit.log.includes("browser:detach:rejected"),
    `the fake's detach rejected, which is the case the detach has to swallow (log: ${exit.log.join(", ")})`,
  );
  assert.equal(crashSends(exit.log), 1, `the crash still went out (log: ${exit.log.join(", ")})`);
});

test("(M4 CONTROL) the fake's browser session still opens first and records a detach only when one is made", async () => {
  const proc = fakeProcess();
  const exit = fakeExitContext(1);
  const run = blankPagesOnExit(() => exit.context, { proc });

  proc.stdin.emit("close");
  await run();

  assert.equal(exit.log[0], "browser:newSession", `the session is opened first (log: ${exit.log.join(", ")})`);
  assert.deepEqual(
    exit.log.filter((entry) => entry === "browser:detach"),
    [],
    `the exit path never detaches (the browser is going away), so the fake records a detach only when a caller ` +
      `actually makes one (log: ${exit.log.join(", ")})`,
  );
});

// ---------------------------------------------------------------------------
// M5 (a) — an operator page is not even READ
// ---------------------------------------------------------------------------

test("(M5a REGRESSION) an operator page that leaves the page list mid-cleanup is never touched: no property is read", async () => {
  const closeGuardedPages = requireCloseGuardedPages();
  // The (gap 4) late-close scenario: the operator's page is there at the start and
  // is gone from context.pages() by the time the bot page's close is issued.
  const exit = fakeExitContext(2, {
    onGoto: (name, addPage, dropPage) => { if (name === "1") dropPage("0"); },
  });
  const touches = [];
  const original = exit.pages[0];
  exit.pages[0] = new Proxy(original, {
    get(target, prop) {
      // `rec` is the fake's own bookkeeping (its name), which this test's classify and
      // dropPage read. Everything else is a method or a property the cleanup's own
      // code would have to reach for — and none of it may be touched.
      if (prop === "rec") return target.rec;
      if (typeof prop === "string") touches.push(prop);
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const ownership = fakeOwnership(ownerByName({ 0: "operator", 1: "bot", survivor: "operator" }));

  const result = await closeGuardedPages(() => exit.context, { ownership, budgetMs: 5000 });

  assert.deepEqual(result, { ok: true }, `the bot's page was cleaned (got ${JSON.stringify(result)}; log: ${exit.log.join(", ")})`);
  assert.deepEqual(
    touches,
    [],
    `an operator page is left exactly as it is — never navigated, closed, blocked or probed: not one property, ` +
      `not isClosed(), not url(), not even a CDP endpoint is read off it (touched: ${JSON.stringify(touches)}; ` +
      `log: ${exit.log.join(", ")})`,
  );
  assert.deepEqual(original.rec.gotos, [], `and it was never navigated (got ${JSON.stringify(original.rec.gotos)})`);
  assert.equal(original.rec.closes, 0, `and never closed (got ${original.rec.closes}; log: ${exit.log.join(", ")})`);
  assert.equal(
    exit.log.filter((entry) => entry === "newPage").length,
    1,
    `the bot page's close still gets a fresh page in front of it (log: ${exit.log.join(", ")})`,
  );
});

// ---------------------------------------------------------------------------
// M5 (b) — two closes landing together make ONE fresh page
// ---------------------------------------------------------------------------

test("(M5b REGRESSION) two bot pages whose graces end together make exactly ONE fresh page", async () => {
  const closeGuardedPages = requireCloseGuardedPages();
  const exit = fakeExitContext(3, {
    attachable: () => true,
    onGoto: (name, addPage, dropPage) => { if (name === "1") dropPage("0"); },
  });
  const ownership = fakeOwnership(ownerByName({ 0: "operator", 1: "bot", 2: "bot", survivor: "operator" }));

  const result = await closeGuardedPages(() => exit.context, { ownership, budgetMs: 5000 });

  assert.deepEqual(result, { ok: true }, `both bot pages were cleaned (got ${JSON.stringify(result)}; log: ${exit.log.join(", ")})`);
  assert.equal(
    exit.log.filter((entry) => entry === "newPage").length,
    1,
    `both closes land at the same moment with no other live page left: the last-page check is serialised, so ` +
      `ONE fresh page keeps the browser alive across both of them, not one per close ` +
      `(newPage entries: ${exit.log.filter((entry) => entry === "newPage").length}; log: ${exit.log.join(", ")})`,
  );
  for (const page of exit.old.slice(1)) {
    assert.equal(page.rec.closes, 1, `page ${page.rec.name} was closed once (log: ${exit.log.join(", ")})`);
  }
  assert.equal(exit.old[0].rec.closes, 0, `the operator's page was not closed (log: ${exit.log.join(", ")})`);
});

// ---------------------------------------------------------------------------
// M5 (c) — two calls started together run one after the other
// ---------------------------------------------------------------------------

test("(M5c) two closeGuardedPages calls on the same context run one after the other, never interleaved", async () => {
  const closeGuardedPages = requireCloseGuardedPages();
  const exit = fakeExitContext(2, { attachable: () => true });
  const getContext = () => exit.context;
  const marks = [];

  /** An ownership whose settle() says which call it belongs to, in one shared log. */
  const taggedOwnership = (tag) => ({
    classify: (page) => {
      const name = page && page.rec ? page.rec.name : "";
      return name === "0" || name === "1" ? "bot" : "operator";
    },
    async settle() {
      marks.push(`${tag}:settle`);
      await flush();
    },
    classifying: () => false,
    botPageCount: () => 1,
    unresolvedMarks: () => 0,
    pending: () => false,
  });

  // Started together, on ONE context: the second call must wait for the first, or the
  // two cleanups walk the same pages at the same time (one blanks the page the other
  // is attaching a deny-all session to, and each makes its own survivor).
  const first = closeGuardedPages(getContext, { ownership: taggedOwnership("A"), budgetMs: 5000 });
  const second = closeGuardedPages(getContext, { ownership: taggedOwnership("B"), budgetMs: 5000 });
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.deepEqual(firstResult, { ok: true }, `the first call cleaned its pages (got ${JSON.stringify(firstResult)}; log: ${exit.log.join(", ")})`);
  assert.deepEqual(secondResult, { ok: true }, `and so did the second (got ${JSON.stringify(secondResult)}; log: ${exit.log.join(", ")})`);

  const firstB = marks.indexOf("B:settle");
  const lastA = marks.lastIndexOf("A:settle");
  assert.notEqual(firstB, -1, `the second call ran at all (marks: ${JSON.stringify(marks)})`);
  assert.notEqual(lastA, -1, `the first call ran too (marks: ${JSON.stringify(marks)})`);
  assert.ok(
    lastA < firstB,
    `two calls on the same context must not interleave: the second call's first step comes after the first ` +
      `call's last. Running them together walks the same pages twice at once, which blanks a page one cleanup ` +
      `has already attached to and skips the other's bookkeeping. The marks are ${lastA < firstB ? "ordered" : "interleaved"} ` +
      `(marks: ${JSON.stringify(marks)}; log: ${exit.log.join(", ")})`,
  );
});

// ===========================================================================
// TG4 — the round-2 findings on the Opus review
//
//   F1  `releaseBrowserSession()` awaits the browser-level session's `detach()`
//       with NOTHING bounding it. A detach that never answers therefore never
//       resolves `closeGuardedPages` — and since every call is serialised on ONE
//       module-level chain, every later call in the process waits behind it
//       forever. A caller that keeps running (a restart, a proxy change) is wedged
//       on a session that is already useless to it.
//   F2  `runCloseGuardedPages` reads the verdict after `settled()`, and
//       `settled()` is BOUNDED by `EXIT_CLEANUP_WORST_CASE_MS` and reports
//       nothing about which of the two happened: the work settling, or the bound
//       passing with the work still running. A cleanup whose work outlives that
//       bound is answered `{ ok: true }` — "the pages were cleaned" — for work
//       that has not finished.
//
// Each finding has its CONTROL next to it, on the same fake with the condition
// flipped, so a green zero is never vacuous.
// ===========================================================================

/** How long a wedged call may keep its caller waiting before this file calls it wedged. */
const WEDGE_BOUND_MS = 2000;

/**
 * `fakeGuardedCloseContext`, with the browser-level CDP session it opens given a
 * `detach()` that either NEVER answers (`stuck`, the default) or answers at once.
 * Everything else about the fake is unchanged, and each `detach()` attempt is
 * recorded in its log so "the call reached its own detach" is observable.
 */
function fakeGuardedCloseContextWithDetach(opts = {}, { stuck = true } = {}) {
  const fake = fakeGuardedCloseContext(opts);
  const opened = fake.context.browser;
  fake.context.browser = () => ({
    async newBrowserCDPSession() {
      const session = await opened().newBrowserCDPSession();
      return {
        async send(method) { return session.send(method); },
        detach() {
          fake.log.push(stuck ? "browser:detach:never" : "browser:detach:answered");
          return stuck ? new Promise(() => {}) : Promise.resolve();
        },
      };
    },
  });
  return fake;
}

/**
 * Take the fake page's deny-all endpoint away, the way a page Playwright never
 * hands a CDP session over for: its close is then issued at once instead of after
 * the unload grace, so a test about something else does not wait 750 ms per page.
 */
function dropCdpEndpoint(fake, name) {
  const page = fake.live.find((candidate) => candidate.rec.name === name);
  assert.ok(page, `the fake has a live page named ${name} (log: ${fake.log.join(", ")})`);
  delete page.context;
  return page;
}

// ---------------------------------------------------------------------------
// F1 — a detach that never answers must not wedge the call, or the chain
//
// ORDER: this section's CONTROLS are declared before the two findings' tests, and
// the F1 test is declared LAST. Its whole point is that a hung detach leaves the
// module-level call chain wedged for good, so any call declared after it would be
// one that never starts — a control written that way would fail for the finding's
// own reason instead of the condition it is there to flip.
// ---------------------------------------------------------------------------

test("(F1 CONTROL) the same fake with a detach that answers resolves at once", async () => {
  const closeGuardedPages = requireCloseGuardedPages();
  const fake = fakeGuardedCloseContextWithDetach({ pages: [{ name: "0", owner: "bot" }] }, { stuck: false });
  dropCdpEndpoint(fake, "0");

  const outcome = await Promise.race([
    closeGuardedPages(() => fake.context, { ownership: fake.ownership, budgetMs: 5000 }).then((result) => ({ result })),
    pauseMs(500).then(() => ({ timedOut: true })),
  ]);

  assert.equal(
    outcome.timedOut,
    undefined,
    `the same fake resolves quickly once its detach answers: nothing here is waiting on anything else ` +
      `(still pending after 500 ms; log: ${fake.log.join(", ")})`,
  );
  assert.deepEqual(
    outcome.result,
    { ok: true },
    `a clean run answers ok:true (got ${JSON.stringify(outcome.result)}; log: ${fake.log.join(", ")})`,
  );
  assert.ok(
    fake.log.includes("browser:detach:answered"),
    `the detach was attempted and answered, which is the condition this control flips (log: ${fake.log.join(", ")})`,
  );
  assert.equal(fake.records.get("0").closes, 1, `the page was closed (log: ${fake.log.join(", ")})`);
});

// ---------------------------------------------------------------------------
// F2 — the bound on the cleanup's own work has to reach the verdict
// ---------------------------------------------------------------------------

// The cleanup's WORK is the page walk. Here it is parked for good inside the
// ownership's `settle()`: no page list is ever read, no page is touched, nothing of
// the bot's is armed — so the budget path crashes nothing (there is nothing to fail
// closed about) and `run()` resolves while the work promise never settles at all.
// The verdict is read after `settled()`, whose bound is the cleanup's own worst case:
// a wait that runs out with the work STILL RUNNING is not a cleanup that finished.
test("(F2) a cleanup whose work does not settle inside its bound answers { ok: false }", async () => {
  const closeGuardedPages = requireCloseGuardedPages();
  const exit = fakeExitContext(1);
  const bound = privateAddressModule.EXIT_CLEANUP_WORST_CASE_MS;
  assert.equal(
    typeof bound,
    "number",
    "private-address.js has to export EXIT_CLEANUP_WORST_CASE_MS: it is the bound the cleanup's own work is " +
      "waited for, and the number every SIGTERM->SIGKILL gap in the product is compared against",
  );

  const ownership = {
    classify: () => "operator",
    // Never answers: the cleanup's work is still running when its bound passes.
    settle: () => new Promise(() => {}),
    classifying: () => false,
    botPageCount: () => 0,
    unresolvedMarks: () => 0,
    pending: () => false,
  };

  const started = Date.now();
  const outcome = await Promise.race([
    closeGuardedPages(() => exit.context, { ownership, budgetMs: 50 }).then((result) => ({ result })),
    // Generous, so a run that never answers is a failing assertion here rather than a
    // test file that hangs.
    pauseMs(bound + 5000).then(() => ({ timedOut: true })),
  ]);
  const elapsed = Date.now() - started;

  assert.equal(
    outcome.timedOut,
    undefined,
    `the answer has to come once the cleanup's bound has passed, not never (still pending after ${bound + 5000} ms; ` +
      `log: ${exit.log.join(", ")})`,
  );
  assert.deepEqual(
    outcome.result,
    { ok: false },
    `the cleanup's work was still RUNNING when the bound passed, so this run cannot say the pages were cleaned: ` +
      `reporting ok:true there tells the launcher a restart's safe close finished when it did not ` +
      `(got ${JSON.stringify(outcome.result)} after ${elapsed} ms, with the bound at ${bound} ms; ` +
      `log: ${exit.log.join(", ")})`,
  );
  assert.ok(
    elapsed >= 50,
    `the answer did not come before the cleanup's own budget had even been spent (came after ${elapsed} ms)`,
  );
  assert.equal(
    crashSends(exit.log),
    0,
    `nothing of the bot's was armed, so nothing was crashed: the answer is false because the work never settled, ` +
      `not because a crash went out (crash sends: ${crashSends(exit.log)}; log: ${exit.log.join(", ")})`,
  );
  assert.deepEqual(
    exit.old[0].rec.gotos,
    [],
    `the parked settle never answered, so no page was read, navigated or closed ` +
      `(got ${JSON.stringify(exit.old[0].rec.gotos)}; log: ${exit.log.join(", ")})`,
  );
});

test("(F2 CONTROL) a cleanup whose work settles inside its bound is { ok: true }", async () => {
  const closeGuardedPages = requireCloseGuardedPages();
  const exit = fakeExitContext(1, { attachable: () => true });
  const ownership = fakeOwnership(ownerByName({ 0: "bot", survivor: "operator" }));

  const outcome = await Promise.race([
    closeGuardedPages(() => exit.context, { ownership, budgetMs: 5000 }).then((result) => ({ result })),
    pauseMs(WEDGE_BOUND_MS + 3000).then(() => ({ timedOut: true })),
  ]);

  assert.equal(
    outcome.timedOut,
    undefined,
    `this run's page is blanked and closed inside its grace, so there is nothing to wait for ` +
      `(still pending after ${WEDGE_BOUND_MS + 3000} ms; log: ${exit.log.join(", ")})`,
  );
  assert.deepEqual(
    outcome.result,
    { ok: true },
    `the same read is ok:true when the work DID settle: failing a cleanup that finished would make every ` +
      `restart report a failed close (got ${JSON.stringify(outcome.result)}; log: ${exit.log.join(", ")})`,
  );
  assert.equal(exit.old[0].rec.closes, 1, `the page was blanked and closed (log: ${exit.log.join(", ")})`);
  assert.equal(crashSends(exit.log), 0, `and nothing was crashed (log: ${exit.log.join(", ")})`);
});

// ---------------------------------------------------------------------------
// F1 — a detach that never answers must not wedge the call, or the chain
// (declared last: see the note in the F1 section above)
// ---------------------------------------------------------------------------

test("(F1) a browser-level detach() that NEVER answers does not wedge closeGuardedPages, nor the call behind it", async () => {
  const closeGuardedPages = requireCloseGuardedPages();
  // One bot page, and its close is issued immediately (no grace), so the only thing
  // this run can be waiting on when it is done is the session's detach.
  const fake = fakeGuardedCloseContextWithDetach({ pages: [{ name: "0", owner: "bot" }] }, { stuck: true });
  dropCdpEndpoint(fake, "0");

  const first = await Promise.race([
    closeGuardedPages(() => fake.context, { ownership: fake.ownership, budgetMs: 5000 }).then((result) => ({ result })),
    pauseMs(WEDGE_BOUND_MS).then(() => ({ timedOut: true })),
  ]);

  assert.equal(
    first.timedOut,
    undefined,
    `the browser-level session this call opened is released on a best-effort basis, and its detach() never ` +
      `answered: awaiting that promise with nothing bounding it keeps the call — and every caller behind it — ` +
      `waiting forever on a session that is already useless to it (still pending after ${WEDGE_BOUND_MS} ms; ` +
      `log: ${fake.log.join(", ")})`,
  );
  assert.deepEqual(
    first.result,
    { ok: true },
    `the pages were cleaned and nothing was crashed, so the verdict is unchanged by a detach that hangs ` +
      `(got ${JSON.stringify(first.result)}; log: ${fake.log.join(", ")})`,
  );

  // The module-level chain only matters because it is what a wedged call poisons: a
  // page the bot drove after this restart path ran has to be cleaned by the NEXT call.
  const late = fake.addPage("1", "bot");
  delete late.context;
  const second = await Promise.race([
    closeGuardedPages(() => fake.context, { ownership: fake.ownership, budgetMs: 5000 }).then((result) => ({ result })),
    pauseMs(WEDGE_BOUND_MS).then(() => ({ timedOut: true })),
  ]);

  assert.equal(
    second.timedOut,
    undefined,
    `calls are serialised on one module-level chain, so a first call that never resolves is a second call that ` +
      `never STARTS: every later restart, proxy change and launch in this process would wait behind one hung ` +
      `detach (still pending after ${WEDGE_BOUND_MS} ms; log: ${fake.log.join(", ")})`,
  );
  assert.deepEqual(
    second.result,
    { ok: true },
    `the second call's own run was clean, so it answers for its own pages (got ${JSON.stringify(second.result)}; ` +
      `log: ${fake.log.join(", ")})`,
  );
  assert.deepEqual(
    late.rec.gotos,
    ["about:blank"],
    `the page that exists at the second call is blanked there, so the call really ran rather than being skipped ` +
      `(got ${JSON.stringify(late.rec.gotos)}; log: ${fake.log.join(", ")})`,
  );
  assert.equal(late.rec.closes, 1, `and closed (got ${late.rec.closes}; log: ${fake.log.join(", ")})`);
  assert.equal(
    fake.log.filter((entry) => entry === "browser:detach:never").length,
    2,
    `each call has to reach its OWN detach and be let go by it: one hung detach must not be the end of the chain ` +
      `(detach attempts that never answered: ` +
      `${fake.log.filter((entry) => entry === "browser:detach:never").length}; log: ${fake.log.join(", ")})`,
  );
});