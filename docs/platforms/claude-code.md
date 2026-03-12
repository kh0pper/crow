# Claude Code (CLI)

Connect Crow to [Claude Code](https://docs.anthropic.com/en/docs/claude-code), Anthropic's CLI tool for using Claude in the terminal.

## Option A: Local (stdio)

Best for development — runs Crow servers directly on your machine.

### Setup Steps

1. Clone and set up Crow locally:
   ```bash
   git clone https://github.com/kh0pper/crow.git
   cd crow
   npm run setup
   ```

2. Add to your project's `.mcp.json` (per-project) or `~/.claude/mcp.json` (global):
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

3. Restart Claude Code — it will automatically detect the MCP servers.

### Transport

- **Type**: stdio
- **Auth**: None (local process)

## Option B: Remote (HTTP)

Connect to a deployed Crow gateway for access to the full platform including external integrations.

### Setup Steps

1. Deploy Crow ([Cloud Deploy Guide](../getting-started/cloud-deploy))

2. Add to `.mcp.json`:
   ```json
   {
     "mcpServers": {
       "crow-memory": {
         "type": "url",
         "url": "https://your-gateway.onrender.com/memory/mcp"
       },
       "crow-projects": {
         "type": "url",
         "url": "https://your-gateway.onrender.com/projects/mcp"
       },
       "crow-tools": {
         "type": "url",
         "url": "https://your-gateway.onrender.com/tools/mcp"
       }
     }
   }
   ```

3. On first use, Claude Code will open the OAuth flow in your browser to authorize.

### Transport

- **Type**: Streamable HTTP
- **Auth**: OAuth 2.1 (automatic)

## Verification

Start Claude Code and try:

```
> Store a memory that Claude Code is connected to Crow
```

Check it worked:

```
> What do you remember?
```

## Cross-Platform Context

Crow automatically delivers behavioral context when Claude Code connects via MCP — memory protocols, session management, and transparency rules are active from the first message.

Claude Code users also have access to skill files in `skills/` and the project-level `CLAUDE.md`, which provide additional platform-specific guidance beyond what MCP instructions deliver.

For detailed guidance via MCP, use prompts: `session-start`, `crow-guide`, `research-guide`, `blog-guide`, `sharing-guide`. Or use `crow_get_context` with `platform: "claude"`. Memories stored via Claude Code are shared with all other connected platforms. See the [Cross-Platform Guide](/guide/cross-platform).

::: tip Already set up on claude.ai?
If you've added Crow as a Custom Integration on claude.ai, those MCP servers are also available in Claude Code CLI without additional configuration — Anthropic's ecosystem shares connector settings across Claude products. No need to duplicate setup in `.mcp.json`. This sharing behavior is specific to Claude; other platforms (ChatGPT, Gemini) manage their MCP connections independently.
:::

## Tips

- Use the project-level `.mcp.json` to share Crow config with your team
- Use `~/.claude/mcp.json` for global access across all projects
- The Crow repo itself includes a `.mcp.json` with all MCP servers pre-configured
