# Qwen CLI

Connect Crow to [Qwen Chat / Qwen Coder](https://github.com/QwenLM/qwen-agent), Alibaba's AI assistant and coding tool.

## Prerequisites

- Node.js 18 or later
- Crow cloned and set up locally (for stdio) or a deployed gateway (for remote)
- Qwen CLI installed and configured

## Option A: Local (stdio)

Best for development — runs Crow servers directly on your machine. No gateway or network required.

### Setup Steps

1. Clone and set up Crow:
   ```bash
   git clone https://github.com/kh0pper/crow.git
   cd crow
   npm run setup
   ```

2. Edit `~/.qwen/mcp.json` and add Crow servers under `mcpServers`:
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

3. Restart Qwen CLI — it will detect the MCP servers automatically.

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

Then copy the `crow-core` entry from the generated `.mcp.json` into `~/.qwen/mcp.json`.

## Option B: Gateway (HTTP)

Connect to a deployed Crow gateway for remote access — useful for Tailscale setups or cloud deployments.

### Prerequisites

- Crow gateway deployed and reachable ([Cloud Deploy Guide](../getting-started/cloud-deploy) or [Tailscale Setup](../getting-started/tailscale-setup))

### Setup Steps

1. Edit `~/.qwen/mcp.json`:
   ```json
   {
     "mcpServers": {
       "crow-memory": {
         "type": "url",
         "url": "https://your-crow-server/memory/mcp"
       },
       "crow-projects": {
         "type": "url",
         "url": "https://your-crow-server/projects/mcp"
       },
       "crow-tools": {
         "type": "url",
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
         "type": "url",
         "url": "http://100.x.x.x:3001/router/mcp"
       }
     }
   }
   ```

2. On first use, Qwen CLI will open the OAuth flow in your browser to authorize.

### Transport

- **Type**: Streamable HTTP
- **Protocol**: `2025-03-26`
- **Auth**: OAuth 2.1 (automatic discovery)

## Verification

Start Qwen CLI and ask:

```
Store a memory that Qwen CLI is connected to Crow.
```

Then verify it was saved:

```
Search my memories for "Qwen".
```

## Cross-Platform Context

Crow automatically delivers behavioral context when Qwen CLI connects via MCP — memory protocols, session management, and transparency rules are active from the first message.

For more detailed guidance, ask Qwen to use MCP prompts: `session-start`, `crow-guide`, `project-guide`, `blog-guide`, or `sharing-guide`.

Memories and projects stored via Qwen CLI are immediately available on all other connected platforms. See the [Cross-Platform Guide](/guide/cross-platform).

## Tips

- Qwen CLI uses `~/.qwen/mcp.json` for global MCP configuration
- Run `npm run mcp-config` in the Crow directory to generate a full config, then copy the relevant entries into `~/.qwen/mcp.json`
- The `crow-storage` server requires MinIO; omit it if you are not using file storage
- For per-project isolation, place a `mcp.json` in a `.qwen/` directory at your project root
