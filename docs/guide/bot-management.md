# Bot Management

Crow manages AI bots natively through the CrowClaw extension. Create, deploy, configure, and monitor bots directly from the Crow's Nest dashboard — no manual config files, no separate admin tools.

## What CrowClaw Does

CrowClaw is an extension that turns Crow into a bot management platform. Install it from Extensions, and the dashboard gains a **Bots** panel where you can:

- **Create bots** — Name, configure AI provider and model, set platform credentials
- **Deploy and manage** — Start, stop, restart, and delete bots as systemd services
- **Configure AI automatically** — CrowClaw's BYOAI bridge generates the bot's AI model config from Crow's existing AI profiles. No manual `models.json` editing.
- **Deploy skills** — Push behavioral prompts (SKILL.md files) to bots from the dashboard
- **Monitor health** — View bot status, logs, uptime, and error rates
- **Chat with bots** — Send messages to your bots directly from the Messages panel, including image attachments with vision model analysis

## One Inbox

Bots appear in the Messages panel alongside peers and AI chat. All your conversations — with people, with the built-in AI, and with your bots — live in one place.

- **Peer messages** — Encrypted Nostr DMs with other Crow users
- **AI chat** — BYOAI conversations with your configured AI provider
- **Bot messages** — Direct conversations with your deployed bots

File attachments work across all message types. When you send an image to a bot, CrowClaw routes it through a vision model for analysis before forwarding to the bot's primary AI.

## BYOAI Bridge

When you configure AI providers in Crow's Settings (API keys, models, endpoints), CrowClaw can use those same providers for your bots. The BYOAI bridge:

1. Reads Crow's AI profiles from the database
2. Generates the bot's `models.json` with correct provider namespaces
3. Detects vision-capable models and configures image processing
4. Runs automatically on every deploy — no manual sync needed

This means adding a new AI provider to Crow automatically makes it available to all your bots.

## Bots as App Controllers

Bots aren't just chat interfaces — they can **control Crow apps**. Since the bot connects via MCP, it has access to the same tool suite as any AI client:

- **Household bot** — Track expenses, manage a pantry, coordinate schedules via Google Calendar
- **Research bot** — Monitor RSS feeds (via Media Hub), store findings in projects, generate bibliographies
- **Blog bot** — Publish scheduled posts, moderate comments, manage themes
- **Storage bot** — Organize files, enforce naming conventions, clean up old uploads
- **Home automation bot** — Control Home Assistant devices via Crow's HA integration

Skills make these workflows portable. The same SKILL.md format works across bots, and language variants are just different skill files pointing at the same underlying tools.

## Connection Options

The bot engine ([OpenClaw](https://openclaw.ai)) connects to Crow in two ways:

| Pattern | Transport | Auth | When to Use |
|---|---|---|---|
| **Local (stdio)** | Child process | None | Bot and Crow on the same machine |
| **Remote (HTTP)** | Streamable HTTP | OAuth 2.1 | Crow gateway deployed remotely |

CrowClaw handles this configuration during bot creation — you don't need to edit MCP server entries manually.

## Tool Routing

When the bot connects to the gateway's `/router/mcp` endpoint, it sees 7 category tools instead of 49+ individual tools. This keeps the bot's context window lean. The bot can use `crow_discover` to look up full parameter schemas on demand. See [Context Management](/architecture/context-management) for details.

## Dual Memory Systems

Both the bot engine and Crow have memory systems. Use them as two layers:

| Layer | System | Purpose |
|---|---|---|
| Working memory | Bot engine (markdown) | Short-term session context, ephemeral notes |
| Long-term memory | Crow (SQLite/FTS5) | Persistent facts, preferences, cross-platform context |

- Use Crow's `crow_store_memory` for anything that should persist across sessions or be accessible from other platforms
- Let the bot's built-in memory handle short-term context naturally
- Don't sync the two systems — let each do what it's best at

## Skills

Skills are behavioral prompts (SKILL.md files) that teach bots specific workflows. Deploy them from the dashboard or via the `crow_deploy_skill` tool.

```markdown
---
name: crow-memory
description: Use Crow for persistent cross-platform memory
---

## When to Use Crow Memory

Use the `crow_store_memory` tool when:
- The user shares a preference or fact that should persist long-term
- Information needs to be accessible from other platforms
- Context is important enough to survive session resets
```

Skills are portable across bots. Language variants (English, Spanish, etc.) use different skill files with the same underlying tool calls.

## Safety

CrowClaw includes safety features for bot operations:

- **Confirm gate** — Destructive operations (deploy, delete bot, delete profile, remove skill) require a two-call confirmation pattern
- **Exec approvals** — Bot command execution can be restricted via allowlists
- **Content moderation** — Configurable content filters and PII detection
- **User allowlists** — Restrict which Discord/platform users can interact with the bot

## Related

- [Integration Overview](/guide/integration-overview) — How all three AI connection patterns work together
- [OpenClaw Platform Guide](/platforms/openclaw) — Setup and advanced configuration
- [Extensions](/guide/extensions) — Install CrowClaw and other extensions
- [CrowClaw Architecture](/architecture/crowclaw) — Technical deep dive: MCP tools, database, BYOAI bridge
- [Social & Messaging](/guide/social) — Nostr-based messaging
- [Sharing](/guide/sharing) — P2P data sharing with Hypercore
- [AI Providers (BYOAI)](/guide/ai-providers) — Built-in AI Chat configuration
