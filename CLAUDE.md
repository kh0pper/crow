# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Working with this repo

- **Always commit with a positional path arg**: `git commit <path> -m "..."`, not `git add <path> && git commit -m "..."`. The repo's index frequently carries unrelated WIP across branch checkouts because parallel Claude sessions modify files in the working tree concurrently. `git add` extends the index rather than replacing it, so a subsequent `git commit` without a path will sweep in those WIP files. Verify with `git show --stat HEAD` after every commit. (See `~/.claude/CLAUDE.md` Learnings 2026-04-14 for the incident this came from.)
- **Always `git pull --rebase` before pushing a branch** — parallel sessions commonly push to `main` between your fetch and your push. `--rebase` cleanly drops upstream-equivalent commits.

## Build & Run Commands

```bash
npm run setup            # Install deps + initialize SQLite database
npm run init-db          # Re-initialize database schema only
npm run wizard           # Open browser-based setup wizard for API keys
npm run memory-server    # Start crow-memory MCP server (stdio)
npm run research-server  # Start crow-projects MCP server (stdio)
npm run sharing-server   # Start crow-sharing MCP server (stdio)
npm run storage-server   # Start crow-storage MCP server (stdio, requires MinIO)
npm run blog-server      # Start crow-blog MCP server (stdio)
npm run gateway          # Start HTTP gateway (Express, port 3001)
npm run check            # Verify database, config, and integration status
npm run mcp-config       # Generate .mcp.json from .env (only configured servers)
npm run mcp-config -- --combined  # Generate with single crow-core server instead of 4 individual
npm run desktop-config   # Generate Claude Desktop config JSON
npm run identity         # Display your Crow ID and public keys
npm run identity:export  # Export encrypted identity for device migration
npm run identity:import  # Import identity on a new device
npm run migrate-data     # Migrate data from ./data/ to ~/.crow/data/
npm run sync-skills      # Regenerate docs/skills/index.md from skills/*.md
npm run backup           # Back up database (SQL dump + binary copy)
npm run restore          # Restore database from backup file
npm run reset-password   # Reset Crow's Nest password (self-hosted, interactive CLI)
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
node servers/research/index.js  # Same (project server)
node servers/sharing/index.js   # Same (P2P sharing server)
node servers/storage/index.js   # Same (requires MinIO for tools to work, but starts without)
node servers/blog/index.js      # Same (blog server)
node servers/core/index.js      # Same (combined server with on-demand activation)
node servers/gateway/index.js --no-auth  # HTTP gateway without OAuth (blocked in production), check http://localhost:3001/health
```

## Architecture

This is an MCP (Model Context Protocol) platform. The AI is the primary interface, guided by CLAUDE.md and skill files. The Crow's Nest provides a secondary visual UI.

### Core layers

1. **Custom MCP Servers** (`servers/`) — Six Node.js servers exposing tools over MCP's stdio transport. All share a single SQLite database (local file).
   - `servers/memory/` — Persistent memory: store, search (FTS5 + optional semantic search via sqlite-vec), recall, deep recall (cross-source: memories + research + notes + blog), dream (memory health analysis: stale detection, shingle-based duplicate detection, category health stats), list, update, delete, stats
   - `servers/research/` — Project management: projects (research, data_connector, extensible types), sources (with multi-format citations: APA, MLA, Chicago, web), notes, bibliography, data backend registration and management
   - `servers/sharing/` — P2P sharing: Hyperswarm discovery, Hypercore data sync, Nostr messaging, peer relay, identity management
   - `servers/storage/` — S3-compatible file storage: upload, list, presigned URLs, delete, quota management (requires MinIO)
   - `servers/blog/` — Blogging platform: create, edit, publish, themes, RSS/Atom, export, share posts
   - `servers/orchestrator/` — Multi-agent orchestration: run teams of AI agents on complex goals using presets and pipelines, powered by `open-multi-agent` engine with Crow's MCP tools bridged into a shared ToolRegistry

2. **HTTP Gateway** (`servers/gateway/`) — Express server that wraps all MCP servers with Streamable HTTP + SSE transports + OAuth 2.1. Includes proxy layer for external MCP servers, **tool router** (`/router/mcp` — 7 tools instead of 49+), **AI chat gateway** (`/api/chat/*` — BYOAI with tool calling), public blog routes, Crow's Nest UI, peer relay, and setup page. Modularized into Express routers (`routes/mcp.js`, `routes/chat.js`, `routes/blog-public.js`, `routes/storage-http.js`, `dashboard/`).

3. **Crow's Nest** (`servers/gateway/dashboard/`) — Server-side rendered HTML control panel (the "Crow's Nest") with Dark Editorial design. Password auth, session cookies, panel registry. Built-in panels: Health, Messages (AI Chat + Peer Messages tabs), Contacts, Memory, Blog (with markdown preview), Podcasts (subscriber + player), Files, Extensions, Skills, Settings. Third-party panels via `~/.crow/panels/`.

4. **Skills** (`skills/`) — 30 markdown files that serve as behavioral prompts loaded by Claude. Not code — they define workflows, trigger patterns, and integration logic.

### Server factory pattern

Each custom server has a **factory function** in `server.js` that returns a configured `McpServer` instance. The `index.js` files wire these to stdio transport. The gateway imports the same factories and wires them to HTTP transport via `routes/mcp.js`. This means all tool logic lives in `server.js` — the transport layer is separate.

```
servers/memory/server.js       → createMemoryServer(dbPath?, options?) → McpServer
servers/memory/crow-context.js → Shared crow.md context logic + condensed context for MCP instructions
servers/memory/index.js        → stdio transport (used by .mcp.json)
servers/shared/instructions.js → generateInstructions() — MCP instructions field generator
servers/shared/notifications.js → createNotification(db, opts), cleanupNotifications(db) — preference-aware notification helper
servers/research/server.js     → createProjectServer(dbPath?, options?) → McpServer (alias: createResearchServer for backward compat)
servers/research/index.js      → stdio transport (used by .mcp.json)
servers/sharing/server.js      → createSharingServer(dbPath?, options?) → McpServer
servers/sharing/index.js       → stdio transport (used by .mcp.json)
servers/sharing/identity.js    → Key generation, Crow ID, invite codes, encryption
servers/sharing/peer-manager.js → Hyperswarm discovery, connection management
servers/sharing/sync.js        → Hypercore feed management, replication
servers/sharing/nostr.js       → Nostr events, NIP-44 encryption, relay comms
servers/sharing/relay.js       → Peer relay opt-in, store-and-forward
servers/storage/server.js      → createStorageServer(dbPath?, options?) → McpServer
servers/storage/index.js       → stdio transport
servers/storage/s3-client.js   → MinIO/S3 connection, bucket init, presigned URLs
servers/blog/server.js         → createBlogServer(dbPath?, options?) → McpServer
servers/blog/index.js          → stdio transport
servers/blog/renderer.js       → Markdown→HTML (marked + sanitize-html)
servers/blog/rss.js            → RSS 2.0 + Atom feed generation
servers/blog/chordpro.js       → ChordPro parser, AST, transpose engine, detection
servers/blog/chord-diagrams.js → SVG chord diagram generator (guitar + piano)
servers/blog/songbook-renderer.js → Songbook HTML rendering (song page, index, setlist)
servers/orchestrator/server.js  → createOrchestratorServer(dbPath?, options?) → McpServer + startOrchestratorPipelines(db)
servers/orchestrator/index.js   → stdio transport
servers/orchestrator/mcp-bridge.js → Connects Crow MCP servers to open-multi-agent ToolRegistry (z.any() + rawInputSchema passthrough)
servers/orchestrator/presets.js → Team preset definitions (research, memory_ops, full, research_cloud)
servers/orchestrator/pipelines.js → Pipeline definitions (memory-consolidation, daily-summary, research-digest)
servers/orchestrator/pipeline-runner.js → Timer-based pipeline executor (polls schedules table for pipeline: entries)
servers/gateway/index.js       → Express + MCP transports (all servers)
servers/gateway/session-manager.js → Consolidated session storage
servers/gateway/routes/mcp.js  → Streamable HTTP + SSE transport mounting
servers/gateway/routes/blog-public.js → Public blog routes (/blog/*)
servers/gateway/routes/storage-http.js → File upload/download routes
servers/gateway/routes/bundles.js → Bundle lifecycle API (install, uninstall, start, stop, status, env config)
servers/gateway/routes/songbook.js → Public songbook routes (/blog/songbook/*)
servers/gateway/dashboard/     → Crow's Nest UI (auth, layout, panels)
servers/gateway/dashboard/settings/ → Settings panel: registry, menu renderer, 14 section modules
servers/gateway/auth.js        → OAuth 2.1 provider (CrowOAuthProvider, SQLite-backed)
servers/gateway/instance-registry.js → Instance registry: register, list, heartbeat, discovery, token management
servers/sharing/instance-sync.js → InstanceSyncManager: Hypercore-based P2P replication with Lamport timestamps and conflict detection
servers/sharing/peer-manager.js → Hyperswarm peer discovery + instance sync topic (joinInstanceSync, onInstanceConnected)
servers/gateway/proxy.js       → Proxy layer for external MCP servers
servers/gateway/router.js      → Tool router (7 category tools, ~75% context reduction)
servers/gateway/ai/provider.js → AI provider registry, adapter factory, hot-reload from .env
servers/gateway/ai/adapters/openai.js    → OpenAI/OpenRouter/OpenAI-compat adapter
servers/gateway/ai/adapters/anthropic.js → Anthropic Messages API adapter
servers/gateway/ai/adapters/google.js    → Google Gemini API adapter
servers/gateway/ai/adapters/ollama.js    → Ollama native /api/chat adapter
servers/gateway/ai/tool-executor.js → MCP tool dispatch for AI chat (reuses router pattern)
servers/gateway/ai/system-prompt.js → System prompt generator (reuses generateInstructions())
servers/gateway/routes/chat.js → AI chat REST + SSE endpoints (conversations, messages, streaming)
servers/gateway/tool-manifests.js → Static tool manifests for router descriptions
servers/gateway/setup-page.js  → Browser-based setup/configuration page (first-run wizard for Crow OS)
servers/gateway/integrations.js → Registry of available integrations
servers/core/server.js         → Combined on-demand server (createCoreServer, 15 startup tools)
servers/core/index.js          → stdio transport for crow-core
bundles/obsidian/              → Obsidian vault add-on (external mcp-obsidian server)
bundles/home-assistant/        → Home Assistant add-on (external hass-mcp server)
bundles/ollama/                → Ollama local AI add-on (Docker + skill)
bundles/localai/               → LocalAI OpenAI-compatible local AI add-on (Docker + skill)
bundles/nextcloud/             → Nextcloud files add-on (Docker + WebDAV)
bundles/immich/                → Immich photos add-on (custom MCP server + Docker)
bundles/jellyfin/              → Jellyfin media server add-on (Docker + MCP server, 7 tools)
bundles/plex/                  → Plex Media Server connector (MCP server, 7 tools, optional Docker)
bundles/iptv/                  → IPTV channel manager (MCP server, 6 tools, M3U/XMLTV)
bundles/kodi/                  → Kodi remote control (MCP server, 6 tools, JSON-RPC)
bundles/trilium/               → TriliumNext knowledge base (Docker + MCP server, 11 tools, ETAPI)
bundles/knowledge-base/        → Multilingual knowledge base (MCP server, 10 tools, LAN discovery, WCAG 2.1 AA)
bundles/maker-lab/             → STEM education companion for kids (MCP server, 21 tools, age-banded personas, classroom-capable). Phase 1 scaffold; see bundles/maker-lab/PHASE-0-REPORT.md
bundles/kolibri/               → Kolibri learning platform (Docker + panel + skill; offline-first STEM/literacy, Pi-friendly, sibling of maker-lab)
bundles/scratch-offline/       → Scratch block-based coding (Dockerfile builds scratch-gui from source + nginx; age 8+, no cloud save)
bundles/vllm/                  → vLLM GPU inference server (OpenAI-compatible endpoint; Linux x86_64 + NVIDIA only; recommended classroom engine for Maker Lab)
bundles/maker-lab-advanced/    → Maker Lab Advanced (Phase 5): JupyterHub for 9+ learners, kid-safe kernel defaults, AI pair-programmer at tween/teen reading level
android/                       → Android WebView shell app (Crow's Nest mobile client)
servers/gateway/public/        → PWA assets (manifest.json, service worker, icons)
servers/gateway/push/          → Web Push notification infrastructure (VAPID)
servers/gateway/routes/push.js → Push subscription registration endpoints
servers/gateway/dashboard/nav-registry.js → Grouped sidebar navigation (user-customizable)
scripts/crow                   → CLI entry point (status, bundle management)
scripts/crow-install.sh        → Raspberry Pi / Debian installer script
scripts/crow-update.sh         → Safe update with rollback
scripts/migrate-data-dir.js    → Data directory migration (./data/ → ~/.crow/data/)
```

### Network exposure invariant

**The Crow's Nest dashboard and all private routes (MCP, AI chat, storage, push, instance sync) MUST NEVER be reachable via Tailscale Funnel.** Only `/blog`, `/robots.txt`, `/sitemap.xml`, `/.well-known/`, `/favicon.ico`, and `/manifest.json` are safe to expose publicly.

Enforcement:
1. **Server-side middleware** — `servers/gateway/index.js` rejects any request carrying the `Tailscale-Funnel-Request` header unless the path matches `PUBLIC_FUNNEL_PREFIXES` or `CROW_DASHBOARD_PUBLIC=true`.
2. **`isAllowedNetwork()`** in `servers/gateway/dashboard/auth.js` — uses the Tailscale-injected `Tailscale-User-Login` / `Tailscale-Funnel-Request` headers (verified unforgeable against `tailscale/ipn/ipnlocal/serve.go:1046-1072`) to distinguish tailnet Serve from public Funnel. Bare loopback is rejected — callers on the same host must use `CROW_ALLOWED_IPS` or `CROW_DASHBOARD_PUBLIC=true`.
3. **Funnel config** — never map `/` or any non-public prefix. Use `tailscale funnel --set-path=/blog` and friends. The docs at `docs/getting-started/tailscale-setup.md` show the correct pattern.

If you touch any of these three layers, run the `servers/gateway/__tests__/auth.test.js` integration tests.

### Turbo Drive

The dashboard uses [Turbo Drive](https://turbo.hotwired.dev/) for client-side panel navigation. **Default-on** as of 2026-04-16 after the Phase 8 walkthrough passed; set `CROW_ENABLE_TURBO=0` to opt out. This is what keeps the player bar visible (and audio playing) across panel navigation, and updates the URL correctly after form submits without a full page reload.

**Opt out (systemd drop-in; recommended because easy to roll forward):**
```bash
sudo tee /etc/systemd/system/crow-gateway.service.d/turbo.conf > /dev/null <<'EOF'
[Service]
Environment=CROW_ENABLE_TURBO=0
EOF
sudo systemctl daemon-reload && sudo systemctl restart crow-gateway
```
Remove the file to return to the default (Turbo on).

**What ships in the platform when Turbo is active:**
- `servers/gateway/public/vendor/turbo-8.0.5.umd.js` is vendored (pinned; do not float to `@8`).
- `turboHead()` in `servers/gateway/dashboard/shared/layout.js` injects the `<script defer>` + `<meta turbo-cache-control="no-cache">` + `<meta view-transition="same-origin">` into the dashboard `<head>`.
- `res.redirectAfterPost(url)` middleware emits `303 See Other` so Turbo updates the URL after a form POST (a bare `302` makes Turbo stay on the old URL). All existing POST handlers were migrated via `scripts/migrate-redirect-303.js`.
- `#crow-player-bar` and nested `<audio>` are `data-turbo-permanent`; player state survives every panel nav.
- A `turbo:before-fetch-response` listener in the layout's global script forces a full reload on `401` responses or redirects to `/dashboard/login` (auth-boundary interception).
- Panel inline scripts track `setInterval` / document-level listeners on `window.__<panel>*` globals with clear-prior-on-re-entry so Turbo re-visits don't stack resources. See `docs/developers/creating-panels.md#turbo-drive-compatibility` for the panel-author guide.
- Media-session iframes (Jellyfin, Navidrome, Audiobookshelf) are marked `data-turbo-permanent` with stable ids for narrow intra-panel persistence. Inter-panel nav still discards them — steer users toward native panels (e.g., the Music bundle) for persistent playback.

**Debug overlay:** append `?diag=turbo` to any dashboard URL; the bottom-right overlay shows Turbo boot state, `window.crowPlayer` availability, recent `turbo:*` events, and any uncaught errors. `?diag=off` dismisses. The overlay is only rendered if the query param / localStorage flag is set, so it costs nothing by default.

**Rollback is clean.** Every piece of Turbo code is either gated behind `CROW_ENABLE_TURBO=0` or behavior-neutral if Turbo doesn't load. If a regression shows up, add the opt-out drop-in above and the dashboard renders exactly as it did pre-rollout.

### Turbo Streams & Frames

**Live dashboard updates via server-pushed HTML fragments and scoped sub-navigation.** Streams replace polling; Frames replace full-panel swaps on in-panel navigation.

**In-process event bus** — `servers/shared/event-bus.js` exports a single per-process `EventEmitter`. Each gateway (crow-gateway on 3002, crow-finance-gateway on 3003) runs its own Node process with its own bus; there is NO cross-process propagation here. Cross-instance events still travel via `InstanceSyncManager`.

**Stream primitives** live under `servers/gateway/streams/`:
- `sse.js` — `openStream(res)` opens an SSE response with a 30s keepalive and `res.on("error")` handler for EPIPE-safe teardown.
- `turbo-stream.js` — `html\`\``, `raw()`, `turboStream(action, target, body)`, `sseTurbo(sendRaw, action, target, body)`. The `sseTurbo` helper emits one `data:` record per content line so multi-line frames survive transport (the spec concatenates with `\n` on the consumer side).
- `authed-stream.js` — `openAuthedStream(req, res)` layers a 5-min session re-check on `openStream`. Stream routes MUST use this variant so logged-out tabs close cleanly.

**Escape-by-default contract for Stream bodies.** Every `<turbo-stream>` body MUST flow from the `html\`\`` tag function (which escapes every interpolant) OR an explicit `raw()` opt-out (for pre-sanitized markdown, etc.). A bare `${userInput}` interpolation into `turboStream()` / `sseTurbo()` is an XSS bug. When reviewing new emit sites, grep for `turboStream|sseTurbo` and confirm each call site feeds from `html\`\`` or a reviewed `raw()`.

**Paired-instance emit discipline.** When a table is in `SYNCED_TABLES` (see `servers/sharing/instance-sync.js`), an inbound replication-path write does NOT fire the usual `createNotification` / nostr.js code path — the row just lands locally via `_applyEntry`. To live-update badges across paired Crows, emit from `_applyEntry` as well as the primary write paths. Tables currently emitting from both:
- `messages` — `servers/sharing/nostr.js` (live Nostr inbound) + `servers/sharing/instance-sync.js::_applyEntry` (synced rows).
- `notifications` — NOT in `SYNCED_TABLES`; `createNotification` alone is sufficient.

**Emit + subscriber isolation.** `EventEmitter.emit` is synchronous and re-throws unhandled subscriber errors. Every emit site wraps in `try { bus.emit(...) } catch {}` so a broken subscriber cannot break the primary DB write. Every subscriber handler defends against its own exceptions; one slow subscriber cannot block siblings but CAN delay them (since emit is synchronous).

**Stream routes** live in `servers/gateway/routes/streams.js`, mounted under `/dashboard/streams/*`. That prefix is intentionally omitted from `PUBLIC_FUNNEL_PREFIXES` in `servers/gateway/index.js`, so Tailscale Funnel traffic is rejected with HTTP 403 before reaching any handler. Smoke test:
```
curl -H "Tailscale-Funnel-Request: 1" -i http://localhost:3002/dashboard/streams/notifications
# Expect: HTTP/1.1 403 Forbidden
```
Active streams: notifications bell, messages peer badges, orchestrator event timeline, glasses media, extensions jobs. Fallback polls run at 5 min as a safety net — after 2 weeks of clean dogfood they can be deleted.

**`chat.js` SSE** (`servers/gateway/routes/chat.js`) uses `openStream()` directly (not `openAuthedStream` — chat already mounts its own auth). Curl smoke test:
```
curl -N -H 'Cookie: crow_session=<valid>' \
  -H 'Content-Type: application/json' \
  -d '{"content":"hello"}' \
  http://localhost:3002/api/chat/conversations/<id>/messages
# Expect: event: content ... event: done
```

**Turbo Frames** currently wrap two lists: `#memory-results` (Memory panel) and `#blog-post-list` (Blog panel). `data-turbo-action="advance"` on the frame keeps the URL in sync with the current page, so bookmarks and back/forward still work. The existing server route returns a full-page response; Turbo extracts the matching frame and swaps only its contents. No separate frame-only route is needed for this pattern.

**Messages conversation Frame (D.1) is deferred.** The Messages panel is implemented as a client-side SPA: `msgSelectItem(type, id)` in `servers/gateway/dashboard/panels/messages/client.js:137` is a `onclick` handler that calls `loadAiConversation` / `loadPeerConversation` / `loadBotConversation`, each of which fetches JSON from `/api/messages/peer/:id` (or AI chat REST), then builds the entire chat UI via `textContent` + `appendChild`. There is no href navigation, no URL change, no server-side conversation template.

Wrapping `#msg-chat` in a `<turbo-frame>` without migrating this flow is a no-op — nothing navigates into the frame. Turning peer selection into link nav (`<a href="/dashboard/messages/conversation/peer/:id" data-turbo-frame="conversation-body">`) requires a server-side renderer for the chat body that matches the client's current output for headers, message bubbles, markdown, attachments, reply bar, file upload UI, and read-tracking. Migrating AI chat and bot chat to the same pattern is further complicated by SSE streaming for AI responses and polling for bot responses — both currently depend on the client's in-memory `_messages` / `_activeItem` state.

A proper migration would:
1. Add `servers/gateway/dashboard/panels/messages/conversation-render.js` exposing `renderPeerConversation(db, contactId, lang)`, matching the client's DOM output (including attachment previews, reply bar, `data-message-id` wiring).
2. Add GET route `/dashboard/messages/conversation/peer/:id` in `messages.js` returning the frame body.
3. Update `messages/html.js` to wrap `#msg-chat` in `<turbo-frame id="conversation-body" data-turbo-action="advance">` and change peer `.msg-avatar-item` elements from `onclick="msgSelectItem('peer',...)"` to `<a href="..." data-turbo-frame="conversation-body">` link nav.
4. Bridge the frame render to client state: wire a `turbo:frame-load` listener that sets `_activeItem`, attaches the `pollStatus` / `sendPeerMessage` handlers, and arms `file-input` change.
5. Leave AI chat + bot chat on the JS path for now; either (a) gate `msgSelectItem` to dispatch only for `type !== "peer"`, or (b) migrate all three types in a follow-up.

Out of scope for the current Turbo follow-on plan because (a) the SPA works fine today and (b) the refactor has real regression risk (markdown output divergence, attachment upload + reply bar regressions, state-machine desync between server render and client handlers). Track this as a standalone refactor plan when addressing "URL syncing for conversations / notification deeplinks" or similar concrete ask.

### Data Directory

Data lives in `~/.crow/data/` (preferred) or `./data/` (fallback). Resolution order: `CROW_DATA_DIR` env → `~/.crow/data/` (if exists) → `./data/`. The `resolveDataDir()` function in `servers/db.js` handles this. Migration script (`scripts/migrate-data-dir.js`) moves data from `./data/` to `~/.crow/data/` and creates a symlink for backward compatibility.

### Database

Uses `@libsql/client` for local SQLite files (default: `~/.crow/data/crow.db`, gitignored). Client factory in `servers/db.js` (also exports `resolveDataDir()`, `sanitizeFtsQuery()`, and `escapeLikePattern()` utility functions). Schema defined in `scripts/init-db.js`. Key tables:

- **memories** — Full-text searchable (FTS5 virtual table `memories_fts`), with triggers to keep FTS in sync on insert/update/delete. Scope columns: `instance_id` (origin instance), `project_id` (project scope) — these are on the main table only (NOT in FTS), filtered via JOIN
- **research_projects** — Projects with `type` column (research, data_connector, extensible). → **research_sources** → **research_notes** — Foreign keys with `ON DELETE SET NULL`
- **data_backends** — External MCP server registrations linked to projects. Stores connection references (env var names, not secrets). Status tracked by gateway proxy.
- **sources_fts** — FTS5 index over sources
- **oauth_clients** / **oauth_tokens** — Gateway auth persistence
- **contacts** — Peer identities, public keys (Ed25519 + secp256k1), relay status, last seen
- **shared_items** — Tracking of sent/received shares with permissions and delivery status (share_type is NOT CHECK-constrained — validated in app code for extensibility)
- **messages** — Local cache of Nostr messages with read status and threading
- **relay_config** — Configured Nostr relays and peer relays
- **storage_files** — S3 object metadata (key, name, MIME, size, bucket, reference to other items)
- **blog_posts** — Blog content with slug, status, visibility, tags, cover image
- **blog_posts_fts** — FTS5 index over blog posts (title, content, excerpt, tags) with triggers
- **dashboard_settings** — Key-value store for dashboard config (blog settings, theme, password hash, notification prefs)
- **notifications** — User notifications with type filtering (reminder, media, peer, system), priority, expiry, action URLs. Max 500 retention enforced by `cleanupNotifications()`
- **chat_conversations** — AI chat conversations (provider, model, system prompt, token tracking)
- **chat_messages** — AI chat messages (role: user/assistant/system/tool, tool_calls JSON, token counts). FK to chat_conversations with CASCADE delete
- **songbook_setlists** — Setlist containers (name, description, visibility)
- **songbook_setlist_items** — Songs in setlists (setlist_id FK, post_id FK, position, key_override, notes) with unique index
- **blog_comments** — Comment stub for forward-compatibility (post_id FK, contact_id FK, status, nostr_event_id)
- **crow_instances** — Instance registry for multi-instance chaining (id TEXT PK, name, crow_id, directory, hostname, tailscale_ip, gateway_url, sync_url, sync_profile, topics, is_home, auth_token_hash, last_seen_at, status)
- **sync_conflicts** — Conflict log for instance sync (table_name, row_id, winning/losing instance_id + lamport_ts + data, resolved flag)
- **sync_state** — Per-instance Lamport counter and checkpoint tracking (instance_id PK, local_counter, last_applied_seq_per_peer JSON)
- **contact_groups** — Contact organization groups (id, name, color, sort_order)
- **contact_group_members** — Many-to-many contacts-to-groups (group_id FK, contact_id FK, unique index)
- **push_subscriptions** — Web Push notification subscriptions (endpoint UNIQUE, keys_json, platform, device_name)
- **moderation_actions** — F.11 queued destructive moderation actions from federated bundles (bundle_id, action_type, payload_json, requested_at, expires_at, status, idempotency_key UNIQUE). 72h default TTL; operator confirms via Nest panel
- **identity_attestations** — F.11 signed bindings (crow_id, app, external_handle, app_pubkey?, sig, version, revoked_at). Published via gateway `/.well-known/crow-identity.json`. UNIQUE(crow_id, app, external_handle, version) — new version row per rotation
- **identity_attestation_revocations** — F.11 signed revocations (attestation_id FK CASCADE, revoked_at, reason, sig). Published via `/.well-known/crow-identity-revocations.json`
- **crosspost_rules** — F.12.2 opt-in crosspost config (source_app, source_trigger, target_app, transform, active). Triggers: `on_publish`, `on_tag:<tag>`, `manual`
- **crosspost_log** — F.12.2 audit + idempotency log (idempotency_key, source_app, source_post_id, target_app, status, target_post_id, scheduled_at, published_at, cancelled_at, **transformed_payload_json** — F.13). UNIQUE(idempotency_key, source_app, target_app). 7-day idempotency window; F.13 scheduler auto-publishes `ready`/`queued`-past-scheduled_at rows to mastodon/gotosocial/crow-blog and marks media-heavy targets (pixelfed/peertube/funkwhale) as `manual`. GC prunes >30 days
- **iptv_playlists** — IPTV M3U playlist sources (name, url, auto_refresh, channel_count)
- **iptv_channels** — IPTV channels from playlists (playlist_id FK, name, stream_url, tvg_id, group_title, is_favorite)
- **iptv_epg** — Electronic Program Guide entries (channel_tvg_id, title, start_time, end_time, indexed)
- **iptv_recordings** — IPTV recording jobs (channel_id FK, status, file_path, duration)
- **kb_collections** — Knowledge base collections (slug UNIQUE, name, languages, visibility CHECK private/public/peers/lan, lan_enabled)
- **kb_categories** — KB categories (collection_id FK, slug, sort_order, icon). UNIQUE(collection_id, slug)
- **kb_category_names** — Localized category names (category_id FK, language, name). UNIQUE(category_id, language)
- **kb_articles** — KB articles, one row per language (collection_id FK, category_id FK, pair_id links translations, language, slug, title, content, status, last_verified_at). UNIQUE(collection_id, slug, language), UNIQUE(pair_id, language)
- **kb_articles_fts** — FTS5 index over kb_articles (title, content, excerpt, tags) with insert/update/delete triggers
- **kb_resources** — Structured resource entries within articles (article_id FK, name, phone, address, website, hours, eligibility, flagged, flag_reason, last_verified_at)
- **kb_review_log** — Verification audit trail (resource_id FK, article_id FK, action, details, reviewed_by)

All FTS sync is handled by SQLite triggers defined in `init-db.js` (core tables) or bundle `init-tables.js` (bundle tables like kb_articles_fts). If you change the memories, sources, blog_posts, or kb_articles schema, you must also update the corresponding FTS virtual table and triggers.

### MCP configuration

`.mcp.json` is **generated** — run `npm run mcp-config` after editing `.env`. It only includes servers whose required env vars are set. The server registry lives in `scripts/server-registry.js`. See `.mcp.json.example` for the full reference with all servers. Use `npm run mcp-config -- --combined` to generate a single `crow-core` entry instead of 4 individual core servers.

### Context management

The gateway includes a **tool router** at `/router/mcp` that exposes 7 category tools instead of 49+ individual tools (~75% context reduction). Each category tool dispatches to the underlying server via an in-process MCP Client + `InMemoryTransport`. The `crow_discover` tool returns full schemas on demand. Disable with `CROW_DISABLE_ROUTER=1`.

For stdio deployments, **`crow-core`** (`servers/core/index.js`) starts with memory tools + 3 management tools (15 total). Other servers activate on demand via `crow_activate_server` / `crow_deactivate_server`, which toggles tool `enabled` state and sends `toolListChanged`. Default server configurable via `CROW_DEFAULT_SERVER` env var.

### Automatic behavioral context (MCP instructions)

All servers deliver a condensed crow.md (~1KB) via the MCP `instructions` field during the connection handshake. This gives remote AI clients (Claude.ai, ChatGPT, etc.) behavioral guidance before any tool calls — no user action required.

**How it works:** `generateInstructions()` in `servers/shared/instructions.js` queries 5 essential `crow_context` sections (identity, memory_protocol, session_protocol, transparency_rules, skills_reference), condenses them via `generateCondensedContext()` in `servers/memory/crow-context.js`, and returns a string. This is generated **once at startup** (gateway or stdio) and passed to factories via `options.instructions`. Falls back to a static ~500-byte string if the DB is unavailable.

**Factory signature:** All server factories accept `(dbPath?, options?)` where `options.instructions` is passed to `new McpServer({...}, { instructions })`.

**Router variant:** `generateInstructions({ routerStyle: true })` produces category-style tool names (`crow_memory action: "store_memory"`) instead of direct names.

### Per-device and per-project context overrides

The `crow_context` table supports scoped behavioral customization via `device_id` and `project_id` columns. Four scope levels exist:
1. **Global** (`device_id NULL`, `project_id NULL`) — base layer, applies everywhere
2. **Device-specific** (`device_id` set, `project_id NULL`) — overrides global for a device
3. **Project-specific** (`project_id` set, `device_id NULL`) — overrides global for a project
4. **Device+project** (both set) — highest priority, overrides all others

**How merging works:** When `deviceId` and/or `projectId` are passed to `generateCrowContext()`, `generateCondensedContext()`, or `generateInstructions()`, the `mergeScopedSections()` function in `crow-context.js` merges all matching scopes. Priority: device+project > project > device > global. Sections only for other devices/projects are ignored.

**Tool support:** All context tools (`crow_get_context`, `crow_update_context_section`, `crow_add_context_section`, `crow_list_context_sections`, `crow_delete_context_section`) accept optional `device_id` and `project_id` parameters. Protected sections can have scoped overrides; deleting a scoped override restores the next-lower scope.

**Schema:** Four partial unique indexes enforce uniqueness — `idx_crow_context_global` (section_key WHERE both NULL), `idx_crow_context_device` (section_key, device_id WHERE project_id NULL), `idx_crow_context_project` (section_key, project_id WHERE device_id NULL), `idx_crow_context_device_project` (section_key, device_id, project_id WHERE both NOT NULL).

### MCP Prompts

Servers register MCP prompts as on-demand skill equivalents for non-Claude-Code platforms:

| Prompt | Registered On | Content |
|--------|--------------|---------|
| `session-start` | memory, router | Session start/end protocol from crow_context DB |
| `crow-guide` | memory, router | Full crow.md (accepts `platform` arg) |
| `project-guide` | projects, router | Static project/research workflow text |
| `blog-guide` | blog, router | Static blog publishing text |
| `sharing-guide` | sharing, router | Static P2P sharing text |

The router registers all 5 so clients at `/router/mcp` see everything.

### Key dependencies

- `@modelcontextprotocol/sdk` — MCP server SDK (stdio + HTTP transports, auth)
- `@libsql/client` — SQLite client (local files)
- `zod` — Schema validation for MCP tool parameters
- `hyperswarm` — DHT-based P2P peer discovery with NAT holepunching
- `hypercore` — Append-only replicated feeds for data sync
- `nostr-tools` — Nostr protocol: events, NIP-44 encryption, relay communication
- `@noble/hashes`, `@noble/ed25519`, `@noble/secp256k1` — Cryptographic primitives for identity
- `minio` — S3-compatible object storage client
- `multer` — Multipart file upload handling
- `marked` — Markdown to HTML rendering
- `sanitize-html` — HTML sanitization (XSS prevention, no jsdom dependency)
- `open-multi-agent` — Multi-agent orchestration engine (local path: `file:../open-multi-agent`)

Node.js >= 18 required. ESM modules (`"type": "module"` in package.json).

### Multi-Agent Orchestrator

The `servers/orchestrator/` server provides multi-agent orchestration powered by the `open-multi-agent` engine. Multiple AI agents collaborate on complex goals, with access to Crow's MCP tools.

**`open-multi-agent` is an `optionalDependency`** (`file:../open-multi-agent` sibling repo). Hosted relays and minimal deployments don't need it. The gateway lazy-imports the orchestrator at three call sites and gracefully omits orchestrator tools when the package is missing — you'll see `[router] orchestrator unavailable` / `[pipeline-runner] Orchestrator unavailable` warnings in the logs but the rest of the gateway runs normally. If you change orchestrator imports, update **all three** call sites: `servers/gateway/router.js`, `servers/gateway/ai/tool-executor.js`, and `servers/gateway/index.js` (pipeline runner).

**Tools:**
- `crow_orchestrate` — Start a multi-agent team on a goal (async, returns job ID)
- `crow_orchestrate_status` — Poll job status/results
- `crow_list_presets` — List available team presets
- `crow_run_pipeline` — Execute a named pipeline immediately (async, returns job ID)
- `crow_schedule_pipeline` — Create a cron schedule for a pipeline (uses `pipeline:` prefix in schedules table)
- `crow_list_pipelines` — List available pipelines

**Presets** (`servers/orchestrator/presets.js`): Each preset defines a team of agents with role-appropriate tool whitelists. Available presets: `research`, `memory_ops`, `full`. Presets are provider-agnostic by default; the LLM provider is resolved from `CROW_ORCHESTRATOR_PROVIDER` env var or the first provider in `models.json`.

**Pipelines** (`servers/orchestrator/pipelines.js`): Predefined goal + preset combos that can run on schedule. Available: `memory-consolidation` (daily 3am), `daily-summary` (daily 10pm), `research-digest` (weekly Monday 9am). Results are stored as memories with `pipeline,automated` tags.

**Pipeline runner** (`servers/orchestrator/pipeline-runner.js`): Timer-based executor started by the gateway alongside the existing scheduler. Polls every 60s for `pipeline:` prefix entries in the schedules table. Includes overlap protection.

**MCP bridge** (`servers/orchestrator/mcp-bridge.js`): Connects Crow's MCP servers to `open-multi-agent`'s `ToolRegistry` via in-process `InMemoryTransport`. Bridge tools use `z.any()` (passthrough validation) with `rawInputSchema` set to the real JSON Schema from each MCP tool. Per-preset category filtering ensures only needed servers are connected. Also supports `registerRemoteTools()` for bridging tools from remote Crow instances (namespaced as `instanceName:toolName`).

**LLM config**: Reads `models.json` (same config as Crow's main agent) to resolve provider endpoints. Default provider resolved from `CROW_ORCHESTRATOR_PROVIDER` env var or first provider in `models.json`. Individual agents can override with their own `provider`/`model` fields. 5-minute timeout on all orchestrations.

**Remote tools**: Presets with `categories: ["memory", "remote"]` can access tools on connected remote Crow instances. Remote tools are namespaced (e.g., `colibri:ha_light_toggle`). Use `crow_list_remote_tools` to see available remote tools. Wildcard `"instance:*"` in agent tool lists expands to all tools from that instance.

**Adding a new preset**: Add an entry to `presets.js` with `categories` (which MCP servers to bridge) and `agents[]` (each with `name`, `systemPrompt`, `tools[]`, `maxTurns`). Optionally set `provider`/`model` to override the default.

**Adding a new pipeline**: Add an entry to `pipelines.js` with `goal`, `preset`, `defaultCron`, `storeResult`, and `resultCategory`.

## Extending the Platform

### Adding a new MCP tool to an existing server

1. Add `server.tool(name, description, zodSchema, handler)` in the relevant `server.js`
2. All Zod string schemas should include `.max()` constraints to prevent abuse (existing tools use `.max(50000)` for content, `.max(500)` for short fields)
3. If the tool needs new DB columns/tables, update `scripts/init-db.js` and re-run `npm run init-db`
4. If new FTS columns are needed, update the virtual table definition AND the insert/update/delete triggers
5. Use `sanitizeFtsQuery()` from `servers/db.js` for any FTS5 MATCH queries and `escapeLikePattern()` for LIKE queries
6. For user-visible actions (publish, share, install), create a notification via `createNotification(db, { title, type, source, action_url })` from `servers/shared/notifications.js`. Types: `reminder`, `media`, `peer`, `system`. Wrap in `try/catch` so notification failure never breaks the primary action.

### Adding a new external MCP server

1. Add server definition to `scripts/server-registry.js` (`EXTERNAL_SERVERS` array)
2. Add env vars to `.env.example`
3. Run `npm run mcp-config` to regenerate `.mcp.json`
4. Create a skill file in `skills/` describing the workflow
5. Add trigger patterns to `skills/superpowers.md` trigger table

### Adding a new skill

Skills are markdown files in `skills/`. They are loaded by Claude on demand — no build step. Checklist:

1. Create `skills/your-skill.md` with YAML frontmatter (name, description, triggers, tools)
2. Add a trigger row in `superpowers.md` with EN and ES intent phrases
3. Add to the Skills Reference section in this file (CLAUDE.md)
4. Run `npm run sync-skills` to update `docs/skills/index.md`
5. Add to VitePress sidebar if creating a new guide page

### Adding a new bundle add-on

Full checklist for adding a bundle that appears on the Extensions page and (if it has a panel) in the sidebar:

1. Create bundle directory at `bundles/<id>/` with `manifest.json`, scripts, panel, skills
2. Add the JSON entry to `registry/add-ons.json` (without this, the Extensions page won't show it)
3. If the `icon` value is new: add it to `ICON_MAP` in `servers/gateway/dashboard/panels/extensions.js`
4. If the `category` is new: add to `CATEGORY_COLORS` and `CATEGORY_LABELS` in `extensions.js`, add `extensions.category*` i18n key in `servers/gateway/dashboard/shared/i18n.js`, add to `CATEGORY_TO_GROUP` in `servers/gateway/dashboard/nav-registry.js`
5. If the bundle has a panel: ensure the panel file is at `bundles/<id>/panel/<id>.js` — the install flow copies it to `~/.crow/panels/` and adds to `~/.crow/panels.json`
6. If the bundle has skills: add to `skills/superpowers.md` trigger table
7. Restart both gateways after any changes
8. **Shared environment files:** If your bundle references shared infra (GPU GIDs, tailnet IPs, image pins), reference `~/.crow/env/rocm.env` or `~/.crow/env/cuda.env` via `env_file: - ${HOME}/.crow/env/<name>.env` in `docker-compose.yml`. These files are untracked (operator-specific values). docker-compose also auto-loads a project-dir `.env` for YAML-level `${VAR}` substitution — symlink it too: `ln -s ~/.crow/env/rocm.env bundles/<id>/.env`. Do **not** put shared env files under `bundles/`; that path breaks `crow bundle install`'s cp-based deployment.

### Adding a Crow's Nest panel

1. Create a JS module exporting `{ id, name, icon, route, navOrder, handler }` (see `templates/dashboard-panel.js`)
2. For built-in panels: add to `servers/gateway/dashboard/panels/` and register in `servers/gateway/dashboard/index.js`
3. For third-party panels: place in `~/.crow/panels/` and add the panel ID to `~/.crow/panels.json`
4. Use shared components from `servers/gateway/dashboard/shared/components.js`
5. Use design tokens from `servers/gateway/dashboard/shared/design-tokens.js` (single source of truth for CSS variables)
6. Handler receives `(req, res, { db, layout })` — return `layout({ title, content })` for consistent styling
7. **Home screen tiles**: Built-in panels automatically appear as tiles on the Nest home screen. Set `hidden: true` in the manifest to hide from both the sidebar and home screen.

### Adding a settings section

The Settings panel uses an iOS/Android-style grouped menu. Each settings section is a module in `servers/gateway/dashboard/settings/sections/`. Section modules export:

```js
export default {
  id: "my-section",                     // URL param: ?section=my-section
  group: "general",                     // Group key: general, ai, connections, content, system, account
  icon: `<svg .../>`,                   // 18x18 inline SVG
  labelKey: "settings.section.mySection", // i18n key
  navOrder: 10,                         // Sort within group
  async getPreview({ settings, lang }) { return "preview text"; },
  async render({ req, db, lang }) { return "<form>...</form>"; },
  async handleAction({ req, res, db, action }) { /* return true if handled */ },
};
```

- Built-in sections: add to `servers/gateway/dashboard/settings/sections/`, import and register in `panels/settings.js`
- Add-on sections: place at `~/.crow/bundles/<id>/settings-section.js` — auto-discovered via `loadAddonSettings()`
- Use `upsertSetting(db, key, value)` from `registry.js` for the common `INSERT ... ON CONFLICT DO UPDATE` pattern
- `getPreview()` receives a pre-fetched `settings` object (all `dashboard_settings` rows), NOT a `db` handle
- POST redirects should go to `?section=<id>` (not the main menu) so users return to the section they were editing
- Group definitions with order: `general (10), ai (20), connections (30), content (40), system (50), account (60)`

File structure:
```
servers/gateway/dashboard/
  panels/settings.js              — Thin orchestrator (imports + registers sections)
  settings/
    registry.js                   — Section registry, group definitions, dispatchAction, upsertSetting
    menu-renderer.js              — iOS-style grouped menu HTML + CSS
    migrations/
      llm-settings-migration.js   — One-time ai_profiles → provider_id pointer migration (phase 3); also adds profile shape v2 fields (kind/system_prompt/temperature)
    sections/
      theme.js, language.js, notifications.js, connections.js, help-setup.js,
      integrations.js, blog.js, discovery.js, updates.js, device-context.js,
      identity.js, password.js
      llm.js                      — Consolidated LLM Orchestrator section (phase 5); 4 internal tabs: providers / roles / profiles / health
      llm/
        providers-tab.js          — DB-backed provider registry + Add cloud provider form + Sync bundle providers
        roles-tab.js              — 12 preset-agent rows with compat()-colored dropdowns + Tier-2 warning banners
        profiles-tab.js           — Subtab switcher; composes ai-profiles / tts-profiles / stt-profiles / vision-profiles sections (not registered in main menu; phase 9)
        health-tab.js             — /api/providers/health matrix + Re-probe
      ai-profiles.js, tts-profiles.js, stt-profiles.js, vision-profiles.js — existing profile editors; imported by llm/profiles-tab.js but not registered standalone
```

### Add-on system

Crow supports installable add-ons (panels, MCP servers, skills, bundles). The registry lives in `registry/add-ons.json`. Users install add-ons by asking their AI ("install the todo add-on") or via the Extensions panel in the Crow's Nest. Installed add-ons are tracked in `~/.crow/installed.json`. Type-specific artifacts:
- **bundle**: Docker Compose files in `~/.crow/bundles/<id>/`
- **mcp-server**: Registered in `~/.crow/mcp-addons.json` (command, args, env)
- **skill**: Copied to `~/.crow/skills/` (takes precedence over repo `skills/`)
- **panel**: Copied to `~/.crow/panels/`, registered in `~/.crow/panels.json`

**Home screen tiles**: When a bundle-type add-on is installed, it automatically gets a tile on the Nest home screen. The tile uses the manifest's `icon` field for its icon (falling back to a branded logo or first-letter circle). When uninstalled, the tile disappears. MCP servers and skills do not get home screen tiles (no UI surface).

### Developer Program

Crow has an open developer program for community contributions. Full developer documentation lives in `docs/developers/` (VitePress site). Key resources:
- `CONTRIBUTING.md` — Contributor guidelines and code conventions
- `scripts/create-integration.js` — Interactive scaffolding CLI (`npm run create-integration`)
- `templates/` — Starter templates for integration skills and workflow skills
- `.github/ISSUE_TEMPLATE/` — Issue templates for integration requests, skill proposals, bug reports
- `.github/PULL_REQUEST_TEMPLATE.md` — PR checklist

### Skills Reference

Consult `skills/superpowers.md` first — it routes user intent to the right skills and tools. Core skills:
- `superpowers.md` — Auto-activation routing
- `safety-guardrails.md` — Universal safety checkpoints (destructive, resource, network actions)
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
- `songbook.md` — Personal chord book: ChordPro charts, transposition, chord diagrams, setlists, music theory
- `data-backends.md` — External data backend registration and knowledge capture workflow
- `extension-dev.md` — Extension development: scaffold, test, and publish bundles, panels, MCP servers, and skills
- `developer-kit.md` — Developer kit: scaffold, test, and submit Crow extensions to the registry
- `network-setup.md` — Tailscale remote access guidance
- `crow-identity.md` — F.11 identity attestations: sign per-app handles (Mastodon/Funkwhale/Matrix/etc.) with the Crow root Ed25519 key, publish via `/.well-known/crow-identity.json`, verify + revoke. Off by default; opt-in per handle — public linkage is effectively permanent
- `crow-crosspost.md` — F.12.2 cross-app publishing: mirror a post from one federated bundle to another via pure-function transforms (writefreely→mastodon, peertube→mastodon, pixelfed→mastodon, funkwhale→mastodon, gotosocial→mastodon, blog→gotosocial). Idempotency_key required; 60s publish-delay safety valve with operator cancel; no fake undo-after-publish
- `add-ons.md` — Add-on browsing, installation, removal
- `scheduling.md` — Scheduled and recurring task management
- `tutoring.md` — Socratic tutoring with progress tracking
- `bug-report.md` — Bug/feature reporting (GitHub or memory fallback)
- `backup.md` — Database backup and restore workflows
- `session-summary.md` — Quick session wrap-up (deliverables, decisions, next steps)
- `onboarding-tour.md` — First-run platform tour for new users
- `context-management.md` — Self-monitor context usage and suggest optimization
- `ideation.md` — Universal notes-to-plans organization
- `crow-dream.md` — Memory consolidation: analyze health, find stale/duplicate memories, prune with approval
- `crow-developer.md` — Developer workflow for working on the Crow codebase

Add-on skills (activated when corresponding add-on is installed):
- `obsidian.md` — Obsidian vault search and research sync
- `home-assistant.md` — Smart home control with safety checkpoints
- `ollama.md` — Local AI model management via HTTP API
- `nextcloud.md` — Nextcloud file access via WebDAV
- `immich.md` — Photo library search and album management
- `tailscale.md` — Private network access setup via Tailscale bundle
- `jellyfin.md` — Jellyfin media server: library search, browsing, playback control
- `plex.md` — Plex Media Server: library browsing, playback, On Deck
- `iptv.md` — IPTV channel management: M3U playlists, EPG, favorites
- `kodi.md` — Kodi remote control: JSON-RPC playback, library browsing
- `trilium.md` — TriliumNext knowledge base: note search, creation, web clipping, organization
- `knowledge-base.md` — Multilingual knowledge base: create, edit, publish, search, verify resources, share articles, LAN discovery
- `maker-lab.md` — STEM education companion for kids: scaffolded AI tutor, hint-ladder pedagogy, age-banded personas (kid/tween/adult), solo/family/classroom modes, guest sidecar
- `gotosocial.md` — GoToSocial ActivityPub microblog: post, follow, search, moderate (block_user/mute inline; defederate/block_domain/import_blocklist queued for operator confirmation), media prune, federation health
- `writefreely.md` — WriteFreely federated blog: create/update/publish/unpublish posts, list collections, fetch public posts, export; minimalist publisher (no comments, no moderation queue — WF is publish-oriented only)
- `matrix-dendrite.md` — Matrix homeserver on Dendrite: create/join/leave rooms, send messages, sync, invite users, federation health; appservice registration prep for F.12 bridges; :8448-vs-well-known either/or federation story
- `matrix-bridges.md` — F.12.1 Matrix appservice bridges meta-bundle (mautrix-signal/telegram/whatsapp). Opt-in per bridge; each has distinct legal/privacy risks (Signal ToS prohibits bots; Meta may ban bridged WhatsApp numbers). post-install.sh writes appservice YAMLs into Dendrite + restarts it. Requires matrix-dendrite bundle
- `funkwhale.md` — Funkwhale federated music pod: library listing, search, upload, follow remote channels/libraries, playlists, listening history, moderation (block_user/mute inline; block_domain/defederate queued), media prune; on-disk or S3 audio storage via storage-translators.funkwhale()
- `pixelfed.md` — Pixelfed federated photo-sharing: post photos (upload+status), feed, search, follow, moderation (block_user/mute inline; block_domain/defederate/import_blocklist queued), admin reports, remote reporting, media prune; Mastodon-compatible REST API; on-disk or S3 media via storage-translators.pixelfed()
- `lemmy.md` — Lemmy federated link aggregator: status, list/follow/unfollow communities, post (link + body), comment, feed (Subscribed/Local/All), search, moderation (block_user/block_community inline; block_instance/defederate queued), admin reports, pict-rs media prune; Lemmy v3 REST API; community-scoped federation
- `mastodon.md` — Mastodon federated microblog (flagship ActivityPub): status, post, post_with_media (async media upload), feed (home/public/local/notifications), search, follow/unfollow, moderation (block_user/mute inline; defederate/import_blocklist queued admin), admin reports, remote reporting, media prune (tootctl); Mastodon v1/v2 reference API; on-disk or S3 media via storage-translators.mastodon()
- `peertube.md` — PeerTube federated video (YouTube-alt): status, list channels/videos, upload_video (multipart), search, subscribe/unsubscribe, rate_video, moderation (block_user inline; block_server/defederate queued admin), admin abuse reports with predefined_reasons taxonomy, remote reporting, media prune recipe; PeerTube v1 REST API; on-disk or S3 via storage-translators.peertube() (strongly recommend S3 — storage unbounded without it)
- `kolibri.md` — Kolibri offline-first learning platform: channel recommendation by age/subject, classroom setup, LAN-sync, pairs with maker-lab as content spine
- `scratch-offline.md` — Self-hosted Scratch (age 8+ block coding): first-project coaching, vocabulary-stays-in-Scratch-terms dialogue, pair with Maker Lab when the learner is stuck
- `vllm.md` — Operational skill for the vLLM classroom inference engine: GPU sizing, model selection, Maker Lab wiring, common-issue diagnostics
- `maker-lab-advanced.md` — Pair-programmer for JupyterHub classroom (ages 9+): traceback explanation, next-cell suggestions at tween/teen reading level, routes back to maker-lab for Blockly, flags kid-safe kernel as a default (not a security sandbox)
- `calibre-server.md` — Calibre content server: search, browse, download ebooks via OPDS
- `calibre-web.md` — Calibre-Web reader: search, shelves, reading status, download
- `miniflux.md` — Miniflux RSS reader: subscribe feeds, read articles, star, mark read
- `audiobookshelf.md` — Audiobookshelf: search audiobooks/podcasts, track listening progress
- `kavita.md` — Kavita reader: browse manga/comics/ebooks, track reading progress
- `navidrome.md` — Navidrome music: search, browse albums/artists, stream, playlists
- `paperless.md` — Paperless-ngx: search/upload documents, OCR, tags, correspondents
- `wallabag.md` — Wallabag read-it-later: save articles, search, tag, archive
- `linkding.md` — Linkding bookmarks: save, search, tag, organize web links
- `shiori.md` — Shiori bookmarks: save pages with cached content, offline reading
- `bookstack.md` — BookStack wiki: search, browse shelves/books/pages, create/edit pages
- `vikunja.md` — Vikunja tasks: projects, tasks, labels, due dates, kanban
- `actual-budget.md` — Actual Budget: accounts, transactions, budgets, spending reports

### Maintaining CLAUDE.md vs crow.md

These two files serve different audiences — keep them separate:

| | CLAUDE.md | crow.md |
|---|---|---|
| **Audience** | Developers building/extending Crow | The AI assistant operating as Crow |
| **Lives in** | Git (this file) | `crow_context` DB table |
| **Updated by** | Editing the file directly | `crow_update_context_section` MCP tool |
| **Contains** | Build commands, architecture, DB schema, extension guides | Identity, memory protocol, session protocol, transparency rules |

**When to update which:**

- New npm script, DB table, server, or extension point → **CLAUDE.md**
- New skill file → **CLAUDE.md** (Skills Reference) + **crow.md** (`skills_reference` section)
- Changed AI behavior (how Crow responds, formats, or routes) → **crow.md** only
- New integration that the AI should know about → **crow.md** (custom section via `crow_add_context_section`)

crow.md seed data (7 protected sections) is defined in `scripts/init-db.js` in the `contextSections` array. Changes there affect new installs only — existing instances update via the MCP tools.

## Documentation Site

The `docs/` directory contains a VitePress documentation site. Key paths:

- `docs/.vitepress/config.ts` — Site config, sidebar, and nav
- `docs/index.md` — Landing page
- `docs/getting-started/` — Setup and deployment guides
- `docs/platforms/` — Per-platform integration guides (Claude, ChatGPT, Gemini, Cursor, OpenClaw, etc.)
- `docs/guide/` — Conceptual guides (cross-platform, storage, blog, Crow's Nest, sharing, social)
- `docs/architecture/` — Server architecture docs (memory, projects, sharing, storage, blog, Crow's Nest, gateway)
- `docs/developers/` — Developer program, creating add-ons/panels/servers, storage API, add-on registry
- `docs/showcase.md` — Community showcase

To run locally: `cd docs && npm run dev`
