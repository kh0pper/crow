/**
 * Turn context on the user message, and the guard that keeps it out of the answer.
 *
 * A voice turn's live state (kiosk: "[Now] <local date and time>" and "[Display] Open windows: …";
 * glasses: the [Now] line) rides on THIS turn's user message, never the system message: the
 * system message (with the tool schemas the chat template renders after it) stays byte-stable
 * turn to turn so the server's prefix cache holds. A small model sometimes reads that context
 * back as the start of its answer (live 2026-10-05, the quick model: "Okay." → "[Now] Monday,
 * October 5, 2026, 7:23 PM (time zone America/Chicago) [Display] Open windows: none. Got it. …").
 *
 * Two levels:
 *  - withTurnContext() closes the context with a tagged note line that tells the model the
 *    lines are context, not the user's words, right where it reads them; the user's own words
 *    stay last.
 *  - createContextEchoGate() removes an echo of any injected tagged line from the model's text
 *    before it is spoken, captioned, saved or put on a card. It is a streaming filter: text
 *    that could still turn into an echo (a chunk ending in "[No" or half-way through a line) is
 *    held until it is decided. Only the tags the context itself carries are recognised, so the
 *    brackets of an ordinary answer ("[Enter]", "[1, 2]", "[sic]") pass through untouched.
 */

/** Closes the turn context (tagged, so an echo of it is removed like the context lines). */
export const TURN_CONTEXT_NOTE = "[Note] The bracketed lines above are context for you, not the user's words. Never repeat them; answer only what the user said below.";

/** The user message for a turn: context lines, the note, a blank line, then the user's words. */
export function withTurnContext(turnContext, transcript) {
  return turnContext ? `${turnContext}\n${TURN_CONTEXT_NOTE}\n\n${transcript}` : transcript;
}

const TAGGED_LINE = /^\[[A-Z][A-Za-z]{0,23}\] /;
const isWs = (c) => /\s/.test(c);

/**
 * Whitespace- and case-insensitive match of `line` at the start of `s`.
 * → { full: end } | { partial: true } | { no: true }
 */
function matchLine(s, line) {
  let i = 0;
  let j = 0;
  for (;;) {
    if (j >= line.length) return { full: i };
    if (i >= s.length) return { partial: true };
    if (isWs(line[j])) {
      if (!isWs(s[i])) return /^[\s.!?]+$/.test(line.slice(j)) ? { full: i } : { no: true };
      while (j < line.length && isWs(line[j])) j++;
      while (i < s.length && isWs(s[i])) i++;
      continue;
    }
    if (s[i].toLowerCase() === line[j].toLowerCase()) { i++; j++; continue; }
    // Only the line's closing punctuation left ("Open windows: none" without the period): an echo.
    return /^[.!?]+$/.test(line.slice(j)) ? { full: i } : { no: true };
  }
}

/** contexts: strings (null/"" skipped); each line that starts with a "[Tag] " is a line to guard. */
function linesOf(contexts) {
  const lines = [];
  for (const c of contexts || []) {
    if (typeof c !== "string" || !c) continue;
    for (const raw of c.split("\n")) {
      const line = raw.trim();
      if (TAGGED_LINE.test(line)) lines.push(line);
    }
  }
  return lines;
}

/**
 * Streaming echo filter. feed(text) → the text that is safe to speak/caption now; flush() → the
 * rest at the end of the stream. One gate per model round.
 */
export function createContextEchoGate(contexts) {
  const lines = linesOf(contexts);
  const tags = [...new Set(lines.map((l) => l.slice(0, l.indexOf("]") + 1)))];
  // A reworded tag line with no end in sight: past this, only the tag itself is dropped.
  const cap = lines.reduce((m, l) => Math.max(m, l.length), 0) + 80;
  let buf = "";
  let skipWs = false;   // after a removed echo, the whitespace that followed it goes too

  /** buf starts with "[": → { hold } | { drop: n } | { keep } */
  function classify(final) {
    const tag = tags.find((t) => buf.startsWith(t));
    if (!tag) {
      const maybe = tags.some((t) => t.length > buf.length && t.startsWith(buf));
      return maybe && !final ? { hold: true } : { keep: true };
    }
    let partial = false;
    for (const line of lines) {
      if (!line.startsWith(tag)) continue;
      const m = matchLine(buf, line);
      if (m.full !== undefined) return { drop: m.full };
      if (m.partial) partial = true;
    }
    if (partial && !final) return { hold: true };
    // Reworded: the tag through the end of its line or sentence, or up to the next tag.
    const rest = buf.slice(tag.length);
    let end = -1;
    const stop = /[.!?](?=\s)|\n/.exec(rest);
    if (stop) end = tag.length + stop.index + 1;
    for (const t of tags) {
      const k = rest.indexOf(t);
      if (k >= 0 && (end < 0 || tag.length + k < end)) end = tag.length + k;
    }
    if (end >= 0) return { drop: end };
    if (final) return { drop: buf.length };
    if (buf.length > cap) return { drop: tag.length };
    return { hold: true };
  }

  function drain(final) {
    let out = "";
    for (;;) {
      if (skipWs) {
        const t = buf.replace(/^\s+/, "");
        buf = t;
        if (!buf) break;   // more whitespace may follow in the next chunk
        skipWs = false;
      }
      const i = buf.indexOf("[");
      if (i < 0 || !tags.length) { out += buf; buf = ""; break; }
      out += buf.slice(0, i);
      buf = buf.slice(i);
      const r = classify(final);
      if (r.hold) break;
      if (r.drop !== undefined) { buf = buf.slice(r.drop); skipWs = true; continue; }
      out += "[";
      buf = buf.slice(1);
    }
    if (final) { out += buf; buf = ""; }
    return out;
  }

  return {
    feed(text) { buf += text; return drain(false); },
    flush() { return drain(true); },
  };
}

/** The whole text at once (what is saved; a card's text). */
export function stripContextEcho(text, contexts) {
  if (typeof text !== "string" || !text) return text;
  const g = createContextEchoGate(contexts);
  return g.feed(text) + g.flush();
}

/** Every string inside a tool's arguments (a display card's title and body). */
export function stripContextEchoDeep(value, contexts) {
  if (typeof value === "string") return stripContextEcho(value, contexts);
  if (Array.isArray(value)) return value.map((v) => stripContextEchoDeep(v, contexts));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, stripContextEchoDeep(v, contexts)]));
  return value;
}
