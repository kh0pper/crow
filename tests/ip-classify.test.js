/**
 * Address classification for outbound-fetch guards and the local-voice rule
 * (servers/shared/ip-classify.js and the bundles that use it).
 *
 * The table is written as URLs, because that is what reaches the guards: the
 * WHATWG parser rewrites `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]`, `127.1`,
 * `0x7f.1` and `2130706433` to `127.0.0.1`, and an IP-literal host is used
 * as-is, without a DNS lookup. Every form below must be refused by the
 * SSRF guards; the public ones must still pass, and only directly-local
 * addresses may count as "local" for the media voice rule.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isPrivateAddress, fetchImagePinned } from "../bundles/meta-glasses/server/net-guard.js";
import { isLocalAddress, hostIsLocal } from "../bundles/media/server/speech.js";
import { assertPublicHost } from "../bundles/reader/server/import.js";
import { validateHostOrReject } from "../bundles/funkwhale/panel/routes.js";

/** Not public: an SSRF guard must refuse each. [url, why] */
export const NOT_PUBLIC = [
  ["http://[::ffff:127.0.0.1]/", "v4-mapped loopback (URL rewrites it to hex)"],
  ["http://[::ffff:7f00:1]/", "v4-mapped loopback, hex"],
  ["http://[::FFFF:7F00:0001]/", "v4-mapped loopback, upper case, zero-padded"],
  ["http://[0:0:0:0:0:ffff:7f00:1]/", "v4-mapped loopback, uncompressed"],
  ["http://[::ffff:a9fe:a9fe]/", "v4-mapped metadata address 169.254.169.254"],
  ["http://[::ffff:169.254.169.254]/", "v4-mapped metadata, dotted"],
  ["http://[::ffff:a00:1]/", "v4-mapped 10.0.0.1"],
  ["http://[::ffff:0:7f00:1]/", "SIIT-translated ::ffff:0:0:0/96 loopback"],
  ["http://[::7f00:1]/", "v4-compatible loopback"],
  ["http://[::127.0.0.1]/", "v4-compatible loopback, dotted"],
  ["http://[::a9fe:a9fe]/", "v4-compatible metadata"],
  ["http://[64:ff9b::7f00:1]/", "NAT64 of loopback"],
  ["http://[64:ff9b::a9fe:a9fe]/", "NAT64 of metadata"],
  ["http://[64:ff9b:1::1]/", "local-use NAT64 64:ff9b:1::/48"],
  ["http://[2002:7f00:1::]/", "6to4 of loopback"],
  ["http://[2002:a9fe:a9fe::1]/", "6to4 of metadata"],
  ["http://[2002:c0a8:101::1]/", "6to4 of 192.168.1.1"],
  ["http://[2001:0:4136:e378:8000:63bf:80ff:fffe]/", "Teredo, client v4 127.0.0.1 (obfuscated)"],
  ["http://[2001:0:7f00:1::1]/", "Teredo, server v4 127.0.0.1"],
  ["http://[::]/", "unspecified"],
  ["http://[0000:0000::0000]/", "unspecified, zero-padded"],
  ["http://[::1]/", "loopback"],
  ["http://[0:0:0:0:0:0:0:1]/", "loopback, uncompressed"],
  ["http://[FE80::1]/", "link-local, upper case"],
  ["http://[fe90::1]/", "link-local fe80::/10 beyond fe80"],
  ["http://[febf::1]/", "link-local top of fe80::/10"],
  ["http://[fec0::1]/", "deprecated site-local"],
  ["http://[fc00::1]/", "unique local"],
  ["http://[FD7A:115C:A1E0::1]/", "unique local, upper case"],
  ["http://[ff02::1]/", "multicast"],
  ["http://[ff0e::1]/", "global multicast"],
  ["http://[2001:db8::1]/", "documentation"],
  ["http://[3fff::1]/", "documentation 3fff::/20"],
  ["http://[2001:2::1]/", "benchmarking"],
  ["http://[100::1]/", "discard-only"],
  ["http://[fc::1]/", "00fc::/16 lies outside global unicast 2000::/3"],
  ["http://2130706433/", "decimal 127.0.0.1"],
  ["http://0x7f.1/", "hex 127.0.0.1"],
  ["http://0177.0.0.1/", "octal 127.0.0.1"],
  ["http://127.1/", "short 127.0.0.1"],
  ["http://0/", "0.0.0.0"],
  ["http://0.1.2.3/", "0.0.0.0/8"],
  ["http://10.1.2.3/", "RFC 1918"],
  ["http://172.16.0.1/", "RFC 1918"],
  ["http://192.168.1.1/", "RFC 1918"],
  ["http://169.254.169.254/", "link-local metadata"],
  ["http://100.64.0.1/", "CGNAT"],
  ["http://192.0.0.8/", "IETF protocol assignments 192.0.0.0/24"],
  ["http://192.0.2.1/", "documentation"],
  ["http://198.51.100.1/", "documentation"],
  ["http://203.0.113.1/", "documentation"],
  ["http://198.18.0.1/", "benchmarking 198.18.0.0/15"],
  ["http://198.19.255.255/", "benchmarking 198.18.0.0/15"],
  ["http://224.0.0.1/", "multicast"],
  ["http://239.255.255.250/", "multicast"],
  ["http://240.0.0.1/", "reserved 240.0.0.0/4"],
  ["http://255.255.255.255/", "broadcast"],
];

/** Public: guards must let each through. */
export const PUBLIC = [
  "http://8.8.8.8/", "http://1.1.1.1/", "http://172.32.0.1/", "http://100.128.0.1/", "http://198.20.0.1/",
  "http://223.255.255.255/", "http://[2606:4700::1111]/", "http://[2606:4700:0:0:0:0:0:1111]/",
  "http://[::ffff:8.8.8.8]/", "http://[::ffff:808:808]/", "http://[64:ff9b::808:808]/",
  "http://[2002:808:808::1]/", "http://[2001:0:808:808:8000:63bf:f7f7:f7f7]/",
];

const hostOf = (url) => new URL(url).hostname.replace(/^\[|\]$/g, "");

test("meta-glasses isPrivateAddress: every not-public form (as the URL parser hands it over) is private; public stays public", () => {
  const miss = NOT_PUBLIC.filter(([u]) => isPrivateAddress(hostOf(u)) !== true).map(([u, why]) => `${u} (${why})`);
  assert.deepEqual(miss, [], "slipped through");
  const blocked = PUBLIC.filter((u) => isPrivateAddress(hostOf(u)) !== false);
  assert.deepEqual(blocked, [], "public refused");
});

test("meta-glasses fetchImagePinned refuses each not-public URL before connecting", async () => {
  const lookup = async () => { throw new Error("an IP literal must never be looked up"); };
  const miss = [];
  for (const [u, why] of NOT_PUBLIC) {
    try { await fetchImagePinned(u, { lookup, timeoutMs: 500 }); miss.push(`${u} (${why}): fetched`); }
    catch (e) { if (e.code !== "host_not_allowed") miss.push(`${u} (${why}): ${e.code}`); }
  }
  assert.deepEqual(miss, []);
});

test("meta-glasses fetchImagePinned refuses a name whose lookup answers a not-public address in any textual form", async () => {
  for (const [u] of NOT_PUBLIC) {
    const address = hostOf(u);
    const lookup = async () => [{ address, family: address.includes(":") ? 6 : 4 }];
    await assert.rejects(fetchImagePinned("http://art.example.invalid/a.png", { lookup }), (e) => e.code === "host_not_allowed", address);
  }
});

test("reader assertPublicHost refuses every not-public URL and passes public ones", async () => {
  const miss = [];
  for (const [u, why] of NOT_PUBLIC) {
    try { await assertPublicHost(u, {}); miss.push(`${u} (${why})`); } catch (e) { if (!/private address/.test(e.message)) miss.push(`${u}: ${e.message}`); }
  }
  assert.deepEqual(miss, []);
  for (const u of PUBLIC) await assertPublicHost(u, {});
});

test("funkwhale artwork host check refuses every not-public form, IPv6 literals included, and passes public ones", async () => {
  // The route's allow-list matches URL.hostname exactly: "localhost", "127.0.0.1" and the
  // configured Funkwhale host. Forms the URL parser rewrites to "127.0.0.1" are allow-listed by
  // that rule, so they are out of this table; every other form (bracketed IPv6 included) is not.
  const lookup = async () => { throw new Error("an IP literal must never be looked up"); };
  const forms = NOT_PUBLIC.filter(([u]) => new URL(u).hostname !== "127.0.0.1");
  const miss = [];
  for (const [u, why] of forms) {
    const r = await validateHostOrReject(new URL(u).hostname, { lookup });
    if (r.ok || r.reason !== "private_host") miss.push(`${u} (${why}): ${JSON.stringify(r)}`);
  }
  assert.deepEqual(miss, []);
  for (const u of PUBLIC) assert.equal((await validateHostOrReject(new URL(u).hostname, { lookup })).ok, true, u);
});

test("media isLocalAddress: only directly-local addresses count as local, in any textual form", () => {
  const local = ["::ffff:7f00:1", "::FFFF:7F00:0001", "::ffff:a00:4", "0:0:0:0:0:ffff:c0a8:101", "::ffff:6440:1405",
    "FD7A:115C:A1E0::1", "FE80::1", "febf::1", "0:0:0:0:0:0:0:1", "127.0.0.1", "10.1.2.3", "100.64.20.5"];
  const notLocal = ["fc::1", "fd::1", "fe9::1", "feb::1", "::ffff:808:808", "2001:db8::1", "64:ff9b::a00:1", "2002:a00:1::1",
    "::a00:1", "ff02::1", "224.0.0.1", "0.0.0.0", "::", "8.8.8.8", "not-an-ip", ""];
  assert.deepEqual(local.filter((a) => isLocalAddress(a) !== true), [], "local refused");
  assert.deepEqual(notLocal.filter((a) => isLocalAddress(a) !== false), [], "treated as local");
});

test("media hostIsLocal: a bracketed literal URL is classified after the URL parser rewrites it", async () => {
  assert.equal(await hostIsLocal("http://[::ffff:127.0.0.1]:8011/v1"), true);
  assert.equal(await hostIsLocal("http://[fc::1]:8011/v1"), false);
  assert.equal(await hostIsLocal("http://[::ffff:8.8.8.8]/"), false);
});

test("shared helper: parseIPv6 expands every spelling to the same eight groups, and rejects malformed input", async () => {
  const { parseIPv6 } = await import("../servers/shared/ip-classify.js");
  const loop4 = [0, 0, 0, 0, 0, 0xffff, 0x7f00, 1];
  for (const s of ["::ffff:127.0.0.1", "::ffff:7f00:1", "::FFFF:7F00:0001", "0:0:0:0:0:ffff:7f00:1", "[::ffff:7f00:1]", "0000:0000:0000:0000:0000:ffff:127.0.0.1"]) assert.deepEqual(parseIPv6(s), loop4, s);
  assert.deepEqual(parseIPv6("fe80::1%eth0"), [0xfe80, 0, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(parseIPv6("1:2:3:4:5:6:7::"), [1, 2, 3, 4, 5, 6, 7, 0]);
  assert.deepEqual(parseIPv6("::"), [0, 0, 0, 0, 0, 0, 0, 0]);
  for (const s of ["", "1::2::3", ":::", "12345::", "::g", "1.2.3.4", "::ffff:1.2.3", "::ffff:01.2.3.4", "1:2:3:4:5:6:7:8:9", null, undefined, 42]) assert.equal(parseIPv6(s), null, String(s));
});

test("shared helper: classifyIp names the class and the embedding; nothing unparseable is public or local", async () => {
  const { classifyIp, isPublicIp, isLocalNetworkIp } = await import("../servers/shared/ip-classify.js");
  const cases = [
    ["::ffff:a9fe:a9fe", "linklocal", "169.254.169.254", "mapped"],
    ["::7f00:1", "loopback", "127.0.0.1", "compatible"],
    ["::ffff:0:a00:1", "private", "10.0.0.1", "siit"],
    ["64:ff9b::6440:1", "cgnat", "100.64.0.1", "nat64"],
    ["2002:c0a8:101::1", "private", "192.168.1.1", "6to4"],
    ["2001:0:4136:e378:8000:63bf:80ff:fffe", "loopback", "127.0.0.1", "teredo"],
    ["64:ff9b::808:808", "public", "8.8.8.8", "nat64"],
    ["fd7a:115c:a1e0::1", "ula", null, null],
    ["ff02::1", "multicast", null, null],
    ["2606:4700::1111", "public", null, null],
    ["0.0.0.0", "unspecified", null, null],
    ["255.255.255.255", "reserved", null, null],
  ];
  for (const [a, cls, v4, via] of cases) assert.deepEqual(classifyIp(a), { cls, v4, via }, a);
  for (const bad of ["", "localhost", "example.com", "127.1", "0x7f000001", "2130706433", "1.2.3.4.5", "::ffff:999.0.0.1", "[::1", null, undefined, {}, 7]) {
    assert.equal(classifyIp(bad).cls, "invalid", String(bad));
    assert.equal(isPublicIp(bad), false, String(bad));
    assert.equal(isLocalNetworkIp(bad), false, String(bad));
  }
});
