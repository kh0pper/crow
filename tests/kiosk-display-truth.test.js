/**
 * Live re-test of kiosk 0.1.7 (2026-10-04), replayed through the REAL voice turn, the REAL
 * OpenAI-compatible chat adapter, and the REAL kiosk display tool, clock and memory gate.
 * Only the model server (fetch), STT and TTS are fakes. Two kinds of model server, as observed
 * on the two backends in use:
 *   honours  — a named tool_choice forces that call (the quick model's server);
 *   ignores  — tool_choice is accepted and ignored (the larger model's server).
 *
 * Evidence: (1) "Show me a list of three fruits." → no tool call, "I've displayed a list of
 * three fruits for you.", the old card stayed. (2) the same request on a paired display → one
 * crow_wm round, the old card stayed, a spoken list. (3) "What's today's date?" with memories
 * on → two memory calls, 11.5 s.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createVoiceTurnRunner } from "../servers/gateway/voice/turn.js";
import createOpenAIAdapter from "../servers/gateway/ai/adapters/openai.js";
import { createWmStore, createWmTool, matchWmFastPath, kioskPromptSuffix, kioskTurnContext } from "../bundles/kiosk/server/wm.js";
import { kioskNowContext, matchClockFastPath } from "../bundles/kiosk/server/clock.js";
import { wantsMemory } from "../bundles/kiosk/server/memory-intent.js";
import { KIOSK_DENY_TOOLS, KIOSK_MAX_TOOL_ROUNDS, kioskDisplayMissedText } from "../bundles/kiosk/server/runtime.js";
import { STRINGS } from "../bundles/kiosk/server/strings.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const AT = Date.UTC(2026, 9, 4, 20, 42, 10);
const TZ = "America/Chicago";

const sse = (chunks) => new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { status: 200 });
const textChunks = (text) => [{ choices: [{ index: 0, delta: { content: text } }] }, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }];
const callChunks = (name, command) => [
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name, arguments: JSON.stringify({ command }) } }] } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
];

/**
 * A display wired as the kiosk runtime wires it. model(request, n) plays the model's own choice
 * for request n: { say } or { call: command } (or { tool, args } for another tool).
 * server: "honours" → a named tool_choice overrides a { say } with the model's `forced` command.
 */
function display({ model, server = "ignores", forced = "display Fruits | apples, bananas, cherries", memories = false, lang = "en", botTools = [] }) {
  const requests = [];
  const spoken = [];
  const events = [];
  const logs = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    const named = body.tool_choice?.function?.name;
    const out = model(body, requests.length);
    if (server === "honours" && named) return sse(callChunks(named, out.call || forced));
    if (out.call) return sse(callChunks("crow_wm", out.call));
    if (out.tool) return sse([{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c2", type: "function", function: { name: out.tool, arguments: JSON.stringify(out.args || {}) } }] } }] }, { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }]);
    return sse(textChunks(out.say));
  };
  const store = createWmStore({ now: () => AT, setTimer: () => ({}), clearTimer: () => {} });
  const executed = [];
  const runner = createVoiceTurnRunner({
    log: (m) => logs.push(m), now: () => AT, sleep: async () => {},
    loadBotRow: async () => ({ bot_id: "house", enabled: 1, definition: JSON.stringify({ bot_id: "house", system_prompt: "You are a small household assistant." }) }),
    getSttProfile: async () => ({ id: "stt" }), createSttAdapter: async () => ({ transcribe: async () => ({ text: "" }) }),
    getTtsProfile: async () => ({ id: "tts", defaultVoice: "v" }),
    createTtsAdapter: async () => ({ name: "kokoro", async *synthesize(text) { spoken.push(text); yield Buffer.from(text); } }),
    createChatAdapter: async () => createOpenAIAdapter({ baseUrl: "http://203.0.113.1:9/v1", model: "voice-model" }),
    resolveKey: async () => ({ baseUrl: "x" }), acquire: async () => null, probeReady: async () => false,
    contextLenFor: async () => 8192,
    chooseVoiceRoute: () => ({ route: "fast", reason: null, key: "voice/quick" }), fastKey: "voice/quick",
    getChatTools: () => botTools.map((name) => ({ name, description: name, inputSchema: { type: "object", properties: { action: { type: "string" } } } })),
    createToolExecutor: () => ({ executeToolCalls: async (tcs) => { executed.push(...tcs.map((t) => t.name)); return tcs.map((t) => ({ id: t.id, name: t.name, result: "nothing found", isError: false })); }, close: async () => {} }),
    maxToolRounds: 10,
    effectiveToolName: (tc) => tc.name, isExternalSendTool: () => false, isConnectedAddonTool: () => false, botVoiceScope: () => null,
    generateSystemPrompt: async ({ botDef }) => botDef.system_prompt, isMemoryTool: (n) => n === "crow_memory",
  });
  const device = { id: "kiosk-live", bound_bot_id: "house", kiosk_settings: { memory_integration: memories, lang } };
  const sink = { event: (e) => events.push(e), audio: () => {} };
  const ask = (transcript) => runner.runVoiceTurn({
    db: {}, device, sink, transcript,
    extraTools: [createWmTool({ store, deviceId: device.id, caps: null, emit: (ev) => sink.event(ev) })],
    fastPaths: async (t) => matchWmFastPath(t, store, device.id, null) || matchClockFastPath(t, { now: AT, tz: TZ }),
    promptSuffix: kioskPromptSuffix(),
    turnContext: `${kioskNowContext(AT, TZ)}\n${kioskTurnContext(store, device.id)}`,
    denyTools: KIOSK_DENY_TOOLS, maxToolRounds: KIOSK_MAX_TOOL_ROUNDS,
    displayMissedText: kioskDisplayMissedText(lang), memoryWhen: wantsMemory,
  });
  const cards = () => store.list(device.id).map((w) => `${w.title}: ${w.blocks?.at(-1)?.text ?? ""}`);
  return { ask, requests, spoken, events, logs, store, cards, executed, wm: () => events.filter((e) => e.type === "wm").map((e) => `${e.action} ${e.id || e.window?.id}`) };
}
const said = (d) => d.spoken.join(" ");
const captions = (d) => d.events.filter((e) => e.type === "caption_delta").map((e) => e.text).join("");
const toolNames = (req) => (req.tools || []).map((t) => t.function.name);
const SHOPPING = "display Shopping list | milk, eggs, bread";
const FRUITS = "display Fruits | apples, bananas, cherries";

test("evidence (1), a server that ignores tool_choice: 'I've displayed a list…' with no call is never heard — the corrective round puts the list up and the old card goes", async () => {
  const d = display({ model: (body, n) => (n === 1 ? { call: SHOPPING } : n === 2 ? { say: "Your shopping list is up. " } : n === 3 ? { say: "I've displayed a list of three fruits for you. " } : n === 4 ? { call: FRUITS } : { say: "Three fruits are on the screen. " }) });
  await d.ask("Show me a shopping list with milk, eggs and bread.");
  assert.deepEqual(d.cards(), ["Shopping list: milk, eggs, bread"]);
  d.spoken.length = 0; d.events.length = 0;
  const r = await d.ask("Show me a list of three fruits.");
  assert.deepEqual(d.cards(), ["Fruits: apples, bananas, cherries"], "the list really is on the screen");
  assert.deepEqual(d.wm(), ["close content-1", "open content-2"], "and the page was told: old card closed, new one opened");
  assert.doesNotMatch(said(d) + captions(d), /I've displayed/, "the claim made before anything was shown was neither spoken nor captioned");
  assert.equal(said(d), "Three fruits are on the screen.");
  assert.equal(r.failed, null);
  assert.equal(r.timings.display_corrected, true);
  assert.deepEqual(r.timings.tools, ["crow_wm:ok"]);
  // What went over the wire: the display tool was required by name (this server ignored it), and
  // the corrective request carries the note on the user message — not the false claim.
  const [first, corrective] = [d.requests[2], d.requests[3]];
  assert.deepEqual(first.tool_choice, { type: "function", function: { name: "crow_wm" } });
  assert.deepEqual(toolNames(first), ["crow_wm"]);
  assert.deepEqual(corrective.tool_choice, { type: "function", function: { name: "crow_wm" } });
  assert.equal(corrective.messages.at(-1).role, "user");
  assert.match(corrective.messages.at(-1).content, /Show me a list of three fruits\.\n\n\[Display\] Nothing has been put on the screen in this turn yet\. Call crow_wm now/);
  assert.ok(!corrective.messages.some((m) => /I've displayed/.test(String(m.content))));
  assert.equal(d.requests[4].tool_choice, undefined, "once it is up, the confirmation round is free");
});

test("evidence (1), the model claims it twice: the turn ends on the truthful line (in the display's language), the old card stays, display_missed is recorded", async () => {
  const d = display({ lang: "es", model: (body, n) => (n === 1 ? { call: SHOPPING } : n === 2 ? { say: "Listo. " } : { say: "I've displayed a list of three fruits for you. " }) });
  await d.ask("Show me a shopping list with milk, eggs and bread.");
  d.spoken.length = 0; d.events.length = 0;
  const r = await d.ask("Show me a list of three fruits.");
  assert.equal(d.requests.length, 4, "the first answer and ONE corrective round");
  assert.deepEqual(d.spoken, [STRINGS.es.display_missed_say]);
  assert.equal(captions(d), STRINGS.es.display_missed_say);
  assert.deepEqual(d.cards(), ["Shopping list: milk, eggs, bread"]);
  assert.deepEqual(d.wm(), []);
  assert.equal(r.failed, "display_missed");
  assert.equal(r.timings.display_missed, true);
  assert.ok(d.logs.some((l) => /turn failed \(display_missed\)/.test(l)));
  assert.ok(!d.logs.some((l) => /fruits|displayed/i.test(l)), "the log has outcomes, never what was said");
});

test("evidence (1), a server that honours tool_choice: the display call is forced in the first round even though the model wanted to just say it", async () => {
  const d = display({ server: "honours", forced: FRUITS, model: (body, n) => (n === 1 ? { say: "I've displayed a list of three fruits for you. " } : { say: "Here are three fruits. " }) });
  const r = await d.ask("Show me a list of three fruits.");
  assert.equal(d.requests.length, 2, "forced call, then the confirmation: no corrective round needed");
  assert.deepEqual(d.requests[0].tool_choice, { type: "function", function: { name: "crow_wm" } });
  assert.deepEqual(d.cards(), ["Fruits: apples, bananas, cherries"]);
  assert.equal(said(d), "Here are three fruits.");
  assert.equal(r.timings.tool_choice, "named");
  assert.equal(r.timings.display_corrected, undefined);
  assert.equal(r.failed, null);
});

test("evidence (2), a malformed first command: the error names the form to use, the retry replaces the card, and the log says what happened without the content", async () => {
  const d = display({ model: (body, n) => (n === 1 ? { call: SHOPPING } : n === 2 ? { say: "Your shopping list is up. " } : n === 3 ? { call: "add apples, bananas and cherries to Shopping list" } : n === 4 ? { call: FRUITS } : { say: "Here is a list of three fruits. " }) });
  await d.ask("Show me a shopping list with milk, eggs and bread.");
  d.spoken.length = 0; d.events.length = 0;
  const r = await d.ask("Show me a list of three fruits.");
  assert.deepEqual(d.cards(), ["Fruits: apples, bananas, cherries"], "the card was replaced");
  assert.deepEqual(d.wm(), ["close content-1", "open content-2"]);
  assert.deepEqual(r.timings.tools, ["crow_wm:unknown_command", "crow_wm:ok"]);
  assert.equal(r.failed, null);
  assert.equal(said(d), "Here is a list of three fruits.");
  // The retry request: the model was told exactly which form to use.
  const toolResult = d.requests[3].messages.at(-1);
  assert.equal(toolResult.role, "tool");
  assert.match(toolResult.content, /unknown_command/);
  assert.match(toolResult.content, /display Shopping list \| milk, eggs, bread/);
  assert.ok(d.logs.some((l) => /kiosk-live round 1: crow_wm:unknown_command$/.test(l)));
  assert.ok(d.logs.some((l) => /kiosk-live round 2: crow_wm:ok$/.test(l)));
  assert.ok(!d.logs.some((l) => /apples|Shopping/i.test(l)), "no command text in the log");
});

test("evidence (2), the retry is malformed too: no third attempt — the truthful line, and the old card is untouched", async () => {
  const d = display({ model: (body, n) => (n === 1 ? { call: SHOPPING } : n === 2 ? { say: "Up. " } : { call: "show Fruits | apples" }) });
  await d.ask("Show me a shopping list with milk, eggs and bread.");
  d.spoken.length = 0;
  const r = await d.ask("Show me a list of three fruits.");
  assert.equal(d.requests.length, 4, "two attempts, no wasted answer round");
  assert.deepEqual(d.spoken, [STRINGS.en.display_missed_say]);
  assert.deepEqual(d.cards(), ["Shopping list: milk, eggs, bread"]);
  assert.equal(r.failed, "display_missed");
  assert.deepEqual(r.timings.tools, ["crow_wm:unknown_command", "crow_wm:unknown_command"]);
});

test("evidence (3), memories ON: 'What's today's date?' (and its variants) is the shortcut — no model call, no memory call", async () => {
  for (const q of ["What's today's date?", "What is today's date?", "What’s today’s date", "Hey, what's the date today?", "What day is it?"]) {
    const d = display({ memories: true, botTools: ["crow_memory"], model: () => ({ tool: "crow_memory", args: { action: "search_memories" } }) });
    const r = await d.ask(q);
    assert.equal(d.requests.length, 0, `${q}: no model call`);
    assert.equal(r.fastPath, true);
    assert.deepEqual(d.spoken, ["Today is Sunday, October 4, 2026."], q);
    assert.deepEqual(d.executed, []);
  }
});

test("evidence (3), memories ON, a plain question that does reach the model: the memory tool is not offered and a forced memory call never runs; asking to recall offers it", async () => {
  const d = display({ memories: true, botTools: ["crow_memory"], model: (body, n) => (n === 1 ? { tool: "crow_memory", args: { action: "search_memories" } } : { say: "It is quarter to four, so two hours and a quarter. " }) });
  const r = await d.ask("How long until six o'clock?");
  assert.deepEqual(toolNames(d.requests[0]), [], "one model round would have been enough: nothing to call");
  assert.deepEqual(d.executed, []);
  assert.deepEqual(r.timings.tools, ["crow_memory:not_offered"]);
  assert.equal(r.failed, null);
  const m = display({ memories: true, botTools: ["crow_memory"], model: (body, n) => (n === 1 ? { tool: "crow_memory", args: { action: "search_memories" } } : { say: "I have nothing saved about that. " }) });
  const rm = await m.ask("Do you remember the wifi password?");
  assert.deepEqual(toolNames(m.requests[0]), ["crow_memory"]);
  assert.deepEqual(m.executed, ["crow_memory"]);
  assert.deepEqual(rm.timings.tools, ["crow_memory:ok"]);
});

test("unchanged: a plain question on a display with a card open is spoken in one round, and 'close that' needs no display call", async () => {
  const d = display({ model: (body, n) => (n === 1 ? { call: SHOPPING } : n === 2 ? { say: "Up. " } : { say: "Why did the crow sit on the wire? To make a long-distance caw. " }) });
  await d.ask("Show me a shopping list with milk, eggs and bread.");
  d.spoken.length = 0;
  const r = await d.ask("Tell me a joke");
  assert.equal(d.requests.length, 3);
  assert.equal(d.requests[2].tool_choice, undefined, "a card being open never makes the display tool mandatory");
  assert.match(said(d), /long-distance caw/);
  assert.equal(r.timings.display_missed, undefined);
  const before = d.requests.length;
  const c = await d.ask("close that");
  assert.equal(c.fastPath, true);
  assert.equal(d.requests.length, before);
  assert.deepEqual(d.cards(), []);
});
