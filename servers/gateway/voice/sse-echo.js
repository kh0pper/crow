/**
 * The context-echo guard for a model reply relayed over HTTP (the /llm/v1 router's companion turns).
 *
 * The router puts [Now] (and, when a day is named, [Dates]) plus the [Note] line on the companion's user message
 * (context-echo.js withTurnContext). A small model sometimes reads those lines back as the start of its answer.
 * This filter rewrites ONLY a string `choices[0].delta.content` of an OpenAI-style SSE stream through one
 * createContextEchoGate(); every other event — the role frame (content null), tool_call deltas, reasoning_content,
 * usage, `[DONE]`, comments, anything that is not JSON — passes through byte for byte, and so does a content frame
 * the gate left unchanged. Text the gate is still holding is emitted as a synthetic chunk (copying id, object,
 * created, model and the choice index) before the first frame carrying a finish_reason or a tool_calls delta, before
 * `[DONE]`, or at the end of the stream. Tool-call arguments are not rewritten (accepted risk; the kiosk path uses stripContextEchoDeep).
 */
import { createContextEchoGate, stripContextEcho, TURN_CONTEXT_NOTE } from "./context-echo.js";

const EVENT_END = /\r?\n\r?\n/;

/** The joined data: payload of one SSE event, or null when it carries none. */
function dataOf(event) {
  const lines = event.split(/\r?\n/).filter((l) => l.startsWith("data:"));
  if (!lines.length) return null;
  return lines.map((l) => l.slice(5).replace(/^ /, "")).join("\n");
}

/**
 * contexts: the injected context text(s). → { write(chunk: string|Buffer) → string, end() → string }.
 * Feed every upstream chunk to write() and send what it returns; send end()'s return when the upstream ends.
 */
export function createSseEchoFilter(contexts) {
  const gate = createContextEchoGate([...(contexts || []), TURN_CONTEXT_NOTE]);
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  let held = false;             // the gate has been fed since its last flush
  let template = null;          // the last content chunk (for a synthetic flush frame)
  let nl = "\n";

  function flushFrame() {
    if (!held) return "";
    held = false;
    const text = gate.flush();
    if (!text) return "";
    const t = template || {};
    const chunk = {};
    for (const k of ["id", "object", "created", "model"]) if (t[k] !== undefined) chunk[k] = t[k];
    if (chunk.object === undefined) chunk.object = "chat.completion.chunk";
    chunk.choices = [{ index: t.choices?.[0]?.index ?? 0, delta: { content: text }, finish_reason: null }];
    return `data: ${JSON.stringify(chunk)}${nl}${nl}`;
  }

  function onEvent(raw) {
    const data = dataOf(raw);
    if (data === null) return raw;
    if (data.trim() === "[DONE]") return flushFrame() + raw;
    let obj;
    try { obj = JSON.parse(data); } catch { return raw; }
    if (!Array.isArray(obj?.choices)) return raw;
    const choice = obj.choices[0];
    // A finish_reason or a tool_calls delta closes the text: held text goes out before it, never after.
    const closes = obj.choices.some((c) => c && (c.finish_reason != null || c.delta?.tool_calls));
    if (!choice || typeof choice.delta?.content !== "string") return (closes ? flushFrame() : "") + raw;
    template = obj;
    const content = choice.delta.content;
    // A content frame that also closes the text carries the gate's rest itself.
    let safe = gate.feed(content);
    if (closes) { safe += gate.flush(); held = false; } else held = true;
    if (safe === content) return raw;
    choice.delta.content = safe;
    return `data: ${JSON.stringify(obj)}${nl}${nl}`;
  }

  function drain() {
    let out = "";
    for (;;) {
      const m = EVENT_END.exec(buf);
      if (!m) break;
      const raw = buf.slice(0, m.index + m[0].length);
      if (m[0].startsWith("\r")) nl = "\r\n"; else nl = "\n";
      buf = buf.slice(raw.length);
      out += onEvent(raw);
    }
    return out;
  }

  return {
    write(chunk) {
      buf += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      return drain();
    },
    end() {
      buf += decoder.decode();
      let out = drain();
      if (buf) { out += buf.trim() ? onEvent(buf) : buf; buf = ""; }
      return out + flushFrame();
    },
  };
}

/** A non-stream chat.completion body (text): the echo removed from each choice's message.content; else as is. */
export function stripJsonEcho(bodyText, contexts) {
  let obj;
  try { obj = JSON.parse(bodyText); } catch { return bodyText; }
  if (!Array.isArray(obj?.choices)) return bodyText;
  const all = [...(contexts || []), TURN_CONTEXT_NOTE];
  let changed = false;
  for (const c of obj.choices) {
    const content = c?.message?.content;
    if (typeof content !== "string") continue;
    const s = stripContextEcho(content, all);
    if (s !== content) { c.message.content = s; changed = true; }
  }
  return changed ? JSON.stringify(obj) : bodyText;
}
