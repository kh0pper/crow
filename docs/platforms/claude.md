# Claude Web & Mobile

Connect Crow to Claude on the web (claude.ai) or the Claude mobile app using Custom Integrations.

## Prerequisites

- Crow gateway deployed and healthy ([Cloud Deploy Guide](../getting-started/cloud-deploy))
- A Claude Pro, Team, or Enterprise plan (Custom Integrations require a paid plan)

## Setup Steps

1. Go to [claude.ai/settings](https://claude.ai/settings) → **Integrations**
2. Click **Add Custom Integration**
3. Enter a name (e.g., "Crow Memory")
4. Paste your gateway URL:
   ```
   https://your-crow-server/memory/mcp
   ```
5. Click **Save** — Claude will initiate the OAuth flow
6. Authorize the connection when prompted

Repeat for each server you want to connect:

| Server | URL |
|---|---|
| Memory | `https://your-crow-server/memory/mcp` |
| Projects | `https://your-crow-server/projects/mcp` |
| Sharing | `https://your-crow-server/sharing/mcp` |
| Storage | `https://your-crow-server/storage/mcp` |
| Blog | `https://your-crow-server/blog-mcp/mcp` |
| External Tools | `https://your-crow-server/tools/mcp` |

> **Note:** The storage endpoint requires MinIO to be configured. See the [Storage Guide](/guide/storage) for setup.

## Transport

- **Type**: Streamable HTTP
- **Protocol**: `2025-03-26`
- **Auth**: OAuth 2.1 (automatic)

## Verification

After connecting, try asking Claude:

> "Store a memory that Crow is now connected."

If it works, you'll see Crow's memory tools in action. You can verify stored memories by asking:

> "What do you remember?"

## Cross-Platform Context

Crow automatically delivers behavioral context during the MCP connection handshake. When Claude connects to any Crow server, it receives Crow's identity, memory protocols, session protocol, transparency rules, and capability reference — no user action required.

This means Claude knows to recall relevant memories at the start of each conversation, store important information, and follow transparency rules from the very first message.

For deeper guidance, Claude can request MCP prompts:

- **session-start** — Detailed session start/end protocol
- **crow-guide** — Full crow.md document with all behavioral sections
- **research-guide** / **blog-guide** / **sharing-guide** — Workflow guidance for specific features

These prompts serve as skill equivalents, giving Claude detailed workflow instructions on demand without consuming context window space upfront.

You can also manually load the full context:

> "Load your crow.md context"

See the [Cross-Platform Guide](/guide/cross-platform) for more details.

## Context Optimization

Claude Code supports `toolListChanged` notifications, making `crow-core` a good fit for local use — it activates servers on demand rather than loading all tools upfront.

For Claude via the gateway, the `/router/mcp` endpoint reduces the tool count from 49+ to 7 consolidated category tools, significantly reducing context window usage. Instead of connecting each server individually, you can connect a single router endpoint:

```
https://your-crow-server/router/mcp
```

See the [Context & Performance guide](/guide/context-performance) for more details.

::: tip Shared with Claude Code CLI
Custom Integrations you add here are also available in Claude Code CLI sessions — they share the same connector configuration within Anthropic's ecosystem. If you set up Crow on claude.ai, it works in Claude Code without additional setup. This cross-platform sharing is specific to Claude; other platforms (ChatGPT, Gemini) manage their MCP connections independently.
:::

## Tips

- You can connect all five servers (memory, projects, sharing, storage, blog) plus external tools simultaneously
- The mobile app uses the same Custom Integrations as the web
- Tools from external integrations (GitHub, Slack, etc.) appear through the `/tools/mcp` endpoint
- Memories stored here are instantly accessible from ChatGPT, Gemini, or any other connected platform
