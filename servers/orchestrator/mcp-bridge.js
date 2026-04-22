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
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { createGoogleOAuthProvider } from "./oauth-client-provider.js";

// Crow server factories
import { createMemoryServer } from "../memory/server.js";
import { createProjectServer } from "../research/server.js";
import { createSharingServer } from "../sharing/server.js";
import { createBlogServer } from "../blog/server.js";

function resolveCrowHome() {
  return process.env.CROW_HOME || join(homedir(), ".crow");
}

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

/**
 * Register MCP addon bundles (from <crow-home>/mcp-addons.json) into the
 * same ToolRegistry that registerCrowTools populates. Each addon is spawned
 * as a stdio child; its listTools() output is bridged one tool at a time.
 *
 * Used by the subprocess pipeline runner so bundle tools (e.g. tasks_*) are
 * reachable to single-agent presets that would otherwise only see crow_*
 * tools. Mirrors connectAddonServer() in gateway/proxy.js but registers
 * into open-multi-agent's ToolRegistry instead of the gateway's proxy map.
 *
 * @param {import('open-multi-agent').ToolRegistry} registry
 * @param {Object} [options]
 * @param {string[]} [options.include] - Only bridge these addon ids. Omit for all.
 * @returns {{ clients: Map<string, Client>, transports: Map<string, StdioClientTransport>, toolCount: number }}
 */
export async function registerAddonTools(registry, options = {}) {
  const mcpAddonsPath = join(resolveCrowHome(), "mcp-addons.json");
  const clients = new Map();
  const transports = new Map();
  let toolCount = 0;

  if (!existsSync(mcpAddonsPath)) return { clients, transports, toolCount };

  let addons;
  try {
    addons = JSON.parse(readFileSync(mcpAddonsPath, "utf8"));
  } catch (err) {
    console.warn(`[mcp-bridge] addons: unreadable mcp-addons.json — ${err.message}`);
    return { clients, transports, toolCount };
  }

  const entries = Object.entries(addons).filter(
    ([id]) => !options.include || options.include.includes(id)
  );

  for (const [id, config] of entries) {
    try {
      const transportMode = (config.transport || "stdio").toLowerCase();
      let transport;
      if (transportMode === "http") {
        if (!config.url) {
          console.warn(`[mcp-bridge] addon ${id}: transport=http requires "url"`);
          continue;
        }
        let authProvider;
        if (config.oauth) {
          const { credentials_file, token_file, scopes } = config.oauth;
          if (!credentials_file || !token_file || !Array.isArray(scopes)) {
            console.warn(
              `[mcp-bridge] addon ${id}: oauth block requires credentials_file, token_file, scopes[]`,
            );
            continue;
          }
          authProvider = createGoogleOAuthProvider({
            credentialsFile: credentials_file,
            tokenFile: token_file,
            scopes,
            label: id,
          });
        }
        transport = new StreamableHTTPClientTransport(new URL(config.url), { authProvider });
      } else {
        const cwd = config.cwd || join(resolveCrowHome(), "bundles", id);
        const env = { ...process.env, ...(config.env || {}) };
        transport = new StdioClientTransport({
          command: config.command,
          args: config.args || [],
          env,
          cwd,
        });
      }
      const client = new Client({ name: `bridge-addon-${id}`, version: "0.1.0" });
      await Promise.race([
        client.connect(transport),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("connect timeout (30s)")), 30_000)
        ),
      ]);

      const { tools } = await client.listTools();
      clients.set(id, client);
      transports.set(id, transport);

      for (const tool of tools) {
        const toolName = tool.name;
        const description = tool.description || `${id} tool: ${toolName}`;
        const rawSchema = tool.inputSchema || { type: "object", properties: {} };
        registry.register({
          name: toolName,
          description,
          inputSchema: z.any(),
          rawInputSchema: rawSchema,
          execute: async (input) => {
            try {
              const result = await client.callTool({ name: toolName, arguments: input || {} });
              let text = "";
              if (result.content) {
                for (const block of result.content) {
                  if (block.type === "text") text += block.text;
                }
              }
              return { data: text || "(empty result)", isError: result.isError || false };
            } catch (err) {
              return { data: `Addon tool error (${id}): ${err.message}`, isError: true };
            }
          },
        });
        toolCount++;
      }

      console.log(`[mcp-bridge] addon ${id}: ${tools.length} tools registered`);
    } catch (err) {
      console.warn(`[mcp-bridge] addon ${id}: failed — ${err.message}`);
    }
  }

  return { clients, transports, toolCount };
}
