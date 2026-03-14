# Gemini

Connect Crow to Google's Gemini — both the Gemini CLI and Gemini in Google AI Studio/Enterprise.

## Gemini CLI — Local (stdio)

Best for development — runs Crow servers directly on your machine. No gateway required.

### Setup Steps

1. Clone and set up Crow locally:
   ```bash
   git clone https://github.com/kh0pper/crow.git
   cd crow
   npm run setup
   ```

2. Edit `~/.gemini/settings.json`:
   ```json
   {
     "mcpServers": {
       "crow-memory": {
         "command": "node",
         "args": ["/path/to/crow/servers/memory/index.js"],
         "env": {
           "CROW_DB_PATH": "/path/to/crow/data/crow.db"
         }
       },
       "crow-projects": {
         "command": "node",
         "args": ["/path/to/crow/servers/research/index.js"],
         "env": {
           "CROW_DB_PATH": "/path/to/crow/data/crow.db"
         }
       }
     }
   }
   ```

3. Restart Gemini CLI — it will detect the MCP servers automatically.

::: tip
Run `npm run mcp-config` in the Crow directory to generate a complete MCP config, then copy the relevant entries to your Gemini settings.
:::

## Gemini CLI — Remote (HTTP)

Connect to a deployed Crow gateway for the full platform including external integrations.

### Prerequisites

- Crow gateway deployed and healthy ([Cloud Deploy Guide](../getting-started/cloud-deploy))

### Setup Steps

1. Edit `~/.gemini/settings.json`:
   ```json
   {
     "mcpServers": {
       "crow-memory": {
         "url": "https://your-crow-server/memory/mcp"
       },
       "crow-projects": {
         "url": "https://your-crow-server/projects/mcp"
       },
       "crow-tools": {
         "url": "https://your-crow-server/tools/mcp"
       }
     }
   }
   ```

2. Start Gemini CLI — it will auto-discover the OAuth metadata and prompt for authorization.

## Google AI Studio

Google AI Studio supports MCP servers for tool use in chat. Configuration is available through the interface when creating a new chat or agent.

### Setup Steps

1. Open [Google AI Studio](https://aistudio.google.com)
2. Create a new chat or agent
3. In the tools section, add an MCP server
4. Enter the Streamable HTTP URL:
   ```
   https://your-crow-server/memory/mcp
   ```
5. Complete the OAuth authorization flow

## Self-Hosted / Local Setup

If you're running the Crow gateway on your own machine, you can expose it to Gemini using [Tailscale Funnel](../getting-started/tailscale-setup#option-a-tailscale-funnel-personal-hobby-use). Once Funnel is enabled on the machine running the gateway, your MCP endpoint URL will be:

```
https://<hostname>.<tailnet>.ts.net/memory/mcp
```

Replace `<hostname>` and `<tailnet>` with your Tailscale machine name and tailnet domain. Use the same URL pattern for other servers (`/projects/mcp`, `/router/mcp`, etc.). The setup steps are identical to the remote instructions above — just substitute your Funnel URL for `your-crow-server` in the Gemini settings.

See the [Tailscale Setup guide](../getting-started/tailscale-setup) for full configuration details.

## Transport

- **Type**: Streamable HTTP
- **Protocol**: `2025-03-26`
- **Auth**: OAuth 2.1 (automatic discovery)

## Cross-Platform Context

Crow automatically delivers behavioral context when Gemini connects — memory protocols, session management, and transparency rules are active from the first message. No manual loading required.

For detailed guidance, Gemini can request MCP prompts like `session-start`, `crow-guide` (with `platform: "gemini"`), or feature-specific guides (`research-guide`, `blog-guide`, `sharing-guide`).

You can also manually load the full context:

> "Use the crow_get_context tool with platform set to gemini"

Memories and projects stored from any platform are shared. See the [Cross-Platform Guide](/guide/cross-platform).

## Verification

Ask Gemini:

> "Store a memory that Gemini is connected to Crow."

Then verify:

> "Search memories for 'Gemini'."
