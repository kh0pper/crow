/**
 * The one place a model error's text is made safe to show (perch strands
 * plan, strand 1). pi's `errorMessage` rides the provider's 4xx/5xx body, so it
 * can carry request URLs, keys and echoed request fragments. Both the live
 * engine frame (perch-interactive.js) and the reloaded transcript
 * (routes/perch.js readTranscript) pass through here, so the raw text never
 * reaches the hub's chat and the live and reloaded rows are byte-identical.
 * (The bot board's raw transcript.jsonl download, an operator file behind
 * the same login, still serves pi's file as written.)
 */

const CAP = 600;
export const MODEL_CALL_FAILED = "The model call failed";

// Each is linear (no nested quantifiers): a 5 MB body redacts in ~10 ms.
const RULES = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]"],
  [/\bBasic\s+[A-Za-z0-9+/=]{8,}/gi, "Basic [redacted]"],
  [/(\/\/)[^\s/@:]+:[^\s/@]+@/g, "$1[redacted]@"],                        // URL userinfo
  [/\b((?:x-)?api[_-]?key|access[_-]?token|token|key|secret|password)(["']?\s*[:=]\s*["']?)[^"'\s,&}]+/gi,
    "$1$2[redacted]"],                                                       // query, header, JSON
  [/\b(?:sk-[A-Za-z0-9_-]{8,}|AIza[0-9A-Za-z_-]{20,}|hf_[A-Za-z0-9]{20,}|gsk_[A-Za-z0-9]{20,}|xai-[A-Za-z0-9]{20,})/g,
    "[redacted]"],                                                           // bare provider keys
];

export function redactErrorText(raw) {
  if (raw == null) return MODEL_CALL_FAILED;
  let s = String(raw);
  for (const [re, to] of RULES) s = s.replace(re, to);
  s = s.replace(/\s+/g, " ").trim();
  if (!s) return MODEL_CALL_FAILED;
  return s.length > CAP ? s.slice(0, CAP) + "\u2026" : s;
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
