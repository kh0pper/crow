/**
 * Shared HTTP timeout helpers for turn-blocking upstream fetches.
 *
 * Two timeout classes:
 *   connectTimeout(ms) — aborts if response HEADERS haven't arrived within ms;
 *     once headers arrive, disarm the timer so long streaming responses are
 *     never killed mid-stream. Usage:
 *       const t = connectTimeout(ms);
 *       const res = t.disarm(await fetch(url, { signal: t.signal }));
 *
 *   timeoutSignal(ms) — total-duration timeout for buffered calls (embeddings).
 *     Thin wrapper around AbortSignal.timeout.
 *
 * composeSignals(...signals) — manually composed abort propagation (not
 *   AbortSignal.any, which requires Node ≥20.3; package.json declares ≥18).
 *
 * Env overrides (read once at module load):
 *   CROW_HTTP_LLM_CONNECT_TIMEOUT_MS  (default 20000)
 *   CROW_HTTP_AI_TIMEOUT_MS           (default 60000)
 *   CROW_HTTP_TTS_TIMEOUT_MS          (default 10000)
 *   CROW_HTTP_VOICELIST_TIMEOUT_MS    (default 5000)
 */

export const LLM_CONNECT_TIMEOUT_MS =
  parseInt(process.env.CROW_HTTP_LLM_CONNECT_TIMEOUT_MS, 10) || 20000;
export const AI_TIMEOUT_MS =
  parseInt(process.env.CROW_HTTP_AI_TIMEOUT_MS, 10) || 60000;
export const TTS_TIMEOUT_MS =
  parseInt(process.env.CROW_HTTP_TTS_TIMEOUT_MS, 10) || 10000;
export const VOICELIST_TIMEOUT_MS =
  parseInt(process.env.CROW_HTTP_VOICELIST_TIMEOUT_MS, 10) || 5000;

/**
 * Total-duration timeout for BUFFERED calls (embeddings, voice lists, TTS when
 * no streaming is expected). AbortSignal.timeout is available since Node 17.3.
 */
export function timeoutSignal(ms) {
  return AbortSignal.timeout(ms);
}

/**
 * Connect / first-byte timeout for STREAMING calls (LLM chat, TTS synthesize).
 * Aborts only if response headers have not arrived within `ms`; once the
 * response starts, the timer is disarmed so long generations are never killed
 * mid-stream.
 *
 * IMPORTANT: disarm MUST be applied in the same statement as the fetch await:
 *   const res = t.disarm(await fetch(url, { signal: t.signal }));
 * A later disarm would allow the timer to fire during the response.
 */
export function connectTimeout(ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(
    () => ctrl.abort(new DOMException("Connect timeout", "TimeoutError")),
    ms
  );
  timer.unref?.();
  return {
    signal: ctrl.signal,
    disarm(res) {
      clearTimeout(timer);
      return res;
    },
  };
}

/**
 * Compose two or more AbortSignals into one that aborts when ANY source aborts.
 * Falsy values are filtered out. Returns the single non-falsy signal if only
 * one survives filtering (avoids unnecessary wrapper). If a source is already
 * aborted, the composite is aborted immediately.
 */
export function composeSignals(...signals) {
  const live = signals.filter(Boolean);
  if (live.length === 0) return undefined;
  if (live.length === 1) return live[0];

  const ctrl = new AbortController();

  for (const sig of live) {
    if (sig.aborted) {
      ctrl.abort(sig.reason);
      return ctrl.signal;
    }
    sig.addEventListener(
      "abort",
      () => { if (!ctrl.signal.aborted) ctrl.abort(sig.reason); },
      { once: true }
    );
  }

  return ctrl.signal;
}

/**
 * Returns true when an error is (or wraps) a timeout/abort-from-timeout error.
 */
export function isTimeoutError(err) {
  return err?.name === "TimeoutError" || err?.cause?.name === "TimeoutError";
}
