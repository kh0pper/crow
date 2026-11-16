/**
 * Every identity path the bot engine controls carries the bot's identity.
 *
 * The per-bot MCP config (written by the regen panel and by the CLI writer), pi's own spawn env (in
 * both delivery modes), the actor an env resolves to under the engine's session marker, and the base
 * actor the gateway's in-process executor builds the projects, memory and storage servers with — the
 * operator's own voice bot keeping operator scope.
 *
 * Scratch CROW_HOME, data dir and HOME: nothing here reads or writes the real ~/.crow or ~/.pi.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..");
const dir = mkdtempSync(join(tmpdir(), "share-identity-"));
const HOME = join(dir, "home");
const CROW_HOME = join(dir, "crow");
const DATA = join(dir, "data");
const DB_FILE = join(DATA, "crow.db");

mkdirSync(join(HOME, ".pi", "agent"), { recursive: true });
mkdirSync(DATA, { recursive: true });
// The canonical third-party config the writer merges (empty: the instance catalog supplies the Crow
// servers). HOME is scratch so the writer never reads the operator's real pi config.
writeFileSync(join(HOME, ".pi", "agent", "mcp.json"), JSON.stringify({ mcpServers: {} }) + "\n");

process.env.HOME = HOME;
process.env.CROW_HOME = CROW_HOME;
process.env.CROW_DATA_DIR = DATA;
delete process.env.CROW_DB_PATH;
process.env.CROW_TASKS_DB_PATH = join(DATA, "tasks.db");
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
// File delivery: the panel and the CLI then write the config, so a test can read it back.
process.env.PIBOT_MCP_CONFIG_DELIVERY = "file";

const BOT = "glass";
const BOT_HOME = join(CROW_HOME, "pi-bots", BOT);
const BOT_DEF = {
  display_name: "Glasses",
  session_dir: BOT_HOME,
  system_prompt: "You are a test bot.",
  tools: { crow_mcp: ["crow-memory/crow_search_memories"] },
  permission_policy: { bash: "deny", write_paths: [] },
};

let db = null;
let mcp = null;
let bridge = null;
let actorMod = null;
let share = null;
let CROW_VOICE_BOT_ID = null;

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env }, stdio: "pipe", cwd: REPO });
  const { createDbClient } = await import("../servers/db.js");
  db = createDbClient(DB_FILE);
  mcp = await import("../scripts/pi-bots/mcp_writer.mjs");
  bridge = await import("../scripts/pi-bots/bridge.mjs");
  actorMod = await import("../servers/research/actor.js");
  share = await import("../servers/shared/project-share-scope.js");
  ({ CROW_VOICE_BOT_ID } = await import("../servers/shared/voice-bot.js"));
});

after(() => {
  try { db && db.close && db.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

async function saveBot(botId = BOT, def = BOT_DEF, displayName = "Glasses") {
  await db.execute({
    sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES (?,?,?,1) ON CONFLICT(bot_id) DO NOTHING",
    args: [botId, displayName, JSON.stringify(def)],
  });
}

function readWrittenConfig() {
  const path = join(BOT_HOME, ".mcp.json");
  assert.ok(existsSync(path), "the writer wrote " + path);
  return JSON.parse(readFileSync(path, "utf8"));
}

const stdioBlocks = (json) => Object.entries(json.mcpServers).filter(([, b]) => b && b.command);

function assertActorEverywhere(json, botId, displayName) {
  const blocks = stdioBlocks(json);
  assert.ok(blocks.length > 0, "the config has at least one stdio block");
  for (const [name, block] of blocks) {
    assert.equal(block.env.CROW_ACTOR_KIND, "bot", name);
    assert.equal(block.env.CROW_ACTOR_BOT_ID, botId, name);
    assert.equal(block.env.CROW_ACTOR_BOT_NAME, displayName, name);
    // The engine marker belongs to pi's own process, never to a block's env.
    assert.ok(!("CROW_BOT_SESSION" in block.env), name);
  }
}

// --- the config writers carry the actor ------------------------------------

test("the regen panel writes the bot's actor onto every stdio block", async () => {
  await saveBot();
  const { regenerateBotMcp } = await import("../servers/gateway/dashboard/panels/bot-mcp-regen.js");
  const r = await regenerateBotMcp(db, BOT);
  assert.equal(r.path, join(BOT_HOME, ".mcp.json"));
  assertActorEverywhere(readWrittenConfig(), BOT, "Glasses");
});

test("the CLI writer carries the bot's actor onto every stdio block", async () => {
  await saveBot();
  execFileSync(process.execPath, ["scripts/pi-bots/mcp_writer.mjs", "write", BOT], {
    cwd: REPO,
    stdio: "pipe",
    env: { ...process.env, HOME, CROW_HOME, CROW_DATA_DIR: DATA, CROW_DB_PATH: DB_FILE, PIBOT_MCP_CONFIG_DELIVERY: "file" },
  });
  assertActorEverywhere(readWrittenConfig(), BOT, "Glasses");
});

// --- a block cannot choose the caller's identity ---------------------------

test("a block's own actor env is stripped, then this turn's actor is applied", () => {
  const def = { tools: { crow_mcp: ["memory/x", "remote/y"] } };
  const blocks = (env) => ({
    mcpServers: {
      memory: { command: "node", args: ["m.js"], env },
      remote: { url: "http://127.0.0.1:1/mcp" },
    },
  });
  const spoilers = [
    { CROW_ACTOR_KIND: "unknown" },
    { CROW_ACTOR_KIND: "owner" },
    { CROW_ACTOR_BOT_ID: "someone-else" },
    { CROW_ACTOR_BOT_NAME: "Someone" },
    { CROW_BOT_SESSION: "someone-else" },
    { CROW_ACTOR_BOT_ID: "glass", CROW_BOT_SESSION: "glass", CROW_ACTOR_THREAD: "t-1" },
  ];
  for (const spoiler of spoilers) {
    const canonical = blocks({ A: "1", ...spoiler });
    const withActor = mcp.buildBotMcp(def, canonical, { botId: BOT, displayName: "Glasses" }).json.mcpServers.memory;
    assert.deepEqual(withActor.env, {
      A: "1", CROW_ACTOR_KIND: "bot", CROW_ACTOR_BOT_ID: BOT, CROW_ACTOR_BOT_NAME: "Glasses",
    }, JSON.stringify(spoiler));
    // No actor (a caller that predates the plumbing): the block keeps only its own names.
    const withoutActor = mcp.buildBotMcp(def, blocks({ A: "1", ...spoiler }), {}).json.mcpServers.memory;
    assert.deepEqual(withoutActor.env, { A: "1" }, JSON.stringify(spoiler));
    // The block handed in is never mutated.
    assert.deepEqual(canonical.mcpServers.memory.env, { A: "1", ...spoiler });
    assert.equal(canonical.mcpServers.remote.env, undefined);
  }
});

test("buildBotMcp takes either option shape: opts.actor or a flat opts.botId", () => {
  const def = { tools: { crow_mcp: ["memory/x"] } };
  const canonical = () => ({ mcpServers: { memory: { command: "node", args: ["m.js"], env: { A: "1" } } } });
  for (const actor of [
    mcp.buildBotMcp(def, canonical(), { actor: { botId: BOT, displayName: "Glasses", threadId: "t-2" } }).json.mcpServers.memory.env,
    mcp.buildBotMcp(def, canonical(), { botId: BOT, displayName: "Glasses", threadId: "t-2" }).json.mcpServers.memory.env,
  ]) {
    assert.equal(actor.CROW_ACTOR_KIND, "bot");
    assert.equal(actor.CROW_ACTOR_BOT_ID, BOT);
    assert.equal(actor.CROW_ACTOR_BOT_NAME, "Glasses");
    assert.equal(actor.CROW_ACTOR_THREAD, "t-2");
  }
  // Two stdio blocks, one actor each; the url block stays untouched.
  const two = mcp.buildBotMcp({ tools: { crow_mcp: ["first/x", "second/y"] } }, {
    mcpServers: {
      first: { command: "node", args: ["a.js"] },
      second: { command: "node", args: ["b.js"] },
    },
  }, { botId: BOT }).json.mcpServers;
  for (const name of ["first", "second"]) {
    assert.equal(two[name].env.CROW_ACTOR_KIND, "bot", name);
    assert.equal(two[name].env.CROW_ACTOR_BOT_ID, BOT, name);
    assert.equal(two[name].env.CROW_ACTOR_BOT_NAME, BOT, "a missing display name falls back to the id");
  }
});

test("the gateway's storage and blog MCP mounts are owner mounts, like /memory", () => {
  for (const p of ["/storage/mcp", "/storage/sse", "/storage/messages", "/blog-mcp/mcp", "/blog-mcp/sse", "/blog-mcp/messages"]) {
    assert.equal(mcp.isOwnerProjectUrl("http://192.0.2.10:3001" + p), true, p);
    assert.equal(mcp.isOwnerProjectUrl("https://crow.example.ts.net:8444" + p), true, p);
  }
  const blocks = {
    "gateway-storage": { url: "http://127.0.0.1:3001/storage/mcp" },
    "gateway-blog": { url: "http://127.0.0.1:3001/blog-mcp/mcp" },
    "third-party": { url: "https://mcp.example.com/mcp" },
  };
  const { json, servers, disabled } = mcp.buildBotMcp({ tools: { crow_mcp: Object.keys(blocks) } }, { mcpServers: blocks }, {});
  for (const name of ["gateway-storage", "gateway-blog"]) {
    assert.deepEqual(json.mcpServers[name], { disabled: true }, name);
    assert.ok(disabled.includes(name), name);
    assert.ok(!servers.includes(name), name);
  }
  assert.deepEqual(json.mcpServers["third-party"], blocks["third-party"]);
});

test("the sandbox wrapper keeps the identity env and the marker", async () => {
  const { scrubSandboxEnv } = await import("../scripts/pi-bots/pi_sandbox.mjs");
  const out = scrubSandboxEnv({
    CROW_ACTOR_KIND: "bot", CROW_ACTOR_BOT_ID: BOT, CROW_ACTOR_BOT_NAME: "Glasses", CROW_BOT_SESSION: BOT,
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1/bus",
  });
  assert.equal(out.CROW_ACTOR_KIND, "bot");
  assert.equal(out.CROW_ACTOR_BOT_ID, BOT);
  assert.equal(out.CROW_ACTOR_BOT_NAME, "Glasses");
  assert.equal(out.CROW_BOT_SESSION, BOT);
  assert.ok(!("DBUS_SESSION_BUS_ADDRESS" in out), "the user-session pointers are still scrubbed");
});

// --- pi's own spawn env ----------------------------------------------------

test("a def's spawn_env cannot set the bot identity or the engine marker", () => {
  const out = bridge.filterSpawnEnv({
    spawn_env: {
      CROW_ACTOR_KIND: "owner", CROW_ACTOR_BOT_ID: "someone-else", CROW_ACTOR_BOT_NAME: "Someone",
      CROW_BOT_SESSION: "someone-else", KEEP: "1",
    },
  });
  assert.deepEqual(out, { KEEP: "1" });
});

test("botSessionEnv is the identity env the engine puts on pi's own process", () => {
  assert.deepEqual(bridge.botSessionEnv("glass", "Glasses"), {
    CROW_ACTOR_KIND: "bot",
    CROW_ACTOR_BOT_ID: "glass",
    CROW_ACTOR_BOT_NAME: "Glasses",
    CROW_BOT_SESSION: "glass",
  });
  assert.equal(bridge.botSessionEnv("glass").CROW_ACTOR_BOT_NAME, "glass", "no display name: the id");
  assert.equal(bridge.botSessionEnv("glass", "G\u0007l\u202easses").CROW_ACTOR_BOT_NAME, "Glasses");
});

/** A stub pi that captures its own environment and stays alive long enough to be read. */
async function spawnStubPi(mode, overrides = {}) {
  const d = join(dir, "pirpc-" + mode);
  mkdirSync(join(d, "sessions"), { recursive: true });
  const capture = join(d, "env.json");
  const stub = join(d, "stub-pi.mjs");
  writeFileSync(stub, [
    'import { writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(capture)}, JSON.stringify(process.env));`,
    "process.stdin.resume();",
    "setTimeout(() => process.exit(0), 20000);",
  ].join("\n"));
  const saved = process.env.CROW_PI_SANDBOX;
  process.env.CROW_PI_SANDBOX = "off";
  let pi = null;
  try {
    const def = {
      permission_policy: { bash: "deny", write_paths: [] },
      spawn_env: {
        CROW_ACTOR_KIND: "owner", CROW_ACTOR_BOT_ID: "someone-else", CROW_ACTOR_BOT_NAME: "Someone",
        CROW_BOT_SESSION: "someone-else", KEEP: "1",
      },
    };
    pi = new bridge.PiRpc({
      def,
      sessionDir: d,
      resolved: { provider: "p", model: "m", key: "p/m" },
      nodeBin: process.execPath,
      cliPath: stub,
      diagLog: () => {},
      botId: BOT,
      displayName: "Glasses",
      mcpDelivery: mode,
      mcpConfig: { mcpServers: {} },
      ...overrides,
    });
  } finally {
    if (saved === undefined) delete process.env.CROW_PI_SANDBOX; else process.env.CROW_PI_SANDBOX = saved;
  }
  try {
    const deadline = Date.now() + 15_000;
    while (!existsSync(capture)) {
      if (Date.now() > deadline || (pi && pi.proc && pi.proc.exitCode !== null)) assert.fail(mode + ": stub pi never captured its env");
      await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, 50)); // the write is one syscall; let it land
    return JSON.parse(readFileSync(capture, "utf8"));
  } finally {
    if (pi && pi.proc && pi.proc.exitCode === null) {
      try { process.kill(-pi.proc.pid, "SIGKILL"); } catch { try { pi.proc.kill("SIGKILL"); } catch {} }
    }
  }
}

for (const mode of ["file", "fd"]) {
  test(`pi's spawn env carries the bot identity in ${mode} mode, never a def's`, { timeout: 30_000 }, async () => {
    const env = await spawnStubPi(mode);
    assert.ok(env.PI_BOT_PERMISSION_POLICY, "the stub really is pi as the bridge spawns it");
    assert.equal(env.CROW_ACTOR_KIND, "bot");
    assert.equal(env.CROW_ACTOR_BOT_ID, BOT);
    assert.equal(env.CROW_ACTOR_BOT_NAME, "Glasses");
    assert.equal(env.CROW_BOT_SESSION, BOT);
    assert.equal(env.KEEP, "1", "an ordinary spawn_env key still passes through");
    assert.ok(!JSON.stringify(env).includes("someone-else"), "the def's actor values are gone");
    if (mode === "fd") assert.equal(env.PI_BOT_MCP_CONFIG_FD, "4", "fd delivery");
    else assert.ok(!("PI_BOT_MCP_CONFIG_FD" in env), "file delivery");
  });

  // A spawn with no bot id (the skill review is one) must not fall back to "nobody said", which
  // reads as unknown = the operator's own client. No actor, and the marker says unbound, so every
  // MCP child pi spawns is the unverified bot and is refused everywhere.
  test(`a spawn with no bot id leaves no actor and marks the session unbound in ${mode} mode`, { timeout: 30_000 }, async () => {
    const env = await spawnStubPi(mode, {
      botId: undefined,
      displayName: undefined,
      // Whatever merged before the identity (opts.extraEnv is not stripped) does not survive it.
      extraEnv: {
        CROW_ACTOR_KIND: "owner", CROW_ACTOR_BOT_ID: "someone-else", CROW_ACTOR_BOT_NAME: "Someone",
        CROW_BOT_SESSION: "someone-else",
      },
    });
    assert.ok(env.PI_BOT_PERMISSION_POLICY, "the stub really is pi as the bridge spawns it");
    assert.equal(env.CROW_BOT_SESSION, "unbound");
    assert.ok(!("CROW_ACTOR_KIND" in env), "no inherited actor kind");
    assert.ok(!("CROW_ACTOR_BOT_ID" in env), "no inherited bot id");
    assert.ok(!("CROW_ACTOR_BOT_NAME" in env), "no inherited bot name");
    assert.ok(!JSON.stringify(env).includes("someone-else"), "the stale identity is gone");
    assert.deepEqual(actorMod.actorFromEnv(env), { kind: "bot", id: null, unverified: true },
      "the unverified bot, which every share rule refuses — never the unknown that is the operator");
    if (mode === "fd") assert.equal(env.PI_BOT_MCP_CONFIG_FD, "4", "fd delivery");
    else assert.ok(!("PI_BOT_MCP_CONFIG_FD" in env), "file delivery");
  });
}

// --- the actor an env resolves to -----------------------------------------

test("actorFromEnv: the engine marker makes a bot session, or an unverified bot", () => {
  const { actorFromEnv } = actorMod;
  assert.deepEqual(actorFromEnv({ CROW_BOT_SESSION: "glass", CROW_ACTOR_KIND: "bot", CROW_ACTOR_BOT_ID: "glass" }),
    { kind: "bot", id: "glass", botSession: true });
  assert.deepEqual(actorFromEnv({ CROW_BOT_SESSION: "glass", CROW_ACTOR_KIND: "bot", CROW_ACTOR_BOT_ID: "someone-else" }),
    { kind: "bot", id: null, unverified: true });
  assert.deepEqual(actorFromEnv({ CROW_BOT_SESSION: "glass" }), { kind: "bot", id: null, unverified: true });
  assert.deepEqual(actorFromEnv({ CROW_BOT_SESSION: "glass", CROW_ACTOR_KIND: "owner" }),
    { kind: "bot", id: null, unverified: true });
  assert.deepEqual(actorFromEnv({ CROW_ACTOR_KIND: "bot", CROW_ACTOR_BOT_ID: "glass" }), { kind: "bot", id: "glass" });
  assert.equal(actorFromEnv({ CROW_ACTOR_KIND: "unknown" }).kind, "unknown");
  assert.equal(actorFromEnv({ CROW_ACTOR_KIND: "unknown" }).unverified, undefined);

  // A pi session on the voice bot's id is an ordinary bound bot: an id is not a credential.
  const session = actorFromEnv({
    CROW_BOT_SESSION: CROW_VOICE_BOT_ID, CROW_ACTOR_KIND: "bot", CROW_ACTOR_BOT_ID: CROW_VOICE_BOT_ID,
  });
  assert.equal(session.botSession, true);
  assert.equal(share.isOperatorVoice(session), false);
  assert.equal(share.isOperatorVoice(share.operatorVoiceActor()), true);
});

test("an unknown actor in a bot session is refused every covered tool; the operator's own env is not", async () => {
  const { actorFromEnv } = actorMod;
  const unverified = actorFromEnv({ CROW_ACTOR_KIND: "unknown", CROW_BOT_SESSION: BOT });
  for (const tool of Object.keys(share.TOOL_CLASS)) {
    const d = await share.decideProjectAccess(db, unverified, { tool });
    assert.equal(d.allowed, false, tool);
    assert.equal(d.code, "owner_only", tool);
  }
  // The operator's own client (no marker) is exactly as before: unknown, not refused.
  const operatorClient = actorFromEnv({ CROW_ACTOR_KIND: "unknown" });
  for (const tool of Object.keys(share.TOOL_CLASS)) {
    assert.equal((await share.decideProjectAccess(db, operatorClient, { tool })).allowed, true, tool);
  }
  // A server built from that env carries the same actor.
  const { createProjectServer } = await import("../servers/research/server.js");
  const server = createProjectServer(DB_FILE, { actor: unverified });
  assert.deepEqual(server.research.actor, { kind: "bot", id: null, unverified: true });
});

test("the combined core server gives memory and storage the env actor too", () => {
  const src = readFileSync(join(REPO, "servers/core/server.js"), "utf8");
  assert.match(src, /const envActor = actorFromEnv\(process\.env\)/);
  assert.match(src, /name === "storage" \? factory\(dbPath, \{ baseActor: envActor \}\)/);
  assert.match(src, /name === "memory" \|\| name === "projects" \? factory\(dbPath, \{ actor: envActor \}\)/);
});

// --- the storage server resolves who is calling ----------------------------

async function inProcess(serverFactory, options) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const server = serverFactory(DB_FILE, options);
  const client = new Client({ name: "share-identity-test", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { server, client, close: async () => { try { await client.close(); } catch {} } };
}

test("the in-process storage server resolves a bot actor from the bound bot's _meta", async () => {
  const { createStorageServer } = await import("../servers/storage/server.js");
  const seen = [];
  const c = await inProcess(createStorageServer, { onCallActor: (actor, tool) => seen.push({ actor, tool }) });
  try {
    await c.client.callTool({
      name: "crow_list_files",
      arguments: {},
      _meta: { "crow/actor": { kind: "bot", id: BOT } },
    });
  } finally {
    await c.close();
  }
  assert.deepEqual(seen.at(-1), { actor: { kind: "bot", id: BOT }, tool: "crow_list_files" });
});

test("the storage server keeps an operator-voice base actor as the frozen singleton", async () => {
  const { createStorageServer } = await import("../servers/storage/server.js");
  const op = share.operatorVoiceActor();
  const seen = [];
  const c = await inProcess(createStorageServer, { baseActor: op, onCallActor: (actor) => seen.push(actor) });
  try {
    assert.equal(c.server.storage.actor, op);
    await c.client.callTool({
      name: "crow_storage_stats",
      arguments: {},
      _meta: { "crow/actor": { kind: "bot", id: BOT } },
    });
  } finally {
    await c.close();
  }
  assert.equal(seen.at(-1), op, "a fixed bot base actor is never narrowed");
  assert.equal(share.isOperatorVoice(seen.at(-1)), true);
});

// --- the gateway executor's base actor -------------------------------------

test("an executor bound to the voice bot gives projects, memory and storage operator scope", async () => {
  const { createToolExecutor } = await import("../servers/gateway/ai/tool-executor.js");
  const op = share.operatorVoiceActor();
  const voice = createToolExecutor({ botDef: { bot_id: CROW_VOICE_BOT_ID, kind: "voice", display_name: "Crow" } });
  try {
    for (const category of ["projects", "memory", "storage"]) {
      const actor = voice.baseActorFor(category);
      assert.equal(actor, op, category);
      assert.equal(share.isOperatorVoice(actor), true, category);
    }
    // The same id without the def's voice kind (a row that predates it) is still the voice bot.
    const byId = createToolExecutor({ botDef: { bot_id: CROW_VOICE_BOT_ID } });
    try {
      assert.equal(byId.baseActorFor("memory"), op);
    } finally { await byId.close(); }
  } finally {
    await voice.close();
  }
});

test("a def that merely says kind:'voice' on another bot's id is still a plain bot actor", async () => {
  const { createToolExecutor } = await import("../servers/gateway/ai/tool-executor.js");
  // A bot writes its own def, so `kind` is the bot's own word and never a credential.
  const ex = createToolExecutor({ botDef: { bot_id: "other.bot", kind: "voice", display_name: "Not Crow" } });
  try {
    for (const category of ["projects", "memory", "storage"]) {
      const actor = ex.baseActorFor(category);
      assert.deepEqual(actor, { kind: "bot", id: "other.bot" }, category);
      assert.equal(share.isOperatorVoice(actor), false, category);
    }
  } finally {
    await ex.close();
  }
});

test("an executor bound to another bot gives projects, memory and storage a plain bot actor", async () => {
  const { createToolExecutor } = await import("../servers/gateway/ai/tool-executor.js");
  const ex = createToolExecutor({ botDef: { bot_id: BOT, display_name: "Glasses" } });
  try {
    for (const category of ["projects", "memory", "storage"]) {
      const actor = ex.baseActorFor(category);
      assert.deepEqual(actor, { kind: "bot", id: BOT }, category);
      assert.equal(share.isOperatorVoice(actor), false, category);
    }
  } finally {
    await ex.close();
  }
  // An unbound executor passes none: its servers resolve their own env (the operator's chat).
  const unbound = createToolExecutor({});
  try {
    for (const category of ["projects", "memory", "storage"]) {
      assert.equal(unbound.baseActorFor(category), undefined, category);
    }
  } finally {
    await unbound.close();
  }
});

/** Build one category's in-process server through the real getClient path (discovery builds it and
 *  runs no handler), so the actor read back is the one the server was CONSTRUCTED with. */
async function buildCategory(ex, category) {
  await ex.executeTool("crow_discover", { category, action: "crow_no_such_action" });
  const server = ex._inProcessServers.get(category);
  assert.ok(server, `${category}: the executor built its in-process server`);
  return server;
}

test("the servers the executor actually builds hold the base actor, voice bot and plain bot alike", async () => {
  const { createToolExecutor } = await import("../servers/gateway/ai/tool-executor.js");
  const op = share.operatorVoiceActor();
  // A project-less memory is what a bot's read scope never includes, so the count tells
  // which base actor the memory server holds (it reports no actor of its own).
  await db.execute({
    sql: "INSERT INTO memories (content, category, importance) VALUES (?, 'general', 5)",
    args: ["The heron lands at the xylophone bridge"],
  });
  const voice = createToolExecutor({ botDef: { bot_id: CROW_VOICE_BOT_ID, display_name: "Crow" } });
  const other = createToolExecutor({ botDef: { bot_id: BOT, display_name: "Glasses" } });
  try {
    assert.equal((await buildCategory(voice, "projects")).research.actor, op, "projects");
    assert.deepEqual((await buildCategory(other, "projects")).research.actor, { kind: "bot", id: BOT }, "projects");
    assert.equal((await buildCategory(voice, "storage")).storage.actor, op, "storage");
    assert.deepEqual((await buildCategory(other, "storage")).storage.actor, { kind: "bot", id: BOT }, "storage");

    const stats = async (ex) => (await ex.executeTool("crow_memory", { action: "memory_stats", params: {} })).result;
    assert.match(await stats(voice), /Total memories: 1/, "the operator-voice base actor reads the project-less memory");
    assert.match(await stats(other), /Total memories: 0/, "a plain bot's read scope excludes it");
  } finally {
    await voice.close();
    await other.close();
  }
});

// The actor is written down in ONE place: getClient builds a server's options from baseActorFor
// through factoryOptionsFor, never from a second copy of the actor.
test("the executor's factory options come from its one base-actor helper", () => {
  const src = readFileSync(join(REPO, "servers/gateway/ai/tool-executor.js"), "utf8");
  assert.match(src, /createInProcessClient\(category, factory, factoryOptionsFor\(category\)\)/);
  assert.equal(src.match(/\{ baseActor \}/g).length, 1, "one storage option shape");
  assert.ok(src.indexOf('category === "storage" ? { baseActor }') > src.indexOf("const factoryOptionsFor"),
    "the actor→option mapping lives inside factoryOptionsFor");
});

// --- the router's base actor ----------------------------------------------

async function connect(server) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const client = new Client({ name: "share-identity-router", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

const text = (r) => (r.content || []).map((b) => b.text || "").join("");

test("a router gives the memory and storage servers the same base actor it gives projects", async () => {
  const { createRouterServer } = await import("../servers/gateway/router.js");
  const { OWNER } = actorMod;
  const ownerRouter = createRouterServer({ actor: OWNER });
  const botRouter = createRouterServer({ actor: { kind: "bot", id: BOT } });
  const owner = await connect(ownerRouter);
  const bot = await connect(botRouter);
  const built = async (routerServer, client, category) => {
    await client.callTool({ name: "crow_discover", arguments: { category, action: "crow_no_such_action" } });
    const server = routerServer._inProcessServers.get(category);
    assert.ok(server, `${category}: the router built its in-process server`);
    return server;
  };
  try {
    // The mount's own actor object, not a copy of it.
    assert.equal((await built(ownerRouter, owner, "projects")).research.actor, OWNER, "projects");
    assert.equal((await built(ownerRouter, owner, "storage")).storage.actor, OWNER, "storage");
    assert.equal((await built(botRouter, bot, "projects")).research.actor.kind, "bot", "projects");
    assert.equal((await built(botRouter, bot, "storage")).storage.actor.id, BOT, "storage");

    // Memory reports no actor of its own: the writing rules refuse a bot base and only a bot base,
    // so the refusal is what shows which base actor the memory server holds.
    const updateWritingStyle = (client) => client.callTool({
      name: "crow_memory",
      arguments: { action: "update_context_section", params: { section_key: "writing_style", content: "# Rules" } },
    });
    assert.match(text(await updateWritingStyle(bot)), /can only be changed by the operator/, "a bot base actor is refused");
    assert.doesNotMatch(text(await updateWritingStyle(owner)), /can only be changed by the operator/, "the mount's actor is not a bot");
  } finally {
    try { await owner.close(); } catch {}
    try { await bot.close(); } catch {}
  }
});