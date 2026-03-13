# Architecture

Crow is an MCP (Model Context Protocol) platform — not a traditional web app. There is no frontend. The "UI" is your AI assistant, guided by skill files and backed by persistent storage.

## System Diagram

```
┌───────────────────────────────────────────────────────────────────────┐
│       AI Client (Claude, ChatGPT, Gemini, Grok, Cursor, etc.)       │
└────────┬──────────────────────┬──────────────────────┬───────────────┘
         │                      │                      │
   /memory/mcp            /projects/mcp          /tools/mcp
   /memory/sse            /projects/sse          /tools/sse
   /sharing/mcp           /storage/mcp           /blog-mcp/mcp
   /sharing/sse           /storage/sse           /blog-mcp/sse
                          /relay/*
         │                      │                      │
┌────────┴──────────────────────┴──────────────────────┴───────────────┐
│  Crow Gateway (Express + OAuth 2.1)                                  │
│  ├── Streamable HTTP transport (2025-03-26)                          │
│  ├── SSE transport (2024-11-05, legacy)                              │
│  ├── crow-memory server (persistent memory + FTS5 search)            │
│  ├── crow-projects server (project management + APA citations)       │
│  ├── crow-sharing server (P2P sharing, Hyperswarm, Nostr messaging)  │
│  │    └── peer relay endpoints (/relay/store, /relay/fetch)          │
│  ├── crow-storage server (S3-compatible file storage via MinIO)      │
│  ├── crow-blog server (blogging platform, Markdown, RSS/Atom)        │
│  └── proxy server → spawns external MCP servers on demand            │
│       ├── GitHub, Brave Search, Slack, Notion, Trello                │
│       ├── Discord, Canvas LMS, Microsoft Teams                       │
│       └── Google Workspace, Zotero, arXiv, Render                    │
└──────────────────────────────┬───────────────────────────────────────┘
                               │
                        ┌──────┴───────┐
                        │    SQLite    │
                        │ (local file  │
                        │  or Turso)   │
                        └──────────────┘
```

## Three Layers

### 1. Custom MCP Servers (`servers/`)

Five Node.js servers exposing tools over MCP. All share a single SQLite database.

- **[Memory Server](./memory-server)** — Persistent memory with full-text search (FTS5), categories, importance scoring, and tags
- **[Project Server](./project-server)** — Project management with typed projects (research, data connectors), sources (auto-APA citation), notes, data backends, and bibliography generation
- **[Sharing Server](./sharing-server)** — P2P sharing protocol with Hyperswarm discovery, Hypercore data sync, Nostr messaging, and peer relay support
- **[Storage Server](./storage-server)** — S3-compatible file storage with MinIO, upload, presigned URLs, quota management
- **[Blog Server](./blog-server)** — Blogging platform with Markdown rendering, RSS/Atom feeds, themes, and export

### 2. HTTP Gateway (`servers/gateway/`)

Express server that wraps all five MCP servers with HTTP transports + OAuth 2.1. Supports:

- **Streamable HTTP** — Modern transport for Claude, Gemini, Grok, Cursor, etc.
- **SSE** — Legacy transport for ChatGPT compatibility
- **OAuth 2.1** — Dynamic Client Registration for secure access
- **Proxy** — Spawns and aggregates external MCP servers
- **Crow's Nest** — Server-rendered HTML UI at `/dashboard` with password auth, session cookies, and panel registry

See [Gateway](./gateway) for details.

### 3. Skills (`skills/`)

30 markdown files that serve as behavioral prompts. Not code — they define workflows, trigger patterns, and integration logic. Loaded by Claude on demand.

See [Skills](../skills/) for the full list.

## Server Factory Pattern

Each custom server has a **factory function** in `server.js` that returns a configured `McpServer` instance. The `index.js` files wire these to stdio transport. The gateway imports the same factories and wires them to HTTP transport.

```
servers/memory/server.js   → createMemoryServer()   → McpServer
servers/memory/index.js    → stdio transport
servers/research/server.js → createProjectServer()   → McpServer
servers/research/index.js  → stdio transport
servers/sharing/server.js  → createSharingServer()   → McpServer
servers/sharing/index.js   → stdio transport
servers/storage/server.js  → createStorageServer()   → McpServer
servers/storage/index.js   → stdio transport
servers/blog/server.js     → createBlogServer()      → McpServer
servers/blog/index.js      → stdio transport
servers/gateway/index.js   → Express + HTTP/SSE transports (all five servers)
```

## Database

Uses `@libsql/client` which supports both:

- **Local**: SQLite file at `~/.crow/data/crow.db`
- **Cloud**: [Turso](https://turso.tech) with `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN`

Key tables:
- `memories` — Full-text searchable via FTS5 virtual table with sync triggers
- `research_projects` → `research_sources` → `research_notes` — Foreign keys with cascade
- `crow_context` — Behavioral context sections (used to generate crow.md), supports per-device overrides via `device_id` column
- `oauth_clients` / `oauth_tokens` — Gateway auth persistence
- `contacts` — Peer identities, public keys, relay status, last seen
- `shared_items` — Tracking of sent/received shares with permissions
- `messages` — Local cache of Nostr messages with read status
- `relay_config` — Configured Nostr relays and peer relays
- `storage_files` — S3 object metadata (key, name, MIME, size, bucket)
- `blog_posts` — Blog content with slug, status, visibility, tags, cover image
- `blog_posts_fts` — FTS5 index over blog posts with sync triggers
- `dashboard_settings` — Key-value store for Crow's Nest config

## Behavioral Context (crow.md)

Crow's behavioral instructions — identity, memory protocols, research protocols, session management, and key principles — are stored in the `crow_context` database table and served dynamically as **crow.md**. This makes the same behavioral context available across all platforms (Claude, ChatGPT, Gemini, Grok, Cursor, etc.).

### What it is

A dynamically generated markdown document assembled from rows in the `crow_context` table. Each row is a named section (e.g., `identity`, `memory-protocols`, `research-protocols`) with content and ordering. The document is rebuilt on every request, so changes take effect immediately. Sections support per-device overrides via the `device_id` column — device-specific sections override globals with the same key, allowing different behavioral preferences per device.

### How it's served

| Method | Endpoint / Tool | Auth |
|---|---|---|
| MCP tool | `crow_get_context` (with optional `platform` and `include_dynamic` params) | Via MCP session |
| MCP resource | `crow://context` | Via MCP session |
| HTTP endpoint | `GET /crow.md` (supports `?platform=` and `?dynamic=false`) | OAuth (when enabled) |

### Management tools

| Tool | Purpose |
|---|---|
| `crow_list_context_sections` | List all sections with keys, titles, and protection status |
| `crow_update_context_section` | Update an existing section's content or title |
| `crow_add_context_section` | Add a new custom section |
| `crow_delete_context_section` | Remove a custom section (protected sections cannot be deleted) |

### Protected vs custom sections

Some sections (like `identity` and `memory-protocols`) are marked as **protected** — they can be updated but not deleted. Custom sections added by the user can be freely modified or removed.

### Cross-platform consistency

Because crow.md is generated from the database, any platform that loads it gets the same behavioral instructions. Platform-specific supplements (like CLAUDE.md for Claude Code) add to this shared foundation but don't replace it.

For the full workflow, see the [Cross-Platform Guide](../guide/cross-platform).

## Context Management

Crow includes a smart tool loading system to reduce context window usage. The gateway router (`/router/mcp`) consolidates 49+ tools into 7 category tools (~75% context reduction). For stdio deployments, `crow-core` provides on-demand server activation. See the [Context Management architecture reference](/architecture/context-management) for details.
