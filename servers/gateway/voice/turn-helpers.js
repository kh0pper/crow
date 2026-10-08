/**
 * Pure voice-turn pieces extracted from the Meta Glasses loop
 * (bundles/meta-glasses/panel/routes.js) for the transport-free core turn
 * (kiosk spec 2026-10-03 §7.1). Behaviour is pinned to glasses by
 * tests/voice-turn-helpers.test.js. Two deliberate differences, both marked:
 * pcmStream honours an AbortSignal (barge-in), and the convo store trims to a
 * window that starts on a user message (no orphan tool result).
 */

export const SENTENCE_END = /[.!?…。]["')\]]?\s|[\n]/;

export function createThinkGate() {
  let open = false;
  let pre = "";
  return {
    feed(text) {
      if (open) return text;
      pre += text;
      const lead = pre.replace(/^\s+/, "");
      if (lead.startsWith("<think>")) {
        const close = pre.indexOf("</think>");
        if (close < 0) return "";
        const out = pre.slice(close + 8);
        pre = "";
        open = true;
        return out;
      }
      if (lead.length < 7 && "<think>".startsWith(lead)) return "";
      const out = pre;
      pre = "";
      open = true;
      return out;
    },
  };
}

/**
 * Tool-call syntax written as TEXT (kiosk re-smoke 2026-10-07 G3: the quick model wrote "<tool_call><function=crow_play>…"
 * for a tool it was not offered). Everything from the first marker on is dropped for the rest of the round; a
 * trailing "<…" that could still become a marker is held until the next delta. `cut` says whether it happened.
 */
// Review of rev 7 (L1): Qwen/Hermes XML tags, Mistral's [TOOL_CALLS], Llama's <|python_tag|>, <function_call>, any case,
// and a bare JSON call object. Lower case; the gate compares case-insensitively.
// r7c: also a pretty-printed call ("{" then a newline, then "name") and a fenced json block. Markers are compared with
// whitespace removed, so a delta that ends right after "{\n" is held too.
const TOOL_MARKERS = ["<tool_call", "</tool_call", "<function=", "<function>", "</function", "<function_call", "<parameter=", "<|tool_call", "<|python_tag|>", "[tool_calls]", '{"name"', "```json{"];
export const TOOL_SYNTAX = /<\/?tool_call|<\/?function(?:_call)?[=>]|<parameter=|<\|tool_call|<\|python_tag\|>|\[TOOL_CALLS\]|\{\s*"name"\s*:|```json\s*\{/i;
export function stripToolSyntax(text) { const s = String(text ?? ""); const m = TOOL_SYNTAX.exec(s); return m ? s.slice(0, m.index).trimEnd() : s; }
export function createToolSyntaxGate() {
  let buf = "", cut = false;
  return {
    get cut() { return cut; },
    feed(text) {
      if (cut) return "";
      buf += text;
      const m = TOOL_SYNTAX.exec(buf);
      if (m) { cut = true; const out = buf.slice(0, m.index); buf = ""; return out; }
      const could = (at) => { const t = buf.slice(at).toLowerCase().replace(/\s+/g, ""); return TOOL_MARKERS.some((k) => k.startsWith(t) && t.length < k.length); };
      const at = [buf.search(/`+[a-z]*\s*$/i), buf.lastIndexOf("<"), buf.lastIndexOf("["), buf.lastIndexOf("{")].filter((i) => i >= 0 && could(i)).sort((a, b) => a - b)[0];
      if (at !== undefined) { const out = buf.slice(0, at); buf = buf.slice(at); return out; }
      const out = buf; buf = ""; return out;
    },
    flush() { const out = cut ? "" : buf; buf = ""; return out; },
  };
}

/**
 * Clause break for the FIRST chunk only (kiosk latency lever 3): , ; : or a dash
 * followed by whitespace (so "1,000" and "3:30" never split). Only taken when the
 * clause already holds FIRST_CLAUSE_MIN_WORDS words, so "Sure," or "Well," is not
 * spoken alone with a falling tone; with no break at all, the first chunk goes
 * at FIRST_CLAUSE_MAX_WORDS complete words.
 */
export const CLAUSE_END = /[,;:\u2014\u2013]["')\]]?\s|\s[\u2014\u2013]\s/;
export const FIRST_CLAUSE_MIN_WORDS = 3;
export const FIRST_CLAUSE_MAX_WORDS = 8;
// Words only: a free-standing dash or punctuation token is not a word ("Okay — sure," is 2).
const wordCount = (s) => (s.match(/[\p{L}\p{N}][^\s]*/gu) || []).length;

/** Where the first chunk ends (index into buf), or -1 to keep waiting. */
export function firstClauseEnd(buf, { minWords = FIRST_CLAUSE_MIN_WORDS, maxWords = FIRST_CLAUSE_MAX_WORDS } = {}) {
  const s = SENTENCE_END.exec(buf);
  const sentenceEnd = s ? s.index + s[0].length : -1;
  const clauses = new RegExp(CLAUSE_END.source, "g");   // local /g copy: no shared lastIndex
  for (let m; (m = clauses.exec(buf));) {
    const end = m.index + m[0].length;
    if (sentenceEnd >= 0 && end > sentenceEnd) break;
    if (wordCount(buf.slice(0, end)) >= minWords) return end;
  }
  if (sentenceEnd >= 0) return sentenceEnd;
  // No break yet: after maxWords COMPLETE words (a trailing space proves the last one ended).
  const words = [...buf.matchAll(/\S+\s+/g)].filter((w) => /[\p{L}\p{N}]/u.test(w[0]));
  if (words.length >= maxWords) { const w = words[maxWords - 1]; return w.index + w[0].length; }
  return -1;
}

/**
 * Sentence chunker (glasses behaviour by default). opts.firstClause (kiosk): the
 * FIRST chunk is the first clause (see firstClauseEnd) so TTS starts ~half a
 * sentence earlier; every later chunk is a full sentence.
 */
export function createSentenceChunker(onSentence, { firstClause = false } = {}) {
  let buf = "";
  let first = firstClause;
  return {
    async push(text) {
      buf += text;
      if (first) {
        // Leading whitespace/newlines (after </think>, before a tool call) never use up the first-clause split.
        const lead = buf.length - buf.trimStart().length;
        if (lead === buf.length) return;
        const rel = firstClauseEnd(buf.slice(lead));
        if (rel < 0) return;
        const end = lead + rel;
        first = false;
        const chunk = buf.slice(0, end);
        buf = buf.slice(end);
        await onSentence(chunk);
      }
      for (;;) {
        const m = SENTENCE_END.exec(buf);
        if (!m) break;
        const end = m.index + m[0].length;
        const sentence = buf.slice(0, end);
        buf = buf.slice(end);
        await onSentence(sentence);
      }
    },
    async flush() {
      const rest = buf;
      buf = "";
      if (rest.trim()) await onSentence(rest);
    },
  };
}

export const CONFIRM_TTL_MS = 60_000;
const DESTRUCTIVE_EXACT = new Set([
  "crow_delete_post", "crow_delete_memory", "crow_delete_setlist",
  "crow_unpublish_post", "crow_remove_backend", "crow_dismiss_all_notifications",
]);
const DESTRUCTIVE_REGEX = /^crow_(delete|remove|destroy|unpublish)_/;
export const AFFIRMATIVE_STARTS = /^\s*(yes|yeah|yep|yup|confirmed?|do it|go ahead|proceed|ok|okay)\b/i;
export const NEGATIVE_STARTS = /^\s*(no|nope|cancel|stop|wait|nevermind|never mind)\b/i;

export function isDestructiveTool(name) {
  if (!name) return false;
  return DESTRUCTIVE_EXACT.has(name) || DESTRUCTIVE_REGEX.test(name);
}

export function describeDestructiveAction(tc) {
  const base = (tc.name || "").replace(/^crow_/, "").replace(/_/g, " ");
  const arg = tc.arguments || {};
  const ref = arg.id || arg.slug || arg.post_id || arg.memory_id || arg.setlist_id || "";
  return ref ? `${base} ${ref}` : base;
}

export function canonicalArgsHash(args) {
  const seen = new WeakSet();
  const canonical = (v) => {
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (seen.has(v)) return '"__cycle__"';
    seen.add(v);
    if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
    return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
  };
  return canonical(args || {});
}

export function createConfirmGate({ now = Date.now, ttlMs = CONFIRM_TTL_MS } = {}) {
  const pending = new Map();
  return {
    check({ deviceId, eff, args, transcript }) {
      const p = pending.get(deviceId);
      const hash = canonicalArgsHash(args);
      const yes = AFFIRMATIVE_STARTS.test(transcript || "");
      const no = NEGATIVE_STARTS.test(transcript || "");
      if (p && p.toolName === eff && p.argsHash === hash && now() - p.at < ttlMs && yes && !no) {
        pending.delete(deviceId);
        return "allow";
      }
      pending.set(deviceId, { toolName: eff, argsHash: hash, at: now() });
      return "confirm";
    },
  };
}

export function createConvoStore({ maxMessages = 24, idleMs = 15 * 60 * 1000, now = Date.now } = {}) {
  const store = new Map();
  return {
    get(id) {
      const e = store.get(id);
      if (!e) return [];
      if (now() - e.lastAt > idleMs) { store.delete(id); return []; }
      return e.messages;
    },
    save(id, messages) {
      let kept = messages.filter((m) => m.role !== "system").slice(-maxMessages);
      // DIFFERENCE from glasses: never begin on a tool result or a tool-calling
      // assistant whose user turn was trimmed away (OpenAI-compatible servers reject it).
      const firstUser = kept.findIndex((m) => m.role === "user");
      kept = firstUser < 0 ? [] : kept.slice(firstUser);
      store.set(id, { messages: kept, lastAt: now() });
    },
    clear(id) { store.delete(id); },
  };
}

/**
 * Is this transcript an STT repetition loop rather than speech (kiosk re-smoke 2026-10-07 G4: "K-P-P-P-P…",
 * "louder, louder, … and louder")? Review of rev 7 (M5): real speech repeats too ("No, no, no, no, no, no!", "Sí, sí…",
 * "very very … good", a title, "100000000"), so only: the same word eight times running; or six times running when
 * that run is most of the transcript (≥ 60 % of its words) AND at least 40 characters long; or, inside one word that is
 * not a number, a 1–3 character unit repeated twelve times or more.
 */
export function degenerateTranscript(text) {
  const words = String(text || "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  let run = 1;
  for (let i = 1; i < words.length; i++) {
    run = words[i] === words[i - 1] ? run + 1 : 1;
    if (run >= 8 || (run >= 6 && run / words.length >= 0.6 && run * (words[i].length + 1) >= 40)) return true;
  }
  return words.some((w) => w.length >= 12 && !/^\d+$/.test(w) && /(.{1,3})\1{11,}/u.test(w));
}

export function negotiatePcm(adapterName) {
  switch (adapterName) {
    case "openai-tts":
    case "kokoro":
      return { synthFormat: "pcm", codec: "pcm", sampleRate: 24000, stripHeaderBytes: 0 };
    case "elevenlabs":
      return { synthFormat: "pcm_24000", codec: "pcm", sampleRate: 24000, stripHeaderBytes: 0 };
    case "azure":
      return { synthFormat: "raw-24khz-16bit-mono-pcm", codec: "pcm", sampleRate: 24000, stripHeaderBytes: 0 };
    case "piper":
      return { synthFormat: undefined, codec: "pcm", sampleRate: 22050, stripHeaderBytes: 44 };
    default:
      return null;
  }
}

/** Buffer one sentence's synthesis, then yield 64 KB frames (glasses behaviour, ruling R15). */
export async function* pcmStream(adapter, text, voice, negotiation, { signal } = {}) {
  if (signal?.aborted) return;
  let bytesToStrip = negotiation.stripHeaderBytes || 0;
  const opts = { signal };
  if (negotiation.synthFormat) opts.format = negotiation.synthFormat;
  const parts = [];
  for await (const chunk of adapter.synthesize(text, voice, opts)) {
    if (signal?.aborted) return;
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (bytesToStrip > 0) {
      if (b.length <= bytesToStrip) { bytesToStrip -= b.length; continue; }
      parts.push(b.subarray(bytesToStrip));
      bytesToStrip = 0;
    } else {
      parts.push(b);
    }
  }
  const full = Buffer.concat(parts);
  const FRAME = 64 * 1024;
  for (let off = 0; off < full.length; off += FRAME) {
    if (signal?.aborted) return;
    yield full.subarray(off, Math.min(off + FRAME, full.length));
  }
}

export function wrapPcmAsWav(pcm, sampleRate) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
