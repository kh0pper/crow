# Cline

Connect Crow to [Cline](https://github.com/cline/cline), the AI coding assistant VS Code extension.

## Option A: Local (stdio)

### Setup Steps

1. Clone and set up Crow:
   ```bash
   git clone https://github.com/kh0pper/crow.git
   cd crow
   npm run setup
   ```

2. In the Cline panel, click the **MCP Servers** icon (toolbar) → **Configure** → **Configure MCP Servers**. This opens Cline's MCP settings file (`cline_mcp_settings.json`, stored under VS Code's `globalStorage/saoudrizwan.claude-dev/settings/`). Add:
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

3. Reload VS Code.

## Option B: Remote (HTTP)

### Setup Steps

1. Deploy Crow ([Getting Started guide](../getting-started/))

2. In the Cline panel, open **MCP Servers** → **Remote Servers** and add the server name + URL, or edit `cline_mcp_settings.json` (via **Configure** → **Configure MCP Servers**):
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

3. Cline will handle OAuth when first connecting.

## Transport

- **Local**: stdio
- **Remote**: Streamable HTTP with OAuth 2.1

## Cross-Platform Context

Crow automatically delivers behavioral context when Cline connects — memory protocols and session management are active from the first message.

IDE platforms get minimal transparency output. MCP prompts (`session-start`, `crow-guide`, etc.) are available for deeper guidance. Memories stored from Cline are shared with all other connected platforms. See the [Cross-Platform Guide](/guide/cross-platform).

## Verification

In Cline's chat, try:

> "Store a memory that Cline is connected to Crow."
