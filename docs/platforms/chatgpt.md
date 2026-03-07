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

## Limitations

- ChatGPT's MCP support may vary by plan and region
- The SSE transport is a legacy protocol but is fully functional
- Tool calling behavior may differ slightly from Claude
