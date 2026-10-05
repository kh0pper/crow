/**
 * The text every transcript matcher in this bundle reads (display intent, memory intent,
 * the clock and window fast paths). A matcher only ever sees the first INTENT_MAX_CHARS
 * characters — cut BEFORE any regular expression runs — so no input, however long or
 * repetitive, can make one slow. A spoken turn is a sentence or two; nothing a matcher
 * looks for sits further in than this.
 */
export const INTENT_MAX_CHARS = 400;

/** Capped, lower case, punctuation to single spaces, trimmed ("" for a non-string): what the intent word lists are tested against. */
export function intentText(transcript) {
  if (typeof transcript !== "string") return "";
  return transcript.slice(0, INTENT_MAX_CHARS).toLowerCase().replace(/[¿¡“”"'’,.!?;:]+/g, " ").replace(/\s+/g, " ").trim();
}
