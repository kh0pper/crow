/**
 * Reads a pi-style JSONL session log into ordered tool-call / tool-result / text events plus the
 * bot's final answer text. Pure: no file or env access, so a replayed log and a live one parse
 * the same way.
 *
 * Log shape: one header line, then lines like {"type":"message","message":{role, content:[...]}}.
 * Assistant content blocks are text, thinking or toolCall {id, name, arguments}; a
 * role:"toolResult" message carries toolCallId, toolName, content:[{type:"text",text}], isError.
 * Lines whose type is not "message" (header, model or thinking-level changes) and thinking
 * blocks are skipped. A bare message line (no "type":"message" wrapper) is a format error, not an
 * empty log: it sets parse_ok false so a mis-written log cannot pass with zero events.
 */

export const TOOL_PREFIX = "mcp__crow-projects__";

/**
 * Splits a raw tool name into its MCP server and tool. The pi spelling is
 * mcp__<server>__<tool>; the server block is read tolerantly. A bare crow_* name belongs to the
 * crow-projects server; anything else (bash, read) has no server.
 */
export function toolName(raw) {
  const name = String(raw ?? "");
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  if (m) return { server: m[1], tool: m[2] };
  if (name.startsWith("crow_")) return { server: "crow-projects", tool: name };
  return { server: null, tool: name };
}

const textOf = (content) => (Array.isArray(content) ? content : [])
  .filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");

/**
 * @param {string} jsonl
 * @returns {{parse_ok: boolean, events: object[], prose: string, no_prose: boolean}}
 */
export function parseSession(jsonl) {
  let parse_ok = true;
  const events = [];
  const calls = new Map();
  let msg = -1;
  let sawMessage = false;
  for (const line of String(jsonl ?? "").split("\n")) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { parse_ok = false; continue; }
    if (!obj || typeof obj !== "object") { parse_ok = false; continue; }
    if (obj.type !== "message") {
      if (obj.role !== undefined && obj.type === undefined) parse_ok = false; // unwrapped message line
      continue;
    }
    const m = obj.message;
    if (!m || typeof m !== "object") { parse_ok = false; continue; }
    sawMessage = true;
    if (m.role === "assistant") {
      msg += 1;
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (!b || typeof b !== "object") continue;
        if (b.type === "toolCall") {
          const ev = { i: events.length, kind: "call", msg, id: b.id, ...toolName(b.name), args: b.arguments ?? {} };
          events.push(ev);
          calls.set(b.id, ev);
        } else if (b.type === "text" && typeof b.text === "string") {
          events.push({ i: events.length, kind: "text", msg, text: b.text });
        }
      }
    } else if (m.role === "toolResult") {
      const call = calls.get(m.toolCallId);
      if (!call) { parse_ok = false; continue; }
      events.push({ i: events.length, kind: "result", msg: call.msg, id: call.id, tool: call.tool, server: call.server,
        text: textOf(m.content), isError: m.isError === true });
    }
  }
  if (!sawMessage) parse_ok = false; // nothing readable: never a silent empty pass
  let lastResult = -1;
  for (const e of events) if (e.kind === "result") lastResult = e.i;
  const prose = events.filter((e) => e.kind === "text" && e.i > lastResult).map((e) => e.text).join("\n\n");
  return { parse_ok, events, prose, no_prose: prose === "" };
}
