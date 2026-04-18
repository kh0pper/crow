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
import { existsSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";

// Bus used to push glasses media-state changes to the Nest player bar
// via /dashboard/streams/glasses (see servers/gateway/routes/streams.js).
// Imported once here and fired from the few highest-signal mutation
// sites; the 5-min fallback poll in shared/player.js catches any
// state changes that bypass these sites (rare voice-turn fast-paths,
// audio-stream-done callbacks, etc.).
import glassesBus from "../../../servers/shared/event-bus.js";

function emitGlassesMediaState(deviceId) {
  if (!deviceId) return;
  try {
    const state = _devicePlaybackState.get(deviceId) || "idle";
    const np = _nowPlaying.get(deviceId);
    glassesBus.emit("glasses:media", {
      deviceId,
      state,
      title: np?.title || null,
      artist: np?.artist || null,
      queueLength: np?.queueLength || 0,
    });
  } catch {
    // Never break the mutation path on a broken subscriber.
  }
}

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
async function loadS3()           { return import(pathToFileURL(join(gatewayDir, "..", "storage", "s3-client.js")).href); }

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
  const existing = _turnLocks.get(deviceId);
  if (existing) {
    // Re-entrant: if the SAME WebSocket already holds the lock, allow re-entry.
    // This is the case when an in-progress voice turn calls pushAudioStream as
    // part of intercepting an `_audio_stream` envelope from a tool result —
    // the turn already owns the lock, so we shouldn't return busy. A different
    // ws still gets refused (genuine concurrent-turn case).
    if (existing.ws === ws) return true;
    return false;
  }
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

/* ---------- Fast-path: simple media voice commands ----------
 * Matches short media commands (stop, pause, resume, next/skip) and executes
 * them directly without going through the LLM. Saves ~4-7 seconds per command.
 * Returns { action, say } if matched, null if the LLM should handle it.
 */
const MEDIA_FAST_PATHS = [
  { pattern: /^(stop|stop\s+(the\s+)?(music|audio|playback|playing|song|track))$/i,
    needsState: ["playing", "paused", "idle"], action: "stop", say: "Stopped." },
  { pattern: /^(pause|pause\s+(the\s+)?(music|audio|playback|playing|song|track)|pause\s+it)$/i,
    needsState: ["playing"], action: "pause", say: "Paused." },
  { pattern: /^(resume|continue|unpause)$/i,
    needsState: ["paused"], action: "resume", say: "Resuming." },
  { pattern: /^(next|skip|next\s+(song|track)|skip\s+(song|track))$/i,
    needsState: ["playing"], action: "next", say: "Next track." },
];

function matchMediaFastPath(transcript, deviceId) {
  const state = _devicePlaybackState.get(deviceId) || "idle";
  // STT often adds trailing punctuation ("Stop.", "Pause!") — strip it
  const cleaned = transcript.replace(/[.!?,;:]+$/, "").trim();
  for (const fp of MEDIA_FAST_PATHS) {
    if (fp.pattern.test(cleaned) && fp.needsState.includes(state)) {
      return fp;
    }
  }
  return null;
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
      // Ask the GPU orchestrator to make the provider resident before we
      // resolve + call it. Silent best-effort — if orchestrator isn't
      // wired or docker control fails, we fall through to the direct
      // provider call and surface whatever error that produces.
      try {
        const { acquireProvider } = await import(pathToFileURL(join(gatewayDir, "gpu-orchestrator.js")).href);
        await acquireProvider(profile.provider_id);
      } catch (err) {
        console.warn(`[meta-glasses] gpu-orchestrator acquire(${profile.provider_id}) failed: ${err.message}`);
      }
      const { resolveProvider } = await loadResolveProv();
      return await resolveProvider(profile.provider_id, profile.model_id);
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

    // Fast-path: simple media commands skip the LLM entirely (~800ms vs 5-8s)
    const mediaFast = matchMediaFastPath(transcript, device.id);
    if (mediaFast) {
      if (mediaFast.action === "stop") {
        clearAudioQueue(device.id);
        sendMediaControl(device.id, "stop");
        _devicePlaybackState.set(device.id, "idle");
        _nowPlaying.delete(device.id);
      } else if (mediaFast.action === "next") {
        sendMediaControl(device.id, "stop");
        const w = _streamDoneWaiters.get(device.id);
        if (w) {
          clearTimeout(w.timer);
          _streamDoneWaiters.delete(device.id);
          const absorb = setTimeout(() => _streamDoneWaiters.delete(device.id), 2000);
          _streamDoneWaiters.set(device.id, {
            resolve: () => { clearTimeout(absorb); _streamDoneWaiters.delete(device.id); },
            reject: () => { clearTimeout(absorb); _streamDoneWaiters.delete(device.id); },
            timer: absorb,
          });
          w.resolve();
        }
      } else {
        sendMediaControl(device.id, mediaFast.action);
        _devicePlaybackState.set(device.id, mediaFast.action === "pause" ? "paused" : "playing");
      }
      emitGlassesMediaState(device.id);
      // Speak brief confirmation via TTS
      const { getTtsProfiles, createTtsAdapter, getDefaultTtsProfile } = await loadTts();
      const ttsProfile = device.tts_profile_id
        ? (await getTtsProfiles(db, { includeKeys: true })).find(p => p.id === device.tts_profile_id)
        : await getDefaultTtsProfile(db, { includeKeys: true });
      if (ttsProfile) {
        try {
          const { adapter: ttsAdapter } = await createTtsAdapter(ttsProfile);
          const ttsNeg = negotiatePcm(ttsAdapter.name);
          if (ttsNeg) {
            sendText(ws, { type: "tts_start", codec: ttsNeg.codec, sample_rate: ttsNeg.sampleRate });
            for await (const chunk of pcmStream(ttsAdapter, mediaFast.say, ttsProfile.defaultVoice, ttsNeg)) {
              sendBinary(ws, chunk);
            }
            sendText(ws, { type: "tts_end" });
          }
        } catch (err) {
          console.warn(`[meta-glasses] fast-path TTS error: ${err.message}`);
        }
      }
      // Save to conversation history so subsequent LLM turns have context
      const priorMessages = getConvo(device.id);
      saveConvo(device.id, [
        ...priorMessages,
        { role: "user", content: transcript },
        { role: "assistant", content: mediaFast.say },
      ]);
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
    const { adapter: chatAdapter } = await createAdapterFromProfile(aiProfile, aiProfile.defaultModel, db);

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
                  timeoutMs: 30_000,
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
        // Intercept `_audio_stream` envelopes: trigger pushAudioStream to the
        // paired device and replace the LLM-visible result with a short prose
        // line so the LLM doesn't parrot the URL or auth sentinel back at the
        // user. Anything without a JSON envelope passes through unchanged.
        let piped = r.result;
        if (typeof piped === "string" && piped.includes('"_audio_stream_control"')) {
          try {
            const parsed = JSON.parse(piped);
            const ctl = parsed?._audio_stream_control;
            if (ctl?.action === "stop") {
              clearAudioQueue(device.id);
              sendMediaControl(device.id, "stop");
              _devicePlaybackState.set(device.id, "idle");
              _nowPlaying.delete(device.id);
              emitGlassesMediaState(device.id);
              piped = parsed.prose || "Stopped.";
            } else if (ctl?.action === "pause") {
              sendMediaControl(device.id, "pause");
              _devicePlaybackState.set(device.id, "paused");
              emitGlassesMediaState(device.id);
              piped = parsed.prose || "Paused.";
            } else if (ctl?.action === "resume") {
              sendMediaControl(device.id, "resume");
              _devicePlaybackState.set(device.id, "playing");
              emitGlassesMediaState(device.id);
              piped = parsed.prose || "Resuming.";
            } else if (ctl?.action === "next") {
              // Send stop first, then resolve the chain waiter to advance.
              sendMediaControl(device.id, "stop");
              const w = _streamDoneWaiters.get(device.id);
              if (w) {
                clearTimeout(w.timer);
                _streamDoneWaiters.delete(device.id);
                // Absorb stale audio_stream_done from the killed track
                const absorb = setTimeout(() => _streamDoneWaiters.delete(device.id), 2000);
                _streamDoneWaiters.set(device.id, {
                  resolve: () => { clearTimeout(absorb); _streamDoneWaiters.delete(device.id); },
                  reject: () => { clearTimeout(absorb); _streamDoneWaiters.delete(device.id); },
                  timer: absorb,
                });
                w.resolve();
              }
              piped = parsed.prose || "Next track.";
            }
          } catch { /* leave untouched */ }
        }
        if (typeof piped === "string" && piped.includes('"_audio_stream"')) {
          try {
            const parsed = JSON.parse(piped);
            const env = parsed?._audio_stream;
            if (env && env.url && env.codec) {
              // Set up the queue (if any) BEFORE pushing the first stream so
              // that pushAudioStream's chaining sees it. Empty queue = single
              // track. Each queue item is {url, codec, auth, sampleRate?, channels?}.
              setAudioQueue(device.id, Array.isArray(env.queue) ? env.queue : []);
              _devicePlaybackState.set(device.id, "playing");
              _nowPlaying.set(device.id, {
                title: parsed.title || null,
                artist: parsed.artist || null,
                artworkUrl: parsed.artwork_url || null,
                queueLength: (Array.isArray(env.queue) ? env.queue.length : 0) + 1,
              });
              emitGlassesMediaState(device.id);
              // Fire-and-forget: don't await pushAudioStream so the voice turn
              // can finish speaking the prose immediately. The stream runs in
              // the background; failures are handled silently.
              pushAudioStream(device.id, {
                url: env.url,
                codec: env.codec,
                sampleRate: env.sample_rate,
                channels: env.channels,
                auth: env.auth,
                title: parsed.title || null,
                artist: parsed.artist || null,
                artworkUrl: parsed.artwork_url || null,
              }).then(outcome => {
                if (!outcome?.delivered) {
                  _devicePlaybackState.set(device.id, "idle");
                  _nowPlaying.delete(device.id);
                  emitGlassesMediaState(device.id);
                }
              }).catch(() => {
                _devicePlaybackState.set(device.id, "idle");
                _nowPlaying.delete(device.id);
                emitGlassesMediaState(device.id);
              });
              piped = parsed.prose || `Started playback (${env.codec}).`;
            }
          } catch {
            // Not a JSON envelope — leave untouched.
          }
        }
        // Phase 6 C.2: capture-and-attach-photo sentinel. The MCP tool
        // returns { _capture_and_attach: { device_id, session_id?, caption? } };
        // the panel actually does the work (triggerCapture + note append +
        // caption backfill row). This keeps the MCP process clean of
        // WebSocket/session access while still letting the LLM call a
        // single tool to chain capture + attach.
        if (typeof piped === "string" && piped.includes('"_capture_and_attach"')) {
          try {
            const parsed = JSON.parse(piped);
            const env = parsed?._capture_and_attach;
            if (env && env.device_id === device.id) {
              piped = await handleCaptureAndAttach(env, db);
            }
          } catch (err) {
            piped = `Capture-and-attach failed: ${err.message}`;
          }
        }
        messages.push({ role: "tool", content: piped, tool_call_id: r.id, tool_name: r.name });
        if (typeof piped === "string" && piped.length > 500) nextMaxTokens = 4000;
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

/* ---------- Phase 6 C.2 helpers: capture-and-attach + caption backfill + remint ---------- */

async function handleCaptureAndAttach({ device_id, session_id, caption }, db) {
  const sess = _sessions.get(device_id);
  if (!sess) return "No connected glasses session to capture from.";
  // Resolve the active session. The MCP tool allows caller to pass
  // session_id explicitly; otherwise pick the most-recent active one
  // for this device.
  let sid = session_id || null;
  let noteId = null;
  try {
    if (sid) {
      const { rows } = await db.execute({ sql: `SELECT note_id FROM glasses_note_sessions WHERE id = ? AND status = 'active'`, args: [sid] });
      noteId = rows[0]?.note_id ?? null;
      if (!noteId) return "Session not found or not active.";
    } else {
      const { rows } = await db.execute({
        sql: `SELECT id, note_id FROM glasses_note_sessions
              WHERE device_id = ? AND status = 'active'
              ORDER BY started_at DESC LIMIT 1`,
        args: [device_id],
      });
      if (!rows[0]) return "No active note session for this device — start one first with crow_glasses_start_note_session.";
      sid = rows[0].id;
      noteId = rows[0].note_id;
    }
  } catch (err) {
    return `Capture-and-attach failed (session lookup): ${err.message}`;
  }

  // Trigger capture. triggerCapture resolves with `{ ok, url, size,
  // photo_id, minio_key }` when the phone's upload completes (the route
  // handler now awaits recordGlassesPhoto before resolving the pending).
  let captureResult;
  try {
    captureResult = await triggerCapture(sess);
  } catch (err) {
    return `Capture failed: ${err.message}`;
  }
  const photoId = captureResult?.photo_id;
  if (!photoId) return "Capture succeeded but no photo id was returned — attach skipped.";

  // Append markdown ref using the photo:// sentinel scheme. The Notes
  // tab's renderer re-mints presigned URLs at render time, so the 1 h
  // TTL never bites a reader.
  const captionText = caption || "[caption pending]";
  const stamp = new Date().toTimeString().slice(0, 5);
  const line = `\n![${captionText.replace(/[\]\[]/g, "")}](photo://${photoId}) *${stamp}*\n`;
  try {
    await db.execute({
      sql: `UPDATE research_notes SET content = COALESCE(content, '') || ?, updated_at = datetime('now') WHERE id = ?`,
      args: [line, noteId],
    });
  } catch (err) {
    return `Captured but note update failed: ${err.message}`;
  }

  // If caller didn't supply a caption, enqueue a backfill row. The
  // scheduler's runCaptionBackfill tick will replace the placeholder
  // with the auto-caption once recordGlassesPhoto's enrichment
  // pipeline has written glasses_photos.caption.
  if (!caption) {
    try {
      await db.execute({
        sql: `INSERT OR IGNORE INTO glasses_caption_backfill (note_id, photo_id)
              VALUES (?, ?)`,
        args: [noteId, photoId],
      });
    } catch {}
  }

  return `Photo ${photoId} attached to note ${noteId} with caption "${captionText}".`;
}

export async function runCaptionBackfill(db) {
  const MAX_ATTEMPTS = 5;
  const { rows } = await db.execute({
    sql: `SELECT note_id, photo_id, attempts FROM glasses_caption_backfill`,
    args: [],
  });
  let replaced = 0;
  let dropped = 0;
  for (const row of rows) {
    // Look up the photo's caption (set by _enrichGlassesPhoto).
    const { rows: pr } = await db.execute({
      sql: `SELECT caption FROM glasses_photos WHERE id = ?`,
      args: [row.photo_id],
    });
    const caption = pr[0]?.caption;
    if (caption) {
      // Find the `![\[caption pending\]](photo://<id>)` placeholder and replace.
      const noteRow = await db.execute({ sql: `SELECT content FROM research_notes WHERE id = ?`, args: [row.note_id] });
      const content = String(noteRow.rows[0]?.content || "");
      // Regex: ![<anything>](photo://<id>) — the caption field may be
      // literally "[caption pending]" (square brackets are pre-stripped
      // in handleCaptureAndAttach) or any other placeholder. Replace only
      // the first match targeting this photo_id.
      const re = new RegExp(`!\\[[^\\]]*\\]\\(photo://${row.photo_id}\\b([^)]*)\\)`, "g");
      let found = false;
      const safeCaption = String(caption).replace(/[\]\[]/g, "");
      const newContent = content.replace(re, (match, tail) => {
        if (found) return match;
        found = true;
        return `![${safeCaption}](photo://${row.photo_id}${tail})`;
      });
      if (found) {
        await db.execute({
          sql: `UPDATE research_notes SET content = ?, updated_at = datetime('now') WHERE id = ?`,
          args: [newContent, row.note_id],
        });
        replaced++;
      }
      await db.execute({
        sql: `DELETE FROM glasses_caption_backfill WHERE note_id = ? AND photo_id = ?`,
        args: [row.note_id, row.photo_id],
      });
    } else if (Number(row.attempts || 0) + 1 >= MAX_ATTEMPTS) {
      await db.execute({
        sql: `DELETE FROM glasses_caption_backfill WHERE note_id = ? AND photo_id = ?`,
        args: [row.note_id, row.photo_id],
      });
      dropped++;
    } else {
      await db.execute({
        sql: `UPDATE glasses_caption_backfill SET attempts = attempts + 1 WHERE note_id = ? AND photo_id = ?`,
        args: [row.note_id, row.photo_id],
      });
    }
  }
  return { replaced, dropped };
}

/**
 * Phase 6 C.2: rewrite `photo://<id>` markdown refs to freshly-minted
 * presigned URLs at render time. Notes store the sentinel; the renderer
 * swaps in real URLs with a 1 h TTL so opening a note days later still
 * shows working images. The regex requires digit-only IDs + a word
 * boundary so a literal `photo://xyz` in operator-typed text is
 * preserved verbatim. Caps at 200 unique IDs per render (SQLite's
 * default SQLITE_MAX_VARIABLE_NUMBER is 999; 200 gives headroom).
 */
export async function remintPhotoRefs(db, content) {
  const matches = [...String(content || "").matchAll(/photo:\/\/(\d+)\b/g)];
  if (matches.length === 0) return content;
  const ids = [...new Set(matches.map(m => Number(m[1])))].slice(0, 200);
  if (matches.length > ids.length) {
    console.warn(`[meta-glasses] remintPhotoRefs: note has ${matches.length} refs; capped to ${ids.length}`);
  }
  const { rows } = await db.execute({
    sql: `SELECT id, minio_key, disk_path FROM glasses_photos WHERE id IN (${ids.map(() => "?").join(",")})`,
    args: ids,
  });
  const byId = new Map(rows.map(r => [Number(r.id), r]));
  let s3Ready = false;
  let getPresignedUrl = null;
  try {
    const s3 = await loadS3();
    s3Ready = await s3.isAvailable();
    getPresignedUrl = s3.getPresignedUrl;
  } catch {}
  const PLACEHOLDER = "data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2264%22%20height%3D%2264%22%3E%3Crect%20width%3D%2264%22%20height%3D%2264%22%20fill%3D%22%23888%22%2F%3E%3Ctext%20x%3D%2232%22%20y%3D%2234%22%20text-anchor%3D%22middle%22%20font-size%3D%2210%22%20fill%3D%22%23fff%22%3Emissing%3C%2Ftext%3E%3C%2Fsvg%3E";
  const resolved = new Map();
  for (const id of ids) {
    const row = byId.get(id);
    let url = PLACEHOLDER;
    if (row?.minio_key && s3Ready && getPresignedUrl) {
      try { url = await getPresignedUrl(row.minio_key, { expiry: 3600 }); } catch {}
    } else if (row?.disk_path) {
      url = `/api/meta-glasses/photo/${encodeURIComponent(String(row.disk_path).split("/").pop())}`;
    }
    resolved.set(id, url);
  }
  return String(content).replace(/photo:\/\/(\d+)\b/g, (_, idStr) => resolved.get(Number(idStr)) || PLACEHOLDER);
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

  // Library: delete a photo by id. Removes the MinIO object (if any),
  // unlinks the disk file (if any), then deletes the DB row. Redirect
  // back to the library tab so Turbo can re-extract the
  // mg-library-results frame from the full-page response.
  router.post("/dashboard/meta-glasses/library/delete", dashboardAuth, async (req, res) => {
    const id = parseInt(req.body?.id, 10);
    if (!id) return res.redirectAfterPost("/dashboard/meta-glasses?tab=library");
    const { createDbClient } = await loadDb();
    const db = createDbClient();
    try {
      const { rows } = await db.execute({
        sql: `SELECT minio_key, disk_path FROM glasses_photos WHERE id = ?`,
        args: [id],
      });
      const row = rows[0];
      if (row?.minio_key) {
        try {
          const { deleteObject } = await loadS3();
          await deleteObject(row.minio_key);
        } catch (err) {
          console.warn(`[meta-glasses] library delete: MinIO removeObject failed for ${row.minio_key}: ${err.message}`);
        }
      }
      if (row?.disk_path) {
        try {
          const { unlinkSync } = await import("node:fs");
          unlinkSync(row.disk_path);
        } catch {}
      }
      await db.execute({ sql: `DELETE FROM glasses_photos WHERE id = ?`, args: [id] });
    } catch (err) {
      console.warn(`[meta-glasses] library delete for ${id} failed: ${err.message}`);
    } finally {
      try { db.close(); } catch {}
    }
    res.redirectAfterPost("/dashboard/meta-glasses?tab=library");
  });

  // Library: delete all photos for a single device. Per-device scope
  // is explicit — cross-device wipe is out of scope this phase.
  router.post("/dashboard/meta-glasses/library/delete-all", dashboardAuth, async (req, res) => {
    const deviceId = String(req.body?.device_id || "").trim();
    if (!deviceId) return res.redirectAfterPost("/dashboard/meta-glasses?tab=library");
    const { createDbClient } = await loadDb();
    const db = createDbClient();
    let removed = 0;
    try {
      const { rows } = await db.execute({
        sql: `SELECT id, minio_key, disk_path FROM glasses_photos WHERE device_id = ?`,
        args: [deviceId],
      });
      const { unlinkSync } = await import("node:fs");
      let s3;
      try { s3 = await loadS3(); } catch {}
      for (const row of rows) {
        if (s3 && row.minio_key) {
          try { await s3.deleteObject(row.minio_key); } catch {}
        }
        if (row.disk_path) { try { unlinkSync(row.disk_path); } catch {} }
      }
      const del = await db.execute({
        sql: `DELETE FROM glasses_photos WHERE device_id = ?`,
        args: [deviceId],
      });
      removed = Number(del.rowsAffected || 0);
      console.log(`[meta-glasses] library delete-all: removed ${removed} photos for device=${deviceId}`);
    } catch (err) {
      console.warn(`[meta-glasses] library delete-all for device=${deviceId} failed: ${err.message}`);
    } finally {
      try { db.close(); } catch {}
    }
    res.redirectAfterPost("/dashboard/meta-glasses?tab=library");
  });

  // Notes: delete a session + its backing research_notes row.
  router.post("/dashboard/meta-glasses/notes/delete", dashboardAuth, async (req, res) => {
    const sid = parseInt(req.body?.session_id, 10);
    if (!sid) return res.redirectAfterPost("/dashboard/meta-glasses?tab=notes");
    const { createDbClient } = await loadDb();
    const db = createDbClient();
    try {
      const { rows } = await db.execute({ sql: `SELECT note_id FROM glasses_note_sessions WHERE id = ?`, args: [sid] });
      const noteId = rows[0]?.note_id;
      await db.execute({ sql: `DELETE FROM glasses_note_sessions WHERE id = ?`, args: [sid] });
      if (noteId) {
        await db.execute({ sql: `DELETE FROM research_notes WHERE id = ?`, args: [noteId] });
        await db.execute({ sql: `DELETE FROM glasses_caption_backfill WHERE note_id = ?`, args: [noteId] });
      }
    } catch (err) {
      console.warn(`[meta-glasses] notes delete for session=${sid} failed: ${err.message}`);
    } finally {
      try { db.close(); } catch {}
    }
    res.redirectAfterPost("/dashboard/meta-glasses?tab=notes");
  });

  // Library: run the daily retention pipeline now (operator-triggered).
  // Useful for verifying the cron without waiting until 03:00. Returns a
  // JSON summary so the UI can show what changed.
  router.post("/dashboard/meta-glasses/library/retention-run", dashboardAuth, async (req, res) => {
    const { createDbClient } = await loadDb();
    const db = createDbClient();
    try {
      const summary = await runPhotoRetention(db);
      res.json({ ok: true, summary });
    } catch (err) {
      console.warn(`[meta-glasses] retention-run failed: ${err.message}`);
      res.status(500).json({ ok: false, error: err.message });
    } finally {
      try { db.close(); } catch {}
    }
  });

  // Operator endpoint: push an audio stream (compressed media) to a paired
  // device. Useful for diagnostics, testing the Phase 4 MediaCodec path, or
  // playing arbitrary content from the Nest without going through the LLM.
  //
  // Body: { device_id, url, codec, sample_rate?, channels?, auth? }
  //   auth must be one of the allow-listed sentinels (see pushAudioStream).
  router.post("/api/meta-glasses/stream", async (req, res) => {
    const { device_id, url, codec, sample_rate, channels, auth, title, artist, artwork_url, queue } = req.body || {};
    if (!device_id || !url || !codec) {
      return res.status(400).json({ ok: false, error: "device_id, url, codec required" });
    }
    // URL-host validation: when funkwhale-authed, reject URLs that don't
    // match FUNKWHALE_URL's hostname. Prevents using this endpoint as a
    // confused deputy to send FUNKWHALE_ACCESS_TOKEN to arbitrary hosts.
    if (auth === "funkwhale" && process.env.FUNKWHALE_URL) {
      try {
        const fwHost = new URL(process.env.FUNKWHALE_URL).hostname;
        const validate = (u) => {
          try { return new URL(u).hostname === fwHost; } catch { return false; }
        };
        if (!validate(url)) {
          return res.status(400).json({ ok: false, error: "url_host_not_allowed" });
        }
        if (Array.isArray(queue)) {
          for (const q of queue) {
            if (!validate(q?.url)) {
              return res.status(400).json({ ok: false, error: "queue_url_host_not_allowed" });
            }
          }
        }
      } catch (err) {
        return res.status(400).json({ ok: false, error: "url_validation_failed" });
      }
    }
    // If a queue is provided, seed it before pushing the first track so the
    // existing chain logic picks up tracks 2..N via audio_stream_done ack.
    if (Array.isArray(queue) && queue.length > 0) {
      setAudioQueue(device_id, queue);
    }
    const outcome = await pushAudioStream(device_id, {
      url, codec, sampleRate: sample_rate, channels, auth, title, artist, artworkUrl: artwork_url,
    });
    return res.json({ ok: outcome?.delivered === true, ...outcome });
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

  /* ---------- Media control REST endpoints ---------- */

  const ALLOWED_MEDIA_ACTIONS = new Set(["stop", "pause", "resume", "next"]);

  router.get("/api/meta-glasses/media/status", (req, res) => {
    const deviceId = req.query.device_id;
    if (!deviceId) return res.status(400).json({ error: "device_id required" });
    const state = _devicePlaybackState.get(deviceId) || "idle";
    const np = _nowPlaying.get(deviceId);
    res.json({
      state,
      title: np?.title || null,
      artist: np?.artist || null,
      queue_length: np?.queueLength || 0,
    });
  });

  router.post("/api/meta-glasses/media/control", (req, res) => {
    const { device_id, action } = req.body || {};
    if (!device_id || !action) return res.status(400).json({ error: "device_id and action required" });
    if (!ALLOWED_MEDIA_ACTIONS.has(action)) return res.status(400).json({ error: "unknown action" });
    const sess = _sessions.get(device_id);
    if (!sess?.ws) return res.status(404).json({ error: "device not connected" });

    if (action === "stop") {
      clearAudioQueue(device_id);
      sendMediaControl(device_id, "stop");
      _devicePlaybackState.set(device_id, "idle");
      _nowPlaying.delete(device_id);
    } else if (action === "next") {
      // Send stop to phone first, then resolve the chain waiter so it
      // advances to the next track. Register a temporary waiter to absorb
      // the stale audio_stream_done from the killed track.
      sendMediaControl(device_id, "stop");
      const w = _streamDoneWaiters.get(device_id);
      if (w) {
        clearTimeout(w.timer);
        _streamDoneWaiters.delete(device_id);
        // Absorb the stale ack from the killed track: register a throwaway
        // waiter that auto-expires, so the ack doesn't set state to idle.
        const absorb = setTimeout(() => _streamDoneWaiters.delete(device_id), 2000);
        _streamDoneWaiters.set(device_id, {
          resolve: () => { clearTimeout(absorb); _streamDoneWaiters.delete(device_id); },
          reject: () => { clearTimeout(absorb); _streamDoneWaiters.delete(device_id); },
          timer: absorb,
        });
        w.resolve(); // wake the chain to push the next track
      }
    } else {
      sendMediaControl(device_id, action);
      _devicePlaybackState.set(device_id, action === "pause" ? "paused" : "playing");
    }
    emitGlassesMediaState(device_id);
    res.json({ ok: true, state: _devicePlaybackState.get(device_id) || "idle" });
  });

  /**
   * Artwork proxy: phone fetches album art via the gateway so no arbitrary
   * URLs are fetched on-device. Validates src host against an allow-list
   * (Funkwhale, localhost). Rejects unknown hosts that resolve to RFC1918 /
   * link-local / Tailscale CGNAT. Streams bytes back without buffering.
   */
  router.get("/api/meta-glasses/artwork", async (req, res) => {
    // Auth: bearer token matching a paired device (same as /session upgrade).
    const deviceId = req.query.device_id;
    const authHdr = req.headers["authorization"] || "";
    const token = authHdr.startsWith("Bearer ") ? authHdr.slice(7) : null;
    if (!deviceId || !token) return res.status(401).json({ error: "unauthorized" });
    const { createDbClient } = await loadDb();
    const db = createDbClient();
    let device = null;
    try {
      const { verifyToken } = await loadDeviceStore();
      device = await verifyToken(db, deviceId, token);
    } finally { try { db.close(); } catch {} }
    if (!device) return res.status(401).json({ error: "invalid token" });

    const src = req.query.src;
    if (!src) return res.status(400).json({ error: "src required" });

    // Validate URL
    let srcUrl;
    try { srcUrl = new URL(src); } catch { return res.status(400).json({ error: "invalid url" }); }
    if (srcUrl.protocol !== "http:" && srcUrl.protocol !== "https:") {
      return res.status(400).json({ error: "unsupported scheme" });
    }

    // Build allow-list from env
    const funkwhaleUrl = process.env.FUNKWHALE_URL || "";
    const allowHosts = new Set(["localhost", "127.0.0.1"]);
    try { if (funkwhaleUrl) allowHosts.add(new URL(funkwhaleUrl).hostname); } catch {}

    const isAllowListed = allowHosts.has(srcUrl.hostname);
    if (!isAllowListed) {
      // Resolve and reject private ranges
      const dns = await import("node:dns");
      try {
        const addr = await new Promise((resolve, reject) => {
          dns.lookup(srcUrl.hostname, { family: 4 }, (err, address) => {
            if (err) reject(err); else resolve(address);
          });
        });
        const parts = addr.split(".").map(Number);
        const [a, b] = parts;
        const isPrivate = a === 10
          || (a === 172 && b >= 16 && b <= 31)
          || (a === 192 && b === 168)
          || (a === 169 && b === 254)
          || a === 127
          || (a === 100 && b >= 64 && b <= 127); // CGNAT / Tailscale
        if (isPrivate) return res.status(403).json({ error: "host not allowed" });
      } catch {
        return res.status(502).json({ error: "dns lookup failed" });
      }
    }

    // Inject Funkwhale bearer if host matches FUNKWHALE_URL
    const headers = {};
    try {
      if (funkwhaleUrl && srcUrl.hostname === new URL(funkwhaleUrl).hostname && process.env.FUNKWHALE_ACCESS_TOKEN) {
        headers.Authorization = `Bearer ${process.env.FUNKWHALE_ACCESS_TOKEN}`;
      }
    } catch {}

    // Abort upstream fetch if client disconnects
    const controller = new AbortController();
    req.on("close", () => { try { controller.abort(); } catch {} });

    try {
      const upstream = await fetch(src, { headers, signal: controller.signal, redirect: "follow" });
      if (!upstream.ok || !upstream.body) {
        return res.status(upstream.status || 502).json({ error: `upstream ${upstream.status}` });
      }
      const ct = upstream.headers.get("content-type") || "application/octet-stream";
      const cl = upstream.headers.get("content-length");
      res.setHeader("Content-Type", ct);
      if (cl) res.setHeader("Content-Length", cl);
      const reader = upstream.body.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      res.end();
    } catch (err) {
      if (!res.headersSent) res.status(502).json({ error: err.message });
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

      // Phase 6 C.2: await the library INSERT so we can include the
      // photoId in the pending capture resolve (so chained tools like
      // crow_glasses_capture_and_attach_photo get the id). Enrichment
      // (vision/OCR) still runs fire-and-forget inside recordGlassesPhoto,
      // so this await is ~50-200ms (MinIO upload + single DB INSERT).
      let photoMeta = null;
      try {
        photoMeta = await recordGlassesPhoto({
          deviceId: device.id,
          diskPath, fname,
          mime: req.body.length > 0 ? (ext === "png" ? "image/png" : "image/jpeg") : "application/octet-stream",
          size: req.body.length,
        });
      } catch (err) {
        console.warn(`[meta-glasses] library insert failed: ${err.message}`);
      }

      const pending = _pendingCaptures.get(reqId);
      if (pending) {
        clearTimeout(pending.timer);
        _pendingCaptures.delete(reqId);
        pending.resolve({
          ok: true,
          url,
          size: req.body.length,
          photo_id: photoMeta?.photoId || null,
          minio_key: photoMeta?.minioKey || null,
        });
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
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

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
      _sessions.set(deviceId, { ws, device, openedAt: Date.now(), lastPingAt: Date.now() });

      sendText(ws, { type: "ready", session_id: `${deviceId}:${Date.now()}` });

      let inTurn = false;
      let turnBuffer = [];
      let turnOpts = {};
      let micSampleRate = 16000;
      let micIsPcm = false;

      let alive = true;
      ws.on("pong", () => {
        alive = true;
        const s = _sessions.get(deviceId);
        if (s && s.ws === ws) s.lastPingAt = Date.now();
      });
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
          case "audio_stream_done": {
            const w = _streamDoneWaiters.get(device.id);
            if (w) {
              clearTimeout(w.timer);
              _streamDoneWaiters.delete(device.id);
              w.resolve();
            } else {
              // No waiter = last track finished naturally (single or end of album)
              _devicePlaybackState.set(device.id, "idle");
              _nowPlaying.delete(device.id);
              emitGlassesMediaState(device.id);
            }
            break;
          }
          case "media_control": {
            // Phone-initiated transport action (notification button / BT headset).
            // Mirror the REST /api/meta-glasses/media/control behavior so server
            // state stays in sync. DO NOT echo media_control back — phone already acted.
            const mcAction = msg.action;
            if (mcAction === "stop") {
              clearAudioQueue(device.id);
              _devicePlaybackState.set(device.id, "idle");
              _nowPlaying.delete(device.id);
              emitGlassesMediaState(device.id);
            } else if (mcAction === "pause") {
              _devicePlaybackState.set(device.id, "paused");
              emitGlassesMediaState(device.id);
            } else if (mcAction === "resume") {
              _devicePlaybackState.set(device.id, "playing");
              emitGlassesMediaState(device.id);
            } else if (mcAction === "next") {
              const w2 = _streamDoneWaiters.get(device.id);
              if (w2) {
                clearTimeout(w2.timer);
                _streamDoneWaiters.delete(device.id);
                const absorb = setTimeout(() => _streamDoneWaiters.delete(device.id), 2000);
                _streamDoneWaiters.set(device.id, {
                  resolve: () => { clearTimeout(absorb); _streamDoneWaiters.delete(device.id); },
                  reject:  () => { clearTimeout(absorb); _streamDoneWaiters.delete(device.id); },
                  timer: absorb,
                });
                w2.resolve();
              }
            }
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
        clearAudioQueue(deviceId);
        _devicePlaybackState.delete(deviceId);
        _nowPlaying.delete(deviceId);
        emitGlassesMediaState(deviceId);
        releaseTurnLock(deviceId, ws);
      });
      ws.on("error", () => { /* close follows */ });
    });
  });

  return { openSessionCount: () => _sessions.size };
}

/* ---------- Phase 5: photo library insert + caption + OCR ---------- */

// Per-device daily OCR cap. Guards against unbounded vision spend on a
// device that captures continuously. At 200 OCRs/device/day, even a
// 3-device household stays under ~600 vision calls/day. Exceeding the
// cap silently skips OCR for the remainder of the day; the caption
// pipeline still runs. Tuned conservatively; raise if real usage
// warrants it. There's a known micro-race: two concurrent captures at
// count 199 can both pass the check and produce 201 writes. Acceptable
// slop — the cap is a budget guard, not a billing-strict limit.
const OCR_DAILY_CAP_PER_DEVICE = 200;

// PII redaction patterns applied to OCR text before it lands in the
// FTS index. Best-effort by design: the settings disclaimer makes
// clear we can't redact names, addresses, account numbers, or any
// format that doesn't match one of these four. The CC regex is Luhn-
// loose — it false-positives on long digit runs (timestamps, CSV
// numeric columns) which is the safe direction for privacy but a
// minor search-quality cost.
const PII_PATTERNS = [
  /\b\d{3}-\d{2}-\d{4}\b/g,                                   // SSN
  /\b(?:\d[ -]*?){13,19}\b/g,                                 // CC (Luhn-loose)
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,      // email
  /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, // US phone
];

function redactPII(text) {
  let t = text;
  for (const re of PII_PATTERNS) t = t.replace(re, "[REDACTED]");
  return t;
}

// Vision models don't reliably honor the literal "." sentinel prompt —
// they emit "No text.", "There is no text in this image.", "I can't
// read this.", etc. Anything under 3 characters (just "." or stray
// whitespace) or matching one of the common no-text/refusal phrases is
// treated as empty. Downside of a false-empty is a missing search
// hit; downside of a false-positive-text is searchable garbage, so we
// err toward dropping.
const EMPTY_OCR_PATTERNS = [
  /^[\s.,\-–—]*$/,                                        // whitespace/punct only
  /^\s*(no[\s_-]?text|none|empty|n\/a)\s*\.?\s*$/i,
  /^\s*there\s+is\s+no\s+text/i,
  /^\s*the\s+image\s+(contains|has)\s+no\s+(legible\s+)?text/i,
  /^\s*i\s+(can'?t|cannot|am\s+unable)/i,                 // refusals
  /^\s*i'?m\s+(sorry|unable)/i,
];

function cleanOcrResponse(raw) {
  const t = (raw || "").trim();
  if (t.length < 3) return "";
  for (const re of EMPTY_OCR_PATTERNS) if (re.test(t)) return "";
  return t;
}

async function recordGlassesPhoto({ deviceId, diskPath, fname, mime, size }) {
  const { createDbClient } = await loadDb();
  const { readFileSync } = await import("node:fs");

  // 1. Best-effort MinIO upload BEFORE the DB insert. If MinIO isn't
  //    configured, we fall straight through to disk-only. If upload
  //    throws, we log and keep disk as the authoritative source. The
  //    resulting `minioKey` is either a real key or null; the INSERT
  //    records both.
  let minioKey = null;
  try {
    const { isAvailable, uploadObject } = await loadS3();
    if (await isAvailable()) {
      const ext = (mime?.split("/")[1] || "jpg").split("+")[0];
      const candidate = `meta-glasses/${deviceId}/${Date.now()}-${randomUUID()}.${ext}`;
      try {
        await uploadObject(candidate, readFileSync(diskPath), { contentType: mime });
        minioKey = candidate;
      } catch (err) {
        console.warn(`[meta-glasses] MinIO upload failed for photo (device=${deviceId}); keeping disk copy only: ${err.message}`);
        minioKey = null;
      }
    }
  } catch (err) {
    // loadS3 itself failed (module missing, etc) — stay on disk path.
    console.warn(`[meta-glasses] S3 client unavailable: ${err.message}`);
  }

  // 2. DB insert. If this fails after a successful MinIO upload, the
  //    MinIO object would be orphaned — compensate by deleting it.
  //    (minio-js removeObject is idempotent on 404.)
  const db = createDbClient();
  let photoId;
  try {
    const ins = await db.execute({
      sql: `INSERT INTO glasses_photos (device_id, disk_path, minio_key, mime, size_bytes)
            VALUES (?, ?, ?, ?, ?)`,
      args: [deviceId, diskPath, minioKey, mime, size],
    });
    photoId = Number(ins.lastInsertRowid);
  } catch (err) {
    if (minioKey) {
      try {
        const { deleteObject } = await loadS3();
        await deleteObject(minioKey);
      } catch {}
    }
    throw err;
  } finally {
    try { db.close(); } catch {}
  }
  if (!photoId) return null;
  // NOTE: the disk file at `diskPath` is intentionally NOT unlinked in
  // this session. A future retention cron (Phase 5 B.4) prunes disk
  // copies once MinIO has served them successfully or after a grace
  // period. Keeps the system recoverable if MinIO is briefly down.

  // Phase 6 C.2: fire-and-forget the enrichment pipeline so the caller
  // gets photoId back synchronously. The capture-and-attach tool needs
  // the id immediately to write a `photo://<id>` markdown ref; waiting
  // for the 5-30s vision call would time out the MCP tool.
  _enrichGlassesPhoto({ photoId, deviceId, diskPath, mime }).catch(err =>
    console.warn(`[meta-glasses] enrich pipeline error for photo ${photoId}: ${err.message}`)
  );
  return { photoId, minioKey };
}

async function _enrichGlassesPhoto({ photoId, deviceId, diskPath, mime }) {
  const { createDbClient } = await loadDb();
  // Fire-and-forget: resolve the default vision profile (no device/AI profile
  // plumbing here — library captions use the platform default). Skip silently
  // if no vision profile is set.
  try {
    const { readSetting } = await loadSettingsReg();
    const db2 = createDbClient();
    try {
      const raw = await readSetting(db2, "vision_profiles");
      if (!raw) return;
      let profiles = [];
      try { profiles = JSON.parse(raw); } catch { return; }
      const profile = profiles.find(p => p.isDefault) || profiles[0];
      if (!profile) return;
      let providerConfig;
      if (profile.provider_id) {
        const { resolveProvider } = await loadResolveProv();
        providerConfig = await resolveProvider(profile.provider_id, profile.model_id);
      } else if (profile.baseUrl && profile.model) {
        providerConfig = { baseUrl: profile.baseUrl, apiKey: profile.apiKey || "none", model: profile.model };
      } else { return; }

      const { analyzeImage } = await loadVision();
      const { readFileSync } = await import("node:fs");
      const imageBytes = readFileSync(diskPath);
      const { description } = await analyzeImage({
        providerConfig,
        prompt: "Briefly describe what's in this image (1 sentence). This is a searchable library caption.",
        imageBytes,
        mime,
        timeoutMs: 30_000,
        maxTokens: 100,
      });
      await db2.execute({
        sql: `UPDATE glasses_photos SET caption = ? WHERE id = ?`,
        args: [description || null, photoId],
      });

      // Phase 5 B.2: opt-in OCR with per-device daily cap + PII redaction.
      // Off by default. Enabling runs a SECOND analyzeImage call with an
      // OCR prompt; the response passes through cleanOcrResponse (to
      // reject model hallucinations / refusals / empty sentinels) and
      // then through redactPII (a small regex set) before it's written
      // to the FTS-indexed ocr_text column.
      try {
        const { findDevice } = await loadDeviceStore();
        const device = await findDevice(db2, deviceId);
        if (device?.ocr_enabled) {
          const today = new Date().toISOString().slice(0, 10);
          const { rows: cap } = await db2.execute({
            sql: `SELECT COUNT(*) AS n FROM glasses_photos
                  WHERE device_id = ? AND DATE(captured_at) = ? AND ocr_text IS NOT NULL`,
            args: [deviceId, today],
          });
          const used = Number(cap?.[0]?.n ?? 0);
          if (used < OCR_DAILY_CAP_PER_DEVICE) {
            const { description: rawOcr } = await analyzeImage({
              providerConfig,
              prompt: "Extract all legible text from this image verbatim, line by line. If no legible text is present, respond with a single period character '.'",
              imageBytes,
              mime,
              timeoutMs: 30_000,
              maxTokens: 500,
            });
            const cleaned = cleanOcrResponse(rawOcr);
            if (cleaned) {
              const redacted = redactPII(cleaned);
              await db2.execute({
                sql: `UPDATE glasses_photos SET ocr_text = ? WHERE id = ?`,
                args: [redacted, photoId],
              });
            }
          } else {
            console.log(`[meta-glasses] OCR daily cap reached for device=${deviceId} (${used}/${OCR_DAILY_CAP_PER_DEVICE}); skipping photo ${photoId}`);
          }
        }
      } catch (err) {
        console.warn(`[meta-glasses] OCR pipeline error for photo ${photoId}: ${err.message}`);
      }
    } finally {
      try { db2.close(); } catch {}
    }
  } catch (err) {
    console.warn(`[meta-glasses] caption pipeline error for photo ${photoId}: ${err.message}`);
  }
}

/**
 * Search the glasses photo library by caption/OCR.
 * Returns [{ id, url, caption, ocr_text, captured_at }, ...].
 *
 * URLs resolve in the following order: if `minio_key` is present AND
 * MinIO is available, a per-row presigned GET is minted with a 1-hour
 * TTL. Otherwise we fall back to the legacy disk-backed
 * /api/meta-glasses/photo/:name route. Presigned-URL minting is async,
 * so the map is wrapped in Promise.all — bare .map(async r => ...)
 * would hand back an array of unresolved Promises.
 */
export async function searchGlassesPhotos(query, { limit = 10 } = {}) {
  const { createDbClient, sanitizeFtsQuery } = await loadDb();
  const db = createDbClient();
  try {
    const q = sanitizeFtsQuery ? sanitizeFtsQuery(query || "") : (query || "").replace(/['"]/g, " ");
    if (!q.trim()) return [];
    const { rows } = await db.execute({
      sql: `SELECT g.id, g.disk_path, g.minio_key, g.caption, g.ocr_text, g.captured_at
            FROM glasses_photos g JOIN glasses_photos_fts f ON g.id = f.rowid
            WHERE glasses_photos_fts MATCH ?
            ORDER BY g.captured_at DESC LIMIT ?`,
      args: [q, limit],
    });
    let s3Ready = false;
    let getPresignedUrl = null;
    try {
      const s3 = await loadS3();
      s3Ready = await s3.isAvailable();
      getPresignedUrl = s3.getPresignedUrl;
    } catch {}
    return Promise.all(rows.map(async (r) => {
      let url;
      if (s3Ready && r.minio_key && getPresignedUrl) {
        try {
          url = await getPresignedUrl(r.minio_key, { expiry: 3600 });
        } catch {
          url = `/api/meta-glasses/photo/${encodeURIComponent(String(r.disk_path || "").split("/").pop())}`;
        }
      } else {
        url = `/api/meta-glasses/photo/${encodeURIComponent(String(r.disk_path || "").split("/").pop())}`;
      }
      return {
        id: r.id,
        url,
        caption: r.caption,
        ocr_text: r.ocr_text,
        captured_at: r.captured_at,
      };
    }));
  } finally {
    try { db.close(); } catch {}
  }
}

/* ---------- Phase 5 B.4: photo retention cron + disk backfill ----------
 *
 * Three helpers + one public entry point:
 *   - backfillGlassesPhoto(db, row)          — migrate one disk-only row into MinIO
 *   - reclaimBackfilledDiskCopies(db)        — unlink disk copies past the grace window
 *   - pruneGlassesPhotos(db)                 — per-device retention + orphan sweep
 *   - runPhotoRetention(db, { budgetMs })    — exported, called by scheduler/admin
 *
 * Disk-only rows are NEVER pruned — doing so during a MinIO outage is
 * unrecoverable data loss. Orphan sweep TTL is measured from the unpair
 * timestamp recorded in `dashboard_settings` (keyed
 * `meta_glasses_device_unpaired.<device_id>` by unpairDevice).
 */

async function backfillGlassesPhoto(db, row) {
  const { isAvailable, uploadObject, deleteObject } = await loadS3();
  if (!(await isAvailable())) return { skipped: "no-storage" };
  const { existsSync, readFileSync } = await import("node:fs");
  if (!row.disk_path || !existsSync(row.disk_path)) {
    return { skipped: "disk-missing" };
  }
  const ext = (row.mime?.split("/")[1] || "jpg").split("+")[0];
  const key = `meta-glasses/${row.device_id}/backfill-${row.id}-${Date.now()}.${ext}`;
  try {
    await uploadObject(key, readFileSync(row.disk_path), { contentType: row.mime });
    const upd = await db.execute({
      sql: `UPDATE glasses_photos SET minio_key = ? WHERE id = ? AND minio_key IS NULL`,
      args: [key, row.id],
    });
    if (Number(upd.rowsAffected || 0) === 0) {
      // Lost a race — the row was updated/deleted between SELECT and UPDATE.
      // Remove the orphan we just uploaded (idempotent on 404).
      try { await deleteObject(key); } catch {}
      return { skipped: "already-migrated" };
    }
    return { migrated: key };
  } catch (err) {
    try { await deleteObject(key); } catch {}
    return { failed: err.message };
  }
}

async function reclaimBackfilledDiskCopies(db) {
  const { unlinkSync } = await import("node:fs");
  const DISK_GRACE_DAYS = 7;
  const { rows } = await db.execute({
    sql: `SELECT id, disk_path FROM glasses_photos
          WHERE minio_key IS NOT NULL AND disk_path IS NOT NULL
            AND captured_at < datetime('now', ?)`,
    args: [`-${DISK_GRACE_DAYS} days`],
  });
  let reclaimed = 0;
  for (const row of rows) {
    if (row.disk_path) { try { unlinkSync(row.disk_path); } catch {} }
    await db.execute({
      sql: `UPDATE glasses_photos SET disk_path = NULL WHERE id = ?`,
      args: [row.id],
    });
    reclaimed++;
  }
  return { reclaimed };
}

async function pruneGlassesPhotos(db) {
  const { listDevices } = await loadDeviceStore();
  const { deleteObject } = await loadS3();
  const { unlinkSync } = await import("node:fs");
  const devices = await listDevices(db);
  const activeIds = new Set(devices.map(d => d.id));
  let prunedTotal = 0;

  // Per-device retention prune (MinIO-backed rows only — disk-only
  // rows are preserved indefinitely until backfilled).
  for (const d of devices) {
    const retention = d.photo_retention || "never";
    if (retention === "never") continue;
    const days = retention === "30d" ? 30 : retention === "1y" ? 365 : 0;
    if (!days) continue;
    const { rows } = await db.execute({
      sql: `SELECT id, minio_key, disk_path FROM glasses_photos
            WHERE device_id = ? AND captured_at < datetime('now', ?)
              AND minio_key IS NOT NULL`,
      args: [d.id, `-${days} days`],
    });
    for (const row of rows) {
      try { await deleteObject(row.minio_key); } catch {}
      if (row.disk_path) { try { unlinkSync(row.disk_path); } catch {} }
      await db.execute({ sql: `DELETE FROM glasses_photos WHERE id = ?`, args: [row.id] });
      prunedTotal++;
    }
  }

  // Orphan sweep. TTL measured from unpair time, not captured_at.
  const ORPHAN_GRACE_DAYS = 7;
  const { rows: unpairRows } = await db.execute({
    sql: `SELECT key, value FROM dashboard_settings
          WHERE key LIKE 'meta_glasses_device_unpaired.%'`,
    args: [],
  });
  for (const urow of unpairRows) {
    const unpairedDeviceId = String(urow.key).replace(/^meta_glasses_device_unpaired\./, "");
    if (activeIds.has(unpairedDeviceId)) {
      // Re-paired — clear the marker. (pairDevice also clears it; this is
      // a belt-and-suspenders cleanup for markers that pre-dated the
      // pair-side delete.)
      await db.execute({
        sql: `DELETE FROM dashboard_settings WHERE key = ?`,
        args: [urow.key],
      });
      continue;
    }
    const unpairedAt = new Date(urow.value).getTime();
    if (Number.isNaN(unpairedAt)) continue;
    const ageDays = (Date.now() - unpairedAt) / 86_400_000;
    if (ageDays < ORPHAN_GRACE_DAYS) continue;
    const { rows: orphanRows } = await db.execute({
      sql: `SELECT id, minio_key, disk_path FROM glasses_photos
            WHERE device_id = ? AND minio_key IS NOT NULL`,
      args: [unpairedDeviceId],
    });
    for (const row of orphanRows) {
      try { await deleteObject(row.minio_key); } catch {}
      if (row.disk_path) { try { unlinkSync(row.disk_path); } catch {} }
      await db.execute({ sql: `DELETE FROM glasses_photos WHERE id = ?`, args: [row.id] });
      prunedTotal++;
    }
    const { rows: rem } = await db.execute({
      sql: `SELECT COUNT(*) AS n FROM glasses_photos WHERE device_id = ?`,
      args: [unpairedDeviceId],
    });
    if (Number(rem?.[0]?.n ?? 0) === 0) {
      await db.execute({
        sql: `DELETE FROM dashboard_settings WHERE key = ?`,
        args: [urow.key],
      });
    }
  }

  return { prunedTotal };
}

export async function runPhotoRetention(db, { budgetMs = 60_000 } = {}) {
  const started = Date.now();
  const summary = { backfilled: 0, backfill_skipped: 0, backfill_failed: 0, reclaimed: 0, pruned: 0 };
  const BATCH_SIZE = 50;
  // 1. Backfill disk-only rows in batches until queue drains OR budget exhausts.
  // Pre-flight: skip the entire backfill loop if MinIO is unavailable.
  // Without this guard the SELECT keeps re-finding the same skipped rows
  // forever, burning the time budget on no-ops.
  let s3Ready = false;
  try {
    const { isAvailable } = await loadS3();
    s3Ready = await isAvailable();
  } catch {}
  if (!s3Ready) {
    summary.backfill_skipped_no_storage = true;
  } else {
    // Track IDs that returned a non-fatal skip (e.g. disk-missing ghost
    // rows) so the next SELECT doesn't re-fetch them and stall the loop.
    const skippedIds = new Set();
    while (Date.now() - started < budgetMs) {
      const placeholders = skippedIds.size > 0 ? `AND id NOT IN (${[...skippedIds].map(() => "?").join(",")})` : "";
      const { rows: pending } = await db.execute({
        sql: `SELECT id, device_id, disk_path, mime FROM glasses_photos
              WHERE minio_key IS NULL AND disk_path IS NOT NULL ${placeholders} LIMIT ?`,
        args: [...skippedIds, BATCH_SIZE],
      });
      if (pending.length === 0) break;
      for (const row of pending) {
        try {
          const r = await backfillGlassesPhoto(db, row);
          if (r.migrated) summary.backfilled++;
          else if (r.failed) { summary.backfill_failed++; skippedIds.add(row.id); }
          else { summary.backfill_skipped++; skippedIds.add(row.id); }
        } catch {
          summary.backfill_failed++;
          skippedIds.add(row.id);
        }
      }
    }
  }
  // 2. Reclaim disk copies past the grace window.
  try {
    const r = await reclaimBackfilledDiskCopies(db);
    summary.reclaimed = r.reclaimed || 0;
  } catch (err) {
    console.warn(`[meta-glasses] reclaim failed: ${err.message}`);
  }
  // 3. Prune per-device retention + orphan sweep.
  try {
    const r = await pruneGlassesPhotos(db);
    summary.pruned = r.prunedTotal || 0;
  } catch (err) {
    console.warn(`[meta-glasses] prune failed: ${err.message}`);
  }
  // 4. Phase 6 C.2: caption backfill. Piggybacks on the daily run; the
  //    scheduler also calls runCaptionBackfill directly every tick so
  //    fill-in lag is typically seconds, not hours.
  try {
    const r = await runCaptionBackfill(db);
    summary.caption_replaced = r.replaced || 0;
    summary.caption_dropped = r.dropped || 0;
  } catch (err) {
    console.warn(`[meta-glasses] caption backfill failed: ${err.message}`);
  }
  summary.elapsed_ms = Date.now() - started;
  return summary;
}

/* ---------- Phase 4: audio_stream proxy (Android MediaCodec pending) ----------
 *
 * Outbound WebSocket protocol, already ratified in this bundle:
 *   server → client text:   { type: "audio_stream_start", codec: "mp3"|"ogg"|"aac",
 *                             sample_rate, channels, content_length? }
 *   server → client binary: compressed audio bytes for the duration of the stream
 *   server → client text:   { type: "audio_stream_end", ok: true|false, error? }
 *
 * Tool-result shape for producers (funkwhale, podcast bundles, etc.):
 *   { _audio_stream: { url, codec, sample_rate?, channels? } }
 *   — the voice-turn loop proxies the URL to the device and never surfaces
 *   the tool result to the LLM as text.
 *
 * pushAudioStream below implements the server side. The Android client must
 * add a MediaCodec decoder + separate AudioTrack (Phase 4 Android PR). Until
 * that APK lands, this helper is callable but ineffective on phone.
 *
 * Backpressure: chunked at 64KB with WebSocket drain awaits, total in-flight
 * bounded at 1MB (bufferedAmount check).
 */
// Maps `auth: "<sentinel>"` from _audio_stream envelopes to the server-side
// env-var bearer token to inject. Keeps credentials out of tool results and
// chat history — only the sentinel string travels through the LLM layer.
const AUDIO_STREAM_AUTH_SENTINELS = {
  funkwhale: () => process.env.FUNKWHALE_ACCESS_TOKEN || null,
};

export async function pushAudioStream(deviceId, { url, codec, sampleRate, channels, auth, title, artist, artworkUrl } = {}) {
  if (!deviceId || !url || !codec) return { delivered: false, reason: "bad_args" };
  const sess = _sessions.get(deviceId);
  if (!sess?.ws) return { delivered: false, reason: "absent" };
  // Detect whether we'd be acquiring a fresh lock or reusing one already held
  // by the same ws (the case when this is called from inside a voice-turn
  // intercepting an `_audio_stream` envelope). If we acquired fresh, we must
  // release in finally; if we reused, the outer turn handler still owns it.
  const lockReentrant = _turnLocks.get(deviceId)?.ws === sess.ws;
  if (!acquireTurnLock(deviceId, sess.ws)) return { delivered: false, reason: "lock_busy" };
  try {
    const headers = {};
    if (auth && AUDIO_STREAM_AUTH_SENTINELS[auth]) {
      const token = AUDIO_STREAM_AUTH_SENTINELS[auth]();
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    // Manual redirect handling to avoid leaking the bearer to signed storage
    // URLs or attacker-controlled hosts. Validate the Location host on any 3xx,
    // then drop the bearer and auto-follow the rest of the chain.
    let resp = await fetch(url, { redirect: "manual", headers });
    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get("location");
      if (!location) {
        sendText(sess.ws, { type: "audio_stream_end", ok: false, error: "redirect_no_location" });
        return { delivered: false, reason: "redirect_no_location" };
      }
      // For funkwhale, validate the Location host. Signed storage URLs commonly
      // go cross-host (e.g. to S3/minio) — that's fine as long as the first hop
      // matches an allow-listed host. After this hop, drop the bearer; signed
      // URLs carry their own auth in query params.
      try {
        const locUrl = new URL(location, url);
        if (auth === "funkwhale" && process.env.FUNKWHALE_URL) {
          const fwHost = new URL(process.env.FUNKWHALE_URL).hostname;
          const origHost = new URL(url).hostname;
          // Accept: same host as the original (internal redirect) OR a
          // storage URL that funkwhale itself issued (location can point
          // anywhere — funkwhale's S3 backend, etc.). The trust anchor is
          // that the ORIGINAL url was funkwhale-hosted (validated upstream).
          // We trust funkwhale's redirect target since we trust the server.
          // We just ensure we're not following a redirect on a non-fw origin.
          if (origHost !== fwHost) {
            sendText(sess.ws, { type: "audio_stream_end", ok: false, error: "redirect_unexpected_origin" });
            return { delivered: false, reason: "redirect_unexpected_origin" };
          }
        }
        // Re-fetch without the bearer — signed storage URLs have their own auth.
        resp = await fetch(locUrl.toString(), { redirect: "follow" });
      } catch (err) {
        sendText(sess.ws, { type: "audio_stream_end", ok: false, error: "redirect_invalid_url" });
        return { delivered: false, reason: "redirect_invalid_url" };
      }
    }
    if (!resp.ok || !resp.body) {
      sendText(sess.ws, { type: "audio_stream_end", ok: false, error: `HTTP ${resp.status}` });
      return { delivered: false, reason: `http_${resp.status}` };
    }
    // Record listen in Funkwhale history (fire-and-forget, only after upstream ok).
    // NOTE: `url` is the ORIGINAL request URL — DO NOT replace with resp.url
    // (signed storage URLs won't match the /listen/<uuid>/ regex).
    // Funkwhale's history endpoint needs the integer track PK, not the UUID —
    // resolve via GET /api/v1/tracks/{uuid}/ first.
    if (auth === "funkwhale") {
      try {
        const trackUuid = url.match(/\/listen\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\//i)?.[1];
        const fwBase = process.env.FUNKWHALE_URL?.replace(/\/$/, "");
        const fwToken = process.env.FUNKWHALE_ACCESS_TOKEN;
        if (trackUuid && fwBase && fwToken) {
          fetch(`${fwBase}/api/v1/tracks/${encodeURIComponent(trackUuid)}/`, {
            headers: { Authorization: `Bearer ${fwToken}` },
          })
            .then((r) => r.ok ? r.json() : null)
            .then((meta) => {
              if (!meta?.id) return;
              return fetch(`${fwBase}/api/v1/history/listenings/`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "Authorization": `Bearer ${fwToken}`,
                },
                body: JSON.stringify({ track: meta.id }),
              });
            })
            .catch((err) => console.warn(`[meta-glasses] record listen failed: ${err.message}`));
        }
      } catch (err) {
        console.warn(`[meta-glasses] listen-record prep failed: ${err.message}`);
      }
    }
    const contentLength = Number(resp.headers.get("content-length")) || undefined;
    // Resolve title/artist/artwork_url: explicit args win, fall back to _nowPlaying
    // (set by the envelope interceptor for the head-of-album track).
    const np = _nowPlaying.get(deviceId) || {};
    sendText(sess.ws, {
      type: "audio_stream_start",
      codec, sample_rate: sampleRate || null, channels: channels || null,
      content_length: contentLength,
      title:  title  ?? np.title  ?? null,
      artist: artist ?? np.artist ?? null,
      artwork_url: artworkUrl ?? np.artworkUrl ?? null,
    });
    const reader = resp.body.getReader();
    while (true) {
      // Backpressure: 1MB cap
      if (sess.ws.bufferedAmount > 1_000_000) {
        await new Promise(r => setTimeout(r, 50));
        continue;
      }
      const { value, done } = await reader.read();
      if (done) break;
      sendBinary(sess.ws, Buffer.from(value));
    }
    // If there's a next track queued, register the done-waiter BEFORE sending
    // audio_stream_end so we don't race with the phone's ack.
    const next = popAudioQueue(deviceId);
    if (next) {
      const donePromise = waitForStreamDone(deviceId);
      sendText(sess.ws, { type: "audio_stream_end", ok: true });
      // Release the lock while the phone plays. This lets voice turns
      // ("stop", "skip", questions) run in the inter-track gap.
      if (!lockReentrant) releaseTurnLock(deviceId, sess.ws);
      try {
        await donePromise;
      } catch (err) {
        console.warn(`[meta-glasses] queue chain for ${deviceId}: ${err.message}`);
        clearAudioQueue(deviceId);
        return { delivered: true, queueAborted: true };
      }
      // Re-acquire for next track. If a voice turn is in progress, spin
      // until it completes. Queue check on each spin prevents spinning
      // forever if fw_stop_playback was called.
      while (!acquireTurnLock(deviceId, sess.ws)) {
        await new Promise(r => setTimeout(r, 200));
        if (!sess.ws || sess.ws.readyState !== 1) return { delivered: true, queueAborted: true };
      }
      // Update _nowPlaying for the next queue item so audio_stream_start gets
      // per-track metadata (album artwork usually stays the same across an album).
      if (next.title || next.artist || next.artworkUrl) {
        const prev = _nowPlaying.get(deviceId) || {};
        _nowPlaying.set(deviceId, {
          title: next.title || null,
          artist: next.artist || prev.artist || null,
          artworkUrl: next.artworkUrl || prev.artworkUrl || null,
          queueLength: Math.max((prev.queueLength || 1) - 1, 1),
        });
        emitGlassesMediaState(deviceId);
      }
      return await pushAudioStream(deviceId, next);
    }
    sendText(sess.ws, { type: "audio_stream_end", ok: true });
    return { delivered: true };
  } catch (err) {
    sendText(sess.ws, { type: "audio_stream_end", ok: false, error: err.message });
    clearAudioQueue(deviceId); // an error mid-album halts the rest
    return { delivered: false, reason: err.message };
  } finally {
    // Only release the lock if WE acquired it. When reentrant (parent voice
    // turn already owns it), the outer handler is responsible for releasing.
    if (!lockReentrant) releaseTurnLock(deviceId, sess.ws);
  }
}

/**
 * Per-device server-side audio queue. Used by fw_play_album (and any future
 * "playlist"-style envelope) to play multiple tracks back-to-back without
 * needing a phone-side queue or each track being a separate AI tool call.
 *
 * Each entry is the same shape pushAudioStream takes: {url, codec, auth?, ...}.
 */
const _audioQueues = new Map(); // deviceId → array of stream descriptors
const _streamDoneWaiters = new Map(); // deviceId → { resolve, reject, timer }
const _devicePlaybackState = new Map(); // deviceId → "idle" | "playing" | "paused"
const _nowPlaying = new Map(); // deviceId → { title, artist, queueLength }

function sendMediaControl(deviceId, action) {
  const sess = _sessions.get(deviceId);
  if (!sess?.ws) return false;
  sendText(sess.ws, { type: "media_control", action });
  return true;
}

function setAudioQueue(deviceId, queue) {
  if (Array.isArray(queue) && queue.length > 0) {
    _audioQueues.set(deviceId, [...queue]);
  } else {
    _audioQueues.delete(deviceId);
  }
}
function popAudioQueue(deviceId) {
  const q = _audioQueues.get(deviceId);
  if (!q || q.length === 0) return null;
  const next = q.shift();
  if (q.length === 0) _audioQueues.delete(deviceId);
  return next;
}
function clearAudioQueue(deviceId) {
  _audioQueues.delete(deviceId);
  const w = _streamDoneWaiters.get(deviceId);
  if (w) {
    clearTimeout(w.timer);
    _streamDoneWaiters.delete(deviceId);
    w.reject(new Error("queue cleared"));
  }
}

function waitForStreamDone(deviceId, timeoutMs = 15 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      _streamDoneWaiters.delete(deviceId);
      reject(new Error("audio_stream_done timeout"));
    }, timeoutMs);
    _streamDoneWaiters.set(deviceId, { resolve, reject, timer });
  });
}

/* ---------- Server-initiated TTS (Phase 3) ---------- */

const DEVICE_PRESENCE_MS = 60_000;
const MUTEX_DEFER_MS = 30_000;

function deviceIsPresent(deviceId) {
  const s = _sessions.get(deviceId);
  if (!s) return false;
  if (!s.lastPingAt) return (Date.now() - (s.openedAt || 0)) < DEVICE_PRESENCE_MS;
  return (Date.now() - s.lastPingAt) < DEVICE_PRESENCE_MS;
}

export function isQuietHours(quietHoursStr, date = new Date()) {
  // "HH:MM-HH:MM" in local time. Wrap-around supported.
  if (!quietHoursStr || !/^\d{2}:\d{2}-\d{2}:\d{2}$/.test(quietHoursStr)) return false;
  const [start, end] = quietHoursStr.split("-");
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  const mins = date.getHours() * 60 + date.getMinutes();
  const sMins = sh * 60 + sm, eMins = eh * 60 + em;
  return sMins <= eMins
    ? (mins >= sMins && mins < eMins)
    : (mins >= sMins || mins < eMins);
}

/**
 * Deliver `text` to device `deviceId` as TTS, subject to policy.
 * Policy is enforced by the caller (scheduler) or opt-in here via opts.
 *
 * Returns { delivered: boolean, reason?: string }.
 */
export async function pushTtsToDevice(deviceId, text, opts = {}) {
  if (!deviceId || !text) return { delivered: false, reason: "bad_args" };
  if (!deviceIsPresent(deviceId)) return { delivered: false, reason: "absent" };

  // Wait for the turn mutex if briefly held.
  const started = Date.now();
  while (_turnLocks.has(deviceId)) {
    if (Date.now() - started > MUTEX_DEFER_MS) {
      return { delivered: false, reason: "mutex_timeout" };
    }
    await new Promise(r => setTimeout(r, 500));
    if (!deviceIsPresent(deviceId)) return { delivered: false, reason: "absent" };
  }
  // Acquire the lock so no voice turn starts mid-push.
  const sess = _sessions.get(deviceId);
  if (!sess?.ws) return { delivered: false, reason: "absent" };
  if (!acquireTurnLock(deviceId, sess.ws)) {
    return { delivered: false, reason: "lock_busy" };
  }
  try {
    const db = (await loadDb()).createDbClient();
    try {
      const { getTtsProfiles, createTtsAdapter, getDefaultTtsProfile } = await loadTts();
      const ttsProfile = sess.device?.tts_profile_id
        ? (await getTtsProfiles(db, { includeKeys: true })).find(p => p.id === sess.device.tts_profile_id)
        : await getDefaultTtsProfile(db, { includeKeys: true });
      if (!ttsProfile) return { delivered: false, reason: "no_tts_profile" };
      const { adapter: ttsAdapter } = await createTtsAdapter(ttsProfile);
      const neg = negotiatePcm(ttsAdapter.name);
      if (neg) sendText(sess.ws, { type: "tts_start", codec: neg.codec, sample_rate: neg.sampleRate });
      else sendText(sess.ws, { type: "tts_start", codec: "mp3", sample_rate: 24000 });
      const stream = neg
        ? pcmStream(ttsAdapter, text, ttsProfile.defaultVoice, neg)
        : ttsAdapter.synthesize(text, ttsProfile.defaultVoice, {});
      for await (const chunk of stream) sendBinary(sess.ws, chunk);
      sendText(sess.ws, { type: "tts_end" });
      return { delivered: true };
    } finally {
      try { db.close(); } catch {}
    }
  } catch (err) {
    return { delivered: false, reason: err.message };
  } finally {
    releaseTurnLock(deviceId, sess.ws);
  }
}
