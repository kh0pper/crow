/**
 * Item 46 PR-B (B6): the signing relay authenticates its caller as the MAIN
 * process of a live pibot-bridge@ / pibot-gateways@ / pibot-discord@ unit,
 * by the socket the connecting process holds. Real processes, real /proc;
 * only the systemd unit list is injected.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { spawn } from "node:child_process";
import {
  createBotHostCallerResolver, parseSystemctlShow, isBotHostUnit, BOT_HOST_UNIT_PATTERNS,
} from "../servers/gateway/bot-host-caller.js";

const kids = [];
after(() => { for (const k of kids) { try { process.kill(-k.pid, "SIGKILL"); } catch { try { k.kill("SIGKILL"); } catch {} } } });

/** A loopback server; resolves each accepted socket in order. */
async function server() {
  const queue = [];
  const waiters = [];
  const srv = net.createServer((sock) => { const w = waiters.shift(); if (w) w(sock); else queue.push(sock); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return {
    port: srv.address().port,
    next: () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => waiters.push(r))),
    close: () => new Promise((r) => srv.close(() => r())),
  };
}

/** A child node process that (via a grandchild when `viaGrandchild`) connects and holds the socket. Prints pids. */
function connector(port, { viaGrandchild = false } = {}) {
  const connect = `const s=require("net").connect(${port},"127.0.0.1",()=>console.log("PID "+process.pid));setInterval(()=>{},1e6);`;
  const code = viaGrandchild
    ? `const c=require("child_process").spawn(process.execPath,["-e",${JSON.stringify(connect)}],{stdio:["ignore","inherit","inherit"]});console.log("PARENT "+process.pid);setInterval(()=>{},1e6);`
    : connect;
  const child = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "pipe"], detached: true });
  kids.push(child);
  let out = "";
  const pids = new Promise((resolve, reject) => {
    child.stdout.on("data", (d) => {
      out += d;
      const m = out.match(/(?:^|\n)PID (\d+)/);
      if (m && (!viaGrandchild || /PARENT \d+/.test(out))) resolve({ connector: Number(m[1]), parent: Number((out.match(/PARENT (\d+)/) || [])[1]) || null });
    });
    child.once("exit", (c) => reject(new Error("connector exited " + c)));
  });
  return { child, pids };
}

const units = (...entries) => async () => entries;

test("the unit patterns and name filter cover exactly the bot host templates", () => {
  assert.deepEqual([...BOT_HOST_UNIT_PATTERNS], ["pibot-bridge@*.service", "pibot-gateways@*.service", "pibot-discord@*.service", "pibot-discord.service"]);
  for (const u of ["pibot-bridge@alpha.service", "pibot-gateways@r4.service", "pibot-discord@alpha.service", "pibot-discord.service"]) assert.equal(isBotHostUnit(u), true, u);
  for (const u of ["crow-gateway.service", "pibot-bridge@alpha.timer", "pibot-bridge@.service", "xpibot-bridge@a.service", "pibot-bridge@a.service.evil", "pibot-bridge@a b.service"]) assert.equal(isBotHostUnit(u), false, u);
});

test("parseSystemctlShow reads systemctl's blank-line-separated blocks", () => {
  const text = "MainPID=1234\nId=pibot-gateways@r4.service\nActiveState=active\n\nMainPID=0\nId=pibot-bridge@r4.service\nActiveState=inactive\n\nId=pibot-bridge@alpha.service\nActiveState=activating\nMainPID=77\n";
  assert.deepEqual(parseSystemctlShow(text), [
    { unit: "pibot-gateways@r4.service", pid: 1234, state: "active" },
    { unit: "pibot-bridge@r4.service", pid: 0, state: "inactive" },
    { unit: "pibot-bridge@alpha.service", pid: 77, state: "activating" },
  ]);
  assert.deepEqual(parseSystemctlShow(""), []);
});

test("the unit's main process is authenticated; another pid, a dead unit or another unit name is not", { timeout: 30_000 }, async () => {
  const s = await server();
  try {
    const { pids } = connector(s.port);
    const [sock, p] = await Promise.all([s.next(), pids]);
    const ok = await createBotHostCallerResolver({ listUnits: units({ unit: "pibot-bridge@alpha.service", pid: p.connector, state: "activating" }) }).authenticate(sock);
    assert.deepEqual(ok, { ok: true, unit: "pibot-bridge@alpha.service", pid: p.connector }, "positive control");
    const other = await createBotHostCallerResolver({ listUnits: units({ unit: "pibot-bridge@alpha.service", pid: process.pid, state: "active" }) }).authenticate(sock);
    assert.equal(other.ok, false, "this test process holds the server end, not the client socket");
    const dead = await createBotHostCallerResolver({ listUnits: units({ unit: "pibot-bridge@alpha.service", pid: p.connector, state: "inactive" }) }).authenticate(sock);
    assert.equal(dead.ok, false, "an inactive unit's stale MainPID never counts");
    const wrongUnit = await createBotHostCallerResolver({ listUnits: units({ unit: "crow-gateway.service", pid: p.connector, state: "active" }) }).authenticate(sock);
    assert.equal(wrongUnit.ok, false, "only bot host units");
    sock.destroy();
  } finally { await s.close(); }
});

test("a grandchild that connects is not its parent unit's main process", { timeout: 30_000 }, async () => {
  const s = await server();
  try {
    const { pids } = connector(s.port, { viaGrandchild: true });
    const [sock, p] = await Promise.all([s.next(), pids]);
    assert.ok(p.parent && p.parent !== p.connector);
    const asParent = await createBotHostCallerResolver({ listUnits: units({ unit: "pibot-gateways@alpha.service", pid: p.parent, state: "active" }) }).authenticate(sock);
    assert.equal(asParent.ok, false, "a child in the unit's cgroup has another pid");
    const asSelf = await createBotHostCallerResolver({ listUnits: units({ unit: "pibot-gateways@alpha.service", pid: p.connector, state: "active" }) }).authenticate(sock);
    assert.equal(asSelf.ok, true, "same harness: the connecting pid itself would pass");
    sock.destroy();
  } finally { await s.close(); }
});

test("anything unresolvable refuses: no /proc/net, no unit list, unreadable descriptors, no socket", { timeout: 30_000 }, async () => {
  const s = await server();
  try {
    const { pids } = connector(s.port);
    const [sock, p] = await Promise.all([s.next(), pids]);
    const good = { unit: "pibot-bridge@alpha.service", pid: p.connector, state: "active" };
    const base = { listUnits: units(good) };
    assert.equal((await createBotHostCallerResolver(base).authenticate(sock)).ok, true, "positive control");
    const cases = {
      "no /proc/net": { ...base, readProcNet: () => { throw new Error("ENOENT"); } },
      "no systemd": { listUnits: async () => { throw new Error("systemctl: not found"); } },
      "empty unit list": { listUnits: units() },
      "fds unreadable": { ...base, readFdLinks: () => { throw new Error("EACCES"); } },
    };
    for (const [name, opts] of Object.entries(cases)) {
      const r = await createBotHostCallerResolver(opts).authenticate(sock);
      assert.equal(r.ok, false, name);
      assert.equal(typeof r.reason, "string", name);
    }
    assert.equal((await createBotHostCallerResolver(base).authenticate(null)).ok, false);
    sock.destroy();
  } finally { await s.close(); }
});

test("the unit list is cached, and a miss refreshes it (rate-limited)", async () => {
  let t = 1_000_000, calls = 0, list = [];
  const r = createBotHostCallerResolver({
    now: () => t,
    listUnits: async () => { calls++; return list; },
    readProcNet: () => "", // no row: every authenticate misses after the unit lookup
  });
  // The unit list is only read once a socket inode is known; drive the cache directly.
  await r._candidates(); await r._candidates();
  assert.equal(calls, 1, "cached");
  t += 5_001;
  await r._candidates();
  assert.equal(calls, 2, "expired");
  await r._candidates({ refresh: true });
  assert.equal(calls, 2, "a refresh within the minimum interval reuses the list");
  t += 600;
  await r._candidates({ refresh: true });
  assert.equal(calls, 3);
});
