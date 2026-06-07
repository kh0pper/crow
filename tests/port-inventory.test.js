import { test } from "node:test";
import assert from "node:assert/strict";
import { parseComposeHostPorts, parseSsListeners } from "../servers/gateway/port-inventory.js";

const one = (yml) => { const r = parseComposeHostPorts(yml); return r.length === 1 ? r[0] : r; };

test("loopback + port-env", () => {
  assert.deepEqual(one(`services:\n  k:\n    ports:\n      - "127.0.0.1:\${KOLIBRI_HTTP_PORT:-8085}:8080"\n`),
    { port: 8085, portEnvVar: "KOLIBRI_HTTP_PORT", bind: "127.0.0.1", bindKind: "loopback", proto: "tcp" });
});

test("bind-env + port-env (funkwhale)", () => {
  assert.deepEqual(one(`services:\n  f:\n    ports:\n      - "\${FW_ADDR:-127.0.0.1}:\${FW_PORT:-8600}:80"\n`),
    { port: 8600, portEnvVar: "FW_PORT", bind: "127.0.0.1", bindKind: "loopback", proto: "tcp" });
});

test("routable-IP env + literal port -> bind template, port literal, NOT port-env", () => {
  assert.deepEqual(one(`services:\n  m:\n    ports:\n      - "\${CROW_TAILSCALE_IP}:8003:8000"\n`),
    { port: 8003, portEnvVar: null, bind: "\${CROW_TAILSCALE_IP}", bindKind: "template", proto: "tcp" });
});

test("port-env, no bind -> all interfaces", () => {
  assert.deepEqual(one(`services:\n  n:\n    ports:\n      - "\${NOMINATIM_PORT:-8088}:8080"\n`),
    { port: 8088, portEnvVar: "NOMINATIM_PORT", bind: "0.0.0.0", bindKind: "all", proto: "tcp" });
});

test("hardcoded loopback", () => {
  assert.deepEqual(one(`services:\n  fw:\n    ports:\n      - "127.0.0.1:8004:8000"\n`),
    { port: 8004, portEnvVar: null, bind: "127.0.0.1", bindKind: "loopback", proto: "tcp" });
});

test("bare host:container + udp proto", () => {
  assert.deepEqual(one(`services:\n  a:\n    ports:\n      - "8555:8555/udp"\n`),
    { port: 8555, portEnvVar: null, bind: "0.0.0.0", bindKind: "all", proto: "udp" });
});

test("multi-port bundle returns all", () => {
  const yml = `services:\n  frigate:\n    ports:\n      - "127.0.0.1:8971:8971"\n      - "127.0.0.1:8554:8554"\n      - "127.0.0.1:8555:8555/tcp"\n      - "127.0.0.1:8555:8555/udp"\n`;
  const r = parseComposeHostPorts(yml);
  assert.equal(r.length, 4);
  assert.deepEqual(r.map(x => x.port), [8971, 8554, 8555, 8555]);
  assert.equal(r[3].proto, "udp");
});

test("host-network / no ports -> empty array", () => {
  assert.deepEqual(parseComposeHostPorts(`services:\n  a:\n    network_mode: host\n`), []);
});

test("port-env with no default -> port null, portEnvVar set", () => {
  assert.deepEqual(one(`services:\n  a:\n    ports:\n      - "\${SOME_PORT}:80"\n`),
    { port: null, portEnvVar: "SOME_PORT", bind: "0.0.0.0", bindKind: "all", proto: "tcp" });
});

test("container-only short form -> skipped (no host port)", () => {
  assert.deepEqual(parseComposeHostPorts(`services:\n  a:\n    ports:\n      - "80"\n`), []);
});

test("parseSsListeners parses addr:port incl ipv6 + %iface", () => {
  const out = `LISTEN 0 511    127.0.0.1:3001 0.0.0.0:*\nLISTEN 0 4096   100.118.41.122:8003 0.0.0.0:*\nLISTEN 0 128    [::]:8880 [::]:*\nLISTEN 0 4096   127.0.0.53%lo:53 0.0.0.0:*`;
  assert.deepEqual(parseSsListeners(out), [
    { port: 3001, boundAddr: "127.0.0.1" },
    { port: 8003, boundAddr: "100.118.41.122" },
    { port: 8880, boundAddr: "[::]" },
    { port: 53, boundAddr: "127.0.0.53%lo" },
  ]);
});

import { attributeAndDetect } from "../servers/gateway/port-inventory.js";

// endpoint: { bundleId, bundleName, port, bind, bindKind, proto, source }
const ep = (bundleId, port, bindKind, extra = {}) =>
  ({ bundleId, bundleName: bundleId, port, bind: bindKind === "loopback" ? "127.0.0.1" : bindKind === "template" ? "${IP}" : "0.0.0.0", bindKind, proto: "tcp", source: "compose", ...extra });
const core = new Map([[3001, "Crow gateway"]]);

test("parameterized endpoint listening -> up, not conflict, shows bound addr", () => {
  const rows = attributeAndDetect([ep("kolibri", 8085, "loopback", { portEnvVar: "KOLIBRI_HTTP_PORT" })],
    [{ port: 8085, boundAddr: "127.0.0.1" }], core);
  const r = rows.find(x => x.port === 8085);
  assert.equal(r.kind, "parameterized");
  assert.equal(r.status, "up");
  assert.equal(r.conflict, false);
  assert.equal(r.boundAddr, "127.0.0.1");
});

test("template-bound model bundle listening on resolved addr -> status up (not down)", () => {
  const rows = attributeAndDetect([ep("vllm-rocm-qwen3", 8001, "template")],
    [{ port: 8001, boundAddr: "100.118.41.122" }], core);
  const r = rows.find(x => x.port === 8001);
  assert.equal(r.status, "up");
  assert.equal(r.conflict, false);
});

test(":8004 two listeners on different specific addrs -> NOT a conflict", () => {
  const rows = attributeAndDetect(
    [ep("faster-whisper-server", 8004, "loopback"), ep("llamacpp-vulkan-qwen3-embed", 8004, "template")],
    [{ port: 8004, boundAddr: "127.0.0.1" }, { port: 8004, boundAddr: "100.118.41.122" }], core);
  const r = rows.find(x => x.port === 8004);
  assert.equal(r.conflict, false);
  assert.equal(r.shared, true);
});

test("swap-group: two declared, one live listener -> shared, up, not conflict", () => {
  const rows = attributeAndDetect(
    [ep("vllm-rocm-kimi", 8003, "template"), ep("llamacpp-qwen72b", 8003, "template")],
    [{ port: 8003, boundAddr: "100.118.41.122" }], core);
  const r = rows.find(x => x.port === 8003);
  assert.equal(r.shared, true);
  assert.equal(r.status, "up");
  assert.equal(r.conflict, false);
});

test("foreign listener (no Crow declaration) -> informational, not conflict", () => {
  const rows = attributeAndDetect([], [{ port: 22, boundAddr: "0.0.0.0" }], core);
  const r = rows.find(x => x.port === 22);
  assert.equal(r.kind, "foreign");
  assert.equal(r.conflict, false);
});

test("core service port shown, not conflict", () => {
  const rows = attributeAndDetect([], [{ port: 3001, boundAddr: "127.0.0.1" }], core);
  assert.equal(rows.find(x => x.port === 3001).kind, "core");
});

test("manifest-only endpoint (no compose publish) -> kind managed", () => {
  const rows = attributeAndDetect(
    [{ bundleId: "x", bundleName: "X", port: 9100, bind: "0.0.0.0", bindKind: "all", proto: "tcp", source: "manifest" }],
    [{ port: 9100, boundAddr: "100.118.41.122" }], core);
  const r = rows.find(x => x.port === 9100);
  assert.equal(r.kind, "managed");
});

test("genuine double-bind: two overlapping listeners on a port -> conflict", () => {
  const rows = attributeAndDetect(
    [ep("a", 7000, "all")],
    [{ port: 7000, boundAddr: "0.0.0.0" }, { port: 7000, boundAddr: "127.0.0.1" }], core);
  const r = rows.find(x => x.port === 7000);
  assert.equal(r.conflict, true);
});

test("dual-stack wildcard (0.0.0.0 + [::]) on same port -> NOT a conflict", () => {
  const rows = attributeAndDetect([], [{ port: 22, boundAddr: "0.0.0.0" }, { port: 22, boundAddr: "[::]" }], core);
  const r = rows.find(x => x.port === 22);
  assert.equal(r.conflict, false);
});
