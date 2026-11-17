/**
 * The sharing server's tools are OWNER-ONLY for bots, on every path — with one exception.
 *
 * The decision: a bot never uses crow_share, or any sharing tool that sends or exports project data
 * to a contact or a peer, changes who can reach this instance, or reveals contacts/peers — including
 * the operator's own voice bot when that bot is anything but the frozen executor actor (a relayed
 * turn can put words in its mouth). The one exception is the frozen operator-voice actor, which is
 * the operator's own voice executor: it keeps exactly crow_send_message and crow_voice_memo (a voice
 * turn says something to a contact) and nothing else (VOICE_ALLOWED). Exactly one tool is harmless
 * for every bot: the static crosspost-transform list.
 *
 * What this file drives, all against a real `createSharingServer` on a scratch crow.db:
 *
 *   (a) the classification has no drift: the map and the server's registered tools are the same set;
 *   (b) each path a bot can take to this server is refused, and the handler never runs — no
 *       `shared_items` row, no `crosspost_log` row, no peer/nostr call:
 *         stdio env actor, per-call `_meta` actor, `x-crow-actor-*` header actor, an unverified-bot
 *         env (the engine marker with no bot identity), the frozen operator-voice actor as the
 *         server's base actor (refused everything but its two voice tools — see (b4)), the
 *         in-process tool executor bound to a normal bot and to the voice bot, and a gateway router
 *         BUILT for a bot actor (a call carrying no `_meta` at all is still that bot's call);
 *   (b3) a registration the guard cannot see the call's actor through — `server.tool` with no
 *       schema object before its handler, or `server.registerTool` — is refused when it happens,
 *       so no tool can be added to this surface unguarded;
 *   (b4) the frozen operator-voice actor: exactly crow_send_message and crow_voice_memo reach their
 *       handlers, every other tool is refused, and the same calls from any other bot (another bot,
 *       the engine's env actor with the reserved id, a per-call _meta/header claim, an un-frozen
 *       copy of the actor) are refused;
 *   (c) the one harmless tool still works for a bot;
 *   (d) the owner and an unidentified caller still reach the server (status, contacts);
 *   (e) a bot that holds a live project share is refused exactly the same.
 *
 * The confirm token proves "the handler never ran" rather than "the token was bad": ONE owner
 * preview mints it, every bot path is handed that token, and the owner executes with it afterwards
 * (a handler that ran would have consumed the single-use token and written the row).
 *
 * No network: CROW_DISABLE_NOSTR + CROW_DISABLE_INSTANCE_SYNC keep the boot offline. Scratch
 * CROW_HOME/data dir, a real crow.db from scripts/init-db.js; nothing here touches ~/.crow.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "share-sharing-tools-"));
const DATA = join(dir, "data");
const HOME = join(dir, "home");
const CROW_HOME = join(dir, "crow");
mkdirSync(DATA, { recursive: true });
mkdirSync(HOME, { recursive: true });
mkdirSync(CROW_HOME, { recursive: true });
process.env.HOME = HOME;
process.env.CROW_HOME = CROW_HOME;
process.env.CROW_DATA_DIR = DATA;
process.env.CROW_DB_PATH = join(DATA, "crow.db");
process.env.CROW_TASKS_DB_PATH = join(DATA, "tasks.db");
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
process.env.CROW_DISABLE_NOSTR = "1";
process.env.CROW_DISABLE_HEALTH_MONITOR = "1";
// The share tools' confirmation gate is part of the proof below: it must not be skipped.
delete process.env.CROW_SKIP_CONFIRM_GATES;

const REPO = join(import.meta.dirname, "..");
const DB_FILE = join(DATA, "crow.db");

// Plausible bot ids, and the two fixed actor shapes the paths use.
const ENV_BOT = "sharing-env-bot";
const META_BOT = "sharing-meta-bot";
const HDR_BOT = "sharing-header-bot";
const ROUTER_BOT = "sharing-router-bot";
const UNVERIFIED_SESSION = "sharing-unverified-session";

const OWNER_ONLY_TEXT = "Error: That tool is for the operator only.";

let db = null;
let createSharingServer = null;
let Client = null;
let InMemoryTransport = null;
let actor = null;
let scope = null;
let managers = null;
let getSharedManagers = null;
let createProjectSpace = null;
let grantShare = null;
let CROW_VOICE_BOT_ID = null;
let SHARING_TOOL_CLASS = null;
let VOICE_ALLOWED = null;
let MEMORY_ID = null;
let CONTACT_CROW_ID = null;
let openShared = []; // every { client, server } this file built, closed in after()

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env }, stdio: "pipe", cwd: REPO });
  const { createDbClient } = await import("../servers/db.js");
  db = createDbClient(DB_FILE);
  ({ createSharingServer } = await import("../servers/sharing/server.js"));
  ({ getSharedManagers } = await import("../servers/sharing/managers.js"));
  ({ Client } = await import("@modelcontextprotocol/sdk/client/index.js"));
  ({ InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js"));
  actor = await import("../servers/research/actor.js");
  scope = await import("../servers/shared/project-share-scope.js");
  ({ createProjectSpace } = await import("../servers/shared/project-spaces.js"));
  ({ grantShare } = await import("../servers/shared/project-bot-shares.js"));
  ({ CROW_VOICE_BOT_ID } = await import("../servers/shared/voice-bot.js"));
  ({ SHARING_TOOL_CLASS, VOICE_ALLOWED } = await import("../servers/sharing/bot-owner-only.js"));

  // The contact and the memory the share tools operate on: with these present, `crow_share` would
  // really send if its handler ran, which is what the bot paths below must not reach.
  CONTACT_CROW_ID = "crowsharingcontact01";
  await db.execute({
    sql: `INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey, origin)
          VALUES (?, 'Sharing Contact', ?, ?, 'remote')`,
    args: [CONTACT_CROW_ID, "a".repeat(64), "b".repeat(66)],
  });
  const mem = await db.execute({
    sql: "INSERT INTO memories (content, category, importance) VALUES ('A heron note for sharing', 'general', 5)",
    args: [],
  });
  MEMORY_ID = Number(mem.lastInsertRowid);

  // The boot happens on the first createSharingServer call; the spies below then watch the shared
  // managers every handler was given.
  managers = getSharedManagers(DB_FILE);
  installSpies();
  createSharingServer(DB_FILE, { baseActor: actor.OWNER });
});

after(async () => {
  for (const entry of openShared) await entry.close();
  restoreSpies();
  try { db && db.close && db.close(); } catch { /* already closed */ }
  rmSync(dir, { recursive: true, force: true });
});

// --- spying on the side effects a handler would leave ---------------------------------------

let peerCalls = [];
let restoreSpies = () => {};

function installSpies() {
  const pm = managers.peerManager;
  const nm = managers.nostrManager;
  const before = { isConnected: pm.isConnected, send: pm.send, sendMessage: nm.sendMessage };
  pm.isConnected = (...args) => { peerCalls.push({ call: "peerManager.isConnected", args }); return false; };
  pm.send = (...args) => { peerCalls.push({ call: "peerManager.send", args }); };
  nm.sendMessage = async (...args) => {
    peerCalls.push({ call: "nostrManager.sendMessage", args });
    return { relays: ["wss://relay.invalid"] };
  };
  restoreSpies = () => {
    pm.isConnected = before.isConnected;
    pm.send = before.send;
    nm.sendMessage = before.sendMessage;
  };
}

// --- harness --------------------------------------------------------------------------------

const textOf = (r) => (r.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");

/** A sharing server wired to an in-process client. */
async function open(options = {}) {
  return mount(createSharingServer(DB_FILE, options));
}

/** Any McpServer wired to an in-process client (the router is mounted the same way). */
async function mount(server) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport)]);
  const client = new Client({ name: "share-sharing-tools", version: "0" });
  await client.connect(clientTransport);
  const entry = {
    server,
    client,
    async call(name, args = {}, meta) {
      const params = { name, arguments: args };
      if (meta) params._meta = { "crow/actor": meta };
      const r = await client.callTool(params);
      return { text: textOf(r), isError: !!r.isError };
    },
    async close() {
      try { await client.close(); } catch { /* gone */ }
      try { await server.close(); } catch { /* gone */ }
    },
  };
  openShared.push(entry);
  return entry;
}

/**
 * A server built under a given actor env. The env is laid over a cleared CROW_ACTOR_* set only
 * while the server is CONSTRUCTED (the base actor is fixed then) and restored before any call —
 * the same order the other share-path tests use.
 */
const ACTOR_ENV_KEYS = ["CROW_ACTOR_KIND", "CROW_ACTOR_BOT_ID", "CROW_ACTOR_BOT_NAME", "CROW_ACTOR_THREAD", "CROW_BOT_SESSION"];
async function openUnderEnv(env, options = {}) {
  const saved = new Map(ACTOR_ENV_KEYS.map((k) => [k, process.env[k]]));
  let entry = null;
  try {
    for (const k of ACTOR_ENV_KEYS) delete process.env[k];
    Object.assign(process.env, env);
    entry = await open(options);
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
  return entry;
}

/**
 * Call through the handler the server registered, with a synthetic `extra` — how a per-call actor
 * that only arrives on the wire (the `x-crow-actor-*` request headers) reaches a server. The
 * registered handler IS the guard, so this is the same code the HTTP mount runs.
 */
function handlerCall(entry, extra) {
  return async (name, args = {}) => {
    const tool = entry.server._registeredTools[name];
    assert.ok(tool && typeof tool.handler === "function", `${name} is registered`);
    const r = await tool.handler(args, extra);
    return { text: textOf(r), isError: !!r.isError };
  };
}

const headerExtra = (botId) => ({ requestInfo: { headers: { "x-crow-actor-kind": "bot", "x-crow-actor-id": botId } } });

const rows = async (sql, args = []) => (await db.execute({ sql, args })).rows;
const count = async (sql, args = []) => Number((await rows(sql, args))[0].n);

/** The side effects a sharing handler leaves behind, if it runs. */
async function sideEffects() {
  return {
    shared: await count("SELECT COUNT(*) AS n FROM shared_items"),
    crosspost: await count("SELECT COUNT(*) AS n FROM crosspost_log"),
  };
}

const shareArgs = (token) => ({
  contact: CONTACT_CROW_ID,
  share_type: "memory",
  item_id: MEMORY_ID,
  permissions: "read",
  confirm_token: token,
});
const sendArgs = () => ({ contact: CONTACT_CROW_ID, message: "hello from a bot" });
const crosspostArgs = (key) => ({
  source_app: "blog",
  source_post_id: "post-1",
  source_post: { title: "A share test post", url: "https://blog.invalid/post-1", excerpt: "Excerpt." },
  target_app: "gotosocial",
  idempotency_key: key,
  confirm: "yes",
});

/** A tool call the guard must refuse, with the proof that nothing ran. */
async function expectOwnerOnly(call, label, tool, args, sentinel) {
  peerCalls = [];
  const before = await sideEffects();
  const r = await call(tool, args);
  assert.equal(r.isError, true, `${label} ${tool}: ${r.text}`);
  assert.equal(r.text, OWNER_ONLY_TEXT, `${label} ${tool}: the fixed owner-only refusal`);
  assert.deepEqual(peerCalls, [], `${label} ${tool}: no peer or nostr call`);
  const after = await sideEffects();
  assert.deepEqual(after, before, `${label} ${tool}: no row written`);
  assert.ok(sentinel === undefined || !r.text.includes(sentinel), `${label} ${tool}: never reaches the handler`);
}

// --- (a) the classification has no drift ----------------------------------------------------

test("every registered sharing tool is classed, and every class entry is registered", async () => {
  const entry = await open({ baseActor: actor.OWNER });
  const registered = Object.keys(entry.server._registeredTools);
  const classed = Object.keys(SHARING_TOOL_CLASS).sort();

  assert.deepEqual(registered.slice().sort(), classed, "the map and the tool surface are the same set");
  assert.equal(registered.length, 37, "the sharing surface has 37 tools");
  assert.equal(classed.length, 37, "the classification has 37 entries");
  // The guard must not have moved a registration: both ends of the frozen order still hold.
  assert.equal(registered[0], "crow_generate_invite");
  assert.equal(registered.at(-1), "crow_list_crossposts");
  for (const [name, cls] of Object.entries(SHARING_TOOL_CLASS)) {
    assert.ok(cls === "owner_only" || cls === "harmless", `${name}: ${cls}`);
  }
  const harmless = Object.entries(SHARING_TOOL_CLASS).filter(([, cls]) => cls === "harmless").map(([n]) => n);
  assert.deepEqual(harmless, ["crow_list_crosspost_transforms"], "exactly one harmless tool");
});

// --- (b) every bot path is refused, and the handler never runs ------------------------------

test("a bot is refused crow_share, crow_send_message and crow_crosspost on every path, and no handler runs", { timeout: 180_000 }, async () => {
  // ONE owner preview mints the confirm token every path below is handed. A handler that ran would
  // consume the single-use token and write the row, so the owner's execute at the end is a tripwire.
  const owner = await open({ baseActor: actor.OWNER });
  const preview = await owner.call("crow_share", shareArgs(""));
  assert.equal(preview.isError, false, preview.text);
  const token = /confirm_token: "([^"]+)"/.exec(preview.text)?.[1];
  assert.ok(token, `the preview carries a confirm token: ${preview.text}`);

  const before = await sideEffects();
  assert.deepEqual(before, { shared: 0, crosspost: 0 }, "nothing has been written yet");

  /** The paths, each built so the bot actor is the one that path really produces. */
  const paths = [];

  // 1. the stdio env actor: the process env, as a bot's MCP child gets it.
  {
    const e = await openUnderEnv({ CROW_ACTOR_KIND: "bot", CROW_ACTOR_BOT_ID: ENV_BOT });
    assert.deepEqual(e.server.sharing.actor, { kind: "bot", id: ENV_BOT }, "the base actor is the env bot");
    paths.push({ label: "stdio env actor", call: e.call });
  }

  // 2. a per-call `crow/actor` in _meta, over an owner mount.
  {
    const e = await open({ baseActor: actor.OWNER });
    paths.push({ label: "_meta actor", call: (t, a) => e.call(t, a, { kind: "bot", id: META_BOT }) });
  }

  // 3. an `x-crow-actor-*` header, as the /sharing HTTP mount reads it.
  {
    const e = await open({ baseActor: actor.OWNER });
    paths.push({ label: "x-crow-actor header", call: handlerCall(e, headerExtra(HDR_BOT)) });
  }

  // 4. an unverified bot: the engine's marker with no bot identity in the env.
  {
    const e = await openUnderEnv({ CROW_BOT_SESSION: UNVERIFIED_SESSION, CROW_ACTOR_KIND: "unknown" });
    assert.equal(e.server.sharing.actor.unverified, true, "the marker with no bot id is the unverified bot");
    paths.push({ label: "unverified-bot env", call: e.call });
  }

  // 5. the operator's own voice bot, as the server's frozen base actor.
  {
    const frozen = scope.operatorVoiceActor();
    const e = await open({ baseActor: frozen });
    assert.equal(e.server.sharing.actor, frozen, "the frozen operator-voice actor is the base");
    assert.equal(scope.isOperatorVoice(e.server.sharing.actor), true);
    paths.push({ label: "operator-voice base actor", call: e.call, voice: true });
  }

  // 6./7. the in-process tool executor, bound to a normal bot and to the voice bot.
  {
    const { createToolExecutor } = await import("../servers/gateway/ai/tool-executor.js");
    const viaCategory = (ex) => async (tool, args) => {
      const r = await ex.executeTool("crow_sharing", { action: tool, params: args });
      return { text: String(r.result), isError: !!r.isError };
    };
    const bound = createToolExecutor({ botDef: { bot_id: ENV_BOT, display_name: "Sharing Bot" } });
    const voice = createToolExecutor({ botDef: { bot_id: CROW_VOICE_BOT_ID, display_name: "Crow" } });
    openShared.push({
      close: async () => {
        try { await bound.close(); } catch { /* gone */ }
        try { await voice.close(); } catch { /* gone */ }
      },
    });

    // Discovery builds the category's in-process server and runs no handler, so the base actor
    // read back is the one the sharing server was CONSTRUCTED with.
    await bound.executeTool("crow_discover", { category: "sharing", action: "crow_no_such_action" });
    const boundServer = bound._inProcessServers.get("sharing");
    assert.ok(boundServer, "the executor built its in-process sharing server");
    assert.deepEqual(boundServer.sharing.actor, { kind: "bot", id: ENV_BOT }, "the executor's sharing server holds the bound bot");
    paths.push({ label: "executor bound bot", call: viaCategory(bound) });

    await voice.executeTool("crow_discover", { category: "sharing", action: "crow_no_such_action" });
    const voiceServer = voice._inProcessServers.get("sharing");
    assert.ok(voiceServer, "the voice executor built its in-process sharing server");
    assert.equal(voiceServer.sharing.actor, scope.operatorVoiceActor(), "the voice executor's sharing server holds the frozen actor");
    assert.equal(scope.isOperatorVoice(voiceServer.sharing.actor), true);
    paths.push({ label: "executor voice bot", call: viaCategory(voice), voice: true });
  }

  // 8. the gateway router, which forwards the caller's actor with every call it dispatches.
  {
    const { createRouterServer } = await import("../servers/gateway/router.js");
    const router = await mount(createRouterServer({ actor: actor.OWNER }));
    paths.push({
      label: "gateway router",
      call: (tool, args) => router.call("crow_sharing", { action: tool, params: args }, { kind: "bot", id: META_BOT }),
    });
  }

  let seq = 0;
  for (const path of paths) {
    await expectOwnerOnly(path.call, path.label, "crow_share", shareArgs(token), "This will share");
    // The operator's own voice executor keeps crow_send_message (and crow_voice_memo): it is the one
    // bot actor the sharing guard lets past, and (b4) is where that exception is pinned. Every other
    // path here is refused it.
    if (path.voice !== true) await expectOwnerOnly(path.call, path.label, "crow_send_message", sendArgs());
    seq += 1;
    await expectOwnerOnly(path.call, path.label, "crow_crosspost", crosspostArgs(`sharing-bot-path-${seq}-${Date.now()}`));
  }

  // The tripwire: the token the bots were handed is still valid, so the owner's execute works —
  // the refusals above were the guard, not an invalid token, and no handler consumed it.
  const executed = await owner.call("crow_share", shareArgs(token));
  assert.equal(executed.isError, false, executed.text);
  assert.match(executed.text, /^Shared memory #/, executed.text);
  assert.equal(await count("SELECT COUNT(*) AS n FROM shared_items"), 1, "exactly the owner's share is recorded");
});

// --- (b2) a router built FOR a bot actor ---------------------------------------------------

test("a router built for a bot actor refuses crow_share with no per-call _meta", { timeout: 120_000 }, async () => {
  const { createRouterServer } = await import("../servers/gateway/router.js");
  // A bot session mounts the router ONCE, built with that bot's actor — the same way the storage
  // category is built. A call that carries no `_meta` at all (the ordinary case for a local MCP
  // client) is still that bot's call, so the sharing server must be constructed with the bot as its
  // base actor: without it the base actor is whatever the process env says, which for the gateway
  // is nobody in particular.
  const botRouter = await mount(createRouterServer({ actor: { kind: "bot", id: ROUTER_BOT } }));
  const viaRouter = (tool, args) => botRouter.call("crow_sharing", { action: tool, params: args });

  await expectOwnerOnly(viaRouter, "bot-actor router (no _meta)", "crow_share", shareArgs("bot-router-token"), "This will share");
  await expectOwnerOnly(viaRouter, "bot-actor router (no _meta)", "crow_list_contacts", {});
  await expectOwnerOnly(viaRouter, "bot-actor router (no _meta)", "crow_send_message", sendArgs());

  // The category is mounted, not merely refused: the one harmless tool still answers a bot. This
  // call is also what builds the router's in-process sharing server, so the base actor it holds can
  // be read back — the same seam the storage category is checked through.
  const harmless = await viaRouter("crow_list_crosspost_transforms", {});
  assert.equal(harmless.isError, false, harmless.text);
  assert.match(harmless.text, /writefreely→mastodon/, harmless.text);
  const builtSharing = botRouter.server._inProcessServers.get("sharing");
  assert.ok(builtSharing, "the router built its in-process sharing server");
  assert.deepEqual(builtSharing.sharing.actor, { kind: "bot", id: ROUTER_BOT },
    "the router hands the sharing server the actor it was built with, as it does for storage");

  // And an owner-built router is unchanged: no `_meta` still reaches the server as the owner.
  const ownerRouter = await mount(createRouterServer({ actor: actor.OWNER }));
  const status = await ownerRouter.call("crow_sharing", { action: "crow_sharing_status", params: {} });
  assert.equal(status.isError, false, status.text);
  assert.match(status.text, /Crow Sharing Status/, status.text);
  assert.equal(ownerRouter.server._inProcessServers.get("sharing").sharing.actor, actor.OWNER,
    "the owner's router hands the sharing server the owner");
});

// --- (b3) a registration the guard could not guard is refused at registration --------------

test("the sharing guard refuses to register a tool it could not see the call's actor through", async () => {
  const { guardSharingServer } = await import("../servers/sharing/bot-owner-only.js");
  const registered = [];
  const fake = {
    tool: (name, ...rest) => registered.push([name, ...rest]),
    registerTool: () => { throw new Error("the guard must replace registerTool"); },
  };
  guardSharingServer(fake, { baseActor: actor.OWNER });

  // The guard reads the call's `extra` from the handler's second argument. A registration with no
  // schema (or annotations) object between the name and the handler calls that handler with
  // `extra` alone, which the guard cannot tell from the call's `args` — so it refuses the
  // registration instead of installing a handler it cannot guard.
  assert.throws(() => fake.tool("crow_no_schema", "a description", () => ({ content: [] })),
    /sharing guard[\s\S]*schema/, "tool(name, description, handler) is refused");
  assert.throws(() => fake.tool("crow_bare", () => ({ content: [] })),
    /sharing guard[\s\S]*schema/, "tool(name, handler) is refused");
  assert.throws(() => fake.tool("crow_no_handler"),
    /sharing guard/, "a registration with no callback at all is refused");
  assert.deepEqual(registered, [], "nothing was registered behind the guard's back");

  // registerTool() takes a config object and a callback: the tool() wrapper never sees it, so a
  // tool registered that way would reach its handler unguarded. It throws instead.
  assert.throws(() => fake.registerTool("crow_via_register_tool", { description: "x" }, () => ({ content: [] })),
    /sharing guard[\s\S]*registerTool/, "registerTool() is refused on a guarded server");
  assert.deepEqual(registered, [], "still nothing registered");

  // A well-shaped registration is still installed, and is still the guard: a bot is refused and the
  // handler does not run.
  let ran = false;
  const botGuard = guardSharingServer(
    { tool: (name, ...rest) => registered.push([name, ...rest]), registerTool: () => {} },
    { baseActor: { kind: "bot", id: ROUTER_BOT } },
  );
  assert.ok(botGuard, "guardSharingServer returns the server it guarded");
  botGuard.tool("crow_share", "share something", {}, () => { ran = true; return { content: [] }; });
  assert.equal(registered.length, 1, "a well-shaped registration goes through");
  const botRefused = await registered.at(-1).at(-1)({}, undefined);
  assert.equal(ran, false, "a bot never reaches the guarded handler");
  assert.equal(botRefused.isError, true);
  assert.equal(botRefused.content[0].text, OWNER_ONLY_TEXT);
});

// --- (b4) the frozen operator-voice actor: exactly two sharing tools -----------------------

test("the frozen operator-voice actor reaches crow_send_message and crow_voice_memo, and nothing else",
  { timeout: 120_000 }, async () => {
    const voice = await open({ baseActor: scope.operatorVoiceActor() });

    // Allowed: the guard passes the call to the handler, so the answer is the handler's own (a
    // missing contact, a kiosk refusal) — never the fixed owner-only refusal.
    for (const [tool, args] of [
      ["crow_send_message", sendArgs()],
      ["crow_voice_memo", { contact: CONTACT_CROW_ID, message: "a memo from the voice turn" }],
    ]) {
      const r = await voice.call(tool, args);
      assert.notEqual(r.text, OWNER_ONLY_TEXT, `${tool} reaches its handler: ${r.text}`);
    }

    // Refused: every other tool, including the ones a spoken turn has no business with.
    for (const [tool, args] of [
      ["crow_share", shareArgs("voice-turn-token")],
      ["crow_crosspost", crosspostArgs("sharing-voice-" + Date.now())],
      ["crow_send_group_message", { group: "friends", message: "hello" }],
      ["crow_room_invite", { contact: CONTACT_CROW_ID }],
    ]) {
      const r = await voice.call(tool, args);
      assert.equal(r.isError, true, `${tool}: ${r.text}`);
      assert.equal(r.text, OWNER_ONLY_TEXT, `${tool}: the fixed owner-only refusal`);
    }

    // The allowlist is those two names, exported frozen, and both stay owner_only in the map (the
    // map's values are unchanged: the exception lives in its own set).
    assert.deepEqual([...VOICE_ALLOWED].sort(), ["crow_send_message", "crow_voice_memo"]);
    assert.equal(Object.isFrozen(VOICE_ALLOWED), true, "the allowlist is frozen");
    for (const name of VOICE_ALLOWED) assert.equal(SHARING_TOOL_CLASS[name], "owner_only", name);

    // Another bot is refused both of them.
    const other = await openUnderEnv({ CROW_ACTOR_KIND: "bot", CROW_ACTOR_BOT_ID: ENV_BOT });
    for (const [tool, args] of [
      ["crow_send_message", sendArgs()],
      ["crow_voice_memo", { contact: CONTACT_CROW_ID, message: "m" }],
    ]) {
      const r = await other.call(tool, args);
      assert.equal(r.text, OWNER_ONLY_TEXT, `${tool} for another bot: ${r.text}`);
    }

    // The reserved id is a claim, not a credential:
    // - the pi engine's env actor with that id (no marker),
    const engineVoice = await openUnderEnv({ CROW_ACTOR_KIND: "bot", CROW_ACTOR_BOT_ID: CROW_VOICE_BOT_ID });
    assert.deepEqual(engineVoice.server.sharing.actor, { kind: "bot", id: CROW_VOICE_BOT_ID },
      "the env actor carries no marker");
    assert.equal((await engineVoice.call("crow_send_message", sendArgs())).text, OWNER_ONLY_TEXT);
    // - a per-call _meta actor with that id,
    const asMeta = await open({ baseActor: actor.OWNER });
    const viaMeta = await asMeta.call("crow_send_message", sendArgs(), { kind: "bot", id: CROW_VOICE_BOT_ID });
    assert.equal(viaMeta.text, OWNER_ONLY_TEXT, "a per-call crow.voice actor is refused");
    // - an x-crow-actor header with that id,
    const asHeader = await open({ baseActor: actor.OWNER });
    const viaHeader = await handlerCall(asHeader, headerExtra(CROW_VOICE_BOT_ID))("crow_send_message", sendArgs());
    assert.equal(viaHeader.text, OWNER_ONLY_TEXT, "a crow.voice header actor is refused");
    // - and a plain COPY of the actor, flag and all, that is not the frozen one.
    const copy = await open({ baseActor: { kind: "bot", id: CROW_VOICE_BOT_ID, operatorVoice: true } });
    assert.equal(scope.isOperatorVoice(copy.server.sharing.actor), false, "a copy is not the frozen actor");
    assert.equal((await copy.call("crow_send_message", sendArgs())).text, OWNER_ONLY_TEXT,
      "an un-frozen copy carrying the flag is refused");
  });

// --- (c) the one harmless tool still works for a bot ---------------------------------------

test("crow_list_crosspost_transforms is the one tool a bot still reaches", { timeout: 120_000 }, async () => {
  const envBot = await openUnderEnv({ CROW_ACTOR_KIND: "bot", CROW_ACTOR_BOT_ID: ENV_BOT });
  const listed = await envBot.call("crow_list_crosspost_transforms", {});
  assert.equal(listed.isError, false, listed.text);
  assert.match(listed.text, /writefreely→mastodon/, listed.text);

  const metaBot = await open({ baseActor: actor.OWNER });
  const viaMeta = await metaBot.call("crow_list_crosspost_transforms", {}, { kind: "bot", id: META_BOT });
  assert.equal(viaMeta.isError, false, viaMeta.text);

  const headerBot = await open({ baseActor: actor.OWNER });
  const viaHeader = await handlerCall(headerBot, headerExtra(HDR_BOT))("crow_list_crosspost_transforms", {});
  assert.equal(viaHeader.isError, false, viaHeader.text);

  // The operator's own voice bot is a bot here too: outside its two voice tools (b4), even the
  // read-only status tool is refused.
  const voiceBot = await open({ baseActor: scope.operatorVoiceActor() });
  const status = await voiceBot.call("crow_sharing_status", {});
  assert.equal(status.isError, true, status.text);
  assert.equal(status.text, OWNER_ONLY_TEXT);

  // A name the map does not class is refused for a bot, never allowed: the map fails closed.
  const { guardSharingServer } = await import("../servers/sharing/bot-owner-only.js");
  const handlers = new Map();
  const fake = { tool: (name, _description, _schema, handler) => handlers.set(name, handler) };
  guardSharingServer(fake, { baseActor: { kind: "bot", id: META_BOT } });
  let ran = false;
  fake.tool("crow_unclassed_tool", "no class in the map", {}, () => { ran = true; return { content: [] }; });
  const unclassed = await handlers.get("crow_unclassed_tool")({}, undefined);
  assert.equal(ran, false, "an unclassed tool's handler never runs for a bot");
  assert.equal(unclassed.isError, true);
  assert.equal(unclassed.content[0].text, OWNER_ONLY_TEXT);
});

// --- (d) the owner and an unidentified caller still reach the server ------------------------

test("the owner and an unknown actor still reach the status and contact tools", async () => {
  for (const [label, base] of [["owner", actor.OWNER], ["unknown", actor.UNKNOWN]]) {
    const e = await open({ baseActor: base });
    const status = await e.call("crow_sharing_status", {});
    assert.equal(status.isError, false, `${label} status: ${status.text}`);
    assert.match(status.text, /Crow Sharing Status/, label);

    const contacts = await e.call("crow_list_contacts", {});
    assert.equal(contacts.isError, false, `${label} contacts: ${contacts.text}`);
    assert.match(contacts.text, new RegExp(CONTACT_CROW_ID), `${label} sees the contact`);
  }

  // And a per-call claim can only ever narrow: an owner mount handed a bot's _meta is refused.
  const e = await open({ baseActor: actor.OWNER });
  const refused = await e.call("crow_list_contacts", {}, { kind: "bot", id: META_BOT });
  assert.equal(refused.isError, true, refused.text);
  assert.equal(refused.text, OWNER_ONLY_TEXT);
});

// --- (e) a bot holding a project share is refused the same ---------------------------------

test("a bot that holds a live project share is refused the sharing tools too", async () => {
  const home = Number((await createProjectSpace(db, { name: "Sharing bot home" })).id);
  const project = Number((await createProjectSpace(db, { name: "Sharing share project" })).id);
  const botId = "sharing-shared-bot";
  await db.execute({
    sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, project_id, enabled) VALUES (?,?,?,?,1)",
    args: [botId, "Shared Bot", "{}", home],
  });
  await grantShare(db, { projectId: project, botId, level: "read_write" });

  const e = await openUnderEnv({ CROW_ACTOR_KIND: "bot", CROW_ACTOR_BOT_ID: botId });
  await expectOwnerOnly(e.call, "bot with a project share", "crow_share", shareArgs("not-a-real-token"), "This will share");
  await expectOwnerOnly(e.call, "bot with a project share", "crow_send_message", sendArgs());
  await expectOwnerOnly(e.call, "bot with a project share", "crow_list_contacts", {});

  // The share is real: the same bot is allowed the project tools a share covers, so the refusal
  // above is the sharing surface's own rule, not a bot that cannot do anything.
  const gate = scope.makeShareGate(db, "crow_search_memories", { baseActor: { kind: "bot", id: botId } });
  assert.deepEqual(await gate.check(project), { projectId: project });
});