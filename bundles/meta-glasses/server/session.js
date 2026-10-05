/**
 * The glasses session's side of a voice turn. The turn itself is the gateway's shared one
 * (servers/gateway/voice/turn.js): speech-to-text, the bound assistant, the prompt-fit check,
 * the tool loop with its caps, sentence-by-sentence speech. This module supplies what is
 * particular to glasses and to the phone app that carries them:
 *
 *  - ONE speech envelope per turn. The app plays nothing until it has seen tts_end, and a
 *    second envelope cuts the first one off, so everything a turn says (answer, fallback line,
 *    failure line) goes out between a single tts_start and a single tts_end, always closed.
 *  - Never silent. A turn that produced no speech ends on a fixed spoken line.
 *  - A voice this app can play. The app plays raw PCM only; a profile that cannot give PCM is
 *    replaced by a local one that can, or the turn says nothing can be spoken (an error event).
 *  - A bound assistant is required. With none, the session says so and stops.
 *  - The camera as a turn tool: offered ALONE on a turn that asks for it, must run, and what it
 *    saw never stays in the saved conversation.
 *  - Audio envelopes: obeyed only from the music add-on's tools (./envelope.js); the stream is
 *    handed back to the caller, who starts it after the turn's speech has been sent.
 *
 * Every gateway dependency is injected. The only app code it reads is the kiosk's pure phrase
 * helpers (memory intent, clock table, [Now] line), through ./voice-shared.js.
 */
import { stringsFor } from "./strings.js";
import { wantsLook, wantsMemory, matchTransport } from "./intent.js";
import { matchClockFastPath, nowContext } from "./voice-shared.js";

/** Never on a glasses turn: work handed to other bots, schedules, schema discovery, and the note and library tools (their text is not for a voice turn's tool loop). */
export const GLASSES_DENY_TOOLS = Object.freeze([
  "crow_delegate", "crow_job_status", "crow_schedule_bot", "crow_list_bot_schedules", "crow_delete_bot_schedule", "crow_discover",
  "crow_glasses_start_note_session", "crow_glasses_add_to_note", "crow_glasses_end_note_session",
  "crow_glasses_undo_last_append", "crow_glasses_confirm_action_items", "crow_glasses_search_photos",
]);
export const GLASSES_MAX_TOOL_ROUNDS = 3;
export const GLASSES_FIRST_AUDIO_BUDGET_MS = 12_000;
/** A look turn waits for the phone to take and upload a frame, then for a description. */
export const GLASSES_LOOK_BUDGET_MS = 45_000;
export const LOOK_TOOL = "crow_glasses_capture_photo";
/** TTS providers whose adapters can return raw PCM (servers/gateway/voice/turn-helpers.js negotiatePcm). */
export const PCM_TTS_PROVIDERS = Object.freeze(["kokoro", "piper", "openai", "elevenlabs"]);
export const RECENT_TURNS = 20;

/** The TTS profile id this client can play: the device's or the default when it gives PCM, else a local one that does. → id | null (the default is fine) | false (nothing playable). */
export function playableTtsProfile(device, profiles) {
  const list = Array.isArray(profiles) ? profiles : [];
  const playable = (p) => !!p && PCM_TTS_PROVIDERS.includes(p.provider);
  const own = device?.tts_profile_id ? list.find((p) => p.id === device.tts_profile_id) : null;
  if (playable(own)) return own.id;
  if (!own && playable(list.find((p) => p.isDefault))) return null;
  const local = list.find((p) => p.provider === "kokoro") || list.find((p) => p.provider === "piper") || list.find(playable);
  return local ? local.id : false;
}

/** One speech envelope over a transport: duplicate starts are dropped, the end is sent once by close(). Remembers the last error code that passed through. */
export function oneEnvelope(send) {
  let open = false;
  let bytes = 0;
  let lastError = null;
  return {
    sink: {
      event(e) {
        if (e?.type === "tts_start") { if (open) return; open = true; }
        else if (e?.type === "tts_end") return;
        else if (e?.type === "error") {
          // The device gets the code only: a provider's own error text stays in the gateway log.
          lastError = String(e.code || "error");
          send.text({ type: "error", code: lastError, recoverable: e.recoverable !== false });
          return;
        }
        send.text(e);
      },
      audio(buf) { bytes += buf.length; send.binary(buf); },
    },
    close() { if (open) { open = false; send.text({ type: "tts_end" }); } },
    get bytes() { return bytes; },
    get lastError() { return lastError; },
  };
}

/**
 * deps:
 *   voice            the shared runner: { runVoiceTurn, speakText, transcribe, convo }
 *   openDb()         → a db handle with close()
 *   findDevice(db, id) → the stored record (or null)
 *   listTtsProfiles(db) → [{ id, provider, isDefault }]
 *   botToolNames(db, device) → names of every tool the bound assistant would be offered
 *   capture(deviceId) → Promise<{ url, size, photo_id }>   (asks the phone for one frame; rejects on failure)
 *   describePhoto({ db, device, shot, question }) → Promise<string|null>
 *   readEnvelope(toolName, result)      (./envelope.js)
 *   playback: { state(deviceId), control(deviceId, action) }   (starting a stream is the caller's job: see runTurn's result)
 *   timeZone         IANA zone for [Now] and the clock answers (the server's; the phone sends none)
 *   log(line), now()
 */
export function createGlassesTurns(deps) {
  const log = deps.log || ((m) => console.log(m));
  const now = deps.now || Date.now;
  const recent = new Map();

  function record(deviceId, entry) {
    const list = recent.get(deviceId) || [];
    list.push(entry);
    while (list.length > RECENT_TURNS) list.shift();
    recent.set(deviceId, list);
    // Codes and timings only: never what was said.
    log(`[glasses-metrics] ${JSON.stringify({ device: deviceId, ...entry })}`);
  }

  /** Say `text` inside the turn's one envelope; false when it could not be spoken. */
  async function sayLine(db, device, env, text, signal) {
    try { return (await deps.voice.speakText({ db, device, text, sink: env.sink, signal })) === true; }
    catch (err) { log(`[meta-glasses] ${device.id} could not speak a line: ${err?.message || err}`); return false; }
  }

  /**
   * Run one voice turn for a connected device. `audio` is a WAV buffer; `send` = { text(obj), binary(buf) }.
   * Resolves with what happened (codes and timings; `playback` = a music envelope for the caller to start); never rejects.
   */
  async function runTurn({ deviceId, audio, send, signal, startedAt }) {
    const t0 = Number.isFinite(startedAt) ? startedAt : now();
    const env = oneEnvelope(send);
    const entry = { at: t0, route: null, fast_path: false, escalated: false, degraded: null, failed: null, look: false, timings: {} };
    const db = deps.openDb();
    let pending = null;
    try {
      const stored = await deps.findDevice(db, deviceId);
      if (!stored) { send.text({ type: "error", code: "device_not_found", recoverable: false }); entry.failed = "device_not_found"; return entry; }
      const { token_hash: _h, kiosk_token_hash: _k, ...device0 } = stored;
      const vs = device0.voice_settings && typeof device0.voice_settings === "object" ? device0.voice_settings : {};
      const L = stringsFor(vs.lang);

      const ttsId = playableTtsProfile(device0, await deps.listTtsProfiles(db));
      if (ttsId === false) {
        // Nothing this client can play: the one case that cannot be spoken. The panel shows it.
        log(`[meta-glasses] ${deviceId} has no voice profile that returns raw PCM; nothing can be spoken`);
        send.text({ type: "error", code: "no_playable_voice", recoverable: false });
        entry.failed = "no_playable_voice";
        return entry;
      }
      const device = { ...device0, tts_profile_id: ttsId };

      if (!device.bound_bot_id) {
        await sayLine(db, device, env, L.no_bot, signal);
        send.text({ type: "error", code: "no_bound_bot", recoverable: false });
        entry.failed = "no_bound_bot";
        return entry;
      }

      // Speech-to-text first: what the turn offers depends on what was asked.
      let transcript = "";
      try { transcript = (await deps.voice.transcribe({ db, device, audio, signal })).text; }
      catch (err) {
        if (signal?.aborted) { entry.failed = null; entry.aborted = true; return entry; }
        log(`[meta-glasses] ${deviceId} speech-to-text failed: ${err?.code || err?.message || err}`);
        await sayLine(db, device, env, L.stt_failed, signal);
        send.text({ type: "error", code: "stt_failed", recoverable: true });
        entry.failed = "stt_failed";
        return entry;
      }
      entry.timings.stt_ms = now() - t0;
      if (!transcript) {
        send.text({ type: "transcript_final", text: "" });
        await sayLine(db, device, env, L.didnt_catch, signal);
        entry.failed = "empty_transcript";
        return entry;
      }

      const look = wantsLook(transcript);
      entry.look = look;
      const deny = [...GLASSES_DENY_TOOLS];
      const extraTools = [];
      if (look) {
        // The camera is offered ALONE: whatever the photo says, the model that reads it has nothing else to call.
        for (const name of await deps.botToolNames(db, device)) if (name !== LOOK_TOOL) deny.push(name);
        extraTools.push({
          definition: {
            name: LOOK_TOOL,
            description: "Take one photo with the glasses camera and get a description of what it shows. Call this when the user asks what they are looking at or asks for a photo.",
            inputSchema: { type: "object", properties: { question: { type: "string", description: "What the user wants to know about what they see" } } },
          },
          when: () => true,
          must: () => true,
          mustDone: (res) => res?.ok === true,
          execute: async (args) => {
            let shot;
            try { shot = await deps.capture(deviceId); }
            catch (err) {
              log(`[meta-glasses] ${deviceId} photo capture failed: ${err?.message || err}`);
              return JSON.stringify({ ok: false, code: "capture_failed", message: L.photo_error });
            }
            let description = null;
            try { description = await deps.describePhoto({ db, device, shot, question: typeof args?.question === "string" && args.question.trim() ? args.question.trim().slice(0, 300) : transcript }); }
            catch (err) { log(`[meta-glasses] ${deviceId} photo description failed: ${err?.message || err}`); }
            return JSON.stringify(description
              ? { ok: true, code: "described", description: `${L.photo_wrapper} ${String(description).slice(0, 1500)}` }
              : { ok: true, code: "saved", note: L.photo_saved });
          },
        });
      }

      const result = await deps.voice.runVoiceTurn({
        db, device, transcript, sink: env.sink, signal, startedAt: t0,
        promptSuffix: L.prompt_suffix,
        turnContext: nowContext(now(), deps.timeZone),
        denyTools: deny,
        extraTools,
        maxToolRounds: GLASSES_MAX_TOOL_ROUNDS,
        firstAudioBudgetMs: look ? GLASSES_LOOK_BUDGET_MS : GLASSES_FIRST_AUDIO_BUDGET_MS,
        fallbackText: L.fallback,
        tooLargeText: L.too_large,
        displayMissedText: L.photo_failed,
        memoryOn: vs.memory !== false,
        memoryWhen: wantsMemory,
        // No model call for a playback control that fits the current state, or a plain time or date question.
        fastPaths: async (t) => {
          const m = matchTransport(t, deps.playback.state(deviceId));
          if (m) {
            deps.playback.control(deviceId, m.action);
            return { say: L[m.say] };
          }
          return matchClockFastPath(t, { now: now(), tz: deps.timeZone });
        },
        // Keyed on `tool`, the tool that really ran: a fw_play called through the crow_tools wrapper is still fw_play.
        onToolResult: async ({ name, tool, result: text }) => {
          const e = deps.readEnvelope(tool || name, text);
          if (!e) return undefined;
          if (e.kind === "control") deps.playback.control(deviceId, e.action);
          else if (e.kind === "stream") pending = e;
          else log(`[meta-glasses] ${deviceId} ignored an audio envelope from a tool that may not send one (${String(tool || name).replace(/[^\w.-]/g, "_").slice(0, 48)})`);
          return e.say;
        },
      });

      Object.assign(entry, {
        route: result.route, fast_path: !!result.fastPath, escalated: !!result.escalated, degraded: result.degraded ?? null,
        failed: result.failed ?? null, aborted: !!result.aborted, timings: { ...entry.timings, ...(result.timings || {}) },
      });
      // What the camera saw does not stay in the conversation a later turn's tools can read.
      if (look) {
        for (const m of deps.voice.convo.get(deviceId)) if (m && m.role === "tool" && m.tool_name === LOOK_TOOL) m.content = L.photo_marker;
      }
      // The shared turn speaks its own line for most failures. A few end with no speech at all
      // (an exception inside the turn; an assistant that was disabled or deleted). Never silent:
      // say why, in one line.
      if (!result.aborted && env.bytes === 0) {
        const code = result.failed || env.lastError;
        if (code) {
          entry.failed = entry.failed || code;
          await sayLine(db, device, env, code === "no_bound_bot" ? L.no_bot : L.failed, signal);
        }
      }
      return entry;
    } catch (err) {
      entry.failed = entry.failed || "error";
      log(`[meta-glasses] ${deviceId} turn failed: ${err?.message || err}`);
      send.text({ type: "error", code: "turn_failed", recoverable: true });
      return entry;
    } finally {
      env.close();
      entry.timings.total_ms = now() - t0;
      record(deviceId, entry);
      try { db.close(); } catch { /* already closed */ }
      // Music is the CALLER's to start (deps.playback.start), after this turn's speech has gone
      // out and its lock is free: handed back on the entry, never started from inside the turn.
      if (pending && !signal?.aborted) entry.playback = pending;
    }
  }

  /** Speak text outside a turn (a reminder, the dashboard's Say). → { delivered, reason? } */
  async function speak({ deviceId, text, send, signal }) {
    const env = oneEnvelope(send);
    const db = deps.openDb();
    try {
      const stored = await deps.findDevice(db, deviceId);
      if (!stored) return { delivered: false, reason: "device_not_found" };
      const ttsId = playableTtsProfile(stored, await deps.listTtsProfiles(db));
      if (ttsId === false) return { delivered: false, reason: "no_playable_voice" };
      const ok = await sayLine(db, { ...stored, tts_profile_id: ttsId }, env, String(text || "").slice(0, 2000), signal);
      return ok && env.bytes > 0 ? { delivered: true } : { delivered: false, reason: "tts_failed" };
    } finally {
      env.close();
      try { db.close(); } catch { /* already closed */ }
    }
  }

  return { runTurn, speak, recentTurns: (deviceId) => [...(recent.get(deviceId) || [])].reverse() };
}
