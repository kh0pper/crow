/**
 * Crow's own tools in the voice turn (PR 2, Task 2.1): an own family offered on intent, actionable and
 * backing, run in-process, with a one-time step-up to the larger model on bad_args. Fake own tools only;
 * the real module (own-tools.js) comes later.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { harness } from "./fixtures/voice-turn-harness.mjs";
import { createToolFamilies } from "../servers/gateway/voice/tool-families.js";
import { CANT_DO_TEXT, NOT_DONE_TEXT, FILLER_TEXT, PARTLY_DONE_TEXT } from "../servers/gateway/voice/turn.js";

const FAST = "crow-voice/qwen3.5-4b";
const ESC = "crow-chat/qwen3.6-35b-a3b";
const CROW = { bot_id: "crow.voice", kind: "voice", display_name: "Crow", fast_voice_model: FAST };
const says = (t) => [{ type: "content_delta", text: t }, { type: "done" }];
const call = (name, args = {}, id = "c1") => [{ type: "tool_call", id, name, arguments: args }, { type: "done" }];

function ownTool(name, family, intentEn, result) {
  const seen = [];
  return {
    definition: { name, description: name, inputSchema: { type: "object" } },
    family,
    intent: { en: intentEn, es: [] },
    seen,
    execute: async (args, ctx) => { seen.push({ args, ctx }); return JSON.stringify(typeof result === "function" ? result(args, ctx) : result); },
  };
}
const ADDED = { ok: true, code: "added", final: true, say: "Added lunch to your calendar for Monday at noon." };
const calTool = (result = ADDED) => ownTool("crow_calendar_add_event", "own:calendar", ["calendar"], result);
const OFFER = { ok: true, effect: false, code: "needs_confirm", final: true, say: "I can't add that to a calendar here, but I can remind you at noon. Okay?" };
const remTool = (result = OFFER) => ownTool("crow_reminder_add", "own:reminders", ["remind me", "reminder"], result);
const taskTool = () => ownTool("crow_task_add", "own:tasks", ["task", "tasks"], { ok: true, code: "added", final: true, say: "Added." });

/** The shared harness with families on, an escalation key, and a router that escalates only an action-intent turn. */
function ownHarness(over = {}) {
  const h = harness({ chatTools: [], ...over });
  h.deps.toolFamilies = createToolFamilies({ manifests: {} });
  h.deps.escalateKey = ESC;
  h.seen = [];
  h.deps.chooseVoiceRoute = (msgs, o) => {
    h.calls.routed.push(msgs.map((m) => m.role));
    h.calls.hasTools.push(o?.hasTools);
    h.seen.push({ msgs, ...o });
    return o?.actionIntent ? { route: "escalate", reason: "action-intent", key: ESC } : { route: "fast", reason: null, key: FAST };
  };
  return h;
}
const turn = (h, transcript, opts = {}) => h.runner.runVoiceTurn({ db: {}, device: h.device, transcript, sink: h.sink, familiesOnIntent: true, ...opts });
const act = { actionWhen: () => true };

test("own tool offered on intent and backs the action", async () => {
  const cal = calTool();
  const h = ownHarness({ rounds: [call("crow_calendar_add_event", { title: "lunch", start: "2026-10-26T12:00:00-05:00" })] });
  const r = await turn(h, "add lunch Monday to my calendar", { ...act, ownTools: [cal] });
  assert.ok(h.log[0].tools.includes("crow_calendar_add_event"));
  assert.deepEqual(h.calls.spoken, [ADDED.say]);
  assert.equal(r.timings.claim_blocked, undefined);
  assert.equal(r.escalated, false);
  assert.equal(cal.seen.length, 1, "run in-process");
  assert.deepEqual(h.calls.executed, [], "never sent to the remote executor");
  assert.equal(cal.seen[0].ctx.transcript, "add lunch Monday to my calendar");
  assert.ok(cal.seen[0].ctx.executor && cal.seen[0].ctx.db, "the executor and db are handed over");
  assert.deepEqual(r.timings.tools, ["crow_calendar_add_event:added"]);
  assert.deepEqual(r.timings.families.offered, ["own:calendar"]);
});

test("own tools are not offered on a turn that does not ask for them", async () => {
  const h = ownHarness({ rounds: [says("Lima. ")] });
  await turn(h, "what's the capital of Peru", { ownTools: [calTool()] });
  assert.deepEqual(h.log[0].tools, []);
});

test("families off: own tools go to every round", async () => {
  const h = ownHarness({ rounds: [says("Lima. ")] });
  await turn(h, "what's the capital of Peru", { familiesOnIntent: false, ownTools: [calTool()] });
  assert.deepEqual(h.log[0].tools, ["crow_calendar_add_event"]);
});

test("withheld own tool escalates on a follow-up (the middle step)", async () => {
  // The previous turn on this device was offered the calendar tool (and only asked back): "put it on Monday" follows it.
  const h = ownHarness({ probe: () => true, rounds: [says("Which day? "), call("crow_calendar_add_event", { title: "lunch" })] });
  await turn(h, "add lunch to my calendar", { ...act, ownTools: [calTool()] });
  assert.ok(h.log[0].tools.includes("crow_calendar_add_event"), "offered on the first turn");
  const r = await turn(h, "put it on Monday", { ...act, ownTools: [calTool()] });
  assert.equal(h.calls.hasTools.at(-1), true);
  assert.equal(h.seen.at(-1).actionIntent, true);
  assert.equal(r.escalated, true);
  assert.ok(h.log[1].tools.includes("crow_calendar_add_event"), "the escalated round is offered the own tool");
  assert.deepEqual(h.calls.chatKeys, [FAST, FAST, ESC]);
});

test("withheld own tool with no routine object and no prior own turn: can't-do, no model call", async () => {
  const h = ownHarness({ probe: () => true, rounds: [call("crow_calendar_add_event", { title: "lunch" })] });
  const r = await turn(h, "put it on Monday", { ...act, ownTools: [calTool()] });
  assert.deepEqual(h.calls.spoken, [CANT_DO_TEXT]);
  assert.equal(r.escalated, false);
  assert.equal(r.timings.action_no_tool, true);
  assert.deepEqual(h.calls.chatKeys, []);
  assert.equal(h.log.length, 0);
});

test("bad_args steps up once", async () => {
  const cal = calTool({ ok: false, code: "bad_args" });
  const h = ownHarness({ probe: () => true, rounds: [call("crow_calendar_add_event", { start: "noon" }), call("crow_calendar_add_event", { start: "noonish" }, "c2"), says("Sorry, I couldn't add that. ")] });
  const r = await turn(h, "add lunch to my calendar", { ...act, ownTools: [cal] });
  assert.deepEqual(h.calls.chatKeys, [FAST, ESC], "one step-up, to the escalation key; the second bad_args does not step up again");
  assert.equal(h.calls.chatKeys.at(-1), ESC);
  assert.equal(r.timings.step_up, "own_tool");
  assert.equal(r.escalated, true);
  assert.equal(cal.seen.length, 2);
  assert.ok(h.log[1].tools.includes("crow_calendar_add_event"), "the 35B round re-runs with the tool");
  assert.deepEqual(h.log[1].messages.map((m) => m.role), h.log[0].messages.map((m) => m.role).concat(["assistant", "tool"]), "same messages, plus the failed call");
});

test("step-up speaks the filler", async () => {
  const h = ownHarness({ probe: () => true, rounds: [call("crow_calendar_add_event", {}), says("Sorry, I couldn't add that. ")] });
  await turn(h, "add lunch to my calendar", { ...act, ownTools: [calTool({ ok: false, code: "bad_args" })] });
  assert.equal(h.calls.spoken[0], FILLER_TEXT);
});

test("step-up that cannot get the larger model continues on the quick model", async () => {
  const h = ownHarness({ probe: () => false, rounds: [call("crow_calendar_add_event", {}), says("Sorry, I couldn't add that. ")] });
  const r = await turn(h, "add lunch to my calendar", { ...act, ownTools: [calTool({ ok: false, code: "bad_args" })] });
  assert.deepEqual(h.calls.chatKeys, [FAST]);
  assert.equal(r.timings.step_up, undefined);
  assert.equal(r.timings.step_up_degraded, "cold_timeout");
  assert.equal(r.escalated, false);
  assert.equal(h.log.length, 2, "the next round ran on the quick model");
});

test("no step-up when escalation is off", async () => {
  const h = ownHarness({ probe: () => true, rounds: [call("crow_calendar_add_event", {}), says("Sorry, I couldn't add that. ")] });
  const r = await turn(h, "add lunch to my calendar", { ...act, noEscalate: true, ownTools: [calTool({ ok: false, code: "bad_args" })] });
  assert.deepEqual(h.calls.chatKeys, [FAST]);
  assert.equal(r.timings.step_up, undefined);
  // The voice bot's own escalation "off" is the same.
  const v = ownHarness({ bot: { ...CROW, voice: { escalation: "off" } }, probe: () => true, rounds: [call("crow_calendar_add_event", {}), says("Sorry. ")] });
  v.deps.ownTools = async () => ({ tools: [calTool({ ok: false, code: "bad_args" })], unavailable: [] });
  const rv = await turn(v, "add lunch to my calendar", act);
  assert.deepEqual(v.calls.chatKeys, [FAST]);
  assert.equal(rv.timings.step_up, undefined);
});

test("after an own-tool turn a plain question stays fast", async () => {
  const h = ownHarness({ rounds: [call("crow_calendar_add_event", { title: "lunch" }), says("Lima. ")] });
  await turn(h, "add lunch Monday to my calendar", { ...act, ownTools: [calTool()] });
  const r = await turn(h, "what's the capital of Peru", { ownTools: [calTool()] });
  assert.equal(r.route, "fast");
  const view = h.seen.at(-1).msgs;
  assert.ok(view.every((m) => m.role !== "tool" && !m.tool_calls), "the router's view has no own-tool messages");
  // A follow-up keeps the own tool on the quick model.
  const f = ownHarness({ rounds: [call("crow_calendar_add_event", { title: "lunch" }), says("Sure. ")] });
  await turn(f, "add lunch Monday to my calendar", { ...act, ownTools: [calTool()] });
  await turn(f, "move it to 3", { ownTools: [calTool()] });
  assert.ok(f.log[1].tools.includes("crow_calendar_add_event"));
});

test("no calendar installed: offers a reminder, no escalation", async () => {
  const rem = remTool();
  const src = [];
  const h = ownHarness({ bot: CROW, rounds: [call("crow_reminder_add", { text: "lunch", at: "2026-10-26T12:00:00-05:00" })] });
  h.deps.ownTools = async (a) => { src.push(a); return { tools: [rem], unavailable: ["calendar"] }; };
  const r = await turn(h, "add lunch to my calendar at noon", { ...act, surface: "phone", tz: "America/Chicago", lang: "en" });
  assert.equal(r.timings.calendar_fallback, true);
  assert.equal(r.timings.action_no_backend, undefined);
  assert.deepEqual(h.calls.routed, [], "no router, no escalation");
  assert.deepEqual(h.calls.chatKeys, [FAST]);
  assert.ok(h.log[0].tools.includes("crow_reminder_add"), "the reminder tool is on offer on the quick model");
  assert.deepEqual(h.calls.spoken, [OFFER.say]);
  assert.equal(rem.seen[0].ctx.fallback, "calendar");
  const user = h.log[0].messages.at(-1);
  assert.equal(user.role, "user");
  assert.match(user.content, /calendar/i);
  assert.match(user.content, /crow_reminder_add/);
  assert.ok(!/crow_reminder_add/.test(h.log[0].messages[0].content), "the note never goes on the system message");
  assert.ok(h.runner.convo.get(h.device.id).every((m) => !/crow_reminder_add/.test(String(m.content))), "the note is not saved");
  // The source got the turn's facts, tz included.
  assert.equal(src.length, 1);
  assert.equal(src[0].tz, "America/Chicago");
  assert.equal(src[0].surface, "phone");
  assert.equal(src[0].lang, "en");
  assert.equal(src[0].bot.bot_id, "crow.voice");
  assert.ok(src[0].db);
  assert.equal(typeof src[0].now, "number");
});

test("no calendar installed and no tool call: the action guard's line", async () => {
  const h = ownHarness({ bot: CROW, rounds: [says("Done, I've added it to your calendar. ")] });
  h.deps.ownTools = async () => ({ tools: [remTool()], unavailable: ["calendar"] });
  const r = await turn(h, "add lunch to my calendar at noon", act);
  assert.equal(r.timings.calendar_fallback, true);
  assert.deepEqual(h.calls.spoken, [NOT_DONE_TEXT]);
  assert.equal(r.timings.claim_blocked, true);
});

test("no task backend: can't-do, no model call, no escalation", async () => {
  const h = ownHarness({ bot: CROW, rounds: [says("Added. ")] });
  h.deps.ownTools = async () => ({ tools: [calTool(), remTool()], unavailable: ["tasks"] });
  const r = await turn(h, "add buy milk to my tasks", act);
  assert.deepEqual(h.calls.spoken, [CANT_DO_TEXT]);
  assert.equal(r.timings.action_no_backend, true);
  assert.deepEqual(h.calls.chatKeys, []);
  assert.deepEqual(h.calls.routed, []);
  // Not an action request: no can't-do.
  const q = ownHarness({ bot: CROW, rounds: [says("A task is a piece of work. ")] });
  q.deps.ownTools = async () => ({ tools: [], unavailable: ["tasks"] });
  const rq = await turn(q, "what is a task", {});
  assert.equal(rq.timings.action_no_backend, undefined);
  assert.deepEqual(q.calls.spoken, ["A task is a piece of work."]);
});

test("an ordinary bot never gets deps.ownTools", async () => {
  const h = ownHarness({ rounds: [says("Sorry. ")] });
  let asked = 0;
  h.deps.ownTools = async () => { asked++; return { tools: [calTool()], unavailable: [] }; };
  await turn(h, "add lunch to my calendar", {});
  assert.equal(asked, 0);
  assert.ok(!h.log[0].tools.includes("crow_calendar_add_event"));
  // opts.ownTools wins over the source on the voice bot.
  const v = ownHarness({ bot: CROW, rounds: [says("Sure. ")] });
  v.deps.ownTools = async () => { asked++; return { tools: [], unavailable: [] }; };
  await turn(v, "add lunch to my calendar", { ownTools: [calTool()] });
  assert.equal(asked, 0);
  assert.ok(v.log[0].tools.includes("crow_calendar_add_event"));
});

test("an offered own tool is not escalated", async () => {
  const h = ownHarness({ probe: () => true, rounds: [call("crow_calendar_add_event", {})] });
  const r = await turn(h, "add lunch to my calendar", { ...act, ownTools: [calTool()] });
  assert.equal(h.seen[0].actionIntent, false);
  assert.equal(r.escalated, false);
  // A hand-off tool offered on the quick model also backs the turn (the add-on wrapper stays withheld).
  const handoff = { definition: { name: "crow_handoff", description: "h", inputSchema: { type: "object" } }, execute: async () => JSON.stringify({ ok: true }) };
  const w = ownHarness({ chatTools: ["crow_tools"], probe: () => true, rounds: [says("Okay. ")] });
  await turn(w, "send an email to alex", { ...act, extraTools: [handoff] });
  assert.equal(w.seen[0].actionIntent, false);
});

test("a must-run extra turn carries no own tools or hand-off", async () => {
  const camera = { definition: { name: "crow_glasses_capture_photo", description: "c", inputSchema: { type: "object" } }, must: () => true, execute: async () => JSON.stringify({ ok: true }) };
  for (const familiesOnIntent of [true, false]) {
    for (const via of ["opts", "deps"]) {
      const h = ownHarness({ bot: CROW, rounds: [call("crow_glasses_capture_photo", {}), says("It's a calendar. ")] });
      let asked = 0;
      h.deps.ownTools = async () => { asked++; return { tools: [calTool()], unavailable: [] }; };
      await turn(h, "take a photo of my calendar", { familiesOnIntent, extraTools: [camera], ...(via === "opts" ? { ownTools: [calTool()] } : {}) });
      assert.deepEqual(h.log[0].tools, ["crow_glasses_capture_photo"], `families ${familiesOnIntent}, ${via}`);
      assert.ok(h.log.every((l) => !l.tools.includes("crow_calendar_add_event")));
      assert.equal(asked, 0);
    }
  }
  const n = ownHarness({ bot: CROW, rounds: [says("Sure. ")] });
  let asked = 0;
  n.deps.ownTools = async () => { asked++; return { tools: [calTool()], unavailable: [] }; };
  await turn(n, "add lunch to my calendar", { noOwnTools: true, ownTools: [calTool()] });
  assert.equal(asked, 0);
  assert.deepEqual(n.log[0].tools, []);
});

test("system message identical with and without own tools", async () => {
  const h = ownHarness({ bot: CROW, rounds: [call("crow_calendar_add_event", { title: "lunch" }), says("Lima. "), says("Lisbon. ")] });
  h.deps.ownTools = async () => ({ tools: [calTool()], unavailable: [] });
  await turn(h, "add lunch Monday to my calendar", act);
  await turn(h, "what's the capital of Peru", { noOwnTools: true });
  await turn(h, "what's the capital of Portugal", { ownTools: [] });
  assert.ok(h.log[0].tools.includes("crow_calendar_add_event"));
  assert.equal(h.log[1].messages[0].content, h.log[0].messages[0].content);
  assert.equal(h.log[2].messages[0].content, h.log[0].messages[0].content);
});

test("'add lunch to my schedule' with no calendar is a fallback turn, not an escalation", async () => {
  const h = ownHarness({ bot: CROW, probe: () => true, rounds: [call("crow_reminder_add", { text: "lunch", at: "2026-10-26T12:00:00-05:00" })] });
  h.deps.ownTools = async () => ({ tools: [remTool()], unavailable: ["calendar"] });
  const r = await turn(h, "add lunch to my schedule", act);
  assert.equal(r.timings.calendar_fallback, true);
  assert.equal(r.escalated, false);
  assert.deepEqual(h.calls.routed, []);
  assert.deepEqual(h.calls.chatKeys, [FAST]);
});

test("'remember to do the dishes tonight' with no task backend offers the reminder tool on the quick model", async () => {
  const { OWN_TOOL_INTENTS } = await import("../servers/gateway/voice/own-tools.js");
  const rem = () => ({ ...remTool({ ok: true, code: "added", final: true, say: "I'll remind you." }), intent: OWN_TOOL_INTENTS.reminders });
  const h = ownHarness({ bot: CROW, rounds: [call("crow_reminder_add", { text: "dishes", at: "2026-10-20T20:00:00-05:00" })] });
  h.deps.ownTools = async () => ({ tools: [rem()], unavailable: ["tasks"] });
  const r = await turn(h, "remember to do the dishes tonight", act);
  assert.ok(h.log[0].tools.includes("crow_reminder_add"), "offered to the quick model");
  assert.equal(r.timings.action_no_tool, undefined);
  assert.equal(r.timings.action_no_backend, undefined);
  assert.equal(r.escalated, false);
  assert.deepEqual(h.calls.chatKeys, [FAST]);
  assert.deepEqual(h.calls.spoken, ["I'll remind you."]);
  // "remember that …" is a memory: no reminder tool.
  const m = ownHarness({ bot: CROW, rounds: [says("Got it. ")] });
  m.deps.ownTools = async () => ({ tools: [rem()], unavailable: [] });
  await turn(m, "remember that my locker is 42", {});
  assert.ok(!m.log[0].tools.includes("crow_reminder_add"));
});

test("own-tool messages stay route-neutral on a later turn that has no own tools", async () => {
  for (const later of [{ noOwnTools: true }, "throws"]) {
    const h = ownHarness({ bot: CROW, rounds: [call("crow_calendar_add_event", { title: "lunch" }), says("Lima. ")] });
    let n = 0;
    h.deps.ownTools = async () => { if (n++ > 0 && later === "throws") throw new Error("down"); return { tools: [calTool()], unavailable: [] }; };
    await turn(h, "add lunch Monday to my calendar", act);
    const r = await turn(h, "what's the capital of Peru", later === "throws" ? {} : later);
    assert.equal(r.route, "fast");
    assert.ok(h.seen.at(-1).msgs.every((m) => m.role !== "tool" && !m.tool_calls), String(later));
  }
});

test("an add-on tool with an own tool's name: only the own definition is advertised and the own tool runs", async () => {
  const cal = calTool();
  const h = ownHarness({ chatTools: ["crow_calendar_add_event"], rounds: [call("crow_calendar_add_event", { title: "lunch" })] });
  await turn(h, "add lunch Monday to my calendar", { ...act, ownTools: [cal] });
  assert.equal(h.log[0].tools.filter((n) => n === "crow_calendar_add_event").length, 1);
  assert.equal(h.log[0].toolDefs.find((t) => t.name === "crow_calendar_add_event"), cal.definition);
  assert.deepEqual(h.calls.executed, []);
  assert.equal(cal.seen.length, 1);
});

// ─── Fix round 2: rule 6 yields to a wanted non-own family; the own-tool follow-up window ───
const SHARING = { sharing: { voiceIntent: { en: ["text", "message", "send"], es: ["mensaje", "mandale"] }, tools: { crow_send_message: {} } } };
function msgHarness(rounds) {
  const h = ownHarness({ bot: CROW, chatTools: ["crow_sharing"], rounds });
  h.deps.toolFamilies = createToolFamilies({ manifests: SHARING });
  h.deps.ownTools = async () => ({ tools: [remTool()], unavailable: ["calendar"] });
  return h;
}

test("calendar unavailable: a message that mentions a meeting is a normal messaging turn, not the calendar fallback", async () => {
  for (const t of ["text her the meeting moved to three", "send a message to the team about the event", "mándale un mensaje a Ana sobre la reunión"]) {
    const h = msgHarness([says("Sent. ")]);
    const r = await turn(h, t, act);
    assert.equal(r.timings.calendar_fallback, undefined, t);
    assert.equal(r.timings.action_no_backend, undefined, t);
    assert.equal(r.timings.action_no_tool, undefined, t);
    assert.ok(h.log[0].tools.includes("crow_sharing"), `${t}: the messaging family is offered`);
  }
});

test("calendar unavailable: 'add the meeting to my calendar' is still the fallback", async () => {
  const h = msgHarness([call("crow_reminder_add", { text: "meeting", at: "2026-10-26T12:00:00-05:00" })]);
  const r = await turn(h, "add the meeting to my calendar", act);
  assert.equal(r.timings.calendar_fallback, true);
});

test("the own-tool follow-up window: an own turn 11 minutes ago no longer counts", async () => {
  const h = ownHarness({ probe: () => true, rounds: [says("Which day? "), call("crow_calendar_add_event", { title: "lunch" })] });
  await turn(h, "add lunch to my calendar", { ...act, ownTools: [calTool()] });
  h.c.advance(11 * 60_000);
  const r = await turn(h, "put it on Monday", { ...act, ownTools: [calTool()] });
  assert.equal(r.escalated, false);
  assert.equal(r.timings.action_no_tool, true);
  // Inside the window it still counts.
  const w = ownHarness({ probe: () => true, rounds: [says("Which day? "), call("crow_calendar_add_event", { title: "lunch" })] });
  await turn(w, "add lunch to my calendar", { ...act, ownTools: [calTool()] });
  w.c.advance(9 * 60_000);
  assert.equal((await turn(w, "put it on Monday", { ...act, ownTools: [calTool()] })).escalated, true);
});

test("an escalated unrelated turn (offered every family) does not arm the own-tool follow-up", async () => {
  // Turn 1 escalates on a withheld messaging family; the escalated round is offered the own tool too.
  const h = ownHarness({ bot: CROW, probe: () => true, chatTools: ["crow_sharing"], rounds: [says("Done. "), says("Sure. ")] });
  h.deps.toolFamilies = createToolFamilies({ manifests: SHARING });
  h.deps.ownTools = async () => ({ tools: [calTool()], unavailable: [] });
  const r1 = await turn(h, "email bob the report", act);
  assert.equal(r1.escalated, true);
  assert.ok(h.log[0].tools.includes("crow_calendar_add_event"), "every family was on offer");
  // Turn 2 on a box with no other tool: a vague action is the instant can't-do, not an own-tool follow-up.
  h.deps.getChatTools = () => [];
  const r2 = await turn(h, "put it on Monday", act);
  assert.equal(r2.escalated, false);
  assert.equal(r2.timings.action_no_tool, true);
});

test("VOICE_MODE_WINDOW_MS is the plan constant", async () => {
  const { VOICE_MODE_WINDOW_MS } = await import("../servers/gateway/voice/turn.js");
  assert.equal(VOICE_MODE_WINDOW_MS, 10 * 60_000);
});

// ─── Final review fixes ───
const BACKEND_ERR = { ok: false, code: "backend_error" };
const taskOwn = (result) => ownTool("crow_task_add", "own:tasks", ["task", "tasks"], result);

test("a failed own tool on a non-action turn turns the action guard on: a later claim is not spoken", async () => {
  for (const familiesOnIntent of [true, false]) {
    const t = taskOwn(BACKEND_ERR);
    const h = ownHarness({ bot: CROW, rounds: [call("crow_task_add", { title: "buy milk" }), says("Done, added it. ")] });
    const r = await turn(h, "put buy milk on my tasks", { familiesOnIntent, ownTools: [t] });
    assert.equal(t.seen.length, 1, `families ${familiesOnIntent}`);
    assert.equal(r.timings.action_intent, undefined, "not an action turn by the display's words");
    assert.equal(r.timings.action_guard, true);
    assert.equal(r.timings.claim_blocked, true);
    assert.deepEqual(h.calls.spoken, [NOT_DONE_TEXT]);
  }
});

test("bad_args on a non-action turn with no step-up available: the claim is not spoken", async () => {
  const t = taskOwn({ ok: false, code: "bad_args", message: "The title is required." });
  const h = ownHarness({ bot: CROW, probe: () => true, rounds: [call("crow_task_add", {}), says("Done, added it. ")] });
  const r = await turn(h, "put buy milk on my tasks", { noEscalate: true, ownTools: [t] });
  assert.deepEqual(h.calls.chatKeys, [FAST]);
  assert.equal(r.timings.action_guard, true);
  assert.deepEqual(h.calls.spoken, [NOT_DONE_TEXT]);
});

test("an ok own tool with a final say on a non-action turn still speaks its line", async () => {
  const t = taskOwn({ ok: true, code: "added", final: true, say: "Added buy milk to your tasks." });
  const h = ownHarness({ bot: CROW, rounds: [call("crow_task_add", { title: "buy milk" })] });
  const r = await turn(h, "put buy milk on my tasks", { ownTools: [t] });
  assert.deepEqual(h.calls.spoken, ["Added buy milk to your tasks."]);
  assert.equal(r.timings.claim_blocked, undefined);
});

test("two identical own calls in one round run once", async () => {
  const t = taskOwn({ ok: true, code: "added", final: true, say: "Added buy milk to your tasks." });
  const both = [
    { type: "tool_call", id: "c1", name: "crow_task_add", arguments: { title: "buy milk" } },
    { type: "tool_call", id: "c2", name: "crow_task_add", arguments: { title: "buy milk" } },
    { type: "done" },
  ];
  const h = ownHarness({ bot: CROW, rounds: [both] });
  await turn(h, "put buy milk on my tasks", { ...act, ownTools: [t] });
  assert.equal(t.seen.length, 1, "one execute, so one row");
  assert.deepEqual(h.calls.spoken, ["Added buy milk to your tasks."]);
});

test("a step-up after an ok own call does not run that call again", async () => {
  const rem = remTool({ ok: true, code: "added", final: true, say: "I'll remind you." });
  let n = 0;
  const cal = calTool(() => (n++ === 0 ? { ok: false, code: "bad_args", message: "Give an offset." } : ADDED));
  const round = (a, b, start) => [
    { type: "tool_call", id: a, name: "crow_reminder_add", arguments: { text: "call", at: "2026-10-26T09:00:00-05:00" } },
    { type: "tool_call", id: b, name: "crow_calendar_add_event", arguments: { title: "lunch", start } },
    { type: "done" },
  ];
  const h = ownHarness({ bot: CROW, probe: () => true, rounds: [round("c1", "c2", "noon"), round("c3", "c4", "2026-10-26T12:00:00-05:00")] });
  const r = await turn(h, "remind me to call and add lunch to my calendar", { ...act, ownTools: [rem, cal] });
  assert.equal(r.timings.step_up, "own_tool");
  assert.equal(rem.seen.length, 1, "the reminder ran once");
  assert.equal(cal.seen.length, 2);
  assert.deepEqual(h.calls.spoken.at(-1), ADDED.say);
});

test("no_tz never steps up to the larger model", async () => {
  const cal = calTool({ ok: false, code: "no_tz", message: "No time zone is known on this device." });
  const h = ownHarness({ bot: CROW, probe: () => true, rounds: [call("crow_calendar_add_event", { title: "lunch", start: "2026-10-26T12:00:00-05:00" }), says("Done, added it. ")] });
  const r = await turn(h, "add lunch to my calendar", { ...act, ownTools: [cal] });
  assert.deepEqual(h.calls.chatKeys, [FAST], "no chat key beyond the fast model");
  assert.equal(r.timings.step_up, undefined);
  assert.equal(r.escalated, false);
  assert.deepEqual(h.calls.spoken, [NOT_DONE_TEXT]);
});

test("an offered own tool puts the zone's UTC offset on the user message only", async () => {
  const h = ownHarness({ bot: CROW, rounds: [call("crow_calendar_add_event", { title: "lunch" }), says("Lima. ")] });
  await turn(h, "add lunch Monday to my calendar", { ...act, tz: "America/Chicago", ownTools: [calTool()] });
  const user = h.log[0].messages.at(-1);
  assert.equal(user.role, "user");
  assert.match(user.content, /\[Zone\] America\/Chicago, UTC-0[56]:00/);
  assert.ok(!/\[Zone\]/.test(h.log[0].messages[0].content), "never on the system message");
  assert.ok(h.runner.convo.get(h.device.id).every((m) => !/\[Zone\]/.test(String(m.content))), "never saved");
  // Not offered (a fresh device, a plain question): no zone line, the same system message.
  const q = ownHarness({ bot: CROW, rounds: [says("Lima. ")] });
  await turn(q, "what's the capital of Peru", { tz: "America/Chicago", ownTools: [calTool()] });
  assert.deepEqual(q.log[0].tools, []);
  assert.ok(!/\[Zone\]/.test(q.log[0].messages.at(-1).content));
  assert.equal(q.log[0].messages[0].content, h.log[0].messages[0].content, "the system message is byte-stable");
});

// ─── #499 same round: Crow's words are held from the first word on a turn aimed at its own tools ───
const sameRound = (text, name, args, id = "c1") => [{ type: "content_delta", text }, { type: "tool_call", id, name, arguments: args }, { type: "done" }];
const captions = (h) => h.events.filter((e) => e.type === "caption_delta").map((e) => e.text).join("");
const noAct = { actionWhen: () => false };

test("same round: 'Added it!' with a failing own call on a non-action turn is never heard", async () => {
  const t = taskOwn(BACKEND_ERR);
  const h = ownHarness({ bot: CROW, rounds: [sameRound("Added it to your tasks! ", "crow_task_add", { title: "buy milk" })] });
  const r = await turn(h, "put buy milk on my tasks", { ...noAct, ownTools: [t] });
  assert.equal(t.seen.length, 1);
  assert.equal(r.timings.action_guard, true);
  assert.ok(!/Added/.test(captions(h)), `captions: ${captions(h)}`);
  assert.ok(h.calls.spoken.every((s) => !/Added/.test(s)), `spoken: ${h.calls.spoken}`);
  assert.equal(h.calls.spoken.at(-1), NOT_DONE_TEXT);
  assert.equal(captions(h).trim(), NOT_DONE_TEXT);
});

test("same round: a follow-up in the own-tool window ('move it to 3') with a failing call is never heard as done", async () => {
  let n = 0;
  const t = taskOwn(() => (n++ === 0 ? { ok: true, code: "added", final: true, say: "Added buy milk to your tasks." } : BACKEND_ERR));
  const h = ownHarness({ bot: CROW, rounds: [call("crow_task_add", { title: "buy milk" }), sameRound("Done, moved it! ", "crow_task_add", { title: "buy milk", due: "15:00" }, "c2")] });
  await turn(h, "put buy milk on my tasks", { ...noAct, ownTools: [t] });
  assert.deepEqual(h.calls.spoken, ["Added buy milk to your tasks."]);
  const before = captions(h).length;
  h.c.advance(60_000);
  const r = await turn(h, "move it to 3", { ...noAct, ownTools: [t] });
  assert.equal(t.seen.length, 2);
  assert.equal(r.timings.action_guard, true);
  assert.ok(!/Done, moved/.test(captions(h).slice(before)), `captions: ${captions(h).slice(before)}`);
  assert.ok(h.calls.spoken.every((s) => !/Done, moved/.test(s)), `spoken: ${h.calls.spoken}`);
  assert.equal(h.calls.spoken.at(-1), NOT_DONE_TEXT);
});

test("same round, families off (cloud model): 'Added it!' with a failing own call is never heard", async () => {
  const t = taskOwn(BACKEND_ERR);
  const h = ownHarness({ bot: CROW, rounds: [sameRound("Added it to your tasks! ", "crow_task_add", { title: "buy milk" })] });
  const r = await turn(h, "put buy milk on my tasks", { ...noAct, familiesOnIntent: false, ownTools: [t] });
  assert.equal(t.seen.length, 1);
  assert.equal(r.timings.action_guard, true);
  assert.ok(!/Added/.test(captions(h)), `captions: ${captions(h)}`);
  assert.ok(h.calls.spoken.every((s) => !/Added/.test(s)), `spoken: ${h.calls.spoken}`);
  assert.equal(h.calls.spoken.at(-1), NOT_DONE_TEXT);
});

test("same round, success: only the server's line is heard, nothing before the result", async () => {
  for (const familiesOnIntent of [true, false]) {
    const t = taskOwn({ ok: true, code: "added", final: true, say: "Added buy milk to your tasks." });
    const h = ownHarness({ bot: CROW, rounds: [sameRound("Added it to your tasks! ", "crow_task_add", { title: "buy milk" })] });
    const r = await turn(h, "put buy milk on my tasks", { ...noAct, familiesOnIntent, ownTools: [t] });
    assert.equal(r.timings.action_guard, true, `families ${familiesOnIntent}`);
    assert.deepEqual(h.calls.spoken, ["Added buy milk to your tasks."]);
    assert.equal(captions(h), "Added buy milk to your tasks.");
    assert.equal(r.timings.claim_blocked, undefined);
  }
});

test("a plain question with own tools offered but not targeted still streams (no hold)", async () => {
  const h = ownHarness({ bot: CROW, rounds: [says("Lima is the capital of Peru. ")] });
  const r = await turn(h, "what's the capital of Peru", { ...noAct, familiesOnIntent: false, ownTools: [taskOwn(BACKEND_ERR), calTool()] });
  assert.deepEqual(h.log[0].tools.sort(), ["crow_calendar_add_event", "crow_task_add"]);
  assert.equal(r.timings.action_guard, undefined);
  assert.equal(captions(h), "Lima is the capital of Peru. ");
  assert.deepEqual(h.calls.spoken, ["Lima is the capital of Peru."]);
});

test("a failed own call whose held text claims nothing still ends on the not-done line", async () => {
  const t = taskOwn(BACKEND_ERR);
  const h = ownHarness({ bot: CROW, rounds: [sameRound("Let me add that. ", "crow_task_add", { title: "buy milk" })] });
  const r = await turn(h, "put buy milk on my tasks", { ...noAct, ownTools: [t] });
  assert.equal(r.timings.action_guard, true);
  const heard = h.calls.spoken.join(" ");
  assert.ok(heard.trim().endsWith(NOT_DONE_TEXT), `spoken: ${heard}`);
  assert.ok(captions(h).trim().endsWith(NOT_DONE_TEXT), `captions: ${captions(h)}`);
  assert.ok(!/added/i.test(heard.replace("Let me add that.", "")) && !/added/i.test(captions(h)), `spoken: ${heard}`);
  // The tool's own failure line wins over the not-done line.
  const t2 = taskOwn({ ok: false, code: "backend_error", say: "Your task list is offline right now." });
  const h2 = ownHarness({ bot: CROW, rounds: [sameRound("Let me add that. ", "crow_task_add", { title: "buy milk" })] });
  await turn(h2, "put buy milk on my tasks", { ...noAct, ownTools: [t2] });
  assert.ok(h2.calls.spoken.join(" ").trim().endsWith("Your task list is offline right now."), `spoken: ${h2.calls.spoken}`);
});

// ─── #499 round 2: cloud follow-ups, partly done turns ───
test("families off (cloud): a follow-up in the own-tool window is held and ends on the not-done line", async () => {
  let n = 0;
  const t = taskOwn(() => (n++ === 0 ? { ok: true, code: "added", final: true, say: "Added buy milk to your tasks." } : BACKEND_ERR));
  const h = ownHarness({ bot: CROW, rounds: [call("crow_task_add", { title: "buy milk" }), sameRound("Done, moved it! ", "crow_task_add", { title: "buy milk", due: "15:00" }, "c2")] });
  await turn(h, "put buy milk on my tasks", { ...noAct, familiesOnIntent: false, ownTools: [t] });
  const before = captions(h).length;
  h.c.advance(60_000);
  const r = await turn(h, "move it to 3", { ...noAct, familiesOnIntent: false, ownTools: [t] });
  assert.equal(t.seen.length, 2);
  assert.equal(r.timings.action_guard, true);
  assert.ok(!/Done, moved/.test(captions(h).slice(before)), `captions: ${captions(h).slice(before)}`);
  assert.ok(h.calls.spoken.every((s) => !/Done, moved/.test(s)), `spoken: ${h.calls.spoken}`);
  assert.equal(h.calls.spoken.at(-1), NOT_DONE_TEXT);
});

const REMINDED = { ok: true, code: "added", final: true, say: "Okay, I'll remind you at 5: milk." };
const both = (text, order) => {
  const ev = { task: { type: "tool_call", id: "t1", name: "crow_task_add", arguments: { title: "milk" } },
    rem: { type: "tool_call", id: "r1", name: "crow_reminder_add", arguments: { text: "milk", at: "2026-10-26T17:00:00-05:00" } } };
  return [...(text ? [{ type: "content_delta", text }] : []), ...order.map((k) => ev[k]), { type: "done" }];
};
async function partly(rounds) {
  const t = taskOwn(BACKEND_ERR);
  const rem = remTool(REMINDED);
  const h = ownHarness({ bot: CROW, rounds });
  const r = await turn(h, "add milk to my tasks and remind me at 5", { ...noAct, ownTools: [t, rem] });
  assert.equal(t.seen.length, 1);
  assert.equal(rem.seen.length, 1);
  const heard = h.calls.spoken.join(" ");
  assert.ok(!/Added both/.test(heard) && !/Added both/.test(captions(h)), `heard: ${heard} | captions: ${captions(h)}`);
  assert.ok(heard.includes(REMINDED.say) && captions(h).includes(REMINDED.say), `heard: ${heard}`);
  assert.ok(heard.trim().endsWith(PARTLY_DONE_TEXT) && captions(h).trim().endsWith(PARTLY_DONE_TEXT), `heard: ${heard}`);
  assert.ok(!heard.includes(NOT_DONE_TEXT));
  // What is saved is what was heard.
  const saved = h.runner.convo.get(h.device.id).filter((m) => m.role === "assistant").map((m) => String(m.content)).join(" ");
  assert.ok(!/Added both/.test(saved), `saved: ${saved}`);
  assert.ok(saved.includes(PARTLY_DONE_TEXT), `saved: ${saved}`);
  return r;
}

test("partly done, same round: 'Added both!' is never heard; the reminder's line and the partly-done line are", async () => {
  await partly([both("Added both! ", ["rem", "task"])]);   // the failed call is last
  await partly([both("Added both! ", ["task", "rem"])]);   // the ok final call is last: a later ok on another item does not clear the failure
});

test("partly done, 'Added both!' in round 2 is never heard", async () => {
  await partly([both("", ["rem", "task"]), says("Added both! ")]);
  const nonFinal = { ok: true, code: "added", say: REMINDED.say };   // not final: the turn goes on either way
  const t = taskOwn(BACKEND_ERR);
  const rem = remTool(nonFinal);
  const h = ownHarness({ bot: CROW, rounds: [both("", ["task", "rem"]), says("Added both! ")] });
  await turn(h, "add milk to my tasks and remind me at 5", { ...noAct, ownTools: [t, rem] });
  const heard = h.calls.spoken.join(" ");
  assert.ok(!/Added both/.test(heard) && !/Added both/.test(captions(h)), `heard: ${heard}`);
  assert.ok(heard.includes(REMINDED.say) && heard.trim().endsWith(PARTLY_DONE_TEXT), `heard: ${heard}`);
});

test("a failed own call: the saved reply is what was heard (released text + the failure line)", async () => {
  // "Let me add that." is a promise (claimsAction), so it is never heard; "One moment." claims nothing.
  const h = ownHarness({ bot: CROW, rounds: [sameRound("One moment. ", "crow_task_add", { title: "buy milk" })] });
  await turn(h, "put buy milk on my tasks", { ...noAct, ownTools: [taskOwn(BACKEND_ERR)] });
  const heard = h.calls.spoken.join(" ");
  assert.equal(captions(h), `One moment. ${NOT_DONE_TEXT}`);
  const saved = h.runner.convo.get(h.device.id).filter((m) => m.role === "assistant" && String(m.content).trim()).map((m) => String(m.content).trim());
  assert.deepEqual(saved, [`One moment. ${NOT_DONE_TEXT}`], `heard: ${heard}`);
});

// ─── #499 round 3: each failed item is told; the budget speaks the server's own ending ───
const twoCalls = (a, b) => [{ type: "tool_call", id: "c1", name: "crow_task_add", arguments: a }, { type: "tool_call", id: "c2", name: "crow_task_add", arguments: b }, { type: "done" }];

test("same tool: a backend failure on one item is not cleared by an ok call on another", async () => {
  const t = taskOwn((args) => (args.title === "milk" ? BACKEND_ERR : { ok: true, code: "added", final: true, say: "Added eggs to your tasks." }));
  const h = ownHarness({ bot: CROW, rounds: [twoCalls({ title: "milk" }, { title: "eggs" })] });
  await turn(h, "put milk and eggs on my tasks", { ...noAct, ownTools: [t] });
  const heard = h.calls.spoken.join(" ");
  assert.equal(t.seen.length, 2);
  assert.ok(heard.includes("Added eggs to your tasks."), `heard: ${heard}`);
  assert.ok(heard.trim().endsWith(PARTLY_DONE_TEXT) && captions(h).trim().endsWith(PARTLY_DONE_TEXT), `heard: ${heard}`);
});

test("same tool: bad_args, then the corrected call is ok: a plain success, no partly-done line", async () => {
  const t = taskOwn((args) => (args.title ? { ok: true, code: "added", final: true, say: "Added buy milk to your tasks." } : { ok: false, code: "bad_args", message: "The title is required." }));
  const h = ownHarness({ bot: CROW, rounds: [call("crow_task_add", {}), call("crow_task_add", { title: "buy milk" }, "c2")] });
  await turn(h, "put buy milk on my tasks", { ...noAct, noEscalate: true, ownTools: [t] });
  assert.deepEqual(h.calls.spoken, ["Added buy milk to your tasks."]);
  assert.equal(captions(h), "Added buy milk to your tasks.");
});

test("the first-audio budget running out after the own outcome is known speaks the server's own ending", async () => {
  const slowFail = (ms) => ({ ...taskOwn(BACKEND_ERR), execute: async () => { await new Promise((r) => setTimeout(r, ms)); return JSON.stringify(BACKEND_ERR); } });
  const h = ownHarness({ bot: CROW, rounds: [call("crow_task_add", { title: "buy milk" })] });
  const r = await turn(h, "put buy milk on my tasks", { ...noAct, ownTools: [slowFail(80)], firstAudioBudgetMs: 40 });
  assert.equal(r.failed, "budget");
  assert.deepEqual(h.calls.spoken, [NOT_DONE_TEXT]);
  // Partly done: the reminder's line, then the partly-done line.
  const p = ownHarness({ bot: CROW, rounds: [both("", ["rem", "task"])] });
  await turn(p, "add milk to my tasks and remind me at 5", { ...noAct, ownTools: [slowFail(80), remTool(REMINDED)], firstAudioBudgetMs: 40 });
  assert.equal(p.calls.spoken.join(" "), `${REMINDED.say} ${PARTLY_DONE_TEXT}`);
});

// ─── #499 round 4: a validation failure is cleared only by its own retry or a later round's step-up pick ───
const BAD = { ok: false, code: "bad_args", message: "The title is required." };

test("same round: bad_args on one own tool is not cleared by another tool's ok final call", async () => {
  const t = taskOwn(BAD);
  const rem = remTool(REMINDED);
  const round = [{ type: "tool_call", id: "t1", name: "crow_task_add", arguments: {} },
    { type: "tool_call", id: "r1", name: "crow_reminder_add", arguments: { text: "milk", at: "2026-10-26T17:00:00-05:00" } }, { type: "done" }];
  const h = ownHarness({ bot: CROW, probe: () => true, rounds: [round] });
  const r = await turn(h, "add milk to my tasks and remind me at 5", { ...noAct, ownTools: [t, rem] });
  const heard = h.calls.spoken.join(" ");
  assert.equal(t.seen.length, 1);
  assert.equal(r.timings.own_failed, true);
  assert.ok(heard.includes(REMINDED.say), `heard: ${heard}`);
  assert.ok(heard.indexOf(REMINDED.say) < heard.indexOf(PARTLY_DONE_TEXT) && heard.trim().endsWith(PARTLY_DONE_TEXT), `heard: ${heard}`);
  assert.ok(captions(h).trim().endsWith(PARTLY_DONE_TEXT), `captions: ${captions(h)}`);
});

test("bad_args, then the corrected same-tool call in the step-up round: a plain success", async () => {
  const t = taskOwn((args) => (args.title ? { ok: true, code: "added", final: true, say: "Added buy milk to your tasks." } : BAD));
  const h = ownHarness({ bot: CROW, probe: () => true, rounds: [call("crow_task_add", {}), call("crow_task_add", { title: "buy milk" }, "c2")] });
  const r = await turn(h, "put buy milk on my tasks", { ...noAct, ownTools: [t] });
  assert.equal(r.timings.step_up, "own_tool");
  assert.equal(h.calls.spoken.at(-1), "Added buy milk to your tasks.");
  const heard = h.calls.spoken.join(" ");
  assert.ok(!heard.includes(PARTLY_DONE_TEXT) && !heard.includes(NOT_DONE_TEXT), `heard: ${heard}`);
  assert.equal(r.timings.own_failed, undefined);
});

test("bad_args in round 1, then the step-up round's ok call of another own tool: a plain success", async () => {
  const t = taskOwn(BAD);
  const rem = remTool(REMINDED);
  const h = ownHarness({ bot: CROW, probe: () => true, rounds: [call("crow_task_add", {}), call("crow_reminder_add", { text: "milk", at: "2026-10-26T17:00:00-05:00" }, "c2")] });
  const r = await turn(h, "remind me about milk at 5, it's on my tasks", { ...noAct, ownTools: [t, rem] });
  assert.equal(r.timings.step_up, "own_tool");
  assert.equal(h.calls.spoken.at(-1), REMINDED.say);
  const heard = h.calls.spoken.join(" ");
  assert.ok(!heard.includes(PARTLY_DONE_TEXT) && !heard.includes(NOT_DONE_TEXT), `heard: ${heard}`);
  assert.equal(r.timings.own_failed, undefined);
});

test("the first-audio budget runs out with a question pending and no failure: the question is heard, last", async () => {
  const Q = { ok: true, effect: false, code: "needs_confirm", final: true, say: "Remind you Monday at 5: milk?" };
  const slowOk = { ...taskOwn(null), execute: async () => { await new Promise((r) => setTimeout(r, 80)); return JSON.stringify({ ok: true, code: "added", say: "Added milk to your tasks." }); } };
  const h = ownHarness({ bot: CROW, rounds: [both("", ["rem", "task"])] });
  const r = await turn(h, "add milk to my tasks and remind me at 5", { ...noAct, ownTools: [slowOk, remTool(Q)], firstAudioBudgetMs: 40 });
  assert.equal(r.failed, "budget");
  const heard = h.calls.spoken.join(" ");
  assert.ok(heard.trim().endsWith(Q.say), `heard: ${heard}`);
  assert.ok(captions(h).trim().endsWith(Q.say), `captions: ${captions(h)}`);
  assert.ok(!heard.includes(NOT_DONE_TEXT) && !heard.includes(PARTLY_DONE_TEXT), `heard: ${heard}`);
});

// ─── #499 round 5: a replay never erases a failure; a held question always ends the turn ───
test("a cached replay in the step-up round does not clear another tool's validation failure", async () => {
  const t = taskOwn(BAD);
  const rem = remTool(REMINDED);
  const remCall = (id) => ({ type: "tool_call", id, name: "crow_reminder_add", arguments: { text: "milk", at: "2026-10-26T17:00:00-05:00" } });
  const h = ownHarness({ bot: CROW, probe: () => true, rounds: [
    [remCall("r1"), { type: "tool_call", id: "t1", name: "crow_task_add", arguments: {} }, { type: "done" }],
    [remCall("r2"), { type: "done" }],
  ] });
  const r = await turn(h, "add milk to my tasks and remind me at 5", { ...noAct, ownTools: [t, rem] });
  assert.equal(r.timings.step_up, "own_tool");
  assert.equal(rem.seen.length, 1, "the replay came from the cache");
  const heard = h.calls.spoken.join(" ");
  assert.equal(r.timings.own_failed, true);
  assert.ok(heard.includes(REMINDED.say) && heard.trim().endsWith(PARTLY_DONE_TEXT), `heard: ${heard}`);
});

const QUESTION = { ok: true, effect: false, code: "needs_confirm", final: true, say: "Remind you Monday at 5: milk?" };
const okTaskSay = () => taskOwn({ ok: true, code: "added", say: "Added milk to your tasks." });

test("a question that is not the round's last final call is still asked, last; later claims are never heard", async () => {
  for (const text of ["Added milk and your reminder is set. ", "Done! "]) {
    const h = ownHarness({ bot: CROW, rounds: [both("", ["rem", "task"]), says(text)] });
    await turn(h, "add milk to my tasks and remind me at 5", { ...noAct, ownTools: [okTaskSay(), remTool(QUESTION)] });
    const heard = h.calls.spoken.join(" ");
    assert.ok(heard.trim().endsWith(QUESTION.say) && captions(h).trim().endsWith(QUESTION.say), `heard: ${heard} | captions: ${captions(h)}`);
    assert.ok(heard.includes("Added milk to your tasks."), `heard: ${heard}`);
    assert.ok(!heard.includes(text.trim()) && !captions(h).includes(text.trim()), `heard: ${heard}`);
  }
});

test("the budget firing while the held ending is still synthesizing keeps the question last", async () => {
  const h = ownHarness({ bot: CROW, rounds: [both("", ["rem", "task"]), says("Done! ")] });
  h.deps.createTtsAdapter = async () => ({ name: "kokoro", async *synthesize(text) { h.calls.spoken.push(text); await new Promise((r) => setTimeout(r, 80)); yield Buffer.from(text); } });
  const r = await turn(h, "add milk to my tasks and remind me at 5", { ...noAct, ownTools: [okTaskSay(), remTool(QUESTION)], firstAudioBudgetMs: 40 });
  assert.equal(r.failed, "budget");
  assert.ok(h.calls.spoken.at(-1).trim().endsWith(QUESTION.say), `spoken: ${JSON.stringify(h.calls.spoken)}`);
  assert.ok(captions(h).trim().endsWith(QUESTION.say), `captions: ${captions(h)}`);
});

test("a write-tool turn's user message drops the [Dates] past-day rule; a plain turn keeps it", async () => {
  const { relativeDatesContext, PAST_DAY_RULE } = await import("../servers/shared/relative-dates.js");
  assert.equal(PAST_DAY_RULE, "For something already past, it is the previous one.");
  const dates = relativeDatesContext(Date.parse("2026-10-21T19:11:00Z"), "America/Chicago");
  assert.ok(dates.includes(PAST_DAY_RULE), "other callers keep the sentence");
  const ctx = `[Now] Wednesday, October 21, 2026, 2:11 PM (time zone America/Chicago)\n${dates}`;
  const w = ownHarness({ rounds: [call("crow_calendar_add_event", { title: "coffee", start: "2026-10-27T09:00:00-05:00" })] });
  await turn(w, "add coffee Tuesday to my calendar", { ...act, ownTools: [calTool()], turnContext: ctx, tz: "America/Chicago" });
  const wUser = w.log[0].messages.at(-1).content;
  assert.ok(w.log[0].tools.includes("crow_calendar_add_event"));
  assert.ok(wUser.includes("[Dates] To add or plan something"), "the dates stay");
  assert.ok(!/previous one/.test(wUser), wUser);
  const p = ownHarness({ rounds: [says("It is on Tuesday. ")] });
  await turn(p, "what day is the fair, Tuesday?", { ownTools: [calTool()], turnContext: ctx, tz: "America/Chicago" });
  assert.deepEqual(p.log[0].tools, []);
  assert.ok(p.log[0].messages.at(-1).content.includes(PAST_DAY_RULE));
});

test("a remote write tool, or the add-on wrapper, also drops the past-day rule", async () => {
  const { relativeDatesContext, PAST_DAY_RULE } = await import("../servers/shared/relative-dates.js");
  const ctx = relativeDatesContext(Date.parse("2026-10-21T19:11:00Z"), "America/Chicago");
  for (const name of ["ws_cal_create_event", "crow_tools"]) {
    const h = ownHarness({ familiesOnIntent: false, chatTools: [name], rounds: [says("Okay. ")] });
    await turn(h, "add coffee Tuesday to my calendar", { familiesOnIntent: false, turnContext: ctx });
    assert.ok(h.log[0].tools.includes(name), `${name} offered: ${h.log[0].tools}`);
    const user = h.log[0].messages.at(-1).content;
    assert.ok(user.includes("[Dates] To add or plan something"), name);
    assert.ok(!user.includes(PAST_DAY_RULE), `${name}: ${user}`);
  }
});

// ─── PR 2.1 Task 4 [r2 I8]: intentWhen ───
const { calendarAddIntent } = await import("../servers/gateway/voice/own-tools.js");
const calWhen = (result = ADDED) => ({ ...calTool(result), intentWhen: calendarAddIntent });

test("intentWhen: 'add coffee Tuesday at 9' offers the calendar tool (not the reminder), is an action, and is fully held", async () => {
  const h = ownHarness({ bot: CROW, rounds: [says("Added coffee to your calendar. ")] });
  const r = await turn(h, "add coffee Tuesday at 9", { ownTools: [calWhen(), remTool()], lang: "en" });
  assert.deepEqual(h.log[0].tools, ["crow_calendar_add_event"]);
  assert.equal(r.timings.action_intent, true, "matching sets actionAsked");
  assert.equal(r.timings.action_guard, true, "the full hold");
  assert.equal(r.escalated, false, "the quick model has the tool");
  assert.ok(!h.calls.spoken.some((t) => /Added coffee/.test(t)), "a claim without a call is never heard");
});

test("intentWhen: 'añade café el martes a las 9' does the same", async () => {
  const h = ownHarness({ bot: CROW, rounds: [says("Listo. ")] });
  const r = await turn(h, "añade café el martes a las 9", { ownTools: [calWhen(), remTool()], lang: "es" });
  assert.deepEqual(h.log[0].tools, ["crow_calendar_add_event"]);
  assert.equal(r.timings.action_intent, true);
  assert.equal(r.timings.action_guard, true);
});

test("intentWhen: a call on the matched tool runs directly when the words were heard as said (not carried-only, not rewritten, no confirm)", async () => {
  const cal = calWhen();
  const h = ownHarness({ bot: CROW, rounds: [call("crow_calendar_add_event", { title: "coffee", start: "2026-10-27T09:00:00-05:00" })] });
  const r = await turn(h, "add coffee Tuesday at 9", { ownTools: [cal], lang: "en" });
  assert.equal(r.timings.stt_rewrite, undefined, "typed correctly: nothing was rewritten");
  assert.equal(cal.seen.length, 1);
  assert.equal(cal.seen[0].ctx.confirm, undefined);
  assert.deepEqual(h.calls.spoken, [ADDED.say]);
});

test("intentWhen: a remind word gives the reminder, not the calendar", async () => {
  const h = ownHarness({ bot: CROW, rounds: [says("Okay. ")] });
  await turn(h, "add coffee Tuesday at 9, remind me", { ownTools: [calWhen(), remTool()], lang: "en" });
  assert.deepEqual(h.log[0].tools, ["crow_reminder_add"]);
});

test("intentWhen yields to the display: 'add two minutes' stays a timer, and a display object wins", async () => {
  const timer = { definition: { name: "crow_wm", description: "wm", inputSchema: { type: "object" } }, execute: async () => "ok" };
  const h = ownHarness({ bot: CROW, rounds: [says("Okay. "), says("Okay. ")] });
  const r = await turn(h, "add two minutes", { ownTools: [calWhen()], extraTools: [timer], displayObjectWhen: () => true, lang: "en" });
  assert.ok(!h.log[0].tools.includes("crow_calendar_add_event"), String(h.log[0].tools));
  assert.equal(r.timings.action_intent, undefined);
  const r2 = await turn(h, "add coffee Tuesday at 9", { ownTools: [calWhen()], extraTools: [timer], displayObjectWhen: () => true, lang: "en" });
  assert.ok(!h.log[1].tools.includes("crow_calendar_add_event"), String(h.log[1].tools));
  assert.equal(r2.timings.action_intent, undefined);
});

test("'add up' is arithmetic, not an add: no tool, no hold, the answer streams", async () => {
  for (const t of ["can you add up my hours for tomorrow", "add up the bill for tonight"]) {
    const h = ownHarness({ bot: CROW, rounds: [says("That comes to twelve. ")] });
    const r = await turn(h, t, { ownTools: [calWhen(), remTool()], lang: "en" });
    assert.deepEqual(h.log[0].tools, [], t);
    assert.equal(r.timings.action_intent, undefined, t);
    assert.equal(r.timings.action_guard, undefined, t);
    assert.deepEqual(h.calls.spoken, ["That comes to twelve."], t);
  }
});

// ─── PR 2.1 Task 5 [r2 C3, I4]: no dead end after a blocked claim ───
const { HINT_TEXT } = await import("../servers/gateway/voice/turn.js");
const LUNCH = { title: "lunch", start: "2026-10-26T12:00:00-05:00" };
const COFFEE = { title: "coffee", start: "2026-10-27T09:00:00-05:00" };
const COFFEE_ADDED = { ok: true, code: "added", final: true, say: "Added coffee to your calendar for Tuesday at 9:00 AM." };
const VLLM = async () => ({ named: true, required: true, engine: "vllm" });
const NO_FORCING = async () => ({ named: false, required: false, engine: "llamacpp" });
/** One turn with what THIS turn captioned, spoke and saved. */
async function heard(h, transcript, opts = {}) {
  const e0 = h.events.length;
  const s0 = h.calls.spoken.length;
  const l0 = h.log.length;
  const r = await turn(h, transcript, { tz: "America/Chicago", lang: "en", ...opts });
  r.captions = h.events.slice(e0).filter((e) => e.type === "caption_delta").map((e) => e.text).join("").trim();
  r.spoken = h.calls.spoken.slice(s0);
  r.rounds = h.log.slice(l0);
  const saved = h.runner.convo.get(h.device.id) || [];
  r.saved = saved.at(-1);
  r.savedText = saved.map((m) => String(m.content || "")).join("\n");
  return r;
}

for (const [label, forcing, choice] of [["named", VLLM, { name: "crow_calendar_add_event" }], ["required", async () => ({ named: false, required: true, engine: "configured" }), "required"]]) {
  test(`claim retry (${label}): a blocked claim, then a forced call that succeeds: the success line is heard, the claim never is`, async () => {
    const cal = calTool(COFFEE_ADDED);
    const h = ownHarness({ bot: CROW, rounds: [says("Added coffee to your calendar. "), call("crow_calendar_add_event", COFFEE)] });
    h.deps.toolForcing = forcing;
    const r = await heard(h, "add coffee Tuesday at 9 to my calendar", { ...act, ownTools: [cal] });
    assert.equal(r.rounds.length, 2, "one retry round");
    assert.deepEqual(r.rounds[1].opts.toolChoice, choice);
    assert.deepEqual(r.rounds[1].tools, ["crow_calendar_add_event"]);
    assert.equal(r.rounds[0].opts.toolChoice, undefined, "the first round is not forced");
    assert.equal(r.timings.claim_retry, label);
    assert.equal(cal.seen.length, 1);
    assert.deepEqual(r.spoken, [COFFEE_ADDED.say]);
    assert.equal(r.captions, COFFEE_ADDED.say);
    assert.equal(r.saved.content, COFFEE_ADDED.say);
    assert.ok(!/Added coffee to your calendar\.(?! for)/.test(r.savedText), "the blocked claim is not saved");
    assert.ok(!r.savedText.includes("[Tools]"), "the retry note is not saved");
    assert.equal(h.runner.convo.get(h.device.id).find((m) => m.role === "user").content, "add coffee Tuesday at 9 to my calendar");
  });
}

test("claim retry: the retry makes no call: the hint is heard, captioned and saved", async () => {
  const cal = calTool(COFFEE_ADDED);
  const h = ownHarness({ bot: CROW, rounds: [says("Added coffee to your calendar. "), says("It's on your calendar now. ")] });
  h.deps.toolForcing = VLLM;
  const r = await heard(h, "add coffee Tuesday at 9 to my calendar", { ...act, ownTools: [cal] });
  assert.equal(r.rounds.length, 2);
  assert.equal(r.timings.claim_retry, "named");
  assert.equal(cal.seen.length, 0);
  assert.deepEqual(r.spoken, [HINT_TEXT]);
  assert.equal(r.captions, HINT_TEXT);
  assert.equal(r.saved.content, HINT_TEXT);
  assert.ok(!/on your calendar now|Added coffee/.test(r.savedText));
});

test("claim retry: the hint follows the surface's language (opts.hintText)", async () => {
  const h = ownHarness({ bot: CROW, rounds: [says("Listo, añadido. "), says("Ya está. ")] });
  h.deps.toolForcing = VLLM;
  const r = await heard(h, "añade café el martes a las 9", { ...act, ownTools: [calWhen()], lang: "es", hintText: "PISTA" });
  assert.deepEqual(r.spoken, ["PISTA"]);
});

for (const [next, hint] of [["did you add it?", false], ["move it to 3", true], ["cancel it", true], ["can you check my calendar for that", false], ["¿lo añadiste?", false], ["cambia la hora a las 3", true]]) {
  test(`claim retry: '${next}' after a write: no retry and no second write${hint ? "; the hint" : ""}`, async () => {
    const cal = calTool();
    const h = ownHarness({ bot: CROW, rounds: [call("crow_calendar_add_event", LUNCH), says("Done, I moved it and it's all set. "), call("crow_calendar_add_event", LUNCH, "c2")] });
    h.deps.toolForcing = VLLM;
    const w = await heard(h, "add lunch Monday to my calendar", { ...act, ownTools: [cal] });
    assert.deepEqual(w.spoken, [ADDED.say]);
    const r = await heard(h, next, { ...act, ownTools: [cal] });
    assert.equal(r.rounds.length, 1, `${next}: no retry round`);
    assert.equal(r.timings.claim_retry, undefined);
    assert.equal(cal.seen.length, 1, "no second write");
    assert.ok(!r.spoken.some((t) => /moved it|all set/.test(t)), "the claim is not heard");
    if (hint) {
      assert.ok(r.spoken.join(" ").endsWith(HINT_TEXT), `${next}: ${r.spoken}`);
      assert.ok(r.captions.endsWith(HINT_TEXT), r.captions);
      assert.equal(r.saved.content, r.spoken.join(" "), "saved = heard");
    } else assert.ok(!r.spoken.includes(HINT_TEXT), `${next}: ${r.spoken}`);
  });
}

test("claim retry: escalation off and no forcing available: the hint, no step-up, no second round", async () => {
  const h = ownHarness({ bot: CROW, probe: () => true, rounds: [says("Added coffee to your calendar. "), call("crow_calendar_add_event", COFFEE)] });
  h.deps.toolForcing = NO_FORCING;
  const cal = calTool(COFFEE_ADDED);
  const r = await heard(h, "add coffee Tuesday at 9 to my calendar", { ...act, noEscalate: true, ownTools: [cal] });
  assert.equal(r.rounds.length, 1);
  assert.deepEqual(h.calls.chatKeys, [FAST]);
  assert.equal(r.timings.step_up, undefined);
  assert.equal(r.timings.claim_retry, undefined);
  assert.equal(cal.seen.length, 0);
  assert.deepEqual(r.spoken, [HINT_TEXT]);
  assert.equal(r.captions, HINT_TEXT);
  assert.equal(r.saved.content, HINT_TEXT);
});

test("claim retry: no forcing available, escalation on: one step-up (the filler), then the larger model's call", async () => {
  const cal = calTool(COFFEE_ADDED);
  const h = ownHarness({ bot: CROW, probe: () => true, rounds: [says("Added coffee to your calendar. "), call("crow_calendar_add_event", COFFEE)] });
  h.deps.toolForcing = NO_FORCING;
  const r = await heard(h, "add coffee Tuesday at 9 to my calendar", { ...act, ownTools: [cal] });
  assert.deepEqual(h.calls.chatKeys, [FAST, ESC]);
  assert.equal(r.timings.claim_retry, "step_up");
  assert.equal(r.rounds[1].opts.toolChoice, undefined, "nothing is forced where the engine does not honour it");
  assert.deepEqual(r.spoken, [FILLER_TEXT, COFFEE_ADDED.say]);
  assert.equal(r.captions, COFFEE_ADDED.say, "the filler is not captioned");
  assert.equal(cal.seen.length, 1);
  assert.equal(r.saved.content, COFFEE_ADDED.say);
});

test("claim retry: a forced call that repeats the last write (same tool, title and start) writes nothing", async () => {
  const cal = calTool();
  const h = ownHarness({ bot: CROW, rounds: [call("crow_calendar_add_event", LUNCH), says("Added lunch to your calendar. "), call("crow_calendar_add_event", { title: " Lunch ", start: LUNCH.start })] });
  h.deps.toolForcing = VLLM;
  await heard(h, "add lunch Monday to my calendar", { ...act, ownTools: [cal] });
  const r = await heard(h, "add lunch Monday to my calendar", { ...act, ownTools: [cal] });
  assert.equal(r.timings.claim_retry, "named");
  assert.equal(cal.seen.length, 1, "no second write");
  assert.deepEqual(r.spoken, [ADDED.say], "the earlier result's line");
  assert.equal(r.saved.content, ADDED.say);
});

test("claim retry: a carried-only turn never retries", async () => {
  const cal = calTool();
  const h = ownHarness({ bot: CROW, rounds: [call("crow_calendar_add_event", LUNCH), says("Added dinner to your calendar. "), call("crow_calendar_add_event", { title: "dinner" }, "c2")] });
  h.deps.toolForcing = VLLM;
  await heard(h, "add lunch Monday to my calendar", { ...act, ownTools: [cal] });
  const r = await heard(h, "sounds good, thanks", { ownTools: [cal] });
  assert.equal(r.rounds.length, 1);
  assert.equal(r.timings.claim_retry, undefined);
  assert.equal(cal.seen.length, 1);
});

test("claim retry: on a rewritten turn the retry's write still asks first", async () => {
  const ASK = { ok: true, effect: false, code: "needs_confirm", final: true, say: "Add coffee to your calendar for Tuesday at 9:00 AM?" };
  const cal = { ...calTool((a, ctx) => (ctx.confirm ? ASK : COFFEE_ADDED)), intentWhen: calendarAddIntent };
  const h = ownHarness({ bot: CROW, rounds: [says("Added coffee to your calendar. "), call("crow_calendar_add_event", COFFEE)] });
  h.deps.toolForcing = VLLM;
  const r = await heard(h, "had coffee Tuesday at 9", { ownTools: [cal] });
  assert.equal(r.timings.stt_rewrite, "had");
  assert.equal(r.timings.claim_retry, "named");
  assert.equal(cal.seen.length, 1);
  assert.equal(cal.seen[0].ctx.confirm, true, "asks before writing");
  assert.deepEqual(r.spoken, [ASK.say]);
  assert.equal(r.saved.content, ASK.say);
});

test("claim retry: an add request with no own tool on offer never retries", async () => {
  const h = ownHarness({ chatTools: ["crow_memory"], rounds: [says("Added it. "), says("Done. ")] });
  h.deps.toolForcing = VLLM;
  const r = await heard(h, "add milk", { ...act, familiesOnIntent: false, ownTools: [] });
  assert.equal(r.timings.claim_retry, undefined);
  assert.ok(!r.spoken.includes(HINT_TEXT));
});

// ─── Task 5 fix round 1 ───
for (const t of ["send a text to mom saying I'm late", "reschedule my appointment to Friday"]) {
  test(`claim retry: '${t}' with own tools on offer: no retry, no write, no step-up`, async () => {
    const cal = calWhen(COFFEE_ADDED);
    const rem = remTool({ ok: true, code: "set", final: true, say: "Okay." });
    const h = ownHarness({ bot: CROW, probe: () => true, rounds: [says("Done, it's all taken care of. "), call("crow_calendar_add_event", COFFEE), call("crow_reminder_add", { text: "x" })] });
    h.deps.toolForcing = NO_FORCING;
    const r = await heard(h, t, { ...act, familiesOnIntent: false, ownTools: [cal, rem] });
    assert.equal(r.rounds.length, 1, `${t}: ${r.rounds.length} rounds`);
    assert.equal(r.timings.claim_retry, undefined);
    assert.deepEqual(h.calls.chatKeys, [FAST], "no step-up");
    assert.equal(cal.seen.length + rem.seen.length, 0, "no write");
    assert.ok(!r.spoken.some((x) => /taken care/.test(x)));
  });
}

for (const t of ["remind me to cancel netflix tomorrow", "add move the couch to my tasks", "remind me to change the oil"]) {
  test(`claim retry: '${t}' is an add (the change word has no referent, or the add verb leads): it retries`, async () => {
    const h = ownHarness({ bot: CROW, rounds: [says("Done, it's all set. "), says("Sure. ")] });
    h.deps.toolForcing = VLLM;
    const r = await heard(h, t, { ...act, ownTools: [calWhen(), remTool(), taskTool()] });
    assert.equal(r.rounds.length, 2, `${t}: one retry round`);
    assert.ok(r.timings.claim_retry, t);
  });
}

test("claim retry: 'cámbiala a las nueve' after a write is a change: no retry, the hint", async () => {
  const cal = calTool();
  const h = ownHarness({ bot: CROW, rounds: [call("crow_calendar_add_event", LUNCH), says("Listo, la cambié. ")] });
  h.deps.toolForcing = VLLM;
  await heard(h, "add lunch Monday to my calendar", { ...act, ownTools: [cal] });
  const r = await heard(h, "cámbiala a las nueve", { ...act, ownTools: [cal] });
  assert.equal(r.rounds.length, 1);
  assert.equal(cal.seen.length, 1);
  assert.deepEqual(r.spoken, [HINT_TEXT]);
});

test("claim retry: no hint when a write tool that is not Crow's own is on offer (it could change things)", async () => {
  const cal = calTool();
  const h = ownHarness({ bot: CROW, chatTools: ["ws_cal_update_event"], rounds: [says("Moved it to 3. ")] });
  h.deps.toolForcing = VLLM;
  const r = await heard(h, "move it to 3", { ...act, familiesOnIntent: false, ownTools: [cal] });
  assert.ok(h.log[0].tools.includes("ws_cal_update_event"));
  assert.deepEqual(r.spoken, [NOT_DONE_TEXT]);
});

test("claim retry: a refused forced request that steps down to no forcing records claim_retry 'none'", async () => {
  const cal = calTool(COFFEE_ADDED);
  const h = ownHarness({ bot: CROW, rounds: [says("Added coffee to your calendar. "), call("crow_calendar_add_event", COFFEE)] });
  h.deps.toolForcing = async () => ({ named: true, required: false, engine: "unknown" });
  const inner = h.deps.createChatAdapter;
  h.deps.createChatAdapter = async (key) => {
    const a = await inner(key);
    return { async *chatStream(m, t, o) { if (o.toolChoice) throw Object.assign(new Error("bad"), { code: "provider_error", status: 400 }); yield* a.chatStream(m, t, o); } };
  };
  const r = await heard(h, "add coffee Tuesday at 9 to my calendar", { ...act, ownTools: [cal] });
  assert.equal(r.timings.claim_retry, "none");
  assert.equal(cal.seen.length, 1);
});

test("claim retry: two calls in the forced round with the same title and start (other args differ): one write", async () => {
  const cal = calTool(COFFEE_ADDED);
  const h = ownHarness({ bot: CROW, rounds: [says("Added coffee to your calendar. "), [
    { type: "tool_call", id: "a", name: "crow_calendar_add_event", arguments: { ...COFFEE, end: "2026-10-27T10:00:00-05:00" } },
    { type: "tool_call", id: "b", name: "crow_calendar_add_event", arguments: { title: "Coffee", start: COFFEE.start, end: "2026-10-27T10:30:00-05:00" } },
    { type: "done" }]] });
  h.deps.toolForcing = VLLM;
  const r = await heard(h, "add coffee Tuesday at 9 to my calendar", { ...act, ownTools: [cal] });
  assert.equal(cal.seen.length, 1, "one write");
  assert.equal(r.timings.claim_dedupe, true);
  assert.deepEqual(r.spoken, [COFFEE_ADDED.say]);
});

// ─── Task 5 fix round 2: a change word anywhere is a change (a leading add verb or the add-matcher overrides it) ───
for (const t of ["move lunch to 3 on my calendar", "cancel lunch on my calendar", "reschedule lunch to 3", "put it off until Friday"]) {
  test(`claim retry: '${t}' after a write is a change: no retry, no write, the hint`, async () => {
    const cal = calTool();
    const h = ownHarness({ bot: CROW, probe: () => true, rounds: [call("crow_calendar_add_event", LUNCH), says("Done, I moved lunch to 3. "), call("crow_calendar_add_event", LUNCH, "c2")] });
    h.deps.toolForcing = VLLM;
    await heard(h, "add lunch Monday to my calendar", { ...act, ownTools: [cal] });
    const r = await heard(h, t, { ...act, ownTools: [cal] });
    assert.equal(r.rounds.length, 1, `${t}: no retry round`);
    assert.equal(r.timings.claim_retry, undefined);
    assert.equal(cal.seen.length, 1, "no second write");
    assert.deepEqual(r.spoken, [HINT_TEXT], `${t}: ${r.spoken}`);
    assert.equal(r.saved.content, HINT_TEXT);
  });
}

// ─── PR 2.1 Task 6 fix 1 (rule 6): while an own routine tool is loaded, the remote write it wraps never runs ───
test("voice bot: a direct or proxied remote calendar/task write is refused while the own tool is loaded; an ordinary bot is unchanged", async () => {
  const { effectiveToolName } = await import("../servers/gateway/ai/tool-executor.js");
  const shared = { calendar: "Menu_shared_by_admin", summary: "Lunch", start: "2026-10-26T12:00:00-05:00" };
  const cases = [
    ["ws_cal_create_event", shared, "ws_cal_create_event"],
    ["crow_tools", { action: "ws_cal_create_event", params: shared }, "crow_tools"],
    ["gcal_create_event", { summary: "Lunch", start: "2026-10-26T12:00:00-05:00", calendar_id: "family" }, "gcal_create_event"],
    ["ws_task_create", { list: "Chores_shared_by_admin", summary: "Milk" }, "ws_task_create"],
  ];
  for (const [name, args, offered] of cases) {
    for (const voice of [true, false]) {
      const h = ownHarness({ bot: voice ? CROW : undefined, familiesOnIntent: false, chatTools: [offered], rounds: [call(name, args), says("Okay. ")] });
      h.deps.effectiveToolName = effectiveToolName;
      h.deps.isConnectedAddonTool = (n) => ["ws_cal_create_event", "gcal_create_event", "ws_task_create"].includes(n);
      await turn(h, "add lunch Monday at noon to my calendar and a task", { familiesOnIntent: false, ownTools: [calTool(), taskTool()] });
      const ran = h.calls.executed.includes(name);
      if (voice) assert.equal(ran, false, `voice: ${name} must not run`);
      else assert.equal(ran, true, `ordinary bot: ${name} runs as before`);
    }
  }
});
