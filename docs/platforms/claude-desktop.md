# Claude Desktop

Connect Crow to Claude Desktop using local stdio transport. This runs the MCP servers directly on your machine — no cloud deployment needed.

## Prerequisites

- [Claude Desktop](https://claude.ai/download) installed
- Crow cloned and set up locally ([Desktop Setup Guide](../getting-started/desktop-setup))

## Setup Steps

1. Run the config generator:
   ```bash
   cd crow
   npm run desktop-config
   ```

2. Copy the output JSON into your Claude Desktop config file:
   - **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
   - **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
   - **Linux**: `~/.config/Claude/claude_desktop_config.json`

3. Restart Claude Desktop

The config will look something like:
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

## Transport

- **Type**: stdio (direct process)
- **Auth**: None needed (local process)

## Verification

After restarting Claude Desktop, look for the MCP server icons (hammer icon) in the input area. Click them to see available tools.

Try: "Store a memory that Crow Desktop is connected."

## Cross-Platform Context

Crow's shared behavioral context (`crow.md`) is available through the `crow_get_context` tool or `crow://context` resource. Load it at session start:

> "Load your crow.md context"

Memories stored in Claude Desktop are shared with all other connected platforms (Claude Web, ChatGPT, Gemini, etc.) when using the same database. See the [Cross-Platform Guide](/guide/cross-platform).

## Adding External Integrations

To use external integrations (GitHub, Slack, etc.) with Claude Desktop, add them directly to the Desktop config. The `.mcp.json` file in the Crow repo has all the configurations — merge them into your Desktop config file.

You'll need to replace `${VAR_NAME}` references with actual values or set them as environment variables.
