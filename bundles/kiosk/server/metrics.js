/** Per-device latency ring buffer (spec §9; ruling R8 decides which turns count toward the gate). */
const REASONS = new Set(["silence", "max", "no_speech", "manual"]);
const CTX_STATES = new Set(["running", "suspended", "interrupted", "closed"]);
const clampMs = (v) => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Math.max(0, Math.min(120_000, Math.round(Number(v)))) : null);

export function sanitizeClientMetrics(m) {
  return {
    turn_id: String(m?.turn_id || "").slice(0, 64),
    e2e_ms: clampMs(m?.e2e_ms),
    output_latency_ms: clampMs(m?.output_latency_ms),
    vad_reason: REASONS.has(m?.vad_reason) ? m.vad_reason : null,
    barged: m?.barged === true,
    // End of speech to the moment the thing happened (a window changed, audio became audible). Fast-path turns are judged on it.
    effect_ms: clampMs(m?.effect_ms),
    source: m?.source === "wake" || m?.source === "tap" || m?.source === "follow_up" ? m.source : null,
    // F6: opening the microphone at the tap (a phone releases it after every turn). Not part of e2e: it is before speech.
    mic_open_ms: clampMs(m?.mic_open_ms),
    // r7 G12: the page's player ended a reply whose audio never finished by itself; the AudioContext state at the report.
    tts_stalled: m?.tts_stalled === true,
    ctx_state: CTX_STATES.has(m?.ctx_state) ? m.ctx_state : null,
    // r7b H3: the reply's scheduled audio, and the stall's own evidence (the audio state at the stall, whether its clock moved).
    tts_audio_ms: clampMs(m?.tts_audio_ms),
    stall_ctx_state: CTX_STATES.has(m?.stall_ctx_state) ? m.stall_ctx_state : null,
    stall_clock_moved: typeof m?.stall_clock_moved === "boolean" ? m.stall_clock_moved : null,
  };
}

export function median(sorted) {
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}
export function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

export function createMetricsStore({ max = 100 } = {}) {
  const devs = new Map();
  function rec(dev, turnId) {
    let d = devs.get(dev);
    if (!d) { d = new Map(); devs.set(dev, d); }
    let r = d.get(turnId);
    if (!r) { r = { turn_id: turnId, at: Date.now() }; d.set(turnId, r); while (d.size > max) d.delete(d.keys().next().value); }
    return r;
  }
  return {
    serverTurn(dev, turnId, r) {
      Object.assign(rec(dev, String(turnId)), {
        route: r?.route ?? null, fast_path: !!r?.fastPath, escalated: !!r?.escalated, aborted: !!r?.aborted,
        degraded: r?.degraded ?? null, failed: r?.failed ?? null, timings: r?.timings || {},
      });
    },
    clientTurn(dev, m) {
      const c = sanitizeClientMetrics(m);
      if (!c.turn_id) return null;
      return Object.assign(rec(dev, c.turn_id), { e2e_ms: c.e2e_ms, output_latency_ms: c.output_latency_ms, barged: c.barged, vad_reason: c.vad_reason, source: c.source, effect_ms: c.effect_ms, mic_open_ms: c.mic_open_ms, tts_stalled: c.tts_stalled, ctx_state: c.ctx_state, tts_audio_ms: c.tts_audio_ms, stall_ctx_state: c.stall_ctx_state, stall_clock_moved: c.stall_clock_moved });
    },
    list(dev) { return [...(devs.get(dev)?.values() || [])].reverse(); },
    /**
     * The gate view (ruling R8, review M5): the LAST `last` turns that exercised the
     * budgeted path — fast route, no fast path, not escalated, NOT degraded (a cold
     * fallback's first audio is the filler), not aborted, silence-ended. Such a turn
     * with no audio (e2e null) is a FAILURE, counted as Infinity, never dropped. So is a turn
     * that ended on the fallback line (r.failed): its audio is the apology, not an answer.
     * r.failed (from the voice turn): tool_rounds | tool_repeat | no_text | budget | error |
     * bot_too_large (the assistant's prompt cannot fit the quick voice model: no model call) |
     * context_full (the request would not fit the context: not sent) | display_missed (a turn that
     * asked for something on the screen ended with nothing put there: the could-not-show line was
     * spoken). Every one is a failure here. timings.tools carries each tool call's outcome (name:code).
     */
    summary(dev, { last = 20 } = {}) {
      const ok = [...(devs.get(dev)?.values() || [])].filter((r) => r.route === "fast" && !r.fast_path && !r.escalated && !r.degraded && !r.aborted && !r.barged && r.vad_reason === "silence").slice(-last);
      const v = ok.map((r) => (Number.isFinite(r.e2e_ms) && !r.failed ? r.e2e_ms : Infinity)).sort((a, b) => a - b);
      return { n: v.length, no_audio: v.filter((x) => x === Infinity).length, median_ms: median(v), p90_ms: percentile(v, 90) };
    },
  };
}
