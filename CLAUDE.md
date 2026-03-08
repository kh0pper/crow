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
npm run storage-server   # Start crow-storage MCP server (stdio, requires MinIO)
npm run blog-server      # Start crow-blog MCP server (stdio)
npm run gateway          # Start HTTP gateway (Express, port 3001)
npm run check            # Verify database, config, and integration status
npm run mcp-config       # Generate .mcp.json from .env (only configured servers)
npm run desktop-config   # Generate Claude Desktop config JSON
npm run identity         # Display your Crow ID and public keys
npm run identity:export  # Export encrypted identity for device migration
npm run identity:import  # Import identity on a new device
npm run migrate-data     # Migrate data from ./data/ to ~/.crow/data/
```

### Crow CLI (Crow OS / self-hosted)

```bash
crow status              # Platform status, identity, resource usage
crow bundle status       # List installed bundles
crow bundle install <id> # Install a bundle add-on (ollama, nextcloud, immich)
crow bundle start <id>   # Start bundle containers
crow bundle stop <id>    # Stop bundle containers
crow bundle remove <id>  # Remove a bundle
```

### Docker (gateway only)

```bash
docker compose --profile cloud up --build   # Cloud deployment
docker compose --profile local up --build   # Local + Cloudflare Tunnel
docker compose --profile storage up --build # MinIO storage only
docker compose --profile full up --build    # Everything (gateway + MinIO)
```

### Testing

No test framework is configured. To verify servers work:
```bash
node servers/memory/index.js    # Should start without errors (ctrl-C to stop)
node servers/research/index.js  # Same
node servers/sharing/index.js   # Same (P2P sharing server)
node servers/storage/index.js   # Same (requires MinIO for tools to work, but starts without)
node servers/blog/index.js      # Same (blog server)
node servers/gateway/index.js --no-auth  # HTTP gateway without OAuth (blocked in production), check http://localhost:3001/health
```

## Architecture

This is an MCP (Model Context Protocol) platform. The AI is the primary interface, guided by CLAUDE.md and skill files. The dashboard provides a secondary visual UI.

### Core layers

1. **Custom MCP Servers** (`servers/`) — Five Node.js servers exposing tools over MCP's stdio transport. All share a single SQLite database (local file or Turso cloud).
   - `servers/memory/` — Persistent memory: store, search (FTS5), recall, list, update, delete, stats
   - `servers/research/` — Research pipeline: projects, sources (with auto-APA citation), notes, bibliography, verification
   - `servers/sharing/` — P2P sharing: Hyperswarm discovery, Hypercore data sync, Nostr messaging, peer relay, identity management
   - `servers/storage/` — S3-compatible file storage: upload, list, presigned URLs, delete, quota management (requires MinIO)
   - `servers/blog/` — Blogging platform: create, edit, publish, themes, RSS/Atom, export, share posts

2. **HTTP Gateway** (`servers/gateway/`) — Express server that wraps all MCP servers with Streamable HTTP + SSE transports + OAuth 2.1. Includes proxy layer for external MCP servers, public blog routes, dashboard UI, peer relay, and setup page. Modularized into Express routers (`routes/mcp.js`, `routes/blog-public.js`, `routes/storage-http.js`, `dashboard/`).

3. **Dashboard** (`servers/gateway/dashboard/`) — Server-side rendered HTML dashboard with Dark Editorial design. Password auth, session cookies, panel registry. Built-in panels: Messages, Blog, Files, Extensions, Settings. Third-party panels via `~/.crow/panels/`.

4. **Skills** (`skills/`) — 29 markdown files that serve as behavioral prompts loaded by Claude. Not code — they define workflows, trigger patterns, and integration logic.

### Server factory pattern

Each custom server has a **factory function** in `server.js` that returns a configured `McpServer` instance. The `index.js` files wire these to stdio transport. The gateway imports the same factories and wires them to HTTP transport via `routes/mcp.js`. This means all tool logic lives in `server.js` — the transport layer is separate.

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
servers/storage/server.js      → createStorageServer(dbPath?) → McpServer
servers/storage/index.js       → stdio transport
servers/storage/s3-client.js   → MinIO/S3 connection, bucket init, presigned URLs
servers/blog/server.js         → createBlogServer(dbPath?) → McpServer
servers/blog/index.js          → stdio transport
servers/blog/renderer.js       → Markdown→HTML (marked + sanitize-html)
servers/blog/rss.js            → RSS 2.0 + Atom feed generation
servers/gateway/index.js       → Express + MCP transports (all servers)
servers/gateway/session-manager.js → Consolidated session storage
servers/gateway/routes/mcp.js  → Streamable HTTP + SSE transport mounting
servers/gateway/routes/blog-public.js → Public blog routes (/blog/*)
servers/gateway/routes/storage-http.js → File upload/download routes
servers/gateway/dashboard/     → Dashboard UI (auth, layout, panels)
servers/gateway/auth.js        → OAuth 2.1 provider (CrowOAuthProvider, SQLite-backed)
servers/gateway/proxy.js       → Proxy layer for external MCP servers
servers/gateway/setup-page.js  → Browser-based setup/configuration page (first-run wizard for Crow OS)
servers/gateway/integrations.js → Registry of available integrations
bundles/obsidian/              → Obsidian vault add-on (external mcp-obsidian server)
bundles/home-assistant/        → Home Assistant add-on (external hass-mcp server)
bundles/ollama/                → Ollama local AI add-on (Docker + skill)
bundles/nextcloud/             → Nextcloud files add-on (Docker + WebDAV)
bundles/immich/                → Immich photos add-on (custom MCP server + Docker)
scripts/crow                   → CLI entry point (status, bundle management)
scripts/crow-install.sh        → Raspberry Pi / Debian installer script
scripts/crow-update.sh         → Safe update with rollback
scripts/migrate-data-dir.js    → Data directory migration (./data/ → ~/.crow/data/)
```

### Data Directory

Data lives in `~/.crow/data/` (preferred) or `./data/` (fallback). Resolution order: `CROW_DATA_DIR` env → `~/.crow/data/` (if exists) → `./data/`. The `resolveDataDir()` function in `servers/db.js` handles this. Migration script (`scripts/migrate-data-dir.js`) moves data from `./data/` to `~/.crow/data/` and creates a symlink for backward compatibility.

### Database

Uses `@libsql/client` which supports both local SQLite files (default: `~/.crow/data/crow.db`, gitignored) and remote Turso databases. Set `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` for cloud; otherwise falls back to local file. Client factory in `servers/db.js` (also exports `resolveDataDir()`, `sanitizeFtsQuery()`, and `escapeLikePattern()` utility functions). Schema defined in `scripts/init-db.js`. Key tables:

- **memories** — Full-text searchable (FTS5 virtual table `memories_fts`), with triggers to keep FTS in sync on insert/update/delete
- **research_projects** → **research_sources** → **research_notes** — Foreign keys with `ON DELETE SET NULL`
- **sources_fts** — FTS5 index over sources
- **oauth_clients** / **oauth_tokens** — Gateway auth persistence
- **contacts** — Peer identities, public keys (Ed25519 + secp256k1), relay status, last seen
- **shared_items** — Tracking of sent/received shares with permissions and delivery status (share_type is NOT CHECK-constrained — validated in app code for extensibility)
- **messages** — Local cache of Nostr messages with read status and threading
- **relay_config** — Configured Nostr relays and peer relays
- **storage_files** — S3 object metadata (key, name, MIME, size, bucket, reference to other items)
- **blog_posts** — Blog content with slug, status, visibility, tags, cover image
- **blog_posts_fts** — FTS5 index over blog posts (title, content, excerpt, tags) with triggers
- **dashboard_settings** — Key-value store for dashboard config (blog settings, theme, password hash)

All FTS sync is handled by SQLite triggers defined in `init-db.js`. If you change the memories, sources, or blog_posts schema, you must also update the corresponding FTS virtual table and triggers.

### MCP configuration

`.mcp.json` is **generated** — run `npm run mcp-config` after editing `.env`. It only includes servers whose required env vars are set. The server registry lives in `scripts/server-registry.js`. See `.mcp.json.example` for the full reference with all servers.

### Key dependencies

- `@modelcontextprotocol/sdk` — MCP server SDK (stdio + HTTP transports, auth)
- `@libsql/client` — SQLite/Turso client (supports local files and remote Turso databases)
- `zod` — Schema validation for MCP tool parameters
- `hyperswarm` — DHT-based P2P peer discovery with NAT holepunching
- `hypercore` — Append-only replicated feeds for data sync
- `nostr-tools` — Nostr protocol: events, NIP-44 encryption, relay communication
- `@noble/hashes`, `@noble/ed25519`, `@noble/secp256k1` — Cryptographic primitives for identity
- `minio` — S3-compatible object storage client
- `multer` — Multipart file upload handling
- `marked` — Markdown to HTML rendering
- `sanitize-html` — HTML sanitization (XSS prevention, no jsdom dependency)

Node.js >= 18 required. ESM modules (`"type": "module"` in package.json).

## Extending the Platform

### Adding a new MCP tool to an existing server

1. Add `server.tool(name, description, zodSchema, handler)` in the relevant `server.js`
2. All Zod string schemas should include `.max()` constraints to prevent abuse (existing tools use `.max(50000)` for content, `.max(500)` for short fields)
3. If the tool needs new DB columns/tables, update `scripts/init-db.js` and re-run `npm run init-db`
4. If new FTS columns are needed, update the virtual table definition AND the insert/update/delete triggers
5. Use `sanitizeFtsQuery()` from `servers/db.js` for any FTS5 MATCH queries and `escapeLikePattern()` for LIKE queries

### Adding a new external MCP server

1. Add server definition to `scripts/server-registry.js` (`EXTERNAL_SERVERS` array)
2. Add env vars to `.env.example`
3. Run `npm run mcp-config` to regenerate `.mcp.json`
4. Create a skill file in `skills/` describing the workflow
5. Add trigger patterns to `skills/superpowers.md` trigger table

### Adding a new skill

Skills are markdown files in `skills/`. They are loaded by Claude on demand — no build step. Add a trigger row in `superpowers.md` so it auto-activates.

### Adding a dashboard panel

1. Create a JS module exporting `{ id, name, icon, route, navOrder, handler }` (see `templates/dashboard-panel.js`)
2. For built-in panels: add to `servers/gateway/dashboard/panels/` and register in `servers/gateway/dashboard/index.js`
3. For third-party panels: place in `~/.crow/panels/` and add the panel ID to `~/.crow/panels.json`
4. Use shared components from `servers/gateway/dashboard/shared/components.js`
5. Handler receives `(req, res, { db, layout })` — return `layout({ title, content })` for consistent styling

### Add-on system

Crow supports installable add-ons (panels, MCP servers, skills, bundles). The registry lives in `registry/add-ons.json`. Users install add-ons by asking their AI ("install the todo add-on") or via the Extensions dashboard panel. Installed add-ons are tracked in `~/.crow/installed.json`.

### Developer Program

Crow has an open developer program for community contributions. Full developer documentation lives in `docs/developers/` (VitePress site). Key resources:
- `CONTRIBUTING.md` — Contributor guidelines and code conventions
- `scripts/create-integration.js` — Interactive scaffolding CLI (`npm run create-integration`)
- `templates/` — Starter templates for integration skills and workflow skills
- `.github/ISSUE_TEMPLATE/` — Issue templates for integration requests, skill proposals, bug reports
- `.github/PULL_REQUEST_TEMPLATE.md` — PR checklist

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
- `storage.md` — File storage management workflow
- `blog.md` — Blog creation, publishing, theming, export
- `network-setup.md` — Tailscale remote access guidance
- `add-ons.md` — Add-on browsing, installation, removal
- `bug-report.md` — Bug/feature reporting (GitHub or memory fallback)
- `onboarding-tour.md` — First-run platform tour for new users

Add-on skills (activated when corresponding add-on is installed):
- `obsidian.md` — Obsidian vault search and research sync
- `home-assistant.md` — Smart home control with safety checkpoints
- `ollama.md` — Local AI model management via HTTP API
- `nextcloud.md` — Nextcloud file access via WebDAV
- `immich.md` — Photo library search and album management

## Documentation Site

The `docs/` directory contains a VitePress documentation site. Key paths:

- `docs/.vitepress/config.ts` — Site config, sidebar, and nav
- `docs/index.md` — Landing page
- `docs/getting-started/` — Setup and deployment guides
- `docs/platforms/` — Per-platform integration guides (Claude, ChatGPT, Gemini, Cursor, OpenClaw, etc.)
- `docs/guide/` — Conceptual guides (cross-platform, storage, blog, dashboard, sharing, social)
- `docs/architecture/` — Server architecture docs (memory, research, sharing, storage, blog, dashboard, gateway)
- `docs/developers/` — Developer program, creating add-ons/panels/servers, storage API, add-on registry
- `docs/showcase.md` — Community showcase

To run locally: `cd docs && npm run dev`
