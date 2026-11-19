/**
 * A typed turn at the runner level: the same voice turn as a spoken one, with typed words.
 *
 * opts.typed = true says the words were typed, never heard: there is no audio, no STT, and the leading-"add"
 * STT repair (stt-rewrite.js, for a misheard "had"/"and"/"at"/"ad") is skipped. A typed turn is the operator's
 * own words, so it is a NORMAL turn — never a relay turn. Which surface it came from still decides whether a
 * yes confirms a hand-off: on the kiosk (a shared display) nothing may be confirmed in the room, however the
 * words arrived; on the phone a typed turn behaves exactly like a spoken one.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import Database from "better-sqlite3";
import { harness } from "./fixtures/voice-turn-harness.mjs";
import { VOICE_HANDOFFS_DDL } from "../scripts/migrations/0018-voice-handoffs.mjs";

const { createDbClient } = await import("../servers/db.js");
const { createHandoffCore, createHandoffVoiceActions, HANDOFF_TOOL_NAME } = await import("../servers/gateway/voice/handoff.js");
const { createHandoffStore } = await import("../servers/gateway/voice/handoff-store.js");
const { createSummaryCache } = await import("../servers/gateway/voice/bot-summaries.js");
const { createPendingStore, chainVoiceActions } = await import("../servers/gateway/voice/pending.js");
const { CROW_VOICE_BOT_ID } = await import("../servers/shared/voice-bot.js");

const dirs = [];
const clients = [];
after(() => {
  for (const c of clients) { try { c.close(); } catch {} }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const FAST = "crow-voice/qwen3.5-4b";
const CROW = { bot_id: CROW_VOICE_BOT_ID, kind: "voice", display_name: "Crow", fast_voice_model: FAST, handoff: { enabled: true, allowed_bots: [] } };
const board = (over = {}) => ({ gateways: [{ type: "perch" }], models: { default: "prov/model-a" }, ...over });
const WRITER = { bot_id: "writer", display_name: "Writer", def: board({ description: "Researches topics and writes them up as documents" }) };
const HELPER = { bot_id: "helper", display_name: "Helper", def: board({ description: "Sets up automations", models: { default: "prov/model-b" } }) };
const ASK = "have writer research radio history and write it up";
const TASK = "research radio history and write it up";
// Starts with a misheard "add" and names an item and a day: stt-rewrite.js puts the "add" back.
const HEARD = "Had dentist appointment on Tuesday at 815 am";
const ADDED = "add dentist appointment on Tuesday at 815 am";
const says = (t) => [{ type: "content_delta", text: t }, { type: "done" }];
const call = (args, id = "h1", name = HANDOFF_TOOL_NAME) => [{ type: "tool_call", id, name, arguments: args }, { type: "done" }];
const lastUser = (h) => h.log[0].messages.at(-1).content;

/** A harness whose STT adapter and profile lookups are counted (a typed turn must reach neither). */
function countedStt(over = {}) {
  const h = harness(over);
  const seen = { adapters: [], profiles: [] };
  const realAdapter = h.deps.createSttAdapter;
  const realProfile = h.deps.getSttProfile;
  h.deps.createSttAdapter = async (p) => { seen.adapters.push(p); return realAdapter(p); };
  h.deps.getSttProfile = async (...a) => { seen.profiles.push(a); return realProfile(...a); };
  return { h, seen };
}

function freshDb(bots) {
  const dir = mkdtempSync(join(tmpdir(), "vh-typed-"));
  dirs.push(dir);
  const path = join(dir, "crow.db");
  const raw = new Database(path);
  raw.exec(VOICE_HANDOFFS_DDL);
  raw.exec(`CREATE TABLE pi_bot_defs (bot_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, definition TEXT,
    enabled INTEGER NOT NULL DEFAULT 1, project_id INTEGER)`);
  raw.exec(`CREATE TABLE project_audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL,
    actor_type TEXT NOT NULL, actor_id TEXT, action TEXT NOT NULL, target TEXT, payload TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  const ins = raw.prepare("INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id) VALUES (?,?,?,?,?)");
  for (const b of bots) ins.run(b.bot_id, b.display_name ?? b.bot_id, JSON.stringify(b.def ?? board()), b.enabled ?? 1, 1);
  raw.close();
  const db = createDbClient(path);
  clients.push(db);
  return db;
}

/**
 * The fake turn with the real hand-off wired as defaultVoiceDeps wires it, on a kiosk named "Kitchen".
 * `turn(transcript, opts)` takes the turn options typed turns add (typed: true). `deviceId`, `surface` and
 * `confirmImpl` let a test run the same turn from the phone, with a stand-in for core.confirm.
 */
function setup({ bots = [WRITER, HELPER], rounds, notify = "ok", deviceName = "Kitchen", deviceId = "kiosk-1", surface = "kiosk", confirmImpl = null, over = {} } = {}) {
  const h = harness({ bot: CROW, chatTools: [], rounds, ...over });
  const db = freshDb(bots);
  const bus = new EventEmitter();
  const pending = createPendingStore({ now: h.c.now });
  const pushes = [];
  const confirms = [];
  const store = createHandoffStore({ now: h.c.now });
  const core = createHandoffCore({
    store,
    summaries: createSummaryCache({ bus, now: h.c.now }),
    availability: async () => "up",
    loadVoiceDef: async () => null,
    notify: async (_db, n) => { pushes.push(n); return notify === "off" ? null : { id: pushes.length }; },
    now: h.c.now,
    log: (m) => h.calls.logs.push(m),
  });
  const realConfirm = confirmImpl || core.confirm;
  core.confirm = (...a) => { confirms.push(a); return realConfirm(...a); };
  h.deps.handoffs = { forTurn: (c) => core.forTurn({ ...c, pending }) };
  h.deps.voiceActions = chainVoiceActions([createHandoffVoiceActions({ core, pending })]);
  const device = { ...h.device, id: deviceId, name: deviceName };
  const turn = (transcript, opts = {}) => h.runner.runVoiceTurn({ db, device, transcript, sink: h.sink, surface, lang: "en", ...opts });
  const rows = async () => (await db.execute("SELECT * FROM voice_handoffs ORDER BY created_at, rowid")).rows;
  return { h, db, pending, core, store, pushes, confirms, turn, rows, device };
}

test("a typed turn never transcribes: the typed words are the model's last user message, the reply is spoken, no relay", async () => {
  const { h, seen } = countedStt({ rounds: [[{ type: "content_delta", text: "It is nine. " }, { type: "done" }]] });
  const r = await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "hello there", typed: true, sink: h.sink, surface: "kiosk", lang: "en" });
  assert.deepEqual(seen.adapters, [], "no STT adapter for typed words");
  assert.deepEqual(seen.profiles, [], "and no STT profile read");
  assert.equal(h.log[0].messages.at(-1).role, "user");
  assert.ok(lastUser(h).endsWith("hello there"), lastUser(h));
  assert.deepEqual(h.calls.spoken, ["It is nine."], "the reply is spoken");
  assert.equal(r.transcript, "hello there");
  assert.equal(r.timings.relay, undefined, "the operator's own words, not a relay");
});

test("the leading-add STT rewrite is skipped for typed words and still runs for the same spoken words", async () => {
  const typed = harness({ bot: CROW });
  const tr = await typed.runner.runVoiceTurn({ db: {}, device: typed.device, transcript: HEARD, typed: true, sink: typed.sink, surface: "kiosk", lang: "en" });
  assert.match(lastUser(typed), new RegExp(HEARD), "the typed words arrive unchanged");
  assert.doesNotMatch(lastUser(typed), /add dentist/);
  assert.equal(tr.transcript, HEARD);
  assert.equal(tr.timings.stt_rewrite, undefined);

  const spoken = harness({ bot: CROW });
  const sr = await spoken.runner.runVoiceTurn({ db: {}, device: spoken.device, transcript: HEARD, sink: spoken.sink, surface: "kiosk", lang: "en" });
  assert.match(lastUser(spoken), new RegExp(ADDED), "the spoken words are still repaired");
  assert.equal(sr.transcript, ADDED);
  assert.equal(sr.timings.stt_rewrite, "had");
});

test("a typed turn on the kiosk is an ordinary operator turn: crow_handoff is offered, nothing is relayed", async () => {
  const s = setup({ rounds: [call({ task: TASK, bot: "writer" })] });
  const r = await s.turn(ASK, { typed: true });
  assert.ok(s.h.log[0].tools.includes(HANDOFF_TOOL_NAME), "offered as on a spoken kiosk turn");
  assert.equal(r.timings.relay, undefined);
  const [row] = await s.rows();
  assert.equal(row.status, "awaiting_phone");
  assert.equal(row.surface, "kiosk");
  assert.equal(row.asked, ASK);
});

test("a typed yes on the kiosk starts nothing", async () => {
  const s = setup({ rounds: [call({ task: TASK, bot: "writer" }), says("Okay. ")] });
  await s.turn(ASK);
  await s.turn("yes", { typed: true });
  assert.deepEqual(s.confirms, [], "no spoken confirm");
  assert.equal(s.h.log.length, 2, "the typed yes is an ordinary model turn, not a fast-path confirm");
  const rows = await s.rows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "awaiting_phone");
  assert.equal(rows[0].card_id, null, "no card");
  assert.equal((await s.db.execute("SELECT COUNT(*) AS n FROM project_audit_log")).rows[0].n, 0, "nothing given");
  assert.equal(s.pushes.length, 1);
  assert.equal(s.pending.get("kiosk-1"), null);
});

/**
 * The contrast that matters: a typed yes and the same spoken yes reach core.confirm alike on the phone, and
 * neither reaches it on a kiosk. The confirm itself is a stand-in here; it is the routing of the yes that
 * this file decides, and the yes is the same answer either way.
 */
test("a typed yes on the phone confirms a pending hand-off exactly as the spoken yes does, and neither does on a kiosk", async () => {
  const CONFIRMED = { status: "started", say: "On it." };
  const run = async (yesTurn) => {
    const s = setup({ rounds: [call({ task: TASK, bot: "writer" }), says("Okay. ")], deviceId: "phone-1", deviceName: "Phone", surface: "phone", confirmImpl: async () => CONFIRMED });
    await s.turn(ASK);
    const entry = s.pending.get("phone-1");
    assert.equal(entry?.kind, "handoff", "the phone waits on a yes");
    const rounds = s.h.log.length;
    await s.turn("yes", yesTurn);
    return { s, entry, rounds };
  };
  const typed = await run({ typed: true });
  const spoken = await run({});
  for (const [label, r] of [["typed", typed], ["spoken", spoken]]) {
    assert.equal(r.s.confirms.length, 1, `${label}: the yes reached core.confirm`);
    const [db, id, decision, via] = r.s.confirms[0];
    assert.equal(db, r.s.db, `${label}: on the turn's own db`);
    assert.equal(id, r.entry.id, `${label}: for the pending row`);
    assert.deepEqual([decision, via], ["yes", "voice"], label);
    assert.equal(r.s.confirms[0].length, 4, `${label}: the same four arguments as the spoken yes`);
    assert.equal(r.s.h.log.length, r.rounds, `${label}: answered on the fast path, no model round`);
    assert.equal(r.s.pending.get("phone-1"), null, `${label}: the entry is taken`);
    assert.equal(r.s.h.calls.spoken.at(-1), CONFIRMED.say, `${label}: the confirm's line is spoken`);
  }
  assert.deepEqual(typed.s.confirms.map((a) => a.slice(2)), spoken.s.confirms.map((a) => a.slice(2)), "the same answer, the same speak");
  // The kiosk: the very same typed yes reaches nothing (the setup here is the kiosk's own).
  const kiosk = setup({ rounds: [call({ task: TASK, bot: "writer" }), says("Okay. ")] });
  await kiosk.turn(ASK);
  await kiosk.turn("yes", { typed: true });
  assert.deepEqual(kiosk.confirms, [], "a typed yes on a kiosk confirms nothing");
});

test("on the phone a typed turn is the same turn as a spoken one", async () => {
  const phoneTurn = async (extra) => {
    const h = harness({ bot: CROW, rounds: [[{ type: "content_delta", text: "It is nine. " }, { type: "done" }]] });
    const device = { ...h.device, id: "phone-1", name: "Phone", bound_bot_id: CROW.bot_id };
    const r = await h.runner.runVoiceTurn({ db: {}, device, transcript: "hello there", sink: h.sink, surface: "phone", lang: "en", ...extra });
    return { h, r };
  };
  const typed = await phoneTurn({ typed: true });
  const spoken = await phoneTurn({});
  assert.deepEqual(typed.h.log[0].tools, spoken.h.log[0].tools);
  assert.deepEqual(typed.h.calls.spoken, spoken.h.calls.spoken);
  assert.deepEqual(
    { transcript: typed.r.transcript, route: typed.r.route, failed: typed.r.failed },
    { transcript: spoken.r.transcript, route: spoken.r.route, failed: spoken.r.failed },
  );
});