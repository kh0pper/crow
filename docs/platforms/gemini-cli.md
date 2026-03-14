# Gemini CLI

Connect Crow to [Gemini CLI](https://github.com/google-gemini/gemini-cli), Google's AI assistant for the terminal.

## Prerequisites

- Node.js 18 or later
- Crow cloned and set up locally (for stdio) or a deployed gateway (for remote)
- Gemini CLI installed (`npm install -g @google/gemini-cli`)

## Option A: Local (stdio)

Best for development — runs Crow servers directly on your machine. No gateway or network required.

### Setup Steps

1. Clone and set up Crow:
   ```bash
   git clone https://github.com/kh0pper/crow.git
   cd crow
   npm run setup
   ```

2. Edit `~/.gemini/settings.json` and add Crow servers under `mcpServers`:
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
       },
       "crow-sharing": {
         "command": "node",
         "args": ["/path/to/crow/servers/sharing/index.js"],
         "env": {
           "CROW_DB_PATH": "/path/to/crow/data/crow.db"
         }
       },
       "crow-blog": {
         "command": "node",
         "args": ["/path/to/crow/servers/blog/index.js"],
         "env": {
           "CROW_DB_PATH": "/path/to/crow/data/crow.db"
         }
       },
       "crow-storage": {
         "command": "node",
         "args": ["/path/to/crow/servers/storage/index.js"],
         "env": {
           "CROW_DB_PATH": "/path/to/crow/data/crow.db",
           "MINIO_ENDPOINT": "localhost",
           "MINIO_PORT": "9000",
           "MINIO_ACCESS_KEY": "your-access-key",
           "MINIO_SECRET_KEY": "your-secret-key"
         }
       }
     }
   }
   ```

   Replace `/path/to/crow` with the absolute path where you cloned Crow. Omit `crow-storage` if you are not running MinIO.

3. Restart Gemini CLI — it will detect the MCP servers automatically.

### Transport

- **Type**: stdio
- **Auth**: None (local process)

### Combined server (lighter footprint)

If you prefer a single entry point rather than five separate servers, use the `crow-core` combined server. It starts with memory tools active and loads other servers on demand:

```json
{
  "mcpServers": {
    "crow-core": {
      "command": "node",
      "args": ["/path/to/crow/servers/core/index.js"],
      "env": {
        "CROW_DB_PATH": "/path/to/crow/data/crow.db"
      }
    }
  }
}
```

Or generate the config automatically:

```bash
cd /path/to/crow
npm run mcp-config -- --combined
```

Then copy the `crow-core` entry from the generated `.mcp.json` into `~/.gemini/settings.json`.

## Option B: Gateway (HTTP)

Connect to a deployed Crow gateway for remote access — useful for Tailscale setups or cloud deployments.

### Prerequisites

- Crow gateway deployed and reachable ([Cloud Deploy Guide](../getting-started/cloud-deploy) or [Tailscale Setup](../getting-started/tailscale-setup))

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

   For a Tailscale-accessible gateway, use the Tailscale address instead:
   ```json
   {
     "mcpServers": {
       "crow": {
         "url": "http://100.x.x.x:3001/router/mcp"
       }
     }
   }
   ```

2. Start Gemini CLI — it will auto-discover OAuth metadata and prompt for authorization on first use.

### Transport

- **Type**: Streamable HTTP
- **Protocol**: `2025-03-26`
- **Auth**: OAuth 2.1 (automatic discovery)

## Verification

Start Gemini CLI and ask:

```
Store a memory that Gemini CLI is connected to Crow.
```

Then verify it was saved:

```
Search my memories for "Gemini".
```

## Cross-Platform Context

Crow automatically delivers behavioral context when Gemini CLI connects via MCP — memory protocols, session management, and transparency rules are active from the first message.

For more detailed guidance, ask Gemini to use MCP prompts: `session-start`, `crow-guide` (accepts `platform: "gemini"` argument), `project-guide`, `blog-guide`, or `sharing-guide`.

Memories and projects stored via Gemini CLI are immediately available on all other connected platforms. See the [Cross-Platform Guide](/guide/cross-platform).

## Tips

- Gemini CLI looks for `~/.gemini/settings.json` globally — there is no per-project config file like Claude Code's `.mcp.json`
- Run `npm run mcp-config` in the Crow directory to generate a full config, then copy the relevant entries into `settings.json`
- The `crow-storage` server requires MinIO; omit it if you are not using file storage
