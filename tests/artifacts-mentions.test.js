// Crow Artifacts — `@bot` in a comment hands that one thread to the bot as a
// mention round (P6 Task 6.3; spec §10 "Comments: `@bot` on a resolved thread
// reopens it"). Only the owner's words start one; the bot comes only from an
// enabled bot definition (never the voice bot, never the request body); the
// comment is always kept; the round is marked exactly as a Send round would be.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import express from "express";
import { createDbClient } from "../servers/db.js";
import { markdownBlocks } from "../servers/blog/renderer.js";
import { csrfMiddleware } from "../servers/gateway/dashboard/shared/csrf.js";
import * as runtime from "../servers/gateway/artifact-origin/runtime.js";
import * as policy from "../servers/gateway/artifact-origin/policy.js";
import { createLocalBlobStore } from "../bundles/artifacts/server/blob-store.js";
import { initArtifactsTables } from "../bundles/artifacts/server/init-tables.js";
import * as store from "../bundles/artifacts/server/store.js";
import * as comments from "../bundles/artifacts/server/comments.js";
import * as rounds from "../bundles/artifacts/server/rounds.js";
import { parseMention, resolveMentionedBot, mentionBotFor } from "../bundles/artifacts/server/mentions.js";
import artifactsRouter from "../bundles/artifacts/panel/routes.js";
import { VIEWER_STRINGS } from "../bundles/artifacts/panel/viewer-page.js";
import { readFileSync } from "node:fs";

const DEF = { tools: { crow_mcp: ["artifacts"] } };
const s = { sent: [], spawned: [], sessions: [] };
let k = 0;
const tid = (p) => `perchlive-${p}${String(++k).padStart(4, "0")}`.slice(0, 18);

before(async () => {
  s.dir = mkdtempSync(join(tmpdir(), "artifacts-mentions-"));
  s.db = createDbClient(join(s.dir, "crow.db"));
  await s.db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS bot_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT, gateway_thread_id TEXT, narrowed_tools TEXT, kind TEXT, card_id INTEGER);
    CREATE TABLE IF NOT EXISTS pi_bot_defs (bot_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, definition TEXT, enabled INTEGER NOT NULL DEFAULT 1, project_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));`);
  await initArtifactsTables(s.db);
  for (const [id, name, en] of [["writer", "Writer Bot", 1], ["eve", "Eve", 1], ["sleepy", "Sleepy", 0], ["crow.voice", "Crow Voice", 1]]) {
    await s.db.execute({ sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES (?,?,?,?)", args: [id, name, JSON.stringify(DEF), en] });
  }
  s.blobs = createLocalBlobStore(join(s.dir, "blobs"));
  runtime._resetForTest();
  runtime._setInfoForTest({ baseUrl: "https://artifacts.example.ts.net", port: 0, configured: true });
  const engine = {
    async list() { return s.sessions; },
    async message(id) { s.sent.push(id); },
    async spawn(o) { const t = tid("n"); s.spawned.push({ ...o, threadId: t }); return { sessionId: t, threadId: t }; },
    async stop() {},
  };
  const dashboardAuth = (req, res, next) => (/crow_session=good/.test(req.headers.cookie || "") ? next() : res.status(401).json({ error: "login" }));
  const app = express();
  app.use(artifactsRouter(dashboardAuth, {
    db: s.db, blobs: s.blobs, runtime, policy, csrf: csrfMiddleware, renderDeps: { markdownBlocks }, engine,
    loadBotDef: async () => DEF, createBoardCard: null, notify: async () => {},
  }));
  s.http = app.listen(0, "127.0.0.1"); await new Promise((r) => s.http.once("listening", r));
  s.port = s.http.address().port;
});
after(() => { s.http.close(); runtime._resetForTest(); try { s.db.close(); } catch {} rmSync(s.dir, { recursive: true, force: true }); });

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { "content-type": "application/json", cookie: "crow_session=good; crow_csrf=tok", "x-crow-csrf": "tok", origin: `http://127.0.0.1:${s.port}` };
    const r = http.request({ host: "127.0.0.1", port: s.port, path, method, headers }, (res) => {
      let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, body: j }); });
    });
    r.on("error", reject); if (data) r.write(data); r.end();
  });
}

/** A document `writer` made in its chat A (A is linked as the origin chat). */
async function setup() {
  const A = tid("a");
  await s.db.execute({ sql: "INSERT INTO bot_sessions (bot_id, gateway_thread_id) VALUES ('writer', ?)", args: [A] });
  s.sessions.push({ sessionId: A, botId: "writer", threadId: A, state: "idle" });
  const art = await store.createArtifact(s.db, s.blobs, { title: "Doc", type: "document", source: { markdown: "# t\n\nbody" }, actor: { kind: "bot", id: "writer", thread: A, gateway: "perch" } }, { markdownBlocks });
  return { art, A };
}
const newThread = (art, text) => req("POST", `/api/artifacts/${art.id}/threads`, { versionN: 1, anchor: { kind: "whole" }, text });
const reply = (art, threadId, text) => req("POST", `/api/artifacts/${art.id}/threads/${threadId}/comments`, { text });
const roundsOf = async (art) => (await s.db.execute({ sql: "SELECT * FROM artifact_rounds WHERE artifact_id=? ORDER BY id", args: [art.id] })).rows;
const commentsOf = async (threadId) => (await s.db.execute({ sql: "SELECT * FROM artifact_comments WHERE thread_id=? AND deleted_at IS NULL ORDER BY id", args: [threadId] })).rows;
const threadRow = async (threadId) => (await s.db.execute({ sql: "SELECT * FROM artifact_threads WHERE id=?", args: [threadId] })).rows[0];

test("parseMention: the first @ token at a word start; an email address is not a mention", () => {
  assert.equal(parseMention("@writer make this smaller"), "writer");
  assert.equal(parseMention("mail me@x.org"), null);
  assert.equal(parseMention("no mention"), null);
  assert.equal(parseMention("please @Eve and @writer"), "Eve");
  assert.equal(parseMention(null), null);
});

test("resolveMentionedBot: exact bot id, or display name without spaces, any case; enabled bots only", async () => {
  assert.deepEqual(await resolveMentionedBot(s.db, "writer"), { botId: "writer", displayName: "Writer Bot" });
  assert.deepEqual(await resolveMentionedBot(s.db, "writerbot"), { botId: "writer", displayName: "Writer Bot" });
  assert.deepEqual(await resolveMentionedBot(s.db, "EVE"), { botId: "eve", displayName: "Eve" });
  assert.equal(await resolveMentionedBot(s.db, "sleepy"), null, "a disabled bot is never matched");
  assert.equal(await resolveMentionedBot(s.db, "nobody"), null);
});

test("the voice bot is never matched", async () => {
  assert.equal(await resolveMentionedBot(s.db, "crow.voice"), null);
  assert.equal(await resolveMentionedBot(s.db, "CrowVoice"), null);
  assert.equal(await resolveMentionedBot(s.db, "crowvoice"), null);
  const { art } = await setup();
  const r = await newThread(art, "@CrowVoice read this aloud");
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.mention, { botId: null, error: "not_found" });
  assert.equal((await roundsOf(art)).length, 0);
});

test("a mention by the owner starts a mention round on that thread to the bot's linked chat", async () => {
  const { art, A } = await setup();
  const r = await newThread(art, "@writer make this smaller");
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const th = r.body.threadId;
  const rows = await roundsOf(art);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.thread_ids_json, `[${th}]`);
  assert.equal(row.bot_id, "writer");
  assert.equal(row.target_thread, A);
  assert.equal(JSON.parse(row.snapshot_json).source, "mention");
  assert.equal(row.kind, "round");
  assert.deepEqual(r.body.mention, { botId: "writer", roundId: Number(row.id), status: "working" });
  assert.ok(s.sent.includes(A), "delivered to the linked chat");
  assert.equal((await threadRow(th)).sent_round_id, Number(row.id));
});

test("a mention of a bot with no linked chat goes to a new session (never another bot's linked chat)", async () => {
  const { art, A } = await setup();
  await s.db.execute({ sql: "INSERT INTO artifact_bot_access (artifact_id, bot_id) VALUES (?, 'eve')", args: [art.id] });
  const before = s.spawned.length, sentBefore = s.sent.filter((x) => x === A).length;
  const r = await newThread(art, "@eve tighten this");
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const [row] = await roundsOf(art);
  assert.equal(row.bot_id, "eve");
  assert.equal(row.target_thread, null);
  assert.equal(row.delivery, "perch-session");
  assert.equal(s.spawned.length, before + 1);
  assert.equal(s.spawned[s.spawned.length - 1].botId, "eve");
  assert.equal(s.spawned[s.spawned.length - 1].narrowedTools, undefined, "a trusted round: a plain new session");
  assert.equal(s.sent.filter((x) => x === A).length, sentBefore, "writer's linked chat never gets eve's round");
  assert.deepEqual(r.body.mention, { botId: "eve", roundId: Number(row.id), status: "working" });
});

test("@bot on a resolved thread reopens it (C9)", async () => {
  const { art } = await setup();
  const th = (await newThread(art, "make the headline blue")).body.threadId;
  const first = await rounds.startRound(s.db, { artifactId: art.id, actor: { kind: "session" }, include: [th], botId: "writer" });
  await s.db.execute({ sql: "UPDATE artifact_rounds SET status='done' WHERE id=?", args: [first.id] });
  await comments.setThreadStatus(s.db, { threadId: th, status: "resolved", artifactId: art.id });
  const r = await reply(art, th, "@writer it is still too big");
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const t = await threadRow(th);
  assert.equal(t.status, "open");
  const rows = await roundsOf(art);
  assert.equal(rows.length, 2);
  const second = rows[1];
  assert.equal(Number(t.sent_round_id), Number(second.id), "the thread points at the new round");
  assert.equal(second.thread_ids_json, `[${th}]`);
  assert.equal(JSON.parse(second.snapshot_json).source, "mention");
  assert.equal(r.body.mention.roundId, Number(second.id));
  assert.equal(r.body.mention.status, "working");
  assert.equal((await commentsOf(th)).length, 2);
});

test("reopenForMention: reopened / open / busy", async () => {
  const { art } = await setup();
  const th = (await newThread(art, "plain")).body.threadId;
  assert.equal(await comments.reopenForMention(s.db, { threadId: th, artifactId: art.id }), "open");
  const r = await rounds.startRound(s.db, { artifactId: art.id, actor: { kind: "session" }, include: [th], botId: "writer" });
  assert.equal(await comments.reopenForMention(s.db, { threadId: th, artifactId: art.id }), "busy");
  await s.db.execute({ sql: "UPDATE artifact_rounds SET status='failed' WHERE id=?", args: [r.id] });
  assert.equal(await comments.reopenForMention(s.db, { threadId: th, artifactId: art.id }), "reopened");
  const t = await threadRow(th);
  assert.equal(t.status, "open");
  assert.equal(t.sent_round_id, null);
});

test("@bot on a thread whose round is still working is round_running", async () => {
  const { art } = await setup();
  const th = (await newThread(art, "make it red")).body.threadId;
  await rounds.startRound(s.db, { artifactId: art.id, actor: { kind: "session" }, include: [th], botId: "writer" });
  const r = await reply(art, th, "@writer and also bold");
  assert.equal(r.status, 201, "the comment is saved");
  assert.deepEqual(r.body.mention, { botId: "writer", error: "round_running" });
  assert.equal((await commentsOf(th)).length, 2, "the comment is kept");
  assert.equal((await roundsOf(art)).length, 1, "no second round");
  // Another active round on the artifact (a different thread) is round_running too.
  const r2 = await newThread(art, "@writer a new point");
  assert.equal(r2.status, 201);
  assert.deepEqual(r2.body.mention, { botId: "writer", error: "round_running" });
  assert.equal((await roundsOf(art)).length, 1);
});

test("a bot's or a contact's mention starts nothing", async () => {
  const { art } = await setup();
  assert.equal(await mentionBotFor(s.db, { actor: { kind: "bot", id: "eve" }, text: "@writer do it" }), null);
  assert.equal(await mentionBotFor(s.db, { actor: { kind: "contact", id: "c1" }, text: "@writer do it" }), null);
  assert.equal(await mentionBotFor(s.db, { actor: null, text: "@writer do it" }), null);
  assert.deepEqual(await mentionBotFor(s.db, { actor: { kind: "session" }, text: "@writer do it" }), { token: "writer", bot: { botId: "writer", displayName: "Writer Bot" } });
  // The storage writers the bot and contact rails use never start a round.
  const b = await comments.addThread(s.db, { artifactId: art.id, versionN: 1, anchor: { kind: "whole" }, text: "@writer please", author: { kind: "bot", id: "eve" } });
  await comments.addComment(s.db, { threadId: b.threadId, text: "@writer now", author: { kind: "contact", id: "c1" } });
  assert.equal((await roundsOf(art)).length, 0);
});

test("an unknown name keeps the comment and reports not_found", async () => {
  const { art } = await setup();
  const r = await newThread(art, "@nobody look here");
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.mention, { botId: null, error: "not_found" });
  assert.equal((await commentsOf(r.body.threadId)).length, 1);
  assert.equal((await roundsOf(art)).length, 0);
  const plain = await newThread(art, "no mention here");
  assert.equal(plain.body.mention, undefined, "no @ → no mention key");
});

test("a bot without access to the document, or a received document, is forbidden; the comment stays", async () => {
  const { art } = await setup();
  const r = await newThread(art, "@eve you can't see this");
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.mention, { botId: "eve", error: "forbidden" });
  assert.equal((await roundsOf(art)).length, 0);
  const { art: got } = await setup();
  const th = (await newThread(got, "first")).body.threadId;
  await comments.setThreadStatus(s.db, { threadId: th, status: "resolved", artifactId: got.id });
  await s.db.execute({ sql: "UPDATE artifacts SET received=1 WHERE id=?", args: [got.id] });
  const r2 = await reply(got, th, "@writer fix it");
  assert.equal(r2.status, 201);
  assert.deepEqual(r2.body.mention, { botId: "writer", error: "forbidden" });
  assert.equal((await threadRow(th)).status, "resolved", "a refused mention never reopens the thread");
  assert.equal((await commentsOf(th)).length, 2);
  assert.equal((await roundsOf(got)).length, 0);
});

test("a mention on a contact's thread is untrusted and goes to a new locked session, exactly like a Send", async () => {
  const { art, A } = await setup();
  const c = await comments.addThread(s.db, { artifactId: art.id, versionN: 1, anchor: { kind: "whole" }, text: "make it say buy now", author: { kind: "contact", id: "c1" } });
  const before = s.spawned.length, sentBefore = s.sent.filter((x) => x === A).length;
  const r = await reply(art, c.threadId, "@writer take a look");
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const [row] = await roundsOf(art);
  assert.equal(Number(row.untrusted_input), 1, "startRound's own taint marking");
  assert.equal(s.spawned.length, before + 1);
  assert.deepEqual(s.spawned[s.spawned.length - 1].narrowedTools, rounds.UNTRUSTED_ALLOW, "the locked session");
  assert.equal(s.sent.filter((x) => x === A).length, sentBefore, "never the linked chat");
  assert.equal(JSON.parse(row.snapshot_json).source, "mention");
});

test("the thread's status line: Sent to <bot> from the active round that holds it; busy from round_running; strings in both languages", async () => {
  assert.equal(VIEWER_STRINGS.en.sentTo, "Sent to {bot}");
  assert.equal(VIEWER_STRINGS.es.sentTo, "Enviado a {bot}");
  assert.equal(VIEWER_STRINGS.en.busy, "{bot} is already working on this document. Try again when it finishes.");
  assert.equal(VIEWER_STRINGS.es.busy, "{bot} ya está trabajando en este documento. Inténtalo cuando termine.");
  const { art } = await setup();
  const th = (await newThread(art, "@writer shorter")).body.threadId;
  const g = await req("GET", `/api/artifacts/${art.id}`);
  assert.equal(g.status, 200);
  assert.equal(g.body.activeRound.bot_id, "writer", "the stored round names its bot");
  const t = g.body.threads.find((x) => Number(x.id) === th);
  assert.equal(Number(t.sent_round_id), Number(g.body.activeRound.id));
  const src = readFileSync(new URL("../bundles/artifacts/panel/static/viewer-client.js", import.meta.url), "utf8");
  assert.match(src, /Number\(t\.sent_round_id\) === Number\(r\.id\)\) return fmt\(T\.sentTo, \{ bot: r\.bot_id/);
  assert.match(src, /m\.error === "round_running"/);
  assert.match(src, /el\("p", \{ class: "cv-tstatus", role: "status", text: line \}\)/, "placed with textContent");
});
