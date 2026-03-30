# OpenClaw

Connect Crow to [OpenClaw](https://openclaw.ai), the open-source personal AI assistant that runs on WhatsApp, Telegram, Discord, Slack, Signal, iMessage, and more.

## Recommended: Install CrowClaw

The easiest way to connect OpenClaw to Crow is through the **CrowClaw extension**:

1. Go to **Extensions** in the Crow's Nest dashboard
2. Install **CrowClaw** (under AI & Automation)
3. Open the **Bots** panel and create a bot
4. CrowClaw handles everything: MCP server registration, AI model config (BYOAI bridge), skill deployment, and service management

Your bot appears in the Messages panel, shares Crow's AI providers, and can be managed entirely from the dashboard. See the [Bot Management guide](/guide/bot-management) for the full walkthrough.

## Why Use Crow with OpenClaw?

OpenClaw handles the conversational front-end across chat platforms. Crow adds capabilities that complement OpenClaw's strengths:

- **Persistent memory** — OpenClaw's markdown memory is session-scoped and subject to compaction. Crow's SQLite/FTS5 memory is structured, searchable, and permanent.
- **Cross-platform access** — Memories stored from OpenClaw are instantly available from Claude, ChatGPT, Gemini, Cursor, or any other connected platform.
- **Project pipeline** — Typed projects (research, data connectors), sources with auto-APA citations, notes, data backends, and bibliography generation.
- **Bot control of Crow apps** — Bots can publish blog posts, manage files, control integrations — the same MCP tools available to any AI client.

## Prerequisites

- [OpenClaw](https://openclaw.ai) installed and running
- Crow set up (`npm run setup`) or Crow gateway deployed ([Cloud Deploy Guide](../getting-started/cloud-deploy))
- Node.js >= 18

## Transport

| Pattern | Transport | Auth | When to Use |
|---|---|---|---|
| **Local (stdio)** | Child process | None (local process) | OpenClaw and Crow on the same machine |
| **Remote (HTTP)** | Streamable HTTP | OAuth 2.1 | Crow gateway deployed remotely |

## Manual Setup

::: details Advanced: Manual MCP Configuration

If you prefer to configure OpenClaw manually instead of using CrowClaw, add Crow's MCP servers directly to your OpenClaw configuration.

### Local (stdio)

Add to `~/.openclaw/openclaw.json`:

```json
{
  "mcpServers": {
    "crow-memory": {
      "command": "node",
      "args": ["/path/to/crow/servers/memory/index.js"],
      "env": {
        "CROW_DB_PATH": "/path/to/crow/data/crow.db"
      }
    },
    "crow-projects": {
      "command": "node",
      "args": ["/path/to/crow/servers/research/index.js"],
      "env": {
        "CROW_DB_PATH": "/path/to/crow/data/crow.db"
      }
    }
  }
}
```

Replace `/path/to/crow` with your actual Crow installation path.

### Remote (HTTP)

```json
{
  "mcpServers": {
    "crow-memory": {
      "url": "https://your-crow-server/memory/mcp"
    },
    "crow-projects": {
      "url": "https://your-crow-server/projects/mcp"
    },
    "crow-tools": {
      "url": "https://your-crow-server/tools/mcp"
    }
  }
}
```

OAuth 2.1 discovery and authorization work automatically via `@modelcontextprotocol/sdk`.

### Sharing Tools

To use P2P sharing through OpenClaw, add the sharing server:

**Local:**
```json
{
  "mcpServers": {
    "crow-sharing": {
      "command": "node",
      "args": ["/path/to/crow/servers/sharing/index.js"],
      "env": {
        "CROW_DB_PATH": "/path/to/crow/data/crow.db"
      }
    }
  }
}
```

**Remote:**
```json
{
  "mcpServers": {
    "crow-sharing": {
      "url": "https://your-crow-server/sharing/mcp"
    }
  }
}
```

:::

## Cross-Platform Context

Crow automatically delivers behavioral context when OpenClaw connects via MCP — memory protocols, session management, and transparency rules are active from the first message. For deeper guidance, MCP prompts are available: `session-start`, `crow-guide`, `research-guide`, `blog-guide`, `sharing-guide`.

See the [Cross-Platform Guide](/guide/cross-platform) for details.

## Verification

After connecting (via CrowClaw or manual setup), test through any OpenClaw-connected chat platform:

1. **Store a memory**: "Store a memory that OpenClaw is connected to Crow"
2. **Verify retrieval**: "Search my memories for 'OpenClaw'"
3. **Cross-platform test**: Ask another connected platform to search for the same memory
4. **Project tools**: "List my projects"

## Tips

- Memories stored from OpenClaw are instantly available from Claude, ChatGPT, Gemini, or any other connected platform
- Use Crow's importance scoring (1-10) to prioritize what matters — high-importance memories surface first
- Both memory systems can coexist — let each do what it's best at
- If using remote HTTP, ensure your gateway stays healthy — OpenClaw loses access if it goes down

## Related

- [Bot Management](/guide/bot-management) — Dashboard-based bot lifecycle management
- [Integration Overview](/guide/integration-overview) — How all three AI connection patterns work together
- [AI Providers (BYOAI)](/guide/ai-providers) — Built-in AI Chat configuration
- [CrowClaw Architecture](/architecture/crowclaw) — Technical deep dive
