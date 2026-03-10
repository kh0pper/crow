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
   https://your-gateway.onrender.com/memory/sse
   ```
4. ChatGPT will discover the OAuth metadata and initiate authorization
5. Authorize the connection when prompted

Repeat for additional servers:

| Server | SSE URL |
|---|---|
| Memory | `https://your-gateway.onrender.com/memory/sse` |
| Research | `https://your-gateway.onrender.com/research/sse` |
| External Tools | `https://your-gateway.onrender.com/tools/sse` |

## Transport

- **Type**: SSE (Server-Sent Events)
- **Protocol**: `2024-11-05`
- **Auth**: OAuth 2.1 (automatic discovery)

::: tip Important
ChatGPT uses the **SSE** transport, not Streamable HTTP. Use the `/sse` endpoints, not the `/mcp` endpoints.
:::

## Verification

After connecting, try asking ChatGPT:

> "Use the memory tool to store that ChatGPT is connected to Crow."

Then verify:

> "Search my memories for 'ChatGPT'."

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
GET https://your-gateway.onrender.com/crow.md?platform=chatgpt
```

Any memories you store in ChatGPT are instantly available from Claude, Gemini, or any other connected platform. See the [Cross-Platform Guide](/guide/cross-platform) for more details.

## Context Optimization

ChatGPT connects via the gateway. If you have many integrations enabled, consider using the `/router/mcp` endpoint instead of connecting each server individually. The router consolidates 49+ tools into 7 category tools, reducing context window usage:

```
https://your-gateway.onrender.com/router/sse
```

See the [Context & Performance guide](/guide/context-performance) for more details.

## Limitations

- ChatGPT's MCP support may vary by plan and region
- The SSE transport is a legacy protocol but is fully functional
- Tool calling behavior may differ slightly from Claude
