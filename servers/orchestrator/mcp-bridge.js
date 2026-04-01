/**
 * MCP Bridge — connects Crow MCP servers to open-multi-agent's ToolRegistry.
 *
 * Replicates the createInProcessClient() pattern from gateway/ai/tool-executor.js
 * but registers every discovered tool into an open-multi-agent ToolRegistry
 * instead of dispatching through category-level wrappers.
 *
 * Each MCP tool becomes a ToolDefinition with:
 *   - z.any() as the Zod schema (passthrough — MCP servers validate their own inputs)
 *   - rawInputSchema set to the MCP tool's original JSON Schema (sent to the LLM)
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

// Crow server factories
import { createMemoryServer } from "../memory/server.js";
import { createProjectServer } from "../research/server.js";
import { createSharingServer } from "../sharing/server.js";
import { createBlogServer } from "../blog/server.js";

/**
 * Server factories to bridge.  Matches the gateway's SERVER_FACTORIES.
 * Storage is omitted (optional, requires MINIO_ENDPOINT).
 */
const SERVER_FACTORIES = {
  memory: createMemoryServer,
  projects: createProjectServer,
  sharing: createSharingServer,
  blog: createBlogServer,
};

/**
 * Create an in-process MCP Client connected to a server factory.
 * Same pattern as gateway/ai/tool-executor.js lines 41-48.
 *
 * @param {string} name - Category name (for logging/client ID).
 * @param {Function} serverFactory - Factory function that returns an McpServer.
 * @returns {{ client: Client, server: McpServer }}
 */
async function createInProcessClient(name, serverFactory) {
  const server = serverFactory();
  const client = new Client({ name: `bridge-${name}`, version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

/**
 * Connect to a single MCP server and return its tool definitions.
 *
 * @param {string} name - Category name.
 * @param {Function} serverFactory - Factory function.
 * @returns {{ client: Client, tools: Array<{ name, description, inputSchema }> }}
 */
async function connectServer(name, serverFactory) {
  const { client } = await createInProcessClient(name, serverFactory);
  const { tools } = await client.listTools();
  return { client, tools };
}

/**
 * Register all tools from all Crow MCP servers into an open-multi-agent
 * ToolRegistry.
 *
 * Each MCP tool is registered with:
 *   - z.any() as inputSchema (passthrough — no client-side validation)
 *   - rawInputSchema set to the tool's real JSON Schema from the MCP server
 *   - execute() calls the MCP server via client.callTool()
 *
 * @param {import('open-multi-agent').ToolRegistry} registry - Target registry.
 * @param {Object} [options]
 * @param {string[]} [options.categories] - Subset of categories to bridge.
 *   Defaults to all categories in SERVER_FACTORIES.
 * @returns {{ clients: Map<string, Client>, toolCount: number }}
 */
export async function registerCrowTools(registry, options = {}) {
  const categories = options.categories || Object.keys(SERVER_FACTORIES);
  const clients = new Map();
  let toolCount = 0;

  for (const category of categories) {
    const factory = SERVER_FACTORIES[category];
    if (!factory) {
      console.warn(`[mcp-bridge] Unknown category: ${category}, skipping`);
      continue;
    }

    try {
      const { client, tools } = await connectServer(category, factory);
      clients.set(category, client);

      for (const tool of tools) {
        // MCP listTools() returns: { name, description?, inputSchema }
        // inputSchema is already JSON Schema (type: "object", properties: ...)
        const toolName = tool.name;
        const description = tool.description || `${category} tool: ${toolName}`;
        const rawSchema = tool.inputSchema || { type: "object", properties: {} };

        registry.register({
          name: toolName,
          description,
          inputSchema: z.any(),
          rawInputSchema: rawSchema,
          execute: async (input) => {
            try {
              const result = await client.callTool({
                name: toolName,
                arguments: input || {},
              });

              // Extract text from MCP result content blocks
              let text = "";
              if (result.content) {
                for (const block of result.content) {
                  if (block.type === "text") {
                    text += block.text;
                  }
                }
              }

              return {
                data: text || "(empty result)",
                isError: result.isError || false,
              };
            } catch (err) {
              return {
                data: `Tool execution error: ${err.message}`,
                isError: true,
              };
            }
          },
        });

        toolCount++;
      }

      console.log(`[mcp-bridge] ${category}: ${tools.length} tools registered`);
    } catch (err) {
      console.error(`[mcp-bridge] ${category}: failed — ${err.message}`);
    }
  }

  return { clients, toolCount };
}

/**
 * Register tools from remote Crow instances into the ToolRegistry.
 * Remote tools are namespaced as "{instanceName}:{toolName}".
 *
 * @param {import('open-multi-agent').ToolRegistry} registry - Target registry.
 * @param {Map} connectedServers - Remote instance map from proxy.js.
 * @param {Object} [options]
 * @param {string[]} [options.instances] - Filter to specific instance names.
 * @returns {{ toolCount: number }}
 */
export async function registerRemoteTools(registry, connectedServers, options = {}) {
  let toolCount = 0;

  for (const [key, entry] of connectedServers) {
    if (!entry.isRemote || entry.status !== "connected" || !entry.client) continue;

    const instanceName = entry.instanceName || entry.instanceId || key;

    // Optional instance filter
    if (options.instances && !options.instances.includes(instanceName)) continue;

    for (const tool of entry.tools || []) {
      const namespacedName = `${instanceName}:${tool.name}`;
      const description = `[${instanceName}] ${tool.description || tool.name}`;
      const rawSchema = tool.inputSchema || { type: "object", properties: {} };

      registry.register({
        name: namespacedName,
        description,
        inputSchema: z.any(),
        rawInputSchema: rawSchema,
        execute: async (input) => {
          try {
            const result = await entry.client.callTool({
              name: tool.name,
              arguments: input || {},
            });

            let text = "";
            if (result.content) {
              for (const block of result.content) {
                if (block.type === "text") text += block.text;
              }
            }

            return {
              data: text || "(empty result)",
              isError: result.isError || false,
            };
          } catch (err) {
            return {
              data: `Remote tool error (${instanceName}): ${err.message}`,
              isError: true,
            };
          }
        },
      });

      toolCount++;
    }

    if ((entry.tools || []).length > 0) {
      console.log(`[mcp-bridge] ${instanceName} (remote): ${entry.tools.length} tools registered`);
    }
  }

  return { toolCount };
}
