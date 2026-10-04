/** Pure page decisions (unit-tested in Node). */
import { e2eMs } from "./metrics.js";

/**
 * Close codes: 4401 unauthorized/unpaired → the token is dead, re-pair; 4000 superseded →
 * the display is open elsewhere, stop (no ping-pong). Everything else — 4401 hello_timeout,
 * 1006 network drops, 1011 server_error (a transient verify/setup failure) — reconnects
 * with backoff and KEEPS the token.
 */
export function closeDecision(code, reason) {
  if (code === 4401 && (reason === "unauthorized" || reason === "unpaired")) return { action: "forget_token" };
  if (code === 4000 && reason === "superseded") return { action: "halt", banner: "opened_elsewhere" };
  return { action: "reconnect" };
}
export function backoffMs(attempt) { return Math.min(30_000, 1000 * 2 ** Math.min(Math.max(0, attempt), 5)); }
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
export function msToNextMinute(date) { return 60_000 - (date.getSeconds() * 1000 + date.getMilliseconds()); }

/*
 * Ruling F3: the server sends turn_done + state idle when it has SENT the audio,
 * before the page has PLAYED it. The page stays "speaking" until local playback
 * drains; the follow-up mic and the turn_metrics report key off the drain.
 */
export function displayedBird(serverBird, localPlaying) {
  return localPlaying && serverBird === "idle" ? "speaking" : serverBird;
}
export function tapDecision({ halted, playing, birdState, turnOpen }) {
  if (halted) return "resume";
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
    barged: !!turn.barged, output_latency_ms: outputLatencyMs,
  };
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
