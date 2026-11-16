/**
 * Phase 1 bot↔project shares, Task 10 — workspace-file reach at spawn.
 *
 * A share row grants a bot a project at `read` or `read_write`. What a bot's
 * NATIVE FILE TOOLS can reach is decided by the read_paths/write_paths pi is
 * spawned with, so the share's `project_spaces.workspace_dir` becomes:
 *
 *   - a read root for every live, non-suspended share (either level);
 *   - a write root as well, ONLY for `read_write`.
 *
 * A suspended share (either side has an outside member), a revoked one, one
 * whose project is archived/tombstoned, and one with no workspace_dir add
 * nothing — and none of them may break a spawn.
 *
 * The boundary this file pins (and the code documents): file-system reach
 * follows the share at the NEXT SPAWN, because pi's roots are fixed when the
 * child starts. The MCP tools are a different path — rechecked on every call
 * (servers/shared/project-bot-shares.js resolveBotAccess), covered by the
 * share-store suites, not here.
 *
 * Hermetic: CROW_DATA_DIR/CROW_HOME/HOME are scratch, the bot engine is a stub.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

// Hermetic env: an ambient PI_*/PIBOT_* var would otherwise reach the stub.
for (const k of Object.keys(process.env)) {
  if (/^(PI_|PIBOT_)/.test(k)) delete process.env[k];
}

const dir = realpathSync(mkdtempSync(join(tmpdir(), "share-roots-")));
process.env.CROW_DATA_DIR = dir;
process.env.CROW_HOME = join(dir, "home");
delete process.env.CROW_DB_PATH;
// No sandbox wrapper: the stub must be the process pi is handed.
process.env.CROW_PI_SANDBOX = "off";
process.env.PIBOT_MAX_PI = "99";
process.env.PIBOT_WARM_GATEWAY_URL = "http://127.0.0.1:1";
process.env.PIBOT_WARM_TIMEOUT_MS = "1500";
process.env.PIBOT_PROMPT_ACK_TIMEOUT_MS = "8000";
process.env.PIBOT_TURN_TIMEOUT_MS = "8000";
process.env.PI_MODELS_JSON = join(dir, "models.json");
mkdirSync(join(process.env.CROW_HOME, "skills"), { recursive: true });
writeFileSync(process.env.PI_MODELS_JSON, JSON.stringify({ providers: { stub: { models: [{ id: "m1" }] } } }));
// mcp_writer pins the canonical config path at module load; give it a scratch
// HOME with a readable one.
process.env.HOME = join(dir, "fakehome");
mkdirSync(join(process.env.HOME, ".pi", "agent"), { recursive: true });
writeFileSync(join(process.env.HOME, ".pi", "agent", "mcp.json"), JSON.stringify({ mcpServers: {} }));

const DB_FILE = join(dir, "crow.db");
const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

// ---- the recording protocol stub -------------------------------------------
const STUB_PI = join(dir, "stub-pi.mjs");
writeFileSync(STUB_PI, [
  'import { writeFileSync, readFileSync, closeSync } from "node:fs";',
  'const env = {};',
  'for (const k of Object.keys(process.env).sort()) if (/^(PI_|PIBOT_)/.test(k)) env[k] = process.env[k];',
  'const cap = { argv: process.argv.slice(2), env, cwd: process.cwd(), cfgText: null };',
  'const fdKey = process.env.PI_BOT_MCP_CONFIG_FD;',
  'if (fdKey) { try { cap.cfgText = readFileSync(Number(fdKey), "utf8"); } catch { cap.cfgText = null; }',
  '  try { closeSync(Number(fdKey)); } catch {} }',
  'const flush = () => writeFileSync(process.env.PIBOT_TEST_CAPTURE, JSON.stringify(cap));',
  'flush();',
  'const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");',
  'let buf = "";',
  'process.stdin.on("data", (chunk) => {',
  '  buf += chunk.toString("utf8");',
  '  let nl;',
  '  while ((nl = buf.indexOf("\\n")) >= 0) {',
  '    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);',
  '    if (!line.trim()) continue;',
  '    let m; try { m = JSON.parse(line); } catch { continue; }',
  '    if (m.type === "get_state") out({ type: "response", command: "get_state", data: { sessionId: "share-uuid" } });',
  '    else if (m.type === "get_session_stats") out({ type: "response", command: "get_session_stats", id: m.id, data: { tokens: { input: 1, output: 1, cacheRead: 0 } } });',
  '    else if (m.type === "prompt") { out({ type: "response", command: "prompt" });',
  '      out({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }] }); }',
  '    else if (m.type === "abort") out({ type: "response", command: "abort" });',
  '  }',
  '});',
  'process.stdin.resume();',
  '',
].join("\n"));
process.env.PIBOT_PI_CLI = STUB_PI;

const { handleInbound, PiRpc, loadBotShares } = await import("../scripts/pi-bots/bridge.mjs");
const { buildBotWorld, prepareSpawn, shareWorkspaceRoots } = await import("../scripts/pi-bots/bot-world.mjs");
const { effectiveReadPaths } = await import("../scripts/pi-bots/bot-read-paths.mjs");
const { buildContainPlan, ContainRefused } = await import("../scripts/pi-bots/pi_contain.mjs");
const { createInteractiveEngine, _resetInteractiveEngineForTest } = await import("../servers/gateway/perch-interactive.js");

// ---- fixture ----------------------------------------------------------------
const ws = (name) => join(dir, "projects", name, "workspace");
const W_HOME = ws("home");
const W_X = ws("shared-x");
const W_ARCH = ws("archived");
const W_TOMB = ws("tombstoned");
const W_SUSP = ws("suspended");

const P_HOME = 201, P_X = 202, P_ARCH = 203, P_TOMB = 204, P_NOWS = 205, P_SUSP = 206;

const baseDef = () => ({
  system_prompt: "You are a test bot.",
  models: { default: "stub/m1" },
  tools: { pi_builtin: ["read"], crow_mcp: [] },
  permission_policy: { bash: "deny", write_paths: [] },
  gateways: [{ type: "gmail" }],
  tracker_config: { type: "none" },
});

before(() => {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: REPO,
  });
  for (const d of [W_HOME, W_X, W_ARCH, W_TOMB, W_SUSP]) mkdirSync(d, { recursive: true });
  const c = new Database(DB_FILE);
  const proj = c.prepare("INSERT INTO project_spaces (id, slug, name, workspace_dir, status, archived_at) VALUES (?,?,?,?,?,?)");
  proj.run(P_HOME, "home", "Home", W_HOME, "active", null);
  proj.run(P_X, "shared-x", "Shared X", W_X, "active", null);
  proj.run(P_ARCH, "archived-one", "Archived One", W_ARCH, "archived", null);
  proj.run(P_TOMB, "tombstoned-one", "Tombstoned One", W_TOMB, "active", "2026-01-01 00:00:00");
  proj.run(P_NOWS, "no-workspace", "No Workspace", null, "active", null);
  proj.run(P_SUSP, "suspended-one", "Suspended One", W_SUSP, "active", null);

  const ins = c.prepare("INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES (?,?,?,?,?)");
  const def = (id) => JSON.stringify({ ...baseDef(), session_dir: join(dir, "bots", id) });
  for (const id of ["reader", "writer", "suspended", "arch", "tomb", "nows", "revoked", "nothing", "deadbot"]) {
    ins.run(id, id, def(id), 1, P_HOME);
  }
  ins.run("homeless", "homeless", def("homeless"), 1, null);

  // An outside member on the project the "suspended" bot is shared: while that
  // row is active the share is suspended on the PROJECT side.
  c.prepare("INSERT INTO contacts (id, crow_id, display_name, ed25519_pubkey, secp256k1_pubkey) VALUES (?,?,?,?,?)")
    .run(9001, "crow-guest", "Guest", "ed25519-fixture", "secp-fixture");
  c.prepare("INSERT INTO project_members (project_id, contact_id, role) VALUES (?,?,?)").run(P_SUSP, 9001, "editor");

  const share = c.prepare("INSERT INTO project_bot_shares (project_id, bot_id, level, revoked_at) VALUES (?,?,?,?)");
  share.run(P_X, "reader", "read", null);
  share.run(P_X, "writer", "read_write", null);
  share.run(P_SUSP, "suspended", "read", null);
  share.run(P_ARCH, "arch", "read", null);
  share.run(P_TOMB, "tomb", "read", null);
  share.run(P_NOWS, "nows", "read_write", null);
  share.run(P_X, "revoked", "read", "2026-01-02 00:00:00");
  share.run(P_X, "deadbot", "read", null);
  c.close();
});

after(() => { rmSync(dir, { recursive: true, force: true }); });

beforeEach(() => { if (_resetInteractiveEngineForTest) _resetInteractiveEngineForTest(); });

let capFile = null;
function arm(leg) {
  capFile = join(dir, "cap-" + leg + ".json");
  if (existsSync(capFile)) rmSync(capFile);
  process.env.PIBOT_TEST_CAPTURE = capFile;
}
const readCap = () => JSON.parse(readFileSync(capFile, "utf8"));
const policyOf = (cap) => JSON.parse(cap.env.PI_BOT_PERMISSION_POLICY);

/** One real channel turn; returns what pi was handed. */
async function channelTurn(botId, leg) {
  arm(leg);
  const r = await handleInbound({
    bot_id: botId, gateway_thread_id: "t-" + leg, gateway_type: "gmail", user_message: "hi",
    sendReply: async () => {}, log: () => {},
  });
  assert.equal(r.action, "asked", "the turn completed against the stub: " + JSON.stringify(r));
  return readCap();
}

/** A direct PiRpc spawn (the permissionMode bypass seam channel turns never set). */
async function directSpawn(leg, opts) {
  arm(leg);
  const pi = new PiRpc(Object.assign({
    nodeBin: process.execPath, cliPath: STUB_PI,
  }, opts));
  try { await pi.getState(); } finally { try { await pi.close(); } catch { /* exiting */ } }
  return readCap();
}

// ---------------------------------------------------------------------------
// loadBotShares — the spend-side read of the share tables
// ---------------------------------------------------------------------------

test("loadBotShares returns the live shares with name, level, workspace_dir and suspension", () => {
  assert.deepEqual(loadBotShares("reader"), [
    { project_id: P_X, level: "read", workspace_dir: W_X, name: "Shared X", suspended: false },
  ]);
  assert.deepEqual(loadBotShares("writer"), [
    { project_id: P_X, level: "read_write", workspace_dir: W_X, name: "Shared X", suspended: false },
  ]);
  const susp = loadBotShares("suspended");
  assert.equal(susp.length, 1);
  assert.equal(susp[0].project_id, P_SUSP);
  assert.equal(susp[0].suspended, true, "an outside member on the shared project suspends the share");
  assert.deepEqual(loadBotShares("nothing"), []);
  assert.deepEqual(loadBotShares("no-such-bot"), []);
  assert.deepEqual(loadBotShares(null), []);
});

test("loadBotShares leaves out a revoked share, an archived project, a tombstoned project, and a dead bot def", () => {
  assert.deepEqual(loadBotShares("revoked"), [], "revoked_at set => not live");
  assert.deepEqual(loadBotShares("arch"), [], "status='archived' => no access");
  assert.deepEqual(loadBotShares("tomb"), [], "archived_at set => no access");
  const c = new Database(DB_FILE);
  c.prepare("DELETE FROM pi_bot_defs WHERE bot_id = ?").run("deadbot");
  c.close();
  assert.deepEqual(loadBotShares("deadbot"), [], "a share whose bot def is gone resolves to nothing");
  // ...and the row itself is untouched, so re-creating the bot would not silently inherit it.
  const c2 = new Database(DB_FILE);
  assert.equal(c2.prepare("SELECT COUNT(*) AS n FROM project_bot_shares WHERE bot_id='deadbot'").get().n, 1);
  c2.close();
});

test("loadBotShares never throws: a missing table (older DB) is 'no shares'", () => {
  const c = new Database(DB_FILE);
  c.exec("ALTER TABLE project_bot_shares RENAME TO project_bot_shares_gone");
  c.close();
  try {
    assert.deepEqual(loadBotShares("reader"), []);
  } finally {
    const c2 = new Database(DB_FILE);
    c2.exec("ALTER TABLE project_bot_shares_gone RENAME TO project_bot_shares");
    c2.close();
  }
  assert.equal(loadBotShares("reader").length, 1, "and the live row is back afterwards");
});

test("shareWorkspaceRoots: read roots for both levels, a write root only for read_write, and nothing for a suspended/unusable row", () => {
  assert.deepEqual(shareWorkspaceRoots([
    { project_id: 1, level: "read", workspace_dir: "/w/one", suspended: false },
    { project_id: 2, level: "read_write", workspace_dir: "/w/two", suspended: false },
  ]), { read: ["/w/one", "/w/two"], write: ["/w/two"] });
  assert.deepEqual(shareWorkspaceRoots([
    { project_id: 3, level: "read_write", workspace_dir: "/w/three", suspended: true },
    { project_id: 4, level: "read_write", workspace_dir: null, suspended: false },
    { project_id: 5, level: "read", workspace_dir: "relative/dir", suspended: false },
  ]), { read: [], write: [] });
  assert.deepEqual(shareWorkspaceRoots([]), { read: [], write: [] });
  assert.deepEqual(shareWorkspaceRoots(null), { read: [], write: [] });
});

// ---------------------------------------------------------------------------
// the spawn's effective roots (a real channel turn, real world build)
// ---------------------------------------------------------------------------

test("a READ share's workspace is a read root and never a write root", async () => {
  const cap = await channelTurn("reader", "read-share");
  const policy = policyOf(cap);
  assert.deepEqual(policy.read_paths, [W_HOME, W_X],
    "the bot's own project workspace, then the shared project's workspace");
  assert.deepEqual(policy.write_paths, [], "a read share grants no write reach");
});

test("a READ_WRITE share's workspace is both a read and a write root", async () => {
  const cap = await channelTurn("writer", "write-share");
  const policy = policyOf(cap);
  assert.deepEqual(policy.read_paths, [W_HOME, W_X]);
  assert.deepEqual(policy.write_paths, [W_X]);
});

test("a SUSPENDED share adds no root, at either level", async () => {
  const cap = await channelTurn("suspended", "suspended-share");
  const policy = policyOf(cap);
  assert.deepEqual(policy.read_paths, [W_HOME], "the suspended project's workspace stays out");
  assert.deepEqual(policy.write_paths, []);
});

test("an ARCHIVED or TOMBSTONED project adds no root", async () => {
  const arch = await channelTurn("arch", "arch-share");
  assert.deepEqual(policyOf(arch).read_paths, [W_HOME]);
  assert.deepEqual(policyOf(arch).write_paths, []);
  const tomb = await channelTurn("tomb", "tomb-share");
  assert.deepEqual(policyOf(tomb).read_paths, [W_HOME]);
  assert.deepEqual(policyOf(tomb).write_paths, []);
});

test("a REVOKED share adds no root", async () => {
  const cap = await channelTurn("revoked", "revoked-share");
  assert.deepEqual(policyOf(cap).read_paths, [W_HOME]);
  assert.deepEqual(policyOf(cap).write_paths, []);
});

test("a project with a NULL workspace_dir adds no root and does not break the turn", async () => {
  const cap = await channelTurn("nows", "no-workspace");
  assert.deepEqual(policyOf(cap).read_paths, [W_HOME]);
  assert.deepEqual(policyOf(cap).write_paths, []);
});

test("a bot with no share adds nothing, and a bot with no project keeps no read_paths at all", async () => {
  const none = await channelTurn("nothing", "no-share");
  assert.deepEqual(policyOf(none).read_paths, [W_HOME], "only its own project workspace");
  assert.deepEqual(policyOf(none).write_paths, []);
  const homeless = await channelTurn("homeless", "no-project");
  assert.equal(policyOf(homeless).read_paths, undefined, "no project, no explicit roots, no shares => no read_paths key");
  assert.deepEqual(policyOf(homeless).write_paths, []);
});

test("the world reports the loaded shares as projectShares for a later UI read", async () => {
  const world = await buildBotWorld({ botId: "writer", threadId: "world-shares", gatewayType: "gmail" });
  assert.deepEqual(world.projectShares, [
    { project_id: P_X, level: "read_write", workspace_dir: W_X, name: "Shared X", suspended: false },
  ]);
  assert.deepEqual(world.extraReadPaths, [W_X]);
  assert.deepEqual(world.extraWritePaths, [W_X]);
  const reader = await buildBotWorld({ botId: "reader", threadId: "world-shares-read", gatewayType: "gmail" });
  assert.deepEqual(reader.extraReadPaths, [W_X]);
  assert.deepEqual(reader.extraWritePaths, [], "a read share never reaches the write roots");
});

test("bypass permission mode is unchanged by shares: read_paths and write_paths are still '/'", async () => {
  const world = await buildBotWorld({ botId: "writer", threadId: "bypass", gatewayType: "gmail" });
  const prep = await prepareSpawn(world, { log: () => {} });
  const cap = await directSpawn("bypass", Object.assign({}, prep.piRpcOpts, { permissionMode: "bypass" }));
  const policy = policyOf(cap);
  assert.deepEqual(policy.read_paths, ["/"], "bypass reads everything; a share adds nothing to that");
  assert.deepEqual(policy.write_paths, ["/"], "and writes everything — the share roots are not appended to '/'");
});

// ---------------------------------------------------------------------------
// Perch: an open-anywhere session working OUTSIDE the home workspace (M2)
// ---------------------------------------------------------------------------

let pidSeq = 790000;
function makeFakePi(state) {
  return class FakePi {
    constructor(o) {
      this.opts = o;
      this.sent = [];
      this.closed = 0;
      this.proc = { pid: ++pidSeq };
      this.piSessionId = "pisess-" + this.proc.pid;
      this.toolsCsv = "read";
      this._exitCode = null;
      let done;
      this.exited = new Promise((r) => { done = r; });
      this._done = done;
      state.instances.push(this);
    }
    async getState() { return { data: { sessionId: this.piSessionId } }; }
    async getSessionStats() { return { data: { tokens: { input: 1, output: 1, cacheRead: 0 } } }; }
    async trimLog() {}
    async abortSince() { return null; }
    send(o) { this.sent.push(o); }
    async close() { this.closed += 1; this.exit(0); }
    exit(code = 0) {
      if (this._exitCode != null) return;
      this._exitCode = code;
      this._done(code);
    }
    _exitError() { return new Error("pi exited (code " + this._exitCode + ")"); }
    emit() {}
  };
}
const tick = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

function makeEngine() {
  const state = { instances: [] };
  const seam = {
    PiRpc: makeFakePi(state),
    LIFECYCLE_DEFAULTS: { maxPi: 99 },
    countLivePi: () => 0,
    buildBotWorld: (args) => buildBotWorld(args),
    prepareSpawn: (world, opts) => prepareSpawn(world, opts),
    warmModel: async () => {},
    meterTurn: async () => ({}),
    appendAudit: () => {},
    planForCard: () => null,
    projectContextBlock: () => "",
    cardStatus: () => "todo",
    boardVocab: () => ({ statuses: [], terminals: [] }),
    cardText: () => ({ title: null, description: null }),
    capFor: () => null,
  };
  const engine = createInteractiveEngine({
    crowHome: process.env.CROW_HOME,
    env: { CROW_HOME: process.env.CROW_HOME },
    bridge: seam,
    log: () => {},
  });
  return { engine, state };
}

test("PERCH open-anywhere, READ share: the chosen cwd stays writable, the shared workspace is read-only (M2)", async () => {
  const chosen = join(dir, "operator-chosen");
  mkdirSync(chosen, { recursive: true });
  const { engine, state } = makeEngine();
  const r = await engine.spawn({ botId: "reader", cwd: chosen });
  await tick();
  const pi = state.instances[0];
  assert.ok(pi, "the engine started a child");
  const outputsDir = join(pi.opts.sessionDir, "outputs", r.sessionId);
  assert.deepEqual(pi.opts.extraWritePaths, [outputsDir, chosen],
    "only outputsDir and the operator's chosen dir are writable — the read share adds nothing");
  const readPaths = effectiveReadPaths(pi.opts.def, {
    projectWorkspaceDir: pi.opts.projectWorkspaceDir, extra: pi.opts.extraReadPaths,
  });
  assert.ok(readPaths.includes(W_X), "the shared project's workspace is readable");
  assert.ok(!pi.opts.extraWritePaths.includes(W_X), "the read share is not in the child's write roots");
});

test("PERCH: a READ_WRITE share's workspace joins the child's write roots too", async () => {
  const chosen = join(dir, "operator-chosen-rw");
  mkdirSync(chosen, { recursive: true });
  const { engine, state } = makeEngine();
  const r = await engine.spawn({ botId: "writer", cwd: chosen });
  await tick();
  const pi = state.instances[0];
  assert.ok(pi, "the engine started a child");
  const outputsDir = join(pi.opts.sessionDir, "outputs", r.sessionId);
  assert.deepEqual(pi.opts.extraWritePaths, [outputsDir, chosen, W_X]);
});

// ---------------------------------------------------------------------------
// the contain tier's bind plan
// ---------------------------------------------------------------------------

const pairs = (args) => {
  const o = [];
  for (let i = 0; i < args.length; i++) {
    if (["--ro-bind", "--bind", "--symlink"].includes(args[i])) { o.push([args[i], args[i + 1], args[i + 2]]); i += 2; }
    else if (["--tmpfs", "--dev", "--proc", "--chdir"].includes(args[i])) { o.push([args[i], args[i + 1]]); i += 1; }
    else o.push([args[i]]);
  }
  return o;
};
const has = (args, flag, src, dst = src) => pairs(args).some((p) => p[0] === flag && p[1] === src && (p.length < 3 || p[2] === dst));

test("CONTAIN: a share read root binds read-only, a read_write root read-write, and the Crow home stays refused", () => {
  const T = realpathSync(mkdtempSync(join(tmpdir(), "share-contain-")));
  const H = join(T, "home", "alice");
  const mk = (...p) => { const d = join(...p); mkdirSync(d, { recursive: true }); return d; };
  const crowHome = mk(H, ".crow");
  const data = mk(crowHome, "data");
  writeFileSync(join(data, "crow.db"), "");
  mk(crowHome, "secrets");
  const app = mk(H, "crow-checkout"); // a small fake checkout: nothing large to scan
  const session = mk(T, "sess", "bot-reader");
  const readRoot = mk(H, "shared-read");   // a `read` share's workspace_dir
  const writeRoot = mk(H, "shared-write"); // a `read_write` share's workspace_dir

  const plan = (over = {}) => buildContainPlan({
    home: H, nodeBin: null, cliPath: null, appRoot: app, piLabDir: null,
    crowHome, dataDir: data, sessionDir: session, cwd: session,
    writePaths: [], readPaths: [], mcpServers: [], systemDirs: ["/usr", "/etc"], ...over,
  });

  // What the bridge hands the plan: read_paths carries every share root,
  // write_paths only the read_write ones (bridge.mjs containPlanInputs).
  const { args } = plan({ readPaths: [readRoot], writePaths: [writeRoot] });
  assert.ok(has(args, "--ro-bind", readRoot), "the read share's workspace is mounted read-only");
  assert.ok(!has(args, "--bind", readRoot), "...and never read-write");
  assert.ok(has(args, "--bind", writeRoot), "the read_write share's workspace is mounted read-write");
  assert.ok(!has(args, "--ro-bind", writeRoot), "...and not at the same time");

  assert.throws(() => plan({ writePaths: [crowHome] }), ContainRefused,
    "a write root covering the Crow home still refuses the spawn");
  const ro = plan({ readPaths: [crowHome] });
  assert.ok(!has(ro.args, "--ro-bind", crowHome), "a read root covering the Crow home is not bound");
  assert.ok(ro.refused.some((r) => r.path === crowHome), "and the refusal is recorded");
});