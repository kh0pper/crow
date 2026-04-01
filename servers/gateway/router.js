/**
 * Gateway Tool Router — Consolidated MCP endpoint
 *
 * Exposes ~7 category tools instead of 49+ individual tools, reducing
 * context window usage by ~75-87%. Each category tool dispatches to the
 * underlying server via an in-process MCP Client + InMemoryTransport pair.
 *
 * Tools:
 *   crow_memory    — Routes to memory server (20 actions)
 *   crow_projects  — Routes to project server (16 actions)
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
import { createProjectServer } from "../research/server.js";
import { createSharingServer } from "../sharing/server.js";
import { createBlogServer } from "../blog/server.js";
import { createOrchestratorServer } from "../orchestrator/server.js";
import { TOOL_MANIFESTS, buildCompressedDescription } from "./tool-manifests.js";
import { connectedServers } from "./proxy.js";
import { createDbClient } from "../db.js";
import { generateCrowContext } from "../memory/crow-context.js";

/**
 * Server factory map — maps category names to their factory functions.
 * Storage and media are loaded dynamically since they may not be available.
 */
const SERVER_FACTORIES = {
  memory: createMemoryServer,
  projects: createProjectServer,
  sharing: createSharingServer,
  blog: createBlogServer,
  orchestrator: () => createOrchestratorServer(undefined, { connectedServers }),
  // storage added dynamically in createRouterServer
  // media added dynamically in createRouterServer (bundle add-on)
};

/** Backward-compat aliases for category names */
const CATEGORY_ALIASES = {
  research: "projects",
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
export function createRouterServer(options = {}) {
  const routerServer = new McpServer(
    { name: "crow-router", version: "0.1.0" },
    options.instructions ? { instructions: options.instructions } : undefined
  );

  // Lazy-initialized in-process clients (per-session)
  const clients = new Map(); // category → Client

  /**
   * Get or create an in-process client for a category.
   */
  async function getClient(category) {
    if (clients.has(category)) return clients.get(category);

    // Check if storage/media are available (loaded dynamically)
    let factories = { ...SERVER_FACTORIES };
    if (category === "storage") {
      try {
        const { createStorageServer } = await import("../storage/server.js");
        factories.storage = createStorageServer;
      } catch {
        throw new Error("Storage server is not available. Set MINIO_ENDPOINT in .env to enable it.");
      }
    }
    if (category === "media") {
      try {
        // Try installed bundle first, then repo
        const { existsSync } = await import("node:fs");
        const { join } = await import("node:path");
        const { pathToFileURL } = await import("node:url");
        const { homedir } = await import("node:os");
        const installed = join(homedir(), ".crow", "bundles", "media", "server", "server.js");
        const repo = join(import.meta.dirname, "../../bundles/media/server/server.js");
        const serverPath = existsSync(installed) ? installed : repo;
        const { createMediaServer } = await import(pathToFileURL(serverPath).href);
        factories.media = createMediaServer;
      } catch {
        throw new Error("Media bundle is not installed. Install it via the Extensions panel or place it in bundles/media/.");
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
    "Route to external integration tools (Trello, Canvas, Slack, etc.) and remote Crow instances. Use crow_discover with category 'tools' or 'instances' to see what's available.",
    {
      action: z.string().describe("Tool name from the external server"),
      params: z.record(z.any()).optional().describe("Parameters for the tool"),
      instance_id: z.string().optional().describe("Route to a specific remote instance by ID (use crow_discover category 'instances' to see available)"),
    },
    async ({ action, params, instance_id }) => {
      // If instance_id is specified, route directly to that remote instance
      if (instance_id) {
        const instanceKey = `instance-${instance_id}`;
        const entry = connectedServers.get(instanceKey);
        if (!entry || !entry.isRemote) {
          return {
            content: [{ type: "text", text: `Remote instance "${instance_id}" not found. Use crow_discover category "instances" to see available instances.` }],
            isError: true,
          };
        }
        if (entry.status !== "connected" || !entry.client) {
          return {
            content: [{ type: "text", text: `Remote instance "${entry.instanceName}" is ${entry.status}${entry.error ? `: ${entry.error}` : ""}` }],
            isError: true,
          };
        }
        try {
          return await entry.client.callTool({ name: action, arguments: params || {} });
        } catch (error) {
          return {
            content: [{ type: "text", text: `Error calling ${action} on ${entry.instanceName}: ${error.message}` }],
            isError: true,
          };
        }
      }

      if (connectedServers.size === 0) {
        return {
          content: [{
            type: "text",
            text: "No external integrations are currently connected. Configure integrations in .env and restart the gateway. Visit /setup for details.",
          }],
        };
      }

      // Find which connected server has this tool (local integrations first, then remote instances)
      for (const [integrationId, entry] of connectedServers) {
        if (entry.status !== "connected" || !entry.client) continue;
        if (entry.isRemote) continue; // Skip remote instances for name-based lookup

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
        if (entry.isRemote) {
          available.push(`${id} (remote: ${entry.instanceName}): use instance_id="${entry.instanceId}" to route tools`);
        } else {
          available.push(`${id}: ${entry.tools.map((t) => t.name).join(", ")}`);
        }
      }

      return {
        content: [{
          type: "text",
          text: `Tool "${action}" not found in any connected integration.\n\nAvailable:\n${available.join("\n") || "None"}`,
        }],
      };
    }
  );

  // --- crow_discover: schema discovery ---

  routerServer.tool(
    "crow_discover",
    "Discover available actions and their full parameter schemas. Use without arguments to list all categories. Specify a category to list its actions. Specify category + action to get the full JSON Schema for that action.",
    {
      category: z.string().optional().describe("Server category: memory, projects, blog, sharing, media, storage, tools"),
      action: z.string().optional().describe("Specific action name to get full schema for"),
    },
    async ({ category, action }) => {
      // Resolve category aliases (e.g. "research" → "projects")
      if (category && CATEGORY_ALIASES[category]) {
        category = CATEGORY_ALIASES[category];
      }

      // No category: list all categories with action counts
      if (!category) {
        const lines = ["Available categories:"];
        for (const [cat, manifest] of Object.entries(TOOL_MANIFESTS)) {
          const toolCount = Object.keys(manifest.tools).length;
          lines.push(`  ${cat} (${toolCount} actions): ${manifest.description}`);
        }

        // Add external tools
        let externalCount = 0;
        let remoteCount = 0;
        for (const [, entry] of connectedServers) {
          if (entry.isRemote) { remoteCount++; continue; }
          if (entry.status === "connected") externalCount += entry.tools.length;
        }
        if (externalCount > 0) {
          lines.push(`  tools (${externalCount} actions): External integrations`);
        }
        if (remoteCount > 0) {
          lines.push(`  instances (${remoteCount} remote): Federated Crow instances`);
        }

        lines.push("\nUse crow_discover with a category to see its actions.");
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      // Handle "instances" category (remote Crow instances)
      if (category === "instances") {
        const lines = ["Remote Crow instances:"];
        let found = false;
        for (const [id, entry] of connectedServers) {
          if (!entry.isRemote) continue;
          found = true;
          const statusIcon = entry.status === "connected" ? "●" : entry.status === "offline" ? "○" : "!";
          lines.push(`\n  ${statusIcon} ${entry.instanceName || id} (${entry.status})`);
          lines.push(`    ID: ${entry.instanceId}`);
          lines.push(`    Host: ${entry.hostname || "unknown"}`);
          lines.push(`    Gateway: ${entry.gatewayUrl || "none"}`);
          if (entry.error) lines.push(`    Error: ${entry.error}`);
          lines.push(`    Route tools via: crow_tools action="<tool_name>" instance_id="${entry.instanceId}"`);
        }
        if (!found) {
          lines.push("  No remote instances registered. Use crow_register_instance to add one.");
        }
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

  // --- Prompts (skill equivalents for non-Claude-Code platforms) ---

  const promptDb = createDbClient();

  routerServer.prompt(
    "session-start",
    "Session start/end protocol — how to begin and end conversations with Crow",
    async () => {
      let text;
      try {
        const result = await promptDb.execute({
          sql: "SELECT content FROM crow_context WHERE enabled = 1 AND section_key IN ('memory_protocol', 'session_protocol')",
          args: [],
        });
        if (result.rows.length > 0) {
          text = result.rows.map((r) => r.content).join("\n\n");
        }
      } catch {
        // Fallback below
      }

      if (!text) {
        text = `Session Start Protocol:
1. Call crow_recall_by_context with the user's first message to load relevant memories
2. Use recalled memories to personalize your response
3. Throughout the conversation, store important new information with crow_store_memory

Session End Protocol:
- Before ending, store any important learnings, decisions, or preferences
- Use appropriate categories: general, project, preference, person, process, decision, learning, goal
- Set importance 8-10 for critical information the user would expect you to remember`;
      }

      return { messages: [{ role: "user", content: { type: "text", text } }] };
    }
  );

  routerServer.prompt(
    "crow-guide",
    "Full Crow behavioral context (crow.md) — identity, memory protocols, transparency rules, and more",
    { platform: z.string().default("generic").describe("Target platform: claude, chatgpt, gemini, grok, cursor, generic") },
    async ({ platform }) => {
      let text;
      try {
        text = await generateCrowContext(promptDb, { includeDynamic: false, platform });
      } catch {
        text = "Unable to load crow.md context. Use crow_memory with action 'get_context' as an alternative.";
      }
      return { messages: [{ role: "user", content: { type: "text", text } }] };
    }
  );

  routerServer.prompt(
    "project-guide",
    "Project workflow guidance — project creation, data backends, source management, citations, and bibliography",
    async () => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `Crow Project Workflow Guide

1. Project Creation — Use crow_projects action: "create_project" with name, description, and type ('research' or 'data_connector')
2. Data Backends — Register external MCP servers with action: "register_backend". List with "list_backends", inspect with "backend_schema".
3. Source Management — Add sources with action: "add_source" (URL, title, authors, date, type). Auto-generates APA citations. Link to backends with backend_id.
4. Notes — Attach with action: "add_note". Types: summary, quote, analysis, methodology, finding, question.
5. Bibliography — Generate with action: "generate_bibliography" (APA format, filterable by project).
6. Search — Use action: "search_sources" or "search_notes" for full-text search across all project data.`,
        },
      }],
    })
  );

  routerServer.prompt(
    "blog-guide",
    "Blog publishing workflow — creating posts, themes, RSS feeds, and export",
    async () => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `Crow Blog Publishing Guide

1. Create — crow_blog action: "create_post" with title and markdown content (starts as draft)
2. Edit — action: "edit_post" to update content, title, tags, excerpt
3. Publish — action: "publish_post" to make visible at /blog/:slug
4. Themes — action: "customize_theme" for colors, fonts, layout; "blog_settings" for name and tagline
5. Feeds — RSS at /blog/feed.xml, Atom at /blog/feed.atom
6. Export — action: "export_blog" for markdown or HTML export`,
        },
      }],
    })
  );

  routerServer.prompt(
    "media-guide",
    "Media workflow — subscribing to feeds, browsing articles, and managing your news",
    async () => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `Crow Media Guide

1. Subscribe — crow_media action: "add_source" with an RSS/Atom feed URL
2. Browse — action: "feed" for your news feed (filter by category, unread, starred)
3. Read — action: "get_article" for full article content
4. Search — action: "search" for full-text search across all articles
5. Interact — action: "article_action" to star, save, or give feedback
6. Refresh — action: "refresh" to trigger immediate feed updates
7. Stats — action: "stats" for an overview of your media library`,
        },
      }],
    })
  );

  routerServer.prompt(
    "sharing-guide",
    "P2P sharing and messaging workflow — invites, contacts, sharing data, and Nostr messaging",
    async () => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `Crow P2P Sharing Guide

1. Identity — Each Crow has a unique ID. Check with crow_sharing action: "sharing_status"
2. Connect — Generate invite (action: "generate_invite"), share code, peer accepts (action: "accept_invite")
3. Share Data — action: "share" with contact, item type (memory/project/source/note), and item ID
4. Messages — action: "send_message" for encrypted Nostr messaging
5. Inbox — action: "inbox" to see received shares and messages
6. Security — End-to-end encrypted, peer-to-peer via Hyperswarm with NAT holepunching`,
        },
      }],
    })
  );

  return routerServer;
}
