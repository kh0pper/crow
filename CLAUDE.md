# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Run Commands

```bash
npm run setup            # Install deps + initialize SQLite database
npm run init-db          # Re-initialize database schema only
npm run wizard           # Open browser-based setup wizard for API keys
npm run memory-server    # Start crow-memory MCP server (stdio)
npm run research-server  # Start crow-research MCP server (stdio)
npm run gateway          # Start HTTP gateway (Express, port 3001)
npm run desktop-config   # Generate Claude Desktop config JSON
```

### Docker (gateway only)

```bash
docker compose --profile cloud up --build   # Cloud deployment
docker compose --profile local up --build   # Local + Cloudflare Tunnel
```

### Testing

No test framework is configured. To verify servers work:
```bash
node servers/memory/index.js    # Should start without errors (ctrl-C to stop)
node servers/research/index.js  # Same
node servers/gateway/index.js --no-auth  # HTTP gateway without OAuth, check http://localhost:3001/health
```

## Architecture

This is an MCP (Model Context Protocol) platform — not a traditional web app. There is no frontend. The "UI" is Claude itself, guided by CLAUDE.md and skill files.

### Three layers

1. **Custom MCP Servers** (`servers/`) — Two Node.js servers exposing tools over MCP's stdio transport. Both share a single SQLite database (local file or Turso cloud).
   - `servers/memory/` — Persistent memory: store, search (FTS5), recall, list, update, delete, stats
   - `servers/research/` — Research pipeline: projects, sources (with auto-APA citation), notes, bibliography, verification

2. **HTTP Gateway** (`servers/gateway/`) — Express server that wraps both MCP servers with Streamable HTTP transport + OAuth 2.1. Used for mobile/remote access via Claude Connectors.

3. **Skills** (`skills/`) — 17 markdown files that serve as behavioral prompts loaded by Claude. Not code — they define workflows, trigger patterns, and integration logic.

### Server factory pattern

Each custom server has a **factory function** (`createMemoryServer`, `createResearchServer`) in `server.js` that returns a configured `McpServer` instance. The `index.js` files wire these to stdio transport. The gateway imports the same factories and wires them to HTTP transport. This means all tool logic lives in `server.js` — the transport layer is separate.

```
servers/memory/server.js   → createMemoryServer(dbPath?)  → McpServer
servers/memory/index.js    → stdio transport (used by .mcp.json)
servers/research/server.js → createResearchServer(dbPath?) → McpServer
servers/research/index.js  → stdio transport (used by .mcp.json)
servers/gateway/index.js   → Express + StreamableHTTPServerTransport (both servers)
servers/gateway/auth.js    → OAuth 2.1 provider (CrowOAuthProvider, SQLite-backed)
```

### Database

Uses `@libsql/client` which supports both local SQLite files (`data/crow.db`, gitignored) and remote Turso databases. Set `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` for cloud; otherwise falls back to local file. Client factory in `servers/db.js`. Schema defined in `scripts/init-db.js`. Key tables:

- **memories** — Full-text searchable (FTS5 virtual table `memories_fts`), with triggers to keep FTS in sync on insert/update/delete
- **research_projects** → **research_sources** → **research_notes** — Foreign keys with `ON DELETE SET NULL`
- **sources_fts** — FTS5 index over sources
- **oauth_clients** / **oauth_tokens** — Gateway auth persistence

All FTS sync is handled by SQLite triggers defined in `init-db.js`. If you change the memories or sources schema, you must also update the corresponding FTS virtual table and triggers.

### MCP configuration

`.mcp.json` at project root configures all MCP servers Claude can use. Custom servers use `node` command; external ones use `npx`/`uvx`. Environment variables are referenced with `${VAR_NAME}` syntax and loaded from `.env`.

### Key dependencies

- `@modelcontextprotocol/sdk` — MCP server SDK (stdio + HTTP transports, auth)
- `@libsql/client` — SQLite/Turso client (supports local files and remote Turso databases)
- `zod` — Schema validation for MCP tool parameters

Node.js >= 18 required. ESM modules (`"type": "module"` in package.json).

## Extending the Platform

### Adding a new MCP tool to an existing server

1. Add `server.tool(name, description, zodSchema, handler)` in the relevant `server.js`
2. If the tool needs new DB columns/tables, update `scripts/init-db.js` and re-run `npm run init-db`
3. If new FTS columns are needed, update the virtual table definition AND the insert/update/delete triggers

### Adding a new external MCP server

1. Add config to `.mcp.json` with env var references
2. Add env vars to `.env.example`
3. Create a skill file in `skills/` describing the workflow
4. Add trigger patterns to `skills/superpowers.md` trigger table

### Adding a new skill

Skills are markdown files in `skills/`. They are loaded by Claude on demand — no build step. Add a trigger row in `superpowers.md` so it auto-activates.

## AI Operational Context

This section guides Claude's behavior when operating as the Crow AI assistant (not when developing the codebase).

### Session Protocol

- **On start**: `crow_recall_by_context` with user's first message, check `crow_memory_stats`, load language preference, consult `skills/superpowers.md`
- **During**: Store important info with `crow_store_memory`, document sources with `crow_add_source`, monitor friction signals
- **On end**: Store unfinished work, run reflection if friction occurred

### Transparency Protocol

Surface all autonomous actions inline:
- **Tier 1 (FYI)**: Italic one-liners for routine actions — `*[crow: stored memory — "..." (preference, importance 8)]*`
- **Tier 2 (Checkpoint)**: Bold lines before significant decisions, wait for user — `**[crow checkpoint: ...]**`

### Key Principles

- Always cite sources with APA citations
- When in doubt, store it in memory
- Verify sources before marking verified
- Consistent tagging across memory and research
- Detect and adapt to user's language (see `skills/i18n.md`)
- All output in user's preferred language; skill files stay in English

### Skills Reference

Consult `skills/superpowers.md` first — it routes user intent to the right skills and tools. Core skills:
- `superpowers.md` — Auto-activation routing
- `reflection.md` — Session friction analysis + improvement proposals
- `plan-review.md` — Checkpoint-based planning for multi-step tasks
- `skill-writing.md` — Dynamic skill creation with user consent
- `i18n.md` — Multilingual output adaptation
