/**
 * Meta Glasses Panel — REST API + /session WebSocket.
 *
 * REST (Express, dashboardAuth-gated under /api/meta-glasses):
 *   GET    /api/meta-glasses/devices            — list paired devices (no tokens)
 *   POST   /api/meta-glasses/pair               — pair a device, returns { device, token }
 *   DELETE /api/meta-glasses/devices/:id        — unpair a device
 *   POST   /api/meta-glasses/devices/:id        — update per-device overrides
 *   POST   /api/meta-glasses/say                — queue text for TTS broadcast
 *   POST   /api/meta-glasses/debug/voice-turn   — simulate a voice turn from a prompt
 *
 * WebSocket (no Express middleware — token-authed at upgrade):
 *   wss://.../api/meta-glasses/session?device_id=X
 *     Authorization: Bearer <token>
 *
 * Protocol envelope (per plan §WebSocket protocol):
 *   client→server text:   { type: hello | turn_start | turn_end }
 *   client→server binary: Opus frames (20ms, 16 kHz mono) during a turn
 *   server→client text:   { type: ready | transcript_partial | transcript_final |
 *                           llm_delta | tts_start | tts_end | error }
 *   server→client binary: TTS audio chunks per tts_start codec
 */

import express, { Router } from "express";
import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";

/* ---------- Bundle path resolution ---------- */

function resolveBundleServer() {
  const installed = join(homedir(), ".crow", "bundles", "meta-glasses", "server");
  if (existsSync(installed)) return installed;
  return join(import.meta.dirname, "..", "server");
}
const serverDir = resolveBundleServer();

function resolveGatewayDir() {
  const fromBundle = join(import.meta.dirname, "..", "..", "..", "servers", "gateway");
  if (existsSync(join(fromBundle, "ai", "tts", "index.js"))) return fromBundle;
  const fromHome = join(homedir(), "crow", "servers", "gateway");
  if (existsSync(join(fromHome, "ai", "tts", "index.js"))) return fromHome;
  throw new Error("Cannot locate Crow gateway directory from meta-glasses bundle.");
}
const gatewayDir = resolveGatewayDir();

async function loadDeviceStore() { return import(pathToFileURL(join(serverDir, "device-store.js")).href); }
async function loadTts()         { return import(pathToFileURL(join(gatewayDir, "ai/tts/index.js")).href); }
async function loadStt()         { return import(pathToFileURL(join(gatewayDir, "ai/stt/index.js")).href); }
async function loadProvider()    { return import(pathToFileURL(join(gatewayDir, "ai/provider.js")).href); }
async function loadDb()          { return import(pathToFileURL(join(gatewayDir, "..", "db.js")).href); }
async function loadToolExec()    { return import(pathToFileURL(join(gatewayDir, "ai/tool-executor.js")).href); }
async function loadSystemPrompt(){ return import(pathToFileURL(join(gatewayDir, "ai/system-prompt.js")).href); }
async function loadVision()       { return import(pathToFileURL(join(gatewayDir, "ai/vision.js")).href); }
async function loadResolveProv()  { return import(pathToFileURL(join(gatewayDir, "ai/resolve-provider.js")).href); }
async function loadSettingsReg()  { return import(pathToFileURL(join(gatewayDir, "dashboard/settings/registry.js")).href); }

/* ---------- Shared session state ---------- */

const _sessions = new Map();
// Outstanding capture_photo requests: request_id → { resolve, reject, timer }
const _pendingCaptures = new Map();

/** Send a capture_photo command to a session and await upload. */
function triggerCapture(sess) {
  const reqId = randomUUID();
  const p = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      _pendingCaptures.delete(reqId);
      reject(new Error("capture timeout"));
    }, 20_000);
    _pendingCaptures.set(reqId, { resolve, reject, timer });
  });
  sendText(sess.ws, { type: "capture_photo", request_id: reqId });
  return p;
}
// Where uploaded photos live. Crow data dir has a "uploads" convention.
const _photoDir = join(homedir(), ".crow", "data", "glasses-photos");
try { mkdirSync(_photoDir, { recursive: true }); } catch {}

/* ---------- Per-device turn mutex (Phase 2) ----------
 * Prevents overlapping voice turns on the same device. A rapid second PTT
 * while the first is still drafting TTS would corrupt the adapter state.
 * The lock is released in finally, on ws close, or by the 60s watchdog.
 */
const _turnLocks = new Map(); // deviceId → { acquiredAt, ws, watchdog }
const TURN_WATCHDOG_MS = 60_000;

function acquireTurnLock(deviceId, ws) {
  if (_turnLocks.has(deviceId)) return false;
  const watchdog = setTimeout(() => {
    const e = _turnLocks.get(deviceId);
    if (e && e.ws === ws) {
      _turnLocks.delete(deviceId);
      try { sendText(ws, { type: "error", code: "turn_timeout", recoverable: true }); } catch {}
    }
  }, TURN_WATCHDOG_MS);
  _turnLocks.set(deviceId, { acquiredAt: Date.now(), ws, watchdog });
  return true;
}
function releaseTurnLock(deviceId, ws) {
  const entry = _turnLocks.get(deviceId);
  if (entry && (!ws || entry.ws === ws)) {
    clearTimeout(entry.watchdog);
    _turnLocks.delete(deviceId);
  }
}

/* ---------- Destructive-action spoken confirmation (Phase 2) ----------
 * First call to a destructive tool returns a "confirmation required" prompt
 * instead of executing. Next turn, the LLM retries the same tool with same
 * args; if the user's transcript starts with an affirmative token within
 * 60s, the call runs. Any mismatch clears the pending state.
 * Per-device map — 'yes' on glasses A cannot fulfill a pending on glasses B.
 */
const _pendingConfirms = new Map(); // deviceId → { toolName, argsHash, at }
const CONFIRM_TTL_MS = 60_000;
const DESTRUCTIVE_EXACT = new Set([
  "crow_delete_post",
  "crow_delete_memory",
  "crow_delete_setlist",
  "crow_unpublish_post",
  "crow_remove_backend",
  "crow_dismiss_all_notifications",
]);
const DESTRUCTIVE_REGEX = /^crow_(delete|remove|destroy|unpublish)_/;
const AFFIRMATIVE_STARTS = /^\s*(yes|yeah|yep|yup|confirmed?|do it|go ahead|proceed|ok|okay)\b/i;
const NEGATIVE_STARTS = /^\s*(no|nope|cancel|stop|wait|nevermind|never mind)\b/i;

function isDestructiveTool(name) {
  if (!name) return false;
  if (DESTRUCTIVE_EXACT.has(name)) return true;
  if (DESTRUCTIVE_REGEX.test(name)) return true;
  return false;
}
function describeDestructiveAction(tc) {
  const base = (tc.name || "").replace(/^crow_/, "").replace(/_/g, " ");
  const arg = tc.arguments || {};
  const ref = arg.id || arg.slug || arg.post_id || arg.memory_id || arg.setlist_id || "";
  return ref ? `${base} ${ref}` : base;
}
function canonicalArgsHash(args) {
  // Canonical JSON (sorted keys, stable recursion) — equality check only.
  const seen = new WeakSet();
  const canonical = (v) => {
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (seen.has(v)) return '"__cycle__"';
    seen.add(v);
    if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
    const keys = Object.keys(v).sort();
    return "{" + keys.map(k => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
  };
  return canonical(args || {});
}

// Per-device short-term conversation history (non-system messages).
// Keeps the last N turns so follow-ups like "add purple too" retain
// context. Expires after CONVO_IDLE_MS of inactivity so long gaps
// between sessions start fresh.
const _convoHistory = new Map(); // deviceId → { messages: [...], lastAt: ts }
const CONVO_MAX_MESSAGES = 24;   // ~8 user/assistant/tool triples
const CONVO_IDLE_MS = 15 * 60 * 1000; // 15 min

function getConvo(deviceId) {
  const entry = _convoHistory.get(deviceId);
  if (!entry) return [];
  if (Date.now() - entry.lastAt > CONVO_IDLE_MS) {
    _convoHistory.delete(deviceId);
    return [];
  }
  return entry.messages;
}

function saveConvo(deviceId, messages) {
  // Drop the leading system message; we re-generate it every turn.
  const trimmed = messages.filter(m => m.role !== "system").slice(-CONVO_MAX_MESSAGES);
  _convoHistory.set(deviceId, { messages: trimmed, lastAt: Date.now() });
}

/**
 * Resolve the active vision-model provider config for a voice turn.
 *
 * Precedence:
 *   1. device.vision_profile_id (override)
 *   2. aiProfile.vision_profile_id (default)
 *   3. First profile marked isDefault in vision_profiles (platform default)
 *
 * If any pointer profile is selected, resolves via models.json. Direct-mode
 * profiles return their stored baseUrl/model/apiKey. On any miss (no profile,
 * missing provider, etc.) returns null so the caller skips vision.
 */
async function resolveVisionProfileConfig(db, device, aiProfile) {
  try {
    const { readSetting } = await loadSettingsReg();
    const raw = await readSetting(db, "vision_profiles");
    if (!raw) return null;
    let profiles = [];
    try { profiles = JSON.parse(raw); } catch { return null; }
    const targetId = device?.vision_profile_id || aiProfile?.vision_profile_id;
    const profile = targetId
      ? profiles.find(p => p.id === targetId)
      : (profiles.find(p => p.isDefault) || profiles[0]);
    if (!profile) return null;
    if (profile.provider_id) {
      const { resolveProvider } = await loadResolveProv();
      return resolveProvider(profile.provider_id, profile.model_id);
    }
    if (profile.baseUrl && profile.model) {
      return { baseUrl: profile.baseUrl, apiKey: profile.apiKey || "none", model: profile.model };
    }
    return null;
  } catch (err) {
    console.warn(`[meta-glasses] vision profile resolve failed: ${err.message}`);
    return null;
  }
}

function sendText(ws, obj) {
  if (ws.readyState !== 1) return;
  ws.send(JSON.stringify(obj));
}
function sendBinary(ws, chunk) {
  if (ws.readyState !== 1) return;
  ws.send(chunk);
}

/**
 * Prepend a RIFF/WAV header onto raw 16-bit signed LE mono PCM. STT
 * providers (Groq/Whisper/Deepgram) expect a container, not headerless
 * PCM — this is the minimal 44-byte header.
 */
function wrapPcmAsWav(pcm, sampleRate) {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * 2;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);        // PCM chunk size
  header.writeUInt16LE(1, 20);          // PCM format
  header.writeUInt16LE(1, 22);          // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(2, 32);          // block align
  header.writeUInt16LE(16, 34);         // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/* ---------- TTS codec negotiation ----------
 *
 * The Android client opens an AudioTrack configured for raw 16-bit signed
 * PCM mono and writes whatever bytes arrive on the socket directly into it.
 * That means we must hand it raw PCM in matching sample rate. Each TTS
 * adapter takes a different `format` string for its provider; this helper
 * returns the right one (plus a header-stripping rule for piper which
 * always emits a 44-byte WAV header before the PCM body).
 *
 * Returns null when the adapter cannot produce raw PCM — in that case the
 * caller falls back to advertising the legacy mp3 codec, which the current
 * Android client will play as noise. (Edge / native MediaCodec decode is
 * the next iteration.)
 */
function negotiatePcm(adapterName) {
  switch (adapterName) {
    case "openai-tts":
      // OpenAI TTS pcm = signed 16-bit LE mono @ 24 kHz, no header.
      return { synthFormat: "pcm", codec: "pcm", sampleRate: 24000, stripHeaderBytes: 0 };
    case "kokoro":
      // Kokoro mirrors OpenAI's response_format. Defaults to 24 kHz.
      return { synthFormat: "pcm", codec: "pcm", sampleRate: 24000, stripHeaderBytes: 0 };
    case "elevenlabs":
      // ElevenLabs supports `pcm_24000` -> 24 kHz s16le mono raw.
      return { synthFormat: "pcm_24000", codec: "pcm", sampleRate: 24000, stripHeaderBytes: 0 };
    case "azure":
      // Azure: raw-24khz-16bit-mono-pcm == 24 kHz s16le mono raw.
      return { synthFormat: "raw-24khz-16bit-mono-pcm", codec: "pcm", sampleRate: 24000, stripHeaderBytes: 0 };
    case "piper":
      // Piper emits a 44-byte RIFF/WAV header followed by 22.05 kHz s16le mono.
      // Strip the header on the first chunk and advertise 22050 Hz.
      return { synthFormat: undefined, codec: "pcm", sampleRate: 22050, stripHeaderBytes: 44 };
    default:
      // edge-tts and others: no raw PCM path. Caller emits mp3 + warning.
      return null;
  }
}

async function* pcmStream(adapter, text, voice, negotiation, extraOpts = {}) {
  let bytesToStrip = negotiation.stripHeaderBytes || 0;
  const opts = negotiation.synthFormat ? { ...extraOpts, format: negotiation.synthFormat } : extraOpts;
  // Buffer the entire synthesis before yielding. Rationale: PCM has no codec
  // compression, so OpenAI (and most TTS providers) stream bytes at roughly
  // realtime playback speed — 48 kB/s for 24 kHz s16le mono. The phone's
  // AudioTrack consumes at the same rate, so any network jitter drains the
  // client-side buffer and causes underrun (audible as static/clicks).
  // By buffering here first, we can then blast the PCM to the phone
  // faster-than-realtime over the WebSocket, giving AudioTrack plenty of
  // headroom. Cost: +latency equal to synthesis time before first audio.
  const parts = [];
  for await (const chunk of adapter.synthesize(text, voice, opts)) {
    if (bytesToStrip > 0) {
      if (chunk.length <= bytesToStrip) {
        bytesToStrip -= chunk.length;
        continue;
      }
      const trimmed = chunk.slice(bytesToStrip);
      bytesToStrip = 0;
      if (trimmed.length) parts.push(trimmed);
    } else {
      parts.push(chunk);
    }
  }
  const full = Buffer.concat(parts.map(p => Buffer.isBuffer(p) ? p : Buffer.from(p)));
  // Yield in ~64 KB frames so WebSocket backpressure can apply on slow links.
  const FRAME = 64 * 1024;
  for (let off = 0; off < full.length; off += FRAME) {
    yield full.subarray(off, Math.min(off + FRAME, full.length));
  }
}

/* ---------- Voice-turn pipeline ---------- */

async function runVoiceTurn(ws, device, audioBuffer, options = {}) {
  const db = (await loadDb()).createDbClient();
  let toolExecutor = null;
  try {
    const { getDefaultSttProfile, createSttAdapter, getSttProfiles } = await loadStt();
    const { getTtsProfiles, createTtsAdapter, getDefaultTtsProfile } = await loadTts();
    const { createAdapterFromProfile, getAiProfiles } = await loadProvider();
    const { createToolExecutor, getChatTools, MAX_TOOL_ROUNDS } = await loadToolExec();
    const { generateSystemPrompt } = await loadSystemPrompt();

    // 1. STT
    const sttProfile = device.stt_profile_id
      ? (await getSttProfiles(db, { includeKeys: true })).find(p => p.id === device.stt_profile_id)
      : await getDefaultSttProfile(db, { includeKeys: true });
    if (!sttProfile) {
      sendText(ws, { type: "error", code: "no_stt_profile", recoverable: false });
      return;
    }
    const { adapter: sttAdapter } = await createSttAdapter(sttProfile);
    const stt = await sttAdapter.transcribe(audioBuffer, {
      filename: options.filename || "turn.opus",
      contentType: options.contentType || "audio/ogg;codecs=opus",
    });
    const transcript = (stt.text || "").trim();
    sendText(ws, { type: "transcript_final", text: transcript, language: stt.language });
    if (!transcript) {
      sendText(ws, { type: "error", code: "empty_transcript", recoverable: true });
      return;
    }

    // 2. BYOAI chat
    const aiProfiles = await getAiProfiles(db, { includeKeys: true });
    const slugOf = (n) => n.toLowerCase().replace(/\s+/g, "_").replace(/\./g, "_");
    const aiProfile = device.ai_profile_slug
      ? aiProfiles.find(p => slugOf(p.name) === device.ai_profile_slug)
      : aiProfiles[0];
    if (!aiProfile) {
      sendText(ws, { type: "error", code: "no_ai_profile", recoverable: false });
      return;
    }
    const { adapter: chatAdapter } = await createAdapterFromProfile(aiProfile, aiProfile.defaultModel);

    // 3. TTS
    const ttsProfile = device.tts_profile_id
      ? (await getTtsProfiles(db, { includeKeys: true })).find(p => p.id === device.tts_profile_id)
      : await getDefaultTtsProfile(db, { includeKeys: true });
    if (!ttsProfile) {
      sendText(ws, { type: "error", code: "no_tts_profile", recoverable: false });
      return;
    }
    const { adapter: ttsAdapter } = await createTtsAdapter(ttsProfile);

    const ttsNeg = negotiatePcm(ttsAdapter.name);
    if (ttsNeg) {
      sendText(ws, { type: "tts_start", codec: ttsNeg.codec, sample_rate: ttsNeg.sampleRate });
    } else {
      console.warn(`[meta-glasses] TTS adapter '${ttsAdapter.name}' has no PCM path; sending mp3 (will not play correctly on current Android client).`);
      sendText(ws, { type: "tts_start", codec: "mp3", sample_rate: 24000 });
    }

    let textBuffer = "";
    const SENTENCE_END = /[.!?…。]["')\]]?\s|[\n]/;

    async function flushTts(text) {
      const trimmed = text.trim();
      if (!trimmed) return;
      try {
        const stream = ttsNeg
          ? pcmStream(ttsAdapter, trimmed, ttsProfile.defaultVoice, ttsNeg)
          : ttsAdapter.synthesize(trimmed, ttsProfile.defaultVoice, {});
        for await (const chunk of stream) {
          sendBinary(ws, chunk);
        }
      } catch (err) {
        sendText(ws, { type: "error", code: "tts_error", recoverable: true, message: err.message });
      }
    }

    toolExecutor = createToolExecutor();
    const tools = getChatTools();
    const systemPrompt = await generateSystemPrompt({ deviceId: device.id });
    console.log(`[meta-glasses] voice turn: transcript=${JSON.stringify(transcript)} ai=${aiProfile.name}/${aiProfile.defaultModel} tools=${tools.length}`);

    const priorMessages = getConvo(device.id);
    const messages = [
      { role: "system", content: systemPrompt + `

The user is speaking to you through Meta Ray-Ban glasses. Keep replies concise and conversational (1-3 short sentences). Plain prose only, no markdown, no lists. When the user asks to remember something or recall something, actually call the appropriate tool — don't just say you will.

If a tool returns content explicitly meant to be read aloud (a news briefing, an article, a podcast description, a recall result), recite it in full instead of summarizing — the user is listening, not reading. If a tool result is wrapped in <audio_friendly>…</audio_friendly> tags, read exactly what is between the tags, verbatim, without trimming or paraphrasing.

CAPABILITIES. You can play music (call the music tools), read news (news tools), look up things (crow_search_memories / crow_recall / crow_search_notes / crow_deep_recall), set reminders (crow_create_notification), control smart home, draft blog posts (crow_create_post), and take photos (crow_glasses_capture_photo). Use the tools — don't just say you will.

DESTRUCTIVE TOOLS. For any tool that deletes, removes, unpublishes, or dismisses (e.g. crow_delete_memory, crow_unpublish_post, crow_dismiss_all_notifications), the server will return "Confirmation required" the first time you call it. When that happens, speak the exact confirmation question the server provided and then END YOUR TURN — do not call another tool. The user's next spoken answer will be inspected server-side; if they say yes, retry the SAME tool with the SAME arguments on the next turn and it will execute. If they say no or change topic, drop the action.

LONG WORK via the orchestrator. For research, multi-step analysis, code work, or anything that would take more than one chat turn, call crow_orchestrate with a team preset (research, memory_ops, full, or another from crow_list_presets) — this launches a team of specialized agents in the background. After calling crow_orchestrate, speak a brief ack ("I'm on it…") and then call crow_orchestrate_status periodically with the returned job id until it reports completed. Deliver the summary verbatim if it's <audio_friendly>-wrapped. This single call authorizes whatever the preset's agents need to do; individual confirmation is not re-asked per internal tool.` },
      ...priorMessages,
      { role: "user", content: transcript },
    ];

    async function drainBuffer(force) {
      while (true) {
        const match = SENTENCE_END.exec(textBuffer);
        if (!match) break;
        const end = match.index + match[0].length;
        const sentence = textBuffer.slice(0, end);
        textBuffer = textBuffer.slice(end);
        await flushTts(sentence);
      }
      if (force && textBuffer.trim()) { await flushTts(textBuffer); textBuffer = ""; }
    }

    let rounds = 0;
    // Adaptive maxTokens: bumped to 4000 for the round after a long tool
    // result (>~500 chars) so multi-sentence recitations (news briefings,
    // articles) aren't silently truncated. Resets to 600 otherwise.
    let nextMaxTokens = 600;
    while (rounds < MAX_TOOL_ROUNDS) {
      rounds++;
      let assistantContent = "";
      const toolCalls = [];
      const roundMaxTokens = nextMaxTokens;
      nextMaxTokens = 600;
      for await (const event of chatAdapter.chatStream(messages, tools, { temperature: 0.7, maxTokens: roundMaxTokens })) {
        if (event.type === "content_delta" && event.text) {
          sendText(ws, { type: "llm_delta", text: event.text });
          assistantContent += event.text;
          textBuffer += event.text;
          await drainBuffer(false);
        } else if (event.type === "tool_call") {
          toolCalls.push({ id: event.id, name: event.name, arguments: event.arguments });
        } else if (event.type === "done") {
          break;
        }
      }
      console.log(`[meta-glasses] round ${rounds}: content_len=${assistantContent.length} tool_calls=${toolCalls.length}${toolCalls.length ? " (" + toolCalls.map(t => t.name + "/" + (t.arguments?.action || "?")).join(",") + ")" : ""}`);
      if (assistantContent || toolCalls.length > 0) {
        const m = { role: "assistant", content: assistantContent || "" };
        if (toolCalls.length > 0) {
          // The OpenAI-compatible adapter expects tool_calls as a JSON string
          // (it calls JSON.parse on it). Anthropic adapter accepts either.
          m.tool_calls = JSON.stringify(toolCalls.map(tc => ({ id: tc.id, name: tc.name, arguments: tc.arguments })));
        }
        messages.push(m);
      }
      if (toolCalls.length === 0) break;

      // Intercept crow_glasses_capture_photo so it actually captures via the
      // connected /session WebSocket instead of hitting the stdio MCP stub.
      // LLMs call it two ways: direct tool name, or via the crow_tools
      // addon-proxy wrapper with action="crow_glasses_capture_photo".
      const isCaptureTool = (tc) =>
        tc.name === "crow_glasses_capture_photo" ||
        (tc.name === "crow_tools" && tc.arguments?.action === "crow_glasses_capture_photo");
      // Destructive-tool spoken confirmation. If the LLM calls a destructive
      // tool, the FIRST call is intercepted — we store the pending state and
      // return a "confirmation required" tool-result. The LLM is expected to
      // speak the confirmation question and end the turn. On the NEXT turn,
      // if the LLM retries the same tool+args AND the user's transcript
      // starts with an affirmative within 60s, it executes. Anything else
      // clears the pending state.
      const confirmNow = (tc) => {
        if (!isDestructiveTool(tc.name)) return false;
        const pending = _pendingConfirms.get(device.id);
        const hash = canonicalArgsHash(tc.arguments);
        const transcriptOk = AFFIRMATIVE_STARTS.test(transcript || "");
        const transcriptNo = NEGATIVE_STARTS.test(transcript || "");
        if (pending
            && pending.toolName === tc.name
            && pending.argsHash === hash
            && (Date.now() - pending.at) < CONFIRM_TTL_MS
            && transcriptOk
            && !transcriptNo) {
          _pendingConfirms.delete(device.id);
          return true; // proceed to execute
        }
        // Fresh — store and return gate message. Clear any stale entry.
        _pendingConfirms.set(device.id, { toolName: tc.name, argsHash: hash, at: Date.now() });
        return "gated";
      };
      const localResults = [];
      const remoteCalls = [];
      for (const tc of toolCalls) {
        const gate = confirmNow(tc);
        if (gate === "gated") {
          localResults.push({
            id: tc.id,
            name: tc.name,
            result: `Confirmation required. Tell the user: "Are you sure you want to ${describeDestructiveAction(tc)}? Say yes to proceed." Then end your turn — do not call another tool.`,
            isError: false,
          });
          continue;
        }
        if (isCaptureTool(tc)) {
          const sess = _sessions.get(device.id);
          if (!sess) {
            localResults.push({ id: tc.id, name: tc.name, result: "No connected glasses session to capture from.", isError: true });
            continue;
          }
          try {
            // Resolve effective vision profile: device override → AI profile default → none.
            const visionConfig = await resolveVisionProfileConfig(db, device, aiProfile);
            if (visionConfig) {
              // Filler TTS to bridge cold-start (Qwen3-VL is ~25-30s cold).
              try { await flushTts("Let me look at that."); } catch {}
            }
            const r = await triggerCapture(sess);
            let description = null;
            if (visionConfig) {
              try {
                const { readFileSync } = await import("node:fs");
                const basename = decodeURIComponent(r.url.split("/").pop() || "");
                const diskPath = join(_photoDir, basename);
                const imageBytes = readFileSync(diskPath);
                const mime = basename.endsWith(".png") ? "image/png" : "image/jpeg";
                const { analyzeImage } = await loadVision();
                const result = await analyzeImage({
                  providerConfig: visionConfig,
                  prompt: "Describe what you see in this image. Be concise (1-3 sentences). This will be spoken to the user via TTS.",
                  imageBytes,
                  mime,
                  timeoutMs: 10_000,
                  maxTokens: 300,
                });
                description = result.description;
              } catch (visionErr) {
                console.warn(`[meta-glasses] vision analysis failed: ${visionErr.message}`);
              }
            }
            const msg = description
              ? `Photo captured. URL: ${r.url}. Vision analysis: ${description}. Use the description to answer the user.`
              : `Photo captured. URL: ${r.url} (${r.size} bytes). Tell the user the photo was saved — do not hallucinate its contents.`;
            localResults.push({ id: tc.id, name: tc.name, result: msg, isError: false });
          } catch (err) {
            localResults.push({ id: tc.id, name: tc.name, result: `Photo capture failed: ${err.message}`, isError: true });
          }
        } else {
          remoteCalls.push(tc);
        }
      }
      const remoteResults = remoteCalls.length ? await toolExecutor.executeToolCalls(remoteCalls) : [];
      const results = [...localResults, ...remoteResults];
      for (const r of results) {
        messages.push({ role: "tool", content: r.result, tool_call_id: r.id, tool_name: r.name });
        if (typeof r.result === "string" && r.result.length > 500) nextMaxTokens = 4000;
      }
    }
    await drainBuffer(true);
    sendText(ws, { type: "tts_end" });
    saveConvo(device.id, messages);
  } catch (err) {
    sendText(ws, { type: "error", code: "turn_failed", recoverable: true, message: err.message });
  } finally {
    if (toolExecutor) { try { await toolExecutor.close(); } catch {} }
    try { db.close(); } catch {}
  }
}

/* ---------- Express router ---------- */

export default function metaGlassesRouter(dashboardAuth) {
  const router = Router();
  // The Android app uploads captured photos via POST /api/meta-glasses/photo
  // with an `Authorization: Bearer <device-token>` header and no session
  // cookie. The route handler verifies the bearer token itself, so skip
  // dashboardAuth for that one endpoint; without this skip the request hits
  // the login page before it can reach the handler.
  router.use("/api/meta-glasses", (req, res, next) => {
    if (req.method === "POST" && req.path === "/photo") return next();
    return dashboardAuth(req, res, next);
  });

  router.get("/api/meta-glasses/devices", async (req, res) => {
    const { createDbClient } = await loadDb();
    const { listDevices } = await loadDeviceStore();
    const db = createDbClient();
    try {
      const devices = await listDevices(db);
      const annotated = devices.map(d => ({ ...d, connected: _sessions.has(d.id) }));
      res.json({ devices: annotated, connected_count: annotated.filter(d => d.connected).length });
    } finally {
      db.close();
    }
  });

  router.post("/api/meta-glasses/pair", async (req, res) => {
    const { createDbClient } = await loadDb();
    const { pairDevice } = await loadDeviceStore();
    const { id, name, generation, household_profile, stt_profile_id, ai_profile_slug, tts_profile_id } = req.body || {};
    if (!id || typeof id !== "string" || id.length > 128) {
      return res.status(400).json({ ok: false, error: "id required (string, ≤128 chars)" });
    }
    if (generation && !["gen1", "gen2", "unknown"].includes(generation)) {
      return res.status(400).json({ ok: false, error: "generation must be gen1|gen2|unknown" });
    }
    if (generation === "gen1") {
      return res.status(400).json({
        ok: false,
        error: "Gen 1 (Ray-Ban Stories) is not supported. Only Gen 2 (Ray-Ban Meta) exposes the DAT camera primitives we need.",
      });
    }
    const db = createDbClient();
    try {
      const result = await pairDevice(db, {
        id, name, generation: generation || "unknown",
        household_profile: household_profile || null,
        stt_profile_id: stt_profile_id || null,
        ai_profile_slug: ai_profile_slug || null,
        tts_profile_id: tts_profile_id || null,
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    } finally {
      db.close();
    }
  });

  router.delete("/api/meta-glasses/devices/:id", async (req, res) => {
    const { createDbClient } = await loadDb();
    const { unpairDevice } = await loadDeviceStore();
    const db = createDbClient();
    try {
      const result = await unpairDevice(db, req.params.id);
      const sess = _sessions.get(req.params.id);
      if (sess?.ws) { try { sess.ws.close(1000, "device_unpaired"); } catch {} _sessions.delete(req.params.id); }
      res.json({ ok: true, ...result });
    } finally {
      db.close();
    }
  });

  router.post("/api/meta-glasses/devices/:id", async (req, res) => {
    const { createDbClient } = await loadDb();
    const { updateDeviceProfiles } = await loadDeviceStore();
    const db = createDbClient();
    try {
      const updated = await updateDeviceProfiles(db, req.params.id, req.body || {});
      if (!updated) return res.status(404).json({ ok: false, error: "device not found" });
      res.json({ ok: true, device: updated });
    } finally {
      db.close();
    }
  });

  router.post("/api/meta-glasses/say", async (req, res) => {
    const { text, device_id } = req.body || {};
    if (!text || typeof text !== "string") {
      return res.status(400).json({ ok: false, error: "text required" });
    }
    const { createDbClient } = await loadDb();
    const { findDevice } = await loadDeviceStore();
    const { getDefaultTtsProfile, createTtsAdapter, getTtsProfiles } = await loadTts();
    const db = createDbClient();
    try {
      const targetIds = device_id ? [device_id] : [..._sessions.keys()];
      let delivered = 0;
      for (const id of targetIds) {
        const sess = _sessions.get(id);
        if (!sess?.ws) continue;
        const devRec = await findDevice(db, id);
        const ttsProfile = devRec?.tts_profile_id
          ? (await getTtsProfiles(db, { includeKeys: true })).find(p => p.id === devRec.tts_profile_id)
          : await getDefaultTtsProfile(db, { includeKeys: true });
        if (!ttsProfile) continue;
        const { adapter } = await createTtsAdapter(ttsProfile);
        const neg = negotiatePcm(adapter.name);
        if (neg) {
          sendText(sess.ws, { type: "tts_start", codec: neg.codec, sample_rate: neg.sampleRate });
        } else {
          console.warn(`[meta-glasses] TTS adapter '${adapter.name}' has no PCM path; sending mp3.`);
          sendText(sess.ws, { type: "tts_start", codec: "mp3", sample_rate: 24000 });
        }
        try {
          const stream = neg
            ? pcmStream(adapter, text, ttsProfile.defaultVoice, neg)
            : adapter.synthesize(text, ttsProfile.defaultVoice, {});
          for await (const chunk of stream) {
            sendBinary(sess.ws, chunk);
          }
          sendText(sess.ws, { type: "tts_end" });
          delivered++;
        } catch (err) {
          sendText(sess.ws, { type: "error", code: "tts_error", recoverable: true, message: err.message });
        }
      }
      res.json({ ok: true, delivered, targeted: targetIds.length });
    } finally {
      db.close();
    }
  });

  /**
   * Photo upload endpoint: Android POSTs the captured photo bytes here.
   * Authorized by the device's bearer token (same token as /session).
   * Returns { ok, url } with a stable URL the LLM / client can serve.
   */
  router.post("/api/meta-glasses/photo",
    express.raw({ type: "*/*", limit: "25mb" }),
    async (req, res) => {
      const deviceId = req.query.device_id;
      const reqId = req.query.request_id || randomUUID();
      const ext = (req.query.ext || "jpg").replace(/[^a-z0-9]/gi, "") || "jpg";
      const auth = req.headers["authorization"] || "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
      if (!deviceId || !token) return res.status(400).json({ ok: false, error: "device_id+token required" });

      const { createDbClient } = await loadDb();
      const { verifyToken } = await loadDeviceStore();
      const db = createDbClient();
      let device;
      try { device = await verifyToken(db, deviceId, token); } finally { try { db.close(); } catch {} }
      if (!device) return res.status(401).json({ ok: false, error: "bad token" });

      const fname = `${Date.now()}_${reqId}.${ext}`;
      const diskPath = join(_photoDir, fname);
      try { writeFileSync(diskPath, req.body); } catch (err) {
        return res.status(500).json({ ok: false, error: err.message });
      }
      const url = `/api/meta-glasses/photo/${encodeURIComponent(fname)}`;
      res.json({ ok: true, url, size: req.body.length });

      // Resolve any pending capture request for this request_id.
      const pending = _pendingCaptures.get(reqId);
      if (pending) {
        clearTimeout(pending.timer);
        _pendingCaptures.delete(reqId);
        pending.resolve({ ok: true, url, size: req.body.length });
      }
    });

  /** Serve a stored photo. Authed (so only the Nest / authed LLM callers can read). */
  router.get("/api/meta-glasses/photo/:name", async (req, res) => {
    const name = req.params.name.replace(/[^\w.\-]/g, "");
    const p = join(_photoDir, name);
    if (!existsSync(p)) return res.status(404).json({ ok: false, error: "not found" });
    res.sendFile(p);
  });

  /**
   * Trigger a photo capture on a connected glasses session. Blocks up to
   * 20 s for the phone to capture, upload, and reply with photo_ready.
   */
  router.post("/api/meta-glasses/capture", async (req, res) => {
    const { device_id } = req.body || {};
    const targetIds = device_id ? [device_id] : [..._sessions.keys()];
    const id = targetIds.find(x => _sessions.get(x));
    if (!id) return res.status(404).json({ ok: false, error: "no connected session" });
    const sess = _sessions.get(id);
    const reqId = randomUUID();
    const p = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        _pendingCaptures.delete(reqId);
        reject(new Error("capture timeout"));
      }, 20_000);
      _pendingCaptures.set(reqId, { resolve, reject, timer });
    });
    sendText(sess.ws, { type: "capture_photo", request_id: reqId });
    try {
      const result = await p;
      res.json(result);
    } catch (err) {
      res.status(504).json({ ok: false, error: err.message });
    }
  });

  /**
   * Remote push-to-talk: tells the paired device to begin/end a voice turn
   * over its existing /session WebSocket. Lets the Crow's Nest panel
   * (and any other dashboard surface) drive the voice loop without the
   * user having to hold a physical button on the phone.
   */
  router.post("/api/meta-glasses/turn", async (req, res) => {
    const { action, device_id } = req.body || {};
    if (action !== "begin" && action !== "end") {
      return res.status(400).json({ ok: false, error: "action must be 'begin' or 'end'" });
    }
    const targetIds = device_id ? [device_id] : [..._sessions.keys()];
    let delivered = 0;
    for (const id of targetIds) {
      const sess = _sessions.get(id);
      if (!sess?.ws) continue;
      sendText(sess.ws, { type: "remote_turn", action });
      delivered++;
    }
    res.json({ ok: true, delivered, targeted: targetIds.length });
  });

  return router;
}

/* ---------- WebSocket upgrade handler ---------- */

/**
 * Attach /api/meta-glasses/session WebSocket handler.
 * Call once at gateway startup with the HTTP server instance.
 */
export function setupWebSocket(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", async (req, socket, head) => {
    const url = req.url || "";
    if (!url.startsWith("/api/meta-glasses/session")) return;

    const params = new URL(url, "http://localhost").searchParams;
    const deviceId = params.get("device_id");
    const auth = req.headers["authorization"] || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : params.get("token");

    if (!deviceId || !token) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }

    const db = (await loadDb()).createDbClient();
    let device = null;
    try {
      const { verifyToken } = await loadDeviceStore();
      device = await verifyToken(db, deviceId, token);
    } finally { try { db.close(); } catch {} }
    if (!device) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const prior = _sessions.get(deviceId);
      if (prior?.ws && prior.ws !== ws) {
        try { prior.ws.close(1000, "superseded"); } catch {}
      }
      _sessions.set(deviceId, { ws, device, openedAt: Date.now() });

      sendText(ws, { type: "ready", session_id: `${deviceId}:${Date.now()}` });

      let inTurn = false;
      let turnBuffer = [];
      let turnOpts = {};
      let micSampleRate = 16000;
      let micIsPcm = false;

      let alive = true;
      ws.on("pong", () => { alive = true; });
      const pinger = setInterval(() => {
        if (!alive) { try { ws.terminate(); } catch {} clearInterval(pinger); return; }
        alive = false;
        try { ws.ping(); } catch {}
      }, 15000);

      ws.on("message", (raw, isBinary) => {
        if (isBinary) {
          if (inTurn) turnBuffer.push(raw);
          return;
        }
        let msg;
        try { msg = JSON.parse(raw.toString("utf8")); } catch { return; }
        switch (msg.type) {
          case "hello":
            micIsPcm = msg.codec === "pcm";
            micSampleRate = msg.sample_rate || 16000;
            turnOpts = {
              contentType: micIsPcm ? "audio/wav" : "audio/ogg;codecs=opus",
              filename: `turn.${micIsPcm ? "wav" : "opus"}`,
            };
            break;
          case "turn_start":
            inTurn = true;
            turnBuffer = [];
            break;
          case "turn_end": {
            if (!inTurn) return;
            inTurn = false;
            const raw = Buffer.concat(turnBuffer);
            turnBuffer = [];
            const audio = micIsPcm ? wrapPcmAsWav(raw, micSampleRate) : raw;
            if (!acquireTurnLock(device.id, ws)) {
              sendText(ws, { type: "error", code: "turn_busy", recoverable: true });
              break;
            }
            runVoiceTurn(ws, device, audio, turnOpts)
              .catch((err) => {
                sendText(ws, { type: "error", code: "turn_failed", recoverable: true, message: err.message });
              })
              .finally(() => releaseTurnLock(device.id, ws));
            break;
          }
          case "photo_error": {
            // Phone reports a capture failure (permission, stream start, etc.).
            // Reject the matching pending capture so callers see a real error,
            // not a 20 s timeout.
            const pending = _pendingCaptures.get(msg.request_id);
            if (pending) {
              clearTimeout(pending.timer);
              _pendingCaptures.delete(msg.request_id);
              pending.reject(new Error(`${msg.code || "capture_failed"}: ${msg.message || ""}`));
            }
            break;
          }
        }
      });

      ws.on("close", () => {
        clearInterval(pinger);
        if (_sessions.get(deviceId)?.ws === ws) _sessions.delete(deviceId);
        releaseTurnLock(deviceId, ws);
      });
      ws.on("error", () => { /* close follows */ });
    });
  });

  return { openSessionCount: () => _sessions.size };
}
