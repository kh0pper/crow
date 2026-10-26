/**
 * The voice transcript buffer (PR 2.1 Task 7): an opt-in, in-memory view of the last few voice-bot turns on each device,
 * for troubleshooting a turn after the fact (the convo store has no route, and no log carries the words).
 *
 * - OFF unless the Crow voice bot's def has voice.transcript_buffer === true (normalizeVoiceSettings). A turn, or a
 *   pibots:defs-changed reload, that reads it as off clears the WHOLE buffer.
 * - In memory only, per device: at most TRANSCRIPT_BUFFER_MAX entries, none older than TRANSCRIPT_BUFFER_TTL_MS.
 *   Never written to disk and never logged; nothing in this module logs.
 * - An entry: { at, transcript, stt_rewrite, spoken, tools_called, codes }. transcript is the final one (after the STT
 *   rewrite), stt_rewrite what was heard before it (null when not rewritten), spoken the text handed to TTS (what the
 *   person heard), tools_called the tool names the model called, codes the per-call result codes ("name:code"), a fast
 *   path's verb ("verb:<v>") and a failure ("failed:<why>").
 *
 * The one process-wide buffer is `voiceTranscripts` (turn.js defaultVoiceDeps feeds every runner from it, so the kiosk's
 * admin route sees phone and display turns alike).
 */
import { normalizeVoiceSettings, isVoiceBotDef } from "../../shared/voice-bot.js";

export const TRANSCRIPT_BUFFER_MAX = 20;
export const TRANSCRIPT_BUFFER_TTL_MS = 15 * 60_000;
const MAX_DEVICES = 64;
const TEXT_MAX = 2000;
const LIST_MAX = 32;

/** Is the buffer on for this (Crow voice bot) def? Anything but an explicit true is off. */
export function transcriptBufferOn(def) {
  return !!def && isVoiceBotDef(def) && normalizeVoiceSettings(def).transcript_buffer === true;
}

const text = (v) => (typeof v === "string" ? v.slice(0, TEXT_MAX) : "");
const names = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x).slice(0, LIST_MAX).map((x) => x.slice(0, 200)) : []);

/**
 * sweepMs (the singleton: 60 s): while anything is held, an unref()'d interval prunes every device, so a display that
 * goes quiet does not keep its words in the heap past the TTL. It starts on the first record and stops when the buffer
 * empties, so a buffer nothing records into never has a timer. setInterval / clearInterval are injectable (tests).
 */
export function createTranscriptBuffer({ now = Date.now, max = TRANSCRIPT_BUFFER_MAX, ttlMs = TRANSCRIPT_BUFFER_TTL_MS,
  sweepMs = 0, setInterval: setIv = globalThis.setInterval, clearInterval: clearIv = globalThis.clearInterval } = {}) {
  const byDevice = new Map();
  let timer = null;
  const stopSweep = () => { if (timer) { clearIv(timer); timer = null; } };
  const live = (list) => {
    const cut = now() - ttlMs;
    return list.filter((e) => e.at > cut);
  };
  const prune = (id) => {
    const list = byDevice.get(id);
    if (!list) return [];
    const kept = live(list);
    if (kept.length) byDevice.set(id, kept); else byDevice.delete(id);
    return kept;
  };

  /** Prune every device; drop the empty ones; stop the sweep once nothing is held. */
  function sweep() {
    for (const id of [...byDevice.keys()]) prune(id);
    if (byDevice.size === 0) stopSweep();
  }

  function record(deviceId, entry = {}) {
    if (typeof deviceId !== "string" || !deviceId) return;
    sweep();
    const e = Object.freeze({
      at: now(),
      transcript: text(entry.transcript),
      stt_rewrite: typeof entry.stt_rewrite === "string" && entry.stt_rewrite ? text(entry.stt_rewrite) : null,
      spoken: text(entry.spoken),
      tools_called: Object.freeze(names(entry.tools_called)),
      codes: Object.freeze(names(entry.codes)),
    });
    const list = prune(deviceId);
    list.push(e);
    byDevice.delete(deviceId);   // re-insert: the map's order is least recently used first
    byDevice.set(deviceId, list.slice(-max));
    while (byDevice.size > MAX_DEVICES) byDevice.delete(byDevice.keys().next().value);
    if (sweepMs > 0 && !timer) { timer = setIv(sweep, sweepMs); timer?.unref?.(); }
  }

  /** This device's live entries, oldest first (copies). */
  function list(deviceId) {
    return prune(String(deviceId)).map((e) => ({ ...e, tools_called: [...e.tools_called], codes: [...e.codes] }));
  }

  /** Drop one device's entries, or (no id) everything. */
  function clear(deviceId) {
    if (deviceId === undefined) byDevice.clear(); else byDevice.delete(String(deviceId));
    if (byDevice.size === 0) stopSweep();
  }

  /** How many entries are live across every device. */
  function size() {
    let n = 0;
    for (const id of [...byDevice.keys()]) n += prune(id).length;
    return n;
  }

  // Test-only: what the map really holds (no pruning), entries and devices.
  const _rawCount = () => [...byDevice.values()].reduce((n, l) => n + l.length, 0);
  const _deviceCount = () => byDevice.size;

  return { record, list, clear, size, sweep, _rawCount, _deviceCount };
}

/**
 * A pibots:defs-changed reload: with anything held, read the voice def (readDef → def | null; a throw counts as off)
 * and clear the whole buffer unless it is on.
 */
export async function reloadTranscriptSetting(buffer, readDef) {
  if (!buffer || buffer.size() === 0) return;
  let def = null;
  try { def = await readDef(); } catch { def = null; }
  if (!transcriptBufferOn(def)) buffer.clear();
}

export const voiceTranscripts = createTranscriptBuffer({ sweepMs: 60_000 });
