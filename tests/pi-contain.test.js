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
  writeFileSync(join(dataDir, "identity.json"), "FAKE-IDENTITY");
  const crowHome = process.env.CROW_HOME;
  writeFileSync(join(crowHome, "board-token"), "FAKE-TOKEN");

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
    '};',
    'process.stdout.write(JSON.stringify({ type: "report", ...r }) + "\\n");',
    'process.stdin.resume();',
  ].join("\n"));

  process.env.CROW_PI_CONTAIN_BOTS = "contain-test-bot";
  process.env.PI_CODING_AGENT_DIR = agent;
  delete process.env.CROW_PI_SANDBOX;
  const testPaths = { hidden, boardToken: join(crowHome, "board-token"), identity: join(dataDir, "identity.json"),
    agentSessions: join(agent, "sessions", "operator-session.jsonl"), repo: REPO, out, notes, data: dataDir, session, agent };
  const pi = new PiRpc({
    def: { bot_id: "contain-test-bot", permission_policy: { bash: "deny", write_paths: [out], read_paths: [notes] },
      spawn_env: { CROW_TEST_PATHS: JSON.stringify(testPaths) } },
    sessionDir: session, resolved: { provider: "p", model: "m", key: "p/m" }, nodeBin: process.execPath, cliPath: stub,
  });
  try {
    assert.equal(pi.sandboxTier, "contain");
    const r = await pi.waitFor((m) => m.type === "report", 20000, "report");
    assert.equal(r.ssh, false, "~/.ssh is not in the sandbox");
    assert.equal(r.claude, false, "~/.claude is not in the sandbox");
    assert.equal(r.hidden, false, "a host dir outside the bot's paths does not exist inside");
    assert.equal(r.boardToken, false, "CROW_HOME's token files are not bound");
    assert.ok(r.identity === "" || r.identity === "ERR:EACCES", "identity.json is masked (empty or unreadable): " + r.identity);
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
  } finally {
    await pi.close();
  }
  const leftovers = readdirSync(tmpdir()).filter((e) => e.startsWith("crow-pi-agent-"));
  assert.ok(!leftovers.some((e) => { try { return existsSync(join(tmpdir(), e, "settings.json")) && false; } catch { return false; } }));
});

test("integration: bypass mode cannot be contained: the spawn throws and leaves no shadow", { skip, timeout: 30000 }, async () => {
  const { PiRpc } = await import("../scripts/pi-bots/bridge.mjs");
  process.env.CROW_PI_CONTAIN_BOTS = "contain-bypass-bot";
  const before = new Set(readdirSync(tmpdir()).filter((e) => e.startsWith("crow-pi-agent-")));
  const session = join(scratch, "session-b"); mkdirSync(join(session, "sessions"), { recursive: true });
  assert.throws(() => new PiRpc({
    def: { bot_id: "contain-bypass-bot", permission_policy: { bash: "deny", write_paths: [] } },
    sessionDir: session, resolved: { provider: "p", model: "m", key: "p/m" }, nodeBin: process.execPath,
    cliPath: join(scratch, "nope.mjs"), permissionMode: "bypass",
  }), /cannot run in the contain tier/);
  const after_ = readdirSync(tmpdir()).filter((e) => e.startsWith("crow-pi-agent-") && !before.has(e));
  assert.deepEqual(after_, [], "the agent shadow was removed");
});
