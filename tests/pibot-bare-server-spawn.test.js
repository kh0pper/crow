/**
 * A bare `crow_mcp` server entry, END TO END through the rails that spawn pi.
 *
 * bare-server-tools.mjs lists a bare server's tools and returns them as an explicit
 * snapshot. This file pins that the snapshot travels: the REAL prepareSpawn
 * (scripts/pi-bots/bot-world.mjs) primes, puts the map on piRpcOpts, and the child's
 * `--tools` csv carries `mcp__studio__<tool>` (not the bare `mcp__studio`); runJob
 * (job_runner.mjs) hands the same map to its PiRpc; and the eval seam's spawn-opts
 * check accepts (and compares) the key like any other plain-data option.
 *
 * Everything runs on scratch paths: a fake $HOME, a scratch CROW_HOME with one add-on
 * entry, a scratch models.json, an injected listing probe, and PiRpc's nodeBin/cliPath
 * stub for the actual spawn.
 */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Env BEFORE the modules load: model_resolver pins PI_MODELS_JSON at import time,
// skill_resolver reads HOME, and runJob reads the warm/delivery switches.
for (const k of Object.keys(process.env)) if (/^(PI_|PIBOT_)/.test(k)) delete process.env[k];
const DIR = mkdtempSync(join(tmpdir(), "crow-bare-spawn-"));
const CROW_HOME = join(DIR, "home");
process.env.HOME = join(DIR, "fakehome");
mkdirSync(process.env.HOME, { recursive: true });
mkdirSync(join(CROW_HOME, "data"), { recursive: true });
process.env.CROW_HOME = CROW_HOME;
process.env.CROW_DATA_DIR = join(CROW_HOME, "data");
delete process.env.CROW_DB_PATH;
// The warm call and the audience relay are loopback: point them at a closed port so
// they fail fast and never reach a real gateway.
process.env.PIBOT_WARM_GATEWAY_URL = "http://127.0.0.1:1";
process.env.PIBOT_WARM_TIMEOUT_MS = "1000";
process.env.CROW_GATEWAY_PORT = "1";
process.env.PIBOT_MCP_CONFIG_DELIVERY = "fd";
process.env.CROW_PI_SANDBOX = "off";
process.env.PI_MODELS_JSON = join(DIR, "models.json");
writeFileSync(process.env.PI_MODELS_JSON, JSON.stringify({ providers: { stub: { models: [{ id: "m1" }] } } }));
// The co-host scan must not read the HOST's /etc: empty scratch dirs instead.
const SCAN_UNITS = join(DIR, "scan-units");
const SCAN_ENV = join(DIR, "scan-etc-crow");
mkdirSync(SCAN_UNITS, { recursive: true });
mkdirSync(SCAN_ENV, { recursive: true });
const { _setSystemScanDirsForTest } = await import("../servers/shared/secret-values.js");
_setSystemScanDirsForTest({ unitDirs: [SCAN_UNITS], envFileDirs: [SCAN_ENV] });

// One add-on entry: the bare id "studio" this file expands.
const STUDIO_TOOLS = ["studio_play", "studio_status"];
mkdirSync(join(CROW_HOME, "bundles", "studio"), { recursive: true });
writeFileSync(join(CROW_HOME, "mcp-addons.json"), JSON.stringify({
  studio: { command: "node", args: ["server/index.js"], cwd: join(CROW_HOME, "bundles", "studio") },
}, null, 2));

const BST = await import("../scripts/pi-bots/bare-server-tools.mjs");
const { prepareSpawn } = await import("../scripts/pi-bots/bot-world.mjs");
const { runJob } = await import("../scripts/pi-bots/job_runner.mjs");
const { PiRpc, buildToolsCsv } = await import("../scripts/pi-bots/bridge.mjs");
const { defaultCompanionBudget } = await import("../scripts/pi-bots/artifacts-companions.mjs");

beforeEach(() => BST._resetBareServerToolsForTest());
after(() => { try { rmSync(DIR, { recursive: true, force: true }); } catch { /* gone */ } });

const RESOLVED = { provider: "stub", model: "m1" };
const def = () => ({ system_prompt: "x", tools: { pi_builtin: ["read"], crow_mcp: ["studio"] }, models: { default: "stub/m1" } });
/** The probe the rails must never really run in a test. */
const probed = () => {
  const state = { calls: 0 };
  state.probe = async () => { state.calls++; return { ok: true, tools: STUDIO_TOOLS.map((name) => ({ name })) }; };
  return state;
};

/** A hand-built world, the shape buildBotWorld returns (bridge.mjs passes it to prepareSpawn). */
function world() {
  const sessionDir = mkdtempSync(join(DIR, "session-"));
  mkdirSync(join(sessionDir, "sessions"), { recursive: true });
  return {
    def: def(), bot: { bot_id: "spawnbot", display_name: "Spawn" }, crowHome: CROW_HOME,
    projectId: null, projectSpace: null, projectMembers: [], sessionDir, cwd: sessionDir,
    mcpDelivery: "fd", mcpConfig: null, tasksDbPath: null, remoteEnabled: false,
    peerGatewayUrls: {}, session: null, botClassifier: null, narrowedTools: null,
    gatewayType: "perch", kitInstalled: false, houseStyle: null, extraReadPaths: [],
  };
}

/** Spawn the real PiRpc options against a stub pi that dumps argv. */
async function argvFor(prep) {
  const out = join(DIR, "argv-" + Date.now() + "-" + Math.random().toString(16).slice(2) + ".json");
  const stub = join(DIR, "stub-pi.mjs");
  writeFileSync(stub,
    'import { writeFileSync } from "node:fs";\n' +
    'writeFileSync(process.env.CROW_TEST_ARGV_OUT, JSON.stringify(process.argv.slice(2)));\n' +
    'process.exit(0);\n');
  const pi = new PiRpc({ ...prep.piRpcOpts, nodeBin: process.execPath, cliPath: stub,
    extraEnv: { ...(prep.piRpcOpts.extraEnv || {}), CROW_TEST_ARGV_OUT: out } });
  for (let i = 0; i < 100 && !existsSync(out); i++) await new Promise((r) => setTimeout(r, 50));
  try { pi.close(); } catch { /* already exited */ }
  assert.ok(existsSync(out), "stub pi never recorded its argv");
  const argv = JSON.parse(readFileSync(out, "utf8"));
  const at = argv.indexOf("--tools");
  return at === -1 ? undefined : argv[at + 1];
}

test("prepareSpawn primes, and the child's --tools carries the per-tool names, never mcp__studio", async () => {
  const p = probed();
  const prep = await prepareSpawn(world(), { probe: p.probe });
  assert.equal(p.calls, 1, "the rail lists the server once, before the spawn");
  assert.deepEqual(prep.piRpcOpts.bareServerTools, { studio: STUDIO_TOOLS },
    "the snapshot the budget check and the spawn share is on piRpcOpts");
  const csv = await argvFor(prep);
  const names = String(csv || "").split(",");
  for (const t of STUDIO_TOOLS) assert.ok(names.includes("mcp__studio__" + t), String(csv));
  assert.ok(!names.includes("mcp__studio"), "the bare entry matches no tool pi-lab registers: " + String(csv));
  assert.ok(names.includes("read"), "the def's builtin is untouched");
});

test("prepareSpawn without a listing still spawns with mcp__studio (and {} on the options)", async () => {
  const prep = await prepareSpawn(world(), { probe: async () => ({ ok: false, error: "not up" }) });
  assert.deepEqual(prep.piRpcOpts.bareServerTools, {}, "always present, empty when nothing was listed");
  assert.equal(await argvFor(prep), "read,mcp__studio");
});

test("runJob hands its PiRpc the same listing snapshot", async () => {
  const p = probed();
  const seen = {};
  class FakePiRpc {
    constructor(o) { seen.opts = o; }
    async getState() { return { data: { sessionId: "s1" } }; }
    async getSessionStats() { return null; }
    async prompt() {}
    assistantText() { return "done"; }
    toolCalls() { return []; }
    async close() {}
  }
  const bridge = {
    loadBot: () => ({ bot_id: "jobbot", display_name: "Job", def: def(), project_id: null }),
    PiRpc: FakePiRpc,
  };
  const repoSkillsDir = mkdtempSync(join(DIR, "repo-skills-"));
  const r = await runJob({ job_id: "j1", bot_id: "jobbot", goal: "work", escalate: 0 },
    { bridge, repoSkillsDir, probe: p.probe });
  assert.equal(r.result, "done");
  assert.equal(p.calls, 1, "the job rail lists the bare server once");
  assert.deepEqual(seen.opts.bareServerTools, { studio: STUDIO_TOOLS },
    "the constructor received the listing, not a cache it would have to re-read");
  // What PiRpc's own assembly does with those options: the same per-tool names.
  const csv = buildToolsCsv(seen.opts.def, { ...seen.opts, interactive: true }).csv;
  for (const t of STUDIO_TOOLS) assert.ok(csv.split(",").includes("mcp__studio__" + t), csv);
});

test("the eval seam's spawn-opts check clones and compares bareServerTools like any plain key", async () => {
  const { cloneSpawnOpts, checkEvalSpawnOpts } = await import("../scripts/lib/eval-guard.mjs");
  const { realish } = await import("../scripts/lib/protected-paths.mjs");
  const sealed = realish(CROW_HOME);
  const original = {
    def: def(), sessionDir: join(DIR, "seam"), resolved: RESOLVED,
    narrowedTools: ["read"], appendSystemPromptFile: "/base.md",
    bareServerTools: { studio: STUDIO_TOOLS.slice() },
  };
  const clone = cloneSpawnOpts(original);
  assert.ok(Object.hasOwn(clone, "bareServerTools"), "the key survives the clone");
  assert.notEqual(clone.bareServerTools, original.bareServerTools, "as a private copy, not a shared reference");
  assert.deepEqual(clone.bareServerTools, original.bareServerTools);
  assert.equal(checkEvalSpawnOpts(original, clone, clone, sealed), "/base.md",
    "an unchanged clone passes the spawn-opts check with the key present");
  // The key is part of the compared set: changing it, or adding it, is refused.
  assert.throws(() => checkEvalSpawnOpts(original, clone,
    { ...clone, bareServerTools: { studio: ["read"] } }, sealed), /key bareServerTools was changed/);
  assert.throws(() => checkEvalSpawnOpts(original, clone,
    (() => { const { bareServerTools, ...rest } = clone; return rest; })(), sealed), /key bareServerTools was removed/);
  const empty = { def: {}, bareServerTools: {} };
  assert.equal(checkEvalSpawnOpts(empty, cloneSpawnOpts(empty), cloneSpawnOpts(empty), sealed), undefined,
    "an empty snapshot is plain data too");
});

test("defaultCompanionBudget counts the expanded names, with or without a caller's snapshot", async () => {
  const d = def();
  const perTool = { tools: { pi_builtin: ["read"], crow_mcp: STUDIO_TOOLS.map((t) => "studio/" + t) }, models: { default: "stub/m1" } };
  const expanded = (await defaultCompanionBudget(d, { bareServerTools: { studio: STUDIO_TOOLS } })).countFor(d);
  const writtenOut = (await defaultCompanionBudget(perTool)).countFor(perTool);
  const primed = (await defaultCompanionBudget(d, { crowHome: CROW_HOME, probe: probed().probe })).countFor(d);
  assert.equal(expanded, writtenOut, "the same tool set counts the same, whichever way it is spelled");
  assert.equal(primed, writtenOut,
    "no snapshot: it primes the listing itself (F1), so the expanded names are counted too");
});