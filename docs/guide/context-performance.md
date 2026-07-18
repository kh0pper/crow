# Context & Performance

Every MCP tool your AI loads takes up space in its context window — the finite amount of text it can hold at once. When you connect multiple servers and integrations, those tool definitions add up, leaving less room for your actual conversation. This guide explains why that matters and what you can do about it.

## The Problem

Think of the AI's context window as a working desk. Each connected MCP server drops a stack of tool manuals on that desk: names, descriptions, parameter schemas. The more tools loaded, the less desk space remains for the conversation itself.

The result: responses can feel slower, the AI may "forget" earlier parts of a conversation sooner, and quality degrades as the window fills up. This is not a Crow-specific issue — it affects any MCP setup — but Crow gives you options to manage it.

## How MCP Tools Use Context

When an MCP server connects, every tool it exposes gets serialized into the AI's context. That means the tool name, its description, and the full Zod parameter schema — all converted to text tokens.

```
Server connects → 126 tool signatures loaded → ~25,000 tokens consumed
```

Those tokens are consumed before you type a single word. With a 200K token context window, 25,000 tokens is over 12% of your budget gone to tool definitions alone. Add a few external integrations and you can easily hit 30% or more.

## Crow's Tool Inventory

Crow's core servers expose over 110 tools total:

| Server | Tools | Examples |
|--------|-------|---------|
| Memory | 24 | `crow_store_memory`, `crow_search_memories`, `crow_recall_by_context` |
| Projects | 23 | `crow_create_project`, `crow_add_source`, `crow_generate_bibliography` |
| Blog | 23 | `crow_create_post`, `crow_publish_post`, `crow_blog_settings` |
| Sharing | 33 | `crow_generate_invite`, `crow_share`, `crow_inbox` |
| Storage | 8 | `crow_upload_file`, `crow_list_files`, `crow_delete_file` |
| **Total** | **117** | |

Each external integration (Obsidian, Home Assistant, Ollama, etc.) adds 5-20+ more tools on top of this.

## Your Options

Crow offers three configuration modes that trade off between context efficiency and compatibility:

| Mode | Tools Loaded | Context Cost | Best For |
|------|-------------|-------------|----------|
| Gateway Router (`/router/mcp`) | 9 | ~3,000 tokens | Hosted deployments, many integrations |
| Combined Core (`crow-core` stdio) | one server's tools at startup | ~6,000 tokens | Local/stdio, Raspberry Pi |
| Individual Servers | 117+ | ~25,000+ tokens | Maximum compatibility, simple setup |

### Gateway Router

The gateway exposes a single MCP endpoint at `/router/mcp` with one consolidated **category tool per server** — 8 tools on a full install: `crow_memory`, `crow_projects`, `crow_blog`, `crow_sharing`, `crow_storage`, `crow_media`, plus `crow_tools` (external integrations and remote instances) and `crow_discover` (schema lookup). Instead of loading 117 tool definitions upfront, the AI calls a category tool with an `action` parameter — `crow_memory` with `action: "store_memory"`, for example — and uses `crow_discover` to look up available actions and their full schemas on demand. Tool definitions only enter context when actually needed.

### Combined Core

The `crow-core` stdio server starts with one server's tools active (memory by default — `CROW_DEFAULT_SERVER` changes it) plus three control tools, and activates other servers on demand via `crow_activate_server`. A middle ground — fewer tools than individual servers, more direct access than the router.

### Individual Servers

Each server runs as a separate MCP connection. Every tool is available immediately with no discovery step. The simplest setup, and the most compatible across platforms, but the highest context cost.

::: info Naming aliases
You may see two names for the same thing in older configs — they are aliases, not different servers: the **projects** server was previously called **research** (`/research/mcp` still works as an alias for `/projects/mcp`, and the router accepts `crow_research` for `crow_projects`), and the bare `/mcp` endpoint is a compatibility alias for the memory server.
:::

## Recommendations by Use Case

- **Just getting started?** Use individual servers. The setup is straightforward and context cost is manageable with just Crow's core tools.

- **Running many integrations?** Switch to the gateway router. When you have Obsidian, Home Assistant, and other integrations stacked on top of Crow's 126 tools, the router's category-dispatch pattern keeps context lean.

- **On a Raspberry Pi or constrained device?** Use `crow-core`. It balances low overhead with direct tool access — no HTTP gateway required.

- **Platform context limits to keep in mind:** Claude (200K tokens), ChatGPT (128K tokens), Gemini (varies by model). The smaller your context window, the more a router or combined approach helps.

::: tip
You do not have to pick one mode for everything. Some users run individual servers locally in Claude Code and the gateway router for their hosted instance.
:::

## Checking Your Context Usage

### Gateway mode

Hit the `/health` endpoint on your gateway. The response includes a `toolCounts` object showing how many tools each connected server exposes:

```bash
curl http://localhost:3001/health
```

### Combined Core mode

Use the `crow_server_status` tool to see which tool groups are active and how many tools are currently loaded.

### Router mode

Use `crow_discover` with a broad query to see available tools without loading them all into context.

---

For implementation details on how Crow manages tool loading and context budgets internally, see the [Context Management architecture reference](/architecture/context-management).
