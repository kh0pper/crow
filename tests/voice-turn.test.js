import { test } from "node:test";
import assert from "node:assert/strict";
import { toolCategoryOf } from "../servers/gateway/ai/tool-executor.js";
import { TURN_CONTEXT_NOTE } from "../servers/gateway/voice/context-echo.js";
import { createVoiceTurnRunner, wasOffered, ESCALATION_READY_TIMEOUT_MS, FILLER_TEXT, FALLBACK_TEXT, STOP_TOOLS_NOTE, BOT_TOO_LARGE_TEXT, DISPLAY_MISSED_TEXT } from "../servers/gateway/voice/turn.js";

/** A fake clock: sleep() advances it. */
function clock() { let t = 1_000; return { now: () => t, sleep: async (ms) => { t += ms; }, advance: (ms) => { t += ms; } }; }

/** chat adapter that plays one scripted round per chatStream call (the round index is shared by every adapter the harness hands out). */
function scriptedChat(rounds, log, state) {
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

function harness({ rounds = [[{ type: "content_delta", text: "Lisbon is the capital. " }, { type: "done" }]], route = "fast",
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

test("transcript → bot persona + suffix → fast model; captions, PCM tts framing, timings", async () => {
  const h = harness();
  const r = await h.runner.runVoiceTurn({ db: {}, device: h.device, audio: Buffer.alloc(10), sink: h.sink, promptSuffix: "KIOSK" });
  assert.equal(r.transcript, "What is the capital of Portugal?");
  assert.equal(r.route, "fast");
  assert.deepEqual(h.calls.chatKeys, ["crow-voice/qwen3.5-4b"]);
  assert.match(h.log[0].messages[0].content, /^PERSONA:House\n\nKIOSK$/);
  assert.equal(h.log[0].messages.at(-1).content, "What is the capital of Portugal?");
  assert.equal(h.log[0].opts.chatTemplateKwargs.enable_thinking, false);
  assert.deepEqual(h.events.map((e) => e.type), ["transcript_final", "caption_delta", "tts_start", "tts_end"]);
  assert.deepEqual(h.events[2], { type: "tts_start", codec: "pcm", sample_rate: 24000 });
  assert.equal(Buffer.concat(h.audio).toString(), "Lisbon is the capital.");
  for (const k of ["stt_ms", "llm_first_token_ms", "tts_first_chunk_ms", "total_ms"]) assert.equal(typeof r.timings[k], "number", k);
});

test("memory category + glasses capture are stripped unless memory_integration; a forced memory call is refused", async () => {
  const h = harness({ rounds: [[{ type: "tool_call", id: "t1", name: "crow_memory", arguments: { action: "search_memories", params: { query: "x" } } }, { type: "done" }], [{ type: "content_delta", text: "I can't here." }, { type: "done" }]] });
  await h.runner.runVoiceTurn({ db: {}, device: h.device, audio: Buffer.alloc(1), sink: h.sink });
  assert.deepEqual(h.log[0].tools, ["crow_projects", "crow_delegate"]);
  assert.deepEqual(h.calls.executed, [], "the executor never ran the memory call");
  assert.match(h.log[1].messages.at(-1).content, /Memory is turned off on this display/);
  const on = harness();
  on.device.kiosk_settings.memory_integration = true;
  await on.runner.runVoiceTurn({ db: {}, device: on.device, audio: Buffer.alloc(1), sink: on.sink });
  assert.deepEqual(on.log[0].tools, ["crow_memory", "crow_projects", "crow_delegate"]);
});

test("think gate: <think> text is never spoken or captioned", async () => {
  const h = harness({ rounds: [[{ type: "content_delta", text: "<think>plan" }, { type: "content_delta", text: " it</think>Hello there. " }, { type: "done" }]] });
  await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "hi", sink: h.sink });
  assert.deepEqual(h.calls.spoken, ["Hello there."]);
  assert.ok(!h.events.some((e) => e.type === "caption_delta" && /think|plan/.test(e.text)));
});

test("sentence chunking: each sentence is synthesized in order", async () => {
  const h = harness({ rounds: [[{ type: "content_delta", text: "One. Two" }, { type: "content_delta", text: "! Three" }, { type: "done" }]] });
  await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "count", sink: h.sink });
  assert.deepEqual(h.calls.spoken, ["One.", "Two!", "Three"]);
});

test("barge-in: abort stops the LLM stream and TTS at once (no further pulls, no more audio)", async () => {
  const ac = new AbortController();
  const h = harness({ rounds: [[{ type: "content_delta", text: "First. " }, { type: "content_delta", text: "Second. " }, { type: "content_delta", text: "Third. " }, { type: "done" }]] });
  const origAudio = h.sink.audio;
  let tAbort = 0;
  h.sink.audio = (b) => { origAudio(b); tAbort = performance.now(); ac.abort(); };
  const r = await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "go", sink: h.sink, signal: ac.signal });
  const tDone = performance.now();
  assert.equal(r.aborted, true);
  assert.equal(h.audio.length, 1, "only the first sentence's audio left the server");
  assert.ok(h.log.pulls <= 2, `stream stopped after abort (pulls=${h.log.pulls})`);
  assert.equal(h.log[0].opts.signal.aborted, true, "the abort signal reaches the provider fetch (composed with the first-audio budget)");
  assert.ok(tDone - tAbort < 100, `the turn returned ${Math.round(tDone - tAbort)} ms after the abort (real clock; spec: within 100 ms)`);
});

test("cold escalation target: filler first, then fall back to the fast model after 8 s", async () => {
  const h = harness({ route: "escalate", probe: () => false });
  const r = await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "set a timer", sink: h.sink });
  assert.equal(h.calls.spoken[0], FILLER_TEXT);
  assert.equal(r.route, "fast");
  assert.equal(r.degraded, "cold_timeout");
  assert.deepEqual(h.calls.acquired, ["crow-chat"]);
  assert.ok(h.c.now() >= 1_000 + ESCALATION_READY_TIMEOUT_MS);
  assert.deepEqual(h.calls.chatKeys, ["crow-voice/qwen3.5-4b"]);
  assert.match(h.log[0].messages[0].content, /larger model is not available/, "the note joins the leading system message");
  assert.ok(h.log.every((l) => !l.systemAfterZero), "no system message after index 0 in any request (Qwen templates reject it — review C1)");
});

test("escalation target ready on the second probe → escalated turn on the 35B", async () => {
  let n = 0;
  const h = harness({ route: "escalate", probe: () => ++n >= 2 });
  const r = await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "set a timer", sink: h.sink });
  assert.equal(r.route, "escalate"); assert.equal(r.escalated, true);
  assert.deepEqual(h.calls.chatKeys, ["crow-voice/qwen3.5-4b", "crow-chat/qwen3.6-35b-a3b"]);
});

test("box reserved → immediate fallback, no 8 s wait", async () => {
  const h = harness({ route: "escalate", acquire: async () => { throw Object.assign(new Error("reserved"), { code: "box_reserved" }); } });
  const r = await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "set a timer", sink: h.sink });
  assert.equal(r.degraded, "box_reserved");
  assert.ok(h.calls.sleeps <= 1);
});

test("destructive tool: two-turn spoken confirmation", async () => {
  const del = { type: "tool_call", id: "d1", name: "crow_delete_post", arguments: { id: 7 } };
  const h = harness({ chatTools: ["crow_blog"], rounds: [[del, { type: "done" }], [{ type: "content_delta", text: "Are you sure?" }, { type: "done" }], [del, { type: "done" }], [{ type: "content_delta", text: "Deleted." }, { type: "done" }]] });
  await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "delete post 7", sink: h.sink });
  assert.deepEqual(h.calls.executed, []);
  assert.match(h.log[1].messages.at(-1).content, /Confirmation required/);
  await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "yes", sink: h.sink });
  assert.deepEqual(h.calls.executed, ["crow_delete_post"]);
});

test("extra tools run in-process; fast paths skip the LLM entirely", async () => {
  const wmCalls = [];
  const extra = { definition: { name: "crow_wm", description: "wm", inputSchema: { type: "object" } }, execute: async (a) => { wmCalls.push(a); return '{"ok":true}'; } };
  const h = harness({ rounds: [[{ type: "tool_call", id: "w1", name: "crow_wm", arguments: { command: "timer 2 minutes tea" } }, { type: "done" }], [{ type: "content_delta", text: "Timer set." }, { type: "done" }]] });
  await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "set a timer", sink: h.sink, extraTools: [extra] });
  assert.deepEqual(wmCalls, [{ command: "timer 2 minutes tea" }]);
  assert.deepEqual(h.calls.executed, []);
  assert.ok(h.log[0].tools.includes("crow_wm"));

  const f = harness();
  const r = await f.runner.runVoiceTurn({ db: {}, device: f.device, transcript: "close", sink: f.sink,
    fastPaths: async (t) => (t === "close" ? { say: "Closed.", events: [{ type: "wm", action: "close", id: "content-1" }] } : null) });
  assert.equal(r.fastPath, true);
  assert.deepEqual(f.calls.chatKeys, []);
  assert.ok(f.events.some((e) => e.type === "wm" && e.action === "close"));
  assert.deepEqual(f.calls.spoken, ["Closed."]);
});

test("no bound bot → error no_bound_bot, nothing spoken", async () => {
  const h = harness({ bot: null });
  await h.runner.runVoiceTurn({ db: {}, device: { ...h.device, bound_bot_id: null }, transcript: "hi", sink: h.sink });
  assert.ok(h.events.some((e) => e.type === "error" && e.code === "no_bound_bot"));
  assert.deepEqual(h.calls.spoken, []);
});

test("denyTools: crow_delegate/crow_job_status are not advertised and a forced call never runs (review C3)", async () => {
  const h = harness({ rounds: [[{ type: "tool_call", id: "d1", name: "crow_delegate", arguments: { goal: "search Kevin's memories", bot: "kevin-personal" } }, { type: "done" }], [{ type: "content_delta", text: "I can't do that here." }, { type: "done" }]],
    chatTools: ["crow_projects", "crow_delegate", "crow_job_status"] });
  await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "delegate", sink: h.sink, denyTools: ["crow_delegate", "crow_job_status"] });
  assert.deepEqual(h.log[0].tools, ["crow_projects"]);
  assert.deepEqual(h.calls.executed, []);
  assert.match(h.log[1].messages.at(-1).content, /not available on this display/);
});

test("routing ignores in-process display-tool turns; turnContext rides on the request only (review M5/M6)", async () => {
  const extra = { definition: { name: "crow_wm", description: "wm", inputSchema: { type: "object" } }, execute: async () => '{"ok":true}' };
  const h = harness({ rounds: [[{ type: "tool_call", id: "w1", name: "crow_wm", arguments: { command: "timer 2 minutes tea" } }, { type: "done" }], [{ type: "content_delta", text: "Set." }, { type: "done" }], [{ type: "content_delta", text: "Lisbon." }, { type: "done" }]] });
  await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "set a timer", sink: h.sink, extraTools: [extra], turnContext: "Open windows: none." });
  await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "capital of Portugal?", sink: h.sink, extraTools: [extra], turnContext: "Open windows: timer 'Tea' 1:59 left." });
  assert.ok(!h.calls.routed[1].includes("tool"), "the crow_wm round-trip is invisible to the router");
  assert.match(h.log.at(-1).messages.at(-1).content, /^Open windows: timer 'Tea' 1:59 left\.\n\[Note\] [^\n]+\n\ncapital of Portugal\?$/);
  assert.equal(h.log.at(-1).messages[0].content, h.log[0].messages[0].content, "system message byte-stable across turns");
  const saved = h.runner.convo.get("kiosk-a").filter((m) => m.role === "user").map((m) => m.content);
  assert.deepEqual(saved, ["set a timer", "capital of Portugal?"], "saved history has plain transcripts");
});

test("maxTokens is clamped to the model's context minus the prompt estimate (review M6)", async () => {
  const h = harness({ ctx: 500 });
  await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "hi", sink: h.sink });
  const m = h.log[0].opts.maxTokens;
  assert.ok(m >= 64 && m < 400, `maxTokens ${m} for a 500-token context`);
  const big = harness({ ctx: null });
  await big.runner.runVoiceTurn({ db: {}, device: big.device, transcript: "hi", sink: big.sink });
  assert.equal(big.log[0].opts.maxTokens, 600, "unknown context → the glasses default");
});

test("Edge (no PCM path) sends ONE mp3 buffer per sentence", async () => {
  const h = harness({ ttsName: "edge", rounds: [[{ type: "content_delta", text: "One. Two." }, { type: "done" }]] });
  await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "x", sink: h.sink });
  assert.deepEqual(h.events.find((e) => e.type === "tts_start"), { type: "tts_start", codec: "mp3", sample_rate: 24000 });
  assert.equal(h.audio.length, 2);
});

test("denyTools (ruling F4): schedule tools are hidden and refused when passed; whitespace-only sentences are never synthesized", async () => {
  const deny = ["crow_schedule_bot", "crow_list_bot_schedules", "crow_delete_bot_schedule"];
  const h = harness({ chatTools: ["crow_projects", ...deny],
    rounds: [[{ type: "tool_call", id: "s1", name: "crow_schedule_bot", arguments: {} }, { type: "done" }], [{ type: "content_delta", text: "Hi.   \n\n  Ok. " }, { type: "done" }]] });
  await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "schedule", sink: h.sink, denyTools: deny });
  assert.deepEqual(h.log[0].tools, ["crow_projects"]);
  assert.deepEqual(h.calls.executed, []);
  assert.deepEqual(h.calls.spoken, ["Hi.", "Ok."]);
});

test("review fix: a filler TTS rejection during the real-timer wait is not an unhandled rejection", async () => {
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  const origWarn = console.warn; const warned = [];
  console.warn = (...a) => warned.push(a.join(" "));
  try {
    const h = harness({ route: "escalate", probe: () => false });
    h.deps.sleep = (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20)));   // real timers; fake clock advances via now()
    let t = 0; h.deps.now = () => (t += 400);
    h.deps.createTtsAdapter = async () => ({ name: "kokoro", async *synthesize() { throw new Error("tts down"); } });
    const runner = createVoiceTurnRunner(h.deps);
    const r = await runner.runVoiceTurn({ db: {}, device: h.device, transcript: "set a timer", sink: h.sink });
    await new Promise((res) => setTimeout(res, 30));
    assert.deepEqual(unhandled, []);
    assert.equal(r.degraded, "cold_timeout");
    assert.ok(warned.some((w) => /filler TTS failed: tts down/.test(w)), "the filler error is logged, not hidden");
  } finally { process.off("unhandledRejection", onUnhandled); console.warn = origWarn; }
});

test("review fix: acquire resolving false falls back at once", async () => {
  const h = harness({ route: "escalate", acquire: async () => false });
  const r = await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "set a timer", sink: h.sink });
  assert.equal(r.degraded, "acquire_failed");
  assert.ok(h.calls.sleeps <= 1);
});

test("review fix: bare tool names hit the memory strip, denyTools and the destructive gate (REAL effectiveToolName/isMemoryTool)", async () => {
  const real = await (await import("../servers/gateway/voice/turn.js")).defaultVoiceDeps();
  const bare = async (name, args, extra = {}) => {
    const h = harness({ rounds: [[{ type: "tool_call", id: "b1", name, arguments: args }, { type: "done" }], [{ type: "content_delta", text: "Ok." }, { type: "done" }]], chatTools: ["crow_projects", "crow_blog"] });
    h.deps.effectiveToolName = real.effectiveToolName; h.deps.isMemoryTool = real.isMemoryTool;
    const runner = createVoiceTurnRunner(h.deps);
    await runner.runVoiceTurn({ db: {}, device: h.device, transcript: "go", sink: h.sink, ...extra });
    return h;
  };
  const m = await bare("search_memories", { query: "x" });
  assert.deepEqual(m.calls.executed, []); assert.match(m.log[1].messages.at(-1).content, /Memory is turned off/);
  const d = await bare("delegate", { goal: "x" }, { denyTools: ["crow_delegate"] });
  assert.deepEqual(d.calls.executed, []); assert.match(d.log[1].messages.at(-1).content, /not available on this display/);
  const x = await bare("delete_post", { id: 7 });
  assert.deepEqual(x.calls.executed, []); assert.match(x.log[1].messages.at(-1).content, /Confirmation required/);
});

test("smoke 2026-10-04: the router sees the plain transcript — a turnContext containing 'Open' never escalates a plain question", async () => {
  const { chooseVoiceRoute } = await import("../servers/gateway/routes/llm-router.js");
  const seen = [];
  const extra = { definition: { name: "crow_wm", description: "wm", inputSchema: { type: "object" } }, execute: async () => '{"ok":true}' };
  const h = harness();
  h.deps.chooseVoiceRoute = (msgs, o) => { seen.push(msgs.at(-1).content); return chooseVoiceRoute(msgs, o); };
  const r = await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "What is the capital of Portugal?", sink: h.sink, extraTools: [extra], turnContext: "[Display] Open windows: none." });
  assert.deepEqual(seen, ["What is the capital of Portugal?"]);
  assert.equal(r.route, "fast");
  assert.equal(r.escalated, false);
  assert.match(h.log.at(-1).messages.at(-1).content, /^\[Display\] Open windows: none\.\n\[Note\] [^\n]+\n\nWhat is the capital of Portugal\?$/, "the model still gets the context");
});

test("smoke 2026-10-04 lever 3: the FIRST chunk is the first clause, later chunks are whole sentences (opt-out keeps sentences)", async () => {
  const text = ["Lisbon", " is", " the", " capital", " of", " Portugal,", " a", " city", " by", " the", " sea.", " It", " is", " old,", " and", " lovely."];
  const h = harness({ rounds: [[...text.map((t) => ({ type: "content_delta", text: t })), { type: "done" }]] });
  await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "capital?", sink: h.sink });
  assert.deepEqual(h.calls.spoken, ["Lisbon is the capital of Portugal,", "a city by the sea.", "It is old, and lovely."]);
  const off = harness({ rounds: [[...text.map((t) => ({ type: "content_delta", text: t })), { type: "done" }]] });
  await off.runner.runVoiceTurn({ db: {}, device: off.device, transcript: "capital?", sink: off.sink, firstClause: false });
  assert.deepEqual(off.calls.spoken, ["Lisbon is the capital of Portugal, a city by the sea.", "It is old, and lovely."]);
});

test("smoke 2026-10-04: refused tool calls (denied crow_discover) never make the next turns 'recent tool context'; a real tool call still does", async () => {
  const h = harness({
    rounds: [
      [{ type: "tool_call", id: "x1", name: "crow_discover", arguments: {} }, { type: "done" }],
      [{ type: "content_delta", text: "Lisbon." }, { type: "done" }],
      [{ type: "content_delta", text: "Madrid." }, { type: "done" }],
      [{ type: "tool_call", id: "p1", name: "crow_projects", arguments: { action: "list_projects" } }, { type: "done" }],
      [{ type: "content_delta", text: "Two projects." }, { type: "done" }],
      [{ type: "content_delta", text: "Paris." }, { type: "done" }],
    ],
    chatTools: ["crow_projects", "crow_discover"],
  });
  const deny = ["crow_discover"];
  await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "capital of Portugal?", sink: h.sink, denyTools: deny });
  assert.deepEqual(h.log[0].tools, ["crow_projects"], "crow_discover is not advertised");
  assert.match(h.log[1].messages.at(-1).content, /^Tool discovery is not needed here/, "review I1: a denied discover keeps the turn going (no 'not available' answer)");
  assert.doesNotMatch(h.log[1].messages.at(-1).content, /end your turn/);
  await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "capital of Spain?", sink: h.sink, denyTools: deny });
  assert.ok(!h.calls.routed[1].includes("tool"), "the refused crow_discover round-trip is invisible to the router");
  assert.ok(h.log[2].messages.some((m) => m.role === "tool"), "…but the model still sees it in its history");
  await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "my projects?", sink: h.sink, denyTools: deny });
  await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "capital of France?", sink: h.sink, denyTools: deny });
  assert.ok(h.calls.routed[3].includes("tool"), "an executed (non-kiosk-native) tool call still counts as recent tool context");
});

test("smoke 2026-10-04 lever 2: opts.sttModel(profile) picks the transcription model; null keeps the profile's", async () => {
  const seen = [];
  const h = harness();
  h.deps.getSttProfile = async () => ({ id: "kiosk-stt", provider: "fasterwhisper", language: "en" });
  h.deps.createSttAdapter = async () => ({ transcribe: async (audio, o) => { seen.push(o.model ?? null); return { text: "hi" }; } });
  await h.runner.runVoiceTurn({ db: {}, device: h.device, audio: Buffer.alloc(10), sink: h.sink, sttModel: (p) => (p.provider === "fasterwhisper" ? "Systran/faster-whisper-tiny.en" : null) });
  await h.runner.runVoiceTurn({ db: {}, device: h.device, audio: Buffer.alloc(10), sink: h.sink, sttModel: () => null });
  await h.runner.runVoiceTurn({ db: {}, device: h.device, audio: Buffer.alloc(10), sink: h.sink });
  assert.deepEqual(seen, ["Systran/faster-whisper-tiny.en", null, null]);
});

test("review I3: a confirmation refusal still counts as tool context — the 'yes' that follows keeps its route", async () => {
  const h = harness({ rounds: [[{ type: "tool_call", id: "c1", name: "crow_delete_post", arguments: { id: 7 } }, { type: "done" }], [{ type: "content_delta", text: "Are you sure?" }, { type: "done" }], [{ type: "content_delta", text: "Done." }, { type: "done" }]],
    chatTools: ["crow_delete_post"] });
  await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "delete post 7", sink: h.sink });
  assert.match(h.log[1].messages.at(-1).content, /Confirmation required/);
  await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "yes", sink: h.sink });
  assert.ok(h.calls.routed[1].includes("tool"), "the confirm round-trip stays visible to the router");
});

test("review M7: route-neutrality follows the refused call, not its id — a real call sharing an empty id still counts", async () => {
  const h = harness({ rounds: [[{ type: "tool_call", id: "", name: "crow_discover", arguments: {} }, { type: "tool_call", id: "", name: "crow_projects", arguments: { action: "list_projects" } }, { type: "done" }], [{ type: "content_delta", text: "Two." }, { type: "done" }], [{ type: "content_delta", text: "Ok." }, { type: "done" }]],
    chatTools: ["crow_projects", "crow_discover"] });
  await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "projects?", sink: h.sink, denyTools: ["crow_discover"] });
  assert.deepEqual(h.calls.executed, ["crow_projects"]);
  await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "and?", sink: h.sink, denyTools: ["crow_discover"] });
  assert.equal(h.calls.routed[1].filter((r) => r === "tool").length, 1, "the executed crow_projects result counts; the refused discover does not");
});

test("lever D: an early transcript skips STT; timings count from the real turn start (startedAt) and record the early STT", async () => {
  const h = harness();
  let sttCalls = 0;
  h.deps.createSttAdapter = async () => ({ transcribe: async () => { sttCalls++; return { text: "x" }; } });
  const startedAt = h.c.now() - 150;                         // the turn waited 150 ms for the early transcript
  const r = await h.runner.runVoiceTurn({ db: {}, device: h.device, audio: Buffer.alloc(10), transcript: "What is the capital of Portugal?", startedAt, sttEarly: { used: true, ms: 620, discards: 1 }, sink: h.sink });
  assert.equal(sttCalls, 0);
  assert.equal(r.timings.stt_ms, 150);
  assert.equal(r.timings.stt_early, "used");
  assert.equal(r.timings.stt_early_ms, 620);
  assert.equal(r.timings.stt_early_discards, 1);
  assert.ok(r.timings.llm_first_token_ms >= 150, "later marks are from startedAt too");
  const seen = [];
  h.deps.getSttProfile = async () => ({ id: "k", provider: "fasterwhisper", language: "en" });
  h.deps.createSttAdapter = async () => ({ transcribe: async (a, o) => { seen.push(o.model ?? null); return { text: "  hi  " }; } });
  assert.deepEqual(await h.runner.transcribe({ db: {}, device: h.device, audio: Buffer.alloc(4), sttModel: () => "Systran/faster-whisper-tiny.en" }), { text: "hi" });
  assert.deepEqual(seen, ["Systran/faster-whisper-tiny.en"]);
});

// --- Tool-loop stall fix (smoke 2026-10-04 Run B #19: 10 silent 4B tool rounds, 24.5 s, no audio, no message) ---

const call = (id, name, args = { q: "secret-arg" }) => [{ type: "tool_call", id, name, arguments: args }, { type: "done" }];

test("stall fix: a model looping the SAME tool is stopped after 2 rounds; the final round's call is ignored; the fallback is spoken + captioned; logs name the tool, never its args", async () => {
  const h = harness({ rounds: Array.from({ length: 10 }, (_, i) => call("c" + i, "crow_projects")) });
  const r = await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "how do you separate an egg yolk", sink: h.sink, maxToolRounds: 3 });
  assert.equal(r.failed, "tool_repeat");
  assert.equal(r.timings.failed, "tool_repeat");
  assert.deepEqual(h.calls.executed, ["crow_projects", "crow_projects"], "two calls ran, the forced final round's call did not");
  assert.equal(h.log.length, 3, "two tool rounds + one forced final round");
  assert.equal(h.log[2].tools.length, h.log[0].tools.length, "the final round keeps the same tool list (prefix cache)");
  assert.match(h.log[2].messages.at(-1).content, new RegExp(STOP_TOOLS_NOTE.slice(0, 30)));
  assert.deepEqual(h.calls.spoken, [FALLBACK_TEXT]);
  assert.ok(h.events.some((e) => e.type === "caption_delta" && e.text === FALLBACK_TEXT));
  assert.deepEqual(h.events.filter((e) => /^tts_/.test(e.type)).map((e) => e.type), ["tts_start", "tts_end"]);
  assert.ok(h.calls.logs.some((l) => /round 1: crow_projects/.test(l)) && h.calls.logs.some((l) => /round 2: crow_projects/.test(l)));
  assert.ok(h.calls.logs.some((l) => /turn failed \(tool_repeat\).*crow_projects:ok → crow_projects:ok/.test(l)));
  assert.ok(!h.calls.logs.some((l) => /secret-arg/.test(l)), "no tool arguments in the logs");
  assert.deepEqual(r.timings.tools, ["crow_projects:ok", "crow_projects:ok"], "each call's outcome, never its arguments");
  // The saved conversation is a clean exchange: no looping tool chatter, no stop note.
  const saved = h.runner.convo.get(h.device.id);
  assert.deepEqual(saved.map((m) => m.role), ["user", "assistant"]);
  assert.equal(saved[1].content, FALLBACK_TEXT);
});

test("stall fix: varied tools hit the round cap (3); the forced final answer is spoken and the turn does not fail", async () => {
  const h = harness({ chatTools: ["crow_projects", "crow_blog", "crow_sharing"],
    rounds: [call("a", "crow_projects"), call("b", "crow_blog"), call("c", "crow_sharing"), [{ type: "content_delta", text: "Crack it over a bowl." }, { type: "done" }]] });
  const r = await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "egg yolk?", sink: h.sink, maxToolRounds: 3 });
  assert.equal(r.failed, null);
  assert.deepEqual(h.calls.executed, ["crow_projects", "crow_blog", "crow_sharing"]);
  assert.match(h.log[3].messages.at(-1).content, /Tool limit reached/);
  assert.deepEqual(h.calls.spoken, ["Crack it over a bowl."]);
  assert.ok(!h.runner.convo.get(h.device.id).some((m) => typeof m.content === "string" && m.content.includes("Tool limit reached")), "the stop note never reaches the saved conversation");
});

test("stall fix: round cap with an empty final answer → fallback (tool_rounds), in the display's language", async () => {
  const h = harness({ chatTools: ["crow_projects", "crow_blog", "crow_sharing"],
    rounds: [call("a", "crow_projects"), call("b", "crow_blog"), call("c", "crow_sharing"), [{ type: "done" }]] });
  const es = "Lo siento, me atasqué con esa. Intenta preguntarme otra vez.";
  const r = await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "¿yema?", sink: h.sink, maxToolRounds: 3, fallbackText: es });
  assert.equal(r.failed, "tool_rounds");
  assert.deepEqual(h.calls.spoken, [es]);
  assert.ok(h.events.some((e) => e.type === "caption_delta" && e.text === es));
});

test("stall fix: an empty reply (no text, no tool call) speaks the fallback and is recorded as failed", async () => {
  const h = harness({ rounds: [[{ type: "content_delta", text: "<think>hmm</think>" }, { type: "done" }]] });
  const r = await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "what rhymes with orange", sink: h.sink });
  assert.equal(r.failed, "no_text");
  assert.deepEqual(h.calls.spoken, [FALLBACK_TEXT]);
  assert.ok(h.events.some((e) => e.type === "caption_delta" && e.text === FALLBACK_TEXT));
});

test("stall fix: the cap keeps legitimate tool use — timer set + spoken confirm, and two display calls in a row (progress), never cut", async () => {
  const wmCalls = [];
  const extra = { definition: { name: "crow_wm", description: "wm", inputSchema: { type: "object" } }, execute: async (a) => { wmCalls.push(a); return '{"ok":true,"action":"open"}'; } };
  const h = harness({ rounds: [call("w1", "crow_wm", { command: "timer 5 minutes pasta" }), [{ type: "content_delta", text: "Pasta timer set." }, { type: "done" }]] });
  const r = await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "set a pasta timer for five minutes", sink: h.sink, extraTools: [extra], maxToolRounds: 3 });
  assert.equal(r.failed, null);
  assert.deepEqual(h.calls.spoken, ["Pasta timer set."]);
  const two = harness({ rounds: [call("w1", "crow_wm", { command: "timer 5 minutes pasta" }), call("w2", "crow_wm", { command: "timer 9 minutes sauce" }), [{ type: "content_delta", text: "Both timers are running." }, { type: "done" }]] });
  const r2 = await two.runner.runVoiceTurn({ db: {}, device: two.device, transcript: "pasta five, sauce nine", sink: two.sink, extraTools: [extra], maxToolRounds: 3 });
  assert.equal(r2.failed, null, "a display call that changed the screen is progress, so the same tool twice is not a loop");
  assert.equal(two.log.length, 3);
  assert.ok(!two.log[2].messages.at(-1).content.includes("Tool limit reached"));
  assert.deepEqual(two.calls.spoken, ["Both timers are running."]);
  // A silent display action (timer set, no words) is not a failure either.
  const quiet = harness({ rounds: [call("w1", "crow_wm", { command: "timer 1 minute" }), [{ type: "done" }]] });
  const r3 = await quiet.runner.runVoiceTurn({ db: {}, device: quiet.device, transcript: "one minute timer", sink: quiet.sink, extraTools: [extra], maxToolRounds: 3 });
  assert.equal(r3.failed, null);
  assert.deepEqual(quiet.calls.spoken, []);
});

test("stall fix: first-audio budget — a model that never answers is cut and the fallback is spoken (no silence)", async () => {
  const h = harness({ rounds: [[{ type: "hang" }]] });
  const t = performance.now();
  const r = await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "hello?", sink: h.sink, firstAudioBudgetMs: 40 });
  assert.ok(performance.now() - t < 1000);
  assert.equal(r.failed, "budget");
  assert.equal(r.aborted, false);
  assert.deepEqual(h.calls.spoken, [FALLBACK_TEXT]);
  assert.ok(!h.events.some((e) => e.type === "error"), "the budget's provider abort is not a turn_failed error");
});

test("stall fix: first-audio budget on an escalated turn — 'One moment.' is followed by the fallback", async () => {
  const h = harness({ route: "escalate", probe: () => false, rounds: [[{ type: "hang" }]] });
  const r = await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "set a timer", sink: h.sink, firstAudioBudgetMs: 40 });
  assert.equal(r.failed, "budget");
  assert.deepEqual(h.calls.spoken, [FILLER_TEXT, FALLBACK_TEXT]);
});

test("stall fix: the budget also bounds a slow remote tool; it never fires once answer audio has started; a barge-in is not a failure", async () => {
  const h = harness({ rounds: [call("a", "crow_projects")] });
  h.deps.createToolExecutor = () => ({ executeToolCalls: () => new Promise(() => {}), close: async () => {} });
  const r = await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "find it", sink: h.sink, firstAudioBudgetMs: 40 });
  assert.equal(r.failed, "budget");
  assert.deepEqual(h.calls.spoken, [FALLBACK_TEXT]);

  const ok = harness({ rounds: [[{ type: "content_delta", text: "Here we go. " }, { type: "done" }]] });
  const r2 = await ok.runner.runVoiceTurn({ db: {}, device: ok.device, transcript: "go", sink: ok.sink, firstAudioBudgetMs: 40 });
  await new Promise((res) => setTimeout(res, 60));
  assert.equal(r2.failed, null);
  assert.deepEqual(ok.calls.spoken, ["Here we go."]);

  const ac = new AbortController();
  const b = harness({ rounds: [[{ type: "hang" }]] });
  setTimeout(() => ac.abort(), 10);
  const r3 = await b.runner.runVoiceTurn({ db: {}, device: b.device, transcript: "go", sink: b.sink, signal: ac.signal, firstAudioBudgetMs: 200 });
  assert.equal(r3.aborted, true);
  assert.equal(r3.failed, null);
  assert.deepEqual(b.calls.spoken, []);
});

// --- review fixes (adversarial review of the stall fix) ---

test("review 1: the budget firing during the final flush (TTS ends cleanly on abort) still speaks the fallback", async () => {
  const h = harness({ rounds: [[{ type: "content_delta", text: "No sentence end here" }, { type: "done" }]] });
  h.deps.createTtsAdapter = async () => ({ name: "kokoro", async *synthesize(text, voice, o) {
    if (text === FALLBACK_TEXT) { h.calls.spoken.push(text); yield Buffer.from(text); return; }
    await new Promise((res) => (o.signal?.aborted ? res() : o.signal?.addEventListener("abort", res, { once: true })));   // slow, ends cleanly
  } });
  const r = await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "hm", sink: h.sink, firstAudioBudgetMs: 40 });
  assert.equal(r.failed, "budget");
  assert.deepEqual(h.calls.spoken, [FALLBACK_TEXT]);
  assert.ok(h.events.some((e) => e.type === "caption_delta" && e.text === ` ${FALLBACK_TEXT}`), "joins the shown caption with a space");
});

test("review 2/5: a silent forced final round after a real spoken answer, or after display changes, is not a failure", async () => {
  const h = harness({ chatTools: ["crow_projects", "crow_blog", "crow_sharing"],
    rounds: [call("a", "crow_projects"), [{ type: "content_delta", text: "It's 72 and sunny. " }, ...call("b", "crow_blog")], call("c", "crow_sharing"), [{ type: "done" }]] });
  const r = await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "weather?", sink: h.sink, maxToolRounds: 3 });
  assert.equal(r.failed, null);
  assert.deepEqual(h.calls.spoken, ["It's 72 and sunny."]);
  // A short preamble then a loop still gets the fallback.
  const p = harness({ rounds: [[{ type: "content_delta", text: "Let me check. " }, ...call("a", "crow_projects")], call("b", "crow_projects"), call("c", "crow_projects"), [{ type: "done" }]] });
  const rp = await p.runner.runVoiceTurn({ db: {}, device: p.device, transcript: "x", sink: p.sink, maxToolRounds: 3 });
  assert.ok(rp.failed, "preamble-only turn still fails");
  assert.equal(p.calls.spoken.at(-1), FALLBACK_TEXT);
  // Three display changes then a silent final round: the screen changed, no apology.
  const extra = { definition: { name: "crow_wm", description: "wm", inputSchema: { type: "object" } }, execute: async () => '{"ok":true,"action":"open"}' };
  const d = harness({ rounds: [call("w1", "crow_wm"), call("w2", "crow_wm"), call("w3", "crow_wm"), [{ type: "done" }]] });
  const rd = await d.runner.runVoiceTurn({ db: {}, device: d.device, transcript: "three timers", sink: d.sink, extraTools: [extra], maxToolRounds: 3 });
  assert.equal(rd.failed, null);
  assert.deepEqual(d.calls.spoken, []);
});

test("review 3: a budget cut during the escalation wait is degraded='budget' (not 'aborted') with no filler warning", async () => {
  const h = harness({ route: "escalate", probe: () => false });
  h.deps.sleep = (ms) => new Promise((res) => setTimeout(res, 5));   // real-time probe loop so the budget lands inside it
  h.deps.now = (() => { const t0 = Date.now(); return () => 1_000 + (Date.now() - t0); })();
  const runner = createVoiceTurnRunner(h.deps);   // the runner reads now/sleep at creation
  const r = await runner.runVoiceTurn({ db: {}, device: h.device, transcript: "set a timer", sink: h.sink, firstAudioBudgetMs: 40 });
  assert.equal(r.failed, "budget");
  assert.equal(r.degraded, "budget");
  assert.equal(r.timings.filler_error, undefined);
  assert.equal(h.calls.spoken.at(-1), FALLBACK_TEXT);
});

test("review 4: a barge-in over the fallback line marks the turn aborted, not failed", async () => {
  const ac = new AbortController();
  const h = harness({ rounds: [[{ type: "done" }]] });
  const orig = h.sink.audio;
  h.sink.audio = (b) => { orig(b); ac.abort(); };
  const r = await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "x", sink: h.sink, signal: ac.signal });
  assert.equal(r.aborted, true);
  assert.equal(r.failed, null);
  assert.equal(r.timings.failed, undefined);
});

// ── Prompt fit (a bound assistant whose skills do not fit the quick voice model) ──────────────────
const FAST_CTX = 8192;
const estOf = (entry) => Math.ceil((JSON.stringify(entry.messages).length + JSON.stringify(entry.toolDefs).length) / 3.2);
/** A general assistant with many skills: ~35k tokens of skill text behind a short persona. */
const bigBot = (over = {}) => ({ bot_id: "general", display_name: "General", fast_voice_model: "crow-voice/qwen3.5-4b", skills_text: "SKILL ".repeat(19_000), ...over });

test("prompt fit: skills that overflow the 8,192 context are left out — the request fits, the system message is stable, one log line per display", async () => {
  const h = harness({ bot: bigBot(), ctx: FAST_CTX, rounds: [[{ type: "content_delta", text: "Lisbon. " }, { type: "done" }], [{ type: "content_delta", text: "Madrid. " }, { type: "done" }]] });
  const r = await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "capital of Portugal?", sink: h.sink, promptSuffix: "KIOSK" });
  assert.equal(h.log.length, 1, "the turn ran");
  assert.equal(h.log[0].messages[0].content, "PERSONA:General\n\nKIOSK", "persona + suffix kept, skill bodies gone");
  assert.ok(estOf(h.log[0]) + 128 + 64 <= FAST_CTX, `request estimate ${estOf(h.log[0])} is inside the context`);
  assert.ok(h.log[0].opts.maxTokens > 64, "a real completion budget, not the 64-token floor");
  assert.equal(r.failed, null);
  assert.equal(r.timings.prompt_fit, "no_skills");
  assert.ok(r.timings.est_prompt_tokens + r.timings.max_tokens + 128 <= FAST_CTX);
  assert.deepEqual(h.calls.spoken, ["Lisbon."]);
  await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "and Spain?", sink: h.sink, promptSuffix: "KIOSK" });
  assert.equal(h.log[1].messages[0].content, h.log[0].messages[0].content, "byte-stable system message at this fit level");
  const lines = h.calls.logs.filter((l) => /without its skills/.test(l));
  assert.equal(lines.length, 1, "logged once per display, not every turn");
  assert.match(lines[0], /kiosk-a/); assert.match(lines[0], /general/); assert.match(lines[0], /8192/);
  assert.match(lines[0], /~\d{5} prompt tokens/, "the numbers are in the line");
});

test("prompt fit: a prompt that fits is sent unchanged (skills kept, no prompt_fit in the timings)", async () => {
  const bot = bigBot({ skills_text: "SKILL ".repeat(200) });
  const h = harness({ bot, ctx: FAST_CTX });
  const r = await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "hi", sink: h.sink, promptSuffix: "KIOSK" });
  assert.equal(h.log[0].messages[0].content, `PERSONA:General\n\n${bot.skills_text}\n\nKIOSK`);
  assert.equal(r.timings.prompt_fit, undefined);
  assert.equal(h.log[0].opts.maxTokens, 600);
  assert.ok(!h.calls.logs.some((l) => /skills/.test(l)));
});

test("prompt fit: unknown context → today's behaviour (full prompt, default completion)", async () => {
  const h = harness({ bot: bigBot(), ctx: null });
  const r = await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "hi", sink: h.sink });
  assert.match(h.log[0].messages[0].content, /SKILL SKILL/);
  assert.equal(h.log[0].opts.maxTokens, 600);
  assert.equal(r.failed, null);
  assert.equal(r.timings.prompt_fit, undefined);
});

test("prompt fit: too large even without skills → NO model call; the specific line is spoken and captioned; error bot_too_large (not recoverable); failed = bot_too_large", async () => {
  const h = harness({ bot: bigBot({ display_name: "P".repeat(40_000) }), ctx: FAST_CTX });
  const line = "Este asistente es demasiado grande.";
  const r = await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "hi", sink: h.sink, tooLargeText: line, firstAudioBudgetMs: 12_000 });
  assert.equal(h.log.length, 0, "no request reached the model");
  assert.equal(r.failed, "bot_too_large");
  assert.equal(r.timings.failed, "bot_too_large");
  assert.equal(r.timings.prompt_fit, "too_large");
  assert.ok(r.timings.est_prompt_tokens > FAST_CTX);
  assert.equal(r.route, "fast");
  assert.deepEqual(h.calls.spoken, [line]);
  assert.deepEqual(h.events.filter((e) => e.type === "caption_delta").map((e) => e.text), [line]);
  const errs = h.events.filter((e) => e.type === "error");
  assert.deepEqual(errs, [{ type: "error", code: "bot_too_large", recoverable: false }]);
  assert.ok(h.events.findIndex((e) => e.type === "tts_end") < h.events.indexOf(errs[0]), "the error follows the spoken line (the page replaces the caption with its own string)");
  assert.deepEqual(h.runner.convo.get("kiosk-a"), [], "nothing is saved");
  assert.ok(h.calls.logs.some((l) => /too large/.test(l) && /general/.test(l) && /8192/.test(l)));
  // Default line when the caller passes none.
  const d = harness({ bot: bigBot({ display_name: "P".repeat(40_000) }), ctx: FAST_CTX });
  await d.runner.runVoiceTurn({ db: {}, device: d.device, transcript: "hi", sink: d.sink });
  assert.deepEqual(d.calls.spoken, [BOT_TOO_LARGE_TEXT]);
});

test("prompt fit: the escalated route is checked against the escalation model's context (full prompt there; too large there → no call)", async () => {
  const ctx = (key) => (key === "crow-chat/qwen3.6-35b-a3b" ? 131_072 : FAST_CTX);
  const h = harness({ bot: bigBot(), ctx, route: "escalate", probe: () => true });
  const r = await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "search my notes", sink: h.sink });
  assert.equal(r.escalated, true);
  assert.match(h.log[0].messages[0].content, /SKILL SKILL/, "the larger model takes the full prompt");
  assert.equal(r.timings.prompt_fit, undefined);
  // Escalation unavailable → the fast model, with the fast model's fit (no skills) and the degraded note.
  const cold = harness({ bot: bigBot(), ctx, route: "escalate", acquire: async () => { throw Object.assign(new Error("reserved"), { code: "box_reserved" }); } });
  const rc = await cold.runner.runVoiceTurn({ db: {}, device: cold.device, transcript: "search my notes", sink: cold.sink });
  assert.equal(rc.degraded, "box_reserved");
  assert.equal(rc.timings.prompt_fit, "no_skills");
  assert.doesNotMatch(cold.log[0].messages[0].content, /SKILL SKILL/);
  assert.match(cold.log[0].messages[0].content, /^PERSONA:General\n\nThe larger model is not available/);
  assert.ok(estOf(cold.log[0]) + 192 <= FAST_CTX);
  // Too large for the escalation model as well.
  const small = harness({ bot: bigBot(), ctx: (key) => (key === "crow-chat/qwen3.6-35b-a3b" ? 16_384 : FAST_CTX), route: "escalate", probe: () => true });
  const rs = await small.runner.runVoiceTurn({ db: {}, device: small.device, transcript: "search my notes", sink: small.sink });
  assert.equal(rs.escalated, true);
  assert.equal(rs.timings.prompt_fit, "no_skills", "35k tokens of skills do not fit 16k either");
  assert.ok(estOf(small.log[0]) + 192 <= 16_384);
});

test("prompt fit: a later tool round that no longer fits is never sent — the turn ends on the fallback line (context_full)", async () => {
  const h = harness({ ctx: FAST_CTX, chatTools: ["crow_projects"], rounds: [
    [{ type: "tool_call", id: "t1", name: "crow_projects", arguments: { action: "list_sources" } }, { type: "done" }],
    [{ type: "content_delta", text: "never sent" }, { type: "done" }],
  ] });
  h.deps.createToolExecutor = () => ({ executeToolCalls: async (tcs) => tcs.map((t) => ({ id: t.id, name: t.name, result: "R".repeat(40_000) })), close: async () => {} });
  const runner = createVoiceTurnRunner(h.deps);
  const r = await runner.runVoiceTurn({ db: {}, device: h.device, transcript: "list my sources", sink: h.sink, fallbackText: "FALLBACK" });
  assert.equal(h.log.length, 1, "round 2 (≈12.5k tokens against 8,192) was not sent");
  assert.equal(r.failed, "context_full");
  assert.deepEqual(h.calls.spoken, ["FALLBACK"]);
  assert.ok(!h.events.some((e) => e.type === "error"));
  assert.deepEqual(runner.convo.get("kiosk-a").map((m) => m.content), ["list my sources", "FALLBACK"], "the oversized tool result is not saved");
  assert.ok(h.calls.logs.some((l) => /turn failed \(context_full\)/.test(l)));
});

test("prompt fit: saved history never pushes a fitting bot over — the oldest exchanges are dropped, the system and the current question stay", async () => {
  const answer = "W".repeat(5000) + ". ";
  const h = harness({ ctx: FAST_CTX, rounds: Array.from({ length: 8 }, () => [{ type: "content_delta", text: answer }, { type: "done" }]) });
  let r = null;
  for (let i = 0; i < 8; i++) r = await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: `question ${i}`, sink: h.sink });
  for (const [i, entry] of h.log.entries()) {
    assert.ok(estOf(entry) + 192 <= FAST_CTX, `turn ${i}: estimate ${estOf(entry)} stays inside the context`);
    assert.equal(entry.messages[0].role, "system");
    assert.equal(entry.messages.at(-1).content, `question ${i}`);
    assert.ok(entry.opts.maxTokens >= 64);
  }
  const last = h.log.at(-1).messages;
  assert.equal(last[1].role, "user", "trimmed history still starts on a user message");
  assert.ok(last.length < 2 + 7 * 2, "older exchanges were dropped");
  assert.ok(last.length > 2, "recent history is kept");
  assert.ok(r.timings.history_dropped >= 2);
  assert.equal(r.failed, null);
  assert.equal(h.log.length, 8, "every turn ran");
});

test("prompt fit: a question that cannot fit even with no history is not sent (context_full)", async () => {
  const h = harness({ ctx: FAST_CTX });
  const r = await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "hi", sink: h.sink, turnContext: "C".repeat(40_000), fallbackText: "FALLBACK" });
  assert.equal(h.log.length, 0);
  assert.equal(r.failed, "context_full");
  assert.deepEqual(h.calls.spoken, ["FALLBACK"]);
});

test("a real provider error keeps turn_failed and is logged server-side with its message", async () => {
  const h = harness();
  h.deps.createChatAdapter = async () => ({ async *chatStream() { throw new Error("upstream 400: context length exceeded"); } });
  const runner = createVoiceTurnRunner(h.deps);
  const r = await runner.runVoiceTurn({ db: {}, device: h.device, transcript: "hi", sink: h.sink });
  assert.equal(r.failed, "error");
  assert.ok(h.events.some((e) => e.type === "error" && e.code === "turn_failed" && e.recoverable === true));
  assert.ok(h.calls.logs.some((l) => /kiosk-a/.test(l) && /upstream 400: context length exceeded/.test(l)), "the gateway log names the cause");
});

test("assessBot: the bind-time fit check runs the turn's own ladder (tools filtered the same way, fast model's context)", async () => {
  const keys = [];
  const mk = (bot) => harness({ bot, ctx: (key) => { keys.push(key); return FAST_CTX; } });
  const opts = { db: {}, extraTools: [{ definition: { name: "crow_wm", description: "show", inputSchema: { type: "object" } }, execute: async () => "{}" }], denyTools: ["crow_delegate"], promptSuffix: "KIOSK" };
  const small = mk(bigBot({ skills_text: "" }));
  const a = await small.runner.assessBot({ ...opts, botId: "general" });
  assert.equal(a.level, "full");
  assert.equal(a.ctx, FAST_CTX);
  assert.equal(a.model, "crow-voice/qwen3.5-4b");
  assert.deepEqual(keys, ["crow-voice/qwen3.5-4b"]);
  assert.equal((await mk(bigBot()).runner.assessBot({ ...opts, botId: "general" })).level, "no_skills");
  const big = await mk(bigBot({ display_name: "P".repeat(40_000) })).runner.assessBot({ ...opts, botId: "general" });
  assert.equal(big.level, "too_large");
  assert.ok(big.est_tokens > FAST_CTX && big.est_no_skills_tokens > FAST_CTX - 1024);
  assert.equal(await small.runner.assessBot({ ...opts, botId: "missing" }), null, "an unknown or disabled bot has no fit");
  // The estimate matches what the turn would send: same system message, same tool list (memory off, deny applied, extra added).
  const t = mk(bigBot({ skills_text: "" }));
  await t.runner.runVoiceTurn({ db: {}, device: t.device, transcript: "hi", sink: t.sink, extraTools: opts.extraTools, denyTools: opts.denyTools, promptSuffix: "KIOSK" });
  assert.equal(a.est_tokens, Math.ceil((JSON.stringify([t.log[0].messages[0]]).length + JSON.stringify(t.log[0].toolDefs).length) / 3.2));
  const withMem = await small.runner.assessBot({ ...opts, botId: "general", memoryOn: true });
  assert.ok(withMem.est_tokens > a.est_tokens, "memory on adds the memory tool to the estimate");
});

// ── Live test 2026-10-04: every plain question ran two crow_wm rounds (7.2 s) and left junk cards ──
/** A display tool offered only when the plain transcript asks for it (the kiosk's crow_wm). */
function displayTool(seen = []) {
  return {
    definition: { name: "crow_wm", description: "show", inputSchema: { type: "object" } },
    when: (t) => /timer|show me/i.test(t),
    execute: async (args, turn) => { seen.push({ args, turn }); return JSON.stringify({ ok: true }); },
  };
}

test("an extra tool with when(): plain questions never see it and end in ONE model round; display questions do", async () => {
  for (const q of ["Tell me a joke", "What time is it?"]) {
    const h = harness({ chatTools: ["crow_projects"], rounds: [[{ type: "content_delta", text: "Here you go. " }, { type: "done" }]] });
    const r = await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: q, sink: h.sink, extraTools: [displayTool()], turnContext: "[Display] Open windows: none. show me a timer" });
    assert.deepEqual(h.log[0].tools, ["crow_projects"], `${q}: the display tool is not offered (and the context prefix never counts)`);
    assert.equal(h.log.length, 1, `${q}: one model round`);
    assert.equal(r.failed, null);
    assert.equal(r.timings.tool_rounds, undefined);
  }
  for (const q of ["set a timer for one minute and label it check", "show me the shopping list"]) {
    const seen = [];
    const h = harness({ chatTools: ["crow_projects"], rounds: [[{ type: "tool_call", id: "w1", name: "crow_wm", arguments: { command: "timer 1 minute check" } }, { type: "done" }], [{ type: "content_delta", text: "Done. " }, { type: "done" }]] });
    await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: q, sink: h.sink, extraTools: [displayTool(seen)], turnContext: "[Display] Open windows: none." });
    assert.deepEqual(h.log[0].tools, ["crow_projects", "crow_wm"], q);
    assert.deepEqual(seen, [{ args: { command: "timer 1 minute check" }, turn: { transcript: q } }], "the tool gets the plain transcript, never the context prefix");
  }
});

test("an extra tool that was not offered is refused if force-called: never executed, the model is told to answer aloud, and the next turn is not 'tool context'", async () => {
  const seen = [];
  const h = harness({ chatTools: [], rounds: [
    [{ type: "tool_call", id: "w1", name: "crow_wm", arguments: { command: "display Info | a joke" } }, { type: "done" }],
    [{ type: "content_delta", text: "Why did the crow cross the road? " }, { type: "done" }],
    [{ type: "content_delta", text: "Lisbon. " }, { type: "done" }],
  ] });
  const r = await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "Tell me a joke", sink: h.sink, extraTools: [displayTool(seen)] });
  assert.deepEqual(seen, [], "never executed: nothing can be opened");
  assert.deepEqual(h.log[0].tools, [], "nothing was offered");
  const refusal = h.log[1].messages.at(-1);
  assert.equal(refusal.role, "tool");
  assert.match(refusal.content, /aloud/i);
  assert.match(refusal.content, /not needed/i);
  assert.equal(r.failed, null);
  assert.deepEqual(h.calls.spoken, ["Why did the crow cross the road?"]);
  await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "capital of Portugal?", sink: h.sink, extraTools: [displayTool(seen)] });
  assert.deepEqual(h.calls.routed.at(-1), ["system", "user", "assistant", "user"], "the refused call and its result are invisible to the router");
});

test("when() and routing: a bot whose only tool is the hidden display tool routes with hasTools=false; offered → true; no when() keeps today's behaviour", async () => {
  const plain = harness({ chatTools: [] });
  await plain.runner.runVoiceTurn({ db: {}, device: plain.device, transcript: "Tell me a joke", sink: plain.sink, extraTools: [displayTool()] });
  assert.deepEqual(plain.calls.hasTools, [false]);
  const shown = harness({ chatTools: [] });
  await shown.runner.runVoiceTurn({ db: {}, device: shown.device, transcript: "show me the shopping list", sink: shown.sink, extraTools: [displayTool()] });
  assert.deepEqual(shown.calls.hasTools, [true]);
  const always = harness({ chatTools: [] });
  const { when, ...noWhen } = displayTool();
  await always.runner.runVoiceTurn({ db: {}, device: always.device, transcript: "Tell me a joke", sink: always.sink, extraTools: [noWhen] });
  assert.deepEqual(always.log[0].tools, ["crow_wm"], "an extra tool without when() is always offered");
  assert.deepEqual(always.calls.hasTools, [true]);
});

test("when() and prompt fit: the fit level is decided with EVERY extra tool counted, so hiding one never flips the system message between turns", async () => {
  // A bot that fits the context only when the (large) display tool is left out.
  const wide = { ...displayTool(), definition: { name: "crow_wm", description: "D".repeat(6000), inputSchema: { type: "object" } } };
  const bot = bigBot({ skills_text: "SKILL ".repeat(3600) });   // ~6.7k tokens: inside 8,192 − 1,024 alone, outside it with the tool
  const h = harness({ bot, ctx: FAST_CTX, chatTools: [], rounds: [[{ type: "content_delta", text: "One. " }, { type: "done" }], [{ type: "content_delta", text: "Two. " }, { type: "done" }]] });
  const a = await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "Tell me a joke", sink: h.sink, extraTools: [wide] });
  const b = await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "show me the shopping list", sink: h.sink, extraTools: [wide] });
  assert.deepEqual(h.log.map((e) => e.tools.length), [0, 1]);
  assert.equal(a.timings.prompt_fit, "no_skills");
  assert.equal(b.timings.prompt_fit, "no_skills");
  assert.equal(h.log[0].messages[0].content, h.log[1].messages[0].content, "same system message whether or not the tool is offered");
  const fit = await h.runner.assessBot({ db: {}, botId: "general", extraTools: [wide] });
  assert.equal(fit.level, "no_skills", "the panel's check counts the tool the same way");
});

// ── Live re-test 2026-10-04 (kiosk 0.1.7): claimed displays, silent tool failures, memory on a plain question ──
/** A display tool as the kiosk builds it: offered on display intent, MUST run on "show me …", results carry a code. */
function mustTool(results = [], seen = []) {
  return {
    definition: { name: "crow_wm", description: "show", inputSchema: { type: "object" } },
    when: (t) => /show me|timer|close/i.test(t),
    must: (t) => /show me/i.test(t),
    mustNote: "[Display] Nothing is on the screen yet. Call crow_wm now.",
    execute: async (args) => { seen.push(args); return JSON.stringify(results.shift() ?? { ok: true, code: "ok" }); },
  };
}
const wmCall = (command, id = "w") => [{ type: "tool_call", id, name: "crow_wm", arguments: { command } }, { type: "done" }];
const says = (text) => [{ type: "content_delta", text }, { type: "done" }];
const choices = (h) => h.log.map((e) => e.opts.toolChoice ?? null);

test("outcomes: the round log and timings.tools carry name:code for every call — ok, the tool's own error code, or why the gate refused — and never arguments", async () => {
  const h = harness({ chatTools: ["crow_projects", "crow_delete_post", "crow_other"], rounds: [
    [{ type: "tool_call", id: "a", name: "crow_wm", arguments: { command: "SECRET-ARG display x" } }, { type: "tool_call", id: "b", name: "crow_projects", arguments: { action: "list" } },
      { type: "tool_call", id: "c", name: "crow_delegate", arguments: { goal: "SECRET-ARG" } }, { type: "tool_call", id: "d", name: "crow_delete_post", arguments: { id: 7 } },
      { type: "tool_call", id: "e", name: "crow_memory", arguments: { action: "search_memories" } }, { type: "tool_call", id: "f", name: "crow_other", arguments: {} }, { type: "done" }],
    says("Done. "),
  ] });
  h.deps.createToolExecutor = () => ({ executeToolCalls: async (tcs) => tcs.map((t) => ({ id: t.id, name: t.name, result: t.name === "crow_other" ? "Error: SECRET-RESULT" : "ok", isError: t.name === "crow_other" })), close: async () => {} });
  const runner = createVoiceTurnRunner(h.deps);
  const r = await runner.runVoiceTurn({ db: {}, device: h.device, transcript: "show me things", sink: h.sink, denyTools: ["crow_delegate"], extraTools: [mustTool([{ action: "error", code: "placeholder", message: "SECRET-RESULT" }])] });
  assert.deepEqual(r.timings.tools, ["crow_wm:placeholder+crow_projects:ok+crow_delegate:refused_policy+crow_delete_post:needs_confirm+crow_memory:refused_policy+crow_other:error"]);
  const line = h.calls.logs.find((l) => /round 1:/.test(l));
  assert.match(line, /kiosk-a round 1: crow_wm:placeholder, crow_projects:ok, crow_delegate:refused_policy, crow_delete_post:needs_confirm, crow_memory:refused_policy, crow_other:error$/);
  assert.ok(!h.calls.logs.some((l) => /SECRET/.test(l)), "no argument or result text in any log line");
  assert.doesNotMatch(JSON.stringify(r.timings), /SECRET/);
  // A hidden extra tool that is force-called, and an extra tool whose result has no code.
  const n = harness({ chatTools: [], rounds: [wmCall("display x"), says("Hi. ")] });
  const rn = await n.runner.runVoiceTurn({ db: {}, device: n.device, transcript: "Tell me a joke", sink: n.sink, extraTools: [mustTool()] });
  assert.deepEqual(rn.timings.tools, ["crow_wm:not_offered"]);
  const plain = harness({ chatTools: [], rounds: [wmCall("timer 1 minute"), says("Set. ")] });
  const { must, mustNote, ...basic } = mustTool([{ ok: true }]);
  const rp = await plain.runner.runVoiceTurn({ db: {}, device: plain.device, transcript: "set a timer", sink: plain.sink, extraTools: [basic] });
  assert.deepEqual(rp.timings.tools, ["crow_wm:ok"], "ok:true without a code is ok");
});

test("memory only when asked: with memories ON, memoryWhen(transcript) decides whether the memory tool is offered; a forced call is refused and never run", async () => {
  const asked = [];
  const memoryWhen = (t) => { asked.push(t); return /remember/i.test(t); };
  const mk = (rounds) => { const h = harness({ rounds }); h.device.kiosk_settings.memory_integration = true; return h; };
  const plain = mk([[{ type: "tool_call", id: "m1", name: "crow_memory", arguments: { action: "search_memories", params: { query: "date" } } }, { type: "done" }], says("It is Sunday. ")]);
  const r = await plain.runner.runVoiceTurn({ db: {}, device: plain.device, transcript: "What's today's date?", sink: plain.sink, memoryWhen, turnContext: "[Now] remember this prefix is never the transcript" });
  assert.deepEqual(asked, ["What's today's date?"], "asked with the plain transcript");
  assert.deepEqual(plain.log[0].tools, ["crow_projects", "crow_delegate"], "no memory tool on a plain question");
  assert.deepEqual(plain.calls.executed, [], "a forced memory call never runs");
  assert.match(plain.log[1].messages.at(-1).content, /did not ask/i);
  assert.match(plain.log[1].messages.at(-1).content, /aloud/i);
  assert.deepEqual(r.timings.tools, ["crow_memory:not_offered"]);
  await plain.runner.runVoiceTurn({ db: {}, device: plain.device, transcript: "capital of Portugal?", sink: plain.sink, memoryWhen });
  assert.deepEqual(plain.calls.routed.at(-1), ["system", "user", "assistant", "user"], "the refused call is not 'recent tool context' for the router");
  const recall = mk([[{ type: "tool_call", id: "m1", name: "crow_memory", arguments: { action: "search_memories", params: { query: "wifi" } } }, { type: "done" }], says("It is on the fridge. ")]);
  const rr = await recall.runner.runVoiceTurn({ db: {}, device: recall.device, transcript: "Do you remember the wifi password?", sink: recall.sink, memoryWhen });
  assert.deepEqual(recall.log[0].tools, ["crow_memory", "crow_projects", "crow_delegate"]);
  assert.deepEqual(recall.calls.executed, ["crow_memory"]);
  assert.deepEqual(rr.timings.tools, ["crow_memory:ok"]);
  // No memoryWhen (another caller): memories ON offers the tool on every turn, as before. Memories OFF never asks.
  const always = mk([says("Hi. ")]);
  await always.runner.runVoiceTurn({ db: {}, device: always.device, transcript: "hello", sink: always.sink });
  assert.deepEqual(always.log[0].tools, ["crow_memory", "crow_projects", "crow_delegate"]);
  const off = harness();
  let n = 0;
  await off.runner.runVoiceTurn({ db: {}, device: off.device, transcript: "remember this", sink: off.sink, memoryWhen: () => { n++; return true; } });
  assert.deepEqual(off.log[0].tools, ["crow_projects", "crow_delegate"]);
  assert.equal(n, 0);
});

test("memory only when asked: the prompt-fit level still counts the memory tool, so it cannot flip between a plain and a recall turn", async () => {
  const bot = bigBot({ skills_text: "SKILL ".repeat(3700) });
  const h = harness({ bot, ctx: FAST_CTX, chatTools: ["crow_memory"], rounds: [says("One. "), says("Two. ")] });
  h.deps.getChatTools = () => [{ name: "crow_memory", description: "M".repeat(2500), inputSchema: { type: "object" } }];
  h.device.kiosk_settings.memory_integration = true;
  const runner = createVoiceTurnRunner(h.deps);
  const memoryWhen = (t) => /remember/.test(t);
  const a = await runner.runVoiceTurn({ db: {}, device: h.device, transcript: "hello", sink: h.sink, memoryWhen });
  const b = await runner.runVoiceTurn({ db: {}, device: h.device, transcript: "remember milk", sink: h.sink, memoryWhen });
  assert.deepEqual(h.log.map((e) => e.tools.length), [0, 1]);
  assert.equal(a.timings.prompt_fit, b.timings.prompt_fit);
  assert.equal(h.log[0].messages[0].content, h.log[1].messages[0].content);
});

test("must-run tool, the only tool offered: the first round carries tool_choice for it; once it has run, later rounds do not; the confirmation is spoken", async () => {
  const seen = [];
  const h = harness({ chatTools: [], rounds: [wmCall("display Fruits | apples"), says("Here are three fruits. ")] });
  const r = await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "Show me a list of three fruits.", sink: h.sink, extraTools: [mustTool([], seen)] });
  assert.deepEqual(choices(h), [{ name: "crow_wm" }, null]);
  assert.deepEqual(seen, [{ command: "display Fruits | apples" }]);
  assert.deepEqual(h.calls.spoken, ["Here are three fruits."]);
  assert.equal(r.failed, null);
  assert.equal(r.timings.tool_choice, "named");
  assert.equal(r.timings.display_missed, undefined);
  assert.deepEqual(r.timings.tools, ["crow_wm:ok"]);
});

test("must-run: not a must turn (or no must tool) → no tool_choice and text streams as before", async () => {
  const h = harness({ chatTools: [], rounds: [says("Closed. ")] });
  const r = await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "close that", sink: h.sink, extraTools: [mustTool()] });
  assert.deepEqual(choices(h), [null]);
  assert.deepEqual(h.calls.spoken, ["Closed."]);
  assert.equal(r.timings.tool_choice, undefined);
});

test("must-run with other tools offered: nothing is forced (the model may need to fetch first), but the backstop still applies", async () => {
  const h = harness({ chatTools: ["crow_projects"], rounds: [
    [{ type: "tool_call", id: "p", name: "crow_projects", arguments: { action: "list_notes" } }, { type: "done" }],
    wmCall("display Notes | buy milk"), says("Your notes are up. "),
  ] });
  const r = await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "show me my notes", sink: h.sink, extraTools: [mustTool()] });
  assert.deepEqual(choices(h), [null, null, null]);
  assert.equal(r.timings.tool_choice, "none");
  assert.deepEqual(r.timings.tools, ["crow_projects:ok", "crow_wm:ok"]);
  assert.deepEqual(h.calls.spoken, ["Your notes are up."]);
  assert.equal(r.failed, null);
});

test("must-run: a backend that REJECTS a named tool_choice gets 'required', then none — remembered per model, so later turns send no rejected request", async () => {
  const h = harness({ chatTools: [] });
  const sent = [];
  const reject = new Set(["named"]);
  h.deps.createChatAdapter = async () => ({ async *chatStream(messages, tools, opts) {
    const kind = opts.toolChoice ? (typeof opts.toolChoice === "string" ? opts.toolChoice : "named") : "none";
    sent.push(kind);
    if (reject.has(kind)) throw Object.assign(new Error("Provider error (400): tool_choice not supported"), { code: "provider_error", status: 400 });
    if (messages.at(-1).role === "tool") { yield { type: "content_delta", text: "It is up. " }; yield { type: "done" }; return; }
    yield { type: "tool_call", id: "w", name: "crow_wm", arguments: { command: "display A | b" } }; yield { type: "done" };
  } });
  const runner = createVoiceTurnRunner(h.deps);
  const ask = () => runner.runVoiceTurn({ db: {}, device: h.device, transcript: "show me a list", sink: h.sink, extraTools: [mustTool()] });
  const r1 = await ask();
  assert.deepEqual(sent, ["named", "required", "none"]);
  assert.equal(r1.failed, null);
  assert.equal(r1.timings.tool_choice, "required");
  assert.ok(h.calls.logs.some((l) => /tool_choice/.test(l) && /named/.test(l) && /400/.test(l)));
  sent.length = 0;
  await ask();
  assert.deepEqual(sent, ["required", "none"], "the named form is not tried again on this model");
  reject.add("required");
  sent.length = 0;
  const r3 = await ask();
  assert.deepEqual(sent, ["required", "none", "none"], "'required' rejected too → the same round is sent without tool_choice");
  assert.equal(r3.failed, null);
  sent.length = 0;
  const r4 = await ask();
  assert.deepEqual(sent, ["none", "none"]);
  assert.equal(r4.timings.tool_choice, "none");
});

test("must-run: any other provider failure on a forced round is still a turn_failed (never retried as if tool_choice were the problem)", async () => {
  const h = harness({ chatTools: [] });
  let n = 0;
  h.deps.createChatAdapter = async () => ({ async *chatStream() { n++; throw Object.assign(new Error("Provider error (503): overloaded"), { code: "provider_error", status: 503 }); } });
  const runner = createVoiceTurnRunner(h.deps);
  const r = await runner.runVoiceTurn({ db: {}, device: h.device, transcript: "show me a list", sink: h.sink, extraTools: [mustTool()] });
  assert.equal(n, 1);
  assert.equal(r.failed, "error");
  // Only a "bad request" (400 / 422) can mean "this tool_choice form is not accepted": a 403 is not retried.
  const f = harness({ chatTools: [] });
  let m = 0;
  f.deps.createChatAdapter = async () => ({ async *chatStream() { m++; throw Object.assign(new Error("Provider error (403): forbidden"), { code: "provider_error", status: 403 }); } });
  const rf = await createVoiceTurnRunner(f.deps).runVoiceTurn({ db: {}, device: f.device, transcript: "show me a list", sink: f.sink, extraTools: [mustTool()] });
  assert.equal(m, 1);
  assert.equal(rf.failed, "error");
  // A 400 that is NOT about tool_choice (every form fails): the turn fails, and nothing is remembered —
  // the next turn asks for the named tool again.
  const b = harness({ chatTools: [] });
  const sent = [];
  let broken = true;
  b.deps.createChatAdapter = async () => ({ async *chatStream(messages, tools, opts) {
    sent.push(opts.toolChoice ? (typeof opts.toolChoice === "string" ? opts.toolChoice : "named") : "none");
    if (broken) throw Object.assign(new Error("Provider error (400): bad request"), { code: "provider_error", status: 400 });
    if (messages.at(-1).role === "tool") { yield { type: "content_delta", text: "Up. " }; yield { type: "done" }; return; }
    yield { type: "tool_call", id: "w", name: "crow_wm", arguments: { command: "display A | b" } }; yield { type: "done" };
  } });
  const br = createVoiceTurnRunner(b.deps);
  const r1 = await br.runVoiceTurn({ db: {}, device: b.device, transcript: "show me a list", sink: b.sink, extraTools: [mustTool()] });
  assert.deepEqual(sent, ["named", "required", "none"]);
  assert.equal(r1.failed, "error");
  broken = false; sent.length = 0;
  const r2 = await br.runVoiceTurn({ db: {}, device: b.device, transcript: "show me a list", sink: b.sink, extraTools: [mustTool()] });
  assert.deepEqual(sent, ["named", "none"], "still asks by name");
  assert.equal(r2.failed, null);
});

test("must-run backstop: a model that only CLAIMS the display (no call) is never heard — one corrective round with the tool's note, then the real confirmation", async () => {
  const seen = [];
  const h = harness({ chatTools: [], rounds: [says("I've displayed a list of three fruits for you. "), wmCall("display Fruits | apples, bananas, cherries"), says("The list is on the screen. ")] });
  const r = await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "Show me a list of three fruits.", sink: h.sink, extraTools: [mustTool([], seen)], turnContext: "[Display] Open windows: content 'Shopping list'." });
  assert.equal(h.log.length, 3);
  assert.deepEqual(h.calls.spoken, ["The list is on the screen."], "the false claim was never spoken");
  assert.ok(!h.events.some((e) => e.type === "caption_delta" && /I've displayed/.test(e.text)), "nor captioned");
  // The corrective round: same tools, the false claim is not in the request, the note rides on the last message.
  assert.deepEqual(h.log[1].tools, h.log[0].tools);
  assert.deepEqual(h.log[1].messages.map((m) => m.role), ["system", "user"]);
  assert.match(h.log[1].messages.at(-1).content, /Show me a list of three fruits\.\n\n\[Display\] Nothing is on the screen yet\. Call crow_wm now\.$/);
  assert.equal(h.log[1].messages[0].content, h.log[0].messages[0].content, "the system message is untouched");
  assert.deepEqual(choices(h), [{ name: "crow_wm" }, { name: "crow_wm" }, null]);
  assert.equal(seen.length, 1);
  assert.equal(r.failed, null);
  assert.equal(r.timings.display_corrected, true);
  assert.equal(r.timings.display_missed, undefined);
  // Nothing of the detour is saved: no false claim, no note.
  const saved = h.runner.convo.get("kiosk-a");
  assert.ok(!saved.some((m) => /I've displayed|Nothing is on the screen/.test(String(m.content))));
  assert.equal(saved[0].content, "Show me a list of three fruits.");
});

test("must-run backstop: no display after the corrective round either → the turn does not end on a false claim; the truthful line is spoken, display_missed is recorded", async () => {
  const h = harness({ chatTools: [], rounds: [says("I've displayed a list of three fruits for you. "), says("Done! The fruits are on your screen now. ")] });
  const r = await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "Show me a list of three fruits.", sink: h.sink, extraTools: [mustTool()], displayMissedText: "No pude ponerlo en la pantalla.", fallbackText: "FALLBACK" });
  assert.equal(h.log.length, 2, "one corrective round, no more");
  assert.deepEqual(h.calls.spoken, ["No pude ponerlo en la pantalla."]);
  assert.deepEqual(h.events.filter((e) => e.type === "caption_delta").map((e) => e.text), ["No pude ponerlo en la pantalla."]);
  assert.equal(r.failed, "display_missed");
  assert.equal(r.timings.display_missed, true);
  assert.equal(r.timings.display_corrected, true);
  assert.ok(!h.events.some((e) => e.type === "error"));
  assert.deepEqual(h.runner.convo.get("kiosk-a").map((m) => m.content), ["Show me a list of three fruits.", "No pude ponerlo en la pantalla."]);
  assert.ok(h.calls.logs.some((l) => /turn failed \(display_missed\)/.test(l)));
  const d = harness({ chatTools: [], rounds: [says("Shown. "), says("Shown. ")] });
  await d.runner.runVoiceTurn({ db: {}, device: d.device, transcript: "show me a list", sink: d.sink, extraTools: [mustTool()] });
  assert.deepEqual(d.calls.spoken, [DISPLAY_MISSED_TEXT], "a default line when the caller passes none");
});

test("must-run: a failed command gets ONE retry (the round cap leaves room for it); words spoken around a failed call are held back", async () => {
  const seen = [];
  const h = harness({ chatTools: [], rounds: [
    [{ type: "content_delta", text: "Here is your list. " }, { type: "tool_call", id: "w1", name: "crow_wm", arguments: { command: "show Fruits | apples" } }, { type: "done" }],
    wmCall("display Fruits | apples, bananas, cherries", "w2"),
    says("Three fruits are on the screen. "),
  ] });
  const r = await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "Show me a list of three fruits.", sink: h.sink, maxToolRounds: 3, extraTools: [mustTool([{ action: "error", code: "unknown_command", message: "Use: display Shopping list | milk" }], seen)] });
  assert.equal(h.log.length, 3);
  assert.match(h.log[1].messages.at(-1).content, /Use: display Shopping list \| milk/, "the model sees which form to use");
  assert.deepEqual(choices(h), [{ name: "crow_wm" }, { name: "crow_wm" }, null], "still required on the retry");
  assert.deepEqual(seen.map((a) => a.command), ["show Fruits | apples", "display Fruits | apples, bananas, cherries"]);
  assert.deepEqual(h.calls.spoken, ["Three fruits are on the screen."], "'Here is your list.' was said before anything was shown: held back");
  assert.ok(!h.runner.convo.get("kiosk-a").some((m) => /Here is your list/.test(String(m.content))), "and what was never heard is not saved as if it had been said");
  assert.equal(h.log[1].messages.find((m) => m.role === "assistant").content, "", "nor shown back to the model as its own words");
  assert.deepEqual(r.timings.tools, ["crow_wm:unknown_command", "crow_wm:ok"]);
  assert.equal(r.failed, null);
  assert.equal(r.timings.display_missed, undefined);
});

test("must-run: the retry fails too → no third attempt and no wasted answer round; the truthful line", async () => {
  const seen = [];
  const e = { action: "error", code: "unknown_command", message: "Use: display …" };
  const h = harness({ chatTools: [], rounds: [wmCall("show a"), wmCall("show b"), says("never requested")] });
  const r = await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "Show me a list of three fruits.", sink: h.sink, maxToolRounds: 3, extraTools: [mustTool([e, { ...e }], seen)], displayMissedText: "MISSED" });
  assert.equal(h.log.length, 2);
  assert.equal(seen.length, 2);
  assert.deepEqual(h.calls.spoken, ["MISSED"]);
  assert.equal(r.failed, "display_missed");
  assert.deepEqual(r.timings.tools, ["crow_wm:unknown_command", "crow_wm:unknown_command"]);
});

test("must-run: a failed command followed by a text-only answer still gets the corrective round (the note rides on the tool result)", async () => {
  const h = harness({ chatTools: [], rounds: [wmCall("show a"), says("Here are three fruits: apples, bananas and cherries. "), wmCall("display Fruits | apples", "w2"), says("They are on the screen. ")] });
  const r = await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "Show me a list of three fruits.", sink: h.sink, maxToolRounds: 3, extraTools: [mustTool([{ action: "error", code: "unknown_command", message: "Use: display" }])] });
  assert.equal(h.log.length, 4);
  assert.equal(h.log[2].messages.at(-1).role, "tool");
  assert.match(h.log[2].messages.at(-1).content, /^\{.*unknown_command.*\}\n\n\[Display\] Nothing is on the screen yet/s);
  assert.deepEqual(h.calls.spoken, ["They are on the screen."]);
  assert.equal(r.failed, null);
  assert.ok(!h.runner.convo.get("kiosk-a").some((m) => /Nothing is on the screen yet|Here are three fruits/.test(String(m.content))), "the note and the unspoken answer are not saved");
});

test("must-run: barge-in and the first-audio budget keep their own endings", async () => {
  const ac = new AbortController();
  const h = harness({ chatTools: [], rounds: [says("I've displayed it. "), says("Done. ")] });
  const tool = mustTool();
  const orig = h.deps.createChatAdapter;
  let n = 0;
  h.deps.createChatAdapter = async (k) => { const a = await orig(k); return { async *chatStream(...args) { if (++n === 2) ac.abort(); yield* a.chatStream(...args); } }; };
  const runner = createVoiceTurnRunner(h.deps);
  const r = await runner.runVoiceTurn({ db: {}, device: h.device, transcript: "show me a list", sink: h.sink, signal: ac.signal, extraTools: [tool] });
  assert.equal(r.aborted, true);
  assert.equal(r.failed, null);
  assert.deepEqual(h.calls.spoken, []);
  // A forced round that never answers: the budget's own fallback, not display_missed.
  const slow = harness({ chatTools: [], rounds: [[{ type: "hang" }]] });
  const rs = await slow.runner.runVoiceTurn({ db: {}, device: slow.device, transcript: "show me a list", sink: slow.sink, extraTools: [mustTool()], firstAudioBudgetMs: 40, displayMissedText: "MISSED" });
  assert.equal(rs.failed, "budget");
  assert.deepEqual(slow.calls.spoken, [FALLBACK_TEXT]);
  assert.equal(rs.timings.display_missed, undefined);
});

test("must-run: the tool says which result counts (mustDone) — an ok that put nothing new up (a close) does not satisfy the turn", async () => {
  const seen = [];
  const tool = { ...mustTool([{ ok: true, code: "ok", action: "close" }, { ok: true, code: "ok", action: "open" }], seen), mustDone: (r) => r?.ok === true && r.action === "open" };
  const h = harness({ chatTools: [], rounds: [wmCall("close"), wmCall("display A | b", "w2"), says("It is up. ")] });
  const r = await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "show me a list", sink: h.sink, maxToolRounds: 3, extraTools: [tool] });
  assert.deepEqual(choices(h), [{ name: "crow_wm" }, { name: "crow_wm" }, null], "still required after the close");
  assert.deepEqual(r.timings.tools, ["crow_wm:ok", "crow_wm:ok"]);
  assert.deepEqual(h.calls.spoken, ["It is up."]);
  assert.equal(r.failed, null);
  const only = harness({ chatTools: [], rounds: [wmCall("close"), says("Closed it. "), says("Closed it. ")] });
  const ro = await only.runner.runVoiceTurn({ db: {}, device: only.device, transcript: "show me a list", sink: only.sink, extraTools: [{ ...mustTool([{ ok: true, action: "close" }]), mustDone: (x) => x?.action === "open" }], displayMissedText: "MISSED" });
  assert.equal(ro.failed, "display_missed");
  assert.deepEqual(only.calls.spoken, ["MISSED"]);
});

// ── Endpoint-neutral options: memory permission from the caller, a camera the endpoint supplies, a result hook ──
test("memoryOn from the caller decides memory, whatever kiosk_settings says; without it the display setting decides as before", async () => {
  const mem = [[{ type: "tool_call", id: "m", name: "crow_memory", arguments: { action: "search_memories" } }, { type: "done" }], says("Noted. ")];
  const on = harness({ rounds: mem });
  on.device.kiosk_settings = undefined;   // not a display: no kiosk settings at all
  await on.runner.runVoiceTurn({ db: {}, device: on.device, transcript: "remember the gate code", sink: on.sink, memoryOn: true });
  assert.ok(on.log[0].tools.includes("crow_memory"), "offered");
  assert.deepEqual(on.calls.executed, ["crow_memory"]);
  const off = harness({ rounds: mem });
  off.device.kiosk_settings = { memory_integration: true };
  await off.runner.runVoiceTurn({ db: {}, device: off.device, transcript: "remember the gate code", sink: off.sink, memoryOn: false });
  assert.ok(!off.log[0].tools.includes("crow_memory"), "the caller said no");
  assert.deepEqual(off.calls.executed, []);
  const legacy = harness({ rounds: mem });
  legacy.device.kiosk_settings = { memory_integration: true };
  await legacy.runner.runVoiceTurn({ db: {}, device: legacy.device, transcript: "remember the gate code", sink: legacy.sink });
  assert.deepEqual(legacy.calls.executed, ["crow_memory"], "no memoryOn: the display setting still decides");
});

test("the camera tool: refused on every turn that does not supply it; runs (in process) on a turn whose endpoint supplies it as an extra tool", async () => {
  const call = [[{ type: "tool_call", id: "c", name: "crow_glasses_capture_photo", arguments: {} }, { type: "done" }], says("It is a red mug. ")];
  const none = harness({ rounds: call });
  const r0 = await none.runner.runVoiceTurn({ db: {}, device: none.device, transcript: "what is this", sink: none.sink });
  assert.ok(!none.log[0].tools.includes("crow_glasses_capture_photo"), "never advertised by default");
  assert.deepEqual(none.calls.executed, [], "and never executed");
  assert.match(r0.timings.tools[0], /crow_glasses_capture_photo:refused_policy/);
  const ran = [];
  const cam = harness({ rounds: call });
  const camera = { definition: { name: "crow_glasses_capture_photo", description: "camera", inputSchema: { type: "object" } }, when: () => true, must: () => true,
    execute: async (args, ctx) => { ran.push(ctx.transcript); return JSON.stringify({ ok: true, description: "a red mug" }); } };
  const r1 = await cam.runner.runVoiceTurn({ db: {}, device: cam.device, transcript: "what is this", sink: cam.sink, extraTools: [camera] });
  assert.deepEqual(cam.log[0].tools.filter((n) => n === "crow_glasses_capture_photo"), ["crow_glasses_capture_photo"], "advertised once: the endpoint's definition replaces the generic one");
  assert.deepEqual(ran, ["what is this"]);
  assert.deepEqual(cam.calls.executed, [], "it ran in process, not through the tool executor");
  assert.equal(r1.failed, null);
  assert.match(r1.timings.tools[0], /crow_glasses_capture_photo:ok/);
});

test("onToolResult: the replacement is what the model reads and what is saved; in-process tools and refused calls never pass through it; a throwing hook changes nothing", async () => {
  const seen = [];
  const h = harness({ chatTools: ["crow_projects", "crow_delegate"], rounds: [[{ type: "tool_call", id: "p", name: "crow_projects", arguments: { action: "x" } }, { type: "tool_call", id: "d", name: "crow_delegate", arguments: {} }, { type: "done" }], says("Done. ")] });
  h.deps.createToolExecutor = () => ({ executeToolCalls: async (tcs) => tcs.map((t) => ({ id: t.id, name: t.name, result: JSON.stringify({ ok: true, _audio_stream: { url: "https://media.example.invalid/secret?token=abc", codec: "mp3" }, prose: "Playing it." }) })), close: async () => {} });
  await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "list my projects", sink: h.sink, denyTools: ["crow_delegate"],
    onToolResult: async ({ name, result }) => { seen.push(name); return "Playing it."; } });
  assert.deepEqual(seen, ["crow_projects"], "only executor results reach the hook; the refused call does not");
  const toolMsg = h.log[1].messages.find((m) => m.role === "tool" && m.tool_name === "crow_projects");
  assert.equal(toolMsg.content, "Playing it.");
  assert.ok(!JSON.stringify(h.log[1].messages).includes("token=abc"), "the envelope never reaches the model");
  assert.ok(!JSON.stringify(h.runner.convo.get(h.device.id)).includes("token=abc"), "nor the saved conversation");
  const t = harness({ chatTools: ["crow_projects"], rounds: [[{ type: "tool_call", id: "p", name: "crow_projects", arguments: { action: "x" } }, { type: "done" }], says("Done. ")] });
  await t.runner.runVoiceTurn({ db: {}, device: t.device, transcript: "list projects", sink: t.sink, onToolResult: async () => { throw new Error("boom"); } });
  assert.equal(t.log[1].messages.find((m) => m.role === "tool").content, "ok", "the original result stands");
});

// ── Only what was offered runs (every voice turn: kiosk, glasses, any endpoint) ──
test("offered tools only: a call to a tool the turn did not offer is refused (not_offered) and never executed; an offered category's own action and an offered tool still run", async () => {
  const call = (name, args = {}) => [{ type: "tool_call", id: name, name, arguments: args }, { type: "done" }];
  const off = harness({ chatTools: ["crow_memory"], rounds: [call("crow_create_project", { name: "INJECTED" }), says("I can't do that here. ")] });
  off.device.kiosk_settings = { memory_integration: true };
  const r0 = await off.runner.runVoiceTurn({ db: {}, device: off.device, transcript: "remember this", sink: off.sink });
  assert.deepEqual(off.calls.executed, [], "never reached the executor");
  assert.deepEqual(r0.timings.tools, ["crow_create_project:not_offered"]);
  assert.match(off.log[1].messages.at(-1).content, /is not available here/);
  const wrapped = harness({ chatTools: ["crow_memory"], rounds: [call("crow_tools", { action: "fw_play", params: {} }), says("No. ")] });
  wrapped.device.kiosk_settings = { memory_integration: true };
  await wrapped.runner.runVoiceTurn({ db: {}, device: wrapped.device, transcript: "remember this", sink: wrapped.sink });
  assert.deepEqual(wrapped.calls.executed, [], "the add-on wrapper was not offered either");
  const on = harness({ chatTools: ["crow_projects"], rounds: [call("crow_list_projects"), call("crow_projects", { action: "list_projects" }), says("Two projects. ")] });
  await on.runner.runVoiceTurn({ db: {}, device: on.device, transcript: "list my projects", sink: on.sink });
  assert.deepEqual(on.calls.executed, ["crow_list_projects", "crow_projects"], "an action of an offered category, and the category tool itself");
});

test("wasOffered: own name, an offered category's action, a selected add-on behind an offered wrapper; nothing else", () => {
  const cat = (n) => toolCategoryOf(n);
  const offered = new Set(["crow_memory", "crow_tools", "crow_glasses_capture_photo"]);
  const sel = (n) => n === "fw_play";
  assert.equal(wasOffered({ name: "crow_glasses_capture_photo" }, offered), true);
  assert.equal(wasOffered({ name: "crow_store_memory" }, offered, { categoryOf: cat }), true);
  assert.equal(wasOffered({ name: "store_memory" }, offered, { categoryOf: cat }), true);
  assert.equal(wasOffered({ name: "crow_create_project" }, offered, { categoryOf: cat }), false);
  assert.equal(wasOffered({ name: "fw_play" }, offered, { categoryOf: cat, selectedAddon: sel }), true);
  assert.equal(wasOffered({ name: "fw_delete_playlist" }, offered, { categoryOf: cat, selectedAddon: sel }), false);
  assert.equal(wasOffered({ name: "fw_play" }, new Set(["crow_memory"]), { categoryOf: cat, selectedAddon: sel }), false, "no wrapper offered: no add-on by name");
  assert.equal(wasOffered({ name: "" }, offered), false);
  assert.equal(wasOffered({ name: "crow_create_project" }, new Set(["crow_glasses_capture_photo"]), { categoryOf: cat }), false, "a photo turn offers the camera only");
});

test("onToolResult contract: { name, tool, result, isError }; tool is the unwrapped name of a proxy call", async () => {
  const seen = [];
  const h = harness({ chatTools: ["crow_projects"], rounds: [[{ type: "tool_call", id: "p", name: "crow_projects", arguments: { action: "list_projects" } }, { type: "done" }], says("Done. ")] });
  h.deps.createToolExecutor = () => ({ executeToolCalls: async (tcs) => tcs.map((t) => ({ id: t.id, name: t.name, result: "boom", isError: true })), close: async () => {} });
  await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "list projects", sink: h.sink, onToolResult: async (a) => { seen.push(a); } });
  assert.deepEqual(seen, [{ name: "crow_projects", tool: "crow_list_projects", result: "boom", isError: true }]);
});

// Live 2026-10-05 (kiosk, quick model): "Okay." was answered with the turn context read back.
const ECHO_CTX = "[Now] Monday, October 5, 2026, 7:23 PM (time zone America/Chicago)\n[Display] Open windows: none.";
const ECHO_LIVE = "[Now] Monday, October 5, 2026, 7:23 PM (time zone America/Chicago) [Display] Open windows: none. Got it. Is there anything specific you'd like me to help with?";
const ECHO_ANSWER = "Got it. Is there anything specific you'd like me to help with?";
/** The live reply as stream deltas cut at the given positions (inside the tags and the lines). */
const deltasAt = (s, cuts) => [0, ...cuts, s.length].slice(0, -1).map((a, i, arr) => ({ type: "content_delta", text: s.slice(a, [...cuts, s.length][i]) }));

test("live 2026-10-05: an echoed [Now]/[Display] context is never spoken, captioned or saved — chunks cut inside the tags", async () => {
  for (const cuts of [[3], [2, 9, 40, 72, 77, 81], [...Array(ECHO_LIVE.length).keys()].slice(1)]) {
    const h = harness({ rounds: [[...deltasAt(ECHO_LIVE, cuts), { type: "done" }]] });
    const r = await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "Okay.", sink: h.sink, turnContext: ECHO_CTX });
    assert.equal(r.failed, null);
    const caption = h.events.filter((e) => e.type === "caption_delta").map((e) => e.text).join("");
    assert.equal(caption, ECHO_ANSWER, `captions, cuts ${cuts.length}`);
    assert.equal(h.calls.spoken.join(" "), ECHO_ANSWER, `speech, cuts ${cuts.length}`);
    assert.doesNotMatch(Buffer.concat(h.audio).toString(), /\[(Now|Display)\]|October|Open windows/);
    const saved = h.runner.convo.get(h.device.id);
    assert.deepEqual(saved.map((m) => m.content), ["Okay.", ECHO_ANSWER], "the saved exchange has the plain transcript and the clean answer (an echo kept in history invites the next one)");
  }
});

test("the turn context reaches the model on the user message, closed by the note line, the user's words last; the system message never carries it", async () => {
  const h = harness();
  await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "Okay.", sink: h.sink, turnContext: ECHO_CTX, promptSuffix: "KIOSK" });
  assert.equal(h.log[0].messages.at(-1).content, `${ECHO_CTX}\n${TURN_CONTEXT_NOTE}\n\nOkay.`);
  assert.equal(h.log[0].messages[0].content, "PERSONA:House\n\nKIOSK", "the system message stays byte-stable (prefix cache)");
  const plain = harness();
  await plain.runner.runVoiceTurn({ db: {}, device: plain.device, transcript: "Okay.", sink: plain.sink });
  assert.equal(plain.log[0].messages.at(-1).content, "Okay.", "no context, no note");
});

test("an echo of the context inside a display tool's arguments never reaches the card; other brackets do", async () => {
  const seen = [];
  const h = harness({ rounds: [
    [{ type: "tool_call", id: "w1", name: "crow_wm", arguments: { command: "display Fruit | [Display] Open windows: none. Apples [1], pears [2]" } }, { type: "done" }],
    [{ type: "content_delta", text: "Here is your list. " }, { type: "done" }],
  ] });
  await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "show me a list of fruit", sink: h.sink, extraTools: [displayTool(seen)], turnContext: ECHO_CTX });
  assert.deepEqual(seen.map((s) => s.args), [{ command: "display Fruit | Apples [1], pears [2]" }]);
});

test("an answer with ordinary brackets is spoken unchanged when a turn context is present", async () => {
  const h = harness({ rounds: [[{ type: "content_delta", text: "Press [Enter], then pick [1" }, { type: "content_delta", text: "]. Done." }, { type: "done" }]] });
  await h.runner.runVoiceTurn({ db: {}, device: h.device, transcript: "how?", sink: h.sink, turnContext: ECHO_CTX });
  assert.equal(h.events.filter((e) => e.type === "caption_delta").map((e) => e.text).join(""), "Press [Enter], then pick [1]. Done.");
});
