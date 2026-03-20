/**
 * AI Chat Tool Executor
 *
 * Dispatches tool calls from AI providers to underlying Crow MCP servers.
 * Reuses the router.js pattern: in-process MCP Client + InMemoryTransport.
 *
 * Uses the router's 7 category tools (crow_memory, crow_projects, etc.)
 * to keep context manageable. The AI sees category-style tool names and
 * uses crow_discover for on-demand schema lookup.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMemoryServer } from "../../memory/server.js";
import { createProjectServer } from "../../research/server.js";
import { createSharingServer } from "../../sharing/server.js";
import { createBlogServer } from "../../blog/server.js";
import { TOOL_MANIFESTS } from "../tool-manifests.js";
import { connectedServers } from "../proxy.js";

/** Max characters for a single tool result before truncation */
const MAX_RESULT_LENGTH = 2000;

/** Max tool call rounds per message turn */
export const MAX_TOOL_ROUNDS = 10;

/**
 * Server factory map — mirrors router.js.
 * Media is available as a bundle add-on (accessed via crow_tools proxy).
 */
const SERVER_FACTORIES = {
  memory: createMemoryServer,
  projects: createProjectServer,
  sharing: createSharingServer,
  blog: createBlogServer,
};

/**
 * Create an in-process MCP Client connected to a server.
 */
async function createInProcessClient(name, serverFactory) {
  const server = serverFactory();
  const client = new Client({ name: `chat-${name}`, version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

/**
 * Resolve which server category owns a tool name.
 * Returns { category, toolName } or null.
 */
function resolveToolCategory(action) {
  for (const [category, manifest] of Object.entries(TOOL_MANIFESTS)) {
    if (manifest.tools[action]) return { category, toolName: action };
    // Try without crow_ prefix
    const prefixed = `crow_${action}`;
    if (manifest.tools[prefixed]) return { category, toolName: prefixed };
  }
  return null;
}

/**
 * Create a tool executor instance.
 *
 * Manages a pool of lazy in-process MCP clients and dispatches
 * tool calls to the appropriate server.
 */
export function createToolExecutor() {
  const clients = new Map(); // category → Client

  async function getClient(category) {
    if (clients.has(category)) return clients.get(category);

    let factories = { ...SERVER_FACTORIES };
    if (category === "storage") {
      try {
        const { createStorageServer } = await import("../../storage/server.js");
        factories.storage = createStorageServer;
      } catch {
        throw new Error("Storage server not available. Set MINIO_ENDPOINT in .env.");
      }
    }

    const factory = factories[category];
    if (!factory) {
      throw new Error(`Unknown category: ${category}`);
    }

    const { client } = await createInProcessClient(category, factory);
    clients.set(category, client);
    return client;
  }

  /**
   * Execute a single tool call.
   * Returns { result: string, isError: boolean }.
   */
  async function executeTool(name, args) {
    try {
      // Check if it's a category-level tool (crow_memory, crow_projects, etc.)
      const categoryMatch = name.match(/^crow_(memory|projects|blog|sharing|storage|media)$/);
      if (categoryMatch) {
        const category = categoryMatch[1];
        const action = args.action;
        const params = args.params || {};

        if (!action) {
          return { result: `Error: ${name} requires an 'action' parameter`, isError: true };
        }

        const client = await getClient(category);

        // Resolve action to full tool name
        const manifest = TOOL_MANIFESTS[category];
        let toolName = action;
        if (manifest && !manifest.tools[action]) {
          const prefixed = `crow_${action}`;
          if (manifest.tools[prefixed]) toolName = prefixed;
        }

        const result = await client.callTool({ name: toolName, arguments: params });
        return formatResult(result);
      }

      // crow_discover — schema discovery
      if (name === "crow_discover") {
        return await handleDiscover(args);
      }

      // crow_tools — external integrations (legacy wrapper, still supported)
      if (name === "crow_tools") {
        return await handleExternalTool(args);
      }

      // Direct addon tool call (e.g., "crow_tax_prepare_from_documents")
      if (connectedServers) {
        for (const [integrationId, entry] of connectedServers) {
          if (entry.status !== "connected" || !entry.client) continue;
          const hasTool = entry.tools?.some((t) => t.name === name);
          if (hasTool) {
            try {
              const result = await entry.client.callTool({ name, arguments: args });
              return formatResult(result);
            } catch (err) {
              return { result: `Error calling ${name} (${integrationId}): ${err.message}`, isError: true };
            }
          }
        }
      }

      // Direct tool name (resolve to category)
      const resolved = resolveToolCategory(name);
      if (resolved) {
        const client = await getClient(resolved.category);
        const result = await client.callTool({ name: resolved.toolName, arguments: args });
        return formatResult(result);
      }

      return { result: `Unknown tool: ${name}`, isError: true };
    } catch (err) {
      return { result: `Tool error (${name}): ${err.message}`, isError: true };
    }
  }

  /**
   * Execute multiple tool calls concurrently.
   */
  async function executeToolCalls(toolCalls) {
    return Promise.all(
      toolCalls.map(async (tc) => {
        const { result, isError } = await executeTool(tc.name, tc.arguments || {});
        return {
          id: tc.id,
          name: tc.name,
          result,
          isError,
        };
      })
    );
  }

  /**
   * Handle crow_discover tool call.
   */
  async function handleDiscover(args) {
    const { category, action } = args;

    if (!category) {
      const lines = ["Available categories:"];
      for (const [cat, manifest] of Object.entries(TOOL_MANIFESTS)) {
        const toolCount = Object.keys(manifest.tools).length;
        lines.push(`  ${cat} (${toolCount} actions): ${manifest.description}`);
      }
      // Include addon servers as discoverable categories
      if (connectedServers) {
        for (const [id, entry] of connectedServers) {
          if (entry.status === "connected" && entry.tools?.length) {
            lines.push(`  tools/${id} (${entry.tools.length} tools): Installed extension`);
          }
        }
      }
      return { result: lines.join("\n"), isError: false };
    }

    // Handle "tools" category — discover addon tools
    if (category === "tools" || category.startsWith("tools/")) {
      const addonId = category.includes("/") ? category.split("/")[1] : null;

      if (action) {
        // Get schema for a specific addon tool
        for (const [id, entry] of connectedServers) {
          if (entry.status !== "connected" || !entry.client) continue;
          const tool = entry.tools?.find((t) => t.name === action);
          if (tool) {
            return {
              result: JSON.stringify({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }, null, 2),
              isError: false,
            };
          }
        }
        return { result: `Tool "${action}" not found in any addon`, isError: true };
      }

      // List all addon tools (or just one addon)
      const lines = [];
      for (const [id, entry] of connectedServers) {
        if (entry.status !== "connected") continue;
        if (addonId && id !== addonId) continue;
        lines.push(`[${id}] (${entry.tools?.length || 0} tools):`);
        for (const t of entry.tools || []) {
          lines.push(`  - ${t.name}: ${(t.description || "").substring(0, 100)}`);
        }
      }
      return { result: lines.join("\n") || "No addon tools connected", isError: false };
    }

    const manifest = TOOL_MANIFESTS[category];
    if (!manifest) {
      return { result: `Unknown category: ${category}. Use crow_discover (no args) to see available categories.`, isError: true };
    }

    if (action) {
      try {
        const client = await getClient(category);
        const { tools } = await client.listTools();
        const tool = tools.find((t) => t.name === action || t.name === `crow_${action}`);
        if (!tool) {
          return { result: `Action "${action}" not found in ${category}`, isError: true };
        }
        return {
          result: JSON.stringify({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }, null, 2),
          isError: false,
        };
      } catch (err) {
        return { result: `Error discovering ${category}/${action}: ${err.message}`, isError: true };
      }
    }

    const lines = [`${manifest.displayName} actions:`];
    for (const [toolName, info] of Object.entries(manifest.tools)) {
      const shortName = toolName.replace(/^crow_/, "");
      lines.push(`  - ${shortName}(${info.params}): ${info.desc}`);
    }
    return { result: lines.join("\n"), isError: false };
  }

  /**
   * Handle crow_tools (external integration) tool call.
   *
   * Forgiving parameter handling — accepts multiple formats that weaker models produce:
   *   { action: "tool", params: { key: val } }           — correct format
   *   { action: "tool", params: { arguments: { ... } } } — nested arguments (common mistake)
   *   { action: "tool", arguments: { key: val } }         — arguments instead of params
   *   { action: "tool", key: val, ... }                   — flat params mixed with action
   */
  async function handleExternalTool(args) {
    let { action, params } = args;
    if (!action) {
      return { result: "crow_tools requires an 'action' parameter. Example: { action: 'crow_tax_get_documents', params: {} }", isError: true };
    }

    // Normalize params from various formats weaker models produce
    if (!params || typeof params !== "object") {
      params = {};
    }
    // Unwrap nested { arguments: { ... } } inside params
    if (params.arguments && typeof params.arguments === "object" && Object.keys(params).length <= 2) {
      params = params.arguments;
    }
    // If model put tool params directly on args (flat), extract them
    if (Object.keys(params).length === 0) {
      const flat = { ...args };
      delete flat.action;
      delete flat.params;
      if (Object.keys(flat).length > 0) {
        params = flat;
      }
    }

    for (const [integrationId, entry] of connectedServers) {
      if (entry.status !== "connected" || !entry.client) continue;
      const hasTool = entry.tools.some((t) => t.name === action);
      if (hasTool) {
        try {
          const result = await entry.client.callTool({ name: action, arguments: params });
          return formatResult(result);
        } catch (err) {
          return { result: `Error calling ${action} (${integrationId}): ${err.message}`, isError: true };
        }
      }
    }

    return { result: `Tool "${action}" not found in any connected extension. Available: ${[...connectedServers.entries()].filter(([,e]) => e.status === "connected").map(([id, e]) => `${id}(${e.tools?.length || 0})`).join(", ")}`, isError: true };
  }

  /**
   * Clean up all in-process clients.
   */
  async function close() {
    for (const [, client] of clients) {
      try {
        await client.close();
      } catch {}
    }
    clients.clear();
  }

  return { executeTool, executeToolCalls, close };
}

/**
 * Format an MCP tool result into a truncated string.
 */
function formatResult(mcpResult) {
  const isError = mcpResult.isError || false;
  let text = "";

  if (mcpResult.content) {
    for (const block of mcpResult.content) {
      if (block.type === "text") {
        text += block.text;
      }
    }
  }

  // Truncate long results
  if (text.length > MAX_RESULT_LENGTH) {
    text = text.slice(0, MAX_RESULT_LENGTH) + "\n...[truncated]";
  }

  return { result: text, isError };
}

/**
 * Build the MCP tool schemas for the AI provider.
 * Returns the 7 category tools + discover in MCP tool format.
 */
export function getChatTools() {
  const tools = [];

  for (const [category, manifest] of Object.entries(TOOL_MANIFESTS)) {
    const actionLines = Object.entries(manifest.tools)
      .map(([name, info]) => `- ${name.replace(/^crow_/, "")}(${info.params}): ${info.desc}`)
      .join("\n");

    tools.push({
      name: `crow_${category}`,
      description: `${manifest.description}. Actions:\n${actionLines}`,
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            description: "Action name (e.g. 'store_memory', 'search_memories'). Use crow_discover to see full schemas.",
          },
          params: {
            type: "object",
            description: "Parameters for the action",
          },
        },
        required: ["action"],
      },
    });
  }

  // crow_discover
  tools.push({
    name: "crow_discover",
    description: "Discover available actions and their parameter schemas. No args = list categories. category = list actions. category + action = full schema.",
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string", description: "Server category: memory, projects, blog, sharing, storage" },
        action: { type: "string", description: "Action name for full schema" },
      },
    },
  });

  // Addon tools (from installed extensions)
  if (connectedServers && connectedServers.size > 0) {
    // Promote high-level "entry point" tools as direct tools (no crow_tools wrapper needed).
    // These are the tools an AI should call first — they do the most with fewest calls.
    const PROMOTED_PATTERNS = [/prepare/, /get_documents/, /calculate/, /generate_pdfs/];

    const promotedTools = [];
    const allAddonLines = [];

    for (const [id, entry] of connectedServers) {
      if (entry.status !== "connected" || !entry.tools?.length) continue;
      const toolNames = [];

      for (const tool of entry.tools) {
        const isPromoted = PROMOTED_PATTERNS.some((p) => p.test(tool.name));
        if (isPromoted) {
          // Expose as direct tool with real schema — no wrapper needed
          tools.push({
            name: tool.name,
            description: tool.description || "",
            inputSchema: tool.inputSchema || { type: "object", properties: {} },
          });
          promotedTools.push(tool.name);
        }
        toolNames.push(tool.name);
      }
      allAddonLines.push(`[${id}]: ${toolNames.join(", ")}`);
    }

    // Also keep crow_tools for accessing granular tools that aren't promoted
    tools.push({
      name: "crow_tools",
      description: `Call any installed extension tool. Use: { action: "tool_name", params: { ... } }.\n\nAll tools by extension:\n${allAddonLines.join("\n")}${promotedTools.length ? `\n\nNote: These tools can also be called directly (no crow_tools wrapper): ${promotedTools.join(", ")}` : ""}`,
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", description: "Tool name" },
          params: { type: "object", description: "Parameters for the tool" },
        },
        required: ["action"],
      },
    });
  }

  return tools;
}
