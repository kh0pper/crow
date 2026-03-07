# Claude Web & Mobile

Connect Crow to Claude on the web (claude.ai) or the Claude mobile app using Custom Integrations.

## Prerequisites

- Crow gateway deployed and healthy ([Cloud Deploy Guide](../getting-started/cloud-deploy))
- A Claude Pro, Team, or Enterprise plan (Custom Integrations require a paid plan)

## Setup Steps

1. Go to [claude.ai/settings](https://claude.ai/settings) → **Integrations**
2. Click **Add Custom Integration**
3. Enter a name (e.g., "Crow Memory")
4. Paste your gateway URL:
   ```
   https://your-gateway.onrender.com/memory/mcp
   ```
5. Click **Save** — Claude will initiate the OAuth flow
6. Authorize the connection when prompted

Repeat for each server you want to connect:

| Server | URL |
|---|---|
| Memory | `https://your-gateway.onrender.com/memory/mcp` |
| Research | `https://your-gateway.onrender.com/research/mcp` |
| External Tools | `https://your-gateway.onrender.com/tools/mcp` |

## Transport

- **Type**: Streamable HTTP
- **Protocol**: `2025-03-26`
- **Auth**: OAuth 2.1 (automatic)

## Verification

After connecting, try asking Claude:

> "Store a memory that Crow is now connected."

If it works, you'll see Crow's memory tools in action. You can verify stored memories by asking:

> "What do you remember?"

## Cross-Platform Context

Crow provides a shared behavioral context document (`crow.md`) that ensures consistent behavior across platforms. On Claude, the context is automatically available through the `crow_get_context` tool or the `crow://context` MCP resource.

To load Crow's full context at the start of a session:

> "Load your crow.md context"

This gives Claude all of Crow's behavioral instructions — memory protocols, transparency rules, and any custom sections you've configured. See the [Cross-Platform Guide](/guide/cross-platform) for more details.

## Tips

- You can connect all three servers (memory, research, tools) simultaneously
- The mobile app uses the same Custom Integrations as the web
- Tools from external integrations (GitHub, Slack, etc.) appear through the `/tools/mcp` endpoint
- Memories stored here are instantly accessible from ChatGPT, Gemini, or any other connected platform
