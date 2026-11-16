/**
 * Every spawn path that hands a bot the projects, memory and storage tools is gated for REAL.
 *
 * This file does not assert config shape where it can assert behaviour instead: it takes the block
 * env a path actually produces, SPAWNS the real stdio server (`servers/research/index.js`,
 * `servers/memory/index.js`, `servers/storage/index.js`) with the env pi would give that child (the
 * process env with the block's env laid over it — pi-lab's cleanEnv order, and the engine's own
 * `CROW_BOT_SESSION` marker on the process env), connects an MCP client, and calls a covered tool
 * for a project the bot holds no share of. Expected: the fixed refusal text, and a `share.refused`
 * row in that project's `project_audit_log`. Then a `read` share row is inserted and the SAME call
 * (a read tool) succeeds — the share is resolved on every call, never cached at spawn.
 *
 * Paths covered:
 *   - the channel world builder (`bot-world.mjs` writeWorldMcp): a gmail turn (all three servers),
 *     a discord turn, and the card-bound job turn (which is the same builder);
 *   - the job/card goal turn (`job_runner.mjs`), driven through the real runJob against a stub pi;
 *   - the file-mode regen panel (`bot-mcp-regen.js`) and the CLI writer (`mcp_writer.mjs write`);
 *   - in-process: the router (`createRouterServer({actor})`), the executor with a bound bot
 *     (projects, memory and storage), the combined core server, and the operator's voice bot, which
 *     keeps operator scope.
 *
 * A hostile block per stdio path (a block env claiming `CROW_ACTOR_KIND=unknown`, laid over the
 * engine marker pi's process carries) is still refused: the marker turns "no bot identity" into the
 * unverified bot, never into the operator's own client. The card-bound turn rides the channel world
 * builder, so it shares that path's hostile case.
 *
 * NO path here lacks identity, so there is nothing "refused by default for lack of identity" to
 * record. The one family that deliberately carries none is the gateway's URL mounts
 * (/memory/mcp, /storage/mcp, /projects/mcp): a bot config disables those blocks because a gateway
 * token is the owner (mcp_writer.mjs `isOwnerProjectUrl`, asserted in
 * tests/project-share-identity-paths.test.js) — i.e. refused for every project, not just non-home
 * ones.
 *
 * Scratch CROW_HOME / data dir / HOME throughout: nothing here reads or writes the real ~/.crow,
 * ~/.pi, or a gateway.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..");
const dir = mkdtempSync(join(tmpdir(), "share-spawn-"));
const HOME = join(dir, "home");
const CROW_HOME = join(dir, "crow");
const DATA = join(dir, "data");
const DB_FILE = join(DATA, "crow.db");
const BOT = "spawnglass";
const BOT_NAME = "Glasses";
const PEER = "abcdef1234567890";

mkdirSync(join(HOME, ".pi", "agent"), { recursive: true });
mkdirSync(DATA, { recursive: true });
// The canonical third-party config the writer merges (empty: the instance catalog supplies the
// Crow servers). HOME is scratch so the writer never reads the operator's real pi config.
writeFileSync(join(HOME, ".pi", "agent", "mcp.json"), JSON.stringify({ mcpServers: {} }) + "\n");

process.env.HOME = HOME;
process.env.CROW_HOME = CROW_HOME;
process.env.CROW_DATA_DIR = DATA;
process.env.CROW_DB_PATH = DB_FILE;
process.env.CROW_TASKS_DB_PATH = join(DATA, "tasks.db");
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
// The catalog's stdio blocks all ask for journal DELETE (the WAL-unlink guard): keep this file's own
// client in the same mode so a child never has to flip it.
process.env.CROW_JOURNAL_MODE = "DELETE";
// File delivery, so a producer's config is on disk to read back where the path writes one.
process.env.PIBOT_MCP_CONFIG_DELIVERY = "file";
// A loopback relay / warm call is refused at once: no test here reaches a gateway.
process.env.CROW_GATEWAY_PORT = "1";
process.env.PIBOT_WARM_GATEWAY_URL = "http://127.0.0.1:1";
process.env.PIBOT_WARM_TIMEOUT_MS = "1000";
// Bound every pi wait: a stub that stays silent must redden fast, never sit on the production
// 10-minute turn timeout.
process.env.PIBOT_PROMPT_ACK_TIMEOUT_MS = "8000";
process.env.PIBOT_TURN_TIMEOUT_MS = "8000";
process.env.PIBOT_JOB_TIMEOUT_MS = "8000";
process.env.CROW_PI_SANDBOX = "off";
process.env.PI_MODELS_JSON = join(dir, "models.json");
writeFileSync(process.env.PI_MODELS_JSON, JSON.stringify({ providers: { stub: { models: [{ id: "m1" }] } } }));

// The instance's peer-relay token, where the gateway mints it: only its value ever reaches a block.
mkdirSync(join(CROW_HOME, "secrets"), { recursive: true, mode: 0o700 });
writeFileSync(join(CROW_HOME, "secrets", "peer-relay-token"), "spawn-relay-token\n", { mode: 0o600 });

const NO_SHARE = /No share grants this bot access to that project\./;
const SUSPENDED = /suspended while a project has an outside member\./;
const NOT_OPERATOR = /That tool is for the operator only\./;
const HOME_ONLY = /That tool is for the bot's own project only\./;

let db = null;
let mcp = null;
let shares = null;
let actorEnv = null;
let spaces = null;
let CROW_VOICE_BOT_ID = null;
let homeProject = null;
const spawned = [];

/** The bot def every path test starts from: the three project servers, no tracker/board. */
const botDef = (over = {}) => ({
  system_prompt: "You are a test bot.",
  models: { default: "stub/m1" },
  tools: { pi_builtin: [], crow_mcp: ["crow-projects", "crow-memory", "crow-storage"] },
  permission_policy: { bash: "deny", write_paths: [] },
  tracker_config: { type: "none" },
  ...over,
});

async function saveBot(def = botDef(), home = homeProject, botId = BOT, displayName = BOT_NAME) {
  await db.execute({
    sql: `INSERT INTO pi_bot_defs (bot_id, display_name, definition, project_id, enabled) VALUES (?,?,?,?,1)
          ON CONFLICT(bot_id) DO UPDATE SET display_name=excluded.display_name,
            definition=excluded.definition, project_id=excluded.project_id, enabled=1`,
    args: [botId, displayName, JSON.stringify({ ...def, session_dir: join(CROW_HOME, "pi-bots", botId) }), home],
  });
}

async function mkProject(name) {
  const p = await spaces.createProjectSpace(db, { name });
  return Number(p.id);
}

let contactSeq = 0;
/** An active `project_members` row whose contact is not the local owner: "an outside member". */
async function mkOutsideMember(projectId) {
  contactSeq += 1;
  const crowId = `share-spawn-peer-${contactSeq}`.padEnd(16, "0").slice(0, 16);
  const r = await db.execute({
    sql: "INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey, origin) VALUES (?,?,?,?, 'remote')",
    args: [crowId, `Peer ${contactSeq}`, `${contactSeq}`.padEnd(64, "a"), `${contactSeq}`.padEnd(64, "b")],
  });
  const contactId = Number(r.lastInsertRowid);
  await db.execute({
    sql: "INSERT INTO project_members (project_id, contact_id, role, mode) VALUES (?,?, 'viewer', 'live')",
    args: [Number(projectId), contactId],
  });
  return contactId;
}

/** The `share.refused` audit row a refusal of `tool` left on `projectId`, if any. */
async function refusalAudit(projectId, tool) {
  const { rows } = await db.execute({
    sql: `SELECT actor_type, actor_id, action, target, payload FROM project_audit_log
           WHERE project_id = ? AND action = 'share.refused' AND target = ? ORDER BY id ASC`,
    args: [Number(projectId), "tool:" + tool],
  });
  return rows[0] || null;
}

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env }, stdio: "pipe", cwd: REPO });
  const { createDbClient } = await import("../servers/db.js");
  db = createDbClient(DB_FILE);
  mcp = await import("../scripts/pi-bots/mcp_writer.mjs");
  actorEnv = await import("../scripts/pi-bots/actor-env.mjs");
  shares = await import("../servers/shared/project-bot-shares.js");
  spaces = await import("../servers/shared/project-spaces.js");
  ({ CROW_VOICE_BOT_ID } = await import("../servers/shared/voice-bot.js"));
  homeProject = await mkProject("Spawn bot home");
  await saveBot();
});

after(async () => {
  for (const s of spawned) await s.close();
  try { db && db.close && db.close(); } catch { /* already closed */ }
  rmSync(dir, { recursive: true, force: true });
});

// --- the real stdio spawn --------------------------------------------------

/** The env pi's own process carries: the bridge's identity env (marker included) over the process
 *  env, exactly as `botSessionEnv` writes it onto the spawn. */
function piEnv() {
  return { ...process.env, ...actorEnv.botSessionEnv(BOT, BOT_NAME) };
}

function blockOf(config, name) {
  const block = config && config.mcpServers && config.mcpServers[name];
  assert.ok(block && block.command, `the config carries a spawnable ${name} block`);
  return block;
}

/**
 * Spawn the real server a config block names, with the env pi would give that child: the process
 * env with the block's env laid over it (pi-lab's cleanEnv order), plus any override last.
 */
async function spawnBlock(block, { env: override = {} } = {}) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const transport = new StdioClientTransport({
    command: block.command,
    args: block.args || [],
    cwd: block.cwd,
    env: { ...piEnv(), ...(block.env || {}), ...override },
  });
  const client = new Client({ name: "share-spawn-path", version: "0" }, { capabilities: {} });
  let timer;
  await Promise.race([
    client.connect(transport),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("MCP connect timeout")), 45_000); }),
  ]).finally(() => clearTimeout(timer));
  const entry = {
    client,
    close: async () => { try { await client.close(); } catch { /* gone */ } },
  };
  spawned.push(entry);
  return entry;
}

const textOf = (r) => (r.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");

async function call(entry, name, args) {
  const client = entry.client || entry;
  const r = await client.callTool({ name, arguments: args });
  return { text: textOf(r), isError: !!r.isError };
}

/**
 * The one hostile-block case per stdio path: a block whose own env says `CROW_ACTOR_KIND=unknown`,
 * laid over the engine marker pi's process carries. The marker makes that the unverified bot, which
 * every project tool refuses — the spoof can never fall back to the operator's own client, and it
 * cannot ride a share the bot really holds (the project passed in is shared by then).
 */
async function hostileBlock(label, block, projectId) {
  const c = await spawnBlock(block, { env: { CROW_ACTOR_KIND: "unknown" } });
  try {
    const r = await call(c, "crow_search_memories", { query: "hostile", project_id: projectId, semantic: false });
    assert.equal(r.isError, true, `${label}: a block that claims kind=unknown is still refused`);
    assert.match(r.text, NOT_OPERATOR, `${label}: refused as the unverified bot`);
    assert.doesNotMatch(r.text, NO_SHARE, `${label}: never read as an ordinary share miss`);
  } finally {
    await c.close();
  }
}

/** Refused for an unshared project, and the refusal is in that project's audit log. */
async function expectRefused(label, entry, tool, args, projectId) {
  const refused = await call(entry, tool, args);
  assert.equal(refused.isError, true, `${label} ${tool}: ${refused.text}`);
  assert.match(refused.text, NO_SHARE, `${label} ${tool}`);
  const row = await refusalAudit(projectId, tool);
  assert.ok(row, `${label} ${tool}: the refusal is in the unshared project's audit log`);
  assert.equal(row.actor_type, "bot", `${label} ${tool}: attributed to the bot`);
  assert.equal(row.actor_id, BOT, `${label} ${tool}: attributed to the bot`);
  assert.match(String(row.payload), /"code":"no_share"/, `${label} ${tool}`);
}

/** The same call, with a `read` share inserted: allowed (or `success` decides what "allowed" looks
 *  like — storage stops at its availability probe on an instance with no backend). */
async function expectAllowed(label, entry, tool, args, projectId, { success } = {}) {
  await shares.grantShare(db, { projectId, botId: BOT, level: "read" });
  const allowed = await call(entry, tool, args);
  if (success) success(allowed, `${label} ${tool}`);
  else assert.equal(allowed.isError, false, `${label} ${tool} after a read share: ${allowed.text}`);
  return allowed;
}

// --- the channel world builder (gmail, discord, card turns) -----------------

test("a gmail turn: the spawned research, memory and storage servers refuse an unshared project and follow a read share", { timeout: 240_000 }, async () => {
  await saveBot();
  const x = await mkProject("World X");
  const logs = [];
  const world = await (await import("../scripts/pi-bots/bot-world.mjs"))
    .buildBotWorld({ botId: BOT, threadId: "gmail:1", gatewayType: "gmail", log: (m) => logs.push(String(m)) });
  assert.ok(world.mcpConfig, "the world built an MCP config: " + logs.join(" | "));
  for (const name of ["crow-memory", "crow-projects", "crow-storage"]) {
    const b = blockOf(world.mcpConfig, name);
    assert.equal(b.env.CROW_ACTOR_KIND, "bot", name);
    assert.equal(b.env.CROW_ACTOR_BOT_ID, BOT, name);
    assert.equal(b.env.CROW_ACTOR_BOT_NAME, BOT_NAME, name);
    // The engine marker belongs to pi's own process, never to a block's env.
    assert.ok(!("CROW_BOT_SESSION" in b.env), name);
    assert.equal(b.env.CROW_DB_PATH, DB_FILE, name + ": bound to this instance");
  }

  const research = await spawnBlock(blockOf(world.mcpConfig, "crow-projects"));
  const memory = await spawnBlock(blockOf(world.mcpConfig, "crow-memory"));
  const storage = await spawnBlock(blockOf(world.mcpConfig, "crow-storage"));
  const search = { query: "share-spawn-channel", project_id: x, semantic: false };
  try {
    // Every server refuses the unshared project first — one grant would otherwise let the next
    // server through.
    await expectRefused("gmail turn", research, "crow_list_sources", { project_id: x }, x);
    await expectRefused("gmail turn", memory, "crow_search_memories", search, x);
    await expectRefused("gmail turn", storage, "crow_list_files", { project_id: x }, x);

    await expectAllowed("gmail turn", research, "crow_list_sources", { project_id: x }, x);
    await expectAllowed("gmail turn", memory, "crow_search_memories", search, x);
    // No storage backend on this instance: the gate is what the assertion reads — a share lets the
    // call through to the availability probe, and the refusal is no longer the share rule.
    await expectAllowed("gmail turn", storage, "crow_list_files", { project_id: x }, x, {
      success: (r, label) => {
        assert.doesNotMatch(r.text, NO_SHARE, label);
        assert.match(r.text, /Storage is not configured/, label);
      },
    });
  } finally {
    await research.close();
    await memory.close();
    await storage.close();
  }

  // The discord turn runs the same builder with its own thread; the block still carries the bot.
  const xDiscord = await mkProject("World X discord");
  const discord = await (await import("../scripts/pi-bots/bot-world.mjs"))
    .buildBotWorld({ botId: BOT, threadId: "discord:7", gatewayType: "discord", log: () => {} });
  assert.equal(blockOf(discord.mcpConfig, "crow-memory").env.CROW_ACTOR_THREAD, "discord:7");
  const dmem = await spawnBlock(blockOf(discord.mcpConfig, "crow-memory"));
  try {
    await expectRefused("discord turn", dmem, "crow_search_memories",
      { query: "share-spawn-discord", project_id: xDiscord, semantic: false }, xDiscord);
    await expectAllowed("discord turn", dmem, "crow_search_memories",
      { query: "share-spawn-discord", project_id: xDiscord, semantic: false }, xDiscord);
  } finally {
    await dmem.close();
  }

  await hostileBlock("gmail turn", blockOf(world.mcpConfig, "crow-memory"), x);
});

test("a card-bound turn: the card the bot holds grants nothing, a share does, and a revoke is live on the next call", { timeout: 180_000 }, async () => {
  await saveBot();
  const x = await mkProject("Card X");
  const world = await (await import("../scripts/pi-bots/bot-world.mjs"))
    .buildBotWorld({ botId: BOT, threadId: "job-card-1", gatewayType: "perch", jobId: "job-card-1", cardBound: true, log: () => {} });
  assert.ok(world.mcpConfig);
  const memory = await spawnBlock(blockOf(world.mcpConfig, "crow-memory"));
  const search = { query: "share-spawn-card", project_id: x, semantic: false };
  try {
    // The card points at X and the bot holds it: covered tools still follow the SHARE, so with no
    // share the call is refused.
    const refused = await call(memory, "crow_search_memories", search);
    assert.equal(refused.isError, true, refused.text);
    assert.match(refused.text, NO_SHARE);

    // A project tool outside the four shared families is refused whatever the share says.
    const blocked = await call(memory, "crow_get_context", { project_id: x });
    assert.equal(blocked.isError, true, blocked.text);
    assert.match(blocked.text, HOME_ONLY);

    await shares.grantShare(db, { projectId: x, botId: BOT, level: "read" });
    const allowed = await call(memory, "crow_search_memories", search);
    assert.equal(allowed.isError, false, allowed.text);
    const stillBlocked = await call(memory, "crow_get_context", { project_id: x });
    assert.equal(stillBlocked.isError, true, stillBlocked.text);
    assert.match(stillBlocked.text, HOME_ONLY);

    // Revoke: the VERY NEXT call on the same client (same process, no restart) is refused.
    await shares.revokeShare(db, { projectId: x, botId: BOT });
    const after = await call(memory, "crow_search_memories", search);
    assert.equal(after.isError, true, after.text);
    assert.match(after.text, NO_SHARE);
  } finally {
    await memory.close();
  }
});

// --- the job runner --------------------------------------------------------

/** A stub pi that speaks the rpc protocol and records what it was handed. `PIBOT_PI_CLI` points the
 *  bridge at it (pi_resolver), so runJob's REAL PiRpc spawn runs it — never the installed engine. */
function writeJobStub() {
  const stub = join(dir, "stub-pi-job.mjs");
  writeFileSync(stub, [
    'import { readFileSync, writeFileSync } from "node:fs";',
    'let cfgText = null;',
    'try { cfgText = readFileSync(process.env.PI_BOT_MCP_CONFIG, "utf8"); } catch { cfgText = null; }',
    'writeFileSync(process.env.PIBOT_TEST_CAPTURE, JSON.stringify({ argv: process.argv.slice(2), env: process.env, cfgText }));',
    'const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");',
    'let buf = "";',
    'process.stdin.on("data", (chunk) => {',
    '  buf += chunk.toString("utf8");',
    '  let nl;',
    '  while ((nl = buf.indexOf("\\n")) >= 0) {',
    '    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);',
    '    if (!line.trim()) continue;',
    '    let m; try { m = JSON.parse(line); } catch { continue; }',
    '    if (m.type === "get_state") out({ type: "response", command: "get_state", data: { sessionId: "share-job-uuid" } });',
    '    else if (m.type === "get_session_stats") out({ type: "response", command: "get_session_stats", id: m.id, data: { tokens: { input: 1, output: 1, cacheRead: 0 } } });',
    '    else if (m.type === "prompt") { out({ type: "response", command: "prompt" });',
    '      out({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }] }); }',
    '    else if (m.type === "abort") out({ type: "response", command: "abort" });',
    '  }',
    '});',
    'process.stdin.resume();',
  ].join("\n"));
  return stub;
}

// Before any module import can resolve the engine (pi_resolver reads this at spawn time, and a
// checkout may well have the real pi installed).
process.env.PIBOT_PI_CLI = writeJobStub();

let jobStubSeq = 0;
/** One real runJob (stub pi only), returning what pi was handed: its env and its MCP config. */
async function jobTurn(leg) {
  const { runJob } = await import("../scripts/pi-bots/job_runner.mjs");
  const capture = join(dir, `job-capture-${leg}.json`);
  const saved = process.env.PIBOT_TEST_CAPTURE;
  process.env.PIBOT_TEST_CAPTURE = capture;
  try {
    const logs = [];
    const r = await runJob(
      { job_id: "job-share-" + leg, bot_id: BOT, goal: "read the shared project", escalate: 0, source: "chat", principal: null },
      { log: (m) => logs.push(String(m)) },
    );
    assert.ok(r && r.result != null, "the job completed against the stub: " + logs.join(" | "));
    const cap = JSON.parse(readFileSync(capture, "utf8"));
    // runJob removes its temp session dir when the turn ends, so the config is read off what pi
    // itself was handed, at spawn time.
    assert.ok(cap.cfgText, "the job turn was handed its MCP config: " + logs.join(" | "));
    return { env: cap.env, config: JSON.parse(cap.cfgText), logs };
  } finally {
    if (saved === undefined) delete process.env.PIBOT_TEST_CAPTURE; else process.env.PIBOT_TEST_CAPTURE = saved;
  }
}

test("a job turn: its spawned memory server refuses an unshared project, and the share reaches its file roots", { timeout: 240_000 }, async () => {
  await saveBot();
  const x = await mkProject("Job X");
  const first = await jobTurn("first-" + (++jobStubSeq));
  const memory = await spawnBlock(blockOf(first.config, "crow-memory"));
  const search = { query: "share-spawn-job", project_id: x, semantic: false };
  try {
    await expectRefused("job turn", memory, "crow_search_memories", search, x);
    await expectAllowed("job turn", memory, "crow_search_memories", search, x);
  } finally {
    await memory.close();
  }

  // The next job turn is spawned after the share: its pi read roots carry X's workspace, so pi's own
  // file tools follow the share too (fixed at spawn, as documented — the MCP tools are per call).
  const second = await jobTurn("second-" + (++jobStubSeq));
  const policy = JSON.parse(second.env.PI_BOT_PERMISSION_POLICY);
  const xWorkspace = (await db.execute({ sql: "SELECT workspace_dir FROM project_spaces WHERE id = ?", args: [Number(x)] })).rows[0].workspace_dir;
  assert.ok(Array.isArray(policy.read_paths) && policy.read_paths.includes(xWorkspace),
    "the shared workspace is a read root for the job's pi: " + JSON.stringify(policy.read_paths));
  assert.ok(!(policy.write_paths || []).includes(xWorkspace), "a read share is not a write root");

  await hostileBlock("job turn", blockOf(second.config, "crow-memory"), x);
});

// --- the config writers ----------------------------------------------------

test("the file-mode regen path: its written config spawns a gated memory server", { timeout: 180_000 }, async () => {
  await saveBot();
  const x = await mkProject("Regen X");
  const { regenerateBotMcp } = await import("../servers/gateway/dashboard/panels/bot-mcp-regen.js");
  const r = await regenerateBotMcp(db, BOT);
  const written = JSON.parse(readFileSync(r.path, "utf8"));
  assert.equal(blockOf(written, "crow-memory").env.CROW_ACTOR_BOT_ID, BOT);
  const memory = await spawnBlock(blockOf(written, "crow-memory"));
  try {
    await expectRefused("regen panel", memory, "crow_search_memories",
      { query: "share-spawn-regen", project_id: x, semantic: false }, x);
    await expectAllowed("regen panel", memory, "crow_search_memories",
      { query: "share-spawn-regen", project_id: x, semantic: false }, x);
  } finally {
    await memory.close();
  }
  await hostileBlock("regen panel", blockOf(written, "crow-memory"), x);
});

test("the CLI writer path: its written config spawns a gated memory server", { timeout: 180_000 }, async () => {
  await saveBot();
  const x = await mkProject("CLI X");
  execFileSync(process.execPath, ["scripts/pi-bots/mcp_writer.mjs", "write", BOT], {
    cwd: REPO,
    stdio: "pipe",
    env: { ...process.env, HOME, CROW_HOME, CROW_DATA_DIR: DATA, CROW_DB_PATH: DB_FILE, PIBOT_MCP_CONFIG_DELIVERY: "file" },
  });
  const written = JSON.parse(readFileSync(join(CROW_HOME, "pi-bots", BOT, ".mcp.json"), "utf8"));
  assert.equal(blockOf(written, "crow-memory").env.CROW_ACTOR_BOT_ID, BOT);
  const memory = await spawnBlock(blockOf(written, "crow-memory"));
  try {
    await expectRefused("CLI writer", memory, "crow_search_memories",
      { query: "share-spawn-cli", project_id: x, semantic: false }, x);
    await expectAllowed("CLI writer", memory, "crow_search_memories",
      { query: "share-spawn-cli", project_id: x, semantic: false }, x);
  } finally {
    await memory.close();
  }
  await hostileBlock("CLI writer", blockOf(written, "crow-memory"), x);
});

// --- in-process paths ------------------------------------------------------

async function connectInProcess(server) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const client = new Client({ name: "share-spawn-inprocess", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

const routerCall = (client, action, params) =>
  client.callTool({ name: "crow_memory", arguments: { action, params } }).then((r) => ({ text: textOf(r), isError: !!r.isError }));

test("a router's bot actor server is refused an unshared project, then retired live by a revoke, a suspension and a re-grant", { timeout: 120_000 }, async () => {
  await saveBot();
  const x = await mkProject("Router X");
  await shares.grantShare(db, { projectId: x, botId: BOT, level: "read" });
  const { createRouterServer } = await import("../servers/gateway/router.js");
  const server = createRouterServer({ actor: { kind: "bot", id: BOT } });
  const client = await connectInProcess(server);
  const search = () => routerCall(client, "search_memories", { query: "share-spawn-router", project_id: x, semantic: false });
  try {
    assert.equal((await search()).isError, false, "the share allows the first call");

    await shares.revokeShare(db, { projectId: x, botId: BOT });
    const refused = await search();
    assert.equal(refused.isError, true, refused.text);
    assert.match(refused.text, NO_SHARE, "refused on the next call, no restart");

    await shares.grantShare(db, { projectId: x, botId: BOT, level: "read" });
    assert.equal((await search()).isError, false, "re-granted: allowed again");

    const contactId = await mkOutsideMember(x);
    const suspended = await search();
    assert.equal(suspended.isError, true, suspended.text);
    assert.match(suspended.text, SUSPENDED);

    await db.execute({ sql: "UPDATE project_members SET revoked_at = datetime('now') WHERE contact_id = ?", args: [contactId] });
    assert.equal((await search()).isError, false, "the outside member left: allowed again");
  } finally {
    try { await client.close(); } catch { /* gone */ }
    try { await server.close(); } catch { /* gone */ }
  }
});

test("an executor bound to a bot is gated on projects, memory and storage; the operator's voice bot keeps operator scope", { timeout: 120_000 }, async () => {
  await saveBot();
  const x = await mkProject("Executor X");
  const { createToolExecutor } = await import("../servers/gateway/ai/tool-executor.js");
  const ex = createToolExecutor({ botDef: { bot_id: BOT, display_name: BOT_NAME } });
  const voice = createToolExecutor({ botDef: { bot_id: CROW_VOICE_BOT_ID, display_name: "Crow" } });
  const memory = (e) => e.executeTool("crow_memory", { action: "search_memories", params: { query: "share-spawn-executor", project_id: x, semantic: false } })
    .then((r) => ({ text: String(r.result), isError: !!r.isError }));
  const storage = (e) => e.executeTool("crow_storage", { action: "list_files", params: { project_id: x } })
    .then((r) => ({ text: String(r.result), isError: !!r.isError }));
  const projects = (e) => e.executeTool("crow_projects", { action: "workspace_dir", params: { project_id: x } })
    .then((r) => ({ text: String(r.result), isError: !!r.isError }));
  try {
    for (const [label, fn] of [["projects", projects], ["memory", memory], ["storage", storage]]) {
      const refused = await fn(ex);
      assert.equal(refused.isError, true, `${label}: ${refused.text}`);
      assert.match(refused.text, NO_SHARE, label);
    }
    await shares.grantShare(db, { projectId: x, botId: BOT, level: "read" });
    for (const [label, fn] of [["projects", projects], ["memory", memory]]) {
      const allowed = await fn(ex);
      assert.equal(allowed.isError, false, `${label} after a read share: ${allowed.text}`);
    }
    const files = await storage(ex);
    assert.doesNotMatch(files.text, NO_SHARE, "storage after a read share");
    assert.match(files.text, /Storage is not configured/, "storage reaches the availability probe");

    // The operator's own voice bot is not bound by the share rules: the same project needs no share.
    for (const [label, fn] of [["projects", projects], ["memory", memory]]) {
      const allowed = await fn(voice);
      assert.equal(allowed.isError, false, `operator voice bot, ${label}: ${allowed.text}`);
    }
  } finally {
    await ex.close();
    await voice.close();
  }
});

/** Build the combined core server under `env` and connect an in-process client (the env is restored
 *  before anything is called, so the actor is the one the server was BUILT with). */
async function coreUnder(env) {
  const { createCoreServer } = await import("../servers/core/server.js");
  const KEYS = ["CROW_ACTOR_KIND", "CROW_ACTOR_BOT_ID", "CROW_ACTOR_BOT_NAME", "CROW_ACTOR_THREAD", "CROW_BOT_SESSION"];
  const saved = new Map(KEYS.map((k) => [k, process.env[k]]));
  let server = null;
  let client = null;
  try {
    for (const k of KEYS) delete process.env[k];
    Object.assign(process.env, env);
    server = await createCoreServer(DB_FILE);
    client = await connectInProcess(server);
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
  return {
    async call(name, args = {}) {
      const r = await client.callTool({ name, arguments: args });
      return { text: textOf(r), isError: !!r.isError };
    },
    async close() {
      try { await client.close(); } catch { /* gone */ }
      try { await server.close(); } catch { /* gone */ }
    },
  };
}

test("the combined core server is gated on memory and storage for a bot built from the env", { timeout: 120_000 }, async () => {
  await saveBot();
  const x = await mkProject("Core X");
  const core = await coreUnder({ CROW_ACTOR_KIND: "bot", CROW_ACTOR_BOT_ID: BOT, CROW_ACTOR_BOT_NAME: BOT_NAME });
  const search = { query: "share-spawn-core", project_id: x, semantic: false };
  try {
    const refused = await core.call("crow_search_memories", search);
    assert.equal(refused.isError, true, refused.text);
    assert.match(refused.text, NO_SHARE);

    await core.call("crow_activate_server", { server: "storage" });
    const refusedFiles = await core.call("crow_list_files", { project_id: x });
    assert.equal(refusedFiles.isError, true, refusedFiles.text);
    assert.match(refusedFiles.text, NO_SHARE);

    await shares.grantShare(db, { projectId: x, botId: BOT, level: "read" });
    const allowed = await core.call("crow_search_memories", search);
    assert.equal(allowed.isError, false, allowed.text);
    const files = await core.call("crow_list_files", { project_id: x });
    assert.doesNotMatch(files.text, NO_SHARE);
    assert.match(files.text, /Storage is not configured/);
  } finally {
    await core.close();
  }
});

// --- remote invocation -----------------------------------------------------
// A bot holding a live share gets NO remote-proxy blocks (its calls would arrive at the peer as a
// relayed actor, not as this bot); with no share the config is byte-identical to today's.

const remoteSearchDir = () => {
  const d = join(dir, "remote-block-" + Math.random().toString(16).slice(2));
  mkdirSync(d, { recursive: true });
  return d;
};

test("holdsShare true: no remote-proxy block and the reason as a warning; holdsShare false: byte-identical", async () => {
  const sessionDir = remoteSearchDir();
  const d = botDef({ tools: { crow_mcp: ["crow-memory"], remote_mcp: [PEER + "::crow-memory"] } });
  const opts = {
    sessionDir, crowHome: CROW_HOME, remoteEnabled: true, peerGatewayUrls: { [PEER]: "https://peer.example:8444" },
    botId: BOT, displayName: BOT_NAME, write: false,
  };
  const noShare = mcp.writeBotMcp(d, opts);
  const remoteNames = (json) => Object.keys(json.mcpServers).filter((n) => n.startsWith("crow-remote-"));
  assert.equal(remoteNames(noShare.json).length, 1, "no share: the remote forward proxy is minted");

  const explicitOff = mcp.writeBotMcp(d, { ...opts, holdsShare: false });
  assert.deepEqual(explicitOff.json, noShare.json, "holdsShare:false is byte-identical to the config without the option");
  assert.deepEqual(explicitOff.remoteWarnings, noShare.remoteWarnings);

  const held = mcp.writeBotMcp(d, { ...opts, holdsShare: true });
  assert.deepEqual(remoteNames(held.json), [], "a bot holding a share gets no remote-proxy block");
  assert.ok(held.remoteWarnings.includes("remote tools are off while this bot holds a project share"),
    JSON.stringify(held.remoteWarnings));
});

test("the world builder suppresses the remote-proxy block while the bot holds a share, and restores it after a revoke", { timeout: 120_000 }, async () => {
  // A bot of its own: every other bot in this file holds a live share by now, which is exactly what
  // this test turns on and off.
  const REMOTE_BOT = "remoteglass";
  const remoteHome = await mkProject("Remote bot home");
  const x = await mkProject("Remote world X");
  await saveBot(botDef({ tools: { crow_mcp: ["crow-memory"], remote_mcp: [PEER + "::crow-memory"] } }), remoteHome, REMOTE_BOT);
  await db.execute({
    sql: "INSERT OR REPLACE INTO dashboard_settings (key, value) VALUES ('feature_flags', ?)",
    args: [JSON.stringify({ remote_invocation: true })],
  });
  await db.execute({
    sql: "INSERT OR REPLACE INTO crow_instances (id, name, crow_id, gateway_url, status, trusted) VALUES (?,?,?,?, 'active', 1)",
    args: [PEER, "peer", PEER, "https://peer.example:8444/"],
  });
  const { buildBotWorld } = await import("../scripts/pi-bots/bot-world.mjs");
  const remoteNames = (json) => Object.keys((json && json.mcpServers) || {}).filter((n) => n.startsWith("crow-remote-"));
  try {
    const logsA = [];
    const a = await buildBotWorld({ botId: REMOTE_BOT, threadId: "gmail:remote", gatewayType: "gmail", log: (m) => logsA.push(String(m)) });
    assert.equal(remoteNames(a.mcpConfig).length, 1, "no share: the proxy block is there: " + logsA.join(" | "));

    await shares.grantShare(db, { projectId: x, botId: REMOTE_BOT, level: "read" });
    const logsB = [];
    const b = await buildBotWorld({ botId: REMOTE_BOT, threadId: "gmail:remote", gatewayType: "gmail", log: (m) => logsB.push(String(m)) });
    assert.deepEqual(remoteNames(b.mcpConfig), [], "a live share keeps the proxy block out of the next build");
    assert.ok(logsB.some((l) => l.includes("remote tools are off while this bot holds a project share")),
      "the reason is reported: " + logsB.join(" | "));

    await shares.revokeShare(db, { projectId: x, botId: REMOTE_BOT });
    const c = await buildBotWorld({ botId: REMOTE_BOT, threadId: "gmail:remote", gatewayType: "gmail", log: () => {} });
    assert.equal(remoteNames(c.mcpConfig).length, 1, "revoking the share restores the proxy block at the next build");
  } finally {
    await db.execute({ sql: "DELETE FROM dashboard_settings WHERE key = 'feature_flags'", args: [] });
    await db.execute({ sql: "DELETE FROM crow_instances WHERE id = ?", args: [PEER] });
  }
});