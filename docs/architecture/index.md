# Architecture

Crow is an MCP (Model Context Protocol) platform — not a traditional web app. There is no frontend. The "UI" is your AI assistant, guided by skill files and backed by persistent storage.

## System Diagram

```
┌───────────────────────────────────────────────────────────────────────┐
│       AI Client (Claude, ChatGPT, Gemini, Grok, Cursor, etc.)       │
└────────┬──────────────────────┬──────────────────────┬───────────────┘
         │                      │                      │
   /memory/mcp            /research/mcp          /tools/mcp
   /memory/sse            /research/sse          /tools/sse
         │                      │                      │
┌────────┴──────────────────────┴──────────────────────┴───────────────┐
│  Crow Gateway (Express + OAuth 2.1)                                  │
│  ├── Streamable HTTP transport (2025-03-26)                          │
│  ├── SSE transport (2024-11-05, legacy)                              │
│  ├── crow-memory server (persistent memory + FTS5 search)            │
│  ├── crow-research server (research pipeline + APA citations)        │
│  └── proxy server → spawns external MCP servers on demand            │
│       ├── GitHub, Brave Search, Slack, Notion, Trello                │
│       ├── Discord, Canvas LMS, Microsoft Teams                       │
│       └── Google Workspace, Zotero, arXiv, Render                    │
└──────────────────────────────┬───────────────────────────────────────┘
                               │
                         ┌─────┴─────┐
                         │  SQLite   │
                         │ (Turso)   │
                         └───────────┘
```

## Three Layers

### 1. Custom MCP Servers (`servers/`)

Two Node.js servers exposing tools over MCP. Both share a single SQLite database.

- **[Memory Server](./memory-server)** — Persistent memory with full-text search (FTS5), categories, importance scoring, and tags
- **[Research Server](./research-server)** — Research pipeline with projects, sources (auto-APA citation), notes, verification tracking, and bibliography generation

### 2. HTTP Gateway (`servers/gateway/`)

Express server that wraps both MCP servers with HTTP transports + OAuth 2.1. Supports:

- **Streamable HTTP** — Modern transport for Claude, Gemini, Grok, Cursor, etc.
- **SSE** — Legacy transport for ChatGPT compatibility
- **OAuth 2.1** — Dynamic Client Registration for secure access
- **Proxy** — Spawns and aggregates external MCP servers

See [Gateway](./gateway) for details.

### 3. Skills (`skills/`)

17 markdown files that serve as behavioral prompts. Not code — they define workflows, trigger patterns, and integration logic. Loaded by Claude on demand.

See [Skills](../skills/) for the full list.

## Server Factory Pattern

Each custom server has a **factory function** in `server.js` that returns a configured `McpServer` instance. The `index.js` files wire these to stdio transport. The gateway imports the same factories and wires them to HTTP transport.

```
servers/memory/server.js   → createMemoryServer()  → McpServer
servers/memory/index.js    → stdio transport
servers/research/server.js → createResearchServer() → McpServer
servers/research/index.js  → stdio transport
servers/gateway/index.js   → Express + HTTP/SSE transports (both servers)
```

## Database

Uses `@libsql/client` which supports both:

- **Local**: SQLite file at `data/crow.db`
- **Cloud**: [Turso](https://turso.tech) with `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN`

Key tables:
- `memories` — Full-text searchable via FTS5 virtual table with sync triggers
- `research_projects` → `research_sources` → `research_notes` — Foreign keys with cascade
- `oauth_clients` / `oauth_tokens` — Gateway auth persistence
