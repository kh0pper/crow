/**
 * "How's it going?" (PR 5, Task 5.3): the operator asks about a handed-off job and Crow answers from the
 * hand-off log, the card's result and the bot's Perch session, reconciled with the real session (a bot that
 * ended without reporting, or has gone quiet, is reported truthfully), never from the model. The fast path
 * never takes ordinary speech. A scratch init-db'd crow.db (voice_handoffs, bot_sessions, notifications) plus a
 * tasks.db per test, the real store, the real result-service for the completion rail, a fake engine that only
 * answers waitingOnCard, a fake clock.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import Database from "better-sqlite3";
import { harness } from "./fixtures/voice-turn-harness.mjs";

const root = mkdtempSync(join(tmpdir(), "vh-status-"));
process.env.CROW_DATA_DIR = join(root, "master");
process.env.CROW_HOME = join(root, "home");
delete process.env.CROW_DB_PATH;
process.env.CROW_TASKS_DB_PATH = join(root, "master", "tasks.db");
const REPO = new URL("..", import.meta.url).pathname;
const MASTER = { crow: join(root, "master", "crow.db"), tasks: join(root, "master", "tasks.db") };

const { createDbClient } = await import("../servers/db.js");
const { _setEngineStatusForTest: setStatus } = await import("../servers/gateway/dashboard/panels/bot-builder/engine-gate.js");
const { BOARD_PLANS_DDL, BOARD_RESULTS_DDL, BOARD_MUTATIONS_DDL } = await import("../scripts/migrations/0004-track1-card-model.mjs");
const { reportResult } = await import("../servers/gateway/board/result-service.js");
const { createCard } = await import("../servers/gateway/board/card-service.js");
const { createHandoffCore, createHandoffVoiceActions, startHandoffSweep, registerVoiceResultKind } = await import("../servers/gateway/voice/handoff.js");
const { announceHandoff } = await import("../servers/gateway/voice/handoff-confirm.js");
const S = await import("../servers/gateway/voice/handoff-status.js");
const { topicFor, bumpExchange, HANDOFF_TOPIC_EXCHANGES } = await import("../servers/gateway/voice/handoff-topic.js");
const { createHandoffStore } = await import("../servers/gateway/voice/handoff-store.js");
const { createSummaryCache } = await import("../servers/gateway/voice/bot-summaries.js");
const { createPendingStore, chainVoiceActions } = await import("../servers/gateway/voice/pending.js");
const { botDefsGeneration } = await import("../servers/gateway/voice/defs-generation.js");
const { createVoiceBotLoader } = await import("../servers/gateway/voice/crow-voice.js");
const { voiceLine, VOICE_LINES } = await import("../servers/gateway/voice/voice-lines.js");
const { HANDOFF_QUIET_AFTER_MS } = await import("../servers/gateway/voice/handoff-constants.js");
const RR = await import("../servers/gateway/board/result-requesters.js");
const P = await import("../servers/gateway/perch-interactive.js");
const { CROW_VOICE_BOT_ID } = await import("../servers/shared/voice-bot.js");

const VOICE = { bot_id: CROW_VOICE_BOT_ID, kind: "voice", display_name: "Crow", fast_voice_model: "crow-voice/qwen3.5-4b", handoff: { enabled: true, allowed_bots: [] } };
const board = (over = {}) => ({ gateways: [{ type: "perch" }], tracker_config: { type: "kanban" }, models: { default: "prov/model-a" }, ...over });
const TASK = "research radio history";
const DEVICE = { id: "phone-1", name: "Phone" };
const KIOSK = { id: "kiosk-1", name: "Kitchen" };
const WRITER = { kind: "bot", id: "writer", jobId: null };
const HUMAN = { kind: "human", id: "alex", jobId: null };
const T0 = 1_800_000_000_000;
const MIN = 60_000;
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
const sqlTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const says = (t) => [{ type: "content_delta", text: t }, { type: "done" }];

let PID, HPID;
const open = [];
after(() => { setStatus(null); P._resetInteractiveEngineForTest(); for (const c of open) { try { c.close(); } catch {} } rmSync(root, { recursive: true, force: true }); });

before(() => {
  mkdirSync(join(root, "master"), { recursive: true });
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: join(root, "master") }, stdio: "pipe", cwd: REPO });
  const raw = new Database(MASTER.crow);
  PID = Number(raw.prepare("INSERT INTO project_spaces (slug, name) VALUES ('voice-p','Voice P')").run().lastInsertRowid);
  HPID = Number(raw.prepare("INSERT INTO project_spaces (slug, name) VALUES ('helper-p','Helper P')").run().lastInsertRowid);
  const seed = raw.prepare("INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES (?,?,?,1,?)");
  seed.run(CROW_VOICE_BOT_ID, "Crow", JSON.stringify(VOICE), null);
  seed.run("writer", "Writer", JSON.stringify(board({ description: "Writes documents" })), PID);
  seed.run("helper", "Helper", JSON.stringify(board({ description: "Automations" })), HPID);
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
  return { db, tdb, crow, tasks };
}

beforeEach(() => { RR._resetResultRequestersForTest(); P._resetInteractiveEngineForTest(); setStatus({ state: "ready", source: "test", cliPath: "/nonexistent/pi" }); });

/** The engine as the status read may see it: waitingOnCard only (P10). Reading a session (get, adopt) is a fault. */
function fakeEngine() {
  const waiting = new Set();
  const eng = {
    waiting, gets: 0,
    waitingOnCard: (id) => waiting.has(Number(id)),
    get() { eng.gets++; throw new Error("status must never read a session: it would adopt it"); },
    resolveSession() { eng.gets++; throw new Error("status must never adopt"); },
    stop: async () => ({ ok: true }),
  };
  return eng;
}

async function setup() {
  const { db, tdb, crow, tasks } = freshDbs();
  let t = T0;
  const now = () => t;
  now.advance = (ms) => { t += ms; };
  const notifications = [];
  const announced = [];
  const logs = [];
  const eng = fakeEngine();
  const store = createHandoffStore({ now });
  const pending = createPendingStore({ now });
  const core = createHandoffCore({
    store,
    summaries: createSummaryCache({ bus: new EventEmitter(), now }),
    availability: async () => "up",
    loadVoiceDef: createVoiceBotLoader({ generation: botDefsGeneration, now }),
    engine: async () => eng,
    openTasksDb: () => createDbClient(tasks),
    notify: async (_db, nf) => { notifications.push(nf); return { id: notifications.length }; },
    announce: async (a) => { announced.push(a); return { spokenOn: null }; },
    withDb: (fn) => fn(db),
    now,
    log: (m) => logs.push(m),
  });
  registerVoiceResultKind({ core });
  const actions = createHandoffVoiceActions({ core, pending });

  /** A hand-off row in `status` on a fresh card of `bot`, claimed for the voice rail. */
  async function handoff({ status = "started", bot = "writer", surface = "phone", device = DEVICE, lang = "en", session = null, card = true, detail = null } = {}) {
    let cardId = null;
    if (card) ({ id: cardId } = await createCard(tdb, { title: TASK, status: "pending", project_id: bot === "writer" ? PID : HPID, assigned_bot: bot, autonomy: "gated" }, HUMAN));
    const id = await store.insert(db, { kind: "handoff", surface, device_id: device.id, device_name: device.name, bot_id: bot, task: TASK, status: "proposed", lang });
    if (status !== "proposed") await store.transition(db, id, ["proposed"], status, detail ? { detail } : {});
    const fields = {};
    if (cardId != null) fields.card_id = cardId;
    if (session) fields.session_id = session;
    if (Object.keys(fields).length) await store.setFields(db, id, fields);
    if (cardId != null) RR.claimResult(cardId, "voice");
    return { id, cardId };
  }
  /** The bot's perch-live session row for a hand-off, as the engine writes it (updated_at in UTC, `agoMs` old). */
  async function session({ sid, cardId, bot = "writer", status = "active", agoMs = 0 }) {
    await db.execute({
      sql: "INSERT INTO bot_sessions (bot_id, gateway_type, gateway_thread_id, kind, status, card_id, updated_at) VALUES (?, 'perch', ?, 'perch-live', ?, ?, ?)",
      args: [bot, sid, status, cardId ?? null, sqlTime(now() - agoMs)],
    });
  }
  const setSession = (sid, status, agoMs = 0) => db.execute({ sql: "UPDATE bot_sessions SET status = ?, updated_at = ? WHERE gateway_thread_id = ?", args: [status, sqlTime(now() - agoMs), sid] });
  /** A board result written straight into tasks.db: the log row "missed it". */
  const result = (cardId, outcome, summary = "Done: the write-up is ready.") => tdb.execute({
    sql: "INSERT INTO board_results (item_id, actor_kind, actor_id, outcome, summary_md) VALUES (?, 'bot', 'writer', ?, ?)", args: [cardId, outcome, summary],
  });
  const ask = (transcript, { device = DEVICE, surface = "phone", lang = "en", bot = VOICE } = {}) => actions.fastPath({ db, device, surface, transcript, lang, bot });
  const afterTurn = (device = DEVICE) => actions.afterTurn({ db, device, calledTools: [], relay: false });
  const sweep = startHandoffSweep({ core, intervalMs: 3_600_000, openDb: () => createDbClient(crow) });
  const row = (id) => store.get(db, id);
  const dbNotifications = async () => (await db.execute("SELECT title, action_url, source FROM notifications ORDER BY id")).rows;
  const report = (cardId, { outcome = "success", summaryMd = "Done: the write-up is ready." } = {}) => reportResult(tdb, db, cardId, { outcome, summaryMd }, WRITER);
  return { db, tdb, now, core, eng, store, pending, actions, notifications, announced, logs, handoff, session, setSession, result, ask, afterTurn, sweep, row, dbNotifications, report };
}

const line = (key, { lang = "en", bot = "Writer", task = TASK, ...vars } = {}) => voiceLine(key, lang, { bot, task, ...vars });

/* ---------- Every state line ---------- */

test("queued: the bot has not started, and the line says it waits on the board", async () => {
  const s = await setup();
  await s.handoff({ status: "queued" });
  assert.deepEqual(await s.ask("how's writer doing"), { say: "Writer hasn't started research radio history yet. It's waiting on Writer's board.", verb: "status_queued" });
});

test("starting: still starting up", async () => {
  const s = await setup();
  await s.handoff({ status: "starting" });
  assert.deepEqual(await s.ask("is writer done"), { say: "Writer is still starting up for research radio history.", verb: "status_starting" });
});

test("running: an active session", async () => {
  const s = await setup();
  const { cardId } = await s.handoff({ session: "s1" });
  await s.session({ sid: "s1", cardId, status: "active" });
  assert.deepEqual(await s.ask("how's writer doing"), { say: "Writer is working on research radio history.", verb: "status_running" });
  assert.equal(s.eng.gets, 0, "the status read never adopts a session (P10)");
});

test("needs-you: a session waiting on the operator is never quiet, however old (P10)", async () => {
  const s = await setup();
  const { id, cardId } = await s.handoff({ session: "s1" });
  await s.session({ sid: "s1", cardId, status: "waiting-user", agoMs: 45 * MIN });
  s.eng.waiting.add(cardId);
  assert.deepEqual(await s.ask("how's writer doing"), { say: "Writer needs an answer from you. Check your phone.", verb: "status_needs_you" });
  assert.equal((await s.row(id)).status, "started", "never quiet");
  assert.deepEqual((await s.sweep.runOnce()).reconciled, { rows: 1, ended: 0, quiet: 0, resumed: 0, done: 0 }, "the sweep leaves it too");
  assert.equal((await s.row(id)).status, "started");
});

test("done and failed: ended rows within the hour answer from the log", async () => {
  const s = await setup();
  await s.handoff({ status: "done" });
  assert.deepEqual(await s.ask("how's writer doing"), { say: "Writer finished research radio history. It's on your phone.", verb: "status_done" });
  const t = await setup();
  await t.handoff({ status: "failed", detail: "The archive is offline." });
  assert.deepEqual(await t.ask("is the writer done"), { say: "Writer couldn't finish research radio history.", verb: "status_failed" });
});

test("a session that ended without a result is reported, and the row is failed", async () => {
  const s = await setup();
  const { id, cardId } = await s.handoff({ session: "s1" });
  await s.session({ sid: "s1", cardId, status: "stopped" });
  assert.deepEqual(await s.ask("how's writer doing"), { say: "Writer stopped without saying it was done. The card is still on Writer's board.", verb: "status_ended_quiet" });
  const r = await s.row(id);
  assert.equal(r.status, "failed");
  assert.equal(r.detail, "session_ended_no_result");
  assert.equal(r.ended_at, T0);
  assert.equal(RR.requesterOf(cardId), null, "the claim is released");
  assert.deepEqual(s.notifications, [{
    type: "attention", priority: "high",
    title: "Writer stopped without finishing research radio history. The card is still on Writer's board.",
    action_url: `/dashboard/bot-board?bot=writer#open=${cardId}`,
  }], "one handoff_ended_no_result notification, in handoff_start_failed's shape, opening the card [rv5 m3]");
  await flush();
  assert.equal(s.announced.length, 1, "the heads-up when the operator is present");
  assert.equal(s.announced[0].originDeviceId, DEVICE.id);
  assert.equal(s.announced[0].handoffId, id);
  assert.equal(s.announced[0].lineFor("phone"), "Writer stopped without finishing research radio history. The card is still on Writer's board.");
  assert.equal(s.announced[0].lineFor("kiosk"), "Writer stopped without finishing a task. The card is still on Writer's board.", "a kiosk never hears the task (P34)");
  // Asked again: the row is read as it is now, and nothing is sent twice.
  assert.deepEqual(await s.ask("how's writer doing"), { say: "Writer stopped without saying it was done. The card is still on Writer's board.", verb: "status_ended_quiet" });
  assert.equal(s.notifications.length, 1);
  assert.deepEqual(s.logs, []);
});

test("the notification and the heads-up follow the row's language, the answer the turn's", async () => {
  const s = await setup();
  const { cardId } = await s.handoff({ session: "s1", lang: "es" });
  await s.session({ sid: "s1", cardId, status: "stopped" });
  assert.equal((await s.ask("how's writer doing")).say, "Writer stopped without saying it was done. The card is still on Writer's board.");
  assert.equal(s.notifications[0].title, "Writer se detuvo sin terminar: research radio history. La tarjeta sigue en el tablero de Writer.");
  await flush();
  assert.equal(s.announced[0].lineFor("kiosk"), "Writer se detuvo sin terminar una tarea. La tarjeta sigue en el tablero de Writer.");
});

test("a taint-stopped hand-off session sends one handoff_ended_no_result notification, and a second sweep sends none [rv5 m3]", async () => {
  const s = await setup();
  // The engine stopped the session by itself (recordOutsideTaintSync's stop): the row still says started.
  const { id, cardId } = await s.handoff({ session: "s1" });
  await s.session({ sid: "s1", cardId, status: "stopped" });
  const first = await s.sweep.runOnce();
  assert.deepEqual(first.reconciled, { rows: 1, ended: 1, quiet: 0, resumed: 0, done: 0 });
  assert.equal((await s.row(id)).detail, "session_ended_no_result");
  assert.equal(s.notifications.length, 1);
  assert.equal(RR.requesterOf(cardId), null);
  const second = await s.sweep.runOnce();
  assert.deepEqual(second.reconciled, { rows: 0, ended: 0, quiet: 0, resumed: 0, done: 0 }, "a failed row is not reconciled again");
  assert.equal(s.notifications.length, 1, "sent once per row");
  await flush();
  assert.equal(s.announced.length, 1);
});

test("the status read and the sweep racing send one notification", async () => {
  const s = await setup();
  const { id, cardId } = await s.handoff({ session: "s1" });
  await s.session({ sid: "s1", cardId, status: "stopped" });
  const [answer, swept] = await Promise.all([s.ask("how's writer doing"), s.sweep.runOnce()]);
  assert.equal(answer.verb, "status_ended_quiet", "whoever lost the CAS still answers truthfully");
  assert.equal((await s.row(id)).status, "failed");
  assert.equal(s.notifications.length, 1, "only the CAS winner sends");
  assert.equal(swept.reconciled.rows, 1);
});

test("a session waiting 31 min with no result and no question is quiet, keeps its claim, and a later report gets the hand-off notice [rv2 N2]", async () => {
  const s = await setup();
  const { id, cardId } = await s.handoff({ session: "s1" });
  await s.session({ sid: "s1", cardId, status: "waiting-user", agoMs: 31 * MIN });
  assert.deepEqual(await s.ask("how's writer doing"), { say: "Writer paused without reporting a result. Its session is waiting on Writer's board.", verb: "status_waiting_quiet" });
  assert.equal((await s.row(id)).status, "quiet");
  assert.equal(RR.requesterOf(cardId), "voice", "the claim is kept");
  assert.deepEqual(s.notifications, [], "quiet is not an end: nothing is pushed");
  // Asked again while quiet: the same answer, no second transition.
  assert.equal((await s.ask("how's writer doing")).verb, "status_waiting_quiet");
  // The bot wakes up and reports: the completion rail's own notice, and the row is done.
  const r = await s.report(cardId);
  assert.equal(r.status, "recorded");
  assert.deepEqual((await s.dbNotifications()).map((x) => x.title), ["Writer finished: research radio history"]);
  assert.equal((await s.row(id)).status, "done");
  assert.equal(RR.requesterOf(cardId), null);
});

test("one waiting 29 min is still running; at 30 the sweep makes it quiet, and an active session brings it back", async () => {
  const s = await setup();
  const { id, cardId } = await s.handoff({ session: "s1" });
  await s.session({ sid: "s1", cardId, status: "waiting-user", agoMs: 29 * MIN });
  assert.equal((await s.ask("how's writer doing")).verb, "status_running");
  assert.equal((await s.row(id)).status, "started");
  assert.equal(HANDOFF_QUIET_AFTER_MS, 30 * MIN);
  s.now.advance(MIN);
  assert.deepEqual((await s.sweep.runOnce()).reconciled, { rows: 1, ended: 0, quiet: 1, resumed: 0, done: 0 });
  assert.equal((await s.row(id)).status, "quiet");
  await s.setSession("s1", "active");
  assert.deepEqual((await s.sweep.runOnce()).reconciled, { rows: 1, ended: 0, quiet: 0, resumed: 1, done: 0 });
  assert.equal((await s.row(id)).status, "started", "an active session moves a quiet row back [rv2 N2]");
  assert.equal((await s.ask("how's writer doing")).verb, "status_running");
});

test("a quiet row read with a session that is not active stays quiet; the hibernate bump is accepted (P11)", async () => {
  const s = await setup();
  const { id, cardId } = await s.handoff({ status: "quiet", session: "s1" });
  await s.session({ sid: "s1", cardId, status: "waiting-user", agoMs: 2 * MIN });
  assert.equal((await s.ask("how's writer doing")).verb, "status_waiting_quiet");
  assert.equal((await s.row(id)).status, "quiet");
  // updated_at is UTC: a row stamped in the local zone's reading would be hours off, and this one is read as 31 min old exactly.
  const t = await setup();
  const b = await t.handoff({ session: "s2" });
  await t.db.execute({ sql: "INSERT INTO bot_sessions (bot_id, gateway_thread_id, kind, status, card_id, updated_at) VALUES ('writer', 's2', 'perch-live', 'waiting-user', ?, ?)", args: [b.cardId, sqlTime(T0 - 31 * MIN)] });
  assert.equal(S.utcMs(sqlTime(T0 - 31 * MIN)), T0 - 31 * MIN);
  assert.equal(S.utcMs("not a time"), null);
  assert.equal((await t.ask("how's writer doing")).verb, "status_waiting_quiet");
});

test("stopping is a stopped row with no session yet; one with a session was stopped, a retried stop included", async () => {
  const s = await setup();
  await s.handoff({ status: "stopped", detail: "pending_start" });
  assert.deepEqual(await s.ask("how's writer doing"), { say: "Writer's task will stop as soon as Writer finishes starting up.", verb: "status_stopping" });
  const t = await setup();
  await t.handoff({ status: "stopped", session: "s1" });
  assert.deepEqual(await t.ask("how's writer doing"), { say: "Writer's task was stopped. What it made so far is kept.", verb: "status_stopped" });
  const u = await setup();
  await u.handoff({ status: "stopped", session: "s2", detail: "stop_pending" });
  assert.equal((await u.ask("how's writer doing")).verb, "status_stopped", "the engine stop is still being retried, but the session exists");
  const v = await setup();
  await v.handoff({ status: "stopped" });
  assert.equal((await v.ask("how's writer doing")).verb, "status_stopped", "a stop while queued: no session, no pending start");
});

test("a named question about the work is a status question, not a hand-off request", async () => {
  const s = await setup();
  const { cardId } = await s.handoff({ session: "s1" });
  await s.session({ sid: "s1", cardId, status: "active" });
  for (const t of ["is writer done with the research", "how's writer doing on that research", "how's writer doing with the report", "como va writer con el informe", "ya terminó writer el informe"]) {
    assert.equal((await s.ask(t))?.verb, "status_running", t);
  }
});

test("a bot that is no longer a candidate is still asked about by name (hand-offs off, a row open)", async () => {
  const s = await setup();
  const { cardId } = await s.handoff({ session: "s1" });
  await s.session({ sid: "s1", cardId, status: "active" });
  const off = { ...VOICE, handoff: { enabled: false, allowed_bots: [] } };
  assert.deepEqual(await s.ask("how's writer doing", { bot: off }), { say: "Writer is working on research radio history.", verb: "status_running" });
  assert.equal((await s.ask("is the writer done", { bot: null })).verb, "status_running", "no voice def at all");
  assert.equal((await s.ask("como va writer", { bot: off, lang: "es" })).verb, "status_running");
  assert.equal(await s.ask("how's my mom doing", { bot: off }), null, "the shape alone is not enough: the name must be a row's bot");
  assert.equal(await s.ask("is dinner done", { bot: off }), null);
  assert.equal(await s.ask("how's helper doing", { bot: off }), null, "helper has no row and is not a candidate: the model");
});

test("a compound utterance that also asks for a hand-off goes to the model, even with the bot named", async () => {
  const s = await setup();
  const { cardId } = await s.handoff({ session: "s1" });
  await s.session({ sid: "s1", cardId, status: "active" });
  for (const t of ["how's it going, have writer research the bus routes", "is writer done? then have helper write up the bus routes", "como va writer, y pidele a helper que investigue las rutas"]) {
    assert.equal(await s.ask(t), null, t);
  }
  assert.equal((await s.ask("how's writer doing")).verb, "status_running", "a plain status question still answers");
  assert.equal(await s.ask("how's it going, have writer research the bus routes", { bot: null }), null, "no candidates: a plain word still names the bot from its row, and the ask is still the model's");
});

test("the newer of the row's session and the card's newest session speaks for the hand-off (P11)", async () => {
  const s = await setup();
  const { id, cardId } = await s.handoff({ session: "s1" });
  await s.session({ sid: "s1", cardId, status: "stopped" });
  // The card was re-run by hand: a newer perch-live session holds it and is active.
  await s.session({ sid: "s9", cardId, status: "active" });
  assert.equal((await s.ask("how's writer doing")).verb, "status_running");
  assert.equal((await s.row(id)).status, "started");
  assert.deepEqual(s.notifications, []);
  // The other way round: the row's session is the newer one and it stopped.
  const t = await setup();
  const b = await t.handoff({ session: "s2" });
  await t.session({ sid: "old", cardId: b.cardId, status: "active" });
  await t.session({ sid: "s2", cardId: b.cardId, status: "stopped" });
  assert.equal((await t.ask("how's writer doing")).verb, "status_ended_quiet");
});

test("a CAS lost to a quiet move answers waiting-quiet, not running", async () => {
  const s = await setup();
  const { id, cardId } = await s.handoff({ session: "s1" });
  await s.session({ sid: "s1", cardId, status: "stopped" });
  const real = s.store.transition;
  s.store.transition = async (db, rid, from, to, ...rest) => {
    if (to === "failed") { await real(db, rid, ["started"], "quiet"); return false; }   // someone else moved it first
    return real(db, rid, from, to, ...rest);
  };
  assert.equal((await s.ask("how's writer doing")).verb, "status_waiting_quiet");
  assert.equal((await s.row(id)).status, "quiet");
  assert.deepEqual(s.notifications, [], "a lost CAS sends nothing");
});

test("a named bot with nothing in scope: status_none, never the model", async () => {
  const s = await setup();
  assert.deepEqual(await s.ask("how's writer doing"), { say: "There's nothing handed off right now.", verb: "status_none" });
  await s.handoff();
  assert.deepEqual(await s.ask("how's helper doing"), { say: "There's nothing handed off right now.", verb: "status_none" });
  assert.deepEqual(await s.ask("any news on helper"), { say: "There's nothing handed off right now.", verb: "status_none" });
  assert.deepEqual(await s.ask("como va helper", { lang: "es" }), { say: "Ahora mismo no hay nada encargado.", verb: "status_none" });
});

test("two open hand-offs asks which; the answer names the bot and proposes nothing (P18)", async () => {
  const s = await setup();
  const a = await s.handoff({ session: "s1" });
  await s.session({ sid: "s1", cardId: a.cardId, status: "active" });
  s.now.advance(1000);
  const b = await s.handoff({ bot: "helper", session: "s2" });
  await s.session({ sid: "s2", cardId: b.cardId, bot: "helper", status: "active" });
  assert.deepEqual(await s.ask("how's the research going"), { say: "Helper and Writer are working on things. Which one?", verb: "status_which" });
  const e = s.pending.get(DEVICE.id);
  assert.equal(e.kind, "which");
  assert.equal(e.purpose, "status");
  assert.deepEqual(e.options.map((o) => o.bot_id), ["helper", "writer"]);
  assert.deepEqual(await s.ask("writer"), { say: "Writer is working on research radio history.", verb: "status_running" });
  assert.equal(s.pending.get(DEVICE.id), null, "answered: the entry is taken");
  assert.equal((await s.tdb.execute("SELECT COUNT(*) AS n FROM tasks_items")).rows[0].n, 2, "no card was proposed or created");
  // A no lets it go; an unrelated reply leaves it waiting; a fresh status question answers and takes it.
  await s.ask("how's the research going");
  assert.deepEqual(await s.ask("no"), { say: "Okay, I won't.", verb: "handoff_declined" });
  assert.equal(s.pending.get(DEVICE.id), null);
  await s.ask("how's the research going");
  assert.equal(await s.ask("what's on the menu"), null);
  assert.equal(s.pending.get(DEVICE.id).purpose, "status", "still waiting");
  assert.equal((await s.ask("how's helper doing")).say, "Helper is working on research radio history.");
  assert.equal(s.pending.get(DEVICE.id), null);
  // The model is told what is waited on, and not to guess.
  await s.ask("how's the research going");
  assert.deepEqual(s.actions.turnContext({ device: DEVICE }), { text: "[Hand-off] Waiting for which bot's task the user is asking about: Helper or Writer. Do not guess at its progress.", pending: true });
  // Spanish list.
  assert.equal((await s.ask("como va la investigacion", { lang: "es" })).say, "Helper y Writer están trabajando en cosas. ¿Cuál?");
});

test("the named bot wins over the which, and the same bot's newest open row is the one", async () => {
  const s = await setup();
  const a = await s.handoff({ session: "s1" });
  await s.session({ sid: "s1", cardId: a.cardId, status: "active" });
  const b = await s.handoff({ bot: "helper", status: "queued" });
  assert.deepEqual(await s.ask("how's helper doing"), { say: "Helper hasn't started research radio history yet. It's waiting on Helper's board.", verb: "status_queued" });
  assert.equal(s.pending.get(DEVICE.id), null, "no which");
  s.now.advance(1000);
  const c = await s.handoff({ status: "queued" });
  assert.equal((await s.ask("how's writer doing")).verb, "status_queued", "writer's newest open row");
  assert.deepEqual(topicFor(s.core, DEVICE.id), { id: c.id });
  void b;
});

/* ---------- The fast path never takes ordinary speech ---------- */

test("a greeting is not a status question, nor is the election, the game, the song or the timer", async () => {
  const s = await setup();
  const { cardId } = await s.handoff({ session: "s1" });
  await s.session({ sid: "s1", cardId, status: "active" });
  for (const t of ["any news on the election", "how's the game going", "como va el partido", "ya terminó la canción", "how's it going?", "hi there, how's it going", "is the timer done?", "how is it going to rain today", "what time is it"]) {
    assert.equal(await s.ask(t), null, t);
  }
  assert.equal(s.pending.get(DEVICE.id), null);
  assert.deepEqual(s.notifications, []);
});

test("a bare \"how's it going?\" with nothing in scope goes to the model, even right after a topic", async () => {
  const s = await setup();
  assert.equal(await s.ask("how's it going?"), null);
  s.core.lastHandoffTopic.set(DEVICE.id, { id: "vh-0000000000000000", exchange: 0, at: T0 });
  assert.equal(await s.ask("how's it going?"), null, "a topic that is not in scope is no topic");
});

test("a bare question answers within two exchanges of a hand-off topic on this device, then not (P16, P17)", async () => {
  const s = await setup();
  const { id, cardId } = await s.handoff({ session: "s1" });
  await s.session({ sid: "s1", cardId, status: "active" });
  assert.equal(HANDOFF_TOPIC_EXCHANGES, 2);
  assert.equal(await s.ask("how's it going?"), null, "no topic yet");
  assert.equal((await s.ask("how's writer doing")).verb, "status_running");   // the exchange that set the topic
  await s.afterTurn();
  assert.equal(s.core.lastHandoffTopic.get(DEVICE.id).id, id);
  await s.afterTurn();                                                          // exchange 1 after
  assert.equal((await s.ask("hey crow, how's it going?")).verb, "status_running", "within two exchanges");
  await s.afterTurn();                                                          // the status answer renewed the topic: its own turn
  await s.afterTurn();
  await s.afterTurn();
  assert.equal((await s.ask("is it done yet?")).verb, "status_running", "two exchanges on: still about it");
  await s.afterTurn();                                                          // renewed again: its own turn
  await s.afterTurn();
  await s.afterTurn();
  await s.afterTurn();
  assert.equal(await s.ask("is it done yet?"), null, "three exchanges on: the model's turn");
  assert.equal(await s.ask("how's it going?", { device: KIOSK, surface: "kiosk" }), null, "another device has no topic");
  // "Is it done?" on the phone right after a status answer is about it.
  assert.equal((await s.ask("is the research done")).verb, "status_running");
  assert.equal((await s.ask("¿ya terminó?", { lang: "es" })).say, "Writer está trabajando en: research radio history.");
});

test("a spoken heads-up makes the hand-off the device's topic between turns; a kiosk's queued line counts (5.2 carry)", async () => {
  const s = await setup();
  const { id, cardId } = await s.handoff({ session: "s1", surface: "kiosk", device: KIOSK });
  await s.session({ sid: "s1", cardId, status: "active" });
  s.core.announce = async () => ({ spokenOn: KIOSK.id, surface: "kiosk" });
  await announceHandoff(s.core, id, { originDeviceId: KIOSK.id, lineFor: () => "x" });
  assert.deepEqual(s.core.lastHandoffTopic.get(KIOSK.id), { id, exchange: 0, at: T0 }, "said between turns: the next turn is the first after it");
  await s.afterTurn(KIOSK);
  await s.afterTurn(KIOSK);
  assert.deepEqual(await s.ask("how's it going?", { device: KIOSK, surface: "kiosk" }), { say: "Writer is working on the task.", verb: "status_running" }, "the second exchange after it");
  assert.deepEqual(s.core.lastHandoffTopic.get(KIOSK.id), { id, exchange: 3, at: T0 }, "renewed by the answer, as its own exchange");
  for (let i = 0; i < 4; i++) await s.afterTurn(KIOSK);
  assert.equal(await s.ask("how's it going?", { device: KIOSK, surface: "kiosk" }), null, "three exchanges on");
  assert.equal(bumpExchange(s.core, KIOSK.id), 7);
});

test("a work phrase answers only with something in scope; an hour-old end is out of scope", async () => {
  const s = await setup();
  assert.equal(await s.ask("how's the research going"), null, "nothing in scope: the model");
  assert.equal(await s.ask("is the report done"), null);
  const { id } = await s.handoff({ status: "done" });
  assert.equal((await s.ask("how's the research going")).verb, "status_done");
  s.now.advance(59 * MIN);
  assert.equal((await s.ask("is the report done")).verb, "status_done", "within the hour");
  s.now.advance(2 * MIN);
  assert.equal(await s.ask("is the report done"), null, "over an hour: out of scope");
  assert.equal((await s.ask("is writer done")).verb, "status_none", "a named bot still answers");
  void id;
});

/* ---------- Results, partials and the card ---------- */

test("status reads the card's result when the log row missed it, and ends the row without a second notice", async () => {
  const s = await setup();
  const { id, cardId } = await s.handoff({ session: "s1" });
  await s.session({ sid: "s1", cardId, status: "stopped" });
  await s.result(cardId, "success", "Done: the write-up is ready. ".repeat(20));
  assert.deepEqual(await s.ask("how's writer doing"), { say: "Writer finished research radio history. It's on your phone.", verb: "status_done" });
  const r = await s.row(id);
  assert.equal(r.status, "done");
  assert.equal(r.outcome, "success");
  assert.equal(r.detail, "Done: the write-up is ready. ".repeat(20).slice(0, 300));
  assert.equal(RR.requesterOf(cardId), null);
  assert.deepEqual(s.notifications, [], "a result wins over the stopped session, and sends no end-without-result notice");
  const t = await setup();
  const b = await t.handoff({ status: "queued" });
  await t.result(b.cardId, "failure", "Could not reach the archive.");
  assert.deepEqual(await t.ask("how's writer doing"), { say: "Writer couldn't finish research radio history.", verb: "status_failed" });
  assert.equal((await t.row(b.id)).status, "failed");
});

test("a partial result is progress, not an end (P12)", async () => {
  const s = await setup();
  const { id, cardId } = await s.handoff({ session: "s1" });
  await s.session({ sid: "s1", cardId, status: "active" });
  await s.result(cardId, "partial", "Half way.");
  assert.equal((await s.ask("how's writer doing")).verb, "status_running");
  assert.equal((await s.row(id)).status, "started");
  assert.equal(RR.requesterOf(cardId), "voice");
  assert.deepEqual((await s.sweep.runOnce()).reconciled, { rows: 1, ended: 0, quiet: 0, resumed: 0, done: 0 });
});

test("the sweep ends a started row whose card already has a final result", async () => {
  const s = await setup();
  const { id, cardId } = await s.handoff({ session: "s1" });
  await s.result(cardId, "success");
  assert.deepEqual((await s.sweep.runOnce()).reconciled, { rows: 1, ended: 0, quiet: 0, resumed: 0, done: 1 });
  assert.equal((await s.row(id)).status, "done");
});

test("a started row with no session row yet is running, and a session found by card is read (P11)", async () => {
  const s = await setup();
  const { id, cardId } = await s.handoff({ session: "s1" });
  assert.equal((await s.ask("how's writer doing")).verb, "status_running");
  assert.equal((await s.row(id)).status, "started");
  // A queued card dispatched by hand: the session names the card, not the row's session id.
  await s.session({ sid: "other", cardId, status: "stopped" });
  assert.equal((await s.ask("how's writer doing")).verb, "status_ended_quiet");
  // Another bot's session on the same card is not this hand-off's.
  const t = await setup();
  const b = await t.handoff({ session: "s3" });
  await t.session({ sid: "helper-s", cardId: b.cardId, bot: "helper", status: "stopped" });
  assert.equal((await t.ask("how's writer doing")).verb, "status_running");
});

test("rows that were never open are never answered (reconcileRow), and the store scopes ended rows (P14, P23)", async () => {
  const s = await setup();
  const { id } = await s.handoff({ status: "proposed", card: false });
  assert.equal(await S.reconcileRow(s.core, s.db, await s.row(id)), null);
  const k = await s.handoff({ status: "done", surface: "kiosk", device: KIOSK });
  const p = await s.handoff({ status: "failed" });
  assert.deepEqual((await s.store.endedSince(s.db, T0 - MIN, { deviceId: KIOSK.id })).map((r) => r.id), [k.id]);
  assert.deepEqual((await s.store.endedSince(s.db, T0 - MIN, { personal: true })).map((r) => r.id), [p.id]);
  assert.deepEqual((await s.store.endedSince(s.db, T0 - MIN, { all: true })).map((r) => r.id).sort(), [k.id, p.id].sort(), "every surface");
  assert.deepEqual(await s.store.endedSince(s.db, T0 - MIN), [], "no scope, no rows");
  assert.deepEqual(await s.store.endedSince(s.db, T0 + 1, { personal: true }), []);
  await assert.rejects(s.store.endedSince(s.db, "soon", { personal: true }), /needs a time/);
  await assert.rejects(s.store.openRows(s.db, { statuses: ["bogus"] }), /unknown status/);
  assert.deepEqual((await s.store.openRows(s.db)).length, 0);
});

/* ---------- Scope ---------- */

test("a kiosk hears only its own hand-offs, without the task text; the phone hears every device's (amended P23)", async () => {
  const s = await setup();
  const { cardId } = await s.handoff({ session: "s1", surface: "kiosk", device: KIOSK });
  await s.session({ sid: "s1", cardId, status: "active" });
  assert.deepEqual(await s.ask("how's writer doing", { device: KIOSK, surface: "kiosk" }), { say: "Writer is working on the task.", verb: "status_running" });
  assert.deepEqual(await s.ask("como va writer", { device: KIOSK, surface: "kiosk", lang: "es" }), { say: "Writer está trabajando en: la tarea.", verb: "status_running" });
  assert.deepEqual(await s.ask("how's writer doing", { device: { id: "kiosk-2", name: "Hall" }, surface: "kiosk" }), { say: "There's nothing handed off right now.", verb: "status_none" }, "another kiosk sees nothing (P23)");
  assert.deepEqual(await s.ask("how's writer doing"), { say: "Writer is working on research radio history.", verb: "status_running" }, "the phone hears about the kiosk's hand-off, with the task");
  assert.equal((await s.ask("how's writer doing", { device: { id: "glasses-1" }, surface: "glasses" })).verb, "status_running", "the glasses too");
  assert.equal(await s.ask("how's the research going", { device: { id: "kiosk-2" }, surface: "kiosk" }), null);
  // The glasses see the phone's hand-off: every personal row.
  const { cardId: c2 } = await s.handoff({ session: "s2", surface: "glasses", device: { id: "glasses-1", name: "Glasses" } });
  await s.session({ sid: "s2", cardId: c2, status: "active" });
  assert.equal((await s.ask("how's writer doing", { surface: "phone" })).verb, "status_running");
  assert.equal((await s.ask("how's writer doing", { device: { id: "glasses-1" }, surface: "glasses" })).verb, "status_running");
});

test("a pending hand-off proposal is answered first; a status question meanwhile goes to the model", async () => {
  const s = await setup();
  const { cardId } = await s.handoff({ session: "s1" });
  await s.session({ sid: "s1", cardId, status: "active" });
  s.pending.set(DEVICE.id, { kind: "handoff", id: "vh-0000000000000001", bot_id: "helper", name: "Helper", task: "x", names: [] });
  assert.equal(await s.ask("how's writer doing"), null, "the proposal is what is waited on");
  s.pending.take(DEVICE.id);
  assert.equal((await s.ask("how's writer doing")).verb, "status_running");
});

/* ---------- No model call; never on a relay turn ---------- */

function withTurn(s, rounds) {
  const h = harness({ bot: VOICE, chatTools: [], rounds });
  h.deps.handoffs = { forTurn: (c) => s.core.forTurn({ ...c, pending: s.pending }) };
  h.deps.voiceActions = chainVoiceActions([s.actions]);
  const turn = (transcript, opts = {}) => h.runner.runVoiceTurn({ db: s.db, device: { ...h.device, ...DEVICE }, transcript, sink: h.sink, surface: "phone", lang: "en", ...opts });
  return { h, turn };
}

test("no model call: a status question through the turn is a fast path, and a relay turn never reaches it", async () => {
  const s = await setup();
  const { cardId } = await s.handoff({ session: "s1" });
  await s.session({ sid: "s1", cardId, status: "active" });
  const { h, turn } = withTurn(s, [says("I think writer is nearly done.")]);
  const r = await turn("how's writer doing?");
  assert.equal(r.fastPath, true);
  assert.equal(r.timings.verb, "status_running");
  assert.deepEqual(h.calls.spoken, ["Writer is working on research radio history."]);
  assert.equal(h.log.length, 0, "no model round");
  assert.equal(s.core.exchanges.get(DEVICE.id), 1, "the turn counted one exchange");
  // The relay contract: the words are not the operator's; the model answers and the status path is never asked.
  const t = await setup();
  const b = await t.handoff({ session: "s2" });
  await t.session({ sid: "s2", cardId: b.cardId, status: "active" });
  const rt = withTurn(t, [says("Okay. ")]);
  const rr = await rt.turn("how's writer doing?", { relayThreadId: "thread-1" });
  assert.equal(rr.fastPath, false);
  assert.equal(rt.h.log.length, 1, "the model answered");
  assert.equal(topicFor(t.core, DEVICE.id), null, "no topic was set by a relay");
});

test("through the runner: a which-status question, answered by a bot's name, gets that bot's answer (e; PR 6 fix round 1)", async () => {
  const s = await setup();
  const a = await s.handoff({ session: "s1" });
  await s.session({ sid: "s1", cardId: a.cardId, status: "active" });
  s.now.advance(1000);
  const b = await s.handoff({ bot: "helper", session: "s2" });
  await s.session({ sid: "s2", cardId: b.cardId, bot: "helper", status: "active" });
  const { h, turn } = withTurn(s, []);
  assert.equal((await turn("how's the research going")).timings.verb, "status_which");
  assert.equal(s.pending.get(DEVICE.id).purpose, "status", "the asking turn's own afterTurn keeps the question");
  const r = await turn("writer");
  assert.equal(r.fastPath, true);
  assert.equal(r.timings.verb, "status_running");
  assert.equal(h.calls.spoken.at(-1), "Writer is working on research radio history.");
  assert.equal(s.pending.get(DEVICE.id), null);
  assert.equal(h.log.length, 0, "no model round");
});

/* ---------- The lines ---------- */

test("the status lines are the plan's, in both languages", () => {
  const exact = {
    status_queued: ["{bot} hasn't started {task} yet. It's waiting on {bot}'s board.", "{bot} aún no ha empezado: {task}. Está esperando en el tablero de {bot}."],
    status_starting: ["{bot} is still starting up for {task}.", "{bot} todavía se está poniendo en marcha para: {task}."],
    status_running: ["{bot} is working on {task}.", "{bot} está trabajando en: {task}."],
    status_needs_you: ["{bot} needs an answer from you. Check your phone.", "{bot} necesita una respuesta tuya. Mira el teléfono."],
    status_done: ["{bot} finished {task}. It's on your phone.", "{bot} terminó: {task}. Lo tienes en el teléfono."],
    status_failed: ["{bot} couldn't finish {task}.", "{bot} no pudo terminar: {task}."],
    status_ended_quiet: ["{bot} stopped without saying it was done. The card is still on {bot}'s board.", "{bot} se detuvo sin decir que había terminado. La tarjeta sigue en el tablero de {bot}."],
    handoff_ended_no_result: ["{bot} stopped without finishing {task}. The card is still on {bot}'s board.", "{bot} se detuvo sin terminar: {task}. La tarjeta sigue en el tablero de {bot}."],
    ended_no_result_spoken_kiosk: ["{bot} stopped without finishing a task. The card is still on {bot}'s board.", "{bot} se detuvo sin terminar una tarea. La tarjeta sigue en el tablero de {bot}."],
    status_waiting_quiet: ["{bot} paused without reporting a result. Its session is waiting on {bot}'s board.", "{bot} se pausó sin informar de un resultado. Su sesión espera en el tablero de {bot}."],
    status_stopping: ["{bot}'s task will stop as soon as {bot} finishes starting up.", "La tarea de {bot} se parará en cuanto {bot} termine de arrancar."],
    status_stopped: ["{bot}'s task was stopped. What it made so far is kept.", "La tarea de {bot} se paró. Lo que hizo hasta ahora se queda."],
    status_none: ["There's nothing handed off right now.", "Ahora mismo no hay nada encargado."],
    status_which: ["{list} are working on things. Which one?", "{list} están trabajando en cosas. ¿Cuál?"],
    status_task_kiosk: ["the task", "la tarea"],
  };
  for (const [key, [en, es]] of Object.entries(exact)) {
    assert.equal(VOICE_LINES.en[key], en, `en ${key}`);
    assert.equal(VOICE_LINES.es[key], es, `es ${key}`);
  }
  assert.equal(line("status_running", { lang: "es" }), "Writer está trabajando en: research radio history.");
  assert.equal(voiceLine("list_and", "en", { rest: "Writer, Helper", last: "Plain" }), "Writer, Helper and Plain");
});
