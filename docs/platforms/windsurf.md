# Windsurf

Connect Crow to [Windsurf](https://codeium.com/windsurf), the AI-powered IDE by Codeium.

## Option A: Local (stdio)

### Setup Steps

1. Clone and set up Crow:
   ```bash
   git clone https://github.com/kh0pper/crow.git
   cd crow
   npm run setup
   ```

2. Edit `~/.codeium/windsurf/mcp_config.json`:
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

3. Restart Windsurf.

## Option B: Remote (HTTP)

### Setup Steps

1. Deploy Crow ([Cloud Deploy Guide](../getting-started/cloud-deploy))

2. Edit `~/.codeium/windsurf/mcp_config.json`:
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

3. Windsurf will handle OAuth automatically when connecting.

## Transport

- **Local**: stdio
- **Remote**: Streamable HTTP with OAuth 2.1

## Cross-Platform Context

Crow automatically delivers behavioral context when Windsurf connects — memory protocols and session management are active from the first message.

IDE platforms get minimal transparency output. MCP prompts (`session-start`, `crow-guide`, etc.) are available for deeper guidance. Memories stored from Windsurf are shared with all other connected platforms. See the [Cross-Platform Guide](/guide/cross-platform).

## Verification

In Windsurf's Cascade chat, try:

> "Store a memory that Windsurf is connected to Crow."
