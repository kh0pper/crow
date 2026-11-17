/**
 * The blog server's tools are OWNER-ONLY for bots, except the four post tools a bot may use on
 * DRAFTS, and one harmless exception.
 *
 * The decision: a bot may create a draft post, edit a draft, list drafts and read a draft — and
 * nothing else. It never publishes, unpublishes, deletes, shares or configures the operator's blog,
 * never touches the songbook, and never sees a live post, the settings or the songbook rows —
 * including the operator's own voice bot when that bot is anything but the frozen executor actor (a
 * relayed turn can put words in its mouth). The frozen operator-voice actor keeps every tool,
 * exactly as today. Exactly one tool is harmless for every bot: the chord diagram, a pure function
 * of a chord name.
 *
 * The accepted trade-off of the draft allowance is in the guard's own header and is asserted here
 * only as behaviour: `blog_posts` has no author column, so a bot's drafts are every draft on the
 * instance, the operator's own included.
 *
 * What this file drives, all against a real `createBlogServer` on a scratch crow.db:
 *
 *   (a) the classification has no drift: the map and the server's registered tools are the same set,
 *       and exactly the four post tools are classed bot_draft;
 *   (b) a bot is refused every owner_only tool and the handler never runs — the seeded draft is
 *       still a draft, no post/setting/setlist/share row changed, and the read tools hand back no
 *       post data (token-less, forged-token and plain calls alike), on each path a bot can take:
 *       the constructed base actor, a per-call `_meta` actor (including one claiming the reserved
 *       voice id and the operator-voice flag), a bot claim over an unknown base, and a stdio env
 *       actor built under the engine marker;
 *   (b2) on every one of those paths a bot reaches create/edit/list/get and is held to drafts: its
 *       new post is a draft whatever visibility it asked for, it can edit that draft, a published
 *       post (public or private) is refused with the one fixed draft text and left byte-identical,
 *       a missing id reads exactly the same, listings are drafts only on the plain, tag and FTS
 *       paths, and a live post reads exactly like a missing one;
 *   (c) the one harmless tool still works for a bot;
 *   (d) the frozen operator-voice actor, the owner and an unidentified caller are unchanged: create
 *       → publish token round-trip, an edit of a PUBLISHED post, every post listed and read — and
 *       the three callers' read output is byte-identical, while a bot's read of the same rows is
 *       drafts only;
 *   (e) the gateway's router path: an `x-crow-actor-kind` header marking a bot gives it drafts only
 *       (create a draft, list drafts) and refuses a publish, with or without an id, and a header
 *       claiming the owner is ignored either way;
 *   (f) a registration the guard cannot see the call's actor through is refused at registration.
 * *
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
const DRAFT_ONLY_EDIT_TEXT = "Error: A bot can only edit draft posts.";
const NOT_FOUND_TEXT = "Post not found. Use crow_list_posts to see available posts.";
const DRAFT_TITLE = "A heron draft the bot must not touch";
const LIVE_TITLE = "A gull the bot must never see";
const PRIVATE_LIVE_TITLE = "A tern posted to nobody in particular";
const TAGGED_DRAFT_TITLE = "A kestrel draft with a shared tag";
const TAGGED_DRAFT_CONTENT = "The kestrel hovers over the sharedtag field.";
const SHARED_TAG = "sharedtag";
const SEARCH_WORD = "kestrel";

let db = null;
let createBlogServer = null;
let Client = null;
let InMemoryTransport = null;
let actor = null;
let scope = null;
let BLOG_TOOL_CLASS = null;
let DRAFT_ID = null;
let LIVE_ID = null;
let PRIVATE_LIVE_ID = null;
let TAGGED_DRAFT_ID = null;
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

  // The draft every bot path below is pointed at: a real row the owner-only tools could reveal or
  // change, and the one the draft tools must refuse to publish.
  const seeded = await db.execute({
    sql: `INSERT INTO blog_posts (slug, title, content, excerpt, status, visibility)
          VALUES ('heron-draft', ?, 'The heron stands in the shallows.', 'A draft.', 'draft', 'private')`,
    args: [DRAFT_TITLE],
  });
  DRAFT_ID = Number(seeded.lastInsertRowid);

  // A PUBLISHED post (public) and a PUBLISHED one that is private: a bot must not see, edit or be
  // told about either, while an owner/unknown/operator-voice caller is unchanged for both.
  const live = await db.execute({
    sql: `INSERT INTO blog_posts (slug, title, content, excerpt, status, visibility, tags, published_at)
          VALUES ('gull-live', ?, 'The gull patrols the kestrel line.', 'Live.', 'published', 'public', ?, datetime('now'))`,
    args: [LIVE_TITLE, SHARED_TAG],
  });
  LIVE_ID = Number(live.lastInsertRowid);
  const privateLive = await db.execute({
    sql: `INSERT INTO blog_posts (slug, title, content, excerpt, status, visibility, tags, published_at)
          VALUES ('tern-live-private', ?, 'The tern also hunts the kestrel line.', 'Live and private.', 'published', 'private', ?, datetime('now'))`,
    args: [PRIVATE_LIVE_TITLE, SHARED_TAG],
  });
  PRIVATE_LIVE_ID = Number(privateLive.lastInsertRowid);

  // A DRAFT with the same tag and the same searchable word, so the tag and FTS paths below prove the
  // status filter rather than an empty result.
  const taggedDraft = await db.execute({
    sql: `INSERT INTO blog_posts (slug, title, content, excerpt, status, visibility, tags)
          VALUES ('kestrel-draft', ?, ?, 'A tagged draft.', 'draft', 'private', ?)`,
    args: [TAGGED_DRAFT_TITLE, TAGGED_DRAFT_CONTENT, SHARED_TAG],
  });
  TAGGED_DRAFT_ID = Number(taggedDraft.lastInsertRowid);
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

/** One plausible call per owner-only tool, against the seeded draft. The four bot_draft tools are
 *  NOT here: they are driven in (b2), where a bot reaches them and is held to drafts. */
const BOT_CALLS = (postId) => [
  ["crow_publish_post", { id: postId, confirm_token: "" }, "This will publish"],
  ["crow_publish_post", { id: postId, confirm_token: "forged-token" }, "Invalid or expired"],
  ["crow_unpublish_post", { id: postId }, "reverted to draft"],
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

/**
 * The five paths a bot really reaches this server by, each built so the resolved actor is the one
 * that path produces. Used by (b), (b2) and (b3) so every rule below is proven on every path.
 */
async function botPaths() {
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

  // 3. a per-call bot CLAIM with no usable id over an unknown base: it resolves to "unknown", the
  //    actor an unmarked local client gets, so the draft rule has to come from the claim.
  {
    const e = await open({ baseActor: actor.UNKNOWN });
    paths.push({ label: "_meta bot claim on an unknown base", call: (t, a) => e.call(t, a, { kind: "bot" }) });
  }

  // 4. a per-call _meta actor claiming the reserved voice id, with the operator-voice flag: the id is
  //    not a credential and resolveCallActor copies kind and id alone, so it is a plain bot.
  {
    const e = await open({ baseActor: actor.OWNER });
    paths.push({
      label: "_meta crow.voice + operatorVoice",
      call: (t, a) => e.call(t, a, { kind: "bot", id: "crow.voice", operatorVoice: true }),
    });
  }

  // 5. the stdio env actor: the process env a bot's MCP child gets, with the engine's session marker.
  {
    const e = await openUnderEnv({ CROW_ACTOR_KIND: "bot", CROW_ACTOR_BOT_ID: BOT, CROW_BOT_SESSION: BOT });
    assert.deepEqual(e.server.blog.actor, { kind: "bot", id: BOT, botSession: true }, "the base actor is the env bot");
    assert.equal(scope.isOperatorVoice(e.server.blog.actor), false, "an env actor never carries the marker");
    paths.push({ label: "stdio env actor (pi bot session)", call: e.call });
  }

  return paths;
}

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
    assert.ok(cls === "owner_only" || cls === "bot_draft" || cls === "harmless", `${name}: ${cls}`);
  }

  // Exactly the four post tools a bot needs to write a draft are bot_draft — no more.
  const botDraft = Object.entries(BLOG_TOOL_CLASS).filter(([, cls]) => cls === "bot_draft").map(([n]) => n).sort();
  assert.deepEqual(botDraft,
    ["crow_create_post", "crow_edit_post", "crow_get_post", "crow_list_posts"],
    "exactly the four draft tools are bot_draft");

  const harmless = Object.entries(BLOG_TOOL_CLASS).filter(([, cls]) => cls === "harmless").map(([n]) => n);
  assert.deepEqual(harmless, ["crow_get_chord_diagram"], "exactly one harmless tool");

  // Everything else — publish, unpublish, delete, share, export, settings, theme, stats and the whole
  // songbook — is owner_only.
  const ownerOnly = Object.entries(BLOG_TOOL_CLASS).filter(([, cls]) => cls === "owner_only").map(([n]) => n);
  assert.equal(ownerOnly.length, 18, "18 owner-only tools");
  for (const name of [
    "crow_publish_post", "crow_unpublish_post", "crow_delete_post", "crow_share_post",
    "crow_export_blog", "crow_blog_settings", "crow_blog_customize_theme", "crow_blog_stats",
    "crow_create_song", "crow_transpose_song", "crow_list_songs", "crow_create_setlist",
    "crow_add_to_setlist", "crow_remove_from_setlist", "crow_update_setlist", "crow_list_setlists",
    "crow_get_setlist", "crow_delete_setlist",
  ]) {
    assert.equal(BLOG_TOOL_CLASS[name], "owner_only", `${name}: still owner_only`);
  }
  assert.equal(Object.isFrozen(BLOG_TOOL_CLASS), true, "the map is frozen");
});

// --- (b) every bot path is refused, and the handler never runs ------------------------------

test("a bot is refused every owner-only blog tool on every path, and no handler runs", { timeout: 180_000 }, async () => {
  for (const path of await botPaths()) {
    for (const [tool, args, sentinel] of BOT_CALLS(DRAFT_ID)) {
      await expectOwnerOnly(path.call, path.label, tool, args, sentinel);
    }
  }

  // The seeded draft is untouched by every path above: still a draft, same title.
  const after = await rows("SELECT status, title FROM blog_posts WHERE id = ?", [DRAFT_ID]);
  assert.deepEqual(after.map((r) => ({ status: r.status, title: r.title })),
    [{ status: "draft", title: DRAFT_TITLE }], "the draft was never published, edited or deleted");

  // Nor was the published post touched, and no published post reached a bot's read.
  const live = await rows("SELECT title, status, content FROM blog_posts WHERE id = ?", [LIVE_ID]);
  assert.deepEqual(live.map((r) => ({ title: r.title, status: r.status })),
    [{ title: LIVE_TITLE, status: "published" }], "the published post is untouched");
});

// --- (b2) a bot reaches the four draft tools, and only ever on drafts -----------------------

/**
 * Drive the four draft tools as a bot on one path: create a draft, edit it, and be refused every
 * post that is not a draft — with the one fixed refusal, changing nothing.
 */
async function expectDraftTools(call, label) {
  // create → a real row that is a draft, even though the call asked for public visibility (which is
  // recorded, and only means anything at publish time — and a bot cannot publish).
  const title = `A bot draft (${label}) ${Date.now().toString(36)}`;
  const created = await call("crow_create_post", { title, content: "First words.", visibility: "public" });
  assert.equal(created.isError, false, `${label} create: ${created.text}`);
  assert.match(created.text, /^Created draft: /, `${label} create: the same response an owner gets`);
  const id = Number(/ID: (\d+)/.exec(created.text)?.[1]);
  assert.ok(Number.isFinite(id), `${label} create: the response carries the id: ${created.text}`);

  const row = async () => (await rows("SELECT title, content, status, visibility, published_at FROM blog_posts WHERE id = ?", [id]))[0];
  assert.equal((await row()).status, "draft", `${label}: a bot's post is a draft whatever visibility it asked for`);
  assert.equal((await row()).visibility, "public", `${label}: the visibility it asked for is recorded`);

  // edit that draft → it changes, and stays a draft (there is no status field to send, either).
  const edited = await call("crow_edit_post", { id, content: "Second words, still a draft." });
  assert.equal(edited.isError, false, `${label} edit draft: ${edited.text}`);
  assert.match(edited.text, /^Updated post \d+: content\.$/, `${label} edit draft: the usual response`);
  assert.equal((await row()).content, "Second words, still a draft.", `${label}: the draft really changed`);
  assert.equal((await row()).status, "draft", `${label}: an edit never changes the status`);

  // There is no status field on crow_edit_post, and an argument the schema does not declare is
  // dropped before the handler — so "publish it with an edit" is not a path either.
  const sneaky = await call("crow_edit_post", { id, status: "published" });
  assert.equal((await row()).status, "draft", `${label}: a status argument changes nothing: ${sneaky.text}`);
  assert.equal((await row()).content, "Second words, still a draft.", `${label}: and nothing else changed`);

  // edit a PUBLISHED post → the one draft refusal, and the row byte-identical.
  const liveBefore = await rows("SELECT * FROM blog_posts WHERE id = ?", [LIVE_ID]);
  const refusedLive = await call("crow_edit_post", { id: LIVE_ID, title: "A bot rewrote a live post" });
  assert.equal(refusedLive.isError, true, `${label} edit live: ${refusedLive.text}`);
  assert.equal(refusedLive.text, DRAFT_ONLY_EDIT_TEXT, `${label} edit live: the fixed draft refusal`);
  assert.deepEqual(await rows("SELECT * FROM blog_posts WHERE id = ?", [LIVE_ID]), liveBefore,
    `${label} edit live: nothing changed`);

  // edit a PUBLISHED-private post → the very same refusal (the rule is about status, not reach).
  const privateBefore = await rows("SELECT * FROM blog_posts WHERE id = ?", [PRIVATE_LIVE_ID]);
  const refusedPrivate = await call("crow_edit_post", { id: PRIVATE_LIVE_ID, content: "A bot's words." });
  assert.equal(refusedPrivate.text, DRAFT_ONLY_EDIT_TEXT, `${label} edit published-private: the same refusal`);
  assert.deepEqual(await rows("SELECT * FROM blog_posts WHERE id = ?", [PRIVATE_LIVE_ID]), privateBefore,
    `${label} edit published-private: nothing changed`);

  // edit a MISSING id → the identical refusal: a live post and a missing one must read the same.
  const refusedMissing = await call("crow_edit_post", { id: 999999, content: "A bot's words." });
  assert.equal(refusedMissing.isError, true, `${label} edit missing: ${refusedMissing.text}`);
  assert.equal(refusedMissing.text, DRAFT_ONLY_EDIT_TEXT, `${label} edit missing: the same refusal again`);
  assert.equal(await count("SELECT COUNT(*) AS n FROM blog_posts WHERE id = 999999"), 0,
    `${label} edit missing: and of course nothing was created`);
}

test("a bot creates and edits drafts, and only drafts, on every bot path", { timeout: 180_000 }, async () => {
  for (const path of await botPaths()) await expectDraftTools(path.call, path.label);
});

// --- (b3) a bot lists and reads drafts only -------------------------------------------------

async function expectDraftReads(call, label) {
  // list: drafts and nothing else, on the plain path …
  const all = await call("crow_list_posts", {});
  assert.equal(all.isError, false, `${label} list: ${all.text}`);
  assert.ok(all.text.includes(TAGGED_DRAFT_TITLE), `${label} list: a draft is listed`);
  assert.ok(!all.text.includes(LIVE_TITLE), `${label} list: a published post is not`);
  assert.ok(!all.text.includes(PRIVATE_LIVE_TITLE), `${label} list: nor a published-private one`);
  const listedRows = all.text.split("\n").filter((l) => l.startsWith("- #"));
  assert.ok(listedRows.length > 0, `${label} list: something was listed`);
  for (const line of listedRows) assert.match(line, /\[draft\]/, `${label} list: every row is a draft: ${line}`);

  // … with the status argument forced to draft, whatever the call asks for …
  const askedPublished = await call("crow_list_posts", { status: "published" });
  assert.equal(askedPublished.text, all.text, `${label} list status=published: no wider than the plain listing`);
  const askedArchived = await call("crow_list_posts", { status: "archived" });
  assert.equal(askedArchived.text, all.text, `${label} list status=archived: the same drafts`);

  // … on the tag path …
  const byTag = await call("crow_list_posts", { tag: SHARED_TAG });
  assert.equal(byTag.isError, false, `${label} list tag: ${byTag.text}`);
  assert.ok(byTag.text.includes(TAGGED_DRAFT_TITLE), `${label} list tag: the tagged draft is listed`);
  assert.ok(!byTag.text.includes(LIVE_TITLE), `${label} list tag: the tagged PUBLISHED post is not`);
  assert.ok(!byTag.text.includes(PRIVATE_LIVE_TITLE), `${label} list tag: nor the tagged published-private one`);

  // … and on the FTS join path.
  const bySearch = await call("crow_list_posts", { search: SEARCH_WORD });
  assert.equal(bySearch.isError, false, `${label} list search: ${bySearch.text}`);
  assert.ok(bySearch.text.includes(TAGGED_DRAFT_TITLE), `${label} list search: the draft matches`);
  assert.ok(!bySearch.text.includes(LIVE_TITLE), `${label} list search: the matching PUBLISHED post does not`);
  assert.ok(!bySearch.text.includes(PRIVATE_LIVE_TITLE), `${label} list search: nor the matching published-private one`);

  // get: a draft answers with its content …
  const draft = await call("crow_get_post", { id: TAGGED_DRAFT_ID });
  assert.equal(draft.isError, false, `${label} get draft: ${draft.text}`);
  assert.ok(draft.text.includes(TAGGED_DRAFT_CONTENT), `${label} get draft: the body is returned`);
  assert.match(draft.text, /Status: draft/, label);

  // … while a published post, a published-private one, and an id that does not exist are the same
  // one "not found" (by id and by slug), so nothing reveals that a live post exists.
  const missing = await call("crow_get_post", { id: 999999 });
  assert.equal(missing.isError, true, `${label} get missing: ${missing.text}`);
  assert.equal(missing.text, NOT_FOUND_TEXT, `${label} get missing: the ordinary not-found text`);
  for (const [what, args] of [
    ["live by id", { id: LIVE_ID }],
    ["live by slug", { slug: "gull-live" }],
    ["published-private by id", { id: PRIVATE_LIVE_ID }],
  ]) {
    const hidden = await call("crow_get_post", args);
    assert.equal(hidden.isError, true, `${label} get ${what}: ${hidden.text}`);
    assert.equal(hidden.text, missing.text, `${label} get ${what}: identical to a missing post`);
  }
}

test("a bot lists and reads drafts only, on every bot path", { timeout: 180_000 }, async () => {
  for (const path of await botPaths()) await expectDraftReads(path.call, path.label);
});

// --- (c) the one harmless tool still works for a bot ---------------------------------------

test("crow_get_chord_diagram is the one harmless blog tool a bot reaches", async () => {
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
  assert.equal((await rows("SELECT status FROM blog_posts WHERE id = ?", [id]))[0].status, "draft",
    "a new post starts as a draft");

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

/** The three callers whose behaviour must be byte-identical to before: neither is bound by the
 *  draft rule, and the operator's own spoken turn is the frozen operator-voice actor. */
const OPERATOR_CALLERS = () => [
  ["owner", actor.OWNER],
  ["unknown", actor.UNKNOWN],
  ["operator voice", scope.operatorVoiceActor()],
];

test("the operator-voice actor, the owner and an unidentified caller create, publish and edit live posts as before", { timeout: 120_000 }, async () => {
  for (const [label, base] of OPERATOR_CALLERS()) {
    const e = await open({ baseActor: base });
    assert.equal(e.server.blog.actor, base, `${label}: the base actor is the mount's`);
    if (label === "operator voice") assert.equal(scope.isOperatorVoice(e.server.blog.actor), true);

    // create → draft → publish, with the real token round-trip.
    const id = await createAndPublish(e.call, `A post from the ${label}`);

    // An edit of a PUBLISHED post still lands — the draft rule narrows a bot, not these callers.
    const liveEdit = await e.call("crow_edit_post", { id, title: `Edited live by the ${label}` });
    assert.equal(liveEdit.isError, false, `${label} edit live: ${liveEdit.text}`);
    const afterEdit = (await rows("SELECT title, status FROM blog_posts WHERE id = ?", [id]))[0];
    assert.equal(afterEdit.title, `Edited live by the ${label}`, `${label}: the live post really changed`);
    assert.equal(afterEdit.status, "published", `${label}: and an edit never changes the status`);
  }

  // The guard's exception is about the ACTOR, not the tool: a bot base actor is held to drafts on the
  // very tools the operator-voice actor reaches in full.
  const botE = await open({ baseActor: { kind: "bot", id: BOT } });
  const botList = await botE.call("crow_list_posts", { status: "published" });
  assert.equal(botList.isError, false, botList.text);
  assert.ok(!botList.text.includes(LIVE_TITLE), "the bot's listing carries no published post");
  assert.equal((await botE.call("crow_blog_stats", {})).text, OWNER_ONLY_TEXT, "and the owner-only tools are refused");

  // An un-frozen copy carrying the flag is not the frozen actor: it is an ordinary bot.
  const copy = await open({ baseActor: { kind: "bot", id: "crow.voice", operatorVoice: true } });
  assert.equal(scope.isOperatorVoice(copy.server.blog.actor), false, "a copy is not the frozen actor");
  assert.equal((await copy.call("crow_blog_stats", {})).text, OWNER_ONLY_TEXT, "so it is refused owner-only tools");
  assert.ok(!(await copy.call("crow_list_posts", {})).text.includes(LIVE_TITLE),
    "and its listing is drafts only, unlike the operator's own turn");
});

test("the read tools answer identically for the owner, an unidentified caller and the operator's own voice turn", async () => {
  // No writes in this test: the three callers read the same rows, so their answers must be equal —
  // that is what "unchanged" means here. Called in the order OPERATOR_CALLERS lists them.
  const outputs = [];
  for (const [label, base] of OPERATOR_CALLERS()) {
    const e = await open({ baseActor: base });
    const all = await e.call("crow_list_posts", {});
    const publishedOnly = await e.call("crow_list_posts", { status: "published" });
    const byTag = await e.call("crow_list_posts", { tag: SHARED_TAG });
    const bySearch = await e.call("crow_list_posts", { search: SEARCH_WORD });
    const draft = await e.call("crow_get_post", { id: TAGGED_DRAFT_ID });
    const live = await e.call("crow_get_post", { id: LIVE_ID });
    const privateLive = await e.call("crow_get_post", { id: PRIVATE_LIVE_ID });

    // The behaviour itself, first: every post listed, published included, drafts included.
    assert.equal(all.isError, false, `${label} list: ${all.text}`);
    assert.ok(all.text.includes(LIVE_TITLE), `${label} list: the published post is listed`);
    assert.ok(all.text.includes(PRIVATE_LIVE_TITLE), `${label} list: the published-private post too`);
    assert.ok(all.text.includes(TAGGED_DRAFT_TITLE), `${label} list: and the drafts`);
    assert.ok(publishedOnly.text.includes(LIVE_TITLE), `${label} list status=published: the status filter still filters`);
    assert.ok(!publishedOnly.text.includes(TAGGED_DRAFT_TITLE), `${label} list status=published: drafts excluded`);
    assert.ok(byTag.text.includes(LIVE_TITLE), `${label} list tag: a published post with the tag`);
    assert.ok(byTag.text.includes(TAGGED_DRAFT_TITLE), `${label} list tag: and a draft with it`);
    assert.ok(bySearch.text.includes(LIVE_TITLE), `${label} list search: a matching published post`);
    assert.ok(bySearch.text.includes(TAGGED_DRAFT_TITLE), `${label} list search: and a matching draft`);
    assert.equal(draft.isError, false, `${label} get draft: ${draft.text}`);
    assert.equal(live.isError, false, `${label} get published: ${live.text}`);
    assert.match(live.text, /Status: published/, label);
    assert.equal(privateLive.isError, false, `${label} get published-private: ${privateLive.text}`);

    outputs.push({
      label,
      all: all.text, publishedOnly: publishedOnly.text, byTag: byTag.text, bySearch: bySearch.text,
      draft: draft.text, live: live.text, privateLive: privateLive.text,
    });
  }

  // And then the byte-for-byte part: three callers, one answer each.
  const [first, ...rest] = outputs;
  for (const other of rest) {
    for (const key of ["all", "publishedOnly", "byTag", "bySearch", "draft", "live", "privateLive"]) {
      assert.equal(other[key], first[key], `${key}: ${other.label} reads exactly what ${first.label} reads`);
    }
  }
});

// --- (e) the gateway path: an actor header marking a bot gets drafts only ---------------------

/**
 * A router (`/router/mcp`, the gateway's consolidated endpoint) wired to an in-process client whose
 * transport carries request headers — InMemoryTransport carries none, so this is how an
 * `x-crow-actor-*` header from the gateway arrives at the router's handler. `crow_blog` then
 * dispatches to the router's OWN in-process blog server, the path the gateway really uses.
 */
async function openRouter(routerActor, headers) {
  const { createRouterServer } = await import("../servers/gateway/router.js");
  const server = createRouterServer({ actor: routerActor });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const inner = serverTransport.onmessage;
  serverTransport.onmessage = (m, extra) => inner(m, { ...(extra || {}), requestInfo: { headers } });
  const client = new Client({ name: "blog-router", version: "0" });
  await client.connect(clientTransport);
  const entry = {
    server,
    call: async (tool, args = {}) => {
      const r = await client.callTool({ name: "crow_blog", arguments: { action: tool, params: args } });
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

const BOT_HEADER = { "x-crow-actor-kind": "bot" };
const BOT_ID_HEADER = { "x-crow-actor-kind": "bot", "x-crow-actor-id": META_BOT };
const OWNER_HEADER = { "x-crow-actor-kind": "owner" };

/** A bot-marked caller through the router: it gets a DRAFT, and nothing wider. */
async function expectRouterDraftOnly(call, label, title) {
  const created = await call("crow_create_post", { title, content: "words", visibility: "public" });
  assert.equal(created.isError, false, `${label} create: ${created.text}`);
  assert.match(created.text, /^Created draft/, label);
  const id = Number(/ID: (\d+)/.exec(created.text)?.[1]);
  assert.ok(Number.isFinite(id), `${label} create: the id travels back: ${created.text}`);
  assert.equal((await rows("SELECT status FROM blog_posts WHERE id = ?", [id]))[0].status, "draft",
    `${label}: the row is a draft even though the call asked for public visibility`);

  // A live post is refused the one draft refusal and left alone.
  const liveBefore = await rows("SELECT * FROM blog_posts WHERE id = ?", [LIVE_ID]);
  const liveEdit = await call("crow_edit_post", { id: LIVE_ID, title: "A router bot rewrote a live post" });
  assert.equal(liveEdit.text, DRAFT_ONLY_EDIT_TEXT, `${label} edit live: the fixed draft refusal`);
  assert.deepEqual(await rows("SELECT * FROM blog_posts WHERE id = ?", [LIVE_ID]), liveBefore,
    `${label} edit live: nothing changed`);

  // The listing is drafts only, and a read of a live post is the ordinary not-found text.
  const listed = await call("crow_list_posts", { status: "published" });
  assert.equal(listed.isError, false, `${label} list: ${listed.text}`);
  assert.ok(!listed.text.includes(LIVE_TITLE), `${label} list: no published post`);
  const live = await call("crow_get_post", { id: LIVE_ID });
  assert.equal(live.text, NOT_FOUND_TEXT, `${label} get live: identical to a missing post`);

  // And a publish is still refused, which is the whole point of the draft allowance.
  await expectOwnerOnly(call, label, "crow_publish_post", { id, confirm_token: "" }, "This will publish");
  await expectOwnerOnly(call, label, "crow_unpublish_post", { id }, "reverted to draft");
}

test("the gateway path gives a bot-marked caller drafts only, and an owner header is ignored", async () => {
  // A caller marking itself a bot: drafts only with an id and without one. The id-less claim resolves
  // to the same actor an unmarked client gets, so the draft rule has to come from the CLAIM — an
  // unverifiable bot is never treated as the operator's own client.
  for (const [label, headers] of [
    ["bot, no id", BOT_HEADER],
    ["bot, with id", BOT_ID_HEADER],
  ]) {
    const e = await openRouter(actor.OWNER, headers);
    await expectRouterDraftOnly(e.call, `router ${label}`, `A router draft from a ${label} caller`);
  }

  // A header cannot upgrade either: on a router built for a bot, `x-crow-actor-kind: owner` is
  // ignored and the mount's own actor still decides (drafts only, no publish).
  const botRouter = await openRouter({ kind: "bot", id: BOT }, OWNER_HEADER);
  await expectRouterDraftOnly(botRouter.call, "router owner header on a bot mount",
    "A router draft claiming to be the owner");

  // And on an owner-built router the same header is ignored the other way: it is no credential,
  // and no downgrade — the mount's actor, the owner, still creates and publishes the post.
  const ownerRouter = await openRouter(actor.OWNER, OWNER_HEADER);
  const title = "A router post from the owner with an owner header";
  const created = await ownerRouter.call("crow_create_post", { title, content: "The operator's words." });
  assert.equal(created.isError, false, created.text);
  assert.match(created.text, /Created draft/);
  assert.equal(await count("SELECT COUNT(*) AS n FROM blog_posts WHERE title = ?", [title]), 1, "the owner's post exists");
  const id = Number(/ID: (\d+)/.exec(created.text)?.[1]);
  const preview = await ownerRouter.call("crow_publish_post", { id, confirm_token: "" });
  assert.equal(preview.isError, false, preview.text);
  const token = /confirm_token: "([^"]+)"/.exec(preview.text)?.[1];
  const published = await ownerRouter.call("crow_publish_post", { id, confirm_token: token });
  assert.equal(published.isError, false, published.text);
  assert.match(published.text, /^Published!/, "the owner's own turn still publishes through the router");
});

// --- (f) a registration the guard could not guard is refused at registration ---------------

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