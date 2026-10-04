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

export function createSentenceChunker(onSentence) {
  let buf = "";
  return {
    async push(text) {
      buf += text;
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
