import { test } from "node:test";
import assert from "node:assert/strict";
import { createVoiceTurnRunner, ESCALATION_READY_TIMEOUT_MS, FILLER_TEXT } from "../servers/gateway/voice/turn.js";

/** A fake clock: sleep() advances it. */
function clock() { let t = 1_000; return { now: () => t, sleep: async (ms) => { t += ms; }, advance: (ms) => { t += ms; } }; }

/** chat adapter that plays one scripted round per chatStream call (the round index is shared by every adapter the harness hands out). */
function scriptedChat(rounds, log, state) {
  return {
    async *chatStream(messages, tools, opts) {
      log.push({ messages: messages.map((m) => ({ ...m })), tools: tools.map((t) => t.name), opts, systemAfterZero: messages.slice(1).some((m) => m.role === "system") });
      const events = rounds[state.i++] || [{ type: "done" }];
      for (const ev of events) { if (opts.signal?.aborted) return; log.pulls = (log.pulls || 0) + 1; yield ev; }
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
  const calls = { chatKeys: [], executed: [], spoken: [], sleeps: 0, acquired: [], routed: [] };
  const deps = {
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
    contextLenFor: async () => ctx,
    chooseVoiceRoute: (msgs) => (calls.routed.push(msgs.map((m) => m.role)), route === "fast" ? { route: "fast", reason: null, key: "crow-voice/qwen3.5-4b" } : { route: "escalate", reason: "tool-intent", key: "crow-chat/qwen3.6-35b-a3b" }),
    fastKey: "crow-voice/qwen3.5-4b",
    getChatTools: () => chatTools.map((name) => ({ name, description: name, inputSchema: { type: "object" } })),
    createToolExecutor: () => ({ executeToolCalls: async (tcs) => { calls.executed.push(...tcs.map((t) => t.name)); return tcs.map((t) => ({ id: t.id, name: t.name, result: "ok" })); }, close: async () => {} }),
    maxToolRounds: 10,
    effectiveToolName: (tc) => (/^crow_(memory|projects|blog)$/.test(tc.name) && tc.arguments?.action ? "crow_" + String(tc.arguments.action).replace(/^crow_/, "") : tc.name),
    isExternalSendTool: () => false, isConnectedAddonTool: () => false, botVoiceScope: () => null,
    generateSystemPrompt: async ({ botDef }) => `PERSONA:${botDef.display_name}`,
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
  assert.equal(h.log[0].opts.signal, ac.signal, "the abort signal reaches the provider fetch");
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
  const h = harness({ rounds: [[del, { type: "done" }], [{ type: "content_delta", text: "Are you sure?" }, { type: "done" }], [del, { type: "done" }], [{ type: "content_delta", text: "Deleted." }, { type: "done" }]] });
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
  assert.match(h.log.at(-1).messages.at(-1).content, /^Open windows: timer 'Tea' 1:59 left\.\n\ncapital of Portugal\?$/);
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
    const h = harness({ rounds: [[{ type: "tool_call", id: "b1", name, arguments: args }, { type: "done" }], [{ type: "content_delta", text: "Ok." }, { type: "done" }]], chatTools: ["crow_projects"] });
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
  assert.match(h.log.at(-1).messages.at(-1).content, /^\[Display\] Open windows: none\.\n\nWhat is the capital of Portugal\?$/, "the model still gets the context");
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
