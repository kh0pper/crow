/**
 * The kiosk shared-display rule (PR 4, Task 4.1): a hand-off asked on the kiosk (or on a turn with no known
 * surface) is never confirmed by voice in the room. It becomes an `awaiting_phone` row and one push to the
 * operator's phone, and Crow says it sent it there, only when the push really went out [rv1 C5]. One open
 * phone confirmation per kiosk [rv2 m4, rv3 m4]. The real core (handoff.js) on a scratch db with the real store,
 * candidate cache and pending store; a fake notify and model availability; the shared fake turn.
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
const { createToolFamilies } = await import("../servers/gateway/voice/tool-families.js");
const { HANDOFF_PHONE_TTL_MS } = await import("../servers/gateway/voice/handoff-constants.js");
const { VOICE_LINES } = await import("../servers/gateway/voice/voice-lines.js");
const { CROW_VOICE_BOT_ID } = await import("../servers/shared/voice-bot.js");
const { KIOSK_DENY_TOOLS } = await import("../bundles/kiosk/server/runtime.js");

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
const SENT = "I've sent that to your phone to confirm.";
const OFF = "I couldn't send that to your phone, because Crow's alerts are turned off there. Ask me from your phone instead.";
const ALREADY = "I've already sent one to your phone. Confirm or decline that first.";
const says = (t) => [{ type: "content_delta", text: t }, { type: "done" }];
const call = (args, id = "h1", name = HANDOFF_TOOL_NAME) => [{ type: "tool_call", id, name, arguments: args }, { type: "done" }];

function freshDb(bots) {
  const dir = mkdtempSync(join(tmpdir(), "vh-kiosk-"));
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
 * notify: "ok" (a notification id), "off" (null: the type is turned off) or "throw".
 */
function setup({ bots = [WRITER, HELPER], rounds, notify = "ok", deviceName = "Kitchen", over = {} } = {}) {
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
    notify: async (_db, n) => {
      pushes.push(n);
      if (notify === "throw") throw new Error("db locked");
      return notify === "off" ? null : { id: pushes.length };
    },
    now: h.c.now,
    log: (m) => h.calls.logs.push(m),
  });
  const realConfirm = core.confirm;
  core.confirm = (...a) => { confirms.push(a); return realConfirm(...a); };
  h.deps.handoffs = { forTurn: (c) => core.forTurn({ ...c, pending }) };
  h.deps.voiceActions = chainVoiceActions([createHandoffVoiceActions({ core, pending })]);
  const device = { ...h.device, id: "kiosk-1", name: deviceName };
  const turn = (transcript, opts = {}) => h.runner.runVoiceTurn({ db, device, transcript, sink: h.sink, surface: "kiosk", lang: "en", ...opts });
  const rows = async () => (await db.execute("SELECT * FROM voice_handoffs ORDER BY created_at, rowid")).rows;
  return { h, db, pending, core, store, pushes, confirms, turn, rows };
}

test("a kiosk hand-off is only proposed: an awaiting_phone row, one push, the sent-to-phone line, no card", async () => {
  const s = setup({ rounds: [call({ task: TASK, bot: "writer" })] });
  const r = await s.turn(ASK);
  assert.ok(s.h.log[0].tools.includes(HANDOFF_TOOL_NAME), "offered on the kiosk");
  assert.deepEqual(s.h.calls.spoken, [SENT]);
  assert.equal(r.timings.final, "crow_handoff:ok");
  const rows = await s.rows();
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.status, "awaiting_phone");
  assert.equal(row.kind, "handoff");
  assert.equal(row.surface, "kiosk");
  assert.equal(row.device_id, "kiosk-1");
  assert.equal(row.device_name, "Kitchen");
  assert.equal(row.bot_id, "writer");
  assert.equal(row.task, TASK);
  assert.equal(row.asked, ASK);
  assert.equal(row.lang, "en");
  assert.equal(row.model_key, "prov/model-a");
  assert.equal(row.start_now, 1);
  assert.equal(Number(row.expires_at), s.h.c.now() + HANDOFF_PHONE_TTL_MS);
  assert.match(row.id, /^vh-[0-9a-f]{16}$/);
  assert.equal(row.card_id, null, "no card");
  assert.equal((await s.db.execute("SELECT COUNT(*) AS n FROM project_audit_log")).rows[0].n, 0, "nothing given");
  assert.deepEqual(s.pushes, [{
    type: "attention", priority: "high", title: "Crow on Kitchen: hand a task to Writer?", body: TASK,
    action_url: "/dashboard/voice/handoffs/" + row.id, source: "crow-voice",
  }]);
  assert.equal(s.pending.get("kiosk-1"), null, "never a handoff pending entry: no yes in the room");
  assert.deepEqual(s.confirms, []);
});

test("notifications off: Crow says so, and the row is failed not_sent", async () => {
  const s = setup({ notify: "off", rounds: [call({ task: TASK, bot: "writer" })] });
  await s.turn(ASK);
  assert.deepEqual(s.h.calls.spoken, [OFF]);
  const [row] = await s.rows();
  assert.equal(row.status, "failed");
  assert.equal(row.detail, "not_sent");
  assert.equal(s.pushes.length, 1);
  assert.equal(s.pending.get("kiosk-1"), null);
});

test("a notify that throws is the same as notifications off: failed not_sent, the phone-off line, logged", async () => {
  const s = setup({ notify: "throw", rounds: [call({ task: TASK, bot: "writer" })] });
  const r = await s.turn(ASK);
  assert.equal(r.failed, null);
  assert.deepEqual(s.h.calls.spoken, [OFF]);
  const [row] = await s.rows();
  assert.deepEqual([row.status, row.detail], ["failed", "not_sent"]);
  assert.ok(s.h.calls.logs.some((m) => /phone notification failed \(db locked\)/.test(m)));
});

test("a failed not_sent row does not block the next kiosk proposal", async () => {
  const s = setup({ notify: "off", rounds: [call({ task: TASK, bot: "writer" }), call({ task: TASK, bot: "writer" }, "h2")] });
  await s.turn(ASK);
  await s.turn(ASK);
  assert.equal(s.pushes.length, 2);
  assert.deepEqual((await s.rows()).map((r) => r.status), ["failed", "failed"]);
});

test("a second kiosk proposal while one is open sends no push and says already sent [rv2 m4]", async () => {
  const s = setup({ rounds: [call({ task: TASK, bot: "writer" }), call({ task: "set up a morning automation", bot: "helper" }, "h2")] });
  await s.turn(ASK);
  await s.turn("have helper set up a morning automation");
  assert.deepEqual(s.h.calls.spoken, [SENT, ALREADY]);
  assert.equal(s.pushes.length, 1, "no second push");
  const rows = await s.rows();
  assert.deepEqual(rows.map((r) => [r.bot_id, r.status]), [["writer", "awaiting_phone"]], "nothing inserted");
});

test("a correction on a kiosk with a live awaiting_phone row says already sent and sends no second push (P11)", async () => {
  const s = setup({ rounds: [call({ task: TASK, bot: "writer" }), call({ task: TASK, bot: "helper" }, "h2")] });
  await s.turn(ASK);
  await s.turn("no, give it to helper");
  assert.ok(s.h.log[1].tools.includes(HANDOFF_TOOL_NAME), "the correction turn is offered the tool");
  assert.deepEqual(s.h.calls.spoken, [SENT, ALREADY]);
  assert.equal(s.pushes.length, 1);
  assert.deepEqual((await s.rows()).map((r) => [r.bot_id, r.status]), [["writer", "awaiting_phone"]], "the first stays open; no row for helper");
});

test("a row expiring between openPhone and insert does not block a new one [rv3 m4]", async () => {
  const s = setup({ rounds: [call({ task: TASK, bot: "writer" }), call({ task: TASK, bot: "helper" }, "h2")] });
  await s.turn(ASK);
  const [first] = await s.rows();
  s.h.c.advance(HANDOFF_PHONE_TTL_MS);   // the first row's expires_at is now: expired, still awaiting_phone in the table
  // The first openPhone read raced the expiry (it saw no live row); the insert then hits the partial unique index.
  const real = s.store.openPhone;
  let n = 0;
  s.store.openPhone = async (...a) => (n++ === 0 ? null : real(...a));
  await s.turn("have helper research radio history");
  assert.equal(n, 2, "openPhone is re-run once after phone_open");
  assert.deepEqual(s.h.calls.spoken, [SENT, SENT]);
  assert.equal(s.pushes.length, 2);
  const rows = await s.rows();
  assert.deepEqual(rows.map((r) => [r.id === first.id, r.bot_id, r.status]), [[true, "writer", "expired"], [false, "helper", "awaiting_phone"]]);
});

test("a second phone_open on the retry is answered already sent, with no push", async () => {
  const s = setup({ rounds: [call({ task: TASK, bot: "writer" }), call({ task: TASK, bot: "helper" }, "h2")] });
  await s.turn(ASK);
  // Both openPhone reads miss the live row (a racing proposal), so both inserts hit the index.
  s.store.openPhone = async () => null;
  let inserts = 0;
  const realInsert = s.store.insert;
  s.store.insert = async (...a) => { inserts++; return realInsert(...a); };
  await s.turn("have helper research radio history");
  assert.equal(inserts, 2, "the insert is retried once");
  assert.deepEqual(s.h.calls.spoken, [SENT, ALREADY]);
  assert.equal(s.pushes.length, 1);
  assert.equal((await s.rows()).length, 1);
});

test("after the first expires, a new one is sent", async () => {
  const s = setup({ rounds: [call({ task: TASK, bot: "writer" }), call({ task: TASK, bot: "helper" }, "h2")] });
  await s.turn(ASK);
  s.h.c.advance(HANDOFF_PHONE_TTL_MS + 1);
  await s.turn("have helper research radio history");
  assert.deepEqual(s.h.calls.spoken, [SENT, SENT]);
  assert.equal(s.pushes.length, 2);
  assert.deepEqual((await s.rows()).map((r) => [r.bot_id, r.status]), [["writer", "expired"], ["helper", "awaiting_phone"]]);
});

test("yes on the kiosk starts nothing", async () => {
  const s = setup({ rounds: [call({ task: TASK, bot: "writer" }), says("Okay. ")] });
  await s.turn(ASK);
  await s.turn("yes");
  assert.deepEqual(s.confirms, [], "no spoken confirm");
  assert.equal(s.h.log.length, 2, "the yes is an ordinary model turn, not a fast-path confirm");
  const [row] = await s.rows();
  assert.equal(row.status, "awaiting_phone");
  assert.equal(row.card_id, null);
  assert.equal((await s.db.execute("SELECT COUNT(*) AS n FROM project_audit_log")).rows[0].n, 0);
  assert.equal(s.pushes.length, 1);
});

test("a which on a kiosk speaks the which line; the named reply (fastPath) takes the same phone path (P2)", async () => {
  const s = setup({ rounds: [call({ task: TASK, candidates: ["writer", "helper"] })] });
  await s.turn("could someone research radio history");
  assert.deepEqual(s.h.calls.spoken, ["That could go to Writer or to Helper — which one?"]);
  assert.equal(s.pending.get("kiosk-1").kind, "which");
  assert.deepEqual(await s.rows(), []);
  const r = await s.turn("writer");
  assert.equal(s.h.log.length, 1, "answered on the fast path, no model round");
  assert.deepEqual(s.h.calls.spoken.at(-1), SENT);
  assert.equal(r.timings.verb, "handoff_which");
  const [row] = await s.rows();
  assert.deepEqual([row.bot_id, row.status, row.surface, row.asked], ["writer", "awaiting_phone", "kiosk", "could someone research radio history"]);
  assert.equal(s.pushes.length, 1);
  assert.equal(s.pushes[0].action_url, "/dashboard/voice/handoffs/" + row.id);
  assert.equal(s.pending.get("kiosk-1"), null, "the which entry is taken and no handoff entry is set");
  // A which answered while one is open on the phone: already sent, no push.
  const t = setup({ rounds: [call({ task: TASK, bot: "helper" }), call({ task: TASK, candidates: ["writer", "helper"] }, "h2")] });
  await t.turn("have helper research radio history");
  await t.turn("could someone research radio history");
  await t.turn("writer");
  assert.deepEqual(t.h.calls.spoken.at(-1), ALREADY);
  assert.equal(t.pushes.length, 1);
  assert.equal(t.pending.get("kiosk-1"), null);
});

test("missing surface is a kiosk", async () => {
  const s = setup({ rounds: [call({ task: TASK, bot: "writer" })] });
  await s.turn(ASK, { surface: undefined });
  assert.deepEqual(s.h.calls.spoken, [SENT]);
  const [row] = await s.rows();
  assert.deepEqual([row.surface, row.status], ["kiosk", "awaiting_phone"]);
  // forTurn itself: no surface, or one it does not know, offers the tool and takes the phone path.
  for (const surface of [undefined, "fridge"]) {
    const t = setup();
    const got = await t.core.forTurn({ db: t.db, device: { id: "kiosk-2", name: null }, surface, lang: "en", bot: CROW, transcript: ASK, pending: t.pending });
    assert.equal(got.length, 1);
    const out = JSON.parse(await got[0].execute({ task: TASK, bot: "writer" }));
    assert.equal(out.say, SENT);
    const [r2] = await t.rows();
    assert.deepEqual([r2.surface, r2.status], ["kiosk", "awaiting_phone"]);
  }
  // A phone and the glasses keep the spoken yes.
  const p = setup();
  const got = await p.core.forTurn({ db: p.db, device: { id: "phone-1", name: "Phone" }, surface: "glasses", lang: "en", bot: CROW, transcript: ASK, pending: p.pending });
  await got[0].execute({ task: TASK, bot: "writer" });
  assert.equal((await p.rows())[0].status, "proposed");
  assert.equal(p.pushes.length, 0);
});

test("the title names the kiosk when it has no name, and Spanish uses Spanish lines (P6)", async () => {
  const s = setup({ deviceName: null, rounds: [call({ task: TASK, bot: "writer" })] });
  await s.turn(ASK);
  assert.equal(s.pushes[0].title, "Crow on the kiosk: hand a task to Writer?");
  assert.doesNotMatch(s.pushes[0].title, /\{display\}/);
  const es = setup({ deviceName: "  ", rounds: [call({ task: "investigar la radio", bot: "writer" }), call({ task: "investigar la radio", bot: "writer" }, "h2")] });
  await es.turn("pídele a writer que investigue la radio", { lang: "es" });
  assert.equal(es.pushes[0].title, "Crow en el quiosco: ¿pasarle una tarea a Writer?");
  assert.deepEqual(es.h.calls.spoken, ["Te lo he enviado al teléfono para que lo confirmes."]);
  assert.equal((await es.rows())[0].lang, "es");
  await es.turn("pídele a writer que investigue la radio", { lang: "es" });
  assert.equal(es.h.calls.spoken.at(-1), "Ya te envié una al teléfono. Confírmala o recházala primero.");
  const off = setup({ notify: "off", rounds: [call({ task: "investigar la radio", bot: "writer" })] });
  await off.turn("pídele a writer que investigue la radio", { lang: "es" });
  assert.equal(off.h.calls.spoken[0], "No pude enviártelo al teléfono porque las alertas de Crow están desactivadas. Pídemelo desde el teléfono.");
  for (const k of ["handoff_sent_to_phone", "handoff_phone_off", "handoff_already_sent", "handoff_phone_title", "handoff_display_fallback"]) {
    assert.ok(VOICE_LINES.en[k] && VOICE_LINES.es[k], `${k} in en and es`);
  }
});

test("routine adds stay direct on a kiosk", async () => {
  const seen = [];
  const cal = {
    definition: { name: "crow_calendar_add_event", description: "crow_calendar_add_event", inputSchema: { type: "object" } },
    family: "own:calendar", intent: { en: ["calendar"], es: [] },
    execute: async (args) => { seen.push(args); return JSON.stringify({ ok: true, code: "added", final: true, say: "Added lunch to your calendar for Monday at noon." }); },
  };
  const s = setup({ rounds: [[{ type: "tool_call", id: "c1", name: "crow_calendar_add_event", arguments: { title: "lunch" } }, { type: "done" }]] });
  s.h.deps.toolFamilies = createToolFamilies({ manifests: {} });
  const r = await s.turn("add lunch Monday to my calendar", { familiesOnIntent: true, ownTools: [cal] });
  assert.equal(seen.length, 1, "run in-process on the kiosk");
  assert.deepEqual(s.h.calls.spoken, ["Added lunch to your calendar for Monday at noon."]);
  assert.deepEqual(r.timings.tools, ["crow_calendar_add_event:added"]);
  assert.deepEqual(await s.rows(), [], "no hand-off row");
  assert.equal(s.pushes.length, 0, "no push");
});

test("KIOSK_DENY_TOOLS still denies crow_delegate, and never crow_handoff", async () => {
  assert.ok(KIOSK_DENY_TOOLS.includes("crow_delegate"));
  assert.ok(KIOSK_DENY_TOOLS.includes("crow_job_status"));
  assert.ok(!KIOSK_DENY_TOOLS.includes(HANDOFF_TOOL_NAME));
  // With the kiosk's deny list, a forced crow_delegate is refused and the hand-off is still offered.
  const s = setup({ rounds: [call({ bot: "writer", task: TASK }, "d1", "crow_delegate"), says("Sorry. ")], over: { chatTools: ["crow_delegate"] } });
  const r = await s.turn(ASK, { denyTools: KIOSK_DENY_TOOLS });
  assert.ok(!s.h.log[0].tools.includes("crow_delegate"));
  assert.ok(s.h.log[0].tools.includes(HANDOFF_TOOL_NAME));
  assert.deepEqual(s.h.calls.executed, [], "crow_delegate never ran");
  assert.ok(r.timings.tools.some((t) => t.startsWith("crow_delegate:")));
});

test("the kiosk fit check builds the hand-off tool and writes nothing", async () => {
  const s = setup();
  const got = await s.core.forTurn({ db: s.db, device: { id: "voice-fit-check" }, surface: "kiosk", lang: null, bot: CROW, transcript: "", pending: s.pending });
  assert.equal(got.length, 1);
  assert.equal(got[0].definition.name, HANDOFF_TOOL_NAME);
  assert.deepEqual(await s.rows(), []);
  assert.equal(s.pushes.length, 0);
});
