# ChatGPT

::: danger Not available for self-hosted Crow (planned as a follow-on)
ChatGPT connects to MCP servers **from OpenAI's cloud**, so it can only reach a server that is publicly accessible on the internet. A self-hosted Crow is deliberately **not** reachable from the internet — that privacy posture is the product's core promise, not a missing feature. There is currently **no supported way** to connect ChatGPT to a private Crow. Public cloud-client access is **planned as a follow-on** after v1, behind a dedicated security review.

**Use instead:** any of the local MCP clients on the [platforms index](./index) — they run on your machine and reach your private Crow directly.
:::

The instructions below apply **only** to the unsupported, advanced case where you have made your gateway publicly reachable yourself (your own domain and reverse proxy — read [SECURITY.md](https://github.com/kh0pper/crow/blob/main/SECURITY.md) first). Tailscale Funnel is **not** such a path: Crow's gateway rejects funneled requests to MCP and OAuth routes by design.

## Prerequisites

- Crow gateway deployed, healthy, **and publicly reachable** (unsupported — see above)
- A ChatGPT plan with custom MCP access (behind **Developer Mode**; plan/region availability varies)

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

::: tip Transport note
ChatGPT historically required the **SSE** transport; newer ChatGPT releases also accept Streamable HTTP. If a `/sse` endpoint fails to connect, try the matching `/mcp` endpoint.
:::

## Self-Hosted Crow

A standard self-hosted Crow **cannot** be connected to ChatGPT — see the notice at the top of this page. In particular, **Tailscale Funnel does not work for this**: the gateway rejects funneled requests to every MCP and OAuth route (only the blog and a few public files are Funnel-safe). Earlier versions of this page documented a Funnel-based setup; that flow has never worked on current Crow and the instructions were removed.

## Verification

After connecting, try asking ChatGPT:

> "Use the memory tool to store that ChatGPT is connected to Crow."

Then verify:

> "Search my memories for 'ChatGPT'."

## Troubleshooting OAuth

If the connector fails to connect or tools don't appear:

- **Leave OAuth fields blank if prompted.** Crow uses Dynamic Client Registration — ChatGPT discovers OAuth endpoints automatically from the `.well-known` metadata.
- **Verify your gateway's OAuth metadata is reachable.** Visit `https://your-crow-server/.well-known/oauth-authorization-server` in your browser — you should see a JSON response with `authorization_endpoint`, `token_endpoint`, and `registration_endpoint`.
- **Check `CROW_GATEWAY_URL` in your `.env` file.** This must match your actual public URL exactly (including `https://`).
- **Start a new conversation after gateway restarts.** OAuth sessions are tied to the gateway process. When the gateway restarts, existing sessions become invalid.
- **Try the other transport.** Older ChatGPT builds require `/sse`; newer ones accept `/mcp`. If one fails, try the other.

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

ChatGPT connects via the gateway. If you have many integrations enabled, consider using the `/router/mcp` endpoint instead of connecting each server individually. The router consolidates 126+ tools into 10 category tools, reducing context window usage:

```
https://your-crow-server/router/sse
```

See the [Context & Performance guide](/guide/context-performance) for more details.

## Limitations

- ChatGPT's MCP support may vary by plan and region
- The SSE transport is a legacy protocol but is fully functional
- Tool calling behavior may differ slightly from Claude
