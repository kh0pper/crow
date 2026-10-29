#!/usr/bin/env node
/**
 * A tiny stdio MCP server standing in for a service's add-on in tests (project services Task 14).
 * Never prints an environment VALUE on stdout: tools answer names, lengths and sha256 hashes.
 *
 *   whoami            → {keys: sorted env key names, argc: process.argv.length, pid, cwd}
 *   envhash {name}    → {present, sha256} of that env var's value
 *   sleep {ms}        → waits, then "slept"
 *   crash             → exits at once, mid-call
 *
 * Env: ECHO_SPAWN_LOG=<file> appends this pid on start. ECHO_EXIT=1 exits at once.
 * ECHO_STDERR=1 writes every *_TOKEN / *_KEY value to stderr, the first one split across two
 * writes and the line ended later (so a reader must join chunks before redacting).
 */
import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

if (process.env.ECHO_SPAWN_LOG) appendFileSync(process.env.ECHO_SPAWN_LOG, `${process.pid}\n`);
if (process.env.ECHO_EXIT === "1") process.exit(3);

if (process.env.ECHO_STDERR === "1") {
  const values = Object.entries(process.env).filter(([k]) => /_(TOKEN|KEY)$/.test(k)).map(([, v]) => v);
  for (const v of values) {
    const half = Math.floor(v.length / 2);
    process.stderr.write(`starting with token ${v.slice(0, half)}`);
    await new Promise((r) => setTimeout(r, 30));
    process.stderr.write(`${v.slice(half)} ok\n`);
  }
  process.stderr.write("ready\n");
}

const json = (v) => ({ content: [{ type: "text", text: JSON.stringify(v) }] });
const server = new Server({ name: "echo", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "whoami", description: "Env key names and argv length", inputSchema: { type: "object", properties: {} } },
    { name: "envhash", description: "Hash of one env value", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
    { name: "sleep", description: "Wait", inputSchema: { type: "object", properties: { ms: { type: "number" } } } },
    { name: "crash", description: "Exit mid-call", inputSchema: { type: "object", properties: {} } },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  if (name === "whoami") return json({ keys: Object.keys(process.env).sort(), argc: process.argv.length, pid: process.pid, cwd: process.cwd() });
  if (name === "envhash") {
    const v = process.env[String(args.name)];
    return json({ present: typeof v === "string", sha256: typeof v === "string" ? createHash("sha256").update(v).digest("hex") : null });
  }
  if (name === "sleep") {
    await new Promise((r) => setTimeout(r, Number(args.ms) || 0));
    return json("slept");
  }
  if (name === "crash") process.exit(4);
  return { content: [{ type: "text", text: "unknown" }], isError: true };
});

await server.connect(new StdioServerTransport());
