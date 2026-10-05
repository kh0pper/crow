/**
 * Outbound guards must refuse this host itself and its on-link neighbours, even where those
 * addresses are public: a service listening on [::] answers on the host's own global IPv6, and the
 * router and other machines on the same /64 (or a public IPv4 LAN) are one hop away.
 *
 * The interface table is injected, so these results do not depend on the machine running the suite.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { isPublicIp, isPublicEgressIp, isOwnNetworkIp, interfaceNets, setInterfaceTableForTests } from "../servers/shared/ip-classify.js";
import { isPrivateAddress, fetchImagePinned } from "../bundles/meta-glasses/server/net-guard.js";
import { assertPublicHost } from "../bundles/reader/server/import.js";
import { validateHostOrReject } from "../bundles/funkwhale/panel/routes.js";

/** A host with a global IPv6 /64, a public IPv4 LAN, a private LAN, loopback and a tailnet address. */
const TABLE = {
  lo: [
    { address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", internal: true, cidr: "127.0.0.1/8" },
    { address: "::1", netmask: "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", family: "IPv6", internal: true, cidr: "::1/128" },
  ],
  eth0: [
    { address: "2a01:4f8:1:2::10", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", internal: false, cidr: "2a01:4f8:1:2::10/64" },
    { address: "fe80::1c2:3ff:fe4:5", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", internal: false, cidr: "fe80::1c2:3ff:fe4:5/64" },
    { address: "198.20.5.10", netmask: "255.255.255.0", family: "IPv4", internal: false, cidr: "198.20.5.10/24" },
  ],
  eth1: [{ address: "10.0.0.5", netmask: "255.255.255.0", family: "IPv4", internal: false }], // no cidr: the mask decides
  tun0: [{ address: "100.64.20.7", netmask: "255.255.255.255", family: "IPv4", internal: false, cidr: "100.64.20.7/32" }],
};

afterEach(() => setInterfaceTableForTests(null));

/** [address, why]: public by class, but this host or a neighbour. */
const OWN = [
  ["2a01:4f8:1:2::10", "own global IPv6"],
  ["2A01:04F8:0001:0002:0000:0000:0000:0010", "own global IPv6, uncompressed upper case"],
  ["2a01:4f8:1:2::1", "router on the same /64"],
  ["2a01:4f8:1:2:ffff:ffff:ffff:ffff", "top of the same /64"],
  ["198.20.5.10", "own public IPv4"],
  ["198.20.5.1", "neighbour on the public IPv4 /24"],
  ["::ffff:198.20.5.1", "neighbour, v4-mapped dotted"],
  ["::ffff:c614:501", "neighbour, v4-mapped hex"],
  ["64:ff9b::c614:501", "neighbour through NAT64"],
];
const NOT_OWN_PUBLIC = ["2a01:4f8:1:3::1", "2a01:4f8:1:1::10", "198.20.6.1", "198.20.4.255", "8.8.8.8", "2606:4700::1111", "64:ff9b::808:808"];

test("isPublicEgressIp: own addresses and on-link neighbours are refused; other public addresses pass", () => {
  for (const [a] of OWN) assert.equal(isPublicIp(a), true, `${a} is public by class (the gap this closes)`);
  const slipped = OWN.filter(([a]) => isPublicEgressIp(a, { interfaces: TABLE })).map(([a, why]) => `${a} (${why})`);
  assert.deepEqual(slipped, []);
  assert.deepEqual(NOT_OWN_PUBLIC.filter((a) => !isPublicEgressIp(a, { interfaces: TABLE })), []);
});

test("isOwnNetworkIp covers private interfaces too, using the netmask when there is no cidr", () => {
  assert.equal(isOwnNetworkIp("10.0.0.99", { interfaces: TABLE }), true, "same /24 as eth1, from its netmask");
  assert.equal(isOwnNetworkIp("10.0.1.1", { interfaces: TABLE }), false);
  assert.equal(isOwnNetworkIp("100.64.20.7", { interfaces: TABLE }), true, "a /32 is its own address");
  assert.equal(isOwnNetworkIp("100.64.20.8", { interfaces: TABLE }), false);
  assert.equal(isOwnNetworkIp("not-an-ip", { interfaces: TABLE }), false);
  assert.equal(isPublicEgressIp("not-an-ip", { interfaces: TABLE }), false);
});

test("a mis-reported very short mask never turns the internet into a neighbour; the address itself still counts", () => {
  const odd = { wg0: [{ address: "203.1.2.3", netmask: "0.0.0.0", family: "IPv4", cidr: "203.1.2.3/0" }, { address: "2a02:1::5", family: "IPv6", cidr: "2a02:1::5/8" }] };
  assert.equal(isPublicEgressIp("8.8.8.8", { interfaces: odd }), true);
  assert.equal(isPublicEgressIp("2a00::1", { interfaces: odd }), true);
  assert.equal(isPublicEgressIp("203.1.2.3", { interfaces: odd }), false);
  assert.equal(isPublicEgressIp("2a02:1::5", { interfaces: odd }), false);
});

test("interfaceNets parses cidr, netmask and skips junk", () => {
  const nets = interfaceNets({ a: [{ address: "198.20.5.10", cidr: "198.20.5.10/24" }, { address: "10.0.0.5", netmask: "255.255.0.0" }, { address: "junk" }, null] });
  assert.deepEqual(nets.map((n) => [n.family, n.prefix]), [[4, 24], [4, 16]]);
});

test("the live table is used by default and the test hook replaces it", () => {
  setInterfaceTableForTests(() => TABLE);
  assert.equal(isPublicEgressIp("2a01:4f8:1:2::1"), false);
  setInterfaceTableForTests(() => ({}));
  assert.equal(isPublicEgressIp("2a01:4f8:1:2::1"), true);
});

test("every egress guard refuses the host's own global IPv6, its /64 neighbour and its public IPv4 LAN", async () => {
  setInterfaceTableForTests(() => TABLE);
  const targets = ["2a01:4f8:1:2::10", "2a01:4f8:1:2::1", "198.20.5.1"];
  const lit = (a) => (a.includes(":") ? `[${a}]` : a);
  for (const a of targets) {
    // meta-glasses: classification, a literal URL, and a name that resolves to it
    assert.equal(isPrivateAddress(a), true, `net-guard ${a}`);
    await assert.rejects(fetchImagePinned(`http://${lit(a)}/x.png`, { lookup: async () => { throw new Error("no lookup for a literal"); } }), (e) => e.code === "host_not_allowed", `net-guard literal ${a}`);
    await assert.rejects(fetchImagePinned("http://art.example.test/x.png", { lookup: async () => [{ address: a, family: a.includes(":") ? 6 : 4 }] }), (e) => e.code === "host_not_allowed", `net-guard name ${a}`);
    // reader (checked on every redirect hop by fetchUrl)
    await assert.rejects(assertPublicHost(`http://${lit(a)}/doc`, {}), /private address/, `reader ${a}`);
    // funkwhale artwork proxy
    assert.equal((await validateHostOrReject(lit(a), { lookup: async () => { throw new Error("no lookup for a literal"); } })).reason, "private_host", `funkwhale literal ${a}`);
    assert.equal((await validateHostOrReject("art.example.test", { lookup: async () => [{ address: "8.8.8.8", family: 4 }, { address: a, family: a.includes(":") ? 6 : 4 }] })).reason, "private_host", `funkwhale name ${a}`);
  }
  // A public address off this host's networks still passes each guard's check.
  assert.equal(isPrivateAddress("2a01:4f8:1:3::1"), false);
  await assertPublicHost("http://[2a01:4f8:1:3::1]/doc", {});
  assert.equal((await validateHostOrReject("[2a01:4f8:1:3::1]", {})).ok, true);
});
