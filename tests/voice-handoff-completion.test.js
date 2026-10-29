/**
 * The completion notice (PR 5, Task 5.1): when the bot that took a voice hand-off reports its final result
 * through board_report_result, the operator gets ONE notification that opens what the bot made, the hand-off
 * row ends (done or failed), the claim is released, and the bot's running Perch turn keeps its "replied" push
 * to itself [rv2 N2, rv3 C2]. Any other reporter, a partial report [rv2 m6], or a card nobody claimed keeps
 * today's generic "needs review" notice, byte for byte. A scratch init-db'd crow.db plus a tasks.db per test,
 * the real result-service, store and card-docs; a fake engine installed as the process singleton.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const root = mkdtempSync(join(tmpdir(), "vh-completion-"));
process.env.CROW_DATA_DIR = join(root, "master");
process.env.CROW_HOME = join(root, "home");
delete process.env.CROW_DB_PATH;
process.env.CROW_TASKS_DB_PATH = join(root, "master", "tasks.db");
const REPO = new URL("..", import.meta.url).pathname;
const MASTER = { crow: join(root, "master", "crow.db"), tasks: join(root, "master", "tasks.db") };

const { createDbClient } = await import("../servers/db.js");
const { BOARD_PLANS_DDL, BOARD_RESULTS_DDL, BOARD_MUTATIONS_DDL } = await import("../scripts/migrations/0004-track1-card-model.mjs");
const { reportResult } = await import("../servers/gateway/board/result-service.js");
const { createCard, getCard } = await import("../servers/gateway/board/card-service.js");
const { setItemCard } = await import("../servers/shared/shell-items.js");
const { createHandoffCore, registerVoiceResultKind } = await import("../servers/gateway/voice/handoff.js");
const { createHandoffCompletion } = await import("../servers/gateway/voice/handoff-completion.js");
const { createHandoffStore } = await import("../servers/gateway/voice/handoff-store.js");
const { voiceLine } = await import("../servers/gateway/voice/voice-lines.js");
const RR = await import("../servers/gateway/board/result-requesters.js");
const P = await import("../servers/gateway/perch-interactive.js");
const { CROW_VOICE_BOT_ID } = await import("../servers/shared/voice-bot.js");

const VOICE = { bot_id: CROW_VOICE_BOT_ID, kind: "voice", display_name: "Crow", fast_voice_model: "crow-voice/qwen3.5-4b", handoff: { enabled: true, allowed_bots: [] } };
const board = (over = {}) => ({ gateways: [{ type: "perch" }], tracker_config: { type: "kanban" }, models: { default: "prov/model-a" }, ...over });
const TASK = "research radio history";
const DEVICE = "phone-1";
const WRITER = { kind: "bot", id: "writer", jobId: null };
const HELPER = { kind: "bot", id: "helper", jobId: null };
const UNATTRIBUTED = { kind: "bot", id: null, jobId: null };
const HUMAN = { kind: "human", id: "alex", jobId: null };
const T0 = 1_800_000_000_000;
const flush = () => new Promise((r) => setImmediate(r));

let PID;
const open = [];
after(() => { P._resetInteractiveEngineForTest(); for (const c of open) { try { c.close(); } catch {} } rmSync(root, { recursive: true, force: true }); });

before(() => {
  mkdirSync(join(root, "master"), { recursive: true });
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: join(root, "master") }, stdio: "pipe", cwd: REPO });
  const raw = new Database(MASTER.crow);
  PID = Number(raw.prepare("INSERT INTO project_spaces (slug, name) VALUES ('voice-p','Voice P')").run().lastInsertRowid);
  const seed = raw.prepare("INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES (?,?,?,1,?)");
  seed.run(CROW_VOICE_BOT_ID, "Crow", JSON.stringify(VOICE), null);
  seed.run("writer", "Writer", JSON.stringify(board({ description: "Writes documents" })), PID);
  seed.run("helper", "Helper", JSON.stringify(board({ description: "Automations" })), Number(raw.prepare("INSERT INTO project_spaces (slug, name) VALUES ('helper-p','Helper P')").run().lastInsertRowid));
  // The artifacts table is the Make feature's (not init-db's): the shape card-docs.js reads.
  raw.exec(`CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, title TEXT, origin_card INTEGER, origin_session TEXT,
    deleted_at TEXT, created_at TEXT DEFAULT (datetime('now')))`);
  raw.pragma("wal_checkpoint(TRUNCATE)");
  raw.close();
  const t = new Database(MASTER.tasks);
  t.exec(`CREATE TABLE tasks_items (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
    description TEXT, status TEXT NOT NULL DEFAULT 'pending', priority INTEGER DEFAULT 3,
    due_date TEXT, phase TEXT, owner TEXT, tags TEXT, parent_id INTEGER, project_id INTEGER,
    assigned_bot TEXT, board_id INTEGER, bot_id TEXT, action_needed TEXT, next_followup_date TEXT,
    processing_lease TEXT, processing_lease_status TEXT,
    autonomy TEXT NOT NULL DEFAULT 'gated', archived_at TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT, data_json TEXT NOT NULL DEFAULT '{}')`);
  t.exec(BOARD_PLANS_DDL);
  t.exec(BOARD_RESULTS_DDL);
  t.exec(BOARD_MUTATIONS_DDL);
  t.close();
});

let n = 0;
function freshDbs() {
  const dir = join(root, "t" + (++n));
  mkdirSync(dir);
  const crow = join(dir, "crow.db"), tasks = join(dir, "tasks.db");
  copyFileSync(MASTER.crow, crow);
  copyFileSync(MASTER.tasks, tasks);
  process.env.CROW_TASKS_DB_PATH = tasks;
  const db = createDbClient(crow);
  const tdb = createDbClient(tasks);
  open.push(db, tdb);
  return { db, tdb };
}

/**
 * The engine as the mark sees it: a session bound to a card, a running turn, and the engine's own away push
 * when a turn that ran 30 s or more ends with nobody watching, unless the turn's push was suppressed. The push
 * lands in the same notifications table as the completion notice, so one count covers both rails.
 */
function fakeEngine(db) {
  const claims = new Map();
  const sessions = new Map();
  return {
    bind(sid, cardId) { sessions.set(sid, { turn: null }); claims.set(Number(cardId), sid); },
    startTurn(sid) { sessions.get(sid).turn = { noPush: false }; },
    async endTurn(sid, { ranS = 45 } = {}) {
      const s = sessions.get(sid);
      const turn = s.turn;
      s.turn = null;
      if (ranS < 30 || turn.noPush) return false;
      const { createNotification } = await import("../servers/shared/notifications.js");
      await createNotification(db, { type: "attention", priority: "normal", title: "writer replied", body: "ok", action_url: "/dashboard/bot-board#bird=" + sid });
      return true;
    },
    suppressTurnEndPush(cardId) {
      const sid = claims.get(Number(cardId));
      const s = sid == null ? null : sessions.get(sid);
      if (!s || !s.turn) return false;
      s.turn.noPush = true;
      return true;
    },
  };
}

beforeEach(() => { RR._resetResultRequestersForTest(); P._resetInteractiveEngineForTest(); });

async function setup() {
  const { db, tdb } = freshDbs();
  const announced = [];
  const logs = [];
  const now = () => T0;
  const store = createHandoffStore({ now });
  const core = createHandoffCore({ store, announce: async (a) => { announced.push(a); return { spokenOn: null }; }, now, log: (m) => logs.push(m) });
  registerVoiceResultKind({ core });
  const eng = fakeEngine(db);
  P._setInteractiveEngineForTest(eng);

  /** A hand-off row in `status` on a fresh card of `bot`, claimed for the voice rail unless `claim` is false. */
  async function handoff({ status = "started", bot = "writer", autonomy = "gated", claim = true, lang = "en", surface = "phone" } = {}) {
    const { id: cardId } = await createCard(tdb, { title: TASK, status: "pending", project_id: bot === "writer" ? PID : null, assigned_bot: bot, autonomy }, HUMAN);
    const id = await store.insert(db, { kind: "handoff", surface, device_id: DEVICE, bot_id: bot, task: TASK, status: "proposed", lang });
    await store.transition(db, id, ["proposed"], status === "proposed" ? "proposed" : status);
    await store.setFields(db, id, { card_id: cardId });
    if (claim) RR.claimResult(cardId, "voice");
    return { id, cardId };
  }
  const report = (cardId, { outcome = "success", summaryMd = "Done: the write-up is ready." } = {}, actor = WRITER) => reportResult(tdb, db, cardId, { outcome, summaryMd }, actor);
  const notifications = async () => (await db.execute("SELECT type, source, title, body, priority, action_url FROM notifications ORDER BY id")).rows
    .map((r) => ({ type: r.type, source: r.source, title: r.title, body: r.body, priority: r.priority, action_url: r.action_url }));
  const row = (id) => store.get(db, id);
  return { db, tdb, store, core, eng, announced, logs, handoff, report, notifications, row };
}

/** Today's notice for a result on `cardId`, exactly as result-service.js has always sent it. */
const generic = (cardId, { outcome = "success", summary = "Done: the write-up is ready.", actor = WRITER } = {}) => ({
  type: "attention", source: null, priority: "high",
  title: `"${TASK}" needs review`,
  body: summary || `${outcome} reported by ${actor.kind}${actor.id ? " " + actor.id : ""}`,
  action_url: "/dashboard/bot-board#card=" + cardId,
});

test("a claimed card's result sends one notification that opens its document", async () => {
  const s = await setup();
  const { id, cardId } = await s.handoff();
  await setItemCard(s.db, "workspace_file", "12", cardId);
  const r = await s.report(cardId, { summaryMd: "Done: the write-up is ready. ".repeat(10) });
  assert.equal(r.status, "recorded");
  const nfs = await s.notifications();
  assert.equal(nfs.length, 1);
  assert.deepEqual(nfs[0], {
    type: "attention", source: "crow-voice", priority: "high",
    title: "Writer finished: research radio history",
    body: "Done: the write-up is ready. ".repeat(10).slice(0, 140),
    action_url: "/dashboard/make/open/workspace_file/12",
  });
  const h = await s.row(id);
  assert.equal(h.status, "done");
  assert.equal(h.outcome, "success");
  assert.equal(h.detail, "Done: the write-up is ready. ".repeat(10).slice(0, 300));
  assert.equal(h.ended_at, T0);
  assert.equal(RR.requesterOf(cardId), null, "the claim is released");
  await flush();
  assert.equal(s.announced.length, 1);
  assert.equal(s.announced[0].originDeviceId, DEVICE);
  assert.equal(s.announced[0].lineFor("phone"), "Writer finished research radio history. It's on your phone.");
  assert.equal(s.announced[0].lineFor("kiosk"), "Writer has finished a task. The details are on your phone.", "a kiosk never hears the task text");
  assert.deepEqual(s.logs, []);
});

test("the last listed document wins: an artifact made on the card over an earlier hand link (P5)", async () => {
  const s = await setup();
  const { cardId } = await s.handoff();
  await setItemCard(s.db, "workspace_file", "12", cardId);
  await s.db.execute({ sql: "INSERT INTO artifacts (id, title, origin_card) VALUES ('art_abcdef', 'Radio', ?)", args: [cardId] });
  await s.report(cardId);
  const [nf] = await s.notifications();
  assert.equal(nf.action_url, "/dashboard/make/open/artifact/art_abcdef");
});

test("an artifact link in the summary is used when the card has no document", async () => {
  const s = await setup();
  const a = await s.handoff();
  await s.report(a.cardId, { summaryMd: "Wrote it up: /dashboard/artifacts/view/art_k3j2h1 (two sections)." });
  const b = await s.handoff();
  await s.report(b.cardId, { summaryMd: "Saved at /dashboard/make/open/workspace_file/44." });
  const nfs = await s.notifications();
  assert.equal(nfs[0].action_url, "/dashboard/artifacts/view/art_k3j2h1");
  assert.equal(nfs[1].action_url, "/dashboard/make/open/workspace_file/44");
});

test("otherwise the card drawer; and with no drawer, today's card link (P6)", async () => {
  const s = await setup();
  const { cardId } = await s.handoff();
  await s.report(cardId, { summaryMd: "Done, see the card." });
  const [nf] = await s.notifications();
  assert.equal(nf.action_url, `/dashboard/bot-board?bot=writer#open=${cardId}`);

  const other = await s.handoff();
  const completion = createHandoffCompletion({ store: s.store, announce: s.core.announce, cardHref: async () => null, log: () => {} });
  const notice = await completion.notice(s.db, { card: await getCard(s.tdb, other.cardId), outcome: "success", summaryMd: "", resultId: 2, actor: WRITER, tdb: s.tdb });
  assert.equal(notice.action_url, "/dashboard/bot-board#card=" + other.cardId);
  assert.equal(notice.body, null, "an empty summary is no body");
});

test("an unclaimed card keeps today's notification, byte for byte", async () => {
  const s = await setup();
  const { id: cardId } = await createCard(s.tdb, { title: TASK, status: "pending", project_id: PID, autonomy: "gated" }, HUMAN);
  await s.report(cardId);
  assert.deepEqual(await s.notifications(), [generic(cardId)]);
  // An empty summary falls back to the actor line, as today.
  const { id: second } = await createCard(s.tdb, { title: TASK, status: "pending", project_id: PID, autonomy: "gated" }, HUMAN);
  await s.report(second, { outcome: "failure", summaryMd: "" }, UNATTRIBUTED);
  assert.deepEqual((await s.notifications())[1], generic(second, { outcome: "failure", summary: "", actor: UNATTRIBUTED }));
  assert.equal(s.announced.length, 0);
});

test("a kind that throws keeps today's notification", async () => {
  const s = await setup();
  RR.registerResultKind("delegate", { notice: async () => { throw new Error("delegate down"); }, restore: async () => [], owns: async () => false });
  const { id: cardId } = await createCard(s.tdb, { title: TASK, status: "pending", project_id: PID, autonomy: "gated" }, HUMAN);
  RR.claimResult(cardId, "delegate");
  await s.report(cardId);
  assert.deepEqual(await s.notifications(), [generic(cardId)]);
});

test("an unattributed bot report gets today's notice and the row stays started [rv1 C7]", async () => {
  const s = await setup();
  const { id, cardId } = await s.handoff();
  await s.report(cardId, {}, UNATTRIBUTED);
  assert.deepEqual(await s.notifications(), [generic(cardId, { actor: UNATTRIBUTED })]);
  assert.equal((await s.row(id)).status, "started");
  assert.equal(RR.requesterOf(cardId), "voice", "the claim is kept for the bot's own report");
  assert.equal(s.announced.length, 0);
});

test("another bot's report, or a human's, gets today's notice", async () => {
  const s = await setup();
  const { id, cardId } = await s.handoff();
  await s.report(cardId, {}, HELPER);
  await s.report(cardId, {}, HUMAN);
  assert.deepEqual(await s.notifications(), [generic(cardId, { actor: HELPER }), generic(cardId, { actor: HUMAN })]);
  assert.equal((await s.row(id)).status, "started");
  assert.equal(RR.requesterOf(cardId), "voice");
});

test("a restart keeps the completion notice: the DB row owns the card when no claim is in memory (Review Focus 4)", async () => {
  const s = await setup();
  const { id, cardId } = await s.handoff({ claim: false });
  assert.equal(RR.requesterOf(cardId), null);
  await s.report(cardId);
  const nfs = await s.notifications();
  assert.equal(nfs.length, 1);
  assert.equal(nfs[0].title, "Writer finished: research radio history");
  assert.equal((await s.row(id)).status, "done");
});

test("owns and restore count started, queued, quiet and a starting row with a card; never a closed one (P8)", async () => {
  const s = await setup();
  const rows = {};
  for (const status of ["starting", "started", "queued", "quiet", "stopped", "done", "failed", "declined"]) rows[status] = await s.handoff({ status, claim: false });
  const noCard = await s.store.insert(s.db, { kind: "handoff", surface: "phone", device_id: DEVICE, bot_id: "writer", task: TASK, status: "starting" });
  const completion = s.core.completion;
  for (const status of ["starting", "started", "queued", "quiet"]) assert.equal(await completion.owns(s.db, rows[status].cardId), true, status);
  for (const status of ["stopped", "done", "failed", "declined"]) assert.equal(await completion.owns(s.db, rows[status].cardId), false, status);
  assert.deepEqual((await completion.restore(s.db)).sort((a, b) => a - b), ["starting", "started", "queued", "quiet"].map((k) => rows[k].cardId).sort((a, b) => a - b));
  assert.equal(await RR.restoreResultRequesters(s.db), 4);
  assert.equal(RR.requesterOf(rows.quiet.cardId), "voice");
  assert.equal(RR.requesterOf(rows.stopped.cardId), null);
  // A stopped row's later result is today's notice (5.4 relies on this).
  await s.report(rows.stopped.cardId);
  assert.deepEqual((await s.notifications()).at(-1), generic(rows.stopped.cardId));
  assert.equal((await s.row(noCard)).status, "starting");
});

test("a claimed auto card gets the notice; an unclaimed one gets none", async () => {
  const s = await setup();
  const { id, cardId } = await s.handoff({ autonomy: "auto" });
  const r = await s.report(cardId);
  assert.equal(r.status, "approved");
  assert.equal((await getCard(s.tdb, cardId)).status, "done");
  const nfs = await s.notifications();
  assert.equal(nfs.length, 1);
  assert.equal(nfs[0].title, "Writer finished: research radio history");
  assert.equal((await s.row(id)).status, "done");

  const { id: plain } = await createCard(s.tdb, { title: TASK, status: "pending", project_id: PID, autonomy: "auto" }, HUMAN);
  await s.report(plain);
  assert.equal((await s.notifications()).length, 1, "an unclaimed auto card pushes nothing, as today");
});

test("a moveCard that is refused still sends the notice, then rethrows (P7)", async () => {
  const s = await setup();
  const { id, cardId } = await s.handoff({ autonomy: "auto" });
  // Another bot's live chat session holds the card (board-lock.js: an `active` non-perch-live row locks it).
  await s.db.execute({ sql: "INSERT INTO bot_sessions (bot_id, card_id, status, kind) VALUES ('helper', ?, 'active', 'chat')", args: [cardId] });
  await assert.rejects(() => s.report(cardId), (e) => e.code === "locked");
  const nfs = await s.notifications();
  assert.equal(nfs.length, 1);
  assert.equal(nfs[0].title, "Writer finished: research radio history");
  assert.equal((await s.row(id)).status, "done");
  assert.notEqual((await getCard(s.tdb, cardId)).status, "done");
});

test("the log row ends done or failed, and the claim is released", async () => {
  const s = await setup();
  const { id, cardId } = await s.handoff({ lang: "es" });
  await s.report(cardId, { outcome: "failure", summaryMd: "The source archive is offline." });
  const [nf] = await s.notifications();
  assert.equal(nf.title, "Writer no pudo terminar: research radio history");
  assert.equal(nf.body, "The source archive is offline.");
  const h = await s.row(id);
  assert.equal(h.status, "failed");
  assert.equal(h.outcome, "failure");
  assert.equal(h.detail, "The source archive is offline.");
  assert.equal(RR.requesterOf(cardId), null);
  await flush();
  assert.equal(s.announced[0].lineFor("phone"), "Writer no pudo terminar: research radio history. Los detalles están en tu teléfono.");
  assert.equal(s.announced[0].lineFor("kiosk"), "Writer no pudo terminar una tarea. Los detalles están en tu teléfono.");
});

test("a partial report keeps the row open and the claim held, and a later success gets the hand-off notice [rv2 m6]", async () => {
  const s = await setup();
  const { id, cardId } = await s.handoff();
  await s.report(cardId, { outcome: "partial", summaryMd: "Half way: the 1920s are done." });
  assert.deepEqual(await s.notifications(), [generic(cardId, { outcome: "partial", summary: "Half way: the 1920s are done." })]);
  let h = await s.row(id);
  assert.equal(h.status, "started");
  assert.equal(h.outcome, null);
  assert.equal(h.detail, "Half way: the 1920s are done.");
  assert.equal(RR.requesterOf(cardId), "voice");
  assert.equal(s.announced.length, 0);
  await s.report(cardId, { summaryMd: "All done." });
  const nfs = await s.notifications();
  assert.equal(nfs.length, 2);
  assert.equal(nfs[1].title, "Writer finished: research radio history");
  h = await s.row(id);
  assert.equal(h.status, "done");
  assert.equal(h.detail, "All done.");
  assert.equal(RR.requesterOf(cardId), null);
});

test("the turn that reports the result sends no \"replied\" push [rv2 N2]", async () => {
  const s = await setup();
  const { cardId } = await s.handoff();
  s.eng.bind("s1", cardId);
  s.eng.startTurn("s1");
  await s.report(cardId);
  assert.equal(await s.eng.endTurn("s1", { ranS: 45 }), false, "the turn's own push is suppressed");
  const nfs = await s.notifications();
  assert.equal(nfs.length, 1);
  assert.equal(nfs[0].title, "Writer finished: research radio history");
});

test("a mid-task turn of a claimed card still pushes \"replied\", and so does a plain-text question turn [rv2 N2]", async () => {
  const s = await setup();
  const { cardId } = await s.handoff();
  s.eng.bind("s1", cardId);
  s.eng.startTurn("s1");
  assert.equal(await s.eng.endTurn("s1", { ranS: 45 }), true);
  s.eng.startTurn("s1");
  assert.equal(await s.eng.endTurn("s1", { ranS: 60 }), true, "a turn that ends asking the operator something pushes too");
  assert.deepEqual((await s.notifications()).map((x) => x.title), ["writer replied", "writer replied"]);
  assert.equal(RR.requesterOf(cardId), "voice");
});

test("a report in a 10 s turn, then a 40 s follow-up turn, still pushes \"replied\" for the follow-up [rv3 C2]", async () => {
  const s = await setup();
  const { cardId } = await s.handoff();
  s.eng.bind("s1", cardId);
  s.eng.startTurn("s1");
  await s.report(cardId);
  assert.equal(await s.eng.endTurn("s1", { ranS: 10 }), false);
  s.eng.startTurn("s1");
  assert.equal(await s.eng.endTurn("s1", { ranS: 40 }), true, "the mark was the 10 s turn's alone");
  assert.deepEqual((await s.notifications()).map((x) => x.title), ["Writer finished: research radio history", "writer replied"]);
});

test("a report made outside any running turn suppresses nothing [rv3 C2]", async () => {
  const s = await setup();
  const { cardId } = await s.handoff();
  s.eng.bind("s1", cardId);
  await s.report(cardId);
  s.eng.startTurn("s1");
  assert.equal(await s.eng.endTurn("s1", { ranS: 40 }), true);
  assert.deepEqual((await s.notifications()).map((x) => x.title), ["Writer finished: research radio history", "writer replied"]);
});

test("two kinds: each card goes to its own kind", async () => {
  const s = await setup();
  const seen = [];
  RR.registerResultKind("delegate", {
    notice: async (_cdb, ctx) => { seen.push(ctx.card.id); return { type: "attention", priority: "normal", title: "delegate: " + ctx.summaryMd, action_url: "/dashboard/delegate" }; },
    restore: async () => [],
    owns: async () => false,
  });
  const voice = await s.handoff();
  const { id: delegated } = await createCard(s.tdb, { title: "Delegated", status: "pending", project_id: PID, autonomy: "gated" }, HUMAN);
  RR.claimResult(delegated, "delegate");
  await s.report(voice.cardId);
  await s.report(delegated, { summaryMd: "ok" }, HELPER);
  const nfs = await s.notifications();
  assert.deepEqual(nfs.map((x) => [x.title, x.action_url]), [
    ["Writer finished: research radio history", `/dashboard/bot-board?bot=writer#open=${voice.cardId}`],
    ["delegate: ok", "/dashboard/delegate"],
  ]);
  assert.deepEqual(seen, [delegated]);
});

test("the notice is resolved while the reporting turn is still running, and a missing voice_handoffs table is a plain no", async () => {
  const s = await setup();
  const { cardId } = await s.handoff();
  s.eng.bind("s1", cardId);
  s.eng.startTurn("s1");
  const p = s.report(cardId);
  await p;
  assert.equal(s.eng.suppressTurnEndPush(cardId), true, "still running: the mark landed before reportResult returned");
  // A crow.db without the hand-off log (a pre-0018 instance): nothing owned, nothing thrown.
  await s.db.execute("DROP TABLE voice_handoffs");
  const { id: plain } = await createCard(s.tdb, { title: TASK, status: "pending", project_id: PID, autonomy: "gated" }, HUMAN);
  await s.report(plain);
  assert.deepEqual((await s.notifications()).at(-1), generic(plain));
  assert.deepEqual(s.logs, []);
});

test("the completion lines exist in both languages", () => {
  for (const key of ["completion_title_done", "completion_title_failed", "completion_spoken", "completion_spoken_kiosk", "completion_failed_spoken", "completion_failed_spoken_kiosk"]) {
    assert.ok(voiceLine(key, "en", {}), key);
    assert.ok(voiceLine(key, "es", {}), key + " es");
    assert.notEqual(voiceLine(key, "en", {}), voiceLine(key, "es", {}), key);
  }
  for (const key of ["completion_spoken_kiosk", "completion_failed_spoken_kiosk"]) {
    assert.ok(!voiceLine(key, "en", {}).includes("{task}"), key + " never carries the task text");
    assert.ok(!voiceLine(key, "es", {}).includes("{task}"), key + " never carries the task text (es)");
  }
  assert.equal(voiceLine("completion_title_done", "es", { bot: "Writer", task: "x" }), "Writer terminó: x");
  assert.equal(voiceLine("completion_title_failed", "en", { bot: "Writer", task: "x" }), "Writer couldn't finish: x");
});

test("the heads-up is announced only after the completion notification was sent (5.2 carry)", async () => {
  const s = await setup();
  const { id, cardId } = await s.handoff();
  const seenAtAnnounce = [];
  s.core.announce = async (a) => { seenAtAnnounce.push((await s.notifications()).length); s.announced.push(a); return { spokenOn: null }; };
  await s.report(cardId);
  await flush();
  assert.equal(s.announced.length, 1);
  assert.deepEqual(seenAtAnnounce, [1], "the notification was already stored when the heads-up was asked for");
  assert.equal(s.announced[0].handoffId, id, "the heads-up names its hand-off (P31: the device's last topic)");
});

test("a completion notification that is turned off, or that fails, speaks nothing (5.2 carry)", async () => {
  // Turned off: createNotification filters the attention type and returns null.
  const s = await setup();
  const { id, cardId } = await s.handoff();
  await s.db.execute({ sql: "INSERT INTO dashboard_settings (key, value) VALUES ('notification_prefs', ?)", args: [JSON.stringify({ types_enabled: ["system"] })] });
  await s.report(cardId);
  await flush();
  assert.deepEqual(await s.notifications(), []);
  assert.equal(s.announced.length, 0, "nothing reached the phone, so nothing is said about it");
  assert.equal((await s.row(id)).status, "done", "the row still ends");
  // Failed: the send throws (no notifications table), and result-service swallows it.
  const f = await setup();
  const b = await f.handoff();
  await f.db.execute("DROP TABLE notifications");
  const r = await f.report(b.cardId);
  await flush();
  assert.equal(r.status, "recorded", "the result is still recorded");
  assert.equal(f.announced.length, 0);
});

test("the notice's onSent is not part of the notification itself", async () => {
  const s = await setup();
  const { cardId } = await s.handoff();
  const completion = createHandoffCompletion({ store: s.store, announce: s.core.announce, log: () => {} });
  const notice = await completion.notice(s.db, { card: await getCard(s.tdb, cardId), outcome: "success", summaryMd: "Done.", resultId: 1, actor: WRITER, tdb: s.tdb });
  assert.ok(!Object.keys(notice).includes("onSent"), "not enumerable");
  assert.equal(typeof notice.onSent, "function");
  await flush();
  assert.equal(s.announced.length, 0, "nothing is spoken until the sender says it was sent");
  notice.onSent({ id: 1 });
  await flush();
  assert.equal(s.announced.length, 1);
});

test("a completion heads-up that was spoken makes the hand-off that device's last topic, on the core (P31)", async () => {
  const s = await setup();
  const { id, cardId } = await s.handoff();
  s.core.announce = async () => ({ spokenOn: "glasses-1", surface: "glasses" });
  await s.report(cardId);
  await flush();
  assert.deepEqual(s.core.lastHandoffTopic.get("glasses-1"), { id, exchange: 0, at: T0 });
  const t = await setup();
  const b = await t.handoff();
  await t.report(b.cardId);
  await flush();
  assert.equal(t.core.lastHandoffTopic.size, 0, "not spoken: nothing recorded");
});
