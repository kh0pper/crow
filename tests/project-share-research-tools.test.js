/**
 * Project shares in the research (projects) server: a bot sees its own project and the ones shared
 * with it, nothing else; a read share refuses every write-class tool; an omitted project_id reads
 * the home project only and writes land in it; and a hidden row reads exactly like a missing one.
 *
 * Scratch CROW_HOME + data dir, a real crow.db from scripts/init-db.js. Nothing here touches ~/.crow.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const REPO = join(import.meta.dirname, "..");
const dir = mkdtempSync(join(tmpdir(), "share-research-"));
const DATA = join(dir, "data");
const HOME = join(dir, "home");
mkdirSync(DATA, { recursive: true });
mkdirSync(HOME, { recursive: true });
process.env.HOME = HOME;
process.env.CROW_HOME = join(dir, "crow");
process.env.CROW_DATA_DIR = DATA;
delete process.env.CROW_DB_PATH;
process.env.CROW_TASKS_DB_PATH = join(DATA, "tasks.db");
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";

const DB_FILE = join(DATA, "crow.db");

let db = null;
let createDbClient = null;
let S = null;
let OWNER = null;
let createProjectServer = null;
let createStorageServer = null;
let createProjectSpace = null;
let Client = null;
let InMemoryTransport = null;

// One project the bot is homed in, one project shared with it, and a row in each plus a
// project-less row set.
let A = null;
let B = null;
let srcA = null;
let srcB = null;
let srcLoose = null;
let noteA = null;
let noteB = null;
let noteLoose = null;

const BOT_NO = "share-bot-noaccess";
const BOT_RO = "share-bot-read";
const BOT_RW = "share-bot-write";
const BOT_HOMELESS = "share-bot-homeless";

const sha = (s) => createHash("sha256").update(s).digest("hex");
const PAGE = "The council voted on Tuesday. The budget doubles next year.";
const text = (r) => (r.content || []).map((c) => c.text).join("\n");
const stubPage = (url) => ({
  ok: true, fetch_status: "fetched", final_url: url, http_status: 200, content_type: "text/plain",
  text: PAGE, readable_text: PAGE, truncated: false, sha256: sha(PAGE), fetched_at: new Date().toISOString(),
});

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env }, stdio: "pipe", cwd: REPO });
  ({ createDbClient } = await import("../servers/db.js"));
  db = createDbClient(DB_FILE);
  S = await import("../servers/shared/project-share-scope.js");
  ({ OWNER } = await import("../servers/research/actor.js"));
  ({ createProjectServer } = await import("../servers/research/server.js"));
  ({ createStorageServer } = await import("../servers/storage/server.js"));
  ({ createProjectSpace } = await import("../servers/shared/project-spaces.js"));
  Client = (await import("@modelcontextprotocol/sdk/client/index.js")).Client;
  ({ InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js"));

  // Constructing one server readies the provenance/withdrawal columns this file inserts into.
  createProjectServer(DB_FILE, { actor: OWNER }).close();

  A = Number((await createProjectSpace(db, { name: "Home Alpha", description: "alpha description" })).id);
  B = Number((await createProjectSpace(db, { name: "Shared Bravo", description: "bravo description" })).id);

  const mkSource = async (projectId, title, url) => Number((await db.execute({
    sql: `INSERT INTO research_sources
            (project_id, title, source_type, url, citation_apa, fetch_status, fetched_at, fetched_text, content_sha256)
          VALUES (?, ?, 'web_article', ?, ?, 'fetched', ?, ?, ?)`,
    args: [projectId, title, url, title, new Date().toISOString(), PAGE, sha(PAGE)],
  })).lastInsertRowid);
  srcA = await mkSource(A, "Alpha Source", "https://example.com/alpha");
  srcB = await mkSource(B, "Bravo Source", "https://example.com/bravo");
  srcLoose = await mkSource(null, "Loose Source", "https://example.com/loose");

  const mkNote = async (projectId, content) => Number((await db.execute({
    sql: "INSERT INTO research_notes (project_id, content, note_type, created_by) VALUES (?, ?, 'note', 'owner')",
    args: [projectId, content],
  })).lastInsertRowid);
  noteA = await mkNote(A, "alpha note body");
  noteB = await mkNote(B, "bravo note body");
  noteLoose = await mkNote(null, "loose note body");

  for (const [botId, home, level] of [
    [BOT_NO, A, null], [BOT_RO, A, "read"], [BOT_RW, A, "read_write"], [BOT_HOMELESS, null, null],
  ]) {
    await db.execute({
      sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, project_id, enabled) VALUES (?,?,?,?,1)",
      args: [botId, botId, "{}", home],
    });
    if (level) {
      await db.execute({
        sql: "INSERT INTO project_bot_shares (project_id, bot_id, level) VALUES (?,?,?)",
        args: [B, botId, level],
      });
    }
  }
});

after(async () => {
  try { db && db.close && db.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

async function clientFor(actor, opts = {}) {
  const server = createProjectServer(DB_FILE, { actor, fetchPage: async ({ url }) => stubPage(url), ...opts });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "share-research-test", version: "0" });
  await client.connect(ct);
  return client;
}

const botClient = (botId) => clientFor({ kind: "bot", id: botId });
const call = (client, name, args = {}) => client.callTool({ name, arguments: args });

/** The storage server wired to the same DB, for the audit-oracle probe (B2). */
async function storageClientFor(botId) {
  const server = createStorageServer(DB_FILE, { baseActor: { kind: "bot", id: botId } });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "share-research-storage", version: "0" });
  await client.connect(ct);
  return client;
}

const rowProjectOf = async (table, id) => Number((await db.execute({
  sql: `SELECT project_id FROM ${table} WHERE id = ?`, args: [id],
})).rows[0].project_id);
const refuses = async (r) => {
  assert.equal(r.isError, true, text(r));
  assert.match(text(r), /^Error: /, text(r));
  return text(r);
};

// --- no share -------------------------------------------------------------------------------

test("a bot with no share is refused on a project it does not hold, without naming it", async () => {
  const bot = await botClient(BOT_NO);

  const add = await refuses(await call(bot, "crow_add_source", {
    title: "Intruder", source_type: "web_article", project_id: B,
  }));
  assert.match(add, /No share grants this bot access to that project/);
  assert.ok(!add.includes("Shared Bravo"), add);

  const search = await refuses(await call(bot, "crow_search_notes", { query: "bravo", project_id: B }));
  assert.match(search, /No share grants this bot access to that project/);
  assert.ok(!search.includes("Shared Bravo"), search);

  const rows = (await db.execute({
    sql: "SELECT action, target, payload, actor_type, actor_id FROM project_audit_log WHERE project_id = ? AND action = 'share.refused'",
    args: [B],
  })).rows;
  assert.ok(rows.some((r) => r.target === "tool:crow_add_source" && r.actor_type === "bot" && r.actor_id === BOT_NO),
    JSON.stringify(rows));
});

// --- read share -----------------------------------------------------------------------------

test("a read share allows reading the shared project and refuses every write-class tool", async () => {
  const bot = await botClient(BOT_RO);

  const found = await call(bot, "crow_search_sources", { query: "source", project_id: B });
  assert.ok(!found.isError, text(found));
  assert.ok(text(found).includes("Bravo Source"), text(found));
  assert.ok(!text(found).includes("Alpha Source"), text(found));
  assert.ok(!text(found).includes("Loose Source"), text(found));

  const get = await call(bot, "crow_get_source", { id: srcB });
  assert.ok(!get.isError, text(get));
  assert.ok(text(get).includes("Bravo Source"), text(get));

  for (const [name, args] of [
    ["crow_add_source", { title: "Nope", source_type: "web_article", project_id: B }],
    ["crow_add_note", { content: "nope", project_id: B }],
  ]) {
    const refused = await refuses(await call(bot, name, args));
    assert.match(refused, /read-only/, `${name}: ${refused}`);
  }
  // The by-id writes are refused for the same reason (code read_only in the audit log), and their
  // text stays the missing-row text, because a by-id answer may never say whether the row is real.
  for (const name of ["crow_fetch_source", "crow_verify_source"]) {
    const r = await call(bot, name, { id: srcB });
    assert.equal(r.isError, true, `${name}: ${text(r)}`);
    assert.equal(text(r), "Error: Not found.", name);
    const audited = (await db.execute({
      sql: "SELECT payload FROM project_audit_log WHERE project_id = ? AND actor_id = ? AND action = 'share.refused' AND target = ?",
      args: [B, BOT_RO, `tool:${name}`],
    })).rows;
    assert.deepEqual(audited.map((r) => JSON.parse(r.payload)), [{ code: "read_only" }], name);
  }
});

// --- read_write share -----------------------------------------------------------------------

test("a read_write share lands a note in the shared project, audited as the bot", async () => {
  const bot = await botClient(BOT_RW);
  const r = await call(bot, "crow_add_note", { content: "bravo shared note", project_id: B });
  assert.ok(!r.isError, text(r));
  const noteId = Number(text(r).match(/Note added \(id: (\d+)/)[1]);
  assert.equal(await rowProjectOf("research_notes", noteId), B);

  const audit = (await db.execute({
    sql: "SELECT actor_type, actor_id FROM project_audit_log WHERE project_id = ? AND action = 'note.add' AND target = ?",
    args: [B, `note:${noteId}`],
  })).rows;
  assert.equal(audit.length, 1, "one audit row on the shared project");
  assert.equal(audit[0].actor_type, "bot");
  assert.equal(audit[0].actor_id, BOT_RW);
});

test("a write with no project_id lands in the bot's home project", async () => {
  const bot = await botClient(BOT_RW);
  const r = await call(bot, "crow_add_source", { title: "Homebound Source", source_type: "web_article" });
  assert.ok(!r.isError, text(r));
  const id = Number(text(r).match(/Source added \(id: (\d+)/)[1]);
  assert.equal(await rowProjectOf("research_sources", id), A);
});

// --- reads with no project_id ---------------------------------------------------------------

test("a bot's reads with no project_id cover the home project only: no other project, no project-less row", async () => {
  const bot = await botClient(BOT_RO); // holds a read share of B: it must NOT widen the read

  const search = await call(bot, "crow_search_sources", { query: "source" });
  assert.ok(!search.isError, text(search));
  assert.ok(text(search).includes("Alpha Source"), text(search));
  assert.ok(!text(search).includes("Bravo Source"), text(search));
  assert.ok(!text(search).includes("Loose Source"), text(search));

  const list = await call(bot, "crow_list_sources", {});
  assert.ok(!list.isError, text(list));
  assert.ok(text(list).includes("Alpha Source"), text(list));
  assert.ok(!text(list).includes("Bravo Source"), text(list));
  assert.ok(!text(list).includes("Loose Source"), text(list));

  const notes = await call(bot, "crow_search_notes", { query: "note body" });
  assert.ok(!notes.isError, text(notes));
  assert.ok(text(notes).includes("alpha note body"), text(notes));
  assert.ok(!text(notes).includes("bravo note body"), text(notes));
  assert.ok(!text(notes).includes("loose note body"), text(notes));

  const bib = await call(bot, "crow_generate_bibliography", { include_unfetched: true });
  assert.ok(!bib.isError, text(bib));
  assert.ok(text(bib).includes("Alpha Source"), text(bib));
  assert.ok(!text(bib).includes("Bravo Source"), text(bib));
  assert.ok(!text(bib).includes("Loose Source"), text(bib));
});

test("a bot with no home project reads nothing and cannot write without naming a project", async () => {
  const bot = await botClient(BOT_HOMELESS);

  const search = await call(bot, "crow_search_sources", { query: "source" });
  assert.ok(!search.isError, text(search));
  assert.match(text(search), /No sources found/);

  const list = await call(bot, "crow_list_sources", {});
  assert.match(text(list), /No sources found/);

  const notes = await call(bot, "crow_search_notes", { query: "note body" });
  assert.match(text(notes), /No notes found/);

  const add = await call(bot, "crow_add_note", { content: "homeless write" });
  assert.equal(add.isError, true);
  assert.equal(text(add), `Error: ${S.NAME_A_PROJECT_MESSAGE}`);
});

// --- by-id rows -----------------------------------------------------------------------------

test("a hidden source reads exactly like a missing one; a read share makes it visible", async () => {
  const bot = await botClient(BOT_NO);
  const hidden = await call(bot, "crow_get_source", { id: srcB });
  const missing = await call(bot, "crow_get_source", { id: 987654321 });
  assert.equal(text(hidden), text(missing));
  assert.equal(hidden.isError, true);
  assert.equal(text(hidden), "Error: Not found.");
  assert.ok(!text(hidden).includes("Bravo Source"));

  const read = await botClient(BOT_RO);
  const visible = await call(read, "crow_get_source", { id: srcB });
  assert.ok(!visible.isError, text(visible));
  assert.ok(text(visible).includes("Bravo Source"), text(visible));

  // A project-less row is owner-only, so a bot reads it as missing too.
  const loose = await call(read, "crow_get_source", { id: srcLoose });
  assert.equal(text(loose), text(missing));
  assert.ok(!text(loose).includes("Loose Source"));
});

test("withdrawing a note on a read-shared project is refused like a missing note", async () => {
  const bot = await botClient(BOT_RO);
  const refused = await call(bot, "crow_withdraw_note", { id: noteB, reason: "nope" });
  assert.equal(refused.isError, true);
  assert.equal(text(refused), "Error: Not found.");
  const missing = await call(bot, "crow_withdraw_note", { id: 987654321, reason: "nope" });
  assert.equal(text(refused), text(missing));

  const still = (await db.execute({ sql: "SELECT withdrawn_at FROM research_notes WHERE id = ?", args: [noteB] })).rows[0];
  assert.equal(still.withdrawn_at, null, "the note is untouched");
});

test("a note on a source from an unreachable project is not found, not 'a different project'", async () => {
  const bot = await botClient(BOT_NO);
  const r = await call(bot, "crow_add_note", { content: "cross project", source_id: srcB });
  assert.equal(r.isError, true);
  assert.equal(text(r), "Error: Not found.");
  assert.ok(!text(r).includes("different project"), text(r));
});

// --- project tools outside the four families ------------------------------------------------

test("crow_workspace_dir follows the share level and crow_project_get is home-only", async () => {
  const ro = await botClient(BOT_RO);
  const shared = await call(ro, "crow_workspace_dir", { project_id: B });
  assert.ok(!shared.isError, text(shared));
  assert.match(text(shared), new RegExp(`Project #${B} \\(`), text(shared));

  const no = await botClient(BOT_NO);
  const refused = await refuses(await call(no, "crow_workspace_dir", { project_id: B }));
  assert.match(refused, /No share grants this bot access/);
  assert.ok(!refused.includes("Shared Bravo"), refused);

  const rw = await botClient(BOT_RW);
  const details = await refuses(await call(rw, "crow_project_get", { project_id: B }));
  assert.match(details, /own project only/);
  assert.ok(!details.includes("Shared Bravo"), details);
});

test("member tools are refused on a project shared read_write: a share buys no member list", async () => {
  const bot = await botClient(BOT_RW);
  for (const [name, args] of [
    ["crow_list_members", { project_id: B }],
    ["crow_add_member", { project_id: B, role: "viewer" }],
  ]) {
    const refused = await refuses(await call(bot, name, args));
    assert.match(refused, /own project only/, `${name}: ${refused}`);
    assert.ok(!refused.includes("Shared Bravo"), refused);
  }
  // The same tools work on the bot's own project.
  const own = await call(bot, "crow_list_members", { project_id: A });
  assert.ok(!own.isError, text(own));
});

// --- listings -------------------------------------------------------------------------------

test("crow_list_projects shows a bot its home only, then home plus a shared project's name and level", async () => {
  const no = await clientFor({ kind: "bot", id: BOT_NO });
  const noText = text(await call(no, "crow_list_projects", {}));
  assert.ok(noText.includes("Home Alpha"), noText);
  assert.ok(!noText.includes("Shared Bravo"), noText);
  assert.ok(!noText.includes("alpha description"), "a bot's listing carries no description");

  const ro = await clientFor({ kind: "bot", id: BOT_RO });
  const roText = text(await call(ro, "crow_list_projects", {}));
  assert.ok(roText.includes("Home Alpha"), roText);
  assert.ok(roText.includes("Shared Bravo"), roText);
  assert.ok(!roText.includes("bravo description"), roText);
  const bravoLine = roText.split("\n").find((l) => l.includes("Shared Bravo"));
  assert.match(bravoLine, /\(read\)$/, bravoLine);

  const rw = await clientFor({ kind: "bot", id: BOT_RW });
  const rwText = text(await call(rw, "crow_list_projects", {}));
  const bravoRwLine = rwText.split("\n").find((l) => l.includes("Shared Bravo"));
  assert.match(bravoRwLine, /\(read and write\)$/, bravoRwLine);
});

test("crow_project_stats counts the bot's home project only", async () => {
  const bot = await clientFor({ kind: "bot", id: BOT_RW });
  const homeSources = Number((await db.execute({
    sql: "SELECT COUNT(*) AS n FROM research_sources WHERE project_id = ?", args: [A],
  })).rows[0].n);
  const homeNotes = Number((await db.execute({
    sql: "SELECT COUNT(*) AS n FROM research_notes WHERE project_id = ?", args: [A],
  })).rows[0].n);
  const st = text(await call(bot, "crow_project_stats", {}));
  assert.match(st, new RegExp(`Projects: 1\\b`), st);
  assert.match(st, new RegExp(`Sources: ${homeSources} \\(`), st);
  assert.match(st, new RegExp(`Notes: ${homeNotes}\\b`), st);

  const owner = await clientFor(OWNER);
  const ownerText = text(await call(owner, "crow_project_stats", {}));
  assert.ok(Number(ownerText.match(/Sources: (\d+)/)[1]) > homeSources, "the owner still sees every project");
});

test("crow_create_project is refused for a bot", async () => {
  const bot = await botClient(BOT_NO);
  const refused = await refuses(await call(bot, "crow_create_project", { name: "Bot project" }));
  assert.match(refused, /operator only/);
  const made = (await db.execute({ sql: "SELECT COUNT(*) AS n FROM project_spaces WHERE name = 'Bot project'", args: [] })).rows[0];
  assert.equal(Number(made.n), 0);
});

// --- the audit log is not an oracle (B2) -----------------------------------------------------

test("crow_audit_log cannot tell a bot whether a hidden storage key exists (B2)", async () => {
  const home = Number((await createProjectSpace(db, { name: "Audit Probe Home" })).id);
  const hidden = Number((await createProjectSpace(db, { name: "Audit Probe Hidden" })).id);
  const botId = "share-bot-audit-probe";
  await db.execute({
    sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, project_id, enabled) VALUES (?,?,?,?,1)",
    args: [botId, botId, "{}", home],
  });
  const hiddenKey = `audit-oracle-hidden-${home}.txt`;
  await db.execute({
    sql: `INSERT INTO storage_files (s3_key, original_name, mime_type, size_bytes, bucket, project_id)
          VALUES (?, ?, 'text/plain', 1, 'crow-files', ?)`,
    args: [hiddenKey, hiddenKey, hidden],
  });

  const bot = await botClient(botId);
  const storage = await storageClientFor(botId);

  const baseline = text(await call(bot, "crow_audit_log", { project_id: home, limit: 200 }));

  // A key that does not exist anywhere: the refusal is recorded on the bot's HOME project.
  const missing = await call(storage, "crow_get_file_url", { s3_key: `audit-oracle-missing-${home}.txt` });
  assert.equal(missing.isError, true, text(missing));
  const afterMissing = text(await call(bot, "crow_audit_log", { project_id: home, limit: 200 }));

  // A key that exists in a project the bot holds no share of: the refusal is recorded THERE.
  const existing = await call(storage, "crow_get_file_url", { s3_key: hiddenKey });
  assert.equal(existing.isError, true, text(existing));
  assert.equal(text(existing), text(missing), "the two probes answer identically");
  const afterHidden = text(await call(bot, "crow_audit_log", { project_id: home, limit: 200 }));

  assert.equal(afterHidden, afterMissing, "the home log reads the same after either probe");
  assert.equal(afterMissing, baseline, "a refusal adds nothing the bot can read");
  assert.doesNotMatch(afterMissing, /share\.refused/);

  // Both refusals ARE in the table: the filter is what keeps the bot from reading them.
  const logged = (await db.execute({
    sql: `SELECT project_id FROM project_audit_log
           WHERE action = 'share.refused' AND target = 'tool:crow_get_file_url' AND project_id IN (?, ?)`,
    args: [home, hidden],
  })).rows.map((r) => Number(r.project_id));
  assert.ok(logged.includes(home), "the project-less probe is logged on the home project: " + JSON.stringify(logged));
  assert.ok(logged.includes(hidden), "the hidden-key probe is logged on the hidden project: " + JSON.stringify(logged));

  // The owner's view is unchanged: share.refused rows are still there.
  const owner = await clientFor(OWNER);
  const ownerHome = text(await call(owner, "crow_audit_log", { project_id: home, limit: 200 }));
  assert.match(ownerHome, /share\.refused/);
  const ownerHidden = text(await call(owner, "crow_audit_log", { project_id: hidden, limit: 200 }));
  assert.match(ownerHidden, /share\.refused/);

  // The operator's voice bot is the operator here too, byte for byte.
  const voice = await clientFor(S.operatorVoiceActor());
  assert.equal(text(await call(voice, "crow_audit_log", { project_id: home, limit: 200 })), ownerHome);
});

// --- the operator's voice bot ---------------------------------------------------------------

test("a server built with the operator-voice actor lists exactly what the owner's does", async () => {
  const owner = await clientFor(OWNER);
  const voice = await clientFor(S.operatorVoiceActor());

  const ownerList = text(await call(owner, "crow_list_projects", {}));
  const voiceList = text(await call(voice, "crow_list_projects", {}));
  assert.equal(voiceList, ownerList);
  assert.ok(voiceList.includes("Shared Bravo"), voiceList);

  const ownerStats = text(await call(owner, "crow_project_stats", {}));
  const voiceStats = text(await call(voice, "crow_project_stats", {}));
  assert.equal(voiceStats, ownerStats);
});

// --- the owner is unchanged -----------------------------------------------------------------

test("an owner server still behaves as before", async () => {
  const owner = await clientFor(OWNER);

  const search = await call(owner, "crow_search_sources", { query: "source" });
  assert.ok(!search.isError, text(search));
  for (const title of ["Alpha Source", "Bravo Source", "Loose Source"]) {
    assert.ok(text(search).includes(title), `${title} in ${text(search)}`);
  }

  const loose = await call(owner, "crow_get_source", { id: srcLoose });
  assert.ok(!loose.isError, text(loose));
  assert.ok(text(loose).includes("Loose Source"), text(loose));

  const looseNotes = await call(owner, "crow_search_notes", { query: "loose note body" });
  assert.ok(text(looseNotes).includes("loose note body"), text(looseNotes));

  const created = await call(owner, "crow_create_project", { name: "Owner project" });
  assert.ok(!created.isError, text(created));
  assert.match(text(created), /Project created/);

  const fetch = await call(owner, "crow_fetch_source", { id: srcLoose });
  assert.ok(!fetch.isError, text(fetch));

  const withdrawLoose = await call(owner, "crow_withdraw_note", { id: noteLoose, reason: "owner can" });
  assert.ok(!withdrawLoose.isError, text(withdrawLoose));

  const withdrawA = await call(owner, "crow_withdraw_note", { id: noteA, reason: "owner can" });
  assert.ok(!withdrawA.isError, text(withdrawA));
});