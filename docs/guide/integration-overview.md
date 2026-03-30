# How AI Works with Crow

Crow is an AI-powered platform, but it is not tied to any single AI provider. Multiple AI systems can connect to the same Crow instance simultaneously, sharing a single database of memories, projects, blog posts, files, and contacts. This page explains the three connection patterns and how they fit together.

## Three Ways to Connect

### 1. External MCP (Direct Connection)

AI platforms that support the Model Context Protocol connect directly to Crow's MCP servers. This is the primary pattern for Claude.ai, ChatGPT, Gemini, Cursor, Windsurf, and other desktop/web AI tools.

```
AI Platform ──► MCP Transport ──► Crow MCP Servers ──► SQLite Database
  (Claude,        (stdio or           (memory,
   ChatGPT,        Streamable HTTP)    projects,
   Cursor)                             sharing,
                                       storage,
                                       blog)
```

**How it works:** The AI platform spawns Crow's MCP servers as child processes (stdio) or connects to the gateway over HTTP. The platform's built-in AI calls Crow tools directly — store memories, search projects, publish blog posts, etc.

**Best for:** Deep work sessions, platform-specific features (Claude's artifacts, Cursor's code editing), using the AI you already pay for.

**Setup:** Add MCP server entries to the platform's configuration file. See [Platforms](/platforms/) for per-platform guides.

### 2. BYOAI Chat (Crow's Nest)

Crow's built-in AI Chat lets you use any AI provider through the Crow's Nest web dashboard. Crow handles the AI provider connection and tool dispatch internally.

```
User ──► Crow's Nest ──► /api/chat ──► AI Provider API ──► Tool Executor ──► MCP Servers ──► Database
           (browser)      (gateway)    (OpenAI, Anthropic,   (in-process
                                        Google, Ollama,       MCP Client)
                                        OpenRouter)
```

**How it works:** You configure an AI provider (API key + model) in Settings. When you send a message, the gateway forwards it to the provider. When the AI responds with tool calls, the gateway's tool executor dispatches them to Crow's MCP servers in-process and feeds the results back to the AI. The response streams to your browser via Server-Sent Events.

**Best for:** Quick interactions from the dashboard, using free/cheap AI providers (Ollama for fully local, OpenRouter for budget models), accessing Crow from devices without a native AI client.

**Setup:** See the [AI Providers (BYOAI) guide](/guide/ai-providers).

### 3. Native Bots (CrowClaw)

AI bots that live on Discord, WhatsApp, Telegram, and other chat platforms — managed directly from the Crow dashboard. The [CrowClaw](/guide/bot-management) extension handles bot lifecycle, AI configuration, skill deployment, and monitoring.

```
Chat Platform ──► OpenClaw Engine ──► Crow MCP Servers ──► SQLite Database
  (Discord,         (managed by            ▲
   WhatsApp,         CrowClaw)             │
   Telegram)                          CrowClaw Panel
                                     (dashboard UI)
```

**How it works:** Install the CrowClaw extension, create a bot from the dashboard, and deploy it. CrowClaw auto-configures the bot's AI provider from Crow's existing AI profiles (BYOAI bridge), deploys skills, and manages the bot's systemd service. The bot appears in the Messages panel alongside peers and AI chat — one inbox for everything.

Bots aren't just chat interfaces — they can **control Crow apps**. Since the bot connects via MCP, it has access to the same tool suite as Claude or ChatGPT: memory, projects, blog, sharing, storage, and extensions. A household bot can track expenses and manage a pantry. A research bot can monitor RSS feeds and store findings in projects. A blog bot can publish scheduled posts.

**Best for:** Accessing Crow from mobile chat apps, multi-platform presence, automated workflows, collaborative use through shared channels.

**Setup:** See the [Bot Management guide](/guide/bot-management) or install CrowClaw from [Extensions](/guide/extensions).

## What They All Share

All three connection patterns access the **same database, same tools, and same data**. A memory stored from Claude.ai is instantly searchable from the Crow's Nest AI Chat and from a bot on Discord. A blog post drafted in Cursor can be published from ChatGPT.

| Resource | Shared across all connections |
|---|---|
| Memories | Full-text searchable, tagged, scored by importance |
| Projects & sources | Research, data connectors, notes, citations |
| Blog posts | Drafts, published posts, themes, RSS feeds |
| Files | S3-compatible storage (when MinIO is configured) |
| Contacts & messages | Peer identities, Nostr DMs, shared items |
| Behavioral context | crow.md identity, protocols, and custom sections |

This is the core value proposition: **use whichever AI interface fits the moment, and your data follows you**.

## Tool Routing

Crow exposes 49+ individual MCP tools across its five servers. Loading all of them into an AI's context window is wasteful — most interactions only need a few tools.

### The Router Pattern

The gateway's `/router/mcp` endpoint consolidates all tools into **7 category tools**, reducing context usage by approximately 75%:

| Category Tool | Routes To | Actions |
|---|---|---|
| `crow_memory` | Memory server | store, search, recall, list, update, delete, stats, context |
| `crow_projects` | Project server | create, list, update, add sources/notes, search, bibliography |
| `crow_blog` | Blog server | create, edit, publish, unpublish, themes, export, share |
| `crow_sharing` | Sharing server | invite, accept, share, inbox, send message, contacts, revoke |
| `crow_storage` | Storage server | upload, list, get URL, delete, stats |
| `crow_tools` | External integrations | GitHub, Brave Search, Slack, and other connected services |
| `crow_discover` | Schema lookup | Returns full parameter schemas on demand |

Each category tool accepts an `action` parameter (e.g., `crow_memory` with `action: "store_memory"`) and a `params` object. The `crow_discover` tool lets the AI inspect available actions and their full schemas without loading everything upfront.

### Where Routing Applies

- **Gateway HTTP** (`/router/mcp`): Used by remote MCP clients and the BYOAI tool executor
- **crow-core** (`servers/core/`): Stdio equivalent for local deployments — starts with memory tools, activates other servers on demand
- **Direct endpoints** (`/memory/mcp`, `/projects/mcp`, etc.): Still available for clients that prefer full tool definitions

## Messaging and Sharing

Crow includes a peer-to-peer layer for communication and data sharing between users, independent of any AI provider.

### Nostr (Messaging)

Direct messages between Crow users are encrypted with NIP-44 and relayed through Nostr relays. Messages appear in the Crow's Nest Messages panel and are accessible from any connected AI via the `crow_send_message` and `crow_inbox` tools.

### Hypercore (Data Sync)

Shared items (memories, projects, sources) replicate between peers over Hypercore append-only feeds. Peers discover each other via Hyperswarm DHT with NAT holepunching — no central server required.

### Peer Relay (Offline Delivery)

When a peer is offline, messages and shares can be held by an opt-in peer relay for later delivery. The relay stores encrypted payloads and forwards them when the recipient comes online.

## Choosing a Pattern

| Scenario | Recommended Pattern |
|---|---|
| Deep research session with Claude | External MCP (stdio) |
| Quick memory lookup from your phone | BYOAI Chat (Crow's Nest) |
| Team collaboration on Discord | Native Bots (CrowClaw) |
| Code project with AI assistance | External MCP via Cursor or Claude Code |
| Fully local, no cloud AI | BYOAI Chat with Ollama |
| Access from multiple chat apps | Native Bots (Discord + WhatsApp + Telegram) |
| Automated household management | Native Bots with skills |
| All of the above, simultaneously | All three — they share one database |

## Next Steps

- [AI Providers (BYOAI)](/guide/ai-providers) — Configure the built-in AI Chat
- [Bot Management](/guide/bot-management) — Create and manage bots from the dashboard
- [Cross-Platform Guide](/guide/cross-platform) — How behavioral context syncs across platforms
- [OpenClaw](/platforms/openclaw) — Connect Crow to chat platform bots
- [Platforms](/platforms/) — Per-platform setup guides for external MCP
- [Context Management](/architecture/context-management) — Deep dive on the tool router
