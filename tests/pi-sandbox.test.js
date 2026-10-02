// S3 (2026-10-02): pi children must not inherit the gateway's docker access.
//
// The integration test spawns a stub "pi" through the real PiRpc and has it
// report what it can do. It runs only where it can prove something: the test
// process must hold the docker group AND bubblewrap must be usable; otherwise
// it skips (CI runners usually lack one or the other). The unit tests below it
// run everywhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import {
  wrapPiSpawn, piSandboxMode, probePiSandbox, dockerSocketPaths, isSandboxWrapperArgs,
  _resetPiSandboxForTest,
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

const GID = dockerGid();
const PARENT_HAS_DOCKER = GID != null && process.getgroups().includes(GID);
const SOCKS = dockerSocketPaths();
const SANDBOX = probePiSandbox({ force: true });
const skipWhy = !PARENT_HAS_DOCKER ? "test process is not in the docker group"
  : !SOCKS.length ? "no docker socket on this host"
  : !SANDBOX.ok ? "pi sandbox unavailable here: " + SANDBOX.reason
  : false;

test("integration: a PiRpc child is denied docker while its parent keeps it", { skip: skipWhy }, async () => {
  assert.equal(await canConnect(SOCKS[0]), true, "precondition: the parent reaches the docker socket");
  const dir = mkdtempSync(join(tmpdir(), "crow-pi-sandbox-"));
  mkdirSync(join(dir, "sessions"), { recursive: true });
  const stub = join(dir, "stub-pi.mjs");
  writeFileSync(stub, [
    'import { readFileSync } from "node:fs";',
    'import { execFileSync } from "node:child_process";',
    'import { connect } from "node:net";',
    'const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");',
    'const status = readFileSync("/proc/self/status", "utf8");',
    'const field = (k) => (status.match(new RegExp("^" + k + ":\\\\s*(.*)$", "m")) || [])[1] || "";',
    'let idG = ""; try { idG = execFileSync("id", ["-G"], { encoding: "utf8" }).trim(); } catch (e) { idG = "ERR " + e.message; }',
    'let parentEnv = "readable"; try { readFileSync("/proc/" + process.env.CROW_TEST_PARENT_PID + "/environ"); } catch (e) { parentEnv = e.code || "denied"; }',
    'let viaProc = false;',
    'const sock = process.env.CROW_TEST_SOCK;',
    'const tryConn = (p) => new Promise((r) => { const s = connect(p); const d = (v) => { try { s.destroy(); } catch {} r(v); };',
    '  s.once("connect", () => d(true)); s.once("error", () => d(false)); setTimeout(() => d(false), 2000); });',
    'const direct = await tryConn(sock);',
    'viaProc = await tryConn("/proc/" + process.env.CROW_TEST_PARENT_PID + "/root" + sock);',
    'out({ type: "report", idG, groups: field("Groups"), nnp: field("NoNewPrivs"), direct, viaProc, parentEnv, pid: process.pid });',
    'process.stdin.resume();',
  ].join("\n"));
  const prevEnv = { CROW_TEST_PARENT_PID: process.env.CROW_TEST_PARENT_PID, CROW_TEST_SOCK: process.env.CROW_TEST_SOCK };
  process.env.CROW_TEST_PARENT_PID = String(process.pid);
  process.env.CROW_TEST_SOCK = SOCKS[0];
  const pi = new PiRpc({
    def: {}, sessionDir: dir, resolved: { provider: "p", model: "m", key: "p/m" },
    nodeBin: process.execPath, cliPath: stub,
  });
  try {
    assert.equal(pi.sandboxed, true);
    const r = await pi.waitFor((m) => m.type === "report", 5000, "report");
    assert.ok(!r.idG.split(/\s+/).map(Number).includes(GID), "child id -G lacks the docker gid: " + r.idG);
    assert.equal(r.direct, false, "child cannot connect to " + SOCKS[0]);
    assert.equal(r.viaProc, false, "child cannot reach the socket through the parent's /proc/<pid>/root");
    assert.notEqual(r.parentEnv, "readable", "child cannot read the parent's /proc/<pid>/environ");
    assert.equal(r.nnp, "1", "no_new_privs is set (sudo/setuid cannot escalate)");
    assert.equal(pi.piPid, r.pid, "bwrap reports pi's own pid");
    assert.notEqual(pi.proc.pid, r.pid, "proc.pid is the wrapper");
    // The parent kept its docker access.
    assert.equal(await canConnect(SOCKS[0]), true, "the parent still reaches the docker socket");
  } finally {
    await pi.close();
    for (const [k, v] of Object.entries(prevEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wrapPiSpawn: off / auto-unavailable / required / available", () => {
  _resetPiSandboxForTest();
  const off = wrapPiSpawn("node", ["cli.js"], { mode: "off" });
  assert.deepEqual([off.cmd, off.args, off.sandboxed], ["node", ["cli.js"], false]);

  const bad = { ok: false, bwrap: null, reason: "bubblewrap (bwrap) is not installed" };
  const origErr = console.error; const msgs = []; console.error = (m) => msgs.push(String(m));
  try {
    const a = wrapPiSpawn("node", ["cli.js"], { mode: "auto", probe: bad });
    assert.equal(a.sandboxed, false);
    assert.equal(a.cmd, "node");
    wrapPiSpawn("node", ["cli.js"], { mode: "auto", probe: bad });
    assert.equal(msgs.filter((m) => m.includes("[pi-sandbox] WARNING")).length, 1, "warns once per process");
  } finally { console.error = origErr; }
  assert.throws(() => wrapPiSpawn("node", ["cli.js"], { mode: "required", probe: bad }), /required.*unavailable/);

  const good = { ok: true, bwrap: "/usr/bin/bwrap", reason: null };
  const w = wrapPiSpawn("/n/node", ["/x/cli.js", "--mode", "rpc"], { mode: "auto", probe: good, sockets: ["/run/docker.sock"], infoFd: 3 });
  assert.equal(w.sandboxed, true);
  assert.equal(w.cmd, "/usr/bin/bwrap");
  assert.deepEqual(w.args, ["--dev-bind", "/", "/", "--unshare-user", "--ro-bind", "/dev/null", "/run/docker.sock",
    "--info-fd", "3", "--", "/n/node", "/x/cli.js", "--mode", "rpc"]);
  _resetPiSandboxForTest();
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
  assert.ok(!victims.includes(100), "a live sandboxed pi under its gateway is left alone");
});
