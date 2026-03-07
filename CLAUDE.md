# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Run Commands

```bash
npm run setup            # Install deps + initialize SQLite database
npm run init-db          # Re-initialize database schema only
npm run wizard           # Open browser-based setup wizard for API keys
npm run memory-server    # Start crow-memory MCP server (stdio)
npm run research-server  # Start crow-research MCP server (stdio)
npm run sharing-server   # Start crow-sharing MCP server (stdio)
npm run gateway          # Start HTTP gateway (Express, port 3001)
npm run desktop-config   # Generate Claude Desktop config JSON
npm run identity         # Display your Crow ID and public keys
npm run identity:export  # Export encrypted identity for device migration
npm run identity:import  # Import identity on a new device
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
node servers/sharing/index.js   # Same (P2P sharing server)
node servers/gateway/index.js --no-auth  # HTTP gateway without OAuth (blocked in production), check http://localhost:3001/health
```

## Architecture

This is an MCP (Model Context Protocol) platform — not a traditional web app. There is no frontend. The "UI" is Claude itself, guided by CLAUDE.md and skill files.

### Three layers

1. **Custom MCP Servers** (`servers/`) — Three Node.js servers exposing tools over MCP's stdio transport. All share a single SQLite database (local file or Turso cloud).
   - `servers/memory/` — Persistent memory: store, search (FTS5), recall, list, update, delete, stats
   - `servers/research/` — Research pipeline: projects, sources (with auto-APA citation), notes, bibliography, verification
   - `servers/sharing/` — P2P sharing: Hyperswarm discovery, Hypercore data sync, Nostr messaging, peer relay, identity management

2. **HTTP Gateway** (`servers/gateway/`) — Express server that wraps all three MCP servers with Streamable HTTP + SSE transports + OAuth 2.1. Includes a proxy layer for external MCP servers, setup page, integrations registry, and peer relay endpoints (`/relay/store`, `/relay/fetch`). Used for mobile/remote access via Claude Connectors.

3. **Skills** (`skills/`) — 24 markdown files that serve as behavioral prompts loaded by Claude. Not code — they define workflows, trigger patterns, and integration logic.

### Server factory pattern

Each custom server has a **factory function** (`createMemoryServer`, `createResearchServer`, `createSharingServer`) in `server.js` that returns a configured `McpServer` instance. The `index.js` files wire these to stdio transport. The gateway imports the same factories and wires them to HTTP transport. This means all tool logic lives in `server.js` — the transport layer is separate.

```
servers/memory/server.js       → createMemoryServer(dbPath?)  → McpServer
servers/memory/crow-context.js → Shared crow.md context logic (used by both memory server and gateway)
servers/memory/index.js        → stdio transport (used by .mcp.json)
servers/research/server.js     → createResearchServer(dbPath?) → McpServer
servers/research/index.js      → stdio transport (used by .mcp.json)
servers/sharing/server.js      → createSharingServer(dbPath?) → McpServer
servers/sharing/index.js       → stdio transport (used by .mcp.json)
servers/sharing/identity.js    → Key generation, Crow ID, invite codes, encryption
servers/sharing/peer-manager.js → Hyperswarm discovery, connection management
servers/sharing/sync.js        → Hypercore feed management, replication
servers/sharing/nostr.js       → Nostr events, NIP-44 encryption, relay comms
servers/sharing/relay.js       → Peer relay opt-in, store-and-forward
servers/gateway/index.js       → Express + Streamable HTTP & SSE transports (all three servers)
servers/gateway/auth.js        → OAuth 2.1 provider (CrowOAuthProvider, SQLite-backed)
servers/gateway/proxy.js       → Proxy layer for external MCP servers
servers/gateway/setup-page.js  → Browser-based setup/configuration page
servers/gateway/integrations.js → Registry of available integrations
```

### Database

Uses `@libsql/client` which supports both local SQLite files (`data/crow.db`, gitignored) and remote Turso databases. Set `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` for cloud; otherwise falls back to local file. Client factory in `servers/db.js` (also exports `sanitizeFtsQuery()` and `escapeLikePattern()` utility functions for safe query handling). Schema defined in `scripts/init-db.js`. Key tables:

- **memories** — Full-text searchable (FTS5 virtual table `memories_fts`), with triggers to keep FTS in sync on insert/update/delete
- **research_projects** → **research_sources** → **research_notes** — Foreign keys with `ON DELETE SET NULL`
- **sources_fts** — FTS5 index over sources
- **oauth_clients** / **oauth_tokens** — Gateway auth persistence
- **contacts** — Peer identities, public keys (Ed25519 + secp256k1), relay status, last seen
- **shared_items** — Tracking of sent/received shares with permissions and delivery status
- **messages** — Local cache of Nostr messages with read status and threading
- **relay_config** — Configured Nostr relays and peer relays

All FTS sync is handled by SQLite triggers defined in `init-db.js`. If you change the memories or sources schema, you must also update the corresponding FTS virtual table and triggers.

### MCP configuration

`.mcp.json` at project root configures all MCP servers Claude can use. Custom servers use `node` command; external ones use `npx`/`uvx`. Environment variables are referenced with `${VAR_NAME}` syntax and loaded from `.env`.

### Key dependencies

- `@modelcontextprotocol/sdk` — MCP server SDK (stdio + HTTP transports, auth)
- `@libsql/client` — SQLite/Turso client (supports local files and remote Turso databases)
- `zod` — Schema validation for MCP tool parameters
- `hyperswarm` — DHT-based P2P peer discovery with NAT holepunching
- `hypercore` — Append-only replicated feeds for data sync
- `nostr-tools` — Nostr protocol: events, NIP-44 encryption, relay communication
- `@noble/hashes`, `@noble/ed25519`, `@noble/secp256k1` — Cryptographic primitives for identity

Node.js >= 18 required. ESM modules (`"type": "module"` in package.json).

## Extending the Platform

### Adding a new MCP tool to an existing server

1. Add `server.tool(name, description, zodSchema, handler)` in the relevant `server.js`
2. All Zod string schemas should include `.max()` constraints to prevent abuse (existing tools use `.max(50000)` for content, `.max(500)` for short fields)
3. If the tool needs new DB columns/tables, update `scripts/init-db.js` and re-run `npm run init-db`
4. If new FTS columns are needed, update the virtual table definition AND the insert/update/delete triggers
5. Use `sanitizeFtsQuery()` from `servers/db.js` for any FTS5 MATCH queries and `escapeLikePattern()` for LIKE queries

### Adding a new external MCP server

1. Add config to `.mcp.json` with env var references
2. Add env vars to `.env.example`
3. Create a skill file in `skills/` describing the workflow
4. Add trigger patterns to `skills/superpowers.md` trigger table

### Adding a new skill

Skills are markdown files in `skills/`. They are loaded by Claude on demand — no build step. Add a trigger row in `superpowers.md` so it auto-activates.

## AI Operational Context

This section guides Claude's behavior when operating as the Crow AI assistant (not when developing the codebase).

### Cross-Platform Behavioral Context (crow.md)

Crow's core behavioral instructions — identity, memory protocols, research protocols, session management, transparency rules, and key principles — are stored in the `crow_context` database table and served dynamically as **crow.md**. This makes the same behavioral context available across all platforms (Claude, ChatGPT, Gemini, Grok, Cursor, etc.).

**Access methods:**
- MCP tool: `crow_get_context` (with optional `platform` and `include_dynamic` params)
- MCP resource: `crow://context`
- HTTP endpoint: `GET /crow.md` (supports `?platform=` and `?dynamic=false`) — protected by auth middleware when OAuth is enabled

**Management tools:** `crow_list_context_sections`, `crow_update_context_section`, `crow_add_context_section`, `crow_delete_context_section`

See `skills/crow-context.md` for the full workflow.

### Claude-Specific Supplements

These apply only when running on Claude (in addition to crow.md):

- **Transparency formatting**: Use *italic* for Tier 1 FYI lines, **bold** for Tier 2 checkpoints
- **Skill file access**: Load skill files from `skills/` directory on demand — they are markdown behavioral prompts, not code
- **CLAUDE.md**: This file itself provides developer context (build commands, architecture) that other platforms don't need

### Skills Reference

Consult `skills/superpowers.md` first — it routes user intent to the right skills and tools. Core skills:
- `superpowers.md` — Auto-activation routing
- `crow-context.md` — Cross-platform behavioral context management
- `reflection.md` — Session friction analysis + improvement proposals
- `plan-review.md` — Checkpoint-based planning for multi-step tasks
- `skill-writing.md` — Dynamic skill creation with user consent
- `i18n.md` — Multilingual output adaptation
- `sharing.md` — P2P sharing workflows (invite, share, inbox, revoke)
- `social.md` — Messaging and social interactions (Nostr)
- `peer-network.md` — Peer management, relay config, identity, blocking
- `onboarding.md` — First-run sharing setup and device migration

## Documentation Site

The `docs/` directory contains a VitePress documentation site. Key paths:

- `docs/.vitepress/config.ts` — Site config, sidebar, and nav
- `docs/index.md` — Landing page
- `docs/getting-started/` — Setup and deployment guides
- `docs/platforms/` — Per-platform integration guides (Claude, ChatGPT, Gemini, Cursor, OpenClaw, etc.)
- `docs/guide/` — Conceptual guides (cross-platform, sharing, social)
- `docs/architecture/sharing-server.md` — P2P sharing server architecture (5-layer design)

To run locally: `cd docs && npm run dev`
