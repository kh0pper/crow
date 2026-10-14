/**
 * The one place a model error's text is made safe to show (perch strands
 * plan, strand 1). pi's `errorMessage` rides the provider's 4xx/5xx body, so it
 * can carry request URLs, keys and echoed request fragments. Both the live
 * engine frame (perch-interactive.js) and the reloaded transcript
 * (routes/perch.js readTranscript) pass through here, so the raw text never
 * crosses the wire and the live and reloaded bubbles are byte-identical.
 */

const CAP = 600;
export const MODEL_CALL_FAILED = "The model call failed";

const PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\b(api[_-]?key|access[_-]?token|token|key|secret|password)=([^&\s"']+)/gi,
];

export function redactErrorText(raw) {
  if (raw == null) return MODEL_CALL_FAILED;
  let s = String(raw);
  s = s.replace(PATTERNS[0], "Bearer [redacted]");
  s = s.replace(PATTERNS[1], "[redacted]");
  s = s.replace(PATTERNS[2], (_m, k) => k + "=[redacted]");
  s = s.replace(/\s+/g, " ").trim();
  if (!s) return MODEL_CALL_FAILED;
  return s.length > CAP ? s.slice(0, CAP) + "…" : s;
}

/** The last assistant message of a turn's messages, when it ended in error. */
export function lastAssistantError(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m && m.role === "assistant") return m.stopReason === "error" ? m : null;
  }
  return null;
}
