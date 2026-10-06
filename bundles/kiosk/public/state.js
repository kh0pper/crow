/** Pure page decisions (unit-tested in Node). */
import { e2eMs } from "./metrics.js";

/**
 * Close codes: 4401 unauthorized/unpaired → the token is dead, re-pair; 4000 superseded →
 * the display is open elsewhere, stop (no ping-pong). Everything else — 4401 hello_timeout,
 * 1006 network drops, 1011 server_error (a transient verify/setup failure) — reconnects
 * with backoff and KEEPS the token. `mode` is "session" on /display/session.
 */
export function closeDecision(code, reason, mode) {
  // A session display (the dashboard's Talk to Crow) has no token to forget and nothing to pair:
  // an ended login or a missing assistant stops it with a message; a tap tries again.
  if (mode === "session") {
    if (code === 4401 && (reason === "unauthorized" || reason === "unpaired")) return { action: "halt", banner: "session_expired" };
    if (code === 4403 && reason === "no_bot") return { action: "halt", banner: "session_no_bot" };
  }
  if (code === 4401 && (reason === "unauthorized" || reason === "unpaired")) return { action: "forget_token" };
  if (code === 4000 && reason === "superseded") return { action: "halt", banner: "opened_elsewhere" };
  return { action: "reconnect" };
}
export function backoffMs(attempt, cap = 30_000) { return Math.min(cap, 1000 * 2 ** Math.min(Math.max(0, attempt), 5)); }
/** Review M3: while audio is live, reconnect at least this often, so the page is back before its offline clear (and the server's grace) runs out. */
export const MEDIA_RECONNECT_CAP_MS = 5_000;
export function micDecision(err, ctxState) {
  if (err && (err.name === "NotAllowedError" || err.name === "SecurityError")) return "mic_blocked";
  if (err && (err.name === "NotFoundError" || err.name === "OverconstrainedError")) return "no_mic";
  if (err) return "mic_error";
  return ctxState === "suspended" ? "needs_gesture" : "ok";
}
const mins = (hhmm) => { const [h, m] = String(hhmm).split(":").map(Number); return h * 60 + m; };
export function isNight(date, start = "22:30", end = "06:30") {
  const m = date.getHours() * 60 + date.getMinutes();
  const s = mins(start), e = mins(end);
  return s <= e ? m >= s && m < e : m >= s || m < e;
}
/** The page theme: a pinned "light"/"dark" wins; "auto" (or anything else) keeps the default rule. */
export function themeFor(pref, { session = false, osDark = false, night = false } = {}) {
  if (pref === "light" || pref === "dark") return pref;
  return (session ? osDark : night) ? "dark" : "light";
}
export function msToNextMinute(date) { return 60_000 - (date.getSeconds() * 1000 + date.getMilliseconds()); }

/*
 * Ruling F3: the server sends turn_done + state idle when it has SENT the audio,
 * before the page has PLAYED it. The page stays "speaking" until local playback
 * drains; the follow-up mic and the turn_metrics report key off the drain.
 */
export function displayedBird(serverBird, localPlaying) {
  return localPlaying && serverBird === "idle" ? "speaking" : serverBird;
}
export function tapDecision({ halted, playing, birdState, turnOpen, starting = false }) {
  if (halted) return "resume";
  if (starting) return "ignore";                 // review H3: the mic is still opening for the last tap
  if (playing || birdState === "speaking") return "barge";
  if (turnOpen) return "stop";
  if (birdState === "thinking") return "ignore";
  return "start";
}
/** Follow up only after this turn's own audio played and drained — never on a barge, a follow-up, silence or an abort. */
export function followUpDecision(turn, config, { playing }) {
  if (!config?.follow_up || !turn || !turn.done || playing) return false;
  if (turn.done.aborted || turn.barged || turn.followedUp || turn.playAt == null) return false;
  return turn.reason !== "no_speech" && turn.source !== "follow_up";
}

/** Ruling F9: how long an audio-expected turn may stay silent after turn_done before it is reported as a failure. */
export const NO_AUDIO_WAIT_MS = 3000;
const expectsAudio = (turn) => !turn.done.aborted && (!!turn.tts || turn.done.timings?.tts_first_chunk_ms != null);
/**
 * When to send this turn's turn_metrics (once). `now` and turn.doneAt are performance.now() ms.
 * Waits while its audio plays (a later barge must still be reported, F3); an audio-expected
 * turn that never played is reported after NO_AUDIO_WAIT_MS with e2e_ms null (F9).
 * `force` (a new turn is starting) reports at once.
 */
export function reportDecision(turn, { playing, now, force = false }) {
  if (!turn || turn.reported || !turn.done) return { report: false };
  if (!force) { const w = effectWaitMs(turn, now); if (w > 0) return { report: false, retryInMs: w }; }
  if (force || turn.barged || !expectsAudio(turn)) return { report: true };
  if (turn.playAt == null) {
    const waited = now - turn.doneAt;
    return waited >= NO_AUDIO_WAIT_MS ? { report: true } : { report: false, retryInMs: NO_AUDIO_WAIT_MS - waited };
  }
  return playing ? { report: false } : { report: true };
}
export function turnMetrics(turn, { outputLatencyMs = 0 } = {}) {
  return {
    type: "turn_metrics", turn_id: turn.id, source: turn.source, vad_reason: turn.reason,
    e2e_ms: e2eMs({ speechEndAt: turn.speechEndAt, playAt: turn.playAt }),
    effect_ms: turn.effectAt == null ? null : e2eMs({ speechEndAt: turn.speechEndAt ?? turn.endedAt, playAt: turn.effectAt }),
    barged: !!turn.barged, output_latency_ms: outputLatencyMs,
    // F6: how long opening the microphone took at this turn's tap (null when it was already open).
    mic_open_ms: Number.isFinite(turn.micOpenMs) ? Math.round(turn.micOpenMs) : null,
  };
}
/**
 * F6 (smoke 2026-10-06): after a turn's speech has ended, does the page let the microphone go? On a phone or
 * a tablet (display_config.mic_per_turn, decided on the server from the display type) yes: an open
 * echo-cancelled capture keeps Android in voice-call audio mode and every sound plays through the call path.
 * The next tap opens it again; the permission is kept, so nothing is asked again. phase: "end" (the speech is in),
 * "settled" (the answer is over and no follow-up started), "closed" (turn_over, socket closed, barge).
 */
export function micAfterTurn(config, { phase = "end", source = "tap" } = {}) {
  if (config?.mic_per_turn !== true) return "keep";
  // Review M4: with follow-up on, a follow-up turn may open right after the answer: the mic is kept through it
  // (one switch into call mode per conversation, not two) and let go when the conversation settles.
  if (phase === "end" && config.follow_up === true && source !== "follow_up") return "keep";
  return "release";
}

/*
 * Ducking (review C1). The music is turned down (or paused) while a turn is OPEN: the mic is open,
 * the server's bird is not idle (listening, thinking, speaking), or this page's TTS is playing.
 * "Open" never depends on turn_done: a turn that never ran (empty, too long, busy) or a socket
 * that closed mid-turn ends with the server's idle state, the mic closed, or the socket's own close.
 */
export function duckDecision({ turnOpen, serverBird, playing }) {
  return !!turnOpen || (typeof serverBird === "string" && serverBird !== "idle") || !!playing;
}
/** Backstop: ducked this long with the bird idle and no TTS playing, the music comes back whatever the page thinks. */
export const DUCK_BACKSTOP_MS = 30_000;
export function duckBackstop({ duckedFor, serverBird, playing }) {
  return duckedFor >= DUCK_BACKSTOP_MS && serverBird === "idle" && !playing;
}

/*
 * Effect time (ruling S12): end of speech to the moment the thing happened. The first `wm` or `media`
 * change that arrives after turn_end and before the turn's closing frame is stamped; a media `load`
 * is stamped when the element reports `playing` for that item, if within EFFECT_WAIT_MS of the load.
 * ev = { kind: "wm" | "media" | "load" | "playing", id?, at } (performance.now() ms). Mutates turn.
 */
export const EFFECT_WAIT_MS = 6000;
export function noteEffect(turn, ev) {
  if (!turn || !turn.ended || turn.effectAt != null || !ev) return false;
  if (ev.kind === "playing") {
    const l = turn.effectLoad;
    if (!l || l.id !== ev.id || ev.at - l.at > EFFECT_WAIT_MS) return false;
    turn.effectAt = ev.at;
    return true;
  }
  if (turn.done || turn.effectLoad) return false;
  if (ev.kind === "load") { turn.effectLoad = { id: ev.id, at: ev.at }; return false; }
  turn.effectAt = ev.at;
  return true;
}
/** A load still waiting for its `playing` holds the turn's report (up to EFFECT_WAIT_MS). → ms to wait, or 0. */
export function effectWaitMs(turn, now) {
  const l = turn?.effectLoad;
  if (!l || turn.effectAt != null) return 0;
  return Math.max(0, EFFECT_WAIT_MS - (now - l.at));
}

/** A dead token or a halt leaves the display idle for a long time: release the mic so the phone's indicator goes off. */
export const releasesMic = (decision) => decision.action === "forget_token" || decision.action === "halt";
/**
 * tts_start: `own` = it belongs to the active turn (may book playAt); `play` = false keeps the player
 * muted — a barged turn's tts_start/frames still in flight before the server saw barge_in.
 */
export function ttsStartDecision(turn) {
  if (turn && turn.barged && !turn.done) return { play: false, own: false };
  return { play: true, own: !!(turn && turn.ended && !turn.done && !turn.barged) };
}
export function pairStartDecision(status, body, attempt) {
  if (status === 200 && body && /^\d{6}$/.test(String(body.code)) && body.pair_id && body.poll_secret) return { action: "show" };
  return status === 429 ? { action: "retry", hint: "pair_busy", ms: 15_000 } : { action: "retry", hint: "pair_error", ms: backoffMs(attempt) };
}
/**
 * What an `error` frame shows: a banner (a display that cannot work until its settings change)
 * or a caption (this turn only). On a paired display bot_too_large is a caption: the server has
 * just spoken and captioned the same line, and this replaces it in the page's language. In session
 * mode (the dashboard's Talk to Crow) both "no assistant" and "assistant too large" show the
 * banner that links to the Kiosk panel, where the assistant is chosen; the spoken line stays as the caption.
 */
export function errorDecision(code, recoverable, mode) {
  const session = mode === "session";
  if (code === "no_bound_bot") return { banner: session ? "session_no_bot" : "no_bot" };
  if (code === "bot_too_large") return session ? { banner: "session_no_bot" } : { caption: "err_bot_too_large" };
  return recoverable ? { caption: `err_${code}` } : { banner: "error_generic" };
}
/**
 * One debug line for a turn's tool calls, from turn_done's timings: "name:code" per call (the
 * server sends outcomes only — never arguments or text), rounds joined by →, plus the display flags.
 */
export function toolsLine(timings) {
  const tm = timings || {};
  const tools = (Array.isArray(tm.tools) ? tm.tools : []).filter((x) => typeof x === "string").map((x) => x.replace(/[^\w:+.-]/g, "_").slice(0, 160));
  const flags = [];
  if (typeof tm.tool_choice === "string") flags.push(`tool_choice ${tm.tool_choice.replace(/[^a-z_]/g, "").slice(0, 16)}`);
  if (tm.display_corrected === true) flags.push("corrected");
  if (tm.display_missed === true) flags.push("display missed");
  if (!tools.length && !flags.length) return "";
  return [tools.length ? tools.join(" → ") : "(no tool call)", ...flags].join(" · ");
}
const MIC_BANNERS = new Set(["mic_blocked", "needs_gesture", "no_mic", "mic_error"]);
export const bannerAfterReady = (cur) => (MIC_BANNERS.has(cur) ? cur : null);

/**
 * Debug ring of what the page displayed (smoke 2026-10-04). Oldest dropped past `max`;
 * format() is newest-first, one "HH:MM:SS.mmm kind: text" line each (text capped at 120).
 */
export function createStatusRing(max = 20) {
  const items = [];
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  const stamp = (at) => { const d = new Date(at); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`; };
  return {
    push(kind, text, at = Date.now()) { items.push({ at, kind: String(kind), text: String(text ?? "").slice(0, 120) }); if (items.length > max) items.shift(); },
    list() { return items.slice(); },
    format() { return items.slice().reverse().map((i) => `${stamp(i.at)} ${i.kind}: ${i.text}`).join("\n"); },
  };
}
