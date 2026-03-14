# Qwen Coder CLI

Connect Crow to [Qwen Coder CLI](https://github.com/QwenLM/qwen-coder-cli), the terminal-based coding assistant from Alibaba's Qwen team.

## Option A: Local (stdio)

Best for development — runs Crow servers directly on your machine.

### Setup Steps

1. Clone and set up Crow locally:
   ```bash
   git clone https://github.com/kh0pper/crow.git
   cd crow
   npm run setup
   ```

2. Add to your project's `.qwen/mcp.json` or `~/.qwen/mcp.json` (global):
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

3. Restart Qwen Coder CLI — it will detect the MCP servers automatically.

::: tip
Run `npm run mcp-config` in the Crow directory to generate a complete MCP config. Copy the relevant entries to your Qwen config file.
:::

### Transport

- **Type**: stdio
- **Auth**: None (local process)

## Option B: Remote (HTTP)

Connect to a deployed Crow gateway for access to the full platform.

### Prerequisites

- Crow gateway deployed and healthy ([Cloud Deploy Guide](../getting-started/cloud-deploy))

### Setup Steps

1. Add to `.qwen/mcp.json`:
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

2. On first use, Qwen Coder CLI will open the OAuth flow to authorize.

### Transport

- **Type**: Streamable HTTP
- **Protocol**: `2025-03-26`
- **Auth**: OAuth 2.1 (automatic discovery)

## Cross-Platform Context

Crow automatically delivers behavioral context when Qwen Coder connects — memory protocols, session management, and transparency rules are active from the first message.

For detailed guidance, use MCP prompts: `session-start`, `crow-guide`, `project-guide`, `blog-guide`, `sharing-guide`. Memories stored from any platform are shared. See the [Cross-Platform Guide](/guide/cross-platform).

## Verification

Start Qwen Coder CLI and try:

> "Store a memory that Qwen Coder is connected to Crow."

Then verify:

> "Search memories for 'Qwen'."

## Tips

- Use the project-level `.qwen/mcp.json` to share config with your team
- Use `~/.qwen/mcp.json` for global access across all projects
- Qwen Coder follows a `.mcp.json`-style config format similar to Claude Code
