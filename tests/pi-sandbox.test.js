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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync, statSync, lstatSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { connect, createServer } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import {
  wrapPiSpawn, piSandboxMode, probePiSandbox, dockerSocketPaths, isSandboxWrapperArgs,
  scrubSandboxEnv, userRuntimeDirs, PROBE_RETRY_MS, _resetPiSandboxForTest,
  credentialMaskDirs, boardSecretCredential, boardSecretCredentialRoots, BWRAP_BASE, BWRAP_BASE_NO_PIDNS, piSandboxStatus,
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
    // PID namespace: inside, pi sees its own pid (2, under the namespace's
    // init); outside, PiRpc resolved pi's OUTER pid, whose NSpid ends in it.
    for (let i = 0; i < 50 && pi.piPid == null; i++) await new Promise((res) => setTimeout(res, 20));
    assert.ok(pi.piPid && pi.piPid !== pi.proc.pid && pi.piPid !== pi.sandboxInitPid, "piPid is pi, not a wrapper");
    const nspid = (readFileSync("/proc/" + pi.piPid + "/status", "utf8").match(/^NSpid:\s*(.*)$/m) || [])[1].trim().split(/\s+/).map(Number);
    assert.deepEqual([nspid[0], nspid[nspid.length - 1]], [pi.piPid, r.pid], "outer pid " + pi.piPid + " is the inner pid " + r.pid);
    assert.equal(r.pid, 2, "pi runs under the namespace's init");
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
    credentialDirs: ["/run/credentials", "/srv/board-secret"],
  });
  assert.deepEqual([w.sandboxed, w.wrapper, w.cmd], [true, "bwrap", "/usr/bin/bwrap"]);
  assert.deepEqual(w.args, ["--dev-bind", "/", "/", "--unshare-user", "--unshare-pid", "--proc", "/proc",
    "--tmpfs", "/run/user/1000", "--tmpfs", "/tmp/tmux-1000",
    "--tmpfs", "/run/credentials", "--tmpfs", "/srv/board-secret",
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
    assert.match(src, /k === "CROW_PI_SANDBOX" \|\| k === "CROW_PI_CONTAIN_BOTS" \|\| k === "CROW_PI_CONTAIN_DATA_KEEP"\) \{ strippedSpawnEnv\.push\(k\)/, "spawn_env strips CROW_PI_SANDBOX and CROW_PI_CONTAIN_BOTS");
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
    // PID-namespace topology (outer bwrap 800 -> inner bwrap 801 -> pi 802)
    // as origin/main's ONE-level fold lists it: the inner bwrap carries pi's
    // RSS and innerPid, the outer one stands alone. perch now leases all
    // three (wrapper, sandboxInitPid, piPid).
    writeFileSync(leaseFile, JSON.stringify({ version: 1, leases: {
      "800": { sessionId: "s2", expiresAt: now + 60_000 },
      "801": { sessionId: "s2", expiresAt: now + 60_000 },
      "802": { sessionId: "s2", expiresAt: now + 60_000 },
    } }));
    const oneLevel = [
      { pid: 801, ppid: 800, etimes: 4000, rssKb: 250000, args: `/usr/bin/bwrap -- /n/node ${CLI} --mode rpc`, innerPid: 802 },
      { pid: 800, ppid: 50, etimes: 4000, rssKb: 3000, args: `/usr/bin/bwrap -- /n/node ${CLI} --mode rpc` },
    ];
    const r3 = reapStalePi({ _procs: oneLevel, _kill: () => {}, leaseFiles: [leaseFile], now });
    assert.deepEqual(r3.reaped, [], "the one-level reaper leaves a leased nested sandbox alone");
    writeFileSync(leaseFile, JSON.stringify({ version: 1, leases: {
      "800": { sessionId: "s2", expiresAt: now + 60_000 }, "802": { sessionId: "s2", expiresAt: now + 60_000 } } }));
    const r4 = reapStalePi({ _procs: oneLevel, _kill: () => {}, leaseFiles: [leaseFile], now });
    assert.deepEqual(r4.reaped.map((v) => v.pid), [801], "control: without the init lease the one-level reaper kills the session");
    // Control: with only the wrapper leased (pre-fix lease file) the old reaper kills pi.
    writeFileSync(leaseFile, JSON.stringify({ version: 1, leases: { "700": { sessionId: "s1", expiresAt: now + 60_000 } } }));
    const r2 = reapStalePi({ _procs: oldStyle, _kill: () => {}, leaseFiles: [leaseFile], now });
    assert.deepEqual(r2.reaped.map((v) => v.pid), [701], "control: the bug the dual lease fixes");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- board actor secret file (2026-10-20 fix round 1) ----

test("board secret: only a systemd credential under an always-masked root is accepted", () => {
  const real = (p) => p.replace(/^\/link\//, "/run/credentials/");
  assert.equal(boardSecretCredential({}), null);
  assert.deepEqual(boardSecretCredential({ CREDENTIALS_DIRECTORY: "/run/credentials/u.service" }, { realpathFn: real }),
    { path: "/run/credentials/u.service/board-actor-secret", dir: "/run/credentials/u.service" });
  assert.equal(boardSecretCredential({ CREDENTIALS_DIRECTORY: "/link/u.service" }, { realpathFn: real }).path,
    "/run/credentials/u.service/board-actor-secret", "judged by real path");
  assert.equal(boardSecretCredential({ CREDENTIALS_DIRECTORY: "/run/user/1000/credentials/u.service", XDG_RUNTIME_DIR: "/run/user/1000" }, { realpathFn: (p) => p }).path,
    "/run/user/1000/credentials/u.service/board-actor-secret");
  for (const cd of ["/srv/creds", "/run/credentials", "/run/credentialsX/u", "/tmp/run/credentials/u", "/home/alex/credentials/u"]) {
    assert.match(boardSecretCredential({ CREDENTIALS_DIRECTORY: cd, XDG_RUNTIME_DIR: "/run/user/1000" }, { realpathFn: (p) => p }).problem, /not under/, cd);
  }
  assert.match(boardSecretCredential({ CREDENTIALS_DIRECTORY: "/x" }, { realpathFn: () => { throw new Error("ENOENT"); } }).problem, /does not exist/);
  // a runtime dir outside /run/user (not covered by the /run/user mask) adds no root
  assert.deepEqual(boardSecretCredentialRoots({ XDG_RUNTIME_DIR: "/tmp/xdg" }, { realpathFn: (p) => p }), ["/run/credentials"]);
  assert.deepEqual(boardSecretCredentialRoots({ XDG_RUNTIME_DIR: "/run/user/1000" }, { realpathFn: (p) => p }), ["/run/credentials", "/run/user/1000/credentials"]);
});

test("board secret: /run/credentials is masked for EVERY pi child, independent of the spawner's env", () => {
  assert.deepEqual(credentialMaskDirs({ isDirFn: () => true }), ["/run/credentials"]);
  assert.deepEqual(credentialMaskDirs({ isDirFn: () => false }), [], "absent: no credential exists, and bwrap could not create the mount point");
  const good = { ok: true, bwrap: "/usr/bin/bwrap", reason: null };
  const w = wrapPiSpawn("node", ["cli.js"], { mode: "auto", probe: good, env: {}, sockets: [], runtimeDirs: [], roDirs: [] });
  if (existsSync("/run/credentials")) {
    const i = w.args.indexOf("/run/credentials");
    assert.ok(i > 0 && w.args[i - 1] === "--tmpfs" && i < w.args.indexOf("--"), JSON.stringify(w.args));
  }
  const src = readFileSync(new URL("../scripts/pi-bots/pi_sandbox.mjs", import.meta.url), "utf8");
  assert.match(src, /opts\.credentialDirs \|\| credentialMaskDirs\(\)/, "the default takes no env");
});

test("every pi spawn goes through PiRpc and the central wrapPiSpawn", () => {
  // Tracked files only (git ls-files): never follows a symlink in the working
  // tree, never reads untracked scratch.
  const root = new URL("..", import.meta.url).pathname;
  const files = spawnSync("git", ["ls-files", "-z", "--", "scripts", "servers", "bundles"], { cwd: root, encoding: "utf8" })
    .stdout.split("\0").filter((f) => /\.(m?js)$/.test(f) && !f.includes("node_modules/"))
    .map((f) => join(root, f)).filter((f) => { try { return lstatSync(f).isFile(); } catch { return false; } });
  assert.ok(files.length > 100, "git ls-files found the tree");
  // Any call to something named like a process launcher (spawn, spawnSync,
  // execFile, execFileFn, forkChild, ...) whose next lines name the pi CLI.
  // Allowed: bridge.mjs (PiRpc, checked below) and pi-model-catalog's
  // `pi --list-models` (no bot input, no tools, exits at once; returns the
  // model list only).
  const ALLOWED = [
    { file: join("scripts", "pi-bots", "bridge.mjs") },
    { file: join("scripts", "pi-bots", "pi-model-catalog.mjs"), must: /"--list-models"/ },
  ];
  const offenders = [];
  for (const f of files) {
    const lines = readFileSync(f, "utf8").split("\n");
    lines.forEach((l, i) => {
      // Skip comments and declarations at line start only: a one-line helper
      // (`const run = () => spawn(...)`, `function f() { return execFile(...) }`)
      // is still checked for what it calls.
      if (/^\s*(\*|\/\/)/.test(l)) return;
      const decl = l.match(/^\s*(export\s+)?(async\s+)?function\s*\*?\s*[\w$]+\s*\([^)]*\)\s*\{?\s*$/);
      if (decl) return;
      if (!/\b[\w$]*(spawn|exec|fork)[\w$]*\s*\(/i.test(l)) return;
      const win = lines.slice(i, i + 4).join(" ");
      if (!/cliPath|piCli|PiCli|pi-coding-agent|"rpc"|'rpc'/.test(win)) return;
      const ok = ALLOWED.find((a) => f.endsWith(a.file) && (!a.must || a.must.test(win)));
      if (!ok) offenders.push(f.slice(root.length) + ":" + (i + 1));
    });
  }
  assert.deepEqual(offenders, [], "pi spawned outside PiRpc");
  const bridge = readFileSync(join(root, "scripts/pi-bots/bridge.mjs"), "utf8");
  assert.equal((bridge.match(/\bspawn\(/g) || []).length, 1);
  assert.match(bridge, /launch = wrapPiSpawn\(nodeBin, args, \{ env, infoFd: 3, botId: sandboxBotId, contain \}\);/);
  assert.match(bridge, /this\.proc = spawn\(launch\.cmd, launch\.args,/);
  assert.match(readFileSync(join(root, "scripts/pi-bots/job_runner.mjs"), "utf8"), /new bridge\.PiRpc\(/);
  assert.match(readFileSync(join(root, "servers/gateway/perch-interactive.js"), "utf8"), /new S\.PiRpc\(/);
  assert.match(readFileSync(join(root, "scripts/pi-bots/skill_review.mjs"), "utf8"), /new PiRpc\(/);
  const discord = readFileSync(join(root, "scripts/pi-bots/discord_gateway.mjs"), "utf8");
  assert.match(discord, /import \{ handleInbound \} from "\.\/bridge\.mjs";/, "Discord turns run through the bridge");
  assert.doesNotMatch(discord, /\bspawn\(/);
});

test("integration: a sandboxed child cannot read the board secret file; the parent can", { skip: noSandbox }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "crow-board-secret-int-"));
  const file = join(dir, "board-actor-secret");
  writeFileSync(file, "a".repeat(64) + "\n", { mode: 0o600 });
  try {
    const script = 'try{console.log("READ "+require("fs").readFileSync(process.argv[1],"utf8").length)}catch(e){console.log("ERR "+e.code)}';
    const launch = wrapPiSpawn(process.execPath, ["-e", script, file], { mode: "auto", sockets: [], runtimeDirs: [], roDirs: [],
      credentialDirs: [dir] });
    assert.equal(launch.wrapper, "bwrap");
    const res = await new Promise((resolve) => {
      const c = spawn(launch.cmd, launch.args, { env: launch.env });
      let o = ""; c.stdout.on("data", (d) => (o += d)); c.on("exit", () => resolve(o.trim()));
    });
    assert.match(res, /^ERR ENOENT/, "masked inside: " + res);
    assert.equal(readFileSync(file, "utf8").length, 65, "still readable by the parent");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("integration: PID namespace + fresh /proc: no host process is visible; the parent's root and environ do not exist inside", { skip: noSandbox }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "crow-pidns-"));
  const secret = join(dir, "secret");
  writeFileSync(secret, "s3cr3t-value-for-test", { mode: 0o600 });
  try {
    const script = [
      'const fs = require("fs"); const { execFileSync } = require("child_process");',
      'const ppid = process.argv[1], secret = process.argv[2];',
      'const tryRead = (p) => { try { fs.readFileSync(p); return "READ"; } catch (e) { return e.code; } };',
      'const pids = fs.readdirSync("/proc").filter((x) => /^\\d+$/.test(x)).map(Number);',
      'const sub = execFileSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" }).trim();',
      'fs.writeFileSync("written-inside.txt", "ok");',
      'console.log(JSON.stringify({ root: tryRead("/proc/" + ppid + "/root" + secret), environ: tryRead("/proc/" + ppid + "/environ"), pids, self: process.pid, sub, cwdRead: fs.readFileSync("written-inside.txt", "utf8") }));',
    ].join("\n");
    const launch = wrapPiSpawn(process.execPath, ["-e", script, String(process.pid), secret], { mode: "auto", sockets: [], runtimeDirs: [], roDirs: [], credentialDirs: [] });
    assert.ok(launch.args.includes("--unshare-pid") && !launch.args.includes("--die-with-parent"));
    const res = await new Promise((resolve) => {
      const c = spawn(launch.cmd, launch.args, { env: launch.env, cwd: dir });
      let o = "", e = ""; c.stdout.on("data", (d) => (o += d)); c.stderr.on("data", (d) => (e += d));
      c.on("exit", (code) => resolve({ code, o: o.trim(), e }));
    });
    assert.equal(res.code, 0, "the sandboxed child (with its own subprocess) exits 0: " + res.e);
    const r = JSON.parse(res.o.split("\n").pop());
    assert.notEqual(r.root, "READ", "the parent's /proc/<pid>/root is not reachable");
    assert.notEqual(r.environ, "READ", "the parent's /proc/<pid>/environ is not reachable");
    assert.ok(!r.pids.includes(process.pid), "the parent's pid is not even listed");
    assert.ok(r.pids.length <= 4 && r.pids.every((p) => p <= 10), "only the sandbox's own pids: " + r.pids.join(","));
    assert.ok(Number(r.sub) > r.self, "the child spawned its own subprocess");
    assert.equal(r.cwdRead, "ok", "reads and writes its cwd");
    assert.equal(readFileSync(join(dir, "written-inside.txt"), "utf8"), "ok", "the write is visible outside");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("integration: close()'s group SIGTERM lets a sandboxed pi finish its SIGTERM drain", { skip: noSandbox }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "crow-pi-drain-"));
  mkdirSync(join(dir, "sessions"), { recursive: true });
  const marker = join(dir, "drained");
  const stub = join(dir, "stub-pi.mjs");
  writeFileSync(stub, [
    'import { writeFileSync } from "node:fs";',
    `process.on("SIGTERM", () => setTimeout(() => { writeFileSync(${JSON.stringify(marker)}, "ok"); process.exit(0); }, 800));`,
    'process.stdout.write(JSON.stringify({ type: "up" }) + "\\n");',
    "setInterval(() => {}, 1000);",
  ].join("\n"));
  const prev = process.env.CROW_PI_SANDBOX;
  delete process.env.CROW_PI_SANDBOX;
  try {
    const pi = new PiRpc({ def: {}, sessionDir: dir, resolved: { provider: "p", model: "m", key: "p/m" }, nodeBin: process.execPath, cliPath: stub });
    assert.equal(pi.sandboxed, true);
    await pi.waitFor((m) => m.type === "up", 20000, "up");
    await pi.close();
    for (let i = 0; i < 40 && !existsSync(marker); i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(existsSync(marker), true, "pi's SIGTERM handler ran to completion (no PDEATHSIG kill)");
  } finally {
    if (prev === undefined) delete process.env.CROW_PI_SANDBOX; else process.env.CROW_PI_SANDBOX = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("integration: a sandboxed pi that IGNORES SIGTERM is still gone within ~6 s of close()", { skip: noSandbox }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "crow-pi-stubborn-"));
  mkdirSync(join(dir, "sessions"), { recursive: true });
  const stub = join(dir, "stub-pi.mjs");
  writeFileSync(stub, [
    'process.on("SIGTERM", () => {});',
    'process.stdout.write(JSON.stringify({ type: "up" }) + "\\n");',
    "setInterval(() => {}, 1000);",
  ].join("\n"));
  const prev = process.env.CROW_PI_SANDBOX;
  delete process.env.CROW_PI_SANDBOX;
  let pgidForCleanup = null;
  try {
    const pi = new PiRpc({ def: {}, sessionDir: dir, resolved: { provider: "p", model: "m", key: "p/m" }, nodeBin: process.execPath, cliPath: stub });
    assert.equal(pi.sandboxed, true);
    await pi.waitFor((m) => m.type === "up", 20000, "up");
    for (let i = 0; i < 50 && pi.piPid == null; i++) await new Promise((r) => setTimeout(r, 20));
    const piPid = pi.piPid, pgid = pi.proc.pid;
    pgidForCleanup = pgid;
    const alive = (p) => { try { process.kill(p, 0); return true; } catch (e) { return e.code === "EPERM"; } };
    const t0 = Date.now();
    await pi.close();
    assert.ok(Date.now() - t0 < 2000, "close() itself does not wait for the drain");
    assert.equal(alive(piPid), true, "pi ignored SIGTERM and is still alive right after close()");
    for (let i = 0; i < 70 && alive(piPid); i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(alive(piPid), false, "SIGKILLed by the kept 5 s timer");
    assert.throws(() => process.kill(-pgid, 0), "the process group is gone");
    pgidForCleanup = null; // never SIGKILL a pgid that may since have been reused
  } finally {
    try { if (pgidForCleanup) process.kill(-pgidForCleanup, "SIGKILL"); } catch { /* gone */ }
    if (prev === undefined) delete process.env.CROW_PI_SANDBOX; else process.env.CROW_PI_SANDBOX = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("countLivePi's scan counts a sandboxed pi ONCE in the nested topology", () => {
  const W = `/usr/bin/bwrap --dev-bind / / --unshare-user --unshare-pid --proc /proc --info-fd 3 -- /n/node ${CLI} --mode rpc`;
  const ps = [`  700    50   400   3000 ${W}`, `  701   700   400   1000 ${W}`, `  702   701   399 250000 /n/node ${CLI} --mode rpc`,
    `  200    50    10 120000 /n/node ${CLI} --mode rpc`].join("\n");
  assert.equal(listBridgePi({ _psOutput: ps }).length, 2, "one sandboxed + one plain pi");
  const src = readFileSync(new URL("../scripts/pi-bots/pi_lifecycle.mjs", import.meta.url), "utf8");
  assert.match(src, /export function countLivePi\(\) \{\n  return listBridgePi\(\)\.length;/);
});

test("listBridgePi folds a PID-namespace sandbox (outer bwrap -> inner bwrap -> pi) into ONE entry", () => {
  const W = `/usr/bin/bwrap --dev-bind / / --unshare-user --unshare-pid --proc /proc --info-fd 3 -- /n/node ${CLI} --mode rpc`;
  const ps = [
    `  700    50   400   3000 ${W}`,
    `  701   700   400   1000 ${W}`,
    `  702   701   399 250000 /n/node ${CLI} --mode rpc`,
    // orphaned nested sandbox
    `  800     1   500   3000 ${W}`,
    `  801   800   500   1000 ${W}`,
    `  802   801   499 999999 /n/node ${CLI} --mode rpc`,
    // nested wrapper whose pi has not started
    `  900    50     0   2000 ${W}`,
    `  901   900     0   1000 ${W}`,
  ].join("\n");
  const procs = listBridgePi({ _psOutput: ps });
  const byPid = Object.fromEntries(procs.map((p) => [p.pid, p]));
  assert.equal(procs.length, 3, JSON.stringify(procs));
  assert.deepEqual([byPid[700].ppid, byPid[700].rssKb, byPid[700].innerPid], [50, 250000, 702]);
  assert.deepEqual([byPid[800].ppid, byPid[800].innerPid], [1, 802]);
  assert.ok(byPid[900] && !byPid[901]);
  const killed = [];
  const r = reapStalePi({ _procs: procs, _kill: (pid, sig) => killed.push([pid, sig]), leaseFiles: [], now: Date.now() });
  assert.deepEqual(r.reaped.map((v) => v.pid), [800]);
  assert.ok(killed.some(([p, s2]) => p === -800 && s2 === "SIGTERM"), "the outer wrapper's group (inner bwrap, pi, its children) is signalled");
});

test("two-tier probe: full flags first, then user-namespace only ('active-no-pidns'), setpriv only when both fail", () => {
  const calls = [];
  const stub = (results) => (bin, args) => { calls.push([bin, args.join(" ")]); return results.shift(); };
  const prevMode = process.env.CROW_PI_SANDBOX;
  delete process.env.CROW_PI_SANDBOX;
  try {
    // tier 1 works
    _resetPiSandboxForTest();
    let p = probePiSandbox({ force: true, bwrap: "/b", setpriv: "/s", runProbe: stub([null]) });
    assert.deepEqual([p.ok, p.pidns, p.bwrap], [true, true, "/b"]);
    assert.equal(piSandboxStatus(), "active");
    assert.equal(calls.length, 1);
    assert.match(calls[0][1], /--unshare-pid --proc \/proc -- \/bin\/true$/);
    // tier 1 fails, tier 2 works
    calls.length = 0;
    _resetPiSandboxForTest();
    p = probePiSandbox({ force: true, bwrap: "/b", setpriv: "/s", runProbe: stub(["no pidns", null]) });
    assert.deepEqual([p.ok, p.pidns, p.setpriv], [true, false, null]);
    assert.match(p.pidnsReason, /--unshare-pid \/ --proc.*no pidns/);
    assert.equal(piSandboxStatus(), "active-no-pidns");
    assert.deepEqual(calls.map((c) => c[1]), [[...BWRAP_BASE, "--", "/bin/true"].join(" "), [...BWRAP_BASE_NO_PIDNS, "--", "/bin/true"].join(" ")]);
    const msgs = []; const orig = console.error; console.error = (m) => msgs.push(String(m));
    try {
      const w = wrapPiSpawn("/n/node", ["cli.js"], { mode: "auto", probe: p, env: {}, sockets: [], runtimeDirs: [], roDirs: [], credentialDirs: ["/run/credentials"] });
      assert.deepEqual([w.sandboxed, w.pidNamespace], [true, false]);
      assert.deepEqual(w.args, ["--dev-bind", "/", "/", "--unshare-user", "--tmpfs", "/run/credentials", "--", "/n/node", "cli.js"]);
      wrapPiSpawn("/n/node", ["cli.js"], { mode: "auto", probe: p, env: {}, sockets: [], runtimeDirs: [], roDirs: [], credentialDirs: [] });
    } finally { console.error = orig; }
    assert.equal(msgs.filter((m) => m.includes("WITHOUT a private PID namespace")).length, 1, "warns once");
    // both bwrap tiers fail: setpriv
    calls.length = 0;
    _resetPiSandboxForTest();
    p = probePiSandbox({ force: true, bwrap: "/b", setpriv: "/s", runProbe: stub(["e1", "e2", null]) });
    assert.deepEqual([p.ok, p.setpriv], [false, "/s"]);
    assert.match(p.reason, /--unshare-user\): e2/);
    assert.match(piSandboxStatus(), /^nnp-only: /);
    assert.equal(calls[2][0], "/s");
  } finally {
    if (prevMode === undefined) delete process.env.CROW_PI_SANDBOX; else process.env.CROW_PI_SANDBOX = prevMode;
    _resetPiSandboxForTest();
  }
});

test("a tier-2 success is re-probed after PROBE_RETRY_MS and upgrades to the full tier", () => {
  const prevMode = process.env.CROW_PI_SANDBOX;
  delete process.env.CROW_PI_SANDBOX;
  const results = ["probe timeout", null, null];
  const calls = [];
  const runProbe = (bin, args) => { calls.push(args.join(" ")); return results.shift(); };
  try {
    _resetPiSandboxForTest();
    const t0 = 1_000_000;
    let p = probePiSandbox({ now: t0, bwrap: "/b", setpriv: "/s", runProbe });
    assert.deepEqual([p.ok, p.pidns], [true, false], "transient tier-1 failure: tier 2");
    p = probePiSandbox({ now: t0 + PROBE_RETRY_MS - 1, bwrap: "/b", setpriv: "/s", runProbe });
    assert.equal(calls.length, 2, "cached within the retry interval");
    assert.equal(p.pidns, false);
    p = probePiSandbox({ now: t0 + PROBE_RETRY_MS, bwrap: "/b", setpriv: "/s", runProbe });
    assert.deepEqual([p.ok, p.pidns], [true, true], "upgraded");
    assert.equal(calls.length, 3);
    assert.match(calls[2], /--unshare-pid --proc \/proc/);
    assert.equal(piSandboxStatus(), "active", "status follows the cache");
    const w = wrapPiSpawn("/n/node", ["cli.js"], { mode: "auto", probe: probePiSandbox({ now: t0 + 10 * PROBE_RETRY_MS, runProbe }), env: {}, sockets: [], runtimeDirs: [], roDirs: [], credentialDirs: [] });
    assert.equal(w.pidNamespace, true, "later spawns use the full tier");
    assert.equal(calls.length, 3, "a full-tier success is kept for good");
  } finally {
    if (prevMode === undefined) delete process.env.CROW_PI_SANDBOX; else process.env.CROW_PI_SANDBOX = prevMode;
    _resetPiSandboxForTest();
  }
});
