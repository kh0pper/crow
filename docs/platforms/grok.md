# Grok (xAI)

Connect Crow to xAI's Grok using its Remote MCP Tools support.

## Prerequisites

- Crow gateway deployed and healthy ([Cloud Deploy Guide](../getting-started/cloud-deploy))
- An xAI API account

## Setup Steps

Grok supports remote MCP servers through its API. Configure Crow as a remote tool source:

1. In your Grok/xAI configuration, add a remote MCP server:
   ```json
   {
     "mcp_servers": [
       {
         "url": "https://your-crow-server/memory/mcp",
         "name": "crow-memory"
       },
       {
         "url": "https://your-crow-server/projects/mcp",
         "name": "crow-projects"
       },
       {
         "url": "https://your-crow-server/tools/mcp",
         "name": "crow-tools"
       }
     ]
   }
   ```

2. If using OAuth, the client will need to complete the authorization flow. If using bearer tokens, you can generate a token via the gateway's OAuth flow and pass it directly.

## Transport

- **Type**: Streamable HTTP
- **Protocol**: `2025-03-26`
- **Auth**: OAuth 2.1 or Bearer token

## Using Bearer Tokens

If your Grok client doesn't support OAuth discovery, you can:

1. Register a client manually via the `/register` endpoint
2. Complete the OAuth flow to get an access token
3. Pass the token as a `Bearer` header in requests

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
