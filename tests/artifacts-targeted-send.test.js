// Crow Artifacts — Send targets one chat (spec v1.6 D25; plan PR-3 Task 3.3,
// review M4 + round-2 B7/B8, D23 delivery). Every perch-session round is
// TARGETED: the verified chat is persisted on the round (target_thread) and
// is the ONLY place it can go — no "any live session" fallback, no origin
// fallback, in the route or in the sweep. A target that cannot take it fails
// with a named, owner-visible reason; its threads are released.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { markdownBlocks } from "../servers/blog/renderer.js";
import { initArtifactsTables } from "../bundles/artifacts/server/init-tables.js";
import { createLocalBlobStore } from "../bundles/artifacts/server/blob-store.js";
import * as store from "../bundles/artifacts/server/store.js";
import * as comments from "../bundles/artifacts/server/comments.js";
import * as rounds from "../bundles/artifacts/server/rounds.js";
import { deliverRound } from "../bundles/artifacts/server/delivery.js";
import { verifyTarget, pickSendTarget } from "../bundles/artifacts/server/links.js";
import { runSweep } from "../bundles/artifacts/server/sweep.js";
import { markSessionTainted } from "../bundles/artifacts/server/trust.js";

const s = {};
const OWNER = { kind: "session" };
const DEF = { tools: { crow_mcp: ["artifacts"] } };
const NO_TOOLS = { tools: { crow_mcp: [] } };
before(async () => {
  s.dir = mkdtempSync(join(tmpdir(), "artifacts-target-"));
  s.db = createDbClient(join(s.dir, "crow.db"));
  await s.db.executeMultiple(`CREATE TABLE IF NOT EXISTS bot_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT, gateway_thread_id TEXT, narrowed_tools TEXT);`);
  await initArtifactsTables(s.db);
  s.blobs = createLocalBlobStore(join(s.dir, "blobs"));
});
after(() => { try { s.db.close(); } catch {} rmSync(s.dir, { recursive: true, force: true }); });

let k = 0;
const tid = (p) => `perchlive-${p}${String(++k).padStart(4, "0")}`.slice(0, 18);
const session = (bot, thread, nt = null) => s.db.execute({ sql: "INSERT INTO bot_sessions (bot_id, gateway_thread_id, narrowed_tools) VALUES (?,?,?)", args: [bot, thread, nt] });
const link = (art, bot, thread) => s.db.execute({ sql: "INSERT INTO artifact_links (artifact_id,bot_id,thread_id,linked_by) VALUES (?,?,?,'owner-yes')", args: [art, bot, thread] });
const unlink = (art, thread) => s.db.execute({ sql: "UPDATE artifact_links SET unlinked_at=datetime('now') WHERE artifact_id=? AND thread_id=? AND unlinked_at IS NULL", args: [art, thread] });

/** A bot-made artifact from chat A (live, clean), one owner thread, a pending round. */
async function setup({ contact = false } = {}) {
  const A = tid("a"), B = tid("b");
  await session("bobby", A); await session("bobby", B);
  const art = await store.createArtifact(s.db, s.blobs, { title: "Target me", type: "document", source: { markdown: "# t" }, actor: { kind: "bot", id: "bobby", thread: A, gateway: "perch" } }, { markdownBlocks });
  const th = await comments.addThread(s.db, { artifactId: art.id, versionN: 1, anchor: { kind: "whole" }, text: "make it blue", author: contact ? { kind: "contact", id: "c1" } : { kind: "owner" } });
  return { art, A, B, threadId: th.threadId };
}
async function startTo(x, target, botId = "bobby") {
  return rounds.startRound(s.db, { artifactId: x.art.id, actor: OWNER, include: [x.threadId], botId, targetThread: target });
}
function engine(sessions, { failMessage = null } = {}) {
  return {
    sent: [], spawned: [],
    async list() { return sessions; },
    async message(id, text) {
      const f = typeof failMessage === "function" ? failMessage(id) : failMessage;
      if (f) throw Object.assign(new Error(f), { code: f });
      this.sent.push(id);
    },
    async spawn(o) { const t = tid("n"); this.spawned.push({ ...o, threadId: t }); return { sessionId: t, threadId: t }; },
    async stop() {},
  };
}
const live = (bot, thread, state = "idle") => ({ sessionId: thread, botId: bot, threadId: thread, state });
const threadSent = async (id) => (await s.db.execute({ sql: "SELECT sent_round_id FROM artifact_threads WHERE id=?", args: [id] })).rows[0].sent_round_id;

test("verifyTarget: refuses an unlinked, unlinked-later, other-bot, no-access or other-bot's-session chat, and a def without artifacts tools — by name", async () => {
  const x = await setup();
  assert.equal(await verifyTarget(s.db, { artifactId: x.art.id, botId: "bobby", threadId: x.A, botDef: DEF }), null, "the origin chat is a valid target");
  assert.equal(await verifyTarget(s.db, { artifactId: x.art.id, botId: "bobby", threadId: x.B, botDef: DEF }), "target_unlinked");
  await link(x.art.id, "bobby", x.B); await unlink(x.art.id, x.B);
  assert.equal(await verifyTarget(s.db, { artifactId: x.art.id, botId: "bobby", threadId: x.B, botDef: DEF }), "target_unlinked", "unlinked later");
  const C = tid("c"); await session("bobby", C); await link(x.art.id, "eve", C);
  assert.equal(await verifyTarget(s.db, { artifactId: x.art.id, botId: "bobby", threadId: C, botDef: DEF }), "target_other_bot", "the link names another bot");
  assert.equal(await verifyTarget(s.db, { artifactId: x.art.id, botId: "eve", threadId: C, botDef: DEF }), "target_no_access", "eve has no grant on bobby's artifact");
  await s.db.execute({ sql: "INSERT INTO artifact_bot_access (artifact_id, bot_id) VALUES (?, 'eve')", args: [x.art.id] });
  assert.equal(await verifyTarget(s.db, { artifactId: x.art.id, botId: "eve", threadId: C, botDef: DEF }), "target_not_bots_chat", "M5c: the chat's own session row belongs to bobby");
  const E = tid("e"); await session("eve", E); await link(x.art.id, "eve", E);
  assert.equal(await verifyTarget(s.db, { artifactId: x.art.id, botId: "eve", threadId: E, botDef: DEF }), null, "granted bot, its own linked chat");
  assert.equal(await verifyTarget(s.db, { artifactId: x.art.id, botId: "eve", threadId: E, botDef: NO_TOOLS }), "bot_lacks_artifacts");
  const N = tid("x"); await link(x.art.id, "bobby", N);
  assert.equal(await verifyTarget(s.db, { artifactId: x.art.id, botId: "bobby", threadId: N, botDef: DEF }), "target_not_bots_chat", "no session row at all fails closed");
});

test("B7: the Library's Send persists the most recent VERIFIED active link; no active link → no target (never 'any live chat')", async () => {
  const x = await setup();
  await link(x.art.id, "bobby", x.B);
  await s.db.execute({ sql: "UPDATE artifact_links SET linked_at=datetime('now','+1 minute') WHERE artifact_id=? AND thread_id=?", args: [x.art.id, x.B] });
  assert.deepEqual(await pickSendTarget(s.db, { artifactId: x.art.id, loadBotDef: async () => DEF }), { threadId: x.B, botId: "bobby" });
  await unlink(x.art.id, x.B); await unlink(x.art.id, x.A);
  assert.equal(await pickSendTarget(s.db, { artifactId: x.art.id, loadBotDef: async () => DEF }), null);
  // An untargeted trusted round never lands in a live chat: it asks for a choice.
  const r = await startTo(x, null);
  const e = engine([live("bobby", x.A), live("bobby", x.B)]);
  const out = await deliverRound(s.db, r, { engine: e, botDef: DEF, choice: "chat" });
  assert.equal(out.needsChoice, true);
  assert.deepEqual(e.sent, [], "nothing sent to the origin chat or any other live chat");
});

test("happy path: a targeted round goes to that chat and binds it; target_thread is persisted on the row", async () => {
  const x = await setup();
  await link(x.art.id, "bobby", x.B);
  const r = await startTo(x, x.B);
  assert.equal((await rounds.getRound(s.db, r.id)).target_thread, x.B);
  const e = engine([live("bobby", x.A), live("bobby", x.B)]);
  const out = await deliverRound(s.db, r, { engine: e, botDef: DEF, choice: "chat" });
  assert.equal(out.status, "working");
  assert.deepEqual(e.sent, [x.B], "chat B only — not the origin chat A");
  assert.equal((await rounds.getRound(s.db, r.id)).session_id, x.B);
});

test("capacity: queued from chat B, the sweep delivers to B — never A; B unlinked while queued → failed, owner told, never A", async () => {
  const x = await setup();
  await link(x.art.id, "bobby", x.B);
  const r = await startTo(x, x.B);
  const full = engine([live("bobby", x.A), live("bobby", x.B, "hibernating")], { failMessage: "interactive_capacity" });
  assert.equal((await deliverRound(s.db, r, { engine: full, botDef: DEF, choice: "chat" })).status, "queued");
  const e = engine([live("bobby", x.A), live("bobby", x.B)]);
  const notes = [];
  await runSweep(s.db, { engine: e, botDefOf: async () => DEF, notify: async (n) => notes.push(n) });
  assert.deepEqual(e.sent, [x.B]);
  assert.equal((await rounds.getRound(s.db, r.id)).status, "working");
  // Second case: unlinked while queued.
  const y = await setup();
  await link(y.art.id, "bobby", y.B);
  const r2 = await startTo(y, y.B);
  assert.equal((await deliverRound(s.db, r2, { engine: full, botDef: DEF, choice: "chat" })).status, "queued");
  await unlink(y.art.id, y.B);
  const e2 = engine([live("bobby", y.A), live("bobby", y.B)]);
  const notes2 = [];
  await runSweep(s.db, { engine: e2, botDefOf: async () => DEF, notify: async (n) => notes2.push(n) });
  assert.deepEqual(e2.sent, [], "never the origin chat, never any chat");
  assert.deepEqual(e2.spawned, [], "never a new session either");
  const row = await rounds.getRound(s.db, r2.id);
  assert.equal(row.status, "failed");
  assert.ok(notes2.some((n) => /couldn't/i.test(n.title) && n.body.includes("unlinked")), `owner told: ${JSON.stringify(notes2)}`);
  assert.equal(await threadSent(y.threadId), null, "the failed round's threads are open again");
});

test("B8: a hibernating target is woken through the engine; a stopped or vanished one fails by name — never a new session or another chat (route path and sweep path)", async () => {
  const x = await setup();
  await link(x.art.id, "bobby", x.B);
  const r = await startTo(x, x.B);
  const e = engine([live("bobby", x.A), live("bobby", x.B, "hibernating")]);
  assert.equal((await deliverRound(s.db, r, { engine: e, botDef: DEF, choice: "chat" })).status, "working");
  assert.deepEqual(e.sent, [x.B], "message() wakes the hibernating chat");
  for (const [label, sessions, fail] of [
    ["stopped in the list", (y) => [live("bobby", y.A), live("bobby", y.B, "stopped")], null],
    ["the engine says stopped", (y) => [live("bobby", y.A)], "session_stopped"],
    ["the engine has no such session", (y) => [live("bobby", y.A)], "no_such_session"],
  ]) {
    const y = await setup();
    await link(y.art.id, "bobby", y.B);
    const ry = await startTo(y, y.B);
    const ey = engine(sessions(y), { failMessage: fail });
    const out = await deliverRound(s.db, ry, { engine: ey, botDef: DEF, choice: "chat" });
    assert.equal(out.status, "failed", label);
    assert.equal(out.error, "target_asleep", label);
    assert.ok(!out.needsChoice, label);
    assert.deepEqual(ey.spawned, [], `${label}: no new session`);
    assert.ok(!ey.sent.includes(y.A), `${label}: never the origin chat`);
  }
  // Sweep path: queued at capacity, the target stopped meanwhile.
  const z = await setup();
  await link(z.art.id, "bobby", z.B);
  const rz = await startTo(z, z.B);
  await deliverRound(s.db, rz, { engine: engine([live("bobby", z.B, "hibernating")], { failMessage: "pi_capacity" }), botDef: DEF, choice: "chat" });
  const ez = engine([live("bobby", z.A), live("bobby", z.B, "stopped")]);
  const notes = [];
  await runSweep(s.db, { engine: ez, botDefOf: async () => DEF, notify: async (n) => notes.push(n) });
  assert.equal((await rounds.getRound(s.db, rz.id)).status, "failed");
  assert.deepEqual([ez.sent, ez.spawned], [[], []]);
  assert.ok(notes.some((n) => n.body.includes("asleep")), JSON.stringify(notes));
});

test("D23: a tainted linked chat RECEIVES a trusted round; a locked one never does (failed by name)", async () => {
  const x = await setup();
  await link(x.art.id, "bobby", x.B);
  await markSessionTainted(s.db, "bobby", x.B, "read-contact");
  const r = await startTo(x, x.B);
  const e = engine([live("bobby", x.B)]);
  assert.equal((await deliverRound(s.db, r, { engine: e, botDef: DEF, choice: "chat" })).status, "working");
  assert.deepEqual(e.sent, [x.B]);
  const y = await setup();
  const L = tid("l"); await session("bobby", L, JSON.stringify(["crow:locked", "crow:only:mcp__artifacts__"])); await link(y.art.id, "bobby", L);
  const ry = await startTo(y, L);
  const ey = engine([live("bobby", L)]);
  const out = await deliverRound(s.db, ry, { engine: ey, botDef: DEF, choice: "chat" });
  assert.deepEqual([out.status, out.error], ["failed", "target_locked"]);
  assert.deepEqual(ey.sent, []);
});

test("M5(b): a targeted round downgraded at delivery goes ONLY to a fresh locked session — never the target chat", async () => {
  const x = await setup();
  await link(x.art.id, "bobby", x.B);
  const r = await startTo(x, x.B);
  assert.equal(r.untrusted, false);
  // The snapshot's provenance turns untrusted before delivery (a comment re-marked tainted).
  await s.db.execute({ sql: "UPDATE artifact_comments SET tainted=1 WHERE thread_id=?", args: [x.threadId] });
  const e = engine([live("bobby", x.A), live("bobby", x.B)]);
  const out = await deliverRound(s.db, r, { engine: e, botDef: DEF, choice: "chat" });
  assert.equal(out.downgraded, true);
  assert.deepEqual(e.sent.filter((t) => t === x.A || t === x.B), [], "neither linked chat");
  assert.equal(e.spawned.length, 1);
  assert.deepEqual(e.spawned[0].narrowedTools, rounds.UNTRUSTED_ALLOW);
});

test("a def that lost its artifacts tools fails the round by name and releases its threads", async () => {
  const x = await setup();
  const r = await startTo(x, x.A);
  const out = await deliverRound(s.db, r, { engine: engine([live("bobby", x.A)]), botDef: NO_TOOLS, choice: "chat" });
  assert.deepEqual([out.status, out.error], ["failed", "bot_lacks_artifacts"]);
  assert.equal(await threadSent(x.threadId), null);
});
