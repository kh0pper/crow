/**
 * The hostile fixture inside a real bubblewrap wall (plan Step 2; the review's
 * hostile tests 1-6): a scratch home with the operator's files, this instance's
 * registry and keychain key, another add-on's data, a docker socket, a unix
 * socket in the Crow home, two scratch HTTP servers and a listener nothing
 * lists.
 *
 * The wall is built through `createWallContext` with the REAL wrap/plan/relay/
 * probe chain, and the add-on is connected with an SDK client over
 * `AddonStdioTransport`. The last section reads the wall's fds from the host
 * side (`/proc`), because a process cannot judge its own inherited fds: node
 * opens its event loop before any user code runs.
 *
 * Skips when bubblewrap cannot run here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import {
  cpSync, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync,
  readdirSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { probePiSandbox, _resetPiSandboxForTest } from "../scripts/pi-bots/pi_sandbox.mjs";
import { addonWallMode } from "../scripts/addon-sandbox/spawn.mjs";
import { createWallContext } from "../scripts/addon-sandbox/gateway-wall.mjs";
import { AddonStdioTransport } from "../scripts/addon-sandbox/transport.mjs";

const REPO = realpathSync(join(import.meta.dirname, ".."));
_resetPiSandboxForTest();
const SANDBOX = probePiSandbox({ force: true });
const skip = SANDBOX.ok ? false : "bubblewrap unavailable: " + SANDBOX.reason;

const ID = "addon-hostile";

/** Resolve once `check()` is true, or fail after `ms`. */
function waitFor(check, ms = 5000, what = "condition") {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = () => {
      let ok = false;
      try { ok = check(); } catch { ok = false; }
      if (ok) return resolve();
      if (Date.now() > deadline) return reject(new Error("timed out waiting for " + what));
      setTimeout(tick, 20);
    };
    tick();
  });
}

/** Every descendant of `pid` (not `pid` itself) through /proc, or [] when it is gone. */
function descendantsOf(pid) {
  const out = [];
  const stack = [pid];
  const seen = new Set([pid]);
  while (stack.length) {
    const p = stack.pop();
    let tids = [];
    try { tids = readdirSync(`/proc/${p}/task`); } catch { continue; }
    for (const tid of tids) {
      let kids = "";
      try { kids = readFileSync(`/proc/${p}/task/${tid}/children`, "utf8"); } catch { continue; }
      for (const k of kids.split(/\s+/).filter(Boolean).map(Number)) {
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(k);
        stack.push(k);
      }
    }
  }
  return out;
}

/** The argv of one process, as one line, or "". */
function cmdlineOf(pid) {
  try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" "); } catch { return ""; }
}

/** `dev:ino` of an open fd, or null when the number is not exposed. */
function fdIdentityOf(socket) {
  const fd = Number.isInteger(socket?.fd) ? socket.fd : (Number.isInteger(socket?._handle?.fd) ? socket._handle.fd : null);
  if (fd === null) return null;
  try {
    const st = fstatSync(fd);
    return `${st.dev}:${st.ino}`;
  } catch {
    return null;
  }
}

/** An HTTP server that answers 200 to everything, on 127.0.0.1. */
function httpServerOk() {
  return new Promise((resolve) => {
    const server = createHttpServer((req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

/** A unix-socket listener that counts what reaches it. */
function unixListener(path, accepts, key) {
  const server = createNetServer((socket) => { accepts[key] += 1; socket.destroy(); });
  server.listen(path);
  return server;
}

async function buildRig() {
  const T = realpathSync(mkdtempSync(join(tmpdir(), "addon-wall-int-")));
  const home = join(T, "home");
  const crowHome = join(home, ".crow");
  const dataDir = join(crowHome, "data");

  // The operator's own files, and this instance's.
  mkdirSync(join(home, "crow"), { recursive: true });
  writeFileSync(join(home, "crow", ".env"), "FIXTURE_VALUE=1\n");
  mkdirSync(join(home, ".ssh"), { recursive: true });
  writeFileSync(join(home, ".ssh", "id_ed25519"), "fixture key\n");
  mkdirSync(join(crowHome, "secrets"), { recursive: true });
  writeFileSync(join(crowHome, "secrets", "keychain.key"), "fixture key material\n");
  writeFileSync(join(crowHome, "mcp-addons.json"), JSON.stringify({}), { mode: 0o600 });

  // The add-on's own installed copy, another add-on's code cache, and the data dir.
  cpSync(join(REPO, "tests", "fixtures", "addon-hostile"), join(crowHome, "bundles", ID), { recursive: true });
  mkdirSync(join(crowHome, "bundles", "other", ".cache"), { recursive: true });
  writeFileSync(join(crowHome, "bundles", "other", ".cache", "x"), "other add-on\n");
  mkdirSync(join(dataDir, ID), { recursive: true, mode: 0o700 });
  mkdirSync(join(dataDir, "other", ".cache"), { recursive: true });
  writeFileSync(join(dataDir, "other", ".cache", "x"), "other add-on\n");

  // Two unix sockets nothing should reach, one of them inside the Crow home.
  const accepts = { dockerSock: 0, homeSock: 0, third: 0 };
  const dockerSockPath = join(T, "docker.sock");
  const homeSockPath = join(crowHome, "x.sock");
  const dockerSock = unixListener(dockerSockPath, accepts, "dockerSock");
  const homeSock = unixListener(homeSockPath, accepts, "homeSock");

  // The namespace's own listener that is not in any profile.
  const third = createNetServer((socket) => { accepts.third += 1; socket.destroy(); });
  await new Promise((resolve) => third.listen(0, "127.0.0.1", resolve));
  const thirdPort = third.address().port;

  // The "gateway" (answers 200 to everything; the relay refuses before it is reached)
  // and the owner-set service HOSTILE_URL names.
  const gateway = await httpServerOk();
  const service = await httpServerOk();

  // A scratch file this test holds open: no walled process may hold the same one.
  const logPath = join(T, "gateway.log");
  writeFileSync(logPath, "");
  const logFd = openSync(logPath, "a");

  const ctx = createWallContext({
    crowHome,
    appRoot: REPO,
    dataDir,
    home,
    nodeBin: process.execPath,
    gatewayPort: gateway.port,
    gatewayEnv: {},
    deps: {
      dockerView: () => ({
        snapshot: async () => ({ publishes: [], containers: [], subnets: [], addonProjects: new Map() }),
      }),
      tailscaleStatus: async () => null,
      identifyListener: async () => ({ kind: "own-uid" }),
    },
  });

  const entry = {
    command: "node",
    args: ["server/index.js"],
    env: {
      HOSTILE_ENV_FILE: join(home, "crow", ".env"),
      HOSTILE_ADDONS_FILE: join(crowHome, "mcp-addons.json"),
      HOSTILE_URL: "http://localhost:" + service.port,
      // The gateway's own port must be in the plan's listeners for the relay's
      // door refusal to be the answer a probe gets there.
      HOSTILE_GATEWAY_URL: "http://localhost:" + gateway.port + "/health",
    },
    ownerSet: ["HOSTILE_ENV_FILE", "HOSTILE_ADDONS_FILE", "HOSTILE_URL", "HOSTILE_GATEWAY_URL"],
  };

  const wall = await ctx.startAddonWall({
    id: ID,
    entry,
    command: process.execPath,
    args: ["server/index.js"],
    env: { PATH: process.env.PATH, HOME: home },
    kind: "addon",
  });
  assert.equal(wall.walled, true, "the wall was built (bwrap ran)");
  await wall.relay?.ready?.catch?.(() => {});

  // The seccomp program's identity, read while its host fd is still ours.
  let seccompId = null;
  const seccompEntry = wall.stdioExtra.find((e) => e.role === "seccomp");
  if (seccompEntry && Number.isInteger(seccompEntry.fd)) {
    try {
      const st = fstatSync(seccompEntry.fd);
      seccompId = `${st.dev}:${st.ino}`;
    } catch { seccompId = null; }
  }

  const logged = [];
  let exitCalls = 0;
  const transport = new AddonStdioTransport({
    id: ID,
    command: wall.cmd,
    args: wall.args,
    env: wall.env,
    stdioExtra: wall.stdioExtra,
    onExit: () => {
      exitCalls += 1;
      try { wall.cleanup(); } catch { /* nothing left to close */ }
    },
    log: (line) => logged.push(line),
  });
  const client = new Client({ name: "addon-wall-integration", version: "1.0.0" });
  await client.connect(transport);

  async function call(name, args = {}) {
    const result = await client.callTool({ name, arguments: args });
    const text = result?.content?.[0]?.text;
    return JSON.parse(String(text));
  }

  /** bwrap's `--info-fd` line, then the wall's pids as the host sees them. */
  async function wallPids() {
    const info = transport.extraStreams.info;
    assert.ok(info, "the info pipe");
    let text = "";
    info.on("data", (chunk) => { text += chunk.toString("utf8"); });
    await waitFor(() => /"child-pid"\s*:\s*\d+/.test(text), 5000, "bwrap's info line");
    const initPid = Number(/"child-pid"\s*:\s*(\d+)/.exec(text)[1]);
    const all = [initPid, ...descendantsOf(initPid)];
    const addonPid = all.find((p) => cmdlineOf(p).includes("server/index.js")) || null;
    return { initPid, all, addonPid, info };
  }

  return {
    T, home, crowHome, dataDir, gateway, service, third, thirdPort,
    dockerSock, homeSock, dockerSockPath, homeSockPath, accepts, logFd, logPath,
    ctx, entry, wall, transport, client, call, wallPids, logged, seccompId,
    exitCalls: () => exitCalls,
  };
}

async function teardown(rig) {
  try { await rig.client?.close?.(); } catch { /* already gone */ }
  try { await rig.transport?.close?.(); } catch { /* already gone */ }
  try { await rig.wall?.cleanup?.(); } catch { /* nothing left to close */ }
  try { closeSync(rig.logFd); } catch { /* already closed */ }
  for (const s of [rig.gateway?.server, rig.service?.server, rig.third, rig.dockerSock, rig.homeSock]) {
    try { s?.close?.(); } catch { /* already closed */ }
  }
  rmSync(rig.T, { recursive: true, force: true });
}

test("a walled hostile add-on reaches nothing it was not given", { skip, timeout: 120_000 }, async (t) => {
  const rig = await buildRig();
  try {
    const pids = await rig.wallPids();
    assert.ok(pids.addonPid, "the add-on's own process, found from the host side");

    await t.test("the operator's files, this instance's registry and the keychain key are unreadable", async () => {
      for (const path of [
        join(rig.crowHome, "mcp-addons.json"),
        join(rig.home, "crow", ".env"),
        join(rig.crowHome, "secrets", "keychain.key"),
        join(rig.home, ".ssh", "id_ed25519"),
        "/var/run/docker.sock",
      ]) {
        const result = await rig.call("probe_read", { path });
        assert.equal(result.ok, false, "an add-on opened " + path);
      }
    });

    await t.test("its own code is read-only, another add-on's data is out of reach, its own folder is writable", async () => {
      const code = await rig.call("probe_write", { path: join(rig.crowHome, "bundles", ID, "server", "x") });
      assert.equal(code.ok, false);
      assert.equal(code.code, "EROFS");
      assert.equal((await rig.call("probe_write", { path: join(rig.dataDir, "other", ".cache", "x") })).ok, false);
      assert.equal((await rig.call("probe_write", { path: join(rig.dataDir, ID, "ok") })).ok, true);
    });

    await t.test("unix sockets are out of reach and neither listener sees a connection", async () => {
      for (const path of [rig.dockerSockPath, rig.homeSockPath, "/var/run/docker.sock"]) {
        assert.equal((await rig.call("probe_unix", { path })).ok, false);
      }
      assert.equal(rig.accepts.dockerSock, 0);
      assert.equal(rig.accepts.homeSock, 0);
    });

    await t.test("no database is bound", async () => {
      assert.equal((await rig.call("probe_sql")).code, "NO_DB");
    });

    await t.test("a listener outside the profile is refused, the gateway port gets the door refusal, the owner's service answers", async () => {
      assert.equal((await rig.call("probe_connect", { host: "127.0.0.1", port: rig.thirdPort })).ok, false);
      assert.equal(rig.accepts.third, 0);
      const door = await rig.call("probe_http", { url: "http://127.0.0.1:" + rig.gateway.port + "/health" });
      assert.equal(door.status, 403);
      const own = await rig.call("probe_http", { url: "http://localhost:" + rig.service.port });
      assert.equal(own.status, 200);
    });

    await t.test("the fixture's stderr line arrives through the prefixer", async () => {
      await waitFor(() => rig.logged.includes("[addon:addon-hostile] hostile-started"), 5000, "the prefixed stderr line");
    });

    await t.test("no host fd reaches the add-on", async () => {
      // Every identity the wall's own machinery holds, from the host side.
      const forbidden = new Set();
      if (rig.seccompId) forbidden.add(rig.seccompId);
      const infoId = fdIdentityOf(pids.info);
      if (infoId) forbidden.add(infoId);
      // bwrap itself still holds the info pipe (fd 4); a pipe's two ends share one inode.
      try {
        const st = statSync(`/proc/${rig.transport.pid}/fd/4`);
        forbidden.add(`${st.dev}:${st.ino}`);
      } catch { /* bwrap already closed it */ }
      try {
        const st = statSync(rig.wall.relay.socketPath);
        forbidden.add(`${st.dev}:${st.ino}`);
      } catch { /* the relay is already down */ }
      try {
        const st = fstatSync(rig.logFd);
        forbidden.add(`${st.dev}:${st.ino}`);
      } catch { /* the scratch file is gone */ }

      const fdDir = `/proc/${pids.addonPid}/fd`;
      const ownData = join(realpathSync(rig.dataDir), ID);
      const offenders = [];
      for (const name of readdirSync(fdDir)) {
        let st = null;
        let link = "";
        try { st = statSync(`${fdDir}/${name}`); } catch { continue; }
        try { link = String(readlinkSync(`${fdDir}/${name}`)); } catch { link = ""; }
        if (forbidden.has(`${st.dev}:${st.ino}`)) offenders.push(`fd ${name} -> ${link}`);
        if (link.startsWith(rig.dataDir + "/") && link !== ownData && !link.startsWith(ownData + "/")) {
          offenders.push(`fd ${name} -> ${link}`);
        }
      }
      assert.deepEqual(offenders, [], "the add-on holds a host fd");
    });

    await t.test("its process list is the wall's own", async () => {
      const result = await rig.call("probe_pids");
      assert.equal(result.ok, true);
      const visible = result.pids.map((p) => p.pid);
      assert.equal(visible.includes(process.pid), false, "this test process is not visible inside the wall");
      assert.ok(visible.length >= 1 && visible.length <= 4, "the wall runs a handful of processes, not the host's");
      const comms = result.pids.map((p) => p.comm).filter((c) => typeof c === "string");
      // Node 24 names its main thread "MainThread", and /proc/<pid>/comm reads that.
      for (const comm of comms) assert.match(comm, /^(bwrap|node|MainThread|sh|cat|ls)$/);
    });

    await t.test("after the fixture exits its cleanup runs, nothing survives, and the mode is unchanged", async () => {
      const before = [pids.initPid, ...descendantsOf(pids.initPid)];
      await assert.rejects(rig.call("crash"));
      await waitFor(() => rig.exitCalls() >= 1, 5000, "the transport's onExit");

      const previous = process.env.CROW_ADDON_WALLS_DEFAULT;
      process.env.CROW_ADDON_WALLS_DEFAULT = "walled";
      try {
        assert.equal(addonWallMode({ id: ID, gatewayEnv: process.env, crowHome: rig.crowHome }).mode, "walled");
      } finally {
        if (previous === undefined) delete process.env.CROW_ADDON_WALLS_DEFAULT;
        else process.env.CROW_ADDON_WALLS_DEFAULT = previous;
      }

      await waitFor(() => before.every((pid) => !existsSync(`/proc/${pid}`)), 5000, "the wall's processes to be gone");
    });
  } finally {
    await teardown(rig);
  }
});