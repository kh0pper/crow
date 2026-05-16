#!/usr/bin/env node
/**
 * S4 spike — Crow Bot Builder. Minimal dependency-free MCP stdio server
 * (newline-delimited JSON-RPC 2.0, the StdioServerTransport wire format).
 *
 * Exposes two echo tools to isolate ONE variable — a JSON-Schema `pattern`:
 *   - s4_echo_pattern : param `code` has pattern "^\\d{4}-\\d{2}-\\d{2}$"
 *                       (the exact regex shape that triggered the crow-chat
 *                       --jinja GBNF scar, memory crowchat-jinja-regex-toolcall)
 *   - s4_echo_plain   : param `code` is a plain string (NO pattern) — control
 *
 * Both just echo the arg back. The question S4 answers: does pi driving the
 * LOCAL crow-local model (same :8003 llama.cpp --jinja container) tolerate the
 * `pattern` tool, or fail like crow-chat did? Cloud model = expected control.
 */
import { createInterface } from "node:readline";

const TOOLS = [
  {
    name: "s4_echo_pattern",
    description: "Echo a date code back. Call with code in YYYY-MM-DD form.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "A date YYYY-MM-DD" },
      },
      required: ["code"],
    },
  },
  {
    name: "s4_echo_plain",
    description: "Echo a code back. Call with any string code.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "Any string code" },
      },
      required: ["code"],
    },
  },
];

function send(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }

// MCP stdio = newline-delimited JSON. (This is the SERVER side; readline is
// acceptable here — only RPC-mode CLIENTS must avoid readline per pi docs.)
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const s = line.trim();
  if (!s) return;
  let msg;
  try { msg = JSON.parse(s); } catch { return; }
  const { id, method, params } = msg;

  if (method === "initialize") {
    send({ jsonrpc: "2.0", id, result: {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "s4-pattern-mcp", version: "0.1.0" },
    } });
    return;
  }
  if (method === "notifications/initialized") return; // notification, no reply
  if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    return;
  }
  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments ?? {};
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) {
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `unknown tool ${name}` }], isError: true } });
      return;
    }
    // Server-generated nonce the model CANNOT guess from the prompt — the only
    // way it ends up in the model's answer is if the tool genuinely executed.
    // Logged to stderr too (pi surfaces MCP-server stderr) so the driver has an
    // irrefutable "tool actually ran server-side" signal independent of rpc
    // event parsing.
    const nonce = "N" + Math.random().toString(16).slice(2, 10).toUpperCase();
    process.stderr.write(`[s4-pattern-mcp] INVOKED tool=${name} code=${args.code ?? "?"} nonce=${nonce}\n`);
    send({ jsonrpc: "2.0", id, result: {
      content: [{ type: "text", text: JSON.stringify({ ok: true, tool: name, echoed: args.code ?? null, nonce }) }],
      isError: false,
    } });
    return;
  }
  if (id !== undefined) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
  }
});

process.stderr.write("[s4-pattern-mcp] ready (s4_echo_pattern[pattern], s4_echo_plain[plain])\n");
