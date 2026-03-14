/**
 * Crow Core — On-Demand Server Activation (stdio)
 *
 * A single MCP server for local deployments that starts with one server's
 * tools active (memory by default) and activates others on demand via
 * toolListChanged notifications.
 *
 * Startup: 15 tools (12 memory + 3 management) vs 49+ with all servers.
 * Configurable default via CROW_DEFAULT_SERVER env var.
 *
 * Management tools:
 *   crow_activate_server(server)   — Enable a server's tools
 *   crow_deactivate_server(server) — Disable a server's tools
 *   crow_server_status()           — Show active/inactive servers
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import { createMemoryServer } from "../memory/server.js";
import { createProjectServer } from "../research/server.js";
import { createSharingServer } from "../sharing/server.js";
import { createBlogServer } from "../blog/server.js";
import { TOOL_MANIFESTS, getToolNames } from "../gateway/tool-manifests.js";
import { generateInstructions } from "../shared/instructions.js";

const SERVER_FACTORIES = {
  memory: createMemoryServer,
  projects: createProjectServer,
  sharing: createSharingServer,
  blog: createBlogServer,
};

// Storage loaded dynamically (may not be available)
async function getStorageFactory() {
  try {
    const { createStorageServer } = await import("../storage/server.js");
    return createStorageServer;
  } catch {
    return null;
  }
}

/**
 * Create the core on-demand McpServer.
 *
 * Registers management tools and the default server's tools.
 * Other servers' tools are registered as disabled and activated on demand.
 */
export async function createCoreServer(dbPath) {
  const instructions = await generateInstructions({ dbPath, deviceId: process.env.CROW_DEVICE_ID });

  const server = new McpServer(
    { name: "crow-core", version: "0.1.0" },
    instructions ? { instructions } : undefined
  );

  const defaultServer = process.env.CROW_DEFAULT_SERVER || "memory";
  const activeServers = new Set([defaultServer]);

  // In-process clients for dispatching to underlying servers
  const clients = new Map(); // serverName → Client

  /**
   * Connect to an underlying server via in-process transport.
   */
  async function connectServer(name) {
    if (clients.has(name)) return clients.get(name);

    let factory = SERVER_FACTORIES[name];
    if (!factory && name === "storage") {
      factory = await getStorageFactory();
      if (!factory) throw new Error("Storage server not available. Set MINIO_ENDPOINT in .env.");
    }
    if (!factory) throw new Error(`Unknown server: ${name}`);

    const targetServer = factory(dbPath);
    const client = new Client({ name: `core-${name}`, version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await targetServer.connect(serverTransport);
    await client.connect(clientTransport);

    clients.set(name, client);
    return client;
  }

  /**
   * Register tools from a server as proxy tools on the core server.
   * Returns the registered tool objects for enable/disable.
   */
  const registeredProxyTools = new Map(); // toolName → registeredTool

  async function registerServerTools(name, enabled) {
    const client = await connectServer(name);
    const { tools } = await client.listTools();

    for (const tool of tools) {
      // Convert JSON Schema to Zod for registration
      const zodShape = jsonSchemaToZodShape(tool.inputSchema);

      const registeredTool = server.tool(
        tool.name,
        tool.description || `Tool from ${name}`,
        zodShape,
        async (args) => {
          try {
            const result = await client.callTool({
              name: tool.name,
              arguments: args,
            });
            return result;
          } catch (error) {
            return {
              content: [{ type: "text", text: `Error calling ${tool.name}: ${error.message}` }],
              isError: true,
            };
          }
        }
      );

      if (!enabled) {
        registeredTool.disable();
      }

      registeredProxyTools.set(tool.name, { registeredTool, serverName: name });
    }
  }

  // --- Register management tools ---

  server.tool(
    "crow_activate_server",
    "Activate a server's tools, making them available for use. Servers: memory, projects, sharing, storage, blog.",
    {
      server: z.string().describe("Server name to activate: memory, projects, sharing, storage, blog"),
    },
    async ({ server: serverName }) => {
      const available = Object.keys(TOOL_MANIFESTS);
      if (!available.includes(serverName)) {
        return {
          content: [{ type: "text", text: `Unknown server "${serverName}". Available: ${available.join(", ")}` }],
          isError: true,
        };
      }

      if (activeServers.has(serverName)) {
        const toolNames = getToolNames(serverName);
        return {
          content: [{ type: "text", text: `Server "${serverName}" is already active (${toolNames.length} tools).` }],
        };
      }

      // Check if tools are registered but disabled, or need first-time registration
      const toolNames = getToolNames(serverName);
      const alreadyRegistered = toolNames.some((name) => registeredProxyTools.has(name));

      if (alreadyRegistered) {
        // Re-enable existing tools
        for (const toolName of toolNames) {
          const entry = registeredProxyTools.get(toolName);
          if (entry) entry.registeredTool.enable();
        }
      } else {
        // First activation — register and connect
        await registerServerTools(serverName, true);
      }

      activeServers.add(serverName);

      return {
        content: [{
          type: "text",
          text: `Activated "${serverName}" — ${toolNames.length} tools now available. The AI should re-fetch the tool list.`,
        }],
      };
    }
  );

  server.tool(
    "crow_deactivate_server",
    "Deactivate a server's tools to free up context space. The default server cannot be deactivated.",
    {
      server: z.string().describe("Server name to deactivate"),
    },
    async ({ server: serverName }) => {
      if (!activeServers.has(serverName)) {
        return {
          content: [{ type: "text", text: `Server "${serverName}" is not active.` }],
        };
      }

      if (serverName === defaultServer) {
        return {
          content: [{ type: "text", text: `Cannot deactivate the default server ("${defaultServer}"). Change CROW_DEFAULT_SERVER to use a different default.` }],
        };
      }

      const toolNames = getToolNames(serverName);
      for (const toolName of toolNames) {
        const entry = registeredProxyTools.get(toolName);
        if (entry) entry.registeredTool.disable();
      }

      activeServers.delete(serverName);

      return {
        content: [{
          type: "text",
          text: `Deactivated "${serverName}" — ${toolNames.length} tools removed.`,
        }],
      };
    }
  );

  server.tool(
    "crow_server_status",
    "Show which servers are active/inactive and their tool counts.",
    {},
    async () => {
      const lines = ["Crow Core — Server Status", ""];

      for (const [name, manifest] of Object.entries(TOOL_MANIFESTS)) {
        const toolCount = Object.keys(manifest.tools).length;
        const isActive = activeServers.has(name);
        const isDefault = name === defaultServer;
        const status = isActive ? "active" : "inactive";
        const defaultTag = isDefault ? " (default)" : "";
        lines.push(`  ${name}: ${status}${defaultTag} — ${toolCount} tools`);
      }

      const totalActive = [...activeServers].reduce((sum, name) => {
        return sum + getToolNames(name).length;
      }, 0);

      lines.push("");
      lines.push(`Active tools: ${totalActive} + 3 management = ${totalActive + 3}`);
      lines.push(`Use crow_activate_server to enable more servers.`);

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // --- Register default server tools (active) ---
  await registerServerTools(defaultServer, true);

  // --- Pre-register other servers (disabled) for faster activation ---
  // We connect and register all tools but disable them immediately.
  // This means tool schemas are already loaded — activation just flips enabled.
  const otherServers = Object.keys(TOOL_MANIFESTS).filter((s) => s !== defaultServer);
  for (const name of otherServers) {
    try {
      await registerServerTools(name, false);
    } catch (err) {
      // Storage may not be available — that's fine, it'll be registered on first activate
      if (name !== "storage") {
        console.warn(`[core] Failed to pre-register ${name}: ${err.message}`);
      }
    }
  }

  return server;
}

/**
 * Convert JSON Schema properties to a Zod shape object.
 * Simplified version — handles common MCP tool parameter types.
 */
function jsonSchemaToZodShape(schema) {
  if (!schema || !schema.properties) return {};

  const shape = {};
  const required = new Set(schema.required || []);

  for (const [key, prop] of Object.entries(schema.properties)) {
    let zodProp = jsonSchemaToZodProp(prop);
    if (prop.description) zodProp = zodProp.describe(prop.description);
    if (!required.has(key)) zodProp = zodProp.optional();
    shape[key] = zodProp;
  }
  return shape;
}

function jsonSchemaToZodProp(prop) {
  if (!prop) return z.string();

  if (prop.anyOf) {
    const nonNull = prop.anyOf.filter((s) => s.type !== "null");
    if (nonNull.length === 1) return jsonSchemaToZodProp(nonNull[0]).optional();
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
      return z.array(prop.items ? jsonSchemaToZodProp(prop.items) : z.any());
    case "object":
      return z.record(z.any());
    default:
      return z.any();
  }
}
