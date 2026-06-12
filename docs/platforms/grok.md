# Grok (xAI)

Connect Crow to xAI's Grok using its Remote MCP Tools support.

## Prerequisites

- Crow gateway deployed and healthy ([Cloud Deploy Guide](../getting-started/cloud-deploy))
- An xAI API account

Either path requires your Crow gateway to be reachable from the public internet (xAI's servers call it directly) — a Tailscale-only gateway won't work for Grok. Remember the [network-exposure rules](https://github.com/kh0pper/crow/blob/main/SECURITY.md#whats-public-by-default) before exposing MCP endpoints publicly.

## Option A: grok.com Connectors (consumer UI)

1. Go to **grok.com → Connectors → Custom** and add a custom MCP connector.
2. Enter your Crow MCP server URL (e.g. `https://your-crow-server/router/mcp`).
3. Complete the OAuth authorization when prompted — Crow's gateway supports the OAuth 2.1 flow Connectors uses.

## Option B: xAI API — Remote MCP Tools

Declare Crow as an MCP entry in the `tools` array of your API request:

```json
{
  "tools": [
    {
      "type": "mcp",
      "server_url": "https://your-crow-server/router/mcp",
      "server_label": "crow",
      "authorization": "YOUR_ACCESS_TOKEN"
    }
  ]
}
```

The `authorization` value is sent to Crow as a `Bearer` header. To mint a token, register a client via the gateway's `/register` endpoint and complete the OAuth flow to obtain an access token (see [OAuth 2.1](/architecture/gateway#oauth-2-1)). Optional fields: `server_description`, `allowed_tools`, `headers`.

## Transport

- **Type**: Streamable HTTP (or SSE)
- **Protocol**: `2025-03-26`
- **Auth**: OAuth 2.1 (Connectors) or Bearer via the `authorization` field (API)

## Cross-Platform Context

Crow automatically delivers behavioral context when Grok connects — memory protocols, session management, and transparency rules are active from the first message.

For detailed guidance, Grok can request MCP prompts like `session-start`, `crow-guide` (with `platform: "grok"`), or feature-specific guides.

You can also manually load the full context:

> "Use the crow_get_context tool with platform set to grok"

Or fetch via HTTP: `GET https://your-crow-server/crow.md?platform=grok`

Memories and projects stored from any platform are shared. See the [Cross-Platform Guide](/guide/cross-platform).

## Verification

Use Grok's tool calling to test:

> "Use the crow_store_memory tool to store that Grok is connected."
