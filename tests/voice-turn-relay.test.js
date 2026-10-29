/**
 * The relay contract (PR 3, Task 3.9): a voice turn carrying opts.relayThreadId is not the operator's own speech
 * (the R1.2 session's relayed operator turn, or its speak-the-answer call). It offers no hand-off and none of Crow's
 * own tools, never reaches voiceActions.fastPath or turnContext, and its afterTurn clears every pending entry on the
 * device, expiring a hand-off's row, whether or not a model turn ran. A scratch init-db'd crow.db plus a tasks.db per
 * test, the real hand-off core, store, candidate cache and voice-bot loader, the real own tools and the real
 * pending store, chained as defaultVoiceDeps chains them; a fake engine and a fake clock.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, copyFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import Database from "better-sqlite3";
import { harness } from "./fixtures/voice-turn-harness.mjs";

const root = mkdtempSync(join(tmpdir(), "vh-relay-"));
process.env.CROW_DATA_DIR = join(root, "master");
process.env.CROW_HOME = join(root, "home");
delete process.env.CROW_DB_PATH;
process.env.CROW_TASKS_DB_PATH = join(root, "master", "tasks.db");
const REPO = new URL("..", import.meta.url).pathname;
const MASTER = { crow: join(root, "master", "crow.db"), tasks: join(root, "master", "tasks.db") };

const { createDbClient } = await import("../servers/db.js");
const { _setEngineStatusForTest: setStatus } = await import("../servers/gateway/dashboard/panels/bot-builder/engine-gate.js");
const { createHandoffCore, createHandoffVoiceActions, proposeHandoff, HANDOFF_TOOL_NAME } = await import("../servers/gateway/voice/handoff.js");
const { createHandoffStore } = await import("../servers/gateway/voice/handoff-store.js");
const { createSummaryCache } = await import("../servers/gateway/voice/bot-summaries.js");
const { createPendingStore, chainVoiceActions } = await import("../servers/gateway/voice/pending.js");
const { createOwnTools } = await import("../servers/gateway/voice/own-tools.js");
const { botDefsGeneration } = await import("../servers/gateway/voice/defs-generation.js");
const { createVoiceBotLoader } = await import("../servers/gateway/voice/crow-voice.js");
const { isRelayTurn } = await import("../servers/gateway/voice/turn.js");
const { CROW_VOICE_BOT_ID } = await import("../servers/shared/voice-bot.js");

const FAST = "crow-voice/qwen3.5-4b";
const VOICE = { bot_id: CROW_VOICE_BOT_ID, kind: "voice", display_name: "Crow", fast_voice_model: FAST, handoff: { enabled: true, allowed_bots: [] } };
const board = (over = {}) => ({ gateways: [{ type: "perch" }], tracker_config: { type: "kanban" }, models: { default: "prov/model-a" }, ...over });
const BOTS = {
  writer: board({ description: "Researches topics and writes them up as documents" }),
  helper: board({ description: "Sets up automations", models: { default: "prov/model-b" } }),
};
const ASK = "have writer research radio history and write it up";
const TASK = "research radio history and write it up";
// The speak-the-answer call's transcript: the bot's own answer text, which reads like a yes, a status ask and a stop.
const BOT_TEXT = "yes, is it done? stop it";
const DEVICE = { id: "dash-1", name: "Dashboard" };
const REMINDER = "crow_reminder_add";
const T0 = 1_800_000_000_000;   // 2027-01-15T08:00:00.000Z
const says = (t) => [{ type: "content_delta", text: t }, { type: "done" }];
const call = (args, id = "h1") => [{ type: "tool_call", id, name: HANDOFF_TOOL_NAME, arguments: args }, { type: "done" }];
const RELAY = { relayThreadId: "thread-1" };

const open = [];
after(() => { setStatus(null); for (const c of open) { try { c.close(); } catch {} } rmSync(root, { recursive: true, force: true }); });

before(() => {
  mkdirSync(join(root, "master"), { recursive: true });
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: join(root, "master") }, stdio: "pipe", cwd: REPO });
  const raw = new Database(MASTER.crow);
  const seed = raw.prepare("INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES (?,?,?,1,?)");
  seed.run(CROW_VOICE_BOT_ID, "Crow", JSON.stringify(VOICE), null);
  for (const [id, def] of Object.entries(BOTS)) {
    const pid = Number(raw.prepare("INSERT INTO project_spaces (slug, name) VALUES (?,?)").run(`${id}-p`, id).lastInsertRowid);
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

/** An engine that starts every session at once (a yes that gets through really starts the bot). */
function fakeEngine() {
  let k = 0;
  const calls = { spawn: [] };
  return {
    calls,
    checkCardFree: async () => {},
    async spawn(args) { const sessionId = "s" + (++k); calls.spawn.push(args); return { sessionId, threadId: "t-" + sessionId, state: "starting" }; },
    async message() {},
    watchTurns: () => () => {},
    suppressTurnEndPush: () => false,
    async stop() { return { ok: true }; },
  };
}

/**
 * The fake turn with the real hand-off and the real own tools wired as defaultVoiceDeps wires them: one pending
 * store, deps.ownTools = own.forTurn, deps.handoffs.forTurn, and deps.voiceActions = the chain (own tools first).
 * Every seam the relay contract closes is counted: forTurn (both), and the chain members' fastPath/turnContext.
 */
async function setup(rounds = [says("Okay. ")]) {
  setStatus({ state: "ready", source: "test", cliPath: "/nonexistent/pi" });
  const { db, tdb, tasks } = freshDbs();
  const h = harness({ bot: VOICE, chatTools: [], rounds });
  const now = () => T0;
  const pending = createPendingStore({ now });
  const eng = fakeEngine();
  const core = createHandoffCore({
    store: createHandoffStore({ now }),
    summaries: createSummaryCache({ bus: new EventEmitter(), now }),
    availability: async () => "up",
    loadVoiceDef: createVoiceBotLoader({ generation: botDefsGeneration, now }),
    engine: async () => eng,
    openTasksDb: () => createDbClient(tasks),
    notify: async () => ({ id: 1 }),
    announce: async () => ({ spokenOn: null }),
    withDb: (fn) => fn(db),
    now,
    log: (m) => h.calls.logs.push(m),
  });
  const own = createOwnTools({ pending, now, log: (m) => h.calls.logs.push(m), openTasksDb: () => createDbClient(tasks) });
  const handoff = createHandoffVoiceActions({ core, pending });
  const counts = { ownTools: 0, handoffs: 0, fastPath: 0, turnContext: 0, afterTurn: [] };
  // Spy on the real members in place: chainVoiceActions reads each member's method at call time.
  for (const m of [own, handoff]) {
    const { fastPath, turnContext, afterTurn } = m;
    m.fastPath = (a) => { counts.fastPath++; return fastPath(a); };
    m.turnContext = (a) => { counts.turnContext++; return turnContext(a); };
    m.afterTurn = (a) => { counts.afterTurn.push({ relay: a.relay }); return afterTurn(a); };
  }
  h.deps.ownTools = (a) => { counts.ownTools++; return own.forTurn(a); };
  h.deps.handoffs = { forTurn: (c) => { counts.handoffs++; return core.forTurn({ ...c, pending }); } };
  h.deps.voiceActions = chainVoiceActions([own, handoff]);
  const turn = (transcript, opts = {}) => h.runner.runVoiceTurn({ db, device: { ...h.device, ...DEVICE }, transcript, sink: h.sink, surface: "phone", lang: "en", tz: "America/Chicago", ...opts });
  async function propose() {
    const def = JSON.parse((await db.execute({ sql: "SELECT definition FROM pi_bot_defs WHERE bot_id=?", args: [CROW_VOICE_BOT_ID] })).rows[0].definition);
    await proposeHandoff({ core, pending, db, device: DEVICE, surface: "phone", lang: "en", transcript: ASK, candidates: await core.summaries.get(db, def), log: core.log }, TASK, "writer");
    return pending.get(DEVICE.id).id;
  }
  /** A strict-confirm reminder waiting for its yes, held exactly as own-tools.js holds one. */
  const holdReminder = () => pending.set(DEVICE.id, { kind: "routine", tool: REMINDER, args: { text: "call the plumber", at: "2027-01-15T15:00:00-06:00" }, say: "Remind you to call the plumber at 3 PM?", lang: "en", tz: "America/Chicago" });
  const row = (id) => core.store.get(db, id);
  const cards = async () => (await tdb.execute("SELECT * FROM tasks_items ORDER BY id")).rows;
  const schedules = async () => (await db.execute("SELECT * FROM schedules")).rows;
  return { h, db, pending, core, own, handoff, eng, counts, turn, propose, holdReminder, row, cards, schedules };
}

test("a relay turn offers no own tools and no hand-off", async () => {
  // The control: the same words from the operator are offered both.
  const c = await setup();
  await c.turn(`${ASK}, and remind me to call the plumber at 3`);
  assert.ok(c.h.log[0].tools.includes(HANDOFF_TOOL_NAME), "control: the hand-off is offered");
  assert.ok(c.h.log[0].tools.includes(REMINDER), "control: an own tool is offered");
  assert.equal(c.counts.ownTools, 1);

  const s = await setup([call({ task: TASK, bot: "writer" }), says("Sorry. ")]);
  const r = await s.turn(`${ASK}, and remind me to call the plumber at 3`, RELAY);
  assert.equal(r.timings.relay, true);
  assert.ok(!s.h.log[0].tools.includes(HANDOFF_TOOL_NAME));
  assert.ok(!s.h.log[0].tools.some((t) => t.startsWith("crow_reminder") || t.startsWith("crow_calendar") || t.startsWith("crow_task")), s.h.log[0].tools.join(","));
  assert.deepEqual(r.timings.tools, ["crow_handoff:refused_policy"], "a forced crow_handoff is denied and never runs");
  assert.equal(s.counts.ownTools, 0, "deps.ownTools is never asked");
  assert.equal(s.counts.handoffs, 0, "deps.handoffs.forTurn is never asked");
  assert.equal(s.pending.get(DEVICE.id), null, "nothing was proposed");
  assert.equal((await s.db.execute("SELECT COUNT(*) AS n FROM voice_handoffs")).rows[0].n, 0);
  // opts.ownTools (tests, overrides) is not loaded on a relay turn either.
  const o = await setup();
  await o.turn("remind me to call the plumber at 3", { ...RELAY, ownTools: [{ definition: { name: "crow_reminder_add", description: "x", inputSchema: { type: "object" } }, family: "own:reminders", execute: async () => "{}" }] });
  assert.ok(!o.h.log[0].tools.includes(REMINDER));
});

test("a pending hand-off and a relayed \"yes\" leave no card and the row expired", async () => {
  // The control: the operator's own yes starts the hand-off (so the card check below can see a card).
  const c = await setup();
  const cid = await c.propose();
  const cr = await c.turn("yes");
  assert.equal(cr.timings.verb, "handoff_started");
  assert.equal((await c.cards()).length, 1);
  assert.equal((await c.row(cid)).status, "started");

  const s = await setup([says("Okay. ")]);
  const id = await s.propose();
  const r = await s.turn("yes", RELAY);
  assert.equal(r.fastPath, false, "no fast path answered it");
  assert.equal(s.h.log.length, 1, "the model answered the words as words");
  assert.deepEqual(s.h.calls.spoken, ["Okay."]);
  assert.deepEqual(await s.cards(), [], "no card");
  assert.deepEqual(s.eng.calls.spawn, [], "no bot started");
  assert.equal((await s.row(id)).status, "expired");
  assert.equal(s.pending.get(DEVICE.id), null);
  assert.equal(s.counts.fastPath, 0);
  assert.equal(s.counts.turnContext, 0, "a pending proposal does not make the relay an action turn");
  assert.ok(!s.h.log[0].messages.some((m) => /\[Hand-off\]/.test(String(m.content))), "the pending proposal is never put in front of the model");
});

test("a pending own-tool routine confirm and a relayed \"yes\" write nothing and clear the entry", async () => {
  // The control: the operator's own yes writes the reminder (so the schedules check below can see one).
  const c = await setup();
  c.holdReminder();
  const cr = await c.turn("yes");
  assert.equal(cr.timings.verb, "routine_yes");
  assert.equal((await c.schedules()).length, 1);

  const s = await setup([says("Okay. ")]);
  s.holdReminder();
  const before = (await s.schedules()).length;
  const r = await s.turn("yes", RELAY);
  assert.equal(r.fastPath, false);
  assert.equal((await s.schedules()).length, before, "nothing written");
  assert.deepEqual(s.h.calls.executed, [], "no tool ran");
  assert.equal(s.pending.get(DEVICE.id), null, "the entry is cleared");
  assert.ok(!s.h.log[0].messages.some((m) => /\[Pending\]/.test(String(m.content))));
  // A which-calendar question is cleared the same way.
  const w = await setup([says("Okay. ")]);
  w.pending.set(DEVICE.id, { kind: "which_calendar", tool: "crow_calendar_add_event", args: { title: "lunch" }, options: [{ id: "cal-1", name: "Home" }], say: "Which calendar?", lang: "en", tz: "America/Chicago" });
  await w.turn("Home", RELAY);
  assert.equal(w.pending.get(DEVICE.id), null);
  assert.deepEqual(w.h.calls.executed, []);
});

test("relay afterTurn clears pending entries even when no model turn ran", async () => {
  const fastPaths = (t) => (t === "pause" ? { say: "Paused.", verb: "pause" } : null);
  const s = await setup();
  const id = await s.propose();
  const r = await s.turn("pause", { ...RELAY, fastPaths });
  assert.equal(r.fastPath, true);
  assert.equal(r.timings.verb, "pause");
  assert.equal(r.timings.relay, true);
  assert.equal(s.h.log.length, 0, "no model call");
  assert.equal(s.pending.get(DEVICE.id), null, "the entry is gone");
  assert.equal((await s.row(id)).status, "expired", "and its row expired");
  assert.deepEqual(s.counts.afterTurn, [{ relay: true }, { relay: true }], "both hooks ran with relay: true");
  const o = await setup();
  o.holdReminder();
  await o.turn("pause", { ...RELAY, fastPaths });
  assert.equal(o.pending.get(DEVICE.id), null);
  // A relay turn that failed early (an empty transcript) still clears.
  const e = await setup();
  const eid = await e.propose();
  await e.turn("", RELAY);
  assert.equal(e.pending.get(DEVICE.id), null);
  assert.equal((await e.row(eid)).status, "expired");
});

test("the speak-the-answer call (bot text) triggers nothing, and no hand-off matcher reads it", async () => {
  const s = await setup([says("Okay. ")]);
  const id = await s.propose();
  const r = await s.turn(BOT_TEXT, RELAY);
  assert.equal(r.fastPath, false);
  assert.equal(r.timings.verb, undefined);
  assert.deepEqual(await s.cards(), []);
  assert.deepEqual(s.eng.calls.spawn, []);
  assert.equal((await s.row(id)).status, "expired");
  assert.equal(s.pending.get(DEVICE.id), null);
  // The matchers (wantsHandoff, wantsHandoffStatus, wantsHandoffStop) are read only inside the hand-off's fastPath and
  // forTurn: neither ran, and turn.js never imports them itself (3.5 carry).
  assert.equal(s.counts.fastPath, 0);
  assert.equal(s.counts.handoffs, 0);
  assert.equal(s.counts.turnContext, 0);
  const src = readFileSync(join(REPO, "servers/gateway/voice/turn.js"), "utf8");
  assert.ok(!/handoff-intent/.test(src) && !/\bwantsHandoff/.test(src), "turn.js reads no hand-off matcher");
  // A stop entry (PR 5's kind) is cleared too, and nothing is stopped.
  const t = await setup([says("Okay. ")]);
  t.pending.set(DEVICE.id, { kind: "stop", id: "h-x", name: "Writer" });
  await t.turn(BOT_TEXT, RELAY);
  assert.equal(t.pending.get(DEVICE.id), null);
});

test("a blank relayThreadId is no relay", async () => {
  for (const blank of ["", "   "]) {
    const s = await setup();
    const id = await s.propose();
    const r = await s.turn("yes", { relayThreadId: blank });
    assert.equal(isRelayTurn({ relayThreadId: blank }), false);
    assert.equal(r.timings.relay, undefined);
    assert.equal(r.timings.verb, "handoff_started", "the operator's yes still answers");
    assert.equal((await s.cards()).length, 1);
    assert.equal((await s.row(id)).status, "started");
    assert.deepEqual(s.counts.afterTurn, [{ relay: false }, { relay: false }]);
  }
});

test("R15: each afterTurn hook clears only its own kinds on a relay, and nothing outside one", async () => {
  const s = await setup();
  const dev = { device: DEVICE, calledTools: [] };
  // The hand-off hook alone: a hand-off (its row expired), a which, a stop; never a routine or which_calendar.
  const id = await s.propose();
  await s.handoff.afterTurn({ db: s.db, ...dev, relay: true });
  assert.equal(s.pending.get(DEVICE.id), null);
  assert.equal((await s.row(id)).status, "expired");
  for (const kind of ["which", "stop"]) {
    s.pending.set(DEVICE.id, { kind, task: TASK, options: [] });
    await s.handoff.afterTurn({ db: s.db, ...dev, calledTools: [HANDOFF_TOOL_NAME], relay: true });
    assert.equal(s.pending.get(DEVICE.id), null, `${kind}: cleared even when crow_handoff was called`);
  }
  s.holdReminder();
  await s.handoff.afterTurn({ db: s.db, ...dev, relay: true });
  assert.equal(s.pending.get(DEVICE.id).kind, "routine", "the hand-off hook leaves a routine entry");
  // The own-tools hook alone: a routine and a which_calendar; never a hand-off kind; nothing outside a relay.
  await s.own.afterTurn({ db: s.db, ...dev, relay: false });
  assert.equal(s.pending.get(DEVICE.id).kind, "routine", "a non-relay turn leaves it to its yes");
  await s.own.afterTurn({ db: s.db, ...dev, relay: true });
  assert.equal(s.pending.get(DEVICE.id), null);
  s.pending.set(DEVICE.id, { kind: "which_calendar", tool: "crow_calendar_add_event", args: {}, options: [], say: "Which?" });
  await s.own.afterTurn({ db: s.db, ...dev, relay: true });
  assert.equal(s.pending.get(DEVICE.id), null);
  const id2 = await s.propose();
  await s.own.afterTurn({ db: s.db, ...dev, relay: true });
  assert.equal(s.pending.get(DEVICE.id).id, id2, "the own-tools hook leaves a hand-off");
  assert.equal((await s.row(id2)).status, "proposed");
  s.pending.set(DEVICE.id, { kind: "stop", id: "h-x", name: "Writer" });
  await s.handoff.afterTurn({ db: s.db, ...dev, relay: false });
  assert.equal(s.pending.get(DEVICE.id).kind, "stop", "outside a relay the hand-off hook leaves a stop to PR 5");
});

// Fix round 1: the spoken-yes confirm gate (turn-helpers.js createConfirmGate). The default harness bot is an ordinary
// bot; crow_delete_post is destructive, so an operator's request is held for a yes.
const del = (id) => [{ type: "tool_call", id, name: "crow_delete_post", arguments: { id: 7 } }, { type: "done" }];
for (const relayText of ["yes", "Yes, the post is gone."]) {
  test(`a relay turn never answers a held confirm-gate question: ${relayText}`, async () => {
    const h = harness({ chatTools: ["crow_delete_post"], rounds: [del("a"), says("Are you sure? "), del("b"), says("Okay. "), del("c"), says("Are you sure? ")] });
    const r1 = await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "delete post 7", sink: h.sink });
    assert.deepEqual(r1.timings.tools, ["crow_delete_post:needs_confirm"], "the operator's request is held");
    const r2 = await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: relayText, sink: h.sink, relayThreadId: "thread-1" });
    assert.deepEqual(r2.timings.tools, ["crow_delete_post:refused_policy"], "refused before the gate");
    assert.ok(!h.calls.executed.includes("crow_delete_post"), "a relay turn ran a confirm-gated delete");
    // The relay ended the question: a later operator yes is asked again, never run on the old hold.
    const r3 = await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "yes", sink: h.sink });
    assert.deepEqual(r3.timings.tools, ["crow_delete_post:needs_confirm"]);
    assert.ok(!h.calls.executed.includes("crow_delete_post"));
  });
}

test("a relay turn never arms the confirm gate: a later operator yes does not run a call the relay asked for", async () => {
  const h = harness({ chatTools: ["crow_delete_post"], rounds: [del("a"), says("I can't. "), del("b"), says("Are you sure? ")] });
  const r1 = await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "delete post 7", sink: h.sink, relayThreadId: "thread-1" });
  assert.deepEqual(r1.timings.tools, ["crow_delete_post:refused_policy"]);
  const r2 = await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "yes", sink: h.sink });
  assert.deepEqual(r2.timings.tools, ["crow_delete_post:needs_confirm"], "nothing was armed for this yes to answer");
  assert.deepEqual(h.calls.executed, []);
});

// Fix round 1: relayKind "answer" (the speak-the-answer call: the transcript is the bot's own text).
const VOICE_LOGGED = { ...VOICE, voice: { transcript_log: true, transcript_buffer: true } };
function answerHarness(rounds = [says("Writer says it is done.")]) {
  const h = harness({ bot: VOICE_LOGGED, chatTools: ["crow_memory", "crow_projects", "crow_delete_post"], rounds });
  h.logged = [];
  h.buffered = [];
  h.deps.transcriptLog = { record: async (e) => { h.logged.push(e); }, clear: async () => {} };
  h.deps.transcripts = { record: (id, e) => { h.buffered.push(e); }, clear: () => {} };
  const wm = { definition: { name: "crow_wm", description: "display", inputSchema: { type: "object" } }, execute: async () => "{}" };
  h.turn = (transcript, opts = {}) => h.runner.runVoiceTurn({ db: {}, device: h.device, transcript, sink: h.sink, extraTools: [wm], memoryOn: true, ...opts });
  return h;
}
const ANSWER = { relayThreadId: "thread-1", relayKind: "answer" };

test("an answer relay: a bot answer \"Pause.\" never reaches the endpoint's pause fast path; an operator relay's does", async () => {
  let paused = 0;
  const fastPaths = (t) => (/^pause\.?$/i.test(t) ? (paused++, { say: "Paused.", verb: "pause" }) : null);
  const a = answerHarness();
  const r = await a.turn("Pause.", { ...ANSWER, fastPaths });
  assert.equal(paused, 0);
  assert.equal(r.fastPath, false);
  assert.equal(r.timings.relay, true);
  const o = answerHarness();
  const ro = await o.turn("Pause.", { ...RELAY, fastPaths });
  assert.equal(paused, 1, "an operator relay keeps the endpoint's own paths");
  assert.equal(ro.timings.verb, "pause");
});

test("an answer relay sends its model round with no tools at all, and a forced call never runs", async () => {
  const a = answerHarness([[{ type: "tool_call", id: "x", name: "crow_projects", arguments: {} }, { type: "done" }], says("Done.")]);
  const r = await a.turn("remember this and show me my projects", ANSWER);
  assert.deepEqual(a.log[0].tools, [], "no tools, the display's extra tool included");
  assert.ok(a.log.every((round) => round.tools.length === 0), "no later round has tools either");
  assert.equal(r.timings.tools_offered, 0);
  assert.deepEqual(a.calls.executed, []);
  // The control: the operator relay of the same words is offered the bot's tools.
  const o = answerHarness([says("Okay.")]);
  await o.turn("remember this and show me my projects", RELAY);
  assert.ok(o.log[0].tools.length > 0);
});

test("an answer relay is never recorded in the transcript log or buffer; an operator relay is", async () => {
  const a = answerHarness();
  await a.turn("Writer finished the radio history report.", ANSWER);
  assert.deepEqual(a.logged, []);
  assert.deepEqual(a.buffered, []);
  const o = answerHarness();
  await o.turn("what did writer find", RELAY);
  assert.equal(o.logged.length, 1);
  assert.equal(o.buffered.length, 1);
});

test("an answer relay is never saved into the voice conversation; an operator relay is", async () => {
  const BOT_WORDS = "Writer finished the radio history report.";
  const a = answerHarness([says("Writer finished it."), says("Sure.")]);
  await a.turn(BOT_WORDS, ANSWER);
  await a.turn("thanks");
  assert.ok(!a.log[1].messages.some((m) => String(m.content).includes(BOT_WORDS)), "the next turn's history never carries the bot text");
  // The same holds for an answer turn that fails (the fallback path saves too).
  const f = answerHarness([says("")]);
  await f.turn(BOT_WORDS, ANSWER);
  assert.equal(f.calls.spoken.length > 0, true, "the fallback was spoken");
  await f.turn("thanks");
  assert.ok(!f.log[f.log.length - 1].messages.some((m) => String(m.content).includes(BOT_WORDS)));
  const o = answerHarness([says("Okay."), says("Sure.")]);
  await o.turn("what did writer find", RELAY);
  await o.turn("thanks");
  assert.ok(o.log[1].messages.some((m) => m.role === "user" && m.content === "what did writer find"), "an operator relay is history");
});

// Fix round 2.
const { wantsAction, wantsActionFollowUp } = await import("../bundles/kiosk/server/action-intent.js");
const { relayKindOf } = await import("../servers/gateway/voice/turn.js");
const { createToolFamilies } = await import("../servers/gateway/voice/tool-families.js");
const FAM = () => createToolFamilies({ manifests: { projects: { tools: {}, voiceIntent: { en: ["project", "projects"], es: ["proyecto"] } }, blog: { tools: {} }, memory: { tools: {} } } });
const CANT = "CANT_DO";
const projCall = [{ type: "tool_call", id: "p", name: "crow_projects", arguments: { action: "list_projects" } }, { type: "done" }];

test("relayKindOf: only an absent or \"operator\" kind is the operator; any unknown kind is the answer", () => {
  assert.equal(relayKindOf({ relayThreadId: "t" }), "operator");
  assert.equal(relayKindOf({ relayThreadId: "t", relayKind: "operator" }), "operator");
  assert.equal(relayKindOf({ relayThreadId: "t", relayKind: "answer" }), "answer");
  for (const k of ["answr", "", "OPERATOR", 7, false]) assert.equal(relayKindOf({ relayThreadId: "t", relayKind: k }), "answer", String(k));
  assert.equal(relayKindOf({ relayKind: "operator" }), null, "no relay, no kind");
});

test("an unknown relayKind runs as an answer turn: no endpoint fast path, no tools", async () => {
  let ran = 0;
  const a = answerHarness([says("Paused it.")]);
  await a.turn("Pause.", { relayThreadId: "t", relayKind: "answr", fastPaths: () => (ran++, { say: "Paused.", verb: "pause" }) });
  assert.equal(ran, 0);
  assert.deepEqual(a.log[0].tools, []);
});

for (const text of ["Writer sent the email to your landlord and set a reminder for 3.", "Writer added the meeting to your calendar."]) {
  test(`an answer relay of action-sounding bot text speaks the model's short version, never a can't-do: ${text}`, async () => {
    assert.equal(wantsAction(text), true, "the kiosk reads these words as an action request");
    for (const bot of [undefined, VOICE]) {
      const h = harness({ ...(bot ? { bot } : {}), chatTools: ["crow_projects"], rounds: [says("Writer did it.")] });
      h.deps.toolFamilies = FAM();
      const r = await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: text, sink: h.sink, ...ANSWER, actionWhen: wantsAction, actionFollowWhen: wantsActionFollowUp, familiesOnIntent: true, cantDoText: CANT, notReadyText: "NOT_READY" });
      assert.equal(h.log.length, 1, "the model was asked");
      assert.deepEqual(h.calls.spoken, ["Writer did it."]);
      for (const k of ["action_intent", "action_no_tool", "action_not_ready", "action_no_backend", "claim_blocked"]) assert.equal(r.timings[k], undefined, k);
    }
    // The control: the operator relay of the same words is an action request.
    const o = harness({ chatTools: [], rounds: [says("Writer did it.")] });
    const ro = await o.runner.runVoiceTurn({ db: {}, device: o.device, transcript: text, sink: o.sink, ...RELAY, actionWhen: wantsAction, actionFollowWhen: wantsActionFollowUp, familiesOnIntent: true, cantDoText: CANT });
    assert.equal(ro.timings.action_intent, true);
  });
}

test("an answer relay never changes the operator's follow-up state (last families, last action)", async () => {
  // Families: the operator's projects follow-up survives a bot answer in between.
  const h = harness({ chatTools: ["crow_projects"], rounds: [projCall, says("You have two. "), says("Writer found two. "), says("The second is Garden. ")] });
  h.deps.toolFamilies = FAM();
  const fam = (t, o = {}) => h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: t, sink: h.sink, familiesOnIntent: true, ...o });
  await fam("List my projects.");
  await fam("Writer found two.", ANSWER);
  await fam("And the second one?");
  assert.deepEqual(h.log.at(-1).tools, ["crow_projects"], "the operator's follow-up is still a follow-up");
  // Last action: the operator's action request still guards the follow-up after a bot answer in between.
  const a = harness({ chatTools: [], rounds: [says("Writer is on it. "), says("Done, I've moved it to 9. ")] });
  a.deps.toolFamilies = FAM();
  const act = (t, o = {}) => a.runner.runVoiceTurn({ db: {}, device: a.device, transcript: t, sink: a.sink, familiesOnIntent: true, actionWhen: wantsAction, actionFollowWhen: wantsActionFollowUp, cantDoText: CANT, ...o });
  const r1 = await act("Add a car appointment for 815am Monday to my calendar");
  assert.equal(r1.timings.action_no_tool, true);
  await act("Writer is on it.", ANSWER);
  const r3 = await act("Move it to 9 instead.");
  assert.equal(r3.timings.claim_blocked, true, "the follow-up is still an action turn: the unbacked claim is replaced");
  assert.equal(a.calls.spoken.at(-1), CANT);
});

test("a relay of either kind runs known reads only: crow_create_post is refused_policy, a read runs", async () => {
  const post = [{ type: "tool_call", id: "w", name: "crow_create_post", arguments: { title: "x" } }, { type: "done" }];
  const h = harness({ chatTools: ["crow_create_post", "crow_projects"], rounds: [post, says("I can't from here. "), projCall, says("You have two. ")] });
  const r1 = await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "write a blog post titled x", sink: h.sink, ...RELAY });
  assert.deepEqual(r1.timings.tools, ["crow_create_post:refused_policy"]);
  const r2 = await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "list my projects", sink: h.sink, ...RELAY });
  assert.deepEqual(r2.timings.tools, ["crow_projects:ok"]);
  assert.deepEqual(h.calls.executed, ["crow_projects"], "only the read ran");
  // The control: the operator's own turn runs the write.
  const c = harness({ chatTools: ["crow_create_post"], rounds: [post, says("Done. ")] });
  await c.runner.runVoiceTurn({ db: {}, device: c.device, transcript: "write a blog post titled x", sink: c.sink });
  assert.deepEqual(c.calls.executed, ["crow_create_post"]);
});
