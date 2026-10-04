/**
 * Transport-free voice turn (kiosk spec 2026-10-03 §7.1, D14). The reusable
 * core of the Meta Glasses loop: STT → bound bot (persona, botVoiceScope,
 * permission policy, fast_voice_model) → route (chooseVoiceRoute; escalation
 * with filler + 8 s cold fallback) → streamed tool loop with the <think> gate
 * → sentence-chunked TTS. Every dependency is injected (defaultVoiceDeps()
 * wires the real ones) so tests run on fakes. Glasses does NOT use this yet.
 *
 * NO AUDIO IS STORED: `opts.audio` is handed to the STT adapter and dropped.
 */
import {
  createThinkGate, createSentenceChunker, createConfirmGate, createConvoStore,
  negotiatePcm, pcmStream, isDestructiveTool, describeDestructiveAction,
} from "./turn-helpers.js";

export const ESCALATION_READY_TIMEOUT_MS = 8000;
export const ESCALATION_PROBE_EVERY_MS = 500;
export const FILLER_TEXT = "One moment.";
export const BOT_CACHE_TTL_MS = 30_000;
const DEGRADED_NOTE = "The larger model is not available right now. Answer with what you have, and call a tool directly if one is needed.";
// A denied discovery call keeps the turn going: the schemas are already in the tool list.
const SOFT_DENY = { crow_discover: "Tool discovery is not needed here: every tool you can use is already listed with its parameters. Call the right tool directly, or answer from what you know." };
const MEMORY_OFF = "Memory is turned off on this display. Tell the user you can't use saved memories here, then end your turn — do not call another tool.";

export function createVoiceTurnRunner(deps) {
  const now = deps.now || Date.now;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const convo = deps.convo || createConvoStore({ now });
  const confirm = deps.confirm || createConfirmGate({ now });
  const botCache = new Map();
  const fillerCache = new Map();
  // Saved-history messages the router must not count as "recent tool context":
  // in-process display-tool calls and calls the gate REFUSED (denied tools such as
  // crow_discover, policy/confirm refusals). The convo store keeps these objects
  // by reference, so the mark survives into later turns (smoke 2026-10-04: a
  // refused/looping crow_discover escalated the next three plain questions).
  const routeNeutral = new WeakSet();

  async function loadBot(db, botId) {
    if (!botId) return null;
    const hit = botCache.get(botId);
    if (hit && now() - hit.at < BOT_CACHE_TTL_MS) return hit.def;
    let def = null;
    try {
      const row = await deps.loadBotRow(db, botId);
      if (row && row.enabled) {
        def = JSON.parse(row.definition);
        if (def) def.bot_id = row.bot_id;
      }
    } catch { def = null; }
    botCache.set(botId, { def, at: now() });
    return def;
  }

  async function openTts(db, device) {
    const profile = await deps.getTtsProfile(db, device);
    if (!profile) return null;
    const adapter = await deps.createTtsAdapter(profile);
    return { profile, adapter, neg: negotiatePcm(adapter.name), voice: profile.defaultVoice };
  }

  /** A speaker bound to one turn: emits tts_start once, then audio; non-PCM = one buffer per sentence. */
  function makeSpeaker(tts, sink, signal, onChunk) {
    let started = false;
    const begin = () => {
      if (started) return;
      started = true;
      sink.event({ type: "tts_start", codec: tts.neg ? "pcm" : "mp3", sample_rate: tts.neg ? tts.neg.sampleRate : 24000 });
    };
    const emit = (buf) => { if (signal?.aborted || !buf.length) return; onChunk(); sink.audio(buf); };
    async function collect(text) {
      const parts = [];
      const stream = tts.neg ? pcmStream(tts.adapter, text, tts.voice, tts.neg, { signal }) : tts.adapter.synthesize(text, tts.voice, { signal });
      for await (const c of stream) {
        if (signal?.aborted) return null;
        if (tts.neg) { begin(); emit(Buffer.isBuffer(c) ? c : Buffer.from(c)); } else parts.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
      }
      return tts.neg ? null : Buffer.concat(parts);
    }
    const say = async (text) => {
      const t = String(text || "").trim();
      if (!t || signal?.aborted) return;
      const mp3 = await collect(t);
      if (mp3 && !signal?.aborted) { begin(); emit(mp3); }
    };
    say.filler = async () => {
      if (signal?.aborted) return;
      const key = `${tts.profile.id}|${tts.voice}|${tts.adapter.name}`;
      let buf = fillerCache.get(key);
      if (!buf) {
        const parts = [];
        const stream = tts.neg ? pcmStream(tts.adapter, FILLER_TEXT, tts.voice, tts.neg, { signal }) : tts.adapter.synthesize(FILLER_TEXT, tts.voice, { signal });
        for await (const c of stream) parts.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
        if (signal?.aborted) return;
        buf = Buffer.concat(parts);
        fillerCache.set(key, buf);
      }
      begin();
      emit(buf);
    };
    say.end = () => { if (started) sink.event({ type: "tts_end" }); };
    return say;
  }

  async function readyEscalation(key, db, signal) {
    const providerId = String(key).split("/")[0];
    let up;
    try { up = await deps.resolveKey(key); } catch { return { reason: "unresolved" }; }
    let refused = null;
    // maybeAcquireLocalProvider blocks until the model is ready, so it runs in
    // the background and we PROBE instead (ruling R14). A cold start keeps
    // going after we give up (the gateway's on-demand start, CROW-SCHEDULE.md).
    Promise.resolve().then(() => deps.acquire(providerId)).then((ok) => { if (ok === false) refused = Object.assign(new Error("acquire returned false"), { code: "acquire_failed" }); }).catch((err) => { refused = err || new Error("acquire failed"); });
    const deadline = now() + ESCALATION_READY_TIMEOUT_MS;
    while (now() < deadline) {
      if (signal?.aborted) return { reason: "aborted" };
      await new Promise((r) => setImmediate(r));   // lets a background acquire rejection/false land before the first probe
      if (refused) {
        const code = refused.code;
        return { reason: code === "box_reserved" ? "box_reserved" : code === "serving_class_refused" ? "serving_class" : "acquire_failed" };
      }
      if (await deps.probeReady(up.baseUrl)) return { adapter: await deps.createChatAdapter(key, db) };
      await sleep(ESCALATION_PROBE_EVERY_MS);
    }
    return { reason: "cold_timeout" };
  }

  async function runVoiceTurn(opts) {
    const { db, device, sink, signal } = opts;
    const t0 = now();
    const timings = {};
    const result = { transcript: "", route: null, fastPath: false, escalated: false, degraded: null, aborted: false, timings };
    const mark = (k) => { if (timings[k] == null) timings[k] = now() - t0; };
    const aborted = () => signal?.aborted === true;
    const fail = (code, recoverable = true, message) => sink.event({ type: "error", code, recoverable, ...(message ? { message } : {}) });
    let executor = null;
    try {
      // 1. STT (the WAV is only ever passed to the adapter; never written anywhere)
      let transcript = opts.transcript;
      if (transcript == null) {
        const sttProfile = await deps.getSttProfile(db, device);
        if (!sttProfile) { fail("no_stt_profile", false); return result; }
        const stt = await deps.createSttAdapter(sttProfile);
        // opts.sttModel(profile): a per-display model override (kiosk: tiny.en), or null for the profile's own.
        const model = typeof opts.sttModel === "function" ? opts.sttModel(sttProfile) : null;
        const r = await stt.transcribe(opts.audio, { filename: "turn.wav", contentType: "audio/wav", language: sttProfile.language || undefined, signal, ...(model ? { model } : {}) });
        transcript = String(r?.text || "").trim();
        mark("stt_ms");
      }
      result.transcript = transcript;
      sink.event({ type: "transcript_final", text: transcript });
      if (aborted()) { result.aborted = true; return result; }
      if (!transcript) { fail("empty_transcript"); return result; }

      const tts = await openTts(db, device);
      if (!tts) { fail("no_tts_profile", false); return result; }
      const say = makeSpeaker(tts, sink, signal, () => mark("tts_first_chunk_ms"));

      // 2. Fast paths (no LLM)
      if (typeof opts.fastPaths === "function") {
        const fp = await opts.fastPaths(transcript);
        if (fp) {
          result.fastPath = true;
          for (const ev of fp.events || []) sink.event(ev);
          if (fp.say) { sink.event({ type: "caption_delta", text: fp.say }); await say(fp.say); }
          say.end();
          convo.save(device.id, [...convo.get(device.id), { role: "user", content: transcript }, { role: "assistant", content: fp.say || "" }]);
          return result;
        }
      }

      // 3. The bound bot drives the turn (ruling R11: no profile fallback)
      const bot = await loadBot(db, device.bound_bot_id);
      if (!bot) { fail("no_bound_bot", false); return result; }
      const memoryOn = device.kiosk_settings?.memory_integration === true;
      const extra = Array.isArray(opts.extraTools) ? opts.extraTools : [];
      const extraByName = new Map(extra.map((x) => [x.definition.name, x]));
      // denyTools (kiosk: crow_delegate, crow_job_status — review C3): never advertised AND
      // refused by the gate below even if force-called, so a room cannot hand work to
      // another bot (crow_delegate's `bot` arg accepts ANY enabled bot) or read it back.
      const deny = new Set(["crow_glasses_capture_photo", ...(Array.isArray(opts.denyTools) ? opts.denyTools : [])]);
      const tools = deps.getChatTools({ botDef: bot })
        .filter((t) => !deny.has(t.name) && (memoryOn || t.name !== "crow_memory") && !extraByName.has(t.name))
        .concat(extra.map((x) => x.definition));
      executor = deps.createToolExecutor({ botDef: bot });
      // No deviceId: generateSystemPrompt stamps it as a "glasses device_id" for
      // crow_glasses_* tools, and no kiosk tool takes a device_id.
      const system = await deps.generateSystemPrompt({ botDef: bot });
      // The system message stays byte-stable turn to turn (vLLM prefix cache, review M6);
      // live state (e.g. open windows) rides on THIS turn's user message only and is
      // dropped from the saved conversation.
      const userMsg = { role: "user", content: opts.turnContext ? `${opts.turnContext}\n\n${transcript}` : transcript };
      const messages = [
        { role: "system", content: opts.promptSuffix ? `${system}\n\n${opts.promptSuffix}` : system },
        ...convo.get(device.id),
        userMsg,
      ];

      // 4. Route — on a view WITHOUT in-process display-tool turns (review M5): a
      // crow_wm timer must not make the next 2-3 plain questions "recent tool context"
      // and send them to the (possibly cold) 35B.
      const isExtraCall = (m) => {
        if (routeNeutral.has(m)) return true;
        if (m.role === "tool") return extraByName.has(m.tool_name);
        if (m.role !== "assistant" || !m.tool_calls) return false;
        try { const tc = JSON.parse(m.tool_calls); return Array.isArray(tc) && tc.length > 0 && tc.every((c) => extraByName.has(c.name)); } catch { return false; }
      };
      // The router sees the PLAIN transcript, never the turnContext prefix: "[Display] Open windows: …"
      // matched TOOL_INTENT_RE ("open") and escalated every kiosk turn to the 35B (smoke 2026-10-04).
      const routeView = messages.filter((m) => !isExtraCall(m)).map((m) => (m === userMsg ? { ...m, content: transcript } : m));
      const decision = deps.chooseVoiceRoute(routeView, { hasTools: tools.length > 0 });
      let chat = await deps.createChatAdapter(bot.fast_voice_model || deps.fastKey, db);
      result.route = "fast";
      if (decision.route === "escalate") {
        // The filler runs alongside the (real-timer) readiness wait. A handler is attached NOW
        // so a rejection during that wait is never an unhandledRejection (which would exit the
        // gateway); the error is kept, logged below, and the turn carries on without the filler.
        let fillerErr = null;
        const filler = say.filler().catch((err) => { fillerErr = err; });
        const ready = await readyEscalation(decision.key, db, signal);
        await filler;
        if (fillerErr && !aborted()) {
          console.warn(`[voice-turn] filler TTS failed: ${fillerErr.message}`);
          timings.filler_error = String(fillerErr.message || fillerErr);
        }
        if (ready.adapter) { chat = ready.adapter; result.route = "escalate"; result.escalated = true; }
        // Qwen chat templates reject a system message anywhere but first (review C1):
        // the note joins the leading system message.
        else { result.degraded = ready.reason; messages[0] = { ...messages[0], content: `${messages[0].content}\n\n${DEGRADED_NOTE}` }; }
      }
      if (aborted()) { result.aborted = true; return result; }

      // 5. Streamed tool loop
      const scope = deps.botVoiceScope(bot);
      const policy = bot.permission_policy || {};
      const shortName = (n) => String(n || "").replace(/^crow_/, "").replace(/_/g, " ");
      const policyGate = (tc) => {
        const eff = deps.effectiveToolName(tc);
        // The executor resolves a bare name (`search_memories`) to `crow_<name>`
        // (tool-executor resolveToolCategory), so every check sees both spellings.
        const names = eff && !String(eff).startsWith("crow_") ? [eff, `crow_${eff}`] : [eff];
        const soft = SOFT_DENY[tc.name] || names.map((n) => SOFT_DENY[n]).find(Boolean);
        if (soft && (deny.has(tc.name) || names.some((n) => deny.has(n)))) return soft;
        if (names.some((n) => deny.has(n)) || deny.has(tc.name)) return `"${shortName(eff)}" is not available on this display. Tell the user, then end your turn — do not call another tool.`;
        if (!memoryOn && names.some((n) => deps.isMemoryTool(n))) return MEMORY_OFF;
        if (scope && deps.isConnectedAddonTool(eff) && !scope.selectedToolNames.has(eff)) {
          return `This assistant isn't allowed to use "${shortName(eff)}" by voice. Tell the user and end your turn — do not call another tool.`;
        }
        if (policy.external_send === "draft_only" && deps.isExternalSendTool(eff)) {
          return `This assistant is draft-only by voice and cannot send "${shortName(eff)}" externally. Tell the user it was not sent. Then end your turn — do not call another tool.`;
        }
        if (Array.isArray(policy.deny) && names.some((n) => policy.deny.includes(n))) {
          return `This assistant is not permitted to use "${shortName(eff)}" by voice. Tell the user and end your turn — do not call another tool.`;
        }
        const confirmName = names.find((n) => isDestructiveTool(n) || (Array.isArray(policy.confirm) && policy.confirm.includes(n)));
        if (!confirmName) return null;
        if (confirm.check({ deviceId: device.id, eff: confirmName, args: tc.arguments, transcript }) === "allow") return null;
        return `Confirmation required. Tell the user: "Are you sure you want to ${describeDestructiveAction({ name: confirmName, arguments: tc.arguments })}? Say yes to proceed." Then end your turn — do not call another tool.`;
      };

      // First chunk = first clause (latency lever 3); later chunks are whole sentences.
      const chunker = createSentenceChunker((s) => say(s), { firstClause: opts.firstClause !== false });
      let rounds = 0;
      let nextMax = 600;
      while (rounds < (deps.maxToolRounds || 10)) {
        rounds++;
        const think = createThinkGate();
        let content = "";
        const calls = [];
        const roundMax = nextMax;
        nextMax = 600;
        // Keep prompt + completion inside the model's context (review M6: the 4B is 8192;
        // tool schemas alone are ~5k tokens). ~3.2 chars/token is a deliberate over-estimate.
        const ctx = await deps.contextLenFor(result.escalated ? decision.key : (bot.fast_voice_model || deps.fastKey), db);
        const estPrompt = Math.ceil((JSON.stringify(messages).length + JSON.stringify(tools).length) / 3.2);
        const maxTokens = ctx ? Math.max(64, Math.min(roundMax, ctx - estPrompt - 128)) : roundMax;
        timings.est_prompt_tokens = estPrompt; timings.max_tokens = maxTokens;   // in [kiosk-metrics]; the smoke records both
        for await (const ev of chat.chatStream(messages, tools, { temperature: 0.7, maxTokens, chatTemplateKwargs: { enable_thinking: false }, signal })) {
          if (aborted()) break;
          if (ev.type === "content_delta" && ev.text) {
            mark("llm_first_token_ms");
            content += ev.text;
            const spoken = think.feed(ev.text);
            if (spoken) { sink.event({ type: "caption_delta", text: spoken }); await chunker.push(spoken); }
          } else if (ev.type === "tool_call") {
            mark("llm_first_token_ms");
            calls.push({ id: ev.id, name: ev.name, arguments: ev.arguments });
          } else if (ev.type === "done") break;
        }
        if (aborted()) { result.aborted = true; break; }
        let assistantMsg = null;
        if (content || calls.length) {
          assistantMsg = { role: "assistant", content };
          if (calls.length) assistantMsg.tool_calls = JSON.stringify(calls.map((tc) => ({ id: tc.id, name: tc.name, arguments: tc.arguments })));
          messages.push(assistantMsg);
        }
        if (!calls.length) break;
        const local = [];
        const remote = [];
        // Route-neutral = in-process display tools + calls refused because the tool is not on this
        // display (deny list / memory off). Confirm and policy refusals still count as tool context:
        // the "yes" that follows a confirmation must keep its escalation (review I3).
        let neutralCalls = 0;
        for (const tc of calls) {
          const gate = policyGate(tc);
          if (gate) {
            const offDisplay = gate === MEMORY_OFF || Object.values(SOFT_DENY).includes(gate) || /is not available on this display/.test(gate);
            if (offDisplay) neutralCalls++;
            local.push({ id: tc.id, name: tc.name, result: gate, neutral: offDisplay });
            continue;
          }
          const x = extraByName.get(tc.name);
          if (x) {
            neutralCalls++;
            let out;
            try { out = await x.execute(tc.arguments || {}); } catch (err) { out = JSON.stringify({ action: "error", message: err.message }); }
            local.push({ id: tc.id, name: tc.name, result: out, neutral: true });
            continue;
          }
          remote.push(tc);
        }
        const remoteResults = remote.length ? await executor.executeToolCalls(remote) : [];
        // A text-free assistant turn whose every call was refused/in-process is neutral too.
        if (assistantMsg && !content.trim() && neutralCalls === calls.length) routeNeutral.add(assistantMsg);
        // Neutrality rides on the local result object, never on the call id (ids may be "" — review M7).
        for (const r of [...local, ...remoteResults]) {
          const toolMsg = { role: "tool", content: r.result, tool_call_id: r.id, tool_name: r.name };
          if (r.neutral === true && local.includes(r)) routeNeutral.add(toolMsg);
          messages.push(toolMsg);
          if (typeof r.result === "string" && r.result.length > 500) nextMax = 4000;
        }
      }
      if (!aborted()) await chunker.flush();
      if (aborted()) result.aborted = true;
      say.end();
      const userIdx = messages.indexOf(userMsg);
      if (userIdx >= 0) messages[userIdx] = { role: "user", content: transcript };
      convo.save(device.id, messages);
      return result;
    } catch (err) {
      if (aborted()) { result.aborted = true; return result; }
      fail("turn_failed", true, err.message);
      return result;
    } finally {
      timings.total_ms = now() - t0;
      if (executor) { try { await executor.close(); } catch {} }
    }
  }

  /** Speak text outside a turn (announce, timer done). */
  async function speakText({ db, device, text, sink, signal }) {
    const tts = await openTts(db, device);
    if (!tts) return false;
    const say = makeSpeaker(tts, sink, signal, () => {});
    await say(text);
    say.end();
    return true;
  }

  return { runVoiceTurn, speakText, convo };
}

/** The real dependencies (gateway process). Lazy so tests never load them. */
export async function defaultVoiceDeps() {
  const stt = await import("../ai/stt/index.js");
  const tts = await import("../ai/tts/index.js");
  const provider = await import("../ai/provider.js");
  const tx = await import("../ai/tool-executor.js");
  const sp = await import("../ai/system-prompt.js");
  const router = await import("../routes/llm-router.js");
  const orch = await import("../gpu-orchestrator.js");
  const { TOOL_MANIFESTS } = await import("../tool-manifests.js");
  const memoryTools = new Set(Object.keys(TOOL_MANIFESTS.memory?.tools || {}));
  const byId = (list, id) => list.find((p) => p.id === id) || null;
  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    loadBotRow: async (db, botId) => (await db.execute({ sql: "SELECT bot_id, definition, enabled FROM pi_bot_defs WHERE bot_id = ?", args: [botId] })).rows[0] || null,
    getSttProfile: async (db, device) => (device.stt_profile_id
      ? byId(await stt.getSttProfiles(db, { includeKeys: true }), device.stt_profile_id)
      : stt.getDefaultSttProfile(db, { includeKeys: true })),
    createSttAdapter: async (p) => (await stt.createSttAdapter(p)).adapter,
    getTtsProfile: async (db, device) => (device.tts_profile_id
      ? byId(await tts.getTtsProfiles(db, { includeKeys: true }), device.tts_profile_id)
      : tts.getDefaultTtsProfile(db, { includeKeys: true })),
    createTtsAdapter: async (p) => (await tts.createTtsAdapter(p)).adapter,
    createChatAdapter: async (key, db) => {
      const i = String(key).indexOf("/");
      const provider_id = i >= 0 ? key.slice(0, i) : key;
      const model_id = i >= 0 ? key.slice(i + 1) : "";
      return (await provider.createAdapterFromProfile({ provider_id, model_id }, null, db)).adapter;
    },
    resolveKey: router.resolveVoiceKey,
    probeReady: router.probeVoiceReady,
    acquire: (providerId) => orch.maybeAcquireLocalProvider(providerId, { requester: "kiosk" }),
    chooseVoiceRoute: router.chooseVoiceRoute,
    fastKey: router.VOICE_ROUTE_KEYS.fast,
    getChatTools: tx.getChatTools,
    createToolExecutor: tx.createToolExecutor,
    maxToolRounds: tx.MAX_TOOL_ROUNDS,
    effectiveToolName: tx.effectiveToolName,
    isExternalSendTool: tx.isExternalSendTool,
    isConnectedAddonTool: tx.isConnectedAddonTool,
    botVoiceScope: tx.botVoiceScope,
    generateSystemPrompt: sp.generateSystemPrompt,
    isMemoryTool: (n) => n === "crow_memory" || memoryTools.has(n),
    contextLenFor: async (key, db) => {
      try {
        const i = String(key).indexOf("/");
        const row = (await db.execute({ sql: "SELECT models FROM providers WHERE id = ?", args: [i >= 0 ? key.slice(0, i) : key] })).rows[0];
        const m = JSON.parse(row?.models || "[]").find((x) => x && (x.id === key.slice(i + 1) || i < 0));
        return Number.isFinite(m?.contextLen) ? m.contextLen : null;
      } catch { return null; }
    },
  };
}
