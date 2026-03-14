# OpenClaw Bridge

Connect Crow's capabilities to chat platforms (Discord, WhatsApp, Telegram, and others) through [OpenClaw](https://openclaw.ai).

## What Works Today

OpenClaw bots connect to Crow via MCP, giving them full access to Crow's tool suite. This means an OpenClaw bot on Discord or WhatsApp can store and search memories, manage projects, publish blog posts, send peer messages, and share data — the same tools available from Claude.ai or the Crow's Nest.

### Shared Data

Because OpenClaw connects via the same MCP servers as every other platform, all data is shared:

- Memories stored from Discord are searchable from Claude.ai
- A project created in the Crow's Nest AI Chat is visible to the OpenClaw bot
- Blog posts drafted from ChatGPT can be published from WhatsApp via OpenClaw
- Contacts, shared items, and messages are accessible everywhere

This is the standard Crow integration model — see the [Integration Overview](/guide/integration-overview) for the full picture.

### Connection Options

OpenClaw connects to Crow in two ways:

| Pattern | Transport | Auth | When to Use |
|---|---|---|---|
| **Local (stdio)** | Child process | None | OpenClaw and Crow on the same machine |
| **Remote (HTTP)** | Streamable HTTP | OAuth 2.1 | Crow gateway deployed remotely |

For setup steps, see the [OpenClaw platform guide](/platforms/openclaw).

### BYOAI + OpenClaw

If you have both BYOAI (Crow's Nest AI Chat) and OpenClaw configured, they complement each other:

- **OpenClaw** gives you Crow access from mobile chat apps — Discord, WhatsApp, Telegram, wherever you already are
- **BYOAI Chat** gives you a dedicated AI Chat interface in the Crow's Nest dashboard with provider choice and streaming
- Both write to the same database, so switching between them is seamless

### Tool Routing

When OpenClaw connects to the gateway's `/router/mcp` endpoint, it sees 7 category tools instead of 49+ individual tools. This keeps the bot's context window lean. The bot can use `crow_discover` to look up full parameter schemas on demand. See [Context Management](/architecture/context-management) for details.

For local (stdio) connections, OpenClaw can connect to individual servers (`crow-memory`, `crow-projects`, etc.) or use `crow-core` for the same on-demand activation pattern.

## Roadmap

The following features are planned but **not yet built**:

### Message Bridge

A two-way message bridge between Crow's Nostr messaging and OpenClaw's chat platforms:

- **Outbound**: `crow_send_message` with a platform routing hint would forward through OpenClaw's gateway to Discord, WhatsApp, Telegram, etc.
- **Inbound**: Messages from connected chat platforms would be forwarded to Crow's inbox via webhook, tagged with their source platform.
- **Single inbox**: All messages (Crow peers + chat platforms) in one place.

```
Crow AI ──► Crow Sharing Server ──► OpenClaw Gateway API ──► Chat Platforms
                (Nostr + Bridge)      (webhook relay)         (Discord,
                                                               Telegram,
                                                               WhatsApp)
```

This depends on OpenClaw's gateway API, which is still in development.

### Platform-Aware Contact Routing

Contacts would have linked accounts across platforms. When sending a message, Crow would automatically route through the best available channel — Nostr for Crow-to-Crow (end-to-end encrypted), or via OpenClaw's bridge for platform users.

::: info Privacy Note
Messages crossing the bridge would lose Nostr's end-to-end encryption and become subject to the destination platform's privacy policy. Crow-to-Crow messages would continue using Nostr for maximum privacy.
:::

## Related

- [Integration Overview](/guide/integration-overview) — How all three AI connection patterns work together
- [OpenClaw Platform Guide](/platforms/openclaw) — Setup steps for connecting OpenClaw to Crow
- [Social & Messaging](/guide/social) — Nostr-based messaging (available now)
- [Sharing](/guide/sharing) — P2P data sharing with Hypercore (available now)
- [AI Providers (BYOAI)](/guide/ai-providers) — Built-in AI Chat configuration
