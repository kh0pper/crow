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
  negotiatePcm, pcmStream, isDestructiveTool, describeDestructiveAction, SENTENCE_END,
} from "./turn-helpers.js";
import { withTurnContext, createContextEchoGate, stripContextEcho, stripContextEchoDeep, TURN_CONTEXT_NOTE } from "./context-echo.js";
import { estimatePromptTokens, requestFits, choosePromptFit, dropOldestExchange } from "./prompt-fit.js";

export const ESCALATION_READY_TIMEOUT_MS = 8000;
export const ESCALATION_PROBE_EVERY_MS = 500;
export const FILLER_TEXT = "One moment.";
export const BOT_CACHE_TTL_MS = 30_000;
/** Spoken + captioned when a turn ends with no answer (tool loop, empty reply, budget); callers pass a localized one. */
export const FALLBACK_TEXT = "Sorry, I got stuck on that one. Try asking again.";
/** Spoken + captioned INSTEAD of a model call when the bound bot's prompt cannot fit the model even without its skills; callers pass a localized one. */
export const BOT_TOO_LARGE_TEXT = "This assistant is too large for the quick voice model. Choose another assistant for this display in the Kiosk settings.";
/** Rides on the last tool result before the forced final round (kept off the saved conversation). */
export const STOP_TOOLS_NOTE = "Tool limit reached for this question. Answer the user now from what you already have, in one or two short sentences. Do not call another tool.";
const DEGRADED_NOTE = "The larger model is not available right now. Answer with what you have, and call a tool directly if one is needed.";
// A denied discovery call keeps the turn going: the schemas are already in the tool list.
const SOFT_DENY = { crow_discover: "Tool discovery is not needed here: every tool you can use is already listed with its parameters. Call the right tool directly, or answer from what you know." };
// An extra tool with when(transcript) is offered only on turns that need it; a forced call on any other turn gets this.
const EXTRA_NOT_NEEDED = "Not needed for this question: nothing was done. Answer the user aloud now, in one or two short sentences. Do not call another tool.";
// Memories are on for this display, but opts.memoryWhen said this question does not ask for them.
const MEMORY_NOT_ASKED = "The user did not ask to remember or recall anything, so memory was not used. Answer the user aloud now from what you know. Do not call another tool.";
/** Spoken + captioned when a must-run display tool never succeeded: the turn must not end on a claim that something is on the screen. Callers pass a localized one. */
export const DISPLAY_MISSED_TEXT = "Sorry, I couldn't put that on the screen.";
// The corrective round's note when the must-run tool brings none of its own (rides on the last message, never saved).
const MUST_RUN_NOTE = "Nothing has been done yet: the required tool has not run successfully in this turn. Call it now with the real content, or say plainly that you could not.";
const outcomeCode = (v, fallback) => (typeof v === "string" && /^[a-z][a-z0-9_]{0,31}$/.test(v) ? v : fallback);
const logName = (n) => String(n ?? "").replace(/[^\w.-]/g, "_").slice(0, 48) || "_";
const MEMORY_OFF = "Memory is turned off on this display. Tell the user you can't use saved memories here, then end your turn — do not call another tool.";

/**
 * Only a tool OFFERED on this turn may run. The model can name any tool, and a photo, a page or a
 * tool result can tell it which (an injected "call crow_create_project" must never reach the
 * executor). A call counts as offered when:
 *  - its own name is in the turn's tool list (a category tool, an add-on tool, an endpoint's extra);
 *  - it names a core action whose category tool is in the list (small models call
 *    `crow_search_memories` instead of `crow_memory {action}`; both reach the same server);
 *  - it names a selected add-on tool directly while the `crow_tools` wrapper is offered.
 * offered: Set of tool names sent with the request. categoryOf(name) → core category | null.
 * selectedAddon(name) → true for an add-on tool the bound bot selected.
 */
export function wasOffered(tc, offered, { categoryOf = () => null, selectedAddon = () => false } = {}) {
  const name = String(tc?.name || "");
  if (!name) return false;
  if (offered.has(name)) return true;
  const cat = categoryOf(name);
  if (cat && offered.has(`crow_${cat}`)) return true;
  return offered.has("crow_tools") && selectedAddon(name) === true;
}

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
  const fitLogged = new Set();
  // Per model: the strongest tool_choice form the backend has not refused ("named" → "required" → "none").
  const toolChoiceMode = new Map();

  /** The tool list a turn advertises (also what the bind-time fit check counts). */
  function turnTools(bot, { memoryOn, extra, deny }) {
    const extraNames = new Set(extra.map((x) => x.definition.name));
    return deps.getChatTools({ botDef: bot })
      .filter((t) => !deny.has(t.name) && (memoryOn || t.name !== "crow_memory") && !extraNames.has(t.name))
      .concat(extra.map((x) => x.definition));
  }
  // The camera tool is refused unless THIS turn's endpoint supplies it as an extra tool (a session with a camera).
  const turnDeny = (denyTools, extra = []) => new Set([
    ...(extra.some((x) => x?.definition?.name === "crow_glasses_capture_photo") ? [] : ["crow_glasses_capture_photo"]),
    ...(Array.isArray(denyTools) ? denyTools : []),
  ]);
  const withSuffix = (system, suffix) => (suffix ? `${system}\n\n${suffix}` : system);

  /**
   * The fit ladder for one bot on one model (prompt-fit.js): the full system message, else the
   * one without the bot's skill bodies, else too large. `full` = an already-built full message.
   */
  async function promptFit({ db, bot, tools, promptSuffix, key, full }) {
    const ctx = await deps.contextLenFor(key, db);
    return choosePromptFit({
      ctx, tools,
      full: full ?? withSuffix(await deps.generateSystemPrompt({ botDef: bot }), promptSuffix),
      lean: async () => withSuffix(await deps.generateSystemPrompt({ botDef: bot, omitSkills: true }), promptSuffix),
    });
  }

  /**
   * Bind-time check (Kiosk panel): would this bot's voice prompt fit its quick voice model?
   * Runs the turn's own tool filter and ladder. null = no such enabled bot.
   * → { level: "full" | "no_skills" | "too_large", ctx (null = unknown), est_tokens, est_no_skills_tokens, reserve_tokens, model }
   */
  async function assessBot({ db, botId, memoryOn = false, extraTools, denyTools, promptSuffix }) {
    const bot = await loadBot(db, botId);
    if (!bot) return null;
    const key = bot.fast_voice_model || deps.fastKey;
    const extra = Array.isArray(extraTools) ? extraTools : [];
    const tools = turnTools(bot, { memoryOn, extra, deny: turnDeny(denyTools, extra) });
    const fit = await promptFit({ db, bot, tools, promptSuffix, key });
    return { level: fit.level, ctx: fit.ctx, est_tokens: fit.est, est_no_skills_tokens: fit.est_no_skills, reserve_tokens: fit.reserve, model: key };
  }

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

  /**
   * A speaker bound to one turn: emits tts_start once, then audio; non-PCM = one buffer per sentence.
   * `mute` (optional AbortSignal) silences the ANSWER (say/filler) when the turn's first-audio budget
   * runs out; say.force() ignores it, so the fallback line still plays. `signal` (barge-in/close) stops both.
   */
  function makeSpeaker(tts, sink, signal, onChunk, mute = null) {
    let started = false;
    let answered = false;
    const both = mute ? (signal ? AbortSignal.any([signal, mute]) : mute) : signal;
    const off = (hard) => signal?.aborted === true || (!hard && mute?.aborted === true);
    const begin = () => {
      if (started) return;
      started = true;
      sink.event({ type: "tts_start", codec: tts.neg ? "pcm" : "mp3", sample_rate: tts.neg ? tts.neg.sampleRate : 24000 });
    };
    const emit = (buf, hard, answer) => { if (off(hard) || !buf.length) return; onChunk(); if (answer) answered = true; sink.audio(buf); };
    async function collect(text, hard) {
      const parts = [];
      const sig = hard ? signal : both;
      const stream = tts.neg ? pcmStream(tts.adapter, text, tts.voice, tts.neg, { signal: sig }) : tts.adapter.synthesize(text, tts.voice, { signal: sig });
      for await (const c of stream) {
        if (off(hard)) return null;
        if (tts.neg) { begin(); emit(Buffer.isBuffer(c) ? c : Buffer.from(c), hard, true); } else parts.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
      }
      return tts.neg ? null : Buffer.concat(parts);
    }
    const speak = async (text, hard) => {
      const t = String(text || "").trim();
      if (!t || off(hard)) return;
      const mp3 = await collect(t, hard);
      if (mp3 && !off(hard)) { begin(); emit(mp3, hard, true); }
    };
    const say = (text) => speak(text, false);
    /** Speaks even after the answer was muted (the fallback line); a barge-in still stops it. */
    say.force = (text) => speak(text, true);
    /** Whether any answer audio (not the filler) has left the server this turn. */
    say.answered = () => answered;
    say.filler = async () => {
      if (off(false)) return;
      const key = `${tts.profile.id}|${tts.voice}|${tts.adapter.name}`;
      let buf = fillerCache.get(key);
      if (!buf) {
        const parts = [];
        const stream = tts.neg ? pcmStream(tts.adapter, FILLER_TEXT, tts.voice, tts.neg, { signal: both }) : tts.adapter.synthesize(FILLER_TEXT, tts.voice, { signal: both });
        for await (const c of stream) parts.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
        if (off(false)) return;
        buf = Buffer.concat(parts);
        fillerCache.set(key, buf);
      }
      if (off(false)) return;
      begin();
      emit(buf, false, false);
    };
    let ended = false;
    say.end = () => { if (started && !ended) { ended = true; sink.event({ type: "tts_end" }); } };
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

  /** STT only (the kiosk's early transcription, lever D). The WAV is handed to the adapter and dropped. */
  async function transcribe({ db, device, audio, signal, sttModel }) {
    const sttProfile = await deps.getSttProfile(db, device);
    if (!sttProfile) throw Object.assign(new Error("no STT profile"), { code: "no_stt_profile" });
    const stt = await deps.createSttAdapter(sttProfile);
    const model = typeof sttModel === "function" ? sttModel(sttProfile) : null;
    const r = await stt.transcribe(audio, { filename: "turn.wav", contentType: "audio/wav", language: sttProfile.language || undefined, signal, ...(model ? { model } : {}) });
    return { text: String(r?.text || "").trim() };
  }

  /**
   * opts (beyond the transport): maxToolRounds — tool-calling rounds before a forced, tool-free
   * final answer (default deps.maxToolRounds); firstAudioBudgetMs — wall-clock from the turn start
   * to the first ANSWER audio (the filler does not count), after which the answer is cut and the
   * fallback spoken (default: none); fallbackText — the localized fallback line; tooLargeText —
   * the localized line for a bot whose prompt cannot fit the model (default BOT_TOO_LARGE_TEXT);
   * memoryWhen(transcript) — with memories on, whether THIS question asks for them (default: always);
   * displayMissedText — the localized line for a must-run tool that never succeeded;
   * memoryOn (boolean) — whether memory tools may be used on this endpoint at all (default: the
   * display's kiosk_settings.memory_integration);
   * onToolResult({ name, tool, result, isError }) → string | undefined — a caller may REPLACE a remote
   * tool's result before the model reads it (and before it is saved). `name` is the tool the model
   * called, `tool` the one that really ran (a proxy call unwrapped). Never called for the caller's own
   * extraTools or for a refused call; a hook that throws, or returns anything but a string, changes nothing.
   *
   * extraTools[i] = { definition, execute(args, { transcript }) → JSON string, when?, must?, mustNote?, mustDone? }:
   *   when(transcript) false → not offered this turn (a forced call is refused, never run);
   *   must(transcript) true  → the turn must end with a successful call of this tool ({ ok: true }, or
   *     mustDone(result) when the tool says which results count):
   *     tool_choice requires it while it is the only tool offered; text is held back (not spoken)
   *     until it has run; a turn that ends without it gets ONE corrective round with mustNote on
   *     the last message; if it still has not run, displayMissedText is spoken instead of the text.
   *
   * result.failed: null | "tool_rounds" | "tool_repeat" | "no_text" | "budget" | "error"
   *   | "bot_too_large" (the bot's prompt does not fit the model even without its skills: no model call)
   *   | "context_full" (this request would not fit the context even with no saved history: not sent)
   *   | "display_missed" (a must-run tool never succeeded: the truthful line was spoken).
   * timings.prompt_fit: "no_skills" | "too_large" when the full prompt did not fit (absent when it did).
   * timings.tools: one entry per tool round, "name:code" per call joined by "+" — code is ok, error,
   *   the tool's own code (e.g. placeholder), or not_offered / refused_policy / needs_confirm. Never arguments.
   * timings.tool_choice ("named" | "required" | "none"), display_corrected, display_missed: must-run turns only.
   */
  async function runVoiceTurn(opts) {
    const { db, device, sink, signal } = opts;
    // opts.startedAt: when the turn really began (the kiosk's turn_end), so an early-STT wait counts.
    const t0 = Number.isFinite(opts.startedAt) ? opts.startedAt : now();
    const timings = {};
    const result = { transcript: "", route: null, fastPath: false, escalated: false, degraded: null, aborted: false, failed: null, timings };
    const mark = (k) => { if (timings[k] == null) timings[k] = now() - t0; };
    const aborted = () => signal?.aborted === true;
    const fail = (code, recoverable = true, message) => sink.event({ type: "error", code, recoverable, ...(message ? { message } : {}) });
    const log = deps.log || ((m) => console.log(m));
    const defaultFallbackText = String(opts.fallbackText || FALLBACK_TEXT);
    // The first-audio budget cuts the answer (LLM stream, tool wait, answer TTS) through `mute`;
    // the session `signal` (barge-in/close) is never touched by it.
    const mute = new AbortController();
    const llmSignal = signal ? AbortSignal.any([signal, mute.signal]) : mute.signal;
    let budgetHit = false;
    let budgetTimer = null;
    let budgetFired = null;
    const budgetP = new Promise((res) => { budgetFired = res; });
    let say = null;
    let history = null;
    let executor = null;
    /** Speak + caption the fallback, record the failure, and save a clean exchange (no looping tool chatter). */
    const speakFallback = async (why, spokenBefore, fallbackText = defaultFallbackText) => {
      result.failed = why;
      timings.failed = why;
      log(`[voice-turn] ${device?.id} turn failed (${why})${timings.tools ? `; tools by round: ${timings.tools.join(" → ")}` : ""}`);
      if (aborted()) { result.aborted = true; result.failed = null; delete timings.failed; return; }
      if (!say) return;
      sink.event({ type: "caption_delta", text: spokenBefore ? ` ${fallbackText}` : fallbackText });
      await say.force(fallbackText);
      // A barge-in over the apology: the turn was interrupted, not failed (the gate excludes it anyway).
      if (aborted()) { result.aborted = true; result.failed = null; delete timings.failed; return; }
      say.end();
      if (history) convo.save(device.id, [...history, { role: "user", content: result.transcript }, { role: "assistant", content: fallbackText }]);
    };
    try {
      // 1. STT (the WAV is only ever passed to the adapter; never written anywhere)
      let transcript = opts.transcript;
      if (opts.sttEarly) {
        timings.stt_early = opts.sttEarly.used ? "used" : "none";
        if (opts.sttEarly.discards) { timings.stt_early_discards = opts.sttEarly.discards; timings.stt_early_discard_ms = opts.sttEarly.discard_ms || 0; }
        if (opts.sttEarly.used && Number.isFinite(opts.sttEarly.ms)) timings.stt_early_ms = opts.sttEarly.ms;
      }
      if (transcript != null && opts.sttEarly?.used) mark("stt_ms");   // = how long the turn waited for the early transcript
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
      say = makeSpeaker(tts, sink, signal, () => mark("tts_first_chunk_ms"), mute.signal);

      // 2. Fast paths (no LLM)
      if (typeof opts.fastPaths === "function") {
        const fp = await opts.fastPaths(transcript);
        if (fp) {
          result.fastPath = true;
          if (fp.tier === "t0" || fp.tier === "t1") timings.tier = fp.tier;
          for (const ev of fp.events || []) sink.event(ev);
          if (fp.say) { sink.event({ type: "caption_delta", text: fp.say }); await say(fp.say); }
          say.end();
          // A path with nothing to say (a transport verb) leaves no exchange behind: an empty
          // assistant message would only confuse the next turn's chat template.
          if (fp.say) convo.save(device.id, [...convo.get(device.id), { role: "user", content: transcript }, { role: "assistant", content: fp.say }]);
          return result;
        }
      }

      // 3. The bound bot drives the turn (ruling R11: no profile fallback)
      const bot = await loadBot(db, device.bound_bot_id);
      if (!bot) { fail("no_bound_bot", false); return result; }
      history = convo.get(device.id);
      // First-audio budget (smoke 2026-10-04 #19: a 24.5 s silent tool loop). Counted from the turn
      // start; only answer audio stops it, so an escalation's "One moment." is followed by the fallback.
      if (Number.isFinite(opts.firstAudioBudgetMs) && opts.firstAudioBudgetMs > 0) {
        const left = Math.max(0, opts.firstAudioBudgetMs - (now() - t0));
        budgetTimer = (deps.setTimeout || setTimeout)(() => {
          if (say.answered() || aborted()) return;
          budgetHit = true;
          mute.abort();
          budgetFired();
        }, left);
      }
      // opts.memoryOn (boolean): the endpoint's own answer; without it, the display setting decides as before.
      const memoryOn = typeof opts.memoryOn === "boolean" ? opts.memoryOn : device.kiosk_settings?.memory_integration === true;
      const extra = Array.isArray(opts.extraTools) ? opts.extraTools : [];
      const extraByName = new Map(extra.map((x) => [x.definition.name, x]));
      // denyTools (kiosk: crow_delegate, crow_job_status — review C3): never advertised AND
      // refused by the gate below even if force-called, so a room cannot hand work to
      // another bot (crow_delegate's `bot` arg accepts ANY enabled bot) or read it back.
      const deny = turnDeny(opts.denyTools, extra);
      // extraTools[i].when(transcript) (kiosk: crow_wm): offered only when the PLAIN transcript
      // needs it. Live test 2026-10-04: with the display tool on every turn the 4B answered plain
      // questions through it — two tool rounds, 7 s, and a card repeating the spoken answer.
      const offered = new Set(extra.filter((x) => typeof x.when !== "function" || x.when(transcript) === true).map((x) => x.definition.name));
      const allTools = turnTools(bot, { memoryOn, extra, deny });
      // Memories on: the memory tool is offered only when the question asks to remember or recall
      // (live re-test 2026-10-04: "what's today's date" went to memory twice — 11.5 s).
      const memoryOffered = memoryOn && (typeof opts.memoryWhen !== "function" || opts.memoryWhen(transcript) === true);
      const tools = allTools.filter((t) => (!extraByName.has(t.name) || offered.has(t.name)) && (memoryOffered || t.name !== "crow_memory"));
      // A must-run tool (kiosk: crow_wm on "show me …"): see the opts doc above.
      const mustX = extra.find((x) => offered.has(x.definition.name) && typeof x.must === "function" && x.must(transcript) === true) || null;
      const mustName = mustX?.definition.name;
      executor = deps.createToolExecutor({ botDef: bot });
      // No deviceId: generateSystemPrompt stamps it as a "glasses device_id" for
      // crow_glasses_* tools, and no kiosk tool takes a device_id.
      const system = await deps.generateSystemPrompt({ botDef: bot });
      // The system message stays byte-stable turn to turn (vLLM prefix cache, review M6);
      // live state (e.g. open windows) rides on THIS turn's user message only, closed by a note
      // line, and is dropped from the saved conversation. A small model may still read it back
      // (live 2026-10-05): echoGuard lists every injected line the echo gate removes from what is
      // spoken, captioned, saved and put on a card. opts.turnContext may be a function of the plain
      // transcript: the context STRING is computed first, then wrapped and guarded.
      const ctxLine = typeof opts.turnContext === "function" ? String(opts.turnContext(transcript) || "") : opts.turnContext;
      const userMsg = { role: "user", content: withTurnContext(ctxLine, transcript) };
      const echoGuard = [ctxLine ? TURN_CONTEXT_NOTE : null, ctxLine, mustX?.mustNote];
      const messages = [
        { role: "system", content: withSuffix(system, opts.promptSuffix) },
        ...history,
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
      // A must-run tool that needs only a few words and an enumeration (play, open) is forced on the
      // quick model instead of being escalated: mustRoute "fast".
      const decision = mustX?.mustRoute === "fast" ? { route: "fast", reason: "must-fast", key: bot.fast_voice_model || deps.fastKey } : deps.chooseVoiceRoute(routeView, { hasTools: tools.length > 0 });
      let chat = await deps.createChatAdapter(bot.fast_voice_model || deps.fastKey, db);
      result.route = "fast";
      if (decision.route === "escalate") {
        // The filler runs alongside the (real-timer) readiness wait. A handler is attached NOW
        // so a rejection during that wait is never an unhandledRejection (which would exit the
        // gateway); the error is kept, logged below, and the turn carries on without the filler.
        let fillerErr = null;
        const filler = say.filler().catch((err) => { fillerErr = err; });
        const ready = await readyEscalation(decision.key, db, llmSignal);
        await filler;
        if (fillerErr && !aborted() && !mute.signal.aborted) {
          console.warn(`[voice-turn] filler TTS failed: ${fillerErr.message}`);
          timings.filler_error = String(fillerErr.message || fillerErr);
        }
        if (ready.adapter) { chat = ready.adapter; result.route = "escalate"; result.escalated = true; }
        // Qwen chat templates reject a system message anywhere but first (review C1):
        // the note joins the leading system message.
        else if (budgetHit) result.degraded = "budget";   // cut by the first-audio budget, not a barge-in
        else { result.degraded = ready.reason; messages[0] = { ...messages[0], content: `${messages[0].content}\n\n${DEGRADED_NOTE}` }; }
      }
      if (aborted()) { result.aborted = true; return result; }
      if (budgetHit) { await speakFallback("budget", false); return result; }

      // 4b. Prompt fit, against the model this turn really uses. A bound bot's skills are inlined
      // in the system message; a general assistant with many skills was ~41k tokens against the
      // 4B's 8,192 and every turn failed. Full prompt → the one without skill bodies → no call.
      const modelKey = result.escalated ? decision.key : (bot.fast_voice_model || deps.fastKey);
      // Decided on allTools (every extra counted, as the panel does), so an extra tool that is
      // hidden this turn never flips the level — and the system message — between turns.
      const fit = await promptFit({ db, bot, tools: allTools, promptSuffix: opts.promptSuffix, key: modelKey, full: withSuffix(system, opts.promptSuffix) });
      const ctx = fit.ctx;
      if (fit.level !== "full") {
        timings.prompt_fit = fit.level;
        const nums = `~${fit.est} prompt tokens with skills, ~${fit.est_no_skills} without, +${fit.reserve} reserved for the turn, context ${ctx}`;
        if (fit.level === "too_large") {
          result.failed = "bot_too_large";
          timings.failed = "bot_too_large";
          timings.est_prompt_tokens = fit.est_no_skills;
          log(`[voice-turn] ${device.id} bot ${bot.bot_id} is too large for ${modelKey} even without its skills (${nums}); no model call`);
          const line = String(opts.tooLargeText || BOT_TOO_LARGE_TEXT);
          sink.event({ type: "caption_delta", text: line });
          try { await say.force(line); } catch (err) { log(`[voice-turn] ${device.id} could not speak the too-large line: ${err.message}`); }
          // A barge-in over the line: aborted, but failed stays — the assistant still cannot answer here.
          if (aborted()) { result.aborted = true; return result; }
          say.end();
          fail("bot_too_large", false);
          return result;
        }
        // A degraded escalation's note joined the full message above; it joins the lean one the same way.
        messages[0] = { ...messages[0], content: result.degraded ? `${fit.system}\n\n${DEGRADED_NOTE}` : fit.system };
        const once = `${device.id}|${bot.bot_id}|${modelKey}`;
        if (!fitLogged.has(once)) {
          fitLogged.add(once);
          log(`[voice-turn] ${device.id} bot ${bot.bot_id} runs without its skills on ${modelKey}: the full prompt does not fit (${nums})`);
        }
      }

      // 5. Streamed tool loop
      const scope = deps.botVoiceScope(bot);
      const policy = bot.permission_policy || {};
      const shortName = (n) => String(n || "").replace(/^crow_/, "").replace(/_/g, " ");
      // → null (run it) or { code, message, neutral }: `code` goes to the log, `message` to the model;
      // neutral = the tool is simply not on this display / not offered (invisible to the router).
      const refuse = (code, message, neutral = false) => ({ code, message, neutral });
      const offeredNames = new Set(tools.map((t) => t.name));
      const offeredCheck = {
        categoryOf: typeof deps.toolCategory === "function" ? deps.toolCategory : () => null,
        selectedAddon: (n) => !!scope && scope.selectedToolNames.has(n) && deps.isConnectedAddonTool(n),
      };
      const policyGate = (tc) => {
        const eff = deps.effectiveToolName(tc);
        // The executor resolves a bare name (`search_memories`) to `crow_<name>`
        // (tool-executor resolveToolCategory), so every check sees both spellings.
        const names = eff && !String(eff).startsWith("crow_") ? [eff, `crow_${eff}`] : [eff];
        const soft = SOFT_DENY[tc.name] || names.map((n) => SOFT_DENY[n]).find(Boolean);
        if (soft && (deny.has(tc.name) || names.some((n) => deny.has(n)))) return refuse("refused_policy", soft, true);
        if (names.some((n) => deny.has(n)) || deny.has(tc.name)) return refuse("refused_policy", `"${shortName(eff)}" is not available on this display. Tell the user, then end your turn — do not call another tool.`, true);
        if (names.some((n) => deps.isMemoryTool(n))) {
          if (!memoryOn) return refuse("refused_policy", MEMORY_OFF, true);
          if (!memoryOffered) return refuse("not_offered", MEMORY_NOT_ASKED, true);
        }
        // Never run a tool this turn did not offer (an endpoint's extra tools have their own not-offered path below).
        if (!extraByName.has(tc.name) && !wasOffered(tc, offeredNames, offeredCheck)) {
          return refuse("not_offered", `"${shortName(eff)}" is not available here. Tell the user you can't do that here, then end your turn — do not call another tool.`, true);
        }
        if (scope && deps.isConnectedAddonTool(eff) && !scope.selectedToolNames.has(eff)) {
          return refuse("refused_policy", `This assistant isn't allowed to use "${shortName(eff)}" by voice. Tell the user and end your turn — do not call another tool.`);
        }
        if (policy.external_send === "draft_only" && deps.isExternalSendTool(eff)) {
          return refuse("refused_policy", `This assistant is draft-only by voice and cannot send "${shortName(eff)}" externally. Tell the user it was not sent. Then end your turn — do not call another tool.`);
        }
        if (Array.isArray(policy.deny) && names.some((n) => policy.deny.includes(n))) {
          return refuse("refused_policy", `This assistant is not permitted to use "${shortName(eff)}" by voice. Tell the user and end your turn — do not call another tool.`);
        }
        const confirmName = names.find((n) => isDestructiveTool(n) || (Array.isArray(policy.confirm) && policy.confirm.includes(n)));
        if (!confirmName) return null;
        if (confirm.check({ deviceId: device.id, eff: confirmName, args: tc.arguments, transcript }) === "allow") return null;
        return refuse("needs_confirm", `Confirmation required. Tell the user: "Are you sure you want to ${describeDestructiveAction({ name: confirmName, arguments: tc.arguments })}? Say yes to proceed." Then end your turn — do not call another tool.`);
      };

      // First chunk = first clause (latency lever 3); later chunks are whole sentences.
      const chunker = createSentenceChunker((s) => say(s), { firstClause: opts.firstClause !== false });
      // Tool rounds are capped (kiosk: 3). When the cap is hit — or the model calls the same tool(s)
      // twice in a row with nothing user-visible in between (no speech, no display change) — one
      // final round runs with the SAME tool list (the prefix cache stays warm) and a stop note on
      // the last tool result; any call it makes is ignored. No text from it → the fallback.
      const maxRounds = Number.isInteger(opts.maxToolRounds) && opts.maxToolRounds > 0 ? opts.maxToolRounds : (deps.maxToolRounds || 10);
      let rounds = 0;
      let toolRounds = 0;
      let nextMax = 600;
      let spokenChars = 0;
      let displayProgress = false;
      // Speech that reads as an ANSWER, not a preamble: any words after the first tool round, or a
      // long first round. A silent forced final round after a real answer is not a failure.
      let answeredChars = 0;
      let cut = null;
      let finalRound = false;
      let finalSpoken = 0;
      let lastStuckSig = null;
      const restores = [];           // notes appended to a message for one request: undone before saving
      const appendNote = (msg, note) => {
        restores.push({ msg, content: msg.content });
        msg.content = `${typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)}\n\n${note}`;
      };
      let overflow = false;
      let mustDone = !mustX;         // the must-run tool has succeeded this turn (true when there is none)
      let corrected = false;
      const toolLog = [];
      // On a must-run turn the first (and the corrective) round offers only the must-run tool, so a
      // forced call can be used where the engine honours one — unless another tool family is on
      // offer this turn (the model may need to fetch before it shows).
      const narrow = !!mustX && (typeof mustX.narrow !== "function" || mustX.narrow(transcript) !== false)
        && (mustX.mustRoute === "fast" || tools.every((t) => extraByName.has(t.name)));
      // On a turn whose words ask a display tool for something (holdText), a round's text is DEFERRED:
      // not captioned and not spoken until that round's calls are known. No display call → the text is
      // released. A display call → the text is dropped, and the tool's result says what really happened.
      const holdIntent = extra.some((x) => offered.has(x.definition.name) && typeof x.holdText === "function" && x.holdText(transcript) === true);
      let endedFinal = false;
      timings.tools_offered = tools.length;
      while (!budgetHit) {
        rounds++;
        const think = createThinkGate();
        const echo = createContextEchoGate(echoGuard);
        let content = "";
        let roundSpoken = 0;
        let calls = [];
        // Until the must-run tool has succeeded, nothing the model says is captioned or spoken:
        // "I've displayed the list" is only true after the call.
        const hold = !mustDone;
        const defer = !hold && holdIntent && !finalRound;
        let deferred = "";
        const roundTools = narrow && !mustDone && !finalRound ? [mustX.definition] : tools;
        let roundText = "";
        let finalRes = null;
        const roundMax = nextMax;
        nextMax = 600;
        // Keep prompt + completion inside the model's context (review M6: the 4B is 8192;
        // tool schemas alone are ~5k tokens). ~3.2 chars/token is a deliberate over-estimate.
        let estPrompt = estimatePromptTokens(messages, roundTools);
        // Never send a request that cannot fit (every round: history and tool results grow). Saved
        // history goes first, oldest exchange first; the system message and this turn stay.
        for (let n; !requestFits(estPrompt, ctx) && (n = dropOldestExchange(messages, userMsg)) > 0;) {
          timings.history_dropped = (timings.history_dropped || 0) + n;
          estPrompt = estimatePromptTokens(messages, roundTools);
        }
        timings.est_prompt_tokens = estPrompt;
        if (!requestFits(estPrompt, ctx)) {
          log(`[voice-turn] ${device.id} round ${rounds} not sent: ~${estPrompt} prompt tokens do not fit ${modelKey} (context ${ctx}) with no saved history left`);
          overflow = true;
          break;
        }
        const maxTokens = ctx ? Math.max(64, Math.min(roundMax, ctx - estPrompt - 128)) : roundMax;
        timings.max_tokens = maxTokens;   // with est_prompt_tokens in [kiosk-metrics]; the smoke records both
        // tool_choice requires the must-run tool while it is the ONLY tool offered (with others the
        // model may need to fetch first; the backstop below still applies). Backends differ: a vLLM
        // server honours a named choice; the llama.cpp builds in use accept and ignore it.
        let choiceMode = !mustDone && !finalRound && roundTools.length === 1 ? (toolChoiceMode.get(modelKey) || "named") : "none";
        let steppedDown = false;
        for (;;) {
          const toolChoice = choiceMode === "named" ? { name: mustName } : choiceMode === "required" ? "required" : null;
          let started = false;
          try {
            for await (const ev of chat.chatStream(messages, roundTools, { temperature: 0.7, maxTokens, chatTemplateKwargs: { enable_thinking: false }, signal: llmSignal, ...(toolChoice ? { toolChoice } : {}) })) {
              started = true;
              if (aborted() || budgetHit) break;
              if (ev.type === "content_delta" && ev.text) {
                mark("llm_first_token_ms");
                content += ev.text;
                const spoken = echo.feed(think.feed(ev.text));
                if (spoken && defer) deferred += spoken;
                else if (spoken && !hold) {
                  roundText += spoken;
                  if (spoken.trim()) { roundSpoken += spoken.trim().length; spokenChars += spoken.trim().length; }
                  sink.event({ type: "caption_delta", text: spoken });
                  await chunker.push(spoken);
                }
              } else if (ev.type === "tool_call") {
                mark("llm_first_token_ms");
                // A display card's text gets the same guard as speech (kept that way in the saved call).
                calls.push({ id: ev.id, name: ev.name, arguments: extraByName.has(ev.name) ? stripContextEchoDeep(ev.arguments, echoGuard) : ev.arguments });
              } else if (ev.type === "done") break;
            }
          } catch (err) {
            if (budgetHit) break;   // the budget's own abort surfacing from the provider fetch
            // The backend refused the request (400/422 before any output) and it carried a tool_choice:
            // step down and send the same round again. The step is remembered for this model only
            // once the weaker request goes through — that is what shows tool_choice was the cause.
            if (toolChoice && !started && !aborted() && err?.code === "provider_error" && (err.status === 400 || err.status === 422)) {
              const next = choiceMode === "named" ? "required" : "none";
              log(`[voice-turn] ${device.id} ${modelKey} refused a request with tool_choice ${choiceMode} (HTTP ${err.status}); trying ${next}`);
              choiceMode = next;
              steppedDown = true;
              content = ""; calls = [];
              continue;
            }
            throw err;
          }
          if (steppedDown) toolChoiceMode.set(modelKey, choiceMode);
          break;
        }
        if (mustX && timings.tool_choice === undefined) timings.tool_choice = choiceMode;
        // Text the echo gate still held (it could have been the start of an echo) is decided now.
        const tail = echo.flush();
        if (tail && !hold && !aborted() && !budgetHit) {
          if (tail.trim()) { roundSpoken += tail.trim().length; spokenChars += tail.trim().length; }
          sink.event({ type: "caption_delta", text: tail });
          await chunker.push(tail);
        }
        // What is kept as said is what was heard: an echo saved in the history invites the next one.
        content = stripContextEcho(content, echoGuard);
        if (aborted()) { result.aborted = true; break; }
        if (budgetHit) break;
        const displayCall = calls.some((c) => extraByName.has(c.name));
        if (defer && deferred && !displayCall) {
          // No display call came with it: the deferred text is the answer after all.
          roundText += deferred;
          if (deferred.trim()) { roundSpoken += deferred.trim().length; spokenChars += deferred.trim().length; }
          sink.event({ type: "caption_delta", text: deferred });
          await chunker.push(deferred);
        }
        if (finalRound) {
          // The forced answer: its text is kept, any call it still makes is ignored (never executed,
          // never saved — an unanswered tool call would break the next turn's template).
          finalSpoken = roundSpoken;
          if (calls.length) log(`[voice-turn] ${device.id} final round ignored tool call(s): ${calls.map((c) => c.name).join(", ")}`);
          if (content) messages.push({ role: "assistant", content });
          break;
        }
        let assistantMsg = null;
        const kept = hold || (defer && displayCall) ? "" : content;   // held or dropped text was never heard: it is not kept as something said
        if (kept || calls.length) {
          assistantMsg = { role: "assistant", content: kept };
          if (calls.length) assistantMsg.tool_calls = JSON.stringify(calls.map((tc) => ({ id: tc.id, name: tc.name, arguments: tc.arguments })));
          messages.push(assistantMsg);
        }
        if (!calls.length) {
          if (mustDone) break;
          // The model's turn ended with nothing on the screen. Its text was held back and is dropped
          // (never spoken, never saved). One corrective round, then the truthful line (after the loop).
          if (corrected) break;
          corrected = true;
          timings.display_corrected = true;
          log(`[voice-turn] ${device.id} round ${rounds}: no ${logName(mustName)} call on a turn that needs one; one corrective round`);
          appendNote(messages.at(-1), mustX.mustNote || MUST_RUN_NOTE);
          continue;
        }
        toolRounds++;
        const roundSig = [...new Set(calls.map((c) => String(c.name)))].sort().join("+");
        timings.tool_rounds = toolRounds;
        // Each call's OUTCOME — name:code, never arguments or result text — in the log and in
        // timings.tools (live re-test 2026-10-04: a display call changed nothing and nobody could say why).
        const outcome = new Map();
        const noteRound = () => {
          const parts = calls.map((c) => `${logName(c.name)}:${outcome.get(c) || "pending"}`);
          toolLog.push(parts.join("+"));
          timings.tools = toolLog.slice();
          log(`[voice-turn] ${device.id} round ${rounds}: ${parts.join(", ")}`);
        };
        const local = [];
        const remote = [];
        let roundDisplay = false;
        // Route-neutral = in-process display tools + calls refused because the tool is not on this
        // display (deny list / memory off). Confirm and policy refusals still count as tool context:
        // the "yes" that follows a confirmation must keep its escalation (review I3).
        let neutralCalls = 0;
        for (const tc of calls) {
          if (tc === calls.at(-1)) finalRes = null;
          const gate = policyGate(tc);
          if (gate) {
            if (gate.neutral) neutralCalls++;
            outcome.set(tc, gate.code);
            local.push({ id: tc.id, name: tc.name, result: gate.message, neutral: gate.neutral });
            continue;
          }
          const x = extraByName.get(tc.name);
          if (x) {
            neutralCalls++;
            let out;
            if (!offered.has(tc.name)) out = JSON.stringify({ action: "error", code: "not_offered", message: EXTRA_NOT_NEEDED });   // never run
            else try { out = await x.execute(tc.arguments || {}, { transcript }); } catch (err) { out = JSON.stringify({ action: "error", message: err.message }); }
            let res = null;
            try { res = JSON.parse(out); } catch {}
            const ok = res?.ok === true;
            // The log code: why (reason), else what happened (outcome), else the 0.1.8 rule.
            const code = outcomeCode(res?.reason, null) || outcomeCode(res?.outcome, null) || (ok ? "ok" : outcomeCode(res?.code, "error"));
            outcome.set(tc, code);
            // effect: the call changed something (a no-op success such as "nothing is open" sets effect: false).
            finalRes = tc === calls.at(-1) && offered.has(tc.name) && res && res.final === true && typeof res.say === "string" && res.say.trim()
              ? { name: tc.name, say: res.say.trim(), code, effect: ok && res.effect !== false } : null;
            // A display tool that changed the screen is user-visible progress.
            if (ok) roundDisplay = true;
            if (tc.name === mustName && (typeof mustX.mustDone === "function" ? mustX.mustDone(res) === true : ok)) mustDone = true;
            local.push({ id: tc.id, name: tc.name, result: out, neutral: true });
            continue;
          }
          remote.push(tc);
        }
        // The budget also bounds a slow remote tool: the race stops waiting (the call itself runs on).
        let remoteResults = [];
        try { if (remote.length) remoteResults = await Promise.race([executor.executeToolCalls(remote), budgetP.then(() => null)]); }
        catch (err) { noteRound(); throw err; }   // the round is still in the log when a tool run throws
        (remoteResults || []).forEach((r, i) => { if (remote[i]) outcome.set(remote[i], r?.isError ? "error" : "ok"); });
        noteRound();
        // A final result ends the turn only when no must-run tool is still owed, or when it comes from the
        // must-run tool itself. A final result from ANOTHER tool on a must-run turn is just a result: the
        // model gets it back, and the turn still has to end with the must-run call or the could-not line.
        const endsFinal = !!finalRes && (mustDone || finalRes.name === mustName);
        if ((budgetHit || remoteResults == null) && !endsFinal) break;
        if (roundDisplay) displayProgress = true;
        if (roundSpoken > 0 && (toolRounds > 1 || roundSpoken >= 40)) answeredChars += roundSpoken;
        // A text-free assistant turn whose every call was refused/in-process is neutral too.
        if (assistantMsg && !kept.trim() && neutralCalls === calls.length) routeNeutral.add(assistantMsg);
        // opts.onToolResult: what the model reads (and what is saved) for a remote result may be replaced.
        const replaced = new Map();
        if (typeof opts.onToolResult === "function") {
          for (const [i, r] of (remoteResults || []).entries()) {
            if (!remote[i] || !r) continue;
            try {
              const rep = await opts.onToolResult({ name: r.name, tool: deps.effectiveToolName(remote[i]) || r.name, result: r.result, isError: r.isError === true });
              if (typeof rep === "string") replaced.set(r, rep);
            } catch (err) { log(`[voice-turn] ${device.id} onToolResult failed for ${logName(r.name)}: ${err?.message || err}`); }
          }
        }
        // Neutrality rides on the local result object, never on the call id (ids may be "" — review M7).
        let lastToolMsg = null;
        for (const r of [...local, ...(remoteResults || [])]) {
          const content = replaced.has(r) ? replaced.get(r) : r.result;
          const toolMsg = { role: "tool", content, tool_call_id: r.id, tool_name: r.name };
          if (r.neutral === true && local.includes(r)) routeNeutral.add(toolMsg);
          messages.push(toolMsg);
          lastToolMsg = toolMsg;
          if (typeof content === "string" && content.length > 500) nextMax = 4000;
        }
        if (endsFinal) {
          // The turn ends on the server's own line: no further model round. What the display hears:
          //  - nothing was spoken in this round (the usual case: text was held or deferred) → the server's line;
          //  - the model had already spoken a full sentence AND the call had an effect → that sentence stands;
          //  - the model had already spoken and the call did nothing or failed → the server's line as well,
          //    because what was said is not what happened.
          // The line is short and already known, so it is spoken even when the first-audio budget has run out.
          timings.final = `${logName(finalRes.name)}:${finalRes.code}`;
          if (budgetTimer) { (deps.clearTimeout || clearTimeout)(budgetTimer); budgetTimer = null; }
          const spokeSentence = roundSpoken > 0 && SENTENCE_END.test(`${roundText.trim()} `);
          if (!(spokeSentence && finalRes.effect)) {
            await chunker.flush();
            sink.event({ type: "caption_delta", text: spokenChars > 0 ? ` ${finalRes.say}` : finalRes.say });
            await (budgetHit ? say.force(finalRes.say) : say(finalRes.say));
            spokenChars += finalRes.say.length;
          }
          messages.push({ role: "assistant", content: finalRes.say });
          endedFinal = true;
          break;
        }
        // Stuck: the same tool(s) twice in a row with no user-visible progress in either round.
        const progress = roundSpoken > 0 || roundDisplay;
        if (!progress && roundSig === lastStuckSig) cut = "tool_repeat";
        lastStuckSig = progress ? null : roundSig;
        if (!cut && toolRounds >= maxRounds) cut = "tool_rounds";
        if (cut) {
          // A must-run tool that failed again (or never ran before the cap): no forced answer round —
          // its text could only be dropped. The truthful line follows the loop.
          if (!mustDone) { log(`[voice-turn] ${device.id} stopping tools (${cut}) after ${toolRounds} round(s); ${logName(mustName)} never succeeded`); break; }
          log(`[voice-turn] ${device.id} stopping tools (${cut}) after ${toolRounds} round(s); forcing an answer`);
          finalRound = true;
          if (lastToolMsg) appendNote(lastToolMsg, STOP_TOOLS_NOTE);
        }
      }
      for (const r of restores.reverse()) r.msg.content = r.content;
      if (aborted()) {
        result.aborted = true;
      } else if (budgetHit && !endedFinal) {
        await speakFallback("budget", spokenChars > 0);
        return result;
      } else {
        await chunker.flush();
        if (aborted()) result.aborted = true;
        // The budget can fire while the last chunk is still synthesizing (the stream already ended).
        else if (budgetHit && !endedFinal && !say.answered()) { await speakFallback("budget", spokenChars > 0); return result; }
        else if (overflow) { await speakFallback("context_full", spokenChars > 0); return result; }
        else if (!mustDone && !endedFinal) {
          // Never end on a claim that something is on the screen when nothing was put there.
          timings.display_missed = true;
          await speakFallback("display_missed", spokenChars > 0, String(mustX?.missedText || opts.displayMissedText || DISPLAY_MISSED_TEXT));
          return result;
        }
        else if (cut && finalSpoken === 0 && answeredChars === 0 && !displayProgress) { await speakFallback(cut, spokenChars > 0); return result; }
        else if (spokenChars === 0 && !displayProgress) { await speakFallback("no_text", false); return result; }
      }
      say.end();
      const userIdx = messages.indexOf(userMsg);
      if (userIdx >= 0) messages[userIdx] = { role: "user", content: transcript };
      convo.save(device.id, messages);
      return result;
    } catch (err) {
      if (aborted()) { result.aborted = true; return result; }
      if (budgetHit) { await speakFallback("budget", true).catch(() => {}); return result; }
      result.failed = "error";
      timings.failed = "error";
      // The cause used to reach the client only; the gateway log is where it gets diagnosed.
      log(`[voice-turn] ${device?.id} turn failed (error): ${err?.message || err}`);
      fail("turn_failed", true, err.message);
      return result;
    } finally {
      if (budgetTimer) (deps.clearTimeout || clearTimeout)(budgetTimer);
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

  return { runVoiceTurn, speakText, transcribe, assessBot, convo };
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
    toolCategory: tx.toolCategoryOf,
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
