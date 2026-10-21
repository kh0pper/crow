// Queue item 19, step 2a: a PiRpc child in the contain tier. A stub pi
// reports what it can see and write; every probe is existence / open / write
// of a test-owned marker, never a read of a real file's contents.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, realpathSync, readdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { probePiSandbox, _resetPiSandboxForTest } from "../scripts/pi-bots/pi_sandbox.mjs";

const REPO = resolve(import.meta.dirname, "..");
_resetPiSandboxForTest();
const SANDBOX = probePiSandbox({ force: true });
const skip = SANDBOX.ok ? false : "bubblewrap unavailable: " + SANDBOX.reason;

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "crow-pi-contain-")));
const saved = { bots: process.env.CROW_PI_CONTAIN_BOTS, agent: process.env.PI_CODING_AGENT_DIR, sb: process.env.CROW_PI_SANDBOX };
after(() => {
  for (const [k, v] of [["CROW_PI_CONTAIN_BOTS", saved.bots], ["PI_CODING_AGENT_DIR", saved.agent], ["CROW_PI_SANDBOX", saved.sb]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  rmSync(scratch, { recursive: true, force: true });
});

test("integration: a contained PiRpc child sees only its engine, its paths and its data; the host stays out of reach", { skip, timeout: 60000 }, async () => {
  const { PiRpc, CROW_DB } = await import("../scripts/pi-bots/bridge.mjs");
  const dataDir = dirname(CROW_DB);
  assert.ok(dataDir.startsWith(tmpdir()) || dataDir.includes("crow-suite"), "suite scratch data dir: " + dataDir);
  mkdirSync(dataDir, { recursive: true });
  // Probe files with unique names: the suite's scratch data dir is shared by
  // test files running in parallel (never overwrite identity.json there).
  const probeData = join(dataDir, `contain-probe-${process.pid}.json`);
  writeFileSync(probeData, "FAKE-IDENTITY");
  const crowHome = process.env.CROW_HOME;
  const probeToken = join(crowHome, `contain-probe-${process.pid}-token`);
  writeFileSync(probeToken, "FAKE-TOKEN");

  const agent = join(scratch, "agent");
  mkdirSync(join(agent, "pkg"), { recursive: true });
  mkdirSync(join(agent, "sessions"), { recursive: true });
  writeFileSync(join(agent, "settings.json"), "{}");
  writeFileSync(join(agent, "sessions", "operator-session.jsonl"), "x");
  const session = join(scratch, "session"); mkdirSync(join(session, "sessions"), { recursive: true });
  const out = join(scratch, "out"); mkdirSync(out);
  const notes = join(scratch, "notes"); mkdirSync(notes); writeFileSync(join(notes, "n.txt"), "note");
  const hidden = join(scratch, "hidden"); mkdirSync(hidden); writeFileSync(join(hidden, "h.txt"), "h");

  const stub = join(scratch, "stub-pi.mjs");
  writeFileSync(stub, [
    'import { existsSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";',
    'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
    'import { homedir } from "node:os";',
    'import { join } from "node:path";',
    'const P = JSON.parse(process.env.CROW_TEST_PATHS);',
    'const tryW = (p) => { try { writeFileSync(p, "w"); return "ok"; } catch (e) { return e.code; } };',
    'const tryR = (p) => { try { return readFileSync(p, "utf8"); } catch (e) { return "ERR:" + e.code; } };',
    'const r = {',
    '  ssh: existsSync(join(homedir(), ".ssh")), claude: existsSync(join(homedir(), ".claude")),',
    '  hidden: existsSync(P.hidden), boardToken: existsSync(P.boardToken),',
    '  identity: tryR(P.identity), agentSessions: existsSync(P.agentSessions),',
    '  checkoutWrite: tryW(join(P.repo, "contain-probe.txt")), repoReadable: existsSync(join(P.repo, "package.json")),',
    '  outWrite: tryW(join(P.out, "o.txt")), notesRead: tryR(join(P.notes, "n.txt")), notesWrite: tryW(join(P.notes, "x.txt")),',
    '  dataWrite: tryW(join(P.data, "probe.txt")), sessionWrite: tryW(join(P.session, "s.txt")),',
    '  agentLock: (() => { try { mkdirSync(join(P.agent, "settings.json.lock")); return "ok"; } catch (e) { return e.code; } })(),',
    '  tmpEmpty: true, etcCrow: existsSync("/etc/crow") ? "present" : "absent",',
    '  cache: process.env.npm_config_cache || null,',
    '  signal: (() => { try { process.kill(P.sentinel, 0); return "reached"; } catch (e) { return e.code; } })(),',
    '  resolv: existsSync("/etc/resolv.conf"),',
    '  keyctl: (() => { try { return require("child_process").execFileSync("python3", ["-c", "import ctypes,os;l=ctypes.CDLL(None,use_errno=True);r=l.syscall(" + P.keyctlNr + ",0,0);print(\'ok\' if r>=0 else os.strerror(ctypes.get_errno()))"]).toString().trim(); } catch (e) { return "noexec:" + e.code; } })(),',
    '};',
    'process.stdout.write(JSON.stringify({ type: "report", ...r }) + "\\n");',
    'process.stdin.resume();',
  ].join("\n"));

  process.env.CROW_PI_CONTAIN_BOTS = "contain-test-bot";
  process.env.PI_CODING_AGENT_DIR = agent;
  delete process.env.CROW_PI_SANDBOX;
  const testPaths = { hidden, boardToken: probeToken, identity: probeData,
    agentSessions: join(agent, "sessions", "operator-session.jsonl"), repo: REPO, out, notes, data: dataDir, session, agent };
  const { spawn: spawnSentinel } = await import("node:child_process");
  const sentinel = spawnSentinel("sleep", ["60"], { stdio: "ignore" });
  testPaths.sentinel = sentinel.pid;
  const { SYSCALLS } = await import("../scripts/pi-bots/pi_seccomp.mjs");
  testPaths.keyctlNr = (SYSCALLS[process.arch] || {}).keyctl ?? -1;
  const pi = new PiRpc({
    def: { bot_id: "contain-test-bot", permission_policy: { bash: "deny", write_paths: [out], read_paths: [notes] },
      spawn_env: { CROW_TEST_PATHS: JSON.stringify(testPaths) } },
    sessionDir: session, resolved: { provider: "p", model: "m", key: "p/m" }, nodeBin: process.execPath, cliPath: stub,
  });
  try {
    const { seccompSupported } = await import("../scripts/pi-bots/pi_seccomp.mjs");
    assert.equal(pi.sandboxTier, seccompSupported() ? "contain" : "contain-noseccomp");
    const r = await pi.waitFor((m) => m.type === "report", 20000, "report");
    assert.equal(r.ssh, false, "~/.ssh is not in the sandbox");
    assert.equal(r.claude, false, "~/.claude is not in the sandbox");
    assert.equal(r.hidden, false, "a host dir outside the bot's paths does not exist inside");
    assert.equal(r.boardToken, false, "CROW_HOME's *-token files are not bound");
    assert.ok(r.identity === "" || r.identity === "ERR:EACCES", "a non-DB data entry is masked (empty or unreadable): " + r.identity);
    assert.notEqual(r.identity, "FAKE-IDENTITY");
    assert.equal(r.agentSessions, false, "the operator's pi sessions are not visible");
    assert.equal(r.repoReadable, true, "the checkout is readable");
    assert.equal(r.checkoutWrite, "EROFS", "the checkout is read-only");
    assert.equal(r.outWrite, "ok", "write_paths are writable");
    assert.equal(r.notesRead, "note", "read_paths are readable");
    assert.equal(r.notesWrite, "EROFS", "read_paths are read-only");
    assert.equal(r.dataWrite, "ok", "the instance data dir is writable (MCP servers open the DB)");
    assert.equal(r.sessionWrite, "ok");
    assert.equal(r.agentLock, "ok", "pi can make its lock dirs in the agent shadow");
    assert.equal(r.etcCrow, existsSync("/etc/crow") ? "present" : "absent", "/etc/crow is an empty tmpfs when present");
    assert.ok(r.cache && r.cache.startsWith(join(crowHome, "bot-cache")));
    assert.ok(!existsSync(join(REPO, "contain-probe.txt")));
    assert.ok(!existsSync(join(agent, "settings.json.lock")), "the lock went to the shadow, not the real agent dir");
    assert.ok(existsSync(join(out, "o.txt")));
    assert.equal(r.signal, "ESRCH", "a same-uid host process cannot even be signalled (own pid namespace)");
    assert.equal(r.resolv, existsSync("/etc/resolv.conf"), "the resolver config resolves inside as it does outside");
    if (existsSync("/usr/bin/python3") && pi.sandboxTier === "contain") assert.match(r.keyctl, /Operation not permitted/, "the seccomp filter is live: " + r.keyctl);
  } finally {
    try { sentinel.kill("SIGKILL"); } catch {}
    await pi.close();
    rmSync(probeData, { force: true }); rmSync(probeToken, { force: true });
  }
});

test("integration: bypass mode cannot be contained: the spawn throws and leaves no shadow", { skip, timeout: 30000 }, async () => {
  const { PiRpc } = await import("../scripts/pi-bots/bridge.mjs");
  process.env.CROW_PI_CONTAIN_BOTS = "contain-bypass-bot";
  const runDir = join(process.env.CROW_HOME, "contain-run");
  const list = () => { try { return readdirSync(runDir).filter((e) => e.startsWith("crow-pi-agent-")); } catch { return []; } };
  const before = new Set(list());
  const session = join(scratch, "session-b"); mkdirSync(join(session, "sessions"), { recursive: true });
  assert.throws(() => new PiRpc({
    def: { bot_id: "contain-bypass-bot", permission_policy: { bash: "deny", write_paths: [] } },
    sessionDir: session, resolved: { provider: "p", model: "m", key: "p/m" }, nodeBin: process.execPath,
    cliPath: join(scratch, "nope.mjs"), permissionMode: "bypass",
  }), /cannot run in the contain tier/);
  const after_ = list().filter((e) => !before.has(e));
  assert.deepEqual(after_, [], "the agent shadow was removed");
});

const myShadows = () => { try { return readdirSync(join(process.env.CROW_HOME, "contain-run")).filter((e) => e.startsWith("crow-pi-agent-" + process.pid + "-")); } catch { return []; } };
async function waitGone(ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (!myShadows().length) return true; await new Promise((r) => setTimeout(r, 100)); }
  return false;
}

test("integration: the agent shadow (it holds a copy of the provider keys) is removed after close and after a pi that fails to start", { skip, timeout: 60000 }, async () => {
  const { PiRpc } = await import("../scripts/pi-bots/bridge.mjs");
  process.env.CROW_PI_CONTAIN_BOTS = "contain-clean-bot";
  const agent = join(scratch, "agent-c"); mkdirSync(agent, { recursive: true }); writeFileSync(join(agent, "settings.json"), "{}");
  process.env.PI_CODING_AGENT_DIR = agent;
  const session = join(scratch, "session-c"); mkdirSync(join(session, "sessions"), { recursive: true });
  const stub = join(scratch, "stub-ok.mjs"); writeFileSync(stub, 'process.stdout.write(JSON.stringify({type:"report"})+"\\n"); process.stdin.resume();');
  const def = { bot_id: "contain-clean-bot", permission_policy: { bash: "deny", write_paths: [] } };
  const pi = new PiRpc({ def, sessionDir: session, resolved: { provider: "p", model: "m", key: "p/m" }, nodeBin: process.execPath, cliPath: stub });
  await pi.waitFor((m) => m.type === "report", 20000, "report");
  assert.ok(myShadows().length >= 1, "a shadow exists while pi runs");
  await pi.close();
  assert.equal(await waitGone(), true, "removed after close");
  const bad = new PiRpc({ def, sessionDir: session, resolved: { provider: "p", model: "m", key: "p/m" }, nodeBin: join(scratch, "no-such-node"), cliPath: stub });
  await bad.exited;
  assert.equal(await waitGone(), true, "removed after a failed start");
});

test("sweepStaleContainDirs removes dirs of dead spawners only", async () => {
  const { sweepStaleContainDirs } = await import("../scripts/pi-bots/pi_contain.mjs");
  const parent = join(scratch, "sweep"); mkdirSync(parent);
  mkdirSync(join(parent, "crow-pi-agent-999999998-abc"));
  mkdirSync(join(parent, "crow-pi-net-999999998-abc"));
  mkdirSync(join(parent, `crow-pi-agent-${process.pid}-abc`));
  mkdirSync(join(parent, "crow-pi-agent-1-abc"));
  mkdirSync(join(parent, "unrelated-999999998"));
  assert.equal(sweepStaleContainDirs({ parent }), 2);
  assert.deepEqual(readdirSync(parent).sort(), [`crow-pi-agent-${process.pid}-abc`, "crow-pi-agent-1-abc", "unrelated-999999998"].sort());
});

test("spawn_env cannot carry loader hooks (LD_*, NODE_OPTIONS beyond heap size, NODE_PATH)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../scripts/pi-bots/bridge.mjs", import.meta.url), "utf8");
  assert.match(src, /\^LD_\|\^DYLD_/);
  assert.match(src, /k === "NODE_OPTIONS" && !\//);
});
