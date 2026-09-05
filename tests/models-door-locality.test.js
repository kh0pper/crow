import { test } from "node:test";
import assert from "node:assert/strict";
import { gatewayPort, doorBaseUrl, nativeLoopbackUrl } from "../servers/gateway/models/door.js";
import { getOwnTailnetIp, _resetTailnetIpCache } from "../servers/shared/tailnet-ip.js";
import { isOwnedHere, isOrchestratableHere, localizeNativeRow } from "../servers/shared/native-locality.js";

const OWN = new Set(["localhost", "127.0.0.1", "::1", "100.118.41.122"]);

test("gatewayPort: PORT wins, then CROW_GATEWAY_PORT, then 3001", () => {
  assert.equal(gatewayPort({ PORT: "3008", CROW_GATEWAY_PORT: "3001" }), 3008);
  assert.equal(gatewayPort({ CROW_GATEWAY_PORT: "3008" }), 3008);
  assert.equal(gatewayPort({}), 3001);
});

test("doorBaseUrl and nativeLoopbackUrl shapes", () => {
  assert.equal(doorBaseUrl({ tailnetIp: "100.118.41.122", port: 3001 }), "http://100.118.41.122:3001/llm/v1");
  assert.equal(doorBaseUrl({ tailnetIp: null, port: 3001 }), "http://127.0.0.1:3001/llm/v1");
  assert.equal(nativeLoopbackUrl(18100), "http://127.0.0.1:18100/v1");
});

test("getOwnTailnetIp: env override, tailscale output, failure -> null; cached", () => {
  _resetTailnetIpCache();
  assert.equal(getOwnTailnetIp({ env: { CROW_TAILNET_IP: "100.1.2.3" } }), "100.1.2.3");
  _resetTailnetIpCache();
  let calls = 0;
  const exec = () => { calls++; return "100.118.41.122\nfd7a:115c::1\n"; };
  assert.equal(getOwnTailnetIp({ env: {}, execFileSyncImpl: exec }), "100.118.41.122");
  assert.equal(getOwnTailnetIp({ env: {}, execFileSyncImpl: exec }), "100.118.41.122");
  assert.equal(calls, 1);
  _resetTailnetIpCache();
  assert.equal(getOwnTailnetIp({ env: {}, execFileSyncImpl: () => { throw new Error("no tailscale"); } }), null);
});

test("isOwnedHere: declared owner compares; undeclared is null", () => {
  assert.equal(isOwnedHere({ gpuPolicy: { owner: "A" } }, "A"), true);
  assert.equal(isOwnedHere({ gpuPolicy: { owner: "A" } }, "B"), false);
  assert.equal(isOwnedHere({ gpuPolicy: {} }, "B"), null);
  assert.equal(isOwnedHere({}, "B"), null);
});

test("isOrchestratableHere: owner gate wins over the baseUrl-hostname rule; falls back to it when no owner", () => {
  const door = { baseUrl: "http://100.118.41.122:3001/llm/v1", gpuPolicy: { runtime: "native", owner: "crow" } };
  assert.equal(isOrchestratableHere(door, { ownAddrs: OWN, ownInstanceId: "crow" }), true);
  // r4 shares the box: same tailnet address is in OWN, but the owner is crow -> not orchestratable on r4.
  assert.equal(isOrchestratableHere(door, { ownAddrs: OWN, ownInstanceId: "r4" }), false);
  const bundle = { baseUrl: "http://100.118.41.122:8003/v1", bundleId: "x" };
  assert.equal(isOrchestratableHere(bundle, { ownAddrs: OWN, ownInstanceId: "r4" }), true); // unchanged legacy rule
  assert.equal(isOrchestratableHere({ baseUrl: "http://100.121.254.89:9100/v1" }, { ownAddrs: OWN, ownInstanceId: "crow" }), false);
});

test("localizeNativeRow rewrites an owned native row to loopback and keeps the door; leaves everything else untouched", () => {
  const row = { baseUrl: "http://100.118.41.122:3001/llm/v1", gpuPolicy: { runtime: "native", owner: "crow", port: 18100 } };
  const local = localizeNativeRow(row, "crow");
  assert.equal(local.baseUrl, "http://127.0.0.1:18100/v1");
  assert.equal(local.doorUrl, "http://100.118.41.122:3001/llm/v1");
  assert.equal(row.baseUrl, "http://100.118.41.122:3001/llm/v1", "input not mutated");
  assert.equal(localizeNativeRow(row, "r4"), row);
  assert.equal(localizeNativeRow({ baseUrl: "http://x/v1", bundleId: "b" }, "crow").baseUrl, "http://x/v1");
  const noPort = { baseUrl: "http://127.0.0.1:18100/v1", gpuPolicy: { runtime: "native", owner: "crow" } };
  assert.equal(localizeNativeRow(noPort, "crow").baseUrl, "http://127.0.0.1:18100/v1"); // pre-arc row: already loopback, no rewrite
});

test("getOwnTailnetIp: IPv6-first output extracts the first IPv4 address", () => {
  _resetTailnetIpCache();
  const exec = () => "fd7a:115c::1\n100.118.41.122\n";
  assert.equal(getOwnTailnetIp({ env: {}, execFileSyncImpl: exec }), "100.118.41.122");
});

test("getOwnTailnetIp: cache: false bypasses cache on every call", () => {
  _resetTailnetIpCache();
  let calls = 0;
  const exec = () => { calls++; return "100.118.41.122\n"; };
  assert.equal(getOwnTailnetIp({ env: {}, execFileSyncImpl: exec, cache: false }), "100.118.41.122");
  assert.equal(getOwnTailnetIp({ env: {}, execFileSyncImpl: exec, cache: false }), "100.118.41.122");
  assert.equal(calls, 2);
  // After cache:false calls, a cache:true call should still probe because _cached was never set
  assert.equal(getOwnTailnetIp({ env: {}, execFileSyncImpl: exec, cache: true }), "100.118.41.122");
  assert.equal(calls, 3);
});

test("isOwnedHere: empty string owner is null (falsy but not undeclared)", () => {
  assert.equal(isOwnedHere({ gpuPolicy: { owner: "" } }, "A"), null);
});

test("isOrchestratableHere: empty owner falls back to baseUrl rule; loopback in OWN -> true", () => {
  const row = { baseUrl: "http://127.0.0.1:18100/v1", gpuPolicy: { owner: "" } };
  assert.equal(isOrchestratableHere(row, { ownAddrs: OWN, ownInstanceId: "crow" }), true);
});

test("localizeNativeRow: string port (numeric) is converted and used", () => {
  const row = { baseUrl: "http://100.118.41.122:3001/llm/v1", gpuPolicy: { runtime: "native", owner: "crow", port: "18100" } };
  const local = localizeNativeRow(row, "crow");
  assert.equal(local.baseUrl, "http://127.0.0.1:18100/v1");
  assert.equal(local.doorUrl, "http://100.118.41.122:3001/llm/v1");
});
