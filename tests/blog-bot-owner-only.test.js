/**
 * The blog server's tools are OWNER-ONLY for bots, on every path — with one harmless exception.
 *
 * The decision: a bot never publishes, edits, deletes, shares or configures the operator's blog, and
 * never reads back the drafts, settings or songbook rows — including the operator's own voice bot
 * when that bot is anything but the frozen executor actor (a relayed turn can put words in its
 * mouth). The frozen operator-voice actor keeps every tool, exactly as today. Exactly one tool is
 * harmless for every bot: the chord diagram, a pure function of a chord name.
 *
 * What this file drives, all against a real `createBlogServer` on a scratch crow.db:
 *
 *   (a) the classification has no drift: the map and the server's registered tools are the same set;
 *   (b) a bot is refused every owner_only tool and the handler never runs — the seeded draft is
 *       still a draft, no post/setting/setlist/share row changed, and the read tools hand back no
 *       post data (token-less, forged-token and plain calls alike), on each path a bot can take:
 *       the constructed base actor, a per-call `_meta` actor (including one claiming the reserved
 *       voice id and the operator-voice flag), and a stdio env actor built under the engine marker;
 *   (c) the one harmless tool still works for a bot;
 *   (d) the frozen operator-voice actor really publishes (create → publish token round-trip), and
 *       the owner and an unidentified caller are unchanged (create + publish);
 *   (e) a registration the guard cannot see the call's actor through is refused at registration.
 *
 * No network: nothing here opens a peer connection. Scratch CROW_HOME/data dir, a real crow.db from
 * scripts/init-db.js; nothing here touches ~/.crow.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "blog-bot-owner-only-"));
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
// The publishing/delete confirmation gate is part of the proof below: it must not be skipped.
delete process.env.CROW_SKIP_CONFIRM_GATES;

const REPO = join(import.meta.dirname, "..");
const DB_FILE = join(DATA, "crow.db");

const BOT = "blog-gate-bot";
const META_BOT = "blog-meta-bot";
const CONTACT_CROW_ID = "crowblogcontact001";
const OWNER_ONLY_TEXT = "Error: That tool is for the operator only.";
const DRAFT_TITLE = "A heron draft the bot must not touch";

let db = null;
let createBlogServer = null;
let Client = null;
let InMemoryTransport = null;
let actor = null;
let scope = null;
let BLOG_TOOL_CLASS = null;
let DRAFT_ID = null;
const openServers = []; // every { client, server } this file built, closed in after()

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env }, stdio: "pipe", cwd: REPO });
  const { createDbClient } = await import("../servers/db.js");
  db = createDbClient(DB_FILE);
  ({ createBlogServer } = await import("../servers/blog/server.js"));
  ({ Client } = await import("@modelcontextprotocol/sdk/client/index.js"));
  ({ InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js"));
  actor = await import("../servers/research/actor.js");
  scope = await import("../servers/shared/project-share-scope.js");
  ({ BLOG_TOOL_CLASS } = await import("../servers/blog/bot-owner-only.js"));

  // The contact crow_share_post would write a row against, if its handler ran.
  await db.execute({
    sql: `INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey, origin)
          VALUES (?, 'Blog Contact', ?, ?, 'remote')`,
    args: [CONTACT_CROW_ID, "a".repeat(64), "b".repeat(66)],
  });

  // The draft every bot path below is pointed at: a real row the read tools would reveal and the
  // write tools would change.
  const seeded = await db.execute({
    sql: `INSERT INTO blog_posts (slug, title, content, excerpt, status, visibility)
          VALUES ('heron-draft', ?, 'The heron stands in the shallows.', 'A draft.', 'draft', 'private')`,
    args: [DRAFT_TITLE],
  });
  DRAFT_ID = Number(seeded.lastInsertRowid);
});

after(async () => {
  for (const entry of openServers) await entry.close();
  try { db && db.close && db.close(); } catch { /* already closed */ }
  rmSync(dir, { recursive: true, force: true });
});

// --- harness --------------------------------------------------------------------------------

const textOf = (r) => (r.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");

/** A blog server wired to an in-process client. */
async function open(options = {}) {
  return mount(createBlogServer(DB_FILE, options));
}

/** Any McpServer wired to an in-process client (the guard fixture is mounted the same way). */
async function mount(server) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport)]);
  const client = new Client({ name: "blog-bot-owner-only", version: "0" });
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
  openServers.push(entry);
  return entry;
}

/**
 * A server built under a given actor env. The env is laid over a cleared CROW_ACTOR_* set only
 * while the server is CONSTRUCTED (the base actor is fixed then) and restored before any call.
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

const rows = async (sql, args = []) => (await db.execute({ sql, args })).rows;
const count = async (sql, args = []) => Number((await rows(sql, args))[0].n);

/** Every table a blog handler would leave a mark in. */
async function snapshot() {
  return {
    posts: await rows("SELECT id, slug, title, content, excerpt, status, visibility, published_at FROM blog_posts ORDER BY id"),
    settings: await rows("SELECT key, value FROM dashboard_settings WHERE key LIKE 'blog%' ORDER BY key"),
    shared: await rows("SELECT id, contact_id, share_type, item_id FROM shared_items ORDER BY id"),
    setlists: await rows("SELECT id, name, description, visibility FROM songbook_setlists ORDER BY id"),
    setlistItems: await rows("SELECT setlist_id, post_id, position FROM songbook_setlist_items ORDER BY setlist_id, position"),
  };
}

/**
 * A tool call the guard must refuse, proven not to have run its handler: the fixed refusal text, the
 * table snapshot identical, and (when given) a sentinel string the handler would have produced.
 */
async function expectOwnerOnly(call, label, tool, args, sentinel) {
  const before = await snapshot();
  const r = await call(tool, args);
  assert.equal(r.isError, true, `${label} ${tool}: ${r.text}`);
  assert.equal(r.text, OWNER_ONLY_TEXT, `${label} ${tool}: the fixed owner-only refusal`);
  assert.deepEqual(await snapshot(), before, `${label} ${tool}: no row written`);
  assert.ok(!r.text.includes(DRAFT_TITLE), `${label} ${tool}: no post data`);
  assert.ok(sentinel === undefined || !r.text.includes(sentinel), `${label} ${tool}: never reaches the handler`);
}

/** One plausible call per owner-only tool, against the seeded draft. */
const BOT_CALLS = (postId) => [
  ["crow_create_post", { title: "A post a bot wrote", content: "body" }, "Created draft:"],
  ["crow_edit_post", { id: postId, title: "A bot edit" }, "Updated post"],
  ["crow_publish_post", { id: postId, confirm_token: "" }, "This will publish"],
  ["crow_publish_post", { id: postId, confirm_token: "forged-token" }, "Invalid or expired"],
  ["crow_unpublish_post", { id: postId }, "reverted to draft"],
  ["crow_list_posts", {}, "post(s):"],
  ["crow_get_post", { id: postId }, "Status:"],
  ["crow_delete_post", { id: postId, confirm_token: "" }, "This will permanently delete"],
  ["crow_delete_post", { id: postId, confirm_token: "forged-token" }, "Invalid or expired"],
  ["crow_share_post", { id: postId, contact: CONTACT_CROW_ID }, "Delivery: pending"],
  ["crow_export_blog", {}, "Exported"],
  ["crow_blog_settings", { action: "get" }, "Blog Settings:"],
  ["crow_blog_settings", { action: "set", title: "A bot title" }, "Updated"],
  ["crow_blog_customize_theme", { css: "body{display:none}" }, "Custom CSS saved"],
  ["crow_blog_stats", {}, "Blog Statistics:"],
  ["crow_create_song", { title: "A bot song", content: "Am G" }, "Created"],
  ["crow_transpose_song", { id: postId, target_key: "C" }, "Transposed"],
  ["crow_list_songs", {}, "song(s)"],
  ["crow_create_setlist", { name: "A bot setlist" }, "Created"],
  ["crow_add_to_setlist", { setlist_id: 1, post_id: postId }, "Added"],
  ["crow_remove_from_setlist", { setlist_id: 1, post_id: postId }, "Removed"],
  ["crow_update_setlist", { id: 1, name: "A bot name" }, "Updated"],
  ["crow_list_setlists", {}, "setlist"],
  ["crow_get_setlist", { id: 1 }, "# "],
  ["crow_delete_setlist", { id: 1, confirm_token: "" }, "This will permanently delete"],
];

// --- (a) the classification has no drift ----------------------------------------------------

test("every registered blog tool is classed, and every class entry is registered", async () => {
  const entry = await open({ baseActor: actor.OWNER });
  const registered = Object.keys(entry.server._registeredTools);
  const classed = Object.keys(BLOG_TOOL_CLASS).sort();

  assert.deepEqual(registered.slice().sort(), classed, "the map and the tool surface are the same set");
  assert.equal(registered.length, 23, "the blog surface has 23 tools");
  assert.equal(classed.length, 23, "the classification has 23 entries");
  // The guard must not have moved a registration: both ends of the order still hold.
  assert.equal(registered[0], "crow_create_post");
  assert.equal(registered.at(-1), "crow_delete_setlist");
  for (const [name, cls] of Object.entries(BLOG_TOOL_CLASS)) {
    assert.ok(cls === "owner_only" || cls === "harmless", `${name}: ${cls}`);
  }
  const harmless = Object.entries(BLOG_TOOL_CLASS).filter(([, cls]) => cls === "harmless").map(([n]) => n);
  assert.deepEqual(harmless, ["crow_get_chord_diagram"], "exactly one harmless tool");
  assert.equal(Object.isFrozen(BLOG_TOOL_CLASS), true, "the map is frozen");
});

// --- (b) every bot path is refused, and the handler never runs ------------------------------

test("a bot is refused every owner-only blog tool on every path, and no handler runs", { timeout: 180_000 }, async () => {
  /** The paths, each built so the bot actor is the one that path really produces. */
  const paths = [];

  // 1. the constructed base actor (what the tool executor hands the in-process server).
  {
    const e = await open({ baseActor: { kind: "bot", id: BOT } });
    assert.deepEqual(e.server.blog.actor, { kind: "bot", id: BOT }, "the base actor is the bot");
    paths.push({ label: "bot base actor", call: e.call });
  }

  // 2. a per-call `crow/actor` in _meta, over an owner mount.
  {
    const e = await open({ baseActor: actor.OWNER });
    paths.push({ label: "_meta actor", call: (t, a) => e.call(t, a, { kind: "bot", id: META_BOT }) });
  }

  // 3. a per-call _meta actor claiming the reserved voice id, with the operator-voice flag: the id
  //    is not a credential and resolveCallActor copies kind and id alone, so it is a plain bot.
  {
    const e = await open({ baseActor: actor.OWNER });
    paths.push({
      label: "_meta crow.voice + operatorVoice",
      call: (t, a) => e.call(t, a, { kind: "bot", id: "crow.voice", operatorVoice: true }),
    });
  }

  // 4. the stdio env actor: the process env a bot's MCP child gets, with the engine's session marker.
  {
    const e = await openUnderEnv({ CROW_ACTOR_KIND: "bot", CROW_ACTOR_BOT_ID: BOT, CROW_BOT_SESSION: BOT });
    assert.deepEqual(e.server.blog.actor, { kind: "bot", id: BOT, botSession: true }, "the base actor is the env bot");
    assert.equal(scope.isOperatorVoice(e.server.blog.actor), false, "an env actor never carries the marker");
    paths.push({ label: "stdio env actor", call: e.call });
  }

  for (const path of paths) {
    for (const [tool, args, sentinel] of BOT_CALLS(DRAFT_ID)) {
      await expectOwnerOnly(path.call, path.label, tool, args, sentinel);
    }
  }

  // The seeded draft is untouched by every path above: still a draft, same title.
  const after = await rows("SELECT status, title FROM blog_posts WHERE id = ?", [DRAFT_ID]);
  assert.deepEqual(after.map((r) => ({ status: r.status, title: r.title })),
    [{ status: "draft", title: DRAFT_TITLE }], "the draft was never published, edited or deleted");
});

// --- (c) the one harmless tool still works for a bot ---------------------------------------

test("crow_get_chord_diagram is the one blog tool a bot still reaches", async () => {
  for (const [label, base, meta] of [
    ["bot base actor", { kind: "bot", id: BOT }, undefined],
    ["_meta actor", actor.OWNER, { kind: "bot", id: META_BOT }],
    ["voice id claimed by _meta", actor.OWNER, { kind: "bot", id: "crow.voice", operatorVoice: true }],
  ]) {
    const e = await open({ baseActor: base });
    const r = await e.call("crow_get_chord_diagram", { chord: "Am7" }, meta);
    assert.equal(r.isError, false, `${label}: ${r.text}`);
    assert.match(r.text, /<svg/, `${label}: the diagram is rendered`);
    assert.ok(!r.text.includes(DRAFT_TITLE), `${label}: no post data`);
  }

  // A name the map does not class is refused for a bot, never allowed: the map fails closed.
  const { guardBlogServer } = await import("../servers/blog/bot-owner-only.js");
  const handlers = new Map();
  const fake = { tool: (name, _description, _schema, handler) => handlers.set(name, handler) };
  guardBlogServer(fake, { baseActor: { kind: "bot", id: BOT } });
  let ran = false;
  fake.tool("crow_unclassed_tool", "no class in the map", {}, () => { ran = true; return { content: [] }; });
  const unclassed = await handlers.get("crow_unclassed_tool")({}, undefined);
  assert.equal(ran, false, "an unclassed tool's handler never runs for a bot");
  assert.equal(unclassed.isError, true);
  assert.equal(unclassed.content[0].text, OWNER_ONLY_TEXT);
});

// --- (d) the operator's own paths are unchanged --------------------------------------------

/** Create a post and publish it through the given call, with the real confirm-token round-trip. */
async function createAndPublish(call, title) {
  const created = await call("crow_create_post", { title, content: "Published by the operator." });
  assert.equal(created.isError, false, created.text);
  const id = Number(/ID: (\d+)/.exec(created.text)?.[1]);
  assert.ok(Number.isFinite(id), `the create response carries the id: ${created.text}`);

  const preview = await call("crow_publish_post", { id, confirm_token: "" });
  assert.equal(preview.isError, false, preview.text);
  const token = /confirm_token: "([^"]+)"/.exec(preview.text)?.[1];
  assert.ok(token, `the preview carries a confirm token: ${preview.text}`);

  const published = await call("crow_publish_post", { id, confirm_token: token });
  assert.equal(published.isError, false, published.text);
  assert.match(published.text, /^Published!/, published.text);

  const row = (await rows("SELECT status, published_at FROM blog_posts WHERE id = ?", [id]))[0];
  assert.equal(row.status, "published", "the post really is published");
  assert.ok(row.published_at, "and the timestamp is recorded");
  return id;
}

test("the frozen operator-voice actor publishes for real (create → publish token round-trip)", { timeout: 120_000 }, async () => {
  const frozen = scope.operatorVoiceActor();
  const e = await open({ baseActor: frozen });
  assert.equal(e.server.blog.actor, frozen, "the frozen operator-voice actor is the base");
  assert.equal(scope.isOperatorVoice(e.server.blog.actor), true);

  await createAndPublish(e.call, "The operator's own spoken turn");

  // The guard's exception is about the ACTOR: a bot base actor is refused the same tools the
  // operator-voice one reaches.
  const botE = await open({ baseActor: { kind: "bot", id: BOT } });
  assert.equal((await botE.call("crow_list_posts", {})).text, OWNER_ONLY_TEXT);

  // An un-frozen copy carrying the flag is not the frozen actor, so it is refused.
  const copy = await open({ baseActor: { kind: "bot", id: "crow.voice", operatorVoice: true } });
  assert.equal(scope.isOperatorVoice(copy.server.blog.actor), false, "a copy is not the frozen actor");
  assert.equal((await copy.call("crow_list_posts", {})).text, OWNER_ONLY_TEXT);
});

test("the owner and an unidentified caller create and publish as before", { timeout: 120_000 }, async () => {
  for (const [label, base] of [["owner", actor.OWNER], ["unknown", actor.UNKNOWN]]) {
    const e = await open({ baseActor: base });
    assert.equal(e.server.blog.actor, base, `${label}: the base actor is the mount's`);
    const id = await createAndPublish(e.call, `A post from the ${label}`);

    // And the read tools answer with the real row.
    const listed = await e.call("crow_list_posts", { status: "published" });
    assert.equal(listed.isError, false, `${label} list: ${listed.text}`);
    assert.ok(listed.text.includes(`A post from the ${label}`), `${label} sees its own post`);
    const got = await e.call("crow_get_post", { id });
    assert.equal(got.isError, false, `${label} get: ${got.text}`);
    assert.match(got.text, /Status: published/, label);
  }
});

// --- (e) a registration the guard could not guard is refused at registration ---------------

test("the blog guard refuses to register a tool it could not see the call's actor through", async () => {
  const { guardBlogServer } = await import("../servers/blog/bot-owner-only.js");
  const registered = [];
  const fake = {
    tool: (name, ...rest) => registered.push([name, ...rest]),
    registerTool: () => { throw new Error("the guard must replace registerTool"); },
  };
  guardBlogServer(fake, { baseActor: actor.OWNER });

  // The guard reads the call's `extra` from the handler's second argument. A registration with no
  // schema (or annotations) object between the name and the handler calls that handler with
  // `extra` alone, which the guard cannot tell from the call's `args` — so it refuses the
  // registration instead of installing a handler it cannot guard.
  assert.throws(() => fake.tool("crow_no_schema", "a description", () => ({ content: [] })),
    /blog guard[\s\S]*schema/, "tool(name, description, handler) is refused");
  assert.throws(() => fake.tool("crow_bare", () => ({ content: [] })),
    /blog guard[\s\S]*schema/, "tool(name, handler) is refused");
  assert.throws(() => fake.tool("crow_no_handler"),
    /blog guard/, "a registration with no callback at all is refused");
  assert.deepEqual(registered, [], "nothing was registered behind the guard's back");

  // registerTool() takes a config object and a callback: the tool() wrapper never sees it, so a
  // tool registered that way would reach its handler unguarded. It throws instead.
  assert.throws(() => fake.registerTool("crow_via_register_tool", { description: "x" }, () => ({ content: [] })),
    /blog guard[\s\S]*registerTool/, "registerTool() is refused on a guarded server");
  assert.deepEqual(registered, [], "still nothing registered");

  // A well-shaped registration is still installed, and is still the guard: a bot is refused and the
  // handler does not run.
  let ran = false;
  const botGuard = guardBlogServer(
    { tool: (name, ...rest) => registered.push([name, ...rest]), registerTool: () => {} },
    { baseActor: { kind: "bot", id: BOT } },
  );
  assert.ok(botGuard, "guardBlogServer returns the server it guarded");
  botGuard.tool("crow_publish_post", "publish something", {}, () => { ran = true; return { content: [] }; });
  assert.equal(registered.length, 1, "a well-shaped registration goes through");
  const botRefused = await registered.at(-1).at(-1)({}, undefined);
  assert.equal(ran, false, "a bot never reaches the guarded handler");
  assert.equal(botRefused.isError, true);
  assert.equal(botRefused.content[0].text, OWNER_ONLY_TEXT);

  // The onCallActor seam sees every resolution (the guard's decision is otherwise only visible
  // through the refusal).
  const seen = [];
  const handlers = new Map();
  const seamServer = { tool: (name, _d, _s, h) => handlers.set(name, h) };
  guardBlogServer(seamServer, { baseActor: actor.UNKNOWN, onCallActor: (a, tool) => seen.push({ actor: a, tool }) });
  seamServer.tool("crow_blog_stats", "stats", {}, () => ({ content: [] }));
  await handlers.get("crow_blog_stats")({}, { _meta: { "crow/actor": { kind: "bot", id: BOT } } });
  assert.deepEqual(seen.at(-1), { actor: { kind: "bot", id: BOT }, tool: "crow_blog_stats" });
});