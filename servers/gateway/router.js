/**
 * Gateway Tool Router — Consolidated MCP endpoint
 *
 * Exposes ~7 category tools instead of 49+ individual tools, reducing
 * context window usage by ~75-87%. Each category tool dispatches to the
 * underlying server via an in-process MCP Client + InMemoryTransport pair.
 *
 * Tools:
 *   crow_memory    — Routes to memory server (12 actions)
 *   crow_research  — Routes to research server (12 actions)
 *   crow_blog      — Routes to blog server (12 actions)
 *   crow_sharing   — Routes to sharing server (8 actions)
 *   crow_storage   — Routes to storage server (5 actions)
 *   crow_tools     — Routes to external proxy servers (dynamic)
 *   crow_discover  — Returns full schema for any action
 *
 * Feature flag: Set CROW_DISABLE_ROUTER=1 to skip mounting /router/mcp.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import { createMemoryServer } from "../memory/server.js";
import { createResearchServer } from "../research/server.js";
import { createSharingServer } from "../sharing/server.js";
import { createBlogServer } from "../blog/server.js";
import { TOOL_MANIFESTS, buildCompressedDescription } from "./tool-manifests.js";
import { connectedServers } from "./proxy.js";

/**
 * Server factory map — maps category names to their factory functions.
 * Storage is loaded dynamically since it may not be available.
 */
const SERVER_FACTORIES = {
  memory: createMemoryServer,
  research: createResearchServer,
  sharing: createSharingServer,
  blog: createBlogServer,
  // storage added dynamically in createRouterServer
};

/**
 * Create an in-process MCP Client connected to a server via InMemoryTransport.
 * Returns { client, server } pair.
 */
async function createInProcessClient(name, serverFactory) {
  const server = serverFactory();
  const client = new Client({ name: `router-${name}`, version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  // Server must connect first — it needs to be ready when client sends initialize
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

/**
 * Create the router McpServer.
 *
 * Each invocation creates a fresh router instance (called per-session by
 * mountMcpServer). In-process clients to underlying servers are created
 * lazily on first use within the session.
 */
export function createRouterServer() {
  const routerServer = new McpServer({
    name: "crow-router",
    version: "0.1.0",
  });

  // Lazy-initialized in-process clients (per-session)
  const clients = new Map(); // category → Client

  /**
   * Get or create an in-process client for a category.
   */
  async function getClient(category) {
    if (clients.has(category)) return clients.get(category);

    // Check if storage is available
    let factories = { ...SERVER_FACTORIES };
    if (category === "storage") {
      try {
        const { createStorageServer } = await import("../storage/server.js");
        factories.storage = createStorageServer;
      } catch {
        throw new Error("Storage server is not available. Set MINIO_ENDPOINT in .env to enable it.");
      }
    }

    const factory = factories[category];
    if (!factory) {
      throw new Error(`Unknown server category: ${category}. Available: ${Object.keys(TOOL_MANIFESTS).join(", ")}`);
    }

    const { client } = await createInProcessClient(category, factory);
    clients.set(category, client);
    return client;
  }

  /**
   * Dispatch an action to the appropriate server.
   * Resolves the full tool name from the action (adds crow_ prefix if needed).
   */
  async function dispatch(category, action, params) {
    const client = await getClient(category);

    // Resolve tool name: accept both "store_memory" and "crow_store_memory"
    const manifest = TOOL_MANIFESTS[category];
    let toolName = action;
    if (manifest && !manifest.tools[action]) {
      const prefixed = `crow_${action}`;
      if (manifest.tools[prefixed]) {
        toolName = prefixed;
      }
    }

    const result = await client.callTool({
      name: toolName,
      arguments: params || {},
    });
    return result;
  }

  // --- Register category tools ---

  for (const [category, manifest] of Object.entries(TOOL_MANIFESTS)) {
    const description = buildCompressedDescription(category);

    routerServer.tool(
      `crow_${category}`,
      description,
      {
        action: z.string().describe("Action name (e.g. 'store_memory', 'search_memories'). Use crow_discover to see available actions and their full schemas."),
        params: z.record(z.any()).optional().describe("Parameters for the action"),
      },
      async ({ action, params }) => {
        try {
          return await dispatch(category, action, params);
        } catch (error) {
          return {
            content: [{ type: "text", text: `Error in ${category}/${action}: ${error.message}` }],
            isError: true,
          };
        }
      }
    );
  }

  // --- crow_tools: external proxy servers ---

  routerServer.tool(
    "crow_tools",
    "Route to external integration tools (Trello, Canvas, Slack, etc.). Use crow_discover with category 'tools' to see available integrations and their tools.",
    {
      action: z.string().describe("Tool name from the external server"),
      params: z.record(z.any()).optional().describe("Parameters for the tool"),
    },
    async ({ action, params }) => {
      if (connectedServers.size === 0) {
        return {
          content: [{
            type: "text",
            text: "No external integrations are currently connected. Configure integrations in .env and restart the gateway. Visit /setup for details.",
          }],
        };
      }

      // Find which connected server has this tool
      for (const [integrationId, entry] of connectedServers) {
        if (entry.status !== "connected" || !entry.client) continue;

        const hasTool = entry.tools.some((t) => t.name === action);
        if (hasTool) {
          try {
            const result = await entry.client.callTool({
              name: action,
              arguments: params || {},
            });
            return result;
          } catch (error) {
            return {
              content: [{ type: "text", text: `Error calling ${action} (${integrationId}): ${error.message}` }],
              isError: true,
            };
          }
        }
      }

      // Tool not found — list available tools
      const available = [];
      for (const [id, entry] of connectedServers) {
        if (entry.status !== "connected") continue;
        available.push(`${id}: ${entry.tools.map((t) => t.name).join(", ")}`);
      }

      return {
        content: [{
          type: "text",
          text: `Tool "${action}" not found in any connected integration.\n\nAvailable tools:\n${available.join("\n") || "None"}`,
        }],
      };
    }
  );

  // --- crow_discover: schema discovery ---

  routerServer.tool(
    "crow_discover",
    "Discover available actions and their full parameter schemas. Use without arguments to list all categories. Specify a category to list its actions. Specify category + action to get the full JSON Schema for that action.",
    {
      category: z.string().optional().describe("Server category: memory, research, blog, sharing, storage, tools"),
      action: z.string().optional().describe("Specific action name to get full schema for"),
    },
    async ({ category, action }) => {
      // No category: list all categories with action counts
      if (!category) {
        const lines = ["Available categories:"];
        for (const [cat, manifest] of Object.entries(TOOL_MANIFESTS)) {
          const toolCount = Object.keys(manifest.tools).length;
          lines.push(`  ${cat} (${toolCount} actions): ${manifest.description}`);
        }

        // Add external tools
        let externalCount = 0;
        for (const [, entry] of connectedServers) {
          if (entry.status === "connected") externalCount += entry.tools.length;
        }
        if (externalCount > 0) {
          lines.push(`  tools (${externalCount} actions): External integrations`);
        }

        lines.push("\nUse crow_discover with a category to see its actions.");
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      // Handle "tools" category (external servers)
      if (category === "tools") {
        if (connectedServers.size === 0) {
          return {
            content: [{ type: "text", text: "No external integrations connected." }],
          };
        }

        if (action) {
          // Find the specific tool schema
          for (const [integrationId, entry] of connectedServers) {
            if (entry.status !== "connected") continue;
            const tool = entry.tools.find((t) => t.name === action);
            if (tool) {
              return {
                content: [{
                  type: "text",
                  text: JSON.stringify({
                    name: tool.name,
                    description: tool.description,
                    inputSchema: tool.inputSchema,
                    source: integrationId,
                  }, null, 2),
                }],
              };
            }
          }
          return {
            content: [{ type: "text", text: `Tool "${action}" not found in any connected integration.` }],
          };
        }

        // List all external tools
        const lines = ["External integration tools:"];
        for (const [id, entry] of connectedServers) {
          if (entry.status !== "connected") continue;
          lines.push(`\n  ${id}:`);
          for (const tool of entry.tools) {
            lines.push(`    - ${tool.name}: ${tool.description || "No description"}`);
          }
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      // Core category
      if (!TOOL_MANIFESTS[category]) {
        return {
          content: [{
            type: "text",
            text: `Unknown category "${category}". Available: ${Object.keys(TOOL_MANIFESTS).join(", ")}, tools`,
          }],
        };
      }

      if (action) {
        // Get full schema for a specific action via client.listTools()
        try {
          const client = await getClient(category);
          const { tools } = await client.listTools();

          // Match by action name (with or without crow_ prefix)
          const tool = tools.find((t) => t.name === action || t.name === `crow_${action}`);
          if (!tool) {
            return {
              content: [{
                type: "text",
                text: `Action "${action}" not found in ${category}. Available: ${tools.map((t) => t.name).join(", ")}`,
              }],
            };
          }

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema,
              }, null, 2),
            }],
          };
        } catch (error) {
          return {
            content: [{ type: "text", text: `Error discovering ${category}/${action}: ${error.message}` }],
            isError: true,
          };
        }
      }

      // List actions for the category (from static manifest — no server instantiation)
      const manifest = TOOL_MANIFESTS[category];
      const lines = [`${manifest.displayName} actions:`];
      for (const [name, info] of Object.entries(manifest.tools)) {
        lines.push(`  - ${name}(${info.params}): ${info.desc}`);
      }
      lines.push(`\nUse crow_discover with category="${category}" and action="<name>" for full schema.`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  return routerServer;
}
