# Cursor

Connect Crow to [Cursor](https://cursor.com), the AI-powered code editor.

## Option A: Local (stdio)

Run Crow servers locally for direct integration.

### Setup Steps

1. Clone and set up Crow:
   ```bash
   git clone https://github.com/kh0pper/crow.git
   cd crow
   npm run setup
   ```

2. Create `.cursor/mcp.json` in your project root:
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
       "crow-research": {
         "command": "node",
         "args": ["/path/to/crow/servers/research/index.js"],
         "env": {
           "CROW_DB_PATH": "/path/to/crow/data/crow.db"
         }
       }
     }
   }
   ```

3. Restart Cursor to load the MCP servers.

## Option B: Remote (HTTP)

Connect to a deployed Crow gateway.

### Setup Steps

1. Deploy Crow ([Cloud Deploy Guide](../getting-started/cloud-deploy))

2. Create `.cursor/mcp.json`:
   ```json
   {
     "mcpServers": {
       "crow-memory": {
         "url": "https://your-gateway.onrender.com/memory/mcp"
       },
       "crow-research": {
         "url": "https://your-gateway.onrender.com/research/mcp"
       },
       "crow-tools": {
         "url": "https://your-gateway.onrender.com/tools/mcp"
       }
     }
   }
   ```

3. Cursor will handle the OAuth flow automatically.

## Transport

- **Local**: stdio
- **Remote**: Streamable HTTP with OAuth 2.1

## Cross-Platform Context

Load Crow's shared behavioral context in Cursor:

> "Use the crow_get_context tool with platform set to cursor"

IDE platforms get minimal transparency output — only Tier 2 checkpoints. Memories and research stored from Cursor are shared with all other connected platforms. See the [Cross-Platform Guide](/guide/cross-platform).

## Verification

In Cursor's AI chat, try:

> "Store a memory that Cursor is connected to Crow."
