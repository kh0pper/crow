/**
 * Project shares on the ungated corners of the memory and research servers (Phase 1): the two
 * project-neutral tools (`crow_web_search`, `crow_create_notification`) and the three MCP
 * resources (`crow://context`, `memory://categories`, `projects://list`) follow the same gate the
 * project tools do, while the owner, an unidentified caller and the operator's voice bot are
 * untouched.
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

const dir = mkdtempSync(join(tmpdir(), "share-resources-"));
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
// The default web-search caller answers "not configured" without a key; keep that deterministic.
delete process.env.BRAVE_API_KEY;

const REPO = join(import.meta.dirname, "..");
const DB_FILE = join(DATA, "crow.db");

const UNVERIFIED = Object.freeze({ kind: "bot", id: null, unverified: true });

let db = null;
let createMemoryServer = null;
let createProjectServer = null;
let generateCrowContext = null;
let Client = null;
let InMemoryTransport = null;
let S = null;
let OWNER = null;
let UNKNOWN = null;
let createProjectSpace = null;

// Two projects the bot can name, one it never can, and the bot ids the tests share.
let A = null;          // the home project
let B = null;          // shared with BOT_HOME (read) and BOT_NOSHARE holds nothing
let HIDDEN = null;     // never shared
let BOT_HOME = null;   // home A, read share of B
let BOT_NOSHARE = null; // home A, no share of B

const CAT_HOME = "resource-cat-home";
const CAT_SHARED = "resource-cat-shared";
const CAT_LOOSE = "resource-cat-loose";

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env }, stdio: "pipe", cwd: REPO });
  const { createDbClient } = await import("../servers/db.js");
  db = createDbClient(DB_FILE);
  ({ createMemoryServer } = await import("../servers/memory/server.js"));
  ({ createProjectServer } = await import("../servers/research/server.js"));
  ({ generateCrowContext } = await import("../servers/memory/crow-context.js"));
  ({ Client } = await import("@modelcontextprotocol/sdk/client/index.js"));
  ({ InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js"));
  S = await import("../servers/shared/project-share-scope.js");
  ({ OWNER, UNKNOWN } = await import("../servers/research/actor.js"));
  ({ createProjectSpace } = await import("../servers/shared/project-spaces.js"));

  // Constructing one server readies the provenance/withdrawal columns this file's fixtures and
  // the research resource use.
  createProjectServer(DB_FILE, { actor: OWNER }).close();

  A = Number((await createProjectSpace(db, { name: "Resource Home Alpha", description: "alpha description" })).id);
  B = Number((await createProjectSpace(db, { name: "Resource Shared Bravo", description: "bravo description" })).id);
  HIDDEN = Number((await createProjectSpace(db, { name: "Resource Hidden Charlie", description: "charlie description" })).id);

  BOT_HOME = await mkBot({ home: A });
  BOT_NOSHARE = await mkBot({ home: A });
  await grant(B, BOT_HOME, "read");

  // Memories in three scopes, one category each, so a count names the scope it came from.
  for (let i = 0; i < 2; i++) await seedMemory(`home memory ${i}`, A, CAT_HOME);
  for (let i = 0; i < 3; i++) await seedMemory(`shared memory ${i}`, B, CAT_SHARED);
  await seedMemory("loose memory", null, CAT_LOOSE);

  // One project-scoped crow.md override per project: the resource must merge the bot's home one.
  await db.execute({
    sql: "INSERT INTO crow_context (section_key, section_title, content, sort_order, project_id) VALUES ('share_resource_probe', 'Probe', 'home project marker', 95, ?)",
    args: [A],
  });
  await db.execute({
    sql: "INSERT INTO crow_context (section_key, section_title, content, sort_order, project_id) VALUES ('share_resource_probe', 'Probe', 'shared project marker', 95, ?)",
    args: [B],
  });
});

after(async () => {
  try { db && db.close && db.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

// --- harness ---------------------------------------------------------------------------------

/** A memory server wired to an in-process client, as the gateway and the stdio server wire it. */
async function openMemory(actor) {
  const server = createMemoryServer(DB_FILE, { actor });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "share-resources-memory", version: "0" });
  await client.connect(clientTransport);
  return wrap(client, server);
}

/** A research (projects) server on the same wiring. */
async function openProject(actor) {
  const server = createProjectServer(DB_FILE, { actor });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "share-resources-project", version: "0" });
  await client.connect(clientTransport);
  return wrap(client, server);
}

function wrap(client, server) {
  return {
    client,
    async call(name, args = {}) {
      const r = await client.callTool({ name, arguments: args });
      const text = (r.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
      return { text, isError: !!r.isError };
    },
    /** Read a resource, optionally carrying a per-call actor in `_meta`, as a tool call does. */
    async read(uri, meta) {
      const params = meta ? { uri, _meta: meta } : { uri };
      const r = await client.readResource(params);
      return (r.contents || []).filter((c) => typeof c.text === "string").map((c) => c.text).join("\n");
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

let botSeq = 0;
async function mkBot({ home = null } = {}) {
  botSeq += 1;
  const botId = `resource-share-bot-${botSeq}`;
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

async function seedMemory(content, projectId, category) {
  const r = await db.execute({
    sql: "INSERT INTO memories (content, category, importance, project_id) VALUES (?, ?, 5, ?)",
    args: [content, category, projectId == null ? null : Number(projectId)],
  });
  return Number(r.lastInsertRowid);
}

let contactSeq = 0;
/** A project member whose contact is not the local owner: an outside member. */
async function addOutsideMember(projectId) {
  contactSeq += 1;
  const contact = await db.execute({
    sql: "INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey, origin) VALUES (?,?,?,?, 'remote')",
    args: [`resource-peer-${contactSeq}`.padEnd(16, "0"), `Peer ${contactSeq}`, `${contactSeq}`.padEnd(64, "a"), `${contactSeq}`.padEnd(64, "b")],
  });
  await db.execute({
    sql: "INSERT INTO project_members (project_id, contact_id, role, mode) VALUES (?,?, 'viewer', 'live')",
    args: [Number(projectId), Number(contact.lastInsertRowid)],
  });
}

// --- the two project-neutral tools -----------------------------------------------------------

test("crow_web_search: a normal bot answers exactly like the owner, an unverified bot is refused", async () => {
  const owner = await openProject(OWNER);
  const bot = await openProject({ kind: "bot", id: BOT_HOME });
  const unverified = await openProject(UNVERIFIED);
  try {
    const mine = await owner.call("crow_web_search", { query: "crow project shares" });
    assert.equal(mine.isError, false, mine.text);
    assert.match(mine.text, /not configured/);

    const theirs = await bot.call("crow_web_search", { query: "crow project shares" });
    assert.equal(theirs.isError, false, theirs.text);
    assert.equal(theirs.text, mine.text, "a project-neutral tool answers a normal bot as it does the owner");

    const refused = await unverified.call("crow_web_search", { query: "crow project shares" });
    assert.equal(refused.isError, true);
    assert.equal(refused.text, "Error: That tool is for the operator only.");
  } finally { await owner.close(); await bot.close(); await unverified.close(); }
});

test("crow_create_notification: a normal bot's notification is stored, an unverified bot's is not", async () => {
  const bot = await openMemory({ kind: "bot", id: BOT_HOME });
  const unverified = await openMemory(UNVERIFIED);
  const sent = "Resource share notice";
  const refused = "Resource share notice refused";
  try {
    const r = await bot.call("crow_create_notification", { title: sent, body: "a bot's own note to the operator" });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /Notification created/);
    assert.equal(await count("SELECT COUNT(*) AS n FROM notifications WHERE title = ?", [sent]), 1);

    const no = await unverified.call("crow_create_notification", { title: refused, body: "planted" });
    assert.equal(no.isError, true);
    assert.equal(no.text, "Error: That tool is for the operator only.");
    assert.equal(await count("SELECT COUNT(*) AS n FROM notifications WHERE title = ?", [refused]), 0,
      "an unverified bot leaves no notification behind");
  } finally { await bot.close(); await unverified.close(); }
});

// --- crow://context --------------------------------------------------------------------------

test("crow://context: the owner, unknown and voice keep the dynamic block; a bot reads its home merge without it", async () => {
  const owner = await openMemory(OWNER);
  const unknown = await openMemory(UNKNOWN);
  const voice = await openMemory(S.operatorVoiceActor());
  const bot = await openMemory({ kind: "bot", id: BOT_HOME });
  const unverified = await openMemory(UNVERIFIED);
  try {
    const full = await generateCrowContext(db, { includeDynamic: true, platform: "generic" });
    assert.match(full, /\(Dynamic\)/);
    assert.equal(await owner.read("crow://context"), full);
    assert.equal(await unknown.read("crow://context"), full, "an unidentified caller is unchanged");
    assert.equal(await voice.read("crow://context"), full, "the operator's voice bot is unchanged");

    const botText = await bot.read("crow://context");
    assert.equal(botText, await generateCrowContext(db, { includeDynamic: false, platform: "generic", projectId: A }));
    assert.doesNotMatch(botText, /\(Dynamic\)/, "a bot's context carries no dynamic block");
    assert.match(botText, /home project marker/, "the home project's override is merged");
    assert.doesNotMatch(botText, /shared project marker/, "a shared project's override is not");

    assert.equal(await unverified.read("crow://context"), "");
  } finally { await owner.close(); await unknown.close(); await voice.close(); await bot.close(); await unverified.close(); }
});

test("crow://context resolves a bot from the per-call actor a resource read carries", async () => {
  const s = await openMemory(UNKNOWN);
  try {
    const botText = await s.read("crow://context", { "crow/actor": { kind: "bot", id: BOT_HOME } });
    assert.equal(botText, await generateCrowContext(db, { includeDynamic: false, platform: "generic", projectId: A }));
    assert.doesNotMatch(botText, /\(Dynamic\)/);
  } finally { await s.close(); }
});

// --- memory://categories ---------------------------------------------------------------------

test("memory://categories counts the bot's read scope only", async () => {
  const owner = await openMemory(OWNER);
  const voice = await openMemory(S.operatorVoiceActor());
  const bot = await openMemory({ kind: "bot", id: BOT_HOME });
  const noShare = await openMemory({ kind: "bot", id: BOT_NOSHARE });
  const unverified = await openMemory(UNVERIFIED);
  try {
    const ownerText = await owner.read("memory://categories");
    const all = new Map(JSON.parse(ownerText).map((c) => [c.category, Number(c.count)]));
    assert.equal(all.get(CAT_HOME), 2);
    assert.equal(all.get(CAT_SHARED), 3);
    assert.equal(all.get(CAT_LOOSE), 1, "the owner counts project-less rows too");
    assert.equal(await voice.read("memory://categories"), ownerText, "the voice bot counts like the owner");

    const mine = JSON.parse(await bot.read("memory://categories"));
    assert.deepEqual(mine.map((c) => c.category), [CAT_HOME], "the home project's category only");
    assert.equal(Number(mine[0].count), 2);

    const withoutShare = JSON.parse(await noShare.read("memory://categories"));
    assert.deepEqual(withoutShare, mine, "a read share of B does not widen the counts");

    assert.deepEqual(JSON.parse(await unverified.read("memory://categories")), []);
  } finally {
    await owner.close(); await voice.close(); await bot.close(); await noShare.close(); await unverified.close();
  }
});

// --- projects://list -------------------------------------------------------------------------

test("projects://list: the owner, unknown and voice keep the full rows; a bot gets its home plus live shares, id and name only", async () => {
  const owner = await openProject(OWNER);
  const unknown = await openProject(UNKNOWN);
  const voice = await openProject(S.operatorVoiceActor());
  const bot = await openProject({ kind: "bot", id: BOT_HOME });
  const noShare = await openProject({ kind: "bot", id: BOT_NOSHARE });
  const unverified = await openProject(UNVERIFIED);
  try {
    const ownerText = await owner.read("projects://list");
    const all = JSON.parse(ownerText);
    const ids = all.map((p) => Number(p.id));
    for (const id of [A, B, HIDDEN]) assert.ok(ids.includes(id), `the owner's listing carries project ${id}`);
    assert.ok(all.every((p) => "description" in p && "type" in p && "status" in p),
      "the owner's listing carries the whole rows");
    assert.equal(await unknown.read("projects://list"), ownerText, "an unidentified caller is unchanged");
    assert.equal(await voice.read("projects://list"), ownerText, "the operator's voice bot is unchanged");

    const mine = JSON.parse(await bot.read("projects://list"));
    assert.deepEqual(mine.map((p) => Number(p.id)).sort((x, y) => x - y), [A, B].sort((x, y) => x - y),
      "the home project plus the project with a live share");
    for (const p of mine) assert.deepEqual(Object.keys(p).sort(), ["id", "name"], "id and name only");
    assert.equal(mine.find((p) => Number(p.id) === A).name, "Resource Home Alpha");

    assert.deepEqual(JSON.parse(await noShare.read("projects://list")).map((p) => Number(p.id)), [A],
      "a bot with no share of B never learns B's name");
    assert.deepEqual(JSON.parse(await unverified.read("projects://list")), []);
  } finally {
    await owner.close(); await unknown.close(); await voice.close(); await bot.close(); await noShare.close();
    await unverified.close();
  }
});

test("projects://list leaves out a suspended share", async () => {
  const project = Number((await createProjectSpace(db, { name: "Resource Suspended Delta" })).id);
  const bot = await mkBot({ home: A });
  await grant(project, bot, "read_write");
  const s = await openProject({ kind: "bot", id: bot });
  try {
    const before = JSON.parse(await s.read("projects://list"));
    assert.ok(before.some((p) => Number(p.id) === project), "a live share is listed");

    await addOutsideMember(project);
    const after = JSON.parse(await s.read("projects://list"));
    assert.deepEqual(after.map((p) => Number(p.id)), [A], "a suspended share names no project");
  } finally { await s.close(); }
});