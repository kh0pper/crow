/**
 * The shared fake voice-turn harness (moved verbatim from tests/voice-turn.test.js so
 * tests/voice-turn-crow.test.js can use it too).
 */
import { toolCategoryOf } from "../../servers/gateway/ai/tool-executor.js";
import { createVoiceTurnRunner } from "../../servers/gateway/voice/turn.js";

/** A fake clock: sleep() advances it. */
export function clock() { let t = 1_000; return { now: () => t, sleep: async (ms) => { t += ms; }, advance: (ms) => { t += ms; } }; }

/** chat adapter that plays one scripted round per chatStream call (the round index is shared by every adapter the harness hands out). */
export function scriptedChat(rounds, log, state) {
  return {
    async *chatStream(messages, tools, opts) {
      log.push({ messages: messages.map((m) => ({ ...m })), tools: tools.map((t) => t.name), toolDefs: tools, opts, systemAfterZero: messages.slice(1).some((m) => m.role === "system") });
      const events = rounds[state.i++] || [{ type: "done" }];
      for (const ev of events) {
        if (opts.signal?.aborted) return;
        log.pulls = (log.pulls || 0) + 1;
        if (ev.type === "hang") {   // a model that never answers: waits for the abort, then throws like fetch does
          await new Promise((res) => (opts.signal?.aborted ? res() : opts.signal?.addEventListener("abort", res, { once: true })));
          throw Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
        }
        yield ev;
      }
    },
  };
}

export function harness({ rounds = [[{ type: "content_delta", text: "Lisbon is the capital. " }, { type: "done" }]], route = "fast",
  bot = { bot_id: "household", display_name: "House", fast_voice_model: "crow-voice/qwen3.5-4b" },
  chatTools = ["crow_memory", "crow_projects", "crow_glasses_capture_photo", "crow_delegate"], probe = () => false, acquire = async () => null,
  ttsName = "kokoro", ctx = null } = {}) {
  const c = clock();
  const log = [];
  const state = { i: 0 };
  const calls = { chatKeys: [], executed: [], spoken: [], sleeps: 0, acquired: [], routed: [], hasTools: [], logs: [] };
  const deps = {
    log: (m) => calls.logs.push(m),
    now: c.now, sleep: async (ms) => { calls.sleeps++; await c.sleep(ms); },
    loadBotRow: async (db, id) => (bot && id === bot.bot_id ? { bot_id: bot.bot_id, enabled: 1, definition: JSON.stringify(bot) } : null),
    getSttProfile: async () => ({ id: "kiosk-stt", language: "en" }),
    createSttAdapter: async () => ({ transcribe: async (audio, o) => ({ text: o.__text ?? "What is the capital of Portugal?" }) }),
    getTtsProfile: async () => ({ id: "kokoro", defaultVoice: "af_heart" }),
    createTtsAdapter: async () => ({ name: ttsName, async *synthesize(text, voice, o) { calls.spoken.push(text); yield Buffer.from(text); } }),
    createChatAdapter: async (key) => { calls.chatKeys.push(key); return scriptedChat(rounds, log, state); },
    resolveKey: async (key) => ({ baseUrl: "http://esc", model: key }),
    acquire: async (p) => { calls.acquired.push(p); return acquire(p); },
    probeReady: async () => probe(),
    contextLenFor: async (key) => (typeof ctx === "function" ? ctx(key) : ctx),
    chooseVoiceRoute: (msgs, o) => (calls.routed.push(msgs.map((m) => m.role)), calls.hasTools.push(o?.hasTools), route === "fast" ? { route: "fast", reason: null, key: "crow-voice/qwen3.5-4b" } : { route: "escalate", reason: "tool-intent", key: "crow-chat/qwen3.6-35b-a3b" }),
    fastKey: "crow-voice/qwen3.5-4b",
    getChatTools: () => chatTools.map((name) => ({ name, description: name, inputSchema: { type: "object" } })),
    createToolExecutor: () => ({ executeToolCalls: async (tcs) => { calls.executed.push(...tcs.map((t) => t.name)); return tcs.map((t) => ({ id: t.id, name: t.name, result: "ok" })); }, close: async () => {} }),
    maxToolRounds: 10,
    effectiveToolName: (tc) => (/^crow_(memory|projects|blog)$/.test(tc.name) && tc.arguments?.action ? "crow_" + String(tc.arguments.action).replace(/^crow_/, "") : tc.name),
    isExternalSendTool: () => false, isConnectedAddonTool: () => false, botVoiceScope: () => null,
    toolCategory: toolCategoryOf,
    // `skills_text` stands in for the bound bot's resolved skill bodies (the real generator inlines them).
    generateSystemPrompt: async ({ botDef, omitSkills }) => `PERSONA:${botDef.display_name}${botDef.skills_text && !omitSkills ? `\n\n${botDef.skills_text}` : ""}`,
    isMemoryTool: (n) => n === "crow_memory" || n === "crow_search_memories",
  };
  const events = [];
  const audio = [];
  const sink = { event: (e) => events.push(e), audio: (b) => audio.push(b) };
  const runner = createVoiceTurnRunner(deps);
  const device = { id: "kiosk-a", bound_bot_id: bot?.bot_id ?? null, kiosk_settings: { memory_integration: false } };
  return { runner, deps, calls, events, audio, sink, device, log, c };
}
