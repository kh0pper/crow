# Context & Performance

Every MCP tool your AI loads takes up space in its context window — the finite amount of text it can hold at once. When you connect multiple servers and integrations, those tool definitions add up, leaving less room for your actual conversation. This guide explains why that matters and what you can do about it.

## The Problem

Think of the AI's context window as a working desk. Each connected MCP server drops a stack of tool manuals on that desk: names, descriptions, parameter schemas. The more tools loaded, the less desk space remains for the conversation itself.

The result: responses can feel slower, the AI may "forget" earlier parts of a conversation sooner, and quality degrades as the window fills up. This is not a Crow-specific issue — it affects any MCP setup — but Crow gives you options to manage it.

## How MCP Tools Use Context

When an MCP server connects, every tool it exposes gets serialized into the AI's context. That means the tool name, its description, and the full Zod parameter schema — all converted to text tokens.

```
Server connects → 49 tool signatures loaded → ~10,000 tokens consumed
```

Those tokens are consumed before you type a single word. With a 200K token context window, 10,000 tokens is 5% of your budget gone to tool definitions alone. Add a few external integrations and you can easily hit 20-30%.

## Crow's Tool Inventory

Crow's five core servers expose 49 tools total:

| Server | Tools | Examples |
|--------|-------|---------|
| Memory | 12 | `crow_store_memory`, `crow_search_memories`, `crow_recall_by_context` |
| Research | 12 | `crow_create_project`, `crow_add_source`, `crow_generate_bibliography` |
| Blog | 12 | `crow_create_post`, `crow_publish_post`, `crow_blog_settings` |
| Sharing | 8 | `crow_add_peer`, `crow_share_item`, `crow_check_inbox` |
| Storage | 5 | `crow_upload_file`, `crow_list_files`, `crow_delete_file` |
| **Total** | **49** | |

Each external integration (Obsidian, Home Assistant, Ollama, etc.) adds 5-20+ more tools on top of this.

## Your Options

Crow offers three configuration modes that trade off between context efficiency and compatibility:

| Mode | Tools Loaded | Context Cost | Best For |
|------|-------------|-------------|----------|
| Gateway Router (`/router/mcp`) | 7 | ~2,500 tokens | Hosted deployments, many integrations |
| Combined Core (`crow-core`) | 15 at startup | ~5,000 tokens | Local/stdio, Raspberry Pi |
| Individual Servers | 49+ | ~10,000+ tokens | Maximum compatibility, simple setup |

### Gateway Router

The gateway exposes a single MCP endpoint at `/router/mcp` with just 7 meta-tools. Instead of loading all 49 tool definitions upfront, the AI uses `crow_discover` to find relevant tools on demand and `crow_execute` to call them. Tools only enter context when actually needed.

### Combined Core

The `crow-core` server starts with 15 commonly-used tools and activates others on demand via `crow_activate_tools`. A middle ground — fewer tools than individual servers, more direct access than the router.

### Individual Servers

Each server runs as a separate MCP connection. Every tool is available immediately with no discovery step. The simplest setup, and the most compatible across platforms, but the highest context cost.

## Recommendations by Use Case

- **Just getting started?** Use individual servers. The setup is straightforward and context cost is manageable with just Crow's core tools.

- **Running many integrations?** Switch to the gateway router. When you have Obsidian, Home Assistant, and other integrations stacked on top of Crow's 49 tools, the router's discover-and-execute pattern keeps context lean.

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
