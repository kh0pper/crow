/**
 * The three findings of the 2026-10-04 live tests, replayed on the four-tool surface: a claimed
 * action with no call, a malformed display call, a plain question that went to a tool. The REAL
 * voice turn, adapter, display tools, executor, clock and fast paths; only the model server, STT
 * and TTS are scripted.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createVoiceTurnRunner } from "../servers/gateway/voice/turn.js";
import createOpenAIAdapter from "../servers/gateway/ai/adapters/openai.js";
import { createToolFamilies } from "../servers/gateway/voice/tool-families.js";
import { createWmStore, wantsNewDisplay } from "../bundles/kiosk/server/wm.js";
import { createDisplayTools, cardUpdate } from "../bundles/kiosk/server/display-tools.js";
import { matchSpoken } from "../bundles/kiosk/server/tiers.js";
import { matchWmFastPath } from "../bundles/kiosk/server/wm.js";
import { displayPromptSuffix, displayTurnContext } from "../bundles/kiosk/server/prompt.js";
import { kioskNowContext, matchClockFastPath } from "../bundles/kiosk/server/clock.js";
import { wantsMemory } from "../bundles/kiosk/server/memory-intent.js";
import { KIOSK_DENY_TOOLS, KIOSK_MAX_TOOL_ROUNDS, kioskDisplayMissedText } from "../bundles/kiosk/server/runtime.js";

const AT = Date.UTC(2026, 9, 4, 20, 42, 10);
const TZ = "America/Chicago";
const CAPS = { windows: ["timer", "recipe", "content"], max_windows: 4, screen: { w: 800, h: 480, touch: true }, audio: { out: true }, video: "none" };
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const sse = (chunks) => new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { status: 200 });
const text = (t) => [{ choices: [{ index: 0, delta: { content: t } }] }, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }];
const call = (name, args, say = "") => [...(say ? [{ choices: [{ index: 0, delta: { content: say } }] }] : []), { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] }, { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }];
const FRUITS = { kind: "list", title: "Fruits", body: "apples\nbananas\ncherries" };

/** model(body, n) → { say } | { tool, args } | { say, tool, args } (text, then the call, in one round). forcing: what the engine honours ("named" = a vLLM-like server that obeys a named choice). */
function display({ model, forcing = "none", memories = false, lang = "en", botTools = [], media = null }) {
  const requests = [], spoken = [], events = [], logs = [], executed = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    const named = body.tool_choice?.function?.name;
    const out = model(body, requests.length);
    if (forcing === "named" && named) return sse(call(named, out.args || FRUITS));
    return out.tool ? sse(call(out.tool, out.args || {}, out.say)) : sse(text(out.say));
  };
  const store = createWmStore({ now: () => AT, setTimer: () => ({}), clearTimer: () => {} });
  const runner = createVoiceTurnRunner({
    log: (m) => logs.push(m), now: () => AT, sleep: async () => {},
    loadBotRow: async () => ({ bot_id: "house", enabled: 1, definition: JSON.stringify({ bot_id: "house", system_prompt: "You are a small household assistant." }) }),
    getSttProfile: async () => ({ id: "stt" }), createSttAdapter: async () => ({ transcribe: async () => ({ text: "" }) }),
    getTtsProfile: async () => ({ id: "tts", defaultVoice: "v" }),
    createTtsAdapter: async () => ({ name: "kokoro", async *synthesize(t) { spoken.push(t); yield Buffer.from(t); } }),
    createChatAdapter: async () => createOpenAIAdapter({ baseUrl: "http://203.0.113.1:9/v1", model: "voice-model" }),
    resolveKey: async () => ({ baseUrl: "x" }), acquire: async () => null, probeReady: async () => false,
    contextLenFor: async () => 8192,
    chooseVoiceRoute: () => ({ route: "fast", reason: null, key: "voice/quick" }), fastKey: "voice/quick",
    getChatTools: () => botTools.map((name) => ({ name, description: name, inputSchema: { type: "object", properties: { action: { type: "string" } } } })),
    createToolExecutor: () => ({ executeToolCalls: async (tcs) => { executed.push(...tcs.map((t) => t.name)); return tcs.map((t) => ({ id: t.id, name: t.name, result: "nothing found", isError: false })); }, close: async () => {} }),
    maxToolRounds: 10,
    effectiveToolName: (tc) => tc.name, isExternalSendTool: () => false, isConnectedAddonTool: () => false, botVoiceScope: () => null,
    generateSystemPrompt: async ({ botDef }) => botDef.system_prompt, isMemoryTool: (n) => n === "crow_memory",
    toolForcing: async () => ({ named: forcing === "named", required: forcing === "named", engine: forcing === "named" ? "vllm" : "llamacpp" }),
    toolFamilies: createToolFamilies({ manifests: { memory: { tools: {} }, projects: { tools: {}, voiceIntent: { en: ["project", "projects"] } }, sharing: { tools: {}, voiceIntent: { en: ["message", "messages"] } } } }),
  });
  const device = { id: "kiosk-live", bound_bot_id: "house", kiosk_settings: { memory_integration: memories, lang } };
  const sink = { event: (e) => events.push(e), audio: () => {} };
  const ctx = { store, deviceId: device.id, caps: CAPS, lang, sources: [], items: [], emit: (ev) => sink.event(ev), ...(media ? media(device.id) : {}) };
  const ask = (transcript) => runner.runVoiceTurn({
    db: {}, device, sink, transcript,
    extraTools: createDisplayTools(ctx),
    fastPaths: async (t) => (await matchSpoken(t, ctx)) || matchWmFastPath(t, store, device.id, CAPS) || matchClockFastPath(t, { now: AT, tz: TZ }),
    promptSuffix: displayPromptSuffix(CAPS),
    turnContext: (t) => `${kioskNowContext(AT, TZ)}\n${displayTurnContext(store, device.id, { countsOnly: wantsNewDisplay(t), card: cardUpdate(t, store, device.id) !== null })}`,
    denyTools: KIOSK_DENY_TOOLS, maxToolRounds: KIOSK_MAX_TOOL_ROUNDS, familiesOnIntent: true,
    displayMissedText: kioskDisplayMissedText(lang), memoryWhen: wantsMemory,
  });
  const cards = () => store.list(device.id).map((w) => `${w.kind}:${w.title}`);
  return { ask, requests, spoken, events, logs, store, cards, executed, ctx };
}
const said = (d) => d.spoken.join(" ");
const captions = (d) => d.events.filter((e) => e.type === "caption_delta").map((e) => e.text).join("");
const toolNames = (req) => (req.tools || []).map((t) => t.function.name);

test("evidence (1), an engine that honours nothing: 'I've displayed a list…' with no call is never heard — the corrective round puts the list up and the turn ends on the server's line", async () => {
  const d = display({ model: (body, n) => (n === 1 ? { say: "I've displayed a list of three fruits for you." } : { tool: "crow_show", args: FRUITS }) });
  const r = await d.ask("Show me a list of three fruits.");
  assert.equal(d.requests.length, 2, "the claim, then the corrective round — and NO third round: the result was final");
  assert.equal(d.requests[0].tool_choice, undefined, "nothing is forced on this engine");
  assert.deepEqual(toolNames(d.requests[0]), ["crow_show"], "only the must-run tool is offered");
  assert.match(d.requests[1].messages.at(-1).content, /Call crow_show now/);
  assert.equal(said(d), "Here's Fruits.");
  assert.equal(captions(d), "Here's Fruits.");
  assert.deepEqual(d.cards(), ["content:Fruits"]);
  assert.equal(r.failed, null);
  assert.equal(r.timings.display_corrected, true);
  assert.equal(r.timings.final, "crow_show:shown");
});

test("evidence (1), the model claims it twice: the truthful line in the display's language, nothing on the screen, display_missed", async () => {
  const d = display({ lang: "es", model: () => ({ say: "Listo, ya está en la pantalla." }) });
  const r = await d.ask("Muéstrame una lista de tres frutas.");
  assert.equal(said(d), "Lo siento, no pude ponerlo en la pantalla.");
  assert.deepEqual(d.cards(), []);
  assert.equal(r.failed, "display_missed");
  assert.equal(d.requests.length, 2);
});

test("evidence (1), an engine that honours a named choice: crow_show is forced in the first request and the turn ends after ONE model request", async () => {
  const d = display({ forcing: "named", model: () => ({ say: "I've displayed it." }) });
  const r = await d.ask("Show me a list of three fruits.");
  assert.equal(d.requests.length, 1);
  assert.deepEqual(d.requests[0].tool_choice, { type: "function", function: { name: "crow_show" } });
  assert.deepEqual(toolNames(d.requests[0]), ["crow_show"]);
  assert.equal(said(d), "Here's Fruits.");
  assert.equal(r.timings.tool_choice, "named");
  assert.ok(d.requests.every((b) => b.tool_choice !== "required"));
});

test("evidence (2), a placeholder title: refused with the fix, one retry shows the card, and the log says what happened without the content", async () => {
  const d = display({ model: (body, n) => (n === 1 ? { tool: "crow_show", args: { kind: "list", title: "<title>", body: "apples" } } : { tool: "crow_show", args: FRUITS }) });
  const r = await d.ask("Show me a list of three fruits.");
  assert.deepEqual(r.timings.tools, ["crow_show:placeholder", "crow_show:shown"]);
  assert.match(d.requests[1].messages.at(-1).content, /Call crow_show again now with the real words/);
  assert.deepEqual(d.cards(), ["content:Fruits"]);
  assert.ok(!d.logs.join("\n").includes("apples"), "no argument text in the log");
  assert.equal(said(d), "Here's Fruits.");
});

test("evidence (2), the retry is a placeholder too: the truthful line, and an old card is untouched", async () => {
  const d = display({ model: (body, n) => (n === 1 ? { tool: "crow_show", args: { kind: "list", title: "Shopping", body: "milk\neggs" } } : { tool: "crow_show", args: { kind: "list", title: "Title", body: "x" } }) });
  await d.ask("Show me the shopping list.");
  const r = await d.ask("Show me a list of three fruits.");
  assert.equal(r.failed, "display_missed");
  assert.deepEqual(d.cards(), ["content:Shopping"]);
  assert.equal(d.spoken.at(-1), "Sorry, I couldn't put that on the screen.");
});

test("evidence (3), memories ON: the date is the shortcut; a plain question is offered no tool at all; a forced card on it is refused; asking to recall offers memory", async () => {
  const d = display({ memories: true, botTools: ["crow_memory", "crow_projects"], model: () => ({ say: "Lisbon." }) });
  const date = await d.ask("What's today's date?");
  assert.equal(date.fastPath, true);
  assert.equal(d.requests.length, 0);
  const plain = await d.ask("What is the capital of Portugal?");
  assert.deepEqual(toolNames(d.requests[0]), []);
  assert.equal(d.requests[0].tools, undefined, "no tools key at all: the shortest prompt");
  assert.equal(plain.timings.tools_offered, 0);
  await d.ask("What did I tell you about the wifi?");
  assert.deepEqual(toolNames(d.requests[1]), ["crow_memory"]);
  const forced = display({ model: (body, n) => (n === 1 ? { tool: "crow_show", args: { kind: "text", title: "Portugal", body: "Lisbon" } } : { say: "Lisbon." }) });
  const r = await forced.ask("What is the capital of Portugal?");
  assert.deepEqual(r.timings.tools, ["crow_show:not_offered"], "a tool that was not offered is never run");
  assert.deepEqual(forced.cards(), []);
});

test("titles: the same title updates that card; a new subject on a new-content turn sees kinds and counts only", async () => {
  const d = display({ forcing: "named", model: (body, n) => ({ say: "ok", args: n === 1 ? FRUITS : n === 2 ? { ...FRUITS, body: "apples\nbananas\ncherries\ngrapes" } : { kind: "list", title: "Vegetables", body: "carrot\npea" } }) });
  await d.ask("Show me a list of three fruits.");
  const up = await d.ask("Show me the fruits list with grapes added.");
  assert.equal(up.timings.final, "crow_show:updated");
  assert.equal(d.spoken.at(-1), "I updated Fruits.");
  assert.deepEqual(d.cards(), ["content:Fruits"]);
  await d.ask("Now show me a list of vegetables.");
  assert.match(d.requests[2].messages.at(-1).content, /\[Display\] Open windows: 1 card\.\n\[Note\] [^\n]*\n\nNow show me/);
  assert.doesNotMatch(d.requests[2].messages.at(-1).content, /Fruits/);
  assert.deepEqual(d.cards(), ["content:Vegetables"]);
});

test("crow_show kinds: steps with the dashes line become a recipe; a timer is set and named; a one-line comma list is split; Spanish lines on a Spanish display", async () => {
  const d = display({ forcing: "named", lang: "es", model: (body, n) => ({ say: "ok", args: n === 1 ? { kind: "steps", title: "Guacamole", body: "aguacate\nlimón\n---\n1. Machaca el aguacate\n2. Añade el limón" } : n === 2 ? { kind: "timer", title: "arroz", body: "12 minutes" } : { kind: "list", title: "Compras", body: "leche, huevos, pan" } }) });
  await d.ask("Muéstrame una receta de guacamole.");
  const rec = d.store.list("kiosk-live").find((w) => w.kind === "recipe");
  assert.deepEqual([rec.ingredients, rec.steps], [["aguacate", "limón"], ["Machaca el aguacate", "Añade el limón"]]);
  assert.equal(d.spoken.at(-1), "Aquí está Guacamole. Di siguiente paso cuando quieras.");
  await d.ask("Pon un temporizador de doce minutos para el arroz.");
  assert.equal(d.spoken.at(-1), "Temporizador Arroz: 12 minutos.");
  await d.ask("Muéstrame la lista de compras.");
  assert.deepEqual(d.store.list("kiosk-live").find((w) => w.kind === "content").blocks[1].items, ["leche", "huevos", "pan"]);
});

test("crow_wm: the do form closes by kind and says so; nothing open is a success; the K1 command form is still accepted and keeps its K1 result", async () => {
  const d = display({ model: () => ({ say: "ok" }) });
  const wm = createDisplayTools(d.ctx).find((t) => t.definition.name === "crow_wm");
  d.store.open("kiosk-live", { kind: "timer", name: "Rice", title: "Rice", seconds: 600 });
  assert.deepEqual(JSON.parse(await wm.execute({ do: "close", name: "timer" }, { transcript: "get rid of the timer" })), { ok: true, outcome: "done", say: "Timer stopped.", final: true });
  assert.deepEqual(JSON.parse(await wm.execute({ do: "close" }, { transcript: "close it" })), { ok: true, outcome: "nothing_open", say: "Nothing is open.", final: true, effect: false });
  assert.equal(JSON.parse(await wm.execute({ do: "explode" }, {})).reason, "bad_argument");
  const legacy = JSON.parse(await wm.execute({ command: "timer 10 minutes pasta" }, {}));
  assert.deepEqual([legacy.ok, legacy.code, legacy.action, legacy.kind], [true, "ok", "open", "timer"]);
  const refused = JSON.parse(await wm.execute({ command: "timer 5 minutes eggs" }, { transcript: "Set a timer for five minutes." }));
  assert.deepEqual([refused.ok, refused.reason, refused.final], [false, "use_crow_show", false], "on a turn that has to end with a card, the K1 form is sent back to crow_show");
  assert.equal(JSON.parse(await wm.execute({ command: "close" }, {})).ok, true);
  assert.deepEqual(JSON.parse(await wm.execute({ command: "close" }, {})), { action: "error", code: "nothing_open", message: "Nothing like that is open." }, "the K1 form keeps the K1 result");
  assert.deepEqual(d.events.filter((e) => e.type === "wm").map((e) => e.action), ["close", "open", "close"]);
});

test("the dormant tools: with a source and an item they are offered, forced on the quick model without the router, and an argument outside the enumeration never reaches the executor as given", async () => {
  const d = display({ forcing: "named", model: () => ({ say: "ok", args: { app: "https://evil.example/" } }) });
  Object.assign(d.ctx, { sources: ["radio"], items: [{ id: "now_playing", title: "Now playing" }] });
  const r = await d.ask("Open the lab dashboard.");
  assert.deepEqual(toolNames(d.requests[0]), ["crow_open"]);
  assert.equal(r.timings.final, "crow_open:unavailable");
  assert.equal(said(d), "I can't open that on this display.");
  const p = await d.ask("Play some jazz.");
  assert.deepEqual(toolNames(d.requests[1]), ["crow_play"]);
  assert.equal(p.timings.final, "crow_play:unavailable");
  assert.equal(p.route, "fast");
});

// ── What the display hears when a result is final and the model also spoke ──────────────────────
test("a claim before a call that did nothing is never heard: on a turn that asks the display for something, text is held until the call's result is known", async () => {
  const d = display({ model: () => ({ say: "Okay, I have closed the pasta timer for you.", tool: "crow_wm", args: { do: "close", name: "pasta timer" } }) });
  d.store.open("kiosk-live", { kind: "timer", name: "Rice", title: "Rice", seconds: 600 });
  const r = await d.ask("Close the pasta timer.");
  assert.equal(said(d), "Nothing like that is open.");
  assert.equal(captions(d), "Nothing like that is open.");
  assert.equal(r.timings.final, "crow_wm:nothing_open");
  assert.deepEqual(d.cards(), ["timer:Rice"], "nothing was closed, and nobody was told otherwise");
  assert.equal(d.requests.length, 1);
});

test("the model spoke on a turn with no display word, then its call did nothing: the server's line is spoken as well, so the turn never ends on the claim", async () => {
  const d = display({ model: () => ({ say: "Done, the pasta timer is closed.", tool: "crow_wm", args: { do: "close", name: "pasta timer" } }) });
  d.store.open("kiosk-live", { kind: "timer", name: "Rice", title: "Rice", seconds: 600 });
  await d.ask("I'm finished with the pasta one.");
  assert.deepEqual(toolNames(d.requests[0]), ["crow_show", "crow_wm"], "a window is open: both display tools (revision 4)");
  assert.match(said(d), /Nothing like that is open\.$/, "the last thing heard is what really happened");
  assert.deepEqual(d.cards(), ["timer:Rice"]);
});

test("the model spoke a sentence and its call DID work: the server's line is not said on top of it", async () => {
  const d = display({ model: () => ({ say: "Sure, closing that now.", tool: "crow_wm", args: { do: "close" } }) });
  d.store.open("kiosk-live", { kind: "content", title: "Fruits", blocks: [] });
  const r = await d.ask("I'm done with that one.");
  assert.equal(said(d), "Sure, closing that now.");
  assert.equal(r.timings.final, "crow_wm:done");
  assert.deepEqual(d.cards(), []);
});

// ── Compound requests and must-run turns ─────────────────────────────────────────────────────────
test("a compound request is not cut after its first action: the timer closes, the list goes up, and the model finishes the sentence (as 0.1.8 did)", async () => {
  const d = display({ model: (body, n) => (n === 1 ? { tool: "crow_wm", args: { do: "close", name: "timer" } } : n === 2 ? { tool: "crow_show", args: FRUITS } : { say: "The timer is off and your list is up." }) });
  d.store.open("kiosk-live", { kind: "timer", name: "Rice", title: "Rice", seconds: 600 });
  const r = await d.ask("Close the timer and then show me a list of three fruits.");
  assert.deepEqual(toolNames(d.requests[0]).sort(), ["crow_show", "crow_wm"], "not narrowed to one tool: both halves are possible in the first round");
  assert.equal(d.requests[0].tool_choice, undefined, "and nothing is forced while two tools are on offer");
  assert.equal(r.timings.tool_choice, "none");
  assert.deepEqual(r.timings.tools, ["crow_wm:done", "crow_show:shown"]);
  assert.deepEqual(d.cards(), ["content:Fruits"]);
  assert.equal(said(d), "Timer stopped. Here's Fruits.", "the turn ends on the server's lines for what was done, not on the model's own sentence");
  assert.equal(r.failed, null);
  assert.equal(r.timings.final, undefined, "no result ended the turn early");
});

test("a compound request whose second half never happens still ends truthfully", async () => {
  const d = display({ model: (body, n) => (n === 1 ? { tool: "crow_wm", args: { do: "close", name: "timer" } } : { say: "All done, the list is on the screen." }) });
  d.store.open("kiosk-live", { kind: "timer", name: "Rice", title: "Rice", seconds: 600 });
  const r = await d.ask("Close the timer and then show me a list of three fruits.");
  assert.equal(r.failed, "display_missed");
  assert.equal(d.spoken.at(-1), "Sorry, I couldn't put that on the screen.");
  assert.ok(!said(d).includes("All done"), "the claim was held back, never spoken");
  assert.deepEqual(r.timings.tools.slice(0, 1), ["crow_wm:done"]);
  assert.deepEqual(d.cards(), []);
});

test("a final result from ANOTHER tool does not end a turn that has to show something: no card means the could-not line", async () => {
  const d = display({ botTools: ["crow_projects"], model: () => ({ tool: "crow_wm", args: { do: "close" } }) });
  const r = await d.ask("Show me a list of my projects.");
  assert.deepEqual(toolNames(d.requests[0]).sort(), ["crow_projects", "crow_show", "crow_wm"], "another family is on offer, so the round is not narrowed");
  assert.equal(r.failed, "display_missed");
  assert.equal(d.spoken.at(-1), "Sorry, I couldn't put that on the screen.");
  assert.ok(!said(d).includes("Nothing is open."), "the other tool's line did not stand in for the card");
  assert.deepEqual(d.cards(), []);
});

test("the K1 command form on a turn that has to show a card is sent back to crow_show, so the card that goes up counts", async () => {
  const d = display({ model: (body, n) => (n === 1 ? { tool: "crow_wm", args: { command: "display Fruits | apples" } } : { tool: "crow_show", args: FRUITS }) });
  const r = await d.ask("Show me a list of three fruits.");
  assert.deepEqual(r.timings.tools, ["crow_wm:use_crow_show", "crow_show:shown"]);
  assert.equal(said(d), "Here's Fruits.");
  assert.equal(r.failed, null);
});

// ── What is offered ──────────────────────────────────────────────────────────────────────────────
test("a plain question while a window is open is offered both display tools, never required or forced (revision 4: follow-ups need no display word); with no window, no tool at all", async () => {
  const d = display({ forcing: "named", model: () => ({ say: "Lisbon." }) });
  d.store.open("kiosk-live", { kind: "timer", name: "Rice", title: "Rice", seconds: 600 });
  const r = await d.ask("What is the capital of Portugal?");
  assert.deepEqual(toolNames(d.requests[0]), ["crow_show", "crow_wm"]);
  assert.equal(d.requests[0].tool_choice, undefined);
  assert.equal(r.timings.tools_offered, 2);
  assert.equal(said(d), "Lisbon.");
  d.store.closeAll("kiosk-live");
  const empty = await d.ask("What is the capital of Portugal?");
  assert.equal(d.requests[1].tools, undefined);
  assert.equal(empty.timings.tools_offered, 0);
});

test("a tool family that is not on offer is never run on a display turn either", async () => {
  const d = display({ botTools: ["crow_projects", "crow_sharing"], model: (body, n) => (n === 1 ? { tool: "crow_sharing", args: { action: "send_message" } } : { say: "Lisbon." }) });
  const r = await d.ask("What is the capital of Portugal?");
  assert.deepEqual(d.executed, []);
  assert.deepEqual(r.timings.tools, ["crow_sharing:not_offered"]);
  assert.equal(said(d), "Lisbon.");
});

// ── Requests the 0.1.8 word lists missed ─────────────────────────────────────────────────────────
test("Spanish 'me muestras los pasos…' is a display request: a claim with no call is never heard, and a real call shows the steps", async () => {
  const claim = display({ lang: "es", model: () => ({ say: "Claro, aquí tienes los pasos en la pantalla." }) });
  const r = await claim.ask("¿Me muestras los pasos para hacer panqueques?");
  assert.deepEqual(toolNames(claim.requests[0]), ["crow_show"]);
  assert.equal(said(claim), "Lo siento, no pude ponerlo en la pantalla.");
  assert.equal(r.failed, "display_missed");
  const ok = display({ lang: "es", model: () => ({ tool: "crow_show", args: { kind: "steps", title: "Panqueques", body: "harina\nhuevos\n---\nMezcla\nCocina" } }) });
  await ok.ask("¿Me muestras los pasos para hacer panqueques?");
  assert.deepEqual(ok.cards(), ["recipe:Panqueques"]);
  assert.equal(said(ok), "Aquí está Panqueques. Di siguiente paso cuando quieras.");
});

test("changing the open card needs no display word: the model is shown the card's words, a call under its title updates it, another title is sent back with the title to use", async () => {
  const d = display({ model: (body, n) => (n === 1 ? { tool: "crow_show", args: { kind: "list", title: "Shopping", body: "grapes" } } : { tool: "crow_show", args: { kind: "list", title: "Fruits", body: "apples\nbananas\ncherries\ngrapes" } }) });
  d.store.open("kiosk-live", { kind: "content", title: "Fruits", blocks: [{ type: "heading", text: "Fruits" }, { type: "list", items: ["apples", "bananas", "cherries"] }] });
  const r = await d.ask("Add grapes to the fruits list.");
  assert.deepEqual(toolNames(d.requests[0]), ["crow_show"], "must-run, so only crow_show in the first round");
  assert.match(d.requests[0].messages.at(-1).content, /The card "Fruits" now says: apples; bananas; cherries\. To change it, call crow_show with that same title/);
  assert.deepEqual(r.timings.tools, ["crow_show:update_title", "crow_show:updated"]);
  assert.match(d.requests[1].messages.at(-1).content, /exactly its title, Fruits, and the whole new body/);
  assert.equal(said(d), "I updated Fruits.");
  assert.deepEqual(d.store.list("kiosk-live")[0].blocks[1].items, ["apples", "bananas", "cherries", "grapes"]);
  const claim = display({ model: () => ({ say: "I have added grapes to the list." }) });
  claim.store.open("kiosk-live", { kind: "content", title: "Fruits", blocks: [{ type: "heading", text: "Fruits" }, { type: "list", items: ["apples"] }] });
  const c = await claim.ask("Add grapes to the fruits list.");
  assert.equal(c.failed, "display_missed");
  assert.equal(claim.spoken.at(-1), "Sorry, I couldn't put that on the screen.");
});

test("offered is wider than must-run for play and open: a question about music is offered the tool and nothing is required", async () => {
  const d = display({ model: () => ({ say: "I do, especially in the kitchen." }) });
  Object.assign(d.ctx, { sources: ["music"], items: [{ id: "lab_dashboard", title: "Lab dashboard" }] });
  const q = await d.ask("Do you like music?");
  assert.deepEqual(toolNames(d.requests[0]), ["crow_play"]);
  assert.equal(d.requests[0].tool_choice, undefined);
  assert.equal(said(d), "I do, especially in the kitchen.", "text on such a turn is released once the round made no call");
  assert.equal(q.failed, null);
  const need = display({ forcing: "named", model: () => ({ say: "ok", args: { app: "lab_dashboard" } }) });
  Object.assign(need.ctx, { sources: ["music"], items: [{ id: "lab_dashboard", title: "Lab dashboard" }] });
  const o = await need.ask("I need the lab dashboard up.");
  assert.deepEqual(need.requests[0].tool_choice, { type: "function", function: { name: "crow_open" } }, "a request that names an item, with a request cue, must run");
  assert.equal(o.timings.final, "crow_open:unavailable");
});

// ── WM1a revision 3 ──────────────────────────────────────────────────────────────────────────────
test("a compound request: a false claim about the half that never happened is never heard — the turn ends on the line for what was done", async () => {
  const d = display({ model: (body, n) => (n === 1 ? { tool: "crow_show", args: FRUITS } : { say: "I closed the timer and put your list up." }) });
  d.store.open("kiosk-live", { kind: "timer", name: "Rice", title: "Rice", seconds: 600 });
  const r = await d.ask("Close the timer and then show me a list of three fruits.");
  assert.deepEqual(r.timings.tools, ["crow_show:shown"]);
  assert.equal(said(d), "Here's Fruits.");
  assert.equal(captions(d), "Here's Fruits.");
  assert.ok(!said(d).includes("closed the timer"));
  assert.equal(r.failed, null);
  assert.deepEqual(d.cards(), ["timer:Rice", "content:Fruits"]);
});

test("a card asked for without a display word is offered and must run: 'I need a list…', 'Hazme una lista…'; a claim with no call is never heard", async () => {
  for (const [lang, say, line] of [["en", "I need a list of three fruits.", "Sorry, I couldn't put that on the screen."], ["es", "Hazme una lista de tres frutas.", null]]) {
    const claim = display({ lang, model: () => ({ say: lang === "es" ? "Aquí tienes la lista en la pantalla." : "Your list is on the screen now." }) });
    const r = await claim.ask(say);
    assert.deepEqual(toolNames(claim.requests[0]), ["crow_show"], `${say}: offered, and narrowed to the card tool`);
    assert.equal(r.failed, "display_missed", say);
    assert.ok(!said(claim).includes("on the screen now") && !said(claim).includes("Aquí tienes"), say);
    if (line) assert.equal(claim.spoken.at(-1), line);
    const ok = display({ lang, forcing: "named", model: () => ({ tool: "crow_show", args: FRUITS }) });
    const r2 = await ok.ask(say);
    assert.deepEqual([r2.failed, ok.cards()], [null, ["content:Fruits"]], say);
  }
});

test("the card rule is narrow: questions, reading or closing a card, a noun inside an item's name, and 'next steps for' questions are not card requests", async () => {
  for (const say of ["What are the next steps for the project?", "What's on my list?", "Can you read me the list?", "I need to text my mom.", "Is there a timer running?"]) {
    const d = display({ model: () => ({ say: "Okay." }) });
    const r = await d.ask(say);
    assert.equal(r.failed, null, say);
    // "timer" is a display word (0.1.8's wantsDisplay) and "the list" a card noun after a determiner (revision 4), so those two
    // are OFFERED crow_show; nothing is required of any of them.
    if (say !== "Is there a timer running?" && say !== "Can you read me the list?") assert.equal(d.requests[0].tools, undefined, `${say}: no display tool is offered`);
    assert.equal(r.timings.tool_choice, undefined, `${say}: nothing is required`);
    assert.equal(said(d), "Okay.");
  }
  const make = display({ model: () => ({ say: "Done." }) });
  assert.equal((await make.ask("Make a list of chores.")).failed, "display_missed", "a making verb with a card noun is a request");
});

// ── Smoke 2026-10-06 F2: "Louder." over the radio went to the quick model, which SAID it turned the volume
// up and called nothing. The same turn shape, on a sentence no fast path takes: crow_wm is offered (music is
// on) and must run; the claim is never heard; with no call the turn ends on the truthful line.
async function playingRadio() {
  const { createMediaStore } = await import("../bundles/kiosk/server/media.js");
  const { createTicketStore } = await import("../bundles/kiosk/server/tickets.js");
  const { createPlayResolver, createMediaVerbs } = await import("../bundles/kiosk/server/play.js");
  const { createSourceRegistry } = await import("../bundles/kiosk/server/sources/index.js");
  const { createStationsSource, normalizeStations } = await import("../bundles/kiosk/server/sources/stations.js");
  const sent = [];
  const tickets = createTicketStore({ now: () => AT, setTimer: () => ({}), clearTimer: () => {} });
  const media = createMediaStore({ now: () => AT, tickets, send: (id, m) => { sent.push(m); return true; }, setTimer: () => ({}), clearTimer: () => {} });
  const registry = createSourceRegistry([createStationsSource({ list: () => normalizeStations([{ name: "Morning Mix", url: "https://stream.example.invalid/mix" }]) })]);
  const verbs = createMediaVerbs({ media, resolver: createPlayResolver({ registry, now: () => AT }), maxVolume: () => 100 });
  return { sent, media, build: (id) => ({ media, maxVolume: 100, sources: registry.kinds(), ...verbs }), start: async (id) => { media.play(id, [{ kind: "station", id: "m", title: "Morning Mix", upstream: { url: "https://stream.example.invalid/mix" } }], { origin: { source: "radio", candidateId: "m" } }); } };
}

test("smoke F2: a volume claim with no call is never heard — the corrective round turns it up, or the turn ends on 'I couldn't change the playback'", async () => {
  const SAID = "Could you turn the radio up a little so I can hear it?";
  // The model claims, then (corrective round) calls: the volume really changes and the server's line ends the turn.
  let radio = await playingRadio();
  let d = display({ media: radio.build, model: (body, n) => (n === 1 ? { say: "I turned the display volume up." } : { tool: "crow_wm", args: { do: "volume_up" } }) });
  await radio.start("kiosk-live");
  let r = await d.ask(SAID);
  assert.equal(await matchSpoken(SAID, d.ctx), null, "no fast path takes this sentence: the model gets it");
  assert.deepEqual(toolNames(d.requests[0]), ["crow_wm"], "only the must-run tool is offered");
  assert.match(d.requests[1].messages.at(-1).content, /Call crow_wm now/);
  assert.doesNotMatch(said(d), /turned/, "the claim is never spoken");
  assert.equal(radio.media.current("kiosk-live").volume, 60);
  assert.equal(r.failed, null);
  // The model claims twice and never calls: the truthful line, the volume untouched.
  radio = await playingRadio();
  d = display({ media: radio.build, model: () => ({ say: "Done, I turned the display volume up." }) });
  await radio.start("kiosk-live");
  r = await d.ask(SAID);
  assert.equal(said(d), "Sorry, I couldn't change the playback.");
  assert.equal(captions(d), "Sorry, I couldn't change the playback.");
  assert.equal(radio.media.current("kiosk-live").volume, 50);
  assert.equal(r.failed, "display_missed");
  // Spanish display, same shape.
  radio = await playingRadio();
  d = display({ lang: "es", media: radio.build, model: () => ({ say: "Listo, subí el volumen." }) });
  await radio.start("kiosk-live");
  await d.ask("¿Me subes el volumen de la radio un poquito, porfa?".replace("¿", ""));
  assert.equal(said(d), "Lo siento, no pude cambiar la reproducción.");
});

test("smoke F2: with nothing playing, the call's own answer is the truth ('Nothing is playing.'), and a plain question over music is never required to change anything", async () => {
  const radio = await playingRadio();
  let d = display({ media: radio.build, model: (body, n) => (n === 1 ? { say: "Turned it up!" } : { tool: "crow_wm", args: { do: "volume_up" } }) });
  await d.ask("Could you turn the radio up a little so I can hear it?");
  assert.equal(said(d), "Nothing is playing.");
  await radio.start("kiosk-live");
  d = display({ media: radio.build, model: () => ({ say: "Lisbon." }) });
  const r = await d.ask("What is the capital of Portugal?");
  assert.equal(said(d), "Lisbon.");
  assert.equal(r.failed, null);
  assert.equal(d.requests[0].tool_choice, undefined);
});
