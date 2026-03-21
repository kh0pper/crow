# ChatGPT

Connect Crow to ChatGPT using the SSE transport. ChatGPT supports MCP through its Apps/Connectors feature.

## Prerequisites

- Crow gateway deployed and healthy ([Cloud Deploy Guide](../getting-started/cloud-deploy))
- A ChatGPT Plus or Team plan

## Setup Steps

1. Go to [ChatGPT Settings](https://chat.openai.com/settings) → **Apps** (or **Connectors**)
2. Click **Create** or **Add MCP Server**
3. Enter your Crow SSE endpoint URL:
   ```
   https://your-crow-server/memory/sse
   ```
4. ChatGPT will discover the OAuth metadata and initiate authorization
5. Authorize the connection when prompted

Repeat for additional servers:

| Server | SSE URL |
|---|---|
| Memory | `https://your-crow-server/memory/sse` |
| Projects | `https://your-crow-server/projects/sse` |
| External Tools | `https://your-crow-server/tools/sse` |

## Transport

- **Type**: SSE (Server-Sent Events)
- **Protocol**: `2024-11-05`
- **Auth**: OAuth 2.1 (automatic discovery)

::: tip Important
ChatGPT uses the **SSE** transport, not Streamable HTTP. Use the `/sse` endpoints, not the `/mcp` endpoints.
:::

## Self-Hosted / Local Setup

If you're running the Crow gateway on your own machine, you can expose it to ChatGPT using [Tailscale Funnel](../getting-started/tailscale-setup#option-a-tailscale-funnel-personal-hobby-use). Once Funnel is enabled on the machine running the gateway, your SSE endpoint URL will be:

```
https://<hostname>.<tailnet>.ts.net/memory/sse
```

Replace `<hostname>` and `<tailnet>` with your Tailscale machine name and tailnet domain. Use the same URL pattern for other servers (`/projects/sse`, `/router/sse`, etc.). The OAuth flow and setup steps are identical to the cloud instructions above — just substitute your Funnel URL for `your-crow-server`.

See the [Tailscale Setup guide](../getting-started/tailscale-setup) for full configuration details.

## Verification

After connecting, try asking ChatGPT:

> "Use the memory tool to store that ChatGPT is connected to Crow."

Then verify:

> "Search my memories for 'ChatGPT'."

## Troubleshooting OAuth

If the connector fails to connect or tools don't appear:

- **Leave OAuth fields blank if prompted.** Crow uses Dynamic Client Registration — ChatGPT discovers OAuth endpoints automatically from the `.well-known` metadata.
- **Verify your gateway's OAuth metadata is reachable.** Visit `https://your-crow-server/.well-known/oauth-authorization-server` in your browser — you should see a JSON response with `authorization_endpoint`, `token_endpoint`, and `registration_endpoint`.
- **Check `CROW_GATEWAY_URL` in your `.env` file.** This must match your actual public URL exactly (including `https://`). If you're using Tailscale Funnel, it should be `https://<hostname>.<tailnet>.ts.net`.
- **Start a new conversation after gateway restarts.** OAuth sessions are tied to the gateway process. When the gateway restarts, existing sessions become invalid.
- **Use the `/sse` endpoints, not `/mcp`.** ChatGPT uses the SSE transport, not Streamable HTTP.

## Cross-Platform Context

Crow automatically delivers behavioral context when ChatGPT connects. During the MCP handshake, ChatGPT receives Crow's identity, memory protocols, session protocol, and transparency rules — no manual setup required.

This means ChatGPT knows to recall relevant memories at the start of each conversation and store important information automatically.

For deeper guidance, ChatGPT can request MCP prompts:

- **session-start** — Detailed session start/end protocol
- **crow-guide** — Full crow.md document (use with `platform: "chatgpt"` for ChatGPT-specific formatting)
- **research-guide** / **blog-guide** / **sharing-guide** — Workflow guidance for specific features

You can also manually load the full context:

> "Use the crow_get_context tool with platform set to chatgpt"

Or fetch it via HTTP:

```
GET https://your-crow-server/crow.md?platform=chatgpt
```

Any memories you store in ChatGPT are instantly available from Claude, Gemini, or any other connected platform. See the [Cross-Platform Guide](/guide/cross-platform) for more details.

## Context Optimization

ChatGPT connects via the gateway. If you have many integrations enabled, consider using the `/router/mcp` endpoint instead of connecting each server individually. The router consolidates 49+ tools into 7 category tools, reducing context window usage:

```
https://your-crow-server/router/sse
```

See the [Context & Performance guide](/guide/context-performance) for more details.

## Limitations

- ChatGPT's MCP support may vary by plan and region
- The SSE transport is a legacy protocol but is fully functional
- Tool calling behavior may differ slightly from Claude
