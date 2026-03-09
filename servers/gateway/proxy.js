/**
 * MCP Proxy — Spawns external MCP servers and re-exposes their tools.
 *
 * Pattern: For each configured integration with valid env vars, spawn it as a
 * child process, connect via StdioClientTransport, discover its tools, and
 * register proxy tools on a combined McpServer that the gateway serves over HTTP.
 */

import { spawn } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { INTEGRATIONS, isIntegrationConfigured, getSpawnEnv } from "./integrations.js";

// Track connected servers for health checks and router access
const connectedServers = new Map(); // id → { client, process, tools }
export { connectedServers };

/**
 * Convert a JSON Schema property definition to a Zod schema.
 * Handles the common types MCP tools use.
 */
function jsonSchemaToZod(prop) {
  if (!prop) return z.string();

  // Handle anyOf (often used for nullable types)
  if (prop.anyOf) {
    const nonNull = prop.anyOf.filter((s) => s.type !== "null");
    if (nonNull.length === 1) {
      const inner = jsonSchemaToZod(nonNull[0]);
      return inner.optional();
    }
    return z.any();
  }

  switch (prop.type) {
    case "string":
      if (prop.enum) return z.enum(prop.enum);
      return z.string();
    case "number":
    case "integer":
      return z.number();
    case "boolean":
      return z.boolean();
    case "array":
      return z.array(prop.items ? jsonSchemaToZod(prop.items) : z.any());
    case "object":
      return z.record(z.any());
    default:
      return z.any();
  }
}

/**
 * Convert a JSON Schema "properties" + "required" into a Zod object shape.
 */
function jsonSchemaPropertiesToZod(schema) {
  if (!schema || !schema.properties) return {};

  const shape = {};
  const required = new Set(schema.required || []);

  for (const [key, prop] of Object.entries(schema.properties)) {
    let zodProp = jsonSchemaToZod(prop);
    if (prop.description) zodProp = zodProp.describe(prop.description);
    if (!required.has(key)) zodProp = zodProp.optional();
    shape[key] = zodProp;
  }
  return shape;
}

/**
 * Spawn a single external server, connect, and discover its tools.
 * Returns { client, childProcess, tools } or null on failure.
 */
async function connectToServer(integration) {
  const spawnEnv = getSpawnEnv(integration);
  const env = {
    ...process.env,
    ...spawnEnv,
  };

  // Support argsTransform for servers that need env values in args (e.g., Render bearer token)
  const args = integration.argsTransform
    ? integration.argsTransform(spawnEnv)
    : integration.args;

  // Timeout: npx/uvx may need to download packages on first run
  const CONNECT_TIMEOUT_MS = 60_000;

  try {
    const transport = new StdioClientTransport({
      command: integration.command,
      args,
      env,
    });

    const client = new Client({
      name: `crow-proxy-${integration.id}`,
      version: "0.1.0",
    });

    // Race the connection against a timeout
    await Promise.race([
      client.connect(transport),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Connection timed out (60s)")), CONNECT_TIMEOUT_MS)
      ),
    ]);

    // Discover tools
    const { tools } = await client.listTools();

    console.log(`  [proxy] ${integration.name}: connected, ${tools.length} tools discovered`);

    connectedServers.set(integration.id, {
      client,
      tools,
      status: "connected",
    });

    // Handle unexpected disconnection
    transport.onclose = () => {
      console.warn(`  [proxy] ${integration.name}: disconnected`);
      const entry = connectedServers.get(integration.id);
      if (entry) entry.status = "disconnected";
    };

    return { client, tools };
  } catch (error) {
    console.error(`  [proxy] ${integration.name}: failed to connect — ${error.message}`);
    connectedServers.set(integration.id, {
      client: null,
      tools: [],
      status: "error",
      error: error.message,
    });
    return null;
  }
}

/**
 * Create a combined McpServer that proxies tools from all connected external servers.
 * Call this once at gateway startup; it spawns all configured servers.
 */
export async function initProxyServers() {
  const configured = INTEGRATIONS.filter(isIntegrationConfigured);

  if (configured.length === 0) {
    console.log("[proxy] No external integrations configured — /tools/mcp will have no tools.");
    return;
  }

  console.log(`[proxy] Starting ${configured.length} external server(s)...`);

  // Connect to all servers in parallel
  const results = await Promise.allSettled(
    configured.map((integration) => connectToServer(integration))
  );

  const successCount = results.filter(
    (r) => r.status === "fulfilled" && r.value !== null
  ).length;

  console.log(`[proxy] ${successCount}/${configured.length} server(s) connected.`);
}

/**
 * Create a new McpServer instance with proxy tools for all connected servers.
 * Called per-session by the gateway's MCP handler.
 */
export function createProxyServer() {
  const server = new McpServer({
    name: "crow-tools",
    version: "0.1.0",
  });

  // Register proxy tools for each connected server
  for (const [integrationId, entry] of connectedServers) {
    if (entry.status !== "connected" || !entry.client) continue;

    for (const tool of entry.tools) {
      const zodShape = jsonSchemaPropertiesToZod(tool.inputSchema);

      server.tool(
        tool.name,
        tool.description || `Tool from ${integrationId}`,
        zodShape,
        async (args) => {
          try {
            const result = await entry.client.callTool({
              name: tool.name,
              arguments: args,
            });
            return result;
          } catch (error) {
            return {
              content: [
                {
                  type: "text",
                  text: `Error calling ${tool.name}: ${error.message}`,
                },
              ],
              isError: true,
            };
          }
        }
      );
    }
  }

  return server;
}

/**
 * Get status of all integrations for the /health and /setup endpoints.
 */
export function getProxyStatus() {
  return INTEGRATIONS.map((integration) => {
    const configured = isIntegrationConfigured(integration);
    const entry = connectedServers.get(integration.id);

    return {
      id: integration.id,
      name: integration.name,
      description: integration.description,
      configured,
      status: entry?.status || (configured ? "pending" : "not_configured"),
      toolCount: entry?.tools?.length || 0,
      error: entry?.error || null,
      envVars: integration.envVars,
      keyUrl: integration.keyUrl,
      keyInstructions: integration.keyInstructions,
    };
  });
}
