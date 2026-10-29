/**
 * Item 46 PR-B (B6): the signing relay authenticates its caller as the MAIN
 * process of a live, installed (not transient) bot host unit of the configured
 * systemd manager, by the socket the connecting process holds, its cgroup and
 * its start time. Real processes and real /proc for the socket, fds, cgroup
 * and start time; the systemd unit list and the instance config file are
 * injected.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  createBotHostCallerResolver, parseSystemctlShow, isBotHostUnit, unitTemplate, BOT_HOST_UNIT_PATTERNS,
  configuredManager, parseEnvFile, hostDbPathFromEnv,
} from "../servers/gateway/bot-host-caller.js";

const kids = [];
after(() => { for (const k of kids) { try { process.kill(-k.pid, "SIGKILL"); } catch { try { k.kill("SIGKILL"); } catch {} } } });

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

/** A child node process that (via a grandchild when `viaGrandchild`) connects and holds the socket. */
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

const realCgroup = (pid) => readFileSync(`/proc/${pid}/cgroup`, "utf8").split("\n").find((l) => l.startsWith("0::")).slice(3);
const ENV_OK = { isFile: true, uid: 0, mode: 0o100644, text: "CROW_HOME=/srv/alpha\nCROW_DATA_DIR=/srv/alpha/data\nCROW_DB_PATH=/srv/alpha/data/crow.db\n" };

/** A unit record as systemctl show reports a correctly installed system template unit. */
function unit(pid, over = {}) {
  return {
    unit: "pibot-bridge@alpha.service", pid, state: "activating", transient: "no",
    fragment: "/etc/systemd/system/pibot-bridge@.service", cgroup: realCgroup(pid),
    envFiles: ["/etc/crow/pibot-alpha.env"], ...over,
  };
}
function resolver(units, over = {}) {
  return createBotHostCallerResolver({
    manager: "system", listUnits: async () => (typeof units === "function" ? units() : units),
    readEnvFile: () => ENV_OK, ...over,
  });
}

test("the unit patterns, name filter and template mapping cover exactly the bot host templates", () => {
  assert.deepEqual([...BOT_HOST_UNIT_PATTERNS], ["pibot-bridge@*.service", "pibot-gateways@*.service", "pibot-discord@*.service", "pibot-discord.service"]);
  for (const u of ["pibot-bridge@alpha.service", "pibot-gateways@r4.service", "pibot-discord@alpha.service", "pibot-discord.service"]) assert.equal(isBotHostUnit(u), true, u);
  for (const u of ["crow-gateway.service", "pibot-bridge@alpha.timer", "pibot-bridge@.service", "xpibot-bridge@a.service", "pibot-bridge@a.service.evil", "pibot-bridge@a b.service"]) assert.equal(isBotHostUnit(u), false, u);
  assert.deepEqual(unitTemplate("pibot-gateways@r4.service"), { template: "gateways", instance: "r4", templateFile: "pibot-gateways@.service" });
  assert.deepEqual(unitTemplate("pibot-discord.service"), { template: "discord", instance: null, templateFile: "pibot-discord.service" });
});

test("the manager is configuration (system by default), never probed", () => {
  assert.equal(configuredManager({}), "system");
  assert.equal(configuredManager({ CROW_BOT_HOST_MANAGER: "user" }), "user");
  assert.equal(configuredManager({ CROW_BOT_HOST_MANAGER: "both" }), "system");
  const asked = [];
  const r = createBotHostCallerResolver({ manager: "system", listUnits: async (m) => { asked.push(m); return []; } });
  return r._candidates().then(() => { assert.deepEqual(asked, ["system"], "only the configured manager is asked"); assert.equal(r.manager, "system"); });
});

test("parseSystemctlShow reads every property block, EnvironmentFiles without its flag", () => {
  const text = "MainPID=1234\nControlGroup=/system.slice/system-pibot\\x2dgateways.slice/pibot-gateways@r4.service\nEnvironmentFiles=/etc/crow/pibot-r4.env (ignore_errors=no)\nId=pibot-gateways@r4.service\nFragmentPath=/etc/systemd/system/pibot-gateways@.service\nTransient=no\nActiveState=active\n\nId=pibot-bridge@r4.service\nMainPID=0\nActiveState=inactive\n";
  assert.deepEqual(parseSystemctlShow(text), [
    { unit: "pibot-gateways@r4.service", pid: 1234, state: "active", transient: "no", fragment: "/etc/systemd/system/pibot-gateways@.service",
      cgroup: "/system.slice/system-pibot\\x2dgateways.slice/pibot-gateways@r4.service", envFiles: ["/etc/crow/pibot-r4.env"] },
    { unit: "pibot-bridge@r4.service", pid: 0, state: "inactive", transient: "", fragment: "", cgroup: "", envFiles: [] },
  ]);
  assert.deepEqual(parseSystemctlShow(""), []);
});

test("instance config: KEY=VALUE parsing and the database it names", () => {
  assert.deepEqual(parseEnvFile("# c\nA=1\nB=\"two words\"\n\nC='x'\n"), { A: "1", B: "two words", C: "x" });
  assert.equal(hostDbPathFromEnv({ CROW_DB_PATH: "/srv/a/data/crow.db" }), "/srv/a/data/crow.db");
  assert.equal(hostDbPathFromEnv({ CROW_DATA_DIR: "/srv/a/data" }), "/srv/a/data/crow.db");
  assert.equal(hostDbPathFromEnv({}), null);
});

test("the installed template unit's main process is accepted, with its template, instance and database", { timeout: 30_000 }, async () => {
  const s = await server();
  try {
    const { pids } = connector(s.port);
    const [sock, p] = await Promise.all([s.next(), pids]);
    const ok = await resolver([unit(p.connector)]).authenticate(sock);
    assert.deepEqual(ok, { ok: true, unit: "pibot-bridge@alpha.service", pid: p.connector, template: "bridge", instance: "alpha", hostDbPath: "/srv/alpha/data/crow.db" }, "positive control");
    for (const dir of ["/lib/systemd/system", "/usr/lib/systemd/system"]) {
      assert.equal((await resolver([unit(p.connector, { fragment: `${dir}/pibot-bridge@.service` })]).authenticate(sock)).ok, true, dir);
    }
    sock.destroy();
  } finally { await s.close(); }
});

test("look-alikes are refused: transient, foreign fragment, wrong template file, wrong cgroup, bad instance config", { timeout: 30_000 }, async () => {
  const s = await server();
  try {
    const { pids } = connector(s.port);
    const [sock, p] = await Promise.all([s.next(), pids]);
    const pid = p.connector;
    assert.equal((await resolver([unit(pid)]).authenticate(sock)).ok, true, "positive control in the same harness");
    const cases = {
      "a transient unit (systemd-run --unit=pibot-bridge@alpha)": unit(pid, { transient: "yes" }),
      "Transient unknown": unit(pid, { transient: "" }),
      "a fragment under the user's own unit dir": unit(pid, { fragment: "/home/alex/.config/systemd/user/pibot-bridge@.service" }),
      "a fragment under /run (generated)": unit(pid, { fragment: "/run/systemd/transient/pibot-bridge@alpha.service" }),
      "a fragment path with ..": unit(pid, { fragment: "/etc/systemd/system/../../tmp/pibot-bridge@.service" }),
      "the gateways template file for a bridge unit": unit(pid, { fragment: "/etc/systemd/system/pibot-gateways@.service" }),
      "an instance-specific fragment, not the template": unit(pid, { fragment: "/etc/systemd/system/pibot-bridge@alpha.service" }),
      "another unit's cgroup": unit(pid, { cgroup: "/system.slice/system-pibot\\x2dbridge.slice/pibot-bridge@bravo.service" }),
      "no environment file": unit(pid, { envFiles: [] }),
      "another instance's environment file": unit(pid, { envFiles: ["/etc/crow/pibot-bravo.env"] }),
      "an environment file outside /etc/crow": unit(pid, { envFiles: ["/home/alex/pibot-alpha.env"] }),
      "inactive": unit(pid, { state: "inactive" }),
      "not a bot host unit": unit(pid, { unit: "crow-gateway.service", fragment: "/etc/systemd/system/crow-gateway.service" }),
    };
    for (const [name, u] of Object.entries(cases)) {
      const r = await resolver([u]).authenticate(sock);
      assert.equal(r.ok, false, name);
    }
    for (const [name, ef] of Object.entries({
      "config not owned by root": { ...ENV_OK, uid: 1000 },
      "config group-writable": { ...ENV_OK, mode: 0o100664 },
      "config world-writable": { ...ENV_OK, mode: 0o100646 },
      "config names no database": { ...ENV_OK, text: "CROW_HOME=/srv/alpha\n" },
      "config not a file": { ...ENV_OK, isFile: false },
    })) {
      assert.equal((await resolver([unit(pid)], { readEnvFile: () => ef }).authenticate(sock)).ok, false, name);
    }
    sock.destroy();
  } finally { await s.close(); }
});

test("user mode accepts only the configured user unit dir, and system mode never does", { timeout: 30_000 }, async () => {
  const s = await server();
  try {
    const { pids } = connector(s.port);
    const [sock, p] = await Promise.all([s.next(), pids]);
    const userFrag = { fragment: "/home/alex/.config/systemd/user/pibot-bridge@.service" };
    const user = (u) => createBotHostCallerResolver({ manager: "user", userUnitDir: "/home/alex/.config/systemd/user", listUnits: async () => [u], readEnvFile: () => ENV_OK });
    assert.equal((await user(unit(p.connector, userFrag)).authenticate(sock)).ok, true, "user mode, user unit dir");
    assert.equal((await user(unit(p.connector)).authenticate(sock)).ok, false, "user mode does not also take system dirs");
    assert.equal((await user(unit(p.connector, { ...userFrag, transient: "yes" })).authenticate(sock)).ok, false, "still never transient");
    assert.equal((await resolver([unit(p.connector, userFrag)]).authenticate(sock)).ok, false, "system mode refuses a user fragment");
    sock.destroy();
  } finally { await s.close(); }
});

test("another pid, a grandchild, or a recycled pid is not the unit's main process", { timeout: 30_000 }, async () => {
  const s = await server();
  try {
    const { pids } = connector(s.port, { viaGrandchild: true });
    const [sock, p] = await Promise.all([s.next(), pids]);
    assert.ok(p.parent && p.parent !== p.connector);
    assert.equal((await resolver([unit(p.parent)]).authenticate(sock)).ok, false, "a child in the unit's cgroup has another pid");
    assert.equal((await resolver([unit(process.pid)]).authenticate(sock)).ok, false, "this process holds the server end only");
    assert.equal((await resolver([unit(p.connector)]).authenticate(sock)).ok, true, "same harness: the connecting pid itself would pass");
    // Pid reuse: the start time seen at list time no longer matches.
    let calls = 0;
    const recycled = resolver([unit(p.connector)], { readStartTime: () => String(++calls === 1 ? 111 : 222) });
    assert.equal((await recycled.authenticate(sock)).ok, false, "a pid whose start time changed since the list was read");
    sock.destroy();
  } finally { await s.close(); }
});

test("anything unresolvable refuses: no /proc/net, no systemd, no unit, unreadable descriptors, no socket", { timeout: 30_000 }, async () => {
  const s = await server();
  try {
    const { pids } = connector(s.port);
    const [sock, p] = await Promise.all([s.next(), pids]);
    const good = [unit(p.connector)];
    assert.equal((await resolver(good).authenticate(sock)).ok, true, "positive control");
    const cases = {
      "no /proc/net": resolver(good, { readProcNet: () => { throw new Error("ENOENT"); } }),
      "no systemd": resolver(() => { throw new Error("systemctl: not found"); }),
      "empty unit list": resolver([]),
      "fds unreadable": resolver(good, { readFdLinks: () => { throw new Error("EACCES"); } }),
      "cgroup unreadable": resolver(good, { readCgroups: () => { throw new Error("EACCES"); } }),
      "config unreadable": resolver(good, { readEnvFile: () => { throw new Error("EACCES"); } }),
    };
    for (const [name, r] of Object.entries(cases)) {
      const out = await r.authenticate(sock);
      assert.equal(out.ok, false, name);
      assert.equal(typeof out.reason, "string", name);
    }
    assert.equal((await resolver(good).authenticate(null)).ok, false);
    sock.destroy();
  } finally { await s.close(); }
});

test("the unit list is cached, single-flight, and its refresh is rate-limited", async () => {
  let t = 1_000_000, calls = 0, release;
  let gate = null;
  const r = createBotHostCallerResolver({
    manager: "system", now: () => t,
    listUnits: async () => { calls++; if (gate) await gate; return []; },
  });
  await r._candidates(); await r._candidates();
  assert.equal(calls, 1, "cached");
  t += 5_001;
  gate = new Promise((res) => { release = res; });
  const burst = Array.from({ length: 50 }, () => r._candidates({ refresh: true }));
  assert.equal(calls, 2, "a burst of concurrent refreshes forks one read");
  release(); gate = null;
  await Promise.all(burst);
  await r._candidates({ refresh: true });
  assert.equal(calls, 2, "a refresh within the minimum interval reuses the list");
  t += 600;
  await r._candidates({ refresh: true });
  assert.equal(calls, 3);
  // A failing read is stamped too: no retry storm.
  const f = createBotHostCallerResolver({ manager: "system", now: () => t, listUnits: async () => { calls++; throw new Error("down"); } });
  const before = calls;
  await assert.rejects(f._candidates());
  await assert.rejects(f._candidates());
  assert.equal(calls - before, 1, "one failing read per interval");
});
