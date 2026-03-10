# Context Management

## Overview

The MCP protocol eagerly loads all tool signatures when a server connects. Each tool's name, description, and full JSON Schema consumes tokens in the AI's context window before the conversation even starts. With 49 core tools across five servers plus external integrations, this baseline cost reaches 10,000-20,000+ tokens — a significant fraction of the available context on smaller-window models and a cost multiplier on every request.

Crow addresses this with two complementary strategies: the **Gateway Tool Router** (HTTP deployments) and **On-Demand Server Activation** (stdio deployments). Both build on the same server factory pattern and `InMemoryTransport` plumbing.

## Gateway Tool Router

The router (`servers/gateway/router.js`) consolidates all core and external tools behind 7 category tools, reducing context usage by approximately 75%.

### Architecture

```
                        +-----------------------+
  [AI Client] -------->| /router/mcp           |
                        |  crow-router McpServer|
                        +-----------+-----------+
                                    |
            +-----------+-----------+-----------+-----------+
            |           |           |           |           |
     crow_memory  crow_research  crow_blog  crow_sharing  crow_storage
            |           |           |           |           |
     [InMemory   [InMemory   [InMemory   [InMemory   [InMemory
      Transport]  Transport]  Transport]  Transport]  Transport]
            |           |           |           |           |
     [Memory     [Research   [Blog       [Sharing   [Storage
      McpServer]  McpServer]  McpServer]  McpServer]  McpServer]

  crow_tools -----> connectedServers (from proxy.js)
  crow_discover --> static manifests + live schema lookup
```

Each category tool creates an in-process `Client` connected to the underlying `McpServer` via `InMemoryTransport.createLinkedPair()`. Clients are created lazily on first use within each session.

### Router Tools

| Tool | Dispatches To | Actions |
|---|---|---|
| `crow_memory` | Memory server | 12 (store, search, recall, list, update, delete, stats, context ops) |
| `crow_research` | Research server | 12 (projects, sources, notes, bibliography, stats) |
| `crow_blog` | Blog server | 12 (create, edit, publish, list, delete, export, themes, stats) |
| `crow_sharing` | Sharing server | 8 (invite, contacts, share, inbox, messaging, revoke) |
| `crow_storage` | Storage server | 5 (upload, list, download URL, delete, stats) |
| `crow_tools` | External proxy servers | Dynamic (Trello, Canvas, Slack, etc.) |
| `crow_discover` | Static manifests + live schemas | Discovery protocol |

### Parameter Schema

Every category tool accepts the same shape:

```js
{
  action: z.string(),    // Action name, e.g. "store_memory" or "crow_store_memory"
  params: z.record(z.any()).optional()  // Parameters forwarded to the underlying tool
}
```

The router resolves tool names with or without the `crow_` prefix, so both `store_memory` and `crow_store_memory` work.

### Compressed Manifests

Each category tool's description is built by `buildCompressedDescription()` from `tool-manifests.js`. It packs all action names and parameter signatures into the tool description string:

```
Persistent memory: store, search, recall, list... Actions:
- store_memory(content, category?, context?, tags?, source?, importance?): Store a memory
- search_memories(query, category?, min_importance?, limit?): Search memories (FTS5)
...
```

This gives the AI enough information to call most actions without discovery, while keeping the schema footprint small.

### Discovery Protocol

The `crow_discover` tool provides on-demand access to full JSON Schemas:

```
crow_discover()                              → List all categories with action counts
crow_discover(category="memory")             → List memory actions with param summaries
crow_discover(category="memory", action="crow_store_memory") → Full JSON Schema
crow_discover(category="tools")              → List external integration tools
crow_discover(category="tools", action="github_create_issue") → Full external tool schema
```

Category-level discovery uses static manifests (no server instantiation). Action-level discovery calls `client.listTools()` on the underlying server to return the live schema.

### Context Savings

| Mode | Tools Loaded | Estimated Tokens |
|---|---|---|
| Individual servers (no router) | 49 x ~200 tokens | ~9,800 |
| Router mode | 7 x ~350 tokens | ~2,450 |
| **Reduction** | | **~75%** |

### Feature Flag

Disable the router to mount servers individually:

```bash
CROW_DISABLE_ROUTER=1 npm run gateway
```

## On-Demand Server Activation (crow-core)

For stdio deployments, `servers/core/` provides a single MCP server that starts with one server active and adds others on demand.

### Architecture

```
  [AI Client] <--stdio--> [crow-core McpServer]
                                |
                          +-----+-----+
                          |           |
                   [Active Tools]  [Management Tools (3)]
                   (memory: 12)    crow_activate_server
                                   crow_deactivate_server
                                   crow_server_status

  crow_activate_server("research")
        |
        v
  [registeredTool.enable()] --> toolListChanged notification
        |
        v
  [AI re-fetches tool list] --> research tools now visible
```

### Management Tools

| Tool | Parameters | Description |
|---|---|---|
| `crow_activate_server` | `server: string` | Enable a server's tools (memory, research, sharing, storage, blog) |
| `crow_deactivate_server` | `server: string` | Disable a server's tools (default server cannot be deactivated) |
| `crow_server_status` | none | Show active/inactive servers with tool counts |

### Startup Behavior

1. All servers are connected via `InMemoryTransport` and their tools registered on the core `McpServer`
2. Only the default server's tools are enabled; all others are registered but disabled
3. The AI sees 15 tools at startup: 12 memory tools + 3 management tools
4. Calling `crow_activate_server("research")` flips the registered tools to enabled and triggers a `toolListChanged` notification
5. The AI client re-fetches the tool list and sees the newly available tools

The default server is configurable:

```bash
CROW_DEFAULT_SERVER=research node servers/core/index.js
```

## Automatic Behavioral Context (MCP Instructions)

The MCP protocol supports an `instructions` field in the `InitializeResult` — a string sent during the connection handshake before any tool calls. Per the spec, this "can be used by clients to improve the LLM's understanding of available tools" and "MAY be added to the system prompt."

Crow uses this to deliver behavioral context automatically to every connected AI client, eliminating the need for users to manually ask the AI to load crow.md.

### How It Works

```
  Gateway startup
       |
       v
  generateInstructions() ──> queries crow_context table
       |                     extracts 5 essential sections
       v                     condenses to ~1KB string
  instructions string (pre-computed)
       |
       +──> createMemoryServer(undefined, { instructions })
       +──> createResearchServer(undefined, { instructions })
       +──> createRouterServer({ instructions: routerInstructions })
       +──> ...
       |
       v
  McpServer({ name, version }, { instructions })
       |
       v
  Client connects ──> InitializeResult includes instructions
       |
       v
  AI sees behavioral context before any tool calls
```

The instructions string is generated **once at gateway startup** and passed to all server factories as a pre-computed string. This avoids per-session database queries and keeps factories synchronous.

### Content

The condensed instructions (~1KB) include:

| Section | Content |
|---|---|
| Identity | Who Crow is (1-2 sentences) |
| Session Protocol | "Call crow_recall_by_context on session start" |
| Memory Protocol | Categories, importance levels, deduplication rules |
| Transparency Rules | [crow: action] notation for autonomous actions |
| Capabilities | Tool routing table (direct names or category names for router) |

Two variants are generated:
- **Direct style**: Uses tool names like `crow_store_memory` (for individual server endpoints)
- **Router style**: Uses category names like `crow_memory action: "store_memory"` (for `/router/mcp`)

### Fallback

If the `crow_context` table doesn't exist or the database is unavailable, a static ~500-byte fallback is used that provides minimal behavioral guidance.

### stdio Servers

stdio entry points (`servers/*/index.js`) generate instructions at startup using top-level `await`, then pass the string to the factory. crow-core does the same inside its async `createCoreServer()` function.

## MCP Prompts (Skill Equivalents)

MCP prompts are first-class prompt templates that clients can list and request on demand. Crow registers prompts as **skill equivalents for non-Claude-Code platforms**, giving the AI access to detailed workflow guidance without consuming context window space upfront.

### Available Prompts

| Prompt | Server(s) | Description |
|---|---|---|
| `session-start` | Memory, Router | Session start/end protocol from crow.md |
| `crow-guide` | Memory, Router | Full crow.md document (accepts `platform` argument) |
| `research-guide` | Research, Router | Research workflow: projects, sources, citations, bibliography |
| `blog-guide` | Blog, Router | Blog publishing: posts, themes, RSS, export |
| `sharing-guide` | Sharing, Router | P2P sharing: invites, contacts, messaging |

The router registers all 5 prompts so clients connected to `/router/mcp` have access to everything. Individual servers register only their own relevant prompts.

### How Clients Use Prompts

```
Client: prompts/list
Server: [{ name: "session-start", description: "..." }, ...]

Client: prompts/get { name: "crow-guide", arguments: { platform: "chatgpt" } }
Server: { messages: [{ role: "user", content: { type: "text", text: "# crow.md — ..." } }] }
```

The AI can request a prompt when it needs detailed guidance for a specific workflow, keeping the initial context footprint small while making comprehensive instructions available on demand.

## Server Factory Integration

Both the router and crow-core reuse the same factory functions (`createMemoryServer`, `createResearchServer`, etc.) and the same `InMemoryTransport` + `Client` pattern. The factory creates a standalone `McpServer`; the caller wires it to whatever transport the deployment needs:

```js
// stdio (individual server)
const server = createMemoryServer();
await server.connect(new StdioServerTransport());

// Gateway router (in-process)
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);

// crow-core (same in-process pattern, tools proxied onto core McpServer)
```

Static tool metadata lives in `servers/gateway/tool-manifests.js`. Both the router (`buildCompressedDescription`) and crow-core (`getToolNames`) import from it.

## Configuration

### .mcp.json Generation

```bash
# Individual servers (one entry per server in .mcp.json)
npm run mcp-config

# Combined crow-core mode (single entry)
npm run mcp-config -- --combined
```

The `--combined` flag writes a single `crow-core` entry pointing to `servers/core/index.js` instead of separate entries for each server. The server registry in `scripts/server-registry.js` defines both modes.

### Health Endpoint

The gateway `/health` response includes tool count telemetry:

```json
{
  "status": "ok",
  "servers": ["crow-memory", "crow-research", "crow-sharing", "crow-storage", "crow-blog"],
  "externalServers": [{ "id": "github", "name": "GitHub", "tools": 15 }],
  "toolCounts": {
    "core": 49,
    "external": 15,
    "total": 64,
    "routerMode": 7
  }
}
```

The `routerMode` field is the number of router tools exposed (7), or `null` when the router is disabled via `CROW_DISABLE_ROUTER=1`.

## API Reference

| Endpoint | Method | Description |
|---|---|---|
| `/router/mcp` | POST, GET, DELETE | Streamable HTTP transport for the router McpServer |
| `/health` | GET | Status including `toolCounts` object |

For usage guidance and optimization tips, see the [Context Performance Guide](/guide/context-performance).
