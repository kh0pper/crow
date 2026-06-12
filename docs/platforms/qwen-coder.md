# Qwen Code

Connect Crow to [Qwen Code](https://github.com/QwenLM/qwen-code), the `qwen` terminal coding agent from Alibaba's Qwen team. (Earlier versions of these docs covered it on two pages as "Qwen CLI" and "Qwen Coder CLI" — it's one tool, and this is its page.)

## Prerequisites

- Node.js 18 or later
- Qwen Code installed and configured
- Crow cloned and set up locally (for stdio) or a deployed gateway (for remote)

## Option A: Local (stdio)

Best for development — runs Crow servers directly on your machine. No gateway or network required.

### Setup Steps

1. Clone and set up Crow:
   ```bash
   git clone https://github.com/kh0pper/crow.git
   cd crow
   npm run setup
   ```

2. Add Crow servers to your project's `.qwen/mcp.json` or `~/.qwen/mcp.json` (global) under `mcpServers`:
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

   Replace `/path/to/crow` with the absolute path where you cloned Crow.

3. Restart Qwen Code — it will detect the MCP servers automatically.

::: tip
Run `npm run mcp-config` in the Crow directory to generate a complete MCP config covering every available server (sharing, blog, storage, …). Copy the relevant entries into your Qwen config file.
:::

### Transport

- **Type**: stdio
- **Auth**: None (local process)

### Combined server (lighter footprint)

If you prefer a single entry point rather than separate servers, use the `crow-core` combined server. It starts with memory tools active and loads other servers on demand:

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

- Crow gateway deployed and reachable ([Getting Started](../getting-started/) or [Tailscale Setup](../getting-started/tailscale-setup))

### Setup Steps

1. Edit `.qwen/mcp.json` (project) or `~/.qwen/mcp.json` (global):
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

   For a Tailscale-accessible gateway, use the Tailscale address — and consider the [router endpoint](/guide/context-performance) for a much smaller tool surface:
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

2. On first use, Qwen Code will open the OAuth flow in your browser to authorize.

### Transport

- **Type**: Streamable HTTP
- **Protocol**: `2025-03-26`
- **Auth**: OAuth 2.1 (automatic discovery)

## Verification

Start Qwen Code and ask:

```
Store a memory that Qwen Code is connected to Crow.
```

Then verify it was saved:

```
Search my memories for "Qwen".
```

## Cross-Platform Context

Crow automatically delivers behavioral context when Qwen Code connects via MCP — memory protocols, session management, and transparency rules are active from the first message.

For more detailed guidance, ask Qwen to use MCP prompts: `session-start`, `crow-guide`, `project-guide`, `blog-guide`, or `sharing-guide`.

Memories and projects stored via Qwen Code are immediately available on all other connected platforms. See the [Cross-Platform Guide](/guide/cross-platform).

## Tips

- Use the project-level `.qwen/mcp.json` to share config with your team; `~/.qwen/mcp.json` applies globally across projects
- Run `npm run mcp-config` in the Crow directory to generate a full config, then copy the relevant entries
- The `crow-storage` server requires MinIO — see the [Storage guide](/guide/storage) for setup and the env vars it needs
- Qwen Code follows a `.mcp.json`-style config format similar to Claude Code
