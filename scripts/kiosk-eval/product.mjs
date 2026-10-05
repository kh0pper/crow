/**
 * One evaluation turn, run through the PRODUCT: the real voice turn (offer rules, must-run rules,
 * the forcing rule, held text, the corrective round, final results), the real display tools and
 * executor, the real no-model paths, the real prompt lines. Only these are stand-ins:
 *   - speech in and out (the transcript is given; what would be spoken is collected);
 *   - what the display can play and open (a fixture: every play and open succeeds and is recorded);
 *   - the assistant's other tools (memory and projects are on offer under the product's rules; a call
 *     to one is recorded and counts as a wrong turn in this set).
 * surface "four" is the product. surface "single" is the control: ONE tool { do, what, kind } whose
 * calls are translated to the same four executors, offered and required by the same rules.
 */
import { createVoiceTurnRunner } from "../../servers/gateway/voice/turn.js";
import { createConvoStore } from "../../servers/gateway/voice/turn-helpers.js";
import { createToolFamilies } from "../../servers/gateway/voice/tool-families.js";
import { TOOL_MANIFESTS } from "../../servers/gateway/tool-manifests.js";
import { createWmStore, wantsNewDisplay, matchWmFastPath } from "../../bundles/kiosk/server/wm.js";
import { createDisplayTools, cardUpdate } from "../../bundles/kiosk/server/display-tools.js";
import { SHOW_KINDS, WM_VERBS, MEDIA_VERBS } from "../../bundles/kiosk/server/tools.js";
import { result } from "../../bundles/kiosk/server/executor.js";
import { matchSpoken } from "../../bundles/kiosk/server/tiers.js";
import { displayPromptSuffix, displayTurnContext } from "../../bundles/kiosk/server/prompt.js";
import { kioskNowContext, matchClockFastPath } from "../../bundles/kiosk/server/clock.js";
import { wantsMemory } from "../../bundles/kiosk/server/memory-intent.js";
import { KIOSK_DENY_TOOLS, KIOSK_MAX_TOOL_ROUNDS, kioskDisplayMissedText } from "../../bundles/kiosk/server/runtime.js";
import { AT, TZ, FIXTURE } from "./cases.mjs";

/** A household assistant as people really set one up: a persona with habits, not one line. */
export const PERSONA = [
  "You are Juniper, the assistant for a busy household of four. You live on the display in the kitchen and you are spoken to while people cook, clean up and get ready to leave.",
  "Be warm and brief. People are usually doing something else while they talk to you, so answer the question that was asked and stop. If you do not know something, say so plainly.",
  "The household speaks English and Spanish; answer in the language you are spoken to in. Children use this display too: keep everything suitable for them.",
  "You can remember things for the family when they ask you to, and you can look things up in their projects when they ask about one. Do not bring either up unless asked.",
].join("\n");
/** What was said before this turn (a real display is rarely on its first turn). */
export const HISTORY = Object.freeze([
  { role: "user", content: "Good evening." },
  { role: "assistant", content: "Good evening! How can I help?" },
  { role: "user", content: "How many tablespoons are in a quarter cup?" },
  { role: "assistant", content: "Four tablespoons." },
]);
const BOT_TOOLS = ["memory", "projects"];
const botToolDefs = () => BOT_TOOLS.map((c) => ({ name: `crow_${c}`, description: TOOL_MANIFESTS[c].description, inputSchema: { type: "object", properties: { action: { type: "string", description: "Action name." }, params: { type: "object" } }, required: ["action"] } }));

/** The control arm's one tool, worded like the four, with one example per verb (none of them from the evaluation set). */
export function singleToolDefinition({ sources, items, verbs, kinds }) {
  return {
    name: "crow_do",
    description: "Do something on this display, only when someone asks to see, time, follow, open or play something. Examples: do \"play\", what \"ocean sounds\", kind \"auto\". do \"open\", what \"launcher\". do \"show\", kind \"list\", what \"Chores | sweep\\nmop\\ndust\". do \"close\", what \"weather\".",
    inputSchema: { type: "object", properties: {
      do: { type: "string", enum: [...(sources.length ? ["play"] : []), ...(items.length ? ["open"] : []), ...(kinds.length ? ["show"] : []), ...verbs] },
      what: { type: "string", maxLength: 4000, description: `play: what to play, a name or a few search words. open: one of ${[...items.map((i) => `${i.id} = ${i.title}`), "launcher = anything else"].join("; ")}. show: the title, a bar, then the body (text: paragraphs; list: one item per line; steps: ingredients one per line, a line with three dashes, then the steps; timer: how long, like 12 minutes). close: which window, by its name or kind, or leave out for the one in front.` },
      kind: { type: "string", enum: ["auto", ...sources, ...kinds], description: "play: where to look (auto unless the person named one). show: the kind of card." },
    }, required: ["do"] },
  };
}
/** { do, what, kind } → the four-tool call it stands for. */
export function fromSingle(args) {
  const a = args || {};
  const what = typeof a.what === "string" ? a.what : "";
  if (a.do === "play") return { name: "crow_play", args: { what, source: a.kind } };
  if (a.do === "open") return { name: "crow_open", args: { app: what } };
  if (a.do === "show") { const bar = what.indexOf("|"); return { name: "crow_show", args: { kind: a.kind, title: bar < 0 ? what : what.slice(0, bar).trim(), body: bar < 0 ? "" : what.slice(bar + 1).trim() } }; }
  return { name: "crow_wm", args: { do: a.do, ...(what ? { name: what } : {}) } };
}
/** A four-tool call as the single tool carries it. */
export function toSingle({ name, args }) {
  if (name === "crow_play") return { name: "crow_do", args: { do: "play", what: args.what, kind: args.source } };
  if (name === "crow_open") return { name: "crow_do", args: { do: "open", what: args.app } };
  if (name === "crow_show") return { name: "crow_do", args: { do: "show", kind: args.kind, what: `${args.title} | ${args.body}` } };
  return { name: "crow_do", args: { do: args.do, ...(args.name ? { what: args.name } : {}) } };
}
/** The single tool, with the union of the four tools' rules: offered when any is, required when any is. bind(transcript) fixes which of the four this turn requires. */
function singleTool(four, def) {
  const by = new Map(four.map((t) => [t.definition.name, t]));
  const any = (key) => (t) => four.some((x) => typeof x[key] === "function" && x[key](t) === true);
  const mustOf = (t) => four.find((x) => typeof x.when === "function" && x.when(t) === true && typeof x.must === "function" && x.must(t) === true) || null;
  let required = null, last = null;
  const tool = {
    definition: def,
    when: any("when"), holdText: any("holdText"), must: (t) => mustOf(t) !== null,
    narrow: (t) => four.every((x) => typeof x.narrow !== "function" || x.narrow(t) !== false),
    mustNote: "[Display] Nothing has been done on the display in this turn yet. Call crow_do now with what the person asked for. If you cannot, tell the user plainly that you could not; never say that it is done.",
    // What counts as done is the required tool's own rule, applied to the call the single tool stood for.
    mustDone: (r) => !!required && last === required.definition.name && (typeof required.mustDone === "function" ? required.mustDone(r) === true : r?.ok === true),
    bind(transcript) { required = mustOf(transcript); last = null; tool.missedText = required?.missedText; },
    async execute(args, turn) {
      const call = fromSingle(args);
      const x = by.get(call.name);
      last = call.name;
      if (!x || (typeof x.when === "function" && x.when(turn?.transcript) !== true)) return JSON.stringify({ ok: false, outcome: "invalid", reason: "not_offered", say: "Nothing was done: that is not needed for this question. Answer the user aloud.", final: false });
      return x.execute(call.args, turn);
    },
  };
  return tool;
}

/**
 * chat: an adapter with chatStream(messages, tools, opts) (the real OpenAI adapter, or a scripted one).
 * forcing: async () => { named, required, engine } (the real createToolForcing, or a fixed answer).
 * → { ask(transcript) → row, gates(transcript) }.
 */
export function createProductDisplay({ surface = "four", chat, forcing, state = {}, lang = "en", ctxLen = 8192 }) {
  const calls = [], other = [], spoken = [], events = [];
  const stats = { requests: 0, errors: [], first: null };
  const store = createWmStore({ now: () => AT, setTimer: () => ({}), clearTimer: () => {} });
  for (const w of state.windows || []) store.open("eval", w);
  const playing = state.playing ? { ...state.playing } : null;
  const media = { active: () => !!playing };
  const ctx = {
    store, deviceId: "eval", caps: FIXTURE.caps, lang, sources: FIXTURE.sources, items: FIXTURE.items, emit: (ev) => events.push(ev), media,
    // The fixture's display can play and open anything: what is measured is the call, not a library.
    resolvePlay: (i) => result(true, "playing", lang === "es" ? `Reproduciendo ${i.what}.` : `Playing ${i.what}.`),
    openItem: (i) => result(true, "opened", lang === "es" ? "Abierto." : "Opened."),
    mediaVerb: () => (playing ? result(true, "done", lang === "es" ? "Listo." : "Okay.") : result(true, "nothing_playing", lang === "es" ? "No hay nada sonando." : "Nothing is playing.", { effect: false })),
  };
  const four = createDisplayTools(ctx).map((t) => ({
    ...t,
    async execute(args, turn) {
      const before = new Set(store.list("eval").map((w) => w.id));
      const out = await t.execute(args, turn);
      const res = JSON.parse(out);
      const opened = store.list("eval").find((w) => !before.has(w.id));
      calls.push({ tool: t.definition.name, args: args || {}, result: res, ...(opened?.kind === "timer" ? { seconds: Math.round((opened.ends_at - AT) / 1000) } : {}) });
      return out;
    },
  }));
  const kinds = SHOW_KINDS.filter((k) => four.find((t) => t.definition.name === "crow_show")?.definition.inputSchema.properties.kind.enum.includes(k));
  const single = singleTool(four, singleToolDefinition({ sources: FIXTURE.sources, items: FIXTURE.items, verbs: [...WM_VERBS, ...MEDIA_VERBS], kinds }));
  const extraTools = surface === "four" ? four : [single];
  const counted = {
    async *chatStream(messages, tools, opts) {
      stats.requests += 1;
      if (!stats.first) stats.first = { tools: tools.map((t) => t.name), choice: opts?.toolChoice ? (typeof opts.toolChoice === "string" ? opts.toolChoice : "named") : "none" };
      try { yield* chat.chatStream(messages, tools, opts); }
      catch (err) {
        // A refused tool_choice (400/422) is the product's own step-down, handled by the turn. Anything else is a failed request.
        if (!(opts?.toolChoice && err?.code === "provider_error" && (err.status === 400 || err.status === 422))) stats.errors.push(String(err?.message || err).slice(0, 200));
        throw err;
      }
    },
  };
  const convo = createConvoStore({ now: () => AT });
  convo.save("eval", HISTORY.map((m) => ({ ...m })));
  const runner = createVoiceTurnRunner({
    log: () => {}, now: () => AT, sleep: async () => {}, convo,
    loadBotRow: async () => ({ bot_id: "house", enabled: 1, definition: JSON.stringify({ bot_id: "house", system_prompt: PERSONA }) }),
    getSttProfile: async () => ({ id: "stt" }), createSttAdapter: async () => ({ transcribe: async () => ({ text: "" }) }),
    getTtsProfile: async () => ({ id: "tts", defaultVoice: "v" }),
    createTtsAdapter: async () => ({ name: "kokoro", async *synthesize(t) { spoken.push(t); yield Buffer.from("x"); } }),
    createChatAdapter: async () => counted,
    resolveKey: async () => ({ baseUrl: "x" }), acquire: async () => null, probeReady: async () => false,
    contextLenFor: async () => ctxLen,
    // Every turn goes to the model under test. (In production the router sends only some turns to the larger model.)
    chooseVoiceRoute: () => ({ route: "fast", reason: null, key: "eval/model" }), fastKey: "eval/model",
    getChatTools: botToolDefs,
    createToolExecutor: () => ({ executeToolCalls: async (tcs) => { other.push(...tcs.map((t) => t.name)); return tcs.map((t) => ({ id: t.id, name: t.name, result: "No results.", isError: false })); }, close: async () => {} }),
    maxToolRounds: 10,
    effectiveToolName: (tc) => tc.name, isExternalSendTool: () => false, isConnectedAddonTool: () => false, botVoiceScope: () => null,
    generateSystemPrompt: async ({ botDef }) => botDef.system_prompt, isMemoryTool: (n) => n === "crow_memory",
    toolForcing: forcing,
    toolFamilies: createToolFamilies({ manifests: TOOL_MANIFESTS }),
  });
  const device = { id: "eval", bound_bot_id: "house", kiosk_settings: { memory_integration: true, lang } };
  const sink = { event: (e) => events.push(e), audio: () => {} };
  const mediaLine = () => (playing ? `${playing.paused ? "Paused" : "Playing"}: ${playing.title} (${playing.source}).` : "");
  const fastPaths = async (t) => (await matchSpoken(t, ctx)) || matchWmFastPath(t, store, "eval", FIXTURE.caps) || matchClockFastPath(t, { now: AT, tz: TZ });
  /** What the product's own rules do with this transcript, before any model is asked. */
  function gates(transcript) {
    const offered = four.filter((t) => typeof t.when !== "function" || t.when(transcript) === true).map((t) => t.definition.name);
    const must = four.find((t) => offered.includes(t.definition.name) && typeof t.must === "function" && t.must(transcript) === true)?.definition.name || null;
    return { offered, must };
  }
  async function ask(transcript) {
    const t0 = Date.now();
    single.bind(transcript);
    const r = await runner.runVoiceTurn({
      db: {}, device, sink, transcript, extraTools, fastPaths,
      promptSuffix: displayPromptSuffix(FIXTURE.caps),
      turnContext: (t) => `${kioskNowContext(AT, TZ)}\n${displayTurnContext(store, "eval", { countsOnly: wantsNewDisplay(t), media: mediaLine(), card: cardUpdate(t, store, "eval") !== null })}`,
      denyTools: KIOSK_DENY_TOOLS, maxToolRounds: KIOSK_MAX_TOOL_ROUNDS, familiesOnIntent: true,
      displayMissedText: kioskDisplayMissedText(lang), memoryWhen: wantsMemory,
    });
    return {
      calls: calls.slice(), other: other.slice(), spoken: spoken.join(" "), failed: r.failed ?? null, fast_path: r.fastPath === true,
      requests: stats.requests, errors: stats.errors.slice(), first: stats.first, tool_choice: r.timings?.tool_choice ?? null,
      corrected: r.timings?.display_corrected === true, final: r.timings?.final ?? null, tools: r.timings?.tools || [], ms: Date.now() - t0,
    };
  }
  return { ask, gates, fastPaths, store };
}
