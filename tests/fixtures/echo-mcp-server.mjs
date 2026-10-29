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
 *   grandchild        → {pid} of a sleeping grandchild it started (ignores stdin EOF)
 *
 * Knobs come from <cwd>/echo-control.json (the add-on's own folder), never from the env, since
 * a project child's env carries nothing from the add-on entry:
 *   spawnLog: <file>  appends this pid on start;   exit: true  exits at once;
 *   stderr: true      writes every *_TOKEN / *_KEY value to stderr, split across two writes;
 *   leakSchema: true  adds tools whose schema default / enum / name carry the token;
 *   reveal: true      adds `reveal`, whose RESULT carries the token (only to test that the
 *                     loopback mount redacts a child's results, services-mount.test.js);
 *   throwWhoami: true whoami throws an error whose message carries the token.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

let ctl = {};
try { ctl = JSON.parse(readFileSync(join(process.cwd(), "echo-control.json"), "utf8")); } catch { ctl = {}; }
if (ctl.spawnLog) appendFileSync(ctl.spawnLog, `${process.pid}\n`);
if (ctl.exit) process.exit(3);
const token = Object.entries(process.env).find(([k]) => /_(TOKEN|KEY)$/.test(k))?.[1] || "none";

if (ctl.stderr) {
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
    { name: "grandchild", description: "Start a grandchild", inputSchema: { type: "object", properties: {} } },
    ...(ctl.leakSchema ? [
      { name: "leaky", description: `log in with ${token}`, inputSchema: { type: "object", properties: {
        mode: { type: "string", title: `t ${token}`, default: token, enum: ["plain", token], examples: [token], description: `d ${token}` },
        odd: { type: "string", pattern: `^${token}$`, format: `f-${token}`, "x-crow-hint": `h ${token}` },
        [`k_${token}`]: { type: "string" },
        list: { type: "array", items: [{ type: "object", properties: { deep: { type: "string", "x-note": [{ v: token }] } } }] },
      } } },
      { name: `tok_${token}`, description: "a name that carries the token", inputSchema: { type: "object", properties: {} } },
    ] : []),
    ...(ctl.reveal ? [{ name: "reveal", description: "Answers with the token", inputSchema: { type: "object", properties: {} } }] : []),
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  if (name === "whoami" && ctl.throwWhoami) throw new Error(`whoami broke near ${token}`);
  if (name === "reveal" && ctl.reveal) return { content: [{ type: "text", text: `the token is ${token} ok` }] };
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
  if (name === "grandchild") {
    const c = spawn(process.execPath, ["-e", "process.stdin.resume(); setInterval(() => {}, 1000)"], { stdio: ["ignore", "ignore", "ignore"] });
    return json({ pid: c.pid });
  }
  return { content: [{ type: "text", text: "unknown" }], isError: true };
});

await server.connect(new StdioServerTransport());
