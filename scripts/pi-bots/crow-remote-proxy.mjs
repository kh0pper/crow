#!/usr/bin/env node
/**
 * F4a Layer 2b — cross-instance forward-proxy (stdio MCP server).
 *
 * pi spawns this as a stdio MCP server (its only proven transport). It passes
 * tools/list + tools/call through verbatim to ONE paired peer's capability
 * mount, and carries NO policy of its own. On any connect failure it serves an
 * empty tool list so a turn never crashes.
 *
 * Item 46 PR-B (the operator's ruling): no pair key, signing key or peer bearer
 * is handed to a bot or pi process (a bot with an open shell can still read
 * the credential files under CROW_HOME by path: the known residual in
 * docs/architecture/instances.md), so this process never talks to the peer. It
 * connects to its own gateway's loopback relay (CROW_REMOTE_RELAY_URL,
 * servers/gateway/routes/peer-relay.js) with the path-scoped relay token read
 * from CROW_REMOTE_RELAY_TOKEN (the bot engine reads the token file outside
 * the sandbox; inside, its secrets dir is hidden) and the X-Crow-Actor-* headers the gateway
 * signed for this bot and its session (CROW_REMOTE_ACTOR_*). The gateway verifies the
 * bot, re-checks its selection, and forwards with the peer bearer, signing
 * the tools/call itself. This module must not import the peer credential
 * store, directly or transitively (tests/no-peer-key-in-bot-process.test.js).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { jsonSchemaToZodObject, SOURCE_BUDGET } from "../../servers/shared/json-schema-to-zod.js";

const CONNECT_TIMEOUT_MS = 15000;
const ACTOR_HEADERS = {
  CROW_REMOTE_ACTOR_ID: "X-Crow-Actor-Id",
  CROW_REMOTE_ACTOR_THREAD: "X-Crow-Actor-Thread",
  CROW_REMOTE_ACTOR_GATEWAY: "X-Crow-Actor-Gateway",
  CROW_REMOTE_ACTOR_SESSION: "X-Crow-Actor-Session",
  CROW_REMOTE_ACTOR_SIG: "X-Crow-Actor-Sig",
};

/** Real client factory: a StreamableHTTP client to this gateway's peer relay. */
async function defaultClientFactory() {
  const relayUrl = process.env.CROW_REMOTE_RELAY_URL || "";
  const token = String(process.env.CROW_REMOTE_RELAY_TOKEN || "").trim();
  if (!relayUrl || !token) throw new Error("crow-remote-proxy: missing CROW_REMOTE_RELAY_* env");
  const headers = { Authorization: `Bearer ${token}` };
  for (const [envName, headerName] of Object.entries(ACTOR_HEADERS)) {
    const v = process.env[envName];
    if (typeof v === "string" && v !== "") headers[headerName] = v;
  }
  const transport = new StreamableHTTPClientTransport(new URL(relayUrl), { requestInit: { headers } });
  const client = new Client({ name: "crow-remote-proxy", version: "0.2.0" });
  let timer;
  try {
    await Promise.race([
      client.connect(transport),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("connect timeout")), CONNECT_TIMEOUT_MS); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  return client;
}

/**
 * Build the passthrough server. Returns { server, listTools, callTool } where
 * listTools/callTool are the testable passthrough primitives. On connect
 * failure, listTools yields { tools: [] } and callTool rejects with a clear
 * error (no peer to forward to).
 * @param {object} [opts]
 * @param {Function} [opts.clientFactory] async () => MCP client (injectable for tests)
 */
export async function buildRemoteProxyServer({ clientFactory = defaultClientFactory } = {}) {
  let client = null;
  let connectError = null;
  try { client = await clientFactory(); }
  catch (err) { connectError = err; console.error("[crow-remote-proxy] connect failed:", err.message); }

  const listTools = async () => {
    if (!client) return { tools: [] };
    try { return await client.listTools(); }
    catch (err) { console.error("[crow-remote-proxy] listTools failed:", err.message); return { tools: [] }; }
  };
  const callTool = async (params) => {
    if (!client) throw new Error("crow-remote-proxy: peer unavailable" + (connectError ? ` (${connectError.message})` : ""));
    return client.callTool(params); // forward verbatim; peer L2a gate decides
  };

  // Register a passthrough McpServer that mirrors the peer's tools.
  const server = new McpServer({ name: "crow-remote-proxy", version: "0.1.0" });
  const { tools } = await listTools();
  const pool = { units: SOURCE_BUDGET }; // the peer's whole tool list shares one conversion budget
  for (const t of tools) {
    server.registerTool(t.name, { description: t.description || "", inputSchema: jsonSchemaToZodObject(t.inputSchema, pool) }, async (args) => {
      return callTool({ name: t.name, arguments: args || {} });
    });
  }
  return { server, listTools, callTool };
}

// CLI entrypoint: connect to the peer and serve over stdio.
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const { server } = await buildRemoteProxyServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
  })().catch((err) => { console.error("[crow-remote-proxy] fatal:", err.message); process.exit(1); });
}
