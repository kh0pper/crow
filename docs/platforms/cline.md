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

2. Open VS Code Settings → search for "Cline MCP" → edit the MCP server configuration, or create `~/.cline/mcp_config.json`:
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

3. Reload VS Code.

## Option B: Remote (HTTP)

### Setup Steps

1. Deploy Crow ([Cloud Deploy Guide](../getting-started/cloud-deploy))

2. Add to Cline's MCP configuration:
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
