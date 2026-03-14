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

3. Cursor will handle the OAuth flow automatically.

## Transport

- **Local**: stdio
- **Remote**: Streamable HTTP with OAuth 2.1

## Cross-Platform Context

Crow automatically delivers behavioral context when Cursor connects — memory protocols and session management are active from the first message.

IDE platforms get minimal transparency output — only Tier 2 checkpoints. MCP prompts (`session-start`, `crow-guide`, etc.) are available for deeper guidance. Memories and projects stored from Cursor are shared with all other connected platforms. See the [Cross-Platform Guide](/guide/cross-platform).

## Context Optimization

Cursor uses stdio transport locally. For a lighter setup, `crow-core` provides a single combined entry point that activates servers on demand instead of running all of them simultaneously. Generate a combined config with:

```bash
npm run mcp-config -- --combined
```

This creates a single `crow-core` entry in `.mcp.json` instead of separate entries for each server. For remote deployments, the `/router/mcp` endpoint offers similar consolidation. See the [Context & Performance guide](/guide/context-performance) for details.

## Verification

In Cursor's AI chat, try:

> "Store a memory that Cursor is connected to Crow."
