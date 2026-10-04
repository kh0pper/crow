/**
 * Client energy VAD (spec §7.3): 450 ms hangover (smoke 2026-10-04 lever 1; per display 300-900 ms), 15 s cap,
 * 8 s with no speech ends a tap. Early STT (lever D): `pauseMs` into a silence after real speech, push()
 * reports `pause: true` ONCE for that silence, so the server can start transcribing while the hangover
 * still runs; a resumed voice starts a new silence (and a new pause). `voiced` marks a frame at/over threshold.
 */
export const VAD_DEFAULTS = Object.freeze({ threshold: 0.012, hangoverMs: 450, pauseMs: 120, maxMs: 15_000, minSpeechMs: 120, noSpeechMs: 8000, frameMs: 20 });

export function createVad(opts = {}) {
  const o = { ...VAD_DEFAULTS, ...opts };
  let startAt = null, speechMs = 0, started = false, lastVoiceAt = null, ended = false, pausedFor = null;
  return {
    push(rms, t) {
      if (ended) return { end: false };
      if (startAt == null) startAt = t - o.frameMs;
      const voiced = rms >= o.threshold;
      if (voiced) { speechMs += o.frameMs; lastVoiceAt = t; if (speechMs >= o.minSpeechMs) started = true; }
      let r = null;
      if (started && t - lastVoiceAt >= o.hangoverMs) r = { end: true, reason: "silence", speechEndAt: lastVoiceAt };
      else if (t - startAt >= o.maxMs) r = { end: true, reason: "max", speechEndAt: lastVoiceAt ?? t };
      else if (!started && t - startAt >= o.noSpeechMs) r = { end: true, reason: "no_speech", speechEndAt: null };
      if (r) { ended = true; return r; }
      if (started && !voiced && o.pauseMs < o.hangoverMs && t - lastVoiceAt >= o.pauseMs && pausedFor !== lastVoiceAt) {
        pausedFor = lastVoiceAt;
        return { end: false, pause: true, voiced, speechEndAt: lastVoiceAt };
      }
      return { end: false, voiced };
    },
  };
}

/** 1.0 s ring of 20 ms frames, held in page memory only; nothing is sent while idle. */
export function createPreroll(maxFrames = 50) {
  const buf = [];
  return {
    push(f) { buf.push(f); if (buf.length > maxFrames) buf.shift(); },
    drain() { return buf.splice(0); },
    get size() { return buf.length; },
  };
}

/** Wall-clock backstop: if the worklet stops posting (phone locked, track ended) the VAD never sees the cap. */
export const TURN_GUARD_MS = VAD_DEFAULTS.maxMs + 1000;
