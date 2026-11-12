/**
 * The tailnet firewall decision for bundle ports (servers/gateway/bundle-firewall.js).
 * Pure helpers, an injected runner throughout: no sudo, no ufw, no Tailscale anywhere.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  tailscaleUp, portLoopbackOnly, tailnetRuleArgs, deleteRuleArgs,
  openTailnetPorts, closeTailnetPorts,
} from "../servers/gateway/bundle-firewall.js";

const LOG_LINE_NO_TAILSCALE = (p) => `Tailscale is not running here, so no tailnet firewall rule was added for port ${p} — connect Tailscale and reinstall this add-on to add the rule later`;
const LOG_LINE_LOOPBACK = (p) => `Port ${p} listens only on this machine, so no firewall rule is needed`;
const LOG_LINE_OPENED = (p) => `Opened firewall port ${p}/tcp for Tailscale`;
const LOG_LINE_OPEN_FAILED = (p) => `Note: Could not open port ${p} (sudo/ufw not available — open manually if needed)`;
const LOG_LINE_CLOSED = (p) => `Closed firewall port ${p}/tcp`;
const LOG_LINE_CLOSE_FAILED = (p) => `Note: Could not close port ${p} (sudo/ufw not available)`;


function iface(address, extra = {}) {
  return [{ address, family: "IPv4", internal: false, netmask: "255.192.0.0", cidr: `${address}/10`, ...extra }];
}

function modelWithPorts(ports) {
  return { name: "bundle", services: { app: { ports } } };
}

// --- tailscaleUp -----------------------------------------------------------

test("tailscaleUp: a tailnet address on tailscale0 is up", () => {
  assert.equal(tailscaleUp({ tailscale0: iface("100.64.0.7") }), true);
  assert.equal(tailscaleUp({ tailscale0: iface("100.101.5.6") }), true);
  assert.equal(tailscaleUp({ tailscale0: iface("100.127.255.254") }), true);
});

test("tailscaleUp: no tailscale0 interface is down", () => {
  assert.equal(tailscaleUp({}), false);
  assert.equal(tailscaleUp({ eth0: iface("192.168.1.20") }), false);
  assert.equal(tailscaleUp({ tailscale0: [] }), false);
  assert.equal(tailscaleUp({ tailscale0: undefined }), false);
  // No interfaces injected: this reads the real host, so only the shape is asserted —
  // a host that really runs Tailscale (with a tailnet interface up) returns true here.
  assert.equal(typeof tailscaleUp(), "boolean");
});

test("tailscaleUp: an address outside 100.64.0.0/10 is down", () => {
  assert.equal(tailscaleUp({ tailscale0: iface("100.63.0.7") }), false); //  often DSHISP/NAT, not tailnet
  assert.equal(tailscaleUp({ tailscale0: iface("100.128.0.1") }), false);
  assert.equal(tailscaleUp({ tailscale0: iface("192.168.1.20") }), false);
  assert.equal(tailscaleUp({ tailscale0: iface("10.0.0.1") }), false);
  assert.equal(tailscaleUp({ tailscale0: iface("100.64.0.7", { family: "IPv6" }) }), false);
  assert.equal(tailscaleUp({ tailscale0: iface("100.64.0.7", { internal: true }) }), false);
});

test("tailscaleUp: a second non-tailnet address does not make it up", () => {
  assert.equal(tailscaleUp({
    tailscale0: [
      { address: "fe80::1", family: "IPv6", internal: false },
      { address: "192.168.1.5", family: "IPv4", internal: false },
    ],
  }), false);
});

// --- portLoopbackOnly ------------------------------------------------------

test("portLoopbackOnly: a 127.0.0.1 publish is loopback-only", () => {
  assert.equal(portLoopbackOnly(modelWithPorts([{ target: 8080, published: "8080", host_ip: "127.0.0.1", protocol: "tcp", mode: "host" }]), 8080), true);
});

test("portLoopbackOnly: ::1 and localhost are loopback too", () => {
  assert.equal(portLoopbackOnly(modelWithPorts([{ target: 8080, published: 8080, host_ip: "::1", protocol: "tcp" }]), 8080), true);
  assert.equal(portLoopbackOnly(modelWithPorts([{ target: 8080, published: "8080", host_ip: "localhost", protocol: "tcp" }]), "8080"), true);
});

test("portLoopbackOnly: a number or a string published both match the port", () => {
  assert.equal(portLoopbackOnly(modelWithPorts([{ target: 9000, published: 9000, host_ip: "127.0.0.1" }]), 9000), true);
  assert.equal(portLoopbackOnly(modelWithPorts([{ target: 9000, published: "9000", host_ip: "127.0.0.1" }]), 9000), true);
  assert.equal(portLoopbackOnly(modelWithPorts([{ target: 9000, published: "9000", host_ip: "127.0.0.1", protocol: "tcp" }]), "9000"), true);
});

test("portLoopbackOnly: one mapping on 0.0.0.0 (or a mixed pair) is NOT loopback", () => {
  assert.equal(portLoopbackOnly(modelWithPorts([{ target: 8080, published: "8080", host_ip: "0.0.0.0", protocol: "tcp" }]), 8080), false);
  assert.equal(portLoopbackOnly(modelWithPorts([
    { target: 8080, published: "8080", host_ip: "127.0.0.1", protocol: "tcp" },
    { target: 8080, published: "8080", host_ip: "0.0.0.0", protocol: "tcp" },
  ]), 8080), false);
});

test("portLoopbackOnly: an empty or absent host_ip means the wildcard, not loopback", () => {
  assert.equal(portLoopbackOnly(modelWithPorts([{ target: 8080, published: "8080", host_ip: "", protocol: "tcp" }]), 8080), false);
  assert.equal(portLoopbackOnly(modelWithPorts([{ target: 8080, published: "8080" }]), 8080), false);
  assert.equal(portLoopbackOnly(modelWithPorts([{ target: 8080, published: "8080", host_ip: "10.0.0.5" }]), 8080), false);
});

test("portLoopbackOnly: a port the model does not publish is not loopback, and neither is a udp-only mapping", () => {
  assert.equal(portLoopbackOnly(modelWithPorts([{ target: 8080, published: "8080", host_ip: "127.0.0.1", protocol: "tcp" }]), 9090), false);
  assert.equal(portLoopbackOnly(modelWithPorts([{ target: 8080, published: "8080", host_ip: "127.0.0.1", protocol: "udp" }]), 8080), false);
  assert.equal(portLoopbackOnly(modelWithPorts([{ target: 8080, published: null, host_ip: "127.0.0.1", protocol: "tcp" }]), 8080), false);
  assert.equal(portLoopbackOnly(modelWithPorts([]), 8080), false);
});

test("portLoopbackOnly: an unknown model is not loopback", () => {
  assert.equal(portLoopbackOnly(null, 8080), false);
  assert.equal(portLoopbackOnly(undefined, 8080), false);
  assert.equal(portLoopbackOnly({}, 8080), false);
  assert.equal(portLoopbackOnly("not a model", 8080), false);
  assert.equal(portLoopbackOnly({ services: null }, 8080), false);
});

test("portLoopbackOnly: loopback in another service counts against the port", () => {
  const model = {
    name: "bundle",
    services: {
      app: { ports: [{ target: 8080, published: "8080", host_ip: "127.0.0.1", protocol: "tcp" }] },
      sidecar: { ports: [{ target: 8080, published: "8080", host_ip: "0.0.0.0", protocol: "tcp" }] },
    },
  };
  assert.equal(portLoopbackOnly(model, 8080), false);
});

// --- argvs -----------------------------------------------------------------

test("tailnetRuleArgs: the exact scoped ufw allow", () => {
  assert.deepEqual(tailnetRuleArgs(8080, "Ramble"), [
    "-n", "ufw", "allow", "in", "on", "tailscale0", "from", "100.64.0.0/10",
    "to", "any", "port", "8080", "proto", "tcp", "comment", "Crow: Ramble",
  ]);
});

test("deleteRuleArgs: the exact scoped and legacy ufw deletes, in that order", () => {
  assert.deepEqual(deleteRuleArgs(8080), [
    ["-n", "ufw", "delete", "allow", "in", "on", "tailscale0", "from", "100.64.0.0/10", "to", "any", "port", "8080", "proto", "tcp"],
    ["-n", "ufw", "delete", "allow", "from", "100.64.0.0/10", "to", "any", "port", "8080", "proto", "tcp"],
  ]);
});

// --- openTailnetPorts ------------------------------------------------------

function recorder(behaviour = () => {}) {
  const calls = [];
  const run = (cmd, argv, opts) => {
    calls.push({ cmd, argv, opts });
    return behaviour(cmd, argv, opts);
  };
  return { calls, run };
}

/** The legacy unscoped delete openTailnetPorts runs before adding or skipping a port. */
function legacyDeleteCall(port) {
  return { cmd: "sudo", argv: deleteRuleArgs(port)[1], opts: { timeout: 10000 } };
}

function addCall(port, name) {
  return { cmd: "sudo", argv: tailnetRuleArgs(port, name), opts: { timeout: 10000 } };
}

const TAILNET_UP = { tailscale0: iface("100.64.0.7") };
const TAILNET_DOWN = { eth0: iface("192.168.1.20") };

// --- the log line tells the operator what to do ----------------------------

test("the no-Tailscale line says to reinstall the add-on once Tailscale is connected, and prints no sudo command", () => {
  const line = LOG_LINE_NO_TAILSCALE(8080);
  assert.match(line, /connect Tailscale and reinstall this add-on/);
  assert.match(line, /add the rule later/);
  assert.doesNotMatch(line, /sudo/);
});

test("openTailnetPorts: Tailscale down calls no runner and says so per port", async () => {
  const logs = [];
  const { calls, run } = recorder();
  const results = await openTailnetPorts({
    ports: [8080, 9090], name: "Ramble", model: null,
    interfaces: { eth0: iface("192.168.1.20") }, run, log: (m) => logs.push(m),
  });
  assert.deepEqual(calls, []);
  assert.deepEqual(results, [
    { port: 8080, action: "skipped-no-tailscale" },
    { port: 9090, action: "skipped-no-tailscale" },
  ]);
  assert.deepEqual(logs, [LOG_LINE_NO_TAILSCALE(8080), LOG_LINE_NO_TAILSCALE(9090)]);
});

test("openTailnetPorts: a loopback-only port is skipped with its own line, after the legacy delete", async () => {
  const logs = [];
  const { calls, run } = recorder();
  const results = await openTailnetPorts({
    ports: [8080], name: "Ramble",
    model: modelWithPorts([{ target: 8080, published: "8080", host_ip: "127.0.0.1", protocol: "tcp" }]),
    interfaces: { tailscale0: iface("100.64.0.7") }, run, log: (m) => logs.push(m),
  });
  assert.deepEqual(calls, [legacyDeleteCall(8080)]);
  assert.deepEqual(results, [{ port: 8080, action: "skipped-loopback" }]);
  assert.deepEqual(logs, [LOG_LINE_LOOPBACK(8080)]);
});

test("openTailnetPorts: a wide port gets the exact add call, after the legacy delete", async () => {
  const logs = [];
  const { calls, run } = recorder();
  const results = await openTailnetPorts({
    ports: [8080], name: "Ramble",
    model: modelWithPorts([{ target: 8080, published: "8080", host_ip: "0.0.0.0", protocol: "tcp" }]),
    interfaces: { tailscale0: iface("100.64.0.7") }, run, log: (m) => logs.push(m),
  });
  assert.deepEqual(calls, [legacyDeleteCall(8080), addCall(8080, "Ramble")]);
  assert.deepEqual(results, [{ port: 8080, action: "added" }]);
  assert.deepEqual(logs, [LOG_LINE_OPENED(8080)]);
});

test("openTailnetPorts: an unknown model still gets the rule (unknown is not loopback)", async () => {
  const { calls, run } = recorder();
  const results = await openTailnetPorts({
    ports: [8080], name: "Ramble", model: null,
    interfaces: { tailscale0: iface("100.64.0.7") }, run,
  });
  assert.deepEqual(calls, [legacyDeleteCall(8080), addCall(8080, "Ramble")]);
  assert.deepEqual(results, [{ port: 8080, action: "added" }]);
});

test("openTailnetPorts: a throwing runner is logged, not propagated, and the next port still runs", async () => {
  const logs = [];
  const { calls, run } = recorder((_cmd, argv) => {
    if (argv.includes("8080")) throw new Error("sudo: no tty present");
  });
  const results = await openTailnetPorts({
    ports: [8080, 9090], name: "Ramble", model: null,
    interfaces: { tailscale0: iface("100.64.0.7") }, run, log: (m) => logs.push(m),
  });
  assert.deepEqual(calls, [
    legacyDeleteCall(8080), addCall(8080, "Ramble"),
    legacyDeleteCall(9090), addCall(9090, "Ramble"),
  ]);
  assert.deepEqual(results, [
    { port: 8080, action: "failed" },
    { port: 9090, action: "added" },
  ]);
  assert.deepEqual(logs, [LOG_LINE_OPEN_FAILED(8080), LOG_LINE_OPENED(9090)]);
});

// --- the legacy unscoped rule is cleaned up on open ------------------------

test("openTailnetPorts: the legacy delete comes first, then the scoped add", async () => {
  const { calls, run } = recorder();
  const results = await openTailnetPorts({
    ports: [8080], name: "Ramble", model: null,
    interfaces: TAILNET_UP, run,
  });
  assert.deepEqual(calls, [legacyDeleteCall(8080), addCall(8080, "Ramble")]);
  assert.ok(!calls[0].argv.includes("tailscale0"), "the first call is the unscoped delete");
  assert.deepEqual(results, [{ port: 8080, action: "added" }]);
});

test("openTailnetPorts: a loopback-only port gets the legacy delete and no add", async () => {
  const { calls, run } = recorder();
  const results = await openTailnetPorts({
    ports: [8080], name: "Ramble",
    model: modelWithPorts([{ target: 8080, published: "8080", host_ip: "127.0.0.1", protocol: "tcp" }]),
    interfaces: TAILNET_UP, run,
  });
  assert.deepEqual(calls, [legacyDeleteCall(8080)]);
  assert.deepEqual(results, [{ port: 8080, action: "skipped-loopback" }]);
});

test("openTailnetPorts: a throwing legacy delete does not stop the add", async () => {
  const { calls, run } = recorder((_cmd, argv) => {
    if (!argv.includes("tailscale0")) throw new Error("ufw: rule not found");
  });
  const results = await openTailnetPorts({
    ports: [8080], name: "Ramble", model: null,
    interfaces: TAILNET_UP, run,
  });
  assert.deepEqual(calls, [legacyDeleteCall(8080), addCall(8080, "Ramble")]);
  assert.deepEqual(results, [{ port: 8080, action: "added" }]);
});

test("openTailnetPorts: no legacy delete when Tailscale is down", async () => {
  const { calls, run } = recorder();
  await openTailnetPorts({
    ports: [8080], name: "Ramble", model: null,
    interfaces: TAILNET_DOWN, run,
  });
  assert.deepEqual(calls, []);
});

// --- closeTailnetPorts -----------------------------------------------------

test("closeTailnetPorts: both deletes are attempted, in order, even when the first throws", async () => {
  const logs = [];
  const { calls, run } = recorder((_cmd, argv) => {
    if (argv.includes("tailscale0")) throw new Error("sudo/ufw not available");
  });
  const results = await closeTailnetPorts({ ports: [8080], run, log: (m) => logs.push(m) });
  const [scoped, legacy] = deleteRuleArgs(8080);
  assert.deepEqual(calls, [
    { cmd: "sudo", argv: scoped, opts: { timeout: 10000 } },
    { cmd: "sudo", argv: legacy, opts: { timeout: 10000 } },
  ]);
  assert.deepEqual(results, [{ port: 8080, action: "closed" }]);
  assert.deepEqual(logs, [LOG_LINE_CLOSED(8080)]);
});

test("closeTailnetPorts: both deletes attempted per port, several ports, and a total failure says so", async () => {
  const logs = [];
  const { calls, run } = recorder((_cmd, argv) => {
    if (argv.includes("9090")) throw new Error("rule not found");
  });
  const results = await closeTailnetPorts({ ports: [8080, 9090], run, log: (m) => logs.push(m) });
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map((c) => c.argv), [...deleteRuleArgs(8080), ...deleteRuleArgs(9090)]);
  assert.deepEqual(results, [
    { port: 8080, action: "closed" },
    { port: 9090, action: "failed" },
  ]);
  assert.deepEqual(logs, [LOG_LINE_CLOSED(8080), LOG_LINE_CLOSE_FAILED(9090)]);
});

test("closeTailnetPorts: an absent manifest.ports list runs nothing", async () => {
  const { calls, run } = recorder();
  const logs = [];
  assert.deepEqual(await closeTailnetPorts({ run, log: (m) => logs.push(m) }), []);
  assert.equal(calls.length, 0);
  assert.deepEqual(logs, []);
});