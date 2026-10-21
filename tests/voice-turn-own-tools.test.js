/**
 * Crow's own tools in the voice turn (PR 2, Task 2.1): an own family offered on intent, actionable and
 * backing, run in-process, with a one-time step-up to the larger model on bad_args. Fake own tools only;
 * the real module (own-tools.js) comes later.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { harness } from "./fixtures/voice-turn-harness.mjs";
import { createToolFamilies } from "../servers/gateway/voice/tool-families.js";
import { CANT_DO_TEXT, NOT_DONE_TEXT, FILLER_TEXT } from "../servers/gateway/voice/turn.js";

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
