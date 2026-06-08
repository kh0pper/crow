#!/usr/bin/env node
/**
 * F4a Layer 2b — cross-instance forward-proxy (stdio MCP server).
 *
 * pi spawns this as a stdio MCP server (its only proven transport). It connects
 * an MCP client to ONE peer capability mount (CROW_REMOTE_GATEWAY_URL +
 * CROW_REMOTE_MOUNT + /mcp) using the Bearer peer token from peer-tokens.json,
 * and passes tools/list + tools/call through verbatim. It carries NO policy:
 * the peer's L2a exposure gate is the authoritative allow/deny. On any connect
 * failure it serves an empty tool list so a turn never crashes.
 *
 * Reuses the auth pattern from servers/gateway/proxy.js connectToRemoteInstance.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getPeerCreds } from "../../servers/shared/peer-credentials.js";
import { jsonSchemaPropertiesToZod } from "../../servers/shared/json-schema-to-zod.js";

const CONNECT_TIMEOUT_MS = 15000;

/** Real client factory: authenticated StreamableHTTP client to the peer mount. */
async function defaultClientFactory() {
  const instanceId = process.env.CROW_REMOTE_INSTANCE_ID;
  const gatewayUrl = (process.env.CROW_REMOTE_GATEWAY_URL || "").replace(/\/$/, "");
  const mount = process.env.CROW_REMOTE_MOUNT || "";
  if (!instanceId || !gatewayUrl || !mount) throw new Error("crow-remote-proxy: missing CROW_REMOTE_* env");
  const creds = getPeerCreds(instanceId);
  if (!creds || !creds.auth_token) throw new Error(`crow-remote-proxy: no peer token for ${instanceId}`);
  const url = new URL(`${gatewayUrl}${mount}/mcp`);
  const requestInit = { headers: { Authorization: `Bearer ${creds.auth_token}` } };
  const transport = new StreamableHTTPClientTransport(url, { requestInit });
  const client = new Client({ name: "crow-remote-proxy", version: "0.1.0" });
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
  for (const t of tools) {
    server.tool(t.name, t.description || "", jsonSchemaPropertiesToZod(t.inputSchema), async (args) => {
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
