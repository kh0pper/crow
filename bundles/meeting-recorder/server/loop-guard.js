/**
 * Meeting Recorder — an engine-agnostic repetition-loop detector.
 *
 * Whisper-family decoders can fall into a loop: one sentence, or "thank you", emitted over and
 * over until the window ends. faster-whisper reports a per-segment compression ratio that catches
 * most of these, but not every engine reports it, and a loop of varied phrasing can stay under
 * the ratio threshold. These checks need only the text and the audio length, so they guard any
 * engine the worker talks to.
 */

import { deflateSync } from "node:zlib";

/** Whisper's definition: UTF-8 bytes over zlib-compressed bytes. Loops compress very well. */
export function compressionRatio(text) {
  const bytes = Buffer.from(String(text || ""), "utf8");
  if (!bytes.length) return 0;
  return bytes.length / deflateSync(bytes).length;
}

export const wordsOf = (text) => String(text || "").toLowerCase().split(/\s+/).filter(Boolean);

/** How often the most frequent n-word sequence occurs. */
export function maxNgramRepeats(text, n = 5) {
  const w = wordsOf(text).map((x) => x.replace(/[^\p{L}\p{N}']/gu, "")).filter(Boolean);
  const counts = new Map();
  let max = 0;
  for (let i = 0; i + n <= w.length; i++) {
    const key = w.slice(i, i + n).join(" ");
    const c = (counts.get(key) || 0) + 1;
    counts.set(key, c);
    if (c > max) max = c;
  }
  return max;
}

export const LOOP_DEFAULTS = Object.freeze({ maxWps: 4, ngram: 5, maxRepeats: 8, minSeconds: 5 });

/**
 * Flag text that reads like a decode loop: more than maxWps words per second (judged over at
 * least minSeconds, so a short tail is not condemned for a quick phrase), or any ngram-word
 * sequence repeated more than maxRepeats times.
 */
export function loopCheck(text, seconds, opts = {}) {
  const o = { ...LOOP_DEFAULTS, ...opts };
  const words = wordsOf(text).length;
  const wps = words / Math.max(Number(seconds) || 0, o.minSeconds);
  const maxRepeats = maxNgramRepeats(text, o.ngram);
  let reason = "";
  if (maxRepeats > o.maxRepeats) reason = `${o.ngram}-gram repeated ${maxRepeats}x`;
  else if (wps > o.maxWps) reason = `${wps.toFixed(1)} words/s`;
  return { loop: Boolean(reason), reason, words, wps, maxRepeats };
}
