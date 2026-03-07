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

3. Restart Windsurf.

## Option B: Remote (HTTP)

### Setup Steps

1. Deploy Crow ([Cloud Deploy Guide](../getting-started/cloud-deploy))

2. Edit `~/.codeium/windsurf/mcp_config.json`:
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

3. Windsurf will handle OAuth automatically when connecting.

## Transport

- **Local**: stdio
- **Remote**: Streamable HTTP with OAuth 2.1

## Verification

In Windsurf's Cascade chat, try:

> "Store a memory that Windsurf is connected to Crow."
