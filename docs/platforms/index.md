# Platform Compatibility

Crow uses the open [Model Context Protocol (MCP)](https://modelcontextprotocol.io) standard. Any MCP-compatible AI client can connect to Crow's gateway — no vendor-specific extensions are used.

## Compatibility Matrix

| Platform | Transport | Auth | Setup Difficulty | Status |
|---|---|---|---|---|
| [Claude Web & Mobile](./claude) | Streamable HTTP | OAuth 2.1 | Easy | Fully tested |
| [Claude Desktop](./claude-desktop) | stdio | N/A (local) | Easy | Fully tested |
| [Claude Code (CLI)](./claude-code) | stdio / HTTP | OAuth 2.1 | Easy | Fully tested |
| [ChatGPT](./chatgpt) | SSE | OAuth 2.1 | Easy | Compatible |
| [Gemini](./gemini) | stdio / HTTP | OAuth 2.1 | Easy | Compatible |
| [Grok (xAI)](./grok) | Streamable HTTP | Bearer token | Medium | Compatible |
| [Cursor](./cursor) | stdio / HTTP | Varies | Easy | Compatible |
| [Windsurf](./windsurf) | stdio / HTTP | Varies | Easy | Compatible |
| [Cline](./cline) | stdio / HTTP | Varies | Easy | Compatible |
| [Qwen Coder CLI](./qwen-coder) | stdio / HTTP | OAuth 2.1 | Easy | Compatible |

## MCP Endpoints

Every path is relative to your gateway URL (e.g. `http://crow:3001`). Each server is available over Streamable HTTP at `<prefix>/mcp` and over legacy SSE at `<prefix>/sse` + `<prefix>/messages`:

| Prefix | Server | Notes |
|---|---|---|
| `/router` | **Category router (recommended)** | 10 consolidated tools instead of the full 126+ raw surface — see [Context & Performance](/guide/context-performance) |
| `/memory` | Memory | The bare `/mcp` path is a compatibility alias for this server |
| `/projects` | Projects | `/research` is a legacy alias — same server, older name |
| `/sharing` | Sharing | |
| `/storage` | Storage | Available only when MinIO is configured |
| `/blog-mcp` | Blog | |
| `/tools` | External tool proxy | Integrations (GitHub, Trello, …) aggregated into one endpoint |

::: info Naming aliases
The **projects** server was previously called **research**. Old configs using `/research/mcp` or the `crow_research` router tool keep working — they are aliases for `/projects/mcp` and `crow_projects`.
:::

## Transport Types

Crow's gateway supports two MCP transport protocols:

### Streamable HTTP (Recommended)

- Protocol version: `2025-03-26`
- Endpoints: `<prefix>/mcp` from the table above
- Used by: Claude, Gemini, Grok, Cursor, Windsurf, Cline, Claude Code

### SSE (Legacy)

- Protocol version: `2024-11-05`
- Endpoints: `<prefix>/sse` + `<prefix>/messages` from the table above
- Used by: ChatGPT

### stdio (Local Only)

- Direct process communication, no network
- Used by: Claude Desktop, Claude Code (local), Gemini CLI (local), Qwen Coder CLI (local), Cursor (local), Windsurf (local), Cline (local)

## Authentication

The gateway uses **OAuth 2.1 with Dynamic Client Registration**. When you connect a new client, it automatically:

1. Discovers the OAuth metadata at `/.well-known/oauth-authorization-server`
2. Registers itself as a client via `/register`
3. Redirects you to authorize at `/authorize`
4. Receives an access token via `/token`

This is the same standard flow used by most OAuth providers. No manual token management needed for platforms that support OAuth discovery.

For platforms that don't support OAuth discovery (like Grok), you can use the `/introspect` endpoint or configure bearer tokens manually.

## Cross-Platform Context (crow.md)

Crow goes beyond shared data — it also shares **behavioral context** across platforms. The `crow.md` document defines how Crow behaves: identity, memory protocols, transparency rules, and your customizations.

**Automatic delivery:** When any AI connects to Crow, it receives a condensed version of your behavioral context during the MCP handshake — before any tool calls happen. The AI immediately knows how to use memory, follow session protocols, and respect transparency rules. No user action required.

**On-demand guidance:** For detailed workflow instructions, the AI can request MCP prompts like `session-start`, `crow-guide`, `research-guide`, `blog-guide`, or `sharing-guide`. These provide comprehensive guidance without consuming context window space upfront.

**Manual access:** Use the `crow_get_context` tool (any MCP platform) or `GET /crow.md` (HTTP endpoint) for the full document.

See the [Cross-Platform Guide](/guide/cross-platform) for a complete walkthrough.
