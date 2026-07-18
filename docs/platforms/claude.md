# Claude Web & Mobile

::: danger Not available for self-hosted Crow (planned as a follow-on)
claude.ai and the Claude mobile app connect to MCP servers **from Anthropic's cloud**, so they can only reach a server that is publicly accessible on the internet. A self-hosted Crow is deliberately **not** reachable from the internet — that privacy posture is the product's core promise, not a missing feature. There is currently **no supported way** to connect claude.ai or the Claude mobile app to a private Crow. Public cloud-client access is **planned as a follow-on** after v1, behind a dedicated security review.

**Use instead:** [Claude Desktop](./claude-desktop) or [Claude Code](./claude-code) — both run on your own machine, reach your private Crow directly, and share the same memories.
:::

The instructions below apply **only** to the unsupported, advanced case where you have made your gateway publicly reachable yourself (your own domain and reverse proxy — read [SECURITY.md](https://github.com/kh0pper/crow/blob/main/SECURITY.md) first). Tailscale Funnel is **not** such a path: Crow's gateway rejects funneled requests to MCP and OAuth routes by design.

## Prerequisites

- Crow gateway deployed, healthy, **and publicly reachable** (unsupported — see above)
- A Claude plan that supports custom connectors (Free currently includes one connector; paid plans allow more)

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

## Self-Hosted Crow

A standard self-hosted Crow **cannot** be connected to claude.ai — see the notice at the top of this page. In particular, **Tailscale Funnel does not work for this**: the gateway rejects funneled requests to every MCP and OAuth route (only the blog and a few public files are Funnel-safe). Earlier versions of this page documented a Funnel-based setup; that flow has never worked on current Crow and the instructions were removed.

Your self-hosted Crow works today with the local clients on the [platforms index](./index) — Claude Desktop and Claude Code give you the same Claude models with full access to your private Crow.

## Verification

After connecting, try asking Claude:

> "Store a memory that Crow is now connected."

If it works, you'll see Crow's memory tools in action. You can verify stored memories by asking:

> "What do you remember?"

## Troubleshooting OAuth

If the connector fails to connect or tools don't appear:

- **Leave OAuth Client ID and Client Secret blank.** Crow uses Dynamic Client Registration (RFC 7591) — Claude discovers the OAuth endpoints automatically from the `.well-known` metadata. No pre-configured credentials needed.
- **Verify your gateway's OAuth metadata is reachable.** Visit `https://your-crow-server/.well-known/oauth-authorization-server` in your browser — you should see a JSON response with `authorization_endpoint`, `token_endpoint`, and `registration_endpoint`.
- **Check `CROW_GATEWAY_URL` in your `.env` file.** This must match your actual public URL exactly (including `https://`).
- **Start a new conversation after gateway restarts.** OAuth sessions are tied to the gateway process. When the gateway restarts, existing Claude.ai sessions become invalid — start a fresh conversation to re-authenticate.
- **Check gateway logs for OAuth errors.** If running via systemd: `journalctl -u crow-gateway -f`. Look for errors in the `/register`, `/authorize`, or `/token` endpoints.

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

For Claude via the gateway, the `/router/mcp` endpoint reduces the tool count from 126+ to 10 consolidated category tools, significantly reducing context window usage. Instead of connecting each server individually, you can connect a single router endpoint:

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
