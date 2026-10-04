/** Client energy VAD (spec §7.3): 600 ms hangover, 15 s cap, 8 s with no speech ends a tap. */
export const VAD_DEFAULTS = Object.freeze({ threshold: 0.012, hangoverMs: 600, maxMs: 15_000, minSpeechMs: 120, noSpeechMs: 8000, frameMs: 20 });

export function createVad(opts = {}) {
  const o = { ...VAD_DEFAULTS, ...opts };
  let startAt = null, speechMs = 0, started = false, lastVoiceAt = null, ended = false;
  return {
    push(rms, t) {
      if (ended) return { end: false };
      if (startAt == null) startAt = t - o.frameMs;
      if (rms >= o.threshold) { speechMs += o.frameMs; lastVoiceAt = t; if (speechMs >= o.minSpeechMs) started = true; }
      let r = null;
      if (started && t - lastVoiceAt >= o.hangoverMs) r = { end: true, reason: "silence", speechEndAt: lastVoiceAt };
      else if (t - startAt >= o.maxMs) r = { end: true, reason: "max", speechEndAt: lastVoiceAt ?? t };
      else if (!started && t - startAt >= o.noSpeechMs) r = { end: true, reason: "no_speech", speechEndAt: null };
      if (r) ended = true;
      return r || { end: false };
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
