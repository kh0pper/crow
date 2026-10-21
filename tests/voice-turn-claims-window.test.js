/**
 * PR 2.1 Task 1 (#499): no false claim on a turn after one of Crow's own tools. The voice bot keeps a per-device
 * voice memory: own families carry over for VOICE_MODE_WINDOW_MS (offered, never arming the full hold), and every
 * other voice-bot turn inside the window streams through a per-sentence claim gate. Asserted on captions AND TTS.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { harness } from "./fixtures/voice-turn-harness.mjs";
import { createToolFamilies } from "../servers/gateway/voice/tool-families.js";
import { NOT_DONE_TEXT, ACTION_HELD_MAX_TOKENS, ACTION_NOTE, FILLER_TEXT } from "../servers/gateway/voice/turn.js";
import { lastWriteRecap, createOwnTools } from "../servers/gateway/voice/own-tools.js";
import { createPendingStore, chainVoiceActions } from "../servers/gateway/voice/pending.js";

const FAST = "crow-voice/qwen3.5-4b";
const ESC = "crow-chat/qwen3.6-35b-a3b";
const CROW = { bot_id: "crow.voice", kind: "voice", display_name: "Crow", fast_voice_model: FAST };
const TZ = "America/Chicago";
const MIN = 60_000;
const says = (t) => [{ type: "content_delta", text: t }, { type: "done" }];
const call = (name, args = {}, id = "c1") => [{ type: "tool_call", id, name, arguments: args }, { type: "done" }];
const LUNCH = { title: "lunch", start: "2026-10-26T12:00:00-05:00" };
const ADDED = { ok: true, code: "added", final: true, say: "Added lunch to your calendar for Monday at noon." };

function calTool(result = ADDED) {
  const seen = [];
  return {
    definition: { name: "crow_calendar_add_event", description: "add", inputSchema: { type: "object" } },
    family: "own:calendar", intent: { en: ["calendar"], es: [] }, seen,
    execute: async (args) => { seen.push(args); return JSON.stringify(typeof result === "function" ? result(args) : result); },
  };
}
function gateHarness(over = {}) {
  const h = harness({ chatTools: [], bot: CROW, ...over });
  h.deps.toolFamilies = createToolFamilies({ manifests: {} });
  h.deps.escalateKey = ESC;
  h.deps.chooseVoiceRoute = (msgs, o) => (o?.actionIntent ? { route: "escalate", reason: "action-intent", key: ESC } : { route: "fast", reason: null, key: FAST });
  return h;
}
/** One turn; returns its result plus what THIS turn captioned and spoke. */
async function turn(h, transcript, opts = {}) {
  const e0 = h.events.length;
  const s0 = h.calls.spoken.length;
  const r = await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript, sink: h.sink, familiesOnIntent: true, tz: TZ, lang: "en", ownTools: [opts.cal || calTool()], ...opts });
  r.captions = h.events.slice(e0).filter((e) => e.type === "caption_delta").map((e) => e.text).join("");
  r.spoken = h.calls.spoken.slice(s0);
  r.saved = h.runner.convo.get(h.device.id).at(-1);
  return r;
}
/** Turn 1 of every scenario: an ok own add. */
async function addLunch(h) {
  const r = await turn(h, "add lunch Monday to my calendar", { actionWhen: () => true });
  assert.deepEqual(r.spoken, [ADDED.say]);
  return r;
}
const RECAP = () => lastWriteRecap({ tool: "crow_calendar_add_event", ...LUNCH, tz: TZ }, "en");

test("(1) after an ok add, 'add coffee next Tuesday at nine' is offered the calendar tool and a claim is never heard", async () => {
  const h = gateHarness({ rounds: [call("crow_calendar_add_event", LUNCH), says("Added coffee to your calendar for Tuesday. ")] });
  await addLunch(h);
  const r = await turn(h, "add coffee next Tuesday at nine");
  assert.ok(h.log[1].tools.includes("crow_calendar_add_event"), "carried over: the calendar tool is on offer");
  assert.ok(!/Added coffee/.test(r.captions) && !r.spoken.some((t) => /Added coffee/.test(t)));
  assert.equal(r.timings.claim_blocked, true);
});

test("(1b) 'add coffee next Tuesday at nine' is fully held (Task 4's add-matcher)", { todo: "Task 4 adds the add-matcher to the full hold" }, async () => {
  const h = gateHarness({ rounds: [call("crow_calendar_add_event", LUNCH), says("Okay. ")] });
  await addLunch(h);
  const r = await turn(h, "add coffee next Tuesday at nine");
  assert.equal(r.timings.action_guard, true);
});

test("(2) a no-call claim inside the window: not heard or captioned; the recap is, and saved = heard", async () => {
  const h = gateHarness({ rounds: [call("crow_calendar_add_event", LUNCH), says("Added lunch to your calendar for Tuesday. ")] });
  await addLunch(h);
  const r = await turn(h, "what about Tuesday");
  assert.ok(!/Added lunch/.test(r.captions), r.captions);
  assert.ok(!r.spoken.some((t) => /Added lunch/.test(t)));
  assert.ok(RECAP(), "the recap line exists");
  assert.deepEqual(r.spoken, [RECAP()]);
  assert.equal(r.captions.trim(), RECAP());
  assert.equal(r.saved.role, "assistant");
  assert.equal(r.saved.content, RECAP(), "the saved assistant message is what was heard");
  assert.equal(r.timings.claim_blocked, true);
  assert.equal(r.timings.claim_gate, "sentence");
  assert.equal(r.timings.claim_recap, true);
  const turn2 = h.runner.convo.get(h.device.id).slice(-2);
  assert.deepEqual(turn2.map((m) => m.role), ["user", "assistant"]);
  assert.ok(h.runner.convo.get(h.device.id).slice(-2).every((m) => !/Added lunch to your calendar for Tuesday/.test(String(m.content))));
});

test("(2c) a claim about another item ('Added coffee…' after a lunch write): not-done, never the lunch recap", async () => {
  const h = gateHarness({ rounds: [call("crow_calendar_add_event", LUNCH), says("Added coffee to your calendar for Tuesday. ")] });
  await addLunch(h);
  const r = await turn(h, "what about Tuesday");
  assert.deepEqual(r.spoken, [NOT_DONE_TEXT]);
  assert.ok(!/Added coffee/.test(r.captions));
  assert.equal(r.saved.content, NOT_DONE_TEXT);
  assert.equal(r.timings.claim_recap, undefined);
});

test("(2d) Spanish: 'la'/'lo' alone never make a claim refer to the last write", async () => {
  const h = gateHarness({ rounds: [call("crow_calendar_add_event", LUNCH), says("La he enviado. "), says("Lo he añadido a tu calendario. ")] });
  await addLunch(h);
  const r = await turn(h, "y el correo", { lang: "es" });
  assert.deepEqual(r.spoken, [NOT_DONE_TEXT], "a sent message is not the calendar write");
  const r2 = await turn(h, "y la comida", { lang: "es" });
  const es = lastWriteRecap({ tool: "crow_calendar_add_event", ...LUNCH, tz: TZ }, "es");
  assert.deepEqual(r2.spoken, [es], "the same object still recaps");
});

test("(2b) a claim that names nothing of the last write gets the not-done line", async () => {
  const h = gateHarness({ rounds: [call("crow_calendar_add_event", LUNCH), says("Done, I've sent the email to Sam. ")] });
  await addLunch(h);
  const r = await turn(h, "email Sam");
  assert.deepEqual(r.spoken, [NOT_DONE_TEXT]);
  assert.equal(r.saved.content, NOT_DONE_TEXT);
});

test("(3) a plain question inside the window streams: first audio before the end, no 150-token cap", async () => {
  const h = gateHarness({ rounds: [call("crow_calendar_add_event", LUNCH)] });
  await addLunch(h);
  let spokenBeforeDone = -1;
  let maxTokens = null;
  let userMsg = null;
  h.deps.createChatAdapter = async () => ({
    async *chatStream(messages, tools, o) {
      maxTokens = o.maxTokens;
      userMsg = messages.at(-1).content;
      yield { type: "content_delta", text: "It's sunny and mild today. " };
      yield { type: "content_delta", text: "Expect a high of seventy. " };
      spokenBeforeDone = h.calls.spoken.length;
      yield { type: "done" };
    },
  });
  const s0 = h.calls.spoken.length;
  const r = await turn(h, "what's the weather");
  assert.ok(spokenBeforeDone > s0, "audio left before the stream ended");
  assert.notEqual(maxTokens, ACTION_HELD_MAX_TOKENS);
  assert.ok(!String(userMsg).includes(ACTION_NOTE));
  assert.equal(r.timings.action_guard, undefined);
  assert.equal(r.timings.claim_blocked, undefined);
  assert.equal(r.captions, "It's sunny and mild today. Expect a high of seventy. ");
  assert.deepEqual(r.spoken, ["It's sunny and mild today.", "Expect a high of seventy."]);
  assert.equal(r.saved.content, "It's sunny and mild today. Expect a high of seventy. ");
});

test("(4) a preamble then a call that succeeds: the server's line is heard, not not-done", async () => {
  const COFFEE = { ok: true, code: "added", final: true, say: "Added coffee to your calendar for Tuesday at 9:00 AM." };
  const cal = calTool((a) => (a.title === "coffee" ? COFFEE : ADDED));
  const h = gateHarness({ rounds: [
    call("crow_calendar_add_event", LUNCH),
    [{ type: "content_delta", text: "Sure, I'll add that to your calendar. " }, { type: "tool_call", id: "c2", name: "crow_calendar_add_event", arguments: { title: "coffee", start: "2026-10-27T09:00:00-05:00" } }, { type: "done" }],
  ] });
  await turn(h, "add lunch Monday to my calendar", { actionWhen: () => true, cal });
  const r = await turn(h, "can you do coffee Tuesday at nine", { cal });
  assert.equal(cal.seen.length, 2, "the round's call still ran");
  assert.deepEqual(r.spoken, [COFFEE.say]);
  assert.equal(r.captions.trim(), COFFEE.say);
  assert.ok(!r.spoken.includes(NOT_DONE_TEXT));
  assert.equal(r.saved.content, COFFEE.say);
  assert.ok(h.runner.convo.get(h.device.id).every((m) => !/I'll add that/.test(String(m.content))));
});

test("(5) 'did you add it?' after a real write: the recap, never 'nothing was changed'", async () => {
  const h = gateHarness({ rounds: [call("crow_calendar_add_event", LUNCH), says("Yes, it's on your calendar. ")] });
  await addLunch(h);
  const r = await turn(h, "did you add it?");
  assert.deepEqual(r.spoken, [RECAP()]);
  assert.ok(!r.spoken.includes(NOT_DONE_TEXT));
  assert.ok(!/Yes, it's on your calendar/.test(r.captions));
  assert.equal(r.saved.content, RECAP());
});

test("(6) 9 minutes after an own turn, with a plain turn between: still gated; 11 minutes: not gated, not carried", async () => {
  const h = gateHarness({ rounds: [call("crow_calendar_add_event", LUNCH), says("Lima. "), says("Added it to your calendar. ")] });
  await addLunch(h);
  h.c.advance(4 * MIN);
  await turn(h, "what's the capital of Peru");
  h.c.advance(5 * MIN);
  const r = await turn(h, "and Tuesday?");
  assert.ok(h.log[2].tools.includes("crow_calendar_add_event"), "still carried at 9 minutes");
  assert.equal(r.timings.claim_gate, "sentence");
  assert.ok(!r.spoken.some((t) => /Added it/.test(t)));

  const late = gateHarness({ rounds: [call("crow_calendar_add_event", LUNCH), says("Lima. "), says("Added it to your calendar. ")] });
  await addLunch(late);
  late.c.advance(5 * MIN);
  await turn(late, "what's the capital of Peru");
  late.c.advance(6 * MIN);
  const r2 = await turn(late, "and Tuesday?");
  assert.ok(!late.log[2].tools.includes("crow_calendar_add_event"), "not carried at 11 minutes");
  assert.equal(r2.timings.claim_gate, undefined);
  assert.deepEqual(r2.spoken, ["Added it to your calendar."], "outside the window the turn is as before");
});

test("(7) a carried family does not re-stamp itself: after 3 plain turns it still ends at 10 minutes", async () => {
  const h = gateHarness({ rounds: [call("crow_calendar_add_event", LUNCH), says("One. "), says("Two. "), says("Three. "), says("Four. ")] });
  await addLunch(h);
  for (const [i, q] of ["what time is it", "what's the capital of Peru", "how tall is Everest"].entries()) {
    h.c.advance(3 * MIN);
    await turn(h, q);
    assert.ok(h.log[i + 1].tools.includes("crow_calendar_add_event"), `carried on plain turn ${i + 1}`);
  }
  h.c.advance(1.5 * MIN);   // 10.5 minutes after the add
  const r = await turn(h, "and the weather");
  assert.ok(!h.log[4].tools.includes("crow_calendar_add_event"), "the window ended");
  assert.equal(r.timings.claim_gate, undefined);
});

test("(8) an ordinary bot is unchanged: no carry-over, no sentence gate", async () => {
  const bot = { bot_id: "household", display_name: "House", fast_voice_model: FAST };
  const h = gateHarness({ bot, rounds: [call("crow_calendar_add_event", LUNCH), says("Added coffee to your calendar. "), says("Added coffee to your calendar. ")] });
  await addLunch(h);
  // The one-turn follow-up (lastFamilies) and the own-tool window arm the full hold, as before.
  const r = await turn(h, "what about Tuesday");
  assert.deepEqual(r.spoken, [NOT_DONE_TEXT]);
  assert.equal(r.timings.claim_gate, undefined);
  // Two turns on: nothing is carried, and nothing gates the stream.
  const r3 = await turn(h, "and Wednesday");
  assert.ok(!h.log[2].tools.includes("crow_calendar_add_event"));
  assert.equal(r3.timings.claim_gate, undefined);
  assert.deepEqual(r3.spoken, ["Added coffee to your calendar."]);
});

test("an own write's result carries what it wrote (the recap's source)", async () => {
  assert.equal(lastWriteRecap({ tool: "crow_task_add", title: "buy milk" }, "en"), "Buy milk is on your tasks.");
  assert.match(lastWriteRecap({ tool: "crow_reminder_add", title: "call mom", start: "2026-10-26T17:00:00-05:00", tz: TZ }, "en"), /^Your reminder is set for .+: call mom\.$/);
  assert.match(lastWriteRecap({ tool: "crow_calendar_add_event", title: "café", start: "2026-10-26", tz: TZ }, "es"), /^Café está en tu calendario para el /);
  assert.equal(lastWriteRecap({ tool: "crow_calendar_add_event", title: "", start: "2026-10-26" }, "en"), "");
});

test("(9) a gated turn tracks its remote writes: a claim a write backed is heard", async () => {
  const h = gateHarness({ chatTools: ["crow_create_post"], rounds: [call("crow_calendar_add_event", LUNCH), call("crow_create_post", { title: "notes" }, "c2"), says("I've created the post. ")] });
  await addLunch(h);
  const r = await turn(h, "make a post called notes", { familiesOnIntent: false });
  assert.deepEqual(h.calls.executed, ["crow_create_post"]);
  assert.deepEqual(r.spoken, ["I've created the post."]);
  assert.equal(r.timings.claim_blocked, undefined);
});

test("(10) a stray own call with bad_args on a carried-only plain turn never steps up to the larger model", async () => {
  const bad = { ok: false, code: "bad_args", message: "The start is not a date." };
  const cal = calTool((a) => (a.title === "lunch" ? ADDED : bad));
  const h = gateHarness({ probe: () => true, rounds: [call("crow_calendar_add_event", LUNCH), call("crow_calendar_add_event", { title: "x", start: "soon" }, "c2"), says("It's sunny. ")] });
  await turn(h, "add lunch Monday to my calendar", { actionWhen: () => true, cal });
  const keys = h.calls.chatKeys.length;
  const r = await turn(h, "what's the weather", { cal });
  assert.ok(h.log[1].tools.includes("crow_calendar_add_event"), "carried");
  assert.equal(r.timings.step_up, undefined);
  assert.equal(r.escalated, false);
  assert.deepEqual(h.calls.chatKeys.slice(keys), [FAST], "no extra chat key");
  assert.ok(!r.spoken.includes(FILLER_TEXT));
});

test("(11) a stray own write on a carried-only turn asks first; nothing is written until a yes, which writes once", async () => {
  const pending = createPendingStore({ now: () => 1_000 });
  const own = createOwnTools({ pending, connected: () => new Set(["gcal_create_event"]) });
  const h = gateHarness({ rounds: [call("crow_calendar_add_event", LUNCH), call("crow_calendar_add_event", { title: "coffee", start: "2026-10-27T09:00:00-05:00" }, "c2")] });
  const writes = [];
  h.deps.createToolExecutor = () => ({
    executeToolCalls: async (tcs) => { writes.push(...tcs.map((t) => t.arguments.summary)); return tcs.map((t) => ({ id: t.id, name: t.name, result: JSON.stringify({ id: "e1" }) })); },
    close: async () => {},
  });
  h.deps.ownTools = own.forTurn;
  h.deps.voiceActions = chainVoiceActions([own]);
  const run = (transcript, o = {}) => turn(h, transcript, { ownTools: undefined, ...o });
  await run("add lunch Monday to my calendar", { actionWhen: () => true });
  assert.deepEqual(writes, ["lunch"], "a real add runs at once");
  const r = await run("what's the weather");
  assert.deepEqual(writes, ["lunch"], "the stray call wrote nothing");
  assert.equal(r.spoken.length, 1);
  assert.match(r.spoken[0], /^Add coffee to your calendar for .+\?$/);
  const y = await run("yes");
  assert.deepEqual(writes, ["lunch", "coffee"], "the yes wrote once");
  assert.match(y.spoken[0], /^Added coffee to your calendar/);
});

test("(12) a failed stray own call does not stamp the voice memory", async () => {
  const bad = { ok: false, code: "backend_error" };
  const cal = calTool((a) => (a.title === "lunch" ? ADDED : bad));
  const h = gateHarness({ rounds: [call("crow_calendar_add_event", LUNCH), says("Lima. "), call("crow_calendar_add_event", { title: "x" }, "c2"), says("Sorry. "), says("Sunny. "), says("Tall. ")] });
  await turn(h, "add lunch Monday to my calendar", { actionWhen: () => true, cal });
  h.c.advance(1 * MIN);
  await turn(h, "what's the capital of Peru", { cal });   // clears the one-turn lastFamilies follow-up
  h.c.advance(7 * MIN);
  await turn(h, "what's the weather", { cal });           // the failed stray call (8 minutes after the add)
  h.c.advance(1 * MIN);
  await turn(h, "is it sunny", { cal });                  // the one-turn follow-up of the failed call
  h.c.advance(2 * MIN);   // 11 minutes after the ok add, 3 after the failed stray call
  await turn(h, "how tall is Everest", { cal });
  assert.ok(!h.log.at(-1).tools.includes("crow_calendar_add_event"), "the failed call did not renew the window");
});

test("(13) an ordinary bot: a tool-using turn 11 minutes ago is no longer carried (lastFamilies expires)", async () => {
  const bot = { bot_id: "household", display_name: "House", fast_voice_model: FAST };
  const h = gateHarness({ bot, rounds: [call("crow_calendar_add_event", LUNCH), says("Sure. ")] });
  await addLunch(h);
  h.c.advance(11 * MIN);
  await turn(h, "move it to 3");
  assert.ok(!h.log[1].tools.includes("crow_calendar_add_event"));
});
