/**
 * Live test 2026-10-04, replayed: a small assistant on a kiosk display, three plain
 * questions and one timer. Before: every turn ran crow_wm twice (≈7 s), "Tell me a joke"
 * left an "Info" card repeating the spoken joke, "What time is it?" left a card titled
 * "<title>" (the tool's own syntax line) and no time, and the cards piled up as chips.
 * The REAL voice turn + the REAL kiosk display tool, clock and fast paths; only the
 * model, STT and TTS are scripted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createVoiceTurnRunner } from "../servers/gateway/voice/turn.js";
import { TURN_CONTEXT_NOTE } from "../servers/gateway/voice/context-echo.js";
import { createWmStore, createWmTool, matchWmFastPath, kioskPromptSuffix, kioskTurnContext } from "../bundles/kiosk/server/wm.js";
import { kioskNowContext, matchClockFastPath } from "../bundles/kiosk/server/clock.js";
import { KIOSK_DENY_TOOLS, KIOSK_MAX_TOOL_ROUNDS } from "../bundles/kiosk/server/runtime.js";

const AT = Date.UTC(2026, 9, 4, 20, 42, 10);   // 3:42 PM in America/Chicago
const TZ = "America/Chicago";

/** A display wired like the kiosk runtime wires it; `script(request)` plays the model, one call per round. */
function display(script) {
  const requests = [];
  const spoken = [];
  const events = [];
  const store = createWmStore({ now: () => AT, setTimer: () => ({}), clearTimer: () => {} });
  const runner = createVoiceTurnRunner({
    log: () => {}, now: () => AT, sleep: async () => {},
    loadBotRow: async () => ({ bot_id: "house", enabled: 1, definition: JSON.stringify({ bot_id: "house", system_prompt: "You are a small household assistant." }) }),
    getSttProfile: async () => ({ id: "stt" }), createSttAdapter: async () => ({ transcribe: async () => ({ text: "" }) }),
    getTtsProfile: async () => ({ id: "tts", defaultVoice: "v" }),
    createTtsAdapter: async () => ({ name: "kokoro", async *synthesize(text) { spoken.push(text); yield Buffer.from(text); } }),
    createChatAdapter: async () => ({ async *chatStream(messages, tools) { const req = { messages: messages.map((m) => ({ ...m })), tools: tools.map((t) => t.name) }; requests.push(req); yield* script(req, requests.length); yield { type: "done" }; } }),
    resolveKey: async () => ({ baseUrl: "x" }), acquire: async () => null, probeReady: async () => false,
    contextLenFor: async () => 8192,
    chooseVoiceRoute: () => ({ route: "fast", reason: null, key: "voice/quick" }), fastKey: "voice/quick",
    getChatTools: () => [], createToolExecutor: () => ({ executeToolCalls: async () => [], close: async () => {} }), maxToolRounds: 10,
    effectiveToolName: (tc) => tc.name, isExternalSendTool: () => false, isConnectedAddonTool: () => false, botVoiceScope: () => null,
    generateSystemPrompt: async ({ botDef }) => botDef.system_prompt, isMemoryTool: () => false,
  });
  const device = { id: "kiosk-live", bound_bot_id: "house", kiosk_settings: { memory_integration: false } };
  const sink = { event: (e) => events.push(e), audio: () => {} };
  const ask = (transcript) => runner.runVoiceTurn({
    db: {}, device, sink, transcript,
    extraTools: [createWmTool({ store, deviceId: device.id, caps: null, emit: (ev) => sink.event(ev) })],
    fastPaths: async (t) => matchWmFastPath(t, store, device.id, null) || matchClockFastPath(t, { now: AT, tz: TZ }),
    promptSuffix: kioskPromptSuffix(),
    turnContext: `${kioskNowContext(AT, TZ)}\n${kioskTurnContext(store, device.id)}`,
    denyTools: KIOSK_DENY_TOOLS, maxToolRounds: KIOSK_MAX_TOOL_ROUNDS,
  });
  return { ask, requests, spoken, events, store, windows: () => store.list(device.id).map((w) => `${w.kind}:${w.title}`) };
}
const call = (command) => ({ type: "tool_call", id: "c", name: "crow_wm", arguments: { command } });
const text = (t) => ({ type: "content_delta", text: t });
const JOKE = "Why did the crow sit on the wire? To make a long-distance caw. ";

test("'Tell me a joke': the display tool is not offered, the answer is spoken in ONE model round, no card", async () => {
  const d = display(function* () { yield text(JOKE); });
  const r = await d.ask("Tell me a joke");
  assert.deepEqual(d.requests.map((q) => q.tools), [[]], "one round, crow_wm not offered");
  assert.equal(r.timings.tool_rounds, undefined);
  assert.equal(r.failed, null);
  assert.deepEqual(d.windows(), []);
  assert.ok(d.spoken.join(" ").includes("long-distance caw"));
});

test("'Tell me a joke' with a model that calls the display tool anyway (as the 4B did): no 'Info' card, the joke is still spoken", async () => {
  const d = display(function* (req, n) { if (n === 1) yield call(`display Info | ${JOKE}`); else yield text(JOKE); });
  const r = await d.ask("Tell me a joke");
  assert.deepEqual(d.windows(), [], "nothing was opened");
  assert.ok(!d.events.some((e) => e.type === "wm"), "nothing was sent to the page");
  assert.match(d.requests[1].messages.at(-1).content, /Answer the user aloud/);
  assert.equal(r.failed, null);
  assert.ok(d.spoken.join(" ").includes("long-distance caw"));
});

test("'What time is it?': answered from the display's clock with NO model call; never a placeholder card", async () => {
  const d = display(function* () { yield call("display <title> | <text> — || starts a paragraph; lines starting '- ' become a list"); });
  const r = await d.ask("What time is it?");
  assert.equal(r.fastPath, true);
  assert.equal(d.requests.length, 0, "no model call");
  assert.deepEqual(d.spoken, ["It's 3:42 PM."]);
  assert.deepEqual(d.windows(), []);
  const date = await d.ask("What's today's date?");
  assert.equal(date.fastPath, true);
  assert.equal(d.spoken.at(-1), "Today is Sunday, October 4, 2026.");
});

test("a clock question the fast path does not take reaches the model WITH the date, time and zone on the user message", async () => {
  const d = display(function* () { yield text("It is quarter to four, so two hours and fifteen minutes. "); });
  await d.ask("How long until six o'clock?");
  assert.equal(d.requests.length, 1);
  assert.deepEqual(d.requests[0].tools, []);
  assert.equal(d.requests[0].messages.at(-1).content, `[Now] Sunday, October 4, 2026, 3:42 PM (time zone America/Chicago)\n[Display] Open windows: none.\n${TURN_CONTEXT_NOTE}\n\nHow long until six o'clock?`);
  assert.doesNotMatch(d.requests[0].messages[0].content, /2026|3:42/, "never in the system message");
});

test("the placeholder card can no longer be opened even when the tool IS offered (a window is open)", async () => {
  const d = display(function* (req, n) {
    if (n === 1) yield call("display <title> | <text> — || starts a paragraph; lines starting '- ' become a list");
    else yield text("I can show things when you ask. ");
  });
  d.store.open("kiosk-live", { kind: "timer", name: "Check", title: "Check", seconds: 60 });
  await d.ask("show me something");
  assert.deepEqual(d.requests[0].tools, ["crow_wm"]);
  assert.deepEqual(d.windows(), ["timer:Check"], "no '<title>' card");
  assert.match(d.requests[1].messages.at(-1).content, /placeholder/);
  assert.doesNotMatch(JSON.stringify(d.requests[0]), /<title>|<text>/, "and the prompt no longer contains the placeholders to copy");
});

test("the timer still works ('set a timer for one minute and label it check'), and cards no longer pile up", async () => {
  const d = display(function* (req, n) {
    if (n === 1) yield call("timer 1 minute check");
    else if (n === 2) yield text("Your one minute timer is set. ");
    else if (n === 3) yield call("display Shopping list | milk, eggs");
    else if (n === 4) yield text("Here is the list. ");
    else if (n === 5) yield call("display Weather | Sunny all day");
    else yield text("Here is the weather. ");
  });
  const r = await d.ask("set a timer for one minute and label it check");
  assert.deepEqual(d.requests[0].tools, ["crow_wm"], "timer intent: the tool is offered");
  assert.equal(r.failed, null);
  assert.deepEqual(d.windows(), ["timer:Check"]);
  await d.ask("show me the shopping list");
  await d.ask("show me the weather");
  assert.deepEqual(d.windows(), ["timer:Check", "content:Weather"], "the new card replaced the old one");
  // While a window is open a plain question still gets the tool (follow-ups), but an echo card is refused.
  const before = d.requests.length;
  const e = display(function* (req, n) { if (n === 1) yield call(`display Info | ${JOKE}`); else yield text(JOKE); });
  e.store.open("kiosk-live", { kind: "timer", name: "Check", title: "Check", seconds: 60 });
  await e.ask("Tell me a joke");
  assert.deepEqual(e.requests[0].tools, ["crow_wm"]);
  assert.deepEqual(e.windows(), ["timer:Check"], "no echo card");
  assert.match(e.requests[1].messages.at(-1).content, /nobody asked to see anything/);
  assert.equal(d.requests.length, before);
});

test("live 2026-10-05, replayed: \"Okay.\" answered with the turn context read back — only the answer is spoken, captioned and kept", async () => {
  // The display's real context for this clock, echoed the way the quick model did, in small stream pieces.
  const ctx = "[Now] Sunday, October 4, 2026, 3:42 PM (time zone America/Chicago) [Display] Open windows: none. ";
  const answer = "Got it. Is there anything specific you'd like me to help with?";
  const reply = ctx + answer;
  const d = display(function* () { for (let i = 0; i < reply.length; i += 5) yield text(reply.slice(i, i + 5)); });
  const r = await d.ask("Okay.");
  assert.equal(r.failed, null);
  assert.equal(d.spoken.join(" "), answer);
  assert.equal(d.events.filter((e) => e.type === "caption_delta").map((e) => e.text).join(""), answer);
  assert.deepEqual(d.windows(), []);
  const second = await d.ask("Thanks.");
  assert.equal(second.failed, null);
  const history = d.requests.at(-1).messages.filter((m) => m.role === "assistant").map((m) => m.content);
  assert.ok(history.length >= 1 && history.every((c) => !/\[(Now|Display)\]/.test(c)), "the next turn's history carries no echo for the model to copy");
});
