// S3 (2026-10-02): the pi sandbox — defense in depth that removes the casual
// docker/sudo routes from a bot's shell. It is NOT containment: the
// filesystem stays writable (see pi_sandbox.mjs "What it does not stop").
//
// The integration tests spawn real children through the sandbox and have
// them report what they can do. They run wherever bubblewrap works; checks
// that need something extra (the docker group, a running systemd user
// manager, a live tmux server) are asserted only where that precondition
// holds in the PARENT, so each assertion proves the sandbox took it away.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync, statSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { connect, createServer } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import {
  wrapPiSpawn, piSandboxMode, probePiSandbox, dockerSocketPaths, isSandboxWrapperArgs,
  scrubSandboxEnv, userRuntimeDirs, PROBE_RETRY_MS, _resetPiSandboxForTest,
} from "../scripts/pi-bots/pi_sandbox.mjs";
import { listBridgePi, reapStalePi } from "../scripts/pi-bots/pi_lifecycle.mjs";

const { PiRpc } = await import("../scripts/pi-bots/bridge.mjs");

function dockerGid() {
  try {
    const line = readFileSync("/etc/group", "utf8").split("\n").find((l) => l.startsWith("docker:"));
    return line ? Number(line.split(":")[2]) : null;
  } catch { return null; }
}

function canConnect(path) {
  return new Promise((resolve) => {
    const s = connect(path);
    const done = (v) => { try { s.destroy(); } catch {} resolve(v); };
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
    setTimeout(() => done(false), 2000);
  });
}

const UID = process.getuid();
const GID = dockerGid();
const PARENT_HAS_DOCKER = GID != null && process.getgroups().includes(GID);
const SOCKS = dockerSocketPaths();
_resetPiSandboxForTest();
const SANDBOX = probePiSandbox({ force: true });
const noSandbox = SANDBOX.ok ? false : "pi sandbox unavailable here: " + SANDBOX.reason;
const RUN_USER = `/run/user/${UID}`;
const sdRun = (env) => spawnSync("systemd-run", ["--user", "--pipe", "--quiet", "true"],
  { env: { ...env, XDG_RUNTIME_DIR: RUN_USER }, timeout: 15000, encoding: "utf8" });
const PARENT_SYSTEMD_USER = existsSync(RUN_USER) && sdRun(process.env).status === 0;
const TMUX_SOCK = `/tmp/tmux-${UID}/default`;
const PARENT_TMUX = existsSync(TMUX_SOCK) && await canConnect(TMUX_SOCK);

test("integration: a PiRpc child loses the casual docker, user-session and sudo routes; its parent keeps them", { skip: noSandbox }, async (t) => {
  t.diagnostic(`preconditions: docker=${PARENT_HAS_DOCKER && SOCKS.length > 0} systemd-user=${PARENT_SYSTEMD_USER} tmux=${PARENT_TMUX}`);
  if (PARENT_HAS_DOCKER && SOCKS.length) {
    assert.equal(await canConnect(SOCKS[0]), true, "precondition: the parent reaches the docker socket");
  }
  const dir = mkdtempSync(join(tmpdir(), "crow-pi-sandbox-"));
  mkdirSync(join(dir, "sessions"), { recursive: true });
  const stub = join(dir, "stub-pi.mjs");
  writeFileSync(stub, [
    'import { readFileSync, writeFileSync } from "node:fs";',
    'import { execFileSync, spawnSync } from "node:child_process";',
    'import { connect } from "node:net";',
    'import { homedir } from "node:os";',
    'const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");',
    'const status = readFileSync("/proc/self/status", "utf8");',
    'const field = (k) => (status.match(new RegExp("^" + k + ":\\\\s*(.*)$", "m")) || [])[1] || "";',
    'let idG = ""; try { idG = execFileSync("id", ["-G"], { encoding: "utf8" }).trim(); } catch (e) { idG = "ERR " + e.message; }',
    'let parentEnv = "readable"; try { readFileSync("/proc/" + process.env.CROW_TEST_PARENT_PID + "/environ"); } catch (e) { parentEnv = e.code || "denied"; }',
    'const tryConn = (p) => new Promise((r) => { if (!p) return r(false); const s = connect(p); const d = (v) => { try { s.destroy(); } catch {} r(v); };',
    '  s.once("connect", () => d(true)); s.once("error", () => d(false)); setTimeout(() => d(false), 2000); });',
    'const sock = process.env.CROW_TEST_SOCK || "";',
    'const direct = await tryConn(sock);',
    'const viaProc = sock ? await tryConn("/proc/" + process.env.CROW_TEST_PARENT_PID + "/root" + sock) : false;',
    'const tmux = await tryConn(process.env.CROW_TEST_TMUX);',
    'const sd = spawnSync("systemd-run", ["--user", "--pipe", "--quiet", "true"], { env: { ...process.env, XDG_RUNTIME_DIR: process.env.CROW_TEST_RUN_USER }, timeout: 15000, encoding: "utf8" });',
    'let unitWrite = "ok"; try { writeFileSync(homedir() + "/.config/systemd/user/crow-sandbox-probe.service", "[Unit]\\n"); } catch (e) { unitWrite = e.code || "denied"; }',
    'const keys = Object.keys(process.env).filter((k) => /^(DBUS_SESSION_BUS_ADDRESS|XDG_RUNTIME_DIR|SSH_AUTH_SOCK|TMUX|CROW_PI_SANDBOX)$|_SOCK(ET)?$/.test(k));',
    'out({ type: "report", idG, nnp: field("NoNewPrivs"), direct, viaProc, parentEnv, tmux, sdStatus: sd.status, unitWrite, keys, pid: process.pid });',
    'process.stdin.resume();',
  ].join("\n"));
  const setEnv = {
    CROW_TEST_PARENT_PID: String(process.pid), CROW_TEST_SOCK: SOCKS[0] || "", CROW_TEST_TMUX: TMUX_SOCK, CROW_TEST_RUN_USER: RUN_USER,
    // Planted in the gateway env: the child must not see any of them.
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${RUN_USER}/bus`, XDG_RUNTIME_DIR: RUN_USER, SSH_AUTH_SOCK: "/tmp/x-agent.sock",
    TMUX: TMUX_SOCK + ",1,0", SOME_TOOL_SOCK: "/tmp/y.sock", SOME_TOOL_SOCKET: "/tmp/z.sock",
  };
  const prevEnv = Object.fromEntries(Object.keys(setEnv).map((k) => [k, process.env[k]]));
  Object.assign(process.env, setEnv);
  // M1: a bot def's spawn_env cannot switch the sandbox off.
  const pi = new PiRpc({
    def: { spawn_env: { CROW_PI_SANDBOX: "off" } }, sessionDir: dir, resolved: { provider: "p", model: "m", key: "p/m" },
    nodeBin: process.execPath, cliPath: stub,
  });
  const unitProbe = join(homedir(), ".config", "systemd", "user", "crow-sandbox-probe.service");
  try {
    assert.equal(pi.sandboxed, true, "spawn_env CROW_PI_SANDBOX=off is ignored");
    const r = await pi.waitFor((m) => m.type === "report", 20000, "report");
    assert.equal(r.nnp, "1", "no_new_privs is set (sudo/setuid cannot escalate)");
    assert.notEqual(r.parentEnv, "readable", "child cannot read the parent's /proc/<pid>/environ");
    assert.deepEqual(r.keys, [], "user-session IPC pointers and the sandbox switch are scrubbed from the child env");
    assert.notEqual(r.unitWrite, "ok", "~/.config/systemd/user is read-only inside (" + r.unitWrite + ")");
    assert.ok(!existsSync(unitProbe));
    assert.equal(pi.piPid, r.pid, "bwrap reports pi's own pid");
    assert.notEqual(pi.proc.pid, r.pid, "proc.pid is the wrapper");
    if (PARENT_SYSTEMD_USER) {
      assert.notEqual(r.sdStatus, 0, "C1: systemd-run --user (the escape to an unsandboxed user-manager process) FAILS inside");
    }
    if (PARENT_TMUX) assert.equal(r.tmux, false, "C1: the tmux server socket is unreachable inside");
    if (PARENT_HAS_DOCKER && SOCKS.length) {
      assert.ok(!r.idG.split(/\s+/).map(Number).includes(GID), "child id -G lacks the docker gid: " + r.idG);
      assert.equal(r.direct, false, "child cannot connect to " + SOCKS[0]);
      assert.equal(r.viaProc, false, "child cannot reach the socket through the parent's /proc/<pid>/root");
      assert.equal(await canConnect(SOCKS[0]), true, "the parent still reaches the docker socket");
    }
    if (PARENT_SYSTEMD_USER) assert.equal(sdRun(process.env).status, 0, "the parent still reaches its user manager");
  } finally {
    await pi.close();
    try { rmSync(unitProbe, { force: true }); } catch {}
    for (const [k, v] of Object.entries(prevEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("integration (M7, no docker needed): a masked socket is unreachable inside, reachable outside", { skip: noSandbox }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "crow-pi-sandbox-sock-"));
  const sock = join(dir, "fake-docker.sock");
  const srv = createServer((c) => c.end());
  await new Promise((r) => srv.listen(sock, r));
  try {
    assert.equal(await canConnect(sock), true, "precondition: reachable from the parent");
    const script = 'const s=require("net").connect(process.argv[1]);s.on("connect",()=>{console.log("CONNECTED");process.exit(0)});s.on("error",(e)=>{console.log("ERR "+e.code);process.exit(0)})';
    const launch = wrapPiSpawn(process.execPath, ["-e", script, sock], { mode: "auto", sockets: [sock], runtimeDirs: [], roDirs: [] });
    assert.equal(launch.wrapper, "bwrap");
    const res = await new Promise((resolve) => {
      const c = spawn(launch.cmd, launch.args, { env: launch.env });
      let o = ""; c.stdout.on("data", (d) => (o += d)); c.on("exit", () => resolve(o.trim()));
    });
    assert.match(res, /^ERR /, "masked inside: " + res);
    assert.equal(await canConnect(sock), true, "still reachable from the parent");
  } finally {
    srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wrapPiSpawn: off / auto-unavailable / required / available argv", () => {
  _resetPiSandboxForTest();
  const off = wrapPiSpawn("node", ["cli.js"], { mode: "off", env: { SSH_AUTH_SOCK: "x" } });
  assert.deepEqual([off.cmd, off.args, off.sandboxed, off.wrapper], ["node", ["cli.js"], false, null]);
  assert.equal(off.env.SSH_AUTH_SOCK, "x", "off leaves the env alone");

  const bad = { ok: false, bwrap: null, setpriv: null, reason: "bubblewrap (bwrap) is not installed" };
  const origErr = console.error; const msgs = []; console.error = (m) => msgs.push(String(m));
  try {
    const a = wrapPiSpawn("node", ["cli.js"], { mode: "auto", probe: bad });
    assert.deepEqual([a.cmd, a.sandboxed, a.wrapper], ["node", false, null]);
    wrapPiSpawn("node", ["cli.js"], { mode: "auto", probe: bad });
    assert.equal(msgs.filter((m) => m.includes("[pi-sandbox] WARNING")).length, 1, "warns once per reason");
  } finally { console.error = origErr; }
  assert.throws(() => wrapPiSpawn("node", ["cli.js"], { mode: "required", probe: bad }), /required.*unavailable/);

  const good = { ok: true, bwrap: "/usr/bin/bwrap", reason: null };
  const w = wrapPiSpawn("/n/node", ["/x/cli.js", "--mode", "rpc"], {
    mode: "auto", probe: good, infoFd: 3, env: { A: "1", DBUS_SESSION_BUS_ADDRESS: "x", FOO_SOCK: "y" },
    sockets: ["/run/docker.sock", "/run/user/1000/docker.sock"],
    runtimeDirs: ["/run/user/1000", "/tmp/tmux-1000"], roDirs: ["/h/.config/systemd"],
  });
  assert.deepEqual([w.sandboxed, w.wrapper, w.cmd], [true, "bwrap", "/usr/bin/bwrap"]);
  assert.deepEqual(w.args, ["--dev-bind", "/", "/", "--unshare-user",
    "--tmpfs", "/run/user/1000", "--tmpfs", "/tmp/tmux-1000",
    "--ro-bind", "/dev/null", "/run/docker.sock",
    "--ro-bind", "/h/.config/systemd", "/h/.config/systemd",
    "--info-fd", "3", "--", "/n/node", "/x/cli.js", "--mode", "rpc"]);
  assert.deepEqual(w.env, { A: "1" }, "IPC pointers scrubbed");
  _resetPiSandboxForTest();
});

test("M1: the mode comes from the gateway's env, never from the child env", () => {
  _resetPiSandboxForTest();
  const prev = process.env.CROW_PI_SANDBOX;
  delete process.env.CROW_PI_SANDBOX;
  try {
    const good = { ok: true, bwrap: "/usr/bin/bwrap", reason: null };
    const w = wrapPiSpawn("node", ["cli.js"], { probe: good, env: { CROW_PI_SANDBOX: "off" }, sockets: [], runtimeDirs: [], roDirs: [] });
    assert.equal(w.sandboxed, true, "a child-env CROW_PI_SANDBOX=off does not turn the sandbox off");
    assert.ok(!("CROW_PI_SANDBOX" in w.env));
    const src = readFileSync(new URL("../scripts/pi-bots/bridge.mjs", import.meta.url), "utf8");
    assert.match(src, /k === "CROW_PI_SANDBOX"\) \{ strippedSpawnEnv\.push\(k\)/, "spawn_env strips CROW_PI_SANDBOX");
  } finally {
    if (prev === undefined) delete process.env.CROW_PI_SANDBOX; else process.env.CROW_PI_SANDBOX = prev;
  }
});

test("scrubSandboxEnv drops session IPC pointers and every *_SOCK", () => {
  assert.deepEqual(scrubSandboxEnv({ PATH: "/bin", HOME: "/h", XDG_RUNTIME_DIR: "/run/user/1", DBUS_SESSION_BUS_ADDRESS: "x",
    SSH_AUTH_SOCK: "a", TMUX: "t", TMUX_PANE: "%1", DISPLAY: ":0", WAYLAND_DISPLAY: "w", X_SOCK: "s", CROW_PI_SANDBOX: "off" }),
  { PATH: "/bin", HOME: "/h" });
});

test("M2: a failed probe is retried after PROBE_RETRY_MS; a success is kept", () => {
  _resetPiSandboxForTest();
  const dir = mkdtempSync(join(tmpdir(), "crow-pi-sandbox-probe-"));
  const okBin = join(dir, "bwrap-ok");
  writeFileSync(okBin, "#!/bin/sh\nexit 0\n"); chmodSync(okBin, 0o755);
  try {
    const t0 = 1_000_000;
    const a = probePiSandbox({ bwrap: null, setpriv: null, now: t0 });
    assert.equal(a.ok, false);
    const b = probePiSandbox({ bwrap: okBin, setpriv: null, now: t0 + PROBE_RETRY_MS - 1 });
    assert.equal(b.ok, false, "within the retry window the failure is cached");
    const c = probePiSandbox({ bwrap: okBin, setpriv: null, now: t0 + PROBE_RETRY_MS + 1 });
    assert.equal(c.ok, true, "after the window it re-probes and recovers");
    const d = probePiSandbox({ bwrap: null, setpriv: null, now: t0 + 10 * PROBE_RETRY_MS });
    assert.equal(d.ok, true, "a success is kept for the life of the process");
  } finally {
    _resetPiSandboxForTest();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M3: without bwrap, setpriv --no-new-privs is the fallback (stubbed binary)", () => {
  _resetPiSandboxForTest();
  const dir = mkdtempSync(join(tmpdir(), "crow-pi-sandbox-setpriv-"));
  const log = join(dir, "calls.log");
  const stub = join(dir, "setpriv");
  writeFileSync(stub, `#!/bin/sh\necho "$@" >> ${log}\nexit 0\n`); chmodSync(stub, 0o755);
  const origErr = console.error; const msgs = []; console.error = (m) => msgs.push(String(m));
  try {
    const p = probePiSandbox({ bwrap: null, setpriv: stub, force: true });
    assert.deepEqual([p.ok, p.setpriv], [false, stub]);
    assert.equal(readFileSync(log, "utf8").trim(), "--no-new-privs /bin/true", "the probe ran the stub");
    const w = wrapPiSpawn("/n/node", ["/x/cli.js", "--mode", "rpc"], { mode: "auto", env: { A: "1", SSH_AUTH_SOCK: "s" } });
    assert.deepEqual([w.cmd, w.args, w.wrapper, w.sandboxed], [stub, ["--no-new-privs", "/n/node", "/x/cli.js", "--mode", "rpc"], "setpriv", false]);
    assert.deepEqual(w.env, { A: "1" });
    assert.ok(msgs.some((m) => m.includes("setpriv --no-new-privs")));
    assert.throws(() => wrapPiSpawn("n", [], { mode: "required" }), /required/, "required still demands bwrap");
  } finally {
    console.error = origErr;
    _resetPiSandboxForTest();
    rmSync(dir, { recursive: true, force: true });
  }
});

const REAL_SETPRIV = ["/usr/bin/setpriv", "/bin/setpriv"].find((p) => existsSync(p));
test("M3: the real setpriv fallback sets no_new_privs on pi", { skip: REAL_SETPRIV ? false : "setpriv not installed" }, () => {
  const w = wrapPiSpawn(process.execPath, ["-e", 'console.log(require("fs").readFileSync("/proc/self/status","utf8").match(/NoNewPrivs:\\s*(\\d)/)[1])'],
    { mode: "auto", probe: { ok: false, bwrap: null, setpriv: REAL_SETPRIV, reason: "test" } });
  const origErr = console.error; console.error = () => {};
  try {
    const r = spawnSync(w.cmd, w.args, { env: w.env, encoding: "utf8" });
    assert.equal(r.stdout.trim(), "1");
  } finally { console.error = origErr; _resetPiSandboxForTest(); }
});

test("N2: session paths are masked even when nothing is running at spawn time", () => {
  for (const d of userRuntimeDirs(UID, { create: false })) assert.ok(existsSync(d), d);
  const fake = 4_000_123;
  const made = [`/tmp/tmux-${fake}`, `/tmp/cc-daemon-${fake}`];
  for (const d of made) rmSync(d, { recursive: true, force: true });
  try {
    assert.deepEqual(userRuntimeDirs(fake, { create: false }).filter((d) => d.includes(String(fake))), [], "create:false does not invent them");
    const dirs = userRuntimeDirs(fake);
    for (const d of made) {
      assert.ok(dirs.includes(d), d + " is masked though absent at spawn");
      assert.equal(statSync(d).mode & 0o777, 0o700, d + " pre-created 0700");
    }
    if (existsSync("/run/user")) assert.ok(dirs.includes("/run/user"), "/run/user is masked whole");
    assert.ok(!dirs.some((d) => d.startsWith("/run/user/")), "no per-uid entry needed under the whole-/run/user mask");
  } finally {
    for (const d of made) rmSync(d, { recursive: true, force: true });
  }
});

test("N3: *_SOCKET and *_SOCKET_PATH are scrubbed too", () => {
  assert.deepEqual(scrubSandboxEnv({ KEEP: "1", CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/x", FOO_SOCKET_PATH: "/tmp/y", SOCKET_TIMEOUT_MS: "5" }),
    { KEEP: "1", SOCKET_TIMEOUT_MS: "5" });
});

test("piSandboxMode parses CROW_PI_SANDBOX, defaulting to auto", () => {
  assert.equal(piSandboxMode({}), "auto");
  assert.equal(piSandboxMode({ CROW_PI_SANDBOX: "OFF" }), "off");
  assert.equal(piSandboxMode({ CROW_PI_SANDBOX: "required" }), "required");
  assert.equal(piSandboxMode({ CROW_PI_SANDBOX: "bogus" }), "auto");
});

test("isSandboxWrapperArgs recognises bwrap argv only", () => {
  assert.equal(isSandboxWrapperArgs("/usr/bin/bwrap --dev-bind / / -- node cli.js"), true);
  assert.equal(isSandboxWrapperArgs("bwrap --unshare-user -- x"), true);
  assert.equal(isSandboxWrapperArgs("/usr/bin/node /x/cli.js --mode rpc"), false);
});

const CLI = "/h/node_modules/@earendil-works/pi-coding-agent/dist/cli.js";
const PS = [
  // sandboxed: wrapper 100 (child of gateway 50) -> pi 101
  `  100    50   400   3000 /usr/bin/bwrap --dev-bind / / --unshare-user --ro-bind /dev/null /run/docker.sock --info-fd 3 -- /n/node ${CLI} --mode rpc --no-approve`,
  `  101   100   399 250000 /n/node ${CLI} --mode rpc --no-approve`,
  // unsandboxed pi 200
  `  200    50    10 120000 /n/node ${CLI} --mode rpc`,
  // orphaned sandbox: wrapper reparented to init
  `  300     1   500   3000 /usr/bin/bwrap --dev-bind / / --unshare-user -- /n/node ${CLI} --mode rpc`,
  `  301   300   499 999999 /n/node ${CLI} --mode rpc`,
  // a wrapper whose pi has not started yet
  `  400    50     0   2000 /usr/bin/bwrap --dev-bind / / --unshare-user -- /n/node ${CLI} --mode rpc`,
  // interactive (non-rpc) pi is never listed
  `  500    50    10 100000 /n/node ${CLI}`,
].join("\n");

test("listBridgePi counts a sandboxed pi once: wrapper pid/ppid, pi's RSS", () => {
  const procs = listBridgePi({ _psOutput: PS });
  const byPid = Object.fromEntries(procs.map((p) => [p.pid, p]));
  assert.equal(procs.length, 4, JSON.stringify(procs));
  assert.deepEqual([byPid[100].ppid, byPid[100].rssKb, byPid[100].innerPid], [50, 250000, 101]);
  assert.equal(byPid[200].innerPid, undefined);
  assert.deepEqual([byPid[300].ppid, byPid[300].innerPid], [1, 301]);
  assert.equal(byPid[400].innerPid, undefined);
  assert.ok(!byPid[101] && !byPid[301], "inner pids are folded into their wrapper");
});

test("reapStalePi signals both the wrapper and pi for a sandboxed orphan", () => {
  const killed = [];
  const procs = listBridgePi({ _psOutput: PS });
  const r = reapStalePi({ _procs: procs, _kill: (pid, sig) => killed.push([pid, sig]), leaseFiles: [], now: Date.now() });
  const victims = r.reaped.map((v) => v.pid);
  assert.ok(victims.includes(300), "orphaned wrapper reaped");
  assert.ok(killed.some(([p, s]) => p === 300 && s === "SIGTERM"));
  assert.ok(killed.some(([p, s]) => p === 301 && s === "SIGTERM"), "pi inside the orphaned sandbox is signalled too");
  assert.ok(killed.some(([p, s]) => p === -300 && s === "SIGTERM"), "M8: the wrapper's process group (pi's MCP children) is signalled");
  assert.ok(!victims.includes(100), "a live sandboxed pi under its gateway is left alone");
});

test("I1: an OLD-style reaper (no wrapper folding) respects the dual lease on pi's own pid", () => {
  const dir = mkdtempSync(join(tmpdir(), "crow-pi-sandbox-lease-"));
  const leaseFile = join(dir, "perch-interactive-leases.json");
  const now = Date.now();
  // What perch-interactive writeLeases now writes for a sandboxed child.
  writeFileSync(leaseFile, JSON.stringify({ version: 1, leases: {
    "700": { sessionId: "s1", expiresAt: now + 60_000 },
    "701": { sessionId: "s1", expiresAt: now + 60_000 },
  } }));
  // The pre-branch scan: every argv carrying the marker is its own entry.
  const oldStyle = [
    { pid: 700, ppid: 50, etimes: 4000, rssKb: 3000, args: `/usr/bin/bwrap -- /n/node ${CLI} --mode rpc` },
    { pid: 701, ppid: 700, etimes: 4000, rssKb: 250000, args: `/n/node ${CLI} --mode rpc` },
  ];
  try {
    const killed = [];
    const r = reapStalePi({ _procs: oldStyle, _kill: (pid, sig) => killed.push([pid, sig]), leaseFiles: [leaseFile], now });
    assert.deepEqual(r.reaped, [], "neither the wrapper nor the inner pi is reaped past hardAgeSec");
    assert.deepEqual(killed, []);
    // Control: with only the wrapper leased (pre-fix lease file) the old reaper kills pi.
    writeFileSync(leaseFile, JSON.stringify({ version: 1, leases: { "700": { sessionId: "s1", expiresAt: now + 60_000 } } }));
    const r2 = reapStalePi({ _procs: oldStyle, _kill: () => {}, leaseFiles: [leaseFile], now });
    assert.deepEqual(r2.reaped.map((v) => v.pid), [701], "control: the bug the dual lease fixes");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
