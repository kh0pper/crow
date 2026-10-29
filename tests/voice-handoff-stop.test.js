/**
 * "Stop it" (PR 5, Task 5.4): the operator asks Crow to stop a handed-off job. Crow asks first (a spoken yes
 * on a phone or the glasses; the phone page for a kiosk), then stops the bot's session and keeps anything it
 * made: the card stays where it is, nothing is archived or deleted. A scratch init-db'd crow.db plus a
 * tasks.db per test, the real store, give-service and voice-bot loader, the confirm tests' controllable fake
 * engine (a held spawn, stop, watchTurns), a fake clock, and the real turn runner for the media cases.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, copyFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import Database from "better-sqlite3";
import { harness } from "./fixtures/voice-turn-harness.mjs";

const root = mkdtempSync(join(tmpdir(), "vh-stop-"));
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
const { DASHBOARD_ACTOR } = await import("../servers/gateway/board/give-service.js");
const { createHandoffCore, createHandoffVoiceActions, startHandoffSweep, registerVoiceResultKind, proposeHandoff, HANDOFF_TOOL_NAME, phoneConfirmPath } = await import("../servers/gateway/voice/handoff.js");
const { createHandoffStore } = await import("../servers/gateway/voice/handoff-store.js");
const { createSummaryCache } = await import("../servers/gateway/voice/bot-summaries.js");
const { createPendingStore, chainVoiceActions } = await import("../servers/gateway/voice/pending.js");
const { botDefsGeneration } = await import("../servers/gateway/voice/defs-generation.js");
const { createVoiceBotLoader } = await import("../servers/gateway/voice/crow-voice.js");
const { voiceLine, VOICE_LINES } = await import("../servers/gateway/voice/voice-lines.js");
const { HANDOFF_START_BUDGET_MS, HANDOFF_PHONE_TTL_MS } = await import("../servers/gateway/voice/handoff-constants.js");
const RR = await import("../servers/gateway/board/result-requesters.js");
const P = await import("../servers/gateway/perch-interactive.js");
const { CROW_VOICE_BOT_ID } = await import("../servers/shared/voice-bot.js");

const VOICE = { bot_id: CROW_VOICE_BOT_ID, kind: "voice", display_name: "Crow", fast_voice_model: "crow-voice/qwen3.5-4b", handoff: { enabled: true, allowed_bots: [] } };
const board = (over = {}) => ({ gateways: [{ type: "perch" }], tracker_config: { type: "kanban" }, models: { default: "prov/model-a" }, ...over });
const TASK = "research radio history";
const ASK = "have writer research radio history";
const DEVICE = { id: "phone-1", name: "Phone" };
const KIOSK = { id: "kiosk-1", name: "Kitchen" };
const WRITER = { kind: "bot", id: "writer", jobId: null };
const HUMAN = { kind: "human", id: "alex", jobId: null };
const T0 = 1_800_000_000_000;
const MIN = 60_000;
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
const says = (t) => [{ type: "content_delta", text: t }, { type: "done" }];
const call = (args, id = "h1") => [{ type: "tool_call", id, name: HANDOFF_TOOL_NAME, arguments: args }, { type: "done" }];
const noSession = () => Object.assign(new Error("no_such_session"), { code: "no_such_session" });
function deferred() { let res, rej; const promise = new Promise((a, b) => { res = a; rej = b; }); return { promise, res, rej }; }
const line = (key, { lang = "en", bot = "Writer", task = TASK, ...vars } = {}) => voiceLine(key, lang, { bot, task, ...vars });

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
  return { db, tdb, dir, crow, tasks };
}

function clock(start = T0) {
  let t = start;
  let timers = [];
  const now = () => t;
  now.advance = (ms) => {
    t += ms;
    const due = timers.filter((x) => x.at <= t);
    timers = timers.filter((x) => x.at > t);
    for (const x of due) x.res();
  };
  now.wait = (ms) => new Promise((res) => timers.push({ at: t + ms, res }));
  return now;
}

/** The confirm tests' engine: a controllable spawn (`hold`), stop, watchTurns; `get`/`resolveSession` are faults (P10). */
function fakeEngine() {
  const sessions = new Map();
  const calls = { spawn: [], stop: [], watched: [], minted: 0 };
  let k = 0;
  const eng = {
    calls, sessions, hold: null,
    checkCardFree: async () => {},
    async spawn(args) {
      const sessionId = "s" + (++k);
      sessions.set(sessionId, { sessionId, cardId: args.cardId, watchers: new Set() });
      calls.spawn.push({ ...args, sessionId });
      if (eng.hold) await eng.hold.promise;
      return { sessionId, threadId: "t-" + sessionId, state: "starting" };
    },
    async message() {},
    watchTurns(sid, fn) { const s = sessions.get(sid); if (!s) throw noSession(); calls.watched.push(sid); s.watchers.add(fn); return () => s.watchers.delete(fn); },
    suppressTurnEndPush: () => false,
    waitingOnCard: () => false,
    get() { throw new Error("a stop never reads a session through get"); },
    resolveSession() { throw new Error("a stop never adopts through resolveSession"); },
    async stop(sid) {
      calls.stop.push(sid);
      const s = sessions.get(sid);
      if (!s) throw noSession();
      s.watchers.clear();
      s.stopped = true;
      return { ok: true };
    },
  };
  return eng;
}

beforeEach(() => { RR._resetResultRequestersForTest(); P._resetInteractiveEngineForTest(); setStatus({ state: "ready", source: "test", cliPath: "/nonexistent/pi" }); });

async function setup({ avail = {}, notify = "ok" } = {}) {
  const { db, tdb, dir, tasks } = freshDbs();
  const now = clock();
  const notifications = [];
  const announced = [];
  const logs = [];
  const eng = fakeEngine();
  const store = createHandoffStore({ now });
  const pending = createPendingStore({ now });
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  const core = createHandoffCore({
    store,
    summaries: createSummaryCache({ bus: new EventEmitter(), now }),
    availability: async (_db, key) => avail[key] ?? "up",
    loadVoiceDef: createVoiceBotLoader({ generation: botDefsGeneration, now }),
    engine: async () => { eng.calls.minted++; return eng; },
    openTasksDb: () => createDbClient(tasks),
    notify: async (_db, nf) => { notifications.push(nf); if (notify === "throw") throw new Error("db locked"); return notify === "off" ? null : { id: notifications.length }; },
    announce: async (a) => { announced.push(a); return { spokenOn: null }; },
    withDb: (fn) => fn(db),
    wait: now.wait,
    now,
    log: (m) => logs.push(m),
  });
  registerVoiceResultKind({ core });
  const actions = createHandoffVoiceActions({ core, pending });

  /** A hand-off row in `status` on a fresh card of `bot` (no spawn), claimed for the voice rail. */
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
  /** The bot's perch-live session row, as the engine writes it. */
  const session = ({ sid, cardId, bot = "writer", status = "active" }) => db.execute({
    sql: "INSERT INTO bot_sessions (bot_id, gateway_type, gateway_thread_id, kind, status, card_id) VALUES (?, 'perch', ?, 'perch-live', ?, ?)",
    args: [bot, sid, status, cardId ?? null],
  });
  /** A kiosk stop row awaiting the phone, for `target`. */
  const stopRow = (target, over = {}) => store.insert(db, { kind: "stop", surface: "kiosk", device_id: KIOSK.id, device_name: KIOSK.name, bot_id: "writer", task: TASK, status: "awaiting_phone", target_id: target, ...over });
  const voiceDef = async () => JSON.parse((await db.execute({ sql: "SELECT definition FROM pi_bot_defs WHERE bot_id=?", args: [CROW_VOICE_BOT_ID] })).rows[0].definition);
  const candidates = async () => core.summaries.get(db, await voiceDef());
  /** The confirm tests' propose: a proposed row and the pending entry, on the phone. */
  async function propose({ bot = "writer", lang = "en", surface = "phone", transcript = ASK, task = TASK, device = DEVICE } = {}) {
    const out = await proposeHandoff({ core, pending, db, device, surface, lang, transcript, candidates: await candidates(), log: core.log }, task, bot);
    return { out, id: pending.get(device.id).id };
  }
  const ask = (transcript, { device = DEVICE, surface = "phone", lang = "en", bot = VOICE, mediaActive = () => false } = {}) => actions.fastPath({ db, device, surface, transcript, lang, bot, mediaActive });
  const afterTurn = (device = DEVICE) => actions.afterTurn({ db, device, calledTools: [], relay: false });
  const row = (id) => store.get(db, id);
  const cards = async () => (await tdb.execute("SELECT * FROM tasks_items ORDER BY id")).rows;
  const mutations = async (cardId) => (await tdb.execute({ sql: "SELECT verb, actor_kind, actor_id, detail_json FROM board_mutations WHERE item_id = ? ORDER BY id", args: [cardId] })).rows;
  const report = (cardId, { outcome = "success", summaryMd = "Done: the write-up is ready." } = {}) => reportResult(tdb, db, cardId, { outcome, summaryMd }, WRITER);
  const sweep = () => startHandoffSweep({ core, intervalMs: 3_600_000, openDb: () => ({ execute: (...a) => db.execute(...a), close() {} }) });
  const done = () => process.off("unhandledRejection", onUnhandled);
  return { db, tdb, dir, now, eng, core, store, pending, actions, notifications, announced, logs, unhandled, handoff, session, stopRow, propose, ask, afterTurn, row, cards, mutations, report, sweep, done };
}

/** A started hand-off through the real yes: the card is a Give card and the session s1 is running. */
async function started(s, over = {}) {
  const { id } = await s.propose(over);
  const fp = await s.ask("yes", over);
  assert.equal(fp.verb, "handoff_started");
  const r = await s.row(id);
  return { id, cardId: r.card_id, sid: r.session_id };
}

function withTurn(s, rounds) {
  const h = harness({ bot: VOICE, chatTools: [], rounds });
  h.deps.handoffs = { forTurn: (c) => s.core.forTurn({ ...c, pending: s.pending }) };
  h.deps.voiceActions = chainVoiceActions([s.actions]);
  const turn = (transcript, opts = {}) => h.runner.runVoiceTurn({ db: s.db, device: { ...h.device, ...DEVICE }, transcript, sink: h.sink, surface: "phone", lang: "en", ...opts });
  return { h, turn };
}

/* ---------- The spoken stop ---------- */

test("stop asks first, and yes stops the session and keeps the card and files", async () => {
  const s = await setup();
  const { id, cardId, sid } = await started(s);
  const made = join(s.dir, "write-up.md");
  writeFileSync(made, "# Radio history\n");
  const before = (await s.cards())[0];
  assert.deepEqual(await s.ask("stop writer"), { say: "Stop Writer's task: research radio history?", verb: "stop_propose" });
  assert.deepEqual(s.eng.calls.stop, [], "asked, not acted");
  assert.equal((await s.row(id)).status, "started");
  assert.equal(s.pending.get(DEVICE.id).kind, "stop");
  assert.deepEqual(await s.ask("yes"), { say: "Okay, I stopped Writer. Anything it already made is kept.", verb: "stop_stopped" });
  assert.deepEqual(s.eng.calls.stop, [sid], "engine.stop once");
  const r = await s.row(id);
  assert.equal(r.status, "stopped");
  assert.equal(r.detail, null);
  assert.equal(r.ended_at, T0);
  const after = (await s.cards())[0];
  assert.equal(after.status, before.status, "the card's status is unchanged");
  assert.equal(after.archived_at, null, "nothing archived");
  assert.equal((await s.cards()).length, 1);
  assert.ok(existsSync(made), "what the bot made is kept");
  const muts = (await s.mutations(cardId)).filter((m) => m.verb === "handoff_stopped");
  assert.equal(muts.length, 1, "one handoff_stopped mutation");
  assert.equal(muts[0].actor_kind, DASHBOARD_ACTOR.kind);
  assert.equal(muts[0].actor_id, DASHBOARD_ACTOR.id);
  assert.deepEqual(JSON.parse(muts[0].detail_json), { via: "voice", handoff_id: id });
  assert.equal(RR.requesterOf(cardId), null, "the claim is released");
  assert.equal(s.pending.get(DEVICE.id), null);
  assert.deepEqual(s.unhandled, []);
  s.done();
});

test("stopping a queued hand-off says the card stays on the board", async () => {
  const s = await setup({ avail: { "prov/model-a": "unavailable" } });
  const { id } = await s.propose();
  assert.equal((await s.ask("yes")).verb, "handoff_queued");
  assert.equal((await s.ask("cancel the research")).verb, "stop_propose");
  assert.deepEqual(await s.ask("yes"), { say: "Okay, Writer won't start it. The card stays on Writer's board.", verb: "stop_stopped" });
  const r = await s.row(id);
  assert.equal(r.status, "stopped");
  assert.deepEqual(s.eng.calls.stop, [], "no session, no engine call");
  assert.equal((await s.cards()).length, 1, "the card stays");
  assert.equal((await s.mutations(r.card_id)).filter((m) => m.verb === "handoff_stopped").length, 1);
  s.done();
});

test("a queued target returns stopped with stopped_queued; an engine.stop error returns stopping, and the sweep retries it [rv3 m5, m1]", async () => {
  const s = await setup();
  const q = await s.handoff({ status: "queued" });
  assert.deepEqual(await s.core.stop(s.db, q.id, "voice"), { status: "stopped", say: line("stopped_queued") });
  assert.equal((await s.row(q.id)).status, "stopped");

  const { id, sid } = await started(s);
  const stop = s.eng.stop;
  s.eng.stop = async (x) => { s.eng.calls.stop.push(x); throw new Error("engine busy"); };
  assert.deepEqual(await s.core.stop(s.db, id, "voice"), { status: "stopping", say: line("stop_requested") });
  let r = await s.row(id);
  assert.equal(r.status, "stopped");
  assert.equal(r.detail, "stop_pending");
  assert.equal(RR.requesterOf(r.card_id), null, "the claim is released even while the stop is pending");
  assert.ok(s.logs.some((m) => /engine busy/.test(m)), s.logs.join("\n"));
  s.eng.stop = stop;
  const sw = s.sweep();
  try { assert.equal((await sw.runOnce()).retried, 1); } finally { sw.stop(); }
  r = await s.row(id);
  assert.equal(r.detail, null);
  assert.deepEqual(s.eng.calls.stop, [sid, sid]);
  s.done();
});

test("core.stop: none for an unknown id or a stop row; already once the row is no longer open", async () => {
  const s = await setup();
  assert.deepEqual(await s.core.stop(s.db, "vh-0000000000000000", "voice"), { status: "none", say: line("stop_none") });
  const h = await s.handoff({ status: "done" });
  assert.deepEqual(await s.core.stop(s.db, h.id, "voice"), { status: "already", say: line("stop_already") });
  assert.equal((await s.row(h.id)).status, "done", "an ended row is never rewritten");
  const st = await s.stopRow(h.id);
  assert.equal((await s.core.stop(s.db, st, "voice")).status, "none");
  assert.deepEqual(s.eng.calls.stop, []);
  s.done();
});

test("a double yes stops once", async () => {
  const s = await setup();
  const { id, sid } = await started(s);
  assert.equal((await s.ask("stop writer")).verb, "stop_propose");
  assert.equal((await s.ask("yes")).verb, "stop_stopped");
  assert.equal(await s.ask("yes"), null, "the second yes answers nothing");
  assert.deepEqual(s.eng.calls.stop, [sid]);
  assert.deepEqual(await s.core.stop(s.db, id, "voice"), { status: "already", say: line("stop_already") });
  assert.deepEqual(s.eng.calls.stop, [sid], "already: no second engine call");
  s.done();
});

test("no declines a stop and leaves the task running; an unanswered stop is taken by the next turn (P19)", async () => {
  const s = await setup();
  const { id } = await started(s);
  assert.equal((await s.ask("stop writer")).verb, "stop_propose");
  assert.deepEqual(await s.ask("no"), { say: "Okay, I won't.", verb: "handoff_declined" });
  assert.equal((await s.row(id)).status, "started");
  assert.equal(s.pending.get(DEVICE.id), null);
  assert.equal((await s.ask("stop writer")).verb, "stop_propose");
  assert.equal(await s.ask("what's the weather tomorrow"), null);
  await s.afterTurn();
  assert.equal(s.pending.get(DEVICE.id), null, "a non-relay turn takes an unanswered stop");
  assert.equal(await s.ask("yes"), null, "so a later stray yes stops nothing");
  assert.deepEqual(s.eng.calls.stop, []);
  assert.equal((await s.row(id)).status, "started");
  s.done();
});

test("a turn that calls crow_handoff (refused) while a stop waits still takes the stop, so a later yes stops nothing (fix round 1)", async () => {
  const s = await setup();
  const { id, sid } = await started(s);
  assert.equal((await s.ask("stop writer")).verb, "stop_propose");
  // Not a yes or no, and no hand-off cue: the tool is not offered, the model's forced call is refused, and the
  // call still counts as called this turn (calledTools) — the stop question is taken all the same.
  const { h, turn } = withTurn(s, [call({ task: "write a poem", bot: "writer" }), says("It'll be sunny. ")]);
  const r = await turn("what's the weather tomorrow");
  assert.equal(r.fastPath, false);
  assert.deepEqual(r.timings.tools, ["crow_handoff:not_offered"]);
  assert.deepEqual(h.calls.spoken, ["It'll be sunny."]);
  assert.equal(s.pending.get(DEVICE.id), null, "the stop question is gone");
  assert.equal(await s.ask("yes"), null, "a stray yes stops nothing");
  assert.deepEqual(s.eng.calls.stop, []);
  assert.equal((await s.row(id)).status, "started");
  assert.equal(sid, "s1");
  s.done();
});

test("the proposal's own words echoed back are a stop: an article, a possessive, Spanish \"de\" (final review I1)", async () => {
  for (const phrase of ["stop the writer", "cancel the writer", "stop writer's task", "para la investigación de writer"]) {
    const s = await setup();
    await started(s);
    assert.deepEqual(await s.ask(phrase), { say: "Stop Writer's task: research radio history?", verb: "stop_propose" }, phrase);
    assert.equal(s.pending.get(DEVICE.id).kind, "stop", phrase);
    s.done();
  }
});

test("a bot that is no longer a candidate is still stopped by name through its open row (stopShape, fix round 1)", async () => {
  const s = await setup();
  const { id, sid } = await started(s);
  const off = { ...VOICE, handoff: { enabled: false, allowed_bots: [] } };
  assert.deepEqual(await s.ask("stop writer", { bot: off }), { say: "Stop Writer's task: research radio history?", verb: "stop_propose" });
  assert.equal((await s.ask("yes", { bot: off })).verb, "stop_stopped");
  assert.deepEqual(s.eng.calls.stop, [sid]);
  assert.equal((await s.row(id)).status, "stopped");
  // The shape alone never stops anything: a subject that is no row's bot is the model's (or the media's).
  const t = await setup();
  await started(t);
  for (const phrase of ["stop the music", "cancel the timer", "para la musica", "stop helper"]) assert.equal(await t.ask(phrase, { bot: off }), null, phrase);
  assert.equal((await t.ask("stop writer", { bot: null })).verb, "stop_propose", "no voice def at all: the shape still reads the log");
  s.done(); t.done();
});

test("turnContext names the pending stop, and nothing else", async () => {
  const s = await setup();
  await started(s);
  await s.ask("stop writer");
  assert.deepEqual(s.actions.turnContext({ device: DEVICE }), {
    text: "[Hand-off] Waiting for a yes or no on stopping Writer's task: research radio history. Do not stop anything or claim it was stopped.",
    pending: true,
  });
  s.pending.clear(DEVICE.id);
  assert.equal(s.actions.turnContext({ device: DEVICE }), null);
  s.done();
});

/* ---------- "Stop it" and media (Review Focus 5, P21) ---------- */

test("\"stop it\" with music and no recent hand-off talk is not a task stop", async () => {
  const s = await setup();
  const { id } = await s.handoff({ session: "s1" });
  let media = 0;
  const { h, turn } = withTurn(s, [says("Okay. ")]);
  const r = await turn("stop it", { mediaActive: () => true, fastPaths: async (t) => (/^stop it$/i.test(t) ? (media++, { say: "Stopped.", verb: "stop" }) : null) });
  assert.equal(r.fastPath, true);
  assert.equal(r.timings.verb, "stop", "the media path answered");
  assert.equal(media, 1);
  assert.deepEqual(h.calls.spoken, ["Stopped."]);
  assert.equal((await s.row(id)).status, "started");
  assert.deepEqual(s.eng.calls.stop, []);
  assert.equal(s.pending.get(DEVICE.id), null);
  // Without the runner: null, whatever the media flag says, with no topic on this device.
  assert.equal(await s.ask("stop it"), null);
  assert.equal(await s.ask("stop it", { mediaActive: () => true }), null);
  assert.equal(await s.ask("stop it", { mediaActive: null }), null);
  s.done();
});

test("\"stop it\" right after \"on it\" asks to stop the task", async () => {
  const s = await setup();
  const { id, sid } = await started(s);
  assert.deepEqual(await s.ask("stop it"), { say: "Stop Writer's task: research radio history?", verb: "stop_propose" });
  assert.equal((await s.ask("yes")).verb, "stop_stopped");
  assert.deepEqual(s.eng.calls.stop, [sid]);
  assert.equal((await s.row(id)).status, "stopped");
  s.done();
});

test("a pronoun stop while media plays, or with no media flag, asks which it means; a named stop never does (P21)", async () => {
  const s = await setup();
  const { id, sid } = await started(s);
  // Media active: the ask, and a non-yes falls through (null) and leaves the question to the next turn's take.
  assert.deepEqual(await s.ask("stop it", { mediaActive: () => true }), { say: "Do you mean Writer's task? Say yes, or say stop the music.", verb: "stop_propose_media" });
  assert.equal(s.pending.get(DEVICE.id).kind, "stop");
  assert.equal(await s.ask("stop the music", { mediaActive: () => true }), null, "falls through to media");
  assert.equal(await s.ask("no", { mediaActive: () => true }), null, "anything but yes falls through");
  assert.deepEqual(s.eng.calls.stop, []);
  await s.afterTurn();
  assert.equal(s.pending.get(DEVICE.id), null);
  // No flag at all (an older caller): the ask too; a flag that throws counts as active.
  assert.equal((await s.ask("stop it", { mediaActive: null })).verb, "stop_propose_media");
  s.pending.clear(DEVICE.id);
  assert.equal((await s.ask("stop it", { mediaActive: () => { throw new Error("x"); } })).verb, "stop_propose_media");
  s.pending.clear(DEVICE.id);
  // A named stop with music playing goes to the normal confirm.
  assert.equal((await s.ask("stop writer", { mediaActive: () => true })).verb, "stop_propose");
  s.pending.clear(DEVICE.id);
  // The yes on the media ask stops the task.
  assert.equal((await s.ask("stop it", { mediaActive: () => true })).verb, "stop_propose_media");
  assert.equal((await s.ask("yes", { mediaActive: () => true })).verb, "stop_stopped");
  assert.deepEqual(s.eng.calls.stop, [sid]);
  assert.equal((await s.row(id)).status, "stopped");
  s.done();
});

test("through the runner: \"stop it\" with a topic and no media is the stop ask, a fast path with no model round", async () => {
  const s = await setup();
  await started(s);
  const { h, turn } = withTurn(s, [says("Sure, stopping. ")]);
  const r = await turn("stop it", { mediaActive: () => false, fastPaths: async () => ({ say: "Stopped.", verb: "stop" }) });
  assert.equal(r.fastPath, true);
  assert.equal(r.timings.verb, "stop_propose");
  assert.deepEqual(h.calls.spoken, ["Stop Writer's task: research radio history?"]);
  assert.equal(h.log.length, 0, "no model round");
  s.done();
});

/* ---------- Scope and resolution (P20, P23) ---------- */

test("a named bot with nothing open of its own: already when it just ended, none otherwise; nothing open at all is the model's", async () => {
  const s = await setup();
  assert.equal(await s.ask("stop writer"), null, "no open hand-off: the stop matchers never fire");
  await s.handoff({ bot: "helper", session: "s1" });
  assert.deepEqual(await s.ask("stop writer"), { say: "I couldn't find that task.", verb: "stop_none" });
  await s.handoff({ status: "done" });
  assert.deepEqual(await s.ask("stop writer"), { say: "Writer isn't working on that anymore.", verb: "stop_already" });
  assert.equal(await s.ask("don't stop writer"), null);
  assert.deepEqual(s.eng.calls.stop, []);
  s.done();
});

test("a work target picks the one open row; two bots ask which (purpose stop), and the pick asks to stop that one", async () => {
  const s = await setup();
  const w = await s.handoff({ session: "s1" });
  assert.equal((await s.ask("cancel the task")).verb, "stop_propose");
  s.pending.clear(DEVICE.id);
  const h = await s.handoff({ bot: "helper", session: "s2" });
  assert.deepEqual(await s.ask("stop the research"), { say: "Helper and Writer are working on things. Which one?", verb: "status_which" });
  const e = s.pending.get(DEVICE.id);
  assert.equal(e.kind, "which");
  assert.equal(e.purpose, "stop");
  assert.equal(await s.ask("what's for dinner"), null);
  assert.deepEqual(await s.ask("the helper one"), { say: "Stop Helper's task: research radio history?", verb: "stop_propose" });
  assert.equal(s.pending.get(DEVICE.id).id, h.id);
  assert.equal((await s.ask("yes")).verb, "stop_stopped");
  assert.deepEqual(s.eng.calls.stop, ["s2"]);
  assert.equal((await s.row(w.id)).status, "started", "writer's keeps running");
  assert.equal((await s.ask("stop the task")).verb, "stop_propose", "one bot left: no which");
  s.pending.clear(DEVICE.id);
  await s.handoff({ bot: "helper", session: "s3" });
  assert.equal((await s.ask("stop the task")).verb, "status_which");
  assert.deepEqual(await s.ask("no"), { say: "Okay, I won't.", verb: "handoff_declined" });
  assert.equal(s.pending.get(DEVICE.id), null);
  s.done();
});

test("the phone can stop a kiosk-started hand-off; a kiosk sees only its own device's rows (P23, amended)", async () => {
  const s = await setup();
  const k = await s.handoff({ surface: "kiosk", device: KIOSK, session: "s1" });
  assert.equal((await s.ask("stop writer", { surface: "phone" })).verb, "stop_propose");
  s.pending.clear(DEVICE.id);
  assert.equal((await s.ask("stop writer", { surface: "glasses", device: { id: "glasses-1" } })).verb, "stop_propose");
  s.pending.clear("glasses-1");
  assert.equal(await s.ask("stop writer", { surface: "kiosk", device: { id: "kiosk-2", name: "Hall" } }), null, "another kiosk sees nothing");
  assert.equal(await s.ask("stop writer", { surface: "kiosk", device: KIOSK }) !== null, true, "its own kiosk does");
  assert.equal((await s.row(k.id)).status, "started");
  s.done();
});

/* ---------- The kiosk: confirmed on the phone (Review Focus 5, rv1 C4) ---------- */

test("a kiosk stop goes to the phone, and confirming it stops the target and creates no card", async () => {
  const s = await setup();
  const k = await s.handoff({ surface: "kiosk", device: KIOSK, session: "s1" });
  await s.session({ sid: "s1", cardId: k.cardId });
  s.eng.sessions.set("s1", { sessionId: "s1", cardId: k.cardId, watchers: new Set() });
  assert.deepEqual(await s.ask("stop writer", { surface: "kiosk", device: KIOSK }), { say: "I've sent that to your phone to confirm.", verb: "stop_sent_to_phone" });
  const rows = (await s.db.execute("SELECT * FROM voice_handoffs WHERE kind = 'stop'")).rows;
  assert.equal(rows.length, 1);
  const st = rows[0];
  assert.equal(st.status, "awaiting_phone");
  assert.equal(st.surface, "kiosk", "the PR 4 route's decidable check");
  assert.equal(st.device_id, KIOSK.id);
  assert.equal(st.bot_id, "writer");
  assert.equal(st.task, TASK);
  assert.equal(st.target_id, k.id);
  assert.equal(st.asked, "stop writer");
  assert.equal(Number(st.expires_at), T0 + HANDOFF_PHONE_TTL_MS);
  assert.deepEqual(s.notifications, [{ type: "attention", priority: "high", title: "Crow on Kitchen: stop Writer's task?", body: TASK, action_url: phoneConfirmPath(st.id), source: "crow-voice" }]);
  assert.equal(s.pending.get(KIOSK.id), null, "no spoken yes in the room");
  assert.equal(await s.ask("yes", { surface: "kiosk", device: KIOSK }), null);
  assert.deepEqual(s.eng.calls.stop, [], "nothing stopped yet");
  // A second ask while one is open: already sent, no second push [rv2 m4].
  assert.deepEqual(await s.ask("stop writer", { surface: "kiosk", device: KIOSK }), { say: line("handoff_already_sent"), verb: "stop_already_sent" });
  assert.equal(s.notifications.length, 1);
  // The phone page's yes (the route calls core.decideStop).
  const cardsBefore = (await s.cards()).length;
  assert.deepEqual(await s.core.decideStop(s.db, st.id, "yes"), { status: "done", stop: "stopped" });
  assert.equal((await s.cards()).length, cardsBefore, "a stop creates no card");
  const now = await s.row(st.id);
  assert.equal(now.status, "done");
  assert.equal(now.detail, "stopped");
  assert.equal((await s.row(k.id)).status, "stopped");
  assert.deepEqual(s.eng.calls.stop, ["s1"]);
  assert.deepEqual(JSON.parse((await s.mutations(k.cardId)).find((m) => m.verb === "handoff_stopped").detail_json), { via: "phone", handoff_id: k.id });
  // Decided: a second yes or no changes nothing.
  assert.deepEqual(await s.core.decideStop(s.db, st.id, "yes"), { status: "already" });
  assert.deepEqual(await s.core.decideStop(s.db, st.id, "no"), { status: "already" });
  assert.deepEqual(s.eng.calls.stop, ["s1"]);
  s.done();
});

test("a kiosk stop with the alerts off, or a push that fails, is said so and the row is not left open", async () => {
  const off = await setup({ notify: "off" });
  await off.handoff({ surface: "kiosk", device: KIOSK, session: "s1" });
  assert.deepEqual(await off.ask("stop writer", { surface: "kiosk", device: KIOSK }), { say: line("handoff_phone_off"), verb: "stop_phone_off" });
  let st = (await off.db.execute("SELECT * FROM voice_handoffs WHERE kind = 'stop'")).rows[0];
  assert.equal(st.status, "failed");
  assert.equal(st.detail, "not_sent");
  off.done();
  const thrown = await setup({ notify: "throw" });
  await thrown.handoff({ surface: "kiosk", device: KIOSK, session: "s1" });
  assert.deepEqual(await thrown.ask("stop writer", { surface: "kiosk", device: KIOSK }), { say: line("handoff_phone_failed"), verb: "stop_phone_failed" });
  st = (await thrown.db.execute("SELECT * FROM voice_handoffs WHERE kind = 'stop'")).rows[0];
  assert.equal(st.status, "failed");
  assert.ok(thrown.logs.some((m) => /db locked/.test(m)));
  thrown.done();
});

test("a pronoun stop on a kiosk while media plays asks first, and the yes goes to the phone", async () => {
  const s = await setup();
  const k = await s.handoff({ surface: "kiosk", device: KIOSK, session: "s1" });
  // The kiosk spoke of it: a heads-up records the topic on that device (handoff-topic.js).
  const { rememberTopic } = await import("../servers/gateway/voice/handoff-topic.js");
  rememberTopic(s.core, KIOSK.id, k.id, { inTurn: false });
  assert.equal((await s.ask("stop it", { surface: "kiosk", device: KIOSK, mediaActive: () => true })).verb, "stop_propose_media");
  assert.deepEqual(await s.ask("yes", { surface: "kiosk", device: KIOSK, mediaActive: () => true }), { say: line("handoff_sent_to_phone"), verb: "stop_sent_to_phone" });
  assert.equal((await s.db.execute("SELECT count(*) AS c FROM voice_handoffs WHERE kind = 'stop' AND status = 'awaiting_phone'")).rows[0].c, 1);
  assert.deepEqual(s.eng.calls.stop, [], "the yes in the room stops nothing");
  assert.equal((await s.row(k.id)).status, "started");
  // Without media: straight to the phone.
  const t = await setup();
  const k2 = await t.handoff({ surface: "kiosk", device: KIOSK, session: "s1" });
  rememberTopic(t.core, KIOSK.id, k2.id, { inTurn: false });
  assert.equal((await t.ask("stop it", { surface: "kiosk", device: KIOSK, mediaActive: () => false })).verb, "stop_sent_to_phone");
  t.done(); s.done();
});

test("declining a stop on the page leaves the target running", async () => {
  const s = await setup();
  const k = await s.handoff({ surface: "kiosk", device: KIOSK, session: "s1" });
  const st = await s.stopRow(k.id);
  assert.deepEqual(await s.core.decideStop(s.db, st, "no"), { status: "declined" });
  const now = await s.row(st);
  assert.equal(now.status, "declined");
  assert.equal(now.decided_at, T0);
  assert.equal((await s.row(k.id)).status, "started");
  assert.deepEqual(s.eng.calls.stop, []);
  assert.equal((await s.cards()).length, 1);
  s.done();
});

test("a stop row confirmed for a target that is already done is failed, not done [rv2 m6]; a core.stop throw leaves the stop row failed", async () => {
  const s = await setup();
  const d = await s.handoff({ status: "done", surface: "kiosk", device: KIOSK });
  const st = await s.stopRow(d.id);
  assert.deepEqual(await s.core.decideStop(s.db, st, "yes"), { status: "failed", detail: "already" });
  let now = await s.row(st);
  assert.equal(now.status, "failed");
  assert.equal(now.detail, "already");
  assert.equal(now.ended_at, T0);
  assert.equal((await s.row(d.id)).status, "done");

  const k = await s.handoff({ surface: "kiosk", device: KIOSK, session: "s1" });
  const st2 = await s.stopRow(k.id);
  const real = s.core.stop;
  s.core.stop = async () => { throw Object.assign(new Error("tasks.db locked"), { code: "tasks_db" }); };
  try { assert.deepEqual(await s.core.decideStop(s.db, st2, "yes"), { status: "failed", detail: "tasks_db" }); }
  finally { s.core.stop = real; }
  now = await s.row(st2);
  assert.equal(now.status, "failed");
  assert.equal(now.detail, "tasks_db");
  assert.deepEqual(s.eng.calls.stop, []);
  s.done();
});

test("decideStop validates before any write: bad_decision, wrong_kind, none, and a target of another device or bot is bad_target (P24)", async () => {
  const s = await setup();
  const k = await s.handoff({ surface: "kiosk", device: KIOSK, session: "s1" });
  const st = await s.stopRow(k.id);
  assert.deepEqual(await s.core.decideStop(s.db, st, "maybe"), { status: "bad_decision" });
  assert.deepEqual(await s.core.decideStop(s.db, k.id, "yes"), { status: "wrong_kind" });
  assert.deepEqual(await s.core.decideStop(s.db, "vh-0000000000000000", "yes"), { status: "none" });
  assert.equal((await s.row(st)).status, "awaiting_phone", "nothing written");
  assert.equal((await s.row(k.id)).status, "started");
  await s.db.execute({ sql: "UPDATE voice_handoffs SET status = 'declined' WHERE id = ?", args: [st] });   // one live stop per kiosk
  // Another device's hand-off as the target: refused, and the stop row is failed bad_target.
  const other = await s.handoff({ surface: "kiosk", device: { id: "kiosk-2", name: "Hall" }, session: "s2" });
  const st2 = await s.stopRow(other.id);
  assert.deepEqual(await s.core.decideStop(s.db, st2, "yes"), { status: "failed", detail: "bad_target" });
  assert.equal((await s.row(st2)).detail, "bad_target");
  assert.equal((await s.row(other.id)).status, "started");
  // Another bot's: the same, even on a no.
  const helper = await s.handoff({ surface: "kiosk", device: KIOSK, bot: "helper", session: "s3" });
  const st3 = await s.stopRow(helper.id);
  assert.deepEqual(await s.core.decideStop(s.db, st3, "no"), { status: "failed", detail: "bad_target" });
  assert.equal((await s.row(st3)).status, "failed");
  // A stop row pointing at a stop row.
  const st4 = await s.stopRow(st);
  assert.deepEqual(await s.core.decideStop(s.db, st4, "yes"), { status: "failed", detail: "bad_target" });
  assert.deepEqual(s.eng.calls.stop, []);
  assert.equal((await s.cards()).length, 3);
  s.done();
});

test("an expired stop row cannot be decided: expired, and the target keeps running", async () => {
  const s = await setup();
  const k = await s.handoff({ surface: "kiosk", device: KIOSK, session: "s1" });
  const st = await s.stopRow(k.id);
  s.now.advance(HANDOFF_PHONE_TTL_MS + 1);
  assert.deepEqual(await s.core.decideStop(s.db, st, "yes"), { status: "expired" });
  assert.equal((await s.row(st)).status, "expired");
  assert.equal((await s.row(k.id)).status, "started");
  assert.deepEqual(s.eng.calls.stop, []);
  s.done();
});

/* ---------- Races with the start (rv2 N1, rv3 m2) ---------- */

test("stop during starting says the stop is pending, and the session is stopped when the spawn lands [rv2 N1]", async () => {
  const s = await setup({ avail: { "prov/model-a": "on_demand" } });
  const { id } = await s.propose();
  s.eng.hold = deferred();
  const p = s.ask("yes");
  await flush();
  s.now.advance(HANDOFF_START_BUDGET_MS);
  assert.equal((await p).verb, "handoff_starting");
  assert.equal((await s.row(id)).status, "starting");
  assert.equal((await s.ask("stop writer")).verb, "stop_propose");
  assert.deepEqual(await s.ask("yes"), { say: "Okay. Writer is still starting up, so I'll stop it the moment it does. Anything it makes is kept.", verb: "stop_pending_start" });
  let r = await s.row(id);
  assert.equal(r.status, "stopped");
  assert.equal(r.detail, "pending_start", "the 5.3 carry: status reads it as stopping");
  assert.equal(r.session_id, null);
  assert.deepEqual(s.eng.calls.stop, [], "no session yet: nothing to stop");
  assert.deepEqual(await s.ask("how's writer doing"), { say: "Writer's task will stop as soon as Writer finishes starting up.", verb: "status_stopping" });
  assert.equal(RR.requesterOf(r.card_id), null, "the claim is released (P9)");
  // The spawn lands: finishStart loses its CAS and stops the session the moment it exists.
  s.eng.hold.res();
  await flush();
  r = await s.row(id);
  assert.equal(r.status, "stopped");
  assert.equal(r.session_id, "s1");
  assert.deepEqual(s.eng.calls.stop, ["s1"]);
  assert.deepEqual(s.eng.calls.watched, [], "no turn-1 watcher");
  assert.equal(s.core.inFlight.size, 0);
  assert.equal(RR.requesterOf(r.card_id), null, "still released (P32)");
  assert.deepEqual(await s.ask("how's writer doing"), { say: "Writer's task was stopped. What it made so far is kept.", verb: "status_stopped" });
  assert.deepEqual(s.notifications, []);
  assert.deepEqual(s.unhandled, []);
  s.done();
});

test("finishStart winning between core.stop's two CAS attempts still ends with the session stopped [rv3 m2]", async () => {
  const s = await setup();
  const { id } = await s.handoff({ status: "starting" });
  const real = s.store.transition;
  let raced = false;
  s.store.transition = async (db, rid, from, to, ...rest) => {
    if (!raced && rid === id && from[0] === "starting" && to === "stopped") {
      raced = true;
      assert.equal(await real(db, rid, ["starting"], "started", { session_id: "s7", thread_id: "t-s7" }), true, "the start lands first");
      s.eng.sessions.set("s7", { sessionId: "s7", cardId: null, watchers: new Set() });
    }
    return real(db, rid, from, to, ...rest);
  };
  try { assert.deepEqual(await s.core.stop(s.db, id, "voice"), { status: "stopped", say: line("stopped") }); }
  finally { s.store.transition = real; }
  const r = await s.row(id);
  assert.equal(r.status, "stopped");
  assert.equal(r.session_id, "s7");
  assert.equal(r.detail, null);
  assert.deepEqual(s.eng.calls.stop, ["s7"]);
  s.done();
});

test("a stop inside the 3 s budget is said so, but a report that landed inside it says on it (5.1 carry)", async () => {
  const s = await setup();
  const { id } = await s.propose();
  s.eng.hold = deferred();
  const p = s.ask("yes");
  await flush();
  const r0 = await s.row(id);
  await s.report(r0.card_id, { outcome: "success" });
  assert.equal((await s.row(id)).status, "done");
  s.eng.hold.res();
  assert.deepEqual(await p, { say: "Okay, Writer's on it.", verb: "handoff_started" });
  assert.equal((await s.row(id)).status, "done", "the report stands");
  assert.deepEqual(s.eng.calls.stop, []);
  s.done();
});

test("a session that moved on to other work is not stopped: the row ends session_moved and Crow says already (P25)", async () => {
  const s = await setup();
  const { id, cardId, sid } = await started(s);
  // The engine's row for that session now holds another card (a re-attach).
  const { id: other } = await createCard(s.tdb, { title: "Other work", status: "pending", project_id: PID, assigned_bot: "writer", autonomy: "gated" }, HUMAN);
  await s.session({ sid, cardId: other });
  assert.deepEqual(await s.core.stop(s.db, id, "voice"), { status: "already", say: line("stop_already") });
  const r = await s.row(id);
  assert.equal(r.status, "stopped");
  assert.equal(r.detail, "session_moved");
  assert.deepEqual(s.eng.calls.stop, [], "no engine call");
  assert.equal(RR.requesterOf(cardId), null);
  // The same session still on this card and bot is stopped.
  const t = await setup();
  const b = await started(t);
  await t.session({ sid: b.sid, cardId: b.cardId });
  assert.equal((await t.core.stop(t.db, b.id, "voice")).status, "stopped");
  assert.deepEqual(t.eng.calls.stop, [b.sid]);
  // Another bot's session under the same id (never in practice): moved too.
  const u = await setup();
  const c = await started(u);
  await u.session({ sid: c.sid, cardId: c.cardId, bot: "helper" });
  assert.equal((await u.core.stop(u.db, c.id, "voice")).status, "already");
  assert.deepEqual(u.eng.calls.stop, []);
  s.done(); t.done(); u.done();
});

/* ---------- After the stop ---------- */

test("a stopped card's later result gets today's notification, and the row stays stopped", async () => {
  const s = await setup();
  const { id, cardId } = await started(s);
  assert.equal((await s.core.stop(s.db, id, "voice")).status, "stopped");
  await s.report(cardId, { outcome: "success" });
  const rows = (await s.db.execute("SELECT title FROM notifications ORDER BY id")).rows;
  assert.equal(rows.length, 1);
  assert.ok(!rows[0].title.startsWith("Writer finished:"), `not the hand-off's completion notice: ${rows[0].title}`);
  assert.equal((await s.row(id)).status, "stopped");
  assert.equal(RR.requesterOf(cardId), null);
  s.done();
});

test("a relay turn never stops anything: a pending stop and a relayed yes clear the entry and leave the task running", async () => {
  const s = await setup();
  const { id, sid } = await started(s);
  assert.equal((await s.ask("stop writer")).verb, "stop_propose");
  const { h, turn } = withTurn(s, [says("Okay. ")]);
  const r = await turn("yes, stop it", { relayThreadId: "thread-1" });
  assert.equal(r.fastPath, false);
  assert.equal(h.log.length, 1, "the model answered");
  assert.equal(s.pending.get(DEVICE.id), null, "the relay cleared the stop entry");
  assert.deepEqual(s.eng.calls.stop, []);
  assert.equal((await s.row(id)).status, "started");
  assert.equal(await s.ask("yes"), null, "a later yes answers nothing");
  assert.equal(sid, "s1");
  s.done();
});

test("a stop beside a status phrase (\"stop writer, how's it going\") is a stop, and a status question meanwhile answers from the log", async () => {
  const s = await setup();
  await started(s);
  assert.equal((await s.ask("stop writer, how's it going")).verb, "stop_propose");
  s.pending.clear(DEVICE.id);
  assert.equal((await s.ask("how's writer doing")).verb, "status_running");
  s.done();
});

/* ---------- The lines ---------- */

test("the stop lines are the plan's, in both languages", () => {
  const en = {
    stop_propose: "Stop {bot}'s task: {task}?",
    stop_propose_media: "Do you mean {bot}'s task? Say yes, or say stop the music.",
    stopped: "Okay, I stopped {bot}. Anything it already made is kept.",
    stop_pending_start: "Okay. {bot} is still starting up, so I'll stop it the moment it does. Anything it makes is kept.",
    stopped_queued: "Okay, {bot} won't start it. The card stays on {bot}'s board.",
    stop_already: "{bot} isn't working on that anymore.",
    stop_requested: "I've asked {bot} to stop. Anything it already made is kept.",
    stop_none: "I couldn't find that task.",
    handoff_stop_phone_title: "Crow on {display}: stop {bot}'s task?",
  };
  const es = {
    stop_propose: "¿Paro la tarea de {bot}: {task}?",
    stop_propose_media: "¿Te refieres a la tarea de {bot}? Di que sí, o di para la música.",
    stopped: "Vale, he parado a {bot}. Lo que ya hizo se queda.",
    stop_pending_start: "Vale. {bot} todavía está arrancando, así que lo pararé en cuanto lo haga. Lo que haga se queda.",
    stopped_queued: "Vale, {bot} no lo empezará. La tarjeta se queda en el tablero de {bot}.",
    stop_already: "{bot} ya no está con eso.",
    stop_requested: "Le he pedido a {bot} que pare. Lo que ya hizo se queda.",
    stop_none: "No encontré esa tarea.",
    handoff_stop_phone_title: "Crow en {display}: ¿parar la tarea de {bot}?",
  };
  for (const [k, v] of Object.entries(en)) assert.equal(VOICE_LINES.en[k], v, k);
  for (const [k, v] of Object.entries(es)) assert.equal(VOICE_LINES.es[k], v, k);
  assert.equal(voiceLine("stop_propose", "es", { bot: "Writer", task: "investigar la radio" }), "¿Paro la tarea de Writer: investigar la radio?");
});

test("the spoken lines follow the row's language for the stop itself and the turn's for the ask", async () => {
  const s = await setup();
  const { id } = await started(s, { lang: "es", transcript: "que writer investigue la radio", task: "investigar la radio" });
  assert.deepEqual(await s.ask("para a writer", { lang: "es" }), { say: "¿Paro la tarea de Writer: investigar la radio?", verb: "stop_propose" });
  assert.deepEqual(await s.ask("sí", { lang: "es" }), { say: "Vale, he parado a Writer. Lo que ya hizo se queda.", verb: "stop_stopped" });
  assert.equal((await s.row(id)).status, "stopped");
  s.done();
});
