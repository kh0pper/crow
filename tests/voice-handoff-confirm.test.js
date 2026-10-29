/**
 * The spoken yes (PR 3, Task 3.8): core.confirm creates the card synchronously, detaches the spawn and races it
 * against the start budget, says "on it" only when the bot really started on an up model, watches the first
 * turn and reports a failed start once; fastPath answers a pending hand-off or which; the sweep is wired with
 * the engine's stop. A scratch init-db'd crow.db plus a tasks.db per test, the real give-service, the real
 * store, the real voice-bot loader and candidate list, a fake engine with a controllable spawn, a fake clock.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, copyFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import Database from "better-sqlite3";
import { harness } from "./fixtures/voice-turn-harness.mjs";

const root = mkdtempSync(join(tmpdir(), "vh-confirm-"));
process.env.CROW_DATA_DIR = join(root, "master");
process.env.CROW_HOME = join(root, "home");
delete process.env.CROW_DB_PATH;
process.env.CROW_TASKS_DB_PATH = join(root, "master", "tasks.db");
const REPO = new URL("..", import.meta.url).pathname;
const MASTER = { crow: join(root, "master", "crow.db"), tasks: join(root, "master", "tasks.db") };

const { createDbClient } = await import("../servers/db.js");
const { _setEngineStatusForTest: setStatus } = await import("../servers/gateway/dashboard/panels/bot-builder/engine-gate.js");
const H = await import("../servers/gateway/voice/handoff.js");
const { createHandoffCore, createHandoffVoiceActions, proposeHandoff, startHandoffSweep, HANDOFF_TOOL_NAME } = H;
const { createHandoffStore, findHandoffCard } = await import("../servers/gateway/voice/handoff-store.js");
const { createSummaryCache } = await import("../servers/gateway/voice/bot-summaries.js");
const { createPendingStore, chainVoiceActions } = await import("../servers/gateway/voice/pending.js");
const { botDefsGeneration, bumpBotDefsGeneration } = await import("../servers/gateway/voice/defs-generation.js");
const { createVoiceBotLoader } = await import("../servers/gateway/voice/crow-voice.js");
const { voiceLine } = await import("../servers/gateway/voice/voice-lines.js");
const { HANDOFF_START_BUDGET_MS, HANDOFF_STARTING_STUCK_MS, HANDOFF_PROPOSAL_TTL_MS } = await import("../servers/gateway/voice/handoff-constants.js");
const { createTaskForBot } = await import("../servers/gateway/board/give-service.js");
const RR = await import("../servers/gateway/board/result-requesters.js");
const { CROW_VOICE_BOT_ID } = await import("../servers/shared/voice-bot.js");

const FAST = "crow-voice/qwen3.5-4b";
const VOICE = { bot_id: CROW_VOICE_BOT_ID, kind: "voice", display_name: "Crow", fast_voice_model: FAST, handoff: { enabled: true, allowed_bots: [] } };
const board = (over = {}) => ({ gateways: [{ type: "perch" }], tracker_config: { type: "kanban" }, models: { default: "prov/model-a" }, ...over });
const BOTS = {
  writer: board({ description: "Researches topics and writes them up as documents" }),
  helper: board({ description: "Sets up automations", models: { default: "prov/model-b" } }),
  plain: board({ gateways: [{ type: "glasses" }], description: "No Perch" }),
};
const ASK = "have writer research radio history and write it up";
const TASK = "research radio history and write it up";
const DEVICE = { id: "phone-1", name: "Phone" };
const T0 = 1_800_000_000_000;   // 2027-01-15T08:00:00.000Z
const line = (key, vars = {}, lang = "en") => voiceLine(key, lang, { bot: "Writer", task: TASK, ...vars });
const says = (t) => [{ type: "content_delta", text: t }, { type: "done" }];
const call = (args, id = "h1") => [{ type: "tool_call", id, name: HANDOFF_TOOL_NAME, arguments: args }, { type: "done" }];
const flush = () => new Promise((r) => setImmediate(r));
function deferred() { let res, rej; const promise = new Promise((a, b) => { res = a; rej = b; }); return { promise, res, rej }; }
const noSession = () => Object.assign(new Error("no_such_session"), { code: "no_such_session" });

let PID;
const open = [];
after(() => { setStatus(null); for (const c of open) { try { c.close(); } catch {} } rmSync(root, { recursive: true, force: true }); });

before(() => {
  mkdirSync(join(root, "master"), { recursive: true });
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: join(root, "master") }, stdio: "pipe", cwd: REPO });
  const raw = new Database(MASTER.crow);
  PID = Number(raw.prepare("INSERT INTO project_spaces (slug, name) VALUES ('voice-p','Voice P')").run().lastInsertRowid);
  // Each bot has a board of its own: a card's drawer link names its project's board bot (card-link.js), so
  // writer's cards must link to writer.
  const others = { helper: "helper-p", plain: "plain-p" };
  const seed = raw.prepare("INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES (?,?,?,1,?)");
  seed.run(CROW_VOICE_BOT_ID, "Crow", JSON.stringify(VOICE), null);
  for (const [id, def] of Object.entries(BOTS)) {
    const pid = id === "writer" ? PID : Number(raw.prepare("INSERT INTO project_spaces (slug, name) VALUES (?,?)").run(others[id], id).lastInsertRowid);
    seed.run(id, id[0].toUpperCase() + id.slice(1), JSON.stringify(def), pid);
  }
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
  t.exec(`CREATE TABLE board_mutations (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL,
    verb TEXT NOT NULL, actor_kind TEXT NOT NULL, actor_id TEXT, job_id TEXT,
    detail_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  t.close();
});

let n = 0;
/** A fresh copy of the seeded databases; the tasks path is what card-link's cardDrawerHref opens. */
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
  return { db, tdb, tasks };
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

/**
 * The engine as confirm sees it: a controllable spawn (`hold` a deferred the spawn awaits, after the session
 * exists), watchTurns with the first-turn replay, stop clearing the watchers, and `endTurn` to drive a counted
 * turn end the way the real engine does (its own away push after 30 s unless the turn's push was suppressed).
 */
function fakeEngine(notifications) {
  const sessions = new Map();
  const calls = { spawn: [], message: [], stop: [], watched: [] };
  let k = 0;
  const eng = {
    calls, sessions, hold: null, spawnResult: null,
    checkCardFree: async () => {},
    async spawn(args) {
      const sessionId = "s" + (++k);
      sessions.set(sessionId, { sessionId, cardId: args.cardId, watchers: new Set(), firstTurn: null });
      calls.spawn.push({ ...args, sessionId });
      if (eng.hold) await eng.hold.promise;
      return eng.spawnResult ? eng.spawnResult(sessionId) : { sessionId, threadId: "t-" + sessionId, state: "starting" };
    },
    async message(sid, note) { calls.message.push([sid, note]); },
    watchTurns(sid, fn, { first = false } = {}) {
      const s = sessions.get(sid);
      if (!s) throw noSession();
      calls.watched.push(sid);
      if (first && s.firstTurn) {
        fn({ ...s.firstTurn, replay: true, alreadyPushed: !!s.firstTurn.pushed, suppressPush() {} });
        return () => {};
      }
      const w = { fn, first };
      s.watchers.add(w);
      return () => s.watchers.delete(w);
    },
    suppressTurnEndPush: () => false,
    async stop(sid) {
      calls.stop.push(sid);
      const s = sessions.get(sid);
      if (!s) throw noSession();
      s.watchers.clear();
      s.stopped = true;
      return { ok: true };
    },
    /** A counted turn ends: watchers first (synchronously), then the engine's own away push decision. */
    endTurn(sid, outcome, { ranS = 1, errorText = null } = {}) {
      const s = sessions.get(sid);
      const record = { outcome, errorText, pushed: false };
      if (!s.firstTurn) s.firstTurn = record;
      const turn = { noPush: false };
      for (const w of [...s.watchers]) {
        if (w.first) s.watchers.delete(w);
        w.fn({ outcome, errorText, replay: false, alreadyPushed: false, suppressPush: () => { turn.noPush = true; } });
      }
      if (ranS >= 30 && !turn.noPush) { notifications.push({ title: outcome === "ok" ? "Writer replied" : "Writer: turn failed", engine: true }); record.pushed = true; }
    },
  };
  return eng;
}

async function setup({ avail = {}, store = null } = {}) {
  setStatus({ state: "ready", source: "test", cliPath: "/nonexistent/pi" });
  const { db, tdb, tasks } = freshDbs();
  const now = clock();
  const notifications = [];
  const announced = [];
  const logs = [];
  const eng = fakeEngine(notifications);
  const bus = new EventEmitter();
  const pending = createPendingStore({ now });
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  const core = createHandoffCore({
    store: store || createHandoffStore({ now }),
    summaries: createSummaryCache({ bus, now }),
    availability: async (_db, key) => avail[key] ?? "up",
    loadVoiceDef: createVoiceBotLoader({ generation: botDefsGeneration, now }),
    engine: async () => eng,
    openTasksDb: () => createDbClient(tasks),
    notify: async (_db, nf) => { notifications.push(nf); return { id: notifications.length }; },
    announce: async (a) => { announced.push(a); return { spokenOn: null }; },
    withDb: (fn) => fn(db),
    wait: now.wait,
    now,
    log: (m) => logs.push(m),
  });
  const actions = createHandoffVoiceActions({ core, pending });
  const voiceDef = async () => JSON.parse((await db.execute({ sql: "SELECT definition FROM pi_bot_defs WHERE bot_id=?", args: [CROW_VOICE_BOT_ID] })).rows[0].definition);
  const candidates = async () => core.summaries.get(db, await voiceDef());
  async function propose({ bot = "writer", lang = "en", surface = "phone", transcript = ASK, task = TASK } = {}) {
    const out = await proposeHandoff({ core, pending, db, device: DEVICE, surface, lang, transcript, candidates: await candidates(), log: core.log }, task, bot);
    return { out, id: pending.get(DEVICE.id).id };
  }
  const answer = (transcript, over = {}) => actions.fastPath({ db, device: DEVICE, surface: "phone", transcript, lang: "en", bot: VOICE, ...over });
  const row = (id) => core.store.get(db, id);
  const cards = async () => (await tdb.execute("SELECT * FROM tasks_items ORDER BY id")).rows;
  const setVoiceDef = async (def) => { await db.execute({ sql: "UPDATE pi_bot_defs SET definition=? WHERE bot_id=?", args: [JSON.stringify(def), CROW_VOICE_BOT_ID] }); bumpBotDefsGeneration(); };
  const done = () => process.off("unhandledRejection", onUnhandled);
  return { db, tdb, now, eng, core, actions, pending, notifications, announced, logs, unhandled, propose, answer, row, cards, setVoiceDef, done };
}

/** A hand-off confirmed while the spawn is held: the turn said "starting up" and the row is `starting`. */
async function startingUp(s, over = {}) {
  const { id } = await s.propose(over);
  s.eng.hold = deferred();
  const p = s.answer("yes");
  await flush();
  s.now.advance(HANDOFF_START_BUDGET_MS);
  const fp = await p;
  assert.equal(fp.say, line("handoff_starting_up", {}, over.lang));
  assert.equal((await s.row(id)).status, "starting");
  return { id, sid: s.eng.calls.spawn[0].sessionId };
}

test("yes with an up model creates one card, starts it, then says on it", async () => {
  const s = await setup();
  const { id } = await s.propose();
  const order = [];
  const spawn = s.eng.spawn;
  s.eng.spawn = async (args) => { order.push(`spawn:${(await s.cards()).length}`); return spawn(args); };
  const fp = await s.answer("yes");
  order.push("say");
  assert.deepEqual(fp, { say: "Okay, Writer's on it.", verb: "handoff_started" });
  assert.deepEqual(order, ["spawn:1", "say"], "the card exists before the spawn, and the speech comes last");
  const r = await s.row(id);
  assert.equal(r.status, "started");
  assert.equal(r.session_id, "s1");
  assert.equal(r.thread_id, "t-s1");
  assert.equal(r.decided_at, T0);
  const [card] = await s.cards();
  assert.equal(r.card_id, card.id);
  assert.equal(card.assigned_bot, "writer");
  assert.equal(card.tags, "crow-voice");
  assert.equal(card.title, TASK);
  assert.deepEqual(s.eng.calls.spawn.map((c) => [c.botId, c.cardId]), [["writer", card.id]]);
  assert.deepEqual(s.eng.calls.message, [["s1", ""]], "turn 1 fires with an empty note");
  assert.deepEqual(s.eng.calls.watched, ["s1"], "the first turn is watched");
  const audit = (await s.db.execute({ sql: "SELECT payload FROM project_audit_log WHERE action='card_given' AND target=?", args: [`card:${card.id}`] })).rows;
  assert.deepEqual(JSON.parse(audit[0].payload), { bot_id: "writer", via: "voice", surface: "phone", handoff_id: id, created: true });
  assert.equal(RR.requesterOf(card.id), "voice", "the result is claimed for the voice rail");
  assert.equal(s.pending.get(DEVICE.id), null, "the entry is taken");
  assert.equal(s.core.inFlight.size, 0);
  assert.deepEqual(s.notifications, []);
  s.done();
});

test("a cold model never blocks the yes or claims on it", async () => {
  const s = await setup({ avail: { "prov/model-a": "on_demand" } });
  const { id } = await s.propose();
  s.eng.hold = deferred();
  const p = s.answer("yes");
  await flush();
  assert.equal((await s.cards()).length, 1, "the card is created before the spawn settles");
  assert.ok(s.core.inFlight.has(id));
  s.now.advance(HANDOFF_START_BUDGET_MS);
  const fp = await p;
  assert.equal(fp.say, "It's on Writer's board, and Writer is starting up. I'll tell you if it can't.");
  assert.equal(fp.verb, "handoff_starting");
  assert.equal((await s.row(id)).status, "starting");
  assert.ok(s.core.inFlight.has(id), "still in flight while the spawn runs");
  s.now.advance(200_000);
  s.eng.hold.res();
  await flush();
  const r = await s.row(id);
  assert.equal(r.status, "started");
  assert.equal(r.session_id, "s1");
  assert.ok(!s.core.inFlight.has(id));
  assert.deepEqual(s.eng.calls.watched, ["s1"]);
  s.done();
});

test("an on-demand model that started inside the budget still says starting up, never on it", async () => {
  const s = await setup({ avail: { "prov/model-a": "on_demand" } });
  const { id } = await s.propose();
  const fp = await s.answer("yes");
  assert.equal(fp.say, line("handoff_starting_up"));
  await flush();
  assert.equal((await s.row(id)).status, "started");
  s.done();
});

test("a cold start whose first turn fails is reported once", async () => {
  const s = await setup({ avail: { "prov/model-a": "on_demand" } });
  const { id, sid } = await startingUp(s);
  s.eng.hold.res();
  await flush();
  assert.equal((await s.row(id)).status, "started");
  s.eng.endTurn(sid, "failed", { ranS: 5, errorText: "connection refused" });
  await flush();
  const r = await s.row(id);
  assert.equal(r.status, "queued");
  assert.equal(r.detail, "turn1_failed");
  assert.equal(s.notifications.length, 1);
  const [nf] = s.notifications;
  assert.equal(nf.title, "Writer couldn't start research radio history and write it up. It's waiting on Writer's board.");
  assert.equal(nf.type, "attention");
  assert.equal(nf.priority, "high");
  assert.equal(nf.action_url, `/dashboard/bot-board?bot=writer#open=${r.card_id}`);
  assert.equal(s.announced.length, 1);
  assert.equal(s.announced[0].originDeviceId, DEVICE.id);
  assert.equal(s.announced[0].lineFor("phone"), nf.title);
  assert.equal(s.eng.sessions.get(sid).watchers.size, 0, "a first watcher fires once");
  s.done();
});

test("a first turn that fails after 30 s sends exactly one notification (the engine's own push is suppressed)", async () => {
  const s = await setup({ avail: { "prov/model-a": "on_demand" } });
  const { id, sid } = await startingUp(s);
  s.eng.hold.res();
  await flush();
  s.eng.endTurn(sid, "failed", { ranS: 40 });
  await flush();
  assert.equal((await s.row(id)).detail, "turn1_failed");
  assert.equal(s.notifications.length, 1);
  assert.equal(s.notifications[0].engine, undefined, "the hand-off's notification, not Perch's");
  s.done();
});

test("a stalled first turn, and a pi exit on turn 1, are reported", async () => {
  for (const outcome of ["stalled", "exited"]) {
    const s = await setup({ avail: { "prov/model-a": "on_demand" } });
    const { id, sid } = await startingUp(s);
    s.eng.hold.res();
    await flush();
    s.eng.endTurn(sid, outcome, { ranS: 2 });
    await flush();
    const r = await s.row(id);
    assert.equal(r.status, "queued");
    assert.equal(r.detail, "turn1_" + outcome);
    assert.equal(s.notifications.length, 1);
    s.done();
  }
});

test("turn 1 ending before finishStart registers is replayed", async () => {
  // Under 30 s: the replay carries no push, so the hand-off notifies once.
  const s = await setup({ avail: { "prov/model-a": "on_demand" } });
  const { id, sid } = await startingUp(s);
  s.eng.endTurn(sid, "failed", { ranS: 5 });
  assert.deepEqual(s.notifications, [], "nothing yet: no watcher is registered");
  s.eng.hold.res();
  await flush();
  const r = await s.row(id);
  assert.equal(r.status, "queued");
  assert.equal(r.detail, "turn1_failed");
  assert.equal(s.notifications.length, 1);
  assert.equal(s.notifications[0].engine, undefined);
  s.done();
  // 30 s or more: Perch already pushed, so the hand-off sends none of its own and still updates the row.
  const s2 = await setup({ avail: { "prov/model-a": "on_demand" } });
  const b = await startingUp(s2);
  s2.eng.endTurn(b.sid, "failed", { ranS: 35 });
  assert.equal(s2.notifications.length, 1, "Perch's own push");
  s2.eng.hold.res();
  await flush();
  assert.equal((await s2.row(b.id)).detail, "turn1_failed");
  assert.equal(s2.notifications.length, 1, "no second notification");
  assert.equal(s2.announced.length, 1, "still announced");
  s2.done();
});

test("a successful first turn unwatches and sends nothing", async () => {
  const s = await setup();
  const { id } = await s.propose();
  await s.answer("yes");
  s.eng.endTurn("s1", "ok", { ranS: 45 });
  await flush();
  assert.equal((await s.row(id)).status, "started");
  assert.equal(s.eng.sessions.get("s1").watchers.size, 0);
  assert.deepEqual(s.notifications.map((x) => x.title), ["Writer replied"], "Perch's own push is untouched");
  s.done();
});

test("stop clears the watchers: a turn end after a stop touches nothing", async () => {
  const s = await setup();
  const { id } = await s.propose();
  await s.answer("yes");
  assert.equal(await s.core.store.transition(s.db, id, ["started"], "stopped"), true);   // core.stop is Task 5.4
  await s.eng.stop("s1");
  s.eng.endTurn("s1", "failed", { ranS: 5 });
  await flush();
  const r = await s.row(id);
  assert.equal(r.status, "stopped");
  assert.equal(r.detail, null);
  assert.deepEqual(s.notifications, []);
  s.done();
});

test("a stop landing inside the 3 s budget never says on it", async () => {
  const s = await setup();
  const { id } = await s.propose();
  s.eng.hold = deferred();
  const p = s.answer("yes");
  await flush();
  assert.equal(await s.core.store.transition(s.db, id, ["starting"], "stopped"), true);
  s.eng.hold.res();
  const fp = await p;
  assert.deepEqual(fp, { say: "Writer's task was stopped. What it made so far is kept.", verb: "handoff_stopped" });
  const r = await s.row(id);
  assert.equal(r.status, "stopped");
  assert.equal(r.session_id, "s1");
  assert.equal(r.thread_id, "t-s1");
  assert.deepEqual(s.eng.calls.stop, ["s1"]);
  assert.deepEqual(s.eng.calls.watched, [], "no turn-1 watcher on a stopped row");
  assert.equal(s.core.inFlight.size, 0);
  s.done();
});

test("a stop that lands between the CAS and the spawn settling leaves no running session", async () => {
  const s = await setup({ avail: { "prov/model-a": "on_demand" } });
  const { id, sid } = await startingUp(s);
  assert.equal(await s.core.store.transition(s.db, id, ["starting"], "stopped"), true);
  s.eng.hold.res();
  await flush();
  const r = await s.row(id);
  assert.equal(r.status, "stopped");
  assert.equal(r.session_id, sid);
  assert.equal(r.detail, null);
  assert.deepEqual(s.eng.calls.stop, [sid]);
  assert.deepEqual(s.eng.calls.watched, []);
  assert.ok(!s.core.inFlight.has(id));
  assert.deepEqual(s.notifications, []);
  s.done();
});

test("an engine.stop error on that path leaves stop_pending with the session id, and the sweep retries it", async () => {
  const s = await setup({ avail: { "prov/model-a": "on_demand" } });
  const { id, sid } = await startingUp(s);
  await s.core.store.transition(s.db, id, ["starting"], "stopped");
  const stop = s.eng.stop;
  s.eng.stop = async (x) => { s.eng.calls.stop.push(x); throw new Error("engine busy"); };
  s.eng.hold.res();
  await flush();
  let r = await s.row(id);
  assert.equal(r.status, "stopped");
  assert.equal(r.detail, "stop_pending");
  assert.equal(r.session_id, sid);
  assert.ok(s.logs.some((m) => /engine busy/.test(m)), s.logs.join("\n"));
  s.eng.stop = stop;
  const sweep = startHandoffSweep({ core: s.core, intervalMs: 3_600_000, openDb: () => ({ execute: (...a) => s.db.execute(...a), close() {} }) });
  try {
    assert.equal((await sweep.runOnce()).retried, 1);
  } finally { sweep.stop(); }
  r = await s.row(id);
  assert.equal(r.detail, null);
  assert.deepEqual(s.eng.calls.stop, [sid, sid]);
  s.done();
});

test("a throw in the detached finish is logged, not unhandled", async () => {
  const s = await setup({ avail: { "prov/model-a": "on_demand" } });
  const { id } = await startingUp(s);
  const transition = s.core.store.transition;
  s.core.store.transition = async (db, hid, from, to, ...rest) => {
    if (to === "started") throw new Error("disk full");
    return transition(db, hid, from, to, ...rest);
  };
  s.eng.hold.res();
  await flush();
  await flush();
  assert.ok(s.logs.some((m) => /disk full/.test(m)), s.logs.join("\n"));
  assert.deepEqual(s.unhandled, []);
  assert.ok(!s.core.inFlight.has(id), "the chain's finally still clears the in-flight set");
  s.done();
});

test("the sweep skips a confirm still in flight", async () => {
  const s = await setup({ avail: { "prov/model-a": "on_demand" } });
  const { id } = await startingUp(s);
  s.now.advance(HANDOFF_STARTING_STUCK_MS + 1);
  const r = await s.core.store.sweep(s.db, { inFlight: s.core.inFlight, findCard: findHandoffCard });
  assert.equal(r.requeued + r.failed, 0);
  assert.equal((await s.row(id)).status, "starting");
  s.eng.hold.res();
  await flush();
  assert.equal((await s.row(id)).status, "started");
  s.done();
});

test("the card is a hand-made Give card", async () => {
  const s = await setup();
  const before = (await s.db.execute("SELECT definition FROM pi_bot_defs WHERE bot_id='writer'")).rows[0].definition;
  const { id } = await s.propose();
  await s.answer("yes");
  const byHand = await createTaskForBot(s.db, s.tdb, "writer", { title: "By hand" });
  const [voice, hand] = await s.cards();
  assert.equal(voice.autonomy, hand.autonomy);
  assert.equal(voice.autonomy, "gated");
  assert.equal(Number(voice.project_id), PID);
  assert.equal(Number(voice.project_id), Number(byHand.row.project_id));
  assert.equal(voice.status, hand.status);
  assert.equal((await s.db.execute("SELECT definition FROM pi_bot_defs WHERE bot_id='writer'")).rows[0].definition, before, "writer's definition is untouched");
  assert.equal((await s.row(id)).card_id, voice.id);
  s.done();
});

test("the card carries the confirmed task and the operator's words", async () => {
  const s = await setup();
  const long = "write a report on " + "radio ".repeat(40) + "history";
  await s.propose({ task: long, transcript: "please have writer write that long report" });
  await s.answer("yes");
  const [card] = await s.cards();
  assert.ok(card.title.length <= 120);
  assert.ok(long.startsWith(card.title));
  assert.notEqual(card.title.at(-1), " ");
  assert.ok(/radio$/.test(card.title), "cut on a word");
  assert.equal(card.description,
    long + "\n\nOperator's words: \"please have writer write that long report\"\n\nAsked by voice (Crow, phone) on 2027-01-15. "
    + "When you are done, call board_report_result. Keep anything you write; nothing is undone if this task is stopped.");
  s.done();
});

test("the session is filed under the card's project", async () => {
  const s = await setup();
  await s.propose();
  await s.answer("yes");
  const { projectOfItems } = await import("../servers/shared/shell-items.js");
  const m = await projectOfItems(s.db, "perch_thread", ["t-s1"]);
  assert.equal(Number(m.get ? m.get("t-s1") : m["t-s1"]), PID);
  s.done();
});

test("two yeses create one card", async () => {
  const s = await setup();
  const { id } = await s.propose();
  const [a, b] = await Promise.all([s.core.confirm(s.db, id, "yes", "voice"), s.core.confirm(s.db, id, "yes", "voice")]);
  assert.deepEqual([a.status, b.status].sort(), ["already", "started"]);
  const already = a.status === "already" ? a : b;
  assert.equal(already.say, "That one is already with Writer.");
  assert.equal((await s.cards()).length, 1);
  assert.equal(s.eng.calls.spawn.length, 1);
  // By voice: the entry is taken on the first yes, so a second yes is just an utterance.
  const s2 = await setup();
  await s2.propose();
  assert.equal((await s2.answer("yes")).verb, "handoff_started");
  assert.equal(await s2.answer("yes"), null);
  assert.equal((await s2.cards()).length, 1);
  s.done(); s2.done();
});

test("a yes after expiry creates nothing", async () => {
  const s = await setup();
  const { id } = await s.propose();
  s.now.advance(HANDOFF_PROPOSAL_TTL_MS + 1);
  const r = await s.core.confirm(s.db, id, "yes", "voice");
  assert.equal(r.status, "expired");
  assert.equal(r.say, line("handoff_failed"));
  // A no on an expired proposal just declines.
  const s3 = await setup();
  const { id: id3 } = await s3.propose();
  s3.now.advance(HANDOFF_PROPOSAL_TTL_MS + 1);
  assert.deepEqual(await s3.core.confirm(s3.db, id3, "no", "voice"), { status: "expired", say: "Okay, I won't." });
  assert.equal((await s3.row(id3)).status, "expired");
  s3.done();
  assert.deepEqual(await s.cards(), []);
  assert.equal((await s.row(id)).status, "expired");
  assert.equal(s.eng.calls.spawn.length, 0);
  // By voice, with an entry that outlives its row (a longer pending TTL): the row's TTL is the guard.
  const s2 = await setup();
  const { id: id2 } = await s2.propose();
  const longer = createPendingStore({ now: s2.now, ttlMs: HANDOFF_PROPOSAL_TTL_MS * 2 });
  longer.set(DEVICE.id, s2.pending.get(DEVICE.id));
  const actions = createHandoffVoiceActions({ core: s2.core, pending: longer });
  s2.now.advance(HANDOFF_PROPOSAL_TTL_MS + 1);
  const fp = await actions.fastPath({ db: s2.db, device: DEVICE, surface: "phone", transcript: "yes", lang: "en", bot: VOICE });
  assert.deepEqual(fp, { say: line("handoff_failed"), verb: "handoff_expired" });
  assert.deepEqual(await s2.cards(), []);
  assert.equal((await s2.row(id2)).status, "expired");
  s.done(); s2.done();
});

test("hand-offs turned off, the bot removed from allowed_bots, or the voice bot switched off before the yes: nothing is created", async () => {
  const cases = [
    ["hand-offs off", (s) => s.setVoiceDef({ ...VOICE, handoff: { enabled: false } })],
    ["writer not allowed", (s) => s.setVoiceDef({ ...VOICE, handoff: { enabled: true, allowed_bots: ["helper"] } })],
    ["voice bot off", async (s) => { await s.db.execute({ sql: "UPDATE pi_bot_defs SET enabled=0 WHERE bot_id=?", args: [CROW_VOICE_BOT_ID] }); bumpBotDefsGeneration(); }],
    ["bot disabled", async (s) => { await s.db.execute("UPDATE pi_bot_defs SET enabled=0 WHERE bot_id='writer'"); bumpBotDefsGeneration(); }],
    ["board turned off", async (s) => { await s.db.execute({ sql: "UPDATE pi_bot_defs SET definition=? WHERE bot_id='writer'", args: [JSON.stringify(board({ tracker_config: { type: "none" } }))] }); bumpBotDefsGeneration(); }],
  ];
  for (const [name, change] of cases) {
    const s = await setup();
    const { id } = await s.propose();
    await change(s);
    const fp = await s.answer("yes");
    assert.deepEqual(fp, { say: line("handoff_failed"), verb: "handoff_failed" }, name);
    const r = await s.row(id);
    assert.equal(r.status, "failed", name);
    assert.equal(r.detail, "not_allowed", name);
    assert.deepEqual(await s.cards(), [], name);
    assert.equal(s.eng.calls.spawn.length, 0, name);
    s.done();
  }
});

test("a setting saved one second before the yes is seen (no cache in the way)", async () => {
  const s = await setup();
  const { id } = await s.propose();
  assert.ok(await s.core.loadVoiceDef(s.db), "the loader is warm");
  assert.equal((await s.core.summaries.get(s.db, VOICE)).length, 3, "the candidate cache is warm");
  await s.setVoiceDef({ ...VOICE, handoff: { enabled: true, allowed_bots: ["helper"] } });
  s.now.advance(1000);
  const fp = await s.answer("yes");
  assert.equal(fp.verb, "handoff_failed");
  assert.equal((await s.row(id)).detail, "not_allowed");
  assert.deepEqual(await s.cards(), []);
  s.done();
});

test("the starting-up line and the notification follow the row's language", async () => {
  const s = await setup({ avail: { "prov/model-a": "on_demand" } });
  const { id, sid } = await startingUp(s, { lang: "es" });
  assert.equal((await s.row(id)).lang, "es");
  s.eng.hold.res();
  await flush();
  s.eng.endTurn(sid, "failed", { ranS: 3 });
  await flush();
  assert.equal(s.notifications[0].title, "Writer no pudo empezar: research radio history and write it up. Está esperando en el tablero de Writer.");
  assert.equal(s.announced[0].lineFor("phone"), s.notifications[0].title);
  s.done();
});

test("model up at proposal, down at yes: queued, not started", async () => {
  const avail = { "prov/model-a": "up" };
  const s = await setup({ avail });
  const { id } = await s.propose();
  assert.equal((await s.row(id)).start_now, 1);
  avail["prov/model-a"] = "unavailable";
  const fp = await s.answer("yes");
  assert.deepEqual(fp, { say: "Okay, it's on Writer's board. Writer can't start it right now, so it will wait there.", verb: "handoff_queued" });
  const r = await s.row(id);
  assert.equal(r.status, "queued");
  assert.equal(r.detail, "model_unavailable");
  assert.equal((await s.cards()).length, 1);
  assert.equal(s.eng.calls.spawn.length, 0);
  assert.deepEqual(s.notifications, [], "the operator heard it; no notification");
  s.done();
});

test("a bot without Perch is queued with perch_not_attached and never started", async () => {
  const s = await setup();
  const { id } = await s.propose({ bot: "plain", transcript: "have plain do it" });
  assert.equal((await s.row(id)).start_now, 0);
  const fp = await s.answer("yes");
  assert.equal(fp.say, voiceLine("handoff_queued", "en", { bot: "Plain" }));
  const r = await s.row(id);
  assert.equal(r.status, "queued");
  assert.equal(r.detail, "perch_not_attached");
  assert.equal(s.eng.calls.spawn.length, 0);
  s.done();
});

test("a dispatch refused inside the budget is queued with its code; refused after the budget, it is notified", async () => {
  const s = await setup();
  const { id } = await s.propose();
  setStatus({ state: "missing", source: "test" });   // dispatchCard: engine_required
  const fp = await s.answer("yes");
  assert.equal(fp.verb, "handoff_queued");
  let r = await s.row(id);
  assert.equal(r.status, "queued");
  assert.equal(r.detail, "engine_required");
  assert.deepEqual(s.notifications, []);
  s.done();
  const s2 = await setup({ avail: { "prov/model-a": "on_demand" } });
  const b = await startingUp(s2);
  s2.eng.spawnResult = () => { throw Object.assign(new Error("no slot"), { code: "pi_capacity" }); };
  s2.eng.hold.res();
  await flush();
  r = await s2.row(b.id);
  assert.equal(r.status, "queued");
  assert.equal(r.detail, "pi_capacity");
  assert.equal(s2.notifications.length, 1);
  assert.equal(s2.notifications[0].title, line("handoff_start_failed"));
  s2.done();
});

test("confirm refuses a stop row, and an unknown id", async () => {
  const s = await setup();
  const stopId = await s.core.store.insert(s.db, { kind: "stop", surface: "kiosk", device_id: "kiosk-1", bot_id: "writer", task: TASK, status: "awaiting_phone", target_id: "vh-x" });
  assert.deepEqual(await s.core.confirm(s.db, stopId, "yes", "phone"), { status: "wrong_kind" });
  assert.deepEqual(await s.core.confirm(s.db, stopId, "no", "phone"), { status: "wrong_kind" });
  assert.equal((await s.row(stopId)).status, "awaiting_phone");
  assert.deepEqual(await s.core.confirm(s.db, "vh-nope", "yes", "voice"), { status: "none" });
  assert.deepEqual(await s.cards(), []);
  s.done();
});

test("a long yes never speaks on it without a card", async () => {
  const s = await setup();
  const { id } = await s.propose();
  await s.tdb.execute("DROP TABLE tasks_items");
  const fp = await s.answer("yes");
  assert.deepEqual(fp, { say: line("handoff_failed"), verb: "handoff_failed" });
  const r = await s.row(id);
  assert.equal(r.status, "failed");
  assert.equal(r.card_id, null);
  assert.equal(r.detail, "tasks_db");
  assert.equal(s.eng.calls.spawn.length, 0);
  assert.equal(s.core.inFlight.size, 0);
  s.done();
});

test("a tasks store that cannot be opened fails the row at once, never leaving it starting for the sweep", async () => {
  const s = await setup();
  const { id } = await s.propose();
  s.core.openTasksDb = () => { throw new Error("tasks.db is locked"); };
  const fp = await s.answer("yes");
  assert.deepEqual(fp, { say: line("handoff_failed"), verb: "handoff_failed" });
  const r = await s.row(id);
  assert.equal(r.status, "failed");
  assert.equal(r.detail, "tasks_db");
  assert.equal(s.core.inFlight.size, 0);
  // A give refusal keeps its own code.
  const s2 = await setup();
  const { id: id2 } = await s2.propose();
  s2.core.give.createTaskForBot = async () => { throw Object.assign(new Error("no board"), { code: "no_board", http: 409 }); };
  await s2.answer("yes");
  assert.equal((await s2.row(id2)).detail, "no_board");
  s.done(); s2.done();
});

test("a no that changes the task is a correction, not a decline; a plain refusal declines", async () => {
  const s = await setup();
  const { id } = await s.propose();
  for (const t of ["no, make it about radio drama", "no, have writer write a summary instead", "no, que sea sobre la radio", "no, change it to a short summary"]) {
    assert.equal(await s.answer(t), null, t);
  }
  assert.equal((await s.row(id)).status, "proposed");
  assert.equal(s.pending.get(DEVICE.id).id, id, "still waiting: the model re-proposes");
  const declines = ["no thanks", "not now", "never mind", "forget it", "I changed my mind", "cancel that", "déjalo", "olvídalo", "ahora no",
    "no, mejor no", "no, mejor lo dejamos", "no pero gracias", "no but thanks", "no, not at all", "no, not at the moment", "no, at least not today",
    "no, let's not have writer do that", "no, writer doesn't need to", "no, make it not happen", "no, que sea no"];
  for (const t of declines) {
    const s2 = await setup();
    const { id: id2 } = await s2.propose();
    assert.deepEqual(await s2.answer(t), { say: "Okay, I won't.", verb: "handoff_declined" }, t);
    assert.equal((await s2.row(id2)).status, "declined", t);
    s2.done();
  }
  s.done();
});

test("no declines and logs", async () => {
  const s = await setup();
  const { id } = await s.propose();
  const fp = await s.answer("no thanks");
  assert.deepEqual(fp, { say: "Okay, I won't.", verb: "handoff_declined" });
  const r = await s.row(id);
  assert.equal(r.status, "declined");
  assert.equal(r.decided_at, T0);
  assert.equal(s.pending.get(DEVICE.id), null);
  assert.deepEqual(await s.cards(), []);
  // Through the phone via, a proposed row is not the phone's to decide.
  const s2 = await setup();
  const { id: id2 } = await s2.propose();
  assert.equal((await s2.core.confirm(s2.db, id2, "no", "phone")).status, "already");
  assert.equal((await s2.row(id2)).status, "proposed");
  s.done(); s2.done();
});

test("anything that is not a yes or a no leaves the proposal waiting", async () => {
  const s = await setup();
  const { id } = await s.propose();
  assert.equal(await s.answer("what's the weather"), null);
  assert.equal(s.pending.get(DEVICE.id).id, id);
  assert.equal((await s.row(id)).status, "proposed");
  s.done();
});

/** The fake turn with the hand-off wired as defaultVoiceDeps wires it. */
function withTurn(s, rounds) {
  const h = harness({ bot: VOICE, chatTools: [], rounds });
  h.deps.handoffs = { forTurn: (c) => s.core.forTurn({ ...c, pending: s.pending }) };
  h.deps.voiceActions = chainVoiceActions([s.actions]);
  const turn = (transcript, opts = {}) => h.runner.runVoiceTurn({ db: s.db, device: { ...h.device, ...DEVICE }, transcript, sink: h.sink, surface: "phone", lang: "en", ...opts });
  return { h, turn };
}

test("\"no, give it to helper\" re-proposes, and the old row is expired", async () => {
  const s = await setup();
  const { id } = await s.propose();
  assert.equal(await s.answer("no, give it to helper"), null, "a correction: the model re-proposes");
  assert.equal(await s.answer("yes, but send it to helper"), null);
  assert.equal(await s.answer("helper instead"), null);
  assert.equal((await s.row(id)).status, "proposed", "fastPath wrote nothing");
  const { h, turn } = withTurn(s, [call({ task: TASK, bot: "helper" })]);
  await turn("no, give it to helper");
  assert.deepEqual(h.calls.spoken, ["I'll have Helper research radio history and write it up — okay?"]);
  assert.equal((await s.row(id)).status, "expired");
  const e = s.pending.get(DEVICE.id);
  assert.equal(e.bot_id, "helper");
  assert.equal((await s.row(e.id)).status, "proposed");
  assert.deepEqual(await s.cards(), []);
  s.done();
});

test("a yes by voice through the turn speaks the server's line and is a fast path", async () => {
  const s = await setup();
  const { id } = await s.propose();
  const { h, turn } = withTurn(s, [says("never")]);
  const r = await turn("yes please");
  assert.deepEqual(h.calls.spoken, ["Okay, Writer's on it."]);
  assert.equal(r.fastPath, true);
  assert.equal(r.timings.verb, "handoff_started");
  assert.equal(h.log.length, 0, "no model round");
  assert.equal((await s.row(id)).status, "started");
  s.done();
});

test("a topic change expires the proposal, and a pending routine entry survives a non-relay turn", async () => {
  const s = await setup();
  const { id } = await s.propose();
  const { turn } = withTurn(s, [says("Sunny. ")]);
  await turn("what's the weather tomorrow");
  assert.equal((await s.row(id)).status, "expired");
  assert.equal(s.pending.get(DEVICE.id), null);
  s.pending.set(DEVICE.id, { kind: "routine", tool: "crow_task_add", say: "Add milk?" });
  await turn("what's the weather tomorrow");
  assert.equal(s.pending.get(DEVICE.id).kind, "routine");
  s.done();
});

test("which, then \"the helper one\", re-proposes helper; \"what's on the menu\" is no answer; a no declines", async () => {
  const s = await setup();
  const which = async () => {
    const { h, turn } = withTurn(s, [call({ task: TASK, candidates: ["writer", "helper"] })]);
    await turn("could someone research radio history");
    assert.equal(h.calls.spoken[0], "That could go to Writer or to Helper — which one?");
    assert.equal(s.pending.get(DEVICE.id).kind, "which");
  };
  await which();
  assert.equal(await s.answer("what's on the menu"), null);
  assert.equal(s.pending.get(DEVICE.id).kind, "which", "still waiting");
  const fp = await s.answer("the helper one");
  assert.deepEqual(fp, { say: "I'll have Helper research radio history and write it up — okay?", verb: "handoff_which" });
  const e = s.pending.get(DEVICE.id);
  assert.equal(e.kind, "handoff");
  assert.equal(e.bot_id, "helper");
  const r = await s.row(e.id);
  assert.equal(r.status, "proposed");
  assert.equal(r.asked, "could someone research radio history", "the original request, not the answer to which one");
  assert.equal(r.surface, "phone");
  // And a yes to that re-proposal hands it to helper.
  assert.equal((await s.answer("yes")).say, "Okay, Helper's on it.");
  assert.equal((await s.cards())[0].assigned_bot, "helper");
  await which();
  assert.deepEqual(await s.answer("no"), { say: "Okay, I won't.", verb: "handoff_declined" });
  assert.equal(s.pending.get(DEVICE.id), null);
  assert.equal((await s.cards()).length, 1);
  s.done();
});

test("turnContext names the pending hand-off or the which options, and nothing else", async () => {
  const s = await setup();
  assert.equal(s.actions.turnContext({ device: DEVICE }), null);
  await s.propose();
  assert.deepEqual(s.actions.turnContext({ device: DEVICE }), {
    text: `[Hand-off] Waiting for a yes or no: Writer: ${TASK}. If the user changes the bot or the task, call crow_handoff again with the change.`, pending: true,
  });
  s.pending.set(DEVICE.id, { kind: "which", task: TASK, options: [{ bot_id: "writer", name: "Writer" }, { bot_id: "helper", name: "Helper" }] });
  assert.equal(s.actions.turnContext({ device: DEVICE }).text, `[Hand-off] Waiting for a yes or no: Writer or Helper: ${TASK}. If the user changes the bot or the task, call crow_handoff again with the change.`);
  s.done();
});

test("startHandoffSweep runs the store's sweep with the in-flight set, the card finder and the engine's stop (R8), armed once", async () => {
  const seen = [];
  const eng = { calls: [], stop: async (sid) => { eng.calls.push(sid); return { ok: true }; } };
  let present = eng;
  const asked = [];
  const core = createHandoffCore({
    store: { sweep: async (db, opts) => { seen.push({ db, opts }); return { expired: 0 }; } },
    summaries: { get: async () => [] }, engine: async (o) => { asked.push(o); return present; }, log: () => {},
  });
  const fake = { execute: async () => ({ rows: [] }), closed: 0, close() { fake.closed++; } };
  const sweep = startHandoffSweep({ core, intervalMs: 3_600_000, openDb: () => fake });
  try {
    assert.equal(startHandoffSweep({ core, intervalMs: 1 }), sweep, "armed once per core");
    await sweep.runOnce();
    assert.equal(seen.length, 1);
    assert.equal(seen[0].db, fake);
    assert.equal(fake.closed, 1, "the pass closes its db");
    assert.equal(seen[0].opts.inFlight, core.inFlight);
    assert.equal(seen[0].opts.findCard, findHandoffCard);
    await seen[0].opts.retryStop("s-9");
    assert.deepEqual(eng.calls, ["s-9"], "retryStop is the engine's stop");
    assert.deepEqual(asked, [{ createIfMissing: false }], "the sweep never mints an engine");
    present = null;
    await assert.rejects(seen[0].opts.retryStop("s-9"), (e) => e.code === "no_such_session", "no engine: nothing to stop");
  } finally { sweep.stop(); }
  const { readFileSync } = await import("node:fs");
  assert.match(readFileSync(join(REPO, "servers/gateway/boot/post-listen.js"), "utf8"), /startHandoffSweep\(\)/, "armed at boot");
});

test("result-requesters: claim, release, requesterOf; markTurnEnd reaches the engine's suppressTurnEndPush and is a no-op without one", async () => {
  RR._resetResultRequestersForTest();
  assert.equal(RR.requesterOf(7), null);
  RR.claimResult(7, "voice");
  assert.equal(RR.requesterOf("7"), "voice");
  assert.throws(() => RR.claimResult(8, "Bad Kind"), /kind/);
  RR.releaseResult(7);
  assert.equal(RR.requesterOf(7), null);
  const P = await import("../servers/gateway/perch-interactive.js");
  P._resetInteractiveEngineForTest();
  assert.equal(await RR.markTurnEnd(7), false, "no engine: nothing to mark");
  const marked = [];
  P._setInteractiveEngineForTest({ suppressTurnEndPush: (id) => { marked.push(id); return true; } });
  try {
    assert.equal(await RR.markTurnEnd(7), true);
    assert.deepEqual(marked, [7]);
  } finally { P._resetInteractiveEngineForTest(); }
});

test("the lines exist in both languages", () => {
  for (const key of ["handoff_started", "handoff_starting_up", "handoff_start_failed", "handoff_queued", "handoff_failed", "handoff_already", "status_stopped"]) {
    assert.ok(voiceLine(key, "en", {}), key);
    assert.ok(voiceLine(key, "es", {}), key + " es");
    assert.notEqual(voiceLine(key, "en", {}), voiceLine(key, "es", {}), key);
  }
  assert.equal(voiceLine("handoff_started", "es", { bot: "Writer" }), "Vale, Writer se pone con ello.");
  assert.equal(voiceLine("handoff_already", "es", { bot: "Writer" }), "Eso ya lo tiene Writer.");
  assert.equal(voiceLine("handoff_queued", "es", { bot: "Writer" }), "Vale, está en el tablero de Writer. Writer no puede empezar ahora, así que esperará ahí.");
  assert.equal(voiceLine("handoff_failed", "es", { bot: "Writer" }), "Lo siento, no pude pasárselo a Writer, así que no se ha empezado nada.");
});
