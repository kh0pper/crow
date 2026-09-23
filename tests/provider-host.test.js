import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isInstanceIdShape, isValidHost, hostnameOf, isIpLiteral, inferHost,
  isForeignInstanceHost, inRepairScope, repairHostDecision, hostLabel,
} from "../servers/shared/provider-host.js";
import { addressClass, isPrivateHost } from "../servers/shared/locality.js";

const OWN_ID = "0867ac2809dedd885ba7769b21966f8e";
const PEER_ID = "49cf71ca878643ba7717f344329266fd";
const CROW = new Set(["localhost", "127.0.0.1", "::1", "10.0.0.237", "100.118.41.122"]);
const CROW_NO_TS = new Set(["localhost", "127.0.0.1", "::1", "10.0.0.237"]);
const LOOP_ONLY = new Set(["localhost", "127.0.0.1", "::1"]);

test("isInstanceIdShape / isValidHost", () => {
  assert.equal(isInstanceIdShape(OWN_ID), true);
  assert.equal(isInstanceIdShape(OWN_ID.toUpperCase()), false);
  assert.equal(isInstanceIdShape("grackle-5fc01ac74463b6f4"), false);
  assert.equal(isInstanceIdShape("aaaaaaaa-0000-0000-0000-00000000000a"), false);
  for (const v of ["local", "cloud", OWN_ID]) assert.equal(isValidHost(v), true, v);
  for (const v of ["raven", "external", "grackle-5fc01ac74463b6f4", "", null, undefined, "LOCAL", 42]) {
    assert.equal(isValidHost(v), false, String(v));
  }
});

test("hostnameOf / isIpLiteral", () => {
  assert.equal(hostnameOf("http://[::1]:8080/v1"), "::1");
  assert.equal(hostnameOf("http://[FD00::5]:80/"), "fd00::5");
  assert.equal(hostnameOf("HTTP://Raven:8030/v1"), "raven");
  assert.equal(hostnameOf("not a url"), null);
  assert.equal(hostnameOf(""), null);
  assert.equal(hostnameOf(null), null);
  assert.equal(isIpLiteral("10.0.0.126"), true);
  assert.equal(isIpLiteral("fd00::5"), true);
  assert.equal(isIpLiteral("raven"), false);
});

test("inferHost: own/loopback → local; every foreign address → cloud (the regression)", () => {
  const o = { ownAddrs: CROW };
  assert.equal(inferHost("http://127.0.0.1:8003/v1", null, o), "local");
  assert.equal(inferHost("http://localhost:3001/llm/v1", null, o), "local");
  assert.equal(inferHost("http://[::1]:8080/v1", null, o), "local");
  assert.equal(inferHost("http://100.118.41.122:8003/v1", null, o), "local");
  assert.equal(inferHost("http://10.0.0.237:8003/v1", null, o), "local");
  assert.equal(inferHost("http://10.0.0.126:8030/v1", null, o), "cloud");
  assert.equal(inferHost("http://192.168.1.50:8000/v1", null, o), "cloud");
  assert.equal(inferHost("http://100.121.254.89:9100/v1", null, o), "cloud");
  assert.equal(inferHost("https://api.z.ai/api/coding/paas/v4", null, o), "cloud");
  assert.equal(inferHost("http://raven:8030/v1", null, o), "cloud"); // D8 unchanged
  assert.equal(inferHost("", null, o), "local");
  assert.equal(inferHost(null, null, o), "local");
  assert.equal(inferHost("not a url", null, o), "local");
});

test("inferHost: valid existing host short-circuits; invalid falls through", () => {
  assert.equal(inferHost("http://10.0.0.126:8030/v1", "local", { ownAddrs: CROW }), "local");
  assert.equal(inferHost("http://10.0.0.126:8030/v1", PEER_ID, { ownAddrs: CROW }), PEER_ID);
  assert.equal(inferHost("http://10.0.0.126:8030/v1", "raven", { ownAddrs: CROW }), "cloud");
  assert.equal(inferHost("http://100.121.254.89:9100/v1", "grackle-5fc01ac74463b6f4",
    { ownAddrs: new Set(["127.0.0.1", "100.121.254.89"]) }), "local");
});

test("isForeignInstanceHost: only a DIFFERENT 32-hex id is foreign; id read lazily", () => {
  let reads = 0;
  const own = () => { reads++; return OWN_ID; };
  for (const h of ["local", "cloud", "raven", "grackle-5fc01ac74463b6f4", null, undefined]) {
    assert.equal(isForeignInstanceHost(h, own), false, String(h));
  }
  assert.equal(reads, 0, "never reads the instance id for non-id hosts");
  assert.equal(isForeignInstanceHost(OWN_ID, own), false);
  assert.equal(isForeignInstanceHost(PEER_ID, own), true);
  assert.equal(isForeignInstanceHost(PEER_ID, () => null), true, "unknown own id: any id is foreign");
});

const row = (host, baseUrl, extra = {}) => ({
  host, baseUrl, instance_id: OWN_ID, bundleId: null, gpuPolicy: null, disabled: false, ...extra,
});

test("inRepairScope: bundle, owned-native, local_only and disabled rows are out", () => {
  assert.equal(inRepairScope(row("local", "http://10.0.0.126:1/v1")), true);
  assert.equal(inRepairScope(row("local", "http://10.0.0.126:1/v1", { bundleId: "b" })), false);
  assert.equal(inRepairScope(row("local", "http://10.0.0.126:1/v1", { gpuPolicy: { owner: OWN_ID } })), false);
  assert.equal(inRepairScope(row("local", "http://10.0.0.126:1/v1", { gpuPolicy: { local_only: true } })), false);
  assert.equal(inRepairScope(row("local", "http://10.0.0.126:1/v1", { disabled: true })), false);
  assert.equal(inRepairScope(null), false);
});

test("repairHostDecision: the two live crow rows", () => {
  const o = { ownInstanceId: OWN_ID, ownAddrs: CROW };
  assert.equal(repairHostDecision(row("local", "http://10.0.0.126:8731/v1"), o), "cloud");
  assert.equal(repairHostDecision(row("raven", "http://10.0.0.126:8030/v1"), o), "cloud");
});

test("repairHostDecision D3: another instance's write is never touched", () => {
  const o = { ownInstanceId: OWN_ID, ownAddrs: CROW };
  assert.equal(repairHostDecision(row("local", "http://10.0.0.126:8731/v1", { instance_id: PEER_ID }), o), null);
  assert.equal(repairHostDecision(row("raven", "http://10.0.0.126:8030/v1", { instance_id: PEER_ID }), o), null);
  assert.equal(repairHostDecision(row("local", "http://10.0.0.126:8731/v1"), { ownInstanceId: null, ownAddrs: CROW }), null);
});

test("repairHostDecision scope: re-stamped BUNDLE row (the live crow-chat case) is never touched", () => {
  // On grackle: crow-chat is host=local, base_url crow's 100.118.41.122, instance_id = grackle
  const GRACKLE = new Set(["127.0.0.1", "::1", "localhost", "10.0.0.21", "100.121.254.89"]);
  const crowChat = row("local", "http://100.118.41.122:8003/v1", { bundleId: "llamacpp-vulkan-qwen36-35b-a3b" });
  assert.equal(repairHostDecision(crowChat, { ownInstanceId: OWN_ID, ownAddrs: GRACKLE }), null);
});

test("repairHostDecision: never touches valid non-local hosts, own addresses, DNS names (G2)", () => {
  const o = { ownInstanceId: OWN_ID, ownAddrs: CROW };
  assert.equal(repairHostDecision(row("cloud", "http://10.0.0.126:8030/v1"), o), null);
  assert.equal(repairHostDecision(row(PEER_ID, "http://10.0.0.126:8030/v1"), o), null);
  assert.equal(repairHostDecision(row("local", "http://100.118.41.122:8003/v1"), o), null);
  assert.equal(repairHostDecision(row("local", "http://127.0.0.1:8020/v1"), o), null);
  assert.equal(repairHostDecision(row("local", "https://api.z.ai/api/coding/paas/v4"), o), null);
  assert.equal(repairHostDecision(row("local", "http://raven:8030/v1"), o), null);
  assert.equal(repairHostDecision(row("local", ""), o), null);
  // invalid label on a DNS-name row → left for the operator (cloud result, not judgeable)
  assert.equal(repairHostDecision(row("raven", "http://raven:8030/v1"), o), null);
  // invalid label whose inference is local (own address) IS repaired
  assert.equal(repairHostDecision(row("raven", "http://127.0.0.1:9/v1"), o), "local");
});

test("repairHostDecision G1: 100.x targets skipped while no CGNAT own address — BOTH branches", () => {
  const o = { ownInstanceId: OWN_ID, ownAddrs: CROW_NO_TS };
  assert.equal(repairHostDecision(row("local", "http://100.118.41.122:8003/v1"), o), null);
  assert.equal(repairHostDecision(row("raven", "http://100.121.254.89:9100/v1"), o), null);
  assert.equal(repairHostDecision(row("local", "http://10.0.0.126:8731/v1"), o), "cloud");
});

test("repairHostDecision G1: loopback-only box repairs nothing to cloud", () => {
  const o = { ownInstanceId: OWN_ID, ownAddrs: LOOP_ONLY };
  assert.equal(repairHostDecision(row("local", "http://10.0.0.126:8731/v1"), o), null);
  assert.equal(repairHostDecision(row("raven", "http://10.0.0.126:8030/v1"), o), null);
});

test("repairHostDecision G1: link-local and public-family mismatch are not judged", () => {
  const o = { ownInstanceId: OWN_ID, ownAddrs: new Set([...CROW, "fe80::abcd", "2601:2c5::5"]) };
  assert.equal(repairHostDecision(row("local", "http://[fe80::1]:80/"), o), null);
  // box has public6 only → a public4 target is not judged
  assert.equal(repairHostDecision(row("local", "http://8.8.8.8:80/"), o), null);
});

test("addressClass", () => {
  assert.equal(addressClass("127.0.0.1"), "loopback");
  assert.equal(addressClass("::1"), "loopback");
  assert.equal(addressClass("169.254.3.3"), "linklocal");
  assert.equal(addressClass("fe80::1"), "linklocal");
  assert.equal(addressClass("100.64.0.1"), "cgnat");
  assert.equal(addressClass("100.127.255.254"), "cgnat");
  assert.equal(addressClass("100.128.0.1"), "public4");
  assert.equal(addressClass("10.0.0.126"), "rfc1918");
  assert.equal(addressClass("172.16.0.1"), "rfc1918");
  assert.equal(addressClass("172.32.0.1"), "public4");
  assert.equal(addressClass("192.168.1.1"), "rfc1918");
  assert.equal(addressClass("fd00::5"), "ula");
  assert.equal(addressClass("fc00::5"), "ula");
  assert.equal(addressClass("::ffff:10.0.0.1"), "rfc1918");
  assert.equal(addressClass("::ffff:a00:1"), "rfc1918"); // WHATWG URL's normalised form of [::ffff:10.0.0.1]
  assert.equal(hostnameOf("http://[::ffff:10.0.0.1]/"), "::ffff:a00:1");
  assert.equal(addressClass("8.8.8.8"), "public4");
  assert.equal(addressClass("2606:4700::1111"), "public6");
  assert.equal(addressClass("raven"), null);
});

test("isPrivateHost (display only)", () => {
  for (const h of ["10.0.0.126", "100.121.254.89", "fd00::5", "raven", "localhost",
                   "grackle.dachshund-chromatic.ts.net", "nas.local", "box.lan", "x.home.arpa", "y.internal"]) {
    assert.equal(isPrivateHost(h), true, h);
  }
  for (const h of ["8.8.8.8", "api.z.ai", "api.together.xyz", "", null]) {
    assert.equal(isPrivateHost(h), false, String(h));
  }
});

test("hostLabel", () => {
  const ctx = { ownAddrs: CROW, ownInstanceId: OWN_ID, instanceNames: new Map([[PEER_ID, "Primary"]]) };
  assert.deepEqual(hostLabel({ host: "local", baseUrl: "http://100.118.41.122:8003/v1" }, ctx), { kind: "this", text: "this machine" });
  assert.deepEqual(hostLabel({ host: "local", baseUrl: "" }, ctx), { kind: "this", text: "this machine" });
  assert.deepEqual(hostLabel({ host: "local", baseUrl: "http://100.121.254.89:9100/v1" }, ctx), { kind: "network", text: "network" });
  assert.deepEqual(hostLabel({ host: "local", baseUrl: "https://api.z.ai/v4" }, ctx), { kind: "cloud", text: "cloud" });
  assert.deepEqual(hostLabel({ host: "cloud", baseUrl: "http://10.0.0.126:8030/v1" }, ctx), { kind: "network", text: "network" });
  assert.deepEqual(hostLabel({ host: "cloud", baseUrl: "https://api.together.xyz/v1" }, ctx), { kind: "cloud", text: "cloud" });
  assert.deepEqual(hostLabel({ host: OWN_ID, baseUrl: "http://127.0.0.1:1/v1" }, ctx), { kind: "this", text: "this machine" });
  assert.deepEqual(hostLabel({ host: PEER_ID, baseUrl: "http://x/v1" }, ctx), { kind: "instance", text: "Primary" });
  const unknown = "ffffffffffffffffffffffffffffffff";
  assert.deepEqual(hostLabel({ host: unknown, baseUrl: "http://x/v1" }, ctx), { kind: "instance", text: unknown.slice(0, 18) });
  assert.deepEqual(hostLabel({ host: "raven", baseUrl: "http://10.0.0.126:8030/v1" }, ctx), { kind: "invalid", text: "raven" });
});
