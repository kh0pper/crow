/**
 * Containment PR 6, layer 2 at the caller check (bot-host-caller.js): a socket
 * the egress relay opened is refused BEFORE anything reads /proc.
 *
 * The hole this closes, in this file's own terms: the relay used to splice a
 * contained bot's connection to the gateway port, so the socket's inode sat in
 * the spawner process — for `pibot-gateways@` a bot host's MainPID — and steps
 * (1)-(3) of the caller check authenticated it. A contained bot's only path to
 * loopback is that relay, so marking the relay's sockets is enough to tell the
 * two apart: this test process is the unit's MainPID, and it accepts a socket
 * twice — once from a plain loopback client (the hole) and once from a client
 * bound to the relay mark (refused).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { readFileSync } from "node:fs";

import { createBotHostCallerResolver } from "../servers/gateway/bot-host-caller.js";
import { RELAY_SOURCE_V4 } from "../servers/shared/bot-doors.js";

// This test process plays the bot host's main process: the unit record is the
// injected part; the socket, fds, cgroup and start time are this process's real
// ones (the seams tests/bot-host-caller.test.js uses).
const CGROUP = readFileSync(`/proc/${process.pid}/cgroup`, "utf8").split("\n").find((l) => l.startsWith("0::")).slice(3);
const ENV_OK = { isFile: true, uid: 0, mode: 0o100644, text: "CROW_DB_PATH=/srv/t/data/crow.db\n" };
const unit = () => ({
  unit: "pibot-gateways@t.service", pid: process.pid, state: "active", transient: "no",
  fragment: "/etc/systemd/system/pibot-gateways@.service", cgroup: CGROUP, envFiles: ["/etc/crow/pibot-t.env"],
});

/** One loopback connection whose client end is held by THIS process. */
async function pair(localAddress) {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const accepted = new Promise((r) => srv.once("connection", r));
  const client = net.connect({ host: "127.0.0.1", port: srv.address().port, localAddress });
  await new Promise((r, j) => { client.once("connect", r); client.once("error", j); });
  const serverSock = await accepted;
  return {
    client, serverSock,
    close: () => { try { client.destroy(); } catch {} try { serverSock.destroy(); } catch {} srv.close(); },
  };
}

test("the hole exists without the mark", async () => {
  const p = await pair("127.0.0.1");
  try {
    assert.equal(p.serverSock.remoteAddress, "127.0.0.1");
    const resolver = createBotHostCallerResolver({
      manager: "system", listUnits: async () => [unit()], readEnvFile: () => ENV_OK,
    });
    // The socket this process holds, and this process IS the unit's MainPID:
    // exactly what a spliced relay connection looked like.
    assert.deepEqual(await resolver.authenticate(p.serverSock), {
      ok: true, unit: "pibot-gateways@t.service", pid: process.pid, template: "gateways",
      instance: "t", hostDbPath: "/srv/t/data/crow.db",
    });
  } finally { p.close(); }
});

test("relayed socket refused", async () => {
  const p = await pair(RELAY_SOURCE_V4);
  try {
    assert.equal(p.serverSock.remoteAddress, RELAY_SOURCE_V4);
    let fdCalls = 0, netCalls = 0, listCalls = 0;
    const resolver = createBotHostCallerResolver({
      manager: "system",
      listUnits: async () => { listCalls++; return [unit()]; },
      readEnvFile: () => ENV_OK,
      readFdLinks: () => { fdCalls++; return []; },
      readProcNet: () => { netCalls++; throw new Error("/proc must not be read for a relayed socket"); },
    });
    assert.deepEqual(await resolver.authenticate(p.serverSock), { ok: false, reason: "relayed socket" });
    assert.deepEqual([fdCalls, netCalls, listCalls], [0, 0, 0], "refused before any /proc read or systemctl call");
  } finally { p.close(); }
});

test("the v4-mapped spelling of the mark is refused too", async () => {
  let fdCalls = 0;
  const resolver = createBotHostCallerResolver({
    manager: "system", listUnits: async () => [unit()], readEnvFile: () => ENV_OK,
    readFdLinks: () => { fdCalls++; return []; },
  });
  const out = await resolver.authenticate({ remoteAddress: "::ffff:" + RELAY_SOURCE_V4, localAddress: "::1", remotePort: 1, localPort: 2 });
  assert.deepEqual(out, { ok: false, reason: "relayed socket" });
  assert.equal(fdCalls, 0);
});