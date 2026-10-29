/**
 * Queue item 38a, end to end: a bot that selects a remote peer capability gets
 * that capability's tool in its model request, and a call through it reaches
 * the peer. Real code: bridge.mjs buildToolsCsv, remote-blocks.mjs
 * mintRemoteBlocks, crow-remote-proxy.mjs, pi-lab extensions/mcp-client.ts and
 * the pi CLI (--mode rpc). Fakes: a loopback stand-in for the gateway's peer
 * relay (item 46 PR-B: the proxy never talks to a peer itself) serving
 * /peer-relay/<peer>/memory/mcp behind the relay-token check, and a loopback
 * OpenAI-compatible model that records each request's tools and answers the
 * first one with a call to the remote tool.
 *
 * Runs only where a pi CLI (pi_resolver ladder) and a pi-lab checkout
 * (pi-lab-compat findPiLabDir, or PIBOT_PI_LAB_DIR) both exist — CI has
 * neither and skips. Set PIBOT_PI_LAB_DIR to pin a known pi-lab checkout;
 * otherwise this runs whatever the operator's pi-lab has checked out.
 * Everything pi touches lives in one mkdtemp dir: HOME, PI_CODING_AGENT_DIR,
 * CROW_HOME, the session dir and the .mcp.json. The pi child runs in its own
 * process group and is killed with it.
 *
 * Scope: only pi-lab's mcp-client is loaded (--no-extensions -e), with file
 * delivery. It proves registration, the --tools match and the router call
 * path; it does NOT exercise permission-gating (policy.confirm matches the
 * gateway name for every router action — see the PR notes). Re-run it after
 * any pi or pi-lab upgrade: tests/helpers/pi-tool-names.mjs is the offline
 * mirror CI relies on.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { resolvePiCli } from "../scripts/pi-bots/pi_resolver.mjs";
import { findPiLabDir } from "../scripts/pi-bots/pi-lab-compat.mjs";

const REPO = resolve(import.meta.dirname, "..");
const pi = resolvePiCli();
const piLab = findPiLabDir();
const MCP_CLIENT = piLab ? join(piLab, "extensions", "mcp-client.ts") : null;
const skip = !pi ? "no pi CLI on this host"
  : !MCP_CLIENT || !existsSync(MCP_CLIENT) ? "no pi-lab checkout on this host"
  : !existsSync(join(piLab, "node_modules")) ? "pi-lab has no node_modules"
  : false;

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "remote-tools-pi-")));
const servers = [];
let child = null;
after(async () => {
  if (child && child.exitCode === null) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
  await Promise.all(servers.map((s) => new Promise((r) => s.close(() => r()))));
  rmSync(scratch, { recursive: true, force: true });
});

const listen = (srv) => new Promise((r) => { servers.push(srv); srv.listen(0, "127.0.0.1", () => r(srv.address().port)); });

test("a selected remote capability reaches the pi bot's model, and a call through it reaches the peer", { skip, timeout: 120_000 }, async () => {
  // Every path pi or the proxy can write under is inside the scratch dir.
  const home = join(scratch, "home"), agentDir = join(scratch, "agent"), crowHome = join(scratch, "crowhome");
  const botDir = join(scratch, "bot"), sessions = join(botDir, "sessions");
  for (const d of [home, agentDir, crowHome, sessions]) mkdirSync(d, { recursive: true });
  for (const p of [home, agentDir, crowHome, botDir]) assert.ok(p.startsWith(scratch + "/") && !/\/\.crow/.test(p));

  // Fake relay: /peer-relay/<peer>/memory/mcp, stateless, relay-token-checked; records tool calls.
  const TOKEN = "fake-relay-token-not-a-secret";
  const PEER_ID = "abcdef1234567890fakepeer";
  const peerCalls = [];
  const peerPort = await listen(http.createServer(async (req, res) => {
    if (!req.url.startsWith(`/peer-relay/${PEER_ID}/memory/mcp`)) { res.writeHead(404); return res.end(); }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401); return res.end(); }
    let body = ""; for await (const c of req) body += c;
    const s = new McpServer({ name: "fake-peer-memory", version: "0.0.1" });
    s.tool("crow_store_memory", "fake store", { content: z.string() }, async ({ content }) => {
      peerCalls.push(content); return { content: [{ type: "text", text: "stored" }] };
    });
    s.tool("crow_search_memories", "fake search", { query: z.string() }, async () => ({ content: [{ type: "text", text: "none" }] }));
    const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await s.connect(t);
    await t.handleRequest(req, res, body ? JSON.parse(body) : undefined);
  }));

  const REMOTE_TOOL = "mcp__crow-remote-abcdef12-crow-memory";

  // Fake model: request 1 → call the remote gateway tool; later → plain text.
  const modelRequests = [];
  const modelPort = await listen(http.createServer(async (req, res) => {
    let body = ""; for await (const c of req) body += c;
    if (!req.url.endsWith("/chat/completions")) { res.writeHead(404); return res.end(); }
    const j = JSON.parse(body || "{}");
    modelRequests.push((j.tools || []).map((t) => t.function?.name || t.name));
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (o) => res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", model: "fake-model", ...o })}\n\n`);
    if (modelRequests.length === 1) {
      chunk({ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function",
        function: { name: REMOTE_TOOL, arguments: JSON.stringify({ action: "call", tool: "crow_store_memory", args: { content: "from-the-bot" } }) } }] }, finish_reason: null }] });
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
    } else {
      chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] });
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    }
    res.end("data: [DONE]\n\n");
  }));

  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { fake: {
    baseUrl: `http://127.0.0.1:${modelPort}/v1`, api: "openai-completions", apiKey: "none",
    models: [{ id: "fake-model", name: "fake", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 1000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
  const relayTokenPath = join(crowHome, "peer-relay-token");
  writeFileSync(relayTokenPath, TOKEN, { mode: 0o600 });

  const { buildToolsCsv } = await import("../scripts/pi-bots/bridge.mjs");
  const { mintRemoteBlocks } = await import("../scripts/pi-bots/remote-blocks.mjs");
  const def = { tools: { pi_builtin: ["read"], crow_mcp: [], remote_mcp: [`${PEER_ID}::crow-memory`] } };
  const { csv } = buildToolsCsv(def, { resolved: { provider: "fake", model: "fake-model" }, remoteEnabled: true });
  const { blocks, warnings } = mintRemoteBlocks(def, {
    peerGatewayUrls: { [PEER_ID]: "http://127.0.0.1:9" },
    proxyPath: join(REPO, "scripts", "pi-bots", "crow-remote-proxy.mjs"),
    node: process.execPath,
    relayBaseUrl: `http://127.0.0.1:${peerPort}`,
    relayTokenPath,
  });
  assert.deepEqual(warnings, []);
  assert.ok(csv.split(",").includes(REMOTE_TOOL), csv);
  const mcpPath = join(botDir, ".mcp.json");
  writeFileSync(mcpPath, JSON.stringify({ mcpServers: blocks }), { mode: 0o600 });

  child = spawn(process.execPath, [pi.cliPath, "--mode", "rpc", "--no-approve", "--no-extensions", "-e", MCP_CLIENT,
    "--provider", "fake", "--model", "fake-model", "--session-dir", sessions, "--tools", csv], {
    cwd: botDir, detached: true, stdio: ["pipe", "pipe", "pipe"],
    // A minimal env: no operator PI_* / PIBOT_* / CROW_* value leaks in.
    env: { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: agentDir, CROW_HOME: crowHome, PI_BOT_MCP_CONFIG: mcpPath },
  });
  let stderr = ""; child.stderr.on("data", (d) => { stderr += d; });
  const ended = await new Promise((res) => {
    let buf = "";
    const timer = setTimeout(() => res("timeout"), 90_000);
    child.stdout.on("data", (d) => {
      buf += d; let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        try { if (JSON.parse(line).type === "agent_end") { clearTimeout(timer); res("agent_end"); } } catch {}
      }
    });
    child.once("exit", () => { clearTimeout(timer); res("exit"); });
    child.stdin.write(JSON.stringify({ type: "prompt", message: "store a memory" }) + "\n");
  });
  try { process.kill(-child.pid, "SIGKILL"); } catch {}

  const diag = `ended=${ended} requests=${JSON.stringify(modelRequests)} stderr=${stderr.slice(-800)}`;
  assert.equal(ended, "agent_end", diag);
  assert.ok(modelRequests.length >= 2, diag);
  assert.deepEqual([...modelRequests[0]].sort(), [REMOTE_TOOL, "read"].sort(), "the model is offered the remote gateway tool: " + diag);
  assert.deepEqual(peerCalls, ["from-the-bot"], "the call through the gateway tool reached the peer: " + diag);
});
