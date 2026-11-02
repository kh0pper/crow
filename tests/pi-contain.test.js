// Queue item 19, step 2a: a PiRpc child in the contain tier. A stub pi
// reports what it can see and write; every probe is existence / open / write
// of a test-owned marker, never a read of a real file's contents.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, realpathSync, readdirSync, renameSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { probePiSandbox, _resetPiSandboxForTest } from "../scripts/pi-bots/pi_sandbox.mjs";
import { resolvePiCli } from "../scripts/pi-bots/pi_resolver.mjs";

const REPO = resolve(import.meta.dirname, "..");
_resetPiSandboxForTest();
const SANDBOX = probePiSandbox({ force: true });
const skip = SANDBOX.ok ? false : "bubblewrap unavailable: " + SANDBOX.reason;

// This file runs against its own scratch instance. The contain tier's agent
// dir is DOOR-ONLY (scripts/pi-bots/pi_contain_agent.mjs), so a contained
// spawn needs a providers row with a door, and the rows/consent come from this
// instance's crow.db — init-db in before() creates its schema. Only CROW_HOME
// and CROW_DATA_DIR move; the suite's other scratch paths are untouched.
const INST = mkdtempSync(join(tmpdir(), "crow-pi-contain-inst-"));
process.env.CROW_HOME = join(INST, "home");
process.env.CROW_DATA_DIR = join(INST, "data");
delete process.env.CROW_DB_PATH;
mkdirSync(process.env.CROW_HOME, { recursive: true });
mkdirSync(process.env.CROW_DATA_DIR, { recursive: true });

// One local row (bundle shape) stands in for the bot's provider.
const DOOR_ROW = "contain-test-local";
// A plain LAN endpoint nothing forwards for: the provider door does not serve it.
const LAN_ROW = "contain-test-lan";
async function openDoorRow() {
  const [{ CROW_DB }, { default: Database }] = await Promise.all([
    import("../scripts/pi-bots/bridge.mjs"), import("better-sqlite3"),
  ]);
  const conn = new Database(CROW_DB);
  try {
    conn.prepare("INSERT OR REPLACE INTO providers (id, base_url, models, host, disabled, bundle_id) VALUES (?, ?, ?, 'local', 0, ?)")
      .run(DOOR_ROW, "http://127.0.0.1:18299/v1", JSON.stringify([{ id: "m" }]), "contain-test-bundle");
  } finally { conn.close(); }
}
async function openLanRow() {
  const [{ CROW_DB }, { default: Database }] = await Promise.all([
    import("../scripts/pi-bots/bridge.mjs"), import("better-sqlite3"),
  ]);
  const conn = new Database(CROW_DB);
  try {
    conn.prepare("INSERT OR REPLACE INTO providers (id, base_url, models, host, disabled, bundle_id) VALUES (?, ?, ?, 'local', 0, NULL)")
      .run(LAN_ROW, "http://192.168.1.50:8099/v1", JSON.stringify([{ id: "m" }]));
  } finally { conn.close(); }
}
before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env }, stdio: "pipe", cwd: REPO });
  await openDoorRow();
});
after(() => rmSync(INST, { recursive: true, force: true }));

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
  // Probe files with unique names: this file's instance data dir is its own,
  // but the names keep a parallel run from ever colliding with a leftover.
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
  await openDoorRow();
  const { SYSCALLS } = await import("../scripts/pi-bots/pi_seccomp.mjs");
  testPaths.keyctlNr = (SYSCALLS[process.arch] || {}).keyctl ?? -1;
  const pi = new PiRpc({
    def: { bot_id: "contain-test-bot", permission_policy: { bash: "deny", write_paths: [out], read_paths: [notes] },
      spawn_env: { CROW_TEST_PATHS: JSON.stringify(testPaths) } },
    sessionDir: session, resolved: { provider: DOOR_ROW, model: "m", key: DOOR_ROW + "/m" }, nodeBin: process.execPath, cliPath: stub,
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

// ---- fix round 1 (F2): the no-door refusal, end to end through the bridge ----

test("integration: a provider row with no door fails the contain spawn with the exact reason", { skip, timeout: 30000 }, async () => {
  const { PiRpc } = await import("../scripts/pi-bots/bridge.mjs");
  const { ContainRefused } = await import("../scripts/pi-bots/pi_contain.mjs");
  process.env.CROW_PI_CONTAIN_BOTS = "contain-nodoor-bot";
  await openLanRow();
  const session = join(scratch, "session-nodoor"); mkdirSync(join(session, "sessions"), { recursive: true });
  assert.throws(() => new PiRpc({
    def: { bot_id: "contain-nodoor-bot", permission_policy: { bash: "deny", write_paths: [] } },
    sessionDir: session, resolved: { provider: LAN_ROW, model: "m", key: LAN_ROW + "/m" },
    nodeBin: process.execPath, cliPath: process.execPath,
  }), (e) => e instanceof ContainRefused && e.message === "contain refused: provider " + LAN_ROW + " has no door",
  "exactly the no-door refusal, naming the provider");
});

test("integration: with crow.db missing a contained spawn is refused (fail closed)", { skip, timeout: 30000 }, async () => {
  const { PiRpc, CROW_DB } = await import("../scripts/pi-bots/bridge.mjs");
  const { ContainRefused } = await import("../scripts/pi-bots/pi_contain.mjs");
  process.env.CROW_PI_CONTAIN_BOTS = "contain-nodb-bot";
  const aside = CROW_DB + ".away";
  rmSync(aside, { force: true });
  renameSync(CROW_DB, aside);   // no rows at all: no provider can have a door
  try {
    const session = join(scratch, "session-nodb"); mkdirSync(join(session, "sessions"), { recursive: true });
    assert.throws(() => new PiRpc({
      def: { bot_id: "contain-nodb-bot", permission_policy: { bash: "deny", write_paths: [] } },
      sessionDir: session, resolved: { provider: DOOR_ROW, model: "m", key: DOOR_ROW + "/m" },
      nodeBin: process.execPath, cliPath: process.execPath,
    }), (e) => e instanceof ContainRefused && e.message === "contain refused: provider " + DOOR_ROW + " has no door",
    "an unreadable instance database never widens the spawn");
  } finally {
    renameSync(aside, CROW_DB);
  }
});

const myShadows = () => { try { return readdirSync(join(process.env.CROW_HOME, "contain-run")).filter((e) => e.startsWith("crow-pi-agent-" + process.pid + "-")); } catch { return []; } };
async function waitGone(ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (!myShadows().length) return true; await new Promise((r) => setTimeout(r, 100)); }
  return false;
}

test("integration: the agent shadow (now a generated, key-free agent dir) is removed after close and after a pi that fails to start", { skip, timeout: 60000 }, async () => {
  const { PiRpc } = await import("../scripts/pi-bots/bridge.mjs");
  process.env.CROW_PI_CONTAIN_BOTS = "contain-clean-bot";
  await openDoorRow();
  const agent = join(scratch, "agent-c"); mkdirSync(agent, { recursive: true }); writeFileSync(join(agent, "settings.json"), "{}");
  process.env.PI_CODING_AGENT_DIR = agent;
  const session = join(scratch, "session-c"); mkdirSync(join(session, "sessions"), { recursive: true });
  const stub = join(scratch, "stub-ok.mjs"); writeFileSync(stub, 'process.stdout.write(JSON.stringify({type:"report"})+"\\n"); process.stdin.resume();');
  const def = { bot_id: "contain-clean-bot", permission_policy: { bash: "deny", write_paths: [] } };
  const pi = new PiRpc({ def, sessionDir: session, resolved: { provider: DOOR_ROW, model: "m", key: DOOR_ROW + "/m" }, nodeBin: process.execPath, cliPath: stub });
  await pi.waitFor((m) => m.type === "report", 20000, "report");
  assert.ok(myShadows().length >= 1, "a shadow exists while pi runs");
  await pi.close();
  assert.equal(await waitGone(), true, "removed after close");
  const bad = new PiRpc({ def, sessionDir: session, resolved: { provider: DOOR_ROW, model: "m", key: DOOR_ROW + "/m" }, nodeBin: join(scratch, "no-such-node"), cliPath: stub });
  await bad.exited;
  assert.equal(await waitGone(), true, "removed after a failed start");
});

// ---- fix round 1 (F3): one REAL pi turn through a /llm/p stub door ----
// This branch has no fake-model harness that drives a contained real pi, so
// this is the one place pi itself runs: it is skipped unless a real pi binary
// and bubblewrap are both available, and nothing about the pi side is stubbed.
// The door is a loopback HTTP stub; the generated models.json is what the
// bridge writes (door-only, $crowManaged, apiKey "none").
const realPiSkip = (() => resolvePiCli() ? null
  : "the real pi binary is not installed on this box (bot-engine bundle, repo dependency or global npm root)")();

test("integration: one real pi turn answers through a /llm/p stub door", { skip: skip || realPiSkip || false, timeout: 180000 }, async () => {
  const { PiRpc } = await import("../scripts/pi-bots/bridge.mjs");
  const { createServer } = await import("node:http");
  const REPLY = "containment-ok";

  // A free loopback port: containInputs reads the spawner's gateway port, and
  // the generated models.json points pi at /llm/p/<row>/v1 on it.
  const probe = createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  const savedPort = process.env.PORT;
  process.env.PORT = String(port);

  let doorHits = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const url = String(req.url || "");
      if (req.method === "GET" && /\/models\/?$/.test(url)) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [{ id: "m", object: "model" }] }));
        return;
      }
      if (!/^\/llm\/p\/[^/]+\/v1\/chat\/completions$/.test(url)) { res.writeHead(404, { "content-type": "application/json" }); res.end("{}"); return; }
      doorHits++;
      let stream = false;
      try { stream = JSON.parse(body || "{}").stream === true; } catch { /* not JSON */ }
      const base = { id: "chatcmpl-stub", created: 0, model: "m" };
      if (!stream) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ...base, object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: REPLY }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const chunk = (delta, finish) => "data: " + JSON.stringify({ ...base, object: "chat.completion.chunk",
        choices: [{ index: 0, delta, finish_reason: finish }] }) + "\n\n";
      res.write(chunk({ role: "assistant", content: REPLY }, null));
      res.write(chunk({}, "stop"));
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));

  process.env.CROW_PI_CONTAIN_BOTS = "contain-real-bot";
  await openDoorRow();
  const session = join(scratch, "session-real"); mkdirSync(join(session, "sessions"), { recursive: true });
  let pi = null;
  try {
    pi = new PiRpc({
      def: { bot_id: "contain-real-bot", permission_policy: { bash: "deny", write_paths: [] } },
      sessionDir: session, resolved: { provider: DOOR_ROW, model: "m", key: DOOR_ROW + "/m" },
    });
    assert.equal(pi.sandboxTier, "contain");
    await pi.promptTurn("Reply with a short acknowledgement.", 120000);
    assert.match(pi.assistantText(), new RegExp(REPLY), "the reply came from the stub door");
    assert.ok(doorHits >= 1, "the door really served the turn (pi is not faked)");
  } finally {
    if (pi) await pi.close();
    // A keep-alive socket pi left behind must not hold the stub server open.
    try { server.closeAllConnections?.(); } catch { /* none */ }
    await new Promise((r) => server.close(r));
    if (savedPort === undefined) delete process.env.PORT; else process.env.PORT = savedPort;
  }
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
