/**
 * Pure voice-turn pieces extracted from the Meta Glasses loop
 * (bundles/meta-glasses/panel/routes.js) for the transport-free core turn
 * (kiosk spec 2026-10-03 §7.1). Behaviour is pinned to glasses by
 * tests/voice-turn-helpers.test.js. Two deliberate differences, both marked:
 * pcmStream honours an AbortSignal (barge-in), and the convo store trims to a
 * window that starts on a user message (no orphan tool result).
 */
import { isProxyCall, executedProxyArgs, normalizeExternalParams, ADDON_PROXY } from "../ai/proxy-args.js";
import { firstVerb } from "./action-claims.js";

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
// English words end at \b; Spanish ones at a space, punctuation or the end (\b fails after "í" in JS).
export const AFFIRMATIVE_STARTS = /^\s*(?:(?:yes|yeah|yep|yup|sure|confirmed?|do it|go ahead|please do|sounds good|proceed|ok|okay)\b|¡?(?:s[ií]|claro|dale|hazlo|adelante|vale|de acuerdo)(?=[\s,.!?]|$))/i;
export const NEGATIVE_STARTS = /^\s*(?:(?:no|nope|cancel|stop|wait|nevermind|never mind|forget it|i(?:'ve| have)? changed my mind)\b|¡?(?:no|espera|cancela|para|d[eé]jalo|olv[ií]dalo|(?:he cambiado|cambi[eé]) de idea)(?=[\s,.!?]|$))/i;

// A negation in the first few words ("claro que no", "of course not", "yes, no wait") is never a yes.
const NEGATION_WORDS = new Set(["no", "not", "nope", "don't", "dont", "never", "nunca", "tampoco"]);
const NEGATION_WINDOW = 4;
const leadNegated = (text) => String(text || "").toLowerCase().replace(/[\u2018\u2019]/g, "'")
  .split(/[^\p{L}']+/u).filter(Boolean).slice(0, NEGATION_WINDOW).some((w) => NEGATION_WORDS.has(w));
/** A spoken yes: starts as one, and no negation word in its first few words. */
export const isAffirmative = (text) => AFFIRMATIVE_STARTS.test(text || "") && !leadNegated(text);
/** A spoken no: starts as one, or a negation word in its first few words. */
export const isNegative = (text) => NEGATIVE_STARTS.test(text || "") || leadNegated(text);

export function isDestructiveTool(name) {
  if (!name) return false;
  return DESTRUCTIVE_EXACT.has(name) || DESTRUCTIVE_REGEX.test(name);
}

// The proxies and the arguments they really run with come from the executor's own module (one matcher).
export { isProxyCall, executedProxyArgs };
const objOf = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
// The fields the confirm question names, in order, before its id-key fallback (ID_KEY).
const NAMED_FIELDS = ["id", "slug", "post_id", "memory_id", "setlist_id", "section_key"];
// The fallback: a key ending in _id or Id, or id followed by an uppercase letter (card_id, cardId, idCard),
// never one that looks like a credential (idToken, apiKey…).
const SECRET_KEY = /(?:token|secret|key|password)$/i;
const isIdKey = (k) => /(?:_id|[a-z0-9]Id)$|^id[A-Z]/.test(k) && !SECRET_KEY.test(k);
// Who a send goes to, named for a send (SEND_VERBS: the tool name's first verb). Crow's own sends key it
// as contact (crow_send_message, crow_share) or group (crow_send_group_message).
const RECIPIENT_FIELDS = ["to", "recipient", "email", "contact", "group"];
const SEND_VERBS = new Set(["send", "reply", "post", "forward", "share"]);
// Always compared (the voice policy checks read them, asked or not), and the named fields as before.
const POLICY_FIELDS = [...NAMED_FIELDS, "delete", "task", "enabled", "cron_expression"];
// Scalars compare as strings ("3" and 3 are the same id); objects by their canonical form.
const sameValue = (a, b) => ((a === null || typeof a !== "object") && (b === null || typeof b !== "object")
  ? String(a) === String(b) : canonicalArgsHash(a) === canonicalArgsHash(b));
/**
 * A proxied call (isProxyCall) that carries a described field somewhere other than where it runs with a
 * different value, or where the run never sees it: the top level, params, or params.arguments disagreeing
 * with executedProxyArgs. The question would name one value and the tool run another; the voice gate refuses it.
 * `asking`: a confirm question will be asked, so every field it can name is compared too (each isIdKey key
 * and RECIPIENT_FIELDS); without it only POLICY_FIELDS are.
 */
export function proxyArgsConflict(tc, { asking = false } = {}) {
  if (!isProxyCall(tc)) return false;
  const top = { ...objOf(tc.arguments) };
  delete top.action;   // the proxy's own selector
  delete top.params;
  const params = objOf(objOf(tc.arguments).params);
  const layers = [top, params, objOf(params.arguments)];
  const runs = objOf(executedProxyArgs(tc));
  const fields = new Set(POLICY_FIELDS);
  if (asking) {
    for (const k of RECIPIENT_FIELDS) fields.add(k);
    for (const l of [...layers, runs]) for (const k of Object.keys(l)) if (isIdKey(k)) fields.add(k);
  }
  return [...fields].some((k) => layers.some((l) => l !== runs && l[k] !== undefined && (runs[k] === undefined || !sameValue(l[k], runs[k]))));
}
/**
 * A crow_tools call that runs on its flat top-level fields (params empty). The local executor runs those;
 * the remote route runs args.params as given ({}), so a described value may never run. The voice gate refuses
 * such a call when it would need a spoken yes.
 */
export function reliesOnFlatFallback(tc) {
  return String(tc?.name || "") === ADDON_PROXY && isProxyCall(tc) && normalizeExternalParams(tc.arguments).flat;
}

/**
 * The action the confirm question names, read ONLY from what the executor runs (executedProxyArgs). `via` is
 * the tool the model really called when it was a proxy (crow_memory, crow_tools…); without it the call is direct
 * and its own args are read. crow_update_schedule with delete: true deletes.
 */
export function describeDestructiveAction(tc, { via = null } = {}) {
  const src = objOf(executedProxyArgs({ name: via || tc.name, arguments: tc.arguments }));
  const has = (v) => v !== undefined && v !== null && v !== "";
  let name = String(tc.name || "");
  if (name === "crow_update_schedule" && (src.delete === true || src.delete === "true")) name = "crow_delete_schedule";
  if (name === "crow_notification_settings") return "change your notification settings";
  const base = name.replace(/^crow_/, "").replace(/_/g, " ");
  const scalar = (v) => (typeof v === "string" || typeof v === "number") && has(v);
  // Named fields first, then the first id-keyed field (isIdKey) with a scalar value. Never a free-text body.
  const refKey = NAMED_FIELDS.find((k) => scalar(src[k])) ?? Object.keys(src).find((k) => isIdKey(k) && scalar(src[k]));
  let out = refKey === undefined ? base : `${base} ${speakable(src[refKey])}`;
  const verb = firstVerb(name)?.verb;
  if (SEND_VERBS.has(verb)) {
    const to = RECIPIENT_FIELDS.map((k) => src[k]).map((v) => (Array.isArray(v) ? v.filter(scalar).join(", ") : v)).find(scalar);
    if (to !== undefined) out += ` ${verb === "share" ? "with" : "to"} ${speakable(to)}`;
  }
  return out;
}
// A value as the question speaks it: one line, at most QUESTION_VALUE_MAX characters, and never a double
// quote or backslash that could close the quoted 'Tell the user: "…"' frame around it.
const QUESTION_VALUE_MAX = 60;
function speakable(v) {
  const s = String(v).replace(/"/g, "'").replace(/\\/g, " ").replace(/\s+/g, " ").trim();
  return s.length > QUESTION_VALUE_MAX ? `${s.slice(0, QUESTION_VALUE_MAX - 1)}…` : s;
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
      const yes = isAffirmative(transcript);
      const no = isNegative(transcript);
      if (p && p.toolName === eff && p.argsHash === hash && now() - p.at < ttlMs && yes && !no) {
        pending.delete(deviceId);
        return "allow";
      }
      pending.set(deviceId, { toolName: eff, argsHash: hash, at: now() });
      return "confirm";
    },
    /** Is this very call (name + canonical args) waiting for a yes on this device? A read: nothing changes. */
    has({ deviceId, eff, args }) {
      const p = pending.get(deviceId);
      return !!p && p.toolName === eff && p.argsHash === canonicalArgsHash(args) && now() - p.at < ttlMs;
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
