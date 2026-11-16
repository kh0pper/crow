/**
 * Project shares on the memory server (Phase 1): a bot's memory tools follow its home project and
 * the projects it holds a share of, a by-id tool answers a row it may not see exactly the way it
 * answers a missing id, the operator's voice bot keeps operator scope, and the owner / unknown
 * caller behaves as before.
 *
 * Scratch CROW_HOME + data dir, a real crow.db from scripts/init-db.js. Nothing here touches
 * ~/.crow.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "share-memory-"));
const DATA = join(dir, "data");
const HOME = join(dir, "home");
mkdirSync(DATA, { recursive: true });
mkdirSync(HOME, { recursive: true });
process.env.CROW_HOME = HOME;
process.env.CROW_DATA_DIR = DATA;
delete process.env.CROW_DB_PATH;
process.env.CROW_TASKS_DB_PATH = join(DATA, "tasks.db");
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
delete process.env.CROW_EMBED_PROVIDER;
delete process.env.CROW_RERANK_PROVIDER;

const REPO = join(import.meta.dirname, "..");
const DB_FILE = join(DATA, "crow.db");

let db = null;
let createMemoryServer = null;
let Client = null;
let InMemoryTransport = null;
let S = null;
let OWNER = null;
let UNKNOWN = null;
let createProjectSpace = null;
let generateCrowContext = null;

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env }, stdio: "pipe", cwd: REPO });
  const { createDbClient } = await import("../servers/db.js");
  db = createDbClient();
  ({ createMemoryServer } = await import("../servers/memory/server.js"));
  ({ generateCrowContext } = await import("../servers/memory/crow-context.js"));
  ({ Client } = await import("@modelcontextprotocol/sdk/client/index.js"));
  ({ InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js"));
  S = await import("../servers/shared/project-share-scope.js");
  ({ OWNER, UNKNOWN } = await import("../servers/research/actor.js"));
  ({ createProjectSpace } = await import("../servers/shared/project-spaces.js"));
});

after(async () => {
  try { db && db.close && db.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

// --- harness ---------------------------------------------------------------------------------

/** A memory server wired to an in-process client, as the gateway and the stdio server wire it. */
async function open(options = {}) {
  const server = createMemoryServer(DB_FILE, options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport)]);
  const client = new Client({ name: "share-memory", version: "0" });
  await client.connect(clientTransport);
  return {
    client,
    async call(name, args, meta) {
      const params = meta ? { name, arguments: args, _meta: meta } : { name, arguments: args };
      const r = await client.callTool(params);
      const text = (r.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
      return { text, isError: !!r.isError };
    },
    async close() {
      try { await client.close(); } catch {}
      try { await server.close(); } catch {}
    },
  };
}

const rows = async (sql, args = []) => (await db.execute({ sql, args })).rows;
const count = async (sql, args = []) => Number((await rows(sql, args))[0].n);

// --- fixtures --------------------------------------------------------------------------------

let projectSeq = 0;
async function mkProject(name) {
  const r = await createProjectSpace(db, { name: name || `Memory share project ${++projectSeq}` });
  return Number(r.id);
}

let botSeq = 0;
async function mkBot({ home = null } = {}) {
  botSeq += 1;
  const botId = `memory-share-bot-${botSeq}`;
  await db.execute({
    sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, project_id, enabled) VALUES (?,?,?,?,1)",
    args: [botId, `Bot ${botSeq}`, "{}", home],
  });
  return botId;
}

async function grant(projectId, botId, level = "read_write") {
  await db.execute({
    sql: "INSERT INTO project_bot_shares (project_id, bot_id, level) VALUES (?,?,?)",
    args: [Number(projectId), botId, level],
  });
}

async function revoke(projectId, botId) {
  await db.execute({
    sql: "UPDATE project_bot_shares SET revoked_at = datetime('now') WHERE project_id = ? AND bot_id = ? AND revoked_at IS NULL",
    args: [Number(projectId), botId],
  });
}

let tokenSeq = 0;
/** A word no other test uses, so each test's rows are the only ones a full-text query matches. */
const token = () => `zq${++tokenSeq}x`;

async function seedMemory(content, projectId) {
  const r = await db.execute({
    sql: "INSERT INTO memories (content, category, importance, project_id) VALUES (?, 'general', 5, ?)",
    args: [content, projectId == null ? null : Number(projectId)],
  });
  return Number(r.lastInsertRowid);
}

const memory = async (id) => (await rows("SELECT * FROM memories WHERE id = ?", [Number(id)]))[0] ?? null;

async function seedSource(title, projectId) {
  const r = await db.execute({
    sql: "INSERT INTO research_sources (title, source_type, citation_apa, project_id) VALUES (?, 'web_article', ?, ?)",
    args: [title, title, projectId == null ? null : Number(projectId)],
  });
  return Number(r.lastInsertRowid);
}

async function seedNote(title, projectId, sourceId = null) {
  const r = await db.execute({
    sql: "INSERT INTO research_notes (title, content, project_id, source_id) VALUES (?, ?, ?, ?)",
    args: [title, `${title} body`, projectId == null ? null : Number(projectId), sourceId == null ? null : Number(sourceId)],
  });
  return Number(r.lastInsertRowid);
}

// --- writes ----------------------------------------------------------------------------------

test("a bot with no share cannot store into another project, and nothing is inserted", async () => {
  const home = await mkProject();
  const B = await mkProject();
  const bot = await mkBot({ home });
  const s = await open({ actor: { kind: "bot", id: bot } });
  try {
    const before = await count("SELECT COUNT(*) AS n FROM memories");
    const r = await s.call("crow_store_memory", { content: `${token()} nope`, project_id: B });
    assert.equal(r.isError, true);
    assert.match(r.text, /No share grants this bot access to that project/);
    assert.equal(await count("SELECT COUNT(*) AS n FROM memories"), before, "nothing was inserted");
  } finally { await s.close(); }
});

test("a read share refuses store, update and delete on that project, and the row survives", async () => {
  const home = await mkProject();
  const B = await mkProject();
  const bot = await mkBot({ home });
  await grant(B, bot, "read");
  const id = await seedMemory(`${token()} shared read row`, B);
  const s = await open({ actor: { kind: "bot", id: bot } });
  try {
    const stored = await s.call("crow_store_memory", { content: `${token()} refused`, project_id: B });
    assert.equal(stored.isError, true);
    assert.match(stored.text, /read-only/);

    const updated = await s.call("crow_update_memory", { id, content: "overwritten" });
    assert.equal(updated.isError, true);
    assert.equal(updated.text, `Error: ${S.NOT_FOUND_MESSAGE}`);

    const deleted = await s.call("crow_delete_memory", { id, confirm_token: "" });
    assert.equal(deleted.isError, true);
    assert.equal(deleted.text, `Error: ${S.NOT_FOUND_MESSAGE}`);

    const still = await memory(id);
    assert.ok(still, "the row was not deleted");
    assert.notEqual(still.content, "overwritten", "the row was not updated");
  } finally { await s.close(); }
});

test("a read_write share stores into that project and the sync emit still fires once", async () => {
  const home = await mkProject();
  const B = await mkProject();
  const bot = await mkBot({ home });
  await grant(B, bot, "read_write");
  const emitted = [];
  const s = await open({
    actor: { kind: "bot", id: bot },
    syncManager: { feedsDisabled: false, emitChange: async (table, op, row) => { emitted.push({ table, op, row }); return 1; } },
  });
  try {
    const content = `${token()} shared write`;
    const r = await s.call("crow_store_memory", { content, project_id: B });
    assert.equal(r.isError, false, r.text);
    const id = Number(/id: (\d+)/.exec(r.text)[1]);
    const row = await memory(id);
    assert.equal(Number(row.project_id), B);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(emitted.length, 1, "one sync emit for the one insert");
    assert.equal(emitted[0].table, "memories");
    assert.equal(emitted[0].op, "insert");
    assert.equal(emitted[0].row.content, content);
  } finally { await s.close(); }
});

test("a bot's write with no project lands in its home project; with no home project it is refused", async () => {
  const home = await mkProject();
  const bot = await mkBot({ home });
  const homeless = await mkBot({});
  const s = await open({ actor: { kind: "bot", id: bot } });
  const h = await open({ actor: { kind: "bot", id: homeless } });
  try {
    const content = `${token()} homed write`;
    const r = await s.call("crow_store_memory", { content });
    assert.equal(r.isError, false, r.text);
    const id = Number(/id: (\d+)/.exec(r.text)[1]);
    assert.equal(Number((await memory(id)).project_id), home);

    const before = await count("SELECT COUNT(*) AS n FROM memories");
    const refused = await h.call("crow_store_memory", { content: `${token()} homeless write` });
    assert.equal(refused.isError, true);
    assert.equal(refused.text, `Error: ${S.NAME_A_PROJECT_MESSAGE}`);
    assert.equal(await count("SELECT COUNT(*) AS n FROM memories"), before, "nothing was inserted");
  } finally { await s.close(); await h.close(); }
});

// --- reads with no project -------------------------------------------------------------------

test("a bot's search with no project returns the home project only, over the full-text path", async () => {
  const A = await mkProject();
  const B = await mkProject();
  const bot = await mkBot({ home: A });
  await grant(B, bot, "read_write");
  const t = token();
  await seedMemory(`${t} home row`, A);
  await seedMemory(`${t} shared row`, B);
  await seedMemory(`${t} loose row`, null);
  const s = await open({ actor: { kind: "bot", id: bot } });
  try {
    const r = await s.call("crow_search_memories", { query: t, semantic: false });
    assert.match(r.text, /home row/);
    assert.doesNotMatch(r.text, /shared row/, "a share of B does not widen an omitted project");
    assert.doesNotMatch(r.text, /loose row/, "project-less rows are the owner's");
  } finally { await s.close(); }
});

test("a bot's search with no project stays home-only over the semantic path too", async () => {
  const A = await mkProject();
  const B = await mkProject();
  const bot = await mkBot({ home: A });
  await grant(B, bot, "read_write");
  const t = token();
  const homeId = await seedMemory(`${t} home semantic row`, A);
  const sharedId = await seedMemory(`${t} shared semantic row`, B);
  const looseId = await seedMemory(`${t} loose semantic row`, null);

  // A stub embedding provider: every row gets the same vector, so the semantic path ranks all
  // three and only the fetch SQL's scope can keep two of them out.
  const { vecToBlob } = await import("../servers/memory/embeddings.js");
  const vec = Float32Array.from([1, 0, 0, 0]);
  await db.execute({
    sql: "INSERT OR REPLACE INTO providers (id, base_url, api_key, models) VALUES ('sharetests', 'http://127.0.0.1:9', 'none', ?)",
    args: [JSON.stringify([{ id: "share-embed", task: "embed", dim: 4 }])],
  });
  for (const id of [homeId, sharedId, looseId]) {
    await db.execute({
      sql: "INSERT OR REPLACE INTO memory_embeddings_blob (memory_id, model, dim, vec) VALUES (?, 'share-embed', 4, ?)",
      args: [id, vecToBlob(vec)],
    });
  }

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.endsWith("/models")) return { ok: true, json: async () => ({ data: [{ id: "share-embed" }] }) };
    return { ok: true, json: async () => ({ data: [{ embedding: [1, 0, 0, 0] }] }) };
  };
  process.env.CROW_EMBED_PROVIDER = "sharetests";
  const s = await open({ actor: { kind: "bot", id: bot } });
  try {
    // The query appears in no row, so only the semantic path can return anything at all.
    const r = await s.call("crow_search_memories", { query: `${t}notindexed` });
    assert.match(r.text, /home semantic row/, "the semantic path ran and the home row came back");
    assert.doesNotMatch(r.text, /shared semantic row/);
    assert.doesNotMatch(r.text, /loose semantic row/);
    assert.doesNotMatch(r.text, /No memories found/);
  } finally {
    await s.close();
    globalThis.fetch = realFetch;
    delete process.env.CROW_EMBED_PROVIDER;
    await db.execute("DELETE FROM providers WHERE id = 'sharetests'");
    const { _resetProviderTaskCacheForTest } = await import("../servers/shared/provider-task.js");
    _resetProviderTaskCacheForTest();
  }
});

test("a bot naming a shared project sees that project and never the home rows", async () => {
  const A = await mkProject();
  const B = await mkProject();
  const bot = await mkBot({ home: A });
  await grant(B, bot, "read");
  const t = token();
  await seedMemory(`${t} home row`, A);
  await seedMemory(`${t} shared row`, B);
  await seedMemory(`${t} loose row`, null);
  const s = await open({ actor: { kind: "bot", id: bot } });
  try {
    const r = await s.call("crow_search_memories", { query: t, semantic: false, project_id: B });
    assert.match(r.text, /shared row/);
    assert.doesNotMatch(r.text, /home row/, "recall of a shared project is never merged with home");
    assert.doesNotMatch(r.text, /loose row/);
  } finally { await s.close(); }
});

test("recall_by_context and list_memories follow the same scope, omitted and named", async () => {
  const A = await mkProject();
  const B = await mkProject();
  const bot = await mkBot({ home: A });
  await grant(B, bot, "read");
  const t = token();
  await seedMemory(`${t} home row`, A);
  await seedMemory(`${t} shared row`, B);
  await seedMemory(`${t} loose row`, null);
  const s = await open({ actor: { kind: "bot", id: bot } });
  try {
    for (const tool of ["crow_recall_by_context", "crow_list_memories"]) {
      const args = tool === "crow_recall_by_context" ? { context: t } : {};
      const homeOnly = await s.call(tool, args);
      assert.equal(homeOnly.isError, false, `${tool}: ${homeOnly.text}`);
      assert.match(homeOnly.text, /home row/, tool);
      assert.doesNotMatch(homeOnly.text, /shared row/, `${tool} without a project`);
      assert.doesNotMatch(homeOnly.text, /loose row/, `${tool} without a project`);

      const named = await s.call(tool, { ...args, project_id: B });
      assert.match(named.text, /shared row/, `${tool} on the shared project`);
      assert.doesNotMatch(named.text, /home row/, `${tool} on the shared project`);
      assert.doesNotMatch(named.text, /loose row/, `${tool} on the shared project`);
    }
  } finally { await s.close(); }
});

test("deep_recall scopes every project-scoped subquery and leaves blog posts out for a bot", async () => {
  const A = await mkProject();
  const B = await mkProject();
  const bot = await mkBot({ home: A });
  await grant(B, bot, "read");
  const t = token();
  await seedMemory(`${t} home memory`, A);
  await seedMemory(`${t} shared memory`, B);
  await seedMemory(`${t} loose memory`, null);
  await seedSource(`${t} home source`, A);
  await seedSource(`${t} shared source`, B);
  await seedSource(`${t} loose source`, null);
  await seedNote(`${t} home note`, A);
  await seedNote(`${t} shared note`, B);
  await seedNote(`${t} loose note`, null);
  await db.execute({
    sql: "INSERT INTO blog_posts (slug, title, content, status) VALUES (?, ?, ?, 'draft')",
    args: [`${t}-post`, `${t} blog post`, `${t} blog body`],
  });

  const owner = await open({ actor: OWNER });
  const s = await open({ actor: { kind: "bot", id: bot } });
  try {
    // The fixtures themselves are reachable: the owner's recall sees all of them.
    const everything = await owner.call("crow_deep_recall", { topic: t, per_source_limit: 10 });
    for (const marker of ["home memory", "shared memory", "loose memory", "home source", "shared source",
      "loose source", "home note", "shared note", "loose note", "blog post"]) {
      assert.match(everything.text, new RegExp(marker), `the owner sees ${marker}`);
    }

    const homeOnly = await s.call("crow_deep_recall", { topic: t, per_source_limit: 10 });
    assert.match(homeOnly.text, /home memory/);
    assert.match(homeOnly.text, /home source/);
    assert.match(homeOnly.text, /home note/);
    for (const marker of ["shared memory", "loose memory", "shared source", "loose source", "shared note",
      "loose note", "blog post"]) {
      assert.doesNotMatch(homeOnly.text, new RegExp(marker), `a bot must not see ${marker}`);
    }
    assert.match(homeOnly.text, /Sources searched: memories, research_sources, research_notes\n/,
      "blog posts are not searched for a bot");

    const named = await s.call("crow_deep_recall", { topic: t, per_source_limit: 10, project_id: B });
    assert.match(named.text, /shared memory/);
    assert.match(named.text, /shared source/);
    assert.match(named.text, /shared note/);
    for (const marker of ["home memory", "loose memory", "home source", "loose source", "home note",
      "loose note", "blog post"]) {
      assert.doesNotMatch(named.text, new RegExp(marker), `the shared project's recall must not carry ${marker}`);
    }
  } finally { await owner.close(); await s.close(); }
});

// A home note may name a source the note's reader cannot reach: the note's own project scopes the
// note, and the source's project must scope the title it lends the note.
test("deep_recall never lends a home note a source title the bot cannot read, and the owner still sees it", async () => {
  const A = await mkProject();
  const B = await mkProject();
  const bot = await mkBot({ home: A });
  const t = token();
  const homeTitle = `${t} home source title`;
  const looseTitle = `${t} loose source title`;
  const otherTitle = `${t} other project source title`;
  const homeSource = await seedSource(homeTitle, A);
  const looseSource = await seedSource(looseTitle, null);
  const otherSource = await seedSource(otherTitle, B);
  await seedNote(`${t} home note on a home source`, A, homeSource);
  await seedNote(`${t} home note on a loose source`, A, looseSource);
  await seedNote(`${t} home note on another project's source`, A, otherSource);

  const owner = await open({ actor: OWNER });
  const s = await open({ actor: { kind: "bot", id: bot } });
  try {
    const mine = await s.call("crow_deep_recall", { topic: t, per_source_limit: 20 });
    assert.match(mine.text, /home note on a home source/, "the bot reads its home project's note");
    assert.ok(mine.text.includes(`re: "${homeTitle}"`), "a home note's home-project source is still named");
    assert.ok(!mine.text.includes(`re: "${looseTitle}"`),
      "a project-less source's title never rides a home note");
    assert.ok(!mine.text.includes(`re: "${otherTitle}"`),
      "another project's source title never rides a home note");

    const seen = await owner.call("crow_deep_recall", { topic: t, per_source_limit: 20 });
    for (const title of [homeTitle, looseTitle, otherTitle]) {
      assert.ok(seen.text.includes(`re: "${title}"`), `the owner still sees ${title}`);
    }
  } finally { await owner.close(); await s.close(); }
});

// --- by-id -----------------------------------------------------------------------------------

test("get_memory answers a hidden row exactly like a missing one and returns a shared row", async () => {
  const A = await mkProject();
  const B = await mkProject();
  const hidden = await mkProject();
  const bot = await mkBot({ home: A });
  await grant(B, bot, "read");
  const t = token();
  const sharedId = await seedMemory(`${t} shared by id`, B);
  const hiddenId = await seedMemory(`${t} hidden by id`, hidden);
  const looseId = await seedMemory(`${t} loose by id`, null);
  const s = await open({ actor: { kind: "bot", id: bot } });
  try {
    const missing = await s.call("crow_get_memory", { id: 987654321 });
    const hiddenShared = await s.call("crow_get_memory", { id: hiddenId });
    const hiddenLoose = await s.call("crow_get_memory", { id: looseId });
    assert.equal(missing.text, `Error: ${S.NOT_FOUND_MESSAGE}`);
    assert.equal(hiddenShared.text, missing.text, "a hidden row is indistinguishable from a missing one");
    assert.equal(hiddenLoose.text, missing.text, "a project-less row is the owner's alone");
    assert.equal(hiddenShared.isError, true);

    const visible = await s.call("crow_get_memory", { id: sharedId });
    assert.equal(visible.isError, false, visible.text);
    const payload = JSON.parse(visible.text);
    assert.equal(payload.id, sharedId);
    assert.equal(payload.project_id, B);
    assert.match(payload.content, /shared by id/);
  } finally { await s.close(); }
});

// --- stats and the consolidation report ------------------------------------------------------

test("memory stats preview home rows only and count only home rows", async () => {
  const A = await mkProject();
  const B = await mkProject();
  const bot = await mkBot({ home: A });
  await grant(B, bot, "read_write");
  const t = token();
  await seedMemory(`${t} home counted`, A);
  await seedMemory(`${t} home counted too`, A);
  await seedMemory(`${t} shared not counted`, B);
  await seedMemory(`${t} loose not counted`, null);
  const s = await open({ actor: { kind: "bot", id: bot } });
  try {
    const r = await s.call("crow_memory_stats", {});
    assert.doesNotMatch(r.text, /shared not counted/);
    assert.doesNotMatch(r.text, /loose not counted/);
    const total = Number(/Total memories: (\d+)/.exec(r.text)[1]);
    const homeCount = await count("SELECT COUNT(*) AS n FROM memories WHERE project_id = ?", [A]);
    assert.equal(total, homeCount, "the counts cover the home project only");
    assert.ok(homeCount >= 2);
  } finally { await s.close(); }
});

test("dream quotes home rows only in a dry run and is refused as a live run for a bot", async () => {
  const A = await mkProject();
  const B = await mkProject();
  const bot = await mkBot({ home: A });
  await grant(B, bot, "read_write");
  const t = token();
  const staleIds = [
    await seedMemory(`${t} home stale row`, A),
    await seedMemory(`${t} shared stale row`, B),
    await seedMemory(`${t} loose stale row`, null),
  ];
  await db.execute({
    sql: `UPDATE memories SET created_at = '2020-01-01 00:00:00', accessed_at = NULL WHERE id IN (${staleIds.map(() => "?").join(",")})`,
    args: staleIds,
  });
  const s = await open({ actor: { kind: "bot", id: bot } });
  try {
    const dry = await s.call("crow_dream", { stale_days: 30, low_importance_threshold: 10, dry_run: true });
    assert.match(dry.text, /home stale row/);
    assert.doesNotMatch(dry.text, /shared stale row/);
    assert.doesNotMatch(dry.text, /loose stale row/);

    const live = await s.call("crow_dream", { stale_days: 30, low_importance_threshold: 10, dry_run: false });
    assert.equal(live.isError, true);
    assert.match(live.text, /operator only/);
  } finally { await s.close(); }
});

test("regenerate_embeddings is refused for a bot", async () => {
  const A = await mkProject();
  const bot = await mkBot({ home: A });
  const s = await open({ actor: { kind: "bot", id: bot } });
  try {
    const r = await s.call("crow_regenerate_embeddings", {});
    assert.equal(r.isError, true);
    assert.match(r.text, /operator only/);
  } finally { await s.close(); }
});

// --- the operator's voice bot ----------------------------------------------------------------

test("the operator's voice bot recalls across every project and project-less rows like the owner", async () => {
  const A = await mkProject();
  const B = await mkProject();
  const t = token();
  await seedMemory(`${t} voice home row`, A);
  await seedMemory(`${t} voice shared row`, B);
  await seedMemory(`${t} voice loose row`, null);

  const owner = await open({ actor: OWNER });
  const voice = await open({ actor: S.operatorVoiceActor() });
  try {
    const calls = [
      ["crow_search_memories", { query: t, semantic: false }],
      ["crow_recall_by_context", { context: t }],
      ["crow_list_memories", { limit: 100 }],
      ["crow_deep_recall", { topic: t, include_sources: ["memories"], per_source_limit: 10 }],
    ];
    for (const [tool, args] of calls) {
      const mine = await owner.call(tool, args);
      const theirs = await voice.call(tool, args);
      assert.doesNotMatch(mine.text, /Error:/, `${tool}: the owner is unrestricted`);
      for (const marker of ["voice home row", "voice shared row", "voice loose row"]) {
        assert.match(theirs.text, new RegExp(marker), `${tool}: the voice bot sees ${marker}`);
      }
      assert.equal(theirs.text, mine.text, `${tool}: the voice bot answers exactly like the owner`);
    }
  } finally { await owner.close(); await voice.close(); }
});

test("the operator's voice bot stores with no project (project-less) and with a project", async () => {
  const B = await mkProject();
  const voice = await open({ actor: S.operatorVoiceActor() });
  try {
    const loose = await voice.call("crow_store_memory", { content: `${token()} voice loose write` });
    assert.equal(loose.isError, false, loose.text);
    const looseId = Number(/id: (\d+)/.exec(loose.text)[1]);
    assert.equal((await memory(looseId)).project_id, null, "no project_id: project-less, as today");

    const filed = await voice.call("crow_store_memory", { content: `${token()} voice filed write`, project_id: B });
    assert.equal(filed.isError, false, filed.text);
    const filedId = Number(/id: (\d+)/.exec(filed.text)[1]);
    assert.equal(Number((await memory(filedId)).project_id), B);
  } finally { await voice.close(); }
});

// --- two calls in one session ----------------------------------------------------------------

test("a delete previewed before a revoke cannot be confirmed after it", async () => {
  const A = await mkProject();
  const B = await mkProject();
  const bot = await mkBot({ home: A });
  await grant(B, bot, "read_write");
  const id = await seedMemory(`${token()} delete target`, B);
  const s = await open({ actor: { kind: "bot", id: bot } });
  try {
    const preview = await s.call("crow_delete_memory", { id, confirm_token: "" });
    assert.equal(preview.isError, false, preview.text);
    const confirmToken = /confirm_token: "([^"]+)"/.exec(preview.text)[1];
    assert.ok(confirmToken);

    await revoke(B, bot);

    const confirmed = await s.call("crow_delete_memory", { id, confirm_token: confirmToken });
    assert.equal(confirmed.isError, true);
    assert.equal(confirmed.text, `Error: ${S.NOT_FOUND_MESSAGE}`);
    assert.ok(await memory(id), "the row remains");
  } finally { await s.close(); }
});

// --- crow.md context tools -------------------------------------------------------------------

test("I3: a bot's context calls act on its home project and never on the global scope", async () => {
  const A = await mkProject();
  const other = await mkProject();
  const bot = await mkBot({ home: A });
  const homeless = await mkBot({});
  const key = `share_probe_${token()}`;
  await db.execute({
    sql: "INSERT INTO crow_context (section_key, section_title, content, sort_order) VALUES (?, 'Probe', 'global body', 90)",
    args: [key],
  });
  await db.execute({
    sql: "INSERT INTO crow_context (section_key, section_title, content, sort_order, project_id) VALUES (?, 'Probe', 'home body', 90, ?)",
    args: [key, A],
  });
  await db.execute({
    sql: "INSERT INTO crow_context (section_key, section_title, content, sort_order, project_id) VALUES (?, 'Probe', 'other body', 90, ?)",
    args: [key, other],
  });

  const s = await open({ actor: { kind: "bot", id: bot } });
  const h = await open({ actor: { kind: "bot", id: homeless } });
  try {
    const context = await s.call("crow_get_context", {});
    assert.doesNotMatch(context.text, /\(Dynamic\)/, "a bot's context carries no dynamic block");
    assert.match(context.text, /home body/, "the home project's override is merged");
    assert.doesNotMatch(context.text, /other body/);
    assert.equal(context.text, await generateCrowContext(db, { includeDynamic: false, platform: "generic", deviceId: null, projectId: A }));

    const updated = await s.call("crow_update_context_section", { section_key: key, content: "home body v2" });
    assert.match(updated.text, /updated/);
    const saved = await rows("SELECT content FROM crow_context WHERE section_key = ? AND project_id IS ?", [key, A]);
    assert.equal(saved[0].content, "home body v2");
    const globalRow = await rows("SELECT content FROM crow_context WHERE section_key = ? AND project_id IS NULL", [key]);
    assert.equal(globalRow[0].content, "global body", "the global section is untouched");

    const addedKey = `share_added_${token()}`;
    const added = await s.call("crow_add_context_section", { section_key: addedKey, section_title: "Added", content: "added body" });
    assert.match(added.text, /added to crow\.md/);
    const addedRow = await rows("SELECT project_id FROM crow_context WHERE section_key = ?", [addedKey]);
    assert.equal(Number(addedRow[0].project_id), A, "a bot's new section belongs to its home project");
    assert.equal(addedRow.length, 1);

    const listed = await s.call("crow_list_context_sections", {});
    assert.match(listed.text, new RegExp(addedKey), "the bot lists its own project's sections");
    // The probe key exists globally, in the home project and in another project; a bot's listing
    // carries the global section and its home project's override, never the other project's.
    assert.equal((listed.text.match(new RegExp(key, "g")) || []).length, 2);

    // Another project's sections are refused, not listed.
    const elsewhere = await s.call("crow_list_context_sections", { project_id: other });
    assert.equal(elsewhere.isError, true);
    assert.match(elsewhere.text, /own project only/);

    // A bot with no home project sees the global sections and no project-scoped ones.
    const homelessListed = await h.call("crow_list_context_sections", {});
    assert.equal(homelessListed.isError, false, homelessListed.text);
    assert.doesNotMatch(homelessListed.text, /\[project: /, "no project's sections for a bot with none");

    // A bot with no home project has no project to act on.
    for (const [tool, args] of [
      ["crow_get_context", {}],
      ["crow_update_context_section", { section_key: key, content: "planted" }],
      ["crow_add_context_section", { section_key: `${key}_x`, section_title: "X", content: "planted" }],
    ]) {
      const r = await h.call(tool, args);
      assert.equal(r.isError, true, tool);
      assert.match(r.text, /own project only/, tool);
    }
    assert.equal((await rows("SELECT content FROM crow_context WHERE section_key = ? AND project_id IS NULL", [key]))[0].content,
      "global body", "nothing reached the global scope");
  } finally { await s.close(); await h.close(); }
});

// --- schedules and notifications are the operator's ------------------------------------------

test("a bot is refused every schedule tool; the owner is unchanged", async () => {
  const A = await mkProject();
  const bot = await mkBot({ home: A });
  const s = await open({ actor: { kind: "bot", id: bot } });
  const owner = await open({ actor: UNKNOWN });
  try {
    const before = await count("SELECT COUNT(*) AS n FROM schedules");
    const calls = [
      ["crow_create_schedule", { task: "water the plants", cron_expression: "0 9 * * *" }],
      ["crow_list_schedules", {}],
      ["crow_update_schedule", { id: 1, enabled: false }],
    ];
    for (const [tool, args] of calls) {
      const r = await s.call(tool, args);
      assert.equal(r.isError, true, tool);
      assert.match(r.text, /operator only/, tool);
    }
    assert.equal(await count("SELECT COUNT(*) AS n FROM schedules"), before, "no schedule was created");

    const made = await owner.call("crow_create_schedule", { task: "owner reminder", cron_expression: "0 9 * * *" });
    assert.equal(made.isError, false, made.text);
    assert.match(made.text, /Schedule created/);
  } finally { await s.close(); await owner.close(); }
});

test("a bot's update_schedule answers an existing routine id and a missing id identically", async () => {
  const A = await mkProject();
  const bot = await mkBot({ home: A });
  const made = await db.execute({
    sql: "INSERT INTO schedules (task, cron_expression, description, enabled) VALUES (?, '0 9 * * *', 'a bot routine', 1)",
    args: [`pipeline:botcron:${bot}`],
  });
  const routineId = Number(made.lastInsertRowid);
  const s = await open({ actor: { kind: "bot", id: bot } });
  try {
    const existing = await s.call("crow_update_schedule", { id: routineId, enabled: false });
    const missing = await s.call("crow_update_schedule", { id: 987654321, enabled: false });
    assert.equal(existing.isError, true);
    assert.equal(existing.text, missing.text,
      "a bot must not learn from the answer whether an id exists or is a routine");
    assert.match(existing.text, /operator only/);
    assert.doesNotMatch(existing.text, /Bot Builder/);
    const still = await rows("SELECT enabled FROM schedules WHERE id = ?", [routineId]);
    assert.equal(Number(still[0].enabled), 1, "nothing was changed");
  } finally { await s.close(); }
});

test("a bot is refused the notification tools; sending one is still allowed", async () => {
  const A = await mkProject();
  const bot = await mkBot({ home: A });
  const s = await open({ actor: { kind: "bot", id: bot } });
  try {
    for (const tool of ["crow_check_notifications", "crow_dismiss_all_notifications"]) {
      const r = await s.call(tool, {});
      assert.equal(r.isError, true, tool);
      assert.match(r.text, /operator only/, tool);
    }
    const sent = await s.call("crow_create_notification", { title: "Bot status", body: "done" });
    assert.equal(sent.isError, false, sent.text);
    assert.match(sent.text, /Notification created/);
  } finally { await s.close(); }
});

// --- owner and unknown ----------------------------------------------------------------------

test("the owner and an unidentified caller keep today's behaviour on every memory tool", async () => {
  const A = await mkProject();
  const B = await mkProject();
  const t = token();
  await seedMemory(`${t} owner home row`, A);
  await seedMemory(`${t} owner shared row`, B);
  await seedMemory(`${t} owner loose row`, null);
  const loose = await seedMemory(`${t} owner by id loose`, null);
  for (const actor of [OWNER, UNKNOWN]) {
    const o = await open({ actor });
    try {
      const stored = await o.call("crow_store_memory", { content: `${t} ${actor.kind} write` });
      assert.equal(stored.isError, false, stored.text);
      const newId = Number(/id: (\d+)/.exec(stored.text)[1]);
      assert.equal((await memory(newId)).project_id, null, `${actor.kind}: no project stays project-less`);

      const search = await o.call("crow_search_memories", { query: t, semantic: false, limit: 50 });
      assert.match(search.text, /owner home row/, actor.kind);
      assert.match(search.text, /owner shared row/, actor.kind);
      assert.match(search.text, /owner loose row/, actor.kind);

      const got = await o.call("crow_get_memory", { id: loose });
      assert.equal(got.isError, false, `${actor.kind}: a project-less row is reachable`);
      assert.match(got.text, /owner by id loose/);

      const dream = await o.call("crow_dream", { dry_run: false });
      assert.equal(dream.isError, false, `${actor.kind}: a live dream run stays the operator's`);
    } finally { await o.close(); }
  }
});