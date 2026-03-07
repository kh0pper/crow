# Platform Compatibility

Crow uses the open [Model Context Protocol (MCP)](https://modelcontextprotocol.io) standard. Any MCP-compatible AI client can connect to Crow's gateway — no vendor-specific extensions are used.

## Compatibility Matrix

| Platform | Transport | Auth | Setup Difficulty | Status |
|---|---|---|---|---|
| [Claude Web & Mobile](./claude) | Streamable HTTP | OAuth 2.1 | Easy | Fully tested |
| [Claude Desktop](./claude-desktop) | stdio | N/A (local) | Easy | Fully tested |
| [Claude Code (CLI)](./claude-code) | stdio / HTTP | OAuth 2.1 | Easy | Fully tested |
| [ChatGPT](./chatgpt) | SSE | OAuth 2.1 | Easy | Compatible |
| [Gemini](./gemini) | Streamable HTTP | OAuth 2.1 | Medium | Compatible |
| [Grok (xAI)](./grok) | Streamable HTTP | Bearer token | Medium | Compatible |
| [Cursor](./cursor) | stdio / HTTP | Varies | Easy | Compatible |
| [Windsurf](./windsurf) | stdio / HTTP | Varies | Easy | Compatible |
| [Cline](./cline) | stdio / HTTP | Varies | Easy | Compatible |

## Transport Types

Crow's gateway supports two MCP transport protocols:

### Streamable HTTP (Recommended)

- Protocol version: `2025-03-26`
- Endpoints: `/memory/mcp`, `/research/mcp`, `/tools/mcp`
- Used by: Claude, Gemini, Grok, Cursor, Windsurf, Cline, Claude Code

### SSE (Legacy)

- Protocol version: `2024-11-05`
- Endpoints: `/memory/sse`, `/research/sse`, `/tools/sse`
- Used by: ChatGPT

### stdio (Local Only)

- Direct process communication, no network
- Used by: Claude Desktop, Claude Code (local), Cursor (local), Windsurf (local), Cline (local)

## Authentication

The gateway uses **OAuth 2.1 with Dynamic Client Registration**. When you connect a new client, it automatically:

1. Discovers the OAuth metadata at `/.well-known/oauth-authorization-server`
2. Registers itself as a client via `/register`
3. Redirects you to authorize at `/authorize`
4. Receives an access token via `/token`

This is the same standard flow used by most OAuth providers. No manual token management needed for platforms that support OAuth discovery.

For platforms that don't support OAuth discovery (like Grok), you can use the `/introspect` endpoint or configure bearer tokens manually.
