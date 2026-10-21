/**
 * Crow's own tools (PR 2, Task 2.5): a calendar event, a reminder and a task, each written to whichever
 * system is installed (Workspace, Google, Crow's own schedules, the board). Fake executor, scratch DBs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "../scripts/migrations/runner.mjs";
import { createDbClient } from "../servers/db.js";
import { createOwnTools, VOICE_OWN_TOOL_NAMES } from "../servers/gateway/voice/own-tools.js";
import { createPendingStore, chainVoiceActions } from "../servers/gateway/voice/pending.js";
import { VOICE_LINES, voiceLine } from "../servers/gateway/voice/voice-lines.js";
import { NOT_DONE_TEXT, CANT_DO_TEXT, PARTLY_DONE_TEXT } from "../servers/gateway/voice/turn.js";
import { createToolFamilies, normalizeIntentLists, listMatches, phraseWords } from "../servers/gateway/voice/tool-families.js";
import { harness } from "./fixtures/voice-turn-harness.mjs";

const MIGRATIONS = join(import.meta.dirname, "..", "scripts", "migrations");
const TZ = "America/Chicago";
const NOW = Date.parse("2026-10-20T15:00:00Z");
const DEVICE = { id: "kiosk-a" };
const CROW = (over = {}) => ({ bot_id: "crow.voice", kind: "voice", display_name: "Crow", fast_voice_model: "crow-voice/qwen3.5-4b", ...over });
const whenOf = (iso, lang = "en-US", tz = TZ) => new Intl.DateTimeFormat(lang, { weekday: "long", hour: "numeric", minute: "2-digit", timeZone: tz }).format(new Date(iso));

/** A scratch crow.db (schedules) and tasks.db (the real migrations), and a cleanup. */
async function stores() {
  const root = mkdtempSync(join(tmpdir(), "own-tools-"));
  const dbPath = join(root, "crow.db");
  const tasksFile = join(root, "tasks.db");
  const c = new Database(dbPath);
  c.exec("CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, sha TEXT)");
  for (const id of ["0001-board-stages", "0002-board-defs", "0003-tracker-convergence"]) c.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, datetime('now'))").run(id);
  c.exec(`CREATE TABLE schedules (id INTEGER PRIMARY KEY AUTOINCREMENT, task TEXT NOT NULL, cron_expression TEXT NOT NULL, description TEXT,
    enabled INTEGER NOT NULL DEFAULT 1, last_run TEXT, next_run TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))`);
  c.close();
  const t = new Database(tasksFile);
  t.exec(`CREATE TABLE tasks_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT,
    status TEXT NOT NULL DEFAULT 'pending', priority INTEGER DEFAULT 3,
    due_date TEXT, phase TEXT, owner TEXT, tags TEXT, parent_id INTEGER,
    project_id INTEGER, assigned_bot TEXT, plan_ref TEXT, stage TEXT,
    board_id INTEGER, bot_id TEXT, action_needed TEXT, next_followup_date TEXT,
    processing_lease TEXT, processing_lease_status TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT, data_json TEXT NOT NULL DEFAULT '{}');
  CREATE TABLE board_defs (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE,
    project_id INTEGER UNIQUE, display_name TEXT NOT NULL, status_values TEXT NOT NULL,
    terminal_values TEXT NOT NULL, fields_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  t.close();
  await runMigrations({ migrationsDir: MIGRATIONS, dbPath, tasksDbPath: tasksFile, sha: "test", log: () => {} });
  const db = createDbClient(dbPath);
  return {
    db,
    openTasksDb: () => createDbClient(tasksFile),
    schedules: async () => (await db.execute("SELECT task, cron_expression, description, next_run, enabled FROM schedules ORDER BY id")).rows,
    cards: () => { const x = new Database(tasksFile, { readonly: true }); try { return x.prepare("SELECT id, title, tags, autonomy, due_date FROM tasks_items ORDER BY id").all(); } finally { x.close(); } },
    mutations: () => { const x = new Database(tasksFile, { readonly: true }); try { return x.prepare("SELECT item_id, verb, actor_kind, actor_id FROM board_mutations ORDER BY id").all(); } finally { x.close(); } },
    close: () => { try { db.close(); } catch {} rmSync(root, { recursive: true, force: true }); },
  };
}

/** A fake executor: answers the Workspace and Google tools the way their MCP servers do (JSON text). */
function fakeExecutor({ calendars = [{ id: "cal-1", name: "Home", writable: true }], lists = [{ id: "list-1", name: "Chores", writable: true }], fail = null } = {}) {
  const calls = [];
  const answer = (tc) => {
    if (fail && fail === tc.name) return { result: JSON.stringify({ success: false, code: "server_error", error: "down" }), isError: true };
    if (tc.name === "ws_cal_list_calendars") return { result: JSON.stringify({ success: true, data: { calendars } }), isError: false };
    if (tc.name === "ws_tasks_list_lists") return { result: JSON.stringify({ success: true, data: { lists } }), isError: false };
    if (tc.name === "ws_cal_create_event") return { result: JSON.stringify({ success: true, data: { uid: "u1", ref: "cal-1/u1", calendar: "Home", version_id: 1 } }), isError: false };
    if (tc.name === "ws_task_create") return { result: JSON.stringify({ success: true, data: { uid: "t1", ref: "list-1/t1", list: "Chores", version_id: 2 } }), isError: false };
    if (tc.name === "gcal_create_event") return { result: JSON.stringify({ id: "g1", htmlLink: "x" }), isError: false };
    return { result: `Unknown tool: ${tc.name}`, isError: true };
  };
  return { calls, executeToolCalls: async (tcs) => tcs.map((tc) => { calls.push({ name: tc.name, arguments: tc.arguments }); return { id: tc.id, name: tc.name, ...answer(tc) }; }) };
}

function make({ connected = [], now = () => NOW, openTasksDb, pending = createPendingStore({ now }) } = {}) {
  const logs = [];
  const own = createOwnTools({ pending, now, log: (m) => logs.push(m), connected: () => new Set(connected), openTasksDb });
  return { own, pending, logs };
}
const toolOf = (set, name) => set.tools.find((t) => t.definition.name === name);
const run = async (tool, args, ctx) => JSON.parse(await tool.execute(args, ctx));

test("auto picks workspace, then google, then none for the calendar", async () => {
  const { own } = make();
  const s = { routine: {} };
  assert.equal(own.resolveBackends(s, new Set(["ws_cal_create_event"])).calendar, "workspace");
  assert.equal(own.resolveBackends(s, new Set(["gcal_create_event"])).calendar, "google");
  assert.equal(own.resolveBackends(s, new Set(["ws_cal_create_event", "gcal_create_event"])).calendar, "workspace");
  assert.equal(own.resolveBackends(s, new Set()).calendar, null);
  assert.deepEqual(own.resolveBackends(s, new Set()), { calendar: null, reminders: "crow", tasks: "board" });
  assert.equal(own.resolveBackends(s, new Set(["ws_task_create"])).tasks, "workspace");
  // An explicit backend that is not connected resolves to null; "off" is null.
  assert.equal(own.resolveBackends({ routine: { calendar: { backend: "google" } } }, new Set(["ws_cal_create_event"])).calendar, null);
  assert.equal(own.resolveBackends({ routine: { tasks: { backend: "workspace" } } }, new Set()).tasks, null);
  assert.equal(own.resolveBackends({ routine: { reminders: { backend: "off" } } }, new Set()).reminders, null);
  const set = await own.forTurn({ db: {}, bot: CROW(), surface: "kiosk", lang: "en", tz: TZ });
  assert.equal(toolOf(set, "crow_calendar_add_event"), undefined);
  assert.ok(toolOf(set, "crow_reminder_add") && toolOf(set, "crow_task_add"));
});

test("no backend is reported as unavailable", async () => {
  const { own } = make();
  const set = await own.forTurn({ db: {}, bot: CROW({ routine: { reminders: { backend: "off" } } }), surface: "kiosk", lang: "en", tz: TZ });
  assert.deepEqual(set.unavailable.sort(), ["calendar", "reminders"]);
  const full = await make({ connected: ["ws_cal_create_event"] }).own.forTurn({ db: {}, bot: CROW(), surface: "kiosk", lang: "en", tz: TZ });
  assert.deepEqual(full.unavailable, []);
  for (const t of full.tools) {
    assert.ok(VOICE_OWN_TOOL_NAMES.includes(t.definition.name));
    assert.match(t.family, /^own:(calendar|reminders|tasks)$/);
    assert.ok(t.intent.en.length && t.intent.es.length);
  }
});

test("calendar add calls ws_cal_create_event with the resolved calendar", async () => {
  const { own } = make({ connected: ["ws_cal_create_event", "ws_cal_list_calendars"] });
  const ex = fakeExecutor({ calendars: [{ id: "ro", name: "Shared", writable: false }, { id: "cal-1", name: "Home", writable: true }] });
  const set = await own.forTurn({ db: {}, bot: CROW(), surface: "kiosk", lang: "en", tz: TZ });
  const r = await run(toolOf(set, "crow_calendar_add_event"), { title: "Lunch", start: "2026-10-26T12:00:00-05:00" }, { executor: ex, db: {}, device: DEVICE });
  const create = ex.calls.find((c) => c.name === "ws_cal_create_event");
  assert.deepEqual(create, { name: "ws_cal_create_event", arguments: { calendar: "cal-1", summary: "Lunch", start: "2026-10-26T12:00:00-05:00", end: "2026-10-26T13:00:00-05:00" } });
  assert.equal(r.ok, true);
  assert.equal(r.code, "added");
  assert.equal(r.final, true);
  assert.equal(r.say, `Added Lunch to your calendar for ${whenOf("2026-10-26T12:00:00-05:00")}.`);
  // The resolved calendar is cached: a second add lists nothing.
  await run(toolOf(set, "crow_calendar_add_event"), { title: "Dinner", start: "2026-10-26T19:00:00-05:00" }, { executor: ex, db: {}, device: DEVICE });
  assert.equal(ex.calls.filter((c) => c.name === "ws_cal_list_calendars").length, 1);
});

test("a configured calendar is used as is; Google gets calendar_id", async () => {
  const ws = make({ connected: ["ws_cal_create_event"] }).own;
  const ex = fakeExecutor();
  const set = await ws.forTurn({ db: {}, bot: CROW({ routine: { calendar: { calendar: "family" } } }), surface: "kiosk", lang: "en", tz: TZ });
  await run(toolOf(set, "crow_calendar_add_event"), { title: "Lunch", start: "2026-10-26T12:00:00-05:00", end: "2026-10-26T12:30:00-05:00" }, { executor: ex, db: {}, device: DEVICE });
  assert.deepEqual(ex.calls.map((c) => c.name), ["ws_cal_create_event"]);
  assert.equal(ex.calls[0].arguments.calendar, "family");
  assert.equal(ex.calls[0].arguments.end, "2026-10-26T12:30:00-05:00");
  const g = make({ connected: ["gcal_create_event"] }).own;
  const gx = fakeExecutor();
  const gset = await g.forTurn({ db: {}, bot: CROW(), surface: "kiosk", lang: "en", tz: TZ });
  const r = await run(toolOf(gset, "crow_calendar_add_event"), { title: "Lunch", start: "2026-10-26T12:00:00-05:00" }, { executor: gx, db: {}, device: DEVICE });
  assert.deepEqual(gx.calls, [{ name: "gcal_create_event", arguments: { summary: "Lunch", start: "2026-10-26T12:00:00-05:00", end: "2026-10-26T13:00:00-05:00", calendar_id: "primary" } }]);
  assert.equal(r.code, "added");
});

test("a time without an offset is bad_args and nothing is written", async () => {
  const s = await stores();
  try {
    const { own } = make({ connected: ["ws_cal_create_event"] });
    const ex = fakeExecutor();
    const set = await own.forTurn({ db: s.db, bot: CROW(), surface: "kiosk", lang: "en", tz: TZ });
    const c = await run(toolOf(set, "crow_calendar_add_event"), { title: "Lunch", start: "2026-10-26T12:00:00" }, { executor: ex, db: s.db, device: DEVICE });
    assert.equal(c.ok, false);
    assert.equal(c.code, "bad_args");
    assert.ok(typeof c.message === "string" && c.message.length > 10, "the model is told why");
    assert.equal(c.say, undefined);
    const r = await run(toolOf(set, "crow_reminder_add"), { text: "call the dentist", at: "2026-10-26T12:00" }, { executor: ex, db: s.db, device: DEVICE });
    assert.equal(r.code, "bad_args");
    for (const bad of [{ title: "", start: "2026-10-26T12:00:00-05:00" }, { title: "x", start: "next monday" }, { title: "x", start: "2026-02-30T12:00:00-05:00" }, { title: "x".repeat(201), start: "2026-10-26T12:00:00-05:00" }, { title: "x", start: "2026-10-26T12:00:00-05:00", end: "2026-10-26T11:00:00-05:00" }]) {
      assert.equal((await run(toolOf(set, "crow_calendar_add_event"), bad, { executor: ex, db: s.db, device: DEVICE })).code, "bad_args", JSON.stringify(bad));
    }
    assert.deepEqual(ex.calls, []);
    assert.deepEqual(await s.schedules(), []);
  } finally { s.close(); }
});

test("without a time zone, date-times are no_tz (never guessed, never a step-up)", async () => {
  const s = await stores();
  try {
    const { own } = make({ connected: ["ws_cal_create_event"] });
    const ex = fakeExecutor();
    for (const tz of [undefined, null, "", "Not/AZone"]) {
      const set = await own.forTurn({ db: s.db, bot: CROW(), surface: "kiosk", lang: "en", tz });
      const rem = await run(toolOf(set, "crow_reminder_add"), { text: "call", at: "2026-10-26T12:00:00-05:00" }, { executor: ex, db: s.db, device: DEVICE });
      assert.equal(rem.code, "no_tz");
      assert.equal(rem.ok, false);
      assert.ok(rem.message && !rem.say, "a message for the model, no spoken line");
      assert.equal((await run(toolOf(set, "crow_calendar_add_event"), { title: "Lunch", start: "2026-10-26T12:00:00-05:00" }, { executor: ex, db: s.db, device: DEVICE })).code, "no_tz");
      // A malformed date-time is still bad_args (a larger model can fix that).
      assert.equal((await run(toolOf(set, "crow_reminder_add"), { text: "call", at: "noon" }, { executor: ex, db: s.db, device: DEVICE })).code, "bad_args");
    }
    assert.deepEqual(ex.calls, []);
    assert.deepEqual(await s.schedules(), []);
  } finally { s.close(); }
});

test("reminder writes one one-shot schedule", async () => {
  const s = await stores();
  try {
    const { own } = make();
    const set = await own.forTurn({ db: s.db, bot: CROW(), surface: "kiosk", lang: "en", tz: TZ });
    const at = "2026-10-26T09:30:00-05:00";
    const r = await run(toolOf(set, "crow_reminder_add"), { text: "call the dentist", at }, { executor: null, db: s.db, device: DEVICE });
    assert.equal(r.ok, true);
    assert.equal(r.code, "added");
    assert.equal(r.say, `Okay, I'll remind you ${whenOf(at)}: call the dentist.`);
    const rows = await s.schedules();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].task, "reminder:call the dentist");
    assert.equal(rows[0].cron_expression, "@once");
    assert.equal(rows[0].description, "Set by Crow's voice");
    assert.equal(rows[0].next_run, new Date(at).toISOString());
    assert.equal(rows[0].next_run, "2026-10-26T14:30:00.000Z");
    assert.equal(Number(rows[0].enabled), 1);
  } finally { s.close(); }
});

test("a reminder in the past is bad_args", async () => {
  const s = await stores();
  try {
    const { own } = make();
    const set = await own.forTurn({ db: s.db, bot: CROW(), surface: "kiosk", lang: "en", tz: TZ });
    const r = await run(toolOf(set, "crow_reminder_add"), { text: "call", at: "2026-10-20T09:00:00-05:00" }, { executor: null, db: s.db, device: DEVICE });
    assert.equal(r.code, "bad_args");
    assert.deepEqual(await s.schedules(), []);
  } finally { s.close(); }
});

test("an all-day event ends the same day", async () => {
  const { own } = make({ connected: ["ws_cal_create_event"] });
  const ex = fakeExecutor();
  const set = await own.forTurn({ db: {}, bot: CROW({ routine: { calendar: { calendar: "cal-1" } } }), surface: "kiosk", lang: "en", tz: TZ });
  const r = await run(toolOf(set, "crow_calendar_add_event"), { title: "Holiday", start: "2026-12-25", all_day: true }, { executor: ex, db: {}, device: DEVICE });
  assert.deepEqual(ex.calls[0].arguments, { calendar: "cal-1", summary: "Holiday", start: "2026-12-25", end: "2026-12-25" });
  assert.equal(r.code, "added");
  assert.match(r.say, /^Added Holiday to your calendar for Friday, December 25\.$/);
  // Google's all-day end is exclusive: the next day.
  const g = make({ connected: ["gcal_create_event"] }).own;
  const gx = fakeExecutor();
  const gset = await g.forTurn({ db: {}, bot: CROW(), surface: "kiosk", lang: "en", tz: TZ });
  await run(toolOf(gset, "crow_calendar_add_event"), { title: "Holiday", start: "2026-12-31" }, { executor: gx, db: {}, device: DEVICE });
  assert.equal(gx.calls[0].arguments.end, "2027-01-01");
});

test("tasks fall back to a board card tagged crow-voice, gated", async () => {
  const s = await stores();
  try {
    const { own } = make({ openTasksDb: s.openTasksDb });
    const set = await own.forTurn({ db: s.db, bot: CROW(), surface: "kiosk", lang: "en", tz: TZ });
    const r = await run(toolOf(set, "crow_task_add"), { title: "Fix the gate", due: "2026-10-30" }, { executor: fakeExecutor(), db: s.db, device: DEVICE });
    assert.equal(r.ok, true);
    assert.equal(r.say, "Added Fix the gate to your tasks.");
    const cards = s.cards();
    assert.equal(cards.length, 1);
    assert.equal(cards[0].title, "Fix the gate");
    assert.equal(cards[0].tags, "crow-voice");
    assert.equal(cards[0].autonomy, "gated");
    assert.equal(cards[0].due_date, "2026-10-30");
    assert.deepEqual(s.mutations().map((m) => [m.verb, m.actor_kind, m.actor_id]), [["create", "human", "crow.voice"]]);
    assert.equal((await run(toolOf(set, "crow_task_add"), { title: "x", due: "Friday" }, { executor: null, db: s.db, device: DEVICE })).code, "bad_args");
    assert.equal(s.cards().length, 1);
  } finally { s.close(); }
});

test("tasks go to Workspace when it is connected and a list resolves; auto falls back to the board when none does", async () => {
  const s = await stores();
  try {
    const { own } = make({ connected: ["ws_task_create", "ws_tasks_list_lists"], openTasksDb: s.openTasksDb });
    const ex = fakeExecutor({ lists: [{ id: "ro", name: "Theirs", writable: false }, { id: "list-1", name: "Chores", writable: true }] });
    const set = await own.forTurn({ db: s.db, bot: CROW(), surface: "kiosk", lang: "en", tz: TZ });
    const r = await run(toolOf(set, "crow_task_add"), { title: "Buy milk", due: "2026-10-21" }, { executor: ex, db: s.db, device: DEVICE });
    assert.equal(r.code, "added");
    assert.deepEqual(ex.calls.find((c) => c.name === "ws_task_create"), { name: "ws_task_create", arguments: { list: "list-1", summary: "Buy milk", due: "2026-10-21" } });
    assert.equal(s.cards().length, 0);
    const none = make({ connected: ["ws_task_create"], openTasksDb: s.openTasksDb }).own;
    const nx = fakeExecutor({ lists: [{ id: "ro", name: "Theirs", writable: false }] });
    const nset = await none.forTurn({ db: s.db, bot: CROW(), surface: "kiosk", lang: "en", tz: TZ });
    assert.equal((await run(toolOf(nset, "crow_task_add"), { title: "Buy eggs" }, { executor: nx, db: s.db, device: DEVICE })).code, "added");
    assert.deepEqual(nx.calls.map((c) => c.name), ["ws_tasks_list_lists"]);
    assert.equal(s.cards().length, 1, "the board took it");
  } finally { s.close(); }
});

test("a backend error is backend_error with no say, and nothing is claimed", async () => {
  const s = await stores();
  try {
    const { own } = make({ connected: ["ws_cal_create_event"] });
    const set = await own.forTurn({ db: s.db, bot: CROW({ routine: { calendar: { calendar: "cal-1" } } }), surface: "kiosk", lang: "en", tz: TZ });
    const r = await run(toolOf(set, "crow_calendar_add_event"), { title: "Lunch", start: "2026-10-26T12:00:00-05:00" }, { executor: fakeExecutor({ fail: "ws_cal_create_event" }), db: s.db, device: DEVICE });
    assert.deepEqual(r, { ok: false, code: "backend_error" });
    const broken = { execute: async () => { throw new Error("SQLITE_BUSY"); } };
    const rr = await run(toolOf(set, "crow_reminder_add"), { text: "call", at: "2026-10-26T12:00:00-05:00" }, { executor: null, db: broken, device: DEVICE });
    assert.deepEqual(rr, { ok: false, code: "backend_error" });
  } finally { s.close(); }
});

test("a backend error speaks no success in the turn (the action guard's line)", async () => {
  const s = await stores();
  try {
    const { own, pending } = make();
    const h = harness({ bot: CROW(), chatTools: [], rounds: [
      [{ type: "tool_call", id: "c1", name: "crow_reminder_add", arguments: { text: "call", at: "2026-10-26T12:00:00-05:00" } }, { type: "done" }],
      [{ type: "content_delta", text: "Done, I'll remind you Monday. " }, { type: "done" }],
    ] });
    h.deps.ownTools = own.forTurn;
    h.deps.voiceActions = chainVoiceActions([own]);
    const broken = { execute: async () => { throw new Error("disk full"); } };
    await h.runner.runVoiceTurn({ db: broken, device: h.device, transcript: "remind me Monday at noon to call", sink: h.sink, tz: TZ, lang: "en", actionWhen: () => true });
    assert.ok(!h.calls.spoken.some((x) => /remind you/i.test(x)), JSON.stringify(h.calls.spoken));
    assert.ok(h.calls.spoken.includes(NOT_DONE_TEXT), JSON.stringify(h.calls.spoken));
    assert.equal(pending.get(h.device.id), null);
  } finally { s.close(); }
});

test("strict asks first, and yes writes exactly once", async () => {
  const s = await stores();
  try {
    const { own, pending } = make({ openTasksDb: s.openTasksDb });
    const bot = CROW({ voice: { confirm: "strict" } });
    const set = await own.forTurn({ db: s.db, bot, surface: "kiosk", lang: "en", tz: TZ });
    const r = await run(toolOf(set, "crow_task_add"), { title: "Fix the gate" }, { executor: null, db: s.db, device: DEVICE });
    assert.equal(r.ok, true);
    assert.equal(r.effect, false);
    assert.equal(r.code, "needs_confirm");
    assert.equal(r.final, true);
    assert.equal(r.say, "Add Fix the gate to your tasks?");
    assert.equal(s.cards().length, 0, "nothing written before the yes");
    assert.equal(pending.get(DEVICE.id).kind, "routine");
    assert.deepEqual(own.turnContext({ device: DEVICE }), { text: "[Pending] Add Fix the gate to your tasks?", pending: true });
    const base = { db: s.db, device: DEVICE, surface: "kiosk", lang: "en", tz: TZ, bot, executor: null };
    const yes = await own.fastPath({ ...base, transcript: "yes" });
    assert.equal(yes.say, voiceLine("task_added", "en", { title: "Fix the gate" }));
    assert.equal(s.cards().length, 1);
    assert.equal(await own.fastPath({ ...base, transcript: "yes" }), null, "nothing pending any more");
    assert.equal(s.cards().length, 1, "written exactly once");
    assert.equal(own.turnContext({ device: DEVICE }), null);
    // Strict reminders and calendar events ask too.
    const rem = await run(toolOf(set, "crow_reminder_add"), { text: "call", at: "2026-10-26T12:00:00-05:00" }, { executor: null, db: s.db, device: DEVICE });
    assert.equal(rem.code, "needs_confirm");
    assert.equal(rem.say, `Remind you ${whenOf("2026-10-26T12:00:00-05:00")}: call?`);
    assert.deepEqual(await s.schedules(), []);
  } finally { s.close(); }
});

test("standard confirm adds directly", async () => {
  const s = await stores();
  try {
    const { own, pending } = make({ openTasksDb: s.openTasksDb });
    const set = await own.forTurn({ db: s.db, bot: CROW({ voice: { confirm: "standard" } }), surface: "kiosk", lang: "en", tz: TZ });
    assert.equal((await run(toolOf(set, "crow_task_add"), { title: "Fix" }, { executor: null, db: s.db, device: DEVICE })).code, "added");
    assert.equal(pending.get(DEVICE.id), null);
  } finally { s.close(); }
});

test("fallback-offer mode writes nothing; a yes writes exactly one reminder", async () => {
  const s = await stores();
  try {
    const { own } = make();
    const set = await own.forTurn({ db: s.db, bot: CROW(), surface: "kiosk", lang: "en", tz: TZ });
    const at = "2026-10-26T12:00:00-05:00";
    const r = await run(toolOf(set, "crow_reminder_add"), { text: "lunch with the team", at }, { executor: null, db: s.db, device: DEVICE, fallback: "calendar" });
    assert.deepEqual(r, { ok: true, effect: false, code: "needs_confirm", final: true, say: voiceLine("calendar_fallback_offer", "en", { when: whenOf(at), text: "lunch with the team" }) });
    assert.match(r.say, /^I can't add that to a calendar here, but I can remind you .+: lunch with the team\. Okay\?$/);
    assert.deepEqual(await s.schedules(), []);
    assert.equal(await own.fastPath({ db: s.db, device: DEVICE, transcript: "what time is it", lang: "en", tz: TZ, bot: CROW(), executor: null }), null, "an unrelated utterance leaves it pending");
    assert.ok(own.turnContext({ device: DEVICE }).pending);
    const yes = await own.fastPath({ db: s.db, device: DEVICE, transcript: "yes please", lang: "en", tz: TZ, bot: CROW(), executor: null });
    assert.equal(yes.say, `Okay, I'll remind you ${whenOf(at)}: lunch with the team.`);
    assert.equal(yes.verb, "routine_yes");
    assert.equal((await s.schedules()).length, 1);
    assert.equal(await own.fastPath({ db: s.db, device: DEVICE, transcript: "yes", lang: "en", tz: TZ, bot: CROW(), executor: null }), null);
    assert.equal((await s.schedules()).length, 1);
  } finally { s.close(); }
});

test("fallback-offer mode: a no writes nothing and speaks declined (Spanish too)", async () => {
  const s = await stores();
  try {
    const { own } = make();
    for (const [lang, no] of [["en", "no thanks"], ["es", "no, gracias"]]) {
      const set = await own.forTurn({ db: s.db, bot: CROW(), surface: "kiosk", lang, tz: TZ });
      const r = await run(toolOf(set, "crow_reminder_add"), { text: "lunch", at: "2026-10-26T12:00:00-05:00" }, { executor: null, db: s.db, device: DEVICE, fallback: "calendar" });
      assert.equal(r.code, "needs_confirm");
      const out = await own.fastPath({ db: s.db, device: DEVICE, transcript: no, lang, tz: TZ, bot: CROW(), executor: null });
      assert.deepEqual(out, { say: voiceLine("declined", lang), verb: "routine_no" });
      assert.equal(own.turnContext({ device: DEVICE }), null);
    }
    assert.deepEqual(await s.schedules(), []);
  } finally { s.close(); }
});

test("a pending entry on device A is not taken by device B; no device, no fast path", async () => {
  const s = await stores();
  try {
    const { own, pending } = make();
    const set = await own.forTurn({ db: s.db, bot: CROW({ voice: { confirm: "strict" } }), surface: "kiosk", lang: "en", tz: TZ });
    await run(toolOf(set, "crow_reminder_add"), { text: "call", at: "2026-10-26T12:00:00-05:00" }, { executor: null, db: s.db, device: { id: "dev-a" } });
    const ask = (device, transcript = "yes") => own.fastPath({ db: s.db, device, transcript, lang: "en", tz: TZ, bot: CROW(), executor: null });
    assert.equal(await ask({ id: "dev-b" }), null);
    assert.equal(await ask(null), null);
    assert.equal(await ask(undefined), null);
    assert.equal(own.turnContext({ device: { id: "dev-b" } }), null);
    assert.deepEqual(await s.schedules(), []);
    assert.ok(pending.get("dev-a"));
    assert.ok((await ask({ id: "dev-a" })).say);
    assert.equal((await s.schedules()).length, 1);
    // Strict with no device to hold the question: nothing is asked or written.
    const r = await run(toolOf(set, "crow_reminder_add"), { text: "call", at: "2026-10-26T12:00:00-05:00" }, { executor: null, db: s.db });
    assert.equal(r.ok, false);
    assert.equal((await s.schedules()).length, 1);
  } finally { s.close(); }
});

test("a yes whose write fails speaks the not-done line, never a success", async () => {
  const { own } = make({ connected: ["ws_cal_create_event"] });
  const bot = CROW({ voice: { confirm: "strict" }, routine: { calendar: { calendar: "cal-1" } } });
  const set = await own.forTurn({ db: {}, bot, surface: "kiosk", lang: "en", tz: TZ });
  await run(toolOf(set, "crow_calendar_add_event"), { title: "Lunch", start: "2026-10-26T12:00:00-05:00" }, { executor: null, db: {}, device: DEVICE });
  const out = await own.fastPath({ db: {}, device: DEVICE, transcript: "yes", lang: "en", tz: TZ, bot, executor: fakeExecutor({ fail: "ws_cal_create_event" }) });
  assert.equal(out.say, voiceLine("not_done_say", "en"));
  assert.equal(own.turnContext({ device: DEVICE }), null, "the question is answered either way");
});

test("in the turn: strict reminder asks, the next turn's yes writes it once (the device reaches the tool)", async () => {
  const s = await stores();
  try {
    const { own } = make();
    const bot = CROW({ voice: { confirm: "strict" } });
    const h = harness({ bot, chatTools: [], rounds: [
      [{ type: "tool_call", id: "c1", name: "crow_reminder_add", arguments: { text: "call mom", at: "2026-10-26T12:00:00-05:00" } }, { type: "done" }],
    ] });
    h.deps.ownTools = own.forTurn;
    h.deps.voiceActions = chainVoiceActions([own]);
    const opts = { db: s.db, device: h.device, sink: h.sink, tz: TZ, lang: "en", actionWhen: (t) => /remind/.test(t) };
    await h.runner.runVoiceTurn({ ...opts, transcript: "remind me Monday at noon to call mom" });
    assert.deepEqual(h.calls.spoken, [`Remind you ${whenOf("2026-10-26T12:00:00-05:00")}: call mom?`]);
    assert.deepEqual(await s.schedules(), []);
    await h.runner.runVoiceTurn({ ...opts, transcript: "yes" });
    assert.equal(h.calls.spoken.at(-1), `Okay, I'll remind you ${whenOf("2026-10-26T12:00:00-05:00")}: call mom.`);
    assert.equal((await s.schedules()).length, 1);
    assert.equal(h.log.length, 1, "the yes needed no model call");
  } finally { s.close(); }
});

test("chainVoiceActions: the first fast path that answers wins; contexts join; every afterTurn runs", async () => {
  const seen = [];
  const a = { fastPath: async () => null, turnContext: () => ({ text: "[Pending] A", pending: true }), afterTurn: async () => seen.push("a") };
  const b = { fastPath: async () => ({ say: "B", verb: "b" }), turnContext: () => null, afterTurn: async () => { seen.push("b"); } };
  const c = { fastPath: async () => { throw new Error("never reached"); } };
  const ch = chainVoiceActions([a, b, c]);
  assert.deepEqual(await ch.fastPath({}), { say: "B", verb: "b" });
  assert.deepEqual(ch.turnContext({ device: DEVICE }), { text: "[Pending] A", pending: true });
  await ch.afterTurn({ device: DEVICE, calledTools: [] });
  assert.deepEqual(seen, ["a", "b"]);
  assert.equal(chainVoiceActions([{ turnContext: () => null }]).turnContext({ device: DEVICE }), null);
});

test("VOICE_OWN_TOOL_NAMES is exported from crow-voice.js", async () => {
  const cv = await import("../servers/gateway/voice/crow-voice.js");
  assert.deepEqual([...cv.VOICE_OWN_TOOL_NAMES].sort(), ["crow_calendar_add_event", "crow_reminder_add", "crow_task_add"]);
  assert.equal(cv.VOICE_OWN_TOOL_NAMES, VOICE_OWN_TOOL_NAMES);
});

test("crowVoiceTurnOptions passes a surface's time zone through as opts.tz", async () => {
  const { crowVoiceTurnOptions } = await import("../servers/gateway/voice/crow-voice.js");
  assert.equal(crowVoiceTurnOptions({ surface: "kiosk", lang: "en", tz: TZ }).tz, TZ);
  assert.equal("tz" in crowVoiceTurnOptions({ surface: "kiosk", lang: "en" }), false);
});

test("voice-lines en/es parity for the routine keys", () => {
  const keys = ["calendar_added", "reminder_set", "task_added", "routine_confirm_calendar", "routine_confirm_reminder", "routine_confirm_task", "declined", "calendar_fallback_offer"];
  for (const k of keys) {
    for (const lang of ["en", "es"]) assert.ok(typeof VOICE_LINES[lang][k] === "string" && VOICE_LINES[lang][k].trim(), `${lang}.${k}`);
    const ph = (s) => (s.match(/\{\w+\}/g) || []).sort();
    assert.deepEqual(ph(VOICE_LINES.es[k]), ph(VOICE_LINES.en[k]), k);
  }
  assert.equal(VOICE_LINES.en.calendar_added, "Added {title} to your calendar for {when}.");
  assert.equal(VOICE_LINES.en.reminder_set, "Okay, I'll remind you {when}: {text}.");
  assert.equal(VOICE_LINES.en.task_added, "Added {title} to your tasks.");
  assert.equal(VOICE_LINES.en.routine_confirm_calendar, "Add {title} to your calendar for {when}?");
  assert.equal(VOICE_LINES.en.routine_confirm_reminder, "Remind you {when}: {text}?");
  assert.equal(VOICE_LINES.en.routine_confirm_task, "Add {title} to your tasks?");
  assert.equal(VOICE_LINES.en.declined, "Okay, I won't.");
});

test("a yes with the voice bot gone (null) or under a non-voice bot writes nothing and says not done", async () => {
  const s = await stores();
  try {
    const { own } = make();
    const set = await own.forTurn({ db: s.db, bot: CROW({ voice: { confirm: "strict" } }), surface: "kiosk", lang: "es", tz: TZ });
    for (const bot of [null, { bot_id: "writer", display_name: "Writer" }]) {
      await run(toolOf(set, "crow_reminder_add"), { text: "llamar", at: "2026-10-26T12:00:00-05:00" }, { executor: null, db: s.db, device: DEVICE });
      const out = await own.fastPath({ db: s.db, device: DEVICE, transcript: "sí", lang: "es", tz: TZ, bot, executor: null });
      assert.deepEqual(out, { say: voiceLine("not_done_say", "es"), verb: "routine_failed" }, JSON.stringify(bot));
      assert.equal(own.turnContext({ device: DEVICE }), null, "the entry was taken");
    }
    assert.deepEqual(await s.schedules(), []);
  } finally { s.close(); }
});

test("in the turn: a yes answered under a non-voice bot (opts.botId) writes nothing", async () => {
  const s = await stores();
  try {
    const { own } = make();
    const set = await own.forTurn({ db: s.db, bot: CROW({ voice: { confirm: "strict" } }), surface: "kiosk", lang: "en", tz: TZ });
    const writer = { bot_id: "writer", display_name: "Writer", fast_voice_model: "crow-voice/qwen3.5-4b" };
    const h = harness({ bot: writer, chatTools: [], rounds: [] });
    await run(toolOf(set, "crow_reminder_add"), { text: "call", at: "2026-10-26T12:00:00-05:00" }, { executor: null, db: s.db, device: h.device });
    h.deps.ownTools = own.forTurn;
    h.deps.voiceActions = chainVoiceActions([own]);
    await h.runner.runVoiceTurn({ db: s.db, device: h.device, transcript: "yes", sink: h.sink, tz: TZ, lang: "en", botId: "writer" });
    assert.deepEqual(h.calls.spoken, [voiceLine("not_done_say", "en")]);
    assert.deepEqual(await s.schedules(), []);
  } finally { s.close(); }
});

/** A harness on the real own tools with families on (the voice bot's quick model), escalating only an action-intent turn. */
function familyHarness(own, rounds = []) {
  const h = harness({ bot: CROW(), chatTools: [], rounds });
  h.deps.toolFamilies = createToolFamilies({ manifests: {} });
  h.deps.escalateKey = "crow-chat/qwen3.6-35b-a3b";
  h.deps.chooseVoiceRoute = (msgs, o) => (o?.actionIntent ? { route: "escalate", reason: "action-intent", key: "crow-chat/qwen3.6-35b-a3b" } : { route: "fast", reason: null, key: "crow-voice/qwen3.5-4b" });
  h.deps.ownTools = own.forTurn;
  h.deps.voiceActions = chainVoiceActions([own]);
  return h;
}

test("an action no tool matches, with the default backends: the instant can't-do, no model", async () => {
  const s = await stores();
  try {
    const { own } = make();
    const h = familyHarness(own, [[{ type: "content_delta", text: "Sent. " }, { type: "done" }]]);
    const r = await h.runner.runVoiceTurn({ db: s.db, device: h.device, transcript: "Email my landlord about the heating.", sink: h.sink, tz: TZ, lang: "en", familiesOnIntent: true, actionWhen: () => true });
    assert.deepEqual(h.calls.spoken, [CANT_DO_TEXT]);
    assert.deepEqual(h.calls.chatKeys, []);
    assert.equal(h.log.length, 0);
    assert.equal(r.escalated, false);
  } finally { s.close(); }
});

test("'apaga todo' offers no task tool (no bare to do / todo in the own-tool intents)", async () => {
  const s = await stores();
  try {
    const { own } = make();
    const h = familyHarness(own, [[{ type: "content_delta", text: "Vale. " }, { type: "done" }]]);
    await h.runner.runVoiceTurn({ db: s.db, device: h.device, transcript: "apaga todo", sink: h.sink, tz: TZ, lang: "es", familiesOnIntent: true });
    assert.deepEqual(h.log[0].tools, []);
    const { OWN_TOOL_INTENTS } = await import("../servers/gateway/voice/own-tools.js");
    for (const lists of Object.values(OWN_TOOL_INTENTS)) for (const w of [...lists.en, ...lists.es]) assert.ok(!["to do", "todo"].includes(w), w);
  } finally { s.close(); }
});

test("own-tool intents are the routine-object vocabulary plus a short documented extra list", async () => {
  const { OWN_TOOL_INTENTS, OWN_INTENT_EXTRAS } = await import("../servers/gateway/voice/own-tools.js");
  const { ROUTINE_OBJECTS } = await import("../servers/gateway/voice/routine-objects.js");
  for (const id of ["calendar", "reminders", "tasks"]) for (const lang of ["en", "es"]) {
    assert.deepEqual(OWN_TOOL_INTENTS[id][lang], [...ROUTINE_OBJECTS[id][lang], ...(OWN_INTENT_EXTRAS[id]?.[lang] || [])], `${id}.${lang}`);
  }
});

test("a backend answer that is not JSON is a backend error, never a success", async () => {
  const { own } = make({ connected: ["ws_cal_create_event"] });
  const set = await own.forTurn({ db: {}, bot: CROW({ routine: { calendar: { calendar: "cal-1" } } }), surface: "kiosk", lang: "en", tz: TZ });
  for (const result of ["Created.", "", "[1,2]", "null"]) {
    const ex = { executeToolCalls: async (tcs) => tcs.map((tc) => ({ id: tc.id, name: tc.name, result, isError: false })) };
    const r = await run(toolOf(set, "crow_calendar_add_event"), { title: "Lunch", start: "2026-10-26T12:00:00-05:00" }, { executor: ex, db: {}, device: DEVICE });
    assert.deepEqual(r, { ok: false, code: "backend_error" }, JSON.stringify(result));
  }
});

test("'remember to' / 'acuérdate de' offer the reminder tool; 'remember that' does not", async () => {
  const { own } = make();
  const set = await own.forTurn({ db: {}, bot: CROW(), surface: "kiosk", lang: "en", tz: TZ });
  const lists = normalizeIntentLists(toolOf(set, "crow_reminder_add").intent);
  const offered = (t) => listMatches(phraseWords(t), lists);
  assert.equal(offered("remember to do the dishes tonight"), true);
  assert.equal(offered("acuérdate de sacar la basura"), true);
  assert.equal(offered("acuerdate de sacar la basura"), true);
  assert.equal(offered("remember that my locker is 42"), false);
  assert.equal(offered("remember my locker number"), false);
});

test("strict: a failed own call before a confirmation question still asks it, last, and a yes writes it once", async () => {
  const s = await stores();
  try {
    const { own, pending } = make();
    const bot = CROW({ voice: { confirm: "strict" } });
    const failingTask = { definition: { name: "crow_task_add", description: "x", inputSchema: { type: "object" } }, family: "own:tasks", intent: { en: ["task", "tasks"], es: [] },
      execute: async () => JSON.stringify({ ok: false, code: "backend_error" }) };
    const at = "2026-10-26T17:00:00-05:00";
    const h = harness({ bot, chatTools: [], rounds: [[
      { type: "tool_call", id: "c1", name: "crow_task_add", arguments: { title: "milk" } },
      { type: "tool_call", id: "c2", name: "crow_reminder_add", arguments: { text: "milk", at } },
      { type: "done" },
    ]] });
    h.deps.ownTools = async (a) => { const set = await own.forTurn(a); return { ...set, tools: [failingTask, ...set.tools.filter((t) => t.definition.name !== "crow_task_add")] }; };
    h.deps.voiceActions = chainVoiceActions([own]);
    await h.runner.runVoiceTurn({ db: s.db, device: h.device, transcript: "add milk to my tasks and remind me at 5", sink: h.sink, tz: TZ, lang: "en", actionWhen: () => false });
    const question = `Remind you ${whenOf(at)}: milk?`;
    const heard = h.calls.spoken.join(" ");
    assert.ok(heard.trim().endsWith(question), `heard: ${heard}`);
    assert.ok(heard.includes(NOT_DONE_TEXT) || heard.includes(PARTLY_DONE_TEXT), `heard: ${heard}`);
    assert.equal(pending.get(h.device.id)?.kind, "routine");
    assert.deepEqual(await s.schedules(), []);
    await h.runner.runVoiceTurn({ db: s.db, device: h.device, transcript: "yes", sink: h.sink, tz: TZ, lang: "en", actionWhen: () => false });
    assert.equal((await s.schedules()).length, 1, "the reminder is written once");
    assert.equal(pending.get(h.device.id), null);
  } finally { s.close(); }
});

test("strict: a question re-called from the turn's cache is not re-asked over the one the store holds", async () => {
  const s = await stores();
  try {
    const { own, pending } = make();
    const bot = CROW({ voice: { confirm: "strict" } });
    const failingTask = { definition: { name: "crow_task_add", description: "x", inputSchema: { type: "object" } }, family: "own:tasks", intent: { en: ["task", "tasks"], es: [] },
      execute: async () => JSON.stringify({ ok: false, code: "backend_error" }) };
    const atA = "2026-10-26T17:00:00-05:00";
    const atB = "2026-10-26T18:00:00-05:00";
    const remA = { type: "tool_call", id: "a1", name: "crow_reminder_add", arguments: { text: "milk", at: atA } };
    const h = harness({ bot, chatTools: [], rounds: [[
      remA,
      { type: "tool_call", id: "b1", name: "crow_reminder_add", arguments: { text: "eggs", at: atB } },
      { type: "tool_call", id: "c1", name: "crow_task_add", arguments: { title: "bread" } },
      { type: "done" },
    ], [{ ...remA, id: "a2" }, { type: "done" }]] });
    h.deps.ownTools = async (a) => { const set = await own.forTurn(a); return { ...set, tools: [failingTask, ...set.tools.filter((t) => t.definition.name !== "crow_task_add")] }; };
    h.deps.voiceActions = chainVoiceActions([own]);
    await h.runner.runVoiceTurn({ db: s.db, device: h.device, transcript: "remind me at 5 and at 6 and add bread to my tasks", sink: h.sink, tz: TZ, lang: "en", actionWhen: () => false });
    const qB = `Remind you ${whenOf(atB)}: eggs?`;
    const heard = h.calls.spoken.join(" ");
    assert.ok(heard.trim().endsWith(qB), `heard: ${heard}`);
    assert.ok(!heard.includes(`Remind you ${whenOf(atA)}: milk?`), `heard: ${heard}`);
    assert.equal(pending.get(h.device.id)?.args?.text, "eggs");
    await h.runner.runVoiceTurn({ db: s.db, device: h.device, transcript: "yes", sink: h.sink, tz: TZ, lang: "en", actionWhen: () => false });
    const rows = await s.schedules();
    assert.equal(rows.length, 1, "one reminder is written");
    assert.ok(JSON.stringify(rows).includes("eggs") && !JSON.stringify(rows).includes("milk"), JSON.stringify(rows));
  } finally { s.close(); }
});

test("strict: a cached question that ends the turn as its final line is the pending one, too", async () => {
  const s = await stores();
  try {
    const { own, pending } = make();
    const bot = CROW({ voice: { confirm: "strict" } });
    const okTask = { definition: { name: "crow_task_add", description: "x", inputSchema: { type: "object" } }, family: "own:tasks", intent: { en: ["task", "tasks"], es: [] },
      execute: async () => JSON.stringify({ ok: true, code: "added" }) };
    const atA = "2026-10-26T17:00:00-05:00";
    const atB = "2026-10-26T18:00:00-05:00";
    const remA = { type: "tool_call", id: "a1", name: "crow_reminder_add", arguments: { text: "milk", at: atA } };
    const h = harness({ bot, chatTools: [], rounds: [[
      remA,
      { type: "tool_call", id: "b1", name: "crow_reminder_add", arguments: { text: "eggs", at: atB } },
      { type: "tool_call", id: "c1", name: "crow_task_add", arguments: { title: "bread" } },
      { type: "done" },
    ], [{ ...remA, id: "a2" }, { type: "done" }]] });
    h.deps.ownTools = async (a) => { const set = await own.forTurn(a); return { ...set, tools: [okTask, ...set.tools.filter((t) => t.definition.name !== "crow_task_add")] }; };
    h.deps.voiceActions = chainVoiceActions([own]);
    await h.runner.runVoiceTurn({ db: s.db, device: h.device, transcript: "remind me at 5 and at 6 and add bread to my tasks", sink: h.sink, tz: TZ, lang: "en", actionWhen: () => false });
    const heard = h.calls.spoken.join(" ");
    assert.ok(heard.trim().endsWith(`Remind you ${whenOf(atB)}: eggs?`), `heard: ${heard}`);
    assert.ok(!heard.includes(`Remind you ${whenOf(atA)}: milk?`), `heard: ${heard}`);
    assert.equal(pending.get(h.device.id)?.args?.text, "eggs");
  } finally { s.close(); }
});
